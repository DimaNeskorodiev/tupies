import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { HttpError } from '../store.mjs';
import { fingerprint } from './crypto.mjs';

const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
export const certificateFingerprint = raw => fingerprint(new X509Certificate(raw).publicKey.export({ type: 'spki', format: 'der' }));

/**
 * Opens TLS connections to one engine. A certificate carrying the engine's identity key (the fingerprint from the pairing
 * link) is accepted; otherwise only a publicly trusted certificate for the host is, and not even that once the engine is
 * known to serve its own. The check runs before the connection is handed to HTTP, so nothing is sent to an impostor.
 */
class EngineAgent extends https.Agent {
  constructor(pin, requirePin) { super({ keepAlive: true, maxSockets: 8 }); this.pin = pin; this.requirePin = requirePin; }
  createConnection(options, callback) {
    const socket = tls.connect({ ...options, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    let settled = false;
    const finish = error => { if (settled) return; settled = true; if (error) { socket.destroy(); callback(error); } else callback(null, socket); };
    socket.once('secureConnect', () => {
      let pinned = false;
      try { pinned = !!this.pin && certificateFingerprint(socket.getPeerCertificate().raw) === this.pin; } catch {}
      const trusted = !this.requirePin && socket.authorized && !tls.checkServerIdentity(options.servername || options.host, socket.getPeerCertificate());
      if (!pinned && !trusted) return finish(new HttpError(502, 'The engine’s certificate does not match its pairing. Nothing was sent.'));
      socket.studioTrust = pinned ? 'pinned' : 'public';
      finish(null);
    });
    socket.once('error', finish);
  }
}

/** Engine-to-engine HTTPS with a fetch-shaped result; `trust` reports how the certificate was accepted. One per engine. */
export class EngineTransport {
  constructor() { this.agents = new Map(); }
  agent(pin, requirePin) {
    const key = `${pin}:${requirePin}`;
    if (!this.agents.has(key)) this.agents.set(key, new EngineAgent(pin, requirePin));
    return this.agents.get(key);
  }
  request(url, { method = 'GET', headers = {}, body, signal, pin, requirePin = false } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      const request = https.request(url, { method, signal, agent: this.agent(pin, requirePin), headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) } }, response => {
        const chunks = [], trust = response.socket?.studioTrust || null; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > MAX_RESPONSE_BYTES) request.destroy(new HttpError(502, 'The engine sent too much data.')); else chunks.push(chunk); });
        response.on('end', () => {
          const data = Buffer.concat(chunks);
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, trust, json: async () => JSON.parse(data.toString('utf8')), arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) });
        });
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end(payload || undefined);
    });
  }
  close() { for (const agent of this.agents.values()) agent.destroy(); this.agents.clear(); }
}
