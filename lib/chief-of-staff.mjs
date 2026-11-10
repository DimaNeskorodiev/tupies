// The chief of staff: the one bot that can see, read-only, what the other bots did and what waits for the owner.
// team_activity grants nothing. It reports counts, short task titles, usage summaries and one-line engine summaries,
// never message text, tool output, file contents or memory, and never another person's Telegram conversation.
import { ensure, id, now } from './store.mjs';
import { CHAT, sessionKind } from './sessions.mjs';
import { validateRoutine } from './routines.mjs';

export const TEAM_ACTIVITY='team_activity';
export const TEAM_ACTIVITY_LIMITS={hoursMin:1,hoursMax:168,hoursDefault:24,rows:40};
export const BRIEF_NAME='Daily brief';
export const BRIEF_TIME='08:30';
export const BRIEF_PROMPT='Call team_activity for the last 24 hours and write the owner a brief of at most ten lines: what finished, what failed and why, what waits for the owner, and what you suggest next. Use only what team_activity returns; do not invent activity. If there was no activity and nothing waits for the owner, answer with exactly one line: Nothing to report since yesterday.';
export const CHIEF_GUIDANCE='Chief of staff: the team group has a read-only activity report of the work of your teammates and of what waits for the owner; load it for questions like what did my bots do or what is waiting for me. When a request clearly fits a teammate\'s role and delegation tools are available, hand it over with the delegation tool and report the verified result. Bring the owner only decisions, failures and finished results, as a short list.';

/** The chief of staff: the bot the owner chose, else the seeded chief-of-staff bot while it exists, else none. */
export function chiefOfStaff(state) {
  const bots=state?.bots || [],chosen=state?.settings?.chiefOfStaffBotId;
  if(typeof chosen==='string' && chosen){const bot=bots.find(item=>item.id===chosen);if(bot)return bot;}
  return bots.find(item=>item.starterTemplate==='chief-of-staff') || null;
}

/** team_activity is for the chief of staff in the owner's own chat and in that bot's own routines, nowhere else. */
export function teamActivityAllowed(engine,context) {
  const chief=chiefOfStaff(engine.store.state);
  if(!chief || chief.id!==context?.bot?.id || context.roomId || context.delegation?.depth>0)return false;
  if(context.runId && engine.current(context)?.delegation)return false;
  if(engine.missions.missionFor(context))return false;
  const chat=context.source==='chat' && (!context.lane || context.lane===CHAT);
  const routine=context.source==='routine' && context.routine?.botId===chief.id && String(context.lane || '').startsWith('routine:');
  return chat || routine;
}

export const teamActivityDefinitions=(engine,context)=>teamActivityAllowed(engine,context)?[{
  name:TEAM_ACTIVITY,description:'What the other bots did lately: their state, finished tasks, costs and what waits for the owner. Read-only; no message text or outputs.',
  parameters:{type:'object',properties:{hours:{type:'integer',minimum:1,maximum:168,description:'Look back this many hours (default 24).'},botId:{type:'string',maxLength:120,description:'Only this bot.'}},required:[],additionalProperties:false},
}]:[];

const oneLine=(value,max)=>{const text=String(value ?? '').replace(/\s+/g,' ').trim();return text.length>max?`${text.slice(0,max-1).trimEnd()}…`:text;};
const STOPPED=new Set(['cancelled','interrupted','unknown']);
const ACTIVE_DONE=new Set(['completed','failed','cancelled','interrupted','unknown']);
const meterOf=value=>value && typeof value==='object' && !Array.isArray(value) && Number.isFinite(value.totalTokens)?value:null;
// Another person's Telegram conversation is never summarized; the owner's own Telegram messages share the chat lane.
const foreignTelegram=run=>run.lane==='telegram' || sessionKind(run.sessionId)==='telegram' || (run.source==='telegram' && !run.sessionId && !run.lane);

