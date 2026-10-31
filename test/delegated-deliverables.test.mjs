import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { writeWorkspace } from '../lib/agent-tools.mjs';
import { prepareDeliverable, recordDeliverableAttempt, ensureDeliverableIds, hydrateLegacyDeliverables, deliverableRepairFeedback, repairObservationGuidance } from '../lib/delegated-deliverables.mjs';
import { checkOutcomes, callFingerprint } from '../lib/work-quality.mjs';

const call=(id,name,args={})=>({id,name,arguments:args});
const tools=(...toolCalls)=>({text:'',toolCalls});
const answer=text=>({text,toolCalls:[]});
const original='A checked report with the literal verified result.';
const checks=[{id:'report',kind:'file_contains',path:'report.txt',value:'verified result'}];
function child(id,{passed=true,declared=checks,records=[],deniedCalls=[]}={}) {
  return {id,status:'completed',outcomeChecks:structuredClone(declared),workRecords:records,deniedCalls,verification:{passed:declared.length?passed:null,checks:declared.map(c=>({id:c.id,kind:c.kind,passed}))}};
}
function prepared(run={}){return {run,item:prepareDeliverable(run,{botId:'scout',expectedOutput:original,callId:'first'})};}

test('repairs bind to an engine ID and preserve the original requirement despite different wording',()=>{
  const {run,item}=prepared();
  recordDeliverableAttempt(run,item.id,child('first-child',{declared:[]}),{callId:'first',tools:['workspace']});
  const before=structuredClone(run.requiredDeliverables[0].attempts[0]);
  assert.throws(()=>prepareDeliverable(run,{botId:'scout',expectedOutput:'A rewritten report.',callId:'different'}),/deliverableId/);
  const retry=prepareDeliverable(run,{botId:'scout',expectedOutput:'A rewritten report.',deliverableId:item.id,callId:'repair'});
  assert.equal(retry.expected,original);assert.equal(retry.id,item.id);
  const result=recordDeliverableAttempt(run,item.id,child('repaired-child'),{callId:'repair',tools:['workspace']});
  assert.equal(result.status,'completed');assert.equal(run.requiredDeliverables.length,1);
  assert.deepEqual(result.attempts[0],before);assert.equal(result.attempts[0].status,'partial');
  assert.equal(result.attempts[1].status,'completed');
});

test('another teammate, another task ID and a duplicate admitted call cannot certify a repair',()=>{
  const {run,item}=prepared();recordDeliverableAttempt(run,item.id,child('draft',{declared:[]}),{callId:'first'});
  assert.throws(()=>prepareDeliverable(run,{botId:'nova',deliverableId:item.id,callId:'repair'}),/original teammate/);
  assert.throws(()=>prepareDeliverable({}, {botId:'scout',deliverableId:item.id,callId:'repair'}),/current task/);
  assert.throws(()=>prepareDeliverable(run,{botId:'scout',deliverableId:item.id,callId:'first'}),/already been admitted/);
});

test('a repaired child must declare real passing checks and cannot replace an original file predicate',()=>{
  const {run,item}=prepared();
  recordDeliverableAttempt(run,item.id,child('failed-check',{passed:false}),{callId:'first'});
  const weakened=recordDeliverableAttempt(run,item.id,child('weakened',{declared:[{id:'report',kind:'file_exists',path:'report.txt'}]}),{callId:'weaken'});
  assert.equal(weakened.status,'partial');assert.match(weakened.unmet[0],/original check report/);
  const undeclared=recordDeliverableAttempt(run,item.id,child('undeclared',{declared:[]}),{callId:'empty'});
  assert.equal(undeclared.status,'partial');
  const reordered=recordDeliverableAttempt(run,item.id,child('correct',{declared:[{value:'verified result',path:'report.txt',kind:'file_contains',id:'report'}]}),{callId:'correct'});
  assert.equal(reordered.status,'completed');
});

