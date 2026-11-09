import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { callFingerprint } from '../lib/work-quality.mjs';
import { DelegationJobs } from '../lib/delegation-jobs.mjs';
import { groupGuidance } from '../lib/tool-catalog.mjs';

const call=(id,name,args)=>({id,name,arguments:args});
const reply=text=>({text,toolCalls:[]});
const tools=(...toolCalls)=>({text:'',toolCalls});
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const waitFor=async(predicate,timeout=10000)=>{const until=Date.now()+timeout;while(Date.now()<until){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Timed out waiting for delegation-job fixture.');};
const worker=request=>request.messages[0].content.match(/^You are (Worker\d+),/)?.[1];
const parent=store=>store.state.runs.bot_atlas;

async function fixture(t,complete,{workers=10,...options}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-delegation-jobs-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{
    state.connections.push({id:'fixture',type:'openai',name:'Fixture',model:'fixture-model'});
    state.bots=[{...state.bots[0],connectionId:'fixture',tools:['workspace','memory','delegation'],approvalPolicy:'balanced'},...Array.from({length:workers},(_,i)=>({id:`worker_${i}`,name:`Worker${i}`,title:'Disposable checker',connectionId:'fixture',tools:['workspace','memory','delegation'],approvalPolicy:'balanced',enabled:true,skills:[]}))];
  });
  const engine=new NativeEngine(store,{runTimeout:15000,providers:{async complete(_connection,request){requests.push(request);return complete(request);}},...options});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,store,engine,requests};
}

test('twelve independent jobs enqueue across model turns before collection and run within the global concurrency limit',async t=>{
  const gates=Array.from({length:12},gate),started=[],finished=[];let turns=0,active=0,peak=0,collected;
  const {store,engine,requests}=await fixture(t,async request=>{
    const name=worker(request);
    if(name){const index=Number(name.slice(6));started.push(index);active++;peak=Math.max(peak,active);try{await gates[index].promise;finished.push(index);return reply(`Checked worker ${index}; limitations retained.`);}finally{active--;}}
    turns++;
    if(turns<=2){const begin=turns===1?0:8,end=turns===1?8:12;return tools(...Array.from({length:end-begin},(_,i)=>call(`dispatch-${begin+i}`,'delegate_task',{botId:`worker_${begin+i}`,task:'Report current health and what cannot be checked.',wait:false})));}
    if(turns===3)return tools(call('collect','delegation_status',{wait:true}));
    collected=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);return reply('All twelve real replies were collected, including their limitations.');
  },{workers:12});
  const run=await engine.start('bot_atlas','Ask all twelve independent teammates, then collect their actual results.');
  await waitFor(()=>parent(store)?.delegationJobs?.length===12 && started.length===3 && parent(store).status==='waiting_for_delegate');
  assert.equal(finished.length,0);assert.equal(parent(store).delegationJobs.filter(job=>job.status==='queued').length,9);
  assert.equal(Object.values(store.state.runs).filter(isActive).length,4);
  gates[1].resolve();await waitFor(()=>started.length===4);assert.ok(!finished.includes(0));
  for(const item of gates)item.resolve();await waitFor(()=>parent(store)?.status==='completed');await engine.tasks.get(run.id);
  assert.equal(peak,3);assert.equal(collected.pending,0);assert.equal(collected.jobs.length,12);assert.ok(collected.jobs.every(job=>job.status==='completed' && job.result.status==='completed' && job.result.output.includes('limitations')));
  assert.equal(new Set(parent(store).delegationJobs.map(job=>job.id)).size,12);
  const acknowledgements=requests.filter(request=>!worker(request)).flatMap(request=>request.messages.filter(message=>message.role==='tool' && message.tool_call_id?.startsWith('dispatch-')).map(message=>JSON.parse(message.content)));
  assert.ok(acknowledgements.every(ack=>ack.accepted===true && ack.completed===false && ack.status==='queued' && !ack.runId));
  // Collaboration protocol arrives with the team group, which the system prompt names.
  assert.match(requests[0].messages[0].content,/load the team group/);assert.match(groupGuidance('team',new Set(['delegate_task','delegation_status'])),/enqueue every request with wait:false before collecting/);
});

