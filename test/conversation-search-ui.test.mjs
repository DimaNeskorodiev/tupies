import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n'),mobile=await readFile(new URL('../public/mobile.js',import.meta.url),'utf8');
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const result=(messageId='message_target',changes={})=>({scope:'bot',conversationId:'bot_atlas',name:'Atlas',messageId,role:'assistant',createdAt:'2026-10-28T12:00:00Z',excerpt:'An earlier decision.',...changes});
const reply=items=>({results:items,total:items.length,truncated:false,hasMore:false});
function fixture(t,{search=async()=>reply([result()]),phone=false}={}) {
  const dom=new JSDOM('<div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'https://studio.test/#/bot/bot_atlas',runScripts:'outside-only'}),win=dom.window,doc=win.document,requests=[],scrolls=[];
  win.matchMedia=query=>({matches:query.includes('reduced-motion')?true:phone,addEventListener(){},removeEventListener(){}});win.setInterval=()=>1;win.scrollTo=()=>{};win.requestAnimationFrame=()=>1;win.cancelAnimationFrame=()=>{};
  win.HTMLElement.prototype.scrollIntoView=function(options){scrolls.push({id:this.dataset.searchMessageId,options});};
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
  const context=dom.getInternalVMContext();vm.runInContext(mobile,context);vm.runInContext(source,context);
  win.fixtureApi=async(route,options={})=>{
    requests.push({route,options});
    if(route.startsWith('/api/conversations/search?'))return search(route,options);
    if(route.includes('/messages'))return {body:{messages:[{id:'message_other',role:'assistant',content:'Same visible words.'},{id:'message_target',role:'assistant',content:'Same visible words.'}],run:null,drive:null},etag:'"fixture"'};
    throw new Error(`Unexpected fixture request ${route}`);
  };
  vm.runInContext("auth={authenticated:true,csrf:'fixture'};data={...initialState,bots:[{id:'bot_atlas',name:'Atlas',skills:[],tools:[],collaborators:[]},{id:'bot_nova',name:'Nova',skills:[],tools:[],collaborators:[]}],rooms:[{id:'room_one',name:'Team',botIds:['bot_atlas','bot_nova']}]};api=fixtureApi;refresh=async()=>{};renderApp();",context);
  const run=code=>vm.runInContext(code,context),query=selector=>doc.querySelector(selector),submit=async(text='earlier decision')=>{query('#conversation-search-query').value=text;query('#conversation-search-form').dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));await tick();};
  t.after(()=>win.close());return {win,doc,query,run,requests,scrolls,submit};
}

