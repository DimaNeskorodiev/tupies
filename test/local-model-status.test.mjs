import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { Providers } from '../lib/providers.mjs';
import { InferenceRelay, RELAY_PROTOCOL } from '../lib/inference-relay.mjs';
import { watchRelayState } from '../lib/model-resilience.mjs';
import { SleepGuard, CAFFEINATE } from '../lib/sleep-guard.mjs';
import { isEmbeddingModel } from '../lib/local-models.mjs';
import { sealJson, openJson } from '../lib/sync/crypto.mjs';

// Live local-model states in the chat, the macOS sleep guard and hidden embedding models.
// Every model, runtime, hub and caffeinate process here is a fake; nothing is dialled or spawned.
const BOT='bot_atlas',MODEL='qwen3.8-27b';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(predicate,timeoutMs=8000){const until=Date.now()+timeoutMs;while(Date.now()<until){const value=await predicate();if(value)return value;await delay(5);}throw new Error('Status fixture timed out.');}
const HERE={here:true,mac:true};

/** An engine whose bot uses `connection`; `providers` is the model double. Records every run event as it is written. */
async function engineFixture(t,{connection,providers,options={}}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-lm-status-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections.push(connection);Object.assign(state.bots.find(bot=>bot.id===BOT),{connectionId:connection.id,model:MODEL,tools:[],collaborators:[]});});
  const engine=new NativeEngine(store,{retryDelay:1,providers,...options}),written=[];
  const event=engine.event.bind(engine);engine.event=async(context,type,details={},extra)=>{written.push({type,...details});return event(context,type,details,extra);};
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const run=async text=>{const started=await engine.start(BOT,text);await eventually(()=>store.state.runs[BOT]?.id===started.id && !isActive(store.state.runs[BOT]));await engine.tasks.get(started.id);return store.state.runs[BOT];};
  return {store,engine,written,run};
}
const notices=written=>written.filter(item=>item.type==='model.waiting');

// ---- watchRelayState: one notice per change ------------------------------------------------------

test('relay states become one notice per change; heartbeats repeat nothing and streamed text clears it',async()=>{
  const written=[],context={controller:new AbortController(),connection:{type:'ollama'},inference:{model:MODEL}};
  const engine={event:async(_context,type,details,options)=>{written.push({type,...details,replace:options?.replace===true});}};
  const watch=watchRelayState(engine,context,3,{estimate:2400.4});
  for(let beat=0;beat<5;beat++)watch.onRelayState({state:'queued',host:HERE});
  watch.onRelayState({state:'loading',host:HERE});watch.onRelayState({state:'loading',host:HERE});
  for(let beat=0;beat<5;beat++)watch.onRelayState({state:'reading',host:HERE});
  await delay(5);
  assert.deepEqual(written.map(item=>item.state),['queued','loading','reading']);
  assert.ok(written.every(item=>item.type==='model.waiting' && item.replace && item.step===3 && item.elapsedMs===0));
  assert.equal(written[2].tokens,2400,'reading uses the engine estimate when the runtime gives none');
  assert.deepEqual(written[0].host,HERE);assert.equal(written[0].model,MODEL);
  assert.deepEqual(context.relayState,{state:'reading',tokens:2400,host:HERE},'the periodic wait notice keeps the state');
  watch.activity();watch.activity();
  watch.onRelayState({state:'reading',host:HERE});
  await delay(5);
  assert.deepEqual(written.slice(3).map(item=>item.type),['model.resumed'],'streamed text clears the notice once; later heartbeats are ignored');
  assert.equal(context.relayState,null);
  watch.stop();watch.onRelayState({state:'queued',host:HERE});await delay(5);assert.equal(written.length,4,'nothing after the step ends');

  // A relayed host's own token estimate wins, and a generating state clears the notice like text does.
  const relayed=[],other=watchRelayState({event:async(_c,type,details)=>{relayed.push({type,...details});}},{controller:new AbortController(),connection:{type:'ollama'},inference:{}},1,{estimate:10});
  other.onRelayState({state:'queued',host:{here:false,name:' Studio Mac '}});other.onRelayState({state:'reading',tokens:24_000,host:{here:false,name:'Studio Mac'}});other.onRelayState({state:'generating',host:{here:false}});other.onRelayState({state:'generating'});
  await delay(5);
  assert.deepEqual(relayed.map(item=>[item.type,item.state,item.tokens]),[['model.waiting','queued',undefined],['model.waiting','reading',24_000],['model.resumed',undefined,undefined]]);
  assert.deepEqual(relayed[0].host,{here:false,name:'Studio Mac'});
  for(const bad of [null,'reading',{state:'unknown'},{}])other.onRelayState(bad);
});

