import { ensure } from './store.mjs';
import { missionDigest, validateMissionContract } from './mission-contract.mjs';
import { missionEvidenceDigest, readMissionEvidence } from './mission-evidence.mjs';
import { checkOutcomes } from './work-quality.mjs';

const reviewPassed = (review, contract, evidenceDigest, rubricVersion) => review?.passed === true && review.contractVersion === contract.version && review.evidenceDigest === evidenceDigest && review.rubricVersion === rubricVersion && typeof review.reviewer?.connectionId === 'string' && review.reviewer.connectionId.length > 0 && review.reviewer.connectionId.length <= 120 && typeof review.reviewer?.model === 'string' && review.reviewer.model.length > 0 && review.reviewer.model.length <= 240;

/** Reuse the existing actual child-result checks, including retained nested evidence. */
async function verifyRequired(store, requirement, depth = 1, lineage = new Set(), budget = { count: 0 }) {
  const accepted = requirement.accepted, identity = `${requirement.botId}:${accepted?.runId}`;
  if (requirement.status !== 'completed' || !accepted || depth > 2 || lineage.has(identity) || ++budget.count > 128) return false;
  if (!requirement.attempts?.some(attempt => attempt.runId === accepted.runId && attempt.callId === accepted.callId && attempt.status === 'completed' && attempt.verification?.passed === true)) return false;
  if (requirement.currentVerification?.passed === false || requirement.guards?.untrackedUnknown) return false;
  const next = new Set([...lineage, identity]);
  for (const child of accepted.requiredDeliverables || []) if (!await verifyRequired(store, child, depth + 1, next, budget)) return false;
  const result = await checkOutcomes({ store, assertRunning() {}, current: () => ({ outcomeChecks: accepted.checks, workRecords: accepted.records, delegationJobs: accepted.delegationJobs, requiredDeliverables: accepted.requiredDeliverables }) }, { bot: { id: requirement.botId, tools: accepted.tools } });
  return result.passed === true;
}

