import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { createStudioServer, controlSocketPath, controlSocketLive } from '../server.mjs';
import { prepareControlDirectory, assertOwnedControlSocket } from '../lib/control.mjs';
import { Access, normalizeAddress, isPrivateAddress, addressBucket, WindowCounter } from '../lib/access.mjs';
import { PAIR_MESSAGE, SESSION_MESSAGE } from '../lib/sync/crypto.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_HOST = 'studio.example.com', PASSWORD = 'fixture-workspace-password';
const run = promisify(execFile);
const fakeRequest = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers: { host: PUBLIC_HOST, ...headers } });

async function engine(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-access-'));
  const app = await createStudioServer({ dataDir: directory, scheduler: false, logErrors: false, publicUrl: `https://${PUBLIC_HOST}` });
  const { port, url } = await app.listen(0);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); await fs.rm(directory, { recursive: true, force: true }); });
  /** Plain HTTP so tests can set Host and X-Forwarded-For the way a reverse proxy does. Without `from`, the request is local. */
  const call = (route, { method = 'GET', from, cookie, csrf, bearer, data } = {}) => new Promise((resolve, reject) => {
    const payload = data === undefined ? null : Buffer.from(JSON.stringify(data));
    const headers = { Host: from ? PUBLIC_HOST : `127.0.0.1:${port}`, ...(from ? { 'X-Forwarded-For': from } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) };
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let body; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode, body, headers: res.headers }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
  const cookieOf = result => result.headers['set-cookie'][0].split(';')[0];
  async function setup() {
    const result = await call('/api/setup', { method: 'POST', data: { token: app.bootstrapToken, password: PASSWORD } });
    assert.equal(result.status, 201);
    return { cookie: cookieOf(result), csrf: result.body.csrf };
  }
  async function pairDevice(from) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), signer = message => sign('sha256', Buffer.from(message), privateKey).toString('base64');
    const { code } = app.sync.devices.createPairing({ kind: 'device', baseUrl: `https://${PUBLIC_HOST}` });
    const paired = await call('/api/pair', { method: 'POST', from, data: { v: 1, code, kind: 'device', name: 'Fixture phone', platform: 'ios', publicKey: key, proof: signer(PAIR_MESSAGE(code, key)) } });
    assert.equal(paired.status, 201, JSON.stringify(paired.body));
    const deviceId = paired.body.deviceId;
    const signIn = (via = from) => { const timestamp = Date.now(), nonce = randomBytes(16).toString('base64url'),engineNodeId=app.sync.nodeId,engineFingerprint=app.sync.identity.fingerprint; return call('/api/device/session', { method: 'POST', from: via, data: {v:2,engineNodeId,engineFingerprint, deviceId, timestamp, nonce, signature: signer(SESSION_MESSAGE(engineNodeId,engineFingerprint,deviceId,timestamp,nonce)) } }); };
    return { deviceId, signIn };
  }
  return { app, port, url, directory, call, cookieOf, setup, pairDevice, close };
}

