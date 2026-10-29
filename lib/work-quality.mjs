import { createHash } from 'node:crypto';
import { ensure, now } from './store.mjs';
import { readWorkspaceBytes, groupsFor } from './agent-tools.mjs';
import { sessionKind } from './sessions.mjs';

const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const text={type:'string',maxLength:240};
const definitions=[
  {name:'task_outcome_set',description:'Declare mechanical checks for the requested result. Checks are model-extracted candidates, not proof that every user requirement was captured. Existing checks cannot be removed or weakened. File checks re-read the actual private file; command/source/teammate checks use exact tool call IDs from this run. These checks cannot authorize actions.',parameters:object({checks:{type:'array',minItems:1,maxItems:12,items:object({id:text,kind:{type:'string',enum:['file_exists','file_contains','file_sha256','command_success','source_read','teammate_completed']},path:text,value:{type:'string',maxLength:4000},callId:text},['id','kind'])}},['checks'])},
  {name:'task_outcome_check',description:'Evaluate this task’s declared mechanical checks against current files and actual tool results. A passing mechanical check does not certify arbitrary prose or completeness of the extracted criteria.',parameters:object({})},
  {name:'work_records_read',description:'Read bounded local work receipts for this bot, from this run or an earlier visible run. Receipts record actual tool outcomes and source identities, not full payloads or permission. Third-party conversations are isolated. Records do not sync and older records can expire.',parameters:object({runId:{type:'string',maxLength:120},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:20}},[])},
];
export const qualityToolDefinitions=()=>structuredClone(definitions);
export const isQualityTool=name=>definitions.some(item=>item.name===name);
const clip=(value,max)=>String(value ?? '').slice(0,max);
const canonical=value=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const callFingerprint=call=>createHash('sha256').update(JSON.stringify([call.name,canonical(call.arguments)])).digest('hex');
export const SAFE_RETRY_READS=new Set(['workspace_list','workspace_read','workspace_glob','workspace_search','documents_read','brain_search','brain_read','brain_links','http_fetch','integration_list']);
const COMMANDS=new Set(['shell_run','skills_run','shell_read','shell_start']);
const SOURCE_READ_TOOLS=new Set(['http_fetch','documents_read','workspace_read','browser_text','session_read','brain_read']);
const WORKSPACE_MUTATIONS=new Set(['workspace_write','workspace_edit','workspace_delete','documents_create','brain_write','brain_append']);
const privatePath=value=>typeof value==='string'?value.replace(/^\.\//,'').replace(/\/+$/,''):'';
const READ_ONLY_TOOLS=new Set([...SAFE_RETRY_READS,'memory_search','session_search','session_read','task_plan_get','tool_result_read','shell_read','shell_list','lsp_query','lsp_list','skills_list','skills_read','skills_file','skills_search','skills_inspect','workspace_image','browser_open','browser_click','browser_scroll','browser_text','browser_back','task_outcome_check','work_records_read']);

/** Reconcile only retained starts with no receipt; no absence of a receipt proves an action did not happen. */
export function reconcileWork(run,reason='The task ended before this tool result was retained.') {
  const records=run.workRecords ||= [],counts=new Map();let interruptedPending=0;
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
    if(records.length>=60)break;
    records.push({callId:clip(event.toolCallId,120),tool:clip(event.tool,120),status:'interrupted',outcome:pending.has(event)?'not_started':READ_ONLY_TOOLS.has(event.tool)?'not_applied':'unknown',errorCode:'interrupted',error:clip(reason,500),at:now(),reconciled:true});added++;
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

export function workReceipt(call,output) {
  const command=COMMANDS.has(call.name),pending=command && !output?.error && ['running','starting'].includes(output?.status);
  const uncertainCommand=command && (output?.timedOut || ['timed_out','output_limit','interrupted','stopped'].includes(output?.status) || (!pending && !Number.isInteger(output?.exitCode)));
  const badCommand=command && !pending && (uncertainCommand || output?.truncated || output?.status==='failed' || output?.exitCode!==0);
  const httpStatus=call.name==='http_fetch' && Number.isInteger(output?.status)?output.status:null,httpFailure=httpStatus!==null && (httpStatus<200 || httpStatus>=300);
  const failure=Boolean(output?.error || badCommand || httpFailure);
  const record={callId:clip(call.id,120),tool:call.name,status:failure?'failed':pending?'pending':'succeeded',outcome:output?.outcome || (failure && uncertainCommand?'unknown':failure && !command?'not_applied':pending?'pending':'observed'),at:now()};
  if(output?.errorCode)record.errorCode=clip(output.errorCode,60);
  if(httpStatus!==null)record.httpStatus=httpStatus;
  if(httpFailure)record.errorCode='http_status';
  if(failure)record.error=clip(output?.error || 'The command did not produce a verified successful result.',500);
  if(httpFailure)record.error=`The source returned HTTP ${httpStatus}; this is not a successful source read.`;
  if(command && Number.isInteger(output?.exitCode))record.exitCode=output.exitCode;
  if(output?.processId)record.processId=clip(output.processId,120);
  if(typeof output?.sha256==='string' && /^[a-f0-9]{64}$/.test(output.sha256))record.sha256=output.sha256;
  if(typeof output?.path==='string')record.path=clip(output.path,240);
  if(typeof output?.url==='string')record.url=clip(output.url,2000);
  if(call.name==='http_fetch' && !failure)record.url ||= clip(call.arguments?.url,2000);
  if(call.name==='delegate_task')Object.assign(record,{childRunId:clip(output?.runId,120),childStatus:clip(output?.status,40),deliverable:clip(output?.deliverable?.status,40)});
  if(!failure)record.resultDigest=createHash('sha256').update(JSON.stringify(output) ?? '').digest('hex');
  return record;
}

/** Only engine-recorded successful reads become child evidence references; no payload or authority crosses scope. */
export function delegatedSources(run,botId) {
  return (run.workRecords || []).filter(record=>record.status==='succeeded' && ['http_fetch','workspace_read','documents_read','browser_text'].includes(record.tool) && (record.url || record.path)).slice(-12).map(record=>({botId,runId:run.id,callId:record.callId,tool:record.tool,scope:record.url?'public_web':'child_private_workspace',...(record.url?{url:clip(record.url,2000)}:{}),...(record.path?{path:clip(record.path,240)}:{}),...(record.sha256?{sha256:record.sha256}:{}),...(record.resultDigest?{resultDigest:record.resultDigest}:{}),...(record.httpStatus?{httpStatus:record.httpStatus}:{}),notice:'Reference to an observed child read. No cross-bot file access or action authority is granted.'}));
}

export async function recordWork(engine,context,call,output) {
  const record=engine.store.redactValue(workReceipt(call,output));
  context.failedCalls ||= new Map();const key=callFingerprint(call),entry=context.failedCalls.get(key);
  if(record.status==='failed')context.failedCalls.set(key,{count:(entry?.count || 0)+1,denied:entry?.denied || output?.errorCode==='denied',unknown:entry?.unknown || record.outcome==='unknown',tool:call.name,path:privatePath(call.arguments?.path ?? (['workspace_list','workspace_glob','workspace_search'].includes(call.name)?'.':'')),cwd:privatePath(call.arguments?.cwd ?? '.'),errorCode:record.errorCode});
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
  // Per-run total tool calls are bounded too; this cap preserves every receipt within the normal 60-call limit.
  await engine.store.mutate(state=>{engine.assertRunning(context);const run=state.runs[context.bot.id];(run.workRecords ||= []).push(record);run.workRecords=run.workRecords.slice(-60);},{local:true});
  return record;
}

function validateChecks(checks) {
  ensure(Array.isArray(checks) && checks.length>=1 && checks.length<=12,400,'Use 1–12 outcome checks.');
  const ids=new Set();
  for(const c of checks) {
    ensure(c && Object.keys(c).every(key=>['id','kind','path','value','callId'].includes(key)) && /^[\w-]{1,64}$/.test(c.id) && !ids.has(c.id),400,'Use unique safe outcome check IDs and supported fields.');ids.add(c.id);
    ensure(['file_exists','file_contains','file_sha256','command_success','source_read','teammate_completed'].includes(c.kind),400,'Choose a supported outcome check.');
    if(c.kind.startsWith('file_'))ensure(typeof c.path==='string' && c.path.length<=240 && c.path && !c.path.startsWith('/') && !/[\\\x00-\x1f]/.test(c.path) && c.path.split('/').every(part=>part && part!=='.' && part!=='..'),400,'Use a private relative file path.');
    else ensure(typeof c.callId==='string' && c.callId.length>0 && c.callId.length<=120,400,'Use an exact tool call ID from this task.');
    if(c.kind==='file_contains')ensure(typeof c.value==='string' && c.value.length>0 && c.value.length<=4000,400,'Give literal expected file content of 1–4000 characters.');
    if(c.kind==='file_sha256')ensure(typeof c.value==='string' && /^[a-f0-9]{64}$/.test(c.value),400,'Use a full file sha256.');
  }
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
      } else {
        const matches=(run.workRecords || []).filter(record=>record.callId===check.callId),r=matches.length===1?matches[0]:null;
        if(matches.length>1)detail='The tool call ID is ambiguous; use an unambiguous observation from this task.';
        passed=Boolean(r?.status==='succeeded' && (check.kind==='command_success'?['shell_run','skills_run','shell_read'].includes(r.tool) && r.exitCode===0:check.kind==='source_read'?SOURCE_READ_TOOLS.has(r.tool):r.tool==='delegate_task' && r.childStatus==='completed' && r.deliverable==='completed'));
      }
    } catch(error){if(context.controller?.signal.aborted)throw error;detail=clip(engine.store.redact(error.message),300);}
    results.push({id:check.id,kind:check.kind,passed,detail});
  }
  return {coverage:checks.length?'declared_checks':'not_declared',passed:checks.length?results.every(r=>r.passed):null,checks:results,notice:'Mechanical checks cover only declared properties. Extracted criteria are candidates, not proof of complete user intent or prose correctness.'};
}

