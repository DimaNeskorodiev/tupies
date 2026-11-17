import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Providers,presetReasoning,reasoningForModel,reasonsByDefault,safeReasoning,effectiveReasoningEffort,connectionProblem,IDLE_REASONING_MS,IDLE_STANDARD_MS} from '../lib/providers.mjs';
import {contextLimits} from '../lib/context-budget.mjs';
import {LOCAL_DEFAULTS,isLocalConnection,localReasoning,localThinksByDefault,localCatalogFacts,largeLocalWindow,LOCAL_THINKING_PARAMETER} from '../lib/local-models.mjs';

// Fixture values only: no real account, key or workspace.
const QWEN='mlx-community/Qwen3.8-27B-4bit',KEY='fixture-local-key',messages=[{role:'user',content:'Synthetic local request.'}];
const sealed=value=>`sealed:${value}`;
function makeStore(connections=[]){return {state:{connections},redact:value=>String(value),seal:sealed,unseal:value=>String(value).replace(/^sealed:/,'')};}
/** A stand-in for lib/local-queue.mjs that records what it was asked to run. */
class RecordingQueue{constructor(){this.calls=[];}async run(key,options,fn){this.calls.push({key,...options});return fn();}}
async function server(t,handler){
  const requests=[];
  const s=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):null;requests.push({url:req.url,body,headers:req.headers});await handler(req,res,body,requests.length);});
  await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{s.closeAllConnections();await new Promise(resolve=>s.close(resolve));});
  return {origin:`http://127.0.0.1:${s.address().port}`,requests};
}
const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const sse=(res,events)=>{res.writeHead(200,{'content-type':'text/event-stream'});for(const event of events)res.write(`data: ${JSON.stringify(event)}\n\n`);res.end('data: [DONE]\n\n');};
const done={choices:[{message:{role:'assistant',content:'Done.'},finish_reason:'stop'}]};
function local(t,origin,{type='mlx',options={},...fields}={}){
  const connection={id:`local-${type}`,type,name:'Local fixture',baseUrl:`${origin}/v1`,defaultModel:QWEN,maxOutputTokens:4096,...fields};
  const providers=new Providers(makeStore([connection]),{localQueue:new RecordingQueue(),...options});t.after(()=>providers.close());
  return {providers,connection};
}

test('MLX and Ollama are local presets; MLX needs no key and sends one as Bearer when set',async t=>{
  const providers=new Providers(makeStore());t.after(()=>providers.close());
  const catalog=providers.catalog(),mlx=catalog.find(item=>item.type==='mlx'),ollama=catalog.find(item=>item.type==='ollama');
  assert.deepEqual({name:mlx.name,baseUrl:mlx.baseUrl,auth:mlx.auth,keyOptional:mlx.keyOptional,transport:mlx.transport,local:mlx.local},{name:'MLX LM (Mac)',baseUrl:'http://127.0.0.1:8080/v1',auth:'none',keyOptional:true,transport:'chat-completions',local:true});
  assert.equal(ollama.local,true);
  for(const item of catalog.filter(item=>!['mlx','ollama'].includes(item.type)))assert.equal(item.local,undefined,item.type);
  const open=providers.validate({type:'mlx'});assert.equal(open.baseUrl,'http://127.0.0.1:8080/v1');assert.equal(open.secret,undefined);
  assert.deepEqual(await providers.headers({...open,id:'mlx-open'}),{});assert.equal(connectionProblem(open),'');
  const keyed=providers.validate({type:'mlx',apiKey:KEY});assert.equal(keyed.secret,sealed(KEY));
  assert.deepEqual(await providers.headers({...keyed,id:'mlx-keyed'}),{Authorization:`Bearer ${KEY}`});
  assert.equal(isLocalConnection(open),true);
  // Sampling: automatic (model card) or the runtime's own.
  assert.equal(providers.validate({type:'mlx',sampling:'runtime'}).sampling,'runtime');
  assert.equal(Object.hasOwn(providers.validate({sampling:'auto'},{...open,sampling:'runtime'}),'sampling'),false);
  assert.throws(()=>providers.validate({type:'mlx',sampling:'greedy'}),/Sampling must be/);
});

