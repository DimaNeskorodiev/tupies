import { createHash } from 'node:crypto';
import { ensure, now } from './store.mjs';
import { readWorkspaceBytes, groupsFor } from './agent-tools.mjs';
import { sessionKind, sessionOwner, modelHistoryForSession } from './sessions.mjs';
import { historySourceScope } from './history.mjs';
import { requiredDeliverableForCall } from './delegated-deliverables.mjs';

const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const text={type:'string',maxLength:240};
// These tools read actual source content or a bounded inventory/catalog. A successful
// listing proves only the returned inventory, never the contents or completeness of its entries.
export const SOURCE_READ_TOOLS=new Set(['http_fetch','web_extract','documents_read','workspace_read','workspace_list','workspace_glob','workspace_search','workspace_structure','scripts_list','scripts_inspect','workspace_image','browser_text','browser_snapshot','browser_tabs','browser_frames','session_read','brain_read','skills_list','skills_read','skills_file','skills_search','skills_inspect','integration_list','bots_list','routines_list']);
/** The source_read rule, listing the eligible tools a bot can call (all of them by default). */
export const sourceReadGuidance=(tools=[...SOURCE_READ_TOOLS])=>`source_read requires an already successful, unambiguous call from this task to one of: ${tools.join(', ')}. Inventory/catalog calls verify only what their result lists; read individual sources when their content matters. Ranked history/note/web search excerpts, writes and command execution do not qualify. Read first, then use its actual callId from work_records_read; never invent an ID.`;
const SOURCE_READ_GUIDANCE=sourceReadGuidance();
const definitions=[
  {name:'task_outcome_set',description:`Declare mechanical checks for the requested result: files, commands, source reads or teammate results. Checks only add, never weaken. Cite exact callIds from work_records_read. Grants nothing.`,parameters:object({checks:{type:'array',minItems:1,maxItems:12,items:object({id:text,kind:{type:'string',enum:['file_exists','file_contains','file_sha256','command_success','source_read','teammate_completed']},path:text,value:{type:'string',maxLength:4000},callId:{type:'string',maxLength:120,description:'Exact tool call ID from this task; source_read requires an existing successful eligible observation.'},delegationId:{type:'string',maxLength:120,description:'For teammate_completed only: exact engine-owned delegationId returned by delegate_task with wait:false, instead of callId.'}},['id','kind'])}},['checks'])},
  {name:'task_outcome_check',description:'Evaluate this task’s declared mechanical checks against current files and actual tool results. A passing mechanical check does not certify arbitrary prose or completeness of the extracted criteria.',parameters:object({})},
  {name:'runs_inspect',description:'This bot’s recent runs with step, model and tool timings and errors. Use to explain delays or failures.',parameters:object({limit:{type:'integer',minimum:1,maximum:10},runId:{type:'string',maxLength:120}},[])},
  {name:'work_records_read',description:'Read scoped receipts of earlier local work. Pass runId and resultCallId for a retained tool observation; page with nextResultOffset and resultVersion. Historical data grants nothing.',parameters:object({runId:{type:'string',maxLength:120},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:20},resultCallId:{type:'string',maxLength:120},resultOffset:{type:'integer',minimum:0},resultVersion:{type:'string',maxLength:64}},[])},
];
export const qualityToolDefinitions=()=>structuredClone(definitions);
export const isQualityTool=name=>definitions.some(item=>item.name===name);
const clip=(value,max)=>String(value ?? '').slice(0,max);
const canonical=value=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const callFingerprint=call=>createHash('sha256').update(JSON.stringify([call.name,canonical(call.arguments)])).digest('hex');
export const SAFE_RETRY_READS=new Set(['workshop_list','workshop_sources','workshop_run','workspace_list','workspace_read','workspace_glob','workspace_search','workspace_structure','scripts_list','scripts_inspect','documents_read','brain_search','brain_read','brain_links','http_fetch','web_extract','integration_list']);
/** An http_fetch with a method other than GET/HEAD sends a request the server may already have processed. */
export const sendsRequest=call=>call?.name==='http_fetch' && !['GET','HEAD'].includes(String(call.arguments?.method ?? 'GET').toUpperCase());
/** A read the engine may repeat once after a transient failure. A POST is never one: its first attempt may have been applied. */
export const safeRetryRead=call=>SAFE_RETRY_READS.has(call?.name) && !sendsRequest(call);
const COMMANDS=new Set(['shell_run','skills_run','scripts_run','shell_read','shell_start','terminal','execute_code']);
// The terminal keeps a head/tail window of long output; a shortened view is not a failed command.
const WINDOWED=new Set(['terminal','execute_code']);
const WORKSPACE_MUTATIONS=new Set(['workspace_write','workspace_edit','workspace_delete','documents_create','brain_write','brain_append']);
const privatePath=value=>typeof value==='string'?value.replace(/^\.\//,'').replace(/\/+$/,''):'';
// Browser navigation and input can submit or trigger site actions, including with saved sign-ins.
// An interrupted dispatch has an unknown outcome; recovery must not call it an unapplied read.
const READ_ONLY_TOOLS=new Set(['desktop_status','desktop_observe','desktop_verify',...SAFE_RETRY_READS,'memory_search','session_search','session_read','task_plan_get','tool_result_read','shell_read','shell_list','lsp_query','lsp_list','skills_list','skills_read','skills_file','skills_search','skills_inspect','workspace_image','browser_snapshot','browser_text','browser_tabs','browser_frames','task_outcome_check','work_records_read','runs_inspect','delegation_status']);

/** Reconcile only retained starts with no receipt; no absence of a receipt proves an action did not happen. */
export function reconcileWork(run,reason='The task ended before this tool result was retained.') {
  const records=run.workRecords ||= [],counts=new Map(),receiptLimit=run.executionPolicy?.mode==='autonomous'?1000:Math.max(60,Math.min(1000,run.limits?.toolCalls || 60));let interruptedPending=0;
  for(const record of records) {
    if(typeof record?.callId==='string')counts.set(record.callId,(counts.get(record.callId) || 0)+1);
    if(record?.status==='pending'){Object.assign(record,{status:'interrupted',outcome:'unknown',errorCode:'interrupted',error:clip(reason,500),reconciled:true});interruptedPending++;}
  }
  const starts=(run.events || []).filter(event=>event?.type==='tool.started' && typeof event.toolCallId==='string' && event.toolCallId && typeof event.tool==='string' && event.tool);
  const missing=[];
  for(const event of starts) {
    const count=counts.get(event.toolCallId) || 0;
    if(count)counts.set(event.toolCallId,count-1);else missing.push(event);
  }
  // One exact pending approval identifies the newest matching start, not every reused call ID.
  const pending=new Set();
  for(const control of run.pending_controls || []) {
    if(control?.kind!=='approval' || typeof control.tool!=='string' || !control.arguments || (run.approval?.request_id && control.prompt_id!==run.approval.request_id))continue;
    const event=[...missing].reverse().find(event=>!pending.has(event) && event.tool===control.tool && JSON.stringify(canonical(event.arguments))===JSON.stringify(canonical(control.arguments)));
    if(event)pending.add(event);
  }
  let added=0;
  for(const event of missing) {
    if(records.length>=receiptLimit)break;
    records.push({callId:clip(event.toolCallId,120),tool:clip(event.tool,120),status:'interrupted',outcome:pending.has(event)?'not_started':READ_ONLY_TOOLS.has(event.tool) && !sendsRequest({name:event.tool,arguments:event.arguments})?'not_applied':'unknown',errorCode:'interrupted',error:clip(reason,500),at:now(),reconciled:true});added++;
  }
  run.workReconciliation={coverage:'retained_tool_starts',retainedStarts:starts.length,added,interruptedPending,unresolved:missing.length-added};
  return run.workReconciliation;
}

/** No message from a model or remote service is interpreted as retry authority. */
export function toolFailure(error,{read=false,dispatched=false,denied=false}={}) {
  const status=Number(error?.status),code=error?.code;
  let errorCode='tool_failed',recovery='Inspect the actual state and choose a narrower or corrected approach.';
  if(denied || status===403){errorCode='denied';recovery='This action is refused. Do not retry or disguise it.';}
  else if(status===409){errorCode='stale_state';recovery='Read the current state and use its current revision before trying a changed request.';}
  else if([400,413,415,422].includes(status)){errorCode='invalid_arguments';recovery='Correct the arguments or narrow the request before trying again.';}
  else if(status===404 || status===501){errorCode='unavailable';recovery='Check capability and current resource identity; choose an available approach.';}
  else if(read && ([408,429,502,503,504].includes(status) || ['ETIMEDOUT','ECONNRESET','EAI_AGAIN'].includes(code))){errorCode='transient_read';recovery='A bounded retry of this explicitly classified read is allowed.';}
  // An HTTP error after mutation dispatch does not prove that the remote action never happened.
  const outcome=read?'not_applied':dispatched?'unknown':'not_started';
  return {error:clip(error?.message || error || 'Tool failed.',1500),errorCode,outcome,retryable:errorCode==='transient_read',recovery};
}

export function repeatedFailure(context,call) {
  const entry=context.failedCalls?.get(callFingerprint(call));
  return entry && (entry.denied || entry.unknown || entry.count>=2)?{error:'This unchanged failing call was blocked. Inspect current state or use a different approach.',errorCode:'repeated_failure',outcome:'not_started',retryable:false,recovery:entry.unknown?'The earlier action outcome is unknown. Inspect actual state; do not replay the action.':'Change the relevant inputs or state; a repeated denial cannot be bypassed.'}:null;
}

// Identical successful reads repeat at most twice per task; paging, polling and status tools are deliberately absent.
export const REPEAT_GUARDED_READS=new Set(['workspace_read','workspace_list','workspace_glob','workspace_search','workspace_structure','documents_read','skills_read','skills_file','skills_list','skills_search','skills_inspect','brain_read','brain_search','brain_links','memory_search','http_fetch','web_extract','web_search','browser_open','browser_new_tab','browser_text','browser_snapshot','session_search','session_read','integration_list']);
const guardedRead=call=>REPEAT_GUARDED_READS.has(call?.name) && !(call.name==='http_fetch' && call.arguments?.method!==undefined && !['GET','HEAD'].includes(String(call.arguments.method).toUpperCase()));
/** Blocks the third identical successful read in one task; mutating, paging and polling tools are never affected. */
export function repeatedRead(context,call) {
  if(!guardedRead(call))return null;
  const entry=context.completedReads?.get(callFingerprint(call));if(!entry || entry.count<2)return null;
  const previousResultId=entry.resultId && context.toolResults?.has(entry.resultId)?entry.resultId:undefined;
  return {error:'This exact read already returned the same result twice in this task. Reuse the earlier result or change the arguments.',errorCode:'repeated_read',outcome:'not_started',retryable:false,recovery:previousResultId?'The earlier result was shortened: page it with tool_result_read and previousResultId, or change the arguments.':'Use the earlier result already in this conversation, or change the arguments (a different path, query, URL, range or page).',...(previousResultId?{previousResultId}:{})};
}
/** Counts a completed call for repeatedRead. A successful state-changing call makes every earlier read stale. */
export function noteCompletedRead(context,call,{succeeded,resultId,stateChanging}={}) {
  if(stateChanging && succeeded!==undefined){context.completedReads?.clear();return;}
  if(!succeeded || !guardedRead(call))return;
  context.completedReads ||= new Map();const key=callFingerprint(call),entry=context.completedReads.get(key);
  context.completedReads.set(key,{count:(entry?.count || 0)+1,...(resultId || entry?.resultId?{resultId:resultId || entry.resultId}:{})});
}

export function workReceipt(call,output) {
  const study=call.name==='study_material',incompleteStudy=study && output?.status!=='completed';
  const command=COMMANDS.has(call.name),pending=command && !output?.error && ['running','starting'].includes(output?.status);
  const uncertainCommand=command && (output?.timedOut || output?.outputLimit || ['timed_out','output_limit','interrupted','stopped'].includes(output?.status) || (!pending && !Number.isInteger(output?.exitCode)));
  const badCommand=command && !pending && (uncertainCommand || output?.truncated && !WINDOWED.has(call.name) || output?.status==='failed' || output?.exitCode!==0);
  const httpStatus=['http_fetch','web_extract'].includes(call.name) && Number.isInteger(output?.status)?output.status:null,httpFailure=httpStatus!==null && (httpStatus<200 || httpStatus>=300);
  const failure=Boolean(output?.error || badCommand || httpFailure || incompleteStudy);
  const record={callId:clip(call.id,120),tool:call.name,requestDigest:callFingerprint(call),status:failure?'failed':pending?'pending':'succeeded',outcome:output?.outcome || (incompleteStudy?(output?.status==='partial' || output?.retained>0?'partial':'unknown'):failure && uncertainCommand?'unknown':failure && !command?'not_applied':pending?'pending':'observed'),at:now()};
  if(study)record.studyStatus=clip(output?.status || 'unverified',40);
  if(output?.errorCode)record.errorCode=clip(output.errorCode,60);
  if(incompleteStudy && !record.errorCode)record.errorCode='study_incomplete';
  if(httpStatus!==null)record.httpStatus=httpStatus;
  if(httpFailure)record.errorCode='http_status';
  if(failure)record.error=clip(output?.error || 'The command did not produce a verified successful result.',500);
  if(incompleteStudy && !output?.error)record.error='The learning task did not complete. Inspect its job receipt and any retained knowledge before another attempt.';
  if(httpFailure)record.error=`The source returned HTTP ${httpStatus}; this is not a successful source read.`;
  if(command && Number.isInteger(output?.exitCode))record.exitCode=output.exitCode;
  if(command && typeof output?.backend==='string')record.backend=clip(output.backend,40);
  if(output?.processId)record.processId=clip(output.processId,120);
  if(typeof output?.sha256==='string' && /^[a-f0-9]{64}$/.test(output.sha256))record.sha256=output.sha256;
  if(typeof output?.path==='string')record.path=clip(output.path,240);
  if(typeof output?.url==='string')record.url=clip(output.url,2000);
  if(['http_fetch','web_extract'].includes(call.name) && !failure)record.url ||= clip(call.arguments?.url,2000);
  if(call.name==='delegate_task')Object.assign(record,{...(output?.deliverable?.id?{deliverableId:clip(output.deliverable.id,100)}:{}),childRunId:clip(output?.runId,120),childStatus:clip(output?.status,40),deliverable:clip(output?.deliverable?.status,40)});
  if(!failure)record.resultDigest=createHash('sha256').update(JSON.stringify(output) ?? '').digest('hex');
  return record;
}

/** Only engine-recorded successful reads become child evidence references; no payload or authority crosses scope. */
export function delegatedSources(run,botId) {
  return (run.workRecords || []).filter(record=>record.status==='succeeded' && ['http_fetch','web_extract','workspace_read','documents_read','browser_text'].includes(record.tool) && (record.url || record.path)).slice(-12).map(record=>({botId,runId:run.id,callId:record.callId,tool:record.tool,scope:record.url?'public_web':'child_private_workspace',...(record.url?{url:clip(record.url,2000)}:{}),...(record.path?{path:clip(record.path,240)}:{}),...(record.sha256?{sha256:record.sha256}:{}),...(record.resultDigest?{resultDigest:record.resultDigest}:{}),...(record.httpStatus?{httpStatus:record.httpStatus}:{}),notice:'Reference to an observed child read. No cross-bot file access or action authority is granted.'}));
}

export async function recordWork(engine,context,call,output) {
  const record=engine.store.redactValue(workReceipt(call,output));
  context.failedCalls ||= new Map();const key=callFingerprint(call),entry=context.failedCalls.get(key);
  if(output?.errorCode==='repeated_read'){ /* A blocked duplicate read is not a new failure of the read itself. */ }
  else if(record.status==='failed')context.failedCalls.set(key,{count:(entry?.count || 0)+1,denied:entry?.denied || output?.errorCode==='denied',unknown:entry?.unknown || record.outcome==='unknown',tool:call.name,path:privatePath(call.arguments?.path ?? (['workspace_list','workspace_glob','workspace_search'].includes(call.name)?'.':'')),cwd:privatePath(call.arguments?.cwd ?? '.'),errorCode:record.errorCode});
  else context.failedCalls.delete(key);
  if(record.status==='succeeded' && WORKSPACE_MUTATIONS.has(call.name)) {
    const changed=privatePath(call.arguments?.path);
    for(const [fingerprint,failure] of context.failedCalls) {
      if(failure.denied || failure.unknown || failure.errorCode==='invalid_arguments')continue;
      const noteChange=call.name.startsWith('brain_') && failure.tool?.startsWith('brain_');
      const target=failure.path,related=changed && (target==='.' || target===changed || (target && changed.startsWith(`${target}/`)));
      const commandScope=COMMANDS.has(failure.tool) && (failure.cwd==='.' || !failure.cwd || changed===failure.cwd || changed.startsWith(`${failure.cwd}/`));
      if(noteChange || (SAFE_RETRY_READS.has(failure.tool) && related) || commandScope)context.failedCalls.delete(fingerprint);
    }
  }
  // Preserve the receipts of an explicitly budgeted long routine as well as ordinary chat work.
  await engine.store.mutate(state=>{engine.assertRunning(context);const run=state.runs[context.bot.id],records=run.workRecords ||= [];records.push(record);const limit=run.executionPolicy?.mode==='autonomous'?1000:Math.max(60,Math.min(1000,run.limits?.toolCalls || 60));const pinned=new Set((run.outcomeChecks || []).map(check=>check.callId).filter(Boolean)),keep=new Set(records.filter(item=>pinned.has(item.callId)));for(let index=records.length-1;index>=0 && keep.size<limit;index--)keep.add(records[index]);run.workRecords=records.filter(item=>keep.has(item));},{local:true});
  return record;
}

function validateChecks(checks) {
  ensure(Array.isArray(checks) && checks.length>=1 && checks.length<=12,400,'Use 1–12 outcome checks.');
  const ids=new Set();
  for(const c of checks) {
    ensure(c && Object.keys(c).every(key=>['id','kind','path','value','callId','delegationId'].includes(key)) && /^[\w-]{1,64}$/.test(c.id) && !ids.has(c.id),400,'Use unique safe outcome check IDs and supported fields.');ids.add(c.id);
    ensure(['file_exists','file_contains','file_sha256','command_success','source_read','teammate_completed'].includes(c.kind),400,'Choose a supported outcome check.');
    ensure(c.delegationId===undefined || c.kind==='teammate_completed',400,'Only teammate_completed can use a delegationId.');
    if(c.kind.startsWith('file_'))ensure(typeof c.path==='string' && c.path.length<=240 && c.path && !c.path.startsWith('/') && !/[\\\x00-\x1f]/.test(c.path) && c.path.split('/').every(part=>part && part!=='.' && part!=='..'),400,'Use a private relative file path.');
    else if(c.kind==='teammate_completed' && c.delegationId!==undefined)ensure(c.callId===undefined && typeof c.delegationId==='string' && c.delegationId.length>0 && c.delegationId.length<=120,400,'Use exactly one exact callId or engine-owned delegationId for a teammate check.');
    else ensure(typeof c.callId==='string' && c.callId.length>0 && c.callId.length<=120,400,'Use an exact tool call ID from this task.');
    if(c.kind==='file_contains')ensure(typeof c.value==='string' && c.value.length>0 && c.value.length<=4000,400,'Give literal expected file content of 1–4000 characters.');
    if(c.kind==='file_sha256')ensure(typeof c.value==='string' && /^[a-f0-9]{64}$/.test(c.value),400,'Use a full file sha256.');
  }
}

function sourceObservation(run,callId) {
  const matches=(run.workRecords || []).filter(record=>record.callId===callId);
  if(!matches.length)return {passed:false,detail:'No observation has this tool call ID in the current task. Run the source read first and use its exact callId from work_records_read.'};
  if(matches.length!==1)return {passed:false,detail:'The tool call ID is ambiguous; use an unambiguous observation from this task.'};
  const record=matches[0];
  if(!SOURCE_READ_TOOLS.has(record.tool))return {passed:false,detail:`The matching tool is not an eligible source read or inventory observation. Read the source with a supported tool before declaring this check. ${SOURCE_READ_GUIDANCE}`};
  if(record.status!=='succeeded' || ['http_fetch','web_extract'].includes(record.tool) && record.httpStatus!==undefined && (record.httpStatus<200 || record.httpStatus>=300))return {passed:false,detail:'The matching source observation did not succeed. Perform a successful read and use its exact callId for a new check.'};
  return {passed:true,detail:`Observed a successful ${record.tool} result for this exact call. A listing or excerpt proves only the returned data.`};
}

function verifiedRequirement(requirement,runId,callId) {
  return Boolean(requirement?.attempts?.some(a=>a.runId===runId && a.callId===callId) && requirement.status==='completed' && requirement.accepted && requirement.attempts.some(a=>a.runId===requirement.accepted.runId && a.callId===requirement.accepted.callId && a.status==='completed' && a.verification?.passed===true));
}

function delegationObservation(run,delegationId) {
  const matches=(run.delegationJobs || []).filter(job=>job.id===delegationId);
  if(!matches.length)return {passed:false,detail:'No engine-owned delegation has this ID in the current task.'};
  if(matches.length!==1)return {passed:false,detail:'The delegation ID is ambiguous; no unique engine-owned job can be verified.'};
  const job=matches[0],result=job.result;
  if(job.status!=='completed')return {passed:false,detail:'The delegated child has not completed successfully. Queued, running, failed and interrupted jobs do not pass.'};
  if(!job.childRunId || job.childRunId!==result?.runId || job.botId!==result?.botId || result.status!=='completed' || result.error || !['partial','completed'].includes(result.deliverable?.status))return {passed:false,detail:'The delegation result does not match a successful engine-recorded child run.'};
  if(result.deliverable?.id) {
    const requirements=(run.requiredDeliverables || []).filter(item=>item.id===result.deliverable.id),requirement=requirements.length===1?requirements[0]:null;
    const passed=requirement?.botId===job.botId && verifiedRequirement(requirement,job.childRunId,job.callId);
    return {passed:Boolean(passed),detail:passed?'The engine-owned delegation is bound to its original required deliverable and verified child resolution; earlier attempt results remain unchanged.':'The original required deliverable still needs a verified repair or its current checks no longer pass.'};
  }
  const passed=result.deliverable?.status==='completed';
  return {passed,detail:passed?'Verified the completed engine-owned delegation and its exact child result.':'The child result remains partial; an acknowledgment or reply alone does not verify completion.'};
}

export async function checkOutcomes(engine,context) {
  const run=engine.current(context),checks=run?.outcomeChecks || [],results=[];
  for(const check of checks) {
    engine.assertRunning(context);let passed=false,detail='No matching successful observation.';
    try {
      if(check.kind.startsWith('file_')) {
        ensure(groupsFor(context.bot).includes('workspace'),403,'File outcome checks require the Workspace tools in this task’s capability snapshot.');
        const bytes=await readWorkspaceBytes(engine.store,context.bot.id,check.path,{maxBytes:check.kind==='file_contains'?1_000_000:20_000_000});
        passed=check.kind==='file_exists' || (check.kind==='file_contains'?new TextDecoder('utf-8',{fatal:true}).decode(bytes).includes(check.value):createHash('sha256').update(bytes).digest('hex')===check.value);
        detail=passed?'Checked the current private file.':'Current file does not match the declared check.';
      } else if(check.kind==='source_read') {
        ({passed,detail}=sourceObservation(run,check.callId));
      } else if(check.kind==='teammate_completed' && check.delegationId!==undefined) {
        ({passed,detail}=delegationObservation(run,check.delegationId));
      } else {
        const matches=(run.workRecords || []).filter(record=>record.callId===check.callId),r=matches.length===1?matches[0]:null;
        if(matches.length>1)detail='The tool call ID is ambiguous; use an unambiguous observation from this task.';
        const requirement=check.kind==='teammate_completed' && requiredDeliverableForCall(run,check.callId);
        if(requirement){passed=r?.status==='succeeded' && verifiedRequirement(requirement,r.childRunId,check.callId);detail=passed?'The original required deliverable has a verified child resolution; earlier attempt receipts remain unchanged.':'The original required deliverable still needs a verified repair.';}
        else {passed=Boolean(r?.status==='succeeded' && (check.kind==='command_success'?['shell_run','skills_run','scripts_run','shell_read','terminal','execute_code'].includes(r.tool) && r.exitCode===0:r.tool==='delegate_task' && r.childStatus==='completed' && r.deliverable==='completed'));if(passed)detail=check.kind==='command_success'?'Observed a successful command with exit code 0 for this exact call.':'Observed the completed teammate result for this exact delegation call.';}
      }
    } catch(error){if(context.controller?.signal.aborted)throw error;detail=clip(engine.store.redact(error.message),300);}
    results.push({id:check.id,kind:check.kind,passed,detail});
  }
  return {coverage:checks.length?'declared_checks':'not_declared',passed:checks.length?results.every(r=>r.passed):null,checks:results,notice:'Mechanical checks cover only declared properties. Extracted criteria are candidates, not proof of complete user intent or prose correctness.'};
}

// Another person's Telegram conversation stays private from every other lane, and the reverse.
function visibleRuns(context,current) {
  const ownTelegram=sessionKind(context.sessionId)==='telegram';
  return item=>ownTelegram?item.sessionId===context.sessionId:item.lane!=='telegram' && sessionKind(item.sessionId)!=='telegram' && !(item.source==='telegram' && !item.sessionId && !item.lane && !(item===current && context.sessionId===context.bot.id));
}
const elapsed=(from,to)=>{const value=Date.parse(to)-Date.parse(from);return Number.isFinite(value)?Math.max(0,value):null;};
/** Per-step model and tool timings from a live run's retained events. */
export function runTimeline(run) {
  const steps=[],tools=[],openModel=new Map(),openTool=new Map();
  for(const event of run?.events || []) {
    if(event.type==='model.started'){const step={step:event.step,model:event.model,startedAt:event.createdAt,durationMs:null};openModel.set(event.step,step);steps.push(step);}
    else if(event.type==='model.completed' && openModel.has(event.step)){const step=openModel.get(event.step);openModel.delete(event.step);Object.assign(step,{durationMs:elapsed(step.startedAt,event.createdAt),toolCalls:event.toolCalls ?? 0,...(Number.isFinite(event.reasoningChars)?{reasoningChars:event.reasoningChars}:{})});}
    else if(event.type==='tool.started'){const tool={tool:event.tool,toolCallId:event.toolCallId,startedAt:event.createdAt,durationMs:null,outcome:'running'};openTool.set(event.toolCallId,tool);tools.push(tool);}
    else if(event.type==='tool.skipped' && openTool.has(event.toolCallId))Object.assign(openTool.get(event.toolCallId),{outcome:'skipped',reason:event.reason});
    else if(event.type==='tool.completed' && openTool.has(event.toolCallId)){const tool=openTool.get(event.toolCallId);openTool.delete(event.toolCallId);Object.assign(tool,{durationMs:elapsed(tool.startedAt,event.createdAt),outcome:tool.outcome==='skipped'?'skipped':event.error?'error':'ok'});}
  }
  return {steps:steps.slice(-60),tools:tools.slice(-120)};
}
async function inspectRuns(engine,context,args) {
  const limit=args.limit ?? 5;
  ensure(Number.isSafeInteger(limit) && limit>=1 && limit<=10 && (args.runId===undefined || typeof args.runId==='string' && args.runId.length>0 && args.runId.length<=120),400,'Use a limit from 1 to 10 and an exact run ID.');
  const botId=context.bot.id,current=engine.current(context),visible=visibleRuns(context,current);
  const history=(engine.store.state.runHistory?.[botId] || []).filter(visible);
  const summary=run=>({runId:run.id,status:run.status,source:run.source || 'chat',model:run.model || '',steps:run.steps || 0,toolCalls:Number.isFinite(run.toolCalls)?run.toolCalls:(run.events || []).filter(event=>event.type==='tool.completed').length,...(Number.isFinite(run.durationMs)?{durationMs:run.durationMs}:{}),...(run.metering?.totalTokens!==undefined?{usage:run.metering}:{}),...(run.error?{error:clip(typeof run.error==='string'?run.error:run.error.message,500)}:{}),createdAt:run.createdAt,...(run.finishedAt?{finishedAt:run.finishedAt}:{})});
  let runs=history;
  if(args.runId!==undefined){const target=args.runId===current?.id?current:history.find(run=>run.id===args.runId);ensure(target && (target===current || visible(target)),404,'No run with this ID is visible to this conversation.');runs=target===current?[]:[target];}
  else runs=history.slice(0,limit);
  const target=current && (args.runId===undefined || args.runId===current.id)?current:null;
  const runIds=new Set([...runs.map(run=>run.id),...(target?[target.id]:[])]);
  const log=engine.engineLog;let records=[];
  if(log?.read)try{records=await log.read({filter:record=>['model.call','tool.call'].includes(record.kind) && record.botId===botId && runIds.has(record.runId),limit:200});}catch { records=[]; }
  return engine.store.redactValue({botId,runs:runs.map(summary),...(target?{current:{...summary(target),timeline:runTimeline(target)}}:{}),log:{available:Boolean(log?.read),records},notice:'This bot’s own run diagnostics. Durations are engine-measured; earlier runs keep summaries only, with per-call detail from the local engine log for about two days. No action is replayed.'});
}

export async function executeQualityTool(engine,context,name,args) {
  const definition=definitions.find(item=>item.name===name);ensure(definition,400,'Unknown quality tool.');
  ensure(args && typeof args==='object' && !Array.isArray(args) && Object.keys(args).every(key=>Object.hasOwn(definition.parameters.properties,key)) && definition.parameters.required.every(key=>Object.hasOwn(args,key)) && Buffer.byteLength(JSON.stringify(args))<=60000,400,'Use supported quality-tool arguments.');
  engine.assertRunning(context);
  if(name==='task_outcome_set') {
    validateChecks(args.checks);
    ensure(!args.checks.some(check=>check.kind.startsWith('file_')) || groupsFor(context.bot).includes('workspace'),403,'File outcome checks require the Workspace tools in this task’s capability snapshot.');
    await engine.store.mutate(state=>{engine.assertRunning(context);const run=state.runs[context.bot.id],previous=run.outcomeChecks || [];for(const old of previous)ensure(args.checks.some(c=>JSON.stringify(canonical(c))===JSON.stringify(canonical(old))),409,'Declared checks cannot be removed or weakened. Add a new check while preserving existing checks.');for(const check of args.checks){if(previous.some(old=>JSON.stringify(canonical(check))===JSON.stringify(canonical(old))))continue;if(check.kind==='source_read'){const observed=sourceObservation(run,check.callId);ensure(observed.passed,400,`${observed.detail} ${SOURCE_READ_GUIDANCE}`);}if(check.kind==='teammate_completed' && check.delegationId!==undefined)ensure((run.delegationJobs || []).filter(job=>job.id===check.delegationId).length===1,400,'Use an exact, unambiguous engine-owned delegationId returned by delegate_task with wait:false in this task.');}run.outcomeChecks=engine.store.redactValue(args.checks);},{local:true});
    return {checks:engine.current(context).outcomeChecks,notice:'Criteria extracted by the model; verification still required.'};
  }
  if(name==='task_outcome_check')return checkOutcomes(engine,context);
  if(name==='runs_inspect')return inspectRuns(engine,context,args);
  const runId=args.runId || context.runId,offset=args.offset ?? 0,limit=args.limit ?? 10;
  ensure(typeof runId==='string' && runId.length<=120 && Number.isSafeInteger(offset) && offset>=0 && offset<=1000 && Number.isSafeInteger(limit) && limit>=1 && limit<=20,400,'Use a valid run ID, offset and limit.');
  const current=engine.current(context),record=current?.id===runId?current:(engine.store.state.runHistory?.[context.bot.id] || []).find(r=>r.id===runId);
  const visible=visibleRuns(context,current);
  ensure(record && visible(record),404,'No work record is available to this conversation.');
  const records=record.workRecords || [];
  if(args.resultCallId!==undefined){
    const resultOffset=args.resultOffset ?? 0;
    ensure(typeof args.resultCallId==='string' && args.resultCallId.length>0 && args.resultCallId.length<=120 && Number.isSafeInteger(resultOffset) && resultOffset>=0,400,'Use an exact retained call ID and result offset.');
    const lane=record.sessionId || context.bot.id;
    ensure(sessionOwner(lane)===context.bot.id && (runId===context.runId || historySourceScope(engine.store.state,context).runIds.has(runId)),404,'No retained tool observation is available to this conversation.');
    const receipts=records.filter(row=>row.callId===args.resultCallId);
    const matches=modelHistoryForSession(engine.store.state.conversations?.[lane] || [],lane).filter(row=>row.role==='tool' && row.runId===runId && row.tool_call_id===args.resultCallId);
    ensure(receipts.length===1 && matches.length===1 && typeof matches[0].content==='string',404,'This tool observation is missing, expired or no longer retained. Do not replay an action to reconstruct it.');
    const content=engine.store.redact(matches[0].content),resultVersion=createHash('sha256').update(content).digest('hex');
    ensure(resultOffset===0 && args.resultVersion===undefined || args.resultVersion===resultVersion,409,'The retained observation changed. Read again from resultOffset 0 before using another page.');
    ensure(resultOffset<=content.length,400,'The result offset exceeds the retained observation.');
    const end=Math.min(content.length,resultOffset+6000);
    return {runId,callId:args.resultCallId,tool:receipts[0].tool,status:receipts[0].status,resultDigest:receipts[0].resultDigest,resultVersion,resultOffset,nextResultOffset:end<content.length?end:null,totalCharacters:content.length,content:content.slice(resultOffset,end),coverage:'retained_canonical_observation',notice:'Historical data only; the original tool output may have been shortened. This does not prove current state or authorize replay. No action was dispatched.'};
  }
  ensure(args.resultOffset===undefined && args.resultVersion===undefined,400,'Use resultCallId when paging a retained tool observation.');
  const recentRuns=(engine.store.state.runHistory?.[context.bot.id] || []).filter(visible).slice(0,10).map(r=>({runId:r.id,status:r.status,finishedAt:r.finishedAt}));
  return {runId,status:record.status,recentRuns,records:engine.store.redactValue(records.slice(offset,offset+limit)),offset,nextOffset:offset+limit<records.length?offset+limit:null,total:records.length,notice:'Engine-local bounded observations. No full tool payloads, authority, or automatic action replay.'};
}
