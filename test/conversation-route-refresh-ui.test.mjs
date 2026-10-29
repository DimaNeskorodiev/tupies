import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const response=(body,status=200)=>({status,ok:status>=200&&status<300,headers:{get:()=>''},async json(){return body;}});
const bot=id=>({id,name:id,title:'Synthetic route QA',connectionId:'connection_qa',model:'fixture-model',color:'mint',enabled:true,tools:[],skills:[],collaborators:[],integrationIds:[]});
const state=({target=true,room=true}={})=>({bots:[bot('bot_existing'),...(target?[bot('bot_target')]:[])],rooms:room?[{id:'room_target',name:'Synthetic late room',botIds:['bot_existing']}]:[],connections:[{id:'connection_qa',type:'openai',status:'connected',defaultModel:'fixture-model'}]});

function harness(t,readState){
 const dom=new JSDOM('<div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'https://studio.test/#/bot/bot_existing',runScripts:'outside-only',pretendToBeVisual:true}),win=dom.window,doc=win.document,calls=[];
 win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});win.setInterval=()=>1;win.scrollTo=()=>{};win.requestAnimationFrame=()=>1;win.cancelAnimationFrame=()=>{};win.HTMLElement.prototype.scrollIntoView=()=>{};
 win.fixtureInitialState=state({target:false,room:false});
 win.fetch=async(route,options={})=>{
  const method=options.method||'GET';calls.push({route,method});assert.equal(method,'GET','Restored notification navigation must not dispatch a task.');
  if(route==='/api/state')return readState();
  if(route==='/api/providers')return response({providers:[],features:{}});
  if(/^\/api\/(bots\/bot_(existing|target)|rooms\/room_target)\/messages$/.test(route))return response({messages:[{id:'synthetic_message',role:'assistant',botId:route.includes('/rooms/')?'bot_existing':undefined,content:'SYNTHETIC_ROUTE_CONTENT'}],run:null,drive:null,elsewhere:null});
  assert.fail(`Unexpected synthetic route ${route}`);
 };
 const context=dom.getInternalVMContext();vm.runInContext(source,context);vm.runInContext("auth={authenticated:true,csrf:'synthetic'};data={...initialState,...fixtureInitialState};providerCatalog=[{id:'fixture'}];renderApp();",context);
 t.after(()=>win.close());return {win,doc,calls,run:code=>vm.runInContext(code,context),visible:async()=>{win.dispatchEvent(new win.Event('studio:visible'));await tick();},navigate:async hash=>{win.location.hash=hash;await tick();}};
}

for(const scope of ['bot','room'])test(`a fresh state read rebuilds a previously missing ${scope} frame after a notification hash races restored state`,async t=>{
 const pending=deferred(),h=harness(t,()=>pending.promise);await tick();await h.visible();assert.equal(h.calls.filter(call=>call.route==='/api/state').length,1);
 await h.navigate(scope==='bot'?'#/bot/bot_target':'#/room/room_target');
 pending.resolve(response(state()));await tick();
 const form=h.doc.querySelector(scope==='bot'?'#message-form':'#room-message-form');assert.equal(form?.dataset.id,scope==='bot'?'bot_target':'room_target');
 assert.match(h.doc.querySelector(scope==='bot'?'#chat-thread':'#room-thread').textContent,/SYNTHETIC_ROUTE_CONTENT/);
 assert.doesNotMatch(h.doc.querySelector('#app').textContent,/isn’t here|may have been removed/);
 assert.ok(h.calls.every(call=>!call.route.includes('/bots/room_target/')),'The latest route type, not the pre-refresh type, selects the endpoint.');
});

test('a newly missing target gets a fresh state read despite the visible-refresh throttle',async t=>{
 let count=0;const h=harness(t,()=>response(++count===1?state({target:false,room:false}):state()));await tick();await h.visible();assert.equal(count,1);
 await h.navigate('#/bot/bot_target');await h.visible();await tick();assert.equal(h.doc.querySelector('#message-form')?.dataset.id,'bot_target');assert.ok(count>=2);
});

test('refreshing an already mounted conversation preserves its exact composer and unsent draft',async t=>{
 const h=harness(t,()=>response(state()));await tick();const field=h.doc.querySelector('#message-input');field.value='Keep my unsent route QA draft';await h.visible();
 assert.equal(h.doc.querySelector('#message-input'),field);assert.equal(field.value,'Keep my unsent route QA draft');assert.equal(h.doc.querySelector('#message-form').dataset.id,'bot_existing');
});

test('a late state response opens only the latest route and cannot replace an existing composer after navigation',async t=>{
 const pending=deferred(),h=harness(t,()=>pending.promise);await tick();await h.visible();await h.navigate('#/bot/bot_target');await h.navigate('#/bot/bot_existing');
 const field=h.doc.querySelector('#message-input');field.value='Preserve the latest screen';pending.resolve(response(state()));await tick();
 assert.equal(h.win.location.hash,'#/bot/bot_existing');assert.equal(h.doc.querySelector('#message-input'),field);assert.equal(field.value,'Preserve the latest screen');
 assert.equal(h.calls.filter(call=>call.route==='/api/bots/bot_target/messages').length,0);
});

test('sign-out during a restored-state read cannot repopulate conversations or show an old destination',async t=>{
 const pending=deferred(),h=harness(t,()=>pending.promise);await tick();await h.visible();await h.navigate('#/bot/bot_target');
 h.run("auth={authenticated:false,passwordSignIn:true,setupRequired:false};data={...initialState};renderAuth();");pending.resolve(response(state()));await tick();
 assert.ok(h.doc.querySelector('#auth-form'));assert.equal(h.doc.querySelector('#message-form'),null);assert.equal(h.run('data.bots.length'),0);
});

