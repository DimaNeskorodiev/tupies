import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { Providers, IDLE_STANDARD_MS, IDLE_REASONING_MS } from '../lib/providers.mjs';
import { markProviderFailure, providerFailure } from '../lib/provider-failure.mjs';
import { retryAfterMs } from '../lib/provider-net.mjs';
import { validateFallback } from '../lib/model-resilience.mjs';
import { ensure } from '../lib/store.mjs';

const BOT='bot_atlas';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const current=store=>store.state.runs[BOT];
const call=(id,name,args)=>({id,name,arguments:args});
const answer=text=>({text,toolCalls:[]});
const transient=(code='upstream_unavailable')=>markProviderFailure(new HttpError(503,'Disposable provider outage.'),code,{upstreamStatus:503});
const reasoning={supported:true,efforts:['low','high'],defaultEffort:'low',parameter:'reasoning.effort',source:'provider'};
async function until(predicate,timeoutMs=10000) {
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){const result=predicate();if(result)return result;await delay(5);}
  throw new Error('Resilience fixture timed out.');
}

// ---- Providers over a real fake HTTP server -------------------------------------------------

async function fakeServer(t,handler) {
  const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections?.();server.close();});
  return `http://127.0.0.1:${server.address().port}/v1`;
}
async function providers(t,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-resilience-')),store=await new Store(directory).init();
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return {store,providers:new Providers(store,{allowPrivateHttp:true,...options})};
}
const sse=(res,chunks)=>{if(res.destroyed)return;if(!res.headersSent)res.writeHead(200,{'Content-Type':'text/event-stream'});for(const chunk of chunks)res.write(`data: ${JSON.stringify(chunk)}\n\n`);res.end('data: [DONE]\n\n');};
const reply=text=>[{choices:[{delta:{content:text},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}];

test('idle allowance is 120 s for ordinary models and 600 s for reasoning models',async t=>{
  const {providers:p}=await providers(t);
  const plain={type:'custom',models:[{id:'plain'}]},thinker={type:'custom',models:[{id:'think',reasoning:{supported:true,efforts:['low','high'],defaultEffort:'low',parameter:'reasoning',source:'provider'}}]};
  assert.equal(IDLE_STANDARD_MS,120_000);assert.equal(IDLE_REASONING_MS,600_000);
  assert.equal(p.idleTimeout(plain,'plain',{supported:false}),120_000);
  assert.equal(p.idleTimeout(thinker,'think',{supported:true}),600_000);
  assert.equal(p.idleTimeout({type:'deepseek',models:[]},'deepseek-v4-pro',null),600_000,'a preset thinking model is a reasoning model');
  assert.equal(p.idleTimeout({type:'openai',models:[]},'o3',null),600_000,'an o-series model reasons by default');
  const custom=new Providers(p.store,{idleTimeouts:{standard:111,reasoning:222}});
  assert.equal(custom.idleTimeout(plain,'plain',{supported:false}),111);assert.equal(custom.idleTimeout(thinker,'think',{supported:true}),222);
});

test('a stalled ordinary model times out at its short idle limit while a reasoning model keeps waiting',async t=>{
  const base=await fakeServer(t,(req,res)=>{
    req.resume();
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      const wanted=JSON.parse(body).model;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': keep-alive\n\n');
      // The reasoning model is silent for longer than the ordinary limit, then answers.
      setTimeout(()=>sse(res,reply('thought it through')),wanted==='think'?450:5000);
    });
  });
  const {store,providers:p}=await providers(t,{idleTimeouts:{standard:150,reasoning:1500}});
  const connection={id:'c1',type:'custom',name:'Fixture',baseUrl:base,models:[{id:'plain'},{id:'think',reasoning:{supported:true,efforts:['low','high'],defaultEffort:'low',parameter:'reasoning',source:'provider'}}]};
  await store.mutate(state=>{state.connections.push(connection);});
  const started=Date.now();
  await assert.rejects(()=>p.complete(connection,{model:'plain',messages:[{role:'user',content:'hi'}]}),error=>{const failure=providerFailure(error);return failure?.code==='timeout' && failure.timeoutPhase==='idle';});
  assert.ok(Date.now()-started<2500);
  const result=await p.complete(connection,{model:'think',messages:[{role:'user',content:'hi'}]});
  assert.equal(result.text,'thought it through');
});

