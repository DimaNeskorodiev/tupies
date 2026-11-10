import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { Providers } from '../lib/providers.mjs';
import { usageCounts, safePricing, priceFor, callCostMicros, addModelCall, cachePercent, costUsd, usageSummary, sumSummaries } from '../lib/run-usage.mjs';
import { markProviderFailure, providerFailure, quotaExhausted, quotaResetMs } from '../lib/provider-failure.mjs';
import { autonomousRetryPolicy } from '../lib/autonomous-work.mjs';
import { safeRetryRead, sendsRequest, reconcileWork, toolFailure } from '../lib/work-quality.mjs';
import { retainToolResult, executeEngineTool } from '../lib/task-tools.mjs';

const BOT='bot_atlas';
const call=(id,name,args)=>({id,name,arguments:args});

// ---- Provider-neutral counts ------------------------------------------------------------------

test('every provider usage shape reduces to fresh, cached, written and output tokens',()=>{
  // OpenAI Responses: the prompt total contains the cached part.
  assert.deepEqual(usageCounts({input_tokens:1000,input_tokens_details:{cached_tokens:800},output_tokens:50,output_tokens_details:{reasoning_tokens:20}}),{input:200,cached:800,cacheWrite:0,output:50,reasoning:20});
  // Chat completions, with OpenRouter's cache-write detail and charged cost.
  assert.deepEqual(usageCounts({prompt_tokens:1000,prompt_tokens_details:{cached_tokens:600,cache_write_tokens:100},completion_tokens:40,cost:0.00125}),{input:300,cached:600,cacheWrite:100,output:40,reasoning:0,costMicros:1250});
  // Anthropic: input_tokens are the fresh part only.
  assert.deepEqual(usageCounts({input_tokens:30,cache_read_input_tokens:900,cache_creation_input_tokens:70,output_tokens:10}),{input:30,cached:900,cacheWrite:70,output:10,reasoning:0});
  // DeepSeek names hits on the top level.
  assert.deepEqual(usageCounts({prompt_tokens:500,prompt_cache_hit_tokens:400,prompt_cache_miss_tokens:100,completion_tokens:5}),{input:100,cached:400,cacheWrite:0,output:5,reasoning:0});
  for(const empty of [undefined,null,{},[],{total_tokens:5},'x'])assert.equal(usageCounts(empty),null);
  // Hostile or broken numbers never go negative or non-finite.
  assert.deepEqual(usageCounts({prompt_tokens:10,prompt_tokens_details:{cached_tokens:50},completion_tokens:-4,cost:Infinity}),{input:0,cached:50,cacheWrite:0,output:0,reasoning:0});
});

test('prices come only from a named source and are bounded',()=>{
  // OpenRouter publishes USD per token as strings.
  assert.deepEqual(safePricing({prompt:'0.00000028',completion:'0.00000042',input_cache_read:'0.000000028'}),{input:0.28,output:0.42,cachedInput:0.028});
  assert.deepEqual(safePricing({input:3,output:15,cachedInput:0.3,cacheWrite:3.75}),{input:3,output:15,cachedInput:0.3,cacheWrite:3.75});
  for(const bad of [null,'3',[],{},{input:3},{prompt:'-1',completion:'1'},{prompt:'abc',completion:'1'},{input:1e9,output:1},{input:NaN,output:1}])assert.equal(safePricing(bad),null);
  const connection={id:'c',type:'openrouter',models:[{id:'m',pricing:{input:1,output:2}}]};
  assert.deepEqual(priceFor(connection,'m'),{pricing:{input:1,output:2},source:'catalog'});
  assert.equal(priceFor(connection,'other'),null);
  assert.deepEqual(priceFor({...connection,prices:{m:{input:5,output:6}}},'m'),{pricing:{input:5,output:6},source:'owner'});
  // A subscription connection is never priced, whatever its catalog says.
  assert.equal(priceFor({type:'chatgpt',models:[{id:'m',pricing:{input:1,output:2}}]},'m'),null);
  assert.equal(callCostMicros({input:1_000_000,cached:1_000_000,cacheWrite:0,output:500_000},{input:1,output:2,cachedInput:0.1}),2_100_000);
  // Without a cached rate, cached tokens are estimated at the input price rather than free.
  assert.equal(callCostMicros({input:0,cached:1_000_000,cacheWrite:0,output:0},{input:1,output:2}),1_000_000);
});