test('failed children retain their actual failure while successful sibling replies remain collectable',async t=>{
  let turns=0,collected;
  const {store,engine}=await fixture(t,async request=>{
    const name=worker(request);if(name==='Worker0')throw new Error('Disposable checker cannot access its required source.');if(name)return reply('The second checker replied with explicit caveats.');
    if(++turns===1)return tools(call('a','delegate_task',{botId:'worker_0',task:'Report health.',wait:false}),call('b','delegate_task',{botId:'worker_1',task:'Report health.',wait:false}));
    if(turns===2)return tools(call('collect','delegation_status',{wait:true}));
    collected=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);return reply('One checker failed; the other replied.');
  },{workers:2});
  await engine.start('bot_atlas','Collect independent checker results.');await waitFor(()=>parent(store)?.status==='completed');
  assert.equal(collected.jobs[0].status,'failed');assert.equal(collected.jobs[0].result.status,'failed');assert.match(collected.jobs[0].result.error,/cannot access/);
  assert.equal(collected.jobs[1].status,'completed');assert.match(collected.jobs[1].result.output,/caveats/);
});

test('required asynchronous work keeps its original partial result and closes only through a verified same-teammate repair',async t=>{
  let turns=0,childTurns=0,firstJobId;
  const expected='Create a verified report containing the exact acceptance marker.';
  const {engine,store}=await fixture(t,async request=>{
    if(worker(request)) {
      childTurns++;
      if(childTurns===1)return reply('A partial report without a created or verified file.');
      if(childTurns===2)return tools(call('write-report','workspace_write',{path:'report.txt',content:'acceptance marker'}),call('declare-report','task_outcome_set',{checks:[{id:'report-content',kind:'file_contains',path:'report.txt',value:'acceptance marker'}]}));
      return reply('The original report now exists and its file check passes.');
    }
    turns++;
    if(turns===1)return tools(call('dispatch-original','delegate_task',{botId:'worker_0',task:'Create the original report.',expectedOutput:expected,wait:false}));
    if(turns===2){const ack=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);firstJobId=ack.delegationId;assert.equal(ack.deliverable.status,'pending');return tools(call('collect-original','delegation_status',{wait:true}));}
    if(turns===3){const first=JSON.parse(request.messages.findLast(message=>message.role==='tool').content).jobs[0];assert.equal(first.result.deliverable.status,'partial');return tools(call('require-job','task_outcome_set',{checks:[{id:'original-job',kind:'teammate_completed',delegationId:firstJobId}]}),call('repair','delegate_task',{botId:'worker_0',deliverableId:first.result.deliverable.id,task:'Create and verify the missing report using retained evidence.',expectedOutput:'Reworded correction must not replace the original.',wait:false}));}
    if(turns===4)return tools(call('collect-repair','delegation_status',{wait:true}));
    return reply('The original required report was repaired and actually verified.');
  },{workers:1});
  await engine.start('bot_atlas','Obtain the concrete verified report.');await waitFor(()=>parent(store)?.status==='completed');
  const requirement=parent(store).requiredDeliverables[0];assert.equal(requirement.expected,expected);assert.equal(requirement.status,'completed');assert.equal(requirement.attempts.length,2);assert.deepEqual(requirement.attempts.map(attempt=>attempt.status),['partial','completed']);
  assert.equal(parent(store).delegationJobs[0].result.deliverable.status,'partial');assert.equal(parent(store).delegationJobs[1].result.deliverable.status,'completed');assert.equal(parent(store).verification.passed,true);
});