test('Qwen3.8 on a local runtime is a thinking model with none…xhigh efforts and the reasoning idle allowance',()=>{
  const mlx={type:'mlx',baseUrl:'http://127.0.0.1:8080/v1'},loopback={type:'custom',baseUrl:'http://localhost:8080/v1'},ollama={type:'ollama',baseUrl:'http://127.0.0.1:11434/v1'};
  const expected={supported:true,efforts:['none','low','medium','xhigh'],defaultEffort:'xhigh',parameter:LOCAL_THINKING_PARAMETER,source:'preset'};
  for(const connection of [mlx,loopback]) {
    assert.deepEqual(presetReasoning(connection,QWEN),expected,connection.type);
    assert.deepEqual(reasoningForModel(connection,QWEN),expected,connection.type);
    assert.equal(reasonsByDefault(connection,QWEN),true);
    // A capability stored on the catalog record survives the outbound recheck.
    assert.deepEqual(safeReasoning(connection.type,expected),expected);
    // The automatic preference sends nothing, so the family default (thinking on, xhigh) applies.
    assert.equal(effectiveReasoningEffort('auto',expected),'');assert.equal(effectiveReasoningEffort('none',expected),'none');assert.equal(effectiveReasoningEffort('high',expected),'');
  }
  for(const id of ['qwen3.8:27b','Qwen/Qwen3.8-27B','qwen3.8'])assert.equal(localReasoning(mlx,id)?.parameter,LOCAL_THINKING_PARAMETER,id);
  // Ollama thinks by default but has no thinking control on /v1 yet; unknown families and remote hosts get nothing.
  assert.equal(presetReasoning(ollama,QWEN),null);assert.equal(reasonsByDefault(ollama,QWEN),true);assert.equal(localThinksByDefault(ollama,QWEN),true);
  assert.equal(presetReasoning(mlx,'llama-3.3-70b'),null);assert.equal(reasonsByDefault(mlx,'llama-3.3-70b'),false);
  assert.equal(presetReasoning({type:'custom',baseUrl:'https://inference.example.test/v1'},QWEN),null);assert.equal(reasonsByDefault({type:'custom',baseUrl:'https://inference.example.test/v1'},QWEN),false);
  assert.equal(presetReasoning({type:'openrouter'},'qwen/qwen3.8-27b')?.parameter,'reasoning');
  assert.equal(safeReasoning('openai',expected).supported,false);
  const providers=new Providers(makeStore());
  assert.equal(providers.idleTimeout(mlx,QWEN,reasoningForModel(mlx,QWEN)),IDLE_REASONING_MS);
  assert.equal(providers.idleTimeout(ollama,QWEN,reasoningForModel(ollama,QWEN)),IDLE_REASONING_MS);
  assert.equal(providers.idleTimeout(mlx,'llama-3.3-70b',reasoningForModel(mlx,'llama-3.3-70b')),IDLE_STANDARD_MS);
});

