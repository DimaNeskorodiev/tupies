import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { createStudioServer } from '../server.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check){for(let i=0;i<800;i++){const result=check();if(result)return result;await delay(5);}throw new Error('Browser control fixture timed out.');}
const identity=run=>({runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation});
const call={id:'browser_help',name:'browser_handoff',arguments:{reason:'Please sign in and complete the human verification.'}};
function fakeSession(){return {botId:'bot_atlas',retained:false,actions:[],revision:0,async ownerView(){return {imageBase64:'cGl4ZWxz',url:'https://example.org/signin?secret=owner-only',title:'Sign in',width:1280,height:900,tabId:'tab_one',tabs:[{id:'tab_one',title:'Sign in',url:'https://example.org/signin'}],identity:`document_${this.revision}`};},async ownerAction(action,expected){assert.equal(expected,`document_${this.revision}`);this.actions.push(action);this.revision++;},async close(){}};}
function installBrowserFixture(engine,store,session){
  engine.browsers.available=()=>true;
  engine.browsers.setRetained=async(runId,botId,keep)=>{assert.equal(engine.browsers.sessions.get(runId),session);assert.equal(botId,'bot_atlas');session.retained=keep;};
  return (request,count)=>{
    if(count===1){engine.browsers.sessions.set(store.state.runs.bot_atlas.id,session);return {text:'',toolCalls:[call]};}
    return {text:'Browser assistance finished.',toolCalls:[]};
  };
}
async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-browser-control-')),store=await new Store(directory).init(),requests=[],session=fakeSession();
  await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',model:'fixture'});Object.assign(state.bots[0],{connectionId:'fixture',tools:['browser'],approvalPolicy:'strict'});});
  let complete;const engine=new NativeEngine(store,{runTimeout:10_000,...options,providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length);}}});
  await engine.recover();complete=installBrowserFixture(engine,store,session);
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,session,requests,directory};
}
async function handoff(f){await f.engine.start('bot_atlas','Help me use my account.');return structuredClone(await waitFor(()=>f.store.state.runs.bot_atlas?.status==='waiting_for_input' && f.store.state.runs.bot_atlas));}

test('browser handoff pauses the task and owner inputs and pixels never enter durable state or model history',async t=>{
  const f=await fixture(t,{runTimeout:150}),waiting=await handoff(f),input=identity(waiting);
  assert.equal(waiting.pending_controls[0].kind,'browser');assert.ok(f.requests[0].tools.some(tool=>tool.name==='browser_handoff'));
  await delay(250);assert.equal(f.store.state.runs.bot_atlas.status,'waiting_for_input');
  const view=await f.engine.browserControl.view('bot_atlas',input);
  assert.equal(view.retained,false);assert.equal(view.imageBase64,'cGl4ZWxz');assert.equal(view.identity,undefined);
  const secret='owner-password-never-in-model-2026';
  const after=await f.engine.browserControl.action('bot_atlas',{...input,viewId:view.viewId,action:{type:'text',text:secret}});
  assert.notEqual(after.viewId,view.viewId);assert.equal(f.session.actions[0].text,secret);
  await f.engine.browserControl.resume('bot_atlas',{...input,keepSession:true});
  await waitFor(()=>f.store.state.runs.bot_atlas.status==='completed');
  assert.equal(f.session.retained,true);
  const persisted=await fs.readFile(f.store.file,'utf8'),history=JSON.stringify(f.requests);
  for(const value of [secret,'cGl4ZWxz','secret=owner-only']){assert.ok(!persisted.includes(value));assert.ok(!history.includes(value));}
  const output=JSON.parse(f.requests[1].messages.at(-1).content);assert.equal(output.resumed,true);assert.equal(output.skipped,false);assert.match(output.notice,/does not approve/);
});

