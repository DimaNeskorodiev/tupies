import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { availableSearchFallbacks, searchFallbackIdentity, searchFallback, normalizeFallbackResults, duckDuckGoDefinition } from '../lib/web-search.mjs';

async function fixture(t,provider='tavily') {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-fallback-')),store=await new Store(directory).init(),integrations=new Integrations(store),preset=integrations.catalog().find(item=>item.id===provider);
  const integration={...integrations.validate({...preset,...(provider==='searxng'?{baseUrl:'https://search.example.test'}:{apiKey:'fixture-search-key'})}),id:'fallback_fixture'};
  await store.mutate(state=>{state.integrations=[integration];state.bots[0].integrationIds=[integration.id];});
  t.after(async()=>{await integrations.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,integrations,integration,bot:store.state.bots[0]};
}
const request=()=>({integrationId:'fallback_fixture',query:'primary reference',count:2});

test('fallback presets require explicit assigned fixed service contracts and supported groups',async t=>{
  const f=await fixture(t);
  assert.deepEqual(availableSearchFallbacks(f.integrations,f.bot),[{id:'fallback_fixture',name:'Tavily Search',provider:'Tavily'}]);
  assert.deepEqual(duckDuckGoDefinition(f.integrations,f.bot).parameters.properties.integrationId.enum,['fallback_fixture']);
  assert.deepEqual(availableSearchFallbacks(f.integrations,{...f.bot,integrationIds:[]}),[]);assert.deepEqual(availableSearchFallbacks(f.integrations,{...f.bot,tools:['web']}),[]);
  const original=structuredClone(f.integration);
  for(const change of [{baseUrl:'https://evil.example.test'},{authType:'header'},{type:'mcp'}]){Object.assign(f.integration,original,change);assert.deepEqual(availableSearchFallbacks(f.integrations,f.bot),[]);}
  Object.assign(f.integration,original);f.integration.tools[0].inputSchema.properties.search_depth.enum=['advanced'];assert.deepEqual(availableSearchFallbacks(f.integrations,f.bot),[]);
});

test('Tavily fallback is one exact approved Basic request with no answer/content extras',async t=>{
  const f=await fixture(t),requests=[];
  f.integrations.request=async(integration,args)=>{requests.push({integrationId:integration.id,...args});return {data:{results:[{url:'https://example.com/source',title:'Primary',content:'Candidate snippet'}],usage:{credits:1}}};};
  const identity=searchFallbackIdentity(f.integrations,f.bot,f.integration.id);
  await assert.rejects(searchFallback(f.integrations,f.bot,request(),{expectedIdentity:identity}),/approval/);
  await assert.rejects(searchFallback(f.integrations,f.bot,request(),{approved:true}),/changed after approval/);assert.equal(requests.length,0);
  const result=await searchFallback(f.integrations,f.bot,request(),{approved:true,expectedIdentity:identity});
  assert.equal(requests.length,1);assert.equal(requests[0].method,'POST');assert.equal(requests[0].path,'/search');assert.deepEqual(requests[0].body,{query:'primary reference',max_results:2,search_depth:'basic',include_answer:false,include_raw_content:false,include_images:false,include_usage:true,auto_parameters:false});
  assert.equal(result.provider,'Tavily');assert.equal(result.reportedCredits,1);assert.equal(result.results[0].url,'https://example.com/source');assert.match(result.notice,/not fetched page evidence/);assert.equal(result.partial,false);assert.equal(result.noResults,false);
});

test('fallback rejects changed credentials, configuration, assignments and malformed input before dispatch',async t=>{
  const f=await fixture(t),identity=searchFallbackIdentity(f.integrations,f.bot,f.integration.id);let calls=0;f.integrations.call=async()=>{calls++;return {results:[]};};
  f.integration.secret=f.store.seal('rotated-fixture-key');await assert.rejects(searchFallback(f.integrations,f.bot,request(),{approved:true,expectedIdentity:identity}),/changed after approval/);
  const current=searchFallbackIdentity(f.integrations,f.bot,f.integration.id);
  await assert.rejects(searchFallback(f.integrations,{...f.bot,integrationIds:[]},request(),{approved:true,expectedIdentity:current}),/assigned/);
  for(const change of [{query:''},{query:'x '.repeat(76)},{count:11},{count:1.5},{extra:true}])await assert.rejects(searchFallback(f.integrations,f.bot,{...request(),...change},{approved:true,expectedIdentity:current}));
  f.integration.tools[0].path='/research';await assert.rejects(searchFallback(f.integrations,f.bot,request(),{approved:true,expectedIdentity:current}),/assigned/);assert.equal(calls,0);
});

test('owner SearXNG uses fixed JSON query and marks partial upstream coverage honestly',async t=>{
  const f=await fixture(t,'searxng'),requests=[];
  f.integrations.request=async(integration,args)=>{requests.push({integrationId:integration.id,...args});return {data:{results:[{url:'https://example.org/a',title:'One',content:'A candidate.'}],unresponsive_engines:[['some-engine','timeout']]}};};
  const result=await searchFallback(f.integrations,f.bot,request(),{approved:true,expectedIdentity:searchFallbackIdentity(f.integrations,f.bot,f.integration.id)});
  assert.equal(requests.length,1);assert.equal(requests[0].method,'GET');assert.equal(requests[0].path,'/search?q=primary+reference&format=json&safesearch=1&pageno=1');assert.equal(result.provider,'SearXNG');assert.equal(result.partial,true);assert.equal(result.unavailableEngines,1);assert.equal(result.noResults,false);
  const partial=normalizeFallbackResults({results:[],unresponsive_engines:[['engine','blocked']]},{provider:'SearXNG',...request()});assert.equal(partial.noResults,false);assert.equal(partial.partial,true);
  const empty=normalizeFallbackResults({results:[],unresponsive_engines:[]},{provider:'SearXNG',...request()});assert.equal(empty.noResults,true);assert.equal(empty.partial,false);
});

test('fallback output is bounded and bad responses cannot become invented empty success',()=>{
  const result=normalizeFallbackResults({results:[{url:'https://example.org/a#fragment',title:'<b>Source</b>',content:'s'.repeat(4000)},{url:'https://127.0.0.1/secret'},{url:'http://example.com/insecure'},{url:'https://example.org/a#duplicate'},{url:'https://example.com/b'}]},{provider:'Tavily',...request(),count:1});
  assert.equal(result.returned,1);assert.equal(result.omitted,4);assert.equal(result.results[0].title,'Source');assert.equal(result.results[0].snippet.length,1200);assert.equal(result.results[0].url,'https://example.org/a');
  for(const value of [{},{results:{}},{results:[],error:'failed'},{results:[],isError:true}])assert.throws(()=>normalizeFallbackResults(value,{provider:'Tavily',...request()}),/invalid or failed/);
  const unusable=normalizeFallbackResults({results:[{url:'https://127.0.0.1/secret'}]},{provider:'Tavily',...request()});assert.equal(unusable.partial,true);assert.equal(unusable.noResults,false);
});

test('fallback respects cancellation and does not retry uncertain integration failures',async t=>{
  const f=await fixture(t);let calls=0;
  f.integrations.call=async()=>{calls++;throw new Error('Connection lost after dispatch.');};
  const args={approved:true,expectedIdentity:searchFallbackIdentity(f.integrations,f.bot,f.integration.id)};
  const controller=new AbortController();controller.abort(new Error('Stopped by owner.'));await assert.rejects(searchFallback(f.integrations,f.bot,request(),{...args,signal:controller.signal}),/Stopped by owner/);assert.equal(calls,0);
  await assert.rejects(searchFallback(f.integrations,f.bot,request(),args),/Connection lost after dispatch/);assert.equal(calls,1);
});

test('fallback refuses result provenance when configuration changes during its one request',async t=>{
  const f=await fixture(t,'searxng');let calls=0;
  const identity=searchFallbackIdentity(f.integrations,f.bot,f.integration.id);
  f.integrations.request=async()=>{calls++;f.integration.baseUrl='https://changed.example.test';return {data:{results:[]}};};
  await assert.rejects(searchFallback(f.integrations,f.bot,request(),{approved:true,expectedIdentity:identity}),/changed during the request/);assert.equal(calls,1);
  f.integration.baseUrl='https://search.example.test';
  f.integrations.request=async()=>{calls++;f.bot.integrationIds=[];return {data:{results:[]}};};
  await assert.rejects(searchFallback(f.integrations,f.bot,request(),{approved:true,expectedIdentity:identity}),/changed during the request/);assert.equal(calls,2);
});