test('local requests carry the thinking switch, effort, model-card sampling and the thinking output floor',async t=>{
  const f=await server(t,(_req,res)=>json(res,done));
  const {providers,connection}=local(t,f.origin);
  const body=async request=>{await providers.complete(connection,{messages,...request});return f.requests.at(-1).body;};
  const auto=await body({});
  assert.deepEqual(auto.chat_template_kwargs,{enable_thinking:true});assert.equal(auto.reasoning_effort,undefined);
  assert.deepEqual([auto.temperature,auto.top_p,auto.top_k,auto.min_p,auto.presence_penalty],[1.0,0.95,20,0,0]);
  assert.equal(auto.max_tokens,LOCAL_DEFAULTS.thinkingOutputFloor);
  const low=await body({reasoningEffort:'low'});
  assert.deepEqual(low.chat_template_kwargs,{enable_thinking:true});assert.equal(low.reasoning_effort,'low');assert.equal(low.max_tokens,LOCAL_DEFAULTS.thinkingOutputFloor);
  // Reviews and other engine work: thinking off, plain sampling, the connection's own output limit.
  const off=await body({reasoningEffort:'none',maxOutputTokens:2000});
  assert.deepEqual(off.chat_template_kwargs,{enable_thinking:false});assert.equal(off.reasoning_effort,undefined);
  assert.deepEqual([off.temperature,off.top_p,off.top_k,off.min_p,off.presence_penalty],[0.7,0.8,20,0,1.5]);assert.equal(off.max_tokens,2000);
  // A run's captured capability that predates the preset does not stop the explicit switch.
  const stale=await body({reasoningCapabilities:{supported:false,efforts:[],defaultEffort:'',parameter:null,source:'unavailable'}});
  assert.deepEqual(stale.chat_template_kwargs,{enable_thinking:true});
  await assert.rejects(providers.complete(connection,{messages,reasoningEffort:'high'}),/does not advertise/);
  // The owner kept the runtime's sampling.
  const runtime=local(t,f.origin,{sampling:'runtime',id:'local-runtime-sampling'});
  await runtime.providers.complete(runtime.connection,{messages});
  assert.equal(f.requests.at(-1).body.temperature,undefined);assert.deepEqual(f.requests.at(-1).body.chat_template_kwargs,{enable_thinking:true});
});

test('Ollama and unknown local families get no thinking fields, and thinking off from engine work is never refused',async t=>{
  const f=await server(t,(_req,res)=>json(res,done));
  const ollama=local(t,f.origin,{type:'ollama'});
  await ollama.providers.complete(ollama.connection,{messages});
  let sent=f.requests.at(-1).body;
  assert.equal(sent.chat_template_kwargs,undefined);assert.equal(sent.reasoning_effort,undefined);assert.equal(sent.temperature,1.0);assert.equal(sent.max_tokens,LOCAL_DEFAULTS.thinkingOutputFloor);
  await ollama.providers.complete(ollama.connection,{messages,reasoningEffort:'none'});
  // Ollama's /v1 has no thinking control yet, so 'none' falls back to the runtime default: it still thinks and gets room.
  sent=f.requests.at(-1).body;assert.equal(sent.chat_template_kwargs,undefined);assert.equal(sent.temperature,1.0);assert.equal(sent.max_tokens,LOCAL_DEFAULTS.thinkingOutputFloor);
  const unknown=local(t,f.origin,{type:'custom',id:'local-unknown',defaultModel:'llama-3.3-70b'});
  await unknown.providers.complete(unknown.connection,{messages,reasoningEffort:'none'});
  sent=f.requests.at(-1).body;
  for(const field of ['chat_template_kwargs','reasoning_effort','temperature','top_k','reasoning','thinking'])assert.equal(sent[field],undefined,field);
  assert.equal(sent.max_tokens,4096);
});

test('cloud connections never receive local thinking or sampling fields and are not queued',async t=>{
  const queue=new RecordingQueue(),connection={id:'cloud',type:'openrouter',name:'Cloud',baseUrl:'https://openrouter.ai/api/v1',defaultModel:'qwen/qwen3.8-27b',secret:sealed(KEY)};
  const providers=new Providers(makeStore([connection]),{localQueue:queue});t.after(()=>providers.close());
  const sent=[];providers.request=async(_connection,_path,options)=>{sent.push(options);return {status:200,streaming:false,data:done};};
  await providers.complete(connection,{messages});await providers.complete(connection,{messages,reasoningEffort:'none'});
  for(const {body} of sent)for(const field of ['chat_template_kwargs','temperature','top_p','top_k','min_p','presence_penalty'])assert.equal(body[field],undefined,field);
  assert.deepEqual(sent[1].body.reasoning,{effort:'none'});
  assert.equal(queue.calls.length,0);
  // A cloud model without 'none' still refuses it.
  const plain={...connection,id:'cloud-plain',type:'groq',baseUrl:'https://api.groq.com/openai/v1',defaultModel:'llama-3.3-70b-versatile'};
  await assert.rejects(providers.complete(plain,{messages,reasoningEffort:'none'}),/does not advertise/);
});

