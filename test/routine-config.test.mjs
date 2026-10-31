import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { validateRoutine, routineRuns } from '../lib/routines.mjs';
import { DEFAULT_ROUTINE_LIMITS, newRoutineCheckpoint, validateRoutineLimits, routineIdentity } from '../lib/routine-checkpoints.mjs';
import { setupApprovalSummary, selfManagementGuidance } from '../lib/setup-tools.mjs';

const base={name:'Feed check',botId:'bot_atlas',prompt:'Review new items.',schedule:{kind:'interval',minutes:15},timezone:'UTC',enabled:true};
const workflow={version:1,mode:'agent',steps:[{id:'feed',op:'read',path:'feeds/updates.json'},{id:'items',op:'json',from:'feed',path:'content'},{id:'fresh',op:'select',from:'items',key:'url',limit:20}],skipIfEmpty:'fresh',context:'Review {{fresh}}.'};
const report={version:1,mode:'report',steps:[{id:'feed',op:'read',path:'feeds/status.txt'}],report:'Status: {{feed}}'};

test('routine validation normalizes explicit execution configuration and preserves omitted configuration',()=>{
  const normalized=validateRoutine({...base,workflow,limits:{runtimeMinutes:60}},{id:'routine_feed'});
  assert.deepEqual(normalized.limits,{mode:'autonomous',runtimeMinutes:60,modelTurns:50,toolCalls:200});
  assert.deepEqual(validateRoutineLimits(),DEFAULT_ROUTINE_LIMITS);assert.equal(validateRoutineLimits({runtimeMinutes:30,modelTurns:50,toolCalls:200}).mode,'autonomous','old numeric defaults do not choose bounded execution');
  assert.deepEqual(validateRoutineLimits({mode:'bounded',runtimeMinutes:60}),{mode:'bounded',runtimeMinutes:60,modelTurns:50,toolCalls:200});
  assert.equal(routineIdentity(base),routineIdentity({...base,limits:{runtimeMinutes:30,modelTurns:50,toolCalls:200}}),'omitted mode and legacy defaults have the same execution identity');
  assert.equal(normalized.workflow.version,1);assert.equal(normalized.workflow.mode,'agent');assert.ok(Object.isFrozen(normalized.workflow));
  const paused=validateRoutine({enabled:false},normalized);
  assert.deepEqual(paused.limits,normalized.limits);assert.equal(paused.workflow,normalized.workflow);assert.equal(paused.nextRunAt,null);
  const removed=validateRoutine({workflow:null},normalized);
  assert.equal(removed.workflow,undefined);assert.equal(normalized.workflow.mode,'agent','normalization never mutates the prior routine');
  const legacy=validateRoutine(base,{id:'routine_legacy'});assert.equal(legacy.limits,undefined,'an omitted configuration does not rewrite an existing identity');
  for(const limits of [null,{runtimeMinutes:121},{modelTurns:0},{toolCalls:1001},{runtimeMinutes:1.2},{shell:true},{mode:'unlimited'},{mode:null}])assert.throws(()=>validateRoutine({...base,limits}),/whole number|routine limits|execution mode/);
  assert.throws(()=>validateRoutine({...base,workflow:{version:1,steps:[{id:'unsafe',op:'shell',command:'echo nope'}]}}),/Step operation/);
  assert.throws(()=>validateRoutine({...base,workflow:{version:1,steps:[{id:'unsafe',op:'read',path:'../state.json'}]}}),/workspace path/);
});

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-routine-config-')),store=await new Store(directory).init();
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  await store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Fixture',defaultModel:'fixture-model',secret:store.seal('fixture-routine-config-secret')});for(const bot of state.bots){bot.connectionId='fixture-provider';bot.tools=['workspace','automation'];bot.approvalPolicy='balanced';}});
  return {store,tools:new AgentTools(store),bot:store.state.bots[0]};
}

