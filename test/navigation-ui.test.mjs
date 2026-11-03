import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const fixtureData={bots:[{id:'bot_nova',name:'Nova',title:'Writer',connectionId:'provider_1',enabled:true},{id:'bot_atlas',name:'Atlas',connectionId:'provider_1',enabled:true}],connections:[{id:'provider_1',name:'Fixture',type:'openai',status:'connected',defaultModel:'fixture-model'}],activity:[],runs:{},rooms:[],routines:[],skills:[],integrations:[],channels:[],sync:{node:{name:'TX-N-1540',role:'replica'},hub:{name:'Home server',connected:false}}};

// Only the shell is exercised: #app and #main-content keep their markup, every other lookup is absent.
function harness(hash='',modules={},{documentElement}={}) {
  const app={innerHTML:''},main={innerHTML:'',querySelectorAll(){return [];}},mounts=[];
  const document={hidden:false,activeElement:null,documentElement,addEventListener(){},querySelectorAll(){return [];},body:{classList:{add(){},remove(){}}},
    querySelector(selector){if(selector==='#app')return app;if(selector==='#main-content')return main;return null;}};
  const window={addEventListener(){},...modules};
  const ctx=vm.createContext({document,window,location:{hash},URL,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},mounts});
  vm.runInContext(source,ctx,{filename:'app.js'});
  vm.runInContext('data={...initialState,...fixture};auth={authenticated:true,csrf:"fixture"};loadChat=()=>{};loadRoomChat=()=>{};loadSyncPage=()=>{};',Object.assign(ctx,{fixture:fixtureData}));
  return {app,main,mounts,run:code=>vm.runInContext(code,ctx),setHash(value){ctx.location.hash=value;}};
}

test('the sidebar leads with the Dashboard and keeps only Settings at the bottom',()=>{
  const h=harness();h.run('renderApp()');
  const sidebar=h.app.innerHTML.match(/<aside[\s\S]*<\/aside>/)[0];
  for(const label of ['Dashboard','Bots','Team rooms','Routines','Settings'])assert.match(sidebar,new RegExp(`>${label}(<|$)`));
  // Skills moved into Settings, so the sidebar matches the phone's four tabs.
  for(const removed of ['Skills','YOUR BOT WORKSPACE','TX-N-1540','SYNCED','Your workspace','Your bots','Model providers','Messaging channels','Devices &amp; sync','Help &amp; documentation','Integrations','Activity'])assert.ok(!sidebar.includes(removed),removed);
  assert.match(sidebar,/data-nav="\/dashboard"[^>]*aria-current="page"/);
  // An offline home server is still visible without the old engine badge.
  assert.match(sidebar,/data-nav="\/settings"[\s\S]*nav-alert[\s\S]*Waiting for Home server/);
});

test('the header has no workspace breadcrumb, only a page name for phones',()=>{
  const h=harness('#/bots');h.run('renderApp()');
  const header=h.app.innerHTML.match(/<header class="topbar">[\s\S]*?<\/header>/)[0];
  assert.ok(!header.includes('Workspace'));assert.ok(!header.includes('crumb'));
  assert.match(header,/<span class="topbar-title">Bots<\/span>/);
});

test('Settings starts with Skills beside Models and keeps expert sections in a closed disclosure',()=>{
  const h=harness('#/settings');h.run('renderApp()');
  const page=h.app.innerHTML.match(/<section class="page settings-overview">[\s\S]*?<\/section>/)[0];
  const [essentials,advanced]=page.split('<details class="pearl-advanced" data-disclosure="settings-more">');
  assert.deepEqual([...essentials.matchAll(/class="pearl-resource-card" data-nav="\/([^\"]+)"/g)].map(match=>match[1]),['skills','connections','coding','sync','help']);
  assert.match(essentials,/Manage installed skills and assign them to your bots\./);
  for(const view of ['integrations','channels','activity']){
    assert.ok(!essentials.includes(`data-nav="/${view}"`));assert.match(advanced,new RegExp(`data-nav="/${view}"`));
  }
  assert.match(advanced,/<summary>More settings<\/summary>/);assert.match(page,/data-action="logout"/);
});

