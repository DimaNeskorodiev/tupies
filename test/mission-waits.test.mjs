import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMissionWait, missionWaitDecision, consumeMissionWake } from '../lib/mission-waits.mjs';

test('durable timer has exact one-shot identity and retains its original deadline',()=>{
  const wait=validateMissionWait({kind:'timer',delayMs:100,deadlineAt:2000},{time:1000});
  assert.equal(missionWaitDecision(wait,{time:1099}).ready,false);
  const decision=missionWaitDecision(wait,{time:1100});assert.equal(decision.ready,true);
  const mission={ownerEngineId:'engine_one',state:'waiting',waitCondition:wait};
  const wake=consumeMissionWake(mission,wait.id,decision.eventDigest,{time:1100});
  assert.equal(wake.cursor,1);assert.equal(mission.resumeRequested,true);assert.equal(mission.waitHistory[0].deadlineAt,2000);
  assert.throws(()=>consumeMissionWake(mission,wait.id,decision.eventDigest),/stopped|replaced|consumed/);
});
test('Stop, Pause and a replacement wait defeat a previously observed wake',()=>{
  const wait=validateMissionWait({kind:'timer',delayMs:1},{time:1000}),decision=missionWaitDecision(wait,{time:1001});
  for(const patch of [{stopRequested:true},{pauseRequested:true},{state:'paused'},{waitCondition:{...wait,id:'mission_wait_other'}}])assert.throws(()=>consumeMissionWake({ownerEngineId:'engine_one',state:'waiting',waitCondition:structuredClone(wait),...patch},wait.id,decision.eventDigest),/stopped|paused|replaced|consumed/);
});
test('clock rollback and expiry never become a successful new observation',()=>{
  const wait=validateMissionWait({kind:'timer',delayMs:10,deadlineAt:1100},{time:1000});
  assert.equal(missionWaitDecision(wait,{time:999}).blocked,true);
  assert.equal(missionWaitDecision(wait,{time:1100}).expired,true);
});
test('dependency waits bind only actual current delegation IDs and do not wake on admission',()=>{
  const job={id:'delegation_one',status:'queued'},wait=validateMissionWait({kind:'dependency',delegationIds:[job.id]},{time:1000,run:{delegationJobs:[job]}});
  assert.equal(missionWaitDecision(wait,{time:1000,jobs:[job]}).ready,false);
  assert.equal(missionWaitDecision(wait,{time:1000,jobs:[{...job,status:'suspended'}]}).ready,false);
  assert.equal(missionWaitDecision(wait,{time:1000,jobs:[{...job,status:'failed',childRunId:'run_exact'}]}).ready,true);
  assert.equal(missionWaitDecision(wait,{time:1000,jobs:[]}).blocked,true);
  assert.throws(()=>validateMissionWait({kind:'dependency',delegationIds:['foreign']},{time:1000,run:{delegationJobs:[job]}}),/another task/);
});
test('file watcher admits only canonical private paths and existing read-only condition fields',()=>{
  for(const file of ['/etc/passwd','../secret','folder/../secret','folder//file','./file','folder\\file',''])assert.throws(()=>validateMissionWait({kind:'file_change',path:file},{time:1000}),/canonical/);
  assert.throws(()=>validateMissionWait({kind:'file_change',path:'valid.txt',url:'https://example.com'},{time:1000}),/supported/);
  const wait=validateMissionWait({kind:'file_change',path:'Documents/input.md',intervalMs:1000},{time:1000});wait.baseline={sha256:'old'};
  assert.equal(missionWaitDecision(wait,{time:2000}).reason,'observation_required');
  assert.equal(missionWaitDecision(wait,{time:2000,observation:{sha256:'old'}}).ready,false);
  assert.equal(missionWaitDecision(wait,{time:2000,observation:{sha256:'new'}}).ready,true);
});
