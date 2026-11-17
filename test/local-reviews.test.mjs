import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { reviewActionRisk } from '../lib/action-risk-review.mjs';
import { markProviderFailure } from '../lib/provider-failure.mjs';

// A loopback OpenAI-compatible runtime whose model can turn thinking off. The reasoning record is declared in the
// catalog so these tests do not depend on the family presets in lib/local-models.mjs.
const LOCAL_MODEL='qwen3.8-27b';
const thinking={supported:true,source:'provider',parameter:'reasoning',efforts:['none','low','medium','high'],defaultEffort:''};
const localConnection=(reasoning=thinking)=>({id:'local',type:'custom',baseUrl:'http://127.0.0.1:8080/v1',defaultModel:LOCAL_MODEL,models:[{id:LOCAL_MODEL,reasoning}]});
const cloudConnection=()=>({id:'cloud',type:'custom',baseUrl:'https://models.example.test/v1',defaultModel:'fixture-model'});

const serviceCall={id:'compute',name:'integration_call',arguments:{integrationId:'fixture-api',tool:'compute',arguments:{}}};
const integration={id:'fixture-api',name:'Fixture API',type:'rest',baseUrl:'https://example.test',tools:[{name:'compute',method:'POST',path:'/compute',inputSchema:{type:'object'}}]};
const verdict=request=>({toolCalls:[{name:'action_review_result',arguments:{actionDigest:JSON.parse(request.messages[1].content).actionDigest,decision:'approve',risks:[],reason:'Compute the requested value.'}}],usage:{}});
function actionHarness(connection,infer=async(_c,_n,request)=>verdict(request)) {
  const bot={id:'fixture',approvalPolicy:'auto'},requests=[];
  const context={bot,source:'chat',sessionId:'fixture',runId:'run',task:'Compute the requested value.',controller:new AbortController(),connection,inference:{model:connection.defaultModel,reasoning:{supported:false,efforts:[]},reasoningEffort:''}};
  const state={bots:[bot],messages:{fixture:[]},conversations:{fixture:[]},integrations:[integration]};
  const engine={store:{state,redactValue:value=>value,redact:value=>value},providers:{reviewAction(){}},assertRunning(){},assertNoPendingSteer(){},event:async()=>{},current:()=>({usage:{}}),update:async()=>{},
    infer:async(...args)=>{requests.push(args[2]);return infer(...args);}};
  return {engine,context,requests};
}

test('action review on a local runtime keeps the task model, turns thinking off, waits 45 s and runs as background work',async()=>{
  const h=actionHarness(localConnection());
  assert.equal((await reviewActionRisk(h.engine,h.context,serviceCall)).automatic,true);
  const [request]=h.requests;
  assert.equal(request.model,LOCAL_MODEL);assert.equal(request.reasoningEffort,'none');assert.ok(request.reasoningCapabilities.efforts.includes('none'));
  assert.equal(request.timeoutMs,45_000);assert.equal(request.priority,'background');
});

test('a local model that cannot turn thinking off keeps the task reasoning but still gets the local limit and priority',async()=>{
  // A model with no family preset, so only its catalog entry decides that thinking cannot be turned off.
  const connection={...localConnection({supported:false,efforts:[]}),defaultModel:'local-model-without-preset'};connection.models=[{id:'local-model-without-preset',reasoning:{supported:false,efforts:[]}}];
  const h=actionHarness(connection);
  await reviewActionRisk(h.engine,h.context,serviceCall);
  const [request]=h.requests;
  assert.equal(request.reasoningEffort,'');assert.deepEqual(request.reasoningCapabilities,{supported:false,efforts:[]});
  assert.equal(request.timeoutMs,45_000);assert.equal(request.priority,'background');
});

test('action review on a cloud connection sends exactly the same request as before',async()=>{
  const h=actionHarness(cloudConnection());
  await reviewActionRisk(h.engine,h.context,serviceCall);
  const [request]=h.requests;
  assert.deepEqual(Object.keys(request),['model','messages','tools','signal','timeoutMs','maxOutputTokens','reasoningCapabilities','reasoningEffort']);
  assert.equal(request.timeoutMs,20_000);assert.equal(request.reasoningEffort,'');
});

test('a local reviewer that times out or returns an invalid decision leaves the action for the owner, saying why',async()=>{
  const timeout=()=>markProviderFailure(new HttpError(504,'The model service did not answer in time.'),'timeout');
  let h=actionHarness(localConnection(),async()=>{throw timeout();});
  let result=await reviewActionRisk(h.engine,h.context,serviceCall);
  assert.equal(result.automatic,false);assert.match(result.reason,/local reviewer did not answer within 45 seconds/);
  h=actionHarness(localConnection(),async()=>({toolCalls:[{name:'action_review_result',arguments:{actionDigest:'x'.repeat(100),decision:'approve',risks:[],reason:'ok'}}]}));
  result=await reviewActionRisk(h.engine,h.context,serviceCall);
  assert.equal(result.automatic,false);assert.match(result.reason,/local reviewer did not return a usable decision/);
  assert.equal(h.requests.length,1);
  // Cloud wording is unchanged.
  h=actionHarness(cloudConnection(),async()=>{throw timeout();});
  assert.equal((await reviewActionRisk(h.engine,h.context,serviceCall)).reason,'Automatic risk review could not finish. Review this exact action.');
});

