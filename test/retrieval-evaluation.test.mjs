import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRetrieval, aggregateRetrieval, runRetrievalEvaluation } from '../eval/retrieval-runner.mjs';

test('retrieval arithmetic uses explicit-label denominators and never inflates duplicate hits',()=>{
  const score=scoreRetrieval({retrieved:['a','b','wrong'],relevant:['a','b','c'],stale:['wrong'],k:4});
  assert.equal(score.precisionAtK.rate,0.5);assert.equal(score.recallAtK.rate,2/3);assert.equal(score.sourceCorrectness.rate,2/3);assert.equal(score.staleCandidates.rate,1/3);
  const duplicate=scoreRetrieval({retrieved:['a','a','wrong'],relevant:['a','b'],k:3});assert.equal(duplicate.hits,1);assert.equal(duplicate.duplicates,1);assert.equal(duplicate.recallAtK.rate,0.5);
});
test('negative and unmeasured retrieval categories remain distinct from perfect scores',()=>{
  const empty=scoreRetrieval({retrieved:[],relevant:[],k:4});assert.equal(empty.precisionAtK.rate,null);assert.equal(empty.recallAtK.rate,null);assert.equal(empty.correctAbstention,true);
  const leaked=scoreRetrieval({retrieved:['private'],relevant:[],excluded:['private'],k:4});assert.equal(leaked.correctAbstention,false);assert.equal(leaked.excludedCandidates.count,1);
  assert.equal(aggregateRetrieval([]).recallAtK.rate,null);assert.equal(aggregateRetrieval([]).staleFactUse,null);assert.throws(()=>scoreRetrieval({k:0}),/1 to 10/);
});
test('actual production retrieval runs on the public corpus without private-lane leakage or invented source IDs',async()=>{
  const report=await runRetrievalEvaluation();assert.equal(report.queryCount,12);assert.equal(report.corpusVersion,'2026-10-28.1');assert.match(report.corpusSha256,/^[a-f0-9]{64}$/);
  assert.equal(report.humanReview.status,'pending');assert.match(report.labels,/agent-authored/);
  assert.equal(report.overall.excludedCandidates.count,0);assert.equal(report.overall.sourceValidity.rate,1);assert.equal(report.overall.staleFactUse,null);
  assert.ok(report.rows.some(row=>row.queryId==='short-followup' && row.previous));assert.equal(report.factComparator.rows.length,11);assert.match(report.factComparator.name,/not a historical/);
  for(const result of [report.overall,...Object.values(report.bySource),report.factComparator.metrics])for(const name of ['precisionAtK','recallAtK','sourceCorrectness'])assert.ok(result[name].rate===null || result[name].rate>=0 && result[name].rate<=1);
  assert.ok(!JSON.stringify(report).includes('tupies-retrieval-'));assert.ok(report.sourceIdentities.every(item=>/^[a-f0-9]{64}$/.test(item.sha256)));
});
