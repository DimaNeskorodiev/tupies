// Alerts for everything a bot waits on the owner for: approval cards in every lane the owner decides (with an
// argument-free plain-word title), browser handoffs in the owner's chat, failed chat tasks and skill suggestions.
// Fixtures only: plainly fake tokens and values, no Apple connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../lib/store.mjs';
import { Notifications } from '../lib/notifications.mjs';
import { approvalText } from '../lib/attention-text.mjs';
import { createStudioServer } from '../server.mjs';

const TOKEN='ab'.repeat(32),BASE=Date.parse('2026-11-19T10:00:00Z');
const iso=n=>new Date(BASE+n).toISOString();
const enrollment=overrides=>({token:TOKEN,environment:'sandbox',enabled:true,botReplies:true,routines:true,...overrides});
const SECRET_COMMAND='rm -rf /srv/fixture-private-folder';
const approvalRun=(overrides={},control={})=>({id:'run_approval',botId:'bot_atlas',source:'chat',status:'waiting_for_approval',execution_generation:1,createdAt:iso(0),updatedAt:iso(0),
  pending_controls:[{kind:'approval',prompt_id:'approval_first',createdAt:iso(0),tool:'routines_create',arguments:{name:'Fixture private routine',prompt:'Fixture private prompt',commands:[SECRET_COMMAND]},preview:SECRET_COMMAND,review:{summary:`Schedule ${SECRET_COMMAND}`},...control}],
  approval:{request_id:control.prompt_id || 'approval_first',tool:control.tool || 'routines_create',command:SECRET_COMMAND},...overrides});

async function fixture(t,{graceMs=0,seed}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-attention-'));
  const store=await new Store(directory).init();
  const device={id:'dev_phone',kind:'device',platform:'ios',name:'Fixture phone'};
  await store.mutate(state=>{state.devices.push(device);seed?.(state);});
  let time=BASE;const sent=[];
  const transport={available:true,environment:'sandbox',async send(request){sent.push(request);return {status:200};},close(){}};
  const sync={nodeId:'node_fixture',role:()=>'hub',devices:{find:id=>store.state.devices.find(item=>item.id===id && !item.revokedAt)}};
  const notifications=await new Notifications(store,{sync,transport,now:()=>time,graceMs,intervalMs:1_000_000}).init();
  t.after(async()=>{await notifications.close();await fs.rm(directory,{recursive:true,force:true});});
  await notifications.register(device,enrollment());
  const body=index=>sent[index]?.payload.aps.alert.body;
  return {store,device,notifications,sent,body,advance:ms=>{time+=ms;}};
}
// The payloads Apple receives and the saved outbox: no arguments, prompts or names of the request; no token on disk.
const noSecrets=async(f)=>{
  const saved=await fs.readFile(f.notifications.file,'utf8'),text=JSON.stringify(f.sent.map(item=>item.payload))+saved;
  for(const value of [SECRET_COMMAND,'Fixture private prompt','Fixture private routine','fixture-private-folder'])assert.ok(!text.includes(value),value);
  assert.ok(!saved.includes(TOKEN));
};

test('a chat approval alerts once in plain words and never carries the action’s arguments',async t=>{
  const f=await fixture(t);
  await f.store.mutate(state=>{state.runs.bot_atlas=approvalRun();});await f.notifications.flush();await f.notifications.flush();
  assert.equal(f.sent.length,1);assert.equal(f.body(0),'Needs your approval to create a routine.');
  assert.equal(f.sent[0].payload.studio.kind,'message');assert.equal(f.sent[0].payload.studio.botId,'bot_atlas');assert.equal(f.sent[0].payload.aps.alert.title,'Roki');
  await noSecrets(f);
  // The next approval in the same task is a new alert; a repeated observation of the same prompt is not.
  await f.store.mutate(state=>{Object.assign(state.runs.bot_atlas.pending_controls[0],{prompt_id:'approval_second',tool:'terminal'});state.runs.bot_atlas.execution_generation=2;});await f.notifications.flush();
  assert.equal(f.sent.length,2);assert.equal(f.body(1),'Needs your approval to run a command.');assert.notEqual(f.sent[0].eventId,f.sent[1].eventId);
  assert.deepEqual(f.notifications.pendingBotItems(),{bot_atlas:1});
});