// ---- The engine step on a local, a relayed and a cloud connection --------------------------------

test('a task step on a local model shows queued and reading once each, then the streamed answer',async t=>{
  const requests=[],seen=[];
  const providers={hostedElsewhere:()=>false,async complete(_connection,request){
    requests.push(request);
    for(let beat=0;beat<4;beat++){request.onRelayState?.({state:'queued',host:HERE});await delay(2);}
    for(let beat=0;beat<4;beat++){request.onRelayState?.({state:'reading',host:HERE});await delay(2);}
    seen.push(structuredClone(f.store.state.runs[BOT].events.filter(event=>event.type==='model.waiting')));
    await request.onDelta?.('Hello ');request.onRelayState?.({state:'reading',host:HERE});await request.onDelta?.('there.');
    return {text:'Hello there.',toolCalls:[],usage:{prompt_tokens:20,completion_tokens:3},finishReason:'stop'};
  },
  async reviewMemory(_connection,request){requests.push({review:true,...request});return {text:'{}',toolCalls:[]};},
  async reviewSkill(_connection,request){requests.push({review:true,...request});return {text:'{}',toolCalls:[]};}};
  const f=await engineFixture(t,{connection:{id:'mac',type:'ollama',name:'Mac · Ollama',baseUrl:'http://127.0.0.1:11434/v1',model:MODEL,models:[{id:MODEL}]},providers});
  const done=await f.run('Say hello.');
  assert.equal(done.status,'completed');assert.equal(done.output,'Hello there.');
  assert.equal(typeof requests[0].onRelayState,'function','the task step asks for live states');
  assert.ok(requests.filter(request=>request.review).every(request=>request.onRelayState===undefined),'reviews never write notices');
  const states=notices(f.written);
  assert.deepEqual(states.map(item=>item.state),['queued','reading'],'eight heartbeats wrote two notices');
  assert.ok(states[1].tokens>0,'reading carries the engine estimate');assert.deepEqual(states[1].host,HERE);
  assert.equal(seen[0].length,1,'only the newest notice is kept on the run');assert.equal(seen[0][0].state,'reading');
  const resumed=f.written.findIndex(item=>item.type==='model.resumed');
  assert.ok(resumed>f.written.indexOf(states[1]),'the first text clears the notice');
  assert.equal(f.written.filter(item=>item.type==='model.resumed').length,1);
  assert.ok(!f.written.slice(resumed).some(item=>item.type==='model.waiting'),'no notice after the answer started');
});

test('a cloud model step gets no live states and writes no notices',async t=>{
  const requests=[];
  const providers={hostedElsewhere:()=>false,async complete(_connection,request){requests.push(request);await request.onDelta?.('Cloud.');return {text:'Cloud.',toolCalls:[],finishReason:'stop'};}};
  const f=await engineFixture(t,{connection:{id:'cloud',type:'openai',name:'Cloud',model:'cloud-model',secret:'disposable',models:[{id:MODEL}]},providers});
  const done=await f.run('Say hi.');
  assert.equal(done.status,'completed');assert.equal(requests.length>=1,true);
  assert.ok(requests.every(request=>!('onRelayState' in request)),'cloud requests are unchanged');
  assert.deepEqual(notices(f.written),[]);assert.equal(f.written.some(item=>item.type==='model.resumed'),false);
});