test('failed observational checks require the same observed action in a fresh verified attempt',()=>{
  const {run,item}=prepared(),check={id:'source',kind:'source_read',callId:'old-read'};
  const record={callId:'old-read',tool:'http_fetch',status:'failed',requestDigest:'exact-request'};
  recordDeliverableAttempt(run,item.id,child('old',{passed:false,declared:[check],records:[record]}),{callId:'first'});
  const changed=recordDeliverableAttempt(run,item.id,child('wrong-source',{declared:[{...check,callId:'new-read'}],records:[{...record,callId:'new-read',status:'succeeded',requestDigest:'different-request'}]}),{callId:'wrong'});
  assert.equal(changed.status,'partial');
  const exact=recordDeliverableAttempt(run,item.id,child('right-source',{declared:[{...check,callId:'new-read'}],records:[{...record,callId:'new-read',status:'succeeded'}]}),{callId:'right'});
  assert.equal(exact.status,'completed');
});

test('failed source repairs retain exact read requests and check identities without replaying successful reads',()=>{
  const {run,item}=prepared(),read=call('skills-read','skills_read',{skillId:'assigned-skill'}),check={id:'original-source',kind:'source_read',callId:read.id};
  const record={callId:read.id,tool:read.name,status:'succeeded',requestDigest:callFingerprint(read)};
  const attempt={...child('original-child',{passed:false,declared:[check,{id:'already-read',kind:'source_read',callId:'passed-read'}],records:[record,{callId:'passed-read',tool:'workspace_read',status:'succeeded',requestDigest:'retained'}]}),events:[{type:'tool.started',toolCallId:read.id,tool:read.name,arguments:read.arguments}]};
  attempt.verification.checks[1].passed=true;
  recordDeliverableAttempt(run,item.id,attempt,{callId:'first'});
  const guidance=repairObservationGuidance(run.requiredDeliverables[0],{});
  assert.equal(guidance.length,1);assert.equal(guidance[0].id,check.id);assert.equal(guidance[0].originalCallId,read.id);
  assert.deepEqual(guidance[0].readRequest,{tool:read.name,arguments:read.arguments});
  assert.match(guidance[0].notice,/fresh call ID/);
  assert.equal(run.requiredDeliverables[0].attempts[0].status,'partial');
});

test('repair guidance never offers mismatched, ambiguous or mutating calls as repeatable reads',()=>{
  for(const mode of ['mismatch','duplicate','mutation','denied','unknown']) {
    const {run,item}=prepared(),read=call('observed',mode==='mutation'?'workspace_write':'skills_list',{}),record={callId:read.id,tool:read.name,status:'failed',requestDigest:mode==='mismatch'?'wrong':callFingerprint(read)};
    const event={type:'tool.started',toolCallId:read.id,tool:read.name,arguments:read.arguments};
    if(mode==='denied')record.errorCode='denied';
    if(mode==='unknown')record.outcome='unknown';
    recordDeliverableAttempt(run,item.id,{...child('child',{passed:false,declared:[{id:'source',kind:'source_read',callId:read.id}],records:[record]}),events:mode==='duplicate'?[event,event]:[event]},{callId:'first'});
    const [guidance]=repairObservationGuidance(run.requiredDeliverables[0],{});
    assert.equal(guidance.readRequest,undefined);assert.match(guidance.notice,/unavailable/);
  }
});

test('historical read guidance requires the exact child run, unique canonical call and matching receipt digest',()=>{
  const read=call('old-read','skills_read',{skillId:'retained-skill'}),record={callId:read.id,tool:read.name,status:'succeeded',requestDigest:callFingerprint(read)},check={id:'source',kind:'source_read',callId:read.id};
  for(const mode of ['exact','wrong-run','different-request','duplicate']) {
    const {run,item}=prepared(),old=child('old-child',{passed:false,declared:[check],records:[record]});
    recordDeliverableAttempt(run,item.id,old,{callId:'first'});
    const baseline=run.requiredDeliverables[0].baselineChecks[0];delete baseline.request;delete baseline.runId;
    const canonicalCall={id:read.id,type:'function',function:{name:read.name,arguments:JSON.stringify(mode==='different-request'?{skillId:'another-skill'}:read.arguments)}};
    const state={runHistory:{scout:[old]},conversations:{scout:[{role:'assistant',runId:mode==='wrong-run'?'another-child':old.id,tool_calls:mode==='duplicate'?[canonicalCall,canonicalCall]:[canonicalCall]}]}};
    const [guidance]=repairObservationGuidance(run.requiredDeliverables[0],state);
    assert.equal(Boolean(guidance.readRequest),mode==='exact');
    if(mode==='exact')assert.deepEqual(guidance.readRequest,{tool:read.name,arguments:read.arguments});
  }
});

