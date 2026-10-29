import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, ensure, HttpError } from './store.mjs';

const SAFE_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const TOKEN = /^(?:[0-9a-f]{2}){32,256}$/;
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const DAY = 24 * 60 * 60_000, MAX_OUTBOX = 1000, MAX_ORPHANS = 1000, MAX_SEEN = 10_000;
const map = value => Object.assign(Object.create(null), value || {});
const hash = value => createHash('sha256').update(value).digest('hex');
const eventId = (kind, botId, identity) => hash(`${kind}\n${botId}\n${identity}`).slice(0, 32);
const initial = () => ({v:1, sequence:0, read:map(), seen:map(), seenFloor:0, routines:map(), orphans:[], subscriptions:map(), outbox:[]});

/** Capture only routing metadata, never message contents, names, prompts or errors. */
function snapshot(state) {
  const bots = new Set((state.bots || []).map(bot => bot.id).filter(id => SAFE_ID.test(id)));
  const messages = map();
  for (const [botId, rows] of Object.entries(state.messages || {})) {
    if (!bots.has(botId) || !Array.isArray(rows)) continue;
    messages[botId] = rows.map(({id, role, createdAt, runId, source, routineId, sessionId, fromBotId, partial}) =>
      ({id, role, createdAt, runId, source, routineId, sessionId, fromBotId, partial}));
  }
  const history = Object.entries(state.runHistory || {}).flatMap(([botId, rows]) => Array.isArray(rows) ? rows.map(row => ({...row, botId})) : []);
  const runs = [...new Map([...Object.values(state.runs || {}), ...history].filter(run => bots.has(run.botId)).map(({id, botId, source, routineId, status, createdAt, finishedAt}) => [id, {id, botId, source, routineId, status, createdAt, finishedAt}])).values()];
  const routines = (state.routines || []).filter(routine => bots.has(routine.botId)).map(({id, botId, lastRunAt, lastError}) => ({id, botId, lastRunAt, failed:!!lastError}));
  const roomMessages = map();
  const rooms = new Set((state.rooms || []).map(room => room.id).filter(id => SAFE_ID.test(id)));
  for (const [roomId, rows] of Object.entries(state.roomMessages || {})) if (rooms.has(roomId) && Array.isArray(rows)) {
    roomMessages[roomId] = rows.filter(row => bots.has(row.botId)).map(({id, role, createdAt, botId, partial}) => ({id, role, createdAt, botId, partial}));
  }
  return {messages, runs, routines, roomMessages};
}

