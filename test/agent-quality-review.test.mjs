import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, HttpError } from '../lib/store.mjs';
import { workReceipt, recordWork, repeatedFailure, toolFailure, checkOutcomes, executeQualityTool, SAFE_RETRY_READS } from '../lib/work-quality.mjs';
import { sessionIdFor } from '../lib/sessions.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { writeWorkspace } from '../lib/agent-tools.mjs';

const call=(id,name,args={})=>({id,name,arguments:args});
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-quality-review-')),store=await new Store(directory).init();
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const context={bot:store.state.bots[0],runId:'review_run',sessionId:'bot_atlas',controller:new AbortController()};
  await store.mutate(state=>{state.runs.bot_atlas={id:context.runId,botId:'bot_atlas',source:'chat',status:'running',workRecords:[]};});
  const engine={store,assertRunning(){},current(ctx){const r=store.state.runs[ctx.bot.id];return r?.id===ctx.runId?r:null;}};
  return {engine,store,context};
}

test('running background commands with null exit codes remain pending and ordinary polling is not a failure loop',async t=>{
  const {engine,context}=await fixture(t),read=call('poll','shell_read',{processId:'process_1'});
  assert.equal(workReceipt(call('launch','shell_start'),{status:'starting',exitCode:null}).status,'pending');
  for(let i=0;i<4;i++)await recordWork(engine,context,read,{status:'running',exitCode:null,processId:'process_1'});
  assert.equal(repeatedFailure(context,read),null);assert.equal(engine.current(context).workRecords.at(-1).outcome,'pending');
  assert.equal(workReceipt(read,{status:'stopped',exitCode:0}).status,'failed','stopping a process never proves successful completion');
});

test('denied and unknown mutations are blocked immediately and remain sticky after blocked receipts or unrelated writes',async t=>{
  const {engine,context}=await fixture(t),write=call('uncertain','workspace_write',{path:'result.txt',content:'x'}),denied=call('denied','integration_call',{integrationId:'fixture',tool:'publish',arguments:{}});
  await recordWork(engine,context,write,toolFailure(new HttpError(502,'Response lost.'),{dispatched:true}));
  assert.ok(repeatedFailure(context,write));await recordWork(engine,context,write,repeatedFailure(context,write));
  await recordWork(engine,context,denied,toolFailure(new HttpError(403,'Refused.'),{denied:true}));
  await recordWork(engine,context,call('other','workspace_write',{path:'unrelated.txt',content:'ok'}),{path:'unrelated.txt'});
  assert.match(repeatedFailure(context,write).recovery,/unknown/);assert.ok(repeatedFailure(context,denied));
  assert.equal(SAFE_RETRY_READS.has('web_search'),false,'an approved external search adapter is not an automatically retryable action');
});

test('a relevant successful file mutation refreshes failed safe reads, without clearing unrelated reads or invalid inputs',async t=>{
  const {engine,context}=await fixture(t),missing=call('read','workspace_read',{path:'missing.txt'}),other=call('read-other','workspace_read',{path:'other.txt'}),invalid=call('invalid','workspace_read',{path:42});
  for(let i=0;i<2;i++)for(const c of [missing,other,invalid])await recordWork(engine,context,c,toolFailure(new HttpError(c===invalid?400:404,'Read failed.'),{read:true}));
  assert.ok(repeatedFailure(context,missing));
  await recordWork(engine,context,call('create','workspace_write',{path:'missing.txt',content:'ready'}),{path:'missing.txt'});
  assert.equal(repeatedFailure(context,missing),null);assert.ok(repeatedFailure(context,other));assert.ok(repeatedFailure(context,invalid));
});

test('known failed verification commands can run again after edits while unknown command outcomes stay blocked',async t=>{
  const {engine,context}=await fixture(t),testCommand=call('verify','shell_run',{executable:'fixture-test',args:[],cwd:'src'}),unknown=call('uncertain','shell_run',{executable:'fixture-unknown',args:[],cwd:'src'});
  for(let i=0;i<2;i++)await recordWork(engine,context,testCommand,{exitCode:1,stdout:'failure'});
  assert.equal(engine.current(context).workRecords.at(-1).outcome,'observed');assert.ok(repeatedFailure(context,testCommand));
  await recordWork(engine,context,unknown,{exitCode:null,timedOut:true});
  await recordWork(engine,context,call('edit','workspace_edit',{path:'src/program.mjs',edits:[]}),{path:'src/program.mjs'});
  assert.equal(repeatedFailure(context,testCommand),null);assert.ok(repeatedFailure(context,unknown));
  await recordWork(engine,context,testCommand,{exitCode:0,stdout:'pass'});assert.equal(engine.current(context).workRecords.at(-1).status,'succeeded');
});

