import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserSession, findBrowser } from '../lib/browser.mjs';
import { OwnerControl, StreamSink, checkEvents, virtualKey } from '../lib/browser-stream.mjs';
import { createStudioServer } from '../server.mjs';

const executable=await findBrowser();
const chrome={skip:executable?false:'Chrome or Chromium is unavailable.'};
const resolver=async()=>[{address:'127.0.0.1',family:4}];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label,limit=8000){const started=Date.now();while(Date.now()-started<limit){const value=await check();if(value)return value;await delay(20);}throw new Error(`Timed out waiting for ${label}.`);}

const PAGES={
  churn:`<title>Churn</title><meta name=viewport content="width=device-width"><style>.a{color:red}.b{color:blue}</style><p id=tick>0</p><p id=log></p><button id=go style="position:absolute;left:20px;top:120px;width:160px;height:50px" onclick="log.textContent='clicked'">Go</button><input id=field style="position:absolute;left:20px;top:200px;width:220px;height:30px"><script>let n=0;setInterval(()=>{tick.textContent=String(++n);document.body.classList.toggle('a');document.body.classList.toggle('b');for(const el of document.querySelectorAll('p'))el.dataset.n=n;},250);</script>`,
  password:`<title>Sign in</title><form onsubmit="event.preventDefault();document.title='submitted'"><input id=user style="position:absolute;left:20px;top:40px;width:220px;height:30px"><input id=pw type=password style="position:absolute;left:20px;top:100px;width:220px;height:30px"></form><script>for(const t of ['keydown','keyup','keypress'])pw.addEventListener(t,()=>{pw.dataset[t]=Number(pw.dataset[t] || 0)+1;});</script>`,
  crossslider:'',
  slider:`<title>Slider</title><div id=track style="position:absolute;left:40px;top:100px;width:300px;height:40px;background:#ddd"><div id=handle style="position:absolute;left:0;top:0;width:40px;height:40px;background:#333"></div></div><p id=state style="position:absolute;top:200px">locked</p><script>let start=null,moves=[];handle.addEventListener('mousedown',e=>{start={x:e.clientX,t:performance.now()};moves=[];});addEventListener('mousemove',e=>{if(!start)return;moves.push(performance.now());handle.style.left=Math.max(0,Math.min(260,e.clientX-start.x))+'px';});addEventListener('mouseup',e=>{if(!start)return;const span=moves.length?moves.at(-1)-start.t:0;state.textContent=(parseFloat(handle.style.left)>=250 && moves.length>=10 && span>=300)?'verified':'rejected '+moves.length+' '+Math.round(span);start=null;});</script>`,
  popup:`<title>Opener</title><button id=open style="position:absolute;left:20px;top:40px;width:160px;height:50px" onclick="window.open('/child','oauth','width=500,height=600')">Sign in with provider</button><p id=back></p><script>addEventListener('message',e=>{back.textContent=e.data;});</script>`,
  child:`<title>Provider</title><button id=done style="position:absolute;left:20px;top:40px;width:160px;height:50px" onclick="opener.postMessage('approved','*');window.close()">Approve</button>`,
  dialogs:`<title>Dialogs</title><button id=alert style="position:absolute;left:20px;top:40px;width:160px;height:50px" onclick="alert('Session expired');document.title='after alert'">Alert</button><button id=confirm style="position:absolute;left:20px;top:120px;width:160px;height:50px" onclick="document.title='confirm '+confirm('Continue?')">Confirm</button><script>setInterval(()=>{document.body.dataset.t=Date.now();},200);</script>`,
  busy:`<title>Busy</title><input id=f style="position:absolute;left:10px;top:10px;width:200px;height:30px" autofocus><script>f.addEventListener('beforeinput',()=>{const s=Date.now();while(Date.now()-s<700){}});</script>`,
  tabalert:`<title>A</title><button id=b style="position:absolute;left:0;top:0;width:200px;height:100px" onclick="alert('hello');document.title='after'">x</button>`,
  downalert:`<title>Down</title><div id=box style="position:absolute;left:0;top:0;width:300px;height:200px" onmousedown="if(!window.done){window.done=1;alert('from mousedown');}"></div><script>addEventListener('mousemove',e=>{document.body.dataset.buttons=e.buttons;});addEventListener('mouseup',()=>{document.body.dataset.up=Number(document.body.dataset.up||0)+1;});</script>`,
  long:`<title>Long</title><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0;height:6000px;background:linear-gradient(#fff,#08f)"><p style="font-size:30px">Top</p></body>`,
};
async function pageServer(t) {
  const server=http.createServer((request,response)=>{
    response.setHeader('content-type','text/html; charset=utf-8');
    const name=request.url.slice(1).split('?')[0];
    if(name==='cross')return response.end(`<title>Cross</title><iframe src="http://localhost:${server.address().port}/frame" style="position:absolute;left:0;top:0;width:500px;height:300px;border:0"></iframe>`);
    if(name==='crossslider')return response.end(`<title>Cross slider</title><iframe src="http://localhost:${server.address().port}/slider" style="position:absolute;left:0;top:0;width:500px;height:300px;border:0"></iframe>`);
    if(name==='slow'){const timer=setTimeout(()=>response.end('<title>Slow</title><p>finally</p>'),8000);timer.unref();return;}
    if(name==='frame')return response.end('<title>Frame</title><button id=b style="position:absolute;left:30px;top:30px;width:160px;height:50px" onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<p>Frame clicked</p>\')">Frame action</button><input type=hidden name=token value=0><script>setInterval(()=>{document.querySelector(\'[name=token]\').value=Date.now();document.body.dataset.v=Date.now();},100);</script>');
    response.end(PAGES[name] || '<title>Blank</title>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}
/** A response stand-in that records the SSE events a stream writes. */
export function sseRecorder() {
  const res=new EventEmitter();let buffer='';Object.assign(res,{events:[],bytes:0,writableEnded:false,destroyed:false});
  res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};res.flushHeaders=()=>{};
  res.write=chunk=>{res.bytes+=chunk.length;buffer+=chunk;for(let end=buffer.indexOf('\n\n');end>=0;end=buffer.indexOf('\n\n')){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);if(block.startsWith(':'))continue;res.events.push({name:/^event: (.*)$/m.exec(block)[1],data:JSON.parse(/^data: (.*)$/m.exec(block)[1]),at:Date.now()});}return true;};
  res.end=()=>{res.writableEnded=true;res.emit('close');};
  res.find=(name,match=()=>true)=>res.events.find(event=>event.name===name && match(event.data))?.data;
  res.all=name=>res.events.filter(event=>event.name===name).map(event=>event.data);
  return res;
}
async function browser(t,base,page,viewport={width:390,height:700,dpr:1,touch:false},{before}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-stream-'));
  const session=await BrowserSession.start({executable,profileRoot:root,allowPrivate:true,resolver});
  t.after(async()=>{await session.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
  await session.navigate(`${base}/${page}`);await before?.(session);
  const control=new OwnerControl(session,{idleMs:60_000}),res=sseRecorder(),sink=new StreamSink(res,'stream_test');
  await control.attach(sink,viewport);const ready=await until(()=>res.find('ready'),'ready');
  if(!session.dialog)await until(()=>res.find('frame'),'first frame');
  const input=events=>control.input(checkEvents(events,{url:value=>new URL(value)}),{webUrl:value=>new URL(value)});
  const evaluate=(fn,args={})=>session.evaluate(fn,args);
  const at=async selector=>evaluate(function({selector}){const r=document.querySelector(selector).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};},{selector});
  const click=async(point,{tabId=session.tabId,nav=control.nav}={})=>input([{t:'pointer',kind:'move',x:point.x,y:point.y},{t:'pointer',kind:'down',x:point.x,y:point.y,button:0,buttons:1,clickCount:1,tabId,nav},{t:'pointer',kind:'up',x:point.x,y:point.y,button:0,buttons:0,clickCount:1,dt:30}]);
  const type=text=>input([...text].flatMap(key=>[{t:'key',kind:'down',key,code:/[a-z]/i.test(key)?`Key${key.toUpperCase()}`:/\d/.test(key)?`Digit${key}`:''},{t:'key',kind:'up',key,code:/[a-z]/i.test(key)?`Key${key.toUpperCase()}`:/\d/.test(key)?`Digit${key}`:''}]));
  return {session,control,res,sink,ready,input,evaluate,at,click,type};
}

test('frames keep arriving on a page with constant DOM churn and a click plus typed text land there',chrome,async t=>{
  const base=await pageServer(t),b=await browser(t,base,'churn');
  assert.equal(b.ready.width,390);assert.equal(b.ready.tabId,b.session.tabId);assert.equal(b.ready.streamId,'stream_test');
  const before=b.res.all('frame').length;await until(()=>b.res.all('frame').length-before>=3,'three frames during churn',15000);const frames=b.res.all('frame');
  assert.ok(frames.every((frame,index)=>index===0 || frame.seq>frames[index-1].seq));assert.equal(frames.at(-1).width,390);assert.ok(Buffer.from(frames.at(-1).jpeg,'base64').subarray(0,2).equals(Buffer.from([0xff,0xd8])));
  assert.equal((await b.click(await b.at('#go'))).dropped,0);
  await b.click(await b.at('#field'));await b.type('hello');
  await until(async()=>(await b.evaluate(function(){return log.textContent+'|'+field.value;}))==='clicked|hello','click and text');
  await until(()=>b.res.all('state').some(state=>state.focus?.kind==='text'),'text focus state');
});

test('typing a password with key events fires keydown/keyup, fills the field and registers it for redaction',chrome,async t=>{
  const base=await pageServer(t),b=await browser(t,base,'password');
  await b.click(await b.at('#pw'));
  await until(()=>b.res.all('state').some(state=>state.focus?.kind==='password'),'password focus');
  await b.type('s3cretpw');
  await b.input([{t:'key',kind:'down',key:'Backspace',code:'Backspace'},{t:'key',kind:'up',key:'Backspace',code:'Backspace'},{t:'key',kind:'down',key:'X',code:'KeyX',modifiers:8},{t:'key',kind:'up',key:'X',code:'KeyX',modifiers:8}]);
  const state=await b.evaluate(function(){return {value:pw.value,down:Number(pw.dataset.keydown),up:Number(pw.dataset.keyup)};});
  assert.equal(state.value,'s3cretpX');assert.ok(state.down>=10 && state.up>=10,`key events ${JSON.stringify(state)}`);
  assert.equal(b.session.ownerTouched,true);
  // Tab moves focus: the typed run and the field's actual value are registered before the next field gets text.
  await b.input([{t:'key',kind:'down',key:'Tab',code:'Tab',modifiers:8},{t:'key',kind:'up',key:'Tab',code:'Tab',modifiers:8}]);
  assert.equal(b.session.redact('page shows s3cretpX'),'page shows [private]');
  for(const event of b.res.events)assert.ok(!JSON.stringify(event.data).includes('s3cretp'),'typed text never appears in stream events');
  // Select-all then overwrite, with Meta (macOS panels) and Ctrl, works through explicit editing commands on any host.
  for(const modifiers of [4,2]) {
    await b.click(await b.at('#user'));await b.type('first');
    await b.input([{t:'key',kind:'down',key:'a',code:'KeyA',modifiers},{t:'key',kind:'up',key:'a',code:'KeyA',modifiers}]);await b.type('next');
    assert.equal(await b.evaluate(function(){return user.value;}),'next',`modifiers ${modifiers}`);
    await b.input([{t:'key',kind:'down',key:'Backspace',code:'Backspace',modifiers:modifiers===4?4:2},{t:'key',kind:'up',key:'Backspace',code:'Backspace'}]);
    assert.equal(await b.evaluate(function(){return user.value;}),'',`line/word delete with modifiers ${modifiers}`);
  }
  await b.control.close('resumed','done');assert.equal(b.res.find('end').reason,'resumed');
});

test('a click inside a cross-origin iframe lands while hidden verification bookkeeping churns',chrome,async t=>{
  const base=await pageServer(t),b=await browser(t,base,'cross',{width:800,height:600,dpr:1,touch:false});
  const frames=await b.session.frames(),child=frames.find(frame=>frame.parentId);assert.ok(child);
  const button=await b.session.evaluate(function(){const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},{},child.id);
  assert.equal((await b.click(button)).dropped,0);
  await until(async()=>/Frame clicked/.test(await b.session.evaluate(function(){return document.body.innerText;},{},child.id)),'frame click');
});

test('a slider inside a cross-origin iframe that needs over 300 ms of mouse moves completes from one batched pointer path',chrome,async t=>{
  const base=await pageServer(t),b=await browser(t,base,'crossslider',{width:600,height:500,dpr:1,touch:false});
  const child=(await b.session.frames()).find(frame=>frame.parentId);assert.ok(child);
  const inFrame=fn=>b.session.evaluate(fn,{},child.id);
  const handle=await inFrame(function(){const r=handle.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
  const events=[{t:'pointer',kind:'move',x:handle.x,y:handle.y},{t:'pointer',kind:'down',x:handle.x,y:handle.y,button:0,buttons:1,clickCount:1,tabId:b.session.tabId,nav:b.control.nav}];
  for(let step=1;step<=16;step++)events.push({t:'pointer',kind:'move',x:handle.x+step*18,y:handle.y+(step%3)-1,buttons:1,dt:25});
  events.push({t:'pointer',kind:'up',x:handle.x+288,y:handle.y,button:0,buttons:0,clickCount:1,dt:20});
  const started=Date.now(),result=await b.input(events);assert.equal(result.dropped,0);assert.ok(Date.now()-started>=400,'the batch keeps its real timing');
  assert.equal(await inFrame(function(){return state.textContent;}),'verified');
});

test('a popup opened by the page is followed, and the stream returns to the opener after it closes itself',chrome,async t=>{
  const base=await pageServer(t),b=await browser(t,base,'popup'),opener=b.session.tabId;
  await b.click(await b.at('#open'));
  const popup=await until(()=>b.session.tabId!==opener && b.session.tabId,'switch to popup');
  await until(()=>b.res.all('state').some(state=>state.tabId===popup && /\/child$/.test(state.url)),'popup state');
  await until(()=>b.res.all('frame').some(frame=>frame.tabId===popup),'popup frames');
  assert.equal(await b.evaluate(function(){return innerWidth;}),390,'the popup gets the owner viewport');
  await until(async()=>(await b.evaluate(function(){return document.readyState;}))==='complete','popup loaded');
  await b.click(await b.at('#done'));
  await until(()=>b.session.tabId===opener,'return to opener');
  await until(()=>b.res.all('state').some(state=>state.tabId===opener && state.tabs.length===1),'opener state');
  await until(async()=>(await b.evaluate(function(){return back.textContent;}))==='approved','opener received the result');
  const frames=b.res.all('frame').length;await b.click(await b.at('#open'));await until(()=>b.res.all('frame').length>frames,'stream still live');
});

test('alert and confirm arrive as dialog events, can be answered, and the stream stays alive',chrome,async t=>{
  const base=await pageServer(t),b=await browser(t,base,'dialogs');
  const started=Date.now(),result=await b.click(await b.at('#alert'));assert.ok(Date.now()-started<3000,'a dialog does not hang input');
  assert.ok(result.dropped<=1);
  const dialog=await until(()=>b.res.find('dialog',event=>event.open),'alert event');assert.equal(dialog.type,'alert');assert.equal(dialog.message,'Session expired');
  assert.equal((await b.click({x:5,y:5})).dropped,3,'input other than the dialog answer is dropped while a dialog is open');
  await b.input([{t:'dialog',accept:true}]);await until(()=>b.res.find('dialog',event=>!event.open),'dialog closed');
  await until(async()=>(await b.evaluate(function(){return document.title;}))==='after alert','alert handled');
  await b.click(await b.at('#confirm'));await until(()=>b.res.all('dialog').filter(event=>event.open).length===2,'confirm event');
  await b.input([{t:'dialog',accept:false}]);await until(async()=>(await b.evaluate(function(){return document.title;}))==='confirm false','confirm answered');
  const frames=b.res.all('frame').length;await until(()=>b.res.all('frame').length>frames,'frames after dialogs');
});

test('main-frame navigation changes nav, a stale press is dropped whole, and a second stream replaces the first',chrome,async t=>{
  const base=await pageServer(t),b=await browser(t,base,'churn'),oldNav=b.control.nav,button=await b.at('#go');
  await b.input([{t:'navigate',url:`${base}/churn?second`}]);
  await until(()=>b.res.all('state').some(state=>state.nav>oldNav && /second/.test(state.url)),'navigation state');
  await until(async()=>(await b.evaluate(function(){return location.search;}))==='?second','navigated');
  const result=await b.click(button,{nav:oldNav});assert.equal(result.dropped,2,'the press and its release are dropped');
  assert.equal(await b.evaluate(function(){return log.textContent;}),'');
  assert.equal((await b.click(button)).dropped,0);await until(async()=>(await b.evaluate(function(){return log.textContent;}))==='clicked','current press lands');
  await b.input([{t:'history',action:'back'}]);await until(async()=>(await b.evaluate(function(){return location.search;}))==='','back');
  const second=sseRecorder();await b.control.attach(new StreamSink(second,'stream_two'),{width:500,height:600,dpr:1,touch:false});
  assert.equal(b.res.find('end').reason,'replaced');await until(()=>second.find('frame'),'frames on the new stream');
  const count=b.res.all('frame').length;await delay(400);assert.equal(b.res.all('frame').length,count,'the replaced stream receives nothing more');
});

test('touch scrolls the page natively when touch is on, and the bot viewport is restored after the handoff',chrome,async t=>{
  const base=await pageServer(t),b=await browser(t,base,'long',{width:390,height:700,dpr:2,touch:true});
  assert.deepEqual(await b.evaluate(function(){return [innerWidth,devicePixelRatio,navigator.maxTouchPoints>0];}),[390,2,true]);
  const tabId=b.session.tabId,nav=b.control.nav,events=[{t:'touch',kind:'start',points:[{id:1,x:200,y:600}],tabId,nav}];
  for(let step=1;step<=10;step++)events.push({t:'touch',kind:'move',points:[{id:1,x:200,y:600-step*40}],dt:16});
  events.push({t:'touch',kind:'end',points:[],dt:16});
  assert.equal((await b.input(events)).dropped,0);
  await until(async()=>(await b.evaluate(function(){return scrollY;}))>200,'touch scroll');
  await b.input([{t:'wheel',x:100,y:100,dx:0,dy:400}]);
  // Two fingers: lifting one is "end" with the finger that remains, then "end" with none.
  const two=[{t:'touch',kind:'start',points:[{id:1,x:100,y:500}],tabId,nav},{t:'touch',kind:'start',points:[{id:1,x:100,y:500},{id:2,x:250,y:500}],tabId,nav,dt:10},{t:'touch',kind:'move',points:[{id:1,x:100,y:450},{id:2,x:250,y:450}],dt:16},{t:'touch',kind:'end',points:[{id:2,x:250,y:450}],dt:16},{t:'touch',kind:'move',points:[{id:2,x:250,y:400}],dt:16},{t:'touch',kind:'end',points:[],dt:16},{t:'touch',kind:'start',points:[{id:3,x:100,y:100}],tabId,nav},{t:'touch',kind:'cancel',points:[]}];
  assert.equal((await b.input(two)).dropped,0);
  const frames=b.res.all('frame').length;assert.equal((await b.input([{t:'resize',width:390,height:700,dpr:2,touch:true}])).dropped,0);
  await until(()=>b.res.all('frame').length>frames,'an unchanged resize still pushes a fresh frame');
  await b.input([{t:'resize',width:420,height:640,touch:true}]);assert.deepEqual(await b.evaluate(function(){return [innerWidth,innerHeight];}),[420,640]);
  await b.control.close('resumed','done');
  assert.deepEqual(await b.evaluate(function(){return [innerWidth,innerHeight,devicePixelRatio];}),[1280,900,1]);
});

test('a navigation to a slow page returns at once, the stream stays alive and reports loading',chrome,async t=>{
  const base=await pageServer(t),b=await browser(t,base,'churn'),button=await b.at('#go');
  const started=Date.now(),result=await b.input([{t:'navigate',url:`${base}/slow`}]);assert.equal(result.dropped,0);assert.ok(Date.now()-started<1000,`navigate returned after ${Date.now()-started} ms`);
  await until(()=>b.res.all('state').some(state=>state.loading),'loading state');
  const frames=b.res.all('frame').length;await until(()=>b.res.all('frame').length>frames,'frames of the old page during the pending navigation',4000);
  const clicked=Date.now();await b.click(button);assert.ok(Date.now()-clicked<1500,'input still flows while the navigation is pending');
  const closed=Date.now();await b.control.close('resumed','done');assert.ok(Date.now()-closed<4000,`close took ${Date.now()-closed} ms`);assert.equal(b.res.find('end').reason,'resumed');
});

test('a stream opened while a dialog is already open reports it right after ready and can answer it',chrome,async t=>{
  const base=await pageServer(t);
  const b=await browser(t,base,'dialogs',undefined,{before:async session=>{await session.pipe.send('Runtime.evaluate',{expression:'setTimeout(()=>{alert("Already open");document.title="answered";},0)'},session.session);await until(()=>session.dialog,'dialog before stream');}});
  const names=b.res.events.map(event=>event.name);assert.equal(names[0],'ready');assert.ok(names.indexOf('dialog')>0 && names.indexOf('dialog')<=2,`event order ${names.join(',')}`);
  assert.equal(b.res.find('dialog').message,'Already open');
  const started=Date.now();await b.input([{t:'dialog',accept:true}]);assert.ok(Date.now()-started<2500);
  await until(()=>b.res.find('dialog',event=>!event.open),'closed');await until(()=>b.res.find('frame'),'frames after the dialog');
  assert.equal(await b.evaluate(function(){return [innerWidth,screen.width>=innerWidth,screen.height>=innerHeight].join();}),'390,true,true');
});

test('screen metrics are never smaller than the viewport for the owner and the bot',chrome,async t=>{
  const base=await pageServer(t),b=await browser(t,base,'long',{width:1000,height:1100,dpr:1,touch:false});
  assert.deepEqual(await b.evaluate(function(){return [innerWidth,innerHeight,screen.width,screen.height];}),[1000,1100,1000,1100]);
  await b.control.close('resumed','done');
  assert.deepEqual(await b.evaluate(function(){return [innerWidth,innerHeight,screen.width,screen.height];}),[1280,900,1280,900]);
});

test('the stream route serves SSE under normal auth, refuses stale leases and repeated input, resumes promptly and keeps typed text out of state',chrome,async t=>{
  const base=await pageServer(t),directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-stream-api-'));let complete,count=0;
  const logs=[];for(const method of ['log','error','warn'])t.mock.method(console,method,(...args)=>{logs.push(args.join(' '));});
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,browserHandoffTimeoutMs:600_000,providers:{async complete(connection,request){return complete(request,++count);}}}),{url}=await app.listen(0);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-stream-api-profile-')),session=await BrowserSession.start({executable,profileRoot:root,allowPrivate:true,resolver});session.botId='bot_atlas';
  t.after(async()=>{await app.close();await session.close().catch(()=>{});await fs.rm(directory,{recursive:true,force:true});await fs.rm(root,{recursive:true,force:true});});
  await session.navigate(`${base}/password`);
  const restored=[];const send=session.pipe.send.bind(session.pipe);session.pipe.send=(method,params,...rest)=>{if(method==='Emulation.setDeviceMetricsOverride')restored.push(params.width);return send(method,params,...rest);};
  let cookie='',csrf='';
  const post=async(endpoint,data,{security=true}={})=>fetch(url+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Origin:url,...(cookie?{Cookie:cookie}:{}),...(security?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify(data)});
  const setup=await post('/api/setup',{token:app.bootstrapToken,password:'browser-fixture-password'});cookie=setup.headers.get('set-cookie').split(';')[0];csrf=(await setup.json()).csrf;
  await app.store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',model:'fixture'});Object.assign(state.bots[0],{connectionId:'fixture',tools:['browser']});});
  app.runtime.browsers.available=()=>true;app.runtime.browsers.setRetained=async(runId,botId,keep)=>{session.retained=keep;};
  complete=(request,number)=>{if(number===1){app.runtime.browsers.sessions.set(app.store.state.runs.bot_atlas.id,session);return {text:'',toolCalls:[{id:'help',name:'browser_handoff',arguments:{reason:'Please sign in.'}}]};}return {text:'Done.',toolCalls:[]};};
  await app.runtime.start('bot_atlas','Sign in for me.');
  const run=await until(()=>app.store.state.runs.bot_atlas?.status==='waiting_for_input' && structuredClone(app.store.state.runs.bot_atlas),'handoff');
  const identity={runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation},viewport={width:390,height:700,dpr:1,touch:false};
  assert.equal((await post('/api/bots/bot_atlas/browser/stream',{...identity,viewport},{security:false})).status,403);
  const stale=await post('/api/bots/bot_atlas/browser/stream',{...identity,execution_generation:0,viewport});assert.equal(stale.status,409);assert.match(stale.headers.get('content-type'),/json/);assert.equal((await stale.json()).code,'handoff_ended');
  assert.equal((await post('/api/bots/bot_atlas/browser/view',identity)).status,404,'the old one-shot view route is gone');
  const open=async()=>{
    const response=await post('/api/bots/bot_atlas/browser/stream',{...identity,viewport});assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'text/event-stream');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-accel-buffering'),'no');assert.equal(response.headers.get('content-encoding'),null);
    const events=[],reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    const pump=(async()=>{for(;;){const {value,done}=await reader.read();if(done)return;buffer+=decoder.decode(value,{stream:true});for(let end=buffer.indexOf('\n\n');end>=0;end=buffer.indexOf('\n\n')){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!block.startsWith(':'))events.push({name:/^event: (.*)$/m.exec(block)[1],data:JSON.parse(/^data: (.*)$/m.exec(block)[1])});}}})();
    const ready=(await until(()=>events.find(event=>event.name==='ready'),'ready')).data;await until(()=>events.find(event=>event.name==='frame'),'frame');
    return {events,ready,pump};
  };
  const first=await open(),second=await open();
  await until(()=>first.events.find(event=>event.name==='end'),'first stream replaced');assert.equal(first.events.find(event=>event.name==='end').data.reason,'replaced');await first.pump;
  const input=(body,streamId=second.ready.streamId)=>post('/api/bots/bot_atlas/browser/input',{...identity,streamId,...body});
  assert.equal((await input({seq:1,events:[]},first.ready.streamId)).status,409,'a replaced stream cannot send input');
  assert.equal((await input({seq:1,events:[{t:'eval',code:'1'}]})).status,400);
  assert.equal((await input({seq:1,events:Array.from({length:65},()=>({t:'wheel',x:1,y:1,dy:1}))})).status,413);
  const field=await session.evaluate(function(){const r=pw.getBoundingClientRect();return {x:r.left+5,y:r.top+5};},{});
  const tabId=second.ready.tabId,nav=second.ready.nav,secret='owner-typed-zx81';
  let response=await input({seq:1,events:[{t:'pointer',kind:'down',x:field.x,y:field.y,button:0,buttons:1,clickCount:1,tabId,nav},{t:'pointer',kind:'up',x:field.x,y:field.y,button:0,buttons:0,clickCount:1}]});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,seq:1,dropped:0});
  response=await input({seq:2,events:[...secret].flatMap(key=>[{t:'key',kind:'down',key},{t:'key',kind:'up',key}])});assert.equal(response.status,200);
  assert.equal((await input({seq:2,events:[{t:'text',text:'again'}]})).status,409,'a repeated seq is never replayed');
  assert.equal((await input({seq:1,events:[{t:'text',text:'again'}]})).status,409);
  assert.equal(await session.evaluate(function(){return pw.value;},{}),secret);
  // A hung page during a pending slow navigation must not block Resume.
  await session.pipe.send('Runtime.evaluate',{expression:"pw.addEventListener('keydown',()=>{const end=Date.now()+4000;while(Date.now()<end);})"},session.session);
  const navigating=Date.now();response=await input({seq:3,events:[{t:'navigate',url:`${base}/slow`}]});assert.equal(response.status,200);assert.ok(Date.now()-navigating<1000,'navigation input returns at once');
  await until(()=>second.events.some(event=>event.name==='state' && event.data.loading),'loading');
  const hung=input({seq:4,events:[{t:'key',kind:'down',key:'q'},{t:'key',kind:'up',key:'q'}]});await delay(200);
  const started=Date.now(),resumed=await post('/api/bots/bot_atlas/browser/resume',{...identity,keepSession:false});
  assert.equal(resumed.status,200);assert.ok(Date.now()-started<1500,`resume took ${Date.now()-started} ms`);
  await until(()=>second.events.find(event=>event.name==='end'),'stream end');assert.equal(second.events.find(event=>event.name==='end').data.reason,'resumed');await second.pump;
  assert.equal((await hung).status,200);
  await until(()=>app.store.state.runs.bot_atlas.status==='completed','completion');
  assert.equal(session.redact(`echo ${secret}`),'echo [private]');
  const persisted=await fs.readFile(app.store.file,'utf8');
  for(const value of [secret,second.events.find(event=>event.name==='frame').data.jpeg.slice(0,40)]){assert.ok(!persisted.includes(value));assert.ok(!logs.join('\n').includes(value));}
  assert.ok(!JSON.stringify(app.store.state).includes(secret));
  assert.equal(restored.at(-1),1280,'bot viewport restored before the task continued');
});

