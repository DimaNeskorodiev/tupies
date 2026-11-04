import test from 'node:test';
import assert from 'node:assert/strict';
import { MissionResourceRuntime } from '../lib/mission-resource-runtime.mjs';
import { createMissionResources, missionResourceSummary, recoverMissionResources, reviseMissionResourceLimits } from '../lib/mission-resources.mjs';

function fixture({limits={},finalReserve={},complete=async()=>({text:'fixture',usage:{input_tokens:2,output_tokens:3}})}={}){
  const controller=new AbortController(),context={bot:{id:'lead'},runId:'run',controller,inference:{model:'fixture'}},connection={id:'connection',type:'openai',contextWindow:4000,models:[{id:'fixture',contextWindow:4000,contextSource:'provider'}],maxOutputTokens:256};
  const mission={id:'mission',contractVersion:1,ownerEngineId:'local',state:'running',resourceLedger:createMissionResources({limits,finalReserve})};
  const store={state:{missions:{mission},runs:{lead:{id:'run',missionId:'mission',missionContractVersion:1}}},queue:Promise.resolve(),async mutate(fn){const next=this.queue.then(async()=>{const previous=structuredClone(this.state);try{return await fn(this.state);}catch(error){this.state=previous;throw error;}});this.queue=next.catch(()=>{});return next;}};
  const engine={store,providers:{options:{inferenceTimeout:1000},complete},current(ctx){const run=this.store.state.runs[ctx.bot.id];return run?.id===ctx.runId?run:null;},assertRunning(ctx){if(ctx.controller.signal.aborted)throw ctx.controller.signal.reason;if(!this.current(ctx))throw new Error('replaced');if(this.store.state.missions[this.current(ctx).missionId]?.stopRequested)throw new Error('stopped');},missions:{get(id){const value=store.state.missions[id];assert.equal(value.ownerEngineId,'local');return value;},touch(value){value.revision=(value.revision || 0)+1;}}};
  const runtime=new MissionResourceRuntime(engine);return {engine,store,runtime,context,connection,mission:()=>store.state.missions.mission,request:{model:'fixture',messages:[{role:'user',content:'synthetic fixture'}]}};
}
const code=expected=>error=>{assert.equal(error.code,expected);return true;};

test('real adapter reserves before a synthetic provider and settles reported usage',async()=>{
  let f,calls=0;f=fixture({limits:{requests:1,toolCalls:0},complete:async()=>{calls++;assert.equal(missionResourceSummary(f.mission().resourceLedger).reserved.requests,1);assert.equal(Object.values(f.mission().resourceLedger.operations)[0].dispatchedAt!==undefined,true);return {text:'done',usage:{input_tokens:2,output_tokens:3}};}});
  const result=await f.runtime.infer(f.context,f.connection,f.request);assert.equal(result.text,'done');assert.equal(calls,1);
  const summary=missionResourceSummary(f.mission().resourceLedger);assert.equal(summary.settled.tokens,5);assert.equal(summary.settled.requests,1);assert.equal(summary.remaining.requests,0);assert.equal(summary.moneyBasis,'unavailable');
  await assert.rejects(f.runtime.infer(f.context,f.connection,f.request),code('mission_budget_exhausted'));assert.equal(calls,1);
});

test('ordinary provider calls retain ordinary behavior with no invented Mission ownership',async()=>{
  let calls=0;const f=fixture({complete:async()=>{calls++;return {text:'ordinary',usage:{}};}});delete f.store.state.runs.lead.missionId;
  await f.runtime.infer(f.context,f.connection,f.request);assert.equal(calls,1);assert.deepEqual(f.mission().resourceLedger.operations,{});
});

test('concurrent coordinator and child requests share one atomic predispatch allowance',async()=>{
  let calls=0,release;const held=new Promise(resolve=>release=resolve),f=fixture({limits:{requests:1},complete:async()=>{calls++;await held;return {usage:{input_tokens:1,output_tokens:1}};}});
  const child={...f.context,bot:{id:'child'},runId:'childrun'};f.store.state.runs.child={id:'childrun',missionId:'mission',missionContractVersion:1};
  const results=Promise.allSettled([f.runtime.infer(f.context,f.connection,f.request),f.runtime.infer(child,f.connection,f.request)]);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);release();const outcomes=await results;
  assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);assert.equal(outcomes.find(row=>row.status==='rejected').reason.code,'mission_budget_exhausted');
});

