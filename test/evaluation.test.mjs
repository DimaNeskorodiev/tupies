import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { EvaluationBudget, EvaluationBudgetError, evaluationOptions, grade, check, createHarness, runEvaluation, qualityMetrics, repeatStatistics, CASES } from '../eval/runner.mjs';

test('evaluation admission stops before the next inference or token dispatch',()=>{
  const options=evaluationOptions({maxInferences:1,maxTokens:10000,maxOutputTokens:256}),budget=new EvaluationBudget(options),request={messages:[{role:'user',content:'Fixture'}],tools:[]};
  const first=budget.reserve(request,0);budget.settle(first,{input_tokens:20,output_tokens:5});
  assert.equal(budget.calls,1);assert.throws(()=>budget.reserve(request,1),EvaluationBudgetError);assert.equal(budget.calls,1);
  const noRoom=new EvaluationBudget({...options,maxTokens:10});assert.throws(()=>noRoom.reserve(request,0),/token budget/);assert.equal(noRoom.calls,0);
});

test('unknown metrics stay unknown and pricing has a pre-dispatch ceiling',()=>{
  const request={messages:[{role:'user',content:'Fixture'}],tools:[]},config=evaluationOptions({mode:'live',provider:'custom',model:'fixture',inputPrice:1000,outputPrice:1000,maxCost:0.001}),budget=new EvaluationBudget(config);
  assert.throws(()=>budget.reserve(request,0),/cost budget/);assert.equal(budget.calls,0);
  const unknown=new EvaluationBudget(evaluationOptions());unknown.settle(unknown.reserve(request,0),{});assert.equal(unknown.metrics().reportedInputTokens,null);assert.equal(unknown.metrics().reportedCacheTokens,null);assert.equal(unknown.metrics().reportedCostUsd,null);
  const failed=new EvaluationBudget(evaluationOptions({mode:'live',provider:'custom',model:'fixture',inputPrice:1,outputPrice:1}));failed.reserve(request,0);assert.equal(failed.metrics().reportedInputTokens,null);assert.equal(failed.metrics().reportedCostUsd,null);assert.equal(failed.metrics().usageReportingCoverage.complete,false);
  const partialCache=new EvaluationBudget(evaluationOptions());partialCache.settle(partialCache.reserve(request,0),{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:2}});partialCache.settle(partialCache.reserve(request,1),{input_tokens:10,output_tokens:5});assert.equal(partialCache.metrics().reportedCacheTokens,null,'partial cache reporting is not a complete total');
});

test('outcome grade follows independent checks and reports capability gaps separately',()=>{
  assert.equal(grade([check('real file',false)]),'failed');assert.equal(grade([check('real file',true)]),'passed');assert.equal(grade([check('text paging',true)],{capabilityGap:true}),'capability_gap');assert.equal(grade([check('real file',true)],{budgetReached:true}),'budget_exhausted');assert.equal(grade([]),'failed');
  assert.equal(grade([check('text paging',false)],{capabilityGap:true}),'failed','a missing image capability cannot hide a failed supported check');
  assert.throws(()=>evaluationOptions({mode:'live',provider:'openai',model:'fixture'}),/prices/);assert.throws(()=>evaluationOptions({cases:['nonexistent']}),/known case/);
});

test('evaluation executes real disposable engine workflows with mechanical output oracles',async()=>{
  const report=await runEvaluation({cases:['research-document','coding-verification','memory-correction','ask-deny','lifecycle'],maxMs:12000});
  assert.equal(report.results.length,5);assert.ok(report.results.every(item=>item.status==='passed'),JSON.stringify(report.results,null,2));assert.equal(report.mode,'fixture');assert.match(report.qualityClaim,/not model quality/);
  assert.ok(report.sourceIdentities.every(item=>/^[a-f0-9]{64}$/.test(item.sha256)));assert.equal(report.summary.p95CaseMs,null);
  assert.ok(!JSON.stringify(report).includes('vault.key'));assert.equal(CASES.length,8);
  const code=report.results.find(item=>item.id==='coding-verification');assert.notEqual(code.baselineTestExitCode,0);assert.equal(code.verificationTestExitCode,0);assert.equal(code.controlResponses.fixtureCommandApprovals,1);assert.match(code.fixtureOracleSha256,/^[a-f0-9]{64}$/);
  assert.equal(report.quality.falseSuccess.count,0);assert.ok(report.quality.falseSuccess.denominator>0);assert.equal(report.quality.humanInterventions.count,null);assert.ok(report.results.every(item=>item.usage?.usageSource==='scripted-fixture'));
});

test('finite quality metrics expose denominators, failures and unknown measurements',()=>{
  const rows=[{id:'a',taskOutcome:{expected:'completed',actual:'completed'},elapsedMs:10,status:'failed',checks:[check('required file',false,'','goal'),check('exact ID',true,'','retention'),check('citation',false,'','source'),check('privacy',false,'','privacy')]},{id:'a',taskOutcome:{expected:'failed',actual:'failed'},elapsedMs:30,status:'passed',checks:[check('one dispatch',true,'','duplicate')]}];
  const result=qualityMetrics(rows);assert.deepEqual(result.falseSuccess,{count:1,denominator:1,rate:1});assert.deepEqual(result.exactConstraintRetention,{count:1,denominator:1,rate:1});assert.equal(result.sourceCorrectness.rate,0);assert.equal(result.unauthorizedChanges.count,1);assert.equal(result.duplicateEffects.count,0);assert.equal(result.humanInterventions.count,null);
  assert.deepEqual(qualityMetrics([]).sourceCorrectness,{count:0,denominator:0,rate:null});
  const stats=repeatStatistics(rows)[0];assert.deepEqual(stats.elapsedMs,[10,30]);assert.equal(stats.medianMs,20);assert.equal(stats.populationStdDevMs,10);
});

