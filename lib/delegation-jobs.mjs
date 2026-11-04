import { routineBotIdentity, routineConnectionIdentity } from './routine-checkpoints.mjs';
import { ensure, id, now } from './store.mjs';

const PENDING=new Set(['queued','running','suspended']);
const TERMINAL=new Set(['completed','failed','cancelled','interrupted','unknown']);
const MAX_JOBS=64;
const abortError=()=>Object.assign(new Error('Owning task stopped before this delegated work completed.'),{name:'AbortError'});
const copy=value=>structuredClone(value);
const notice='A queued acknowledgement proves admission only. Read delegation_status for actual child outcomes; a completed reply alone does not prove the bot or its integrations are healthy.';

/** Engine-local dispatch queue. Persisted records are evidence, never executable requests. */
export class DelegationJobs {
  constructor(engine) {this.engine=engine;this.entries=new Map();this.parents=new Map();this.waiting=new Map();this.pumping=false;this.timer=null;}
  records(context) {return this.engine.current(context)?.delegationJobs || [];}
  pending(context) {return this.records(context).filter(job=>PENDING.has(job.status));}
  unobserved(context) {return this.records(context).filter(job=>!PENDING.has(job.status) && !job.observed);}
  assertAvailable(context,botId) {
    ensure(this.records(context).length<MAX_JOBS,400,'This task reached its retained delegation-job limit.');
    ensure(!this.pending(context).some(job=>job.botId===botId),409,'This teammate already has queued or running work for this task. Inspect its delegationId instead of dispatching it twice.');
    ensure((this.engine.options.maxRuns || 4)>1,409,'Delegation needs capacity for the coordinator and at least one teammate.');
  }
  async enqueue(context,prepared) {
    this.assertAvailable(context,prepared.botId);
    const intent=this.engine.current(context)?.missionId?{intent:{...copy(prepared),botIdentity:routineBotIdentity(prepared.target),connectionIdentity:routineConnectionIdentity(this.engine.connection(prepared.target))}}:{};
    const job={...intent,id:id('delegation'),botId:prepared.botId,callId:prepared.callId,status:'queued',createdAt:now(),observed:false,...(prepared.requestDigest?{requestDigest:prepared.requestDigest}:{}),...(prepared.requirement?{deliverableId:prepared.requirement.id}:{})};
    await this.engine.store.mutate(state=>{this.engine.assertRunning(context);this.assertAvailable(context,prepared.botId);(state.runs[context.bot.id].delegationJobs ||= []).push(job);},{local:true});
    const controller=new AbortController();
    let resolve;const done=new Promise(settle=>{resolve=settle;});
    this.entries.set(job.id,{context,prepared,controller,done,resolve,started:false});
    let parent=this.parents.get(context.runId);
    if(!parent) {
      const jobIds=new Set(),onAbort=()=>{for(const jobId of jobIds)this.entries.get(jobId)?.controller.abort(context.controller.signal.reason || abortError());};
      parent={jobIds,onAbort};this.parents.set(context.runId,parent);context.controller.signal.addEventListener('abort',onAbort,{once:true});
    }
    parent.jobIds.add(job.id);if(context.controller.signal.aborted)controller.abort(context.controller.signal.reason || abortError());
    await this.engine.event(context,'delegation.queued',{delegationId:job.id,botId:job.botId,targetBotId:job.botId});
    this.schedule();
    return {delegationId:job.id,botId:job.botId,status:'queued',accepted:true,completed:false,...(job.deliverableId?{deliverable:{id:job.deliverableId,status:'pending'}}:{}),notice};
  }
  restore(context) {
    for(const job of this.pending(context)){
      if(this.entries.has(job.id) || !job.intent)continue;
      const prepared=copy(job.intent);if(job.childRunId)prepared.resumeChildRunId=job.childRunId;
      const controller=new AbortController();let resolve;const done=new Promise(settle=>{resolve=settle;});
      this.entries.set(job.id,{context,prepared,controller,done,resolve,started:false});
      let parent=this.parents.get(context.runId);if(!parent){const jobIds=new Set(),onAbort=()=>{for(const jobId of jobIds)this.entries.get(jobId)?.controller.abort(context.controller.signal.reason || abortError());};parent={jobIds,onAbort};this.parents.set(context.runId,parent);context.controller.signal.addEventListener('abort',onAbort,{once:true});}parent.jobIds.add(job.id);
    }
    this.schedule();
  }
  schedule(delay=0) {
    if(this.timer || this.engine.closing)return;
    this.timer=setTimeout(()=>{this.timer=null;void this.pump().catch(()=>{this.schedule(50);});},delay);
    this.timer.unref?.();
  }
  async write(context,jobId,changes) {
    await this.engine.store.mutate(state=>{const run=state.runs[context.bot.id];if(run?.id!==context.runId)return;const job=run.delegationJobs?.find(item=>item.id===jobId);if(job)Object.assign(job,this.engine.store.redactValue(changes));},{local:true});
  }
  activeCount() {return new Set([...this.engine.starting,...Object.entries(this.engine.store.state.runs).filter(([,run])=>run && !TERMINAL.has(run.status)).map(([botId])=>botId)]).size;}
  async breakWaitCycle() {
    const graph=new Map(),queued=[],runs=this.engine.store.state.runs;
    const edge=(from,to)=>{const next=graph.get(from) || [];next.push(to);graph.set(from,next);};
    for(const [jobId,entry] of this.entries) {
      const parent=this.engine.current(entry.context);
      if(parent?.status!=='waiting_for_delegate' || !this.waiting.get(parent.id)?.has(jobId))continue;
      if(entry.started && !entry.childRunId)continue;
      const target=runs[entry.prepared.botId];
      if(!target || TERMINAL.has(target.status) || entry.childRunId && target.id!==entry.childRunId)continue;
      edge(parent.id,target.id);
      if(!entry.started)queued.push({jobId,entry,from:parent.id,to:target.id});
    }
    // Synchronous handoffs also hold an actual dependency, without a job wait set.
    // Bind it to the real child's engine-owned lineage rather than a profile/name.
    for(const parent of Object.values(runs)) {
      if(parent.status!=='waiting_for_delegate' || this.waiting.has(parent.id))continue;
      const child=runs[parent.teammate?.botId],root=parent.delegation?.rootRunId || parent.id;
      if(child && !TERMINAL.has(child.status) && child.source==='delegation' && child.delegation?.rootRunId===root && child.delegation.lineage?.at(-2)===parent.botId)edge(parent.id,child.id);
    }
    const reaches=(from,target)=>{const seen=new Set(),pending=[from];while(pending.length){const current=pending.pop();if(current===target)return true;if(seen.has(current))continue;seen.add(current);for(const next of graph.get(current) || [])pending.push(next);}return false;};
    const cycle=queued.find(candidate=>reaches(candidate.to,candidate.from));
    if(!cycle)return false;
    await this.settle(cycle.jobId,cycle.entry,{status:'failed',outcome:'not_started',errorCode:'concurrency_blocked',reason:'dependency_cycle',error:'This queued delegation forms a dependency cycle: its target is waiting back on this task. The request was not dispatched. Collect the actual failure and complete existing work before asking that busy teammate again.'});
    return true;
  }
  async pump() {
    if(this.pumping || this.engine.closing)return;
    this.pumping=true;
    try {
      await this.breakWaitCycle();
      // Count admissions before they reach start(): event persistence yields too.
      let admitting=[...this.entries.values()].filter(entry=>entry.started && !entry.childAdmitted).length;
      for(const [jobId,entry] of this.entries) {
        if(entry.started)continue;
        const {context,prepared,controller}=entry,job=this.records(context).find(item=>item.id===jobId);
        if(!job || !PENDING.has(job.status)){this.release(jobId,entry);continue;}
        const owner=this.engine.store.state.missions?.[this.engine.current(context)?.missionId];
        if(owner?.pauseRequested)continue;
        if(owner?.effort && !prepared.resumeChildRunId){
          const occupied=new Set(Object.values(this.engine.store.state.runs).filter(run=>run.missionId===owner.id && run.botId!==owner.leadBotId && !TERMINAL.has(run.status)).map(run=>run.botId));
          for(const candidate of this.entries.values())if(candidate.started && !candidate.childAdmitted && this.engine.current(candidate.context)?.missionId===owner.id)occupied.add(candidate.prepared.botId);
          if(occupied.size>=owner.effort.limits.parallelTeammates){
            if(context.delegation.depth>0)await this.settle(jobId,entry,{status:'failed',outcome:'not_started',errorCode:'concurrency_blocked',error:'The Mission teammate allowance is occupied. Complete this work without a nested handoff.'});
            continue;
          }
        }
        if(controller.signal.aborted || !this.engine.current(context) || TERMINAL.has(this.engine.current(context).status) && !(owner && !owner.stopRequested && this.engine.current(context).missionSuspended)) {await this.settle(jobId,entry,{status:this.engine.closing?'interrupted':'cancelled',outcome:job.childRunId || prepared.resumeChildRunId?'unknown':'not_started',error:'The owning task stopped. This queued request was not dispatched.'});continue;}
        const target=this.engine.store.state.runs[prepared.botId];
        if(!prepared.resumeChildRunId && this.engine.starting.has(prepared.botId) || !prepared.resumeChildRunId && target && (!TERMINAL.has(target.status) || this.engine.tasks.has(target.id)))continue;
        if(!prepared.resumeChildRunId && this.activeCount()+admitting>=(this.engine.options.maxRuns || 4)) {
          const active=Object.values(this.engine.store.state.runs).filter(run=>!TERMINAL.has(run.status));
          // A full tree of waiting coordinators cannot create another slot itself.
          // Refuse one undispatched nested request explicitly instead of deadlocking.
          if(!admitting && !this.engine.starting.size && active.length && active.every(run=>run.status==='waiting_for_delegate')) {
            const queued=[...this.entries.entries()].filter(([,candidate])=>!candidate.started),blocked=queued.find(([,candidate])=>candidate.context.delegation.depth>0) || queued[0];
            if(blocked)await this.settle(blocked[0],blocked[1],{status:'failed',outcome:'not_started',errorCode:'concurrency_blocked',error:'All engine task slots are held by coordinators waiting for teammates. This request was not dispatched. Complete existing work before requesting another nested teammate.'});
          }
          break;
        }
        entry.started=true;if(!prepared.resumeChildRunId)admitting++;
        // run() owns all rejections and settles its done promise exactly once.
        entry.running=this.run(jobId,entry);void entry.running.catch(()=>{});
      }
    } finally {
      this.pumping=false;
      if([...this.entries.values()].some(entry=>!entry.started))this.schedule(50);
    }
  }
  async run(jobId,entry) {
    const {context,prepared,controller}=entry;
    try {
      await this.write(context,jobId,{status:'running',startedAt:now()});
      const result=await this.engine.runDelegation(context,prepared,{signal:controller.signal,delegationId:jobId,onAdmitted:async child=>{entry.childAdmitted=true;entry.childRunId=child.id;await this.write(context,jobId,{childRunId:child.id});this.schedule();}});
      // Keep output bounded independently of provider/tool-result retention.
      const retained=copy(result);
      if(retained.output?.length>16000){retained.output=retained.output.slice(0,16000);retained.outputTruncated=true;retained.outputNotice='The complete reply remains in the child conversation.';}
      await this.settle(jobId,entry,{status:result.status==='completed'?'completed':result.status==='cancelled'?'cancelled':result.status==='interrupted'?'interrupted':'failed',result:retained});
    } catch(error) {
      if(error.code==='mission_suspended'){await this.settle(jobId,entry,{status:'suspended',outcome:'checkpointed',error:null});return;}
      if(!controller.signal.aborted && !this.engine.closing && error?.status===429 && !entry.childRunId) {
        entry.started=false;entry.childAdmitted=false;await this.write(context,jobId,{status:'queued'});this.schedule(50);return;
      }
      const status=this.engine.closing?'interrupted':controller.signal.aborted?'cancelled':'failed';
      await this.settle(jobId,entry,{status,error:this.engine.store.redact(error.message || 'Delegated work could not complete.'),...(!entry.childRunId?{outcome:'not_started'}:{outcome:'unknown'})});
    }
  }
  release(jobId,entry) {
    const parent=this.parents.get(entry.context.runId);parent?.jobIds.delete(jobId);
    if(parent && !parent.jobIds.size){entry.context.controller.signal.removeEventListener('abort',parent.onAbort);this.parents.delete(entry.context.runId);}
    this.entries.delete(jobId);entry.resolve();
  }
  async settle(jobId,entry,changes) {
    try {await this.write(entry.context,jobId,{...changes,finishedAt:now()});}
    finally {this.release(jobId,entry);this.schedule();}
  }
  async wait(context,ids,timeoutMs) {
    const selected=new Set(ids),entries=[...this.entries.entries()].filter(([jobId,entry])=>entry.context.runId===context.runId && selected.has(jobId));
    if(!entries.length)return;
    this.engine.pauseForInput(context);
    this.waiting.set(context.runId,selected);
    let timer,onAbort;
    try {
      await this.engine.update(context,{status:'waiting_for_delegate'});
      this.schedule();
      await Promise.race([Promise.allSettled(entries.map(([,entry])=>entry.done)),new Promise((resolve,reject)=>{timer=setTimeout(resolve,timeoutMs);onAbort=()=>reject(context.controller.signal.reason || abortError());context.controller.signal.addEventListener('abort',onAbort,{once:true});if(context.controller.signal.aborted)onAbort();})]);
      this.engine.assertRunning(context);
    } finally {
      clearTimeout(timer);context.controller.signal.removeEventListener('abort',onAbort);
      try {if(!context.controller.signal.aborted && this.engine.current(context)){this.engine.resumeAfterInput(context);await this.engine.update(context,{status:'running',teammate:null});}}
      finally {this.waiting.delete(context.runId);}
    }
  }
  async status(context,args={}) {
    const {delegationIds,wait=false,timeoutMs=30000,offset=0,limit=20}=args;
    ensure(typeof wait==='boolean',400,'wait must be true or false.');
    ensure(Number.isInteger(timeoutMs) && timeoutMs>=1 && timeoutMs<=30000,400,'Delegation waits must be between 1 and 30000 milliseconds.');
    ensure(Number.isInteger(offset) && offset>=0 && offset<=MAX_JOBS && Number.isInteger(limit) && limit>=1 && limit<=20,400,'Choose a delegation status page of at most 20 jobs.');
    ensure(delegationIds===undefined || Array.isArray(delegationIds) && delegationIds.length>=1 && delegationIds.length<=MAX_JOBS && delegationIds.every(value=>typeof value==='string' && value.length<=100) && new Set(delegationIds).size===delegationIds.length,400,'Choose distinct engine-owned delegationIds from this task.');
    const all=this.records(context),ids=delegationIds || all.map(job=>job.id);
    ensure(ids.every(jobId=>all.some(job=>job.id===jobId)),404,'A delegationId does not belong to this current task.');
    if(wait)await this.wait(context,ids,timeoutMs);
    const selected=this.records(context).filter(job=>ids.includes(job.id)),page=selected.slice(offset,offset+limit);
    const pageIds=new Set(page.map(job=>job.id));
    await this.engine.store.mutate(state=>{this.engine.assertRunning(context);for(const job of state.runs[context.bot.id].delegationJobs || [])if(pageIds.has(job.id) && !PENDING.has(job.status))job.observed=true;},{local:true});
    const current=this.records(context).filter(job=>ids.includes(job.id));
    return {jobs:copy(current.slice(offset,offset+limit)),total:current.length,pending:current.filter(job=>PENDING.has(job.status)).length,completed:current.filter(job=>job.status==='completed').length,...(offset+page.length<current.length?{nextOffset:offset+page.length}:{}),notice};
  }
  async closeRun(context,{interrupted=false}={}) {
    const entries=[...this.entries.entries()].filter(([,entry])=>entry.context.runId===context.runId);
    if(interrupted && entries.length)await this.engine.store.mutate(state=>{const run=state.runs[context.bot.id],checkpoint=run?.routineId?state.routineRuntime?.[run.routineId]?.checkpoint:state.taskCheckpoints?.[context.bot.id];if(checkpoint?.runId===context.runId){checkpoint.automatic=false;checkpoint.blocked='Delegated work was interrupted. Inspect actual child outcomes before starting new work.';}},{local:true});
    for(const [jobId,entry] of entries) {
      entry.controller.abort(abortError());
      if(!entry.started)await this.settle(jobId,entry,{status:interrupted?'interrupted':'cancelled',outcome:'not_started',error:'The owning task ended before this queued work was dispatched.'});
    }
    await Promise.allSettled(entries.map(([,entry])=>entry.done));
  }
  recover(state) {
    for(const run of Object.values(state.runs || {})) {
      const pending=(run.delegationJobs || []).filter(job=>PENDING.has(job.status));
      if(!pending.length)continue;
      if(run.missionId && pending.every(job=>job.intent && job.intent.botId===job.botId)){for(const job of pending){job.status='suspended';job.outcome='checkpointed';}continue;}
      for(const job of pending)Object.assign(job,{status:run.stopRequested?'cancelled':'interrupted',finishedAt:now(),error:'The engine restarted. This queued or active delegation was not replayed.',outcome:job.childRunId?'unknown':'not_started'});
      const checkpoint=run.routineId?state.routineRuntime?.[run.routineId]?.checkpoint:state.taskCheckpoints?.[run.botId];
      if(checkpoint?.runId===run.id){checkpoint.blocked='Delegated work was interrupted. Inspect actual child results before starting new work; queued requests were not replayed.';checkpoint.automatic=false;}
    }
  }
  close() {clearTimeout(this.timer);this.timer=null;}
}
