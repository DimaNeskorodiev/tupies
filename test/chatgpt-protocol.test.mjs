import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../lib/store.mjs';
import {Providers,responsesInput} from '../lib/providers.mjs';

const tool={name:'workspace_read',description:'Read a private file.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}};
async function fixture(t,output) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-chatgpt-protocol-')),store=await new Store(directory).init(),requests=[];
  const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output:typeof output==='function'?output(requests.length):output,usage:{input_tokens:10,output_tokens:5}}})}\n\n`);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const providers=new Providers(store,{allowTestOAuth:true}),connection={...providers.validate({type:'chatgpt',name:'Fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,defaultModel:'fixture',maxOutputTokens:512}),id:'fixture'};
  providers.oauth.bearer=async()=> 'disposable-protocol-token';await store.mutate(state=>state.connections.push(connection));
  t.after(async()=>{await providers.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  return {providers,connection,requests,complete:messages=>providers.complete(connection,{model:'fixture',messages,tools:[tool]})};
}

test('ChatGPT subscription uses namespace tools and omits unsupported remote token caps across a tool round trip',async t=>{
  const f=await fixture(t,count=>count===1?[{type:'reasoning',id:'r_fixture',encrypted_content:'opaque-fixture'},{type:'function_call',namespace:'tupies',call_id:'call_fixture',name:'workspace_read',arguments:'{"path":"fixture.txt"}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Verified fixture.'}]}]);
  const messages=[{role:'system',content:'Use the permitted engine tools.'},{role:'user',content:'Read the fixture.'}],first=await f.complete(messages);
  const body=f.requests[0];assert.equal(body.max_output_tokens,undefined);assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.tools.length,1);assert.equal(body.tools[0].type,'namespace');assert.equal(body.tools[0].name,'tupies');assert.equal(body.tools[0].tools[0].name,tool.name);assert.equal(body.tools[0].tools[0].strict,false);
  assert.deepEqual(first.toolCalls,[{id:'call_fixture',name:'workspace_read',arguments:{path:'fixture.txt'}}]);assert.equal(first.outputLimit.enforcedByProvider,false);assert.equal(first.outputLimit.requestedTokens,512);
  messages.push({role:'assistant',content:first.text,providerItems:first.providerItems,tool_calls:[{id:'call_fixture',type:'function',function:{name:'workspace_read',arguments:'{"path":"fixture.txt"}'}}]},{role:'tool',tool_call_id:'call_fixture',content:'Actual fixture result.'});
  const original=structuredClone(messages);await f.complete(messages);assert.deepEqual(messages,original);
  assert.equal(f.requests[1].input.find(item=>item.type==='function_call').namespace,'tupies');assert.equal(f.requests[1].input.at(-1).namespace,'tupies');assert.equal(f.requests[1].input.at(-1).call_id,'call_fixture');assert.equal(f.requests[1].input.filter(item=>item.type==='function_call').length,1);
});

for(const item of [{namespace:'foreign',name:'workspace_read'},{name:'workspace_read'},{namespace:'tupies',name:'unoffered_tool'}])test(`ChatGPT refuses unoffered or incorrectly scoped calls (${item.namespace || 'missing'}/${item.name})`,async t=>{
  const f=await fixture(t,[{type:'function_call',...item,call_id:'call_fixture',arguments:'{}'}]);
  await assert.rejects(f.complete([{role:'user',content:'Try the fixture.'}]),/outside the offered Tupies namespace/);assert.equal(f.requests.length,1);
});

test('legacy canonical calls are namespaced without mutating history, and foreign provider namespaces are refused',()=>{
  const messages=[{role:'assistant',content:'',tool_calls:[{id:'old_call',type:'function',function:{name:'workspace_read',arguments:'{}'}}]},{role:'tool',tool_call_id:'old_call',content:'Retained result.'}],before=structuredClone(messages);
  assert.equal(responsesInput(messages,{namespace:'tupies'})[0].namespace,'tupies');assert.deepEqual(messages,before);assert.equal(responsesInput(messages)[0].namespace,undefined);
  assert.throws(()=>responsesInput([{role:'assistant',providerItems:[{type:'function_call',namespace:'foreign',call_id:'bad',name:'workspace_read',arguments:'{}'}]}],{namespace:'tupies'}),/unexpected function namespace/);
});