test('browser controls require exact live identities, current view tokens, and one request at a time',async t=>{
  const f=await fixture(t),waiting=await handoff(f),input=identity(waiting);
  for(const wrong of [{runId:'old_run'},{remoteRunId:'old_run'},{request_id:'old_prompt'},{execution_generation:0}])await assert.rejects(f.engine.browserControl.view('bot_atlas',{...input,...wrong}),/older|changed/);
  await assert.rejects(f.engine.browserControl.view('bot_atlas',{...input,password:'never'}),/unknown fields/);
  const view=await f.engine.browserControl.view('bot_atlas',input);
  await assert.rejects(f.engine.browserControl.action('bot_atlas',{...input,viewId:'old_view',action:{type:'click',x:5,y:5}}),/view changed/);
  let release;f.session.ownerAction=async()=>new Promise(resolve=>{release=resolve;});
  const action=f.engine.browserControl.action('bot_atlas',{...input,viewId:view.viewId,action:{type:'click',x:5,y:5}});
  await waitFor(()=>release);
  await assert.rejects(f.engine.browserControl.resume('bot_atlas',{...input,keepSession:false}),/in progress/);
  await assert.rejects(f.engine.browserControl.view('bot_atlas',input),/in progress/);
  release();await action;
  await assert.rejects(f.engine.browserControl.action('bot_atlas',{...input,viewId:view.viewId,action:{type:'click',x:5,y:5}}),/view changed/);
  await f.engine.browserControl.resume('bot_atlas',{...input,keepSession:false,skip:true});
  await waitFor(()=>f.store.state.runs.bot_atlas.status==='completed');
  assert.equal(JSON.parse(f.requests[1].messages.at(-1).content).skipped,true);
  await assert.rejects(f.engine.browserControl.resume('bot_atlas',{...input,keepSession:false}),/older or inactive/);
});

test('Stop and topology changes invalidate pending browser access and do not replay owner actions',async t=>{
  let changing=false;const f=await fixture(t,{admissionPaused:()=>changing}),waiting=await handoff(f),input=identity(waiting);
  changing=true;await assert.rejects(f.engine.browserControl.view('bot_atlas',input),/ownership is changing/);changing=false;
  const view=await f.engine.browserControl.view('bot_atlas',input);
  let release;f.session.ownerAction=async()=>new Promise(resolve=>{release=resolve;});
  const action=f.engine.browserControl.action('bot_atlas',{...input,viewId:view.viewId,action:{type:'key',key:'Enter'}});void action.catch(()=>{});
  await waitFor(()=>release);await f.engine.control('bot_atlas','stop',input);release();
  await assert.rejects(action,/older|cancelled|changed/);
  await waitFor(()=>f.store.state.runs.bot_atlas.status==='cancelled');
  await assert.rejects(f.engine.browserControl.view('bot_atlas',input),/older or inactive/);assert.equal(f.requests.length,1);
});

test('browser assistance is not offered to unattended lanes, expires finitely, and never claims sign-in',async t=>{
  const f=await fixture(t,{browserHandoffTimeoutMs:100}),waiting=await handoff(f);
  const context={bot:f.store.state.bots[0],source:'routine',lane:'routine:fixture',inference:{images:false}};
  assert.ok(!f.engine.toolDefinitions(context).some(tool=>tool.name==='browser_handoff'));
  await waitFor(()=>f.store.state.runs.bot_atlas.status==='completed');
  const result=JSON.parse(f.requests[1].messages.at(-1).content);assert.match(result.error,/expired/);assert.equal(result.resumed,undefined);
  await assert.rejects(f.engine.browserControl.view('bot_atlas',identity(waiting)),/older or inactive/);
});

test('a forged handoff tool from a routine is refused without exposing a browser control',async t=>{
  const f=await fixture(t);
  await f.store.mutate(state=>state.routines.push({id:'routine_browser',name:'Browser fixture',botId:'bot_atlas',prompt:'Inspect a public page.',intervalMinutes:60,enabled:false}));
  await f.engine.runRoutine('routine_browser');await waitFor(()=>f.store.state.runs.bot_atlas.status==='completed');
  const result=JSON.parse(f.requests[1].messages.at(-1).content);assert.match(result.error,/only in a direct owner/);assert.equal(result.errorCode,'denied');
  assert.ok(!f.requests[0].tools.some(tool=>tool.name==='browser_handoff'));assert.equal(f.engine.browserControl.pending.size,0);
});