test('a task total has dollars only when every call was priced',()=>{
  const connection={id:'c',type:'openrouter',models:[{id:'m',pricing:{input:1,output:2,cachedInput:0.1}}]};
  let meter=addModelCall(undefined,{prompt_tokens:1000,prompt_tokens_details:{cached_tokens:0},completion_tokens:100},{connection,model:'m'});
  meter=addModelCall(meter,{prompt_tokens:2000,prompt_tokens_details:{cached_tokens:1500},completion_tokens:100},{connection,model:'m'});
  assert.deepEqual([meter.calls,meter.input,meter.cached,meter.output,meter.pricedCalls,meter.unpricedCalls,meter.costSource],[2,1500,1500,200,2,0,'catalog']);
  assert.equal(cachePercent(meter),50);assert.equal(costUsd(meter),0.00205);
  // The provider's own cost report wins over the catalog, and the weaker source names the total.
  const reported=addModelCall(undefined,{prompt_tokens:10,completion_tokens:1,cost:0.5},{connection,model:'m'});
  assert.deepEqual([costUsd(reported),reported.costSource],[0.5,'provider']);
  assert.equal(addModelCall(reported,{prompt_tokens:10,completion_tokens:1},{connection,model:'m'}).costSource,'catalog');
  // One unpriced call removes the dollar total; tokens remain.
  const partial=addModelCall(meter,{prompt_tokens:10,completion_tokens:1},{connection,model:'unknown'});
  assert.equal(costUsd(partial),null);assert.equal(partial.unpricedCalls,1);assert.equal(partial.input,1510);
  // A call whose provider reported nothing is counted, never guessed.
  const silent=addModelCall(meter,{},{connection,model:'m'});
  assert.deepEqual([silent.calls,silent.unreportedCalls,costUsd(silent)],[3,1,null]);
  // Subscriptions show tokens and cache reuse only.
  const plan=addModelCall(undefined,{input_tokens:100,input_tokens_details:{cached_tokens:90},output_tokens:5},{connection:{type:'chatgpt',models:[{id:'m',pricing:{input:1,output:1}}]},model:'m'});
  const summary=usageSummary(plan,{steps:1,toolCalls:0,durationMs:1200,model:'m',provider:'chatgpt'});
  assert.deepEqual(summary,{steps:1,toolCalls:0,modelCalls:1,inputTokens:10,cachedTokens:90,cacheWriteTokens:0,outputTokens:5,totalTokens:105,cachePercent:90,costSource:'subscription',durationMs:1200,model:'m',provider:'chatgpt'});
  assert.equal(usageSummary(undefined),null);assert.equal(usageSummary({calls:0}),null);
  // The earlier meter is never mutated.
  assert.equal(meter.calls,2);
  const day=sumSummaries([usageSummary(meter,{steps:2}),usageSummary(partial,{steps:3}),summary,null]);
  assert.deepEqual([day.tasks,day.steps,day.unpricedTasks,day.costUsd],[3,6,1,0.00205]);
});

// ---- Spent quota is not a passing error ---------------------------------------------------------

test('a spent balance or plan limit is told apart from a request-rate throttle',()=>{
  assert.equal(quotaExhausted(402,{}),true);
  assert.equal(quotaExhausted(429,{error:{code:'insufficient_quota',message:'You exceeded your current quota.'}}),true);
  assert.equal(quotaExhausted(429,{error:{type:'usage_limit_reached',resets_in_seconds:7200}}),true);
  assert.equal(quotaExhausted(429,{error:{message:'Insufficient Balance'}}),true);
  assert.equal(quotaExhausted(429,{error:'Your credit balance is too low to access the API.'}),true);
  assert.equal(quotaExhausted(403,{error:{code:'billing_not_active'}}),true);
  // Ordinary throttles, wording on a 403, other statuses and non-objects stay what they were.
  assert.equal(quotaExhausted(429,{error:{message:'Rate limit reached for requests per minute.',code:'rate_limit_exceeded'}}),false);
  assert.equal(quotaExhausted(403,{error:{message:'insufficient balance'}}),false);
  assert.equal(quotaExhausted(500,{error:{code:'insufficient_quota'}}),false);
  assert.equal(quotaExhausted(429,'insufficient quota'),false);assert.equal(quotaExhausted(429,null),false);
  assert.equal(quotaResetMs({error:{resets_in_seconds:90}}),90_000);
  assert.equal(quotaResetMs({error:{resets_at:1_700_000_100}},1_700_000_000_000),100_000);
  assert.equal(quotaResetMs({error:{resets_at:1}},1_700_000_000_000),0);assert.equal(quotaResetMs({}),0);assert.equal(quotaResetMs(null),0);
});

