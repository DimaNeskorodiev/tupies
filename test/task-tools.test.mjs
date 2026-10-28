import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { executeEngineTool, retainToolResult } from '../lib/task-tools.mjs';
import { writeWorkspace, readWorkspace } from '../lib/agent-tools.mjs';

const call=(id,name,args)=>({id,name,arguments:args});
async function fixture(t,complete) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-task-tools-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture-model'});for(const bot of state.bots){bot.connectionId='fixture';bot.tools=['workspace'];bot.approvalPolicy='balanced';}});
  const requests=[],engine=new NativeEngine(store,{providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length);}},runTimeout:10000});
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const run=async()=>{const result=await engine.start('bot_atlas','Find the source, fix it and verify your work.');await engine.tasks.get(result.id);return store.state.runs.bot_atlas;};
  return {store,engine,requests,run,directory};
}
const step=(id,status='pending')=>({id,title:`Do ${id}`,status});

test('real engine discovers, reads, edits and verifies files while keeping a durable plan',async t=>{
  const {store,engine,requests,run,directory}=await fixture(t,async(request,index)=>{
    assert.ok(request.tools.some(tool=>tool.name==='task_plan_set'));
    const outputs=request.messages.filter(message=>message.role==='tool').map(message=>({id:message.tool_call_id,value:JSON.parse(message.content)}));
    if(index===1)return {text:'I will locate, edit and verify the source.',toolCalls:[call('plan','task_plan_set',{steps:[step('locate','in_progress'),step('edit'),step('verify')]}),call('find','workspace_glob',{pattern:'**/*.js'}),call('search','workspace_search',{query:'old value',glob:'**/*.js'})]};
    if(index===2){assert.deepEqual(outputs.find(item=>item.id==='find').value.files,['src/main.js']);return {text:'',toolCalls:[call('read','workspace_read',{path:'src/main.js'})]};}
    if(index===3){const read=outputs.find(item=>item.id==='read').value;return {text:'',toolCalls:[call('edit','workspace_edit',{path:'src/main.js',oldText:'old value',newText:'new value',expectedSha256:read.sha256}),call('plan2','task_plan_set',{expectedVersion:1,steps:[step('locate','completed'),step('edit','completed'),step('verify','in_progress')]}),call('verify','workspace_read',{path:'src/main.js'})]};}
    if(index===4){assert.equal(outputs.find(item=>item.id==='verify').value.content,"export const value = 'new value';\n");return {text:'',toolCalls:[call('plan3','task_plan_set',{expectedVersion:2,steps:[step('locate','completed'),step('edit','completed'),step('verify','completed')]})]};}
    // The current plan reaches the model in the per-step turn context, not in the cached system prompt.
    assert.match(request.turnContext,/"version":3/);assert.doesNotMatch(request.messages[0].content,/"version":3/);return {text:'Updated the source and verified its contents.',toolCalls:[]};
  });
  await writeWorkspace(store,'bot_atlas','src/main.js',"export const value = 'old value';\n");
  const result=await run();assert.equal(result.status,'completed');assert.equal(result.plan.version,3);assert.ok(result.plan.steps.every(item=>item.status==='completed'));
  assert.equal(requests.length,5);assert.ok(result.events.some(event=>event.type==='plan.updated'));
  assert.match((await readWorkspace(store,'bot_atlas','src/main.js')).content,/new value/);
  const reloaded=await new Store(directory).init();assert.deepEqual(reloaded.state.runs.bot_atlas.plan,result.plan);
  assert.equal(engine.capabilities().features.task_plans,true);
});

test('invalid and stale plan updates are recoverable and cannot change standing permissions or run status',async t=>{
  const {store,run}=await fixture(t,async(request,index)=>index===1?{text:'',toolCalls:[
    call('plan','task_plan_set',{steps:[step('real','in_progress')]}),
    call('stale','task_plan_set',{expectedVersion:0,steps:[step('fake','completed')]}),
    call('bad-active','task_plan_set',{steps:[step('a','in_progress'),step('b','in_progress')]}),
    call('bad-permission','task_plan_set',{steps:[step('x')],tools:['terminal']}),
    call('get','task_plan_get',{}),
  ]}:{text:'The unfinished step remains in the plan.',toolCalls:[]});
  const before=structuredClone(store.state.bots[0]),result=await run();
  assert.equal(result.status,'failed');assert.match(result.error,/unfinished plan steps/);assert.equal(result.output,'The unfinished step remains in the plan.');
  assert.equal(result.plan.version,1);assert.equal(result.plan.steps[0].id,'real');assert.deepEqual(store.state.bots[0],before);
  const errors=store.state.conversations.bot_atlas.filter(message=>message.is_error);assert.equal(errors.length,3);
  assert.match(errors[0].content,/plan changed/);assert.match(errors[1].content,/one plan step/);assert.match(errors[2].content,/unknown arguments/);
});

