import { isActive, TERMINAL } from './engine.mjs';
import { describeSchedule, validateSchedule } from './schedule.mjs';
import { normalizeTaskOutcome } from './task-outcomes.mjs';

/**
 * Read-only, bounded projection of the workspace for the Dashboard page. Nothing here is persisted.
 * Text from runs and messages is redacted before it is shortened, so a clipped credential cannot slip past the
 * known-secret match; the whole reply is redacted once more on the way out.
 */
const LIMITS={files:12,activity:80,needs:20,working:20,routines:12,scan:400,cards:3};
const WAITING=new Set(['waiting_for_approval','waiting_for_input']);
const FINISHED={completed:'completed',failed:'failed',cancelled:'cancelled',interrupted:'interrupted',unknown:'interrupted'};
const plain=(value,max)=>{const text=String(value ?? '').replace(/\s+/g,' ').trim();return text.length>max?`${text.slice(0,max-1).trimEnd()}…`:text;};
const base=value=>String(value ?? '').split('/').filter(Boolean).at(-1) || '';
const plural=(count,word)=>`${count} ${word}${count===1?'':'s'}`;
const time=value=>{const parsed=Date.parse(value);return Number.isFinite(parsed)?new Date(parsed).toISOString():null;};
const newest=(a,b)=>String(b.at || b.createdAt || '').localeCompare(String(a.at || a.createdAt || ''));
/** Artifact paths are workspace-relative by construction; anything else is never offered. */
const relativePath=value=>typeof value==='string' && value.length<=500 && !value.startsWith('/') && !/^[a-zA-Z]:/.test(value) && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part=>part && part!=='.' && part!=='..');
const errorText=error=>typeof error==='string'?error:typeof error?.message==='string'?error.message:'';

const TOOL_STEPS={
  workspace_list:'Looking through files',workspace_glob:'Looking through files',workspace_search:'Searching files',
  workspace_read:a=>`Reading ${base(a.path) || 'a file'}`,documents_read:a=>`Reading ${base(a.path) || 'a document'}`,
  workspace_image:a=>`Looking at ${base(a.path) || 'an image'}`,web_search:'Searching the web',
  workspace_write:a=>`Writing ${base(a.path) || 'a file'}`,workspace_edit:a=>`Editing ${base(a.path) || 'a file'}`,
  documents_create:a=>`Creating ${base(a.path) || 'a document'}`,workspace_delete:a=>`Deleting ${base(a.path) || 'a file'}`,
  memory_search:'Checking memory',memory_set:'Saving to memory',memory_delete:'Updating memory',
  brain_search:'Searching notes',brain_read:'Reading notes',brain_links:'Following note links',brain_write:'Writing notes',brain_append:'Writing notes',
  skills_search:'Finding a skill',skills_inspect:'Checking a skill',skills_install:'Installing a skill',skills_list:'Reviewing skills',skills_read:'Reading a skill',skills_file:'Reading a skill',skills_create:'Learning a new skill',skills_run:'Running a skill',memory_propose:'Suggesting a memory update',skills_propose:'Suggesting a skill change',
  http_fetch:a=>{try{return `Reading ${new URL(a.url).hostname}`;}catch{return 'Reading a web page';}},
  integration_list:'Checking integrations',routines_list:'Checking routines',routines_create:'Scheduling a routine',routines_delete:'Removing a routine',
  shell_run:a=>`Running ${base(a.executable) || 'a command'}`,shell_start:a=>`Running ${base(a.executable) || 'a command'}`,shell_read:'Checking a command',shell_list:'Checking commands',shell_stop:'Stopping a command',
  lsp_start:'Starting code analysis',lsp_query:'Analyzing code',lsp_list:'Analyzing code',lsp_stop:'Finishing code analysis',
  task_plan_set:'Updating the plan',task_plan_get:'Reviewing the plan',tool_result_read:'Reading results',ask_user:'Asking you a question',browser_open:'Opening a web page',browser_snapshot:'Reading a web page',browser_click:'Clicking on a web page',browser_scroll:'Scrolling a web page',browser_text:'Reading a web page',browser_back:'Going back a page',browser_screenshot:'Looking at a web page',
  task_outcome_set:'Preparing result checks',task_outcome_check:'Checking the result',work_records_read:'Reviewing earlier work',
};

