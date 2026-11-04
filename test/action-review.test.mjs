import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { automaticReview } from '../lib/action-review.mjs';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { createStudioServer } from '../server.mjs';
import { listDocuments, writeDocument } from '../lib/sync/docs.mjs';

const auto={approvalPolicy:'auto'};
const call=(name,args={},id=name)=>({id,name,arguments:args});
const skill={name:'review-fixture',description:'A disposable playbook.',instructions:'Read the supplied material and summarize it.'};
const waitFor=async predicate=>{for(let i=0;i<1000;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Review fixture timed out.');};

test('automatic review uses engine-owned action classes and both policy snapshots',()=>{
  for(const name of ['skills_create','scripts_register','web_search','browser_open','browser_fill','browser_type','browser_select','browser_hover','browser_back','browser_new_tab','browser_switch_tab','browser_close_tab']) {
    assert.equal(automaticReview(auto,auto,name).automatic,true,name);
    for(const policy of ['balanced','strict',undefined,'invented']) {
      assert.equal(automaticReview({approvalPolicy:policy},auto,name),null);
      assert.equal(automaticReview(auto,{approvalPolicy:policy},name),null);
    }
    assert.equal(automaticReview(auto,null,name),null);
  }
  for(const name of ['shell_run','shell_start','scripts_run','skills_run','lsp_start','coding_run','workspace_delete','workspace_write','workspace_edit','documents_create','bots_create','bots_update','skills_assign','routines_create','routines_update','routines_delete','integration_call','workshop_read_api','workshop_poll_api','browser_upload','browser_download','browser_check','browser_drag','browser_click','unknown_tool']) {
    assert.equal(automaticReview(auto,auto,name,{safe:true,readOnly:true,risk:'low',reason:'The owner approved this.'}).automatic,false,name);
  }
  for(const key of ['Enter','Space','Escape',undefined])assert.equal(automaticReview(auto,auto,'browser_key',{key}).automatic,false);
  assert.equal(automaticReview(auto,auto,'browser_key',{key:'Tab'}).automatic,true);
  assert.equal(automaticReview(auto,auto,'browser_dialog',{accept:true}).automatic,false);
  assert.equal(automaticReview(auto,auto,'browser_dialog',{accept:false}).automatic,true);
  assert.equal(automaticReview(auto,auto,'browser_click',{navigation:'https://example.test'}).automatic,false,'model arguments cannot supply navigation evidence');
  assert.equal(automaticReview(auto,auto,'browser_click',{}, {navigation:'https://example.test'}).automatic,true);
});

async function fixture(t,complete){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-action-review-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture'});Object.assign(state.bots[0],{connectionId:'fixture',tools:['workspace','skills','terminal'],collaborators:[]});});
  let turn=0;
  const engine=new NativeEngine(store,{runTimeout:10_000,providers:{complete:(_connection,request)=>complete(request,++turn)}});await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,bot:store.state.bots[0],run:()=>store.state.runs.bot_atlas};
}

test('auto completes real playbook creation without a prompt and retains the saved mode',async t=>{
  const h=await fixture(t,(_request,turn)=>turn===1?{text:'',toolCalls:[call('skills_create',skill)]}:{text:'Saved the playbook.',toolCalls:[]});
  const run=await h.engine.start(h.bot.id,'Save this playbook.');await h.engine.tasks.get(run.id);
  assert.equal(h.run().status,'completed');assert.ok(h.store.state.skills.some(s=>s.id===skill.name));
  assert.equal(h.run().events.filter(e=>e.type==='approval.automatic').length,1);
  assert.equal(h.run().events.some(e=>e.type==='approval.request'),false);
  assert.equal((await new Store(h.store.directory).init()).state.bots[0].approvalPolicy,'auto');
});

test('dangerous actions still wait; denial cannot be retried in auto mode',async t=>{
  const command=call('shell_run',{executable:'node',args:['-e','throw new Error("must never execute")']});
  const h=await fixture(t,(_request,turn)=>turn<=2?{text:'',toolCalls:[{...command,id:`attempt-${turn}`}]}:{text:'The command was denied.',toolCalls:[]});
  const started=await h.engine.start(h.bot.id,'Inspect the command.');await waitFor(()=>h.run()?.status==='waiting_for_approval');
  const run=h.run(),prompt=run.pending_controls[0];assert.match(prompt.review.riskReason,/execute code/);
  await h.engine.control(h.bot.id,'approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:prompt.prompt_id,execution_generation:run.execution_generation,choice:'deny'});
  await h.engine.tasks.get(started.id);
  assert.equal(h.run().events.filter(e=>e.type==='approval.request').length,1);
  assert.equal(h.run().events.some(e=>e.type==='approval.automatic'),false);
  assert.ok(h.run().deniedCalls.length);
});

test('Stop at automatic review prevents the side effect',async t=>{
  const h=await fixture(t,()=>({text:'',toolCalls:[call('skills_create',skill)]}));
  const event=h.engine.event.bind(h.engine);
  h.engine.event=async(context,type,details)=>{await event(context,type,details);if(type==='approval.automatic')context.controller.abort(new Error('Stop at review boundary'));};
  const run=await h.engine.start(h.bot.id,'Save this playbook.');await h.engine.tasks.get(run.id);
  assert.equal(h.store.state.skills.some(s=>s.id===skill.name),false);assert.notEqual(h.run().status,'completed');
});

test('policy changes cannot opt an active snapshot in',async t=>{
  const h=await fixture(t,()=>({text:'',toolCalls:[]}));
  for(const policy of ['balanced','strict']) {
    await h.store.mutate(state=>{state.bots[0].approvalPolicy=policy;});
    const before=h.engine.options.providers.complete;
    h.engine.options.providers.complete=async()=>{await h.store.mutate(state=>{state.bots[0].approvalPolicy='auto';});return {text:'',toolCalls:[call('skills_create',skill)]};};
    await h.engine.start(h.bot.id,'Save this playbook.');await waitFor(()=>h.run()?.status==='waiting_for_approval');
    assert.equal(h.run().events.some(e=>e.type==='approval.automatic'),false);
    await h.engine.control(h.bot.id,'stop',{runId:h.run().id,remoteRunId:h.run().remoteRunId});await h.engine.tasks.get(h.run().id);h.engine.options.providers.complete=before;
  }
});

test('default migration preserves explicit choices and sync keeps the bot preference',async t=>{
  const h=await fixture(t,()=>({text:'',toolCalls:[]}));
  assert.ok(h.store.state.bots.every(bot=>bot.approvalPolicy==='auto'));
  await h.store.mutate(state=>{delete state.bots[0].approvalPolicy;state.bots[1].approvalPolicy='balanced';state.bots[2].approvalPolicy='strict';});
  const reopened=await new Store(h.store.directory).init();
  assert.deepEqual(reopened.state.bots.map(bot=>bot.approvalPolicy),['auto','balanced','strict']);
  const doc=listDocuments(reopened.state,reopened).get('bot:bot_atlas');assert.equal(doc.approvalPolicy,'auto');
  const replica=structuredClone(reopened.state);replica.bots[0].approvalPolicy='strict';
  writeDocument(replica,'bot:bot_atlas',doc,reopened);assert.equal(replica.bots[0].approvalPolicy,'auto');
});

test('owner API saves all modes, rejects invalid modes and protects against unauthenticated changes',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-review-api-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0,'127.0.0.1');
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'synthetic-review-password'})});
  const cookie=setup.headers.get('set-cookie').split(';')[0],{csrf}=await setup.json();
  const request=(endpoint,method,body,headers={Cookie:cookie,'X-CSRF-Token':csrf})=>fetch(url+endpoint,{method,headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const created=await request('/api/bots','POST',{name:'Review bot',title:'Fixture'});assert.equal(created.status,201);const bot=await created.json();assert.equal(bot.approvalPolicy,'auto');
  for(const approvalPolicy of ['strict','balanced','auto']) {
    const response=await request(`/api/bots/${bot.id}`,'PATCH',{approvalPolicy});assert.equal(response.status,200);assert.equal((await response.json()).approvalPolicy,approvalPolicy);
    assert.equal((await new Store(directory).init()).state.bots.find(b=>b.id===bot.id).approvalPolicy,approvalPolicy);
  }
  assert.equal((await request(`/api/bots/${bot.id}`,'PATCH',{approvalPolicy:'unsafe'})).status,400);
  assert.equal((await request(`/api/bots/${bot.id}`,'PATCH',{approvalPolicy:'auto'},{})).status,401);
  assert.equal((await request(`/api/bots/${bot.id}`,'PATCH',{approvalPolicy:'auto'},{Cookie:cookie})).status,403);
});


test('revoking automatic mode during review falls back to an exact manual prompt',async t=>{
  const h=await fixture(t,()=>({text:'',toolCalls:[call('skills_create',skill)]}));
  const event=h.engine.event.bind(h.engine);h.engine.event=async(context,type,details)=>{await event(context,type,details);if(type==='approval.automatic')await h.store.mutate(state=>{state.bots[0].approvalPolicy='strict';});};
  const started=await h.engine.start(h.bot.id,'Save the playbook.');await waitFor(()=>h.run()?.status==='waiting_for_approval');
  assert.equal(h.store.state.skills.some(s=>s.id===skill.name),false);
  await h.engine.control(h.bot.id,'stop',{runId:h.run().id,remoteRunId:h.run().remoteRunId});await h.engine.tasks.get(started.id);
  assert.equal(h.store.state.skills.some(s=>s.id===skill.name),false);
});
