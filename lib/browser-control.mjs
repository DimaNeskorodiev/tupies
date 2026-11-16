import { ownerMissionContext } from './missions.mjs';
import { ensure, HttpError, id, now } from './store.mjs';
import { groupsFor } from './agent-tools.mjs';
import { OwnerControl, StreamSink, checkEvents, checkViewport } from './browser-stream.mjs';
import { ownerWebUrl } from './browser.mjs';

const MAX_HANDOFFS=20,MAX_IDLE_MS=30*60*1000,MAX_TOTAL_MS=2*60*60*1000,MAX_BODY=32_768,WATCH_MS=5000;
const IDENTITY=['runId','remoteRunId','request_id','execution_generation'];
const plain=value=>value && typeof value==='object' && !Array.isArray(value);
const END={resumed:'The owner returned control to the bot.',expired:'The browser handoff expired.',cancelled:'The task was stopped or changed.',closed:'Tupies is shutting down.'};
export const browserHandoffDefinition=()=>({name:'browser_handoff',description:'Pause a direct owner chat so the owner can operate this task’s browser for sign-in, passwords, 2FA or human verification. Never ask for credentials in chat. Inspect the page after.',parameters:{type:'object',properties:{reason:{type:'string',maxLength:1000,description:'Briefly explain what the owner needs to do. Do not include credentials.'}},required:['reason'],additionalProperties:false}});

function ended(condition,message) {if(!condition)throw Object.assign(new HttpError(409,message),{code:'handoff_ended'});}
function validate(input,extra=[]) {
  ensure(plain(input) && Object.keys(input).every(key=>[...IDENTITY,...extra].includes(key)),400,'Browser control contains unknown fields.');
  ensure(Buffer.byteLength(JSON.stringify(input))<=MAX_BODY,413,'Browser control exceeds the size limit.');
  ensure(IDENTITY.slice(0,3).every(key=>typeof input[key]==='string' && input[key].length<=100) && Number.isSafeInteger(input.execution_generation),400,'Use the exact current browser request identity.');
}

/**
 * Owner-only rendezvous. While a handoff waits, the owner watches a live screencast (`stream`) and sends raw input
 * (`input`) under a single stream lease. Browser pixels, typed inputs and field values exist only in memory and the
 * direct API response; none reach chat, tool arguments, activity, the store or logs.
 */