export function dashboard(store,{busy={}}={}) {
  const state=store.state,text=(value,max)=>plain(store.redact(value ?? ''),max);
  const bots=new Map(state.bots.map(bot=>[bot.id,bot])),rooms=new Map((state.rooms || []).map(room=>[room.id,room]));
  const botName=id=>bots.get(id)?.name || '';
  const integrationName=(id,fallback='')=>(state.integrations || []).find(item=>item.id===id)?.name || fallback || 'an integration';
  const routines=state.routines || [];

  // Recent transcript per bot: task titles and verified file outputs by run. Assistant attachments come only from
  // a run's verified artifacts (documents_create succeeded and the file was re-checked when the run finished).
  const runInfo=new Map(),allFiles=[];
  for(const bot of bots.values()) {
    const messages=state.messages?.[bot.id] || [];
    for(let index=messages.length-1,stop=Math.max(0,messages.length-LIMITS.scan);index>=stop;index--) {
      const message=messages[index];if(!message?.runId)continue;
      const info=runInfo.get(message.runId) || {botId:bot.id,files:[]};runInfo.set(message.runId,info);
      if(message.role==='user' && !['answer','steer'].includes(message.kind)){info.request=message;info.task=taskTitle(message);info.source=message.source;info.prompt=message.content;}
      else if(message.role==='assistant' && !info.reply)info.reply=message;
      if(message.role==='assistant' && Array.isArray(message.attachments)) {
        const files=message.attachments.filter(file=>file && relativePath(file.path)).map(file=>artifact(bot,file,message));
        info.files=files;allFiles.push(...files);
      }
    }
  }
  function taskTitle(message) {
    let content=store.redact(message.content ?? '');
    if(message.source==='telegram'){const split=content.indexOf('\n\n');if(split>=0)content=content.slice(split+2);}
    const line=content.split('\n').map(value=>value.replace(/^[\s#>*-]+/,'').trim()).find(Boolean) || '';
    return line?plain(line,120):Array.isArray(message.attachments) && message.attachments.length?`Shared ${plural(message.attachments.length,'file')}`:'';
  }
  function artifact(bot,file,message) {
    const name=plain(base(file.path),160),format=String(file.format || name.split('.').at(-1) || '').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,10);
    return {botId:bot.id,botName:bot.name,name,path:file.path,format,size:Number.isSafeInteger(file.size) && file.size>=0?file.size:null,createdAt:time(message.createdAt),runId:message.runId,
      downloadUrl:`/api/bots/${encodeURIComponent(bot.id)}/files/download?path=${encodeURIComponent(file.path)}`};
  }
  const routineFor=(runId,info)=>routines.find(routine=>routine.lastRunId===runId) || (info?.source==='routine' ? routines.find(routine=>routine.botId===info.botId && routine.prompt===info.prompt) : null);
  const cards=files=>({files:files.slice(0,LIMITS.cards),moreFiles:Math.max(0,files.length-LIMITS.cards)});

  // Only shared transcript evidence supplies history. Local runs and the audit trail deliberately do not sync.
  // Old successful replies predate taskOutcome; an unanswered request never proves completion or interruption.
  function outcomeFor(info) {
    const recorded=normalizeTaskOutcome(info.request?.taskOutcome);if(recorded)return recorded;
    const reply=info.reply;if(!reply || (reply.partial && !['failed','cancelled','interrupted','unknown'].includes(reply.runStatus)))return null;
    return normalizeTaskOutcome({status:reply.partial?reply.runStatus:'completed',finishedAt:reply.createdAt});
  }
  const ended=new Map();
  for(const [runId,info] of runInfo){const outcome=outcomeFor(info);if(outcome)ended.set(runId,outcome.status);}

  const files=[],seenFiles=new Set();
  for(const file of allFiles.sort(newest)) {
    const key=`${file.botId}\n${file.path}`;if(seenFiles.has(key))continue;
    seenFiles.add(key);files.push(file);if(files.length>=LIMITS.files)break;
  }

  function runEvent(runId,info,outcome) {
    const bot=bots.get(info.botId),request=info.request,routine=routineFor(runId,info);
    const room=info.source==='room'?rooms.get(request.roomId):null;
    const context=info.source==='telegram'?'From Telegram':info.source==='delegation'?'For a teammate':room?`In ${room.name}`:'';
    const task=routine?`${routine.name} routine`:info.task || '',detail=[context,task].filter(Boolean).join(' · ');
    const checks=outcome.checks,checked=checks?(checks.failed?`${plural(checks.failed,'declared check')} failed`:`${plural(checks.passed,'declared check')} passed`):'';
    const error=text(outcome.error,160),outputs=info.files || [],nav=`/bot/${bot.id}`;
    const item={id:`run:${runId}`,at:outcome.finishedAt,kind:'run',tone:'neutral',actor:'bot',botId:bot.id,subject:bot.name,text:'',detail:''};
    if(outcome.status==='completed') {
      const made=outputs.length===1?`created ${outputs[0].name}`:outputs.length?`created ${plural(outputs.length,'file')}`:'';
      return {...item,kind:outputs.length?'file':'run',tone:'ok',text:made || (routine?`ran ${routine.name}`:'finished a task'),detail:[made?detail:routine?'Routine completed':detail,checked].filter(Boolean).join(' · '),...cards(outputs),nav};
    }
    if(outcome.status==='failed')return {...item,tone:'error',text:routine?`couldn’t finish ${routine.name}`:'couldn’t finish a task',detail:[checked,error || detail].filter(Boolean).join(' · '),...cards(outputs),nav};
    if(outcome.status==='cancelled')return {...item,tone:'muted',text:routine?`stopped ${routine.name}`:'stopped working on a task',detail,...cards(outputs),nav};
    return {...item,tone:'muted',text:'was interrupted',detail:error || detail || 'Tupies restarted before the task finished.',...cards(outputs),nav};
  }
  const activity=[];
  for(const [runId,info] of runInfo) {
    if(!info.request)continue;
    const outcome=outcomeFor(info);if(outcome)activity.push(runEvent(runId,info,outcome));
  }
  for(const room of rooms.values()) {
    const messages=state.roomMessages?.[room.id] || [],seen=new Set();
    for(const message of messages.slice(-LIMITS.scan).reverse()) {
      if(message?.role!=='user' || !message.driveId || seen.has(message.driveId))continue;
      seen.add(message.driveId);
      // One member reply cannot prove that a multi-turn room task finished.
      const outcome=normalizeTaskOutcome(message.taskOutcome);if(!outcome)continue;
      const result={completed:['ok','finished a team task'],failed:['error','couldn’t finish a team task'],cancelled:['muted','was stopped'],interrupted:['muted','was interrupted']}[outcome.status];
      activity.push({id:`room:${message.driveId}`,at:outcome.finishedAt,actor:'room',subject:room.name,roomId:room.id,botId:null,kind:'room',tone:result[0],text:result[1],detail:outcome.error || taskTitle(message),nav:`/room/${room.id}`});
    }
  }
  activity.sort((a,b)=>newest(a,b) || a.id.localeCompare(b.id));activity.splice(LIMITS.activity);
  for(const item of activity){item.text=text(item.text,200);item.detail=text(item.detail,200);item.subject=text(item.subject,80);}

  function approvalSummary(tool,args) {
    const a=args && typeof args==='object' && !Array.isArray(args)?args:{},list=value=>Array.isArray(value)?value.map(String).join(' '):'';
    switch(tool) {
      // An executable may be a host path; only its name is shown here. The chat shows the exact approval.
      case 'shell_run':case 'shell_start':return `Run ${[base(a.executable),list(a.args)].filter(Boolean).join(' ')}${a.cwd && a.cwd!=='.'?` in ${a.cwd}`:''}`;
      case 'workspace_write':return `Write ${a.path || 'a file'}`;
      case 'workspace_edit':return `Edit ${a.path || 'a file'}`;
      case 'documents_create':return `Create ${a.path || 'a document'}`;
      case 'workspace_delete':return `Delete ${a.path || 'a file'}`;
      case 'brain_write':case 'brain_append':return `Update the note ${a.path || ''}`.trim();
      case 'skills_install':return `Install ${a.catalogId || 'a catalog skill'} (${a.version || 'exact version'}) for this bot`;
      case 'skills_create':return `Learn a new skill: ${a.name || 'unnamed'}`;
      case 'skills_run':return `Run ${a.path || 'a script'} from the ${a.skillId || ''} skill${a.args?.length?` with ${list(a.args)}`:''}`;
      case 'integration_call':return `Use ${integrationName(a.integrationId)}: ${String(a.tool || 'a tool').replace(/[_-]+/g,' ')}`;
      case 'routines_create':{let when=Number.isInteger(a.intervalMinutes)?` every ${interval(a.intervalMinutes)}`:'';try{if(a.schedule)when=`: ${describeSchedule(validateSchedule(a.schedule),typeof a.timezone==='string'?a.timezone.slice(0,64):state.settings?.timezone || '')}`;}catch{/* An invalid schedule is refused at execution; the summary stays general. */}return `Schedule “${a.name || 'a routine'}”${when}`;}
      case 'routines_delete':return `Remove the ${routines.find(routine=>routine.id===a.routineId)?.name || 'selected'} routine`;
      case 'lsp_start':return `Start ${a.server==='custom'?`${base(a.executable) || 'a custom'}`:'the TypeScript'} language server`;
      default:return `Use ${String(tool || 'a tool').replace(/[_-]+/g,' ')}`;
    }
  }
  const lastEvent=(run,types)=>(run.events || []).findLast(event=>types.includes(event.type));
  const runRoom=run=>run.roomId?rooms.get(run.roomId):null;

  const needs=[];
  for(const bot of bots.values()) {
    const run=state.runs?.[bot.id];if(!isActive(run) || !WAITING.has(run.status))continue;
    const control=(run.pending_controls || []).find(item=>item?.kind===(run.status==='waiting_for_approval'?'approval':'question')),info=runInfo.get(run.id) || {},room=runRoom(run);
    const common={botId:bot.id,botName:bot.name,runId:run.id,task:info.task || '',roomId:room?.id || null,roomName:room?.name || '',nav:`/bot/${bot.id}`};
    if(run.status==='waiting_for_approval') {
      const tool=control?.tool || run.approval?.tool;
      needs.push({id:`approval:${run.id}`,kind:'approval',...common,at:time(lastEvent(run,['approval.request'])?.createdAt || run.updatedAt),title:text(approvalSummary(tool,control?.arguments),240),detail:'Paused until you review this action.',action:'Review action'});
    } else {
      const questions=Array.isArray(control?.questions)?control.questions:[];
      needs.push({id:`question:${run.id}`,kind:'question',...common,at:time(lastEvent(run,['question.request'])?.createdAt || run.updatedAt),title:text(questions[0]?.prompt || 'A question is waiting for your answer.',240),detail:questions.length>1?`And ${plural(questions.length-1,'more question')}.`:'Paused until you answer.',action:'Reply'});
    }
  }
  needs.sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  // Setup problems that stop bots from working: only connections that an enabled bot relies on.
  const enabled=[...bots.values()].filter(bot=>bot.enabled!==false);
  for(const connection of state.connections || []) {
    const users=enabled.filter(bot=>bot.connectionId===connection.id);if(!users.length)continue;
    const names=users.map(bot=>bot.name),who=names.length>2?`${names.slice(0,2).join(', ')} and ${names.length-2} more`:names.join(' and ');
    if(connection.type==='legacy-hermes')needs.push({id:`provider:${connection.id}`,kind:'setup',botId:users[0].id,botName:users[0].name,title:`${connection.name || 'An old connection'} needs replacing`,detail:`${who} can’t work until you choose a model provider.`,nav:'/connections',action:'Fix provider'});
    else if(connection.status==='error')needs.push({id:`provider:${connection.id}`,kind:'setup',botId:users[0].id,botName:users[0].name,title:`${connection.name || 'A provider'} has a connection problem`,detail:text(errorText(connection.error),160) || `${who} may not be able to work.`,nav:'/connections',action:'Fix provider'});
  }
  const unconfigured=enabled.filter(bot=>!bot.connectionId || !(state.connections || []).some(connection=>connection.id===bot.connectionId));
  if(unconfigured.length) {
    const names=unconfigured.map(bot=>bot.name),who=names.length>3?`${names.slice(0,3).join(', ')} and ${names.length-3} more`:names.length>1?`${names.slice(0,-1).join(', ')} and ${names.at(-1)}`:names[0];
    needs.push({id:'setup:providers',kind:'setup',botId:unconfigured[0].id,botName:unconfigured[0].name,title:`${who} need${names.length===1?'s':''} a model provider`,detail:'Connect a provider so these bots can take on work.',nav:'/connections',action:'Connect'});
  }
  for(const integration of state.integrations || [])if(integration.status==='error' && enabled.some(bot=>(bot.integrationIds || []).includes(integration.id)))needs.push({id:`integration:${integration.id}`,kind:'setup',botId:null,botName:'',title:`${integration.name || 'An integration'} has a connection problem`,detail:text(errorText(integration.error),160) || 'Bots that use it can’t reach it.',nav:'/integrations',action:'Review'});
  for(const channel of state.channels || [])if(channel.enabled!==false && channel.status==='error')needs.push({id:`channel:${channel.id}`,kind:'setup',botId:bots.has(channel.botId)?channel.botId:null,botName:botName(channel.botId),title:`${channel.name || 'A messaging channel'} stopped receiving messages`,detail:text(errorText(channel.error),160) || 'Check its bot token and allowed chats.',nav:'/channels',action:'Review'});

  // Suggested memory and skill changes wait for review; they block nothing, so they come after approvals and setup.
  for(const bot of bots.values()) {
    const pending=(state.proposals || []).filter(item=>item.botId===bot.id && item.status==='pending');if(!pending.length)continue;
    const memory=pending.filter(item=>item.kind==='memory').length,skills=pending.length-memory;
    needs.push({id:`review:${bot.id}`,kind:'review',botId:bot.id,botName:bot.name,at:time(pending.at(-1).createdAt),title:`${[memory?plural(memory,'memory update'):'',skills?plural(skills,'skill change'):''].filter(Boolean).join(' and ')} to review`,detail:'Suggested from its recent work. Nothing changes until you accept.',nav:`/bots/${bot.id}/learning`,action:'Review'});
  }

  function currentStep(run) {
    if(run.status==='queued')return 'Waiting to start';
    if(run.status==='stopping')return 'Stopping';
    const events=run.events || [];
    if(run.status==='waiting_for_delegate'){const event=lastEvent(run,['delegation.started']);return `Waiting for ${botName(event?.targetBotId || event?.botId) || 'a teammate'}`;}
    const active=Array.isArray(run.plan?.steps)?run.plan.steps.find(step=>step?.status==='in_progress'):null;
    if(active?.title)return text(active.title,140);
    for(let index=events.length-1;index>=0;index--) {
      const event=events[index];
      if(event.type==='tool.started'){const step=TOOL_STEPS[event.tool];return text(typeof step==='function'?step(event.arguments || {}):step || (event.tool==='integration_call'?`Using ${integrationName(event.arguments?.integrationId)}`:event.tool==='delegate_task'?`Asking ${botName(event.arguments?.botId) || 'a teammate'} for help`:'Using a tool'),140);}
      if(event.type==='model.started')return 'Thinking';
      if(event.type==='model.completed' && !event.toolCalls)return 'Writing the answer';
      if(event.type==='artifact.created')return text(`Created ${base(event.artifact?.path) || 'a file'}`,140);
      if(event.type==='memory.recalled')return 'Recalling notes';
      if(event.type==='question.answered')return 'Continuing with your answer';
      if(event.type==='delegation.completed')return 'Reviewing a teammate’s result';
      if(event.type==='run.started')return 'Getting started';
    }
    return 'Working';
  }
  const working=[],busyRooms=new Set();
  for(const bot of bots.values()) {
    const run=state.runs?.[bot.id];if(!isActive(run) || WAITING.has(run.status))continue;
    const info=runInfo.get(run.id) || {},room=runRoom(run),routine=run.routineId?routines.find(item=>item.id===run.routineId):null,steps=Array.isArray(run.plan?.steps)?run.plan.steps:[];
    if(room)busyRooms.add(room.id);
    working.push({id:`run:${run.id}`,kind:'run',botId:bot.id,botName:bot.name,runId:run.id,status:run.status,title:routine?`${routine.name} routine`:info.task || 'A new task',step:currentStep(run),
      progress:steps.length?{done:steps.filter(step=>step?.status==='completed').length,total:steps.length}:null,since:time(run.createdAt),roomId:room?.id || null,roomName:room?.name || '',source:run.source || 'chat',nav:`/bot/${bot.id}`});
  }
  for(const [botId,engine] of Object.entries(busy || {})) {
    const bot=bots.get(botId);if(!bot || isActive(state.runs?.[botId]))continue;
    working.push({id:`elsewhere:${botId}`,kind:'elsewhere',botId,botName:bot.name,title:'Working on another engine',step:text(`On ${engine || 'another engine'}`,100),elsewhere:text(engine || 'another engine',80),since:null,nav:`/bot/${botId}`});
  }
  for(const [roomId,drive] of Object.entries(state.roomDrives || {})) {
    const room=rooms.get(roomId);if(!room || busyRooms.has(roomId) || !drive || !['queued','running','stopping'].includes(drive.status))continue;
    const current=botName(drive.currentBotId),task=(state.roomMessages?.[roomId] || []).find(message=>message.role==='user' && message.driveId===drive.id);
    working.push({id:`room:${drive.id}`,kind:'room',botId:drive.currentBotId && bots.has(drive.currentBotId)?drive.currentBotId:null,botName:current,roomId,roomName:room.name,title:task?text(String(task.content ?? '').split('\n').find(line=>line.trim()) || '',120):'Team task',
      step:drive.status==='stopping'?'Stopping this round':current?`${current} is taking a turn`:'Getting the team started',since:time(drive.createdAt),nav:`/room/${roomId}`});
  }
  working.sort((a,b)=>String(b.since || '').localeCompare(String(a.since || '')));

  function routineState(routine) {
    if(routine.lastError)return {status:'failed',detail:text(routine.lastError,160)};
    if(!routine.lastRunAt)return {status:routine.enabled?'scheduled':'paused',detail:''};
    const run=state.runs?.[routine.botId];
    if(routine.lastRunId && run?.id===routine.lastRunId) {
      if(WAITING.has(run.status))return {status:'needs_input',detail:run.status==='waiting_for_approval'?'Waiting for your approval.':'Waiting for your answer.'};
      if(isActive(run))return {status:'running',detail:currentStep(run)};
      const status=FINISHED[run.status] || 'completed';return {status,detail:status==='completed'?'':text(errorText(run.error),160)};
    }
    return {status:ended.get(routine.lastRunId) || 'ran',detail:''};
  }
  const routineItems=[...routines].filter(routine=>bots.has(routine.botId)).sort((a,b)=>(b.lastRunAt?1:0)-(a.lastRunAt?1:0) || (a.lastRunAt?String(b.lastRunAt).localeCompare(String(a.lastRunAt)):String(a.nextRunAt || '9').localeCompare(String(b.nextRunAt || '9')))).slice(0,LIMITS.routines).map(routine=>{
    const {status,detail}=routineState(routine),outputs=routine.lastRunId?runInfo.get(routine.lastRunId)?.files || []:[];
    return {id:routine.id,name:text(routine.name,100),botId:routine.botId,botName:botName(routine.botId),status,detail,lastRunAt:time(routine.lastRunAt),nextRunAt:routine.enabled?time(routine.nextRunAt):null,enabled:routine.enabled===true,intervalMinutes:Number.isInteger(routine.intervalMinutes)?routine.intervalMinutes:null,files:outputs.slice(0,2),nav:`/bot/${routine.botId}`};
  });

  const result={counts:{files:files.length,activity:activity.length,needs:needs.length,working:working.length,routines:routineItems.length},files,activity,needs:needs.slice(0,LIMITS.needs),working:working.slice(0,LIMITS.working),routines:routineItems};
  result.counts.needs=result.needs.length;result.counts.working=result.working.length;
  return store.redactValue(result);
}

function interval(minutes) {
  if(minutes%1440===0)return minutes===1440?'day':`${minutes/1440} days`;
  if(minutes%60===0)return minutes===60?'hour':`${minutes/60} hours`;
  return `${minutes} minutes`;
}
