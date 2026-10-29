import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const reply=(status,data)=>({status,ok:status>=200&&status<300,async json(){return data;}});
const mismatch=()=>reply(403,{error:'Security token expired. Reload and try again.',code:'csrf_mismatch'});

// Execute api() itself. The fetch queue models responses before/after the server's
// pre-dispatch CSRF guard; no real session, network request or credential is used.
function harness(responses) {
  const calls=[];
  const document={hidden:false,activeElement:null,addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];}};
  const ctx=vm.createContext({document,window:{addEventListener(){}},location:{hash:'#/integrations'},URL,crypto:webcrypto,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},fetch:async(path,options={})=>{
    const call={path,method:options.method||'GET',headers:{...options.headers},body:options.body,credentials:options.credentials};calls.push(call);
    const response=responses[calls.length-1];if(!response)throw new Error('Unexpected additional fetch.');
    if(response instanceof Error)throw response;
    return typeof response==='function'?response(call):response;
  }});
  vm.runInContext(source,ctx,{filename:'app.js'});
  vm.runInContext("auth={authenticated:true,csrf:'old-tab-token'};let authRenders=0;renderAuth=()=>{authRenders++};",ctx);
  return {ctx,calls,run:code=>vm.runInContext(code,ctx)};
}

test('an explicit CSRF mismatch refreshes auth and retries the original JSON mutation once',async()=>{
  let saves=0;
  const h=harness([mismatch(),reply(200,{authenticated:true,csrf:'fresh-shared-token'}),()=>{saves++;return reply(201,{id:'integration_saved'});}]);
  const payload={name:'QA integration',tools:[{name:'echo',arguments:{text:'Українська "quotation"\nnext line'}}]};h.ctx.payload=payload;
  const result=await h.run("api('/api/integrations',{method:'POST',headers:{Accept:'application/json','X-Test-Header':'preserved'},body:payload})");
  assert.equal(result.id,'integration_saved');assert.equal(saves,1);
  assert.deepEqual(h.calls.map(c=>[c.path,c.method]),[['/api/integrations','POST'],['/api/auth','GET'],['/api/integrations','POST']]);
  const [first,,retry]=h.calls;
  assert.equal(first.headers['X-CSRF-Token'],'old-tab-token');assert.equal(retry.headers['X-CSRF-Token'],'fresh-shared-token');
  assert.equal(retry.body,first.body);assert.deepEqual(JSON.parse(retry.body),payload);
  assert.equal(retry.headers['Content-Type'],'application/json');assert.equal(retry.headers['X-Test-Header'],'preserved');
  assert.equal(first.credentials,'same-origin');assert.equal(retry.credentials,'same-origin');
  assert.equal(h.run('auth.csrf'),'fresh-shared-token');assert.equal(h.run('authRenders'),0);
});

test('a second CSRF rejection stops after one refresh and one retry',async()=>{
  const h=harness([mismatch(),reply(200,{authenticated:true,csrf:'new-token'}),mismatch()]);
  await assert.rejects(h.run("api('/api/bots',{method:'POST',body:{name:'QA'}})"),/Security token expired/);
  assert.equal(h.calls.length,3);assert.equal(h.calls.filter(c=>c.path==='/api/auth').length,1);
  assert.equal(h.calls.filter(c=>c.path==='/api/bots').length,2);
});

test('a generic 403 never refreshes auth or replays a mutation',async()=>{
  const h=harness([reply(403,{error:'This action is not allowed.',code:'permission_denied'})]);
  await assert.rejects(h.run("api('/api/bots/bot_qa',{method:'PATCH',body:{enabled:false}})"),/not allowed/);
  assert.equal(h.calls.length,1);assert.equal(h.run('auth.csrf'),'old-tab-token');
});

