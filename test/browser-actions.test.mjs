import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { EventEmitter } from 'node:events';
import { BrowserSession, Browsers, EgressProxy, findBrowser, forgetBrowserUserAgents, regularUserAgent, prepareBrowserAction, executeBrowserTool, browserActionRequiresApproval, browserToolDefinitions } from '../lib/browser.mjs';
import { OwnerControl, StreamSink, checkEvents } from '../lib/browser-stream.mjs';

const executable=await findBrowser();
const chrome={skip:executable?false:'Chrome or Chromium is unavailable.'};
async function fixture(t) {
  const requests=[];
  const server=http.createServer((request,response)=>{
    requests.push({url:request.url,cookie:request.headers.cookie || ''});response.setHeader('content-type','text/html; charset=utf-8');
    if(request.url==='/auto')return response.end('<title>Review fixture</title><label>Search<input name="q"></label><a href="/account" onclick="fetch(\'/click-effect\')">Browse account</a><button onclick="fetch(\'/commit-effect\')">Submit order</button>');
    if(request.url==='/done' || request.url.startsWith('/done?')){response.setHeader('Set-Cookie','session=verified; Path=/; Max-Age=86400; SameSite=Lax');return response.end('<title>Complete</title><h1>Reservation request received</h1><a href="/account">Account</a>');}
    if(request.url==='/account')return response.end(`<title>Account</title><h1>${request.headers.cookie?.includes('session=verified')?'Signed in':'Signed out'}</h1>`);
    if(request.url==='/cross')return response.end(`<title>Cross origin</title><iframe src="http://localhost:${server.address().port}/frame" title="Cross origin frame" style="width:600px;height:300px"></iframe>`);
    if(request.url.startsWith('/identity')){
      requests.at(-1).ua=request.headers['user-agent'];requests.at(-1).ch=request.headers['sec-ch-ua'] || '';
      const report='<script>window.report=()=>JSON.stringify({ua:navigator.userAgent,brands:(navigator.userAgentData?.brands || []).map(b=>b.brand+"/"+b.version),webdriver:navigator.webdriver,screen:[screen.width,screen.height,innerWidth,innerHeight]});document.title=report();</script>';
      if(request.url==='/identity')return response.end(`<title>Identity</title><iframe src="http://localhost:${server.address().port}/identity-frame"></iframe><button onclick="window.open('/identity-popup')">Open popup</button>${report}`);
      return response.end(`<title>Identity part</title>${report}`);
    }
    if(request.url==='/frame')return response.end('<title>Embedded form</title><label>Embedded value<input name="embedded"></label><button onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<p>Frame clicked</p>\')">Frame action</button>');
    response.end(`<title>Apartment search</title><h1>Search apartments</h1><form action="/done"><label>Destination<input name="city" placeholder="City"></label><label>Arrival<input name="arrival" type="date"></label><label>Guests<select name="guests"><option value="1">One</option><option value="2">Two</option></select></label><label><input name="flexible" type="checkbox">Flexible dates</label><label>Password<input type="password" name="password" value="fixture-secret-never-output"></label><label>Verification<input name="otp" autocomplete="one-time-code" value="123987"></label><button type="submit">Find apartments</button></form><a href="/account" target="_blank">Open account</a><button onclick="alert('Review this change')">Alert</button><button onclick="confirm('Submit this request?')">Confirm</button><button onclick="document.querySelector('button[type=submit]').textContent='Pay now'">Change target</button><iframe src="/frame" title="Embedded form"></iframe>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-browser-actions-'));
  const browsers=new Browsers({directory},{executable,allowPrivate:true,resolver:async()=>[{address:'127.0.0.1',family:4}]});await browsers.recover();
  // Anything the test starts closes before the folder goes: a failing after hook skips the ones registered after it.
  const closers=[],closeFirst=close=>closers.push(close);
  t.after(async()=>{try{for(const close of closers.reverse())await close();await browsers.close();await new Promise(resolve=>server.close(resolve));}finally{await fs.rm(directory,{recursive:true,force:true});}});
  const context={bot:{id:'bot_test',tools:['browser']},runId:'run_test',signal:new AbortController().signal};
  const base=`http://127.0.0.1:${server.address().port}`;
  return {base,browsers,context,requests,directory,closeFirst};
}
/** Owner live control over the task's browser, recording the stream it would send. */
async function owner(session,viewport={width:1280,height:900,dpr:1,touch:false}) {
  const res=new EventEmitter();res.events=[];let buffer='';
  Object.assign(res,{writeHead(){},flushHeaders(){},end(){res.writableEnded=true;res.emit('close');},write(chunk){buffer+=chunk;for(let end=buffer.indexOf('\n\n');end>=0;end=buffer.indexOf('\n\n')){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!block.startsWith(':'))res.events.push({name:/^event: (.*)$/m.exec(block)[1],data:JSON.parse(/^data: (.*)$/m.exec(block)[1])});}return true;}});
  const control=new OwnerControl(session,{idleMs:60_000});await control.attach(new StreamSink(res,'stream_fixture'),viewport);
  const input=events=>control.input(checkEvents(events,{url:value=>new URL(value)}),{webUrl:value=>new URL(value)});
  const click=(x,y,{nav=control.nav}={})=>input([{t:'pointer',kind:'down',x,y,button:0,buttons:1,clickCount:1,tabId:session.tabId,nav},{t:'pointer',kind:'up',x,y,button:0,buttons:0,clickCount:1,dt:20}]);
  const type=text=>input([...text].flatMap(key=>[{t:'key',kind:'down',key},{t:'key',kind:'up',key}]));
  return {control,res,input,click,type};
}
const find=(outline,text)=>{const line=outline.split(/(?=\[e\d+\])/).find(line=>line.includes(`"${text}"`));assert.ok(line,`Missing control ${text}: ${outline}`);return /\[(e\d+)\]/.exec(line)[1];};
const run=async(f,name,args)=>{const prepared=browserActionRequiresApproval(name,{retained:await f.browsers.hasRetained(f.context.bot.id)})?await prepareBrowserAction(f.browsers,f.context,name,args):null;return executeBrowserTool(f.browsers,{...f.context,approvedAction:prepared?.identity},name,args);};

test('form fields use real DOM updates, exact approvals, options and checkboxes before verified navigation',chrome,async t=>{
  const f=await fixture(t);let page=await run(f,'browser_open',{url:f.base});
  assert.match(page.outline,/password field "Password" \[private/);assert.ok(!JSON.stringify(page).includes('fixture-secret-never-output'));assert.ok(!JSON.stringify(page).includes('123987'));
  const args={ref:find(page.outline,'Destination'),revision:page.revision,text:'Kraków'};
  await assert.rejects(executeBrowserTool(f.browsers,f.context,'browser_fill',args),/exact approval/);
  page=await run(f,'browser_fill',args);
  page=await run(f,'browser_type',{ref:find(page.outline,'Destination'),revision:page.revision,text:' centre'});
  page=await run(f,'browser_fill',{ref:find(page.outline,'Arrival'),revision:page.revision,text:'2026-11-02'});
  page=await run(f,'browser_select',{ref:find(page.outline,'Guests'),revision:page.revision,values:['2']});
  page=await run(f,'browser_check',{ref:find(page.outline,'Flexible dates'),revision:page.revision,checked:true});
  const session=f.browsers.sessions.get(f.context.runId);
  const actual=await session.evaluate(function(){return {city:document.querySelector('[name=city]').value,date:document.querySelector('[name=arrival]').value,guests:document.querySelector('[name=guests]').value,flexible:document.querySelector('[name=flexible]').checked};},{});
  assert.deepEqual(actual,{city:'Kraków centre',date:'2026-11-02',guests:'2',flexible:true});
  await assert.rejects(prepareBrowserAction(f.browsers,f.context,'browser_fill',{ref:find(page.outline,'Password'),revision:page.revision,text:'nope'}),/browser_handoff/);
  page=await run(f,'browser_key',{ref:find(page.outline,'Destination'),revision:page.revision,key:'Enter'});
  assert.ok(f.requests.some(request=>request.url.startsWith('/done?city=Krak')));assert.match(page.title,/Complete|Apartment search/);
});

test('approval is refused if the referenced control, form contents or exact action changes',chrome,async t=>{
  const f=await fixture(t);const page=await run(f,'browser_open',{url:f.base}),args={ref:find(page.outline,'Find apartments'),revision:page.revision};
  const prepared=await prepareBrowserAction(f.browsers,f.context,'browser_click',args),session=f.browsers.sessions.get(f.context.runId);
  assert.ok(!JSON.stringify(prepared.review).includes('fixture-secret-never-output'));
  await session.evaluate(function(){document.querySelector('[name=city]').value='Different city';},{});
  await assert.rejects(executeBrowserTool(f.browsers,{...f.context,approvedAction:prepared.identity},'browser_click',args),error=>/changed after approval/.test(error.message) && error.browserDispatched===false);
  await session.evaluate(function(){document.querySelector('button[type=submit]').textContent='Pay now';},{});
  await assert.rejects(prepareBrowserAction(f.browsers,f.context,'browser_click',args),/element is gone or changed/);
  assert.equal(f.requests.filter(request=>request.url.startsWith('/done')).length,0);
});

test('owner-typed text never appears in model outlines, and a press aimed at a replaced page is dropped',chrome,async t=>{
  const f=await fixture(t);await run(f,'browser_open',{url:f.base});const session=f.browsers.sessions.get(f.context.runId),o=await owner(session);
  const oldNav=o.control.nav;await session.navigate(f.base);for(let i=0;i<500 && o.control.nav===oldNav;i++)await new Promise(resolve=>setTimeout(resolve,20));assert.notEqual(o.control.nav,oldNav,'the stream saw the navigation');
  const before=session.dispatchCount,stale=await o.click(20,20,{nav:oldNav});assert.equal(stale.dropped,2);assert.equal(session.dispatchCount,before);
  const field=await session.evaluate(function(){const r=document.querySelector('[name=password]').getBoundingClientRect();return {x:r.x+5,y:r.y+5};},{});
  await o.click(field.x,field.y);await session.evaluate(function(){document.querySelector('[name=password]').value='';},{});await o.type('a-private-owner-secret');
  await o.control.close('resumed','done');
  await session.evaluate(function(){document.body.insertAdjacentHTML('beforeend','<p>a-private-owner-secret</p>');},{});
  const page=await run(f,'browser_snapshot',{});assert.ok(!JSON.stringify(page).includes('a-private-owner-secret'));assert.match(page.outline,/\[private\]/);
  await assert.rejects(run(f,'browser_screenshot',{}),/screenshots are unavailable after private owner input/);
  const text=await run(f,'browser_text',{});assert.ok(!text.text.includes('a-private-owner-secret'));
  assert.equal(session.ownerTouched,true,'a later retained-profile reuse needs approval');
});

test('owner clicks land in a cross-origin frame while invisible verification bookkeeping keeps changing the page',chrome,async t=>{
  const f=await fixture(t);await run(f,'browser_open',{url:`${f.base}/cross`});const session=f.browsers.sessions.get(f.context.runId);
  const frames=await session.frames(),child=frames.find(frame=>frame.parentId);assert.ok(child);
  const update=function(){
    let token=document.querySelector('[name=verification_token]');
    if(!token){token=document.createElement('input');token.type='hidden';token.name='verification_token';document.body.append(token);}
    token.value=String(Number(token.value || 0)+1);document.body.dataset.verificationTick=token.value;
  };
  const o=await owner(session);
  const point=await session.evaluate(function(){const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y};},{},session.mainFrame);
  const button=await session.evaluate(function(){const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},{},child.id);
  for(let i=0;i<3;i++){await session.evaluate(update,{},session.mainFrame);await session.evaluate(update,{},child.id);}
  assert.equal((await o.click(point.x+2+button.x,point.y+2+button.y)).dropped,0);
  assert.match(await session.evaluate(function(){return document.body.innerText;},{},child.id),/Frame clicked/);
  await o.control.close('resumed','done');
});

test('owner input is bound to the tab and main-frame navigation, not to DOM details that change',chrome,async t=>{
  const f=await fixture(t);await run(f,'browser_open',{url:f.base});const session=f.browsers.sessions.get(f.context.runId),o=await owner(session);
  for(const change of ['label','destination','replacement','overlay','moved']) {
    const before=session.dispatchCount;
    await session.evaluate(function({change}){
      const button=document.querySelector('button[type=submit]');
      if(change==='label')button.textContent='Pay now';
      if(change==='destination')document.querySelector('a').href='/different-account';
      if(change==='replacement')button.replaceWith(button.cloneNode(true));
      if(change==='moved')button.style.transform='translateX(5px)';
      if(change==='overlay'){const overlay=document.createElement('div');overlay.style.cssText='position:fixed;left:0;top:0;width:5px;height:5px;z-index:9999';document.body.append(overlay);}
    },{change});
    assert.equal((await o.input([{t:'pointer',kind:'move',x:600,y:600}])).dropped,0,change);assert.equal(session.dispatchCount,before,'owner input does not count as a bot dispatch');
  }
  const frames=o.res.events.filter(event=>event.name==='frame').length;assert.ok(frames>=1);
  const otherTab=await o.click(10,10,{nav:o.control.nav});assert.equal(otherTab.dropped,0);
  await o.control.close('resumed','done');
});

test('tabs, embedded frames and JavaScript dialogs have explicit bounded controls',chrome,async t=>{
  const f=await fixture(t);let page=await run(f,'browser_open',{url:f.base});
  page=await run(f,'browser_click',{ref:find(page.outline,'Open account'),revision:page.revision});
  const tabs=await run(f,'browser_tabs',{});assert.equal(tabs.tabs.length,2);
  const second=tabs.tabs.find(tab=>tab.id!==tabs.tabId);page=await run(f,'browser_switch_tab',{tabId:second.id});assert.match(page.outline,/Signed out/);
  page=await run(f,'browser_close_tab',{tabId:second.id});
  const frames=await run(f,'browser_frames',{});const child=frames.frames.find(frame=>frame.parentId);assert.ok(child);
  page=await run(f,'browser_select_frame',{frameId:child.id});assert.match(page.outline,/Embedded value/);
  page=await run(f,'browser_fill',{ref:find(page.outline,'Embedded value'),revision:page.revision,text:'inside frame'});
  page=await run(f,'browser_click',{ref:find(page.outline,'Frame action'),revision:page.revision});assert.match(page.outline,/Frame clicked/);
  page=await run(f,'browser_select_frame',{frameId:'main'});
  page=await run(f,'browser_click',{ref:find(page.outline,'Alert'),revision:page.revision});assert.equal(page.dialog.type,'alert');
  page=await run(f,'browser_dialog',{accept:true});assert.ok(!page.dialog);
});

test('cross-origin frame fields and owner snapshots remain bound to their own document',chrome,async t=>{
  const f=await fixture(t);await run(f,'browser_open',{url:`${f.base}/cross`});
  const frames=await run(f,'browser_frames',{}),child=frames.frames.find(frame=>frame.parentId);assert.ok(child);
  let page=await run(f,'browser_select_frame',{frameId:child.id});assert.match(page.url,/localhost/);
  page=await run(f,'browser_fill',{ref:find(page.outline,'Embedded value'),revision:page.revision,text:'cross origin'});
  page=await run(f,'browser_click',{ref:find(page.outline,'Frame action'),revision:page.revision});assert.match(page.outline,/Frame clicked/);
  const session=f.browsers.sessions.get(f.context.runId),o=await owner(session);
  await session.evaluate(function(){document.querySelector('input').value='a value changed by script';},{});
  assert.equal((await o.click(20,20)).dropped,0,'script changes do not invalidate the owner’s live picture');
  await o.control.close('resumed','done');
  assert.equal(await session.evaluate(function(){return innerWidth;},{},session.mainFrame),1280);
});

test('task cancellation during startup closes its browser and cannot resurrect the session',chrome,async t=>{
  const f=await fixture(t),pending=f.browsers.session('run_cancel','bot_cancel');
  const closed=f.browsers.closeRun('run_cancel');await assert.rejects(pending,/task ended/);await closed;
  assert.equal(f.browsers.sessions.has('run_cancel'),false);await assert.rejects(f.browsers.session('run_cancel','bot_cancel'),/task has ended/);
});

test('owner opt-in retains a private per-bot login across tasks and forgetting removes it',chrome,async t=>{
  const f=await fixture(t);await run(f,'browser_open',{url:`${f.base}/done`});await f.browsers.setRetained('run_test','bot_test',true);
  await assert.rejects(f.browsers.setRetained('run_test','bot_other',true),/another bot/);
  await f.browsers.closeRun('run_test');assert.equal(await f.browsers.hasRetained('bot_test'),true);
  f.context.runId='run_next';
  await assert.rejects(executeBrowserTool(f.browsers,f.context,'browser_open',{url:`${f.base}/account`}),/exact approval/);
  const page=await run(f,'browser_open',{url:`${f.base}/account`});assert.match(page.outline,/Signed in/);
  await f.browsers.setRetained('run_next','bot_test',false);await f.browsers.closeRun('run_next');assert.equal(await f.browsers.hasRetained('bot_test'),false);
});

test('browser action schemas omit arbitrary evaluation and filter workspace transfers',()=>{
  const tools=browserToolDefinitions({vision:false,workspace:false});assert.ok(tools.some(tool=>tool.name==='browser_fill'));assert.ok(!tools.some(tool=>/eval|upload|download|screenshot/.test(tool.name)));
  for(const name of ['browser_click','browser_fill','browser_key','browser_select','browser_dialog','browser_upload','browser_download'])assert.equal(browserActionRequiresApproval(name),true);
  assert.equal(browserActionRequiresApproval('browser_open'),false);assert.equal(browserActionRequiresApproval('browser_open',{retained:true}),true);
});

test('browser startup filesystem errors close the already opened proxy',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-browser-setup-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const blocker=path.join(directory,'regular-file');await fs.writeFile(blocker,'preserve');
  const original=EgressProxy.prototype.listen;let proxy;
  t.mock.method(EgressProxy.prototype,'listen',function(...args){proxy=this;return original.apply(this,args);});
  await assert.rejects(BrowserSession.start({executable:'/not-a-browser',profileRoot:blocker}),/browser could not start/);
  assert.ok(proxy);assert.equal(proxy.server.listening,false);assert.equal(proxy.closed,true);assert.equal(await fs.readFile(blocker,'utf8'),'preserve');
});

test('failed browser startup preserves an existing retained profile and drains all waits',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-browser-retained-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const profilePath=path.join(directory,'saved');await fs.mkdir(profilePath);await fs.writeFile(path.join(profilePath,'sentinel'),'existing sign-in');
  const before=Date.now();await assert.rejects(BrowserSession.start({executable:'/nonexistent/browser-program',profileRoot:directory,profilePath}),/browser could not start/);
  assert.ok(Date.now()-before<5000,'a spawn error drains protocol waits without the fifteen-second startup timeout');assert.equal(await fs.readFile(path.join(profilePath,'sentinel'),'utf8'),'existing sign-in');
});