test('the retry policy never backs off on a spent quota unless the provider names a short reset',()=>{
  const quota=(retryAfterMs=0)=>Object.assign(markProviderFailure(new HttpError(502,'Provider returned HTTP 429: insufficient_quota'),'quota_exhausted',{upstreamStatus:429}),retryAfterMs?{retryAfterMs}:{});
  const spent=autonomousRetryPolicy(quota(),{attempt:0});
  assert.deepEqual([spent.retry,spent.exhausted,spent.transient,spent.quota,spent.reason],[false,true,true,true,'quota_exhausted']);
  // A reset inside one backoff window is waited for once, then given up on.
  const soon=autonomousRetryPolicy(quota(60_000),{attempt:0,random:()=>0});
  assert.deepEqual([soon.retry,soon.delayMs,soon.attempt],[true,60_000,1]);
  const again=autonomousRetryPolicy(quota(60_000),{attempt:1});
  assert.deepEqual([again.retry,again.quota,again.resetMs],[false,true,60_000]);
  // A reset hours away is final immediately and carries the wait for the message.
  const later=autonomousRetryPolicy(quota(3*3600_000),{attempt:0});
  assert.deepEqual([later.retry,later.quota,later.resetMs],[false,true,3*3600_000]);
  // An ordinary 429 keeps its six backed-off retries.
  const throttle=autonomousRetryPolicy(markProviderFailure(new HttpError(502,'slow down'),'rate_limit',{upstreamStatus:429}),{attempt:0});
  assert.deepEqual([throttle.retry,throttle.quota],[true,undefined]);
});

async function fakeServer(t,handler) {
  const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
}

test('a provider response that names a spent quota is classified from its structured code',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-run-usage-')),store=await new Store(directory).init();
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const providers=new Providers(store,{allowPrivateNetwork:true});
  const base=await fakeServer(t,(req,res)=>{req.resume();res.writeHead(429,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'insufficient_quota',type:'insufficient_quota',message:'You exceeded your current quota, please check your plan and billing details.'}}));});
  const error=await providers.complete({id:'c1',type:'custom',baseUrl:base,models:[]},{model:'m',messages:[{role:'user',content:'hi'}]}).catch(value=>value);
  assert.equal(providerFailure(error)?.code,'quota_exhausted');assert.equal(providerFailure(error).upstreamStatus,429);
});

// ---- Engine: meter on the run, the reply and the history; quota goes straight to the fallback ------

async function fixture(t,complete,{fallback=false}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-run-usage-')),store=await new Store(directory).init();
  await store.mutate(state=>{
    state.connections.push({id:'primary',type:'openrouter',defaultModel:'cheap',models:[{id:'cheap',pricing:{input:1,output:2,cachedInput:0.1}}]},{id:'backup',type:'openai',defaultModel:'backup-model',models:[{id:'backup-model'}]});
    for(const bot of state.bots){bot.connectionId='primary';bot.model='cheap';bot.tools=['workspace'];bot.approvalPolicy='balanced';if(fallback)bot.fallback={connectionId:'backup',model:'backup-model'};}
  });
  const requests=[],engine=new NativeEngine(store,{providers:{async complete(connection,request){requests.push({connectionId:connection.id,request});return complete(request,requests.length,connection);}},runTimeout:10000,retryDelay:0});
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const run=async text=>{const started=await engine.start(BOT,text);await engine.tasks.get(started.id);return store.state.runs[BOT];};
  return {store,engine,requests,run};
}

