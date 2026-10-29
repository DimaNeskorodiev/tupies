import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { writeWorkspace, getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { executeQualityTool, toolFailure, checkOutcomes } from '../lib/work-quality.mjs';
import { sessionIdFor } from '../lib/sessions.mjs';

const call=(id,name,args={})=>({id,name,arguments:args});
const tools=toolCalls=>({text:'',toolCalls});
async function fixture(t,complete,{vision=false}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-quality-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture-model',imageInput:vision?'on':'off'});for(const bot of state.bots){bot.connectionId='fixture';bot.tools=['workspace','memory','delegation'];bot.approvalPolicy='balanced';}});
  const engine=new NativeEngine(store,{providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length,store);}},runTimeout:10000});
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const run=async(task='Complete the requested result.',options={})=>{const started=await engine.start('bot_atlas',task,options);await engine.tasks.get(started.id);return store.state.runs.bot_atlas;};
  return {engine,store,requests,run};
}

test('outcome checks re-read final files and prevent a false success after a later edit',async t=>{
  const {run,store}=await fixture(t,async(_,index)=>index===1?tools([call('write','workspace_write',{path:'report.txt',content:'approved value'}),call('criteria','task_outcome_set',{checks:[{id:'required',kind:'file_contains',path:'report.txt',value:'approved value'}]})]):index===2?tools([call('check','task_outcome_check'),call('change','workspace_write',{path:'report.txt',content:'wrong value'})]):{text:'Everything is done.',toolCalls:[]});
  const result=await run();assert.equal(result.status,'failed');assert.equal(result.verification.passed,false);assert.match(result.error,/outcome check/);
  assert.ok(result.workRecords.find(r=>r.callId==='check').status==='succeeded');
  assert.equal(store.state.runHistory.bot_atlas[0].verification.passed,false);
});

test('successful original-history and Brain reads satisfy exact source checks while searches and failed reads do not',async t=>{
  const h=await fixture(t,async(_,index)=>index===1?tools([
    call('history','session_read',{messageId:'source_original'}),
    call('note','brain_read',{path:'source-note'}),
    call('criteria','task_outcome_set',{checks:[{id:'history',kind:'source_read',callId:'history'},{id:'note',kind:'source_read',callId:'note'}]})
  ]):{text:'Recovered the original history and note.',toolCalls:[]});
  await h.store.mutate(state=>{state.messages.bot_atlas=[{id:'source_original',role:'user',content:'Original source evidence.',createdAt:'2026-01-01T00:00:00Z'}];});
  await h.engine.tools.execute(h.store.state.bots[0],'brain_write',{path:'source-note',content:'# Source\n\nOriginal note evidence.'});
  const run=await h.run();assert.equal(run.status,'completed');assert.equal(run.verification.passed,true);
  assert.ok(run.workRecords.some(r=>r.callId==='history'&&r.tool==='session_read'&&r.status==='succeeded'));
  assert.ok(run.workRecords.some(r=>r.callId==='note'&&r.tool==='brain_read'&&r.status==='succeeded'));
  const observations=[{callId:'search',tool:'session_search',status:'succeeded'},{callId:'failed',tool:'session_read',status:'failed'},{callId:'ambiguous',tool:'brain_read',status:'succeeded'},{callId:'ambiguous',tool:'brain_read',status:'succeeded'}];
  const checks=['search','failed','ambiguous','invented'].map(id=>({id,kind:'source_read',callId:id}));
  const result=await checkOutcomes({assertRunning(){},current:()=>({outcomeChecks:checks,workRecords:observations})},{});
  assert.equal(result.passed,false);assert.ok(result.checks.every(check=>!check.passed));
});

test('declared checks cannot be removed, weakened, or satisfied by fabricated command identities',async t=>{
  const {run,store}=await fixture(t,async(_,index)=>index===1?tools([call('set','task_outcome_set',{checks:[{id:'test',kind:'command_success',callId:'invented'}]}),call('weaken','task_outcome_set',{checks:[{id:'file',kind:'file_exists',path:'exists.txt'}]})]):{text:'Done.',toolCalls:[]});
  const result=await run();assert.equal(result.status,'failed');assert.equal(result.outcomeChecks[0].id,'test');
  assert.match(store.state.conversations.bot_atlas.find(m=>m.tool_call_id==='weaken').content,/cannot be removed or weakened/);
});

test('safe transient reads retry once; ambiguous mutations never retry',async t=>{
  const {engine,run}=await fixture(t,async(_,i)=>i===1?tools([call('read','workspace_list',{path:'.'}),call('write','workspace_write',{path:'a.txt',content:'x'})]):{text:'Read worked; write outcome is unknown.',toolCalls:[]});
  const execute=engine.tools.execute.bind(engine.tools);let reads=0,writes=0;
  engine.tools.execute=async(bot,name,args,opts)=>{if(name==='workspace_list' && ++reads===1)throw new HttpError(503,'Temporarily unavailable.');if(name==='workspace_write'){writes++;throw new HttpError(502,'Connection lost after dispatch.');}return execute(bot,name,args,opts);};
  const result=await run();assert.equal(reads,2);assert.equal(writes,1);const r=result.workRecords.find(r=>r.callId==='write');assert.equal(r.outcome,'unknown');assert.equal(r.status,'failed');
  assert.equal(toolFailure(new HttpError(409,'Conflict'),{dispatched:true}).outcome,'unknown');
});

