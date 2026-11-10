import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Browsers, findBrowser, prepareBrowserAction, executeBrowserTool, browserActionRequiresApproval, browserToolDefinitions } from '../lib/browser.mjs';

const executable=await findBrowser();
const chrome={skip:executable?false:'Chrome or Chromium is unavailable.'};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// More than 200 visible characters and a link: a page that needs no settling.
const PROSE='<h1>Release notes</h1><p>The spring release moves every workspace to the new editor, keeps existing shortcuts, and adds offline drafts for phones and tablets. Administrators can stage the change per team, and nothing is removed before the summer review of the remaining legacy exports.</p><a href="/static">Read the notes</a>';
const PAGES={
  '/static':`<title>Static</title>${PROSE}`,
  '/scripted':`<title>Scripted</title>${PROSE}<script>document.title='Scripted page';</script>`,
  '/short':'<title>Short</title><h1>Thanks</h1><p>Your request was received.</p>',
  '/blank':'<title>Blank</title>',
  '/canvas':'<title>Canvas</title><canvas width="300" height="150"></canvas><script>document.querySelector("canvas").getContext("2d").fillRect(10,10,50,50);</script>',
  // An application shell whose content is inserted by script well after the load event.
  '/late':'<title>Late app</title><div id="root"></div><script>setTimeout(()=>{document.getElementById("root").innerHTML="<h1>Vault overview</h1><p>Total value locked: 4.2M USDC across 318 depositors.</p><p>The vault follows a market-neutral strategy, settles deposits every hour and publishes its positions after each rebalance.</p><a href=\\"/static\\">Depositors</a> <a href=\\"/static\\">Positions</a> <a href=\\"/static\\">History</a>";},800);</script>',
  // Enough static text to look ready, plus a busy skeleton that is replaced a second later.
  '/skeleton':`<title>Skeleton</title>${PROSE}<section id="panel" aria-busy="true"><div class="skeleton-row" style="height:24px;background:#ddd"></div></section><script>setTimeout(()=>{const panel=document.getElementById("panel");panel.removeAttribute("aria-busy");panel.innerHTML="<p>Balance ready: 1,250.00 EUR</p>";},1000);</script>`,
  '/spinner':`<title>Spinner</title>${PROSE}<div class="Loading-Spinner" style="width:20px;height:20px"></div>`,
  '/slow':`<title>Slow</title>${PROSE}<script>setTimeout(()=>{document.body.insertAdjacentHTML("beforeend","<p>Order   confirmed: reference 7731</p>");},2500);</script>`,
  '/alert':'<title>Alert</title><div id="root"></div><script>setTimeout(()=>alert("Session expired"),300);</script>',
};
async function fixture(t) {
  const server=http.createServer((request,response)=>{response.setHeader('content-type','text/html; charset=utf-8');response.end(PAGES[request.url] ?? PAGES['/static']);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-browser-settle-'));
  const browsers=new Browsers({directory},{executable,allowPrivate:true,resolver:async()=>[{address:'127.0.0.1',family:4}]});await browsers.recover();
  t.after(async()=>{await browsers.close();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});});
  const context={bot:{id:'bot_test',tools:['browser']},runId:'run_test',signal:new AbortController().signal},base=`http://127.0.0.1:${server.address().port}`;
  // Tools that need exact approval (a new tab) are prepared first, as the engine does.
  const run=async(name,args={},extra={})=>{const prepared=browserActionRequiresApproval(name)?await prepareBrowserAction(browsers,context,name,args):null;return executeBrowserTool(browsers,{...context,...(prepared?{approvedAction:prepared.identity}:{}),...extra},name,args);};
  const timed=async(name,args)=>{const started=Date.now(),page=await run(name,args);return {page,ms:Date.now()-started};};
  // The first open also starts Chrome; timings are taken on later calls.
  const warm=()=>run('browser_open',{url:`${base}/static`});
  return {base,browsers,context,run,timed,warm,session:()=>browsers.sessions.get(context.runId)};
}