test('input validation refuses unknown fields and types, and keys derive virtual codes on the engine',()=>{
  assert.throws(()=>checkEvents([{t:'pointer',kind:'down',x:1,y:1}]),/tabId and nav/);
  assert.throws(()=>checkEvents([{t:'key',kind:'down',key:'a',extra:1}]),/unknown fields/);
  assert.throws(()=>checkEvents([{t:'text',text:''}]),/1 and 10000/);
  assert.throws(()=>checkEvents([{t:'touch',kind:'start',points:[{id:1,x:1,y:1,force:1}],tabId:'a',nav:0}]),/touch points/);
  assert.throws(()=>checkEvents(Array.from({length:65},()=>({t:'text',text:'a'}))),error=>error.status===413);
  assert.equal(virtualKey('KeyQ','q'),81);assert.equal(virtualKey('Digit7','7'),55);assert.equal(virtualKey('','Enter'),13);assert.equal(virtualKey('','é'),0);assert.equal(virtualKey('F5','F5'),116);assert.equal(virtualKey('Numpad3','3'),99);
});

test('text still being dispatched when the handoff ends is registered for redaction and blocks model screenshots',chrome,async t=>{
  const base=await pageServer(t),{session,control,input,evaluate}=await browser(t,base,'busy');
  await evaluate(function(){document.getElementById('f').focus();return 1;});
  const sending=input([{t:'text',text:'supersecret-in-flight'}]);
  await delay(150);await control.close('resumed','Back to the bot.');await sending;
  assert.equal(await evaluate(function(){return document.getElementById('f').value;}),'supersecret-in-flight');
  assert.ok(session.ownerSecrets.has('supersecret-in-flight'));assert.equal(session.redact('shows supersecret-in-flight'),'shows [private]');assert.equal(session.ownerTyped,true);
});

