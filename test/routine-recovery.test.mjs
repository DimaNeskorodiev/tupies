import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { routineRuns, validateRoutine } from '../lib/routines.mjs';
import { markProviderFailure } from '../lib/provider-failure.mjs';

const BOT='bot_atlas',ROUTINE='routine_recovery_fixture';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const current=store=>store.state.runs[BOT];
const call=(id,name,args)=>({id,name,arguments:args});
const answer=text=>({text,toolCalls:[]});
const outage=()=>markProviderFailure(new HttpError(504,'Fixture provider response stopped.'),'timeout',{timeoutPhase:'idle'});
async function until(predicate,timeout=5000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){const result=predicate();if(result)return result;await delay(5);}
  throw new Error('Routine recovery fixture timed out.');
}
const reasoning={supported:true,efforts:['low','high'],defaultEffort:'low',parameter:'reasoning.effort',source:'provider'};
async function fixture(t,complete,{routine={},configure,runTimeout=10000,...options}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-routine-recovery-')),store=await new Store(directory).init(),requests=[],engines=[];
  await store.mutate(state=>{
    state.connections.push({id:'routine-fixture-provider',type:'openai',name:'Fixture',model:'model-original',models:[{id:'model-original',reasoning},{id:'model-next',reasoning}],secret:store.seal('disposable-routine-fixture-key')});
    Object.assign(state.bots.find(bot=>bot.id===BOT),{connectionId:'routine-fixture-provider',model:'model-original',reasoningEffort:'low',tools:['workspace','web','automation'],approvalPolicy:'balanced',collaborators:[]});
    // This file verifies the explicitly selected bounded/manual-recovery option.
    // Default autonomous retries and startup recovery live in autonomous-engine.
    state.routines.push({...validateRoutine({name:'Fixture research',botId:BOT,prompt:'Inspect fixture releases, preserve completed work and report the new findings.',intervalMinutes:60,enabled:false,limits:{mode:'bounded'},...routine}),id:ROUTINE});
    configure?.(state);
  });
  const providers={async complete(connection,request){requests.push({model:request.model,reasoningEffort:request.reasoningEffort,reasoningCapabilities:structuredClone(request.reasoningCapabilities),messages:structuredClone(request.messages),turnContext:request.turnContext});return complete(request,requests.length,connection);}};
  const engine=new NativeEngine(store,{runTimeout,...options,providers});engines.push(engine);await engine.recover();
  t.after(async()=>{for(const item of engines)await item.close();await fs.rm(directory,{recursive:true,force:true});});
  return {engine,store,directory,requests,engines,providers,routine:()=>store.state.routines.find(item=>item.id===ROUTINE)};
}
async function settled(engine,store,started) {
  await until(()=>current(store)?.id===started.id && !isActive(current(store)));
  await engine.tasks.get(started.id);await store.queue;
  return current(store);
}
function continuation(store) {
  const routine=store.state.routines.find(item=>item.id===ROUTINE),entry=routineRuns(store.state,routine).find(item=>item.runId===current(store).id);
  assert.ok(entry?.resume?.checkpointId,'engine exposes an exact safe continuation');
  return {runId:entry.runId,checkpointId:entry.resume.checkpointId};
}
async function failedFixture(t,options={}) {
  const f=await fixture(t,async()=>{throw outage();},options);
  await settled(f.engine,f.store,await f.engine.runRoutine(ROUTINE));
  assert.equal(current(f.store).status,'failed');
  return {...f,identity:continuation(f.store)};
}

