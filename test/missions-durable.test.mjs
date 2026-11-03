import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { ownerMissionContext } from '../lib/missions.mjs';
import { observeMissionFile } from '../lib/mission-waits.mjs';
import { currentMissionAttention } from '../lib/mission-attention.mjs';

const BOT = 'bot_atlas';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const answer = text => ({ text, toolCalls: [] });
const call = (id, name, args) => ({ id, name, arguments: args });
const tools = (...toolCalls) => ({ text: '', toolCalls });
async function until(predicate) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await delay(5); }
  throw new Error('Mission Engine fixture timed out.');
}
function missionContext(request) {
  const line = request.turnContext?.split('\n').find(value => value.startsWith('Mission context '));
  assert.ok(line, 'the Engine provides the exact owner/Mission identity');
  return JSON.parse(line.slice(line.indexOf('{')));
}
function requirement(context, id, checker) {
  return { id, text: context.goal, source: { ownerId: context.ownerMessageId, quote: context.goal }, checker };
}
function reviewResponse(request) {
  const data = JSON.parse(request.messages[1].content);
  return answer(JSON.stringify({ coveragePassed: true, requirements: data.contract.requirements.map(item => ({ id: item.id, passed: true, reason: 'Synthetic exact evidence acceptance.' })), reason: 'Synthetic independent acceptance.' }));
}
async function fixture(t, author, { reviewer = reviewResponse, maxTurns = 10, providers } = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'tupies-missions-durable-'));
  const store = await new Store(directory).init();
  await store.mutate(state => {
    state.connections.push({ id: 'fixture', type: 'openai', name: 'Synthetic provider', defaultModel: 'mission-model' });
    for (const bot of state.bots) Object.assign(bot, { connectionId: 'fixture', tools: ['workspace', 'delegation'], approvalPolicy: 'balanced' });
  });
  const requests = [], reviewRequests = [], engines = [];
  let turn = 0;
  const provider = providers || { async complete(connection, request) {
    if (request.messages[0]?.content?.includes('You independently assess an agent result')) { reviewRequests.push({ connection: structuredClone(connection), request }); return reviewer(request, reviewRequests.length); }
    requests.push(request); return author(request, ++turn);
  } };
  const engine = new NativeEngine(store, { maxTurns, runTimeout: 10000, retryDelay: 1, providers: provider }); engines.push(engine);
  await engine.recover();
  t.after(async () => { for (const item of engines) await item.close(); await store.queue; await fs.rm(directory, { recursive: true, force: true }); });
  const settled = async (botId = BOT) => { await until(() => store.state.runs[botId] && !isActive(store.state.runs[botId])); for (const task of engine.tasks.values()) await task; return store.state.runs[botId]; };
  const create = goal => engine.missions.create({ leadBotId: BOT, goal, clientMessageId: `mission_fixture_${Math.random().toString(36).slice(2)}` });
  return { directory, store, engine, engines, requests, reviewRequests, settled, create, provider };
}

test('real Mission timer frees its slot and wakes the same run exactly once',async t=>{
 let calls=0;
 const h=await fixture(t,(request,turn)=>{
  calls++;const context=missionContext(request);
  if(turn===1)return tools(call('criteria','mission_contract_set',{requirements:[requirement(context,'answer',{kind:'rubric',rubric:'Give the requested answer after the saved timer.',rubricVersion:'wait-v1'})]}));
  if(turn===2)return tools(call('wait_once','mission_wait',{kind:'timer',delayMs:30}));
  return answer('The saved timer completed; the same goal is answered.');
 });
 const created=await h.create('Wait for a saved timer, then give the requested answer.');
 await until(()=>h.store.state.runs[BOT]?.missionSuspended);const runId=h.store.state.runs[BOT].id;
 assert.equal(isActive(h.store.state.runs[BOT]),false);assert.equal(calls,2);
 await delay(40);await h.engine.tick();await h.settled();
 assert.equal(h.store.state.runs[BOT].id,runId);assert.equal(h.store.state.missions[created.mission.id].outcome,'achieved');assert.equal(calls,3);
 await h.engine.tick();assert.equal(calls,3);assert.equal(h.store.state.missions[created.mission.id].waitHistory.length,1);
});