test('queued required work records the actual child admission capabilities after an owner configuration change',async t=>{
  const blocker=gate();let turns=0,childTurns=0;
  const {engine,store}=await fixture(t,async request=>{
    const name=worker(request);
    if(name==='Worker0'){await blocker.promise;return reply('The slot is free now.');}
    if(name==='Worker1'){if(++childTurns===1)return tools(call('write','workspace_write',{path:'verified.txt',content:'verified'}),call('check','task_outcome_set',{checks:[{id:'file',kind:'file_exists',path:'verified.txt'}]}));return reply('Created and verified the file with my admitted tools.');}
    if(++turns===1)return tools(call('blocker','delegate_task',{botId:'worker_0',task:'Occupy the available child slot.',wait:false}),call('required','delegate_task',{botId:'worker_1',task:'Create a verified file.',expectedOutput:'A mechanically verified file.',wait:false}));
    if(turns===2)return tools(call('collect','delegation_status',{wait:true}));
    return reply('The actual admitted capability snapshot was verified.');
  },{workers:2,maxRuns:2});
  await store.mutate(state=>{state.bots.find(bot=>bot.id==='worker_1').tools=['memory'];});
  await engine.start('bot_atlas','Ask both independent teammates.');await waitFor(()=>parent(store)?.delegationJobs?.length===2 && store.state.runs.worker_0?.status==='running');
  await store.mutate(state=>{state.bots=state.bots.map(bot=>bot.id==='worker_1'?{...bot,tools:['workspace']}:bot);});blocker.resolve();
  await waitFor(()=>parent(store)?.status==='completed');assert.deepEqual(parent(store).requiredDeliverables[0].accepted.tools,['workspace']);
});

test('premature parent completion waits for children and requires collection before a final answer',async t=>{
  const blocked=gate();let turns=0;
  const {engine,store}=await fixture(t,async request=>{
    if(worker(request)){await blocked.promise;return reply('A real delayed reply.');}
    if(++turns===1)return tools(call('dispatch','delegate_task',{botId:'worker_0',task:'Give a delayed report.',wait:false}));
    if(turns===2)return reply('I claim this finished too early.');
    if(turns===3){assert.ok(request.messages.some(message=>message.role==='user' && message.content.includes('uncollected')===false && message.content.includes('actual outcomes are collected')));return tools(call('collect','delegation_status',{}));}
    return reply('I collected the actual completed report.');
  },{workers:1});
  await engine.start('bot_atlas','Wait for and collect the report.');await waitFor(()=>parent(store)?.status==='waiting_for_delegate');
  assert.notEqual(parent(store).status,'completed');assert.equal(turns,2);blocked.resolve();
  await waitFor(()=>parent(store)?.status==='completed');assert.equal(turns,4);assert.equal(parent(store).delegationJobs[0].observed,true);
});

test('Stop cancels every queued job and drains active children before the parent becomes terminal',async t=>{
  const drain=gate(),started=[],aborted=[];let turns=0;
  const {engine,store}=await fixture(t,async request=>{
    const name=worker(request);
    if(name){started.push(name);await new Promise(resolve=>{request.signal.addEventListener('abort',()=>{aborted.push(name);resolve();},{once:true});});await drain.promise;throw request.signal.reason;}
    if(++turns===1)return tools(...Array.from({length:6},(_,i)=>call(`dispatch-${i}`,'delegate_task',{botId:`worker_${i}`,task:'Run until stopped.',wait:false})));
    return tools(call('collect','delegation_status',{wait:true}));
  },{workers:6});
  const run=await engine.start('bot_atlas','Start independent checks.');await waitFor(()=>started.length===3 && parent(store).status==='waiting_for_delegate' && parent(store).delegationJobs.length===6);
  await engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});await waitFor(()=>aborted.length===3);
  assert.equal(parent(store).status,'stopping');assert.equal(isActive(parent(store)),true);drain.resolve();
  await waitFor(()=>parent(store)?.status==='cancelled');await engine.tasks.get(run.id);
  assert.equal(started.length,3);assert.equal(parent(store).delegationJobs.length,6);assert.ok(parent(store).delegationJobs.every(job=>job.status==='cancelled'));
  assert.ok(parent(store).delegationJobs.filter(job=>!job.childRunId).every(job=>job.outcome==='not_started'));
  assert.ok(Object.values(store.state.runs).every(run=>!isActive(run)));
});