test('client addresses come from trusted proxies only and classify private networks', async () => {
  assert.equal(normalizeAddress('::ffff:10.1.2.3'), '10.1.2.3');
  assert.equal(normalizeAddress('203.0.113.9:4431'), '203.0.113.9');
  assert.equal(normalizeAddress('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(normalizeAddress('not an address'), null);
  for (const address of ['127.0.0.1', '::1', '10.0.0.8', '172.20.1.1', '192.168.1.20', '100.101.102.103', 'fd7a:115c:a1e0::1', 'fe80::1']) assert.equal(isPrivateAddress(address), true, address);
  for (const address of ['8.8.8.8', '203.0.113.9', '2001:4860:4860::8888', '172.32.0.1', 'garbage', '']) assert.equal(isPrivateAddress(address), false, address);

  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-access-unit-'));
  try {
    const loopback = await new Access(directory, { publicHost: PUBLIC_HOST }).init();
    // The last hop is the one the proxy appended; anything before it may be forged by the client.
    const proxied = fakeRequest('127.0.0.1', { 'x-forwarded-for': '10.0.0.5, 198.51.100.7' });
    assert.equal(loopback.client(proxied), '198.51.100.7'); assert.equal(loopback.isPublic(proxied), true);
    const direct = fakeRequest('203.0.113.5', { 'x-forwarded-for': '10.0.0.1', host: 'other' });
    assert.equal(loopback.client(direct), '203.0.113.5'); assert.equal(loopback.isPublic(direct), true);
    assert.equal(loopback.isPublic(fakeRequest('127.0.0.1', { 'x-forwarded-for': '100.101.102.103' })), false, 'a tailnet client through tailscale serve is private');
    assert.equal(loopback.isPublic(fakeRequest('127.0.0.1', { host: '127.0.0.1:4310' })), false, 'an SSH tunnel is private');
    assert.equal(loopback.isPublic(fakeRequest('127.0.0.1')), true, 'the public host name without a proxy report is treated as the internet');
    assert.equal(loopback.client(fakeRequest('127.0.0.1', { 'x-forwarded-for': 'nonsense' })), 'unknown');
    assert.equal(loopback.isPublic(fakeRequest('127.0.0.1', { 'x-forwarded-for': 'nonsense' })), true);
    const container = fakeRequest('172.18.0.1', { 'x-forwarded-for': '203.0.113.40' });
    assert.equal(loopback.client(container), '172.18.0.1', 'loopback trust ignores a container gateway');
    assert.equal(loopback.isPublic(container), true, 'but the public host name still counts as the internet');
    const docker = await new Access(directory, { trustProxy: 'private', publicHost: PUBLIC_HOST }).init();
    assert.equal(docker.client(container), '203.0.113.40');
    assert.throws(() => new Access(directory, { trustProxy: 'everyone' }), /STUDIO_TRUSTED_PROXY/);

    // Many failed passwords from the internet pause internet password sign-in only, wherever they come from.
    const publicRequest = fakeRequest('127.0.0.1', { 'x-forwarded-for': '203.0.113.50' }), privateRequest = fakeRequest('127.0.0.1', { host: 'localhost:4310' });
    assert.throws(() => loopback.checkPassword(publicRequest), error => error.status === 403 && /npm run pair/.test(error.message));
    await loopback.setPublicPassword(true);
    // Each attempt holds its place before the password is checked, so concurrent guesses cannot all slip under the cap.
    const pending = Array.from({ length: 50 }, (_, index) => loopback.checkPassword(fakeRequest('127.0.0.1', { 'x-forwarded-for': `203.0.113.${index}` })));
    assert.throws(() => loopback.checkPassword(publicRequest), error => error.status === 429);
    pending[0](); pending[0]();
    const refunded = loopback.checkPassword(publicRequest);
    assert.throws(() => loopback.checkPassword(publicRequest), error => error.status === 429, 'a refund is returned once');
    refunded();
    assert.doesNotThrow(() => loopback.checkPassword(privateRequest));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'access.json'), 'utf8')), { publicPassword: true });
    assert.equal((await new Access(directory).init()).settings.publicPassword, true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('the internet address accepts paired apps only until the owner allows the password', async t => {
  const studio = await engine(t), publicIp = '203.0.113.10';
  const auth = await studio.call('/api/auth', { from: publicIp });
  assert.equal(auth.body.passwordSignIn, false);
  assert.equal((await studio.call('/api/auth')).body.passwordSignIn, true);
  const blockedSetup = await studio.call('/api/setup', { method: 'POST', from: publicIp, data: { token: studio.app.bootstrapToken, password: PASSWORD } });
  assert.equal(blockedSetup.status, 403); assert.match(blockedSetup.body.error, /npm run pair/);

  const local = await studio.setup();
  assert.equal((await studio.call('/api/login', { method: 'POST', from: publicIp, data: { password: PASSWORD } })).status, 403);
  assert.equal((await studio.call('/api/state', { cookie: local.cookie })).status, 200);
  assert.equal((await studio.call('/api/state', { from: publicIp, cookie: local.cookie })).status, 401, 'a password session does not carry over to the internet address');
  assert.equal((await studio.call('/api/auth', { from: publicIp, cookie: local.cookie })).body.authenticated, false);

  // Paired apps sign in from anywhere and can open a web session there.
  const phone = await studio.pairDevice(publicIp);
  const session = await phone.signIn();
  assert.equal(session.status, 200);
  const bearer = session.body.token;
  assert.equal((await studio.call('/api/state', { from: publicIp, bearer })).status, 200);
  const ticket = await studio.call('/api/device/web-ticket', { method: 'POST', from: publicIp, bearer, data: {} });
  const opened = await studio.call(ticket.body.path, { from: publicIp });
  assert.equal(opened.status, 302);
  assert.equal((await studio.call('/api/state', { from: publicIp, cookie: studio.cookieOf(opened) })).status, 200);

  const status = await studio.call('/api/sync/status', { from: publicIp, bearer });
  assert.deepEqual(status.body.access, { publicPassword: false, trustProxy: 'loopback', public: true });
  assert.equal((await studio.call('/api/access', { method: 'PATCH', from: publicIp, bearer, data: { publicPassword: 'yes' } })).status, 400);
  const allowed = await studio.call('/api/access', { method: 'PATCH', from: publicIp, bearer, data: { publicPassword: true } });
  assert.equal(allowed.status, 200); assert.equal(allowed.body.publicPassword, true);
  assert.equal((await studio.call('/api/auth', { from: publicIp })).body.passwordSignIn, true);
  assert.equal((await studio.call('/api/state', { from: publicIp, cookie: local.cookie })).status, 200);
  assert.equal((await studio.call('/api/login', { method: 'POST', from: publicIp, data: { password: PASSWORD } })).status, 200);
  assert.ok(studio.app.store.state.activity.some(event => event.type === 'security.public-password'));
  // Changing it back with a cookie session follows the usual CSRF rule.
  assert.equal((await studio.call('/api/access', { method: 'PATCH', cookie: local.cookie, data: { publicPassword: false } })).status, 403);
  assert.equal((await studio.call('/api/access', { method: 'PATCH', cookie: local.cookie, csrf: local.csrf, data: { publicPassword: false } })).status, 200);
  assert.equal((await studio.call('/api/state', { from: publicIp, cookie: local.cookie })).status, 401);
});

test('sign-in limits follow the real client behind a proxy, so strangers cannot lock out your devices', async t => {
  const studio = await engine(t);
  await studio.setup();
  await studio.app.access.setPublicPassword(true);
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await studio.call('/api/login', { method: 'POST', from: '203.0.113.20', data: { password: 'wrong-password-attempt' } })).status, 401);
  assert.equal((await studio.call('/api/login', { method: 'POST', from: '203.0.113.20', data: { password: PASSWORD } })).status, 429);
  assert.equal((await studio.call('/api/login', { method: 'POST', from: '203.0.113.21', data: { password: PASSWORD } })).status, 200, 'another client is unaffected');
  assert.equal((await studio.call('/api/login', { method: 'POST', data: { password: PASSWORD } })).status, 200, 'local sign-in is unaffected');

  const phone = await studio.pairDevice('198.51.100.77');
  for (let attempt = 0; attempt < 30; attempt++) {
    const timestamp = Date.now(), nonce = randomBytes(16).toString('base64url');
    assert.equal((await studio.call('/api/device/session', { method: 'POST', from: '198.51.100.66', data: {v:2,engineNodeId:studio.app.sync.nodeId,engineFingerprint:studio.app.sync.identity.fingerprint, deviceId: phone.deviceId, timestamp, nonce, signature: Buffer.alloc(70).toString('base64') } })).status, 401);
  }
  const bogus = await studio.call('/api/device/session', { method: 'POST', from: '198.51.100.66', data: { deviceId: 'dev_unknown', timestamp: Date.now(), nonce: randomBytes(16).toString('base64url'), signature: 'AA==' } });
  assert.equal(bogus.status, 429);
  assert.equal((await phone.signIn('198.51.100.77')).status, 200, 'the paired phone still signs in from its own network');
  // Each device is limited separately as well.
  let last;
  for (let attempt = 0; attempt < 30; attempt++) last = await phone.signIn('198.51.100.77');
  assert.equal(last.status, 429);
});

