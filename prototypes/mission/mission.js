/* Scripted, memory-only prototype. No API, model, storage or execution authority. */
(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths = {
    home:'M3 11 12 3l9 8M5 9.5V21h5v-6h4v6h5V9.5',
    grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    mission:'M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 12l9-9m-5 0h5v5',
    team:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM20 21v-2a4 4 0 0 0-3-3.9M16 3a4 4 0 0 1 0 8',
    routine:'M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5M12 8v4l3 2',
    plus:'M12 5v14M5 12h14', check:'m5 12 4 4L19 6', file:'M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8M8 17h5',
    search:'M21 21l-5-5M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14', arrow:'M5 12h14m-5-5 5 5-5 5', back:'m14 6-6 6 6 6',
    chevron:'m9 5 7 7-7 7', clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2',
    chat:'M21 11a8 8 0 0 1-8 8H7l-4 3V7a4 4 0 0 1 4-4h6a8 8 0 0 1 8 8ZM7 8h9M7 12h6',
    pause:'M8 5v14M16 5v14', play:'m8 4 12 8-12 8Z', stop:'M6 6h12v12H6Z', close:'m6 6 12 12M6 18 18 6',
    moon:'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z', sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
    info:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v5M12 7v.1', download:'M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4',
    send:'m5 12 7-7 7 7M12 5v14', lock:'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5Z', activity:'M3 12h4l3-7 4 14 3-7h4',
    gear:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.mission}"/></svg>`;
  const bots = {
    atlas: {name:'Atlas', role:'Your thoughtful coordinator', color:'blue'},
    nova: {name:'Nova', role:'Writing & creative direction', color:'coral'},
    scout: {name:'Scout', role:'Research & discovery', color:'jade'},
    echo: {name:'Echo', role:'Review & quality', color:'honey'},
  };
  const avatar = (id, size = '', alt = '') => `<img class="mp-avatar ${size}" src="../../public/assets/companions/companion-${bots[id].color}-portrait-128.webp" width="42" height="42" alt="${esc(alt)}">`;
  const labels = {attention:'Needs you',working:'In progress',planning:'Planning',waiting:'Waiting',paused:'Paused',stopped:'Stopped',achieved:'Achieved'};
  const finished = m => ['achieved','stopped'].includes(m.status);
  const criterion = (title, note, done, file) => ({title,note,done,file});
  const initialMissions = () => [
    {id:'autumn-launch',title:'Prepare the autumn launch',goal:'A clear launch story, a ready-to-share content kit, and a practical two-week rollout plan.',lead:'atlas',team:['atlas','scout','nova','echo'],status:'attention',updated:'2 min ago',created:'Today, 09:12',deadline:'6 November',now:'One decision before the content kit',nowNote:'Nova is ready to adapt the story to your audience.',request:{type:'question',title:'Who should the launch speak to first?',description:'The research points to two strong audiences. Your choice will shape the content kit.',options:['Independent creators','Small teams']},criteria:[
      criterion('Research the audience and positioning','Scout · 8 sources reviewed',true,'Audience & positioning'),
      criterion('Define the launch story','Nova · Clear message and three key benefits',true,'Launch narrative'),
      criterion('Build the two-week rollout plan','Atlas · Owners and dates included',true,'Two-week rollout'),
      criterion('Prepare the launch content kit','Nova · Landing copy, email and 3 social posts',false,'Launch content kit'),
      criterion('Verify the complete launch package','Echo · Check every result against the goal',false,'Final review'),
    ],events:[{title:'Atlas needs your audience choice',detail:'The next step depends on this decision.',time:'09:48',kind:'chat'},{title:'Two-week rollout verified',detail:'Dates, owners and launch milestones are included.',time:'09:45',kind:'check'},{title:'Nova finished the launch story',detail:'The narrative is grounded in Scout’s research.',time:'09:32',kind:'file'},{title:'Mission started from your chat',detail:'Atlas brought Scout, Nova and Echo into the work.',time:'09:12',kind:'mission'}]},
    {id:'knowledge-tools',title:'Find the right knowledge tool',goal:'Compare five tools for a small team and deliver one recommendation with a migration checklist.',lead:'scout',team:['scout','echo'],status:'working',updated:'Just now',created:'Today, 10:04',deadline:'No deadline',now:'Comparing search and export options',nowNote:'Scout is building a side-by-side comparison from the collected material.',criteria:[
      criterion('Define the team’s requirements','Search, permissions, export and collaboration',true,'Requirements'),
      criterion('Collect evidence for five tools','Primary product documentation collected',true,'Research notes'),
      criterion('Compare the shortlist','Tradeoffs, fit and missing capabilities',false,'Tool comparison'),
      criterion('Write a recommendation and migration plan','A clear choice with an actionable next step',false,'Recommendation'),
      criterion('Verify sources and the final recommendation','Echo · Check coverage and cited evidence',false,'Final review'),
    ],events:[{title:'Scout is comparing the shortlist',detail:'Five tools, four decision criteria.',time:'10:21',kind:'activity'},{title:'Research notes verified',detail:'The source list is attached to the result.',time:'10:18',kind:'check'},{title:'Mission started',detail:'Scout leads; Echo will review the recommendation.',time:'10:04',kind:'mission'}]},
    {id:'team-offsite',title:'Plan a thoughtful team offsite',goal:'A two-day agenda and three venue options for a team of twelve, with travel and accessibility notes.',lead:'atlas',team:['atlas','scout'],status:'waiting',updated:'18 min ago',created:'Today, 08:40',deadline:'10 November',now:'Waiting for venue availability',nowNote:'Next scheduled check: tomorrow at 09:00. No action needed from you.',criteria:[
      criterion('Define the offsite brief','Team size, dates and accessibility needs',true,'Offsite brief'),
      criterion('Compare three available venues','Scout · Waiting for availability information',false,'Venue shortlist'),
      criterion('Prepare the agenda and travel notes','Atlas · Two days with time to connect',false,'Offsite plan'),
      criterion('Verify the final package','Confirm all requirements have been covered',false,'Final review'),
    ],events:[{title:'Waiting until the next availability check',detail:'The work stays visible while nothing needs to run.',time:'09:32',kind:'clock'},{title:'Offsite brief verified',detail:'Twelve people, two days, accessible venues.',time:'09:05',kind:'check'},{title:'Mission started',detail:'Atlas coordinates planning and research.',time:'08:40',kind:'mission'}]},
    {id:'team-playbook',title:'Turn team notes into a playbook',goal:'Organise scattered onboarding notes into a concise, searchable guide for new teammates.',lead:'nova',team:['nova','echo'],status:'achieved',updated:'Yesterday',created:'Yesterday, 11:10',deadline:'Completed',now:'The playbook is ready',nowNote:'All required results passed the final review.',criteria:[criterion('Organise the source notes','Sections and duplicate notes resolved',true,'Source outline'),criterion('Write the onboarding playbook','A clear guide with a first-week checklist',true,'Onboarding playbook'),criterion('Verify the finished guide','Echo · Coverage and links checked',true,'Final review')],events:[{title:'Mission achieved',detail:'All three required outcomes verified.',time:'16:42',kind:'check'},{title:'Playbook ready',detail:'The guide includes a first-week checklist.',time:'16:28',kind:'file'}]},
  ];
  let missions = initialMissions();
  let filter = 'active';
  let query = '';
  let nextId = 1;
  let toastTimer;
  let dialogOpener;
  let customMessages = [];
  let chatDrafts = {};
  const app = $('#app');
  const dialog = $('#mission-dialog');
  const route = () => {
    const [view = 'missions', id] = location.hash.replace(/^#\/?/,'').split('/');
    return {view: view || 'missions',id};
  };
  const find = id => missions.find(m => m.id === id);
  const status = m => `<span class="mp-status ${m.status}"><i></i>${labels[m.status]}</span>`;
  const progress = m => {
    const total = m.criteria.length;
    const done = m.criteria.filter(c => c.done).length;
    return {total,done,percent:total ? Math.round(done / total * 100) : null};
  };
  const progressMarkup = (m, large = false) => {
    const p = progress(m);
    return `<div class="${large ? 'mp-large-progress' : ''}"><div class="mp-progress-caption"><span>${p.total ? `${p.done} of ${p.total} outcomes verified` : 'Defining the outcomes'}</span><b>${p.total ? p.percent + '%' : '—'}</b></div><div class="mp-progress ${!p.total ? 'indeterminate' : ''} ${m.status === 'achieved' ? 'complete' : ''}" role="progressbar" aria-label="Verified mission outcomes" ${p.total ? `aria-valuenow="${p.percent}" aria-valuemin="0" aria-valuemax="100" aria-valuetext="${p.done} of ${p.total} outcomes verified"` : 'aria-valuetext="Defining the outcomes"'}><span style="width:${p.total ? p.percent : 25}%"></span></div></div>`;
  };
  const tabs = [['dashboard','Dashboard','home'],['bots','Bots','grid'],['missions','Mission','mission'],['rooms','Team rooms','team'],['routines','Routines','routine']];
  function shell(page, current) {
    const active = current.view === 'chat' ? 'bots' : current.view;
    const nav = phone => tabs.map(([id,label,symbol]) => `<button class="${phone ? 'tab' : 'nav-item'} ${active === id ? 'active' : ''}" data-nav="${id}" ${active === id ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${phone && id === 'rooms' ? 'Rooms' : label}</span>${!phone && id === 'missions' ? `<span class="nav-count">${missions.filter(m=>!finished(m)).length}</span>` : ''}</button>`).join('');
    return `<div class="app-shell" data-view="mission"><aside class="sidebar" aria-label="Main navigation"><div class="brand"><img class="mp-brand-image" src="../../public/assets/brand/tupies-avatar.webp" alt=""><span class="brand-name">Tupies</span></div><nav class="nav-list">${nav(false)}</nav><div class="sidebar-label">My Tupies</div><div class="roster">${Object.entries(bots).map(([id,b])=>`<button class="roster-item ${current.view==='chat' && current.id===id ? 'selected' : ''}" data-nav="chat/${id}">${avatar(id)}<span class="mp-roster-copy"><span class="roster-name">${b.name}</span><span class="roster-role">${b.role}</span></span></button>`).join('')}</div><div class="sidebar-bottom"><button class="nav-item" data-action="about">${icon('gear')}<span>Preview settings</span></button><div class="mp-prototype-note"><i></i>Interactive prototype</div></div></aside><div class="content"><header class="mp-topbar"><div class="mp-breadcrumb"><span>Workspace</span>${icon('chevron')}<span>${current.view === 'chat' ? 'Chat' : tabs.find(t=>t[0]===current.view)?.[1] || 'Mission'}</span></div><div class="mp-top-actions"><span class="mp-demo-pill">Demo workspace</span><button class="icon-button" data-action="theme" aria-label="Switch to ${document.documentElement.dataset.theme==='dark' ? 'light' : 'dark'} appearance">${icon(document.documentElement.dataset.theme==='dark' ? 'sun' : 'moon')}</button></div></header><main id="main-content" tabindex="-1">${page}</main></div><nav class="tabbar" aria-label="Sections">${nav(true)}</nav></div>`;
  }
  function card(m) {
    return `<article class="mp-card ${m.status}"><div class="mp-card-top">${status(m)}<time>${esc(m.updated)}</time></div><h2><button class="mp-card-link" data-nav="missions/${m.id}">${esc(m.title)}</button></h2><p class="mp-card-description">${esc(m.goal)}</p><div class="mp-card-progress">${progressMarkup(m)}</div><div class="mp-card-now">${icon(m.status==='attention' ? 'chat' : m.status==='waiting' ? 'clock' : m.status==='achieved' ? 'check' : 'activity')}<span>${esc(m.now)}</span></div><div class="mp-card-bottom"><div class="mp-led">${avatar(m.lead,'small')}<span>Led by <b>${bots[m.lead].name}</b></span></div><div class="mp-stack" aria-label="Participants: ${m.team.map(id=>bots[id].name).join(', ')}">${m.team.filter(id=>id!==m.lead).map(id=>avatar(id,'small',bots[id].name)).join('')}</div><span class="mp-card-open">Open${icon('arrow')}</span></div></article>`;
  }
  function filtered() {
    return missions.filter(m => (filter==='all' || filter==='active' && !finished(m) || filter==='attention' && m.status==='attention' || filter==='finished' && finished(m)) && `${m.title} ${m.goal} ${bots[m.lead].name}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>Number(b.status==='attention')-Number(a.status==='attention'));
  }
  function cardsMarkup() {
    const list = filtered();
    if (!list.length) return `<div class="mp-empty">${icon(query ? 'search' : 'mission')}<h2>${query ? 'No matching missions' : filter==='attention' ? 'Nothing needs your attention' : 'Room for your next mission'}</h2><p>${query ? 'Try another name, goal or lead bot.' : filter==='attention' ? 'Your team has what it needs to keep going.' : 'Give your team a goal and a clear outcome.'}</p><button class="secondary-button" data-action="${query ? 'clear-search' : 'new'}">${query ? 'Clear search' : 'New Mission'}</button></div>`;
    return list.map(card).join('') + (!query && filter==='active' ? `<button class="mp-new-card" data-action="new"><span>${icon('plus')}</span><span><strong>What’s your next goal?</strong><small>Start here, or turn a conversation into a Mission.</small></span></button>` : '');
  }
  function listPage() {
    const counts = {active:missions.filter(m=>!finished(m)).length,attention:missions.filter(m=>m.status==='attention').length,finished:missions.filter(finished).length,all:missions.length};
    return `<section class="mp-page"><div class="mp-heading"><div><h1>Mission</h1><p>Give your team a goal. Keep the whole journey in view.</p></div><button class="primary-button" data-action="new" aria-label="New Mission">${icon('plus')}New Mission</button></div><div class="mp-overview"><div class="mp-overview-item"><strong>${counts.active}</strong>Active</div><div class="mp-overview-item attention"><strong>${counts.attention}</strong>Needs you</div><div class="mp-overview-item"><strong>${missions.filter(m=>m.status==='achieved').length}</strong>Achieved</div><div class="mp-overview-note">${icon('check')}Progress backed by results</div></div><div class="mp-toolbar"><div class="mp-filters" role="group" aria-label="Filter missions">${[['active','Active'],['attention','Needs you'],['finished','Finished'],['all','All']].map(([id,label])=>`<button class="mp-filter ${filter===id ? 'active' : ''}" data-filter="${id}" aria-pressed="${filter===id}">${label}<span class="mp-filter-count">${counts[id]}</span></button>`).join('')}</div><label class="mp-search">${icon('search')}<input type="search" id="mission-search" placeholder="Search missions" aria-label="Search missions" value="${esc(query)}"></label></div><div class="mp-grid" id="mission-grid">${cardsMarkup()}</div><footer class="mp-list-footer"><span>One goal. One shared view of the work, wherever it starts.</span><button class="mp-link" data-nav="chat/atlas">Try creating from chat${icon('arrow')}</button></footer></section>`;
  }
  function question(m) {
    if (!m.request || m.status !== 'attention') return '';
    return `<section class="mp-panel mp-question" aria-label="Your response is needed"><div class="mp-question-label">${icon(m.request.type==='approval' ? 'lock' : 'chat')}${bots[m.lead].name} needs ${m.request.type==='approval' ? 'your approval' : 'your input'}</div><h2>${esc(m.request.title)}</h2><p>${esc(m.request.description)}</p><div class="mp-question-actions">${m.request.options.map((option,index)=>`<button class="${index===0 ? 'accent-button' : 'secondary-button'}" data-action="answer" data-id="${m.id}" data-option="${index}">${esc(option)}</button>`).join('')}${m.request.type==='approval' ? '' : `<button class="secondary-button" data-action="custom-answer" data-id="${m.id}">Something else</button>`}</div></section>`;
  }
  function files(m) {
    const ready = m.criteria.map((c,i)=>({...c,index:i})).filter(c=>c.done);
    return ready.length ? ready.map(c=>`<button class="mp-artifact" data-action="artifact" data-id="${m.id}" data-index="${c.index}"><span class="mp-file-icon">${icon('file')}</span><span class="mp-file-copy"><strong>${esc(c.file)}</strong><small>Verified · ${c.index===m.criteria.length-1 ? 'Review' : 'Document'}</small></span>${icon('chevron')}</button>`).join('') : `<p class="mp-progress-note">Verified results will appear here as the work moves forward.</p>`;
  }
  function detailPage(m) {
    if (!m) return `<section class="mp-page"><div class="mp-empty">${icon('mission')}<h2>This demo mission is no longer here</h2><p>New missions last until the prototype is reloaded.</p><button class="secondary-button" data-nav="missions">All missions</button></div></section>`;
    const p = progress(m);
    const currentIndex = m.criteria.findIndex(c=>!c.done);
    return `<section class="mp-page"><button class="mp-back" data-nav="missions">${icon('back')}All missions</button><div class="mp-detail-header"><div>${status(m)}<h1>${esc(m.title)}</h1><p>${esc(m.goal)}</p></div><div class="mp-detail-actions">${!finished(m) ? `<button class="secondary-button" data-action="pause" data-id="${m.id}">${icon(m.status==='paused' ? 'play' : 'pause')}${m.status==='paused' ? 'Resume' : 'Pause'}</button><button class="icon-button" data-action="stop" data-id="${m.id}" aria-label="Stop mission" title="Stop mission">${icon('stop')}</button>` : ''}<button class="icon-button" data-action="mission-chat" data-id="${m.id}" aria-label="Open mission chat" title="Open mission chat">${icon('chat')}</button></div></div><div class="mp-detail-meta"><span>${avatar(m.lead,'small')}Led by ${bots[m.lead].name}</span><span>${icon('team')}${m.team.length} ${m.team.length===1 ? 'teammate' : 'teammates'}</span><span>${icon('clock')}${esc(m.deadline)}</span></div><div class="mp-detail-layout"><div class="mp-main-column">${question(m)}<section class="mp-panel"><div class="mp-panel-title"><h2>${m.status==='achieved' ? 'Mission accomplished' : 'Happening now'}</h2><span>${esc(m.updated)}</span></div><div class="mp-now"><div class="mp-now-orbit ${m.status==='working' || m.status==='planning' ? 'working' : ''}">${avatar(m.lead,'large')}</div><div class="mp-now-copy"><small>${bots[m.lead].name} · Mission lead</small><h3>${esc(m.now)}</h3><p>${esc(m.nowNote)}</p></div></div>${progressMarkup(m,true)}<p class="mp-progress-note">${p.total ? 'Based on verified outcomes, including the final review.' : 'Progress begins once the required outcomes are defined.'}</p></section><section class="mp-panel"><div class="mp-panel-title"><h2>What success looks like</h2><span>${p.total ? `${p.done} / ${p.total} verified` : 'Being defined'}</span></div>${m.criteria.length ? `<ol class="mp-criteria">${m.criteria.map((c,i)=>`<li class="mp-criterion"><span class="mp-step-check ${c.done ? 'done' : currentIndex===i && m.status==='working' ? 'current' : ''}">${c.done ? icon('check') : i+1}</span><div><strong>${esc(c.title)}</strong><small>${esc(c.note)}</small>${c.done ? `<button class="mp-evidence" data-action="artifact" data-id="${m.id}" data-index="${i}">${icon('file')}View evidence</button>` : ''}</div></li>`).join('')}</ol>` : `<p class="mp-progress-note">${bots[m.lead].name} is turning your goal into clear, checkable outcomes. No percentage is estimated yet.</p>`}</section><section class="mp-panel"><div class="mp-panel-title"><h2>Activity</h2><span>Meaningful updates</span></div><ol class="mp-timeline">${m.events.map(e=>`<li class="mp-event"><span class="mp-event-mark">${icon(e.kind)}</span><div><strong>${esc(e.title)}</strong><small>${esc(e.detail)}</small></div><time>${esc(e.time)}</time></li>`).join('')}</ol></section>${!finished(m) ? `<div class="mp-demo-controls"><span>Prototype controls<br>Preview the next stage of this mission.</span><button class="secondary-button" data-action="advance" data-id="${m.id}" ${['paused','attention'].includes(m.status) ? 'disabled' : ''}>${m.status==='planning' ? 'Define outcomes' : m.status==='waiting' ? 'Simulate new information' : p.done===p.total-1 ? 'Simulate final review' : 'Verify next outcome'}${icon('arrow')}</button></div>` : ''}</div><aside class="mp-side-column"><section class="mp-panel"><div class="mp-panel-title"><h2>The team</h2><span>${m.team.length} involved</span></div>${m.team.map(id=>`<div class="mp-person">${avatar(id)}<div class="mp-person-copy"><strong>${bots[id].name}${id===m.lead ? '<span class="mp-lead-label">Lead</span>' : ''}</strong><small>${teamTask(m,id)}</small></div>${finished(m) ? '' : `<span class="mp-person-state ${id==='scout' && m.id==='autumn-launch' ? 'done' : ''}" title="${id==='scout' && m.id==='autumn-launch' ? 'Research delivered' : 'Assigned to mission'}"></span>`}</div>`).join('')}</section><section class="mp-panel"><div class="mp-panel-title"><h2>Results</h2><span>${p.done} available</span></div>${files(m)}</section><section class="mp-panel"><div class="mp-panel-title"><h2>Resources</h2>${icon('lock')}</div><dl class="mp-resources"><div><dt>Execution</dt><dd>Home engine</dd></div><div><dt>Model usage</dt><dd>Not connected</dd></div><div><dt>External spending</dt><dd>Not enabled</dd></div><div><dt>External actions</dt><dd>Ask when needed</dd></div></dl><p class="mp-resource-footnote">This prototype shows the intended controls. No engine, tools or paid services are connected.</p></section><button class="secondary-button" data-action="direction" data-id="${m.id}" ${finished(m) ? 'disabled' : ''}>${icon('chat')}Add direction</button></aside></div><p class="mp-detail-footer">Demo data · Pause, recovery and verification are simulated.</p></section>`;
  }
  function teamTask(m,id) {
    if (m.status==='achieved') return id===m.lead ? 'Delivered the final package' : 'Review complete';
    if (m.status==='stopped') return 'Work stopped · Results retained';
    if (m.status==='paused') return 'Paused with the mission';
    if (id==='echo') return m.criteria.filter(c=>!c.done).length===1 ? 'Checking the final package' : 'Final review queued';
    if (id===m.lead) return m.status==='attention' ? 'Waiting for your answer' : m.status==='waiting' ? 'Waiting for new information' : 'Coordinating the next step';
    return id==='scout' ? 'Research and source checks' : 'Preparing the content kit';
  }
  function chatCard(m) {
    if (!m) return '';
    return `<div class="mp-chat-mission"><div class="mp-chat-mission-head"><span>Mission · Linked to this chat</span>${status(m)}</div><h2>${esc(m.title)}</h2>${progressMarkup(m)}${question(m)}<button class="mp-link" data-nav="missions/${m.id}">Open Mission${icon('arrow')}</button></div>`;
  }
  function chatPage(id='atlas') {
    if (!bots[id]) id='atlas';
    const chatDraft = chatDrafts[id] || '';
    const linked = missions.find(m=>m.chatPinned===id) || (id==='atlas' ? find('autumn-launch') : missions.find(m=>m.lead===id));
    const messages = customMessages.filter(msg=>msg.bot===id);
    return `<section class="mp-page mp-chat-page"><div class="mp-chat-heading"><div class="mp-chat-person">${avatar(id,'large')}<div><h1>${bots[id].name}</h1><p>${bots[id].role}</p></div></div><button class="secondary-button" data-action="new" data-lead="${id}">${icon('mission')}New Mission</button></div><div class="mp-chat-history"><div class="mp-message user"><div class="mp-bubble">${linked ? `Make this a Mission: ${esc(linked.goal)}` : 'I’d like to work on a new goal with you.'}</div></div><div class="mp-message">${avatar(id,'small')}<div class="mp-message-body"><small>${bots[id].name}</small><p>${linked ? 'I’ve brought the goal, team and results together in Mission. You can follow the work here, too.' : 'Tell me what you want to achieve. You can ask me to start a Mission whenever you’re ready.'}</p>${linked ? chatCard(linked) : ''}</div></div>${messages.map(msg=>msg.type==='user' ? `<div class="mp-message user"><div class="mp-bubble">${esc(msg.text)}</div></div>` : `<div class="mp-message">${avatar(id,'small')}<div class="mp-message-body"><small>${bots[id].name}</small><p>${esc(msg.text)}</p>${msg.missionId ? chatCard(find(msg.missionId)) : ''}${msg.offer ? `<button class="secondary-button" data-action="promote" data-index="${customMessages.indexOf(msg)}">${icon('mission')}Create Mission</button>` : ''}</div></div>`).join('')}</div><div class="mp-chat-examples" aria-label="Try a chat scenario"><button data-example="explicit">Explicit Mission</button><button data-example="clear">Clear goal</button><button data-example="explore">Explore an idea</button><button data-example="hypothetical">Hypothetical</button></div><form class="mp-composer" id="chat-form"><textarea id="chat-input" aria-label="Message ${bots[id].name}" placeholder="Give ${bots[id].name} a goal…" rows="2" maxlength="1500">${esc(chatDraft)}</textarea><button class="primary-button" aria-label="Send message">${icon('send')}</button></form><p class="mp-chat-hint">Scripted demo · Try a scenario above. New Mission cards appear in the Mission tab.</p></section>`;
  }
  function botsPage() {
    return `<section class="mp-page"><div class="mp-heading"><div><h1>Your Tupies</h1><p>Start with a conversation. Give it a mission when the goal is clear.</p></div></div><div class="mp-bot-options">${Object.entries(bots).map(([id,b])=>`<button class="mp-panel mp-bot-option" data-nav="chat/${id}">${avatar(id,'large')}<span><strong>${b.name}</strong><small>${b.role}</small></span>${icon('arrow')}</button>`).join('')}</div><p class="mp-detail-footer">These teammates are part of the demo workspace.</p></section>`;
  }
  function render(keepScroll=false) {
    const r = route();
    const y = window.scrollY;
    let page;
    if (r.view==='missions') page = r.id ? detailPage(find(r.id)) : listPage();
    else if (r.view==='chat') page = chatPage(r.id);
    else if (r.view==='bots') page = botsPage();
    else if (r.view==='dashboard') page = `<section class="mp-page"><div class="mp-heading"><div><h1>A little progress, every day.</h1><p>Your Mission overview, brought into the workspace.</p></div></div><div class="mp-grid">${missions.filter(m=>!finished(m)).slice(0,2).map(card).join('')}</div><div class="mp-list-footer"><button class="mp-link" data-nav="missions">See all missions${icon('arrow')}</button></div></section>`;
    else page = `<section class="mp-page"><div class="mp-heading"><div><h1>${r.view==='rooms' ? 'Team rooms' : 'Routines'}</h1><p>This preview focuses on Mission and its connection to chat.</p></div></div><div class="mp-empty">${icon(r.view==='rooms' ? 'team' : 'routine')}<h2>${r.view==='rooms' ? 'A shared place for your team' : 'Your recurring work, on schedule'}</h2><p>The existing ${r.view==='rooms' ? 'Team rooms' : 'Routines'} module stays in the navigation.</p><button class="secondary-button" data-nav="missions">Explore Mission${icon('arrow')}</button></div></section>`;
    app.innerHTML = shell(page,r);
    document.title = `${r.id && r.view==='missions' ? find(r.id)?.title || 'Mission' : r.view==='chat' ? bots[r.id]?.name || 'Chat' : 'Mission'} · Tupies`;
    if (keepScroll) window.scrollTo(0,y);
  }
  function go(path) {
    if (dialog.open) closeDialog();
    const hash = '#/'+path;
    if (location.hash===hash) {render();window.scrollTo(0,0);} else location.hash=hash;
  }
  function toast(message) {
    const el = $('#mp-toast');
    el.textContent = message;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>el.classList.remove('visible'),3800);
  }
  function showDialog(title,description,body) {
    dialogOpener = document.activeElement;
    dialog.innerHTML = `<div class="mp-dialog-head"><div><h2 id="dialog-title">${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}</div><button class="icon-button" data-action="close" aria-label="Close dialog">${icon('close')}</button></div>${body}`;
    dialog.showModal();
    const field = $('textarea, input, select',dialog);
    if (field) field.focus();
  }
  function closeDialog() { dialog.close(); if (dialogOpener?.isConnected) dialogOpener.focus(); }
  function createForm(lead='atlas',goal='') {
    showDialog('A new Mission','A goal for your team. A clear place to follow the work.',`<form id="create-form"><div class="mp-field"><label for="mission-goal">What would you like to achieve?</label><textarea id="mission-goal" name="goal" placeholder="For example, compare five knowledge tools and recommend the best fit for our team…" required maxlength="1000">${esc(goal)}</textarea><p class="mp-field-help">Describe the result you want. Your lead will work out the steps.</p></div><div class="mp-field"><label for="mission-lead">Who should lead?</label><select id="mission-lead" name="lead">${Object.entries(bots).map(([id,b])=>`<option value="${id}" ${id===lead?'selected':''}>${b.name} · ${b.role}</option>`).join('')}</select></div><details><summary>Add success criteria or a deadline</summary><div class="mp-field"><label for="mission-criteria">Required outcomes <span class="mp-field-help">(optional)</span></label><textarea id="mission-criteria" name="criteria" placeholder="One outcome per line" maxlength="1500"></textarea><p class="mp-field-help">A final review is always included.</p></div><div class="mp-field"><label for="mission-deadline">Target date <span class="mp-field-help">(optional)</span></label><input id="mission-deadline" name="deadline" type="date"></div></details><p class="mp-dialog-demo">Demo workspace · Starting creates a local preview. No bots or services run.</p><div class="mp-dialog-actions"><button type="button" class="secondary-button" data-action="close">Cancel</button><button class="primary-button">${icon('mission')}Start Mission</button></div></form>`);
  }
  function makeMission(goal,lead,criteria=[],deadline='',title) {
    const cleaned = criteria.map(s=>s.trim()).filter(Boolean).slice(0,8);
    const m = {id:`demo-${nextId++}`,title:title || (goal.length>76 ? goal.slice(0,73)+'…' : goal),goal,lead,team:[lead],status:cleaned.length ? 'working' : 'planning',updated:'Just now',created:'Just now',deadline:deadline || 'No deadline',now:cleaned.length ? 'Starting with the first outcome' : 'Turning your goal into a plan',nowNote:cleaned.length ? 'The required outcomes are ready for the lead to work through.' : 'Your lead is defining the results and the checks that will prove they are complete.',criteria:cleaned.length ? [...cleaned.map(t=>criterion(t,'Required outcome · Awaiting work',false,t)),criterion('Verify the complete result','Final check against your goal',false,'Final review')] : [],events:[{title:'Mission created',detail:`${bots[lead].name} is leading this goal.`,time:'Now',kind:'mission'}]};
    missions.unshift(m);return m;
  }
  function event(m,title,detail,kind='activity') { m.events.unshift({title,detail,kind,time:'Now'});m.updated='Just now'; }
  function answer(m,value) {
    if (m.status!=='attention' || !m.request) return;
    if (m.request.type==='approval') {
      const allowed=value==='Allow once';
      event(m,allowed ? 'You approved the sample read once' : 'You denied the sample read',allowed ? 'Only the exact displayed demo request was approved.' : 'No read was made. The team will use the material it already has.','lock');
      m.request=null;m.status='working';m.now=allowed ? 'Reviewing the sample export metadata' : 'Continuing with the available research';m.nowNote=allowed ? 'The one-time approval has been consumed in this simulation.' : 'The denied request will not be retried.';
      render(true);toast(allowed ? 'One demo read approved. No service was contacted.' : 'Demo read denied. The team will use its existing research.');return;
    }
    event(m,'You answered the open question',value,'chat');
    m.answer=value;m.request=null;m.status='working';m.now='Preparing the content for your audience';m.nowNote=`The team is continuing with your direction: ${value}`;
    if (dialog.open) closeDialog();render(true);toast('Answer shared. The same update is visible in chat and Mission.');
  }
  function advance(m) {
    if (finished(m) || ['paused','attention'].includes(m.status)) return;
    if (!m.criteria.length) {
      m.criteria=[criterion('Research and define the approach','Evidence and assumptions documented',false,'Approach & evidence'),criterion('Produce the requested result','A complete deliverable aligned with your goal',false,'Mission result'),criterion('Verify the complete result','Final acceptance against the goal',false,'Final review')];
      m.status='working';m.now='Researching the approach';m.nowNote='The required outcomes are now defined.';event(m,'Required outcomes defined','Three outcomes, including final verification.','mission');
    } else if (m.status==='waiting') {m.status='working';m.now='Comparing the available venues';m.nowNote='The simulated availability update has arrived.';event(m,'New information received','The waiting mission can continue.','clock');}
    else {
      const next=m.criteria.find(c=>!c.done);
      if (!next) return;
      next.done=true;next.note='Verified in the prototype · Sample evidence attached';event(m,`${next.file} verified`,'The result meets this demonstration’s outcome check.','check');
      const remaining=m.criteria.find(c=>!c.done);
      if (!remaining) {m.status='achieved';m.now='All outcomes verified';m.nowNote='The complete package passed its final review. Your results are ready.';event(m,'Mission achieved','Every required outcome, including final review, has been verified.','mission');}
      else if(m.id==='knowledge-tools' && !m.approvalShown) {m.approvalShown=true;m.status='attention';m.now='A sample integration read needs approval';m.nowNote='Scout can continue after your decision.';m.request={type:'approval',title:'Read the sample export metadata once?',description:'Scout · Demo Knowledge connector · GET /sample/export-metadata · Read only · One request. No service is contacted in this prototype.',options:['Allow once','Deny']};event(m,'A one-time read needs approval','The exact sample request is ready for your review.','lock');}
      else {m.now=remaining.title;m.nowNote='The team is working toward the next required outcome.';}
    }
    render(true);toast(m.status==='achieved' ? 'Demo mission achieved. All results are available.' : 'Demo advanced. Progress reflects the verified results.');
  }
  function artifact(m,index) {
    const c=m.criteria[index];if(!c?.done)return;
    const review=index===m.criteria.length-1;
    showDialog(c.file,'Sample document · A preview of the result and its evidence.',`<div class="mp-preview-meta"><span>${icon('check')}Outcome verified</span><span>Prepared for ${esc(m.title)}</span></div><article class="mp-preview-document"><h3>${esc(c.title)}</h3><p>${esc(m.goal)}</p><h4>${review ? 'Acceptance summary' : 'What’s included'}</h4><ul>${review ? m.criteria.map(item=>`<li>${esc(item.title)} — ${item.done ? 'verified' : 'pending'}</li>`).join('') : `<li>A concise summary grounded in the mission’s goal.</li><li>The decisions, supporting material and practical next steps.</li><li>A clear handoff for the next teammate.</li>`}</ul><h4>Evidence note</h4><p>${esc(c.note)}. This is an illustrative document for the interface prototype; it is not a real research result.</p></article><div class="mp-dialog-actions"><button class="secondary-button" data-action="close">Close</button><button class="primary-button" data-action="download" data-id="${m.id}" data-index="${index}">${icon('download')}Download sample</button></div>`);
  }
  function submitChat(text) {
    const bot=bots[route().id] ? route().id : 'atlas';
    customMessages.push({type:'user',text,bot});
    const negative=/(hypothetical|what if|imagine|don.t (?:start|create)|do not (?:start|create)|не (?:створюй|запускай)|уяви|гіпотетич)/i.test(text) || /^\s*["“«>]/.test(text);
    const explicit=/^\s*(?:(?:please|can you|could you)\s+)?(?:(?:start|create|launch)\s+(?:a\s+|an?\s+new\s+)?mission\s*[:—-]?|make\s+this\s+a\s+mission\s*[:—-]?|(?:створи|запусти|почни)\s+(?:нову\s+)?місію\s*[:—-]?)/i.test(text);
    const clear=text===examples.clear;
    const duplicate=missions.find(m=>m.chatSource===text && m.lead===bot);
    if (duplicate && !negative) {customMessages.push({type:'bot',bot,text:'This goal already has a Mission. Here is the same one, with its current progress.',missionId:duplicate.id});}
    else if (!negative && (explicit||clear)) {
      const goal=text.replace(/^(?:start|create|make this a)\s+(?:a\s+)?mission\s*[:—-]?\s*/i,'').trim()||text;
      const m=makeMission(goal,bot,[],'',clear?'Prepare a customer interview kit':undefined);m.chatSource=text;
      event(m,'Created from your conversation','This chat and the Mission tab share the same goal.','chat');
      customMessages.push({type:'bot',bot,text:'I’ve created a Mission for this goal. The plan and verified results will stay connected to this chat.',missionId:m.id});
    } else {customMessages.push({type:'bot',bot,text:negative?'We can explore this as a hypothetical. No Mission has been created.':'Let’s explore the idea here. When you want to work toward a concrete result, you can turn it into a Mission.',offer:!negative,goal:text});}
    chatDrafts[bot]='';render(true);$('#chat-form').scrollIntoView({block:'end',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});$('#chat-input').focus();
  }
  const examples={explicit:'Start a Mission: prepare a concise onboarding guide and a first-week checklist for new teammates.',clear:'Prepare a customer interview kit: research the audience, write ten questions, and deliver a ready-to-use interview guide.',explore:'Help me think about ways to improve our onboarding.',hypothetical:'Hypothetical: what if a bot could create a Mission to organise a launch? Don’t start anything yet.'};
  document.addEventListener('click', e => {
    if(e.target.closest('.mp-skip')){e.preventDefault();$('#main-content').focus();$('#main-content').scrollIntoView({block:'start'});return;}
    const target=e.target.closest('button');if(!target)return;
    if(target.dataset.nav){go(target.dataset.nav);return;}
    if(target.dataset.filter){filter=target.dataset.filter;render(true);$(`[data-filter="${filter}"]`).focus();return;}
    if(target.dataset.example){chatDrafts[route().id||'atlas']=examples[target.dataset.example];$('#chat-input').value=examples[target.dataset.example];$('#chat-input').focus();return;}
    const action=target.dataset.action;if(!action)return;
    const m=find(target.dataset.id);
    if(action==='new')createForm(target.dataset.lead||'atlas');
    else if(action==='close')closeDialog();
    else if(action==='theme'){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';render(true);$('[data-action="theme"]').focus();}
    else if(action==='clear-search'){query='';render(true);$('#mission-search').focus();}
    else if(action==='answer'&&m)answer(m,m.request.options[Number(target.dataset.option)]);
    else if(action==='custom-answer'&&m)showDialog('Your direction',m.request.title,`<form id="answer-form" data-id="${m.id}"><label for="answer-text">Your answer</label><textarea id="answer-text" name="answer" required maxlength="600"></textarea><div class="mp-dialog-actions"><button type="button" class="secondary-button" data-action="close">Cancel</button><button class="primary-button">Send answer</button></div></form>`);
    else if(action==='advance'&&m)advance(m);
    else if(action==='pause'&&m){if(m.status==='paused'){m.status=m.previousStatus||'working';m.now=m.previousNow;m.nowNote=m.previousNote;event(m,'Mission resumed','The team continues from the saved stage.','play');}else{m.previousStatus=m.status;m.previousNow=m.now;m.previousNote=m.nowNote;m.status='paused';m.now='Paused by you';m.nowNote='The current stage and every verified result are retained.';event(m,'Mission paused','No work continues until you resume.','pause');}render(true);toast(m.status==='paused'?'Demo paused. Verified results are retained.':'Demo resumed from its saved stage.');}
    else if(action==='stop'&&m)showDialog('Stop this Mission?','The team will stop. Verified results and partial progress stay available.',`<p class="mp-dialog-demo">This control changes only the prototype’s local state.</p><div class="mp-dialog-actions"><button class="secondary-button" data-action="close">Keep working</button><button class="danger-button" data-action="confirm-stop" data-id="${m.id}">${icon('stop')}Stop Mission</button></div>`);
    else if(action==='confirm-stop'&&m){m.status='stopped';m.request=null;m.now='Stopped by you';m.nowNote='Partial progress and verified results are available below.';event(m,'Mission stopped','Existing results were retained. The goal is not marked achieved.','stop');closeDialog();render(true);toast('Mission stopped. Its results are retained.');}
    else if(action==='artifact'&&m)artifact(m,Number(target.dataset.index));
    else if(action==='download'&&m){const c=m.criteria[Number(target.dataset.index)];if(!c?.done)return;const blob=new Blob([`# ${c.file}\n\nDEMONSTRATION DOCUMENT — NOT A REAL RESEARCH RESULT\n\nMission: ${m.title}\nGoal: ${m.goal}\n\nOutcome: ${c.title}\nEvidence: ${c.note}\n\nThis sample illustrates the Tupies Mission result flow.\n`],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='tupies-mission-sample.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Sample document downloaded.');}
    else if(action==='mission-chat'&&m){missions.forEach(item=>{if(item.chatPinned===m.lead)delete item.chatPinned;});m.chatPinned=m.lead;go(`chat/${m.lead}`);}
    else if(action==='direction'&&m)showDialog('Add direction','Keep the goal clear as the work evolves.',`<form id="direction-form" data-id="${m.id}"><label for="direction-text">What should the team keep in mind?</label><textarea id="direction-text" name="direction" required maxlength="600" placeholder="For example, prioritise clarity over a long report…"></textarea><p class="mp-dialog-demo">The direction will appear in this demo mission’s activity. It does not change permissions.</p><div class="mp-dialog-actions"><button type="button" class="secondary-button" data-action="close">Cancel</button><button class="primary-button">Share with the team</button></div></form>`);
    else if(action==='promote'){const msg=customMessages[Number(target.dataset.index)];if(!msg?.offer)return;const mission=makeMission(msg.goal,msg.bot);mission.chatSource=msg.goal;msg.offer=false;msg.missionId=mission.id;msg.text='This conversation is now linked to a Mission. The goal appears in your Mission tab.';render(true);toast('Mission created from this conversation.');}
    else if(action==='about')showDialog('Mission prototype','A connected view of goals, teammates and verified results.',`<article class="mp-preview-document"><p>Explore the Mission list, open a goal, answer a question, preview a result, or start a new Mission from the tab or chat.</p><p>All interactions use scripted demo data in memory. Reloading restores the original examples. No model, Engine, account or service is connected.</p><p>Pause and recovery show the intended future experience. Actual implementation is covered by the Mission product plan.</p></article><div class="mp-dialog-actions"><button class="secondary-button" data-action="reset">Reset demo</button><button class="primary-button" data-action="close">Keep exploring</button></div>`);
    else if(action==='reset'){missions=initialMissions();customMessages=[];chatDrafts={};filter='active';query='';nextId=1;closeDialog();go('missions');toast('Demo reset.');}
  });
  document.addEventListener('input', e=>{if(e.target.id==='mission-search'){query=e.target.value;$('#mission-grid').innerHTML=cardsMarkup();}if(e.target.id==='chat-input')chatDrafts[route().id||'atlas']=e.target.value;});
  document.addEventListener('submit', e=>{
    if(!['create-form','answer-form','direction-form','chat-form'].includes(e.target.id))return;
    e.preventDefault();const form=e.target;
    if(form.id==='chat-form'){const value=$('#chat-input').value.trim();if(value)submitChat(value);return;}
    const data=new FormData(form);
    if(form.id==='create-form'){const goal=String(data.get('goal')).trim();if(!goal){$('#mission-goal').focus();return;}const m=makeMission(goal,String(data.get('lead')),String(data.get('criteria')||'').split('\n'),String(data.get('deadline')||''));closeDialog();go(`missions/${m.id}`);toast('Demo Mission started.');}
    else if(form.id==='answer-form'){const value=String(data.get('answer')).trim();if(value)answer(find(form.dataset.id),value);}
    else {const value=String(data.get('direction')).trim();if(!value)return;const m=find(form.dataset.id);event(m,'You added direction',value,'chat');closeDialog();render(true);toast('Direction added to the mission activity.');}
  });
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog();}});
  window.addEventListener('hashchange',()=>{render();window.scrollTo(0,0);$('#main-content').focus({preventScroll:true});});
  render();
})();