test('local completions wait in the per-connection queue with their priority',async t=>{
  const f=await server(t,(_req,res)=>json(res,done));
  const {providers,connection}=local(t,f.origin),queue=providers.localQueue,signal=new AbortController().signal;
  await providers.complete(connection,{messages});
  await providers.reviewMemory(connection,{messages,priority:'background',reasoningEffort:'none',signal});
  assert.deepEqual(queue.calls.map(({key,priority})=>({key,priority})),[{key:'local-mlx',priority:'interactive'},{key:'local-mlx',priority:'background'}]);
  assert.equal(queue.calls[1].signal,signal);
  await assert.rejects(providers.complete(connection,{messages,priority:'urgent'}),/priority/);
  assert.equal(queue.calls.length,2);assert.equal(f.requests.length,2);
});

test('local inference gets the long total limit and a first-event allowance; catalog and cloud requests keep theirs',async t=>{
  const seen=[];
  const fake=async(_url,options)=>{seen.push(options);return {status:200,streaming:false,data:options.method==='GET'?{data:[]}:done,headers:{}};};
  const providers=new Providers(makeStore(),{serviceRequest:fake,localQueue:new RecordingQueue()});t.after(()=>providers.close());
  const mlx={id:'mlx-limits',type:'mlx',baseUrl:'http://127.0.0.1:8080/v1',defaultModel:QWEN};
  await providers.complete(mlx,{messages});
  assert.equal(seen[0].timeoutMs,LOCAL_DEFAULTS.totalTimeoutMs);assert.equal(seen[0].firstEventTimeoutMs,LOCAL_DEFAULTS.firstTokenTimeoutMs);assert.equal(seen[0].idleTimeoutMs,IDLE_REASONING_MS);
  // A caller's own deadline (action review) bounds both.
  await providers.complete(mlx,{messages,timeoutMs:45_000,reasoningEffort:'none'});
  assert.equal(seen[1].timeoutMs,45_000);assert.equal(seen[1].firstEventTimeoutMs,45_000);
  await providers.models(mlx);
  assert.equal(seen[2].timeoutMs,120_000);assert.equal(seen[2].firstEventTimeoutMs,undefined);
  const cloud={id:'cloud-limits',type:'openrouter',baseUrl:'https://openrouter.ai/api/v1',defaultModel:'openai/gpt-5',secret:sealed(KEY)};
  await providers.complete(cloud,{messages});
  assert.equal(seen[3].timeoutMs,900_000);assert.equal(seen[3].firstEventTimeoutMs,undefined);
  const configured=new Providers(makeStore(),{serviceRequest:fake,localQueue:new RecordingQueue(),localInferenceTimeout:60_000,firstEventTimeout:90_000});t.after(()=>configured.close());
  await configured.complete(mlx,{messages});
  assert.equal(seen[4].timeoutMs,60_000);assert.equal(seen[4].firstEventTimeoutMs,60_000);
});