test('a task records normalized tokens, cache reuse and an estimate on the run, the reply and the run history',async t=>{
  const f=await fixture(t,async(request,count)=>count===1
    ?{text:'',toolCalls:[call('list','workspace_list',{path:'.'})],usage:{prompt_tokens:10_000,prompt_tokens_details:{cached_tokens:0},completion_tokens:100}}
    :{text:'Listed the workspace.',toolCalls:[],usage:{prompt_tokens:10_400,prompt_tokens_details:{cached_tokens:10_000},completion_tokens:200}});
  const run=await f.run('List my files.');
  assert.equal(run.status,'completed');
  assert.deepEqual([run.metering.calls,run.metering.input,run.metering.cached,run.metering.output,run.metering.costSource],[2,10_400,10_000,300,'catalog']);
  // The raw provider sums Missions read are unchanged.
  assert.equal(run.usage.prompt_tokens,20_400);assert.equal(run.usage.cached_tokens,10_000);
  const reply=f.store.state.messages[BOT].at(-1);
  assert.equal(reply.role,'assistant');
  assert.deepEqual([reply.usage.steps,reply.usage.toolCalls,reply.usage.modelCalls,reply.usage.inputTokens,reply.usage.cachedTokens,reply.usage.outputTokens,reply.usage.totalTokens,reply.usage.cachePercent,reply.usage.costSource,reply.usage.model,reply.usage.provider],[2,1,2,10_400,10_000,300,20_700,49,'catalog','cheap','openrouter']);
  // 10,400 fresh × $1/M + 10,000 cached × $0.10/M + 300 output × $2/M.
  assert.equal(reply.usage.costUsd,0.012);assert.ok(reply.usage.durationMs>=0);
  const history=f.store.state.runHistory[BOT][0];
  assert.equal(history.id,run.id);assert.deepEqual(history.metering,reply.usage);
  const log=await f.engine.engineLog.read({limit:50});
  assert.equal(log.find(row=>row.kind==='run.finished' && row.runId===run.id).metering.costUsd,0.012);
});

test('a reply from a provider that reports no usage carries no invented numbers',async t=>{
  const f=await fixture(t,async()=>({text:'Hello.',toolCalls:[]}));
  const run=await f.run('Say hello.');
  assert.equal(run.status,'completed');
  const reply=f.store.state.messages[BOT].at(-1);
  assert.deepEqual([reply.usage.totalTokens,reply.usage.unreportedCalls,reply.usage.costUsd,reply.usage.cachePercent],[0,1,undefined,undefined]);
});

test('a spent quota skips the six backed-off retries and is sent once to the fallback model',async t=>{
  const spent=()=>markProviderFailure(new HttpError(502,'OpenRouter returned HTTP 402: Insufficient credits.'),'quota_exhausted',{upstreamStatus:402});
  const f=await fixture(t,async(request,count,connection)=>{if(connection.id==='primary')throw spent();return {text:'Answered by the backup.',toolCalls:[],usage:{input_tokens:50,output_tokens:5}};},{fallback:true});
  const run=await f.run('Say hi.');
  assert.equal(run.status,'completed');
  assert.deepEqual(f.requests.map(item=>item.connectionId),['primary','backup']);
  assert.equal((run.events || []).filter(event=>event.type==='model.retry').length,0);
  assert.equal((run.events || []).find(event=>event.type==='model.fallback').reason,'quota_exhausted');
  // The fallback is another provider without a price: tokens are kept, dollars are not guessed.
  const reply=f.store.state.messages[BOT].at(-1);
  assert.deepEqual([reply.usage.inputTokens,reply.usage.costUsd,reply.usage.model,reply.usage.provider],[50,undefined,'backup-model','openai']);
});

test('without a fallback a spent quota fails at once with a plain reason and no retries',async t=>{
  const f=await fixture(t,async()=>{throw Object.assign(markProviderFailure(new HttpError(502,'ChatGPT returned HTTP 429: usage limit reached'),'quota_exhausted',{upstreamStatus:429}),{retryAfterMs:2*3600_000});});
  const run=await f.run('Say hi.');
  assert.equal(run.status,'failed');assert.equal(f.requests.length,1);
  assert.equal((run.events || []).filter(event=>event.type==='model.retry').length,0);
  const message=typeof run.error==='string'?run.error:run.error.message;
  assert.match(message,/balance, credits or plan usage is used up; it resets in about 120 min/);assert.match(message,/nothing was replayed/);
  assert.equal(run.failure.code,'quota_exhausted');
});

