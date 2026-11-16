import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { createStudioServer } from '../server.mjs';
import { EventEmitter } from 'node:events';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check){for(let i=0;i<800;i++){const result=check();if(result)return result;await delay(5);}throw new Error('Browser control fixture timed out.');}
const identity=run=>({runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation});
const call={id:'browser_help',name:'browser_handoff',arguments:{reason:'Please sign in and complete the human verification.'}};
/** A BrowserSession stand-in with a DevTools pipe that answers what the owner stream asks. `hang` holds input until the per-command timeout; `fail` rejects input with an echo. */
function fakeSession(){
  const session={botId:'bot_atlas',retained:false,tabId:'tab_one',session:'page_one',dialog:null,allowPrivate:false,actions:[],ownerSecrets:new Set(),ownerTouched:false,hang:false,fail:null,
    keepPrivate(value){if(value)this.ownerSecrets.add(value);},
    redact(value){for(const secret of this.ownerSecrets)value=String(value).split(secret).join('[private]');return value;},
    async switchTab(){},async close(){},
    pipe:{handlers:new Set(),closed:false,async send(method,params={},sessionId,timeout=30_000){
      if(/^(?:Input\.|Page\.navigate)/.test(method)){
        session.actions.push({method,params});
        if(session.fail)throw new Error(`DevTools rejected ${session.fail}`);
        if(session.hang)return new Promise((resolve,reject)=>setTimeout(()=>reject(Object.assign(new HttpError(504,'The browser did not answer in time.'),{status:504})),timeout));
        return {};
      }
      if(method==='Target.getTargets')return {targetInfos:[{type:'page',targetId:'tab_one',title:'Sign in',url:'https://example.org/signin?secret=owner-only'}]};
      if(method==='Page.captureScreenshot')return {data:'cGl4ZWxz'};
      if(method==='Page.getNavigationHistory')return {currentIndex:0,entries:[{id:1}]};
      if(method==='Page.createIsolatedWorld')return {executionContextId:1};
      if(method==='Runtime.evaluate')return {result:{value:{editable:true,kind:'password',id:1,private:true,hasFocus:true,value:''}}};
      return {};
    }}};
  return session;
}
function recorder(){
  const res=new EventEmitter();let buffer='';Object.assign(res,{events:[],writableEnded:false,destroyed:false});
  res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};res.flushHeaders=()=>{};
  res.write=chunk=>{buffer+=chunk;for(let end=buffer.indexOf('\n\n');end>=0;end=buffer.indexOf('\n\n')){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!block.startsWith(':'))res.events.push({name:/^event: (.*)$/m.exec(block)[1],data:JSON.parse(/^data: (.*)$/m.exec(block)[1])});}return true;};
  res.end=()=>{res.writableEnded=true;res.emit('close');};
  res.find=name=>res.events.find(event=>event.name===name)?.data;
  return res;
}
const VIEWPORT={width:390,height:700,dpr:2,touch:true};
async function openStream(f,input){const res=recorder(),done=f.engine.browserControl.stream('bot_atlas',{...input,viewport:VIEWPORT},{res});void done.catch(()=>{});const ready=await waitFor(()=>res.find('ready'));return {res,done,ready};}
const keys=text=>[...text].flatMap(key=>[{t:'key',kind:'down',key},{t:'key',kind:'up',key}]);
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
  const f=await fixture(t,{runTimeout:1500}),waiting=await handoff(f),input=identity(waiting);
  assert.equal(waiting.pending_controls[0].kind,'browser');assert.ok(f.requests[0].tools.find(tool=>tool.name==='tools_load').parameters.properties.groups.items.enum.includes('browser'));assert.ok(f.engine.permittedTools({bot:f.store.state.bots[0],source:'chat',lane:'chat',runId:waiting.id,inference:{images:false}}).some(tool=>tool.name==='browser_handoff'));
  // Longer than the 1.5 s runtime limit (room for cold release runners): waiting for the owner does not count.
  await delay(1800);assert.equal(f.store.state.runs.bot_atlas.status,'waiting_for_input');
  const stream=await openStream(f,input);
  assert.equal(stream.ready.retained,false);assert.equal(stream.ready.width,390);assert.equal(stream.ready.tabId,'tab_one');assert.equal(stream.res.status,200);assert.equal(stream.res.headers['Content-Type'],'text/event-stream');
  assert.equal((await waitFor(()=>stream.res.find('frame'))).jpeg,'cGl4ZWxz');
  const secret='owner-password-never-in-model-2026',{streamId}=stream.ready;
  assert.deepEqual(await f.engine.browserControl.input('bot_atlas',{...input,streamId,seq:1,events:keys(secret.slice(0,20))}),{ok:true,seq:1,dropped:0});
  assert.deepEqual(await f.engine.browserControl.input('bot_atlas',{...input,streamId,seq:2,events:keys(secret.slice(20))}),{ok:true,seq:2,dropped:0});
  assert.ok(f.session.actions.some(action=>action.params.text==='o'),'keys carry their text');assert.equal(f.session.ownerTouched,true);
  await f.engine.browserControl.resume('bot_atlas',{...input,keepSession:true});
  await waitFor(()=>stream.res.find('end'));assert.equal(stream.res.find('end').reason,'resumed');await stream.done;
  await waitFor(()=>f.store.state.runs.bot_atlas.status==='completed');
  assert.equal(f.session.retained,true);assert.ok(f.session.ownerSecrets.has(secret),'typed text is registered for redaction');
  const persisted=await fs.readFile(f.store.file,'utf8'),history=JSON.stringify(f.requests);
  for(const value of [secret,'cGl4ZWxz','secret=owner-only']){assert.ok(!persisted.includes(value));assert.ok(!history.includes(value));}
  const output=JSON.parse(f.requests[1].messages.at(-1).content);assert.equal(output.resumed,true);assert.equal(output.skipped,false);assert.match(output.notice,/does not approve/);
});

