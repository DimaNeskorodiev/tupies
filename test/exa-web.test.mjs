import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, HttpError } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { isExaIntegration, defaultExa, normalizeExaResults, searchFilters, fallbackSearchArgs, webExtract, exaFailureStatus, extractArgs } from '../lib/exa.mjs';
import { workReceipt } from '../lib/work-quality.mjs';
import { callSites } from '../lib/site-access.mjs';
import { CORE_TOOLS } from '../lib/tool-catalog.mjs';

const KEY='exa-fixture-key-7c1d';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate){const until=Date.now()+5000;while(Date.now()<until){const value=predicate();if(value)return value;await delay(5);}throw new Error('Exa fixture timed out.');}
const ddgPage='<a class="result__a" href="https://example.com/ddg">DuckDuckGo source</a><div class="result__snippet">Keyless candidate.</div>';
const exaSearchReply={requestId:'r1',results:[
  {id:'a',url:'https://example.com/a#section',title:'Primary A',publishedDate:'2026-11-01T00:00:00.000Z',author:'Ada',highlights:['First relevant passage.','Second passage.']},
  {id:'dup',url:'https://example.com/a',title:'Duplicate A',highlights:['Same page.']},
  {id:'local',url:'http://127.0.0.1/admin',title:'Private',highlights:['Never offered.']},
  {id:'b',url:'https://example.org/b',title:'Primary B',highlights:['B passage.']}
],costDollars:{total:0.007},notices:[{message:'Results localized.'}]};
const page=(text,extra={})=>({requestId:'r2',results:[{id:'https://example.com/article',url:'https://example.com/article',title:'Article',text,...extra}],statuses:[{id:'https://example.com/article',status:'success',source:'cached'}],costDollars:{total:0.001}});

async function exaIntegrations(t,{configured=true,cleanup=true}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-exa-')),s=await new Store(directory).init(),integrations=new Integrations(s),preset=integrations.catalog().find(item=>item.id==='exa');
  const remove=()=>fs.rm(directory,{recursive:true,force:true});if(cleanup)t.after(remove);
  if(configured)await s.mutate(state=>{state.integrations=[{...integrations.validate({...preset,apiKey:KEY}),id:'exa_owned'}];});
  const calls=[];let reply=()=>({data:exaSearchReply});
  integrations.request=async(integration,request)=>{calls.push({integration,...request});return reply(request,integration);};
  return {store:s,integrations,calls,remove,reply:fn=>{reply=fn;}};
}

test('only the official Exa host with a stored key becomes the default provider',async t=>{
  const h=await exaIntegrations(t);
  const integration=h.store.state.integrations[0];
  assert.equal(integration.baseUrl,'https://api.exa.ai');assert.equal(isExaIntegration(integration),true);assert.equal(defaultExa(h.integrations)?.id,'exa_owned');
  assert.deepEqual(integration.tools.map(tool=>`${tool.method} ${tool.path}`),['POST /search','POST /contents']);
  assert.equal(isExaIntegration({...integration,baseUrl:'https://api.exa.ai.example.com'}),false);
  assert.equal(isExaIntegration({...integration,secret:''}),false);
  assert.equal(isExaIntegration({...integration,authType:'header',headerName:'X-Other'}),false);
  assert.equal(isExaIntegration({...integration,authType:'header',headerName:'x-api-key'}),true);
  assert.equal(isExaIntegration({...integration,type:'mcp'}),false);
});

test('Exa results are deduplicated, public-only, budgeted and carry provenance',()=>{
  const result=normalizeExaResults(exaSearchReply,{query:'q',count:5,filters:{category:'news',startPublishedDate:'2026-11-01T00:00:00.000Z'}});
  assert.equal(result.provider,'Exa');assert.deepEqual(result.results.map(item=>item.url),['https://example.com/a','https://example.org/b']);
  assert.equal(result.omitted,2);assert.equal(result.results[0].snippet,'First relevant passage. … Second passage.');
  assert.equal(result.results[0].publishedDate,'2026-11-01T00:00:00.000Z');assert.equal(result.results[0].author,'Ada');
  assert.equal(result.reportedCostUsd,0.007);assert.deepEqual(result.providerNotices,['Results localized.']);
  assert.deepEqual(result.filters,{category:'news',startPublishedDate:'2026-11-01'});assert.equal(result.noResults,false);
  const long=normalizeExaResults({results:Array.from({length:12},(_,index)=>({url:`https://example.com/${index}`,title:'T',highlights:['x'.repeat(5000)]}))},{query:'q',count:10});
  assert.ok(JSON.stringify(long).length<16_000,'a full result list stays under the retained-result threshold');
  assert.equal(normalizeExaResults({results:[]},{query:'q'}).noResults,true);
  assert.throws(()=>normalizeExaResults({error:'bad'},{query:'q'}),/invalid result list/);
});