test('every settings section remains directly reachable with a collapsed section picker',()=>{
  for(const [view,tab] of [['connections','connections'],['skills','skills'],['integrations','integrations'],['channels','channels'],['sync','sync'],['activity','activity'],['help','help']]){
    const h=harness(`#/${view}`);h.run('renderApp()');
    assert.match(h.app.innerHTML,/<h1>Settings<\/h1>/,view);
    assert.match(h.app.innerHTML,new RegExp(`class="settings-tab active" data-nav="/${tab}" aria-current="page"`),view);
    assert.match(h.app.innerHTML,/<details class="pearl-advanced settings-section-picker" data-disclosure="settings-sections">/,view);
    const tabs=h.app.innerHTML.match(/<nav class="settings-tabs"[\s\S]*?<\/nav>/)[0];
    assert.deepEqual([...tabs.matchAll(/data-nav="\/([^\"]+)"/g)].map(match=>match[1]),['skills','connections','integrations','coding','channels','sync','activity','help'],view);
    assert.match(h.app.innerHTML,/data-nav="\/settings">[\s\S]*All settings/,view);
    assert.match(h.app.innerHTML,/data-nav="\/settings" aria-current="page"/,view);
  }
});

test('the Dashboard and bot profile render from their modules and mount after every render',()=>{
  const modules={
    StudioDashboard:{render:ctx=>`<section class="page">dashboard for ${ctx.data.bots.length} bots</section>`,mount:(ctx,root)=>mounts.push(['dashboard',root===undefined?null:'root'])},
    StudioBotProfile:{render:(ctx,id)=>`<section class="page">profile ${id}</section>`,mount:(ctx,id)=>mounts.push(['profile',id])},
  };
  const mounts=[];const h=harness('',modules);
  // No hash at all is the Dashboard too, and it must still load its data.
  h.run('renderApp()');assert.match(h.app.innerHTML,/dashboard for 2 bots/);assert.match(h.app.innerHTML,/data-nav="\/dashboard" aria-current="page"/);
  h.run('showPage()');assert.match(h.main.innerHTML,/dashboard for 2 bots/);assert.deepEqual(mounts,[['dashboard','root'],['dashboard','root']]);
  h.setHash('#/bots/bot_atlas/brain');h.run('renderApp()');assert.match(h.app.innerHTML,/profile bot_atlas/);assert.deepEqual(mounts.at(-1),['profile','bot_atlas']);
  h.setHash('#/bots/missing');h.run('renderApp()');assert.match(h.app.innerHTML,/This bot isn’t here/);assert.equal(mounts.length,3);
  h.setHash('#/bots');h.run('renderApp()');assert.match(h.app.innerHTML,/<h1>Bots<\/h1>/);assert.match(h.app.innerHTML,/data-nav="\/bots\/bot_nova"/);assert.equal(mounts.length,3);
});

test('phones get a five-tab bar and a navigation bar with Settings in the top-right corner',()=>{
  const h=harness('#/routines');h.run('renderApp()');
  const tabbar=h.app.innerHTML.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...tabbar.matchAll(/<span>([^<]+)<\/span>/g)].map(m=>m[1]),['Dashboard','Bots','Mission','Rooms','Routines']);
  assert.match(tabbar,/data-nav="\/rooms" aria-label="Team rooms"/);
  assert.match(tabbar,/class="tab active" data-nav="\/routines" aria-current="page"/);
  assert.ok(!h.app.innerHTML.includes('mobile-menu')&&!h.app.innerHTML.includes('menu-overlay'),'the side menu is gone');
  const header=h.app.innerHTML.match(/<header class="topbar">[\s\S]*?<\/header>/)[0];
  assert.match(header,/class="topbar-settings" data-nav="\/settings" aria-label="Settings"/);
  assert.ok(!header.includes('topbar-back'));
  // Settings is pushed over the tab it was opened from: Back returns there and that tab stays highlighted.
  h.setHash('#/settings');h.run('renderApp()');
  assert.match(h.app.innerHTML,/class="topbar-back" data-nav="\/routines"/);
  assert.ok(!h.app.innerHTML.includes('topbar-settings'));
  assert.match(h.app.innerHTML,/class="tab active" data-nav="\/routines"/);
  // A Settings section is pushed over Settings, so its Back returns to Settings; the tab stays highlighted.
  h.setHash('#/skills');h.run('renderApp()');
  assert.match(h.app.innerHTML,/class="topbar-back" data-nav="\/settings"/);
  assert.match(h.app.innerHTML,/class="tab active" data-nav="\/routines"/);
  // A bot's details go back to Bots.
  h.setHash('#/bots/bot_nova');h.run('renderApp()');
  assert.match(h.app.innerHTML,/class="topbar-back" data-nav="\/bots"/);
  assert.match(h.app.innerHTML,/class="tab active" data-nav="\/bots"/);
});