test('approvals decided, stopped or replaced during the grace period do not alert',async t=>{
  const f=await fixture(t,{graceMs:8000});
  const outcomes=[state=>{state.runs.bot_atlas.status='running';state.runs.bot_atlas.pending_controls=[];},state=>{state.runs.bot_atlas.stopRequested=true;},state=>{state.runs.bot_atlas.pending_controls[0].prompt_id='approval_replaced';}];
  for(const [index,change] of outcomes.entries()) {
    await f.store.mutate(state=>{state.runs.bot_atlas=approvalRun({id:`run_case_${index}`});});await f.notifications.flush();
    await f.store.mutate(change);f.advance(8001);await f.notifications.flush();
  }
  assert.equal(f.sent.filter(item=>/run_case_\d/.test(JSON.stringify(item))).length,0);
  assert.ok(f.notifications.state.outbox.filter(item=>item.event.promptId==='approval_first').every(item=>item.status==='cancelled'));
});

test('a visible approval card mutes only its own pending alert; reading it decides nothing',async t=>{
  const f=await fixture(t,{graceMs:8000});
  await f.store.mutate(state=>{state.runs.bot_atlas=approvalRun();});await f.notifications.flush();
  await f.notifications.acknowledge({botId:'bot_atlas',messageIds:[],approvalId:'approval_stale'});assert.equal(f.notifications.state.outbox[0].status,'pending');
  await f.notifications.acknowledge({botId:'bot_atlas',messageIds:[],approvalId:'approval_first'});assert.equal(f.notifications.state.outbox[0].status,'suppressed');
  f.advance(8001);await f.notifications.flush();assert.equal(f.sent.length,0);
  assert.equal(f.store.state.runs.bot_atlas.status,'waiting_for_approval');
  await assert.rejects(f.notifications.acknowledge({botId:'bot_atlas',roomId:'room_one',messageIds:[],approvalId:'approval_first'}),/approval receipt/);
});

test('routine, teammate, room and Telegram approvals alert; a routine approval follows the routine preference and route',async t=>{
  const f=await fixture(t,{seed:state=>{state.routines.push({id:'routine_digest',botId:'bot_atlas',name:'Morning digest',prompt:'Fixture private prompt',enabled:true});}});
  await f.store.mutate(state=>{state.runs.bot_atlas=approvalRun({id:'run_routine',source:'routine',routineId:'routine_digest',sessionId:'bot_atlas--routine-0123456789abcdef'},{tool:'script_run',prompt_id:'approval_routine'});});await f.notifications.flush();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].payload.studio.kind,'routine');assert.equal(f.sent[0].payload.studio.routineId,'routine_digest');
  assert.equal(f.body(0),'Needs your approval to run a saved script.');assert.equal(f.sent[0].payload.aps.alert.subtitle,'Routine · Morning digest');
  for(const [index,overrides] of [{source:'delegation',delegation:{depth:1,rootTrusted:true}},{source:'room',roomId:'room_one',sessionId:'bot_atlas--room-0123456789abcdef'},{source:'telegram',sessionId:'bot_atlas--telegram-0123456789abcdef'}].entries()) {
    await f.store.mutate(state=>{state.runs.bot_atlas=approvalRun({id:`run_lane_${index}`,...overrides},{prompt_id:`approval_lane_${index}`});});await f.notifications.flush();
  }
  assert.equal(f.sent.length,4);assert.ok(f.sent.slice(1).every(item=>item.payload.studio.kind==='message' && !item.payload.studio.roomId));
  await f.notifications.register(f.device,enrollment({routines:false}));
  await f.store.mutate(state=>{state.runs.bot_atlas=approvalRun({id:'run_routine_off',source:'routine',routineId:'routine_digest'},{prompt_id:'approval_routine_off'});});await f.notifications.flush();
  assert.equal(f.sent.length,4,'routine approvals respect the routine switch');await noSecrets(f);
});

