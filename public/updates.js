/* Settings › Version & updates: one answer first (is everything current?), then each part with its own action. */
(()=>{
  'use strict';
  // The first iPhone and Mac app build that reports its own version to the page and can start an update from it.
  const FIRST_REPORTING_BUILD=17,AUTO_CHECK_MS=12*3600_000,POLL_MS=4000,WAIT_NOTE_MS=90_000,WATCH_MS=60_000;
  let context=null,poll=null,baseline='',watchedAt=0,announced='';
  const state={status:null,loading:false,checking:false,requesting:false,error:'',waitingSince:0,restarting:false,updatedTo:''};
  const e=value=>context?context.esc(String(value ?? '')):String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon=name=>context?.icon?.(name)||'';
  const current=()=>Boolean(context && context.route().view==='updates' && document.querySelector('[data-updates-page]'));
  const day=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):'';};
  const ago=value=>{const minutes=Math.round((Date.now()-new Date(value).getTime())/60_000);return !Number.isFinite(minutes)?'':minutes<1?'just now':minutes<60?`${minutes} min ago`:minutes<1440?`${Math.round(minutes/60)} h ago`:day(value);};
  /** Only https links to the release pages the engine already validated; anything else is dropped. */
  const safeLink=value=>typeof value==='string' && /^https:\/\/github\.com\/[^\s"'<>]+$/.test(value)?value:'';
  const whatsNew=url=>safeLink(url)?`<a class="updates-link" href="${e(safeLink(url))}" target="_blank" rel="noopener">What’s new</a>`:'';
  const pill=(tone,text)=>`<span class="status-pill ${tone}"><i class="dot"></i>${e(text)}</span>`;
  /** What identifies the running copy; it changes exactly when the engine was replaced. */
  const fingerprint=status=>status?.installed?.id || status?.installed?.commit || '';

  /** The native app around this page, as it reports itself. `build` is null for an app too old to say. */
  function nativeApp(root=document.documentElement) {
    const platform=root?.dataset?.studioApp;
    if(platform!=='ios' && platform!=='macos')return null;
    const build=Number(root.dataset.studioAppBuild),known=Number.isInteger(build) && build>0;
    return {platform,name:platform==='ios'?'iPhone app':'Mac app',version:known?root.dataset.studioAppVersion||'':'',build:known?build:null};
  }
  /**
   * "current", "available", "required" or "unknown" for the app around this page.
   * "available" needs a build that was actually published (the Mac channel) or a TestFlight link (iPhone):
   * a build that only exists in the source is never promised.
   */
  function appState(app,expected) {
    if(!app || !expected)return 'current';
    const build=app.build ?? FIRST_REPORTING_BUILD-1,published=expected.published?.build;
    if(build<expected.minimumBuild)return 'required';
    if(Number.isInteger(published))return build<published?'available':app.build?'current':'unknown';
    if(app.platform==='ios' && expected.testflightURL)return build<expected.build?'available':'current';
    return app.build && build>=expected.build?'current':'unknown';
  }
  const expectedApp=(app,status)=>app?status?.apps?.[app.platform==='ios'?'ios':'mac']||null:null;
  /** True when Settings should draw attention to this page. */
  function needsAttention(status=state.status,app=nativeApp()) {
    return Boolean(status && (status.updateAvailable===true || ['available','required'].includes(appState(app,expectedApp(app,status)))));
  }
  const localEngine=()=>['127.0.0.1','localhost','[::1]'].includes(location.hostname);

  /** How a newer release reaches this engine, in the owner's words. */
  function howItArrives(status,app,local) {
    const mode=status.install.mode;
    if(status.latest?.expired)return 'Its signed release note is more than 30 days old, so servers no longer install it by themselves. Publish a fresh release.';
    if(mode==='request')return 'Tupies waits until no task is running, installs it and is back in about a minute.';
    if(mode==='automatic')return 'This server installs it by itself within about 30 minutes, once no task is running.';
    if(app?.platform==='macos' && local)return 'This Mac runs the engine that comes with the Mac app, so it arrives with the next Mac app update.';
    return 'This copy was installed by hand. Update it the same way it was installed.';
  }
  function installedMeta(installed) {
    if(installed.kind==='release')return `${installed.label} · released ${day(installed.releasedAt)}`;
    if(installed.kind==='build')return installed.builtAt?`${installed.label} · built from the code of ${day(installed.builtAt)}`:`${installed.label} · built from source`;
    return `${installed.version || installed.label} · development copy`;
  }
  const row=({key,iconName,eyebrow,title,meta,status='',detail='',actions=''})=>`<article class="updates-row" data-updates-${key}><span class="setup-icon">${icon(iconName)}</span><div class="updates-main">${eyebrow?`<p class="updates-eyebrow">${e(eyebrow)}</p>`:''}<h3>${e(title)}</h3><p class="updates-meta">${meta}</p>${detail?`<div class="updates-detail" role="status" aria-live="polite">${detail}</div>`:''}</div><div class="updates-aside">${status}${actions}</div></article>`;

  function engineRow(status) {
    const {installed,latest,install}=status,app=nativeApp(),local=localEngine();
    let pillHTML='',detail='',actions='';
    if(state.updatedTo){pillHTML=pill('ready','Updated');detail=`<p>Now on ${e(state.updatedTo)}. Reloading this page…</p>`;}
    else if(state.waitingSince) {
      const step=state.restarting?'Restarting — back in about a minute':install.installing?'Installing the update':'Waiting for running tasks to finish';
      pillHTML=pill('working','Updating');
      detail=`<p class="updates-progress"><span class="updates-spinner" aria-hidden="true"></span>${e(step)}…</p>${Date.now()-state.waitingSince>WAIT_NOTE_MS?'<p>It installs as soon as no task, room or sign-in is running, and retries by itself every 30 minutes. You can leave this page.</p>':''}`;
    } else if(status.updateAvailable===true) {
      pillHTML=pill('attention','Update available');
      detail=`<p><strong>${e(latest.label)}</strong> · published ${e(ago(latest.publishedAt))}${whatsNew(latest.notesURL)?` · ${whatsNew(latest.notesURL)}`:''}</p><p>${e(howItArrives(status,app,local))}</p>`;
      if(install.mode==='request' && !latest.expired)actions=`<button class="primary-button" data-updates-install ${state.requesting?'disabled':''}>${icon('arrow')}Update now</button>`;
    } else if(status.updateAvailable===false)pillHTML=pill('ready','Up to date');
    else if(latest)detail=`<p>Newest release: <strong>${e(latest.label)}</strong>, published ${e(day(latest.publishedAt))}. This copy runs from source, so Tupies cannot tell whether it already includes it.</p>`;
    const name=status.engine?.name;
    return row({key:'engine',iconName:'server',eyebrow:name?`Engine · ${name}`:'Engine',title:'Tupies Engine',meta:e(installedMeta(installed)),status:pillHTML,detail,actions});
  }

  function appRow(status) {
    const app=nativeApp(),expected=expectedApp(app,status);
    if(!app)return downloadRow(status);
    const which=appState(app,expected),published=expected?.published,mac=app.platform==='macos';
    const meta=app.build?`Version ${e(app.version)} (${e(app.build)})`:'An older version';
    let pillHTML='',detail='',actions='';
    if(which==='available' || which==='required') {
      pillHTML=which==='required'?pill('error','Update required'):pill('attention','Update available');
      const newest=published?`${published.version} (${published.build})`:expected.build?`${expected.version} (${expected.build})`:'';
      detail=`${newest?`<p><strong>${e(newest)}</strong>${published?.publishedAt?` · published ${e(ago(published.publishedAt))}`:''}${whatsNew(published?.notesURL)?` · ${whatsNew(published.notesURL)}`:''}</p>`:''}${which==='required'?`<p>This engine needs a newer ${e(app.name)}. Some screens may not work until you update.</p>`:''}`;
      if(mac && app.build)actions=`<button class="primary-button" data-updates-app-check>${icon('arrow')}Update now</button>`;
      else if(mac && safeLink(published?.downloadURL)) {
        actions=`<a class="primary-button" data-updates-app-download href="${e(safeLink(published.downloadURL))}" target="_blank" rel="noopener">${icon('arrow')}Download</a>`;
        detail+='<p>This version of the app cannot update itself from here. Open the downloaded file and drag Tupies into Applications; your workspace stays as it is.</p>';
      } else if(mac)detail+='<p>Choose <strong>Tupies → Check for Updates…</strong> in the menu bar.</p>';
      else if(/^https:\/\/testflight\.apple\.com\/[^\s"'<>]+$/.test(expected.testflightURL||''))actions=`<a class="primary-button" href="${e(expected.testflightURL)}" target="_blank" rel="noopener">${icon('arrow')}Open TestFlight</a>`;
      else detail+='<p>Open the <strong>TestFlight</strong> app on this iPhone and tap <strong>Update</strong> next to Tupies.</p>';
    } else if(which==='current')pillHTML=pill('ready','Up to date');
    else if(published)detail=`<p>The newest published build is <strong>${e(published.version)} (${e(published.build)})</strong>. ${mac?'<strong>Tupies → Check for Updates…</strong> shows which one you have.':''}</p>`;
    return row({key:'app',iconName:mac?'laptop':'phone',eyebrow:mac?'This Mac':'This iPhone',title:app.name,meta,status:pillHTML,detail,actions});
  }
  /** In a browser, offer the Mac app itself: the published build, straight from the release. */
  function downloadRow(status) {
    const published=status?.apps?.mac?.published;
    if(!published || !safeLink(published.downloadURL))return '';
    return row({key:'download',iconName:'laptop',eyebrow:'Apps',title:'Tupies for Mac',meta:`${e(published.version)} (${e(published.build)}) · published ${e(day(published.publishedAt))}${whatsNew(published.notesURL)?` · ${whatsNew(published.notesURL)}`:''}`,actions:`<a class="secondary-button" data-updates-app-download href="${e(safeLink(published.downloadURL))}" target="_blank" rel="noopener">${icon('arrow')}Download</a>`});
  }

  /** The one answer at the top: is anything waiting, and when was this last asked. */
  function summary(status) {
    const app=nativeApp(),which=appState(app,expectedApp(app,status)),engineReady=status.updateAvailable===true;
    const count=(engineReady?1:0)+(['available','required'].includes(which)?1:0);
    let tone='good',iconName='check',title='Everything is up to date';
    if(state.updatedTo){title=`Updated to ${state.updatedTo}`;}
    else if(state.waitingSince){tone='busy';iconName='sync';title='Updating Tupies…';}
    else if(state.checking){tone='busy';iconName='sync';title='Checking for updates…';}
    else if(status.error && !status.latest){tone='error';iconName='info';title='Could not check for updates';}
    else if(which==='required'){tone='error';iconName='info';title=`Update this ${app.name} to keep using Tupies`;}
    else if(count){tone='attention';iconName='arrow';title=count===2?'2 updates are ready':'An update is ready';}
    else if(status.error){tone='neutral';iconName='info';title='Could not check just now';}
    else if(status.updateAvailable==null && status.installed.kind==='development'){tone='neutral';iconName='server';title='Running a development copy';}
    else if(!status.checkedAt){tone='neutral';iconName='sync';title='Not checked yet';}
    const note=state.waitingSince||state.updatedTo?'You can keep working; this page reloads by itself.'
      :status.error && !status.latest?status.error
      :status.error && !count?`At the last successful check everything was up to date. Tried ${ago(status.checkedAt)}.`
      :status.checkedAt?`Checked ${ago(status.checkedAt)}${status.error?' · the last check failed':''}`:'';
    const busy=state.checking || state.waitingSince;
    return `<article class="updates-summary glass-card tone-${tone}"><span class="updates-summary-icon ${busy?'spinning':''}" aria-hidden="true">${icon(iconName)}</span><div><h3 role="status" aria-live="polite">${e(title)}</h3>${note?`<p>${e(note)}</p>`:''}</div><button class="secondary-button" data-updates-check ${busy?'disabled':''}>${icon('sync')}${status.error && !status.latest?'Try again':'Check now'}</button></article>`;
  }

  function body() {
    if(state.error && !state.status)return `<div class="empty-state"><p>${e(state.error)}</p><button class="secondary-button" data-updates-retry>Try again</button></div>`;
    if(!state.status)return `<p class="updates-note">Loading…</p>`;
    const rows=engineRow(state.status)+appRow(state.status);
    return `${summary(state.status)}<div class="updates-list glass-card">${rows}</div><p class="updates-trust">${icon('shield')}<span>Updates are signed and verified before they install. A running task is never cut off: Tupies waits until it finishes.</span></p>`;
  }
  const page=()=>`<section class="page settings-page" data-updates-page>${context.settingsHeading('updates','Tupies keeps itself up to date. Update right away, or let it happen when nothing is running.')}<div class="updates-body" data-updates-body>${body()}</div></section>`;
  function paint(){const host=document.querySelector('[data-updates-body]');if(host && current())host.innerHTML=body();}

  async function load({check=false}={}) {
    if(state.loading)return;
    state.loading=true;state.error='';
    try {
      state.status=await context.api('/api/update');baseline ||= fingerprint(state.status);
      const stale=!state.status.checkedAt || Date.now()-new Date(state.status.checkedAt).getTime()>AUTO_CHECK_MS;
      if((check || stale) && !state.waitingSince){state.loading=false;return void await checkNow();}
    } catch(error) {state.error=context.errorText?.(error) || 'Check the connection to this engine and try again.';}
    finally {state.loading=false;paint();}
  }
  async function checkNow() {
    if(state.checking)return;
    state.checking=true;paint();
    try {state.status=await context.api('/api/update/check',{method:'POST',body:{}});}
    catch(error) {context.toast?.(context.errorText?.(error) || 'Could not check for updates.',true);}
    finally {state.checking=false;paint();}
  }
  function stopWaiting(){clearInterval(poll);poll=null;state.waitingSince=0;state.restarting=false;}
  /** After Update now: follow the engine through its restart and reload once it reports another release. */
  function follow(before) {
    clearInterval(poll);
    poll=setInterval(async()=>{
      try {
        const status=await context.api('/api/update');state.restarting=false;state.status=status;
        if(fingerprint(status) && fingerprint(status)!==before) {
          stopWaiting();baseline=fingerprint(status);
          // Reload by itself only while the owner is still watching this page with nothing half-typed elsewhere.
          if(current() && window.tupiesReadyForAppUpdate?.()!==false){state.updatedTo=status.installed.label;paint();setTimeout(()=>location.reload(),1500);}
          else {announced=baseline;announce(status.installed.label);paint();}
          return;
        }
      } catch {state.restarting=true;}
      paint();
    },POLL_MS);
  }
  async function installNow() {
    if(state.requesting || state.waitingSince)return;
    state.requesting=true;paint();
    try {
      const before=fingerprint(state.status);
      state.status=await context.api('/api/update/install',{method:'POST',body:{}});
      state.waitingSince=Date.now();follow(before);
    } catch(error) {context.toast?.(context.errorText?.(error) || 'The update could not be requested.',true);}
    finally {state.requesting=false;paint();}
  }

  // Pages stay open for days. When the engine underneath was replaced, say so once, with a way to load the new screens.
  // Only a signed-in page asks: an unauthenticated request here would send the native app into its sign-in recovery.
  async function watch() {
    if(document.visibilityState!=='visible' || !document.getElementById('main-content') || state.waitingSince || Date.now()-watchedAt<WATCH_MS)return;
    watchedAt=Date.now();
    try {
      const response=await fetch('/api/update',{credentials:'same-origin',headers:{Accept:'application/json'}});
      if(!response.ok)return;
      const status=await response.json(),now=fingerprint(status);
      state.status=status;
      if(!baseline){baseline=now;return;}
      if(now && now!==baseline && announced!==now){announced=now;announce(status.installed.label);}
    } catch {}
  }
  function announce(label) {
    document.querySelector('[data-updates-banner]')?.remove();
    const banner=document.createElement('div');
    banner.className='updates-banner';banner.dataset.updatesBanner='';banner.setAttribute('role','status');
    const text=document.createElement('span');text.textContent=`Tupies was updated to ${label}.`;
    const reload=document.createElement('button');reload.type='button';reload.className='primary-button';reload.textContent='Reload';reload.addEventListener('click',()=>location.reload());
    const later=document.createElement('button');later.type='button';later.className='text-button';later.textContent='Later';later.addEventListener('click',()=>banner.remove());
    banner.append(text,reload,later);document.body.append(banner);
  }

  if(typeof document!=='undefined' && document.addEventListener) {
    document.addEventListener('click',event=>{
      if(!context)return;
      const target=name=>event.target.closest?.(`[data-updates-${name}]`);
      if(target('check'))void checkNow();
      else if(target('install'))void installNow();
      else if(target('retry'))void load();
      else if(target('app-check')){try{window.webkit?.messageHandlers?.hermesStudio?.postMessage({type:'check-app-updates'});}catch{}}
    });
    document.addEventListener('visibilitychange',()=>void watch());
    window.addEventListener?.('focus',()=>void watch());
    setTimeout(()=>void watch(),5000);
  }
  /** Returns the page markup and refreshes what it shows each time the tab is opened. */
  function render(nextContext){context=nextContext;queueMicrotask(()=>void load());return page();}
  /** A small dot for the Settings card when the engine or this app has something newer. */
  const alert=()=>needsAttention()?'<i class="dot warning nav-alert" title="An update is available"></i>':'';
  window.StudioUpdates={render,alert,nativeApp,appState,needsAttention,summary,engineRow,appRow,state};
})();
