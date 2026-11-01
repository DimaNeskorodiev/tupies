import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createMissionContract } from '../lib/mission-contract.mjs';
import { captureMissionEvidence, captureMissionResponseEvidence, missionEvidenceDigest, readMissionEvidence, readMissionEvidenceFile } from '../lib/mission-evidence.mjs';
import { verifyMission } from '../lib/mission-verifier.mjs';
import { createDocument } from '../lib/documents.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, kind = 'file_contains') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tupies-mission-evidence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const run = { id: 'run_1', workRecords: [{ callId: 'call_1', tool: 'workspace_write', status: 'succeeded', outcome: 'observed', path: 'report.md', resultDigest: hash('output') }] };
  const store = { directory, state: { runs: { bot_1: run }, runHistory: {} }, redactValue: value => structuredClone(value), redact: value => value };
  await fs.mkdir(path.join(directory, 'workspaces', 'bot_1'), { recursive: true });
  await fs.writeFile(path.join(directory, 'workspaces', 'bot_1', 'report.md'), 'A checked summary.');
  const checker = kind === 'rubric' ? { kind, rubric: 'The summary must correctly answer the requested result and cite observed sources.', rubricVersion: 'summary-v1' } : { kind, path: 'report.md', ...(kind === 'file_contains' ? { value: 'checked summary' } : {}) };
  const contract = createMissionContract({ goal: 'Create a checked summary.', ownerSource: { id: 'owner_1', text: 'Create a checked summary.' }, requirements: [{ id: 'summary', text: 'Create a checked summary.', source: { ownerId: 'owner_1', quote: 'Create a checked summary.' }, checker }] });
  const input = { store, missionId: 'mission_1', botId: 'bot_1', runId: run.id, contractVersion: 1, requirementId: 'summary', callId: 'call_1', kind: 'file', path: 'report.md' };
  return { directory, store, run, contract, input };
}
const coverage = (contract, evidence) => ({ contractVersion: contract.version, contractDigest: contract.digest, evidenceDigest: missionEvidenceDigest(evidence), passed: true, reviewer: { connectionId: 'fixture', model: 'reviewer' }, rubricVersion: 'mission-coverage-v1' });

test('file evidence needs a real unique successful exact-path receipt', async t => {
  const { input, run } = await fixture(t);
  await assert.rejects(captureMissionEvidence({ ...input, callId: 'invented' }), /unambiguous/);
  await assert.rejects(captureMissionEvidence({ ...input, path: '../report.md' }), /exact private file/);
  run.workRecords.push({ ...run.workRecords[0] });
  await assert.rejects(captureMissionEvidence(input), /unambiguous/); run.workRecords.pop();
  run.workRecords[0].outcome = 'unknown'; await assert.rejects(captureMissionEvidence(input), /uncertain/);
});

test('immutable evidence survives history pruning and ignores supplied metadata', async t => {
  const { input, store } = await fixture(t), ref = await captureMissionEvidence(input);
  store.state.runs = {}; store.state.runHistory = {};
  const loaded = await readMissionEvidence({ store, reference: { ...ref, path: '../../private', sha256: hash('forged') }, includeContent: true });
  assert.equal(loaded.content, 'A checked summary.'); assert.equal(loaded.path, 'report.md');
  assert.equal(loaded.sha256, hash('A checked summary.'));
  await assert.rejects(readMissionEvidence({ store, reference: { id: 'evidence_forged', digest: ref.digest } }), /identity/);
  await assert.rejects(readMissionEvidence({ store, reference: { digest: hash('invented receipt') } }), /ENOENT/);
});

test('current file mutation and deletion invalidate captured evidence', async t => {
  const { input, store, directory, contract, run } = await fixture(t), ref = await captureMissionEvidence(input);
  const args = { store, missionId: 'mission_1', contract, evidence: [ref], runs: [run], final: true, coverageReview: coverage(contract, [ref]) };
  const initial = await verifyMission(args); assert.equal(initial.canAchieve, true); assert.equal(initial.progress.percent, 50);
  await fs.writeFile(path.join(directory, 'workspaces', 'bot_1', 'report.md'), 'Changed');
  assert.equal((await verifyMission(args)).passed, false);
  await fs.rm(path.join(directory, 'workspaces', 'bot_1', 'report.md'));
  assert.equal((await verifyMission(args)).passed, false);
});