test('a Mission lead’s approval stays with Mission attention; its teammate’s approval alerts here',async t=>{
  const mission={id:'mission_one',leadBotId:'bot_atlas',ownerEngineId:'foreign_engine',state:'running',episodeRefs:[]};
  const f=await fixture(t,{seed:state=>{state.missions={mission_one:mission};}});
  await f.store.mutate(state=>{state.runs.bot_atlas=approvalRun({source:'mission',missionId:'mission_one'});});await f.notifications.flush();
  assert.equal(f.sent.length,0);
  await f.store.mutate(state=>{state.runs.bot_nova=approvalRun({id:'run_teammate',botId:'bot_nova',source:'delegation',missionId:'mission_one',delegation:{depth:1,rootTrusted:true}},{prompt_id:'approval_teammate',tool:'workspace_write'});});await f.notifications.flush();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].payload.studio.botId,'bot_nova');assert.equal(f.body(0),'Needs your approval to write a file.');
  await f.store.mutate(state=>{state.missions.mission_one.pauseRequested=true;state.runs.bot_nova=approvalRun({id:'run_paused',botId:'bot_nova',source:'delegation',missionId:'mission_one'},{prompt_id:'approval_paused'});});await f.notifications.flush();
  assert.equal(f.sent.length,1,'a paused Mission does not ask the owner');
});

test('plain-word approval text names services and engine check-ins but never argument values',()=>{
  const integrations=[{id:'gmail',name:'Gmail'}];
  assert.equal(approvalText('integration_call',{integrationId:'gmail',tool:'send_message',arguments:{to:'fixture@example.test',body:'Fixture private body'}},{integrations}),'Needs your approval to use Gmail: send message.');
  assert.equal(approvalText('integration_call',{integrationId:'missing',tool:'delete-task'}),'Needs your approval to use a connected service: delete task.');
  assert.equal(approvalText('integration_propose',{name:'Fixture API',baseUrl:'https://fixture.example.test'}),'Needs your approval to add a connection.');
  assert.equal(approvalText('task_budget',{}),'Reached its task budget. Needs your OK to continue.');
  assert.equal(approvalText('site_access_review',{site:'fixture.example.test'}),'A website keeps refusing. Needs your OK to keep trying.');
  for(const [tool,text] of [['routines_update','change a routine'],['routines_delete','delete a routine'],['script_save','save a script'],['scripts_register','register a script'],['skills_create','create a skill'],['skills_install','install a skill'],['workshop_build','build a new tool'],['bots_create','create a bot'],['http_fetch','send a web request']])
    assert.equal(approvalText(tool,{url:'https://fixture.example.test/private',command:SECRET_COMMAND}),`Needs your approval to ${text}.`);
  assert.equal(approvalText('custom_tool<script>',{}),'Needs your approval to use “custom toolscript”.');
});

test('a browser handoff in the owner’s chat alerts without the bot’s own wording and clears when resumed',async t=>{
  const f=await fixture(t,{graceMs:8000});
  const browserRun=(id,prompt)=>({id,botId:'bot_atlas',source:'chat',status:'waiting_for_input',createdAt:iso(0),updatedAt:iso(0),pending_controls:[{kind:'browser',prompt_id:prompt,createdAt:iso(0),reason:'Sign in at https://fixture.example.test/private-account'}]});
  await f.store.mutate(state=>{state.runs.bot_atlas=browserRun('run_browser','browser_first');});await f.notifications.flush();
  f.advance(8001);await f.notifications.flush();
  assert.equal(f.sent.length,1);assert.equal(f.body(0),'Needs your help in the browser. Open the chat to continue.');assert.ok(!JSON.stringify(f.sent).includes('private-account'));
  await f.store.mutate(state=>{state.runs.bot_atlas=browserRun('run_browser_two','browser_second');});await f.notifications.flush();
  await f.store.mutate(state=>{state.runs.bot_atlas.status='running';state.runs.bot_atlas.pending_controls=[];});f.advance(8001);await f.notifications.flush();
  assert.equal(f.sent.length,1,'a handoff resumed during the grace period does not alert');
});