/** A home server whose relay is installed on a model double that must never be dialled; the Mac is played by the test. */
function hubRelay(store) {
  const key=randomBytes(32);
  const sync={nodeId:'node_hub',role:()=>'hub',nodeName:node=>node==='node_mac'?'Studio Mac':'another engine',securityOperation:operation=>Promise.resolve().then(operation),hubEngine:session=>session.device,assertEpoch(){},workspaceKey:key,online:new Map(),config:{},options:{}};
  const dialled=[],providers={async complete(){dialled.push('complete');throw new Error('The hub must not dial the Mac runtime.');}};
  const relay=new InferenceRelay({store,sync,options:{claimWaitMs:50,heartbeatTimeoutMs:5000}}).install(providers);
  relay.seen.set('node_mac',Date.now());
  const session={device:{nodeId:'node_mac'}};
  const claim=async()=>openJson(key,await relay.claim(session,sealJson(key,{node:'node_mac',v:RELAY_PROTOCOL,wait:50,capacity:4},'inference-claim'),null,1),'inference-claim-reply');
  const post=async(job,seq,events)=>openJson(key,await relay.events(session,sealJson(key,{node:'node_mac',v:RELAY_PROTOCOL,job,seq,events},'inference-events'),1),'inference-events-reply');
  return {relay,providers,claim,post,dialled};
}

test('a step relayed to the Mac says “Waiting for” the Mac by name, then reading, once each despite heartbeats',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-lm-status-hub-')),store=await new Store(directory).init();
  const hub=hubRelay(store);
  t.after(async()=>{await hub.relay.close();});
  const connection={id:'mac',type:'ollama',name:'Mac · Ollama',host:'node_mac',baseUrl:'http://127.0.0.1:11434/v1',model:MODEL,models:[{id:MODEL}]};
  const f=await engineFixture(t,{connection,providers:hub.providers});
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const started=f.engine.start(BOT,'Say hello from the Mac.');
  await eventually(()=>hub.relay.jobs.size===1);
  await eventually(()=>notices(f.written).length===1);
  assert.deepEqual(notices(f.written).map(item=>[item.state,item.host]),[['queued',{here:false,name:'Studio Mac'}]],'the hub says it waits for the Mac before the Mac claims');
  const {jobs}=await hub.claim();assert.equal(jobs.length,1);const job=jobs[0].id;
  // Heartbeats repeat the state in every batch.
  let seq=0;
  for(const state of ['queued','reading','reading','reading'])assert.equal((await hub.post(job,++seq,[{type:'state',state,...(state==='reading'?{tokens:24_000}:{})}])).action,'continue');
  await hub.post(job,++seq,[{type:'state',state:'generating'},{type:'delta',text:'Hello.'}]);
  await hub.post(job,++seq,[{type:'state',state:'generating'}]);
  await hub.post(job,++seq,[{type:'result',result:{text:'Hello.',toolCalls:[],usage:{},finishReason:'stop'}}]);
  await started;await eventually(()=>!isActive(f.store.state.runs[BOT]));await f.engine.tasks.get(f.store.state.runs[BOT].id);
  const done=f.store.state.runs[BOT];
  assert.equal(done.status,'completed');assert.equal(done.output,'Hello.');assert.deepEqual(hub.dialled,[]);
  assert.deepEqual(notices(f.written).map(item=>[item.state,item.tokens]),[['queued',undefined],['reading',24_000]],'one notice per change, the host’s token estimate');
  assert.equal(f.written.filter(item=>item.type==='model.resumed').length,1);
});

// ---- Sleep guard -----------------------------------------------------------------------------------

function fakeSpawner() {
  const spawned=[];
  const spawn=(command,args,options)=>{const child=new EventEmitter();child.killed=[];child.kill=signal=>{child.killed.push(signal);};child.unrefed=false;child.unref=()=>{child.unrefed=true;};spawned.push({command,args,options,child});return child;};
  return {spawn,spawned};
}