function botState(state,bot) {
  if(bot.enabled===false)return {state:'paused'};
  const run=state.runs?.[bot.id];
  if(!run || ACTIVE_DONE.has(run.status))return {state:'idle'};
  const since=run.updatedAt || run.createdAt || null;
  if(foreignTelegram({lane:sessionKind(run.sessionId),sessionId:run.sessionId,source:run.source}))return {state:'working',since};
  if(run.status==='waiting_for_approval')return {state:'waiting_for_approval',since};
  if(run.status==='waiting_for_input')return {state:'waiting_for_answer',since};
  return {state:'working',since};
}

function waiting(state,bot) {
  const run=state.runs?.[bot.id];
  if(!run || ACTIVE_DONE.has(run.status) || !['waiting_for_approval','waiting_for_input'].includes(run.status) || foreignTelegram({lane:sessionKind(run.sessionId),sessionId:run.sessionId,source:run.source}))return null;
  const control=(run.pending_controls || [])[0] || {},since=run.updatedAt || run.createdAt || null;
  if(run.status==='waiting_for_approval')return {botId:bot.id,botName:oneLine(bot.name || 'Bot',60),kind:'approval',tool:oneLine(control.tool || run.approval?.tool,80),summary:oneLine(control.review?.summary,200),since};
  return {botId:bot.id,botName:oneLine(bot.name || 'Bot',60),kind:control.kind==='question'?'question':'input',...(Array.isArray(control.questions)?{questions:control.questions.length}:{}),since};
}

/** The bounded team report. `now` is injectable for tests. */
export function teamActivityReport(state,{hours=TEAM_ACTIVITY_LIMITS.hoursDefault,botId,chiefId,now:at=Date.now()}={}) {
  ensure(Number.isInteger(hours) && hours>=TEAM_ACTIVITY_LIMITS.hoursMin && hours<=TEAM_ACTIVITY_LIMITS.hoursMax,400,'Use 1–168 hours.');
  ensure(botId===undefined || typeof botId==='string' && botId.length>0 && botId.length<=120 && (state.bots || []).some(bot=>bot.id===botId),404,'No bot with this ID.');
  const since=at-hours*3_600_000,bots=(state.bots || []).filter(bot=>!bot.hidden && (botId===undefined || bot.id===botId)),all=[],perBot=[],waits=[];
  for(const bot of bots) {
    const tasks=[];
    for(const run of state.runHistory?.[bot.id] || []) {
      const finished=Date.parse(run.finishedAt || run.createdAt);
      if(!Number.isFinite(finished) || finished<since || finished>at+60_000 || foreignTelegram(run) || typeof run.id!=='string')continue;
      const usage=meterOf(run.metering);
      tasks.push({botId:bot.id,at:finished,row:{runId:run.id,task:oneLine(run.task,140),status:run.status || 'completed',source:run.delegatedBy!==undefined?'teammate':(run.source || 'chat'),finishedAt:run.finishedAt || run.createdAt,steps:Number.isFinite(run.steps)?run.steps:0,...(usage?{usage}:{}),...(run.error?{error:oneLine(typeof run.error==='string'?run.error:run.error.message,160)}:{})}});
    }
    const counts={completed:0,failed:0,stopped:0};
    for(const task of tasks){const status=task.row.status;if(status==='completed')counts.completed++;else if(status==='failed')counts.failed++;else if(STOPPED.has(status))counts.stopped++;}
    const priced=tasks.length>0 && tasks.every(task=>Number.isFinite(task.row.usage?.costUsd));
    perBot.push({botId:bot.id,name:oneLine(bot.name || 'Bot',60),...(bot.id===chiefId?{you:true}:{}),...botState(state,bot),counts,estimatedCostUsd:priced?Math.round(tasks.reduce((sum,task)=>sum+task.row.usage.costUsd,0)*1e6)/1e6:null,tasks:[]});
    all.push(...tasks);
    const wait=waiting(state,bot);if(wait)waits.push(wait);
  }
  all.sort((a,b)=>b.at-a.at);
  const shown=all.slice(0,TEAM_ACTIVITY_LIMITS.rows);
  for(const task of shown)perBot.find(item=>item.botId===task.botId).tasks.push(task.row);
  return {windowHours:hours,since:new Date(since).toISOString(),bots:perBot,waitingForOwner:waits,totalTasks:all.length,truncated:all.length>shown.length,
    notice:'Task titles, statuses and usage only; no message text, tool output or files. The run history keeps the latest 50 tasks per bot. Nothing here grants access to any bot.'};
}

