// What the engine itself observed during one task, as a small display-only summary for the owner.
//
// The summary is built only from engine records: work receipts, verified document artifacts, the final outcome-check
// results, required teammate deliverables and interruption reconciliation. It never reads the reply or any model text,
// never infers what the reply claims and never authorizes anything. Counts are bounded; labels are tool names only.
import { SOURCE_READ_TOOLS } from './work-quality.mjs';

const MAX_RECORDS=2000,MAX_COUNT=9999,MAX_ITEMS=8;
// Bookkeeping tools change no outside state and show nothing to the owner: plans, checks, paging, catalogs and reviews.
const INTERNAL=new Set(['task_plan_set','task_plan_get','tool_result_read','task_outcome_set','task_outcome_check','work_records_read','runs_inspect','tools_load','memory_refresh','ask_user','task_note','task_checkpoint','task_budget','site_access_review','action_review_result','memory_review_result','skill_review_result']);
const FILE_WRITES=new Set(['workspace_write','workspace_edit','documents_create']);
const SEARCHES=new Set(['web_search','workspace_search','workspace_glob','brain_search','memory_search','session_search','skills_search']);
const COMMANDS=new Set(['shell_run','skills_run','scripts_run','shell_read','terminal','execute_code']);
const MEMORY=new Set(['memory_set','brain_write','brain_append']);
// A failed read changed nothing; it is noted, not raised as something to fix.
const READS=new Set([...SOURCE_READ_TOOLS,...SEARCHES,'workspace_symbols','lsp_query','lsp_list','shell_list','desktop_status','desktop_observe','desktop_verify','memory_get','brain_links','delegation_status']);
// An owner's refusal, a blocked duplicate read and a blocked repeat of a known failure add no new problem.
const NOT_A_NEW_FAILURE=new Set(['repeated_read','repeated_failure']);

