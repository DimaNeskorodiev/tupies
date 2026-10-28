import { ensure, string } from './store.mjs';
import { defaultTimeZone, nextRun, planRoutine, scheduleOf, validateSchedule, validTimeZone } from './schedule.mjs';

const TERMINAL=new Set(['completed','failed','cancelled','interrupted','unknown']);
const bounded=(value,max)=>String(value ?? '').slice(0,max);
// What older engines read: an interval close to the schedule, so a routine they see still has a sensible period.
const legacyInterval=schedule=>schedule.kind==='interval'?schedule.minutes:schedule.kind==='weekly' && schedule.days.length===1?10080:schedule.kind==='once'?525600:1440;

/**
 * Validates a routine from the API or a bot's tool and plans its next run. `intervalMinutes` alone still means an
 * interval schedule. Changing the schedule or time zone starts its slots afresh; a one-time routine must be in the future.
 */
export function validateRoutine(input,previous={},{now=Date.now(),timeZone}={}) {
  const value={...previous};
  for(const [key,max] of [['name',100],['botId',100],['prompt',20_000]]) if(Object.hasOwn(input,key))value[key]=string(input[key],key,max);
  ensure(value.name && value.botId && value.prompt,400,'Routine name, bot, and task are required.');
  const before=JSON.stringify([scheduleOf(previous),previous.timezone || '']);
  if(Object.hasOwn(input,'schedule'))value.schedule=validateSchedule(input.schedule);
  else if(Object.hasOwn(input,'intervalMinutes'))value.schedule=validateSchedule({kind:'interval',minutes:input.intervalMinutes});
  value.schedule ||= scheduleOf(previous);
  if(Object.hasOwn(input,'timezone')){ensure(validTimeZone(input.timezone),400,'Choose a valid time zone, such as Europe/Warsaw.');value.timezone=input.timezone;}
  value.timezone ||= timeZone || defaultTimeZone();
  if(Object.hasOwn(input,'missed')){ensure(['once','skip'].includes(input.missed),400,'When a run is missed while Tupies is offline, choose to run it once or skip it.');value.missed=input.missed;}
  value.missed ||= 'once';
  if(Object.hasOwn(input,'enabled')){ensure(typeof input.enabled==='boolean',400,'enabled must be true or false.');value.enabled=input.enabled;}
  value.enabled ??= false;
  value.intervalMinutes=legacyInterval(value.schedule);
  if(JSON.stringify([value.schedule,value.timezone])!==before){delete value.lastSlot;delete value.completedAt;}
  if(value.schedule.kind==='once' && value.enabled && !value.lastSlot)ensure(Date.parse(nextRun(value.schedule,value.timezone,{now}).at)>now,400,'Choose a time in the future for a one-time routine.');
  return planRoutine(value,{now});
}

/**
 * The routine's recent runs, newest first. Requests and replies sync between engines, so this works wherever the owner
 * looks; the engine that ran a task adds its duration, usage and error from its run history.
 */
export function routineRuns(state,routine,limit=10) {
  const messages=state.messages?.[routine.botId] || [],history=new Map((state.runHistory?.[routine.botId] || []).map(item=>[item.id,item])),live=state.runs?.[routine.botId],runs=[];
  for(let index=messages.length-1;index>=0 && runs.length<limit;index--) {
    const request=messages[index];if(request?.role!=='user' || request.routineId!==routine.id || !request.runId)continue;
    const reply=messages.find(item=>item.role==='assistant' && item.runId===request.runId),record=history.get(request.runId),current=live?.id===request.runId?live:null;
    const status=record?.status || (current && !TERMINAL.has(current.status)?'running':current?.status) || (reply?reply.partial?reply.runStatus || 'incomplete':'completed':'no reply');
    runs.push({runId:request.runId,startedAt:request.createdAt,status,
      ...(record?.durationMs!==undefined?{durationMs:record.durationMs}:{}),...(record?.usage?{usage:record.usage}:{}),...(record?.error?{error:bounded(record.error,300)}:{}),
      ...(reply?{preview:bounded(reply.content,280)}:{})});
  }
  return runs;
}
