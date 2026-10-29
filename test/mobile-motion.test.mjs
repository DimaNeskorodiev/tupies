import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

// Phone motion and gestures in public/mobile.js. Web Animations are recorded instead of played, and
// navigation is simulated the way app.js renders: beforeRender, replace #app, afterRender.
const mobileSource=await readFile(new URL('../public/mobile.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const HAPTICS=['selection','light','medium','rigid','soft','success','warning','error'];

const tabbar=(active,hidden=false)=>`<nav class="tabbar"${hidden?' style="display:none"':''}>${['dashboard','bots','rooms','routines'].map(id=>`<button class="tab ${id===active?'active':''}" data-nav="/${id}" ${id===active?'aria-current="page"':''}>${id}</button>`).join('')}</nav>`;
const screens={
  bots:()=>`<div class="app-shell" data-view="bots"><div class="content"><header class="topbar"><span class="topbar-title">Bots</span></header><main id="main-content"><section class="page"><div class="page-heading"><h1>Bots</h1></div><ul class="bot-list"><li class="bot-row"><button class="bot-row-main" data-nav="/bot/bot_nova"><span class="bot-row-text"><strong>Nova</strong></span></button><button class="bot-row-more" data-nav="/bots/bot_nova">More</button></li><li class="bot-row bot-row-new"><button class="bot-row-main" data-action="create-bot"><strong>New bot</strong></button></li></ul></section></main></div>${tabbar('bots')}</div>`,
  rooms:()=>`<div class="app-shell" data-view="rooms"><div class="content"><header class="topbar"><span class="topbar-title">Team rooms</span></header><main id="main-content"><section class="page"><h1>Team rooms</h1></section></main></div>${tabbar('rooms')}</div>`,
  profile:()=>`<div class="app-shell" data-view="bots"><div class="content"><header class="topbar"><button class="topbar-back" data-nav="/bots">Back</button><span class="topbar-title">Nova</span></header><main id="main-content"><section class="page"><h1>Nova</h1></section></main></div>${tabbar('bots')}</div>`,
  chat:()=>`<div class="app-shell" data-view="bot"><div class="content"><main id="main-content"><section class="chat-page"><div class="chat-main"><header class="chat-header"><button class="icon-button chat-back" data-nav="/bots">Back</button></header><div class="chat-thread" id="chat-thread"></div><div class="chat-composer-wrap"><form id="message-form" class="chat-composer" data-id="bot_nova"><textarea id="message-input" name="text"></textarea><button class="send" type="submit">Send</button></form></div></div></section></main></div>${tabbar('bots',true)}</div>`,
};
const routes={'#/bots':['bots',screens.bots],'#/rooms':['rooms',screens.rooms],'#/bots/bot_nova':['bots',screens.profile,'bot_nova'],'#/bot/bot_nova':['bot',screens.chat,'bot_nova']};

function harness({reduced=false,manualFrames=false}={}) {
  const dom=new JSDOM('<div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'https://studio.test/#/bots',pretendToBeVisual:true});
  const {window}=dom;let scrollY=0;
  window.matchMedia=query=>({matches:query.includes('reduced-motion')?reduced:true,addEventListener(){}});
  Object.defineProperty(window,'innerWidth',{value:390,writable:true});
  Object.defineProperty(window,'innerHeight',{value:844,writable:true});
  Object.defineProperty(window,'scrollY',{get:()=>scrollY});
  const scrolls=[];window.scrollTo=(position,y)=>{scrollY=typeof position==='object'?position.top:y;scrolls.push(position);};
  // Tabs sit 90px apart so the lens has somewhere to glide.
  Object.defineProperty(window.HTMLElement.prototype,'offsetLeft',{configurable:true,get(){return this.matches('.tab')?[...this.parentElement.querySelectorAll('.tab')].indexOf(this)*90:0;}});
  const frames=new Map();let frameId=0;
  if(manualFrames){window.requestAnimationFrame=callback=>{frames.set(++frameId,callback);return frameId;};window.cancelAnimationFrame=id=>frames.delete(id);}
  const animations=[],posted=[],copied=[];
  window.Element.prototype.animate=function(frames,options){
    let resolve,reject;const record={element:this,frames,options,cancelled:false,finished:new Promise((done,fail)=>{resolve=done;reject=fail;})};record.finish=()=>resolve(record);record.interrupt=()=>reject(new Error('Animation interrupted'));
    animations.push(record);
    return {finished:record.finished,cancel(){record.cancelled=true;},effect:{getTiming:()=>({duration:options?.duration||0})}};
  };
  window.webkit={messageHandlers:{hermesStudio:{postMessage:message=>posted.push(message)}}};
  window.document.documentElement.dataset.studioHaptics='true';
  Object.defineProperty(window.navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copied.push(text);}}});
  const viewport=Object.assign(new window.EventTarget(),{height:844,width:390,offsetTop:0,scale:1});
  Object.defineProperty(window,'visualViewport',{value:viewport});
  const context=vm.createContext({window,document:window.document,location:window.location,URL,getComputedStyle:window.getComputedStyle.bind(window)});
  vm.runInContext(mobileSource,context,{filename:'mobile.js'});
  const mobile=window.StudioMobile,query=selector=>window.document.querySelector(selector);
  function go(hash) {
    const [view,markup,id]=routes[hash];
    window.location.hash=hash;mobile.beforeRender();
    query('#app').innerHTML=markup();mobile.afterRender({view,id});
  }
  function touch(target,type,x,y,time,touches=type==='touchend'||type==='touchcancel'?[]:[{clientX:x,clientY:y}]) {
    const event=new window.Event(type,{bubbles:true,cancelable:true});
    Object.assign(event,{touches});Object.defineProperty(event,'timeStamp',{value:time});
    target.dispatchEvent(event);return event;
  }
  const haptics=()=>posted.filter(message=>message.type==='haptic').map(message=>message.style);
  const settleAll=async()=>{for(const animation of animations)animation.finish();await tick();};
  const flushFrames=()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(window.performance.now());};
  return {window,mobile,query,go,touch,animations,haptics,copied,scrolls,settleAll,viewport,frames,flushFrames,setScroll:value=>{scrollY=value;},close:()=>dom.window.close()};
}
// Keyframes come from the page's realm; copy them into plain arrays before comparing.
const transformOf=frames=>Array.from(frames,frame=>frame.transform);
const opacityOf=frames=>Array.from(frames,frame=>frame.opacity);