test('restart interrupts a pending browser handoff without restoring a rendezvous or replaying actions',async t=>{
  const f=await fixture(t),waiting=await handoff(f);
  const restarted=new NativeEngine(f.store,{providers:{async complete(){throw new Error('A restart must not run the model.');}}});
  try {
    await restarted.recover();assert.equal(f.store.state.runs.bot_atlas.status,'interrupted');assert.equal(f.store.state.runs.bot_atlas.pending_controls,undefined);
    await assert.rejects(restarted.browserControl.view('bot_atlas',identity(waiting)),/older or inactive/);assert.equal(restarted.browserControl.pending.size,0);assert.equal(f.session.actions.length,0);
  } finally {await restarted.close();}
});

test('owner browser errors cannot echo typed secrets into API errors or persistent events',async t=>{
  const f=await fixture(t),waiting=await handoff(f),input=identity(waiting),view=await f.engine.browserControl.view('bot_atlas',input);
  const secret='private-otp-573442';f.session.ownerAction=async()=>{throw new Error(`DevTools rejected ${secret}`);};
  await assert.rejects(f.engine.browserControl.action('bot_atlas',{...input,viewId:view.viewId,action:{type:'text',text:secret}}),error=>error instanceof HttpError && !error.message.includes(secret) && /could not be confirmed/.test(error.message));
  await assert.rejects(f.engine.browserControl.action('bot_atlas',{...input,viewId:view.viewId,action:{type:'text',text:secret}}),/view changed/);
  assert.ok(!JSON.stringify(f.store.state).includes(secret));await f.engine.browserControl.resume('bot_atlas',{...input,keepSession:false,skip:true});
});

test('model browser actions require exact approval, recheck the target, and never replay an uncertain action',async t=>{
  for(const scenario of ['denied','stale','unknown','success','stopped','restarted'])await t.test(scenario,async t=>{
    const f=await fixture(t),session=f.session,requests=[],action={id:'fill_field',name:'browser_fill',arguments:{ref:'e1',revision:1,text:'Approved public search'}};
    let fingerprint='page-one',fills=0;
    Object.assign(session,{dispatchCount:0,redact:value=>value,async actionIdentity(){return {fingerprint,review:{label:'Search',url:'https://example.org/search'}};},async fill(){fills++;this.dispatchCount++;if(scenario==='unknown')throw new HttpError(502,'Browser transport disconnected.');},async outline(){return {url:'https://example.org/search',title:'Search',outline:'Search results',revision:2,references:0,truncated:false};}});
    f.engine.providers.complete=async(connection,request)=>{
      requests.push(request);if(requests.length===1){f.engine.browsers.sessions.set(f.store.state.runs.bot_atlas.id,session);return {text:'',toolCalls:[action]};}
      if(scenario==='unknown' && requests.length===2)return {text:'',toolCalls:[{...action,id:'repeat_fill'}]};
      return {text:'Checked the browser result.',toolCalls:[]};
    };
    await f.engine.start('bot_atlas','Search the approved text.');
    const waiting=structuredClone(await waitFor(()=>f.store.state.runs.bot_atlas?.status==='waiting_for_approval' && f.store.state.runs.bot_atlas));
    assert.equal(fills,0);assert.equal(waiting.pending_controls[0].tool,'browser_fill');assert.equal(waiting.pending_controls[0].review.label,'Search');
    assert.deepEqual(waiting.pending_controls[0].arguments,action.arguments,'engine review metadata must not change the original approved arguments');
    if(scenario==='stopped' || scenario==='restarted') {
      if(scenario==='stopped'){await f.engine.control('bot_atlas','stop',identity(waiting));await waitFor(()=>f.store.state.runs.bot_atlas.status==='cancelled');}
      else {const restarted=new NativeEngine(f.store,{providers:{async complete(){throw new Error('No replay.');}}});try{await restarted.recover();}finally{await restarted.close();}}
      const record=f.store.state.runs.bot_atlas.workRecords.find(record=>record.callId===action.id);assert.equal(record.outcome,'not_started');assert.equal(record.status,'interrupted');assert.equal(fills,0);return;
    }
    await assert.rejects(f.engine.control('bot_atlas','approval',{...identity(waiting),request_id:'older_prompt',choice:'once'}),/prompt changed/);
    if(scenario==='stale')fingerprint='page-two';
    await f.engine.control('bot_atlas','approval',{...identity(waiting),choice:scenario==='denied'?'deny':'once'});
    await waitFor(()=>f.store.state.runs.bot_atlas.status==='completed');
    const result=JSON.parse(requests[1].messages.at(-1).content);
    if(scenario==='denied'){assert.equal(result.errorCode,'denied');assert.equal(fills,0);}
    if(scenario==='stale'){assert.equal(result.errorCode,'stale_state');assert.equal(result.outcome,'not_started');assert.equal(fills,0);}
    if(scenario==='unknown'){assert.equal(result.outcome,'unknown');assert.equal(result.retryable,false);assert.equal(fills,1);assert.equal(JSON.parse(requests[2].messages.at(-1).content).errorCode,'repeated_failure');}
    if(scenario==='success'){assert.equal(result.outline,'Search results');assert.equal(fills,1);}
  });
});

