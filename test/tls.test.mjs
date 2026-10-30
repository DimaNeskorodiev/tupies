import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { X509Certificate, generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStudioServer } from '../server.mjs';
import { generateIdentity, fingerprint } from '../lib/sync/crypto.mjs';
import { identityCertificate } from '../lib/sync/certificate.mjs';
import { EngineTransport, certificateFingerprint } from '../lib/sync/transport.mjs';
import { LoopbackCallback, CALLBACK_PORT } from '../lib/oauth-callback.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch (error) { last = error; } await sleep(40); }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}
async function engine(t, { tls: tlsMode = false, port = 0, directory, options = {} } = {}) {
  directory ||= await fs.mkdtemp(path.join(tmpdir(), 'studio-tls-'));
  const app = await createStudioServer({ dataDir: directory, scheduler: false, logErrors: false, ...(tlsMode ? { tls: 'engine' } : {}), sync: { longPollMs: 1500, fileScanInterval: 300 }, ...options });
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
  const pairingFile=path.join(hub.directory,'local-engine-fixture.json');await hub.app.writeLocalPairing(pairingFile,hub.url);const discovery=JSON.parse(await fs.readFile(pairingFile,'utf8'));assert.equal(discovery.tls,'engine','Local native discovery must require the identity pin on first contact.');
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
  assert.equal(new URL(hub.app.sync.devices.createPairing({ kind: 'device', baseUrl: hub.url }).link).searchParams.get('tls'), 'engine');
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

/** A local OpenID issuer standing in for auth.openai.com: discovery, signing keys and a code exchange that records its redirect URI. */
async function issuerFixture(t) {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }), jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const fixture = { origin: '', nonce: '', exchanges: [] };
  const idToken = claims => { const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url'), body = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.privateKey).toString('base64url')}`; };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const send = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/.well-known/openid-configuration') return send({ issuer: fixture.origin, token_endpoint: `${fixture.origin}/token`, jwks_uri: `${fixture.origin}/jwks` });
    if (req.url === '/jwks') return send({ keys: [jwk] });
    fixture.exchanges.push(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())));
    send({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid resource.invoke chatgpt.tokens.use.direct', id_token: idToken({ iss: fixture.origin, aud: 'issued-fixture-client', sub: 'fixture-account', nonce: fixture.nonce, exp: Math.floor(Date.now() / 1000) + 3600 }) });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fixture.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));
  return fixture;
}
async function freePort() {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address(); await new Promise(resolve => probe.close(resolve)); return port;
}
/** Plain HTTP the way a browser sends OpenAI's redirect; Host and Origin can be forged to check the listener's own checks. */
const plain = (url, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const request = http.request(url, { method, headers }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), headers: response.headers })); });
  request.on('error', reject); request.end();
});
/** Signs a fixture owner in over HTTPS and returns a client carrying that session. */
async function owner(hub) {
  const setup = await insecure(`${hub.url}/api/setup`, { method: 'POST', data: { token: hub.app.bootstrapToken, password: 'fixture-workspace-password' } });
  const headers = { Cookie: setup.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': setup.body.csrf };
  return (route, init = {}) => insecure(`${hub.url}${route}`, { ...init, headers: { ...headers, ...init.headers } });
}
const refused = url => plain(url).then(() => false, error => error.code === 'ECONNREFUSED');

test('ChatGPT sign-in finishes on an engine serving TLS itself, through a loopback callback that exists only while it is pending', async t => {
  const issuer = await issuerFixture(t), callbackPort = await freePort();
  const hub = await engine(t, { tls: true, options: { oauthIssuer: issuer.origin, allowTestOAuth: true, requestTimeout: 2000, oauthCallbackPort: callbackPort } });
  const api = await owner(hub), callbackBase = `http://127.0.0.1:${callbackPort}`;
  const connection = (await api('/api/connections', { method: 'POST', data: { name: 'ChatGPT', type: 'chatgpt' } })).body;
  assert.ok(await refused(`${callbackBase}/auth/callback`), 'nothing listens for a callback before a sign-in starts');

  const start = await api(`/api/connections/${connection.id}/login`, { method: 'POST', data: {} });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const auth = new URL(start.body.authUrl), redirect = auth.searchParams.get('redirect_uri'); issuer.nonce = auth.searchParams.get('nonce');
  // OpenAI requires plain HTTP on 127.0.0.1; the engine's own port speaks only TLS, so the callback has its own port.
  assert.equal(redirect, `${callbackBase}/auth/callback`);
  assert.notEqual(callbackPort, hub.port);
  assert.match(start.body.message, new RegExp(`forward port ${callbackPort} over SSH`));
  await assert.rejects(plainRequest(`http://127.0.0.1:${hub.port}/auth/callback`), 'the engine port itself still serves no plain HTTP');

  // The listener answers nothing but GET /auth/callback for its exact loopback address, and refusals leave the attempt pending.
  const state = auth.searchParams.get('state'), callback = `${redirect}?${new URLSearchParams({ state, code: 'fixture-code', client_id: 'issued-fixture-client' })}`;
  for (const [route, init] of [['/', {}], ['/api/state', {}], ['/guide.css', {}], ['/auth/callback', { method: 'POST' }], [callback.slice(callbackBase.length), { headers: { Host: `rebound.example:${callbackPort}` } }], [callback.slice(callbackBase.length), { headers: { Origin: 'https://evil.example' } }]]) {
    const response = await plain(`${callbackBase}${route}`, init);
    assert.equal(response.status, 404, `${init.method || 'GET'} ${route} ${JSON.stringify(init.headers || {})}`);
  }
  const mismatched = await plain(`${callbackBase}/auth/callback?${new URLSearchParams({ state: 'forged-state', code: 'fixture-code', client_id: 'issued-fixture-client' })}`);
  assert.equal(mismatched.status, 400); assert.match(mismatched.body, /Sign-in could not be completed/);
  assert.equal(issuer.exchanges.length, 0, 'no code is exchanged for a refused callback');
  assert.equal((await api(`/api/connections/${connection.id}/login`)).body.status, 'pending');

  // What the browser does after the owner approves.
  const finished = await plain(callback);
  assert.equal(finished.status, 200); assert.match(finished.body, /ChatGPT is connected/);
  assert.equal(finished.headers.connection, 'close');
  assert.doesNotMatch(finished.body, /guide\.css|href="\/"/, 'the standalone page links nothing the callback listener does not serve');
  assert.equal(issuer.exchanges.length, 1); assert.equal(issuer.exchanges[0].redirect_uri, redirect, 'the code exchange repeats the exact redirect URI');
  const status = (await api(`/api/connections/${connection.id}/login`)).body;
  assert.equal(status.status, 'connected'); assert.equal(status.account.subject, 'fixture-account');
  await eventually(() => refused(`${callbackBase}/auth/callback`), 'the callback listener to close once nothing is pending');

  // A cancelled sign-in closes it as well.
  const again = await api(`/api/connections/${connection.id}/login`, { method: 'POST', data: {} });
  assert.equal(new URL(again.body.authUrl).searchParams.get('redirect_uri'), redirect);
  assert.equal((await plain(`${callbackBase}/`)).status, 404);
  assert.equal((await api(`/api/connections/${connection.id}/login`, { method: 'DELETE' })).status, 200);
  await eventually(() => refused(`${callbackBase}/auth/callback`), 'the callback listener to close after cancellation');
});

test('an engine without its own TLS keeps the same-port ChatGPT callback and opens no other listener', async t => {
  const issuer = await issuerFixture(t), callbackPort = await freePort();
  const mac = await engine(t, { options: { oauthIssuer: issuer.origin, allowTestOAuth: true, requestTimeout: 2000, oauthCallbackPort: callbackPort } });
  const setup = await plainRequest(`${mac.url}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: mac.app.bootstrapToken, password: 'fixture-workspace-password' }) });
  const headers = { Cookie: setup.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await setup.json()).csrf, 'Content-Type': 'application/json' };
  const connection = await (await plainRequest(`${mac.url}/api/connections`, { method: 'POST', headers, body: JSON.stringify({ name: 'ChatGPT', type: 'chatgpt' }) })).json();
  const start = await (await plainRequest(`${mac.url}/api/connections/${connection.id}/login`, { method: 'POST', headers, body: '{}' })).json();
  assert.equal(new URL(start.authUrl).searchParams.get('redirect_uri'), `http://127.0.0.1:${mac.port}/auth/callback`);
  assert.ok(await refused(`http://127.0.0.1:${callbackPort}/auth/callback`));
});

test('the loopback callback prefers its documented port, falls back when it is taken, stays open while held and closes when the last attempt expires', async t => {
  assert.equal(CALLBACK_PORT, 1455, "OpenAI's documented example port keeps SSH forwarding instructions predictable");
  const busy = net.createServer(); await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => busy.close(resolve)));
  let until = 0;
  const callback = new LoopbackCallback({ port: busy.address().port, pendingUntil: () => until, handle: (_req, res) => { res.writeHead(200); res.end('handled'); } });
  t.after(() => callback.close());
  const redirect = new URL(await callback.open());
  assert.equal(redirect.hostname, '127.0.0.1'); assert.equal(redirect.pathname, '/auth/callback');
  assert.notEqual(Number(redirect.port), busy.address().port, 'a taken port falls back to a free one');
  assert.equal(await callback.open(), redirect.href, 'one listener serves every attempt while any is pending');

  // Nothing is pending yet, but an attempt being registered holds it open: neither a settle nor a request closes it.
  callback.settle();
  assert.equal((await plain(redirect.href)).body, 'handled');
  callback.release();
  assert.equal((await plain(redirect.href)).body, 'handled');
  callback.release();
  await eventually(() => refused(redirect.href), 'the listener to close once released with nothing pending');

  // A pending attempt keeps it open until it expires; with no further request only the expiry timer can close it.
  until = Date.now() + 300;
  const pending = new URL(await callback.open()); callback.release();
  assert.equal((await plain(pending.href)).body, 'handled');
  await sleep(1500);
  assert.ok(await refused(pending.href), 'the listener closes by itself after the last attempt expired');

  until = Date.now() + 60_000;
  const reopened = new URL(await callback.open()); callback.release();
  assert.equal((await plain(reopened.href)).body, 'handled', 'a new sign-in opens it again');
  await callback.close();
  assert.ok(await refused(reopened.href));
});