test('an interrupted navigation animation immediately restores the live screen',async()=>{
  const h=harness();
  try{
    h.go('#/bots');h.go('#/bot/bot_nova');
    h.animations.find(animation=>animation.element===h.query('#app .content')).interrupt();await tick();
    assert.equal(h.query('.motion-layer'),null);
    assert.equal(h.query('#app .content').style.willChange,'');
    assert.equal(h.query('#app .app-shell').style.zIndex,'');
  }finally{h.close();}
});

test('backgrounding or rotating during an edge drag restores the screen without navigating',async()=>{
  for(const event of ['visibilitychange','resize','studio:visible']){
    const h=harness();
    try{
      h.go('#/bots');h.go('#/bot/bot_nova');await h.settleAll();
      const content=h.query('#app .content');let backs=0;
      h.query('.chat-back').addEventListener('click',()=>backs++);
      h.touch(content,'touchstart',5,300,0);h.touch(content,'touchmove',80,302,30);
      assert.ok(content.style.transform);
      if(event==='visibilitychange')Object.defineProperty(h.window.document,'hidden',{value:true,configurable:true});
      (event==='visibilitychange'?h.window.document:h.window).dispatchEvent(new h.window.Event(event));
      assert.equal(content.style.transform,'',event);
      assert.equal(h.query('.motion-layer'),null,event);
      h.touch(content,'touchend',80,302,50);assert.equal(backs,0);
    }finally{h.close();}
  }
});

test('streaming coalesces scroll frames and yields immediately to the owner',async()=>{
  const h=harness({manualFrames:true});
  try{
    h.go('#/bot/bot_nova');const thread=h.query('.chat-thread');let height=1000;
    Object.defineProperty(thread,'scrollHeight',{get:()=>height});Object.defineProperty(thread,'clientHeight',{value:400});
    thread.innerHTML='<article class="chat-message">History</article>';thread.scrollTop=600;await tick();h.flushFrames();
    for(let index=0;index<8;index++){
      height+=40;const node=h.window.document.createElement('article');node.className='partial-message';thread.append(node);
      thread.scrollTop=height-400;await tick();
      assert.equal(h.frames.size,1,'only one scroll frame waits, even when several updates arrive before a repaint');
      assert.ok(height-thread.clientHeight-thread.scrollTop<=64,'bursts stay inside the renderer’s follow threshold');
    }
    thread.dispatchEvent(new h.window.Event('wheel',{bubbles:true}));thread.scrollTop=150;
    assert.equal(h.frames.size,0,'touch/wheel cancels the scheduled scroll immediately');h.flushFrames();
    assert.equal(thread.scrollTop,150);
    height+=40;thread.append(h.window.document.createElement('article'));await tick();h.flushFrames();
    assert.equal(thread.scrollTop,150,'later updates leave the reading position alone');
  }finally{h.close();}
});