test('input too short to redact (a split code box) still marks the session as owner-typed',chrome,async t=>{
  const base=await pageServer(t),{session,input,evaluate}=await browser(t,base,'busy');
  await evaluate(function(){document.getElementById('f').focus();return 1;});
  await input([{t:'key',kind:'down',key:'4',code:'Digit4'},{t:'key',kind:'up',key:'4',code:'Digit4'}]);
  assert.equal(session.ownerSecrets.size,0,'one character is not a redaction entry');assert.equal(session.ownerTyped,true,'but model screenshots stay blocked');
});

test('an owner tab switch that outlives the end of the handoff never leaves the phone viewport or touch on for the bot',chrome,async t=>{
  const base=await pageServer(t),{session,control,input}=await browser(t,base,'blank',{width:390,height:700,dpr:2,touch:true},{before:async session=>{const first=session.tabId;session.other=(await session.pipe.send('Target.createTarget',{url:`${base}/churn`})).targetId;await session.switchTab(first);}});
  const original=session.switchTab.bind(session);session.switchTab=async(...args)=>{await delay(4000);return original(...args);};
  const switching=input([{t:'tab',tabId:session.other}]);
  await delay(200);await control.close('resumed','Back to the bot.');await switching;
  const view=await until(async()=>{const value=await session.evaluate(function(){return {w:innerWidth,touch:navigator.maxTouchPoints,dpr:devicePixelRatio};},{});return value.w===1280 && value.touch===0 && value.dpr===1 && value;},'the bot viewport',8000);
  assert.deepEqual(view,{w:1280,touch:0,dpr:1});
});

