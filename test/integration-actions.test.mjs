import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Integrations, decodeResponseFields } from '../lib/integrations.mjs';
import { buildWorkshopTool } from '../lib/workshop.mjs';
import { prepareWorkshopRead, runWorkshopRead } from '../lib/workshop-gateway.mjs';

const SECRET='integration-actions-fixture-key';
const b64url=text=>Buffer.from(text,'utf8').toString('base64url');
async function fixture(t,handler=(_req,res)=>json(res,{ok:true})){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-integration-actions-')),store=await new Store(directory).init();store.state.integrations=[];
  const requests=[],server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const request={method:req.method,url:req.url,headers:req.headers,body:raw?JSON.parse(raw):null};requests.push(request);try{handler(request,res);}catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.message}}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,integrations=new Integrations(store,{requestTimeout:1000});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await integrations.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  return {store,requests,origin,integrations};
}
function json(res,data,status=200){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}
async function add(f,input){const integration={...f.integrations.validate({name:'Fixture API',type:'rest',apiKey:SECRET,baseUrl:f.origin,...input}),id:'integration_actions'};await f.store.mutate(state=>{state.integrations=[integration];state.bots[0].integrationIds=[integration.id];});return integration;}
const call=(f,name,args)=>f.integrations.call('integration_actions',name,args,{botId:'bot_atlas',approved:true});
const getMessage={name:'get_message',description:'Read one message.',method:'GET',path:'/users/{userId}/messages/{id}',inputSchema:{type:'object',properties:{userId:{type:'string'},id:{type:'string'},format:{type:'string'},page:{type:'integer'}},required:['userId','id'],additionalProperties:false}};

test('path placeholders are filled with one encoded segment and are not repeated as query or body',async t=>{
  const f=await fixture(t,(req,res)=>json(res,{url:req.url,body:req.body}));
  await add(f,{tools:[getMessage,{name:'page',method:'DELETE',path:'/pages/{page}',inputSchema:{type:'object',properties:{page:{type:'integer'},note:{type:'string'}},required:['page']}}]});
  assert.equal((await call(f,'get_message',{userId:'me',id:'a b?c#d%',format:'full'})).url,'/users/me/messages/a%20b%3Fc%23d%25?format=full');
  assert.deepEqual(await call(f,'page',{page:42,note:'x'}),{url:'/pages/42',body:{note:'x'}});
  assert.deepEqual(await call(f,'page',{page:7}),{url:'/pages/7',body:null});
  for(const id of ['..','.','a/b','a\\b','a\nb','','x'.repeat(513)])await assert.rejects(call(f,'get_message',{userId:'me',id}),/Path input id/);
  assert.equal(f.requests.length,3);
});

test('placeholders must be declared required string or integer inputs and literal path rules remain',async t=>{
  const f=await fixture(t),base={name:'Paths',type:'rest',baseUrl:f.origin,authType:'none'},schema=(properties,required=Object.keys(properties))=>({type:'object',properties,required});
  const bad=[
    {path:'/x/{id}',inputSchema:schema({})},
    {path:'/x/{id}',inputSchema:schema({id:{type:'string'}},[])},
    {path:'/x/{id}',inputSchema:schema({id:{type:'boolean'}})},
    {path:'/x/{id}/{id}',inputSchema:schema({id:{type:'string'}})},
  ];
  for(const tool of bad)assert.throws(()=>f.integrations.validate({...base,tools:[{name:'x',method:'GET',...tool}]}),/placeholder/);
  for(const path of ['/x/{id','/x/{1d}','{id}/x','//{id}','/../{id}','/{id}?q=1','/%2f/{id}'])assert.throws(()=>f.integrations.validate({...base,tools:[{name:'x',method:'GET',path,inputSchema:schema({id:{type:'string'}})}]}),/safe paths/);
  const valid=f.integrations.validate({...base,tools:[{name:'x',method:'GET',path:'/v1/{name}:generate',inputSchema:schema({name:{type:'string'}})}]});assert.equal(valid.tools[0].path,'/v1/{name}:generate');
});

