import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source=await readFile(new URL('../public/browser-control.js',import.meta.url),'utf8');
const appSource=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const identity={runId:'run_browser',remoteRunId:'remote_browser',request_id:'handoff_browser',execution_generation:4};
const jpeg='/9j/4AAQSkZJRgABAQ';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const plain=value=>JSON.parse(JSON.stringify(value));
const ready=(extra={})=>({streamId:'stream_1',width:1280,height:800,dpr:1,tabId:'tab_1',nav:1,url:'https://accounts.example.test/sign-in?x=1',title:'Sign in',tabs:[{id:'tab_1',title:'Sign in',url:'https://accounts.example.test/sign-in',active:true}],retained:false,idleMs:0,...extra});
const sse=(name,data)=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

// A fake stream body the test feeds chunk by chunk.
function fakeStream() {
  const chunks=[],waiters=[];let closed=false,cancelled=false;
  const reader={read(){if(chunks.length)return Promise.resolve({value:new TextEncoder().encode(chunks.shift()),done:false});if(closed)return Promise.resolve({done:true});return new Promise(resolve=>waiters.push(resolve));}};
  const deliver=()=>{while(waiters.length&&(chunks.length||closed)){const resolve=waiters.shift();if(chunks.length)resolve({value:new TextEncoder().encode(chunks.shift()),done:false});else resolve({done:true});}};
  return {response:{ok:true,status:200,body:{getReader:()=>reader,cancel(){cancelled=true;}}},push(text){chunks.push(text);deliver();},close(){closed=true;deliver();},get cancelled(){return cancelled;}};
}

function fixture(t,{input,resume,stream}={}) {
  const dom=new JSDOM('<!doctype html><body><div id="dialog-root"></div></body>',{url:'https://tupies.test',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom,requests=[],streams=[],messages=[];let valid=true;
  window.TextDecoder=TextDecoder;window.TextEncoder=TextEncoder;
  window.eval(source);
  const timing=window.StudioBrowser.timing;Object.assign(timing,{watchdog:5000,backoff:[5,10,20],input:200,resume:200,resize:5,hover:5,drag:5,drain:100,notice:10000,decode:5});
  const context={
    api:async(path,options)=>{
      requests.push({path,options});
      if(path.endsWith('/stream')){if(stream)return stream(options);const fake=fakeStream();streams.push(Object.assign(fake,{options}));options.signal?.addEventListener('abort',()=>fake.close());return fake.response;}
      if(path.endsWith('/input'))return input?input(options):{ok:true,seq:options.body.seq,dropped:0};
      if(path.endsWith('/resume'))return resume?resume(options):{ok:true};
      throw new Error('unexpected '+path);
    },
    async loadChat(id){messages.push(['load',id]);},toast(message){messages.push(['toast',message]);},valid:()=>valid,botName:'QA bot',reason:'Sign in to the example account',
  };
  const $=selector=>window.document.querySelector(selector);
  const inputs=()=>requests.filter(item=>item.path.endsWith('/input'));
  const events=()=>inputs().flatMap(item=>plain(item.options.body.events));
  const open=async()=>{window.StudioBrowser.open(context,'bot_browser',identity);await tick();};
  // Opens the stream, sends ready plus one frame, and waits until the frame is displayed.
  const live=async(extra={})=>{await open();const fake=streams.at(-1);fake.push(sse('ready',ready(extra)));fake.push(sse('frame',{seq:1,tabId:'tab_1',nav:1,width:1280,height:800,jpeg}));await tick();await tick();return fake;};
  const surface=()=>{const node=$('[data-browser-surface]');node.getBoundingClientRect=()=>({left:10,top:20,width:640,height:400,right:650,bottom:420});return node;};
  const pointer=(type,x,y,init={})=>{const event=new window.MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:type==='pointerdown'?1:0,...init});Object.defineProperty(event,'pointerId',{value:init.pointerId??1});Object.defineProperty(event,'pointerType',{value:init.pointerType??'mouse'});surface().dispatchEvent(event);return event;};
  const key=(target,type,init)=>{const event=new window.KeyboardEvent(type,{bubbles:true,cancelable:true,...init});target.dispatchEvent(event);return event;};
  t.after(()=>{window.StudioBrowser.reset();window.close();});
  return {window,requests,streams,messages,$,open,live,surface,pointer,key,inputs,events,context,timing,invalidate(){valid=false;}};
}

