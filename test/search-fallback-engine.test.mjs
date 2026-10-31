import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, HttpError } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { delegatedSources, workReceipt, checkOutcomes } from '../lib/work-quality.mjs';

const call=(id,name,args)=>({id,name,arguments:args});
async function fixture(t,{read,complete}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-search-fallback-')),store=await new Store(directory).init(),integrations=new Integrations(store),template=integrations.catalog().find(item=>item.id==='searxng');
  const search={...integrations.validate({...template,baseUrl:'http://127.0.0.1:8888'}),id:'search_owned'};
  await store.mutate(state=>{state.connections=[{id:'fixture',type:'custom',defaultModel:'fixture-model'}];state.integrations=[search];for(const bot of state.bots){bot.connectionId='fixture';bot.tools=['web','integrations'];bot.integrationIds=[search.id];bot.searchFallbackIntegrationId=search.id;}});
  const requests=[],dispatches=[],reads=[];
  integrations.request=async(integration,request)=>{dispatches.push(request);return {data:{results:[{title:'Primary page',url:'https://example.com/source',content:'A discovery snippet.'}],unresponsive_engines:[]}};};
  const engine=new NativeEngine(store,{integrations,runTimeout:5000,publicFetch:async(url,opts)=>{reads.push(url);return read?read(url,opts):{status:202,text:'<form id="challenge-form">Challenge</form>'};},providers:{async complete(_,request){requests.push(request);return complete?complete(request,requests.length):requests.length===1?{text:'',toolCalls:[call('search','web_search',{query:'public source',count:2})]}:{text:'Search observed.',toolCalls:[]};}}});
  t.after(async()=>{await engine.close();await integrations.close();await fs.rm(directory,{recursive:true,force:true});});
  const run=async()=>{const r=await engine.start('bot_atlas','Find sources.');await engine.tasks.get(r.id);return store.state.runs.bot_atlas;};
  return {engine,store,integrations,requests,dispatches,reads,run};
}

test('DDG failure uses only the chosen assigned SearXNG after exact approval, with provider provenance',async t=>{
  const h=await fixture(t);let approvals=0;
  h.engine.approve=async(context,request)=>{approvals++;assert.equal(h.dispatches.length,0);assert.equal(request.arguments.integrationId,'search_owned');assert.match(request.arguments.reason,/DuckDuckGo unavailable/);return true;};
  const run=await h.run(),result=JSON.parse(h.requests[1].messages.findLast(m=>m.role==='tool').content);
  assert.equal(run.status,'completed');assert.equal(approvals,1);assert.equal(h.reads.length,2);assert.equal(h.dispatches.length,1);
  assert.equal(result.provider,'SearXNG');assert.equal(result.fallback.primaryFailure.provider,'DuckDuckGo');assert.equal(result.fallback.used,true);
  assert.match(h.dispatches[0].path,/format=json/);assert.equal(result.results[0].url,'https://example.com/source');
});

test('genuine no-results and policy refusal never trigger fallback',async t=>{
  for(const mode of ['empty','policy'])await t.test(mode,async t=>{
    const h=await fixture(t,{read:()=>{if(mode==='policy')throw new HttpError(400,'Unsafe destination refused.');return {status:200,text:'<div class="no-results">No results</div>'};}});let approvals=0;h.engine.approve=async()=>{approvals++;return true;};
    await h.run();assert.equal(approvals,0);assert.equal(h.dispatches.length,0);
    if(mode==='empty')assert.equal(JSON.parse(h.requests[1].messages.findLast(m=>m.role==='tool').content).noResults,true);
  });
});

test('the real public-fetch timeout shape reaches the selected fallback after exact approval',async t=>{
  const h=await fixture(t,{read:()=>{throw new HttpError(504,'Web request timed out.');}});let approvals=0;
  h.engine.approve=async()=>{approvals++;assert.equal(h.dispatches.length,0);return true;};
  await h.run();const result=JSON.parse(h.requests[1].messages.findLast(m=>m.role==='tool').content);
  assert.equal(approvals,1);assert.equal(h.reads.length,1);assert.equal(h.dispatches.length,1);
  assert.equal(result.fallback.primaryFailure.code,'search_timeout');assert.equal(result.provider,'SearXNG');
});