test('non-GET query lists, repeated array query values and their limits',async t=>{
  const f=await fixture(t,(req,res)=>json(res,{url:req.url,body:req.body}));
  await add(f,{tools:[
    {name:'modify',method:'POST',path:'/messages/{id}/modify',query:['fields','labelIds'],inputSchema:{type:'object',properties:{id:{type:'string'},fields:{type:'string'},labelIds:{type:'array',items:{type:'string'}},addLabelIds:{type:'array',items:{type:'string'}}},required:['id']}},
    {name:'list',method:'GET',path:'/messages',inputSchema:{type:'object',properties:{labelIds:{type:'array',items:{type:'string'}},q:{type:'string'},nothing:{type:'null'}}}},
  ]});
  assert.deepEqual(await call(f,'modify',{id:'m1',fields:'id',labelIds:['A','B'],addLabelIds:['STARRED']}),{url:'/messages/m1/modify?fields=id&labelIds=A&labelIds=B',body:{addLabelIds:['STARRED']}});
  assert.equal((await call(f,'list',{labelIds:['INBOX','UNREAD'],q:'is:unread',nothing:null})).url,'/messages?labelIds=INBOX&labelIds=UNREAD&q=is%3Aunread');
  await assert.rejects(call(f,'list',{labelIds:Array(51).fill('A')}),/at most 50/);
  await assert.rejects(call(f,'list',{labelIds:[{a:1}]}),/invalid type|scalar/);
  assert.equal(f.requests.length,2);
  const base={name:'Q',type:'rest',baseUrl:f.origin,authType:'none'},inputSchema={type:'object',properties:{id:{type:'string'},a:{type:'string'}},required:['id']};
  assert.throws(()=>f.integrations.validate({...base,tools:[{name:'x',method:'GET',path:'/x',query:['a'],inputSchema}]}),/Remove query/);
  for(const query of [[],['missing'],['id'],['a','a'],'a',Array(33).fill('a')])assert.throws(()=>f.integrations.validate({...base,tools:[{name:'x',method:'POST',path:'/x/{id}',query,inputSchema}]}),/query must list/);
});

test('encode turns declared plain text inputs into base64url or base64 before sending',async t=>{
  const f=await fixture(t,(req,res)=>json(res,{url:req.url,body:req.body}));
  const message='To: owner@example.test\r\nSubject: Привет\r\n\r\nHello ü?>';
  await add(f,{tools:[{name:'send',method:'POST',path:'/messages/send',encode:{raw:'base64url',note:'base64'},query:['note'],inputSchema:{type:'object',properties:{raw:{type:'string'},note:{type:'string'},threadId:{type:'string'}},required:['raw']}}]});
  const result=await call(f,'send',{raw:message,note:'??>',threadId:'t1'});
  assert.deepEqual(result.body,{raw:b64url(message),threadId:'t1'});assert.equal(Buffer.from(result.body.raw,'base64url').toString('utf8'),message);
  assert.equal(result.url,`/messages/send?note=${encodeURIComponent(Buffer.from('??>').toString('base64'))}`);
  const base={name:'E',type:'rest',baseUrl:f.origin,authType:'none'};
  for(const encode of [{n:'base64'},{raw:'hex'},{id:'base64'},{},[]])assert.throws(()=>f.integrations.validate({...base,tools:[{name:'x',method:'POST',path:'/x/{id}',encode,inputSchema:{type:'object',properties:{raw:{type:'string'},n:{type:'integer'},id:{type:'string'}},required:['id']}}]}),/encode must map/);
});

