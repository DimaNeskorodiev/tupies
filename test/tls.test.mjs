import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStudioServer } from '../server.mjs';
import { generateIdentity, fingerprint } from '../lib/sync/crypto.mjs';
import { identityCertificate } from '../lib/sync/certificate.mjs';
import { EngineTransport, certificateFingerprint } from '../lib/sync/transport.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch (error) { last = error; } await sleep(40); }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}
async function engine(t, { tls: tlsMode = false, port = 0, directory } = {}) {
  directory ||= await fs.mkdtemp(path.join(tmpdir(), 'studio-tls-'));
  const app = await createStudioServer({ dataDir: directory, scheduler: false, logErrors: false, ...(tlsMode ? { tls: 'engine' } : {}), sync: { longPollMs: 1500, fileScanInterval: 300 } });
  const { url, port: bound } = await app.listen(port);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { app, url, port: bound, directory, close };
}
/** Test-only HTTPS client that skips verification, so each test checks trust explicitly where it matters. */
const insecure = (url, { method = 'GET', headers = {}, data } = {}) => new Promise((resolve, reject) => {
  const payload = data === undefined ? null : Buffer.from(JSON.stringify(data));
  const request = https.request(url, { method, rejectUnauthorized: false, headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, response => {
    const chunks = [], certificate = response.socket.getPeerCertificate(); response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => { const text = Buffer.concat(chunks).toString(); let body; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: response.statusCode, body, headers: response.headers, certificate }); });
  });
  request.on('error', reject); request.end(payload || undefined);
});
const plainRequest = (url, init = {}) => fetch(url, init);

test('the identity certificate is a valid self-signed certificate over the engine key', () => {
  const identity = generateIdentity();
  const first = new X509Certificate(identityCertificate(identity.privateKey, { hosts: ['203.0.113.5', 'studio.example.com', '2001:db8::1'] }));
  const second = new X509Certificate(identityCertificate(identity.privateKey));
  assert.equal(first.subject, 'CN=Tupies');
  assert.equal(first.verify(first.publicKey), true);
  assert.equal(fingerprint(first.publicKey.export({ type: 'spki', format: 'der' })), identity.fingerprint);
  assert.equal(certificateFingerprint(first.raw), identity.fingerprint);
  assert.match(first.subjectAltName, /IP Address:203\.0\.113\.5/); assert.match(first.subjectAltName, /DNS:studio\.example\.com/); assert.match(first.subjectAltName, /IP Address:2001:DB8:0:0:0:0:0:1/i); assert.match(first.subjectAltName, /DNS:localhost/);
  assert.equal(first.ca, false);
  // iOS 27 refuses long-lived certificates even when the app trusts the key, so the lifetime stays under 47 days.
  const days = (Date.parse(first.validTo) - Date.parse(first.validFrom)) / (24 * 60 * 60_000);
  assert.ok(days > 40 && days < 47, String(days));
  assert.notEqual(first.serialNumber, second.serialNumber);
  assert.equal(certificateFingerprint(second.raw), identity.fingerprint, 'only the key matters, so a regenerated certificate keeps the same pin');
});

test('an engine with STUDIO_TLS=engine serves TLS 1.3 with its identity key only', async t => {
  const hub = await engine(t, { tls: true });
  assert.match(hub.url, /^https:\/\/127\.0\.0\.1:\d+$/);
  const info = await insecure(`${hub.url}/api/engine`);
  assert.equal(info.status, 200); assert.equal(info.body.tls, 'identity'); assert.equal(info.body.fingerprint, hub.app.sync.identity.fingerprint);
  assert.equal(certificateFingerprint(info.certificate.raw), hub.app.sync.identity.fingerprint, 'the TLS key is the identity key from the pairing link');
  const transport = new EngineTransport(); t.after(() => transport.close());
  const pinned = await transport.request(`${hub.url}/api/engine`, { pin: hub.app.sync.identity.fingerprint, requirePin: true });
  assert.equal(pinned.status, 200); assert.equal(pinned.trust, 'pinned');
  await assert.rejects(transport.request(`${hub.url}/api/engine`, { pin: generateIdentity().fingerprint }), /does not match its pairing/);
  await assert.rejects(new Promise((resolve, reject) => { const socket = tls.connect({ host: '127.0.0.1', port: hub.port, rejectUnauthorized: false, maxVersion: 'TLSv1.2' }, () => { socket.end(); resolve(); }); socket.on('error', reject); }), 'TLS 1.2 is refused');
  await assert.rejects(plainRequest(`http://127.0.0.1:${hub.port}/api/engine`), 'plain HTTP is not served');
  // Nothing sits in front of a TLS engine, so a forwarded address from the client is ignored.
  assert.equal(hub.app.access.trustProxy, 'none');
  const setup = await insecure(`${hub.url}/api/setup`, { method: 'POST', data: { token: hub.app.bootstrapToken, password: 'fixture-workspace-password' } });
  assert.equal(setup.status, 201); assert.match(setup.headers['set-cookie'][0], /; Secure/);
  assert.equal((await insecure(`${hub.url}/api/auth`, { headers: { Origin: hub.url } })).status, 200, 'the https origin of this engine is accepted');
});