test('search filters are validated and DuckDuckGo receives only what it can honour',()=>{
  assert.deepEqual(searchFilters({includeDomains:['Docs.Python.org','example.com/docs'],category:'news',startPublishedDate:'2026-02-28'}),{includeDomains:['docs.python.org','example.com/docs'],category:'news',startPublishedDate:'2026-02-28T00:00:00.000Z'});
  for(const bad of [{includeDomains:[]},{includeDomains:['not a domain']},{includeDomains:['https://example.com']},{category:'blogs'},{startPublishedDate:'2026-02-30'},{startPublishedDate:'yesterday'}])assert.throws(()=>searchFilters(bad),HttpError);
  assert.deepEqual(fallbackSearchArgs({query:'release notes',count:3},{includeDomains:['example.com']}),{args:{query:'release notes site:example.com',count:3},ignored:[]});
  assert.deepEqual(fallbackSearchArgs({query:'q'},{includeDomains:['a.com','b.com'],category:'news'}),{args:{query:'q'},ignored:['includeDomains','category']});
});

test('web_extract reads through Exa with paging, passages and an exact request shape',async t=>{
  const h=await exaIntegrations(t),text=`# Heading\n\n${'a'.repeat(1500)}${'b'.repeat(1500)}`;
  h.reply(request=>({data:page(text.slice(0,request.body.text.maxCharacters),{highlights:['The relevant passage.']})}));
  const first=await webExtract(h.integrations,{url:'https://example.com/article',query:'pricing',maxCharacters:1000});
  assert.equal(first.provider,'Exa');assert.equal(first.text,text.slice(0,1000));assert.equal(first.nextOffset,1000);assert.deepEqual(first.highlights,['The relevant passage.']);
  assert.equal(first.contentSource,'cached');assert.match(first.notice,/offset 1000/);assert.match(first.notice,/fresh:true/);
  assert.deepEqual(h.calls[0].body,{urls:['https://example.com/article'],text:{maxCharacters:1001},highlights:{query:'pricing',maxCharacters:3000}});
  assert.equal(h.calls[0].path,'/contents');assert.equal(h.calls[0].method,'POST');
  const last=await webExtract(h.integrations,{url:'https://example.com/article',offset:2000,maxCharacters:2000,fresh:true});
  assert.equal(last.text,text.slice(2000));assert.equal(last.totalChars,text.length);assert.equal(last.nextOffset,undefined);assert.equal(last.highlights,undefined);
  assert.deepEqual(h.calls[1].body,{urls:['https://example.com/article'],text:{maxCharacters:4001},maxAgeHours:0,livecrawlTimeout:12000});
});

test('web_extract falls back to the direct read with provenance; cancellation never falls back',async t=>{
  const direct=[];const fetch=async url=>{direct.push(url);return {status:200,url,contentType:'text/html',text:'<html><head><title>Direct</title></head><body><main><p>Directly extracted text.</p><a href="https://example.com/next">Next</a></main></body></html>'};};
  const h=await exaIntegrations(t);
  h.reply(()=>({data:{results:[],statuses:[{id:'https://example.com/article',status:'error',error:{tag:'CRAWL_NOT_FOUND',httpStatusCode:404}}]}}));
  const missing=await webExtract(h.integrations,{url:'https://example.com/article'},{fetch});
  assert.equal(missing.provider,'direct');assert.equal(missing.status,200);assert.match(missing.text,/Directly extracted text/);assert.equal(missing.title,'Direct');
  assert.deepEqual(missing.fallback,{used:true,primaryFailure:{provider:'Exa',status:'page_error',pageStatus:404},provider:'direct'});assert.equal(missing.links[0].url,'https://example.com/next');
  h.reply(()=>{throw new HttpError(502,'Integration returned HTTP 402: out of credits');});
  const unpaid=await webExtract(h.integrations,{url:'https://example.com/article'},{fetch});
  assert.equal(unpaid.fallback.primaryFailure.status,'payment_required');assert.equal(direct.length,2);
  const controller=new AbortController();h.reply(()=>{controller.abort(new Error('Stopped.'));throw new Error('aborted request');});
  await assert.rejects(webExtract(h.integrations,{url:'https://example.com/article'},{fetch,signal:controller.signal}),/Stopped/);assert.equal(direct.length,2);
  const none=await exaIntegrations(t,{configured:false});
  const plain=await webExtract(none.integrations,{url:'https://example.com/article'},{fetch});
  assert.equal(plain.provider,'direct');assert.equal(plain.fallback,undefined);assert.equal(none.calls.length,0);
  assert.throws(()=>extractArgs({url:'http://example.com/'}),/HTTPS/);assert.throws(()=>extractArgs({url:'https://127.0.0.1/'}),HttpError);assert.throws(()=>extractArgs({url:'https://example.com',extra:true}),/accepts/);
});

