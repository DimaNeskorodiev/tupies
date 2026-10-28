import { randomBytes } from 'node:crypto';
import qrcode from 'qrcode-generator';
import { ensure, string, now, id } from '../store.mjs';
import { WindowCounter, addressBucket } from '../access.mjs';
import { b64url, sha256, fingerprint, publicKeyObject, signMessage, verifyMessage, wrapWorkspaceKey, PAIR_MESSAGE, PAIRED_MESSAGE, SESSION_MESSAGE } from './crypto.mjs';

const PAIRING_MS = 10 * 60_000, LOCAL_PAIRING_MS = 24 * 60 * 60_000, SESSION_MS = 60 * 60_000, TICKET_MS = 30_000, SKEW_MS = 5 * 60_000;
const PLATFORMS = ['ios', 'macos', 'android', 'web', 'engine', 'other'];
const SAFE_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const hashCode = code => b64url(sha256(`hermes-studio/pairing-code\n${code}`));

/**
 * Paired devices and engines. Pairing codes are single-use and short-lived; each device proves possession of its P-256
 * key and receives an engine signature over its identity so it can detect an impersonated server. Device records hold
 * only public keys and replicate to linked engines, so pairing once with the home server works on every engine and a
 * revocation anywhere applies everywhere.
 */
export class Devices {
  constructor(store, sync) {
    this.store = store; this.sync = sync;
    this.codes = new Map(); this.sessions = new Map(); this.tickets = new Map(); this.nonces = new Map(); this.lastSeen = new Map(); this.limits = new WindowCounter();
  }
  active() { return (this.store.state.devices || []).filter(device => !device.revokedAt); }
  find(deviceId) { return (this.store.state.devices || []).find(device => device.id === deviceId && !device.revokedAt); }
  limit(key, max, windowMs) {
    ensure(this.limits.count(key) < max, 429, 'Too many pairing or sign-in attempts. Wait a few minutes.');
    this.limits.add(key, windowMs);
  }
  over(key, max) { return this.limits.count(key) >= max; }
  /**
   * Device sign-in for a client address. Only failures count against the address, so strangers sending bogus requests
   * cannot lock a paired device out from another network; each device's own sign-ins are limited separately.
   */
  signIn(input, client) {
    const failures = `session-failed:${addressBucket(client)}`;
    ensure(!this.over(failures, 30), 429, 'Too many failed sign-in attempts from this network. Wait a few minutes.');
    try { return this.session(input); }
    catch (error) { if (error.status < 500 && error.status !== 429) this.limit(failures, Infinity, 10 * 60_000); throw error; }
  }
  sweep() {
    const time = Date.now();
    for (const map of [this.codes, this.sessions, this.tickets, this.nonces]) for (const [key, value] of map) if (value.expires < time) map.delete(key);
  }

