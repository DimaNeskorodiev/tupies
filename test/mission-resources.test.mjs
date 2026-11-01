import test from 'node:test';
import assert from 'node:assert/strict';
import { createMissionResources, missionResourceSummary, reserveMissionResources, markMissionResourceDispatch, releaseMissionReservation, settleMissionResources, unknownMissionResources, recoverMissionResources, reviseMissionResourceLimits, setMissionResourceAdmission, reopenMissionResources, adoptMissionUsage, missionResourceReadiness, estimateMissionInference, missionInferenceUsage } from '../lib/mission-resources.mjs';

const sha='a'.repeat(64), receipt='b'.repeat(64);
const op=(id,estimate={},extra={})=>({operationId:id,botId:'lead',runId:'run1',kind:'inference',requestDigest:sha,estimate,pricing:{status:'known'},...extra});
const ref=id=>({operationId:id,requestDigest:sha});
const check=(code,dimension,reason)=>error=>{assert.equal(error.code,code);if(dimension)assert.equal(error.dimension,dimension);if(reason)assert.equal(error.reason,reason);return true;};
const dispatch=(ledger,id,estimate={},extra={})=>{reserveMissionResources(ledger,op(id,estimate,extra),{now:10});return markMissionResourceDispatch(ledger,ref(id),{now:11});};
const finish=(ledger,id,actual,extra={})=>settleMissionResources(ledger,{...ref(id),actual,receiptDigest:receipt,...extra},{now:12});
const price={source:'operator',currency:'USD',model:'fixture',version:'v1',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:2_000_000,cachedInputMicrosPerMillion:100_000};

test('one shared allowance rejects second participant before dispatch',()=>{
  const ledger=createMissionResources({limits:{tokens:100}});
  reserveMissionResources(ledger,op('first',{tokens:70}));
  assert.throws(()=>reserveMissionResources(ledger,op('child',{tokens:31},{botId:'child',runId:'childrun'})),check('mission_budget_exhausted','tokens'));
  assert.equal(ledger.operations.child,undefined);
  assert.equal(missionResourceSummary(ledger).reserved.tokens,70);
});

test('work cannot consume verification headroom; verification uses it without resetting costs',()=>{
  const ledger=createMissionResources({limits:{tokens:100,requests:3},finalReserve:{tokens:30,requests:1}});
  dispatch(ledger,'work',{tokens:70,requests:2});finish(ledger,'work',{tokens:70,requests:2});
  assert.throws(()=>reserveMissionResources(ledger,op('extra',{tokens:1,requests:0})),check('mission_budget_exhausted','tokens','verification_headroom'));
  dispatch(ledger,'review',{tokens:30,requests:1},{phase:'verification'});finish(ledger,'review',{tokens:30,requests:1});
  assert.equal(missionResourceSummary(ledger).settled.tokens,100);
  assert.throws(()=>reserveMissionResources(ledger,op('review2',{tokens:1,requests:0},{phase:'verification'})),check('mission_budget_exhausted','tokens'));
});

test('exact operation replay yields receipt, changed identity conflicts',()=>{
  const ledger=createMissionResources();const request=op('same',{requests:1});
  assert.equal(reserveMissionResources(ledger,request).admitted,true);
  assert.equal(reserveMissionResources(ledger,request).admitted,false);
  assert.equal(markMissionResourceDispatch(ledger,ref('same')).admitted,true);
  assert.equal(markMissionResourceDispatch(ledger,ref('same')).admitted,false);
  assert.throws(()=>reserveMissionResources(ledger,{...request,runId:'other'}),check('mission_resource_changed'));
});

test('release requires proven absence of dispatch, restart retains uncertain charges',()=>{
  const ledger=createMissionResources({limits:{requests:3}});
  reserveMissionResources(ledger,op('notstarted',{requests:1}));dispatch(ledger,'sent',{requests:2});
  assert.throws(()=>releaseMissionReservation(ledger,ref('sent')),check('mission_resource_unavailable',undefined,'dispatch_not_proven_absent'));
  const restored=JSON.parse(JSON.stringify(ledger));recoverMissionResources(restored);
  assert.equal(restored.operations.notstarted.status,'released');assert.equal(restored.operations.sent.status,'unknown');
  assert.equal(missionResourceSummary(restored).unknown.requests,2);
  reserveMissionResources(restored,op('last',{requests:1}));
  assert.throws(()=>reserveMissionResources(restored,op('beyond',{requests:1})),check('mission_budget_exhausted','requests'));
});

