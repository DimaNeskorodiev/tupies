import { ensure, id, now } from './store.mjs';

const canonical=value=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const fileCheck=check=>check.kind?.startsWith('file_');
const observation=(records,callId)=>{const found=(records || []).filter(r=>r.callId===callId);return found.length===1?found[0]:null;};

/** Requirements are engine-owned goals; child runs and their receipts are immutable attempts. */
export function ensureDeliverableIds(run) {
  for(const item of run.requiredDeliverables || []) {
    item.id ||= id('deliverable');
    item.attempts ||= item.runId?[{runId:item.runId,status:item.status,legacy:true}]:[];
    for(const attempt of item.attempts)if(!attempt.callId) {
      const matches=(run.workRecords || []).filter(r=>r.tool==='delegate_task' && r.childRunId===attempt.runId);
      if(matches.length===1)attempt.callId=matches[0].callId;
    }
    item.baselineChecks ||= [];
    item.guards ||= {denied:[],unknown:[]};
  }
  return run.requiredDeliverables || [];
}

export function hydrateLegacyDeliverables(run,lookup) {
  for(const item of ensureDeliverableIds(run))if(item.attempts.some(a=>a.legacy) && !item.legacyHydrated) {
    const child=lookup(item.botId,item.runId);
    if(!child){item.guards.untrackedUnknown=true;continue;}
    for(const fingerprint of child.deniedCalls || [])if(!item.guards.denied.includes(fingerprint))item.guards.denied.push(fingerprint);
    for(const record of child.workRecords || [])if(record.outcome==='unknown' || record.errorCode==='denied') {
      const target=record.errorCode==='denied'?item.guards.denied:item.guards.unknown;
      if(record.requestDigest){if(!target.includes(record.requestDigest))target.push(record.requestDigest);}
      else item.guards.untrackedUnknown=true;
    }
    for(const check of child.outcomeChecks || [])if(!item.baselineChecks.some(c=>c.check.id===check.id))item.baselineChecks.push({check:structuredClone(check),passed:child.verification?.checks?.some(c=>c.id===check.id && c.passed) || false,...(!fileCheck(check)?{record:structuredClone(observation(child.workRecords,check.callId))}:{})});
    item.legacyHydrated=true;
  }
}

export function prepareDeliverable(run,{botId,expectedOutput='',deliverableId='',callId=''}) {
  const items=ensureDeliverableIds(run);
  let item;
  if(deliverableId) {
    item=items.find(r=>r.id===deliverableId);
    ensure(item,404,'This deliverableId does not belong to the current task.');
    ensure(item.botId===botId,403,'A repair must use the original teammate. Another bot cannot certify this requirement.');
    ensure(item.status!=='completed',409,'This required deliverable is already verified. Inspect its result instead of repeating it.');
  } else if(expectedOutput) {
    item=items.find(r=>r.botId===botId && r.expected===expectedOutput && r.status!=='completed');
    const pending=items.filter(r=>r.botId===botId && r.status!=='completed');
    ensure(item || !pending.length,409,`This teammate has unfinished required work. Repair it with delegate_task and deliverableId (${pending.map(r=>r.id).join(', ')}). Keep its original requirement; put correction instructions in task.`);
    if(!item) {
      ensure(items.length<64,400,'This task reached its retained required-deliverable limit.');
      item={id:id('deliverable'),botId,expected:expectedOutput,status:'pending',attempts:[],baselineChecks:[],guards:{denied:[],unknown:[]}};
      (run.requiredDeliverables ||= []).push(item);
    }
  }
  if(!item)return null;
  ensure(!item.guards.untrackedUnknown,409,'An earlier teammate action has an unknown outcome without an exact retained identity. Inspect its actual destination before attempting new delegated work.');
  ensure(!item.attempts.some(a=>a.callId===callId && !a.legacy),409,'This delegation call identity has already been admitted. Use a fresh call ID for a repair.');
  return structuredClone(item);
}

