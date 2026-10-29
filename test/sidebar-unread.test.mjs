import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
function fixture(t){
  const dom=new JSDOM('<div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'https://studio.test/#/bots',runScripts:'outside-only',pretendToBeVisual:true});
  const win=dom.window;win.setInterval=()=>1;win.matchMedia=()=>({matches:false,addEventListener(){}});
  const context=dom.getInternalVMContext(),run=code=>vm.runInContext(code,context);run(source);
  run("auth={authenticated:true};data={...initialState,bots:[{id:'bot_atlas',name:'Atlas',connectionId:'provider',model:'fixture'},{id:'bot_nova',name:'Nova'}],connections:[{id:'provider',status:'connected'}]};renderApp();");
  t.after(()=>win.close());return {win,doc:win.document,run};
}

test('the sidebar has no availability dots and updates only the unread indicator while typing',async t=>{
  const f=fixture(t),roster=f.doc.querySelector('.roster'),input=f.doc.querySelector('#workspace-search'),row=f.doc.querySelector('[data-nav="/bot/bot_atlas"]');
  assert.equal(f.doc.querySelectorAll('.roster .dot,.roster-unread').length,0);
  roster.scrollTop=37;input.value='Unsent search';input.focus();
  f.win.unreadApi=async()=>({unreadBots:{bot_atlas:'reply_1'}});f.run('api=unreadApi');await f.run('refreshUnread()');
  assert.equal(row.querySelector('.roster-unread').getAttribute('aria-label'),'Unread message');
  assert.equal(f.doc.querySelectorAll('.roster-unread').length,1);
  assert.equal(f.doc.querySelector('.roster'),roster);assert.equal(roster.scrollTop,37);
  assert.equal(f.doc.activeElement,input);assert.equal(input.value,'Unsent search');
});

test('only reading the latest direct reply clears its dot and stale summaries cannot restore it',async t=>{
  const f=fixture(t);f.run("data.unreadBots={bot_atlas:'latest'};updateSidebarUnread()");
  const marker=()=>f.doc.querySelector('.roster-unread');assert.ok(marker());
  f.run("acknowledgeSidebarRead({view:'room',botId:'bot_atlas',messageIds:['latest']})");assert.ok(marker());
  f.run("acknowledgeSidebarRead({view:'bot',botId:'bot_atlas',messageIds:['older']})");assert.ok(marker());
  f.run("acknowledgeSidebarRead({view:'bot',botId:'bot_atlas',messageIds:['latest']})");assert.equal(marker(),null);
  f.run("applyWorkspaceState({...data,unreadBots:{bot_atlas:'latest'}},100);updateSidebar()");assert.equal(marker(),null);
  f.run("data.unreadBots={bot_atlas:'newer'};updateSidebarUnread()");assert.ok(marker());
});

test('out-of-order polling, failed polls and sign-out cannot replace current unread state',async t=>{
  const f=fixture(t),pending=[];f.win.unreadApi=()=>new Promise(resolve=>pending.push(resolve));f.run('api=unreadApi');
  const older=f.run('refreshUnread()'),newer=f.run('refreshUnread()');
  pending[1]({unreadBots:{bot_nova:'new'}});await newer;pending[0]({unreadBots:{bot_atlas:'stale'}});await older;
  assert.ok(f.doc.querySelector('[data-nav="/bot/bot_nova"] .roster-unread'));assert.equal(f.doc.querySelector('[data-nav="/bot/bot_atlas"] .roster-unread'),null);
  f.run('applyWorkspaceState({...data,unreadBots:{}},1);updateSidebarUnread()');assert.equal(f.doc.querySelectorAll('.roster-unread').length,1,'a workspace response older than the unread poll cannot clear a new dot');
  f.win.unreadApi=async()=>{throw new Error('Offline');};f.run('api=unreadApi');await f.run('refreshUnread()');assert.equal(f.doc.querySelectorAll('.roster-unread').length,1);
  f.win.unreadApi=()=>new Promise(resolve=>pending.push(resolve));f.run('api=unreadApi');const signedOut=f.run('refreshUnread()');
  f.run('auth.authenticated=false;renderAuth();data={...initialState};auth={authenticated:true};renderApp()');pending[2]({unreadBots:{bot_atlas:'old_session'}});await signedOut;
  assert.equal(f.doc.querySelector('.roster-unread'),null);
});
