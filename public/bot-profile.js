/* Bot profile (#/bots/<botId>): Overview, Brain (long-term notes), Memory (core facts), Learning (suggested changes to review) and Files. app.js calls render(), sets the HTML, then mount(). */
(()=>{
const TABS=[['overview','Overview','grid'],['settings','Settings','sliders'],['brain','Brain','brain'],['memory','Memory','pin'],['learning','Learning','spark'],['files','Files','folder'],['scripts','Scripts','code'],['workshop','Workshop','code']];
const GROUPS={workspace:'Files',memory:'Memory',skills:'Skills',web:'Web',integrations:'Integrations',delegation:'Bot collaboration',automation:'Routines',setup:'Manage Tupies',terminal:'Terminal',browser:'Browser'};
const DEFAULT_GROUPS=['workspace','memory','skills','web','integrations','delegation','automation','setup'];
const PROVIDERS={openai:'OpenAI',anthropic:'Anthropic',xai:'xAI',openrouter:'OpenRouter',ollama:'Ollama',custom:'Custom API',chatgpt:'ChatGPT plan',codex:'Codex local'};
const PALETTE=['#829f96','#9590b5','#81a0bd','#d0a47b','#bf92aa','#b7b17e'];
const ACTIVITY={run:'play',memory:'pin',file:'file',bot:'bots',skill:'spark',learning:'spark',routine:'routine',integration:'globe',channel:'chat',process:'stop',room:'team'};
const GRAPH_NODES=60,LIST_PAGE=60,STALE=20000,MAX_FACTS=200,MAX_PINNED=20,W=640,H=340;
const WIKI=/(!?)\[\[([^\[\]|#\n]+)(#[^\[\]|\n]*)?(?:\|([^\[\]\n]*))?\]\]/g;
const TOKEN=/(!?)\[\[([^\[\]|#\n]+)(#[^\[\]|\n]*)?(?:\|([^\[\]\n]*))?\]\]|(^|\s)#([\p{L}\p{N}_/-]+)/gu;
const TEXT=/\.(?:txt|md|markdown|json|jsonl|csv|tsv|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|css|scss|html?|xml|svg|ya?ml|toml|ini|cfg|conf|sh|bash|zsh|sql|log)$/i;
const OWN={
  brain:'M12 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM5 22a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm14 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM12 7v5m0 0-5.5 5.2M12 12l5.5 5.2M7.5 19.5h9',
  folder:'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z',
  image:'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M15 8.5h.01',
  sheet:'M4 3h16v18H4zM4 9h16M4 15h16M10 3v18',
  slides:'M3 4h18v12H3zM12 16v4M8 20h8',
  code:'m8 8-4 4 4 4m8-8 4 4-4 4M13.5 5l-3 14',
  download:'M12 3v12m-5-5 5 5 5-5M4 20h16',
  back:'m15 5-7 7 7 7',
};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const enc=encodeURIComponent;
const views=new Map();
let ctx=null;
const icon=name=>OWN[name]?`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${OWN[name]}"/></svg>`:ctx.icon(name);
const plural=(count,word,many=`${word}s`)=>`${count} ${count===1?word:many}`;
const bytes=value=>{const n=Number(value)||0;return n<1000?`${n} B`:n<1e6?`${Math.round(n/1000)} KB`:`${(n/1e6).toFixed(1)} MB`;};
const groupsOf=bot=>Array.isArray(bot.tools)?bot.tools:DEFAULT_GROUPS;
const busy=bot=>ctx.botStatus(bot).className==='working';
const fold=value=>String(value||'').normalize('NFC').trim().toLowerCase();
const noteName=value=>String(value||'').split('/').at(-1).replace(/\.md$/i,'');
const displayName=item=>String(item.name||'').replace(/^file_[a-f0-9]{18}-/,'');
const colorOf=(v,folder)=>v.colors?.get(String(folder||'').split('/')[0])||'#9aa5b4';
const titleOf=(v,file)=>v.byPath?.get(file)?.title||noteName(file);
const showing=botId=>document.querySelector('.bot-profile')?.dataset.profileBot===botId;
const empty=(ico,title,text,extra='')=>`<div class="section-empty bp-empty">${icon(ico)}<h3>${esc(title)}</h3><p>${text}</p>${extra}</div>`;
const loading=label=>`<div class="bp-loading" role="status"><span class="bp-pulse"></span>${esc(label)}</div>`;
const retry=(message,action)=>`<div class="bp-error" role="alert"><p>${esc(message)}</p><button class="secondary-button" data-profile-action="${action}">Try again</button></div>`;
function friendly(bot,error,what='memory'){return error?.status===409&&/Wait for this bot/i.test(error.message||'')?`${bot.name} is working on a task right now. You can change its ${what} when it finishes.`:ctx.errorText(error);}

function view(botId){
  let v=views.get(botId);
  if(v){views.delete(botId);views.set(botId,v);return v;}
  v={id:botId,tab:'overview',tickets:{},loading:{},scroll:{},focus:null,brain:null,byPath:null,brainAt:0,brainError:'',layout:null,graphShown:false,noteTarget:'',note:null,noteHTML:'',noteAt:0,noteError:'',noteLoading:false,revealReader:false,query:'',folder:'',tag:'',sort:'recent',shown:LIST_PAGE,
    memory:null,memoryAt:0,memoryError:'',proposals:null,proposalsAt:0,proposalsError:'',proposalNotice:'',deciding:'',confirmingUndo:'',runs:null,runsAt:0,runsError:'',taskDetails:new Set(),memoryQuery:'',memoryNotice:'',adding:false,editing:'',confirming:'',draft:{},saving:false,files:new Map(),filesFolder:'',uploading:false,dirty:false,settingsOpen:false,settingsDraft:null,
    workspace:null,workspaceAt:0,workspaceError:'',workspaceSaving:false,workspaceNotice:'',scripts:null,scriptsAt:0,scriptsError:'',scriptsTruncated:false,scriptTarget:'',script:null,scriptLoading:false,scriptError:'',scriptQuery:'',scriptArgs:new Map(),scriptNotice:'',revealScript:false};
  views.set(botId,v);while(views.size>8)views.delete(views.keys().next().value);
  return v;
}
function hashTab(botId){const [page,id,tab]=location.hash.replace(/^#\/?/,'').split('/');return page==='bots'&&id===botId&&TABS.some(([key])=>key===tab)?tab:'';}

/* Data: cached per bot, refetched when stale; a superseded response never overwrites a newer one. */
async function fetchInto(bot,v,key,path,apply){
  const ticket=v.tickets[key]=(v.tickets[key]||0)+1;let result=null,error=null;
  try{result=await ctx.api(path);}catch(caught){error=caught;}
  if(v.tickets[key]!==ticket)return;
  apply(result,error);if(showing(bot.id))refresh(bot.id);
}
function ensureBrain(bot,v,force=false){
  if(v.loading.brain||(!force&&v.brainAt&&Date.now()-v.brainAt<STALE))return;v.loading.brain=true;
  fetchInto(bot,v,'brain',`/api/bots/${enc(bot.id)}/brain`,(result,error)=>{v.loading.brain=false;v.brainAt=Date.now();if(error){v.brainError=ctx.errorText(error);return;}v.brain={...result,notes:Array.isArray(result?.notes)?result.notes:[]};v.byPath=new Map(v.brain.notes.map(note=>[note.path,note]));v.brainError='';v.layout=null;
    // Folder colours follow folder size within this vault, so the largest folders never share a colour.
    const tops=new Map();for(const note of v.brain.notes){const top=note.folder.split('/')[0];if(top)tops.set(top,(tops.get(top)||0)+1);}
    v.colors=new Map([...tops].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([top],i)=>[top,PALETTE[i%PALETTE.length]]));
  });
}
function ensureRuns(bot,v,force=false){
  if(v.loading.runs||(!force&&v.runsAt&&Date.now()-v.runsAt<STALE))return;v.loading.runs=true;
  fetchInto(bot,v,'runs',`/api/bots/${enc(bot.id)}/runs`,(result,error)=>{v.loading.runs=false;v.runsAt=Date.now();if(error){v.runsError=ctx.errorText(error);return;}v.runs=Array.isArray(result?.data)?result.data:[];v.runsError='';});
}
function ensureMemory(bot,v,force=false){
  if(v.loading.memory||(!force&&v.memoryAt&&Date.now()-v.memoryAt<STALE))return;v.loading.memory=true;
  fetchInto(bot,v,'memory',`/api/bots/${enc(bot.id)}/memory`,(result,error)=>{v.loading.memory=false;v.memoryAt=Date.now();if(error){v.memoryError=ctx.errorText(error);return;}v.memory=Array.isArray(result?.entries)?result.entries:[];v.memoryError='';});
}
function ensureProposals(bot,v,force=false){
  if(v.loading.proposals||(!force&&v.proposalsAt&&Date.now()-v.proposalsAt<STALE))return;v.loading.proposals=true;
  fetchInto(bot,v,'proposals',`/api/bots/${enc(bot.id)}/proposals`,(result,error)=>{v.loading.proposals=false;v.proposalsAt=Date.now();if(error){v.proposalsError=ctx.errorText(error);return;}v.proposals=Array.isArray(result?.proposals)?result.proposals:[];v.proposalsError='';});
}
function ensureFiles(bot,v,folder,force=false){
  const entry=v.files.get(folder);if(entry?.loading||(!force&&entry?.at&&Date.now()-entry.at<STALE))return;
  v.files.set(folder,{...entry,loading:true});while(v.files.size>30)v.files.delete(v.files.keys().next().value);
  fetchInto(bot,v,`files:${folder}`,`/api/bots/${enc(bot.id)}/files?path=${enc(folder)}`,(result,error)=>v.files.set(folder,{at:Date.now(),list:error?entry?.list:(result?.files||[]),truncated:Boolean(result?.truncated),error:error?ctx.errorText(error):''}));
}
function ensureWorkspace(bot,v,force=false){
  if(v.loading.workspace||(!force&&v.workspaceAt&&Date.now()-v.workspaceAt<STALE))return;v.loading.workspace=true;
  fetchInto(bot,v,'workspace',`/api/bots/${enc(bot.id)}/workspace`,(result,error)=>{v.loading.workspace=false;v.workspaceAt=Date.now();v.workspaceError=error?ctx.errorText(error):'';if(!error)v.workspace={...result,folders:Array.isArray(result?.folders)?result.folders:[]};});
}
function ensureScripts(bot,v,force=false){
  if(v.loading.scripts||(!force&&v.scriptsAt&&Date.now()-v.scriptsAt<STALE))return;v.loading.scripts=true;
  fetchInto(bot,v,'scripts',`/api/bots/${enc(bot.id)}/scripts`,(result,error)=>{v.loading.scripts=false;v.scriptsAt=Date.now();v.scriptsError=error?ctx.errorText(error):'';if(error)return;v.scripts=Array.isArray(result?.scripts)?result.scripts:[];v.scriptsTruncated=Boolean(result?.truncated);if(v.scriptTarget&&!v.scripts.some(script=>script.id===v.scriptTarget)){v.scriptTarget='';v.script=null;}if(force&&v.scriptTarget)openScript(bot,v,v.scriptTarget);});
}
function openScript(bot,v,id){
  v.scriptTarget=id;v.script=null;v.scriptLoading=true;v.scriptError='';v.scriptNotice='';v.revealScript=true;
  if(showing(bot.id))refresh(bot.id);
  fetchInto(bot,v,'script',`/api/bots/${enc(bot.id)}/scripts/${enc(id)}`,(result,error)=>{v.scriptLoading=false;v.scriptError=error?ctx.errorText(error):'';if(!error)v.script=result;});
}
function openNote(bot,v,target,{quiet=false}={}){
  v.noteTarget=target;v.noteError='';if(!quiet){v.noteLoading=true;v.revealReader=true;if(showing(bot.id))refresh(bot.id);}
  fetchInto(bot,v,'note',`/api/bots/${enc(bot.id)}/brain/note?path=${enc(target)}`,(result,error)=>{
    v.noteLoading=false;v.noteAt=Date.now();
    if(error){v.noteError=error.status===404?`There’s no note called “${noteName(target)}” yet. It appears here once ${bot.name} writes it.`:ctx.errorText(error);if(!quiet){v.note=null;v.noteHTML='';}return;}
    v.note=result;v.noteTarget=result.path;v.noteHTML=noteHTML(result);
  });
}
function load(bot,v,force=false){
  if(v.tab==='overview'){ensureMemory(bot,v,force);ensureBrain(bot,v,force);ensureFiles(bot,v,'',force);ensureRuns(bot,v,force);ensureProposals(bot,v,force);}
  if(v.tab==='brain'){ensureBrain(bot,v,force);if(v.noteTarget&&!v.noteLoading&&(force||!v.note||Date.now()-v.noteAt>STALE))openNote(bot,v,v.noteTarget,{quiet:Boolean(v.note)});}
  if(v.tab==='memory')ensureMemory(bot,v,force);
  if(v.tab==='learning'){ensureProposals(bot,v,force);window.StudioStudyLearning?.mount(bot,studyContext(bot,v),document.querySelector('.bot-profile'));}
  if(v.tab==='files'){ensureFiles(bot,v,v.filesFolder,force);if(!v.filesFolder)ensureWorkspace(bot,v,force);}
  if(v.tab==='scripts')ensureScripts(bot,v,force);
  if(v.tab==='workshop')ensureWorkshop(bot,v,force);
}

/* Note bodies use the shared sanitized Markdown renderer; [[links]] and #tags in prose then become buttons built with DOM APIs. */
function noteHTML(note){
  const content=String(note.content||''),html=window.StudioRich?.render?window.StudioRich.render(content):`<pre class="bp-plain">${esc(content)}</pre>`;
  if(!document.createElement)return html;
  const resolved=new Map((note.links||[]).map(link=>[fold(link.target),link.path])),template=document.createElement('template');template.innerHTML=html;
  const walker=document.createTreeWalker(template.content,4),texts=[];
  while(walker.nextNode()){const node=walker.currentNode;if(/\[\[|#/.test(node.data)&&!node.parentElement?.closest('code,pre,a,button,[data-rich]'))texts.push(node);}
  for(const node of texts) {
    const text=node.data,fragment=document.createDocumentFragment();let last=0,changed=false;
    for(const match of text.matchAll(TOKEN)) {
      const [whole,bang,target,heading,label,space='',tag]=match;let element;
      if(target!==undefined) {
        const name=target.trim();if(!name)continue;
        if(bang&&/\.(?!md$)[a-z0-9]{1,5}$/i.test(name)){element=document.createElement('span');element.className='bp-embed';element.textContent=name;}
        else {
          const path=resolved.get(fold(name));element=document.createElement('button');element.type='button';element.className=`bp-wikilink${path?'':' is-missing'}`;
          element.dataset.profileAction='open-link';element.dataset.target=name;if(path)element.dataset.path=path;
          element.title=path?`Open ${path.replace(/\.md$/,'')}`:'Not written yet';element.textContent=(label||'').trim()||`${noteName(name)}${heading&&heading.length>1?` › ${heading.slice(1)}`:''}`;
        }
      } else {
        const clean=tag.replace(/\/+$/,'');if(!/\D/.test(clean))continue;
        element=document.createElement('button');element.type='button';element.className='bp-tagref';element.dataset.profileAction='tag';element.dataset.tag=clean.toLowerCase();element.textContent=`#${clean}`;
      }
      fragment.append(text.slice(last,match.index+space.length),element);last=match.index+whole.length;changed=true;
    }
    if(changed){fragment.append(text.slice(last));node.replaceWith(fragment);}
  }
  return template.innerHTML;
}
function factText(value){
  const text=String(value??'');let html='',last=0;
  for(const match of text.matchAll(WIKI)){const [whole,,target,,label]=match,name=target.trim();html+=esc(text.slice(last,match.index))+`<button type="button" class="bp-wikilink" data-profile-action="memory-link" data-target="${esc(name)}" title="Open ${esc(name)} in Brain">${esc((label||'').trim()||noteName(name))}</button>`;last=match.index+whole.length;}
  return html+esc(text.slice(last));
}

/* Page */
function render(context,botId){
  ctx=context;const bot=ctx.botById(botId);if(!bot)return '';
  const v=view(botId);v.tab=hashTab(botId)||'overview';capture(v);
  return `<section class="page bot-profile" data-profile-bot="${esc(bot.id)}"><button class="text-button bp-back" data-nav="/bots">${icon('back')}Bots</button>${hero(bot)}${tabs(bot,v)}<div class="bp-panel" id="bp-panel" role="tabpanel" aria-labelledby="bp-tab-${v.tab}">${panel(bot,v)}</div></section>`;
}
function mount(context,botId,root){
  ctx=context;watchDialogs();const bot=ctx.botById(botId),page=(root||document).querySelector('.bot-profile');
  if(!bot||page?.dataset.profileBot!==botId)return;
  const v=view(botId);after(page,v);load(bot,v);
}
function hero(bot){
  const intro=bot.description?esc(bot.description):'Here to help with your next task.';
  return `<header class="glass-card bp-hero"><div class="bp-hero-avatar">${ctx.avatar(bot,'large','profile-mascot')}</div><div class="bp-hero-text"><div class="bp-hero-name"><h1>${esc(bot.name)}</h1>${ctx.statusPill(bot)}</div><p class="bp-role">${esc(bot.title||'Your teammate')}</p><p class="bp-intro">${intro}</p></div><div class="bp-hero-actions"><button class="primary-button" data-nav="/bot/${esc(bot.id)}">${icon('chat')}Open chat</button><button class="secondary-button bp-configure" data-profile-action="tab" data-tab="settings" aria-label="Bot settings" title="Bot settings">${icon('sliders')}<span>Settings</span></button></div></header>`;
}
function tabs(bot,v){
  const counts={brain:v.brain?.total,memory:v.memory?.length,learning:v.proposals?.filter(item=>item.status==='pending').length,scripts:v.scripts?.length};
  return `<div class="bp-tabs" id="bp-tabs" role="tablist" aria-label="${esc(bot.name)} profile">${TABS.map(([key,label,ico])=>`<button class="segment${v.tab===key?' active':''}" role="tab" id="bp-tab-${key}" aria-selected="${v.tab===key}" aria-controls="bp-panel" tabindex="${v.tab===key?0:-1}" data-profile-action="tab" data-tab="${key}">${icon(ico)}${label}${counts[key]?`<span>${counts[key]}</span>`:''}</button>`).join('')}</div>`;
}
function panelContent(bot,v){return v.tab==='settings'?settingsPanel(bot,v):v.tab==='brain'?brainPanel(bot,v):v.tab==='memory'?memoryPanel(bot,v):v.tab==='learning'?learningPanel(bot,v):v.tab==='files'?filesPanel(bot,v):v.tab==='scripts'?scriptsPanel(bot,v):v.tab==='workshop'?workshopPanel(bot,v):overviewPanel(bot,v);}
const PANEL_INTRO={
  brain:['Brain','Linked notes about people, projects and what this bot has learned.'],
  memory:['Memory','Key facts and preferences this bot carries into its tasks.'],
  files:['Files','Documents, sources and outputs in this bot’s workspace.'],
  workshop:['Workshop','Isolated tools and improvements to review for product reuse.'],
  scripts:['Scripts','Reusable programs. Inspect a package before using it.'],
};
function panel(bot,v){
  const intro=PANEL_INTRO[v.tab];
  return `${intro?`<header class="bp-panel-heading"><h2>${intro[0]}</h2><p>${intro[1]}</p></header>`:''}${panelContent(bot,v)}`;
}
function settingsPanel(bot){return ctx.botSettingsForm?.(bot.id,{embedded:true})||'<p class="bp-muted">Bot settings are unavailable. Reload this page to try again.</p>';}

/* Overview */
// The activity log titles name the bot ("Atlas: completed"); on its own profile the sentence reads better without it.
const RUN_TEXT={completed:'Finished a task',failed:'Couldn’t finish a task',cancelled:'Stopped a task',interrupted:'A task was interrupted'};
function eventText(item,bot){
  const title=String(item.title||item.message||item.description||'Updated'),type=String(item.type||''),status=type.startsWith('run.')?type.slice(4):'';
  if(RUN_TEXT[status])return RUN_TEXT[status];
  if(type==='file.written'&&title.startsWith(`${bot.name}: `))return `Saved ${title.slice(bot.name.length+2)}`;
  if(title.startsWith(`${bot.name} `)){const rest=title.slice(bot.name.length+1).replace(/^was /,'');return rest.charAt(0).toUpperCase()+rest.slice(1);}
  return title;
}
// The engine keeps a short local history of finished tasks: what was asked, where, how it ended and what it cost.
const RUN_STATUS={completed:['Done','ok'],failed:['Failed','fail'],cancelled:['Stopped',''],interrupted:['Interrupted','fail'],unknown:['Unknown','fail']};
const RUN_SOURCE={chat:'Chat',routine:'Routine',room:'Team room',telegram:'Telegram',delegation:'For a teammate'};
function duration(ms){if(!Number.isFinite(ms))return '';const seconds=Math.round(ms/1000);return seconds<60?`${seconds}s`:seconds<3600?`${Math.round(seconds/60)} min`:`${(seconds/3600).toFixed(1)} h`;}
const CHECK_KIND={file_exists:'File exists',file_contains:'File content',file_sha256:'File version',command_success:'Command result',source_read:'Source read',teammate_completed:'Teammate result'};
const RECEIPT_TOOL={workspace_image:'Read image',web_search:'Search web',http_fetch:'Read web page',task_outcome_set:'Set result checks',task_outcome_check:'Check results',work_records_read:'Read earlier work',delegate_task:'Ask teammate'};
const shortValue=(value,max=200)=>String(value??'').slice(0,max);
function taskEvidence(item,v){
  const verification=item.verification,checks=Array.isArray(verification?.checks)?verification.checks.slice(0,12):[],records=Array.isArray(item.workRecords)?item.workRecords.slice(0,60):[];
  let label='';
  if(verification?.coverage==='declared_checks'&&checks.length){const failed=checks.filter(check=>check.passed===false).length,unverified=checks.some(check=>typeof check.passed!=='boolean');label=failed?`${plural(failed,'declared check')} failed`:unverified?'Some declared checks are unverified':`${plural(checks.length,'declared check')} passed`;}
  else if(verification?.coverage==='not_declared')label='No mechanical checks declared';
  const checked=label?`<small class="${verification?.passed===false?'bp-task-error':'bp-task-checks'}">${esc(label)}</small>`:'';
  const diagnostics=item.diagnostics,diagnosticRows=[];
  if(diagnostics?.context){const c=diagnostics.context;diagnosticRows.push(`${Number(c.tokens)||0} estimated context tokens${Number.isFinite(c.effective)?` of ${c.effective.toLocaleString()} available`:''}.`);}
  if(diagnostics?.memory){const m=diagnostics.memory;diagnosticRows.push(`Memory: ${Number(m.selected)||0} of ${Number(m.total)||0} facts selected; ${Number(m.omitted)||0} omitted. ${Number(m.refreshes)||0} recall passes.`);if(m.omittedPins?.length)diagnosticRows.push(`${m.omittedPins.length} pinned facts did not fit.`);if(m.truncated?.length)diagnosticRows.push(`${m.truncated.length} fact excerpts were shortened; full values remain in Memory.`);}
  if(diagnostics?.memoryReview){const m=diagnostics.memoryReview;diagnosticRows.push(`Memory review: ${m.status==='reviewed'?'checked':m.status==='capacity'?'suggestion limit reached':'unavailable'}; ${plural(Number(m.proposed)||0,'fact')} suggested for Learning.${m.guarded?' An unverified memory confirmation was corrected.':''}`);}
  if(diagnostics?.compaction){const c=diagnostics.compaction;diagnosticRows.push(`Summary coverage: ${c.coverage?.complete===true?'complete within the selected sources':'partial; read original sources for missing details'}. ${Number(c.coverage?.summaryCalls)||0} summary calls.`);if(c.coverage?.mergeFailed)diagnosticRows.push('Summary merge failed; the handoff retains partial coverage.');}
  const diagnosticHTML=diagnosticRows.length?`<p class="bp-task-body"><small><strong>Context and memory coverage</strong></small>${diagnosticRows.map(row=>`<small>${esc(row)}</small>`).join('')}</p>`:'';
  if(!checks.length&&!records.length&&!diagnosticRows.length)return checked;
  const checkRows=checks.map(check=>`<p class="bp-task-body"><small><strong>${esc(CHECK_KIND[check.kind]||'Declared check')} · ${check.passed===true?'Passed':check.passed===false?'Failed':'Not checked'}</strong></small><small>${esc(shortValue(check.detail||check.id,300))}</small></p>`).join('');
  const receiptRows=records.map(record=>{
    const status=record.outcome==='unknown'?'Outcome uncertain':record.status==='failed'?'Failed':record.status==='pending'?'Pending':record.status==='succeeded'?'Observed':'Not confirmed';
    const target=typeof record.path==='string'&&!record.path.startsWith('/')&&!/^[a-z]:|[\\\x00-\x1f]/i.test(record.path)&&record.path.split('/').every(part=>part&&part!=='.'&&part!=='..')?shortValue(record.path,240):'';
    const info=[target,Number.isInteger(record.exitCode)?`Exit ${record.exitCode}`:'',record.error?shortValue(record.error,300):''].filter(Boolean).join(' · ');
    return `<p class="bp-task-body"><small><strong>${esc(RECEIPT_TOOL[record.tool]||shortValue(record.tool,80).replace(/_/g,' '))} · ${status}</strong></small>${info?`<small>${esc(info)}</small>`:''}</p>`;
  }).join('');
  return `${checked}<details class="bp-proposal-more" data-task-evidence="${esc(item.id)}"${v.taskDetails.has(item.id)?' open':''}><summary>Checks and tool activity${records.length?` (${records.length})`:''}</summary><p class="bp-task-body"><small>Checks cover declared properties. Tool activity records observations; neither proves every part of the request was satisfied.</small></p>${diagnosticHTML}${checkRows}${receiptRows}</details>`;
}
function tasksCard(bot,v){
  const runs=(v.runs||[]).slice(0,6),tokens=usage=>(Number(usage?.input_tokens)||Number(usage?.prompt_tokens)||0)+(Number(usage?.output_tokens)||Number(usage?.completion_tokens)||0);
  const body=v.runs?runs.length?`<ul class="bp-tasks">${runs.map(item=>{const [label,tone]=RUN_STATUS[item.status]||[item.status||'Finished',''],used=tokens(item.usage);
    const meta=[RUN_SOURCE[item.source]||'Task',item.finishedAt?ctx.relative(item.finishedAt):'',duration(item.durationMs),used?`${used.toLocaleString()} tokens`:'',item.questions?plural(item.questions,'question'):''].filter(Boolean).join(' · ');
    return `<li><span class="bp-task-status ${tone}">${esc(label)}</span><div class="bp-task-body"><span class="bp-task-title">${esc(item.task||'Untitled task')}</span><small>${esc(meta)}</small>${taskEvidence(item,v)}${item.error&&item.status!=='completed'?`<small class="bp-task-error">${esc(item.error)}</small>`:''}</div></li>`;}).join('')}</ul>`:`<p class="bp-muted">No finished tasks recorded yet. Tasks finished on this engine appear here.</p>`:v.runsError?`<p class="bp-muted">${esc(v.runsError)}</p>`:'<p class="bp-muted">Loading…</p>';
  return `<section class="glass-card bp-card"><h2>${icon('clock')}Recent tasks</h2>${body}</section>`;
}
function overviewPanel(bot,v){
  const data=ctx.data||{},conn=(data.connections||[]).find(item=>item.id===bot.connectionId),model=bot.model||conn?.defaultModel||conn?.model||'';
  const run=data.runs?.[bot.id],events=(data.activity||[]).filter(item=>item.botId===bot.id),root=v.files.get('')?.list,visible=root?.filter(item=>!item.name.startsWith('.'));
  const last=[run?.updatedAt,events[0]?.createdAt||events[0]?.timestamp].filter(Boolean).sort().at(-1);
  const pinned=v.memory?.filter(entry=>entry.pinned).length||0,linkCount=v.brain?.notes.reduce((sum,note)=>sum+note.links.length,0)||0,newest=visible?.map(item=>item.updatedAt).filter(Boolean).sort().at(-1);
  const status=ctx.botStatus(bot),runWords={completed:'Finished its last task',failed:'Last task failed',cancelled:'Last task was stopped',interrupted:'Last task was interrupted'}[run?.status];
  const tile=(ico,label,value,detail,tab)=>`<${tab?`button type="button" data-profile-action="tab" data-tab="${tab}"`:'div'} class="glass-card bp-stat">${icon(ico)}<span>${label}</span><strong>${value}</strong><small>${detail}</small></${tab?'button':'div'}>`;
  const stats=`<div class="bp-stats">${tile('pin','Memory',v.memory?v.memory.length:'…',v.memory?(pinned?`${pinned} pinned`:'Core facts'):v.memoryError?'Unavailable':'Loading','memory')}${tile('brain','Notes',v.brain?v.brain.total:'…',v.brain?plural(linkCount,'link'):v.brainError?'Unavailable':'Loading','brain')}${tile('folder','Files',visible?visible.length:'…',visible?(newest?`Updated ${esc(ctx.relative(newest))}`:'In its workspace'):v.files.get('')?.error?'Unavailable':'Loading','files')}${tile('clock','Last active',last?esc(ctx.relative(last)):'Not yet',esc(status.className.startsWith('working')?status.text:runWords||'Start a conversation'))}</div>`;
  const row=(label,value)=>`<div class="bp-row"><dt>${label}</dt><dd>${value}</dd></div>`;
  const strict=bot.approvalPolicy==='strict',groups=groupsOf(bot),chips=items=>`<div class="bp-chips">${items.join('')}</div>`;
  const skills=(bot.skills||[]).map(id=>(data.skills||[]).find(skill=>skill.id===id)?.name||id),integrations=(bot.integrationIds||[]).map(id=>(data.integrations||[]).find(item=>item.id===id)?.name).filter(Boolean);
  const mates=ctx.botTeammates?ctx.botTeammates(bot):(bot.collaborators||[]).map(id=>ctx.botById(id)).filter(Boolean),rooms=(data.rooms||[]).filter(room=>(room.botIds||[]).includes(bot.id)),routines=(data.routines||[]).filter(item=>item.botId===bot.id);
  const every=minutes=>({60:'hourly',1440:'daily',10080:'weekly'})[minutes]||(minutes<60?`every ${minutes} min`:minutes%1440===0?`every ${minutes/1440} days`:`every ${Math.round(minutes/60)} h`);
  const setup=`<section class="glass-card bp-card"><h2>${icon('sliders')}How ${esc(bot.name)} works</h2><dl class="bp-rows">${row('Model',conn?`${esc(model||'Provider default')} <small>${bot.model?'Own choice':'Workspace default'}</small>`:'<span class="bp-muted">Choose a model provider in Settings</span>')}${conn?row('Provider',`${esc(conn.name)} <small>${esc(PROVIDERS[conn.type]||'Model provider')}</small>`):''}${row('Action review',`<strong>${strict?'Strict':'Balanced'}</strong><small class="bp-block">${strict?'Asks before every file change, command and outside action.':'Works freely in its own files. Asks before commands, deletions and outside actions.'}</small>`)}${bot.enabled===false?row('Status','<span class="bp-muted">Paused · it won’t take new tasks</span>'):''}</dl></section>`;
  const abilities=`<section class="glass-card bp-card"><h2>${icon('spark')}What it can use</h2>${chips(Object.keys(GROUPS).filter(key=>groups.includes(key)).map(key=>`<span class="bp-chip">${esc(GROUPS[key])}</span>`))||''}${groups.length?'':'<p class="bp-muted">No tools enabled. It can still chat.</p>'}<a class="text-button" href="#/skills/${esc(bot.id)}">${icon('spark')}Find skills</a>${skills.length?`<h3>Skills</h3>${chips(skills.map(name=>`<span class="bp-chip">${icon('spark')}${esc(name)}</span>`))}`:''}${integrations.length?`<h3>Integrations</h3>${chips(integrations.map(name=>`<span class="bp-chip">${icon('globe')}${esc(name)}</span>`))}`:''}</section>`;
  const team=mates.length||rooms.length||routines.length?`<section class="glass-card bp-card"><h2>${icon('team')}Team and routines</h2>${mates.length?`<h3>${bot.teamMode==='selected'?'Talks with selected teammates':'Talks with the whole team'}</h3><div class="bp-people">${mates.map(mate=>`<button class="bp-person" data-nav="/bots/${esc(mate.id)}">${ctx.avatar(mate,'tiny')}<span>${esc(mate.name)}</span></button>`).join('')}</div>`:''}${rooms.length?`<h3>Rooms</h3>${chips(rooms.map(room=>`<button class="bp-chip" data-nav="/room/${esc(room.id)}">${icon('team')}${esc(room.name||'Team room')}</button>`))}`:''}${routines.length?`<h3>Routines</h3><ul class="bp-plain-list">${routines.map(item=>`<li>${icon('routine')}<span>${esc(item.name||'Routine')}</span><small>${item.enabled===false?'Paused':esc(ctx.scheduleLabel?ctx.scheduleLabel(item):every(Number(item.intervalMinutes)||1440))}</small></li>`).join('')}</ul>`:''}</section>`:'';
  const activity=`<section class="glass-card bp-card"><h2>${icon('activity')}Recent activity</h2>${events.length?`<ul class="bp-events">${events.slice(0,6).map(item=>`<li>${icon(ACTIVITY[String(item.type||'').split('.')[0]]||'activity')}<span>${esc(eventText(item,bot))}</span><time>${esc(ctx.relative(item.createdAt||item.timestamp))}</time></li>`).join('')}</ul>`:`<p class="bp-muted">Nothing yet. When ${esc(bot.name)} gets to work, the important moments appear here.</p>`}</section>`;
  const controls=`<div class="bp-settings-actions"><button type="button" class="secondary-button" data-profile-action="tab" data-tab="settings">${icon('sliders')}Open settings</button></div>`;
  const waiting=v.proposals?.filter(item=>item.status==='pending').length,review=waiting?`<div class="bp-notice">${icon('spark')}<p>${esc(bot.name)} has ${plural(waiting,'suggestion')} for its memory and skills. Nothing changes until you accept.</p><button class="secondary-button" data-profile-action="tab" data-tab="learning">Review</button></div>`:'';
  return `<div class="bp-overview"><div class="bp-col bp-primary-column">${review}${stats}${tasksCard(bot,v)}${activity}</div><details class="pearl-advanced bp-settings-disclosure" data-profile-disclosure="settings"${v.settingsOpen?' open':''}><summary><span><strong>Configuration summary</strong><small>Model, permissions and teamwork</small></span>${icon('chevron')}</summary><div class="bp-advanced-content">${controls}${setup}${abilities}${team}</div></details></div>`;
}

/* Brain */
function matches(v,note){
  if(v.folder&&note.folder!==v.folder&&!note.folder.startsWith(`${v.folder}/`))return false;
  if(v.tag&&!note.tags.some(tag=>tag===v.tag||tag.startsWith(`${v.tag}/`)))return false;
  const words=fold(v.query).split(/\s+/).filter(Boolean);if(!words.length)return true;
  const haystack=fold(`${note.title} ${note.path} ${note.tags.join(' ')} ${note.type||''}`);return words.every(word=>haystack.includes(word));
}
const filtering=v=>Boolean(v.query.trim()||v.folder||v.tag);
function brainPanel(bot,v){
  const enabled=groupsOf(bot).includes('memory'),b=v.brain;
  const off=`<div class="bp-notice">${icon('info')}<p><strong>Notes are off for ${esc(bot.name)}.</strong> Turn on <em>Memory</em> in its settings to let it write and recall long-term notes.</p><button class="secondary-button" data-action="edit-bot" data-id="${esc(bot.id)}">${icon('edit')}Edit</button></div>`;
  if(!b)return v.brainError&&!v.loading.brain?retry(v.brainError,'retry'):loading('Opening notes…');
  if(!b.total)return enabled?empty('brain','No notes yet',`As ${esc(bot.name)} learns about people, projects and decisions, it writes linked Markdown notes here, and you’ll see them as a map of connected ideas. Try asking it to “start a note about our project”.`,`<button class="secondary-button" data-nav="/bot/${esc(bot.id)}">${icon('chat')}Open chat</button>`):empty('brain','Notes are off',`${esc(bot.name)} doesn’t keep long-term notes yet. Turn on <em>Memory</em> in its settings to give it a second brain of linked notes.`,`<button class="secondary-button" data-action="edit-bot" data-id="${esc(bot.id)}">${icon('edit')}Edit</button>`);
  const folders=new Map();for(const note of b.notes){const top=note.folder.split('/')[0];if(top)folders.set(top,(folders.get(top)||0)+1);}
  const notes=[];if(b.truncated||b.skipped)notes.push(`Some notes aren’t shown: the folder is past Tupies’s limits (${b.limits?.notes??2000} notes, 500 KB per note).`);if(b.linksTruncated)notes.push('Some links are left out of this view.');
  return `${enabled?'':off}<div class="bp-brain"><div class="bp-toolbar"><label class="bp-search">${icon('search')}<input type="search" data-profile-input="brain-query" value="${esc(v.query)}" placeholder="Search ${plural(b.total,'note')}" aria-label="Search notes" autocomplete="off"></label><select class="bp-select" data-profile-input="brain-folder" aria-label="Folder"><option value="">All folders</option>${[...folders].sort((x,y)=>x[0].localeCompare(y[0])).map(([name,count])=>`<option value="${esc(name)}"${v.folder===name?' selected':''}>${esc(name)} (${count})</option>`).join('')}</select></div><div class="bp-brain-body${v.noteTarget?' has-note':''}"><div class="bp-brain-main" id="bp-brain-results">${brainResults(bot,v)}</div><aside class="bp-reader-wrap" id="bp-reader" aria-label="Note">${v.noteTarget?reader(bot,v):summary(bot,v)}</aside></div>${notes.map(text=>`<p class="bp-limit">${esc(text)}</p>`).join('')}</div>`;
}
function brainResults(bot,v){
  const b=v.brain,list=b.notes.filter(note=>matches(v,note)),degree=note=>note.links.length+note.backlinks;
  const sorted=v.sort==='linked'?[...list].sort((x,y)=>degree(y)-degree(x)||x.title.localeCompare(y.title)):v.sort==='az'?[...list].sort((x,y)=>x.title.localeCompare(y.title)):list;
  const tags=(b.tags||[]).slice(0,12);if(v.tag&&!tags.some(item=>item.tag===v.tag))tags.unshift({tag:v.tag,notes:list.length});
  const row=note=>`<button class="bp-note-row${note.path===v.noteTarget?' active':''}" data-profile-action="open-note" data-path="${esc(note.path)}"><span class="bp-note-dot" style="--c:${colorOf(v,note.folder)}"></span><span class="bp-note-main"><strong>${esc(note.title)}</strong><small>${esc(note.folder||'Notes')} · ${esc(ctx.relative(note.updated))}</small></span><span class="bp-note-side">${note.tags.slice(0,2).map(tag=>`<span class="bp-hash">#${esc(tag)}</span>`).join('')}<span class="bp-links" title="${plural(note.links.length,'link')} out · ${plural(note.backlinks,'backlink')}">${icon('link')}${degree(note)}</span></span></button>`;
  return `${tags.length?`<div class="bp-chips bp-tag-filter" role="group" aria-label="Filter by tag">${tags.map(item=>`<button class="bp-chip${v.tag===item.tag?' active':''}" data-profile-action="tag" data-tag="${esc(item.tag)}" aria-pressed="${v.tag===item.tag}">#${esc(item.tag)}<small>${item.notes}</small></button>`).join('')}${filtering(v)?'<button class="text-button" data-profile-action="clear-filters">Clear</button>':''}</div>`:''}${mapDisclosure(v)}<div class="bp-list-head"><span>${filtering(v)?`${list.length} of ${plural(b.total,'note')}`:plural(b.total,'note')}</span><div class="segmented bp-sort" role="group" aria-label="Sort notes">${[['recent','Recent'],['linked','Most linked'],['az','A–Z']].map(([key,label])=>`<button class="segment${v.sort===key?' active':''}" data-profile-action="sort" data-sort="${key}" aria-pressed="${v.sort===key}">${label}</button>`).join('')}</div></div>${list.length?`<div class="bp-note-list" data-profile-scroll="notes">${sorted.slice(0,v.shown).map(row).join('')}${sorted.length>v.shown?`<button class="text-button bp-more" data-profile-action="more-notes">Show ${Math.min(LIST_PAGE,sorted.length-v.shown)} more</button>`:''}</div>`:`<p class="bp-muted bp-none">No notes match. <button class="text-button" data-profile-action="clear-filters">Clear filters</button></p>`}`;
}

/* A deterministic force layout of the most connected notes: spiral start, fixed iterations, then fitted to the frame. */
function layout(v){
  if(v.layout?.source===v.brain)return v.layout;
  const notes=v.brain.notes,degree=note=>note.links.length+note.backlinks;
  const picked=[...notes].sort((a,b)=>degree(b)-degree(a)||String(b.updated).localeCompare(String(a.updated))||(a.path<b.path?-1:1)).slice(0,GRAPH_NODES),index=new Map(picked.map((note,i)=>[note.path,i])),seen=new Set(),edges=[];
  for(const note of picked)for(const target of note.links){const i=index.get(note.path),j=index.get(target);if(j===undefined||i===j)continue;const key=i<j?`${i}:${j}`:`${j}:${i}`;if(!seen.has(key)){seen.add(key);edges.push([i,j]);}}
  const n=picked.length,pos=picked.map((_,i)=>{const angle=i*2.399963,radius=Math.sqrt((i+.5)/Math.max(n,1))*150;return {x:W/2+Math.cos(angle)*radius*1.5,y:H/2+Math.sin(angle)*radius*.8,dx:0,dy:0};});
  const k=Math.sqrt(W*H/Math.max(n,1))*.5;let heat=W/10;
  for(let step=0;n>1&&step<260;step++) {
    for(const p of pos){p.dx=(W/2-p.x)*.04;p.dy=(H/2-p.y)*.08;}
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const a=pos[i],b=pos[j],dx=a.x-b.x,dy=a.y-b.y,d=Math.max(Math.hypot(dx,dy),.5),f=k*k/d/d;a.dx+=dx*f;a.dy+=dy*f;b.dx-=dx*f;b.dy-=dy*f;}
    for(const [i,j] of edges){const a=pos[i],b=pos[j],dx=a.x-b.x,dy=a.y-b.y,d=Math.max(Math.hypot(dx,dy),.5),f=d/k;a.dx-=dx*f;a.dy-=dy*f;b.dx+=dx*f;b.dy+=dy*f;}
    for(const p of pos){const d=Math.hypot(p.dx,p.dy)||1,m=Math.min(d,heat);p.x+=p.dx/d*m;p.y+=p.dy/d*m;}
    heat=Math.max(heat*.975,.5);
  }
  const xs=pos.map(p=>p.x),ys=pos.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),pad=34;
  const fit=(value,min,max,size)=>max-min<1?size/2:pad+(value-min)/(max-min)*(size-2*pad);
  return v.layout={source:v.brain,edges,nodes:picked.map((note,i)=>({note,degree:degree(note),x:Math.round(fit(pos[i].x,minX,maxX,W)*10)/10,y:Math.round(fit(pos[i].y,minY,maxY,H)*10)/10}))};
}
function mapDisclosure(v){
  const open=v.mapOpen??!window.matchMedia?.('(max-width: 760px)').matches;
  return `<details class="bp-map" data-profile-disclosure="map"${open?' open':''}><summary>${icon('brain')}<span>Explore connections</span>${icon('chevron')}</summary>${graph(v)}</details>`;
}
function graph(v){
  const {nodes,edges}=layout(v),active=nodes.findIndex(node=>node.note.path===v.noteTarget),near=new Set(),dimmed=filtering(v);
  for(const [i,j] of edges){if(i===active)near.add(j);if(j===active)near.add(i);}
  const labelled=new Set([...nodes.map((_,i)=>i).sort((a,b)=>nodes[b].degree-nodes[a].degree).slice(0,8),...near,active]);
  const lit=nodes.map(node=>!dimmed||matches(v,node.note));
  const edgeHTML=edges.map(([i,j])=>`<line x1="${nodes[i].x}" y1="${nodes[i].y}" x2="${nodes[j].x}" y2="${nodes[j].y}" class="${i===active||j===active?'on':''}${lit[i]&&lit[j]?'':' is-dim'}"/>`).join('');
  const nodeHTML=nodes.map((node,i)=>{const r=Math.round((4+Math.min(8,Math.sqrt(node.degree)*2.2))*10)/10,title=node.note.title,label=title.length>18?`${title.slice(0,17)}…`:title;
    return `<g class="bp-node${i===active?' is-active':''}${near.has(i)?' is-near':''}${lit[i]?'':' is-dim'}" transform="translate(${node.x} ${node.y})" data-profile-action="open-note" data-path="${esc(node.note.path)}"><title>${esc(title)}</title><circle class="bp-hit" r="${r+7}"/><circle class="bp-dot" r="${r}" fill="${colorOf(v,node.note.folder)}"/>${labelled.has(i)?`<text y="${r+11}" text-anchor="middle">${esc(label)}</text>`:''}</g>`;}).join('');
  const total=v.brain.notes.length,caption=edges.length?`${total>nodes.length?`The ${nodes.length} most connected of ${plural(total,'note')}`:'How the notes connect'}${active<0&&v.noteTarget?' · this note isn’t in the map':''}`:'Notes connect when they link to each other with [[note name]].';
  return `<figure class="glass-card bp-graph-card"><svg class="bp-graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of ${plural(nodes.length,'linked note')}. The list below has every note.">${edgeHTML}${nodeHTML}</svg><figcaption><span>${esc(caption)}</span>${v.colors?.size?`<span class="bp-legend">${[...v.colors].slice(0,6).map(([name,color])=>`<span><i style="--c:${color}"></i>${esc(name)}</span>`).join('')}</span>`:''}</figcaption></figure>`;
}
function summary(bot,v){
  const b=v.brain,hubs=b.notes.filter(note=>note.backlinks).sort((x,y)=>y.backlinks-x.backlinks).slice(0,5),links=b.notes.reduce((sum,note)=>sum+note.links.length,0);
  const item=note=>`<button class="bp-mini" data-profile-action="open-note" data-path="${esc(note.path)}"><span class="bp-note-dot" style="--c:${colorOf(v,note.folder)}"></span><span>${esc(note.title)}</span><small>${esc(ctx.relative(note.updated))}</small></button>`;
  return `<div class="glass-card bp-reader bp-summary"><p class="eyebrow">Second brain</p><h2>${plural(b.total,'note')}, ${plural(links,'link')}</h2><p class="bp-muted">Pick a note on the map or in the list to read it. Links and backlinks lead to the next note.</p>${hubs.length?`<h3>Most linked</h3><div class="bp-mini-list">${hubs.map(item).join('')}</div>`:''}<h3>Recently updated</h3><div class="bp-mini-list">${b.notes.slice(0,5).map(item).join('')}</div>${b.unresolved?`<p class="bp-muted">${plural(b.unresolved,'link')} ${b.unresolved===1?'points':'point'} to notes that aren’t written yet.</p>`:''}<p class="bp-tip">${icon('book')}<span>Obsidian-compatible. Open the <code>workspaces/${esc(bot.id)}/brain</code> folder in your Tupies data directory as a vault to browse or edit these notes.</span></p></div>`;
}
function reader(bot,v){
  const note=v.note&&v.note.path===v.noteTarget?v.note:null,close=`<button class="icon-button" data-profile-action="close-note" aria-label="Close note" title="Close">${icon('close')}</button>`;
  if(!note)return `<article class="glass-card bp-reader"><div class="bp-reader-bar"><span class="bp-crumb">${esc(noteName(v.noteTarget))}</span>${close}</div>${v.noteError?`<p class="bp-muted">${esc(v.noteError)}</p>`:loading('Opening note…')}</article>`;
  const crumbs=note.folder?note.folder.split('/').map(part=>`<span>${esc(part)}</span>`).join(icon('chevron')):'<span>Notes</span>';
  const download=`/api/bots/${enc(bot.id)}/files/download?path=${enc(note.workspacePath||`brain/${note.path}`)}`;
  const outgoing=(note.links||[]).filter((link,i,all)=>all.findIndex(other=>(other.path||fold(other.target))===(link.path||fold(link.target)))===i);
  const linkChip=link=>link.path?`<button class="bp-chip" data-profile-action="open-note" data-path="${esc(link.path)}">${esc(titleOf(v,link.path))}</button>`:`<span class="bp-chip is-missing" title="Not written yet">${esc(link.target)}</span>`;
  return `<article class="glass-card bp-reader"><div class="bp-reader-bar"><span class="bp-crumb">${crumbs}</span><div class="bp-reader-tools"><button class="icon-button" data-profile-action="edit-note" aria-label="Edit note text" title="Edit text">${icon('edit')}</button><a class="icon-button" href="${esc(download)}" download aria-label="Download note" title="Download">${icon('download')}</a>${close}</div></div><h2>${esc(note.title)}</h2><div class="bp-reader-meta">${note.type?`<span class="bp-type">${esc(note.type)}</span>`:''}${(note.tags||[]).map(tag=>`<button class="bp-chip${v.tag===tag?' active':''}" data-profile-action="tag" data-tag="${esc(tag)}">#${esc(tag)}</button>`).join('')}</div><p class="bp-dates">${note.created?`Created ${esc(ctx.shortDate(note.created))} · `:''}Updated ${esc(ctx.relative(note.updated))}${note.aliases?.length?` · Also called ${esc(note.aliases.join(', '))}`:''}</p>${v.noteError?`<p class="bp-limit">${esc(v.noteError)}</p>`:''}<div class="bp-note-body rich-prose" data-profile-scroll="reader">${v.noteHTML||'<p class="bp-muted">This note is empty.</p>'}</div>${note.truncated?'<p class="bp-limit">This note is long, so only the beginning is shown. Download it to read everything.</p>':''}<div class="bp-reader-links"><section><h3>Links to</h3>${outgoing.length?`<div class="bp-chips">${outgoing.map(linkChip).join('')}</div>`:'<p class="bp-muted">No links yet.</p>'}</section><section><h3>Linked from</h3>${note.backlinks?.length?`<div class="bp-chips">${note.backlinks.map(path=>`<button class="bp-chip" data-profile-action="open-note" data-path="${esc(path)}">${esc(titleOf(v,path))}</button>`).join('')}</div>`:'<p class="bp-muted">No other note links here yet.</p>'}</section></div></article>`;
}

/* Memory */
function factProvenance(entry){
  const source=entry.provenance || {},label={'owner-edit':'Edited by you','owner-chat':'Saved from your conversation',reviewed:'Accepted after your review',unknown:'Source not recorded'}[source.kind] || 'Source not recorded';
  const at=Number.isFinite(Date.parse(source.observedAt))?new Date(source.observedAt).toLocaleDateString():'',ids=(Array.isArray(source.messageIds)?source.messageIds:[]).filter(id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(id)).slice(0,10);
  return `<details class="bp-proposal-more"><summary>Source and changes</summary><p class="bp-hint">${esc(label)}${at?` · ${esc(at)}`:''}. ${entry.supersedes?'Replaces an earlier revision. ':''}Source information records origin; it does not grant permission.</p>${ids.length?`<p class="bp-hint">Source messages: ${ids.map(id=>`<code>${esc(id)}</code>`).join(', ')}</p>`:''}</details>`;
}
function memoryPanel(bot,v){
  if(!v.memory)return v.memoryError&&!v.loading.memory?retry(v.memoryError,'retry'):loading('Opening memory…');
  const entries=[...v.memory].sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned))||String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))),pinned=entries.filter(entry=>entry.pinned).length;
  const off=groupsOf(bot).includes('memory')?'':`<div class="bp-notice">${icon('info')}<p>Memory tools are off, so ${esc(bot.name)} can’t change these facts itself. They’re still included in every task.</p></div>`;
  const working=busy(bot)?`<div class="bp-notice">${icon('clock')}<p>${esc(bot.name)} is working on a task. You can read its memory now and change it when the task finishes.</p></div>`:'';
  return `${off}${working}<div class="bp-toolbar"><label class="bp-search">${icon('search')}<input type="search" data-profile-input="memory-query" value="${esc(v.memoryQuery)}" placeholder="Search memory" aria-label="Search memory" autocomplete="off"></label><span class="bp-count">${plural(entries.length,'fact')} · ${pinned} of ${MAX_PINNED} pinned</span><button class="primary-button" data-profile-action="add-fact"${entries.length>=MAX_FACTS?' disabled':''}>${icon('plus')}Add a fact</button></div><p class="bp-hint">Short facts ${esc(bot.name)} keeps in every task. Pinned facts come first. Put longer knowledge in a note and link it with <code>[[note name]]</code>.</p><p class="bp-form-error" role="alert">${esc(v.memoryNotice)}</p>${v.adding?factForm(bot,v,null):''}<div class="bp-facts" id="bp-memory-list">${memoryList(bot,v,entries)}</div>`;
}
function memoryList(bot,v,entries=[...v.memory].sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned))||String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))){
  if(!entries.length)return empty('pin','A fresh memory',`Add a preference or a standing piece of context, or let ${esc(bot.name)} learn through its memory tools.`);
  const words=fold(v.memoryQuery).split(/\s+/).filter(Boolean),list=entries.filter(entry=>words.every(word=>fold(`${entry.key} ${entry.value}`).includes(word)));
  if(!list.length)return '<p class="bp-muted bp-none">No facts match your search.</p>';
  return list.map(entry=>v.editing===entry.id?factForm(bot,v,entry):`<article class="bp-fact${entry.pinned?' pinned':''}"><div class="bp-fact-head"><strong>${esc(entry.key)}</strong>${entry.pinned?`<span class="bp-pin-label">${icon('pin')}Pinned</span>`:''}<small>${esc(ctx.relative(entry.updatedAt))}</small></div><p>${factText(entry.value)}</p>${factProvenance(entry)}${v.confirming===entry.id?`<div class="bp-confirm"><span>Remove this fact from future tasks?</span><button class="secondary-button" data-profile-action="cancel-delete">Keep it</button><button class="danger-button" data-profile-action="confirm-delete" data-id="${esc(entry.id)}">Remove</button></div>`:`<div class="bp-fact-actions"><button class="icon-button${entry.pinned?' active':''}" data-profile-action="pin-fact" data-id="${esc(entry.id)}" aria-pressed="${Boolean(entry.pinned)}" aria-label="${entry.pinned?'Unpin':'Pin'} ${esc(entry.key)}" title="${entry.pinned?'Unpin':'Pin'}">${icon('pin')}</button><button class="icon-button" data-profile-action="edit-fact" data-id="${esc(entry.id)}" aria-label="Edit ${esc(entry.key)}" title="Edit">${icon('edit')}</button><button class="icon-button" data-profile-action="delete-fact" data-id="${esc(entry.id)}" aria-label="Remove ${esc(entry.key)}" title="Remove">${icon('trash')}</button></div>`}</article>`).join('');
}
function factForm(bot,v,entry){
  const draft=v.draft;
  return `<form class="glass-card bp-fact-form" data-profile-form="fact" data-id="${esc(entry?.id||'')}"><div class="field"><label for="bp-fact-key">What should ${esc(bot.name)} remember?</label><input id="bp-fact-key" name="key" data-profile-input="fact-key" maxlength="100" value="${esc(draft.key??entry?.key??'')}" placeholder="e.g. Writing preferences" required${entry?' readonly':''}></div><div class="field"><label for="bp-fact-value">Details</label><textarea id="bp-fact-value" name="value" data-profile-input="fact-value" maxlength="4000" placeholder="A useful fact or preference. Link a note with [[note name]]." required>${esc(draft.value??entry?.value??'')}</textarea></div><label class="bp-check"><input type="checkbox" name="pinned" data-profile-input="fact-pinned"${(draft.pinned??entry?.pinned)?' checked':''}><span>Pin this fact <small>Always included first. Up to ${MAX_PINNED}.</small></span></label><div class="bp-form-actions"><button type="button" class="secondary-button" data-profile-action="cancel-fact">Cancel</button><button type="submit" class="primary-button"${v.saving?' disabled':''}>${icon('check')}Save fact</button></div></form>`;
}
async function saveFact(bot,v,body,message){
  v.saving=true;v.memoryNotice='';
  try{const entry=await ctx.api(`/api/bots/${enc(bot.id)}/memory`,{method:'PUT',body});const list=v.memory||[],index=list.findIndex(item=>item.key===entry.key);if(index>=0)list[index]=entry;else list.push(entry);v.memory=list;v.memoryAt=Date.now();ctx.toast(message);return true;}
  catch(error){v.memoryNotice=friendly(bot,error);return false;}
  finally{v.saving=false;}
}

/* Learning: suggested memory and skill changes. The engine checks each one against the current memory or skill again on accept. */
const REVIEW_PROMPT='Look back over your conversations since your last review and suggest what is worth learning. List the messages from the last 24 hours with session_search (leave the query empty and set after), and read around anything important with session_read. Look for lasting facts, preferences and decisions; core-memory facts that are outdated or duplicated; and repeated workflows that a new skill, or a better version of one of your skills, would handle. Search existing Brain notes before proposing duplicate knowledge. If notes overlap or contradict each other, suggest a consolidation in your reply with the exact note paths and source messages; do not merge, edit or delete notes during this review. Suggest changes with memory_propose and skills_propose, citing the message IDs they come from. Do not change memory or skills directly: the owner reviews every suggestion. If nothing is worth changing, say so in one line.';
const PROPOSAL_STATUS={accepted:['Accepted','ok'],rejected:['Declined',''],stale:['Out of date','fail'],undone:['Undone','']};
const PROPOSAL_FROM={chat:'a chat with you',routine:'a routine',room:'a team room',telegram:'a Telegram chat',delegation:'a teammate’s request'};
function lineDiff(before,after){
  const a=String(before??'').split('\n'),b=String(after??'').split('\n'),rows=[];
  let start=0;while(start<a.length&&start<b.length&&a[start]===b[start])start++;
  let endA=a.length,endB=b.length;while(endA>start&&endB>start&&a[endA-1]===b[endB-1]){endA--;endB--;}
  const x=a.slice(start,endA),y=b.slice(start,endB);
  for(let i=0;i<start;i++)rows.push([' ',a[i]]);
  // Longest common subsequence over the changed middle; very large rewrites show as removed then added.
  if(x.length*y.length<=250000){
    const t=Array.from({length:x.length+1},()=>new Uint16Array(y.length+1));
    for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)t[i][j]=x[i]===y[j]?t[i+1][j+1]+1:Math.max(t[i+1][j],t[i][j+1]);
    let i=0,j=0;while(i<x.length&&j<y.length){if(x[i]===y[j]){rows.push([' ',x[i]]);i++;j++;}else if(t[i+1][j]>=t[i][j+1])rows.push(['-',x[i++]]);else rows.push(['+',y[j++]]);}
    while(i<x.length)rows.push(['-',x[i++]]);while(j<y.length)rows.push(['+',y[j++]]);
  } else {for(const line of x)rows.push(['-',line]);for(const line of y)rows.push(['+',line]);}
  for(let i=endA;i<a.length;i++)rows.push([' ',a[i]]);
  return rows;
}
function diffHTML(rows){
  const changed=rows.map(([kind])=>kind!==' '),keep=rows.map((_,i)=>changed.slice(Math.max(0,i-2),i+3).some(Boolean));
  let html='',skipped=0;const skip=()=>{if(skipped)html+=`<div class="bp-diff-skip">${plural(skipped,'unchanged line')}</div>`;skipped=0;};
  rows.forEach(([kind,line],index)=>{
    if(!keep[index]){skipped++;return;}skip();
    const type=kind==='+'?'add':kind==='-'?'del':'same';
    html+=`<div class="bp-diff-line is-${type}"><span class="bp-diff-mark" aria-hidden="true">${kind==='+'?'+':kind==='-'?'−':''}</span>${type==='same'?'':`<span class="bp-visually-hidden">${type==='add'?'Added':'Removed'}: </span>`}<code>${esc(line)||' '}</code></div>`;
  });
  skip();
  return `<div class="bp-diff" role="group" aria-label="Changes to SKILL.md">${html}</div>`;
}
function memoryChange(change){
  const {key,before,after}=change,kind=!before?'add':!after?'remove':'change',tag={add:'New',remove:'Remove',change:'Update'}[kind];
  const pin=before&&after&&Boolean(before.pinned)!==Boolean(after.pinned)?`<span class="bp-pin-label">${icon('pin')}${after.pinned?'Pin':'Unpin'}</span>`:after?.pinned?`<span class="bp-pin-label">${icon('pin')}Pinned</span>`:'';
  const body=kind==='add'?`<p class="bp-change-new">${factText(after.value)}</p>`:kind==='remove'?`<p class="bp-change-old"><del>${esc(before.value)}</del></p>`:before.value===after.value?`<p>${factText(after.value)}</p>`:`<p class="bp-change-old"><span class="bp-change-label">Now</span><del>${esc(before.value)}</del></p><p class="bp-change-new"><span class="bp-change-label">Becomes</span>${factText(after.value)}</p>`;
  return `<li class="bp-change is-${kind}"><div class="bp-change-head"><span class="bp-change-tag">${tag}</span><strong>${esc(key)}</strong>${pin}</div>${body}</li>`;
}
function proposalTitle(item){
  if(item.kind==='skill')return item.skill?.create?`New skill: ${item.skill.name}`:`Improve the ${item.skill?.name||'skill'} skill`;
  const changes=item.changes||[],one=changes[0];
  return changes.length===1?`${!one.before?'Remember':!one.after?'Forget':'Update'} “${one.key}”`:`Change ${plural(changes.length,'fact')}`;
}
function sourceLabel(bot,source){const from=String(source.from||'');return from==='bot'?bot.name:from==='owner'?'You':from==='routine'?'Routine task':from==='room'?'Team room':from==='telegram'?'Telegram user':from.startsWith('teammate:')?from.slice(9):'Message';}
function proposalCard(bot,v,item){
  const pending=item.status==='pending',memory=item.kind==='memory',skill=item.skill||{};
  const [label,tone]=PROPOSAL_STATUS[item.status]||[];
  const when=pending?`Suggested ${ctx.relative(item.createdAt)}`:`${item.status==='undone'?'Undone':label} ${ctx.relative(item.undoneAt||item.decidedAt||item.createdAt)}`;
  const meta=[when,PROPOSAL_FROM[item.source?.from]?`during ${PROPOSAL_FROM[item.source.from]}`:''].filter(Boolean).join(' · ');
  const change=memory?`<ul class="bp-changes">${(item.changes||[]).map(memoryChange).join('')}</ul>`:`${skill.create?`<p class="bp-proposal-desc">${esc(skill.description)}</p>`:''}${diffHTML(lineDiff(skill.before?.content||'',skill.after?.content||''))}`;
  const used=pending&&item.usedBy?.length?`<p class="bp-proposal-note">${icon('team')}<span>${esc(item.usedBy.map(other=>other.name).join(', '))} also ${item.usedBy.length===1?'uses':'use'} this skill. Accepting changes it for them too.</span></p>`:'';
  const sources=item.sources?.length?`<details class="bp-sources"><summary>Based on ${plural(item.sources.length,'message')}</summary><ul>${item.sources.map(source=>`<li><small>${esc(sourceLabel(bot,source))} · ${esc(source.where)} · ${esc(ctx.relative(source.createdAt))}</small><p>${esc(source.excerpt)}</p></li>`).join('')}</ul></details>`:'';
  const button=(decision,text,kind)=>`<button type="button" class="${kind}" data-profile-action="decide" data-decision="${decision}" data-id="${esc(item.id)}"${v.deciding?' disabled':''}>${text}</button>`;
  let actions='';
  if(pending)actions=item.current===false?`<p class="bp-proposal-stale">${icon('info')}<span>Out of date: the ${memory?'facts have':'skill has'} changed since ${esc(bot.name)} suggested this. Decline it, or ask ${esc(bot.name)} to suggest it again.</span></p><div class="bp-proposal-actions">${button('reject','Decline','secondary-button')}</div>`:`<div class="bp-proposal-actions">${button('reject','Decline','secondary-button')}${button('accept',`${icon('check')}Accept`,'primary-button')}</div>`;
  else if(item.status==='accepted')actions=v.confirmingUndo===item.id?`<div class="bp-confirm"><span>${skill.create?`Remove the ${esc(skill.name)} skill again?`:'Put back what was there before?'}</span><button class="secondary-button" data-profile-action="cancel-undo">Keep it</button>${button('undo','Undo','danger-button')}</div>`:item.undoable?`<div class="bp-proposal-actions">${button('undo','Undo','text-button')}</div>`:`<p class="bp-muted">Changed again since, so it can’t be undone here.</p>`;
  else if(item.status==='stale'&&item.staleReason)actions=`<p class="bp-muted">${esc(item.staleReason)}</p>`;
  const body=`${item.reason?`<p class="bp-proposal-reason">${esc(item.reason)}</p>`:''}${used}${change}${sources}`;
  return `<article class="bp-proposal${pending?'':' is-reviewed'}" data-proposal="${esc(item.id)}"><div class="bp-proposal-head"><span class="bp-chip">${icon(memory?'pin':'spark')}${memory?'Memory':'Skill'}</span><strong>${esc(proposalTitle(item))}</strong>${label?`<span class="bp-task-status ${tone}">${esc(label)}</span>`:''}</div><small class="bp-proposal-meta">${esc(meta)}</small>${pending?body:`<details class="bp-proposal-more"><summary>Show the change</summary>${body}</details>`}${actions}</article>`;
}
function reviewRoutine(bot){
  if(!groupsOf(bot).includes('memory'))return `<div class="bp-notice">${icon('info')}<p>Memory tools are off, so ${esc(bot.name)} can’t suggest memory updates. Turn on <em>Memory</em> in its settings.</p></div>`;
  const routine=(ctx.data?.routines||[]).find(item=>item.botId===bot.id&&/memory_propose/.test(item.prompt||''));
  if(routine)return `<div class="bp-notice">${icon('routine')}<p><strong>${esc(routine.name||'Review')}</strong> ${routine.enabled===false?'is paused.':`· ${esc(ctx.scheduleLabel?ctx.scheduleLabel(routine):'On a schedule')}`}</p><button class="secondary-button" data-action="edit-routine" data-id="${esc(routine.id)}">Edit</button></div>`;
  return `<div class="bp-notice">${icon('routine')}<p>Let ${esc(bot.name)} look back over each day and suggest what to remember. The home server runs the review.</p><button class="secondary-button" data-profile-action="setup-review">Set up a daily review</button></div>`;
}
function studyContext(bot,v){return {...ctx,studyChanged(kind){
  if(kind==='proposal'){v.proposalsAt=0;ensureProposals(bot,v,true);}
  if(kind==='knowledge'){v.brainAt=0;v.noteAt=0;ensureBrain(bot,v,true);}
  if(kind==='study')return ctx.refresh?.();
}};}
function learningPanel(bot,v){
  const study=window.StudioStudyLearning?.render(bot,studyContext(bot,v))||'';
  if(!v.proposals)return study+(v.proposalsError&&!v.loading.proposals?retry(v.proposalsError,'retry'):loading('Opening suggestions…'));
  const pending=v.proposals.filter(item=>item.status==='pending'),reviewed=v.proposals.filter(item=>item.status!=='pending');
  const working=busy(bot)&&pending.length?`<div class="bp-notice">${icon('clock')}<p>${esc(bot.name)} is working on a task. You can read its suggestions now and accept them when it finishes.</p></div>`:'';
  const list=pending.length?`<div class="bp-proposals">${pending.map(item=>proposalCard(bot,v,item)).join('')}</div>`:empty('spark','Nothing to review',`When ${esc(bot.name)} suggests a memory update or a skill change, it appears here for you to accept or decline.`);
  const history=reviewed.length?`<section class="bp-proposal-history"><h3>Reviewed</h3><div class="bp-proposals">${reviewed.map(item=>proposalCard(bot,v,item)).join('')}</div></section>`:'';
  return `${study}${working}<p class="bp-hint">With Memory tools on, ${esc(bot.name)} checks your chats for lasting facts and preferences and suggests them here. Suggestions change nothing until you accept. You can also review skill suggestions and undo accepted changes while nothing newer has changed them.</p>${reviewRoutine(bot)}<p class="bp-form-error" role="alert">${esc(v.proposalNotice)}</p>${list}${history}`;
}

/* Files */
function fileIcon(item){
  if(item.kind==='directory'||item.type==='directory')return item.name==='brain'?'brain':'folder';
  const ext=String(item.name).split('.').at(-1).toLowerCase();
  return /^(png|jpe?g|webp|gif|svg)$/.test(ext)?'image':/^(xlsx|csv|tsv)$/.test(ext)?'sheet':/^(pptx|key)$/.test(ext)?'slides':/^(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|sql|html?|css|json|ya?ml|toml)$/.test(ext)?'code':'file';
}
function workspaceCategories(bot,v){
  const folders=(v.workspace?.folders||[]).filter(folder=>typeof folder.path==='string'&&!folder.path.startsWith('.'));
  const symbols={brain:'brain',notes:'book',scripts:'code',projects:'folder',documents:'file',data:'sheet',outputs:'download',uploads:'upload'};
  const card=(folder)=>{
    const tab=folder.path==='brain'?'brain':folder.path==='scripts'?'scripts':'',blocked=folder.status==='blocked',missing=folder.status==='missing',disabled=blocked||(!tab&&missing),action=tab?'tab':'folder';
    return `<button type="button" class="glass-card bp-workspace-card${folder.path==='brain'?' is-brain':''}" data-profile-action="${action}" ${tab?`data-tab="${tab}"`:`data-path="${esc(folder.path)}"`}${disabled?' disabled':''}><span class="bp-workspace-symbol">${icon(symbols[folder.path]||'folder')}</span><span><strong>${esc(folder.label||folder.path)}</strong><small>${esc(folder.description||'Private workspace files.')}</small><span class="bp-folder-state${blocked?' is-blocked':''}">${blocked?'Path needs attention':missing?'Folder not created':'Ready'}</span></span>${icon('chevron')}</button>`;
  };
  const memory=`<button type="button" class="glass-card bp-workspace-card" data-profile-action="tab" data-tab="memory"><span class="bp-workspace-symbol">${icon('pin')}</span><span><strong>${esc(v.workspace?.memory?.label||'Memory')}</strong><small>Short facts and preferences kept in native memory.</small><span class="bp-folder-state">Core memory</span></span>${icon('chevron')}</button>`;
  const missing=folders.some(folder=>folder.status==='missing'),blocked=folders.some(folder=>folder.status==='blocked');
  return `<section class="bp-workspace"><div class="bp-section-heading"><div><h2>A place for everything</h2><p>Knowledge, working files and finished outputs, private to ${esc(bot.name)}.</p></div>${missing?`<button type="button" class="secondary-button" data-profile-action="initialize-workspace"${v.workspaceSaving||busy(bot)?' disabled':''}>${icon('plus')}${v.workspaceSaving?'Creating…':'Create default folders'}</button>`:''}</div><div class="bp-workspace-grid">${memory}${folders.map(card).join('')}</div>${v.loading.workspace&&!v.workspace?'<p class="bp-muted" role="status">Loading workspace folders…</p>':''}${v.workspaceError?`<p class="bp-limit" role="alert">${esc(v.workspaceError)} <button type="button" class="text-button" data-profile-action="retry-workspace">Try again</button></p>`:''}${v.workspaceNotice?`<p class="bp-muted" role="status">${esc(v.workspaceNotice)}</p>`:''}${blocked?'<p class="bp-limit">An existing file or link occupies a default folder path. Your files stay in place; inspect them below before changing anything.</p>':''}</section>`;
}
async function initializeWorkspace(bot,v){
  if(v.workspaceSaving)return;v.workspaceSaving=true;v.workspaceNotice='';refresh(bot.id);
  try{const result=await ctx.api(`/api/bots/${enc(bot.id)}/workspace`,{method:'POST',body:{}});if(Array.isArray(result?.folders)){v.workspace=result;v.workspaceAt=Date.now();v.workspaceError='';}else ensureWorkspace(bot,v,true);v.workspaceNotice='Default folders are ready. Existing files were kept in place.';ensureFiles(bot,v,'',true);ctx.toast('Workspace folders ready.');}
  catch(error){v.workspaceNotice=friendly(bot,error,'workspace folders');}
  finally{v.workspaceSaving=false;refresh(bot.id);}
}
function filesPanel(bot,v){
  const folder=v.filesFolder,entry=v.files.get(folder),parts=folder?folder.split('/'):[];
  const crumbs=`<nav class="bp-crumbs" aria-label="Folder">${[['','Workspace'],...parts.map((part,i)=>[parts.slice(0,i+1).join('/'),part])].map(([path,label],i,all)=>i===all.length-1?`<span aria-current="page">${esc(label)}</span>`:`<button class="text-button" data-profile-action="folder" data-path="${esc(path)}">${esc(label)}</button>${icon('chevron')}`).join('')}</nav>`;
  const tools=`<div class="bp-toolbar">${crumbs}<div class="bp-file-tools"><button class="secondary-button" data-profile-action="new-file">${icon('plus')}New file</button><input type="file" id="bp-upload" class="bp-file-input" multiple data-profile-upload="${esc(bot.id)}"${v.uploading?' disabled':''}><label class="secondary-button" for="bp-upload">${icon('upload')}${v.uploading?'Adding…':'Add files'}</label></div></div>`;
  const brainNote=folder==='brain'||folder.startsWith('brain/')?`<div class="bp-notice">${icon('brain')}<p>These are ${esc(bot.name)}’s long-term notes. The Brain tab shows them as linked, readable notes.</p><button class="secondary-button" data-profile-action="tab" data-tab="brain">Open Brain</button></div>`:'';
  const categories=!folder?workspaceCategories(bot,v):'';
  if(!entry?.list)return `${tools}${categories}${brainNote}${entry?.error&&!entry.loading?retry(entry.error,'retry'):loading('Opening files…')}`;
  const all=entry.list,visible=all.filter(item=>!item.name.startsWith('.')),managed=new Set(!folder?(v.workspace?.folders||[]).filter(item=>item.status==='ready').map(item=>item.path):[]),items=visible.filter(item=>!((item.kind||item.type)==='directory'&&managed.has(item.path||item.name))).sort((a,b)=>Number((b.kind||b.type)==='directory')-Number((a.kind||a.type)==='directory')||displayName(a).localeCompare(displayName(b))),hidden=all.length-visible.length;
  const row=item=>{
    const kind=item.kind||item.type,path=item.path||[folder,item.name].filter(Boolean).join('/'),when=item.updatedAt?ctx.relative(item.updatedAt):'',name=displayName(item);
    if(kind==='blocked-symlink')return `<div class="bp-file-row"><span class="bp-file is-blocked">${icon('lock')}<strong>${esc(name)}</strong><small>Link blocked for safety</small></span></div>`;
    if(kind==='directory'){
      if(!folder&&item.name==='brain')return `<div class="bp-file-row"><button class="bp-file is-brain" data-profile-action="tab" data-tab="brain">${icon('brain')}<span class="bp-file-name"><strong>brain</strong><small>Long-term notes · open in Brain</small></span><small>${esc(when)}</small>${icon('arrow')}</button><button class="text-button" data-profile-action="folder" data-path="brain">Browse files</button></div>`;
      return `<div class="bp-file-row"><button class="bp-file" data-profile-action="folder" data-path="${esc(path)}">${icon(fileIcon(item))}<span class="bp-file-name"><strong>${esc(name)}</strong><small>${!folder&&item.name==='uploads'?'Files you added':'Folder'}</small></span><small>${esc(when)}</small>${icon('chevron')}</button></div>`;
    }
    const download=`/api/bots/${enc(bot.id)}/files/download?path=${enc(path)}`,meta=`<span class="bp-file-name"><strong>${esc(name)}</strong><small>${esc(bytes(item.size))}</small></span><small>${esc(when)}</small>`;
    const opener=ctx.previewFormats?.test(path)||TEXT.test(path)?`<button class="bp-file" data-profile-action="open-file" data-path="${esc(path)}" title="${ctx.previewFormats?.test(path)?'Preview':'Open as text'}">${icon(fileIcon(item))}${meta}</button>`:`<a class="bp-file" href="${esc(download)}" download title="Download">${icon(fileIcon(item))}${meta}</a>`;
    return `<div class="bp-file-row">${opener}<a class="icon-button" href="${esc(download)}" download aria-label="Download ${esc(name)}" title="Download">${icon('download')}</a></div>`;
  };
  const list=items.length?`${!folder&&v.workspace?'<h3>Other workspace files</h3>':''}<div class="bp-files glass-card" data-profile-scroll="files">${items.map(row).join('')}</div>`:folder?empty('folder','This folder is empty','Nothing here yet.'):v.workspace?'<p class="bp-muted">Open a category to browse its files. Any other folders and files appear here.</p>':empty('folder','A clean workspace',`${esc(bot.name)}’s private workspace is empty. Add files here, or ask ${esc(bot.name)} to create documents for you.`);
  return `${tools}${categories}${brainNote}${entry.error?`<p class="bp-limit">${esc(entry.error)}</p>`:''}${list}${hidden||entry.truncated?`<p class="bp-limit">${hidden?`${plural(hidden,'hidden item')} not shown.`:''}${entry.truncated?' Only the first 500 items are listed.':''}</p>`:''}`;
}

/* Script packages are inspected here; execution stays in the normal task and approval flow. */
function scriptState(script){return script.status==='registered'?(script.runtimeAvailable===false?'Runtime unavailable':'Registered'):{draft:'Draft',changed:'Files changed',invalid:'Needs correction'}[script.status]||'Needs inspection';}
function scriptMetadata(value){
  if(value===null||value===undefined)return '';
  if(Array.isArray(value))return value.map(scriptMetadata).filter(Boolean).join(' · ');
  if(typeof value==='object')return Object.entries(value).map(([key,item])=>`${key}: ${scriptMetadata(item)}`).join('; ');
  return String(value);
}
function scriptConfig(label,value){
  if(value===undefined||value===null||(Array.isArray(value)&&!value.length)||(typeof value==='object'&&!Array.isArray(value)&&!Object.keys(value).length))return '';
  const rows=Array.isArray(value)?value:typeof value==='object'?Object.entries(value).map(([name,details])=>({name,details})):[value];
  return `<section class="bp-script-config"><h3>${label}</h3><ul>${rows.map(item=>`<li>${esc(scriptMetadata(item))}</li>`).join('')}</ul></section>`;
}
function scriptArguments(v,id){
  const source=v.scriptArgs.get(id)||'[]';let args;
  try{args=JSON.parse(source);}catch{throw new Error('Arguments must be a JSON array of strings, such as ["--input", "data/source.csv"].');}
  if(!Array.isArray(args)||args.length>30||args.some(item=>typeof item!=='string'||item.length>2000||item.includes('\0')))throw new Error('Use at most 30 literal string arguments, each up to 2000 characters.');
  return args;
}
function scriptDetail(bot,v){
  if(!v.scriptTarget)return `<section class="glass-card bp-script-detail bp-script-welcome">${icon('code')}<h2>Reusable work, with a clear purpose</h2><p>Select a script to inspect its files, inputs and outputs before using it.</p></section>`;
  if(v.scriptLoading)return `<section class="glass-card bp-script-detail">${loading('Inspecting script…')}</section>`;
  if(v.scriptError||!v.script)return `<section class="glass-card bp-script-detail">${retry(v.scriptError||'This script is unavailable.','retry-script')}</section>`;
  const script=v.script,tools=groupsOf(bot),allowed=tools.includes('terminal')&&tools.includes('workspace'),ready=script.status==='registered'&&script.runtimeAvailable===true&&/^[a-f0-9]{64}$/.test(script.digest||''),canUse=allowed&&ready;
  const files=Array.isArray(script.files)?script.files:[],title=script.title||script.id;
  return `<article class="glass-card bp-script-detail"><header><span class="bp-script-status${ready?' is-ready':''}">${esc(scriptState(script))}</span><h2>${esc(title)}</h2><p>${esc(script.purpose||'No purpose has been recorded for this script.')}</p></header><dl class="bp-rows"><div class="bp-row"><dt>Runtime</dt><dd>${esc(script.interpreter||'Not configured')}</dd></div><div class="bp-row"><dt>Entry point</dt><dd><code>${esc(script.entrypoint||'Not configured')}</code></dd></div></dl>${script.error?`<p class="bp-limit" role="alert">${esc(script.error)}</p>`:''}${!allowed?`<div class="bp-notice">${icon('shield')}<p>Running scripts requires Files and Terminal tools for ${esc(bot.name)}.</p><button class="secondary-button" data-action="edit-bot" data-id="${esc(bot.id)}">Bot settings</button></div>`:'<p class="bp-hint">Each execution uses the bot’s normal task, exact approval and Stop controls.</p>'}${scriptConfig('Dependencies',script.dependencies)}${scriptConfig('Inputs',script.inputs)}${scriptConfig('Outputs',script.outputs)}<section class="bp-script-config"><h3>Package files</h3>${files.length?`<ul class="bp-script-files">${files.map(file=>`<li><button type="button" class="text-button" data-profile-action="script-file" data-path="${esc(file.path)}">${icon('file')}<span>${esc(file.relativePath||file.path)}</span></button><small>${esc(bytes(file.size))}</small></li>`).join('')}</ul>`:'<p class="bp-muted">No verified file inventory is available.</p>'}</section><div class="field bp-script-arguments"><label for="bp-script-args">Arguments</label><textarea id="bp-script-args" data-profile-input="script-args" data-script-id="${esc(script.id)}" rows="3" spellcheck="false" maxlength="65000">${esc(v.scriptArgs.get(script.id)||'[]')}</textarea><small>A JSON array of literal strings. These values are reviewed with the exact script before execution.</small></div>${v.scriptNotice?`<p class="bp-form-error" role="alert">${esc(v.scriptNotice)}</p>`:''}<div class="bp-script-actions"><button type="button" class="primary-button" data-profile-action="script-chat"${canUse?'':' disabled'}>${icon('chat')}Use in chat</button><button type="button" class="secondary-button" data-profile-action="script-routine"${canUse?'':' disabled'}>${icon('routine')}Use in routine</button></div><details class="bp-script-version"><summary>Version details</summary><dl class="bp-rows"><div class="bp-row"><dt>Package digest</dt><dd><code>${esc(script.digest||'Not registered')}</code></dd></div><div class="bp-row"><dt>Manifest hash</dt><dd><code>${esc(script.manifestSha256||'Unavailable')}</code></dd></div></dl></details></article>`;
}
function ensureWorkshop(bot,v,force=false){
  if(v.loading.workshop||(!force&&v.workshopAt&&Date.now()-v.workshopAt<STALE))return;v.loading.workshop=true;
  fetchInto(bot,v,'workshop',`/api/bots/${enc(bot.id)}/workshop`,(result,error)=>{v.loading.workshop=false;v.workshopAt=Date.now();v.workshopError=error?ctx.errorText(error):'';if(!error)v.workshop=result;});
}
function workshopGrantPanel(bot,v){
  const grants=v.workshop?.grants||[];
  return `<section class="glass-card bp-workshop-card"><h2>Bounded API reads</h2><p>Task-scoped permissions issued from an exact chat approval. Request budgets are shared by the selected participants, not copied to each bot.</p><button type="button" class="secondary-button" data-profile-action="refresh-workshop-grants">Refresh grants</button>${grants.length?grants.map(grant=>`<div class="bp-workshop-grant"><h3>${esc(grant.tool)} · ${esc(grant.status)}</h3><p>${esc(grant.endpoint)}</p><p>${esc(grant.used)} / ${esc(grant.maxRequests)} requests reserved · Expires ${esc(grant.expiresAt)}</p><p>Participants: ${esc(grant.botIds.map(id=>(ctx.data?.bots||[]).find(item=>item.id===id)?.name||id).join(', '))}</p>${['active','blocked','exhausted'].includes(grant.status)?`<button type="button" class="secondary-button" data-profile-action="revoke-workshop-grant" data-id="${esc(grant.id)}">Revoke grant</button>`:''}</div>`).join(''):'<p>No bounded-read grants for this bot.</p>'}</section>`;
}
function workshopPanel(bot,v){
  if(!v.workshop)return v.workshopError?retry(v.workshopError,'retry'):loading('Opening workshop…');
  const active=bot.tools?.includes('workshop'),engineWorkshop=bot.tools?.includes('engine_workshop'),tools=v.workshop.tools||[],items=v.workshop.items||[];
  return `<p class="bp-hint">${active?'This bot can build and test local tools in isolation.':'Enable Tool workshop in this bot’s Settings to let it build and test local tools.'} Tools receive only supplied data. They cannot access the network, system files or credentials.</p><p class="bp-hint">${engineWorkshop?'Engine workshop is enabled: this bot can inspect allowlisted product source and prepare isolated candidates.':'Enable Engine workshop separately in Settings to let this bot prepare product source changes.'} Candidates never modify the running Engine. Syntax and pure-function checks do not replace a full build and regression suite.</p><section class="glass-card bp-workshop-card"><h2>Local tools</h2>${tools.length?tools.map(tool=>`<p><strong>${esc(tool.title||'Invalid package')}</strong> — ${esc(tool.description||tool.status)}</p>`).join(''):'<p>No tools yet. Ask the bot to build a reusable data transformation.</p>'}<p class="bp-hint">${esc(v.workshop.catalog?.length||0)} shared catalog tools available to the bot.</p></section><section class="glass-card bp-workshop-card"><h2>Product improvements</h2><p>Proposals stay on this engine. Review code and test fixtures for private data before exporting a package to share with the product maintainer.</p>${items.length?items.map(item=>`<p><strong>${esc(item.title||'Invalid proposal')}</strong> · ${esc(item.kind||item.status)}<br>${esc(item.summary||'')}<br>${item.checks?`<span>${esc(item.checks.syntax)} syntax checks · ${esc(item.checks.tests)} pure-function tests · Full Engine suite not run</span><br>`:''}<button class="secondary-button" data-profile-action="review-improvement" data-id="${esc(item.digest)}">Review proposal</button></p>`).join(''):'<p>No proposals yet. The bot can save a useful tool or an Engine patch here.</p>'}</section>${workshopGrantPanel(bot,v)}${v.improvement?`<section class="glass-card bp-workshop-card"><h2>Review source and fixtures</h2><p>Export includes the complete source below. No automatic upload or installation.</p><pre class="bp-workshop-source">${esc(JSON.stringify(v.improvement.proposal,null,2))}</pre><button class="primary-button" data-profile-action="export-improvement" data-id="${esc(v.improvement.digest)}">Export reviewed source</button></section>`:''}${v.workshopError?`<p role="alert">${esc(v.workshopError)}</p>`:''}`;
}
function scriptsPanel(bot,v){
  if(!v.scripts)return v.scriptsError&&!v.loading.scripts?retry(v.scriptsError,'retry'):loading('Opening scripts…');
  const query=fold(v.scriptQuery),items=v.scripts.filter(script=>!query||fold(`${script.title||script.id} ${script.purpose||''} ${script.interpreter||''}`).includes(query));
  const tools=`<div class="bp-toolbar"><label class="bp-search">${icon('search')}<input type="search" data-profile-input="script-query" value="${esc(v.scriptQuery)}" placeholder="Search scripts" aria-label="Search scripts" autocomplete="off"></label><button type="button" class="secondary-button" data-profile-action="script-folder">${icon('folder')}Browse script files</button></div>`;
  if(!v.scripts.length)return `${tools}${empty('code','No scripts yet','Scripts saved for this bot appear here with their purpose, files, inputs and outputs. Open the scripts folder to inspect or add a package.')}<p class="bp-hint">Adding files does not execute them or enable Terminal tools.</p>`;
  const rows=items.map(script=>`<button type="button" class="bp-script-row${v.scriptTarget===script.id?' active':''}" data-profile-action="inspect-script" data-id="${esc(script.id)}" aria-pressed="${v.scriptTarget===script.id}"><span class="bp-script-symbol">${icon('code')}</span><span><strong>${esc(script.title||script.id)}</strong><small>${esc(script.purpose||'Purpose not recorded')}</small><span class="bp-script-status">${esc(scriptState(script))}</span></span>${icon('chevron')}</button>`).join('');
  return `${tools}${v.scriptsError?`<p class="bp-limit" role="alert">${esc(v.scriptsError)}</p>`:''}<div class="bp-scripts-layout"><div class="glass-card bp-script-list" aria-label="Script catalog">${rows||'<p class="bp-muted">No scripts match this search.</p>'}</div>${scriptDetail(bot,v)}</div>${v.scriptsTruncated?'<p class="bp-limit">This catalog is bounded. Browse the scripts folder for additional packages.</p>':''}`;
}
async function upload(bot,v,input){
  const files=[...input.files];input.value='';
  if(files.length>5||files.reduce((sum,file)=>sum+file.size,0)>20_000_000)throw new Error('Choose up to 5 files with a combined size below 20 MB.');
  const read=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(new Error(`Could not read ${file.name}.`));reader.readAsDataURL(file);});
  v.uploading=true;refresh(bot.id);
  try{const payload=await Promise.all(files.map(async file=>({name:file.name,contentBase64:await read(file)})));await ctx.api(`/api/bots/${enc(bot.id)}/attachments`,{method:'POST',body:{files:payload}});ctx.toast(`${plural(files.length,'file')} added to uploads.`);v.filesFolder='uploads';ensureFiles(bot,v,'',true);ensureFiles(bot,v,'uploads',true);}
  catch(error){ctx.toast(friendly(bot,error,'files'),true);}
  finally{v.uploading=false;refresh(bot.id);}
}

/* Rendering in place: keep focus, caret and inner scroll across app.js re-renders and data refreshes. */
function capture(v){
  const page=document.querySelector('.bot-profile');if(page?.dataset.profileBot!==v.id)return;
  const form=page.querySelector('#bot-form[data-embedded]');
  if(form?.dataset.settingsDirty==='true')v.settingsDraft={fields:[...form.elements].filter(element=>element.name).map(element=>({name:element.name,type:element.type,value:element.value,checked:element.checked})),error:form.querySelector('.form-error')?.textContent||'',disclosures:[...form.querySelectorAll('details')].map(element=>element.open)};
  const settings=page.querySelector('[data-profile-disclosure="settings"]');if(settings)v.settingsOpen=settings.open;
  const map=page.querySelector('[data-profile-disclosure="map"]');if(map)v.mapOpen=map.open;
  v.taskDetails=new Set([...page.querySelectorAll('details[data-task-evidence]')].filter(element=>element.open).map(element=>element.dataset.taskEvidence));
  const active=document.activeElement;
  v.tabScroll=page.querySelector('#bp-tabs')?.scrollLeft||0;
  if(active?.matches?.('#bp-tabs [role=tab]'))v.focus={tab:active.dataset.tab};
  else if(form?.contains(active)&&active.name)v.focus={settings:true,name:active.name,value:active.value,start:active.selectionStart,end:active.selectionEnd};
  else if(page.contains(active)&&active.dataset?.profileInput)v.focus={key:active.dataset.profileInput,start:active.selectionStart,end:active.selectionEnd};
  else if(active?.matches?.('[data-profile-disclosure] > summary'))v.focus={disclosure:active.parentElement.dataset.profileDisclosure};
  for(const element of page.querySelectorAll('[data-profile-scroll]'))v.scroll[element.dataset.profileScroll]=element.scrollTop;
}
function after(root,v){
  const rail=root.querySelector('#bp-tabs');
  if(rail){
    rail.scrollLeft=v.tabScroll||0;
    if(v.visibleTab!==v.tab||v.tabWidth!==rail.clientWidth){
      const selected=rail.querySelector('[aria-selected=true]'),outer=rail.getBoundingClientRect(),inner=selected?.getBoundingClientRect();
      if(inner&&outer.width){
        if(inner.left<outer.left+8)rail.scrollLeft-=outer.left+8-inner.left;
        else if(inner.right>outer.right-8)rail.scrollLeft+=inner.right-outer.right+8;
      }
      v.visibleTab=v.tab;v.tabWidth=rail.clientWidth;v.tabScroll=rail.scrollLeft;
    }
  }
  if(v.tab==='learning'){const bot=ctx?.botById(v.id);if(bot)window.StudioStudyLearning?.mount(bot,studyContext(bot,v),root);}
  const form=root.querySelector('#bot-form[data-embedded]');
  if(form&&v.settingsDraft){
    for(const field of v.settingsDraft.fields){const element=[...form.elements].find(element=>element.name===field.name&&element.type===field.type&&(!['checkbox','radio'].includes(field.type)||element.value===field.value));if(!element)continue;if(['checkbox','radio'].includes(field.type))element.checked=field.checked;else element.value=field.value;}
    [...form.querySelectorAll('details')].forEach((element,index)=>{element.open=v.settingsDraft.disclosures[index]||false;});
    form.dataset.settingsDirty='true';form.querySelector('.form-error').textContent=v.settingsDraft.error;
    form.querySelector('[data-settings-status]').textContent='Unsaved changes';
    const bot=ctx.botById(v.id),preview=form.querySelector('#bot-avatar-preview');if(preview)preview.innerHTML=ctx.avatar({...bot,icon:form.elements.icon.value,color:form.elements.color.value},'large');
    for(const button of form.querySelectorAll('.companion-choice'))button.setAttribute('aria-pressed',String(`companion:${button.dataset.variant}`===form.elements.icon.value));
    const team=form.querySelector('.team-checklist');if(team)team.hidden=form.elements.teamMode.value!=='selected';
  }
  for(const element of root.querySelectorAll('[data-profile-scroll]')){const top=v.scroll[element.dataset.profileScroll];if(top)element.scrollTop=top;}
  if(v.focus){const element=v.focus.tab?root.querySelector(`#bp-tab-${v.focus.tab}`):v.focus.settings?[...(form?.elements||[])].find(element=>element.name===v.focus.name&&(!['checkbox','radio'].includes(element.type)||element.value===v.focus.value)):v.focus.disclosure?root.querySelector(`[data-profile-disclosure="${v.focus.disclosure}"] > summary`):root.querySelector(`[data-profile-input="${v.focus.key}"]`);if(element&&document.activeElement!==element){element.focus({preventScroll:true});try{if(typeof v.focus.start==='number')element.setSelectionRange(v.focus.start,v.focus.end);}catch{}}v.focus=null;}
  const body=root.querySelector('.bp-note-body');if(body&&window.StudioRich?.hydrate)window.StudioRich.hydrate(body).catch(()=>{});
  const map=root.querySelector('.bp-graph');if(map&&!v.graphShown){v.graphShown=true;map.classList.add('bp-graph-enter');}
  if(v.revealReader&&!v.noteLoading){v.revealReader=false;const reader=root.querySelector('#bp-reader');if(reader&&window.matchMedia?.('(max-width: 1100px)').matches)reader.scrollIntoView?.({block:'start'});}
  if(v.revealScript&&!v.scriptLoading){v.revealScript=false;if(window.matchMedia?.('(max-width: 900px)').matches)root.querySelector('.bp-script-detail')?.scrollIntoView?.({block:'start'});}
}
function refresh(botId){
  const page=document.querySelector('.bot-profile'),bot=ctx&&page?.dataset.profileBot===botId?ctx.botById(botId):null;if(!bot)return;
  const v=view(botId),panelNode=page.querySelector('#bp-panel');capture(v);
  page.querySelector('#bp-tabs')?.replaceWith(Object.assign(document.createElement('template'),{innerHTML:tabs(bot,v)}).content);
  if(panelNode){panelNode.setAttribute('aria-labelledby',`bp-tab-${v.tab}`);if(!(v.tab==='settings'&&panelNode.querySelector('#bot-form[data-embedded]')))panelNode.innerHTML=panel(bot,v);}
  after(page,v);
}
function patch(bot,v,selector,renderHTML){const page=document.querySelector('.bot-profile'),target=page?.querySelector(selector);if(!target)return refresh(bot.id);capture(v);target.innerHTML=renderHTML();after(page,v);}
function setTab(bot,v,tab,focus=false){
  if(!TABS.some(([key])=>key===tab))return;v.tab=tab;
  const hash=`#/bots/${bot.id}${tab==='overview'?'':`/${tab}`}`;if(location.hash!==hash)history.replaceState(history.state,'',hash);
  refresh(bot.id);load(bot,v);
  if(focus)document.getElementById(`bp-tab-${tab}`)?.focus({preventScroll:true});
}
function watchDialogs(){
  const root=document.getElementById('dialog-root');if(!root||root.__profileWatch||typeof MutationObserver==='undefined')return;root.__profileWatch=true;
  // Editors and previews are app.js dialogs; reload what they may have changed once the last dialog closes.
  new MutationObserver(()=>{
    if(root.querySelector('dialog'))return;const page=document.querySelector('.bot-profile'),bot=page&&ctx?.botById(page.dataset.profileBot);if(!bot)return;
    const v=view(bot.id);if(!v.dirty)return;v.dirty=false;load(bot,v,true);
  }).observe(root,{childList:true});
}

/* Events: one listener per kind, installed once; app.js ignores elements without data-action or data-nav. */
async function act(element){
  const page=element.closest('.bot-profile'),bot=page&&ctx?.botById(page.dataset.profileBot);if(!bot)return;
  const v=view(bot.id),action=element.dataset.profileAction,id=element.dataset.id,fact=id&&v.memory?.find(entry=>entry.id===id);
  switch(action){
    case 'tab':setTab(bot,v,element.dataset.tab,element.getAttribute('role')==='tab');break;
    case 'settings-section':{const heading=page.querySelector(`#bot-section-${element.dataset.section}`);heading?.scrollIntoView?.({block:'start',behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});heading?.focus({preventScroll:true});break;}
    case 'discard-settings':settingsSaved(bot.id);page.querySelector('#bp-panel').innerHTML=settingsPanel(bot,v);break;
    case 'retry':load(bot,v,true);refresh(bot.id);break;
    case 'retry-workspace':ensureWorkspace(bot,v,true);refresh(bot.id);break;
    case 'initialize-workspace':await initializeWorkspace(bot,v);break;
    case 'refresh-workshop-grants':ensureWorkshop(bot,v,true);break;
    case 'revoke-workshop-grant':await ctx.api(`/api/bots/${enc(bot.id)}/workshop-grants/${enc(id)}/revoke`,{method:'POST',body:{}});ensureWorkshop(bot,v,true);break;
    case 'review-improvement':v.improvement=await ctx.api(`/api/bots/${enc(bot.id)}/improvements/${enc(id)}`);refresh(bot.id);break;
    case 'export-improvement':{
      if(v.improvement?.digest!==id)break;
      const result=await ctx.api(`/api/bots/${enc(bot.id)}/improvements/${enc(id)}`,{method:'POST',body:{digest:id,reviewedDigest:id,includeSource:true}});
      const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)+'\n'],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download=`tupies-contribution-${id.slice(0,12)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);break;
    }
    case 'inspect-script':openScript(bot,v,id);break;
    case 'retry-script':if(v.scriptTarget)openScript(bot,v,v.scriptTarget);break;
    case 'script-file':v.dirty=true;await ctx.fileEditor(bot.id,element.dataset.path);break;
    case 'script-folder':{
      if(!v.workspace)try{const result=await ctx.api(`/api/bots/${enc(bot.id)}/workspace`);v.workspace={...result,folders:Array.isArray(result?.folders)?result.folders:[]};v.workspaceAt=Date.now();v.workspaceError='';}catch{}
      v.filesFolder=v.workspace?.folders?.some(folder=>folder.path==='scripts'&&folder.status==='ready')?'scripts':'';setTab(bot,v,'files');break;}
    case 'script-chat':case 'script-routine':{
      const script=v.script;if(!script||script.status!=='registered'||script.runtimeAvailable!==true||!groupsOf(bot).includes('workspace')||!groupsOf(bot).includes('terminal'))break;
      const field=document.getElementById('bp-script-args');if(field)v.scriptArgs.set(script.id,field.value);
      try{
        const args=scriptArguments(v,script.id),request={scriptId:script.id,digest:script.digest,args,timeoutMs:120000};v.scriptNotice='';
        if(action==='script-chat'){
          const text=`Run the registered script ${JSON.stringify(script.title||script.id)} with scripts_run using these exact values:\n\n${JSON.stringify(request,null,2)}\n\nInspect the script and follow the normal approval and verification steps. Keep the actual result and any created files in this task.`;
          if(!ctx.openBotDraft)throw new Error('Chat drafts are unavailable. Reload Tupies and try again.');ctx.openBotDraft(bot.id,text);
        }else{
          if(!ctx.routineDialog)throw new Error('Routine setup is unavailable. Reload Tupies and try again.');
          ctx.routineDialog(undefined,bot.id,{name:String(script.title||script.id).slice(0,100),prompt:`Use the result of ${script.title||script.id}. ${script.purpose||'Report the actual outcome and any verified output files.'}`,enabled:false,workflow:{version:1,mode:'agent',steps:[{id:'script',op:'script',...request}],context:'Use this verified script result as task data: {{script}}',report:'{{script}}'}});
        }
      }catch(error){v.scriptNotice=ctx.errorText(error);refresh(bot.id);}
      break;}
    case 'open-note':if(v.tab!=='brain')setTab(bot,v,'brain');openNote(bot,v,element.dataset.path);break;
    case 'open-link':openNote(bot,v,element.dataset.path||element.dataset.target);break;
    case 'memory-link':v.noteTarget='';setTab(bot,v,'brain');openNote(bot,v,element.dataset.target);break;
    case 'close-note':v.tickets.note=(v.tickets.note||0)+1;v.noteTarget='';v.note=null;v.noteHTML='';v.noteError='';v.noteLoading=false;refresh(bot.id);break;
    case 'tag':{const tag=element.dataset.tag;v.tag=v.tag===tag?'':tag;v.shown=LIST_PAGE;if(v.tab!=='brain')setTab(bot,v,'brain');else patch(bot,v,'#bp-brain-results',()=>brainResults(bot,v));break;}
    case 'clear-filters':v.query='';v.folder='';v.tag='';v.shown=LIST_PAGE;refresh(bot.id);break;
    case 'sort':v.sort=element.dataset.sort;patch(bot,v,'#bp-brain-results',()=>brainResults(bot,v));break;
    case 'more-notes':v.shown+=LIST_PAGE;patch(bot,v,'#bp-brain-results',()=>brainResults(bot,v));break;
    case 'edit-note':if(v.note){v.dirty=true;await ctx.fileEditor(bot.id,v.note.workspacePath||`brain/${v.note.path}`);}break;
    case 'add-fact':v.adding=true;v.editing='';v.confirming='';v.draft={};v.memoryNotice='';refresh(bot.id);document.getElementById('bp-fact-key')?.focus();break;
    case 'edit-fact':if(fact){v.editing=fact.id;v.adding=false;v.confirming='';v.draft={};v.memoryNotice='';refresh(bot.id);document.getElementById('bp-fact-value')?.focus();}break;
    case 'cancel-fact':v.adding=false;v.editing='';v.draft={};v.memoryNotice='';refresh(bot.id);break;
    case 'pin-fact':if(fact&&!v.saving){element.disabled=true;await saveFact(bot,v,{key:fact.key,value:fact.value,pinned:!fact.pinned},fact.pinned?'Fact unpinned.':'Fact pinned.');refresh(bot.id);}break;
    case 'delete-fact':v.confirming=id;refresh(bot.id);break;
    case 'cancel-delete':v.confirming='';refresh(bot.id);break;
    case 'confirm-delete':{if(v.saving)break;v.saving=true;element.disabled=true;v.memoryNotice='';
      try{await ctx.api(`/api/bots/${enc(bot.id)}/memory/${enc(id)}`,{method:'DELETE',body:{}});v.memory=(v.memory||[]).filter(entry=>entry.id!==id);v.memoryAt=Date.now();ctx.toast('Fact removed.');}
      catch(error){v.memoryNotice=friendly(bot,error);}finally{v.saving=false;v.confirming='';refresh(bot.id);}break;}
    case 'folder':v.filesFolder=element.dataset.path||'';ensureFiles(bot,v,v.filesFolder);if(!v.filesFolder)ensureWorkspace(bot,v);refresh(bot.id);break;
    case 'open-file':{const path=element.dataset.path;v.dirty=true;if(ctx.previewFormats?.test(path))await ctx.documentPreview(bot.id,path);else await ctx.fileEditor(bot.id,path);break;}
    case 'new-file':v.dirty=true;await ctx.fileEditor(bot.id,v.filesFolder,true);break;
    case 'decide':{
      const decision=element.dataset.decision,item=v.proposals?.find(entry=>entry.id===id);if(v.deciding||!item)break;
      if(decision==='undo'&&v.confirmingUndo!==id){v.confirmingUndo=id;refresh(bot.id);break;}
      v.deciding=id;v.proposalNotice='';element.disabled=true;
      try{
        await ctx.api(`/api/bots/${enc(bot.id)}/proposals/${enc(id)}/${decision}`,{method:'POST',body:{}});
        ctx.toast(decision==='reject'?'Suggestion declined.':decision==='undo'?'Change undone.':item.kind==='memory'?'Memory updated.':item.skill?.create?'Skill added.':'Skill updated.');
        if(item.kind==='memory')v.memoryAt=0;
      }catch(error){v.proposalNotice=friendly(bot,error,'memory and skills');}
      finally{v.deciding='';v.confirmingUndo='';refresh(bot.id);ensureProposals(bot,v,true);}
      break;}
    case 'cancel-undo':v.confirmingUndo='';refresh(bot.id);break;
    case 'setup-review':ctx.routineDialog?.(undefined,bot.id,{name:'Daily review',prompt:REVIEW_PROMPT,schedule:{kind:'daily',time:'21:00'}});break;
  }
}
document.addEventListener('click',event=>{
  const element=event.target.closest?.('[data-profile-action]');if(!element||!ctx||!element.closest('.bot-profile'))return;
  act(element).catch(error=>ctx.toast(ctx.errorText(error),true));
});
document.addEventListener('keydown',event=>{
  const element=event.target;if(!ctx||!element.closest?.('.bot-profile'))return;
  if(element.matches('[role=tab]')&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
    event.preventDefault();const keys=TABS.map(([key])=>key),index=keys.indexOf(element.dataset.tab),next=event.key==='Home'?0:event.key==='End'?keys.length-1:(index+(event.key==='ArrowRight'?1:-1)+keys.length)%keys.length;
    const bot=ctx.botById(element.closest('.bot-profile').dataset.profileBot);if(bot)setTab(bot,view(bot.id),keys[next],true);
  }
});
document.addEventListener('input',event=>{
  markSettingsDirty(event.target);
  const element=event.target,key=element.dataset?.profileInput,page=key&&element.closest('.bot-profile'),bot=page&&ctx?.botById(page.dataset.profileBot);if(!bot||element.tagName==='SELECT')return;
  const v=view(bot.id);
  if(key==='brain-query'&&v.brain){v.query=element.value;v.shown=LIST_PAGE;patch(bot,v,'#bp-brain-results',()=>brainResults(bot,v));}
  if(key==='memory-query'&&v.memory){v.memoryQuery=element.value;patch(bot,v,'#bp-memory-list',()=>memoryList(bot,v));}
  if(key==='fact-key')v.draft.key=element.value;
  if(key==='fact-value')v.draft.value=element.value;
  if(key==='script-query'){v.scriptQuery=element.value;refresh(bot.id);}
  if(key==='script-args'){v.scriptArgs.set(element.dataset.scriptId,element.value);v.scriptNotice='';}
});
document.addEventListener('change',event=>{
  markSettingsDirty(event.target);
  const element=event.target,page=element.closest?.('.bot-profile'),bot=page&&ctx?.botById(page.dataset.profileBot);if(!bot)return;
  const v=view(bot.id),key=element.dataset.profileInput;
  if(key==='brain-folder'&&v.brain){v.folder=element.value;v.shown=LIST_PAGE;patch(bot,v,'#bp-brain-results',()=>brainResults(bot,v));}
  if(key==='fact-pinned')v.draft.pinned=element.checked;
  if(element.dataset.profileUpload&&element.files?.length)upload(bot,v,element).catch(error=>ctx.toast(ctx.errorText(error),true));
});
document.addEventListener('submit',async event=>{
  const form=event.target;if(!form?.matches?.('[data-profile-form="fact"]'))return;event.preventDefault();
  const page=form.closest('.bot-profile'),bot=page&&ctx?.botById(page.dataset.profileBot);if(!bot)return;
  const v=view(bot.id);if(v.saving)return;
  const key=String(form.elements.key.value).trim(),value=String(form.elements.value.value).trim();
  if(!key||!value){v.memoryNotice='Add a short name and the fact itself.';return refresh(bot.id);}
  if(await saveFact(bot,v,{key,value,pinned:form.elements.pinned.checked},form.dataset.id?'Fact updated.':'Fact saved.')){v.adding=false;v.editing='';v.draft={};}
  refresh(bot.id);
});
document.addEventListener('scroll',event=>{
  const element=event.target;if(!element?.dataset?.profileScroll)return;const page=element.closest('.bot-profile');if(page)view(page.dataset.profileBot).scroll[element.dataset.profileScroll]=element.scrollTop;
},true);

function markSettingsDirty(element){
  const form=element.closest?.('#bot-form[data-embedded]');if(!form)return;
  form.dataset.settingsDirty='true';form.querySelector('[data-settings-status]').textContent='Unsaved changes';
  const page=form.closest('.bot-profile');if(page)capture(view(page.dataset.profileBot));
}
function settingsSaved(botId){const v=views.get(botId);if(v)v.settingsDraft=null;const form=document.querySelector('#bot-form[data-embedded]');if(form?.dataset.id===botId)delete form.dataset.settingsDirty;}
window.StudioBotProfile={render,mount,settingsSaved};
})();
