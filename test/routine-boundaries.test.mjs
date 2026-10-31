import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { getWorkspaceRoot, writeWorkspace } from '../lib/agent-tools.mjs';
import { routineRuns, validateRoutine } from '../lib/routines.mjs';
import { newRoutineCheckpoint, resumableCheckpoint, requireRoutineCheckpoint, pruneRoutineCheckpoints } from '../lib/routine-checkpoints.mjs';
import { listDocuments } from '../lib/sync/docs.mjs';

const BOT='bot_atlas',ROUTINE='routine_boundaries_fixture',delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const call=(id,name,args)=>({id,name,arguments:args}),answer=text=>({text,toolCalls:[]});
async function until(predicate){const end=Date.now()+5000;while(Date.now()<end){const result=predicate();if(result)return result;await delay(5);}throw new Error('Routine boundary fixture timed out.');}
async function fixture(t,complete){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-routine-boundaries-')),store=await new Store(directory).init();let requests=0;
  await store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Fixture',defaultModel:'fixture-model',secret:store.seal('disposable-boundary-key')});Object.assign(state.bots.find(bot=>bot.id===BOT),{connectionId:'fixture-provider',tools:['workspace','automation'],approvalPolicy:'balanced',collaborators:[]});state.routines.push(validateRoutine({name:'Boundary fixture',botId:BOT,prompt:'Preserve completed notes and report the current result.',intervalMinutes:60,enabled:false},{id:ROUTINE}));});
  const engine=new NativeEngine(store,{runTimeout:10000,providers:{async complete(_connection,request){return complete(request,++requests);}}});
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});await engine.recover();
  const settled=async started=>{await until(()=>store.state.runs[BOT]?.id===started.id && !isActive(store.state.runs[BOT]));await engine.tasks.get(started.id);await store.queue;return store.state.runs[BOT];};
  return {store,engine,directory,settled};
}

test('continuation refuses an exact old write when its successful file changed and then reads the current file',async t=>{
  const write={path:'reports/boundary.txt',content:'Original committed evidence.'},changed='The owner changed this file after the failed attempt.';
  const f=await fixture(t,async(request,count)=>{
    if(count===1)return {text:'',toolCalls:[call('first-write','workspace_write',write)]};
    if(count===2)throw new HttpError(504,'Fixture generation timed out.');
    if(count===3)return {text:'Check the earlier write.',toolCalls:[call('repeat-under-new-id','workspace_write',write)]};
    if(count===4){const result=JSON.parse(request.messages.find(message=>message.tool_call_id==='repeat-under-new-id').content);assert.equal(result.errorCode,'stale_state');assert.match(result.error,/previously written file changed/);return {text:'Read its current contents.',toolCalls:[call('read-current','workspace_read',{path:write.path})]};}
    assert.equal(count,5);const result=JSON.parse(request.messages.find(message=>message.tool_call_id==='read-current').content);assert.equal(result.content,changed);return answer('The file changed after the earlier save. I read its current contents and preserved the owner’s update.');
  });
  let writes=0;const execute=f.engine.tools.execute.bind(f.engine.tools);
  // workspace_write historically returned no sha256. The engine must retain its
  // own committed-byte digest before making this result resumable.
  f.engine.tools.execute=async(...args)=>{const result=await execute(...args);if(args[1]==='workspace_write'){writes++;const {sha256,...withoutDigest}=result;return withoutDigest;}return result;};
  const failed=await f.settled(await f.engine.runRoutine(ROUTINE));assert.equal(failed.status,'failed');
  const checkpoint=f.store.state.routineRuntime[ROUTINE].checkpoint,retained=checkpoint.snapshot.completedEffects.find(([,effect])=>effect.path===write.path)?.[1];assert.match(retained.sha256,/^[a-f0-9]{64}$/);
  const routine=f.store.state.routines.find(item=>item.id===ROUTINE),row=routineRuns(f.store.state,routine)[0];assert.ok(row.resume?.checkpointId);
  const target=path.join(await getWorkspaceRoot(f.store,BOT),write.path);await fs.writeFile(target,changed);
  const done=await f.settled(await f.engine.resumeRoutine(ROUTINE,{runId:row.runId,checkpointId:row.resume.checkpointId}));
  assert.equal(done.status,'completed',done.error);assert.equal(writes,1,'the rejected replay never reaches the write tool');assert.equal(await fs.readFile(target,'utf8'),changed);assert.match(done.output,/preserved the owner/);
});

