/**
 * Terminal presentation data travels with the originating display message. It is never run state,
 * an approval, or authority to execute anything; the engine's audit trail and run history stay local.
 */
const TERMINAL=new Set(['completed','failed','cancelled','interrupted']);
const statusOf=value=>value==='unknown'?'interrupted':TERMINAL.has(value)?value:null;
const timestamp=value=>{if(typeof value!=='string')return null;const parsed=Date.parse(value);return Number.isFinite(parsed)?new Date(parsed).toISOString():null;};
const errorText=value=>typeof value==='string'?value:typeof value?.message==='string'?value.message:'';
const count=value=>Number.isSafeInteger(value) && value>=0 && value<=10_000;

/** Validate a replicated outcome and discard fields that do not belong to this presentation schema. */
export function normalizeTaskOutcome(value) {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const status=statusOf(value.status),finishedAt=timestamp(value.finishedAt);if(!status || !finishedAt)return null;
  const result={status,finishedAt};
  // An overlong incoming error is omitted: clipping it before redaction could expose a credential prefix.
  if(typeof value.error==='string' && value.error && value.error.length<=500)result.error=value.error;
  if(value.checks && count(value.checks.passed) && count(value.checks.failed) && value.checks.passed+value.checks.failed>0)result.checks={passed:value.checks.passed,failed:value.checks.failed};
  return result;
}

function outcomeFor(record,redact) {
  const value={status:record?.status,finishedAt:record?.finishedAt || record?.updatedAt};
  const error=errorText(record?.error);if(error)value.error=String(redact(error)).slice(0,500);
  const verification=record?.verification;
  if(verification?.coverage==='declared_checks' && Array.isArray(verification.checks) && verification.checks.length) {
    const passed=verification.checks.filter(check=>check?.passed===true).length;
    value.checks={passed,failed:verification.checks.length-passed};
  }
  return normalizeTaskOutcome(value);
}

function contextFor(message,record) {
  let changed=false;
  for(const field of ['roomId','routineId'])if(!message[field] && typeof record?.[field]==='string' && record[field]){message[field]=record[field];changed=true;}
  return changed;
}

/** Called inside the terminal-state commit, including failures that have no partial reply. */
export function recordTaskOutcome(state,botId,run,redact=value=>value) {
  const outcome=outcomeFor(run,redact);if(!outcome)return false;
  const message=(state.messages?.[botId] || []).find(item=>item.role==='user' && !['answer','steer'].includes(item.kind) && item.runId===run.id);if(!message)return false;
  contextFor(message,run);message.taskOutcome=outcome;return true;
}

/** A room turn has its own outcome, independent of the statuses of individual member runs. */
export function recordRoomOutcome(state,roomId,drive,redact=value=>value) {
  const outcome=outcomeFor(drive,redact);if(!outcome)return false;
  const message=(state.roomMessages?.[roomId] || []).find(item=>item.role==='user' && item.driveId===drive.id);if(!message)return false;
  message.taskOutcome=outcome;return true;
}

const terminalAudit=(entries,group,ownerField,idField)=>{
  const results=new Map();
  for(const entry of entries || []) {
    if(!String(entry?.type || '').startsWith(`${group}.`))continue;
    const status=statusOf(entry.type.slice(group.length+1)),finishedAt=timestamp(entry.createdAt);
    if(!status || !finishedAt || !entry[ownerField] || !entry[idField])continue;
    const key=`${entry[ownerField]}\n${entry[idField]}`,previous=results.get(key);
    // The earliest terminal audit is stable if later fallback evidence or duplicate records exist.
    if(!previous || finishedAt<previous.finishedAt)results.set(key,{status,finishedAt});
  }
  return results;
};

/**
 * Upgrade retained local evidence once. Synced metadata always wins over migration fallbacks.
 * An orphan request or arbitrary assistant text never proves completion. Legacy completed replies
 * remain readable by Dashboard, while partial replies can supply only an explicit non-success status.
 */
export function backfillTaskOutcomes(state,redact=value=>value) {
  let changed=0;
  const runs=terminalAudit(state.activity,'run','botId','runId'),rooms=terminalAudit(state.activity,'room','roomId','driveId');
  for(const [botId,messages] of Object.entries(state.messages || {})) {
    const records=new Map((state.runHistory?.[botId] || []).map(record=>[record.id,record]));
    const current=state.runs?.[botId];if(current)records.set(current.id,current);
    const partials=new Map();
    for(const reply of messages) {
      const status=reply?.partial===true && statusOf(reply.runStatus),finishedAt=timestamp(reply?.createdAt);
      if(reply?.role!=='assistant' || !reply.runId || !status || status==='completed' || !finishedAt)continue;
      const previous=partials.get(reply.runId);
      if(!previous || finishedAt<previous.finishedAt)partials.set(reply.runId,{status,finishedAt});
    }
    for(const message of messages) {
      if(message?.role!=='user' || ['answer','steer'].includes(message.kind) || !message.runId)continue;
      const record=records.get(message.runId);let updated=contextFor(message,record);
      if(!normalizeTaskOutcome(message.taskOutcome)) {
        const audit=runs.get(`${botId}\n${message.runId}`),local=outcomeFor(record,redact);
        const outcome=audit?{...(local?.status===audit.status?local:{}),...audit}:local || partials.get(message.runId);
        if(outcome){message.taskOutcome=outcome;updated=true;}
      }
      if(updated)changed++;
    }
  }
  for(const [roomId,messages] of Object.entries(state.roomMessages || {}))for(const message of messages) {
    if(message?.role!=='user' || !message.driveId || normalizeTaskOutcome(message.taskOutcome))continue;
    const drive=state.roomDrives?.[roomId],local=drive?.id===message.driveId?outcomeFor(drive,redact):null,audit=rooms.get(`${roomId}\n${message.driveId}`);
    const outcome=audit?{...(local?.status===audit.status?local:{}),...audit}:local;
    if(outcome){message.taskOutcome=outcome;changed++;}
  }
  return changed;
}