test('browser streams and input require exact live identities, the current lease and a new sequence number, and queue in order',async t=>{
  const f=await fixture(t),waiting=await handoff(f),input=identity(waiting);
  for(const wrong of [{runId:'old_run'},{remoteRunId:'old_run'},{request_id:'old_prompt'},{execution_generation:0}]){const res=recorder();await assert.rejects(f.engine.browserControl.stream('bot_atlas',{...input,...wrong,viewport:VIEWPORT},{res}),/older|changed/);assert.equal(res.status,undefined,'refused before streaming');}
  await assert.rejects(f.engine.browserControl.stream('bot_atlas',{...input,password:'never',viewport:VIEWPORT},{res:recorder()}),/unknown fields/);
  await assert.rejects(f.engine.browserControl.input('bot_atlas',{...input,streamId:'stream_none',seq:1,events:[]}),error=>error.status===409 && /Reopen/.test(error.message));
  // A viewer that goes away (panel closed, app backgrounded) stops the screencast but never ends the handoff.
  const gone=await openStream(f,input);gone.res.end();await gone.done;
  await waitFor(()=>f.session.actions.length>=0 && f.store.state.runs.bot_atlas.status==='waiting_for_input');
  await assert.rejects(f.engine.browserControl.input('bot_atlas',{...input,streamId:gone.ready.streamId,seq:1,events:[]}),error=>error.status===409);
  const first=await openStream(f,input),second=await openStream(f,input);
  await waitFor(()=>first.res.find('end'));assert.equal(first.res.find('end').reason,'replaced');await first.done;
  await assert.rejects(f.engine.browserControl.input('bot_atlas',{...input,streamId:first.ready.streamId,seq:1,events:[]}),error=>error.status===409);
  const send=(seq,events)=>f.engine.browserControl.input('bot_atlas',{...input,streamId:second.ready.streamId,seq,events});
  await assert.rejects(send(1,[{t:'script',code:'1'}]),error=>error.status===400);
  await assert.rejects(send(1,[{t:'pointer',kind:'down',x:5,y:5}]),/tabId and nav/);
  await assert.rejects(send(1,Array.from({length:65},()=>({t:'text',text:'a'}))),error=>error.status===413);
  assert.deepEqual(await send(5,[{t:'pointer',kind:'down',x:5,y:5,button:0,buttons:1,clickCount:1,tabId:'tab_one',nav:0},{t:'pointer',kind:'up',x:5,y:5}]),{ok:true,seq:5,dropped:0});
  await assert.rejects(send(5,[{t:'text',text:'again'}]),/already received/);await assert.rejects(send(4,[{t:'text',text:'again'}]),/already received/);
  assert.equal(f.session.actions.filter(action=>action.params.text==='again').length,0,'input is never replayed');
  assert.deepEqual(await send(6,[{t:'pointer',kind:'down',x:5,y:5,button:0,buttons:1,clickCount:1,tabId:'tab_one',nav:7},{t:'pointer',kind:'move',x:9,y:9,buttons:1},{t:'pointer',kind:'up',x:9,y:9}]),{ok:true,seq:6,dropped:3},'a press aimed at an older page is dropped whole');
  // A stalled browser queues the next batch instead of refusing it, and never blocks Resume.
  f.session.hang=true;const before=f.session.actions.length;
  const stalled=send(7,[{t:'text',text:'first-batch'}]),queued=send(8,[{t:'text',text:'second-batch'}]);
  await waitFor(()=>f.session.actions.length>before);
  const started=Date.now();await f.engine.browserControl.resume('bot_atlas',{...input,keepSession:false,skip:true});assert.ok(Date.now()-started<500,`resume took ${Date.now()-started} ms`);
  await waitFor(()=>second.res.find('end'));assert.equal(second.res.find('end').reason,'resumed');
  assert.deepEqual(await stalled,{ok:true,seq:7,dropped:0});assert.deepEqual(await queued,{ok:true,seq:8,dropped:1},'a batch after Resume is not dispatched');
  assert.deepEqual(f.session.actions.slice(before).map(action=>action.params.text),['first-batch']);
  await waitFor(()=>f.store.state.runs.bot_atlas.status==='completed');
  assert.equal(JSON.parse(f.requests[1].messages.at(-1).content).skipped,true);
  await assert.rejects(f.engine.browserControl.resume('bot_atlas',{...input,keepSession:false}),/older or inactive/);
});

