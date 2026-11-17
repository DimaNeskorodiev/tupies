import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createStudioServer } from '../server.mjs';
import { Providers } from '../lib/providers.mjs';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { InferenceRelay, nodeFailure, RELAY_PROTOCOL } from '../lib/inference-relay.mjs';
import { markProviderFailure, providerFailure } from '../lib/provider-failure.mjs';
import { autonomousRetryPolicy } from '../lib/autonomous-work.mjs';
import { sealJson, openJson } from '../lib/sync/crypto.mjs';
import { controlSocketPath } from '../lib/control.mjs';
import { updateControl } from '../lib/update-control.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(predicate,timeoutMs=8000){const until=Date.now()+timeoutMs;while(Date.now()<until){const value=await predicate();if(value)return value;await delay(10);}throw new Error('Relay fixture timed out.');}
const RELAY={claimWaitMs:300,heartbeatTimeoutMs:800,onlineWindowMs:1200,flushMs:20,beatMs:100,idleCheckMs:30,postRetryMs:1500,timeoutGraceMs:1000};
const MODEL='qwen3.8-27b';
const userMessage=[{role:'user',content:'Hello from the home server.'}];

/** A test double that keeps the real connection validation and lets each test script the model. */
function fakeProviders() {
  const real=new Providers({state:{connections:[]},seal:value=>value,unseal:value=>value,redact:value=>value},{allowPrivateHttp:true});
  const fake={calls:[],modelCalls:0,
    behaviour:async()=>({text:'Fixture answer.',toolCalls:[],usage:{prompt_tokens:3,completion_tokens:2},finishReason:'stop'}),
    listing:async()=>({models:[{id:MODEL,name:'Qwen3.8 27B'}],source:'provider'}),
    catalog:()=>real.catalog(),defaults:type=>real.defaults(type),validate:(input,previous)=>real.validate(input,previous),
    async complete(connection,request){this.calls.push({connectionId:connection.id,request});return this.behaviour(request,connection,this.calls.length);},
    async models(connection){this.modelCalls++;return this.listing(connection);},
    async test(connection){return {connected:true,...await this.models(connection)};},
  };
  return fake;
}
async function engine(t,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-relay-')),model=fakeProviders();
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,retryDelay:1,providers:model,sleepGuard:false,sync:{longPollMs:100,fileScanInterval:200},relay:RELAY,...options}),{url}=await app.listen(0);
  let cookie='',csrf='';
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const request=async(route,{method='GET',body}={})=>{const response=await fetch(url+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
  const setup=async()=>{const response=await fetch(url+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'relay-fixture-password'})});assert.equal(response.status,201);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrf;};
  await setup();
  return {app,directory,url,request,model,openControl:()=>app.openControl(controlSocketPath(directory),url)};
}
async function link(hub,mac){await mac.app.sync.connect(hub.app.sync.devices.createPairing({kind:'engine',baseUrl:hub.url}).link);await eventually(()=>mac.app.sync.peerStatus.connected);}
/** A Mac that hosts an Ollama connection, linked to a home server that has received it and sees the Mac claiming. */
async function pair(t,options={}) {
  const hub=await engine(t,options.hub),mac=await engine(t,options.mac);
  const created=await mac.request('/api/connections',{method:'POST',body:{type:'ollama',name:'Mac · Ollama',defaultModel:MODEL}});
  assert.equal(created.status,201);
  await mac.app.store.mutate(state=>{const connection=state.connections.find(item=>item.id===created.body.id);connection.models=[{id:MODEL,name:'Qwen3.8 27B'}];connection.status='connected';});
  await link(hub,mac);
  const id=created.body.id;
  await eventually(()=>hub.app.store.state.connections.some(item=>item.id===id));
  if(options.online!==false)await eventually(()=>hub.app.sync.inference.hostOnline(mac.app.sync.nodeId) && hub.app.sync.inference.waiting.size>0);
  return {hub,mac,id,created:created.body,connection:()=>hub.app.store.state.connections.find(item=>item.id===id)};
}
const silentUntilAborted=request=>new Promise((_,reject)=>{request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});});

