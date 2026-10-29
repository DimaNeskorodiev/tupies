import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { Providers, responsesInput, anthropicMessages } from '../lib/providers.mjs';
import { validateServiceUrl, serviceRequest, requireSuccess } from '../lib/provider-net.mjs';

const SECRET='provider-fixture-key-do-not-expose';
async function fixture(t,handler){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-providers-')),store=await new Store(directory).init();
  const requests=[];
  const server=http.createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;const request={url:req.url,method:req.method,headers:req.headers,raw,body:raw && req.headers['content-type']?.includes('application/json')?JSON.parse(raw):null};requests.push(request);await handler(request,res);}catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.message}}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  const providers=new Providers(store,{requestTimeout:1000});
  t.after(async()=>{await providers.close();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  return {store,origin,providers,requests,server};
}
function json(res,data,status=200){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}
function sse(res,events){res.writeHead(200,{'content-type':'text/event-stream'});for(const event of events)res.write(`data: ${JSON.stringify(event)}\r\n\r\n`);res.end();}
async function connection(f,type='openai'){const value={...f.providers.validate({name:'Test provider',type,baseUrl:`${f.origin}/v1`,apiKey:SECRET,defaultModel:'fixture-model'}),id:'provider_test'};await f.store.mutate(state=>state.connections.push(value));return value;}

test('per-request summary output caps survive stored connection refresh across protocols',async t=>{
  for(const type of ['openai','anthropic','custom'])await t.test(type,async t=>{
    const f=await fixture(t,(req,res)=>{
      if(req.url.endsWith('/responses'))json(res,{id:'cap-fixture',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Bounded summary.'}]}]});
      else if(req.url.endsWith('/messages'))json(res,{content:[{type:'text',text:'Bounded summary.'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:5}});
      else json(res,{choices:[{message:{role:'assistant',content:'Bounded summary.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}});
    });
    const c=await connection(f,type),messages=[{role:'user',content:'Summarize this fixture.'}];
    await f.providers.complete({...c,maxOutputTokens:2048},{messages,maxOutputTokens:512});
    assert.equal(f.requests[0].body.max_output_tokens ?? f.requests[0].body.max_tokens,512);
    assert.equal(f.store.state.connections[0].maxOutputTokens,4096);
    await f.providers.complete(c,{messages,maxOutputTokens:8192});assert.equal(f.requests[1].body.max_output_tokens ?? f.requests[1].body.max_tokens,4096,'a request cap cannot raise the configured limit');
    await assert.rejects(f.providers.complete(c,{messages,maxOutputTokens:12}),/Per-request output limit/);assert.equal(f.requests.length,2);
  });
});

test('direct OpenAI Responses streams text, preserves reasoning and returns exact function calls',async t=>{
  const f=await fixture(t,(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${SECRET}`);assert.equal(req.url,'/v1/responses');assert.equal(req.body.store,false);assert.equal(req.body.stream,true);assert.equal(req.body.parallel_tool_calls,true);
    sse(res,[{type:'response.output_text.delta',delta:'I will check.'},{type:'response.completed',response:{status:'completed',output:[{type:'reasoning',id:'reasoning_1',encrypted_content:'opaque-reasoning'},{type:'message',role:'assistant',content:[{type:'output_text',text:'I will check.'}]},{type:'function_call',call_id:'call_1',name:'workspace_read',arguments:'{"path":"brief.txt"}'}],usage:{input_tokens:10,output_tokens:5}}}]);
  });
  const c=await connection(f),deltas=[];
  const result=await f.providers.complete(c,{messages:[{role:'system',content:'Be useful.'},{role:'user',content:'Read the brief.'}],tools:[{name:'workspace_read',description:'Read a workspace file.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}],onDelta:async text=>{await new Promise(resolve=>setTimeout(resolve,2));deltas.push(text);}});
  assert.equal(result.text,'I will check.');assert.deepEqual(deltas,['I will check.']);assert.deepEqual(result.toolCalls,[{id:'call_1',name:'workspace_read',arguments:{path:'brief.txt'}}]);
  const input=responsesInput([{role:'assistant',content:result.text,providerItems:result.providerItems},{role:'tool',tool_call_id:'call_1',content:'The brief'}]);
  assert.equal(input[0].encrypted_content,'opaque-reasoning');assert.equal(input.at(-1).call_id,'call_1');assert.equal(input.at(-1).type,'function_call_output');
});

test('provider model testing performs discovery without paid inference and changing provider drops old keys',async t=>{
  const f=await fixture(t,(req,res)=>{assert.equal(req.method,'GET');assert.equal(req.url,'/v1/models');json(res,{data:[{id:'fixture-model',name:'Fixture model'}]});});
  const c=await connection(f);assert.equal((await f.providers.test(c)).connected,true);assert.equal(f.requests.length,1);
  assert.throws(()=>f.providers.validate({type:'anthropic',baseUrl:`f.origin/v1`},c));
  assert.throws(()=>f.providers.validate({type:'anthropic',baseUrl:`${f.origin}/v1`},c),/API key/);
  const changed=f.providers.validate({type:'ollama',baseUrl:`${f.origin}/v1`},c);assert.equal(changed.secret,undefined);
  assert.throws(()=>f.providers.validate({baseUrl:`${f.origin}/other`},c),/API key/);
  const disk=await fs.readFile(f.store.file,'utf8');assert.ok(!disk.includes(SECRET));
});

test('the turn context is sent last and cache hints never cover it',async t=>{
  const bodies=[];
  const f=await fixture(t,(req,res)=>{
    bodies.push(req.body);
    if(req.url==='/v1/responses')return sse(res,[{type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Done.'}]}],usage:{input_tokens:10,output_tokens:2}}}]);
    sse(res,[{type:'message_start',message:{usage:{input_tokens:4}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Done.'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}]);
  });
  const messages=[{role:'system',content:'Be precise.'},{role:'user',content:'First.'},{role:'assistant',content:'Earlier answer.'},{role:'user',content:'Read it.'},{role:'assistant',content:'',tool_calls:[{id:'read',type:'function',function:{name:'memory_search',arguments:'{}'}}]},{role:'tool',tool_call_id:'read',content:'Found it.'}];
  const turnContext='<turn_context>\nToday is 2026-10-27.\n</turn_context>';
  await f.providers.complete(await connection(f),{messages,turnContext,cacheKey:'abc123',tools:[]});
  const responses=bodies[0];
  assert.equal(responses.prompt_cache_key,'abc123');assert.equal(responses.instructions,'Be precise.');
  assert.deepEqual(responses.input.at(-1),{role:'user',content:turnContext});assert.equal(responses.input.at(-2).type,'function_call_output');
  await f.providers.complete({...await connection(f,'anthropic'),id:'provider_anthropic'},{messages,turnContext,cacheKey:'not a valid key!',tools:[]});
  const anthropic=bodies[1],last=anthropic.messages.at(-1).content;
  assert.deepEqual(anthropic.system,[{type:'text',text:'Be precise.',cache_control:{type:'ephemeral'}}]);
  // The turn context shares the last user message with the tool result, which carries the breakpoint instead.
  assert.deepEqual(last.map(block=>block.type),['tool_result','text']);assert.equal(last[1].text,turnContext);
  assert.equal(last[1].cache_control,undefined);assert.deepEqual(last[0].cache_control,{type:'ephemeral'});
  assert.equal(JSON.stringify(anthropic).split('cache_control').length-1,4);assert.equal(anthropic.prompt_cache_key,undefined);
  // The stored conversation is never extended by the turn context.
  assert.equal(messages.length,6);
});

test('model catalogs keep each model context window and owners can state one for a local service',async t=>{
  const f=await fixture(t,(req,res)=>json(res,{data:[{id:'wide',context_length:262_144},{id:'codex',context_window:272_000,max_context_window:900_000},{id:'silent'},{id:'odd',context_length:'many'}]}));
  const c=await connection(f,'openrouter'),{models}=await f.providers.models(c);
  assert.deepEqual(models.map(model=>[model.id,model.contextWindow]),[['wide',262_144],['codex',272_000],['silent',undefined],['odd',undefined]]);
  const local=f.providers.validate({type:'ollama',baseUrl:`${f.origin}/v1`,contextWindow:'32768'});assert.equal(local.contextWindow,32_768);
  assert.equal(f.providers.validate({contextWindow:''},local).contextWindow,undefined);
  assert.throws(()=>f.providers.validate({contextWindow:'12'},local),/Context window/);
});

test('Responses preserves streamed function calls when the completed envelope contains an empty output array',async t=>{
  const f=await fixture(t,(_req,res)=>sse(res,[{type:'response.output_item.added',output_index:0,item:{id:'fc_1',type:'function_call',call_id:'call_1',name:'workspace_read',arguments:''}},{type:'response.function_call_arguments.delta',output_index:0,item_id:'fc_1',delta:'{"path":'},{type:'response.function_call_arguments.delta',output_index:0,item_id:'fc_1',delta:'"qa/brief.txt"}'},{type:'response.function_call_arguments.done',output_index:0,item_id:'fc_1',arguments:'{"path":"qa/brief.txt"}'},{type:'response.completed',response:{status:'completed',output:[]}}]));
  const c=await connection(f),result=await f.providers.complete(c,{messages:[{role:'user',content:'Read qa/brief.txt'}]});
  assert.deepEqual(result.toolCalls,[{id:'call_1',name:'workspace_read',arguments:{path:'qa/brief.txt'}}]);assert.equal(result.finishReason,'tool_calls');
  const replay=responsesInput([{role:'assistant',content:'',providerItems:result.providerItems},{role:'tool',tool_call_id:'call_1',content:'exact file result'}]);assert.equal(replay[0].call_id,'call_1');assert.equal(replay[1].type,'function_call_output');assert.equal(f.requests.length,1);
});

test('Responses empty-output diagnostics contain only bounded shape metadata',async t=>{
  const f=await fixture(t,(_req,res)=>sse(res,[{type:'response.output_item.done',output_index:0,item:{type:'reasoning',encrypted_content:SECRET}},{type:'response.completed',response:{status:'completed',output:[]}}]));
  const c=await connection(f);await assert.rejects(f.providers.complete(c,{messages:[{role:'user',content:'A request'}]}),error=>{assert.match(error.message,/final items: 0; streamed items: 1; types: reasoning/);assert.match(error.message,/response.output_item.done/);assert.ok(!error.message.includes(SECRET));return true;});
  assert.deepEqual(responsesInput([{role:'assistant',content:'Keep this answer.',providerItems:[]}]),[{role:'assistant',content:'Keep this answer.'}]);
});

test('Anthropic native messages retain tool results and parse streamed tool JSON',async t=>{
  const f=await fixture(t,(req,res)=>{
    assert.equal(req.headers['x-api-key'],SECRET);assert.equal(req.headers['anthropic-version'],'2023-06-01');assert.equal(req.body.messages.at(-1).content[0].type,'tool_result');
    sse(res,[{type:'message_start',message:{usage:{input_tokens:4}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Checking.'}},{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'tool_anthropic',name:'memory_search',input:{}}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"query":'}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'"plans"}'}},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:3}},{type:'message_stop'}]);
  });
  const c=await connection(f,'anthropic');
  const result=await f.providers.complete(c,{messages:[{role:'system',content:'Be precise.'},{role:'user',content:'Remember my plan.'},{role:'assistant',content:'',tool_calls:[{id:'before',type:'function',function:{name:'memory_search',arguments:'{}'}}]},{role:'tool',tool_call_id:'before',content:'No matching memory.'}],tools:[]});
  assert.equal(result.text,'Checking.');assert.deepEqual(result.toolCalls,[{id:'tool_anthropic',name:'memory_search',arguments:{query:'plans'}}]);assert.equal(result.usage.output_tokens,3);
  assert.equal(anthropicMessages([{role:'user',content:'A'},{role:'user',content:'B'}]).length,1);
});

test('compatible APIs assemble tool fragments and refuse truncated streams or invalid arguments',async t=>{
  let truncated=false;
  const f=await fixture(t,(req,res)=>sse(res,[{choices:[{delta:{tool_calls:[{index:0,id:'compat_1',function:{name:'memory_set',arguments:'{"key":"'} }]}}]},...(!truncated?[{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'name","value":"Ada"}'}}]},finish_reason:'tool_calls'}]}]:[])]));
  const c=await connection(f,'custom');const result=await f.providers.complete(c,{messages:[{role:'user',content:'Remember Ada.'}],tools:[]});assert.equal(result.toolCalls[0].arguments.value,'Ada');
  truncated=true;await assert.rejects(f.providers.complete(c,{messages:[{role:'user',content:'Again'}]}),/before a final result/);
});

test('compatible providers admit multiple tool calls while the engine owns execution ordering',async t=>{
  const f=await fixture(t,(req,res)=>{assert.equal(req.body.parallel_tool_calls,true);json(res,{choices:[{message:{content:'',tool_calls:[{id:'read-a',type:'function',function:{name:'workspace_read',arguments:'{"path":"a.txt"}'}},{id:'read-b',type:'function',function:{name:'workspace_read',arguments:'{"path":"b.txt"}'}}]},finish_reason:'tool_calls'}]});});
  const c=await connection(f,'custom');
  const result=await f.providers.complete(c,{messages:[{role:'user',content:'Read two files.'}],tools:[{name:'workspace_read',description:'Read a file.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}]});
  assert.deepEqual(result.toolCalls.map(call=>call.id),['read-a','read-b']);assert.equal(result.finishReason,'tool_calls');
});

test('Anthropic tool results retain explicit failure metadata without altering successful results',()=>{
  const messages=anthropicMessages([{role:'tool',tool_call_id:'failed',content:'{"error":"Missing file"}',is_error:true},{role:'tool',tool_call_id:'success',content:'{"content":"Useful text"}'}]);
  assert.equal(messages.length,1);assert.equal(messages[0].role,'user');assert.equal(messages[0].content[0].is_error,true);assert.equal(messages[0].content[1].is_error,undefined);
  assert.equal(messages[0].content[0].tool_use_id,'failed');assert.equal(messages[0].content[1].tool_use_id,'success');
});

test('service transport refuses redirect credential forwarding and restricted destinations',async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(302,{location:'https://attacker.invalid/'});res.end();});
  await assert.rejects(serviceRequest(`${f.origin}/redirect`,{headers:{Authorization:`Bearer ${SECRET}`}}),/redirects/);
  assert.equal(f.requests.length,1);assert.throws(()=>validateServiceUrl('http://169.254.169.254/latest/meta-data'),/metadata/);assert.throws(()=>validateServiceUrl('https://192.168.0.1/v1'),/Private/);assert.throws(()=>validateServiceUrl('http://public.example/v1'),/HTTPS/);
  assert.throws(()=>validateServiceUrl('http://[::ffff:169.254.169.254]/latest',{allowPrivateHttp:true}),/metadata/);
  assert.throws(()=>validateServiceUrl('http://169.254.1.1/latest',{allowPrivateHttp:true}),/metadata/);
});

test('service transport resolves a hostname with Node autoSelectFamily lookup semantics',async t=>{
  const f=await fixture(t,(_req,res)=>json(res,{ok:true}));
  const result=await serviceRequest(f.origin.replace('127.0.0.1','localhost'));
  assert.equal(result.status,200);assert.equal(result.data.ok,true);
});

test('malformed service JSON reports safe protocol metadata without echoing its body',async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(`not JSON ${SECRET}`);});
  await assert.rejects(serviceRequest(`${f.origin}/malformed`),error=>{
    assert.match(error.message,/invalid JSON \(HTTP 200; Content-Type: application\/json; Content-Encoding: identity; Body format: text\)/);
    assert.ok(!error.message.includes(SECRET));return true;
  });
  assert.equal(f.requests.length,1);
});

test('Responses accepts successful SSE without MIME headers across BOM, UTF-8 and CRLF chunk boundaries',async t=>{
  const reply='Привіт 🌿',f=await fixture(t,async(_req,res)=>{
    res.writeHead(200);
    const body=Buffer.from(`\uFEFF: heartbeat\r\n\r\nevent: response.output_text.delta\r\ndata: ${JSON.stringify({type:'response.output_text.delta',delta:reply})}\r\n\r\ndata: ${JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:reply}]}]}})}\r\n\r\n`);
    for(let offset=0;offset<body.length;offset+=2){res.write(body.subarray(offset,offset+2));await new Promise(resolve=>setImmediate(resolve));}res.end();
  });
  const c=await connection(f),deltas=[],result=await f.providers.complete(c,{messages:[{role:'user',content:'Привіт'}],onDelta:delta=>deltas.push(delta)});
  assert.equal(result.text,reply);assert.deepEqual(deltas,[reply]);assert.equal(result.finishReason,'stop');assert.equal(f.requests.length,1);
});

test('missing or generic MIME types preserve JSON fallback and SSE sniffing remains opt-in',async t=>{
  const f=await fixture(t,(req,res)=>{if(req.url==='/events'){res.writeHead(200,{'content-type':'text/plain'});res.end('data: {"type":"ok"}\n\n');return;}res.writeHead(200);res.end('\uFEFF{"ok":"Привіт 🌿"}');});
  const jsonResult=await serviceRequest(`${f.origin}/json`,{onSSE:()=>assert.fail('JSON must not emit stream events')});assert.equal(jsonResult.streaming,false);assert.equal(jsonResult.data.ok,'Привіт 🌿');
  const events=[],eventResult=await serviceRequest(`${f.origin}/events`,{onSSE:event=>events.push(event)});assert.equal(eventResult.streaming,true);assert.deepEqual(events,[{type:'ok'}]);
  await assert.rejects(serviceRequest(`${f.origin}/events`),/invalid JSON/);
});

test('non-JSON HTTP errors retain status and never emit inference events or echo their body',async t=>{
  const f=await fixture(t,(req,res)=>{res.writeHead(429,req.url==='/sse'?{'content-type':'text/event-stream'}:{});res.end(`data: {"error":"${SECRET}"}\n\n`);});
  const result=await serviceRequest(f.origin,{onSSE:()=>assert.fail('HTTP errors must not emit model events')});assert.equal(result.status,429);assert.equal(result.streaming,false);
  assert.throws(()=>requireSuccess(result,'Provider'),error=>{assert.match(error.message,/Provider returned HTTP 429/);assert.ok(!error.message.includes(SECRET));return true;});
  const labeled=await serviceRequest(`${f.origin}/sse`,{onSSE:()=>assert.fail('SSE-labeled HTTP errors must not emit model events')});assert.equal(labeled.status,429);assert.equal(labeled.streaming,false);
  assert.throws(()=>requireSuccess(labeled,'Provider'),/Provider returned HTTP 429/);assert.equal(f.requests.length,2);
});

test('malformed event streams reject immediately without returning a completed response or replaying',async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: not-json-${SECRET}\n\n`);});
  await assert.rejects(serviceRequest(f.origin,{onSSE:()=>assert.fail('Invalid frames must not be emitted')}),error=>{assert.match(error.message,/invalid stream data/);assert.ok(!error.message.includes(SECRET));return true;});
  assert.equal(f.requests.length,1);
});

test('cancellation stops buffered stream callbacks synchronously and never replays the request',async t=>{
  const f=await fixture(t,(_req,res)=>sse(res,[{type:'first'},{type:'second'}])),controller=new AbortController(),received=[];
  await assert.rejects(serviceRequest(f.origin,{signal:controller.signal,onSSE:event=>{received.push(event.type);controller.abort(new Error('fixture cancellation'));}}),/fixture cancellation/);
  assert.deepEqual(received,['first']);assert.equal(f.requests.length,1);
});

test('sniffed event streams remain bounded before any oversized frame reaches a callback',async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(200);res.end(`data: ${JSON.stringify({type:'large',value:'x'.repeat(1024)})}\n\n`);});
  await assert.rejects(serviceRequest(f.origin,{maxBytes:64,onSSE:()=>assert.fail('Oversized streams must not emit events')}),/size limit/);assert.equal(f.requests.length,1);
});