test('provider failure and success without usage retain unknown liabilities across recovery',async()=>{
  let calls=0;const f=fixture({limits:{requests:2,tokens:9000},complete:async()=>{calls++;if(calls===1)throw new Error('synthetic transport loss');return {text:'success without usage'};}});
  await assert.rejects(f.runtime.infer(f.context,f.connection,f.request),/transport loss/);
  recoverMissionResources(f.mission().resourceLedger);assert.equal(missionResourceSummary(f.mission().resourceLedger).unknown.requests,1);
  await f.runtime.infer(f.context,f.connection,f.request);const summary=missionResourceSummary(f.mission().resourceLedger);
  assert.equal(summary.unknownOperations,2);assert.equal(summary.unknown.tokens,8512);assert.equal(summary.committed.requests,2);
  await assert.rejects(f.runtime.infer(f.context,f.connection,f.request),code('mission_budget_exhausted'));assert.equal(calls,2);
});

test('verification phase can consume headroom denied to a normal model turn',async()=>{
  let calls=0;const f=fixture({limits:{requests:1},finalReserve:{requests:1},complete:async()=>{calls++;return {usage:{input_tokens:1,output_tokens:1}};}});
  await assert.rejects(f.runtime.infer(f.context,f.connection,f.request),code('mission_budget_exhausted'));
  await f.runtime.infer(f.context,f.connection,f.request,{kind:'mission_review',phase:'verification'});assert.equal(calls,1);
});

test('Stop/pause/stale contract before actual dispatch never calls the provider',async()=>{
  for(const state of ['stop','pause','contract']){
    let calls=0;const f=fixture({complete:async()=>{calls++;return {usage:{}};}});let commits=0;const mutate=f.store.mutate.bind(f.store);
    f.store.mutate=fn=>mutate(value=>{commits++;if(commits===3){if(state==='stop')value.missions.mission.stopRequested=true;else if(state==='pause')value.missions.mission.pauseRequested=true;else value.missions.mission.contractVersion++;}return fn(value);});
    await assert.rejects(f.runtime.infer(f.context,f.connection,f.request));assert.equal(calls,0);
    assert.equal(Object.values(f.mission().resourceLedger.operations)[0].status,'released');
  }
});

test('owner limit reduction during reservation blocks the later dispatch',async()=>{
  let calls=0;const f=fixture({limits:{requests:2},complete:async()=>{calls++;return {usage:{}};}}),mutate=f.store.mutate.bind(f.store);let commits=0;
  f.store.mutate=fn=>mutate(state=>{if(++commits===3){const ledger=state.missions.mission.resourceLedger;reviseMissionResourceLimits(ledger,{limits:{requests:0}},{expectedRevision:ledger.revision});}return fn(state);});
  await assert.rejects(f.runtime.infer(f.context,f.connection,f.request),code('mission_budget_exhausted'));assert.equal(calls,0);
});

test('unknown model window, subscription output and money prices fail closed only for relevant caps',async()=>{
  let calls=0;const f=fixture({limits:{tokens:10000},complete:async()=>{calls++;return {usage:{}};}});
  await assert.rejects(f.runtime.infer(f.context,{...f.connection,type:'chatgpt'},f.request),code('mission_resource_unavailable'));
  await assert.rejects(f.runtime.infer(f.context,{...f.connection,type:'synthetic',contextWindow:undefined},f.request),code('mission_resource_unavailable'));
  assert.equal(calls,0);
  const g=fixture({limits:{moneyMicros:10000}});await assert.rejects(g.runtime.infer(g.context,g.connection,g.request),code('mission_resource_unavailable'));
});

test('local tools charge one distinct call and elapsed wall time, exact receipt cannot execute again',async()=>{
  let calls=0;const f=fixture({limits:{toolCalls:1,requests:0,moneyMicros:0,tokens:0}}),call={id:'call',name:'workspace_write',arguments:{path:'synthetic.txt',content:'synthetic'}};
  f.runtime.monotonic=(()=>{let time=0;return()=>time+=4;})();
  const invoke=async({signal})=>{assert.equal(signal.aborted,false);calls++;return {written:true};};
  await f.runtime.tool(f.context,call,invoke);const summary=missionResourceSummary(f.mission().resourceLedger);
  assert.equal(summary.settled.toolCalls,1);assert.equal(summary.settled.requests,0);assert.equal(summary.settled.computeMs,4);
  await assert.rejects(f.runtime.tool(f.context,call,invoke),/already has a receipt/);assert.equal(calls,1);
});

