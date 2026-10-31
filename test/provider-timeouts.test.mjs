import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {serviceRequest} from '../lib/provider-net.mjs';
import {Providers} from '../lib/providers.mjs';
import {providerFailure,sanitizeProviderFailure} from '../lib/provider-failure.mjs';

const messages=[{role:'user',content:'Complete this synthetic request.'}];
async function fixture(t,handler){
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    for await(const _chunk of req){};
    requests.push(req.url);handler(req,res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {origin:`http://127.0.0.1:${server.address().port}`,requests};
}
function later(res,ms,callback){const timer=setTimeout(callback,ms);res.once('close',()=>clearTimeout(timer));}
function pulse(res,ms,callback){const timer=setInterval(callback,ms);res.once('close',()=>clearInterval(timer));}
function stream(res){res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();}
function event(res,value){res.write(`data: ${JSON.stringify(value)}\n\n`);}
function provider(t,origin,options={},type='custom'){
  // This fixture needs no credentials, persisted account or production workspace.
  const store={state:{connections:[]},redact:value=>String(value)},providers=new Providers(store,options);
  t.after(()=>providers.close());
  return {providers,connection:{id:'timeout-fixture',type,name:'Timeout fixture',baseUrl:origin,defaultModel:'fixture-model'}};
}

test('active inference passes the shorter catalog limit while receiving several stream chunks',async t=>{
  const f=await fixture(t,(_req,res)=>{
    stream(res);let count=0;
    pulse(res,30,()=>{event(res,{choices:[{delta:{content:'part '}}]});if(++count===5){event(res,{choices:[{delta:{},finish_reason:'stop'}]});res.end();}});
  });
  const {providers,connection}=provider(t,f.origin,{requestTimeout:30,inferenceTimeout:2000,inferenceIdleTimeout:1000});
  const chunks=[],result=await providers.complete(connection,{messages,onDelta:value=>chunks.push(value)});
  assert.equal(result.text,'part '.repeat(5));assert.equal(chunks.length,5);assert.equal(f.requests.length,1);
});

test('all inference protocols allow silent reasoning before their first response while catalog requests keep their bound',async t=>{
  for(const type of ['openai','chatgpt','anthropic','custom'])await t.test(type,async t=>{
    const f=await fixture(t,(req,res)=>later(res,100,()=>{
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify(req.url==='/models'?{data:[]}:
        req.url==='/responses'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Done.'}]}]}:
        req.url==='/messages'?{content:[{type:'text',text:'Done.'}],stop_reason:'end_turn'}:
        {choices:[{message:{content:'Done.'},finish_reason:'stop'}]}));
    }));
    const {providers,connection}=provider(t,f.origin,{allowTestOAuth:true,requestTimeout:30,inferenceTimeout:2000,inferenceIdleTimeout:1000},type);
    providers.headers=async()=>({});
    assert.equal((await providers.complete(connection,{messages})).text,'Done.');
    await assert.rejects(providers.models(connection),error=>providerFailure(error)?.timeoutPhase==='total');
    assert.deepEqual(f.requests,[type==='anthropic'?'/messages':['openai','chatgpt'].includes(type)?'/responses':'/chat/completions','/models']);
  });
});

test('a stalled inference stream fails with a distinct idle deadline and closes its socket without replay',async t=>{
  let disconnected;const closed=new Promise(resolve=>{disconnected=resolve;});
  const f=await fixture(t,(_req,res)=>{res.once('close',disconnected);stream(res);event(res,{choices:[{delta:{content:'Partial.'}}]});});
  const {providers,connection}=provider(t,f.origin,{inferenceTimeout:2000,inferenceIdleTimeout:60});
  const chunks=[];
  await assert.rejects(providers.complete(connection,{messages,onDelta:value=>chunks.push(value)}),error=>{
    assert.match(error.message,/waiting for more data/);
    assert.deepEqual(providerFailure(error),{origin:'provider',code:'timeout',status:504,upstreamStatus:null,timeoutPhase:'idle'});return true;
  });
  await closed;assert.deepEqual(chunks,['Partial.']);assert.equal(f.requests.length,1);
});

test('inference stops waiting for its first response at the idle allowance',async t=>{
  const f=await fixture(t,()=>{}),{providers,connection}=provider(t,f.origin,{inferenceTimeout:2000,inferenceIdleTimeout:60});
  await assert.rejects(providers.complete(connection,{messages}),error=>providerFailure(error)?.timeoutPhase==='idle');
  assert.equal(f.requests.length,1);
});

test('heartbeats cannot extend the absolute response deadline',async t=>{
  let received=0;
  const f=await fixture(t,(_req,res)=>{stream(res);event(res,{pulse:true});pulse(res,10,()=>event(res,{pulse:true}));});
  await assert.rejects(serviceRequest(f.origin,{timeoutMs:120,idleTimeoutMs:1000,onSSE:()=>received++}),error=>{
    assert.match(error.message,/total response limit/);assert.equal(providerFailure(error)?.timeoutPhase,'total');return true;
  });
  assert.ok(received>=1);assert.equal(f.requests.length,1);
});

test('per-request task budget can shorten inference but cannot extend its configured total limit',async t=>{
  for(const [configured,budget] of [[2000,60],[60,2000]])await t.test(`${configured}/${budget}`,async t=>{
    const f=await fixture(t,()=>{}),{providers,connection}=provider(t,f.origin,{inferenceTimeout:configured,inferenceIdleTimeout:2000});
    await assert.rejects(providers.complete(connection,{messages,timeoutMs:budget}),error=>providerFailure(error)?.timeoutPhase==='total');
    assert.equal(f.requests.length,1);
  });
});

test('explicit requestTimeout still provides a short inference timeout for existing fixtures',async t=>{
  const f=await fixture(t,()=>{}),{providers,connection}=provider(t,f.origin,{requestTimeout:60});
  await assert.rejects(providers.complete(connection,{messages}),error=>providerFailure(error)?.timeoutPhase==='total');
  assert.equal(f.requests.length,1);
});

test('owner cancellation preserves its exact reason, closes the stream and never becomes a timeout',async t=>{
  let disconnected;const closed=new Promise(resolve=>{disconnected=resolve;}),controller=new AbortController(),reason=new Error('Synthetic owner stop.');
  const f=await fixture(t,(_req,res)=>{res.once('close',disconnected);stream(res);event(res,{choices:[{delta:{content:'Partial.'}}]});pulse(res,10,()=>event(res,{choices:[{delta:{content:'More.'}}]}));});
  const {providers,connection}=provider(t,f.origin,{inferenceTimeout:2000,inferenceIdleTimeout:1000});
  await assert.rejects(providers.complete(connection,{messages,signal:controller.signal,onDelta(){controller.abort(reason);}}),error=>{
    assert.equal(error,reason);assert.equal(providerFailure(error),null);return true;
  });
  await closed;assert.equal(f.requests.length,1);
});

test('timeout phase metadata accepts only static timeout categories',()=>{
  const failure={origin:'provider',code:'timeout',status:504,upstreamStatus:null};
  assert.deepEqual(sanitizeProviderFailure({...failure,timeoutPhase:'private data'}),failure);
  assert.deepEqual(sanitizeProviderFailure({...failure,timeoutPhase:'idle',body:'private data'}),{...failure,timeoutPhase:'idle'});
  assert.deepEqual(sanitizeProviderFailure({...failure,code:'transport_error',timeoutPhase:'idle'}),{...failure,code:'transport_error'});
});