test('the sleep guard holds one caffeinate tied to the engine while requests run, and lets go after a grace period',async()=>{
  const {spawn,spawned}=fakeSpawner();
  const guard=new SleepGuard({platform:'darwin',exists:file=>file===CAFFEINATE,spawn,pid:4321,graceMs:40});
  const first=guard.acquire(),second=guard.acquire();
  assert.equal(spawned.length,1,'one assertion for any number of requests');
  assert.equal(spawned[0].command,'/usr/bin/caffeinate');assert.deepEqual(spawned[0].args,['-i','-w','4321']);assert.equal(spawned[0].options.stdio,'ignore');assert.equal(spawned[0].child.unrefed,true,'it never keeps the engine alive');
  first();first();assert.equal(guard.count,1,'a release function counts once');
  second();assert.deepEqual(spawned[0].child.killed,[],'the grace period avoids flapping');
  const third=guard.acquire();await delay(60);
  assert.deepEqual(spawned[0].child.killed,[],'a new request during the grace period keeps the same assertion');assert.equal(spawned.length,1);
  third();await delay(15);assert.deepEqual(spawned[0].child.killed,[]);
  await delay(60);assert.deepEqual(spawned[0].child.killed,['SIGTERM'],'released after the last request plus the grace period');assert.equal(guard.holding,false);
  // An ended caffeinate is replaced by the next request.
  const fourth=guard.acquire();assert.equal(spawned.length,2);spawned[1].child.emit('exit',0);assert.equal(guard.holding,false);
  const fifth=guard.acquire();assert.equal(spawned.length,3);fourth();fifth();
  assert.equal(await guard.hold(async()=>{assert.equal(guard.count,1);return 'held';}),'held');assert.equal(guard.count,0);
  guard.close();assert.deepEqual(spawned[2].child.killed,['SIGTERM'],'closing the engine ends it at once');
  guard.acquire();assert.equal(spawned.length,3,'nothing after close');
  // A failed spawn is not fatal.
  const broken=new SleepGuard({platform:'darwin',exists:()=>true,spawn:()=>{throw new Error('spawn failed');},graceMs:1});
  assert.equal(await broken.hold(async()=>'still answered'),'still answered');
});

test('the sleep guard does nothing on Linux or without caffeinate',async()=>{
  for(const options of [{platform:'linux',exists:()=>true},{platform:'darwin',exists:()=>false},{platform:'win32',exists:()=>true}]){
    const {spawn,spawned}=fakeSpawner(),guard=new SleepGuard({...options,spawn,graceMs:1});
    const release=guard.acquire();release();assert.equal(await guard.hold(async()=>'ok'),'ok');await delay(5);
    assert.equal(spawned.length,0,options.platform);assert.equal(guard.supported,false);guard.close();
  }
});

