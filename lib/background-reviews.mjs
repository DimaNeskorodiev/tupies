import { groupsFor } from './agent-tools.mjs';
import { imagesForModel, reasoningForModel } from './providers.mjs';
import { memoryWriteAllowed } from './memory-quality.mjs';
import { reviewFinalMemory } from './memory-review.mjs';
import { reviewFinalSkill } from './skill-review.mjs';
import { proposeSkill } from './learning.mjs';
import { recordLearningChange } from './learning-changes.mjs';
import { now } from './store.mjs';
import { isChatSession } from './sessions.mjs';

/**
 * Memory and skill reviews run here, after the reply is delivered and the run has finished.
 *
 * - One job per finished run reviews memory and then skills back to back on the auxiliary model, so one idle period
 *   costs one queued slot (not interleaved with the next task's model calls).
 * - Bounded concurrency and queue; a job waits briefly while its bot is busy with its next task.
 * - A review can only ever add an owner-reviewed suggestion (an atomic store mutation). It never writes memory or
 *   a skill itself, so Stop or shutdown cannot leave a half-applied write, and a failure never touches the run.
 */
const MAX_WAIT_FOR_IDLE=60_000;

/** The owner-level auxiliary model, else the bot's own provider and model captured for the run. */
export function auxiliaryTarget(store,job) {
  const setting=store.state.settings?.auxiliary,connection=setting?.connectionId && store.state.connections.find(item=>item.id===setting.connectionId);
  if(connection && connection.type && connection.type!=='legacy-hermes' && typeof setting.model==='string' && setting.model.trim()) {
    const model=setting.model.trim();
    // A different model gets its own capability resolution and the provider default effort.
    return {connection:structuredClone(connection),inference:{model,reasoning:reasoningForModel(connection,model),reasoningEffort:'',images:imagesForModel(connection,model).supported===true},auxiliary:true};
  }
  return {connection:structuredClone(job.connection),inference:structuredClone(job.inference),auxiliary:false};
}

/** Whether a finished run may need a review at all; cheap, so an ordinary reply queues nothing. */
export function reviewEligible(context,run) {
  if(!run || run.missionId || context.missionId)return false;
  const memory=groupsFor(context.bot).includes('memory') && memoryWriteAllowed(context);
  const skills=groupsFor(context.bot).includes('skills') && context.source==='chat' && isChatSession(context.sessionId,context.bot.id);
  return memory || skills;
}