test('whitespace-only text next to tool calls is empty and never streamed ahead of the call',async t=>{
  const call={index:0,id:'call_fixture',type:'function',function:{name:'workspace_read',arguments:'{"path":"notes.md"}'}};
  const f=await server(t,(_req,res,body,count)=>{
    if(!body.stream)return json(res,{choices:[{message:{role:'assistant',content:'\n\n',tool_calls:[call]},finish_reason:'tool_calls'}]});
    if(count===1)return sse(res,[{choices:[{delta:{role:'assistant',content:'\n'}}]},{choices:[{delta:{content:'\n'}}]},{choices:[{delta:{tool_calls:[call]}}]},{choices:[{delta:{},finish_reason:'tool_calls'}]}]);
    if(count===2)return sse(res,[{choices:[{delta:{content:'\n\n'}}]},{choices:[{delta:{content:'Hello'}}]},{choices:[{delta:{content:' there.'},finish_reason:'stop'}]}]);
    return sse(res,[{choices:[{delta:{content:'  '},finish_reason:'stop'}]}]);
  });
  const {providers,connection}=local(t,f.origin);
  const run=async()=>{const deltas=[];const result=await providers.complete(connection,{messages,onDelta:value=>deltas.push(value)});return {result,deltas};};
  let {result,deltas}=await run();
  assert.equal(result.text,'');assert.deepEqual(deltas,[]);assert.equal(result.toolCalls[0].name,'workspace_read');assert.equal(result.finishReason,'tool_calls');
  ({result,deltas}=await run());
  assert.equal(result.text,'\n\nHello there.');assert.equal(deltas.join(''),'\n\nHello there.');
  // Whitespace without a tool call is still the answer, delivered at the end.
  ({result,deltas}=await run());
  assert.equal(result.text,'  ');assert.deepEqual(deltas,['  ']);
  // Non-streaming responses follow the same rule.
  providers.request=async(...args)=>{const response=await Providers.prototype.request.apply(providers,[args[0],args[1],{...args[2],body:{...args[2].body,stream:false}}]);return response;};
  ({result,deltas}=await run());
  assert.equal(result.text,'');assert.deepEqual(deltas,[]);assert.equal(result.toolCalls.length,1);
});

test('a local context window defaults to 32K below the native window and flags large windows for a memory warning',()=>{
  const mlx={type:'mlx',baseUrl:'http://127.0.0.1:8080/v1'};
  let limits=contextLimits(mlx,QWEN);
  assert.equal(limits.window,LOCAL_DEFAULTS.contextWindow);assert.equal(limits.source,'local-default');assert.equal(limits.local,true);assert.equal(limits.memoryWarning,false);assert.equal(limits.small,true);
  // A family preset's native window from the catalog is a ceiling, not a size.
  limits=contextLimits({...mlx,models:[{id:QWEN,contextWindow:262_144,contextSource:'preset'}]},QWEN);
  assert.equal(limits.window,32_768);assert.equal(limits.source,'local-default');
  limits=contextLimits({...mlx,models:[{id:'tiny',contextWindow:16_384,contextSource:'preset'}]},'tiny');
  assert.equal(limits.window,16_384);
  assert.equal(contextLimits({type:'ollama',baseUrl:'http://127.0.0.1:11434/v1'},'llama-3.1-8b').window,32_768);
  // The owner's setting and a provider-declared window win.
  limits=contextLimits({...mlx,contextWindow:65_536},QWEN);assert.equal(limits.window,65_536);assert.equal(limits.source,'connection');assert.equal(limits.memoryWarning,true);
  limits=contextLimits({...mlx,models:[{id:QWEN,contextWindow:131_072}]},QWEN);assert.equal(limits.window,131_072);assert.equal(limits.source,'provider');assert.equal(limits.memoryWarning,true);
  assert.equal(contextLimits({...mlx,contextWindow:65_536},QWEN,{contextLimit:'128k'}).memoryWarning,true);
  // Cloud and remote compatible connections keep the 128K assumption and the old result shape.
  limits=contextLimits({type:'custom',baseUrl:'https://inference.example.test/v1'},QWEN);
  assert.equal(limits.window,128_000);assert.equal(limits.source,'default');assert.equal(Object.hasOwn(limits,'local'),false);assert.equal(Object.hasOwn(limits,'memoryWarning'),false);
  assert.equal(contextLimits({type:'openrouter',models:[{id:QWEN,contextWindow:262_144,contextSource:'preset'}]},QWEN).window,262_144);
  assert.equal(largeLocalWindow(mlx,LOCAL_DEFAULTS.largeWindowWarning),true);assert.equal(largeLocalWindow({type:'openai'},1_000_000),false);
});