test('decode replaces clean UTF-8 under declared keys at depth and leaves binary, plain or unlisted values alone',async t=>{
  const binary=Buffer.from([0xff,0xfe,0x00,0x81]).toString('base64url'),deep={};let cursor=deep;for(let i=0;i<40;i++){cursor.next={};cursor=cursor.next;}cursor.data=b64url('too deep');
  const f=await fixture(t,(_req,res)=>json(res,{id:'m1',payload:{body:{data:b64url('Top ✓')},parts:[{body:{data:b64url('Hello ü\r\n')}},{body:{data:binary}},{body:{data:'plain words'}},{body:{size:3,other:b64url('kept')}},{parts:[{body:{data:b64url('nested')}}]}]},deep}));
  await add(f,{tools:[{name:'get',method:'GET',path:'/m',decode:{keys:['data'],as:'base64url'},inputSchema:{type:'object',properties:{}}}]});
  const result=await call(f,'get',{});
  assert.equal(result.payload.body.data,'Top ✓');assert.equal(result.payload.parts[0].body.data,'Hello ü\r\n');assert.equal(result.payload.parts[1].body.data,binary);assert.equal(result.payload.parts[2].body.data,'plain words');
  assert.equal(result.payload.parts[3].body.other,b64url('kept'));assert.equal(result.payload.parts[4].parts[0].body.data,'nested');
  let leaf=result.deep;while(leaf.next)leaf=leaf.next;assert.equal(leaf.data,b64url('too deep'));
  const big=Buffer.alloc(700_000,'a').toString('base64'),budget=decodeResponseFields({a:{data:big},b:{data:big}},{keys:['data'],as:'base64'});assert.equal(budget.a.data.length,700_000);assert.equal(budget.b.data,big);
  const base={name:'D',type:'rest',baseUrl:f.origin,authType:'none'};
  for(const decode of [{keys:[],as:'base64'},{keys:['data'],as:'hex'},{keys:['a b'],as:'base64'},{keys:Array.from({length:9},(_,i)=>`k${i}`),as:'base64'},{keys:['data'],as:'base64',extra:1},'data'])assert.throws(()=>f.integrations.validate({...base,tools:[{name:'x',method:'GET',path:'/x',decode}]}),/decode needs/);
});

test('static headers are sent but cannot replace authentication, engine or reserved headers',async t=>{
  const f=await fixture(t,(req,res)=>json(res,{headers:req.headers}));
  const integration=await add(f,{authType:'header',headerName:'X-Api-Key',headers:{'Notion-Version':'2022-06-28','X-Trace':'fixture'},tools:[{name:'get',method:'GET',path:'/x',inputSchema:{type:'object',properties:{}}}]});
  const {headers}=await call(f,'get',{});assert.equal(headers['notion-version'],'2022-06-28');assert.equal(headers['x-trace'],'fixture');assert.equal(f.requests[0].headers['x-api-key'],SECRET);assert.equal(headers['user-agent'],'Tupies/0.2.0');
  const base={name:'H',type:'rest',baseUrl:f.origin,authType:'header',headerName:'X-Api-Key',apiKey:SECRET,tools:[{name:'x',method:'GET',path:'/x'}]};
  for(const name of ['Authorization','authorization','x-api-key','Host','Cookie','Accept','Content-Type','User-Agent','Mcp-Session-Id','Bad Header','X_Under'])assert.throws(()=>f.integrations.validate({...base,headers:{[name]:'v'}}),/reserved or unsafe/,name);
  for(const value of ['a\r\nInjected: 1','x'.repeat(513),7])assert.throws(()=>f.integrations.validate({...base,headers:{'X-Ok':value}}),/Header values/);
  assert.throws(()=>f.integrations.validate({...base,headers:Object.fromEntries(Array.from({length:9},(_,i)=>[`X-H${i}`,'v']))}),/at most 8/);
  assert.throws(()=>f.integrations.validate({...base,headers:{'X-A':'1','x-a':'2'}}),/distinct/);
  const bearer=f.integrations.validate({...base,authType:'bearer',headers:{'X-Api-Key':'not-auth-here'}});assert.equal(bearer.headers['X-Api-Key'],'not-auth-here');
  const changed=f.integrations.validate({headers:{'Notion-Version':'2025-01-01'}},integration);assert.equal(changed.secret,integration.secret);assert.deepEqual(changed.headers,{'Notion-Version':'2025-01-01'});
  assert.equal(f.integrations.validate({headers:null},integration).headers,undefined);assert.deepEqual(f.integrations.validate({name:'Kept'},integration).headers,integration.headers);
});

