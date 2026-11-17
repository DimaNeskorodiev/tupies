import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {serviceRequest} from '../lib/provider-net.mjs';
import {providerFailure} from '../lib/provider-failure.mjs';

// Behaves like Python http.server runtimes (mlx_lm.server): a body must declare its Content-Length.
async function strictServer(t,handler){
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks),record={method:req.method,url:req.url,headers:req.headers,body:body.toString('utf8')};requests.push(record);
    if(req.headers['transfer-encoding'] || ['POST','PUT','PATCH'].includes(req.method) && req.headers['content-length']===undefined){res.writeHead(411,{'content-type':'application/json'});res.end(JSON.stringify({error:'Length Required'}));return;}
    handler(req,res,record);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {origin:`http://127.0.0.1:${server.address().port}`,requests};
}
const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
function stream(res){res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();}
function event(res,value){res.write(`data: ${JSON.stringify(value)}\n\n`);}
function later(res,ms,callback){const timer=setTimeout(callback,ms);res.once('close',()=>clearTimeout(timer));}
function pulse(res,ms,callback){const timer=setInterval(callback,ms);res.once('close',()=>clearInterval(timer));}
const prompt={model:'fixture-model',messages:[{role:'user',content:'Synthetic prompt — naïve “quotes” ✓'}]};

test('the strict fixture refuses a chunked body with 411, as mlx_lm.server does',async t=>{
  const f=await strictServer(t,(_req,res)=>json(res,{ok:true}));
  const status=await new Promise((resolve,reject)=>{
    const request=http.request(`${f.origin}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'}},response=>{response.resume();resolve(response.statusCode);});
    request.on('error',reject);request.write(JSON.stringify(prompt));request.end();
  });
  assert.equal(status,411);assert.equal(f.requests[0].headers['transfer-encoding'],'chunked');
});

test('request bodies always carry their exact byte Content-Length and are never chunked',async t=>{
  const f=await strictServer(t,(_req,res,record)=>json(res,{echo:record.body}));
  const text=JSON.stringify(prompt);
  for(const body of [prompt,text,Buffer.from(text)]){
    const response=await serviceRequest(`${f.origin}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body});
    assert.equal(response.status,200);assert.equal(response.data.echo,text);
  }
  for(const record of f.requests){
    assert.equal(record.headers['transfer-encoding'],undefined);
    assert.equal(record.headers['content-length'],String(Buffer.byteLength(text)));
    assert.notEqual(Buffer.byteLength(text),text.length);
  }
});

test('a POST body works with an SSE response from a strict runtime',async t=>{
  const f=await strictServer(t,(_req,res)=>{stream(res);event(res,{choices:[{delta:{content:'Hello'}}]});event(res,{choices:[{delta:{},finish_reason:'stop'}]});res.end('data: [DONE]\n\n');});
  const seen=[],response=await serviceRequest(`${f.origin}/v1/chat/completions`,{method:'POST',body:{...prompt,stream:true},onSSE:value=>seen.push(value)});
  assert.equal(response.status,200);assert.equal(response.streaming,true);assert.equal(response.events.length,2);
  assert.equal(seen[0].choices[0].delta.content,'Hello');
});

test('a matching caller Content-Length is kept once and a mismatched one is refused before sending',async t=>{
  const f=await strictServer(t,(_req,res)=>json(res,{ok:true})),text='{"ok":"✓"}';
  const response=await serviceRequest(f.origin,{method:'POST',headers:{'Content-Length':String(Buffer.byteLength(text))},body:text});
  assert.equal(response.status,200);assert.equal(f.requests[0].headers['content-length'],String(Buffer.byteLength(text)));
  await assert.rejects(serviceRequest(f.origin,{method:'POST',headers:{'content-length':String(text.length)},body:text}),error=>error.status===500 && /Content-Length/.test(error.message));
  await assert.rejects(serviceRequest(f.origin,{method:'POST',headers:{'Transfer-Encoding':'chunked'},body:text}),error=>error.status===500);
  assert.equal(f.requests.length,1);
});

test('requests without a body are unchanged',async t=>{
  const f=await strictServer(t,(_req,res)=>json(res,{data:[]}));
  const response=await serviceRequest(`${f.origin}/v1/models`);
  assert.deepEqual(response.data,{data:[]});assert.equal(f.requests[0].headers['content-length'],undefined);assert.equal(f.requests[0].headers['transfer-encoding'],undefined);
});

