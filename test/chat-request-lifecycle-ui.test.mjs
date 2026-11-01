import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const response=(status,value)=>({status,ok:status>=200&&status<300,async json(){return value;}});
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
function harness(responses){
  const originalThread={innerHTML:'Original conversation',scrollTop:0,clientHeight:500,scrollHeight:500,querySelector(){return null;}};let currentThread=originalThread,index=0;const requests=[];
  const app={_html:'',get innerHTML(){return this._html;},set innerHTML(value){this._html=value;currentThread=null;}},send={disabled:false},draft={value:'An unsent draft'},header={innerHTML:''};
  const document={hidden:false,activeElement:null,addEventListener(){},querySelectorAll(){return [];},querySelector(selector){if(selector==='#app')return app;if(selector==='#chat-thread'||selector==='#room-thread')return currentThread;if(selector==='#message-form .send'||selector==='#room-message-form .send')return send;if(selector==='#message-input'||selector==='#room-message-input')return draft;if(selector==='.chat-header .chat-tools')return header;return null;}};
  const context=vm.createContext({document,window:{addEventListener(){}},location:{hash:'#/bot/bot_qa'},URL,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},fetch:async(path,options)=>{requests.push({path,headers:{...options?.headers}});const next=responses[index++];if(!next)throw new Error('Unexpected request');if(next instanceof Error)throw next;return next.promise?await next.promise:next;}});
  vm.runInContext(source,context,{filename:'app.js'});vm.runInContext("auth={authenticated:true,csrf:'token'};data={...initialState,bots:[{id:'bot_qa',name:'Atlas',skills:[]}]};activeBot='bot_qa';",context);
  return {context,app,originalThread,requests,draft,header,get currentThread(){return currentThread;},set currentThread(value){currentThread=value;},run:code=>vm.runInContext(code,context)};
}
test('a 401 during chat loading returns to sign-in without writing into a removed thread or rejecting',async()=>{
  const h=harness([response(401,{error:'Sign in to continue.'})]);
  await assert.doesNotReject(h.run("loadChat('bot_qa')"));assert.equal(h.run('auth.authenticated'),false);assert.match(h.app.innerHTML,/auth-screen/);assert.equal(h.currentThread,null);assert.equal(h.originalThread.innerHTML,'Original conversation');
});
test('an older failed chat request cannot replace a newer successful conversation',async()=>{
  const first=deferred(),second=deferred(),h=harness([first,second]);const older=h.run("loadChat('bot_qa')"),newer=h.run("loadChat('bot_qa')");
  second.resolve(response(200,{messages:[{id:'fresh',role:'assistant',content:'Fresh reply'}],run:null}));await newer;assert.match(h.currentThread.innerHTML,/Fresh reply/);
  first.resolve(response(503,{error:'Stale service failure'}));await older;assert.match(h.currentThread.innerHTML,/Fresh reply/);assert.doesNotMatch(h.currentThread.innerHTML,/Stale service failure/);
});
test('a failed request does not render into a chat after the view changes, even when the route id matches',async()=>{
  const pending=deferred(),h=harness([pending]),loading=h.run("loadChat('bot_qa')");h.run("location.hash='#/room/bot_qa'");pending.resolve(response(500,{error:'Old bot request'}));await loading;assert.equal(h.originalThread.innerHTML,'Original conversation');
});
test('a successful request arriving after another request expires the session cannot repopulate the old chat',async()=>{
  const unauthorized=deferred(),late=deferred(),h=harness([unauthorized,late]);const first=h.run("loadChat('bot_qa')"),second=h.run("loadChat('bot_qa')");unauthorized.resolve(response(401,{error:'Session expired'}));await first;late.resolve(response(200,{messages:[{role:'assistant',content:'Late private reply'}],run:null}));await second;assert.equal(h.currentThread,null);assert.match(h.app.innerHTML,/auth-screen/);assert.equal(h.run('chat.messages.length'),0);assert.equal(h.originalThread.innerHTML,'Original conversation');
});
test('polling revalidates only the transcript already on screen and skips rendering when it is unchanged',async()=>{
  const tagged=(status,value,etag)=>({...response(status,value),headers:{get:name=>name==='ETag'?etag:null}});
  const h=harness([tagged(200,{messages:[{id:'first',role:'assistant',content:'First reply'}],run:null},'"t1"'),tagged(304,undefined,'"t1"'),tagged(200,{messages:[{id:'first',role:'assistant',content:'First reply'}],run:null},'"t1"'),tagged(200,{messages:[{id:'second',role:'assistant',content:'Second reply'}],run:null},'"t2"')]);
  await h.run("loadChat('bot_qa')");assert.equal(h.requests[0].headers['If-None-Match'],undefined);assert.match(h.currentThread.innerHTML,/First reply/);
  h.currentThread.innerHTML='Drawn from t1';
  await h.run("loadChat('bot_qa',{poll:true})");assert.equal(h.requests[1].headers['If-None-Match'],'"t1"');assert.equal(h.currentThread.innerHTML,'Drawn from t1');assert.equal(h.run('chat.messages[0].id'),'first');
  // A thread element that was not drawn from that response is redrawn from a full reply.
  h.currentThread={innerHTML:'Fresh page',scrollTop:0,clientHeight:500,scrollHeight:500,querySelector(){return null;}};
  await h.run("loadChat('bot_qa',{poll:true})");assert.equal(h.requests[2].headers['If-None-Match'],undefined);assert.match(h.currentThread.innerHTML,/First reply/);
  await h.run("loadChat('bot_qa',{poll:true})");assert.equal(h.requests[3].headers['If-None-Match'],'"t1"');assert.match(h.currentThread.innerHTML,/Second reply/);assert.equal(h.run('chat.etag'),'"t2"');
});
test('an engine name reported by another engine is shown as text in the status pill',()=>{
  const h=harness([]);h.run("chat={messages:[],run:null,elsewhere:{name:'<button data-action=\"delete-bot\">Mac</button>'}};data.connections=[{id:'c',type:'openai',status:'connected'}];data.bots[0].connectionId='c';");
  const pill=h.run("statusPill(data.bots[0])");
  assert.doesNotMatch(pill,/<button/);assert.match(pill,/Working on &lt;button data-action=&quot;delete-bot&quot;&gt;Mac&lt;\/button&gt;/);
});