test('chat tools accept workflow and budgets only after exact approval and list effective legacy defaults',async t=>{
  const {store,tools,bot}=await fixture(t),args={name:base.name,prompt:base.prompt,schedule:base.schedule,workflow,limits:{mode:'bounded',runtimeMinutes:90,modelTurns:100,toolCalls:400}};
  for(const name of ['routines_create','routines_update']){
    const definition=tools.definitions(bot).find(item=>item.name===name);assert.ok(definition.parameters.properties.workflow);assert.equal(definition.parameters.properties.limits.additionalProperties,false);assert.deepEqual(definition.parameters.properties.limits.properties.mode.enum,['autonomous','bounded']);
    assert.equal(tools.requiresApproval(name,bot),true);
  }
  await assert.rejects(tools.execute(bot,'routines_create',args),/approval/);assert.equal(store.state.routines.length,0);
  const result=await tools.execute(bot,'routines_create',args,{approved:true}),routine=result.routine;
  assert.deepEqual(routine.limits,args.limits);assert.equal(routine.workflow.skipIfEmpty,'fresh');assert.deepEqual(bot.tools,['workspace','automation']);
  await assert.rejects(tools.execute(bot,'routines_update',{routineId:routine.id,workflow:report}),/approval/);
  const updated=await tools.execute(bot,'routines_update',{routineId:routine.id,workflow:report,limits:{runtimeMinutes:45}},{approved:true});
  assert.equal(updated.routine.workflow.mode,'report');assert.deepEqual(updated.routine.limits,{mode:'autonomous',runtimeMinutes:45,modelTurns:50,toolCalls:200});
  await tools.execute(bot,'routines_update',{routineId:routine.id,workflow:null},{approved:true});
  assert.equal(store.state.routines[0].workflow,undefined);
  await store.mutate(state=>state.routines.push({...base,id:'routine_legacy'}));
  const listed=await tools.execute(bot,'routines_list',{});
  assert.deepEqual(listed.routines.find(item=>item.id==='routine_legacy').limits,DEFAULT_ROUTINE_LIMITS);
  assert.equal(store.state.routines.find(item=>item.id==='routine_legacy').limits,undefined,'listing does not mutate persisted configuration');
  const teammate=store.state.bots[1];await assert.rejects(tools.execute(teammate,'routines_update',{routineId:routine.id,limits:{runtimeMinutes:120}},{approved:true}),error=>error.status===403);
});

test('routine approval descriptions show execution budgets and agent versus report behavior',()=>{
  const state={bots:[],routines:[{id:'routine_feed',name:'Feed check'}],settings:{}};
  const create=setupApprovalSummary(state,'routines_create',{...base,workflow:report,limits:{mode:'bounded',runtimeMinutes:90}});
  assert.match(create,/90 min, 50 model turns, 200 tool calls/);assert.match(create,/Deterministic report.*1 steps/);
  const update=setupApprovalSummary(state,'routines_update',{routineId:'routine_feed',workflow,limits:{mode:'bounded',runtimeMinutes:120,modelTurns:200,toolCalls:1000}});
  assert.match(update,/120 min, 200 model turns, 1000 tool calls/);assert.match(update,/Prepare data, then ask the bot/);assert.match(update,/skip unchanged items/);
  assert.match(setupApprovalSummary(state,'routines_update',{routineId:'routine_feed',workflow:null}),/use an agent task/);
  const automatic=setupApprovalSummary(state,'routines_update',{routineId:'routine_feed',limits:{runtimeMinutes:30}});assert.match(automatic,/work until done.*recover automatically/);assert.doesNotMatch(automatic,/30 min/);
  const guidance=selfManagementGuidance(['automation']);assert.match(guidance,/Report mode renders.*without a model/);assert.match(guidance,/source failure is not evidence that nothing changed/);assert.match(guidance,/never grant tools or waive exact action approvals/);assert.doesNotMatch(guidance,/every run uses model credits/);
  assert.match(guidance,/Do not ask the owner.*approve execution continuation/);assert.match(guidance,/Stop remains available/);assert.match(guidance,/Set limits.mode to bounded only when the owner explicitly requests/);
});

test('history offers only the exact local resumable checkpoint and explains blocked continuations',async t=>{
  const {store,bot}=await fixture(t),routine=validateRoutine({...base,workflow},{id:'routine_feed'}),runId='run_failed';
  await store.mutate(state=>{
    state.routines.push(routine);state.messages[bot.id]=[{role:'user',routineId:routine.id,runId,createdAt:'2026-10-30T10:00:00Z'},{role:'assistant',runId,content:'Partial report.',partial:true,runStatus:'failed'}];
    state.runHistory={[bot.id]:[{id:runId,status:'failed'}]};
    const checkpoint=newRoutineCheckpoint(routine,bot,state.connections[0],{model:'fixture-model'});Object.assign(checkpoint,{runId,status:'failed',snapshot:{}});state.routineRuntime={[routine.id]:{checkpoint}};
  });
  const checkpoint=store.state.routineRuntime[routine.id].checkpoint;
  assert.equal(checkpoint.schemaVersion,2);assert.equal(checkpoint.automatic,true);assert.equal(newRoutineCheckpoint({...routine,limits:{mode:'bounded'}},bot,store.state.connections[0],{model:'fixture-model'}).automatic,false);
  assert.deepEqual(routineRuns(store.state,routine)[0].resume,{checkpointId:checkpoint.id});
  const remote={...store.state,routineRuntime:{}};assert.equal(routineRuns(remote,routine)[0].resume,undefined);
  checkpoint.runId='run_other';assert.equal(routineRuns(store.state,routine)[0].resume,undefined);checkpoint.runId=runId;
  checkpoint.blocked='Inspect an action whose outcome is unknown before continuing.';
  const blocked=routineRuns(store.state,routine)[0];assert.equal(blocked.resume,undefined);assert.equal(blocked.resumeUnavailable,checkpoint.blocked);delete checkpoint.blocked;
  const changed={...routine,prompt:'A different task.'};assert.equal(routineRuns(store.state,changed)[0].resume,undefined);
  checkpoint.status='running';assert.equal(routineRuns(store.state,routine)[0].resume,undefined);
});
