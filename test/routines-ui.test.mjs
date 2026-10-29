import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {JSDOM} from 'jsdom';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// The real app code in a DOM, with timers that fire at once; no engine, account or provider is involved.
function harness(respond=async()=>({}),{controlledTimers=false}={}) {
  const dom=new JSDOM('<div id="app"><main id="main-content"></main></div><div id="dialog-root"></div><div id="toasts"></div>');
  const {window}=dom,requests=[];
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const timers=[];
  const ctx=vm.createContext({document:window.document,window,HTMLFormElement:window.HTMLFormElement,HTMLElement:window.HTMLElement,FormData:window.FormData,location:{hash:'#/routines'},URL,crypto:webcrypto,setInterval:()=>1,clearInterval(){},setTimeout:fn=>controlledTimers?timers.push(fn):setImmediate(fn),clearTimeout(){}});
  vm.runInContext(source,ctx,{filename:'app.js'});
  ctx.fixtureApi=async(path,options={})=>{requests.push({path,method:options.method||'GET',body:options.body&&JSON.parse(JSON.stringify(options.body))});return respond(path,options,requests.length);};
  vm.runInContext("auth={authenticated:true,csrf:'fixture-session'};data={...initialState,settings:{timezone:'Europe/Warsaw'},bots:[{id:'bot_qa',name:'QA Bot',title:'Tester',connectionId:'',tools:[],skills:[],enabled:true}],connections:[],rooms:[],routines:[]};api=fixtureApi;refresh=async()=>{};",ctx);
  return {window,requests,timers,run:code=>vm.runInContext(code,ctx),$:selector=>window.document.querySelector(selector),$$:selector=>[...window.document.querySelectorAll(selector)]};
}
const networkError=()=>new TypeError('Failed to fetch');

test('an uncertain send asks the engine before sending again, and reuses the message ID',async()=>{
  // The first POST loses its answer; the engine did receive it.
  const received=harness(async(path,options,count)=>{if(count===1)throw networkError();if(path.includes('/submissions/'))return {received:true,run:{id:'run_1',status:'running'}};throw new Error('unexpected');});
  const result=await received.run("sendMessage('bot_qa',{text:'Plan my week.'})");
  assert.equal(result.duplicate,true);assert.equal(result.run.id,'run_1');
  const id=received.requests[0].body.clientMessageId;assert.match(id,/^[0-9a-f]{32}$/);
  assert.deepEqual(received.requests.map(item=>[item.method,item.path]),[['POST','/api/bots/bot_qa/messages'],['GET',`/api/bots/bot_qa/submissions/${id}`]]);
  // The engine never got it: the same message goes again with the same ID.
  const lost=harness(async(path,options,count)=>{if(count===1)throw networkError();if(path.includes('/submissions/'))throw Object.assign(new Error('Not received.'),{status:404});return {run:{id:'run_2'}};});
  await lost.run("sendMessage('bot_qa',{text:'Plan my week.'})");
  assert.equal(lost.requests.length,3);assert.equal(lost.requests[2].body.clientMessageId,lost.requests[0].body.clientMessageId);
});

test('a definite refusal is not retried, and a draft sent again after a failure keeps its ID',async()=>{
  const busy=harness(async()=>{throw Object.assign(new Error('This bot already has an active task.'),{status:409});});
  await assert.rejects(busy.run("sendMessage('bot_qa',{text:'Hello.'})"),/already has an active task/);
  assert.equal(busy.requests.length,1);
  const offline=harness(async()=>{throw networkError();});
  await assert.rejects(offline.run("sendMessage('bot_qa',{text:'Hello.'})"),/Your message is still in the box; sending it again is safe\./);
  const firstId=offline.requests[0].body.clientMessageId,posts=offline.requests.filter(item=>item.method==='POST');
  assert.equal(posts.length,3);assert.ok(posts.every(item=>item.body.clientMessageId===firstId));
  await assert.rejects(offline.run("sendMessage('bot_qa',{text:'Hello.'})"));
  assert.equal(offline.requests.at(-1).body?.clientMessageId ?? offline.requests.filter(item=>item.method==='POST').at(-1).body.clientMessageId,firstId);
  await assert.rejects(offline.run("sendMessage('bot_qa',{text:'Something else.'})"));
  assert.notEqual(offline.requests.filter(item=>item.method==='POST').at(-1).body.clientMessageId,firstId,'a different draft gets a new ID');
});

test('a lost room acceptance is reconciled by receipt and an unreceived retry preserves its room message ID',async()=>{
  const received=harness(async(path,options,count)=>{if(count===1)throw networkError();if(path.includes('/submissions/'))return {received:true,drive:{id:'drive_1',status:'running'}};throw new Error('unexpected');});
  const result=await received.run("sendRoomMessage('room_qa',{text:'Team task.'})");assert.equal(result.duplicate,true);assert.equal(result.drive.id,'drive_1');
  const id=received.requests[0].body.clientMessageId;assert.deepEqual(received.requests.map(item=>[item.method,item.path]),[['POST','/api/rooms/room_qa/messages'],['GET',`/api/rooms/room_qa/submissions/${id}`]]);
  const lost=harness(async(path,options,count)=>{if(count===1)throw networkError();if(path.includes('/submissions/'))throw Object.assign(new Error('Not received.'),{status:404});return {drive:{id:'drive_2'}};});
  await lost.run("sendRoomMessage('room_qa',{text:'Team task.'})");assert.equal(lost.requests.length,3);assert.equal(lost.requests[2].body.clientMessageId,lost.requests[0].body.clientMessageId);
  const busy=harness(async()=>{throw Object.assign(new Error('This room already has an active turn.'),{status:409});});await assert.rejects(busy.run("sendRoomMessage('room_qa',{text:'Team task.'})"),/active turn/);assert.equal(busy.requests.length,1);
});