test('browser handoff card escapes website-supplied reason and carries exact run identity',t=>{
  const h=fixture(t),run={id:identity.runId,remoteRunId:identity.remoteRunId,status:'waiting_for_input',execution_generation:4,pending_controls:[{kind:'browser',prompt_id:identity.request_id,reason:'Sign in <img src=x onerror=alert(1)>'}]};
  h.$('#dialog-root').innerHTML=h.window.StudioBrowser.renderCard({id:'bot_browser',name:'QA <bot>'},run);
  assert.equal(h.$('img'),null);assert.match(h.$('.browser-handoff-card').textContent,/QA <bot>/);
  assert.deepEqual(JSON.parse(h.$('[data-action=browser-handoff]').dataset.browserIdentity),identity);
  assert.equal(h.$('[data-action=browser-handoff]').dataset.browserReason,'Sign in <img src=x onerror=alert(1)>');
  assert.deepEqual(JSON.parse(h.$('[data-action=stop-run]').dataset.run),{runId:identity.runId,remoteRunId:identity.remoteRunId});
});

test('opening posts the exact identity and viewport, parses events split across chunks and shows the site prominently',async t=>{
  const h=fixture(t);await h.open();
  const request=h.requests[0];
  assert.equal(request.path,'/api/bots/bot_browser/browser/stream');assert.equal(request.options.responseType,'stream');assert.equal(request.options.method,'POST');
  assert.deepEqual(plain(request.options.body),{...identity,viewport:{width:1280,height:800,dpr:1,touch:false}});
  assert.equal(h.$('.browser-control-panel').dataset.phase,'connecting');
  assert.equal(h.$('[data-browser-reason]').textContent,'Sign in to the example account');
  const text=sse('ready',ready())+': ping\n\n'+sse('frame',{seq:1,tabId:'tab_1',nav:1,width:1280,height:800,jpeg});
  const fake=h.streams[0];for(let index=0;index<text.length;index+=7)fake.push(text.slice(index,index+7));
  await tick();await tick();
  assert.equal(h.$('.browser-control-panel').dataset.phase,'live');
  assert.equal(h.$('[data-browser-connection-text]').textContent,'Live');
  assert.equal(h.$('[data-browser-host]').textContent,'accounts.example.test');
  assert.equal(h.$('[data-browser-path]').textContent,'/sign-in?x=1');
  assert.equal(h.$('.browser-control-frame.is-front').getAttribute('src'),`data:image/jpeg;base64,${jpeg}`);
  assert.equal(h.$('[data-browser-overlay]').hidden,true);
  // Resume, Skip, Close and the keyboard control are never disabled.
  for(const selector of ['[data-browser-resume=resume]','[data-browser-resume=skip]','[data-browser-close]','[data-browser-keyboard]'])assert.equal(h.$(selector).disabled,false);
});

test('a newer frame replaces one still waiting to be shown, and old frames never return',async t=>{
  const h=fixture(t);const fake=await h.live();
  fake.push(sse('frame',{seq:3,tabId:'tab_1',nav:1,width:1280,height:800,jpeg:'AAAA'})+sse('frame',{seq:2,tabId:'tab_1',nav:1,width:1280,height:800,jpeg:'BBBB'})+sse('frame',{seq:4,tabId:'tab_1',nav:1,width:1280,height:800,jpeg:'CCCC'}));
  await tick();await tick();await tick();
  assert.equal(h.$('.browser-control-frame.is-front').getAttribute('src'),'data:image/jpeg;base64,CCCC');
  assert.equal(h.window.document.querySelectorAll('.browser-control-frame').length,2,'two reused images');
});