test('a local connection belongs to the engine that adds it; the home server relays answers with tool calls and streamed text',async t=>{
  const {hub,mac,id,created,connection}=await pair(t);
  assert.equal(created.local,true);assert.deepEqual({nodeId:created.host.nodeId,here:created.host.here,online:created.host.online},{nodeId:mac.app.sync.nodeId,here:true,online:true});
  assert.equal(mac.app.store.state.connections.find(item=>item.id===id).host,mac.app.sync.nodeId,'The record stores the host node id.');
  const view=(await hub.request('/api/state')).body.connections.find(item=>item.id===id);
  assert.equal(view.local,true);assert.equal(view.host.nodeId,mac.app.sync.nodeId);assert.equal(view.host.here,false);assert.equal(view.host.online,true);assert.equal(view.host.name,mac.app.sync.identity.name);

  mac.model.behaviour=async request=>{
    await request.onReasoning?.('Thinking about it.');
    await request.onDelta?.('Looking ');await delay(40);await request.onDelta?.('it up.');
    return {text:'Looking it up.',toolCalls:[{id:'call_1',name:'lookup',arguments:{query:'weather'}}],usage:{prompt_tokens:12,completion_tokens:5},finishReason:'tool_calls',reasoning:{text:'Thinking about it.',chars:18}};
  };
  const deltas=[],reasoning=[],states=[];
  const result=await hub.app.providers.complete(structuredClone(connection()),{model:MODEL,messages:userMessage,tools:[{name:'lookup',description:'Look something up.',parameters:{type:'object',properties:{query:{type:'string'}}}}],onDelta:text=>deltas.push(text),onReasoning:text=>reasoning.push(text),onRelayState:state=>states.push(state.state)});
  assert.equal(result.text,'Looking it up.');assert.deepEqual(result.toolCalls,[{id:'call_1',name:'lookup',arguments:{query:'weather'}}]);assert.equal(result.finishReason,'tool_calls');assert.equal(result.usage.prompt_tokens,12);assert.equal(result.reasoning.chars,18);
  assert.equal(deltas.join(''),'Looking it up.');assert.equal(reasoning.join(''),'Thinking about it.');assert.ok(states.includes('generating'));
  assert.equal(hub.model.calls.length,0,'The home server never dials the Mac runtime itself.');
  const sent=mac.model.calls.at(-1);assert.equal(sent.connectionId,id);assert.equal(sent.request.model,MODEL);assert.deepEqual(sent.request.messages,userMessage);assert.equal(sent.request.priority,undefined,'Relay-only fields never reach the provider.');

  // A tool name outside the offered catalog is passed back as the model said it: the engine answers it with a tool error,
  // as it does when the model runs on this engine directly. A malformed call is still refused.
  mac.model.behaviour=async()=>({text:'',toolCalls:[{id:'call_2',name:'delete_everything',arguments:{}}],usage:{},finishReason:'tool_calls'});
  const unknownTool=await hub.app.providers.complete(structuredClone(connection()),{model:MODEL,messages:userMessage,tools:[{name:'lookup',parameters:{type:'object'}}]});
  assert.deepEqual(unknownTool.toolCalls,[{id:'call_2',name:'delete_everything',arguments:{}}]);
  mac.model.behaviour=async()=>({text:'',toolCalls:[{id:'call_3',name:'lookup',arguments:'not an object'}],usage:{},finishReason:'tool_calls'});
  await assert.rejects(hub.app.providers.complete(structuredClone(connection()),{model:MODEL,messages:userMessage,tools:[{name:'lookup',parameters:{type:'object'}}]}),error=>providerFailure(error)?.code==='tool_call_invalid');

  // A provider error on the Mac reaches the home server with its code; it is not replayed.
  mac.model.behaviour=async()=>{throw markProviderFailure(new HttpError(502,'Synthetic runtime failure.'),'upstream_unavailable',{upstreamStatus:503});};
  const before=mac.model.calls.length;
  await assert.rejects(hub.app.providers.complete(structuredClone(connection()),{model:MODEL,messages:userMessage}),error=>providerFailure(error)?.code==='upstream_unavailable' && /Synthetic runtime failure/.test(error.message));
  assert.equal(mac.model.calls.length,before+1);
});

