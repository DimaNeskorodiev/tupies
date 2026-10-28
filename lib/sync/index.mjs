import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicWrite, ensure, HttpError, now } from '../store.mjs';
import { Clock, GENESIS, compareStamps, parseStamp } from './clock.mjs';
import { listDocuments, readDocument, writeDocument, parseKey, botOf, kindOf } from './docs.mjs';
import { FileReplica } from './files.mjs';
import { Devices } from './devices.mjs';
import { EngineTransport } from './transport.mjs';
import { digest, fingerprint, generateIdentity, sealBytes, openBytes, sealJson, openJson, signMessage, verifyMessage, unwrapWorkspaceKey, PAIR_MESSAGE, PAIRED_MESSAGE, SESSION_MESSAGE } from './crypto.mjs';

const BATCH_CHANGES = 400, BATCH_BYTES = 4 * 1024 * 1024, LONG_POLL_MS = 25_000, PRESENCE_BEAT_MS = 120_000, PRESENCE_STALE_MS = 6 * 60_000;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,120}$/;
/** Waits for a backoff unless the link is being stopped, so shutdown never hangs on a sleeping loop. */
const pause = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(done, ms); timer.unref?.();
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});
/** A friendly first name: the Mac's Computer Name from System Settings, otherwise "Home server" for a server. */
function defaultEngineName() {
  if (process.platform === 'darwin') {
    try { const name = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (name && !/[\x00-\x1f\x7f]/.test(name)) return name.slice(0, 60); } catch {}
    return os.hostname().replace(/\.local$/i, '').slice(0, 60) || 'Mac';
  }
  return 'Home server';
}
const isActiveRun = run => !!run && ['queued', 'running', 'waiting_for_approval', 'stopping'].includes(run.status);

/** Engines may reach each other over HTTPS, loopback (SSH tunnels) or a Tailscale address; anything else needs an explicit opt-in. */
export function validateEngineUrl(value, allowHttp = process.env.STUDIO_SYNC_ALLOW_HTTP === 'true') {
  let url;
  try { url = new URL(String(value)); } catch { throw new HttpError(400, 'Enter the engine address, such as https://studio.example.ts.net.'); }
  ensure(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && ['', '/'].includes(url.pathname), 400, 'Use the engine origin only, such as https://studio.example.ts.net.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(host);
  const tailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) || /^fd7a:115c:a1e0:/i.test(host) || host.endsWith('.ts.net');
  ensure(url.protocol === 'https:' || loopback || tailnet || allowHttp, 400, 'Use HTTPS (or a Tailscale/loopback address) so device credentials are never sent in clear text.');
  return url.origin;
}
export function parsePairingLink(link) {
  let url;
  try { url = new URL(String(link).trim()); } catch { throw new HttpError(400, 'Paste the complete pairing link that starts with hermes-studio://pair.'); }
  ensure(url.protocol === 'hermes-studio:' && (url.hostname === 'pair' || url.pathname.replace(/^\/+/, '') === 'pair'), 400, 'Paste the complete pairing link that starts with hermes-studio://pair.');
  const value = key => url.searchParams.get(key) || '';
  ensure(value('v') === '1', 400, 'This pairing link needs a newer Tupies version.');
  return { url: value('url'), code: value('code'), fingerprint: value('fp'), name: value('name') || 'Home server', kind: value('kind') || 'device', tls: value('tls') };
}

/**
 * Replicates Tupies state between engines. The home server is the hub; other engines push their own changes and
 * long-poll the hub for everyone else's. Every document carries a hybrid-logical-clock stamp and the newest stamp wins;
 * chats, memory facts and files are separate documents, so most concurrent work merges without conflict.
 * Engine-to-engine payloads are sealed with a workspace key that only linked engines hold.
 */
