import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeEngine,isActive} from '../lib/engine.mjs';
import {desktopToolDefinitions,executeDesktopTool} from '../lib/desktop-tools.mjs';
import {desktopFixture} from './desktop-fixture.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const deadline=Date.now()+10000;while(Date.now()<deadline){if(predicate())return;await pause(5);}throw new Error('Desktop engine fixture did not settle.');}
const next=(id,name,args)=>({text:'',toolCalls:[{id,name,arguments:args}]});
const reply=request=>JSON.parse(request.messages.findLast(m=>m.role==='tool').content);
async function fixture(t,complete,options={}) {
  const f=await desktopFixture(t,options);await f.store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture'});Object.assign(state.bots[0],{connectionId:'fixture',tools:['desktop'],approvalPolicy:options.policy || 'strict'});});
  const engine=new NativeEngine(f.store,{maxTurns:12,runTimeout:15000,providers:{complete:(_c,request)=>complete(request),...(options.reviewAction?{reviewAction:(_c,request)=>options.reviewAction(request)}:{})}});engine.desktop=f.desktop;await engine.recover();t.after(()=>engine.close());
  const bot=f.store.state.bots[0],run=()=>f.store.state.runs[bot.id];
  async function start(){return engine.start(bot.id,'Send Hello fixture to the selected local app.');}
  async function settle(started,choose=()=>true){
    const approvals=[];while(isActive(run())){const current=run(),prompt=current.pending_controls?.[0];if(current.status==='waiting_for_approval'&&prompt&&engine.pending.get(current.id)?.promptId===prompt.prompt_id){approvals.push(prompt);await engine.control(bot.id,'approval',{runId:started.id,remoteRunId:started.remoteRunId,request_id:prompt.prompt_id,execution_generation:current.execution_generation,choice:choose(prompt)?'once':'deny'});}await pause(5);}
    await engine.tasks.get(started.id);return {run:run(),approvals};
  }
  return {...f,engine,bot,run,start,settle};
}