test('explicit bounded-routine continuation retains completed writes and prevents a repeated exact mutation',async t=>{
  const write={path:'reports/retained.txt',content:'Verified fixture evidence.\n'};
  const f=await fixture(t,async(request,count)=>{
    if(count===1)return {text:'Saving verified evidence.',toolCalls:[call('save-first','workspace_write',write)]};
    if(count===2)throw outage();
    if(count===3){assert.ok(request.messages.some(message=>message.role==='tool' && message.tool_call_id==='save-first'),'completed tool transcript reaches the continuation');return {text:'Confirm the retained save.',toolCalls:[call('save-again','workspace_write',write)]};}
    return answer('Completed the report using the retained evidence.');
  });
  let writes=0;const execute=f.engine.tools.execute.bind(f.engine.tools);
  f.engine.tools.execute=async(...args)=>{if(args[1]==='workspace_write')writes++;return execute(...args);};
  const first=await f.engine.runRoutine(ROUTINE),failed=await settled(f.engine,f.store,first),identity=continuation(f.store);
  assert.equal(failed.status,'failed');assert.equal(writes,1);assert.equal(f.requests.length,2);
  assert.equal(await fs.readFile(path.join(await getWorkspaceRoot(f.store,BOT),write.path),'utf8'),write.content);
  await delay(30);assert.equal(f.requests.length,2,'failed work never restarts on its own');
  const resumed=await f.engine.resumeRoutine(ROUTINE,identity),finished=await settled(f.engine,f.store,resumed);
  assert.equal(finished.status,'completed',finished.error);assert.equal(finished.continuedFrom,first.id);
  assert.equal(writes,1,'a new model call id cannot repeat an already completed identical write');
  assert.equal(f.requests.length,4);assert.equal(routineRuns(f.store.state,f.routine())[0].resume,undefined);
  await assert.rejects(f.engine.resumeRoutine(ROUTINE,identity),error=>error.status===409);
});

test('bounded-routine continuation preserves original model, reasoning and capabilities after next-run selections change',async t=>{
  const f=await fixture(t,async(_request,count)=>{if(count===1)throw outage();return answer('Finished with the original inference snapshot.');});
  await settled(f.engine,f.store,await f.engine.runRoutine(ROUTINE));const identity=continuation(f.store);
  await f.store.mutate(state=>{
    Object.assign(state.bots.find(bot=>bot.id===BOT),{model:'model-next',reasoningEffort:'high'});
    state.connections.find(connection=>connection.id==='routine-fixture-provider').models=[{id:'model-next',reasoning}];
  });
  const resumed=await f.engine.resumeRoutine(ROUTINE,identity),done=await settled(f.engine,f.store,resumed);
  assert.equal(done.status,'completed',done.error);
  assert.equal(f.requests[1].model,'model-original');assert.equal(f.requests[1].reasoningEffort,'low');
  assert.deepEqual(f.requests[1].reasoningCapabilities,reasoning);
  await settled(f.engine,f.store,await f.engine.runRoutine(ROUTINE));
  assert.equal(f.requests[2].model,'model-next');assert.equal(f.requests[2].reasoningEffort,'high');
});

test('stale checkpoints and changes to routine, permissions or provider refuse continuation before inference',async t=>{
  for(const [name,change] of [
    ['routine instructions',state=>{state.routines[0].prompt='Changed task with different scope.';}],
    ['tool permissions',state=>{state.bots.find(bot=>bot.id===BOT).tools=['workspace'];}],
    ['approval policy',state=>{state.bots.find(bot=>bot.id===BOT).approvalPolicy='strict';}],
    ['provider destination',state=>{state.connections[0].baseUrl='https://other.example.org/v1';}],
  ])await t.test(name,async t=>{
    const f=await failedFixture(t);
    await assert.rejects(f.engine.resumeRoutine(ROUTINE,{...f.identity,checkpointId:'checkpoint_stale'}),error=>error.status===409);
    await f.store.mutate(change);
    assert.equal(routineRuns(f.store.state,f.routine())[0].resume,undefined);
    await assert.rejects(f.engine.resumeRoutine(ROUTINE,f.identity),error=>error.status===409);
    assert.equal(f.requests.length,1);
  });
});