test('shared delegation budgets are reserved atomically before queue admission',async t=>{
  const blocked=gate();let context;
  const {engine,store}=await fixture(t,async()=>{await blocked.promise;return reply('Finished after reservation checks.');},{workers:2,maxDelegations:1});
  const instructions=engine.instructions.bind(engine);engine.instructions=(bot,current)=>{context=current;return instructions(bot,current);};
  const run=await engine.start('bot_atlas','Keep this task open during concurrent queue admission.');await waitFor(()=>context);
  const admitted=await Promise.allSettled([engine.delegate(context,'worker_0','First independent check.','','','first',false),engine.delegate(context,'worker_1','Second independent check.','','','second',false)]);
  assert.equal(admitted.filter(result=>result.status==='fulfilled').length,1);assert.equal(admitted.filter(result=>result.status==='rejected').length,1);assert.match(admitted.find(result=>result.status==='rejected').reason.message,/delegation budget/);
  assert.equal(context.delegation.budget.used,1);assert.equal(parent(store).delegationJobs.length,1);
  await engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});blocked.resolve();await waitFor(()=>parent(store).status==='cancelled');
});

test('status refuses another parent job ID and validates bounded wait arguments',async t=>{
  let turns=0,toolsSeen;
  const {engine,store}=await fixture(t,async request=>{
    if(++turns===1)return tools(call('foreign','delegation_status',{delegationIds:['delegation_other_parent']}),call('invalid-wait','delegation_status',{timeoutMs:30001}),call('invalid-type','delegate_task',{botId:'worker_0',task:'Report health.',wait:'false'}));
    toolsSeen=request.messages.filter(message=>message.role==='tool');return reply('Invalid requests were refused without starting children.');
  },{workers:1});
  await engine.start('bot_atlas','Validate job scope.');await waitFor(()=>parent(store)?.status==='completed');
  assert.ok(toolsSeen.every(message=>message.is_error));assert.match(toolsSeen[0].content,/current task/);assert.match(toolsSeen[1].content,/30000/);assert.match(toolsSeen[2].content,/wait must/);assert.equal(store.state.runs.worker_0,undefined);
});

test('a synchronous duplicate cannot bypass a queued job and repeated asynchronous requests reuse their admitted identity',async t=>{
  const blocked=gate(),args={botId:'worker_0',task:'Run this exact health question once.',wait:false};let turns=0,childCalls=0,firstId;
  const {engine,store}=await fixture(t,async request=>{
    if(worker(request)){childCalls++;await blocked.promise;return reply('The only actual child reply.');}
    if(++turns===1)return tools(call('async','delegate_task',args),call('sync-bypass','delegate_task',{...args,wait:true}));
    if(turns===2){const messages=request.messages.filter(message=>message.role==='tool');firstId=JSON.parse(messages[0].content).delegationId;assert.equal(messages[1].is_error,true);assert.match(messages[1].content,/queued or running/);return tools(call('repeat-async','delegate_task',args),call('collect','delegation_status',{wait:true}));}
    const repeated=JSON.parse(request.messages.find(message=>message.tool_call_id==='repeat-async').content);assert.equal(repeated.delegationId,firstId);assert.equal(repeated.alreadyAdmitted,true);return reply('One actual dispatch, with the duplicate acknowledged safely.');
  },{workers:1});
  await engine.start('bot_atlas','Run the independent checker once.');await waitFor(()=>parent(store)?.status==='waiting_for_delegate' && childCalls===1);blocked.resolve();await waitFor(()=>parent(store)?.status==='completed');
  assert.equal(childCalls,1);assert.equal(parent(store).delegationJobs.length,1);
});

test('status polls ignore old recovered mutation caches and never become retained completed effects',async t=>{
  let context,turns=0;
  const statusCall=call('collect','delegation_status',{wait:true}),fingerprint=callFingerprint(statusCall);
  const {engine,store}=await fixture(t,async request=>{
    if(worker(request))return reply('The fresh actual child result.');
    if(++turns===1)return tools(call('dispatch','delegate_task',{botId:'worker_0',task:'Give the actual result.',wait:false}));
    if(turns===2){context.resumedEffects=new Map([[fingerprint,{output:{alreadyCompleted:true,jobs:[],notice:'A stale old poll.'}}]]);return tools(statusCall);}
    const result=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);assert.equal(result.jobs.length,1);assert.match(result.jobs[0].result.output,/fresh actual/);assert.equal(result.alreadyCompleted,undefined);return reply('Collected the fresh current-parent outcome.');
  },{workers:1});
  const instructions=engine.instructions.bind(engine);engine.instructions=(bot,current)=>{if(bot.id==='bot_atlas')context=current;return instructions(bot,current);};
  await engine.start('bot_atlas','Collect the current job.');await waitFor(()=>parent(store)?.status==='completed');assert.equal(context.completedEffects.has(fingerprint),false);
});

