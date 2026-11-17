import { randomBytes } from 'node:crypto';
import { HttpError, ensure, now } from './store.mjs';
import { sealJson, openJson } from './sync/crypto.mjs';
import { markProviderFailure, providerFailure } from './provider-failure.mjs';
import { isLocalConnection, LOCAL_DEFAULTS } from './local-models.mjs';

/**
 * Local models on the Mac, used from the home server (docs/plans/local-models-20261117.md, L2).
 *
 * A connection created on an engine with a local preset stores `host: <nodeId>`. Only that engine dials the runtime.
 * This module decorates the Providers instance in place (complete, models, test, reviews):
 *
 * - Host engine: local connections run through one bounded queue per runtime (interactive before background), shared
 *   by the engine's own tasks and jobs relayed from the home server.
 * - Home server (hub), connection hosted by a linked engine: `complete()` and `test()` become in-memory jobs. The host
 *   long-polls `POST /api/sync/inference/claim`, runs each job against its own loopback runtime and posts sealed event
 *   batches to `POST /api/sync/inference/events` (deltas at most every 250 ms, a heartbeat at least every 3 s, then the
 *   final result). Each reply says continue, cancel or unknown; the host aborts on cancel or unknown.
 * - Any other engine: the model list comes from the synced record; tests and generation fail with `node_offline`.
 *
 * Payloads are sealed with the workspace key like other sync payloads. The host only generates text: tools, approvals
 * and the agent loop stay with the engine that runs the task. Nothing is ever replayed: a broken relay fails the call.
 *
 * Wire shapes (protocol 1):
 *   claim        {node, v, wait, capacity}                     → {node, v, jobs:[{id, v, kind, priority, connectionId, request}], incompatible?}
 *   events       {node, v, job, seq, events:[…]}               → {node, v, job, seq, action:'continue'|'cancel'|'unknown', duplicate?}
 *   event types  {type:'state', state:'queued'|'loading'|'reading'|'generating', tokens?} · {type:'delta', text} ·
 *                {type:'reasoning', text} · {type:'result', result} · {type:'error', code, status, upstreamStatus, message, retryAfterMs}
 */
export const RELAY_PROTOCOL=1;
export const CLAIM_ROUTE='/api/sync/inference/claim',EVENTS_ROUTE='/api/sync/inference/events';
const STATES=new Set(['queued','loading','reading','generating']);
const FINISH=new Set(['stop','length','tool_calls']);
const DEFAULTS=Object.freeze({
  claimWaitMs:25_000,        // same long-poll as the sync exchange
  heartbeatTimeoutMs:20_000, // hub: no batch from the host for this long → node_lost
  onlineWindowMs:45_000,     // hub: a host that claimed this recently is online
  flushMs:250,               // host: deltas at most this often
  beatMs:3_000,              // host: a heartbeat at least this often
  maxQueuedPerHost:16,
  maxClaim:4,
  maxRunning:8,              // relayed jobs a host accepts at once; its runtime queue runs LOCAL_DEFAULTS.concurrency
  maxJobBytes:24*1024*1024,
  totalTimeoutMs:LOCAL_DEFAULTS.totalTimeoutMs,
  testTimeoutMs:90_000,
  postRetryMs:30_000,        // host: give up delivering one batch after this long and stop the job
  tombstoneMs:120_000,
  idleCheckMs:2_000,
});
const abortError=()=>new DOMException('Task cancelled.','AbortError');
const plain=value=>!!value && typeof value==='object' && !Array.isArray(value);
const clamp=(value,min,max)=>Math.min(Math.max(Number.isFinite(Number(value))?Number(value):min,min),max);

/** A failure with one of the relay codes, which the engine sends straight to the bot's fallback model (or fails clearly). */
export function nodeFailure(code,message,status=503) {return markProviderFailure(new HttpError(status,message),code,{status});}