test('npm run pair creates pairing links through the private control socket', async t => {
  const studio = await engine(t), file = controlSocketPath(studio.directory);
  await studio.app.openControl(file, studio.url);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(await controlSocketLive(file), true);
  await assert.rejects(studio.app.openControl(file, studio.url), /already using this data directory/);
  const env = { ...process.env, STUDIO_DATA_DIR: studio.directory };

  const { stdout } = await run(process.execPath, ['scripts/pair.mjs'], { cwd: ROOT, env });
  const link = stdout.match(/hermes-studio:\/\/pair\?\S+/)?.[0];
  assert.ok(link, stdout);
  const params = new URL(link).searchParams;
  assert.equal(params.get('url'), `https://${PUBLIC_HOST}`); assert.equal(params.get('kind'), 'device');
  assert.match(stdout, /Server code [A-Z0-9_-]{4} [A-Z0-9_-]{4}/i); assert.doesNotMatch(stdout, /cannot reach/);
  // The printed link really pairs a device.
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const code = params.get('code'), proof = sign('sha256', Buffer.from(PAIR_MESSAGE(code, key)), privateKey).toString('base64');
  assert.equal((await studio.call('/api/pair', { method: 'POST', from: '203.0.113.30', data: { v: 1, code, kind: 'device', name: 'Shell-paired phone', platform: 'ios', publicKey: key, proof } })).status, 201);

  const engineLink = (await run(process.execPath, ['scripts/pair.mjs', '--engine'], { cwd: ROOT, env })).stdout.match(/hermes-studio:\/\/pair\?\S+/)[0];
  assert.equal(new URL(engineLink).searchParams.get('kind'), 'engine');
  const local = (await run(process.execPath, ['scripts/pair.mjs', '--url', 'http://example.com'], { cwd: ROOT, env }).catch(error => error));
  assert.equal(local.code, 1); assert.match(local.stderr, /HTTPS/);

  await studio.close();
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  const stopped = await run(process.execPath, ['scripts/pair.mjs'], { cwd: ROOT, env }).catch(error => error);
  assert.equal(stopped.code, 1); assert.match(stopped.stderr, /not running/);
});

