import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { describeSchedule, nextRun, validateSchedule, zonedInstant } from '../lib/schedule.mjs';
import { routineRuns, validateRoutine } from '../lib/routines.mjs';
import { dashboard } from '../lib/dashboard.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=4000) {const until=Date.now()+timeout;while(Date.now()<until){const result=predicate();if(result)return result;await delay(5);}throw new Error('Fixture timed out waiting for agent state.');}
const at=value=>Date.parse(value);
const WARSAW='Europe/Warsaw';

test('schedules validate strictly and describe themselves plainly',()=>{
  assert.deepEqual(validateSchedule({kind:'weekly',time:'08:30',days:['fri','mon']}),{kind:'weekly',time:'08:30',days:['mon','fri']});
  assert.deepEqual(validateSchedule({kind:'once',at:'2026-11-02T09:00'}),{kind:'once',at:'2026-11-02T09:00'});
  for(const [input,message] of [[{kind:'interval',minutes:4},/5–525600/],[{kind:'daily',time:'24:00'},/time of day/],[{kind:'daily',time:'08:30',days:['mon']},/unknown fields/],
    [{kind:'weekly',time:'08:30',days:[]},/weekdays/],[{kind:'weekly',time:'08:30',days:['mon','mon']},/weekdays/],[{kind:'once',at:'2026-02-30T09:00'},/local date and time/],[{kind:'cron',expr:'* * * * *'},/interval, daily, weekly or once/]])
    assert.throws(()=>validateSchedule(input),message);
  assert.equal(describeSchedule({kind:'weekly',time:'08:30',days:['mon','tue','wed','thu','fri']},WARSAW),'Weekdays at 08:30 (Europe/Warsaw)');
  assert.equal(describeSchedule({kind:'weekly',time:'18:00',days:['tue','thu']}),'Tue, Thu at 18:00');
  assert.equal(describeSchedule({kind:'interval',minutes:90}),'Every 90 minutes');
});

test('clock schedules keep wall-clock time across daylight-saving changes and never run one date twice',()=>{
  const daily={kind:'daily',time:'08:30'};
  // Spring forward (29 March 2026): 08:30 is now CEST, UTC+2.
  assert.deepEqual(nextRun(daily,WARSAW,{now:at('2026-03-28T09:00:00Z')}),{at:'2026-03-29T06:30:00.000Z',slot:'2026-03-29'});
  // A time inside the skipped hour moves forward by the jump.
  assert.equal(new Date(zonedInstant(2026,3,29,2,30,WARSAW)).toISOString(),'2026-03-29T01:30:00.000Z');
  // Fall back (25 October 2026): 02:30 happens twice; it runs once, then the next date.
  const repeated={kind:'daily',time:'02:30'},first=nextRun(repeated,WARSAW,{now:at('2026-10-24T12:00:00Z')});
  assert.equal(first.slot,'2026-10-25');
  assert.equal(nextRun(repeated,WARSAW,{now:at(first.at)-3_600_000,afterSlot:first.slot}).slot,'2026-10-26','an earlier copy of the same local time is not a second run');
  // Weekly days across a year end, in another zone.
  assert.deepEqual(nextRun({kind:'weekly',time:'09:00',days:['mon','fri']},'America/New_York',{now:at('2026-12-31T23:00:00Z')}),{at:'2027-01-01T14:00:00.000Z',slot:'2027-01-01'});
  assert.equal(nextRun({kind:'weekly',time:'09:00',days:['mon']},'America/New_York',{now:at('2027-01-01T15:00:00Z')}).at,'2027-01-04T14:00:00.000Z');
  // Once is once.
  assert.equal(nextRun({kind:'once',at:'2026-11-02T09:00'},'Asia/Tokyo').at,'2026-11-02T00:00:00.000Z');
  assert.equal(nextRun({kind:'once',at:'2026-11-02T09:00'},'Asia/Tokyo',{afterSlot:'2026-11-02'}),null);
  assert.equal(nextRun({kind:'interval',minutes:30},WARSAW,{now:at('2026-10-27T10:00:00Z')}).at,'2026-10-27T10:30:00.000Z');
});