/** One runtime's queue on the host: at most `limit` requests at once, interactive work first. */
class LocalQueue {
  constructor(limit){this.limit=limit;this.active=0;this.waiting=[];}
  get size(){return this.active+this.waiting.length;}
  async run(priority,signal,task,onState) {
    if(this.active>=this.limit || this.waiting.length) {
      onState?.('queued');
      await new Promise((resolve,reject)=>{
        const entry={background:priority==='background',resolve:()=>{signal?.removeEventListener('abort',abort);resolve();}};
        const abort=()=>{const index=this.waiting.indexOf(entry);if(index>=0)this.waiting.splice(index,1);reject(signal.reason || abortError());};
        const index=entry.background?-1:this.waiting.findIndex(item=>item.background);
        if(index<0)this.waiting.push(entry);else this.waiting.splice(index,0,entry);
        if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
      });
    } else this.active++;
    try {onState?.('reading');return await task();}
    finally {this.active--;while(this.active<this.limit && this.waiting.length){this.active++;this.waiting.shift().resolve();}}
  }
}

export class InferenceRelay {
  constructor({store,sync,options={},onHostTest}={}) {
    this.store=store;this.sync=sync;this.options={...DEFAULTS,...options};this.protocol=this.options.protocol ?? RELAY_PROTOCOL;this.onHostTest=onHostTest;
    // Hub
    this.jobs=new Map();this.tombstones=new Map();this.waiting=new Map();this.waiters=new Map();this.seen=new Map();this.incompatible=new Map();this.watchdog=null;
    // Host
    this.queues=new Map();this.running=new Map();this.base={};this.closed=false;this.controller=new AbortController();this.worker=null;this.workerWake=null;
    this.workerStatus={claiming:false,incompatible:false,error:null,lastClaimAt:null};
  }

  // ---- Which engine dials a connection ----
  current(connection){return this.store.state.connections?.find(item=>item.id===connection?.id) || connection || {};}
  /** True when another engine hosts this connection's runtime; this engine must never dial its baseUrl. */
  hostedElsewhere(connection){const host=this.current(connection).host;return typeof host==='string' && !!host && host!==this.sync.nodeId;}
  hostedHere(connection){return this.current(connection).host===this.sync.nodeId;}
  hostName(nodeId){return String(this.sync.nodeName?.(nodeId) || 'another engine').slice(0,80);}
  /** Hub knowledge: the host is long-polling for jobs now, or did so very recently. */
  hostOnline(nodeId) {
    if(nodeId===this.sync.nodeId)return true;
    if(this.sync.role()==='hub')return (this.waiting.get(nodeId) || 0)>0 || Date.now()-(this.seen.get(nodeId) || 0)<this.options.onlineWindowMs;
    if(nodeId===this.sync.config?.hub?.nodeId)return !!this.sync.peerStatus?.connected;
    return !!this.sync.engines?.().find(engine=>engine.nodeId===nodeId)?.online;
  }
  /** Public, per-engine view of a connection's host for the API: `{local, host:{nodeId,name,online,here,queue?}|null}`. */
  describe(connection) {
    const local=isLocalConnection(connection),nodeId=typeof connection?.host==='string' && connection.host?connection.host:null;
    if(!nodeId)return {local,host:null};
    const here=nodeId===this.sync.nodeId,hub=this.sync.role()==='hub';
    const queue=hub && !here?[...this.jobs.values()].filter(job=>job.host===nodeId).length:here?this.queueFor(connection).size:undefined;
    return {local,host:{nodeId,name:this.hostName(nodeId),online:this.hostOnline(nodeId),here,...(queue!==undefined?{queue}:{}),...(hub && this.incompatible.has(nodeId)?{incompatible:true}:{})}};
  }
  busy(){return this.running.size>0 || this.jobs.size>0;}
  status() {
    const role=this.sync.role();
    if(role==='hub'){
      const hosts=new Set([...this.store.state.connections || []].map(item=>item.host).filter(host=>typeof host==='string' && host && host!==this.sync.nodeId));
      return {protocol:this.protocol,role,hosts:[...hosts].map(nodeId=>{const jobs=[...this.jobs.values()].filter(job=>job.host===nodeId);return {nodeId,name:this.hostName(nodeId),online:this.hostOnline(nodeId),queued:jobs.filter(job=>!job.claimedBy).length,running:jobs.filter(job=>job.claimedBy).length,...(this.incompatible.has(nodeId)?{incompatible:true}:{})};})};
    }
    return {protocol:this.protocol,role,running:this.running.size,...this.workerStatus};
  }

