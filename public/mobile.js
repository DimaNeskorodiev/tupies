/* Phone presentation only. All navigation, submissions and permissions stay in app.js/the engine.
   Motion follows UIKit: an interactive left-edge Back, push/pop with parallax, springy sheets, a gliding
   tab-bar lens, scroll-edge navigation bars, long-press context menus and chat motion. Gestures only ever
   activate controls the screen already has (its Back button, menu items app.js handles); they never replay
   history, submit forms or start engine work. Animations use transform and opacity (the composer's
   height is the one exception) and are skipped or reduced to crossfades under Reduce Motion. */
(() => {
  'use strict';
  const PHONE = '(max-width:760px), (max-height:500px) and (pointer:coarse)';
  const phone = () => window.matchMedia(PHONE).matches;
  const reduced = () => window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  const query = selector => document.querySelector(selector);
  const root = document.documentElement;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const positions = new Map(), drafts = new Map(), formSessions = new WeakMap();
  let current = '', viewportFrame = 0, generation = 0;
  root.dataset.studioMotion = 'true';

  /* ---------- Motion primitives ---------- */
  // Damped springs sampled into CSS linear() (the same curves as mobile-motion.css), with cubic fallbacks.
  const SPRINGS = {
    nav: ['linear(0, 0.06, 0.188, 0.333, 0.469, 0.588, 0.686, 0.764, 0.824, 0.87, 0.905, 0.931, 0.95, 0.964, 0.974, 0.982, 0.987, 0.991, 0.993, 0.995, 1)', 'cubic-bezier(.22,1,.36,1)'],
    sheet: ['linear(0, 0.033, 0.111, 0.213, 0.323, 0.432, 0.533, 0.623, 0.701, 0.767, 0.822, 0.866, 0.901, 0.929, 0.95, 0.966, 0.978, 0.987, 0.993, 0.997, 1, 1.001, 1.002, 1.003, 1.003, 1.003, 1.003, 1.002, 1)', 'cubic-bezier(.2,.9,.3,1)'],
    bouncy: ['linear(0, 0.026, 0.094, 0.187, 0.295, 0.408, 0.518, 0.622, 0.715, 0.796, 0.865, 0.921, 0.965, 0.999, 1.023, 1.039, 1.049, 1.053, 1.054, 1.052, 1.048, 1.042, 1.036, 1.03, 1.024, 1.019, 1.014, 1.01, 1.006, 1.003, 1.001, 1, 0.998, 0.998, 0.997, 0.997, 1)', 'cubic-bezier(.34,1.36,.64,1)'],
  };
  let linearEasing = null;
  function spring(name) {
    if (linearEasing === null) {try {linearEasing = !!window.CSS?.supports?.('transition-timing-function', 'linear(0, 1)');} catch {linearEasing = false;}}
    return SPRINGS[name][linearEasing ? 0 : 1];
  }
  const EASE_OUT = 'cubic-bezier(.22,1,.36,1)';
  // A released gesture continues at the finger's speed: the curve's initial slope matches its velocity.
  function continueEase(velocity, distance, duration) {
    const slope = distance > 0 ? clamp(velocity * duration / distance, 0, 4) : 0;
    return `cubic-bezier(.2,${(.2 * slope).toFixed(3)},.3,1)`;
  }
  const canAnimate = element => !!element && typeof element.animate === 'function';
  function play(element, frames, options) {
    if (!canAnimate(element)) return null;
    try {return element.animate(frames, options);}
    catch {try {return element.animate(frames, {...options, easing:EASE_OUT});} catch {return null;}}
  }
  const now = () => window.performance?.now?.() ?? Date.now();
  // Velocity from the last 100 ms of samples. Too short a window means "unknown", which counts as zero.
  function track(samples, value, time) {
    samples.push({value, time});
    while (samples.length > 2 && time - samples[0].time > 100) samples.shift();
  }
  function speed(samples) {
    if (samples.length < 2) return 0;
    const first = samples[0], last = samples[samples.length - 1], elapsed = last.time - first.time;
    return elapsed >= 12 ? (last.value - first.value) / elapsed : 0;
  }
  // Inline styles set for one gesture or transition, restored exactly afterwards.
  function styleSession() {
    const saved = new Map();
    return {
      set(element, property, value) {
        if (!element) return;
        if (!saved.has(element)) saved.set(element, new Map());
        const properties = saved.get(element);
        if (!properties.has(property)) properties.set(property, element.style.getPropertyValue(property));
        element.style.setProperty(property, value);
      },
      restore() {
        for (const [element, properties] of saved) for (const [property, value] of properties) {
          if (value) element.style.setProperty(property, value); else element.style.removeProperty(property);
        }
        saved.clear();
      },
    };
  }
  const part = className => {const element = document.createElement('div'); element.className = className; return element;};
  const shown = element => !!element && getComputedStyle(element).display !== 'none';
  let insetProbe = null;
  function safeInsets() {
    if (!insetProbe?.isConnected) {insetProbe = part('motion-inset-probe'); document.body.append(insetProbe);}
    const style = getComputedStyle(insetProbe);
    return {top:parseFloat(style.paddingTop) || 0, bottom:parseFloat(style.paddingBottom) || 0};
  }
  function pageBackground(element) {
    const style = getComputedStyle(document.body);
    const color = style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent' ? style.backgroundColor : '#f5f8fc';
    element.style.backgroundColor = color;
    if (style.backgroundImage && style.backgroundImage !== 'none') element.style.backgroundImage = style.backgroundImage;
  }

  /* ---------- Haptics ---------- */
  // The native shell accepts this vocabulary; older shells ignore styles they do not know.
  const HAPTICS = new Set(['selection','light','medium','rigid','soft','success','warning','error']);
  function haptic(style = 'selection') {
    if (!HAPTICS.has(style) || !phone() || root.dataset.studioHaptics !== 'true') return;
    try {window.webkit?.messageHandlers?.hermesStudio?.postMessage({type:'haptic', style});} catch {}
  }

  /* ---------- Drafts, composer and keyboard ---------- */
  const composer = () => query('#app .chat-composer textarea');
  const draftKey = field => `${field?.closest('form')?.id}/${field?.closest('form')?.dataset.id}`;
  let composerMotion = null;
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
    const thread = query('#app .chat-thread');
    const atBottom = thread && !thread.__searchAnchor && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
    composerMotion?.cancel(); composerMotion = null;
    const before = parseFloat(field.style.height) || 0;
    field.style.height = '0px';
    const limit = Math.max(52, Math.min(180, (window.visualViewport?.height || window.innerHeight) * .28));
    const height = Math.max(26, Math.min(field.scrollHeight, limit));
    field.style.height = `${height}px`;
    field.style.overflowY = field.scrollHeight > height ? 'auto' : 'hidden';
    if (atBottom) thread.scrollTop = thread.scrollHeight;
    // A new line grows the composer smoothly; the transcript stays pinned to the latest message meanwhile.
    if (before && Math.abs(before - height) >= 6 && !reduced() && field === document.activeElement) {
      composerMotion = play(field, [{height:`${before}px`}, {height:`${height}px`}], {duration:150, easing:EASE_OUT});
      if (composerMotion && atBottom) {
        const motion = composerMotion, pin = () => {if (composerMotion !== motion) return; thread.scrollTop = thread.scrollHeight; window.requestAnimationFrame(pin);};
        window.requestAnimationFrame(pin);
        motion.finished.then(() => {if (composerMotion === motion) {composerMotion = null; thread.scrollTop = thread.scrollHeight;}}, () => {});
      }
    }
  }
  // Only a focused field can raise the onscreen keyboard.
  const EDITABLE = 'input:not([type=button],[type=checkbox],[type=color],[type=file],[type=hidden],[type=image],[type=radio],[type=range],[type=reset],[type=submit]),textarea,select,[contenteditable]:not([contenteditable=false])';
  const editing = () => !!document.activeElement?.matches?.(EDITABLE);
  let restingHeight = 0, restingWidth = 0;
  // WKWebView can keep reporting a large scale after the keyboard hides. Real pinch zoom also
  // narrows the visual viewport, so both must hold before the page leaves the geometry alone.
  function zoomed(view) {
    const layoutWidth = root.clientWidth || window.innerWidth;
    return !!view && view.scale > 1.05 && view.width < layoutWidth - 2;
  }
  function viewport() {
    viewportFrame = 0;
    const view = window.visualViewport;
    if (!phone()) {
      const field = composer();
      field?.style.removeProperty('height'); field?.style.removeProperty('overflow-y');
      return;
    }
    // Do not fight browser pinch zoom or pan a magnified page back into place.
    if (zoomed(view)) return;
    const thread = query('#app .chat-thread');
    const atBottom = thread && !thread.__searchAnchor && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
    const height = view?.height || window.innerHeight, width = view?.width || window.innerWidth;
    if (!editing()) {
      // No keyboard can be up: CSS sizes the screen (100dvh), and this height is the resting one.
      root.style.removeProperty('--studio-viewport-height'); root.style.removeProperty('--studio-viewport-top');
      root.dataset.keyboard = 'closed';
      if (Math.abs(width - restingWidth) > 1) {restingWidth = width; restingHeight = 0;}
      restingHeight = Math.max(restingHeight, height);
    } else {
      // WKWebView shrinks innerHeight with the keyboard, so compare with the resting height too.
      const open = restingHeight - height > 120 || window.innerHeight - height > 120;
      root.style.setProperty('--studio-viewport-height', `${height}px`);
      root.style.setProperty('--studio-viewport-top', `${view?.offsetTop || 0}px`);
      root.dataset.keyboard = open ? 'open' : 'closed';
    }
    sizeComposer();
    if (atBottom) thread.scrollTop = thread.scrollHeight;
  }
  function scheduleViewport() {
    if (!viewportFrame) viewportFrame = window.requestAnimationFrame(viewport);
  }

  /* ---------- Screen snapshots ---------- */
  // When a screen is left, an inert copy is kept briefly (at most four) so Back can show the screen
  // underneath while the finger drags, and push/pop can slide the outgoing screen away like UIKit.
  const snapshots = new Map();
  let outgoing = null;
  const routeKey = value => {const [view, id] = String(value || '').replace(/^#?\/?/, '').split('/'); return `${view || 'dashboard'}/${id || ''}`;};
  const backControl = () => query('#app .chat-back, #app .topbar-back');
  function cloneDeep(node) {
    const copy = node.cloneNode(true);
    if (node.nodeType !== 1) return copy;
    const copies = copy.querySelectorAll('canvas');
    node.querySelectorAll('canvas').forEach((canvas, index) => {
      try {if (canvas.width && canvas.height) copies[index]?.getContext('2d')?.drawImage(canvas, 0, 0);} catch {}
    });
    return copy;
  }
  const spacer = height => {const element = document.createElement('div'); element.style.height = `${height}px`; return element;};
  // A long transcript is copied only around what is on screen; spacers keep the copy's scroll geometry.
  function cloneAround(node, thread) {
    if (node.nodeType !== 1 || !node.contains(thread)) return cloneDeep(node);
    const copy = node.cloneNode(false);
    if (node !== thread) {for (const child of node.childNodes) copy.append(cloneAround(child, thread)); return copy;}
    const children = [...thread.children], view = thread.getBoundingClientRect(), reach = window.innerHeight || 800;
    const kept = children.filter(child => {const box = child.getBoundingClientRect(); return box.bottom >= view.top - reach && box.top <= view.bottom + reach / 2;});
    if (!kept.length || kept.length === children.length) {for (const child of thread.childNodes) copy.append(cloneDeep(child)); return copy;}
    const head = kept[0].getBoundingClientRect().top - children[0].getBoundingClientRect().top;
    const tail = children[children.length - 1].getBoundingClientRect().bottom - kept[kept.length - 1].getBoundingClientRect().bottom;
    if (head > 0) copy.append(spacer(head));
    for (const child of kept) copy.append(cloneDeep(child));
    if (tail > 0) copy.append(spacer(tail));
    return copy;
  }
  function capture() {
    const shell = query('#app > .app-shell');
    if (!shell) return null;
    const thread = shell.querySelector('.chat-thread'), back = backControl();
    const node = thread ? cloneAround(shell, thread) : cloneDeep(shell);
    for (const media of node.querySelectorAll('iframe,video,audio,object,embed')) media.remove();
    // Copies never duplicate the live screen's ids; the few layout rules keyed on ids are mirrored in CSS.
    for (const element of node.querySelectorAll('[id]')) {element.dataset.motionId = element.id; element.removeAttribute('id');}
    return {node, scrollY:window.scrollY, threadScroll:thread?.scrollTop || 0, tabbar:shown(shell.querySelector('.tabbar')), backTarget:back?.dataset.nav ? routeKey(back.dataset.nav) : ''};
  }
  function layer(over) {
    const element = part('motion-layer');
    if (over) element.dataset.over = 'true';
    element.setAttribute('aria-hidden', 'true'); element.inert = true;
    return element;
  }
  function frame(snapshot) {
    const element = part('motion-frame');
    pageBackground(element);
    if (snapshot) {const scroller = part('motion-scroller'); scroller.append(snapshot.node); element.append(scroller);}
    return element;
  }
  function placeSnapshot(snapshot) {
    if (!snapshot) return;
    const scroller = snapshot.node.parentElement;
    if (scroller) scroller.scrollTop = snapshot.scrollY;
    const thread = snapshot.node.querySelector('.chat-thread');
    if (thread) thread.scrollTop = snapshot.threadScroll;
  }
  function surfaces() {
    const shell = query('#app > .app-shell');
    const content = shell?.querySelector(':scope > .content') || query('#main-content');
    const tabbar = shell?.querySelector(':scope > .tabbar');
    return {shell, content, tabbar:shown(tabbar) ? tabbar : null, fixedShell:!!shell && getComputedStyle(shell).position === 'fixed'};
  }
  // The real screen gets a stacking level relative to the copy (below it for pop, above it for push).
  function raise(session, parts, z) {
    const target = parts.fixedShell ? parts.shell : parts.content;
    if (!target) return;
    if (getComputedStyle(target).position === 'static') session.set(target, 'position', 'relative');
    session.set(target, 'z-index', String(z));
  }

  /* ---------- Push, pop and tab transitions ---------- */
  const SETTINGS = new Set(['connections','skills','integrations','channels','sync','activity','help']);
  const family = key => {const view = key.split('/')[0]; return SETTINGS.has(view) ? 'section' : view;};
  let stack = [], active = null, pendingPop = null, pendingTimer = 0;
  // Push when going deeper, pop when returning to a screen underneath, crossfade between tabs or siblings.
  function classify(from, to, backTarget, hasBack) {
    const index = stack.lastIndexOf(to);
    if (to === backTarget || index >= 0 && index < stack.length - 1 || to === 'settings/' && family(from) === 'section') {
      stack = index >= 0 ? stack.slice(0, index + 1) : [to];
      return 'pop';
    }
    if (!hasBack) {stack = [to]; return 'fade';}
    if (!stack.length) stack = [from];
    if (family(from) === family(to) && stack.length > 1) {stack[stack.length - 1] = to; return 'fade';}
    stack.push(to);
    while (stack.length > 12) stack.shift();
    return 'push';
  }
  function settle() {
    const running = active;
    active = null;
    if (!running) return;
    window.clearTimeout(running.timer);
    for (const animation of running.animations) {try {animation.cancel();} catch {}}
    running.done();
  }
  const longest = animations => Math.max(0, ...animations.map(animation => Number(animation.effect?.getTiming?.().duration) || 0));
  function run(animations, cleanup) {
    let finished = false;
    const record = {animations:animations.filter(Boolean), done:() => {if (!finished) {finished = true; cleanup();}}};
    if (!record.animations.length) {record.done(); return;}
    active = record;
    Promise.all(record.animations.map(animation => animation.finished)).then(() => {if (active === record) settle();}, () => {});
    // If the page stops producing frames (hidden, backgrounded), the screen still ends up in place.
    record.timer = window.setTimeout(() => {if (active === record) settle();}, longest(record.animations) + 600);
  }
  function transition(kind, snapshot, interactive) {
    settle();
    const parts = surfaces();
    if (!snapshot || !parts.content || !canAnimate(parts.content)) return;
    const width = window.innerWidth || 390, parallax = -.3 * width, session = styleSession(), animations = [];
    const finish = element => () => {element.remove(); snapshot.node.remove(); session.restore();};
    if (reduced() || kind === 'fade') {
      // Tabs and siblings crossfade; Reduce Motion turns every transition into a crossfade.
      const over = layer(true), shot = frame(snapshot);
      if (parts.tabbar) over.dataset.hideTabbar = 'true';
      over.append(shot); document.body.append(over); placeSnapshot(snapshot);
      raise(session, parts, 2);
      animations.push(play(shot, [{opacity:interactive?.opacity ?? 1}, {opacity:0}], {duration:kind === 'fade' && !reduced() ? 180 : 220, easing:'ease-out', fill:'forwards'}));
      run(animations, finish(over));
      return;
    }
    const dim = part('motion-dim'), shot = frame(snapshot), timing = {duration:340, easing:spring('nav'), fill:'forwards'};
    raise(session, parts, 2);
    session.set(parts.content, 'will-change', 'transform');
    if (kind === 'push') {
      // The new screen slides in over the old one, which parallaxes left under a light dim.
      const under = layer(false), backdrop = part('motion-backdrop is-leading');
      pageBackground(backdrop);
      if (snapshot.tabbar && parts.tabbar) under.dataset.hideTabbar = 'true';
      under.append(shot, dim, backdrop); document.body.append(under); placeSnapshot(snapshot);
      const enter = [{transform:`translate3d(${width}px,0,0)`}, {transform:'translate3d(0,0,0)'}];
      animations.push(play(parts.content, enter, timing), play(backdrop, enter, timing),
        play(shot, [{transform:'translate3d(0,0,0)'}, {transform:`translate3d(${parallax}px,0,0)`}], timing),
        play(dim, [{opacity:0}, {opacity:1}], timing));
      if (parts.tabbar && !snapshot.tabbar) animations.push(play(parts.tabbar, enter, timing));
      run(animations, finish(under));
      return;
    }
    // Pop: the old screen slides off to the right, revealing the destination from its parallax position.
    const over = layer(true), start = clamp(interactive?.dx || 0, 0, width), progress = start / width, remaining = width - start;
    if (snapshot.tabbar && parts.tabbar) over.dataset.hideTabbar = 'true';
    shot.classList.add('is-leading');
    over.append(dim, shot); document.body.append(over); placeSnapshot(snapshot);
    let popTiming = timing;
    if (interactive) {
      const duration = clamp(remaining / Math.max(interactive.velocity || 0, 1.1), 160, 320);
      popTiming = {duration, easing:continueEase(interactive.velocity || 0, remaining, duration), fill:'forwards'};
    }
    const reveal = [{transform:`translate3d(${parallax * (1 - progress)}px,0,0)`}, {transform:'translate3d(0,0,0)'}];
    animations.push(play(shot, [{transform:`translate3d(${start}px,0,0)`}, {transform:`translate3d(${width}px,0,0)`}], popTiming),
      play(dim, [{opacity:1 - progress}, {opacity:0}], popTiming), play(parts.content, reveal, popTiming));
    if (parts.tabbar && !snapshot.tabbar) {session.set(parts.tabbar, 'z-index', '2'); animations.push(play(parts.tabbar, reveal, popTiming));}
    run(animations, finish(over));
  }

  /* ---------- Interactive left-edge Back ---------- */
  // The screen follows the finger 1:1 over the screen underneath. Releasing past the threshold, or a
  // flick, commits by activating the screen's own Back control; anything else springs back.
  let edge = null;
  const edgeThreshold = width => Math.min(width * .3, 110);
  function scrolledSideways(element) {
    for (let node = element; node && node !== document.body && node.nodeType === 1; node = node.parentElement) {
      if (node.scrollLeft > 0 && node.scrollWidth > node.clientWidth + 1) return true;
    }
    return false;
  }
  function lockEdge(gesture) {
    gesture.locked = true;
    clearPress(); settle();
    const parts = surfaces();
    if (!parts.content) return;
    const width = window.innerWidth || 390, session = styleSession();
    const snapshot = snapshots.get(routeKey(gesture.back.dataset.nav || ''));
    const under = layer(false), shot = frame(snapshot), dim = part('motion-dim'), backdrop = part('motion-backdrop is-leading');
    pageBackground(backdrop);
    if (snapshot?.tabbar && parts.tabbar) under.dataset.hideTabbar = 'true';
    under.append(shot, dim, backdrop); document.body.append(under); placeSnapshot(snapshot);
    raise(session, parts, 2);
    session.set(parts.content, 'will-change', reduced() ? 'opacity' : 'transform');
    gesture.visual = {under, shot, dim, backdrop, snapshot, session, content:parts.content, width, quiet:reduced()};
  }
  function moveEdge(gesture) {
    const visual = gesture.visual;
    if (!visual) return;
    const p = clamp(gesture.distance / visual.width, 0, 1);
    if (visual.quiet) {
      visual.session.set(visual.content, 'opacity', String(1 - p));
      visual.backdrop.style.opacity = String(1 - p);
    } else {
      visual.session.set(visual.content, 'transform', `translate3d(${gesture.distance}px,0,0)`);
      visual.backdrop.style.transform = `translate3d(${gesture.distance}px,0,0)`;
      visual.shot.style.transform = `translate3d(${-.3 * visual.width * (1 - p)}px,0,0)`;
      visual.dim.style.opacity = String(1 - p);
    }
    const armed = gesture.distance > edgeThreshold(visual.width);
    if (armed && !gesture.armed && !gesture.buzzed) {gesture.buzzed = true; haptic('rigid');}
    gesture.armed = armed;
  }
  function teardownEdge(gesture) {
    const visual = gesture?.visual;
    if (!visual) return;
    gesture.visual = null;
    visual.under.remove(); visual.snapshot?.node.remove(); visual.session.restore();
  }
  function springBack(gesture, velocity = 0) {
    const visual = gesture?.visual;
    if (!visual) return;
    if (!canAnimate(visual.content) || !phone()) {teardownEdge(gesture); return;}
    const p = clamp(gesture.distance / visual.width, 0, 1), duration = clamp(gesture.distance / Math.max(-velocity, 1), 180, 320);
    const timing = {duration, easing:spring('nav'), fill:'forwards'}, animations = [];
    if (visual.quiet) animations.push(play(visual.content, [{opacity:1 - p}, {opacity:1}], timing), play(visual.backdrop, [{opacity:1 - p}, {opacity:1}], timing));
    else {
      const from = [{transform:`translate3d(${gesture.distance}px,0,0)`}, {transform:'translate3d(0,0,0)'}];
      animations.push(play(visual.content, from, timing), play(visual.backdrop, from, timing),
        play(visual.shot, [{transform:`translate3d(${-.3 * visual.width * (1 - p)}px,0,0)`}, {transform:`translate3d(${-.3 * visual.width}px,0,0)`}], timing),
        play(visual.dim, [{opacity:1 - p}, {opacity:1}], timing));
    }
    run(animations, () => teardownEdge(gesture));
  }
  function cancelEdge() {
    const gesture = edge;
    edge = null;
    if (gesture?.locked) springBack(gesture);
  }
  function commitEdge(gesture, velocity) {
    haptic('light');
    const visual = gesture.visual;
    if (!visual || !canAnimate(visual.content) || !phone()) {teardownEdge(gesture); gesture.back.click(); return;}
    // The Back control decides the destination; the next render continues the slide from the finger.
    pendingPop = {gesture, dx:gesture.distance, velocity:Math.max(0, velocity), opacity:1 - clamp(gesture.distance / visual.width, 0, 1)};
    gesture.back.click();
    window.clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(() => {if (pendingPop?.gesture === gesture) {pendingPop = null; springBack(gesture);}}, 450);
  }
  document.addEventListener('touchstart', event => {
    if (!phone() || event.touches.length !== 1 || query('dialog[open], .menu-layer, .context-menu-layer')) return;
    const touch = event.touches[0], back = backControl();
    if (touch.clientX > 20 || !back || window.getSelection()?.toString() || scrolledSideways(event.target)) return;
    edge = {x:touch.clientX, y:touch.clientY, back, distance:0, locked:false, samples:[]};
    track(edge.samples, touch.clientX, event.timeStamp);
  }, {passive:true});
  document.addEventListener('touchmove', event => {
    if (!edge) return;
    if (event.touches.length !== 1) {cancelEdge(); return;}
    const touch = event.touches[0], dx = touch.clientX - edge.x, dy = touch.clientY - edge.y;
    if (!edge.locked) {
      if (Math.abs(dy) > 45 || dx < -8) {cancelEdge(); return;}
      if (!(dx > 12 && dx > Math.abs(dy) * 1.5)) return;
      lockEdge(edge);
    }
    event.preventDefault();
    edge.distance = Math.max(0, dx);
    track(edge.samples, touch.clientX, event.timeStamp);
    moveEdge(edge);
  }, {passive:false});
  document.addEventListener('touchend', event => {
    const gesture = edge;
    edge = null;
    if (!gesture?.locked) return;
    const last = gesture.samples[gesture.samples.length - 1];
    if (last) track(gesture.samples, last.value, event.timeStamp);
    const velocity = speed(gesture.samples), width = gesture.visual?.width || window.innerWidth || 390;
    const commit = gesture.back.isConnected && velocity > -.25 && (gesture.distance > edgeThreshold(width) || velocity > .35 && gesture.distance > 24);
    if (commit) commitEdge(gesture, velocity); else springBack(gesture, velocity);
  }, {passive:true});
  document.addEventListener('touchcancel', cancelEdge, {passive:true});

  /* ---------- Render hooks ---------- */
  function beforeRender() {
    rememberDraft();
    // A menu that is still animating away is finished first, so no screen copy keeps its hidden source.
    closeMenu(true);
    for (const finish of [...closing]) finish();
    if (pendingPop) {teardownEdge(pendingPop.gesture); window.clearTimeout(pendingTimer);}
    settle();
    if (edge) {teardownEdge(edge); edge = null;}
    outgoing = null;
    if (phone() && current) {
      positions.set(current, window.scrollY);
      if (routeKey(location.hash) !== current) {
        outgoing = capture();
        if (outgoing) {snapshots.delete(current); snapshots.set(current, outgoing);}
        while (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value);
      }
    }
    while (positions.size > 60) positions.delete(positions.keys().next().value);
  }
  function afterRender(route) {
    const key = `${route.view}/${route.id || ''}`, changed = !!current && key !== current;
    const field = composer(), interactive = pendingPop;
    pendingPop = null;
    if (field) formSessions.set(field.closest('form'), generation);
    if (field && drafts.has(draftKey(field))) field.value = drafts.get(draftKey(field));
    if (phone()) {
      viewport();
      window.scrollTo({top:positions.get(key) || 0, behavior:'instant'});
      if (changed) {
        const kind = classify(current, key, outgoing?.backTarget || '', !!backControl());
        // Only screens still underneath this one can be returned to, so only they keep a copy.
        for (const saved of [...snapshots.keys()]) if (!stack.includes(saved)) snapshots.delete(saved);
        transition(kind, outgoing, kind === 'pop' ? interactive : null);
      } else if (!current) stack = [key];
      mountLens(changed);
      watchThread();
      updateBars();
    }
    outgoing = null;
    current = key;
  }
  function reset() {
    generation++;
    current = ''; positions.clear(); drafts.clear(); snapshots.clear(); stack = [];
    closeMenu(true); for (const finish of [...closing]) finish(); settle();
    if (pendingPop) {teardownEdge(pendingPop.gesture); pendingPop = null;}
    if (edge) {teardownEdge(edge); edge = null;}
    threadWatch?.observer?.disconnect(); threadWatch = null; lensFrom = null;
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

  /* ---------- Sheets ---------- */
  // Sheets spring open (CSS), follow the finger from the grabber, the header, or the body when its
  // content is at the top, rubber-band past the top, and dismiss on distance or a downward flick.
  const released = new WeakMap();
  const rubber = (distance, limit = 60) => limit * (1 - 1 / (distance / limit * .55 + 1));
  function closeSheet(dialog, finish) {
    if (!phone() || reduced() || !dialog.animate) return false;
    if (dialog.dataset.closing) return true;
    dialog.dataset.closing = 'true';
    const drag = released.get(dialog);
    released.delete(dialog);
    const transform = getComputedStyle(dialog).transform, from = drag ? `translateY(${drag.offset}px)` : transform && transform !== 'none' ? transform : 'translateY(0)';
    const height = dialog.getBoundingClientRect?.().height || window.innerHeight || 600, remaining = Math.max(1, height - (drag?.offset || 0));
    const duration = drag?.velocity > .2 ? clamp(remaining / drag.velocity, 140, 280) : 280;
    const easing = drag?.velocity > .2 ? continueEase(drag.velocity, remaining, duration) : 'cubic-bezier(.32,.72,0,1)';
    const animation = dialog.animate([{transform:from}, {transform:'translateY(100%)'}], {duration, easing, fill:'forwards'});
    try {dialog.animate([{opacity:drag?.progress || 1}, {opacity:0}], {duration, easing:'ease-out', fill:'forwards', pseudoElement:'::backdrop'});} catch {}
    // A replacement dialog may already have been opened when this completes.
    animation.finished.then(() => {if (dialog.isConnected && dialog.open) finish();}, () => {}).finally(() => animation.cancel());
    window.setTimeout(() => {if (dialog.isConnected && dialog.open) finish();}, duration + 600);
    return true;
  }
  function mountDialog(dialog, dismiss) {
    if (!phone()) return;
    dialog.querySelector('h2')?.focus({preventScroll:true});
    dialog.addEventListener('cancel', event => {event.preventDefault(); dismiss();});
    const handle = dialog.querySelector('.sheet-grabber');
    let drag = null, suppressClick = false, candidate = null, dirty = false;
    // Like iOS's isModalInPresentation: once something is typed or changed, a swipe or a tap outside
    // never discards it. The sheet only rubber-bands; its own Close or Cancel button still closes it.
    const markDirty = event => {if (event.target !== dialog) {dirty = true; dialog.dataset.dirty = 'true';}};
    dialog.addEventListener('input', markDirty);
    dialog.addEventListener('change', markDirty);
    const refuse = () => {
      haptic('warning');
      if (!reduced()) play(dialog, [{transform:'translateY(0)'}, {transform:'translateY(14px)'}, {transform:'translateY(0)'}], {duration:360, easing:'ease-out'});
    };
    dialog.addEventListener('click', event => {
      if (!dirty || !phone() || event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) return;
      event.preventDefault(); event.stopImmediatePropagation(); refuse();
    }, true);
    function begin(y, time) {
      if (dialog.dataset.closing || drag) return false;
      for (const animation of dialog.getAnimations?.() || []) if (animation.effect?.pseudoElement !== '::backdrop') animation.cancel();
      const style = getComputedStyle(dialog);
      drag = {start:y, offset:0, raw:0, dirty, samples:[], height:dialog.getBoundingClientRect?.().height || 0, armed:false, buzzed:false, shadow:style.boxShadow, fill:style.backgroundColor};
      track(drag.samples, y, time);
      dialog.classList.add('is-dragging');
      return true;
    }
    function update(y, time) {
      if (!drag) return;
      const raw = y - drag.start;
      drag.raw = raw;
      drag.offset = raw < 0 ? -rubber(-raw) : drag.dirty ? rubber(raw, 70) : raw;
      track(drag.samples, y, time);
      if (!reduced()) {
        dialog.style.transform = `translateY(${drag.offset}px)`;
        // Stretching above the top keeps the sheet's own colour under its lifted edge.
        if (drag.offset < 0 && drag.fill) dialog.style.boxShadow = `${drag.shadow && drag.shadow !== 'none' ? `${drag.shadow}, ` : ''}0 80px 0 0 ${drag.fill}`;
        else dialog.style.removeProperty('box-shadow');
        if (drag.height) dialog.style.setProperty('--studio-sheet-progress', String(clamp(1 - drag.offset / drag.height, 0, 1).toFixed(3)));
      }
      const armed = drag.raw > clamp(drag.height * .25, 85, 140);
      if (armed && !drag.armed && !drag.buzzed) {drag.buzzed = true; haptic(drag.dirty ? 'warning' : 'rigid');}
      drag.armed = armed;
    }
    function release(cancelled, time) {
      const finished = drag;
      if (!finished) return;
      drag = null;
      const last = finished.samples[finished.samples.length - 1];
      if (last && time !== undefined) track(finished.samples, last.value, time);
      const velocity = cancelled ? 0 : speed(finished.samples), threshold = clamp(finished.height * .25, 85, 140);
      const commit = !cancelled && !finished.dirty && finished.offset > 0 && (finished.offset > threshold && velocity > -.2 || velocity > .5 && finished.offset > 24);
      const progress = Number(dialog.style.getPropertyValue('--studio-sheet-progress')) || 1;
      for (const property of ['transform','box-shadow','--studio-sheet-progress']) dialog.style.removeProperty(property);
      dialog.classList.remove('is-dragging');
      if (commit) {released.set(dialog, {offset:finished.offset, velocity, progress}); haptic('light'); dismiss(); return;}
      if (finished.dirty && !cancelled && !finished.buzzed && velocity > .5 && finished.raw > 24) haptic('warning');
      if (finished.offset && !reduced()) play(dialog, [{transform:`translateY(${finished.offset}px)`}, {transform:'translateY(0)'}], {duration:420, easing:spring('sheet')});
    }
    handle?.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !phone()) return;
      if (!begin(event.clientY, event.timeStamp)) return;
      drag.id = event.pointerId; suppressClick = false;
      handle.setPointerCapture(event.pointerId);
    });
    handle?.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      if (Math.abs(event.clientY - drag.start) > 6) suppressClick = true;
      update(event.clientY, event.timeStamp);
    });
    for (const name of ['pointerup','pointercancel','lostpointercapture']) handle?.addEventListener(name, event => {
      if (!drag || event.pointerId !== drag.id) return;
      release(event.type !== 'pointerup', event.timeStamp);
    });
    handle?.addEventListener('click', event => {
      if (!suppressClick) return;
      suppressClick = false; event.preventDefault(); event.stopPropagation();
    });
    // The header always drags; the body drags only from the top of its content and never from a field.
    const scrolledAbove = (node, stop) => {
      for (let element = node; element && element !== stop && element.nodeType === 1; element = element.parentElement) if (element.scrollTop > 0) return true;
      return false;
    };
    dialog.addEventListener('touchstart', event => {
      candidate = null;
      if (!phone() || event.touches.length !== 1 || drag || dialog.dataset.closing) return;
      const target = event.target, head = target.closest?.('.modal-head'), body = target.closest?.('.modal-body');
      if (target.closest?.('.sheet-grabber') || !head && !body) return;
      if (target.closest('input,textarea,select,[contenteditable]:not([contenteditable=false]),button,a[href],summary,label,[role=slider],[draggable=true]')) return;
      if (body && (body.scrollTop > 0 || scrolledAbove(target, body) || root.dataset.keyboard === 'open')) return;
      const selection = window.getSelection?.();
      if (selection && !selection.isCollapsed && dialog.contains(selection.anchorNode)) return;
      const touch = event.touches[0];
      candidate = {x:touch.clientX, y:touch.clientY, body, decided:false};
    }, {passive:true});
    dialog.addEventListener('touchmove', event => {
      if (!candidate || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!candidate.decided) {
        const dx = touch.clientX - candidate.x, dy = touch.clientY - candidate.y;
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        // Upward or sideways movement belongs to the content: scrolling, sliders, selection.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || candidate.body?.scrollTop > 0 || !begin(candidate.y, event.timeStamp)) {candidate = null; return;}
        candidate.decided = true;
      }
      if (event.cancelable) event.preventDefault();
      update(touch.clientY, event.timeStamp);
    }, {passive:false});
    dialog.addEventListener('touchend', event => {if (candidate?.decided) release(false, event.timeStamp); candidate = null;}, {passive:true});
    dialog.addEventListener('touchcancel', () => {if (candidate?.decided) release(true); candidate = null;}, {passive:true});
  }

  /* ---------- Tab bar lens ---------- */
  // The selected tab sits in a glass lens that glides (and briefly stretches) to the next selection.
  let lensFrom = null;
  function mountLens(animate) {
    const bar = query('#app .tabbar');
    if (!bar || !shown(bar)) return;
    const tabs = [...bar.querySelectorAll('.tab')], tab = tabs.find(item => item.classList.contains('active'));
    if (!tab) return;
    let lens = bar.querySelector(':scope > .tab-lens');
    if (!lens) {
      lens = document.createElement('span'); lens.className = 'tab-lens'; lens.setAttribute('aria-hidden', 'true');
      lens.append(document.createElement('span'));
      bar.prepend(lens);
    }
    bar.dataset.lens = 'true';
    const x = tab.offsetLeft;
    Object.assign(lens.style, {width:`${tab.offsetWidth}px`, height:`${tab.offsetHeight}px`, top:`${tab.offsetTop}px`, transform:`translate3d(${x}px,0,0)`});
    if (animate && lensFrom !== null && lensFrom !== x && !reduced()) {
      lens.style.willChange = 'transform';
      const glide = play(lens, [{transform:`translate3d(${lensFrom}px,0,0)`}, {transform:`translate3d(${x}px,0,0)`}], {duration:500, easing:spring('bouncy')});
      play(lens.firstElementChild, [{transform:'scale(1,1)'}, {transform:'scale(1.16,.9)', offset:.3}, {transform:'scale(1,1)'}], {duration:440, easing:'ease-in-out'});
      glide?.finished.then(() => lens.style.removeProperty('will-change'), () => {});
    }
    lensFrom = x;
  }
  document.addEventListener('click', event => {
    if (!phone()) return;
    // Re-tapping the current tab at its root scrolls to the top (nested screens are popped by app.js).
    const tab = event.target.closest('#app .tabbar .tab[aria-current="page"]');
    if (tab && routeKey(location.hash) === routeKey(tab.dataset.nav) && window.scrollY > 0) window.scrollTo({top:0, behavior:reduced() ? 'auto' : 'smooth'});
    if (!event.isTrusted) return;
    const control = event.target.closest('button[data-nav], .segment, .chat-switcher, .chat-more');
    if (control && !control.disabled && !control.matches('[aria-current="page"], .segment.active')) haptic();
  });

  /* ---------- Scroll-edge bars ---------- */
  // The navigation bar gets its material once content is under it (data-scrolled) and reports how far the
  // large title has scrolled beneath it (--studio-scroll-progress, 0–1). Chat headers report the same.
  let barFrame = 0;
  const scheduleBars = () => {if (!barFrame) barFrame = window.requestAnimationFrame(updateBars);};
  function setFlag(element, scrolled, progress) {
    const flag = scrolled ? 'true' : 'false';
    if (element.dataset.scrolled !== flag) element.dataset.scrolled = flag;
    const value = progress.toFixed(3);
    if (element.style.getPropertyValue('--studio-scroll-progress') !== value) element.style.setProperty('--studio-scroll-progress', value);
  }
  function updateBars() {
    barFrame = 0;
    if (!phone()) return;
    const bar = query('#app .topbar');
    if (bar && shown(bar)) {
      const y = window.scrollY, title = query('#main-content h1');
      let progress = clamp(y / 44, 0, 1);
      if (title) {
        const box = title.getBoundingClientRect(), edge = bar.getBoundingClientRect().bottom;
        if (box.height) progress = clamp((edge - box.top) / box.height, 0, 1);
        // Pulling down past the top stretches the large title a little, as UIKit does.
        const stretch = y < 0 && !reduced() ? 1 + Math.min(.1, -y / 900) : 1;
        if (stretch > 1) {title.dataset.stretch = 'true'; title.style.setProperty('--studio-title-stretch', stretch.toFixed(4));}
        else if (title.dataset.stretch) {delete title.dataset.stretch; title.style.removeProperty('--studio-title-stretch');}
      }
      setFlag(bar, y > .5, progress);
    }
    const thread = query('#app .chat-thread'), header = query('#app .chat-header');
    if (thread && header) setFlag(header, thread.scrollTop > .5, clamp(thread.scrollTop / 24, 0, 1));
    if (thread && threadWatch?.button) {
      const away = !threadWatch.glide && thread.scrollHeight - thread.scrollTop - thread.clientHeight > Math.max(160, thread.clientHeight / 3);
      const button = threadWatch.button;
      if ((button.dataset.visible === 'true') !== away) {
        button.dataset.visible = String(away); button.tabIndex = away ? 0 : -1;
        if (away) button.removeAttribute('aria-hidden'); else button.setAttribute('aria-hidden', 'true');
      }
    }
  }

  /* ---------- Chat motion ---------- */
  // New messages rise into place; when the transcript is following the latest message, it scrolls smoothly
  // to new and streaming content instead of jumping. Replacements (thinking → reply, streaming updates,
  // approval cards redrawn by a poll) are not treated as arrivals.
  let threadWatch = null;
  const KINDS = ['thinking-message','partial-message','approval-card','question-card','run-status','run-timeline'];
  const kindOf = node => KINDS.find(name => node.classList?.contains(name)) || '';
  function watchThread() {
    threadWatch?.observer?.disconnect();
    threadWatch = null;
    const thread = query('#app .chat-thread');
    if (!thread || !window.MutationObserver) return;
    const state = {thread, filled:false, nodes:new Set(thread.children), height:thread.scrollHeight, atBottom:true, button:null, glide:null, offset:0};
    state.observer = new window.MutationObserver(records => threadChanged(state, records));
    state.observer.observe(thread, {childList:true});
    const wrap = query('#app .chat-composer-wrap');
    if (wrap) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'scroll-to-latest'; button.tabIndex = -1;
      button.dataset.visible = 'false'; button.setAttribute('aria-hidden', 'true'); button.setAttribute('aria-label', 'Scroll to the latest message');
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14m-6-6 6 6 6-6"/></svg>';
      button.addEventListener('click', () => thread.scrollTo({top:thread.scrollHeight, behavior:reduced() ? 'auto' : 'smooth'}));
      wrap.prepend(button); state.button = button;
    }
    threadWatch = state;
  }
  function threadChanged(state, records) {
    const {thread} = state, children = new Set(thread.children), gone = new Set();
    for (const record of records) for (const node of record.removedNodes) if (node.nodeType === 1 && !children.has(node)) gone.add(kindOf(node) || 'message');
    const fresh = [...children].filter(node => !state.nodes.has(node));
    state.nodes = children;
    const height = thread.scrollHeight, delta = height - state.height, bottom = height - thread.clientHeight;
    state.height = height;
    if (thread.__searchAnchor) {state.glide = null; state.atBottom = false;}
    const atBottom = !thread.__searchAnchor && bottom - thread.scrollTop < 6, gliding = !!state.glide, following = gliding || state.atBottom && atBottom;
    state.atBottom = atBottom;
    if (!state.filled) {state.filled = true; return;}
    if (!phone()) return;
    const quiet = reduced(), entering = new Set();
    for (const node of fresh) {
      const kind = kindOf(node);
      if (kind ? gone.has(kind) : !node.matches('.chat-message') || !node.matches('.user') && gone.has('partial-message')) continue;
      entering.add(node);
    }
    // Following the latest message, arriving height is scrolled in smoothly rather than jumped to. Scrolling
    // (not transforming the transcript) keeps app.js's "near the bottom" check and scroll range exact.
    if (following && delta > 0 && delta < thread.clientHeight * 1.5 && !quiet) glide(state, (gliding ? state.offset : 0) + delta);
    for (const node of entering) {
      const user = node.matches('.user');
      node.style.transformOrigin = user ? '100% 100%' : '0 100%';
      if (quiet) play(node, [{opacity:0}, {opacity:1}], {duration:200, easing:'ease-out'});
      else play(node, [{opacity:0, transform:`translate3d(0,${user ? 16 : 10}px,0) scale(${user ? .96 : .98})`}, {opacity:1, offset:.35}, {opacity:1, transform:'translate3d(0,0,0) scale(1)'}], {duration:460, easing:spring('sheet')});
    }
  }
  // A critically damped spring (the navigation curve) drives the scroll position toward the live bottom.
  const settleCurve = progress => {const w = 2 * Math.PI / .27, t = progress * .34; return progress >= 1 ? 1 : 1 - Math.exp(-w * t) * (1 + w * t);};
  function glide(state, offset) {
    const {thread} = state;
    state.glide = {start:now(), from:offset};
    state.offset = offset;
    thread.scrollTop = thread.scrollHeight - thread.clientHeight - offset;
    const step = () => {
      const current = state.glide;
      if (!current || threadWatch !== state || !thread.isConnected) return;
      if (thread.__searchAnchor) {state.glide = null; state.atBottom = false; return;}
      const progress = clamp((now() - current.start) / 340, 0, 1);
      state.offset = current.from * (1 - settleCurve(progress));
      thread.scrollTop = thread.scrollHeight - thread.clientHeight - state.offset;
      if (progress < 1) window.requestAnimationFrame(step);
      else {state.glide = null; state.offset = 0; state.atBottom = true;}
    };
    window.requestAnimationFrame(step);
    // Without frames (a backgrounded page) the transcript still lands on the latest message.
    const current = state.glide;
    window.setTimeout(() => {if (state.glide === current) step();}, 400);
  }
  // The owner's own scrolling always wins over a glide in progress.
  for (const name of ['touchstart','wheel']) document.addEventListener(name, event => {
    if (threadWatch?.glide && threadWatch.thread.contains(event.target)) {threadWatch.glide = null; threadWatch.offset = 0;}
  }, {passive:true, capture:true});

  /* ---------- Long-press context menus ---------- */
  // Messages offer Copy, Select text and Read aloud (when the reply has it); bots offer the actions their
  // own menus already have. Items carry the same data-nav/data-action attributes app.js handles.
  const MENU_TARGETS = '#app .chat-thread .chat-message:not(.thinking-message):not(.partial-message), #app .bot-row:not(.bot-row-new), #app .pearl-home-teammate[data-nav^="/bot/"]';
  const ICONS = {copy:'M8 8h13v13H8zM16 4V2H2v14h2', select:'M9 4h6M9 20h6M12 4v16', speaker:'M4 9h4l5-5v16l-5-5H4V9Zm13-2a7 7 0 0 1 0 10m2-13a11 11 0 0 1 0 16', chat:'M4 3h16v14H8l-4 4V3Z', heart:'m12 21-8-8C-2 7 6-2 12 5c6-7 14 2 8 8l-8 8Z', book:'M3 4h6c2 0 3 1 3 2 0-1 1-2 3-2h6v16h-6c-2 0-3 1-3 2 0-1-1-2-3-2H3V4Zm9 2v16', file:'M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8M8 17h5', edit:'m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z', link:'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'};
  const textOf = element => (element?.innerText ?? element?.textContent ?? '').trim();
  const escape = value => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
  const menuItem = (label, icon, attributes) => `<button type="button" class="menu-item" role="menuitem" ${attributes}><span class="menu-text"><span>${escape(label)}</span></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[icon]}"/></svg></button>`;
  let press = null, menu = null, swallowTouch = false, swallowUntil = 0, swallowSource = null;
  const closing = new Set();
  function clearPress() {
    if (!press) return;
    window.clearTimeout(press.hold); window.clearTimeout(press.open);
    press.target.classList.remove('is-holding');
    press = null;
  }
  // Web links keep the system's own link menu; in-app (#/…) links, whose system menu the app hides, get Copy link here.
  function messageActions(message, link) {
    const text = textOf(message.querySelector('.message-text'));
    const read = message.querySelector('.message-voice-actions [data-action="read-message"]');
    const items = [];
    if (link) items.push(menuItem('Copy link', 'link', 'data-motion-action="copy-link"'));
    if (text) items.push(menuItem('Copy', 'copy', 'data-motion-action="copy"'), menuItem('Select text', 'select', 'data-motion-action="select"'));
    if (read) items.push(menuItem(read.textContent.trim() || 'Read aloud', 'speaker', 'data-motion-action="read"'));
    return items.length ? {label:'Message actions', html:items.join('')} : null;
  }
  function botActions(target) {
    const nav = target.matches('[data-nav]') ? target.dataset.nav : target.querySelector('[data-nav^="/bot/"]')?.dataset.nav;
    const id = /^\/bot\/([^/]+)$/.exec(nav || '')?.[1];
    if (!id) return null;
    const name = target.querySelector('strong')?.textContent.trim() || 'Bot', key = `data-id="${escape(id)}"`;
    return {label:`${name} options`, html:menuItem('Chat', 'chat', `data-nav="/bot/${escape(id)}"`) + menuItem('Bot profile', 'heart', `data-nav="/bots/${escape(id)}"`)
      + menuItem('Memory', 'book', `data-action="bot-memory" ${key}`) + menuItem('Files', 'file', `data-action="bot-files" ${key}`)
      + '<hr>' + menuItem('Edit bot', 'edit', `data-action="edit-bot" ${key}`)};
  }
  async function copyText(text) {
    try {await window.navigator.clipboard.writeText(text); return true;} catch {}
    const area = document.createElement('textarea');
    area.value = text; area.readOnly = true; area.className = 'motion-copy-buffer';
    document.body.append(area); area.select();
    let copied = false;
    try {copied = document.execCommand('copy');} catch {}
    area.remove();
    return copied;
  }
  function selectMessage(message) {
    const text = message?.querySelector('.message-text');
    if (!text || !message.isConnected) return;
    message.dataset.selecting = 'true';
    const range = document.createRange(), selection = window.getSelection();
    range.selectNodeContents(text); selection.removeAllRanges(); selection.addRange(range);
  }
  function focusSource(source) {
    let control = source.matches('button,a[href]') ? source : source.querySelector(':scope > button, :scope > a[href]');
    if (!control) {
      control = source;
      if (!source.hasAttribute('tabindex')) {source.tabIndex = -1; source.addEventListener('blur', () => source.removeAttribute('tabindex'), {once:true});}
    }
    control.focus({preventScroll:true});
  }
  function openMenu(target, link = null) {
    clearPress();
    if (!target.isConnected || !phone() || menu || query('dialog[open]')) return;
    const message = target.matches('.chat-message'), items = message ? messageActions(target, link) : botActions(target);
    if (!items) return;
    // Read the rendered text now: once the source is hidden under its lifted copy, innerText is empty.
    const text = message ? textOf(target.querySelector('.message-text')) : '';
    const rect = target.getBoundingClientRect(), layerElement = part('context-menu-layer'), backdrop = part('context-menu-backdrop'), preview = part('context-menu-preview');
    let copy = target.cloneNode(true);
    copy.classList.remove('is-holding', 'is-pressed');
    for (const node of [copy, ...copy.querySelectorAll('[id]')]) node.removeAttribute('id');
    if (target.matches('.bot-row')) {const list = document.createElement('ul'); list.className = 'bot-list'; list.append(copy); copy = list;}
    preview.dataset.kind = message ? 'message' : 'bot'; preview.setAttribute('aria-hidden', 'true'); preview.append(copy);
    const list = part('popover-menu context-menu');
    list.setAttribute('role', 'menu'); list.setAttribute('aria-label', items.label); list.innerHTML = items.html;
    layerElement.append(backdrop, preview, list); document.body.append(layerElement);
    // Lay out: the preview stays where the item was unless the menu needs room below it.
    const view = window.visualViewport, viewTop = view?.offsetTop || 0, viewWidth = view?.width || window.innerWidth, viewHeight = view?.height || window.innerHeight;
    const insets = safeInsets(), minY = viewTop + insets.top + 10, maxY = viewTop + viewHeight - insets.bottom - 10, gap = 10;
    const menuWidth = list.offsetWidth, menuHeight = Math.min(list.offsetHeight, (maxY - minY) * .6);
    const visibleTop = clamp(rect.top, minY, maxY), visibleBottom = clamp(rect.bottom, minY, maxY);
    const height = Math.min(Math.max(0, visibleBottom - visibleTop), Math.max(72, maxY - minY - menuHeight - gap));
    let top = visibleTop;
    if (top + height + gap + menuHeight > maxY) top = maxY - menuHeight - gap - height;
    top = Math.max(minY, top);
    Object.assign(preview.style, {left:`${rect.left}px`, top:`${top}px`, width:`${rect.width}px`, height:`${height}px`});
    copy.style.translate = `0 ${rect.top - visibleTop}px`;
    const alignEnd = message && target.matches('.user'), menuTop = Math.min(top + height + gap, maxY - menuHeight);
    const menuLeft = clamp(alignEnd ? rect.right - menuWidth : rect.left, 12, viewWidth - 12 - menuWidth);
    Object.assign(list.style, {left:`${menuLeft}px`, top:`${menuTop}px`, maxHeight:`${Math.max(120, maxY - menuTop)}px`, transformOrigin:alignEnd ? '100% 0' : '0 0'});
    target.classList.add('context-menu-source');
    // The screen underneath is inert while the menu is up; focus starts on the first item (as app.js menus do).
    const app = query('#app');
    menu = {layer:layerElement, backdrop, preview, list, source:target, lift:visibleTop - top, app, appInert:!!app?.hasAttribute('inert')};
    app?.setAttribute('inert', '');
    swallowSource = target; swallowUntil = now() + 700;
    const entries = [...list.querySelectorAll('.menu-item')];
    for (const entry of entries) entry.tabIndex = -1;
    entries[0]?.focus({preventScroll:true});
    list.addEventListener('keydown', event => {
      const enabled = entries.filter(entry => !entry.disabled), index = enabled.indexOf(document.activeElement);
      if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : event.key === 'ArrowDown' ? (index + 1) % enabled.length : (index - 1 + enabled.length) % enabled.length;
        enabled[next]?.focus({preventScroll:true});
      } else if (event.key === 'Tab') {event.preventDefault(); closeMenu();}
    });
    haptic('medium');
    if (reduced()) {
      play(backdrop, [{opacity:0}, {opacity:1}], {duration:180, easing:'ease-out'});
      play(list, [{opacity:0}, {opacity:1}], {duration:180, easing:'ease-out'});
    } else {
      play(backdrop, [{opacity:0}, {opacity:1}], {duration:260, easing:'ease-out'});
      play(preview, [{transform:`translate3d(0,${menu.lift}px,0) scale(.97)`}, {transform:'translate3d(0,0,0) scale(1)'}], {duration:500, easing:spring('bouncy')});
      play(list, [{opacity:0, transform:'scale(.45)'}, {opacity:1, offset:.25}, {opacity:1, transform:'scale(1)'}], {duration:500, easing:spring('bouncy')});
    }
    layerElement.addEventListener('click', event => {
      const item = event.target.closest('.menu-item');
      if (!item) {event.preventDefault(); closeMenu(); return;}
      const action = item.dataset.motionAction;
      if (!action) {closeMenu(); return;} // data-nav and data-action continue to app.js
      event.preventDefault(); event.stopPropagation();
      // Clipboard and speech need this tap's activation, so they run before the menu animates away.
      if (action === 'copy') void copyText(text);
      if (action === 'copy-link' && link) void copyText(new URL(link.getAttribute('href'), window.location.href).href);
      if (action === 'read') target.querySelector('.message-voice-actions [data-action="read-message"]')?.click();
      closeMenu(false, action === 'select' ? () => selectMessage(target) : null);
    });
    // Dragging on the dimmed screen dismisses the menu, as on iOS; the screen underneath never scrolls.
    let origin = null;
    layerElement.addEventListener('touchstart', event => {const touch = event.touches[0]; origin = touch && !event.target.closest('.context-menu') ? {x:touch.clientX, y:touch.clientY} : null;}, {passive:true});
    layerElement.addEventListener('touchmove', event => {
      if (event.cancelable && !event.target.closest('.context-menu')) event.preventDefault();
      const touch = event.touches[0];
      if (origin && touch && Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > 12) {origin = null; closeMenu();}
    }, {passive:false});
  }
  function closeMenu(immediate = false, after = null) {
    const open = menu;
    if (!open) return;
    menu = null;
    if (!open.appInert) open.app?.removeAttribute('inert');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true; closing.delete(finish);
      // Focus returns to the item unless an action moved it on (a sheet opened, the screen changed).
      const active = document.activeElement, returnFocus = !active || active === document.body || open.layer.contains(active);
      open.layer.remove(); open.source.classList.remove('context-menu-source');
      if (returnFocus && open.source.isConnected) focusSource(open.source);
      after?.();
    };
    if (immediate || !canAnimate(open.layer)) {finish(); return;}
    closing.add(finish);
    open.layer.style.pointerEvents = 'none';
    const quiet = reduced(), animations = [
      play(open.backdrop, [{opacity:1}, {opacity:0}], {duration:220, easing:'ease-out', fill:'forwards'}),
      play(open.list, [{opacity:1, transform:'scale(1)'}, {opacity:0, transform:quiet ? 'scale(1)' : 'scale(.75)'}], {duration:160, easing:'ease-in', fill:'forwards'}),
      quiet ? null : play(open.preview, [{transform:'translate3d(0,0,0)'}, {transform:`translate3d(0,${open.lift}px,0)`}], {duration:280, easing:spring('nav'), fill:'forwards'}),
    ].filter(Boolean);
    Promise.all(animations.map(animation => animation.finished)).then(finish, finish);
    window.setTimeout(finish, longest(animations) + 600);
  }
  document.addEventListener('touchstart', event => {
    clearPress();
    if (!phone() || event.touches.length !== 1 || menu || query('dialog[open], .menu-layer')) return;
    const target = event.target.closest?.(MENU_TARGETS);
    if (!target || target.dataset.selecting) return;
    if (target.matches('.chat-message') && event.target.closest('a[href]:not([href^="#"]),button,input,textarea,select,summary,label,.rich-code,.rich-visual,.message-attachments')) return;
    const touch = event.touches[0], link = event.target.closest('a[href^="#"]');
    press = {target, x:touch.clientX, y:touch.clientY, top:target.getBoundingClientRect().top,
      hold:window.setTimeout(() => press?.target === target && target.classList.add('is-holding'), 150),
      open:window.setTimeout(() => {if (press?.target === target && !edge?.locked) {openMenu(target, link); if (menu) swallowTouch = true;}}, 480)};
  }, {passive:true});
  document.addEventListener('touchmove', event => {
    if (!press) return;
    const touch = event.touches[0];
    if (!touch || Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 10) clearPress();
  }, {passive:true});
  // The touch that opened a menu must not also tap the item underneath it.
  document.addEventListener('touchend', event => {
    clearPress();
    if (swallowTouch) {swallowTouch = false; if (event.cancelable) event.preventDefault();}
  }, {passive:false});
  document.addEventListener('touchcancel', () => {clearPress(); swallowTouch = false;}, {passive:true});
  // Only a real tap is swallowed; the menu's own programmatic clicks (Read aloud) must get through.
  document.addEventListener('click', event => {
    if (event.isTrusted && swallowSource && now() < swallowUntil && swallowSource.contains(event.target)) {event.preventDefault(); event.stopPropagation();}
  }, true);
  // A secondary click (a pointer at phone width) opens the same menu; web links keep the system menu.
  document.addEventListener('contextmenu', event => {
    if (!phone() || event.target.closest?.('a[href]:not([href^="#"])')) return;
    const target = event.target.closest?.(MENU_TARGETS);
    if (!target) return;
    event.preventDefault();
    if (!menu && !query('dialog[open], .menu-layer')) openMenu(target, event.target.closest('a[href^="#"]'));
  });
  document.addEventListener('keydown', event => {if (event.key === 'Escape' && menu) {event.stopPropagation(); closeMenu();}}, true);
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection?.();
    for (const message of document.querySelectorAll('[data-selecting]')) if (!selection || selection.isCollapsed || !message.contains(selection.anchorNode)) delete message.dataset.selecting;
  });

  /* ---------- Press feedback ---------- */
  // Cards spring down slightly while pressed. Buttons with liquid.js's drop keep their own press.
  const PRESSABLE = '.pearl-resource-card, .skill-card, .provider-choice, .starter-prompt, .app-server-row, .room-member, .companion-choice, .pearl-team-dock button, .question-option, .permission-option, .team-mode-option';
  let pressed = null;
  function releasePressed(immediate) {
    const state = pressed;
    pressed = null;
    if (!state) return;
    window.clearTimeout(state.timer);
    if (immediate || state.shown) {state.element.classList.remove('is-pressed'); return;}
    // A quick tap still shows a brief press.
    state.element.classList.add('is-pressed');
    window.setTimeout(() => state.element.classList.remove('is-pressed'), 110);
  }
  document.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || !phone() || reduced()) return;
    const element = event.target.closest?.(PRESSABLE);
    if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') return;
    releasePressed(true);
    const state = {element, x:event.clientX, y:event.clientY, shown:false};
    state.timer = window.setTimeout(() => {if (pressed === state) {state.shown = true; element.classList.add('is-pressed');}}, 50);
    pressed = state;
  }, {passive:true});
  document.addEventListener('pointermove', event => {
    if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 8) releasePressed(true);
  }, {passive:true});
  document.addEventListener('pointerup', () => releasePressed(false), {passive:true});
  document.addEventListener('pointercancel', () => releasePressed(true), {passive:true});
  document.addEventListener('scroll', event => {
    // Only a scroll that moves the pressed item under the finger cancels a long-press; programmatic
    // scrolling (a transcript following new content) does not.
    if (press && Math.abs(press.target.getBoundingClientRect().top - press.top) > 10) clearPress();
    releasePressed(true); scheduleBars();
    if (threadWatch && !threadWatch.glide && event.target === threadWatch.thread) {const thread = threadWatch.thread; threadWatch.atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 6;}
  }, {capture:true, passive:true});

  /* ---------- Outcomes ---------- */
  // An error that follows the owner's own submission (a sheet's form error or an error toast) taps once.
  let submittedAt = 0;
  document.addEventListener('submit', () => {submittedAt = Date.now();}, true);
  if (window.MutationObserver) {
    const outcomes = new window.MutationObserver(records => {
      if (!submittedAt || Date.now() - submittedAt > 15000) return;
      for (const record of records) {
        const failedToast = [...record.addedNodes].some(node => node.nodeType === 1 && node.matches('.toast.error'));
        const box = record.target.nodeType === 1 ? record.target.closest('.form-error') : record.target.parentElement?.closest('.form-error');
        if (failedToast || box?.textContent.trim()) {submittedAt = 0; haptic('error'); return;}
      }
    });
    for (const id of ['toasts','dialog-root']) {const element = document.getElementById(id); if (element) outcomes.observe(element, {childList:true, subtree:true, characterData:true});}
  }

  document.addEventListener('input', event => {
    if (event.target.matches('.chat-composer textarea')) {rememberDraft(); sizeComposer(event.target);}
  });
  // As in Messages, pressing Send keeps the keyboard up: the press does not take focus from the draft.
  // The click (and so the submission) is unchanged.
  for (const name of ['pointerdown','mousedown']) document.addEventListener(name, event => {
    if (!phone()) return;
    const send = event.target.closest?.('#app .chat-composer .send'), field = send?.closest('form')?.querySelector('textarea');
    if (field && !send.disabled && document.activeElement === field) event.preventDefault();
  });
  for (const name of ['resize','orientationchange','studio:text-size']) window.addEventListener(name, scheduleViewport);
  // Layout changes (rotation, Dynamic Type, a resized window) re-measure the lens without animating it.
  for (const name of ['resize','studio:text-size']) window.addEventListener(name, () => {closeMenu(true); scheduleBars(); window.requestAnimationFrame(() => phone() && mountLens(false));});
  window.visualViewport?.addEventListener('resize', scheduleViewport);
  window.visualViewport?.addEventListener('scroll', scheduleViewport);
  document.addEventListener('focusin', scheduleViewport);
  // The keyboard finishes hiding after focus leaves; measure again once it has.
  document.addEventListener('focusout', () => {scheduleViewport(); window.setTimeout(scheduleViewport, 350);});
  window.StudioMobile = {beforeRender, afterRender, mountDialog, closeSheet, sent, reset, sizeComposer};
})();
