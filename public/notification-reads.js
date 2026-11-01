/* A receipt means this exact committed reply was on screen in an attended window.
   Merely starting a task, keeping a tab open or receiving a stream never mutes push. */
(() => {
  function install(context, {now = Date.now, idleMs = 120000, dwellMs = 600} = {}) {
    let lastInteraction = now(), generation, pending = false, retryAt = 0;
    const sent = new Set(), visibleSince = new Map();
    const interact = () => {lastInteraction = now();};
    const events = ['pointerdown','pointermove','keydown','wheel','touchstart'];
    for (const name of events) window.addEventListener(name, interact, {passive:true});
    window.addEventListener('focus', interact);
    async function tick() {
      const current = context(), native = document.documentElement.dataset.studioAttendance === '1';
      if (native && current.authenticated) {
        try {window.webkit?.messageHandlers?.hermesStudio?.postMessage({type:'notification-attendance'});} catch {}
      }
      const hint = document.documentElement.dataset;
      const nativeAttended = !native || hint.studioAttended === 'true' && now() - Number(hint.studioAttendedAt) >= 0 && now() - Number(hint.studioAttendedAt) < 2500;
      if (generation !== current.generation) {generation = current.generation; sent.clear(); visibleSince.clear();}
      if (!current.authenticated || !nativeAttended || document.hidden || !document.hasFocus() || now() - lastInteraction > idleMs || document.querySelector('dialog[open]') || !['bot','room'].includes(current.view)) {visibleSince.clear(); return;}
      const thread = document.querySelector(current.view === 'room' ? '#room-thread' : '#chat-thread');
      const form = document.querySelector(current.view === 'room' ? '#room-message-form' : '#message-form');
      if (!thread || form?.dataset.id !== current.id) {visibleSince.clear(); return;}
      const viewport = window.visualViewport, top = viewport?.offsetTop || 0, bottom = top + (viewport?.height || window.innerHeight);
      const messages = new Map((current.messages || []).filter(row => row.role === 'assistant' && !row.partial && row.kind !== 'progress').map(row => [row.id, row]));
      const question = current.view === 'bot' && current.run?.status === 'waiting_for_input' && current.run.pending_controls?.find(control => control.kind === 'question');
      if (question) messages.set(question.prompt_id, {id:question.prompt_id,question:true});
      const groups = new Map(), onScreen = new Set();
      for (const node of thread.querySelectorAll('[data-search-message-id],[data-notification-question-id]')) {
        const message = messages.get(node.dataset.searchMessageId || node.dataset.notificationQuestionId);
        if (!message) continue;
        const botId = current.view === 'room' ? message.botId : current.id;
        const key = `${current.view}:${current.id}:${message.id}`, rect = node.getBoundingClientRect();
        if (!botId || sent.has(key) || rect.bottom <= top + 40 || rect.top >= bottom - 80 || rect.width <= 0 || rect.height <= 0) continue;
        onScreen.add(key);
        if (!visibleSince.has(key)) visibleSince.set(key, now());
        if (now() - visibleSince.get(key) < dwellMs) continue;
        const group = groups.get(botId) || []; group.push({id:message.id, key, question:!!message.question}); groups.set(botId, group);
      }
      for (const key of visibleSince.keys()) if (!onScreen.has(key)) visibleSince.delete(key);
      if (pending || now() < retryAt) return;
      const entry = groups.entries().next().value;
      if (!entry) return;
      const [botId, rows] = entry, batch = rows.slice(-20), version = generation;
      pending = true;
      try {
        await current.api('/api/notifications/read', {method:'POST', body:{botId, ...(current.view === 'room' ? {roomId:current.id} : {}), messageIds:batch.filter(row => !row.question).map(row => row.id), ...(batch.some(row => row.question) ? {questionId:batch.find(row => row.question).id} : {})}});
        if (generation === version && context().generation === version) {
          for (const row of batch) sent.add(row.key);
          current.onRead?.({view:current.view, id:current.id, botId, messageIds:batch.map(row => row.id)});
        }
        while (sent.size > 2000) sent.delete(sent.values().next().value);
      } catch {retryAt = now() + 10000;}
      finally {pending = false;}
    }
    const timer = setInterval(() => {void tick();}, 1000);
    return {tick, close() {clearInterval(timer); for (const name of events) window.removeEventListener(name, interact); window.removeEventListener('focus', interact);}};
  }
  window.StudioNotificationReads = Object.freeze({install});
})();