test('bounded-routine restart retains a checkpoint for explicit resume and never replays completed effects',async t=>{
  let waiting=false;
  const f=await fixture(t,async(request,count)=>{
    if(count===1)return {text:'Save before the simulated crash.',toolCalls:[call('saved-before-crash','workspace_write',{path:'before-crash.txt',content:'Committed before interruption.'})]};
    waiting=true;
    await new Promise((resolve,reject)=>{request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});if(request.signal.aborted)reject(request.signal.reason);});
  });
  await f.engine.runRoutine(ROUTINE);await until(()=>waiting);
  const crashState=structuredClone(f.store.state),runId=current(f.store).id;
  assert.ok(crashState.routineRuntime[ROUTINE].checkpoint.snapshot);
  await f.engine.close();
  // Restore only synthetic fixture bytes captured at the crash boundary, after the
  // previous task has drained. No two workers execute against this store at once.
  await f.store.mutate(state=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,structuredClone(crashState));});
  const reopened=await new Store(f.directory).init();let calls=0,writes=0;
  const recovered=new NativeEngine(reopened,{runTimeout:10000,providers:{async complete(_connection,request){calls++;assert.ok(request.messages.some(message=>message.tool_call_id==='saved-before-crash'));return answer('Finished after explicit restart recovery.');}}});
  f.engines.push(recovered);const execute=recovered.tools.execute.bind(recovered.tools);
  recovered.tools.execute=async(...args)=>{if(args[1]==='workspace_write')writes++;return execute(...args);};
  await recovered.recover();await delay(20);
  assert.equal(current(reopened).id,runId);assert.equal(current(reopened).status,'interrupted');assert.equal(calls,0);assert.equal(writes,0);
  const identity=continuation(reopened),resumed=await recovered.resumeRoutine(ROUTINE,identity),done=await settled(recovered,reopened,resumed);
  assert.equal(done.status,'completed',done.error);assert.equal(calls,1);assert.equal(writes,0);
  assert.equal(await fs.readFile(path.join(await getWorkspaceRoot(reopened,BOT),'before-crash.txt'),'utf8'),'Committed before interruption.');
});

test('owner Stop cancels a routine and removes its continuation even when earlier work was saved',async t=>{
  let waiting=false;
  const f=await fixture(t,async(request,count)=>{
    if(count===1)return {text:'',toolCalls:[call('saved-before-stop','workspace_write',{path:'before-stop.txt',content:'Retain this partial work.'})]};
    waiting=true;await new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));
  });
  const run=await f.engine.runRoutine(ROUTINE);await until(()=>waiting);
  const checkpointId=f.store.state.routineRuntime[ROUTINE].checkpoint.id;
  await f.engine.control(BOT,'stop',{runId:run.id,remoteRunId:run.remoteRunId});const stopped=await settled(f.engine,f.store,run);
  assert.equal(stopped.status,'cancelled');assert.equal(routineRuns(f.store.state,f.routine())[0].resume,undefined);
  await assert.rejects(f.engine.resumeRoutine(ROUTINE,{runId:run.id,checkpointId}),error=>error.status===409);
  assert.equal(await fs.readFile(path.join(await getWorkspaceRoot(f.store,BOT),'before-stop.txt'),'utf8'),'Retain this partial work.');
});

test('a mutation with a lost acknowledgement remains uncertain and cannot expose Continue',async t=>{
  const f=await fixture(t,async(_request,count)=>{if(count===1)return {text:'',toolCalls:[call('uncertain-save','workspace_write',{path:'uncertain.txt',content:'The write happened before acknowledgement was lost.'})]};throw outage();});
  const execute=f.engine.tools.execute.bind(f.engine.tools);
  f.engine.tools.execute=async(...args)=>{const output=await execute(...args);if(args[1]==='workspace_write')throw new Error('Fixture lost write acknowledgement.');return output;};
  await settled(f.engine,f.store,await f.engine.runRoutine(ROUTINE));
  assert.equal(current(f.store).status,'failed');assert.ok(current(f.store).workRecords.some(record=>record.outcome==='unknown'));
  const row=routineRuns(f.store.state,f.routine())[0];assert.equal(row.resume,undefined);assert.match(row.resumeUnavailable,/uncertain/i);
  await assert.rejects(f.engine.resumeRoutine(ROUTINE,{runId:row.runId,checkpointId:f.store.state.routineRuntime[ROUTINE].checkpoint.id}),error=>error.status===409);
  assert.match(await fs.readFile(path.join(await getWorkspaceRoot(f.store,BOT),'uncertain.txt'),'utf8'),/write happened/);
});

const workflow=()=>({version:1,mode:'agent',steps:[
  {id:'feed',op:'fetch',url:'https://example.com/fixture-releases.json'},
  {id:'criteria',op:'read',path:'criteria.txt'},
  {id:'data',op:'json',from:'feed',path:'text'},
  {id:'fresh',op:'select',from:'data',path:'items',key:'id',limit:10},
],skipIfEmpty:'fresh',context:'Saved criteria: {{criteria.content}}\nNew candidates: {{fresh}}'});