test('relayed models and tests never dial from the home server or write an error there; non-host edits are refused',async t=>{
  const {hub,mac,id,connection}=await pair(t);
  const models=await hub.request(`/api/connections/${id}/models`);
  assert.equal(models.status,200);assert.equal(models.body.source,'synced');assert.deepEqual(models.body.models.map(item=>item.id),[MODEL]);
  assert.equal(hub.model.modelCalls,0);assert.equal(mac.model.modelCalls,0);

  mac.model.listing=async()=>({models:[{id:MODEL,name:'Qwen3.8 27B'},{id:'qwen3.8-9b',name:'Qwen3.8 9B'}],source:'provider'});
  const tested=await hub.request(`/api/connections/${id}/test`,{method:'POST',body:{}});
  assert.equal(tested.status,200);assert.equal(tested.body.relayed,true);assert.equal(tested.body.models.length,2);assert.equal(mac.model.modelCalls,1);
  // The host records its own test; the result reaches the home server through sync.
  await eventually(()=>connection().models?.length===2 && connection().status==='connected');

  // With the Mac gone, the test fails clearly and nothing marks the shared record broken.
  await mac.app.sync.inference.close();
  await eventually(()=>!hub.app.sync.inference.hostOnline(mac.app.sync.nodeId));
  const offline=await hub.request(`/api/connections/${id}/test`,{method:'POST',body:{}});
  assert.equal(offline.status,503);assert.match(offline.body.error,/offline/);
  assert.equal(connection().status,'connected');assert.equal(connection().error,undefined);
  assert.equal((await hub.request('/api/state')).body.connections.find(item=>item.id===id).host.online,false);

  const refused=await hub.request(`/api/connections/${id}`,{method:'PATCH',body:{baseUrl:'http://127.0.0.1:9999/v1'}});
  assert.equal(refused.status,409);assert.match(refused.body.error,/Only .* can change/);
  const retyped=await hub.request(`/api/connections/${id}`,{method:'PATCH',body:{type:'mlx'}});
  assert.ok([400,409].includes(retyped.status));
  const renamed=await hub.request(`/api/connections/${id}`,{method:'PATCH',body:{name:'Mac model',defaultModel:'qwen3.8-9b'}});
  assert.equal(renamed.status,200);assert.equal(renamed.body.name,'Mac model');assert.equal(connection().status,'connected');assert.equal(connection().models.length,2,'A non-host keeps the host’s model list.');assert.equal(connection().host,mac.app.sync.nodeId);
  // Only a confirmed takeover changes the host, and never while the host is online.
  assert.equal((await hub.request(`/api/connections/${id}/host`,{method:'POST',body:{}})).status,400);
  const takeover=await hub.request(`/api/connections/${id}/host`,{method:'POST',body:{confirm:true}});
  assert.equal(takeover.status,200);assert.equal(takeover.body.host.here,true);assert.equal(connection().host,hub.app.sync.nodeId);
});

test('stopping a task during a silent prefill reaches the Mac through the heartbeat reply',async t=>{
  const {hub,mac,connection}=await pair(t);
  let aborted=false;mac.model.behaviour=request=>silentUntilAborted(request).finally(()=>{aborted=true;});
  const controller=new AbortController(),states=[];
  const pending=hub.app.providers.complete(structuredClone(connection()),{model:MODEL,messages:userMessage,signal:controller.signal,onRelayState:state=>states.push(state.state)});
  await eventually(()=>states.includes('reading'));
  assert.equal(mac.app.sync.inference.running.size,1);
  await delay(RELAY.beatMs*3);assert.equal(aborted,false,'Heartbeats keep a silent prefill alive.');
  controller.abort(new DOMException('Stopped by the owner.','AbortError'));
  await assert.rejects(pending,/Stopped by the owner/);
  await eventually(()=>aborted && mac.app.sync.inference.running.size===0,3000);
  assert.equal(hub.app.sync.inference.jobs.size,0);
});

test('a Mac that stops sending heartbeats fails the request as node_lost; a hub that forgot the job stops the Mac',async t=>{
  const {hub,mac,connection}=await pair(t);
  // The home server restarted and lost its waiter: the Mac's next heartbeat gets "unknown job" and it stops generating.
  let aborted=0;mac.model.behaviour=request=>silentUntilAborted(request).finally(()=>{aborted++;});
  const forgotten=hub.app.providers.complete(structuredClone(connection()),{model:MODEL,messages:userMessage});forgotten.catch(()=>{});
  await eventually(()=>mac.app.sync.inference.running.size===1);
  const [job]=hub.app.sync.inference.jobs.values();hub.app.sync.inference.jobs.clear();hub.app.sync.inference.tombstones.clear();
  await eventually(()=>aborted===1 && mac.app.sync.inference.running.size===0,3000);
  job.reject(new Error('Synthetic restart cleanup.'));

  // The Mac goes away mid-answer: no batch for the heartbeat limit ends the request without a replay.
  const pending=hub.app.providers.complete(structuredClone(connection()),{model:MODEL,messages:userMessage});
  await eventually(()=>mac.app.sync.inference.running.size===1);
  const calls=mac.model.calls.length;
  await mac.app.sync.inference.close();
  const started=Date.now();
  await assert.rejects(pending,error=>providerFailure(error)?.code==='node_lost' && /stopped responding/.test(error.message));
  assert.ok(Date.now()-started<RELAY.heartbeatTimeoutMs+1500);assert.equal(mac.model.calls.length,calls,'Nothing was replayed.');
});

