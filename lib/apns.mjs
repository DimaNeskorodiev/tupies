import http2 from 'node:http2';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { open } from 'node:fs/promises';

const ENDPOINTS = Object.freeze({sandbox:'https://api.sandbox.push.apple.com', production:'https://api.push.apple.com'});
const TOKEN_LIFETIME_MS = 50 * 60_000;
const MAX_PAYLOAD_BYTES = 4096;
const MAX_KEY_BYTES = 64 * 1024;
const APPLE_REASONS = new Set([
  'BadCollapseId','BadDeviceToken','BadExpirationDate','BadMessageId','BadPriority','BadTopic',
  'DeviceTokenNotForTopic','DuplicateHeaders','IdleTimeout','InvalidPushType','MissingDeviceToken',
  'MissingTopic','PayloadEmpty','TopicDisallowed','BadCertificate','BadCertificateEnvironment',
  'ExpiredProviderToken','Forbidden','InvalidProviderToken','MissingProviderToken','BadPath',
  'MethodNotAllowed','Unregistered','PayloadTooLarge','TooManyProviderTokenUpdates','TooManyRequests',
  'InternalServerError','ServiceUnavailable','Shutdown',
]);

function failure(code, message) { return Object.assign(new Error(message), {code}); }
async function readPrivateKey(file) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_KEY_BYTES || stat.size === 0) throw new Error('Invalid key file.');
    const bytes = Buffer.alloc(stat.size + 1);
    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error('Key file changed.');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

const ENVIRONMENTS = Object.freeze(Object.keys(ENDPOINTS));
const KEY_ID = /^[A-Z0-9]{10}$/;

/** `sandbox`, `production`, `both` or a comma/space separated list of the two. */
export function parseEnvironments(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'both') return [...ENVIRONMENTS];
  const list = text.split(/[\s,]+/).filter(Boolean);
  return list.length && list.every(item => ENVIRONMENTS.includes(item)) ? ENVIRONMENTS.filter(item => list.includes(item)) : null;
}

/** A fixed-destination Apple push provider. Configuration belongs to the operator,
 * never a model, device registration, workspace file or notification payload.
 *
 * One provider can serve both Apple environments: a development build installed from Xcode
 * registers a sandbox token, a TestFlight/App Store/Release build a production token. Each
 * environment has its own endpoint, provider token and HTTP/2 session, and may use its own
 * key (`STUDIO_APNS_PRODUCTION_KEY_FILE`/`_KEY_ID`, `STUDIO_APNS_SANDBOX_KEY_FILE`/`_KEY_ID`),
 * because an Apple key can be restricted to one environment. */