test('Bots rows open profiles, with separate Chat and options controls',()=>{
  const h=harness('#/bots');h.run('renderApp()');
  const list=h.app.innerHTML.match(/<ul class="bot-list"[\s\S]*?<\/ul>/)[0];
  assert.match(list,/<button class="bot-row-main" data-nav="\/bots\/bot_nova" aria-label="Open Nova’s profile">/);
  assert.match(list,/<button class="icon-button bot-row-chat" data-nav="\/bot\/bot_nova" aria-label="Chat with Nova"/);
  assert.match(list,/<button class="bot-row-more" data-action="bot-menu" data-id="bot_nova" aria-haspopup="menu"/);
  assert.match(list,/<strong>Nova<\/strong><small>Writer<\/small>/);assert.doesNotMatch(list,/>Ready</);
  assert.match(list,/data-action="create-bot"/);
});

test('chat has one action menu and a single entry to bot resources through the profile',()=>{
  const h=harness('#/bots');h.run('renderApp()');
  h.setHash('#/bot/bot_nova');h.run('renderApp()');
  const header=h.app.innerHTML.match(/<header class="chat-header">[\s\S]*?<\/header>/)[0];
  assert.match(header,/class="icon-button chat-back" data-nav="\/bots"/);
  assert.match(header,/class="chat-switcher" data-action="switch-bot" data-id="bot_nova" aria-haspopup="menu"/);
  assert.match(header,/class="chat-switcher-status ready" hidden/);assert.doesNotMatch(header,/>Ready</);
  assert.match(header,/class="icon-button chat-more" data-action="chat-menu" data-id="bot_nova"/);
  assert.ok(!header.includes('data-action="bot-memory"')&&!header.includes('data-action="edit-bot"'));
  assert.equal([...header.matchAll(/data-action="chat-menu"/g)].length,1);
  assert.ok(!h.app.innerHTML.includes('composer-model-summary'),'a configured chat does not put provider metadata in the composer');
  // Menus need a real page to open; capture their items instead.
  h.run('openMenu=(anchor,items)=>{globalThis.menuItems=items;}');
  h.run('chatMenu({},"bot_nova")');const menu=h.run('menuItems');
  for(const [label,attrs] of [['Chat options','data-action="chat-options" data-id="bot_nova"'],['Bot profile','data-nav="/bots/bot_nova"']])
    assert.match(menu,new RegExp(`${attrs.replace(/[/]/g,'\\/')}><span class="menu-text"><span>${label}<\/span>`),label);
  assert.ok(!menu.includes('fixture-model'),'provider metadata is inside Chat options');
  assert.doesNotMatch(menu,/data-action="(?:bot-memory|bot-files|toggle-inspector|edit-bot)"/);
  h.run('botSwitcherMenu({},"bot_nova")');const switcher=h.run('menuItems');
  assert.ok(switcher.indexOf('/bot/bot_nova')<switcher.indexOf('/bot/bot_atlas'),'the current bot comes first');
  assert.match(switcher,/aria-checked="true" data-nav="\/bot\/bot_nova"/);
  assert.match(switcher,/data-nav="\/bots"[\s\S]*All bots/);
});

test('inside the iPhone app the page takes over navigation and Settings opens the app’s server switcher',()=>{
  const posted=[];
  const h=harness('#/connections',{matchMedia:()=>({matches:true}),webkit:{messageHandlers:{hermesStudio:{postMessage:message=>posted.push(message)}}}},{documentElement:{dataset:{studioApp:'ios'}}});
  h.run('renderApp()');
  assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))),{type:'chrome',ownsChrome:true});
  assert.match(h.app.innerHTML,/class="app-server-row glass-card" data-action="app-settings"[\s\S]*TX-N-1540[\s\S]*Waiting for Home server/);
  h.run('tellApp({type:"app-settings"})');assert.equal(posted.at(-1).type,'app-settings');
  h.run('auth={authenticated:false};renderAuth()');assert.equal(posted.at(-1).ownsChrome,false);
  // In a browser there is no app row.
  const browser=harness('#/connections');browser.run('renderApp()');assert.ok(!browser.app.innerHTML.includes('app-server-row'));
});
