/* Settings › Version & updates: which version this engine and this app run, whether a newer one exists, and how it arrives. */
(()=>{
  'use strict';
  // The first iPhone and Mac app build that reports its own version to the page. An app that says nothing is older.
  const FIRST_REPORTING_BUILD=17,AUTO_CHECK_MS=12*3600_000,POLL_MS=4000,WAIT_NOTE_MS=90_000,WATCH_MS=60_000;
  let context=null,poll=null,baseline='',watchedAt=0,announced='';
  const state={status:null,loading:false,checking:false,requesting:false,error:'',waitingSince:0,restarting:false,updatedTo:''};
  const e=value=>context?context.esc(String(value ?? '')):String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon=name=>context?.icon?.(name)||'';
  const current=()=>Boolean(context && context.route().view==='updates' && document.querySelector('[data-updates-page]'));
  const day=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):'';};
  const ago=value=>{const minutes=Math.round((Date.now()-new Date(value).getTime())/60_000);return !Number.isFinite(minutes)?'':minutes<1?'just now':minutes<60?`${minutes} min ago`:minutes<1440?`${Math.round(minutes/60)} h ago`:day(value);};
  /** What identifies the running copy; it changes exactly when the engine was replaced. */
  const fingerprint=status=>status?.installed?.id || status?.installed?.commit || '';

  /** The native app around this page, as it reports itself. `build` is null for an app too old to say. */
  function nativeApp(root=document.documentElement) {
    const platform=root?.dataset?.studioApp;
    if(platform!=='ios' && platform!=='macos')return null;
    const build=Number(root.dataset.studioAppBuild),known=Number.isInteger(build) && build>0;
    return {platform,name:platform==='ios'?'iPhone app':'Mac app',version:known?root.dataset.studioAppVersion||'':'',build:known?build:null};
  }
  /** "current", "available" or "required" for the app around this page, given what this engine's web UI expects. */
  function appState(app,expected) {
    if(!app || !expected)return 'current';
    const build=app.build ?? FIRST_REPORTING_BUILD-1;
    return build<expected.minimumBuild?'required':build<expected.build?'available':'current';
  }
  const expectedApp=(app,status)=>app?status?.apps?.[app.platform==='ios'?'ios':'mac']||null:null;
  /** True when Settings should draw attention to this page. */
  function needsAttention(status=state.status,app=nativeApp()) {
    return Boolean(status && (status.updateAvailable===true || appState(app,expectedApp(app,status))!=='current'));
  }

  function installedNote(installed) {
    if(installed.kind==='release')return `Released ${day(installed.releasedAt)}`;
    if(installed.kind==='build')return installed.builtAt?`Built from the code of ${day(installed.builtAt)}`:'Built from source';
    return 'Running from a source folder';
  }
  /** How a newer release reaches this engine, in the owner's words. */
  function howItArrives(status,app,local) {
    const mode=status.install.mode;
    if(status.latest?.expired)return 'Its signed release note is more than 30 days old, so servers no longer install it by themselves. Publish a fresh release.';
    if(mode==='request')return 'Tupies restarts by itself once no task is running, and comes back in about a minute.';
    if(mode==='automatic')return 'This server installs it by itself within about 30 minutes, once no task is running.';
    if(app?.platform==='macos' && local)return 'This Mac runs the engine that comes with the Mac app, so it arrives with the next Mac app update.';
    return 'This copy was installed by hand. Update it the same way it was installed.';
  }
  function engineCard(status) {
    const {installed,latest,install}=status,app=nativeApp(),local=['127.0.0.1','localhost','[::1]'].includes(location.hostname);
    let headline,detail='',action='';
    if(state.updatedTo){headline=`Updated to ${state.updatedTo}`;detail='Reloading this page…';}
    else if(state.waitingSince) {
      headline=state.restarting?'Tupies is restarting…':install.installing?'Installing the update…':'Update requested';
      detail=Date.now()-state.waitingSince>WAIT_NOTE_MS?'Still waiting. The update installs as soon as no task, room or sign-in is running; it also retries by itself every 30 minutes. You can leave this page.':'Tupies restarts by itself once no task is running. This page reloads when it is back.';
    } else if(state.checking){headline='Checking for updates…';}
    else if(status.error && !latest){headline='Could not check for updates';detail=status.error;}
    else if(status.updateAvailable===true) {
      headline=`${latest.label} is available`;detail=`Published ${day(latest.publishedAt)}. ${howItArrives(status,app,local)}`;
      if(install.mode==='request' && !latest.expired)action=`<button class="primary-button" data-updates-install ${state.requesting?'disabled':''}>${icon('arrow')}Update now</button>`;
    } else if(status.updateAvailable===false){headline='Up to date';detail=`${latest.label} is the newest release.`;}
    else if(latest){headline=`Newest release: ${latest.label}`;detail=`Published ${day(latest.publishedAt)}. This copy runs from source, so Tupies cannot tell whether it already includes it.`;}
    else {headline='Not checked yet';}
    const checked=status.checkedAt && !state.checking && !state.waitingSince?`<small class="updates-checked">Checked ${e(ago(status.checkedAt))}${status.error && latest?` · the last check failed`:''}</small>`:'';
    const tone=state.updatedTo || status.updateAvailable===false?'good':status.updateAvailable===true || state.waitingSince?'attention':'';
    return `<article class="updates-card glass-card" data-updates-engine><header><span class="setup-icon">${icon('server')}</span><div><h3>Tupies Engine</h3><p class="updates-version">Version ${e(installed.label)}</p><small>${e(installedNote(installed))}</small></div></header><div class="updates-state ${tone}" role="status" aria-live="polite"><strong>${e(headline)}</strong>${detail?`<p>${e(detail)}</p>`:''}</div><footer>${action}<button class="secondary-button" data-updates-check ${state.checking || state.waitingSince?'disabled':''}>${icon('sync')}Check for updates</button>${checked}</footer></article>`;
  }
  function appCard(status) {
    const app=nativeApp();
    if(!app)return `<p class="updates-note">Open this page in the Tupies iPhone or Mac app to see that app’s version.</p>`;
    const expected=expectedApp(app,status),stateName=appState(app,expected),newest=expected?`${expected.version} (${expected.build})`:'';
    const version=app.build?`Version ${app.version} (${app.build})`:'An earlier build that does not report its version';
    let headline='Up to date',detail='',action='';
    if(stateName!=='current') {
      headline=stateName==='required'?`Update this ${app.name} to keep using Tupies`:`${app.name} ${newest} is available`;
      if(app.platform==='ios') {
        detail=stateName==='required'?`This engine needs ${app.name} ${newest} or newer. Some screens may not work until you update.`:'It has changes that only reach you through a new app build.';
        action=expected.testflightURL?`<a class="primary-button" href="${e(expected.testflightURL)}" target="_blank" rel="noopener">${icon('arrow')}Open TestFlight</a>`:`<p class="updates-how">Open the <strong>TestFlight</strong> app on this iPhone and tap <strong>Update</strong> next to Tupies.</p>`;
      } else detail=stateName==='required'?`This engine needs ${app.name} ${newest} or newer.`:'It has changes that only reach you through a new app build.';
    }
    // The Mac app checks its own signed feed; older builds have the same command in the menu bar.
    if(app.platform==='macos')action=app.build?`<button class="${stateName==='current'?'secondary-button':'primary-button'}" data-updates-app-check>${icon('sync')}Check for Mac app updates</button>`:`<p class="updates-how">Choose <strong>Tupies → Check for Updates…</strong> in the menu bar.</p>`;
    return `<article class="updates-card glass-card" data-updates-app><header><span class="setup-icon">${icon(app.platform==='ios'?'phone':'grid')}</span><div><h3>${e(app.name)}</h3><p class="updates-version">${e(version)}</p><small>Changes to the screens you see here arrive with the engine. The app itself changes only with a new build.</small></div></header><div class="updates-state ${stateName==='current'?'good':'attention'}" role="status"><strong>${e(headline)}</strong>${detail?`<p>${e(detail)}</p>`:''}</div>${action?`<footer>${action}</footer>`:''}</article>`;
  }
  function body() {
    if(state.error && !state.status)return `<div class="empty-state"><p>${e(state.error)}</p><button class="secondary-button" data-updates-retry>Try again</button></div>`;
    if(!state.status)return `<p class="updates-note">Loading…</p>`;
    return `${engineCard(state.status)}${appCard(state.status)}`;
  }
  const page=()=>`<section class="page settings-page" data-updates-page>${context.settingsHeading('updates','The version running here, and how the newest one reaches you.')}<div class="updates-body" data-updates-body>${body()}</div></section>`;
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
  window.StudioUpdates={render,alert,nativeApp,appState,needsAttention,engineCard,appCard,state};
})();
