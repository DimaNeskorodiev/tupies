import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { newTaskCheckpoint } from '../lib/task-checkpoints.mjs';
import { validateRoutine } from '../lib/routines.mjs';

const BOT='bot_atlas',RUN='run_boundary_fixture';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const answer=text=>({text,toolCalls:[]});
const call=(id,name,args)=>({id,name,arguments:args});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const end=Date.now()+5000;while(Date.now()<end){const value=predicate();if(value)return value;await delay(5);}throw new Error('Disposable boundary fixture timed out.');}
async function fixture(t,complete=async()=>answer('Completed the synthetic task.'),options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-autonomous-boundary-')),store=await new Store(directory).init(),requests=[],engines=[];
  await store.mutate(state=>{
    state.connections.push({id:'boundary-provider',type:'openai',defaultModel:'fixture-model',secret:store.seal('synthetic-boundary-key')});
    Object.assign(state.bots.find(bot=>bot.id===BOT),{connectionId:'boundary-provider',model:'fixture-model',tools:['workspace'],approvalPolicy:'balanced',collaborators:[]});
  });
  const makeEngine=(activeStore=store,provider=complete,overrides={})=>{
    const engine=new NativeEngine(activeStore,{retryDelay:1,...options,...overrides,providers:{async complete(_connection,request){requests.push(request);return provider(request,requests.length);}}});engines.push(engine);return engine;
  };
  const engine=makeEngine();await engine.recover();
  t.after(async()=>{for(const item of engines)await item.close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,store,engine,requests,makeEngine};
}
async function seedCheckpoint(f,{history,runFields={}}={}) {
  const bot=f.store.state.bots.find(item=>item.id===BOT),connection=f.store.state.connections[0],inference={model:'fixture-model',reasoningEffort:'',reasoning:{supported:false,efforts:[]},images:false};
  const checkpoint=newTaskCheckpoint({bot,connection,inference,runId:RUN,sessionId:BOT,task:'Finish the synthetic owner task.'});
  await f.store.mutate(state=>{
    state.runs[BOT]={id:RUN,remoteRunId:RUN,botId:BOT,source:'chat',status:'interrupted',createdAt:new Date().toISOString(),events:[],artifacts:[],workRecords:[],steps:0,...runFields};
    state.conversations[BOT]=history || [{role:'user',content:'Finish the synthetic owner task.',runId:RUN}];
    (state.taskCheckpoints ||= {})[BOT]=checkpoint;
  });
  const context={runId:RUN,sessionId:BOT,lane:'chat',source:'chat',bot:structuredClone(bot),connection:structuredClone(connection),inference,controller:new AbortController(),completedEffects:new Map(),failedCalls:new Map(),toolResults:new Map()};
  await f.engine.checkpointRoutine(context,'interrupted');return f.store.state.taskCheckpoints[BOT];
}
async function settled(engine,store,runId=RUN){await until(()=>store.state.runs[BOT]?.id===runId && !isActive(store.state.runs[BOT]));await engine.tasks.get(runId);await store.queue;return store.state.runs[BOT];}

test('recovery restores owner guidance committed after the checkpoint and clears stale finalization state',async t=>{
  const guidance='Keep the result private and save only the requested report.';
  const f=await fixture(t,async request=>{
    assert.ok(request.messages.some(message=>message.role==='user' && message.content.includes(guidance)),'committed applied guidance survives an older history snapshot');
    return answer('Completed with the preserved owner guidance.');
  });
  await seedCheckpoint(f);
  await f.store.mutate(state=>{
    state.runs[BOT].steerClosing=true;
    state.runs[BOT].steering={updates:[{id:'steer_fixture',seq:1,text:guidance,status:'applied',messageId:'message_steer_fixture'}],bytes:guidance.length,appliedSeq:1};
    state.conversations[BOT].push({role:'user',kind:'steer',content:`Additional owner guidance for this same task:\n${guidance}`,sourceMessageId:'message_steer_fixture',runId:RUN});
  });
  let closingAtStart;
  const execute=f.engine.execute.bind(f.engine);f.engine.execute=async context=>{closingAtStart=f.store.state.runs[BOT].steerClosing;return execute(context);};
  await f.engine.recoverAutonomous();const done=await settled(f.engine,f.store);
  assert.equal(done.status,'completed',done.error);assert.notEqual(closingAtStart,true);
  assert.equal(f.store.state.runs[BOT].steering.updates[0].status,'applied');
});

test('an exact denied action is durable before its decision resolves and cannot be reprompted after restart',async t=>{
  const action={path:'denied.txt',content:'This write must remain denied.'};
  const f=await fixture(t,async(_request,count)=>count===1?{text:'',toolCalls:[call('denied-original','workspace_write',action)]}:answer('Respected the denial.'));
  await f.store.mutate(state=>{state.bots.find(bot=>bot.id===BOT).approvalPolicy='strict';});
  const started=await f.engine.start(BOT,'Complete only permitted work.');
  await until(()=>f.store.state.runs[BOT]?.status==='waiting_for_approval');
  const pending=f.engine.pending.get(started.id),resolve=pending.resolve;let crashState;
  pending.resolve=value=>{if(value===false)crashState=structuredClone(f.store.state);return resolve(value);};
  const run=f.store.state.runs[BOT];
  await f.engine.control(BOT,'approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:run.approval.request_id,execution_generation:run.execution_generation,choice:'deny'});
  await settled(f.engine,f.store,started.id);
  assert.ok(crashState && Object.keys(crashState.runs[BOT].deniedCalls || {}).length,'denial is persisted before releasing the executor');
  await f.engine.close();
  await f.store.mutate(state=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,crashState);});
  const reopened=await new Store(f.directory).init();let retryCalls=0,writes=0;
  const recovered=f.makeEngine(reopened,async()=>++retryCalls===1?{text:'',toolCalls:[call('denied-retry','workspace_write',action)]}:answer('Finished without repeating denied work.'));
  const execute=recovered.tools.execute.bind(recovered.tools);recovered.tools.execute=async(...args)=>{if(args[1]==='workspace_write')writes++;return execute(...args);};
  await recovered.recover();await recovered.recoverAutonomous();
  await until(()=>!isActive(reopened.state.runs[BOT]) || reopened.state.runs[BOT].status==='waiting_for_approval');
  assert.notEqual(reopened.state.runs[BOT].status,'waiting_for_approval','a new call id cannot regenerate the denied approval');
  const done=await settled(recovered,reopened,started.id);assert.equal(done.status,'completed',done.error);assert.equal(writes,0);
});

