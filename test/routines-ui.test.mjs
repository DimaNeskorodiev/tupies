import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { validateRoutineWorkflow, prepareRoutineWorkflow } from '../lib/routine-workflow.mjs';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
const workflow={version:1,mode:'agent',steps:[{id:'feed',op:'read',path:'feeds/items.json'},{id:'items',op:'json',from:'feed',path:'content'},{id:'newItems',op:'select',from:'items',key:'url',limit:25}],skipIfEmpty:'newItems',context:'Review {{newItems}}. <script>bad()</script>'};

function ui(t,{routine={},runs=[]}={}){
  const dom=new JSDOM('<!doctype html><div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'http://studio.local/#/routines',runScripts:'outside-only'});
  const win=dom.window,doc=win.document,context=dom.getInternalVMContext(),requests=[],toasts=[];
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
  win.matchMedia=()=>({matches:false,addEventListener(){}});
  vm.runInContext(source,context,{filename:'app.js'});
  const saved={id:'routine_feed',name:'Feed digest',botId:'bot_atlas',prompt:'Review the new items.',schedule:{kind:'daily',time:'08:00'},timezone:'UTC',enabled:true,...routine};
  const state={...JSON.parse(JSON.stringify({bots:[{id:'bot_atlas',name:'Atlas'}],routines:[saved],settings:{timezone:'UTC'}}))};
  win.fixture=state;win.requests=requests;win.toasts=toasts;win.runs=runs;win.apiState={};
  win.captureRequest=async(route,options={})=>{requests.push(JSON.parse(JSON.stringify({path:route,method:options.method||'GET',body:options.body})));if(win.apiState.error)throw new Error(win.apiState.error);return route.endsWith('/runs')?{data:runs}:{};};
  vm.runInContext(`data={...initialState,...fixture};auth={authenticated:true,csrf:'fixture'};
    api=captureRequest;
    refresh=async()=>true;toast=(message,error=false)=>toasts.push({message,error});`,context);
  t.after(()=>dom.window.close());
  return {doc,win,requests,toasts,saved,run:code=>vm.runInContext(code,context),async submit(){doc.querySelector('form').dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));await flush();},async click(button){button.click();await flush();}};
}

test('routine execution options stay collapsed and preserve saved limits and workflow bytes through form submission',async t=>{
  const f=ui(t,{routine:{limits:{mode:'bounded',runtimeMinutes:75,modelTurns:80,toolCalls:300},workflow}});
  f.run('routineDialog("routine_feed")');
  const advanced=f.doc.querySelector('.routine-execution');assert.equal(advanced.open,false);
  assert.equal(f.doc.querySelector('[name=executionMode]').value,'bounded');assert.equal(f.doc.querySelector('[data-routine-budget]').hidden,false);
  assert.equal(f.doc.querySelector('[name=runtimeMinutes]').value,'75');
  assert.equal(f.doc.querySelector('[name=modelTurns]').value,'80');assert.equal(f.doc.querySelector('[name=toolCalls]').value,'300');
  assert.deepEqual(JSON.parse(f.doc.querySelector('[name=workflow]').value),workflow);
  assert.equal(f.doc.querySelector('script'),null,'workflow text is rendered as inert text');
  await f.submit();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].method,'PATCH');assert.equal(f.requests[0].path,'/api/routines/routine_feed');
  assert.deepEqual(f.requests[0].body.limits,{mode:'bounded',runtimeMinutes:75,modelTurns:80,toolCalls:300});assert.deepEqual(f.requests[0].body.workflow,workflow);
  assert.equal(f.requests[0].body.prompt,f.saved.prompt);assert.deepEqual(f.requests[0].body.schedule,f.saved.schedule);
  assert.equal(f.doc.querySelector('dialog'),null);
});

