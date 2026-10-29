import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes,createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicWrite, ensure, HttpError, now } from '../store.mjs';
import { Clock, GENESIS, compareStamps, parseStamp } from './clock.mjs';
import { listDocuments, readDocument, writeDocument, parseKey, botOf, kindOf } from './docs.mjs';
import { FileReplica } from './files.mjs';
import { Devices } from './devices.mjs';
import { EngineTransport } from './transport.mjs';
import { SyncSecurity } from './security.mjs';
import { digest, fingerprint, generateIdentity, sealBytes, openBytes, sealJson, openJson, signMessage, verifyMessage, wrapWorkspaceKey, unwrapWorkspaceKey, ENGINE_PAIR_MESSAGE, ENGINE_PAIR_CONTEXT, WRAPPED_KEY_PROOF, SYNC_KEY_CONTEXT, SESSION_MESSAGE, SESSION_REVOKED_MESSAGE, keyId } from './crypto.mjs';

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
const isActiveRun = run => !!run && ['queued', 'running', 'waiting_for_approval','waiting_for_input','waiting_for_delegate', 'stopping'].includes(run.status);

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
  try { url = new URL(String(link).trim()); } catch { throw new HttpError(400, 'Paste the complete engine link from your home server’s Devices & sync.'); }
  ensure(url.protocol === 'hermes-studio:' && (url.hostname === 'pair' || url.pathname.replace(/^\/+/, '') === 'pair'), 400, 'Paste the complete engine link from your home server’s Devices & sync.');
  const value = key => url.searchParams.get(key) || '';
  ensure(value('kind')==='engine'?value('v')==='2':value('v')==='1',426,'Update both engines and create a new engine link. Legacy engine pairing is no longer accepted.');
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
    this.securityQueue=Promise.resolve();this.configQueue=Promise.resolve();
    this.peerStatus = { connected: false, lastSyncAt: null, error: null, pushing: false };
    this.locallyActive = options.locallyActive || (botId => isActiveRun(this.store.state.runs?.[botId]));
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const read = async name => { try { return JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
    let identity = await read('identity.json');
    const createdIdentity=!identity;
    if (!identity) {
      const existing=await fs.readdir(this.directory);ensure(!existing.some(name=>['config.json','meta.json','workspace.key','security.json'].includes(name)),500,'The engine identity is missing. Restore the complete runtime backup; do not reset engine keys.');
      const created = generateIdentity();
      identity = { nodeId: `node_${randomBytes(9).toString('hex')}`, name: this.options.engineName || process.env.STUDIO_ENGINE_NAME || defaultEngineName(), publicKey: created.publicKey, privateKey: this.store.seal(created.privateKey), securityProtocol:2, createdAt: now() };
      await atomicWrite(path.join(this.directory, 'identity.json'), JSON.stringify(identity, null, 2));
    }
    this.identity = { ...identity, privateKey: this.store.unseal(identity.privateKey), fingerprint: fingerprint(identity.publicKey) };
    this.nodeId = identity.nodeId;
    const keyFile = path.join(this.directory, 'workspace.key');
    let legacyKey;try { legacyKey=await fs.readFile(keyFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.config = (await read('config.json')) || { hub: null };
    this.security=await new SyncSecurity(this.store,this.directory).init({identity,createdIdentity,legacyKey,existingSecurePeers:(this.store.state.devices || []).some(device=>device.kind==='engine'&&device.protocolVersion===2)});
    Object.defineProperty(this,'workspaceKey',{get:()=>this.security.key});
    if(identity.securityProtocol!==2){identity.securityProtocol=2;this.identity.securityProtocol=2;await atomicWrite(path.join(this.directory,'identity.json'),JSON.stringify(identity,null,2));}
    await this.store.mutate(state=>{for(const device of state.devices || [])if(this.security.record.revoked[device.id])device.revokedAt ||= this.security.record.revoked[device.id];});
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
    if(this.config.hub?.protocol!==2&&this.config.hub)this.peerStatus.error='Update both engines, then disconnect and re-link with a new secure engine link. Your local workspace is preserved.';
    else if (this.config.hub) this.startPeer();
    return this;
  }

  role() {
    if (this.config.hub) return 'replica';
    return (this.store.state.devices || []).some(device => device.kind === 'engine' && !device.revokedAt && device.pairedVia === this.nodeId) ? 'hub' : 'standalone';
  }
  /** Unlinking never silently promotes a copied schedule or channel to a second automation owner. */
  runsAutomation() { return !this.topologyChanging && this.role() !== 'replica' && !this.config.automationSuspended; }
  assertAdmission() { ensure(!this.topologyChanging,409,'This engine is changing its sync connection. Wait for it to finish before starting work.'); }
  assertIdle() {
    ensure(!this.store.state.bots.some(bot=>this.locallyActive(bot.id)) && !Object.values(this.store.state.roomDrives || {}).some(drive=>['queued','running','stopping'].includes(drive.status)) && !this.options.linkBusy?.(),409,'Wait for active tasks, conversation summaries and credential renewals to finish before changing this engine’s sync connection.');
  }
  async changeTopology(operation) {
    this.assertAdmission();this.topologyChanging=true;
    try { this.assertIdle();await this.prepareLinkChange?.();this.assertIdle();return await operation(); }
    finally { this.topologyChanging=false; }
  }
  oauthAccess(connection) { return this.config.detachedOAuth?.includes(connection.id) ? 'This ChatGPT authorization belongs to the former home server. Re-link to that same home server or complete a fresh ChatGPT sign-in here before using it. Enabling routines does not transfer that authorization.' : null; }
  async authorizeOAuth(connectionId) {
    this.assertAdmission();
    if(!this.config.detachedOAuth?.includes(connectionId))return;
    const previous=this.config,homes={...previous.detachedOAuthHomes};delete homes[connectionId];const next={...previous,detachedOAuth:previous.detachedOAuth.filter(id=>id!==connectionId),detachedOAuthHomes:homes};this.config=next;
    try { await this.saveConfig(); } catch(error) { if(this.config===next)this.config=previous;throw error; }
  }
  async enableAutomation(input) {
    ensure(input?.enabled===true && input?.confirm===true,400,'Explicitly confirm that this engine should run its configured routines and messaging channels.');
    await this.changeTopology(async()=>{
      ensure(!this.config.hub,409,'Routines and messaging channels run on the home server while this engine is linked.');
      const previous=this.config;this.config={...previous,automationSuspended:false};
      try { await this.saveConfig(); } catch(error) { this.config=previous;throw error; }
    });
    return this.status();
  }
  activeBots() { return Object.entries(this.store.state.runs || {}).filter(([, run]) => isActiveRun(run)).map(([botId]) => botId); }
  presence() {
    const active = Object.fromEntries(Object.entries(this.store.state.runs || {}).filter(([, run]) => isActiveRun(run)).map(([botId, run]) => [botId, { runId: run.id, since: run.createdAt }]));
    return { name: this.identity.name, role: this.role(), url: this.options.publicUrl || '', active, ...(Object.keys(active).length ? { beat: Math.floor(Date.now() / PRESENCE_BEAT_MS) } : {}) };
  }
  /** Another engine that is working with this bot right now, from its replicated presence. */
  busyElsewhere(botId) {
    if(this.role()==='standalone')return null;
    for (const [node, presence] of Object.entries(this.store.state.presence || {})) {
      if (node === this.nodeId || this.revokedNode(node)||!presence?.active?.[botId]) continue;
      const wall = parseStamp(this.meta.docs[`presence:${node}`]?.h)?.wall || 0;
      if (Date.now() - wall < PRESENCE_STALE_MS) return { nodeId: node, name: typeof presence.name === 'string' && presence.name ? presence.name.slice(0, 80) : 'another engine' };
    }
    return null;
  }

  documents() {
    const docs = listDocuments(this.store.state, this.store);
    for (const key of [...docs.keys()]) if (key.startsWith('presence:')) docs.delete(key);
    for (const [node, presence] of Object.entries(this.store.state.presence || {})) if (node !== this.nodeId && SAFE_ID.test(node)&&!this.revokedNode(node)) docs.set(`presence:${node}`, presence);
    docs.set(`presence:${this.nodeId}`, this.presence());
    return docs;
  }
  wireValue(key, entry) {
    if (entry.d === null) return null;
    if (key.startsWith('file:')) return { sha: entry.d, size: entry.z || 0 };
    if (key === `presence:${this.nodeId}`) return this.presence();
    const value=readDocument(this.store.state,key,this.store,'wire') ?? null;
    // A different workspace may receive connection settings, but never a rotating grant still owned by a former hub.
    // The existing secret-object convention preserves the receiver's own credential without carrying this one.
    if(value && key.startsWith('conn:') && this.config.detachedOAuth?.includes(value.id))return {...value,oauthSecret:{$withheld:true}};
    return value;
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
  saveConfig() { const bytes=JSON.stringify(this.config,null,2),operation=this.configQueue.then(()=>atomicWrite(path.join(this.directory,'config.json'),bytes));this.configQueue=operation.catch(()=>{});return operation; }
  revokedNode(node){return !!this.security.record.revokedNodes?.[node]&&!Object.values(this.security.record.grants).some(grant=>grant.nodeId===node);}
  securityOperation(operation){const pending=this.securityQueue.then(operation);this.securityQueue=pending.catch(()=>{});return pending;}
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
    if (stateChanges.length) await this.store.mutate(async state => {
      this.scanState();
      for (let change of stateChanges) {
        const incomingRevoked=!!change?.v?.revokedAt;
        if (!this.validChange(change) || change.k === `presence:${this.nodeId}`) continue;
        if(kindOf(change.k)==='presence'&&this.revokedNode(parseKey(change.k).id))continue;
        const local = this.meta.docs[change.k];
        if (local && compareStamps(local.h, change.h) >= 0) continue;
        const botId = botOf(change.k);
        if (botId && this.locallyActive(botId)) { this.deferred.set(change.k, { change, label }); continue; }
        if(kindOf(change.k)==='device'){
          const deviceId=parseKey(change.k).id,grant=this.security.record.grants[deviceId];
          const previousDevice=state.devices?.find(device=>device.id===deviceId);
          const grantInvalid=grant&&(change.v===null||change.v.revokedAt||change.v.kind!=='engine'||change.v.nodeId!==grant.nodeId||change.v.publicKey!==grant.publicKey||change.v.fingerprint!==grant.fingerprint||change.v.protocolVersion!==2);
          const newRevocation=!this.security.record.revoked[deviceId]&&(change.v?.revokedAt||previousDevice?.revokedAt);
          if(grantInvalid||newRevocation)await this.security.revoke([deviceId],{at:change.v?.revokedAt || previousDevice?.revokedAt});
          if(change.v&&this.security.record.revoked[deviceId])change={...change,v:{...change.v,revokedAt:this.security.record.revoked[deviceId]}};
        }
        if (!writeDocument(state, change.k, change.v, this.store)) continue;
        const after = change.v === null ? undefined : readDocument(state, change.k, this.store);
        if (!previous.has(change.k)) previous.set(change.k, this.meta.docs[change.k]);
        this.clock.observe(change.h);
        // A device kept revoked over a newer remote edit is restamped here, so the revocation wins on every engine.
        if (kindOf(change.k) === 'device' && after?.revokedAt && !incomingRevoked) this.record(change.k, digest(JSON.stringify(after)));
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
    // Only the engine where the newer version lands keeps the older one as a conflict copy, so each conflict yields one copy.
    if (local && compareStamps(local.h, change.h) >= 0) return false;
    // Watchers/rescans can lag behind an owner/editor. Inspect the actual current bytes rather than assuming
    // the last advertised hash still describes the file we are about to replace.
    const current=await this.files.readKey(change.k),currentSha=current===null?null:createHash('sha256').update(current).digest('hex');
    const unscanned=currentSha!==(local?.d ?? null),concurrent=unscanned || local && local.d!==null && change.b!==local.h && change.v?.sha!==local.d;
    if (change.v === null && concurrent) { await this.store.serialize(() => this.record(change.k,currentSha,null,current===null?{}:{z:current.length}));return false; }
    let copied=false;
    if(concurrent && current!==null && currentSha!==change.v?.sha){
      ensure(await this.files.conflictCopy(change.k,current,unscanned?this.identity.name:this.nodeName(local.o)),503,'A local file conflict could not be preserved. Sync will retry without replacing it.');copied=true;this.fileEpoch++;
    }
    try{
      ensure(await this.files.apply(change.k,change.v,{expectedCurrentSha:currentSha}),503,'A synced file could not be applied. Its document and sync cursor were not acknowledged; sync will retry.');
    }catch(error){if(copied)this.schedule(0);throw error;}
    this.fileEpoch++;
    await this.store.serialize(() => { this.meta.docs[change.k] = { h: change.h, s: ++this.meta.seq, d: change.v?.sha ?? null, o: change.o, ...(change.b ? { b: change.b } : {}), ...(change.v ? { z: change.v.size } : {}), r: 1 }; this.clock.observe(change.h); });
    if(copied)this.schedule(0);
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
    const current=this.devices.find(session.device.id);ensure(current&&current.kind==='engine'&&current.nodeId===session.device.nodeId,401,'This engine was removed or its secure grant changed. Re-link it explicitly.');return current;
  }
  assertEpoch(epoch){ensure(Number.isSafeInteger(epoch)&&epoch===this.security.record.epoch,409,'The workspace sync key changed. Obtain the current key with a fresh signed session.');}
  /** Hub side of one exchange: apply what the engine pushed, then return what it has not seen, waiting briefly if nothing is new. */
  async exchange(session, sealed, signal,epoch) {
    const {request,device,result}=await this.securityOperation(async()=>{
      const device=this.hubEngine(session);this.assertEpoch(epoch);const request=openJson(this.workspaceKey,sealed,'exchange');ensure(request?.node===device.nodeId,403,'This sync request came from a different engine.');this.online.set(device.nodeId,now());
      if(Array.isArray(request.push)&&request.push.length){ensure(request.push.length<=2000,413,'Push fewer changes at once.');for(const change of request.push)if(change?.k?.startsWith?.('file:')&&change.v)ensure(await this.files.hasBlob(change.v.sha),409,'Upload file contents before their changes.');await this.applyRemote(request.push,{label:device.name});}
      await this.store.serialize(()=>this.scanState());return {request,device,result:Number.isSafeInteger(request.since)?this.changesSince(request.since,device.nodeId):{seq:this.meta.seq,changes:[],more:false}};
    });
    const wait=Math.min(Math.max(Number(request.wait)||0,0),LONG_POLL_MS);if(!result.changes.length&&!result.more&&wait)await this.waitForChange(wait,signal);
    return this.securityOperation(()=>{this.hubEngine(session);this.assertEpoch(epoch);this.online.set(device.nodeId,now());return sealJson(this.workspaceKey,{node:this.nodeId,...(Number.isSafeInteger(request.since)?this.changesSince(request.since,device.nodeId):result)},'exchange-reply');});
  }
  async blobForPeer(session, sha,epoch) {return this.securityOperation(async()=>{
    this.hubEngine(session);this.assertEpoch(epoch);
    ensure(/^[0-9a-f]{64}$/.test(sha), 400, 'Unknown content.');
    const data = await this.files.readBlob(sha);
    ensure(data, 404, 'This file content changed. Sync again.');
    return sealBytes(this.workspaceKey, data, `blob:${sha}`);
  });}
  async receiveBlob(session, sha, sealed,epoch) {return this.securityOperation(async()=>{
    this.hubEngine(session);this.assertEpoch(epoch);
    ensure(/^[0-9a-f]{64}$/.test(sha), 400, 'Unknown content.');
    ensure(await this.files.stageBlob(sha, openBytes(this.workspaceKey, sealed, `blob:${sha}`)), 400, 'File content did not match its hash.');
    return sealJson(this.workspaceKey, { stored: true }, 'blob-reply');
  });}
  /** Only the home server renews rotating ChatGPT refresh tokens; linked engines ask it and receive the renewed bundle. */
  async refreshForPeer(session, sealed, providers,epoch) {
    const {connectionId}=await this.securityOperation(()=>{this.hubEngine(session);this.assertEpoch(epoch);return openJson(this.workspaceKey,sealed,'oauth-refresh');});
    const connection = this.store.state.connections.find(item => item.id === connectionId && item.type === 'chatgpt');
    ensure(connection, 404, 'This ChatGPT connection is not on the home server yet.');
    await providers.oauth.bearer(connection);
    await this.scan();
    const key = `conn:${connectionId}`, entry = this.meta.docs[key];
    return this.securityOperation(()=>{this.hubEngine(session);this.assertEpoch(epoch);return sealJson(this.workspaceKey,{change:{k:key,v:this.wireValue(key,entry),h:entry.h,o:entry.o,...(entry.b?{b:entry.b}:{})}},'oauth-refresh-reply');});
  }
  keyForPeer(session,input){return this.securityOperation(()=>{
    const device=this.hubEngine(session);ensure(input?.v===2&&input.engineNodeId===this.nodeId&&input.engineFingerprint===this.identity.fingerprint&&/^[A-Za-z0-9_-]{16,100}$/.test(input.nonce),400,'Use a fresh target-bound version 2 key request.');
    const record=this.security.record,value={v:2,hubNodeId:this.nodeId,hubFingerprint:this.identity.fingerprint,deviceId:device.id,nodeId:device.nodeId,fingerprint:device.fingerprint,workspaceId:record.workspaceId,epoch:record.epoch,keyId:record.keyId,nonce:input.nonce},context=SYNC_KEY_CONTEXT(value),wrapped=wrapWorkspaceKey(this.identity.privateKey,device.publicKey,context,this.workspaceKey);
    return {...value,wrapped,proof:signMessage(this.identity.privateKey,WRAPPED_KEY_PROOF(context,wrapped))};
  });}

  // ---- Replica side ----
  /**
   * Engine-to-engine HTTP. An https:// engine must present its identity key (pinned from the pairing link) or, unless it
   * was linked with its own certificate, a publicly trusted one. Loopback and Tailscale addresses use plain fetch.
   */
  engineFetch(url, init = {}, pin = this.config.hub?.fingerprint, requirePin = this.config.hub?.tls === 'pinned') {
    ensure(!requirePin||url.startsWith('https:'),400,'This engine link requires HTTPS and its pinned identity. Nothing was sent.');
    const timeout=AbortSignal.timeout(this.options.syncRequestTimeout || 30_000),signal=init.signal?AbortSignal.any([init.signal,timeout]):timeout,request={...init,signal,redirect:'manual'};
    if (this.options.syncFetch || !url.startsWith('https:')) return this.fetch(url,request);
    return this.transport.request(url, { ...request, pin, requirePin });
  }
  async request(route, { method = 'POST', body, aad, raw = false, signal } = {}) {
    const hub = this.config.hub;
    ensure(hub?.protocol===2,426,'Update both engines and re-link using a new secure engine link.');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.peer?.token || this.peer.tokenExpires < Date.now() + 60_000) await this.peerSession();
      const key=this.workspaceKey,epoch=this.security.record.epoch;
      const response = await this.engineFetch(`${hub.url}${route}`, { method, signal, headers: { Authorization: `Bearer ${this.peer.token}`,'X-Tupies-Sync-Version':'2','X-Tupies-Key-Epoch':String(epoch), ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) }, ...(body ? { body:typeof body==='function'?body():body } : {}) });
      if (response.status === 401 && attempt <2) { this.peer.token = null; continue; }
      if(response.status===409&&attempt<2){await this.refreshWorkspaceKey();continue;}
      if (!response.ok) {
        let message = `Home server returned ${response.status}.`;
        try { message = (await response.json()).error || message; } catch {}
        throw Object.assign(new HttpError(response.status === 401 ? 401 : 502, message), { upstream: response.status });
      }
      const data = Buffer.from(await response.arrayBuffer());
      return raw ? openBytes(key, data, aad) : openJson(key, data, aad);
    }
  }
  async peerSession() {
    const hub = this.config.hub, timestamp = Date.now(), nonce = randomBytes(16).toString('base64url');
    ensure(hub?.protocol===2,426,'Update both engines and re-link using a new secure engine link.');
    const response = await this.engineFetch(`${hub.url}/api/device/session`, { method: 'POST',signal:this.peer?.controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({v:2,engineNodeId:hub.nodeId,engineFingerprint:hub.fingerprint, deviceId: hub.deviceId, timestamp, nonce, signature: signMessage(this.identity.privateKey, SESSION_MESSAGE(hub.nodeId,hub.fingerprint,hub.deviceId,timestamp,nonce)) }) });
    const result = await response.json().catch(() => ({}));
    if(response.status===401 && result.code==='engine_revoked'){
      const value=result.revocation;
      ensure(value?.v===2&&value.engineNodeId===hub.nodeId&&value.engineFingerprint===hub.fingerprint&&value.deviceId===hub.deviceId&&value.nodeId===this.nodeId&&value.fingerprint===this.identity.fingerprint&&value.timestamp===timestamp&&value.nonce===nonce&&typeof value.revokedAt==='string'&&Number.isFinite(Date.parse(value.revokedAt))&&Date.parse(value.revokedAt)<=Date.now()+5*60_000&&Math.abs(Date.now()-timestamp)<=5*60_000&&verifyMessage(hub.publicKey,SESSION_REVOKED_MESSAGE(value),value.proof),401,'The home server did not authenticate this engine’s revocation. The local link remains intact.');
      throw Object.assign(new HttpError(401,'The home server durably removed this exact engine grant.'),{code:'engine_revoked_verified'});
    }
    if (!response.ok) throw new HttpError(response.status === 401 ? 401 : 502, response.status === 401 ? 'The home server removed this engine. Link it again from the home server.' : result.error || 'The home server could not start a sync session.');
    this.peer.token = result.token; this.peer.tokenExpires = Date.parse(result.expiresAt);
    await this.refreshWorkspaceKey();
  }
  async refreshWorkspaceKey(){
    if(this.keyRecovery)return this.keyRecovery;
    const operation=(async()=>{
      const hub=this.config.hub,nonce=randomBytes(24).toString('base64url'),response=await this.engineFetch(`${hub.url}/api/sync/key`,{method:'POST',signal:this.peer?.controller.signal,headers:{Authorization:`Bearer ${this.peer.token}`,'Content-Type':'application/json','X-Tupies-Sync-Version':'2'},body:JSON.stringify({v:2,engineNodeId:hub.nodeId,engineFingerprint:hub.fingerprint,nonce})}),result=await response.json().catch(()=>({}));
      ensure(response.ok,response.status===401?401:502,result.error || 'The home server could not provide the current sync key.');
      ensure(result.v===2&&result.hubNodeId===hub.nodeId&&result.hubFingerprint===hub.fingerprint&&result.deviceId===hub.deviceId&&result.nodeId===this.nodeId&&result.fingerprint===this.identity.fingerprint&&result.nonce===nonce&&result.workspaceId===hub.workspaceId,502,'The sync-key response targets a different engine, request or workspace.');
      const context=SYNC_KEY_CONTEXT(result);ensure(verifyMessage(hub.publicKey,WRAPPED_KEY_PROOF(context,result.wrapped),result.proof),502,'The home server could not authenticate the sync-key response.');
      const key=unwrapWorkspaceKey(this.identity.privateKey,hub.publicKey,context,result.wrapped);await this.security.adopt(result,key);
    })();this.keyRecovery=operation;try{return await operation;}finally{if(this.keyRecovery===operation)this.keyRecovery=null;}
  }
  revokeForPeer(session,input){return this.securityOperation(()=>{this.hubEngine(session);ensure(this.devices.active().some(device=>device.id===input?.deviceId&&device.kind==='engine'),404,'Engine not found.');return this.devices.revokeAuthorized(input.deviceId);});}
  async revokeEngineRemotely(deviceId){
    ensure(this.config.hub?.protocol===2&&this.peer,503,'Reconnect to the updated home server before removing an engine.');
    if(!this.peer.token||this.peer.tokenExpires<Date.now()+60_000)await this.peerSession();
    let response,result;for(let attempt=0;attempt<2;attempt++){
      response=await this.engineFetch(`${this.config.hub.url}/api/sync/revoke-engine`,{method:'POST',headers:{Authorization:`Bearer ${this.peer.token}`,'Content-Type':'application/json','X-Tupies-Sync-Version':'2'},body:JSON.stringify({deviceId})});result=await response.json().catch(()=>({}));
      if(response.status!==401 || attempt)break;await this.peerSession();
    }
    ensure(response.ok,response.status===401?401:502,result.error || 'The home server could not remove this engine. No local-only removal was recorded.');
    await this.store.mutate(state=>{const device=state.devices.find(item=>item.id===deviceId);if(device){device.revokedAt ||= now();delete state.presence?.[device.nodeId];}});return result;
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
        const reply = await this.request('/api/sync/exchange', { body: ()=>sealJson(this.workspaceKey, { node: this.nodeId, since: this.meta.cursor, wait: this.options.longPollMs ?? LONG_POLL_MS }, 'exchange'), aad: 'exchange-reply', signal: peer.controller.signal });
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
            await this.request(`/api/sync/blobs/${value.sha}`, { method: 'PUT', body: ()=>sealBytes(this.workspaceKey, data, `blob:${value.sha}`), aad: 'blob-reply', signal: peer.controller.signal });
          }
          changes.push({ k: key, v: value, h: entry.h, o: entry.o, ...(entry.b ? { b: entry.b } : {}) });
        }
        await this.request('/api/sync/exchange', { body: ()=>sealJson(this.workspaceKey, { node: this.nodeId, push: changes }, 'exchange'), aad: 'exchange-reply', signal: peer.controller.signal });
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
    const reply = await this.request('/api/sync/oauth-refresh', { body: ()=>sealJson(this.workspaceKey, { connectionId }, 'oauth-refresh'), aad: 'oauth-refresh-reply' });
    await this.applyRemote([reply.change], { label: this.config.hub.name });
  }

  /** Links this engine to a home server with an engine pairing link created there. */
  connect(link) { return this.changeTopology(()=>this.connectIdle(link)); }
  async connectIdle(link) {
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
    ensure(engine.protocols?.enginePairing===2&&engine.protocols?.deviceSession===2&&engine.protocols?.sync===2,426,'Update both engines before linking. Secure engine pairing and sync protocol version 2 are required.');
    ensure(engine.nodeId !== this.nodeId, 400, 'This link belongs to this same engine.');
    const ephemeral=generateIdentity();
    const response = await this.engineFetch(`${url}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 2, code: info.code, kind: 'engine', name: this.identity.name, platform: 'engine',hubNodeId:engine.nodeId,hubFingerprint:info.fingerprint, nodeId: this.nodeId, publicKey: this.identity.publicKey,ephemeralKey:ephemeral.publicKey, proof: signMessage(this.identity.privateKey, ENGINE_PAIR_MESSAGE(info.code,engine.nodeId,info.fingerprint,this.nodeId,this.identity.publicKey,ephemeral.publicKey)) }) }, info.fingerprint, requirePin || trust === 'pinned');
    const result = await response.json().catch(() => ({}));
    ensure(response.ok, response.status === 429 ? 429 : 400, result.error || 'The home server refused this link.');
    const context=ENGINE_PAIR_CONTEXT({code:info.code,hubNodeId:engine.nodeId,hubFingerprint:info.fingerprint,nodeId:this.nodeId,publicKey:this.identity.publicKey,ephemeralKey:ephemeral.publicKey,engineEphemeralKey:result.ephemeralKey,deviceId:result.deviceId,workspaceId:result.workspaceId,epoch:result.epoch,keyId:result.keyId});
    ensure(result.v===2&&result.engine?.nodeId===engine.nodeId&&result.engine?.publicKey===engine.publicKey&&result.engine?.fingerprint === info.fingerprint && verifyMessage(engine.publicKey,WRAPPED_KEY_PROOF(context,result.workspaceKey),result.engineProof),502,'The home server could not prove its secure pairing transcript. Nothing was shared.');
    const workspaceKey = unwrapWorkspaceKey(ephemeral.privateKey,result.ephemeralKey,context,result.workspaceKey);
    await this.security.adopt(result,workspaceKey,{allowNewWorkspace:true});
    // A home server that proved itself with its own key must keep doing so; a public certificate is not accepted instead.
    const detachedOAuth=(this.config.detachedOAuth || []).filter(id=>{const owner=this.config.detachedOAuthHomes?.[id];return owner?.nodeId!==engine.nodeId || owner?.fingerprint!==info.fingerprint;});
    this.config = {detachedOAuth,detachedOAuthHomes:Object.fromEntries(detachedOAuth.map(id=>[id,this.config.detachedOAuthHomes?.[id] || {}])), hub: {protocol:2,workspaceId:result.workspaceId, url, deviceId: result.deviceId, nodeId: result.engine.nodeId, name: result.engine.name, fingerprint: info.fingerprint, publicKey: engine.publicKey, ...(trust === 'pinned'||requirePin ? { tls: 'pinned' } : {}), connectedAt: now() } };
    this.meta.cursor = 0; this.meta.pushed = 0;
    // An explicit link merges this whole local copy, including documents originally received from another hub.
    // Keep their original causal stamps; a newer destination edit still wins.
    for(const entry of Object.values(this.meta.docs))delete entry.r;
    await this.saveConfig(); await this.saveMeta();
    this.peerStatus = { connected: false, lastSyncAt: null, error: null, pushing: false };
    this.startPeer();
    return this.status();
  }
  disconnect() { return this.changeTopology(()=>this.disconnectIdle()); }
  async disconnectIdle() {
    ensure(this.config.hub, 409, 'This engine is not syncing with a home server.');
    // Persist the fail-closed local ownership barrier before any remote grant/key transition.
    // These fields never enter replicated documents and never change enabled settings on the home server.
    const detachedOAuth=[...new Set([...(this.config.detachedOAuth || []),...this.store.state.connections.filter(connection=>connection.type==='chatgpt'&&connection.oauthSecret).map(connection=>connection.id)])],detachedOAuthHomes={...this.config.detachedOAuthHomes};
    for(const id of detachedOAuth)detachedOAuthHomes[id] ||= {nodeId:this.config.hub.nodeId,fingerprint:this.config.hub.fingerprint};
    this.config={...this.config,automationSuspended:true,automationSuspendedAt:now(),detachedOAuth,detachedOAuthHomes};
    await this.saveConfig();
    // A secure link is removed at its authority before this engine discards its local connection.
    if(this.config.hub.protocol===2) {
      if(!this.peer)this.startPeer();
      try { await this.revokeEngineRemotely(this.config.hub.deviceId); }
      catch(error) { if(error.code!=='engine_revoked_verified')throw error; /* Only a fresh exact hub-signed durable revocation proof can complete a previously committed unlink. */ }
    }
    await this.stopPeer();
    this.transport.close();
    // A fresh key means data from the old workspace can no longer be read by it, and this engine can become a hub itself.
    const workspaceKey=randomBytes(32);await this.security.adopt({workspaceId:randomBytes(18).toString('base64url'),epoch:1,keyId:keyId(workspaceKey)},workspaceKey,{allowNewWorkspace:true});
    this.config = {...this.config, hub: null }; await this.saveConfig();
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
    if(this.role()==='standalone')return [];
    return Object.entries(this.store.state.presence || {}).filter(([node]) => node !== this.nodeId&&!this.revokedNode(node)).map(([nodeId, presence]) => {
      const wall = parseStamp(this.meta.docs[`presence:${nodeId}`]?.h)?.wall || 0, seen = this.online.get(nodeId);
      return { nodeId, name: presence?.name || 'Engine', role: presence?.role || 'replica', url: presence?.url || '', online: seen ? Date.now() - Date.parse(seen) < 60_000 : nodeId === this.config.hub?.nodeId ? this.peerStatus.connected : false, lastSeenAt: seen || (wall ? new Date(wall).toISOString() : null), busy: Object.keys(presence?.active || {}) };
    });
  }
  /** Compact view for every client state poll: which engine this is and which bots are busy elsewhere. */
  summary() {
    const hub = this.config.hub, busy = {};
    for (const engine of this.engines()) for (const botId of engine.busy) busy[botId] = engine.name;
    return { node: { id: this.nodeId, name: this.identity.name, role: this.role(),automation:this.runsAutomation(),automationSuspended:!!this.config.automationSuspended }, hub: hub ? { name: hub.name, url: hub.url, connected: this.peerStatus.connected, error: this.peerStatus.error } : null, engines: this.engines().map(({ busy: _, ...engine }) => engine), busy };
  }
  status() {
    const role = this.role(), hub = this.config.hub;
    const pending = hub ? Object.values(this.meta.docs).filter(entry => entry.s > this.meta.pushed && !entry.r).length : 0;
    return {
      node: { id: this.nodeId, name: this.identity.name, role, fingerprint: this.identity.fingerprint, url: this.options.publicUrl || '', automation: this.runsAutomation(),automationSuspended:!!this.config.automationSuspended,enabledRoutines:(this.store.state.routines || []).filter(item=>item.enabled).length,enabledChannels:(this.store.state.channels || []).filter(item=>item.enabled).length,detachedChatGPT:(this.config.detachedOAuth || []).filter(id=>this.store.state.connections.some(connection=>connection.id===id&&connection.oauthSecret)).length },
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
