import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {JSDOM} from 'jsdom';

const mobileSource=await readFile(new URL('../public/mobile.js',import.meta.url),'utf8');
const appSource=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const composerMarkup=(id='bot_one',room=false)=>`<button class="chat-back" type="button">Back</button><div class="chat-thread"></div><form class="chat-composer" id="${room?'room-message-form':'message-form'}" data-id="${id}"><textarea id="${room?'room-message-input':'message-input'}" name="text"></textarea><button class="send" type="submit">Send</button></form>`;

function harness({phone=true,reduced=false,app=false}={}) {
  const dom=new JSDOM('<div id="app"><main id="main-content"></main></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'https://studio.test/#/bot/bot_one'});
  const {window}=dom,frames=new Map();let frameId=0,scrollY=0;
  window.matchMedia=query=>({matches:query.includes('reduced-motion')?reduced:phone,addEventListener(){}});
  Object.defineProperty(window,'innerHeight',{value:852,writable:true});
  Object.defineProperty(window,'scrollY',{get:()=>scrollY});
  window.scrollTo=(position,y)=>{scrollY=typeof position==='object'?position.top:y;};
  window.requestAnimationFrame=callback=>{frames.set(++frameId,callback);return frameId;};
  window.cancelAnimationFrame=id=>frames.delete(id);
  const viewport=Object.assign(new window.EventTarget(),{height:852,offsetTop:0,scale:1});
  Object.defineProperty(window,'visualViewport',{value:viewport});
  const context=vm.createContext({window,document:window.document,location:window.location,URL,crypto:webcrypto,
    HTMLFormElement:window.HTMLFormElement,FormData:window.FormData,
    getComputedStyle:window.getComputedStyle.bind(window),setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(mobileSource,context,{filename:'mobile.js'});
  if(app){vm.runInContext(appSource,context,{filename:'app.js'});vm.runInContext("auth={authenticated:true,csrf:'fixture-session'};",context);}
  const query=selector=>window.document.querySelector(selector),mobile=window.StudioMobile;
  function render(id='bot_one',room=false) {
    mobile.beforeRender();query('#main-content').innerHTML=composerMarkup(id,room);
    mobile.afterRender({view:room?'room':'bot',id});return query('textarea');
  }
  function event(target,type,values={}) {
    const value=new window.Event(type,{bubbles:true,cancelable:true});
    Object.assign(value,values);target.dispatchEvent(value);return value;
  }
  return {window,viewport,mobile,query,render,event,run:code=>vm.runInContext(code,context),context,
    flushFrames(){const pending=[...frames.values()];frames.clear();for(const callback of pending)callback();},close(){dom.window.close();}};
}

test('phone Return stays a newline; explicit keyboard shortcuts send in bot and room chats',()=>{
  const h=harness({app:true});
  try {
    for(const room of [false,true]) {
      const field=h.render(room?'room_one':'bot_one',room),form=field.closest('form');let submitted=0;
      form.requestSubmit=()=>submitted++;
      const press=options=>{const event=new h.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options});field.dispatchEvent(event);return event;};
      assert.equal(press({}).defaultPrevented,false);assert.equal(submitted,0);
      assert.equal(press({metaKey:true}).defaultPrevented,true);
      assert.equal(press({ctrlKey:true}).defaultPrevented,true);assert.equal(submitted,2);
      assert.equal(press({shiftKey:true}).defaultPrevented,false);
      assert.equal(press({isComposing:true}).defaultPrevented,false);assert.equal(submitted,2);
      form.querySelector('.send').disabled=true;press({metaKey:true});assert.equal(submitted,2);
    }
  } finally {h.close();}
});

test('desktop Enter continues to send while Shift+Enter and composition remain untouched',()=>{
  const h=harness({phone:false,app:true});
  try {
    const field=h.render(),form=field.closest('form');let submitted=0;form.requestSubmit=()=>submitted++;
    for(const options of [{},{shiftKey:true},{isComposing:true}])field.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options}));
    assert.equal(submitted,1);
  } finally {h.close();}
});

test('unsent text survives redraw and switching chats without leaking between bots and rooms',()=>{
  const h=harness();
  try {
    let field=h.render();field.value='Draft for the first bot';h.event(field,'input');
    field=h.render();assert.equal(field.value,'Draft for the first bot');
    field=h.render('bot_two');assert.equal(field.value,'');field.value='Second bot only';h.event(field,'input');
    field=h.render('bot_one',true);assert.equal(field.value,'');field.value='Room with a matching id';h.event(field,'input');
    assert.equal(h.render('bot_one').value,'Draft for the first bot');
    assert.equal(h.render('bot_two').value,'Second bot only');
    assert.equal(h.render('bot_one',true).value,'Room with a matching id');
  } finally {h.close();}
});

