import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { Providers } from '../lib/providers.mjs';

const BOT='bot_atlas',call=(id,name,args)=>({id,name,arguments:args});
const calls=(...toolCalls)=>({text:'',toolCalls}),answer=text=>({text,toolCalls:[]});
async function fixture(t,complete,fetcher,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-web-research-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections=[{id:'research_fixture',type:'custom',defaultModel:'fixture-model'}];Object.assign(state.bots.find(bot=>bot.id===BOT),{connectionId:'research_fixture',model:'fixture-model',tools:['web'],approvalPolicy:'balanced'});});
  const engine=new NativeEngine(store,{runTimeout:10000,publicFetch:fetcher,providers:{async complete(_connection,request){requests.push(structuredClone({messages:request.messages,turnContext:request.turnContext,tools:request.tools,model:request.model}));return complete(request,requests.length);}},...options});
  await engine.recover();t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,store,engine,requests};
}
async function run(f,prompt='Find breakfast near the shopping centre on Saturday morning.') {const started=await f.engine.start(BOT,prompt);await f.engine.tasks.get(started.id);return f.store.state.runs[BOT];}
const ddg=(url='https://example.com/cafe')=>({status:200,contentType:'text/html',text:`<a class="result__a" href="${url}">Fixture café</a><div class="result__snippet">Breakfast discovery.</div>`});

test('simple research gets readable facts and Engine workflow feedback before returning a supported answer',async t=>{
  const reads=[];
  const f=await fixture(t,async(request,turn)=>{
    const content=JSON.stringify([request.messages,request.turnContext]);
    assert.match(content,/Engine workflow:/);assert.match(content,/specific missing fact/);
    if(turn===1)return calls(call('search','web_search',{query:'breakfast shopping centre Saturday'}));
    assert.match(content,/Engine-observed web research/);
    if(turn===2)return calls(call('read','http_fetch',{url:'https://example.com/cafe'}));
    const result=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);
    assert.equal(result.format,'readable_text');assert.match(result.text,/Saturday 08:00/);assert.doesNotMatch(result.text,/css-noise|mustNotRun/);
    assert.equal(result.links[0].url,'https://example.com/menu');
    return answer('Fixture café serves breakfast on Saturday from 08:00; see its public page.');
  },async url=>{reads.push(url);return url.includes('duckduckgo.com')?ddg():{url,status:200,contentType:'text/html',text:`<style>${'css-noise '.repeat(30000)}</style><script>mustNotRun()</script><h1>Fixture café</h1><p>Saturday 08:00–14:00</p><address>Fixture Street 1</address><a href="/menu">Menu</a>`};});
  const done=await run(f);assert.equal(done.status,'completed',done.error);assert.equal(reads.length,2);assert.equal(f.requests.length,3);assert.equal(done.research.novel,2);assert.ok(!done.events.some(event=>event.type==='approval.request'));
  assert.ok(JSON.stringify(f.requests.at(-1)).length<40000,'a large CSS payload must not reach inference');
});

test('changing empty queries stops the real loop and preserves findings, receipts and hashed checkpoint state',async t=>{
  let reads=0;
  const f=await fixture(t,async(_request,turn)=>({text:turn===1?'I will check nearby breakfast options.':'',toolCalls:[call(`search_${turn}`,'web_search',{query:`different empty query ${turn}`})]}),async()=>{reads++;return {status:200,contentType:'text/html',text:'<div class="no-results">No results found.</div>'};});
  const done=await run(f);assert.equal(done.status,'failed');assert.match(done.error,/research made no progress/i);assert.equal(f.requests.length,6);assert.equal(reads,6);assert.equal(done.research.empty,6);assert.equal(done.research.blocked,true);
  assert.equal(done.workRecords.length,6);assert.equal(done.events.filter(event=>event.type==='research.warning').length,1);assert.equal(done.events.filter(event=>event.type==='research.stopped').length,1);
  assert.ok(f.requests.slice(3).some(request=>/Repeated reads or searches/.test(JSON.stringify(request.turnContext))));
  assert.ok(f.store.state.messages[BOT].some(message=>message.content==='I will check nearby breakfast options.'));
  const saved=f.store.state.taskCheckpoints[BOT].snapshot.webResearch;assert.equal(saved.blocked,true);assert.doesNotMatch(JSON.stringify(saved),/different empty query|https:/);
  const count=f.requests.length;await f.engine.close();const reopened=await new Store(f.directory).init();let restarted=0;
  const recovered=new NativeEngine(reopened,{providers:{async complete(){restarted++;return answer('Must not replay stopped research.');}}});
  try {await recovered.recover();await recovered.recoverAutonomous();for(const task of recovered.tasks.values())await task;assert.equal(restarted,0);assert.equal(f.requests.length,count);}finally {await recovered.close();}
});