test('routines default to Work until done and clearing a saved workflow explicitly removes it',async t=>{
  const f=ui(t,{routine:{workflow}});f.run('routineDialog("routine_feed")');
  assert.equal(f.doc.querySelector('[name=executionMode]').value,'autonomous');assert.equal(f.doc.querySelector('[data-routine-budget]').hidden,true);assert.equal(f.doc.querySelector('[name=runtimeMinutes]').disabled,true);
  f.doc.querySelector('[name=workflow]').value=' \n ';
  await f.submit();
  assert.deepEqual(f.requests[0].body.limits,{mode:'autonomous'});assert.equal(f.requests[0].body.workflow,null);
  f.run('routineDialog(null,"bot_atlas")');
  f.doc.querySelector('[name=name]').value='New digest';f.doc.querySelector('[name=prompt]').value='Review.';
  await f.submit();assert.equal(f.requests.at(-1).path,'/api/routines');assert.equal(f.requests.at(-1).method,'POST');
  assert.equal(f.requests.at(-1).body.botId,'bot_atlas');assert.equal(f.requests.at(-1).body.enabled,true);
  assert.deepEqual(f.requests.at(-1).body.limits,{mode:'autonomous'});
});

test('legacy numeric defaults do not silently choose bounded execution',async t=>{
  const f=ui(t,{routine:{limits:{runtimeMinutes:30,modelTurns:50,toolCalls:200}}});f.run('routineDialog("routine_feed")');
  assert.equal(f.doc.querySelector('[name=executionMode]').value,'autonomous');assert.equal(f.doc.querySelector('[data-routine-budget]').hidden,true);
  f.doc.querySelector('[name=runtimeMinutes]').value='121';await f.submit();assert.deepEqual(f.requests[0].body.limits,{mode:'autonomous'},'hidden old numeric values cannot constrain or invalidate autonomous work');
});

test('invalid workflow JSON and out-of-range budgets keep the draft and never dispatch a save',async t=>{
  const f=ui(t);f.run('routineDialog("routine_feed")');const form=f.doc.querySelector('form'),input=f.doc.querySelector('[name=workflow]');
  input.value='{not-json';await f.submit();assert.equal(f.requests.length,0);assert.match(form.querySelector('.form-error').textContent,/Workflow JSON is invalid/);assert.equal(input.value,'{not-json');
  input.value='[]';await f.submit();assert.equal(f.requests.length,0);assert.match(form.querySelector('.form-error').textContent,/must be an object/);
  const mode=f.doc.querySelector('[name=executionMode]');mode.value='bounded';mode.dispatchEvent(new f.win.Event('change',{bubbles:true}));assert.equal(f.doc.querySelector('[data-routine-budget]').hidden,false);assert.equal(f.doc.querySelector('[name=runtimeMinutes]').disabled,false);
  input.value='';f.doc.querySelector('[name=runtimeMinutes]').value='121';await f.submit();assert.equal(f.requests.length,0);assert.match(form.querySelector('.form-error').textContent,/Time budget.*1 to 120/);
  f.doc.querySelector('[name=runtimeMinutes]').value='30';f.doc.querySelector('[name=modelTurns]').value='1.5';await f.submit();assert.equal(f.requests.length,0);assert.match(form.querySelector('.form-error').textContent,/Model turns.*whole number/);
  assert.equal(form.querySelector('button[type=submit]').disabled,false);
  mode.value='autonomous';mode.dispatchEvent(new f.win.Event('change',{bubbles:true}));await f.submit();assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0].body.limits,{mode:'autonomous'});
});

test('routine history reports automatic recovery and never offers a Continue button',async t=>{
  const runs=[{runId:'run_partial',status:'recovering',startedAt:'2026-10-30T10:00:00Z',error:'Generation took too long. <img src=x>',recovery:{status:'retrying',attempt:2,nextAttemptAt:'2026-10-30T10:04:00Z',reason:'Retrying saved progress. <img src=x>'},resume:{checkpointId:'checkpoint_123'}},{runId:'run_remote',status:'failed',startedAt:'2026-10-29T10:00:00Z',recovery:{status:'blocked',reason:'Inspect the uncertain destination.'}},{runId:'run_done',status:'completed',startedAt:'2026-10-28T10:00:00Z'}];
  const f=ui(t,{runs});await f.run('routineHistory("routine_feed")');
  const rows=f.doc.querySelectorAll('.routine-runs li');assert.equal(rows[0].querySelector('.routine-run-status').textContent,'Auto-recovering');assert.equal(rows[1].querySelector('.routine-run-status').textContent,'Needs attention');
  assert.match(rows[0].textContent,/<img src=x>/);assert.match(rows[0].textContent,/Next attempt/);assert.equal(rows[0].querySelector('.routine-run-error'),null);assert.equal(f.doc.querySelector('img'),null);
  assert.equal(f.doc.querySelector('[data-action=resume-routine]'),null);assert.ok(!f.doc.querySelector('dialog').textContent.includes('Continue'));assert.equal(f.requests.length,1);assert.equal(f.requests[0].method,'GET');
});