test('host/unknown/network tools refuse uninstrumented dimensions before invocation without a global ban',async()=>{
  for(const dimension of ['tokens','moneyMicros','requests','computeMs']){
    let calls=0;const f=fixture({limits:{[dimension]:100}});await assert.rejects(f.runtime.tool(f.context,{id:'host',name:'scripts_run',arguments:{}},async()=>{calls++;}),code('mission_resource_unavailable'));assert.equal(calls,0);
  }
  let calls=0;const f=fixture({limits:{toolCalls:1}});await f.runtime.tool(f.context,{id:'host',name:'scripts_run',arguments:{}},async()=>{calls++;return {exitCode:0};});assert.equal(calls,1);
  assert.equal(missionResourceSummary(f.mission().resourceLedger).unknownOperations,1);
  assert.equal(f.runtime.readiness(f.context,{name:'scripts_run'}).available,true);
});

test('document bounded wall reservation is enforced and signal is forwarded without detaching work',async()=>{
  let calls=0;const f=fixture({limits:{computeMs:24999}});await assert.rejects(f.runtime.tool(f.context,{id:'doc',name:'documents_create',arguments:{}},async()=>{calls++;}),code('mission_budget_exhausted'));assert.equal(calls,0);
  const g=fixture({limits:{requests:1,computeMs:10},complete:async(connection,{signal})=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve({usage:{}}),1000);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});})});g.engine.providers.options.inferenceTimeout=10;
  await assert.rejects(g.runtime.infer(g.context,g.connection,g.request),error=>{assert.equal(error.name,'TimeoutError');return true;});
  assert.equal(missionResourceSummary(g.mission().resourceLedger).unknown.requests,1);
});

test('memory review uses the same ledger with its exact supported provider method',async()=>{
  let ordinary=0,review=0;const f=fixture({limits:{requests:1},complete:async()=>{ordinary++;return {usage:{}};}});
  f.engine.providers.reviewMemory=async()=>{review++;return {usage:{input_tokens:1,output_tokens:1}};};
  await f.runtime.infer(f.context,f.connection,f.request,{kind:'memory_review',providerMethod:'reviewMemory'});
  assert.equal(ordinary,0);assert.equal(review,1);assert.equal(missionResourceSummary(f.mission().resourceLedger).settled.requests,1);
  await assert.rejects(f.runtime.infer(f.context,f.connection,f.request,{providerMethod:'logout'}),/supported internal inference method/);
});

test('in-flight cancellation records complete returned usage but does not return a successful result',async()=>{
  let f;f=fixture({complete:async()=>{f.context.controller.abort(Object.assign(new Error('owner stopped'),{name:'AbortError'}));return {usage:{input_tokens:2,output_tokens:1}};}});
  await assert.rejects(f.runtime.infer(f.context,f.connection,f.request),/owner stopped/);
  assert.equal(missionResourceSummary(f.mission().resourceLedger).settled.tokens,3);
});

test('trusted operator rates are pinned for dispatch and remain modeled estimates',async()=>{
  const schedule={source:'operator',currency:'USD',version:'v1',model:'fixture',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000};let f;
  f=fixture({limits:{moneyMicros:5000},complete:async()=>{assert.equal(Object.values(f.mission().resourceLedger.operations)[0].pricing.version,'v1');schedule.version='v2';schedule.inputMicrosPerMillion=100_000_000;return {usage:{input_tokens:2,output_tokens:3}};}});
  f.runtime.priceFor=()=>schedule;await f.runtime.infer(f.context,f.connection,f.request);
  const summary=missionResourceSummary(f.mission().resourceLedger);assert.equal(summary.settled.moneyMicros,5);assert.equal(summary.moneyBasis,'estimated_not_provider_bill');
  assert.equal(Object.values(f.mission().resourceLedger.operations)[0].pricing.schedule.inputMicrosPerMillion,1_000_000);
});

test('in-flight deadline produces typed expiry and retains possible dispatched consumption',async()=>{
  let now=Date.now();const f=fixture({limits:{deadlineAt:now+10},complete:async(connection,{signal})=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve({usage:{}}),1000);signal.addEventListener('abort',()=>{now+=20;clearTimeout(timer);reject(signal.reason);},{once:true});})});
  f.runtime.clock=()=>now;await assert.rejects(f.runtime.infer(f.context,f.connection,f.request),code('mission_expired'));
  assert.equal(missionResourceSummary(f.mission().resourceLedger).unknown.requests,1);
});