test('finishing an old transition cannot remove a newer screen transition',async()=>{
  const h=harness();
  try{
    h.go('#/bots');h.go('#/bot/bot_nova');const old=[...h.animations];
    h.go('#/bots');const layer=h.query('.motion-layer');assert.ok(layer);
    for(const animation of old)animation.finish();await tick();
    assert.equal(h.query('.motion-layer'),layer);
    await h.settleAll();assert.equal(h.query('.motion-layer'),null);
  }finally{h.close();}
});

test('a backgrounded chat settles its pending scroll once and leaves no frame loop',async()=>{
  const h=harness({manualFrames:true});
  try{
    h.go('#/bot/bot_nova');const thread=h.query('.chat-thread');let height=1000;
    Object.defineProperty(thread,'scrollHeight',{get:()=>height});Object.defineProperty(thread,'clientHeight',{value:400});
    thread.innerHTML='<article class="chat-message">History</article>';thread.scrollTop=600;await tick();h.flushFrames();
    height=1080;thread.append(h.window.document.createElement('article'));thread.scrollTop=680;await tick();
    Object.defineProperty(h.window.document,'hidden',{value:true,configurable:true});h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));
    assert.equal(thread.scrollTop,680);h.flushFrames();assert.equal(h.frames.size,0);
  }finally{h.close();}
});

test('cancelled composer resizing cannot keep pinning the transcript',async()=>{
  const h=harness({manualFrames:true});
  try{
    h.go('#/bot/bot_nova');const field=h.query('textarea'),thread=h.query('.chat-thread');
    Object.defineProperty(thread,'scrollHeight',{value:900});Object.defineProperty(thread,'clientHeight',{value:400});thread.scrollTop=500;
    field.focus();h.flushFrames();Object.defineProperty(field,'scrollHeight',{value:80});h.mobile.sizeComposer(field);
    const animation=h.animations.find(animation=>animation.element===field);assert.ok(animation);animation.interrupt();await tick();
    thread.scrollTop=100;h.flushFrames();assert.equal(thread.scrollTop,100);assert.equal(h.frames.size,0);
  }finally{h.close();}
});

test('pushes slide in over a parallaxing screen, pops reverse it and tabs only crossfade',async()=>{
  const h=harness();
  try {
    h.go('#/bots');assert.equal(h.animations.length,0,'the first screen does not animate');
    h.go('#/bot/bot_nova');
    const push=h.animations.find(animation=>animation.element===h.query('#app .content'));
    assert.deepEqual(transformOf(push.frames),['translate3d(390px,0,0)','translate3d(0,0,0)']);
    const layer=h.query('.motion-layer');
    assert.equal(layer.getAttribute('aria-hidden'),'true');assert.ok(layer.querySelector('.bot-list'),'the outgoing screen is an inert copy');
    const under=h.animations.find(animation=>animation.element.matches('.motion-frame'));
    assert.deepEqual(transformOf(under.frames),['translate3d(0,0,0)','translate3d(-117px,0,0)']);
    await h.settleAll();
    assert.equal(h.query('.motion-layer'),null);assert.equal(h.query('#app .content').getAttribute('style')||'','','inline styles are restored');

    h.animations.length=0;h.go('#/bots');
    const pop=h.animations.find(animation=>animation.element.matches('.motion-frame'));
    assert.deepEqual(transformOf(pop.frames),['translate3d(0px,0,0)','translate3d(390px,0,0)']);
    assert.deepEqual(transformOf(h.animations.find(animation=>animation.element===h.query('#app .content')).frames),['translate3d(-117px,0,0)','translate3d(0,0,0)']);
    await h.settleAll();

    h.animations.length=0;h.go('#/rooms');
    assert.ok(!h.animations.some(animation=>animation.element===h.query('#app .content')),'a tab switch does not slide');
    assert.deepEqual(opacityOf(h.animations.find(animation=>animation.element.matches('.motion-frame')).frames),[1,0]);
    const lens=h.animations.find(animation=>animation.element.matches('.tab-lens'));
    assert.deepEqual(transformOf(lens.frames),['translate3d(90px,0,0)','translate3d(180px,0,0)'],'the tab lens glides from Bots to Team rooms');
  } finally {h.close();}
});

