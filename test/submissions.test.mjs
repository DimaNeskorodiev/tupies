import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { createStudioServer } from '../server.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=4000) {const until=Date.now()+timeout;while(Date.now()<until){const result=predicate();if(result)return result;await delay(5);}throw new Error('Fixture timed out waiting for agent state.');}
const ID='client_message_0001';

async function fixture(t,complete=async()=>({text:'Done.',toolCalls:[]})) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-submissions-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'native-provider',type:'openai',name:'Fixture',model:'test-model',secret:store.seal('fixture-private-key')});for(const bot of state.bots){bot.connectionId='native-provider';bot.tools=['workspace'];}});
  const options={runTimeout:10_000,providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length);}}};
  const engine=new NativeEngine(store,options);await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,requests,options};
}
const userMessages=store=>store.state.messages.bot_atlas?.filter(message=>message.role==='user').length || 0;

test('a repeated client message ID admits one task and returns it; different content under the same ID is refused',async t=>{
  const {engine,store,requests}=await fixture(t);
  const first=await engine.submit('bot_atlas','Plan my week.',{clientMessageId:ID});
  assert.equal(first.duplicate,undefined);
  const again=await engine.submit('bot_atlas','Plan my week.',{clientMessageId:ID});
  assert.equal(again.duplicate,true);assert.equal(again.run.id,first.run.id,'a repeat while the task runs gets the same task, not "already busy"');
  await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  const later=await engine.submit('bot_atlas','Plan my week.',{clientMessageId:ID});
  assert.equal(later.run.id,first.run.id);assert.equal(later.run.status,'completed');
  await assert.rejects(engine.submit('bot_atlas','Plan my month.',{clientMessageId:ID}),/already used for a different message/);
  await assert.rejects(engine.submit('bot_atlas','Plan my week.',{clientMessageId:'short'}),/client message ID/);
  assert.equal(userMessages(store),1);assert.equal(requests.length,1);
  assert.deepEqual(Object.keys(store.state.submissions.bot_atlas[0]).sort(),['createdAt','digest','id','runId']);
});

test('duplicates that arrive together still start one task',async t=>{
  const {engine,store}=await fixture(t);
  const results=await Promise.all([1,2,3].map(()=>engine.submit('bot_atlas','Once only.',{clientMessageId:ID})));
  assert.equal(new Set(results.map(result=>result.run.id)).size,1);
  assert.equal(results.filter(result=>result.duplicate).length,2);
  await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');assert.equal(userMessages(store),1);
});

test('receipts survive a restart, are kept a week and are written with the task they admitted',async t=>{
  const {engine,store,options}=await fixture(t);
  const first=await engine.submit('bot_atlas','Before the restart.',{clientMessageId:ID});await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  const restarted=new NativeEngine(await new Store(store.directory).init(),options);await restarted.recover();
  const again=await restarted.submit('bot_atlas','Before the restart.',{clientMessageId:ID});
  assert.equal(again.duplicate,true);assert.equal(again.run.id,first.run.id);assert.equal(again.run.status,'completed');
  await restarted.close();
  await store.mutate(state=>{state.submissions.bot_atlas.unshift({id:'client_message_old',digest:'x',runId:'run_old',createdAt:new Date(Date.now()-8*86_400_000).toISOString()});});
  await engine.submit('bot_atlas','Another.',{clientMessageId:'client_message_0002'});
  assert.deepEqual(store.state.submissions.bot_atlas.map(item=>item.id),[ID,'client_message_0002']);
  // A refused admission leaves no receipt, so the same message can be sent again later.
  await store.mutate(state=>{state.bots.find(bot=>bot.id==='bot_nova').enabled=false;});
  await assert.rejects(engine.submit('bot_nova','While paused.',{clientMessageId:'client_message_0003'}),/paused/);
  assert.equal(engine.receipt('bot_nova','client_message_0003'),null);
});

test('over HTTP a repeat answers 200 with the original task, and the engine says whether it received a message',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-submissions-http-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,runTimeout:5000,providers:{async complete(){return {text:'Done.',toolCalls:[]};}}});
  const {url}=await app.listen(0);let cookie='',csrf='';
  const request=async(route,{method='GET',data}={})=>{const response=await fetch(`${url}${route}`,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});const text=await response.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:response.status,body,cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const setup=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'fixture-workspace-password'}});cookie=setup.cookie;csrf=setup.body.csrf;
  await app.store.mutate(state=>{state.connections.push({id:'native-provider',type:'openai',name:'Fixture',model:'test-model',secret:app.store.seal('fixture-private-key')});for(const bot of state.bots)bot.connectionId='native-provider';});
  app.runtime.providers={async complete(){return {text:'Done.',toolCalls:[]};}};
  assert.equal((await request(`/api/bots/bot_atlas/submissions/${ID}`)).status,404);
  const first=await request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Hello.',clientMessageId:ID}});
  assert.equal(first.status,202,JSON.stringify(first.body));
  const repeat=await request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Hello.',clientMessageId:ID}});
  assert.equal(repeat.status,200);assert.equal(repeat.body.duplicate,true);assert.equal(repeat.body.run.id,first.body.run.id);
  const receipt=await request(`/api/bots/bot_atlas/submissions/${ID}`);
  assert.equal(receipt.status,200);assert.equal(receipt.body.received,true);assert.equal(receipt.body.runId,first.body.run.id);
  assert.equal((await request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Hello again.',clientMessageId:ID}})).status,409);
  assert.equal((await request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Hi',clientMessageId:'bad id!'}})).status,400);
  await waitFor(()=>app.store.state.runs.bot_atlas?.status==='completed');
  assert.equal((await request('/api/bots/bot_atlas',{method:'DELETE',data:{}})).status,200);
  assert.equal(app.store.state.submissions.bot_atlas,undefined);
});