  /** Decorates a Providers instance (or a test double) in place, so every holder of the instance sees the relay. */
  install(providers) {
    for(const name of ['complete','models','test','reviewMemory','reviewSkill','reviewAction'])if(typeof providers[name]==='function')this.base[name]=providers[name].bind(providers);
    if(this.base.complete)providers.complete=(connection,request)=>this.complete(connection,request);
    providers.models=(connection)=>this.models(connection);
    providers.test=(connection)=>this.test(connection);
    // Memory and skill reviews wait behind the owner's work on a busy runtime; action review blocks a task and does not.
    for(const name of ['reviewMemory','reviewSkill'])if(this.base[name])providers[name]=(connection,request={})=>this.base[name](connection,{...request,priority:'background'});
    Object.defineProperty(providers,'relay',{value:this,configurable:true});
    providers.hostedElsewhere=connection=>this.hostedElsewhere(connection);
    return this;
  }
  queueFor(connection) {
    const key=String(this.current(connection).baseUrl || connection?.baseUrl || connection?.type || '');
    if(!this.queues.has(key))this.queues.set(key,new LocalQueue(this.options.concurrency || LOCAL_DEFAULTS.concurrency));
    return this.queues.get(key);
  }
  async complete(connection,request={}) {
    const {priority,onRelayState,...rest}=request || {};
    if(this.hostedElsewhere(connection))return this.relay('complete',this.current(connection),{...rest,priority:priority==='background'?'background':'interactive',onRelayState});
    if(isLocalConnection(this.current(connection)))return this.queueFor(connection).run(priority,rest.signal,()=>this.base.complete(connection,rest),onRelayState);
    return this.base.complete(connection,rest);
  }
  /** A non-host never dials: it lists the models the host last recorded in the shared record. */
  async models(connection) {
    if(this.hostedElsewhere(connection))return {models:(this.current(connection).models || []).filter(item=>plain(item) && typeof item.id==='string' && item.id),source:'synced'};
    ensure(this.base.models,503,'Model listing is unavailable on this engine.');
    return this.base.models(connection);
  }
  async test(connection) {
    if(this.hostedElsewhere(connection)){const result=await this.relay('test',this.current(connection),{timeoutMs:this.options.testTimeoutMs});return {...result,connected:true,relayed:true};}
    ensure(this.base.test || this.base.models,503,'Connection tests are unavailable on this engine.');
    return this.base.test?this.base.test(connection):{connected:true,...await this.base.models(connection)};
  }

