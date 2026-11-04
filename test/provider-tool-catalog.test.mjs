import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {Providers} from '../lib/providers.mjs';
import {NativeEngine} from '../lib/engine.mjs';
import {TOOL_GROUPS} from '../lib/agent-tools.mjs';

const messages=[{role:'user',content:'Return a synthetic catalog check.'}];
const protocols=['openai','chatgpt','anthropic','custom'];
async function fixture(t,type){
  const directory=await mkdtemp(path.join(tmpdir(),'tupies-tool-catalog-')),store=await new Store(directory).init(),requests=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify(type==='anthropic'?{content:[{type:'text',text:'Catalog received.'}],stop_reason:'end_turn'}:type==='custom'?{choices:[{message:{role:'assistant',content:'Catalog received.'},finish_reason:'stop'}]}:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Catalog received.'}]}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const providers=new Providers(store,{requestTimeout:5000,allowTestOAuth:true});
  const connection={id:'catalog_provider',type,name:'Synthetic provider',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,defaultModel:'fixture-model',secret:store.seal('synthetic-catalog-key'),imageInput:'on'};
  if(type==='chatgpt')providers.headers=async()=>({Authorization:'Bearer synthetic-catalog-key'});
  await store.mutate(state=>{state.connections.push(connection);Object.assign(state.bots[0],{connectionId:connection.id,model:'fixture-model',tools:[...TOOL_GROUPS]});});
  const engine=new NativeEngine(store,{providers,executionMode:'bounded'});
  // Availability only shapes the catalog. These tests never launch a browser or coding process.
  engine.browsers.available=()=>true;engine.localCoding.available=()=>true;
  t.after(async()=>{await engine.close();await providers.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const offered=(body=requests.at(-1))=>{
    const tools=type==='chatgpt'?body.tools[0].tools:body.tools;
    if(type==='chatgpt'){assert.equal(body.tools.length,1);assert.equal(body.tools[0].name,'tupies');assert.equal(body.tools[0].type,'namespace');}
    return tools.map(tool=>({name:tool.function?.name ?? tool.name,description:tool.function?.description ?? tool.description,parameters:tool.function?.parameters ?? tool.parameters ?? tool.input_schema}));
  };
  return {store,providers,connection,engine,requests,offered};
}

test('complete native chat and Mission catalogs reach every provider protocol without truncation',async t=>{
  for(const type of protocols)await t.test(type,async t=>{
    const f=await fixture(t,type),bot=f.store.state.bots[0],runId='catalog_run';
    for(const mission of [false,true])for(const images of [false,true])for(const coding of [false,true]){
      f.engine.localCoding.available=()=>coding;
      f.store.state.runs[bot.id]={id:runId,botId:bot.id,status:'completed',...(mission?{missionId:'catalog_mission'}:{})};
      f.store.state.missions ||= {};
      f.store.state.missions.catalog_mission={id:'catalog_mission',state:'running',leadBotId:bot.id,ownerEngineId:f.engine.missions.ownerEngineId,episodeRefs:[{runId,botId:bot.id}]};
      const tools=f.engine.toolDefinitions({bot,source:'chat',runId,connection:f.connection,inference:{model:'fixture-model',images}});
      assert.ok(tools.length>100,`Must exercise the old failure: ${tools.length}`);
      assert.ok(tools.length<=128,`Native catalog exceeds provider capacity: ${tools.length}`);
      assert.equal(new Set(tools.map(tool=>tool.name)).size,tools.length);
      assert.ok(tools.some(tool=>tool.name==='browser_open'));
      assert.equal(tools.some(tool=>tool.name==='mission_contract_set'),mission);
      assert.equal(tools.some(tool=>tool.name==='workspace_image'),images);
      assert.equal(tools.some(tool=>tool.name==='coding_projects'),coding);
      await f.providers.complete(f.connection,{messages,tools});
      assert.deepEqual(f.offered(),tools,'Every name, description and parameter schema must survive transport');
    }
  });
});

test('128 tools fit and oversized or non-array catalogs fail before any provider request',async t=>{
  for(const type of protocols)await t.test(type,async t=>{
    const f=await fixture(t,type),tools=Array.from({length:128},(_,index)=>({name:`fixture_${index}`,description:'Synthetic function.',parameters:{type:'object',properties:{},additionalProperties:false}}));
    await f.providers.complete(f.connection,{messages,tools});assert.deepEqual(f.offered(),tools);
    await assert.rejects(f.providers.complete(f.connection,{messages,tools:[...tools,{...tools[0],name:'fixture_overflow'}]}),error=>error.status===400 && /129.*128/.test(error.message) && /bot settings/i.test(error.message));
    for(const tools of [null,{},'invalid'])await assert.rejects(f.providers.complete(f.connection,{messages,tools}),error=>error.status===400);
    assert.equal(f.requests.length,1,'Invalid catalogs must never reach credentialed transport');
  });
});

test('a bot with all tool groups completes through the real Engine and provider adapter',async t=>{
  const f=await fixture(t,'chatgpt'),bot=f.store.state.bots[0];
  const started=await f.engine.start(bot.id,'Return a synthetic catalog check.');await f.engine.tasks.get(started.id);
  const run=f.store.state.runs[bot.id];assert.equal(run.status,'completed',run.error);
  // The separate final-memory review has its own single-tool catalog.
  const taskRequests=f.requests.filter(request=>request.tools?.length && f.offered(request).some(tool=>tool.name==='browser_open'));assert.equal(taskRequests.length,1);
  for(const request of taskRequests){assert.ok(f.offered(request).length>100);assert.ok(f.offered(request).some(tool=>tool.name==='browser_handoff'));}
  assert.ok(f.store.state.messages[bot.id].some(message=>message.role==='assistant' && message.content==='Catalog received.'));
});