test('reusing a retained or owner-operated session discloses output visibility and still needs owner approval',async t=>{
  for(const scenario of [{source:'telegram',lane:'telegram:fixture:guest',expected:/third-party Telegram/,retained:true},{source:'delegation',lane:'chat',expected:/requesting teammate/,retained:true},{source:'routine',lane:'routine:fixture',expected:/configured delivery/,retained:true},{source:'chat',lane:'chat',expected:/owner’s direct/,retained:false,ownerTouched:true}])await t.test(scenario.source,async t=>{
    const f=await fixture(t),session=f.session,requests=[];Object.assign(session,{retained:scenario.retained,ownerTouched:scenario.ownerTouched,redact:value=>value,async actionIdentity(){return {fingerprint:'page',review:{url:'https://example.org/'}};}});
    f.engine.providers.complete=async(connection,request)=>{requests.push(request);if(requests.length===1){f.engine.browsers.sessions.set(f.store.state.runs.bot_atlas.id,session);return {text:'',toolCalls:[{id:'open_saved',name:'browser_open',arguments:{url:'https://example.org/'}}]};}return {text:'The saved account was not accessed.',toolCalls:[]};};
    await f.engine.start('bot_atlas','Inspect the page.',{source:scenario.source,lane:scenario.lane});
    const waiting=structuredClone(await waitFor(()=>f.store.state.runs.bot_atlas?.status==='waiting_for_approval' && f.store.state.runs.bot_atlas)),review=waiting.pending_controls[0].review;
    assert.equal(review.source,scenario.source);assert.match(review.outputVisibility,scenario.expected);assert.match(waiting.pending_controls[0].preview,scenario.expected);assert.equal(waiting.pending_controls[0].arguments.review,undefined);
    await f.engine.control('bot_atlas','approval',{...identity(waiting),choice:'deny'});await waitFor(()=>f.store.state.runs.bot_atlas.status==='completed');assert.equal(JSON.parse(requests[1].messages.at(-1).content).errorCode,'denied');
  });
});

test('browser endpoints require authentication, CSRF and matching run identity and return no-store views',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-browser-control-api-')),session=fakeSession();let complete,count=0;
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers:{async complete(connection,request){return complete(request,++count);}}}),{url}=await app.listen(0);
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  let cookie='',csrf='';
  const request=async(endpoint,data,{security=true,authenticated=true}={})=>{const res=await fetch(url+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Origin:url,...(authenticated&&cookie?{Cookie:cookie}:{}),...(security?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify(data)});return {res,body:await res.json()};};
  const setup=await request('/api/setup',{token:app.bootstrapToken,password:'browser-fixture-password'});cookie=setup.res.headers.get('set-cookie').split(';')[0];csrf=setup.body.csrf;
  await app.store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',model:'fixture'});Object.assign(state.bots[0],{connectionId:'fixture',tools:['browser']});});
  complete=installBrowserFixture(app.runtime,app.store,session);
  const waiting=await handoff({engine:app.runtime,store:app.store}),input=identity(waiting),endpoint='/api/bots/bot_atlas/browser/view';
  assert.equal((await request(endpoint,input,{authenticated:false})).res.status,401);
  assert.equal((await request(endpoint,input,{security:false})).res.status,403);
  assert.equal((await request(endpoint,{...input,execution_generation:0})).res.status,409);
  const view=await request(endpoint,input);assert.equal(view.res.status,200);assert.equal(view.res.headers.get('cache-control'),'no-store');assert.equal(view.body.imageBase64,'cGl4ZWxz');
  assert.equal((await request('/api/bots/bot_atlas/browser/resume',{...input,keepSession:false,skip:true})).res.status,200);
});
