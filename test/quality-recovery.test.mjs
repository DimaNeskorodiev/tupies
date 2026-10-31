import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { reconcileWork, SAFE_RETRY_READS } from '../lib/work-quality.mjs';

const start=(toolCallId,tool,args={})=>({type:'tool.started',toolCallId,tool,arguments:args});

test('interrupted delegation status reads do not become unknown mutations or automatic retries',()=>{
  const job={id:'delegation_fixture',status:'running',childRunId:'child_fixture'};
  const run={events:[start('status','delegation_status',{delegationId:job.id,waitMs:1000}),start('dispatch','delegate_task',{botId:'bot_scout',task:'Synthetic work.',wait:false})],delegationJobs:[structuredClone(job)]};
  reconcileWork(run);
  assert.deepEqual(run.workRecords.map(record=>[record.callId,record.status,record.outcome]),[['status','interrupted','not_applied'],['dispatch','interrupted','unknown']]);
  assert.equal(SAFE_RETRY_READS.has('delegation_status'),false);assert.deepEqual(run.delegationJobs,[job]);
});

test('browser input and navigation interrupted after dispatch retain an unknown outcome',()=>{
  const actions=['browser_open','browser_click','browser_fill','browser_type','browser_select','browser_check','browser_key','browser_back','browser_scroll','browser_drag','browser_dialog'];
  const run={events:[...actions.map((name,index)=>start(`action-${index}`,name)),start('read','browser_snapshot')]};
  reconcileWork(run);
  assert.ok(run.workRecords.slice(0,-1).every(record=>record.outcome==='unknown'));
  assert.equal(run.workRecords.at(-1).outcome,'not_applied');
});

test('interruption receipts preserve successes and artifacts while distinguishing reads, dispatch and exact pending approval',()=>{
  const success={callId:'saved',tool:'documents_create',status:'succeeded',path:'report.txt',sha256:'a'.repeat(64)},artifact={path:'report.txt',size:12};
  const run={events:[start('saved','documents_create',{path:'report.txt'}),start('read','workspace_read',{path:'source.txt'}),start('remote','integration_call',{tool:'publish'}),start('approval','shell_run',{executable:'echo',args:['fixture']})],workRecords:[success],artifacts:[artifact],pending_controls:[{kind:'approval',prompt_id:'approval_exact',tool:'shell_run',arguments:{args:['fixture'],executable:'echo'}}],approval:{request_id:'approval_exact'}};
  const before=structuredClone({success,artifact}),coverage=reconcileWork(run,'Stopped before a result was retained.');
  assert.equal(coverage.added,3);assert.equal(coverage.unresolved,0);assert.equal(coverage.coverage,'retained_tool_starts');
  assert.deepEqual(run.workRecords[0],before.success);assert.deepEqual(run.artifacts[0],before.artifact);
  assert.deepEqual(run.workRecords.slice(1).map(item=>[item.callId,item.status,item.outcome]),[['read','interrupted','not_applied'],['remote','interrupted','unknown'],['approval','interrupted','not_started']]);
  assert.ok(run.workRecords.slice(1).every(item=>item.errorCode==='interrupted' && !Object.hasOwn(item,'arguments')));
  reconcileWork(run);assert.equal(run.workRecords.length,4,'a repeated recovery never invents another receipt');
});

test('per-ID occurrence counts keep duplicate call IDs ambiguous and only the newest exact approval is unstarted',()=>{
  const run={events:[start('same','workspace_write',{path:'a.txt',content:'x'}),start('same','workspace_write',{path:'a.txt',content:'x'}),start('same','workspace_write',{path:'a.txt',content:'x'})],workRecords:[{callId:'same',tool:'workspace_write',status:'succeeded'}],pending_controls:[{kind:'approval',prompt_id:'pending',tool:'workspace_write',arguments:{path:'a.txt',content:'x'}}],approval:{request_id:'pending'}};
  reconcileWork(run);assert.equal(run.workRecords.filter(item=>item.callId==='same').length,3);
  assert.deepEqual(run.workRecords.slice(1).map(item=>item.outcome),['unknown','not_started']);
  const mismatched={events:[start('mismatch','shell_run',{executable:'echo',args:[]})],pending_controls:[{kind:'approval',prompt_id:'old',tool:'shell_run',arguments:{executable:'echo',args:[]}}],approval:{request_id:'new'}};
  reconcileWork(mismatched);assert.equal(mismatched.workRecords[0].outcome,'unknown','a stale approval identity does not establish nondispatch');
});

test('reconciliation bounds added receipts and settles pending commands without deleting retained observations',()=>{
  const existing=Array.from({length:60},(_,index)=>({callId:`old-${index}`,tool:'workspace_read',status:'succeeded'}));
  const run={workRecords:structuredClone(existing),events:[start('missing','integration_call')]};
  assert.equal(reconcileWork(run).unresolved,1);assert.deepEqual(run.workRecords,existing);
  const command={workRecords:[{callId:'command',tool:'shell_start',status:'pending',processId:'owned_process',outcome:'pending'}],events:[start('command','shell_start')]};
  assert.equal(reconcileWork(command).interruptedPending,1);assert.equal(command.workRecords.length,1);assert.equal(command.workRecords[0].status,'interrupted');assert.equal(command.workRecords[0].outcome,'unknown');assert.equal(command.workRecords[0].processId,'owned_process');
});

test('engine restart archives interrupted missing receipts without replaying provider or tools',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-quality-recover-')),store=await new Store(directory).init();let providerCalls=0;
  const engine=new NativeEngine(store,{providers:{async complete(){providerCalls++;throw new Error('Recovery must not request inference.');}}});
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  await store.mutate(state=>{state.runs.bot_atlas={id:'interrupted_fixture',botId:'bot_atlas',status:'waiting_for_approval',createdAt:'2026-10-01T00:00:00Z',events:[start('write','workspace_write',{path:'not-created.txt',content:'x'}),start('read','workspace_read',{path:'missing.txt'}),start('pending','shell_run',{executable:'echo',args:[]})],workRecords:[{callId:'prior',tool:'shell_start',status:'pending',processId:'old_handle'}],pending_controls:[{kind:'approval',prompt_id:'pending_exact',tool:'shell_run',arguments:{executable:'echo',args:[]}}],approval:{request_id:'pending_exact'}};});
  await engine.recover();const run=store.state.runs.bot_atlas;
  assert.equal(providerCalls,0);assert.equal(run.status,'interrupted');assert.equal(run.pending_controls,undefined);assert.equal(run.approval,undefined);
  assert.deepEqual(run.workRecords.map(item=>[item.callId,item.status,item.outcome]),[['prior','interrupted','unknown'],['write','interrupted','unknown'],['read','interrupted','not_applied'],['pending','interrupted','not_started']]);
  assert.deepEqual(store.state.runHistory.bot_atlas[0].workRecords,run.workRecords);assert.equal(store.state.runHistory.bot_atlas[0].workReconciliation.added,3);
  await assert.rejects(fs.stat(path.join(directory,'workspaces','bot_atlas','not-created.txt')));
});
