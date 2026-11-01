import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const source = await readFile(new URL('../public/notification-reads.js',import.meta.url),'utf8');
function fixture(t) {
  const dom = new JSDOM('<form id="message-form" data-id="bot_atlas"></form><div id="chat-thread"><article data-search-message-id="reply"></article></div>',{runScripts:'outside-only',pretendToBeVisual:true});
  const win=dom.window; win.setInterval=()=>1;win.clearInterval=()=>{};
  let time=1000,focused=true,hidden=false;
  win.document.hasFocus=()=>focused;
  Object.defineProperty(win.document,'hidden',{get:()=>hidden});
  const node=win.document.querySelector('article');let rect={top:100,bottom:300,width:600,height:200};node.getBoundingClientRect=()=>rect;
  const calls=[], context={authenticated:true,generation:1,view:'bot',id:'bot_atlas',messages:[{id:'reply',role:'assistant',runId:'run',partial:false}],api:async(...args)=>{calls.push(args);}};
  win.eval(source);const reader=win.StudioNotificationReads.install(()=>context,{now:()=>time});
  t.after(()=>{reader.close();win.close();});
  return {win,context,calls,reader,advance:ms=>{time+=ms;},focus:v=>{focused=v;},hide:v=>{hidden=v;},rect:v=>{rect=v;}};
}
test('a focused, rendered final reply needs dwell time and sends one exact receipt',async t=>{
  const f=fixture(t);await f.reader.tick();assert.equal(f.calls.length,0);f.advance(700);await f.reader.tick();await f.reader.tick();assert.equal(f.calls.length,1);
  assert.equal(f.calls[0][0],'/api/notifications/read');assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0][1].body)),{botId:'bot_atlas',messageIds:['reply']});
});

test('a question is acknowledged only while its exact card is visible in an attended chat',async t=>{
  const f=fixture(t);f.context.messages=[];
  f.context.run={status:'waiting_for_input',pending_controls:[{kind:'question',prompt_id:'question_current'}]};
  const node=f.win.document.querySelector('article');node.removeAttribute('data-search-message-id');node.dataset.notificationQuestionId='question_current';
  await f.reader.tick();f.advance(700);f.hide(true);await f.reader.tick();assert.equal(f.calls.length,0);
  f.hide(false);await f.reader.tick();f.advance(700);await f.reader.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0][1].body)),{botId:'bot_atlas',messageIds:[],questionId:'question_current'});
  f.context.run.pending_controls=[{kind:'question',prompt_id:'question_new'}];f.advance(700);await f.reader.tick();assert.equal(f.calls.length,1,'an obsolete card cannot acknowledge a newer question');
});