test('Retry-After is parsed from seconds or a date and carried on the provider error',async t=>{
  assert.equal(retryAfterMs({'retry-after':'7'}),7000);assert.equal(retryAfterMs({'retry-after':'1.5'}),1500);
  assert.equal(retryAfterMs({'retry-after':new Date(Date.now()+30_000).toUTCString()},Date.now())>25_000,true);
  assert.equal(retryAfterMs({}),0);assert.equal(retryAfterMs({'retry-after':'soon'}),0);
  const base=await fakeServer(t,(req,res)=>{req.resume();res.writeHead(429,{'Content-Type':'application/json','Retry-After':'12'});res.end(JSON.stringify({error:{message:'slow down'}}));});
  const {providers:p}=await providers(t);
  const error=await p.complete({id:'c2',type:'custom',baseUrl:base,models:[]},{model:'m',messages:[{role:'user',content:'hi'}]}).catch(value=>value);
  assert.equal(error.retryAfterMs,12_000);assert.equal(providerFailure(error).code,'rate_limit');
});

// ---- Engine: retry cap, fallback, no replay -----------------------------------------------

async function fixture(t,complete,{fallback=true,botExtra={},options={}}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-resilience-engine-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{
    state.connections.push({id:'primary',type:'openai',name:'Primary',model:'primary-model',secret:store.seal('disposable-key-1'),models:[{id:'primary-model',reasoning}]});
    state.connections.push({id:'backup',type:'anthropic',name:'Backup',model:'backup-model',secret:store.seal('disposable-key-2'),models:[{id:'backup-model'}]});
    Object.assign(state.bots.find(bot=>bot.id===BOT),{connectionId:'primary',model:'primary-model',reasoningEffort:'low',tools:['workspace'],approvalPolicy:'balanced',collaborators:[],...(fallback?{fallback:{connectionId:'backup',model:'backup-model'}}:{}),...botExtra});
  });
  const engine=new NativeEngine(store,{retryDelay:1,...options,providers:{async complete(connection,request){
    requests.push({connectionId:connection.id,model:request.model,effort:request.reasoningEffort,messages:structuredClone(request.messages)});
    return complete(request,requests.length,connection);
  }}});await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,requests,directory};
}
async function finished(f,run) {
  await until(()=>current(f.store)?.id===run.id && !isActive(current(f.store)));await f.engine.tasks.get(run.id);await f.store.queue;return current(f.store);
}
const eventsOf=(run,type)=>(run.events||[]).filter(event=>event.type===type);

test('transient failures retry at most six times, then the run fails clearly without a fallback',async t=>{
  const f=await fixture(t,async()=>{throw transient();},{fallback:false});
  const run=await finished(f,await f.engine.start(BOT,'Say hi.'));
  assert.equal(f.requests.length,7,'one attempt plus six retries');
  assert.equal(run.status,'failed');assert.match(run.error,/did not recover after 6 automatic retries/);
  const retries=eventsOf(run,'model.retry');assert.deepEqual(retries.map(event=>event.attempt),[1,2,3,4,5,6]);assert.ok(retries.every(event=>event.maxAttempts===6));
});

test('non-transient errors are not retried',async t=>{
  const f=await fixture(t,async()=>{throw markProviderFailure(new HttpError(401,'bad key'),'authentication',{upstreamStatus:401});});
  const run=await finished(f,await f.engine.start(BOT,'Say hi.'));
  assert.equal(f.requests.length,1);assert.equal(run.status,'failed');assert.equal(eventsOf(run,'model.fallback').length,0);
});

test('after the retry cap the same request goes once to the fallback model, which is recorded',async t=>{
  const f=await fixture(t,async(request,count,connection)=>{if(connection.id==='primary')throw transient();return answer(`Answered by ${request.model}.`);});
  const run=await finished(f,await f.engine.start(BOT,'Say hi.'));
  assert.equal(run.status,'completed');assert.equal(run.output,'Answered by backup-model.');
  assert.equal(f.requests.filter(item=>item.connectionId==='primary').length,7);assert.equal(f.requests.filter(item=>item.connectionId==='backup').length,1);
  const [fallback]=eventsOf(run,'model.fallback');assert.equal(fallback.from.model,'primary-model');assert.equal(fallback.to.model,'backup-model');assert.equal(fallback.to.provider,'anthropic');
  assert.deepEqual([run.answeredBy.model,run.answeredBy.fallback],['backup-model',true]);assert.equal(eventsOf(run,'model.completed').at(-1).fallback,true);
  const log=await f.engine.engineLog.read({limit:200});
  assert.ok(log.some(row=>row.kind==='model.fallback' && row.to.model==='backup-model'));assert.ok(log.some(row=>row.kind==='model.call' && row.fallback===true && row.model==='backup-model'));
  // The primary's reasoning effort is not forced onto a model that does not advertise it.
  assert.equal(f.requests.find(item=>item.connectionId==='backup').effort,'');
});

