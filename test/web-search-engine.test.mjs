import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate){const until=Date.now()+5000;while(Date.now()<until){const value=predicate();if(value)return value;await delay(5);}throw new Error('Search engine fixture timed out.');}
async function fixture(t,args={integrationId:'search_fixture',query:'primary source',count:2}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-search-engine-')),store=await new Store(directory).init(),integrations=new Integrations(store),template=integrations.catalog().find(item=>item.id==='brave');
  await store.mutate(state=>{state.connections=[{id:'provider_fixture',type:'custom',defaultModel:'test-model'}];state.integrations=[{...integrations.validate({...template,apiKey:'fixture-search-key'}),id:'search_fixture'}];for(const bot of state.bots){bot.connectionId='provider_fixture';bot.approvalPolicy='balanced';bot.tools=['web','integrations'];bot.integrationIds=['search_fixture'];}});
  const dispatched=[],requests=[];integrations.request=async(integration,request)=>{dispatched.push({integrationId:integration.id,...request});return {data:{web:{results:[{url:'https://example.com/primary',title:'Primary source',description:'Discovery snippet.'}]},query:{more_results_available:false}}};};
  const publicReads=[];
  const engine=new NativeEngine(store,{integrations,runTimeout:5000,publicFetch:async(url,options)=>{publicReads.push({url,options});return {status:200,text:'<a class="result__a" href="https://example.com/primary">Primary source</a><div class="result__snippet">Discovery candidate.</div>'};},providers:{async complete(_connection,request){requests.push(request);return requests.length===1?{text:'',toolCalls:[{id:'search_call',name:'web_search',arguments:args}]}:{text:'The search returned discovery candidates; the source still needs reading.',toolCalls:[]};}}});
  await engine.recover();t.after(async()=>{await engine.close();await integrations.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,integrations,dispatched,requests,publicReads};
}
function identity(run){return {runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation};}

test('engine advertises assigned search and requires exact approval before normalized discovery',async t=>{
  const f=await fixture(t);await f.engine.start('bot_atlas','Search the configured service.');const waiting=await waitFor(()=>f.store.state.runs.bot_atlas?.status==='waiting_for_approval' && f.store.state.runs.bot_atlas);
  assert.ok(f.requests[0].tools.some(tool=>tool.name==='web_search'));assert.equal(f.dispatched.length,0);
  await f.engine.control('bot_atlas','approval',{...identity(waiting),choice:'once'});await waitFor(()=>!isActive(f.store.state.runs.bot_atlas));
  const result=JSON.parse(f.requests[1].messages.findLast(message=>message.role==='tool').content);assert.equal(result.results[0].url,'https://example.com/primary');assert.match(result.notice,/not fetched page evidence/);assert.equal(f.dispatched.length,1);assert.equal(f.dispatched[0].path,'/v1/web/search?q=primary+source&count=2');assert.equal(f.requests.length,2);
});

test('denied search dispatches no integration request and is not retried',async t=>{
  const f=await fixture(t);await f.engine.start('bot_atlas','Search only if approved.');const waiting=await waitFor(()=>f.store.state.runs.bot_atlas?.status==='waiting_for_approval' && f.store.state.runs.bot_atlas);
  await f.engine.control('bot_atlas','approval',{...identity(waiting),choice:'deny'});await waitFor(()=>!isActive(f.store.state.runs.bot_atlas));
  const result=JSON.parse(f.requests[1].messages.findLast(message=>message.role==='tool').content);assert.match(result.error,/denied/i);assert.equal(f.dispatched.length,0);assert.equal(f.requests.length,2);
});

test('search configuration or credential changed during approval refuses dispatch',async t=>{
  const f=await fixture(t);f.engine.approve=async()=>{await f.store.mutate(state=>{state.integrations[0].secret=f.store.seal('rotated-fixture-search-key');});return true;};
  await f.engine.start('bot_atlas','Search with the displayed connection.');await waitFor(()=>!isActive(f.store.state.runs.bot_atlas));
  const result=JSON.parse(f.requests[1].messages.findLast(message=>message.role==='tool').content);assert.match(result.error,/changed after approval/i);assert.equal(f.dispatched.length,0);assert.equal(f.requests.length,2);
  await f.store.mutate(state=>{state.bots[0].tools=['web'];});
  assert.equal(f.engine.capabilities(f.store.state.bots[0]).features.web_search,true,'Web-only bots retain keyless DuckDuckGo search');
  await f.store.mutate(state=>{state.bots[0].tools=[];});assert.equal(f.engine.capabilities(f.store.state.bots[0]).features.web_search,false);
});

test('keyless DuckDuckGo is a Web read with no integration authority or approval prompt',async t=>{
  const f=await fixture(t,{query:'primary source',count:2});await f.store.mutate(state=>{state.bots[0].tools=['web'];state.bots[0].integrationIds=[];});let approvals=0;
  f.engine.approve=async()=>{approvals++;throw new Error('A keyless Web read must not request integration approval.');};
  await f.engine.start('bot_atlas','Search DuckDuckGo.');await waitFor(()=>!isActive(f.store.state.runs.bot_atlas));
  const result=JSON.parse(f.requests[1].messages.findLast(message=>message.role==='tool').content);assert.equal(result.provider,'DuckDuckGo');assert.equal(result.results[0].url,'https://example.com/primary');assert.equal(approvals,0);assert.equal(f.dispatched.length,0);assert.equal(f.publicReads.length,1);assert.equal(new URL(f.publicReads[0].url).hostname,'html.duckduckgo.com');
});


test('Approve for me dispatches the assigned search once without an owner prompt',async t=>{
  const f=await fixture(t);await f.store.mutate(state=>{state.bots[0].approvalPolicy='auto';});
  const started=await f.engine.start('bot_atlas','Search the configured service.');await f.engine.tasks.get(started.id);
  assert.equal(f.store.state.runs.bot_atlas.status,'completed');assert.equal(f.dispatched.length,1);
  assert.equal(f.store.state.runs.bot_atlas.events.filter(event=>event.type==='approval.automatic').length,1);
  assert.equal(f.store.state.runs.bot_atlas.events.some(event=>event.type==='approval.request'),false);
});

test('automatic search still refuses a changed credential identity before dispatch',async t=>{
  const f=await fixture(t);await f.store.mutate(state=>{state.bots[0].approvalPolicy='auto';});
  const event=f.engine.event.bind(f.engine);f.engine.event=async(context,type,details)=>{await event(context,type,details);if(type==='approval.automatic')await f.store.mutate(state=>{state.integrations[0].secret=f.store.seal('replacement-fixture');});};
  const started=await f.engine.start('bot_atlas','Search the configured service.');await f.engine.tasks.get(started.id);
  assert.equal(f.dispatched.length,0);assert.match(JSON.parse(f.requests[1].messages.findLast(message=>message.role==='tool').content).error,/changed after approval/);
});