test('continuation snapshots and seen cursors never enter public state or replicated documents',async t=>{
  const f=await fixture(t,async()=>answer('Unused.')),marker='synthetic-engine-local-checkpoint-marker';
  await f.store.mutate(state=>{const routine=state.routines[0],bot=state.bots.find(item=>item.id===BOT),checkpoint=newRoutineCheckpoint(routine,bot,state.connections[0],{model:'fixture-model'});Object.assign(checkpoint,{runId:'run_private',status:'failed',snapshot:{system:marker,conversation:[],run:{}}});state.routineRuntime={[ROUTINE]:{checkpoint,workflowState:{seen:{feed:[marker]}}}};});
  const exposed=JSON.stringify(f.store.publicState()),replicated=JSON.stringify([...listDocuments(f.store.state,f.store,'wire')]);
  assert.ok(!exposed.includes(marker));assert.ok(!exposed.includes('routineRuntime'));assert.ok(!replicated.includes(marker));assert.ok(!replicated.includes('routineRuntime'));
  assert.ok(JSON.stringify(f.store.state.routineRuntime).includes(marker),'the private checkpoint remains available locally');
});

test('checkpoint pruning bounds count and bytes, keeps recent snapshots and leaves committed seen state intact',()=>{
  const make=(count,bytes)=>({routines:Array.from({length:count},(_,i)=>({id:`routine_${i}`})),routineRuntime:Object.fromEntries(Array.from({length:count},(_,i)=>[`routine_${i}`,{workflowState:{seen:{feed:[String(i)]}},checkpoint:{id:`checkpoint_${i}`,updatedAt:new Date(Date.UTC(2026,9,30,0,i)).toISOString(),snapshot:{payload:'x'.repeat(bytes)}}}]))});
  const count=make(15,1);count.routineRuntime.routine_removed={checkpoint:{snapshot:{payload:'obsolete'}}};pruneRoutineCheckpoints(count);
  const snapshots=Object.values(count.routineRuntime).filter(local=>local.checkpoint);assert.equal(snapshots.length,12);assert.ok(count.routineRuntime.routine_14.checkpoint);assert.equal(count.routineRuntime.routine_0.checkpoint,undefined);assert.equal(count.routineRuntime.routine_removed,undefined);
  assert.deepEqual(count.routineRuntime.routine_0.workflowState,{seen:{feed:['0']}},'pruning cannot forget processed items');
  const bytes=make(10,1_000_000);pruneRoutineCheckpoints(bytes);
  const retained=Object.values(bytes.routineRuntime).filter(local=>local.checkpoint);assert.ok(retained.length<10);assert.ok(retained.reduce((size,local)=>size+Buffer.byteLength(JSON.stringify(local.checkpoint)),0)<=8_000_000);assert.ok(bytes.routineRuntime.routine_9.checkpoint);assert.equal(Object.keys(bytes.routineRuntime).length,10);
});