const tagged=(status,value,etag='"thread-1"')=>({...response(status,value),headers:{get:name=>name==='ETag'?etag:null}});
const connected="data.connections=[{id:'c',type:'openai',status:'connected',defaultModel:'fixture'}];data.bots[0].connectionId='c';";
const room="location.hash='#/room/room_qa';data.rooms=[{id:'room_qa',name:'Team',botIds:['bot_qa']}];refresh=async()=>{};";
test('a failed conversation poll preserves messages and draft, shows connection failure, then recovers on 304',async()=>{
  const h=harness([tagged(200,{messages:[{id:'cached',role:'assistant',content:'A received reply'}],run:null}),new TypeError('Load failed'),tagged(304)]);h.run(connected);
  await h.run("loadChat('bot_qa')");assert.equal(h.header.innerHTML,'');
  await h.run("loadChat('bot_qa',{poll:true})");assert.match(h.currentThread.innerHTML,/A received reply/);assert.match(h.currentThread.innerHTML,/Showing the last received messages/);assert.match(h.currentThread.innerHTML,/Try again/);assert.match(h.header.innerHTML,/Can't reach engine|Can&#39;t reach engine/);assert.doesNotMatch(h.header.innerHTML,/class="status-pill ready"/);assert.equal(h.draft.value,'An unsent draft');
  await h.run("loadChat('bot_qa',{poll:true})");assert.equal(h.requests[2].headers['If-None-Match'],'"thread-1"');assert.match(h.currentThread.innerHTML,/A received reply/);assert.doesNotMatch(h.currentThread.innerHTML,/conversation-load-error/);assert.equal(h.header.innerHTML,'');assert.equal(h.draft.value,'An unsent draft');
});
test('an initial HTTP failure reports a load error without claiming the engine is offline or welcoming an empty chat',async()=>{
  const h=harness([response(500,{error:'Temporary <service> error'})]);h.run(connected);
  await h.run("loadChat('bot_qa')");assert.match(h.currentThread.innerHTML,/Couldn&#39;t load this conversation/);assert.match(h.currentThread.innerHTML,/Temporary &lt;service&gt; error/);assert.doesNotMatch(h.currentThread.innerHTML,/Offline|offline|Can&#39;t reach|Say hello/);assert.doesNotMatch(h.header.innerHTML,/>Ready</);assert.equal(h.draft.value,'An unsent draft');
});
test('a received server error preserves cached messages and a later full response removes its notice',async()=>{
  const h=harness([tagged(200,{messages:[{id:'cached',role:'assistant',content:'Cached reply'}],run:null}),response(503,{error:'Busy service'}),tagged(200,{messages:[{id:'fresh',role:'assistant',content:'Fresh reply'}],run:null},'"thread-2"')]);h.run(connected);
  await h.run("loadChat('bot_qa')");await h.run("loadChat('bot_qa',{poll:true})");assert.match(h.currentThread.innerHTML,/Cached reply/);assert.match(h.header.innerHTML,/Can&#39;t refresh/);assert.doesNotMatch(h.currentThread.innerHTML,/Offline|offline|Can&#39;t reach/);
  await h.run("loadChat('bot_qa')");assert.match(h.currentThread.innerHTML,/Fresh reply/);assert.doesNotMatch(h.currentThread.innerHTML,/conversation-load-error|Cached reply/);assert.equal(h.header.innerHTML,'');
});
test('room polling preserves its received transcript and draft, and recovers with an unchanged response',async()=>{
  const h=harness([tagged(200,{messages:[{id:'room-reply',role:'assistant',botId:'bot_qa',content:'Received team reply'}],drive:null}),new TypeError('Load failed'),tagged(304)]);h.run(room);
  await h.run("loadRoomChat('room_qa')");await h.run("loadRoomChat('room_qa',{poll:true})");assert.match(h.currentThread.innerHTML,/Received team reply/);assert.match(h.currentThread.innerHTML,/Showing the last received messages/);assert.equal(h.draft.value,'An unsent draft');
  await h.run("loadRoomChat('room_qa',{poll:true})");assert.equal(h.requests[2].headers['If-None-Match'],'"thread-1"');assert.match(h.currentThread.innerHTML,/Received team reply/);assert.doesNotMatch(h.currentThread.innerHTML,/conversation-load-error/);
});
test('an older failed room request cannot overwrite a newer successful room response',async()=>{
  const first=deferred(),second=deferred(),h=harness([first,second]);h.run(room);const older=h.run("loadRoomChat('room_qa')"),newer=h.run("loadRoomChat('room_qa')");
  second.resolve(response(200,{messages:[{id:'fresh',role:'assistant',botId:'bot_qa',content:'Fresh team reply'}],drive:null}));await newer;
  first.resolve(response(503,{error:'Stale room failure'}));await older;assert.match(h.currentThread.innerHTML,/Fresh team reply/);assert.doesNotMatch(h.currentThread.innerHTML,/conversation-load-error|Stale room failure/);
});
test('a room failure after navigation cannot replace a bot with the same route id',async()=>{
  const pending=deferred(),h=harness([pending]);h.run(room);const loading=h.run("loadRoomChat('room_qa')");h.run("location.hash='#/bot/room_qa'");pending.resolve(response(500,{error:'Old room failure'}));await loading;assert.equal(h.originalThread.innerHTML,'Original conversation');
});
test('a room 401 returns to sign-in without writing a stale conversation error',async()=>{
  const h=harness([response(401,{error:'Session expired'})]);h.run(room);await assert.doesNotReject(h.run("loadRoomChat('room_qa')"));assert.equal(h.currentThread,null);assert.match(h.app.innerHTML,/auth-screen/);assert.equal(h.originalThread.innerHTML,'Original conversation');assert.equal(h.run('roomChat.loadError'),undefined);
});
