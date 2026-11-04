import { ensure } from './store.mjs';

// Versioned Engine policy, not model-selected permissions or provider billing promises.
export const MISSION_EFFORT_PROFILES = Object.freeze(Object.fromEntries([
  ['low', 12, 500_000, 40, 1, 1],
  ['medium', 32, 1_500_000, 100, 3, 2],
  ['high', 80, 4_000_000, 250, 6, 3],
  ['ultra', 160, 8_000_000, 500, 12, 3],
].map(([level, modelCalls, estimatedTokens, toolCalls, delegations, parallelTeammates]) => [level, Object.freeze({ modelCalls, estimatedTokens, toolCalls, delegations, parallelTeammates })])));
export const EFFORT_DIMENSIONS = ['modelCalls', 'estimatedTokens', 'toolCalls', 'delegations'];
export function createMissionEffort(level = 'medium') {
  ensure(Object.hasOwn(MISSION_EFFORT_PROFILES, level), 400, 'Choose Low, Medium, High or Ultra Mission effort.');
  return { schemaVersion: 1, profileVersion: 1, level, limits: { ...MISSION_EFFORT_PROFILES[level] }, finishing: false, exhausted: false };
}
export function missionEffortSummary(mission) {
  const policy = mission?.effort;
  if (!policy) return null; // Existing Missions retain their admitted policy.
  const used = Object.fromEntries(EFFORT_DIMENSIONS.map(key => [key, 0])), reserved = { ...used };
  for (const operation of Object.values(mission.resourceLedger?.operations || {})) {
    if (operation.status === 'released') continue;
    const effort = operation.effort || (operation.kind==='adopted_usage'?{estimatedTokens:operation.actual?.tokens || 0,toolCalls:operation.actual?.toolCalls || 0}:operation.kind?.startsWith('tool:')?{toolCalls:1,...(operation.kind==='tool:delegate_task'?{delegations:1}:{})}:{modelCalls:1,estimatedTokens:operation.actual?.tokens ?? operation.estimate?.tokens ?? 0});
    const target = operation.status === 'reserved' ? reserved : used;
    for (const key of EFFORT_DIMENSIONS) target[key] += key === 'estimatedTokens' && Number.isSafeInteger(operation.actual?.tokens) ? operation.actual.tokens : effort[key] || 0;
  }
  const committed = Object.fromEntries(EFFORT_DIMENSIONS.map(key => [key, used[key] + reserved[key]]));
  // Delegations are a strategy allowance, not a measure of work completed.
  const ratio = Math.max(...['modelCalls', 'estimatedTokens', 'toolCalls'].map(key => committed[key] / policy.limits[key]));
  return { level: policy.level, profileVersion: policy.profileVersion, limits: { ...policy.limits }, used, reserved, committed, percent: Math.min(100, Math.floor(ratio * 100)), finishing: policy.finishing || ratio >= .8, exhausted: !!policy.exhausted, tokenBasis: 'reported_or_local_estimate' };
}
const failure = (code, message) => Object.assign(new Error(message), { code, status: 409 });
export function checkMissionEffort(mission, quantities = {}, { phase = 'work', coordinator = false, tool } = {}) {
  const summary = missionEffortSummary(mission);
  if (!summary) return;
  const finalTools = new Set(['mission_contract_set', 'mission_status', 'mission_submit_result', 'mission_request_completion', 'task_plan_set', 'task_status', 'task_outcome_set', 'delegation_status', 'work_records_read', 'tool_result_read', 'workspace_read', 'documents_read', 'workspace_write', 'workspace_edit', 'documents_create']);
  if (summary.finishing && tool && !finalTools.has(tool)) throw failure('mission_effort_finishing', 'This Mission is finishing within its remaining effort. Collect retained results and produce the final answer; do not expand research or delegate new work.');
  for (const key of EFFORT_DIMENSIONS) {
    const limit = summary.limits[key];
    // Reserve one coordinator synthesis and one independent acceptance, inside the total.
    const reserve = key === 'modelCalls' ? 2 : key === 'estimatedTokens' ? Math.floor(limit * .2) : key === 'toolCalls' ? 5 : 0;
    const held = phase === 'verification' ? 0 : phase === 'closure' && coordinator ? Math.ceil(reserve / 2) : reserve;
    if (summary.committed[key] + (quantities[key] || 0) + held <= limit) continue;
    if (key === 'delegations') throw failure('mission_effort_finishing', 'The shared delegation allowance is used. Complete the remaining work with the existing team.');
    if (phase === 'work' && coordinator && quantities.modelCalls) throw failure('mission_effort_closing', 'Use the reserved allowance to synthesize the retained work and request final acceptance.');
    throw failure('mission_effort_exhausted', 'This Mission needs more effort. Saved work and partial results are retained; increase effort to continue.');
  }
}

export function missionEffortGuidance(mission) {
  const value = missionEffortSummary(mission);
  if (!value) return '';
  return `Mission effort: ${value.level}; shared team use ${JSON.stringify(value.committed)} of ${JSON.stringify(value.limits)}. Finish as soon as the owner outcomes are met. ${value.finishing ? 'FINISHING: do not expand research or start new delegations. Collect existing results, save useful outputs and give a final answer with explicit gaps. The Engine still requires the original outcomes for Achieved.' : 'Keep research and delegation proportional to the goal. Reserve capacity for the final answer and independent acceptance.'} Effort never changes model reasoning, access or approvals.`;
}