/** Bounded plain text only: never attachment bytes, tool output, URLs or raw errors. */
export function previewText(value, limit) {
  return [...String(value || '').slice(0, 8000).replace(/```[\s\S]*?(?:```|$)/g, ' [Code] ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/gi, '')
    .replace(/<[^>]*>/g, '').replace(/[#*_`~|>]/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim()].slice(0, limit).join('');
}

const AVATARS = new Set(['blue','coral','jade','honey','cloud','tangerine','lagoon','cherry','pistachio','periwinkle','peach','lemon','rose','teal','azure','scarlet','butter','mint','cocoa','blush','cobalt','ice','apricot','silver']);
export function notificationAvatar(bot = {}) {
  const explicit = String(bot.icon || '').replace(/^companion:/, '');
  if (String(bot.icon || '').startsWith('companion:') && AVATARS.has(explicit)) return explicit;
  const names = {atlas:'blue', nova:'coral', scout:'jade', echo:'honey'};
  const canonical = /^bot_(atlas|nova|scout|echo)$/.exec(String(bot.id || ''))?.[1];
  const name = String(bot.name || '').trim().toLowerCase();
  if (canonical || Object.hasOwn(names, name)) return names[canonical || name];
  let identity = 2166136261;
  for (const char of String(bot.id || bot.name || 'companion-preview').slice(0, 200)) identity = Math.imul(identity ^ char.charCodeAt(0), 16777619);
  return ['blue','coral','jade','honey'][(identity >>> 0) % 4];
}

/** iOS controls whether these previews are visible while locked. */
export function notificationPayload(event, engineId, presentation = {}) {
  ensure(SAFE_ID.test(engineId) && SAFE_ID.test(event.botId) && /^[0-9a-f]{32}$/.test(event.id), 500, 'Invalid notification identity.');
  ensure(['message', 'routine'].includes(event.kind), 500, 'Invalid notification kind.');
  const studio = {v:1, engineId, botId:event.botId, kind:event.kind, eventId:event.id};
  if (event.kind === 'routine' && SAFE_ID.test(event.routineId || '')) studio.routineId = event.routineId;
  if (event.kind === 'message' && SAFE_ID.test(event.roomId || '')) studio.roomId = event.roomId;
  const title = previewText(presentation.name, 80) || 'Tupies';
  const body = previewText(presentation.preview, 240) || (event.kind === 'routine' ? 'A routine has an update.' : 'A bot has replied.');
  const subtitle = previewText(presentation.subtitle, 100);
  if (AVATARS.has(presentation.avatar)) studio.avatar = presentation.avatar;
  return {aps:{alert:{title, ...(subtitle ? {subtitle} : {}), body}, sound:'default', 'mutable-content':1, 'thread-id':`studio-${engineId}-${event.roomId || event.botId}`}, studio};
}

/**
 * Engine-local native push registrations and delivery intentions. This file is outside
 * the replicated state; tokens are sealed with this engine's vault key. Observers run
 * after commits but never perform network I/O inside the Store transaction.
 */
export class Notifications {
  constructor(store, {sync, transport, now = Date.now, intervalMs = 15_000, graceMs = 8000} = {}) {
    this.store = store; this.sync = sync; this.transport = transport; this.now = now; this.intervalMs = intervalMs; this.graceMs = graceMs;
    this.file = path.join(store.directory, 'notifications.json'); this.state = initial();
    this.queue = Promise.resolve(); this.closed = false; this.storageError = false; this.readOnly = false;
  }
  async init() {
    let saved = null;
    try {
      const stat = await fs.lstat(this.file);
      ensure(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024, 500, 'Notification storage is invalid.');
      saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const object = value => value && typeof value === 'object' && !Array.isArray(value);
      ensure(saved?.v === 1 && Array.isArray(saved.outbox) && saved.outbox.length <= MAX_OUTBOX && Array.isArray(saved.orphans) && saved.orphans.length <= MAX_ORPHANS && object(saved.seen) && object(saved.routines) && object(saved.subscriptions) && Object.keys(saved.subscriptions).length <= 100 && (saved.read === undefined || object(saved.read) && Object.keys(saved.read).length <= MAX_SEEN), 500, 'Notification storage is invalid.');
      ensure(saved.outbox.every(item => object(item) && typeof item.id === 'string' && typeof item.deviceId === 'string' && object(item.event) && typeof item.status === 'string') && saved.orphans.every(object) && Object.values(saved.subscriptions).every(item => object(item) && typeof item.secret === 'string' && typeof item.tokenHash === 'string' && ['sandbox','production'].includes(item.environment)), 500, 'Notification storage is invalid.');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Push metadata must never stop the engine or be reset over a damaged file.
        this.storageError = true; this.readOnly = true; return this;
      }
    }
    const startup = await this.store.serialize(() => ({observed:snapshot(this.store.state), revision:this.store.revision}));
    if (saved) {
      this.state = {...saved, sequence:saved.sequence || 0, read:map(saved.read), seen:map(saved.seen), seenFloor:saved.seenFloor || 0, routines:map(saved.routines), subscriptions:map(saved.subscriptions)};
      // A process that vanished after a durable claim may already have delivered.
      // Do not replay that ambiguous dispatch when the engine starts again.
      for (const item of this.state.outbox) if (item.status === 'claimed') {item.status = 'unknown'; item.error = 'delivery_unknown';}
      this.prune(); this.removeRevoked();
      await this.observe(startup.observed);
    } else {
      await this.observe(startup.observed, {baseline:true});
    }
    await this.save();
    this.unsubscribe = this.store.onCommit(({local} = {}) => {
      if (this.closed || local || this.observationScheduled) return;
      this.observationScheduled = true;
      // A listener can never throw into a Store commit or grow an unbounded
      // snapshot queue while APNs is slow. Capture one current committed view.
      queueMicrotask(() => {
        this.enqueue(async () => {
          try {
            const observed = await this.store.serialize(() => snapshot(this.store.state));
            this.observationScheduled = false;
            if (!this.closed) await this.observe(observed);
          } finally {this.observationScheduled = false;}
        }).then(() => this.deliver()).catch(() => {this.storageError = true;});
      });
    });
    // Sync is already running: catch commits that landed while startup metadata
    // was being saved, after installing the listener so this handoff has no gap.
    if (this.store.revision !== startup.revision) await this.enqueue(async () => this.observe(await this.store.serialize(() => snapshot(this.store.state))));
    this.timer = setInterval(() => {if (!this.closed) this.flush().catch(() => {this.storageError = true;});}, this.intervalMs);
    this.timer.unref?.();
    this.deliveryTimer = setInterval(() => {this.deliver().catch(() => {this.storageError = true;});}, 1000);
    this.deliveryTimer.unref?.();
    this.deliver().catch(() => {this.storageError = true;});
    return this;
  }
  enqueue(fn) {
    const operation = this.queue.then(fn);
    this.queue = operation.catch(() => {this.storageError = true;});
    return operation;
  }
  async save() {ensure(!this.readOnly, 503, 'Notification storage is unavailable. Restore its backup.'); await atomicWrite(this.file, JSON.stringify(this.state));}
  authority() {return this.sync.role() !== 'replica';}
  available(environment) {return !this.readOnly && this.authority() && !!this.transport?.available && (!environment || environment === this.transport.environment);}
  reason(environment) {
    if (this.readOnly) return 'storage_unavailable';
    if (!this.authority()) return 'home_server_only';
    if (!this.transport?.available) return 'not_configured';
    if (environment && environment !== this.transport.environment) return 'environment_mismatch';
    return null;
  }
  device(device) {
    ensure(device?.id && this.sync.devices.find(device.id) && device.kind !== 'engine' && device.platform === 'ios', 403, 'Only a paired iPhone or iPad can manage its notifications.');
    return device;
  }
  status(device) {
    this.device(device);
    const registration = this.state.subscriptions[device.id];
    const last = this.state.outbox.findLast(item => item.deviceId === device.id);
    const reason = this.reason(registration?.environment);
    return {available:!reason, registered:!!registration, enabled:!!registration?.enabled, botReplies:registration?.botReplies ?? true, routines:registration?.routines ?? true,
      ...(this.transport?.environment || registration?.environment ? {environment:this.transport?.environment || registration.environment} : {}), ...(reason ? {reason} : {}),
      delivery:{status:this.storageError ? 'storage_error' : last?.status || 'idle', ...(this.storageError ? {lastError:'storage_unavailable'} : last?.error ? {lastError:last.error} : {})}};
  }
  async register(device, input) {
    this.device(device);
    ensure(!this.readOnly, 503, 'Notification storage is unavailable. Restore its backup.');
    ensure(input && typeof input === 'object' && !Array.isArray(input), 400, 'Enter notification settings.');
    const allowed = new Set(['token', 'environment', 'enabled', 'botReplies', 'routines']);
    ensure(Object.keys(input).every(key => allowed.has(key)), 400, 'Only this device’s notification settings can be changed.');
    ensure(typeof input.token === 'string' && TOKEN.test(input.token), 400, 'A valid APNs device token is required.');
    ensure(['sandbox', 'production'].includes(input.environment), 400, 'Choose the app’s APNs environment.');
    for (const field of ['enabled', 'botReplies', 'routines']) ensure(typeof input[field] === 'boolean', 400, 'Notification preferences must be true or false.');
    return this.enqueue(async () => {
      this.device(device);
      const tokenHash = hash(`${input.environment}\n${input.token}`);
      // One APNs installation token gets one registration on this engine, even
      // after the same phone was paired again under a new device key.
      for (const [id, entry] of Object.entries(this.state.subscriptions)) if (id !== device.id && entry.tokenHash === tokenHash) delete this.state.subscriptions[id];
      const previous = this.state.subscriptions[device.id], start = this.state.sequence + 1, at = this.now();
      const enabledSeq = previous?.enabled && input.enabled ? previous.enabledSeq : start;
      const enabledAt = previous?.enabled && input.enabled ? previous.enabledAt : at;
      this.state.subscriptions[device.id] = {secret:this.store.seal(input.token), tokenHash, environment:input.environment, enabled:input.enabled, botReplies:input.botReplies, routines:input.routines, updatedAt:at, enabledSeq, enabledAt,
        botRepliesSeq:previous?.botReplies && input.botReplies ? previous.botRepliesSeq : start, botRepliesAt:previous?.botReplies && input.botReplies ? previous.botRepliesAt : at,
        routinesSeq:previous?.routines && input.routines ? previous.routinesSeq : start, routinesAt:previous?.routines && input.routines ? previous.routinesAt : at};
      this.removeRevoked(); this.prune(); await this.save();
      return this.status(device);
    });
  }
  async unregister(device) {
    this.device(device);
    ensure(!this.readOnly, 503, 'Notification storage is unavailable. Restore its backup.');
    return this.enqueue(async () => {
      delete this.state.subscriptions[device.id];
      this.state.outbox = this.state.outbox.filter(item => item.deviceId !== device.id);
      await this.save(); return this.status(device);
    });
  }
  removeRevoked() {
    for (const id of Object.keys(this.state.subscriptions)) {
      const device = this.sync.devices.find(id);
      if (!device || device.kind === 'engine' || device.platform !== 'ios') delete this.state.subscriptions[id];
    }
    for (const item of this.state.outbox) if (['pending', 'claimed'].includes(item.status) && !this.state.subscriptions[item.deviceId]) {item.status = 'cancelled'; item.error = 'registration_removed';}
  }
  prune() {
    const cutoff = this.now() - DAY;
    for (const item of this.state.outbox) if (item.status === 'pending' && item.createdAt < cutoff) {item.status = 'expired'; item.error = 'delivery_expired';}
    this.state.outbox = this.state.outbox.slice(-MAX_OUTBOX);
    this.state.read = map(Object.fromEntries(Object.entries(this.state.read).filter(([, at]) => Number.isFinite(at) && at >= cutoff).slice(-MAX_SEEN)));
    this.state.orphans = this.state.orphans.filter(item => item.observedAt >= cutoff).slice(-MAX_ORPHANS);
    const seen = Object.entries(this.state.seen).filter(([, at]) => at >= cutoff).sort((a, b) => a[1] - b[1]);
    if (seen.length > MAX_SEEN) this.state.seenFloor = Math.max(this.state.seenFloor, seen[seen.length - MAX_SEEN - 1][1]);
    this.state.seen = map(Object.fromEntries(seen.slice(-MAX_SEEN)));
  }
  eligible(registration, event) {
    if (!registration?.enabled || !this.available(registration.environment) || !(event.kind === 'message' ? registration.botReplies : registration.routines)) return false;
    const seq = Math.max(registration.enabledSeq || 0, (event.kind === 'message' ? registration.botRepliesSeq : registration.routinesSeq) || 0);
    const at = Math.max(registration.enabledAt || 0, (event.kind === 'message' ? registration.botRepliesAt : registration.routinesAt) || 0);
    // A first-observed boundary suppresses pre-enrollment orphans. The five-minute
    // creation-time tolerance permits ordinary linked-engine clock skew, while
    // a newly imported old transcript cannot become a lock-screen backlog.
    return event.observedSeq >= seq && event.createdAt >= at - 5 * 60_000;
  }
  permitted(item) {
    const registration = this.state.subscriptions[item.deviceId];
    return !this.closed && this.authority() && !!this.sync.devices.find(item.deviceId) && registration?.tokenHash === item.tokenHash && this.eligible(registration, item.event);
  }
  async markRead(ids) {
    if (this.readOnly || this.closed) return;
    await this.enqueue(async () => {
      for (const id of ids.slice(-1000)) if (/^[0-9a-f]{32}$/.test(id)) this.state.read[id] = this.now();
      for (const item of this.state.outbox) if (item.status === 'pending' && Object.hasOwn(this.state.read, item.event.id)) item.status = 'suppressed';
      this.prune(); await this.save();
    });
  }
  async acknowledge(input) {
    ensure(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => ['botId','roomId','messageIds'].includes(key)), 400, 'Invalid read receipt.');
    ensure(typeof input.botId === 'string' && SAFE_ID.test(input.botId) && (input.roomId === undefined || typeof input.roomId === 'string' && SAFE_ID.test(input.roomId)), 400, 'Invalid conversation.');
    ensure(Array.isArray(input.messageIds) && input.messageIds.length <= 20 && input.messageIds.every(id => typeof id === 'string' && SAFE_ID.test(id)), 400, 'Invalid message receipts.');
    const ids = await this.store.serialize(() => {
      const rows = input.roomId ? this.store.state.roomMessages?.[input.roomId] : this.store.state.messages?.[input.botId];
      const result = [];
      for (const message of rows || []) {
        if (message.role !== 'assistant' || message.partial || !input.messageIds.includes(message.id) || input.roomId && message.botId !== input.botId) continue;
        if (input.roomId) result.push(eventId('message', message.botId, `room:${input.roomId}:${message.id}`));
        else {
          const request = rows.find(row => row.role === 'user' && row.runId === message.runId);
          if (request?.source === 'routine' && SAFE_ID.test(request.routineId || '')) result.push(eventId('routine', input.botId, message.runId));
          else if (request?.source === 'chat' && (!request.sessionId || request.sessionId === input.botId) && !request.fromBotId && !request.routineId) result.push(eventId('message', input.botId, message.id));
        }
      }
      return result;
    });
    await this.markRead(ids);
    this.sync.recordNotificationReads?.(ids);
    return {acknowledged:true};
  }
  presentation(event) {
    const state = this.store.state, bot = state.bots.find(bot => bot.id === event.botId) || {};
    const rows = event.roomId ? state.roomMessages?.[event.roomId] : state.messages?.[event.botId];
    const message = (rows || []).find(message => (message.id === event.messageId || event.runId && message.runId === event.runId) && message.role === 'assistant' && !message.partial);
    const routine = event.kind === 'routine' && state.routines?.find(routine => routine.id === event.routineId);
    const room = event.roomId && state.rooms?.find(room => room.id === event.roomId);
    return {name:this.store.redact(bot.name || ''), avatar:notificationAvatar(bot), subtitle:routine ? this.store.redact(`Routine · ${routine.name || 'Update'}`) : this.store.redact(room?.name || ''),
      preview:this.store.redact(message?.content || (event.kind === 'routine' ? event.outcome === 'failed' ? 'The routine couldn’t finish. Open Tupies for details.' : event.outcome === 'interrupted' ? 'The routine was interrupted.' : 'The routine has an update.' : 'A bot has replied.'))};
  }
  add(event) {
    if (this.readOnly || !this.authority() || !this.transport?.available || Object.hasOwn(this.state.read, event.id)) return;
    for (const [deviceId, registration] of Object.entries(this.state.subscriptions)) {
      if (!this.eligible(registration, event)) continue;
      const id = `${event.id}:${deviceId}:${registration.tokenHash}`;
      const previous = this.state.outbox.find(item => item.id === id);
      if (previous) {if (previous.status === 'pending') previous.event = {...previous.event, ...Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined))}; continue;}
      this.state.outbox.push({id, deviceId, tokenHash:registration.tokenHash, event, status:'pending', attempts:0, createdAt:this.now(), nextAttemptAt:this.now() + this.graceMs});
    }
  }
  classify(botId, message, requests, observation) {
    const request = requests.get(message.runId);
    if (!request) return false;
    if (request.source === 'chat' && (!request.sessionId || request.sessionId === botId) && !request.routineId && !request.fromBotId) {
      this.add({...observation, id:eventId('message', botId, message.id), kind:'message', botId, messageId:message.id});
    } else if (request.source === 'routine' && SAFE_ID.test(request.routineId || '')) {
      this.add({...observation, id:eventId('routine', botId, message.runId), kind:'routine', botId, routineId:request.routineId, runId:message.runId, messageId:message.id});
    }
    return true;
  }
  async observe(observed, {baseline = false} = {}) {
    const before = JSON.stringify(this.state), cutoff = Math.max(this.now() - DAY, this.state.seenFloor || 0);
    this.removeRevoked();
    const fresh = (key, message) => {
      const at = Date.parse(message.createdAt);
      if (!SAFE_ID.test(message.id || '') || !Number.isFinite(at) || at <= cutoff || at > this.now() + 5 * 60_000 || Object.hasOwn(this.state.seen, key)) return false;
      this.state.seen[key] = at;
      const observation = {createdAt:at, observedAt:this.now(), observedSeq:++this.state.sequence};
      return baseline ? false : observation;
    };
    const pending = [];
    for (const [botId, messages] of Object.entries(observed.messages)) {
      const requests = new Map(messages.filter(message => message.role === 'user' && SAFE_ID.test(message.runId || '')).map(message => [message.runId, message]));
      const candidates = this.state.orphans.filter(item => item.botId === botId);
      for (const message of messages) {
        if (message.role !== 'assistant' || message.partial || !SAFE_ID.test(message.runId || '')) continue;
        const observation = fresh(hash(`bot:${botId}:${message.id}`), message);
        if (observation) candidates.push({botId, messageId:message.id, runId:message.runId, ...observation});
      }
      for (const candidate of candidates) {
        const message = messages.find(item => item.id === candidate.messageId && item.runId === candidate.runId && item.role === 'assistant' && !item.partial);
        if (message && Date.parse(message.createdAt) > cutoff && !this.classify(botId, message, requests, candidate)) pending.push(candidate);
      }
    }
    this.state.orphans = baseline ? [] : [...new Map(pending.map(item => [`${item.botId}:${item.messageId}`, item])).values()];
    for (const [roomId, messages] of Object.entries(observed.roomMessages)) {
      for (const message of messages) if (message.role === 'assistant' && !message.partial) {
        const observation = fresh(hash(`room:${roomId}:${message.id}`), message);
        if (observation) this.add({...observation, id:eventId('message', message.botId, `room:${roomId}:${message.id}`), kind:'message', botId:message.botId, roomId, messageId:message.id});
      }
    }
    for (const run of observed.runs) {
      if (run.source !== 'routine' || !TERMINAL.has(run.status) || !SAFE_ID.test(run.routineId || '') || !SAFE_ID.test(run.id || '')) continue;
      if (!observed.routines.some(routine => routine.id === run.routineId && routine.botId === run.botId)) continue;
      const observation = fresh(hash(`routine:${run.botId}:${run.id}`), {id:run.id, createdAt:run.finishedAt || run.createdAt});
      if (observation) this.add({...observation, id:eventId('routine', run.botId, run.id), kind:'routine', botId:run.botId, routineId:run.routineId, runId:run.id, outcome:run.status, messageId:observed.messages[run.botId]?.find(message => message.runId === run.id && message.role === 'assistant' && !message.partial)?.id});
    }
    for (const routine of observed.routines) {
      const cursor = this.state.routines[routine.id] || {};
      if (!baseline && routine.failed && routine.lastRunAt && Date.parse(routine.lastRunAt) > cutoff && cursor.admissionAt !== routine.lastRunAt) this.add({createdAt:Date.parse(routine.lastRunAt), observedAt:this.now(), observedSeq:++this.state.sequence, id:eventId('routine', routine.botId, `admission:${routine.id}:${routine.lastRunAt}`), kind:'routine', botId:routine.botId, routineId:routine.id, outcome:'failed'});
      if (routine.lastRunAt) cursor.admissionAt = routine.lastRunAt;
      this.state.routines[routine.id] = cursor;
    }
    const activeRoutines = new Set(observed.routines.map(routine => routine.id));
    for (const id of Object.keys(this.state.routines)) if (!activeRoutines.has(id)) delete this.state.routines[id];
    this.prune();
    if (JSON.stringify(this.state) !== before) await this.save();
  }
  deliver() {
    if (this.delivery) return this.delivery;
    if (this.closed || this.readOnly || !this.authority() || !this.transport?.available) return Promise.resolve();
    const operation = this.runDelivery();
    this.delivery = operation.finally(() => {this.delivery = null;});
    return this.delivery;
  }
  async runDelivery() {
    for (let sent = 0; sent < 50 && !this.closed && this.authority(); sent++) {
      const claim = await this.enqueue(async () => {
        this.removeRevoked(); this.prune();
        const item = this.state.outbox.find(item => item.status === 'pending' && item.nextAttemptAt <= this.now());
        if (!item) return null;
        const registration = this.state.subscriptions[item.deviceId];
        const permitted = this.permitted(item);
        if (!permitted) {item.status = 'cancelled'; item.error = 'registration_changed'; await this.save(); return {skip:true};}
        if (Object.hasOwn(this.state.read, item.event.id)) {item.status = 'suppressed'; await this.save(); return {skip:true};}
        item.status = 'claimed'; item.attempts++; await this.save();
        return {item, registration:{...registration}};
      });
      if (!claim) break;
      if (claim.skip) continue;
      const {item, registration} = claim;
      // Re-check revocation immediately before credentialed transport. Revocations
      // committed during another device's network request also take effect here.
      if (!this.permitted(item)) {
        await this.enqueue(async () => {item.status = 'cancelled'; item.error = 'registration_changed'; await this.save();});
        continue;
      }
      if (Object.hasOwn(this.state.read, item.event.id)) {
        await this.enqueue(async () => {item.status = 'suppressed'; await this.save();});
        continue;
      }
      let result;
      try {
        const token = this.store.unseal(registration.secret);
        result = await this.transport.send({token, environment:registration.environment, payload:notificationPayload(item.event, this.sync.nodeId, this.presentation(item.event)), eventId:item.event.id});
      } catch {
        await this.enqueue(async () => {if (this.state.outbox.includes(item)) {item.status = 'unknown'; item.error = 'delivery_unknown'; await this.save();}});
        continue;
      }
      await this.enqueue(async () => {
        if (!this.state.outbox.includes(item)) return;
        if (result.status === 200) {item.status = 'sent'; delete item.error;}
        else if (result.status === 410 || result.status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(result.reason)) {
          item.status = 'failed'; item.error = 'registration_expired';
          if (this.state.subscriptions[item.deviceId]?.tokenHash === item.tokenHash) delete this.state.subscriptions[item.deviceId];
        } else if ((result.status === 429 || result.status >= 500 && result.status <= 599) && item.attempts < 5 && this.now() - item.createdAt < DAY) {
          const retry = Math.max(result.status >= 500 ? 15 * 60 : 60, Math.min(Number(result.retryAfter) || 0, 24 * 60 * 60), result.status === 429 ? 60 * 2 ** (item.attempts - 1) : 0);
          item.status = 'pending'; item.error = 'temporarily_unavailable'; item.nextAttemptAt = this.now() + retry * 1000;
        } else {item.status = 'failed'; item.error = result.status === 403 ? 'push_authorization_failed' : 'delivery_rejected';}
        await this.save();
      });
    }
  }
  /** Deterministic fixture/lifecycle drain; no Store mutation or task replay. */
  async flush() {if (this.readOnly) return; await this.enqueue(async () => this.observe(await this.store.serialize(() => snapshot(this.store.state)))); await this.deliver(); await this.queue;}
  async close() {this.closed = true; clearInterval(this.timer); clearInterval(this.deliveryTimer); this.unsubscribe?.(); await this.transport?.close?.(); await this.delivery; await this.queue;}

}

/** This native-only route cannot be reached with a password/web cookie or linked-engine bearer. */
export async function notificationsApi(req, res, url, {session, notifications, body, json}) {
  if (url.pathname === '/api/notifications/read') {
    ensure(session.kind !== 'engine', 403, 'Use an authenticated workspace session.');
    ensure(req.method === 'POST', 405, 'Method not allowed.');
    json(res, await notifications.acknowledge(await body(req, 4000))); return true;
  }
  if (url.pathname !== '/api/device/notifications') return false;
  ensure(session.device && session.kind !== 'engine' && /^hsd_[A-Za-z0-9_-]{43}$/.test(session.token || ''), 403, 'Use the paired app to manage its notifications.');
  if (req.method === 'GET') {json(res, notifications.status(session.device)); return true;}
  if (req.method === 'PUT') {json(res, await notifications.register(session.device, await body(req, 4_000))); return true;}
  if (req.method === 'DELETE') {await body(req); json(res, await notifications.unregister(session.device)); return true;}
  throw new HttpError(405, 'Method not allowed.');
}