// ---- A POST is never an automatic retry -----------------------------------------------------------

test('an http_fetch POST is not a safe read: no automatic retry and never recorded as not applied',()=>{
  assert.equal(safeRetryRead(call('a','http_fetch',{url:'https://example.com'})),true);
  assert.equal(safeRetryRead(call('a','http_fetch',{url:'https://example.com',method:'get'})),true);
  assert.equal(safeRetryRead(call('a','http_fetch',{url:'https://example.com',method:'HEAD'})),true);
  for(const method of ['POST','post','PUT','PATCH','DELETE'])assert.equal(safeRetryRead(call('a','http_fetch',{url:'https://example.com',method})),false);
  assert.equal(sendsRequest(call('a','http_fetch',{url:'https://example.com',method:'POST'})),true);
  assert.equal(sendsRequest(call('a','workspace_read',{path:'x',method:'POST'})),false);
  assert.equal(safeRetryRead(call('a','workspace_read',{path:'x'})),true);assert.equal(safeRetryRead(call('a','workspace_write',{path:'x'})),false);
  assert.equal(safeRetryRead(null),false);
  // A dispatched POST that failed has an unknown outcome and is not retryable, even on a gateway timeout.
  const failure=toolFailure(Object.assign(new Error('Gateway timeout'),{status:504}),{read:false,dispatched:true});
  assert.deepEqual([failure.outcome,failure.retryable],['unknown',false]);
  // Reconciliation after an interruption: a started GET was not applied, a started POST is unknown.
  const run={events:[{type:'tool.started',tool:'http_fetch',toolCallId:'get',arguments:{url:'https://example.com/a'}},{type:'tool.started',tool:'http_fetch',toolCallId:'post',arguments:{url:'https://example.com/a',method:'POST',body:{a:1}}}],workRecords:[]};
  reconcileWork(run);
  assert.deepEqual(run.workRecords.map(record=>[record.callId,record.outcome]),[['get','not_applied'],['post','unknown']]);
});

test('the engine sends a failing POST once and a failing GET twice',async t=>{
  let posts=0,gets=0;
  const f=await fixture(t,async(request,count)=>count===1
    ?{text:'',toolCalls:[call('post','http_fetch',{url:'https://api.example.com/orders',method:'POST',body:{item:1}}),call('get','http_fetch',{url:'https://api.example.com/orders'})]}
    :{text:'Reported both results.',toolCalls:[]});
  await f.store.mutate(state=>{for(const bot of state.bots){bot.tools=['web'];bot.approvalPolicy='auto';}});
  f.engine.tools.execute=async(bot,name,args)=>{if(name!=='http_fetch')throw new Error(`Unexpected tool ${name}.`);if(args.method==='POST')posts++;else gets++;throw Object.assign(new Error('Gateway timeout'),{status:504});};
  const run=await f.run('Create the order and read it back.');
  assert.equal(run.status,'completed');assert.equal(posts,1);assert.equal(gets,2);
  const records=Object.fromEntries(run.workRecords.map(record=>[record.callId,record]));
  assert.equal(records.post.outcome,'unknown');assert.equal(records.get.outcome,'not_applied');
  assert.deepEqual((run.events || []).filter(event=>event.type==='tool.retry').map(event=>event.toolCallId),['get']);
});

// ---- The first page of a long result arrives with the call ----------------------------------------

