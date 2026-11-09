import { ensure, id, now } from './store.mjs';
import { createHash } from 'node:crypto';

const canonical=value=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const fileCheck=check=>check.kind?.startsWith('file_');
const observation=(records,callId)=>{const found=(records || []).filter(r=>r.callId===callId);return found.length===1?found[0]:null;};
const repairReads=new Set(['http_fetch','web_extract','documents_read','workspace_read','workspace_list','workspace_glob','workspace_search','browser_text','session_read','brain_read','brain_links','skills_list','skills_read','skills_file','skills_search','skills_inspect','integration_list','bots_list','routines_list']);
function observedRequest(child,record,history=[]) {
  if(!record?.requestDigest || record.errorCode==='denied' || record.outcome==='unknown' || !repairReads.has(record.tool))return null;
  let events=(child.events || []).filter(event=>event.type==='tool.started' && event.toolCallId===record.callId && event.tool===record.tool);
  if(!events.length) {
    const calls=history.filter(message=>message.runId===child.id && message.role==='assistant').flatMap(message=>message.tool_calls || []).filter(call=>call.id===record.callId && (call.function?.name || call.name)===record.tool);
    if(calls.length===1) {
      let args=calls[0].function?.arguments ?? calls[0].arguments;
      if(typeof args==='string')try{args=args.length<=16000?JSON.parse(args):null;}catch{args=null;}
      events=[{arguments:args}];
    }
  }
  if(events.length!==1)return null;
  const args=events[0].arguments;
  if(!args || typeof args!=='object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args))>16000)return null;
  const digest=createHash('sha256').update(JSON.stringify([record.tool,canonical(args)])).digest('hex');
  return digest===record.requestDigest?{tool:record.tool,arguments:structuredClone(args)}:null;
}
function retainedCheck(child,check,passed) {
  const record=!fileCheck(check)?observation(child.workRecords,check.callId):null;
  const request=observedRequest(child,record);
  return {check:structuredClone(check),passed,runId:child.id,...(!fileCheck(check)?{record:structuredClone(record),...(request?{request}:{})}:{})};
}

function nestedEvidence(child,checks) {
  const teammateChecks=checks.filter(check=>check.kind==='teammate_completed');
  if(!teammateChecks.length)return {};
  const jobs=(child.delegationJobs || []).filter(job=>teammateChecks.some(check=>check.delegationId===job.id)).map(job=>({id:job.id,botId:job.botId,callId:job.callId,status:job.status,childRunId:job.childRunId,...(job.result?{result:{botId:job.result.botId,runId:job.result.runId,status:job.result.status,...(job.result.error?{error:job.result.error}:{}),deliverable:job.result.deliverable?{id:job.result.deliverable.id,status:job.result.deliverable.status}:undefined}}:{})}));
  const requirements=(child.requiredDeliverables || []).filter(item=>jobs.some(job=>job.result?.deliverable?.id===item.id) || teammateChecks.some(check=>check.callId && item.attempts?.some(attempt=>attempt.callId===check.callId)));
  return {delegationJobs:structuredClone(jobs),requiredDeliverables:structuredClone(requirements)};
}

/** Failed read predicates need their original IDs and exact request, never an automatic replay. */
export function repairObservationGuidance(requirement,state) {
  return (requirement.baselineChecks || []).filter(item=>!fileCheck(item.check) && !item.passed).map(item=>{
    let request=item.request;
    if(!request && item.record) {
      const runIds=item.runId?[item.runId]:(requirement.attempts || []).map(attempt=>attempt.runId);
      const children=runIds.map(runId=>state.runs?.[requirement.botId]?.id===runId?state.runs[requirement.botId]:(state.runHistory?.[requirement.botId] || []).find(run=>run.id===runId)).filter(Boolean);
      const found=children.map(child=>observedRequest(child,item.record,state.conversations?.[child.sessionId || requirement.botId] || [])).filter(Boolean);
      if(found.length===1)request=found[0];
    }
    return {id:item.check.id,kind:item.check.kind,originalCallId:item.check.callId,...(item.record?{tool:item.record.tool,requestDigest:item.record.requestDigest}:{}),...(request?{readRequest:request}:{}),notice:request?'Inspect retained evidence; if this same read is still needed, run it with a fresh call ID and preserve this check ID and kind.':'The exact repeatable read request is unavailable. Inspect retained evidence and report the missing identity; do not invent a replacement or replay an action.'};
  });
}

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
    for(const check of child.outcomeChecks || [])if(!item.baselineChecks.some(c=>c.check.id===check.id))item.baselineChecks.push(retainedCheck(child,check,child.verification?.checks?.some(c=>c.id===check.id && c.passed) || false));
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
    item.baselineChecks.push(retainedCheck(child,check,result?.passed===true));
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
  for(const check of run.outcomeChecks || [])if(check.kind==='teammate_completed' && check.delegationId) {
    const jobs=(run.delegationJobs || []).filter(job=>job.id===check.delegationId);
    if(jobs.length===1)pinned.add(jobs[0].callId);
  }
  if(item.attempts.length>16)item.attempts=item.attempts.filter((a,index,all)=>index===0 || index>=all.length-12 || pinned.has(a.callId));
  Object.assign(item,{runId:child.id,status,unmet:missing.length?missing.map(c=>`Retain original check ${c.id} (${c.kind}).`):passed?[]:[child.error || 'Declare and pass mechanical checks for the original required result.']});
  if(passed) {
    const pinnedRecords=new Set(checks.filter(c=>!fileCheck(c)).map(c=>c.callId));
    item.accepted={runId:child.id,callId,checks,records:structuredClone(records.filter(r=>pinnedRecords.has(r.callId))),tools:[...tools],...nestedEvidence(child,checks)};
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