test('Reduce Motion turns navigation into crossfades without parallax',async()=>{
  const h=harness({reduced:true});
  try {
    h.go('#/bots');h.go('#/bot/bot_nova');
    assert.ok(h.animations.length>0);
    assert.ok(h.animations.every(animation=>animation.frames.every(frame=>frame.transform===undefined)),'no movement');
    assert.deepEqual(opacityOf(h.animations.find(animation=>animation.element.matches('.motion-frame')).frames),[1,0]);
  } finally {h.close();}
});

test('the edge swipe follows the finger over the previous screen and commits only through Back',async()=>{
  const h=harness();
  try {
    h.go('#/bots');h.go('#/bot/bot_nova');await h.settleAll();h.animations.length=0;
    let backs=0;
    h.window.document.addEventListener('click',event=>{if(event.target.closest?.('.chat-back')){backs++;h.go('#/bots');}});
    const content=h.query('#app .content');
    h.touch(content,'touchstart',5,300,0);h.touch(content,'touchmove',60,302,16);
    assert.equal(content.style.transform,'translate3d(55px,0,0)');
    assert.ok(h.query('.motion-layer .bot-list'),'the Bots screen waits underneath');
    h.touch(content,'touchmove',200,304,200);h.touch(content,'touchmove',60,304,260);h.touch(content,'touchmove',200,304,500);
    assert.deepEqual(h.haptics(),['rigid'],'crossing the threshold taps once per gesture');
    assert.equal(backs,0);
    h.touch(content,'touchend',200,304,900);
    assert.equal(backs,1);assert.deepEqual(h.haptics(),['rigid','light']);
    const pop=h.animations.find(animation=>animation.element.matches('.motion-frame'));
    assert.deepEqual(transformOf(pop.frames),['translate3d(195px,0,0)','translate3d(390px,0,0)'],'the pop continues from the finger');
    assert.equal(h.window.location.hash,'#/bots');
    assert.ok(h.haptics().every(style=>HAPTICS.includes(style)));
  } finally {h.close();}
});

test('a flick commits a short swipe, a reverse flick cancels a long one and nothing else navigates',async()=>{
  const h=harness();
  try {
    h.go('#/bots');h.go('#/bot/bot_nova');await h.settleAll();
    let backs=0;h.window.document.addEventListener('click',event=>{if(event.target.closest?.('.chat-back'))backs++;});
    let content=h.query('#app .content');
    // Slow and short: springs back.
    h.touch(content,'touchstart',5,300,0);h.touch(content,'touchmove',30,300,100);h.touch(content,'touchmove',70,300,400);h.touch(content,'touchend',70,300,700);
    assert.equal(backs,0);await h.settleAll();assert.equal(h.query('.motion-layer'),null);assert.equal(content.getAttribute('style')||'','');
    // Long, then thrown back toward the edge: cancels.
    h.touch(content,'touchstart',5,300,1000);h.touch(content,'touchmove',150,300,1100);h.touch(content,'touchmove',200,300,1200);
    h.touch(content,'touchmove',180,300,1260);h.touch(content,'touchmove',150,300,1290);h.touch(content,'touchend',150,300,1295);
    assert.equal(backs,0);await h.settleAll();
    // Short but fast: commits.
    h.touch(content,'touchstart',5,300,2000);h.touch(content,'touchmove',30,300,2010);h.touch(content,'touchmove',70,300,2040);h.touch(content,'touchend',70,300,2045);
    assert.equal(backs,1);
    // A swipe that starts away from the edge, or on a screen without Back, never navigates.
    h.go('#/bot/bot_nova');content=h.query('#app .content');
    h.touch(content,'touchstart',60,300,3000);h.touch(content,'touchmove',300,300,3020);h.touch(content,'touchend',300,300,3030);
    h.go('#/bots');content=h.query('#app .content');
    h.touch(content,'touchstart',5,300,4000);h.touch(content,'touchmove',300,300,4020);h.touch(content,'touchend',300,300,4030);
    assert.equal(backs,1);
  } finally {h.close();}
});

