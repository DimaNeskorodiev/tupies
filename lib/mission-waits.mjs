import { createHash } from 'node:crypto';
import path from 'node:path';
import { ensure, id, now } from './store.mjs';
import { groupsFor, readWorkspaceBytes } from './agent-tools.mjs';
import { routineBotIdentity, routineConnectionIdentity } from './routine-checkpoints.mjs';
import { createMissionResources, reserveMissionResources, markMissionResourceDispatch, assertMissionResourceDispatch, settleMissionResources } from './mission-resources.mjs';
import { performance } from 'node:perf_hooks';

const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>value && typeof value==='object' && !Array.isArray(value);
const safe=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const ended=run=>!run || ['completed','failed','cancelled','interrupted','unknown'].includes(run.status);
export const missionSuspension=()=>Object.assign(new Error('Mission saved at a safe execution boundary.'),{code:'mission_suspended'});

export function validateMissionWait(input,{time=Date.now(),run}={}) {
  ensure(plain(input) && Object.keys(input).every(key=>['kind','delayMs','deadlineAt','path','intervalMs','delegationIds'].includes(key)),400,'Use a supported timer, dependency or private file-change wait.');
  ensure(['timer','dependency','file_change'].includes(input.kind),400,'Choose timer, dependency or file_change.');
  const deadlineAt=input.deadlineAt ?? time+30*86400000;
  ensure(Number.isSafeInteger(deadlineAt) && deadlineAt>time && deadlineAt<=time+30*86400000,400,'Wait expiry must be within thirty days.');
  const wait={id:id('mission_wait'),kind:input.kind,createdAt:new Date(time).toISOString(),deadlineAt,lastObservedAt:time,cursor:0,consumed:false};
  if(input.kind==='timer') {
    ensure(Object.keys(input).every(key=>['kind','delayMs','deadlineAt'].includes(key)) && Number.isSafeInteger(input.delayMs) && input.delayMs>=1 && input.delayMs<=30*86400000 && time+input.delayMs<=deadlineAt,400,'Choose a positive timer within its expiry.');
    wait.nextWakeAt=time+input.delayMs;
  } else if(input.kind==='file_change') {
    ensure(Object.keys(input).every(key=>['kind','path','intervalMs','deadlineAt'].includes(key)),400,'Use only a private path, polling interval and expiry.');
    ensure(typeof input.path==='string' && input.path.length<=1000 && input.path && !input.path.includes('\\') && !input.path.includes('\0') && !path.posix.isAbsolute(input.path) && !input.path.split('/').some(part=>['.','..',''].includes(part)),400,'Use an exact canonical private workspace file path.');
    ensure(input.intervalMs===undefined || Number.isSafeInteger(input.intervalMs) && input.intervalMs>=1000 && input.intervalMs<=86400000,400,'Choose a file-watch interval between one second and one day.');
    wait.path=input.path;wait.intervalMs=input.intervalMs ?? 60000;wait.nextWakeAt=time+wait.intervalMs;
  } else {
    ensure(Object.keys(input).every(key=>['kind','delegationIds','deadlineAt'].includes(key)) && Array.isArray(input.delegationIds) && input.delegationIds.length>=1 && input.delegationIds.length<=64 && input.delegationIds.every(safe) && new Set(input.delegationIds).size===input.delegationIds.length,400,'Select exact distinct delegation IDs from this coordinator episode.');
    ensure(input.delegationIds.every(value=>(run?.delegationJobs || []).some(job=>job.id===value)),403,'A dependency belongs to another task.');
    wait.delegationIds=[...input.delegationIds];wait.nextWakeAt=time;
  }
  return wait;
}