test('failure statuses never carry the key and classify common Exa errors',()=>{
  assert.equal(exaFailureStatus(new HttpError(401,'Integration returned HTTP 401')),'unauthorized');
  assert.equal(exaFailureStatus(new HttpError(502,'Integration returned HTTP 429: slow down')),'rate_limited');
  assert.equal(exaFailureStatus(Object.assign(new Error('t'),{name:'TimeoutError'})),'timeout');
  assert.equal(exaFailureStatus(new HttpError(502,'The integration could not be reached.')),'unavailable');
});

test('web_extract is a page read for receipts, the site gate and the core tool set',()=>{
  assert.ok(CORE_TOOLS.has('web_extract'));
  const call={id:'read',name:'web_extract',arguments:{url:'https://www.example.co.uk/a'}};
  assert.deepEqual(callSites(call),['example.co.uk']);
  const ok=workReceipt(call,{url:'https://www.example.co.uk/a',provider:'Exa',text:'Page.'});assert.equal(ok.status,'succeeded');assert.equal(ok.url,'https://www.example.co.uk/a');
  const missing=workReceipt(call,{url:'https://www.example.co.uk/a',provider:'direct',status:404,text:'Missing.'});assert.equal(missing.status,'failed');assert.equal(missing.httpStatus,404);
});

async function engineFixture(t,{configured=true,calls:toolCalls,exa}={}) {
  const h=await exaIntegrations(t,{configured,cleanup:false});if(exa)h.reply(exa);
  await h.store.mutate(state=>{state.connections=[{id:'provider_fixture',type:'custom',defaultModel:'test-model'}];for(const bot of state.bots){bot.connectionId='provider_fixture';bot.approvalPolicy='balanced';bot.tools=['web'];bot.integrationIds=[];}});
  const requests=[],publicReads=[];
  const engine=new NativeEngine(h.store,{integrations:h.integrations,runTimeout:5000,publicFetch:async(url,options)=>{publicReads.push(url);return new URL(url).hostname.endsWith('duckduckgo.com')?{status:200,text:ddgPage}:{status:200,url,contentType:'text/html',text:'<p>Direct page.</p>'};},
    providers:{async complete(_connection,request){requests.push(request);const next=toolCalls?.[requests.length-1];return next?{text:'',toolCalls:next}:{text:'Done.',toolCalls:[]};}}});
  await engine.recover();t.after(async()=>{await engine.close();await h.integrations.close();await h.remove();});
  engine.approve=async()=>{throw new Error('Exa search and page reads must not ask for approval.');};
  const run=async(prompt='Research.')=>{await engine.start('bot_atlas',prompt);await waitFor(()=>!isActive(h.store.state.runs.bot_atlas));return h.store.state.runs.bot_atlas;};
  const toolResult=id=>JSON.parse(requests.at(-1).messages.find(message=>message.role==='tool' && message.tool_call_id===id).content);
  return {...h,engine,requests,publicReads,run,toolResult};
}

test('a configured Exa connection is every Web bot’s default search, without assignment or approval',async t=>{
  const f=await engineFixture(t,{calls:[[{id:'s',name:'web_search',arguments:{query:'battery policy',count:3,category:'news',startPublishedDate:'2026-10-01'}}]]});
  const run=await f.run();assert.equal(run.status,'completed');
  const tools=f.requests[0].tools,search=tools.find(tool=>tool.name==='web_search');
  assert.ok(tools.some(tool=>tool.name==='web_extract'));assert.ok(search.parameters.properties.includeDomains);assert.equal(search.parameters.properties.integrationId,undefined);
  assert.match(f.requests[0].messages[0].content,/Read pages, articles, documentation and PDFs with web_extract/);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].integration.id,'exa_owned');assert.equal(f.calls[0].path,'/search');
  assert.deepEqual(f.calls[0].body,{query:'battery policy',type:'auto',numResults:3,contents:{highlights:true},category:'news',startPublishedDate:'2026-10-01T00:00:00.000Z'});
  const result=f.toolResult('s');assert.equal(result.provider,'Exa');assert.equal(result.results.length,2);assert.equal(f.publicReads.length,0);
  assert.equal(f.engine.capabilities(f.store.state.bots[0]).features.web_search_provider,'Exa');assert.equal(f.engine.capabilities(f.store.state.bots[0]).features.web_extract,true);
  assert.ok(!JSON.stringify(f.requests.at(-1).messages).includes(KEY),'the key never reaches the model');
});