test('real Engine desktop tools create one message with exact review and independent UI verification',async t=>{
  let f,step=0;f=await fixture(t,async request=>{step++;const result=step===1?null:reply(request);
    if(step===1)return next('observe','desktop_observe',{appId:f.appId,windowId:'w-1'});
    if(step===2)return next('type','desktop_action',f.typeArgs(result));
    if(step===3)return next('verify-type','desktop_verify',{actionId:result.actionId});
    if(step===4)return next('send','desktop_action',{observationId:result.observationId,ref:result.tree.children[1].ref_id,action:'click',expect:{kind:'appears',role:'text',text:'Delivered: Hello fixture'}});
    if(step===5)return next('verify-send','desktop_verify',{actionId:result.actionId});
    assert.equal(result.passed,true);return {text:'The fixture message is present in the conversation.',toolCalls:[]};
  });
  const result=await f.settle(await f.start());assert.equal(result.run.status,'completed');assert.equal(result.approvals.length,2);assert.equal(f.calls.filter(c=>c.args[0]==='click').length,1);assert.equal(f.engine.desktop.hasPending(result.run.id),false);assert.equal(result.approvals[0].tool,'desktop_action');assert.equal(result.approvals[0].arguments.review.application,'Fixture');
});
test('Engine refuses completion while delivered input has no verified result',async t=>{
  let f,step=0;f=await fixture(t,async request=>{step++;if(step===1)return next('observe','desktop_observe',{appId:f.appId,windowId:'w-1'});if(step===2)return next('type','desktop_action',f.typeArgs(reply(request)));return {text:'Claimed completion without checking.',toolCalls:[]};});
  const result=await f.settle(await f.start());assert.equal(result.run.status,'failed');assert.match(result.run.error,/verified|progress|turn/i);assert.equal(f.calls.filter(c=>c.args[0]==='set-value').length,1);assert.equal(f.engine.desktop.hasPending(result.run.id),true);
});
test('revoking current desktop access while approval is pending prevents dispatch',async t=>{
  let f,step=0;f=await fixture(t,async request=>{step++;if(step===1)return next('observe','desktop_observe',{appId:f.appId,windowId:'w-1'});if(step===2)return next('type','desktop_action',f.typeArgs(reply(request)));assert.equal(reply(request).errorCode,'denied');return {text:'Desktop access was removed; input was not sent.',toolCalls:[]};});
  const started=await f.start();await until(()=>f.run()?.status==='waiting_for_approval');await f.store.mutate(state=>state.bots[0].tools=[]);const result=await f.settle(started);assert.equal(result.run.status,'completed');assert.equal(f.calls.filter(c=>c.args[0]==='set-value').length,0);
});
test('Stop on a pending desktop approval never dispatches the action',async t=>{
  let f,step=0;f=await fixture(t,async request=>++step===1?next('observe','desktop_observe',{appId:f.appId,windowId:'w-1'}):next('type','desktop_action',f.typeArgs(reply(request))));const started=await f.start();await until(()=>f.run()?.status==='waiting_for_approval');await f.engine.control(f.bot.id,'stop',{runId:started.id,remoteRunId:started.remoteRunId});await f.engine.tasks.get(started.id);assert.equal(f.run().status,'cancelled');assert.equal(f.calls.filter(c=>c.args[0]==='set-value').length,0);
});
test('desktop tools require opt-in, local Mac, direct owner context and both permission snapshots',async t=>{
  const f=await fixture(t,async()=>({text:'Unused',toolCalls:[]})),context={bot:structuredClone(f.bot),source:'chat',lane:'chat',runId:'fixture',controller:new AbortController(),inference:{images:false}};
  await f.desktop.admit(context.runId,context.bot.id);
  assert.equal(desktopToolDefinitions(f.engine,context).length,5);
  for(const changed of [{source:'delegation'},{source:'routine'},{roomId:'room'},{delegation:{depth:1}},{lane:'room:one'},{bot:{...context.bot,tools:[]}}])assert.equal(desktopToolDefinitions(f.engine,{...context,...changed}).length,0);
  f.engine.store.state.runs[f.bot.id]={id:'fixture',missionId:'mission',status:'running'};assert.equal(desktopToolDefinitions(f.engine,context).length,0);
  delete f.engine.store.state.runs[f.bot.id];await f.store.mutate(state=>state.bots[0].tools=[]);await assert.rejects(executeDesktopTool(f.engine,context,{name:'desktop_status',arguments:{}}));
});
test('Engine freezes application scope before inference and refuses later app grants in that run',async t=>{
  let f,step=0,newApp;f=await fixture(t,async request=>{step++;
    if(step===1){await f.desktop.configure({enabled:true,executable:f.desktop.config.identity[0].path,apps:[{name:'Fixture',botIds:[f.bot.id]},{name:'Later grant',botIds:[f.bot.id]}]});newApp=f.desktop.config.apps.find(a=>a.name==='Later grant');return next('status','desktop_status',{});}
    if(step===2){assert.deepEqual(reply(request).apps.map(a=>a.name),['Fixture']);return next('forged-new-app','desktop_observe',{appId:newApp.id,windowId:'w-1'});}
    assert.equal(reply(request).errorCode,'denied');return {text:'The later grant did not expand this task.',toolCalls:[]};
  });
  const started=await f.engine.start(f.bot.id,'Verify that later application grants do not expand this task.'),result=await f.settle(started);assert.equal(result.run.status,'completed');assert.equal(f.calls.filter(c=>c.args[0]==='snapshot').length,0);
});
test('changing invalid desktop arguments cannot evade the Engine no-progress stop',async t=>{
  let f,step=0,view;f=await fixture(t,async request=>{step++;if(step===1)return next('observe','desktop_observe',{appId:f.appId,windowId:'w-1'});if(step===2)view=reply(request);return next('bad_'+step,'desktop_action',{...f.typeArgs(view),ref:`@s${step}:e999`});});
  const result=await f.settle(await f.engine.start(f.bot.id,'Inspect the fixture and stop if no desktop progress is possible.'));assert.equal(result.run.status,'failed');assert.equal(result.run.errorCode,'desktop_no_progress');assert.match(result.run.error,/six failures/);assert.equal(f.calls.filter(c=>c.args[0]==='set-value').length,0);
});

test('Approve for me reviews actual Mac targets and verifies input and Send without manual prompts',async t=>{
  let f,step=0;const reviews=[];
  f=await fixture(t,async request=>{
    step++;const result=step===1?null:reply(request);
    if(step===1)return next('observe','desktop_observe',{appId:f.appId,windowId:'w-1'});
    if(step===2)return next('type','desktop_action',f.typeArgs(result));
    if(step===3)return next('verify-type','desktop_verify',{actionId:result.actionId});
    if(step===4)return next('send','desktop_action',{observationId:result.observationId,ref:result.tree.children[1].ref_id,action:'click',expect:{kind:'appears',role:'text',text:'Delivered: Hello fixture'}});
    if(step===5)return next('verify-send','desktop_verify',{actionId:result.actionId});
    assert.equal(result.passed,true);return {text:'The requested message is verified.',toolCalls:[]};
  },{policy:'auto',reviewAction:request=>{const payload=JSON.parse(request.messages[1].content);reviews.push(payload);return {toolCalls:[{name:'action_review_result',arguments:{actionDigest:payload.actionDigest,decision:'approve',risks:[],reason:'Send the exact message requested by the owner in the assigned fixture app.'}}]};}});
  const result=await f.settle(await f.start());assert.equal(result.run.status,'completed');assert.equal(result.approvals.length,0);assert.equal(reviews.length,2);
  assert.equal(reviews[0].action.review.target.name,'Message');assert.equal(reviews[1].action.review.target.name,'Send');assert.equal(f.state.sent,true);assert.equal(f.engine.desktop.hasPending(result.run.id),false);
});