test('Pause waits for the active provider boundary and Resume preserves the same run',async t=>{
 let held=false,release;
 const h=await fixture(t,(request,turn)=>{if(turn===1){held=true;return new Promise(resolve=>{release=resolve;});}return answer('A resumed partial response.');});
 const created=await h.create('Retain this work across an explicit owner pause.');await until(()=>held);
 const mission=h.store.state.missions[created.mission.id],runId=h.store.state.runs[BOT].id;
 await h.engine.missions.control(mission.id,{action:'pause',revision:mission.revision});assert.equal(mission.state,'pausing');
 release(tools(call('must_not_write','workspace_write',{path:'unstarted.md',content:'Not admitted.'})));
 await until(()=>mission.state==='paused');await until(()=>!h.engine.tasks.has(runId));
 const retained=mission.runtimeCheckpoints[runId].connectionSettings;assert.equal(retained.maxOutputTokens,null);await h.store.mutate(state=>{state.connections[0].maxOutputTokens=32768;state.connections[0].contextWindow=100000;});
 const originalInfer=h.engine.infer.bind(h.engine);h.engine.infer=(context,connection,...rest)=>{assert.equal(connection.maxOutputTokens,undefined);assert.equal(connection.contextWindow,undefined);return originalInfer(context,connection,...rest);};
 await assert.rejects(fs.readFile(path.join(h.directory,'workspaces',BOT,'unstarted.md')),{code:'ENOENT'});
 assert.equal(h.store.state.runs[BOT].missionSuspended,true);
 await h.engine.missions.control(mission.id,{action:'resume',revision:mission.revision});await h.settled();assert.equal(h.store.state.runs[BOT].id,runId);assert.notEqual(mission.outcome,'achieved');
});

test('a real checked child completes before the coordinator independent Mission acceptance',async t=>{
 let parent=0,child=0;
 const h=await fixture(t,request=>{
  if(request.messages[0].content.startsWith('You are Ops,')){
   child++;if(child===1)return tools(call('child_check','task_outcome_set',{checks:[{id:'file',kind:'file_exists',path:'checked-child.md'}]}));
   if(child===2)return tools(call('child_write','workspace_write',{path:'checked-child.md',content:'A real checked child output.'}));
   return answer('Created and checked the requested child file.');
  }
  parent++;const context=missionContext(request);
  if(parent===1)return tools(call('criteria','mission_contract_set',{requirements:[requirement(context,'team',{kind:'rubric',rubric:'The required teammate really creates and checks the requested file.',rubricVersion:'checked-child-v1'})]}));
  if(parent===2)return tools(call('child','delegate_task',{botId:'bot_nova',task:'Create checked-child.md and declare its actual file check.',expectedOutput:'A real checked file.'}));
  return answer('The required teammate created and verified the real file.');
 });
 const created=await h.create('Have the teammate create and independently check the requested file.');await h.settled();
 assert.equal(h.store.state.runs.bot_nova.status,'completed');assert.equal(h.store.state.runs[BOT].requiredDeliverables[0].status,'completed');
 assert.equal(h.store.state.missions[created.mission.id].outcome,'achieved',h.store.state.missions[created.mission.id].reason);assert.equal(h.reviewRequests.length,1);assert.equal(child,3);
});