test('a data directory too deep for a Unix socket gets a private per-user socket directory', async t => {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'studio-deep-')), deep = path.join(base, 'a'.repeat(60), 'b'.repeat(60));
  // One hook, close first: a failing after hook skips the ones after it, and an open server would keep the run alive.
  let app;
  t.after(async () => { try { await app?.close(); } finally { await fs.rm(base, { recursive: true, force: true }); } });
  const file = controlSocketPath(deep);
  assert.match(file, /^\/tmp\/hermes-studio-[\w-]+\/[0-9a-f]{24}\.sock$/);
  assert.equal(controlSocketPath(`${deep}/`), file, 'the same data directory always maps to the same socket');
  assert.equal(controlSocketPath(base), path.join(base, 'control.sock'));
  app = await createStudioServer({ dataDir: deep, scheduler: false, logErrors: false });
  const { url } = await app.listen(0);
  await app.openControl(file, url);
  assert.equal(((await fs.stat(path.dirname(file))).mode & 0o777), 0o700);
  const { stdout } = await run(process.execPath, ['scripts/pair.mjs'], { cwd: ROOT, env: { ...process.env, STUDIO_DATA_DIR: deep } });
  assert.match(stdout, /hermes-studio:\/\/pair\?/);
  assert.match(stdout, /other devices cannot reach/, 'a loopback-only link says so');
  const loose = path.join(base, 'shared'); await fs.mkdir(loose, { mode: 0o755 }); await fs.chmod(loose, 0o755);
  await assert.rejects(prepareControlDirectory(path.join(loose, 'control.sock')), /private directory/);
});

test('unauthenticated limits group IPv6 by /64 and keep bounded memory under a flood of new addresses', () => {
  assert.equal(addressBucket('2001:db8:1:2:aaaa::1'), addressBucket('[2001:db8:1:2:ffff:ffff:ffff:ffff]:443'));
  assert.notEqual(addressBucket('2001:db8:1:2::1'), addressBucket('2001:db8:1:3::1'));
  assert.equal(addressBucket('::ffff:203.0.113.7'), '203.0.113.7');assert.equal(addressBucket('not an address'), 'unknown');
  const counter = new WindowCounter(100);
  for (let index = 0; index < 5000; index++) counter.add(`client-${index}`, 60_000);
  assert.equal(counter.size, 100);assert.equal(counter.count('client-4999'), 1);assert.equal(counter.count('client-0'), 0);
  counter.add('client-4999', 60_000);assert.equal(counter.count('client-4999'), 2);
  const expiring = new WindowCounter();
  for (let index = 0; index < 50; index++) expiring.add(`old-${index}`, -1);
  expiring.add('fresh', 60_000);
  assert.equal(expiring.size, 1, 'expired windows are swept from the front');
});

test('the pairing command only talks to a private socket owned by this account', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-sock-')), file = path.join(directory, 'control.sock');
  const server = http.createServer(); await new Promise(resolve => server.listen(file, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  await fs.chmod(directory, 0o700); await assert.doesNotReject(assertOwnedControlSocket(file));
  await fs.chmod(directory, 0o755); await assert.rejects(assertOwnedControlSocket(file), error => error.status === 403);
  await fs.chmod(directory, 0o700); await fs.writeFile(path.join(directory, 'plain'), '');
  await assert.rejects(assertOwnedControlSocket(path.join(directory, 'plain')), error => error.status === 403);
  await assert.rejects(assertOwnedControlSocket(path.join(directory, 'missing.sock')), error => error.code === 'ENOENT');
});