test('desktop has an explicit search entry; Cmd/Ctrl K and workspace Enter open it without losing the workspace filter or current draft',async t=>{
  const h=fixture(t);await tick();assert.match(h.query('.sidebar-conversation-search').textContent,/Search conversations/);
  const draft=h.query('#message-input');draft.value='Keep my unsent draft';
  for(const modifier of ['metaKey','ctrlKey']){h.doc.dispatchEvent(new h.win.KeyboardEvent('keydown',{key:'k',[modifier]:true,bubbles:true,cancelable:true}));assert.equal(h.doc.activeElement.id,'conversation-search-query');h.run('closeDialog()');}
  const filter=h.query('#workspace-search');filter.value='Atlas';filter.dispatchEvent(new h.win.Event('input',{bubbles:true}));assert.equal(h.run('search'),'Atlas');assert.equal(h.query('[data-nav="/bot/bot_nova"]').hidden,true);
  filter.dispatchEvent(new h.win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await tick();
  assert.equal(h.query('#conversation-search-query').value,'Atlas');assert.equal(h.run('search'),'Atlas');assert.equal(h.query('#message-input'),draft);assert.equal(draft.value,'Keep my unsent draft');assert.equal(h.requests.filter(item=>item.route.startsWith('/api/conversations/search?')).length,1);
});

test('search escapes names/excerpts, exposes bounded coverage and sends scope without any model operation',async t=>{
  const h=fixture(t,{search:async()=>({...reply([result('message_target',{name:'<img src=x onerror=alert(1)>',excerpt:'<script>private()</script> & decision'})]),total:31,hasMore:true,truncated:true,notice:'Only a bounded part was searched.'})});await tick();
  h.run("conversationSearchDialog('bot','bot_atlas')");await h.submit();
  const request=h.requests.find(item=>item.route.startsWith('/api/conversations/search?')),url=new URL(request.route,'https://studio.test');assert.equal(url.searchParams.get('scope'),'bot');assert.equal(url.searchParams.get('conversationId'),'bot_atlas');
  assert.equal(h.query('#conversation-search-results img, #conversation-search-results script'),null);assert.match(h.query('#conversation-search-results').textContent,/<script>private\(\)<\/script>/);assert.match(h.query('#conversation-search-results').textContent,/1 of 31 matches/);assert.match(h.query('.conversation-search-notice').textContent,/bounded part/);
  h.query('#conversation-search-scope').value='all';h.query('#conversation-search-scope').dispatchEvent(new h.win.Event('change'));await tick();const all=new URL(h.requests.filter(item=>item.route.startsWith('/api/conversations/search?')).at(-1).route,'https://studio.test');assert.equal(all.searchParams.has('conversationId'),false);
  const count=h.requests.length;await h.submit(Array.from({length:21},(_,i)=>`w${i}`).join(' '));assert.equal(h.requests.length,count);assert.match(h.query('[role="alert"]').textContent,/twenty search words/);
});

test('older responses cannot replace a newer query and closed or replaced searches ignore late results',async t=>{
  const first=deferred(),second=deferred();let count=0;const h=fixture(t,{search:()=>++count===1?first.promise:second.promise});await tick();
  h.run('conversationSearchDialog()');const old=h.submit('first query');await tick();const latest=h.submit('latest query');await tick();second.resolve(reply([result('latest_message',{excerpt:'Latest result.'})]));await latest;await tick();
  first.resolve(reply([result('stale_message',{excerpt:'Stale result.'})]));await old;await tick();assert.match(h.query('#conversation-search-results').textContent,/Latest result/);assert.doesNotMatch(h.query('#conversation-search-results').textContent,/Stale result/);
  const pending=deferred();h.win.fixtureApi=async()=>pending.promise;h.run('api=fixtureApi');const closed=h.submit('closed query');h.run('closeDialog();conversationSearchDialog()');pending.resolve(reply([result('old_dialog',{excerpt:'Old private result.'})]));await closed;assert.doesNotMatch(h.query('#conversation-search-results').textContent,/Old private result/);
});

test('sign-out immediately removes search results and a late result cannot repopulate a new session',async t=>{
  const pending=deferred(),h=fixture(t,{search:()=>pending.promise});await tick();h.run('conversationSearchDialog()');const searching=h.submit();await tick();
  h.run('auth.authenticated=false;renderAuth()');assert.equal(h.query('dialog'),null);assert.match(h.query('#app').textContent,/Welcome back/);
  h.run("auth={authenticated:true,csrf:'new-owner-session'};renderApp();conversationSearchDialog()");pending.resolve(reply([result('old_private_result',{excerpt:'Old session private result.'})]));await searching;
  assert.doesNotMatch(h.query('#conversation-search-results').textContent,/Old session private result/);assert.equal(h.run('pendingSearchMessage'),null);
});

test('opening a result focuses and scrolls its exact message ID, preserves same-chat draft and does not jump again on a poll',async t=>{
  const h=fixture(t);await tick();const loaded=h.requests.filter(item=>item.route.includes('/messages')).length;h.query('#message-input').value='Keep this draft';h.run('conversationSearchDialog()');await h.submit();h.query('.conversation-search-result').click();await tick();
  assert.equal(h.doc.activeElement.dataset.searchMessageId,'message_target');assert.equal(h.scrolls.length,1);assert.equal(h.scrolls[0].id,'message_target');assert.equal(h.scrolls[0].options.behavior,'auto');assert.equal(h.query('#message-input').value,'Keep this draft');
  assert.equal(h.requests.filter(item=>item.route.includes('/messages')).length,loaded,'An existing same-chat result focuses directly, without a reload racing the unchanged poll.');
  await h.run("loadChat('bot_atlas')");assert.equal(h.scrolls.length,1);assert.equal(h.query('[data-search-message-id="message_other"]').classList.contains('search-message-target'),false);
});

test('cross-chat result navigation preserves drafts separately for bots and rooms',async t=>{
  const h=fixture(t,{search:async()=>reply([result('message_target',{scope:'room',conversationId:'room_one',name:'Team'})])});await tick();h.query('#message-input').value='Atlas draft';h.run('conversationSearchDialog()');await h.submit();h.query('.conversation-search-result').click();await tick();
  assert.equal(h.win.location.hash,'#/room/room_one');assert.equal(h.doc.activeElement.dataset.searchMessageId,'message_target');assert.equal(h.query('#room-message-input').value,'');h.query('#room-message-input').value='Room draft';
  h.win.location.hash='/bot/bot_atlas';await tick();assert.equal(h.query('#message-input').value,'Atlas draft');h.win.location.hash='/room/room_one';await tick();assert.equal(h.query('#room-message-input').value,'Room draft');
});

test('the exact target stays inside the thread viewport through polling until the owner scrolls or navigates',async t=>{
  const h=fixture(t);await tick();const thread=h.query('#chat-thread'),target=h.query('[data-search-message-id="message_target"]');
  Object.defineProperties(thread,{clientHeight:{value:440},scrollHeight:{value:600}});thread.scrollTop=150;
  thread.getBoundingClientRect=()=>({top:60,bottom:500,height:440});target.getBoundingClientRect=()=>({top:85-thread.scrollTop,bottom:175-thread.scrollTop,height:90});
  h.run('conversationSearchDialog()');await h.submit();h.query('.conversation-search-result').click();await tick();
  assert.ok(target.getBoundingClientRect().top>=60);assert.ok(target.getBoundingClientRect().bottom<=500);assert.ok(thread.__searchAnchor);
  await h.run("loadChat('bot_atlas')");assert.equal(thread.scrollTop,0,'An unchanged poll must not pin the view back to the latest reply.');
  thread.dispatchEvent(new h.win.Event('wheel',{bubbles:true}));assert.equal(thread.__searchAnchor,undefined,'Owner scrolling releases the search anchor.');
});

test('navigation cancels a pending response, pending message target and delayed sheet-close selection',async t=>{
  const pending=deferred(),h=fixture(t,{search:()=>pending.promise});await tick();h.run('conversationSearchDialog()');const searching=h.submit();await tick();h.win.location.hash='/bots';await tick();pending.resolve(reply([result()]));await searching;assert.equal(h.query('dialog'),null);assert.equal(h.run('pendingSearchMessage'),null);
  h.win.location.hash='/bot/bot_atlas';await tick();let close;h.win.StudioMobile.closeSheet=(_dialog,done)=>{close=done;return true;};h.run('conversationSearchDialog()');h.run("openSearchResult('room','room_one','message_target')");h.win.location.hash='/bots';await tick();close();await tick();assert.equal(h.win.location.hash,'#/bots');assert.equal(h.run('pendingSearchMessage'),null);
  h.run("pendingSearchMessage={scope:'bot',id:'bot_atlas',messageId:'message_target',generation:sendSessionGeneration,navigation:conversationSearchNavigation};");h.win.location.hash='/settings';await tick();h.win.location.hash='/bot/bot_atlas';await tick();assert.equal(h.run('pendingSearchMessage'),null);assert.equal(h.scrolls.length,0);
});

test('a failed conversation refresh retains the target until a successful retry, then reports a truly missing message',async t=>{
  const h=fixture(t);await tick();h.win.fixtureApi=async()=>{throw new Error('Temporary engine error');};h.run('api=fixtureApi;conversationSearchDialog()');h.run("openSearchResult('bot','bot_atlas','message_missing')");await tick();assert.ok(h.run('pendingSearchMessage'));assert.doesNotMatch(h.query('#toasts').textContent,/no longer available/);
  h.win.fixtureApi=async()=>({body:{messages:[],run:null},etag:'"retry"'});await h.run("api=fixtureApi;loadChat('bot_atlas')");assert.equal(h.run('pendingSearchMessage'),null);assert.match(h.query('#toasts').textContent,/no longer available/);
});