test('durable timer survives restart without model polling or repeated write',async t=>{
 const h=await fixture(t,(request,turn)=>{
  const context=missionContext(request);
  if(turn===1)return tools(call('criteria','mission_contract_set',{requirements:[requirement(context,'file',{kind:'file_exists',path:'saved-before-wait.md'})]}));
  if(turn===2)return tools(call('write_once','workspace_write',{path:'saved-before-wait.md',content:'Retained across the timer and restart.'}));
  if(turn===3)return tools(call('bind_file','mission_submit_result',{requirementId:'file',callId:'write_once',path:'saved-before-wait.md'}));
  return tools(call('saved_timer','mission_wait',{kind:'timer',delayMs:1000}));
 });
 const created=await h.create('Save a file, wait durably, then complete without repeating effects.');await until(()=>h.store.state.runs[BOT]?.missionSuspended);await until(()=>!h.engine.tasks.size);
 const runId=h.store.state.runs[BOT].id,waitId=h.store.state.missions[created.mission.id].waitCondition.id;await h.engine.close();
 const reopened=await new Store(h.directory).init();let authorCalls=0;
 const recovered=new NativeEngine(reopened,{maxTurns:10,runTimeout:10000,providers:{async complete(_connection,request){if(request.messages[0].content.includes('You independently assess an agent result'))return reviewResponse(request);authorCalls++;assert.ok(request.messages.some(message=>message.tool_call_id==='write_once'));return answer('The exact retained file completes this goal.');}}});h.engines.push(recovered);
 await recovered.recover();await recovered.recoverAutonomous();assert.equal(authorCalls,0);assert.equal(reopened.state.missions[created.mission.id].waitCondition.id,waitId);
 await delay(1050);await recovered.tick();await until(()=>authorCalls>0&&!isActive(reopened.state.runs[BOT]));await Promise.all([...recovered.tasks.values()]);
 assert.equal(reopened.state.runs[BOT].id,runId);assert.equal(reopened.state.missions[created.mission.id].outcome,'achieved',reopened.state.missions[created.mission.id].reason);assert.equal(authorCalls,1);assert.equal(reopened.state.runs[BOT].workRecords.filter(record=>record.tool==='workspace_write').length,1);
});

test('file watch rechecks private permissions and never treats an unreadable source as changed',async t=>{
 const h=await fixture(t,()=>answer('An incomplete response.'));const started=await h.engine.start(BOT,'Keep the private fixture file available.');await h.settled();
 const root=path.join(h.directory,'workspaces',BOT);await fs.writeFile(path.join(root,'watched.md'),'original');
 let held,release;h.engine.providers.complete=async(_connection,request)=>{held=true;return new Promise(resolve=>{release=resolve;});};
 const created=await h.create('Watch a current private file without new permissions.');await until(()=>held);
 const mission=h.store.state.missions[created.mission.id];await assert.rejects(h.engine.missions.wait(mission.id,{kind:'file_change',path:'../outside'}),/canonical/);
 await h.engine.missions.wait(mission.id,{kind:'file_change',path:'watched.md',intervalMs:1000});release(answer('The wait is saved.'));await until(()=>h.store.state.runs[BOT].missionSuspended);await until(()=>!h.engine.tasks.size);
 await h.store.mutate(state=>{state.bots.find(bot=>bot.id===BOT).tools=[];});await delay(1020);await h.engine.tick();
 assert.equal(mission.waitCondition.kind,'attention');assert.match(mission.reason,/access|Files|read/i);assert.equal(mission.lastWake,undefined);
});

test('250ms scheduler ticks cannot postpone a one-second file observation forever',async t=>{
 const h=await fixture(t,(request,turn)=>{
  const context=missionContext(request);
  if(turn===1)return tools(call('criteria','mission_contract_set',{requirements:[requirement(context,'changed',{kind:'rubric',rubric:'Read and report the actually changed private file.',rubricVersion:'file-watch-v1'})]}));
  if(turn===2)return tools(call('watch','mission_wait',{kind:'file_change',path:'watched.md',intervalMs:1000}));
  if(turn===3)return tools(call('observe_changed','workspace_read',{path:'watched.md'}));
  assert.ok(request.messages.some(message=>message.role==='tool' && String(message.content).includes('changed by the owner')));return answer('The actual owner file now contains changed by the owner.');
 });
 const root=path.join(h.directory,'workspaces',BOT);await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'watched.md'),'original');
 const created=await h.create('Watch the exact private file and report its actual changed contents.');await until(()=>h.store.state.runs[BOT]?.missionSuspended);await until(()=>!h.engine.tasks.size);
 const mission=h.store.state.missions[created.mission.id],originalWake=mission.waitCondition.nextWakeAt;
 await delay(250);await h.engine.tick();assert.equal(mission.waitCondition.nextWakeAt,originalWake);
 await delay(250);await fs.writeFile(path.join(root,'watched.md'),'changed by the owner');await h.engine.tick();assert.equal(mission.waitCondition.nextWakeAt,originalWake);
 await delay(250);await h.engine.tick();assert.equal(mission.waitCondition.nextWakeAt,originalWake);
 await delay(300);await h.engine.tick();await h.settled();assert.equal(mission.outcome,'achieved',mission.reason);assert.equal(mission.waitHistory.length,1);assert.equal(mission.lastWake.cursor,1);
});