test('successful response with missing usage remains unknown and later verified receipt resolves restart uncertainty',()=>{
  const ledger=createMissionResources({limits:{tokens:100}});dispatch(ledger,'missing',{tokens:80});
  unknownMissionResources(ledger,{...ref('missing'),reason:'network_loss'});
  finish(ledger,'missing',{tokens:45});assert.equal(ledger.operations.missing.status,'settled');
  dispatch(ledger,'success',{tokens:20});finish(ledger,'success',{});
  const summary=missionResourceSummary(ledger);assert.equal(summary.settled.tokens,45);assert.equal(summary.unknown.tokens,20);
  assert.equal(ledger.operations.success.status,'unknown');
});

test('unknown zero-bound consumption is unbounded and prevents false remaining allowance',()=>{
  const ledger=createMissionResources();dispatch(ledger,'unknown',{tokens:0});finish(ledger,'unknown',{}, {unknownDimensions:['tokens']});
  reviseMissionResourceLimits(ledger,{limits:{tokens:100}},{expectedRevision:ledger.revision});
  assert.equal(missionResourceSummary(ledger).remaining.tokens,null);
  assert.throws(()=>reserveMissionResources(ledger,op('next',{tokens:1})),check('mission_resource_unavailable','tokens','unknown_prior_usage'));
});

test('settlement is immutable and measured overruns stop later admission',()=>{
  const ledger=createMissionResources({limits:{tokens:10}});dispatch(ledger,'over',{tokens:5});finish(ledger,'over',{tokens:12});
  assert.equal(missionResourceSummary(ledger).overrun.tokens,2);
  finish(ledger,'over',{tokens:12});
  assert.throws(()=>finish(ledger,'over',{tokens:5}),check('mission_resource_changed'));
  assert.throws(()=>reserveMissionResources(ledger,op('later',{tokens:0})),check('mission_budget_exhausted','tokens'));
});

test('owner CAS changes preserve costs and invalidate an undispatched admission',()=>{
  const ledger=createMissionResources({limits:{requests:5}});reserveMissionResources(ledger,op('wait',{requests:3}));const revision=ledger.revision;
  assert.throws(()=>reviseMissionResourceLimits(ledger,{limits:{requests:10}},{expectedRevision:revision-1}),check('mission_resource_changed'));
  assert.throws(()=>reviseMissionResourceLimits(ledger,{limits:{requests:10}}),check('mission_resource_invalid'));
  reviseMissionResourceLimits(ledger,{limits:{requests:2}},{expectedRevision:revision});
  assert.throws(()=>markMissionResourceDispatch(ledger,ref('wait')),check('mission_budget_exhausted','requests','limit_changed'));
  assert.equal(ledger.operations.wait.dispatchedAt,undefined);
});

test('pause, Stop, deadline and explicit owner reopening never reset liabilities',()=>{
  const ledger=createMissionResources({limits:{requests:2,deadlineAt:50},now:0});dispatch(ledger,'first',{requests:1});unknownMissionResources(ledger,ref('first'));
  setMissionResourceAdmission(ledger,'paused',{now:20});assert.throws(()=>reserveMissionResources(ledger,op('paused',{requests:1}),{now:21}),check('mission_resource_unavailable',undefined,'paused'));
  setMissionResourceAdmission(ledger,'stopped',{now:22});assert.throws(()=>setMissionResourceAdmission(ledger,'open'),check('mission_resource_unavailable',undefined,'stopped'));
  assert.throws(()=>reopenMissionResources(ledger),check('mission_resource_invalid'));
  reopenMissionResources(ledger,{expectedRevision:ledger.revision,now:25});assert.equal(missionResourceSummary(ledger,{now:25}).unknown.requests,1);
  reserveMissionResources(ledger,op('late',{requests:1}),{now:49});assert.throws(()=>markMissionResourceDispatch(ledger,ref('late'),{now:50}),check('mission_expired','deadlineAt'));
});

