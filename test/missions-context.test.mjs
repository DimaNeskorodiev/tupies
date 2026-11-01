import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-mission-context-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'fixture_provider',name:'Fixture',type:'openai',model:'fixture-model',contextWindow:8000});Object.assign(state.bots[0],{connectionId:'fixture_provider',tools:['workspace']});});
  const engine=new NativeEngine(store,{runTimeout:10000,maxTurns:4,providers:{async complete(_connection,request){requests.push(request);if(request.messages[0].content.includes('You independently assess an agent result')){const payload=JSON.parse(request.messages[1].content);return {text:JSON.stringify({coveragePassed:true,requirements:payload.contract.requirements.map(item=>({id:item.id,passed:true,reason:'Deterministic context-admission fixture.'})),reason:'Synthetic acceptance.'}),toolCalls:[]};}return {text:'A concise synthetic summary with its explicit limits.',toolCalls:[]};}}});
  await engine.recover();t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const settle=async()=>{await Promise.all([...engine.tasks.values()]);await store.queue;return store.state.runs.bot_atlas;};
  return {store,engine,requests,settle};
}

test('ordinary context overflow drops only optional first-step recognition and preserves the ordinary task',async t=>{
  const {store,engine,requests,settle}=await fixture(t),working=engine.workingContext.bind(engine);let refused=0,fallback=0;
  engine.workingContext=(context,providerContext,tools)=>{if(tools.some(item=>item.name==='mission_start')){refused++;throw new HttpError(400,'This conversation exceeds its working-context budget.');}fallback++;return working(context,providerContext,tools);};
  await engine.start('bot_atlas','Return a concise ordinary response.');const run=await settle();
  assert.equal(run.status,'completed',run.error);assert.equal(refused,1);assert.equal(fallback,1);assert.equal(requests.length,1);assert.equal(Object.keys(store.state.missions || {}).length,0);
  assert.equal(requests[0].tools.some(item=>item.name==='mission_start'),false);assert.equal(requests[0].tools.some(item=>item.name==='workspace_write'),true);assert.equal(requests[0].tools.find(item=>item.name==='workspace_write').parameters.additionalProperties,false);
});

test('established Mission overflow cannot drop contract tools or fall through to ordinary success',async t=>{
  const {store,engine,requests,settle}=await fixture(t);let attempts=0;
  engine.workingContext=(_context,_providerContext,tools)=>{attempts++;assert.ok(tools.some(item=>item.name==='mission_contract_set'));assert.ok(!tools.some(item=>item.name==='mission_start'));throw new HttpError(400,'This conversation exceeds its working-context budget.');};
  const {mission}=await engine.missions.create({leadBotId:'bot_atlas',goal:'Provide a checked synthetic summary.',requirements:['Provide a checked synthetic summary.'],clientMessageId:'mission_context_established'});
  const run=await settle();assert.equal(run.status,'failed');assert.equal(attempts,1);assert.equal(requests.length,0);assert.equal(store.state.missions[mission.id].outcome,'blocked');assert.match(store.state.missions[mission.id].reason,/larger context window/);assert.equal(store.state.missions[mission.id].contract.requirements.length,1);assert.ok(engine.missions.view(mission.id).progress.percent<100);
});

test('explicit owner creation and review work independently of optional chat recognition',async t=>{
  const {engine,store,requests,settle}=await fixture(t),working=engine.workingContext.bind(engine);
  await store.mutate(state=>{state.connections[0].contextWindow=32000;});
  engine.workingContext=(context,providerContext,tools)=>{assert.ok(!tools.some(item=>item.name==='mission_start'));return working(context,providerContext,tools);};
  const {mission}=await engine.missions.create({leadBotId:'bot_atlas',goal:'Give a synthetic summary and its limits.',requirements:['Give a synthetic summary and its limits.'],clientMessageId:'mission_context_explicit'});
  const run=await settle();assert.equal(run.status,'completed',run.error);assert.equal(store.state.missions[mission.id].outcome,'achieved');assert.equal(engine.missions.view(mission.id).progress.percent,100);assert.ok(requests.some(request=>request.messages[0].content.includes('You independently assess an agent result')));
});

test('retry rechecks retained unresolved episode effects instead of trusting a stale display flag',async t=>{
  const {engine,store,requests,settle}=await fixture(t);
  const {mission}=await engine.missions.create({leadBotId:'bot_atlas',goal:'Produce a synthetic result with declared criteria.',clientMessageId:'mission_context_unknown'});await settle();
  const current=store.state.missions[mission.id],run=store.state.runs.bot_atlas,calls=requests.length;
  await store.mutate(()=>{current.unknownEffects=false;current.episodeSnapshots[run.id].workReconciliation={unresolved:1};store.state.runs.bot_atlas={id:'run_later_ordinary',botId:'bot_atlas',source:'chat',status:'completed'};});
  await assert.rejects(engine.missions.control(mission.id,{action:'retry',revision:current.revision}),/Reconcile unknown effects/);
  assert.equal(store.state.missions[mission.id].episodeRefs.length,1);assert.equal(requests.length,calls);
});