async function waitingTeam(t) {
 let parent=0,child=0,held=false,release;
 const h=await fixture(t,request=>{
  if(request.messages[0].content.startsWith('You are Ops,')){
   child++;if(child===1)return tools(call('child_check','task_outcome_set',{checks:[{id:'file',kind:'file_exists',path:'family-child.md'}]}));
   if(child===2)return tools(call('child_write','workspace_write',{path:'family-child.md',content:'Committed exactly once before the tree paused.'}));
   if(child===3){held=true;return new Promise(resolve=>{release=resolve;});}
   return answer('The retained child file still passes its actual check.');
  }
  parent++;const context=missionContext(request);
  if(parent===1)return tools(call('criteria','mission_contract_set',{requirements:[requirement(context,'team',{kind:'rubric',rubric:'The assigned teammate completes the actual checked file without another write.',rubricVersion:'family-v1'})]}));
  if(parent===2)return tools(call('queue_child','delegate_task',{botId:'bot_nova',task:'Create and mechanically check family-child.md.',expectedOutput:'The real checked file.',wait:false}));
  const ids=h.store.state.runs[BOT].delegationJobs.map(job=>job.id);
  if(parent===3)return tools(call('dependency_wait','mission_wait',{kind:'dependency',delegationIds:ids}));
  if(parent===4)return tools(call('collect_exact','delegation_status',{delegationIds:ids,wait:true,timeoutMs:30000}));
  return answer('The exact original teammate file and checks complete this goal.');
 });
 const created=await h.create('Wait durably for the teammate and preserve the checked child file.');await until(()=>held && h.store.state.runs[BOT]?.missionSuspended);await until(()=>!h.engine.tasks.has(h.store.state.runs[BOT].id));
 return {...h,mission:h.store.state.missions[created.mission.id],counts:()=>({parent,child}),release:()=>release(answer('The child response reached the requested pause boundary.'))};
}

test('dependency wake observes child completion under fast scheduler ticks without re-dispatch',async t=>{
 const h=await waitingTeam(t),mission=h.mission,childId=h.store.state.runs.bot_nova.id;
 await h.engine.tick();const due=mission.waitCondition.nextWakeAt;
 await delay(250);await h.engine.tick();assert.equal(mission.waitCondition.nextWakeAt,due);
 h.release();await until(()=>h.store.state.runs.bot_nova.status==='completed');
 await delay(250);await h.engine.tick();assert.equal(mission.waitCondition.nextWakeAt,due);
 await delay(550);await h.engine.tick();await h.settled();
 assert.equal(mission.outcome,'achieved',mission.reason);assert.equal(h.store.state.runs.bot_nova.id,childId);assert.equal(h.store.state.runs.bot_nova.workRecords.filter(record=>record.tool==='workspace_write').length,1);assert.equal(mission.waitHistory.length,1);
});