export class Sync {
  constructor(store, options = {}) {
    this.store = store; this.options = options;
    this.directory = path.join(store.directory, 'sync');
    this.fetch = options.syncFetch || globalThis.fetch; this.transport = new EngineTransport();
    this.waiters = new Set(); this.deferred = new Map(); this.listeners = new Set(); this.online = new Map();
    this.peer = null; this.closed = false; this.scanTimer = null; this.metaTimer = null; this.fileEpoch = 0;
    this.peerStatus = { connected: false, lastSyncAt: null, error: null, pushing: false };
    this.locallyActive = options.locallyActive || (botId => isActiveRun(this.store.state.runs?.[botId]));
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const read = async name => { try { return JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
    let identity = await read('identity.json');
    if (!identity) {
      const created = generateIdentity();
      identity = { nodeId: `node_${randomBytes(9).toString('hex')}`, name: this.options.engineName || process.env.STUDIO_ENGINE_NAME || defaultEngineName(), publicKey: created.publicKey, privateKey: this.store.seal(created.privateKey), createdAt: now() };
      await atomicWrite(path.join(this.directory, 'identity.json'), JSON.stringify(identity, null, 2));
    }
    this.identity = { ...identity, privateKey: this.store.unseal(identity.privateKey), fingerprint: fingerprint(identity.publicKey) };
    this.nodeId = identity.nodeId;
    const keyFile = path.join(this.directory, 'workspace.key');
    try { this.workspaceKey = await fs.readFile(keyFile); } catch (error) { if (error.code !== 'ENOENT') throw error; this.workspaceKey = randomBytes(32); await fs.writeFile(keyFile, this.workspaceKey, { mode: 0o600, flag: 'wx' }); }
    ensure(this.workspaceKey.length === 32, 500, 'The sync workspace key is invalid. Restore your data backup.');
    this.config = (await read('config.json')) || { hub: null };
    this.clock = new Clock(this.nodeId);
    const meta = await read('meta.json');
    this.files = new FileReplica(this.store.directory, { onChange: () => this.schedule(400), maxFileBytes: this.options.maxSyncFileBytes });
    await this.files.init();
    this.store.state.devices ||= []; this.store.state.presence ||= {};
    if (meta?.v === 1) {
      this.meta = meta;
      for (const entry of Object.values(meta.docs)) this.clock.observe(entry.h);
    } else {
      // A brand-new or re-seeded engine starts at genesis so an existing workspace wins; an established workspace stamps its data now.
      this.meta = { v: 1, seq: 0, pushed: 0, cursor: 0, docs: {} };
      const stamp = this.store.created || this.config.hub ? GENESIS : this.clock.now();
      const fileDocs = await this.files.scan();
      await this.store.serialize(() => { this.scanState(stamp); this.scanFiles(fileDocs, stamp); });
      await this.saveMeta();
    }
    this.devices = new Devices(this.store, this);
    // Run progress (streamed text, work-log events) holds no replicated documents, so it does not trigger a full rescan.
    this.store.onCommit(({ local } = {}) => { if (!local) this.schedule(); });
    await this.scan();
    this.heartbeat = setInterval(() => { if (this.activeBots().length) this.schedule(0); }, PRESENCE_BEAT_MS);
    this.heartbeat.unref?.();
    this.periodic = setInterval(() => this.schedule(0), this.options.fileScanInterval || 30_000);
    this.periodic.unref?.();
    if (this.config.hub) this.startPeer();
    return this;
  }

  role() {
    if (this.config.hub) return 'replica';
    return (this.store.state.devices || []).some(device => device.kind === 'engine' && !device.revokedAt && device.pairedVia === this.nodeId) ? 'hub' : 'standalone';
  }
  /** Routines and messaging channels run on exactly one engine: the home server, or this engine when it syncs with nobody. */
  runsAutomation() { return this.role() !== 'replica'; }
  activeBots() { return Object.entries(this.store.state.runs || {}).filter(([, run]) => isActiveRun(run)).map(([botId]) => botId); }
  presence() {
    const active = Object.fromEntries(Object.entries(this.store.state.runs || {}).filter(([, run]) => isActiveRun(run)).map(([botId, run]) => [botId, { runId: run.id, since: run.createdAt }]));
    return { name: this.identity.name, role: this.role(), url: this.options.publicUrl || '', active, ...(Object.keys(active).length ? { beat: Math.floor(Date.now() / PRESENCE_BEAT_MS) } : {}) };
  }
  /** Another engine that is working with this bot right now, from its replicated presence. */
  busyElsewhere(botId) {
    for (const [node, presence] of Object.entries(this.store.state.presence || {})) {
      if (node === this.nodeId || !presence?.active?.[botId]) continue;
      const wall = parseStamp(this.meta.docs[`presence:${node}`]?.h)?.wall || 0;
      if (Date.now() - wall < PRESENCE_STALE_MS) return { nodeId: node, name: typeof presence.name === 'string' && presence.name ? presence.name.slice(0, 80) : 'another engine' };
    }
    return null;
  }

  documents() {
    const docs = listDocuments(this.store.state, this.store);
    for (const key of [...docs.keys()]) if (key.startsWith('presence:')) docs.delete(key);
    for (const [node, presence] of Object.entries(this.store.state.presence || {})) if (node !== this.nodeId && SAFE_ID.test(node)) docs.set(`presence:${node}`, presence);
    docs.set(`presence:${this.nodeId}`, this.presence());
    return docs;
  }
  wireValue(key, entry) {
    if (entry.d === null) return null;
    if (key.startsWith('file:')) return { sha: entry.d, size: entry.z || 0 };
    if (key === `presence:${this.nodeId}`) return this.presence();
    return readDocument(this.store.state, key, this.store, 'wire') ?? null;
  }
  record(key, hash, stamp, extra = {}) {
    const previous = this.meta.docs[key];
    this.meta.docs[key] = { h: stamp || this.clock.now(), s: ++this.meta.seq, d: hash, o: this.nodeId, ...(previous?.h ? { b: previous.h } : {}), ...extra };
    this.dirty = true;
  }
  /** Compares current state with recorded hashes. Must run inside the store's serialized queue. */
  scanState(stamp) {
    const docs = this.documents();
    for (const [key, value] of docs) {
      const hash = digest(JSON.stringify(value));
      if (this.meta.docs[key]?.d !== hash) this.record(key, hash, stamp);
    }
    for (const [key, entry] of Object.entries(this.meta.docs)) if (!key.startsWith('file:') && entry.d !== null && !docs.has(key)) this.record(key, null, stamp);
  }
  scanFiles(fileDocs, stamp) {
    for (const [key, value] of fileDocs) if (this.meta.docs[key]?.d !== value.sha) this.record(key, value.sha, stamp, { z: value.size });
    const skipped = new Set(this.files.skipped.map(item => `file:${item}`));
    for (const [key, entry] of Object.entries(this.meta.docs)) if (key.startsWith('file:') && entry.d !== null && !fileDocs.has(key) && !skipped.has(key) && parseKey(key)) this.record(key, null, stamp);
  }
  schedule(delay = 120) {
    if (this.closed) return;
    if (this.scanTimer && delay > 0) return;
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => { this.scanTimer = null; this.scan().catch(error => this.log('scan', error)); }, delay);
    this.scanTimer.unref?.();
  }
  async scan() {
    if (this.closed) return;
    let fileDocs, epoch;
    do { epoch = this.fileEpoch; fileDocs = await this.files.scan(); } while (epoch !== this.fileEpoch);
    await this.store.serialize(() => { this.scanState(); if (epoch === this.fileEpoch) this.scanFiles(fileDocs); });
    if (this.deferred.size) await this.retryDeferred();
    if (this.dirty) { this.dirty = false; this.saveMetaSoon(); this.notify(); }
  }
  notify() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
    for (const listener of this.listeners) listener();
  }
  saveMetaSoon() { if (this.metaTimer) return; this.metaTimer = setTimeout(() => { this.metaTimer = null; this.saveMeta().catch(error => this.log('meta', error)); }, 150); this.metaTimer.unref?.(); }
  async saveMeta() { await atomicWrite(path.join(this.directory, 'meta.json'), JSON.stringify(this.meta)); }
  async saveConfig() { await atomicWrite(path.join(this.directory, 'config.json'), JSON.stringify(this.config, null, 2)); }
  log(scope, error) { if (this.options.logErrors !== false) console.error(`Tupies sync (${scope}):`, this.store.redact(error?.message || String(error))); }