test('readiness for a queued or settled Mission uses that exact Mission limits rather than a later ordinary run',()=>{
  const f=fixture({limits:{requests:2}});delete f.store.state.runs.lead.missionId;
  assert.equal(f.runtime.readiness(f.context,{name:'browser_navigate'},{missionId:'mission'}).status,'unsupported_bound');
  assert.equal(f.runtime.readiness(f.context,{name:'workspace_read'},{missionId:'mission'}).available,true);
});

test('provider dispatch carries explicit frozen model and output ceiling even when caller omitted them',async()=>{
  let seen;const f=fixture({complete:async(connection,request)=>{seen=request;return {usage:{input_tokens:1,output_tokens:1}};}});
  await f.runtime.infer(f.context,f.connection,{messages:f.request.messages});assert.equal(seen.model,'fixture');assert.equal(seen.maxOutputTokens,256);
});

test('in-flight ordinary request promotes its durable journal exactly once and settles the Mission ledger',async()=>{
  let release,entered;const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
  const f=fixture({complete:async()=>{entered();await held;return {usage:{input_tokens:10,output_tokens:2}};}});delete f.store.state.runs.lead.missionId;
  const completion=f.runtime.infer(f.context,f.connection,f.request);await started;
  const journal=f.store.state.runs.lead.resourceJournal,record=Object.values(journal.operations)[0];assert.equal(record.status,'reserved');assert.equal(record.dispatchedAt!==undefined,true);
  await f.store.mutate(()=>{f.mission().resourceLedger=structuredClone(journal);f.store.state.runs.lead.missionId='mission';});
  release();await completion;const summary=missionResourceSummary(f.mission().resourceLedger);
  assert.equal(summary.settled.tokens,12);assert.equal(summary.settled.requests,1);assert.equal(summary.reserved.requests,0);assert.equal(Object.values(f.mission().resourceLedger.operations).length,1);
});

test('ordinary tool observations never grant replay authority or impose Mission tool limits',async()=>{
  const f=fixture({limits:{toolCalls:0}});delete f.store.state.runs.lead.missionId;let invoked=0;
  const call={id:'same',name:'workspace_read',arguments:{path:'synthetic.txt'}};await f.runtime.tool(f.context,call,async()=>{invoked++;return {};});await f.runtime.tool(f.context,call,async()=>{invoked++;return {};});
  assert.equal(invoked,2);assert.equal(missionResourceSummary(f.store.state.runs.lead.resourceJournal).settled.toolCalls,2);assert.equal(Object.keys(f.mission().resourceLedger.operations).length,0);
});

test('provider destination change between reservation and dispatch is refused',async()=>{
  let calls=0;const f=fixture({complete:async()=>{calls++;return {usage:{}};}});f.store.state.connections=[{...f.connection}];let commits=0;const mutate=f.store.mutate.bind(f.store);
  f.store.mutate=fn=>mutate(state=>{if(++commits===3)state.connections[0].baseUrl='https://different.invalid';return fn(state);});
  await assert.rejects(f.runtime.infer(f.context,f.connection,f.request),error=>{assert.equal(error.reason,'provider_changed');return true;});assert.equal(calls,0);
});

test('after approval recheck refuses a newly constrained hidden-fanout dimension before actual action',async()=>{
  const f=fixture();let invoked=0;
  await assert.rejects(f.runtime.tool(f.context,{id:'host',name:'shell_run',arguments:{}},async({recheck})=>{
    await f.store.mutate(()=>{const ledger=f.mission().resourceLedger;reviseMissionResourceLimits(ledger,{limits:{requests:1}},{expectedRevision:ledger.revision});});
    recheck();invoked++;return {exitCode:0};
  }),code('mission_resource_unavailable'));assert.equal(invoked,0);assert.equal(missionResourceSummary(f.mission().resourceLedger).unknownOperations,1);
});

test('owner window override and family guesses cannot replace an authoritative provider input bound',async()=>{
  const f=fixture({limits:{tokens:5000}});let dispatched=false;f.engine.providers.complete=async()=>{dispatched=true;return {usage:{input_tokens:1,output_tokens:1}};};
  await assert.rejects(f.runtime.infer(f.context,{...f.connection,models:[{id:'fixture',contextWindow:16000,contextSource:'provider'}]},f.request),code('mission_budget_exhausted'));assert.equal(dispatched,false);
  await assert.rejects(f.runtime.infer(f.context,{...f.connection,models:undefined},f.request),code('mission_resource_unavailable'));assert.equal(dispatched,false);
});