test('the relay holds the sleep guard for local requests and relayed jobs on the host, never for cloud or hub-side jobs',async t=>{
  const counts=[];let active=0,acquired=0;
  const guard={acquire(){active++;acquired++;let done=false;return ()=>{if(!done){done=true;active--;}};},async hold(fn){const release=this.acquire();try{return await fn();}finally{release();}},close(){}};
  // Host engine: one local connection, one cloud one; the hub is played by a fake sync.request.
  const key=randomBytes(32),store={state:{connections:[{id:'local',type:'ollama',host:'node_mac',baseUrl:'http://127.0.0.1:11434/v1'},{id:'cloud',type:'openai'}]},redact:value=>value,redactValue:value=>value};
  const posted=[];
  const sync={nodeId:'node_mac',role:()=>'replica',config:{hub:{nodeId:'node_hub'}},options:{},workspaceKey:key,
    async request(_route,{body}){const batch=openJson(key,body(),'inference-events');posted.push(batch);return {node:'node_hub',job:batch.job,seq:batch.seq,action:'continue'};}};
  const providers={async complete(connection,request){counts.push([connection.id,active]);request.onDelta?.('Hi');return {text:'Hi',toolCalls:[],usage:{},finishReason:'stop'};}};
  const relay=new InferenceRelay({store,sync,sleepGuard:guard,options:{flushMs:1,beatMs:20}}).install(providers);
  t.after(()=>relay.close());
  await providers.complete(store.state.connections[0],{messages:[]});
  assert.deepEqual(counts.at(-1),['local',1],'a local request holds the guard');assert.equal(active,0);
  await providers.complete(store.state.connections[1],{messages:[]});
  assert.deepEqual(counts.at(-1),['cloud',0],'a cloud request does not');
  const before=acquired;
  relay.runJob({id:`ij_${'a'.repeat(24)}`,v:RELAY_PROTOCOL,kind:'complete',priority:'interactive',connectionId:'local',request:{model:MODEL,messages:[{role:'user',content:'Hello'}]}});
  await eventually(()=>posted.some(batch=>batch.events.some(event=>event.type==='result')));
  await eventually(()=>!relay.running.size);
  assert.ok(counts.at(-1)[1]>=1,'a relayed job holds the guard while it runs');assert.ok(acquired>before);assert.equal(active,0,'and lets go when it ends');
  const states=posted.flatMap(batch=>batch.events).filter(event=>event.type==='state').map(event=>event.state);
  assert.ok(states.includes('reading'),'the host still reports its own runtime state');
  // Hub side: a job for another engine never holds this engine awake.
  const hubStore={state:{connections:[{id:'local',type:'ollama',host:'node_mac'}]},redact:value=>value,redactValue:value=>value};
  const hub=new InferenceRelay({store:hubStore,sync:{nodeId:'node_hub',role:()=>'hub',nodeName:()=>'Studio Mac',online:new Map(),config:{},options:{}},sleepGuard:guard,options:{heartbeatTimeoutMs:5000}});
  hub.install({async complete(){throw new Error('never');}});hub.seen.set('node_mac',Date.now());
  const queued=hub.complete(hubStore.state.connections[0],{model:MODEL,messages:[],onRelayState:()=>{}});
  await delay(5);assert.equal(active,0,'the hub only waits for the Mac');
  await hub.close();await assert.rejects(queued);
});

// ---- Embedding models ---------------------------------------------------------------------------

test('local model lists hide embedding models; cloud lists keep every model',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-lm-status-models-')),store=await new Store(directory).init();
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const catalog={data:[{id:'qwen3.8:27b'},{id:'sentence-transformers/all-MiniLM-L6-v2'},{id:'nomic-embed-text:latest'},{id:'llama3.2:3b'}]};
  const providers=new Providers(store,{allowPrivateHttp:true,serviceRequest:async()=>({status:200,headers:{},data:catalog})});t.after(()=>providers.close?.());
  const local=await providers.models({id:'local',type:'ollama',baseUrl:'http://127.0.0.1:11434/v1'});
  assert.deepEqual(local.models.map(model=>model.id),['qwen3.8:27b','llama3.2:3b']);
  const cloud=await providers.models({id:'cloud',type:'custom',baseUrl:'https://models.example.test/v1',local:false});
  assert.equal(cloud.models.length,4,'a cloud endpoint lists its embedding models unchanged');
  // The home server's synced listing of a Mac-hosted connection hides them too, also from records written before this change.
  const hubStore={state:{connections:[{id:'mac',type:'ollama',host:'node_mac',models:[{id:'qwen3.8:27b'},{id:'all-minilm:latest'}]}]}};
  const relay=new InferenceRelay({store:hubStore,sync:{nodeId:'node_hub',role:()=>'hub',config:{},options:{}}});
  assert.deepEqual((await relay.models({id:'mac'})).models.map(model=>model.id),['qwen3.8:27b']);
  for(const id of ['sentence-transformers/all-MiniLM-L6-v2','nomic-embed-text','bge-m3','mxbai-embed-large:latest','intfloat/e5-large-v2'])assert.equal(isEmbeddingModel(id),true,id);
  for(const id of ['qwen3.8:27b','mlx-community/Qwen3.8-27B-4bit','deepseek-v4','gemma4:e4b'])assert.equal(isEmbeddingModel(id),false,id);
});
