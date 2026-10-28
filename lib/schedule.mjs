import { ensure, HttpError } from './store.mjs';

// Routine schedules: every N minutes, at a time of day (every day or on chosen weekdays), or once. Clock schedules use
// an IANA time zone, so they keep their wall-clock time across daylight-saving changes, and run at most once per local
// date (their "slot"), so a repeated hour in autumn cannot run the same day twice.
export const DAYS=['mon','tue','wed','thu','fri','sat','sun'];
const TIME=/^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL=/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

export function defaultTimeZone() {try {return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';} catch {return 'UTC';}}
export function validTimeZone(value) {
  if(typeof value!=='string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value))return false;
  try {new Intl.DateTimeFormat('en-US',{timeZone:value});return true;} catch {return false;}
}

const formatters=new Map();
function parts(time,timeZone) {
  let format=formatters.get(timeZone);
  if(!format){format=new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});formatters.set(timeZone,format);}
  const value=Object.fromEntries(format.formatToParts(new Date(time)).map(part=>[part.type,Number(part.value)]));
  return {year:value.year,month:value.month,day:value.day,hour:value.hour,minute:value.minute,second:value.second};
}

/** The instant a local wall-clock time happens in a time zone. A time skipped by a daylight-saving jump moves forward by the jump. */
export function zonedInstant(year,month,day,hour,minute,timeZone) {
  const wall=Date.UTC(year,month-1,day,hour,minute);
  const offset=time=>{const p=parts(time,timeZone);return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(time/1000)*1000;};
  const first=wall-offset(wall);
  return wall-offset(first);
}

/** Normalizes a schedule from the API or a bot's tool call. */
export function validateSchedule(input) {
  ensure(input && typeof input==='object' && !Array.isArray(input),400,'Choose a routine schedule.');
  const only=keys=>ensure(Object.keys(input).every(key=>keys.includes(key)),400,'The schedule contains unknown fields.');
  if(input.kind==='interval') {
    only(['kind','minutes']);
    ensure(Number.isInteger(input.minutes) && input.minutes>=5 && input.minutes<=525600,400,'Routine interval must be 5–525600 whole minutes.');
    return {kind:'interval',minutes:input.minutes};
  }
  if(input.kind==='daily' || input.kind==='weekly') {
    only(input.kind==='daily'?['kind','time']:['kind','time','days']);
    ensure(typeof input.time==='string' && TIME.test(input.time),400,'Use a time of day like 08:30.');
    if(input.kind==='daily')return {kind:'daily',time:input.time};
    ensure(Array.isArray(input.days) && input.days.length>=1 && input.days.length<=7 && new Set(input.days).size===input.days.length && input.days.every(day=>DAYS.includes(day)),400,'Choose one or more weekdays (mon–sun).');
    return {kind:'weekly',time:input.time,days:DAYS.filter(day=>input.days.includes(day))};
  }
  if(input.kind==='once') {
    only(['kind','at']);
    const match=typeof input.at==='string' && LOCAL.exec(input.at),[year,month,day]=match?match.slice(1,4).map(Number):[];
    ensure(match && year>=2000 && year<=2100 && new Date(Date.UTC(year,month-1,day)).getUTCDate()===day && month>=1 && month<=12,400,'Use a local date and time like 2026-11-02T09:00.');
    return {kind:'once',at:input.at};
  }
  throw new HttpError(400,'Choose a schedule: interval, daily, weekly or once.');
}

/** A routine's schedule; routines saved before schedules existed repeat every `intervalMinutes`. */
export const scheduleOf=routine=>routine.schedule || {kind:'interval',minutes:Number.isInteger(routine.intervalMinutes)?routine.intervalMinutes:1440};

/**
 * When a schedule is next due after `now`: `{at, slot}`, or null when a one-time routine has nothing left. `slot` is the
 * local date a clock schedule runs for. A slot at or before `afterSlot` has already run (or was skipped) and is not repeated.
 */
export function nextRun(schedule,timeZone,{now=Date.now(),afterSlot=null}={}) {
  if(schedule.kind==='interval')return {at:new Date(now+schedule.minutes*60_000).toISOString(),slot:null};
  if(schedule.kind==='once') {
    if(afterSlot)return null;
    const [year,month,day,hour,minute]=LOCAL.exec(schedule.at).slice(1).map(Number);
    return {at:new Date(zonedInstant(year,month,day,hour,minute,timeZone)).toISOString(),slot:schedule.at.slice(0,10)};
  }
  const [hour,minute]=schedule.time.split(':').map(Number),today=parts(now,timeZone);
  for(let offset=0;offset<9;offset++) {
    // Calendar arithmetic on the local date; Date.UTC carries over month and year ends.
    const date=new Date(Date.UTC(today.year,today.month-1,today.day+offset)),slot=date.toISOString().slice(0,10);
    if(schedule.kind==='weekly' && !schedule.days.includes(DAYS[(date.getUTCDay()+6)%7]))continue;
    if(afterSlot && slot<=afterSlot)continue;
    const at=zonedInstant(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate(),hour,minute,timeZone);
    if(at>now)return {at:new Date(at).toISOString(),slot};
  }
  return null;
}

/** Sets when a routine runs next from its schedule; a paused or finished routine has no next run. */
export function planRoutine(routine,{now=Date.now()}={}) {
  const next=routine.enabled?nextRun(scheduleOf(routine),routine.timezone || 'UTC',{now,afterSlot:routine.lastSlot || null}):null;
  routine.nextRunAt=next?.at || null;
  if(next?.slot)routine.nextSlot=next.slot;else delete routine.nextSlot;
  return routine;
}

const WEEKDAY_NAMES={mon:'Mon',tue:'Tue',wed:'Wed',thu:'Thu',fri:'Fri',sat:'Sat',sun:'Sun'};
const every=minutes=>({60:'every hour',1440:'every day',10080:'every week'})[minutes] || (minutes%1440===0?`every ${minutes/1440} days`:minutes%60===0?`every ${minutes/60} hours`:`every ${minutes} minutes`);
/** A short description such as "Weekdays at 08:30 (Europe/Warsaw)". */
export function describeSchedule(schedule,timeZone='') {
  const zone=timeZone?` (${timeZone})`:'';
  if(schedule.kind==='interval')return every(schedule.minutes).replace(/^e/,'E');
  if(schedule.kind==='daily')return `Every day at ${schedule.time}${zone}`;
  if(schedule.kind==='once')return `Once on ${schedule.at.replace('T',' at ')}${zone}`;
  const days=schedule.days.join(',')==='mon,tue,wed,thu,fri'?'Weekdays':schedule.days.join(',')==='sat,sun'?'Weekends':schedule.days.map(day=>WEEKDAY_NAMES[day]).join(', ');
  return `${days} at ${schedule.time}${zone}`;
}