test('accepted nested teammate checks retain engine-owned evidence for final parent rechecks',()=>{
  const {run,item}=prepared(),nested={id:'nested-job',botId:'scout',callId:'nested-call',status:'completed',childRunId:'nested-child',result:{botId:'scout',runId:'nested-child',status:'completed',output:'Do not duplicate full private replies in accepted evidence.',deliverable:{id:'nested-requirement',status:'completed'}}};
  const result=recordDeliverableAttempt(run,item.id,{...child('child',{declared:[{id:'nested',kind:'teammate_completed',delegationId:nested.id}]}),delegationJobs:[nested,{id:'unreferenced'}],requiredDeliverables:[{id:'nested-requirement',status:'completed'},{id:'unreferenced'}]},{callId:'first'});
  assert.equal(result.accepted.delegationJobs.length,1);assert.equal(result.accepted.delegationJobs[0].id,nested.id);
  assert.equal(result.accepted.delegationJobs[0].result.output,undefined);
  assert.deepEqual(result.accepted.requiredDeliverables,[{id:'nested-requirement',status:'completed'}]);
});

test('retained async teammate checks keep their exact intermediate attempt through repair-history pruning',async()=>{
  const {run,item}=prepared();
  for(let index=0;index<22;index++) {
    const callId=`attempt-${index}`,runId=`child-${index}`;
    recordDeliverableAttempt(run,item.id,child(runId,{declared:[]}),{callId});
    if(index===1) {
      run.delegationJobs=[{id:'pinned-job',botId:'scout',callId,status:'completed',childRunId:runId,result:{botId:'scout',runId,status:'completed',deliverable:{id:item.id,status:'partial'}}}];
      run.outcomeChecks=[{id:'pinned',kind:'teammate_completed',delegationId:'pinned-job'}];
    }
  }
  recordDeliverableAttempt(run,item.id,child('final-child'),{callId:'final-call'});
  assert.ok(run.requiredDeliverables[0].attempts.some(attempt=>attempt.callId==='attempt-1'));
  assert.ok(run.requiredDeliverables[0].attempts.length<22);
  const engine={assertRunning(){},current:()=>run,store:{redact:String}};
  assert.equal((await checkOutcomes(engine,{})).passed,true);
  assert.equal(run.delegationJobs[0].result.deliverable.status,'partial');
});

test('denied and uncertain exact actions remain bound to the same requirement across repairs',()=>{
  const {run,item}=prepared();
  recordDeliverableAttempt(run,item.id,child('draft',{declared:[],deniedCalls:['denied-action'],records:[{callId:'uncertain',outcome:'unknown',requestDigest:'unknown-action'}]}),{callId:'first'});
  const retry=prepareDeliverable(run,{botId:'scout',deliverableId:item.id,callId:'repair'});
  assert.deepEqual(retry.guards,{denied:['denied-action'],unknown:['unknown-action']});
  recordDeliverableAttempt(run,item.id,child('missing-identity',{declared:[],records:[{outcome:'unknown'}]}),{callId:'other'});
  assert.throws(()=>prepareDeliverable(run,{botId:'scout',deliverableId:item.id,callId:'unsafe-repair'}),/unknown outcome/);
});

test('legacy checkpoint requirements get stable IDs, actual old call binding and retained refusal guards',()=>{
  const run={requiredDeliverables:[{botId:'scout',runId:'old-child',expected:original,status:'partial'}],workRecords:[{tool:'delegate_task',childRunId:'old-child',callId:'old-call'}]};
  const [item]=ensureDeliverableIds(run);hydrateLegacyDeliverables(run,()=>child('old-child',{declared:[],deniedCalls:['denied']}));
  assert.equal(item.attempts[0].callId,'old-call');assert.equal(ensureDeliverableIds(run)[0].id,item.id);
  assert.deepEqual(item.guards.denied,['denied']);assert.equal(deliverableRepairFeedback(run)[0].repair.arguments.deliverableId,item.id);
});