test('sheets drag from their body only at the top of its content and a downward flick dismisses',async()=>{
  const h=harness();
  try {
    h.query('#dialog-root').innerHTML='<dialog open><button class="sheet-grabber" type="button"></button><div class="modal-head"><h2 tabindex="-1">New bot</h2></div><div class="modal-body"><p class="modal-subtitle">Give it a name.</p><input id="bot-name"></div></dialog>';
    const dialog=h.query('dialog'),body=h.query('.modal-body'),text=h.query('.modal-subtitle'),input=h.query('#bot-name');let dismissals=0;
    h.mobile.mountDialog(dialog,()=>dismissals++);
    h.touch(input,'touchstart',100,100,0);h.touch(input,'touchmove',100,160,20);h.touch(input,'touchend',100,160,30);
    assert.equal(dialog.style.transform,'','a field keeps its own touches');
    Object.defineProperty(body,'scrollTop',{configurable:true,value:40});
    h.touch(text,'touchstart',100,100,100);h.touch(text,'touchmove',100,160,120);h.touch(text,'touchend',100,160,130);
    assert.equal(dialog.style.transform,'','scrolled content scrolls instead of dragging');
    Object.defineProperty(body,'scrollTop',{configurable:true,value:0});
    h.touch(text,'touchstart',100,100,200);h.touch(text,'touchmove',100,90,216);
    assert.equal(dialog.style.transform,'','an upward start belongs to the content');
    h.touch(text,'touchend',100,90,220);
    h.touch(text,'touchstart',100,100,300);h.touch(text,'touchmove',100,110,316);
    assert.equal(dialog.style.transform,'translateY(10px)');
    h.touch(text,'touchmove',100,160,340);h.touch(text,'touchend',100,160,348);
    assert.equal(dismissals,1);assert.equal(dialog.style.transform,'');assert.deepEqual(h.haptics(),['light']);
    // Dismissal continues from where the finger let go.
    assert.equal(h.mobile.closeSheet(dialog,()=>{}),true);
    assert.ok(h.animations.some(animation=>animation.frames[0].transform==='translateY(60px)'&&animation.frames[1].transform==='translateY(100%)'));
  } finally {h.close();}
});

test('the grabber rubber-bands above the top instead of lifting the sheet freely',()=>{
  const h=harness();
  try {
    h.query('#dialog-root').innerHTML='<dialog open><button class="sheet-grabber" type="button"></button><h2 tabindex="-1">Sheet</h2></dialog>';
    const dialog=h.query('dialog'),handle=h.query('.sheet-grabber');handle.setPointerCapture=()=>{};
    h.mobile.mountDialog(dialog,()=>{});
    const pointer=(type,y,time)=>{const event=new h.window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{button:0,pointerId:1,clientY:y});Object.defineProperty(event,'timeStamp',{value:time});handle.dispatchEvent(event);};
    pointer('pointerdown',300,0);pointer('pointermove',100,200);
    const lifted=Number(/translateY\((-?[\d.]+)px\)/.exec(dialog.style.transform)[1]);
    assert.ok(lifted<0&&lifted>-60,`resisted lift ${lifted}`);
    pointer('pointerup',100,400);assert.equal(dialog.style.transform,'');
  } finally {h.close();}
});

test('re-tapping the current tab scrolls its root to the top and leaves nested screens to app.js',()=>{
  const h=harness();
  try {
    h.go('#/bots');h.setScroll(420);h.scrolls.length=0;
    h.query('#app .tab.active').click();
    assert.deepEqual(JSON.parse(JSON.stringify(h.scrolls)),[{top:0,behavior:'smooth'}]);
    h.go('#/bots/bot_nova');h.setScroll(420);h.scrolls.length=0;
    h.query('#app .tab.active').click();
    assert.deepEqual(h.scrolls,[],'app.js pops a nested screen to the tab root through the tab’s own route');
  } finally {h.close();}
});

test('the navigation bar reports when content is under it and how far the large title has gone',async()=>{
  const h=harness();
  try {
    h.go('#/bots');const bar=h.query('#app .topbar');
    h.setScroll(22);h.window.document.dispatchEvent(new h.window.Event('scroll'));await wait(60);
    assert.equal(bar.dataset.scrolled,'true');assert.equal(bar.style.getPropertyValue('--studio-scroll-progress'),'0.500');
    h.setScroll(0);h.window.document.dispatchEvent(new h.window.Event('scroll'));await wait(60);
    assert.equal(bar.dataset.scrolled,'false');assert.equal(bar.style.getPropertyValue('--studio-scroll-progress'),'0.000');
  } finally {h.close();}
});