test('a bounded wait returns pending status without treating admission as a completed result',async t=>{
  const blocked=gate();let turns=0;
  const {engine,store}=await fixture(t,async request=>{
    if(worker(request)){await blocked.promise;return reply('The child eventually completed.');}
    if(++turns===1)return tools(call('dispatch','delegate_task',{botId:'worker_0',task:'Reply after the test gate.',wait:false}));
    if(turns===2)return tools(call('short-wait','delegation_status',{wait:true,timeoutMs:1}));
    if(turns===3){const result=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);assert.equal(result.pending,1);assert.equal(result.completed,0);assert.ok(['queued','running'].includes(result.jobs[0].status));assert.equal(result.jobs[0].result,undefined);blocked.resolve();return tools(call('collect','delegation_status',{wait:true,timeoutMs:2000}));}
    return reply('Collected the actual later reply.');
  },{workers:1});
  await engine.start('bot_atlas','Use a bounded wait for the checker.');await waitFor(()=>parent(store)?.status==='completed');assert.equal(parent(store).delegationJobs[0].status,'completed');
});

test('graceful engine shutdown retains interrupted job evidence and disables automatic request replay',async t=>{
  let turns=0,childStarted=false;
  const {engine,store}=await fixture(t,async request=>{
    if(worker(request)){childStarted=true;return new Promise((_,reject)=>{request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});});}
    if(++turns===1)return tools(call('first','delegate_task',{botId:'worker_0',task:'Stay active until shutdown.',wait:false}),call('queued','delegate_task',{botId:'worker_1',task:'Remain queued until shutdown.',wait:false}));
    return tools(call('collect','delegation_status',{wait:true}));
  },{workers:2,maxRuns:2});
  await engine.start('bot_atlas','Start two independent checks.');await waitFor(()=>childStarted && parent(store)?.delegationJobs?.length===2 && parent(store).status==='waiting_for_delegate');
  await engine.close();assert.equal(parent(store).status,'interrupted');assert.ok(parent(store).delegationJobs.every(job=>job.status==='interrupted'));
  assert.equal(store.state.taskCheckpoints.bot_atlas.automatic,false);assert.equal(engine.delegationJobs.entries.size,0);assert.equal(engine.delegationJobs.parents.size,0);
  let replayed=0;const replacement=new NativeEngine(store,{providers:{async complete(){replayed++;return reply('Must not execute.');}}});t.after(()=>replacement.close());await replacement.recover();await replacement.recoverAutonomous();assert.equal(replayed,0);
});

test('restart interrupts persisted queued and active jobs without replay or automatic parent recovery',async t=>{
  let providerCalls=0;
  const {engine,store}=await fixture(t,async()=>{providerCalls++;return reply('No replay.');},{workers:2});
  await store.mutate(state=>{
    state.runs.bot_atlas={id:'old-parent',botId:'bot_atlas',source:'chat',status:'waiting_for_delegate',createdAt:new Date().toISOString(),delegationJobs:[{id:'queued-job',botId:'worker_0',callId:'queued',status:'queued'},{id:'active-job',botId:'worker_1',callId:'active',status:'running',childRunId:'old-child'}]};
    state.taskCheckpoints={bot_atlas:{schemaVersion:2,automatic:true,runId:'old-parent',status:'running'}};
  });
  await engine.recover();await engine.recoverAutonomous();
  assert.equal(providerCalls,0);assert.ok(parent(store).delegationJobs.every(job=>job.status==='interrupted'));assert.equal(parent(store).delegationJobs[0].outcome,'not_started');assert.equal(parent(store).delegationJobs[1].outcome,'unknown');
  assert.equal(store.state.taskCheckpoints.bot_atlas.automatic,false);assert.match(store.state.taskCheckpoints.bot_atlas.blocked,/interrupted/);
});