test('promotion imports exact prior usage and pending reservations once, without cap reset',()=>{
  const ledger=createMissionResources({limits:{requests:4}});const body={runId:'ordinary',usageDigest:sha,actual:{requests:2},reservations:[op('pending',{requests:1},{runId:'ordinary',dispatchedAt:1})]};
  assert.equal(adoptMissionUsage(ledger,body).adopted,true);assert.equal(adoptMissionUsage(ledger,body).adopted,false);
  assert.throws(()=>adoptMissionUsage(ledger,{...body,actual:{requests:1}}),check('mission_resource_changed'));
  recoverMissionResources(ledger);assert.equal(missionResourceSummary(ledger).committed.requests,3);
  reserveMissionResources(ledger,op('new',{requests:1}));assert.throws(()=>reserveMissionResources(ledger,op('over',{requests:1})),check('mission_budget_exhausted','requests'));
});

test('unknown subscription prices refuse only configured monetary dimensions',()=>{
  const unknown=op('subscription',{requests:1},{pricing:{status:'subscription'}});
  reserveMissionResources(createMissionResources({limits:{requests:1}}),unknown);
  assert.throws(()=>reserveMissionResources(createMissionResources({limits:{moneyMicros:100}}),unknown),check('mission_resource_unavailable','moneyMicros','unknown_price'));
  assert.equal(missionResourceReadiness({tool:'model',limits:{requests:1},pricing:{status:'subscription'}}).available,true);
  assert.equal(missionResourceReadiness({tool:'model',limits:{moneyMicros:1},pricing:{status:'subscription'}}).status,'unknown_price');
});

test('hidden fanout is unavailable only under dimensions that cannot be bounded; access remains separate',()=>{
  const args={tool:'scripts_run',currentGroups:['scripts'],requiredGroups:['scripts'],unavailableDimensions:['requests','tokens'],pricing:{status:'known'}};
  assert.equal(missionResourceReadiness({...args,limits:{toolCalls:2}}).available,true);
  assert.equal(missionResourceReadiness({...args,limits:{requests:2}}).status,'unsupported_bound');
  assert.equal(missionResourceReadiness({...args,currentGroups:[],limits:{}}).status,'needs_access');
  const ledger=createMissionResources({limits:{toolCalls:1}});reserveMissionResources(ledger,op('host',{toolCalls:1},{unavailableDimensions:['tokens','requests']}));
  assert.throws(()=>reserveMissionResources(createMissionResources({limits:{requests:1}}),op('host',{requests:1},{unavailableDimensions:['requests']})),check('mission_resource_unavailable','requests','unsupported_bound'));
});

test('constrained quantities require explicit estimates including known-zero',()=>{
  assert.throws(()=>reserveMissionResources(createMissionResources({limits:{toolCalls:1}}),op('omit',{})),check('mission_resource_unavailable','toolCalls','missing_estimate'));
  const ledger=createMissionResources({limits:{toolCalls:0}});reserveMissionResources(ledger,op('zero',{toolCalls:0}));
});

test('integer, NaN, negative and overflow guards leave accounting unchanged',()=>{
  for(const value of [-1,NaN,Infinity,0.1,Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>createMissionResources({limits:{tokens:value}}),check('mission_resource_invalid'));
    assert.throws(()=>reserveMissionResources(createMissionResources(),op('bad',{tokens:value})),check('mission_resource_invalid'));
  }
  const ledger=createMissionResources();dispatch(ledger,'max',{tokens:Number.MAX_SAFE_INTEGER});finish(ledger,'max',{tokens:Number.MAX_SAFE_INTEGER});const before=JSON.stringify(ledger);
  assert.throws(()=>reserveMissionResources(ledger,op('overflow',{tokens:1})),check('mission_resource_invalid'));assert.equal(JSON.stringify(ledger),before);
  assert.throws(()=>adoptMissionUsage(ledger,{runId:'overflow',usageDigest:sha,actual:{tokens:1}}),check('mission_resource_invalid'));assert.equal(JSON.stringify(ledger),before);
});

test('settlement aggregate overflow is rejected atomically',()=>{
  const ledger=createMissionResources();dispatch(ledger,'first',{tokens:0});dispatch(ledger,'second',{tokens:0});finish(ledger,'first',{tokens:Number.MAX_SAFE_INTEGER});const before=JSON.stringify(ledger);
  assert.throws(()=>finish(ledger,'second',{tokens:1}),check('mission_resource_invalid'));assert.equal(JSON.stringify(ledger),before);
});

