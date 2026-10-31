import test from 'node:test';
import assert from 'node:assert/strict';
import {upgradeReasoningPreference} from '../lib/store.mjs';
import { newTaskCheckpoint, resumableTaskCheckpoint, pruneTaskCheckpoints } from '../lib/task-checkpoints.mjs';

function fixture(){
  const bot={id:'bot_fixture',enabled:true,connectionId:'connection_fixture',tools:['workspace'],approvalPolicy:'strict',model:'next-model',reasoningEffort:'high',instructions:'Synthetic instructions.'};
  const connection={id:'connection_fixture',type:'custom',baseUrl:'https://provider.invalid/v1',secret:'synthetic-sealed-value'};
  const inference={model:'original-model',reasoningEffort:'low',reasoning:{supported:true,efforts:['low','high']}};
  const checkpoint=newTaskCheckpoint({bot,connection,inference,runId:'run_fixture',sessionId:bot.id,task:'Finish the synthetic task.'});
  checkpoint.status='interrupted';checkpoint.snapshot={lane:'chat',conversation:[{role:'user',content:checkpoint.task}],run:{source:'chat',plan:{steps:[{id:'remaining',status:'in_progress'}]}}};
  const state={bots:[bot],connections:[connection],runs:{[bot.id]:{id:checkpoint.runId,status:'interrupted',source:'chat'}},taskCheckpoints:{[bot.id]:checkpoint}};
  return {bot,connection,inference,checkpoint,state};
}

test('direct owner recovery keeps its admitted inference snapshot and does not mutate saved state',()=>{
  const f=fixture(),before=JSON.stringify(f.state);
  assert.equal(resumableTaskCheckpoint(f.state,f.bot.id),f.checkpoint);
  assert.equal(JSON.stringify(f.state),before);
  f.bot.model='another-next-model';f.bot.reasoningEffort='high';f.bot.hidden=true;
  assert.equal(resumableTaskCheckpoint(f.state,f.bot.id)?.inference.model,'original-model');
  f.inference.model='mutated-caller';assert.equal(f.checkpoint.inference.model,'original-model');
  assert.ok(!JSON.stringify(f.checkpoint).includes(f.connection.secret));
});

test('checkpoint creation bounds original task text and rejects a different chat lane',()=>{
  const f=fixture(),input={bot:f.bot,connection:f.connection,inference:f.inference,runId:'new_run',sessionId:f.bot.id,task:'x'.repeat(100_100)};
  assert.equal(newTaskCheckpoint(input).task.length,100_000);
  assert.throws(()=>newTaskCheckpoint({...input,sessionId:'room_fixture'}),/direct owner chat/);
});

test('legacy checkpoints, unfinished snapshots and replaced tasks cannot resurrect work',async t=>{
  const cases=[
    ['legacy',f=>delete f.checkpoint.schemaVersion],['not automatic',f=>f.checkpoint.automatic=false],
    ['no snapshot',f=>delete f.checkpoint.snapshot],['blocked',f=>f.checkpoint.blocked='Unknown external action.'],
    ['not interrupted',f=>f.checkpoint.status='running'],['newer task',f=>f.state.runs[f.bot.id].id='newer_run'],
    ['missing task',f=>delete f.state.runs[f.bot.id]],['different bot key',f=>f.checkpoint.botId='another_bot'],
  ];
  for(const [name,change] of cases)await t.test(name,()=>{const f=fixture();change(f);assert.equal(resumableTaskCheckpoint(f.state,f.bot.id),null);});
});

test('Stop and terminal task states always defeat checkpoint recovery',async t=>{
  for(const change of [f=>f.checkpoint.stopRequested=true,f=>f.state.runs[f.bot.id].stopRequested=true,f=>f.state.runs[f.bot.id].status='stopping',f=>f.state.runs[f.bot.id].status='cancelled',f=>f.state.runs[f.bot.id].status='completed',f=>f.checkpoint.status='cancelled',f=>f.checkpoint.status='completed'])await t.test(()=>{const f=fixture();change(f);assert.equal(resumableTaskCheckpoint(f.state,f.bot.id),null);});
});