for(const room of [false,true])test(`${room?'room':'bot'} retries cannot dispatch into a new sign-in session`,async()=>{
  const h=harness(async()=>{throw networkError();},{controlledTimers:true}),sending=h.run(`${room?'sendRoomMessage':'sendMessage'}('target_qa',{text:'An old private task.'})`);
  const rejected=assert.rejects(sending,/sign-in session changed/);await tick();assert.equal(h.requests.length,1);assert.equal(h.timers.length,1);
  h.run("auth={authenticated:false};renderAuth();auth={authenticated:true,csrf:'new-session'};");h.timers.shift()();await rejected;
  assert.equal(h.requests.length,1,'No receipt lookup or retried side effect may use the new session.');assert.equal(h.run('pendingSends.size'),0);
});

for(const room of [false,true])test(`a late ${room?'room':'bot'} acceptance cannot clear a new session's pending submission`,async()=>{
  let acceptOld,acceptNew;const h=harness(async(_path,_options,count)=>new Promise(resolve=>{if(count===1)acceptOld=resolve;else acceptNew=resolve;})),method=room?'sendRoomMessage':'sendMessage';
  const old=h.run(`${method}('target_qa',{text:'An old task.'})`),rejected=assert.rejects(old,/sign-in session changed/);
  h.run("auth={authenticated:false};renderAuth();auth={authenticated:true,csrf:'new-session'};");const fresh=h.run(`${method}('target_qa',{text:'A new draft.'})`),newId=h.requests[1].body.clientMessageId;
  acceptOld(room?{drive:{id:'old'}}:{run:{id:'old'}});await rejected;assert.equal(h.run(`pendingSends.get('${room?'rooms':'bots'}/target_qa').id`),newId);
  acceptNew(room?{drive:{id:'new'}}:{run:{id:'new'}});await fresh;assert.equal(h.run('pendingSends.size'),0);
});

test('the routine dialog shows only the chosen kind of schedule and sends it with its time zone',async()=>{
  const h=harness(async()=>({}));
  h.run("routineDialog(undefined,'bot_qa')");
  assert.equal(h.$('#routine-kind').value,'daily');assert.equal(h.$('#routine-time').value,'08:00');assert.equal(h.$('#routine-zone').value,'Europe/Warsaw');
  const visible=()=>h.$$('[data-routine-kinds]').filter(field=>!field.hidden).map(field=>field.dataset.routineKinds);
  assert.deepEqual(visible(),['daily weekly']);
  h.$('#routine-kind').value='weekly';h.$('#routine-kind').dispatchEvent(new h.window.Event('change',{bubbles:true}));
  assert.deepEqual(visible(),['daily weekly','weekly']);assert.equal(h.$('[name=days][value=sat]').disabled,false);
  h.$('#routine-name').value='Standup notes';h.$('#routine-prompt').value='Collect notes.';h.$('#routine-time').value='09:15';
  for(const box of h.$$('[name=days]'))box.checked=['mon','wed'].includes(box.value);
  h.$('#routine-missed').value='skip';
  h.$('#routine-form').dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();
  const sent=h.requests.find(item=>item.path==='/api/routines');
  assert.deepEqual(sent.body,{name:'Standup notes',botId:'bot_qa',prompt:'Collect notes.',schedule:{kind:'weekly',time:'09:15',days:['mon','wed']},timezone:'Europe/Warsaw',missed:'skip',enabled:true});
});

test('routine cards and history describe schedules in plain words',async()=>{
  const h=harness(async path=>path.endsWith('/runs')?{data:[{runId:'run_1',startedAt:'2026-10-27T07:30:00Z',status:'failed',durationMs:4200,error:'Provider <unavailable>.'},{runId:'run_0',startedAt:'2026-10-26T07:30:00Z',status:'completed',preview:'All quiet.'}],missedRuns:2}:{});
  assert.equal(h.run("scheduleLabel({schedule:{kind:'weekly',time:'08:30',days:['mon','tue','wed','thu','fri']},timezone:browserZone()})"),'Weekdays at 08:30');
  assert.equal(h.run("scheduleLabel({schedule:{kind:'daily',time:'07:00'},timezone:'Asia/Tokyo'})"),'Every day at 07:00 (Asia/Tokyo)');
  assert.equal(h.run("scheduleLabel({intervalMinutes:1440})"),'Every 24 hours','routines saved before schedules read as before');
  assert.equal(h.run("scheduleLabel({schedule:{kind:'interval',minutes:90}})"),'Every 90 minutes');
  h.run("data.routines=[{id:'routine_a',name:'Digest',botId:'bot_qa',prompt:'Summarize.',enabled:true,schedule:{kind:'daily',time:'08:30'},timezone:browserZone(),nextRunAt:new Date(Date.now()+3600000).toISOString(),missedRuns:2}]");
  const page=h.run('renderRoutines()');assert.match(page,/Every day at 08:30 · Next /);assert.match(page,/2 skipped while offline/);assert.match(page,/data-action="routine-history"/);
  await h.run("routineHistory('routine_a')");
  const dialog=h.$('#dialog-root').textContent;
  assert.match(dialog,/Failed/);assert.match(dialog,/Provider <unavailable>\./);assert.match(dialog,/All quiet\./);assert.match(dialog,/2 skipped while Tupies was offline/);
  assert.equal(h.$('#dialog-root img,#dialog-root script'),null);
});