test('accepted messages and session reset do not resurrect old drafts',()=>{
  const h=harness();
  try {
    let field=h.render();field.value='Accepted draft';h.event(field,'input');
    field.value='';h.mobile.sent(field.closest('form'));
    assert.equal(h.render().value,'');
    field=h.render('bot_two');field.value='Private unsent draft';h.event(field,'input');
    h.mobile.reset();h.query('#main-content').innerHTML='';
    assert.equal(h.render('bot_two').value,'');
  } finally {h.close();}
});

test('a failed submission retains its draft; accepting an old chat submission leaves the new composer alone',async()=>{
  const h=harness({app:true}),requests=[];let accept,reject;
  try {
    h.context.fixtureApi=(path,options)=>{requests.push({path,options});return new Promise((resolve,fail)=>{accept=resolve;reject=fail;});};
    h.run("api=fixtureApi;sendMessage=(id,body)=>fixtureApi(`/api/bots/${id}/messages`,{method:'POST',body});loadChat=async()=>{};loadRoomChat=async()=>{};renderThread=()=>{};renderRoomThread=()=>{};refreshComposerAttachments=()=>{};");
    let field=h.render();field.value='Please keep this if the engine refuses';h.event(field,'input');
    h.event(field.closest('form'),'submit');reject(new Error('Fixture unavailable'));await tick();
    assert.equal(h.render().value,'Please keep this if the engine refuses');
    field=h.query('textarea');h.event(field.closest('form'),'submit');
    const next=h.render('bot_two');next.value='A different bot’s new draft';h.event(next,'input');
    accept({accepted:true});await tick();
    assert.equal(next.value,'A different bot’s new draft');assert.equal(h.render().value,'');
    assert.equal(h.render('bot_two').value,'A different bot’s new draft');
    assert.deepEqual(requests.map(request=>request.path),['/api/bots/bot_one/messages','/api/bots/bot_one/messages']);
  } finally {h.close();}
});

test('acceptance preserves text typed during the request in bot and room composers',async()=>{
  for(const room of [false,true]) {
    const h=harness({app:true});let accept;
    try {
      h.context.fixtureApi=()=>new Promise(resolve=>{accept=resolve;});
      h.run("api=fixtureApi;sendMessage=(id,body)=>fixtureApi(`/api/bots/${id}/messages`,{method:'POST',body});loadChat=async()=>{};loadRoomChat=async()=>{};renderThread=()=>{};renderRoomThread=()=>{};refreshComposerAttachments=()=>{};");
      const id=room?'room_one':'bot_one',field=h.render(id,room);
      field.value='First message';h.event(field,'input');h.event(field.closest('form'),'submit');
      field.value='A follow-up typed while waiting';h.event(field,'input');
      accept({accepted:true});await tick();
      assert.equal(field.value,'A follow-up typed while waiting');
      assert.equal(h.render(id,room).value,'A follow-up typed while waiting');
    } finally {h.close();}
  }
});

test('acceptance after leaving and revisiting clears only the accepted text and preserves a newer draft',async()=>{
  for(const changedDraft of [false,true]) {
    const h=harness({app:true});let accept;
    try {
      h.context.fixtureApi=()=>new Promise(resolve=>{accept=resolve;});
      h.run("api=fixtureApi;sendMessage=(id,body)=>fixtureApi(`/api/bots/${id}/messages`,{method:'POST',body});loadChat=async()=>{};renderThread=()=>{};refreshComposerAttachments=()=>{};");
      let field=h.render();field.value='Submitted message';h.event(field,'input');
      h.event(field.closest('form'),'submit');h.render('bot_two');
      field=h.render();assert.equal(field.value,'Submitted message');
      if(changedDraft){field.value='New draft after returning';h.event(field,'input');}
      accept({accepted:true});await tick();
      const expected=changedDraft?'New draft after returning':'';
      assert.equal(field.value,expected);assert.equal(h.render().value,expected);
    } finally {h.close();}
  }
});

test('a late acceptance from before sign-out cannot restore a cleared private draft',async()=>{
  const h=harness({app:true});let accept;
  try {
    h.context.fixtureApi=()=>new Promise(resolve=>{accept=resolve;});
    h.run("api=fixtureApi;sendMessage=(id,body)=>fixtureApi(`/api/bots/${id}/messages`,{method:'POST',body});loadChat=async()=>{};renderThread=()=>{};refreshComposerAttachments=()=>{};");
    const field=h.render();field.value='Submitted before sign-out';h.event(field,'input');
    h.event(field.closest('form'),'submit');
    field.value='Private follow-up from the old session';h.event(field,'input');
    // renderAuth resets mobile state and then removes the authenticated shell.
    h.run('auth={authenticated:false};renderAuth()');
    accept({accepted:true});await tick();
    h.query('#app').innerHTML='<main id="main-content"></main>';
    assert.equal(h.render().value,'');
  } finally {h.close();}
});