export async function executeTeamActivity(engine,context,args) {
  ensure(teamActivityAllowed(engine,context),403,'team_activity is available only to the chief of staff in the owner\'s own chat and routines.');
  ensure(args && typeof args==='object' && !Array.isArray(args) && Object.keys(args).every(key=>['hours','botId'].includes(key)),400,'Use only hours and botId.');
  engine.assertRunning(context);
  const report=teamActivityReport(engine.store.state,{...(args.hours!==undefined?{hours:args.hours}:{}),...(args.botId!==undefined?{botId:args.botId}:{}),chiefId:context.bot.id});
  return engine.store.redactValue(report);
}

const briefOf=(state,chief)=>chief && (state.routines || []).find(routine=>routine.botId===chief.id && (routine.template==='chief-daily-brief' || routine.name===BRIEF_NAME)) || null;
export const dailyBrief=(state)=>briefOf(state,chiefOfStaff(state));

/** Owner settings view: the stored choice, the resolved bot and the daily brief routine when there is one. */
export function chiefSettings(state) {
  const chief=chiefOfStaff(state),brief=briefOf(state,chief),chosen=state.settings?.chiefOfStaffBotId;
  return {chiefOfStaffBotId:typeof chosen==='string' && state.bots.some(bot=>bot.id===chosen)?chosen:null,chiefOfStaff:chief?{id:chief.id,name:chief.name || 'Bot'}:null,
    brief:brief?{id:brief.id,enabled:brief.enabled!==false,schedule:brief.schedule,timezone:brief.timezone,nextRunAt:brief.nextRunAt || null}:null};
}

/** Sets or clears the chief of staff. An empty value means automatic. */
export async function setChief(store,input) {
  ensure(input && typeof input==='object' && !Array.isArray(input) && Object.keys(input).every(key=>key==='botId'),400,'Choose a bot or Automatic.');
  const botId=input.botId ?? '';
  ensure(typeof botId==='string' && botId.length<=120,400,'Choose a bot or Automatic.');
  await store.mutate(state=>{
    if(!botId){delete state.settings.chiefOfStaffBotId;store.audit('settings.chief_of_staff','Chief of staff set to automatic');return;}
    const bot=state.bots.find(item=>item.id===botId);ensure(bot,400,'Choose an existing bot.');
    state.settings.chiefOfStaffBotId=botId;store.audit('settings.chief_of_staff',`Chief of staff set to ${bot.name || botId}`,botId);
  });
  return chiefSettings(store.state);
}

/** Creates the optional daily brief routine once. A second call returns the existing one. */
export async function ensureDailyBrief(store,{checkConnection}={}) {
  const chief=chiefOfStaff(store.state);ensure(chief,409,'There is no chief of staff bot. Choose one first.');
  const existing=briefOf(store.state,chief);
  if(existing)return {routine:existing,created:false};
  checkConnection?.(chief);
  let routine,created=false;
  await store.mutate(state=>{
    const again=briefOf(state,chiefOfStaff(state));if(again){routine=again;return;}
    ensure(state.routines.length<200,400,'Workspace supports up to 200 routines.');
    routine={...validateRoutine({name:BRIEF_NAME,botId:chief.id,prompt:BRIEF_PROMPT,schedule:{kind:'daily',time:BRIEF_TIME},enabled:true},{id:id('routine'),createdAt:now()},{timeZone:state.settings?.timezone}),template:'chief-daily-brief'};
    state.routines.push(routine);store.audit('routine.created',`${BRIEF_NAME} routine created`,chief.id);
    created=true;
  });
  return {routine:store.state.routines.find(item=>item.id===routine.id) || routine,created};
}
