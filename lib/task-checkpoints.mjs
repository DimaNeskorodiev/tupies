import { ensure, id, now } from './store.mjs';
import { routineBotIdentity, routineConnectionIdentity } from './routine-checkpoints.mjs';

const TERMINAL=new Set(['completed','cancelled','failed','interrupted','unknown']);
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const stopped=(checkpoint,run)=>Boolean(checkpoint?.stopRequested || run?.stopRequested || checkpoint?.status==='cancelled' || run?.status==='cancelled' || run?.status==='stopping');
const completed=(checkpoint,run)=>checkpoint?.status==='completed' || run?.status==='completed';
const checkpointSize=checkpoint=>{try{return Buffer.byteLength(JSON.stringify(checkpoint));}catch{return Infinity;}};
const directSnapshot=snapshot=>object(snapshot) && (snapshot.lane===undefined || snapshot.lane==='chat') && object(snapshot.run) &&
  (snapshot.run.source===undefined || snapshot.run.source==='chat') && !snapshot.run.routineId && !snapshot.run.roomId && !snapshot.run.delegation;

/** Trusted engine-local owner-chat state, never a permission grant or replicated document. */
export function newTaskCheckpoint({bot,connection,inference,runId,sessionId,task}) {
  ensure(bot?.id && connection?.id && typeof runId==='string' && runId && sessionId===bot.id,400,'A task checkpoint must belong to the current direct owner chat.');
  ensure(typeof task==='string',400,'A task checkpoint needs its original task text.');
  return {schemaVersion:2,automatic:true,id:id('checkpoint'),botId:bot.id,runId,sessionId,source:'chat',lane:'chat',task:task.slice(0,100_000),
    botIdentity:routineBotIdentity(bot),connectionIdentity:routineConnectionIdentity(connection),inference:structuredClone(inference),status:'running',updatedAt:now()};
}

/** Inspect without mutating. Only the latest explicitly autonomous owner task can recover. */
export function resumableTaskCheckpoint(state,botId) {
  const checkpoint=state.taskCheckpoints?.[botId],run=state.runs?.[botId];
  if(!object(checkpoint) || checkpoint.schemaVersion!==2 || checkpoint.automatic!==true || checkpoint.botId!==botId || checkpoint.source!=='chat' || checkpoint.lane!=='chat' || checkpoint.sessionId!==botId)return null;
  if(!['failed','interrupted'].includes(checkpoint.status) || checkpoint.blocked || stopped(checkpoint,run) || completed(checkpoint,run) || !run || run.id!==checkpoint.runId)return null;
  if(run.source!==undefined && run.source!=='chat' || run.sessionId!==undefined && run.sessionId!==botId || run.routineId || run.roomId || run.delegation)return null;
  if(!directSnapshot(checkpoint.snapshot) || checkpoint.snapshot.run.sessionId!==undefined && checkpoint.snapshot.run.sessionId!==botId)return null;
  const bot=(state.bots || []).find(item=>item.id===botId),connection=(state.connections || []).find(item=>item.id===bot?.connectionId);
  if(!bot || bot.enabled===false || !connection || checkpoint.botIdentity!==routineBotIdentity(bot) || checkpoint.connectionIdentity!==routineConnectionIdentity(connection))return null;
  return checkpoint;
}

/** Bound retained private state; prefer live checkpoints, then the newest recovery state. */
export function pruneTaskCheckpoints(state) {
  if(!object(state.taskCheckpoints))return;
  const bots=new Set((state.bots || []).map(bot=>bot.id)),entries=[];
  for(const [botId,checkpoint] of Object.entries(state.taskCheckpoints)) {
    const run=state.runs?.[botId];
    if(!bots.has(botId) || !object(checkpoint) || stopped(checkpoint,run) || completed(checkpoint,run) || run && run.id!==checkpoint.runId || checkpointSize(checkpoint)>2_000_000) {delete state.taskCheckpoints[botId];continue;}
    entries.push({botId,checkpoint,size:checkpointSize(checkpoint),active:checkpoint.status==='running' || Boolean(run && run.id===checkpoint.runId && !TERMINAL.has(run.status))});
  }
  entries.sort((a,b)=>Number(b.active)-Number(a.active) || String(b.checkpoint.updatedAt || '').localeCompare(String(a.checkpoint.updatedAt || '')) || a.botId.localeCompare(b.botId));
  let count=0,size=0;
  for(const entry of entries) {
    if(count>=12 || size+entry.size>8_000_000){delete state.taskCheckpoints[entry.botId];continue;}
    count++;size+=entry.size;
  }
}