test('menus support keyboard traversal, skip disabled actions and restore the trigger on Escape',()=>{
  const h=harness({app:true});
  try {
    h.query('#main-content').innerHTML='<button id="menu-trigger">Options</button>';
    const anchor=h.query('#menu-trigger');anchor.focus();
    h.run("openMenu(document.querySelector('#menu-trigger'),'<button class=\"menu-item\" role=\"menuitem\">First</button><button class=\"menu-item\" role=\"menuitem\" disabled>Unavailable</button><button class=\"menu-item\" role=\"menuitem\">Last</button>',{label:'Options'})");
    const menu=h.query('[role=menu]'),items=[...menu.querySelectorAll('button')];
    const press=key=>menu.dispatchEvent(new h.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
    assert.equal(h.window.document.activeElement,items[0]);assert.equal(anchor.getAttribute('aria-expanded'),'true');
    press('ArrowDown');assert.equal(h.window.document.activeElement,items[2]);
    press('ArrowDown');assert.equal(h.window.document.activeElement,items[0]);
    press('ArrowUp');assert.equal(h.window.document.activeElement,items[2]);
    press('Home');assert.equal(h.window.document.activeElement,items[0]);
    press('End');assert.equal(h.window.document.activeElement,items[2]);
    press('Escape');assert.equal(h.query('[role=menu]'),null);assert.equal(h.window.document.activeElement,anchor);
    assert.equal(anchor.getAttribute('aria-expanded'),'false');
  } finally {h.close();}
});

test('a menu near the bottom is positioned within the keyboard viewport',()=>{
  const h=harness({app:true});
  try {
    h.query('#main-content').innerHTML='<button id="menu-trigger">Options</button>';
    h.query('#menu-trigger').getBoundingClientRect=()=>({left:330,right:374,bottom:600,width:44});
    Object.defineProperty(h.window.HTMLElement.prototype,'offsetWidth',{get(){return this.matches('.popover-menu')?270:0;}});
    Object.defineProperty(h.window.HTMLElement.prototype,'offsetHeight',{get(){return this.matches('.popover-menu')?300:0;}});
    Object.assign(h.viewport,{height:340,width:393,offsetTop:24,offsetLeft:0});
    h.run("openMenu(document.querySelector('#menu-trigger'),'<button class=\"menu-item\" role=\"menuitem\">First</button>',{label:'Options'})");
    const menu=h.query('[role=menu]'),top=parseFloat(menu.style.top),left=parseFloat(menu.style.left);
    assert.ok(top>=h.viewport.offsetTop);assert.ok(top+menu.offsetHeight<=h.viewport.offsetTop+h.viewport.height);
    assert.ok(left>=h.viewport.offsetLeft);assert.ok(left+menu.offsetWidth<=h.viewport.offsetLeft+h.viewport.width);
  } finally {h.close();}
});

test('cancelled, short and vertical edge swipes cannot navigate; a deliberate completed swipe follows Back',()=>{
  const h=harness();
  try {
    h.render();const root=h.query('#main-content'),back=h.query('.chat-back');let navigations=0;
    back.addEventListener('click',()=>navigations++);
    // A short, slow drag is not a flick. Keep event timing independent of host scheduling.
    let gestureTime=0;
    const touch=(type,x,y)=>{gestureTime+=200;const event=new h.window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'timeStamp',{value:gestureTime});Object.assign(event,{touches:type==='touchend'||type==='touchcancel'?[]:[{clientX:x,clientY:y}]});root.dispatchEvent(event);};
    touch('touchstart',5,100);touch('touchmove',130,105);touch('touchcancel');touch('touchend');
    touch('touchstart',5,100);touch('touchmove',40,105);touch('touchend');
    touch('touchstart',5,100);touch('touchmove',140,170);touch('touchend');
    assert.equal(navigations,0);assert.equal(root.style.transform,'');
    touch('touchstart',5,100);touch('touchmove',130,105);touch('touchend');
    assert.equal(navigations,1);assert.equal(root.style.transform,'');
  } finally {h.close();}
});