test('nested coordinators blocked by full waiting capacity return an actionable undispatched failure instead of deadlock',async t=>{
  const turnCounts=new Map(),allChildren=gate();let nestedStarted=0,initialChildren=0;
  const {engine,store}=await fixture(t,async request=>{
    const name=worker(request) || 'parent',turn=(turnCounts.get(name) || 0)+1;turnCounts.set(name,turn);
    if(name==='Worker3'){nestedStarted++;return reply('A nested checker finished.');}
    if(name==='parent' && turn===1)return tools(...[0,1,2].map(i=>call(`root-${i}`,'delegate_task',{botId:`worker_${i}`,task:'Ask Worker3 independently, then report.',wait:false})));
    if(name!=='parent' && turn===1){if(++initialChildren===3)allChildren.resolve();await allChildren.promise;return tools(call(`nested-${name}`,'delegate_task',{botId:'worker_3',task:'A nested independent health question.',wait:false}));}
    if(turn===2)return tools(call(`collect-${name}`,'delegation_status',{wait:true,timeoutMs:1000}));
    const job=JSON.parse(request.messages.findLast(message=>message.role==='tool')?.content || '{}');
    if(job.pending)return tools(call(`wait-${name}-${turn}`,'delegation_status',{wait:true,timeoutMs:1000}));
    return reply('Actual nested outcomes, including capacity refusals, were collected.');
  },{workers:4});
  await engine.start('bot_atlas','Run independent nested checks.');await waitFor(()=>parent(store)?.status==='completed');
  const jobs=[0,1,2].flatMap(i=>store.state.runs[`worker_${i}`].delegationJobs || []);
  assert.ok(jobs.some(job=>job.errorCode==='concurrency_blocked' && job.outcome==='not_started'),JSON.stringify(jobs));
  assert.ok(jobs.every(job=>!['queued','running'].includes(job.status)));assert.ok(nestedStarted<3);
});

test('two owner tasks waiting on each other break one undispatched dependency edge despite spare global capacity',async t=>{
  const bothOwners=gate(),turnCounts=new Map(),collected=[];let ownerStarts=0,deferredChildren=0;
  const {engine,store}=await fixture(t,async request=>{
    const botId=worker(request)?'worker_0':'bot_atlas',run=store.state.runs[botId];
    if(run.source==='delegation'){deferredChildren++;return reply('The deferred child replied after the other owner task completed.');}
    const turn=(turnCounts.get(botId) || 0)+1;turnCounts.set(botId,turn);
    if(turn===1){if(++ownerStarts===2)bothOwners.resolve();await bothOwners.promise;return tools(call(`ask-${botId}`,'delegate_task',{botId:botId==='bot_atlas'?'worker_0':'bot_atlas',task:'Answer this independent question when free.',wait:false}));}
    if(turn===2)return tools(call(`wait-${botId}`,'delegation_status',{wait:true,timeoutMs:2000}));
    const result=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);
    if(result.pending)return tools(call(`continue-${botId}-${turn}`,'delegation_status',{wait:true,timeoutMs:2000}));
    collected.push(...result.jobs);return reply('Collected the real result, including any dependency refusal.');
  },{workers:1,maxRuns:4});
  const first=await engine.start('bot_atlas','Ask the other active owner bot.'),second=await engine.start('worker_0','Ask the other active owner bot.');
  await waitFor(()=>!engine.tasks.has(first.id) && !engine.tasks.has(second.id));
  assert.equal(deferredChildren,1);assert.equal(collected.length,2);
  assert.equal(collected.filter(job=>job.reason==='dependency_cycle' && job.errorCode==='concurrency_blocked' && job.outcome==='not_started').length,1);
  assert.equal(collected.filter(job=>job.status==='completed').length,1);assert.equal(engine.delegationJobs.entries.size,0);assert.equal(engine.delegationJobs.waiting.size,0);
});

