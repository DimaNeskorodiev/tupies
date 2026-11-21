/* Settings › Devices & sync: whether phone alerts actually leave this engine, and why not.
   Reads /api/notifications/health (no tokens). The Settings overview shows a dot while a phone misses alerts. */
(()=>{
  'use strict';
  let health=null;
  const BUILD={sandbox:'Xcode build (Apple sandbox)',production:'Release or TestFlight build (Apple production)'};
  const ENVIRONMENT={sandbox:'Sandbox',production:'Production'};
  const when=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'recently';};

  /** Plain words for why an enrolled phone gets nothing, and what fixes it. */
  function explain(reason,device,apple) {
    if(reason==='environment_mismatch') {
      const has=(apple?.environments || []).map(name=>ENVIRONMENT[name] || name).join(' and ') || 'no';
      return device?.environment==='production'
        ? `This iPhone runs a Release or TestFlight build, which uses Apple’s Production push service. This engine has only a ${has} key. Add a Production APNs key to the engine (STUDIO_APNS_PRODUCTION_KEY_FILE and STUDIO_APNS_PRODUCTION_KEY_ID), or install an Xcode development build on the phone.`
        : `This iPhone runs an Xcode development build, which uses Apple’s Sandbox push service. This engine has only a ${has} key. Add a Sandbox key to the engine, or install the Release build on the phone.`;
    }
    if(reason==='not_configured')return 'Apple push isn’t set up on this engine. Add the APNs key settings (see Notifications in Help), then restart the engine.';
    if(reason==='storage_unavailable')return 'This engine can’t read its notification settings file. Restore it from a backup.';
    if(reason==='home_server_only')return 'Alerts are sent by your home server.';
    if(reason==='push_authorization_failed')return 'Apple refused this engine’s push key. Check that the key, Team ID and environment match the app.';
    if(reason==='registration_expired')return 'Apple says this phone’s registration expired. Open the iPhone app once to register again.';
    if(reason==='delivery_rejected')return 'Apple rejected the last alert.';
    if(reason==='delivery_unknown')return 'The last alert’s delivery could not be confirmed.';
    return '';
  }

  async function load(api) {
    try {health=await api('/api/notifications/health');} catch {health=null;}
    return health;
  }

  /** A warning dot for the Settings overview's Devices & sync card. */
  function alert(data) {
    return data?.pushAlert?'<i class="dot warning nav-alert" title="Phone alerts are not being delivered"></i>':'';
  }

  function deviceRow(ctx,device,apple) {
    const {esc,relative,icon}=ctx;
    let tone='ready',label='Alerts on',note='';
    if(!device.enabled){tone='';label='Alerts off';note='Alerts are turned off on this phone.';}
    else if(device.missed){tone='error';label=`${device.missed.count} missed`;note=`Not sent since ${when(device.missed.since)}. ${explain(device.missed.reason,device,apple)}`;}
    else if(device.reason){tone='error';label='Not delivering';note=explain(device.reason,device,apple);}
    else if(device.last && ['failed','unknown'].includes(device.last.status)){tone='attention';label='Last alert failed';note=explain(device.last.error,device,apple);}
    else note=device.lastSentAt?`Last alert sent ${relative(device.lastSentAt)}.`:'No alert sent yet.';
    const kinds=[device.botReplies?'replies, questions and approvals':'',device.routines?'routines':''].filter(Boolean).join(' · ');
    return `<li data-push-device><span class="setup-icon small">${icon('phone')}</span><div><strong>${esc(device.name)}</strong><span class="tag status-pill ${tone}"><i class="dot"></i>${esc(label)}</span><span>${esc(BUILD[device.environment] || device.environment)}${kinds?` · ${esc(kinds)}`:''}</span>${note?`<span class="push-health-note">${esc(note)}</span>`:''}</div></li>`;
  }

  function card(ctx) {
    if(!health)return '';
    const {esc,icon}=ctx,apple=health.apple || {};
    if(health.role==='replica')return `<article class="glass-card sync-card" data-push-health><span class="setup-icon">${icon('phone')}</span><div class="sync-card-body"><p class="eyebrow">PHONE ALERTS</p><h3>Sent by your home server</h3><p>Open the home server’s Settings → Devices & sync to see whether your phone receives alerts.</p></div></article>`;
    const setup=apple.configured
      ? `Apple push: ${esc((apple.environments || []).map(name=>ENVIRONMENT[name] || name).join(' and '))}${apple.invalid?.length?` · the ${esc(apple.invalid.map(name=>ENVIRONMENT[name] || name).join(' and '))} key can’t be used`:''}`
      : 'Apple push isn’t set up on this engine.';
    const devices=health.devices || [];
    const list=devices.length?`<ul class="device-list">${devices.map(device=>deviceRow(ctx,device,apple)).join('')}</ul>`:'<p class="subtle-label">No phone has turned on alerts yet. In the iPhone app, open Settings → Notifications.</p>';
    const paused=health.paused?'<p class="subtle-label">Alerts wait while this engine installs an update.</p>':'';
    return `<article class="glass-card sync-card sync-devices" data-push-health><div class="sync-devices-head"><div><p class="eyebrow">PHONE ALERTS</p><h3>Replies, questions, approvals and routines</h3><p>${setup}</p>${paused}</div></div>${list}</article>`;
  }

  window.StudioNotificationHealth={load,card,alert,explain};
})();
