/* Phone presentation only. All navigation, submissions and permissions stay in app.js/the engine. */
(() => {
  'use strict';
  const phone = () => window.matchMedia('(max-width:760px), (max-height:500px) and (pointer:coarse)').matches;
  const reduced = () => window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  const query = selector => document.querySelector(selector);
  const positions = new Map(), drafts = new Map(), formSessions = new WeakMap();
  let current = '', previousView = '', navigationAnimation = null, viewportFrame = 0, generation = 0;
  const composer = () => query('.chat-composer textarea');
  const draftKey = field => `${field?.closest('form')?.id}/${field?.closest('form')?.dataset.id}`;
  function rememberDraft() {
    const field = composer();
    if (!field) return;
    const key = draftKey(field);
    if (field.value) drafts.set(key, field.value); else drafts.delete(key);
    // Drafts are memory-only, bounded, and cleared when the session ends.
    while (drafts.size > 30) drafts.delete(drafts.keys().next().value);
  }
  function sizeComposer(field = composer()) {
    if (!phone() || !field) return;
    const thread = query('.chat-thread');
    const atBottom = thread && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
    field.style.height = '0px';
    const limit = Math.max(52, Math.min(180, (window.visualViewport?.height || window.innerHeight) * .28));
    const height = Math.max(26, Math.min(field.scrollHeight, limit));
    field.style.height = `${height}px`;
    field.style.overflowY = field.scrollHeight > height ? 'auto' : 'hidden';
    if (atBottom) thread.scrollTop = thread.scrollHeight;
  }
  function viewport() {
    viewportFrame = 0;
    const root = document.documentElement, view = window.visualViewport;
    // Do not fight browser pinch zoom or pan a magnified page back into place.
    if (!phone()) {
      const field = composer();
      field?.style.removeProperty('height'); field?.style.removeProperty('overflow-y');
      return;
    }
    if (view && Math.abs(view.scale - 1) > .05) return;
    const thread = query('.chat-thread');
    const atBottom = thread && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
    root.style.setProperty('--studio-viewport-height', `${view?.height || window.innerHeight}px`);
    root.style.setProperty('--studio-viewport-top', `${view?.offsetTop || 0}px`);
    root.dataset.keyboard = window.innerHeight - (view?.height || window.innerHeight) > 120 ? 'open' : 'closed';
    sizeComposer();
    if (atBottom) thread.scrollTop = thread.scrollHeight;
  }
  function scheduleViewport() {
    if (!viewportFrame) viewportFrame = window.requestAnimationFrame(viewport);
  }
  function haptic(style = 'selection') {
    if (!phone() || document.documentElement.dataset.studioHaptics !== 'true') return;
    try { window.webkit?.messageHandlers?.hermesStudio?.postMessage({type:'haptic', style}); } catch {}
  }
  function beforeRender() {
    rememberDraft();
    if (phone() && current) positions.set(current, window.scrollY);
    while (positions.size > 60) positions.delete(positions.keys().next().value);
  }
  function afterRender(route) {
    const key = `${route.view}/${route.id || ''}`, changed = !!current && key !== current;
    const field = composer();
    if (field) formSessions.set(field.closest('form'), generation);
    if (field && drafts.has(draftKey(field))) field.value = drafts.get(draftKey(field));
    if (phone()) {
      viewport();
      window.scrollTo({top:positions.get(key) || 0, behavior:'instant'});
      navigationAnimation?.cancel();
      if (changed && !reduced()) {
        const pushed = !!query('.chat-back, .topbar-back');
        const popped = ['bot','room'].includes(previousView) || !pushed && ['settings','connections','skills','integrations','channels','sync','activity','help'].includes(previousView);
        navigationAnimation = query('#main-content')?.animate?.([
          {opacity:.4, transform:pushed ? 'translateX(28px)' : popped ? 'translateX(-18px)' : 'translateY(8px)'},
          {opacity:1, transform:'none'}
        ], {duration:320, easing:'cubic-bezier(.22,1,.36,1)'});
      }
    }
    current = key; previousView = route.view;
  }
  function reset() {
    generation++;
    current = ''; previousView = ''; positions.clear(); drafts.clear();
    navigationAnimation?.cancel();
  }
  function sent(form, submittedText) {
    // Only called after the engine has accepted this exact submission.
    if (formSessions.get(form) !== generation) return;
    const key = `${form.id}/${form.dataset.id}`, field = form.querySelector('textarea');
    const visible = composer();
    // While the request travelled, the owner may have typed the next message or
    // revisited this chat. Preserve that newer draft instead of clearing it.
    const latest = visible && draftKey(visible) === key ? visible : field;
    if (latest?.value && latest.value !== submittedText) drafts.set(key, latest.value);
    else {drafts.delete(key); if (latest) latest.value = '';}
    sizeComposer(latest?.isConnected ? latest : composer());
    haptic('light');
  }
  function closeSheet(dialog, finish) {
    if (!phone() || reduced() || !dialog.animate) return false;
    if (dialog.dataset.closing) return true;
    dialog.dataset.closing = 'true';
    const animation = dialog.animate([{transform:getComputedStyle(dialog).transform}, {transform:'translateY(100%)', opacity:.5}],
      {duration:210, easing:'cubic-bezier(.4,0,1,1)', fill:'forwards'});
    // A replacement dialog may already have been opened when this completes.
    animation.finished.then(() => {if (dialog.isConnected && dialog.open) finish();}, () => {}).finally(() => animation.cancel());
    return true;
  }
  function mountDialog(dialog, dismiss) {
    if (!phone()) return;
    dialog.querySelector('h2')?.focus({preventScroll:true});
    dialog.addEventListener('cancel', event => {event.preventDefault(); dismiss();});
    const handle = dialog.querySelector('.sheet-grabber');
    let start = null, distance = 0, suppressClick = false;
    const release = event => {
      if (!start || event.pointerId !== start.id) return;
      const commit = event.type === 'pointerup' && distance > 85;
      start = null;
      dialog.style.removeProperty('transform'); dialog.classList.remove('is-dragging');
      if (commit) {haptic('light'); dismiss();}
    };
    handle?.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !phone()) return;
      start = {y:event.clientY, id:event.pointerId}; distance = 0; suppressClick = false;
      handle.setPointerCapture(event.pointerId); dialog.classList.add('is-dragging');
    });
    handle?.addEventListener('pointermove', event => {
      if (!start || event.pointerId !== start.id) return;
      distance = Math.max(0, event.clientY - start.y);
      if (Math.abs(event.clientY - start.y) > 6) suppressClick = true;
      if (!reduced()) dialog.style.transform = `translateY(${distance}px)`;
    });
    for (const name of ['pointerup','pointercancel','lostpointercapture']) handle?.addEventListener(name, release);
    handle?.addEventListener('click', event => {
      if (!suppressClick) return;
      suppressClick = false; event.preventDefault(); event.stopPropagation();
    });
  }
  // A left-edge back gesture follows the screen's own Back destination, never arbitrary history.
  let edge = null;
  document.addEventListener('touchstart', event => {
    if (!phone() || event.touches.length !== 1 || query('dialog[open], .menu-layer')) return;
    const touch = event.touches[0], back = query('.chat-back, .topbar-back');
    if (touch.clientX > 20 || !back || window.getSelection()?.toString()) return;
    edge = {x:touch.clientX, y:touch.clientY, back, target:query('#main-content'), distance:0};
  }, {passive:true});
  document.addEventListener('touchmove', event => {
    if (!edge) return;
    if (event.touches.length !== 1) {cancelEdge(); return;}
    const touch = event.touches[0], dx = touch.clientX - edge.x, dy = touch.clientY - edge.y;
    if (Math.abs(dy) > 45 || dx < -8) {cancelEdge(); return;}
    if (dx > 12 && dx > Math.abs(dy) * 1.5) {
      event.preventDefault(); edge.distance = dx;
      navigationAnimation?.cancel();
      if (!reduced()) edge.target.style.transform = `translateX(${Math.min(dx * .65, 140)}px)`;
    }
  }, {passive:false});
  function cancelEdge() {if (edge) edge.target?.style.removeProperty('transform'); edge = null;}
  document.addEventListener('touchend', () => {
    const back = edge?.distance > 90 ? edge.back : null;
    cancelEdge(); if (back?.isConnected) back.click();
  }, {passive:true});
  document.addEventListener('touchcancel', cancelEdge, {passive:true});
  document.addEventListener('input', event => {
    if (event.target.matches('.chat-composer textarea')) {rememberDraft(); sizeComposer(event.target);}
  });
  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const control = event.target.closest('button[data-nav], .segment, .chat-switcher, .chat-more');
    if (control && !control.disabled && !control.matches('[aria-current="page"], .segment.active')) haptic();
  });
  for (const name of ['resize','orientationchange','studio:text-size']) window.addEventListener(name, scheduleViewport);
  window.visualViewport?.addEventListener('resize', scheduleViewport);
  window.visualViewport?.addEventListener('scroll', scheduleViewport);
  document.addEventListener('focusin', scheduleViewport);
  document.addEventListener('focusout', scheduleViewport);
  window.StudioMobile = {beforeRender, afterRender, mountDialog, closeSheet, sent, reset, sizeComposer};
})();