test('an older pre-route state read cannot confirm a newly requested target missing',async t=>{
 const beforeRoute=deferred(),afterRoute=deferred();let reads=0;const h=harness(t,()=>++reads===1?beforeRoute.promise:afterRoute.promise);await tick();await h.visible();await h.navigate('#/bot/bot_target');
 assert.equal(reads,2,'The target must get one state request admitted after its route, independent of the older refresh.');
 assert.match(h.doc.querySelector('#app').textContent,/Opening your conversation/);assert.equal(h.doc.querySelector('#main-content [data-action="create-bot"]'),null);
 beforeRoute.resolve(response(state({target:false,room:false})));await tick();
 assert.match(h.doc.querySelector('#app').textContent,/Opening your conversation/);assert.doesNotMatch(h.doc.querySelector('#app').textContent,/isn’t here|may have been removed/);
 afterRoute.resolve(response(state()));await tick();assert.equal(h.doc.querySelector('#message-form')?.dataset.id,'bot_target');
});

test('a late older workspace response cannot remove a target that a newer route read already found',async t=>{
 const old=deferred(),current=deferred();let reads=0;const h=harness(t,()=>++reads===1?old.promise:current.promise);await tick();await h.visible();await h.navigate('#/bot/bot_target');
 current.resolve(response(state()));await tick();const field=h.doc.querySelector('#message-input');assert.ok(field);field.value='Keep this newly opened draft';
 old.resolve(response(state({target:false,room:false})));await tick();
 assert.equal(h.doc.querySelector('#message-input'),field);assert.equal(field.value,'Keep this newly opened draft');assert.equal(h.run("!!botById('bot_target')"),true);
});

test('a genuinely absent conversation is declared missing only after its one fresh successful state read',async t=>{
 const pending=deferred();let reads=0;const h=harness(t,()=>{reads++;return pending.promise;});await tick();await h.navigate('#/bot/bot_target');
 assert.equal(reads,1);assert.match(h.doc.querySelector('#app').textContent,/Opening your conversation/);assert.doesNotMatch(h.doc.querySelector('#app').textContent,/isn’t here/);
 pending.resolve(response(state({target:false,room:false})));await tick();assert.match(h.doc.querySelector('#app').textContent,/This bot isn’t here/);assert.ok(h.doc.querySelector('[data-action="create-bot"]'));
 h.run('renderApp();renderApp()');await tick();assert.equal(reads,1,'Confirmed absence cannot trigger an automatic request loop.');
});

test('a failed route refresh offers a read-only retry instead of claiming the bot was removed',async t=>{
 let reads=0;const h=harness(t,()=>++reads===1?Promise.reject(new Error('Synthetic lost response')):response(state()));await tick();await h.navigate('#/bot/bot_target');
 assert.match(h.doc.querySelector('#app').textContent,/Couldn’t refresh this conversation/);assert.doesNotMatch(h.doc.querySelector('#app').textContent,/isn’t here|may have been removed/);
 assert.equal(reads,1);h.doc.querySelector('[data-action="reload-conversation-route"]').click();await tick();
 assert.equal(reads,2);assert.equal(h.doc.querySelector('#message-form')?.dataset.id,'bot_target');assert.ok(h.calls.every(call=>call.method==='GET'));
});

test('an abandoned missing-bot lookup cannot replace a newer missing-room lookup or its content',async t=>{
 const botRead=deferred(),roomRead=deferred();let reads=0;const h=harness(t,()=>++reads===1?botRead.promise:roomRead.promise);await tick();await h.navigate('#/bot/bot_target');await h.navigate('#/room/room_target');
 botRead.resolve(response(state()));await tick();assert.equal(h.win.location.hash,'#/room/room_target');assert.equal(h.doc.querySelector('#message-form'),null);assert.match(h.doc.querySelector('#app').textContent,/Opening your team room/);
 roomRead.resolve(response(state({target:false})));await tick();assert.equal(h.doc.querySelector('#room-message-form')?.dataset.id,'room_target');assert.match(h.doc.querySelector('#room-thread').textContent,/SYNTHETIC_ROUTE_CONTENT/);
 assert.equal(h.calls.filter(call=>call.route==='/api/bots/bot_target/messages').length,0);
});

for(const outcome of ['success','failure'])test(`a late route resolver ${outcome} preserves a frame and draft already repaired by a newer refresh`,async t=>{
 const resolver=deferred();let reads=0;const h=harness(t,()=>++reads===1?resolver.promise:response(state()));await tick();await h.navigate('#/bot/bot_target');assert.equal(reads,1);
 await h.visible();assert.equal(reads,2);const field=h.doc.querySelector('#message-input');assert.ok(field);field.value='Keep the repaired conversation draft';
 if(outcome==='success')resolver.resolve(response(state({target:false,room:false})));else resolver.reject(new Error('Late obsolete route lookup failed'));
 await tick();assert.equal(h.doc.querySelector('#message-input'),field);assert.equal(field.value,'Keep the repaired conversation draft');assert.equal(h.doc.querySelector('#message-form').dataset.id,'bot_target');assert.match(h.doc.querySelector('#chat-thread').textContent,/SYNTHETIC_ROUTE_CONTENT/);
 assert.doesNotMatch(h.doc.querySelector('#app').textContent,/isn’t here|Couldn’t refresh/);
});