test('routine validation keeps old interval routines working, plans the next run and refuses the impossible',()=>{
  const now=at('2026-10-27T10:00:00Z'),base={name:'Digest',botId:'bot_atlas',prompt:'Summarize.'};
  const legacy=validateRoutine({...base,intervalMinutes:60,enabled:true},{},{now,timeZone:WARSAW});
  assert.deepEqual(legacy.schedule,{kind:'interval',minutes:60});assert.equal(legacy.nextRunAt,'2026-10-27T11:00:00.000Z');assert.equal(legacy.missed,'once');assert.equal(legacy.timezone,WARSAW);
  const weekly=validateRoutine({...base,schedule:{kind:'weekly',time:'08:30',days:['wed']},timezone:WARSAW,enabled:true},{},{now});
  assert.equal(weekly.nextRunAt,'2026-10-28T07:30:00.000Z');assert.equal(weekly.nextSlot,'2026-10-28');assert.equal(weekly.intervalMinutes,10080,'older engines see a sensible period');
  const paused=validateRoutine({enabled:false},weekly,{now});assert.equal(paused.nextRunAt,null);
  const moved=validateRoutine({schedule:{kind:'daily',time:'12:00'}},{...weekly,lastSlot:'2026-10-27'},{now});
  assert.equal(moved.lastSlot,undefined,'a new schedule starts its slots afresh');assert.equal(moved.nextRunAt,'2026-10-27T11:00:00.000Z');
  assert.throws(()=>validateRoutine({...base,schedule:{kind:'once',at:'2026-10-27T09:00'},timezone:WARSAW,enabled:true},{},{now}),/in the future/);
  assert.throws(()=>validateRoutine({...base,timezone:'Mars/Olympus'},{},{now}),/valid time zone/);
  assert.throws(()=>validateRoutine({...base,missed:'twice'},{},{now}),/run it once or skip it/);
});

test('a routine\'s history comes from synced messages, with run details where this engine ran it',()=>{
  const state={messages:{bot_atlas:[
    {id:'m1',role:'user',routineId:'routine_a',runId:'run_1',createdAt:'2026-10-26T07:30:00Z',content:'Digest'},{id:'m2',role:'assistant',runId:'run_1',content:'All quiet.',createdAt:'2026-10-26T07:31:00Z'},
    {id:'m3',role:'user',routineId:'routine_b',runId:'run_x',content:'Other routine'},
    {id:'m4',role:'user',routineId:'routine_a',runId:'run_2',createdAt:'2026-10-27T07:30:00Z',content:'Digest'},{id:'m5',role:'assistant',runId:'run_2',partial:true,runStatus:'failed',content:'Half'},
    {id:'m6',role:'user',routineId:'routine_a',runId:'run_3',createdAt:'2026-10-27T09:00:00Z',content:'Digest'},
  ]},runHistory:{bot_atlas:[{id:'run_2',status:'failed',durationMs:4000,usage:{input_tokens:10},error:'Provider unavailable.'}]},runs:{bot_atlas:{id:'run_3',status:'running'}}};
  const runs=routineRuns(state,{id:'routine_a',botId:'bot_atlas'});
  assert.deepEqual(runs.map(run=>[run.runId,run.status]),[['run_3','running'],['run_2','failed'],['run_1','completed']]);
  assert.equal(runs[1].durationMs,4000);assert.equal(runs[1].error,'Provider unavailable.');assert.equal(runs[2].preview,'All quiet.');
});

async function fixture(t,complete=async()=>({text:'Routine done.',toolCalls:[]})) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-routines-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'native-provider',type:'openai',name:'Fixture',model:'test-model',secret:store.seal('fixture-private-key')});for(const bot of state.bots){bot.connectionId='native-provider';bot.tools=['workspace','memory','automation'];bot.collaborators=[];bot.approvalPolicy='balanced';}});
  const engine=new NativeEngine(store,{runTimeout:10_000,providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length);}}});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,requests};
}
const due=(minutesAgo,extra={})=>({id:'routine_daily',name:'Morning digest',botId:'bot_atlas',prompt:'Summarize what changed.',enabled:true,schedule:{kind:'daily',time:'08:30'},timezone:WARSAW,missed:'once',intervalMinutes:1440,nextRunAt:new Date(Date.now()-minutesAgo*60_000).toISOString(),nextSlot:'2026-10-27',...extra});
const routine=store=>store.state.routines.find(item=>item.id==='routine_daily');
const routineRequests=store=>store.state.messages.bot_atlas?.filter(message=>message.routineId==='routine_daily').length || 0;

test('a due clock routine runs once, records its date and moves to the next one',async t=>{
  const {engine,store}=await fixture(t);
  await store.mutate(state=>{state.routines.push(due(1));});
  engine.schedulerStartedAt=Date.now()-3_600_000;
  await engine.tick();await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  await engine.tick();await delay(20);
  assert.equal(routineRequests(store),1,'a second tick does not run it again');
  assert.equal(routine(store).lastSlot,'2026-10-27');assert.ok(Date.parse(routine(store).nextRunAt)>Date.now());assert.notEqual(routine(store).nextSlot,'2026-10-27');
  assert.equal(store.state.runHistory.bot_atlas[0].routineId,'routine_daily');
});

