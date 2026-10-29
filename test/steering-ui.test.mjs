import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n'),tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(t,{steer=async()=>({accepted:true,update:{status:'queued'}})}={}) {
  const dom=new JSDOM('<div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'https://studio.test/#/bot/bot_atlas',runScripts:'outside-only'}),win=dom.window,doc=win.document,requests=[];
  win.matchMedia=()=>({matches:false,addEventListener(){}});win.setInterval=()=>1;win.scrollTo=()=>{};
  const context=dom.getInternalVMContext();vm.runInContext(source,context);
  const active={id:'run_original',remoteRunId:'remote_original',botId:'bot_atlas',source:'chat',sessionId:'bot_atlas',status:'running',createdAt:'2026-10-28T12:00:00Z'},thread={run:active,messages:[]};
  win.fixtureApi=async(route,options={})=>{requests.push({route,options});if(route.endsWith('/steer'))return steer(options.body);if(route.endsWith('/messages'))return {body:JSON.parse(JSON.stringify(thread)),etag:'"fixture"'};throw new Error('Unexpected fixture route');};
  vm.runInContext("auth={authenticated:true,csrf:'fixture'};data={...initialState,bots:[{id:'bot_atlas',name:'Atlas',skills:[],tools:[],collaborators:[]}],connections:[]};api=fixtureApi;refresh=async()=>{};renderApp();",context);
  const query=selector=>doc.querySelector(selector),run=code=>vm.runInContext(code,context),send=async(text)=>{if(text!==undefined)query('#message-input').value=text;query('[data-action="send-direction"]').click();await tick();};
  t.after(()=>win.close());return {win,doc,query,run,thread,requests,send};
}

test('direction is explicit for active owner chats; normal Send stays disabled and prompts/limits block direction',async t=>{
  const h=fixture(t);await tick();assert.equal(h.query('[data-action="send-direction"]').hidden,false);assert.equal(h.query('#message-form .send').disabled,true);assert.equal(h.query('.direction-hint'),null);assert.match(h.query('[data-action="send-direction"]').title,/Files stay for the next message/);
  for(const status of ['waiting_for_approval','waiting_for_input','stopping']){h.thread.run.status=status;await h.run("loadChat('bot_atlas')");assert.equal(h.query('[data-action="send-direction"]').disabled,true);}
  h.thread.run.status='running';h.thread.run.steering={updates:Array.from({length:8},()=>({status:'applied'})),bytes:100};await h.run("loadChat('bot_atlas')");assert.equal(h.query('[data-action="send-direction"]').disabled,true);assert.match(h.query('[data-action="send-direction"]').title,/limit/);
  h.thread.run.source='routine';await h.run("loadChat('bot_atlas')");assert.equal(h.query('[data-action="send-direction"]').hidden,true);
  h.thread.run.source='chat';h.thread.run.status='completed';await h.run("loadChat('bot_atlas')");assert.equal(h.query('[data-action="send-direction"]').hidden,true);assert.equal(h.query('#message-form .send').disabled,false);assert.equal(h.requests.some(item=>item.options.method==='POST'),false);
});

test('guidance sends original exact run IDs and text only, preserves attachments and shows queued/applied/cancelled honestly',async t=>{
  const h=fixture(t,{steer:async body=>{h.thread.messages=[{id:'direction_message',runId:body.runId,role:'user',kind:'steer',steerStatus:'queued',content:body.text}];return {accepted:true,update:{status:'queued'}};}});await tick();h.run("composerAttachments.set('bot_atlas',[{path:'fixture.txt',name:'fixture.txt'}])");await h.send('Use three concise bullets.');
  const request=h.requests.find(item=>item.route.endsWith('/steer'));assert.deepEqual(Object.keys(request.options.body).sort(),['clientUpdateId','remoteRunId','runId','text']);assert.equal(request.options.body.runId,'run_original');assert.equal(request.options.body.remoteRunId,'remote_original');assert.equal(h.query('#message-input').value,'');assert.equal(h.run("composerAttachments.get('bot_atlas').length"),1);assert.match(h.query('.direction-status').textContent,/queued/);assert.equal(h.query('.direction-result').textContent,'Direction queued.');
  h.thread.messages[0].steerStatus='applied';await h.run("loadChat('bot_atlas')");assert.equal(h.query('.direction-status').textContent,'Added to task');
  h.thread.messages[0].steerStatus='cancelled';h.thread.messages[0].steerNotice='<img src=x onerror=alert(1)> stopped';await h.run("loadChat('bot_atlas')");assert.equal(h.query('.direction-status').textContent,'Direction cancelled');assert.equal(h.query('.direction-message-notice img'),null);assert.match(h.query('.direction-message-notice').textContent,/<img/);
  assert.equal(h.requests.filter(item=>item.options.method==='POST').length,1,'No second task is started.');
});

test('an uncertain acknowledgment retains the draft and retry ID; a cancelled receipt never clears the draft',async t=>{
  let attempts=0;const h=fixture(t,{steer:async()=>{if(++attempts===1)throw new TypeError('Lost acknowledgment');return {accepted:true,update:{status:'cancelled'}};}});await tick();await h.send('Keep this guidance.');assert.equal(h.query('#message-input').value,'Keep this guidance.');assert.match(h.query('.direction-result').textContent,/Could not confirm receipt/);await h.send();
  const requests=h.requests.filter(item=>item.route.endsWith('/steer'));assert.equal(requests[0].options.body.clientUpdateId,requests[1].options.body.clientUpdateId);assert.equal(h.query('#message-input').value,'Keep this guidance.');assert.match(h.query('.direction-result').textContent,/cancelled/);
});

test('a late accepted direction preserves newer draft text and reports context admission without claiming fulfillment',async t=>{
  const pending=defer(),h=fixture(t,{steer:()=>pending.promise});await tick();const sending=h.send('First direction');await tick();h.query('#message-input').value='New draft';pending.resolve({accepted:true,update:{status:'applied'}});await sending;await tick();assert.equal(h.query('#message-input').value,'New draft');assert.equal(h.query('.direction-result').textContent,'Added to the task context.');
});

test('logout, navigation and a newer run invalidate pending direction without clearing current text or showing stale notices',async t=>{
  for(const change of ['logout','navigation','newrun'])await t.test(change,async t=>{
    const pending=defer(),h=fixture(t,{steer:()=>pending.promise});await tick();const sending=h.send('Old direction');await tick();
    if(change==='logout'){h.run('auth.authenticated=false;renderAuth();auth={authenticated:true,csrf:"new"};renderApp()');await tick();}
    else if(change==='navigation'){h.win.location.hash='/bots';await tick();h.win.location.hash='/bot/bot_atlas';await tick();}
    else{h.thread.run={...h.thread.run,id:'run_new',remoteRunId:'remote_new'};await h.run("loadChat('bot_atlas')");}
    h.query('#message-input').value='Current draft';pending.resolve({accepted:true,update:{status:'applied'}});await sending;await tick();assert.equal(h.query('#message-input').value,'Current draft');assert.equal(h.query('.direction-result').textContent,'');assert.equal(h.run('pendingDirections.size'),0);
  });
});

test('empty, oversized and multibyte-overflow guidance is refused locally with no request or draft loss',async t=>{
  const h=fixture(t);await tick();for(const text of ['   ','x'.repeat(4001),'界'.repeat(3000)]){await h.send(text);assert.equal(h.query('#message-input').value,text);assert.match(h.query('.direction-result').textContent,/4000 characters and 8 KB/);}assert.equal(h.requests.some(item=>item.route.endsWith('/steer')),false);
});
