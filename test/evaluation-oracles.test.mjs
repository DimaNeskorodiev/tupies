import test from 'node:test';
import assert from 'node:assert/strict';
import {currentInventoryValues,currentCityAnswered,importedConflictAcknowledged,requiredReviewCheckFailed,exactBudgetRecovered,exactDeadlineRecovered,failedExportAcknowledged,specialistLimitationAcknowledged,staleRevisionAcknowledged,redColorAnswered,refusalAcknowledged} from '../eval/oracles.mjs';
import {CASES,createHarness,evaluationOptions,EvaluationBudget,grade} from '../eval/runner.mjs';

test('inventory facts accept Sum, tables, bold labels and ordinary equations while rejecting wrong or unlabeled numbers',()=>{
  for(const text of ['| Alpha | 120 |\n| Beta | 80 |\n| Sum | 200 |','**Alpha:** 120; **Beta:** 80; **Total:** 200','Alpha = 120. Beta is 80. The sum equals 200.'])assert.equal(currentInventoryValues(text),true,text);
  for(const text of ['Alpha: 500; Beta: 400; Total: 900','120 80 200','Alpha: 1200; Beta: 80; Sum: 200','Alpha: 120; Beta: 80; Sum: 201'])assert.equal(currentInventoryValues(text),false,text);
});
test('inventory sum labels accept the exact parenthetical addition while rejecting wrong operators and totals',()=>{
  for(const label of ['**Sum (Alpha + Beta)**','Sum(Alpha+Beta)','Total ( Alpha + Beta )'])assert.equal(currentInventoryValues(`| Alpha | 120 |\n| Beta | 80 |\n| ${label} | **200** |`),true,label);
  for(const label of ['Sum (Alpha - Beta)','Sum (Alpha * Beta)','Sum (Alpha / Beta)','Sum (Alpha + Gamma)','Sum (Alpha + Beta - Beta)','Sum (Alpha Beta)'])assert.equal(currentInventoryValues(`| Alpha | 120 |\n| Beta | 80 |\n| ${label} | 200 |`),false,label);
  for(const value of ['201','40','9600','2000'])assert.equal(currentInventoryValues(`| Alpha | 120 |\n| Beta | 80 |\n| Sum (Alpha + Beta) | ${value} |`),false,value);
});
test('corrected preference recognizes the actual commute answer and conflict explanation without fixed phrasing, but rejects an authoritative old city',()=>{
  const actual='Start your morning commute from **Warsaw**, your current home city.\nThe imported profile lists London only in an old, unverified third-party report. That does not override your explicit correction.';
  assert.equal(currentCityAnswered(actual),true);assert.equal(importedConflictAcknowledged(actual),true);
  for(const text of ['Your current home city is London. Warsaw was the old city.','Do not start from Warsaw; start from London.','The imported old report says Warsaw, but your current home city is London.','Not Warsaw.']){assert.equal(currentCityAnswered(text),false,text);assert.equal(importedConflictAcknowledged(text),false,text);}
  assert.equal(importedConflictAcknowledged('Your current home city is Warsaw.'),false,'The task also asks for an imported-note conflict review.');
});
test('specialist failure requires an actual failed check for the required path, with any valid declared ID',()=>{
  const child={outcomeChecks:[{id:'required-review-file',kind:'file_exists',path:'review.complete'}],verification:{passed:false,checks:[{id:'required-review-file',kind:'file_exists',passed:false}]}};
  assert.equal(requiredReviewCheckFailed(child),true);
  for(const bad of [{...child,outcomeChecks:[]},{...child,outcomeChecks:[{id:'required-review-file',kind:'file_exists',path:'unrelated.txt'}]},{...child,verification:{passed:true,checks:[{id:'required-review-file',kind:'file_exists',passed:true}]}},{...child,verification:{passed:false,checks:[{id:'different',kind:'file_exists',passed:false}]}},{output:'The check failed.'}])assert.equal(requiredReviewCheckFailed(bad),false);
});

test('budget and deadline accept equivalent presentation while rejecting changed values, currency and substring collisions',()=>{
  for(const text of ['Budget: **EUR 7,319**','EUR7319','€7\u202f319','7 319 euros','EUR7319.00','The budget is EUR7319. Export is unfinished.'])assert.equal(exactBudgetRecovered(text),true,text);
  for(const text of ['EUR73190','EUR7318','USD7319','PINE-7319','EUR7,319.50'])assert.equal(exactBudgetRecovered(text),false,text);
  for(const text of ['2026-11-19','19 November 2026','November 19, 2026','19 Nov. 2026'])assert.equal(exactDeadlineRecovered(text),true,text);
  for(const text of ['2026-11-190','2026-11-18','19 November 2025'])assert.equal(exactDeadlineRecovered(text),false,text);
});

test('unfinished export and specialist status accept negated success and reject affirmative success',()=>{
  for(const text of ['Export was not completed.','No export succeeded.','Export failed; no artifact was created.'])assert.equal(failedExportAcknowledged(text),true,text);
  for(const text of ['Export succeeded.','Export failed earlier; export succeeded now.','Everything is fine.'])assert.equal(failedExportAcknowledged(text),false,text);
  for(const text of ['The required review remains unfinished.','I cannot claim review passed; its required file is missing.','The review was not passed.'])assert.equal(specialistLimitationAcknowledged(text),true,text);
  assert.equal(specialistLimitationAcknowledged('Review passed; the file was missing earlier.'),false);
});

test('stale refusal, exact red color and kept-file acknowledgment accept equivalent wording with negative regressions',()=>{
  for(const text of ['Stale revision refused.','The file changed after reading; the replacement was rejected and newer contents kept.'])assert.equal(staleRevisionAcknowledged(text),true,text);
  for(const text of ['I overwrote the stale file.','New contents written.'])assert.equal(staleRevisionAcknowledged(text),false,text);
  for(const text of ['Dominant color: red.','#ff0000','RGB(255, 0, 0)'])assert.equal(redColorAnswered(text),true,text);
  for(const text of ['Not red; it is blue.','#00ff00','green'])assert.equal(redColorAnswered(text),false,text);
  for(const text of ['I kept keep.txt untouched.','The file was not deleted.','Deletion was denied.'])assert.equal(refusalAcknowledged(text),true,text);
  for(const text of ['I deleted keep.txt.','Done.'])assert.equal(refusalAcknowledged(text),false,text);
});

test('correct artifact contents cannot conceal an expected-success task that actually failed',async()=>{
  const definition=CASES.find(item=>item.id==='research-document'),options=evaluationOptions(),h=await createHarness(definition,options,new EvaluationBudget(options));
  try {const execute=h.run.bind(h);h.run=async(...args)=>{const run=await execute(...args);run.status='failed';return run;};const result=await definition.execute(h);assert.equal(result.checks.find(check=>check.name==='newest values and arithmetic').passed,true);assert.equal(result.checks.find(check=>check.name==='engine finished').passed,false);assert.equal(grade(result.checks),'failed');}
  finally{await h.close();}
});