  validChange(change) {
    return change && typeof change === 'object' && parseKey(change.k) && this.clock.acceptable(change.h) && typeof change.o === 'string' && SAFE_ID.test(change.o)
      && (change.b === undefined || change.b === null || parseStamp(change.b)) && (change.v === null || typeof change.v === 'object');
  }
  /** Applies remote documents newest-stamp-wins. Local edits are scanned first so they are compared, not overwritten. */
  async applyRemote(changes, { label = 'another engine' } = {}) {
    const files = [], updates = [], previous = new Map();
    const stateChanges = changes.filter(change => !change?.k?.startsWith?.('file:'));
    // Sync bookkeeping changes in the same queued operation as the state it describes, and is rolled back if saving fails.
    if (stateChanges.length) await this.store.mutate(state => {
      this.scanState();
      for (const change of stateChanges) {
        if (!this.validChange(change) || change.k === `presence:${this.nodeId}`) continue;
        const local = this.meta.docs[change.k];
        if (local && compareStamps(local.h, change.h) >= 0) continue;
        const botId = botOf(change.k);
        if (botId && this.locallyActive(botId)) { this.deferred.set(change.k, { change, label }); continue; }
        if (!writeDocument(state, change.k, change.v, this.store)) continue;
        const after = change.v === null ? undefined : readDocument(state, change.k, this.store);
        if (!previous.has(change.k)) previous.set(change.k, this.meta.docs[change.k]);
        this.clock.observe(change.h);
        // A device kept revoked over a newer remote edit is restamped here, so the revocation wins on every engine.
        if (kindOf(change.k) === 'device' && after?.revokedAt && !change.v?.revokedAt) this.record(change.k, digest(JSON.stringify(after)));
        else this.meta.docs[change.k] = { h: change.h, s: ++this.meta.seq, d: after === undefined ? null : digest(JSON.stringify(after)), o: change.o, ...(change.b ? { b: change.b } : {}), r: 1 };
        updates.push(change.k);
        this.deferred.delete(change.k);
      }
    }).catch(error => {
      for (const [key, entry] of previous) { if (entry) this.meta.docs[key] = entry; else delete this.meta.docs[key]; }
      throw error;
    });
    for (const change of changes) if (change?.k?.startsWith?.('file:') && this.validChange(change)) files.push(change);
    let applied = updates.length;
    for (const change of files) if (await this.applyFile(change, label)) applied++;
    if (applied) this.options.onApplied?.(updates);
    if (applied || this.dirty) { this.dirty = false; this.saveMetaSoon(); this.notify(); }
    return applied;
  }
  async applyFile(change, label) {
    const local = this.meta.docs[change.k];
    if (change.v && !/^[0-9a-f]{64}$/.test(change.v.sha || '')) return false;
    const concurrent = local && local.d !== null && change.b !== local.h && change.v?.sha !== local.d;
    // Only the engine where the newer version lands keeps the older one as a conflict copy, so each conflict yields one copy.
    if (local && compareStamps(local.h, change.h) >= 0) return false;
    if (change.v === null && concurrent) { await this.store.serialize(() => this.record(change.k, local.d, null, { z: local.z })); return false; }
    if (concurrent) await this.files.conflictCopy(change.k, await this.files.readKey(change.k), this.nodeName(local.o));
    if (!(await this.files.apply(change.k, change.v))) return false;
    this.fileEpoch++;
    await this.store.serialize(() => { this.meta.docs[change.k] = { h: change.h, s: ++this.meta.seq, d: change.v?.sha ?? null, o: change.o, ...(change.b ? { b: change.b } : {}), ...(change.v ? { z: change.v.size } : {}), r: 1 }; this.clock.observe(change.h); });
    return true;
  }
  nodeName(nodeId) { return nodeId === this.nodeId ? this.identity.name : this.store.state.presence?.[nodeId]?.name || 'another engine'; }
  async retryDeferred() {
    const ready = [...this.deferred.values()].filter(({ change }) => !this.locallyActive(botOf(change.k)));
    if (!ready.length) return;
    for (const { change } of ready) this.deferred.delete(change.k);
    await this.applyRemote(ready.map(item => item.change), { label: ready[0].label });
  }