test('an original teammate check follows only its verified repair lineage without rewriting its partial receipt',async()=>{
  const {run,item}=prepared();recordDeliverableAttempt(run,item.id,child('partial',{declared:[]}),{callId:'first'});
  run.workRecords=[{callId:'first',tool:'delegate_task',status:'succeeded',childRunId:'partial',childStatus:'completed',deliverable:'partial'}];
  run.outcomeChecks=[{id:'required',kind:'teammate_completed',callId:'first'}];
  const engine={assertRunning(){},current:()=>run,store:{redact:String}};
  assert.equal((await checkOutcomes(engine,{})).passed,false);
  recordDeliverableAttempt(run,item.id,child('verified'),{callId:'repair'});
  assert.equal((await checkOutcomes(engine,{})).passed,true);assert.equal(run.workRecords[0].deliverable,'partial');
  run.workRecords[0].childRunId='unrelated';assert.equal((await checkOutcomes(engine,{})).passed,false);
});

async function fixture(t,handler,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-deliverable-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture-model'});for(const bot of state.bots){bot.connectionId='fixture';bot.tools=['workspace','memory','delegation'];bot.approvalPolicy='balanced';}});
  const provider={complete:async(_,request)=>handler(request,store,engine)};
  const engine=new NativeEngine(store,{providers:provider,runTimeout:10000,...options});
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,store,engine};
}

for(const source of ['chat','routine'])test(`${source}: six completed steps and a verified reworded Scout repair finish one original requirement`,async t=>{
  let parentTurns=0,childAttempts=0;const childTurns=new Map();
  const f=await fixture(t,async(request,store)=>{
    const parent=request.messages[0].content.startsWith(`You are ${store.state.bots[0].name}`);
    if(!parent) {
      const id=store.state.runs.bot_scout.id;if(!childTurns.has(id)){childTurns.set(id,0);childAttempts++;}
      const turn=childTurns.get(id)+1;childTurns.set(id,turn);
      if(childAttempts===1)return answer('A draft without mechanical checks.');
      assert.ok(request.messages.some(m=>m.content?.includes(original)),'original expectation accompanies repair');
      return turn===1?tools(call('write','workspace_write',{path:'report.txt',content:'verified result'}),call('checks','task_outcome_set',{checks})):answer('The original result is verified.');
    }
    parentTurns++;
    if(parentTurns===1)return tools(call('first','delegate_task',{botId:'bot_scout',task:'Produce the report.',expectedOutput:original}));
    const requirement=store.state.runs.bot_atlas.requiredDeliverables[0];
    if(parentTurns===2)return tools(call('plan','task_plan_set',{steps:Array.from({length:6},(_,i)=>({id:`s${i}`,title:`Step ${i}`,status:'completed'}))}),call('parent-file','workspace_write',{path:'owner-report.txt',content:'owner verified result'}),call('parent-check','task_outcome_set',{checks:[{id:'required',kind:'teammate_completed',callId:'first'},{id:'owner-file',kind:'file_sha256',path:'owner-report.txt',value:createHash('sha256').update('owner verified result').digest('hex')}]}),call('wrong-wording','delegate_task',{botId:'bot_scout',task:'Fix the report.',expectedOutput:'Different wording of the report.'}));
    if(parentTurns===3) {
      assert.ok(request.messages.some(m=>m.role==='tool' && m.content?.includes('Repair it with delegate_task')));
      return tools(call('repair','delegate_task',{botId:'bot_scout',deliverableId:requirement.id,task:'Repair the original report using retained work.',expectedOutput:'Different wording of the report.'}));
    }
    return answer('The report is done.');
  });
  const started=await f.engine.start('bot_atlas','Finish and verify the report.',{source,...(source==='routine'?{lane:'routine:fixture'}:{})});await f.engine.tasks.get(started.id);
  const run=f.store.state.runs.bot_atlas;assert.equal(run.status,'completed',run.error);assert.equal(run.plan.steps.filter(s=>s.status==='completed').length,6);assert.equal(run.verification.passed,true);
  assert.equal(childAttempts,2);assert.equal(run.requiredDeliverables.length,1);assert.equal(run.requiredDeliverables[0].attempts[0].status,'partial');assert.equal(run.requiredDeliverables[0].expected,original);
  assert.equal(run.workRecords.find(r=>r.callId==='first').deliverable,'partial');assert.equal(f.store.state.runHistory.bot_atlas[0].requiredDeliverables[0].status,'completed');
});

