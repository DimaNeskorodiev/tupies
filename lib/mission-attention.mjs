import { createHash } from 'node:crypto';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eventId = identity => digest(['mission_attention', ...identity]).slice(0, 32);

function hasFinalReply(state, mission, runId) {
  if (!runId) return false;
  const rows = state.messages?.[mission.leadBotId] || [];
  const request = rows.find(row => row.role === 'user' && !['answer', 'steer'].includes(row.kind) && row.runId === runId && row.missionId === mission.id && !row.fromBotId && (row.source === 'mission' || row.source === 'chat' && (!row.sessionId || row.sessionId === mission.leadBotId)));
  return !!request && rows.some(row => row.role === 'assistant' && row.runId === runId && !row.partial && row.kind !== 'progress' && safeId(row.id));
}

/** Local presentation identity only. It cannot approve an action or become synced authority. */
export function currentMissionAttention(state, missionId, { ownerEngineId } = {}) {
  const mission = state.missions?.[missionId];
  if (!mission || mission.id !== missionId || !safeId(missionId) || !safeId(mission.leadBotId) || !safeId(mission.ownerEngineId) || ownerEngineId && mission.ownerEngineId !== ownerEngineId || mission.stopRequested && !(mission.expiryRequested===true && mission.state==='terminal' && mission.outcome==='expired') || mission.archivedAt || ['achieved', 'stopped'].includes(mission.outcome) || !(state.bots || []).some(bot => bot.id === mission.leadBotId)) return null;
  const run = state.runs?.[mission.leadBotId];
  const ownsRun = run?.missionId === mission.id && run.botId === mission.leadBotId && safeId(run.id) && !run.stopRequested && !run.delegation && (mission.episodeRefs || []).some(item => item.runId === run.id && item.botId === mission.leadBotId);
  if (ownsRun && mission.state !== 'terminal' && run.status === 'waiting_for_approval' && ['chat', 'mission'].includes(run.source)) {
    const controls = (run.pending_controls || []).filter(control => control.kind === 'approval');
    const control = controls.length === 1 ? controls[0] : null;
    if (!control || !safeId(control.prompt_id) || !Number.isSafeInteger(run.execution_generation) || run.execution_generation < 1 || run.approval?.request_id && run.approval.request_id !== control.prompt_id) return null;
    return { kind: 'approval', missionId, botId: mission.leadBotId, runId: run.id, generation: run.execution_generation, attentionId: eventId([missionId, mission.leadBotId, 'approval', run.id, control.prompt_id, run.execution_generation]), createdAt: control.createdAt || run.updatedAt || mission.updatedAt || mission.createdAt, title: 'Mission needs approval', detail: 'Review the exact action before work can continue.' };
  }
  const blocked = mission.state === 'waiting' && mission.waitCondition?.kind === 'attention' || mission.state === 'terminal' && ['blocked', 'failed', 'expired', 'budget_exhausted'].includes(mission.outcome);
  if (!blocked || typeof mission.reason !== 'string' || !mission.reason.trim()) return null;
  const episode = (mission.episodeRefs || []).at(-1), runId = episode?.runId;
  // The existing final-reply event is the sole terminal notification when a reply exists.
  if (hasFinalReply(state, mission, runId)) return null;
  const identity = [missionId, mission.leadBotId, 'blocker', mission.contractVersion, mission.attempt || 0, episode?.id || runId || mission.origin?.messageId || 'queued', mission.state, mission.outcome || '', digest(mission.reason)];
  return { kind: 'blocker', missionId, botId: mission.leadBotId, ...(safeId(runId) ? { runId } : {}), attentionId: eventId(identity), createdAt: mission.updatedAt || mission.createdAt, title: 'Mission needs attention', detail: 'Open the Mission to review what is preventing progress.' };
}