test('mouse input maps to remote CSS pixels with the displayed frame identity, in one in-flight request at a time',async t=>{
  let release;const pending=[];
  const h=fixture(t,{input:options=>new Promise(resolve=>{pending.push(()=>resolve({ok:true,seq:options.body.seq,dropped:0}));release=()=>pending.shift()?.();})});
  await h.live();
  h.pointer('pointerdown',330,220);// centre of a 640×400 box showing 1280×800
  assert.equal(h.inputs().length,1);
  h.pointer('pointerup',330,220);
  h.pointer('pointerdown',330,220);h.pointer('pointerup',330,220);
  assert.equal(h.inputs().length,1,'later events wait for the in-flight request');
  const first=plain(h.inputs()[0].options.body);
  assert.deepEqual({...first,events:undefined},{...identity,streamId:'stream_1',seq:1,events:undefined});
  assert.deepEqual(first.events,[{t:'pointer',kind:'down',x:640,y:400,button:0,buttons:1,clickCount:1,modifiers:0,tabId:'tab_1',nav:1,dt:0}]);
  release();await tick();await tick();
  assert.equal(h.inputs().length,2);
  const second=h.inputs()[1].options.body;assert.equal(second.seq,2);
  assert.deepEqual(plain(second.events).map(event=>[event.kind,event.clickCount]),[['up',1],['down',2],['up',2]]);
  assert.ok(plain(second.events).every(event=>typeof event.dt==='number'));
  release();await tick();
});

test('hover moves are coalesced, wheel deltas accumulate and right-click stays with the page',async t=>{
  const h=fixture(t);await h.live();
  for(let x=20;x<120;x+=10)h.pointer('pointermove',x,40,{buttons:0});
  const wheel=new h.window.WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:100,clientY:100,deltaY:40});h.surface().dispatchEvent(wheel);
  h.surface().dispatchEvent(new h.window.WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:100,clientY:100,deltaY:60}));
  assert.equal(wheel.defaultPrevented,true);
  const menu=new h.window.MouseEvent('contextmenu',{bubbles:true,cancelable:true});h.surface().dispatchEvent(menu);assert.equal(menu.defaultPrevented,true);
  await wait(30);await tick();
  const sent=h.events();
  assert.equal(sent.filter(event=>event.t==='pointer'&&event.kind==='move').length,1);
  assert.deepEqual(sent.find(event=>event.t==='pointer').x,(110-10)*2);
  assert.equal(sent.find(event=>event.t==='wheel').dy,100);
});

test('touch becomes touch events with active points and no local tap or scroll logic',async t=>{
  const h=fixture(t);await h.live();
  const down=h.pointer('pointerdown',100,100,{pointerType:'touch',pointerId:5});
  assert.equal(down.defaultPrevented,true);
  h.pointer('pointermove',100,80,{pointerType:'touch',pointerId:5});h.pointer('pointermove',100,60,{pointerType:'touch',pointerId:5});
  h.pointer('pointerup',100,60,{pointerType:'touch',pointerId:5});
  await wait(20);await tick();
  const touches=h.events().filter(event=>event.t==='touch');
  assert.deepEqual(touches.map(event=>event.kind),['start','move','end']);
  assert.deepEqual(touches[0].points,[{id:5,x:180,y:160}]);assert.equal(touches[0].tabId,'tab_1');assert.equal(touches[0].nav,1);
  assert.deepEqual(touches[1].points,[{id:5,x:180,y:80}]);
  assert.deepEqual(touches[2].points,[]);
  assert.equal(h.events().some(event=>event.t==='pointer'),false);
});

