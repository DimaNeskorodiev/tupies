import { createHash } from 'node:crypto';
import { ensure, id, now } from './store.mjs';

const canonical=value=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
export const routineHash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const routineIdentity=routine=>routineHash({id:routine.id,botId:routine.botId,prompt:routine.prompt,workflow:routine.workflow || null,limits:validateRoutineLimits(routine.limits)});
// Credentials rotate independently. Bind the continuation to the same connection, destination and account,
// while the provider retains its existing credential renewal/destination checks.
export const routineConnectionIdentity=connection=>routineHash({id:connection.id,type:connection.type,baseUrl:connection.baseUrl || '',oauthAccount:connection.oauthAccount || null});
export const routineBotIdentity=bot=>routineHash(Object.fromEntries(Object.entries(bot).filter(([key])=>!['hidden','model','reasoningEffort','reasoningEffortVersion'].includes(key))));
export const DEFAULT_ROUTINE_LIMITS=Object.freeze({mode:'autonomous',runtimeMinutes:30,modelTurns:50,toolCalls:200});
const ROUTINE_LIMIT_KEYS=new Set(['mode','runtimeMinutes','modelTurns','toolCalls']);
export function validateRoutineLimits(input={}) {
  ensure(input && typeof input==='object' && !Array.isArray(input) && Object.keys(input).every(key=>ROUTINE_LIMIT_KEYS.has(key)),400,'Use mode, runtimeMinutes, modelTurns and toolCalls for routine limits.');
  const result={...DEFAULT_ROUTINE_LIMITS,...input};
  ensure(['autonomous','bounded'].includes(result.mode),400,'Routine execution mode must be autonomous or bounded.');
  for(const [key,max] of [['runtimeMinutes',120],['modelTurns',200],['toolCalls',1000]])ensure(Number.isInteger(result[key]) && result[key]>=1 && result[key]<=max,400,`${key} must be a whole number from 1 to ${max}.`);
  return result;
}
export const ROUTINE_LIMITS_SCHEMA={type:'object',description:'Execution mode defaults to autonomous: work until done and recover temporary interruptions automatically. Use bounded only when the owner explicitly requests execution limits. Numeric values apply only in bounded mode; omitted mode stays autonomous even with legacy numeric fields. This never authorizes tools or bypasses action approval.',properties:{mode:{type:'string',enum:['autonomous','bounded'],default:'autonomous',description:'autonomous works toward completion; bounded applies the numeric budgets.'},runtimeMinutes:{type:'integer',minimum:1,maximum:120,description:'Active minutes in bounded mode; defaults to 30.'},modelTurns:{type:'integer',minimum:1,maximum:200,description:'Model turns in bounded mode; defaults to 50.'},toolCalls:{type:'integer',minimum:1,maximum:1000,description:'Tool calls in bounded mode; defaults to 200.'}},additionalProperties:false};

// Checkpoints, execution snapshots and polling cursors are engine-local, never replicated documents.
export function routineLocal(state,routineId) {return (state.routineRuntime ||= {})[routineId] ||= {};}
export function pruneRoutineCheckpoints(state) {
  const existing=new Set((state.routines || []).map(routine=>routine.id));
  const entries=Object.entries(state.routineRuntime || {});
  for(const [routineId] of entries)if(!existing.has(routineId))delete state.routineRuntime[routineId];
  let size=0,count=0;
  for(const [,local] of entries.filter(([key])=>existing.has(key)).sort((a,b)=>String(b[1].checkpoint?.updatedAt || '').localeCompare(String(a[1].checkpoint?.updatedAt || '')))) {
    if(!local.checkpoint)continue;
    size+=Buffer.byteLength(JSON.stringify(local.checkpoint));count++;
    if(count>12 || size>8_000_000)delete local.checkpoint;
  }
}
export function newRoutineCheckpoint(routine,bot,connection,inference) {
  return {schemaVersion:2,automatic:validateRoutineLimits(routine.limits).mode==='autonomous',id:id('checkpoint'),runId:null,botId:bot.id,routineIdentity:routineIdentity(routine),botIdentity:routineBotIdentity(bot),connectionIdentity:routineConnectionIdentity(connection),inference:structuredClone(inference),status:'running',updatedAt:now()};
}
export function resumableCheckpoint(state,routine,runId) {
  const checkpoint=state.routineRuntime?.[routine.id]?.checkpoint;
  if(!checkpoint || checkpoint.runId!==runId || !['failed','interrupted'].includes(checkpoint.status) || checkpoint.blocked || !checkpoint.snapshot)return null;
  if(checkpoint.routineIdentity!==routineIdentity(routine))return null;
  const bot=state.bots.find(item=>item.id===routine.botId),connection=state.connections.find(item=>item.id===bot?.connectionId);
  const report=routine.workflow?.mode==='report';
  if(!bot || bot.enabled===false || checkpoint.botIdentity!==routineBotIdentity(bot) || (!report && (!connection || checkpoint.connectionIdentity!==routineConnectionIdentity(connection))))return null;
  return checkpoint;
}
export function requireRoutineCheckpoint(state,routine,{runId,checkpointId}={}) {
  ensure(typeof runId==='string' && typeof checkpointId==='string',400,'Choose the exact interrupted run and checkpoint.');
  const checkpoint=resumableCheckpoint(state,routine,runId);
  ensure(checkpoint && checkpoint.id===checkpointId,409,'This continuation is no longer available. The task, routine, permissions or provider may have changed; inspect its saved progress before starting a new run.');
  return checkpoint;
}