test('a long tool result returns its first page inline and pages only the rest',async()=>{
  const context={},serialized=JSON.stringify({text:'a'.repeat(40_000)});
  const first=JSON.parse(retainToolResult(context,{id:'long'},serialized));
  assert.equal(first.shortened,true);assert.equal(first.content,serialized.slice(0,12_000));assert.equal(first.nextOffset,12_000);
  assert.equal(first.totalChars,serialized.length);assert.equal(first.truncated,false);assert.match(first.instruction,/characters 0–12000 of 40011 retained/);
  // The envelope keeps the key order the working-context shaper reads the resultId from.
  assert.match(retainToolResult({}, {id:'x'},serialized),/^\{"shortened":true,"resultId":"[^"]+"/);
  // The next page continues exactly where the inline one stopped.
  const page=await executeEngineTool({assertRunning(){}},context,'tool_result_read',{resultId:first.resultId,offset:first.nextOffset});
  assert.equal(first.content+page.content,serialized.slice(0,first.content.length+page.content.length));
  // Text that grows when escaped is cut until the whole envelope fits the inline limit.
  const escaped=JSON.parse(retainToolResult({}, {id:'quotes'},'"'.repeat(60_000)));
  assert.ok(JSON.stringify(escaped).length<=16_000);assert.equal(escaped.nextOffset,escaped.content.length);assert.ok(escaped.content.length>=5000);
  // A result at the inline limit is untouched.
  const small='x'.repeat(16_000);assert.equal(retainToolResult({}, {id:'small'},small),small);
});

// ---- Small tool-use fixes ---------------------------------------------------------------------------

test('the tool_call bridge accepts one unambiguous spelling of each part and nothing else',async()=>{
  const {unwrapToolCall}=await import('../lib/tool-catalog.mjs');
  const bridge=args=>unwrapToolCall({id:'c',name:'tool_call',arguments:args});
  assert.deepEqual(bridge({name:'brain_search',arguments:{query:'x'}}),{id:'c',name:'brain_search',arguments:{query:'x'},bridged:true});
  for(const args of [{tool:'brain_search',args:{query:'x'}},{tool_name:'brain_search',parameters:{query:'x'}},{name:'brain_search',input:{query:'x'}},{name:'brain_search',arguments:'{"query":"x"}'}])
    assert.deepEqual(bridge(args),{id:'c',name:'brain_search',arguments:{query:'x'},bridged:true},JSON.stringify(args));
  assert.deepEqual(bridge({name:'shell_list'}).arguments,{});
  // Ambiguous, unknown, nested or malformed forms stay a tool_call for the ordinary error.
  for(const args of [{name:'a',tool:'b',arguments:{}},{name:'a',arguments:{},args:{}},{name:'a',arguments:{},extra:1},{arguments:{}},{name:'tool_call',arguments:{}},{name:'a',arguments:'not json'},{name:'a',arguments:[1]},{name:'a',arguments:'[1]'},{name:5,arguments:{}},null,'x'])
    assert.equal(bridge(args).name,'tool_call',JSON.stringify(args));
  assert.equal(unwrapToolCall({id:'d',name:'workspace_read',arguments:{tool:'x'}}).name,'workspace_read');
});

test('http_fetch names a script-rendered page once instead of returning a bare shell',async()=>{
  const {readableWebContent}=await import('../lib/web-content.mjs');
  const page=body=>readableWebContent({url:'https://app.example.com/',status:200,contentType:'text/html; charset=utf-8',text:body});
  const shell=page(`<!doctype html><html><head><title>Vault</title><script src="/static/app.js"></script></head><body><div id="root"></div><noscript>x</noscript><p>Loading</p>${'<link rel="preload" href="/chunk.js">'.repeat(300)}</body></html>`);
  assert.equal(shell.extraction.scriptRendered,true);assert.match(shell.notice,/drawn by scripts[\s\S]*Do not fetch it again[\s\S]*browser_open/);
  const phrase=page('<html><body><script>boot()</script><p>You need to enable JavaScript to run this app.</p></body></html>');
  assert.equal(phrase.extraction.scriptRendered,true);
  // A short static page, a long article and a script-free page are not flagged.
  assert.equal(page('<html><body><script>track()</script><p>Closed on Mondays.</p></body></html>').extraction.scriptRendered,undefined);
  assert.equal(page(`<html><body><script>track()</script><p>${'A real paragraph. '.repeat(600)}</p></body></html>`).extraction.scriptRendered,undefined);
  assert.equal(page(`<html><body><p>Hi</p>${'<span></span>'.repeat(1000)}</body></html>`).extraction.scriptRendered,undefined);
});