test('direct typing sends keys, leaves browser shortcuts alone, pastes as text and keeps nothing typed',async t=>{
  const h=fixture(t);await h.live();
  const sink=h.$('[data-browser-sink]');h.pointer('pointerdown',100,100);h.pointer('pointerup',100,100);
  assert.equal(h.window.document.activeElement,sink,'clicking the page sends keystrokes to it');
  const typed=h.key(sink,'keydown',{key:'s',code:'KeyS'});h.key(sink,'keyup',{key:'s',code:'KeyS'});
  assert.equal(typed.defaultPrevented,true);
  const tab=h.key(sink,'keydown',{key:'Tab',code:'Tab',shiftKey:true});assert.equal(tab.defaultPrevented,true,'Tab stays with the page');
  const reload=h.key(sink,'keydown',{key:'r',code:'KeyR',metaKey:true});assert.equal(reload.defaultPrevented,false,'browser reload is left alone');
  const pasteKey=h.key(sink,'keydown',{key:'v',code:'KeyV',metaKey:true});assert.equal(pasteKey.defaultPrevented,false,'paste shortcut produces a paste event');
  const paste=new h.window.Event('paste',{bubbles:true,cancelable:true});paste.clipboardData={getData:type=>type==='text/plain'?'pasted-fixture-secret':''};sink.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented,true);
  const composition=new h.window.CompositionEvent('compositionend',{bubbles:true,data:'日本'});sink.dispatchEvent(new h.window.CompositionEvent('compositionstart',{bubbles:true}));sink.dispatchEvent(composition);
  await wait(20);await tick();await tick();
  const sent=h.events().filter(event=>event.t==='key'||event.t==='text');
  assert.deepEqual(sent.map(event=>event.t==='key'?`${event.kind}:${event.key}:${event.modifiers}`:`text:${event.text}`),['down:s:0','up:s:0','down:Tab:8','text:pasted-fixture-secret','text:日本']);
  assert.equal(sink.value,'');
  assert.ok(!h.window.document.body.innerHTML.includes('pasted-fixture-secret'));
  assert.equal(h.window.localStorage.length,0);assert.equal(h.window.sessionStorage.length,0);
});

test('Escape goes to the page once and releases the keyboard on a quick second press; held keys are released on blur',async t=>{
  const h=fixture(t);await h.live();
  const sink=h.$('[data-browser-sink]');sink.focus();
  h.key(sink,'keydown',{key:'Shift',code:'ShiftLeft',shiftKey:true});
  h.key(sink,'keydown',{key:'Escape',code:'Escape'});h.key(sink,'keyup',{key:'Escape',code:'Escape'});
  const second=h.key(sink,'keydown',{key:'Escape',code:'Escape'});
  assert.equal(second.defaultPrevented,true);
  assert.notEqual(h.window.document.activeElement,sink);
  assert.match(h.$('[data-browser-notice]').textContent,/Keyboard released/);
  await wait(20);await tick();await tick();
  assert.deepEqual(h.events().filter(event=>event.t==='key').map(event=>`${event.kind}:${event.key}`),['down:Shift','down:Escape','up:Escape','up:Shift']);
});

test('the phone field forwards insertions, Backspace and Enter immediately, masks passwords and never retains text',async t=>{
  const h=fixture(t);await h.live();
  const fake=h.streams[0];fake.push(sse('state',{tabId:'tab_1',nav:1,url:'https://accounts.example.test/',title:'Sign in',tabs:ready().tabs,loading:false,canGoBack:true,canGoForward:false,focus:{editable:true,kind:'password'}}));await tick();
  const type=h.$('[data-browser-type]');
  assert.equal(type.type,'password');assert.equal(type.getAttribute('autocomplete'),'one-time-code');
  h.$('[data-browser-keyboard]').click();// on desktop this focuses the page keyboard
  const insert=(inputType,data)=>{const event=new h.window.InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType,data});type.dispatchEvent(event);return event;};
  type.value='x';assert.equal(insert('insertText','x').defaultPrevented,true);assert.equal(type.value,'');
  insert('insertText','y');insert('deleteContentBackward',null);insert('insertParagraph',null);
  type.value='123456';type.dispatchEvent(new h.window.InputEvent('input',{bubbles:true,inputType:'insertReplacementText'}));// autofilled one-time code
  assert.equal(type.value,'');
  fake.push(sse('state',{focus:{editable:true,kind:'otp'}}));await tick();
  assert.equal(type.type,'text');assert.equal(type.getAttribute('inputmode'),'numeric');
  await wait(20);await tick();await tick();
  assert.deepEqual(h.events().filter(event=>event.t==='key'||event.t==='text').map(event=>event.t==='text'?`text:${event.text}`:`${event.kind}:${event.key}`),['text:x','text:y','down:Backspace','up:Backspace','down:Enter','up:Enter','text:123456']);
  // Hiding the page does not wipe the field's state or require retyping; the stream pauses.
  Object.defineProperty(h.window.document,'hidden',{configurable:true,get:()=>true});h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));
  assert.equal(h.$('.browser-control-panel').dataset.phase,'paused');
  assert.ok(!h.window.document.body.innerHTML.includes('123456'));
});

