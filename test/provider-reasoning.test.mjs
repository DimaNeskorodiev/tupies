import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {Providers,reasoningForModel,effectiveReasoningEffort,presetReasoning,anthropicThinkingRequest} from '../lib/providers.mjs';

const SECRET='provider-reasoning-fixture-private-canary',messages=[{role:'user',content:'A synthetic request.'}];
const sse=(res,events)=>{res.writeHead(200,{'content-type':'text/event-stream'});for(const event of events)res.write(`data: ${JSON.stringify(event)}\n\n`);res.end();};
const json=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
async function fixture(t,{type='custom',models,maxOutputTokens}={}){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-provider-reasoning-')),store=await new Store(directory).init(),requests=[];
  const state={handler:(_req,res)=>json(res,{choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]})};
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push({url:req.url,body:JSON.parse(raw || '{}')});state.handler(req,res,requests.at(-1).body);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const providers=new Providers(store,{requestTimeout:5000,allowTestOAuth:true});
  const connection={id:'fixture',type,name:'Fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,defaultModel:'fixture-model',secret:store.seal(SECRET),...(models?{models}:{}),...(maxOutputTokens?{maxOutputTokens}:{})};
  await store.mutate(next=>{next.connections.push(connection);});
  t.after(async()=>{await providers.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  return {store,providers,connection,requests,state};
}
const ordered=()=>{const log=[];return {log,onDelta:text=>{log.push(['text',text]);},onReasoning:text=>{log.push(['reasoning',text]);}};};

test('chat-completions streams reasoning_content, reasoning and reasoning_details in order with text and never echoes it back',async t=>{
  const f=await fixture(t);
  f.state.handler=(_req,res)=>sse(res,[
    {choices:[{delta:{reasoning_content:'Weigh A. '}}]},
    {choices:[{delta:{reasoning:'Then B. ',reasoning_details:[{type:'reasoning.text',text:'Then B. '}]}}]},
    {choices:[{delta:{reasoning_details:[{type:'reasoning.summary',summary:`Key ${SECRET}. `},{type:'reasoning.encrypted',data:'opaque'}]}}]},
    {choices:[{delta:{content:'Answer'}}]},
    {choices:[{delta:{reasoning_content:'late.'}}]},
    {choices:[{delta:{content:' done.'},finish_reason:'stop'}]}
  ]);
  const consumer=ordered(),result=await f.providers.complete(f.connection,{messages,...consumer});
  assert.deepEqual(consumer.log,[['reasoning','Weigh A. '],['reasoning','Then B. '],['reasoning','Key [redacted]. '],['text','Answer'],['reasoning','late.'],['text',' done.']]);
  assert.equal(result.text,'Answer done.');
  assert.deepEqual(result.reasoning,{text:'Weigh A. Then B. Key [redacted]. late.',chars:`Weigh A. Then B. Key ${SECRET}. late.`.length});
  assert.deepEqual(Object.keys(result).sort(),['finishReason','reasoning','text','toolCalls','usage']);
  // A later request carries only canonical fields, never the reasoning of an earlier turn.
  f.state.handler=(_req,res)=>sse(res,[{choices:[{delta:{content:'Again.'},finish_reason:'stop'}]}]);
  const second=await f.providers.complete(f.connection,{messages:[...messages,{role:'assistant',content:'Answer done.',reasoning:'x',reasoning_content:'x',providerItems:[{type:'reasoning_content',text:'x'}]},{role:'user',content:'More.'}]});
  assert.equal(second.reasoning,undefined);
  assert.ok(f.requests.at(-1).body.messages.every(message=>Object.keys(message).every(key=>['role','content','tool_calls','tool_call_id'].includes(key))));
});

test('reasoning on the result is bounded to head and tail with the full length',async t=>{
  const f=await fixture(t),long='a'.repeat(6000)+'b'.repeat(4000)+'c'.repeat(2000);
  f.state.handler=(_req,res)=>sse(res,[{choices:[{delta:{reasoning_content:long.slice(0,7000)}}]},{choices:[{delta:{reasoning_content:long.slice(7000)}}]},{choices:[{delta:{content:'ok'},finish_reason:'stop'}]}]);
  const result=await f.providers.complete(f.connection,{messages});
  assert.equal(result.reasoning.chars,12000);assert.equal(result.reasoning.text,`${'a'.repeat(6000)} […] ${'c'.repeat(2000)}`);
  f.state.handler=(_req,res)=>sse(res,[{choices:[{delta:{content:'plain'},finish_reason:'stop'}]}]);
  assert.equal(Object.hasOwn(await f.providers.complete(f.connection,{messages}),'reasoning'),false);
});

test('Responses emits reasoning summary deltas in order and keeps them out of the text',async t=>{
  const f=await fixture(t,{type:'openai'});
  f.state.handler=(_req,res)=>sse(res,[
    {type:'response.reasoning_summary_part.added'},{type:'response.reasoning_summary_text.delta',delta:'Plan one.'},
    {type:'response.reasoning_summary_part.added'},{type:'response.reasoning_summary_text.delta',delta:'Plan two.'},
    {type:'response.output_text.delta',delta:'Result.'},
    {type:'response.completed',response:{status:'completed',output:[{type:'reasoning',summary:[]},{type:'message',content:[{type:'output_text',text:'Result.'}]}]}}
  ]);
  const consumer=ordered(),result=await f.providers.complete(f.connection,{messages,...consumer});
  assert.deepEqual(consumer.log,[['reasoning','Plan one.'],['reasoning','\n\n'],['reasoning','Plan two.'],['text','Result.']]);
  assert.equal(result.text,'Result.');assert.deepEqual(result.reasoning,{text:'Plan one.\n\nPlan two.',chars:20});
});

test('Anthropic emits thinking deltas in order and keeps the thinking block for continuation',async t=>{
  const f=await fixture(t,{type:'anthropic'});
  f.state.handler=(_req,res)=>sse(res,[
    {type:'message_start',message:{usage:{input_tokens:3}}},
    {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},
    {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Consider. '}},
    {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Decide.'}},
    {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'sig'}},
    {type:'content_block_start',index:1,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Answer.'}},
    {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:5}},{type:'message_stop'}
  ]);
  const consumer=ordered(),result=await f.providers.complete(f.connection,{model:'claude-sonnet-4-5',messages,...consumer});
  assert.deepEqual(consumer.log,[['reasoning','Consider. '],['reasoning','Decide.'],['text','Answer.']]);
  assert.deepEqual(result.reasoning,{text:'Consider. Decide.',chars:17});assert.equal(result.providerItems[0].thinking,'Consider. Decide.');assert.equal(result.providerItems[0].signature,'sig');
});

test('OpenRouter maps efforts to reasoning.effort from its catalog or the preset family, and a stale record does not block it',async t=>{
  const openrouter={type:'openrouter',baseUrl:'https://openrouter.ai/api/v1'};
  assert.deepEqual(presetReasoning(openrouter,'deepseek/deepseek-v4.1-flash-1017').efforts,['none','low','medium','high']);
  assert.equal(presetReasoning(openrouter,'mistralai/mistral-7b-instruct'),null);
  // A refreshed catalog that lists no reasoning wins over the family guess.
  assert.equal(reasoningForModel({...openrouter,models:[{id:'deepseek/deepseek-v4.1-flash-1017',reasoning:{supported:false,efforts:[],defaultEffort:'',parameter:null,source:'provider'}}]},'deepseek/deepseek-v4.1-flash-1017').supported,false);
  const stale={supported:false,efforts:[],defaultEffort:'',parameter:null,source:'unavailable'};
  const f=await fixture(t,{type:'openrouter',models:[{id:'deepseek/deepseek-v4.1-flash-1017',name:'DeepSeek',reasoning:stale}]});
  f.state.handler=(_req,res)=>sse(res,[{choices:[{delta:{content:'ok'},finish_reason:'stop'}]}]);
  // The engine passes the stale capability captured earlier; the current preset still allows the effort.
  await f.providers.complete(f.connection,{model:'deepseek/deepseek-v4.1-flash-1017',messages,reasoningEffort:'medium',reasoningCapabilities:stale});
  assert.deepEqual(f.requests.at(-1).body.reasoning,{effort:'medium'});assert.equal(f.requests.at(-1).body.reasoning_effort,undefined);
  assert.equal(f.requests.at(-1).body.max_tokens,16_384);
  await f.providers.complete(f.connection,{model:'deepseek/deepseek-v4.1-flash-1017',messages,reasoningEffort:'none'});
  assert.deepEqual(f.requests.at(-1).body.reasoning,{effort:'none'});assert.equal(f.requests.at(-1).body.max_tokens,4096);
  await assert.rejects(f.providers.complete(f.connection,{model:'mistralai/mistral-7b-instruct',messages,reasoningEffort:'high'}),/does not advertise this reasoning effort/);
  // Catalog listing: reasoning object with supported efforts and mandatory reasoning.
  f.state.handler=(_req,res)=>json(res,{data:[{id:'x/mandatory',reasoning:{supported_efforts:['high','medium','low','none'],mandatory:true,default_effort:'medium'}},{id:'x/params',supported_parameters:['reasoning','tools']},{id:'deepseek/deepseek-r1',supported_parameters:['tools']}]});
  const {models}=await f.providers.models(f.connection);
  assert.deepEqual(models[0].reasoning,{supported:true,efforts:['high','medium','low'],defaultEffort:'medium',parameter:'reasoning',source:'provider'});
  assert.deepEqual(models[1].reasoning.efforts,['none','low','medium','high']);assert.equal(models[2].reasoning.supported,false);
});

test('Anthropic thinking: budgets with a max_tokens floor on 3.7-4.5, adaptive effort on 4.6+, nothing for unknown families',async t=>{
  assert.deepEqual(anthropicThinkingRequest('claude-sonnet-4-5-20250929','medium'),{body:{thinking:{type:'enabled',budget_tokens:8192}},minTokens:8192+4096});
  assert.deepEqual(anthropicThinkingRequest('claude-3-7-sonnet-20250219','none'),{body:{},minTokens:0});
  assert.deepEqual(anthropicThinkingRequest('claude-opus-4-7','xhigh').body,{thinking:{type:'adaptive',display:'summarized'},output_config:{effort:'xhigh'}});
  assert.deepEqual(anthropicThinkingRequest('claude-fable-5-1','').body,{thinking:{type:'adaptive',display:'summarized'}});
  assert.deepEqual(anthropicThinkingRequest('claude-opus-4-6','').body,{});
  assert.deepEqual(presetReasoning({type:'anthropic'},'claude-opus-4-6').efforts,['none','low','medium','high','max']);
  assert.deepEqual(presetReasoning({type:'anthropic'},'claude-fable-5-1').efforts,['low','medium','high','xhigh','max']);
  assert.deepEqual(presetReasoning({type:'anthropic'},'claude-haiku-4-5-20251001').efforts,['none','low','medium','high','xhigh']);
  assert.equal(presetReasoning({type:'anthropic'},'claude-3-5-sonnet-20241022'),null);
  const f=await fixture(t,{type:'anthropic',maxOutputTokens:8000});
  f.state.handler=(_req,res)=>json(res,{content:[{type:'thinking',thinking:'Brief.',signature:'s'},{type:'text',text:'Done.'}],stop_reason:'end_turn',usage:{output_tokens:3}});
  const consumer=ordered(),result=await f.providers.complete(f.connection,{model:'claude-sonnet-4-5',messages,reasoningEffort:'xhigh',...consumer});
  let body=f.requests.at(-1).body;
  assert.deepEqual(body.thinking,{type:'enabled',budget_tokens:32768});assert.equal(body.max_tokens,32768+4096);assert.equal(body.temperature,undefined);assert.equal(body.top_k,undefined);
  assert.deepEqual(consumer.log,[['reasoning','Brief.'],['text','Done.']]);assert.deepEqual(result.reasoning,{text:'Brief.',chars:6});
  await f.providers.complete(f.connection,{model:'claude-sonnet-4-5',messages,reasoningEffort:'low'});
  body=f.requests.at(-1).body;assert.deepEqual(body.thinking,{type:'enabled',budget_tokens:2048});assert.equal(body.max_tokens,8000);
  await f.providers.complete(f.connection,{model:'claude-opus-4-7',messages,reasoningEffort:'high'});
  body=f.requests.at(-1).body;assert.deepEqual(body.thinking,{type:'adaptive',display:'summarized'});assert.deepEqual(body.output_config,{effort:'high'});assert.equal(body.max_tokens,16_384);
  await f.providers.complete(f.connection,{model:'claude-sonnet-4-5',messages});
  body=f.requests.at(-1).body;assert.equal(body.thinking,undefined);assert.equal(body.max_tokens,8000);
});

test('DeepSeek and GLM map to thinking.type, Gemini and xAI mini to reasoning_effort, custom hosts follow their provider',async t=>{
  const cases=[
    [{type:'deepseek'},'deepseek-v4-flash','none',{thinking:{type:'disabled'}}],
    [{type:'deepseek'},'deepseek-v4-flash','high',{thinking:{type:'enabled'}}],
    [{type:'deepseek'},'deepseek-v4-flash','max',{thinking:{type:'enabled'},reasoning_effort:'max'}],
    [{type:'zai'},'glm-4.6','high',{thinking:{type:'enabled'}}],
    [{type:'zai'},'glm-5.1','none',{thinking:{type:'disabled'}}],
    [{type:'gemini'},'gemini-2.5-flash','none',{reasoning_effort:'none'}],
    [{type:'gemini'},'gemini-3-pro-preview','medium',{reasoning_effort:'medium'}],
    [{type:'xai'},'grok-3-mini','low',{reasoning_effort:'low'}]
  ];
  for(const [shape,model,effort,expected] of cases){
    const f=await fixture(t,{type:shape.type});
    f.state.handler=(_req,res)=>sse(res,[{choices:[{delta:{content:'ok'},finish_reason:'stop'}]}]);
    await f.providers.complete(f.connection,{model,messages,reasoningEffort:effort});
    const body=f.requests.at(-1).body;
    for(const [key,value] of Object.entries(expected))assert.deepEqual(body[key],value,`${shape.type} ${model} ${effort} ${key}`);
    for(const key of ['reasoning','reasoning_effort','thinking'])if(!Object.hasOwn(expected,key))assert.equal(body[key],undefined,`${shape.type} ${model} ${effort} sent ${key}`);
  }
  assert.equal(presetReasoning({type:'zai'},'glm-5.3'),null);
  assert.deepEqual(presetReasoning({type:'gemini'},'gemini-2.5-pro').efforts,['low','medium','high']);
  assert.equal(presetReasoning({type:'xai'},'grok-4-0709'),null);assert.equal(presetReasoning({type:'xai'},'grok-3'),null);
  assert.equal(presetReasoning({type:'deepseek'},'deepseek-chat'),null);
  for(const [kind,host] of [['groq','api.groq.com'],['mistral','api.mistral.ai'],['together','api.together.xyz'],['fireworks','api.fireworks.ai'],['moonshot','api.moonshot.ai'],['minimax','api.minimax.io'],['ollama','127.0.0.1'],['custom','example.test']])
    assert.equal(presetReasoning({type:kind,baseUrl:`https://${host}/v1`},'deepseek-r1-distill-llama-70b'),null,kind);
  assert.equal(presetReasoning({type:'custom',baseUrl:'https://api.z.ai/api/paas/v4'},'glm-4.7').parameter,'thinking.type');
  assert.equal(presetReasoning({type:'custom',baseUrl:'https://api.deepseek.com'},'deepseek-v4-pro').parameter,'thinking.type');
  // xAI non-mini models never receive reasoning_effort, even when asked.
  const f=await fixture(t,{type:'xai'});
  await assert.rejects(f.providers.complete(f.connection,{model:'grok-4-0709',messages,reasoningEffort:'high'}),/does not advertise/);assert.equal(f.requests.length,0);
});

test('auto resolves to High only for OpenAI/ChatGPT; elsewhere it sends nothing, and explicit efforts need the capability',()=>{
  const openai={supported:true,efforts:['low','medium','high'],defaultEffort:'',parameter:'reasoning.effort',source:'provider'};
  assert.equal(effectiveReasoningEffort('auto',openai),'high');assert.equal(effectiveReasoningEffort(undefined,openai),'high');
  for(const [connection,model] of [[{type:'openrouter'},'deepseek/deepseek-r1'],[{type:'anthropic'},'claude-sonnet-4-5'],[{type:'deepseek'},'deepseek-v4-flash'],[{type:'zai'},'glm-4.6'],[{type:'gemini'},'gemini-2.5-pro'],[{type:'xai'},'grok-3-mini']]) {
    const capability=reasoningForModel(connection,model);assert.equal(capability.supported,true,connection.type);
    assert.equal(effectiveReasoningEffort('auto',capability),'',connection.type);assert.equal(effectiveReasoningEffort('high',capability),'high',connection.type);assert.equal(effectiveReasoningEffort('',capability),'');
  }
  assert.equal(effectiveReasoningEffort('xhigh',reasoningForModel({type:'zai'},'glm-4.6')),'');
});

test('thinking models get a 16K output floor and a strict endpoint gets one max_completion_tokens resend that is remembered',async t=>{
  const f=await fixture(t,{models:[{id:'o3-mini',name:'o3 mini'}]});
  f.state.handler=(_req,res,body)=>Object.hasOwn(body,'max_tokens')?json(res,{error:{message:"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."}},400):sse(res,[{choices:[{delta:{reasoning_content:'r'}}]},{choices:[{delta:{content:'ok'},finish_reason:'stop'}]}]);
  const consumer=ordered(),result=await f.providers.complete(f.connection,{model:'o3-mini',messages,...consumer});
  assert.equal(result.text,'ok');assert.equal(f.requests.length,2);assert.equal(f.requests[0].body.max_tokens,16_384);assert.equal(f.requests[1].body.max_completion_tokens,16_384);assert.equal(f.requests[1].body.max_tokens,undefined);
  assert.deepEqual(consumer.log,[['reasoning','r'],['text','ok']]);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(f.store.state.connections.find(item=>item.id==='fixture').models[0].outputParameter,'max_completion_tokens');
  await f.providers.complete(f.connection,{model:'o3-mini',messages});assert.equal(f.requests.length,3);assert.ok(Object.hasOwn(f.requests[2].body,'max_completion_tokens'));
  // A different 400 is not retried, and a plain model keeps the configured limit.
  f.state.handler=(_req,res)=>json(res,{error:{message:'Invalid messages.'}},400);
  await assert.rejects(f.providers.complete(f.connection,{model:'plain-model',messages}),/HTTP 400/);assert.equal(f.requests.length,4);assert.equal(f.requests[3].body.max_tokens,4096);
});

test('DeepSeek keeps reasoning_content for its own tool continuation only',async t=>{
  const f=await fixture(t,{type:'deepseek'});
  f.state.handler=(_req,res)=>sse(res,[{choices:[{delta:{reasoning_content:'Need a tool.'}}]},{choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'lookup',arguments:'{}'}}]},finish_reason:'tool_calls'}]}]);
  const first=await f.providers.complete(f.connection,{model:'deepseek-v4-flash',messages,tools:[{name:'lookup',description:'Look up.',parameters:{type:'object',properties:{}}}]});
  assert.deepEqual(first.providerItems,[{type:'reasoning_content',text:'Need a tool.'}]);
  f.state.handler=(_req,res)=>sse(res,[{choices:[{delta:{content:'Done.'},finish_reason:'stop'}]}]);
  const history=[...messages,{role:'assistant',content:'',tool_calls:[{id:'call-1',type:'function',function:{name:'lookup',arguments:'{}'}}],providerItems:first.providerItems},{role:'tool',tool_call_id:'call-1',content:'found'}];
  await f.providers.complete(f.connection,{model:'deepseek-v4-flash',messages:history});
  assert.equal(f.requests.at(-1).body.messages[1].reasoning_content,'Need a tool.');
  assert.equal(f.requests.at(-1).body.max_tokens,16_384);
});