test('different URLs returning the same readable source cannot bypass research novelty checks',async t=>{
  let dispatched=0;
  const f=await fixture(t,async(_request,turn)=>calls(call(`mirror_${turn}`,'http_fetch',{url:`https://mirror-${turn}.example/read?variation=${turn}`})),async url=>{dispatched++;return {url,status:200,contentType:'text/html',text:`<style>dynamic ignored ${dispatched}</style><p>Exactly the same café facts.</p>`};});
  const done=await run(f);assert.equal(done.status,'failed');assert.equal(dispatched,7);assert.equal(done.research.novel,1);assert.equal(done.research.duplicates,6);assert.match(done.error,/no progress/i);
});

test('productive research continues past checkpoints and preserves the original model selection',async t=>{
  const f=await fixture(t,async(request,turn)=>turn<=30?calls(call(`source_${turn}`,'http_fetch',{url:`https://example.com/source/${turn}`})):answer('Compared the 30 distinct sources. All requested source reads are complete.'),async url=>({url,status:200,contentType:'text/html',text:`<p>Distinct facts for source ${url.split('/').at(-1)}</p>`}));
  const done=await run(f,'Compare these 30 independent public source pages.');assert.equal(done.status,'completed',done.error);assert.equal(done.research.novel,30);assert.equal(f.requests.length,31);assert.equal(done.events.filter(event=>event.type==='research.checkpoint').length,2);assert.ok(f.requests.every(request=>request.model==='fixture-model'));
});

test('an 8K Web model receives readable evidence and research feedback without a context-budget failure',async t=>{
  const f=await fixture(t,async(_request,turn)=>turn===1?calls(call('small_read','http_fetch',{url:'https://example.com/cafe'})):answer('Fixture café opens Saturday at 08:00.'),async url=>({url,status:200,contentType:'text/html',text:'<p>Saturday 08:00</p>'}));
  await f.store.mutate(state=>{state.connections[0].contextWindow=8000;});
  const done=await run(f);assert.equal(done.status,'completed',done.error);assert.equal(f.requests.length,2);assert.equal(done.context.window,8000);assert.equal(done.research.reads,1);assert.match(JSON.stringify(f.requests[1].turnContext),/Engine-observed web research/);
});

test('retained Web-result pages participate in research feedback without treating unrelated tools as research',async t=>{
  let resultId;
  const f=await fixture(t,async(request,turn)=>{
    if(turn===1)return calls(call('long_source','http_fetch',{url:'https://example.com/long'}));
    if(turn===2){resultId=JSON.parse(request.messages.findLast(message=>message.role==='tool').content).resultId;assert.ok(resultId);return calls(call('page_source','tool_result_read',{resultId,offset:0}));}
    return answer('Read the beginning of the retained source; the rest remains unverified.');
  },async url=>({url,status:200,contentType:'text/html',text:'<p>'+ 'Distinct public fact. '.repeat(1800)+'</p>'}));
  const done=await run(f);assert.equal(done.status,'completed',done.error);assert.equal(done.research.reads,1);assert.equal(done.research.pages,1);assert.equal(done.research.calls,2);
});