test('an offline Mac answers node_offline at once and the bot falls back without retries; without a fallback the task fails clearly',async t=>{
  const {hub,mac,id,connection}=await pair(t);
  await mac.app.sync.inference.close();
  await eventually(()=>!hub.app.sync.inference.hostOnline(mac.app.sync.nodeId));
  const started=Date.now();
  await assert.rejects(hub.app.providers.complete(structuredClone(connection()),{model:MODEL,messages:userMessage}),error=>providerFailure(error)?.code==='node_offline' && /offline/.test(error.message));
  assert.ok(Date.now()-started<200,'No claim wait.');

  await hub.app.store.mutate(state=>{
    state.connections.push({id:'cloud',type:'openai',name:'Cloud',defaultModel:'cloud-model',secret:hub.app.store.seal('fixture-key'),models:[{id:'cloud-model'}]});
    Object.assign(state.bots.find(bot=>bot.id==='bot_atlas'),{connectionId:id,model:MODEL,tools:[],fallback:{connectionId:'cloud',model:'cloud-model'}});
  });
  hub.model.behaviour=async request=>({text:`Answered by ${request.model}.`,toolCalls:[],usage:{},finishReason:'stop'});
  const run=await hub.app.runtime.start('bot_atlas','Say hi.');
  await eventually(()=>!isActive(hub.app.store.state.runs.bot_atlas) && hub.app.store.state.runs.bot_atlas.id===run.id);
  const done=hub.app.store.state.runs.bot_atlas;
  assert.equal(done.status,'completed');assert.equal(done.output,'Answered by cloud-model.');assert.equal(done.fallback.reason,'node_offline');
  assert.equal((done.events || []).filter(event=>event.type==='model.retry').length,0);assert.equal(hub.model.calls.length,1);

  await hub.app.store.mutate(state=>{delete state.bots.find(bot=>bot.id==='bot_atlas').fallback;});
  const second=await hub.app.runtime.start('bot_atlas','Say hi again.');
  await eventually(()=>hub.app.store.state.runs.bot_atlas.id===second.id && !isActive(hub.app.store.state.runs.bot_atlas));
  const failed=hub.app.store.state.runs.bot_atlas;
  assert.equal(failed.status,'failed');assert.match(failed.error,/The Mac that runs this model .* is offline/);assert.equal(failed.failure?.code,'node_offline');
  assert.equal((failed.events || []).filter(event=>event.type==='model.retry').length,0);
});

test('a protocol mismatch fails as node_incompatible and the Mac stops claiming',async t=>{
  const {hub,mac,connection}=await pair(t,{mac:{relay:{...RELAY,protocol:RELAY_PROTOCOL+1}},online:false});
  await eventually(()=>hub.app.sync.inference.incompatible.has(mac.app.sync.nodeId));
  await assert.rejects(hub.app.providers.complete(structuredClone(connection()),{model:MODEL,messages:userMessage}),error=>providerFailure(error)?.code==='node_incompatible' && /Update both engines/.test(error.message));
  await eventually(()=>mac.app.sync.inference.workerStatus.incompatible===true);
  assert.equal(hub.app.sync.status().inference.hosts[0].incompatible,true);
});

test('the claim wait does not block home server updates; a relayed job blocks unlink and updates on the Mac',async t=>{
  const {hub,mac,connection}=await pair(t,{hub:{relay:{...RELAY,claimWaitMs:20_000}},mac:{relay:{...RELAY,claimWaitMs:20_000}}});
  await hub.openControl();await mac.openControl();
  await eventually(()=>hub.app.sync.inference.waiting.size>0);
  const claim=await updateControl(hub.directory,'update-claim');
  assert.equal(claim.ready,true,'An idle claim long-poll leaves the home server free to update.');
  await updateControl(hub.directory,'update-release',claim.token);
  await eventually(()=>hub.app.sync.inference.hostOnline(mac.app.sync.nodeId) && hub.app.sync.inference.waiting.size>0,25_000);

  mac.model.behaviour=silentUntilAborted;
  const controller=new AbortController(),pending=hub.app.providers.complete(structuredClone(connection()),{model:MODEL,messages:userMessage,signal:controller.signal});pending.catch(()=>{});
  await eventually(()=>mac.app.sync.inference.running.size===1);
  await assert.rejects(mac.app.sync.disconnect(),error=>error.status===409);
  assert.equal((await updateControl(mac.directory,'update-claim')).ready,false);
  controller.abort();await assert.rejects(pending);
  await eventually(()=>mac.app.sync.inference.running.size===0,3000);
  const ready=await updateControl(mac.directory,'update-claim');assert.equal(ready.ready,true);await updateControl(mac.directory,'update-release',ready.token);
});