test('symlinks and modified private receipt bytes fail closed', async t => {
  const { input, store, directory } = await fixture(t), ref = await captureMissionEvidence(input);
  await fs.writeFile(path.join(directory, 'mission-evidence', `${ref.digest}.json`), '{}');
  await assert.rejects(readMissionEvidence({ store, reference: ref }), /changed/);
  await fs.rm(path.join(directory, 'workspaces', 'bot_1', 'report.md'));
  await fs.symlink(path.join(directory, 'state.json'), path.join(directory, 'workspaces', 'bot_1', 'report.md'));
  await assert.rejects(captureMissionEvidence(input), /Symbolic/);
});

test('source evidence excludes invented IDs, writes and failed HTTP observations', async t => {
  const { input, run } = await fixture(t);
  await assert.rejects(captureMissionEvidence({ ...input, kind: 'source_read' }), /eligible/);
  Object.assign(run.workRecords[0], { tool: 'http_fetch', httpStatus: 500 });
  await assert.rejects(captureMissionEvidence({ ...input, kind: 'source_read' }), /eligible/);
  run.workRecords[0].httpStatus = 200;
  const ref = await captureMissionEvidence({ ...input, kind: 'source_read' }); assert.equal(ref.kind, 'source_read');
});

test('response text requires independent exact-bound review and coverage', async t => {
  const { input, store, run, contract } = await fixture(t, 'rubric');
  const ref = await captureMissionResponseEvidence({ ...input, text: 'The requested checked summary, with actual source caveats.' });
  const args = { store, missionId: 'mission_1', contract, evidence: [ref], runs: [run], final: true };
  assert.equal((await verifyMission(args)).passed, false);
  const review = { requirementId: 'summary', contractVersion: 1, evidenceDigest: missionEvidenceDigest([ref]), passed: true, reviewer: { connectionId: 'fixture', model: 'reviewer' }, rubricVersion: 'summary-v1' };
  const accepted = { ...args, reviews: [review], coverageReview: coverage(contract, [ref]) };
  assert.equal((await verifyMission(accepted)).canAchieve, true);
  for (const change of [{ contractVersion: 2 }, { evidenceDigest: hash('old') }, { rubricVersion: 'easier' }, { reviewer: {} }]) assert.equal((await verifyMission({ ...accepted, reviews: [{ ...review, ...change }] })).passed, false);
  assert.equal((await verifyMission({ ...accepted, coverageReview: { ...accepted.coverageReview, contractDigest: hash('old') } })).passed, false);
  const read = await readMissionEvidence({ store, reference: ref, includeContent: true }); assert.match(read.content, /checked summary/); assert.equal(read.text, undefined);
});

test('empty criteria, partial required child and unknown effects never achieve', async t => {
  const { input, store, run, contract } = await fixture(t), ref = await captureMissionEvidence(input);
  const args = { store, missionId: 'mission_1', contract, evidence: [ref], runs: [run], final: true, coverageReview: coverage(contract, [ref]) };
  run.requiredDeliverables = [{ id: 'child_requirement', status: 'partial' }];
  assert.equal((await verifyMission(args)).passed, false); delete run.requiredDeliverables;
  run.workRecords.push({ callId: 'uncertain', outcome: 'unknown' });
  assert.equal((await verifyMission(args)).passed, false); run.workRecords.pop();
  const empty = createMissionContract({ goal: 'Goal', ownerSource: { id: 'owner_2', text: 'Goal' } });
  const result = await verifyMission({ ...args, contract: empty, evidence: [], coverageReview: coverage(empty, []) });
  assert.equal(result.passed, false); assert.equal(result.progress.percent, null);
});

test('missing episode snapshots cannot bypass required-child safety checks', async t => {
  const { input, store, contract } = await fixture(t), ref = await captureMissionEvidence(input);
  const result = await verifyMission({ store, missionId: 'mission_1', contract, evidence: [ref], runs: [], coverageReview: coverage(contract, [ref]), final: true });
  assert.equal(result.canAchieve, false); assert.match(result.blockers.join(' '), /snapshot/);
});

test('rubric evidence infers source kind only from an actual eligible receipt', async t => {
  const { input, store } = await fixture(t, 'rubric');
  const ref = await captureMissionEvidence({ ...input, kind: 'rubric' });
  const row = await readMissionEvidence({ store, reference: ref, includeContent: true });
  assert.equal(row.kind, 'file'); assert.match(row.content, /checked summary/);
});