test('an MLX model list gets window, images and reasoning from the family preset',async t=>{
  const f=await server(t,(_req,res)=>json(res,{object:'list',data:[{id:QWEN,object:'model',created:1},{id:'mlx-community/bge-small-en'},{id:'qwen3.8-declared',context_length:131_072,input_modalities:['text']}]}));
  const {providers,connection}=local(t,f.origin);
  const {models}=await providers.models(connection);
  const [qwen,embedding,declared]=models;
  assert.equal(qwen.contextWindow,262_144);assert.equal(qwen.contextSource,'preset');assert.deepEqual(qwen.images,{supported:true,source:'preset'});
  assert.equal(qwen.reasoning.parameter,LOCAL_THINKING_PARAMETER);assert.equal(qwen.reasoning.defaultEffort,'xhigh');
  assert.equal(embedding.contextWindow,undefined);assert.equal(embedding.images,undefined);assert.equal(embedding.reasoning.supported,false);
  assert.equal(declared.contextWindow,131_072);assert.equal(declared.contextSource,undefined);assert.deepEqual(declared.images,{supported:false,source:'provider'});
  assert.deepEqual(localCatalogFacts(connection,QWEN),{family:'qwen3.8',contextWindow:262_144,images:true,tools:true,reasoning:true});
  assert.equal(localCatalogFacts({type:'openrouter'},QWEN),null);
});

test('the local connection test checks prefix reuse with two tiny thinking-off requests and never fails on it',async t=>{
  const catalog={data:[{id:QWEN}]};
  await t.test('reuse reported',async t=>{
    const f=await server(t,(req,res,_body,count)=>req.url.endsWith('/models')?json(res,catalog):json(res,{...done,usage:{prompt_tokens:610,completion_tokens:1,prompt_tokens_details:{cached_tokens:count===2?0:608}}}));
    const {providers,connection}=local(t,f.origin);
    const result=await providers.test(connection);
    assert.deepEqual(result.prefixCache,{supported:true,cachedTokens:608});assert.equal(result.connected,true);assert.equal(result.models.length,1);
    const probes=f.requests.filter(item=>item.url.endsWith('/chat/completions'));
    assert.equal(probes.length,2);assert.deepEqual(probes[0].body,probes[1].body);
    assert.equal(probes[0].body.max_tokens,1);assert.equal(probes[0].body.stream,false);assert.deepEqual(probes[0].body.chat_template_kwargs,{enable_thinking:false});
    assert.equal(providers.localQueue.calls.length,0);
  });
  await t.test('no reuse',async t=>{
    const f=await server(t,(req,res)=>req.url.endsWith('/models')?json(res,catalog):json(res,{...done,usage:{prompt_tokens:610,prompt_tokens_details:{cached_tokens:0}}}));
    const {providers,connection}=local(t,f.origin);
    assert.deepEqual((await providers.test(connection)).prefixCache,{supported:false,cachedTokens:0});
  });
  await t.test('no usage details',async t=>{
    const f=await server(t,(req,res)=>req.url.endsWith('/models')?json(res,catalog):json(res,done));
    const {providers,connection}=local(t,f.origin);
    assert.deepEqual((await providers.test(connection)).prefixCache,{supported:null,cachedTokens:null});
  });
  await t.test('runtime error',async t=>{
    const f=await server(t,(req,res)=>req.url.endsWith('/models')?json(res,catalog):json(res,{error:{message:'model not loaded'}},500));
    const {providers,connection}=local(t,f.origin);
    const result=await providers.test(connection);
    assert.equal(result.connected,true);assert.equal(result.prefixCache.supported,null);assert.match(result.prefixCache.error,/HTTP 500/);
  });
  await t.test('silent runtime is bounded',async t=>{
    const f=await server(t,(req,res)=>{if(req.url.endsWith('/models'))return json(res,catalog);});
    const {providers,connection}=local(t,f.origin,{options:{prefixCacheTimeout:100}});
    const started=Date.now(),result=await providers.test(connection);
    assert.equal(result.prefixCache.supported,null);assert.ok(Date.now()-started<5000);
  });
  await t.test('skipped without a default model',async t=>{
    const f=await server(t,(req,res)=>json(res,catalog));
    const {providers,connection}=local(t,f.origin,{defaultModel:''});
    const result=await providers.test(connection);
    assert.equal(Object.hasOwn(result,'prefixCache'),false);assert.equal(f.requests.length,1);
  });
});