test('paused child tree survives restart and preflights every participant before any recovery call',async t=>{
 const h=await waitingTeam(t),mission=h.mission,rootId=h.store.state.runs[BOT].id,childId=h.store.state.runs.bot_nova.id;
 await h.engine.missions.control(mission.id,{action:'pause',revision:mission.revision});assert.equal(mission.state,'pausing');h.release();await until(()=>mission.state==='paused');await until(()=>!h.engine.tasks.size);await h.engine.close();
 const reopened=await new Store(h.directory).init();let calls=0;const provider=h.provider;const recovered=new NativeEngine(reopened,{maxTurns:10,runTimeout:10000,maxRuns:2,providers:{async complete(connection,request){calls++;return provider.complete(connection,request);}}});h.engines.push(recovered);
 await recovered.recover();await recovered.recoverAutonomous();assert.equal(calls,0);const saved=reopened.state.missions[mission.id];
 const nova=reopened.state.bots.find(bot=>bot.id==='bot_nova'),prior=structuredClone(nova.tools);await reopened.mutate(()=>{nova.tools=[];});
 await assert.rejects(recovered.missions.control(saved.id,{action:'resume',revision:saved.revision}),/participant|permission|provider|contract/i);assert.equal(calls,0);
 await reopened.mutate(()=>{nova.tools=prior;});await recovered.missions.control(saved.id,{action:'resume',revision:saved.revision});
 await until(()=>saved.state==='terminal');await Promise.all([...recovered.tasks.values()]);assert.equal(saved.outcome,'achieved',saved.reason);assert.equal(reopened.state.runs[BOT].id,rootId);assert.equal(reopened.state.runs.bot_nova.id,childId);assert.equal(reopened.state.runs.bot_nova.workRecords.filter(record=>record.tool==='workspace_write').length,1);
});

test('queued child permission changes during dispatch publication refuse every actual child call',async t=>{
 let parent=0,childCalls=0;
 const h=await fixture(t,request=>{if(request.messages[0].content.startsWith('You are Ops,')){childCalls++;return answer('This child must not start.');}parent++;const context=missionContext(request);if(parent===1)return tools(call('criteria','mission_contract_set',{requirements:[requirement(context,'team',{kind:'rubric',rubric:'The exact authorized child produces its checked result.',rubricVersion:'queue-race-v1'})]}));if(parent===2)return tools(call('queue','delegate_task',{botId:'bot_nova',task:'Create a checked child result.',expectedOutput:'A checked result.',wait:false}));if(parent===3)return tools(call('collect','delegation_status',{wait:true}));return answer('No checked child result is available.');});
 const event=h.engine.event.bind(h.engine);let changed=false;
 h.engine.event=async(context,type,data)=>{const result=await event(context,type,data);if(type==='delegation.started'&&!changed){changed=true;await h.store.mutate(state=>{state.bots.find(bot=>bot.id==='bot_nova').tools=['workspace','delegation','web'];});}return result;};
 const created=await h.create('Use only the currently authorized teammate snapshot.');await h.settled();assert.equal(changed,true);assert.equal(childCalls,0);assert.notEqual(h.store.state.missions[created.mission.id].outcome,'achieved');assert.equal(h.store.state.runs.bot_nova,undefined);
});

test('adding a compute cap to a saved watcher blocks the next read before dispatch',async t=>{
 let release,held=false;
 const h=await fixture(t,()=>{held=true;return new Promise(resolve=>{release=resolve;});});const root=path.join(h.directory,'workspaces',BOT);await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'compute-watch.md'),'original');
 const created=await h.create('Retain a private file wait within actual supported resource bounds.');await until(()=>held);const mission=h.store.state.missions[created.mission.id];
 await h.engine.missions.wait(mission.id,{kind:'file_change',path:'compute-watch.md',intervalMs:1000});release(answer('The condition is retained.'));await until(()=>h.store.state.runs[BOT].missionSuspended);await until(()=>!h.engine.tasks.size);
 const prior=Object.values(mission.resourceLedger.operations).filter(operation=>operation.kind==='file_watch').length;
 await h.engine.missions.control(mission.id,{action:'limits',revision:mission.revision,limits:{computeMs:100000}});await delay(1010);await h.engine.tick();
 const current=h.store.state.missions[mission.id];assert.equal(current.waitCondition.kind,'attention');assert.match(current.reason,/computeMs|bound/i);assert.equal(Object.values(current.resourceLedger.operations).filter(operation=>operation.kind==='file_watch').length,prior);assert.equal(current.lastWake,undefined);
});