test('the fallback is tried only once: when it also fails the run fails and no second fallback happens',async t=>{
  const f=await fixture(t,async()=>{throw transient('rate_limit');});
  const run=await finished(f,await f.engine.start(BOT,'Say hi.'));
  assert.equal(run.status,'failed');assert.equal(f.requests.filter(item=>item.connectionId==='backup').length,1);assert.equal(eventsOf(run,'model.fallback').length,1);
});

test('retry and fallback re-send only the model request; a committed tool never runs again',async t=>{
  const f=await fixture(t,async(request,count,connection)=>{
    if(count===1)return {text:'Saving.',toolCalls:[call('saved','workspace_write',{path:'once.txt',content:'one write'})]};
    if(connection.id==='primary')throw transient('timeout');
    assert.ok(request.messages.some(message=>message.role==='tool' && message.tool_call_id==='saved'));
    return answer('Done after fallback.');
  });
  let writes=0;const execute=f.engine.tools.execute.bind(f.engine.tools);
  f.engine.tools.execute=async(...args)=>{if(args[1]==='workspace_write')writes++;return execute(...args);};
  const run=await finished(f,await f.engine.start(BOT,'Write the file.'));
  assert.equal(run.status,'completed');assert.equal(writes,1);
});

test('a stalled call announces itself with waiting events that the activity strip can show',async t=>{
  const release=Promise.withResolvers();
  const f=await fixture(t,async()=>{await release.promise;return answer('Finally.');},{options:{waitNoticeMs:60,waitTickMs:15}});
  const admitted=await f.engine.start(BOT,'Think hard.');
  // A failed assertion must not leave the provider stalled, or engine cleanup would wait on it forever.
  try {
    await until(()=>eventsOf(current(f.store),'model.waiting').length>0);
    const waiting=eventsOf(current(f.store),'model.waiting').at(-1);assert.ok(waiting.elapsedMs>=60);assert.equal(waiting.model,'primary-model');
    await delay(200);assert.equal(eventsOf(current(f.store),'model.waiting').length,1,'older waiting events are replaced, not accumulated');
  } finally {release.resolve();}
  const run=await finished(f,admitted);assert.equal(run.status,'completed');
});

test('bot fallback validation: provider must exist, be a direct provider and differ from the primary',()=>{
  const connections=[{id:'a',type:'openai'},{id:'old',type:'legacy-hermes'}];
  const primary={connectionId:'a',model:'m1'};
  assert.deepEqual(validateFallback({connectionId:'a',model:' m2 '},{connections,ensure,primary}),{connectionId:'a',model:'m2'});
  assert.equal(validateFallback(null,{connections,ensure,primary}),null);
  assert.throws(()=>validateFallback({connectionId:'missing',model:'m'},{connections,ensure,primary}),/does not exist/);
  assert.throws(()=>validateFallback({connectionId:'old',model:'m'},{connections,ensure,primary}),/direct model provider/);
  assert.throws(()=>validateFallback({connectionId:'a',model:'m1'},{connections,ensure,primary}),/differ/);
  assert.throws(()=>validateFallback({connectionId:'a'},{connections,ensure,primary}),/model/);
});

test('background reviews run with bounded concurrency and a full queue drops new jobs without error',async t=>{
  const { BackgroundReviews }=await import('../lib/background-reviews.mjs');
  const engine={store:{state:{runs:{},bots:[]}},starting:new Set()};
  const queue=new BackgroundReviews(engine,{concurrency:2,maxQueued:2});
  let active=0,peak=0;
  queue.run=async()=>{active++;peak=Math.max(peak,active);await delay(20);active--;};
  const accepted=[1,2,3,4,5].map(n=>queue.enqueue({botId:'b',runId:`r${n}`}));
  assert.deepEqual(accepted,[true,true,true,true,false],'two run at once, two wait, the fifth is refused');
  await queue.idle();assert.equal(peak,2);
  await queue.close();assert.equal(queue.enqueue({botId:'b',runId:'late'}),false);
});
