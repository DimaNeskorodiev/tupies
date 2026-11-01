import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { writeWorkspace } from '../lib/agent-tools.mjs';
import { prepareDeliverable, recordDeliverableAttempt } from '../lib/delegated-deliverables.mjs';
import { checkOutcomes, executeQualityTool, recordWork, workReceipt, reconcileWork, SAFE_RETRY_READS } from '../lib/work-quality.mjs';

const call=(id,name,args={})=>({id,name,arguments:args});
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-outcome-observations-')),store=await new Store(directory).init();
  const cleanup=[];t.after(async()=>{for(const close of cleanup)await close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const context={bot:store.state.bots[0],runId:'fixture_run',sessionId:'bot_atlas',controller:new AbortController()};
  await store.mutate(state=>{state.runs.bot_atlas={id:context.runId,status:'running',workRecords:[]};});
  const engine={store,assertRunning(){},current:()=>store.state.runs.bot_atlas};
  return {store,context,engine,cleanup,run:()=>engine.current(context)};
}
const source=(id,callId=id)=>({id,kind:'source_read',callId});
const teammate=delegationId=>({id:'teammate',kind:'teammate_completed',delegationId});
const verifiedJob=()=>({id:'delegation_fixture',botId:'bot_scout',callId:'start_fixture',status:'completed',childRunId:'child_fixture',result:{botId:'bot_scout',runId:'child_fixture',status:'completed',deliverable:{status:'completed'}}});

test('script inventories prove their exact observations while script execution proves only a real completed command',async t=>{
  const h=await fixture(t),inventory=['workspace_structure','scripts_list','scripts_inspect'];
  for(const name of inventory)await recordWork(h.engine,h.context,call(name,name),{items:[]});
  await recordWork(h.engine,h.context,call('run','scripts_run',{scriptId:'fixture',digest:'a'.repeat(64),args:[]}),{status:'completed',exitCode:0,stdout:'verified',stderr:''});
  const checks=[...inventory.map(name=>source(name)),{id:'command',kind:'command_success',callId:'run'}];
  await executeQualityTool(h.engine,h.context,'task_outcome_set',{checks});
  assert.equal((await checkOutcomes(h.engine,h.context)).passed,true);
  await assert.rejects(executeQualityTool(h.engine,h.context,'task_outcome_set',{checks:[...checks,source('execution-is-not-source','run')]}),/not an eligible/);
  for(const output of [{status:'failed',exitCode:7},{status:'timed_out',exitCode:0,timedOut:true},{status:'completed',exitCode:0,truncated:true},{status:'interrupted',exitCode:null}])assert.equal(workReceipt(call('bad','scripts_run'),output).status,'failed');
  assert.equal(SAFE_RETRY_READS.has('scripts_run'),false);
});

test('lost script execution receipts remain unknown while script inventory observations remain unapplied reads',()=>{
  const names=['scripts_run','scripts_list','scripts_inspect','workspace_structure'];
  const run={events:names.map(name=>({type:'tool.started',toolCallId:name,tool:name,arguments:{}})),workRecords:[]};
  reconcileWork(run);
  assert.deepEqual(run.workRecords.map(record=>record.outcome),['unknown','not_applied','not_applied','not_applied']);
});

test('a real skill inventory and assigned skill read satisfy health-check source criteria',async t=>{
  const h=await fixture(t);let turn=0;
  await h.store.mutate(state=>{state.runs.bot_atlas.status='completed';state.connections=[{id:'fixture',type:'openai',defaultModel:'fixture-model'}];Object.assign(state.bots[0],{connectionId:'fixture',tools:['skills']});});
  const engine=new NativeEngine(h.store,{providers:{async complete(){return ++turn===1?{text:'',toolCalls:[call('inventory','skills_list'),call('instructions','skills_read',{skillId:'health-fixture'}),call('criteria','task_outcome_set',{checks:[source('inventory'),source('instructions')]})]}:{text:'The assigned skill inventory and instructions are readable.',toolCalls:[]};}}});
  h.cleanup.push(()=>engine.close());
  await engine.tools.execute(h.store.state.bots[0],'skills_create',{name:'health-fixture',description:'Synthetic health-check instructions.',instructions:'Read the assigned synthetic skill and report capability limits.'},{approved:true});
  const started=await engine.start('bot_atlas','Check that your assigned skill inventory and instructions are readable.');await engine.tasks.get(started.id);
  const run=h.store.state.runs.bot_atlas;assert.equal(run.status,'completed');assert.equal(run.verification.passed,true);
  assert.ok(run.verification.checks.every(check=>/successful skills_/.test(check.detail)));
  assert.ok(!run.verification.checks.some(check=>/No matching/.test(check.detail)));
});

test('source criteria accept explicit skill, integration and workspace inventories while retaining exact observation identity',async t=>{
  const h=await fixture(t),names=['skills_list','skills_read','skills_file','skills_search','skills_inspect','integration_list','workspace_list','workspace_glob','workspace_search','bots_list','routines_list'];
  for(const name of names)await recordWork(h.engine,h.context,call(name,name),{items:[]});
  await executeQualityTool(h.engine,h.context,'task_outcome_set',{checks:names.map(name=>source(name))});
  const result=await checkOutcomes(h.engine,h.context);assert.equal(result.passed,true);assert.ok(result.checks.every(check=>/returned data/.test(check.detail)));
  const before=structuredClone(h.run().outcomeChecks);
  await assert.rejects(executeQualityTool(h.engine,h.context,'task_outcome_set',{checks:[source('replacement','skills_list')]}),/cannot be removed or weakened/);
  assert.deepEqual(h.run().outcomeChecks,before);
});

test('invalid source identities and non-read actions are rejected before immutable checks are stored',async t=>{
  const h=await fixture(t);
  await recordWork(h.engine,h.context,call('valid','skills_list'),{skills:[]});
  await executeQualityTool(h.engine,h.context,'task_outcome_set',{checks:[source('valid')]});
  await recordWork(h.engine,h.context,call('write','workspace_write',{path:'result.txt',content:'fixture'}),{path:'result.txt',tool:'skills_list',status:'succeeded'});
  await recordWork(h.engine,h.context,call('failed','skills_read',{skillId:'missing'}),{error:'No assigned skill.'});
  await recordWork(h.engine,h.context,call('ambiguous','skills_list'),{skills:[]});
  await recordWork(h.engine,h.context,call('ambiguous','skills_list'),{skills:[]});
  for(const [id,reason] of [['invented',/No observation/],['write',/not an eligible/],['failed',/did not succeed/],['ambiguous',/ambiguous/]]) {
    await assert.rejects(executeQualityTool(h.engine,h.context,'task_outcome_set',{checks:[source('valid'),source(id)]}),reason);
    assert.deepEqual(h.run().outcomeChecks,[source('valid')]);
  }
  for(const name of ['session_search','brain_search','web_search','integration_call','skills_run','task_plan_set']) {
    await recordWork(h.engine,h.context,call(name,name),{exitCode:0});
    await assert.rejects(executeQualityTool(h.engine,h.context,'task_outcome_set',{checks:[source('valid'),source(name)]}),/not an eligible/);
  }
});

test('legacy failed source checks remain explicit and passing checks describe actual observations',async()=>{
  const checks=['missing','ambiguous','write','failed','http-error','passed'].map(id=>source(id));
  const records=[workReceipt(call('ambiguous','skills_list'),{}),workReceipt(call('ambiguous','skills_list'),{}),workReceipt(call('write','workspace_write'),{}),workReceipt(call('failed','skills_read'),{error:'Missing.'}),workReceipt(call('http-error','http_fetch'),{status:404}),workReceipt(call('passed','skills_list'),{skills:[]})];
  const result=await checkOutcomes({assertRunning(){},current:()=>({outcomeChecks:checks,workRecords:records})},{});
  assert.equal(result.passed,false);assert.deepEqual(result.checks.map(check=>check.passed),[false,false,false,false,false,true]);
  for(const [index,reason] of [/No observation/,/ambiguous/,/not an eligible/,/did not succeed/,/did not succeed/,/successful skills_list/].entries())assert.match(result.checks[index].detail,reason);
});

test('async teammate checks require a unique current engine job and one identity field',async t=>{
  const h=await fixture(t);
  await assert.rejects(executeQualityTool(h.engine,h.context,'task_outcome_set',{checks:[teammate('invented')]}),/engine-owned delegationId/);
  await h.store.mutate(state=>{state.runs.bot_atlas.delegationJobs=[verifiedJob()];});
  await assert.rejects(executeQualityTool(h.engine,h.context,'task_outcome_set',{checks:[{...teammate('delegation_fixture'),callId:'start_fixture'}]}),/exactly one/);
  await assert.rejects(executeQualityTool(h.engine,h.context,'task_outcome_set',{checks:[{...source('invalid'),delegationId:'delegation_fixture'}]}),/Only teammate_completed/);
  await executeQualityTool(h.engine,h.context,'task_outcome_set',{checks:[teammate('delegation_fixture')]});
  assert.equal((await checkOutcomes(h.engine,h.context)).passed,true);
  await h.store.mutate(state=>{state.runs.bot_atlas.delegationJobs.push(verifiedJob());});
  const ambiguous=await checkOutcomes(h.engine,h.context);assert.equal(ambiguous.passed,false);assert.match(ambiguous.checks[0].detail,/ambiguous/);
});

test('queued acknowledgments, failed children and mismatched or partial async results never certify completion',async()=>{
  for(const change of [job=>{job.status='queued';delete job.result;},job=>{job.status='running';},job=>{job.status='failed';},job=>{job.status='interrupted';},job=>{job.result.runId='another-child';},job=>{job.result.botId='another-bot';},job=>{job.result.status='failed';},job=>{job.result.error='failed';},job=>{job.result.deliverable.status='partial';},job=>{job.result.deliverable.status='failed';},job=>{job.result.deliverable.id='invented-requirement';}]) {
    const job=verifiedJob();change(job);
    const result=await checkOutcomes({assertRunning(){},current:()=>({outcomeChecks:[teammate(job.id)],delegationJobs:[job]})},{});
    assert.equal(result.passed,false);
  }
});

test('an async partial attempt follows only its own verified repair lineage and current requirement checks',async()=>{
  const job=verifiedJob();job.result.deliverable={id:'required_fixture',status:'partial'};
  const requirement={id:'required_fixture',botId:job.botId,status:'completed',accepted:{runId:'repair_child',callId:'repair_call'},attempts:[{runId:job.childRunId,callId:job.callId,status:'partial',verification:{passed:null}},{runId:'repair_child',callId:'repair_call',status:'completed',verification:{passed:true}}]};
  const run={outcomeChecks:[teammate(job.id)],delegationJobs:[job],requiredDeliverables:[requirement]},original=structuredClone(job);
  const engine={assertRunning(){},current:()=>run};
  assert.equal((await checkOutcomes(engine,{})).passed,true);assert.deepEqual(job,original);
  requirement.status='partial';assert.equal((await checkOutcomes(engine,{})).passed,false);requirement.status='completed';
  requirement.attempts[0].callId='unrelated';assert.equal((await checkOutcomes(engine,{})).passed,false);requirement.attempts[0].callId=job.callId;
  requirement.botId='another-bot';assert.equal((await checkOutcomes(engine,{})).passed,false);requirement.botId=job.botId;
  job.status='failed';assert.equal((await checkOutcomes(engine,{})).passed,false);
});

test('a Work-like legacy failed skill-source contract is repaired by exact fresh reads without weakening its original checks',async t=>{
  const h=await fixture(t),reads=[call('old-inventory','skills_list'),call('old-instructions','skills_read',{skillId:'legacy-health-fixture'})],checks=[source('skills-discovery-read',reads[0].id),source('skill-index-source-read',reads[1].id)];
  let parentTurns=0,childTurns=0,legacy,requirementId;
  await h.store.mutate(state=>{state.runs.bot_atlas.status='completed';state.connections=[{id:'fixture',type:'openai',defaultModel:'fixture-model'}];for(const bot of state.bots)Object.assign(bot,{connectionId:'fixture',tools:['skills','delegation']});});
  const engine=new NativeEngine(h.store,{providers:{async complete(_,request){
    const parent=request.messages[0].content.startsWith(`You are ${h.store.state.bots[0].name}`);
    if(parent && ++parentTurns===1) {
      await h.store.mutate(state=>{const run=state.runs.bot_atlas,item=prepareDeliverable(run,{botId:'bot_scout',expectedOutput:'Verify the assigned skill inventory and instructions.',callId:'original-delegation'});requirementId=item.id;recordDeliverableAttempt(run,item.id,legacy,{callId:'original-delegation',tools:['skills']});for(const baseline of run.requiredDeliverables[0].baselineChecks){delete baseline.request;delete baseline.runId;}(state.runHistory ||= {}).bot_scout=[structuredClone(legacy)];state.conversations.bot_scout=[{role:'assistant',runId:legacy.id,tool_calls:reads.map(read=>({id:read.id,type:'function',function:{name:read.name,arguments:JSON.stringify(read.arguments)}}))}];});
      return {text:'',toolCalls:[call('repair-delegation','delegate_task',{botId:'bot_scout',deliverableId:requirementId,task:'Repair the original skill-source checks from the retained evidence.'})]};
    }
    if(!parent && ++childTurns===1) {
      const task=request.messages.filter(message=>message.role==='user').map(message=>message.content).join('\n');
      for(const check of checks)assert.ok(task.includes(`"id":"${check.id}"`));
      assert.ok(task.includes('"readRequest":{"tool":"skills_list","arguments":{}}'));
      assert.ok(task.includes('"readRequest":{"tool":"skills_read","arguments":{"skillId":"legacy-health-fixture"}}'));
      return {text:'',toolCalls:[call('new-inventory','skills_list'),call('new-instructions','skills_read',reads[1].arguments),call('new-checks','task_outcome_set',{checks:checks.map((check,index)=>({...check,callId:index===0?'new-inventory':'new-instructions'}))})]};
    }
    return {text:parent?'The original teammate health check is verified.':'The original skill-source checks pass after exact reads.',toolCalls:[]};
  }}});h.cleanup.push(()=>engine.close());
  const scout=h.store.state.bots.find(bot=>bot.id==='bot_scout');
  await engine.tools.execute(scout,'skills_create',{name:'legacy-health-fixture',description:'Synthetic migrated skill.',instructions:'Report actual assigned skill inventory and readable instructions.'},{approved:true});
  const records=[];for(const read of reads)records.push(workReceipt(read,await engine.tools.execute(h.store.state.bots.find(bot=>bot.id==='bot_scout'),read.name,read.arguments)));
  legacy={id:'legacy_failed_child',status:'failed',outcomeChecks:checks,workRecords:records,verification:{passed:false,checks:checks.map(check=>({id:check.id,kind:check.kind,passed:false}))},error:'The task ended with a failed declared outcome check.'};
  const original=structuredClone(legacy),started=await engine.start('bot_atlas','Repair the retained migrated-bot health check.');await engine.tasks.get(started.id);
  const run=h.store.state.runs.bot_atlas,item=run.requiredDeliverables[0];assert.equal(run.status,'completed');assert.equal(item.id,requirementId);assert.deepEqual(item.attempts.map(attempt=>attempt.status),['failed','completed']);
  assert.deepEqual(item.baselineChecks.map(item=>item.check),checks);assert.deepEqual(legacy,original);assert.deepEqual(h.store.state.runHistory.bot_scout.find(run=>run.id===legacy.id),original);
  assert.deepEqual(item.accepted.checks,checks.map((check,index)=>({...check,callId:index===0?'new-inventory':'new-instructions'})));
  for(const check of item.accepted.checks){const before=records.find(record=>record.callId===checks.find(original=>original.id===check.id).callId),after=item.accepted.records.find(record=>record.callId===check.callId);assert.equal(after.requestDigest,before.requestDigest);assert.equal(after.tool,before.tool);}
});

test('a parent final recheck follows accepted nested teammate evidence down to the current child file',async t=>{
  const h=await fixture(t),fileCheck={id:'leaf-file',kind:'file_contains',path:'health.txt',value:'verified health'},leaf={id:'leaf_child',status:'completed',outcomeChecks:[fileCheck],workRecords:[],verification:{passed:true,checks:[{...fileCheck,passed:true}]}},middle={id:'middle_child',status:'completed',workRecords:[]};
  await writeWorkspace(h.store,'bot_nova',fileCheck.path,fileCheck.value);
  const nested=prepareDeliverable(middle,{botId:'bot_nova',expectedOutput:'A current verified health file.',callId:'nested-call'});recordDeliverableAttempt(middle,nested.id,leaf,{callId:'nested-call',tools:['workspace']});
  middle.delegationJobs=[{id:'nested-job',botId:'bot_nova',callId:'nested-call',status:'completed',childRunId:leaf.id,result:{botId:'bot_nova',runId:leaf.id,status:'completed',deliverable:{id:nested.id,status:'completed'}}}];
  middle.outcomeChecks=[teammate('nested-job')];middle.verification={passed:true,checks:middle.outcomeChecks.map(check=>({...check,passed:true}))};
  const outer=prepareDeliverable(h.run(),{botId:'bot_scout',expectedOutput:'The nested verified health result.',callId:'outer-call'});recordDeliverableAttempt(h.run(),outer.id,middle,{callId:'outer-call',tools:['delegation']});
  const originalLeaf=structuredClone(leaf),originalMiddle=structuredClone(middle);
  await NativeEngine.prototype.verifyRequiredDeliverables.call(h.engine,h.context);assert.equal(h.run().requiredDeliverables[0].status,'completed');
  await writeWorkspace(h.store,'bot_nova',fileCheck.path,'changed after the middle teammate finished');
  await NativeEngine.prototype.verifyRequiredDeliverables.call(h.engine,h.context);assert.equal(h.run().requiredDeliverables[0].status,'partial');assert.equal(h.run().requiredDeliverables[0].currentVerification.passed,false);
  assert.deepEqual(leaf,originalLeaf);assert.deepEqual(middle,originalMiddle);
});