test('a stalled stream is reconnected by the watchdog with the same identity, and visibility returns reconnect',async t=>{
  const h=fixture(t);h.timing.watchdog=80;await h.live();
  assert.equal(h.streams.length,1);
  // Only the first stream stalls: the reconnected one is opened with a long watchdog, so a loaded host cannot stall it again mid-test.
  const api=h.context.api;h.context.api=async(...args)=>{if(args[0].endsWith('/stream'))h.timing.watchdog=60_000;return api(...args);};
  for(const started=Date.now();h.streams.length<2 && Date.now()-started<10_000;)await wait(10);
  await tick();
  assert.equal(h.streams.length,2,'watchdog reconnected once');
  assert.deepEqual(plain(h.streams[1].options.body).request_id,identity.request_id);
  assert.equal(h.$('[data-browser-resume=resume]').disabled,false);
  h.streams[1].push(sse('ready',ready({streamId:'stream_2'})));await tick();
  assert.equal(h.$('.browser-control-panel').dataset.phase,'live');
  Object.defineProperty(h.window.document,'hidden',{configurable:true,get:()=>true});h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));
  const count=h.streams.length;assert.equal(h.$('.browser-control-panel').dataset.phase,'paused');
  Object.defineProperty(h.window.document,'hidden',{configurable:true,get:()=>false});h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));await tick();
  assert.equal(h.streams.length,count+1);
});

test('end:error and a dropped connection reconnect automatically; a refused open shows one Try again button',async t=>{
  const g=fixture(t);await g.live();
  g.streams[0].push(sse('end',{reason:'error',message:'capture failed'}));await wait(20);await tick();
  assert.equal(g.streams.length,2);
  g.streams[1].close();await wait(30);await tick();
  assert.equal(g.streams.length,3);
  const r=fixture(t,{stream:async()=>{throw Object.assign(new Error('This help request is no longer waiting.'),{status:409});}});
  await r.open();await tick();
  assert.equal(r.$('[data-browser-overlay]').hidden,false);
  assert.match(r.$('[data-browser-overlay]').textContent,/no longer waiting/);
  assert.ok(r.$('[data-browser-retry]'));assert.equal(r.$('[data-browser-resume=skip]').disabled,false);
});

test('input 409 reopens the stream once and never resends the events; a second conflict ends as replaced',async t=>{
  const h=fixture(t,{input:async()=>{throw Object.assign(new Error('lease changed'),{status:409});}});await h.live();
  h.pointer('pointerdown',100,100);await tick();await tick();
  assert.equal(h.streams.length,2);assert.match(h.$('[data-browser-notice]').textContent,/Reconnecting/);
  h.streams[1].push(sse('ready',ready({streamId:'stream_2'})));await tick();
  assert.equal(h.inputs().length,1,'the conflicting press is not resent');
  h.key(h.$('[data-browser-sink]'),'keydown',{key:'a',code:'KeyA'});await tick();await tick();
  assert.equal(h.inputs().length,2);assert.equal(h.inputs()[1].options.body.streamId,'stream_2');
  assert.equal(h.$('.browser-control-panel').dataset.phase,'replaced');
  assert.ok(h.$('[data-browser-take]'));
});

test('replaced offers Take control here; resumed shows a clear closed state without resume controls',async t=>{
  const h=fixture(t);const fake=await h.live();
  fake.push(sse('end',{reason:'replaced',message:'Opened elsewhere'}));await tick();
  assert.equal(h.$('.browser-control-panel').dataset.phase,'replaced');assert.match(h.$('[data-browser-overlay]').textContent,/open somewhere else/);
  assert.equal(h.$('.browser-control-panel').hasAttribute('data-closed'),false,'Resume and Skip stay available');
  await wait(50);assert.equal(h.streams.length,1,'no automatic reconnect after replaced');
  h.$('[data-browser-take]').click();await tick();
  assert.equal(h.streams.length,2);
  h.streams[1].push(sse('ready',ready({streamId:'stream_2'}))+sse('end',{reason:'resumed'}));await tick();await tick();
  assert.equal(h.$('.browser-control-panel').dataset.phase,'ended');assert.ok(h.$('.browser-control-panel').hasAttribute('data-closed'));
  assert.match(h.$('[data-browser-overlay]').textContent,/has the browser again/);
  assert.deepEqual(h.messages.at(-1),['load','bot_browser']);
  await wait(50);assert.equal(h.streams.length,2);
  h.$('[data-browser-overlay] [data-browser-close]').click();assert.equal(h.$('.browser-control-dialog'),null);
});