test('changed static oracle is denied even when command arguments match exactly',async()=>{
  const options=evaluationOptions(),definition={script:async(_request,h)=>h.phase++===0?{text:'',toolCalls:[{id:'tampered-oracle',name:'shell_run',arguments:h.oracleCommand}]}:{text:'No command was executed.',toolCalls:[]}},h=await createHarness(definition,options,new EvaluationBudget(options));
  try {
    await h.installOracle('guard',"import test from 'node:test'; test('static',()=>{});\n");await fs.appendFile(h.oracleCommand.args[1],'// changed after registration\n');
    let dispatched=0;const execute=h.engine.tools.execute.bind(h.engine.tools);h.engine.tools.execute=async(...args)=>{if(args[1]==='shell_run')dispatched++;return execute(...args);};
    const run=await h.run('Try only the registered fixture command.');assert.equal(dispatched,0);assert.equal(h.controlResponses.fixtureCommandApprovals,0);assert.equal(h.controlResponses.denials,1);assert.ok(run.workRecords.some(item=>item.errorCode==='denied'));
    await assert.rejects(h.runOracle(),/oracle changed/);
  }finally{await h.close();}
});

test('all eight upgraded families cover mandatory constraints, conflicts, stale edits and required child failure',async()=>{
  const report=await runEvaluation({repeat:1,maxMs:12000});assert.equal(report.results.length,8);assert.ok(report.results.every(item=>item.status==='passed'),JSON.stringify(report.results,null,2));
  const long=report.results.find(item=>item.id==='long-context');assert.equal(long.checks.filter(item=>item.metric==='retention' && item.passed).length,3);
  const child=report.results.find(item=>item.id==='teammate-partial');assert.deepEqual(child.taskOutcome,{expected:'failed',actual:'failed'});assert.ok(child.checks.find(item=>item.name==='actual specialist check failed').passed);
  const large=report.results.find(item=>item.id==='large-result-image');assert.equal(large.capabilityCoverage.staleRevision,'injected');assert.ok(large.checks.find(item=>item.name==='concurrent writer preserved').passed);
  const refusal=report.results.find(item=>item.id==='ask-deny');assert.deepEqual(refusal.controlResponses,{answers:1,skips:0,denials:1,fixtureCommandApprovals:0},'Each accepted owner response is counted once, even while its waiting status is clearing.');
  assert.equal(report.quality.falseSuccess.count,0);assert.equal(report.quality.exactConstraintRetention.rate,1);assert.equal(report.quality.sourceCorrectness.rate,1);assert.equal(report.quality.unauthorizedChanges.count,0);assert.equal(report.quality.duplicateEffects.count,0);
});

test('specialist-failure evaluation reads retained partial output without treating it as successful completion',async()=>{
  const definition=CASES.find(item=>item.id==='teammate-partial'),criterion={id:'required_review',kind:'file_exists',path:'review.complete'};
  const child={status:'failed',delegation:{rootRunId:'fixture-parent'},outcomeChecks:[criterion],verification:{passed:false,checks:[{...criterion,passed:false}]}};
  const run={status:'failed',requiredDeliverables:[{status:'failed'}],partialOutput:'The specialist review failed and is incomplete. I cannot claim it passed.'};
  const harness={run:async()=>run,store:{state:{runs:{bot_nova:child}}},check};
  const result=await definition.execute(harness);
  assert.equal(result.checks.find(item=>item.name==='parent preserves limitation').passed,true);
  assert.equal(result.checks.find(item=>item.name==='required failure blocks parent success').passed,true);
  assert.deepEqual(result.metadata.taskOutcome,{expected:'failed',actual:'failed'});
  const falseClaim=await definition.execute({...harness,run:async()=>({...run,partialOutput:'The review passed.'})});
  assert.equal(falseClaim.checks.find(item=>item.name==='parent preserves limitation').passed,false,'a partial field cannot hide a false success claim');
});

test('one case deadline also aborts compaction requests outside engine.run',async()=>{
  const options=evaluationOptions({maxMs:1000}),definition={script:async(request)=>new Promise((resolve,reject)=>{request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});})},harness=await createHarness(definition,options,new EvaluationBudget(options));
  try {
    await harness.store.mutate(state=>{state.conversations.bot_atlas=[{role:'user',content:'Exact fixture constraint.'},{role:'assistant',content:'Noted.'}];});
    const operation=harness.engine.compactSession({botId:'bot_atlas',sessionId:'bot_atlas',connection:harness.connection,model:'scripted-fixture',effective:16000,keepFrom:-1,topic:true,fallback:true,signal:harness.signal});
    await assert.rejects(harness.withinDeadline(operation),/time budget/);await operation.catch(()=>{});assert.equal(harness.signal.aborted,true);
  } finally {await harness.close();}
});

test('a reached suite budget never counts partial fixture work as passed or dispatches the next case',async()=>{
  const report=await runEvaluation({cases:['research-document','memory-correction'],maxInferences:1});assert.equal(report.results.length,1);assert.equal(report.results[0].status,'budget_exhausted');assert.equal(report.summary.passed,0);assert.equal(report.usage.inferences,1);
});