test('unchanged invalid calls and denied writes are bounded without replaying approvals',async t=>{
  const {engine,run,store}=await fixture(t,async(_,i)=>i<5?tools([call(`bad-${i}`,'workspace_list',{path:42}),call(`denied-${i}`,'workspace_write',{path:'never.txt',content:'not permitted'})]):{text:'The failures are preserved.',toolCalls:[]});
  await store.mutate(state=>{state.bots[0].approvalPolicy='strict';});let approvals=0;engine.approve=async()=>{approvals++;return false;};
  const result=await run();assert.equal(approvals,1);assert.ok(result.workRecords.some(r=>r.errorCode==='repeated_failure'));
  await assert.rejects(fs.stat(path.join(await getWorkspaceRoot(store,'bot_atlas'),'never.txt')));
});

test('work receipts redact secrets and isolate third-party lanes while exposing readable run IDs',async t=>{
  const {engine,store,run}=await fixture(t,async(_,i)=>i===1?tools([call('read','workspace_read',{path:'read.txt'})]):{text:'Read.',toolCalls:[]});
  await store.mutate(state=>{state.connections[0].secret=store.seal('private-fixture-secret');});await writeWorkspace(store,'bot_atlas','read.txt','private-fixture-secret');
  const result=await run();assert.doesNotMatch(JSON.stringify(result.workRecords),/private-fixture-secret/);
  const tg=sessionIdFor('bot_atlas','telegram:outside');await store.mutate(state=>{state.runHistory.bot_atlas.push({id:'outside',sessionId:tg,lane:'telegram',status:'completed',workRecords:[{callId:'private'}]});});
  const context={bot:store.state.bots[0],runId:result.id,sessionId:'bot_atlas',controller:new AbortController()};
  await assert.rejects(executeQualityTool(engine,context,'work_records_read',{runId:'outside'}),/No work record/);
  const visible=await executeQualityTool(engine,context,'work_records_read',{});assert.ok(visible.recentRuns.some(r=>r.runId===result.id));assert.ok(!visible.recentRuns.some(r=>r.runId==='outside'));
  const stranger={...context,sessionId:tg};await assert.rejects(executeQualityTool(engine,stranger,'work_records_read',{runId:result.id}),/No work record/);
});

test('unattended and teammate requests cannot directly mutate owner core memory',async t=>{
  const {store,run}=await fixture(t,async(_,i)=>i%2===1?tools([call('remember','memory_set',{key:'owner',value:'someone else'})]):{text:'Needs review.',toolCalls:[]});
  const result=await run('Remember an inferred owner.',{source:'routine',lane:'routine:test'});assert.equal(store.state.memory.bot_atlas?.length || 0,0);assert.ok(result.workRecords.some(r=>r.errorCode==='review_required'));
  const next=await run('Remember an inferred owner.',{source:'delegation'});assert.equal(store.state.memory.bot_atlas?.length || 0,0);assert.ok(next.workRecords.some(r=>r.errorCode==='review_required'));
});

test('a required child deliverable without passing checks prevents parent completion',async t=>{
  const {run,store}=await fixture(t,async(request)=>{if(!request.messages[0].content.startsWith(`You are ${store.state.bots[0].name}`))return {text:'I have a draft, without verified output.',toolCalls:[]};return request.messages.at(-1).role==='user'?tools([call('child','delegate_task',{botId:'bot_scout',task:'Produce a checked report.',expectedOutput:'A verified report file.'})]):{text:'Done.',toolCalls:[]};});
  const result=await run();assert.equal(result.status,'failed');assert.equal(result.requiredDeliverables[0].status,'partial');assert.match(result.error,/required teammate deliverable/);
});

test('workspace images use actual bounded image input and stay unavailable for text-only models',async t=>{
  const {run,store,requests}=await fixture(t,async(_,i)=>i===1?tools([call('image','workspace_image',{path:'pixel.png'})]):{text:'Image observed.',toolCalls:[]},{vision:true});
  const root=await getWorkspaceRoot(store,'bot_atlas');await sharp({create:{width:16,height:16,channels:3,background:'#e02020'}}).png().toFile(path.join(root,'pixel.png'));
  assert.equal((await run()).status,'completed');const image=requests[1].messages.find(m=>m.imageParts?.length)?.imageParts[0];assert.ok(image?.data);const data=await sharp(Buffer.from(image.data,'base64')).raw().toBuffer();assert.ok(data[0]>180 && data[1]<70);
  await store.mutate(state=>{state.connections[0].imageInput='off';});await run();assert.ok(!requests[2].tools.some(tool=>tool.name==='workspace_image'));
});