test('permission, instructions, provider account and destination changes invalidate recovery',async t=>{
  const cases=[
    ['paused bot',f=>f.bot.enabled=false],['tools',f=>f.bot.tools.push('terminal')],['approval',f=>f.bot.approvalPolicy='balanced'],
    ['instructions',f=>f.bot.instructions='Changed instructions.'],['destination',f=>f.connection.baseUrl='https://another.invalid/v1'],
    ['provider',f=>f.connection.type='openai'],['account',f=>f.connection.oauthAccount={id:'synthetic-other-account'}],
    ['missing provider',f=>f.state.connections=[]],['missing bot',f=>f.state.bots=[]],
  ];
  for(const [name,change] of cases)await t.test(name,()=>{const f=fixture();change(f);assert.equal(resumableTaskCheckpoint(f.state,f.bot.id),null);});
  const f=fixture();f.connection.secret='synthetic-rotated-seal';assert.equal(resumableTaskCheckpoint(f.state,f.bot.id),f.checkpoint,'credential renewal stays provider-owned');
});

test('room, routine, delegated and external chat snapshots cannot use owner recovery',async t=>{
  for(const change of [f=>f.checkpoint.sessionId='telegram_fixture',f=>f.checkpoint.source='routine',f=>f.checkpoint.snapshot.lane='room',f=>f.checkpoint.snapshot.run.source='delegation',f=>f.checkpoint.snapshot.run.routineId='routine_fixture',f=>f.checkpoint.snapshot.run.sessionId='telegram_fixture',f=>f.state.runs[f.bot.id].source='telegram',f=>f.state.runs[f.bot.id].roomId='room_fixture'])await t.test(()=>{const f=fixture();change(f);assert.equal(resumableTaskCheckpoint(f.state,f.bot.id),null);});
});

function collection(count,bytes=0){
  const state={bots:[],runs:{},taskCheckpoints:{}};
  for(let index=0;index<count;index++){
    const botId=`bot_${index}`,runId=`run_${index}`;state.bots.push({id:botId});state.runs[botId]={id:runId,status:'interrupted'};
    state.taskCheckpoints[botId]={botId,runId,status:'interrupted',updatedAt:new Date(1000*index).toISOString(),snapshot:{text:'x'.repeat(bytes)}};
  }
  return state;
}

test('pruning keeps active checkpoints ahead of newer failed work and limits retained count',()=>{
  const state=collection(15);state.taskCheckpoints.bot_0.status='running';state.runs.bot_0.status='running';
  pruneTaskCheckpoints(state);assert.equal(Object.keys(state.taskCheckpoints).length,12);assert.ok(state.taskCheckpoints.bot_0);assert.ok(state.taskCheckpoints.bot_14);assert.equal(state.taskCheckpoints.bot_1,undefined);assert.equal(state.taskCheckpoints.bot_2,undefined);assert.equal(state.taskCheckpoints.bot_3,undefined);
});

test('pruning bounds each checkpoint and aggregate bytes while keeping newest fitting entries',()=>{
  const state=collection(7,1_500_000);state.taskCheckpoints.bot_6.snapshot.text='x'.repeat(2_000_001);
  pruneTaskCheckpoints(state);
  assert.equal(state.taskCheckpoints.bot_6,undefined);assert.equal(Object.keys(state.taskCheckpoints).length,5);
  assert.ok(Buffer.byteLength(JSON.stringify(state.taskCheckpoints))<=8_000_000);assert.equal(state.taskCheckpoints.bot_0,undefined);assert.ok(state.taskCheckpoints.bot_5);
});

test('pruning removes deleted bots, replaced tasks, completion and Stop tombstones',()=>{
  const state=collection(7);state.bots=state.bots.filter(bot=>bot.id!=='bot_0');state.runs.bot_1.status='completed';state.runs.bot_2.stopRequested=true;state.taskCheckpoints.bot_3.status='cancelled';state.runs.bot_4.id='newer_run';state.runs.bot_5.status='stopping';
  pruneTaskCheckpoints(state);assert.deepEqual(Object.keys(state.taskCheckpoints),['bot_6']);
  const empty={};pruneTaskCheckpoints(empty);assert.deepEqual(empty,{});
});


test('reasoning default migration preserves safe checkpoint identity and original concrete inference',()=>{
  const f=fixture();f.bot.reasoningEffort='';
  upgradeReasoningPreference(f.bot);
  assert.equal(f.bot.reasoningEffort,'auto');assert.equal(f.bot.reasoningEffortVersion,1);
  assert.equal(resumableTaskCheckpoint(f.state,f.bot.id),f.checkpoint);
  assert.equal(f.checkpoint.inference.reasoningEffort,'low');
});