test('a denied fallback is not retried or used to rerun the unchanged DDG request',async t=>{
  const h=await fixture(t,{complete:(_,index)=>index<4?{text:'',toolCalls:[call(`search_${index}`,'web_search',{query:'public source',count:2})]}:{text:'Fallback refused.',toolCalls:[]}});let approvals=0;h.engine.approve=async()=>{approvals++;return false;};
  await h.run();assert.equal(approvals,1);assert.equal(h.dispatches.length,0);assert.equal(h.reads.length,2);
});

test('changed fallback identity or assignment refuses dispatch after approval',async t=>{
  const h=await fixture(t);h.engine.approve=async()=>{await h.store.mutate(state=>{state.integrations[0].baseUrl='http://127.0.0.1:9999';});return true;};
  await h.run();assert.equal(h.dispatches.length,0);assert.match(h.requests[1].messages.findLast(m=>m.role==='tool').content,/changed after approval/);
});

test('without an owner choice a configured service is never selected automatically',async t=>{
  const h=await fixture(t);await h.store.mutate(state=>{delete state.bots[0].searchFallbackIntegrationId;});let approvals=0;h.engine.approve=async()=>{approvals++;return true;};
  await h.run();assert.equal(approvals,0);assert.equal(h.dispatches.length,0);
});

test('Stop during primary search cancels it without attempting the configured fallback',async t=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  const h=await fixture(t,{read:(_url,{signal})=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  const run=await h.engine.start('bot_atlas','Search until stopped.');await started;
  await h.engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});await h.engine.tasks.get(run.id);
  assert.equal(h.store.state.runs.bot_atlas.status,'cancelled');assert.equal(h.dispatches.length,0);assert.equal(h.reads.length,1);
});

test('HTTP error pages cannot satisfy a successful-source check',async t=>{
  const h=await fixture(t,{read:()=>({status:404,url:'https://example.com/missing',text:'Missing page.'}),complete:(_,index)=>index===1?{text:'',toolCalls:[call('fetch','http_fetch',{url:'https://example.com/missing'}),call('check','task_outcome_set',{checks:[{id:'source',kind:'source_read',callId:'fetch'}]})]}:{text:'Done.',toolCalls:[]}});
  const result=await h.run();assert.equal(result.verification.coverage,'not_declared');assert.equal(result.workRecords[0].httpStatus,404);assert.equal(result.workRecords[0].status,'failed');
  assert.equal(result.workRecords.find(record=>record.callId==='check').status,'failed');assert.match(h.store.state.conversations.bot_atlas.find(message=>message.tool_call_id==='check').content,/source observation did not succeed/);
  const legacy=await checkOutcomes({assertRunning(){},current:()=>({...result,outcomeChecks:[{id:'source',kind:'source_read',callId:'fetch'}]})},{});assert.equal(legacy.passed,false);
});

test('teammate sources derive from successful observed reads, never failed reads or model claims',()=>{
  const success=workReceipt(call('read','workspace_read',{}),{path:'sources/report.md',sha256:'a'.repeat(64),content:'Observed.'});
  const missing=workReceipt(call('missing','http_fetch',{}),{status:500,url:'https://example.com/failure',text:'Service failed.'});
  const fake=workReceipt(call('answer','task_plan_set',{}),{url:'https://example.com/model-claim'});
  const sources=delegatedSources({id:'child_run',workRecords:[success,missing,fake]},'bot_scout');
  assert.equal(sources.length,1);assert.equal(sources[0].callId,'read');assert.equal(sources[0].scope,'child_private_workspace');assert.equal(sources[0].sha256,'a'.repeat(64));assert.match(sources[0].notice,/No cross-bot file access/);
});