test('Stop and topology changes end the stream, invalidate access and do not replay owner input',async t=>{
  let changing=false;const f=await fixture(t,{admissionPaused:()=>changing}),waiting=await handoff(f),input=identity(waiting);
  changing=true;await assert.rejects(f.engine.browserControl.stream('bot_atlas',{...input,viewport:VIEWPORT},{res:recorder()}),/ownership is changing/);changing=false;
  const stream=await openStream(f,input);f.session.hang=true;
  const pending=f.engine.browserControl.input('bot_atlas',{...input,streamId:stream.ready.streamId,seq:1,events:[{t:'key',kind:'down',key:'Enter'},{t:'key',kind:'up',key:'Enter'}]});void pending.catch(()=>{});
  await waitFor(()=>f.session.actions.some(action=>action.method==='Input.dispatchKeyEvent'));await f.engine.control('bot_atlas','stop',input);
  await waitFor(()=>stream.res.find('end'));assert.equal(stream.res.find('end').reason,'cancelled');
  const sent=f.session.actions.filter(action=>action.method.startsWith('Input.')).length;await pending.catch(()=>{});
  assert.equal(f.session.actions.filter(action=>action.method.startsWith('Input.')).length,sent,'the rest of the batch is not sent after Stop');
  await waitFor(()=>f.store.state.runs.bot_atlas.status==='cancelled');
  await assert.rejects(f.engine.browserControl.stream('bot_atlas',{...input,viewport:VIEWPORT},{res:recorder()}),/older or inactive/);assert.equal(f.requests.length,1);
});

test('browser assistance is not offered to unattended lanes, expires after owner idleness, and never claims sign-in',async t=>{
  const f=await fixture(t,{browserHandoffTimeoutMs:800}),waiting=await handoff(f),input=identity(waiting);
  const context={bot:f.store.state.bots[0],source:'routine',lane:'routine:fixture',inference:{images:false}};
  assert.ok(!f.engine.permittedTools(context).some(tool=>tool.name==='browser_handoff'));
  const stream=await openStream(f,input);assert.equal(stream.ready.idleMs,800);
  for(let seq=1;seq<=8;seq++){await delay(150);await f.engine.browserControl.input('bot_atlas',{...input,streamId:stream.ready.streamId,seq,events:[{t:'wheel',x:5,y:5,dy:10}]});}
  assert.equal(f.store.state.runs.bot_atlas.status,'waiting_for_input','owner input keeps the handoff alive past the idle limit');
  await waitFor(()=>f.store.state.runs.bot_atlas.status==='completed');assert.equal(stream.res.find('end').reason,'expired');
  const result=JSON.parse(f.requests[1].messages.at(-1).content);assert.match(result.error,/expired/);assert.equal(result.resumed,undefined);
  await assert.rejects(f.engine.browserControl.stream('bot_atlas',{...identity(waiting),viewport:VIEWPORT},{res:recorder()}),/older or inactive/);
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
    await assert.rejects(restarted.browserControl.stream('bot_atlas',{...identity(waiting),viewport:VIEWPORT},{res:recorder()}),/older or inactive/);assert.equal(restarted.browserControl.pending.size,0);assert.equal(f.session.actions.length,0);
  } finally {await restarted.close();}
});