// ---- Protocol handlers with a fake hub link ---------------------------------------------------

function fakeHub() {
  const key=randomBytes(32),store={state:{connections:[{id:'local',type:'ollama',host:'node_mac',baseUrl:'http://127.0.0.1:11434/v1'}]},redact:value=>value,redactValue:value=>value};
  const sync={nodeId:'node_hub',role:()=>'hub',nodeName:node=>node==='node_mac'?'Studio Mac':'another engine',securityOperation:operation=>Promise.resolve().then(operation),hubEngine:session=>session.device,assertEpoch(){},workspaceKey:key,online:new Map(),config:{},options:{}};
  const relay=new InferenceRelay({store,sync,options:{...RELAY,claimWaitMs:50}}),session={device:{nodeId:'node_mac'}};
  const claim=async(body={})=>openJson(key,await relay.claim(session,sealJson(key,{node:'node_mac',v:RELAY_PROTOCOL,wait:50,capacity:4,...body},'inference-claim'),null,1),'inference-claim-reply');
  const post=async(job,seq,events,extra={})=>openJson(key,await relay.events(session,sealJson(key,{node:'node_mac',v:RELAY_PROTOCOL,job,seq,events,...extra},'inference-events'),1),'inference-events-reply');
  return {relay,store,claim,post,session,key};
}

test('the hub drops duplicate batches, refuses gaps and other claimants, and answers unknown for forgotten jobs',async t=>{
  const {relay,claim,post,key}=fakeHub();t.after(()=>relay.close());
  relay.seen.set('node_mac',Date.now());
  const deltas=[],pending=relay.relay('complete',{id:'local',host:'node_mac'},{model:MODEL,messages:userMessage,tools:[],onDelta:text=>deltas.push(text)});
  const {jobs}=await claim();assert.equal(jobs.length,1);const job=jobs[0].id;assert.equal(jobs[0].v,RELAY_PROTOCOL);assert.deepEqual(jobs[0].request.messages,userMessage);
  // Another engine cannot claim or feed this job.
  const intruder=openJson(key,await relay.events({device:{nodeId:'node_other'}},sealJson(key,{node:'node_other',v:RELAY_PROTOCOL,job,seq:1,events:[]},'inference-events'),1),'inference-events-reply');
  assert.equal(intruder.action,'unknown');
  await assert.rejects(relay.events({device:{nodeId:'node_other'}},sealJson(key,{node:'node_mac',v:RELAY_PROTOCOL,job,seq:1,events:[]},'inference-events'),1),error=>error.status===403);
  assert.equal((await post(job,1,[{type:'delta',text:'Hello'}])).action,'continue');
  const again=await post(job,1,[{type:'delta',text:'Hello'}]);assert.equal(again.action,'continue');assert.equal(again.duplicate,true);
  assert.equal((await post(job,2,[{type:'delta',text:' world'},{type:'result',result:{text:'Hello world',toolCalls:[],usage:{},finishReason:'stop'}}])).action,'continue');
  const result=await pending;assert.equal(result.text,'Hello world');assert.deepEqual(deltas,['Hello',' world']);
  assert.equal((await post(job,2,[{type:'result',result:{text:'Hello world'}}])).action,'continue','A re-sent final batch is acknowledged, not applied twice.');
  assert.equal((await post(`ij_${'0'.repeat(24)}`,1,[])).action,'unknown');

  const gapped=relay.relay('complete',{id:'local',host:'node_mac'},{model:MODEL,messages:userMessage});
  const second=(await claim()).jobs[0].id;
  assert.equal((await post(second,3,[{type:'delta',text:'skipped'}])).action,'cancel');
  await assert.rejects(gapped,error=>providerFailure(error)?.code==='stream_interrupted');
});