/** Pure acceptance orchestration: no model calls, actions, grants or state mutations. */
export async function verifyMission({ store, missionId, contract, evidence = [], runs = [], reviews = [], coverageReview = null, final = false } = {}) {
  validateMissionContract(contract);
  ensure(typeof missionId === 'string' && /^[\w-]{1,120}$/.test(missionId), 400, 'Use an exact Mission identity.');
  ensure(Array.isArray(runs) && runs.length <= 256 && Array.isArray(reviews) && reviews.length <= 48, 400, 'Mission verification inputs exceed their bounded limits.');
  const evidenceDigest = missionEvidenceDigest(evidence), retained = [], evidenceErrors = [];
  for (const reference of evidence) {
    try {
      let row = await readMissionEvidence({ store, reference });
      const requirement = contract.requirements.find(item => item.id === row.requirementId);
      if (requirement?.checker.kind === 'file_contains' && row.kind === 'file' && !/\.(?:pdf|docx|pptx|xlsx)$/i.test(row.path)) row = await readMissionEvidence({ store, reference, includeContent: true });
      if (row.missionId === missionId && row.contractVersion === contract.version && requirement) retained.push(row);
      else evidenceErrors.push({ id: row.id, reason: 'Evidence belongs to a different Mission, requirement or contract version.' });
    } catch { evidenceErrors.push({ id: typeof reference === 'object' ? reference?.id : reference, reason: 'Evidence is unavailable, changed or not an engine-verified receipt.' }); }
  }
  const results = [];
  for (const requirement of contract.requirements) {
    const checker = requirement.checker, rows = retained.filter(row => row.requirementId === requirement.id);
    let passed = false, reason = 'No current verified evidence satisfies this requirement.', unsupported = false;
    if (checker.kind.startsWith('file_')) {
      const files = rows.filter(row => row.kind === 'file' && row.path === checker.path);
      passed = files.some(row => checker.kind === 'file_exists' || checker.kind === 'file_sha256' && row.sha256 === checker.value || checker.kind === 'file_contains' && row.contentKind === 'literal_utf8' && typeof row.content === 'string' && !row.truncated && row.content.includes(checker.value));
      if (!passed && files.some(row => row.truncated) && checker.kind === 'file_contains') reason = 'The file exceeds this bounded literal checker; use an exact hash or a supported independent review.';
    } else if (checker.kind === 'rubric') {
      const matching = reviews.filter(review => review.requirementId === requirement.id && (review.scope!=='requirement' || review.contractDigest===contract.digest) && reviewPassed(review, contract, review.scope==='requirement' && review.contractDigest===contract.digest?missionEvidenceDigest(evidence.filter(ref=>ref.contractVersion===contract.version && ref.requirementId===requirement.id)):evidenceDigest, checker.rubricVersion));
      passed = rows.length > 0 && matching.length === 1;
      if (!passed) reason = 'This requirement needs an independent review bound to its fixed rubric, current contract and exact evidence.';
    } else if (checker.kind === 'human_acceptance') {
      unsupported = true; reason = 'This release has no verified owner-acceptance adapter for this criterion. Needs attention.';
    } else {
      passed = rows.some(row => row.kind === checker.kind && (!checker.callId || row.receipt?.callId === checker.callId));
      if (checker.kind === 'teammate_completed') {
        if (checker.delegationId) {
          const jobs = runs.flatMap(run => run.delegationJobs || []).filter(job => job.id === checker.delegationId);
          passed = passed && jobs.length === 1 && jobs[0].status === 'completed' && jobs[0].result?.status === 'completed' && jobs[0].childRunId === jobs[0].result?.runId;
        }
        passed = passed && rows.some(row => runs.some(run => (run.requiredDeliverables || []).some(item => item.id === row.receipt?.deliverableId && item.status === 'completed')));
      }
    }
    results.push({ id: requirement.id, kind: checker.kind, passed, status: passed ? 'verified' : unsupported ? 'needs_attention' : 'unverified', reason: passed ? 'Verified the declared property against its exact current evidence.' : reason, evidenceIds: rows.map(row => row.id) });
  }
  const blockers = [];
  if (!results.length) blockers.push('Acceptance criteria have not been established.');
  if (!runs.length || retained.some(row => !runs.some(run => run.id === row.runId && (!run.botId || run.botId === row.botId)))) blockers.push('A complete engine-owned episode safety snapshot is unavailable for the retained evidence.');
  for (const run of runs) {
    if ((run.workRecords || []).some(record => record.outcome === 'unknown') || run.workReconciliation?.unresolved > 0) blockers.push('An episode has an unresolved action outcome.');
    if ((run.delegationJobs || []).some(job => !['completed', 'failed', 'cancelled', 'stopped'].includes(job.status))) blockers.push('A delegated episode still needs collection or attention.');
    for (const requirement of run.requiredDeliverables || []) {
      let passed = false;
      try { passed = await verifyRequired(store, requirement); } catch { /* Missing child files remain unverified. */ }
      if (!passed) blockers.push('An original required teammate result is incomplete or its current checks no longer pass.');
    }
  }
  const coveragePassed = reviewPassed(coverageReview, contract, evidenceDigest, 'mission-coverage-v1') && coverageReview.contractDigest === contract.digest;
  if (!coveragePassed) blockers.push('Independent coverage review has not accepted the current contract and evidence.');
  const verified = results.filter(result => result.passed).length, total = results.length + 1;
  const passed = results.length > 0 && verified === results.length && blockers.length === 0;
  // The controller adds the reserved final outcome only in its atomic Achieved commit.
  const progress = { verified, total, percent: results.length ? Math.min(99, Math.floor(100 * verified / total)) : null };
  return { contractVersion:contract.version, passed, canAchieve: final === true && passed, coverage: results.length ? 'declared_requirements' : 'not_declared', requirements: results, progress, evidenceDigest, evidenceErrors, blockers: [...new Set(blockers)], acceptanceDigest: passed ? missionDigest({ missionId, contractDigest: contract.digest, evidenceDigest, reviews, coverageReview }) : null, notice: 'Mechanical checks prove only declared properties; rubric and coverage acceptance are separately recorded model evaluations. No permission or action authority is created.' };
}