test('an Exa failure falls back to DuckDuckGo with recorded provenance and the single-domain filter',async t=>{
  const f=await engineFixture(t,{calls:[[{id:'s',name:'web_search',arguments:{query:'changelog',includeDomains:['example.com'],category:'news'}}]],exa:()=>{throw new HttpError(502,'Integration returned HTTP 429: slow down');}});
  const run=await f.run();const result=f.toolResult('s');
  assert.equal(result.provider,'DuckDuckGo');assert.deepEqual(result.fallback,{used:true,primaryFailure:{provider:'Exa',status:'rate_limited'},provider:'DuckDuckGo'});
  assert.deepEqual(result.ignoredFilters,['category']);assert.equal(new URL(f.publicReads[0]).searchParams.get('q'),'changelog site:example.com');
  assert.ok(run.events.some(event=>event.type==='search.fallback' && event.from==='Exa' && event.to==='DuckDuckGo' && event.primaryStatus==='rate_limited'));
});

test('without Exa the keyless tools are unchanged and web_extract is not offered',async t=>{
  const f=await engineFixture(t,{configured:false,calls:[[{id:'s',name:'web_search',arguments:{query:'primary source'}}]]});
  await f.run();const tools=f.requests[0].tools;
  assert.equal(tools.some(tool=>tool.name==='web_extract'),false);assert.equal(tools.find(tool=>tool.name==='web_search').parameters.properties.includeDomains,undefined);
  assert.equal(f.toolResult('s').provider,'DuckDuckGo');assert.equal(f.calls.length,0);
  assert.equal(f.engine.capabilities(f.store.state.bots[0]).features.web_search_provider,'DuckDuckGo');
});

test('web_extract through the Engine records a successful page read',async t=>{
  const f=await engineFixture(t,{calls:[[{id:'p',name:'web_extract',arguments:{url:'https://example.com/article',query:'price'}}]],exa:()=>({data:page('Article body.',{highlights:['Price is 10.']})})});
  const run=await f.run();const result=f.toolResult('p');
  assert.equal(result.provider,'Exa');assert.equal(result.text,'Article body.');assert.deepEqual(result.highlights,['Price is 10.']);
  const record=run.workRecords.find(item=>item.callId==='p');assert.equal(record.status,'succeeded');assert.equal(record.url,'https://example.com/article');
});

test('Stop during an Exa search never moves on to DuckDuckGo',async t=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  const f=await engineFixture(t,{calls:[[{id:'s',name:'web_search',arguments:{query:'slow'}}]],exa:(request)=>new Promise((_,reject)=>{entered();request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});})});
  const run=await f.engine.start('bot_atlas','Search until stopped.');await started;
  await f.engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});await f.engine.tasks.get(run.id);
  assert.equal(f.store.state.runs.bot_atlas.status,'cancelled');assert.equal(f.publicReads.length,0);
});

test('a rejected key or exhausted credits marks the Exa card until a request succeeds',async t=>{
  const h=await exaIntegrations(t),fetch=async url=>({status:200,url,contentType:'text/plain',text:'Direct.'});
  const current=()=>h.store.state.integrations[0];
  h.reply(()=>{throw new HttpError(502,'Integration returned HTTP 429: slow down');});
  await webExtract(h.integrations,{url:'https://example.com/a'},{fetch});assert.notEqual(current().status,'error','a rate limit is not an account problem');
  h.reply(()=>{throw new HttpError(401,'Integration returned HTTP 401');});
  const result=await webExtract(h.integrations,{url:'https://example.com/a'},{fetch});assert.equal(result.provider,'direct');
  assert.equal(current().status,'error');assert.match(current().error,/rejected the API key/);assert.ok(!current().error.includes(KEY));
  const revision=h.store.revision;await webExtract(h.integrations,{url:'https://example.com/a'},{fetch});assert.equal(h.store.revision,revision,'an unchanged failure is not rewritten');
  h.reply(()=>({data:page('Back.')}));
  await webExtract(h.integrations,{url:'https://example.com/article'},{fetch});assert.equal(current().status,'configured');assert.equal(current().error,undefined);
  const quiet=h.store.revision;await webExtract(h.integrations,{url:'https://example.com/article'},{fetch});assert.equal(h.store.revision,quiet,'healthy requests never write state');
});
