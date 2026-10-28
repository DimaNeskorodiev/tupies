import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';

const SECRET='integration-fixture-key';
async function fixture(t,handler){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-integrations-')),store=await new Store(directory).init();store.state.integrations=[];
  const requests=[],server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const request={method:req.method,url:req.url,headers:req.headers,body:raw?JSON.parse(raw):null};requests.push(request);try{handler(request,res);}catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.message}}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,integrations=new Integrations(store,{requestTimeout:1000});
  t.after(async()=>{await integrations.close();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  return {store,requests,origin,integrations};
}
function json(res,data,status=200){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}
async function add(f,input){const integration={...f.integrations.validate({name:'Fixture integration',apiKey:SECRET,baseUrl:f.origin,...input}),id:'integration_test'};await f.store.mutate(state=>{state.integrations.push(integration);state.bots[0].integrationIds=[integration.id];});return integration;}

test('REST actions require assigned bot and exact approval before sending fixed-path requests',async t=>{
  const f=await fixture(t,(req,res)=>{assert.equal(req.headers.authorization,`Bearer ${SECRET}`);assert.equal(req.headers['user-agent'],'Tupies/0.2.0');json(res,{ok:true,query:req.url});});
  const integration=await add(f,{type:'rest',tools:[{name:'list_items',description:'List visible items.',method:'GET',path:'/items',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:50}},required:['limit'],additionalProperties:false}}]});
  await f.integrations.discover(integration.id);assert.equal(f.requests.length,0,'REST discovery must not execute an API action');
  await assert.rejects(f.integrations.call(integration.id,'list_items',{limit:10},{botId:'bot_atlas'}),/approval/);
  await assert.rejects(f.integrations.call(integration.id,'list_items',{limit:10},{botId:'bot_scout',approved:true}),/not assigned/);
  await assert.rejects(f.integrations.call(integration.id,'list_items',{limit:100},{botId:'bot_atlas',approved:true}),/maximum/);
  assert.equal(f.requests.length,0);
  const result=await f.integrations.call(integration.id,'list_items',{limit:10},{botId:'bot_atlas',approved:true});assert.equal(result.query,'/items?limit=10');
  assert.equal(f.integrations.listTools(f.store.state.bots[0])[0].integrationId,integration.id);
  assert.ok(!(await fs.readFile(f.store.file,'utf8')).includes(SECRET));
});

test('MCP initializes, retains session/version headers, discovers tools and calls through SSE',async t=>{
  const f=await fixture(t,(req,res)=>{
    assert.equal(req.url,'/mcp');assert.equal(req.headers.authorization,`Bearer ${SECRET}`);assert.ok(req.headers.accept.includes('text/event-stream'));
    if(req.body.method==='initialize'){res.setHeader('Mcp-Session-Id','test-session');return json(res,{jsonrpc:'2.0',id:req.body.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}});}
    assert.equal(req.headers['mcp-session-id'],'test-session');assert.equal(req.headers['mcp-protocol-version'],'2025-06-18');
    if(req.body.method==='notifications/initialized'){res.writeHead(202);return res.end();}
    if(req.body.method==='tools/list')return json(res,{jsonrpc:'2.0',id:req.body.id,result:{tools:[{name:'echo',description:'Echo the value.',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}]}});
    assert.equal(req.body.method,'tools/call');assert.deepEqual(req.body.params,{name:'echo',arguments:{value:'hello'}});
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({jsonrpc:'2.0',id:req.body.id,result:{content:[{type:'text',text:'hello'}]}})}\n\n`);
  });
  const integration=await add(f,{type:'mcp',baseUrl:`${f.origin}/mcp`});
  const catalog=await f.integrations.discover(integration.id);assert.equal(catalog.tools[0].name,'echo');
  const result=await f.integrations.call(integration.id,'echo',{value:'hello'},{botId:'bot_atlas',approved:true});assert.equal(result.content[0].text,'hello');
  assert.deepEqual(f.requests.map(request=>request.body.method),['initialize','notifications/initialized','tools/list','tools/call']);
});

test('integration config rejects unsafe methods, paths, credentials, schemas and malformed MCP responses',async t=>{
  const f=await fixture(t,(req,res)=>json(res,{jsonrpc:'2.0',id:'wrong-id',result:{}}));
  const base={name:'Unsafe',type:'rest',baseUrl:f.origin,authType:'none'};
  for(const path of ['//evil.example/x','/../secret','/x?url=https://evil.example','/%2e%2e/x'])assert.throws(()=>f.integrations.validate({...base,tools:[{name:'x',method:'GET',path}]}),/safe paths/);
  assert.throws(()=>f.integrations.validate({...base,tools:[{name:'x',method:'CONNECT',path:'/x'}]}),/method/);
  assert.throws(()=>f.integrations.validate({...base,authType:'header',headerName:'Host',apiKey:SECRET,tools:[{name:'x',method:'GET',path:'/x'}]}),/authentication header/);
  const integration=await add(f,{type:'mcp'});await assert.rejects(f.integrations.discover(integration.id),/unmatched response/);assert.equal(f.integrations.sessions.has(integration.id),false);
});