  /** Creates a single-use pairing link. Engine links additionally hand over the workspace sync key during pairing. */
  createPairing({ kind = 'device', baseUrl, local = false } = {}) {
    ensure(['device', 'engine'].includes(kind), 400, 'Choose a device or engine pairing.');
    ensure(kind === 'device' || this.sync.role() !== 'replica', 409, 'Link engines from your home server. This engine already syncs with one.');
    this.sweep();
    ensure(this.codes.size < 50, 429, 'Too many open pairing links. Wait for some to expire.');
    const code = randomBytes(24).toString('base64url'), expires = Date.now() + (local ? LOCAL_PAIRING_MS : PAIRING_MS);
    this.codes.set(hashCode(code), { kind, expires, local });
    const identity = this.sync.identity;
    // Percent-encoding (not form encoding) so every client decodes spaces in the engine name the same way.
    // An engine serving its own certificate tells linking engines to accept nothing but that key, even on first contact.
    const params = Object.entries({ v: '1', url: baseUrl, code, fp: identity.fingerprint, name: identity.name, kind, ...(kind === 'engine' && this.sync.options.tls ? { tls: 'engine' } : {}) }).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    const link = `hermes-studio://pair?${params}`;
    const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
    return { code, link, kind, url: baseUrl, expiresAt: new Date(expires).toISOString(), fingerprint: identity.fingerprint, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) };
  }

  async pair(input) {
    ensure(input?.v === 1, 400, 'Update the app: unsupported pairing version.');
    const code = string(input.code, 'Pairing code', 200), entry = this.codes.get(hashCode(code));
    ensure(entry && entry.expires > Date.now(), 403, 'This pairing link expired or was already used. Create a new one.');
    const kind = input.kind === 'engine' ? 'engine' : 'device';
    ensure(entry.kind === kind, 403, kind === 'engine' ? 'This is a device link. Create an engine link to connect another engine.' : 'This link is for connecting another engine, not an app.');
    const name = string(input.name, 'Device name', 80), platform = PLATFORMS.includes(input.platform) ? input.platform : 'other';
    const publicKey = string(input.publicKey, 'Public key', 400); publicKeyObject(publicKey);
    ensure(verifyMessage(publicKey, PAIR_MESSAGE(code, publicKey), input.proof), 403, 'The device could not prove it holds its key.');
    let nodeId = null;
    if (kind === 'engine') {
      nodeId = string(input.nodeId, 'Engine node', 120);
      ensure(SAFE_ID.test(nodeId) && nodeId !== this.sync.nodeId, 400, 'Choose a different engine to link.');
    }
    this.codes.delete(hashCode(code));
    const device = { id: id('dev'), name, kind, platform: kind === 'engine' ? 'engine' : platform, publicKey, fingerprint: fingerprint(publicKey), ...(nodeId ? { nodeId } : {}), pairedVia: this.sync.nodeId, createdAt: now() };
    await this.store.mutate(state => {
      state.devices ||= [];
      ensure(state.devices.filter(item => !item.revokedAt).length < 100, 400, 'Remove an old device before pairing another.');
      if (nodeId) for (const item of state.devices) if (item.nodeId === nodeId && !item.revokedAt) item.revokedAt = now();
      state.devices.push(device);
      this.store.audit('device.paired', `${name} was paired`, null, { deviceId: device.id, kind });
    });
    if (entry.local) this.onLocalPairingUsed?.();
    const identity = this.sync.identity;
    return {
      deviceId: device.id,
      engine: { nodeId: this.sync.nodeId, name: identity.name, fingerprint: identity.fingerprint, publicKey: identity.publicKey },
      engineProof: signMessage(identity.privateKey, PAIRED_MESSAGE(device.id, publicKey)),
      ...(kind === 'engine' ? { workspaceKey: wrapWorkspaceKey(code, nodeId, this.sync.workspaceKey) } : {})
    };
  }

  /** Exchanges a fresh device signature for a one-hour bearer token. */
  session(input) {
    const deviceId = string(input?.deviceId, 'Device', 120), nonce = string(input?.nonce, 'Nonce', 100);
    ensure(/^[A-Za-z0-9_-]{16,100}$/.test(nonce), 400, 'Use a random base64url nonce.');
    ensure(Number.isSafeInteger(input.timestamp) && Math.abs(Date.now() - input.timestamp) <= SKEW_MS, 400, 'This device’s clock differs from the engine by more than five minutes.');
    const device = this.find(deviceId);
    ensure(device && verifyMessage(device.publicKey, SESSION_MESSAGE(deviceId, input.timestamp, nonce), input.signature), 401, 'This device is not paired with this engine. Pair it again.');
    this.sweep();
    const replay = `${deviceId}:${nonce}`;
    ensure(!this.nonces.has(replay), 401, 'This sign-in request was already used.');
    this.limit(`session-device:${deviceId}`, 30, 60_000);
    this.nonces.set(replay, { expires: Date.now() + 2 * SKEW_MS });
    const token = `hsd_${randomBytes(32).toString('base64url')}`, expires = Date.now() + SESSION_MS;
    for (const [key, value] of this.sessions) if (value.deviceId === deviceId && value.expires < Date.now() + 5 * 60_000) this.sessions.delete(key);
    this.sessions.set(token, { deviceId, expires });
    this.lastSeen.set(deviceId, now());
    return { token, expiresAt: new Date(expires).toISOString() };
  }
  /** Resolves a bearer token; a revoked or removed device loses access on its next request. */
  authenticate(header) {
    const match = typeof header === 'string' && header.match(/^Bearer (hsd_[A-Za-z0-9_-]{43})$/);
    if (!match) return null;
    const session = this.sessions.get(match[1]);
    if (!session) return null;
    const device = session.expires > Date.now() && this.find(session.deviceId);
    if (!device) { this.sessions.delete(match[1]); return null; }
    this.lastSeen.set(device.id, now());
    return { device, kind: device.kind, token: match[1] };
  }
  webTicket(deviceId) {
    this.sweep();
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { deviceId, expires: Date.now() + TICKET_MS });
    return { ticket, path: `/auth/device?ticket=${ticket}` };
  }
  redeemTicket(ticket) {
    const entry = typeof ticket === 'string' && this.tickets.get(ticket);
    if (entry) this.tickets.delete(ticket);
    return entry && entry.expires > Date.now() && this.find(entry.deviceId) ? entry.deviceId : null;
  }
  async rename(deviceId, name) {
    const value = string(name, 'Device name', 80);
    await this.store.mutate(state => { const device = (state.devices || []).find(item => item.id === deviceId && !item.revokedAt); ensure(device, 404, 'Device not found.'); device.name = value; });
    return this.list().find(device => device.id === deviceId);
  }
  async revoke(deviceId) {
    await this.store.mutate(state => {
      const device = (state.devices || []).find(item => item.id === deviceId && !item.revokedAt);
      ensure(device, 404, 'Device not found.');
      device.revokedAt = now();
      this.store.audit('device.revoked', `${device.name} was removed`, null, { deviceId });
    });
    for (const [token, session] of this.sessions) if (session.deviceId === deviceId) this.sessions.delete(token);
    return { revoked: true };
  }
  list() {
    return this.active().map(({ publicKey, ...device }) => ({ ...device, shortFingerprint: device.fingerprint.slice(0, 8), lastSeenAt: this.lastSeen.get(device.id) || null, ...(device.nodeId === this.sync.nodeId ? { self: true } : {}) }));
  }
}
