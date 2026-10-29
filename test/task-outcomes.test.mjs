import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeTaskOutcome, recordTaskOutcome, recordRoomOutcome, backfillTaskOutcomes } from '../lib/task-outcomes.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { Rooms } from '../lib/rooms.mjs';
import { Store } from '../lib/store.mjs';
import { listDocuments, writeDocument } from '../lib/sync/docs.mjs';

const AT='2026-10-27T12:00:00.000Z',LATER='2026-10-27T12:01:00.000Z';
const request=(runId,extra={})=>({id:`message_${runId}`,role:'user',content:'A fixture task',runId,createdAt:'2026-10-27T11:59:00.000Z',...extra});
const workspace=()=>({messages:{bot_a:[]},runs:{},runHistory:{},roomMessages:{},roomDrives:{},activity:[]});

test('terminal message metadata validates only bounded presentation fields',()=>{
  assert.equal(normalizeTaskOutcome({status:'running',finishedAt:AT}),null);
  assert.equal(normalizeTaskOutcome({status:'completed'}),null);
  assert.equal(normalizeTaskOutcome({status:'failed',finishedAt:'not a date'}),null);
  assert.deepEqual(normalizeTaskOutcome({status:'unknown',finishedAt:AT,error:'x'.repeat(800),checks:{passed:2,failed:1},approval:{tool:'shell_run'},output:'private'}),{
    status:'interrupted',finishedAt:AT,checks:{passed:2,failed:1},
  });
  assert.deepEqual(normalizeTaskOutcome({status:'completed',finishedAt:AT,checks:{passed:-1,failed:0}}),{status:'completed',finishedAt:AT});
  assert.deepEqual(normalizeTaskOutcome({status:'failed',finishedAt:AT,error:'Valid bounded error',checks:{passed:0,failed:0}}),{status:'failed',finishedAt:AT,error:'Valid bounded error'});
});

test('recording a terminal task redacts before truncation and syncs only the message summary',()=>{
  const state=workspace(),message=request('run_a');state.messages.bot_a.push(message);
  const secret='SECRET_VALUE',run={id:'run_a',status:'failed',finishedAt:AT,error:`${'x'.repeat(496)}${secret}`,roomId:'room_a',routineId:'routine_a',pending_controls:[{kind:'approval',token:'local-only'}],verification:{coverage:'declared_checks',checks:[{passed:true,predicate:{path:'local-only'}},{passed:false}]}},original=structuredClone(run);
  assert.equal(recordTaskOutcome(state,'bot_a',run,value=>value.replaceAll(secret,'[redacted]')),true);
  assert.deepEqual(message.taskOutcome,{status:'failed',finishedAt:AT,error:`${'x'.repeat(496)}[red`,checks:{passed:1,failed:1}});
  assert.equal(message.roomId,'room_a');assert.equal(message.routineId,'routine_a');assert.deepEqual(run,original);
  const replica=workspace();
  for(const [key,value] of listDocuments(state,{}))assert.equal(writeDocument(replica,key,value,{}),true);
  assert.deepEqual(replica.messages.bot_a[0],message);
  assert.deepEqual(replica.runs,{});assert.deepEqual(replica.activity,[]);assert.deepEqual(replica.runHistory,{});
  assert.ok(!JSON.stringify(replica).includes('local-only'));
});

test('migration keeps the earliest terminal audit timestamp and enriches it from local history',()=>{
  const state=workspace(),message=request('run_a');state.messages.bot_a.push(message);
  state.activity=[{type:'run.failed',botId:'bot_a',runId:'run_a',createdAt:LATER},{type:'run.failed',botId:'bot_a',runId:'run_a',createdAt:AT}];
  state.runHistory.bot_a=[{id:'run_a',status:'failed',finishedAt:LATER,error:'fixture secret',roomId:'room_a',verification:{coverage:'declared_checks',checks:[{passed:false}]}}];
  assert.equal(backfillTaskOutcomes(state,value=>value.replace('secret','[redacted]')),1);
  assert.deepEqual(message.taskOutcome,{status:'failed',finishedAt:AT,error:'fixture [redacted]',checks:{passed:0,failed:1}});
  assert.equal(message.roomId,'room_a');
  state.runs.bot_a={id:'run_a',status:'completed',finishedAt:LATER};
  assert.equal(backfillTaskOutcomes(state),0);assert.equal(message.taskOutcome.finishedAt,AT);assert.equal(message.taskOutcome.status,'failed');
});

test('question answers sharing a run id never receive task outcomes or originating context',()=>{
  const state=workspace(),origin=request('run_question'),answer=request('run_question',{id:'message_answer',kind:'answer',requestId:'question_a',content:'The owner answered the question'});
  // Even a reordered transcript must find the actual request, rather than the answer record.
  state.messages.bot_a=[answer,origin];
  const run={id:'run_question',status:'completed',finishedAt:AT,roomId:'room_a',routineId:'routine_a'};
  assert.equal(recordTaskOutcome(state,'bot_a',run),true);
  assert.deepEqual(origin.taskOutcome,{status:'completed',finishedAt:AT});assert.equal(origin.roomId,'room_a');assert.equal(origin.routineId,'routine_a');
  assert.equal(answer.taskOutcome,undefined);assert.equal(answer.roomId,undefined);assert.equal(answer.routineId,undefined);
  delete origin.taskOutcome;delete origin.roomId;delete origin.routineId;state.runs.bot_a=run;
  assert.equal(backfillTaskOutcomes(state),1);
  assert.deepEqual(origin.taskOutcome,{status:'completed',finishedAt:AT});assert.equal(origin.roomId,'room_a');
  assert.equal(answer.taskOutcome,undefined);assert.equal(answer.roomId,undefined);assert.equal(answer.routineId,undefined);
});

