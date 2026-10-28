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

/** A fixed-destination Apple push provider. Configuration belongs to the operator,
 * never a model, device registration, workspace file or notification payload. */
export class APNs {
  constructor(options = {}) {
    const env = options.env || process.env;
    this._config = {
      keyFile:options.keyFile ?? env.STUDIO_APNS_KEY_FILE ?? '',
      keyId:options.keyId ?? env.STUDIO_APNS_KEY_ID ?? '',
      teamId:options.teamId ?? env.STUDIO_APNS_TEAM_ID ?? '',
      topic:options.topic ?? env.STUDIO_APNS_TOPIC ?? 'dev.hermesstudio.app',
      environment:options.environment ?? env.STUDIO_APNS_ENVIRONMENT ?? 'sandbox',
    };
    this._connect = options.connect || http2.connect;
    this._readKey = options.readKey || readPrivateKey;
    this._now = options.now || Date.now;
    this._timeoutMs = options.timeoutMs ?? 30_000;
    this._reason = 'not_configured';
    this._key = null; this._jwt = null; this._session = null; this._closed = false;
    this._waiting = []; this._active = false; this._abort = null;
    this._init = null;
  }
  get available() { return !this._closed && !!this._key; }
  get environment() { return Object.hasOwn(ENDPOINTS,this._config.environment) ? this._config.environment : 'sandbox'; }
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
    if (!c.keyFile && !c.keyId && !c.teamId) return;
    try {
      if (typeof c.keyFile !== 'string' || !c.keyFile || !/^[A-Z0-9]{10}$/.test(c.keyId) ||
          !/^[A-Z0-9]{10}$/.test(c.teamId) || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(c.topic) ||
          !Object.hasOwn(ENDPOINTS, c.environment)) throw new Error('Invalid configuration.');
      const raw = await this._readKey(c.keyFile);
      if (Buffer.byteLength(raw) > MAX_KEY_BYTES) throw new Error('Invalid key.');
      const key = createPrivateKey(raw);
      if (key.type !== 'private' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Invalid key.');
      if (!this._closed) { this._key = key; this._reason = null; }
    } catch { this._key = null; this._reason = 'invalid_configuration'; }
  }
  _providerToken() {
    const now = this._now();
    if (this._jwt && now >= this._jwt.at && now - this._jwt.at < TOKEN_LIFETIME_MS) return this._jwt.value;
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({alg:'ES256',kid:this._config.keyId})}.${encode({iss:this._config.teamId,iat:Math.floor(now/1000)})}`;
    const signature = sign('sha256', Buffer.from(input), {key:this._key,dsaEncoding:'ieee-p1363'}).toString('base64url');
    this._jwt = {at:now,value:`${input}.${signature}`};
    return this._jwt.value;
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
  _connection() {
    if (this._session && !this._session.closed && !this._session.destroyed) return this._session;
    const endpoint = ENDPOINTS[this.environment];
    const session = this._connect(endpoint, {rejectUnauthorized:true,minVersion:'TLSv1.2',servername:new URL(endpoint).hostname});
    this._session = session;
    session.on('error', () => { if (this._session === session) this._session = null; });
    session.on('close', () => { if (this._session === session) this._session = null; });
    session.on('goaway', () => { if (this._session === session) this._session = null; session.close(); });
    session.setTimeout?.(60_000, () => { if (this._session === session) this._session = null; session.close(); });
    return session;
  }
  async send({token,environment,payload,eventId} = {}) {
    await this.init();
    if (!this.available) throw failure('apns_unavailable', this.configError);
    if (environment !== this.environment) throw failure('apns_environment_mismatch','Apple push environment does not match this app.');
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
      return await this._send({token:token.toLowerCase(),bytes,eventId});
    } finally { this._release(); }
  }
  _send({token,bytes,eventId}) {
    return new Promise((resolve,reject) => {
      let stream, session, timer, settled = false, status = 0, retryAfter, size = 0;
      const chunks = [];
      const finish = (error,result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this._abort = null;
        if (error) {
          stream?.close(http2.constants.NGHTTP2_CANCEL);
          if (this._session === session) this._session = null;
          session?.destroy();
          reject(error);
        } else resolve(result);
      };
      const ambiguous = () => finish(failure('apns_delivery_unknown','Apple push delivery could not be confirmed.'));
      this._abort = () => finish(failure('apns_closed','Apple push is closed.'));
      timer = setTimeout(ambiguous,this._timeoutMs); timer.unref?.();
      try {
        session = this._connection();
        const digest = createHash('sha256').update(eventId).digest();
        // Stable identifiers allow APNs to coalesce retries of one event without
        // coalescing different bot replies or exposing an internal event identifier.
        const uuid = Buffer.from(digest.subarray(0,16)); uuid[6] = (uuid[6] & 15) | 0x50; uuid[8] = (uuid[8] & 63) | 0x80;
        const hex = uuid.toString('hex');
        const headers = {
          ':method':'POST', ':path':`/3/device/${token}`,
          authorization:`bearer ${this._providerToken()}`,
          'apns-topic':this._config.topic, 'apns-push-type':'alert', 'apns-priority':'5',
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
    this._session?.destroy(); this._session = null; this._key = null; this._jwt = null;
  }
}