test('the engine renews its short-lived certificate over the same key without a restart', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-tls-'));
  const app = await createStudioServer({ dataDir: directory, scheduler: false, logErrors: false, tls: 'engine', certificateRenewalMs: 150 });
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const { url } = await app.listen(0);
  // A new connection each time, so each request sees the certificate that is current when it connects.
  const served = async () => { const info = await insecure(`${url}/api/engine`, { headers: { Connection: 'close' } }); return new X509Certificate(info.certificate.raw); };
  const first = await served();
  const renewed = await eventually(async () => { const next = await served(); return next.serialNumber !== first.serialNumber && next; }, 'a renewed certificate');
  assert.equal(certificateFingerprint(renewed.raw), app.sync.identity.fingerprint, 'the pin is unchanged');
  assert.ok(Date.parse(renewed.validTo) >= Date.parse(first.validTo));
});

test('a linked engine trusts the home server only by its pinned key and refuses an impostor before sending anything', async t => {
  const hub = await engine(t, { tls: true }), mac = await engine(t);
  const link = hub.app.sync.devices.createPairing({ kind: 'engine', baseUrl: hub.url }).link;
  // The link says the server uses its own certificate, so even the first contact accepts nothing but the pinned key.
  assert.equal(new URL(link).searchParams.get('tls'), 'engine');
  assert.equal(new URL(mac.app.sync.devices.createPairing({ kind: 'engine', baseUrl: mac.url }).link).searchParams.get('tls'), null);
  assert.equal(new URL(hub.app.sync.devices.createPairing({ kind: 'device', baseUrl: hub.url }).link).searchParams.get('tls'), null);
  const fetches = [], engineFetch = mac.app.sync.engineFetch.bind(mac.app.sync);
  mac.app.sync.engineFetch = (url, init, pin, requirePin) => { fetches.push({ route: new URL(url).pathname, requirePin }); return engineFetch(url, init, pin, requirePin); };
  await mac.app.sync.connect(link);
  delete mac.app.sync.engineFetch;
  assert.deepEqual(fetches.slice(0, 2), [{ route: '/api/engine', requirePin: true }, { route: '/api/pair', requirePin: true }]);
  assert.equal(mac.app.sync.config.hub.tls, 'pinned');
  assert.equal(mac.app.sync.config.hub.url, hub.url);
  await mac.app.store.mutate(state => { state.bots.push({ ...state.bots[0], id: 'bot_tls_fixture', name: 'Pinned' }); });
  await eventually(() => hub.app.store.state.bots.some(bot => bot.id === 'bot_tls_fixture'), 'the bot to reach the home server over pinned TLS');
  await hub.app.store.mutate(state => { state.bots.find(bot => bot.id === 'bot_tls_fixture').name = 'Pinned and synced'; });
  await eventually(() => mac.app.store.state.bots.find(bot => bot.id === 'bot_tls_fixture')?.name === 'Pinned and synced', 'the edit to come back');

  // Another engine takes over the home server's address: the Mac refuses it during the TLS handshake.
  const port = hub.port; await hub.close();
  const impostor = await engine(t, { tls: true, port });
  let requests = 0; impostor.app.server.on('request', () => { requests++; });
  await mac.app.store.mutate(state => { state.bots.find(bot => bot.id === 'bot_tls_fixture').name = 'Never leaves the Mac'; });
  await eventually(() => /does not match its pairing/.test(mac.app.sync.status().hub?.error || ''), 'the certificate mismatch to be reported');
  await sleep(300);
  assert.equal(requests, 0, 'the impostor never received a request');
  assert.ok(!impostor.app.store.state.bots.some(bot => bot.id === 'bot_tls_fixture'));

  // A link whose fingerprint does not match the server's certificate is refused before pairing.
  const other = await engine(t);
  const forged = impostor.app.sync.devices.createPairing({ kind: 'engine', baseUrl: impostor.url }).link.replace(/fp=[^&]+/, `fp=${generateIdentity().fingerprint}`);
  await assert.rejects(other.app.sync.connect(forged), /does not match its pairing/);
  assert.equal(other.app.sync.config.hub, null);
});
