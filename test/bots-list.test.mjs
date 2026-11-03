import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {Store} from '../lib/store.mjs';
import {listDocuments, writeDocument} from '../lib/sync/docs.mjs';
import {dashboard} from '../lib/dashboard.mjs';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(t) {
  const dom=new JSDOM('<div id="app"><main id="main-content"></main></div><div id="toasts"></div>',{url:'https://fixture.test/#/bots'}),{window}=dom;
  const ctx=vm.createContext({window,document:window.document,location:window.location,URL,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(source,ctx);const requests=[];
  ctx.fixtureApi=async(route,options)=>{requests.push({route,options:JSON.parse(JSON.stringify(options))});return {favorite:options.body.favorite};};
  vm.runInContext(`auth={authenticated:true};data={...initialState,bots:[
    {id:'a',name:'Aster',title:'Research',connectionId:'fixture'},
    {id:'b',name:'Birch',title:'Writing',connectionId:'fixture',favorite:true},
    {id:'c',name:'Clover',title:'Planning',connectionId:'fixture'},
    {id:'hidden',name:'Hidden',title:'Hidden',connectionId:'fixture',hidden:true,favorite:true}
  ],connections:[{id:'fixture',type:'openai',status:'connected',defaultModel:'fixture-model'}],botLastMessageAt:{a:'2026-11-01T09:00:00Z',b:'2026-11-01T10:00:00Z'},runs:{a:{status:'completed',updatedAt:'2026-11-01T12:00:00Z'}}};api=fixtureApi;showPage();`,ctx);
  t.after(()=>window.close());
  return {window,requests,run:code=>vm.runInContext(code,ctx),$:selector=>window.document.querySelector(selector),$$:selector=>[...window.document.querySelectorAll(selector)]};
}

test('Bots sorts by message recency, with deterministic ties and empty chats after active conversations',t=>{
  const h=harness(t),names=()=>h.$$('.bot-row:not(.bot-row-new) .bot-row-text strong').map(node=>node.textContent);
  assert.deepEqual(names(),['Birch','Aster','Clover']);assert.equal(h.$('[data-filter="ready"]'),null);assert.doesNotMatch(h.$('#main-content').textContent,/Ready/);
  h.run("data.botLastMessageAt.a='2026-11-01T11:00:00Z';showPage()");assert.deepEqual(names(),['Aster','Birch','Clover']);
  h.run("data.botLastMessageAt.b=data.botLastMessageAt.a;showPage()");assert.deepEqual(names(),['Aster','Birch','Clover']);
});

test('My Tupies follows Bots message order on first paint and live refresh while retaining vertical scroll',t=>{
  const h=harness(t),ids=()=>h.$$('.sidebar .roster-item').map(node=>node.dataset.nav);
  h.run("document.getElementById('app').insertAdjacentHTML('afterbegin',sidebarMarkup(route()));updateSidebar()");
  assert.deepEqual(ids(),['/bot/b','/bot/a','/bot/c']);
  assert.equal(h.run('studioContext().sortBotsByMessage===sortBotsByMessage'),true,'Dashboard receives the same sorter used by Bots');
  h.$('.sidebar .roster').scrollTop=72;
  h.run("data.botLastMessageAt.c='2026-11-01T11:00:00Z';updateSidebar()");
  assert.deepEqual(ids(),['/bot/c','/bot/b','/bot/a']);
  assert.equal(h.$('.sidebar .roster').scrollTop,72);
  h.run("data.bots.find(bot=>bot.id==='b').hidden=true;updateSidebar()");
  assert.deepEqual(ids(),['/bot/c','/bot/a']);
});

test('Bots opens profiles from cards and phone rows while Chat stays a separate action',t=>{
  const h=harness(t);
  for(const selector of ['.bot-card .bot-description','.bot-card-avatar','.bot-card-link','.bot-row-main']){
    h.$(selector).click();assert.equal(h.window.location.hash,'#/bots/b',selector);
  }
  for(const selector of ['.bot-card .open-chat','.bot-row-chat']){
    h.$(selector).click();assert.equal(h.window.location.hash,'#/bot/b',selector);
  }
  h.window.location.hash='#/bots';h.run('window.getSelection=()=>"Selected description"');
  h.$('.bot-card .bot-description').click();assert.equal(h.window.location.hash,'#/bots','selecting card text does not navigate');
});

test('Bots options are scoped to quick actions and mobile Favorites without profile section duplicates',async t=>{
  const h=harness(t),items=()=>h.$$('.popover-menu [role="menuitem"]').map(item=>item.textContent.trim());
  h.$('.bot-card [data-action="bot-menu"]').click();
  assert.deepEqual(items(),['Open chat','Start Mission','Delete bot']);
  assert.equal(h.$('.bot-card [data-action="bot-menu"]').getAttribute('aria-expanded'),'true');
  h.run('closeMenu()');
  const trigger=h.$('.bot-row-more');trigger.click();
  assert.deepEqual(items(),['Open chat','Start Mission','Remove from Favorites','Delete bot']);
  const favorite=h.$('.popover-menu [data-action="toggle-bot-favorite"]');favorite.focus();favorite.click();await tick();
  assert.equal(h.$('.popover-menu'),null);assert.equal(h.window.location.hash,'#/bots');
  assert.equal(h.window.document.activeElement,h.$('.bot-row-more'),'keyboard focus returns to the row options after saving');
  assert.deepEqual(h.requests,[{route:'/api/bots/b',options:{method:'PATCH',body:{favorite:false}}}]);
  h.run('data.missionsAdmission=false;showPage()');h.$('.bot-row-more').click();
  assert.deepEqual(items(),['Open chat','Add to Favorites','Delete bot']);
});

test('Memory and Files entry points navigate to profile tabs without opening legacy dialogs',async t=>{
  const h=harness(t);h.run('openDialog=()=>{throw new Error("Unexpected popup");}');
  for(const tab of ['memory','files']){
    h.$('#main-content').innerHTML=`<button data-action="bot-${tab}" data-id="a">${tab}</button>`;
    h.$('button').click();assert.equal(h.window.location.hash,`#/bots/a/${tab}`);
  }
  assert.deepEqual(h.requests,[],'resource data loads through the profile');
});

test('Favorites can be added and removed without opening chat; hidden favorites stay under Hidden',async t=>{
  const h=harness(t);h.$('[data-filter="favorites"]').click();await tick();
  assert.deepEqual(h.$$('.bot-row-main strong').map(node=>node.textContent),['Birch']);
  const button=h.$('.bot-grid .bot-favorite');assert.equal(button.getAttribute('aria-pressed'),'true');h.run('globalThis.staleStateRequest=++workspaceStateRequest');button.focus();button.click();await tick();
  assert.deepEqual(h.requests,[{route:'/api/bots/b',options:{method:'PATCH',body:{favorite:false}}}]);
  assert.match(h.$('#main-content').textContent,/No favorites yet/);assert.equal(h.window.location.hash,'#/bots');
  assert.equal(h.window.document.activeElement,h.$('[data-filter="favorites"]'));assert.equal(h.run('applyWorkspaceState({...data,bots:[]},staleStateRequest)'),false,'a poll started before the saved preference cannot overwrite it');
  h.$('[data-filter="all"]').click();await tick();h.$('.bot-grid .bot-favorite[data-id="a"]').click();await tick();
  h.$('[data-filter="favorites"]').click();await tick();assert.deepEqual(h.$$('.bot-row-main strong').map(node=>node.textContent),['Aster']);
  h.$('[data-filter="hidden"]').click();await tick();assert.deepEqual(h.$$('.bot-row-main strong').map(node=>node.textContent),['Hidden']);
});

test('message recency and Favorites survive store reload and bot/message replication',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'tupies-bots-list-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init();
  await store.mutate(state=>{
    state.bots[0].favorite=true;
    state.messages.bot_atlas=[
      {id:'request',runId:'run_main',role:'user',source:'chat',createdAt:'2026-11-01T09:00:00Z'},
      {id:'reply',runId:'run_main',role:'assistant',createdAt:'2026-11-01T10:00:00Z'},
      {id:'private_request',runId:'run_private',role:'user',source:'telegram',sessionId:'bot_atlas--telegram-private',createdAt:'2026-11-01T14:00:00Z'},
      {id:'private_reply',runId:'run_private',role:'assistant',createdAt:'2026-11-01T15:00:00Z'},
    ];
    state.runs.bot_atlas={status:'running',updatedAt:'2026-11-01T20:00:00Z'};state.activity=[{botId:'bot_atlas',createdAt:'2026-11-01T21:00:00Z'}];
  });
  assert.equal(store.publicState().botLastMessageAt.bot_atlas,'2026-11-01T10:00:00.000Z');
  assert.equal(store.publicState().botLastMessageAt.bot_nova,null);
  const reloaded=await new Store(directory).init();assert.equal(reloaded.state.bots[0].favorite,true);
  const replica={bots:[],messages:{}};
  for(const [key,value] of listDocuments(reloaded.state,reloaded))if(key.startsWith('bot:')||key.startsWith('msg:'))assert.equal(writeDocument(replica,key,structuredClone(value),reloaded),true);
  assert.equal(replica.bots[0].favorite,true);const reader=new Store(directory);reader.state={...reloaded.state,...replica};
  assert.equal(reader.publicState().botLastMessageAt.bot_atlas,'2026-11-01T10:00:00.000Z');
  assert.equal(Object.hasOwn(replica.bots[0],'lastMessageAt'),false,'recency is derived rather than overwriting shared bot settings');
});

test('an intermediate update alone never proves task completion on Dashboard',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'tupies-progress-dashboard-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init();
  await store.mutate(state=>{state.messages.bot_atlas=[{id:'request',runId:'run_progress',role:'user',source:'chat',content:'Research.',createdAt:new Date().toISOString()},{id:'progress',runId:'run_progress',role:'assistant',kind:'progress',content:'Checking sources.',createdAt:new Date().toISOString()}];});
  assert.ok(!dashboard(store).activity.some(item=>item.id==='run:run_progress'));
});