test('all calls in a run retain the first price snapshot while a new run may choose a new schedule',async()=>{
  const first={source:'operator',currency:'USD',version:'first',model:'fixture',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000},second={...first,version:'second',inputMicrosPerMillion:9_000_000};
  const f=fixture();let selected=first;f.runtime.priceFor=()=>selected;
  await f.runtime.infer(f.context,f.connection,f.request);selected=second;await f.runtime.infer(f.context,f.connection,f.request);
  const oldOps=Object.values(f.mission().resourceLedger.operations);assert.deepEqual(oldOps.map(op=>op.pricing.version),['first','first']);assert.deepEqual(oldOps.map(op=>op.actual.moneyMicros),[5,5]);
  f.store.state.runs.lead={id:'next',missionId:'mission',missionContractVersion:1};const next={...f.context,runId:'next'};
  await f.runtime.infer(next,f.connection,f.request);assert.equal(Object.values(f.mission().resourceLedger.operations).at(-1).pricing.version,'second');
});

test('unknown per-run price snapshot cannot silently gain money authority on a later call',async()=>{
  const f=fixture();await f.runtime.infer(f.context,f.connection,f.request);f.runtime.priceFor=()=>({source:'operator',currency:'USD',version:'later',model:'fixture',inputMicrosPerMillion:1,outputMicrosPerMillion:1});
  await f.runtime.infer(f.context,f.connection,f.request);assert.deepEqual(Object.values(f.mission().resourceLedger.operations).map(op=>op.pricing.status),['unknown','unknown']);
});

test('Anthropic money cap requires explicit cache read and creation rates',async()=>{
  const f=fixture({limits:{moneyMicros:10000}});f.runtime.priceFor=()=>({source:'operator',currency:'USD',version:'partial',model:'fixture',inputMicrosPerMillion:1,outputMicrosPerMillion:1});
  await assert.rejects(f.runtime.infer(f.context,{...f.connection,type:'anthropic'},f.request),error=>{assert.equal(error.dimension,'moneyMicros');assert.equal(error.reason,'unsupported_bound');return true;});
});

test('owner-wait monotonic duration is excluded from active charge without moving absolute Mission deadline',async()=>{
  const f=fixture({limits:{deadlineAt:5000}});let now=0;f.runtime.monotonic=()=>now;f.runtime.clock=()=>100;
  await f.runtime.tool(f.context,{id:'question',name:'ask_user',arguments:{}},async()=>{now=10;f.context.resourceWaitStartedAt=now;now=1010;f.context.resourceWaitMs=1000;delete f.context.resourceWaitStartedAt;now=1020;return {answered:true};});
  assert.equal(missionResourceSummary(f.mission().resourceLedger,{now:100}).settled.computeMs,20);assert.equal(f.mission().resourceLedger.limits.deadlineAt,5000);
});

test('failed owner wait excludes still-active waiting time while retaining actual attempted tool charge',async()=>{
  const f=fixture();let now=0;f.runtime.monotonic=()=>now;
  await assert.rejects(f.runtime.tool(f.context,{id:'question',name:'ask_user',arguments:{}},async()=>{now=5;f.context.resourceWaitStartedAt=now;now=1005;throw new Error('owner wait canceled');}),/owner wait canceled/);
  const summary=missionResourceSummary(f.mission().resourceLedger);assert.equal(summary.settled.computeMs,5);assert.equal(summary.settled.toolCalls,1);
});

test('ChatGPT request cap refuses hidden OAuth renewal while uncapped request totals remain honestly unknown',async()=>{
  const f=fixture({limits:{requests:2}});await assert.rejects(f.runtime.infer(f.context,{...f.connection,type:'chatgpt'},f.request),error=>{assert.equal(error.reason,'oauth_renewal_fanout');assert.match(error.message,/renewal/);return true;});
  const g=fixture();await g.runtime.infer(g.context,{...g.connection,type:'chatgpt'},g.request);const summary=missionResourceSummary(g.mission().resourceLedger);assert.equal(summary.settled.requests,0);assert.ok(summary.unknownUnbounded.includes('requests'));
});