test('long-press offers the bot’s existing actions, swallows the opening touch and closes cleanly',async()=>{
  const h=harness();
  try {
    h.go('#/bots');const row=h.query('#app .bot-row'),main=h.query('#app .bot-row-main');
    h.touch(main,'touchstart',100,200,0);h.touch(main,'touchmove',130,200,50);await wait(560);
    assert.equal(h.query('.context-menu-layer'),null,'a moving finger is a scroll, not a long-press');
    h.touch(main,'touchend',130,200,600);
    h.touch(main,'touchstart',100,200,1000);await wait(560);
    const menu=h.query('.context-menu-layer [role=menu]');
    assert.deepEqual([...menu.querySelectorAll('.menu-item')].map(item=>[item.textContent,item.dataset.nav||`${item.dataset.action}:${item.dataset.id}`]),
      [['Chat','/bot/bot_nova'],['Bot profile','/bots/bot_nova'],['Memory','bot-memory:bot_nova'],['Files','bot-files:bot_nova'],['Edit bot','edit-bot:bot_nova']]);
    assert.ok(row.classList.contains('context-menu-source'));assert.deepEqual(h.haptics(),['medium']);
    assert.equal(h.touch(main,'touchend',100,200,1600).defaultPrevented,true,'the opening touch does not also open the chat');
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await h.settleAll();
    assert.equal(h.query('.context-menu-layer'),null);assert.ok(!row.classList.contains('context-menu-source'));
    // The New bot row has no menu.
    h.touch(h.query('.bot-row-new .bot-row-main'),'touchstart',100,300,2000);await wait(560);assert.equal(h.query('.context-menu-layer'),null);
  } finally {h.close();}
});

test('messages rise in once, replacements do not, and the message menu copies its text',async()=>{
  const h=harness();
  try {
    h.go('#/bots');h.go('#/bot/bot_nova');await h.settleAll();h.animations.length=0;
    const thread=h.query('#app .chat-thread'),make=html=>{const box=h.window.document.createElement('div');box.innerHTML=html;return box.firstElementChild;};
    const first=make('<article class="chat-message user" data-message-key="a"><div class="message-text">Hello</div></article>');
    const reply=make('<article class="chat-message" data-message-key="b"><div class="message-content"><div class="message-text">Hi! How can I help?</div></div></article>');
    thread.replaceChildren(first,reply);await tick();
    assert.equal(h.animations.length,0,'the transcript loading is not an arrival');
    const sent=make('<article class="chat-message user" data-message-key="c"><div class="message-text">Plan my week</div></article>');
    thread.replaceChildren(first,reply,sent);await tick();
    assert.deepEqual(h.animations.map(animation=>[animation.element,animation.frames[0].opacity]),[[sent,0]]);
    const partial=()=>make('<article class="chat-message partial-message"><div class="message-text">Here is</div></article>');
    h.animations.length=0;thread.replaceChildren(first,reply,sent,partial());await tick();assert.equal(h.animations.length,1,'the streaming reply appears once');
    h.animations.length=0;thread.replaceChildren(first,reply,sent,partial());await tick();assert.equal(h.animations.length,0,'a streaming update is not an arrival');
    const done=make('<article class="chat-message" data-message-key="d"><div class="message-text">Here is the plan.</div></article>');
    thread.replaceChildren(first,reply,sent,done);await tick();assert.equal(h.animations.length,0,'the finished reply replaces the stream in place');
    assert.ok(h.query('.chat-composer-wrap .scroll-to-latest[aria-hidden="true"]'),'the jump-to-latest control waits hidden');

    h.touch(reply.querySelector('.message-text'),'touchstart',60,200,0);await wait(560);
    const items=[...h.window.document.querySelectorAll('.context-menu .menu-item')];
    assert.deepEqual(items.map(item=>item.textContent),['Copy','Select text']);
    items[0].dispatchEvent(new h.window.MouseEvent('click',{bubbles:true,cancelable:true}));await tick();
    assert.deepEqual(h.copied,['Hi! How can I help?']);
    assert.ok(h.haptics().every(style=>HAPTICS.includes(style)));
  } finally {h.close();}
});

const vars=h=>{const style=h.window.document.documentElement.style;return [h.window.document.documentElement.dataset.keyboard,style.getPropertyValue('--studio-viewport-height'),style.getPropertyValue('--studio-viewport-top')];};
const resize=async(h,values)=>{Object.assign(h.viewport,values);h.viewport.dispatchEvent(new h.window.Event('resize'));await wait(40);};

