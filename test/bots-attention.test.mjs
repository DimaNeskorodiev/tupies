import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {pendingBotItems} from '../lib/notifications.mjs';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
function fixture(t){
  const dom=new JSDOM('<div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'https://fixture.test/#/bots',runScripts:'outside-only',pretendToBeVisual:true});
  const win=dom.window;win.setInterval=()=>1;win.matchMedia=()=>({matches:false,addEventListener(){}});
  const run=code=>vm.runInContext(code,dom.getInternalVMContext());run(source);
  run("auth={authenticated:true};data={...initialState,bots:[{id:'a',name:'Aster'},{id:'b',name:'Birch'},{id:'hidden',name:'Hidden',hidden:true}]};renderApp()");
  t.after(()=>win.close());return {win,doc:win.document,run};
}
const badges=f=>[...f.doc.querySelectorAll('[data-bots-attention-count]')].map(node=>node.textContent);

test('Bots navigation counts unread replies and pending items rather than the bot total on desktop and phone',t=>{
  const f=fixture(t);assert.deepEqual(badges(f),[]);
  f.run("data.unreadBots={a:'reply',hidden:'hidden_reply',missing:'ignored'};data.pendingBotItems={a:1,b:2,missing:5};renderApp()");
  assert.deepEqual(badges(f),['5','5']);
  for(const button of f.doc.querySelectorAll('.sidebar .nav-item[data-nav="/bots"],.tabbar .tab[data-nav="/bots"]'))assert.equal(button.getAttribute('aria-label'),'Bots, 5 items need your attention');
  f.run("acknowledgeSidebarRead({view:'bot',botId:'a',messageIds:['reply']})");assert.deepEqual(badges(f),['4','4']);
  f.run("data.unreadBots={};data.pendingBotItems={};updateSidebarUnread()");assert.deepEqual(badges(f),[]);
});

test('live item polling preserves drafts and focus and rejects stale or signed-out pending summaries',async t=>{
  const f=fixture(t),input=f.doc.querySelector('#workspace-search'),roster=f.doc.querySelector('.roster'),pending=[];
  input.value='Unsent';input.focus();roster.scrollTop=30;f.win.fixtureApi=()=>new Promise(resolve=>pending.push(resolve));f.run('api=fixtureApi');
  const first=f.run('refreshUnread()'),second=f.run('refreshUnread()');
  pending[1]({unreadBots:{a:'reply'},pendingBotItems:{b:1}});await second;
  pending[0]({unreadBots:{},pendingBotItems:{a:5}});await first;
  assert.deepEqual(badges(f),['2','2']);assert.equal(f.doc.activeElement,input);assert.equal(input.value,'Unsent');assert.equal(f.doc.querySelector('.roster'),roster);assert.equal(roster.scrollTop,30);
  f.run('applyWorkspaceState({...data,pendingBotItems:{}},1);updateSidebarUnread()');assert.deepEqual(badges(f),['2','2']);
  const oldSession=f.run('refreshUnread()');f.run('sendSessionGeneration++;data.pendingBotItems={};data.unreadBots={};updateSidebarUnread()');pending[2]({pendingBotItems:{a:3}});await oldSession;assert.deepEqual(badges(f),[]);
});

test('pending counts deduplicate exact prompt mirrors, include browser help and drop resolved, stopped or stale controls',()=>{
  const state={bots:[{id:'a'},{id:'b',hidden:true},{id:'c'},{id:'d'}],runs:{
    a:{status:'waiting_for_approval',pending_controls:[{kind:'approval',prompt_id:'approve_a'},{kind:'approval',prompt_id:'approve_a'}],approval:{request_id:'approve_a'}},
    b:{status:'waiting_for_input',pending_controls:[{kind:'question',prompt_id:'ask_b',questions:[{prompt:'First'},{prompt:'Second'}]},{kind:'browser',prompt_id:'browser_b'}]},
    c:{status:'completed',pending_controls:[{kind:'question',prompt_id:'stale_c'}]},
    d:{status:'waiting_for_input',stopRequested:true,pending_controls:[{kind:'question',prompt_id:'stopped_d'}]},
  }};
  assert.deepEqual(pendingBotItems(state),{a:1,b:2});state.runs.a.status='running';state.runs.b.pending_controls=[];assert.deepEqual(pendingBotItems(state),{});
});

test('exact local Mission blockers count once alongside prompts and disappear after archive or resolution',()=>{
  const state={bots:[{id:'a'}],runs:{},missions:{mission_a:{id:'mission_a',leadBotId:'a',ownerEngineId:'node_local',state:'waiting',waitCondition:{kind:'attention'},reason:'Needs a revised goal.',contractVersion:1}}};
  assert.deepEqual(pendingBotItems(state,{ownerEngineId:'node_local'}),{a:1});
  assert.deepEqual(pendingBotItems(state,{ownerEngineId:'node_other'}),{});
  state.missions.mission_a.archivedAt='2026-11-03T12:00:00Z';assert.deepEqual(pendingBotItems(state,{ownerEngineId:'node_local'}),{});
});
