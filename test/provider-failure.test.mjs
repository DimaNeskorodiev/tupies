import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store,HttpError} from '../lib/store.mjs';
import {Providers} from '../lib/providers.mjs';
import {NativeEngine,recordRun} from '../lib/engine.mjs';
import {providerFailure,sanitizeProviderFailure} from '../lib/provider-failure.mjs';

const SECRET='provider-failure-fixture-private-canary',messages=[{role:'user',content:'A synthetic request.'}];
const metadata=(code,status=502,upstreamStatus=null)=>({origin:'provider',code,status,upstreamStatus});
const json=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
const sse=(res,events)=>{res.writeHead(200,{'content-type':'text/event-stream'});for(const event of events)res.write(`data: ${JSON.stringify(event)}\n\n`);res.end();};
async function fixture(t,handler,{type='openai',timeout=1000}={}){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-provider-failure-')),store=await new Store(directory).init(),requests=[];
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw || '{}'));handler(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const providers=new Providers(store,{requestTimeout:timeout,allowTestOAuth:true}),connection={id:'fixture',type,name:'Fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,defaultModel:'fixture-model',secret:store.seal(SECRET)};
  if(type==='chatgpt')providers.headers=async()=>({Authorization:`Bearer ${SECRET}`});
  await store.mutate(state=>{state.connections.push(connection);for(const bot of state.bots){bot.connectionId=connection.id;bot.tools=['workspace'];bot.approvalPolicy='balanced';}});
  // These fixtures assert terminal failure metadata; autonomous retry behavior has separate integration coverage.
  const engine=new NativeEngine(store,{providers,executionMode:'bounded'});
  t.after(async()=>{await engine.close();await providers.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  const run=async()=>{const started=await engine.start('bot_atlas','Complete the synthetic fixture.');await engine.tasks.get(started.id);return store.state.runs.bot_atlas;};
  return {directory,store,providers,connection,engine,requests,run};
}

test('real provider failures persist only static metadata in the active run and bounded history, preserving upstream HTTP status',async t=>{
  const cases=[
    ['http_400',(_req,res)=>json(res,{error:{message:SECRET,failure:SECRET},account:SECRET},400),metadata('http_400',502,400)],
    ['authentication',(_req,res)=>json(res,{error:{message:SECRET}},403),metadata('authentication',401,403)],
    ['rate_limit',(_req,res)=>json(res,{error:{message:SECRET}},429),metadata('rate_limit',502,429)],
    ['upstream_unavailable',(_req,res)=>json(res,{error:{message:SECRET}},503),metadata('upstream_unavailable',502,503)],
    ['timeout',()=>{},{...metadata('timeout',504),timeoutPhase:'total'},{timeout:30}],
    ['response_failed',(_req,res)=>sse(res,[{type:'response.failed',error:{message:SECRET,code:SECRET,status:SECRET,account:SECRET,failure:{origin:'provider',code:SECRET}}}]),metadata('response_failed',502,200)],
    ['stream_interrupted',(_req,res)=>sse(res,[{type:'response.created',response:{id:SECRET}}]),metadata('stream_interrupted',502,200)],
    ['empty_response',(_req,res)=>json(res,{status:'completed',output:[{type:'reasoning',encrypted_content:SECRET}]}),metadata('empty_response',502,200)],
    ['arguments_rejected',(_req,res)=>json(res,{status:'completed',output:[{type:'function_call',call_id:'fixture_call',name:'workspace_read',arguments:SECRET}]}),metadata('arguments_rejected',502,200)],
    ['namespace_rejected',(_req,res)=>json(res,{status:'completed',output:[{type:'function_call',call_id:'fixture_call',name:'workspace_read',namespace:SECRET,arguments:'{}'}]}),metadata('namespace_rejected',502,200),{type:'chatgpt'}],
    ['invalid_json',(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(SECRET);},metadata('invalid_json',502,200)],
    ['invalid_stream',(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${SECRET}\n\n`);},metadata('invalid_stream',502,200)],
    ['protocol_error',(_req,res)=>json(res,{status:'completed',output:SECRET,private:SECRET}),metadata('protocol_error',502,200)]
  ];
  for(const [name,handler,expected,options] of cases)await t.test(name,async t=>{
    const f=await fixture(t,handler,options),run=await f.run();assert.equal(run.status,'failed');assert.deepEqual(run.failure,expected);assert.deepEqual(f.store.state.runHistory.bot_atlas[0].failure,expected);
    assert.equal(f.requests.length,1,'failure observability must never retry inference or replay actions');assert.equal(run.workRecords?.length || 0,0);
    const disk=JSON.parse(await fs.readFile(f.store.file,'utf8'));assert.deepEqual(disk.runs.bot_atlas.failure,expected);assert.ok(!JSON.stringify(disk).includes(SECRET));
  });
});

test('protocol catch brands unexpected local protocol shapes, but never trusts custom failure properties',async t=>{
  const f=await fixture(t,(_req,res)=>json(res,{}));
  f.providers.responses=async()=>{throw Object.assign(new HttpError(502,SECRET),{code:SECRET,body:SECRET,account:SECRET,headers:{Authorization:SECRET},failure:{origin:'provider',code:'authentication',status:401,upstreamStatus:403,private:SECRET}});};
  const run=await f.run();assert.deepEqual(run.failure,metadata('protocol_error'));assert.ok(!JSON.stringify(run).includes(SECRET));assert.ok(!JSON.stringify(run.failure).includes('private'));
  f.engine.providers={complete:async()=>{throw Object.assign(new HttpError(502,SECRET),{failure:metadata('authentication',401,403),providerFailure:metadata('authentication',401,403),body:SECRET});}};
  const untrusted=await f.run();assert.equal(untrusted.failure,undefined,'the engine only accepts metadata branded inside provider code');assert.equal(f.store.state.runHistory.bot_atlas[0].failure,undefined);
});

test('an owner-cancelled provider request is cancelled without provider failure metadata',async t=>{
  let received;const admitted=new Promise(resolve=>{received=resolve;}),f=await fixture(t,()=>received());
  const run=await f.engine.start('bot_atlas','A cancellable fixture.');await admitted;await f.engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});await f.engine.tasks.get(run.id);
  assert.equal(f.store.state.runs.bot_atlas.status,'cancelled');assert.equal(f.store.state.runs.bot_atlas.failure,undefined);assert.equal(f.store.state.runHistory.bot_atlas[0].failure,undefined);assert.equal(f.requests.length,1);
});

test('owner cancellation wins a marked protocol failure and consumer write failures are not provider failures',async t=>{
  const f=await fixture(t,(_req,res)=>sse(res,[{type:'response.output_text.delta',delta:'A fixture answer.'},{type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'A fixture answer.'}]}]}}]));
  const local=new Error('A local persistence fixture failure.');await assert.rejects(f.providers.complete(f.connection,{messages,onDelta(){throw local;}}),error=>{assert.equal(error,local);assert.equal(providerFailure(error),null);return true;});
  const controller=new AbortController(),cancelled=new Error('Owner stopped.');controller.abort(cancelled);
  await assert.rejects(f.providers.complete(f.connection,{messages,signal:controller.signal}),error=>{assert.equal(error,cancelled);assert.equal(providerFailure(error),null);return true;});
});

test('persisted history sanitization drops unknown fields, invalid categories and invalid numeric statuses',()=>{
  assert.equal(sanitizeProviderFailure({origin:'provider',code:SECRET,status:400,body:SECRET}),null);
  assert.deepEqual(sanitizeProviderFailure({...metadata('http_400'),status:SECRET,upstreamStatus:Infinity,body:SECRET,account:SECRET}),metadata('http_400',null,null));
  const state={};recordRun(state,{id:'fixture',botId:'fixture',status:'failed',failure:{...metadata('http_400',502,400),account:SECRET,error:SECRET,headers:{Authorization:SECRET}}});assert.deepEqual(state.runHistory.fixture[0].failure,metadata('http_400',502,400));assert.ok(!JSON.stringify(state).includes(SECRET));
});