test('bounded-routine preparation reaches inference, commits seen items only after success and skips unchanged model runs',async t=>{
  let reads=0;
  const f=await fixture(t,async(request,count)=>{
    const context=JSON.stringify([request.messages,request.turnContext]);assert.match(context,/New candidates/);assert.match(context,/untrusted source data/);assert.match(context,/fixture-release/);
    if(count===1)throw outage();return answer('A verified new fixture release was recorded.');
  },{routine:{workflow:workflow()},publicFetch:async(url)=>{reads++;assert.equal(url,'https://example.com/fixture-releases.json');return {url,status:200,contentType:'application/json',text:JSON.stringify({items:[{id:'fixture-release',title:'New release'}]})};}});
  await fs.writeFile(path.join(await getWorkspaceRoot(f.store,BOT),'criteria.txt'),'Report meaningful new functionality.');
  await settled(f.engine,f.store,await f.engine.runRoutine(ROUTINE));assert.equal(current(f.store).status,'failed');
  assert.equal(f.store.state.routineRuntime[ROUTINE].workflowState,undefined,'failed analysis cannot consume prepared candidates');assert.equal(reads,1);
  const resumed=await f.engine.resumeRoutine(ROUTINE,continuation(f.store)),done=await settled(f.engine,f.store,resumed);
  assert.equal(done.status,'completed',done.error);assert.equal(reads,1,'completed preparation is restored rather than reissued');
  assert.equal(f.store.state.routineRuntime[ROUTINE].workflowState.seen.fresh.length,1);assert.equal(f.requests.length,2);
  const next=await settled(f.engine,f.store,await f.engine.runRoutine(ROUTINE));
  assert.equal(next.status,'completed',next.error);assert.equal(next.output,'No new items.');assert.equal(f.requests.length,2,'unchanged candidates require no inference');assert.equal(reads,2);
});

test('deterministic routine report runs with no provider connection',async t=>{
  const f=await fixture(t,()=>assert.fail('report mode must not request a model'),{routine:{workflow:{version:1,mode:'report',steps:[{id:'source',op:'read',path:'input.json'},{id:'value',op:'json',from:'source',path:'content'}],report:'Fixture total: {{value.total}}'}},configure:state=>{state.connections=[];state.bots.find(bot=>bot.id===BOT).connectionId='';}});
  await fs.writeFile(path.join(await getWorkspaceRoot(f.store,BOT),'input.json'),' {"total":42} ');
  const done=await settled(f.engine,f.store,await f.engine.runRoutine(ROUTINE));
  assert.equal(done.status,'completed',done.error);assert.equal(done.output,'Fixture total: 42');assert.equal(f.requests.length,0);
});

test('strict routine savePath waits outside its runtime budget for exact ordinary workspace approval',async t=>{
  const f=await fixture(t,()=>assert.fail('report mode must not request a model'),{runTimeout:1000,routine:{workflow:{version:1,mode:'report',steps:[{id:'source',op:'read',path:'source.txt'}],report:'Verified {{source.content}}',savePath:'reports/approved.txt'}},configure:state=>{state.bots.find(bot=>bot.id===BOT).approvalPolicy='strict';}});
  await fs.writeFile(path.join(await getWorkspaceRoot(f.store,BOT),'source.txt'),'fixture result');
  const started=await f.engine.runRoutine(ROUTINE);
  await until(()=>current(f.store)?.status==='waiting_for_approval');const waiting=structuredClone(current(f.store)),control=waiting.pending_controls[0];
  assert.equal(control.tool,'workspace_write');assert.deepEqual(control.arguments,{path:'reports/approved.txt',content:'Verified fixture result'});
  await assert.rejects(fs.stat(path.join(await getWorkspaceRoot(f.store,BOT),'reports/approved.txt')));
  await delay(1100);assert.equal(current(f.store).status,'waiting_for_approval','owner approval waiting does not spend the task execution budget');
  const identity={runId:waiting.id,remoteRunId:waiting.remoteRunId,request_id:control.prompt_id,execution_generation:waiting.execution_generation};
  await assert.rejects(f.engine.control(BOT,'approval',{...identity,request_id:'approval_stale',choice:'once'}),/prompt changed/);
  await f.engine.control(BOT,'approval',{...identity,choice:'once'});
  const done=await settled(f.engine,f.store,started);assert.equal(done.status,'completed',done.error);
  assert.equal(await fs.readFile(path.join(await getWorkspaceRoot(f.store,BOT),'reports/approved.txt'),'utf8'),'Verified fixture result');
});