test('progress text cannot acknowledge a final-reply notification',async t=>{
  const f=fixture(t);f.context.messages[0].kind='progress';await f.reader.tick();f.advance(700);await f.reader.tick();assert.equal(f.calls.length,0);
});
test('hidden, unfocused, idle, covered, partial, offscreen and mismatched chats cannot acknowledge replies',async t=>{
  for(const kind of ['hidden','blur','idle','dialog','partial','offscreen','wrong-chat','signed-out']){
    const f=fixture(t);await f.reader.tick();f.advance(700);
    if(kind==='hidden')f.hide(true);if(kind==='blur')f.focus(false);if(kind==='idle')f.advance(120001);
    if(kind==='dialog')f.win.document.body.insertAdjacentHTML('beforeend','<dialog open></dialog>');
    if(kind==='partial')f.context.messages[0].partial=true;if(kind==='offscreen')f.rect({top:1000,bottom:1200,width:600,height:200});
    if(kind==='wrong-chat')f.context.id='bot_nova';if(kind==='signed-out')f.context.authenticated=false;
    await f.reader.tick();assert.equal(f.calls.length,0,kind);
  }
});
test('focus returns to an idle window; room receipts identify the actual sender and failed requests retry',async t=>{
  const f=fixture(t);f.win.document.querySelector('form').id='room-message-form';f.win.document.querySelector('form').dataset.id='room_a';f.win.document.querySelector('#chat-thread').id='room-thread';
  Object.assign(f.context,{view:'room',id:'room_a',messages:[{id:'reply',role:'assistant',botId:'bot_atlas'}]});
  let fail=true;f.context.api=async(...args)=>{f.calls.push(args);if(fail)throw new Error('offline');};
  await f.reader.tick();f.advance(700);await f.reader.tick();assert.equal(f.calls.length,1);await f.reader.tick();assert.equal(f.calls.length,1);
  fail=false;f.advance(10001);await f.reader.tick();assert.equal(f.calls.length,2);assert.equal(f.calls[1][1].body.roomId,'room_a');
  f.context.generation++;f.advance(120001);await f.reader.tick();f.win.dispatchEvent(new f.win.Event('focus'));await f.reader.tick();f.advance(700);await f.reader.tick();assert.equal(f.calls.length,3);
});
test('native shells require a fresh independent active-window hint and fail closed on missing or stale hints',async t=>{
  const f=fixture(t),data=f.win.document.documentElement.dataset;data.studioAttendance='1';
  await f.reader.tick();f.advance(700);await f.reader.tick();assert.equal(f.calls.length,0);
  data.studioAttended='false';data.studioAttendedAt='1700';await f.reader.tick();assert.equal(f.calls.length,0);
  data.studioAttended='true';data.studioAttendedAt='1700';await f.reader.tick();f.advance(700);await f.reader.tick();assert.equal(f.calls.length,1);
  f.context.generation++;f.advance(2501);await f.reader.tick();f.advance(700);await f.reader.tick();assert.equal(f.calls.length,1);
});

test('successful exact reads notify the sidebar only in the same sign-in generation',async t=>{
  const f=fixture(t),reads=[];f.context.onRead=receipt=>reads.push(receipt);
  await f.reader.tick();f.advance(700);await f.reader.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(reads)),[{view:'bot',id:'bot_atlas',botId:'bot_atlas',messageIds:['reply']}]);
  f.context.generation++;let resolve;f.context.api=()=>new Promise(done=>{resolve=done;});
  await f.reader.tick();f.advance(700);const pending=f.reader.tick();
  f.context.generation++;resolve({acknowledged:true});await pending;
  assert.equal(reads.length,1,'a response after sign-out cannot update the new session');
});

test('an attended local Mission acknowledges only its exact owner question, never transcript messages',async t=>{
 const f=fixture(t),doc=f.win.document;doc.body.innerHTML='<section data-mission-page="mission_a"><div class="mission-owner-controls"><article data-notification-question-id="question_mission"></article><article data-search-message-id="reply"></article></div></section>';
 for(const node of doc.querySelectorAll('article'))node.getBoundingClientRect=()=>({top:100,bottom:300,width:600,height:200});
 Object.assign(f.context,{view:'missions',id:'mission_a',botId:'bot_atlas',messages:[{id:'reply',role:'assistant'}],run:{id:'run_a',missionId:'mission_a',botId:'bot_atlas',status:'waiting_for_input',pending_controls:[{kind:'question',prompt_id:'question_mission'}]}});
 await f.reader.tick();f.advance(700);await f.reader.tick();await f.reader.tick();
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls.map(call=>call[1].body))),[{botId:'bot_atlas',messageIds:[],questionId:'question_mission'}]);
 f.context.run.pending_controls[0].prompt_id='new_question';f.advance(700);await f.reader.tick();assert.equal(f.calls.length,1,'old card cannot acknowledge a replacement');
});