test('two sibling coordinators queued on each other break their dependency cycle while another task slot is free',async t=>{
  const bothSiblings=gate(),turnCounts=new Map(),collected=[];let siblingStarts=0,deferredChildren=0;
  const {engine,store}=await fixture(t,async request=>{
    const name=worker(request) || 'parent',botId=name==='parent'?'bot_atlas':`worker_${name.slice(6)}`,run=store.state.runs[botId];
    if(run.delegation?.depth===2){deferredChildren++;return reply('The peer became available and this real nested child replied.');}
    const turn=(turnCounts.get(run.id) || 0)+1;turnCounts.set(run.id,turn);
    if(name==='parent' && turn===1)return tools(...[0,1].map(i=>call(`dispatch-${i}`,'delegate_task',{botId:`worker_${i}`,task:'Ask the other sibling a question, then collect its outcome.',wait:false})));
    if(name!=='parent' && turn===1){if(++siblingStarts===2)bothSiblings.resolve();await bothSiblings.promise;return tools(call(`ask-${name}`,'delegate_task',{botId:botId==='worker_0'?'worker_1':'worker_0',task:'Give this sibling your independent view when free.',wait:false}));}
    if(turn===2)return tools(call(`wait-${name}`,'delegation_status',{wait:true,timeoutMs:2000}));
    const result=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);
    if(result.pending)return tools(call(`continue-${name}-${turn}`,'delegation_status',{wait:true,timeoutMs:2000}));
    if(name!=='parent')collected.push(...result.jobs);return reply('Collected the actual teammate outcomes.');
  },{workers:2,maxRuns:4});
  const run=await engine.start('bot_atlas','Run two independent coordinators.');await engine.tasks.get(run.id);
  assert.equal(parent(store).status,'completed');assert.equal(deferredChildren,1);assert.equal(collected.length,2);
  assert.equal(collected.filter(job=>job.reason==='dependency_cycle' && job.outcome==='not_started').length,1);
  assert.equal(collected.filter(job=>job.status==='completed').length,1);assert.ok(parent(store).delegationJobs.every(job=>job.status==='completed'));
});

test('a queued request to an unrelated active owner bot remains pending and runs when that owner task finishes',async t=>{
  const ownerGate=gate();let turns=0,ownerStarted=false,children=0;
  const {engine,store}=await fixture(t,async request=>{
    if(worker(request)) {
      if(store.state.runs.worker_0.source==='delegation'){children++;return reply('A real deferred child reply after the unrelated owner task.');}
      ownerStarted=true;await ownerGate.promise;return reply('The unrelated owner task finished normally.');
    }
    if(++turns===1)return tools(call('dispatch','delegate_task',{botId:'worker_0',task:'Reply when your unrelated owner work is finished.',wait:false}));
    if(turns===2)return tools(call('short-poll','delegation_status',{wait:true,timeoutMs:100}));
    const result=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);
    if(result.pending)return tools(call(`continue-${turns}`,'delegation_status',{wait:true,timeoutMs:2000}));
    return reply('Collected the actual later reply.');
  },{workers:1,maxRuns:4});
  const busy=await engine.start('worker_0','Finish unrelated owner work.');await waitFor(()=>ownerStarted);
  const coordinator=await engine.start('bot_atlas','Ask the busy teammate when free.');await waitFor(()=>turns>=3 && parent(store).status==='waiting_for_delegate');
  assert.equal(parent(store).delegationJobs[0].status,'queued');assert.equal(parent(store).delegationJobs[0].error,undefined);assert.equal(children,0);assert.equal(store.state.runs.worker_0.id,busy.id);
  ownerGate.resolve();await engine.tasks.get(coordinator.id);assert.equal(parent(store).status,'completed');assert.equal(children,1);assert.equal(parent(store).delegationJobs[0].status,'completed');assert.equal(parent(store).delegationJobs[0].reason,undefined);
});