  /** Documents changed after a cursor, excluding versions the requesting engine authored itself. */
  changesSince(since, exclude) {
    const entries = Object.entries(this.meta.docs).filter(([, entry]) => entry.s > since).sort((a, b) => a[1].s - b[1].s);
    const changes = []; let bytes = 0, upto = since;
    for (const [key, entry] of entries) {
      if (changes.length >= BATCH_CHANGES || bytes >= BATCH_BYTES) return { changes, seq: upto, more: true };
      upto = entry.s;
      if (entry.o === exclude) continue;
      const change = { k: key, v: this.wireValue(key, entry), h: entry.h, o: entry.o, ...(entry.b ? { b: entry.b } : {}) };
      bytes += JSON.stringify(change).length; changes.push(change);
    }
    return { changes, seq: this.meta.seq, more: false };
  }
  waitForChange(ms, signal) {
    if (this.closed || signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms); timer.unref?.();
      this.waiters.add(done); signal?.addEventListener('abort', done, { once: true });
    });
  }
  hubEngine(session) {
    ensure(this.role() !== 'replica', 409, 'This engine syncs through another home server.');
    ensure(session?.kind === 'engine' && session.device.nodeId, 403, 'Only linked engines can sync.');
    return session.device;
  }
  /** Hub side of one exchange: apply what the engine pushed, then return what it has not seen, waiting briefly if nothing is new. */
  async exchange(session, sealed, signal) {
    const device = this.hubEngine(session), request = openJson(this.workspaceKey, sealed, 'exchange');
    ensure(request?.node === device.nodeId, 403, 'This sync request came from a different engine.');
    this.online.set(device.nodeId, now());
    if (Array.isArray(request.push) && request.push.length) {
      ensure(request.push.length <= 2000, 413, 'Push fewer changes at once.');
      for (const change of request.push) if (change?.k?.startsWith?.('file:') && change.v) ensure(await this.files.hasBlob(change.v.sha), 409, 'Upload file contents before their changes.');
      await this.applyRemote(request.push, { label: device.name });
    }
    if (!Number.isSafeInteger(request.since)) return sealJson(this.workspaceKey, { node: this.nodeId, seq: this.meta.seq, changes: [], more: false }, 'exchange-reply');
    // State is rescanned here; files are kept current by the watcher and periodic scans, which also wake waiting pulls.
    await this.store.serialize(() => this.scanState());
    let result = this.changesSince(request.since, device.nodeId);
    const wait = Math.min(Math.max(Number(request.wait) || 0, 0), LONG_POLL_MS);
    if (!result.changes.length && !result.more && wait) {
      await this.waitForChange(wait, signal);
      result = this.changesSince(request.since, device.nodeId);
    }
    this.online.set(device.nodeId, now());
    return sealJson(this.workspaceKey, { node: this.nodeId, ...result }, 'exchange-reply');
  }
  async blobForPeer(session, sha) {
    this.hubEngine(session);
    ensure(/^[0-9a-f]{64}$/.test(sha), 400, 'Unknown content.');
    const data = await this.files.readBlob(sha);
    ensure(data, 404, 'This file content changed. Sync again.');
    return sealBytes(this.workspaceKey, data, `blob:${sha}`);
  }
  async receiveBlob(session, sha, sealed) {
    this.hubEngine(session);
    ensure(/^[0-9a-f]{64}$/.test(sha), 400, 'Unknown content.');
    ensure(await this.files.stageBlob(sha, openBytes(this.workspaceKey, sealed, `blob:${sha}`)), 400, 'File content did not match its hash.');
    return sealJson(this.workspaceKey, { stored: true }, 'blob-reply');
  }
  /** Only the home server renews rotating ChatGPT refresh tokens; linked engines ask it and receive the renewed bundle. */
  async refreshForPeer(session, sealed, providers) {
    this.hubEngine(session);
    const { connectionId } = openJson(this.workspaceKey, sealed, 'oauth-refresh');
    const connection = this.store.state.connections.find(item => item.id === connectionId && item.type === 'chatgpt');
    ensure(connection, 404, 'This ChatGPT connection is not on the home server yet.');
    await providers.oauth.bearer(connection);
    await this.scan();
    const key = `conn:${connectionId}`, entry = this.meta.docs[key];
    return sealJson(this.workspaceKey, { change: { k: key, v: this.wireValue(key, entry), h: entry.h, o: entry.o, ...(entry.b ? { b: entry.b } : {}) } }, 'oauth-refresh-reply');
  }

  // ---- Replica side ----
  /**
   * Engine-to-engine HTTP. An https:// engine must present its identity key (pinned from the pairing link) or, unless it
   * was linked with its own certificate, a publicly trusted one. Loopback and Tailscale addresses use plain fetch.
   */
  engineFetch(url, init = {}, pin = this.config.hub?.fingerprint, requirePin = this.config.hub?.tls === 'pinned') {
    if (this.options.syncFetch || !url.startsWith('https:')) return this.fetch(url, init);
    return this.transport.request(url, { ...init, pin, requirePin });
  }
  async request(route, { method = 'POST', body, aad, raw = false, signal } = {}) {
    const hub = this.config.hub;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.peer?.token || this.peer.tokenExpires < Date.now() + 60_000) await this.peerSession();
      const response = await this.engineFetch(`${hub.url}${route}`, { method, signal, headers: { Authorization: `Bearer ${this.peer.token}`, ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) }, ...(body ? { body } : {}) });
      if (response.status === 401 && attempt === 0) { this.peer.token = null; continue; }
      if (!response.ok) {
        let message = `Home server returned ${response.status}.`;
        try { message = (await response.json()).error || message; } catch {}
        throw Object.assign(new HttpError(response.status === 401 ? 401 : 502, message), { upstream: response.status });
      }
      const data = Buffer.from(await response.arrayBuffer());
      return raw ? openBytes(this.workspaceKey, data, aad) : openJson(this.workspaceKey, data, aad);
    }
  }
  async peerSession() {
    const hub = this.config.hub, timestamp = Date.now(), nonce = randomBytes(16).toString('base64url');
    const response = await this.engineFetch(`${hub.url}/api/device/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: hub.deviceId, timestamp, nonce, signature: signMessage(this.identity.privateKey, SESSION_MESSAGE(hub.deviceId, timestamp, nonce)) }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new HttpError(response.status === 401 ? 401 : 502, response.status === 401 ? 'The home server removed this engine. Link it again from the home server.' : result.error || 'The home server could not start a sync session.');
    this.peer.token = result.token; this.peer.tokenExpires = Date.parse(result.expiresAt);
  }
  startPeer() {
    if (this.peer || this.closed) return;
    this.peer = { stopped: false, controller: new AbortController(), token: null, tokenExpires: 0, wake: null };
    const listener = () => this.peer?.wake?.();
    this.listeners.add(listener); this.peer.listener = listener;
    this.peer.loops = Promise.allSettled([this.pullLoop(this.peer), this.pushLoop(this.peer)]);
  }
  async stopPeer() {
    const peer = this.peer;
    if (!peer) return;
    peer.stopped = true; peer.controller.abort(); peer.wake?.(); this.listeners.delete(peer.listener);
    await peer.loops; this.peer = null;
    this.peerStatus = { ...this.peerStatus, connected: false };
  }
  async pullLoop(peer) {
    let backoff = 1000;
    while (!peer.stopped) {
      try {
        const reply = await this.request('/api/sync/exchange', { body: sealJson(this.workspaceKey, { node: this.nodeId, since: this.meta.cursor, wait: this.options.longPollMs ?? LONG_POLL_MS }, 'exchange'), aad: 'exchange-reply', signal: peer.controller.signal });
        ensure(reply?.node === this.config.hub.nodeId && Array.isArray(reply.changes), 502, 'The home server sent an unexpected sync reply.');
        for (const change of reply.changes) if (change?.k?.startsWith?.('file:') && change.v && /^[0-9a-f]{64}$/.test(change.v.sha) && !(await this.files.hasBlob(change.v.sha))) {
          const data = await this.request(`/api/sync/blobs/${change.v.sha}`, { method: 'GET', aad: `blob:${change.v.sha}`, raw: true, signal: peer.controller.signal });
          ensure(await this.files.stageBlob(change.v.sha, data), 502, 'A synced file did not match its hash.');
        }
        await this.applyRemote(reply.changes, { label: this.config.hub.name });
        this.meta.cursor = reply.seq; this.saveMetaSoon();
        this.peerStatus = { ...this.peerStatus, connected: true, lastSyncAt: now(), error: null };
        backoff = 1000;
      } catch (error) {
        if (peer.stopped) break;
        this.peerStatus = { ...this.peerStatus, connected: false, error: this.store.redact(error.message || 'Home server unreachable.') };
        await pause(backoff, peer.controller.signal); backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }
  async pushLoop(peer) {
    let backoff = 1000;
    while (!peer.stopped) {
      const pending = Object.entries(this.meta.docs).filter(([, entry]) => entry.s > this.meta.pushed && !entry.r).sort((a, b) => a[1].s - b[1].s);
      if (!pending.length) {
        const upto = this.meta.seq;
        if (this.meta.pushed < upto) { this.meta.pushed = upto; this.saveMetaSoon(); }
        await new Promise(resolve => { peer.wake = resolve; setTimeout(resolve, 15_000).unref?.(); });
        peer.wake = null; continue;
      }
      try {
        this.peerStatus.pushing = true;
        const batch = pending.slice(0, BATCH_CHANGES), changes = [];
        for (const [key, entry] of batch) {
          const value = this.wireValue(key, entry);
          if (key.startsWith('file:') && value) {
            const data = await this.files.readBlob(value.sha);
            if (!data) continue;
            await this.request(`/api/sync/blobs/${value.sha}`, { method: 'PUT', body: sealBytes(this.workspaceKey, data, `blob:${value.sha}`), aad: 'blob-reply', signal: peer.controller.signal });
          }
          changes.push({ k: key, v: value, h: entry.h, o: entry.o, ...(entry.b ? { b: entry.b } : {}) });
        }
        await this.request('/api/sync/exchange', { body: sealJson(this.workspaceKey, { node: this.nodeId, push: changes }, 'exchange'), aad: 'exchange-reply', signal: peer.controller.signal });
        this.meta.pushed = Math.max(this.meta.pushed, batch.at(-1)[1].s); this.saveMetaSoon();
        this.peerStatus = { ...this.peerStatus, pushing: false, lastSyncAt: now(), error: null };
        backoff = 1000;
      } catch (error) {
        this.peerStatus.pushing = false;
        if (peer.stopped) break;
        this.peerStatus = { ...this.peerStatus, error: this.store.redact(error.message || 'Home server unreachable.') };
        await pause(backoff, peer.controller.signal); backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }
  async delegateRefresh(connectionId) {
    ensure(this.peer, 503, 'ChatGPT access is renewed by your home server, which is unreachable. Reconnect and try again.');
    const reply = await this.request('/api/sync/oauth-refresh', { body: sealJson(this.workspaceKey, { connectionId }, 'oauth-refresh'), aad: 'oauth-refresh-reply' });
    await this.applyRemote([reply.change], { label: this.config.hub.name });
  }

  /** Links this engine to a home server with an engine pairing link created there. */
  async connect(link) {
    const info = parsePairingLink(link);
    ensure(info.kind === 'engine', 400, 'This link pairs an app. On the home server, choose “Link another engine”.');
    ensure(!this.config.hub, 409, 'Disconnect from the current home server first.');
    ensure(this.role() !== 'hub', 409, 'Other engines sync through this one. Unlink them before making it sync elsewhere.');
    const url = validateEngineUrl(info.url);
    ensure(/^[A-Za-z0-9_-]{20,200}$/.test(info.code) && /^[A-Za-z0-9_-]{43}$/.test(info.fingerprint), 400, 'This pairing link is incomplete. Copy it again.');
    let engine, trust;const requirePin = info.tls === 'engine';
    try { const response = await this.engineFetch(`${url}/api/engine`, {}, info.fingerprint, requirePin); trust = response.trust; engine = await response.json(); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, `Can’t reach ${url}. Check the address and that the server is running.`); }
    ensure(engine?.product === 'hermes-studio' && engine.fingerprint === info.fingerprint && fingerprint(engine.publicKey || '') === info.fingerprint, 502, 'The server’s identity does not match the pairing link. Nothing was shared.');
    ensure(engine.nodeId !== this.nodeId, 400, 'This link belongs to this same engine.');
    const response = await this.engineFetch(`${url}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code: info.code, kind: 'engine', name: this.identity.name, platform: 'engine', nodeId: this.nodeId, publicKey: this.identity.publicKey, proof: signMessage(this.identity.privateKey, PAIR_MESSAGE(info.code, this.identity.publicKey)) }) }, info.fingerprint, requirePin || trust === 'pinned');
    const result = await response.json().catch(() => ({}));
    ensure(response.ok, response.status === 429 ? 429 : 400, result.error || 'The home server refused this link.');
    ensure(result.engine?.fingerprint === info.fingerprint && verifyMessage(engine.publicKey, PAIRED_MESSAGE(result.deviceId, this.identity.publicKey), result.engineProof), 502, 'The home server could not prove its identity. Nothing was shared.');
    const workspaceKey = unwrapWorkspaceKey(info.code, this.nodeId, result.workspaceKey);
    await atomicWrite(path.join(this.directory, 'workspace.key'), workspaceKey);
    this.workspaceKey = workspaceKey;
    // A home server that proved itself with its own key must keep doing so; a public certificate is not accepted instead.
    this.config = { hub: { url, deviceId: result.deviceId, nodeId: result.engine.nodeId, name: result.engine.name, fingerprint: info.fingerprint, publicKey: engine.publicKey, ...(trust === 'pinned' ? { tls: 'pinned' } : {}), connectedAt: now() } };
    this.meta.cursor = 0; this.meta.pushed = 0;
    await this.saveConfig(); await this.saveMeta();
    this.peerStatus = { connected: false, lastSyncAt: null, error: null, pushing: false };
    this.startPeer();
    return this.status();
  }
  async disconnect() {
    ensure(this.config.hub, 409, 'This engine is not syncing with a home server.');
    await this.stopPeer();
    this.transport.close();
    // A fresh key means data from the old workspace can no longer be read by it, and this engine can become a hub itself.
    this.workspaceKey = randomBytes(32);
    await atomicWrite(path.join(this.directory, 'workspace.key'), this.workspaceKey);
    this.config = { hub: null }; await this.saveConfig();
    return this.status();
  }
  async rename(name) {
    const value = String(name || '').trim();
    ensure(value.length >= 1 && value.length <= 60 && !/[\x00-\x1f\x7f]/.test(value), 400, 'Engine name must contain 1–60 characters.');
    this.identity.name = value;
    const file = path.join(this.directory, 'identity.json'), stored = JSON.parse(await fs.readFile(file, 'utf8'));
    await atomicWrite(file, JSON.stringify({ ...stored, name: value }, null, 2));
    this.schedule(0);
    return this.status();
  }
  engines() {
    return Object.entries(this.store.state.presence || {}).filter(([node]) => node !== this.nodeId).map(([nodeId, presence]) => {
      const wall = parseStamp(this.meta.docs[`presence:${nodeId}`]?.h)?.wall || 0, seen = this.online.get(nodeId);
      return { nodeId, name: presence?.name || 'Engine', role: presence?.role || 'replica', url: presence?.url || '', online: seen ? Date.now() - Date.parse(seen) < 60_000 : nodeId === this.config.hub?.nodeId ? this.peerStatus.connected : false, lastSeenAt: seen || (wall ? new Date(wall).toISOString() : null), busy: Object.keys(presence?.active || {}) };
    });
  }
  /** Compact view for every client state poll: which engine this is and which bots are busy elsewhere. */
  summary() {
    const hub = this.config.hub, busy = {};
    for (const engine of this.engines()) for (const botId of engine.busy) busy[botId] = engine.name;
    return { node: { id: this.nodeId, name: this.identity.name, role: this.role() }, hub: hub ? { name: hub.name, url: hub.url, connected: this.peerStatus.connected, error: this.peerStatus.error } : null, engines: this.engines().map(({ busy: _, ...engine }) => engine), busy };
  }
  status() {
    const role = this.role(), hub = this.config.hub;
    const pending = hub ? Object.values(this.meta.docs).filter(entry => entry.s > this.meta.pushed && !entry.r).length : 0;
    return {
      node: { id: this.nodeId, name: this.identity.name, role, fingerprint: this.identity.fingerprint, url: this.options.publicUrl || '', automation: this.runsAutomation() },
      hub: hub ? { url: hub.url, name: hub.name, nodeId: hub.nodeId, fingerprint: hub.fingerprint, connected: this.peerStatus.connected, lastSyncAt: this.peerStatus.lastSyncAt, error: this.peerStatus.error, connectedAt: hub.connectedAt } : null,
      engines: this.engines(), pending, documents: Object.values(this.meta.docs).filter(entry => entry.d !== null).length,
      skippedFiles: this.files.skipped.slice(0, 20)
    };
  }
  async close() {
    this.closed = true;
    clearTimeout(this.scanTimer); clearInterval(this.heartbeat); clearInterval(this.periodic);
    await this.stopPeer();
    this.transport.close();
    for (const resolve of this.waiters) resolve();
    this.files.close();
    clearTimeout(this.metaTimer); this.metaTimer = null;
    await this.saveMeta().catch(() => {});
  }
}