test('sheet dragging cancels cleanly and only a completed downward drag dismisses',()=>{
  const h=harness();
  try {
    h.query('#dialog-root').innerHTML='<dialog open><button class="sheet-grabber" type="button"></button><h2 tabindex="-1">Options</h2><input></dialog>';
    const dialog=h.query('dialog'),handle=h.query('.sheet-grabber');let dismissals=0;
    handle.setPointerCapture=()=>{};h.mobile.mountDialog(dialog,()=>dismissals++);
    assert.equal(h.window.document.activeElement,h.query('h2'));
    let gestureTime=0;
    const pointer=(type,y,elapsed=200)=>{gestureTime+=elapsed;const event=new h.window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'timeStamp',{value:gestureTime});Object.assign(event,{button:0,pointerId:1,clientY:y});handle.dispatchEvent(event);};
    pointer('pointerdown',100);pointer('pointermove',210);pointer('pointercancel',210);pointer('pointerup',210);
    pointer('pointerdown',100);pointer('pointermove',135);pointer('pointerup',135);
    assert.equal(dismissals,0);assert.equal(dialog.style.transform,'');
    pointer('pointerdown',100);pointer('pointermove',210);pointer('pointerup',210);
    assert.equal(dismissals,1);assert.equal(dialog.style.transform,'');
    pointer('pointerdown',100);pointer('pointermove',135,20);pointer('pointerup',135,10);
    assert.equal(dismissals,2,'a short completed flick remains a valid dismissal');
  } finally {h.close();}
});

test('reduced motion closes sheets synchronously and animated closure cannot dismiss a replacement',async()=>{
  const reduced=harness({reduced:true});
  try {
    const dialog=reduced.window.document.createElement('dialog');dialog.animate=()=>{throw new Error('Motion must be skipped');};
    let closed=0;if(!reduced.mobile.closeSheet(dialog,()=>closed++))closed++;
    assert.equal(closed,1);
  } finally {reduced.close();}
  const h=harness();
  try {
    const dialog=h.window.document.createElement('dialog');dialog.open=true;h.query('#dialog-root').append(dialog);
    let finish;dialog.animate=()=>({finished:new Promise(resolve=>{finish=resolve;}),cancel(){}});
    let closed=0;assert.equal(h.mobile.closeSheet(dialog,()=>closed++),true);
    dialog.remove();h.query('#dialog-root').innerHTML='<dialog open>Replacement</dialog>';
    finish();await tick();assert.equal(closed,0);assert.equal(h.query('dialog').open,true);
  } finally {h.close();}
});

test('keyboard viewport changes resize the composer while browser zoom keeps its own geometry',()=>{
  const h=harness();
  try {
    const field=h.render();Object.defineProperty(field,'scrollHeight',{get:()=>400});h.mobile.sizeComposer(field);
    const fullHeight=parseFloat(field.style.height);
    // Only a focused field raises the keyboard.
    field.focus();h.viewport.height=340;h.viewport.offsetTop=24;h.viewport.dispatchEvent(new h.window.Event('resize'));h.flushFrames();
    assert.equal(h.window.document.documentElement.dataset.keyboard,'open');
    assert.equal(h.window.document.documentElement.style.getPropertyValue('--studio-viewport-height'),'340px');
    assert.equal(h.window.document.documentElement.style.getPropertyValue('--studio-viewport-top'),'24px');
    assert.ok(parseFloat(field.style.height)<fullHeight);assert.equal(field.style.overflowY,'auto');
    // Pinch zoom both scales and narrows the visual viewport.
    h.viewport.scale=2;h.viewport.width=196;h.viewport.height=190;h.viewport.dispatchEvent(new h.window.Event('resize'));h.flushFrames();
    assert.equal(h.window.document.documentElement.style.getPropertyValue('--studio-viewport-height'),'340px');
    h.viewport.scale=1;h.viewport.height=852;h.viewport.offsetTop=0;h.viewport.dispatchEvent(new h.window.Event('resize'));h.flushFrames();
    assert.equal(h.window.document.documentElement.dataset.keyboard,'closed');assert.equal(parseFloat(field.style.height),fullHeight);
  } finally {h.close();}
});

test('resizing to desktop releases the phone composer height without changing its draft',()=>{
  const h=harness();
  try {
    const field=h.render();field.value='Keep this draft across resizing';h.event(field,'input');
    assert.notEqual(field.style.height,'');
    const phoneMedia=h.window.matchMedia;
    h.window.matchMedia=()=>({matches:false,addEventListener(){}});
    h.window.dispatchEvent(new h.window.Event('resize'));h.flushFrames();
    assert.equal(field.style.height,'');assert.equal(field.style.overflowY,'');
    assert.equal(field.value,'Keep this draft across resizing');
    h.window.matchMedia=phoneMedia;h.window.dispatchEvent(new h.window.Event('resize'));h.flushFrames();
    assert.notEqual(field.style.height,'');assert.equal(field.value,'Keep this draft across resizing');
  } finally {h.close();}
});