export class BrowserControl {
  constructor(engine){this.engine=engine;this.pending=new Map();}
  async ask(context,args,{signal=context.controller.signal}={}){
    const engine=this.engine;
    ensure(plain(args) && Object.keys(args).length===1 && typeof args.reason==='string' && args.reason.trim() && args.reason.length<=1000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args.reason),400,'Give a brief browser handoff reason.');
    engine.assertRunning(context);engine.assertNoPendingSteer(context);
    ensure(context.source==='chat' && (!context.lane || context.lane==='chat') || ownerMissionContext(engine,context),403,'Browser handoff is available only in a direct owner Tupies chat.');
    ensure(groupsFor(context.bot).includes('browser'),403,'Browser handoff needs Browser tools.');
    const session=engine.browsers.sessions.get(context.runId);
    ensure(session && (!session.botId || session.botId===context.bot.id),409,'Open this task’s browser before requesting a handoff.');
    ensure(!this.pending.has(context.runId),409,'This task already has a browser handoff.');
    ensure((context.browserHandoffs || 0)<MAX_HANDOFFS,400,'This task reached its browser handoff limit.');context.browserHandoffs=(context.browserHandoffs || 0)+1;
    const promptId=id('browser'),generation=(engine.current(context)?.execution_generation || 0)+1;
    let resolve,reject;const decision=new Promise((yes,no)=>{resolve=yes;reject=no;});void decision.catch(()=>{});
    const pending={context,session,promptId,generation,resolve,reject,claimed:false,control:null,lease:null};this.pending.set(context.runId,pending);
    signal=AbortSignal.any([context.controller.signal,signal]);pending.signal=signal;
    const onAbort=()=>reject(signal.reason || Object.assign(new Error('Task cancelled.'),{name:'AbortError'}));
    signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();
    let timer,cap,paused=false,ending='cancelled';
    try {
      const reason=engine.store.redact(args.reason).replace(/https?:\/\/[^\s]+/g,value=>{try{const url=new URL(value);return `${url.origin}${url.pathname}`;}catch{return '[web page]';}});
      // The idle limit is known before the handoff is published: a window opened at once must not get the default limit.
      const configured=engine.options.browserHandoffTimeoutMs,idleMs=Number.isFinite(configured)?Math.max(100,Math.min(configured,MAX_IDLE_MS)):MAX_IDLE_MS;pending.idleMs=idleMs;
      // Suspend only after validating the owner rendezvous and live browser session,
      // before async publication so slow Store writes cannot spend the owner's wait time.
      engine.pauseForInput(context);paused=true;
      await engine.update(context,{status:'waiting_for_input',execution_generation:generation,pending_controls:[{kind:'browser',prompt_id:promptId,reason}]});
      await engine.event(context,'browser.handoff_requested',{requestId:promptId,executionGeneration:generation});
      engine.assertRunning(context);signal.throwIfAborted();
      const total=engine.options.browserHandoffTotalMs,totalMs=Number.isFinite(total)?Math.max(100,Math.min(total,MAX_TOTAL_MS)):MAX_TOTAL_MS;
      const expire=()=>reject(new HttpError(408,'Browser handoff expired. No owner action or sign-in success is assumed.'));
      // An idle limit (a live stream opening and every owner input batch restart it) inside an absolute limit, so a forgotten open window cannot hold the bot paused forever.
      cap=setTimeout(expire,totalMs);cap.unref?.();
      pending.touch=()=>{clearTimeout(timer);timer=setTimeout(expire,idleMs);timer.unref?.();};pending.touch();
      const result=await decision;ending=result?.resumed?'resumed':'cancelled';engine.assertRunning(context);signal.throwIfAborted();return result;
    } catch(error) {
      ending=error?.status===408?'expired':engine.closing || this.closing?'closed':'cancelled';throw error;
    } finally {
      clearTimeout(timer);clearTimeout(cap);pending.touch=()=>{};signal.removeEventListener('abort',onAbort);
      if(this.pending.get(context.runId)===pending)this.pending.delete(context.runId);
      // The stream ends and the bot's own viewport is restored before the task continues. Bounded.
      pending.lease=null;if(pending.control)await pending.control.close(ending,END[ending]).catch(()=>{});
      if(paused)engine.resumeAfterInput(context);
      if(!context.controller.signal.aborted && !engine.closing && engine.current(context)?.status==='waiting_for_input')await engine.update(context,{status:'running',pending_controls:[]});
    }
  }
  current(botId,input){
    const engine=this.engine,run=engine.store.state.runs[botId];
    // `handoff_ended` lets the panel show its closed state instead of offering a retry.
    ended(run?.status==='waiting_for_input' && input.runId===run.id && input.remoteRunId===run.remoteRunId,'This browser request belongs to an older or inactive task.');
    const pending=this.pending.get(run.id);
    ended(pending && !pending.claimed && input.request_id===pending.promptId && input.execution_generation===pending.generation && run.execution_generation===pending.generation && run.pending_controls?.some(control=>control.kind==='browser' && control.prompt_id===pending.promptId),'This browser handoff changed or was already resumed.');
    engine.assertRunning(pending.context);ended(!pending.signal?.aborted,'This owner prompt expired or was cancelled. Review the current task.');
    ensure(engine.controllers.get(run.id)===pending.context.controller && engine.browsers.sessions.get(run.id)===pending.session,409,'This browser belongs to an older engine session.');
    ensure(!engine.options.busyElsewhere?.(botId) && !engine.options.admissionPaused?.(),409,'Engine ownership is changing. Refresh before controlling this browser.');
    engine.options.assertAdmission?.();
    return pending;
  }
  lease(pending,input){
    ensure(pending.lease && pending.control && !pending.control.closed && pending.lease.streamId===input.streamId,409,'This browser stream was replaced or closed. Reopen it.');
    return pending.lease;
  }
  /** Opens the owner's live view. Validation and authorization errors are ordinary JSON errors; after that the response is an SSE stream until it ends. */
  /** `authorized` re-checks the sign-in or paired device that opened the stream; a stream never outlives it. */
  async stream(botId,input,{res,idleUpdateWait,authorized=()=>true}={}){
    validate(input,['viewport']);const viewport=checkViewport(input.viewport);
    const pending=this.current(botId,input);ensure(res,500,'A browser stream needs a response.');
    // A dead browser cannot be helped: the window shows its final state instead of reconnecting (and extending the wait) forever.
    ended(!pending.session.pipe?.closed && !pending.session.exited,'The task’s browser closed. Review the current task.');
    const control=pending.control || (pending.control=new OwnerControl(pending.session,{idleMs:pending.idleMs || MAX_IDLE_MS}));
    const sink=new StreamSink(res,id('stream'));pending.lease={streamId:sink.streamId,seq:-1,sink};
    const stop=(reason,message)=>{if(pending.lease?.sink===sink)pending.lease=null;if(control.sink===sink)control.endSink(reason,message);sink.end(reason,message);};
    // Stop, restart, ownership changes, sign-out and a dead browser end the stream even when the owner sends nothing.
    const watch=setInterval(()=>{
      if(sink.ended || pending.claimed)return;
      if(!authorized())return stop('signedout','Sign in again to continue.');
      if(pending.session.pipe?.closed || pending.session.exited)return stop('closed','The task’s browser closed.');
      // A handoff that ended is final; a temporary engine condition (ownership change, update admission) lets the window reconnect.
      try{this.current(botId,input);}
      catch(error){if(error?.code==='handoff_ended')stop('cancelled','This browser handoff ended. Review the current task.');else stop('error','The engine is busy. Reconnecting…');}
    },this.engine.options.browserStreamWatchMs ?? WATCH_MS);watch.unref?.();
    try{
      // Only a stream that actually reached the browser counts as owner activity.
      void control.attach(sink,viewport,{onReady:()=>pending.touch?.()});
      if(idleUpdateWait)await idleUpdateWait(()=>sink.done);else await sink.done;
    }finally{clearInterval(watch);if(pending.lease?.sink===sink)pending.lease=null;}
  }
  /** One ordered batch of raw owner input for the current stream lease. Never replayed: a repeated or lower seq is refused. */
  async input(botId,input){
    validate(input,['streamId','seq','events']);
    ensure(typeof input.streamId==='string' && input.streamId.length<=100 && Number.isSafeInteger(input.seq) && input.seq>=0,400,'Use the current stream and a sequence number.');
    const pending=this.current(botId,input),allowPrivate=pending.session.allowPrivate===true;
    checkEvents(input.events,{url:value=>ownerWebUrl(value,allowPrivate)});
    const lease=this.lease(pending,input);ensure(input.seq>lease.seq,409,'This browser input was already received. It is not sent again.');
    lease.seq=input.seq;pending.touch?.();
    let result;
    try{result=await pending.control.input(input.events,{active:()=>!pending.claimed && this.pending.get(input.runId)===pending,webUrl:value=>ownerWebUrl(value,allowPrivate)});}
    catch(error){
      // Browser/DevTools errors may echo typed text or a credential-bearing URL. Never return or log their payload.
      const status=[400,413].includes(error?.status)?error.status:502;
      throw new HttpError(status,status===413?'Private browser input reached this task’s limit. Finish or stop the task.':status===400?'Browser input is invalid.':'Browser input could not be confirmed. Watch the stream before trying again.');
    }
    return {ok:true,seq:input.seq,dropped:result.dropped};
  }
  async resume(botId,input){
    validate(input,['keepSession','skip']);ensure(typeof input.keepSession==='boolean' && (input.skip===undefined || typeof input.skip==='boolean'),400,'Choose whether to keep this browser session and resume or skip.');
    // Never waits for streaming or input: a hung browser cannot block Resume or Skip.
    const pending=this.current(botId,input);
    try{await this.engine.browsers.setRetained(input.runId,botId,input.keepSession);}catch{throw new HttpError(409,'The browser session preference could not be saved. Refresh before resuming.');}
    this.current(botId,input);pending.claimed=true;
    try {
      await this.engine.store.mutate(state=>{
        this.engine.assertRunning(pending.context);ensure(!pending.signal?.aborted,409,'This owner prompt expired or was cancelled. Review the current task.');
        const run=state.runs[botId];ensure(run?.id===input.runId && run.status==='waiting_for_input' && run.execution_generation===pending.generation,409,'This browser handoff changed.');
        Object.assign(run,{status:'running',pending_controls:[],updatedAt:now()});
      });
      const skipped=input.skip===true;
      pending.lease=null;pending.control?.endSink('resumed',END.resumed);
      await this.engine.event(pending.context,'browser.handoff_resumed',{requestId:pending.promptId,skipped});
      pending.resolve({resumed:true,skipped,notice:skipped?'The owner skipped browser assistance. Missing access remains unavailable; do not infer sign-in or challenge success.':'The owner returned browser control. Read a fresh snapshot to verify the current state. Owner inputs were private; this does not approve any later bot action.'});
      return {resolved:1,runId:input.runId,requestId:pending.promptId,skipped};
    }catch(error){if(this.pending.get(input.runId)===pending)pending.claimed=false;throw error;}
  }
  /** Engine shutdown: end every open owner stream at once so long-lived responses never hold the listener open. */
  closeStreams(){this.closing=true;for(const pending of this.pending.values()){pending.lease=null;pending.control?.endSink('closed',END.closed);}}
  close(){this.closeStreams();for(const pending of this.pending.values())pending.reject(Object.assign(new Error('Tupies closed during browser handoff.'),{name:'AbortError'}));}
}