test('outcome checks fail closed when a model reuses a tool-call identity for different command observations',async t=>{
  const {engine,store,context}=await fixture(t);
  await store.mutate(state=>Object.assign(state.runs.bot_atlas,{outcomeChecks:[{id:'tests',kind:'command_success',callId:'same'}],workRecords:[{callId:'same',tool:'shell_run',status:'succeeded',exitCode:0},{callId:'same',tool:'shell_run',status:'failed',exitCode:1}]}));
  const ambiguous=await checkOutcomes(engine,context);assert.equal(ambiguous.passed,false);assert.match(ambiguous.checks[0].detail,/ambiguous/);
  await store.mutate(state=>{state.runs.bot_atlas.workRecords[1].callId='new-failure';});
  assert.equal((await checkOutcomes(engine,context)).passed,true);
});

test('legacy unknown Telegram receipts are hidden while trusted owner-DM current records and exact private lanes work',async t=>{
  const {engine,store,context}=await fixture(t),tgA=sessionIdFor('bot_atlas','telegram:a'),tgB=sessionIdFor('bot_atlas','telegram:b');
  await store.mutate(state=>{state.runs.bot_atlas.source='telegram';(state.runHistory ||= {}).bot_atlas=[{id:'legacy',source:'telegram',status:'completed',workRecords:[{callId:'private'}]},{id:'owner-dm',source:'telegram',lane:'chat',status:'completed',workRecords:[]},{id:'tg-a',source:'telegram',lane:'telegram',sessionId:tgA,status:'completed',workRecords:[{callId:'only-a'}]}];});
  const current=await executeQualityTool(engine,context,'work_records_read',{});assert.equal(current.runId,context.runId);assert.ok(!current.recentRuns.some(item=>item.runId==='legacy' || item.runId==='tg-a'));
  await assert.rejects(executeQualityTool(engine,context,'work_records_read',{runId:'legacy'}),/No work record/);
  assert.equal((await executeQualityTool(engine,context,'work_records_read',{runId:'owner-dm'})).runId,'owner-dm');
  assert.equal((await executeQualityTool(engine,{...context,sessionId:tgA},'work_records_read',{runId:'tg-a'})).records[0].callId,'only-a');
  await assert.rejects(executeQualityTool(engine,{...context,sessionId:tgB},'work_records_read',{runId:'tg-a'}),/No work record/);
});

test('an ambiguous external mutation is never redispatched or reapproved through autonomous repeated calls',async t=>{
  const {store}=await fixture(t);let step=0,approvals=0,dispatches=0;
  await store.mutate(state=>{state.runs.bot_atlas.status='completed';state.connections.push({id:'fixture',type:'openai',model:'fixture'});state.bots[0].connectionId='fixture';state.bots[0].tools=['workspace','integrations'];});
  const engine=new NativeEngine(store,{providers:{async complete(){step++;return step<=4?{text:'',toolCalls:[step===3?call('unrelated','workspace_write',{path:'unrelated.txt',content:'checked'}):call(`remote-${step}`,'integration_call',{integrationId:'fixture',tool:'publish',arguments:{text:'once'}})]}:{text:'The publish outcome is unknown.',toolCalls:[]};}}});
  t.after(()=>engine.close());engine.approve=async()=>{approvals++;return true;};
  const execute=engine.tools.execute.bind(engine.tools);engine.tools.execute=async(bot,name,args,options)=>{if(name==='integration_call'){dispatches++;throw new HttpError(502,'Response lost after dispatch.');}return execute(bot,name,args,options);};
  const run=await engine.start('bot_atlas','Publish once.');await engine.tasks.get(run.id);
  assert.equal(dispatches,1);assert.equal(approvals,1);assert.equal(store.state.runs.bot_atlas.workRecords.filter(r=>r.errorCode==='repeated_failure').length,2);
});

test('outcome checks cannot reveal private file existence or contents when Workspace is disabled',async t=>{
  const {store,engine,context}=await fixture(t);context.bot={...context.bot,tools:['memory']};
  await writeWorkspace(store,context.bot.id,'private.txt','private-value');
  await assert.rejects(executeQualityTool(engine,context,'task_outcome_set',{checks:[{id:'oracle',kind:'file_contains',path:'private.txt',value:'private-value'}]}),error=>error.status===403);
  await store.mutate(state=>{state.runs.bot_atlas.outcomeChecks=[{id:'oracle',kind:'file_contains',path:'private.txt',value:'private-value'}];});
  const checks=await checkOutcomes(engine,context);assert.equal(checks.passed,false);assert.match(checks.checks[0].detail,/require the Workspace tools/);assert.ok(!JSON.stringify(checks).includes('private-value'));
});