test('child approvals remain reachable by the existing bot route and Pause invalidates the old identity',async t=>{
 let parent=0,child=0;
 const h=await fixture(t,request=>{
  if(request.messages[0].content.startsWith('You are Ops,')){child++;if(child===1)return tools(call('check','task_outcome_set',{checks:[{id:'file',kind:'file_exists',path:'approved-child.md'}]}));if(child===2||child===3)return tools(call(`write_${child}`,'workspace_write',{path:'approved-child.md',content:'Written after exact fresh owner approval.'}));return answer('The exact approved child file is checked.');}
  parent++;const context=missionContext(request);if(parent===1)return tools(call('criteria','mission_contract_set',{requirements:[requirement(context,'team',{kind:'rubric',rubric:'Require the checked file and exact owner approval.',rubricVersion:'approval-tree-v1'})]}));if(parent===2)return tools(call('queue','delegate_task',{botId:'bot_nova',task:'Create and mechanically check approved-child.md.',expectedOutput:'The exact owner-approved checked file.',wait:false}));const ids=h.store.state.runs[BOT].delegationJobs.map(job=>job.id);if(parent===3)return tools(call('wait','mission_wait',{kind:'dependency',delegationIds:ids}));if(parent===4)return tools(call('collect','delegation_status',{delegationIds:ids,wait:true}));return answer('The child created the actual checked file after owner approval.');
 });
 await h.store.mutate(state=>{state.bots.find(bot=>bot.id==='bot_nova').approvalPolicy='strict';});const created=await h.create('Have the teammate make the approved checked file.');await until(()=>h.store.state.runs.bot_nova?.status==='waiting_for_approval'&&h.store.state.runs[BOT]?.missionSuspended);
 const mission=h.store.state.missions[created.mission.id],old=h.store.state.runs.bot_nova,oldInput={runId:old.id,remoteRunId:old.remoteRunId,request_id:old.pending_controls[0].prompt_id,execution_generation:old.execution_generation,choice:'once'};
 await h.engine.missions.control(mission.id,{action:'pause',revision:mission.revision});await until(()=>mission.state==='paused');await until(()=>!h.engine.tasks.size);
 await assert.rejects(h.engine.control('bot_nova','approval',oldInput),error=>error.status===409);
 await h.engine.missions.control(mission.id,{action:'resume',revision:mission.revision});await until(()=>h.store.state.runs.bot_nova.status==='waiting_for_approval');
 const fresh=h.store.state.runs.bot_nova;assert.equal(fresh.id,oldInput.runId);assert.notEqual(fresh.pending_controls[0].prompt_id,oldInput.request_id);await assert.rejects(h.engine.control('bot_nova','approval',oldInput),error=>error.status===409);
 await h.engine.control('bot_nova','approval',{runId:fresh.id,remoteRunId:fresh.remoteRunId,request_id:fresh.pending_controls[0].prompt_id,execution_generation:fresh.execution_generation,choice:'once'});
 await until(()=>mission.state==='terminal');await Promise.all([...h.engine.tasks.values()]);assert.equal(mission.outcome,'achieved',mission.reason);assert.equal(h.store.state.runs.bot_nova.workRecords.filter(record=>record.tool==='workspace_write'&&record.status==='succeeded').length,1);
});


test('file observation repeats current Files permission after awaited reservation publication',async t=>{
 let held=false,release;const h=await fixture(t,(_request,turn)=>{if(turn>1)return answer('No unauthorized file read occurred.');held=true;return new Promise(resolve=>{release=resolve;});});const created=await h.create('Read only while exact current Files access remains enabled.');await until(()=>held);const mission=h.store.state.missions[created.mission.id],context=h.engine.contexts.get(h.store.state.runs[BOT].id);
 const mutate=h.store.mutate.bind(h.store);let revoked=false;h.store.mutate=async(callback,...rest)=>{const value=await mutate(callback,...rest);if(!revoked&&Object.values(h.store.state.missions[mission.id].resourceLedger.operations).some(operation=>operation.kind==='file_watch')){revoked=true;await mutate(state=>{state.bots.find(bot=>bot.id===BOT).tools=[];});}return value;};
 try{await assert.rejects(observeMissionFile(h.engine,context,'does-not-exist.md',{missionId:mission.id}),error=>error.status===403&&/Files/.test(error.message));assert.equal(revoked,true);const operation=Object.values(h.store.state.missions[mission.id].resourceLedger.operations).find(operation=>operation.kind==='file_watch');assert.equal(operation.status,'settled');assert.equal(operation.actual.computeMs,0);}finally{release(answer('No unauthorized file read occurred.'));}await h.settled();
});