const plain=value=>value && typeof value==='object' && !Array.isArray(value);
const list=value=>Array.isArray(value)?value.slice(0,MAX_RECORDS).filter(plain):[];
const toolName=value=>typeof value==='string' && /^[a-z][a-z0-9_]{0,63}$/.test(value)?value:'';
const safeId=value=>typeof value==='string' && /^[\w.:-]{1,120}$/.test(value)?value:'';
const safePath=value=>typeof value==='string' && value.length<=240 && value && !/[\x00-\x1f\x7f]/.test(value)?value.replace(/^\.\//,'').slice(0,160):'';
const internal=tool=>INTERNAL.has(tool) || tool.startsWith('mission_');
const bump=(target,key,amount=1)=>{target[key]=Math.min(MAX_COUNT,(target[key] || 0)+amount);};

/**
 * A finished run's observed work as {status, checked, attention, notes?, items?}, or null when the task used no tools
 * that produced an observation (a plain conversational answer shows nothing).
 * - status 'attention': at least one attention count; 'checked': something was observed and nothing needs attention.
 * - checked / attention / notes: only non-zero counts; items: up to eight attention entries for a targeted redo.
 */
export function proofOfWork(run) {
  if(!plain(run))return null;
  const records=list(run.workRecords);
  const argumentsByCall=new Map();
  for(const event of list(run.events))if(event.type==='tool.started' && safeId(event.toolCallId) && plain(event.arguments))argumentsByCall.set(event.toolCallId,event.arguments);
  const pathOf=record=>safePath(record.path) || safePath(argumentsByCall.get(record.callId)?.path);
  const checked={},attention={},notes={},items=[];let observed=false;
  const item=(kind,fields)=>{if(items.length<MAX_ITEMS)items.push({kind,...Object.fromEntries(Object.entries(fields).filter(([,value])=>value))});};

  // A problem is settled when a later success repeats the exact request, the same tool on the same path, or reads
  // the same background process to a clean exit. A later different command does not settle a failed one.
  const settled=(index,record)=>{
    const tool=toolName(record.tool),path=pathOf(record),command=COMMANDS.has(tool);
    for(let later=index+1;later<records.length;later++) {
      const next=records[later];if(next.status!=='succeeded')continue;
      if(typeof record.requestDigest==='string' && record.requestDigest && next.requestDigest===record.requestDigest)return true;
      if(!command && path && toolName(next.tool)===tool && pathOf(next)===path)return true;
      if(safeId(record.processId) && next.processId===record.processId && toolName(next.tool)==='shell_read' && next.exitCode===0)return true;
    }
    return false;
  };

  const saved=new Set(),reads=new Set(),searches=new Set(),teammates=new Set(),processes=new Set(),problems=new Set();
  for(const [index,record] of records.entries()) {
    const tool=toolName(record.tool);if(!tool || internal(tool))continue;
    observed=true;
    if(record.status==='succeeded') {
      const path=pathOf(record);
      if(FILE_WRITES.has(tool))saved.add(path || `call:${record.callId}`);
      else if(tool==='workspace_delete'){if(path)saved.delete(path);bump(checked,'filesRemoved');}
      else if(SEARCHES.has(tool))searches.add(record.requestDigest || record.callId || index);
      else if(SOURCE_READ_TOOLS.has(tool))reads.add(record.requestDigest || record.callId || index);
      else if(COMMANDS.has(tool)){if(record.exitCode===0){const key=safeId(record.processId)?`process:${record.processId}`:`call:${index}`;if(!processes.has(key)){processes.add(key);bump(checked,'commandsRan');}}}
      else if(MEMORY.has(tool))bump(checked,'memorySaved');
      else if(tool==='integration_call')bump(checked,'integrationCalls');
      else if(tool==='delegate_task'){if(record.childStatus==='completed' && record.deliverable==='completed')teammates.add(safeId(record.deliverableId) || safeId(record.childRunId) || `call:${index}`);}
      else if(!READS.has(tool) && tool!=='shell_start')bump(checked,'otherActions');
      continue;
    }
    if(!['failed','interrupted'].includes(record.status) || NOT_A_NEW_FAILURE.has(record.errorCode))continue;
    if(record.errorCode==='denied'){bump(notes,'refused');continue;}
    // An interrupted read or an approval that was never answered did nothing.
    if(record.status==='interrupted' && record.outcome!=='unknown')continue;
    if(settled(index,record))continue;
    const key=`${record.status}:${record.requestDigest || `${tool}:${pathOf(record) || record.callId || index}`}`;if(problems.has(key))continue;problems.add(key);
    const fields={tool,callId:safeId(record.callId),path:pathOf(record)};
    if(record.status==='interrupted'){bump(attention,'interrupted');item('interrupted',fields);}
    else if(record.outcome==='unknown'){bump(attention,'unknownResults');item('unknown_result',fields);}
    else if(COMMANDS.has(tool)){bump(attention,'commandsFailed');item('command_failed',fields);}
    else if(READS.has(tool))bump(notes,'couldNotRead');
    else {bump(attention,'actionsFailed');item('action_failed',fields);}
  }
  // Starts beyond the retained receipt limit were reconciled without a record; their result is unknown.
  const unresolved=Number.isSafeInteger(run.workReconciliation?.unresolved) && run.workReconciliation.unresolved>0?run.workReconciliation.unresolved:0;
  if(unresolved){observed=true;bump(attention,'interrupted',unresolved);}

  // Documents verified as still present when the task finished.
  for(const artifact of list(run.artifacts)){const path=safePath(artifact.path);if(path){saved.add(path);observed=true;}}
  if(saved.size)checked.filesSaved=Math.min(MAX_COUNT,saved.size);
  if(reads.size)checked.sourcesRead=Math.min(MAX_COUNT,reads.size);
  if(searches.size)checked.searches=Math.min(MAX_COUNT,searches.size);

  // The final mechanical check results, not the model's declarations.
  for(const check of list(run.verification?.checks)) {
    observed=true;
    if(check.passed===true)bump(checked,'checksPassed');
    else {bump(attention,'checksFailed');item('check_failed',{checkId:safeId(check.id),check:toolName(check.kind)});}
  }
  for(const requirement of list(run.requiredDeliverables)) {
    observed=true;
    if(requirement.status==='completed')teammates.add(safeId(requirement.id) || `deliverable:${teammates.size}`);
    else {bump(attention,'deliverablesMissing');item('deliverable_missing',{deliverableId:safeId(requirement.id)});}
  }
  if(teammates.size)checked.teammatesVerified=Math.min(MAX_COUNT,teammates.size);

  if(!observed)return null;
  const needsLook=Object.keys(attention).length>0;
  return {status:needsLook?'attention':'checked',checked,attention,...(Object.keys(notes).length?{notes}:{}),...(needsLook && items.length?{items}:{})};
}