test('the keyboard is detected while a field is focused and released when it hides, even with a stale WebKit scale',async()=>{
  const h=harness();
  try {
    h.go('#/bots');h.go('#/bot/bot_nova');await wait(40);
    assert.deepEqual(vars(h),['closed','',''],'at rest CSS sizes the chat (100dvh)');
    const field=h.query('#message-input');field.focus();
    // WKWebView shrinks innerHeight together with the visual viewport.
    h.window.innerHeight=471;await resize(h,{height:471});
    assert.deepEqual(vars(h),['open','471px','0px']);
    // Pressing Send keeps focus until its receipt; confirmation dismisses the keyboard.
    const press=new h.window.Event('mousedown',{bubbles:true,cancelable:true});h.query('#message-form .send').dispatchEvent(press);
    assert.equal(press.defaultPrevented,true);
    // Focus leaves while WebKit still reports a 2.17 scale and the keyboard-height viewport.
    h.mobile.sent(field.closest('form'),field.value);await resize(h,{scale:2.17,height:471});
    assert.deepEqual(vars(h),['closed','',''],'nothing is left half-height');
    // Real pinch zoom (narrower visual viewport) still leaves the page geometry alone.
    h.window.innerHeight=844;await resize(h,{scale:1,height:844});field.focus();await resize(h,{height:471});
    assert.deepEqual(vars(h),['open','471px','0px']);
    await resize(h,{scale:2,width:180,height:230});
    assert.deepEqual(vars(h),['open','471px','0px']);
  } finally {h.close();}
});

test('a sheet with unsaved input is never swiped or tapped away; its own buttons still close it',async()=>{
  const h=harness();
  try {
    h.query('#dialog-root').innerHTML='<dialog open><button class="sheet-grabber" type="button"></button><div class="modal-head"><h2 tabindex="-1">New bot</h2></div><div class="modal-body"><p class="modal-subtitle">Give it a name.</p><input id="bot-name"></div></dialog>';
    const dialog=h.query('dialog'),text=h.query('.modal-subtitle'),input=h.query('#bot-name'),handle=h.query('.sheet-grabber');let dismissals=0,outside=0;
    handle.setPointerCapture=()=>{};
    h.mobile.mountDialog(dialog,()=>dismissals++);
    dialog.addEventListener('click',event=>{if(event.target===dialog)outside++;});
    input.value='Nova';input.dispatchEvent(new h.window.Event('input',{bubbles:true}));
    // A long body drag only rubber-bands.
    h.touch(text,'touchstart',100,100,0);h.touch(text,'touchmove',100,110,16);h.touch(text,'touchmove',100,276,300);
    const resisted=Number(/translateY\((-?[\d.]+)px\)/.exec(dialog.style.transform)[1]);
    assert.ok(resisted>0&&resisted<70,`resisted ${resisted}`);
    h.touch(text,'touchend',100,276,600);
    // A short flick does not dismiss either.
    h.touch(text,'touchstart',100,100,1000);h.touch(text,'touchmove',100,112,1016);h.touch(text,'touchmove',100,136,1048);h.touch(text,'touchend',100,136,1050);
    // Nor does the grabber, however far it is pulled.
    const pointer=(type,y,time)=>{const event=new h.window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{button:0,pointerId:1,clientY:y});Object.defineProperty(event,'timeStamp',{value:time});handle.dispatchEvent(event);};
    pointer('pointerdown',100,2000);pointer('pointermove',400,2300);pointer('pointerup',400,2600);
    // Nor a tap on the dimmed screen outside the sheet.
    dialog.dispatchEvent(new h.window.MouseEvent('click',{bubbles:true,cancelable:true,clientX:20,clientY:20}));
    assert.equal(dismissals,0);assert.equal(outside,0,'app.js never sees the outside tap');
    assert.equal(dialog.style.transform,'');assert.equal(input.value,'Nova');
    assert.deepEqual(h.haptics(),['warning','warning','warning','warning'],'each refusal is felt; nothing reports a dismissal');
  } finally {h.close();}
});

