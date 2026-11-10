const paths = {
  team:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM20 21v-2a4 4 0 0 0-3-3.9M16 3a4 4 0 0 1 0 8',
  bots:'M8 4h8M12 2v2M5 8h14v12H5zM2 12h3m14 0h3M8 20v2m8-2v2M9 12h.01M15 12h.01M9 16h6',
  grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4',
  mission:'M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 12l9-9m-5 0h5v5',
  routine:'M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5M12 8v4l3 2',
  activity:'M3 12h4l3-8 4 16 3-8h4',
  plug:'M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8ZM12 18v4',
  search:'m21 21-5-5M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z',
  plus:'M12 5v14M5 12h14',
  arrow:'M5 12h14m-5-5 5 5-5 5',
  chevron:'m9 5 7 7-7 7',
  close:'m6 6 12 12M6 18 18 6',
  more:'M5 12h.01M12 12h.01M19 12h.01',
  lock:'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4',
  shield:'m12 2 8 3v6c0 5-4 9-8 11-4-2-8-6-8-11V5l8-3Zm-4 9 3 3 5-5',
  help:'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 18h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z',
  logout:'M9 4H4v16h5m6-12 4 4-4 4m-6-4h10',
  edit:'m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z',
  send:'M12 19V5m-5 5 5-5 5 5',
  stop:'M6 6h12v12H6z',
  file:'M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8M8 17h5',
  book:'M3 4h6c2 0 3 1 3 2 0-1 1-2 3-2h6v16h-6c-2 0-3 1-3 2 0-1-1-2-3-2H3V4Zm9 2v16',
  upload:'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
  copy:'M8 8h13v13H8zM16 4V2H2v14h2',
  clock:'M12 7v5l3 2M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z',
  play:'m8 4 12 8-12 8V4Z',
  check:'m5 12 4 4L19 6',
  eye:'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  eyeOff:'m3 3 18 18M10.6 5.1Q11.3 5 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7c1.9 0 3.6-.6 5-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2',
  trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  server:'M3 3h18v7H3zM3 14h18v7H3zM7 6.5h.01M7 17.5h.01',
  globe:'M2 12h20M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 0c-6 5-6 15 0 20 6-5 6-15 0-20Z',
  info:'M12 11v6M12 7h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z',
  menu:'M4 6h16M4 12h16M4 18h16',
  panel:'M3 4h18v16H3zM15 4v16',
  chat:'M4 3h16v14H8l-4 4V3Z',
  sun:'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  mic:'M9 5.5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0v-6ZM5.5 11v.5a6.5 6.5 0 0 0 13 0V11M12 18v3.5M9 21.5h6',
  tune:'M4 7h5m4 0h7M4 17h9m4 0h3M11 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM15 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  speaker:'M4 9h4l5-5v16l-5-5H4V9Zm13-2a7 7 0 0 1 0 10m2-13a11 11 0 0 1 0 16',
  sliders:'M4 7h16M4 17h16M8 4v6m8 4v6',
  heart:'m12 21-8-8C-2 7 6-2 12 5c6-7 14 2 8 8l-8 8Z',
  pin:'M9 3h6l-1 6 4 4H6l4-4-1-6Zm3 10v8',
  phone:'M7 2h10v20H7zM11 18h2',
  laptop:'M4 5h16v11H4zM2 19h20',
  link:'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  home:'M3 11 12 3l9 8M5 9.5V21h5v-6h4v6h5V9.5',
  gear:'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  sync:'M20 11a8 8 0 0 0-14.6-4.5L3 9m0-5v5h5M4 13a8 8 0 0 0 14.6 4.5L21 15m0 5v-5h-5',
  back:'m15 5-7 7 7 7',
  chevronDown:'m7 10 5 5 5-5',
};
const $ = (selector, root=document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.spark}"/></svg>`;
const initialState = {settings:{},bots:[],connections:[],integrations:[],channels:[],routines:[],skills:[],activity:[],rooms:[],runs:{},roomDrives:{},unreadBots:{},pendingBotItems:{},missions:[],botLastMessageAt:{},sync:null};
let syncView=null, pairingTimer=null;
let providerCatalog=[], providerFeatures={}, loginPollTimer=null;
const offeredDefaultModels=new Set();
let importedSkillFiles=null;
const composerAttachments=new Map(), attachmentUploads=new Set();
const updateDraftBridge=window.StudioUpdateDrafts?.create({window,getAttachments:()=>composerAttachments,setAttachments:(id,files)=>composerAttachments.set(id,files),onRestore:()=>{if(activeBot)refreshComposerAttachments(activeBot);}}) || {capture:()=>null,restore:()=>false,clear:()=>{}};
window.tupiesCaptureDrafts=updateDraftBridge.capture;
window.tupiesRestoreDrafts=updateDraftBridge.restore;
// Presentation-only readiness. This can postpone a native update; it never authorizes Engine actions.
window.tupiesReadyForAppUpdate=()=>!attachmentUploads.size && ![...composerAttachments.values()].some(items=>items.length) && !pendingBotDraft && !document.querySelector('dialog[open]') && ![...document.querySelectorAll('textarea, [contenteditable="true"]')].some(field=>(field.value ?? field.textContent ?? '').trim()) && ![...document.querySelectorAll('input')].some(field=>field.type==='file'?field.files?.length:!['checkbox','radio','button','submit','hidden','search'].includes(field.type)&&field.value!==field.defaultValue) && !window.StudioMobile?.hasDrafts?.();
// Whether each bot's current model is shown attached images, checked when an image is attached.
const imageSight=new Map();const imageFile=/\.(?:png|jpe?g|webp)$/i;
let data = {...initialState}, auth = null, search = '', filter = 'all', chat = {messages:[],run:null}, chatSessionView = null, activeBot = null, messageRequest = 0, pollBusy = false, roomChat={messages:[],drive:null,activeRun:null};
let workspaceStateRequest=0,workspaceStateApplied=0,conversationRouteResolution=null,pendingBotDraft=null;
const terminal = new Set(['completed','failed','cancelled','interrupted','unknown','error']);
const route = () => { const [view, id] = location.hash.replace(/^#\/?/,'').split('/'); return {view:view||'dashboard',id}; };
const navigate = hash => { location.hash = hash; };
// Hidden bots keep working; they are only left out of the sidebar and the Bots grid.
const visibleBots = () => data.bots.filter(bot=>!bot.hidden);
// Bots know the whole team unless their owner limited them to selected teammates (mirrors teammatesFor in the engine).
const botTeammates = bot => {const others=data.bots.filter(item=>item.id!==bot?.id);if(bot?.teamMode!=='selected')return others;const selected=new Set(bot.collaborators||[]);return others.filter(item=>selected.has(item.id));};
const botById = id => data.bots.find(b=>b.id===id);
const connectionById = id => data.connections.find(c=>c.id===id);
const shortDate = value => { if(!value)return 'Just now';const d=new Date(value);return Number.isNaN(+d)?'':d.toLocaleDateString(undefined,{month:'short',day:'numeric'}); };
// Routine schedules, as the engine stores them (lib/schedule.mjs).
const DAY_LABELS={mon:'Mon',tue:'Tue',wed:'Wed',thu:'Thu',fri:'Fri',sat:'Sat',sun:'Sun'};
const browserZone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};
function scheduleLabel(r){const s=r.schedule||{kind:'interval',minutes:Number(r.intervalMinutes)||1440},zone=r.timezone&&r.timezone!==browserZone()?` (${r.timezone})`:'';
  if(s.kind==='interval'){const m=Number(s.minutes);return m%1440===0?`Every ${m===1440?'24 hours':`${m/1440} days`}`:m%60===0?`Every ${m===60?'hour':`${m/60} hours`}`:`Every ${m} minutes`;}
  if(s.kind==='daily')return `Every day at ${s.time}${zone}`;
  if(s.kind==='once')return `Once on ${String(s.at).replace('T',' at ')}${zone}`;
  const days=(s.days||[]).join()==='mon,tue,wed,thu,fri'?'Weekdays':(s.days||[]).join()==='sat,sun'?'Weekends':(s.days||[]).map(day=>DAY_LABELS[day]||day).join(', ');return `${days} at ${s.time}${zone}`;}
const whenLabel = value => { const d=new Date(value);if(!value||Number.isNaN(+d))return '';const days=(d-Date.now())/86400000;return d.toLocaleString(undefined,days>=-1&&days<6?{weekday:'short',hour:'2-digit',minute:'2-digit'}:{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); };
const timeLabel = value => { if(!value)return '';const d=new Date(value);return Number.isNaN(+d)?'':d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}); };
const relative = value => { const diff=Date.now()-new Date(value).getTime();if(Number.isNaN(diff))return '';if(diff<60000)return 'Just now';if(diff<3600000)return `${Math.floor(diff/60000)}m ago`;if(diff<86400000)return `${Math.floor(diff/3600000)}h ago`;return shortDate(value); };
function botAvatarRun(bot){
  if(route().view==='room'&&roomChat.drive?.currentBotId===bot?.id)return roomChat.activeRun||data.runs?.[bot.id];
  return bot?.id===activeBot?chat.run:data.runs?.[bot?.id];
}
function botAvatarState(bot,instanceKey=''){
  if(bot?.enabled===false)return 'idle';
  const run=botAvatarRun(bot);
  if(run&&!terminal.has(run.status)){
    if(['waiting_for_approval','waiting_for_input','waiting_for_delegate','queued'].includes(run.status))return 'look';
    if(run.status==='stopping')return 'idle';
    const last=run.events?.findLast?.(event=>['model.started','tool.started','tool.completed'].includes(event.type));
    return run.partialOutput||last?.type?.startsWith('tool.')?'working':'thinking';
  }
  const finished=Date.parse(run?.finishedAt||''),age=Date.now()-finished;
  if(Number.isFinite(finished)&&age>=0&&age<12000){
    if(run.status==='completed')return 'success';
    if(['failed','error','interrupted'].includes(run.status))return 'sad';
  }
  return instanceKey.includes('welcome')?'greeting':'idle';
}
function avatar(bot, size='', instanceKey='') {
  // The full-body companion has room to be a character in the welcome and profile hero.
  // Working UI, including team-room welcomes, uses the quiet compact portrait.
  const presentation=instanceKey==='thread-welcome'||instanceKey==='profile-mascot'?'mascot':'portrait';
  const context=instanceKey.includes('welcome')?'welcome':instanceKey==='profile-mascot'?'profile-mascot':'';
  const options={presentation,state:botAvatarState(bot,instanceKey),working:botStatus(bot).text==='Working',paused:bot?.enabled===false,instanceKey};
  const markup=window.StudioAvatars?.markup(bot,size,options);
  if(markup)return markup.replace('<span ',`<span data-avatar-bot="${esc(bot?.id||'')}" data-avatar-context="${context}" ${context?'':`data-avatar-status="${botAttention(bot)}" `}`);
  // Keep the same local character when the avatar controller cannot load.
  const safeSize=['small','tiny','large'].includes(size)?size:'';
  const source=`companion-blue-${presentation}-128.webp`;
  return `<span class="avatar creature-avatar companion-avatar companion-${presentation} ${safeSize}" data-roki-presentation="${presentation}" aria-hidden="true"><img src="/assets/companions/${source}" alt="" width="128" height="128" style="width:100%;height:100%;object-fit:contain"></span>`;
}
function syncBotAvatarMotion(bot){
  const working=botStatus(bot).text==='Working';
  for(const element of document.querySelectorAll?.('[data-avatar-bot]')||[]){
    if(element.dataset.avatarBot!==bot.id)continue;
    element.classList.toggle('is-working',working);
    element.classList.toggle('is-paused',bot.enabled===false);
    if(!element.dataset.avatarContext)element.dataset.avatarStatus=botAttention(bot);
    window.StudioAvatars?.setState?.(element,botAvatarState(bot,element.dataset.avatarContext||''));
  }
}

function runRecovery(run){
  if(!run || ['completed','cancelled'].includes(run.status))return null;
  const recovery=run.recovery||{},retrying=run.status==='recovering'||recovery.status==='retrying';
  if(!retrying && !['blocked','exhausted'].includes(recovery.status))return null;
  const reason=typeof recovery.reason==='string'?recovery.reason:'',next=retrying&&typeof recovery.nextAttemptAt==='string'&&Number.isFinite(Date.parse(recovery.nextAttemptAt))?` Next attempt ${whenLabel(recovery.nextAttemptAt)}.`:'';
  return {retrying,label:retrying?'Auto-recovering':'Needs attention',detail:`${reason||(retrying?'Recovering saved progress automatically.':'Work cannot progress. Review the task details.')}${next}`};
}
function recoveryMarkup(run,stop=''){const recovery=runRecovery(run);return recovery?`<div class="run-status ${recovery.retrying?'':'run-error'}" role="status">${icon(recovery.retrying?'routine':'info')}<span><strong>${esc(recovery.label)}</strong> · ${esc(recovery.detail)}</span>${stop}</div>`:'';}
/** What a bot's avatar badge says at a glance: working, waiting (for the owner), blocked, unread (finished, not yet read) or nothing. */
function botAttention(bot){
  if(!bot||bot.enabled===false)return '';
  const status=botStatus(bot);
  if(status.className.includes('error'))return 'blocked';
  if(status.className.includes('attention'))return 'waiting';
  if(status.className.includes('working'))return 'working';
  return botHasUnread(bot.id)?'unread':'';
}
function botStatus(bot) {
  if(route().view==='bot'&&bot.id===activeBot&&chat.loadError)return {text:chat.loadError.status,className:'error'};
  if(bot.enabled===false)return {text:'Paused',className:''};
  const run=botAvatarRun(bot),recovery=runRecovery(run);
  if(recovery)return {text:recovery.label,className:recovery.retrying?'working':'working attention'};
  if(!bot.connectionId || !connectionById(bot.connectionId))return {text:'Setup needed',className:''};
  const conn=connectionById(bot.connectionId);
  if(conn.type==='legacy-hermes')return {text:'Choose a provider',className:''};
  if(conn.status==='error')return {text:'Connection issue',className:'error'};
  if(run && !terminal.has(run.status))return run.status==='waiting_for_approval'?{text:'Needs approval',className:'working attention'}:run.status==='waiting_for_input'?{text:run.pending_controls?.some(item=>item.kind==='browser')?'Needs browser help':'Needs your answer',className:'working attention'}:{text:'Working',className:'working'};
  const elsewhere=bot.id===activeBot&&chat.elsewhere?chat.elsewhere.name:data.sync?.busy?.[bot.id];
  if(elsewhere)return {text:`Working on ${elsewhere}`,className:'working'};
  if((conn.status==='connected' || conn.authenticated===true)&&(bot.model||conn.defaultModel))return {text:'',className:'ready'};
  if(conn.status==='connected' || conn.authenticated===true)return {text:'Choose a model',className:''};
  return {text:'Configured',className:''};
}
const statusPill = bot => {const status=botStatus(bot);return status.text?`<span class="status-pill ${status.className}"><i class="dot"></i>${esc(status.text)}</span>`:'';};
// Each message being sent has an ID, reused when the same draft is sent again. After an uncertain failure (no answer,
// or a server/proxy error) the engine is asked whether it received the message before it is sent again, and a repeat
// with the same ID is admitted at most once, so a flaky connection never starts the same task twice.
const pendingSends=new Map();
const pendingDirections=new Map();let directionNavigationGeneration=0;
let sendSessionGeneration=0;
const readBotReplies=new Set();let unreadStateApplied=0;
const changedSessionError=()=>Object.assign(new Error('The sign-in session changed. Review the conversation before sending this message again.'),{name:'AbortError'});
const submissionId=()=>{const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return [...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');};
const uncertainFailure=error=>!error?.status||error.status===408||error.status>=500;
function sendMessage(botId,body,options){return sendConversationMessage('bots',botId,body,options);}
function sendRoomMessage(roomId,body,options){return sendConversationMessage('rooms',roomId,body,options);}
function clearPendingDirections(){for(const pending of pendingDirections.values())pending.controller?.abort();pendingDirections.clear();}
function directGuidanceRun(run,botId){return run?.source==='chat'&&(!run.sessionId||run.sessionId===botId||String(run.sessionId).startsWith(`${botId}--chat-`));}
function updateDirectionComposer(botId,run){
  const form=$('#message-form');if(!form||form.dataset.id!==botId)return;const button=$('[data-action="send-direction"]',form);if(!button)return;
  const pending=pendingDirections.get(botId);if(pending&&pending.runId!==run?.id){pending.controller?.abort();pendingDirections.delete(botId);}
  if(form.dataset.directionRun!==(run?.id||'')){form.dataset.directionRun=run?.id||'';const notice=$('.direction-result',form);if(notice)notice.textContent='';}
  const busy=!!run&&!terminal.has(run.status),direct=busy&&directGuidanceRun(run,botId),allowed=direct&&['queued','running','recovering','waiting_for_delegate'].includes(run.status)&&!run.steerClosing,limited=(run?.steering?.updates?.length||0)>=8||(run?.steering?.bytes||0)>=32000;
  button.hidden=!direct;button.disabled=!allowed||limited||pendingDirections.get(botId)?.inFlight===true;
  button.innerHTML=icon('send');
  button.setAttribute('aria-label',pendingDirections.get(botId)?.inFlight===true?'Sending direction…':'Add direction');
  button.setAttribute('aria-busy',String(pendingDirections.get(botId)?.inFlight===true));
  button.title=limited?'Direction limit reached. Stop to revise the task.':direct&&!allowed?(run.status==='stopping'?'This task is stopping. Wait before sending another message.':run.status==='waiting_for_input'?'Answer the question before adding direction.':'Resolve the pending request first.'):'Add text guidance to this task. Files stay for the next message.';
}
async function addDirection(botId,text){
  const run=chat.run,generation=sendSessionGeneration,navigation=directionNavigationGeneration;
  if(!directGuidanceRun(run,botId)||!['queued','running','recovering','waiting_for_delegate'].includes(run.status)||run.steerClosing)throw Object.assign(new Error('This task is not accepting direction. Resolve its prompt, or Stop and start a revised task.'),{status:409});
  if(!text.trim()||text.length>4000||new Blob([text]).size>8000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))throw Object.assign(new Error('Add direction of up to 4000 characters and 8 KB.'),{status:400});
  const current=()=>{const page=route();if(generation!==sendSessionGeneration||navigation!==directionNavigationGeneration||!auth?.authenticated||page.view!=='bot'||page.id!==botId||chat.run?.id!==run.id||chat.run?.remoteRunId!==run.remoteRunId)throw changedSessionError();};current();
  const previous=pendingDirections.get(botId),same=previous?.runId===run.id&&previous.text===text,pending=same?previous:{runId:run.id,text,id:submissionId()};
  if(pending.inFlight)throw Object.assign(new Error('This direction is still being sent.'),{status:409});pending.inFlight=true;pending.controller=new AbortController();pendingDirections.set(botId,pending);updateDirectionComposer(botId,run);
  try{const result=await api(`/api/bots/${encodeURIComponent(botId)}/steer`,{method:'POST',body:{runId:run.id,remoteRunId:run.remoteRunId,clientUpdateId:pending.id,text},signal:pending.controller.signal});current();if(pendingDirections.get(botId)===pending)pendingDirections.delete(botId);return result;}
  catch(error){current();if(!uncertainFailure(error)&&pendingDirections.get(botId)===pending)pendingDirections.delete(botId);throw error;}
  finally{pending.inFlight=false;if(generation===sendSessionGeneration&&navigation===directionNavigationGeneration)updateDirectionComposer(botId,chat.run);}
}
async function sendDirectionFromComposer(botId){
  const form=$('#message-form');if(!form||form.dataset.id!==botId)return;const field=$('#message-input',form),notice=$('.direction-result',form);if(!field)return;
  const text=field.value,generation=sendSessionGeneration,navigation=directionNavigationGeneration,runId=chat.run?.id;stopSpeechForSend();
  const current=()=>form.isConnected&&generation===sendSessionGeneration&&navigation===directionNavigationGeneration&&auth?.authenticated&&chat.run?.id===runId;
  try{const result=await addDirection(botId,text);if(!current())return;const status=result.update?.status;
    if(result.accepted===true&&['queued','applied'].includes(status)){if(field.value===text)field.value='';window.StudioMobile?.sent(form,text);notice.textContent=status==='applied'?'Added to the task context.':'Direction queued.';}
    else notice.textContent=status==='cancelled'?'Direction was cancelled before it entered the task. Your text is preserved.':'The engine did not confirm this direction. Review the task before trying again.';
    await loadChat(botId);
  }catch(error){if(current()&&error.name!=='AbortError')notice.textContent=uncertainFailure(error)?'Could not confirm receipt. Your text is preserved; retrying this same direction here uses the same update ID.':errorText(error);}
}
async function sendConversationMessage(scope,id,body,{retries=2,wait=800}={}){
  const generation=sendSessionGeneration;
  const currentSession=()=>{if(generation!==sendSessionGeneration||!auth?.authenticated)throw changedSessionError();};
  currentSession();
  if(scope==='bots'&&chatReviewSaves.has(id))throw new Error('Wait for action review to finish saving.');
  const target=`${scope}/${id}`,key=JSON.stringify(body),previous=pendingSends.get(target),clientMessageId=previous?.key===key?previous.id:submissionId(),endpoint=`/api/${scope}/${encodeURIComponent(id)}`;
  const pending={key,id:clientMessageId};pendingSends.set(target,pending);
  const received=()=>{if(pendingSends.get(target)===pending)pendingSends.delete(target);};
  for(let attempt=0;;attempt++){
    currentSession();
    try{const result=await api(`${endpoint}/messages`,{method:'POST',body:{...body,clientMessageId}});currentSession();received();return result;}
    catch(error){
      currentSession();
      if(!uncertainFailure(error))throw error;
      if(attempt>=retries)throw Object.assign(new Error(`${error.message||'The connection failed.'} Your message is still in the box; sending it again is safe.`),{status:error.status});
      await new Promise(resolve=>setTimeout(resolve,wait*(attempt+1)));currentSession();
      try{const receipt=await api(`${endpoint}/submissions/${clientMessageId}`);currentSession();if(receipt?.received){received();return {[scope==='rooms'?'drive':'run']:scope==='rooms'?receipt.drive:receipt.run,duplicate:true};}}
      catch(check){currentSession();if(check.status!==404&&!uncertainFailure(check))throw error;}
    }
  }
}
async function api(path, options={}) {
  const generation=sendSessionGeneration,currentSession=()=>{if(generation!==sendSessionGeneration)throw changedSessionError();};
  const method=options.method||'GET';
  const headers={...options.headers};
  const requestOptions={...options},conditional=Object.hasOwn(options,'etag');
  delete requestOptions.responseType;delete requestOptions.etag;
  // Opt-in conditional GET: the result is {notModified:true} or {body,etag}.
  if(conditional&&options.etag)headers['If-None-Match']=options.etag;
  if(options.body!==undefined){headers['Content-Type']='application/json';requestOptions.body=JSON.stringify(options.body);}
  if(method!=='GET' && auth?.csrf)headers['X-CSRF-Token']=auth.csrf;
  let response=await fetch(path,{...requestOptions,method,headers,credentials:'same-origin'});currentSession();
  if(conditional&&response.status===304)return {notModified:true};
  let result;
  const readResponse=async value=>{if(value.ok&&options.responseType==='blob')return value.blob();try{return await value.json();}catch{return {error:`Request failed (${value.status})`};}};
  result=await readResponse(response);currentSession();
  // This exact guard runs before mutation dispatch, so one retry cannot repeat an action.
  if(method!=='GET'&&response.status===403&&result.code==='csrf_mismatch'){
    const session=await fetch('/api/auth',{credentials:'same-origin'});currentSession();const current=session.ok?await session.json():null;currentSession();
    if(current?.authenticated&&typeof current.csrf==='string'&&current.csrf){
      auth=current;headers['X-CSRF-Token']=current.csrf;
      response=await fetch(path,{...requestOptions,method,headers,credentials:'same-origin'});currentSession();
      result=await readResponse(response);currentSession();
    }
  }
  if(!response.ok){
    // Re-reads the sign-in policy too: a password session ends on an internet address once only paired apps may sign in there.
    if(response.status===401 && auth?.authenticated){auth.authenticated=false;renderAuth();const expiredGeneration=sendSessionGeneration;fetch('/api/auth',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(current=>{if(expiredGeneration===sendSessionGeneration&&!auth?.authenticated&&current&&!current.authenticated){auth=current;renderAuth();}}).catch(()=>{});}
    throw Object.assign(new Error(typeof result.error==='string'?result.error:result.error?.message || result.message || `Request failed (${response.status})`),{status:response.status});
  }
  return conditional?{body:result,etag:response.headers?.get?.('ETag')||''}:result;
}
function toast(message,error=false){const node=document.createElement('div');node.className=`toast${error?' error':''}`;node.textContent=message;$('#toasts').append(node);setTimeout(()=>node.remove(),6000);}
function errorText(error){return error?.message||'Something went wrong. Please try again.';}
function conversationLoadError(error,loaded){
  const offline=window.navigator?.onLine===false,unreachable=!error?.status;
  return {status:offline?'Offline':unreachable?"Can't reach engine":loaded?"Can't refresh":"Can't load",message:offline?'This device is offline.':unreachable?"Can't reach this engine.":`Couldn't ${loaded?'refresh':'load'} this conversation.`,detail:loaded?'Showing the last received messages. Live task status may have changed.':errorText(error)};
}
function conversationErrorMarkup(error,id,room=false){return error?`<div class="run-status run-error conversation-load-error" role="status">${icon('info')}<span>${esc(error.message)} ${esc(error.detail)}</span><button class="text-button" data-action="${room?'reload-room':'reload-chat'}" data-id="${esc(id)}">Try again</button></div>`:'';}
function setFormError(form,error){const box=$('.form-error',form);if(box)box.textContent=errorText(error);else toast(errorText(error),true);}
function applyWorkspaceState(result,request){if(request<workspaceStateApplied)return false;workspaceStateApplied=request;const previousUnread=data.unreadBots,previousPending=data.pendingBotItems;data={...initialState,...result,unreadBots:request<unreadStateApplied?previousUnread:result.unreadBots||{},pendingBotItems:request<unreadStateApplied?previousPending:result.pendingBotItems||{}};unreadStateApplied=Math.max(unreadStateApplied,request);return true;}
async function refresh(render=true,{current=()=>true}={}){const generation=sendSessionGeneration,valid=()=>generation===sendSessionGeneration&&auth?.authenticated&&current(),request=++workspaceStateRequest,result=await api('/api/state');if(!valid()||!applyWorkspaceState(result,request))return false;if(!providerCatalog.length){try{const catalog=await api('/api/providers');if(!valid())return false;providerCatalog=catalog.providers||[];providerFeatures=catalog.features||{};}catch{}}if(valid()&&render)renderApp();return valid();}
function conversationTargetExists(view,id){return view==='bot'?!!botById(id):view==='room'?data.rooms.some(room=>room.id===id):false;}
function hasConversationFrame(view,id){const form=$(view==='room'?'#room-message-form':'#message-form'),thread=$(view==='room'?'#room-thread':'#chat-thread');return !!thread&&form?.dataset.id===id;}
function currentConversationResolution(context){const current=route();return conversationRouteResolution===context&&context.generation===sendSessionGeneration&&auth?.authenticated&&location.hash===context.hash&&current.view===context.view&&current.id===context.id;}
async function resolveConversationRoute(context){
  const request=++workspaceStateRequest;
  try{const result=await api('/api/state');if(!currentConversationResolution(context))return;applyWorkspaceState(result,request);context.status=conversationTargetExists(context.view,context.id)?'found':'missing';if(!hasConversationFrame(context.view,context.id))renderApp();}
  catch(error){if(!currentConversationResolution(context))return;if(conversationTargetExists(context.view,context.id)&&hasConversationFrame(context.view,context.id)){context.status='found';return;}context.status='error';renderApp();}
}
function missingConversationMarkup(view,id){
  const gone=()=>`<section class="page">${view==='bot'?emptyState('bots','This bot isn’t here','It may have been removed. Pick another bot or create one.','create-bot','New bot'):emptyState('team','This room isn’t here','It may have been removed. Pick another room or create one.','create-room','New room')}</section>`;
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(id))return gone();
  let context=conversationRouteResolution;
  if(!context||!currentConversationResolution(context)||context.status==='found'){
    context={view,id,hash:location.hash,generation:sendSessionGeneration,status:'loading'};conversationRouteResolution=context;
    // This request starts after the new route. A state read already in flight before it
    // cannot authoritatively declare the notification's target missing.
    void resolveConversationRoute(context);
  }
  if(context.status==='missing')return gone();
  return `<section class="page"><div class="section-empty" role="status"><p>${context.status==='error'?'Couldn’t refresh this conversation. Try again.':view==='room'?'Opening your team room…':'Opening your conversation…'}</p>${context.status==='error'?'<button class="secondary-button" data-action="reload-conversation-route">Try again</button>':''}</div></section>`;
}
async function offerDefaultModel(){const connection=data.connections.find(c=>oauthProvider(c.type)&&c.status==='connected'&&!c.defaultModel&&!offeredDefaultModels.has(c.id));if(connection&&!$('dialog'))await defaultModelDialog(connection.id);}
function brandMark(size=''){return `<span class="brand-mark ${size}" aria-hidden="true"><img src="/assets/brand/tupies-avatar.webp" width="512" height="512" alt="" decoding="async"></span>`;}
// Native notification navigation may arrive before this page's authentication/state reads finish.
// Keep that hash pending without rendering sign-in or invalidating the current boot's session epoch.
let bootRequest=0,bootPending=false;
async function start(){
  const request=++bootRequest,generation=sendSessionGeneration,current=()=>request===bootRequest&&generation===sendSessionGeneration;bootPending=true;installSpeech();
  try{const nextAuth=await api('/api/auth');if(!current())return;auth=nextAuth;
    if(auth.authenticated){await refresh(false,{current});if(!current())return;bootPending=false;renderApp();if(current())await offerDefaultModel();}
    else{bootPending=false;renderAuth();}
  }catch(error){if(!current())return;bootPending=false;tellApp({type:'chrome',ownsChrome:false});$('#app').innerHTML=`<main class="loading-screen">${brandMark()}<p>${esc(errorText(error))}</p><button class="secondary-button" data-action="retry">Try again</button></main>`;}
}
function renderAuth(){
  if(!auth?.authenticated)updateDraftBridge.clear();
  if(document.querySelector('.browser-control-panel'))closeDialog();
  window.StudioBrowser?.reset();
  bootPending=false;sendSessionGeneration++;window.StudioMissions?.reset();window.StudioSkills?.reset();window.TupiesCoding?.reset();window.TupiesDesktop?.reset();window.StudioStudyLearning?.clear();pendingSends.clear();pendingSearchMessage=null;pendingBotDraft=null;conversationSearchRequest++;conversationRouteResolution=null;
  clearPendingDirections();clearSearchAnchor?.();
  readBotReplies.clear();closeInferencePicker(true,false);reasoningCatalogs.clear();reasoningSaves.clear();reasoningSaveOwners.clear();chatReviewSaves.clear();chatReviewErrors.clear();
  dismissConversationSearch();
  cleanupSpeech();window.StudioMobile?.reset();tellApp({type:'chrome',ownsChrome:false});
  const setup=auth?.setupRequired,intro=`<section class="auth-intro">${brandMark('large')}<h1>Your team.<br>Your own space.</h1><p>A considered home for your AI teammates.<br>Your models. Your engine. Hosted by you.</p><div class="bottom-note">${icon('shield')}Private by design. Yours to run.</div></section>`;
  // On an internet address the engine accepts paired apps only (unless the owner allowed the password there).
  if(auth?.passwordSignIn===false){$('#app').innerHTML=`<main class="auth-screen"><div class="auth-layout">${intro}<section class="auth-card glass-card"><h2>Open it in the app.</h2><p>This address accepts sign-in from your paired Tupies apps only, so nobody can try passwords from the internet.</p><ol class="auth-steps"><li><strong>Already paired?</strong> Open the Tupies app on your iPhone or Mac.</li><li><strong>New device?</strong> On the server, run <code>npm run pair</code> and scan the code with the app.</li></ol><p class="auth-foot">${icon('lock')}You can allow password sign-in from the internet in Settings › Devices & sync.</p></section></div></main>`;return;}
  $('#app').innerHTML=`<main class="auth-screen"><div class="auth-layout">${intro}<section class="auth-card glass-card"><h2>${setup?'Make yourself at home.':'Welcome back.'}</h2><p>${setup?'Set up your private workspace. You’ll find the one-time setup token in the server terminal.':'Your bots, conversations, and routines are waiting for you.'}</p><form id="auth-form">${setup?'<div class="field"><label for="setup-token">Setup token</label><input id="setup-token" name="token" autocomplete="off" placeholder="Paste the token from your terminal" required></div>':''}<div class="field"><label for="password">${setup?'Choose a password':'Workspace password'}</label><input type="password" id="password" name="password" minlength="12" autocomplete="${setup?'new-password':'current-password'}" placeholder="${setup?'At least 12 characters':'Enter your password'}" required>${setup?'<small>This password protects access to your workspace.</small>':''}</div><p class="form-error" role="alert"></p><button class="primary-button" type="submit">${setup?'Create workspace':'Open workspace'}${icon('arrow')}</button></form><p class="auth-foot">${icon('lock')}Self-hosted on your machine or VPS</p></section></div></main>`;
}
function navItem(id,label,ico,count,extra=''){const current=route().view,active=current===id||(id==='bots'&&current==='bot')||(id==='rooms'&&current==='room')||(id==='settings'&&settingsViews.has(current));return `<button class="nav-item ${active?'active':''}" data-nav="/${id}" ${active?'aria-current="page"':''}>${icon(ico)}${label}${id==='bots'?botsAttentionBadge():count?`<span class="nav-count">${count}</span>`:''}${extra}</button>`;}
const settingsTabs=[['skills','Skills','spark'],['connections','Models','plug'],['integrations','Integrations','globe'],['coding','Coding on this Mac','terminal'],['desktop','Desktop on this Mac','grid'],['channels','Messaging','chat'],['sync','Devices & sync','sync'],['usage','Usage','activity'],['activity','Activity','activity'],['help','Help','book']];
const settingsViews=new Set(['settings',...settingsTabs.map(([id])=>id)]);
// Sync trouble surfaces on the Settings entry now that the sidebar has no engine badge.
function syncAlert(){const hub=data.sync?.hub;return hub&&!hub.connected?`<i class="dot warning nav-alert" title="${esc(`Waiting for ${hub.name}`)}"></i>`:'';}
// The phone tab bar; chats and Settings keep the tab they were opened from highlighted.
const mainTabs=[['dashboard','Dashboard','home'],['bots','Bots','grid'],['missions','Mission','mission'],['rooms','Team rooms','team'],['routines','Routines','routine']];
const tabFor=view=>view==='bot'?'bots':view==='room'?'rooms':mainTabs.some(([id])=>id===view)?view:'';
let lastTab='';
const phoneLayout=()=>!!window.matchMedia?.('(max-width:760px), (max-height:500px) and (pointer:coarse)').matches;
// The Tupies iPhone app marks the page; it then hides its own engine bar and opens its settings on request.
const inApp=()=>document.documentElement?.dataset?.studioApp==='ios';
function tellApp(message){try{window.webkit?.messageHandlers?.hermesStudio?.postMessage(message);}catch{}}
function appServerRow(){
  if(!inApp())return '';
  const node=data.sync?.node,hub=data.sync?.hub,state=hub?(hub.connected?`Synced with ${hub.name}`:`Waiting for ${hub.name}`):node?.role==='hub'?'Home server':'Connected';
  return `<button class="app-server-row glass-card" data-action="app-settings"><span class="setup-icon">${icon('server')}</span><span><strong>${esc(node?.name||'This server')}</strong><small>${esc(state)} · Switch server, sync and pairing</small></span>${icon('chevron')}</button>`;
}
function updateTopbarScroll(){$('.topbar')?.classList.toggle('scrolled',(window.scrollY||0)>24);}
// Pull-down menus (bot switcher, chat actions) anchored to the button that opened them, as on iOS.
const menuItem=(label,ico,attrs,detail='')=>`<button class="menu-item" role="menuitem" ${attrs}><span class="menu-text"><span>${esc(label)}</span>${detail?`<small>${esc(detail)}</small>`:''}</span>${icon(ico)}</button>`;
function openMenu(anchor,items,{label='',align='end',className=''}={}){
  closeMenu();const layer=document.createElement('div');layer.className='menu-layer';
  layer.innerHTML=`<div class="menu-backdrop" data-action="close-menu"></div><div class="popover-menu ${className}" role="menu" aria-label="${esc(label)}">${items}</div>`;
  document.body.append(layer);const menu=$('.popover-menu',layer),gap=12;
  layer.reposition=()=>{
    const box=anchor.getBoundingClientRect(),view=window.visualViewport,viewTop=view?.offsetTop||0,viewLeft=view?.offsetLeft||0,width=menu.offsetWidth,viewWidth=view?.width||window.innerWidth,viewHeight=view?.height||window.innerHeight;
    menu.style.maxHeight=`${Math.max(44,viewHeight-gap*2)}px`;
    const left=align==='center'?box.left+box.width/2-width/2:box.right-width;
    menu.style.left=`${Math.max(viewLeft+gap,Math.min(left,viewLeft+viewWidth-width-gap))}px`;
    menu.style.top=`${Math.max(viewTop+gap,Math.min(box.bottom+8,viewTop+viewHeight-menu.offsetHeight-gap))}px`;
  };
  layer.reposition();
  menu.style.transformOrigin=align==='center'?'top center':'top right';
  anchor.setAttribute('aria-expanded','true');layer.anchor=anchor;
  for(const item of menu.querySelectorAll('[role^="menuitem"]'))item.tabIndex=-1;
  menu.addEventListener('keydown',event=>{
    const items=[...menu.querySelectorAll('[role^="menuitem"]:not(:disabled)')],index=items.indexOf(document.activeElement);
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowDown'?(index+1)%items.length:(index-1+items.length)%items.length;
      items[next]?.focus({preventScroll:true});items[next]?.scrollIntoView?.({block:'nearest'});
    }else if(event.key==='Tab')closeMenu();
  });
  // Keyboard users land in the menu; a tap leaves focus alone so an open keyboard stays put.
  if(document.activeElement===anchor)($('.menu-item.current',menu)||$('.menu-item',menu))?.focus({preventScroll:true});
}
function closeMenu(){const layer=$('.menu-layer');if(!layer)return;layer.anchor?.setAttribute('aria-expanded','false');layer.remove();}
function botSwitcherMenu(anchor,id){
  const bots=sortBotsByMessage(visibleBots()).filter(bot=>bot.id!==id),current=botById(id),row=bot=>{const status=botStatus(bot);return `<button class="menu-item bot-choice ${bot.id===id?'current':''}" role="menuitemradio" aria-checked="${bot.id===id}" data-nav="/bot/${esc(bot.id)}">${avatar(bot,'small','switch-'+bot.id)}<span class="menu-text"><span>${esc(bot.name)}</span><small>${esc(bot.title||'Teammate')}</small></span>${status.text?`<span class="choice-status ${status.className}" title="${esc(status.text)}"><i class="dot"></i></span>`:''}${bot.id===id?icon('check'):''}</button>`;};
  openMenu(anchor,`<div class="menu-scroll">${(current?[current,...bots]:bots).map(row).join('')}</div><hr>${menuItem('All bots','grid','data-nav="/bots"')}${menuItem('New bot','plus','data-action="create-bot"')}`,{label:'Switch bot',align:'center',className:'switcher-menu'});
}
function roomSwitcherMenu(anchor,id){
  const rooms=[...data.rooms].sort((a,b)=>(b.id===id)-(a.id===id));
  openMenu(anchor,`<div class="menu-scroll">${rooms.map(room=>`<button class="menu-item bot-choice ${room.id===id?'current':''}" role="menuitemradio" aria-checked="${room.id===id}" data-nav="/room/${esc(room.id)}"><span class="setup-icon">${icon('team')}</span><span class="menu-text"><span>${esc(room.name)}</span><small>${esc(room.botIds.map(botById).filter(Boolean).map(b=>b.name).join(', '))}</small></span>${room.id===id?icon('check'):''}</button>`).join('')}</div><hr>${menuItem('All team rooms','team','data-nav="/rooms"')}${menuItem('New room','plus','data-action="create-room"')}`,{label:'Switch team room',align:'center',className:'switcher-menu'});
}
function botMenu(anchor,id){
  const bot=botById(id);if(!bot)return;const key=`data-id="${esc(id)}"`;
  openMenu(anchor,`${menuItem('Open chat','chat',`data-nav="/bot/${esc(id)}"`)}${data.missionsAdmission!==false?menuItem('Start Mission','mission',`data-action="create-mission" ${key}`):''}${anchor.closest?.('.bot-row')?menuItem(bot.favorite?'Remove from Favorites':'Add to Favorites','heart',`data-action="toggle-bot-favorite" ${key}`):''}<hr>${menuItem('Delete bot','trash',`data-action="delete-bot" ${key}`)}`,{label:`${bot.name} options`});
}
function chatMenu(anchor,id){
  const bot=botById(id);if(!bot)return;const key=`data-id="${esc(id)}"`,inChat=route().view==='bot'&&route().id===id;
  openMenu(anchor,`${menuItem('Bot profile','bots',`data-nav="/bots/${esc(id)}"`)}${menuItem(bot.favorite?'Remove from Favorites':'Add to Favorites','heart',`data-action="toggle-bot-favorite" ${key}`)}${data.missionsAdmission!==false?menuItem('Start Mission','mission',`data-action="create-mission" ${key}`):''}${inChat&&chat.run&&!terminal.has(chat.run.status)&&chat.run.source==='chat'&&!chat.elsewhere&&!chat.run.missionId?menuItem('Make this task a Mission','mission',`data-action="adopt-mission" ${key} data-run-id="${esc(chat.run.id)}"`):''}${menuItem('New chat','plus',`data-action="new-chat" ${key}`)}${menuItem('Chats','clock',`data-action="chat-sessions" ${key}`)}${menuItem('Search conversation','search',`data-action="search-conversations" data-scope="bot" ${key}`)}${menuItem('Chat options','sliders',`data-action="chat-options" ${key}`)}<hr>${menuItem('Delete bot','trash',`data-action="delete-bot" ${key}`)}`,{label:`${bot.name} options`});
}
function roomMenu(anchor,id){
  const key=`data-id="${esc(id)}"`;
  openMenu(anchor,`${menuItem('Search conversation','search',`data-action="search-conversations" data-scope="room" ${key}`)}${menuItem('Teammates','team',`data-action="room-details" ${key}`)}${menuItem('Voice options','sliders','data-action="chat-options"')}<hr>${menuItem('Room settings','edit',`data-action="edit-room" ${key}`)}`,{label:'Room options'});
}
const botHasUnread=id=>typeof data.unreadBots?.[id]==='string'&&!readBotReplies.has(`${id}:${data.unreadBots[id]}`);
const botUnreadMarkup=id=>botHasUnread(id)?'<span class="roster-unread" role="img" aria-label="Unread message" title="Unread message"></span>':'';
const botsAttentionCount=()=>data.bots.reduce((total,bot)=>total+(botHasUnread(bot.id)?1:0)+(Number.isSafeInteger(data.pendingBotItems?.[bot.id])&&data.pendingBotItems[bot.id]>0?data.pendingBotItems[bot.id]:0),0);
const botsAttentionLabel=count=>`${count} ${count===1?'item needs':'items need'} your attention`;
function botsAttentionBadge(phone=false){const count=botsAttentionCount();return count?`<span class="${phone?'tab-count':'nav-count'}" data-bots-attention-count aria-label="${botsAttentionLabel(count)}" title="Unread replies and pending requests">${count}</span>`:'';}
function updateBotsAttention(){
  const count=botsAttentionCount();
  for(const button of document.querySelectorAll('.sidebar .nav-item[data-nav="/bots"],.tabbar .tab[data-nav="/bots"]')){
    const marker=button.querySelector('[data-bots-attention-count]');
    button.setAttribute('aria-label',count?`Bots, ${botsAttentionLabel(count)}`:'Bots');
    if(!count){marker?.remove();continue;}
    if(marker){marker.textContent=count;marker.setAttribute('aria-label',botsAttentionLabel(count));}else button.insertAdjacentHTML('beforeend',botsAttentionBadge(button.classList.contains('tab')));
  }
}
function updateSidebarUnread(){
  for(const row of document.querySelectorAll('.sidebar .roster-item')){
    const id=row.dataset.nav?.replace(/^\/bot\//,''),marker=row.querySelector('.roster-unread');
    if(botHasUnread(id)){if(!marker)row.insertAdjacentHTML('beforeend',botUnreadMarkup(id));}else marker?.remove();
  }
  updateBotsAttention();
}
function acknowledgeSidebarRead({view,botId,messageIds}){
  if(view!=='bot')return;
  for(const id of messageIds)readBotReplies.add(`${botId}:${id}`);
  while(readBotReplies.size>2000)readBotReplies.delete(readBotReplies.values().next().value);
  updateSidebarUnread();
}
async function refreshUnread(){
  if(document.hidden||!auth?.authenticated)return;
  const generation=sendSessionGeneration,request=++workspaceStateRequest;
  try{const result=await api('/api/notifications/unread');if(generation!==sendSessionGeneration||request<unreadStateApplied||!auth?.authenticated)return;unreadStateApplied=request;data.unreadBots=result.unreadBots||{};data.pendingBotItems=result.pendingBotItems||{};updateSidebarUnread();}catch{}
}
function sidebarMarkup(current){
  return `<aside class="sidebar" aria-label="Main navigation"><div class="brand">${brandMark()}<span class="brand-name">Tupies</span></div><form class="searchbox" id="workspace-search-form" role="search">${icon('search')}<input id="workspace-search" aria-label="Search workspace and conversations" title="Filter by name, or press Enter to search messages" placeholder="Search" value="${esc(search)}" autocomplete="off"><button type="submit" class="workspace-search-submit kbd" aria-label="Search conversations" aria-keyshortcuts="Meta+K Control+K" title="Search messages (Enter or Cmd/Ctrl+K)">↵</button></form><nav class="nav-list">${navItem('dashboard','Dashboard','home')}${navItem('bots','Bots','grid')}${navItem('missions','Mission','mission')}${navItem('rooms','Team rooms','team')}${navItem('routines','Routines','routine')}</nav><div class="sidebar-label">My Tupies<button data-action="create-bot" aria-label="New bot" title="New bot">${icon('plus')}</button></div><div class="roster">${sortBotsByMessage(visibleBots()).map(bot=>`<button class="roster-item ${current.view==='bot'&&current.id===bot.id?'selected':''}" data-nav="/bot/${esc(bot.id)}">${avatar(bot,'small')}<span><span class="roster-name">${esc(bot.name)}</span><span class="roster-role">${esc(bot.title||'Teammate')}</span></span>${botUnreadMarkup(bot.id)}</button>`).join('')}</div><div class="sidebar-bottom">${navItem('settings','Settings','gear',0,syncAlert())}</div></aside>`;
}
function renderApp(){
  if(bootPending)return;
  if(!auth?.authenticated)return renderAuth();
  window.StudioMobile?.beforeRender();
  cleanupSpeech();window.StudioRich?.dispose($('#app'));
  closeMenu();closeInferencePicker(true,false);
  const current=route(),tab=tabFor(current.view);if(tab&&!['bot','room'].includes(current.view))lastTab=tab;
  const label=({welcome:'Getting started',dashboard:'Dashboard',bots:current.id?botById(current.id)?.name||'Bots':'Bots',bot:botById(current.id)?.name||'Bots',rooms:'Team rooms',room:data.rooms.find(r=>r.id===current.id)?.name||'Team room',routines:'Routines',missions:'Mission'})[current.view]||(settingsViews.has(current.view)?'Settings':'Dashboard');
  // Phones: an iOS-style navigation bar (back, title, Settings) on top and the five main sections as a tab bar.
  // Settings goes back to the tab it was opened from; a Settings section goes back to Settings.
  const back=current.view==='missions'&&current.id?'/missions':current.view==='bots'&&current.id?'/bots':current.view==='settings'?`/${lastTab||'dashboard'}`:settingsViews.has(current.view)?'/settings':'';
  const topbar=`<header class="topbar">${back?`<button class="topbar-back" data-nav="${back}" aria-label="Back">${icon('back')}</button>`:''}<span class="topbar-title">${esc(label)}</span><div class="topbar-actions"><button class="icon-button conversation-search-open" data-action="search-conversations" aria-label="Search conversations">${icon('search')}</button>${settingsViews.has(current.view)?'':`<button class="topbar-settings" data-nav="/settings" aria-label="Settings">${icon('gear')}${syncAlert()}</button>`}</div></header>`;
  const activeTab=tab||lastTab||'dashboard',tabbar=`<nav class="tabbar" aria-label="Sections">${mainTabs.map(([id,name,symbol])=>`<button class="tab ${activeTab===id?'active':''}" data-nav="/${id}"${id==='rooms'?' aria-label="Team rooms"':''} ${activeTab===id?'aria-current="page"':''}>${icon(symbol)}<span>${id==='rooms'?'Rooms':name}</span>${id==='bots'?botsAttentionBadge(true):''}</button>`).join('')}</nav>`;
  $('#app').innerHTML=`<div class="app-shell" data-view="${esc(current.view)}">${sidebarMarkup(current)}<div class="content">${topbar}<main id="main-content">${renderPage(current)}</main></div>${tabbar}</div>`;
  updateBotsAttention();updateTopbarScroll();tellApp({type:'chrome',ownsChrome:phoneLayout()});
  mountPage(current);
  window.StudioMobile?.afterRender(current);
  applyPendingBotDraft(current);
  if(current.view==='bot'&&conversationTargetExists('bot',current.id))loadChat(current.id);
  if(current.view==='room'&&conversationTargetExists('room',current.id))loadRoomChat(current.id);
  if(current.view==='sync')loadSyncPage();
}
function pageHeading(title,description,action,label,ico='plus',kind='primary-button'){return `<div class="page-heading"><div><h1>${title}</h1><p class="page-description">${description}</p></div>${action?`<button class="${kind}" data-action="${action}">${icon(ico)}${label}</button>`:''}</div>`;}
function settingsHeading(tab,description,action,label,ico='plus'){return `${pageHeading('Settings','Make this space yours.')}${appServerRow()}<button class="text-button settings-back" data-nav="/settings">${icon('back')}All settings</button><details class="pearl-advanced settings-section-picker" data-disclosure="settings-sections"><summary>${esc(settingsTabs.find(([id])=>id===tab)?.[1]||'Settings sections')}</summary><nav class="settings-tabs" aria-label="Settings sections">${settingsTabs.map(([id,name,symbol])=>`<button class="settings-tab ${tab===id?'active':''}" data-nav="/${id}" ${tab===id?'aria-current="page"':''}>${icon(symbol)}${name}${id==='sync'?syncAlert():''}</button>`).join('')}</nav></details><div class="settings-intro"><p>${description}</p>${action?`<button class="primary-button" data-action="${action}">${icon(ico)}${label}</button>`:''}</div>`;}
function renderSettings(){
  const card=(view,name,description,symbol)=>`<button class="pearl-resource-card" data-nav="/${view}">${icon(symbol)}<span><strong>${name}</strong><small>${description}</small></span>${icon('chevron')}${view==='sync'?syncAlert():''}</button>`;
  return `<section class="page settings-overview">${pageHeading('Settings','A few things to make your team feel at home.')}${appServerRow()}${window.StudioChief?.render(studioContext())||''}<div class="pearl-settings-grid">${card('skills','Skills','Manage installed skills and assign them to your bots.','spark')}${card('connections','Models','Connect an account to power your team.','plug')}${card('coding','Coding on this Mac','Work with connected coding agents.','terminal')}${card('desktop','Desktop on this Mac','Let bots work with selected Mac applications.','grid')}${card('sync','Devices & sync','Keep your workspace close, on every device.','sync')}${card('help','Help','A little guidance when you need it.','book')}</div><details class="pearl-advanced" data-disclosure="settings-more"><summary>More settings</summary><div class="pearl-settings-grid">${card('integrations','Integrations','Connect tools your team can use.','globe')}${card('channels','Messaging','Bring your bots into other conversations.','chat')}${card('usage','Usage','See what your bots used, per bot and per day.','activity')}${card('activity','Activity','Review changes on this engine.','activity')}</div></details><button class="text-button" data-action="logout">${icon('logout')}Sign out</button></section>`;
}
// Dashboard and bot profile live in their own scripts; they render from cache, then mount to load fresh data.
const studioContext=()=>({data,api,esc,icon,avatar,botById,botTeammates,sortBotsByMessage,botStatus,statusPill,relative,timeLabel,shortDate,scheduleLabel,toast,errorText,openDialog,closeDialog,documentPreview,fileEditor,previewFormats,navigate,route,openBotDraft,routineDialog,botSettingsForm,refresh,renderApp,settingsHeading,importDialog,viewSkill,confirmDelete,missionControls});
function openBotDraft(botId,text,{notice='Script request added to the chat draft. Review it, then Send.'}={}){
  if(!auth?.authenticated||!botById(botId)||typeof text!=='string'||!text.trim())return false;
  if(text.length>20000){toast('This script request exceeds the chat draft limit. Use fewer arguments or prepare a routine.',true);return false;}
  pendingBotDraft={botId,text,notice,generation:sendSessionGeneration};const current=route();
  if(current.view==='bot'&&current.id===botId)applyPendingBotDraft(current);else navigate(`/bot/${encodeURIComponent(botId)}`);
  return true;
}
function applyPendingBotDraft(current=route()){
  const draft=pendingBotDraft;if(!draft)return;
  if(draft.generation!==sendSessionGeneration||!auth?.authenticated||current.view!=='bot'||current.id!==draft.botId){pendingBotDraft=null;return;}
  const form=$('#message-form'),field=$('#message-input');if(!field||form?.dataset.id!==draft.botId)return;
  pendingBotDraft=null;const next=field.value?`${field.value}\n\n${draft.text}`:draft.text;
  if(next.length>20000){toast('Your existing draft is too long to append this script request. Shorten it first; your text is unchanged.',true);return;}
  field.value=next;field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();
  toast(draft.notice||'Request added to the chat draft. Review it, then Send.');
}
function missionControls(mission){const run=mission.currentRun,bot=botById(mission.leadBotId);if(!run||!bot||mission.remote||mission.canControl===false)return '';return run.status==='waiting_for_approval'?approvalCard(bot,run):run.status==='waiting_for_input'?(window.StudioBrowser?.renderCard(bot,run)||questionCard(bot,run)):'';}
function renderDashboard(){return window.StudioDashboard?.render(studioContext())||`<section class="page">${pageHeading('Dashboard','A live view of your team’s work.')}<div class="section-empty"><p>Loading…</p></div></section>`;}
function renderBotProfile(id){if(!botById(id))return `<section class="page">${emptyState('bots','This bot isn’t here','It may have been removed. Pick another bot or create one.','create-bot','New bot')}</section>`;return window.StudioBotProfile?.render(studioContext(),id)||`<section class="page"><div class="section-empty"><p>Loading…</p></div></section>`;}
function mountPage(current=route()){const root=$('#main-content');if(!root)return;if(current.view==='desktop')window.TupiesDesktop?.mount(studioContext(),root);else if(current.view==='missions')window.StudioMissions?.mount(studioContext(),root);else if(current.view==='coding')window.TupiesCoding?.mount(studioContext(),root);else if(current.view==='skills')window.StudioSkills?.mount(studioContext(),root);else if(current.view==='dashboard')window.StudioDashboard?.mount(studioContext(),root);else if(current.view==='bots'&&current.id&&botById(current.id))window.StudioBotProfile?.mount(studioContext(),current.id,root);}
function showPage(){
  const root=$('#main-content');if(!root)return;
  const active=document.activeElement,focused=active?.tagName==='SUMMARY'?active.parentElement?.dataset.disclosure:'',disclosures=new Map([...root.querySelectorAll('details[data-disclosure]')].map(node=>[node.dataset.disclosure,node.open]));
  root.innerHTML=renderPage();
  for(const node of root.querySelectorAll('details[data-disclosure]')){if(disclosures.has(node.dataset.disclosure))node.open=disclosures.get(node.dataset.disclosure);if(focused===node.dataset.disclosure)node.querySelector('summary')?.focus();}
  mountPage();
}
function renderPage(current=route()){
  switch(current.view){case 'desktop':return window.TupiesDesktop?.render(studioContext())||'<section class="page"><p>Desktop tools are loading…</p></section>';case 'missions':return window.StudioMissions?.render(studioContext())||'<section class="page"><p>Loading Missions…</p></section>';case 'welcome':return window.StudioOnboarding?.render(studioContext())||renderHelp();case 'dashboard':return renderDashboard();case 'bots':return current.id?renderBotProfile(current.id):renderBots();case 'settings':return renderSettings();case 'help':return renderHelp();case 'rooms':return renderRooms();case 'room':return renderRoom(current.id);case 'bot':return renderChat(current.id);case 'skills':return renderSkills();case 'coding':return window.TupiesCoding?.render(studioContext())||`<section class="page"><p>Coding tools are loading…</p></section>`;case 'routines':return renderRoutines();case 'usage':return window.StudioUsage?.render(studioContext())||`<section class="page"><p>Usage is loading…</p></section>`;case 'activity':return renderActivity();case 'connections':return renderConnections();case 'integrations':return renderIntegrations();case 'channels':return renderChannels();case 'sync':return renderSync();default:return renderDashboard();}
}
function filtered(items,fields){const q=search.toLowerCase().trim();return !q?items:items.filter(item=>fields.some(key=>String(item[key]||'').toLowerCase().includes(q)));}
function botModel(bot){const connection=connectionById(bot.connectionId);return bot.model||connection?.defaultModel||'';}
function botLastActive(bot){const run=data.runs?.[bot.id],event=data.activity.find(a=>a.botId===bot.id),times=[run?.updatedAt,event?.createdAt].filter(Boolean).map(value=>new Date(value).getTime()).filter(Number.isFinite);return times.length?new Date(Math.max(...times)).toISOString():'';}
function sortBotsByMessage(bots){return [...bots].sort((a,b)=>(Date.parse(data.botLastMessageAt?.[b.id])||0)-(Date.parse(data.botLastMessageAt?.[a.id])||0)||String(a.id).localeCompare(String(b.id)));}
function favoriteButton(bot){return `<button type="button" class="icon-button bot-favorite ${bot.favorite?'is-favorite':''}" data-action="toggle-bot-favorite" data-id="${esc(bot.id)}" aria-pressed="${bot.favorite===true}" aria-label="${bot.favorite?'Remove':'Add'} ${esc(bot.name)} ${bot.favorite?'from':'to'} Favorites" title="${bot.favorite?'Remove from Favorites':'Add to Favorites'}">${icon('heart')}</button>`;}
const favoriteSaves=new Set();
function renderBots(){
  const hiddenCount=data.bots.length-visibleBots().length;if(filter==='hidden'&&!hiddenCount)filter='all';
  let bots=filtered(data.bots,['name','title','description']).filter(b=>filter==='hidden'?b.hidden:!b.hidden);
  if(filter==='favorites')bots=bots.filter(b=>b.favorite===true);
  bots=sortBotsByMessage(bots);
  const connected=data.connections.some(c=>c.status==='connected'||c.authenticated===true);
  return `<section class="page">${pageHeading('Bots','A little team for your everyday ideas and work.','create-bot','New bot')}${connected?'':`<div class="setup-card glass-card bots-setup"><span class="setup-icon">${icon('server')}</span><div><h3>Connect a model to get started</h3><p>Bots need a model to think with. Add an API key or sign in with your ChatGPT plan.</p></div><button class="primary-button" data-action="create-connection">Connect a model${icon('arrow')}</button></div>`}<div class="filterbar"><div class="segmented" aria-label="Filter bots"><button class="segment ${filter==='all'?'active':''}" data-filter="all">All <span>${data.bots.length-hiddenCount}</span></button><button class="segment ${filter==='favorites'?'active':''}" data-filter="favorites" aria-pressed="${filter==='favorites'}">Favorites <span>${visibleBots().filter(bot=>bot.favorite===true).length}</span></button>${hiddenCount?`<button class="segment ${filter==='hidden'?'active':''}" data-filter="hidden">Hidden <span>${hiddenCount}</span></button>`:''}</div></div>${filter==='hidden'?'<p class="bots-hidden-note">Hidden bots keep their chats, routines and team roles. They just stay out of the sidebar and this list.</p>':''}<div class="bot-grid">${bots.map(bot=>{const skills=(bot.skills||[]).map(id=>data.skills.find(s=>s.id===id)?.name||id),active=botLastActive(bot);return `<article class="glass-card bot-card ${bot.hidden?'is-hidden':''}" data-nav="/bots/${esc(bot.id)}" title="Open ${esc(bot.name)}’s profile"><div class="card-top"><button class="bot-card-avatar" data-nav="/bots/${esc(bot.id)}" aria-label="Open ${esc(bot.name)}’s profile">${avatar(bot)}</button>${statusPill(bot)}</div><h2 class="bot-name"><button class="bot-card-link" data-nav="/bots/${esc(bot.id)}">${esc(bot.name)}</button></h2><p class="bot-title">${esc(bot.title||'Teammate')}</p><p class="bot-description">${esc(bot.description||'No description yet. Add one in settings.')}</p>${active?`<p class="bot-meta">Active ${esc(relative(active).replace(/^Just now$/,'just now'))}</p>`:''}<div class="skill-tags">${skills.slice(0,2).map(name=>`<span class="tag">${icon('spark')}${esc(name)}</span>`).join('')}${skills.length>2?`<span class="tag">+${skills.length-2}</span>`:''}</div><footer class="bot-card-footer"><button class="open-chat" data-nav="/bot/${esc(bot.id)}">Chat${icon('arrow')}</button>${favoriteButton(bot)}<button class="icon-button" data-action="bot-menu" data-id="${esc(bot.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(bot.name)} options">${icon('more')}</button></footer></article>`;}).join('')}${!search&&filter==='all'?`<button class="add-bot-card" data-action="create-bot"><span class="add-circle">${icon('plus')}</span><span>New bot</span><small>A name, a role, a fresh perspective.</small></button>`:''}</div>${botList(bots)}${!bots.length&&(search||filter!=='all')?filter==='favorites'&&!search?emptyState('heart','No favorites yet','Use a bot’s heart or options menu to keep it here.'):emptyState('search','No bots match','Try a different search or filter.'):''}</section>`;
}
// Bots opens profiles on every layout; chat and quick actions have their own controls.
function botList(bots){
  const rows=bots.map(bot=>{const status=botStatus(bot);return `<li class="bot-row ${bot.hidden?'is-hidden':''}" data-bot-favorite="${bot.favorite===true}"><button class="bot-row-main" data-nav="/bots/${esc(bot.id)}" aria-label="Open ${esc(bot.name)}’s profile">${avatar(bot,'small','row-'+bot.id)}<span class="bot-row-text"><strong>${esc(bot.name)}</strong>${status.text?`<span class="bot-row-status ${status.className}"><i class="dot"></i>${esc(status.text)}</span>`:''}<small>${esc(bot.title||'Teammate')}</small></span></button><button class="icon-button bot-row-chat" data-nav="/bot/${esc(bot.id)}" aria-label="Chat with ${esc(bot.name)}" title="Chat">${icon('chat')}</button><button class="bot-row-more" data-action="bot-menu" data-id="${esc(bot.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(bot.name)} options" title="Options">${icon('more')}</button></li>`;}).join('');
  const add=!search&&filter==='all'?`<li class="bot-row bot-row-new"><button class="bot-row-main" data-action="create-bot"><span class="add-circle">${icon('plus')}</span><span class="bot-row-text"><strong>New bot</strong><small>A name, a role, a fresh perspective</small></span></button></li>`:'';
  return rows||add?`<ul class="bot-list" aria-label="Bots">${rows}${add}</ul>`:'';
}
function renderRooms(){
  const rooms=filtered(data.rooms,['name']);
  return `<section class="page">${pageHeading('Team rooms','Put several bots in one conversation and let them work together.','create-room','New room')}<div class="bot-grid">${rooms.map(room=>{const members=room.botIds.map(botById).filter(Boolean);const drive=data.roomDrives?.[room.id];return `<article class="glass-card room-card"><div class="room-card-top"><div class="avatar-stack">${members.slice(0,4).map(b=>avatar(b,'small')).join('')}</div><button class="icon-button" data-action="edit-room" data-id="${esc(room.id)}" aria-label="Edit ${esc(room.name)}">${icon('more')}</button></div><h2>${esc(room.name)}</h2><p>${esc(members.map(b=>b.name).join(', '))}</p><div class="room-card-footer"><span class="status-pill ${drive&&!terminal.has(drive.status)?'working':''}"><i class="dot"></i>${drive&&!terminal.has(drive.status)?'Team working':'Shared conversation'}</span><button class="open-chat" data-nav="/room/${esc(room.id)}">Open room${icon('arrow')}</button></div></article>`;}).join('')}</div>${!rooms.length?emptyState('team','No team rooms yet','Add two or more bots to a room and give them a task together.','create-room','New room'):''}<div class="info-banner">${icon('info')}<p>Everyone in a room sees the same conversation. Use @all for the whole team or @Name for one bot. Turn on handoffs in room settings to let bots pass work to each other within a set number of turns. Each bot keeps its own memory and files.</p></div></section>`;
}
function renderRoom(id){
  const room=data.rooms.find(r=>r.id===id);if(!room)return missingConversationMarkup('room',id);
  const members=room.botIds.map(botById).filter(Boolean);
  return `<section class="chat-page"><div class="chat-main"><header class="chat-header">${chatBack('rooms')}<span class="setup-icon chat-heading">${icon('team')}</span><div class="chat-heading"><h1>${esc(room.name)}</h1><p>${members.length} teammates · One shared conversation</p></div><button class="chat-switcher" data-action="switch-room" data-id="${esc(id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(room.name)}, switch team room"><span class="chat-switcher-text"><strong><span>${esc(room.name)}</span>${icon('chevronDown')}</strong><small>${members.length} teammates</small></span></button><span class="push"></span><button class="icon-button chat-more" data-action="room-menu" data-id="${esc(id)}" aria-haspopup="menu" aria-expanded="false" aria-label="Room options">${icon('more')}</button></header><div class="chat-thread" id="room-thread"><div class="section-empty"><p>Opening your team room…</p></div></div><div class="chat-composer-wrap"><form id="room-message-form" class="chat-composer" data-id="${esc(id)}"><div class="composer-voice-status" role="status" aria-live="polite"></div><textarea id="room-message-input" name="text" aria-label="Message your team" placeholder="Message the team, or @mention a bot…" rows="2" maxlength="20000" required></textarea><div class="composer-footer"><button type="button" class="icon-button" data-action="dictate" data-target="room-message-input" aria-label="Dictate a message" aria-pressed="false">${icon('mic')}</button><span class="composer-spacer"></span><button class="send" type="submit" aria-label="Send to team">${icon('send')}</button></div></form><p class="composer-hint">No mention sends to everyone · @Name for one bot · Shift + Enter for a new line</p></div></div><aside class="bot-inspector" tabindex="-1" aria-label="Room details"><div class="inspector-heading">YOUR TEAM ROOM<button class="icon-button" data-action="edit-room" data-id="${esc(id)}" aria-label="Edit room">${icon('edit')}</button></div><span class="setup-icon">${icon('team')}</span><h2>${esc(room.name)}</h2><p class="inspector-description">${room.autoCollaborate?'A shared space where teammates can hand off useful work within the room’s task budget.':'A shared space for different perspectives. Each selected bot contributes in order.'}</p>${roomDetails(room,members)}</aside></section>`;
}
function roomDetails(room,members){return `<section class="inspector-section"><h3>Teammates</h3>${members.map(bot=>`<button class="room-member" data-nav="/bot/${esc(bot.id)}">${avatar(bot,'small')}<span><strong>${esc(bot.name)}</strong><small>${esc(bot.title||'Teammate')}</small></span></button>`).join('')}</section><section class="inspector-section"><h3>How the room works</h3><p class="inspector-description">${room.autoCollaborate?`Autonomous handoffs are enabled, with a maximum of ${esc(room.maxRounds||4)} collaboration turns. Bots can delegate to room members while Tupies tracks the task.`:'Bots work in order, once per round.'} Stop cancels queued turns and asks the active bot to stop.</p></section><p class="subtle-label">Individual bot workspaces, memories, and conversations remain separate.</p>`;}
function renderRoomThread(id){
  const room=data.rooms.find(r=>r.id===id),container=$('#room-thread');if(!room||!container||route().id!==id)return;
  const nearBottom=!container.__searchAnchor&&container.scrollTop+container.clientHeight>=container.scrollHeight-80;const {messages=[],drive,activeRun}=roomChat;
  let html=messages.length?messages.map(m=>messageMarkup(m,botById(m.botId),'thread-'+messageKey(m))).join(''):roomChat.loadError?'':`<div class="chat-welcome"><div class="avatar-stack large-stack">${room.botIds.slice(0,4).map(botById).filter(Boolean).map((b,index)=>avatar(b,'','room-welcome-'+index)).join('')}</div><h2>Good company. Fresh possibilities.</h2><p>Give the team something to think about. Everyone takes a turn, or @mention the specialist you need.</p></div>`;
  if(drive&&!terminal.has(drive.status)){
    const active=botById(drive.activeBotId||drive.currentBotId),run=activeRun||(active?data.runs?.[active.id]:null);
    if(run?.partialOutput&&active)html+=`<article class="chat-message partial-message">${avatar(active,'tiny','thread-partial')}<div class="message-content"><div class="message-label">${esc(active.name)}<span class="streaming-label">Working</span></div>${messageText(run.partialOutput,{streaming:!!run&&!terminal.has(run.status)})}</div></article>`;
    html+=renderTimeline(activeRun,taskDetailsOpen(container,activeRun));
    const stopRoom=`<button class="thinking-stop" data-action="stop-room" data-id="${esc(id)}" data-drive="${esc(JSON.stringify({driveId:drive.id}))}" ${drive.id?'':'disabled'}>${icon('stop')}Stop</button>`;
    if(active&&run?.status!=='waiting_for_approval'){
      const phase=drive.status==='stopping'?{energy:'calm',text:'is stopping'}:run&&!terminal.has(run.status)?thinkingPhase(active,run):{energy:'calm',text:'is taking a turn'};
      const task=messages.findLast?.(message=>message.role==='user'&&message.driveId===drive.id)?.content||'';
      html+=thinkingMarkup(active,{...run,createdAt:run?.createdAt||drive.createdAt,...(drive.status==='stopping'?{status:'stopping'}:{})},{key:`room-${drive.id||id}`,compact:!!run?.partialOutput,stop:stopRoom,phase,prompt:task});
    }
    else html+=`<div class="run-status"><i class="dot"></i>${esc(drive.status==='stopping'?'Stopping this round…':active?`${active.name} is taking a turn…`:'Your team is getting started…')}${stopRoom.replace('class="thinking-stop"','class="text-button"')}</div>`;
    if(run?.status==='waiting_for_approval')html+=`<div class="approval-card"><h3>${esc(active.name)} needs your approval</h3><p>Review the exact action in ${esc(active.name)}’s chat before this round can continue.</p><div class="approval-actions"><button class="secondary-button" data-nav="/bot/${esc(active.id)}">Review action${icon('arrow')}</button></div></div>`;
  }
  for(const member of room.botIds.map(botById).filter(Boolean)){if(member.id===drive?.currentBotId||data.runs?.[member.id]?.status!=='waiting_for_approval')continue;html+=`<div class="approval-card"><h3>${esc(member.name)} needs your approval</h3><p>A delegated action is waiting. Review its exact details before the team continues.</p><div class="approval-actions"><button class="secondary-button" data-nav="/bot/${esc(member.id)}">Review action${icon('arrow')}</button></div></div>`;}
  if(drive?.error)html+=`<div class="run-status run-error">${icon('info')}<span>${esc(typeof drive.error==='string'?drive.error:JSON.stringify(drive.error))}</span></div>`;
  html+=conversationErrorMarkup(roomChat.loadError,id,true);
  updateThreadContent(container,html);window.StudioThinking?.mount(container);if(nearBottom)container.scrollTop=container.scrollHeight;if(!roomChat.loadError)focusSearchMessage(container,'room',id);
  observeSpeechReplies('room/'+id,messages);
  const button=$('#room-message-form .send');if(button)button.disabled=!!drive&&!terminal.has(drive.status);
}
async function loadRoomChat(id,{poll=false}={}){
  const request=++messageRequest;if(roomChat.id!==id)roomChat={messages:[],drive:null,activeRun:null,id};const previous=roomChat;
  const currentThread=()=>{const current=route();return request===messageRequest&&auth?.authenticated&&current.view==='room'&&current.id===id?$('#room-thread'):null;};
  try{
    const etag=poll&&previous.etag&&currentThread()?.__roomEtag===previous.etag?previous.etag:'',response=await api(`/api/rooms/${encodeURIComponent(id)}/messages`,{etag});if(!currentThread())return;
    const result=response.notModified?{messages:previous.messages,drive:previous.drive,id,etag}:{...response.body,id,etag:response.etag};let activeRun=null,loadError=null;
    if(result.drive?.currentBotId){try{const status=await api(`/api/bots/${encodeURIComponent(result.drive.currentBotId)}/run`);activeRun=status.run||null;}catch(error){activeRun=previous.drive?.currentRunId===result.drive.currentRunId?previous.activeRun:null;loadError=conversationLoadError(error,true);}}
    if(!currentThread())return;roomChat={messages:[],drive:null,...result,activeRun,loaded:true,loadError};
    // A global settings refresh must not discard a conversation response that already succeeded.
    try{await refresh(false);}catch{}
    const container=currentThread();if(!container)return;renderRoomThread(id);container.__roomEtag=roomChat.etag;
  }catch(error){if(!currentThread())return;roomChat.loadError=conversationLoadError(error,roomChat.loaded);renderRoomThread(id);}
}
function roomDialog(id){
  const room=data.rooms.find(r=>r.id===id)||{};
  openDialog(id?'Room settings':'New team room',`<p class="modal-subtitle">Give your team a shared space. Choose 2–8 teammates to join the conversation.</p><form id="room-form" data-id="${esc(id||'')}"><div class="field"><label for="room-name">Room name</label><input id="room-name" name="name" value="${esc(room.name||'')}" maxlength="100" placeholder="e.g. The thinking room" required></div><div class="field"><span class="field-label">Teammates</span><div class="room-member-picker">${data.bots.map(bot=>`<label class="room-member"><input type="checkbox" name="member" value="${esc(bot.id)}" ${(room.botIds||[]).includes(bot.id)?'checked':''}>${avatar(bot,'small')}<span><strong>${esc(bot.name)}</strong><small>${esc(bot.title||'Teammate')}</small></span>${statusPill(bot)}</label>`).join('')}</div></div><details class="pearl-advanced"><summary>Collaboration settings</summary><label class="checkbox-field"><input type="checkbox" name="autoCollaborate" ${room.autoCollaborate?'checked':''}>Let bots hand off work autonomously</label><div class="field"><label for="room-rounds">Maximum collaboration turns</label><input id="room-rounds" name="maxRounds" type="number" min="1" max="8" value="${esc(room.maxRounds||4)}"><small>Each handoff stays inside the room’s membership and this task budget. Stop cancels queued work.</small></div></details>${modalFooter(id?'Save room':'Create team room',id?`<button class="danger-button" type="button" data-action="delete-room" data-id="${esc(id)}">Remove room</button>`:'')}</form>`);
}
function emptyState(ico,title,description,action,label){return `<div class="section-empty">${icon(ico)}<h3>${title}</h3><p>${description}</p>${action?`<button class="secondary-button" data-action="${action}">${icon('plus')}${label}</button>`:''}</div>`;}
function renderSkills(){if(window.StudioSkills)return window.StudioSkills.render(studioContext());const skills=filtered(data.skills,['name','description','id']);return `<section class="page settings-page">${settingsHeading('skills','Reusable playbooks your bots can follow. Works with Hermes SKILL.md files.','import-skill','Import skill','upload')}<div class="skill-grid">${skills.map(skill=>`<button class="skill-card glass-card" data-action="view-skill" data-id="${esc(skill.id)}"><span class="skill-icon">${icon('spark')}</span><h3>${esc(skill.name||skill.id)}</h3><p>${esc(skill.description||'A reusable set of instructions for your bots.')}</p><footer><span>${skill.resourceCount?`${esc(skill.resourceCount)} resource files`:'Hermes SKILL.md'}</span><span>${data.bots.filter(b=>(b.skills||[]).includes(skill.id)).length} bots ${icon('arrow')}</span></footer></button>`).join('')}</div>${!skills.length?emptyState('spark','No skills yet','Import a SKILL.md to give your bots a proven way to do a task.','import-skill','Import skill'):''}<div class="info-banner">${icon('info')}<p>Imported skills are saved as SKILL.md files and included in your bot’s run instructions when assigned. Assigned skill folders are available directly to Tupies Engine. Bots can read references and request permission to run scripts; importing a folder never executes it.</p></div></section>`;}
function renderRoutines(){const routines=filtered(data.routines,['name','prompt']);return `<section class="page">${pageHeading('Routines','Recurring tasks a bot runs on a schedule.','create-routine','New routine')}<div class="routine-list">${routines.map(r=>{const bot=botById(r.botId);return `<article class="routine-card glass-card">${avatar(bot||{},'small')}<div class="routine-info"><h3>${esc(r.name)}</h3><p>${esc(r.prompt)}</p><small>${esc(bot?.name||'Bot unavailable')} · ${esc(scheduleLabel(r))}${r.enabled&&r.nextRunAt?` · Next ${esc(whenLabel(r.nextRunAt))}`:''}${r.completedAt?' · Done':''}${r.lastRunAt?` · Last run ${esc(relative(r.lastRunAt))}`:''}${r.missedRuns?` · ${r.missedRuns} skipped while offline`:''}</small></div><div class="routine-actions"><button class="switch ${r.enabled?'on':''}" role="switch" aria-checked="${!!r.enabled}" aria-label="${r.enabled?'Pause':'Enable'} ${esc(r.name)}" data-action="toggle-routine" data-id="${esc(r.id)}"></button><button class="icon-button" data-action="run-routine" data-id="${esc(r.id)}" aria-label="Run ${esc(r.name)} now">${icon('play')}</button><button class="icon-button" data-action="routine-history" data-id="${esc(r.id)}" aria-label="${esc(r.name)} history">${icon('clock')}</button><button class="icon-button" data-action="edit-routine" data-id="${esc(r.id)}" aria-label="Edit ${esc(r.name)}">${icon('more')}</button></div></article>`;}).join('')}</div>${!routines.length?emptyState('routine','No routines yet','Schedule a morning briefing, a weekly review or any regular check-in. Routines run while Tupies is running.','create-routine','New routine'):''}<div class="info-banner">${icon('clock')}<p>Routines run on the home server at the times you set, in their time zone, while it is online. Results arrive in the assigned bot’s chat. A run that falls due while Tupies is offline runs once when it is back, or is skipped, as you choose.</p></div></section>`;}
function activityTitle(a){return a.title||a.message||a.description||a.action||a.type||'Workspace updated';}
function renderActivity(){const activity=filtered(data.activity,['title','message','description','action','type']);return `<section class="page settings-page">${settingsHeading('activity','Changes on this engine, newest first.')}<div class="activity-list glass-card">${activity.map(a=>`<article class="activity-row"><span class="activity-symbol">${icon(String(a.type||a.action||'').includes('run')?'activity':'check')}</span><div><h3>${esc(activityTitle(a))}</h3>${a.detail?`<p>${esc(typeof a.detail==='string'?a.detail:JSON.stringify(a.detail))}</p>`:''}</div><time datetime="${esc(a.createdAt||a.timestamp||'')}">${esc(relative(a.createdAt||a.timestamp))}</time></article>`).join('')}</div>${!activity.length?emptyState('activity','Nothing here yet','Changes to bots, models, tools and routines will show up here.'):''}</section>`;}
function providerMeta(type){return providerCatalog.find(p=>p.type===type)||{type,name:type==='legacy-hermes'?'Previous Hermes gateway':String(type||'')||'Model provider'};}
/** Catalog-driven provider presentation: a provider without authentication is a local endpoint; one without a default base URL needs an endpoint. */
function providerLocal(type){return providerMeta(type).auth==='none';}
function providerBadge(p){return `<span class="provider-letter" aria-hidden="true">${esc(String(p?.name||p?.type||'?').trim().slice(0,1).toUpperCase()||'?')}</span>`;}
function providerSubtitle(p){return oauthProvider(p.type)?'Sign in with your plan':p.auth==='none'?'Local endpoint':'API key';}
function modelItems(models){return (Array.isArray(models)?models:[]).map(m=>typeof m==='string'?{id:m,name:m}:{id:m.id||m.model||m.name,name:m.name||m.id||m.model}).filter(m=>m.id);}
function oauthProvider(type){return ['chatgpt','codex'].includes(type);}
function safeLink(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;}}
function renderConnections(){
  const providers=providerCatalog.length?providerCatalog:[];
  return `<section class="page settings-page">${settingsHeading('connections','Connect the AI models your bots think with. Keys stay sealed on this server.','create-connection','Add provider')}<div class="provider-choice-grid">${providers.filter(p=>p.type!=='hermes').map(p=>`<button class="provider-choice glass-card" data-action="choose-provider" data-type="${esc(p.type)}">${providerBadge(p)}<strong>${esc(p.name||p.type)}</strong><small>${providerSubtitle(p)}</small>${icon('arrow')}</button>`).join('')}</div><div class="section-label providers-saved-label">Your providers</div><div class="connection-list">${data.connections.map(c=>{const p=providerMeta(c.type);const legacy=c.type==='legacy-hermes';const account=c.oauthAccount?.email||c.oauthAccount?.name||c.account?.email||c.account?.name||'';return `<article class="connection-card glass-card">${providerBadge(p)}<div class="connection-info"><h3>${esc(c.name)}</h3><p>${esc(p.name)}${account?` · ${esc(account)}`:''}${c.defaultModel?` · ${esc(c.defaultModel)}`:''}</p><div class="connection-capabilities"><span class="tag">${oauthProvider(c.type)?'Subscription sign-in':p.auth==='none'?'Local endpoint':c.hasKey?'Key encrypted on server':'Credentials needed'}</span><span class="tag">${data.bots.filter(b=>b.connectionId===c.id).length} bots assigned</span>${data.settings.defaultConnectionId===c.id?'<span class="tag workspace-default-tag">Workspace default</span>':''}</div>${c.error?`<p class="connection-error">${esc(c.error)}</p>`:''}</div><span class="status-pill ${c.status==='connected'?'ready':c.status==='error'?'error':''}"><i class="dot"></i>${legacy?'Migration needed':c.status==='connected'?'Connected':c.status==='error'?'Needs attention':'Finish setup'}</span><div class="connection-actions">${legacy?`<button class="secondary-button" data-action="create-connection">Choose a provider</button>`:oauthProvider(c.type)?`<button class="secondary-button" data-action="provider-login" data-id="${esc(c.id)}">${c.status==='connected'?'Account':'Sign in'}</button>`:`<button class="secondary-button" data-action="test-connection" data-id="${esc(c.id)}">Test</button>`}${legacy?'':`${c.status==='connected'?`<button class="secondary-button" data-action="choose-default-model" data-id="${esc(c.id)}">${c.defaultModel?'Change default model':'Choose default model'}</button>`:''}<button class="secondary-button" data-action="assign-provider" data-id="${esc(c.id)}">Use for a bot</button>`}<button class="icon-button" data-action="edit-connection" data-id="${esc(c.id)}" aria-label="Edit ${esc(c.name)}">${icon('more')}</button></div></article>`;}).join('')}</div>${!data.connections.length?emptyState('plug','No models connected yet','Pick a provider above, or add any OpenAI-compatible endpoint.','create-connection','Add provider'):''}<div class="info-banner">${icon('shield')}<p>Provider secrets stay encrypted on your server. Several bots can use the same provider while keeping separate memory, files, instructions, and conversations. A successful connection test checks access; model use still depends on your provider plan and account.</p></div></section>`;
}

const chatBack=fallback=>`<button class="icon-button chat-back" data-nav="/${esc(lastTab||fallback)}" aria-label="Back">${icon('back')}</button>`;
const switcherStatus=bot=>{const status=botStatus(bot);return `<small class="chat-switcher-status ${status.className}" ${status.text?'':'hidden'}>${status.text?`<i class="dot"></i>${esc(status.text)}`:''}</small>`;};
function renderChat(id){
  const bot=botById(id);if(!bot)return missingConversationMarkup('bot',id);
  const connection=connectionById(bot.connectionId);
  return `<section class="chat-page"><div class="chat-main"><header class="chat-header">${chatBack('bots')}<a class="chat-identity" href="#/bots/${esc(id)}" title="Open ${esc(bot.name)}’s profile">${avatar(bot,'small')}<div><h1>${esc(bot.name)}</h1><p>${esc(bot.title||'Teammate')}</p></div></a><button class="chat-switcher" data-action="switch-bot" data-id="${esc(id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(bot.name)}, switch bot">${avatar(bot,'tiny','switcher')}<span class="chat-switcher-text"><strong><span>${esc(bot.name)}</span>${icon('chevronDown')}</strong>${switcherStatus(bot)}</span></button><span class="push"></span><span class="chat-tools">${statusPill(bot)}</span><button class="icon-button chat-new" data-action="new-chat" data-id="${esc(id)}" title="New chat" aria-label="Start a new chat with ${esc(bot.name)}">${icon('plus')}</button><button class="icon-button chat-more" data-action="chat-menu" data-id="${esc(id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(bot.name)} options">${icon('more')}</button></header><div class="chat-thread" id="chat-thread"><div class="section-empty"><p>Opening your conversation…</p></div></div><div class="chat-composer-wrap"><form id="message-form" class="chat-composer" data-id="${esc(id)}">${attachmentComposer(id)}<input type="file" id="chat-attachments" class="file-input" data-bot="${esc(id)}" accept=".pdf,.md,.docx,.pptx,.xlsx,.csv,.txt,.json,.png,.jpg,.jpeg,.webp" multiple><div class="composer-voice-status" role="status" aria-live="polite"></div><textarea id="message-input" name="text" aria-label="Message ${esc(bot.name)}" placeholder="Message ${esc(bot.name)}…" rows="2" maxlength="20000"></textarea><div class="composer-footer"><button type="button" class="icon-button" data-action="attach-files" data-id="${esc(id)}" aria-label="Attach files" title="Attach up to 5 files · 20 MB combined">${icon('plus')}</button>${chatReviewControl(bot)}${connection?'':`<button type="button" class="composer-model-button" data-action="edit-bot" data-id="${esc(id)}"><span id="composer-model-summary">Connect to start</span>${icon('chevron')}</button>`}<span class="composer-spacer"></span>${chatInferenceBar(bot)}<button type="button" class="icon-button composer-mic-button" data-action="dictate" data-target="message-input" aria-label="Dictate a message" aria-pressed="false" title="Dictate a message">${icon('mic')}</button><button type="button" class="direction-send" data-action="send-direction" data-id="${esc(id)}" aria-label="Add direction" hidden>${icon('send')}</button><button class="send" type="submit" aria-label="Send message">${icon('send')}</button></div><p id="chat-approval-status" class="composer-review-status" role="status" aria-live="polite" ${chatReviewNote(bot)?'':'hidden'}>${esc(chatReviewNote(bot))}</p><p class="direction-result" role="status" aria-live="polite"></p></form><p class="composer-hint">Enter to send · Shift + Enter for a new line · Attach PDFs, documents, sheets or images</p></div></div><aside class="bot-inspector" tabindex="-1" aria-label="Bot details"><div class="inspector-heading">YOUR TEAMMATE<button class="icon-button" data-action="toggle-inspector" aria-label="Close bot details">${icon('close')}</button></div>${avatar(bot,'large')}<h2>${esc(bot.name)}</h2><p class="role">${esc(bot.title||'Teammate')}</p><p class="inspector-description">${esc(bot.description||'No description yet.')}</p><section class="inspector-section"><h3>Intelligence</h3><div class="info-row"><span>Provider</span><strong>${esc(connection?.name||'Choose a provider')}</strong></div><div class="info-row"><span>Model</span><strong id="inspector-model-name">${esc(bot.model||connection?.defaultModel||'Provider default')}</strong></div><button class="text-button" data-action="edit-bot" data-id="${esc(id)}">${connection?'Manage settings':'Connect this bot'}${icon('arrow')}</button></section><section class="inspector-section"><h3>A space of their own</h3><button class="inspector-resource" data-action="bot-memory" data-id="${esc(id)}">${icon('book')}Memory${icon('arrow')}</button><button class="inspector-resource" data-action="bot-files" data-id="${esc(id)}">${icon('file')}Workspace & files${icon('arrow')}</button></section><section class="inspector-section"><h3>Skills & integrations</h3>${(bot.skills||[]).map(skillId=>`<span class="tag">${icon('spark')}${esc(data.skills.find(s=>s.id===skillId)?.name||skillId)}</span>`).join('')}${(bot.integrationIds||[]).map(integrationId=>`<span class="tag">${icon('plug')}${esc(data.integrations.find(i=>i.id===integrationId)?.name||integrationId)}</span>`).join('')}${!(bot.skills||[]).length&&!(bot.integrationIds||[]).length?'<p class="subtle-label">Give this bot the right know-how and tools.</p>':''}<br><button class="text-button" data-action="edit-bot" data-id="${esc(id)}">Bot settings${icon('arrow')}</button></section><section class="inspector-section"><h3>Teammates</h3>${botTeammates(bot).map(b=>`<button class="room-member" data-nav="/bot/${esc(b.id)}">${avatar(b,'tiny')}<span><strong>${esc(b.name)}</strong><small>${esc(b.title)}</small></span></button>`).join('')||`<p class="subtle-label">${bot.teamMode==='selected'?'Choose teammates in bot settings so this bot can talk with them.':'Add another bot and they can work together.'}</p>`}</section><section class="inspector-section"><h3>Routines</h3>${data.routines.filter(r=>r.botId===id).map(r=>`<div class="info-row"><span>${esc(r.name)}</span><strong>${r.enabled?'Scheduled':'Paused'}</strong></div>`).join('')||'<p class="subtle-label">Make good work a habit.</p>'}<button class="text-button" data-action="create-routine" data-bot="${esc(id)}">Add a routine${icon('plus')}</button></section></aside></section>`;
}

const prompts = bot => /research|scout/i.test(`${bot.name} ${bot.title}`)?['Research a topic and compare the best sources.','Help me turn a question into a research brief.']:/creative|nova|design/i.test(`${bot.name} ${bot.title}`)?['Help me shape an idea into a creative brief.','Give me three fresh directions for a project.']:['Help me plan the week ahead.','Turn a messy idea into a clear action plan.'];
const richCache=new Map();let richCacheSize=0;
/** Finished replies render once: their sanitized Markdown is memoized by text within a bounded character budget. */
function richText(text){
  let html=richCache.get(text);
  if(html!==undefined){richCache.delete(text);richCache.set(text,html);return html;}
  html=window.StudioRich.render(text,{streaming:false});if(text.length>40000)return html;
  richCache.set(text,html);richCacheSize+=text.length+html.length;
  for(const [key,value] of richCache){if(richCacheSize<=4_000_000)break;richCache.delete(key);richCacheSize-=key.length+value.length;}
  return html;
}
function messageText(value,{streaming=false}={}){const text=typeof value==='string'?value:JSON.stringify(value??'');return window.StudioRich?.render?`<div class="message-text rich-prose">${streaming?window.StudioRich.render(text,{streaming}):richText(text)}</div>`:`<div class="message-text">${esc(text)}</div>`;}
function missionMessageAnchor(message){const first=[...(chat.messages||[]),...(roomChat.messages||[])].find(item=>item.missionId===message.missionId);return !first||first.id===message.id;}
function messageKey(message){const value=JSON.stringify([message.id,message.role,message.content??message.text,message.createdAt,message.partial,message.attachments,message.missionId?[window.StudioMissions?.fingerprint(studioContext(),message.missionId),missionMessageAnchor(message)]:null,...(message.kind==='steer'?[message.steerStatus,message.steerNotice]:[]),...(message.reasoning?[message.reasoning]:[])]);let hash=2166136261;for(let i=0;i<value.length;i++)hash=Math.imul(hash^value.charCodeAt(i),16777619);return 'message-'+(hash>>>0).toString(36);}
function messageMarkup(message,bot,instanceKey=''){
  // A teammate's request keeps the user role for the model but is shown as coming from that bot.
  const asked=message.role==='user'&&message.fromBotId,teammate=asked?botById(message.fromBotId):null,user=message.role==='user'&&!asked,system=message.role==='system',text=message.content??message.text??'';
  return `<article class="chat-message ${user?'user':asked?'from-teammate':''}" data-message-key="${messageKey(message)}" data-search-message-id="${esc(message.id||'')}">${user?'<span class="user-message-avatar">ME</span>':system?brandMark('tiny'):asked?(teammate?avatar(teammate,'tiny',instanceKey&&instanceKey+'-from'):'<span class="user-message-avatar">'+icon('team')+'</span>'):avatar(bot||{},'tiny',instanceKey)}<div class="message-content"><div class="message-label">${user?'You':system?'Tupies':asked?`${esc(teammate?.name||'A teammate')}<span class="teammate-label">${icon('team')}Teammate</span>`:esc(bot?.name||'Teammate')}${message.kind==='progress'?`<span class="streaming-label">${message.incomplete?'Interrupted update':message.partial?'Partial update':'Update'}</span>`:message.partial?'<span class="streaming-label">Partial response</span>':''}${message.kind==='steer'?`<span class="direction-status">${({queued:'Direction queued',applied:'Added to task',cancelled:'Direction cancelled'})[message.steerStatus]||'Direction update'}</span>`:''}<time>${esc(timeLabel(message.createdAt))}</time></div>${!user&&!asked&&message.reasoning?thinkingBlock(message.reasoning):''}${messageText(text)}${missionMessageAnchor(message)?window.StudioMissions?.chatCard(studioContext(),message)||'':''}${message.kind==='steer'&&message.steerNotice?`<p class="direction-message-notice">${esc(String(message.steerNotice).slice(0,1000))}</p>`:''}${!user&&!system&&!asked&&!message.partial&&message.kind!=='progress'&&String(text).trim()?`<div class="message-voice-actions"><button type="button" data-action="read-message" aria-pressed="false">${icon('speaker')}Read aloud</button></div>`:''}${!user&&!system&&!asked&&!message.partial&&message.usage?window.StudioRunUsage?.footer(message.usage)||'':''}${message.attachments?.length?`<div class="message-attachments">${message.attachments.map(file=>window.StudioRich?.attachmentMarkup?window.StudioRich.attachmentMarkup(file,bot?.id||file.botId):`<span class="tag">${icon('file')}${esc(file.name||file.path)}</span>`).join('')}</div>`:''}</div></article>`;
}
/** A bot's question while its task waits: choices and free text for each question, Skip and Stop. The card keeps its node, and so what was typed, across refreshes until the prompt changes. */
function approvalCard(bot,run){
  if(run?.status!=='waiting_for_approval')return '';
  const stopData=esc(JSON.stringify({runId:run.id,remoteRunId:run.remoteRunId||run.id}));
      const pending=Array.isArray(run.pending_controls)?run.pending_controls.find(p=>p.kind==='approval'):run.pending_controls,control=pending||run.approval,requestId=control?.prompt_id||control?.request_id;
      const identity={runId:run.id,remoteRunId:run.remoteRunId||run.id,request_id:requestId,...(Number.isInteger(run.execution_generation)?{execution_generation:run.execution_generation}:{})},canApprove=!!(requestId&&run.id);
      const rawDetail=control?.preview||control?.description||control?.prompt||control?.command||control?.arguments,detail=typeof rawDetail==='string'?rawDetail:rawDetail?JSON.stringify(rawDetail,null,2):'The engine paused before an action. Review the current task details before continuing.';
      const detailMarkup=control?.tool==='workshop_poll_api'?`<p>API parameters: ${esc(JSON.stringify(control.arguments?.arguments||{}))}</p><details class="workshop-request-detail"><summary>Exact request and tool revision</summary><pre>${esc(detail)}</pre></details>`:`<p>${esc(detail)}</p>`;
      // The engine's own check-ins (a reached task budget, a plan that stopped moving) are a plain continue-or-stop question, not an action to inspect.
      if(['task_budget','task_checkpoint'].includes(control?.tool))return `<div class="approval-card is-checkin"><h3>${icon('shield')} ${control.tool==='task_budget'?'Task budget reached':'Progress check'}</h3>${typeof control?.review?.summary==='string'?`<p><strong>${esc(control.review.summary)}</strong></p>`:''}<p>Continue lets it carry on and asks again at the next check; Stop ends the task and keeps the work so far.</p><div class="approval-actions"><button class="secondary-button" data-action="approve" data-choice="deny" data-id="${esc(bot.id)}" data-approval="${esc(JSON.stringify(identity))}" ${canApprove?'':'disabled'}>Stop</button><button class="primary-button" data-action="approve" data-choice="once" data-id="${esc(bot.id)}" data-approval="${esc(JSON.stringify(identity))}" ${canApprove?'':'disabled'}>Continue</button></div></div>`;
      // Ordinary actions are shown in plain words with their inputs; the exact request stays one click away under Details.
      const readable=control?.tool!=='workshop_poll_api'&&window.StudioApprovals?.body(control,detail);
      return `<div class="approval-card"><h3>${icon('shield')} Your approval is needed${control?.tool?` · ${esc(readable?window.StudioApprovals.title(control):control.tool)}`:''}</h3>${readable||`${typeof control?.review?.summary==='string'?`<p><strong>${esc(control.review.summary)}</strong></p>`:''}${typeof control?.review?.riskReason==='string'?`<p>${esc(control.review.riskReason)}</p>`:''}${detailMarkup}`}<div class="approval-actions"><button class="secondary-button" data-action="approve" data-choice="deny" data-id="${esc(bot.id)}" data-approval="${esc(JSON.stringify(identity))}" ${canApprove?'':'disabled'}>Deny</button><button class="primary-button" data-action="approve" data-choice="once" data-id="${esc(bot.id)}" data-approval="${esc(JSON.stringify(identity))}" ${canApprove?'':'disabled'}>Allow once</button><button class="text-button" data-action="stop-run" data-id="${esc(bot.id)}" data-run="${stopData}">Stop task</button></div>${workshopGrantForm(control,bot,identity,canApprove)}</div>`;
}
function questionCard(bot,run){
  const control=(run.pending_controls||[]).find(item=>item?.kind==='question');if(!control)return '';
  const questions=Array.isArray(control.questions)?control.questions:[],key=`question-${control.prompt_id}`;
  const identity=esc(JSON.stringify({runId:run.id,remoteRunId:run.remoteRunId||run.id,request_id:control.prompt_id,execution_generation:run.execution_generation})),stopData=esc(JSON.stringify({runId:run.id,remoteRunId:run.remoteRunId||run.id}));
  if(control.missionProposal===true && window.StudioMissions)return `<div class="question-card mission-proposal-card" data-message-key="${esc(key)}" data-question="${identity}" data-notification-question-id="${esc(control.prompt_id)}"><h3>${icon('mission')}Run this as a Mission?</h3><p>This goal has several dependent outcomes. Keep the team's work, progress and results together. Work waits for your choice.</p>${window.StudioMissions.effortPicker(studioContext())}<div class="approval-actions"><button type="button" class="primary-button" data-action="answer-mission-proposal" data-id="${esc(bot.id)}" data-effort-start>Start Mission · Medium</button><button type="button" class="secondary-button" data-action="decline-mission-proposal" data-id="${esc(bot.id)}">Continue in chat</button><button type="button" class="text-button" data-action="stop-run" data-id="${esc(bot.id)}" data-run="${stopData}">Stop task</button></div></div>`;
  const items=questions.map(question=>{
    const options=Array.isArray(question.options)?question.options:[],name=esc(`${key}-${question.id}`);
    return `<fieldset class="question-item" data-question-id="${esc(question.id)}"><legend class="question-header">${esc(question.header)}</legend><p class="question-prompt">${esc(question.prompt)}</p>${options.length?`<div class="question-options">${options.map(option=>`<label class="question-option"><input type="${question.multiSelect?'checkbox':'radio'}" name="${name}" value="${esc(option.id)}"><span><strong>${esc(option.label)}</strong>${option.description?`<small>${esc(option.description)}</small>`:''}</span></label>`).join('')}</div>`:''}<textarea class="question-text" rows="${options.length?1:2}" maxlength="2000" aria-label="${options.length?'Another answer':'Your answer'}" placeholder="${options.length?'Or write your own answer':'Your answer'}"></textarea></fieldset>`;
  }).join('');
  return `<div class="question-card" data-message-key="${esc(key)}" data-question="${identity}" data-notification-question-id="${esc(control.prompt_id)}"><h3>${icon('chat')}${esc(bot.name)} ${questions.length>1?'has a few questions':'has a question'}</h3>${items}<div class="approval-actions"><button type="button" class="primary-button" data-action="answer-question" data-id="${esc(bot.id)}">Send answer</button><button type="button" class="secondary-button" data-action="skip-question" data-id="${esc(bot.id)}">Skip</button><button type="button" class="text-button" data-action="stop-run" data-id="${esc(bot.id)}" data-run="${stopData}">Stop task</button></div></div>`;
}
function updateThreadContent(container,html){
  if(container.__studioSource===html)return;
  const active=document.activeElement,focusedRun=active?.matches?.('.task-details>summary')&&container.contains?.(active)?active.parentElement.dataset.runId:null;
  if(window.StudioRich?.hydrate&&document.createElement){
    const template=document.createElement('template');template.innerHTML=html;
    const existing=new Map([...container.querySelectorAll('[data-message-key]')].map(node=>[node.dataset.messageKey,node]));
    for(const node of template.content.querySelectorAll('[data-message-key]')){const old=existing.get(node.dataset.messageKey);if(old){node.replaceWith(old);existing.delete(node.dataset.messageKey);}}
    // Live visuals (the thinking waves) move into the fresh markup so their animation carries on.
    const live=new Map([...container.querySelectorAll('[data-keep]')].map(node=>[node.dataset.keep,node]));
    for(const node of template.content.querySelectorAll('[data-keep]')){const old=live.get(node.dataset.keep);if(old)node.replaceWith(old);}
    for(const old of existing.values())window.StudioRich.dispose(old);
    container.replaceChildren(template.content);container.__studioSource=html;window.StudioRich.hydrate(container).catch(()=>{});
  }else if(container.innerHTML!==html)container.innerHTML=html;
  if(focusedRun!==null){const panel=$('.task-details',container);if(panel?.dataset.runId===focusedRun)panel.querySelector('summary')?.focus({preventScroll:true});}
}
function attachmentComposer(botId){const files=composerAttachments.get(botId)||[],uploading=attachmentUploads.has(botId);return `<div class="composer-attachments" id="composer-attachments" aria-live="polite">${files.map((file,index)=>`<span class="attachment-chip">${icon('file')}<span title="${esc(file.name)}">${esc(file.name)}</span><button type="button" data-action="remove-attachment" data-id="${esc(botId)}" data-index="${index}" aria-label="Remove ${esc(file.name)}">${icon('close')}</button></span>`).join('')}${uploading?'<span class="attachment-uploading"><i class="dot"></i>Adding files…</span>':''}${files.some(file=>imageFile.test(file.name||file.path||''))&&imageSight.get(botId)===false?`<span class="attachment-note">${icon('info')}${esc(botById(botId)?.name||'This bot')}’s model can’t see images. It gets only the file name.</span>`:''}</div>`;}
async function checkImageSight(botId){try{const result=await api(`/api/bots/${encodeURIComponent(botId)}/capabilities`);imageSight.set(botId,result?.documents?.imageVision===true);}catch{imageSight.delete(botId);}refreshComposerAttachments(botId);}
function refreshComposerAttachments(botId){const node=$('#composer-attachments');if(node&&route().view==='bot'&&route().id===botId){node.outerHTML=attachmentComposer(botId);const button=$('[data-action=attach-files]');if(button)button.disabled=attachmentUploads.has(botId);}}
async function uploadFiles(botId,files,{attach=false}={}){
  const current=attach?composerAttachments.get(botId)||[]:[];
  if(!files.length)return;
  if(attachmentUploads.has(botId))throw new Error('Please wait for the current files to finish uploading.');
  if(current.length+files.length>5||current.reduce((n,file)=>n+Number(file.size||0),0)+files.reduce((n,file)=>n+file.size,0)>20000000)throw new Error('Choose up to 5 files with a combined size below 20 MB.');
  attachmentUploads.add(botId);refreshComposerAttachments(botId);if(route().view==='bot'&&route().id===botId)renderThread(botById(botId));
  try{const payload=await Promise.all(files.map(async file=>({name:file.name,contentBase64:await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read '+file.name+'.'));reader.readAsDataURL(file);})})));const result=await api(`/api/bots/${encodeURIComponent(botId)}/attachments`,{method:'POST',body:{files:payload}});const uploaded=result.files||result.attachments||[];if(attach){if(!uploaded.length)throw new Error('The files were uploaded, but no attachment paths were returned. Open the workspace to find them.');composerAttachments.set(botId,[...(composerAttachments.get(botId)||[]),...uploaded]);if(uploaded.some(file=>imageFile.test(file.name||file.path||'')))void checkImageSight(botId);}return uploaded;}finally{attachmentUploads.delete(botId);refreshComposerAttachments(botId);if(route().view==='bot'&&route().id===botId)renderThread(botById(botId));}
}
const previewFormats=/\.(?:pdf|docx|pptx|xlsx|csv|md|markdown|png|jpe?g|webp)$/i;
async function documentPreview(botId,filePath){
  const name=String(filePath||'').split('/').at(-1)||'Document';
  openDialog(name,`<div id="document-preview-content" role="status"><p class="rich-loading">Opening your file…</p></div><div class="modal-footer"><a class="secondary-button" href="/api/bots/${encodeURIComponent(botId)}/files/download?path=${encodeURIComponent(filePath)}" download>${icon('file')}Download file</a>${/\.(?:md|markdown|csv|txt)$/i.test(filePath)?`<button class="secondary-button" data-action="edit-text-file" data-id="${esc(botId)}" data-path="${esc(filePath)}">${icon('edit')}Edit text</button>`:''}<button class="primary-button" data-action="close-dialog">Done</button></div>`,{wide:true});
  const dialog=$('dialog');dialog?.classList.add('document-modal');const target=$('#document-preview-content');
  try{const result=await api(`/api/bots/${encodeURIComponent(botId)}/documents/preview?path=${encodeURIComponent(filePath)}`);if(!target?.isConnected||$('dialog')!==dialog)return;target.removeAttribute('role');target.innerHTML=window.StudioRich?.previewMarkup?window.StudioRich.previewMarkup(result):`<pre class="preview-text">${esc(result.text||'Download this file to view it.')}</pre>`;if(window.StudioRich){await window.StudioRich.hydrate(target);const pdf=$('#document-pdf',target);if(pdf)try{await window.StudioRich.renderPDF(pdf,`/api/bots/${encodeURIComponent(botId)}/files/view?path=${encodeURIComponent(filePath)}`);}catch(error){if(pdf.isConnected)pdf.innerHTML=`<p class="preview-error">${esc(errorText(error))} Download the PDF to open it in your reader.</p>`;}const image=$('#document-image',target);if(image&&/^image\/(?:png|jpeg|webp)$/.test(result.mime||'')){const img=document.createElement('img');img.src=`/api/bots/${encodeURIComponent(botId)}/files/view?path=${encodeURIComponent(filePath)}`;img.alt=result.name||name;image.append(img);}}}catch(error){if(target?.isConnected)target.innerHTML=`<div class="preview-error"><p>${esc(errorText(error))}</p><button class="secondary-button" data-action="preview-document" data-id="${esc(botId)}" data-path="${esc(filePath)}">Try again</button></div>`;}
}
const speechController=()=>window.StudioSpeech?.controller;
let speechSubscription=null,voiceDraftTarget=null,chatInferenceState=null,chatSpeechState=null,speechCatalogGeneration=0;
function installSpeech(){const controller=speechController();if(!controller||speechSubscription)return;controller.setTransport({synthesize:(body,signal)=>api('/api/speech/synthesize',{method:'POST',body,signal,responseType:'blob'}),transcribe:(body,signal)=>api('/api/speech/transcribe',{method:'POST',body,signal})});speechSubscription=controller.subscribe(()=>renderSpeechControls());controller.onVoicesChanged(()=>updateVoiceChoices());}
function renderSpeechControls(){
  const state=speechController()?.state||{};
  const preview=$('#speech-preview-status');if(preview)preview.innerHTML=`<span>${esc(state.error||(state.readingKey?.startsWith('preview:')?(state.loadingVoice?'Preparing preview…':'Playing preview'):'Choose a model and voice, then preview the same sample.'))}</span>${state.readingKey?.startsWith('preview:')?'<button type="button" class="text-button" data-action="stop-reading">Stop preview</button>':''}`;
  for(const button of document.querySelectorAll('[data-action="dictate"]')){const listening=state.listening&&button.dataset.target===voiceDraftTarget;button.classList.toggle('voice-active',!!listening);button.setAttribute('aria-pressed',String(!!listening));button.setAttribute('aria-label',listening?'Stop dictation':'Dictate a message');button.title=listening?'Stop dictation':'Dictate a message';}
  for(const bar of document.querySelectorAll('.composer-voice-status')){if(state.listening)bar.innerHTML=`<span><i class="dot"></i>Listening · Dictation stays in your draft</span><button type="button" data-action="stop-dictation">Stop & transcribe</button><button type="button" data-action="cancel-dictation">Cancel</button>`;else if(state.transcribing)bar.innerHTML='<span>Transcribing into your draft…</span><button type="button" data-action="cancel-dictation">Cancel</button>';else if(state.reading||state.loadingVoice)bar.innerHTML=`<span>${state.loadingVoice?'Preparing voice…':'Reading reply aloud'}</span><button type="button" data-action="stop-reading">Stop reading</button>`;else if(state.error)bar.innerHTML=`<span class="voice-error">${esc(state.error)}</span><button type="button" data-action="dismiss-voice-error" aria-label="Dismiss voice message">${icon('close')}</button>`;else bar.innerHTML='';}
  for(const button of document.querySelectorAll('[data-action="read-message"]')){const key=button.closest('[data-message-key]')?.dataset.messageKey,reading=state.reading&&state.readingKey===key;button.innerHTML=icon(reading?'stop':'speaker')+(reading?'Stop reading':'Read aloud');button.setAttribute('aria-pressed',String(!!reading));}
}
function observeSpeechReplies(scope,messages){const controller=speechController();if(controller)controller.observeReplies(scope,messages.map(message=>({key:messageKey(message),text:message.content??message.text??'',role:message.role,partial:message.partial||message.kind==='progress',runStatus:message.runStatus})));renderSpeechControls();}
function cleanupSpeech(){speechController()?.cleanup();voiceDraftTarget=null;}
function stopSpeechForSend(){speechController()?.discardDictation();speechController()?.stopReading();}
async function startDictation(targetId){
  const controller=speechController(),input=document.getElementById(targetId);if(!controller)throw new Error('Voice features could not load. Reload this page, or use your device’s keyboard dictation.');if(!input)return;
  if(controller.state.listening){controller.stopDictation();return;}
  if(controller.state.transcribing){controller.discardDictation();return;}
  if(controller.preferences.engine==='openrouter'){
    if(!controller.preferences.cloudConsent||!controller.preferences.connectionId){await chatOptionsDialog(route().view==='bot'?route().id:undefined);return;}
    voiceDraftTarget=targetId;await controller.startDictation({getDraft:()=>input.value,maxLength:input.maxLength>0?input.maxLength:20000,onDraft:value=>{if(input.isConnected)input.value=value;}});input.focus();return;
  }
  if(!controller.available.recognition){controller.startDictation();return;}
  if(!controller.preferences.noticeAccepted){openDialog('Voice input',`<div class="voice-notice">${icon('mic')}<p>${esc(window.StudioSpeech.recognitionNotice)}</p></div><p class="modal-subtitle">Your browser will ask for microphone access. Choose a speech language in Chat options.</p><div class="modal-footer"><button class="secondary-button" data-action="close-dialog">Cancel</button><button class="primary-button" data-action="accept-dictation" data-target="${esc(targetId)}">Start dictation${icon('mic')}</button></div>`);return;}
  voiceDraftTarget=targetId;controller.startDictation({getDraft:()=>input.value,maxLength:input.maxLength>0?input.maxLength:100000,onDraft:value=>{if(input.isConnected)input.value=value;}});input.focus();
}
function speechOptionsMarkup(){
  const controller=speechController(),preferences=controller?.preferences||{},language=preferences.language||navigator.language||'en-US';
  const languages=[...new Set([language,'en-US','en-GB','uk-UA','pl-PL','ru-RU','de-DE','fr-FR','es-ES','it-IT','pt-BR','ja-JP','ko-KR','zh-CN'])],labels={'en-US':'English (US)','en-GB':'English (UK)','uk-UA':'Українська','pl-PL':'Polski','ru-RU':'Русский','de-DE':'Deutsch','fr-FR':'Français','es-ES':'Español','it-IT':'Italiano','pt-BR':'Português','ja-JP':'日本語','ko-KR':'한국어','zh-CN':'中文'};
  const connections=data.connections.filter(item=>item.type==='openrouter'&&item.hasKey),connectionId=preferences.connectionId||connections[0]?.id||'';
  return `<details class="chat-option-section pearl-advanced" data-voice-settings><summary>Voice & dictation</summary>
    <div class="field"><label for="speech-engine">Voice service</label><select id="speech-engine" name="speechEngine"><option value="openrouter" ${preferences.engine==='openrouter'?'selected':''}>OpenRouter · AI voices</option><option value="browser" ${preferences.engine==='browser'?'selected':''}>Browser · System voices</option></select></div>
    <div class="field"><label for="speech-language">Speech language</label><select id="speech-language" name="speechLanguage">${languages.map(value=>`<option value="${esc(value)}" ${value===language?'selected':''}>${esc(labels[value]||value)}</option>`).join('')}</select><small>Dictation stays in your draft. Choose a voice suited to the language of your replies.</small></div>
    <div id="speech-cloud-options" ${preferences.engine==='browser'?'hidden':''}>
      <div class="field"><label for="speech-connection">OpenRouter connection</label><select id="speech-connection" name="speechConnection">${connections.length?connections.map(item=>`<option value="${esc(item.id)}" ${item.id===connectionId?'selected':''}>${esc(item.name)}</option>`).join(''):'<option value="">Connect OpenRouter first</option>'}</select><small>Your API key stays on the Tupies server.</small></div>
      ${!connections.length?'<p class="voice-availability">Add an OpenRouter API key in Settings › Models to use AI voices. <button type="button" class="text-button" data-nav="/connections" data-close="true">Open Models</button></p>':''}
      <div id="speech-catalog-status" class="voice-preference-note" role="status">${connections.length?'Loading current models and voices…':'No OpenRouter connection is configured.'}</div>
      <div class="field"><label for="speech-ai-model">Reading model</label><select id="speech-ai-model" name="speechModel"></select></div>
      <div class="field"><label for="speech-ai-voice">AI voice</label><select id="speech-ai-voice" name="speechAIVoice"></select><small>Each model has its own voices. Your choice is remembered for each model.</small></div>
      <div class="field"><label for="speech-transcription">Dictation model</label><select id="speech-transcription" name="transcriptionModel"></select><small>Record up to 60 seconds, then stop to transcribe. Send remains a separate action.</small></div>
      <div class="voice-online-notice"><p>${esc(window.StudioSpeech?.cloudNotice||'OpenRouter and the selected provider process recordings and reply text. API usage is billed to your account.')}</p><label class="checkbox-field"><input type="checkbox" name="cloudSpeechConsent" ${preferences.cloudConsent?'checked':''}>Allow OpenRouter speech processing</label></div>
      <div class="speech-preview"><div class="field"><label for="speech-preview-text">Compare with the same sample</label><textarea id="speech-preview-text" rows="3" maxlength="600">${esc(window.StudioSpeech?.previewText||'Hello, I’m your Tupies teammate. Let’s explore a few ideas together.')}</textarea><small>Previews use paid API requests. Replaying an unchanged sample uses this page’s temporary audio cache.</small></div><div class="speech-preview-models">${[['elevenlabs/eleven-v4-turbo','Eleven v4 Turbo'],['google/gemini-3.8-flash-tts','Gemini 3.8 Flash TTS'],['fish-audio/drama-3','Fish Drama 3']].map(([id,name])=>`<button type="button" class="secondary-button" data-action="preview-ai-voice" data-model="${id}" disabled>${icon('play')}${name}</button>`).join('')}</div><div id="speech-preview-status" role="status" aria-live="polite"></div></div>
      <button type="button" class="text-button" data-action="refresh-speech-catalog">Refresh models & voices</button>
    </div>
    <div id="speech-browser-options" ${preferences.engine==='openrouter'?'hidden':''}>${!controller?.available.recognition?`<p class="voice-availability">${esc(window.StudioSpeech?.recognitionFallback||'Use your device’s keyboard dictation in the draft.')}</p>`:''}<div class="field"><label for="speech-voice">Reading voice</label><select id="speech-voice" name="speechVoice"><option value="">Automatic · On-device voice only</option></select><small id="speech-voice-hint">Loading browser voices…</small></div><div id="speech-remote-notice" class="voice-online-notice" hidden><p>Online voices may send reply text to their provider for processing.</p><label class="checkbox-field"><input type="checkbox" name="allowRemoteVoice" ${preferences.allowRemoteVoice?'checked':''}>Allow this online voice to process reply text</label></div></div>
    <label class="checkbox-field voice-auto-option"><input type="checkbox" name="autoRead" ${preferences.autoRead?'checked':''}>Read new completed replies aloud automatically</label><small class="voice-preference-note">Off by default. Voice preferences are saved only in this browser.</small></details>`;
}
function updateSpeechEngine(){const cloud=$('#speech-engine')?.value==='openrouter';$('#speech-cloud-options').hidden=!cloud;$('#speech-browser-options').hidden=cloud;const consent=$('[name=cloudSpeechConsent]');if(consent)consent.required=cloud&&$('#chat-options-form')?.dataset.voiceDirty==='true';updateRemoteVoiceNotice();speechController()?.stopReading();speechController()?.discardDictation();}
function rememberCloudVoice(){const select=$('#speech-ai-voice');if(select?.dataset.model&&select.value&&chatSpeechState)chatSpeechState.voices[select.dataset.model]=select.value;}
function updateCloudVoices(){
  const select=$('#speech-ai-voice'),model=$('#speech-ai-model')?.value;if(!select)return;const entry=chatSpeechState?.catalog?.speech?.find(item=>item.id===model),saved=chatSpeechState?.voices?.[model],voices=entry?.voices||[];
  select.innerHTML=voices.length?voices.map((voice,index)=>`<option value="${esc(voice)}" ${voice===saved?'selected':''}>${esc(entry.voiceLabels?.[voice]||(/^[a-z0-9]{20,}$/i.test(voice)?`Voice ${index+1} · ${voice.slice(0,10)}…`:voice.charAt(0).toUpperCase()+voice.slice(1)))}</option>`).join(''):'<option value="">No voices available · Refresh catalog</option>';select.dataset.model=model||'';rememberCloudVoice();
}
async function loadSpeechCatalog(refresh=false){
  const form=$('#chat-options-form'),status=$('#speech-catalog-status'),connectionId=$('#speech-connection')?.value,generation=++speechCatalogGeneration;if(!form||!connectionId)return;
  const preferences=speechController().preferences,old=chatSpeechState;rememberCloudVoice();chatSpeechState={catalog:null,voices:{...preferences.modelVoices,...old?.voices}};for(const button of form.querySelectorAll('[data-action=preview-ai-voice]'))button.disabled=true;status.textContent='Loading current models and voices…';
  const selectedModel=$('#speech-ai-model')?.value||preferences.speechModel,selectedTranscription=$('#speech-transcription')?.value||preferences.transcriptionModel;
  try{
    const catalog=await api(`/api/speech/catalog?connectionId=${encodeURIComponent(connectionId)}${refresh?'&refresh=true':''}`);if(!form.isConnected||generation!==speechCatalogGeneration)return;chatSpeechState.catalog=catalog;
    const names=[['elevenlabs/eleven-v4-turbo','Eleven v4 Turbo · Default'],['google/gemini-3.8-flash-tts','Gemini 3.8 Flash TTS'],['fish-audio/drama-3','Fish Drama 3']];
    $('#speech-ai-model').innerHTML=names.map(([id,name])=>`<option value="${id}" ${id===selectedModel?'selected':''} ${catalog.speech?.some(item=>item.id===id&&item.voices?.length)?'':'disabled'}>${name}${catalog.speech?.some(item=>item.id===id&&item.voices?.length)?'':' · Unavailable'}</option>`).join('');
    $('#speech-transcription').innerHTML=(catalog.transcription||[]).map(item=>`<option value="${esc(item.id)}" ${item.id===selectedTranscription?'selected':''}>${esc(item.name)}</option>`).join('');updateCloudVoices();status.textContent='Models and voices are current. Preview a sample before saving.';
    for(const button of form.querySelectorAll('[data-action=preview-ai-voice]'))button.disabled=!catalog.speech?.some(item=>item.id===button.dataset.model&&item.voices?.length);renderSpeechControls();
  }catch(error){if(form.isConnected&&generation===speechCatalogGeneration)status.textContent=errorText(error);}
}
function cloudSpeechOptions(){
  rememberCloudVoice();const connectionId=$('#speech-connection')?.value,speechModel=$('#speech-ai-model')?.value,transcriptionModel=$('#speech-transcription')?.value,cloudConsent=!!$('[name=cloudSpeechConsent]')?.checked,catalog=chatSpeechState?.catalog;
  if(!cloudConsent)throw new Error('Allow OpenRouter speech processing before previewing or saving AI voices.');
  if(!connectionId||catalog?.connectionId!==connectionId)throw new Error('Load models from an OpenRouter connection first.');
  const model=catalog.speech.find(item=>item.id===speechModel);if(!model?.voices.includes(chatSpeechState.voices[speechModel]))throw new Error('Choose an available model and voice.');if(!catalog.transcription.some(item=>item.id===transcriptionModel))throw new Error('Choose an available dictation model.');
  return {engine:'openrouter',connectionId,speechModel,transcriptionModel,cloudConsent,modelVoices:{...chatSpeechState.voices}};
}
async function previewCloudVoice(model){
  const form=$('#chat-options-form');if(form)form.dataset.voiceDirty='true';
  const error=$('.form-error',$('#chat-options-form'));if(error)error.textContent='';speechController()?.clearError();
  rememberCloudVoice();const select=$('#speech-ai-model');if(select.value!==model){speechController()?.stopReading();select.value=model;updateCloudVoices();}const text=$('#speech-preview-text')?.value.trim();if(!text)throw new Error('Enter a short sample to preview.');
  await speechController().read(text,{key:`preview:${model}`,settings:cloudSpeechOptions()});
}
function updateVoiceChoices(){
  const select=$('#speech-voice'),controller=speechController();if(!select||!controller)return;const current=select.dataset.loaded?select.value:controller.preferences.voiceURI,voices=controller.getVoices();select.innerHTML='<option value="">Automatic · On-device voice only</option>'+voices.map(voice=>`<option value="${esc(voice.uri)}" ${voice.uri===current?'selected':''}>${esc(voice.name)} · ${esc(voice.lang)} · ${voice.local?'On device':'Online'}</option>`).join('');select.dataset.loaded='true';const hint=$('#speech-voice-hint');if(hint)hint.textContent=voices.length?'Automatic reading uses an available on-device voice. Online voices require your explicit choice.':'No browser voices are available yet. Install an on-device system voice, or try your device’s screen reader.';updateRemoteVoiceNotice();
}
function updateRemoteVoiceNotice(){const select=$('#speech-voice'),controller=speechController(),notice=$('#speech-remote-notice');if(!select||!controller||!notice)return;const chosen=controller.getVoices().find(voice=>voice.uri===select.value),online=!!chosen&&!chosen.local;notice.hidden=!online;const checkbox=$('[name=allowRemoteVoice]',notice);if(checkbox)checkbox.required=online&&$('#speech-engine')?.value==='browser'&&$('#chat-options-form')?.dataset.voiceDirty==='true';}
const chatReviewSaves=new Map(),chatReviewErrors=new Map();
const chatReviewModes={auto:'Approve for me',balanced:'Balanced',strict:'Strict'};
function chatReviewBusy(bot){const current=route(),run=current.view==='bot'&&current.id===bot.id?chat.run||data.runs?.[bot.id]:data.runs?.[bot.id];return !!(run&&!terminal.has(run.status)||data.sync?.busy?.[bot.id]||current.view==='bot'&&current.id===bot.id&&chat.elsewhere);}
function chatReviewNote(bot){return chatReviewErrors.get(bot.id)||(chatReviewSaves.has(bot.id)?'Saving action review…':'');}
function chatReviewControl(bot){
  const value=chatReviewSaves.get(bot.id)?.value||bot.approvalPolicy||'auto',disabled=chatReviewSaves.has(bot.id)||chatReviewBusy(bot);
  return `<div class="composer-review" data-bot="${esc(bot.id)}"><label class="composer-review-chip">${icon('shield')}<select id="chat-approval-policy" aria-label="Action review" aria-describedby="chat-approval-status" data-bot="${esc(bot.id)}" title="Action review: ${esc(chatReviewModes[value])}. Saved for this bot across chats." ${disabled?'disabled':''}>${Object.entries(chatReviewModes).map(([policy,label])=>`<option value="${policy}" ${value===policy?'selected':''}>${label}</option>`).join('')}</select></label></div>`;
}
function updateChatReview(bot){
  const field=$('#chat-approval-policy');if(!bot||field?.dataset.bot!==bot.id)return;
  const saving=chatReviewSaves.has(bot.id),busy=chatReviewBusy(bot),note=$('#chat-approval-status');
  field.value=chatReviewSaves.get(bot.id)?.value||bot.approvalPolicy||'auto';field.disabled=saving||busy;field.setAttribute('aria-busy',String(saving));
  field.title=`Action review: ${chatReviewModes[field.value]}. ${busy?'Finish or stop this task before changing its saved review mode.':'Saved for this bot across chats.'}`;
  if(note){note.textContent=chatReviewNote(bot);note.hidden=!note.textContent;note.classList.toggle('is-error',chatReviewErrors.has(bot.id));}
}
async function saveChatReview(botId,value){
  const bot=botById(botId);if(!bot||chatReviewSaves.has(botId)||!Object.hasOwn(chatReviewModes,value))return;
  if(chatReviewBusy(bot)){updateChatReview(bot);return;}
  if(value===(bot.approvalPolicy||'auto'))return;
  const generation=sendSessionGeneration,pending={value};chatReviewSaves.set(botId,pending);chatReviewErrors.delete(botId);updateChatReview(bot);
  try{
    const result=await api(`/api/bots/${encodeURIComponent(botId)}`,{method:'PATCH',body:{approvalPolicy:value}});
    if(generation!==sendSessionGeneration||!auth?.authenticated)return;
    if(!Object.hasOwn(chatReviewModes,result.approvalPolicy))throw new Error('The engine did not confirm the saved review mode.');
    // A metadata request started before this acknowledgement must not restore the old mode.
    workspaceStateApplied=++workspaceStateRequest;
    data.bots=data.bots.map(item=>item.id===botId?{...item,approvalPolicy:result.approvalPolicy}:item);
  }catch(error){if(generation===sendSessionGeneration&&auth?.authenticated)chatReviewErrors.set(botId,uncertainFailure(error)?'Couldn’t confirm the saved mode. Refresh before starting a task.':errorText(error));}
  finally{if(chatReviewSaves.get(botId)===pending)chatReviewSaves.delete(botId);if(generation===sendSessionGeneration)updateChatReview(botById(botId));}
}
const reasoningCatalogs=new Map(),reasoningSaves=new Set(),reasoningSaveOwners=new Map();
const reasoningLabel=value=>({auto:'Tupies default',none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max'})[value]||'Provider default';
const reasoningPreference=bot=>typeof bot?.reasoningEffort==='string'&&(bot.reasoningEffort||bot.reasoningEffortVersion>=1)?bot.reasoningEffort:'auto';
const reasoningEfforts=capabilities=>capabilities?.supported===true&&Array.isArray(capabilities.efforts)?capabilities.efforts.filter(value=>['none','minimal','low','medium','high','xhigh','max'].includes(value)):[];
/** Automatic reasoning means High only for OpenAI and ChatGPT connections whose model offers it; every other provider type keeps its own default. */
function autoReasoningIsHigh(bot,capabilities){return ['openai','chatgpt'].includes(connectionById(bot?.connectionId)?.type)&&reasoningEfforts(capabilities).includes('high');}
function reasoningOptions(capabilities,current='auto',{autoHigh=false}={}){
  const efforts=reasoningEfforts(capabilities),providerDefault=efforts.includes(capabilities?.defaultEffort)?` · ${reasoningLabel(capabilities.defaultEffort)}`:'',automatic=autoHigh?'High · Tupies default':'Tupies default · Provider default';
  return `<option value="auto" ${current==='auto'?'selected':''}>${automatic}</option><option value="" ${current===''?'selected':''}>Provider default${providerDefault}</option>${current&&current!=='auto'&&!efforts.includes(current)?`<option value="${esc(current)}" selected disabled>${esc(reasoningLabel(current))} · Unavailable for this model</option>`:''}${efforts.map(effort=>`<option value="${effort}" ${effort===current?'selected':''}>${reasoningLabel(effort)}</option>`).join('')}`;
}
function reasoningOptionsHTML(capabilities,current='auto',{id='chat-reasoning',connected=true,autoHigh=false}={}){
  const efforts=reasoningEfforts(capabilities);
  return `<div class="field"><label for="${id}">Reasoning</label><select id="${id}" name="reasoningEffort" ${connected?'':'disabled'}>${reasoningOptions(capabilities,current,{autoHigh})}</select><small>${!connected?'Connect a model provider to choose reasoning.':efforts.length?`${autoHigh?'High is the Tupies default.':'The automatic preference uses the provider default.'} Choose another level for this bot; changes apply to the next task.`:'This model does not advertise adjustable reasoning. It uses the provider default.'}</small></div>`;
}
function botReasoningCapabilities(bot){const connection=connectionById(bot?.connectionId),model=bot?.model||connection?.defaultModel;return connection?.models?.find(item=>item.id===model)?.reasoning;}
function chatReasoningStatus(bot,capabilities){
  const preference=reasoningPreference(bot),efforts=reasoningEfforts(capabilities),run=data.runs?.[bot.id];
  const effective=preference==='auto'?(autoReasoningIsHigh(bot,capabilities)?'High':'Provider default'):efforts.includes(preference)?reasoningLabel(preference):'Provider default';
  return run&&!terminal.has(run.status)?`Next task: ${effective}. Running task: ${reasoningLabel(run.reasoningEffort)}.`:efforts.length?'Applies to the next task.':'Provider default · adjustable reasoning is not advertised.';
}
let inferencePicker=null;
const pickerQuiet=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;
const pickerHaptic=style=>window.StudioMobile?.haptic?.(style);
function inferenceCapabilities(bot){const cached=reasoningCatalogs.get(bot.id);return botReasoningCapabilities(bot)||(cached?.effectiveModel===botModel(bot)?cached.reasoning:null);}
function inferenceModelName(bot,model=bot.model){const connection=connectionById(bot.connectionId),id=model||connection?.defaultModel||'',cached=reasoningCatalogs.get(bot.id),entry=(cached?.models||connection?.models||[]).find(item=>item.id===id);return entry?.name||id||'Provider default';}
function inferenceEffortName(bot,capabilities=inferenceCapabilities(bot),preference=reasoningPreference(bot)){
  const efforts=reasoningEfforts(capabilities);
  return preference==='auto'?(autoReasoningIsHigh(bot,capabilities)?'High':'Provider default'):efforts.includes(preference)?reasoningLabel(preference):'Provider default';
}
function chatInferenceBar(bot){
  if(!connectionById(bot.connectionId))return '';
  return `<div class="chat-inference-bar" id="chat-inference-bar" data-id="${esc(bot.id)}"><button type="button" class="inference-trigger composer-tool-button" data-action="inference-picker" data-id="${esc(bot.id)}" aria-haspopup="dialog" aria-expanded="false" aria-label="Model and reasoning: ${esc(inferenceModelName(bot))}, ${esc(inferenceEffortName(bot))}">${icon('tune')}<span class="inference-summary" id="chat-model-label">${esc(inferenceModelName(bot))}</span><span class="inference-summary inference-trigger-effort">${esc(inferenceEffortName(bot))}</span></button><small id="chat-reasoning-status" class="inference-status" role="status" aria-live="polite"></small></div>`;
}
function updateChatInferenceBar(bot){
  updateChatReview(bot);
  const bar=$('#chat-inference-bar');if(!bar||bar.dataset.id!==bot?.id)return;
  const button=$('.inference-trigger',bar),model=$('#chat-model-label',bar),effort=$('.inference-trigger-effort',bar),status=$('#chat-reasoning-status',bar),busy=reasoningSaves.has(bot.id),run=data.runs?.[bot.id];
  if(model)model.textContent=inferenceModelName(bot);if(effort)effort.textContent=inferenceEffortName(bot);
  if(button){button.setAttribute('aria-label',`Model and reasoning: ${inferenceModelName(bot)}, ${inferenceEffortName(bot)}`);button.setAttribute('aria-expanded',String(inferencePicker?.botId===bot.id));button.setAttribute('aria-busy',String(busy));button.title=`${inferenceModelName(bot)} · ${inferenceEffortName(bot)}${bar.dataset.error?' · '+bar.dataset.error:''}`;button.classList.toggle('is-saving',busy);}
  if(status){status.textContent=busy?'Saving…':bar.dataset.error||(run&&!terminal.has(run.status)?chatReasoningStatus(bot,inferenceCapabilities(bot)):'');status.hidden=!status.textContent;}
  if(inferencePicker?.botId===bot.id){const note=$('.inference-note',inferencePicker.layer);if(note&&!busy&&!inferencePicker.error)note.textContent=chatReasoningStatus(bot,inferenceCapabilities(bot));}
}
async function loadChatInference(botId){
  const bar=$('#chat-inference-bar'),bot=botById(botId),generation=sendSessionGeneration;if(!bar||bar.dataset.id!==botId||!bot)return;
  const request=Number(bar.dataset.catalogRequest||0)+1;bar.dataset.catalogRequest=String(request);bar.dataset.loading='true';
  const connectionId=bot.connectionId,model=bot.model,picker=inferencePicker?.botId===botId?inferencePicker:null;
  const current=()=>bar.isConnected&&generation===sendSessionGeneration&&bar.dataset.catalogRequest===String(request)&&botById(botId)?.connectionId===connectionId&&botById(botId)?.model===model;
  if(picker){picker.loading=true;renderInferencePicker(picker);}
  try{const result=await api(`/api/bots/${encodeURIComponent(botId)}/inference`);if(!current())return;
    reasoningCatalogs.set(botId,result);const connection=connectionById(connectionId);if(connection&&Array.isArray(result.models))connection.models=result.models;delete bar.dataset.error;
    if(picker&&inferencePicker===picker){picker.error='';}return result;
  }catch(error){if(current()){bar.dataset.error='Couldn’t refresh models. Tap to retry.';if(picker&&inferencePicker===picker)picker.error=errorText(error);}}
  finally{if(current()){delete bar.dataset.loading;updateChatInferenceBar(botById(botId));if(picker&&inferencePicker===picker){picker.loading=false;renderInferencePicker(picker);}}}
}
function positionInferencePicker(picker){
  if(inferencePicker!==picker||!picker.anchor.isConnected)return;
  const viewport=window.visualViewport,offset=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,width=Math.min(400,(viewport?.width||window.innerWidth)-24),rect=picker.anchor.getBoundingClientRect(),left=Math.max(offset+12,Math.min(rect.left+rect.width/2-width/2,offset+(viewport?.width||window.innerWidth)-width-12));
  picker.panel.style.width=`${width}px`;picker.panel.style.left=`${left}px`;picker.panel.style.bottom=`${Math.max(12,window.innerHeight-rect.top+12)}px`;picker.panel.style.maxHeight=`${Math.max(130,rect.top-top-24)}px`;
}
function closeInferencePicker(immediate=false,restore=true){
  const picker=inferencePicker;inferencePicker=null;
  if(immediate)document.querySelectorAll('.inference-layer.is-closing').forEach(layer=>layer.remove());
  if(!picker)return;
  picker.controller.abort();if(picker.moveFrame)cancelAnimationFrame(picker.moveFrame);picker.heightMotion?.cancel();picker.anchor.setAttribute('aria-expanded','false');picker.layer.classList.add('is-closing');
  if(restore&&picker.layer.contains(document.activeElement))picker.anchor.isConnected&&picker.anchor.focus({preventScroll:true});
  if(immediate||pickerQuiet())picker.layer.remove();else window.setTimeout(()=>picker.layer.remove(),180);
}
function renderInferencePicker(picker){
  if(inferencePicker!==picker||!picker.layer.isConnected||picker.drag)return;
  const bot=botById(picker.botId);if(!bot||bot.connectionId!==picker.connectionId){closeInferencePicker(true,false);return;}
  const before=picker.panel.getBoundingClientRect().height,focused=picker.focusedControl||(picker.panel.contains(document.activeElement)?document.activeElement.id:''),models=reasoningCatalogs.get(bot.id)?.models||connectionById(bot.connectionId)?.models||[],capabilities=inferenceCapabilities(bot),efforts=reasoningEfforts(capabilities),preference=picker.preview??reasoningPreference(bot),autoHigh=autoReasoningIsHigh(bot,capabilities),selected=preference==='auto'?(autoHigh?'high':capabilities?.defaultEffort):preference||capabilities?.defaultEffort,marked=efforts.indexOf(selected),index=Math.max(0,marked),disabled=picker.loading||picker.saving,run=data.runs?.[bot.id];
  picker.efforts=efforts;picker.index=index;
  const level=inferenceEffortName(bot,capabilities,preference),defaultName=autoHigh?'High by default':'Tupies default';
  const renderKey=JSON.stringify([picker.view,bot.model,efforts,capabilities?.defaultEffort,models.map(item=>[item.id,item.name])]),rebuild=picker.renderKey!==renderKey,viewChanged=picker.renderedView&&picker.renderedView!==picker.view;
  if(rebuild){picker.renderKey=renderKey;picker.renderedView=picker.view;picker.panel.innerHTML=picker.view==='models'?`<div class="inference-model-heading"><button type="button" data-picker="back" class="inference-back" aria-label="Back to reasoning">${icon('back')}</button><h2>Choose a model</h2><button type="button" data-picker="close" class="inference-close" aria-label="Close model options">${icon('close')}</button></div><div class="inference-model-search">${icon('search')}<input type="search" aria-label="Find a model" placeholder="Find a model" value="${esc(picker.query||'')}" autocomplete="off"></div><div class="inference-model-list" role="group" aria-label="Available models"><button type="button" class="inference-model-row ${!bot.model?'is-selected':''}" data-picker-model="" ${disabled?'disabled':''}><span><strong>Workspace default</strong><small>${esc(inferenceModelName(bot,''))}</small></span>${!bot.model?icon('check'):''}</button>${models.map(item=>`<button type="button" class="inference-model-row ${bot.model===item.id?'is-selected':''}" data-picker-model="${esc(item.id)}" ${disabled?'disabled':''}><span><strong>${esc(item.name||item.id)}</strong>${item.name&&item.name!==item.id?`<small>${esc(item.id)}</small>`:''}</span>${bot.model===item.id?icon('check'):''}</button>`).join('')}</div><p class="inference-empty" hidden>No matching models</p>`:`<button type="button" class="inference-model-heading inference-model-open" data-picker="models" ${picker.saving?'disabled':''}><span class="inference-current-model">${esc(inferenceModelName(bot))}</span><span class="inference-current-effort" id="picker-effort">${esc(level)}</span>${icon('chevron')}</button><div class="inference-reasoning"><div class="inference-reasoning-label"><label for="picker-reasoning">Reasoning</label><span>${preference==='auto'?esc(autoHigh?'Tupies default':'Provider managed'):preference===''?'Provider default':efforts.includes(preference)?'Custom':esc(reasoningLabel(preference)+' unavailable')}</span></div>${efforts.length?`<div class="reasoning-rail" style="--picker-position:${efforts.length>1?index/(efforts.length-1)*100:50}%"><div class="reasoning-rail-inner">${efforts.map((effort,i)=>`<span class="reasoning-detent ${i===marked?'is-selected':''}" style="left:${efforts.length>1?i/(efforts.length-1)*100:50}%" aria-hidden="true"></span>`).join('')}<span class="reasoning-thumb-track" aria-hidden="true"><span class="reasoning-thumb"></span></span></div><input id="picker-reasoning" type="range" min="0" max="${Math.max(0,efforts.length-1)}" step="1" value="${index}" aria-label="Reasoning" aria-valuetext="${esc(level)}" ${disabled||efforts.length<2?'disabled':''}></div><div class="reasoning-endpoints" aria-hidden="true"><span>${esc(reasoningLabel(efforts[0]))}</span><span>${esc(reasoningLabel(efforts.at(-1)))}</span></div>`:'<p class="inference-managed">This model manages reasoning automatically.</p>'}<div class="inference-defaults" role="group" aria-label="Reasoning defaults"><button type="button" data-picker-effort="auto" aria-pressed="${preference==='auto'}" ${disabled?'disabled':''}>${esc(defaultName)}</button><button type="button" data-picker-effort="" aria-pressed="${preference===''}" ${disabled?'disabled':''}>Provider default</button></div></div>`;
  picker.panel.insertAdjacentHTML('beforeend','<p class="inference-note" role="status" aria-live="polite"></p><button type="button" class="inference-retry" data-picker="retry" hidden>Refresh options</button>');}
  const note=$('.inference-note',picker.panel);note.classList.toggle('is-error',!!picker.error);note.textContent=picker.saving?'Saving for the next task…':picker.error||(picker.loading?'Refreshing available models…':chatReasoningStatus(bot,capabilities));
  $('[data-picker="retry"]',picker.panel).hidden=!picker.error;
  picker.panel.querySelectorAll('[data-picker-model],[data-picker-effort]').forEach(button=>button.disabled=disabled);const modelOpen=$('.inference-model-open',picker.panel);if(modelOpen)modelOpen.disabled=picker.saving;
  const range=$('#picker-reasoning',picker.panel);
  if(range){range.disabled=disabled||efforts.length<2;range.value=String(index);range.setAttribute('aria-valuetext',level);const rail=range.closest('.reasoning-rail');rail.classList.remove('is-dragging');rail.style.setProperty('--picker-position',`${efforts.length>1?index/(efforts.length-1)*100:50}%`);picker.panel.querySelectorAll('.reasoning-detent').forEach((dot,i)=>dot.classList.toggle('is-selected',i===marked));}
  const effortLabel=$('#picker-effort',picker.panel);if(effortLabel)effortLabel.textContent=level;
  const preferenceLabel=$('.inference-reasoning-label>span',picker.panel);if(preferenceLabel)preferenceLabel.textContent=preference==='auto'?(autoHigh?'Tupies default':'Provider managed'):preference===''?'Provider default':efforts.includes(preference)?'Custom':reasoningLabel(preference)+' unavailable';
  picker.panel.querySelectorAll('[data-picker-effort]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.pickerEffort===preference)));
  if(picker.view==='models')filterInferenceModels(picker);
  positionInferencePicker(picker);
  const after=picker.panel.getBoundingClientRect().height;
  if(viewChanged&&before&&after&&Math.abs(after-before)>2&&!pickerQuiet()&&picker.panel.animate){picker.heightMotion?.cancel();picker.heightMotion=picker.panel.animate([{height:`${before}px`},{height:`${after}px`}],{duration:240,easing:'cubic-bezier(.2,.85,.2,1)'});picker.heightMotion.finished.catch(()=>{});}
  if(focused){const target=picker.panel.querySelector(`#${focused}`);if(target&&!target.disabled){target.focus({preventScroll:true});picker.focusedControl='';}}
}
function filterInferenceModels(picker){
  const query=(picker.query||'').trim().toLocaleLowerCase();let count=0;
  picker.panel.querySelectorAll('[data-picker-model]').forEach(row=>{row.hidden=!!query&&!row.textContent.toLocaleLowerCase().includes(query);if(!row.hidden)count++;});const empty=$('.inference-empty',picker.panel);if(empty)empty.hidden=count>0;
}
function previewInferenceLevel(picker,position,{drag=false,haptic=true}={}){
  const range=$('#picker-reasoning',picker.panel);if(!range||range.disabled||!picker.efforts.length)return;
  const max=picker.efforts.length-1,value=Math.max(0,Math.min(max,position)),index=Math.round(value),effort=picker.efforts[index],rail=range.closest('.reasoning-rail');
  rail.classList.toggle('is-dragging',drag);rail.style.setProperty('--picker-position',`${max?value/max*100:50}%`);range.value=String(index);range.setAttribute('aria-valuetext',reasoningLabel(effort));
  if(index!==picker.index){if(haptic)pickerHaptic('selection');$('#picker-effort',picker.panel).textContent=reasoningLabel(effort);picker.panel.querySelectorAll('.reasoning-detent').forEach((dot,i)=>dot.classList.toggle('is-selected',i===index));}picker.index=index;
}
async function saveInferenceChoice(picker,body){
  const bot=botById(picker.botId);if(inferencePicker!==picker||!bot||picker.saving||reasoningSaves.has(bot.id))return;
  const generation=sendSessionGeneration,connectionId=bot.connectionId,model=bot.model,owner=Symbol();reasoningSaveOwners.set(bot.id,owner);
  if(picker.panel.contains(document.activeElement)&&document.activeElement.id)picker.focusedControl=document.activeElement.id;
  picker.saving=true;picker.error='';picker.preview=Object.hasOwn(body,'reasoningEffort')?body.reasoningEffort:undefined;reasoningSaves.add(bot.id);renderInferencePicker(picker);updateChatInferenceBar(bot);
  try{const result=await api(`/api/bots/${encodeURIComponent(bot.id)}/inference`,{method:'PATCH',body});
    if(generation!==sendSessionGeneration||!auth?.authenticated||botById(bot.id)?.connectionId!==connectionId||botById(bot.id)?.model!==model)return;
    const updated=result.bot||{...bot,...body,...(Object.hasOwn(body,'reasoningEffort')?{reasoningEffortVersion:1}:{})};data.bots=data.bots.map(item=>item.id===bot.id?updated:item);
    if(Array.isArray(result.models)){reasoningCatalogs.set(bot.id,result);const connection=connectionById(connectionId);if(connection)connection.models=result.models;}
    delete picker.bar.dataset.error;picker.view='reasoning';picker.query='';updateChatModelSummary(updated);
  }catch(error){if(generation===sendSessionGeneration&&auth?.authenticated){picker.error=errorText(error);picker.bar.dataset.error=picker.error;pickerHaptic('error');}}
  finally{if(reasoningSaveOwners.get(bot.id)===owner){reasoningSaveOwners.delete(bot.id);reasoningSaves.delete(bot.id);}picker.saving=false;picker.preview=undefined;if(generation===sendSessionGeneration){updateChatInferenceBar(botById(bot.id));if(inferencePicker===picker)renderInferencePicker(picker);}}
}
function openInferencePicker(anchor,botId){
  if(inferencePicker?.botId===botId){closeInferencePicker();return;}
  closeInferencePicker(true,false);const bot=botById(botId),bar=anchor.closest('.chat-inference-bar');if(!bot||!bar)return;
  const layer=document.createElement('div');layer.className='inference-layer';layer.innerHTML='<div class="inference-scrim" data-picker="dismiss"></div><section class="inference-panel" role="dialog" aria-label="Model and reasoning" tabindex="-1"></section>';
  const picker={botId,connectionId:bot.connectionId,bar,anchor,layer,panel:$('.inference-panel',layer),controller:new window.AbortController(),view:'reasoning',loading:false,saving:reasoningSaves.has(botId),index:-1,error:''};inferencePicker=picker;
  document.body.append(layer);renderInferencePicker(picker);anchor.setAttribute('aria-expanded','true');pickerHaptic('soft');
  const signal=picker.controller.signal,on=(target,name,callback,options={})=>target.addEventListener(name,callback,{...options,signal});
  on(layer,'pointerdown',event=>{if(document.activeElement?.matches('.chat-composer textarea')&&event.target.closest('button,[data-picker="dismiss"]'))event.preventDefault();});
  on(layer,'click',event=>{
    const model=event.target.closest('[data-picker-model]'),effort=event.target.closest('[data-picker-effort]'),action=event.target.closest('[data-picker]')?.dataset.picker;
    if(model&&!model.disabled){pickerHaptic('selection');void saveInferenceChoice(picker,{model:model.dataset.pickerModel});}
    else if(effort&&!effort.disabled){pickerHaptic('selection');void saveInferenceChoice(picker,{reasoningEffort:effort.dataset.pickerEffort});}
    else if(['close','dismiss'].includes(action))closeInferencePicker();
    else if(action==='models'){picker.view='models';renderInferencePicker(picker);}
    else if(action==='back'){picker.view='reasoning';renderInferencePicker(picker);}
    else if(action==='retry')void loadChatInference(botId);
  });
  on(layer,'input',event=>{if(event.target.matches('input[type=search]')){picker.query=event.target.value;filterInferenceModels(picker);}else if(event.target.id==='picker-reasoning')previewInferenceLevel(picker,Number(event.target.value));});
  on(layer,'change',event=>{if(event.target.id==='picker-reasoning'&&!picker.drag)void saveInferenceChoice(picker,{reasoningEffort:picker.efforts[Math.round(Number(event.target.value))]});});
  const move=x=>{const rect=picker.drag?.rect;if(!rect)return;const position=Math.max(0,Math.min(1,(x-rect.left-31)/Math.max(1,rect.width-62)))*(picker.efforts.length-1);previewInferenceLevel(picker,position,{drag:true});};
  on(layer,'pointerdown',event=>{const range=event.target.closest('#picker-reasoning');if(!range||range.disabled||event.button>0)return;event.preventDefault();picker.drag={pointerId:event.pointerId,rect:range.getBoundingClientRect()};range.setPointerCapture?.(event.pointerId);move(event.clientX);});
  on(layer,'pointermove',event=>{if(picker.drag?.pointerId!==event.pointerId)return;picker.moveX=event.clientX;if(!picker.moveFrame)picker.moveFrame=requestAnimationFrame(()=>{picker.moveFrame=0;move(picker.moveX);});});
  const end=(event,cancelled=false)=>{if(picker.drag?.pointerId!==event.pointerId)return;const range=$('#picker-reasoning',picker.panel);if(picker.moveFrame){cancelAnimationFrame(picker.moveFrame);picker.moveFrame=0;}if(!cancelled)move(event.clientX);picker.drag=null;range?.releasePointerCapture?.(event.pointerId);if(cancelled){renderInferencePicker(picker);return;}previewInferenceLevel(picker,picker.index,{haptic:false});void saveInferenceChoice(picker,{reasoningEffort:picker.efforts[picker.index]});};
  on(layer,'pointerup',event=>end(event));on(layer,'pointercancel',event=>end(event,true));on(layer,'lostpointercapture',event=>end(event,true));
  on(document,'keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeInferencePicker();}});
  const resized=()=>{if(picker.drag){if(picker.moveFrame){cancelAnimationFrame(picker.moveFrame);picker.moveFrame=0;}picker.drag=null;renderInferencePicker(picker);}positionInferencePicker(picker);};on(window,'resize',resized);if(window.visualViewport){on(window.visualViewport,'resize',resized);on(window.visualViewport,'scroll',()=>positionInferencePicker(picker));}
  on(window,'hashchange',()=>closeInferencePicker(true,false));on(window,'pagehide',()=>closeInferencePicker(true,false));on(document,'visibilitychange',()=>{if(document.hidden)closeInferencePicker(true,false);});
  if(document.activeElement===anchor)picker.panel.focus({preventScroll:true});
  void loadChatInference(botId);
}
document.addEventListener('pointerdown',event=>{if(event.target.closest?.('.inference-trigger')&&document.activeElement?.matches('.chat-composer textarea'))event.preventDefault();});

function updateBotReasoning(form,{reset=false}={}){
  const target=$('#bot-reasoning-field',form);if(!target||form.dataset.settingsSaving==='true')return;
  const bot={connectionId:$('#bot-connection',form)?.value||'',model:$('#bot-model',form)?.value||''},current=reset?'auto':$('#bot-reasoning',form)?.value??reasoningPreference(botById(form.dataset.id));
  const capabilities=botReasoningCapabilities(bot);target.innerHTML=reasoningOptionsHTML(capabilities,current,{id:'bot-reasoning',connected:!!bot.connectionId,autoHigh:autoReasoningIsHigh(bot,capabilities)});
  window.StudioBotProfile?.syncSettings(form);
}
async function saveBotSettings(form,fields,values){
  const originalId=form.dataset.id,previous=botById(originalId),selected=$('#bot-reasoning',form),effort=selected?.value??reasoningPreference(previous),botValues={...values};
  delete botValues.reasoningEffort;delete botValues.fallbackConnectionId;delete botValues.fallbackModel;
  if(Object.hasOwn(botValues,'commandAllowlist'))botValues.commandAllowlist=String(botValues.commandAllowlist||'').split('\n').map(line=>line.trim()).filter(Boolean);
  const input={...botValues,color:({sage:'mint',lilac:'lavender'}[values.color]||values.color),skills:fields.getAll('skill'),tools:fields.getAll('tool'),collaborators:fields.getAll('collaborator'),teamMode:fields.get('teamMode')==='selected'?'selected':'all',integrationIds:[...new Set([...fields.getAll('integrationId'),...(values.searchFallbackIntegrationId?[values.searchFallbackIntegrationId]:[])])],enabled:fields.has('enabled'),hidden:fields.has('hidden'),episodicMemory:fields.has('episodicMemory'),fallback:fields.get('fallbackConnectionId')?{connectionId:String(fields.get('fallbackConnectionId')),model:String(fields.get('fallbackModel')||'').trim()}:null};
  const canSaveReasoning=selected&&!selected.disabled,locked=[...form.elements].map(element=>[element,element.disabled]);
  form.dataset.settingsSaving='true';form.setAttribute('aria-busy','true');
  for(const [element] of locked)element.disabled=true;
  window.StudioBotProfile?.syncSettings(form);
  try{
  const result=await api(originalId?`/api/bots/${encodeURIComponent(originalId)}`:'/api/bots',{method:originalId?'PATCH':'POST',body:input});
  let saved={...previous,...input,...(result.bot||result)},savedId=saved.id||originalId;
  if(!savedId)throw new Error('Bot settings were saved, but the bot could not be identified. Refresh before trying again.');
  saved.id=savedId;form.dataset.id=savedId;
  // Keep a successful first save even if provider validation below fails. A retry updates this bot instead of creating it again.
  const remember=bot=>{if(data.bots.some(item=>item.id===savedId))data.bots=data.bots.map(item=>item.id===savedId?bot:item);else data.bots.push(bot);updateChatModelSummary(bot);};
  remember(saved);
  if(canSaveReasoning&&effort!==reasoningPreference(saved)){
    try{const inference=await api(`/api/bots/${encodeURIComponent(savedId)}/inference`,{method:'PATCH',body:{reasoningEffort:effort}});saved={...saved,...(inference.bot||{reasoningEffort:effort,reasoningEffortVersion:1})};remember(saved);}
    catch(error){const status=$('[data-settings-status]',form);if(status)status.textContent='Bot settings saved; reasoning still needs saving.';throw new Error(`Bot settings saved. Reasoning wasn’t saved: ${errorText(error)}`);}
  }
  if(form.dataset.embedded==='true')window.StudioBotProfile?.settingsSaved(savedId,form);else closeDialog();
  await refresh();toast(originalId?'Changes saved.':'Bot created.');
  }finally{
    delete form.dataset.settingsSaving;form.removeAttribute('aria-busy');
    for(const [element,disabled] of locked)element.disabled=disabled;
    window.StudioBotProfile?.syncSettings(form);
  }
}
// Mirrors lib/context-budget.mjs: the working context is summarized at the bot's threshold (default 55%) of the model window, capped at 272K unless the bot allows more.
const formatTokens=value=>value>=1_000_000?`${+(value/1_000_000).toFixed(2)}M`:value>=1000?`${Math.round(value/1000)}K`:String(value);
function conversationNoteText(state){const used=state?.conversation?.tokens||0,at=state?.context?.compactAt,last=state?.conversation?.compactedAt;return `This conversation is about ${formatTokens(used)} tokens${at?`; older messages are summarized automatically from about ${formatTokens(at)}`:''}.${last?` Last summarized ${shortDate(last)} ${timeLabel(last)}.`:''}`;}
function contextNoteText(state,model){const bot=botById(state?.botId),known=(state?.models||[]).find(item=>item.id===model)?.contextWindow,window=model===state?.effectiveModel&&state?.context&&state.context.source!=='default'?state.context.window:known;if(!window)return `This provider does not report the model’s context window, so Tupies assumes 128K tokens. You can set the window in the provider’s settings.${imageNote(state,model)}`;const limit=bot?.contextLimit==='max'?window:Math.min(window,bot?.contextLimit==='128k'?128_000:272_000);return `Context window ${formatTokens(window)} tokens. Older material is organized once the conversation passes about ${formatTokens(Math.floor(limit*0.9))}.${imageNote(state,model)}`;}
function imageNote(state,model){const images=(state?.models||[]).find(item=>item.id===model)?.imageInput;return images?images.supported?' Attached images are shown to this model.':' This model gets only the names of attached images.':'';}
function updateChatReasoning(){const form=$('#chat-options-form'),target=$('#chat-reasoning-field'),state=chatInferenceState;if(!form||!target||!state)return;const model=$('#chat-model',form)?.value||'',defaultModel=state.defaultModel||connectionById(botById(state.botId)?.connectionId)?.defaultModel;const capabilities=(state.models||[]).find(item=>item.id===(model||defaultModel))?.reasoning||(model===state.model?state.reasoning:{supported:false,efforts:[]});target.innerHTML=reasoningOptionsHTML(capabilities,$('#chat-reasoning',target)?.value??state.reasoningEffort??'auto',{autoHigh:autoReasoningIsHigh(botById(state.botId),capabilities)});const note=$('#chat-context-note',form);if(note)note.textContent=contextNoteText(state,model||defaultModel);}
async function chatOptionsDialog(botId){
  chatInferenceState=null;chatSpeechState=null;openDialog('Chat options',`<form id="chat-options-form" data-id="${esc(botId||'')}" data-inference-ready="false" data-inference-dirty="false" data-voice-dirty="false">${botId?'<details class="chat-option-section pearl-advanced" open><summary>Model & reasoning</summary><div id="chat-inference-options"><p class="rich-loading">Loading available models…</p></div></details>':''}${speechOptionsMarkup()}<p class="form-error" role="alert"></p><div class="modal-footer"><button type="button" class="secondary-button" data-action="close-dialog">Cancel</button><button type="submit" class="primary-button">Save options${icon('check')}</button></div></form>`,{wide:true});
  updateVoiceChoices();updateSpeechEngine();void loadSpeechCatalog();const voiceDialog=$('dialog');voiceDialog.addEventListener('close',()=>{speechCatalogGeneration++;if(speechController()?.state.readingKey?.startsWith('preview:'))speechController().stopReading();},{once:true});if(!botId)return;const dialog=$('dialog'),target=$('#chat-inference-options');
  try{const result=await api(`/api/bots/${encodeURIComponent(botId)}/inference`);if(!target?.isConnected||$('dialog')!==dialog)return;chatInferenceState={...result,botId};reasoningCatalogs.set(botId,result);const connection=connectionById(botById(botId)?.connectionId);if(connection&&Array.isArray(result.models))connection.models=result.models;updateChatInferenceBar(botById(botId));const models=Array.isArray(result.models)?result.models:[],current=result.model||'';target.innerHTML=`<div class="field"><label for="chat-model">Model</label><select id="chat-model" name="model"><option value="">Use provider default</option>${current&&!models.some(model=>model.id===current)?`<option value="${esc(current)}" selected disabled>${esc(current)} · Unavailable in current catalog</option>`:''}${models.map(model=>`<option value="${esc(model.id)}" ${model.id===current?'selected':''}>${esc(model.name||model.id)}</option>`).join('')}</select><small>${models.length?'Current models from this bot’s provider.':'No models are listed by this provider. Provider default is available.'}</small></div><div id="chat-reasoning-field">${reasoningOptionsHTML(result.reasoning,result.reasoningEffort,{autoHigh:autoReasoningIsHigh(botById(botId),result.reasoning)})}</div><p class="chat-inference-note">Applies to this bot’s next task. The workspace default stays unchanged.</p><p class="chat-inference-note" id="chat-context-note">${esc(contextNoteText(chatInferenceState,current||chatInferenceState.defaultModel))}</p>`;target.closest('.chat-option-section')?.insertAdjacentHTML('afterend',`<details class="chat-option-section pearl-advanced" id="chat-context-tools"><summary>Conversation history</summary><p class="chat-inference-note">${esc(conversationNoteText(chatInferenceState))}</p><div class="chat-context-actions"><button type="button" class="secondary-button" data-action="compact-context" data-id="${esc(botId)}" ${chatInferenceState.activeRun?'disabled':''}>Summarize older messages</button><button type="button" class="secondary-button" data-action="new-chat" data-id="${esc(botId)}" ${chatInferenceState.activeRun?'disabled':''}>New chat</button></div><small class="chat-inference-note">Summaries keep the bot’s working context focused; the full transcript stays in this chat. A new chat starts a fresh working context; memory, notes and earlier chats stay available.</small></details>`);$('#chat-options-form').dataset.inferenceReady='true';}catch(error){if(target?.isConnected)target.innerHTML=`<div class="voice-availability"><p>${esc(errorText(error))}</p><button type="button" class="text-button" data-action="chat-options" data-id="${esc(botId)}">Retry model options</button></div>`;}
}
function updateChatModelSummary(bot){if(!bot||route().id!==bot.id)return;const connection=connectionById(bot.connectionId),summary=$('#composer-model-summary');if(summary)summary.textContent=connection?`${bot.model||connection.defaultModel||'Provider default'}${bot.reasoningEffort?' · '+bot.reasoningEffort:''} · ${providerMeta(connection.type).name}`:'Choose a model provider to start';const inspector=$('#inspector-model-name');if(inspector)inspector.textContent=bot.model||connection?.defaultModel||'Provider default';updateChatInferenceBar(bot);}

function renderTaskPlan(run){
  const plan=run?.plan,steps=Array.isArray(plan?.steps)?plan.steps.slice(0,20):[];if(!steps.length)return '';
  const statuses={pending:'Pending',in_progress:'In progress',completed:'Done'},completed=steps.filter(step=>step.status==='completed').length;
  return `<section class="task-plan" aria-label="Task plan"><div class="task-plan-heading"><strong>Task plan</strong><span>${completed} of ${steps.length} steps done</span></div>${plan.explanation?`<p>${esc(String(plan.explanation).slice(0,1000))}</p>`:''}<ol>${steps.map(step=>`<li class="plan-${Object.hasOwn(statuses,step.status)?step.status:'pending'}"><span class="plan-indicator" aria-hidden="true">${step.status==='completed'?'✓':step.status==='in_progress'?'●':'○'}</span><span>${esc(String(step.title||'').slice(0,240))}</span><small>${statuses[step.status]||'Pending'}</small></li>`).join('')}</ol></section>`;
}
function managedProcessIdentity(run,process){return {botId:run.botId||process.botId,runId:run.id,remoteRunId:run.remoteRunId||run.id,processId:process.id||process.processId};}
function managedCommandPreview(process){
  const preview=process.argsPreview,args=Array.isArray(process.args)?process.args.map(String).join(' '):Array.isArray(preview)?preview.join(' '):String(preview||''),command=[String(process.executable||''),args].filter(Boolean).join(' ');
  const previewTruncated=typeof process.argsPreviewTruncated==='boolean'?process.argsPreviewTruncated:!Array.isArray(process.args)&&Array.isArray(preview)&&(preview.length>=8||preview.some(arg=>String(arg).length>=120));
  return command.slice(0,1000)+(command.length>1000||previewTruncated?'…':'');
}
function renderManagedTools(run){
  const processes=Array.isArray(run?.backgroundProcesses)?run.backgroundProcesses.slice(-20):[],servers=Array.isArray(run?.languageServers)?run.languageServers.slice(-8):[];if(!processes.length&&!servers.length)return '';
  const active=!!run&&!terminal.has(run.status)&&run.status!=='stopping',statuses={starting:'Starting',running:'Running',stopping:'Stopping',completed:'Completed',failed:'Failed',cancelled:'Stopped',timed_out:'Timed out',output_limit:'Output limit reached',interrupted:'Interrupted',ready:'Ready',stopped:'Stopped'};
  const label=status=>Object.hasOwn(statuses,status)?statuses[status]:'Unknown';
  return `<section class="managed-tools" aria-label="Task processes and code intelligence">${processes.length?`<div class="managed-tools-heading"><strong>Background commands</strong><span>${processes.filter(process=>['starting','running'].includes(process.status)).length} running</span></div><div class="managed-process-list">${processes.map(process=>{const identity=managedProcessIdentity(run,process),hasIdentity=!!(identity.botId&&identity.runId&&identity.processId),status=label(process.status),canStop=active&&['starting','running'].includes(process.status),command=managedCommandPreview(process),preview=String(process.outputPreview||'').slice(-1200);return `<article class="managed-process"><div class="managed-process-heading"><strong>${esc(command||'Background command')}</strong><span class="managed-status ${['starting','running'].includes(process.status)?'managed-status-active':''}">${esc(status)}</span></div><p class="managed-process-meta">Folder: ${esc(String(process.cwd||'.').slice(0,240))}${Number.isInteger(process.exitCode)?` · Exit ${process.exitCode}`:''}${process.truncated?' · Output truncated':''}</p>${preview?`<pre class="managed-process-preview">${esc(preview)}</pre>`:''}<div class="managed-process-actions">${hasIdentity?`<button class="text-button" data-action="process-output" data-process="${esc(JSON.stringify(identity))}">View output</button>`:''}${hasIdentity&&canStop?`<button class="text-button" data-action="stop-process" data-process="${esc(JSON.stringify(identity))}">${icon('stop')}Stop command</button>`:''}</div></article>`;}).join('')}</div>`:''}${servers.length?`<div class="managed-tools-heading managed-lsp-heading"><strong>Code intelligence</strong><span>Language servers</span></div><div class="managed-lsp-list">${servers.map(server=>`<article class="managed-lsp"><span class="managed-lsp-mark" aria-hidden="true">⌘</span><div><strong>${esc(String(server.server||server.name||'Language server').slice(0,100))}</strong><p>Folder: ${esc(String(server.rootPath||'.').slice(0,240))}</p>${server.error?`<p>${esc(String(server.error).slice(0,500))}</p>`:''}</div><span class="managed-status ${server.status==='ready'?'managed-status-active':''}">${esc(label(server.status))}</span></article>`).join('')}</div>`:''}</section>`;
}
function activityLabel(tool,args={}){
  const label=window.StudioActivityModel?.describeTool?.(tool,args);if(label)return label;
  const phrase=toolPhrases.find(([pattern])=>pattern.test(String(tool||'')))?.[1]||'working';
  return phrase.charAt(0).toUpperCase()+phrase.slice(1);
}
function taskDetailsOpen(container,run){const panel=$('.task-details',container);return !!panel?.open&&panel.dataset?.runId===String(run?.id||'');}
const workshopGrantDrafts=new Map();
function workshopGrantDraft(promptId,botId){
  if(!workshopGrantDrafts.has(promptId)){if(workshopGrantDrafts.size>=16)workshopGrantDrafts.delete(workshopGrantDrafts.keys().next().value);workshopGrantDrafts.set(promptId,{maxRequests:10,minutes:10,intervalSeconds:1,botIds:[botId],open:false});}
  return workshopGrantDrafts.get(promptId);
}
function workshopGrantForm(control,bot,identity,canApprove){
  if(control?.tool!=='workshop_poll_api'||!control.review?.grantOffer)return '';
  const draft=workshopGrantDraft(identity.request_id,bot.id),participants=control.review.grantOffer.participants||[];
  return `<details class="workshop-grant-form" data-workshop-prompt="${esc(identity.request_id)}" ${draft.open?'open':''}><summary>Allow a bounded series of reads</summary><p>Repeat only this exact request and tool version during this task. Selected bots share one request budget. This is not a monetary spending limit; the service may charge for reads.</p><div class="field"><label>Maximum requests <input type="number" data-workshop-field="maxRequests" min="1" max="100" value="${esc(draft.maxRequests)}"></label></div><div class="field"><label>Expires in minutes <input type="number" data-workshop-field="minutes" min="1" max="60" value="${esc(draft.minutes)}"></label></div><div class="field"><label>Minimum seconds between requests <input type="number" data-workshop-field="intervalSeconds" min="0" max="60" value="${esc(draft.intervalSeconds)}"></label></div><fieldset><legend>Permitted participants in this task</legend>${participants.map(item=>`<label class="permission-option"><input type="checkbox" data-workshop-field="botIds" value="${esc(item.id)}" ${draft.botIds.includes(item.id)?'checked':''} ${item.id===bot.id?'disabled':''}><span>${esc(item.name)}</span></label>`).join('')}</fieldset><p>Failures consume a request and block further use. Stop, expiry, revocation or an Engine restart ends access. Review and revoke grants in Bot → Workshop.</p><button type="button" class="primary-button" data-action="approve" data-choice="bounded-read" data-id="${esc(bot.id)}" data-approval="${esc(JSON.stringify(identity))}" ${canApprove?'':'disabled'}>Allow bounded reads</button></details>`;
}
document.addEventListener('input',event=>{const field=event.target.closest?.('[data-workshop-field]'),form=field?.closest('[data-workshop-prompt]');if(!form)return;const draft=workshopGrantDrafts.get(form.dataset.workshopPrompt);if(!draft)return;if(field.dataset.workshopField==='botIds')draft.botIds=[...form.querySelectorAll('[data-workshop-field="botIds"]:checked')].map(item=>item.value);else draft[field.dataset.workshopField]=field.value;});
document.addEventListener('toggle',event=>{if(event.target.matches?.('.workshop-grant-form')){const draft=workshopGrantDrafts.get(event.target.dataset.workshopPrompt);if(draft)draft.open=event.target.open;}},true);
// Live run view: the step, model and tool the bot is on, its reasoning and its tool calls. While a run is live a 500 ms loop on /events?after= patches these nodes in place; the 2 s transcript poll stays the fallback.
const liveDisclosures=new Map(),HUMAN_WAITS=new Set(['waiting_for_approval','waiting_for_input']);let liveLoop=null;
function liveSeconds(from,to=Date.now()){const start=Date.parse(from||''),end=typeof to==='number'?to:Date.parse(to||'');return Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,(end-start)/1000):null;}
function liveDuration(seconds){return seconds===null?'':seconds<10?`${seconds.toFixed(1)}s`:`${Math.round(seconds)}s`;}
function toolArgumentSummary(args){let value=args;if(typeof value==='string'){try{value=JSON.parse(value);}catch{return '';}}if(!value||typeof value!=='object')return '';const key=['query','url','path','skillId'].find(name=>typeof value[name]==='string'&&value[name].trim());if(!key)return '';const text=value[key].replace(/\s+/g,' ').trim();return text.length>80?text.slice(0,79)+'…':text;}
function runEventSeq(run){let seq=0;for(const event of Array.isArray(run?.events)?run.events:[])if(Number.isFinite(event?.seq)&&event.seq>seq)seq=event.seq;return seq;}
function runActivity(run){
  const activity={step:0,model:'',modelAt:'',wait:null,tools:[]},calls=new Map(),call=(event,outcome)=>({id:event.toolCallId||event.id,tool:String(event.tool||'tool'),argument:toolArgumentSummary(event.arguments),startedAt:event.createdAt||'',endedAt:'',outcome,retries:0});
  for(const event of Array.isArray(run?.events)?run.events:[]){
    if(event?.type==='model.started'){const step=Number(event.step);activity.step=Number.isInteger(step)&&step>0?step:activity.step+1;activity.model=String(event.model||activity.model||'');activity.modelAt=event.createdAt||'';activity.wait=null;}
    else if(event?.type==='model.waiting'){activity.wait={kind:'waiting',at:event.createdAt||'',elapsedMs:Number(event.elapsedMs)||0};}
    else if(event?.type==='model.retry'){activity.wait={kind:'retry',at:event.createdAt||'',attempt:Number(event.attempt)||1,max:Number(event.maxAttempts)||6,delayMs:Number(event.delayMs)||0};}
    else if(event?.type==='model.fallback'){activity.wait={kind:'fallback',at:event.createdAt||'',model:String(event.to?.model||'')};}
    else if(['model.resumed','model.completed'].includes(event?.type)){activity.wait=null;}
    else if(event?.type==='tool.started'){const item=call(event,'running');activity.tools.push(item);if(event.toolCallId)calls.set(event.toolCallId,item);}
    else if(['tool.completed','tool.retry','tool.skipped'].includes(event?.type)){
      let item=event.toolCallId&&calls.get(event.toolCallId)||activity.tools.findLast(entry=>entry.tool===event.tool&&['running','retry'].includes(entry.outcome));
      if(!item&&event.type==='tool.skipped'){item=call(event,'skipped');item.endedAt=item.startedAt;activity.tools.push(item);}
      if(!item)continue;
      if(event.type==='tool.retry'){item.retries++;item.outcome='retry';}
      else{item.endedAt=event.createdAt||item.startedAt;item.outcome=event.type==='tool.skipped'?'skipped':event.error?'error':'ok';}
    }
  }
  activity.tools=activity.tools.slice(-200);return activity;
}
/** Live wait state of the current model call: "waiting for model · 45 s", "retrying 2/6 in 10 s" or the fallback notice. */
function runWaitLabel(wait,now=Date.now()){
  if(!wait)return '';const since=liveSeconds(wait.at,now)||0;
  if(wait.kind==='waiting')return `waiting for model · ${Math.round(wait.elapsedMs/1000+since)} s`;
  if(wait.kind==='retry')return `retrying ${wait.attempt}/${wait.max} in ${Math.max(0,Math.ceil(wait.delayMs/1000-since))} s`;
  return `switched to fallback model${wait.model?` · ${wait.model}`:''}`;
}
function runActivityStrip(activity,now=Date.now()){
  const current=activity.tools.at(-1),parts=[];
  if(activity.wait)parts.push(`<span class="run-strip-wait" role="status">${esc(runWaitLabel(activity.wait,now))}</span>`);
  if(activity.step)parts.push(`<span class="run-strip-step">Step ${activity.step}${activity.model?` · ${esc(activity.model)}`:''}${activity.modelAt?` · ${liveDuration(liveSeconds(activity.modelAt,now))}`:''}</span>`);
  if(current)parts.push(`<span class="run-strip-tool">${esc(current.tool)}${current.argument?` · ${esc(current.argument)}`:''} · ${liveDuration(liveSeconds(current.startedAt,current.endedAt||now))}</span>`);
  return parts.join('');
}
function runActivityItems(activity,{final=false,now=Date.now()}={}){return activity.tools.map(item=>{const stopped=final&&!item.endedAt,outcome=stopped?'stopped':item.outcome;return `<li class="run-activity-item is-${esc(outcome)}"><span class="run-activity-tool">${esc(item.tool)}</span>${item.argument?`<span class="run-activity-arg">${esc(item.argument)}</span>`:''}<span class="run-activity-meta">${stopped?'':`<span class="run-activity-time">${liveDuration(liveSeconds(item.startedAt,item.endedAt||now))}</span>`}<span class="run-activity-outcome">${esc(outcome)}${item.retries&&outcome!=='retry'?` · ${item.retries} ${item.retries===1?'retry':'retries'}`:''}</span></span></li>`;}).join('');}
function runActivitySummary(activity){const count=activity.tools.length;return `${icon('activity')}Activity<span>${count} tool ${count===1?'call':'calls'}</span>`;}
function runActivityList(run,activity,{live=false}={}){const key=`${run.id}:${live?'live':'done'}`;return `<details class="run-activity ${live?'is-live':''}" data-run-activity="${esc(key)}" ${activity.tools.length?'':'hidden'} ${liveDisclosures.get(key)?'open':''}><summary>${runActivitySummary(activity)}</summary><ol class="run-activity-list">${runActivityItems(activity,{final:!live})}</ol></details>`;}
/** The finished run's tool calls stay available as a collapsed disclosure under its last message. Older runs keep no events and show nothing. */
function completedRunActivity(run){const activity=runActivity(run);if(!run?.id||!activity.tools.length)return '';return `<div class="run-activity-attached" data-message-key="${messageKey({id:`activity-${run.id}`,role:'activity',content:[run.status,runEventSeq(run)]})}">${runActivityList(run,activity)}</div>`;}
/** Reasoning is plain text: escaped, never passed through the rich renderer. */
function thinkingBlock(text,{live=false,key=''}={}){const value=String(text||'');if(!live&&!value.trim())return '';const open=live?liveDisclosures.get(`${key}:thinking`)??true:false;return `<details class="thinking-block ${live?'is-live':''}" ${live?`data-live-thinking="${esc(key)}"`:''} ${value.trim()?'':'hidden'} ${open?'open':''}><summary>${live?'Thinking…':'Thinking'}</summary><div class="thinking-text" ${live?'data-live-reasoning':''}>${esc(value)}</div></details>`;}
function liveRunState(run,messages=chat.messages||[]){const activity=runActivity(run),partial=String(run.partialOutput||''),text=partial&&!messages.some(message=>message.runId===run.id&&message.partial)?partial:'',reasoning=String(run.partialReasoning||'');return {activity,text,reasoning,quiet:!text&&!reasoning.trim(),empty:!text&&!reasoning.trim()&&!activity.step&&!activity.tools.length};}
function liveRunMarkup(bot,run,messages){
  const state=liveRunState(run,messages);
  return `<article class="chat-message partial-message live-run ${state.quiet?'is-quiet':''} ${state.empty?'is-empty':''}" data-live-run="${esc(run.id)}">${avatar(bot,'tiny','thread-partial')}<div class="message-content"><div class="message-label">${esc(bot.name)}<span class="streaming-label">Working</span></div>${thinkingBlock(state.reasoning,{live:true,key:run.id})}<div class="live-run-text" data-live-text>${state.text?messageText(state.text,{streaming:true}):''}</div><div class="run-strip" data-live-strip ${state.activity.step||state.activity.tools.length?'':'hidden'}>${runActivityStrip(state.activity)}</div>${runActivityList(run,state.activity,{live:true})}</div></article>`;
}
/** Patch the live run's nodes without rebuilding the thread. Returns false when the thread has no live node for this run. */
function patchLiveRun(run){
  const container=$('#chat-thread'),node=[...(container?.querySelectorAll?.('[data-live-run]')||[])].find(item=>item.dataset.liveRun===run?.id);if(!node)return false;
  const nearBottom=container.scrollTop+container.clientHeight>=container.scrollHeight-80,state=liveRunState(run),set=(element,html)=>{if(element&&element.__liveHtml!==html){element.innerHTML=html;element.__liveHtml=html;}};
  const text=node.querySelector('[data-live-text]');if(text&&text.__liveValue!==state.text){text.innerHTML=state.text?messageText(state.text,{streaming:true}):'';text.__liveValue=state.text;}
  const thinking=node.querySelector('[data-live-thinking]'),body=thinking?.querySelector('[data-live-reasoning]');if(body){if(body.textContent!==state.reasoning)body.textContent=state.reasoning;thinking.hidden=!state.reasoning.trim();body.scrollTop=body.scrollHeight;}
  const strip=node.querySelector('[data-live-strip]');if(strip){set(strip,runActivityStrip(state.activity));strip.hidden=!state.activity.step&&!state.activity.tools.length;}
  const tools=node.querySelector('[data-run-activity]');if(tools){set(tools.querySelector('summary'),runActivitySummary(state.activity));set(tools.querySelector('ol'),runActivityItems(state.activity));tools.hidden=!state.activity.tools.length;}
  node.classList.toggle('is-quiet',state.quiet);node.classList.toggle('is-empty',state.empty);
  if(nearBottom)container.scrollTop=container.scrollHeight;return true;
}
/** A transcript poll may be older than what the live loop already showed; keep the newer live state for the same run. */
function mergeLiveRun(previous,next){
  if(!previous||!next||previous.id!==next.id||terminal.has(next.status))return next;
  const nextSeq=runEventSeq(next),previousSeq=runEventSeq(previous);if(previousSeq<nextSeq)return next;
  const merged={...next};if(previousSeq>nextSeq)merged.events=[...(next.events||[]),...(previous.events||[]).filter(event=>event.seq>nextSeq)];
  for(const field of ['partialOutput','partialReasoning']){const before=String(previous[field]||''),after=String(next[field]||'');if(before.length>after.length&&before.startsWith(after))merged[field]=before;}
  return merged;
}
function liveLoopWanted(){const current=route(),run=chat.run;return !document.hidden&&!!auth?.authenticated&&current.view==='bot'&&current.id===activeBot&&!!run?.id&&!terminal.has(run.status)&&!HUMAN_WAITS.has(run.status);}
function stopLiveLoop(){if(liveLoop?.timer)clearTimeout(liveLoop.timer);liveLoop=null;}
/** Start, keep or stop the fast loop for the open bot's live run. It never polls without an active run. */
function syncLiveLoop(){
  if(!liveLoopWanted())return stopLiveLoop();
  if(liveLoop?.botId===activeBot&&liveLoop.runId===chat.run.id)return;
  stopLiveLoop();const loop={botId:activeBot,runId:chat.run.id,busy:false,timer:null};liveLoop=loop;loop.timer=setTimeout(()=>liveRunTick(loop),500);
}
async function liveRunTick(loop){
  if(liveLoop!==loop)return;loop.timer=null;
  const current=()=>liveLoop===loop&&liveLoopWanted()&&activeBot===loop.botId&&chat.run?.id===loop.runId;
  if(!current()){if(liveLoop===loop)liveLoop=null;return;}
  if(loop.busy)return;loop.busy=true;let result=null;
  try{result=await api(`/api/bots/${encodeURIComponent(loop.botId)}/events?after=${runEventSeq(chat.run)}`);}catch{result=null;}finally{loop.busy=false;}
  if(!current()){if(liveLoop===loop)liveLoop=null;return;}
  if(result&&typeof result==='object'){
    const run=chat.run,status=result.status||run.status;
    // A new run, a terminal status or a human wait changes the thread's structure: stop here and let one full refresh draw it.
    if(result.runId&&result.runId!==run.id||status!==run.status){liveLoop=null;await loadChat(loop.botId);return;}
    const after=runEventSeq(run),fresh=(Array.isArray(result.events)?result.events:[]).filter(event=>Number.isFinite(event?.seq)&&event.seq>after).sort((a,b)=>a.seq-b.seq);
    if(fresh.length)run.events=[...(run.events||[]),...fresh].slice(-300);
    if(typeof result.partialOutput==='string')run.partialOutput=result.partialOutput;
    if(typeof result.partialReasoning==='string')run.partialReasoning=result.partialReasoning;
    patchLiveRun(run);
  }
  if(liveLoop===loop)loop.timer=setTimeout(()=>liveRunTick(loop),500);
}
document.addEventListener('toggle',event=>{const target=event.target;if(liveDisclosures.size>400)liveDisclosures.clear();if(target.matches?.('[data-live-thinking]'))liveDisclosures.set(`${target.dataset.liveThinking}:thinking`,target.open);else if(target.matches?.('[data-run-activity]'))liveDisclosures.set(target.dataset.runActivity,target.open);},true);
function renderTimeline(run,open=false){
  if(!run)return '';
  const steps=Array.isArray(run.plan?.steps)?run.plan.steps.slice(0,20):[],completed=steps.filter(step=>step.status==='completed').length,processes=renderManagedTools(run),activity=[];
  const labels={'run.started':'Started the task','skill.reviewing':'Reviewing a reusable method','approval.request':'Waiting for approval','approval.automatic':'Approved automatically','delegation.started':'Asked a teammate','delegation.completed':'Received a teammate update','run.completed':'Task completed','run.failed':'Task failed','run.cancelled':'Task stopped'};
  for(const event of (run.events||[]).slice(-160)){
    const label=event.type==='tool.started'&&!/^task_plan_/.test(event.tool)?activityLabel(event.tool,event.arguments):event.type==='tool.completed'&&event.error?'Action failed':labels[event.type];
    if(!label||activity.at(-1)?.label===label)continue;
    activity.push({label,createdAt:event.createdAt||event.timestamp});
  }
  const recent=activity.slice(-6);if(!steps.length&&!processes&&!recent.length)return '';
  return `<details class="run-timeline task-details" data-run-id="${esc(run.id||'')}" ${open?'open':''}><summary>${icon('activity')}Task details${steps.length?`<span>${completed}/${steps.length} steps</span>`:''}</summary><div class="task-details-body">${renderTaskPlan(run)}${processes}${recent.length?`<section class="task-activity" aria-label="Recent activity"><h4>Activity</h4><ol>${recent.map(item=>`<li><span>${esc(item.label)}</span>${item.createdAt?`<time>${esc(timeLabel(item.createdAt))}</time>`:''}</li>`).join('')}</ol></section>`:''}</div></details>`;
}

let managedOutputView=null;
function currentManagedRun(identity){
  const candidate=route().view==='room'?roomChat.activeRun:chat.run;
  return candidate?.id===identity.runId&&(candidate.botId||route().id)===identity.botId?candidate:null;
}
async function refreshManagedRun(identity){const current=route();if(current.view==='bot'&&current.id===identity.botId)await loadChat(identity.botId);else if(current.view==='room'&&roomChat.activeRun?.id===identity.runId)await loadRoomChat(current.id);}
async function processOutputDialog(identity){
  if(!currentManagedRun(identity))throw new Error('This command belongs to an older task. Open the current task before reading its output.');
  const view={identity,output:'',request:0,nextOffset:null,outputVersion:undefined};managedOutputView=view;
  openDialog('Background command output',`<p class="modal-subtitle">Output from this task’s approved command. Refresh to read its latest retained output.</p><p class="managed-output-status" id="managed-output-status" role="status">Reading output…</p><pre class="managed-output-text" id="managed-output-content"></pre><div class="modal-footer"><button class="secondary-button" data-action="process-output-refresh">Refresh</button><button class="secondary-button" data-action="process-output-more" id="managed-output-more" disabled>Read more</button><button class="primary-button" data-action="close-dialog">Done</button></div>`,{wide:true});
  view.dialog=$('dialog');view.dialog?.addEventListener('close',()=>{if(managedOutputView===view)managedOutputView=null;},{once:true});await loadProcessOutput(view,0,false);
}
async function loadProcessOutput(view,offset,append){
  if(managedOutputView!==view||$('dialog')!==view.dialog)return;
  const target=$('#managed-output-content'),summary=$('#managed-output-status'),more=$('#managed-output-more');if(!target||!summary)return;
  const request=++view.request;summary.textContent='Reading output…';if(more)more.disabled=true;
  try {
    const {identity}=view,version=offset>0&&Number.isSafeInteger(view.outputVersion)?`&outputVersion=${view.outputVersion}`:'',result=await api(`/api/bots/${encodeURIComponent(identity.botId)}/processes/${encodeURIComponent(identity.processId)}?runId=${encodeURIComponent(identity.runId)}&offset=${offset}&limit=12000${version}`);
    if(managedOutputView!==view||request!==view.request||$('dialog')!==view.dialog||!target.isConnected)return;
    const run=currentManagedRun(identity);if(!run){summary.textContent='This task changed. Reopen its command output from the current task.';view.nextOffset=null;return;}
    if(append&&view.outputVersion!==undefined&&result.outputVersion!==view.outputVersion){view.output='';view.nextOffset=null;view.outputVersion=undefined;target.textContent='';summary.textContent='Output changed after credential redaction. Select Refresh to read again from the beginning.';return;}
    const page=String(result.output??result.content??[result.stdout||'',result.stderr||''].filter(Boolean).join('\n')).slice(0,12000);
    view.output=(append?view.output+page:page).slice(0,250000);view.nextOffset=Number.isSafeInteger(result.nextOffset)&&result.nextOffset>offset?result.nextOffset:null;view.outputVersion=Number.isSafeInteger(result.outputVersion)&&result.outputVersion>=0?result.outputVersion:undefined;
    target.textContent=view.output||'(No output yet.)';
    const returned=result.process||result,current=(run.backgroundProcesses||[]).find(process=>(process.id||process.processId)===identity.processId),process=current&&!['starting','running'].includes(current.status)?current:returned,status=String(process.status||'Unknown').replaceAll('_',' '),exit=Number.isInteger(process.exitCode)?` · Exit ${process.exitCode}`:'';
    summary.textContent=`${status}${exit} · ${view.output.length.toLocaleString()} characters shown${result.truncated?' · Retained output is truncated':''}`;
    if(more)more.disabled=view.nextOffset===null||view.output.length>=250000;
  } catch(error){if(managedOutputView===view&&request===view.request&&$('dialog')===view.dialog&&summary.isConnected){if(error.status===409){view.output='';view.nextOffset=null;view.outputVersion=undefined;target.textContent='';summary.textContent=currentManagedRun(view.identity)?'Output changed after credential redaction. Select Refresh to read again from the beginning.':'This task changed. Reopen its command output from the current task.';}else summary.textContent=errorText(error);}}
}
async function stopManagedProcess(identity){
  const run=currentManagedRun(identity);if(!run||terminal.has(run.status)||run.status==='stopping')throw new Error('This command belongs to an older or finished task. Refresh the task before stopping it.');
  await api(`/api/bots/${encodeURIComponent(identity.botId)}/processes/${encodeURIComponent(identity.processId)}/stop`,{method:'POST',body:{runId:identity.runId,remoteRunId:identity.remoteRunId}});
  await refreshManagedRun(identity);toast('Stop requested for this command.');
}
// What a working bot is doing right now, in plain words, and how lively its thinking waves should be.
const toolPhrases=[[/^tools_load$/,'getting more tools','think'],[/^task_outcome_(set|check)$/,'checking the result','think'],[/^work_records_read$/,'reviewing earlier work','think'],[/^web_search$/,'searching the web','act'],[/^workspace_image$/,'looking at an image','act'],[/^browser_screenshot$/,'looking at a web page','act'],[/^browser_/,'browsing the web','act'],[/^(http_fetch|web_extract)$/,'reading the web','act'],[/^workspace_(write|edit|delete)$/,'editing files','act'],[/^workspace_/,'looking through files','act'],[/^documents_create$/,'making a document','act'],[/^documents_read$/,'reading a document','act'],[/^brain_(write|append)$/,'taking notes','act'],[/^(memory|skills)_propose$/,'suggesting what to learn','think'],[/^(brain|memory)_/,'checking its memory','think'],[/^skills_run$/,'running a skill','act'],[/^skills_/,'reading a playbook','think'],[/^shell_|^terminal/,'running a command','act'],[/^lsp_/,'reading the code','act'],[/^integration_/,'using an integration','act'],[/^task_plan_/,'planning','think'],[/^routines_/,'arranging a routine','act'],[/^tool_result_read$/,'reading results','think']];
function thinkingPhase(bot,run){
  if(runRecovery(run)?.retrying)return {energy:'calm',text:'is recovering saved progress'};
  if(run.status==='queued')return {energy:'calm',text:'is getting ready'};
  if(run.status==='stopping')return {energy:'calm',text:'is stopping'};
  const events=run.events||[];
  if(run.status==='waiting_for_delegate'){const handoff=events.findLast?.(event=>event.type==='delegation.started'),peer=botById(handoff?.targetBotId||handoff?.botId);return {energy:'talk',text:`is talking with ${peer?.name||'a teammate'}`,peer};}
  if(run.partialOutput)return {energy:'write',text:'is writing'};
  const last=events.findLast?.(event=>['model.started','tool.started','tool.completed','memory.recalled','context.compacted','context.pruned','delegation.completed','skill.reviewing'].includes(event.type));
  if(last?.type==='tool.started'){const match=toolPhrases.find(([pattern])=>pattern.test(String(last.tool||'')));return {energy:match?.[2]||'act',text:`is ${match?.[1]||'working'}`};}
  if(last?.type==='skill.reviewing')return {energy:'think',text:'is reviewing what to keep'};
  if(last?.type==='memory.recalled')return {energy:'think',text:'is remembering'};
  if(last?.type==='delegation.completed')return {energy:'think',text:'is reading a teammate’s reply'};
  return {energy:'think',text:last?'is thinking':'is working'};
}
function thinkingMarkup(bot,run,{key,compact=false,phase=thinkingPhase(bot,run),stop='',prompt=''}={}){
  const colors=window.StudioAvatars?.colors?.(bot)||[],peerColors=phase.peer&&window.StudioAvatars?.colors?.(phase.peer)||[];
  const tint=(colors.length?`--think-light:${colors[0]};--think-mid:${colors[1]};--think-deep:${colors[2]};`:'')+(peerColors.length?`--think-peer:${peerColors[1]};`:'');
  let flow=null;
  try{flow=window.StudioActivityModel?.build(bot,run,{prompt:String(prompt||'').slice(0,4000),peers:data.bots||[]})||null;}catch{}
  // Events update the presentation, while data-keep retains the live canvas and its morphing state.
  const cardKey=messageKey({id:`thinking-${key}`,role:'thinking',content:[bot.id,phase.energy,phase.text,compact,stop,colors,peerColors,run.createdAt||'',flow?.signature||'']});
  const caption=flow?.caption||`${bot.name} ${phase.text}`;
  return `<article class="chat-message thinking-message ${compact?'is-compact':''}" data-message-key="${cardKey}">${avatar(bot,'tiny','thinking')}<div class="message-content"><div class="thinking-card" role="group" aria-label="${esc(flow?`${bot.name}: ${caption}`:`${bot.name} ${phase.text}`)}" data-thinking-card data-energy="${esc(phase.energy)}" data-colors="${esc(colors.join(','))}" ${peerColors.length?`data-peer-colors="${esc(peerColors.join(','))}"`:''} ${flow?`data-flow="${esc(JSON.stringify(flow))}" data-flow-kind="${esc(flow.kind)}"`:''} data-started="${esc(run.createdAt||'')}" style="${esc(tint)}"><canvas class="thinking-canvas" data-thinking="${esc(key)}" data-keep="thinking-${esc(key)}" aria-hidden="true"></canvas><div class="thinking-caption"><div class="thinking-copy"><span class="thinking-phase">${esc(caption)}</span></div><span class="thinking-elapsed" data-thinking-elapsed></span>${stop}</div></div></div></article>`;
}
function learningMessageMap(messages,bot,run){
  const runs=new Map(),markup=new Map();
  messages.forEach((message,index)=>{if(!message.runId)return;const entry=runs.get(message.runId)||{};entry.index=index;if(Array.isArray(message.learningChanges))entry.changes=message.learningChanges;runs.set(message.runId,entry);});
  for(const [runId,entry] of runs){if(run?.id===runId&&!terminal.has(run.status))continue;markup.set(entry.index,window.StudioChatLearning?.render(entry.changes || (run?.id===runId?run.learningChanges:[]),bot.id)||'');}
  return markup;
}
function renderThread(bot){
  if(!bot||route().id!==bot.id)return;const container=$('#chat-thread');if(!container)return;
  // An earlier chat is read-only: its messages show, the composer hides and live work stays with the chat it belongs to.
  const earlier=chat.session&&chat.session.active===false,messages=chat.messages||[],run=earlier&&!messages.some(message=>message.runId===chat.run?.id)?null:chat.run;
  const nearBottom=container.scrollTop+container.clientHeight>=container.scrollHeight-80,timelineOpen=taskDetailsOpen(container,run);
  window.StudioBrowser?.observeRun(bot.id,run);
  data.runs ||= {};if(chat.run)data.runs[bot.id]=chat.run;else delete data.runs[bot.id];updateChatReview(bot);
  const headerStatus=$('.chat-header .chat-tools');if(headerStatus)headerStatus.innerHTML=statusPill(bot);const switcherLine=$('.chat-switcher-status');if(switcherLine)switcherLine.outerHTML=switcherStatus(bot);syncBotAvatarMotion(bot);
  const savedLearning=learningMessageMap(messages,bot,run),finishedActivity=run&&terminal.has(run.status)?completedRunActivity(run):'',activityIndex=finishedActivity?messages.findLastIndex(message=>message.runId===run.id&&message.role!=='user'):-1;
  let html=messages.length?messages.map((m,index)=>messageMarkup(m,bot,'thread-'+messageKey(m))+(savedLearning.get(index)||'')+(index===activityIndex?finishedActivity:'')).join(''):chat.loadError?'':`<div class="chat-welcome">${avatar(bot,'large','thread-welcome')}<h2>Say hello to ${esc(bot.name)}</h2><p>${esc(bot.description||'Your next great idea starts with a conversation.')}<br>${bot.connectionId?'What should we work on?':'Connect a model in Settings › Models to get started.'}</p>${window.StudioOnboarding?.chatTips(studioContext(),bot)||`<div class="starter-prompts">${prompts(bot).map(text=>`<button class="starter-prompt" data-action="starter" data-text="${esc(text)}">${icon('chat')}${esc(text)}</button>`).join('')}</div>`}${!bot.connectionId?`<button class="text-button" data-action="edit-bot" data-id="${esc(bot.id)}">Connect ${esc(bot.name)}${icon('arrow')}</button>`:''}</div>`;
  const partial=run?.partialOutput||run?.output;
  if(run&&!terminal.has(run.status))html+=liveRunMarkup(bot,run,messages);
  else if(partial&&run.status!=='completed'&&!messages.some(message=>message.runId===run.id&&message.partial))html+=`<article class="chat-message partial-message">${avatar(bot,'tiny','thread-partial')}<div class="message-content"><div class="message-label">${esc(bot.name)}<span class="streaming-label">${terminal.has(run.status)?'Partial response':'Working'}</span></div>${messageText(partial,{streaming:!terminal.has(run.status)})}</div></article>`;
  if(run&&!terminal.has(run.status))html+=window.StudioChatLearning?.render(run.learningChanges,bot.id)||'';
  if(finishedActivity&&activityIndex<0)html+=finishedActivity;
  html+=renderTimeline(run,timelineOpen);
  if(run&&!terminal.has(run.status)){
    const stopData=esc(JSON.stringify({runId:run.id,remoteRunId:run.remoteRunId||run.id}));
    if(run.status==='waiting_for_approval'){
      html+=approvalCard(bot,run);
    }else if(run.status==='waiting_for_input')html+=(window.StudioBrowser?.renderCard(bot,run)||questionCard(bot,run));
    else if(runRecovery(run))html+=recoveryMarkup(run,`<button class="text-button" data-action="stop-run" data-id="${esc(bot.id)}" data-run="${stopData}" ${run.status==='stopping'?'disabled':''}>${icon('stop')}Stop</button>`);
    else html+=thinkingMarkup(bot,run,{key:run.id,compact:!!partial,prompt:messages.findLast?.(message=>message.role==='user'&&message.runId===run.id&&!message.kind)?.content||'',stop:`<button class="thinking-stop" data-action="stop-run" data-id="${esc(bot.id)}" data-run="${stopData}" ${run.status==='stopping'?'disabled':''}>${icon('stop')}Stop</button>`});
  }else if(run&&terminal.has(run.status)&&run.status!=='completed'){if(runRecovery(run))html+=recoveryMarkup(run);else {const detail=run.status==='cancelled'?'Task stopped. Any available partial response is shown above.':run.error?.message||run.error||run.message||`This task ${run.status}. Open task details and check the provider settings before trying again.`;html+=`<div class="run-status ${run.status==='cancelled'?'':'run-error'}">${icon('info')}<span>${esc(typeof detail==='string'?detail:JSON.stringify(detail))}</span></div>`;}}
  if(run?.pollError)html+=`<div class="run-status run-error">${icon('info')}<span>${esc(run.pollError)}</span></div>`;
  html+=conversationErrorMarkup(chat.loadError,bot.id);
  if(earlier)html+=`<div class="run-status chat-session-banner" role="status">${icon('clock')}<span><strong>Earlier chat</strong>${chat.session.title?` · ${esc(chat.session.title)}`:''}</span><button class="text-button" data-action="resume-chat-session" data-id="${esc(bot.id)}" data-session="${esc(chat.session.id)}">${icon('play')}Continue this chat</button><button class="text-button" data-action="close-chat-session" data-id="${esc(bot.id)}">Back to current chat</button></div>`;
  const composer=$('#message-form');if(composer){composer.hidden=!!earlier;composer.closest('.chat-composer-wrap')?.classList.toggle('is-reading',!!earlier);}
  updateThreadContent(container,html);window.StudioThinking?.mount(container);window.StudioChatLearning?.mount(container,{liveRunId:run?.id,active:!!run&&!terminal.has(run.status)});if(nearBottom)container.scrollTop=container.scrollHeight;if(!chat.loadError)focusSearchMessage(container,'bot',bot.id);
  observeSpeechReplies('bot/'+bot.id,messages);
  const button=$('#message-form .send');if(button)button.disabled=(!!run&&!terminal.has(run.status))||attachmentUploads.has(bot.id);updateDirectionComposer(bot.id,run);
  if(run&&!terminal.has(run.status))patchLiveRun(run);syncLiveLoop();
}

async function loadChat(id,{poll=false}={}){
  const request=++messageRequest;if(id!==activeBot){activeBot=id;chat={messages:[],run:null};}if(chatSessionView&&chatSessionView.botId!==id)chatSessionView=null;const viewing=chatSessionView?.sessionId||'';if(!poll)void loadChatInference(id);
  const currentThread=()=>{const current=route();return request===messageRequest&&auth?.authenticated&&current.view==='bot'&&current.id===id?$('#chat-thread'):null;};
  // A poll skips an unchanged transcript only when the thread on screen was drawn from that exact response.
  try{const etag=poll&&chat.etag&&$('#chat-thread')?.__chatEtag===chat.etag?chat.etag:'',response=await api(`/api/bots/${encodeURIComponent(id)}/messages${viewing?`?session=${encodeURIComponent(viewing)}`:''}`,{etag});if(!currentThread()||(chatSessionView?.sessionId||'')!==viewing)return;if(response.notModified){if(!chat.loadError){const container=currentThread();if(container)focusSearchMessage(container,'bot',id);return;}chat.loadError=null;}else{
    // A finished task may have created bots, routines or skills from chat; refresh the workspace so the sidebar and pages show them.
    const finished=chat.run&&!terminal.has(chat.run.status)&&response.body?.run?.id===chat.run.id&&terminal.has(response.body.run.status),attentionChanged=['waiting_for_input','waiting_for_approval'].includes(chat.run?.status)||['waiting_for_input','waiting_for_approval'].includes(response.body?.run?.status);
    const previousRun=chat.run;if(response.body?.session?.active&&chatSessionView)chatSessionView=null;chat={messages:[],run:null,elsewhere:null,...response.body,etag:response.etag,loaded:true,loadError:null};chat.run=mergeLiveRun(previousRun,chat.run);
    if(attentionChanged)void refreshUnread();
    if(Array.isArray(response.body?.missions))data.missions=response.body.missions;
    if(Object.hasOwn(response.body||{},'lastMessageAt'))(data.botLastMessageAt ||= {})[id]=response.body.lastMessageAt;
    if(finished)refresh(false).then(ok=>{if(ok)updateSidebar();}).catch(()=>{});
  }data.runs??={};if(chat.run)data.runs[id]=chat.run;updateChatInferenceBar(botById(id));renderThread(botById(id));updateElsewhereNotice(botById(id));const thread=currentThread();if(thread)thread.__chatEtag=chat.etag;}
  catch(error){if(!currentThread())return;chat.loadError=conversationLoadError(error,chat.loaded);renderThread(botById(id));}
}
function openDialog(title,body,{wide=false}={}){
  closeInferencePicker(true,false);
  window.StudioBrowser?.reset();
  if(loginPollTimer){clearInterval(loginPollTimer);loginPollTimer=null;}
  const root=$('#dialog-root');window.StudioRich?.dispose(root);
  root.innerHTML=`<dialog class="modal ${wide?'wide':''}" aria-label="${esc(title)}"><button type="button" class="sheet-grabber" data-action="close-dialog" aria-label="Dismiss sheet"><span></span></button><div class="modal-head"><h2 tabindex="-1" ${phoneLayout()?'autofocus':''}>${esc(title)}</h2><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">${icon('close')}</button></div><div class="modal-body">${body}</div></dialog>`;
  const dialog=$('dialog',root);dialog.showModal();
  window.StudioMobile?.mountDialog(dialog,closeDialog);
  dialog.addEventListener('click',event=>{if(event.target===dialog){const bounds=dialog.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)closeDialog();}});
  dialog.addEventListener('close',()=>{if($('dialog',root)===dialog){window.StudioRich?.dispose(root);for(const pdf of root.querySelectorAll?.('.pdf-preview')||[])window.StudioRich?.dispose(pdf);document.body.classList.remove('scroll-lock');root.innerHTML='';}},{once:true});
  document.body.classList.add('scroll-lock');
}
function closeDialog(){
  window.StudioBrowser?.reset();
  if(loginPollTimer){clearInterval(loginPollTimer);loginPollTimer=null;}
  const dialog=$('dialog');if(!dialog)return;
  if(window.StudioMobile?.closeSheet(dialog,()=>dialog.close()))return;
  dialog.close();
}
let conversationSearchRequest=0,pendingSearchMessage=null,conversationSearchNavigation=0,activeConversationSearch=null,clearSearchAnchor=null;
function dismissConversationSearch(){
  const search=activeConversationSearch;if(!search)return;
  search.dispose();search.dialog.close();
}
function focusSearchMessage(container,scope,id){
  const target=pendingSearchMessage;if(!target||target.scope!==scope||target.id!==id)return;
  if(!auth?.authenticated||target.generation!==sendSessionGeneration||target.navigation!==conversationSearchNavigation){pendingSearchMessage=null;return;}
  pendingSearchMessage=null;
  const node=[...container.querySelectorAll('[data-search-message-id]')].find(item=>item.dataset.searchMessageId===target.messageId);
  if(!node){toast('That message is no longer available in this conversation.',true);return;}
  container.querySelectorAll('.search-message-target').forEach(item=>item.classList.remove('search-message-target'));
  node.classList.add('search-message-target');node.tabIndex=-1;node.focus?.({preventScroll:true});
  clearSearchAnchor?.();container.__searchAnchor=target;let frame,timer;
  const current=()=>container.__searchAnchor===target&&node.isConnected&&target.generation===sendSessionGeneration&&target.navigation===conversationSearchNavigation&&auth?.authenticated;
  const align=()=>{if(!current())return false;const box=container.getBoundingClientRect?.(),item=node.getBoundingClientRect?.();if(!box?.height||!item?.height)return false;const top=box.top+Math.max(16,(box.height-Math.min(item.height,box.height-32))/2);container.scrollTop=Math.max(0,Math.min(container.scrollHeight-container.clientHeight,container.scrollTop+item.top-top));return true;};
  const cancel=()=>{if(container.__searchAnchor===target)delete container.__searchAnchor;clearTimeout(timer);window.cancelAnimationFrame?.(frame);for(const event of ['wheel','touchstart','pointerdown','keydown'])document.removeEventListener(event,cancel,true);if(clearSearchAnchor===cancel)clearSearchAnchor=null;};clearSearchAnchor=cancel;
  for(const event of ['wheel','touchstart','pointerdown','keydown'])document.addEventListener(event,cancel,{capture:true,passive:true});
  if(!align())node.scrollIntoView?.({block:'center',behavior:'auto'});
  frame=window.requestAnimationFrame?.(()=>{align();frame=window.requestAnimationFrame?.(align);});timer=setTimeout(align,400);
}
/** The bot's chats: open one to read it, continue it, rename or delete it. Switching waits until the bot is idle. */
async function chatSessionsDialog(botId){
  const bot=botById(botId);if(!bot)return;
  const result=await api(`/api/bots/${encodeURIComponent(botId)}/sessions`),busy=!!data.runs?.[botId]&&!terminal.has(data.runs[botId].status);
  const row=item=>{const title=item.title||'New chat',when=item.updatedAt?new Date(item.updatedAt).toLocaleString([],{dateStyle:'medium',timeStyle:'short'}):'No messages yet';return `<div class="chat-session-row${item.active?' is-active':''}" data-session-row="${esc(item.id)}"><button type="button" class="conversation-search-result" data-action="open-chat-session" data-id="${esc(botId)}" data-session="${esc(item.id)}" data-active="${item.active}"><span><strong>${esc(title)}</strong><small>${item.active?'Current chat · ':''}${esc(when)} · ${item.messageCount} message${item.messageCount===1?'':'s'}</small></span></button><span class="chat-session-actions">${item.active?'':`<button type="button" class="icon-button" data-action="resume-chat-session" data-id="${esc(botId)}" data-session="${esc(item.id)}" title="Continue this chat" aria-label="Continue ${esc(title)}" ${busy?'disabled':''}>${icon('play')}</button>`}<button type="button" class="icon-button" data-action="rename-chat-session" data-id="${esc(botId)}" data-session="${esc(item.id)}" data-title="${esc(item.title||'')}" title="Rename" aria-label="Rename ${esc(title)}">${icon('edit')}</button><button type="button" class="icon-button" data-action="delete-chat-session" data-id="${esc(botId)}" data-session="${esc(item.id)}" data-title="${esc(title)}" title="Delete" aria-label="Delete ${esc(title)}" ${busy?'disabled':''}>${icon('trash')}</button></span></div>`;};
  const body=`<div class="chat-sessions"><div class="chat-sessions-toolbar"><p class="subtle-label">Each chat has its own working context. Memory, notes and files are shared, and the bot can search earlier chats.</p><button type="button" class="primary-button" data-action="new-chat" data-id="${esc(botId)}" ${busy?'disabled':''}>${icon('plus')}New chat</button></div>${busy?'<p class="subtle-label">Switching chats is available when the current task finishes.</p>':''}<div class="conversation-search-list">${result.data.map(row).join('')}</div></div>`;
  const open=$('dialog .chat-sessions');if(open)open.outerHTML=body;else openDialog(`${bot.name} · Chats`,body);
}
function renameChatSessionRow(button,botId){
  const row=button.closest('[data-session-row]');if(!row||row.querySelector('form'))return;const sessionId=button.dataset.session;
  const form=document.createElement('form');form.className='chat-session-rename';form.innerHTML=`<input type="text" maxlength="80" required aria-label="Chat title" value="${esc(button.dataset.title||'')}"><button class="primary-button" type="submit">Save</button>`;
  row.append(form);const input=form.querySelector('input');input.focus();input.select();
  form.addEventListener('submit',async event=>{event.preventDefault();event.stopPropagation();const title=input.value.trim();if(!title)return;try{await api(`/api/bots/${encodeURIComponent(botId)}/sessions/${encodeURIComponent(sessionId)}`,{method:'PATCH',body:{title}});await chatSessionsDialog(botId);if(route().view==='bot'&&route().id===botId)void loadChat(botId);}catch(error){toast(errorText(error),true);}});
}
function conversationSearchDialog(scope='',id='',query=''){
  clearSearchAnchor?.();conversationSearchNavigation++;pendingSearchMessage=null;dismissConversationSearch();
  const scoped=['bot','room'].includes(scope)&&id,choices=scoped?`<option value="${scope}" selected>This conversation</option><option value="all">All conversations</option>`:'<option value="all">All conversations</option><option value="bot">Bot chats</option><option value="room">Team rooms</option>';
  openDialog('Search conversations',`<form id="conversation-search-form"><div class="field"><label for="conversation-search-query">Words or a phrase</label><input type="search" id="conversation-search-query" autocomplete="off" maxlength="200" placeholder="Find an earlier message…"></div><div class="conversation-search-controls"><label for="conversation-search-scope">Search in</label><select id="conversation-search-scope">${choices}</select><button class="primary-button" type="submit">${icon('search')}Search</button></div><p class="subtle-label">Searches stored messages on this engine. Your query is not sent to a model.</p><div id="conversation-search-results" role="status" aria-live="polite"><p>Enter at least two characters.</p></div></form>`);
  const dialog=$('dialog'),form=$('#conversation-search-form',dialog),input=$('#conversation-search-query',dialog),results=$('#conversation-search-results',dialog),generation=sendSessionGeneration,navigation=conversationSearchNavigation;let timer,controller;
  const dispose=()=>{controller?.abort();clearTimeout(timer);conversationSearchRequest++;if(activeConversationSearch?.dialog===dialog)activeConversationSearch=null;};activeConversationSearch={dialog,dispose};
  const run=async()=>{
    clearTimeout(timer);controller?.abort();const request=++conversationSearchRequest,query=input.value.trim();
    if(!auth?.authenticated||generation!==sendSessionGeneration||navigation!==conversationSearchNavigation||!dialog.isConnected||!dialog.open)return;
    if(query.length<2){results.innerHTML='<p>Enter at least two characters.</p>';return;}
    if(query.length>200||new Set(query.toLocaleLowerCase().split(/\s+/u)).size>20){results.innerHTML='<p role="alert">Use at most 200 characters and twenty search words.</p>';return;}
    controller=new AbortController();results.innerHTML='<p>Searching…</p>';
    const current=()=>request===conversationSearchRequest&&dialog.isConnected&&dialog.open&&generation===sendSessionGeneration&&navigation===conversationSearchNavigation&&auth?.authenticated;
    try{const selected=$('#conversation-search-scope',dialog).value,params=new URLSearchParams({query,scope:selected});if(scoped&&selected===scope)params.set('conversationId',id);const result=await api(`/api/conversations/search?${params}`,{signal:controller.signal});if(!current())return;
      results.innerHTML=`<p>${result.total?`${result.results.length} of ${result.total} matches`:'No matching messages.'}${result.hasMore?' · Narrow your search for more specific results.':''}</p>${result.notice?`<p class="conversation-search-notice">${esc(result.notice)}</p>`:''}<div class="conversation-search-list">${result.results.map(item=>`<button type="button" class="conversation-search-result" data-action="open-search-result" data-scope="${esc(item.scope)}" data-id="${esc(item.conversationId)}" data-message-id="${esc(item.messageId)}" data-session="${esc(item.chatSessionId||'')}"><span><strong>${esc(item.name)}</strong><small>${item.scope==='room'?'Team room':'Bot chat'} · ${item.role==='user'?'You':item.role==='system'?'Tupies':'Reply'}${item.createdAt?` · ${esc(new Date(item.createdAt).toLocaleDateString())}`:''}</small></span><span class="conversation-search-excerpt">${esc(item.excerpt)}</span></button>`).join('')}</div>`;
    }catch(error){if(current()&&error.name!=='AbortError')results.innerHTML=`<p role="alert">${esc(errorText(error))}</p>`;}
  };
  form.addEventListener('submit',event=>{event.preventDefault();void run();});input.addEventListener('input',()=>{controller?.abort();conversationSearchRequest++;clearTimeout(timer);timer=setTimeout(run,250);});$('#conversation-search-scope',dialog).addEventListener('change',()=>void run());
  dialog.addEventListener('close',dispose,{once:true});input.value=query;input.focus();if(query.trim())void run();
}
function openSearchResult(scope,id,messageId){
  if(!['bot','room'].includes(scope)||![id,messageId].every(value=>/^[a-zA-Z0-9_-]{1,120}$/.test(value)))return;
  const generation=sendSessionGeneration,navigation=conversationSearchNavigation,go=async()=>{if(generation!==sendSessionGeneration||navigation!==conversationSearchNavigation||!auth?.authenticated)return;const current=route(),same=current.view===scope&&current.id===id;pendingSearchMessage={scope,id,messageId,generation,navigation:navigation+(same?0:1)};if(same){const container=$(scope==='bot'?'#chat-thread':'#room-thread');if(container&&[...container.querySelectorAll('[data-search-message-id]')].some(node=>node.dataset.searchMessageId===messageId))focusSearchMessage(container,scope,id);else if(scope==='bot')await loadChat(id);else await loadRoomChat(id);}else navigate(`/${scope}/${id}`);};
  const dialog=$('dialog');if(dialog){dialog.addEventListener('close',()=>void go().catch(error=>toast(errorText(error),true)),{once:true});closeDialog();}else void go();
}
const modalFooter=(label,danger='')=>`<p class="form-error" role="alert"></p><div class="modal-footer">${danger}<button class="secondary-button" type="button" data-action="close-dialog">Cancel</button><button class="primary-button" type="submit">${label}${icon('arrow')}</button></div>`;
function teamField(bot,id){
  const selected=bot.teamMode==='selected',others=data.bots.filter(b=>b.id!==id);
  const choice=(value,title,detail)=>`<label class="team-mode-option"><input type="radio" name="teamMode" value="${value}" ${(value==='selected')===selected?'checked':''}><span><strong>${title}</strong><small>${detail}</small></span></label>`;
  return `<fieldset class="field team-mode"><legend class="field-label">Teammates</legend><div class="team-mode-options">${choice('all','The whole team','Knows every bot and can talk with any of them.')}${choice('selected','Only selected teammates','Knows and talks with the bots you pick.')}</div><div class="skill-checklist team-checklist" ${selected?'':'hidden'}>${others.map(b=>`<label><input type="checkbox" name="collaborator" value="${esc(b.id)}" ${(bot.collaborators||[]).includes(b.id)?'checked':''}>${esc(b.name)}</label>`).join('')||'<span class="subtle-label">Add another bot to enable collaboration.</span>'}</div><small>Conversations between bots are bounded in depth and number. Each bot still asks you before its own reviewed actions.</small></fieldset>`;
}
function isExaSearch(integration){
  return integration?.type==='rest'&&String(integration.baseUrl||'').replace(/\/+$/,'')==='https://api.exa.ai'&&!!integration.hasKey&&(integration.authType==='bearer'||integration.authType==='header'&&String(integration.headerName||'').toLowerCase()==='x-api-key');
}
const defaultSearchIntegration=()=>data.integrations.find(isExaSearch)||null;
function searchFallbackLabel(integration){
  const action=(integration.tools||[]).find(tool=>tool.name==='web_search');
  if(integration.type!=='rest'||!action)return '';
  if(action.path==='/search'&&action.method==='GET'&&action.inputSchema?.properties?.format?.enum?.includes('json'))return 'SearXNG';
  if(integration.baseUrl==='https://api.tavily.com'&&action.path==='/search'&&action.method==='POST')return 'Tavily';
  if(integration.baseUrl==='https://api.search.brave.com/res'&&action.path==='/v1/web/search'&&action.method==='GET')return 'Brave Search';
  return '';
}
function searchFallbackField(bot){
  const choices=data.integrations.map(item=>({item,provider:searchFallbackLabel(item)})).filter(entry=>entry.provider);
  return `<div class="field"><label for="bot-search-fallback">If DuckDuckGo is unavailable</label><select id="bot-search-fallback" name="searchFallbackIntegrationId"><option value="">Report the search problem</option>${choices.map(({item,provider})=>`<option value="${esc(item.id)}" ${bot.searchFallbackIntegrationId===item.id?'selected':''}>${esc(item.name)} · ${esc(provider)}</option>`).join('')}</select><small>Optional. Choose your own SearXNG connection or another configured search service. Queries go there only after a DuckDuckGo failure and your exact approval. Requires Web and Integrations. Configure a service in Settings → Integrations first.</small></div>`;
}
function botSettingsForm(id,{embedded=false,template=null}={}){
  const bot=botById(id)||{...template,connectionId:data.settings.defaultConnectionId||'',model:''};
  const storedIcon=bot.icon||(id?'':'companion:blue');
  const color=({sage:'mint',lilac:'lavender'}[bot.color]||bot.color)||'slate';
  const toolGroups=[['engine_workshop','Engine workshop','Read allowlisted Tupies source and prepare isolated candidate changes with syntax and pure-function checks. No live Engine modification or full runtime testing.'],['workshop','Tool workshop','Create, test and reuse isolated JavaScript tools. No network, system files or credentials. Approve for me and Balanced run automatically; Strict asks before saving packages.'],['workspace','Files','Read and write this bot’s private workspace.'],['skills','Use skills','Read assigned playbooks and propose reusable workflows. New playbooks follow this bot’s Action review mode.'],['web','Web research','Search the web and read public pages.'],['integrations','Connected services','Use only the integrations assigned below, following Action review.'],['delegation','Bot collaboration','Talk with teammates: ask questions and hand off work.'],['automation','Routines','Create and manage this bot’s recurring work, following Action review.'],['setup','Manage Tupies','Create bots, assign skills and schedule routines from chat, following Action review.'],['terminal','Terminal','Run commands using this bot’s Action review mode.'],['desktop','Desktop on this Mac','Work in assigned Mac applications using Action review and verified results. Configure applications in Settings → Desktop.'],['coding','Coding on this Mac','Discover local projects and delegate coding work to connected Claude Code or Codex after approval.'],['browser','Browser',`Browse and fill forms using this bot’s Action review mode. Take over for sign-in, verification codes and CAPTCHA.${data.browser&&!data.browser.available?' Not available on this engine yet: install Chrome or Chromium.':''}`]];
  const selectedCompanion=window.StudioAvatars?.describe({...bot,icon:storedIcon}).variant||'blue';
  const companionChoices=window.StudioAvatars?.shapes||[{id:'companion:blue',label:'Blue'},{id:'companion:coral',label:'Coral'},{id:'companion:jade',label:'Jade'},{id:'companion:honey',label:'Honey'}];
  const enabledTools=bot.tools||['workspace','memory','skills','web','integrations','delegation','automation','setup'];
  const sections=[['general','General','bots'],['instructions','Instructions','edit'],['model','Model','spark'],['tools','Tools','sliders'],['skills','Skills','book'],['memory','Memory','brain'],['team','Team','team'],['advanced','Advanced','settings'],...(embedded&&id?[['remove','Remove bot','trash']]:[])];
  const section=(key,title,description,content)=>`<section class="glass-card bot-settings-section" data-bot-settings-section="${key}" aria-labelledby="bot-section-${key}"${embedded&&key!=='general'?' hidden':''}><header><h2 id="bot-section-${key}" tabindex="-1">${title}</h2><p>${description}</p></header>${content}</section>`;
  const toolOption=key=>{const [,label,description]=toolGroups.find(item=>item[0]===key);return `<label class="permission-option"><input type="checkbox" name="tool" value="${key}" ${enabledTools.includes(key)?'checked':''}><span><strong>${label}</strong><small>${description}</small></span></label>`;};
  const toolGroup=(title,description,keys,extra='')=>`<details class="bot-capabilities"><summary><span><strong>${title}</strong><small>${description}</small></span><span class="bot-group-count" data-tool-count>${keys.filter(key=>enabledTools.includes(key)).length} of ${keys.length} enabled</span>${icon('chevronDown')}</summary><div class="bot-capability-body"><div class="permissions-grid">${keys.map(toolOption).join('')}</div>${extra}</div></details>`;
  const installedSkills=[...data.skills,...(bot.skills||[]).filter(id=>!data.skills.some(skill=>skill.id===id)).map(id=>({id,name:id,description:'This assigned skill is unavailable on this engine.'}))];
  const skills=`${toolOption('skills')}<p class="bot-settings-note" data-skill-access-notice${enabledTools.includes('skills')?' hidden':''}>Turn on Use skills to let this bot read its assigned playbooks.</p><div class="bot-settings-toolbar"><label class="bp-search">${icon('search')}<input type="search" data-settings-skill-search placeholder="Search installed skills" aria-label="Search installed skills" autocomplete="off"></label><select class="bp-select" data-settings-skill-filter aria-label="Show skills"><option value="all">All installed</option><option value="assigned">Assigned only</option></select></div><p class="subtle-label" data-settings-skill-results role="status">${(bot.skills||[]).length} assigned · ${installedSkills.length} installed</p><div class="bot-skill-options" data-settings-skill-list>${installedSkills.map(skill=>`<label class="bot-skill-option" data-skill-option><input type="checkbox" name="skill" value="${esc(skill.id)}" ${(bot.skills||[]).includes(skill.id)?'checked':''}${skill.available===false&&!(bot.skills||[]).includes(skill.id)?' disabled':''}><span><strong>${esc(skill.title||skill.name||skill.id)}</strong><small>${esc(skill.available===false?'Files unavailable on this engine.':skill.description||'A reusable playbook for this bot.')}</small></span></label>`).join('')}</div><p class="bot-settings-note" data-settings-skill-empty${installedSkills.length?' hidden':''}>No installed skills yet. Browse the library to add a playbook.</p><a class="secondary-button bot-library-link" href="#/skills${id?`/${esc(id)}`:''}">${icon('book')}Browse skill library${icon('arrow')}</a><p class="subtle-label">Assigning a skill adds guidance. It never grants extra tool permissions.</p>`;
  const memory=`<label class="permission-option"><input type="checkbox" name="tool" value="memory" ${enabledTools.includes('memory')?'checked':''}><span><strong>Memory and Brain</strong><small>Let this bot find and update its private facts and long-term notes.</small></span></label>
    <label class="checkbox-field"><input type="checkbox" name="episodicMemory" ${bot.episodicMemory?'checked':''}>Save brief task notes</label>
    <p class="subtle-label">Automatically record the request, task status and verified output paths in Brain. Off by default. Requires Memory and Approve for me or Balanced action review; other people’s chats and teammate work are excluded.</p>
    <div class="bot-memory-guide"><p><strong>Brain notes</strong> hold detailed knowledge. The bot is instructed to save useful findings, but a meaningful note after every task is not guaranteed.</p><p><strong>Learning</strong> holds suggested changes to facts and skills. Nothing is applied until you accept it.</p><p><strong>Reusable methods</strong> can become skills after substantial chat work. Approve for me saves them automatically; Balanced and Strict add a Learning suggestion.</p></div>
    ${id?`<nav class="bot-settings-links" aria-label="Memory content"><a href="#/bots/${esc(id)}/brain">Open Brain${icon('arrow')}</a><a href="#/bots/${esc(id)}/memory">Manage facts${icon('arrow')}</a><a href="#/bots/${esc(id)}/learning">Review Learning${icon('arrow')}</a></nav>`:''}`;
  const actionReview=`<div class="field bot-action-review"><label for="bot-approval-policy">Action review</label><select id="bot-approval-policy" name="approvalPolicy" aria-describedby="bot-approval-help"><option value="auto" ${(bot.approvalPolicy||'auto')==='auto'?'selected':''}>Approve for me · Automatic</option><option value="balanced" ${bot.approvalPolicy==='balanced'?'selected':''}>Balanced · Review outside actions and commands</option><option value="strict" ${bot.approvalPolicy==='strict'?'selected':''}>Strict · Also review every file change</option></select><small id="bot-approval-help">Approve for me works autonomously within enabled tools and reviews commands, browser actions and connected services for you. Asks before deletion, dangerous changes or unresolved risk. Commands are checked by built-in rules; other actions may use the task’s model for review and add usage. Saved for this bot across chats and restarts; applies to new tasks.</small></div>`;
  const footer=embedded?`<div class="bot-settings-save"><p class="form-error" role="alert"></p><div class="bot-settings-save-copy"><strong data-settings-status role="status">All changes saved</strong><span>Changes apply to the next task.</span></div><button type="button" class="secondary-button" data-profile-action="discard-settings" disabled>Discard</button><button class="primary-button bot-save-button" type="submit" disabled>Save changes${icon('check')}</button></div>`:modalFooter(id?'Save changes':'Create bot',id?`<button class="danger-button" type="button" data-action="delete-bot" data-id="${esc(id)}">Delete bot</button>`:'');
  const navigation=embedded?`<nav class="bot-settings-nav" aria-label="Settings sections">${sections.map(([key,label,ico])=>`<button type="button" class="secondary-button" data-profile-action="settings-section" data-section="${key}" aria-pressed="${key==='general'}">${icon(ico)}<span>${label}</span></button>`).join('')}</nav>`:'';
  return `<form id="bot-form" class="bot-settings-form${embedded?' is-page':''}" data-id="${esc(id||'')}"${embedded?' data-embedded="true"':''}>${navigation}<div class="bot-settings-content">${section('general','General','A name, role and familiar face for your teammate.',`${actionReview}<div class="field-row"><div class="field"><label for="bot-name">Name</label><input id="bot-name" name="name" value="${esc(bot.name||'')}" maxlength="60" placeholder="e.g. Atlas" required></div><div class="field"><label for="bot-title">Role</label><input id="bot-title" name="title" value="${esc(bot.title||'')}" maxlength="100" placeholder="e.g. Chief of staff" required></div></div><div class="field"><label for="bot-description">Short description</label><input id="bot-description" name="description" value="${esc(bot.description||'')}" maxlength="1000" placeholder="What will this bot help you with?"></div><div class="bot-appearance"><div id="bot-avatar-preview" class="bot-avatar-preview" aria-hidden="true">${avatar({...bot,color,icon:storedIcon},'large')}</div><div class="bot-appearance-controls"><span class="bot-avatar-name">Your companion</span><p class="bot-avatar-hint">A familiar face for your teammate.</p><details class="companion-library"><summary>Choose avatar<span>${companionChoices.length}</span>${icon('chevronDown')}</summary><div class="companion-picker" role="group" aria-label="Choose companion">${companionChoices.map(({id:iconId,label})=>{const variant=iconId.replace(/^companion:/,'');return `<button type="button" class="companion-choice" data-action="choose-companion" data-variant="${esc(variant)}" aria-pressed="${selectedCompanion===variant}">${avatar({icon:iconId},'tiny')}<span>${esc(label)}</span></button>`;}).join('')}</div></details><input id="bot-icon" type="hidden" name="icon" value="${esc(storedIcon)}"><input type="hidden" name="color" value="${esc(color)}"></div></div>`)}
    ${section('instructions','Instructions','Give your bot clear direction for every new task.',`<div class="field"><label for="bot-instructions">Instructions</label><textarea rows="14" aria-describedby="bot-instructions-help" id="bot-instructions" name="instructions" maxlength="20000" placeholder="How should your bot think, work, and communicate?">${esc(bot.instructions||'')}</textarea><small id="bot-instructions-help">Set the role, communication style and standing rules for this bot. These instructions are included in each new task.</small></div><div class="field-row bot-tone"><div class="field"><label for="bot-tone">Tone of voice</label><select id="bot-tone" name="tone">${[['','Default'],['plain','Plain · neutral, no filler'],['warm','Warm · a considerate colleague'],['brisk','Brisk · answer first, short'],['playful','Playful · a little humour']].map(([value,label])=>`<option value="${value}" ${(bot.tone||'')===value?'selected':''}>${label}</option>`).join('')}</select></div><div class="field"><label for="bot-tone-note">In your own words (optional)</label><input id="bot-tone-note" name="toneNote" maxlength="300" value="${esc(bot.toneNote||'')}" placeholder="e.g. dry, a bit sarcastic, never uses emoji"></div></div><p class="subtle-label">Tone only changes how replies are worded. It applies to new tasks.</p>`)}
    ${section('model','Model & reasoning','Choose how this bot thinks on new tasks.',`<div class="field"><label for="bot-connection">Model provider</label><select id="bot-connection" name="connectionId"><option value="">Choose later</option>${data.connections.filter(c=>c.type!=='legacy-hermes').map(c=>`<option value="${esc(c.id)}" ${bot.connectionId===c.id?'selected':''}>${esc(c.name)} · ${esc(providerMeta(c.type).name)}</option>`).join('')}</select><small>Provider credentials can be shared across bots. Their private state stays separate.</small></div><div class="field"><label for="bot-model">Model</label><input id="bot-model" name="model" value="${esc(bot.model||'')}" list="bot-models" placeholder="${esc(connectionById(bot.connectionId)?.defaultModel||'Use provider default')}" maxlength="200"><datalist id="bot-models">${modelItems(connectionById(bot.connectionId)?.models).map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</datalist><small>Leave empty to follow the default model. Enter a model only for this bot’s own override.</small></div><div id="bot-reasoning-field">${reasoningOptionsHTML(botReasoningCapabilities(bot),reasoningPreference(bot),{id:'bot-reasoning',connected:!!bot.connectionId,autoHigh:autoReasoningIsHigh(bot,botReasoningCapabilities(bot))})}</div>`)}
    ${section('tools','Tools','Choose the kinds of actions this bot can take. Open a group to review its access.',`${toolGroup('Everyday tools','Files, research and browsing',['workspace','web','browser','desktop'])}${toolGroup('Connected services','Assigned APIs, MCP servers and search fallback',['integrations'],`<div class="field"><span class="field-label">Assigned integrations</span><div class="skill-checklist bot-integration-list">${data.integrations.map(i=>`<label><input type="checkbox" name="integrationId" value="${esc(i.id)}" ${(bot.integrationIds||[]).includes(i.id)?'checked':''}><span>${esc(i.name)}</span></label>`).join('')||'<span class="subtle-label">Connect an API or MCP server from Settings → Integrations.</span>'}</div></div>${searchFallbackField(bot)}`)}${toolGroup('Automation & development','Routines, team setup and advanced tools',['automation','setup','terminal','coding','workshop','engine_workshop'],`<div class="field"><label for="bot-command-allowlist">Allowed commands</label><textarea id="bot-command-allowlist" name="commandAllowlist" rows="3" maxlength="10200" placeholder="npm test&#10;npm run *">${esc((bot.commandAllowlist||[]).join('\n'))}</textarea><small>One pattern per line; * matches any text. Matching terminal commands run without asking, also in routines and teammate work, except in Strict. Read-only commands need no entry; dangerous commands always ask.</small></div>`)}<p class="bot-settings-note">Tool access defines what this bot can request. Read-only commands and your allowed commands run automatically; dangerous commands, destructive changes and external actions still require your approval. Approved terminal tools use the server account’s OS permissions.</p>`)}
    ${section('skills','Skills','Assign reusable playbooks that guide how this bot works.',skills)}
    ${section('memory','Memory','Facts, Brain notes and reviewed learning.',memory)}
    ${section('team','Team','Choose who this bot can work with.',`${toolOption('delegation')}${teamField(bot,id)}`)}
    ${section('advanced','Advanced','Context, availability and visibility.',`<details class="pearl-advanced bot-advanced" data-settings-disclosure="advanced"${embedded?' open':''}><summary>Advanced settings</summary><div class="field-row bot-fallback"><div class="field"><label for="bot-fallback-connection">Fallback provider</label><select id="bot-fallback-connection" name="fallbackConnectionId"><option value="">No fallback</option>${data.connections.filter(c=>c.type!=='legacy-hermes').map(c=>`<option value="${esc(c.id)}" ${bot.fallback?.connectionId===c.id?'selected':''}>${esc(c.name)} · ${esc(providerMeta(c.type).name)}</option>`).join('')}</select></div><div class="field"><label for="bot-fallback-model">Fallback model</label><input id="bot-fallback-model" name="fallbackModel" value="${esc(bot.fallback?.model||'')}" maxlength="200" placeholder="e.g. a different provider’s model"></div></div><p class="subtle-label">If the main model keeps failing (after 6 automatic retries), its provider is unavailable or rate limited, or its balance or plan usage is used up, the same request is sent once to this model. Tools are never re-run.</p><div class="field"><label for="bot-context-limit">Context limit</label><select id="bot-context-limit" name="contextLimit"><option value="" ${!bot.contextLimit?'selected':''}>Automatic · up to 272K tokens</option><option value="128k" ${bot.contextLimit==='128k'?'selected':''}>128K tokens · lower cost per step</option><option value="max" ${bot.contextLimit==='max'?'selected':''}>The model’s full window</option></select><small>Every step sends the conversation to the model, so a larger limit costs more.</small></div><div class="field"><label for="bot-compact-threshold">Summarize older messages</label><select id="bot-compact-threshold" name="compactThreshold"><option value="" ${!bot.compactThreshold?'selected':''}>Automatic · at 55% of the limit</option>${[40,70,85].map(value=>`<option value="${value}" ${Number(bot.compactThreshold)===value?'selected':''}>At ${value}% of the limit</option>`).join('')}</select><small>Earlier turns become a summary of about a fifth of the limit; the full transcript stays in the chat.</small></div><div class="field-row bot-task-budget"><div class="field"><label for="bot-task-budget-usd">Task budget in US dollars</label><input id="bot-task-budget-usd" name="taskBudgetUsd" inputmode="decimal" maxlength="9" placeholder="No limit" value="${esc(bot.taskBudget?.usd??'')}"></div><div class="field"><label for="bot-task-budget-steps">Task budget in model steps</label><input id="bot-task-budget-steps" name="taskBudgetSteps" inputmode="numeric" maxlength="4" placeholder="No limit" value="${esc(bot.taskBudget?.steps??'')}"></div></div><p class="subtle-label">Optional. When one task reaches a budget, the bot pauses in your chat and asks whether to continue; in routines and other unattended work it stops and keeps what it has done. Dollars are an estimate and apply only to models with a known price.</p><label class="checkbox-field"><input type="checkbox" name="enabled" ${bot.enabled!==false?'checked':''}>Bot enabled</label><label class="checkbox-field"><input type="checkbox" name="hidden" ${bot.hidden?'checked':''}>Hide from the sidebar and Bots</label></details>`)}
    ${embedded&&id?section('remove','Remove bot','Remove this bot, its conversations, memory and routines from Tupies. Saved workspace files remain on this engine.',`<button class="danger-button" type="button" data-action="delete-bot" data-id="${esc(id)}">${icon('trash')}Delete bot</button>`):''}</div>${footer}</form>`;
}
function botDialog(id,templateId){
  const selectedTemplate=(data.botTemplates||[]).find(item=>item.id===templateId),guide=data.skills.find(item=>item.catalogId==='tupies-product');
  const template=selectedTemplate?{...selectedTemplate,skills:selectedTemplate.id==='ops'&&guide?[guide.id]:[]}:null;
  const picker=id?'':`<p class="modal-subtitle">Choose a starting point, then make it yours. Review the instructions and tools before creating your bot.</p><div class="onboarding-template-picker" aria-label="Bot templates">${[['','Blank bot'],...(data.botTemplates||[]).map(item=>[item.id,item.id==='ops'?'Ops':'Chief of Staff'])].map(([key,label])=>`<button type="button" class="secondary-button" data-action="starter-template" data-template="${esc(key)}" aria-pressed="${(templateId||'')===key}">${label}</button>`).join('')}</div>`;
  openDialog(id?`${botById(id)?.name||'Bot'} settings`:'New bot',picker+botSettingsForm(id,{template}),{wide:true});
  window.StudioBotProfile?.syncSettings($('#dialog-root #bot-form'));
}


function connectionDialog(id,type){
  const c=connectionById(id)||{}, selected=type||c.type||'openai', p=providerMeta(selected), oauth=oauthProvider(selected), local=p.auth==='none', endpointRequired=local||Object.hasOwn(p,'baseUrl')&&!p.baseUrl;
  openDialog(id?'Provider settings':`Connect ${p.name}`,`<p class="modal-subtitle">${oauth?'Sign in through the provider’s official authorization flow. Tupies keeps the account credentials on this server.':local?'Run a local model service and give Tupies its endpoint. The endpoint is reached from the Tupies server.':'Add your provider API key. Tupies runs the agent loop itself and sends inference requests directly to this provider.'}</p><form id="connection-form" data-id="${esc(id||'')}"><input type="hidden" name="type" value="${esc(selected)}"><div class="field"><label for="connection-name">A familiar name</label><input id="connection-name" name="name" value="${esc(c.name||p.name)}" maxlength="100" required></div>${!oauth&&!local?`<div class="field"><label for="connection-key">API key</label><input id="connection-key" name="apiKey" type="password" autocomplete="new-password" placeholder="${id?'Leave empty to keep the saved key':'Paste your provider API key'}" ${id?'':'required'}><small>Encrypted on the server. Never returned to this browser.</small></div>`:''}<div class="field"><label for="connection-model">Default model</label><input id="connection-model" name="defaultModel" value="${esc(c.defaultModel||p.defaultModel||'')}" list="connection-models" maxlength="200" placeholder="${esc(p.defaultModel||'Choose a model after connecting')}"><datalist id="connection-models">${modelItems(c.models||p.models).map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</datalist><small>Bots can use this default or choose their own model.</small></div>${!oauth?`<details class="advanced-fields" ${endpointRequired?'open':''}><summary>${local?'Local model endpoint':'Advanced endpoint settings'}</summary><div class="field"><label for="connection-url">API base URL</label><input id="connection-url" name="baseUrl" type="url" value="${esc(c.baseUrl||p.baseUrl||'')}" placeholder="https://api.example.com/v1" ${endpointRequired?'required':''}><small>${local?`Use the service’s OpenAI-compatible endpoint${p.baseUrl?`, usually ${esc(p.baseUrl)}`:''}.`:p.baseUrl?'Use the provider default unless you operate a compatible proxy.':'Enter the provider’s OpenAI-compatible base URL.'}</small></div><div class="field"><label for="connection-context">Context window (tokens)</label><input id="connection-context" name="contextWindow" type="number" inputmode="numeric" min="4000" max="10000000" step="1000" value="${esc(c.contextWindow||'')}" placeholder="Automatic"><small>Leave empty to use the window the provider reports. Set it when a local service runs models with a smaller context than they support.</small></div><div class="field"><label for="connection-images">Image input</label><select id="connection-images" name="imageInput">${[['auto','Automatic'],['on','Models here can see images'],['off','Text only']].map(([value,label])=>`<option value="${value}" ${(c.imageInput||'auto')===value?'selected':''}>${label}</option>`).join('')}</select><small>Automatic follows the provider’s model list and well-known model families. Choose for a local or compatible service whose models the list does not describe.</small></div></details>`:`<div class="info-banner">${icon('info')}<p>${selected==='chatgpt'?'ChatGPT subscription access uses official account authorization. Eligible local/self-hosted setups can sign in here; a paid hosted product needs the provider’s commercial onboarding.':'The optional Codex adapter uses a separately installed official Codex runtime in a dedicated Tupies account directory. It does not borrow existing application credentials.'}</p></div>`}${modalFooter(id?'Save changes':oauth?'Continue to sign in':'Save and test',id?`<button class="danger-button" type="button" data-action="delete-connection" data-id="${esc(id)}">Remove provider</button>`:'')}</form>`);
}
function chooseProviderDialog(){openDialog('Connect a model',`<p class="modal-subtitle">Choose where your bots’ models come from. You can add more later.</p><div class="provider-choice-grid in-modal">${providerCatalog.filter(p=>p.type!=='hermes').map(p=>`<button class="provider-choice glass-card" data-action="choose-provider" data-type="${esc(p.type)}">${providerBadge(p)}<strong>${esc(p.name||p.type)}</strong><small>${providerSubtitle(p)}</small>${icon('arrow')}</button>`).join('')||'<p class="modal-subtitle">The provider catalog could not be loaded. Refresh the workspace and try again.</p>'}</div>`,{wide:true});}
async function testConnectionDialog(id){
  const c=connectionById(id);openDialog(`Checking ${c?.name||'your provider'}`,`<div class="section-empty"><span class="loading-dot"></span><p>Checking credentials and the model catalog. No inference task is being submitted.</p></div>`);
  try{const result=await api(`/api/connections/${encodeURIComponent(id)}/test`,{method:'POST',body:{}});await refresh(false);const models=modelItems(result.models||connectionById(id)?.models);openDialog('Your provider is ready',`<p class="modal-subtitle">${esc(c?.name||'Your provider')} responded successfully.${models.length?` ${models.length} ${models.length===1?'model is':'models are'} available in the returned catalog.`:''}</p><p class="subtle-label">A catalog is not a guarantee that your plan can use every model. A completed task verifies inference access.</p><div class="modal-footer"><button class="secondary-button" data-action="close-dialog">Done</button><button class="primary-button" data-action="choose-default-model" data-id="${esc(id)}">${c?.defaultModel?'Change default model':'Choose default model'}${icon('arrow')}</button></div>`);}
  catch(error){await refresh(false);openDialog('Setup isn’t finished',`<p class="modal-subtitle">${esc(errorText(error))}</p><div class="modal-footer"><button class="secondary-button" data-action="close-dialog">Close</button><button class="primary-button" data-action="edit-connection" data-id="${esc(id)}">Review provider settings</button></div>`);}
}
async function assignProviderDialog(id){
  const c=connectionById(id);if(!c)return;let models=modelItems(c.models);
  try{const result=await api(`/api/connections/${encodeURIComponent(id)}/models`);models=modelItems(result.models||result.data||result);}catch{}
  openDialog(`Put ${c.name} to work`,`<p class="modal-subtitle">Choose the bots that should use this provider. Each bot keeps its own memory and workspace.</p><form id="assign-provider-form" data-id="${esc(id)}"><div class="room-member-picker">${data.bots.map(b=>`<label class="room-member"><input type="checkbox" name="botId" value="${esc(b.id)}" ${b.connectionId===id?'checked':''}>${avatar(b,'small')}<span><strong>${esc(b.name)}</strong><small>${esc(b.title)}</small></span></label>`).join('')}</div><div class="field"><label for="assign-model">Model</label><select id="assign-model" name="model"><option value="">${c.defaultModel?`Use default · ${esc(c.defaultModel)}`:'Choose a model'}</option>${models.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select><small>Use default keeps these bots in sync when you change your default model. Choose another model only to override it.</small></div>${modalFooter('Save assignment')}</form>`);
}

async function defaultModelDialog(id){
  const connection=connectionById(id);if(!connection)return;
  offeredDefaultModels.add(id);
  openDialog('Choose your default model','<div class="section-empty"><p>Loading models from your connected account…</p></div>');
  const loadingDialog=$('dialog');
  try{
    const result=await api(`/api/connections/${encodeURIComponent(id)}/models`),models=modelItems(result.models||[]);
    if($('dialog')!==loadingDialog)return;
    if(!models.length)throw new Error('Your account returned no models. Refresh the list or check that model access was enabled during sign-in.');
    const selected=models.some(model=>model.id===connection.defaultModel)?connection.defaultModel:'';
    openDialog('Choose your default model',`<p class="modal-subtitle">${esc(connection.name)} is connected. Choose the model your bots will use by default.</p><form id="default-model-form" data-id="${esc(id)}"><div class="default-model-list" role="radiogroup" aria-label="Available models">${models.map((model,index)=>`<label class="default-model-option"><input type="radio" name="model" id="default-model-${index}" value="${esc(model.id)}" ${model.id===selected?'checked':''} required><span><strong>${esc(model.name)}</strong><small>${esc(model.id)}</small></span><span class="model-choice-check" aria-hidden="true">${icon('check')}</span></label>`).join('')}</div><label class="checkbox-field default-model-scope"><input type="checkbox" name="applyToAllBots" checked><span>Apply to all existing bots<small>Every existing bot will follow this model. Uncheck to keep individual model and provider choices.</small></span></label><p class="subtle-label default-model-hint">New bots will use this default automatically.</p>${modalFooter('Use this model for my bots')}</form>`,{wide:true});
    const submit=$('#default-model-form button[type=submit]');if(submit)submit.disabled=!selected;
  }catch(error){
    if($('dialog')!==loadingDialog)return;
    openDialog('Choose your default model',`<p class="form-error" role="alert">${esc(errorText(error))}</p><p class="modal-subtitle">Your account is still connected. No model setting has been changed.</p><div class="modal-footer"><button class="secondary-button" data-action="close-dialog">Choose later</button><button class="primary-button" data-action="choose-default-model" data-id="${esc(id)}">Refresh models${icon('routine')}</button></div>`);
  }
}

function routineExecutionFields(r){const limits={runtimeMinutes:30,modelTurns:50,toolCalls:200,...r.limits},mode=r.limits?.mode==='bounded'?'bounded':'autonomous',bounded=mode==='bounded';
  const example={version:1,mode:'agent',steps:[{id:'feed',op:'fetch',url:'https://example.com/feed.json'},{id:'items',op:'json',from:'feed',path:'text'},{id:'newItems',op:'select',from:'items',key:'url',limit:25}],skipIfEmpty:'newItems',context:'Review these new items: {{newItems}}'};
  return `<details class="advanced-fields routine-execution"${r.workflow?.steps?.some(step=>step.op==='script')?' open':''}><summary>Advanced execution</summary><div class="field"><label for="routine-execution-mode">Execution</label><select id="routine-execution-mode" name="executionMode"><option value="autonomous" ${bounded?'':'selected'}>Work until done</option><option value="bounded" ${bounded?'selected':''}>Use explicit limits</option></select><small>Works toward completion and recovers from temporary interruptions. Stop remains available.</small></div><div data-routine-budget ${bounded?'':'hidden'}><div class="field"><label for="routine-runtime">Time budget, in minutes</label><input id="routine-runtime" name="runtimeMinutes" type="number" min="1" max="120" step="1" value="${esc(limits.runtimeMinutes)}" ${bounded?'':'disabled'} required><small>The whole run can use this much active time.</small></div><div class="field-row"><div class="field"><label for="routine-turns">Model turns</label><input id="routine-turns" name="modelTurns" type="number" min="1" max="200" step="1" value="${esc(limits.modelTurns)}" ${bounded?'':'disabled'} required></div><div class="field"><label for="routine-tools">Tool calls</label><input id="routine-tools" name="toolCalls" type="number" min="1" max="1000" step="1" value="${esc(limits.toolCalls)}" ${bounded?'':'disabled'} required></div></div></div><details class="advanced-fields"${r.workflow?.steps?.some(step=>step.op==='script')?' open':''}><summary>Saved preparation and reports</summary><p class="modal-subtitle">Optional steps can fetch, read and compare data, or use a registered script before the bot works. Steps keep the bot’s existing tools and exact action approvals.</p><div class="field"><label for="routine-workflow-mode">After preparation</label><select id="routine-workflow-mode" name="workflowMode"><option value="agent" ${r.workflow?.mode==='report'?'':'selected'}>Let the bot work with the result</option><option value="report" ${r.workflow?.mode==='report'?'selected':''}>Produce a saved report without a model</option></select><small>The workflow JSON below keeps the complete preparation and report configuration.</small></div><div class="field"><label for="routine-workflow">Workflow JSON</label><textarea id="routine-workflow" name="workflow" class="code-input" maxlength="65536" spellcheck="false" placeholder="Leave empty for an agent task">${esc(r.workflow?JSON.stringify(r.workflow,null,2):'')}</textarea><small>Use fixed targets and registered script versions. Clear this field to use an ordinary agent task.</small></div><details><summary>Example: check a JSON feed</summary><p class="modal-subtitle">Replace the example URL with your feed. The bot receives only new items.</p><pre class="skill-source">${esc(JSON.stringify(example,null,2))}</pre></details></details></details>`;
}
function updateRoutineWorkflowMode(){
  const field=$('#routine-workflow'),mode=$('#routine-workflow-mode')?.value;if(!field||!field.value.trim()||!['agent','report'].includes(mode))return;
  let workflow;try{workflow=JSON.parse(field.value);}catch{return;}
  if(!workflow||typeof workflow!=='object'||Array.isArray(workflow))return;
  workflow.mode=mode;const step=workflow.steps?.at(-1),reference=step?.id?`{{${step.id}}}`:'';
  if(mode==='report'&&typeof workflow.report!=='string')workflow.report=reference;
  if(mode==='agent'&&typeof workflow.context!=='string')workflow.context=reference;
  field.value=JSON.stringify(workflow,null,2);field.dispatchEvent(new Event('input',{bubbles:true}));
}
function updateRoutineExecutionMode(){const bounded=$('#routine-execution-mode')?.value==='bounded',fields=$('[data-routine-budget]');if(!fields)return;fields.hidden=!bounded;for(const input of fields.querySelectorAll('input'))input.disabled=!bounded;}
function routineExecutionInput(values){
  const mode=values.executionMode||'autonomous';if(!['autonomous','bounded'].includes(mode))throw new Error('Choose a valid execution mode.');const limits={mode};
  if(mode==='bounded')for(const [key,max,label] of [['runtimeMinutes',120,'Time budget'],['modelTurns',200,'Model turns'],['toolCalls',1000,'Tool calls']]){const value=Number(values[key]);if(!Number.isInteger(value)||value<1||value>max)throw new Error(`${label} must be a whole number from 1 to ${max}.`);limits[key]=value;}
  const source=String(values.workflow||'').trim();let workflow=null;
  if(source){if(source.length>65536)throw new Error('Workflow JSON must be at most 65536 characters.');try{workflow=JSON.parse(source);}catch{throw new Error('Workflow JSON is invalid. Check the JSON and save again.');}if(!workflow||typeof workflow!=='object'||Array.isArray(workflow))throw new Error('Workflow JSON must be an object.');}
  return {limits,workflow};
}
function routineDialog(id,botId,preset){const r=data.routines.find(r=>r.id===id)||preset||{};const schedule=r.schedule||(r.id?{kind:'interval',minutes:Number(r.intervalMinutes)||1440}:{kind:'daily',time:'08:00'});const kind=schedule.kind;
  const minutes=Number(schedule.minutes)||60,unit=minutes%1440===0?1440:minutes%60===0?60:1,zone=r.timezone||data.settings?.timezone||browserZone();
  let zones=[];try{zones=Intl.supportedValuesOf('timeZone');}catch{}if(!zones.includes(zone))zones=[zone,...zones];
  const show=(...kinds)=>kinds.includes(kind)?'':'hidden',day=new Date(Date.now()+86400000),tomorrow=`${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}T09:00`;
  openDialog(id?'Edit routine':'New routine',`<p class="modal-subtitle">Give a bot a recurring task. The home server runs it at the times you set while it is online.</p><form id="routine-form" data-id="${esc(id||'')}"><div class="field"><label for="routine-name">Routine name</label><input id="routine-name" name="name" value="${esc(r.name||'')}" placeholder="My morning briefing" maxlength="100" required></div><div class="field"><label for="routine-bot">Who’s taking care of it?</label><select id="routine-bot" name="botId" required><option value="">Choose a bot</option>${data.bots.map(b=>`<option value="${esc(b.id)}" ${(r.botId||botId)===b.id?'selected':''}>${esc(b.name)} · ${esc(b.title||'Teammate')}</option>`).join('')}</select></div><div class="field"><label for="routine-prompt">What should they do?</label><textarea id="routine-prompt" name="prompt" placeholder="Review the latest project notes and prepare a short briefing." maxlength="10000" required>${esc(r.prompt||'')}</textarea></div>
<div class="field"><label for="routine-kind">When?</label><select id="routine-kind" name="kind">${[['daily','Every day at a time'],['weekly','On chosen days at a time'],['interval','Repeat every…'],['once','Once, at a date and time']].map(([value,label])=>`<option value="${value}" ${kind===value?'selected':''}>${label}</option>`).join('')}</select></div>
<div class="field" data-routine-kinds="daily weekly" ${show('daily','weekly')}><label for="routine-time">Time</label><input id="routine-time" name="time" type="time" value="${esc(schedule.time||'08:00')}" ${show('daily','weekly')?'disabled':''} required></div>
<fieldset class="field routine-days" data-routine-kinds="weekly" ${show('weekly')}><legend>Days</legend><div class="routine-day-list">${Object.entries(DAY_LABELS).map(([value,label])=>`<label class="routine-day"><input type="checkbox" name="days" value="${value}" ${(schedule.days||['mon','tue','wed','thu','fri']).includes(value)?'checked':''} ${show('weekly')?'disabled':''}><span>${label}</span></label>`).join('')}</div></fieldset>
<div class="field" data-routine-kinds="interval" ${show('interval')}><label for="routine-every">Repeat every</label><div class="routine-every"><input id="routine-every" name="every" type="number" min="1" max="525600" value="${esc(minutes/unit)}" ${show('interval')?'disabled':''} required><select name="unit" aria-label="Unit" ${show('interval')?'disabled':''}>${[[1,'minutes'],[60,'hours'],[1440,'days']].map(([value,label])=>`<option value="${value}" ${unit===value?'selected':''}>${label}</option>`).join('')}</select></div><small>At least 5 minutes, counted from when it is saved or last ran.</small></div>
<div class="field" data-routine-kinds="once" ${show('once')}><label for="routine-at">Date and time</label><input id="routine-at" name="at" type="datetime-local" value="${esc(schedule.at||tomorrow)}" ${show('once')?'disabled':''} required></div>
<div class="field"><label for="routine-zone">Time zone</label><select id="routine-zone" name="timezone">${zones.map(value=>`<option value="${esc(value)}" ${value===zone?'selected':''}>${esc(value.replaceAll('_',' '))}</option>`).join('')}</select></div>
<div class="field"><label for="routine-missed">If Tupies is offline when it is due</label><select id="routine-missed" name="missed">${[['once','Run it once when Tupies is back'],['skip','Skip that run']].map(([value,label])=>`<option value="${value}" ${(r.missed||'once')===value?'selected':''}>${label}</option>`).join('')}</select><small>A bot that is busy at the time runs it as soon as it is free.</small></div>
${routineExecutionFields(r)}<label class="checkbox-field"><input type="checkbox" name="enabled" ${(r.enabled===undefined?!id:r.enabled)?'checked':''}>Enable this schedule</label>${modalFooter(id?'Save routine':'Create routine',id?`<button class="danger-button" type="button" data-action="delete-routine" data-id="${esc(id)}">Delete</button>`:'')}</form>`);}
/** Shows the fields for the chosen kind of schedule; hidden fields are disabled so they are neither validated nor sent. */
function updateRoutineKind(){const kind=$('#routine-kind')?.value;for(const field of document.querySelectorAll('[data-routine-kinds]')){const on=field.dataset.routineKinds.split(' ').includes(kind);field.hidden=!on;for(const input of field.querySelectorAll('input,select'))input.disabled=!on;}}
function routineRunMarkup(run){
  const status={completed:'Done',failed:'Failed',cancelled:'Stopped',interrupted:'Interrupted',running:'Running',recovering:'Auto-recovering',unknown:'Unknown','no reply':'No reply',incomplete:'Incomplete'},recovery=runRecovery(run),attention=!!run.resumeUnavailable||(recovery&&!recovery.retrying),label=recovery?.label||(attention?'Needs attention':status[run.status]||run.status),failed=attention||(!recovery?.retrying&&['failed','interrupted','no reply','incomplete'].includes(run.status));
  return `<li><span class="routine-run-status ${run.status==='completed'?'ok':failed?'fail':''}">${esc(label)}</span><div><strong>${esc(whenLabel(run.startedAt))}</strong>${run.durationMs!==undefined?`<small> · ${esc(Math.max(1,Math.round(run.durationMs/1000)))}s</small>`:''}${run.preview?`<p>${esc(run.preview)}</p>`:''}${recovery?`<p class="${recovery.retrying?'':'routine-run-error'}">${esc(recovery.detail)}</p>`:''}${run.error?`<p class="${recovery?.retrying?'':'routine-run-error'}">${esc(run.error)}</p>`:''}${run.resumeUnavailable&&!recovery?`<p class="routine-run-error">${esc(run.resumeUnavailable)}</p>`:''}</div></li>`;
}
async function routineHistory(id){const r=data.routines.find(item=>item.id===id);if(!r)return;openDialog(`${r.name} · history`,'<p class="rich-loading">Loading runs…</p>');
  const loadingDialog=$('dialog'),result=await api(`/api/routines/${encodeURIComponent(id)}/runs`),runs=result.data||[];
  if($('dialog')!==loadingDialog||!loadingDialog?.open)return;
  openDialog(`${r.name} · history`,`<p class="modal-subtitle">${esc(scheduleLabel(r))}${r.enabled&&r.nextRunAt?` · next ${esc(whenLabel(r.nextRunAt))}`:''}${result.missedRuns?` · ${result.missedRuns} skipped while Tupies was offline`:''}</p>${runs.length?`<ul class="routine-runs">${runs.map(routineRunMarkup).join('')}</ul>`:'<div class="section-empty"><p>No runs yet.</p></div>'}<div class="modal-footer"><button class="primary-button" data-action="close-dialog">Done</button></div>`);}
function importDialog(){importedSkillFiles=null;openDialog('Import a skill',`<p class="modal-subtitle">Import a Hermes-compatible SKILL.md. Assign it in a bot’s settings.</p><form id="skill-form"><label class="secondary-button upload-label" for="skill-file">${icon('upload')}Choose SKILL.md</label> <label class="secondary-button upload-label" for="skill-folder">${icon('book')}Choose a skill folder</label><input class="file-input" id="skill-folder" type="file" webkitdirectory directory multiple><p class="subtle-label import-file-summary" id="import-file-summary"></p><input class="file-input" id="skill-file" type="file" accept=".md,.txt,text/markdown,text/plain"><div class="field"><label for="skill-content">Or paste your skill</label><textarea class="code-input" id="skill-content" name="content" maxlength="100000" placeholder="---&#10;name: weekly-review&#10;description: Turn project notes into a useful weekly review.&#10;---&#10;&#10;# Weekly review&#10;&#10;Start with outcomes, then open questions and next steps." required></textarea><small>Instructions and support files stay together. Bots can read assigned references and request approval before running a skill script.</small></div>${modalFooter('Import skill')}</form>`,{wide:true});}
async function viewSkill(id){const s=data.skills.find(s=>s.id===id);const result=await api(`/api/skills/${encodeURIComponent(id)}`);openDialog(s?.title||s?.name||'Skill',`<p class="modal-subtitle">${esc(s?.description||'A reusable playbook for your bots.')}</p>${window.StudioSkills?.metadata?.(result,studioContext())||''}<pre class="skill-source">${esc(result.content||'')}</pre>${result.resourceCount?`<p class="modal-subtitle">${esc(result.resourceCount)} resource files available to assigned bots. Script execution requires approval.</p><pre class="skill-source skill-file-list">${esc((result.files||[]).join('\n'))}</pre>`:''}<div class="modal-footer"><button class="danger-button" data-action="delete-skill" data-id="${esc(id)}">Remove skill</button><button class="secondary-button" data-action="copy-skill" data-id="${esc(id)}">${icon('copy')}Copy SKILL.md</button><button class="secondary-button" data-action="export-skill" data-id="${esc(id)}">${icon('file')}Download package</button><button class="primary-button" data-action="close-dialog">Done</button></div>`,{wide:true});}
function confirmDelete(kind,id){const endpoint={bot:'bots',routine:'routines',skill:'skills',room:'rooms',connection:'connections',integration:'integrations',channel:'channels'}[kind];const title=kind==='bot'?botById(id)?.name:kind==='connection'?connectionById(id)?.name:data[endpoint].find(x=>x.id===id)?.name;openDialog(`Remove ${title||kind}?`,`<p class="modal-subtitle">${kind==='bot'?'This removes the bot, its conversations, memory and routines from Tupies. Saved workspace files remain on this engine. This cannot be undone.':kind==='connection'?'Assign another provider to its bots first. This removes the saved provider and its encrypted credentials.':kind==='integration'?'This removes the integration and its encrypted credentials. Assigned bots will no longer have access to its tools.':kind==='channel'?'This pauses message intake and removes the saved Telegram channel and encrypted token. The Telegram bot account itself is kept.':kind==='room'?'This removes the room and its Tupies message history. Member bots and their individual chats are kept.':kind==='skill'?'This removes this skill from your workspace library and unassigns it from every bot. Download its package first if you want to keep a copy.': 'This removes the routine from Tupies. Runs already recorded stay in the bot’s chat.'}</p><p class="form-error" role="alert"></p><div class="modal-footer"><button class="secondary-button" data-action="close-dialog">Keep it</button><button class="danger-button" data-action="confirm-delete" data-kind="${kind}" data-id="${esc(id)}">Remove ${kind}</button></div>`);}
const helpSteps=()=>`<div class="help-step"><span class="step-number">1</span><div><h3>Connect a model</h3><p>Add an API key, connect a local model, or sign in with your ChatGPT plan. Keys and account tokens stay on your Tupies server.</p></div></div><div class="help-step"><span class="step-number">2</span><div><h3>Give each bot a role</h3><p>Pick its model, instructions, skills and tools. Every bot gets its own chat, memory and private files.</p></div></div><div class="help-step"><span class="step-number">3</span><div><h3>Connect the tools you use</h3><p>Add an MCP server or an HTTP API in Settings › Integrations, and give each bot only the tools it needs. Outside actions and commands always ask for your approval.</p></div></div><div class="help-step"><span class="step-number">4</span><div><h3>Let bots work together</h3><p>Allow specific teammates in a bot’s settings, or turn on handoffs in a team room. The Dashboard shows what everyone is doing.</p></div></div>`;
function helpDialog(){openDialog('Getting started',`<p class="modal-subtitle">Four steps from an empty workspace to a working team.</p>${helpSteps()}<div class="modal-footer"><button class="secondary-button" data-nav="/connections" data-close="true">Open Models${icon('arrow')}</button><a class="primary-button" href="/guide.html" target="_blank" rel="noopener">Read the guide${icon('book')}</a></div>`,{wide:true});}
function renderHelp(){return `<section class="page settings-page">${settingsHeading('help','How Tupies works, in four steps. The full guide covers everything else.')}<div class="help-panel glass-card"><p><button class="primary-button" data-nav="/welcome">Open getting started${icon('arrow')}</button></p>${helpSteps()}<div class="help-links"><a class="primary-button" href="/guide.html" target="_blank" rel="noopener">${icon('book')}Read the guide</a><button class="secondary-button" data-action="pair-device">${icon('phone')}Pair a phone or Mac</button></div></div></section>`;}



function renderChannels(){
  const channels=filtered(data.channels,['name','username','type']);
  return `<section class="page settings-page">${settingsHeading('channels','Let people reach a bot on Telegram. You decide exactly who can message it.','create-channel','Add Telegram bot')}<div class="connection-list">${channels.map(channel=>{const bot=botById(channel.botId),error=channel.error||channel.lastError,verified=!!(channel.testedAt||channel.username||channel.status==='connected'),status=error?'Needs attention':channel.enabled?'Enabled':verified?'Verified · Paused':'Not tested';return `<article class="connection-card glass-card"><span class="setup-icon">${icon('chat')}</span><div class="connection-info"><h3>${esc(channel.name)}</h3><p>Telegram${channel.username?` · @${esc(channel.username)}`:''}${bot?` · ${esc(bot.name)}`:''}</p><div class="connection-capabilities"><span class="tag">${channel.allowedChatIds?.length||0} allowed chats</span><span class="tag">${channel.allowedUserIds?.length||0} allowed users</span><span class="tag">${channel.enabled?'Message intake enabled':'Message intake paused'}</span></div>${error?`<p class="connection-error">${esc(typeof error==='string'?error:JSON.stringify(error))}</p>`:''}</div><span class="status-pill ${error?'error':channel.enabled?'ready':''}"><i class="dot"></i>${status}</span><div class="connection-actions"><button class="switch ${channel.enabled?'on':''}" role="switch" aria-checked="${!!channel.enabled}" aria-label="${channel.enabled?'Pause':'Enable'} ${esc(channel.name)}" data-action="toggle-channel" data-id="${esc(channel.id)}"></button><button class="secondary-button" data-action="test-channel" data-id="${esc(channel.id)}">Verify bot</button><button class="icon-button" data-action="edit-channel" data-id="${esc(channel.id)}" aria-label="Edit ${esc(channel.name)}">${icon('more')}</button></div></article>`;}).join('')}</div>${!channels.length?emptyState('chat','No messaging channels yet','Connect a Telegram bot, choose which Tupies bot answers, and list the exact chats and people allowed to reach it. New channels start paused.','create-channel','Add Telegram bot'):''}<div class="info-banner">${icon('shield')}<p>Both chat and user allowlists are required before enabling message intake. Allowed messages start normal Tupies tasks using that bot’s provider, tools, and permissions. Command and external-action approvals stay in Tupies; Telegram messages cannot approve them.</p></div><p class="page-description">Create a Telegram bot through <a href="https://core.telegram.org/bots#how-do-i-create-a-bot" target="_blank" rel="noopener noreferrer">Telegram’s official BotFather instructions</a>. Verifying a channel checks the bot’s identity without sending a chat message.</p></section>`;
}
function channelDialog(id){
  const channel=data.channels.find(c=>c.id===id)||{};
  openDialog(id?'Telegram settings':'Add a Telegram bot',`<p class="modal-subtitle">Use a token issued by Telegram’s BotFather. Choose one Tupies bot to handle incoming messages. The channel stays paused until you enable it.</p><form id="channel-form" data-id="${esc(id||'')}"><input type="hidden" name="type" value="telegram"><div class="field"><label for="channel-name">Channel name</label><input id="channel-name" name="name" value="${esc(channel.name||'')}" maxlength="100" placeholder="e.g. My Telegram assistant" required></div><div class="field"><label for="channel-bot">Bot that answers</label><select id="channel-bot" name="botId" required><option value="">Choose a bot</option>${data.bots.map(bot=>`<option value="${esc(bot.id)}" ${channel.botId===bot.id?'selected':''}>${esc(bot.name)} · ${esc(bot.title||'Teammate')}</option>`).join('')}</select><small>Incoming tasks use this bot’s own model, memory, workspace, skills, and integrations.</small></div><div class="field"><label for="channel-token">BotFather token</label><input id="channel-token" name="token" type="password" autocomplete="new-password" placeholder="${id?'Leave empty to keep the saved token':'Paste the token issued by BotFather'}" ${id?'':'required'}><small>Encrypted on your Tupies server and never returned to the browser.</small></div><div class="field"><label for="channel-chats">Allowed chat IDs</label><input id="channel-chats" name="allowedChatIds" value="${esc((channel.allowedChatIds||[]).join(', '))}" placeholder="e.g. 123456789, -1001234567890"><small>Comma-separated numeric Telegram chat IDs. Only these conversations can reach the bot.</small></div><div class="field"><label for="channel-users">Allowed user IDs</label><input id="channel-users" name="allowedUserIds" value="${esc((channel.allowedUserIds||[]).join(', '))}" placeholder="e.g. 123456789"><small>Comma-separated numeric Telegram user IDs. Both the sender and the chat must be allowed.</small></div><div class="field"><label for="channel-owner">Your own Telegram user ID</label><input id="channel-owner" name="ownerUserId" value="${esc(channel.ownerUserId||'')}" inputmode="numeric" placeholder="Optional"><small>Your direct messages continue the bot’s main chat, the same conversation as in Tupies. Other people and groups each get a separate conversation. It must also be an allowed user ID.</small></div><label class="checkbox-field"><input type="checkbox" name="enabled" ${channel.enabled?'checked':''}>Enable incoming messages</label><div class="info-banner">${icon('shield')}<p>Enabling requires both allowlists. Tupies keeps the normal approval policy for this bot. Review pending actions in the Tupies conversation.</p></div>${modalFooter('Save channel',id?`<button class="danger-button" type="button" data-action="delete-channel" data-id="${esc(id)}">Remove channel</button>`:'')}</form>`,{wide:true});
}
async function testChannel(id){
  const result=await api(`/api/channels/${encodeURIComponent(id)}/test`,{method:'POST',body:{}});await refresh();
  openDialog('Telegram identity verified',`<p class="modal-subtitle">${result.username?`@${esc(result.username)} responded successfully.`:'Telegram returned the bot’s identity successfully.'} No chat message was sent by this verification.</p><p class="subtle-label">Enable message intake only after setting the exact allowed chat and user IDs. Provider access is verified separately.</p><div class="modal-footer"><button class="primary-button" data-action="close-dialog">Done</button></div>`);
}

const roleLabel=role=>({hub:'Home server',replica:'Synced engine',standalone:'Standalone'})[role]||'Standalone';
const platformIcon=device=>device.kind==='engine'?'server':device.platform==='ios'||device.platform==='android'?'phone':device.platform==='macos'?'laptop':'globe';
let sidebarKey='';
function updateSidebar(){
  const key=JSON.stringify([data.bots.map(bot=>[bot.id,bot.name,bot.title,bot.icon,bot.color,bot.hidden,data.botLastMessageAt?.[bot.id],botStatus(bot).className]),data.rooms.length,data.sync?.node,data.sync?.hub?.connected]);
  const aside=$('.sidebar');if(!aside)return;if(key===sidebarKey){updateSidebarUnread();return;}
  const scroll=$('.roster',aside)?.scrollTop||0;aside.outerHTML=sidebarMarkup(route());sidebarKey=key;const next=$('.sidebar .roster');if(next)next.scrollTop=scroll;updateBotsAttention();
}
function updateElsewhereNotice(bot){
  const wrap=$('.chat-composer-wrap');if(!wrap||!bot)return;let notice=$('.sync-elsewhere',wrap);
  if(!chat.elsewhere){notice?.remove();return;}
  if(!notice){notice=document.createElement('div');notice.className='sync-elsewhere';notice.setAttribute('role','status');wrap.prepend(notice);}
  notice.innerHTML=`${icon('sync')}<span>${esc(bot.name)} is working on <strong>${esc(chat.elsewhere.name)}</strong>. New messages appear here as soon as it finishes.</span>`;
}
function syncAgo(value){return value?relative(value):'never';}
function renderSync(){
  const view=syncView;
  if(!view)return `<section class="page settings-page">${settingsHeading('sync','Pair your phone and Mac, and keep every engine in step.')}<div class="section-empty"><p>Checking your engines…</p></div></section>`;
  const {status,devices,current}=view,node=status.node,hub=status.hub;
  const health=hub?(hub.connected?`<span class="status-pill ready"><i class="dot"></i>Synced ${esc(syncAgo(hub.lastSyncAt))}</span>`:`<span class="status-pill error"><i class="dot"></i>Offline</span>`):node.automationSuspended?`<span class="status-pill"><i class="dot"></i>Automation paused</span>`:`<span class="status-pill ready"><i class="dot"></i>${node.role==='hub'?'Home server':'Ready'}</span>`;
  const engineCard=`<article class="glass-card sync-card sync-engine"><span class="setup-icon">${icon('server')}</span><div class="sync-card-body"><p class="eyebrow">THIS ENGINE</p><h3>${esc(node.name)} <button class="text-button inline" data-action="rename-engine">Rename</button></h3><p>${esc(roleLabel(node.role))}${node.automation?' · runs routines and messaging channels':hub?' · routines and channels run on the home server':' · automatic routines and messaging are paused'}</p><div class="connection-capabilities"><span class="tag" title="Compare this with the code shown when you pair">ID ${esc(String(node.fingerprint).slice(0,4).toUpperCase())} ${esc(String(node.fingerprint).slice(4,8).toUpperCase())}</span><span class="tag">${status.documents} items tracked</span>${status.pending?`<span class="tag">${status.pending} waiting to sync</span>`:''}</div>${hub?.error&&!hub.connected?`<p class="sync-error">${esc(hub.error)}</p>`:''}${status.skippedFiles?.length?`<p class="subtle-label">Files over 64 MB are not synced: ${status.skippedFiles.map(esc).join(', ')}</p>`:''}</div>${health}</article>`;
  const automationCard=!hub&&(node.automationSuspended||node.detachedChatGPT)?`<article class="glass-card sync-card"><span class="setup-icon">${icon('shield')}</span><div class="sync-card-body"><p class="eyebrow">AFTER DISCONNECTING</p><h3>${node.automationSuspended?'Routines and messaging are paused here':'ChatGPT needs a fresh sign-in here'}</h3>${node.automationSuspended?`<p>This engine kept your workspace. Its ${Number(node.enabledRoutines)||0} enabled routines and ${Number(node.enabledChannels)||0} enabled messaging channels stay paused here so they do not run alongside the former home server. Re-link, or choose this engine to run them separately.</p>`:''}${node.detachedChatGPT?'<p>Copied ChatGPT authorizations remain with the former home server. Re-link or complete a fresh ChatGPT sign-in in Models before using those connections here. Enabling routines does not transfer them.</p>':''}</div>${node.automationSuspended?'<div class="connection-actions"><button class="secondary-button" data-action="enable-local-automation">Run routines and messaging here</button></div>':''}</article>`:'';
  let linkCard;
  if(hub)linkCard=`<article class="glass-card sync-card"><span class="setup-icon">${icon('link')}</span><div class="sync-card-body"><p class="eyebrow">HOME SERVER</p><h3>${esc(hub.name)}</h3><p>${esc(hub.url)} · linked ${esc(shortDate(hub.connectedAt))}</p><p class="subtle-label">Bots, chats, memory, notes, skills and devices sync both ways within a second or two. Each engine runs its own tasks; a bot works on one engine at a time.</p></div><div class="connection-actions">${/^https:/.test(hub.url)?`<a class="secondary-button" href="${esc(hub.url)}" target="_blank" rel="noopener">${icon('globe')}Open</a>`:''}<button class="secondary-button" data-action="disconnect-hub">Disconnect</button></div></article>`;
  else linkCard=`<article class="glass-card sync-card"><span class="setup-icon">${icon('link')}</span><div class="sync-card-body"><p class="eyebrow">YOUR OTHER ENGINES</p><h3>${node.role==='hub'?'Linked engines':'Run Tupies on your Mac and your server'}</h3><p>${node.role==='hub'?'These engines keep a full copy of this workspace and sync through here.':'Link a second engine to keep one workspace on both. Use your always-on server as the home server, and connect your Mac to it.'}</p>${status.engines.length?`<ul class="sync-engine-list">${status.engines.map(engine=>`<li><i class="dot ${engine.online?'ready':''}"></i><strong>${esc(engine.name)}</strong><span>${engine.online?'Online':`Last seen ${esc(syncAgo(engine.lastSeenAt))}`}${engine.busy?.length?` · working with ${engine.busy.length} bot${engine.busy.length>1?'s':''}`:''}</span>${/^https:/.test(engine.url||'')?`<a class="text-button" href="${esc(engine.url)}" target="_blank" rel="noopener">Open</a>`:''}</li>`).join('')}</ul>`:''}</div><div class="connection-actions"><button class="secondary-button" data-action="pair-engine">${icon('plus')}Link another engine</button>${node.role==='hub'?'':`<button class="primary-button" data-action="connect-hub">${icon('link')}Connect to a home server</button>`}</div></article>`;
  const deviceCard=`<article class="glass-card sync-card sync-devices"><div class="sync-devices-head"><div><p class="eyebrow">YOUR DEVICES</p><h3>Paired apps and engines</h3><p>Pair once with your home server and the app works on every linked engine. Removing a device here removes it everywhere.</p></div><button class="primary-button" data-action="pair-device">${icon('phone')}Pair a phone or Mac</button></div>${devices.length?`<ul class="device-list">${devices.map(device=>`<li><span class="setup-icon small">${icon(platformIcon(device))}</span><div><strong>${esc(device.name)}</strong>${device.id===current?'<span class="tag">This device</span>':device.self?'<span class="tag">This engine</span>':''}<span>${esc(device.kind==='engine'?'Linked engine':({ios:'iPhone or iPad',macos:'Mac app',android:'Android',web:'Browser'})[device.platform]||'App')} · paired ${esc(shortDate(device.createdAt))}${device.lastSeenAt?` · active ${esc(syncAgo(device.lastSeenAt))}`:''} · key ${esc(device.shortFingerprint.toUpperCase())}</span></div>${device.self?'':`<button class="text-button" data-action="revoke-device" data-id="${esc(device.id)}" data-name="${esc(device.name)}">Remove</button>`}</li>`).join('')}</ul>`:'<p class="subtle-label">No paired apps yet. Your browser uses your workspace password instead.</p>'}</article>`;
  const access=status.access,accessCard=access&&(node.url||access.public)?`<article class="glass-card sync-card"><span class="setup-icon">${icon('lock')}</span><div class="sync-card-body"><p class="eyebrow">SIGN-IN FROM THE INTERNET</p><h3>${access.publicPassword?'Apps and workspace password':'Paired apps only'}</h3><p>${access.publicPassword?'Browsers anywhere can sign in with the workspace password. Tupies pauses password sign-in from the internet after repeated failures; use a long, unique password.':'Your paired apps sign in with keys that never leave the device. The workspace password works only on private routes: this machine, your home network, Tailscale or an SSH tunnel.'}</p></div><div class="connection-actions"><button class="switch ${access.publicPassword?'on':''}" data-action="toggle-public-password" role="switch" aria-checked="${access.publicPassword}" aria-label="Allow password sign-in from the internet" title="Allow password sign-in from the internet"></button></div></article>`:'';
  const help=`<article class="glass-card sync-card sync-help"><span class="setup-icon">${icon('shield')}</span><div class="sync-card-body"><p class="eyebrow">PRIVATE BY DESIGN</p><h3>Reaching your engines securely</h3><ul><li><strong>Your own domain (recommended).</strong> Point a subdomain at the server, put Caddy in front for automatic HTTPS and set <code>STUDIO_PUBLIC_URL</code>. Your phone reaches it from anywhere without a VPN app.</li><li><strong>Tailscale Funnel.</strong> No domain needed: <code>tailscale funnel --bg ${esc(location.port||'4310')}</code> on the server gives it a public https://…ts.net address. Encryption ends on your server.</li><li><strong>Tailscale, private only.</strong> <code>tailscale serve</code> keeps the engine off the internet; every device then needs the Tailscale app.</li></ul><p class="subtle-label">From the internet, only paired apps can sign in unless you allow the password. Sync between engines is end-to-end encrypted with a workspace key only your engines hold.</p></div></article>`;
  return `<section class="page settings-page sync-page">${settingsHeading('sync','Pair your phone and Mac, and keep every engine in step.')}<div class="connection-list">${engineCard}${automationCard}${linkCard}${deviceCard}${accessCard}${help}</div></section>`;
}
async function loadSyncPage(){
  try{const [status,list]=await Promise.all([api('/api/sync/status'),api('/api/devices')]);syncView={status,devices:list.devices,current:list.current};data.sync={...(data.sync||{}),node:status.node,hub:status.hub};if(route().view==='sync'&&!$('dialog'))$('#main-content').innerHTML=renderSync();}
  catch(error){if(route().view==='sync')$('#main-content').innerHTML=`<section class="page"><div class="section-empty"><p>${esc(errorText(error))}</p><button class="secondary-button" data-nav="/sync">Try again</button></div></section>`;}
}
const safeQr=svg=>/^<svg[^>]*>(?:<rect [^>]*\/>)?<path d="[MLHVZmlhvz0-9 ,.-]+" [^>]*\/><\/svg>$/.test(String(svg||''))?svg:'';
async function pairingDialog(kind,url){
  if(pairingTimer){clearInterval(pairingTimer);pairingTimer=null;}
  const result=await api('/api/pairing',{method:'POST',body:{kind,...(url?{url}:{})}});
  const engine=kind==='engine',local=/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(result.url),short=String(result.fingerprint).slice(0,8).toUpperCase().replace(/(.{4})/,'$1 ');
  openDialog(engine?'Link another engine':'Pair a phone or Mac',`<div class="pairing"><div class="pairing-qr">${safeQr(result.qrSvg)}</div><div class="pairing-steps"><p class="modal-subtitle">${engine?'On the other engine, open <strong>Settings → Devices & sync → Connect to a home server</strong> and paste this link. Its bots, chats and memory merge with this workspace.':'Open the Tupies app and choose <strong>Scan QR code</strong>, or paste the link. Check that the app shows the same server code.'}</p><p class="pairing-code">Server code <strong>${esc(short)}</strong></p><div class="field"><label for="pairing-link">Pairing link</label><div class="copy-row"><input id="pairing-link" value="${esc(result.link)}" readonly><button class="secondary-button" type="button" data-action="copy-pairing">${icon('copy')}Copy</button></div><small>Works once and expires in <span id="pairing-expiry">10:00</span>. It contains no passwords.</small></div>${local?`<form id="pairing-url-form" class="pairing-url" data-kind="${esc(kind)}"><p class="sync-warning">This link points at <strong>${esc(result.url)}</strong>, which ${engine?'another machine':'your phone'} can’t reach. Enter this engine’s HTTPS address, or set <code>STUDIO_PUBLIC_URL</code>.</p><div class="copy-row"><input name="url" placeholder="https://studio.example.com" required><button class="secondary-button" type="submit">Update link</button></div><p class="form-error" role="alert"></p></form>`:''}</div></div><div class="modal-footer"><button class="primary-button" data-action="close-dialog">Done</button></div>`,{wide:true});
  const expires=Date.parse(result.expiresAt);
  const tick=()=>{const left=Math.max(0,expires-Date.now()),label=$('#pairing-expiry');if(!label){clearInterval(pairingTimer);pairingTimer=null;return;}label.textContent=`${Math.floor(left/60000)}:${String(Math.floor(left/1000)%60).padStart(2,'0')}`;if(!left){label.textContent='0:00 — create a new link';clearInterval(pairingTimer);pairingTimer=null;}};
  tick();pairingTimer=setInterval(tick,1000);
}
function connectHubDialog(){
  openDialog('Connect to a home server',`<p class="modal-subtitle">On your home server, open <strong>Settings → Devices & sync → Link another engine</strong>, then paste the link here. This engine keeps working offline and catches up when it reconnects.</p><form id="connect-hub-form"><div class="field"><label for="hub-link">Engine link</label><textarea id="hub-link" name="link" rows="3" placeholder="Paste the engine link from your home server" required></textarea><small>Where both engines changed the same item, the most recent edit wins. Files edited on both keep a conflict copy.</small></div>${modalFooter('Connect')}</form>`);
}
function renameEngineDialog(){
  const name=syncView?.status?.node?.name||'';
  openDialog('Name this engine',`<p class="modal-subtitle">Shown in the apps’ engine switcher and on your other engines.</p><form id="rename-engine-form"><div class="field"><label for="engine-name">Engine name</label><input id="engine-name" name="name" value="${esc(name)}" maxlength="60" placeholder="e.g. Home server or Tupies Mac" required></div>${modalFooter('Save')}</form>`);
}
function renderIntegrations(){
  return `<section class="page settings-page">${settingsHeading('integrations','Connect apps and APIs your bots can use. Bots ask before they act.','create-integration','Connect a tool')}<div class="integration-intro"><button class="glass-card integration-template" data-action="create-integration" data-type="mcp"><span class="setup-icon">${icon('plug')}</span><div><h3>MCP server</h3><p>Discover tools from a compatible remote server.</p></div>${icon('arrow')}</button><button class="glass-card integration-template" data-action="create-integration" data-type="rest"><span class="setup-icon">${icon('globe')}</span><div><h3>HTTP API</h3><p>Give a bot approved access to a third-party API.</p></div>${icon('arrow')}</button><button class="glass-card integration-template" data-action="create-integration" data-type="rest" data-preset="exa"><span class="setup-icon">${icon('search')}</span><div><h3>Web search · Exa</h3><p>${defaultSearchIntegration()?'Exa is your bots’ default search and page reader.':'Better search and page reading for every bot. DuckDuckGo stays as fallback.'}</p></div>${icon('arrow')}</button></div><div class="connection-list">${data.integrations.map(i=>`<article class="connection-card glass-card"><span class="setup-icon">${icon(i.type==='mcp'?'plug':'globe')}</span><div class="connection-info"><h3>${esc(i.name)}</h3><p>${esc(i.baseUrl||i.url||'')}</p><div class="connection-capabilities"><span class="tag">${i.type==='mcp'?'MCP tools':'HTTP API'}</span><span class="tag">${(i.discoveredTools||i.tools||[]).length} tools</span>${defaultSearchIntegration()?.id===i.id?'<span class="tag">Default web search</span><span class="tag">All bots with Web tools</span>':`<span class="tag">${data.bots.filter(b=>(b.integrationIds||[]).includes(i.id)).length} bots</span>`}</div>${i.error?`<p class="connection-error">${esc(i.error)}</p>`:''}</div><span class="status-pill ${i.status==='connected'?'ready':i.status==='error'?'error':''}"><i class="dot"></i>${i.status==='connected'?'Connected':i.status==='configured'?'Configured':i.status==='error'?'Needs attention':'Not tested'}</span><div class="connection-actions"><button class="secondary-button" data-action="test-integration" data-id="${esc(i.id)}">${i.type==='rest'?'Validate actions':'Discover tools'}</button><button class="icon-button" data-action="edit-integration" data-id="${esc(i.id)}" aria-label="Edit ${esc(i.name)}">${icon('more')}</button></div></article>`).join('')}</div>${!data.integrations.length?emptyState('plug','No tools connected yet','Connect an MCP server or describe an HTTP API, then give it to the bots that need it.'):''}<div class="info-banner">${icon('shield')}<p>Credentials stay encrypted on the server. Assign each integration only to the bots that need it. Tupies asks for exact approval before external tool actions; a tool’s own description does not grant permission.</p></div></section>`;
}
function integrationDialog(id,type){
  const i=data.integrations.find(i=>i.id===id)||{},selected=type||i.type||'mcp';
  const sample=[{name:'get_status',description:'Read the service status.',method:'GET',path:'/status',inputSchema:{type:'object',properties:{},additionalProperties:false}}];
  openDialog(id?'Integration settings':'Connect a tool',`<p class="modal-subtitle">${selected==='mcp'?'Tupies discovers tools from a remote MCP server over HTTP.':'Define the exact API actions a bot can request. Each action remains subject to Tupies permissions and approval.'}</p><form id="integration-form" data-id="${esc(id||'')}"><div class="field"><label for="integration-preset">Start with</label><select id="integration-preset"><option value="custom">Custom service</option><option value="exa">Exa · default web search and page reading</option><option value="searxng">SearXNG · your private search</option><option value="tavily">Tavily · search API</option><option value="brave">Brave Search · web search</option><option value="github">GitHub · list repositories</option><option value="slack">Slack · list channels</option></select><small>Presets fill the API shape. Configure your service URL and any credentials it requires.</small></div><div class="field"><label for="integration-type">Connection type</label><select id="integration-type" name="type"><option value="mcp" ${selected==='mcp'?'selected':''}>Remote MCP server</option><option value="rest" ${selected==='rest'?'selected':''}>HTTP API</option></select></div><div class="field"><label for="integration-name">Name</label><input id="integration-name" name="name" value="${esc(i.name||'')}" maxlength="100" placeholder="e.g. Project tools" required></div><div class="field"><label for="integration-url">${selected==='mcp'?'MCP endpoint URL':'API base URL'}</label><input id="integration-url" name="baseUrl" type="url" value="${esc(i.baseUrl||i.url||'')}" placeholder="${selected==='mcp'?'https://tools.example.com/mcp':'https://api.example.com'}" required><small>Use HTTPS for remote services. The endpoint is reached from your Tupies server.</small></div><div class="field"><label for="integration-auth">Authentication</label><select id="integration-auth" name="authType"><option value="bearer" ${(i.authType||'bearer')==='bearer'?'selected':''}>Bearer token</option><option value="header" ${i.authType==='header'?'selected':''}>API key header</option><option value="none" ${i.authType==='none'?'selected':''}>No authentication</option></select></div><div class="field" id="integration-header-field" ${i.authType==='header'?'':'hidden'}><label for="integration-header">Header name</label><input id="integration-header" name="headerName" value="${esc(i.headerName||'x-api-key')}" placeholder="x-api-key"></div><div class="field" id="integration-key-field"><label for="integration-key">Service token <span class="optional-label">optional</span></label><input id="integration-key" name="apiKey" type="password" autocomplete="new-password" placeholder="${id?'Leave empty to keep the saved token':'Token issued by this service'}"></div><div class="field" id="integration-tools-field" ${selected==='rest'?'':'hidden'}><label for="integration-tools">Available API actions</label><textarea id="integration-tools" name="tools" class="code-input" ${selected==='rest'?'required':''}>${esc(JSON.stringify(i.tools?.length?i.tools:sample,null,2))}</textarea><small>JSON array: each action has name, description, method, path, and a JSON-schema inputSchema object. Only declared actions are available.</small></div>${modalFooter(id?'Save integration':selected==='rest'?'Save and validate':'Connect and discover',id?`<button class="danger-button" type="button" data-action="delete-integration" data-id="${esc(id)}">Remove</button>`:'')}</form>`,{wide:true});
}
async function applyIntegrationPreset(select){
  const form=select.closest('form'),choice=select.value;if(choice==='custom')return;
  try{
    const catalog=await api('/api/integrations/catalog');
    if(!form?.isConnected||select.value!==choice)return;
    const preset=(catalog.integrations||[]).find(item=>item.id===choice);if(!preset)return;
    const find=id=>form.querySelector('#'+id);
    find('integration-type').value='rest';find('integration-tools-field').hidden=false;find('integration-tools').required=true;
    find('integration-key').value='';
    find('integration-name').value=preset.name;find('integration-url').value=preset.baseUrl||'';find('integration-tools').value=JSON.stringify(preset.tools||[],null,2);
    find('integration-auth').value=preset.authType||'bearer';find('integration-header').value=preset.headerName||'x-api-key';
    find('integration-header-field').hidden=preset.authType!=='header';find('integration-key-field').hidden=preset.authType==='none';
    find('integration-url').placeholder=choice==='searxng'?'http://127.0.0.1:8888':'https://api.example.com';
    form.querySelector('[for=integration-url]').textContent=choice==='searxng'?'Search instance URL':'API base URL';
    const intro=form.parentElement.querySelector('.modal-subtitle');if(intro)intro.textContent=choice==='exa'?'Paste your Exa API key. Exa becomes the default web search and page reader for every bot with Web tools, without per-bot assignment or approval. DuckDuckGo and direct page reads stay as fallbacks. Queries and page addresses are sent to Exa and billed to your Exa account.':choice==='searxng'?'Connect your own search instance with JSON search enabled. Assign the connection to each bot that may use it.':'Configure the exact service actions. Each request remains subject to Tupies permissions and approval.';
  }catch(error){if(form?.isConnected)toast(errorText(error),true);}
}
async function testIntegration(id){
  const integration=data.integrations.find(i=>i.id===id),result=await api(`/api/integrations/${encodeURIComponent(id)}/test`,{method:'POST',body:{}});await refresh();const tools=result.tools||[],configured=result.status==='configured'||integration?.type==='rest';
  openDialog(configured?'API actions are configured':'Tools found',`<p class="modal-subtitle">${esc(result.note||(configured?'The action definitions are valid. No API action was executed, so credentials and service access have not been verified yet.':`${tools.length} tools were returned by the MCP server.`))}</p><p class="subtle-label">${isExaSearch(integration)&&defaultSearchIntegration()?.id===id?'Exa is now the default web search and page reader for every bot with Web tools: no assignment or approval needed. The key is checked on the first search; if Exa rejects it, this card shows Needs attention and bots use DuckDuckGo meanwhile.':'Assign this integration in a bot’s settings before it can be used. Actual tool requests remain subject to approval.'}</p><div class="discovered-tools">${tools.map(tool=>`<article><strong>${esc(tool.name)}</strong><p>${esc(tool.description||'No description provided.')}</p></article>`).join('')||`<p class="subtle-label">${configured?'No actions were configured.':'This server returned no tools.'}</p>`}</div><div class="modal-footer"><button class="primary-button" data-action="close-dialog">Done</button></div>`,{wide:true});
}
async function providerLoginDialog(id,start=true){
  const c=connectionById(id);if(!c)return;
  openDialog(`Connect ${c.name}`,`<div class="section-empty"><p>Preparing secure provider sign-in…</p></div>`);
  try{const result=await api(`/api/connections/${encodeURIComponent(id)}/login`,start?{method:'POST',body:{}}:{});renderProviderLogin(id,result,{chooseModel:start});}
  catch(error){renderProviderLogin(id,{status:'error',message:errorText(error)});}
}
function renderProviderLogin(id,result,{chooseModel=false}={}){
  if(loginPollTimer){clearInterval(loginPollTimer);loginPollTimer=null;}
  const c=connectionById(id),status=result.status,connected=['connected','completed','authenticated','success'].includes(status),url=safeLink(result.authUrl||result.verificationUrl||result.verificationUri),pending=['pending','started','waiting','authorizing'].includes(status);
  if(connected&&(chooseModel||!c?.defaultModel)){void defaultModelDialog(id);return;}
  openDialog(connected?'You’re connected':`Sign in to ${c?.name||'your provider'}`,`<p class="modal-subtitle">${esc(result.message||(connected?'Your subscription account is connected to Tupies. Your default model is shared by your bots.':pending?'Continue in the provider’s authorization page. Tupies will update when sign-in finishes.':'Sign-in needs attention. Review your server configuration and provider eligibility.'))}</p>${result.userCode?`<div class="device-code"><span>One-time code</span><strong>${esc(result.userCode)}</strong></div>`:''}${url?`<a class="primary-button provider-auth-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Continue with ${c?.type==='chatgpt'?'ChatGPT':'your provider'}${icon('arrow')}</a>`:''}${pending?'<p class="login-wait"><i class="dot"></i>Waiting for official authorization…</p>':''}${result.account?.email?`<p class="account-detail">${esc(result.account.email)}</p>`:''}<div class="modal-footer">${connected?`<button class="danger-button" data-action="provider-logout" data-id="${esc(id)}">Disconnect account</button><button class="primary-button" data-action="choose-default-model" data-id="${esc(id)}">${c?.defaultModel?'Change default model':'Choose default model'}${icon('arrow')}</button>`:`<button class="secondary-button" data-action="close-dialog">${pending?'Close':'Done'}</button>${!pending?`<button class="text-button" data-action="provider-login" data-id="${esc(id)}">Try sign-in again</button>`:''}`}</div>`);
  if(pending)loginPollTimer=setInterval(async()=>{if(!$('dialog')){clearInterval(loginPollTimer);loginPollTimer=null;return;}try{const updated=await api(`/api/connections/${encodeURIComponent(id)}/login`);if(!['pending','started','waiting','authorizing'].includes(updated.status)){await refresh(false);renderProviderLogin(id,updated,{chooseModel:true});}}catch(error){renderProviderLogin(id,{status:'error',message:errorText(error)});}},1800);
}
// Resource entry points share the full profile instead of maintaining separate popup editors.
function openBotProfileTab(botId,tab){if(botById(botId)){closeDialog();navigate(`/bots/${encodeURIComponent(botId)}/${tab}`);}}
async function fileEditor(botId,filePath='',isNew=false){
  const result=isNew?{content:''}:await api(`/api/bots/${encodeURIComponent(botId)}/files/content?path=${encodeURIComponent(filePath)}`);
  openDialog(isNew?'New file':filePath.split('/').at(-1),`<form id="workspace-file-form" data-bot="${esc(botId)}"><div class="field"><label for="workspace-file-path">Workspace path</label><input id="workspace-file-path" name="path" value="${esc(isNew?[filePath,'notes.md'].filter(Boolean).join('/'):filePath)}" maxlength="240" ${isNew?'':'readonly'} required><small>Relative to this bot’s workspace.</small></div><div class="field"><label for="workspace-file-content">Text content</label><textarea id="workspace-file-content" name="content" class="code-input workspace-editor" maxlength="100000">${esc(result.content||'')}</textarea></div>${modalFooter('Save file',isNew?'':`<a class="secondary-button" href="/api/bots/${encodeURIComponent(botId)}/files/download?path=${encodeURIComponent(filePath)}" download>${icon('file')}Download file</a>`)}</form>`,{wide:true});
}

document.addEventListener('click',async event=>{
  const el=event.target.closest('button,[data-action],[data-nav],[data-filter]');if(!el)return;
  const menuAnchor=el.closest('.menu-layer')?.anchor,menuHadFocus=!!menuAnchor&&document.activeElement===el;
  if(menuAnchor)closeMenu();
  if(el.dataset.nav){if(el.classList.contains('bot-card')&&String(window.getSelection?.()||'').trim())return;if(el.dataset.close)closeDialog();navigate(el.dataset.nav);return;}
  if(el.dataset.filter){filter=el.dataset.filter;showPage();return;}
  const action=el.dataset.action,id=el.dataset.id;if(!action)return;
  try{
    switch(action){
      case 'retry':await start();break;
      case 'search-conversations':conversationSearchDialog(el.dataset.scope,id,el.dataset.scope?'':search);break;
      case 'new-chat':{el.disabled=true;try{const result=await api(`/api/bots/${encodeURIComponent(id)}/sessions`,{method:'POST',body:{}});chatSessionView=null;if($('dialog'))closeDialog();if(route().view==='bot'&&route().id===id)await loadChat(id);else navigate(`/bot/${id}`);toast(result.reused?'This chat is already empty.':'New chat started. Memory and notes carry over.');}finally{if(el.isConnected)el.disabled=false;}break;}
      case 'chat-sessions':await chatSessionsDialog(id);break;
      case 'open-chat-session':{const sessionId=el.dataset.session;chatSessionView=el.dataset.active==='true'?null:{botId:id,sessionId};closeDialog();if(route().view==='bot'&&route().id===id)await loadChat(id);else navigate(`/bot/${id}`);break;}
      case 'close-chat-session':chatSessionView=null;await loadChat(id);break;
      case 'resume-chat-session':{el.disabled=true;try{await api(`/api/bots/${encodeURIComponent(id)}/sessions/${encodeURIComponent(el.dataset.session)}/resume`,{method:'POST',body:{}});chatSessionView=null;if($('dialog'))closeDialog();if(route().view==='bot'&&route().id===id)await loadChat(id);else navigate(`/bot/${id}`);toast('Chat resumed.');}finally{if(el.isConnected)el.disabled=false;}break;}
      case 'rename-chat-session':renameChatSessionRow(el,id);break;
      case 'delete-chat-session':{const title=el.dataset.title||'this chat';if(!confirm(`Delete “${title}”? Its messages and the bot’s working history for it are removed on every linked engine. Memory and notes stay. This cannot be undone.`))break;await api(`/api/bots/${encodeURIComponent(id)}/sessions/${encodeURIComponent(el.dataset.session)}`,{method:'DELETE'});if(chatSessionView?.sessionId===el.dataset.session)chatSessionView=null;await chatSessionsDialog(id);if(route().view==='bot'&&route().id===id)void loadChat(id);toast('Chat deleted.');break;}
      case 'open-search-result':if(el.dataset.scope==='bot'&&el.dataset.session)chatSessionView={botId:id,sessionId:el.dataset.session};openSearchResult(el.dataset.scope,id,el.dataset.messageId);break;
      case 'inference-picker':openInferencePicker(el,id);break;
      case 'chat-options':await chatOptionsDialog(id);break;
      case 'compact-context':case 'new-topic':{const topic=action==='new-topic';el.disabled=true;toast(topic?'Starting a new topic…':'Summarizing older messages…');try{const result=await api(`/api/bots/${encodeURIComponent(id)}/compact`,{method:'POST',body:topic?{topic:true}:{}});closeDialog();if(route().id===id)await loadChat(id);toast(result.compacted?(topic?'New topic started. The earlier conversation was summarized.':'Older messages were summarized.'):result.reason||'Nothing to summarize yet.');}finally{if(el.isConnected)el.disabled=false;}break;}
      case 'dictate':await startDictation(el.dataset.target);break;
      case 'accept-dictation':{speechController()?.acceptRecognitionNotice();const target=el.dataset.target;closeDialog();await startDictation(target);break;}
      case 'stop-dictation':speechController()?.stopDictation();break;
      case 'cancel-dictation':speechController()?.cancelDictation();break;
      case 'dismiss-voice-error':speechController()?.clearError();break;
      case 'stop-reading':speechController()?.stopReading();break;
      case 'preview-ai-voice':try{await previewCloudVoice(el.dataset.model);}catch(error){setFormError($('#chat-options-form'),error);}break;
      case 'refresh-speech-catalog':await loadSpeechCatalog(true);break;
      case 'read-message':{const controller=speechController();if(!controller)throw new Error('Read aloud could not load. Reload this page or use your device’s screen reader.');const key=el.closest('[data-message-key]')?.dataset.messageKey;if(controller.state.readingKey===key){controller.stopReading();break;}const message=[...(chat.messages||[]),...(roomChat.messages||[])].find(item=>messageKey(item)===key);if(message)await controller.read(message.content??message.text??'',{key});break;}
      case 'close-menu':break;
      case 'switch-bot':botSwitcherMenu(el,id);break;
      case 'switch-room':roomSwitcherMenu(el,id);break;
      case 'choose-companion':{const variant=el.dataset.variant;if(!window.StudioAvatars?.shapes.some(choice=>choice.id===`companion:${variant}`))break;const form=el.closest('form'),input=$('#bot-icon',form);if(!input)break;input.value=`companion:${variant}`;input.dispatchEvent(new Event('input',{bubbles:true}));const bot={...botById(form.dataset.id),icon:input.value,name:$('#bot-name',form)?.value||'',color:$('[name="color"]',form)?.value};$('#bot-avatar-preview',form).innerHTML=avatar(bot,'large');form.querySelectorAll('.companion-choice').forEach(button=>button.setAttribute('aria-pressed',String(button===el)));break;}
      case 'create-mission':window.StudioMissions?.create(studioContext(),id);break;
      case 'adopt-mission':window.StudioMissions?.adopt(studioContext(),id,el.dataset.runId);break;
      case 'chat-menu':chatMenu(el,id);break;
      case 'bot-menu':botMenu(el,id);break;
      case 'room-menu':roomMenu(el,id);break;
      case 'room-details':{const room=data.rooms.find(r=>r.id===id);if(room)openDialog(room.name,`<div class="room-details">${roomDetails(room,room.botIds.map(botById).filter(Boolean))}</div>`);break;}
      case 'app-settings':tellApp({type:'app-settings'});break;
      case 'help':helpDialog();break;
      case 'logout':workshopGrantDrafts.clear();cleanupSpeech();await api('/api/logout',{method:'POST',body:{}});auth=await api('/api/auth');closeDialog();data={...initialState};renderAuth();break;
      case 'pair-device':await pairingDialog('device');break;
      case 'pair-engine':await pairingDialog('engine');break;
      case 'copy-pairing':{const input=$('#pairing-link');await navigator.clipboard?.writeText(input.value).catch(()=>{input.select();document.execCommand?.('copy');});toast('Pairing link copied.');break;}
      case 'connect-hub':connectHubDialog();break;
      case 'rename-engine':renameEngineDialog();break;
      case 'toggle-public-password':{const on=!!syncView?.status?.access?.publicPassword;if(!on&&!confirm('Allow password sign-in from the internet? Anyone who finds this address can then try passwords. Paired apps work either way.'))break;if(on&&syncView.status.access.public&&!confirm('Turn off password sign-in from the internet? If this browser signed in with the password, it will be signed out.'))break;await api('/api/access',{method:'PATCH',body:{publicPassword:!on}});toast(on?'Only paired apps can sign in from the internet.':'Password sign-in from the internet is on.');await loadSyncPage();break;}
      case 'disconnect-hub':if(confirm('Stop syncing with your home server? Everything already here stays. Automatic routines and messaging will be paused here. Copied ChatGPT connections will need a fresh sign-in or re-link. Wait for active work to finish first.')){await api('/api/sync/disconnect',{method:'POST',body:{}});await refresh(false);await loadSyncPage();toast('Disconnected. Automatic routines and messaging are paused here.');}break;
      case 'enable-local-automation':if(confirm('Run this engine’s enabled routines and messaging channels here? They can use model credits and send messages, even if the former home server still runs its own copy. Copied ChatGPT authorizations still need a fresh sign-in.')){await api('/api/sync/automation',{method:'POST',body:{enabled:true,confirm:true}});await refresh(false);await loadSyncPage();toast('This engine now runs its configured routines and messaging.');}break;
      case 'revoke-device':if(confirm(`Remove ${el.dataset.name||'this device'}? It will need to pair again.`)){await api(`/api/devices/${encodeURIComponent(id)}`,{method:'DELETE'});await loadSyncPage();toast('Device removed.');}break;
      case 'create-room':roomDialog();break;
      case 'edit-room':roomDialog(id);break;
      case 'delete-room':confirmDelete('room',id);break;
      case 'stop-room':el.disabled=true;await api(`/api/rooms/${encodeURIComponent(id)}/stop`,{method:'POST',body:JSON.parse(el.dataset.drive||'{}')});await loadRoomChat(id);toast('Room paused. Queued turns cancelled.');break;
      case 'reload-room':await loadRoomChat(id);break;
      case 'create-bot':botDialog();break;
      case 'starter-template':botDialog(undefined,el.dataset.template);break;
      case 'onboarding-prompt':{const template=(data.botTemplates||[]).find(item=>item.id===el.dataset.template);if(template)openBotDraft(id,template.prompt,{notice:'Prompt added to your draft. Make it yours, then Send.'});break;}
      case 'onboarding-dismiss':{el.disabled=true;try{await api('/api/onboarding',{method:'PATCH',body:{dismissed:true}});await refresh(false);if(route().view==='welcome')navigate('/dashboard');else renderApp();toast('Getting started is always available from Dashboard and Help.');}finally{if(el.isConnected)el.disabled=false;}break;}
      case 'edit-bot':closeDialog();navigate(`/bots/${encodeURIComponent(id)}/settings`);break;
      case 'toggle-bot-favorite':{const bot=botById(id);if(!bot||favoriteSaves.has(id))break;const favorite=!bot.favorite,generation=sendSessionGeneration;favoriteSaves.add(id);el.disabled=true;try{await api(`/api/bots/${encodeURIComponent(id)}`,{method:'PATCH',body:{favorite}});if(generation!==sendSessionGeneration||!auth?.authenticated)break;workspaceStateApplied=++workspaceStateRequest;const current=botById(id);if(current)current.favorite=favorite;const hadFocus=document.activeElement===el||menuHadFocus;if(route().view==='bots'&&!route().id){showPage();if(hadFocus){const buttons=[...document.querySelectorAll(menuAnchor?.closest('.bot-row')?'.bot-list .bot-row-more':'.bot-grid .bot-favorite')];(buttons.find(button=>button.dataset.id===id)||buttons[0]||$('[data-filter="favorites"]'))?.focus({preventScroll:true});}}else for(const button of document.querySelectorAll('.bot-favorite'))if(button.dataset.id===id)button.outerHTML=favoriteButton(current||bot);toast(favorite?`${bot.name} added to Favorites.`:`${bot.name} removed from Favorites.`);}finally{favoriteSaves.delete(id);if(el.isConnected)el.disabled=false;}break;}
      case 'toggle-bot-hidden':{const bot=botById(id);if(!bot)break;const hidden=!bot.hidden;await api(`/api/bots/${encodeURIComponent(id)}`,{method:'PATCH',body:{hidden}});await refresh();toast(hidden?`${bot.name} is hidden. Find it under Bots › Hidden.`:`${bot.name} is back in the sidebar.`);break;}
      case 'create-connection':chooseProviderDialog();break;
      case 'choose-provider':connectionDialog(undefined,el.dataset.type);break;
      case 'assign-provider':await assignProviderDialog(id);break;
      case 'choose-default-model':await defaultModelDialog(id);break;
      case 'provider-login':await providerLoginDialog(id,connectionById(id)?.status!=='connected');break;
      case 'provider-logout':await api(`/api/connections/${encodeURIComponent(id)}/logout`,{method:'POST',body:{}});closeDialog();await refresh();toast('Provider account disconnected.');break;
      case 'create-channel':channelDialog();break;
      case 'edit-channel':channelDialog(id);break;
      case 'delete-channel':confirmDelete('channel',id);break;
      case 'test-channel':el.disabled=true;await testChannel(id);break;
      case 'toggle-channel':{const channel=data.channels.find(c=>c.id===id);if(!channel)break;el.disabled=true;await api(`/api/channels/${encodeURIComponent(id)}`,{method:'PATCH',body:{enabled:!channel.enabled}});await refresh();toast(channel.enabled?'Telegram message intake paused.':'Telegram message intake enabled for allowlisted users and chats.');break;}
      case 'create-integration':{integrationDialog(undefined,el.dataset.type);const preset=el.dataset.preset&&$('#integration-preset');if(preset){preset.value=el.dataset.preset;await applyIntegrationPreset(preset);}break;}
      case 'edit-integration':integrationDialog(id);break;
      case 'test-integration':el.disabled=true;await testIntegration(id);break;
      case 'delete-integration':confirmDelete('integration',id);break;
      case 'bot-memory':openBotProfileTab(id,'memory');break;
      case 'bot-files':openBotProfileTab(id,'files');break;
      case 'open-file':if(previewFormats.test(el.dataset.path||''))await documentPreview(id,el.dataset.path);else await fileEditor(id,el.dataset.path);break;
      case 'preview-document':await documentPreview(id,el.dataset.path);break;
      case 'edit-text-file':await fileEditor(id,el.dataset.path);break;
      case 'attach-files':$('#chat-attachments')?.click();break;
      case 'remove-attachment':{const files=composerAttachments.get(id)||[];files.splice(Number(el.dataset.index),1);composerAttachments.set(id,files);refreshComposerAttachments(id);break;}
      case 'new-file':await fileEditor(id,el.dataset.path||'',true);break;
      case 'edit-connection':if(connectionById(id)?.type==='legacy-hermes')chooseProviderDialog();else connectionDialog(id);break;
      case 'create-routine':routineDialog(undefined,el.dataset.bot);break;
      case 'edit-routine':routineDialog(id);break;
      case 'close-dialog':closeDialog();break;
      case 'import-skill':importDialog();break;
      case 'view-skill':await viewSkill(id);break;
      case 'export-skill':{const result=await api(`/api/skills/${encodeURIComponent(id)}/export`);const blob=new Blob([JSON.stringify(result,null,2)+'\n'],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`${id}.skill.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Skill package downloaded. Use Import skill to add it to a workspace.');break;}
      case 'copy-skill':{const result=await api(`/api/skills/${encodeURIComponent(id)}`);await navigator.clipboard.writeText(result.content);toast('Skill copied.');break;}
      case 'delete-bot':confirmDelete('bot',id);break;
      case 'delete-connection':confirmDelete('connection',id);break;
      case 'delete-routine':confirmDelete('routine',id);break;
      case 'delete-skill':confirmDelete('skill',id);break;
      case 'confirm-delete':{const endpoint={bot:'bots',routine:'routines',skill:'skills',room:'rooms',connection:'connections',integration:'integrations',channel:'channels'}[el.dataset.kind];el.disabled=true;try{await api(`/api/${endpoint}/${encodeURIComponent(id)}`,{method:'DELETE',body:{}});}catch(error){setFormError(el.closest('dialog'),error);break;}closeDialog();if(route().id===id)navigate('/bots');await refresh();toast('Removed.');break;}
      case 'test-connection':testConnectionDialog(id);break;
      case 'toggle-routine':{const routine=data.routines.find(r=>r.id===id);el.disabled=true;await api(`/api/routines/${encodeURIComponent(id)}`,{method:'PATCH',body:{enabled:!routine.enabled}});await refresh();toast(routine.enabled?'Routine paused.':'Routine scheduled.');break;}
      case 'routine-history':await routineHistory(id);break;
      case 'run-routine':el.disabled=true;await api(`/api/routines/${encodeURIComponent(id)}/run`,{method:'POST',body:{}});await refresh();toast('Routine started. Results will arrive in the bot’s chat.');break;
      case 'starter':{const input=$('#message-input');input.value=el.dataset.text;input.focus();break;}
      case 'toggle-inspector':{const inspector=$('.bot-inspector');if(!inspector)break;if(phoneLayout()){openDialog('About your teammate',`<div class="room-details">${inspector.innerHTML}</div>`);const close=$('dialog [aria-label="Close bot details"]');if(close){close.dataset.action='close-dialog';}break;}const open=inspector.classList.toggle('open');if(open)inspector.focus();else $('.chat-more')?.focus();break;}
      case 'send-direction':await sendDirectionFromComposer(id);break;
      case 'reload-chat':await loadChat(id);break;
      case 'reload-conversation-route':conversationRouteResolution=null;renderApp();break;
      case 'process-output':await processOutputDialog(JSON.parse(el.dataset.process||'{}'));break;
      case 'process-output-refresh':if(managedOutputView)await loadProcessOutput(managedOutputView,0,false);break;
      case 'process-output-more':if(managedOutputView&&managedOutputView.nextOffset!==null)await loadProcessOutput(managedOutputView,managedOutputView.nextOffset,true);break;
      case 'stop-process':el.disabled=true;try{await stopManagedProcess(JSON.parse(el.dataset.process||'{}'));}finally{if(el.isConnected)el.disabled=false;}break;
      case 'stop-run':el.disabled=true;await api(`/api/bots/${encodeURIComponent(id)}/stop`,{method:'POST',body:JSON.parse(el.dataset.run||'{}')});await loadChat(id);window.StudioMissions?.reload();toast('Stop requested.');break;
      case 'browser-handoff':{
        const generation=sendSessionGeneration,missionPage=route().view==='missions'?route().id:null,identity=JSON.parse(el.dataset.browserIdentity||'{}');
        window.StudioBrowser?.open({api,openDialog,closeDialog,loadChat,toast,valid:()=>generation===sendSessionGeneration&&auth?.authenticated&&(route().view==='bot'&&route().id===id||route().view==='missions'&&route().id===missionPage&&el.isConnected&&!!el.closest('.mission-owner-controls'))},id,identity);break;
      }
      case 'answer-mission-proposal':case 'decline-mission-proposal':case 'answer-question':case 'skip-question':{
        const card=el.closest('.question-card'),skip=el.dataset.action==='skip-question';
        const answers=el.dataset.action.endsWith('mission-proposal')?[{questionId:'mission_effort',optionIds:[el.dataset.action==='decline-mission-proposal'?'chat':card.querySelector('[name=effort]').value]}]:skip?null:[...card.querySelectorAll('.question-item')].map(item=>({questionId:item.dataset.questionId,optionIds:[...item.querySelectorAll('input:checked')].map(input=>input.value),text:item.querySelector('.question-text')?.value.trim()||''}));
        if(answers?.some(answer=>!answer.optionIds.length&&!answer.text)){toast('Answer each question, or choose Skip.',true);break;}
        el.disabled=true;await api(`/api/bots/${encodeURIComponent(id)}/answer`,{method:'POST',body:{...JSON.parse(card.dataset.question||'{}'),...(skip?{skip:true}:{answers})}});await loadChat(id);window.StudioMissions?.reload();toast(skip?'Question skipped.':'Answer sent.');break;
      }
      case 'undo-memory':{el.disabled=true;const result=await api(`/api/bots/${encodeURIComponent(id)}/memory/${encodeURIComponent(el.dataset.entry||'')}`,{method:'POST',body:{undo:true,revision:el.dataset.revision||''}});await loadChat(id);toast(result?.restored?'Restored the earlier memory.':'Forgotten.');break;}
      case 'approve':{const identity=JSON.parse(el.dataset.approval||'{}'),draft=workshopGrantDrafts.get(identity.request_id),grant=el.dataset.choice==='bounded-read'?{maxRequests:Number(draft?.maxRequests),minutes:Number(draft?.minutes),intervalSeconds:Number(draft?.intervalSeconds),botIds:draft?.botIds}:undefined;el.disabled=true;await api(`/api/bots/${encodeURIComponent(id)}/approval`,{method:'POST',body:{...identity,choice:el.dataset.choice,...(grant?{grant}:{})}});workshopGrantDrafts.delete(identity.request_id);await loadChat(id);window.StudioMissions?.reload();toast(el.dataset.choice==='once'?'Approved for this action.':el.dataset.choice==='bounded-read'?'Bounded reads approved for this task.':'Action denied.');break;}
    }
  }catch(error){toast(errorText(error),true);}finally{if(el.isConnected)el.disabled=el.dataset.action==='process-output-more'&&(!managedOutputView||managedOutputView.nextOffset===null||managedOutputView.output.length>=250000);if(el.dataset.action==='send-direction')updateDirectionComposer(el.dataset.id,chat.run);}
});
document.addEventListener('submit',async event=>{
  if(event.target.id==='conversation-search-form'||event.target.matches?.('[data-mission-create],[data-mission-direction],[data-mission-revise],[data-mission-effort-form],[data-mission-adopt]'))return;
  if(event.target.id==='workspace-search-form'){event.preventDefault();if(auth?.authenticated)conversationSearchDialog('','',$('#workspace-search',event.target).value);return;}
  const form=event.target;if(!(form instanceof HTMLFormElement))return;event.preventDefault();if(form.id==='bot-form'&&form.dataset.settingsSaving==='true')return;if(form.id==='message-form'){const direction=$('[data-action="send-direction"]',form);if(direction&&!direction.hidden){if(!direction.disabled)await sendDirectionFromComposer(form.dataset.id);return;}}if(['message-form','room-message-form'].includes(form.id))stopSpeechForSend();const f=new FormData(form);const values=Object.fromEntries(f);const submittedText=$('textarea[name=text]',form)?.value;const submit=$('button[type=submit]',form);if(submit)submit.disabled=true;const errorBox=$('.form-error',form);if(errorBox)errorBox.textContent='';
  try{
    switch(form.id){
      case 'chat-options-form':{const controller=speechController(),voice=controller?.getVoices().find(item=>item.uri===String(values.speechVoice||'')),cloud=values.speechEngine==='openrouter',voiceDirty=form.dataset.voiceDirty==='true',cloudOptions=voiceDirty&&cloud?cloudSpeechOptions():{engine:'browser'};if(voiceDirty&&!cloud&&voice&&!voice.local&&!f.has('allowRemoteVoice'))throw new Error('Allow online voice processing before choosing this voice.');if(form.dataset.id&&form.dataset.inferenceReady==='true'&&form.dataset.inferenceDirty==='true'){const inferenceBody={model:String($('#chat-model',form)?.value??values.model??'')},effort=String($('#chat-reasoning',form)?.value??values.reasoningEffort??'auto');if(effort!==chatInferenceState?.reasoningEffort||form.dataset.reasoningDirty==='true')inferenceBody.reasoningEffort=effort;const result=await api(`/api/bots/${encodeURIComponent(form.dataset.id)}/inference`,{method:'PATCH',body:inferenceBody});const updated=result.bot||{...botById(form.dataset.id),...inferenceBody};data.bots=data.bots.map(bot=>bot.id===updated.id?updated:bot);updateChatModelSummary(updated);}if(voiceDirty)controller?.setPreferences({...cloudOptions,language:String(values.speechLanguage||'en-US'),voiceURI:String(values.speechVoice||''),autoRead:f.has('autoRead'),allowRemoteVoice:!!voice&&!voice.local&&f.has('allowRemoteVoice')});closeDialog();toast(form.dataset.id?'Chat options saved. Model changes apply to the next task.':'Voice preferences saved in this browser.');break;}
      case 'connect-hub-form':{await api('/api/sync/connect',{method:'POST',body:{link:String(values.link||'').trim()}});closeDialog();await refresh(false);await loadSyncPage();toast('Linked. This engine is now syncing.');break;}
      case 'rename-engine-form':{await api('/api/sync/engine',{method:'PATCH',body:{name:values.name}});closeDialog();await refresh(false);await loadSyncPage();renderApp();break;}
      case 'pairing-url-form':{await pairingDialog(form.dataset.kind,String(values.url||'').trim());break;}
      case 'auth-form':auth=await api(auth?.setupRequired?'/api/setup':'/api/login',{method:'POST',body:values});auth=await api('/api/auth');await refresh();await offerDefaultModel();break;
      case 'room-form':{const id=form.dataset.id;await api(id?`/api/rooms/${encodeURIComponent(id)}`:'/api/rooms',{method:id?'PATCH':'POST',body:{name:values.name,botIds:f.getAll('member'),autoCollaborate:f.has('autoCollaborate'),maxRounds:Number(values.maxRounds||4)}});closeDialog();await refresh();toast('Team room saved.');break;}
      case 'room-message-form':{const id=form.dataset.id;const text=String(values.text||'').trim();if(!text)return;await sendRoomMessage(id,{text});if($('textarea',form).value===submittedText)$('textarea',form).value='';window.StudioMobile?.sent(form,submittedText);await loadRoomChat(id);break;}
      case 'bot-form':await saveBotSettings(form,f,values);break;
      case 'connection-test-form':await testConnectionDialog(form.dataset.id);break;
      case 'default-model-form':{if(!values.model)throw new Error('Choose a model to continue.');await api(`/api/connections/${encodeURIComponent(form.dataset.id)}/default-model`,{method:'POST',body:{model:values.model,applyToAllBots:f.has('applyToAllBots')}});closeDialog();await refresh();toast('Default model saved. Your bots will use it automatically.');break;}
      case 'connection-form':{const id=form.dataset.id;if(!values.apiKey)delete values.apiKey;if(!values.baseUrl)delete values.baseUrl;const result=await api(id?`/api/connections/${encodeURIComponent(id)}`:'/api/connections',{method:id?'PATCH':'POST',body:values});closeDialog();await refresh();const savedId=result.id||result.connection?.id||id;if(oauthProvider(values.type))await providerLoginDialog(savedId);else if(!id)await testConnectionDialog(savedId);else toast('Provider settings saved.');break;}
      case 'assign-provider-form':{const selected=f.getAll('botId');if(!selected.length)throw new Error('Choose at least one bot.');if(!values.model&&!connectionById(form.dataset.id)?.defaultModel)throw new Error('Choose a model from the provider catalog.');for(const botId of selected)await api(`/api/bots/${encodeURIComponent(botId)}`,{method:'PATCH',body:{connectionId:form.dataset.id,model:values.model||''}});closeDialog();await refresh();toast('Your teammates are ready to work.');break;}
      case 'integration-form':{const id=form.dataset.id,payload={name:values.name,type:values.type,baseUrl:values.baseUrl,authType:values.authType||'bearer'};if(values.authType==='header')payload.headerName=values.headerName;if(values.apiKey)payload.apiKey=values.apiKey;if(values.type==='rest'){try{payload.tools=JSON.parse(values.tools);}catch{throw new Error('API actions must be a valid JSON array.');}if(!Array.isArray(payload.tools))throw new Error('API actions must be a JSON array.');}const result=await api(id?`/api/integrations/${encodeURIComponent(id)}`:'/api/integrations',{method:id?'PATCH':'POST',body:payload});closeDialog();await refresh();await testIntegration(result.id||result.integration?.id||id);break;}
      case 'channel-form':{const id=form.dataset.id,splitIds=value=>String(value||'').split(/[,\s]+/).map(v=>v.trim()).filter(Boolean),payload={name:values.name,type:'telegram',botId:values.botId,enabled:f.has('enabled'),allowedChatIds:splitIds(values.allowedChatIds),allowedUserIds:splitIds(values.allowedUserIds),ownerUserId:String(values.ownerUserId||'').trim()};if(values.token)payload.token=values.token;if(payload.enabled&&(!payload.allowedChatIds.length||!payload.allowedUserIds.length))throw new Error('Set both allowed chat IDs and allowed user IDs before enabling incoming messages.');await api(id?`/api/channels/${encodeURIComponent(id)}`:'/api/channels',{method:id?'PATCH':'POST',body:payload});closeDialog();await refresh();toast(payload.enabled?'Channel saved with allowlisted message intake enabled.':'Channel saved paused. Verify its bot identity before enabling.');break;}
      case 'workspace-file-form':await api(`/api/bots/${encodeURIComponent(form.dataset.bot)}/files`,{method:'PUT',body:{path:values.path,content:values.content}});if(route().view==='bots'&&route().id)closeDialog();else openBotProfileTab(form.dataset.bot,'files');toast('File saved.');break;
      case 'routine-form':{const id=form.dataset.id,kind=values.kind,schedule=kind==='interval'?{kind,minutes:Number(values.every)*Number(values.unit)}:kind==='once'?{kind,at:String(values.at).slice(0,16)}:kind==='weekly'?{kind,time:values.time,days:f.getAll('days')}:{kind:'daily',time:values.time},execution=routineExecutionInput(values);await api(id?`/api/routines/${encodeURIComponent(id)}`:'/api/routines',{method:id?'PATCH':'POST',body:{name:values.name,botId:values.botId,prompt:values.prompt,schedule,timezone:values.timezone,missed:values.missed,enabled:f.has('enabled'),...execution}});closeDialog();await refresh();toast('Routine saved.');break;}
      case 'skill-form':await api('/api/skills',{method:'POST',body:importedSkillFiles?{files:importedSkillFiles}:{content:values.content}});closeDialog();await refresh();toast('Skill imported. Assign it in your bot’s settings.');break;
      case 'message-form':{const id=form.dataset.id;const text=String(values.text||'').trim(),attachments=composerAttachments.get(id)||[];if(chatReviewSaves.has(id)){toast('Wait for action review to finish saving.');return;}if(reasoningSaves.has(id)){toast('Wait for reasoning to finish saving.');return;}if(attachmentUploads.has(id)||(!text&&!attachments.length))return;await sendMessage(id,{text,...(attachments.length?{attachments:attachments.map(file=>({path:file.path,name:file.name}))}:{})});if($('textarea',form).value===submittedText)$('textarea',form).value='';window.StudioMobile?.sent(form,submittedText);composerAttachments.delete(id);refreshComposerAttachments(id);await loadChat(id);break;}
    }
  }catch(error){if(['message-form','room-message-form'].includes(form.id))toast(errorText(error),true);else setFormError(form,error);}finally{if(submit?.isConnected)submit.disabled=false;if(form.id==='bot-form')window.StudioBotProfile?.syncSettings(form);if(form.id==='message-form')renderThread(botById(form.dataset.id));if(form.id==='room-message-form')renderRoomThread(form.dataset.id);}
});
document.addEventListener('input',event=>{if(['message-input','room-message-input'].includes(event.target.id)&&(speechController()?.state.listening||speechController()?.state.transcribing))speechController().discardDictation();if(event.target.id==='workspace-search'){search=event.target.value;document.querySelectorAll('.roster-item').forEach(item=>{item.hidden=!item.textContent.toLowerCase().includes(search.toLowerCase());});if(!['bot','room'].includes(route().view))showPage();}});
document.addEventListener('change',async event=>{
  if(event.target.id==='chat-approval-policy'){await saveChatReview(event.target.dataset.bot,event.target.value);return;}
  if(event.target.closest('[data-voice-settings]')){const form=event.target.closest('#chat-options-form');if(form){form.dataset.voiceDirty='true';const consent=$('[name=cloudSpeechConsent]',form);if(consent)consent.required=$('#speech-engine',form)?.value==='openrouter';updateRemoteVoiceNotice();}}
  if(['chat-model','chat-reasoning'].includes(event.target.id)){const form=event.target.closest('#chat-options-form');if(form)form.dataset.inferenceDirty='true';}
  if(event.target.id==='chat-reasoning'){const form=event.target.closest('#chat-options-form');if(form)form.dataset.reasoningDirty='true';}
  if(event.target.id==='chat-model')updateChatReasoning();
  if(event.target.id==='bot-model')updateBotReasoning(event.target.closest('#bot-form'));
  if(event.target.name==='teamMode'){const list=$('.team-checklist',event.target.closest('form'));if(list)list.hidden=event.target.value!=='selected';}
  if(event.target.id==='speech-voice')updateRemoteVoiceNotice();
  if(event.target.id==='speech-engine')updateSpeechEngine();
  if(event.target.id==='speech-connection'){speechController()?.stopReading();void loadSpeechCatalog();}
  if(event.target.id==='speech-ai-model'){rememberCloudVoice();speechController()?.stopReading();updateCloudVoices();}
  if(event.target.id==='speech-ai-voice'){rememberCloudVoice();speechController()?.stopReading();}
  if(event.target.name==='cloudSpeechConsent')speechController()?.stopReading();
  if(event.target.name==='model'&&event.target.closest('#default-model-form')){const form=event.target.closest('form'),submit=$('button[type=submit]',form);if(submit)submit.disabled=!$('[name=model]:checked',form);}
  if(event.target.id==='bot-connection'){const id=event.target.value,form=event.target.closest('#bot-form');updateBotReasoning(form);if(id)try{const result=await api(`/api/connections/${encodeURIComponent(id)}/models`);if(!form?.isConnected||$('#bot-connection',form)?.value!==id)return;const models=result.models||result.data||result,connection=connectionById(id);if(connection&&Array.isArray(models))connection.models=models;if($('#bot-models',form))$('#bot-models',form).innerHTML=modelItems(models).map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');updateBotReasoning(form);}catch(error){toast(errorText(error),true);}}
  if(event.target.id==='integration-preset')await applyIntegrationPreset(event.target);
  if(event.target.name==='integrationId'&&!event.target.checked){const field=$('[name=searchFallbackIntegrationId]',event.target.closest('form'));if(field?.value===event.target.value)field.value='';window.StudioBotProfile?.syncSettings(event.target.closest('form'));}
  if(event.target.id==='integration-auth'){const value=event.target.value;$('#integration-header-field').hidden=value!=='header';$('#integration-key-field').hidden=value==='none';}
  if(event.target.id==='integration-type'){const rest=event.target.value==='rest';$('#integration-tools-field').hidden=!rest;$('#integration-tools').required=rest;}
  if(['workspace-upload','chat-attachments'].includes(event.target.id)&&event.target.files?.length){
    const input=event.target,botId=input.dataset.bot,attach=input.id==='chat-attachments';try{await uploadFiles(botId,[...input.files],{attach});if(!attach){openBotProfileTab(botId,'files');toast('Files added to this bot’s workspace.');}}catch(error){toast(errorText(error),true);}finally{input.value='';}
  }
  if(event.target.id==='routine-kind')updateRoutineKind();
  if(event.target.id==='routine-execution-mode')updateRoutineExecutionMode();
  if(event.target.id==='routine-workflow-mode')updateRoutineWorkflowMode();
  if(event.target.id==='skill-file'&&event.target.files?.[0]){const file=event.target.files[0];if(file.size>100000)return toast('Please choose a SKILL.md smaller than 100 KB.',true);importedSkillFiles=null;$('#skill-content').readOnly=false;$('#skill-content').value=await file.text();$('#import-file-summary').textContent='';}
  if(event.target.id==='skill-folder'&&event.target.files?.length){
    try{
      const files=[...event.target.files].filter(f=>!f.name.startsWith('.DS_Store')&&!f.webkitRelativePath.split('/').includes('.git'));
      if(files.length>100)throw new Error('A skill folder can contain up to 100 files.');
      if(files.reduce((total,f)=>total+f.size,0)>5000000)throw new Error('Please choose a skill folder smaller than 5 MB.');
      const top=files[0]?.webkitRelativePath.split('/')[0];
      const entries=files.map(file=>({file,path:file.webkitRelativePath?file.webkitRelativePath.split('/').slice(1).join('/'):file.name}));
      const main=entries.find(f=>f.path==='SKILL.md');if(!main)throw new Error('Choose a folder with SKILL.md at its root.');
      if(main.file.size>100000)throw new Error('SKILL.md must be smaller than 100 KB.');
      const encoded=await Promise.all(entries.map(async({file,path})=>({path,contentBase64:await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read a skill file.'));reader.readAsDataURL(file);})})));
      importedSkillFiles=encoded;$('#skill-content').value=await main.file.text();$('#skill-content').readOnly=true;$('#import-file-summary').textContent=`${files.length} files selected from ${top||'your skill'}. Resources are saved without being executed.`;
    }catch(error){importedSkillFiles=null;toast(errorText(error),true);}
  }
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&$('.menu-layer')){const anchor=$('.menu-layer').anchor;closeMenu();anchor?.focus();return;}
  if(event.key==='Escape'&&$('.bot-inspector.open')&&!$('dialog')){$('.bot-inspector').classList.remove('open');$('.chat-more')?.focus();return;}
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&auth?.authenticated){event.preventDefault();conversationSearchDialog('','',search);}
  if(['message-input','room-message-input'].includes(event.target.id)&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&(!phoneLayout()||event.metaKey||event.ctrlKey)){event.preventDefault();const form=event.target.closest('form');const direction=$('[data-action="send-direction"]',form),action=direction&&!direction.hidden?direction:$('.send',form);if(action&&!action.disabled)form.requestSubmit();}
});
// A new screen starts at the top; switching tabs inside one screen (a bot profile's sections) keeps the place.
let screenKey=`${route().view}/${route().id||''}`;
window.addEventListener('hashchange',()=>{if(document.querySelector('.browser-control-panel'))closeDialog();window.StudioBrowser?.reset();conversationRouteResolution=null;clearSearchAnchor?.();directionNavigationGeneration++;clearPendingDirections();conversationSearchNavigation++;const target=pendingSearchMessage,current=route();if(target&&(target.navigation!==conversationSearchNavigation||target.scope!==current.view||target.id!==current.id))pendingSearchMessage=null;dismissConversationSearch();cleanupSpeech();search='';const next=`${current.view}/${current.id||''}`;if(next!==screenKey){screenKey=next;if(!window.StudioMobile||!phoneLayout())window.scrollTo?.(0,0);}renderApp();});
window.addEventListener('scroll',updateTopbarScroll,{passive:true});
let menuWidth=window.innerWidth;window.addEventListener('resize',()=>{if(window.innerWidth!==menuWidth){menuWidth=window.innerWidth;closeMenu();}});
window.visualViewport?.addEventListener('resize',()=>$('.menu-layer')?.reposition?.());
window.matchMedia?.('(max-width:760px), (max-height:500px) and (pointer:coarse)').addEventListener?.('change',()=>{if(auth?.authenticated&&$('.app-shell'))tellApp({type:'chrome',ownsChrome:phoneLayout()});});
window.addEventListener('pagehide',()=>cleanupSpeech());
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&auth?.authenticated){if(route().view==='bot')loadChat(route().id);if(route().view==='room')loadRoomChat(route().id);}});
setInterval(async()=>{if(document.hidden||!auth?.authenticated)return;for(const bot of data.bots)syncBotAvatarMotion(bot);if(pollBusy||!['bot','room'].includes(route().view))return;pollBusy=true;try{if(route().view==='room')await loadRoomChat(route().id,{poll:true});else await loadChat(route().id,{poll:true});}finally{pollBusy=false;}},2000);
setInterval(()=>{if(!document.hidden&&auth?.authenticated&&route().view==='sync'&&!$('dialog'))loadSyncPage();},5000);
// Another engine, app or tab may have changed the workspace while this page was hidden; catch up as soon as it is shown.
let visibleRefresh=0;
async function refreshVisible(){
  if(document.hidden||!auth?.authenticated||Date.now()-visibleRefresh<1500)return;visibleRefresh=Date.now();
  try{const before=JSON.stringify(data);if(!await refresh(false))return;updateSidebar();const current=route(),view=current.view;
    if(view==='bot'||view==='room'){
      if(!conversationTargetExists(view,current.id))return;
      if(!hasConversationFrame(view,current.id)){renderApp();return;}
      if(!pollBusy){pollBusy=true;try{if(view==='room')await loadRoomChat(current.id);else await loadChat(current.id);}finally{pollBusy=false;}}
    }
    else if(view==='sync')await loadSyncPage();
    else if(before!==JSON.stringify(data)&&!$('dialog')&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))showPage();
  }catch{}
}
for(const name of ['visibilitychange','focus','pageshow','studio:visible'])(name==='visibilitychange'?document:window).addEventListener(name,refreshVisible);
setInterval(refreshUnread,5000);
setInterval(async()=>{if(document.hidden||!auth?.authenticated||['bot','room','sync'].includes(route().view)||$('dialog')||['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;try{const before=JSON.stringify(data),current=location.hash;await refresh(false);updateSidebar();if(current===location.hash&&before!==JSON.stringify(data)&&!$('dialog'))showPage();await offerDefaultModel();}catch{}},10000);
window.StudioNotificationReads?.install(() => {const current=route(),mission=current.view==='missions'?window.StudioMissions?.attendance():null;return {authenticated:!!auth?.authenticated,generation:sendSessionGeneration,view:current.view,id:current.id,botId:mission?.botId,notificationAttention:mission?.notificationAttention,messages:current.view==='missions'?[]:current.view==='room'?roomChat.messages:chat.messages,run:current.view==='missions'?mission?.run:current.view==='bot'?chat.run:null,api,onRead:acknowledgeSidebarRead};});
start();
