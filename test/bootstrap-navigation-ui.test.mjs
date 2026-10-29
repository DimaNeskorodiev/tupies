import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

// Execute the complete shipped app, including its real hashchange listener, api(),
// authentication rendering and boot/state loading. Fetch never leaves this fixture.
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<3;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const response=(body,status=200)=>({status,ok:status>=200&&status<300,headers:{get:()=>''},async json(){return body;}});
const authenticated=label=>({authenticated:true,csrf:`synthetic-${label}`,setupRequired:true,passwordSignIn:false});
const fixtureState=label=>({
  settings:{fixtureLabel:label,timezone:'Europe/Warsaw'},
  bots:['first','target'].map(name=>({id:`bot_${name}`,name:`${label} ${name}`,title:'Synthetic boot QA',color:'mint',enabled:true,connectionId:'connection_qa',model:'fixture-model',tools:[],skills:[],collaborators:[],integrationIds:[]})),
  connections:[{id:'connection_qa',type:'openai',name:'Synthetic connection',status:'connected',defaultModel:'fixture-model'}],
  rooms:[{id:'room_qa',name:'Synthetic room',botIds:['bot_first','bot_target']}]
});

function harness(t,{auth=()=>response(authenticated('current')),state=()=>response(fixtureState('current')),providers=()=>response({providers:[],features:{}})}={}){
  const dom=new JSDOM('<div id="app"><main class="loading-screen">Starting synthetic engine</main></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'https://studio.test/#/dashboard',runScripts:'outside-only'}),win=dom.window,doc=win.document,calls=[];
  win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  win.setInterval=()=>1;win.clearInterval=()=>{};win.scrollTo=()=>{};win.requestAnimationFrame=()=>1;win.cancelAnimationFrame=()=>{};
  win.HTMLElement.prototype.scrollIntoView=()=>{};
  win.fetch=async(route,options={})=>{
    const call={route,method:options.method||'GET'};calls.push(call);
    assert.equal(call.method,'GET','Boot and notification navigation must not dispatch a task or other mutation.');
    if(route==='/api/auth')return auth(call);
    if(route==='/api/state')return state(call);
    if(route==='/api/providers')return providers(call);
    if(/^\/api\/(?:bots|rooms)\/[a-z_]+\/messages$/.test(route))return response({messages:[],run:null,drive:null,elsewhere:null});
    assert.fail(`Unexpected synthetic boot request: ${route}`);
  };
  const context=dom.getInternalVMContext();vm.runInContext(source,context,{filename:'app.js'});
  t.after(()=>win.close());
  return {win,doc,calls,run:code=>vm.runInContext(code,context),start:()=>vm.runInContext('start()',context),navigate:async hash=>{win.location.hash=hash;await tick();}};
}
function pendingShell(h){
  assert.equal(h.doc.querySelector('.app-shell'),null);
  assert.equal(h.doc.querySelector('.auth-screen'),null);
  assert.match(h.doc.querySelector('#app').textContent,/Starting synthetic engine/);
  assert.equal(h.run('sendSessionGeneration'),0,'Navigation cannot invalidate boot authentication.');
}
function targetOpened(h,label='current'){
  assert.equal(h.win.location.hash,'#/bot/bot_target');
  assert.equal(h.doc.querySelector('.app-shell')?.dataset.view,'bot');
  assert.equal(h.doc.querySelector('#message-form')?.dataset.id,'bot_target');
  assert.equal(h.run('activeBot'),'bot_target');
  assert.match(h.doc.querySelector('.chat-identity h1').textContent,new RegExp(`${label} target`));
  assert.doesNotMatch(h.doc.querySelector('#app').textContent,/sign-in session changed|Try again/);
}

test('a native-style hash during pending boot auth retains the latest destination without invalidating the session',async t=>{
  const auth=deferred(),h=harness(t,{auth:()=>auth.promise}),boot=h.start();
  assert.deepEqual(h.calls.map(call=>call.route),['/api/auth']);
  await h.navigate('#/bot/bot_first');await h.navigate('#/room/room_qa');await h.navigate('#/bot/bot_target');pendingShell(h);
  auth.resolve(response(authenticated('current')));await boot;await tick();targetOpened(h);
  assert.equal(h.run('sendSessionGeneration'),0);assert.equal(h.calls.filter(call=>call.route==='/api/auth').length,1);
  assert.ok(h.calls.filter(call=>call.route.endsWith('/messages')).every(call=>call.route==='/api/bots/bot_target/messages'));
});

for(const phase of ['state','providers'])test(`notification hashes during pending boot ${phase} do not render partial workspace data`,async t=>{
  const pending=deferred(),h=harness(t,{[phase]:()=>pending.promise}),boot=h.start();await tick();
  assert.ok(h.calls.some(call=>call.route===`/api/${phase}`));
  await h.navigate('#/bot/bot_first');await h.navigate('#/bot/bot_target');pendingShell(h);
  pending.resolve(response(phase==='state'?fixtureState('current'):{providers:[{id:'fixture-provider',name:'Synthetic provider'}],features:{}}));
  await boot;await tick();targetOpened(h);assert.equal(h.run('sendSessionGeneration'),0);
});

for(const passwordSignIn of [true,false])test(`genuinely unauthenticated boot still shows the ${passwordSignIn?'password':'paired-app'} sign-in screen`,async t=>{
  const auth=deferred(),h=harness(t,{auth:()=>auth.promise}),boot=h.start();await h.navigate('#/bot/bot_target');pendingShell(h);
  auth.resolve(response({authenticated:false,setupRequired:false,passwordSignIn,csrf:null}));await boot;
  assert.ok(h.doc.querySelector('.auth-screen'));assert.equal(h.doc.querySelector('.app-shell'),null);
  assert.equal(!!h.doc.querySelector('#auth-form'),passwordSignIn);assert.equal(h.run('sendSessionGeneration'),1);
  assert.deepEqual(h.calls.map(call=>call.route),['/api/auth']);assert.doesNotMatch(h.doc.querySelector('#app').textContent,/sign-in session changed/);
});

for(const late of ['success','failure'])test(`a superseded boot auth ${late} cannot replace a newer authenticated boot`,async t=>{
  const old=deferred();let authCalls=0;const h=harness(t,{auth:()=>++authCalls===1?old.promise:response(authenticated('new')),state:()=>response(fixtureState('new'))}),first=h.start();
  await h.navigate('#/bot/bot_target');await h.start();await tick();targetOpened(h,'new');const html=h.doc.querySelector('#app').innerHTML;
  if(late==='success')old.resolve(response({authenticated:false,setupRequired:false,passwordSignIn:true,csrf:null}));else old.reject(new Error('Obsolete boot network failure'));
  await first;await tick();assert.equal(h.doc.querySelector('#app').innerHTML,html);assert.equal(h.run('auth.csrf'),'synthetic-new');assert.equal(h.run('sendSessionGeneration'),0);
});

for(const phase of ['state','providers'])test(`a superseded boot ${phase} response cannot overwrite newer workspace/catalog data`,async t=>{
  const old=deferred();let calls=0;const route=()=>++calls===1?old.promise:response(phase==='state'?fixtureState('new'):{providers:[{id:'new-provider'}],features:{new:true}});
  const h=harness(t,{auth:()=>response(authenticated('new')),state:phase==='state'?route:()=>response(fixtureState('new')),providers:phase==='providers'?route:()=>response({providers:[{id:'new-provider'}],features:{new:true}})}),first=h.start();
  await tick();await h.navigate('#/bot/bot_target');await h.start();await tick();targetOpened(h,'new');const html=h.doc.querySelector('#app').innerHTML;
  old.resolve(response(phase==='state'?fixtureState('old-private'):{providers:[{id:'old-provider'}],features:{old:true}}));await first;await tick();
  assert.equal(h.doc.querySelector('#app').innerHTML,html);assert.equal(h.run('data.settings.fixtureLabel'),'new');assert.equal(h.run('providerCatalog[0].id'),'new-provider');assert.equal(h.run('providerFeatures.new'),true);
});

for(const phase of ['auth','state','providers'])test(`sign-out invalidates pending boot ${phase} without a stale success or abort warning replacing sign-in`,async t=>{
  const pending=deferred(),h=harness(t,{[phase]:()=>pending.promise}),boot=h.start();await tick();
  h.run("auth={authenticated:false,setupRequired:false,passwordSignIn:true,csrf:null};data={...initialState};providerCatalog=[];renderAuth();");
  const html=h.doc.querySelector('#app').innerHTML;assert.ok(h.doc.querySelector('#auth-form'));assert.equal(h.run('sendSessionGeneration'),1);
  pending.resolve(response(phase==='auth'?authenticated('old'):phase==='state'?fixtureState('old-private'):{providers:[{id:'old-provider'}],features:{old:true}}));
  await boot;await tick();assert.equal(h.doc.querySelector('#app').innerHTML,html);assert.equal(h.run('auth.authenticated'),false);assert.equal(h.run('data.bots.length'),0);assert.equal(h.run('providerCatalog.length'),0);
  assert.doesNotMatch(h.doc.querySelector('#app').textContent,/sign-in session changed|old-private/);
});
