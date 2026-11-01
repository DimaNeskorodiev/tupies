import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAssimilationEvaluation, scoreRetainedKnowledge } from '../eval/assimilation/runner.mjs';
import { EXPECTED_UNITS, EXTRACTION_RECIPES, APPLICATION_TASKS } from '../eval/assimilation/corpus.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
function cli(args){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['scripts/eval-assimilation.mjs',...args],{cwd:ROOT,env:{NODE_ENV:'test'},stdio:['ignore','pipe','pipe']}),out=[],err=[];child.stdout.on('data',part=>out.push(part));child.stderr.on('data',part=>err.push(part));child.on('error',reject);child.on('close',code=>resolve({code,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()}));});}

test('assimilation retention scoring detects missing exceptions, lost ordering and promoted outcomes separately',()=>{
  const units=EXTRACTION_RECIPES.filter(recipe=>recipe.relevant).map(recipe=>({unit:structuredClone(recipe.candidate)})),score=scoreRetainedKnowledge(units);
  assert.equal(score.relevantUnits.count,EXPECTED_UNITS.length);assert.equal(score.completeUnits.rate,1);assert.equal(score.exceptions.rate,1);
  units.find(row=>row.unit.title==='Luma crawl allowance').unit.exceptions=[];
  units.find(row=>row.unit.title==='Luma crawl procedure').unit.method.steps.reverse();
  units.find(row=>row.unit.title==='Luma reported Pebble association').unit.outcome='observed';
  const damaged=scoreRetainedKnowledge(units);
  assert.equal(damaged.relevantUnits.rate,1);assert.ok(damaged.completeUnits.rate<1);assert.ok(damaged.criticalUnits.rate<1);assert.ok(damaged.exceptions.rate<1);
  for(const key of ['crawl-allowance','crawl-procedure','reported-association'])assert.equal(damaged.rows.find(row=>row.key===key).detailsPreserved,false);
  const absent=scoreRetainedKnowledge([]);assert.equal(absent.relevantUnits.rate,0);assert.equal(absent.exceptions.rate,0);assert.equal(absent.criticalUnits.rate,0);
});

test('the actual native study fixture preserves knowledge after source cleanup and reports lexical misses honestly',async()=>{
  const report=await runAssimilationEvaluation();
  assert.equal(report.mode,'deterministic-fixture');assert.equal(report.humanReview.status,'pending');
  assert.equal(report.pipeline.status,'completed');assert.equal(report.pipeline.committedCount,EXPECTED_UNITS.length);
  assert.equal(report.reading.sourceCount,13);assert.equal(report.reading.segmentAccounting.rate,1);
  assert.equal(report.reading.originalsRemoved,true);assert.equal(report.reading.readableSegmentsAfterCleanup,0);
  assert.equal(report.reading.inputAccountingIsSemanticCoverage,false);
  assert.equal(report.retained.relevantUnits.rate,1);assert.equal(report.retained.criticalUnits.rate,1);assert.equal(report.retained.exceptions.rate,1);
  assert.equal(report.retained.sourceEvidenceIdentity.rate,1);assert.equal(report.retained.semanticSupportIndependentlyJudged,false);assert.deepEqual(report.retained.unexpectedUnits,[]);
  assert.equal(report.retrieval.explicitAliasRecall.rate,1);
  assert.equal(report.retrieval.unmappedCrossLanguageRecall.rate,0);
  const missing=report.retrieval.questions.find(row=>row.kind==='unmapped-cross-language');
  assert.equal(missing.scriptedAnswerMaterial.passed,false);assert.ok(missing.knownLimitation);
  assert.ok(report.retrieval.positiveRecallAtK.rate<1);
  assert.ok(report.retrieval.questions.every(row=>row.beforeReturned.length===0));
  assert.equal(report.retrieval.questions.find(row=>row.kind==='unanswerable').scriptedAnswerMaterial.passed,true);
  assert.equal(report.application.tasks.length,APPLICATION_TASKS.length);assert.equal(report.application.scriptedContractChecks.rate,1);
  assert.equal(report.application.humanEvaluationPerformed,false);assert.ok(report.application.tasks.every(task=>task.humanRubricScores===null&&task.realTaskOutcome===null));
  assert.equal(report.duplicateReimport.noOp,true);assert.equal(report.duplicateReimport.committedActions,0);assert.equal(report.duplicateReimport.duplicates,EXPECTED_UNITS.length);
  assert.equal(report.execution.externalModelCalls,0);assert.equal(report.execution.networkRequests,0);assert.equal(report.execution.operationalDataUsed,false);
  assert.ok(report.sourceIdentities.every(row=>/^[a-f0-9]{64}$/.test(row.sha256)));
});

test('the fixture CLI exports a usable report while refusing live/runtime execution options',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-assimilation-cli-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const output=path.join(directory,'report.json'),result=await cli(['--output',output]);
  assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/semantic\/model usefulness remains unmeasured/);
  const report=JSON.parse(await fs.readFile(output,'utf8'));assert.equal(report.schemaVersion,1);assert.equal(report.execution.externalModelCalls,0);
  const denied=await cli(['--data-dir',directory]);assert.equal(denied.code,1);assert.match(denied.stderr,/runtime-data options are not supported/);
  const invalid=await cli(['--k','0']);assert.equal(invalid.code,1);assert.match(invalid.stderr,/k from 1 to 10/);
});