test('retention storage failures still close Chrome, proxy and scratch without overwriting sign-ins',chrome,async t=>{
  const f=await fixture(t);await run(f,'browser_open',{url:f.base});const session=f.browsers.sessions.get(f.context.runId),scratch=session.scratch,temporaryProfile=session.profile;
  const destination=path.join(f.directory,'existing-profile');await fs.mkdir(destination);await fs.writeFile(path.join(destination,'sentinel'),'newer sign-in');session.retained=true;session.retainTarget=destination;
  const first=f.browsers.closeRun(f.context.runId),second=f.browsers.closeRun(f.context.runId);assert.equal(first,second,'concurrent closes await the same drain');
  await assert.rejects(first,/Existing sign-ins were preserved/);assert.equal(session.exited,true);assert.equal(session.proxy.server.listening,false);await assert.rejects(fs.stat(scratch),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(destination,'sentinel'),'utf8'),'newer sign-in');assert.ok((await fs.stat(temporaryProfile)).isDirectory(),'unpublished retained profile remains recoverable on storage failure');assert.equal(f.browsers.owners.size,0);
});

test('late browser results keep their private redaction after the task removes the session',chrome,async t=>{
  const f=await fixture(t);await run(f,'browser_open',{url:f.base});const session=f.browsers.sessions.get(f.context.runId),text=session.text;
  session.keepPrivate('late-owner-secret');session.text=async()=>{f.browsers.sessions.delete(f.context.runId);return 'Page echoed late-owner-secret';};
  try {const result=await executeBrowserTool(f.browsers,f.context,'browser_text',{});assert.equal(result.text,'Page echoed [private]');}
  finally {session.text=text;f.browsers.sessions.set(f.context.runId,session);}
});