test('final completion re-reads accepted child files and rejects later changes',async t=>{
  let parentTurns=0,childTurns=0;const f=await fixture(t,async(request,store)=>{
    const parent=request.messages[0].content.startsWith(`You are ${store.state.bots[0].name}`);
    if(!parent)return ++childTurns===1?tools(call('write','workspace_write',{path:'report.txt',content:'verified result'}),call('checks','task_outcome_set',{checks})):answer('Verified.');
    if(++parentTurns===1)return tools(call('delegate','delegate_task',{botId:'bot_scout',task:'Create the result.',expectedOutput:original}));
    if(parentTurns===2)await writeWorkspace(store,'bot_scout','report.txt','changed after child verification');
    return answer('Done.');
  });
  const started=await f.engine.start('bot_atlas','Verify actual results.');await f.engine.tasks.get(started.id);
  const run=f.store.state.runs.bot_atlas;assert.equal(run.status,'failed');assert.equal(run.requiredDeliverables[0].status,'partial');assert.equal(run.requiredDeliverables[0].attempts[0].verification.passed,true);assert.equal(run.requiredDeliverables[0].currentVerification.passed,false);
});

test('a repair child inherits an exact refusal without asking again or dispatching the denied write',async t=>{
  let parentTurns=0,childTurns=0;const args={path:'denied.txt',content:'must not be written'},fingerprint=callFingerprint(call('x','workspace_write',args));
  const f=await fixture(t,async(request,store)=>{
    const parent=request.messages[0].content.startsWith(`You are ${store.state.bots[0].name}`);
    if(!parent)return ++childTurns===1?answer('Draft.'):childTurns===2?tools(call('same-denied-write','workspace_write',args)):answer('The exact refused action stayed blocked.');
    if(++parentTurns===1)return tools(call('first','delegate_task',{botId:'bot_scout',task:'Draft.',expectedOutput:original}));
    if(parentTurns===2) {
      await store.mutate(state=>{state.runs.bot_atlas.requiredDeliverables[0].guards.denied.push(fingerprint);});
      return tools(call('repair','delegate_task',{botId:'bot_scout',deliverableId:store.state.runs.bot_atlas.requiredDeliverables[0].id,task:'Inspect the original work.'}));
    }
    return answer('Cannot complete the denied work.');
  });
  const started=await f.engine.start('bot_atlas','Do not bypass refusals.');await f.engine.tasks.get(started.id);
  assert.equal(f.store.state.runs.bot_atlas.status,'failed');assert.ok(f.store.state.runs.bot_scout.workRecords.some(r=>r.errorCode==='denied'));
  assert.equal(f.engine.pending.size,0);assert.ok(f.store.state.runs.bot_scout.deniedCalls.includes(fingerprint));
});