test('an auto-recovering chat keeps exact Stop and disables sending while presenting recovery as progress',async t=>{
  const f=ui(t);f.win.history.replaceState(null,'','http://studio.local/#/bot/bot_atlas');f.doc.querySelector('#app').innerHTML='<div id="chat-thread"></div><form id="message-form" data-id="bot_atlas"><button class="send" type="submit">Send</button></form>';
  f.run(`activeBot='bot_atlas';chat={messages:[],run:{id:'run_recovering',remoteRunId:'remote_exact',status:'recovering',source:'routine',events:[],recovery:{status:'retrying',reason:'Recovering the next step. <img src=x>'}}};renderThread(botById('bot_atlas'));`);
  const notice=f.doc.querySelector('.run-status');assert.match(notice.textContent,/Auto-recovering/);assert.match(notice.textContent,/<img src=x>/);assert.equal(notice.classList.contains('run-error'),false);assert.equal(notice.querySelector('img'),null);
  const stop=f.doc.querySelector('[data-action=stop-run]');assert.deepEqual(JSON.parse(stop.dataset.run),{runId:'run_recovering',remoteRunId:'remote_exact'});assert.equal(f.doc.querySelector('#message-form .send').disabled,true);assert.equal(f.doc.querySelector('[data-action=resume-routine]'),null);
  assert.equal(f.run('botStatus(botById("bot_atlas")).text'),'Auto-recovering');
  await f.click(stop);assert.deepEqual(f.requests[0],{path:'/api/bots/bot_atlas/stop',method:'POST',body:{runId:'run_recovering',remoteRunId:'remote_exact'}});
});

test('a late history response cannot replace another dialog',async t=>{
  const f=ui(t);let release;
  f.win.waitForHistory=new Promise(resolve=>{release=resolve;});f.run('api=()=>waitForHistory');
  const pending=f.run('routineHistory("routine_feed")');f.run('openDialog("Another dialog","<p>Keep this view.</p>")');
  release({data:[]});await pending;
  assert.equal(f.doc.querySelector('dialog').getAttribute('aria-label'),'Another dialog');assert.match(f.doc.querySelector('dialog').textContent,/Keep this view/);
});

test('the routine editor example executes through the native workflow adapter',async t=>{
  const f=ui(t);f.run('routineDialog("routine_feed")');
  const example=validateRoutineWorkflow(JSON.parse(f.doc.querySelector('.routine-execution .skill-source').textContent)),calls=[];
  const prepared=await prepareRoutineWorkflow(example,{callTool:async(name,args)=>{calls.push({name,args});return {status:200,text:JSON.stringify([{url:'https://example.com/new-item',title:'New example item'}])};}});
  assert.deepEqual(calls,[{name:'http_fetch',args:{url:'https://example.com/feed.json'}}]);assert.equal(prepared.skip,false);assert.match(prepared.context,/New example item/);
});

test('blocked recovery reasons appear as plain text without offering Continue',async t=>{
  const reason='Inspect the uncertain destination. <img src=x onerror=bad()>',f=ui(t,{runs:[{runId:'run_uncertain',status:'failed',startedAt:'2026-10-30T10:00:00Z',recovery:{status:'exhausted',reason}}]});
  await f.run('routineHistory("routine_feed")');assert.equal(f.doc.querySelector('.routine-run-status').textContent,'Needs attention');assert.ok(f.doc.querySelector('.routine-run-error').textContent.includes(reason));
  assert.equal(f.doc.querySelector('img'),null);assert.equal(f.doc.querySelector('[data-action=resume-routine]'),null);
});