test('Approve for me edits a field and follows a link automatically, but stops before a committing button',chrome,async t=>{
  const f=await fixture(t),store=await new Store(f.directory).init();
  await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture'});Object.assign(state.bots[0],{connectionId:'fixture',tools:['browser'],approvalPolicy:'auto',collaborators:[]});});
  let turn=0;
  const engine=new NativeEngine(store,{runTimeout:30000,providers:{async complete(_connection,request){
    turn++;const page=turn>1?JSON.parse(request.messages.filter(m=>m.role==='tool').at(-1).content):null;
    const tool=(name,args)=>({text:'',toolCalls:[{id:`auto-${turn}`,name,arguments:args}]});
    if(turn===1)return tool('browser_open',{url:`${f.base}/auto`});
    if(turn===2)return tool('browser_fill',{ref:find(page.outline,'Search'),revision:page.revision,text:'A routine query'});
    if(turn===3)return tool('browser_click',{ref:find(page.outline,'Browse account'),revision:page.revision});
    if(turn===4){assert.match(page.title,/Account/);return tool('browser_open',{url:`${f.base}/auto`});}
    if(turn===5)return tool('browser_click',{ref:find(page.outline,'Submit order'),revision:page.revision});
    return {text:'The site action was denied.',toolCalls:[]};
  }}});
  engine.browsers=f.browsers;await engine.recover();f.closeFirst(()=>engine.close());
  const started=await engine.start('bot_atlas','Research this fixture and inspect the proposed order.');
  for(let i=0;i<3000&&store.state.runs.bot_atlas?.status!=='waiting_for_approval';i++)await new Promise(resolve=>setTimeout(resolve,10));
  const run=store.state.runs.bot_atlas;assert.equal(run.status,'waiting_for_approval');
  assert.deepEqual(run.events.filter(e=>e.type==='approval.automatic').map(e=>e.tool),['browser_fill','browser_click']);
  assert.equal(f.requests.some(r=>r.url==='/click-effect'||r.url==='/commit-effect'),false,'automatic links use navigation, never page click handlers');
  const prompt=run.pending_controls[0];assert.equal(prompt.tool,'browser_click');assert.match(prompt.review.riskReason,/consequences/);
  await engine.control('bot_atlas','approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:prompt.prompt_id,execution_generation:run.execution_generation,choice:'deny'});
  await engine.tasks.get(started.id);assert.equal(store.state.runs.bot_atlas.status,'completed');
  assert.equal(f.requests.some(r=>r.url==='/commit-effect'),false);
});

test('automatic link navigation still binds href, download state and exact view identity',chrome,async t=>{
  const f=await fixture(t);let page=await run(f,'browser_open',{url:`${f.base}/auto`});
  let args={ref:find(page.outline,'Browse account'),revision:page.revision};
  let prepared=await prepareBrowserAction(f.browsers,f.context,'browser_click',args);
  assert.equal(prepared.identity.navigation,`${f.base}/account`);
  const session=f.browsers.sessions.get(f.context.runId);
  await session.evaluate(function(){document.querySelector('a').setAttribute('download','file');},{});
  await assert.rejects(executeBrowserTool(f.browsers,{...f.context,approvedAction:{...prepared.identity,followLink:true}},'browser_click',args),/changed/);
  page=await run(f,'browser_snapshot',{});args={ref:find(page.outline,'Browse account'),revision:page.revision};
  prepared=await prepareBrowserAction(f.browsers,f.context,'browser_click',args);assert.equal(prepared.identity.navigation,null,'downloads cannot become automatic links');
  assert.equal(f.requests.some(r=>r.url==='/account'),false);
});

test('Approve for me submits an ordinary requested browser form through independent review',chrome,async t=>{
  const f=await fixture(t),store=await new Store(f.directory).init(),reviews=[];
  await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture'});Object.assign(state.bots[0],{connectionId:'fixture',tools:['browser'],approvalPolicy:'auto',collaborators:[]});});
  let turn=0;const engine=new NativeEngine(store,{runTimeout:30000,providers:{complete:async(_c,request)=>{
    turn++;const page=turn>1?JSON.parse(request.messages.findLast(row=>row.role==='tool').content):null;
    const tool=(name,args)=>({toolCalls:[{id:`form-${turn}`,name,arguments:args}]});
    if(turn===1)return tool('browser_open',{url:f.base});
    if(turn===2)return tool('browser_fill',{ref:find(page.outline,'Destination'),revision:page.revision,text:'Kraków'});
    if(turn===3)return tool('browser_click',{ref:find(page.outline,'Find apartments'),revision:page.revision});
    return {text:'The requested search form was submitted.',toolCalls:[]};
  },reviewAction:async(_c,request)=>{const payload=JSON.parse(request.messages[1].content);reviews.push(payload);return {toolCalls:[{name:'action_review_result',arguments:{actionDigest:payload.actionDigest,decision:'approve',risks:[],reason:'Submit the requested apartment search.'}}]};}}});
  engine.browsers=f.browsers;await engine.recover();f.closeFirst(()=>engine.close());
  const started=await engine.start('bot_atlas','Search apartments in Kraków using this fixture form.');await engine.tasks.get(started.id);
  const actual=store.state.runs.bot_atlas;assert.equal(actual.status,'completed');assert.equal(actual.events.some(row=>row.type==='approval.request'),false);assert.equal(reviews.length,1);assert.equal(reviews[0].action.review.control,'Find apartments');assert.ok(f.requests.some(row=>row.url.startsWith('/done?city=Krak')));
});

test('the task browser identifies as regular Chrome without webdriver, in frames, popups, request headers and retained profiles',chrome,async t=>{
  const f=await fixture(t),version=async session=>Number(/Chrome\/(\d+)/.exec((await session.pipe.send('Browser.getVersion')).product)[1]);
  const check=(report,major,where)=>{
    assert.ok(!/headless/i.test(JSON.stringify(report)),`${where}: ${JSON.stringify(report)}`);assert.equal(report.webdriver,false,where);
    assert.equal(Number(/Chrome\/(\d+)/.exec(report.ua)[1]),major,where);assert.ok(report.brands.some(brand=>brand.endsWith(`/${major}`)),where);
    assert.match(report.ua,process.platform==='darwin'?/Macintosh/:process.platform==='linux'?/Linux/:/Windows/,`${where}: the real platform stays`);
    assert.ok(report.screen[0]>=report.screen[2] && report.screen[1]>=report.screen[3],`${where}: screen ${report.screen}`);
  };
  for(const runId of ['run_test','run_retained']) {
    f.context.runId=runId;await run(f,'browser_open',{url:`${f.base}/identity`});const session=f.browsers.sessions.get(runId),major=await version(session);
    check(JSON.parse(await session.evaluate(function(){return document.title;},{},session.mainFrame)),major,`${runId} main`);
    const child=(await session.frames()).find(frame=>frame.parentId);check(JSON.parse(await session.evaluate(function(){return document.title;},{},child.id)),major,`${runId} cross-origin frame`);
    const button=await session.evaluate(function(){const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},{});
    const opened=f.requests.filter(request=>request.url==='/identity-popup').length;await session.pointer(button.x,button.y);
    for(let i=0;i<200 && f.requests.filter(request=>request.url==='/identity-popup').length===opened;i++)await new Promise(resolve=>setTimeout(resolve,20));
    let popup;for(let i=0;i<100 && !popup;i++){popup=(await session.tabs()).find(tab=>/identity-popup/.test(tab.url));if(!popup)await new Promise(resolve=>setTimeout(resolve,20));}assert.ok(popup,'popup opened');
    await session.switchTab(popup.id);let title='';for(let i=0;i<100 && !title.startsWith('{');i++){title=await session.evaluate(function(){return document.title;},{}).catch(()=>'');if(!title.startsWith('{'))await new Promise(resolve=>setTimeout(resolve,20));}
    check(JSON.parse(title),major,`${runId} popup`);
    for(const request of f.requests.filter(request=>request.url.startsWith('/identity') && !request.checked)){request.checked=true;assert.ok(request.ua && !/headless/i.test(request.ua+request.ch),`${request.url} headers: ${request.ua} ${request.ch}`);assert.ok(request.ch.includes(`v="${major}"`),`${request.url} client hints`);}
    if(runId==='run_test'){await f.browsers.setRetained(runId,'bot_test',true);await f.browsers.closeRun(runId);assert.equal(await f.browsers.hasRetained('bot_test'),true);}
  }
});

test('regularUserAgent replaces only the headless product token and refuses unusable values',()=>{
  assert.equal(regularUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/157.0.0.0 Safari/537.36'),'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36');
  assert.equal(regularUserAgent('Mozilla/5.0 Chrome/157.0.0.0'),'Mozilla/5.0 Chrome/157.0.0.0');
  for(const bad of ['',null,'Headless Mozilla/5.0','Chrome/1\n','x'.repeat(513)])assert.equal(regularUserAgent(bad),null);
});

test('a cold start reads the browser’s own user agent and relaunches once, so the first page never sees HeadlessChrome',chrome,async t=>{
  // Regression: a separate probe browser used to read the user agent; when it was slow or failed (busy CI runners),
  // tasks silently launched with the HeadlessChrome token for ten minutes.
  forgetBrowserUserAgents();
  const f=await fixture(t);f.context.runId='run_cold';await run(f,'browser_open',{url:`${f.base}/identity`});
  const session=f.browsers.sessions.get('run_cold'),report=JSON.parse(await session.evaluate(function(){return document.title;},{},session.mainFrame));
  assert.ok(!/headless/i.test(report.ua),report.ua);assert.equal(report.webdriver,false);
  assert.ok(session.child.spawnargs.some(arg=>/^--user-agent=.*Chrome\//.test(arg) && !/Headless/i.test(arg)),'launched with the corrected user agent');
  const request=f.requests.find(row=>row.url==='/identity');assert.ok(request && !/headless/i.test(request.ua),`request header: ${request?.ua}`);
});