export class BackgroundReviews {
  constructor(engine,{concurrency=1,maxQueued=20,idleWaitMs=MAX_WAIT_FOR_IDLE,idlePollMs=500}={}) {
    this.engine=engine;this.concurrency=Math.max(1,concurrency);this.maxQueued=maxQueued;this.idleWaitMs=idleWaitMs;this.idlePollMs=idlePollMs;
    this.queue=[];this.running=new Set();this.controller=new AbortController();this.closed=false;this.waiters=[];
  }
  /** Queue a finished run's review. Returns false when the queue is full or closed; the run is never affected. */
  enqueue(job) {
    if(this.closed || this.queue.length>=this.maxQueued)return false;
    this.queue.push(job);this.pump();return true;
  }
  get pending() {return this.queue.length+this.running.size;}
  /** Resolves when every queued and running review has settled. Used by tests and shutdown. */
  async idle() {
    while(this.pending)await new Promise(resolve=>{this.waiters.push(resolve);});
  }
  pump() {
    while(!this.closed && this.running.size<this.concurrency && this.queue.length) {
      const job=this.queue.shift(),task=this.run(job).catch(()=>{}).finally(()=>{this.running.delete(task);this.pump();this.settle();});
      this.running.add(task);
    }
    this.settle();
  }
  settle() {if(!this.pending){const waiters=this.waiters.splice(0);for(const resolve of waiters)resolve();}}
  async close() {
    this.closed=true;this.queue.length=0;this.controller.abort(Object.assign(new Error('Tupies is shutting down.'),{name:'AbortError'}));
    await Promise.allSettled([...this.running]);this.settle();
  }
  async waitForIdleBot(job) {
    const deadline=Date.now()+this.idleWaitMs;
    while(!this.closed && Date.now()<deadline) {
      const active=this.engine.store.state.runs[job.botId];
      if(!(active && active.id!==job.runId && ['queued','running','recovering','waiting_for_approval','waiting_for_input','waiting_for_delegate'].includes(active.status)) && !this.engine.starting?.has(job.botId))return;
      // Shutdown wakes the wait at once, so close() never waits on this unref'd poll timer.
      const signal=this.controller.signal;if(signal.aborted)return;
      await new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,this.idlePollMs);timer.unref?.();signal.addEventListener('abort',done,{once:true});});
    }
  }
  /** The engine as the reviews see it: no live run to guard, one shared abort, and proposals as the only write path. */
  view(job,context) {
    const engine=this.engine,signal=this.controller.signal;
    const view=Object.create(engine),live=()=>{const run=engine.store.state.runs[job.botId];return run?.id===job.runId?run:null;};
    view.current=()=>live() || job.run;
    view.assertRunning=()=>{if(engine.closing || signal.aborted || context.controller.signal.aborted)throw signal.reason || context.controller.signal.reason || Object.assign(new Error('Task cancelled.'),{name:'AbortError'});};
    view.assertNoPendingSteer=()=>{};
    view.hasPendingSteer=()=>false;
    view.update=async(_context,changes)=>{
      Object.assign(job.run,engine.store.redactValue(changes));
      await engine.store.mutate(state=>{
        const safe=engine.store.redactValue(changes),run=state.runs[job.botId];
        if(run?.id===job.runId)Object.assign(run,safe,{updatedAt:now()});
        // The finished run's history record keeps the review outcome and its extra usage too.
        const record=(state.runHistory?.[job.botId] || []).find(item=>item.id===job.runId);
        if(record) {
          for(const key of ['memoryReview','skillReview']) {
            if(safe[key]){record.diagnostics={...(record.diagnostics || {}),[key]:structuredClone(safe[key])};}
          }
          if(safe.usage)record.usage=Object.fromEntries(Object.entries(safe.usage).filter(([,value])=>Number.isFinite(value) && value>=0));
        }
      },{local:true});
    };
    view.infer=async(_context,connection,request,{providerMethod='complete',kind='review'}={})=>{
      const started=performance.now();let result,failed;
      try {result=await engine.providers[providerMethod](connection,request);return result;}
      catch(error){failed=error;throw error;}
      finally {
        try {engine.engineLog?.write({kind:'review.call',review:kind,runId:job.runId,botId:job.botId,provider:connection?.type,model:request.model,auxiliary:job.auxiliary===true,durationMs:Math.round(performance.now()-started),usage:result?.usage,...(failed?{error:String(failed.message || 'Review failed.').slice(0,300)}:{})});} catch { /* Diagnostics never change a review. */ }
      }
    };
    // A suggestion for the owner, never an unattended write. Automatic skill creation is not available after the run.
    view.routineTool=async(_context,name,args)=>{
      if(!['skills_create','skills_propose'].includes(name))throw new Error('Reviews can only suggest skills.');
      const input={name:args.name,description:args.description,instructions:args.instructions,reason:args.reason || 'A reusable method from a completed task.'};
      const result=await proposeSkill(engine.store,context,input);
      await recordLearningChange(view,context,{name:'skills_propose',arguments:input},result);
      if(!result.duplicate)await view.event(context,'learning.proposed',{message:'Suggested a skill for review',proposalId:result.proposalId});
      return result;
    };
    return view;
  }
  async run(job) {
    await this.waitForIdleBot(job);
    if(this.closed || !this.engine.store.state.bots.some(bot=>bot.id===job.botId))return;
    const target=auxiliaryTarget(this.engine.store,job);
    job.auxiliary=target.auxiliary;
    const controller=new AbortController(),forward=()=>controller.abort(this.controller.signal.reason);
    this.controller.signal.addEventListener('abort',forward,{once:true});
    const context={runId:job.runId,sessionId:job.sessionId,source:job.source,bot:structuredClone(job.bot),connection:target.connection,inference:target.inference,controller,task:job.task,
      ...(job.fromBotId?{fromBotId:job.fromBotId}:{}),...(job.parentRunId?{parentRunId:job.parentRunId}:{}),policy:{mode:'autonomous'},delegation:{rootRunId:job.runId,depth:0,lineage:[job.botId]}};
    const view=this.view(job,context);
    try {
      // Each review is independent: a failure in one never skips the other and never reaches the finished run.
      for(const review of [reviewFinalMemory,reviewFinalSkill]) {
        if(this.closed)break;
        try {await review(view,context,job.text);} catch { /* Reviews are best effort. */ }
      }
    } finally {
      this.controller.signal.removeEventListener('abort',forward);
    }
  }
}