test('shared absolute deadline expires a paused continuation without any resumed provider call',async t=>{
 let held=false,release;const h=await fixture(t,()=>{held=true;return new Promise(resolve=>{release=resolve;});});const created=await h.create('Pause without extending the absolute owner deadline.');await until(()=>held);const mission=h.store.state.missions[created.mission.id];await h.engine.missions.control(mission.id,{action:'pause',revision:mission.revision});release(answer('Paused work.'));await until(()=>mission.state==='paused');await until(()=>!h.engine.tasks.size);
 const deadline=Date.now()-1;await h.engine.missions.control(mission.id,{action:'limits',revision:mission.revision,limits:{deadlineAt:deadline}});await h.engine.missions.tickWaits();assert.equal(mission.outcome,'expired');assert.ok(currentMissionAttention(h.store.state,mission.id));assert.equal(mission.resourceLedger.limits.deadlineAt,deadline);assert.equal(h.requests.length,1);await assert.rejects(h.engine.missions.control(mission.id,{action:'resume',revision:mission.revision}),error=>error.status===409);
});

test('approval CAS refuses a Mission Stop committed before the child cancellation phase',async t=>{
 const h=await fixture(t,()=>tools(call('strict_write','workspace_write',{path:'must-not-exist.md',content:'Not authorized after Stop.'})));await h.store.mutate(state=>{state.bots.find(bot=>bot.id===BOT).approvalPolicy='strict';});const created=await h.create('Create a file only after exact current approval.');await until(()=>h.store.state.runs[BOT]?.status==='waiting_for_approval');const run=h.store.state.runs[BOT],mission=h.store.state.missions[created.mission.id],input={runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation,choice:'once'};
 await h.store.mutate(()=>{mission.stopRequested=true;});await assert.rejects(h.engine.control(BOT,'approval',input),error=>error.status===409);await h.engine.control(BOT,'stop',{runId:run.id,remoteRunId:run.remoteRunId});await h.settled();await assert.rejects(fs.readFile(path.join(h.directory,'workspaces',BOT,'must-not-exist.md')),{code:'ENOENT'});
});

test('serialized explicit Stop wins a previously observed paused deadline expiry',async t=>{
 let held=false,release;const h=await fixture(t,()=>{held=true;return new Promise(resolve=>{release=resolve;});});const created=await h.create('Stop wins before an expired paused Mission can publish a new outcome.');await until(()=>held);const mission=h.store.state.missions[created.mission.id];await h.engine.missions.control(mission.id,{action:'pause',revision:mission.revision});release(answer('Paused before cancellation.'));await until(()=>mission.state==='paused');await until(()=>!h.engine.tasks.size);await h.engine.missions.control(mission.id,{action:'limits',revision:mission.revision,limits:{deadlineAt:Date.now()-1}});
 const mutate=h.store.mutate.bind(h.store);let raced=false;h.store.mutate=async(callback,...rest)=>{if(!raced){raced=true;await h.engine.missions.control(mission.id,{action:'stop',revision:mission.revision});}return mutate(callback,...rest);};await h.engine.missions.tickWaits();assert.equal(raced,true);assert.equal(mission.outcome,'stopped');assert.equal(mission.expiryRequested,undefined);assert.equal(currentMissionAttention(h.store.state,mission.id),null);assert.equal(h.requests.length,1);
});