test('a run missed while Tupies was offline runs once when it is back, or is skipped, as chosen',async t=>{
  const {engine,store}=await fixture(t);
  // Due three days ago; this engine only started scheduling now.
  await store.mutate(state=>{state.routines.push(due(3*1440,{nextSlot:'2026-10-24'}));});
  await engine.tick();await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  await engine.tick();await delay(20);
  assert.equal(routineRequests(store),1,'several missed dates still mean one catch-up run');
  assert.ok(Date.parse(routine(store).nextRunAt)>Date.now());

  await store.mutate(state=>{state.routines=[due(3*1440,{id:'routine_daily',missed:'skip',nextSlot:'2026-10-24'})];});
  await engine.tick();await delay(20);
  assert.equal(routineRequests(store),1,'a skipped run does not start a task');
  assert.equal(routine(store).missedRuns,1);assert.equal(routine(store).lastSlot,'2026-10-24');assert.ok(Date.parse(routine(store).nextRunAt)>Date.now());
  assert.ok(store.state.activity.some(item=>item.type==='routine.missed'));
});

test('a busy bot defers its routine without counting it as missed; a one-time routine then finishes',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const {engine,store}=await fixture(t,async(request,count)=>{if(count===1)await gate;return {text:'Done.',toolCalls:[]};});
  await engine.start('bot_atlas','A long chat task.');
  await store.mutate(state=>{state.routines.push(due(1,{missed:'skip',schedule:{kind:'once',at:'2026-10-27T08:30'}}));});
  engine.schedulerStartedAt=Date.now()-3_600_000;
  await engine.tick();assert.equal(routineRequests(store),0);assert.equal(routine(store).missedRuns,undefined);
  release();await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  await engine.tick();await waitFor(()=>routineRequests(store)===1 && store.state.runs.bot_atlas?.status==='completed');
  assert.equal(routine(store).enabled,false);assert.equal(routine(store).nextRunAt,null);assert.ok(routine(store).completedAt);
});

test('Run now keeps a clock schedule\'s next time but restarts an interval',async t=>{
  const {engine,store}=await fixture(t);
  await store.mutate(state=>{state.routines.push(due(-600,{nextSlot:'2026-10-28'}),{id:'routine_hourly',name:'Hourly',botId:'bot_nova',prompt:'Check.',enabled:true,schedule:{kind:'interval',minutes:60},timezone:WARSAW,intervalMinutes:60,nextRunAt:new Date(Date.now()+50*60_000).toISOString()});});
  const before=routine(store).nextRunAt;
  await engine.runRoutine('routine_daily');await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  assert.equal(routine(store).nextRunAt,before);assert.equal(routine(store).lastSlot,undefined);
  await engine.runRoutine('routine_hourly');await waitFor(()=>store.state.runs.bot_nova?.status==='completed');
  assert.ok(Math.abs(Date.parse(store.state.routines[1].nextRunAt)-(Date.now()+3_600_000))<5000);
});

test('a bot schedules a weekday routine in the owner\'s time zone, and the approval says when',async t=>{
  const call={id:'schedule',name:'routines_create',arguments:{name:'Standup notes',prompt:'Collect yesterday\'s notes.',schedule:{kind:'weekly',time:'09:15',days:['mon','tue','wed','thu','fri']}}};
  const {engine,store,requests}=await fixture(t,async(request,count)=>count===1?{text:'',toolCalls:[call]}:{text:'Scheduled.',toolCalls:[]});
  await store.mutate(state=>{state.settings.timezone='America/New_York';state.bots[0].approvalPolicy='strict';});
  await engine.start('bot_atlas','Every weekday at 9:15 collect my notes.');
  await waitFor(()=>store.state.runs.bot_atlas?.status==='waiting_for_approval');
  assert.match(requests[0].turnContext,/The owner's time zone is America\/New_York; their local time is \d{4}-\d{2}-\d{2} \d{2}:\d{2}\./);
  assert.match(dashboard(store).needs[0].title,/Schedule “Standup notes”: Weekdays at 09:15 \(America\/New_York\)/);
  const run=store.state.runs.bot_atlas;
  await engine.control('bot_atlas','approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation,choice:'once'});
  await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  const created=store.state.routines.at(-1);
  assert.deepEqual(created.schedule,{kind:'weekly',time:'09:15',days:['mon','tue','wed','thu','fri']});assert.equal(created.timezone,'America/New_York');assert.equal(created.enabled,true);
  assert.match(JSON.parse(requests[1].messages.at(-1).content).schedule,/Weekdays at 09:15/);
});
