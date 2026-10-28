import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicWrite, ensure } from './store.mjs';

const PRIVATE = new net.BlockList(), LOOPBACK = new net.BlockList();
// Loopback, RFC 1918, Tailscale/CGNAT, link-local and IPv6 unique-local (which includes Tailscale's IPv6 range).
for (const [address, prefix] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['169.254.0.0', 16]]) PRIVATE.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]]) PRIVATE.addSubnet(address, prefix, 'ipv6');
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4'); LOOPBACK.addAddress('::1', 'ipv6');
const TRUST = ['loopback', 'private', 'none'];
const PUBLIC_FAILURES = 50, PUBLIC_FAILURE_MS = 60 * 60_000;

/** Returns a canonical IP address, or null. Accepts IPv4-mapped IPv6 and the port suffixes some proxies add. */
export function normalizeAddress(value) {
  let address = String(value || '').trim();
  const v4Port = address.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/), v6Port = address.match(/^\[([0-9a-fA-F:.]+)\](?::\d+)?$/);
  if (v4Port) address = v4Port[1]; else if (v6Port) address = v6Port[1];
  if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(address)) address = address.slice(7);
  return net.isIP(address) ? address.toLowerCase() : null;
}
const inList = (list, value) => { const address = normalizeAddress(value); return !!address && list.check(address, net.isIPv4(address) ? 'ipv4' : 'ipv6'); };
export const isPrivateAddress = value => inList(PRIVATE, value);
export const isLoopbackAddress = value => inList(LOOPBACK, value);

/** Rate-limit bucket for a client: its IPv4 address, or its IPv6 /64, which one subscriber usually controls entirely. */
export function addressBucket(value) {
  const address = normalizeAddress(value);
  if (!address || !net.isIPv6(address)) return address || 'unknown';
  const groups = list => list.reduce((count, part) => count + (part.includes('.') ? 2 : 1), 0);
  const [head, tail] = address.split('::'), left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const parts = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - groups(left) - groups(right))).fill('0'), ...right];
  return `${parts.slice(0, 4).map(part => part.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Fixed-window counters with bounded memory for unauthenticated traffic. A key that starts a new window moves to the
 * end, so expired windows are swept from the front in amortized constant time and the oldest are evicted past the cap.
 */
export class WindowCounter {
  constructor(maxKeys = 10_000) { this.entries = new Map(); this.maxKeys = maxKeys; }
  count(key) { const entry = this.entries.get(key); return entry && entry.until > Date.now() ? entry.count : 0; }
  add(key, windowMs) {
    const time = Date.now();
    for (const [name, entry] of this.entries) { if (entry.until > time) break; this.entries.delete(name); }
    let entry = this.entries.get(key);
    if (!entry || entry.until <= time) { this.entries.delete(key); entry = { count: 0, until: time + windowMs }; this.entries.set(key, entry); }
    entry.count++;
    while (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value);
    return entry.count;
  }
  delete(key) { this.entries.delete(key); }
  get size() { return this.entries.size; }
}

/**
 * Who is asking and from where. Behind a reverse proxy or tunnel every request arrives from the proxy, so the client
 * address comes from the last X-Forwarded-For hop, but only when the connection itself comes from a trusted proxy
 * (loopback by default; private networks for containers). Requests from outside private networks are "public": there,
 * only paired apps may sign in unless the owner allows the workspace password from the internet.
 */
export class Access {
  constructor(directory, { trustProxy = process.env.STUDIO_TRUSTED_PROXY || 'loopback', publicHost = '' } = {}) {
    ensure(TRUST.includes(trustProxy), 500, 'STUDIO_TRUSTED_PROXY must be loopback, private or none.');
    this.file = path.join(directory, 'access.json'); this.trustProxy = trustProxy; this.publicHost = publicHost;
    this.settings = { publicPassword: false }; this.publicFailures = { count: 0, until: 0 };
  }
  async init() {
    const saved = await fs.readFile(this.file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (saved && typeof saved.publicPassword === 'boolean') this.settings.publicPassword = saved.publicPassword;
    return this;
  }
  trusted(socketAddress) {
    return this.trustProxy === 'private' ? isPrivateAddress(socketAddress) : this.trustProxy === 'loopback' && isLoopbackAddress(socketAddress);
  }
  resolve(req) {
    const socket = normalizeAddress(req.socket.remoteAddress), header = req.headers['x-forwarded-for'];
    if (header && this.trusted(socket)) return { client: normalizeAddress(String(header).split(',').at(-1)) || 'unknown', vouched: true };
    return { client: socket || 'unknown', vouched: false };
  }
  /** The client's address, or 'unknown' when a trusted proxy reported something unusable. */
  client(req) { return this.resolve(req).client; }
  isPublic(req) {
    const { client, vouched } = this.resolve(req);
    if (!isPrivateAddress(client)) return true;
    // A request for the public host name that no trusted proxy vouched for is treated as coming from the internet.
    return !vouched && !!this.publicHost && req.headers.host === this.publicHost;
  }
  passwordAllowed(req) { return !this.isPublic(req) || this.settings.publicPassword; }
  /**
   * Throws unless the workspace password may be used for this request. Internet attempts count against one hourly cap
   * across all addresses, so a distributed guesser is stopped too. The attempt is counted before the password is checked,
   * so concurrent guesses cannot all pass the cap; call the returned refund when the attempt turns out not to be a wrong guess.
   */
  checkPassword(req) {
    if (!this.isPublic(req)) return () => {};
    ensure(this.settings.publicPassword, 403, 'Password sign-in is off on this internet address. Open Tupies in the Tupies app, or pair it from the server with "npm run pair".');
    const time = Date.now();
    if (this.publicFailures.until <= time) this.publicFailures = { count: 0, until: time + PUBLIC_FAILURE_MS };
    const window = this.publicFailures;
    ensure(window.count < PUBLIC_FAILURES, 429, 'Password sign-in from the internet is paused after many failed attempts. Your paired apps still work; try again within an hour.');
    window.count++;
    let held = true;
    return () => { if (held && window === this.publicFailures) window.count--; held = false; };
  }
  async setPublicPassword(value) {
    ensure(typeof value === 'boolean', 400, 'publicPassword must be true or false.');
    this.settings = { ...this.settings, publicPassword: value };
    if (!value) this.publicFailures = { count: 0, until: 0 };
    await atomicWrite(this.file, JSON.stringify(this.settings, null, 2));
    return this.status();
  }
  status(req) { return { publicPassword: this.settings.publicPassword, trustProxy: this.trustProxy, ...(req ? { public: this.isPublic(req) } : {}) }; }
}