test('a slow first event is allowed by the first-event limit, not the idle limit',async t=>{
  const f=await strictServer(t,(_req,res)=>{stream(res);later(res,150,()=>{event(res,{n:1});event(res,{n:2});res.end();});});
  const response=await serviceRequest(f.origin,{method:'POST',body:prompt,onSSE(){},idleTimeoutMs:50,firstEventTimeoutMs:2000,timeoutMs:5000});
  assert.deepEqual(response.events,[{n:1},{n:2}]);
  // Without the option the same wait is an idle failure: existing behaviour is unchanged.
  await assert.rejects(serviceRequest(f.origin,{method:'POST',body:prompt,onSSE(){},idleTimeoutMs:50,timeoutMs:5000}),error=>providerFailure(error)?.timeoutPhase==='idle' && /waiting for more data/.test(error.message));
});

test('a slow JSON body is allowed by the first-event limit',async t=>{
  const f=await strictServer(t,(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.flushHeaders();later(res,150,()=>res.end(JSON.stringify({ok:true})));});
  const response=await serviceRequest(f.origin,{method:'POST',body:prompt,idleTimeoutMs:50,firstEventTimeoutMs:2000,timeoutMs:5000});
  assert.deepEqual(response.data,{ok:true});
});

test('response headers and SSE comments do not count as the first event',async t=>{
  const f=await strictServer(t,(_req,res)=>{stream(res);pulse(res,20,()=>res.write(': keep-alive\n\n'));});
  const started=Date.now();
  await assert.rejects(serviceRequest(f.origin,{method:'POST',body:prompt,onSSE(){},idleTimeoutMs:5000,firstEventTimeoutMs:150,timeoutMs:5000}),error=>{
    assert.match(error.message,/first data before the first-event limit/);
    assert.deepEqual(providerFailure(error),{origin:'provider',code:'timeout',status:504,upstreamStatus:null,timeoutPhase:'idle'});return true;
  });
  assert.ok(Date.now()-started<2000);
});

test('after the first event the normal idle limit applies',async t=>{
  const f=await strictServer(t,(_req,res)=>{stream(res);later(res,100,()=>event(res,{n:1}));});
  const seen=[];
  await assert.rejects(serviceRequest(f.origin,{method:'POST',body:prompt,onSSE:value=>seen.push(value),idleTimeoutMs:60,firstEventTimeoutMs:5000,timeoutMs:5000}),error=>providerFailure(error)?.timeoutPhase==='idle' && /waiting for more data/.test(error.message));
  assert.deepEqual(seen,[{n:1}]);
});

test('without an idle limit, the first-event limit ends at the first event',async t=>{
  const f=await strictServer(t,(_req,res)=>{stream(res);later(res,30,()=>event(res,{n:1}));later(res,250,()=>{event(res,{n:2});res.end();});});
  const response=await serviceRequest(f.origin,{method:'POST',body:prompt,onSSE(){},firstEventTimeoutMs:100,timeoutMs:5000});
  assert.equal(response.events.length,2);
});

test('the total limit still bounds a request waiting for its first event',async t=>{
  const f=await strictServer(t,(_req,res)=>stream(res));
  await assert.rejects(serviceRequest(f.origin,{method:'POST',body:prompt,onSSE(){},idleTimeoutMs:5000,firstEventTimeoutMs:5000,timeoutMs:120}),error=>providerFailure(error)?.timeoutPhase==='total');
});

test('maxEvents caps SSE events and defaults to 50,000',async t=>{
  const f=await strictServer(t,(_req,res)=>{stream(res);for(let n=1;n<=5;n++)event(res,{n});res.end();});
  await assert.rejects(serviceRequest(f.origin,{onSSE(){},maxEvents:3}),error=>providerFailure(error)?.code==='response_limit' && /event limit/.test(error.message));
  assert.equal((await serviceRequest(f.origin,{onSSE(){},maxEvents:5})).events.length,5);
  assert.equal((await serviceRequest(f.origin,{onSSE(){}})).events.length,5);
  for(const maxEvents of [0,1.5,'many'])await assert.rejects(serviceRequest(f.origin,{onSSE(){},maxEvents}),error=>error.status===500);
  for(const firstEventTimeoutMs of [0,Number.NaN])await assert.rejects(serviceRequest(f.origin,{onSSE(){},firstEventTimeoutMs}),error=>error.status===500);
});
