import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { missionResourceSummary } from '../lib/mission-resources.mjs';
import { loadMissionPricing } from '../lib/mission-pricing.mjs';

const BOT='bot_atlas',delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const answer=(text,usage={input_tokens:10,output_tokens:2})=>({text,toolCalls:[],usage});
const call=(id,name,args)=>({id,name,arguments:args});
const tools=(...toolCalls)=>({...answer(''),toolCalls});
async function until(predicate){const end=Date.now()+12000;while(Date.now()<end){const value=predicate();if(value)return value;await delay(5);}throw new Error('Resource Engine fixture timed out.');}
function context(request){const line=request.turnContext?.split('\n').find(value=>value.startsWith('Mission context '));assert.ok(line);return JSON.parse(line.slice(line.indexOf('{')));}
function review(request,usage){const payload=JSON.parse(request.messages[1].content);return answer(JSON.stringify({coveragePassed:true,requirements:payload.contract.requirements.map(item=>({id:item.id,passed:true,reason:'Exact synthetic phrase accepted.'})),reason:'Synthetic rubric assessment.'}),usage);}
async function fixture(t,author,{reviewer=review,policy='balanced',engineOptions={},pricingFile}={}){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-mission-resource-engine-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',name:'Synthetic provider',defaultModel:'mission-model',maxOutputTokens:256,models:[{id:'mission-model',contextWindow:128000,contextSource:'provider'}]});for(const bot of state.bots)Object.assign(bot,{connectionId:'fixture',tools:['workspace','delegation'],approvalPolicy:policy});});
  const requests=[],reviews=[],engines=[];let turns=0;
  const provider={async complete(connection,request){if(request.messages[0]?.content?.includes('You independently assess an agent result')){reviews.push(request);return reviewer(request);}requests.push(request);return author(request,++turns,connection);}};
  const pricing=await loadMissionPricing({file:pricingFile,dataDir:directory,state:store.state});
  const options={maxTurns:12,runTimeout:10000,retryDelay:1,providers:provider,...(pricing.configured?{missionPriceFor:pricing.priceFor}:{}),...engineOptions};
  const engine=new NativeEngine(store,options);engines.push(engine);await engine.recover();
  t.after(async()=>{for(const item of engines)await item.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const settled=async(bot=BOT)=>{await until(()=>store.state.runs[bot]&&!isActive(store.state.runs[bot]));await Promise.all([...engine.tasks.values()]);return store.state.runs[bot];};
  const create=(limits={})=>engine.missions.create({leadBotId:BOT,goal:'Return the synthetic checked fixture phrase.',requirements:['Return the synthetic checked fixture phrase.'],clientMessageId:'resource_'+Math.random().toString(36).slice(2),limits});
  return {directory,store,engine,engines,provider,options,requests,reviews,settled,create};
}

test('NativeEngine charges author and separate reviewer under supported authoritative token/money/request caps',async t=>{
  const schedule={source:'operator',currency:'USD',model:'mission-model',version:'synthetic-v1',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000};
  const h=await fixture(t,()=>answer('The synthetic checked fixture phrase.'),{engineOptions:{missionPriceFor:()=>schedule}});
  const created=await h.create({tokens:500000,moneyMicros:500000,requests:2});const run=await h.settled(),mission=h.store.state.missions[created.mission.id],summary=missionResourceSummary(mission.resourceLedger);
  assert.equal(run.status,'completed',run.error);assert.equal(mission.outcome,'achieved',mission.reason);assert.equal(h.requests.length,1);assert.equal(h.reviews.length,1);
  assert.equal(summary.settled.requests,2);assert.equal(summary.settled.tokens,24);assert.equal(summary.settled.moneyMicros,24);assert.equal(summary.moneyBasis,'estimated_not_provider_bill');
  assert.equal(h.requests[0].maxOutputTokens,256);assert.equal(h.reviews[0].maxOutputTokens,256);assert.ok(Object.values(mission.resourceLedger.operations).some(op=>op.phase==='verification'));
});

test('new capped Mission protects final review before author dispatch',async t=>{
  const h=await fixture(t,()=>answer('Must not be called.'));const created=await h.create({requests:1});await h.settled();const mission=h.store.state.missions[created.mission.id];
  assert.equal(h.requests.length,0);assert.equal(h.reviews.length,0);assert.equal(mission.resourceLedger.finalReserve.requests,1);assert.equal(mission.outcome,'budget_exhausted');assert.notEqual(mission.verification?.progress?.percent,100);
});

test('ordinary in-flight request promotion retains one exact journal and same run without free usage',async t=>{
  let release,entered;const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
  const h=await fixture(t,async(request,turn)=>{
    if(turn===1){entered();await held;return answer('Retained before promotion.');}
    if(turn===2){const data=context(request);return tools(call('criteria','mission_contract_set',{requirements:[{id:'phrase',text:data.goal,source:{ownerId:data.ownerMessageId,quote:data.goal},checker:{kind:'rubric',rubric:'The result contains the synthetic checked fixture phrase.',rubricVersion:'fixture-v1'}}]}));}
    return answer('The synthetic checked fixture phrase.');
  });
  const run=await h.engine.start(BOT,'Run a Mission returning the synthetic checked fixture phrase.');await started;
  const journal=h.store.state.runs[BOT].resourceJournal,first=Object.values(journal.operations).find(op=>op.kind==='model');assert.equal(first.status,'reserved');assert.ok(first.dispatchedAt);
  const promoted=await h.engine.missions.adopt({botId:BOT,runId:run.id});release();await h.settled();const mission=h.store.state.missions[promoted.mission.id],summary=missionResourceSummary(mission.resourceLedger);
  assert.equal(h.store.state.runs[BOT].id,run.id);assert.equal(mission.episodeRefs.length,1);assert.equal(mission.outcome,'achieved',mission.reason);
  assert.equal(Object.values(mission.resourceLedger.operations).filter(op=>op.operationId===first.operationId).length,1);assert.equal(mission.resourceLedger.operations[first.operationId].status,'unknown');
  assert.equal(mission.resourceLedger.operations[first.operationId].actual.tokens,12);assert.equal(summary.settled.requests,h.requests.length+h.reviews.length);assert.equal(Object.keys(mission.resourceLedger.adoptions).length,1);
});

test('delegated child spends the same request allowance and cannot bypass protected review budget',async t=>{
  let childCalls=0;const h=await fixture(t,(request)=>{
    if(!request.turnContext?.includes('Mission context ')){childCalls++;return answer('Child result.');}
    return tools(call('child','delegate_task',{botId:'bot_nova',task:'Return the synthetic checked fixture phrase.'}));
  });
  const created=await h.create({requests:2});await h.settled();const mission=h.store.state.missions[created.mission.id];
  assert.equal(childCalls,0);assert.equal(h.requests.length,1);assert.notEqual(mission.outcome,'achieved');assert.equal(mission.outcome,'budget_exhausted');assert.equal(missionResourceSummary(mission.resourceLedger).committed.requests,1);
  assert.ok(Object.values(h.store.state.runs).some(run=>run.botId==='bot_nova'&&run.missionId===mission.id));
});

test('lost provider receipt remains unknown after restart/retry and never refunds the original request',async t=>{
  const h=await fixture(t,()=>{throw new Error('Synthetic transport receipt lost.');});const created=await h.create({requests:2});await h.settled();let mission=h.store.state.missions[created.mission.id];
  assert.equal(h.requests.length,1);assert.equal(missionResourceSummary(mission.resourceLedger).unknown.requests,1);
  await h.engine.close();const restarted=new NativeEngine(h.store,h.options);h.engines.push(restarted);await restarted.recover();mission=h.store.state.missions[mission.id];
  assert.equal(missionResourceSummary(mission.resourceLedger).unknown.requests,1);
  await restarted.missions.control(mission.id,{action:'retry',revision:mission.revision});await until(()=>!isActive(h.store.state.runs[BOT]));await Promise.all([...restarted.tasks.values()]);
  mission=h.store.state.missions[mission.id];assert.equal(h.requests.length,1);assert.equal(missionResourceSummary(mission.resourceLedger).unknown.requests,1);assert.equal(mission.outcome,'budget_exhausted');
});

test('owner lowering tool allowance during exact Strict approval prevents workspace write',async t=>{
  const h=await fixture(t,()=>tools(call('write','workspace_write',{path:'forbidden.txt',content:'Must not be written.'})),{policy:'strict'});
  const created=await h.create();const waiting=await until(()=>h.store.state.runs[BOT]?.status==='waiting_for_approval'&&h.store.state.runs[BOT]);const prompt=waiting.pending_controls[0],mission=h.store.state.missions[created.mission.id];
  await h.engine.missions.control(mission.id,{action:'limits',revision:mission.revision,limits:{toolCalls:0}});
  await h.engine.control(BOT,'approval',{runId:waiting.id,remoteRunId:waiting.remoteRunId,request_id:prompt.prompt_id,execution_generation:waiting.execution_generation,choice:'once'});
  await h.settled();await assert.rejects(fs.access(path.join(h.directory,'workspaces',BOT,'forbidden.txt')));
  assert.notEqual(h.store.state.missions[mission.id].outcome,'achieved');assert.equal(h.store.state.missions[mission.id].outcome,'budget_exhausted');
});

test('owner provider destination change queued before mark-dispatch prevents provider execution',async t=>{
  const h=await fixture(t,()=>answer('Must not run.'));let changed=false;
  h.store.onCommit(()=>{const mission=Object.values(h.store.state.missions || {})[0];if(changed || !mission || !Object.values(mission.resourceLedger.operations).some(op=>op.status==='reserved'&&op.dispatchedAt===undefined))return;changed=true;void h.store.mutate(state=>{state.connections[0].baseUrl='https://different.invalid';});});
  const created=await h.create();await h.settled();const mission=h.store.state.missions[created.mission.id];
  assert.equal(changed,true);assert.equal(h.requests.length,0);assert.notEqual(mission.outcome,'achieved');assert.match(mission.reason,/provider identity|destination changed/i);
});

test('reviewer measured usage above its reservation blocks final Achieved and preserves overrun',async t=>{
  const h=await fixture(t,()=>answer('The synthetic checked fixture phrase.'),{reviewer:request=>review(request,{input_tokens:300001,output_tokens:1})});
  const created=await h.create({tokens:300000});const run=await h.settled(),mission=h.store.state.missions[created.mission.id],summary=missionResourceSummary(mission.resourceLedger);
  assert.equal(h.reviews.length,1);assert.equal(run.status,'failed');assert.equal(mission.outcome,'budget_exhausted');assert.equal(summary.overrun.tokens,14);assert.notEqual(h.engine.missions.view(mission.id).progress.percent,100);
});

test('startup operator JSON enables capped NativeEngine work while later file changes cannot change active rates',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'tupies-mission-operator-price-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'prices.json');
  const row={connectionId:'fixture',type:'openai',baseUrl:'',model:'mission-model',version:'operator-v1',currency:'USD',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000};
  await fs.writeFile(file,JSON.stringify({schemaVersion:1,schedules:[row]}),{mode:0o600});
  const h=await fixture(t,async()=>{await fs.writeFile(file,JSON.stringify({schemaVersion:1,schedules:[{...row,version:'operator-v2',inputMicrosPerMillion:99_000_000}]}));return answer('The synthetic checked fixture phrase.');},{pricingFile:file});
  const created=await h.create({tokens:500000,moneyMicros:500000,requests:2});await h.settled();const mission=h.store.state.missions[created.mission.id];
  assert.equal(mission.outcome,'achieved',mission.reason);assert.equal(missionResourceSummary(mission.resourceLedger).settled.moneyMicros,24);
  assert.deepEqual(Object.values(mission.resourceLedger.operations).map(op=>op.pricing.version),['operator-v1','operator-v1']);
});

test('actual owner question idle wait does not become active compute and never extends absolute Mission deadline',async t=>{
  const h=await fixture(t,(request,turn)=>turn===1?tools(call('question','ask_user',{questions:[{id:'format',header:'Format',prompt:'Which synthetic format?'}]})):answer('The synthetic checked fixture phrase.'));
  const deadlineAt=Date.now()+10000,created=await h.create({deadlineAt});
  const waiting=await until(()=>h.store.state.runs[BOT]?.status==='waiting_for_input'&&h.store.state.runs[BOT]),prompt=waiting.pending_controls[0],live=h.engine.contexts.get(waiting.id);
  await delay(200);
  await h.engine.control(BOT,'answer',{runId:waiting.id,remoteRunId:waiting.remoteRunId,request_id:prompt.prompt_id,execution_generation:waiting.execution_generation,answers:[{questionId:'format',text:'Synthetic plain text.',optionIds:[]}]});
  await h.settled();const mission=h.store.state.missions[created.mission.id],question=Object.values(mission.resourceLedger.operations).find(op=>op.kind==='tool:ask_user');
  assert.equal(mission.outcome,'achieved',mission.reason);assert.ok(live.resourceWaitMs>=190);assert.ok(question.actual.computeMs<190,`active question charge ${question.actual.computeMs} must exclude owner idle wait ${live.resourceWaitMs}`);assert.equal(mission.resourceLedger.limits.deadlineAt,deadlineAt);
});