/** The only watcher source is an authorized exact private file; no external grant is created. */
export async function observeMissionFile(engine,context,relative,{missionId}={}) {
  const current=engine.store.state.bots.find(bot=>bot.id===context.bot.id);
  ensure(current && current.enabled!==false && groupsFor(current).includes('workspace') && groupsFor(context.bot).includes('workspace'),403,'File watching requires current and snapshotted private Files access.');
  const mission=missionId?engine.missions.get(missionId):null,expectedVersion=mission?.contractVersion;
  const operation={operationId:id('mission_resource'),requestDigest:hash(JSON.stringify(['file_watch',missionId,context.bot.id,relative])),botId:context.bot.id,runId:context.runId || mission?.waitCondition?.runId,kind:'file_watch',phase:'work',estimate:{tokens:0,moneyMicros:0,requests:0,toolCalls:0,computeMs:0},pricing:{status:'known'},unavailableDimensions:['computeMs'],bounds:'estimated'};
  const gate=()=>{const current=engine.store.state.bots.find(bot=>bot.id===context.bot.id);ensure(current && current.enabled!==false && groupsFor(current).includes('workspace') && groupsFor(context.bot).includes('workspace'),403,'File watching requires current and snapshotted private Files access.');if(!missionId)return null;const value=engine.missions.get(missionId);ensure(!value.stopRequested && !value.pauseRequested && value.state!=='terminal' && value.contractVersion===expectedVersion,409,'The file observation was paused, stopped or replaced.');return value;};
  if(mission)await engine.store.mutate(()=>{const value=gate();value.resourceLedger ||= createMissionResources();reserveMissionResources(value.resourceLedger,operation);markMissionResourceDispatch(value.resourceLedger,operation);});
  if(mission)try{assertMissionResourceDispatch(gate().resourceLedger,operation);}catch(error){await engine.store.mutate(()=>{const value=engine.missions.get(missionId);settleMissionResources(value.resourceLedger,{operationId:operation.operationId,requestDigest:operation.requestDigest,actual:{tokens:0,moneyMicros:0,requests:0,toolCalls:0,computeMs:0},unknownDimensions:[],receiptDigest:hash('file_observation_not_started')});});throw error;}
  const started=performance.now();let observation,failure;
  try {
    // Reuse bounded real-path, metadata and symlink checks on every observation.
    const bytes=await readWorkspaceBytes(engine.store,context.bot.id,relative,{maxBytes:20_000_000});
    observation={sha256:hash(bytes),bytes:bytes.length};
  }catch(error){failure=error;}
  if(mission)await engine.store.mutate(()=>{const value=engine.missions.get(missionId);settleMissionResources(value.resourceLedger,{operationId:operation.operationId,requestDigest:operation.requestDigest,actual:{tokens:0,moneyMicros:0,requests:0,toolCalls:0,computeMs:Math.ceil(performance.now()-started)},unknownDimensions:[],receiptDigest:hash(JSON.stringify(observation || {readFailed:true}))});});
  if(failure)throw failure;
  return observation;
}

/** Inspect a persisted condition without advancing its cursor or granting dispatch. */
export function missionWaitDecision(wait,{time=Date.now(),jobs=[],observation}={}) {
  ensure(plain(wait) && safe(wait.id),409,'The saved wait identity is unavailable.');
  if(wait.consumed)return {ready:false,reason:'consumed'};
  if(time<wait.lastObservedAt)return {ready:false,blocked:true,reason:'The engine clock moved backwards. Review this wait before resuming.'};
  if(time>=wait.deadlineAt)return {ready:false,expired:true,reason:'The Mission wait expired before its condition was satisfied.'};
  if(time<wait.nextWakeAt)return {ready:false,reason:'not_due'};
  if(wait.kind==='timer')return {ready:true,eventDigest:hash(JSON.stringify([wait.id,'timer',wait.nextWakeAt]))};
  if(wait.kind==='dependency') {
    const selected=wait.delegationIds.map(value=>jobs.find(job=>job.id===value));
    if(selected.some(job=>!job))return {ready:false,blocked:true,reason:'A retained dependency identity is unavailable.'};
    if(selected.some(job=>['queued','running','suspended'].includes(job.status)))return {ready:false,reason:'pending'};
    return {ready:true,eventDigest:hash(JSON.stringify([wait.id,selected.map(job=>[job.id,job.childRunId,job.status,job.finishedAt])]))};
  }
  ensure(wait.kind==='file_change',409,'The saved watcher type is unavailable.');
  if(!observation)return {ready:false,reason:'observation_required'};
  return observation.sha256!==wait.baseline.sha256?{ready:true,eventDigest:hash(JSON.stringify([wait.id,observation.sha256]))}:{ready:false,reason:'unchanged'};
}

export function consumeMissionWake(mission,waitId,eventDigest,{time=Date.now()}={}) {
  const wait=mission.waitCondition;
  ensure(!mission.stopRequested && !mission.pauseRequested && mission.state!=='paused' && mission.ownerEngineId && wait?.id===waitId && !wait.consumed && /^[a-f0-9]{64}$/.test(eventDigest),409,'This wake was stopped, paused, replaced or already consumed.');
  wait.consumed=true;wait.eventDigest=eventDigest;wait.cursor++;wait.consumedAt=new Date(time).toISOString();
  (mission.waitHistory ||= []).push(clone(wait));if(mission.waitHistory.length>100)mission.waitHistory.shift();
  mission.lastWake={id:wait.id,eventDigest,cursor:wait.cursor,at:wait.consumedAt};mission.waitCondition=null;mission.resumeRequested=true;
  return clone(mission.lastWake);
}