test('website dialogs render as text and send their response once',async t=>{
  const h=fixture(t);const fake=await h.live();
  fake.push(sse('dialog',{open:true,type:'prompt',message:'Enter <strong>verification</strong>',defaultPrompt:''}));await tick();
  assert.equal(h.$('[data-browser-site-dialog]').hidden,false);
  assert.equal(h.$('[data-browser-site-message]').textContent,'Enter <strong>verification</strong>');assert.equal(h.$('[data-browser-site-message] strong'),null);
  h.$('[data-browser-site-prompt]').value='fixture-code';
  h.$('[data-browser-dialog-accept=true]').click();await tick();
  assert.equal(h.$('[data-browser-site-prompt]').value,'');assert.equal(h.$('[data-browser-site-dialog]').hidden,true);
  assert.deepEqual(h.events().at(-1),{t:'dialog',accept:true,promptText:'fixture-code'});
});

test('toolbar sends history, tab switches and navigation; bare hosts get https and the engine decides the rest',async t=>{
  const h=fixture(t);const fake=await h.live();
  fake.push(sse('state',{tabId:'tab_2',nav:2,url:'http://popup.example.test/',title:'Popup',tabs:[...ready().tabs,{id:'tab_2',title:'<img src=x>',url:'http://popup.example.test/',active:true}],loading:true,canGoBack:true,canGoForward:false,focus:null}));await tick();
  assert.equal(h.$('[data-browser-tabs]').hidden,false);assert.equal(h.window.document.querySelectorAll('.browser-control-tab').length,2);
  assert.equal(h.$('.browser-control-tab[aria-current=page] span').textContent,'<img src=x>');
  assert.match(h.$('[data-browser-notice]').textContent,/another tab: popup.example.test/);
  assert.equal(h.$('[data-browser-progress]').hidden,false);assert.ok(h.$('[data-browser-security]').classList.contains('is-insecure'));
  assert.equal(h.$('[data-browser-history=back]').disabled,false);assert.equal(h.$('[data-browser-history=forward]').disabled,true);
  h.$('[data-browser-history=back]').click();h.$('.browser-control-tab[data-browser-tab="0"]').click();
  h.$('[data-browser-site]').click();const address=h.$('[data-browser-address]');assert.equal(address.hidden,false);
  address.value='example.org/login';h.$('[data-browser-address-form]').dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));
  h.$('[data-browser-site]').click();address.value='http://localhost:8080/fixture';h.$('[data-browser-address-form]').dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));
  await wait(20);await tick();await tick();
  assert.deepEqual(h.events().filter(event=>['history','tab','navigate'].includes(event.t)),[{t:'history',action:'back'},{t:'tab',tabId:'tab_1'},{t:'navigate',url:'https://example.org/login'},{t:'navigate',url:'http://localhost:8080/fixture'}]);
});

test('a resize of the surface sends one debounced resize event',async t=>{
  const h=fixture(t);await h.live();
  const node=h.$('[data-browser-surface]');Object.defineProperty(node,'clientWidth',{configurable:true,get:()=>390});Object.defineProperty(node,'clientHeight',{configurable:true,get:()=>600});
  h.window.dispatchEvent(new h.window.Event('resize'));h.window.dispatchEvent(new h.window.Event('resize'));
  await wait(30);await tick();
  assert.deepEqual(h.events().filter(event=>event.t==='resize'),[{t:'resize',width:390,height:600,dpr:1,touch:false}]);
});