test('task plans survive cancellation and restart without replaying work',async t=>{
  let entered;const waiting=new Promise(resolve=>{entered=resolve;});
  const {store,engine,directory}=await fixture(t,async(request,index)=>{
    if(index===1)return {text:'',toolCalls:[call('plan','task_plan_set',{steps:[step('edit','in_progress'),step('verify')]})]};
    entered();await new Promise((resolve,reject)=>{request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});});
  });
  const run=await engine.start('bot_atlas','Work until stopped.');await waiting;
  await engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});await engine.tasks.get(run.id);
  assert.equal(store.state.runs.bot_atlas.status,'cancelled');const plan=store.state.runs.bot_atlas.plan;
  const restartedStore=await new Store(directory).init(),restarted=new NativeEngine(restartedStore,{});await restarted.recover();
  assert.deepEqual(restartedStore.state.runs.bot_atlas.plan,plan);assert.equal(restartedStore.state.runs.bot_atlas.status,'cancelled');await restarted.close();
});

test('large tool outputs remain redacted, paged, isolated to the active run, and expire',async t=>{
  let resultId,context;
  const {store,engine,run}=await fixture(t,async(request,index)=>{
    if(index===1)return {text:'',toolCalls:[call('large','workspace_list',{path:'.'})]};
    if(index===2){const result=JSON.parse(request.messages.at(-1).content);assert.equal(result.shortened,true);resultId=result.resultId;assert.equal(result.nextOffset,0);assert.doesNotMatch(JSON.stringify(result),/private-fixture-token/);return {text:'',toolCalls:[call('page','tool_result_read',{resultId,offset:16000,limit:12000})]};}
    const page=JSON.parse(request.messages.at(-1).content);assert.equal(page.offset,16000);assert.ok(page.content.length);assert.ok(page.nextOffset>16000);assert.doesNotMatch(page.content,/private-fixture-token/);return {text:'Read a page of the retained result.',toolCalls:[]};
  });
  await store.mutate(state=>{state.connections[0].secret=store.seal('private-fixture-token');});
  const original=engine.executeTool.bind(engine);engine.executeTool=async(ctx,toolCall)=>{context=ctx;return toolCall.id==='large'?{data:('private-fixture-token '+ 'x'.repeat(100)).repeat(1000)}:original(ctx,toolCall);};
  assert.equal((await run()).status,'completed');assert.equal(context.toolResults.size,0);
  assert.doesNotMatch(await fs.readFile(store.file,'utf8'),/private-fixture-token/);
  assert.equal(store.state.runs.bot_atlas.toolResults,undefined);assert.ok(JSON.stringify(store.state.runs.bot_atlas).length<15000);
});

test('retained output has explicit caps, bounded escaped pages and no cross-run access',async()=>{
  const context={},serialized='\u0001'.repeat(300000),summary=JSON.parse(retainToolResult(context,{id:'large'},serialized));
  assert.equal(summary.retainedChars,250000);assert.equal(summary.truncated,true);
  const engine={assertRunning(){}};
  const page=await executeEngineTool(engine,context,'tool_result_read',{resultId:summary.resultId,limit:12000});
  assert.ok(JSON.stringify(page).length<=16000);assert.equal(page.nextOffset,page.content.length);assert.equal(page.truncated,true);
  for(let index=0;index<4;index++)retainToolResult(context,{id:`large${index}`},'x'.repeat(250000));
  assert.equal(context.toolResults.size,4);assert.equal(context.toolResults.has(summary.resultId),false);
  await assert.rejects(executeEngineTool(engine,{},'tool_result_read',{resultId:summary.resultId}),/unavailable or expired/);
  await assert.rejects(executeEngineTool(engine,context,'tool_result_read',{resultId:[...context.toolResults.keys()][0],offset:-1}),/nonnegative offset/);
});