test('a failed owner chat task alerts once with static text; Stop, restarts, teammates and replies do not',async t=>{
  const f=await fixture(t);
  const finish=async(id,{status='failed',request={source:'chat'},reply=false}={})=>{
    await f.store.mutate(state=>{
      ((state.runHistory ||= {}).bot_atlas ||= []).push({id,status,source:request.source==='chat'?'chat':request.source,createdAt:iso(0),finishedAt:iso(1000),error:'Fixture private provider error'});
      const rows=state.messages.bot_atlas ||= [];rows.push({id:`user_${id}`,role:'user',runId:id,content:'Fixture request',createdAt:iso(0),...request});
      if(reply)rows.push({id:`reply_${id}`,role:'assistant',runId:id,content:'Fixture final reply',createdAt:iso(1000)});
      else rows.push({id:`partial_${id}`,role:'assistant',runId:id,partial:true,runStatus:status,content:'Fixture partial',createdAt:iso(1000)});
    });await f.notifications.flush();
  };
  await finish('run_failed');
  assert.equal(f.sent.length,1);assert.equal(f.body(0),'Couldn’t finish the task. Open the chat for details.');assert.ok(!JSON.stringify(f.sent).includes('provider error'));
  await f.notifications.flush();assert.equal(f.sent.length,1,'one alert per failed task');
  await finish('run_cancelled',{status:'cancelled'});await finish('run_interrupted',{status:'interrupted'});
  await finish('run_teammate',{request:{source:'chat',fromBotId:'bot_nova'}});await finish('run_routine',{request:{source:'routine',routineId:'routine_missing'}});
  await finish('run_with_reply',{reply:true});
  assert.equal(f.sent.length,2);assert.equal(f.body(1),'Fixture final reply');
});

test('a skill suggestion alerts for review; a decided one before delivery and memory suggestions stay quiet',async t=>{
  const f=await fixture(t,{graceMs:8000});
  const suggest=(id,kind='skill',create=true)=>f.store.mutate(state=>{(state.proposals ||= []).push({id,botId:'bot_atlas',kind,status:'pending',...(kind==='skill'?{skill:{id:'fixture-skill',name:'Fixture private skill',create}}:{changes:[]}),reason:'Fixture private reason',createdAt:iso(0)});});
  await suggest('proposal_new');await suggest('proposal_change','skill',false);await suggest('proposal_memory','memory');await f.notifications.flush();
  await f.store.mutate(state=>{state.proposals.find(item=>item.id==='proposal_change').status='rejected';});
  f.advance(8001);await f.notifications.flush();
  assert.equal(f.sent.length,1);assert.equal(f.body(0),'Suggests a new skill. Review it in the bot’s profile.');
  assert.ok(!JSON.stringify(f.sent).includes('Fixture private'));
});

