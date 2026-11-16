import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudioServer } from '../server.mjs';
import { isActive } from '../lib/engine.mjs';

const KEY='owner-fixture-api-key';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=15000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=predicate();if(value)return value;await delay(5);}throw new Error('Integration proposal fixture timed out.');}
const bridged=(id,name,args)=>({id,name:'tool_call',arguments:{name,arguments:args}});
const output=(request,id)=>JSON.parse(request.messages.findLast(message=>message.tool_call_id===id).content);
const listItems={name:'list_items',description:'List the owner’s items.',method:'GET',path:'/items',inputSchema:{type:'object',properties:{},additionalProperties:false}};

/** A real Engine server with a scripted model, an approving risk reviewer and a local fixture API. */
async function fixture(t,script,{policy='auto'}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-integration-propose-'));
  const api=[],service=http.createServer((req,res)=>{api.push({method:req.method,url:req.url,authorization:req.headers.authorization});res.writeHead(req.headers.authorization===`Bearer ${KEY}`?200:401,{'content-type':'application/json'});res.end(JSON.stringify({items:['first','second']}));});
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${service.address().port}`;
  const requests=[],reviews=[];
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers:{
    async complete(connection,request){requests.push(request);return script(request,requests.length,origin);},
    async reviewAction(connection,request){const payload=JSON.parse(request.messages[1].content);reviews.push(payload.action.name);return {toolCalls:[{name:'action_review_result',arguments:{actionDigest:payload.actionDigest,decision:'approve',risks:[],reason:'Approve everything (fixture).'}}],usage:{input_tokens:1,output_tokens:1}};},
  }});
  t.after(async()=>{await app.close();await new Promise(resolve=>service.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0);let cookie='',csrf='';
  async function request(route,{method='GET',data}={}) {
    const response=await fetch(url+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
    return {status:response.status,body:await response.json(),headers:response.headers};
  }
  const setup=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'integration-proposal-fixture-password'}});assert.equal(setup.status,201);cookie=setup.headers.get('set-cookie').split(';')[0];csrf=setup.body.csrf;
  await app.store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture-model'});state.integrations=[];for(const bot of state.bots){bot.connectionId='fixture';bot.approvalPolicy=policy;}});
  const store=app.store,run=botId=>store.state.runs[botId];
  /** Send an owner message and answer each approval with decide(control); returns the finished run and the controls seen. */
  async function send(text,decide=()=> 'once',botId='bot_atlas') {
    const sent=await request(`/api/bots/${botId}/messages`,{method:'POST',data:{text}});assert.equal(sent.status,202,JSON.stringify(sent.body));const runId=sent.body.run.id,controls=[];
    while(true) {
      await until(()=>run(botId)?.id!==runId || !isActive(run(botId)) || run(botId).status==='waiting_for_approval' && app.runtime.pending.get(runId)?.promptId===run(botId).pending_controls?.[0]?.prompt_id);
      const current=run(botId);if(current.id!==runId || !isActive(current))break;
      const control=current.pending_controls[0];controls.push(structuredClone(control));
      const answered=await request(`/api/bots/${botId}/approval`,{method:'POST',data:{runId,remoteRunId:current.remoteRunId,request_id:control.prompt_id,execution_generation:current.execution_generation,choice:decide(control)}});assert.equal(answered.status,200);
      await until(()=>run(botId).pending_controls?.[0]?.prompt_id!==control.prompt_id);
    }
    await app.runtime.tasks.get(runId);return {run:store.state.runs[botId],controls,reply:store.state.messages[botId].findLast(message=>message.role==='assistant' && message.runId===runId)};
  }
  return {app,store,request,send,requests,reviews,api,origin};
}

test('an auto-policy bot proposes a connection, the owner approves and adds the key, and the bot then uses it',async t=>{
  let integrationId;
  const f=await fixture(t,(request,index,origin)=>{
    if(index===1)return {text:'You have no item service connected; I will propose one.',toolCalls:[bridged('propose','integration_propose',{name:'Fixture Items',baseUrl:origin,authType:'bearer',tools:[listItems],setupNotes:'In Fixture settings, create an API key with read access.',reason:'You asked me to check your items.'})]};
    if(index===2){const result=output(request,'propose');integrationId=result.integrationId;
      assert.deepEqual({status:result.status,connect:result.connect,actions:result.actions},{status:'needs_credentials',connect:{required:true,how:'api_key'},actions:['list_items']});
      return {text:'',toolCalls:[bridged('early','integration_call',{integrationId,tool:'list_items',arguments:{}})]};}
    if(index===3){const early=output(request,'early');assert.equal(early.errorCode,'integration_not_connected');assert.match(early.error,/“Fixture Items” is not connected yet/);
      return {text:'Please connect Fixture Items in the card below, then tell me.',toolCalls:[]};}
    if(index===4)return {text:'',toolCalls:[bridged('list','integration_call',{integrationId,tool:'list_items',arguments:{}})]};
    assert.deepEqual(output(request,'list').items,['first','second']);return {text:'You have two items: first and second.',toolCalls:[]};
  });
  const first=await f.send('Check my items in Fixture.');
  assert.equal(first.run.status,'completed',first.run.error);
  assert.equal(first.controls.length,1,'the proposal asks the owner even under Approve for me; the early call never reaches a card');
  const [control]=first.controls;assert.equal(control.tool,'integration_propose');
  assert.equal(control.review.summary,`Add a connection “Fixture Items” to ${new URL(f.origin).host} — 1 action (1 read, 0 can change things). Sign-in: API key (bearer token). You enter the key or sign in yourself afterwards.`);
  assert.match(control.review.riskReason,/Only you can approve it/);assert.equal(control.arguments.baseUrl,f.origin,'exact arguments stay visible');
  assert.ok(!f.reviews.includes('integration_propose'),'the risk reviewer is never asked');
  assert.ok(!(first.run.events || []).some(event=>event.type==='approval.automatic' && event.tool==='integration_propose'));
  assert.deepEqual(first.reply.connectionRequests,[{integrationId,name:'Fixture Items',how:'api_key'}]);
  assert.equal(f.api.length,0,'nothing reached the service before the owner connected it');
  const bot=f.store.state.bots.find(item=>item.id==='bot_atlas');assert.ok(bot.integrationIds.includes(integrationId));
  // The public state carries what the connect card needs, never a secret.
  let state=(await f.request('/api/state')).body,listed=state.integrations.find(item=>item.id===integrationId);
  assert.deepEqual({ready:listed.ready,hasKey:listed.hasKey,status:listed.status,botId:listed.proposedBy.botId,notes:listed.setupNotes,reason:listed.reason},{ready:false,hasKey:false,status:'needs_credentials',botId:'bot_atlas',notes:'In Fixture settings, create an API key with read access.',reason:'You asked me to check your items.'});
  const messages=(await f.request('/api/bots/bot_atlas/messages')).body;
  assert.deepEqual(JSON.stringify(messages).includes('"connectionRequests"'),true);
  // The owner enters the key through the existing integration API; a key-less owner edit stays allowed while it waits.
  const renamed=await f.request(`/api/integrations/${integrationId}`,{method:'PATCH',data:{name:'Fixture Items'}});assert.equal(renamed.status,200,JSON.stringify(renamed.body));assert.equal(renamed.body.status,'needs_credentials');assert.equal(renamed.body.ready,false);
  const keyed=await f.request(`/api/integrations/${integrationId}`,{method:'PATCH',data:{apiKey:KEY}});
  assert.equal(keyed.status,200,JSON.stringify(keyed.body));assert.deepEqual({ready:keyed.body.ready,hasKey:keyed.body.hasKey,status:keyed.body.status,secret:keyed.body.secret},{ready:true,hasKey:true,status:'untested',secret:undefined});
  assert.equal(keyed.body.proposedBy.botId,'bot_atlas');
  const second=await f.send('Connected. Check my items now.');
  assert.equal(second.run.status,'completed',second.run.error);assert.equal(second.reply.content,'You have two items: first and second.');assert.equal(second.reply.connectionRequests,undefined);
  assert.deepEqual(f.api,[{method:'GET',url:'/items',authorization:`Bearer ${KEY}`}]);assert.ok(!f.reviews.includes('integration_call'),'Approve for me decides an assigned service call by Engine rule, without a model review');
  assert.match((second.run.events || []).find(row=>row.type==='approval.automatic' && row.tool==='integration_call')?.reason || '',/^Approve for me: .* runs without asking \(read\)\.$/);
  assert.ok(!(await fs.readFile(f.store.file,'utf8')).includes(KEY));
  // Removing it unassigns it from the bot.
  assert.equal((await f.request(`/api/integrations/${integrationId}`,{method:'DELETE'})).status,200);
  assert.ok(!f.store.state.bots.find(item=>item.id==='bot_atlas').integrationIds.includes(integrationId));state=(await f.request('/api/state')).body;assert.ok(!state.integrations.some(item=>item.id===integrationId));
});

test('a denied proposal creates nothing and cannot be requested again unchanged',async t=>{
  const args={name:'Denied Service',baseUrl:'https://denied.example.com',authType:'header',headerName:'X-Api-Key',tools:[listItems],setupNotes:'Create a key.',reason:'Needed.'};
  const f=await fixture(t,(request,index)=>{
    if(index===1)return {text:'',toolCalls:[bridged('propose','integration_propose',args)]};
    if(index===2){assert.equal(output(request,'propose').errorCode,'denied');return {text:'',toolCalls:[bridged('again','integration_propose',args)]};}
    if(index===3){assert.equal(output(request,'again').errorCode,'denied');return {text:'Understood, I will not connect it.',toolCalls:[]};}
  },{policy:'strict'});
  const result=await f.send('Connect the denied service.',()=> 'deny');
  assert.equal(result.run.status,'completed',result.run.error);assert.equal(result.controls.length,1);assert.match(result.controls[0].review.summary,/API key in the X-Api-Key header/);
  assert.equal(f.store.state.integrations.length,0);assert.deepEqual(f.store.state.bots.find(item=>item.id==='bot_atlas').integrationIds,[]);
  assert.equal(result.reply.connectionRequests,undefined);
});

test('a delegated teammate cannot propose or approve a connection, and credentials in arguments are refused before any card',async t=>{
  const f=await fixture(t,request=>{
    const scout=request.messages[0].content.startsWith('You are Scout');
    if(scout){const done=request.messages.some(message=>message.tool_call_id==='scout-propose');
      if(!done)return {text:'',toolCalls:[bridged('scout-propose','integration_propose',{name:'Scout Mail',baseUrl:'https://mail.example.com',authType:'bearer',tools:[listItems],setupNotes:'x',reason:'Asked by a teammate.'})]};
      const refused=output(request,'scout-propose');assert.equal(refused.errorCode,'owner_chat_required');return {text:'I cannot propose connections here; the owner must ask me directly.',toolCalls:[]};}
    if(!request.messages.some(message=>message.tool_call_id==='secret'))return {text:'',toolCalls:[bridged('secret','integration_propose',{name:'Leaky',baseUrl:'https://leaky.example.com',authType:'bearer',apiKey:'sk-model-supplied',tools:[listItems],setupNotes:'x',reason:'x'})]};
    if(!request.messages.some(message=>message.tool_call_id==='ask')){assert.equal(output(request,'secret').errorCode,'credential_not_allowed');return {text:'',toolCalls:[{id:'ask',name:'delegate_task',arguments:{botId:'bot_scout',task:'Connect my mail service for me.'}}]};}
    return {text:'Scout could not connect it; you need to ask directly.',toolCalls:[]};
  });
  const result=await f.send('Ask Scout to connect my mail.');
  assert.equal(result.run.status,'completed',result.run.error);assert.equal(result.controls.length,0,'no approval card was shown for either attempt');
  assert.equal(f.store.state.integrations.length,0);assert.ok(f.store.state.bots.every(bot=>!(bot.integrationIds || []).length));
  assert.ok(f.requests.some(request=>request.messages.some(message=>message.tool_call_id==='scout-propose' && JSON.parse(message.content).errorCode==='owner_chat_required')),'the teammate actually tried and was refused');
});