/** Engine-local snapshots never appear in presentation sync or model-authored files. */
export function retainMissionCheckpoint(engine,context,snapshot) {
  const run=engine.current(context),mission=run?.missionId && engine.store.state.missions?.[run.missionId];
  if(!mission || mission.ownerEngineId!==engine.missions.ownerEngineId)return;
  const checkpoint={schemaVersion:1,id:id('mission_checkpoint'),runId:run.id,botId:run.botId,missionId:mission.id,contractVersion:mission.contractVersion,
    botIdentity:routineBotIdentity(context.bot),connectionIdentity:routineConnectionIdentity(context.connection),bot:clone(context.bot),inference:clone(context.inference),connectionSettings:{maxOutputTokens:context.connection.maxOutputTokens ?? null,contextWindow:context.connection.contextWindow ?? null,models:clone((context.connection.models || []).filter(item=>item.id===context.inference?.model))},source:context.source,lane:context.lane,sessionId:context.sessionId,task:context.task,
    delegation:clone(context.delegation),run:clone({...run,events:(run.events || []).slice(-40)}),snapshot:clone(snapshot),inFlightMutation:!!context.inFlightMutation,updatedAt:now()};
  const safeCheckpoint=engine.store.redactValue(checkpoint);
  ensure(Buffer.byteLength(JSON.stringify(safeCheckpoint))<=2_000_000,413,'This Mission continuation exceeds its retained size; work remains available for review.');
  (mission.runtimeCheckpoints ||= {})[run.id]=safeCheckpoint;
  ensure(Object.keys(mission.runtimeCheckpoints).length<=100,413,'This Mission reached its retained continuation limit.');
}

/** Whole-family preflight runs before any child, model call or queued request is revived. */
export function missionFamilyPreflight(engine,mission) {
  ensure(mission.ownerEngineId===engine.missions.ownerEngineId && !mission.stopRequested && mission.state!=='terminal',409,'This Mission no longer owns resumable work.');
  const retained=mission.runtimeCheckpoints || {},rootId=mission.episodeRefs.at(-1)?.runId,selected=new Set(),pending=[rootId];
  while(pending.length){const runId=pending.pop();if(selected.has(runId))continue;const saved=retained[runId];ensure(saved,409,'A required continuation snapshot is unavailable.');selected.add(runId);const actual=engine.store.state.runs[saved.botId]?.id===runId?engine.store.state.runs[saved.botId]:saved.run;for(const job of actual.delegationJobs || [])if(job.childRunId && ['queued','running','suspended'].includes(job.status)){const child=Object.values(engine.store.state.runs).find(item=>item.id===job.childRunId);if(!child || !['completed','failed','cancelled'].includes(child.status))pending.push(job.childRunId);}}
  const checkpoints=[...selected].map(runId=>retained[runId]);
  ensure(checkpoints.length && checkpoints.some(item=>item.botId===mission.leadBotId && !item.run.delegation),409,'No safe coordinator checkpoint is available.');
  for(const saved of checkpoints) {
    const bot=engine.store.state.bots.find(item=>item.id===saved.botId),connection=engine.store.state.connections.find(item=>item.id===bot?.connectionId),current=engine.store.state.runs[saved.botId];
    ensure(saved.schemaVersion===1 && saved.missionId===mission.id && saved.contractVersion===mission.contractVersion && bot && bot.enabled!==false && connection && saved.botIdentity===routineBotIdentity(bot) && saved.connectionIdentity===routineConnectionIdentity(connection),409,'A saved participant, permission scope, contract or provider changed. Review the whole Mission before resuming.');
    ensure(!engine.options.busyElsewhere?.(saved.botId) && !engine.roomManager?.reserved(saved.botId) && !engine.starting.has(saved.botId) && ended(current) && !engine.tasks.has(saved.runId),409,'A Mission participant is still draining or busy with other work.');
    const actual=current?.id===saved.runId?current:saved.run;
    ensure(!saved.inFlightMutation && !(actual.workRecords || []).some(record=>['pending','unknown'].includes(record.outcome)) && !(actual.workReconciliation?.unresolved>0),409,'An interrupted action has unknown effects. Reconcile its actual destination before resuming; nothing was replayed.');
    for(const job of actual.delegationJobs || [])if(['queued','running','suspended'].includes(job.status)) {
      ensure(plain(job.intent) && job.intent.botId===job.botId && job.intent.callId===job.callId,409,'A pending child lacks its exact retained dispatch intent.');
      const target=engine.store.state.bots.find(bot=>bot.id===job.botId),provider=engine.store.state.connections.find(connection=>connection.id===target?.connectionId);ensure(target && target.enabled!==false && provider && job.intent.botIdentity===routineBotIdentity(target) && job.intent.connectionIdentity===routineConnectionIdentity(provider),409,'A queued child participant, permission scope or provider changed before recovery. No member was dispatched.');
      if(job.childRunId)ensure(checkpoints.some(child=>child.runId===job.childRunId && child.botId===job.botId) || Object.values(engine.store.state.runs).some(child=>child.id===job.childRunId && ['completed','failed','cancelled'].includes(child.status)),409,'A child continuation cannot be reconciled; its dispatch was not repeated.');
    }
  }
  return checkpoints.sort((a,b)=>(b.delegation?.depth || 0)-(a.delegation?.depth || 0));
}