export async function executeQualityTool(engine,context,name,args) {
  const definition=definitions.find(item=>item.name===name);ensure(definition,400,'Unknown quality tool.');
  ensure(args && typeof args==='object' && !Array.isArray(args) && Object.keys(args).every(key=>Object.hasOwn(definition.parameters.properties,key)) && definition.parameters.required.every(key=>Object.hasOwn(args,key)) && Buffer.byteLength(JSON.stringify(args))<=60000,400,'Use supported quality-tool arguments.');
  engine.assertRunning(context);
  if(name==='task_outcome_set') {
    validateChecks(args.checks);
    ensure(!args.checks.some(check=>check.kind.startsWith('file_')) || groupsFor(context.bot).includes('workspace'),403,'File outcome checks require the Workspace tools in this task’s capability snapshot.');
    await engine.store.mutate(state=>{engine.assertRunning(context);const run=state.runs[context.bot.id];for(const old of run.outcomeChecks || [])ensure(args.checks.some(c=>JSON.stringify(canonical(c))===JSON.stringify(canonical(old))),409,'Declared checks cannot be removed or weakened. Add a new check while preserving existing checks.');run.outcomeChecks=engine.store.redactValue(args.checks);},{local:true});
    return {checks:engine.current(context).outcomeChecks,notice:'Criteria extracted by the model; verification still required.'};
  }
  if(name==='task_outcome_check')return checkOutcomes(engine,context);
  const runId=args.runId || context.runId,offset=args.offset ?? 0,limit=args.limit ?? 10;
  ensure(typeof runId==='string' && runId.length<=120 && Number.isSafeInteger(offset) && offset>=0 && offset<=60 && Number.isSafeInteger(limit) && limit>=1 && limit<=20,400,'Use a valid run ID, offset and limit.');
  const current=engine.current(context),record=current?.id===runId?current:(engine.store.state.runHistory?.[context.bot.id] || []).find(r=>r.id===runId);
  const ownTelegram=sessionKind(context.sessionId)==='telegram';
  const visible=item=>ownTelegram?item.sessionId===context.sessionId:item.lane!=='telegram' && sessionKind(item.sessionId)!=='telegram' && !(item.source==='telegram' && !item.sessionId && !item.lane && !(item===current && context.sessionId===context.bot.id));
  ensure(record && visible(record),404,'No work record is available to this conversation.');
  const records=record.workRecords || [];
  const recentRuns=(engine.store.state.runHistory?.[context.bot.id] || []).filter(visible).slice(0,10).map(r=>({runId:r.id,status:r.status,finishedAt:r.finishedAt}));
  return {runId,status:record.status,recentRuns,records:engine.store.redactValue(records.slice(offset,offset+limit)),offset,nextOffset:offset+limit<records.length?offset+limit:null,total:records.length,notice:'Engine-local bounded observations. No full tool payloads, authority, or automatic action replay.'};
}