test('Mission summaries, wrong page/bot/run identities, browser handoffs and unattended cards cannot acknowledge questions',async t=>{
 for(const kind of ['summary','page','mission','bot','browser','hidden','blur','dialog','offscreen']){
  const f=fixture(t),doc=f.win.document;doc.body.innerHTML='<section data-mission-page="mission_a"><div class="mission-owner-controls"><article data-notification-question-id="question_mission"></article></div></section>';
  doc.querySelector('article').getBoundingClientRect=()=>kind==='offscreen'?{top:1000,bottom:1200,width:600,height:200}:{top:100,bottom:300,width:600,height:200};
  Object.assign(f.context,{view:'missions',id:'mission_a',botId:'bot_atlas',run:{id:'run_a',missionId:'mission_a',botId:'bot_atlas',status:'waiting_for_input',pending_controls:[{kind:'question',prompt_id:'question_mission'}]}});
  if(kind==='summary')f.context.run=null;if(kind==='page')doc.querySelector('section').dataset.missionPage='mission_b';if(kind==='mission')f.context.run.missionId='mission_b';if(kind==='bot')f.context.botId='bot_nova';if(kind==='browser')f.context.run.pending_controls[0].kind='browser';if(kind==='hidden')f.hide(true);if(kind==='blur')f.focus(false);if(kind==='dialog')doc.body.insertAdjacentHTML('beforeend','<dialog open></dialog>');
  await f.reader.tick();f.advance(700);await f.reader.tick();assert.equal(f.calls.length,0,kind);
 }
});

test('visible exact local approval and settled blocker attention send exclusive Mission receipts',async t=>{
 for(const kind of ['approval','blocker']){
  const f=fixture(t),doc=f.win.document,attentionId='a'.repeat(32);doc.body.innerHTML=`<section data-mission-page="mission_a"><div data-notification-mission-id="mission_a" data-notification-attention-id="${attentionId}"></div><article data-search-message-id="reply"></article></section>`;
  for(const node of doc.querySelectorAll('[data-notification-attention-id],article'))node.getBoundingClientRect=()=>({top:100,bottom:300,width:600,height:200});
  Object.assign(f.context,{view:'missions',id:'mission_a',botId:'bot_atlas',run:kind==='approval'?{id:'run_a',missionId:'mission_a',botId:'bot_atlas',execution_generation:3,status:'waiting_for_approval'}:null,notificationAttention:{kind,attentionId,missionId:'mission_a',botId:'bot_atlas',...(kind==='approval'?{runId:'run_a',generation:3}:{})}});
  await f.reader.tick();f.advance(700);await f.reader.tick();await f.reader.tick();assert.deepEqual(JSON.parse(JSON.stringify(f.calls.map(call=>call[1].body))),[{botId:'bot_atlas',missionId:'mission_a',attentionId,messageIds:[]}]);
  f.context.notificationAttention.attentionId='b'.repeat(32);f.advance(700);await f.reader.tick();assert.equal(f.calls.length,1,'stale card cannot acknowledge replacement attention');
 }
});

test('remote/mismatched attention, wrong generation and covered or inactive Mission detail cannot acknowledge',async t=>{
 for(const bad of ['no-context','wrong-node','wrong-mission','wrong-bot','wrong-run','generation','hidden','blur','dialog']){
  const f=fixture(t),doc=f.win.document,attentionId='a'.repeat(32);doc.body.innerHTML=`<section data-mission-page="mission_a"><div data-notification-mission-id="mission_a" data-notification-attention-id="${attentionId}"></div></section>`;doc.querySelector('[data-notification-attention-id]').getBoundingClientRect=()=>({top:100,bottom:300,width:600,height:200});
  Object.assign(f.context,{view:'missions',id:'mission_a',botId:'bot_atlas',run:{id:'run_a',missionId:'mission_a',botId:'bot_atlas',execution_generation:3},notificationAttention:{kind:'approval',attentionId,missionId:'mission_a',botId:'bot_atlas',runId:'run_a',generation:3}});
  if(bad==='no-context')f.context.notificationAttention=null;if(bad==='wrong-node')doc.querySelector('[data-notification-mission-id]').dataset.notificationMissionId='mission_b';if(bad==='wrong-mission')f.context.notificationAttention.missionId='mission_b';if(bad==='wrong-bot')f.context.notificationAttention.botId='bot_nova';if(bad==='wrong-run')f.context.notificationAttention.runId='run_old';if(bad==='generation')f.context.notificationAttention.generation=2;if(bad==='hidden')f.hide(true);if(bad==='blur')f.focus(false);if(bad==='dialog')doc.body.insertAdjacentHTML('beforeend','<dialog open></dialog>');
  await f.reader.tick();f.advance(700);await f.reader.tick();assert.equal(f.calls.length,0,bad);
 }
});