test('a real engine run asking to create a routine alerts on the phone, then the approved task’s reply alerts',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-attention-e2e-'));
  const sent=[];
  const transport={available:true,environment:'sandbox',async send(request){sent.push(request);return {status:200};},close(){}};
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,sleepGuard:false,notifications:{transport,graceMs:0},providers:{async complete(connection,request){
    const last=request.messages.at(-1);
    if(last.role==='user' && last.content==='Schedule a daily review.')return {text:'',toolCalls:[{id:'schedule',name:'routines_create',arguments:{name:'Fixture private routine',prompt:'Fixture private prompt',intervalMinutes:1440}}]};
    return {text:'The approved daily review is scheduled.',toolCalls:[]};
  }}});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  await app.store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Fixture',model:'fixture-model',secret:app.store.seal('fixture-not-a-real-key')});for(const bot of state.bots){bot.connectionId='fixture-provider';bot.approvalPolicy='strict';bot.collaborators=[];}state.bots[0].tools=['workspace','memory','automation'];state.devices.push({id:'dev_phone',kind:'device',platform:'ios',name:'Fixture phone'});});
  await app.notifications.register({id:'dev_phone',kind:'device',platform:'ios'},enrollment());
  await app.runtime.submit('bot_atlas','Schedule a daily review.');
  const until=Date.now()+4000;while(app.store.state.runs.bot_atlas?.status!=='waiting_for_approval' && Date.now()<until)await delay(5);
  const run=app.store.state.runs.bot_atlas;assert.equal(run.status,'waiting_for_approval',run.error);assert.ok(run.pending_controls[0].createdAt,'approval prompts carry their creation time');
  await app.notifications.flush();
  assert.equal(sent.length,1);assert.equal(sent[0].payload.aps.alert.body,'Needs your approval to create a routine.');assert.ok(!JSON.stringify(sent).includes('Fixture private'));
  await app.runtime.control('bot_atlas','approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation,choice:'once'});
  await Promise.allSettled([...app.runtime.tasks.values()]);await app.notifications.flush();
  assert.equal(app.store.state.routines.length,1);
  assert.equal(sent.length,2);assert.equal(sent[1].payload.aps.alert.body,'The approved daily review is scheduled.');
});

test('an engine upgrading to these alert types marks existing failures and suggestions as seen instead of sending them late',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-attention-upgrade-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init();let time=BASE;const sent=[];
  await store.mutate(state=>{state.devices.push({id:'dev_phone',kind:'device',platform:'ios',name:'Fixture phone'});});
  const transport={available:true,environment:'sandbox',async send(request){sent.push(request);return {status:200};},close(){}};
  const sync={nodeId:'node_fixture',role:()=>'hub',devices:{find:id=>store.state.devices.find(item=>item.id===id)}};
  // The notification file an older engine wrote: an enrolled phone, no `families`.
  const older=await new Notifications(store,{sync,transport,now:()=>time,graceMs:0,intervalMs:1_000_000}).init();
  await older.register({id:'dev_phone',kind:'device',platform:'ios'},enrollment());
  older.state.subscriptions.dev_phone.enabledAt=BASE-120_000;delete older.state.families;await older.save();await older.close();
  // While the engine was stopped for the update, a chat task failed and a skill was suggested.
  await store.mutate(state=>{
    state.messages.bot_atlas=[{id:'user_old',role:'user',source:'chat',runId:'run_old',content:'Fixture request',createdAt:iso(-60_000)}];
    state.runHistory={bot_atlas:[{id:'run_old',status:'failed',source:'chat',createdAt:iso(-60_000),finishedAt:iso(-30_000)}]};
    state.proposals=[{id:'proposal_old',botId:'bot_atlas',kind:'skill',status:'pending',skill:{create:true},createdAt:iso(-30_000)}];
  });
  const upgraded=await new Notifications(store,{sync,transport,now:()=>time,graceMs:0,intervalMs:1_000_000}).init();
  t.after(()=>upgraded.close());
  await upgraded.flush();assert.equal(sent.length,0);assert.deepEqual(upgraded.state.families,['attention']);
  await store.mutate(state=>{state.proposals.push({id:'proposal_new',botId:'bot_atlas',kind:'skill',status:'pending',skill:{create:true},createdAt:iso(1000)});});
  time+=1000;await upgraded.flush();assert.equal(sent.length,1,'new suggestions after the upgrade alert as usual');
});