test('a version mismatch from the claimant marks the host incompatible and fails its queued jobs',async t=>{
  const {relay,claim}=fakeHub();t.after(()=>relay.close());
  relay.seen.set('node_mac',Date.now());
  const queued=relay.relay('complete',{id:'local',host:'node_mac'},{model:MODEL,messages:userMessage});
  const reply=await claim({v:RELAY_PROTOCOL+1});assert.equal(reply.incompatible,true);assert.deepEqual(reply.jobs,[]);
  await assert.rejects(queued,error=>providerFailure(error)?.code==='node_incompatible');
  await assert.rejects(relay.relay('complete',{id:'local',host:'node_mac'},{model:MODEL,messages:userMessage}),error=>providerFailure(error)?.code==='node_incompatible');
  await claim();assert.equal(relay.incompatible.has('node_mac'),false,'An updated claimant clears the mark.');
});

test('the host queue runs at most two requests per runtime, interactive work before background reviews',async()=>{
  const store={state:{connections:[{id:'local',type:'ollama',host:'node_mac',baseUrl:'http://127.0.0.1:11434/v1'}]},redact:value=>value};
  const sync={nodeId:'node_mac',role:()=>'replica',config:{},options:{}};
  const order=[],gates=[];let running=0,peak=0;
  const providers={async complete(_connection,request){running++;peak=Math.max(peak,running);order.push(request.label);await new Promise(resolve=>gates.push(resolve));running--;return {text:request.label,toolCalls:[]};},async reviewMemory(connection,request){return this.complete(connection,request);}};
  const relay=new InferenceRelay({store,sync}).install(providers);
  const connection=store.state.connections[0],states=[];
  const first=providers.complete(connection,{label:'a'}),second=providers.complete(connection,{label:'b'});
  const review=providers.reviewMemory(connection,{label:'review'}),interactive=providers.complete(connection,{label:'c',onRelayState:state=>states.push(state.state)});
  await eventually(()=>order.length===2);assert.equal(peak,2);assert.deepEqual(states,['queued']);
  gates.shift()();await eventually(()=>order.length===3);assert.equal(order[2],'c','Interactive work overtakes a queued background review.');assert.deepEqual(states,['queued','reading']);
  while(gates.length || order.length<4){if(gates.length)gates.shift()();await delay(5);}
  await Promise.all([first,second,review,interactive]);assert.deepEqual(order,['a','b','c','review']);assert.equal(peak,2);assert.equal(relay.busy(),false);
});

// ---- Engine: relay failures skip retries and go to the fallback ---------------------------------

test('node_offline and node_lost skip the autonomous retry loop; other relay codes keep their meaning',()=>{
  for(const code of ['node_offline','node_lost']){const policy=autonomousRetryPolicy(nodeFailure(code,'offline'));assert.deepEqual([policy.retry,policy.exhausted,policy.transient,policy.node],[false,true,true,true]);}
  const incompatible=autonomousRetryPolicy(nodeFailure('node_incompatible','update',426));assert.equal(incompatible.retry,false);assert.equal(incompatible.transient,undefined);
  assert.equal(providerFailure(nodeFailure('node_lost','gone')).code,'node_lost','Relay codes are trusted provider failure codes.');
});

test('an engine task on an offline local model goes straight to the fallback model, once',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-relay-engine-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{
    state.connections.push({id:'mac',type:'ollama',name:'Mac',host:'node_elsewhere',model:MODEL,models:[{id:MODEL}]});
    state.connections.push({id:'cloud',type:'openai',name:'Cloud',model:'cloud-model',secret:store.seal('disposable-key'),models:[{id:'cloud-model'}]});
    Object.assign(state.bots.find(bot=>bot.id==='bot_atlas'),{connectionId:'mac',model:MODEL,tools:[],collaborators:[],fallback:{connectionId:'cloud',model:'cloud-model'}});
  });
  const engine=new NativeEngine(store,{retryDelay:1,providers:{async complete(connection,request){requests.push(connection.id);if(connection.id==='mac')throw nodeFailure('node_lost','The Mac stopped responding.');return {text:'Cloud answer.',toolCalls:[]};}}});
  await engine.recover();t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const run=await engine.start('bot_atlas','Say hi.');
  await eventually(()=>store.state.runs.bot_atlas?.id===run.id && !isActive(store.state.runs.bot_atlas));await engine.tasks.get(run.id);
  const done=store.state.runs.bot_atlas;
  assert.equal(done.status,'completed');assert.equal(done.output,'Cloud answer.');assert.deepEqual(requests,['mac','cloud']);assert.equal(done.fallback.reason,'node_lost');
});