test('parallel research reads are all recorded before the no-progress stop and no later batch dispatches',async t=>{
  let dispatched=0;
  const f=await fixture(t,async(_request,turn)=>calls(...Array.from({length:4},(_,i)=>call(`empty_${turn}_${i}`,'http_fetch',{url:`https://example.com/empty/${turn}/${i}`}))),async url=>{dispatched++;return {url,status:200,contentType:'application/json',text:'{"elements":[]}'};});
  const done=await run(f);assert.equal(done.status,'failed');assert.equal(dispatched,8);assert.equal(f.requests.length,2);assert.equal(done.workRecords.length,8);assert.equal(done.events.filter(event=>event.type==='tool.completed').length,8);assert.equal(done.research.blocked,true);
});

test('Stop cancels a pending web read and does not dispatch the next model turn',async t=>{
  let entered;const ready=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,async()=>calls(call('pending','http_fetch',{url:'https://example.com/slow'})),async(_url,{signal})=>{entered();return new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);});});
  const started=await f.engine.start(BOT,'Read this slow source.');await ready;await f.engine.control(BOT,'stop',{runId:started.id,remoteRunId:started.remoteRunId});await f.engine.tasks.get(started.id);
  assert.equal(f.store.state.runs[BOT].status,'cancelled');assert.equal(f.requests.length,1);
});

for(const type of ['custom','openai','anthropic','chatgpt'])test(`research workflow crosses the actual ${type} adapter with readable evidence`,async t=>{
  const requests=[],directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-research-protocol-')),store=await new Store(directory).init();
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));
    const n=requests.length,tool=n===1?call('search','web_search',{query:'fixture breakfast Saturday'}):n===2?call('read','http_fetch',{url:'https://example.com/cafe'}):null;
    const text=tool?'':'Fixture café opens Saturday at 08:00, according to its public page.';
    const output=type==='anthropic'?{content:tool?[{type:'tool_use',id:tool.id,name:tool.name,input:tool.arguments}]:[{type:'text',text}],stop_reason:tool?'tool_use':'end_turn'}:type==='custom'?{choices:[{message:{role:'assistant',content:text,...(tool?{tool_calls:[{id:tool.id,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.arguments)}}]}:{})},finish_reason:tool?'tool_calls':'stop'}]}:{status:'completed',output:tool?[{type:'function_call',call_id:tool.id,name:tool.name,arguments:JSON.stringify(tool.arguments),...(type==='chatgpt'?{namespace:'tupies'}:{})}]:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(output));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const providers=new Providers(store,{requestTimeout:5000,allowTestOAuth:true}),connection={id:'protocol_fixture',type,name:'Synthetic research provider',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,defaultModel:'fixture-model',secret:store.seal('synthetic-research-key')};
  if(type==='chatgpt')providers.headers=async()=>({Authorization:'Bearer synthetic-research-key'});
  await store.mutate(state=>{state.connections=[connection];Object.assign(state.bots[0],{connectionId:connection.id,model:'fixture-model',tools:['web'],approvalPolicy:'balanced'});});
  const engine=new NativeEngine(store,{providers,runTimeout:10000,publicFetch:async url=>url.includes('duckduckgo.com')?ddg():{url,status:200,contentType:'text/html',text:'<style>omitted css payload</style><h1>Fixture café</h1><p>Saturday 08:00</p>'}});
  t.after(async()=>{await engine.close();await providers.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  await engine.recover();const started=await engine.start(store.state.bots[0].id,'Find breakfast Saturday morning.');await engine.tasks.get(started.id);
  const done=store.state.runs[store.state.bots[0].id];assert.equal(done.status,'completed',done.error);assert.equal(requests.length,3);assert.match(JSON.stringify(requests[0]),/Engine workflow:/);assert.match(JSON.stringify(requests[2]),/readable_text/);assert.match(JSON.stringify(requests[2]),/Saturday 08:00/);assert.doesNotMatch(JSON.stringify(requests[2]),/omitted css payload/);assert.equal(done.research.novel,2);
});