test('content inserted by script after the load event is readable from the first browser_open result',chrome,async t=>{
  const f=await fixture(t);await f.warm();
  const {page,ms}=await f.timed('browser_open',{url:`${f.base}/late`});
  assert.equal(page.title,'Late app');assert.equal(page.status,200);
  assert.match(page.outline,/^# Vault overview/);assert.match(page.outline,/Total value locked: 4\.2M USDC across 318 depositors\./);assert.match(page.outline,/\[e1\] link "Depositors"/);
  assert.equal(page.hint,undefined);assert.equal(page.loading,undefined);
  assert.ok(ms>=800 && ms<6000,`the open waited for the late render, bounded: ${ms} ms`);
  // The same document is not settled again: a later snapshot stays fast.
  const again=await f.timed('browser_snapshot',{});
  assert.match(again.page.outline,/Total value locked/);assert.equal(again.page.revision,page.revision+1);assert.ok(again.ms<1000,`snapshot of a settled page: ${again.ms} ms`);
});

test('a busy skeleton is waited out, and a loading marker that never clears is bounded',chrome,async t=>{
  const f=await fixture(t);await f.warm();
  const replaced=await f.timed('browser_open',{url:`${f.base}/skeleton`});
  assert.match(replaced.page.outline,/Balance ready: 1,250\.00 EUR/);assert.equal(replaced.page.hint,undefined);
  assert.ok(replaced.ms>=1000 && replaced.ms<6000,`skeleton open: ${replaced.ms} ms`);
  const stuck=await f.timed('browser_open',{url:`${f.base}/spinner`});
  assert.match(stuck.page.outline,/# Release notes/);
  assert.ok(stuck.ms>=1900 && stuck.ms<5000,`a permanent spinner costs about two seconds, once: ${stuck.ms} ms`);
  const snapshot=await f.timed('browser_snapshot',{});assert.ok(snapshot.ms<1000,`no second wait for the same document: ${snapshot.ms} ms`);
});

test('browser_wait reports whether text appeared or the DOM went quiet, without throwing',chrome,async t=>{
  const f=await fixture(t);await f.warm();
  const tool=browserToolDefinitions().find(item=>item.name==='browser_wait');
  assert.deepEqual(Object.keys(tool.parameters.properties),['milliseconds','text','until']);assert.deepEqual(tool.parameters.required,[]);assert.ok(tool.description.length<=200);
  const opened=await f.timed('browser_open',{url:`${f.base}/slow`});
  assert.doesNotMatch(opened.page.outline,/Order confirmed/,'a page that already has content is not held for a late addition');
  // Case and whitespace are ignored; the default limit with a condition is five seconds.
  const met=await f.run('browser_wait',{text:'order CONFIRMED: reference'});
  assert.equal(met.waited.condition,'text');assert.equal(met.waited.met,true);assert.ok(met.waited.ms>=0 && met.waited.ms<4500,`met after ${met.waited.ms} ms`);
  assert.match(met.outline,/Order confirmed: reference 7731/);assert.equal(met.revision,opened.page.revision+1);assert.match(met.notice,/untrusted data/);
  const present=await f.timed('browser_wait',{text:'Release notes',milliseconds:15000});
  assert.equal(present.page.waited.met,true);assert.ok(present.ms<1500,`text already present returns at once: ${present.ms} ms`);
  const missed=await f.timed('browser_wait',{text:'this never appears',milliseconds:600});
  assert.deepEqual({condition:missed.page.waited.condition,met:missed.page.waited.met},{condition:'text',met:false});
  assert.ok(missed.page.waited.ms>=600 && missed.ms<3000,`missed after ${missed.page.waited.ms} ms`);
  assert.match(missed.page.outline,/# Release notes/,'the outline is still returned when the condition is not met');
  const quiet=await f.run('browser_wait',{until:'dom-quiet'});
  assert.equal(quiet.waited.condition,'dom-quiet');assert.equal(quiet.waited.met,true);assert.ok(quiet.waited.ms>=250 && quiet.waited.ms<2000,`quiet after ${quiet.waited.ms} ms`);
  const both=await f.run('browser_wait',{text:'reference 7731',until:'dom-quiet',milliseconds:3000});
  assert.equal(both.waited.condition,'text+dom-quiet');assert.equal(both.waited.met,true);
  // The plain pause is unchanged: at most five seconds, no condition report.
  const plain=await f.timed('browser_wait',{milliseconds:100});
  assert.equal(plain.page.waited,undefined);assert.match(plain.page.outline,/# Release notes/);assert.ok(plain.ms>=100 && plain.ms<1500);
  await assert.rejects(f.run('browser_wait',{milliseconds:6000}),error=>error.status===400 && /Invalid browser milliseconds/.test(error.message));
  await assert.rejects(f.run('browser_wait',{text:'x',milliseconds:15001}),error=>error.status===400);
  await assert.rejects(f.run('browser_wait',{until:'network-idle'}),error=>error.status===400);
  await assert.rejects(f.run('browser_wait',{text:'x'.repeat(201)}),error=>error.status===400);
});

test('static pages are not held back by the settle',chrome,async t=>{
  const f=await fixture(t);await f.warm();
  for(const page of ['/static','/scripted','/short']) {
    const {page:result,ms}=await f.timed('browser_open',{url:`${f.base}${page}`});
    assert.ok(result.outline.length>20,page);assert.ok(ms<2500,`${page} opened in ${ms} ms`);
  }
  const snapshot=await f.timed('browser_snapshot',{});assert.ok(snapshot.ms<1500,`snapshot in ${snapshot.ms} ms`);
});

test('an almost empty page carries one hint; pages with content carry none',chrome,async t=>{
  const f=await fixture(t);await f.warm();
  const blank=await f.run('browser_open',{url:`${f.base}/blank`});
  assert.equal(blank.outline,'');assert.equal(blank.references,0);
  assert.match(blank.hint,/little readable text.*browser_wait with text or until:"dom-quiet".*do not reopen the same URL/);
  // Said once for this load of the page; a wait keeps its own result shape.
  assert.equal((await f.run('browser_snapshot',{})).hint,undefined);assert.equal((await f.run('browser_wait',{until:'dom-quiet'})).hint,undefined);
  const normal=await f.run('browser_open',{url:`${f.base}/static`});assert.equal(normal.hint,undefined);assert.equal((await f.run('browser_snapshot',{})).hint,undefined);
  const short=await f.run('browser_open',{url:`${f.base}/short`});assert.match(short.hint,/little readable text/,'a tiny page is named too, since it may be an unfinished shell');
  // A canvas-only page waits for a render that never produces text, then says so.
  const canvas=await f.timed('browser_open',{url:`${f.base}/canvas`});
  assert.match(canvas.page.hint,/draw on a canvas/);assert.ok(canvas.ms>=1400 && canvas.ms<5000,`canvas open: ${canvas.ms} ms`);
  assert.equal((await f.run('browser_snapshot',{})).hint,undefined);
  // A new tab settles and is advised the same way as browser_open.
  const tab=await f.run('browser_new_tab',{url:`${f.base}/late`});assert.match(tab.outline,/Total value locked/);assert.equal(tab.hint,undefined);assert.equal(tab.tabs.length,2);
  const emptyTab=await f.run('browser_new_tab',{url:`${f.base}/blank`});assert.match(emptyTab.hint,/little readable text/);assert.equal(emptyTab.tabs.length,3);
  const reopened=await f.run('browser_open',{url:`${f.base}/blank`});assert.match(reopened.hint,/little readable text/,'a new load of an empty page is named again');assert.equal((await f.run('browser_snapshot',{})).hint,undefined);
});

test('a dialog or Stop during a wait ends it without an error from the wait itself',chrome,async t=>{
  const f=await fixture(t);await f.warm();
  // The alert fires while the settle is waiting for the empty shell to render.
  const {page,ms}=await f.timed('browser_open',{url:`${f.base}/alert`});
  assert.equal(page.dialog.message,'Session expired');assert.equal(page.title,'Browser dialog');assert.equal(page.hint,undefined);assert.ok(ms<4000,`dialog ended the settle: ${ms} ms`);
  // No page function runs while the dialog is open: the wait reports "not met" at once with the dialog outline.
  const blocked=await f.timed('browser_wait',{text:'anything',milliseconds:8000});
  assert.equal(blocked.page.waited.met,false);assert.equal(blocked.page.dialog.type,'alert');assert.ok(blocked.ms<2000,`dialog wait: ${blocked.ms} ms`);
  await f.session().handleDialog(true);
  await f.run('browser_open',{url:`${f.base}/static`});
  // The engine stops a task with a plain AbortError, as here.
  const controller=new AbortController(),started=Date.now();setTimeout(()=>controller.abort(Object.assign(new Error('Task cancelled.'),{name:'AbortError'})),300);
  await assert.rejects(f.run('browser_wait',{text:'this never appears',milliseconds:15000},{signal:controller.signal}),error=>error.name==='AbortError');
  assert.ok(Date.now()-started<3000,`Stop ended the wait after ${Date.now()-started} ms`);
  await delay(50);assert.match((await f.run('browser_snapshot',{})).outline,/# Release notes/,'the browser is still usable after an abandoned wait');
});