test('expired waiting Mission exposes owner limit change, goal revision and a fresh verified attempt without resetting usage',async t=>{
 const h=await fixture(t,(request,turn)=>{const context=missionContext(request);if(turn===1)return tools(call('criteria','mission_contract_set',{requirements:[requirement(context,'answer',{kind:'rubric',rubric:'Give the requested concrete answer in an owner-authorized attempt.',rubricVersion:'expiry-retry-v1'})]}));if(turn===2)return tools(call('long-wait','mission_wait',{kind:'timer',delayMs:60000}));return answer('The revised owner-requested concrete answer is complete.');});
 const created=await h.create('Retain this goal until its owner chooses a new verified attempt.');await until(()=>h.store.state.runs[BOT]?.missionSuspended);await until(()=>!h.engine.tasks.size);const mission=h.store.state.missions[created.mission.id],firstRun=h.store.state.runs[BOT].id;await h.engine.missions.control(mission.id,{action:'limits',revision:mission.revision,limits:{deadlineAt:Date.now()-1}});await h.engine.missions.tickWaits();assert.equal(mission.outcome,'expired');assert.equal(mission.waitCondition,null);assert.equal(mission.pauseRequested,false);assert.equal(h.engine.missions.view(mission.id,{detail:true}).canResume,false);assert.equal(mission.waitHistory.length,1);const used=mission.resourceLedger.operations,oldOperations=Object.keys(used),priorVersion=mission.contractVersion;
 await h.engine.missions.control(mission.id,{action:'limits',revision:mission.revision,limits:{toolCalls:100}});assert.deepEqual(Object.keys(mission.resourceLedger.operations),oldOperations);await h.engine.missions.control(mission.id,{action:'revise',revision:mission.revision,text:'Give the revised concrete answer.',requirements:['Give the revised concrete answer.']});await h.engine.missions.control(mission.id,{action:'retry',revision:mission.revision});await h.settled();assert.notEqual(h.store.state.runs[BOT].id,firstRun);assert.equal(mission.expiryRequested,false);assert.equal(mission.outcome,'achieved',mission.reason);assert.equal(mission.contractVersion,priorVersion+1);assert.ok(oldOperations.every(id=>mission.resourceLedger.operations[id]));assert.equal(mission.episodeRefs.length,2);
});
test('an active shared deadline aborts the provider and retains expired rather than success',async t=>{
 let held=false;const h=await fixture(t,request=>new Promise((_resolve,reject)=>{held=true;request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});}));const created=await h.create('Retain incomplete work when the absolute deadline expires.');await until(()=>held);const mission=h.store.state.missions[created.mission.id];await h.engine.missions.control(mission.id,{action:'limits',revision:mission.revision,limits:{deadlineAt:Date.now()-1}});await h.engine.missions.tickWaits();await h.settled();assert.equal(mission.outcome,'expired');assert.equal(mission.state,'terminal');assert.notEqual(h.store.state.runs[BOT].status,'completed');assert.equal(mission.waitCondition,null);assert.equal(h.requests.length,1);assert.equal(h.engine.tasks.size,0);
});

test('Retry cannot replace missing or uncertain retained child evidence with an empty current job list',async t=>{
 let held=false,release;const h=await fixture(t,()=>{held=true;return new Promise(resolve=>{release=resolve;});});const created=await h.create('Preserve unresolved retained child identity before any new attempt.');await until(()=>held);const mission=h.store.state.missions[created.mission.id];await h.engine.missions.control(mission.id,{action:'pause',revision:mission.revision});release(answer('Paused safe root.'));await until(()=>mission.state==='paused');await until(()=>!h.engine.tasks.size);const run=h.store.state.runs[BOT],saved=mission.runtimeCheckpoints[run.id],job={id:'retained_child_job',status:'suspended',childRunId:'retained_child_run',botId:'bot_nova'};await h.store.mutate(()=>{saved.run.delegationJobs=[job];run.delegationJobs=[];});await h.engine.missions.control(mission.id,{action:'stop',revision:mission.revision});
 for(const jobs of [[],[{...job,status:'cancelled',outcome:'unknown'}],[{...job,status:'completed',childRunId:'other_child_run'}]]){await h.store.mutate(state=>{state.runs[BOT].delegationJobs=jobs;});await assert.rejects(h.engine.missions.control(mission.id,{action:'retry',revision:mission.revision}),/saved child tree|unknown effects/i);}assert.equal(h.requests.length,1);
});