test('an expired session returns to sign-in without retrying the rejected mutation',async()=>{
  const h=harness([reply(401,{error:'Sign in to continue.'}),reply(200,{setupRequired:false,authenticated:false,csrf:null,passwordSignIn:false})]);
  await assert.rejects(h.run("api('/api/integrations',{method:'POST',body:{name:'QA'}})"),/Sign in/);
  // Only the sign-in policy is re-read (an internet address may accept paired apps only); the mutation is never replayed.
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls.map(c=>[c.path,c.method]),[['/api/integrations','POST'],['/api/auth','GET']]);
  assert.equal(h.run('auth.passwordSignIn'),false);assert.equal(h.run('authRenders'),2);
});

test('network failures and ambiguous service errors never replay mutations',async()=>{
  for(const response of [new Error('Connection closed after sending request.'),reply(500,{error:'Internal service error.'}),{status:403,ok:false,async json(){throw new Error('Not JSON.');}}]) {
    const h=harness([response]);
    await assert.rejects(h.run("api('/api/integrations',{method:'POST',body:{name:'QA'}})"));
    assert.equal(h.calls.length,1);
  }
});

test('read requests do not invoke the mutation-only CSRF recovery path',async()=>{
  const h=harness([mismatch()]);
  await assert.rejects(h.run("api('/api/state')"),/Security token expired/);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].method,'GET');
});

test('an unavailable or unsigned-in auth refresh never retries the original action',async()=>{
  for(const refresh of [reply(200,{authenticated:false,csrf:null}),reply(200,{authenticated:true}),reply(401,{error:'Sign in to continue.'}),new Error('Auth refresh network failure.')]) {
    const h=harness([mismatch(),refresh]);
    await assert.rejects(h.run("api('/api/integrations',{method:'POST',body:{name:'QA'}})"));
    assert.equal(h.calls.length,2);assert.equal(h.calls.filter(c=>c.path==='/api/integrations').length,1);
  }
});

test('a failed recovery retry is never automatically replayed again',async()=>{
  const h=harness([mismatch(),reply(200,{authenticated:true,csrf:'fresh-token'}),new Error('Ambiguous retry connection failure.')]);
  await assert.rejects(h.run("api('/api/integrations',{method:'POST',body:{name:'QA'}})"),/Ambiguous retry/);
  assert.equal(h.calls.length,3);assert.equal(h.calls.filter(c=>c.path==='/api/auth').length,1);
});

for(const room of [false,true])test(`${room?'room':'bot'} CSRF recovery cannot replay an old message after sign-in changes`,async()=>{
  let release;const probe=new Promise(resolve=>{release=resolve;}),h=harness([mismatch(),()=>probe,reply(202,{accepted:true})]);
  const sending=h.run(`${room?'sendRoomMessage':'sendMessage'}('target_qa',{text:'Old session task.'})`),rejected=assert.rejects(sending,/sign-in session changed/);await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.length,2);
  h.run("sendSessionGeneration++;pendingSends.clear();auth={authenticated:true,csrf:'new-session'};");release(reply(200,{authenticated:true,csrf:'new-session'}));await rejected;
  assert.equal(h.calls.length,2,'The original task must not be dispatched with the new session token.');assert.equal(h.run('auth.csrf'),'new-session');
});

test('a late old-session 401 cannot sign out a newly authenticated session',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;}),h=harness([()=>pending]),loading=h.run("api('/api/state')"),rejected=assert.rejects(loading,/sign-in session changed/);
  h.run("sendSessionGeneration++;auth={authenticated:true,csrf:'new-session'};");release(reply(401,{error:'Old session expired'}));await rejected;assert.equal(h.run('auth.authenticated'),true);assert.equal(h.run('authRenders'),0);assert.equal(h.calls.length,1);
});

test('an expired-session policy lookup cannot overwrite a later sign-in',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;}),h=harness([reply(401,{error:'Sign in to continue.'}),()=>pending]);
  await assert.rejects(h.run("api('/api/state')"),/Sign in/);h.run("sendSessionGeneration++;auth={authenticated:true,csrf:'new-session'};");release(reply(200,{authenticated:false,csrf:null}));await new Promise(resolve=>setImmediate(resolve));assert.equal(h.run('auth.authenticated'),true);assert.equal(h.run('auth.csrf'),'new-session');assert.equal(h.run('authRenders'),1);
});