test('failed post-admission setup cannot leave a queued recovery without an executor',async t=>{
  const f=await fixture(t);await seedCheckpoint(f);
  f.engine.appendConversation=async()=>{throw new Error('Synthetic recovery persistence failure.');};
  await f.engine.recoverAutonomous();const run=f.store.state.runs[BOT];
  assert.equal(isActive(run),false);assert.equal(run.recovery?.status,'blocked');assert.equal(f.engine.tasks.has(RUN),false);assert.equal(f.engine.controllers.has(RUN),false);assert.equal(f.engine.starting.has(BOT),false);assert.equal(f.requests.length,0);
});

test('recovery defers to compaction and revalidates topology at its queued admission boundary',async t=>{
  let allowed=true;
  const f=await fixture(t,async()=>answer('Must not run while admission is disabled.'),{assertAdmission(){if(!allowed)throw new HttpError(409,'Synthetic topology change.');}});
  await seedCheckpoint(f);f.engine.compactions.set(BOT,new AbortController());
  await f.engine.recoverAutonomous();assert.equal(f.requests.length,0);assert.equal(f.store.state.taskCheckpoints[BOT].automatic,true);f.engine.compactions.delete(BOT);
  const entered=deferred(),release=deferred();
  const held=f.store.mutate(async()=>{entered.resolve();await release.promise;});await entered.promise;
  const recovering=f.engine.recoverAutonomous();
  try{await until(()=>f.engine.starting.has(BOT));allowed=false;}finally{release.resolve();}
  await held;await recovering;
  assert.equal(f.requests.length,0);assert.equal(isActive(f.store.state.runs[BOT]),false);assert.match(f.store.state.runs[BOT].recovery?.reason || '',/topology/i);
});