test('Resume and Skip stay enabled while input is pending, send the exact identity once and close the panel',async t=>{
  let release,held=false;
  const h=fixture(t,{input:options=>{if(held)return {ok:true,seq:options.body.seq,dropped:0};held=true;return new Promise(resolve=>{release=()=>resolve({ok:true,seq:options.body.seq,dropped:0});});}});await h.live();
  h.pointer('pointerdown',100,100);
  assert.equal(h.$('[data-browser-resume=resume]').disabled,false);assert.equal(h.$('[data-browser-resume=skip]').disabled,false);
  assert.equal(h.$('[data-browser-retain]').checked,false);h.$('[data-browser-retain]').checked=true;
  h.$('[data-browser-resume=resume]').click();h.$('[data-browser-resume=resume]').click();
  await tick();release();await wait(80);await tick();await tick();
  const resumes=h.requests.filter(item=>item.path.endsWith('/resume'));
  assert.equal(resumes.length,1);assert.deepEqual(plain(resumes[0].options.body),{...identity,keepSession:true});
  assert.ok(h.requests.indexOf(resumes[0])>h.requests.indexOf(h.inputs()[0]),'queued input reaches the page first');
  assert.equal(h.$('.browser-control-dialog'),null);assert.deepEqual(h.messages.slice(-2),[['load','bot_browser'],['toast','Control returned to your bot.']]);
});

test('a failed or slow resume keeps the panel usable with a clear message',async t=>{
  const h=fixture(t,{resume:options=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))))});await h.live();
  h.$('[data-browser-resume=skip]').click();await wait(400);await tick();
  assert.match(h.$('[data-browser-notice]').textContent,/didn’t answer in time/);
  assert.equal(h.$('[data-browser-resume=skip]').disabled,false);
  assert.deepEqual(plain(h.requests.find(item=>item.path.endsWith('/resume')).options.body),{...identity,keepSession:false,skip:true});
});

test('uncertain input is reported, not replayed, and later input still flows',async t=>{
  let calls=0;const h=fixture(t,{input:async options=>{calls++;if(calls===1)throw new Error('Synthetic network loss with private URL');return {ok:true,seq:options.body.seq,dropped:1};}});await h.live();
  h.key(h.$('[data-browser-sink]'),'keydown',{key:'Enter',code:'Enter'});await tick();await tick();
  assert.match(h.$('[data-browser-notice]').textContent,/may not have reached the page/);assert.ok(!h.$('[data-browser-notice]').textContent.includes('private URL'));
  h.key(h.$('[data-browser-sink]'),'keydown',{key:'a',code:'KeyA'});await tick();await tick();
  assert.equal(h.inputs().length,2);assert.equal(h.inputs()[1].options.body.events[0].key,'a');
  assert.match(h.$('[data-browser-notice]').textContent,/page changed/);
});

test('closing aborts the stream and pending input; a late frame cannot display; reopening reconnects cleanly',async t=>{
  const h=fixture(t,{input:()=>new Promise(()=>{})});const fake=await h.live();
  h.pointer('pointerdown',100,100);
  const streamSignal=h.streams[0].options.signal,inputSignal=h.inputs()[0].options.signal;
  h.$('[data-browser-close]').click();
  assert.equal(streamSignal.aborted,true);assert.equal(inputSignal.aborted,true);assert.equal(h.$('.browser-control-dialog'),null);
  fake.push(sse('frame',{seq:9,tabId:'tab_1',nav:1,width:1280,height:800,jpeg:'LATE'}));await tick();
  assert.equal(h.window.document.querySelector('img'),null);
  await h.open();assert.equal(h.streams.length,2);assert.equal(h.window.document.querySelectorAll('.browser-control-dialog').length,1);
  h.invalidate();h.streams[1].push(sse('ready',ready())+sse('frame',{seq:1,tabId:'tab_1',nav:1,width:1280,height:800,jpeg:'NOPE'}));await tick();await tick();
  assert.equal(h.$('.browser-control-frame.is-front')?.hasAttribute('src')??false,false);
});

test('only positive evidence that the exact handoff ended closes the panel',async t=>{
  const h=fixture(t);await h.live();
  h.window.StudioBrowser.observeRun('bot_browser',null);
  h.window.StudioBrowser.observeRun('other_bot',{id:'x',status:'completed',pending_controls:[]});
  assert.ok(h.$('.browser-control-dialog'));
  h.window.StudioBrowser.observeRun('bot_browser',{id:identity.runId,remoteRunId:identity.remoteRunId,status:'waiting_for_input',execution_generation:4,pending_controls:[{kind:'browser',prompt_id:identity.request_id}]});
  assert.ok(h.$('.browser-control-dialog'));
  h.window.StudioBrowser.observeRun('bot_browser',{id:identity.runId,status:'cancelled',pending_controls:[]});
  assert.equal(h.$('.browser-control-dialog'),null);
});