test('migration never guesses success from an orphan request, partial reply or arbitrary text',()=>{
  const state=workspace();state.messages.bot_a=[
    request('orphan'),request('legacy_done'),{id:'reply_done',role:'assistant',runId:'legacy_done',content:'Done',createdAt:AT},
    request('partial_success'),{id:'reply_partial_success',role:'assistant',runId:'partial_success',partial:true,runStatus:'completed',content:'I am done',createdAt:AT},
    request('partial_failed'),{id:'reply_failed',role:'assistant',runId:'partial_failed',partial:true,runStatus:'failed',content:'A partial answer',createdAt:AT},
    request('active'),
  ];state.runs.bot_a={id:'active',status:'running',updatedAt:AT};
  assert.equal(backfillTaskOutcomes(state),1);
  for(const id of ['orphan','legacy_done','partial_success','active'])assert.equal(state.messages.bot_a.find(item=>item.runId===id).taskOutcome,undefined);
  assert.deepEqual(state.messages.bot_a.find(item=>item.runId==='partial_failed').taskOutcome,{status:'failed',finishedAt:AT});
});

test('room migration requires terminal drive evidence and keeps aggregate outcomes separate',()=>{
  const state=workspace();state.roomMessages.room_a=[{id:'room_task_a',role:'user',driveId:'drive_a',content:'A room task'},{id:'room_task_b',role:'user',driveId:'drive_b',content:'An active room task'},{id:'member_done',role:'assistant',driveId:'drive_b',runId:'member_run',content:'My member turn finished',createdAt:AT}];
  state.activity=[{type:'room.failed',roomId:'room_a',driveId:'drive_a',createdAt:AT}];
  state.roomDrives.room_a={id:'drive_b',status:'running',updatedAt:LATER};
  assert.equal(backfillTaskOutcomes(state),1);assert.deepEqual(state.roomMessages.room_a[0].taskOutcome,{status:'failed',finishedAt:AT});assert.equal(state.roomMessages.room_a[1].taskOutcome,undefined);
  assert.equal(recordRoomOutcome(state,'room_a',{id:'drive_b',status:'cancelled',finishedAt:LATER}),true);
  assert.deepEqual(state.roomMessages.room_a[1].taskOutcome,{status:'cancelled',finishedAt:LATER});
});

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-task-outcomes-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init(),runtime=new NativeEngine(store);
  runtime.tools.recordEpisode=async()=>{};
  return {store,runtime,bot:store.state.bots[0]};
}

test('engine finish records a failure even without a partial assistant reply',async t=>{
  const {store,runtime,bot}=await fixture(t),run={id:'run_no_output',botId:bot.id,status:'running',createdAt:AT,updatedAt:AT,events:[],artifacts:[]};
  await store.mutate(state=>{state.runs[bot.id]=run;state.messages[bot.id]=[request(run.id)];});
  await runtime.finish({runId:run.id,sessionId:bot.id,bot,task:'A fixture task'},'failed',{error:'Provider refused the fixture request.'});
  const messages=store.state.messages[bot.id],outcome=messages[0].taskOutcome;
  assert.equal(messages.length,1);assert.equal(outcome.status,'failed');assert.equal(outcome.error,'Provider refused the fixture request.');assert.equal(outcome.finishedAt,store.state.runs[bot.id].finishedAt);
  assert.equal(store.state.activity[0].type,'run.failed');
});

test('restart recovery publishes interrupted task and room outcomes without replaying work',async t=>{
  const {store,runtime,bot}=await fixture(t);let replayed=0;runtime.providers={complete:async()=>{replayed++;throw new Error('No model request expected');}};
  runtime.browsers.recover=async()=>{};
  await store.mutate(state=>{
    state.runs[bot.id]={id:'run_restart',botId:bot.id,status:'waiting_for_approval',createdAt:AT,updatedAt:AT,events:[],pending_controls:[{kind:'approval',token:'must-stay-local'}]};state.messages[bot.id]=[request('run_restart')];
    state.roomDrives.room_a={id:'drive_restart',roomId:'room_a',status:'running',remaining:[bot.id],createdAt:AT,updatedAt:AT};state.roomMessages.room_a=[{id:'room_restart',role:'user',driveId:'drive_restart',content:'A room task'}];
  });
  await runtime.recover();const rooms=new Rooms(store,runtime);await rooms.recover();
  assert.equal(replayed,0);assert.equal(store.state.runs[bot.id].status,'interrupted');assert.equal(store.state.messages[bot.id][0].taskOutcome.status,'interrupted');assert.equal(store.state.roomMessages.room_a[0].taskOutcome.status,'interrupted');
  const before=structuredClone(store.state.messages);await runtime.recover();await rooms.recover();assert.deepEqual(store.state.messages,before);
  assert.ok(!JSON.stringify(store.state.messages).includes('must-stay-local'));
});