test('owner browser errors cannot echo typed secrets into API errors, responses or persistent events',async t=>{
  const f=await fixture(t),waiting=await handoff(f),input=identity(waiting),stream=await openStream(f,input);
  const secret='private-otp-573442';f.session.fail=secret;
  const result=await f.engine.browserControl.input('bot_atlas',{...input,streamId:stream.ready.streamId,seq:1,events:[{t:'text',text:secret}]});
  assert.ok(!JSON.stringify(result).includes(secret));assert.equal(result.ok,true);
  const control=f.engine.browserControl.pending.get(waiting.id).control,original=control.input.bind(control);
  control.input=async()=>{throw new Error(`DevTools rejected ${secret}`);};
  await assert.rejects(f.engine.browserControl.input('bot_atlas',{...input,streamId:stream.ready.streamId,seq:2,events:[{t:'text',text:secret}]}),error=>error instanceof HttpError && !error.message.includes(secret) && /could not be confirmed/.test(error.message));
  control.input=original;
  for(const event of stream.res.events)assert.ok(!JSON.stringify(event.data).includes(secret));
  assert.ok(!JSON.stringify(f.store.state).includes(secret));await f.engine.browserControl.resume('bot_atlas',{...input,keepSession:false,skip:true});
  await waitFor(()=>f.store.state.runs.bot_atlas.status==='completed');assert.ok(!JSON.stringify(f.store.state).includes(secret));
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

test('browser endpoints require authentication, CSRF and matching run identity and stream no-store SSE',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-browser-control-api-')),session=fakeSession();let complete,count=0;
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers:{async complete(connection,request){return complete(request,++count);}}}),{url}=await app.listen(0);
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  let cookie='',csrf='';
  const post=(endpoint,data,{security=true,authenticated=true}={})=>fetch(url+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Origin:url,...(authenticated&&cookie?{Cookie:cookie}:{}),...(security?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify(data)});
  const setup=await post('/api/setup',{token:app.bootstrapToken,password:'browser-fixture-password'});cookie=setup.headers.get('set-cookie').split(';')[0];csrf=(await setup.json()).csrf;
  await app.store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',model:'fixture'});Object.assign(state.bots[0],{connectionId:'fixture',tools:['browser']});});
  complete=installBrowserFixture(app.runtime,app.store,session);
  const waiting=await handoff({engine:app.runtime,store:app.store}),input=identity(waiting),endpoint='/api/bots/bot_atlas/browser/stream',body={...input,viewport:VIEWPORT};
  assert.equal((await post(endpoint,body,{authenticated:false})).status,401);
  assert.equal((await post(endpoint,body,{security:false})).status,403);
  const stale=await post(endpoint,{...body,execution_generation:0});assert.equal(stale.status,409);assert.equal((await stale.json()).code,'handoff_ended');
  for(const old of ['view','action'])assert.equal((await post(`/api/bots/bot_atlas/browser/${old}`,input)).status,404);
  const response=await post(endpoint,body);assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'text/event-stream');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-accel-buffering'),'no');
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
  const read=async pattern=>{while(!pattern.test(text)){const {value,done}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});}return text;};
  const streamId=JSON.parse(/event: ready\ndata: (.*)\n/.exec(await read(/event: ready\n.*\n\n/))[1]).streamId;
  for(const name of ['input','resume']){
    const data=name==='input'?{...input,streamId,seq:1,events:[]}:{...input,keepSession:false,skip:true};
    assert.equal((await post(`/api/bots/bot_atlas/browser/${name}`,data,{authenticated:false})).status,401,`${name} needs a sign-in`);
    assert.equal((await post(`/api/bots/bot_atlas/browser/${name}`,data,{security:false})).status,403,`${name} needs the CSRF token`);
    const foreign=await fetch(`${url}/api/bots/bot_atlas/browser/${name}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://attacker.example',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify(data)});
    assert.equal(foreign.status,403,`${name} refuses another origin`);
  }
  assert.equal(app.store.state.runs.bot_atlas.status,'waiting_for_input','refused requests change nothing');
  const sent=await post('/api/bots/bot_atlas/browser/input',{...input,streamId,seq:1,events:[{t:'text',text:'hello there'}]});assert.equal(sent.status,200);assert.deepEqual(await sent.json(),{ok:true,seq:1,dropped:0});
  assert.equal((await post('/api/bots/bot_atlas/browser/input',{...input,streamId,seq:1,events:[]})).status,409);
  assert.equal((await post('/api/bots/bot_atlas/browser/resume',{...input,keepSession:false,skip:true})).status,200);
  assert.match(await read(/event: end\n/),/"reason":"resumed"/);
});

test('an open stream ends when its sign-in ends, its browser dies or its handoff ends, and reconnects after a temporary engine condition',async t=>{
  let changing=false,signedIn=true;const f=await fixture(t,{browserStreamWatchMs:40,admissionPaused:()=>changing}),waiting=await handoff(f),input=identity(waiting);
  const open=()=>{const res=recorder(),done=f.engine.browserControl.stream('bot_atlas',{...input,viewport:VIEWPORT},{res,authorized:()=>signedIn});void done.catch(()=>{});return {res,done};};
  // Signed out (cookie expired, device revoked): frames stop at once and the window shows a final state.
  let stream=open();await waitFor(()=>stream.res.find('frame'));signedIn=false;
  await waitFor(()=>stream.res.find('end'));assert.equal(stream.res.find('end').reason,'signedout');await stream.done;signedIn=true;
  // A temporary admission pause is retryable, not a final "task stopped".
  stream=open();await waitFor(()=>stream.res.find('ready'));changing=true;
  await waitFor(()=>stream.res.find('end'));assert.equal(stream.res.find('end').reason,'error');await stream.done;changing=false;
  assert.equal(f.store.state.runs.bot_atlas.status,'waiting_for_input');
  // A dead browser: the open stream ends as closed and a new one is refused as ended, without restarting the idle limit.
  stream=open();await waitFor(()=>stream.res.find('ready'));f.session.pipe.closed=true;
  await waitFor(()=>stream.res.find('end'));assert.equal(stream.res.find('end').reason,'closed');await stream.done;
  await assert.rejects(f.engine.browserControl.stream('bot_atlas',{...input,viewport:VIEWPORT},{res:recorder()}),error=>error.code==='handoff_ended');
  f.session.pipe.closed=false;await f.engine.browserControl.resume('bot_atlas',{...input,keepSession:false,skip:true});
  await waitFor(()=>f.store.state.runs.bot_atlas.status==='completed');
});

test('owner activity keeps a handoff open only up to its absolute limit',async t=>{
  const f=await fixture(t,{browserHandoffTimeoutMs:400,browserHandoffTotalMs:1200}),waiting=await handoff(f),input=identity(waiting),started=Date.now();
  const stream=await openStream(f,input);
  for(let seq=1;Date.now()-started<2500 && f.store.state.runs.bot_atlas.status==='waiting_for_input';seq++){await delay(150);await f.engine.browserControl.input('bot_atlas',{...input,streamId:stream.ready.streamId,seq,events:[{t:'wheel',x:5,y:5,dy:10}]}).catch(()=>{});}
  await waitFor(()=>f.store.state.runs.bot_atlas.status==='completed');
  const elapsed=Date.now()-started;assert.ok(elapsed>=1100 && elapsed<2400,`ended after ${elapsed} ms`);assert.equal(stream.res.find('end').reason,'expired');
  assert.match(JSON.parse(f.requests[1].messages.at(-1).content).error,/expired/);
});

test('signing out ends an open browser stream on the server even when the panel sends nothing',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-browser-signout-')),session=fakeSession();let complete,count=0;
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,browserStreamWatchMs:40,providers:{async complete(connection,request){return complete(request,++count);}}}),{url}=await app.listen(0);
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  let cookie='',csrf='';
  const post=(endpoint,data)=>fetch(url+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Origin:url,...(cookie?{Cookie:cookie}:{}),'X-CSRF-Token':csrf},body:JSON.stringify(data)});
  const setup=await post('/api/setup',{token:app.bootstrapToken,password:'browser-signout-password'});cookie=setup.headers.get('set-cookie').split(';')[0];csrf=(await setup.json()).csrf;
  await app.store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',model:'fixture'});Object.assign(state.bots[0],{connectionId:'fixture',tools:['browser']});});
  complete=installBrowserFixture(app.runtime,app.store,session);
  const waiting=await handoff({engine:app.runtime,store:app.store}),input=identity(waiting);
  const response=await post('/api/bots/bot_atlas/browser/stream',{...input,viewport:VIEWPORT});assert.equal(response.status,200);
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
  const read=async pattern=>{while(!pattern.test(text)){const {value,done}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});}return text;};
  await read(/event: ready\n/);
  assert.equal((await post('/api/logout',{})).status,200);
  assert.match(await read(/event: end\n.*\n\n/),/"reason":"signedout"/);
  assert.equal(app.store.state.runs.bot_atlas.status,'waiting_for_input','signing out does not end the handoff itself');
});