test('menu actions run through the real controls, links get Copy link, and focus and inert are managed',async()=>{
  const h=harness();
  try {
    h.go('#/bots');h.go('#/bot/bot_nova');await h.settleAll();
    const thread=h.query('#app .chat-thread');
    thread.innerHTML='<article class="chat-message" data-message-key="m"><div class="message-content"><div class="message-text">See <a href="#/bots/bot_nova">Nova’s profile</a> or <a href="https://example.com/">the web</a>.</div><div class="message-voice-actions"><button type="button" data-action="read-message">Read aloud</button></div></div></article>';
    await tick();
    let reads=0;h.window.document.addEventListener('click',event=>{if(event.target.closest('[data-action="read-message"]'))reads++;});
    const message=h.query('#app .chat-message'),inApp=message.querySelector('a[href^="#"]'),web=message.querySelector('a[href^="https"]');
    // A web link keeps the system's own long-press menu.
    h.touch(web,'touchstart',60,200,0);await wait(560);assert.equal(h.query('.context-menu-layer'),null);h.touch(web,'touchend',60,200,600);
    // An in-app link gets Copy link first.
    h.touch(inApp,'touchstart',60,200,1000);await wait(560);
    const items=()=>[...h.window.document.querySelectorAll('.context-menu .menu-item')];
    assert.deepEqual(items().map(item=>item.textContent),['Copy link','Copy','Select text','Read aloud']);
    assert.equal(h.window.document.activeElement,items()[0],'focus starts on the first item');
    assert.ok(h.query('#app').hasAttribute('inert'),'the screen underneath is inert');
    const key=name=>h.query('.context-menu').dispatchEvent(new h.window.KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true}));
    key('ArrowDown');assert.equal(h.window.document.activeElement,items()[1]);
    key('End');assert.equal(h.window.document.activeElement,items()[3]);
    key('ArrowDown');assert.equal(h.window.document.activeElement,items()[0]);
    key('ArrowUp');assert.equal(h.window.document.activeElement,items()[3]);
    key('Home');assert.equal(h.window.document.activeElement,items()[0]);
    items()[0].dispatchEvent(new h.window.MouseEvent('click',{bubbles:true,cancelable:true}));await h.settleAll();
    assert.deepEqual(h.copied,['https://studio.test/#/bots/bot_nova']);
    assert.ok(!h.query('#app').hasAttribute('inert'));assert.equal(h.window.document.activeElement,message,'focus returns to the message');
    // Read aloud picked right away reaches the message's own control (app.js's handler).
    h.touch(message.querySelector('.message-text'),'touchstart',60,200,2000);await wait(560);
    items().find(item=>item.textContent==='Read aloud').dispatchEvent(new h.window.MouseEvent('click',{bubbles:true,cancelable:true}));
    assert.equal(reads,1);await h.settleAll();
    // A secondary click opens the same menu, and Escape closes it.
    message.querySelector('.message-text').dispatchEvent(new h.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
    assert.ok(h.query('.context-menu-layer'));
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await h.settleAll();
    assert.equal(h.query('.context-menu-layer'),null);assert.ok(!h.query('#app').hasAttribute('inert'));
  } finally {h.close();}
});

test('a chat copy keeps only messages near the screen and carries no ids',async()=>{
  const h=harness();
  try {
    h.go('#/bots');h.go('#/bot/bot_nova');await h.settleAll();
    const thread=h.query('#app .chat-thread');
    thread.innerHTML=Array.from({length:60},(_,index)=>`<article class="chat-message" data-message-key="k${index}"><div class="message-text">Message ${index}</div></article>`).join('');
    const rect=(top,height)=>({top,bottom:top+height,height,left:0,right:390,width:390,x:0,y:top,toJSON(){}});
    thread.getBoundingClientRect=()=>rect(60,700);
    [...thread.children].forEach((node,index)=>{node.getBoundingClientRect=()=>rect(index*100-5200,90);});
    h.animations.length=0;h.go('#/bots');
    const copy=h.query('.motion-layer .chat-thread');
    const kept=[...copy.querySelectorAll('.chat-message')].map(node=>node.textContent);
    assert.ok(kept.length>0&&kept.length<20,`${kept.length} messages copied`);assert.equal(kept.at(-1),'Message 59');
    assert.equal(copy.firstElementChild.style.height,`${Number(kept[0].split(' ')[1])*100}px`,'a spacer keeps the scroll position');
    assert.equal(h.query('.motion-layer [id]'),null);assert.equal(h.window.document.querySelectorAll('#chat-thread').length,0);
    assert.ok(h.query('.motion-layer [data-motion-id="main-content"]'));
  } finally {h.close();}
});