test('a dialog left open in one tab survives switching tabs and back, can still be answered, and the other tab is not held by it',chrome,async t=>{
  const base=await pageServer(t),{session,control,res,input,click}=await browser(t,base,'tabalert',undefined,{before:async session=>{const first=session.tabId;session.other=(await session.pipe.send('Target.createTarget',{url:`${base}/churn`})).targetId;await session.switchTab(first);}});
  const A=session.tabId,B=session.other;
  await click({x:50,y:50});await until(()=>session.dialog,'the alert');
  await input([{t:'tab',tabId:B}]);assert.equal(session.dialog,null);assert.equal(res.all('dialog').at(-1).open,false,'the panel hides the dialog on the other tab');
  const started=Date.now();assert.deepEqual(await click({x:60,y:140}),{dropped:0});assert.ok(Date.now()-started<900,'input on the other tab is not paced by the first tab\'s dialog');
  await input([{t:'tab',tabId:A}]);assert.equal(session.dialog?.message,'hello');assert.equal(res.all('dialog').at(-1).open,true,'the panel shows it again');
  assert.deepEqual(await input([{t:'dialog',accept:true}]),{dropped:0});
  await until(async()=>(await session.evaluate(function(){return document.title;},{}))==='after','the page to continue');assert.equal(session.dialog,null);
  await control.close('resumed','Back to the bot.');
});