  // ---- Hub: jobs for a connection hosted by a linked engine ----
  async relay(kind,connection,request) {
    const {signal}=request;
    if(signal?.aborted)throw signal.reason || abortError();
    if(this.closed)throw nodeFailure('node_lost','This engine is shutting down. The model request was not sent.');
    const host=connection.host,name=this.hostName(host),role=this.sync.role();
    if(role==='replica')throw nodeFailure('node_offline',`This model runs on “${name}”. Only your home server can use it from another engine, so it could not answer here. Nothing was replayed. Use it from the home server or set a fallback model.`);
    if(role!=='hub')throw nodeFailure('node_offline',`This model runs on “${name}”, which is not linked to this engine. Link it to this home server, or choose “This Mac hosts this connection” on the Mac that runs the model.`);
    if(this.incompatible.has(host))throw nodeFailure('node_incompatible',`“${name}” runs a different Tupies Engine version, so it cannot run models for this home server. Update both engines. Nothing was replayed.`,426);
    if(!this.hostOnline(host)) {
      // Linked and syncing, yet it has never asked for jobs: most likely an engine from before the relay.
      const synced=this.sync.online?.get(host),connected=!this.seen.has(host) && synced && Date.now()-Date.parse(synced)<60_000;
      throw nodeFailure('node_offline',connected?`“${name}” is connected but is not accepting model requests. If it runs an older Tupies Engine, update it. Nothing was replayed.`:`The Mac that runs this model (“${name}”) is offline, so it could not answer. Nothing was replayed. Wake the Mac, or set a fallback model in the bot settings.`);
    }
    const queued=[...this.jobs.values()].filter(job=>job.host===host).length;
    ensure(queued<this.options.maxQueuedPerHost,429,`“${name}” already has ${queued} model requests waiting. Try again when some finish.`);
    const wire=kind==='complete'?Object.fromEntries(['model','messages','turnContext','tools','reasoningEffort','reasoningCapabilities','cacheKey','maxOutputTokens','timeoutMs'].filter(key=>request[key]!==undefined).map(key=>[key,request[key]])):{};
    const bytes=Buffer.byteLength(JSON.stringify(wire));
    ensure(bytes<=this.options.maxJobBytes,413,`This request is too large to send to “${name}”. Remove large attachments or start a new chat.`);
    const limit=Math.min(Number.isFinite(request.timeoutMs)?request.timeoutMs:Infinity,kind==='test'?this.options.testTimeoutMs:this.options.totalTimeoutMs)+(this.options.timeoutGraceMs ?? 30_000);
    return new Promise((resolve,reject)=>{
      const job={id:`ij_${randomBytes(12).toString('hex')}`,kind,host,name,connectionId:connection.id,priority:request.priority==='background'?'background':'interactive',request:wire,bytes,createdAt:Date.now(),lastBeat:Date.now(),deadline:Date.now()+limit,seq:0,state:'queued',claimedBy:null,done:false,cancelled:false,
        toolNames:new Set((Array.isArray(request.tools)?request.tools:[]).map(tool=>tool?.name)),emissions:Promise.resolve(),onDelta:request.onDelta,onReasoning:request.onReasoning,onState:request.onRelayState,resolve,reject,signal};
      job.abort=()=>this.cancel(job,signal.reason || abortError());
      signal?.addEventListener('abort',job.abort,{once:true});
      this.jobs.set(job.id,job);this.notifyHost(host);this.startWatchdog();
    });
  }
  /** Ends a job once: the caller gets the result or error and later batches from the host get cancel/unknown. */
  settle(job,{result,error,action='unknown'}) {
    if(job.done)return;job.done=true;
    job.signal?.removeEventListener('abort',job.abort);
    this.jobs.delete(job.id);this.tombstones.set(job.id,{action,until:Date.now()+this.options.tombstoneMs,seq:job.seq});
    if(error){void job.emissions.catch(()=>{});job.reject(error);}
    else job.emissions.then(()=>job.resolve(result),job.reject);
    if(!this.jobs.size)this.stopWatchdog();
  }
  cancel(job,reason){job.cancelled=true;this.settle(job,{error:reason,action:'cancel'});}
  fail(job,error){this.settle(job,{error,action:job.claimedBy?'cancel':'unknown'});}
  failHost(host,code,message){for(const job of [...this.jobs.values()])if(job.host===host)this.fail(job,nodeFailure(code,message,code==='node_incompatible'?426:503));}
  startWatchdog() {
    if(this.watchdog)return;
    this.watchdog=setInterval(()=>this.checkJobs(),Math.max(10,Math.min(1000,Math.floor(this.options.heartbeatTimeoutMs/4))));this.watchdog.unref?.();
  }
  stopWatchdog(){clearInterval(this.watchdog);this.watchdog=null;}
  checkJobs() {
    const time=Date.now();
    for(const [id,tomb] of this.tombstones)if(tomb.until<time)this.tombstones.delete(id);
    for(const job of [...this.jobs.values()]) {
      if(time>job.deadline){this.fail(job,markProviderFailure(new HttpError(504,`“${job.name}” did not finish this model request in time. Nothing was replayed.`),'timeout',{status:504,timeoutPhase:'total'}));continue;}
      if(time-job.lastBeat>this.options.heartbeatTimeoutMs)this.fail(job,nodeFailure('node_lost',job.claimedBy?`“${job.name}” stopped responding while it was answering (no heartbeat for ${Math.round(this.options.heartbeatTimeoutMs/1000)} s). The answer was not replayed. It may have gone to sleep or lost its connection; the bot’s fallback model answers if one is set.`:`“${job.name}” did not pick up this model request. It may have gone to sleep or lost its connection. Nothing was replayed.`));
    }
  }
  notifyHost(host){for(const resolve of this.waiters.get(host) || [])resolve();this.waiters.delete(host);}
  waitForJob(host,ms,signal) {
    return new Promise(resolve=>{
      const set=this.waiters.get(host) || new Set();this.waiters.set(host,set);
      const done=()=>{clearTimeout(timer);set.delete(done);signal?.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,ms);set.add(done);signal?.addEventListener('abort',done,{once:true});
      if(this.closed)done();
    });
  }
  pendingFor(host){return [...this.jobs.values()].filter(job=>job.host===host && !job.claimedBy);}
  take(host,capacity) {
    const ready=this.pendingFor(host).sort((a,b)=>(a.priority==='background')-(b.priority==='background') || a.createdAt-b.createdAt),taken=[];let bytes=0;
    for(const job of ready){if(taken.length>=capacity || taken.length && bytes+job.bytes>2*this.options.maxJobBytes)break;bytes+=job.bytes;job.claimedBy=host;job.lastBeat=Date.now();job.state='claimed';taken.push({id:job.id,v:this.protocol,kind:job.kind,priority:job.priority,connectionId:job.connectionId,request:job.request});}
    return taken;
  }
  /** Engine route. The wait gives up update admission like the sync exchange and stays outside `securityOperation`. */
  async claim(session,sealed,signal,epoch,idleWait=operation=>operation()) {
    const {device,request}=await this.sync.securityOperation(()=>{const device=this.sync.hubEngine(session);this.sync.assertEpoch(epoch);const request=openJson(this.sync.workspaceKey,sealed,'inference-claim');ensure(request?.node===device.nodeId,403,'This claim came from a different engine.');return {device,request};});
    const node=device.nodeId,seal=value=>this.sync.securityOperation(()=>{this.sync.hubEngine(session);this.sync.assertEpoch(epoch);return sealJson(this.sync.workspaceKey,{node:this.sync.nodeId,v:this.protocol,...value(),},'inference-claim-reply');});
    this.seen.set(node,Date.now());
    if(request.v!==this.protocol){
      this.incompatible.set(node,Number.isSafeInteger(request.v)?request.v:null);
      this.failHost(node,'node_incompatible',`“${this.hostName(node)}” runs a different Tupies Engine version, so it cannot run models for this home server. Update both engines. Nothing was replayed.`);
      return seal(()=>({jobs:[],incompatible:true}));
    }
    this.incompatible.delete(node);
    const capacity=clamp(request.capacity,0,this.options.maxClaim),wait=clamp(request.wait,0,this.options.claimWaitMs);
    if(capacity && wait && !this.pendingFor(node).length && !signal?.aborted) {
      this.waiting.set(node,(this.waiting.get(node) || 0)+1);
      try {await idleWait(()=>this.waitForJob(node,wait,signal));}
      finally {this.waiting.set(node,this.waiting.get(node)-1);if(!this.waiting.get(node))this.waiting.delete(node);this.seen.set(node,Date.now());}
    }
    // Jobs are taken only once the reply can be sealed and the claimant is still listening.
    return seal(()=>({jobs:signal?.aborted?[]:this.take(node,capacity)}));
  }
  /** Engine route: one sealed batch of events for one job, from the engine that claimed it. */
  events(session,sealed,epoch) {
    return this.sync.securityOperation(()=>{
      const device=this.sync.hubEngine(session);this.sync.assertEpoch(epoch);
      const batch=openJson(this.sync.workspaceKey,sealed,'inference-events');
      ensure(batch?.node===device.nodeId,403,'These events came from a different engine.');
      ensure(typeof batch.job==='string' && /^ij_[0-9a-f]{24}$/.test(batch.job) && Number.isSafeInteger(batch.seq) && batch.seq>=1 && Array.isArray(batch.events) && batch.events.length<=2000,400,'Invalid inference events.');
      this.seen.set(device.nodeId,Date.now());
      const reply=this.apply(device.nodeId,batch);
      return sealJson(this.sync.workspaceKey,{node:this.sync.nodeId,v:this.protocol,job:batch.job,...reply},'inference-events-reply');
    });
  }
  apply(node,{job:id,seq,events,v}) {
    const job=this.jobs.get(id);
    if(!job){const tomb=this.tombstones.get(id);return {action:tomb?.action==='cancel'?'cancel':tomb && seq<=tomb.seq?'continue':'unknown',seq:tomb?.seq ?? 0};}
    if(job.host!==node || job.claimedBy!==node)return {action:'unknown',seq:0};
    if(seq<=job.seq)return {action:'continue',seq:job.seq,duplicate:true};
    if(v!==this.protocol){this.fail(job,nodeFailure('node_incompatible',`“${job.name}” runs a different Tupies Engine version. Update both engines. Nothing was replayed.`,426));return {action:'cancel',seq};}
    if(seq!==job.seq+1){this.fail(job,markProviderFailure(new HttpError(502,`The answer from “${job.name}” arrived incomplete. It was not replayed.`),'stream_interrupted',{status:502}));return {action:'cancel',seq};}
    job.seq=seq;job.lastBeat=Date.now();
    for(const event of events){
      if(job.done || !plain(event))break;
      if(event.type==='state' && STATES.has(event.state)){job.state=event.state;job.tokens=Number.isSafeInteger(event.tokens) && event.tokens>=0?event.tokens:undefined;if(job.onState)this.deliver(job,job.onState,{state:event.state,...(job.tokens!==undefined?{tokens:job.tokens}:{})});}
      else if(event.type==='delta' && typeof event.text==='string' && event.text){job.state='generating';if(job.onDelta)this.deliver(job,job.onDelta,this.store.redact(event.text));}
      else if(event.type==='reasoning' && typeof event.text==='string' && event.text){if(job.onReasoning)this.deliver(job,job.onReasoning,this.store.redact(event.text));}
      else if(event.type==='result'){let result;try{result=this.result(job,event.result);}catch(error){this.fail(job,error);break;}this.settle(job,{result,action:'continue'});}
      else if(event.type==='error')this.settle(job,{error:this.rebuild(job,event),action:'continue'});
    }
    return {action:job.cancelled?'cancel':job.done?(this.tombstones.get(id)?.action || 'continue'):'continue',seq};
  }
  deliver(job,consumer,value) {
    job.emissions=job.emissions.then(()=>consumer(value)).catch(error=>{if(!job.done)this.fail(job,error);throw error;});
    void job.emissions.catch(()=>{});
  }
  result(job,value) {
    const invalid=message=>markProviderFailure(new HttpError(502,`“${job.name}” returned ${message}. Nothing was replayed.`),'protocol_error',{status:502});
    if(!plain(value))throw invalid('an invalid result');
    if(job.kind==='test'){const models=Array.isArray(value.models)?value.models.filter(plain).slice(0,10_000):[];return this.store.redactValue({models,source:typeof value.source==='string'?value.source.slice(0,40):'provider',...(plain(value.account)?{account:value.account}:{})});}
    const toolCalls=Array.isArray(value.toolCalls)?value.toolCalls:[];
    if(toolCalls.length>256 || !toolCalls.every(call=>plain(call) && typeof call.id==='string' && call.id.length<=500 && typeof call.name==='string' && job.toolNames.has(call.name) && plain(call.arguments)))throw markProviderFailure(new HttpError(502,`“${job.name}” returned a tool call outside the offered tools. Nothing was replayed.`),'tool_call_invalid',{status:502});
    const reasoning=plain(value.reasoning) && Number.isSafeInteger(value.reasoning.chars)?{chars:value.reasoning.chars,...(typeof value.reasoning.text==='string'?{text:this.store.redact(value.reasoning.text)}:{})}:null;
    return {text:typeof value.text==='string'?this.store.redact(value.text):'',toolCalls:toolCalls.map(call=>({id:call.id,name:call.name,arguments:call.arguments})),usage:plain(value.usage)?value.usage:{},finishReason:FINISH.has(value.finishReason)?value.finishReason:toolCalls.length?'tool_calls':'stop',
      ...(Array.isArray(value.providerItems)?{providerItems:value.providerItems}:{}),...(plain(value.outputLimit)?{outputLimit:value.outputLimit}:{}),...(reasoning?{reasoning}:{}),relayedBy:{nodeId:job.host,name:job.name}};
  }
  rebuild(job,event) {
    const status=Number.isInteger(event.status) && event.status>=400 && event.status<=599?event.status:502;
    const message=typeof event.message==='string' && event.message.trim()?this.store.redact(event.message.slice(0,2000)):`“${job.name}” could not complete the model request.`;
    const error=new HttpError(status,message);
    if(typeof event.code==='string')markProviderFailure(error,event.code,{status,upstreamStatus:event.upstreamStatus,timeoutPhase:event.timeoutPhase});
    if(Number.isFinite(event.retryAfterMs) && event.retryAfterMs>0)error.retryAfterMs=Math.min(event.retryAfterMs,86_400_000);
    return error;
  }