test('startup recovery ignores an old cached partial delegation and launches a real repair under the same requirement',async t=>{
  let reached;const pending=new Promise(resolve=>{reached=resolve;});let parentTurns=0;
  const originalCall=call('first','delegate_task',{botId:'bot_scout',task:'Produce the report.',expectedOutput:original});
  const f=await fixture(t,async(request,store)=>{
    if(!request.messages[0].content.startsWith(`You are ${store.state.bots[0].name}`))return answer('An unchecked retained draft.');
    if(++parentTurns===1)return tools(originalCall);
    reached();await new Promise((_,reject)=>{request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});if(request.signal.aborted)reject(request.signal.reason);});
  });
  await f.engine.start('bot_atlas','Finish the retained required report.');await pending;
  const snapshot=structuredClone(f.store.state),requirement=snapshot.runs.bot_atlas.requiredDeliverables[0],firstAttempt=structuredClone(requirement.attempts[0]);
  // Inject the pre-fix cache format into a real committed checkpoint, rather than mocking the tool path.
  snapshot.taskCheckpoints.bot_atlas.snapshot.completedEffects.push([callFingerprint(originalCall),{output:{botId:'bot_scout',runId:firstAttempt.runId,status:'completed',deliverable:{status:'partial'}}}]);
  await f.engine.close();await f.store.mutate(state=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,snapshot);});
  const reopened=await new Store(f.directory).init();let parentCalls=0,childCalls=0;
  const recovered=new NativeEngine(reopened,{runTimeout:10000,providers:{async complete(_,request){
    if(!request.messages[0].content.startsWith(`You are ${reopened.state.bots[0].name}`))return ++childCalls===1?tools(call('real-write','workspace_write',{path:'report.txt',content:'verified result'}),call('real-checks','task_outcome_set',{checks})):answer('Actually repaired.');
    return ++parentCalls===1?tools({...originalCall,id:'fresh-repair-call'}):answer('Recovered and completed.');
  }}});
  try {
    await recovered.recover();await recovered.recoverAutonomous();
    for(const task of recovered.tasks.values())await task;
    const run=reopened.state.runs.bot_atlas;assert.equal(run.status,'completed',run.error);assert.equal(childCalls,2,'a partial cached reply cannot substitute for the repaired child');
    assert.equal(run.requiredDeliverables.length,1);assert.equal(run.requiredDeliverables[0].id,requirement.id);assert.deepEqual(run.requiredDeliverables[0].attempts[0],firstAttempt);assert.equal(run.requiredDeliverables[0].attempts[1].status,'completed');
  } finally {await recovered.close();}
});

test('startup recovery reuses a still-verified completed delegation without launching its child again',async t=>{
  let reached;const pending=new Promise(resolve=>{reached=resolve;});let parentTurns=0,childTurns=0;
  const originalCall=call('first','delegate_task',{botId:'bot_scout',task:'Produce the report.',expectedOutput:original});
  const f=await fixture(t,async(request,store)=>{
    if(!request.messages[0].content.startsWith(`You are ${store.state.bots[0].name}`))return ++childTurns===1?tools(call('write','workspace_write',{path:'report.txt',content:'verified result'}),call('checks','task_outcome_set',{checks})):answer('Verified.');
    if(++parentTurns===1)return tools(originalCall);
    reached();await new Promise((_,reject)=>{request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});if(request.signal.aborted)reject(request.signal.reason);});
  });
  await f.engine.start('bot_atlas','Retain completed child work.');await pending;
  const snapshot=structuredClone(f.store.state),id=snapshot.runs.bot_atlas.requiredDeliverables[0].id;
  assert.equal(snapshot.taskCheckpoints.bot_atlas.snapshot.completedEffects.length,1);
  await f.engine.close();await f.store.mutate(state=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,snapshot);});
  const reopened=await new Store(f.directory).init();let parentCalls=0;
  const recovered=new NativeEngine(reopened,{runTimeout:10000,providers:{async complete(_,request){
    assert.ok(request.messages[0].content.startsWith(`You are ${reopened.state.bots[0].name}`),'the completed child must not run again');
    return ++parentCalls===1?tools({...originalCall,id:'repeated-after-restart'}):answer('Completed using verified retained work.');
  }}});
  try {
    await recovered.recover();await recovered.recoverAutonomous();for(const task of recovered.tasks.values())await task;
    const run=reopened.state.runs.bot_atlas;assert.equal(run.status,'completed',run.error);assert.equal(run.requiredDeliverables[0].id,id);assert.equal(run.requiredDeliverables[0].attempts.length,1);assert.equal(run.workRecords.at(-1).childRunId,run.requiredDeliverables[0].runId);
  } finally {await recovered.close();}
});