test('old-shape actions keep their stored form and request behavior',async t=>{
  const f=await fixture(t,(req,res)=>json(res,{url:req.url,body:req.body}));
  const tools=[{name:'list',description:'List.',method:'GET',path:'/items',approval:'auto',inputSchema:{type:'object',properties:{limit:{type:'integer'},q:{type:'string'}}}},{name:'create',description:'Create.',method:'POST',path:'/items',inputSchema:{type:'object',properties:{title:{type:'string'},count:{type:'integer'}}}}];
  const integration=await add(f,{tools});
  assert.deepEqual(integration.tools,tools);assert.deepEqual(f.integrations.validate({},integration).tools,tools);
  assert.deepEqual(await call(f,'list',{limit:5,q:'a b'}),{url:'/items?limit=5&q=a+b',body:null});
  assert.deepEqual(await call(f,'create',{title:'T',count:2}),{url:'/items',body:{title:'T',count:2}});
  assert.deepEqual(f.integrations.listTools(f.store.state.bots[0]).map(tool=>Object.keys(tool)),[['integrationId','integrationName','name','description','parameters','requiresApproval'],['integrationId','integrationName','name','description','parameters','requiresApproval']]);
  // Earlier presets keep their plain shape; Gmail is the one preset that relies on encode/decode.
  for(const preset of f.integrations.catalog().filter(item=>item.type==='rest' && item.tools && item.id!=='gmail'))for(const tool of preset.tools)assert.ok(!('query' in tool || 'encode' in tool || 'decode' in tool));
});

test('discovered MCP tools never gain REST action fields',async t=>{
  const f=await fixture(t,(req,res)=>{
    const method=req.body.method;
    if(method==='initialize')return json(res,{jsonrpc:'2.0',id:req.body.id,result:{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'fixture',version:'1'}}});
    if(method==='notifications/initialized'){res.writeHead(202);return res.end();}
    return json(res,{jsonrpc:'2.0',id:req.body.id,result:{tools:[{name:'act',inputSchema:{type:'object',properties:{}},method:'GET',path:'/{x}',query:['x'],encode:{x:'base64'},decode:{keys:['data'],as:'base64'}}]}});
  });
  const integration={...f.integrations.validate({name:'MCP',type:'mcp',apiKey:SECRET,baseUrl:`${f.origin}/mcp`}),id:'mcp_actions'};await f.store.mutate(state=>{state.integrations=[integration];});
  const {tools}=await f.integrations.discover(integration.id);assert.deepEqual(Object.keys(tools[0]).sort(),['description','inputSchema','name']);
});

test('workshop gateway resolves path inputs in its review and binds new action fields and static headers',async t=>{
  const f=await fixture(t,(_req,res)=>json(res,{price:21}));
  const action={name:'price',description:'Fixture price.',method:'GET',path:'/prices/{symbol}',inputSchema:{type:'object',properties:{symbol:{type:'string',maxLength:10},limit:{type:'integer'}},required:['symbol'],additionalProperties:false}};
  await add(f,{tools:[action]});await f.store.mutate(state=>{state.bots[0].tools=['workshop','integrations'];});
  const bot=structuredClone(f.store.state.bots[0]),built=await buildWorkshopTool(f.store,bot,{id:'double',title:'Double',description:'Double a fixture price.',source:'x=>x.response.price*2',tests:[{input:{response:{price:1}},expected:2}]});
  const args={digest:built.digest,integrationId:'integration_actions',tool:'price',arguments:{symbol:'A B',limit:1},input:{}};
  const run=identity=>runWorkshopRead(f.store,bot,f.integrations,args,{approved:true,approvedIdentity:identity});
  const prepared=await prepareWorkshopRead(f.store,bot,f.integrations,args);assert.equal(prepared.review.endpoint,`${f.origin}/prices/A%20B`);
  await assert.rejects(prepareWorkshopRead(f.store,bot,f.integrations,{...args,arguments:{symbol:'..'}}),/Path input/);
  const original=structuredClone(f.integrations.get('integration_actions'));
  for(const mutate of [i=>{i.tools[0].decode={keys:['price'],as:'base64'};},i=>{i.headers={'X-Version':'2'};},i=>{i.tools[0].path='/prices/{symbol}/x';}]){
    mutate(f.integrations.get('integration_actions'));await assert.rejects(run(prepared.identity),/changed/);f.store.state.integrations=[structuredClone(original)];
  }
  assert.equal(f.requests.length,0);
  const result=await run(prepared.identity);assert.equal(result.output,42);assert.equal(f.requests[0].url,'/prices/A%20B?limit=1');
});
