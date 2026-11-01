/* Dashboard: a calm, live overview built from GET /api/dashboard. app.js calls render(ctx) for the page HTML and
   mount(ctx, root) once that HTML is in place; this module keeps its own conditional-GET refresh while visible. */
(()=>{
  'use strict';
  const REFRESH_MS=5000,FILES_SHOWN=6;
  let cache=null,etag='',failure='',context=null,host=null,timer=null,issued=0,applied=0,inflightAt=0,lastFetch=0,lastPaint=0,range=null,allFiles=false,routinesOpen=false;

  const glyphs={
    page:'M7 3h7l4 4v14H7zM14 3v4h4',doc:'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 15h5M10 18h3',pdf:'M7 3h7l4 4v14H7zM14 3v4h4M10 17v-5h1.5a1.5 1.5 0 0 1 0 3H10',
    sheet:'M5 4h14v16H5zM5 9h14M5 14h14M10 9v11',slides:'M3 5h18v11H3zM12 16v4M8 20h8M8 13v-2m4 2V9m4 4v-3',image:'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9.5h.01',
    data:'M9 4H8a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1M15 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1',
    bell:'M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 21h4',loader:'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
    you:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 21a7.5 7.5 0 0 1 15 0',alert:'M12 3 2 20h20L12 3Zm0 7v4m0 3h.01',question:'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 18h.01',
    download:'M12 4v11m-5-5 5 5 5-5M5 20h14',check:'m6.5 12.5 3.5 3.5 7.5-8',bang:'M12 6.5v7M12 17.5h.01',arrow:'M5 12h14m-5-5 5 5-5 5',
  };
  const KINDS={pdf:'pdf',doc:'doc',docx:'doc',xls:'sheet',xlsx:'sheet',csv:'csv',ppt:'slides',pptx:'slides',md:'text',markdown:'text',txt:'text',json:'data',png:'image',jpg:'image',jpeg:'image',webp:'image',gif:'image'};
  const FILE_GLYPH={pdf:'pdf',doc:'doc',sheet:'sheet',csv:'sheet',slides:'slides',text:'doc',data:'data',image:'image',other:'page'};
  const ROUTINE_STATUS={completed:['Completed','ok'],failed:['Failed','error'],needs_input:['Needs input','warn'],running:['Running','active'],scheduled:['Scheduled','neutral'],paused:['Paused','neutral'],cancelled:['Stopped','neutral'],interrupted:['Interrupted','neutral'],ran:['Ran','neutral']};
  const svg=d=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const hash=value=>{let h=2166136261;for(let i=0;i<value.length;i++)h=Math.imul(h^value.charCodeAt(i),16777619);return (h>>>0).toString(36);};
  const keyOf=(...parts)=>parts.join('-').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').slice(0,80);
  const time=value=>{const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:NaN;};
  const startOfDay=(offset=0,from=Date.now())=>{const day=new Date(from);day.setHours(0,0,0,0);day.setDate(day.getDate()+offset);return day.getTime();};
  const onDashboard=()=>Boolean(context && host?.isConnected && context.route().view==='dashboard');
  const fileKind=format=>KINDS[String(format || '').toLowerCase()] || 'other';
  const downloadUrl=file=>`/api/bots/${encodeURIComponent(file.botId)}/files/download?path=${encodeURIComponent(file.path)}`;
  const sizeText=size=>Number.isFinite(size) && size>0?size<1_000_000?`${Math.max(1,Math.round(size/1000))} KB`:`${(size/1_000_000).toFixed(1)} MB`:'';

  function when(ctx,value) {
    const at=time(value);if(Number.isNaN(at))return '';
    if(at>=startOfDay())return ctx.timeLabel(value);
    return at>=startOfDay(-1)?'Yesterday':ctx.shortDate(value);
  }
  function dayTime(ctx,value) {
    const at=time(value);if(Number.isNaN(at))return '';
    const day=at>=startOfDay()?'Today':at>=startOfDay(-1)?'Yesterday':ctx.shortDate(value);
    return `${day}, ${ctx.timeLabel(value)}`;
  }
  function until(ctx,value) {
    const diff=time(value)-Date.now();if(Number.isNaN(diff))return '';
    if(diff<60_000)return 'any moment';
    if(diff<3_600_000)return `in ${Math.round(diff/60_000)}m`;
    if(diff<86_400_000)return `in ${Math.round(diff/3_600_000)}h`;
    return `on ${ctx.shortDate(value)}`;
  }
  function dayLabel(at) {
    if(at>=startOfDay())return 'Today';
    if(at>=startOfDay(-1))return 'Yesterday';
    return new Date(at).toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});
  }

  const tile=format=>{const kind=fileKind(format);return `<span class="dash-tile dash-kind-${kind}">${svg(glyphs[FILE_GLYPH[kind]])}</span>`;};
  // Settled states carry a filled mark (check or !); live ones a dot, which pulses while working.
  const TONE_MARK={ok:'check',warn:'bang',error:'bang',question:'question'};
  const badge=(label,tone)=>`<span class="dash-badge dash-tone-${tone}">${TONE_MARK[tone]?`<span class="dash-badge-mark">${svg(glyphs[TONE_MARK[tone]])}</span>`:'<i class="dot"></i>'}${label}</span>`;
  const head=(ctx,name,iconMarkup,title,subtitle,count,extra='')=>`<header class="dash-card-head"><span class="dash-card-icon dash-icon-${name}">${iconMarkup}</span><div class="dash-card-title"><h2 id="dash-${name}-title">${title}</h2><p>${subtitle}</p></div>${extra}${count?`<span class="dash-count" title="${count} ${count===1?'item':'items'}">${count}</span>`:''}</header>`;
  const empty=(iconMarkup,title,text,action='')=>`<div class="dash-empty">${iconMarkup}<div><strong>${title}</strong><p>${text}</p>${action}</div></div>`;
  const skeleton=rows=>`<div class="dash-skeleton" aria-hidden="true">${'<span></span>'.repeat(rows)}</div>`;
  const section=(name,inner,{hidden=false,live=true,classes=''}={})=>`<section class="dash-card glass-card dash-${name}${classes?` ${classes}`:''}" data-dash-section="${name}" data-dash-hash="${hash(`${hidden}:${inner}`)}" aria-labelledby="dash-${name}-title"${hidden?' hidden':''}${cache||!live?'':' aria-busy="true"'}>${inner}</section>`;
  function botMark(ctx,botId,size,key) {const bot=botId?ctx.botById(botId):null;return bot?ctx.avatar(bot,size,key):'';}
  function previewButton(ctx,file,label='Preview') {return `<button type="button" class="secondary-button dash-small" data-dash-action="preview" data-bot="${ctx.esc(file.botId)}" data-path="${ctx.esc(file.path)}">${label}</button>`;}
  function downloadLink(ctx,file) {return `<a class="icon-button dash-download" href="${ctx.esc(downloadUrl(file))}" download title="Download" aria-label="Download ${ctx.esc(file.name)}">${svg(glyphs.download)}</a>`;}

  function teamSection(ctx) {
    const e=ctx.esc,bots=(ctx.data?.bots || []).filter(bot=>!bot.hidden),shown=bots.slice(0,4);
    const cards=shown.map(bot=>`<button type="button" class="pearl-resource-card pearl-home-teammate" data-nav="/bot/${e(bot.id)}">${ctx.avatar(bot,'large',keyOf('dash-teammate',bot.id))}<span><strong>${e(bot.name)}</strong><small>${e(bot.title || 'Your teammate')}</small></span>${svg(glyphs.arrow)}</button>`).join('');
    return `<header class="dash-card-head"><div class="dash-card-title"><h2 id="dash-team-title">Your team</h2><p>Choose a teammate and start with a message.</p></div><button type="button" class="text-button dash-head-link" data-nav="/bots">View team${svg(glyphs.arrow)}</button></header><div class="pearl-home-actions">${cards || `<button type="button" class="pearl-resource-card" data-nav="/bots">${ctx.icon('bots')}<span><strong>Find your first teammate</strong><small>Give a bot a name and a role.</small></span>${svg(glyphs.arrow)}</button>`}</div>`;
  }

  function missionsSection(ctx) {
    const e=ctx.esc,items=(ctx.data?.missions || []).filter(m=>!m.archivedAt),attention=m=>['needs_attention','blocked','failed','interrupted','unknown','budget_exhausted','expired'].includes(m.status);
    const finished=m=>m.executionState==='terminal'||['achieved','stopped','failed','expired','budget_exhausted','archived'].includes(m.status);
    const needs=items.filter(attention),active=items.filter(m=>!finished(m)&&!attention(m));
    const label=m=>({queued:'Queued',running:'In progress',planning:'Planning',verifying:'Verifying',waiting:'Waiting',stopping:'Stopping',paused:'Paused',pausing:'Pausing'})[m.status]||'Needs attention';
    const row=m=>{const p=m.progress||{},hasProgress=Number.isFinite(p.verified)&&Number.isFinite(p.total)&&p.total>0&&p.verified>=0&&p.verified<=p.total,mark=botMark(ctx,m.leadBotId,'small',keyOf('dash-mission',m.id))||`<span class="dash-mark dash-mark-neutral">${ctx.icon('mission')}</span>`;
      return `<article class="dash-row dash-mission">${mark}<div class="dash-row-body"><div class="dash-row-top"><strong>${e(m.title||m.goal||'Mission')}</strong>${badge(e(attention(m)?'Needs you':label(m)),attention(m)?'warn':'active')}</div><p class="dash-row-detail">${e(m.remote?`Summary from ${m.originEngineName||'another engine'}`:m.currentStep||'Open the Mission to follow its work.')}${hasProgress?` · ${e(p.verified)} of ${e(p.total)} outcomes verified`:''}</p></div><div class="dash-row-actions"><button type="button" class="secondary-button dash-small" data-nav="/missions/${e(encodeURIComponent(m.id))}">${m.remote?'Open summary':'Open Mission'}${svg(glyphs.arrow)}</button></div></article>`;};
    const group=(title,rows)=>rows.length?`<div class="dash-mission-group"><h3>${title}</h3><div class="dash-list">${rows.slice(0,6).map(row).join('')}</div></div>`:'';
    const body=group('Needs you',needs)+group('Active',active);
    return {visible:needs.length+active.length>0,html:head(ctx,'missions',ctx.icon('mission'),'Missions','Goals your team is working toward.',needs.length+active.length,`<button type="button" class="text-button dash-head-link" data-nav="/missions">View all${svg(glyphs.arrow)}</button>`)+body};
  }

  function filesSection(ctx) {
    const e=ctx.esc,files=cache?.files || [],shown=allFiles?files:files.slice(0,FILES_SHOWN);
    const card=(file,index)=>{const bot=ctx.botById(file.botId);return `<article class="dash-file">${tile(file.format)}<div class="dash-file-body"><strong title="${e(file.name)}">${e(file.name)}</strong><span class="dash-file-meta">${bot?ctx.avatar(bot,'tiny',keyOf('dash-file',index,file.botId)):''}<span class="dash-file-bot">${e(bot?.name || file.botName || 'A bot')}</span><span aria-hidden="true">·</span><time datetime="${e(file.createdAt || '')}">${e(when(ctx,file.createdAt))}</time></span></div><div class="dash-file-actions">${previewButton(ctx,file)}${downloadLink(ctx,file)}</div></article>`;};
    const toggle=files.length>FILES_SHOWN?`<button type="button" class="text-button dash-head-link" data-dash-action="files" aria-expanded="${allFiles}">${allFiles?'Show fewer':`Show all ${files.length}`}</button>`:'';
    const body=!cache?skeleton(1):files.length?`<div class="dash-file-grid">${shown.map(card).join('')}</div>`:empty(ctx.icon('file'),'No files yet','Documents, spreadsheets and images your bots create will appear here.');
    return head(ctx,'files',ctx.icon('file'),'Recent files','Latest outputs from your bots.',0,toggle)+body;
  }

  function activityRange(items) {
    if(range)return range;
    if(items.some(item=>time(item.at)>=startOfDay()))return 'today';
    return items.some(item=>time(item.at)>=startOfDay(-6))?'week':'all';
  }
  function inlineFile(ctx,file) {const e=ctx.esc;return `<div class="dash-inline-file">${tile(file.format)}<div><strong title="${e(file.name)}">${e(file.name)}</strong><small>${e([String(file.format || '').toUpperCase(),sizeText(file.size)].filter(Boolean).join(' · '))}</small></div><div class="dash-file-actions">${previewButton(ctx,file)}${downloadLink(ctx,file)}</div></div>`;}
  function eventMark(ctx,item,index) {
    if(item.actor==='bot' && item.botId){const markup=botMark(ctx,item.botId,'tiny',keyOf('dash-event',index,item.id));if(markup)return markup;}
    const glyph=item.actor==='you'?svg(glyphs.you):item.actor==='room'?ctx.icon('team'):item.kind==='skill'?ctx.icon('spark'):item.kind==='file'?ctx.icon('file'):ctx.icon('activity');
    return `<span class="dash-mark dash-mark-${item.actor==='you'?'you':'neutral'}">${glyph}</span>`;
  }
  function eventRow(ctx,item,index) {
    const e=ctx.esc,files=Array.isArray(item.files)?item.files:[];
    const subject=item.subject?item.nav && item.actor!=='you'?`<a class="dash-subject" href="#${e(item.nav)}">${e(item.subject)}</a> `:`<strong>${e(item.subject)}</strong> `:'';
    return `<li class="dash-event dash-event-${e(item.tone || 'neutral')}"><time class="dash-event-time" datetime="${e(item.at)}">${e(ctx.timeLabel(item.at))}</time><span class="dash-event-dot" aria-hidden="true"></span><span class="dash-event-mark">${eventMark(ctx,item,index)}</span><div class="dash-event-body"><p class="dash-event-text">${subject}${e(item.text)}</p>${item.detail?`<p class="dash-event-detail">${e(item.detail)}</p>`:''}${files.length?`<div class="dash-event-files">${files.map(file=>inlineFile(ctx,file)).join('')}${item.moreFiles?`<span class="dash-more">+${e(item.moreFiles)} more</span>`:''}</div>`:''}</div></li>`;
  }
  function activitySection(ctx) {
    const items=cache?.activity || [],selected=activityRange(items),from=selected==='today'?startOfDay():selected==='week'?startOfDay(-6):-Infinity;
    const visible=items.filter(item=>time(item.at)>=from),groups=[];
    for(const item of visible){const label=dayLabel(time(item.at));if(groups.at(-1)?.label!==label)groups.push({label,items:[]});groups.at(-1).items.push(item);}
    const control=`<div class="segmented dash-range" role="group" aria-label="Activity period">${[['today','Today'],['week','7 days'],['all','All']].map(([value,label])=>`<button type="button" class="segment ${value===selected?'active':''}" aria-pressed="${value===selected}" data-dash-action="range" data-range="${value}">${label}</button>`).join('')}</div>`;
    let index=0,body;
    if(!cache)body=skeleton(4);
    else if(groups.length)body=`<ol class="dash-days">${groups.map(group=>`<li class="dash-day"><h3 class="dash-day-label">${ctx.esc(group.label)}</h3><ol class="dash-events">${group.items.map(item=>eventRow(ctx,item,index++)).join('')}</ol></li>`).join('')}</ol>`;
    else {
      const wider=selected==='today'?['week','Show the last 7 days']:selected==='week'?['all','Show everything']:null,more=wider && items.length?`<button type="button" class="text-button" data-dash-action="range" data-range="${wider[0]}">${wider[1]}</button>`:'';
      body=items.length?empty(ctx.icon('clock'),selected==='today'?'Quiet so far today':'A quiet week','Nothing new happened in this period.',more):empty(ctx.icon('activity'),'No activity yet','Give a bot a task and its result will show up here.','<button type="button" class="text-button" data-nav="/bots">Open your bots</button>');
    }
    return head(ctx,'activity',ctx.icon('activity'),'Latest activity','Recent task results from all your engines.',0,control)+body;
  }

  function needsSection(ctx) {
    const e=ctx.esc,items=cache?.needs || [];
    const row=(item,index)=>{
      const mark=botMark(ctx,item.botId,'small',keyOf('dash-need',index,item.id)) || `<span class="dash-mark dash-mark-warn">${svg(glyphs.alert)}</span>`;
      const label=item.kind==='approval'?badge('Approval needed','warn'):item.kind==='question'?badge('Question','question'):item.kind==='review'?badge('Suggestion','neutral'):badge('Needs setup','error');
      const name=item.kind==='setup'?'':`<strong>${e(item.botName || ctx.botById(item.botId)?.name || 'A bot')}</strong>${item.roomName?`<span class="dash-row-context">in ${e(item.roomName)}</span>`:''}`;
      const detail=[item.detail,item.at && item.kind!=='setup'?ctx.relative(item.at):''].filter(Boolean).join(' · ');
      return `<article class="dash-row dash-need-${e(item.kind)}">${mark}<div class="dash-row-body"><div class="dash-row-top">${name}${label}</div><p class="dash-row-title">${e(item.title)}</p>${detail?`<p class="dash-row-detail">${e(detail)}</p>`:''}</div><div class="dash-row-actions"><button type="button" class="${item.kind==='approval'?'primary-button':item.kind==='question'?'accent-button':'secondary-button'} dash-small" data-nav="${e(item.nav)}">${e(item.action || 'Open')}${svg(glyphs.arrow)}</button></div></article>`;
    };
    const body=!cache?skeleton(1):items.length?`<div class="dash-list">${items.map(row).join('')}</div>`:empty(ctx.icon('check'),'You’re all caught up','Approvals, questions and suggestions from your bots will appear here.');
    return head(ctx,'needs',svg(glyphs.bell),'Needs you','Requests that need your attention.',items.length)+body;
  }

  function workingSection(ctx) {
    const e=ctx.esc,items=cache?.working || [];
    const row=(item,index)=>{
      const mark=botMark(ctx,item.botId,'small',keyOf('dash-work',index,item.id)) || `<span class="dash-mark dash-mark-neutral">${ctx.icon('team')}</span>`;
      const name=item.kind==='room'?item.roomName:item.botName || ctx.botById(item.botId)?.name || 'A bot';
      const label=item.kind==='elsewhere'?badge(`On ${e(item.elsewhere)}`,'neutral'):item.status==='waiting_for_delegate'?badge('Waiting','neutral'):item.status==='stopping'?badge('Stopping','neutral'):item.status==='queued'?badge('Queued','neutral'):badge('Working','active');
      const progress=item.progress?.total?`<span class="dash-progress">${e(item.progress.done)} of ${e(item.progress.total)}</span>`:'';
      const context=item.kind==='room'?'':item.roomName?`<span class="dash-row-context">in ${e(item.roomName)}</span>`:'';
      return `<article class="dash-row dash-working-${e(item.kind)}">${mark}<div class="dash-row-body"><div class="dash-row-top"><strong>${e(name)}</strong>${context}${label}</div>${item.kind==='elsewhere'?'':`<p class="dash-row-title">${e(item.title)}</p>`}<p class="dash-row-detail dash-step">${item.kind==='elsewhere'?'':'<span class="dash-spinner" aria-hidden="true"></span>'}<span>${e(item.kind==='elsewhere'?`Open the chat on ${item.elsewhere} to follow along.`:item.step)}</span>${progress}</p></div><div class="dash-row-actions"><button type="button" class="secondary-button dash-small" data-nav="${e(item.nav)}">${item.kind==='room'?'Open room':'Open chat'}${svg(glyphs.arrow)}</button></div></article>`;
    };
    const body=!cache?skeleton(1):items.length?`<div class="dash-list">${items.map(row).join('')}</div>`:empty(svg(glyphs.loader),'Everyone’s free','Bots working on a task show up here with their current step.');
    return head(ctx,'working',svg(glyphs.loader),'Working now','Bots currently working on tasks.',items.length)+body;
  }

  function routinesSection(ctx) {
    const e=ctx.esc,items=cache?.routines || [];
    const row=item=>{
      const [label,tone]=ROUTINE_STATUS[item.status] || ROUTINE_STATUS.ran,bot=ctx.botById(item.botId),name=bot?.name || item.botName || 'A bot';
      const last=item.lastRunAt?dayTime(ctx,item.lastRunAt):'Not run yet',next=item.enabled?item.nextRunAt?`Next ${until(ctx,item.nextRunAt)}`:'':'Paused';
      const files=Array.isArray(item.files) && item.files.length?item.files.map(file=>file.name).join(', '):'';
      const detail=[item.detail || (files?`Created ${files}`:''),next].filter(Boolean).join(' · ');
      return `<article class="dash-row dash-routine">${`<span class="dash-mark dash-mark-routine">${ctx.icon('routine')}</span>`}<div class="dash-row-body"><div class="dash-row-top"><strong>${e(item.name)}</strong>${badge(label,tone)}</div><p class="dash-row-meta">${e(name)} · ${e(last)}</p>${detail?`<p class="dash-row-detail">${e(detail)}</p>`:''}</div><div class="dash-row-actions"><button type="button" class="${item.status==='needs_input'?'accent-button':'secondary-button'} dash-small" data-nav="${e(item.nav)}">${item.status==='needs_input'?'Reply':'Open chat'}${svg(glyphs.arrow)}</button></div></article>`;
    };
    const body=!cache?skeleton(1):items.length?`<div class="dash-list">${items.map(row).join('')}</div>`:empty(ctx.icon('routine'),'No routines yet','Schedule a recurring task and its latest results will appear here.','<button type="button" class="text-button" data-nav="/routines">Set up a routine</button>');
    return `<details class="pearl-advanced dash-routine-disclosure" data-dash-disclosure="routines"${routinesOpen?' open':''}><summary data-dash-focus="routines">${head(ctx,'routines',ctx.icon('routine'),'Routine updates','Latest results from your routines.',items.length)}</summary><div class="dash-routine-content">${body}</div></details>`;
  }

  function page(ctx) {
    const status=failure && cache?`<p class="dash-status" role="status">Showing the last update. Reconnecting…</p>`:'';
    const mission=missionsSection(ctx),missionSection=section('missions',mission.html,{hidden:!mission.visible,live:false});
    const heading=`<div class="page-heading dash-heading"><div><h1>Dashboard</h1><p class="page-description">A live view of your team’s work.</p></div>${status}</div>`;
    if(!cache && failure)return `<section class="page dashboard-page" data-dash-page>${heading}${mission.visible?missionSection:''}<div class="dash-card glass-card dash-failure" data-dash-section="failure" role="alert">${empty(ctx.icon('info'),'The dashboard didn’t load',ctx.esc(failure),'<button type="button" class="secondary-button dash-small" data-dash-action="retry">Try again</button>')}</div></section>`;
    return `<section class="page dashboard-page" data-dash-page>${heading}${section('team',teamSection(ctx),{live:false,classes:'pearl-home-hero'})}${missionSection}<div class="dash-priority">${section('needs',needsSection(ctx),{hidden:Boolean(cache&&!cache.needs?.length)})}${section('working',workingSection(ctx),{hidden:Boolean(cache&&!cache.working?.length)})}</div>${section('files',filesSection(ctx),{hidden:Boolean(cache&&!cache.files?.length)})}<div class="dash-columns">${section('activity',activitySection(ctx))}<div class="dash-side">${section('routines',routinesSection(ctx),{hidden:Boolean(cache&&!cache.routines?.length)})}</div></div></section>`;
  }

  /** Swaps only the sections whose markup changed, keeping avatars animating and focus where it was. */
  function paint() {
    if(!onDashboard())return;
    const current=host.querySelector('[data-dash-page]');if(!current)return;
    const template=document.createElement('template');template.innerHTML=page(context);
    const next=template.content.querySelector('[data-dash-page]');lastPaint=Date.now();
    const fresh=[...next.querySelectorAll('[data-dash-section]')],old=new Map([...current.querySelectorAll('[data-dash-section]')].map(node=>[node.dataset.dashSection,node]));
    const status=current.querySelector('.dash-heading'),nextStatus=next.querySelector('.dash-heading');
    if(fresh.length!==old.size || fresh.some(node=>!old.has(node.dataset.dashSection))){current.replaceWith(next);return;}
    if(status && nextStatus && status.innerHTML!==nextStatus.innerHTML)status.replaceWith(nextStatus);
    const active=document.activeElement,focusKey=element=>[element.tagName,element.dataset?.dashFocus,element.dataset?.dashAction,element.dataset?.range,element.dataset?.nav,element.dataset?.path,element.getAttribute?.('href')].join('|');
    for(const node of fresh) {
      const previous=old.get(node.dataset.dashSection);if(previous.dataset.dashHash===node.dataset.dashHash)continue;
      const key=active && previous.contains(active)?focusKey(active):null;
      previous.replaceWith(node);
      if(key)[...node.querySelectorAll('button,a,summary')].find(element=>focusKey(element)===key)?.focus();
    }
  }

  async function load() {
    const ctx=context;if(!ctx)return;
    const token=++issued;inflightAt=Date.now();
    try {
      const response=await ctx.api('/api/dashboard',{etag:cache?etag:''});
      // A slower, older reply never overwrites a newer one.
      if(token<=applied)return;applied=token;
      const recovered=Boolean(failure);failure='';
      if(response.notModified){if(recovered || Date.now()-lastPaint>60_000)paint();return;}
      cache=response.body && typeof response.body==='object'?response.body:null;etag=response.etag || '';paint();
    } catch(error) {
      if(token<=applied)return;applied=token;
      failure=ctx.errorText(error);paint();
    } finally {lastFetch=Date.now();if(token===issued)inflightAt=0;}
  }
  function tick() {
    if(!onDashboard()){clearInterval(timer);timer=null;return;}
    if(document.hidden || document.querySelector('dialog') || (inflightAt && Date.now()-inflightAt<15_000))return;
    load();
  }

  function render(ctx) {context=ctx;return page(ctx);}
  function mount(ctx,root) {
    context=ctx;host=root;
    if(!timer)timer=setInterval(tick,REFRESH_MS);
    // app.js re-mounts after its own page refreshes; a fresh reply is reused instead of refetched.
    if(!inflightAt && Date.now()-lastFetch>2000)load();
  }

  document.addEventListener('click',event=>{
    const element=event.target?.closest?.('[data-dash-action]');if(!element || !context)return;
    const action=element.dataset.dashAction;
    if(action==='range'){range=['today','week','all'].includes(element.dataset.range)?element.dataset.range:null;paint();}
    else if(action==='files'){allFiles=!allFiles;paint();}
    else if(action==='retry'){failure='';const ctx=context;if(onDashboard())host.innerHTML=render(ctx);load();}
    else if(action==='preview'){const ctx=context;Promise.resolve().then(()=>ctx.documentPreview(element.dataset.bot,element.dataset.path)).catch(error=>ctx.toast(ctx.errorText(error),true));}
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden && timer && onDashboard() && !inflightAt)load();});
  document.addEventListener('toggle',event=>{if(event.target?.dataset?.dashDisclosure==='routines')routinesOpen=event.target.open;},true);

  window.StudioDashboard=Object.freeze({render,mount});
})();