test('the app keeps the browser window open across ordinary dialogs and navigation but streams through the shared API helper',()=>{
  const openDialog=appSource.slice(appSource.indexOf('function openDialog('),appSource.indexOf('function closeDialog('));
  const closeDialog=appSource.slice(appSource.indexOf('function closeDialog('),appSource.indexOf('let conversationSearchRequest'));
  assert.ok(!openDialog.includes('StudioBrowser'));assert.ok(!closeDialog.includes('StudioBrowser'));
  // Only the ordinary dialog root is closed; without that root (an embedded or test page) nothing is closed and nothing throws.
  assert.match(closeDialog,/root=\$\('#dialog-root'\),dialog=root&&\$\('dialog',root\)/);
  const hashchange=appSource.slice(appSource.indexOf("window.addEventListener('hashchange'"));
  assert.ok(!hashchange.slice(0,200).includes('StudioBrowser'));
  assert.match(appSource,/options\.responseType==='stream'\)return value/);
  assert.match(appSource,/function renderAuth\(\)\{[\s\S]{0,200}StudioBrowser\?\.reset\(\)/,'sign-out still closes it');
  // The window outlives navigation, so its end-of-handoff refresh must not load a chat that is not on screen.
  assert.match(appSource,/refreshAfterHandoff=botId=>\{const current=route\(\);if\(current\.view==='bot'&&current\.id===botId\)return loadChat\(botId\);/);
});

test('a website message already open when the window connects is shown without the connecting cover',async t=>{
  const h=fixture(t);await h.open();const fake=h.streams.at(-1);
  fake.push(sse('ready',ready()));fake.push(sse('dialog',{open:true,type:'alert',message:'Session expired',defaultPrompt:''}));await tick();await tick();
  assert.equal(h.$('[data-browser-site-dialog]').hidden,false);assert.equal(h.$('[data-browser-overlay]').hidden,true,'no "Connecting" text under a live website message');
  h.$('[data-browser-dialog-accept=true]').click();await tick();
  assert.deepEqual(h.events().at(-1),{t:'dialog',accept:true});assert.equal(h.$('[data-browser-overlay]').hidden,false,'until the first picture arrives');
  fake.push(sse('frame',{seq:1,tabId:'tab_1',nav:1,width:1280,height:800,jpeg}));await tick();await tick();await wait(10);
  assert.equal(h.$('[data-browser-overlay]').hidden,true);
});

test('AltGr characters are sent without Ctrl and Alt, so layouts that need it can type @ and €',async t=>{
  const h=fixture(t);await h.live();
  const sink=h.$('[data-browser-sink]');h.pointer('pointerdown',100,100);h.pointer('pointerup',100,100);
  const altGraph=init=>{const event=new h.window.KeyboardEvent('keydown',{bubbles:true,cancelable:true,ctrlKey:true,altKey:true,...init});event.getModifierState=name=>name==='AltGraph';sink.dispatchEvent(event);return event;};
  assert.equal(altGraph({key:'@',code:'KeyQ'}).defaultPrevented,true);
  const plainCtrl=h.key(sink,'keydown',{key:'a',code:'KeyA',ctrlKey:true});assert.equal(plainCtrl.defaultPrevented,true);
  await wait(20);await tick();await tick();
  assert.deepEqual(h.events().filter(event=>event.t==='key').map(event=>`${event.key}:${event.modifiers}`),['@:0','a:2']);
});

test('a stream that ends because the sign-in ended shows a final signed-out state and does not reconnect',async t=>{
  const h=fixture(t);const fake=await h.live();
  fake.push(sse('end',{reason:'signedout',message:'Sign in again to continue.'}));await tick();await wait(40);
  assert.match(h.$('[data-browser-overlay-title]').textContent,/signed out/);assert.equal(h.streams.length,1,'no reconnect');
});