/** Fresh reads must retain predicates; fresh observations must identify the same actual action. */
function compatibleCheck(before,after,oldRecord,newRecord) {
  if(!after || before.id!==after.id || before.kind!==after.kind)return false;
  if(fileCheck(before))return same(before,after);
  return Boolean(oldRecord?.requestDigest && oldRecord.requestDigest===newRecord?.requestDigest && oldRecord.tool===newRecord.tool);
}

export function recordDeliverableAttempt(run,requirementId,child,{callId,tools=[]}) {
  const item=ensureDeliverableIds(run).find(r=>r.id===requirementId);
  ensure(item,409,'The required deliverable changed before its result was recorded.');
  const checks=structuredClone(child.outcomeChecks || []),records=child.workRecords || [],verified=child.verification;
  const missing=[];
  for(const original of item.baselineChecks) {
    const next=checks.find(c=>c.id===original.check.id),r=next && observation(records,next.callId);
    // A successful historical observation stays an observation; it is never re-labelled as a new attempt.
    if(!fileCheck(original.check) && original.passed)continue;
    if(!compatibleCheck(original.check,next,original.record,r))missing.push(original.check);
  }
  const passed=child.status==='completed' && verified?.passed===true && checks.length>0 && !missing.length;
  for(const check of checks)if(!item.baselineChecks.some(c=>c.check.id===check.id)) {
    const result=verified?.checks?.find(c=>c.id===check.id);
    item.baselineChecks.push({check:structuredClone(check),passed:result?.passed===true,...(!fileCheck(check)?{record:structuredClone(observation(records,check.callId))}: {})});
  }
  ensure(item.baselineChecks.length<=24,400,'The required deliverable exceeded its retained acceptance-check limit.');
  const guards=item.guards;
  for(const fingerprint of child.deniedCalls || [])if(!guards.denied.includes(fingerprint))guards.denied.push(fingerprint);
  for(const record of records)if(record.outcome==='unknown' || record.errorCode==='denied') {
    const target=record.errorCode==='denied'?guards.denied:guards.unknown;
    if(record.requestDigest){if(!target.includes(record.requestDigest))target.push(record.requestDigest);}
    else if(record.outcome==='unknown')guards.untrackedUnknown=true;
  }
  ensure(guards.denied.length+guards.unknown.length<=1000,400,'The retained action-safety journal is full; automatic repair is blocked.');
  const status=passed?'completed':child.status==='completed'?'partial':'failed';
  const attempt={runId:child.id,callId,status,at:now(),verification:verified?{passed:verified.passed,checks:(verified.checks || []).map(c=>({id:c.id,kind:c.kind,passed:c.passed}))}:null};
  item.attempts.push(attempt);
  const pinned=new Set((run.outcomeChecks || []).filter(c=>c.kind==='teammate_completed').map(c=>c.callId));
  if(item.attempts.length>16)item.attempts=item.attempts.filter((a,index,all)=>index===0 || index>=all.length-12 || pinned.has(a.callId));
  Object.assign(item,{runId:child.id,status,unmet:missing.length?missing.map(c=>`Retain original check ${c.id} (${c.kind}).`):passed?[]:[child.error || 'Declare and pass mechanical checks for the original required result.']});
  if(passed) {
    const pinnedRecords=new Set(checks.filter(c=>!fileCheck(c)).map(c=>c.callId));
    item.accepted={runId:child.id,callId,checks,records:structuredClone(records.filter(r=>pinnedRecords.has(r.callId))),tools:[...tools]};
    delete item.currentVerification;
  } else delete item.accepted;
  return structuredClone(item);
}

export function requiredDeliverableForCall(run,callId) {
  const matches=(run.requiredDeliverables || []).filter(item=>(item.attempts || []).some(a=>a.callId===callId));
  return matches.length===1?matches[0]:null;
}

export function deliverableRepairFeedback(run) {
  return (run.requiredDeliverables || []).filter(r=>r.status!=='completed').map(r=>({deliverableId:r.id,botId:r.botId,expectedOutput:r.expected,status:r.status,unmet:r.unmet || [],repair:{tool:'delegate_task',arguments:{botId:r.botId,deliverableId:r.id,task:'Inspect the retained work, repair the original result and declare/preserve its actual mechanical checks. Do not repeat already-applied, denied or uncertain actions.'}}}));
}