export class APNs {
  constructor(options = {}) {
    const env = options.env || process.env;
    const own = name => {
      const upper = name.toUpperCase(), given = options.keys?.[name] || {};
      return {keyFile:given.keyFile ?? env[`STUDIO_APNS_${upper}_KEY_FILE`] ?? '', keyId:given.keyId ?? env[`STUDIO_APNS_${upper}_KEY_ID`] ?? ''};
    };
    const environment = options.environment ?? env.STUDIO_APNS_ENVIRONMENT;
    this._config = {
      keyFile:options.keyFile ?? env.STUDIO_APNS_KEY_FILE ?? '',
      keyId:options.keyId ?? env.STUDIO_APNS_KEY_ID ?? '',
      teamId:options.teamId ?? env.STUDIO_APNS_TEAM_ID ?? '',
      topic:options.topic ?? env.STUDIO_APNS_TOPIC ?? 'dev.tupies.app',
      environment:environment ?? 'sandbox', explicitEnvironment:environment !== undefined && environment !== '',
      keys:Object.fromEntries(ENVIRONMENTS.map(name => [name, own(name)])),
    };
    this._connect = options.connect || http2.connect;
    this._readKey = options.readKey || readPrivateKey;
    this._now = options.now || Date.now;
    this._timeoutMs = options.timeoutMs ?? 30_000;
    this._reason = 'not_configured';
    this._targets = new Map(); this._invalid = new Set(); this._closed = false;
    this._waiting = []; this._active = false; this._abort = null;
    this._init = null;
  }
  get available() { return !this._closed && this._targets.size > 0; }
  /** The environments this engine can deliver to right now, in a stable order. */
  get environments() { return this._closed ? [] : ENVIRONMENTS.filter(name => this._targets.has(name)); }
  /** The first usable (or configured) environment, kept for single-environment callers. */
  get environment() { return this.environments[0] || parseEnvironments(this._config.environment)?.[0] || 'sandbox'; }
  supports(environment) { return !this._closed && this._targets.has(environment); }
  /** Why one environment cannot deliver: null when it can. */
  reasonFor(environment) {
    if (this._closed) return 'closed';
    if (this._targets.has(environment)) return null;
    if (this._invalid.has(environment)) return 'invalid_configuration';
    return this._targets.size ? 'environment_mismatch' : this._reason || 'not_configured';
  }
  /** Environments the operator configured whose key could not be used. */
  get invalidEnvironments() { return ENVIRONMENTS.filter(name => this._invalid.has(name)); }
  get reason() { return this._closed ? 'closed' : this._reason; }
  get configError() {
    return this.available ? null : this.reason === 'invalid_configuration' ? 'Apple push configuration is invalid.' : 'Apple push is not configured.';
  }
  async init() {
    this._init ??= this._load();
    await this._init;
    return this;
  }
  async _load() {
    const c = this._config;
    const own = ENVIRONMENTS.filter(name => c.keys[name].keyFile || c.keys[name].keyId);
    const shared = !!(c.keyFile || c.keyId);
    if (!shared && !own.length && !c.teamId) return;
    try {
      const listed = parseEnvironments(c.environment);
      if (!listed || !KEY_ID.test(c.teamId) || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(c.topic)) throw new Error('Invalid configuration.');
      // A listed environment uses the shared key unless it has its own; an environment with
      // its own key is served even when the operator kept the older single-environment setting.
      const wanted = ENVIRONMENTS.filter(name => own.includes(name) || listed.includes(name) && (shared || c.explicitEnvironment));
      for (const name of wanted) {
        const source = own.includes(name) ? c.keys[name] : {keyFile:c.keyFile, keyId:c.keyId};
        try {
          if (typeof source.keyFile !== 'string' || !source.keyFile || !KEY_ID.test(source.keyId)) throw new Error('Invalid key configuration.');
          const raw = await this._readKey(source.keyFile);
          if (Buffer.byteLength(raw) > MAX_KEY_BYTES) throw new Error('Invalid key.');
          const key = createPrivateKey(raw);
          if (key.type !== 'private' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Invalid key.');
          if (!this._closed) this._targets.set(name, {key, keyId:source.keyId, jwt:null, session:null});
        } catch { this._invalid.add(name); }
      }
      if (!this._targets.size) throw new Error('No usable key.');
      if (!this._closed) this._reason = null;
    } catch { this._targets.clear(); this._reason = 'invalid_configuration'; }
  }
  _providerToken(target) {
    const now = this._now();
    if (target.jwt && now >= target.jwt.at && now - target.jwt.at < TOKEN_LIFETIME_MS) return target.jwt.value;
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({alg:'ES256',kid:target.keyId})}.${encode({iss:this._config.teamId,iat:Math.floor(now/1000)})}`;
    const signature = sign('sha256', Buffer.from(input), {key:target.key,dsaEncoding:'ieee-p1363'}).toString('base64url');
    target.jwt = {at:now,value:`${input}.${signature}`};
    return target.jwt.value;
  }
  async _slot() {
    if (this._closed) throw failure('apns_closed','Apple push is closed.');
    if (!this._active) { this._active = true; return; }
    if (this._waiting.length >= 32) throw failure('apns_busy','Apple push is busy.');
    return new Promise((resolve,reject) => this._waiting.push({resolve,reject}));
  }
  _release() {
    const next = this._waiting.shift();
    if (next) next.resolve(); else this._active = false;
  }
  _connection(environment, target) {
    if (target.session && !target.session.closed && !target.session.destroyed) return target.session;
    const endpoint = ENDPOINTS[environment];
    const session = this._connect(endpoint, {rejectUnauthorized:true,minVersion:'TLSv1.2',servername:new URL(endpoint).hostname});
    target.session = session;
    const retire = () => { if (target.session === session) target.session = null; };
    session.on('error', retire);
    session.on('close', retire);
    session.on('goaway', () => { retire(); session.close(); });
    session.setTimeout?.(60_000, () => { retire(); session.close(); });
    return session;
  }
  async send({token,environment,payload,eventId} = {}) {
    await this.init();
    if (!this.available) throw failure('apns_unavailable', this.configError);
    if (!this.supports(environment)) throw failure('apns_environment_mismatch','Apple push environment does not match this app.');
    if (typeof token !== 'string' || !/^[0-9a-fA-F]{64,512}$/.test(token) || token.length % 2 ||
        typeof eventId !== 'string' || !eventId || eventId.length > 512 || /[\x00-\x1f\x7f]/.test(eventId)) throw failure('apns_invalid_request','Apple push request is invalid.');
    let bytes;
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.aps || typeof payload.aps !== 'object') throw new Error('Invalid payload.');
      bytes = Buffer.from(JSON.stringify(payload));
    } catch { throw failure('apns_invalid_payload','Apple push payload is invalid.'); }
    if (bytes.length > MAX_PAYLOAD_BYTES) throw failure('apns_payload_too_large','Apple push payload is too large.');
    await this._slot();
    try {
      if (this._closed) throw failure('apns_closed','Apple push is closed.');
      const target = this._targets.get(environment);
      if (!target) throw failure('apns_closed','Apple push is closed.');
      return await this._send({token:token.toLowerCase(),bytes,eventId,environment,target});
    } finally { this._release(); }
  }
  _send({token,bytes,eventId,environment,target}) {
    return new Promise((resolve,reject) => {
      let stream, session, timer, settled = false, status = 0, retryAfter, size = 0;
      const chunks = [];
      const finish = (error,result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this._abort = null;
        if (error) {
          stream?.close(http2.constants.NGHTTP2_CANCEL);
          if (target.session === session) target.session = null;
          session?.destroy();
          reject(error);
        } else resolve(result);
      };
      const ambiguous = () => finish(failure('apns_delivery_unknown','Apple push delivery could not be confirmed.'));
      this._abort = () => finish(failure('apns_closed','Apple push is closed.'));
      timer = setTimeout(ambiguous,this._timeoutMs); timer.unref?.();
      try {
        session = this._connection(environment, target);
        const digest = createHash('sha256').update(eventId).digest();
        // Stable identifiers allow APNs to coalesce retries of one event without
        // coalescing different bot replies or exposing an internal event identifier.
        const uuid = Buffer.from(digest.subarray(0,16)); uuid[6] = (uuid[6] & 15) | 0x50; uuid[8] = (uuid[8] & 63) | 0x80;
        const hex = uuid.toString('hex');
        // Priority 10: alerts are what the owner is waiting for (a reply, an approval, a question). Apple may
        // batch, throttle or drop priority-5 alerts to save power, which made late or missing alerts likely.
        const headers = {
          ':method':'POST', ':path':`/3/device/${token}`,
          authorization:`bearer ${this._providerToken(target)}`,
          'apns-topic':this._config.topic, 'apns-push-type':'alert', 'apns-priority':'10',
          'apns-expiration':String(Math.floor(this._now()/1000)+86400),
          'apns-id':`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`,
          'apns-collapse-id':digest.toString('hex'),
          'content-type':'application/json','content-length':String(bytes.length),
          [http2.sensitiveHeaders]:['authorization',':path'],
        };
        stream = session.request(headers);
        stream.on('response', headers => {
          const value = Number(headers[':status']);
          status = Number.isInteger(value) && value >= 200 && value <= 599 ? value : 0;
          const delay = Number(headers['retry-after']);
          if (Number.isFinite(delay) && delay >= 0) retryAfter = Math.min(delay,86400);
        });
        stream.on('data', chunk => {
          if (settled) return;
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += value.length;
          if (size > MAX_PAYLOAD_BYTES) { ambiguous(); return; }
          chunks.push(value);
        });
        stream.on('end', () => {
          if (!status) { ambiguous(); return; }
          let reason;
          if (status !== 200) {
            try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); reason = APPLE_REASONS.has(body?.reason) ? body.reason : 'APNsRejected'; }
            catch { reason = 'APNsRejected'; }
          }
          finish(null,{status,...(reason?{reason}:{}),...(retryAfter!==undefined?{retryAfter}:{})});
        });
        stream.on('error', ambiguous);
        stream.on('aborted', ambiguous);
        stream.on('close', () => { if (!settled) ambiguous(); });
        stream.end(bytes);
      } catch { ambiguous(); }
    });
  }
  close() {
    if (this._closed) return;
    this._closed = true;
    for (const item of this._waiting.splice(0)) item.reject(failure('apns_closed','Apple push is closed.'));
    this._abort?.();
    for (const target of this._targets.values()) { target.session?.destroy(); target.session = null; target.key = null; target.jwt = null; }
    this._targets.clear();
  }
}
