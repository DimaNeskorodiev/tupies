import test from 'node:test';
import assert from 'node:assert/strict';
import { createMissionEffort, missionEffortSummary, checkMissionEffort, MISSION_EFFORT_PROFILES } from '../lib/mission-effort.mjs';
import { validateMissionIntent } from '../lib/mission-intent.mjs';
import { sanitizeMissionSummary } from '../lib/mission-presentation.mjs';

test('four finite profiles default to Medium and cannot be supplied by model payloads',()=>{
  assert.deepEqual(Object.keys(MISSION_EFFORT_PROFILES),['low','medium','high','ultra']);assert.equal(createMissionEffort().level,'medium');
  for(const level of Object.keys(MISSION_EFFORT_PROFILES)){const p=createMissionEffort(level);assert.ok(Object.values(p.limits).every(n=>Number.isSafeInteger(n)&&n>0));p.limits.modelCalls=0;assert.notEqual(createMissionEffort(level).limits.modelCalls,0);}
  for(const value of ['unlimited','__proto__',{},null])assert.throws(()=>createMissionEffort(value));
});
test('usage remains shared across attempts and profile changes; released reservations cost nothing',()=>{
  const mission={effort:createMissionEffort('low'),resourceLedger:{operations:{a:{status:'settled',effort:{modelCalls:1,estimatedTokens:100},actual:{tokens:80}},b:{status:'unknown',effort:{modelCalls:1,estimatedTokens:200}},c:{status:'reserved',effort:{modelCalls:1,estimatedTokens:300}},d:{status:'released',effort:{modelCalls:1,estimatedTokens:400}}}}};
  const before=missionEffortSummary(mission);assert.equal(before.used.estimatedTokens,280);assert.equal(before.reserved.estimatedTokens,300);assert.equal(before.committed.modelCalls,3);
  mission.effort=createMissionEffort('high');const after=missionEffortSummary(mission);assert.deepEqual(after.committed,before.committed);assert.equal(after.limits.estimatedTokens,4_000_000);
  assert.equal(missionEffortSummary({}),null);assert.doesNotThrow(()=>checkMissionEffort({}, {modelCalls:9999}));
});
test('effort cannot be selected from an inferred request or fabricated explicit quote',()=>{
  const owner={id:'owner',content:'Create a Mission with High effort to produce this report.'};
  const value={intent:'explicit',ownerMessageId:'owner',explicitRequest:owner.content,effort:'high',effortQuote:'High effort'};
  assert.equal(validateMissionIntent(value,owner).effort,'high');assert.throws(()=>validateMissionIntent({...value,effort:'ultra'},owner));assert.throws(()=>validateMissionIntent({...value,effortQuote:'Ultra effort'},owner));
  assert.throws(()=>validateMissionIntent({intent:'clear_goal',ownerMessageId:'owner',effort:'ultra'},owner));
});
test('remote budget summaries carry no execution authority and unfinished work cannot show 100 percent',()=>{
  const value=sanitizeMissionSummary({id:'mission_test',leadBotId:'bot_test',ownerEngineId:'engine_test',revision:1,status:'running',progress:{total:2,verified:1,percent:100,outcomesTotal:1,outcomesVerified:1},effort:{level:'ultra',percent:98,limits:{modelCalls:999999},operations:{secret:true},exhausted:true}});
  assert.equal(value.progress.percent,99);assert.equal(value.progress.acceptancePending,true);assert.equal(value.effort.limits,undefined);assert.equal(value.effort.operations,undefined);
});