test('ChatGPT registration verifies signed identity, seals credentials, rotates refresh once and rejects replay',async t=>{
  const pair=generateKeyPairSync('rsa',{modulusLength:2048}),publicJwk={...pair.publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
  let origin,auth,refreshCount=0,exchangeCount=0;
  const token=claims=>{const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key'})).toString('base64url'),body=Buffer.from(JSON.stringify(claims)).toString('base64url');return `${head}.${body}.${sign('RSA-SHA256',Buffer.from(`${head}.${body}`),pair.privateKey).toString('base64url')}`;};
  const f=await fixture(t,(req,res)=>{
    if(req.url==='/.well-known/openid-configuration')return json(res,{issuer:origin,token_endpoint:`${origin}/token`,jwks_uri:`${origin}/jwks`,revocation_endpoint:`${origin}/revoke`});
    if(req.url==='/jwks')return json(res,{keys:[publicJwk]});
    if(req.url==='/revoke')return json(res,{});
    const params=new URLSearchParams(req.raw);assert.equal(params.get('client_id'),'issued-test-client');
    if(params.get('grant_type')==='refresh_token'){refreshCount++;assert.equal(params.get('refresh_token'),'refresh-initial');return json(res,{access_token:'access-renewed',refresh_token:'refresh-replacement',token_type:'Bearer',expires_in:3600});}
    exchangeCount++;assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'),auth.searchParams.get('code_challenge'));
    json(res,{access_token:'access-initial',refresh_token:'refresh-initial',id_token:token({iss:origin,aud:'issued-test-client',sub:'account-1',email:'test@example.invalid',nonce:auth.searchParams.get('nonce'),exp:Math.floor(Date.now()/1000)+3600}),token_type:'Bearer',expires_in:3600,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'});
  });origin=f.origin;
  const providers=new Providers(f.store,{oauthIssuer:origin,allowTestOAuth:true,requestTimeout:1000}),c={...providers.validate({name:'ChatGPT',type:'chatgpt'}),id:'oauth_test'};await f.store.mutate(state=>state.connections.push(c));
  let detached=true,authorized=0;providers.oauth.credentialAccess=()=>detached?'Synthetic former-home credential guard':null;providers.oauth.onAuthorized=async id=>{assert.equal(id,c.id);authorized++;detached=false;};
  assert.equal(providers.loginStatus(c).status,'signed_out');
  const start=await providers.loginStart(c,{redirectUri:'http://127.0.0.1:4310/auth/callback'});auth=new URL(start.authUrl);assert.equal(auth.searchParams.get('client_id'),'dynamic_agent_client');assert.match(auth.searchParams.get('ext_agent_host_id'),/^urn:uuid:/);assert.equal(providers.loginStatus(c).status,'pending');
  await assert.rejects(providers.loginCallback({state:'wrong',code:'code',client_id:'issued-test-client'}),/does not match/);assert.equal(exchangeCount,0);assert.equal(authorized,0);
  await providers.loginCallback({state:auth.searchParams.get('state'),code:'good-code',client_id:'issued-test-client'});
  assert.equal(authorized,1);assert.equal(providers.loginStatus(c).status,'connected');assert.equal(await providers.oauth.bearer(c),'access-initial');assert.equal(exchangeCount,1);
  await assert.rejects(providers.loginCallback({state:auth.searchParams.get('state'),code:'good-code',client_id:'issued-test-client'}),/does not match/);
  const bundle=JSON.parse(f.store.unseal(c.oauthSecret));bundle.expiresAt=Date.now()-1;await f.store.mutate(()=>{c.oauthSecret=f.store.seal(JSON.stringify(bundle));});
  assert.deepEqual(await Promise.all([providers.oauth.bearer(c),providers.oauth.bearer(c)]),['access-renewed','access-renewed']);assert.equal(refreshCount,1);
  const disk=await fs.readFile(f.store.file,'utf8');assert.ok(!disk.includes('access-initial') && !disk.includes('refresh-initial') && !disk.includes('access-renewed'));
  await providers.logout(c);assert.equal(providers.loginStatus(c).status,'signed_out');
});

test('a ChatGPT request arriving while a renewal is in progress waits for it instead of failing or refreshing again',async t=>{
  let origin,refreshCount=0,release;
  const renewing=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,async(req,res)=>{
    if(req.url==='/.well-known/openid-configuration')return json(res,{issuer:origin,token_endpoint:`${origin}/token`,jwks_uri:`${origin}/jwks`});
    if(new URLSearchParams(req.raw).get('grant_type')==='refresh_token'){refreshCount++;await renewing;return json(res,{access_token:'access-renewed',refresh_token:'refresh-replacement',token_type:'Bearer',expires_in:3600});}
    json(res,{},404);
  });origin=f.origin;
  const providers=new Providers(f.store,{oauthIssuer:origin,allowTestOAuth:true,requestTimeout:2000});t.after(()=>providers.close());
  const bundle={access_token:'access-initial',refresh_token:'refresh-initial',client_id:'issued-test-client',scopes:['resource.invoke','chatgpt.tokens.use.direct'],expiresAt:Date.now()-1000,savedAt:new Date().toISOString()};
  const c={...providers.validate({name:'ChatGPT',type:'chatgpt'}),id:'oauth_concurrent',status:'connected',oauthAccount:{planEnabled:true,needsLogin:false},oauthSecret:f.store.seal(JSON.stringify(bundle))};
  await f.store.mutate(state=>{state.connections.push(c);});
  const stored=()=>JSON.parse(f.store.unseal(f.store.state.connections.find(item=>item.id===c.id).oauthSecret));
  const first=providers.oauth.bearer(c);
  while(stored().refreshState!=='in_progress')await new Promise(resolve=>setTimeout(resolve,5));
  // The stored bundle now says "in progress"; a second task (or a linked engine asking the home server) must wait for it.
  const second=providers.oauth.bearer(c);
  release();
  assert.deepEqual(await Promise.all([first,second]),['access-renewed','access-renewed']);
  assert.equal(refreshCount,1);assert.equal(stored().refresh_token,'refresh-replacement');assert.equal(stored().refreshState,undefined);
});