test('effort counts actual Engine model attempts for subscription calls without pretending to cap billing',async()=>{
  const {createMissionEffort,missionEffortSummary}=await import('../lib/mission-effort.mjs');let calls=0;
  const f=fixture({complete:async()=>{calls++;if(calls===1)throw new Error('transport lost');return {text:'done'};}});
  f.mission().effort=createMissionEffort('low');f.mission().leadBotId='lead';
  await assert.rejects(f.runtime.infer(f.context,{...f.connection,type:'chatgpt'},f.request),/transport lost/);
  await f.runtime.infer(f.context,{...f.connection,type:'chatgpt'},f.request);
  const value=missionEffortSummary(f.mission());assert.equal(value.used.modelCalls,2);assert.ok(value.used.estimatedTokens>0);assert.equal(value.tokenBasis,'reported_or_local_estimate');assert.deepEqual(f.mission().resourceLedger.limits,{});
});

test('effort reserves globally before concurrent coordinator and child requests and retains final headroom',async()=>{
  const {createMissionEffort,missionEffortSummary}=await import('../lib/mission-effort.mjs');let calls=0,release;const held=new Promise(resolve=>release=resolve);
  const f=fixture({complete:async()=>{calls++;await held;return {usage:{input_tokens:1,output_tokens:1}};}});f.mission().leadBotId='lead';f.mission().effort=createMissionEffort('low');f.mission().effort.limits.modelCalls=3;
  f.store.state.runs.child={id:'childrun',missionId:'mission',missionContractVersion:1};const child={...f.context,bot:{id:'child'},runId:'childrun',delegation:{depth:1}};
  const results=Promise.allSettled([f.runtime.infer(f.context,f.connection,f.request),f.runtime.infer(child,f.connection,f.request)]);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(missionEffortSummary(f.mission()).reserved.modelCalls,1);release();const outcomes=await results;assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);assert.equal(calls,1);
  await assert.rejects(f.runtime.infer(f.context,f.connection,f.request),code('mission_effort_closing'));
  await f.runtime.infer(f.context,f.connection,f.request); // coordinator synthesis
  await f.runtime.infer(f.context,f.connection,f.request,{kind:'mission_review',phase:'verification'});
  assert.equal(calls,3);assert.equal(missionEffortSummary(f.mission()).used.modelCalls,3);
  await assert.rejects(f.runtime.infer(f.context,f.connection,f.request,{kind:'mission_review',phase:'verification'}),code('mission_effort_exhausted'));assert.equal(calls,3);
});

test('lower effort between reservation and dispatch blocks the request without consuming a model call',async()=>{
  const {createMissionEffort,missionEffortSummary}=await import('../lib/mission-effort.mjs');let calls=0;
  const f=fixture({complete:async()=>{calls++;return {text:'must not run'};}});f.mission().effort=createMissionEffort('high');f.mission().leadBotId='lead';
  const mutate=f.store.mutate.bind(f.store);let commits=0;f.store.mutate=fn=>mutate(state=>{if(++commits===3)state.missions.mission.effort.limits.modelCalls=0;return fn(state);});
  await assert.rejects(f.runtime.infer(f.context,f.connection,f.request));assert.equal(calls,0);assert.equal(missionEffortSummary(f.mission()).committed.modelCalls,0);
});

test('effort charges browser and web tools without enabling unsupported hard resource limits',async()=>{
  const {createMissionEffort,missionEffortSummary}=await import('../lib/mission-effort.mjs');const f=fixture();f.mission().effort=createMissionEffort('low');
  await f.runtime.tool(f.context,{id:'web',name:'http_fetch',arguments:{}},async()=>({status:200}));assert.equal(missionEffortSummary(f.mission()).used.toolCalls,1);
  f.mission().effort.finishing=true;
  await assert.rejects(f.runtime.tool(f.context,{id:'more_web',name:'http_fetch',arguments:{}},async()=>{throw new Error('must not dispatch');}),code('mission_effort_finishing'));
});

test('mixed parallel read failures drain every call and preserve a non-budget error in either order',async()=>{
  const { NativeEngine }=await import('../lib/engine.mjs');
  const budget=Object.assign(new Error('shared effort exhausted'),{code:'mission_effort_exhausted'}),failure=Object.assign(new Error('provider identity changed'),{code:'mission_resource_unavailable'});
  for(const errors of [[budget,failure],[failure,budget]]){
    let settled=0;
    const engine={checkpointRoutine:async()=>{},executeTool:async(context,call)=>{await new Promise(resolve=>setImmediate(resolve));settled++;throw errors[call.id];},assertRunning:()=>assert.equal(settled,2)};
    const calls=errors.map((_,id)=>({id,name:'workspace_read',arguments:{path:'synthetic.txt'}}));
    await assert.rejects(NativeEngine.prototype.executeToolBatch.call(engine,{},calls),error=>error===failure);
    assert.equal(settled,2);
  }
});