test('price schedules are frozen, conservatively rounded and never presented as actual bills',()=>{
  const prepared=estimateMissionInference({model:'fixture',inputTokens:2,outputTokens:3,price,enforcedOutput:true});
  price.inputMicrosPerMillion=9_000_000;
  assert.equal(prepared.estimate.moneyMicros,8);assert.equal(prepared.pricing.schedule.inputMicrosPerMillion,1_000_000);
  const usage=missionInferenceUsage({input_tokens:2,output_tokens:3},{pricing:prepared.pricing});assert.equal(usage.actual.moneyMicros,8);assert.equal(usage.moneyBasis,'estimated');
  const tiny=estimateMissionInference({model:'fixture',inputTokens:1,outputTokens:0,price:{...price,inputMicrosPerMillion:1},enforcedOutput:true});assert.equal(tiny.estimate.moneyMicros,1);
  const ledger=createMissionResources();dispatch(ledger,'priced',prepared.estimate,prepared);finish(ledger,'priced',usage.actual,usage);
  assert.equal(missionResourceSummary(ledger).moneyBasis,'estimated_not_provider_bill');
  assert.throws(()=>estimateMissionInference({model:'other',inputTokens:1,outputTokens:1,price}),check('mission_resource_invalid'));
});

test('unenforced output ceiling cannot claim hard token or price bounds',()=>{
  const prepared=estimateMissionInference({model:'fixture',inputTokens:1,outputTokens:5,price});assert.equal(prepared.bounds,'estimated');
  assert.throws(()=>reserveMissionResources(createMissionResources({limits:{tokens:10}}),op('unbounded',prepared.estimate,prepared)),check('mission_resource_unavailable','tokens','unsupported_bound'));
  reserveMissionResources(createMissionResources(),op('allowed',prepared.estimate,prepared));
});

test('provider usage missing fields/cache rates stays unknown; protocol caches count correctly',()=>{
  assert.deepEqual(missionInferenceUsage({input_tokens:2}).unknownDimensions,['tokens','moneyMicros']);
  const prepared=estimateMissionInference({model:'fixture',inputTokens:10,outputTokens:5,price:{...price,cacheCreationMicrosPerMillion:2_000_000},enforcedOutput:true});
  const anthropic=missionInferenceUsage({input_tokens:2,output_tokens:3,cache_read_input_tokens:4,cache_creation_input_tokens:5},{protocol:'anthropic',pricing:prepared.pricing});assert.equal(anthropic.actual.tokens,14);
  const openai=missionInferenceUsage({prompt_tokens:10,completion_tokens:2,prompt_tokens_details:{cached_tokens:4}},{pricing:prepared.pricing});assert.equal(openai.actual.tokens,12);
  const absent=missionInferenceUsage({input_tokens:1,output_tokens:1,cache_creation_input_tokens:1},{protocol:'anthropic',pricing:{...prepared.pricing,schedule:{...prepared.pricing.schedule,cacheCreationMicrosPerMillion:undefined}}});assert.deepEqual(absent.unknownDimensions,['moneyMicros']);
  assert.throws(()=>missionInferenceUsage({input_tokens:1,output_tokens:1,input_tokens_details:{cached_tokens:2}}),check('mission_resource_invalid'));
});

test('unknown model cost is never masked by a known-zero local tool cost',()=>{
  const ledger=createMissionResources();dispatch(ledger,'model',{requests:1},{pricing:{status:'unknown'}});finish(ledger,'model',{requests:1});
  dispatch(ledger,'local',{moneyMicros:0,toolCalls:1});finish(ledger,'local',{moneyMicros:0,toolCalls:1});
  assert.equal(missionResourceSummary(ledger).moneyBasis,'unavailable');assert.deepEqual(missionResourceSummary(ledger).unknownUnbounded,['moneyMicros']);
});

test('money admission covers the highest configured cache rate without assuming a cache hit',()=>{
  const prepared=estimateMissionInference({model:'fixture',inputTokens:10,outputTokens:5,cachedInputTokens:10,enforcedOutput:true,price:{source:'operator',currency:'USD',model:'fixture',version:'cache-v1',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000,cachedInputMicrosPerMillion:100_000,cacheCreationMicrosPerMillion:2_000_000}});
  assert.equal(prepared.estimate.moneyMicros,25);assert.equal(prepared.pricing.schedule.inputMicrosPerMillion,1_000_000);
});