test('a press that opened a dialog from mousedown does not leave the mouse button held after the dialog is answered',chrome,async t=>{
  const base=await pageServer(t),{session,input,evaluate,control}=await browser(t,base,'downalert');
  assert.deepEqual(await input([{t:'pointer',kind:'down',x:50,y:50,button:0,buttons:1,clickCount:1,tabId:session.tabId,nav:control.nav},{t:'pointer',kind:'up',x:50,y:50,button:0,buttons:0,clickCount:1,dt:20}]),{dropped:1});
  assert.ok(session.dialog);await input([{t:'dialog',accept:true}]);await until(()=>!session.dialog,'the dialog to close');
  await until(async()=>Number(await evaluate(function(){return document.body.dataset.up || 0;}))>=1,'the held button to be released');
  await input([{t:'pointer',kind:'move',x:120,y:120,buttons:0}]);
  assert.equal(await until(()=>evaluate(function(){return document.body.dataset.buttons;}),'a mouse move'),'0');
});

test('AltGr characters (Ctrl+Alt with one printable key) are typed as text, other Ctrl shortcuts are not',async()=>{
  const sent=[],session={pipe:{handlers:new Set(),send:async(method,params)=>{sent.push(params);return {};}},session:'s',tabId:'t',dialog:null,keepPrivate(){},ownerTouched:false};
  const control=new OwnerControl(session);
  for(const [key,code] of [['@','KeyQ'],['€','KeyE'],['\\','Minus']]){sent.length=0;await control.keyEvent({kind:'down',key,code,modifiers:3});assert.equal(sent[0].type,'keyDown');assert.equal(sent[0].text,key);assert.equal(sent[0].modifiers,0);assert.equal(sent[0].commands,undefined);}
  assert.equal(control.run,'@€\\');assert.equal(session.ownerTyped,true);
  sent.length=0;await control.keyEvent({kind:'down',key:'a',code:'KeyA',modifiers:2});assert.equal(sent[0].type,'rawKeyDown');assert.deepEqual(sent[0].commands,['selectAll']);
});