  // ---- Host (a replica that runs the model): claim jobs, run them, stream events back ----
  start(){if(!this.worker && !this.closed)this.worker=this.workLoop();return this;}
  hostsAny(){return (this.store.state.connections || []).some(item=>item.host===this.sync.nodeId);}
  eligible(peer){return !!peer && !peer.stopped && this.sync.role()==='replica' && !this.sync.options.updateHeld?.() && !this.sync.topologyChanging && this.hostsAny();}
  idle(ms){return new Promise(resolve=>{const signal=this.controller.signal,timer=setTimeout(done,ms);timer.unref?.();this.workerWake=done;signal.addEventListener('abort',done,{once:true});function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}});}
  wake(){this.workerWake?.();}
  async workLoop() {
    let backoff=1000;
    while(!this.closed) {
      const peer=this.sync.peer;
      if(!this.eligible(peer)){this.workerStatus={...this.workerStatus,claiming:false};await this.idle(this.options.idleCheckMs);continue;}
      const capacity=Math.min(this.options.maxClaim,this.options.maxRunning-this.running.size);
      if(capacity<=0){await this.idle(250);continue;}
      try {
        const reply=await this.sync.request(CLAIM_ROUTE,{body:()=>sealJson(this.sync.workspaceKey,{node:this.sync.nodeId,v:this.protocol,wait:this.options.claimWaitMs,capacity},'inference-claim'),aad:'inference-claim-reply',signal:AbortSignal.any([peer.controller.signal,this.controller.signal])});
        ensure(reply?.node===this.sync.config.hub?.nodeId && Array.isArray(reply.jobs),502,'The home server sent an unexpected inference reply.');
        if(reply.incompatible || reply.v!==this.protocol){this.workerStatus={claiming:false,incompatible:true,error:'The home server runs a different Tupies Engine version. Update both engines to share local models.',lastClaimAt:now()};await this.idle(60_000);continue;}
        this.workerStatus={claiming:true,incompatible:false,error:null,lastClaimAt:now()};
        for(const job of reply.jobs.slice(0,capacity))this.runJob(job);
        backoff=1000;
      } catch(error) {
        if(this.closed)break;
        this.workerStatus={...this.workerStatus,claiming:false,error:this.store.redact(error?.message || 'The home server is unreachable.')};
        // An older home server does not know the route; ask again much later instead of every second.
        const wait=[403,404].includes(error?.upstream)?300_000:backoff;backoff=Math.min(backoff*2,30_000);
        await this.idle(wait);
      }
    }
  }
  runJob(wire) {
    if(!plain(wire) || typeof wire.id!=='string' || !/^ij_[0-9a-f]{24}$/.test(wire.id) || this.running.has(wire.id))return;
    const job={id:wire.id,seq:0,outbox:[],state:'queued',final:false,stop:false,lastPost:0,controller:new AbortController(),wake:null};
    this.running.set(job.id,job);
    const setState=state=>{if(STATES.has(state) && job.state!==state){job.state=state;job.outbox.push({type:'state',state,...(state==='reading' && job.tokens?{tokens:job.tokens}:{})});job.wake?.();}};
    const push=(type,text)=>{if(typeof text!=='string' || !text)return;if(type==='delta')setState('generating');const last=job.outbox.at(-1);if(last?.type===type)last.text+=text;else job.outbox.push({type,text});job.wake?.();};
    const finish=event=>{job.outbox.push(event);job.final=true;job.wake?.();};
    job.pump=this.pump(job);
    (async()=>{
      try {
        if(wire.v!==this.protocol)throw nodeFailure('node_incompatible','This engine runs a different relay version than the home server. Update both engines.',426);
        const connection=(this.store.state.connections || []).find(item=>item.id===wire.connectionId);
        if(!connection || connection.host!==this.sync.nodeId)throw nodeFailure('node_offline','This connection is no longer hosted by this engine.');
        if(this.sync.options.updateHeld?.())throw nodeFailure('node_offline','This engine is preparing an update and is not running models right now.');
        if(wire.kind==='test') {
          let result;
          try{result=await this.test(connection);}catch(error){await this.onHostTest?.(connection.id,{error});throw error;}
          await this.onHostTest?.(connection.id,{result});
          finish({type:'result',result:{models:Array.isArray(result.models)?result.models.slice(0,10_000):[],source:result.source || 'provider',...(result.account?{account:result.account}:{})}});
          return;
        }
        ensure(wire.kind==='complete' && plain(wire.request),400,'Unknown relayed request.');
        job.tokens=Math.ceil(JSON.stringify(wire.request.messages || []).length/4);
        const result=await this.complete(connection,{...wire.request,priority:wire.priority,signal:job.controller.signal,onDelta:text=>push('delta',text),onReasoning:text=>push('reasoning',text),onRelayState:setState});
        finish({type:'result',result:{text:result.text,toolCalls:result.toolCalls,usage:result.usage,finishReason:result.finishReason,...(result.reasoning?{reasoning:result.reasoning}:{}),...(result.providerItems?{providerItems:result.providerItems}:{}),...(result.outputLimit?{outputLimit:result.outputLimit}:{})}});
      } catch(error) {
        if(job.controller.signal.aborted || job.stop){job.final=true;job.stop=true;job.wake?.();return;}
        const failure=providerFailure(error);
        finish({type:'error',code:failure?.code || null,status:error?.status,upstreamStatus:failure?.upstreamStatus ?? null,...(failure?.timeoutPhase?{timeoutPhase:failure.timeoutPhase}:{}),message:this.store.redact(String(error?.message || 'The model request failed.')),...(Number.isFinite(error?.retryAfterMs)?{retryAfterMs:error.retryAfterMs}:{})});
      }
    })().finally(async()=>{await job.pump;this.running.delete(job.id);});
  }
  /** Sends a job's events in order: deltas at most every flushMs, a heartbeat at least every beatMs, the final result at once. */
  async pump(job) {
    for(;;) {
      if(job.stop || this.closed)return;
      const final=job.outbox.some(event=>event.type==='result' || event.type==='error');
      if(job.final && !final)return;
      const dueAt=final?0:job.outbox.length?job.lastPost+this.options.flushMs:job.lastPost+this.options.beatMs;
      if(Date.now()<dueAt){await new Promise(resolve=>{const timer=setTimeout(done,dueAt-Date.now());timer.unref?.();job.wake=done;function done(){clearTimeout(timer);job.wake=null;resolve();}});continue;}
      const events=job.outbox.splice(0,500);
      if(!events.some(event=>['state','result','error'].includes(event.type)))events.unshift({type:'state',state:job.state,...(job.state==='reading' && job.tokens?{tokens:job.tokens}:{})});
      const seq=++job.seq,reply=await this.post(job,seq,events);job.lastPost=Date.now();
      if(!reply || reply.action!=='continue'){job.stop=true;job.controller.abort(new DOMException(reply?.action==='cancel'?'The home server cancelled this model request.':'The home server no longer waits for this model request.','AbortError'));return;}
      if(events.some(event=>event.type==='result' || event.type==='error'))return;
    }
  }
  /** One batch, re-sent with the same sequence number until the hub answers; the hub drops duplicates. */
  async post(job,seq,events) {
    const deadline=Date.now()+this.options.postRetryMs,body=()=>sealJson(this.sync.workspaceKey,{node:this.sync.nodeId,v:this.protocol,job:job.id,seq,events},'inference-events');
    for(let attempt=0;!this.closed;attempt++) {
      try {
        const reply=await this.sync.request(EVENTS_ROUTE,{body,aad:'inference-events-reply',signal:this.controller.signal});
        ensure(reply?.node===this.sync.config.hub?.nodeId && reply.job===job.id && ['continue','cancel','unknown'].includes(reply.action),502,'The home server sent an unexpected inference reply.');
        return reply;
      } catch(error) {
        if(this.closed || Date.now()>=deadline || [400,403,404,413].includes(error?.upstream))return null;
        await new Promise(resolve=>{const timer=setTimeout(resolve,Math.min(250*2**attempt,5000));timer.unref?.();});
      }
    }
    return null;
  }
  async close() {
    this.closed=true;this.controller.abort();this.stopWatchdog();
    for(const set of this.waiters.values())for(const resolve of set)resolve();this.waiters.clear();
    for(const job of [...this.jobs.values()])this.fail(job,nodeFailure('node_lost','This engine is shutting down. The model request was not replayed.'));
    for(const job of this.running.values()){job.stop=true;job.controller.abort(new DOMException('This engine is shutting down.','AbortError'));job.wake?.();}
    await this.worker;
  }
}

/** API view of a connection's host, for engines without a relay (tests) as well. */
export function connectionHostView(connection,sync) {
  return sync?.inference?.describe?sync.inference.describe(connection):{local:isLocalConnection(connection),host:null};
}
