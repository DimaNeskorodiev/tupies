import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { markProviderFailure } from '../lib/provider-failure.mjs';

const BOT='bot_atlas';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const current=store=>store.state.runs[BOT];
const call=(id,name,args)=>({id,name,arguments:args});
const answer=text=>({text,toolCalls:[]});
const timeout=()=>markProviderFailure(new HttpError(504,'Disposable provider timeout.'),'timeout',{timeoutPhase:'idle'});
const reasoning={supported:true,efforts:['low','high'],defaultEffort:'low',parameter:'reasoning.effort',source:'provider'};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function until(predicate,timeoutMs=10000) {
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){const result=predicate();if(result)return result;await delay(5);}
  throw new Error('Autonomous engine fixture timed out.');
}
async function fixture(t,complete,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-autonomous-engine-')),store=await new Store(directory).init(),requests=[],engines=[];
  await store.mutate(state=>{
    state.connections.push({id:'autonomous-fixture',type:'openai',name:'Fixture',model:'original-model',secret:store.seal('disposable-autonomous-fixture-key'),models:[{id:'original-model',reasoning},{id:'next-model',reasoning}]});
    Object.assign(state.bots.find(bot=>bot.id===BOT),{connectionId:'autonomous-fixture',model:'original-model',reasoningEffort:'low',tools:['workspace'],approvalPolicy:'balanced',collaborators:[]});
  });
  const engine=new NativeEngine(store,{retryDelay:1,...options,providers:{async complete(connection,request){
    requests.push({model:request.model,reasoningEffort:request.reasoningEffort,reasoningCapabilities:structuredClone(request.reasoningCapabilities),messages:structuredClone(request.messages),turnContext:request.turnContext});
    return complete(request,requests.length,connection);
  }}});engines.push(engine);await engine.recover();
  t.after(async()=>{for(const item of engines)await item.close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,store,engine,requests,engines};
}
async function settle(engine,store,run,timeoutMs=10000) {
  await until(()=>current(store)?.id===run.id && !isActive(current(store)),timeoutMs);
  await engine.tasks.get(run.id);await store.queue;return current(store);
}
const planStep=status=>({id:'save',title:'Save and verify the requested report',status});

test('transient provider recovery continues the same task without confirmation or repeating committed tools',async t=>{
  const f=await fixture(t,async(request,count)=>{
    if(count===1)return {text:'Saving verified evidence.',toolCalls:[call('saved','workspace_write',{path:'retained.txt',content:'Completed tool evidence.'})]};
    if(count===2)throw timeout();
    assert.ok(request.messages.some(message=>message.role==='tool' && message.tool_call_id==='saved'));
    return answer('Finished automatically after the provider recovered.');
  });
  let writes=0;const execute=f.engine.tools.execute.bind(f.engine.tools);
  f.engine.tools.execute=async(...args)=>{if(args[1]==='workspace_write')writes++;return execute(...args);};
  const started=await f.engine.start(BOT,'Save the evidence and complete the report.'),done=await settle(f.engine,f.store,started);
  assert.equal(done.status,'completed',done.error);assert.equal(done.id,started.id);assert.equal(writes,1);assert.equal(f.requests.length,3);
  assert.deepEqual(done.pending_controls,[]);assert.equal(f.store.state.messages[BOT].filter(message=>message.role==='user').length,1);
  assert.equal(await fs.readFile(path.join(await getWorkspaceRoot(f.store,BOT),'retained.txt'),'utf8'),'Completed tool evidence.');
});

test('autonomous work finishes beyond both former model-turn and tool-call cutoffs when observations keep changing',async t=>{
  let nextFile=0,reads=0;
  const f=await fixture(t,async(_request,count)=>{
    if(count<=55){const batch=Array.from({length:count<=10?2:1},()=>{const number=++nextFile;return call(`read-${number}`,'workspace_read',{path:`sources/${number}.txt`});});return {text:'',toolCalls:batch};}
    return answer('Read all 65 distinct source records and finished the report.');
  });
  const root=await getWorkspaceRoot(f.store,BOT);await fs.mkdir(path.join(root,'sources'));
  await Promise.all(Array.from({length:65},(_,index)=>fs.writeFile(path.join(root,'sources',`${index+1}.txt`),`Verified source record ${index+1}.`)));
  const execute=f.engine.tools.execute.bind(f.engine.tools);f.engine.tools.execute=async(...args)=>{if(args[1]==='workspace_read')reads++;return execute(...args);};
  const started=await f.engine.start(BOT,'Read the 65 source records and finish a report.'),done=await settle(f.engine,f.store,started,20000);
  assert.equal(done.status,'completed',done.error);assert.equal(reads,65);assert.equal(f.requests.length,56);assert.equal(done.steps,56);
});

test('an unfinished plan causes an autonomous repair turn and actual completion instead of a premature final failure',async t=>{
  const f=await fixture(t,async(request,count)=>{
    if(count===1)return {text:'',toolCalls:[call('plan','task_plan_set',{steps:[planStep('in_progress')]})]};
    if(count===2)return answer('The report is ready.');
    if(count===3){assert.match(JSON.stringify([request.messages,request.turnContext]),/unfinished|incomplete|remaining/i);return {text:'Finish the remaining save.',toolCalls:[call('save','workspace_write',{path:'finished.txt',content:'The actual finished report.'}),call('plan-complete','task_plan_set',{expectedVersion:1,steps:[planStep('completed')]})]};}
    return answer('Saved and verified the requested report.');
  });
  const done=await settle(f.engine,f.store,await f.engine.start(BOT,'Save a report and verify the complete plan.'));
  assert.equal(done.status,'completed',done.error);assert.equal(f.requests.length,4);assert.equal(done.plan.steps[0].status,'completed');
  assert.equal(await fs.readFile(path.join(await getWorkspaceRoot(f.store,BOT),'finished.txt'),'utf8'),'The actual finished report.');
});

test('changing final-response wording cannot evade the unchanged unfinished-plan guard',async t=>{
  const f=await fixture(t,async(_request,count)=>count===1?{text:'',toolCalls:[call('plan','task_plan_set',{steps:[planStep('in_progress')]})]}:answer(`A different final claim ${count}, without completing the required save.`));
  const done=await settle(f.engine,f.store,await f.engine.start(BOT,'Complete and save the report before finishing.'));
  assert.equal(done.status,'failed');assert.match(done.error,/no progress/i);assert.equal(done.plan.steps[0].status,'in_progress');
  assert.ok(f.requests.length>=4 && f.requests.length<=10);assert.ok(!f.store.state.messages[BOT].some(message=>message.role==='assistant' && !message.partial && /different final claim/.test(message.content)));
});

test('repeated successful reads of unchanged data stop for observed no progress rather than a time or step quota',async t=>{
  const f=await fixture(t,async(_request,count)=>({text:'',toolCalls:[call(`same-read-${count}`,'workspace_read',{path:'unchanged.txt'})]}));
  await fs.writeFile(path.join(await getWorkspaceRoot(f.store,BOT),'unchanged.txt'),'Same observation every time.');
  const done=await settle(f.engine,f.store,await f.engine.start(BOT,'Investigate the source and produce a useful result.'));
  assert.ok(['failed','blocked'].includes(done.status),done.status);assert.match(done.error,/no progress|unchanged|repeated/i);
  assert.ok(f.requests.length>=4 && f.requests.length<=16,`Unexpected no-progress window: ${f.requests.length}`);
  assert.doesNotMatch(done.error,/model-step limit|tool-call limit|runtime limit/i);
});

test('an autonomous task waits for its exact-approved background command and verifies retained output before finishing',async t=>{
  const command={executable:process.execPath,args:['-e',"console.log('fixture command started');setTimeout(()=>console.log('verified fixture command result'),2500)"],timeoutMs:10000};
  let processId;
  const f=await fixture(t,async(request,count)=>{
    if(count===1)return {text:'',toolCalls:[call('launch','shell_start',command)]};
    if(count===2){
      const started=JSON.parse(request.messages.findLast(message=>message.tool_call_id==='launch').content);processId=started.processId;
      assert.equal(typeof processId,'string');assert.equal(f.engine.backgroundProcesses.hasActive(current(f.store).id),true);
      return answer('A premature final response while the command is still running.');
    }
    if(count===3){assert.match(JSON.stringify([request.messages,request.turnContext]),/commands have settled/);return {text:'',toolCalls:[call('verify-command','shell_read',{processId,offset:0,waitMs:0})]};}
    const result=JSON.parse(request.messages.findLast(message=>message.tool_call_id==='verify-command').content);
    assert.equal(result.status,'completed');assert.equal(result.exitCode,0);assert.match(result.output,/verified fixture command result/);
    return answer('The command completed successfully and its actual retained result was verified.');
  });
  await f.store.mutate(state=>{state.bots.find(bot=>bot.id===BOT).tools.push('terminal');});
  const started=await f.engine.start(BOT,'Run the approved command and verify its actual output before finishing.');
  await until(()=>current(f.store)?.status==='waiting_for_approval');
  const waiting=structuredClone(current(f.store)),control=waiting.pending_controls[0];
  assert.equal(control.tool,'shell_start');assert.deepEqual(control.arguments,command);
  await f.engine.control(BOT,'approval',{runId:waiting.id,remoteRunId:waiting.remoteRunId,request_id:control.prompt_id,execution_generation:waiting.execution_generation,choice:'once'});
  const done=await settle(f.engine,f.store,started);
  assert.equal(done.status,'completed',done.error);assert.equal(done.backgroundProcesses[0].status,'completed');assert.equal(done.backgroundProcesses[0].exitCode,0);
  assert.equal(f.engine.backgroundProcesses.hasActive(started.id),false);assert.equal(f.requests.length,4);
  assert.equal(done.events.filter(event=>event.type==='approval.request').length,1,'only the exact command approval was requested');
  assert.equal(f.store.state.messages[BOT].filter(message=>message.role==='user').length,1,'waiting and verification never request another task confirmation');
});

test('owner Stop during provider backoff cancels recovery and a later startup does not resume the stopped task',async t=>{
  const f=await fixture(t,async()=>{throw timeout();},{retryDelay:1000});
  const run=await f.engine.start(BOT,'Keep working when the provider becomes available.');
  await until(()=>current(f.store)?.events?.some(event=>/retry|recover/i.test(event.type)));
  assert.equal(f.requests.length,1);
  await f.engine.control(BOT,'stop',{runId:run.id,remoteRunId:run.remoteRunId});const stopped=await settle(f.engine,f.store,run);
  assert.equal(stopped.status,'cancelled');assert.equal(f.requests.length,1);
  await f.engine.close();
  const reopened=await new Store(f.directory).init();let calls=0;
  const recovered=new NativeEngine(reopened,{retryDelay:1,providers:{async complete(){calls++;return answer('Must not resume after Stop.');}}});f.engines.push(recovered);
  await recovered.recover();assert.equal(typeof recovered.recoverAutonomous,'function');await recovered.recoverAutonomous();await delay(20);
  assert.equal(calls,0);assert.equal(current(reopened).status,'cancelled');
});

test('network retries keep the original model, effort and capability snapshot while next-run selection changes',async t=>{
  const held=deferred();let entered=false;
  const f=await fixture(t,async(_request,count)=>{if(count===1){entered=true;await held.promise;throw timeout();}return answer('The original model completed its task.');});
  const run=await f.engine.start(BOT,'Complete the task after a transient provider interruption.');await until(()=>entered);
  await f.store.mutate(state=>{Object.assign(state.bots.find(bot=>bot.id===BOT),{model:'next-model',reasoningEffort:'high'});state.connections[0].models=[{id:'next-model',reasoning}];});held.resolve();
  const done=await settle(f.engine,f.store,run);assert.equal(done.status,'completed',done.error);
  assert.equal(f.requests.length,2);for(const request of f.requests){assert.equal(request.model,'original-model');assert.equal(request.reasoningEffort,'low');assert.deepEqual(request.reasoningCapabilities,reasoning);}
  await settle(f.engine,f.store,await f.engine.start(BOT,'Use the next selection for a new task.'));
  assert.equal(f.requests[2].model,'next-model');assert.equal(f.requests[2].reasoningEffort,'high');
});

test('a failed partial stream is retained as evidence and reset before a replacement response',async t=>{
  const fragment='Unfinished first stream fragment.',final='Fresh complete replacement reply.';
  const f=await fixture(t,async(request,count)=>{
    if(count===1){await request.onDelta(fragment);throw timeout();}
    assert.ok(!request.messages.some(message=>message.role==='assistant' && message.content===fragment),'failed fragments cannot masquerade as completed canonical replies');
    await request.onDelta(final);return answer(final);
  });
  const done=await settle(f.engine,f.store,await f.engine.start(BOT,'Produce a complete response after a stream interruption.'));
  assert.equal(done.status,'completed',done.error);assert.equal(done.output,final);assert.equal(done.partialOutput,final);
  assert.ok(JSON.stringify([done.events,f.store.state.messages[BOT]]).includes(fragment),'the failed available preview remains inspectable');
  assert.equal(f.requests.length,2);assert.ok(!done.output.includes(fragment));
});

test('safe startup recovery resumes automatically only after managers initialize and retains earlier committed effects',async t=>{
  let waiting=false;
  const f=await fixture(t,async(request,count)=>{
    if(count===1)return {text:'',toolCalls:[call('saved-before-crash','workspace_write',{path:'before-crash.txt',content:'Already committed before restart.'})]};
    waiting=true;await new Promise((resolve,reject)=>{request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});if(request.signal.aborted)reject(request.signal.reason);});
  });
  await f.engine.start(BOT,'Save the evidence and finish all remaining work.');await until(()=>waiting);
  const crashState=structuredClone(f.store.state);await f.engine.close();
  await f.store.mutate(state=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,structuredClone(crashState));});
  const reopened=await new Store(f.directory).init();let calls=0,writes=0;
  const recovered=new NativeEngine(reopened,{retryDelay:1,providers:{async complete(_connection,request){calls++;assert.ok(request.messages.some(message=>message.tool_call_id==='saved-before-crash'));return answer('Automatically completed after safe startup recovery.');}}});f.engines.push(recovered);
  const execute=recovered.tools.execute.bind(recovered.tools);recovered.tools.execute=async(...args)=>{if(args[1]==='workspace_write')writes++;return execute(...args);};
  await recovered.recover();assert.equal(calls,0,'recovery waits for manager initialization');
  assert.equal(typeof recovered.recoverAutonomous,'function');await recovered.recoverAutonomous();
  await until(()=>calls>0 && !isActive(current(reopened)));for(const promise of recovered.tasks.values())await promise;
  assert.equal(current(reopened).status,'completed',current(reopened).error);assert.equal(calls,1);assert.equal(writes,0);
  assert.equal(await fs.readFile(path.join(await getWorkspaceRoot(reopened,BOT),'before-crash.txt'),'utf8'),'Already committed before restart.');
});