test('document review extracts exact hashed DOCX bytes with the existing bounded worker', async t => {
  const { input, store, directory, run } = await fixture(t, 'rubric');
  await createDocument(store, 'bot_1', { path: 'report.docx', document: { title: 'Mission report', blocks: [{ type: 'paragraph', text: 'The independently checked document summary.' }] } });
  run.workRecords[0].tool = 'documents_create'; run.workRecords[0].path = 'report.docx';
  const ref = await captureMissionEvidence({ ...input, kind: 'rubric', path: 'report.docx' });
  const row = await readMissionEvidence({ store, reference: ref, includeContent: true });
  assert.equal(row.contentKind, 'document_text'); assert.match(row.content, /independently checked document summary/);
  assert.equal((await fs.readdir(path.join(directory, 'mission-evidence'))).some(name => name.startsWith('.extract-')), false);
  await fs.writeFile(path.join(directory, 'workspaces', 'bot_1', 'report.docx'), 'changed');
  await assert.rejects(readMissionEvidence({ store, reference: ref, includeContent: true }), /changed/);
});

test('response hashes describe retained redacted bytes', async t => {
  const { input, store } = await fixture(t, 'rubric');
  store.redactValue = value => JSON.parse(JSON.stringify(value).replaceAll('synthetic-private-value', '[redacted]'));
  const ref = await captureMissionResponseEvidence({ ...input, text: 'Summary synthetic-private-value' });
  const row = await readMissionEvidence({ store, reference: ref, includeContent: true });
  assert.equal(row.content, 'Summary [redacted]'); assert.equal(row.sha256, hash(row.content));
});

test('historical file download keeps the exact accepted bytes after workspace mutation or deletion', async t => {
  const { input, store, directory } = await fixture(t), reference = await captureMissionEvidence(input);
  const file = path.join(directory, 'workspaces', 'bot_1', 'report.md');
  await fs.writeFile(file, 'A later version.');
  let retained = await readMissionEvidenceFile({ store, reference, missionId: 'mission_1' });
  assert.equal(retained.bytes.toString(), 'A checked summary.'); assert.equal(retained.metadata.sha256, hash(retained.bytes));
  await fs.rm(file); retained = await readMissionEvidenceFile({ store, reference, missionId: 'mission_1' });
  assert.equal(retained.bytes.toString(), 'A checked summary.');
  await assert.rejects(readMissionEvidenceFile({ store, reference, missionId: 'mission_2' }), /belongs/);
});

test('corrupted and symbolic historical file blobs cannot be downloaded or accepted', async t => {
  const { input, store, directory } = await fixture(t), reference = await captureMissionEvidence(input);
  const blob = path.join(directory, 'mission-evidence', `${hash('A checked summary.')}.bin`);
  await fs.writeFile(blob, 'Corrupt snapshot bytes.');
  await assert.rejects(readMissionEvidenceFile({ store, reference, missionId: 'mission_1' }), /changed/);
  await assert.rejects(readMissionEvidence({ store, reference }), /changed/);
  await fs.rm(blob); await fs.symlink(path.join(directory, 'workspaces', 'bot_1', 'report.md'), blob);
  await assert.rejects(readMissionEvidenceFile({ store, reference, missionId: 'mission_1' }), /ELOOP|symbolic|link/i);
});

test('owner cancellation aborts document evidence extraction and removes private staging', async t => {
  const { input, store, directory, run } = await fixture(t, 'rubric');
  await createDocument(store, 'bot_1', { path: 'cancel.docx', document: { title: 'Cancelled review', blocks: [{ type: 'paragraph', text: 'Synthetic content for cancellation.' }] } });
  run.workRecords[0].tool = 'documents_create'; run.workRecords[0].path = 'cancel.docx';
  const reference = await captureMissionEvidence({ ...input, kind: 'rubric', path: 'cancel.docx' }), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Owner stopped the fixture review.')), 20);
  try { await assert.rejects(readMissionEvidence({ store, reference, includeContent: true, signal: controller.signal }), error => error.name === 'AbortError' || /Owner stopped/.test(error.message)); }
  finally { clearTimeout(timer); }
  assert.equal((await fs.readdir(path.join(directory, 'mission-evidence'))).some(name => name.startsWith('.extract-')), false);
  await assert.rejects(readMissionEvidence({ store, reference, signal: controller.signal }), /Owner stopped/);
});