test('a chain of website dialogs is answered at once each time, not held behind a view restart',chrome,async t=>{
  const base=await pageServer(t);
  const b=await browser(t,base,'dialogs',undefined,{before:async session=>{await session.pipe.send('Runtime.evaluate',{expression:'setTimeout(()=>{alert("First");const ok=confirm("Second");document.title="done "+ok;},0)'},session.session);await until(()=>session.dialog,'dialog before stream');}});
  await b.input([{t:'resize',width:390,height:650,dpr:1,touch:false}]);
  for(const [message,accept] of [['First',true],['Second',false]]){
    await until(()=>b.session.dialog?.message===message,message);
    const started=Date.now();await b.input([{t:'dialog',accept}]);assert.ok(Date.now()-started<700,`answering ${message} took ${Date.now()-started} ms`);
  }
  await until(async()=>(await b.evaluate(function(){return document.title;}))==='done false','the page to continue');
  await until(()=>b.res.all('frame').length>0,'frames after the dialogs');
  assert.equal(await b.evaluate(function(){return innerWidth+'x'+innerHeight;}),'390x650','the owner view is applied once the dialogs are gone');
  await until(()=>!b.control.viewPending,'the view restart to settle');
  // The screencast runs again (one live screencast, not two racing ones): a navigation shows its new page.
  const nav=b.control.nav;await b.input([{t:'navigate',url:`${base}/long`}]);
  await until(()=>b.res.all('frame').some(frame=>frame.nav>nav),'a frame of the new page');
});
