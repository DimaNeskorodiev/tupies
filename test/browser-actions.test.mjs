import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { BrowserSession, Browsers, EgressProxy, findBrowser, prepareBrowserAction, executeBrowserTool, browserActionRequiresApproval, browserToolDefinitions } from '../lib/browser.mjs';

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
    if(request.url==='/frame')return response.end('<title>Embedded form</title><label>Embedded value<input name="embedded"></label><button onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<p>Frame clicked</p>\')">Frame action</button>');
    response.end(`<title>Apartment search</title><h1>Search apartments</h1><form action="/done"><label>Destination<input name="city" placeholder="City"></label><label>Arrival<input name="arrival" type="date"></label><label>Guests<select name="guests"><option value="1">One</option><option value="2">Two</option></select></label><label><input name="flexible" type="checkbox">Flexible dates</label><label>Password<input type="password" name="password" value="fixture-secret-never-output"></label><label>Verification<input name="otp" autocomplete="one-time-code" value="123987"></label><button type="submit">Find apartments</button></form><a href="/account" target="_blank">Open account</a><button onclick="alert('Review this change')">Alert</button><button onclick="confirm('Submit this request?')">Confirm</button><button onclick="document.querySelector('button[type=submit]').textContent='Pay now'">Change target</button><iframe src="/frame" title="Embedded form"></iframe>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-browser-actions-'));
  const browsers=new Browsers({directory},{executable,allowPrivate:true,resolver:async()=>[{address:'127.0.0.1',family:4}]});await browsers.recover();t.after(async()=>{await browsers.close();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  const context={bot:{id:'bot_test',tools:['browser']},runId:'run_test',signal:new AbortController().signal};
  const base=`http://127.0.0.1:${server.address().port}`;
  return {base,browsers,context,requests,directory};
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

test('owner takeover input never appears in model outlines and stale screenshots cannot click',chrome,async t=>{
  const f=await fixture(t);await run(f,'browser_open',{url:f.base});const session=f.browsers.sessions.get(f.context.runId);
  const initial=await session.ownerView();assert.ok(initial.imageBase64.length>1000);
  await session.evaluate(function(){document.body.insertAdjacentHTML('beforeend','<p>A changed page</p>');},{});
  await assert.rejects(session.ownerAction({type:'click',x:20,y:20},initial.identity),/image changed/);
  await session.evaluate(function(){document.querySelector('[name=password]').focus();},{});
  const view=await session.ownerView();await session.ownerAction({type:'text',text:'a-private-owner-secret'},view.identity);
  await session.evaluate(function(){document.body.insertAdjacentHTML('beforeend','<p>a-private-owner-secret</p>');},{});
  const page=await run(f,'browser_snapshot',{});assert.ok(!JSON.stringify(page).includes('a-private-owner-secret'));assert.match(page.outline,/\[private\]/);
  await assert.rejects(run(f,'browser_screenshot',{}),/screenshots are unavailable after private owner input/);
  const text=await run(f,'browser_text',{});assert.ok(!text.text.includes('a-private-owner-secret'));
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
  const session=f.browsers.sessions.get(f.context.runId),owner=await session.ownerView();
  await session.evaluate(function(){document.querySelector('input').value='a value changed by script';},{});
  await assert.rejects(session.ownerAction({type:'click',x:20,y:20},owner.identity),/image changed/);
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
  engine.browsers=f.browsers;await engine.recover();t.after(()=>engine.close());
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
