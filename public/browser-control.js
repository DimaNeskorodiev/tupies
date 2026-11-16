/* Owner-operated browser handoff: a live remote view of the bot's browser that the owner uses directly.
   Page pixels and typed text stay in this panel. Typed text is forwarded at once and never kept in the DOM,
   storage, logs or error messages. The Engine owns the lease, identity checks and input admission. */
(() => {
  'use strict';
  // Tunable for tests; production values follow the stream contract (heartbeats every 5 s).
  const timing={watchdog:15000,backoff:[1000,2000,4000,8000,15000],input:10000,resume:20000,resize:250,hover:33,drag:16,drain:3000,notice:6000,escape:800,decode:400};
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const svg=path=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  const icons={close:'M6 6l12 12M18 6 6 18',back:'M15 5l-7 7 7 7',forward:'m9 5 7 7-7 7',reload:'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',lock:'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',warn:'M12 3 2 21h20L12 3Zm0 7v5m0 3h.01',keyboard:'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10'};
  // [local field type, inputmode, placeholder]: the field only forwards; it never keeps what is typed.
  const KINDS={text:['text','text','Type into the page'],password:['password','text','Type the password'],email:['text','email','Type the email'],tel:['text','tel','Type the phone number'],number:['text','decimal','Type the number'],url:['text','url','Type the address'],search:['text','search','Type your search'],otp:['text','numeric','Type or paste the code'],textarea:['text','text','Type into the page'],other:['text','text','Type into the page']};
  const FINAL={
    replaced:['This browser is open somewhere else','You opened it in another window or device. Take control here to continue in this one.'],
    resumed:['Your bot has the browser again','This help request is finished.'],
    expired:['This help request timed out','The bot stopped waiting. You can close this window.'],
    cancelled:['The task was stopped','You can close this window.'],
    closed:['The browser was closed','You can close this window.'],
    signedout:['You were signed out','Sign in to Tupies again, then reopen the browser from the chat.'],
    ended:['This help request has ended','Your bot is no longer waiting for the browser. You can close this window.'],
  };
  const PHASES={connecting:'Connecting…',live:'Live',reconnecting:'Reconnecting…',paused:'Paused',offline:'Not connected',ended:'Ended',replaced:'Open elsewhere'};
  // AltGr (reported as Ctrl+Alt on Windows/Linux) types characters such as @ € \; it is not a shortcut.
  const modifiers=event=>{const altGraph=!!event.getModifierState?.('AltGraph');return (event.altKey&&!altGraph?1:0)|(event.ctrlKey&&!altGraph?2:0)|(event.metaKey?4:0)|(event.shiftKey?8:0);};
  const coarse=()=>!!window.matchMedia?.('(pointer: coarse)')?.matches;
  let active=null;
  const identityFor=(run,control)=>({runId:run.id,remoteRunId:run.remoteRunId||run.id,request_id:control.prompt_id,execution_generation:run.execution_generation});

  function renderCard(bot,run) {
    const control=run.pending_controls?.find(item=>item?.kind==='browser');if(!control)return '';
    const identity=escape(JSON.stringify(identityFor(run,control))),stop=escape(JSON.stringify({runId:run.id,remoteRunId:run.remoteRunId||run.id})),reason=String(control.reason||'').slice(0,500);
    return `<section class="browser-handoff-card" data-message-key="browser-${escape(control.prompt_id)}"><h3>${escape(bot.name)} needs your help in the browser</h3><p>${escape(reason||'Complete the sign-in or verification, then return control to your bot.')}</p><p class="subtle-label">Open the bot’s browser to sign in, enter a verification code or complete a CAPTCHA yourself.</p><div class="approval-actions"><button type="button" class="primary-button" data-action="browser-handoff" data-id="${escape(bot.id)}" data-browser-identity="${identity}" data-browser-reason="${escape(reason)}">Open browser</button><button type="button" class="text-button" data-action="stop-run" data-id="${escape(bot.id)}" data-run="${stop}">Stop task</button></div></section>`;
  }

  /* ---------- lifecycle ---------- */
  function current(state) {return active===state&&state.dialog.isConnected&&state.dialog.open&&(!state.context.valid||state.context.valid());}
  function reset() {
    const state=active;active=null;if(!state)return;
    state.abort.abort();state.conn?.abort.abort();state.inflight?.controller.abort();
    for(const timer of ['retryTimer','flushTimer','resizeTimer','noticeTimer'])clearTimeout(state[timer]);if(state.conn)clearTimeout(state.conn.timer);
    state.observer?.disconnect();for(const [target,type,handler] of state.listeners)target.removeEventListener(type,handler);
    state.queue.length=0;state.pending=null;state.nextFrame=null;state.pressed.clear();state.touches.clear();
    state.dialog.querySelectorAll('input:not([type=checkbox]),textarea').forEach(input=>{input.value='';});
    state.frames.forEach(image=>image.removeAttribute('src'));
    document.body.classList.remove('browser-control-open');
    if(state.dialog.open)try{state.dialog.close();}catch{state.dialog.removeAttribute('open');}
    state.dialog.remove();
  }
  function open(context,botId,identity) {
    reset();
    const dialog=document.createElement('dialog');dialog.className='browser-control-dialog';dialog.setAttribute('aria-labelledby','browser-control-title');
    const botName=String(context.botName||'your bot').slice(0,80),reason=String(context.reason||'').slice(0,500);
    dialog.innerHTML=`<section class="browser-control-panel" data-phase="connecting">
<header class="browser-control-head"><button type="button" class="browser-control-icon" data-browser-close aria-label="Close the browser. Your bot stays paused.">${svg(icons.close)}</button><div class="browser-control-heading"><h2 id="browser-control-title">Help ${escape(botName)} in the browser</h2><p class="browser-control-reason" data-browser-reason>${escape(reason||'Sign in or complete the check, then resume your bot.')}</p></div><p class="browser-control-connection" data-browser-connection role="status" aria-live="polite"><span class="browser-control-dot" aria-hidden="true"></span><span data-browser-connection-text>Connecting…</span></p></header>
<div class="browser-control-toolbar"><button type="button" class="browser-control-icon" data-browser-history="back" aria-label="Back" disabled>${svg(icons.back)}</button><button type="button" class="browser-control-icon" data-browser-history="forward" aria-label="Forward" disabled>${svg(icons.forward)}</button><button type="button" class="browser-control-icon" data-browser-history="reload" aria-label="Reload page" disabled>${svg(icons.reload)}</button><form class="browser-control-address" data-browser-address-form novalidate><button type="button" class="browser-control-site" data-browser-site aria-label="Website address. Select to change it."><span class="browser-control-security" data-browser-security>${svg(icons.lock)}</span><span class="browser-control-host" data-browser-host>Opening…</span><span class="browser-control-path" data-browser-path></span></button><input type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="2000" aria-label="Website address" placeholder="https://example.com" data-browser-address hidden></form><button type="button" class="browser-control-icon browser-control-keyboard" data-browser-keyboard aria-pressed="false" aria-label="Type into the page">${svg(icons.keyboard)}<span>Type</span></button></div>
<div class="browser-control-progress" data-browser-progress hidden></div>
<div class="browser-control-tabs" data-browser-tabs role="group" aria-label="Browser tabs" hidden></div>
<div class="browser-control-stage"><p class="browser-control-notice" data-browser-notice role="status" aria-live="polite" hidden><span data-browser-notice-text></span><button type="button" class="text-button" data-browser-notice-action hidden></button></p><div class="browser-control-surface" data-browser-surface role="application" aria-roledescription="remote browser" aria-label="Live page from the bot’s browser. Click or tap to use it. Typing goes to the page; press Escape twice to stop." aria-describedby="browser-control-focus-hint"><img class="browser-control-frame is-front" alt="" draggable="false"><img class="browser-control-frame" alt="" draggable="false" aria-hidden="true"><textarea class="browser-control-sink" data-browser-sink rows="1" aria-label="Keyboard input for the page" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" inputmode="none"></textarea><p class="browser-control-focus-hint" id="browser-control-focus-hint" data-browser-focus-hint>Typing goes to the page · Esc twice to stop</p><div class="browser-control-overlay" data-browser-overlay><div class="browser-control-overlay-card"><h3 data-browser-overlay-title>Connecting to the browser…</h3><p data-browser-overlay-text>The live page appears here in a moment.</p><div class="browser-control-overlay-actions" data-browser-overlay-actions></div></div></div><section class="browser-control-site-dialog" data-browser-site-dialog role="alertdialog" aria-labelledby="browser-control-site-title" hidden><h3 id="browser-control-site-title" data-browser-site-type></h3><p data-browser-site-message></p><label data-browser-site-input hidden>Response<input type="text" maxlength="2000" autocomplete="off" autocapitalize="off" spellcheck="false" data-browser-site-prompt></label><div class="browser-control-site-actions"><button type="button" class="secondary-button" data-browser-dialog-accept="false">Cancel</button><button type="button" class="primary-button" data-browser-dialog-accept="true">OK</button></div></section></div></div>
<div class="browser-control-typer" data-browser-typer hidden><input type="text" inputmode="text" enterkeyhint="enter" autocomplete="one-time-code" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Type into the page" placeholder="${escape(KINDS.text[2])}" data-browser-type><button type="button" class="secondary-button" data-browser-typer-done>Done</button></div>
<footer class="browser-control-footer"><label class="browser-control-retain"><input type="checkbox" data-browser-retain><span>Keep this sign-in on this engine<small>Lets this bot reuse its browser sign-in on this Mac or server. It does not sync to other engines.</small></span></label><div class="browser-control-actions"><button type="button" class="secondary-button" data-browser-resume="skip">Skip help</button><button type="button" class="primary-button" data-browser-resume="resume">Resume bot</button></div></footer>
</section>`;
    document.body.append(dialog);
    const $=selector=>dialog.querySelector(selector);
    const els={panel:$('.browser-control-panel'),surface:$('[data-browser-surface]'),sink:$('[data-browser-sink]'),typer:$('[data-browser-typer]'),type:$('[data-browser-type]'),address:$('[data-browser-address]'),site:$('[data-browser-site]'),retain:$('[data-browser-retain]')};
    const state={context,botId,identity:{...identity},dialog,els,frames:[...dialog.querySelectorAll('.browser-control-frame')],abort:new AbortController(),listeners:[],conn:null,connSeq:0,phase:'connecting',everLive:false,attempts:0,final:null,streamId:null,seq:0,queue:[],pending:null,inflight:null,conflictRetried:false,nextFrame:null,decoding:false,shown:null,page:{tabId:null,nav:null,url:'',title:'',tabs:[],loading:false,canGoBack:false,canGoForward:false,focus:null},siteDialog:null,touches:new Map(),pressed:new Map(),click:null,mouseDown:false,escapeAt:0,composing:false,viewport:null,retentionSet:false,resuming:false,typerPinned:false};
    active=state;
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
    document.body.classList.add('browser-control-open');
    dialog.addEventListener('close',()=>{if(active===state)reset();});
    // Escape belongs to the page while keystrokes go there; otherwise it closes the window as usual.
    dialog.addEventListener('cancel',event=>{if(typing(state))event.preventDefault();});
    bind(state);watchSize(state);
    if(!document.hidden)void connect(state);else setPhase(state,'paused');
    return state;
  }
  function listen(state,target,type,handler,options) {target.addEventListener(type,handler,options);state.listeners.push([target,type,handler]);}
  function typing(state) {const focused=document.activeElement;return focused===state.els.sink||focused===state.els.type||focused===state.els.address||!!focused?.matches?.('[data-browser-site-prompt]');}

  /* ---------- presentation ---------- */
  function setPhase(state,phase) {
    state.phase=phase;const panel=state.els.panel;panel.dataset.phase=phase;
    state.dialog.querySelector('[data-browser-connection-text]').textContent=PHASES[phase]||phase;
    const live=phase==='live';
    state.dialog.querySelectorAll('[data-browser-history]').forEach(button=>{const action=button.dataset.browserHistory;button.disabled=!live||(action==='back'&&!state.page.canGoBack)||(action==='forward'&&!state.page.canGoForward);});
    state.dialog.querySelectorAll('[data-browser-tab]').forEach(button=>{button.disabled=!live;});
    state.els.surface.setAttribute('aria-disabled',String(!live));
    overlay(state);
  }
  function overlay(state) {
    const node=state.dialog.querySelector('[data-browser-overlay]'),title=node.querySelector('[data-browser-overlay-title]'),text=node.querySelector('[data-browser-overlay-text]'),actions=node.querySelector('[data-browser-overlay-actions]');
    let show=false,heading='',body='',buttons='';
    if(state.final){show=true;[heading,body]=FINAL[state.final]||FINAL.closed;buttons=state.final==='replaced'?'<button type="button" class="primary-button" data-browser-take>Take control here</button>':'<button type="button" class="primary-button" data-browser-close>Close</button>';}
    else if(state.failure){show=true;heading='Couldn’t open the browser';body=state.failure;buttons='<button type="button" class="primary-button" data-browser-retry>Try again</button>';}
    // A website message that was already open when the window connected is shown on its own: no picture exists until it is answered.
    else if(!state.shown&&!(state.siteDialog&&state.phase==='live')){show=true;heading=state.phase==='paused'?'Paused while this window is hidden':state.phase==='reconnecting'?'Reconnecting to the browser…':'Connecting to the browser…';body=state.phase==='reconnecting'?'Your bot is still paused. This usually takes a few seconds.':'The live page appears here in a moment.';}
    node.hidden=!show;node.classList.toggle('is-final',!!(state.final||state.failure));
    if(show){title.textContent=heading;text.textContent=body;actions.innerHTML=buttons;}
    state.els.panel.toggleAttribute('data-closed',!!state.final&&state.final!=='replaced');
  }
  function notice(state,text,{error=false,action=null,label=''}={}) {
    const node=state.dialog.querySelector('[data-browser-notice]'),button=node.querySelector('[data-browser-notice-action]');clearTimeout(state.noticeTimer);
    node.hidden=!text;node.classList.toggle('has-error',error);node.querySelector('[data-browser-notice-text]').textContent=text||'';
    button.hidden=!action;button.textContent=label;state.noticeAction=action;
    if(text&&!error&&!action)state.noticeTimer=setTimeout(()=>{if(active===state)notice(state,'');},timing.notice);
  }
  function hostOf(url) {try{const parsed=new URL(url);return parsed.protocol==='http:'||parsed.protocol==='https:'?parsed.hostname:url;}catch{return url;}}
  function renderAddress(state) {
    const url=String(state.page.url||''),host=state.dialog.querySelector('[data-browser-host]'),path=state.dialog.querySelector('[data-browser-path]'),security=state.dialog.querySelector('[data-browser-security]');
    let secure=false,hostText=url||'about:blank',pathText='';
    try{const parsed=new URL(url);if(parsed.protocol==='https:'||parsed.protocol==='http:'){secure=parsed.protocol==='https:';hostText=parsed.hostname;pathText=(parsed.pathname==='/'?'':parsed.pathname)+parsed.search;}}catch{}
    host.textContent=hostText.slice(0,253);path.textContent=pathText.slice(0,300);
    security.innerHTML=svg(secure?icons.lock:icons.warn);security.classList.toggle('is-insecure',!secure);
    state.els.site.setAttribute('aria-label',`Website: ${hostText.slice(0,253)}${secure?'':' (not secure)'}. Select to change the address.`);
    state.els.site.title=url.slice(0,2000);
  }
  function renderTabs(state) {
    const node=state.dialog.querySelector('[data-browser-tabs]'),tabs=state.page.tabs.slice(0,12);node.hidden=tabs.length<2;node.replaceChildren();
    tabs.forEach((tab,index)=>{const button=document.createElement('button');button.type='button';button.className='browser-control-tab';button.dataset.browserTab=String(index);const isActive=tab.id===state.page.tabId;button.setAttribute('aria-pressed',String(isActive));if(isActive)button.setAttribute('aria-current','page');button.disabled=state.phase!=='live';const title=document.createElement('span');title.textContent=String(tab.title||hostOf(tab.url)||'Untitled tab').slice(0,120);const host=document.createElement('small');host.textContent=hostOf(String(tab.url||'')).slice(0,120);button.append(title,host);node.append(button);});
  }
  function applyPage(state,data) {
    const page=state.page,previousTab=page.tabId;
    if(data.tabId!==undefined)page.tabId=data.tabId;if(data.nav!==undefined)page.nav=data.nav;
    if(typeof data.url==='string')page.url=data.url.slice(0,4000);if(typeof data.title==='string')page.title=data.title.slice(0,500);
    if(Array.isArray(data.tabs))page.tabs=data.tabs.filter(tab=>tab&&typeof tab==='object').map(tab=>({id:tab.id,title:String(tab.title??''),url:String(tab.url??''),active:tab.active===true}));
    if(typeof data.loading==='boolean')page.loading=data.loading;
    if(typeof data.canGoBack==='boolean')page.canGoBack=data.canGoBack;if(typeof data.canGoForward==='boolean')page.canGoForward=data.canGoForward;
    if(Object.hasOwn(data,'focus'))page.focus=data.focus&&typeof data.focus==='object'&&data.focus.editable===true?{editable:true,kind:Object.hasOwn(KINDS,data.focus.kind)?data.focus.kind:'other'}:null;
    renderAddress(state);renderTabs(state);
    state.dialog.querySelector('[data-browser-progress]').hidden=!page.loading;state.dialog.querySelector('[data-browser-history=reload]').classList.toggle('is-loading',page.loading);state.els.panel.setAttribute('aria-busy',String(page.loading));
    if(previousTab!=null&&page.tabId!=null&&previousTab!==page.tabId){const tab=page.tabs.find(item=>item.id===page.tabId);notice(state,`Now showing another tab${tab?`: ${hostOf(tab.url)||tab.title}`:''}.`);}
    configureTyper(state);setPhase(state,state.phase);
  }
  function configureTyper(state) {
    const focus=state.page.focus,[type,mode,placeholder]=KINDS[focus?.kind||'text'],input=state.els.type;
    if(input.type!==type)input.type=type;input.inputMode=mode;input.setAttribute('inputmode',mode);input.placeholder=placeholder;
    state.els.panel.dataset.focusKind=focus?.kind||'';
    state.dialog.querySelector('[data-browser-focus-hint]').textContent=focus?.kind==='password'?'Password field · typing goes to the page · Esc twice to stop':'Typing goes to the page · Esc twice to stop';
    // A tapped field shows the compact input; one tap on it opens the phone keyboard (iOS needs that gesture).
    if(coarse()&&state.phase==='live'&&focus?.editable)showTyper(state,true);
    else if(!focus&&!state.typerPinned&&document.activeElement!==input)showTyper(state,false);
  }
  function showTyper(state,show) {state.els.typer.hidden=!show;}
  function renderSiteDialog(state,info) {
    const node=state.dialog.querySelector('[data-browser-site-dialog]'),input=node.querySelector('[data-browser-site-prompt]');
    const open=info&&info.open===true,type=open?String(info.type||'alert'):'';state.siteDialog=open?{type}:null;node.hidden=!open;input.value='';
    overlay(state);if(!open)return;
    node.querySelector('[data-browser-site-type]').textContent=type==='prompt'?'The website asks for a response':type==='beforeunload'?'Leave this page?':type==='confirm'?'The website asks you to confirm':'Message from the website';
    node.querySelector('[data-browser-site-message]').textContent=String(info.message||'').slice(0,2000);
    node.querySelector('[data-browser-site-input]').hidden=type!=='prompt';if(type==='prompt')input.value=String(info.defaultPrompt||'').slice(0,2000);
    const cancel=node.querySelector('[data-browser-dialog-accept=false]'),ok=node.querySelector('[data-browser-dialog-accept=true]');
    cancel.hidden=type==='alert';cancel.textContent=type==='beforeunload'?'Stay':'Cancel';ok.textContent=type==='beforeunload'?'Leave':'OK';
  }

  /* ---------- stream ---------- */
  const endpoint=(state,name)=>`/api/bots/${encodeURIComponent(state.botId)}/browser/${name}`;
  function measure(state) {
    const surface=state.els.surface,box=surface.getBoundingClientRect?.()||{};
    const width=Math.round(surface.clientWidth||box.width||0),height=Math.round(surface.clientHeight||box.height||0);
    return {width:width>0?width:1280,height:height>0?height:800,dpr:Math.min(2,Math.max(1,Math.round((window.devicePixelRatio||1)*100)/100)),touch:coarse()};
  }
  async function connect(state) {
    if(!current(state)||state.final)return;
    clearTimeout(state.retryTimer);state.failure=null;
    if(state.conn){state.conn.done=true;clearTimeout(state.conn.timer);state.conn.abort.abort();}
    const conn={id:++state.connSeq,abort:new AbortController(),timer:null,done:false};state.conn=conn;
    dropQueue(state);state.streamId=null;setPhase(state,state.everLive?'reconnecting':'connecting');
    const viewport=measure(state);state.viewport=viewport;
    let response;
    try{response=await state.context.api(endpoint(state,'stream'),{method:'POST',headers:{Accept:'text/event-stream'},body:{...state.identity,viewport},signal:conn.abort.signal,responseType:'stream'});}
    catch(error){if(conn.done||!current(state))return;conn.done=true;return openFailed(state,error);}
    if(conn.done||!current(state)){try{await response?.body?.cancel?.();}catch{}return;}
    if(!response?.body?.getReader){conn.done=true;return scheduleReconnect(state);}
    await read(state,conn,response);
  }
  function openFailed(state,error) {
    const status=Number(error?.status)||0;
    if(status===401)return;// The app signs out and closes this window.
    if(status>=400&&status<500&&![408,425,429].includes(status)){state.failure=String(error?.message||'The engine refused to open the browser.').slice(0,240);setPhase(state,'offline');return;}
    scheduleReconnect(state);
  }
  function scheduleReconnect(state) {
    if(!current(state)||state.final)return;
    state.streamId=null;dropQueue(state);clearTimeout(state.retryTimer);
    if(document.hidden){setPhase(state,'paused');return;}
    const delay=timing.backoff[Math.min(state.attempts,timing.backoff.length-1)];state.attempts++;
    setPhase(state,state.everLive?'reconnecting':(state.attempts>1?'reconnecting':'connecting'));
    if(state.attempts>2)notice(state,'The connection is slow. Still trying… You can resume or skip at any time.');
    state.retryTimer=setTimeout(()=>void connect(state),delay);
  }
  function lost(state,conn) {if(conn.done)return;conn.done=true;clearTimeout(conn.timer);conn.abort.abort();if(state.conn===conn)scheduleReconnect(state);}
  async function read(state,conn,response) {
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',scan=0,name='',data=[];
    const arm=()=>{clearTimeout(conn.timer);conn.timer=setTimeout(()=>{if(state.conn===conn&&!conn.done){notice(state,'The live view stopped updating. Reconnecting…');lost(state,conn);}},timing.watchdog);};
    arm();
    try{
      for(;;){
        const {value,done}=await reader.read();
        if(conn.done||state.conn!==conn||!current(state))return;
        if(done)break;arm();
        buffer+=typeof value==='string'?value:decoder.decode(value,{stream:true});
        let index;
        while((index=buffer.indexOf('\n',scan))>=0){
          let line=buffer.slice(0,index);buffer=buffer.slice(index+1);scan=0;if(line.endsWith('\r'))line=line.slice(0,-1);
          if(line===''){if(data.length){dispatch(state,conn,name||'message',data.join('\n'));if(conn.done)return;}name='';data=[];continue;}
          if(line[0]===':')continue;
          const colon=line.indexOf(':'),field=colon<0?line:line.slice(0,colon);let text=colon<0?'':line.slice(colon+1);if(text[0]===' ')text=text.slice(1);
          if(field==='event')name=text;else if(field==='data')data.push(text);
        }
        scan=buffer.length;
        if(buffer.length>24_000_000){lost(state,conn);return;}
      }
    }catch{if(conn.done||state.conn!==conn)return;}
    finally{clearTimeout(conn.timer);}
    lost(state,conn);
  }
  function dispatch(state,conn,name,text) {
    let data;try{data=JSON.parse(text);}catch{return;}
    if(!data||typeof data!=='object')return;
    if(name==='ready'){
      if(typeof data.streamId!=='string'||!data.streamId)return;
      state.streamId=data.streamId;state.attempts=0;state.everLive=true;
      if(!state.retentionSet){state.els.retain.checked=data.retained===true;state.retentionSet=true;}
      state.shownSeq=-1;setPhase(state,'live');applyPage(state,data);
      queueResize(state);// Sends a resize only if the window changed while connecting.
      flush(state);return;
    }
    if(name==='frame')return frame(state,data);
    if(name==='state')return applyPage(state,data);
    if(name==='dialog')return renderSiteDialog(state,data);
    if(name==='end'){
      const reason=String(data.reason||'');conn.done=true;clearTimeout(conn.timer);conn.abort.abort();
      if(reason==='error'||!reason){if(state.conn===conn)scheduleReconnect(state);return;}
      return finish(state,Object.hasOwn(FINAL,reason)?reason:'closed');
    }
  }
  function finish(state,reason) {
    state.final=reason;clearTimeout(state.retryTimer);if(state.conn){state.conn.done=true;state.conn.abort.abort();}
    state.streamId=null;dropQueue(state);releaseKeys(state,false);renderSiteDialog(state,null);showTyper(state,false);
    setPhase(state,reason==='replaced'?'replaced':'ended');notice(state,'');
    if(reason!=='replaced'){const ctx=state.context;Promise.resolve().then(()=>ctx.loadChat?.(state.botId)).catch(()=>{});}
  }
  function takeControl(state) {state.final=null;state.failure=null;state.attempts=0;state.conflictRetried=false;notice(state,'');void connect(state);}

  /* ---------- frames ---------- */
  function frame(state,data) {
    if(typeof data.jpeg!=='string'||!data.jpeg||data.jpeg.length>16_000_000)return;
    const width=Number(data.width),height=Number(data.height);
    if(!(width>=1&&height>=1&&width<=8192&&height<=8192))return;
    if(Number.isFinite(data.seq)&&data.seq<=state.shownSeq)return;
    state.nextFrame={seq:Number.isFinite(data.seq)?data.seq:state.shownSeq+1,tabId:data.tabId,nav:data.nav,width,height,jpeg:data.jpeg};
    if(!state.decoding)void paint(state);
  }
  // Two reused images: the next frame decodes in the hidden one and swaps in only when ready; a newer frame replaces a waiting one.
  async function paint(state) {
    state.decoding=true;
    try{
      while(state.nextFrame&&current(state)){
        const next=state.nextFrame;state.nextFrame=null;
        const back=state.frames.find(image=>!image.classList.contains('is-front'))||state.frames[0],front=state.frames.find(image=>image!==back);
        back.src=`data:image/jpeg;base64,${next.jpeg}`;
        // decode() can stall while the page is throttled; never let it freeze the view.
        if(typeof back.decode==='function'){let timer;try{await Promise.race([back.decode(),new Promise(resolve=>{timer=setTimeout(resolve,timing.decode);})]);}catch{continue;}finally{clearTimeout(timer);}}
        if(!current(state))return;
        back.classList.add('is-front');back.removeAttribute('aria-hidden');front?.classList.remove('is-front');front?.setAttribute('aria-hidden','true');
        const first=!state.shown;state.shown={tabId:next.tabId,nav:next.nav,width:next.width,height:next.height,seq:next.seq};state.shownSeq=next.seq;
        if(first)overlay(state);
      }
    }finally{state.decoding=false;}
  }
  function point(state,event,clamp=false) {
    const shown=state.shown;if(!shown)return null;
    const box=state.els.surface.getBoundingClientRect();if(!box.width||!box.height)return null;
    const scale=Math.min(box.width/shown.width,box.height/shown.height),offset=(box.width-shown.width*scale)/2;
    let x=(event.clientX-box.left-offset)/scale,y=(event.clientY-box.top)/scale;
    if(!clamp&&(x<0||y<0||x>=shown.width||y>=shown.height))return null;
    x=Math.max(0,Math.min(shown.width-1,x));y=Math.max(0,Math.min(shown.height-1,y));
    return {x:Math.round(x*10)/10,y:Math.round(y*10)/10};
  }

  /* ---------- input queue: one request in flight; later events wait and go as the next batch ---------- */
  const live=state=>state.phase==='live'&&!!state.streamId&&!state.final;
  function enqueue(state,event) {
    if(!live(state)||!current(state))return false;
    commit(state);event.time=performance.now();state.queue.push(event);flush(state);return true;
  }
  // Hover moves, drag moves, touch moves and wheel are coalesced; any discrete event commits them first to keep order.
  function coalesce(state,key,event,delay) {
    if(!live(state)||!current(state))return;
    state.pending ||= {};const previous=state.pending[key];
    if(key==='wheel'&&previous){event.dx+=previous.dx;event.dy+=previous.dy;}
    event.time=performance.now();state.pending[key]=event;
    if(!state.flushTimer)state.flushTimer=setTimeout(()=>{state.flushTimer=null;commit(state);flush(state);},delay);
  }
  function commit(state) {
    const pending=state.pending;state.pending=null;clearTimeout(state.flushTimer);state.flushTimer=null;
    if(pending)state.queue.push(...Object.values(pending).sort((a,b)=>a.time-b.time));
  }
  function dropQueue(state) {
    const lostInput=state.queue.some(event=>event.t!=='pointer'||event.kind!=='move');
    state.queue.length=0;state.pending=null;clearTimeout(state.flushTimer);state.flushTimer=null;
    if(lostInput&&!state.final)notice(state,'Some input wasn’t sent because the connection dropped. Check the page before you continue.',{error:true});
  }
  const encoder=typeof TextEncoder==='function'?new TextEncoder():null;
  const bytes=text=>encoder?encoder.encode(text).length:text.length*3;
  function wire(event,previous) {
    const {time,...out}=event;
    if(out.t==='pointer'||out.t==='touch')out.dt=previous==null?0:Math.max(0,Math.round(time-previous));
    return out;
  }
  async function flush(state) {
    if(state.inflight||!state.queue.length||!live(state)||!current(state))return;
    const batch=[],streamId=state.streamId;let size=0,previous=null;
    while(state.queue.length&&batch.length<64){
      const event=state.queue[0],out=wire(event,previous),length=bytes(JSON.stringify(out))+1;
      if(batch.length&&size+length>30_000)break;
      batch.push(out);size+=length;previous=event.time;state.queue.shift();
    }
    const seq=++state.seq,controller=new AbortController(),request={controller,seq};state.inflight=request;
    const timer=setTimeout(()=>controller.abort(),timing.input),stop=()=>controller.abort();state.abort.signal.addEventListener('abort',stop,{once:true});
    try{
      const result=await state.context.api(endpoint(state,'input'),{method:'POST',body:{...state.identity,streamId,seq,events:batch},signal:controller.signal});
      if(!current(state))return;
      state.conflictRetried=false;
      if(Number(result?.dropped)>0)notice(state,'A click or tap was ignored because the page changed. Try it again on the new page.');
    }catch(error){
      if(!current(state)||state.abort.signal.aborted)return;
      if(error?.status===409){
        // The lease or handoff changed: reopen once and never resend uncertain input.
        state.queue.length=0;state.pending=null;
        if(state.conflictRetried){finish(state,'replaced');return;}
        state.conflictRetried=true;notice(state,'The browser changed. Reconnecting…');state.attempts=0;void connect(state);
      }else if(error?.status>=400&&error.status<500&&batch.some(event=>event.t==='navigate'))notice(state,`The engine refused that: ${String(error.message||'the address is not allowed').slice(0,200)}`,{error:true});
      else notice(state,'Some input may not have reached the page. Check the page before you continue.',{error:true});
    }finally{
      clearTimeout(timer);state.abort.signal.removeEventListener('abort',stop);
      if(state.inflight===request)state.inflight=null;
      if(current(state))void flush(state);
    }
  }
  function drain(state,limit) {
    commit(state);void flush(state);const until=Date.now()+limit;
    return new Promise(resolve=>{const check=()=>{if(!active||active!==state||(!state.inflight&&!state.queue.length)||Date.now()>=until)return resolve();if(!live(state))return resolve();setTimeout(check,25);};check();});
  }
  function sendText(state,text) {
    let value=String(text||'');if(!value)return;
    if(value.length>10_000){value=value.slice(0,10_000);notice(state,'Only the first 10,000 characters were sent.');}
    if(!live(state)){notice(state,'Wait for the live page before typing. Nothing was sent.',{error:true});return;}
    for(let index=0;index<value.length;index+=2000)enqueue(state,{t:'text',text:value.slice(index,index+2000)});
  }
  function key(state,event,kind) {return enqueue(state,{t:'key',kind,key:String(event.key).slice(0,40),code:String(event.code||'').slice(0,40),modifiers:modifiers(event),repeat:!!event.repeat});}
  function tap(state,keyName,mods=0) {const code={Enter:'Enter',Backspace:'Backspace',Delete:'Delete',Tab:'Tab',Escape:'Escape'}[keyName]||'';enqueue(state,{t:'key',kind:'down',key:keyName,code,modifiers:mods,repeat:false});enqueue(state,{t:'key',kind:'up',key:keyName,code,modifiers:mods,repeat:false});}
  function releaseKeys(state,send=true) {
    const pressed=[...state.pressed].reverse();state.pressed.clear();
    if(send)for(const [code,name] of pressed)enqueue(state,{t:'key',kind:'up',key:name,code,modifiers:0,repeat:false});
  }
  function queueResize(state) {clearTimeout(state.resizeTimer);state.resizeTimer=setTimeout(()=>{if(!current(state))return;const next=measure(state),last=state.viewport;if(last&&next.width===last.width&&next.height===last.height&&next.dpr===last.dpr&&next.touch===last.touch&&!state.forceResize)return;state.forceResize=false;state.viewport=next;if(live(state))enqueue(state,{t:'resize',...next});},timing.resize);}
  function watchSize(state) {
    const changed=()=>queueResize(state);
    if(typeof window.ResizeObserver==='function'){state.observer=new window.ResizeObserver(changed);state.observer.observe(state.els.surface);}
    listen(state,window,'resize',changed);
    const view=window.visualViewport;
    if(view){const fit=()=>{state.dialog.style.setProperty('--browser-control-vh',`${Math.round(view.height)}px`);state.dialog.style.setProperty('--browser-control-top',`${Math.round(view.offsetTop||0)}px`);changed();};listen(state,view,'resize',fit);listen(state,view,'scroll',fit);fit();}
  }

  /* ---------- browser shortcuts the panel leaves alone ---------- */
  function shortcut(event) {
    if(/^F(5|11|12)$/.test(event.key))return 'browser';
    if(!(event.metaKey||event.ctrlKey)||event.getModifierState?.('AltGraph'))return '';
    const name=String(event.key).toLowerCase();
    if(name==='v')return 'paste';
    if(['r','w','t','n','q','l','m','h','tab','pageup','pagedown','0','1','2','3','4','5','6','7','8','9','+','=','-'].includes(name))return 'browser';
    if(event.altKey&&name==='i')return 'browser';
    return '';
  }

  /* ---------- events ---------- */
  function bind(state) {
    const {dialog,els}=state,{surface,sink,type,address,site}=els;
    listen(state,dialog,'click',event=>{
      const target=event.target.closest('button');if(!target||target.disabled)return;
      if(target.hasAttribute('data-browser-close')){reset();return;}
      if(target.hasAttribute('data-browser-take')){takeControl(state);return;}
      if(target.hasAttribute('data-browser-retry')){state.failure=null;state.attempts=0;void connect(state);return;}
      if(target.hasAttribute('data-browser-notice-action')){const action=state.noticeAction;notice(state,'');action?.();return;}
      if(target.dataset.browserResume){void handBack(state,target.dataset.browserResume==='skip');return;}
      if(target.dataset.browserHistory){enqueue(state,{t:'history',action:target.dataset.browserHistory});return;}
      if(target.dataset.browserTab){const tab=state.page.tabs[Number(target.dataset.browserTab)];if(tab&&tab.id!==state.page.tabId)enqueue(state,{t:'tab',tabId:tab.id});return;}
      if(target.dataset.browserDialogAccept){const accept=target.dataset.browserDialogAccept==='true',input=dialog.querySelector('[data-browser-site-prompt]'),promptText=input.value;input.value='';if(enqueue(state,{t:'dialog',accept,...(state.siteDialog?.type==='prompt'&&accept?{promptText:promptText.slice(0,2000)}:{})}))renderSiteDialog(state,null);return;}
      if(target.hasAttribute('data-browser-site')){site.hidden=true;address.hidden=false;address.value=state.page.url||'';address.focus();address.select?.();return;}
      if(target.hasAttribute('data-browser-keyboard')){
        if(!coarse()){sink.focus({preventScroll:true});return;}
        if(document.activeElement===type){type.blur();state.typerPinned=false;showTyper(state,!!state.page.focus);}
        else{state.typerPinned=true;showTyper(state,true);type.focus();}
        return;
      }
      if(target.hasAttribute('data-browser-typer-done')){type.value='';type.blur();state.typerPinned=false;showTyper(state,false);}
    });
    // Address: editing shows the full address; Enter navigates; Escape or leaving the field restores the site view.
    const closeAddress=()=>{address.value='';address.hidden=true;site.hidden=false;};
    listen(state,dialog.querySelector('[data-browser-address-form]'),'submit',event=>{
      event.preventDefault();let value=address.value.trim();if(!value){closeAddress();return;}
      if(!/^[a-z][a-z0-9+.-]*:/i.test(value))value=`https://${value}`;
      // The Engine owns which addresses are allowed; its refusal is shown when it rejects one.
      let url;try{url=new URL(value);}catch{notice(state,'That doesn’t look like a web address. Try something like example.com.',{error:true});return;}
      if(enqueue(state,{t:'navigate',url:url.href})){closeAddress();if(!coarse())sink.focus({preventScroll:true});}else notice(state,'Wait for the live page, then try the address again. Nothing was sent.',{error:true});
    });
    listen(state,address,'keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeAddress();site.focus();}});
    listen(state,address,'blur',()=>setTimeout(()=>{if(active===state&&document.activeElement!==address)closeAddress();},150));

    // Pointer: mouse and pen become pointer events; touch becomes touch events so the page scrolls and drags natively.
    listen(state,surface,'pointerdown',event=>{
      if(event.target.closest('[data-browser-site-dialog],[data-browser-overlay]:not([hidden])'))return;
      const at=point(state,event);if(!at)return;
      if(!live(state)){event.preventDefault();notice(state,'Wait for the live page. That click or tap was not sent.',{error:true});return;}
      event.preventDefault();try{surface.setPointerCapture?.(event.pointerId);}catch{}
      const {tabId,nav}=state.shown;
      if(event.pointerType==='touch'){state.touches.set(event.pointerId,at);enqueue(state,{t:'touch',kind:'start',points:points(state),modifiers:modifiers(event),tabId,nav});return;}
      if(document.activeElement!==type)sink.focus({preventScroll:true});
      const now=event.timeStamp||performance.now(),last=state.click,button=Number(event.button)||0;
      const count=last&&last.button===button&&now-last.time<500&&Math.hypot(at.x-last.x,at.y-last.y)<6?Math.min(3,last.count+1):1;
      state.click={button,x:at.x,y:at.y,time:now,count};state.mouseDown=true;
      enqueue(state,{t:'pointer',kind:'down',x:at.x,y:at.y,button,buttons:Number(event.buttons)||(1<<([0,2,1][button]??0)),clickCount:count,modifiers:modifiers(event),tabId,nav});
    });
    listen(state,surface,'pointermove',event=>{
      if(!state.shown||!live(state))return;
      if(event.pointerType==='touch'){if(!state.touches.has(event.pointerId))return;const at=point(state,event,true);if(!at)return;state.touches.set(event.pointerId,at);coalesce(state,'touch',{t:'touch',kind:'move',points:points(state),modifiers:modifiers(event),tabId:state.shown.tabId,nav:state.shown.nav},timing.drag);return;}
      const at=point(state,event,state.mouseDown);if(!at)return;
      coalesce(state,'move',{t:'pointer',kind:'move',x:at.x,y:at.y,button:state.mouseDown?state.click?.button??0:0,buttons:Number(event.buttons)||0,clickCount:0,modifiers:modifiers(event),tabId:state.shown.tabId,nav:state.shown.nav},state.mouseDown?timing.drag:timing.hover);
    });
    const up=(event,cancel=false)=>{
      if(event.pointerType==='touch'){
        if(!state.touches.has(event.pointerId))return;
        const at=point(state,event,true);if(at&&!cancel)state.touches.set(event.pointerId,at);
        state.touches.delete(event.pointerId);
        enqueue(state,{t:'touch',kind:cancel?'cancel':'end',points:cancel?[]:points(state),modifiers:modifiers(event),tabId:state.shown?.tabId,nav:state.shown?.nav});
        if(cancel)state.touches.clear();
        return;
      }
      if(!state.mouseDown)return;state.mouseDown=false;try{surface.releasePointerCapture?.(event.pointerId);}catch{}
      const at=point(state,event,true)||{x:state.click?.x||0,y:state.click?.y||0};
      enqueue(state,{t:'pointer',kind:'up',x:at.x,y:at.y,button:state.click?.button??0,buttons:Number(event.buttons)||0,clickCount:state.click?.count||1,modifiers:modifiers(event),tabId:state.shown?.tabId,nav:state.shown?.nav});
    };
    listen(state,surface,'pointerup',event=>up(event));
    listen(state,surface,'pointercancel',event=>up(event,true));
    listen(state,surface,'lostpointercapture',event=>{if(event.pointerType!=='touch'&&state.mouseDown)up(event);});
    listen(state,surface,'contextmenu',event=>event.preventDefault());
    // Keeps the phone keyboard open while tapping the page and stops callouts, magnifier and double-tap zoom.
    listen(state,surface,'touchstart',event=>{if(!event.target.closest('[data-browser-site-dialog],[data-browser-overlay]:not([hidden])'))event.preventDefault();},{passive:false});
    listen(state,surface,'wheel',event=>{
      if(event.target.closest('[data-browser-site-dialog]'))return;
      event.preventDefault();const at=point(state,event,true);if(!at||!live(state))return;
      const unit=event.deltaMode===1?16:event.deltaMode===2?(state.shown?.height||800):1;
      coalesce(state,'wheel',{t:'wheel',x:at.x,y:at.y,dx:Math.round(event.deltaX*unit),dy:Math.round(event.deltaY*unit),modifiers:modifiers(event)},timing.hover);
    },{passive:false});

    // Desktop keyboard: a hidden field on the page receives keys, IME text and paste while the page view is focused.
    listen(state,sink,'keydown',event=>{
      if(event.isComposing||event.keyCode===229)return;
      if(event.key==='Escape'&&!modifiers(event)){
        const now=Date.now();
        if(now-state.escapeAt<timing.escape){event.preventDefault();state.escapeAt=0;releaseKeyboard(state);return;}
        state.escapeAt=now;
      }
      const kind=shortcut(event);if(kind)return;// Browser shortcuts and paste keep their normal behaviour.
      event.preventDefault();
      if(!live(state)){notice(state,'Wait for the live page before typing. Nothing was sent.',{error:true});return;}
      if(!event.repeat)state.pressed.set(event.code||event.key,event.key);
      key(state,event,'down');
    });
    listen(state,sink,'keyup',event=>{
      const id=event.code||event.key;if(!state.pressed.has(id))return;
      event.preventDefault();state.pressed.delete(id);key(state,event,'up');
      // macOS swallows key-ups while Command is held; release whatever is left with it.
      if(event.key==='Meta')releaseKeys(state);
    });
    listen(state,sink,'blur',()=>{releaseKeys(state);sink.value='';state.composing=false;});
    listen(state,sink,'compositionstart',()=>{state.composing=true;});
    listen(state,sink,'compositionend',event=>{state.composing=false;const text=event.data||sink.value;sink.value='';if(text)sendText(state,text);});
    listen(state,sink,'input',event=>{if(event.isComposing||state.composing)return;const text=sink.value;sink.value='';if(text)sendText(state,text);});
    const paste=(input)=>event=>{event.preventDefault();const text=event.clipboardData?.getData('text/plain')||'';if(input)input.value='';if(text)sendText(state,text);};
    listen(state,sink,'paste',paste(sink));

    // Phone keyboard: a visible compact field forwards each insertion, deletion and Enter at once and never keeps text.
    listen(state,type,'paste',paste(type));
    listen(state,type,'keydown',event=>{
      if(event.isComposing||event.keyCode===229)return;
      if(['Enter','Backspace','Delete','Tab','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)){
        event.preventDefault();if(event.key==='Escape'&&!modifiers(event)){type.blur();return;}
        if(!live(state)){notice(state,'Wait for the live page before typing. Nothing was sent.',{error:true});return;}
        enqueue(state,{t:'key',kind:'down',key:event.key,code:event.code||event.key,modifiers:modifiers(event),repeat:!!event.repeat});enqueue(state,{t:'key',kind:'up',key:event.key,code:event.code||event.key,modifiers:modifiers(event),repeat:false});
      }
    });
    listen(state,type,'beforeinput',event=>{
      const kind=event.inputType||'';
      if(kind==='insertCompositionText'||event.isComposing)return;
      if(/^insert(Text|ReplacementText|FromPaste|FromDrop|FromYank)$/.test(kind)){event.preventDefault();const text=event.data??event.dataTransfer?.getData?.('text/plain')??'';type.value='';if(text)sendText(state,text);return;}
      if(kind==='insertLineBreak'||kind==='insertParagraph'){event.preventDefault();type.value='';tap(state,'Enter');return;}
      if(kind==='deleteContentBackward'){event.preventDefault();tap(state,'Backspace');return;}
      if(kind==='deleteWordBackward'){event.preventDefault();tap(state,'Backspace',/Mac|iPhone|iPad/.test(navigator.platform||'')?1:2);return;}
      if(kind==='deleteContentForward'){event.preventDefault();tap(state,'Delete');return;}
    });
    listen(state,type,'compositionstart',()=>{state.composing=true;});
    listen(state,type,'compositionend',event=>{state.composing=false;const text=event.data||type.value;type.value='';if(text)sendText(state,text);});
    // Autofill (for example an SMS one-time code) can set the value without a cancellable beforeinput.
    listen(state,type,'input',event=>{if(event.isComposing||state.composing)return;const text=type.value;type.value='';if(text)sendText(state,text);});
    listen(state,type,'focus',()=>dialog.querySelector('[data-browser-keyboard]').setAttribute('aria-pressed','true'));
    listen(state,type,'blur',()=>{dialog.querySelector('[data-browser-keyboard]').setAttribute('aria-pressed','false');if(state.composing){state.composing=false;}type.value='';});

    // Hidden: pause the stream and send what is already queued; in-progress phone typing is left alone.
    listen(state,document,'visibilitychange',()=>{
      if(!current(state))return;
      if(document.hidden){commit(state);void flush(state);clearTimeout(state.retryTimer);if(state.conn&&!state.conn.done){state.conn.done=true;clearTimeout(state.conn.timer);state.conn.abort.abort();}setPhase(state,state.final?state.phase:'paused');}
      else if(!state.final&&!state.failure){state.attempts=0;void connect(state);}
    });
    listen(state,window,'online',()=>{if(current(state)&&!state.final&&state.phase!=='live'){state.attempts=0;void connect(state);}});
    listen(state,window,'pagehide',()=>{if(state.conn){state.conn.done=true;state.conn.abort.abort();}});
  }
  function points(state) {return [...state.touches].slice(0,10).map(([id,at])=>({id,x:at.x,y:at.y}));}
  function releaseKeyboard(state) {
    state.els.sink.blur();const button=state.dialog.querySelector('[data-browser-keyboard]');button.focus?.();
    notice(state,'Keyboard released. Click the page to type into it again.');
  }

  /* ---------- hand control back ---------- */
  async function handBack(state,skip) {
    if(state.resuming||!current(state))return;state.resuming=true;
    const label=skip?'Skipping browser help…':'Returning control to your bot…';notice(state,label);
    // Typing already in the queue reaches the page first; a stalled connection never blocks this step for long.
    if(state.els.sink===document.activeElement)state.els.sink.blur();
    await drain(state,timing.drain);if(!current(state))return;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timing.resume);
    try{
      await state.context.api(endpoint(state,'resume'),{method:'POST',body:{...state.identity,keepSession:state.els.retain.checked,...(skip?{skip:true}:{})},signal:controller.signal});
      if(!current(state))return;
      const ctx=state.context,botId=state.botId;reset();
      try{await ctx.loadChat(botId);}catch{}
      ctx.toast(skip?'Browser help skipped.':'Control returned to your bot.');
    }catch(error){
      if(!current(state))return;state.resuming=false;
      if(error?.status===409){finish(state,'ended');return;}
      notice(state,controller.signal.aborted?'The engine didn’t answer in time. Try again.':`Couldn’t ${skip?'skip':'resume'}: ${String(error?.message||'the engine could not be reached').slice(0,160)}`,{error:true});
    }finally{clearTimeout(timer);}
  }

  // Closes only on positive evidence that this exact handoff ended; a missing run (loading, an earlier chat) is not evidence.
  function observeRun(botId,run) {
    const state=active;if(!state||state.botId!==botId||!run)return;
    const control=run.pending_controls?.find(item=>item?.kind==='browser');
    if(run.status!=='waiting_for_input'||!control||JSON.stringify(identityFor(run,control))!==JSON.stringify(state.identity))reset();
  }
  window.StudioBrowser={renderCard,open,reset,observeRun,timing};
})();
