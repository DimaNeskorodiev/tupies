import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {runEvaluation,createHarness,evaluationOptions,EvaluationBudget,CASES} from '../eval/runner.mjs';
import {collectSyntheticCaseOutput,syntheticFailureCategory} from '../eval/case-output.mjs';

test('synthetic output callback is opt-in, retains final display answer and verified report bytes before cleanup, and keeps outputs out of the report',async()=>{
  const outputs=[],report=await runEvaluation({cases:['research-document']},{onCaseComplete:output=>outputs.push(output)});
  assert.equal(report.summary.passed,1);assert.equal(outputs.length,1);const output=outputs[0];assert.equal(output.caseId,'research-document');assert.match(output.fixtureSha256,/^[a-f0-9]{64}$/);assert.equal(output.answers.length,1);assert.match(output.answers[0].text,/Created the report/);assert.equal(output.artifacts.length,1);assert.equal(output.artifacts[0].path,'report.md');assert.match(output.artifacts[0].bytes.toString(),/Total: 200/);assert.deepEqual(report.results[0].outputRetention,{captured:true,answers:1,artifacts:1,truncated:false,omittedArtifacts:0});
  assert.ok(!JSON.stringify(report).includes('Created the report from'));assert.ok(!JSON.stringify(report).includes('# Inventory'));
  const disabled=await runEvaluation({cases:['research-document']});assert.equal(disabled.configuration.syntheticOutputCallback,false);assert.equal(disabled.results[0].outputRetention,undefined);
});

test('retention redacts known secrets and excludes provider/tool/state data, unowned history, symlinks and outside paths',async()=>{
  const options=evaluationOptions(),definition=CASES.find(item=>item.id==='research-document'),h=await createHarness(definition,options,new EvaluationBudget(options)),secret='synthetic-retention-secret';
  try {
    h.retentionRunIds.add('run_fixture');await h.write('report.md',`# Synthetic report\n${secret}\n`);const outside=path.join(h.directory,'outside.txt');await fs.writeFile(outside,'OUTSIDE-CANARY');
    await h.store.mutate(state=>{state.connections.push({id:'secret_fixture',type:'custom',secret:h.store.seal(secret)});state.messages.bot_atlas=[{role:'user',runId:'run_fixture',content:'PROMPT-CANARY'},{role:'assistant',runId:'run_fixture',content:`Final ${secret}.`,providerItems:[{secret:'PROVIDER-CANARY'}]},{role:'tool',runId:'run_fixture',content:'TOOL-CANARY'},{role:'assistant',runId:'old_run',content:'OLD-HISTORY-CANARY'}];state.runs.bot_atlas={id:'run_fixture',botId:'bot_atlas',status:'completed',artifacts:[{path:'report.md'},{path:'../outside.txt'},{path:outside}],private:'STATE-CANARY'};});
    const context={definition,repetition:1,status:'passed',fixtureSha256:'a'.repeat(64)},output=await collectSyntheticCaseOutput(h,context),serialized=JSON.stringify(output);assert.equal(output.answers[0].text,'Final [redacted].');assert.equal(output.artifacts[0].bytes.toString(),'# Synthetic report\n[redacted]\n');assert.equal(output.omittedArtifacts,2);
    for(const value of [secret,'OUTSIDE-CANARY','PROMPT-CANARY','PROVIDER-CANARY','TOOL-CANARY','OLD-HISTORY-CANARY','STATE-CANARY','oauthSecret','vault.key'])assert.ok(!serialized.includes(value),value);
    await h.store.mutate(state=>{Object.assign(state.runs.bot_atlas,{status:'failed',steps:2,error:`PRIVATE-ERROR-CANARY ${secret}`,workRecords:[{tool:'PROVIDER-CANARY'}],verification:{passed:false,checks:[{id:secret,kind:'source_read',passed:false}]}});});const diagnostics=(await collectSyntheticCaseOutput(h,context)).diagnostics;assert.deepEqual(diagnostics,[{botId:'bot_atlas',runId:'run_fixture',status:'failed',steps:2,toolCalls:1,failedChecks:[{id:'[redacted]',kind:'source_read'}],failureCategory:'declared_check_failed'}]);assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE-ERROR-CANARY'));assert.ok(!JSON.stringify(diagnostics).includes('PROVIDER-CANARY'));
    await h.store.mutate(state=>{state.runs.bot_atlas.artifacts=[];});const unrecorded=await collectSyntheticCaseOutput(h,context);assert.equal(unrecorded.artifacts.length,1);assert.equal(unrecorded.artifacts[0].recordedArtifact,false,'An independently verified expected fixture output remains inspectable when the product omitted its artifact card.');
    await h.store.mutate(state=>{state.runs.bot_atlas.artifacts=[{path:'report.md'},{path:'../outside.txt'},{path:outside}];});
    await fs.rm(path.join(await h.workspace(),'report.md'));await fs.symlink(outside,path.join(await h.workspace(),'report.md'));const linked=await collectSyntheticCaseOutput(h,context);assert.equal(linked.artifacts.length,0);assert.equal(linked.omittedArtifacts,3);
    await assert.rejects(collectSyntheticCaseOutput(h,{...context,definition:{id:'research-document'}}),/versioned disposable/);
  } finally {await h.close();}
});

test('synthetic failure diagnostics return static categories and never echo raw error details',()=>{
  for(const [error,category] of [['OpenAI HTTP 429 PRIVATE-ACCOUNT','provider_rate_limit'],['The provider stream ended before a completed response PRIVATE-BODY','provider_incomplete_response'],['The provider could not be reached PRIVATE-HOST','provider_unavailable'],['PRIVATE-UNCLASSIFIED','unknown']])assert.equal(syntheticFailureCategory({status:'failed',error}),category);
});

test('retained provider failure diagnostics keep only known codes and numeric statuses, never error custom properties',async()=>{
  const options=evaluationOptions(),definition=CASES.find(item=>item.id==='research-document'),h=await createHarness(definition,options,new EvaluationBudget(options)),canary='PRIVATE-PROVIDER-METADATA-CANARY';
  try {
    h.retentionRunIds.add('run_fixture');await h.store.mutate(state=>{state.runs.bot_atlas={id:'run_fixture',botId:'bot_atlas',status:'failed',error:canary,failure:{origin:'provider',code:'http_400',status:502,upstreamStatus:400,error:canary,body:canary,account:canary,headers:{Authorization:canary}}};});
    const context={definition,repetition:1,status:'failed',fixtureSha256:'a'.repeat(64)},output=await collectSyntheticCaseOutput(h,context);assert.deepEqual(output.diagnostics[0].failure,{origin:'provider',code:'http_400',status:502,upstreamStatus:400});assert.equal(output.diagnostics[0].failureCategory,'provider_http_400');assert.ok(!JSON.stringify(output).includes(canary));
    await h.store.mutate(state=>{state.runs.bot_atlas.failure.code=canary;});const rejected=await collectSyntheticCaseOutput(h,context);assert.equal(rejected.diagnostics[0].failure,undefined);assert.equal(rejected.diagnostics[0].failureCategory,'unknown');assert.ok(!JSON.stringify(rejected).includes(canary));
  } finally {await h.close();}
});

test('retention failure is reported without leaking callback errors or leaving disposable data behind',async()=>{
  const report=await runEvaluation({cases:['research-document']},{onCaseComplete(){throw new Error('PRIVATE-CALLBACK-DETAIL');}});assert.equal(report.results[0].status,'passed');assert.equal(report.results[0].outputRetention.captured,false);assert.ok(!JSON.stringify(report).includes('PRIVATE-CALLBACK-DETAIL'));
});