async function engineFixture(t,connection,{tools,complete,reviewMemory,reviewSkill}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-local-review-')),store=await new Store(directory).init(),memoryReviews=[],skillReviews=[];
  await store.mutate(state=>{state.connections=[connection];state.proposals=[];state.memory[state.bots[0].id]=[];Object.assign(state.bots[0],{connectionId:connection.id,approvalPolicy:'auto',tools});});
  let step=0;
  const engine=new NativeEngine(store,{runTimeout:15000,providers:{async complete(_connection,request){return complete(request,++step);},
    async reviewMemory(_connection,request){memoryReviews.push(request);return reviewMemory();},async reviewSkill(_connection,request){skillReviews.push(request);return reviewSkill();}}});
  await engine.recover();t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot=store.state.bots[0],run=async text=>{step=0;const admitted=await engine.start(bot.id,text);await engine.tasks.get(admitted.id);await engine.settleReviews();return store.state.runs[bot.id];};
  return {store,run,memoryReviews,skillReviews};
}
const memoryResult=()=>({text:'',toolCalls:[{id:'review',name:'memory_review_result',arguments:{changes:[],claims:[],reason:'Nothing durable.'}}]});
const skillResult=()=>({text:'',toolCalls:[{id:'review',name:'skill_review_result',arguments:{worthSaving:false,reason:'One-off work.',name:'',description:'',instructions:'',evidenceCallIds:[]}}]});
const workThenAnswer=(_request,step)=>step===1?{toolCalls:[{id:'w',name:'workspace_write',arguments:{path:'r.txt',content:'Report.'}}]}:step===2?{toolCalls:[{id:'r',name:'workspace_read',arguments:{path:'r.txt'}}]}:step===3?{toolCalls:[{id:'l',name:'workspace_list',arguments:{path:'.'}}]}:{text:'The report is ready.',toolCalls:[]};

test('memory and skill reviews on a local runtime use thinking off, 30 s limits and background priority',async t=>{
  const h=await engineFixture(t,localConnection(),{tools:['workspace','memory','skills'],complete:workThenAnswer,reviewMemory:memoryResult,reviewSkill:skillResult});
  const run=await h.run('Write and check a report.');
  assert.equal(run.status,'completed');assert.equal(h.memoryReviews.length,1);assert.equal(h.skillReviews.length,1);
  for(const request of [h.memoryReviews[0],h.skillReviews[0]]) {
    assert.equal(request.model,LOCAL_MODEL);assert.equal(request.reasoningEffort,'none');assert.ok(request.reasoningCapabilities.efforts.includes('none'));
    assert.equal(request.timeoutMs,30_000);assert.equal(request.priority,'background');
  }
});

test('memory and skill reviews on a cloud connection keep their request fields',async t=>{
  const h=await engineFixture(t,cloudConnection(),{tools:['workspace','memory','skills'],complete:workThenAnswer,reviewMemory:memoryResult,reviewSkill:skillResult});
  await h.run('Write and check a report.');
  assert.deepEqual(Object.keys(h.memoryReviews[0]),['model','messages','tools','signal','maxOutputTokens','reasoningCapabilities','reasoningEffort']);
  assert.deepEqual(Object.keys(h.skillReviews[0]),['model','messages','tools','signal','maxOutputTokens','reasoningCapabilities','reasoningEffort']);
});

// Invalid tool-argument JSON is rejected inside providers.complete() with failure code arguments_rejected.
const rejected=()=>markProviderFailure(new HttpError(502,'The model returned invalid tool arguments. No tool was executed.'),'arguments_rejected',{upstreamStatus:200});

test('invalid tool arguments: the same model request is sent once more, nothing is stored and no tool runs',async t=>{
  const requests=[];
  const h=await engineFixture(t,cloudConnection(),{tools:['workspace'],reviewMemory:memoryResult,reviewSkill:skillResult,complete:async(request,step)=>{
    requests.push(request);
    if(step===1){await request.onDelta('BROKEN-ATTEMPT text');throw rejected();}
    if(step===2)return {toolCalls:[{id:'list',name:'workspace_list',arguments:{path:'.'}}]};
    if(step===3)throw rejected();
    return {text:'Listed the workspace.',toolCalls:[]};
  }});
  const run=await h.run('List the workspace.');
  assert.equal(run.status,'completed');assert.equal(requests.length,4);
  // The re-sent request is the same request: same messages and tools.
  assert.deepEqual(requests[1].messages,requests[0].messages);assert.deepEqual(requests[1].tools.map(tool=>tool.name),requests[0].tools.map(tool=>tool.name));
  // A later step gets its own single re-send.
  assert.deepEqual(requests[3].messages,requests[2].messages);
  const conversation=JSON.stringify(h.store.state.conversations[run.botId || h.store.state.bots[0].id]),messages=JSON.stringify(h.store.state.messages);
  assert.doesNotMatch(conversation,/BROKEN-ATTEMPT/);assert.doesNotMatch(messages,/BROKEN-ATTEMPT/);
  assert.equal(run.events.filter(event=>event.type==='tool.started').length,1);
  assert.equal(run.events.filter(event=>event.type==='model.arguments_rejected').length,2);
});

test('a second invalid-arguments failure in the same step ends it as before',async t=>{
  let calls=0;
  const h=await engineFixture(t,cloudConnection(),{tools:['workspace'],reviewMemory:memoryResult,reviewSkill:skillResult,complete:async()=>{calls++;throw rejected();}});
  const run=await h.run('List the workspace.');
  assert.equal(run.status,'failed');assert.equal(calls,2);assert.match(run.error,/invalid tool arguments/);
  assert.equal(run.events.filter(event=>event.type==='tool.started').length,0);
  assert.equal((h.store.state.conversations[h.store.state.bots[0].id] || []).filter(row=>row.role==='assistant').length,0);
});
