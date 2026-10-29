import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { availableWebSearch, webSearchDefinition, webSearchIdentity, webSearch, normalizeSearchResults } from '../lib/web-search.mjs';

async function fixture(t){const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-search-')),store=await new Store(directory).init(),integrations=new Integrations(store),template=integrations.catalog().find(item=>item.id==='brave'),integration={...integrations.validate({...template,apiKey:'fixture-brave-key'}),id:'search_fixture'};await store.mutate(state=>{state.integrations=[integration];state.bots[0].integrationIds=[integration.id];});t.after(async()=>{await integrations.close();await fs.rm(directory,{recursive:true,force:true});});return {store,integrations,integration,bot:store.state.bots[0]};}

test('search is offered only for assigned fixed Brave configuration and tool groups',async t=>{
  const f=await fixture(t);assert.deepEqual(availableWebSearch(f.integrations,f.bot),['search_fixture']);assert.equal(webSearchDefinition(f.integrations,f.bot).name,'web_search');
  assert.equal(webSearchDefinition(f.integrations,{...f.bot,integrationIds:[]}),null);assert.equal(webSearchDefinition(f.integrations,{...f.bot,tools:['web']}),null);
  for(const change of [{baseUrl:'https://evil.example/res'},{authType:'bearer'},{type:'mcp'}]){const original={...f.integration};Object.assign(f.integration,change);assert.deepEqual(availableWebSearch(f.integrations,f.bot),[]);Object.assign(f.integration,original);}
});

test('search preserves exact approval and current integration identity before dispatch',async t=>{
  const f=await fixture(t),requests=[];f.integrations.request=async(integration,request)=>{requests.push({integration:integration.id,...request});return {data:{web:{results:[{url:'https://example.com/primary',title:'Primary',description:'Evidence candidate'}]},query:{more_results_available:false}}};};
  const args={integrationId:f.integration.id,query:'primary reference',count:3},identity=webSearchIdentity(f.integrations,f.bot,f.integration.id);
  await assert.rejects(webSearch(f.integrations,f.bot,args),/approval/);await assert.rejects(webSearch(f.integrations,{...f.bot,integrationIds:[]},args,{approved:true}),/assigned/);assert.equal(requests.length,0);
  f.integration.secret=f.store.seal('replacement-fixture-key');await assert.rejects(webSearch(f.integrations,f.bot,args,{approved:true,expectedIdentity:identity}),/changed/);assert.equal(requests.length,0);
  const result=await webSearch(f.integrations,f.bot,args,{approved:true,expectedIdentity:webSearchIdentity(f.integrations,f.bot,f.integration.id)});
  assert.equal(requests.length,1);assert.equal(requests[0].method,'GET');assert.equal(requests[0].path,'/v1/web/search?q=primary+reference&count=3');assert.equal(result.results[0].url,'https://example.com/primary');assert.match(result.notice,/not fetched page evidence/);assert.equal(result.moreResultsAvailable,false);
});

test('normalization bounds discovery output and excludes unsafe URLs without acquiring them',()=>{
  const result=normalizeSearchResults({web:{results:[{url:'https://example.com/a#section',title:'<b>Source</b>',description:'x'.repeat(4000)},{url:'http://example.com/insecure'},{url:'https://127.0.0.1/private'},{url:'https://example.com/a#other'},{url:'javascript:alert(1)'},{url:'https://example.org/extra'}]}},{query:'fixture',integrationId:'search_fixture',count:1});
  assert.equal(result.results.length,1);assert.equal(result.results[0].title,'Source');assert.equal(result.results[0].snippet.length,1200);assert.equal(result.results[0].url,'https://example.com/a');assert.equal(result.omitted,5);assert.equal(result.moreResultsAvailable,null);assert.throws(()=>normalizeSearchResults({web:{results:'wrong'}}),/invalid result/);
});

test('invalid query/count or changed fixed action is refused before integration invocation',async t=>{
  const f=await fixture(t);let calls=0;f.integrations.call=async()=>{calls++;return {};};
  for(const change of [{query:''},{query:'x '.repeat(76)},{count:20},{query:'secret\nheader'},{count:1.5},{unexpected:true}])await assert.rejects(webSearch(f.integrations,f.bot,{integrationId:f.integration.id,query:'fixture',...change},{approved:true}));
  f.integration.tools[0].method='POST';await assert.rejects(webSearch(f.integrations,f.bot,{integrationId:f.integration.id,query:'fixture'},{approved:true}),/assigned/);assert.equal(calls,0);
});
