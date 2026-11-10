// Usage per bot and per day, built from the display summaries tasks already leave behind: the run history
// (every finished task of the last 50 per bot, including failed and stopped ones) and the final replies in the
// chat (older completed tasks). Engine-local and read-only: numbers and short task titles, never message content.
import { sumSummaries } from './run-usage.mjs';

export const USAGE_DAYS={min:1,max:90,default:14};
const pad=value=>String(value).padStart(2,'0');
/** The engine's local calendar day of an ISO time, as YYYY-MM-DD; null when unreadable. */
export function localDay(value) {
  const date=new Date(value);
  return Number.isFinite(date.getTime())?`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`:null;
}
const title=value=>String(value ?? '').replace(/\s+/g,' ').trim().slice(0,140);
const summary=value=>value && typeof value==='object' && !Array.isArray(value) && Number.isFinite(value.totalTokens) && Number.isFinite(value.modelCalls) && value.modelCalls>0;

/** One row per finished task of a bot inside the window: history first, then completed replies it no longer holds. */
function botTasks(state,bot,since) {
  const rows=new Map();
  for(const run of state.runHistory?.[bot.id] || []) {
    const at=Date.parse(run.finishedAt || run.createdAt);
    if(!summary(run.metering) || !Number.isFinite(at) || at<since || typeof run.id!=='string')continue;
    rows.set(run.id,{runId:run.id,at:run.finishedAt || run.createdAt,task:title(run.task),status:run.status || 'completed',source:run.source || 'chat',usage:run.metering});
  }
  const messages=state.messages?.[bot.id] || [];
  for(let index=0;index<messages.length;index++) {
    const message=messages[index],at=Date.parse(message?.createdAt);
    if(message?.role!=='assistant' || !summary(message.usage) || !Number.isFinite(at) || at<since)continue;
    const runId=typeof message.runId==='string' && message.runId?message.runId:`message:${message.id}`;
    if(rows.has(runId))continue;
    // The request is the nearest earlier message the owner wrote.
    let task='';
    for(let back=index-1;back>=0 && back>=index-40;back--)if(messages[back]?.role==='user' && !messages[back].kind){task=title(messages[back].content ?? messages[back].text);break;}
    rows.set(runId,{runId,at:message.createdAt,task,status:'completed',source:'chat',usage:message.usage});
  }
  return [...rows.values()];
}

/** Totals, a row per day, a row per bot and the tasks that used the most, for the last `days` days. */
export function usageReport(state,{days=USAGE_DAYS.default,now=Date.now(),top=5}={}) {
  const span=Number.isInteger(days) && days>=USAGE_DAYS.min && days<=USAGE_DAYS.max?days:USAGE_DAYS.default;
  // The window starts at local midnight, so "7 days" is today and the six days before it.
  const start=new Date(now);start.setHours(0,0,0,0);start.setDate(start.getDate()-(span-1));
  const since=start.getTime(),all=[],bots=[];
  for(const bot of state.bots || []) {
    const tasks=botTasks(state,bot,since);
    if(!tasks.length)continue;
    for(const task of tasks)all.push({...task,botId:bot.id,botName:bot.name || 'Bot'});
    bots.push({botId:bot.id,name:bot.name || 'Bot',...sumSummaries(tasks.map(task=>task.usage))});
  }
  const byDay=new Map();
  for(let offset=0;offset<span;offset++){const date=new Date(since);date.setDate(date.getDate()+offset);byDay.set(localDay(date),[]);}
  for(const task of all){const day=localDay(task.at);if(byDay.has(day))byDay.get(day).push(task.usage);}
  // Rank by estimated cost when every task has one; otherwise by tokens, so priced and unpriced tasks are never mixed.
  const priced=all.length>0 && all.every(task=>Number.isFinite(task.usage.costUsd));
  const weight=task=>priced?task.usage.costUsd:task.usage.totalTokens;
  const limit=Number.isInteger(top) && top>=0 && top<=50?top:5;
  return {
    days:span,since:new Date(since).toISOString(),rankedBy:priced?'cost':'tokens',
    totals:sumSummaries(all.map(task=>task.usage)),
    daily:[...byDay].map(([day,items])=>({day,...sumSummaries(items)})),
    bots:bots.sort((a,b)=>(b.costUsd-a.costUsd) || (b.totalTokens-a.totalTokens)),
    top:all.sort((a,b)=>weight(b)-weight(a)).slice(0,limit).map(task=>({botId:task.botId,botName:task.botName,runId:task.runId,at:task.at,task:task.task,status:task.status,source:task.source,usage:task.usage})),
  };
}