test('identical bounded waits preserve genuine pending work while unchanged terminal and invalid polls still trigger no-progress',async t=>{
  const childStarted=gate(),childFinish=gate(),pendingOutputs=[];let phase=1,turns=0,childCalls=0;
  const {engine,store}=await fixture(t,async request=>{
    if(worker(request)){childCalls++;childStarted.resolve();await childFinish.promise;return reply('The genuinely active child finished after repeated bounded waits.');}
    turns++;
    if(phase!==1)return tools(call(`poll-${phase}-${turns}`,'delegation_status',{wait:true,timeoutMs:phase===2?5:30001}));
    if(turns===1)return tools(call('dispatch','delegate_task',{botId:'worker_0',task:'Keep working while the parent uses bounded status waits.',wait:false}));
    await childStarted.promise;
    if(turns>=3 && turns<=8) {
      const result=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);assert.equal(result.pending,1);assert.equal(result.jobs[0].status,'running');assert.equal(store.state.runs.worker_0.status,'running');pendingOutputs.push(JSON.stringify(result));
    }
    if(turns<=7)return tools(call(`wait-${turns}`,'delegation_status',{wait:true,timeoutMs:5}));
    if(turns===8){assert.equal(pendingOutputs.length,6);assert.equal(new Set(pendingOutputs).size,1);childFinish.resolve();return tools(call('collect-final','delegation_status',{wait:true,timeoutMs:2000}));}
    const result=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);assert.equal(result.pending,0);assert.equal(result.jobs[0].status,'completed');return reply('Collected the real child result after six unchanged pending waits.');
  },{workers:1});
  const real=await engine.start('bot_atlas','Wait for the actual long-running teammate.');await engine.tasks.get(real.id);
  assert.equal(parent(store).status,'completed');assert.equal(childCalls,1);assert.equal(pendingOutputs.length,6);assert.equal(store.state.runs.worker_0.status,'completed');
  for(const nextPhase of [2,3]) {
    phase=nextPhase;turns=0;const stalled=await engine.start('bot_atlas',nextPhase===2?'Repeat an unchanged terminal poll.':'Repeat an unchanged invalid poll.');await engine.tasks.get(stalled.id);
    assert.equal(parent(store).status,'failed');assert.match(parent(store).error,/made no progress/);assert.ok(turns>=4);assert.equal(childCalls,1);
  }
});

test('queue pump records not_started when an undispatched entry is already cancelled',async t=>{
 let turns=0;const {engine,store}=await fixture(t,async request=>{assert.equal(worker(request),undefined);if(++turns===1)return tools(call('held-queue','delegate_task',{botId:'worker_0',task:'Never dispatch this cancelled request.',wait:false}));if(turns===2)return tools(call('collect-cancelled','delegation_status',{wait:true}));return reply('The cancelled request was not started.');},{workers:1});
 engine.delegationJobs.schedule=()=>{};const run=await engine.start('bot_atlas','Collect a cancelled queued request.');await waitFor(()=>parent(store)?.status==='waiting_for_delegate'&&engine.delegationJobs.entries.size===1);const entry=[...engine.delegationJobs.entries.values()][0];assert.equal(entry.started,false);entry.controller.abort(new Error('Synthetic queued cancellation.'));await engine.delegationJobs.pump();await waitFor(()=>parent(store)?.status==='completed');await engine.tasks.get(run.id);const job=parent(store).delegationJobs[0];assert.equal(job.status,'cancelled');assert.equal(job.outcome,'not_started');assert.equal(job.childRunId,undefined);assert.equal(store.state.runs.worker_0,undefined);
});

test('cancelled restored queue retains prior child identity as unknown rather than not_started',async()=>{
 const context={runId:'parent_retained',bot:{id:'bot_parent'},controller:new AbortController()},job={id:'job_retained',botId:'bot_child',childRunId:'child_original',status:'suspended'},run={id:context.runId,status:'running',delegationJobs:[job]},state={runs:{bot_parent:run},missions:{}},engine={closing:false,current:()=>run,starting:new Set(),options:{maxRuns:4},store:{state,redactValue:structuredClone,async mutate(fn){return fn(state);}}},queue=new DelegationJobs(engine),controller=new AbortController();controller.abort();queue.schedule=()=>{};queue.entries.set(job.id,{context,prepared:{botId:'bot_child',resumeChildRunId:'child_original'},controller,started:false,resolve(){}});await queue.pump();assert.equal(job.status,'cancelled');assert.equal(job.outcome,'unknown');assert.equal(job.childRunId,'child_original');assert.equal(queue.entries.size,0);
});
