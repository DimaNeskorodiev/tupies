import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { buildWorkshopTool } from '../lib/workshop.mjs';
import { listWorkshopSources, prepareWorkshopRead, runWorkshopRead } from '../lib/workshop-gateway.mjs';
import { SAFE_RETRY_READS } from '../lib/work-quality.mjs';

const key='synthetic-gateway-credential-123456';
const pkg={id:'extract-price',title:'Extract price',description:'Extract a number from synthetic API data.',source:'x=>({value:x.response.price*x.data.scale,env:[typeof fetch,typeof process,typeof require]})',tests:[{input:{data:{scale:2},response:{price:3}},expected:{value:6,env:['undefined','undefined','undefined']}}]};
const action={name:'prices',description:'Synthetic fixture price.',method:'GET',path:'/prices',inputSchema:{type:'object',properties:{symbol:{type:'string',enum:['TEST']},limit:{type:'integer',minimum:1,maximum:5}},required:['symbol'],additionalProperties:false}};
const json=(res,data)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));};
async function fixture(t,handler=(_req,res)=>json(res,{price:21})) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-workshop-gateway-')),store=await new Store(directory).init(),requests=[];
  const server=http.createServer((req,res)=>{requests.push({url:req.url,method:req.method,headers:req.headers});handler(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const integrations=new Integrations(store,{requestTimeout:1000}),tools=new AgentTools(store,{integrations});
  const integration={id:'fixture_api',...integrations.validate({name:'Fixture API',type:'rest',baseUrl:`http://127.0.0.1:${server.address().port}`,authType:'bearer',apiKey:key,tools:[action,{...action,name:'write',method:'POST'}]})};
  await store.mutate(state=>{state.integrations=[integration];Object.assign(state.bots[0],{tools:['workshop','integrations'],integrationIds:[integration.id]});});
  const bot=structuredClone(store.state.bots[0]),built=await buildWorkshopTool(store,bot,pkg);
  const args={digest:built.digest,integrationId:integration.id,tool:'prices',arguments:{symbol:'TEST',limit:2},input:{scale:2}};
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await integrations.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  return {store,bot,integrations,tools,args,requests,prepare:()=>prepareWorkshopRead(store,bot,integrations,args),run:async(identity,options={})=>runWorkshopRead(store,bot,integrations,args,{approved:true,approvedIdentity:identity,...options})};
}

test('gateway sends only approved GET parameters, holds credentials in Engine and transforms bounded JSON in isolation',async t=>{
  const f=await fixture(t),sources=listWorkshopSources(f.store,f.bot,f.integrations);
  assert.deepEqual(sources.sources.map(x=>x.tool),['prices']);assert.equal(f.requests.length,0);
  const prepared=await f.prepare();assert.equal(prepared.review.endpoint,`${f.integrations.get('fixture_api').baseUrl}/prices`);
  assert.equal(JSON.stringify(prepared).includes(key),false);assert.equal(f.requests.length,0);
  const result=await f.run(prepared.identity);assert.deepEqual(result.output,{value:42,env:['undefined','undefined','undefined']});
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'/prices?symbol=TEST&limit=2');assert.equal(f.requests[0].method,'GET');assert.equal(f.requests[0].headers.authorization,`Bearer ${key}`);assert.equal(f.requests[0].headers.cookie,undefined);
  assert.equal(JSON.stringify(result).includes(key),false);assert.equal(result.source.requests,1);
});
test('caller cannot turn approved:true or model-supplied identity into gateway authorization',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.tools.execute(f.bot,'workshop_read_api',f.args),/approval/);
  await assert.rejects(f.tools.execute(f.bot,'workshop_read_api',f.args,{approved:true}),/approval/);
  await assert.rejects(f.run('f'.repeat(64)),/changed/);
  await assert.rejects(f.tools.execute(f.bot,'workshop_read_api',{...f.args,approvedIdentity:'fake'},{approved:true}),/unknown arguments/);
  assert.equal(f.requests.length,0);assert.equal(SAFE_RETRY_READS.has('workshop_read_api'),false);
  for(const approvalPolicy of ['balanced','strict'])assert.equal(f.tools.requiresApproval('workshop_read_api',{...f.bot,approvalPolicy}),true);
});
test('gateway refuses write methods, MCP, unknown parameters and excessive inputs before dispatch',async t=>{
  const f=await fixture(t);
  for(const change of [{tool:'write'},{arguments:{symbol:'TEST',url:'https://example.com'}},{arguments:{symbol:'TEST',limit:6}},{arguments:{symbol:['TEST']}},{arguments:{symbol:'x'.repeat(9000)}},{input:'x'.repeat(17000)},{headers:{Authorization:'guess'}},{digest:'bad'}]){
    await assert.rejects(prepareWorkshopRead(f.store,f.bot,f.integrations,{...f.args,...change}));
  }
  f.integrations.get('fixture_api').type='mcp';await assert.rejects(f.prepare(),/REST GET/);assert.equal(listWorkshopSources(f.store,f.bot,f.integrations).sources.length,0);assert.equal(f.requests.length,0);
});
test('new current assignments cannot expand an active snapshot; revocation blocks previously approved reads',async t=>{
  const f=await fixture(t),prepared=await f.prepare();
  for(const group of ['workshop','integrations']){
    const snapshot={...f.bot,tools:f.bot.tools.filter(x=>x!==group)};
    await assert.rejects(prepareWorkshopRead(f.store,snapshot,f.integrations,f.args),/enable both/);
    f.store.state.bots[0].tools=f.bot.tools.filter(x=>x!==group);await assert.rejects(f.run(prepared.identity),/enable both/);f.store.state.bots[0].tools=[...f.bot.tools];
  }
  await assert.rejects(prepareWorkshopRead(f.store,{...f.bot,integrationIds:[]},f.integrations,f.args),/assigned/);
  f.store.state.bots[0].integrationIds=[];await assert.rejects(f.run(prepared.identity),/assigned/);
  f.store.state.bots[0].integrationIds=['fixture_api'];f.store.state.bots[0].enabled=false;await assert.rejects(f.run(prepared.identity),/enable both/);assert.equal(f.requests.length,0);
});
test('approval binds configuration, schema, credential, local input, request and exact package version',async t=>{
  const f=await fixture(t),prepared=await f.prepare(),original=structuredClone(f.integrations.get('fixture_api'));
  for(const mutate of [i=>i.baseUrl+='/other',i=>i.secret=f.store.seal('rotated-synthetic-key'),i=>i.tools[0].path='/other',i=>i.tools[0].inputSchema.properties.limit.maximum=6,i=>i.name='Renamed']){
    mutate(f.integrations.get('fixture_api'));await assert.rejects(f.run(prepared.identity),/changed/);f.store.state.integrations=[structuredClone(original)];
  }
  for(const change of [{input:{scale:3}},{arguments:{symbol:'TEST',limit:1}}])await assert.rejects(runWorkshopRead(f.store,f.bot,f.integrations,{...f.args,...change},{approved:true,approvedIdentity:prepared.identity}),/changed/);
  const newer=await buildWorkshopTool(f.store,f.bot,{...pkg,description:'A different revision.'});
  await assert.rejects(runWorkshopRead(f.store,f.bot,f.integrations,{...f.args,digest:newer.digest},{approved:true,approvedIdentity:prepared.identity}),/changed/);assert.equal(f.requests.length,0);
});
test('damaged package is rejected before the request',async t=>{
  const f=await fixture(t),prepared=await f.prepare(),file=path.join(f.store.directory,'workshop',f.bot.id,'packages',`${f.args.digest}.json`),record=JSON.parse(await fs.readFile(file,'utf8'));
  record.package.source='x=>0';await fs.writeFile(file,JSON.stringify(record));await assert.rejects(f.run(prepared.identity),/revision changed/);assert.equal(f.requests.length,0);
});
test('remote redirects are refused and credentials never reach a second path',async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(302,{Location:'/target'});res.end();}),prepared=await f.prepare();
  await assert.rejects(f.run(prepared.identity),/redirects are refused/);assert.equal(f.requests.length,1);
});
test('oversized or invalid API data never becomes a successful workshop result',async t=>{
  let mode='large';const f=await fixture(t,(_req,res)=>{
    if(mode==='large')return json(res,{price:1,padding:'x'.repeat(65536)});
    if(mode==='invalid'){res.end('<html>not json</html>');return;}
    if(mode==='sse'){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"price":21}\n\n');return;}
    json(res,{price:1,padding:'x'.repeat(58000)});
  });
  for(mode of ['large','invalid','sse']){const prepared=await f.prepare();await assert.rejects(f.run(prepared.identity),/size limit|invalid JSON|finite JSON/);}
  mode='combined';f.args.input={scale:2,padding:'x'.repeat(12000)};const prepared=await f.prepare();await assert.rejects(f.run(prepared.identity),/workshop limit/);assert.equal(f.requests.length,4);
});
test('metadata destinations remain forbidden even when a configuration is changed outside the normal owner validator',async t=>{
  const f=await fixture(t);f.integrations.get('fixture_api').baseUrl='http://169.254.169.254';const prepared=await f.prepare();
  await assert.rejects(f.run(prepared.identity),/metadata|link-local/);assert.equal(f.requests.length,0);
});
test('revocation during a response discards the result',async t=>{
  let respond;const f=await fixture(t,(_req,res)=>{respond=()=>json(res,{price:21});}),prepared=await f.prepare(),pending=f.run(prepared.identity);
  while(!respond)await new Promise(resolve=>setTimeout(resolve,5));f.store.state.bots[0].integrationIds=[];respond();await assert.rejects(pending,/assigned/);assert.equal(f.requests.length,1);
});
test('Stop aborts an in-flight API request with no automatic retry',async t=>{
  let received;const seen=new Promise(resolve=>{received=resolve;});const f=await fixture(t,()=>received()),prepared=await f.prepare(),controller=new AbortController();
  const pending=f.run(prepared.identity,{signal:controller.signal});await seen;controller.abort(new Error('fixture-stop'));await assert.rejects(pending,/fixture-stop/);assert.equal(f.requests.length,1);
});
test('known credentials echoed by an API are redacted before guest processing',async t=>{
  const f=await fixture(t,(_req,res)=>json(res,{credential:key}));const built=await buildWorkshopTool(f.store,f.bot,{...pkg,source:'x=>x.response.credential',tests:[{input:{response:{credential:'synthetic'}},expected:'synthetic'}]});
  f.args.digest=built.digest;const prepared=await f.prepare(),result=await f.run(prepared.identity);assert.equal(result.output.includes(key),false);assert.match(result.output,/redacted/i);
});
test('an API-declared failed result cannot be laundered into successful computed output',async t=>{
  const f=await fixture(t,(_req,res)=>json(res,{isError:true,price:21})),prepared=await f.prepare();
  await assert.rejects(f.run(prepared.identity),/failed result/);assert.equal(f.requests.length,1);
});
