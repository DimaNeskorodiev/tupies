import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { workReceipt, callFingerprint } from '../lib/work-quality.mjs';

const call={id:'fixture-study-call',name:'study_material',arguments:{sources:[{workspacePath:'fixture.txt'}]}};

test('only a completed native study produces a successful work receipt',()=>{
  for(const status of ['partial','failed','cancelled','blocked','interrupted','running',undefined]) {
    const receipt=workReceipt(call,{status,retained:status==='partial'?2:0});
    assert.equal(receipt.status,'failed',String(status));assert.equal(receipt.resultDigest,undefined);assert.equal(receipt.errorCode,'study_incomplete');
    assert.equal(receipt.outcome,status==='partial'?'partial':'unknown');
  }
  const completed=workReceipt(call,{status:'completed',retained:2});assert.equal(completed.status,'succeeded');assert.match(completed.resultDigest,/^[a-f0-9]{64}$/);
  const failed=workReceipt(call,{status:'failed',error:'A real study error.',errorCode:'stale_state'});assert.equal(failed.error,'A real study error.');assert.equal(failed.errorCode,'stale_state');
});

test('incomplete native study results never enter the Engine completed-effects cache',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-study-receipts-')),store=await new Store(directory).init(),engine=new NativeEngine(store),botId=store.state.bots[0].id;
  t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  for(const [index,status] of ['partial','failed','cancelled','completed'].entries()) {
    const runId=`receipt_run_${index}`;
    await store.mutate(state=>{state.runs[botId]={id:runId,status:'running',workRecords:[],events:[]};});
    const context={bot:structuredClone(store.state.bots[0]),runId,sessionId:botId,source:'chat',lane:'chat',controller:new AbortController(),policy:{mode:'bounded'},failedCalls:new Map(),toolResults:new Map(),completedEffects:new Map(),resumedEffects:new Map()};
    engine.studies.runInTask=async()=>({id:`study_fixture_${index}`,status,retained:2});
    await engine.executeToolBatch(context,[call]);
    const receipt=store.state.runs[botId].workRecords.at(-1);
    assert.equal(receipt.status,status==='completed'?'succeeded':'failed');
    assert.equal(context.completedEffects.has(callFingerprint(call)),status==='completed');
  }
});