test('a durable Stop tombstone prevents dispatch before the controller receives abort',async t=>{
  const entered=deferred();
  const f=await fixture(t,async request=>{entered.resolve();return new Promise((_,reject)=>{request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});if(request.signal.aborted)reject(request.signal.reason);});});
  const run=await f.engine.start(BOT,'Wait for a synthetic response.');await entered.promise;
  const save=f.store.save.bind(f.store),saving=deferred(),release=deferred();let held=false;
  f.store.save=async()=>{if(f.store.state.runs[BOT]?.stopRequested && !held){held=true;saving.resolve();await release.promise;}return save();};
  const stopping=f.engine.control(BOT,'stop',{runId:run.id,remoteRunId:run.remoteRunId});
  try{
    await saving.promise;const controller=f.engine.controllers.get(run.id);assert.equal(controller.signal.aborted,false);
    assert.throws(()=>f.engine.assertRunning({runId:run.id,bot:{id:BOT},controller}),error=>error.name==='AbortError');
  }finally{release.resolve();}
  await stopping;const done=await settled(f.engine,f.store,run.id);assert.equal(done.status,'cancelled');assert.equal(f.store.state.taskCheckpoints?.[BOT],undefined);
});

test('large history uses a verified reference and rejects changed prefix recovery',async t=>{
  for(const changed of [false,true])await t.test(changed?'changed prefix':'retained prefix',async t=>{
    const f=await fixture(t),history=[{role:'user',content:'x'.repeat(450_000),runId:'earlier_run'},{role:'assistant',content:'Earlier synthetic context.',runId:'earlier_run'},{role:'user',content:'Finish the synthetic owner task.',runId:RUN}];
    const checkpoint=await seedCheckpoint(f,{history});
    assert.equal(checkpoint.snapshot.conversation,undefined);assert.equal(checkpoint.snapshot.conversationRef.sessionId,BOT);
    if(changed)await f.store.mutate(state=>{state.conversations[BOT][0].content='Changed authoritative prefix.';});
    await f.engine.recoverAutonomous();
    if(changed){assert.equal(f.requests.length,0);assert.equal(isActive(f.store.state.runs[BOT]),false);assert.match(f.store.state.runs[BOT].recovery?.reason || '',/history changed/i);}
    else {const done=await settled(f.engine,f.store);assert.equal(done.status,'completed',done.error);assert.ok(f.requests.length>0);}
  });
});

test('admission atomically checkpoints direct and routine tasks before the first executor turn',async t=>{
  for(const routine of [false,true])await t.test(routine?'routine admission':'direct owner admission',async t=>{
    const task='Finish the admitted task even if the engine restarts immediately.';
    const f=await fixture(t,async request=>{assert.ok(request.messages.some(message=>message.role==='user' && message.content.includes(task)));return answer('Finished the task admitted before restart.');});
    if(routine)await f.store.mutate(state=>{state.routines.push({...validateRoutine({name:'Initial checkpoint fixture',botId:BOT,prompt:task,intervalMinutes:60,enabled:false}),id:'routine_initial_checkpoint'});});
    let crashState;
    f.engine.execute=async()=>{crashState=structuredClone(f.store.state);};
    const started=await (routine?f.engine.runRoutine('routine_initial_checkpoint'):f.engine.start(BOT,task));
    await f.engine.tasks.get(started.id);await f.store.queue;
    const checkpoint=routine?crashState.routineRuntime.routine_initial_checkpoint.checkpoint:crashState.taskCheckpoints[BOT];
    assert.ok(checkpoint.snapshot,'the admission commit already contains its safe starting point');
    assert.equal(checkpoint.inference.model,'fixture-model');assert.equal(checkpoint.snapshot.usedModelTurns,0);assert.deepEqual(checkpoint.snapshot.completedEffects,[]);assert.equal(f.requests.length,0);
    await f.engine.close();
    await f.store.mutate(state=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,crashState);});
    const reopened=await new Store(f.directory).init(),recovered=f.makeEngine(reopened);
    await recovered.recover();await recovered.recoverAutonomous();
    const done=await settled(recovered,reopened,started.id);
    assert.equal(done.status,'completed',done.error);assert.equal(done.id,started.id);assert.equal(f.requests.length,1);
  });
});