test('changing a provider account invalidates continuation while credential rotation retains its identity',()=>{
  const bot={id:BOT,enabled:true,connectionId:'fixture-provider',tools:['workspace','automation']},connection={id:'fixture-provider',type:'chatgpt',baseUrl:'https://chatgpt.com/backend-api/codex',oauthAccount:{accountId:'synthetic-account-a'},oauthSecret:'synthetic-sealed-token-a'},routine={id:ROUTINE,botId:BOT,prompt:'Continue the same task.'};
  const checkpoint=newRoutineCheckpoint(routine,bot,connection,{model:'fixture-model'});Object.assign(checkpoint,{runId:'run_account',status:'failed',snapshot:{conversation:[],run:{}}});
  const state={bots:[bot],connections:[connection],routines:[routine],routineRuntime:{[ROUTINE]:{checkpoint}}},identity={runId:checkpoint.runId,checkpointId:checkpoint.id};
  assert.equal(requireRoutineCheckpoint(state,routine,identity),checkpoint);connection.oauthSecret='synthetic-rotated-token';assert.equal(resumableCheckpoint(state,routine,checkpoint.runId),checkpoint);
  connection.oauthAccount={accountId:'synthetic-account-b'};assert.equal(resumableCheckpoint(state,routine,checkpoint.runId),null);assert.throws(()=>requireRoutineCheckpoint(state,routine,identity),error=>error.status===409);
});

test('report continuation rechecks a saved report after interrupted finalization and preserves later file changes',async t=>{
  let models=0;const f=await fixture(t,async()=>{models++;assert.fail('A deterministic report must not call a model.');});
  await f.store.mutate(state=>{state.connections=[];state.bots.find(bot=>bot.id===BOT).connectionId='';const index=state.routines.findIndex(routine=>routine.id===ROUTINE);state.routines[index]=validateRoutine({workflow:{version:1,mode:'report',steps:[{id:'input',op:'read',path:'fixtures/report-input.json'},{id:'items',op:'json',from:'input',path:'content'},{id:'fresh',op:'select',from:'items',key:'id',limit:10}],skipIfEmpty:'fresh',report:'New report items: {{fresh}}',savePath:'reports/finalized.txt'}},state.routines[index]);});
  await writeWorkspace(f.store,BOT,'fixtures/report-input.json',JSON.stringify([{id:'synthetic-new-item',title:'Verified fixture entry'}]));
  const closeRun=f.engine.backgroundProcesses.closeRun.bind(f.engine.backgroundProcesses);let interrupted=false,writes=0;
  f.engine.backgroundProcesses.closeRun=async(runId,options)=>{if(!interrupted && options?.reason==='Owning task completed.'){interrupted=true;throw new Error('Fixture finalization failed after saving the report.');}return closeRun(runId,options);};
  const execute=f.engine.tools.execute.bind(f.engine.tools);f.engine.tools.execute=async(...args)=>{if(args[1]==='workspace_write')writes++;return execute(...args);};
  const first=await f.settled(await f.engine.runRoutine(ROUTINE));assert.equal(first.status,'failed');assert.match(first.error,/Fixture finalization failed/);assert.equal(writes,1);
  const local=f.store.state.routineRuntime[ROUTINE],checkpoint=local.checkpoint;assert.match(checkpoint.snapshot.workflowSaved,/^[a-f0-9]{64}$/);assert.match(checkpoint.snapshot.finalOutput,/Verified fixture entry/);assert.equal(local.workflowState,undefined,'a finalization failure cannot commit processed items');
  const routine=f.store.state.routines.find(item=>item.id===ROUTINE),row=routineRuns(f.store.state,routine)[0];assert.ok(row.resume?.checkpointId);
  const changed='The owner changed this report after its save checkpoint.';await writeWorkspace(f.store,BOT,'reports/finalized.txt',changed);
  const resumed=await f.settled(await f.engine.resumeRoutine(ROUTINE,{runId:row.runId,checkpointId:row.resume.checkpointId}));
  assert.equal(resumed.status,'failed');assert.match(resumed.error,/saved routine report changed after its checkpoint/);assert.equal(writes,1,'resume must not overwrite the changed report');assert.equal(models,0);assert.equal(await fs.readFile(path.join(await getWorkspaceRoot(f.store,BOT),'reports/finalized.txt'),'utf8'),changed);assert.equal(f.store.state.routineRuntime[ROUTINE].workflowState,undefined,'failed verification cannot consume prepared items');
});
