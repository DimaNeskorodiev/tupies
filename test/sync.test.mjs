import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { createStudioServer } from '../server.mjs';
import { verifyMessage, fingerprint, PAIR_MESSAGE, PAIRED_MESSAGE, SESSION_MESSAGE } from '../lib/sync/crypto.mjs';
import { Clock, GENESIS, compareStamps } from '../lib/sync/clock.mjs';
import { parseKey, listDocuments, writeDocument, botOf } from '../lib/sync/docs.mjs';
import { sessionIdFor, removeBotSessions } from '../lib/sessions.mjs';

const KEY = 'studio-sync-fixture-key-never-public';
const answer = text => ({ id: 'response-fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 5 } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch (error) { last = error; } await sleep(40); }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function provider(t) {
  const remote = { handler: () => answer('Synced fixture answer.') };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return; }
    if (req.url === '/v1/responses') { res.end(JSON.stringify(await remote.handler(input))); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { remote, url: `http://127.0.0.1:${server.address().port}/v1` };
}

async function engine(t, { directory, name } = {}) {
  directory ||= await fs.mkdtemp(path.join(tmpdir(), 'studio-sync-'));
  const app = await createStudioServer({ dataDir: directory, scheduler: false, logErrors: false, sync: { longPollMs: 1500, fileScanInterval: 300, engineName: name } });
  const { url } = await app.listen(0); let cookie = '', csrf = '', closed = false;
  async function request(route, { method = 'GET', data, headers = {}, security = true, bearer } = {}) {
    const response = await fetch(`${url}${route}`, { method, redirect: 'manual', headers: { ...(cookie && !bearer ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(security && csrf && !bearer ? { 'X-CSRF-Token': csrf } : {}), ...headers }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, response };
  }
  async function setup() {
    const result = await request('/api/setup', { method: 'POST', data: { token: app.bootstrapToken, password: 'fixture-workspace-password' } });
    assert.equal(result.status, 201); cookie = result.response.headers.get('set-cookie').split(';')[0]; csrf = result.body.csrf;
  }
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { app, url, directory, request, setup, close };
}

function device() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { publicKey: der, sign: message => sign('sha256', Buffer.from(message), privateKey).toString('base64') };
}
const linkParams = link => Object.fromEntries(new URL(link).searchParams);
async function pairDevice(target, link, key = device(), extra = {}) {
  const { code } = linkParams(link);
  return { key, result: await target.request('/api/pair', { method: 'POST', data: { v: 1, code, kind: 'device', name: 'Fixture iPhone', platform: 'ios', publicKey: key.publicKey, proof: key.sign(PAIR_MESSAGE(code, key.publicKey)), ...extra } }) };
}
async function deviceSession(target, deviceId, key, overrides = {}) {
  const timestamp = Date.now(), nonce = randomBytes(16).toString('base64url');
  const engineNodeId=target.app.sync.nodeId,engineFingerprint=target.app.sync.identity.fingerprint;
  return target.request('/api/device/session', { method: 'POST', data: {v:2,engineNodeId,engineFingerprint, deviceId, timestamp, nonce, signature: key.sign(SESSION_MESSAGE(engineNodeId,engineFingerprint,deviceId,timestamp,nonce)), ...overrides } });
}
async function link(hub, replica) {
  const pairing = await hub.request('/api/pairing', { method: 'POST', data: { kind: 'engine' } });
  assert.equal(pairing.status, 201, JSON.stringify(pairing.body));
  const connected = await replica.request('/api/sync/connect', { method: 'POST', data: { link: pairing.body.link } });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  return connected.body;
}

test('hybrid clock stamps order causally and document keys stay inside replicated collections', () => {
  let time = 1000;
  const clock = new Clock('node_a', () => time), first = clock.now(), second = clock.now();
  assert.equal(compareStamps(second, first), 1);
  assert.equal(compareStamps(first, GENESIS), 1);
  time = 900; assert.equal(compareStamps(clock.now(), second), 1, 'a clock that goes backwards still moves forward');
  assert.equal(clock.observe(new Clock('node_b', () => time + 3_600_000).now()), false, 'stamps far in the future are refused');
  assert.deepEqual(parseKey('msg:bot_atlas:message_1'), { kind: 'msg', owner: 'bot_atlas', id: 'message_1' });
  assert.equal(parseKey('file:workspaces/bot_atlas/../state.json'), null);
  assert.equal(parseKey('file:data/state.json'), null);
  assert.equal(parseKey('password'), null);
  assert.equal(parseKey('runs:bot_atlas'), null);
});

test('device pairing proves both identities, issues short sessions and revocation ends access', async t => {
  const hub = await engine(t, { name: 'Home server' });
  await hub.setup();
  const info = (await hub.request('/api/engine')).body;
  assert.equal(info.product, 'hermes-studio'); assert.equal(info.fingerprint, fingerprint(info.publicKey)); assert.equal(info.name, 'Home server');
  const pairing = (await hub.request('/api/pairing', { method: 'POST', data: {} })).body;
  assert.match(pairing.link, /^hermes-studio:\/\/pair\?/); assert.match(pairing.qrSvg, /^<svg[^>]*>/);
  assert.match(pairing.link, /&name=Home%20server&/, 'links are percent-encoded');
  const params = linkParams(pairing.link);
  assert.equal(params.fp, info.fingerprint); assert.equal(params.kind, 'device'); assert.equal(params.url, hub.url);

  const key = device(), wrong = device();
  const badProof = await hub.request('/api/pair', { method: 'POST', data: { v: 1, code: params.code, kind: 'device', name: 'Thief', platform: 'ios', publicKey: key.publicKey, proof: wrong.sign(PAIR_MESSAGE(params.code, key.publicKey)) } });
  assert.equal(badProof.status, 403);
  const { result } = await pairDevice(hub, pairing.link, key);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.ok(verifyMessage(info.publicKey, PAIRED_MESSAGE(result.body.deviceId, key.publicKey), result.body.engineProof), 'the engine signs the paired identity');
  assert.equal(result.body.workspaceKey, undefined, 'apps never receive the engine workspace key');
  assert.equal((await pairDevice(hub, pairing.link)).result.status, 403, 'pairing codes are single use');

  const deviceId = result.body.deviceId;
  assert.equal((await deviceSession(hub, deviceId, wrong)).status, 401);
  assert.equal((await deviceSession(hub, deviceId, key, { timestamp: Date.now() - 3_600_000 })).status, 400);
  const timestamp = Date.now(), nonce = randomBytes(16).toString('base64url'),engineNodeId=hub.app.sync.nodeId,engineFingerprint=hub.app.sync.identity.fingerprint,signed = {v:2,engineNodeId,engineFingerprint, deviceId, timestamp, nonce, signature: key.sign(SESSION_MESSAGE(engineNodeId,engineFingerprint,deviceId,timestamp,nonce)) };
  const session = await hub.request('/api/device/session', { method: 'POST', data: signed });
  assert.equal(session.status, 200); assert.match(session.body.token, /^hsd_/);
  assert.equal((await hub.request('/api/device/session', { method: 'POST', data: signed })).status, 401, 'a signed session request cannot be replayed');
  const token = session.body.token;

  assert.equal((await hub.request('/api/state', { bearer: token })).status, 200);
  const created = await hub.request('/api/bots', { method: 'POST', data: { name: 'Pocket', title: 'Created from the phone' }, bearer: token });
  assert.equal(created.status, 201, 'bearer sessions need no browser CSRF token');
  assert.equal((await hub.request('/api/state', { bearer: 'hsd_' + 'x'.repeat(43) })).status, 401);
  assert.equal((await hub.request('/api/sync/exchange', { method: 'POST', bearer: token, headers: { 'Content-Type': 'application/octet-stream' } })).status, 403, 'apps cannot use engine replication routes');

  const ticket = await hub.request('/api/device/web-ticket', { method: 'POST', data: {}, bearer: token });
  assert.equal(ticket.status, 200);
  const opened = await fetch(`${hub.url}${ticket.body.path}`, { redirect: 'manual' });
  assert.equal(opened.status, 302); assert.equal(opened.headers.get('location'), '/');
  const webCookie = opened.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await fetch(`${hub.url}/api/auth`, { headers: { Cookie: webCookie } })).json()).authenticated, true);
  assert.equal((await fetch(`${hub.url}${ticket.body.path}`, { redirect: 'manual' })).status, 401, 'web tickets are single use');

  const listed = (await hub.request('/api/devices')).body.devices;
  assert.equal(listed.length, 1); assert.equal(listed[0].publicKey, undefined); assert.equal(listed[0].kind, 'device');
  assert.equal((await hub.request(`/api/devices/${deviceId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await hub.request('/api/state', { bearer: token })).status, 401, 'revocation ends the current session');
  assert.equal((await (await fetch(`${hub.url}/api/auth`, { headers: { Cookie: webCookie } })).json()).authenticated, false, 'revocation also ends the web view session it opened');
  assert.equal((await hub.request('/api/state')).status, 200, 'the password session is unaffected');
  assert.equal((await deviceSession(hub, deviceId, key)).status, 401);

  const engineLink = (await hub.request('/api/pairing', { method: 'POST', data: { kind: 'engine' } })).body.link;
  assert.equal((await pairDevice(hub, engineLink)).result.status, 403, 'an app cannot use an engine link');
  assert.equal((await hub.request('/api/pairing', { method: 'POST', data: { url: 'http://192.168.1.20:4310' } })).status, 400, 'plain HTTP links to other hosts are refused');
});

test('linked engines replicate bots, chats, memory, providers, devices and notes in both directions', async t => {
  const model = await provider(t);
  const hub = await engine(t, { name: 'Home server' }), replica = await engine(t, { name: 'Tupies Mac' });
  await hub.setup(); await replica.setup();
  // The Mac already has a provider, a custom bot and a remembered fact before it links.
  const connection = await replica.request('/api/connections', { method: 'POST', data: { name: 'Direct fixture provider', type: 'openai', baseUrl: model.url, apiKey: KEY, defaultModel: 'fixture-model' } });
  assert.equal(connection.status, 201, JSON.stringify(connection.body));
  const custom = (await replica.request('/api/bots', { method: 'POST', data: { name: 'Mira', title: 'Mac-made helper' } })).body;
  await replica.app.store.mutate(state => { state.memory.bot_atlas = [{ id: 'memory_fixture', key: 'favourite tea', value: 'Sencha', updatedAt: new Date().toISOString() }]; });

  const status = await link(hub, replica);
  assert.equal(status.node.role, 'replica'); assert.equal(status.hub.name, 'Home server');
  await eventually(() => hub.app.store.state.bots.some(bot => bot.id === custom.id), 'the Mac bot on the home server');
  await eventually(() => hub.app.store.state.memory.bot_atlas?.[0]?.value === 'Sencha', 'memory on the home server');
  const hubConnection = await eventually(() => hub.app.store.state.connections.find(item => item.id === connection.body.id), 'provider on the home server');
  assert.notDeepEqual(hub.app.store.key, replica.app.store.key, 'each engine keeps its own vault key');
  assert.equal(hub.app.store.unseal(hubConnection.secret), KEY, 'the API key is re-sealed with the home server vault');
  assert.equal(hub.app.sync.role(), 'hub'); assert.equal(hub.app.sync.runsAutomation(), true); assert.equal(replica.app.sync.runsAutomation(), false);
  assert.ok(!(await fs.readFile(path.join(hub.directory, 'sync', 'meta.json'), 'utf8')).includes(KEY), 'sync metadata never stores secrets');

  // A chat on the home server streams to the Mac, and the bot cannot start on both engines at once.
  let release; const gate = new Promise(resolve => { release = resolve; });
  model.remote.handler = async () => { await gate; return answer('Answer from the home server.'); };
  assert.equal((await hub.request('/api/bots/bot_atlas/messages', { method: 'POST', data: { text: 'Plan my week' } })).status, 202);
  await eventually(() => replica.app.sync.busyElsewhere('bot_atlas'), 'presence of the active run on the Mac');
  const blocked = await replica.request('/api/bots/bot_atlas/messages', { method: 'POST', data: { text: 'Also plan this' } });
  assert.equal(blocked.status, 409); assert.match(blocked.body.error, /working on Home server/);
  assert.equal((await replica.request('/api/state')).body.sync.busy.bot_atlas, 'Home server');
  release();
  await eventually(() => (replica.app.store.state.messages.bot_atlas || []).some(message => message.content === 'Answer from the home server.'), 'the answer on the Mac');
  await eventually(() => !replica.app.sync.busyElsewhere('bot_atlas'), 'presence cleared after the run');
  assert.ok(replica.app.store.state.conversations.bot_atlas.some(item => item.role === 'user' && item.content === 'Plan my week'), 'model history replicates too');
  assert.equal(replica.app.store.state.runs.bot_atlas, undefined, 'runs stay with the engine that executed them');

  // Then the Mac can continue the same conversation, and the home server sees it.
  model.remote.handler = () => answer('Answer from the Mac.');
  assert.equal((await replica.request('/api/bots/bot_atlas/messages', { method: 'POST', data: { text: 'Thanks, now from the Mac' } })).status, 202);
  await eventually(() => (hub.app.store.state.messages.bot_atlas || []).some(message => message.content === 'Answer from the Mac.'), 'the Mac answer on the home server');
  const order = hub.app.store.state.messages.bot_atlas.map(message => message.content);
  assert.deepEqual(order.slice(-4), ['Plan my week', 'Answer from the home server.', 'Thanks, now from the Mac', 'Answer from the Mac.']);

  // Long-term notes and skills are files; both directions apply atomically.
  const note = path.join(hub.directory, 'workspaces', 'bot_atlas', 'brain', 'projects', 'launch.md');
  await fs.mkdir(path.dirname(note), { recursive: true }); await fs.writeFile(note, '# Launch\n\nShip on Friday.\n');
  const mirrored = path.join(replica.directory, 'workspaces', 'bot_atlas', 'brain', 'projects', 'launch.md');
  await eventually(async () => (await fs.readFile(mirrored, 'utf8').catch(() => '')).includes('Friday'), 'the note on the Mac');
  await fs.writeFile(mirrored, '# Launch\n\nShip on Monday instead.\n');
  await eventually(async () => (await fs.readFile(note, 'utf8')).includes('Monday'), 'the edited note on the home server');
  await fs.rm(mirrored);
  await eventually(async () => !(await fs.stat(note).catch(() => null)), 'the deletion on the home server');
  await fs.mkdir(path.join(hub.directory, 'workspaces', 'bot_atlas', 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(hub.directory, 'workspaces', 'bot_atlas', 'node_modules', 'pkg', 'index.js'), 'ignored');
  await fs.writeFile(path.join(hub.directory, 'workspaces', 'bot_atlas', 'marker.txt'), 'after');
  await eventually(() => fs.stat(path.join(replica.directory, 'workspaces', 'bot_atlas', 'marker.txt')), 'the marker on the Mac');
  assert.equal(await fs.stat(path.join(replica.directory, 'workspaces', 'bot_atlas', 'node_modules')).catch(() => null), null, 'dependency folders are not replicated');

  // A device paired once with the home server can sign in on the Mac engine too; revocation also replicates.
  const pairing = (await hub.request('/api/pairing', { method: 'POST', data: {} })).body;
  const { key, result } = await pairDevice(hub, pairing.link);
  assert.equal(result.status, 201);
  await eventually(async () => (await deviceSession(replica, result.body.deviceId, key)).status === 200, 'the paired device on the Mac');
  await hub.request(`/api/devices/${result.body.deviceId}`, { method: 'DELETE' });
  await eventually(async () => (await deviceSession(replica, result.body.deviceId, key)).status === 401, 'the revocation on the Mac');

  // Edits from the Mac's settings reach the home server, and engine sessions cannot browse the workspace API.
  await replica.request(`/api/bots/${custom.id}`, { method: 'PATCH', data: { name: 'Mira', title: 'Renamed on the Mac' } });
  await eventually(() => hub.app.store.state.bots.find(bot => bot.id === custom.id)?.title === 'Renamed on the Mac', 'the renamed bot on the home server');
  const engineDevice = hub.app.store.state.devices.find(item => item.kind === 'engine');
  assert.equal(engineDevice.nodeId, replica.app.sync.nodeId);
  const hubStatus = (await hub.request('/api/sync/status')).body;
  assert.equal(hubStatus.node.role, 'hub'); assert.ok(hubStatus.engines.some(item => item.nodeId === replica.app.sync.nodeId && item.name === 'Tupies Mac'));
});

test('linked engines share terminal dashboard outcomes while execution and audit records stay local', async t => {
  const model = await provider(t);
  const hub = await engine(t, { name: 'Home server' }), replica = await engine(t, { name: 'Tupies Mac' });
  await hub.setup(); await replica.setup();
  const connection = await hub.request('/api/connections', { method: 'POST', data: { name: 'Timeline fixture provider', type: 'openai', baseUrl: model.url, apiKey: KEY, defaultModel: 'fixture-model' } });
  assert.equal(connection.status, 201);
  await link(hub, replica);
  await eventually(() => replica.app.store.state.connections.some(item => item.id === connection.body.id), 'the timeline provider on the Mac');

  model.remote.handler = () => answer('Finished on the home server.');
  assert.equal((await hub.request('/api/bots/bot_atlas/messages', { method: 'POST', data: { text: 'Finish the server task' } })).status, 202);
  const complete = await eventually(() => hub.app.store.state.runs.bot_atlas?.status === 'completed' && hub.app.store.state.runs.bot_atlas, 'the completed server task');

  // A provider failure before any output still needs a shared terminal row.
  model.remote.handler = () => ({ id: 'response-empty', status: 'completed', output: [] });
  assert.equal((await replica.request('/api/bots/bot_nova/messages', { method: 'POST', data: { text: 'Try a task with no provider output' } })).status, 202);
  const failed = await eventually(() => replica.app.store.state.runs.bot_nova?.status === 'failed' && replica.app.store.state.runs.bot_nova, 'the failed Mac task');
  assert.ok(!replica.app.store.state.messages.bot_nova.some(message => message.runId === failed.id && message.role === 'assistant'), 'zero output is not replaced by a fabricated reply');

  // An unfinished reply and its pending delete approval remain unfinished after Stop.
  model.remote.handler = () => ({ ...answer('Only a partial draft.'), output: [
    ...answer('Only a partial draft.').output,
    { type: 'function_call', call_id: 'timeline-delete', name: 'workspace_delete', arguments: JSON.stringify({ path: 'untouched.txt' }) },
  ] });
  assert.equal((await replica.request('/api/bots/bot_scout/messages', { method: 'POST', data: { text: 'Stop after a partial draft' } })).status, 202);
  const waiting = await eventually(() => replica.app.store.state.runs.bot_scout?.status === 'waiting_for_approval' && replica.app.store.state.runs.bot_scout, 'the exact local delete approval');
  await eventually(() => (hub.app.store.state.messages.bot_scout || []).some(message => message.runId === waiting.id), 'the pending task request on the home server');
  assert.equal(hub.app.store.state.runs.bot_scout, undefined, 'the pending approval is not copied to the other engine');
  assert.ok(!(await hub.request('/api/dashboard')).body.activity.some(item => item.id === `run:${waiting.id}`), 'a synced request alone never claims that a task finished');
  assert.equal((await replica.request('/api/bots/bot_scout/stop', { method: 'POST', data: { runId: waiting.id, remoteRunId: waiting.remoteRunId } })).status, 200);
  const cancelled = await eventually(() => replica.app.store.state.runs.bot_scout?.status === 'cancelled' && replica.app.store.state.runs.bot_scout, 'the stopped partial Mac task');
  const partial = replica.app.store.state.messages.bot_scout.find(message => message.runId === cancelled.id && message.role === 'assistant');
  assert.equal(partial.partial, true); assert.equal(partial.runStatus, 'cancelled');

  const expected = new Map([[complete.id, { status: 'completed', botId: 'bot_atlas', text: 'finished a task' }], [failed.id, { status: 'failed', botId: 'bot_nova', text: 'couldn’t finish a task' }], [cancelled.id, { status: 'cancelled', botId: 'bot_scout', text: 'stopped working on a task' }]]);
  const shared = await eventually(async () => {
    const left = (await hub.request('/api/dashboard')).body.activity, right = (await replica.request('/api/dashboard')).body.activity;
    if (left.length !== expected.size || right.length !== expected.size) return false;
    assert.deepEqual(left, right);
    return left;
  }, 'the same terminal timeline on both engines');
  for (const [runId, expectedRow] of expected) {
    const row = shared.find(item => item.id === `run:${runId}`);
    assert.ok(row, `the task ${runId} appears once`); assert.equal(row.text, expectedRow.text);
    const left = hub.app.store.state.messages[expectedRow.botId].find(message => message.runId === runId && message.role === 'user');
    const right = replica.app.store.state.messages[expectedRow.botId].find(message => message.runId === runId && message.role === 'user');
    assert.deepEqual(left.taskOutcome, right.taskOutcome); assert.equal(left.taskOutcome.status, expectedRow.status); assert.equal(row.at, left.taskOutcome.finishedAt);
  }
  assert.deepEqual(shared.map(item => item.at), shared.map(item => item.at).sort().reverse(), 'terminal timestamps determine order');
  assert.equal(replica.app.store.state.runs.bot_atlas, undefined);
  assert.equal(hub.app.store.state.runs.bot_nova, undefined);
  assert.equal(hub.app.store.state.runs.bot_scout, undefined);
  assert.ok(!(replica.app.store.state.runHistory?.bot_atlas || []).some(run => run.id === complete.id));
  assert.ok(!(hub.app.store.state.runHistory?.bot_nova || []).some(run => run.id === failed.id));
  assert.ok(!replica.app.store.state.activity.some(entry => entry.runId === complete.id), 'server audit events stay on the server');
  assert.ok(!hub.app.store.state.activity.some(entry => [failed.id, cancelled.id].includes(entry.runId)), 'Mac audit events stay on the Mac');
});

test('concurrent edits keep the newest version and a conflict copy for files', async t => {
  const hub = await engine(t, { name: 'Home server' }), replica = await engine(t, { name: 'Tupies Mac' });
  await hub.setup(); await replica.setup();
  await link(hub, replica);
  const note = rel => path.join(rel.directory, 'workspaces', 'bot_nova', 'brain', 'ideas.md');
  await fs.mkdir(path.dirname(note(hub)), { recursive: true }); await fs.writeFile(note(hub), 'first draft\n');
  await eventually(async () => (await fs.readFile(note(replica), 'utf8').catch(() => '')) === 'first draft\n', 'the shared note');
  await eventually(() => replica.app.sync.status().pending === 0 && replica.app.sync.peerStatus.connected, 'an idle link');

  await replica.app.sync.stopPeer();
  await replica.request('/api/bots/bot_nova', { method: 'PATCH', data: { name: 'Nova', title: 'Edited offline on the Mac' } });
  await fs.writeFile(note(replica), 'offline Mac edit\n');
  await replica.app.sync.scan();
  await sleep(20);
  await hub.request('/api/bots/bot_nova', { method: 'PATCH', data: { name: 'Nova', title: 'Edited later on the server' } });
  await fs.writeFile(note(hub), 'later server edit\n');
  await hub.app.sync.scan();
  replica.app.sync.startPeer();

  await eventually(() => replica.app.store.state.bots.find(bot => bot.id === 'bot_nova').title === 'Edited later on the server', 'newest bot edit on the Mac');
  assert.equal(hub.app.store.state.bots.find(bot => bot.id === 'bot_nova').title, 'Edited later on the server');
  await eventually(async () => (await fs.readFile(note(replica), 'utf8')) === 'later server edit\n', 'newest note on the Mac');
  const conflictIn = async target => (await fs.readdir(path.dirname(note(target)))).filter(name => name.includes('conflict'));
  const copies = await eventually(async () => { const names = await conflictIn(hub); return names.length === 1 && (await conflictIn(replica)).length === 1 && names; }, 'one conflict copy on both engines');
  assert.equal(await fs.readFile(path.join(path.dirname(note(hub)), copies[0]), 'utf8'), 'offline Mac edit\n');
  assert.match(copies[0], /^ideas \(conflict Tupies Mac .+\)\.md$/);
});

test('an established workspace wins over a freshly installed home server', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-sync-existing-'));
  {
    // Simulate a workspace created before sync existed: edit it, then remove the sync folder.
    const before = await createStudioServer({ dataDir: directory, scheduler: false, logErrors: false });
    await before.store.mutate(state => { state.bots.find(bot => bot.id === 'bot_atlas').title = 'My customised Atlas'; state.settings.defaultModel = 'mac-model'; });
    await before.close();
    await fs.rm(path.join(directory, 'sync'), { recursive: true });
  }
  const replica = await engine(t, { directory, name: 'Tupies Mac' }), hub = await engine(t, { name: 'Home server' });
  await hub.setup(); await replica.setup();
  await link(hub, replica);
  await eventually(() => hub.app.store.state.bots.find(bot => bot.id === 'bot_atlas').title === 'My customised Atlas', 'the Mac Atlas on the fresh server');
  await eventually(() => hub.app.store.state.settings.defaultModel === 'mac-model', 'Mac settings on the fresh server');
  assert.equal(replica.app.store.state.bots.find(bot => bot.id === 'bot_atlas').title, 'My customised Atlas');
  assert.equal(hub.app.store.state.bots.length, 3, 'seeded bots merge rather than duplicate');
});

test('engine links are sealed, single-purpose and refuse impersonation', async t => {
  const hub = await engine(t, { name: 'Home server' }), replica = await engine(t, { name: 'Tupies Mac' }), other = await engine(t, { name: 'Impostor' });
  await hub.setup(); await replica.setup(); await other.setup();
  const pairing = (await hub.request('/api/pairing', { method: 'POST', data: { kind: 'engine' } })).body;
  const forged = pairing.link.replace(encodeURIComponent(hub.url), encodeURIComponent(other.url));
  const refused = await replica.request('/api/sync/connect', { method: 'POST', data: { link: forged } });
  assert.equal(refused.status, 502); assert.match(refused.body.error, /identity does not match/);
  assert.equal(replica.app.sync.role(), 'standalone');
  const deviceLink = (await hub.request('/api/pairing', { method: 'POST', data: {} })).body.link;
  assert.equal((await replica.request('/api/sync/connect', { method: 'POST', data: { link: deviceLink } })).status, 400);
  assert.equal((await replica.request('/api/sync/connect', { method: 'POST', data: { link: pairing.link } })).status, 200);
  assert.equal((await replica.request('/api/pairing', { method: 'POST', data: { kind: 'engine' } })).status, 409, 'a linked engine cannot become a second hub');
  assert.equal((await hub.request('/api/sync/connect', { method: 'POST', data: { link: 'hermes-studio://pair?v=2&kind=engine' } })).status, 409, 'a hub cannot sync elsewhere');

  // The engine session can only replicate, and only with sealed payloads.
  await eventually(() => replica.app.sync.peer?.token, 'an engine session');
  const token = replica.app.sync.peer.token;
  assert.equal((await hub.request('/api/state', { bearer: token })).status, 403);
  const secureHeaders={'X-Tupies-Sync-Version':'2','X-Tupies-Key-Epoch':String(hub.app.sync.security.record.epoch)};
  const garbage = await fetch(`${hub.url}/api/sync/exchange`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream',...secureHeaders }, body: Buffer.from('{"node":"x","since":0}') });
  assert.equal(garbage.status, 400);
  const raw = await fetch(`${hub.url}/api/sync/blobs/${'0'.repeat(64)}`, { headers: { Authorization: `Bearer ${token}`,...secureHeaders } });
  assert.equal(raw.status, 404);

  await replica.request('/api/sync/disconnect', { method: 'POST', data: {} });
  assert.equal(replica.app.sync.role(), 'standalone');
  assert.equal(replica.app.store.state.bots.length, 3, 'disconnecting keeps local data');
});

test('only the home server spends a rotating ChatGPT refresh token; linked engines receive the renewal', async t => {
  let refreshes = 0;
  const issuer = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const origin = `http://127.0.0.1:${issuer.address().port}`, reply = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/.well-known/openid-configuration') return reply({ issuer: origin, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks` });
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    if (req.url === '/token' && params.get('grant_type') === 'refresh_token') {
      refreshes++; await sleep(150);
      assert.equal(params.get('refresh_token'), 'refresh-initial', 'a refresh token is never replayed');
      return reply({ access_token: 'access-renewed', refresh_token: 'refresh-replacement', expires_in: 3600, scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct' });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => issuer.listen(0, '127.0.0.1', resolve));
  t.after(async () => { issuer.closeAllConnections(); await new Promise(resolve => issuer.close(resolve)); });
  const oauth = { oauthIssuer: `http://127.0.0.1:${issuer.address().port}`, allowTestOAuth: true, requestTimeout: 2000 };
  const engineWith = async (name) => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-sync-oauth-'));
    const app = await createStudioServer({ dataDir: directory, scheduler: false, logErrors: false, ...oauth, sync: { longPollMs: 1500, fileScanInterval: 300, engineName: name } });
    const { url } = await app.listen(0);
    t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
    const setup = await fetch(`${url}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.bootstrapToken, password: 'fixture-workspace-password' }) });
    const cookie = setup.headers.get('set-cookie').split(';')[0], { csrf } = await setup.json();
    const request = async (route, data) => { const response = await fetch(`${url}${route}`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
    return { app, request };
  };
  const hub = await engineWith('Home server'), replica = await engineWith('Tupies Mac');
  const bundle = { access_token: 'access-initial', refresh_token: 'refresh-initial', client_id: 'issued-test-client', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() - 1000, savedAt: new Date().toISOString() };
  const connection = { ...hub.app.providers.validate({ name: 'ChatGPT', type: 'chatgpt' }), id: 'conn_chatgpt', status: 'connected', oauthAccount: { planEnabled: true, needsLogin: false }, oauthSecret: hub.app.store.seal(JSON.stringify(bundle)) };
  await hub.app.store.mutate(state => { state.connections.push(connection); });
  const pairing = await hub.request('/api/pairing', { kind: 'engine' });
  assert.equal((await replica.request('/api/sync/connect', { link: pairing.body.link })).status, 200);
  const mirrored = await eventually(() => replica.app.store.state.connections.find(item => item.id === 'conn_chatgpt'), 'the ChatGPT connection on the Mac');
  assert.equal(JSON.parse(replica.app.store.unseal(mirrored.oauthSecret)).refresh_token, 'refresh-initial');

  // Both engines need a token at the same moment; the renewal happens once, on the home server.
  const [onMac, onServer] = await Promise.all([replica.app.providers.oauth.bearer(mirrored), hub.app.providers.oauth.bearer(connection)]);
  assert.equal(onMac, 'access-renewed'); assert.equal(onServer, 'access-renewed');
  assert.equal(refreshes, 1);
  const renewed = JSON.parse(replica.app.store.unseal(replica.app.store.state.connections.find(item => item.id === 'conn_chatgpt').oauthSecret));
  assert.equal(renewed.refresh_token, 'refresh-replacement');
  assert.equal(await replica.app.providers.oauth.bearer(mirrored), 'access-renewed');
  assert.equal(refreshes, 1, 'a fresh renewed token is reused without another refresh');
});

test('a newer edit from an engine that missed a revocation cannot bring the device back', async t => {
  const hub = await engine(t, { name: 'Home server' }), replica = await engine(t, { name: 'Mac' });
  await hub.setup(); await replica.setup(); await link(hub, replica);
  const pairing = await hub.request('/api/pairing', { method: 'POST', data: { kind: 'device' } });
  const { key, result } = await pairDevice(hub, pairing.body.link), deviceId = result.body.deviceId;
  await eventually(() => replica.app.sync.devices.find(deviceId), 'device replicated');
  const session = await deviceSession(replica, deviceId, key);
  assert.equal(session.status, 200);
  await replica.app.sync.stopPeer();
  assert.equal((await hub.request(`/api/devices/${deviceId}`, { method: 'DELETE' })).status, 200);
  // Changes are stamped when sync scans them, so record the revocation now; the stolen device then renames itself on the
  // engine that has not heard of it yet, and that edit carries the newer stamp.
  await hub.app.sync.scan(); await sleep(20);
  assert.equal((await replica.request(`/api/devices/${deviceId}`, { method: 'PATCH', data: { name: 'Renamed after theft' }, bearer: session.body.token })).status, 200);
  replica.app.sync.startPeer();
  await eventually(() => !replica.app.sync.devices.find(deviceId), 'revocation reached the replica');
  assert.equal(hub.app.sync.devices.find(deviceId), undefined);
  assert.equal(hub.app.store.state.devices.find(item => item.id === deviceId).name, 'Renamed after theft');
  assert.equal((await deviceSession(hub, deviceId, key)).status, 401);
  assert.equal((await deviceSession(replica, deviceId, key)).status, 401);
});

test('signing out with a device bearer ends that bearer session', async t => {
  const hub = await engine(t, { name: 'Home server' }); await hub.setup();
  const pairing = await hub.request('/api/pairing', { method: 'POST', data: { kind: 'device' } });
  const { key, result } = await pairDevice(hub, pairing.body.link), session = await deviceSession(hub, result.body.deviceId, key);
  assert.equal((await hub.request('/api/state', { bearer: session.body.token })).status, 200);
  assert.equal((await hub.request('/api/logout', { method: 'POST', data: {}, bearer: session.body.token })).status, 200);
  assert.equal((await hub.request('/api/state', { bearer: session.body.token })).status, 401);
  assert.equal((await deviceSession(hub, result.body.deviceId, key)).status, 200, 'the device itself stays paired');
});

test('separate conversation lanes replicate as their own documents and belong to their bot',()=>{
  const sessionId=sessionIdFor('bot_atlas','room:team'),record={id:sessionId,botId:'bot_atlas',kind:'room',key:'room:team',roomSeen:{id:'message_1',createdAt:'2026-10-27T10:00:00Z'},createdAt:'2026-10-27T10:00:00Z',updatedAt:'2026-10-27T10:00:00Z'};
  const state={bots:[{id:'bot_atlas'}],conversations:{bot_atlas:[{role:'user',content:'Hi'}],[sessionId]:[{role:'user',content:'Room turn'}]},sessions:[record]};
  const docs=listDocuments(state,{});
  assert.deepEqual(docs.get(`conv:${sessionId}`),[{role:'user',content:'Room turn'}]);assert.deepEqual(docs.get(`session:${sessionId}`),record);assert.ok(docs.has('conv:bot_atlas'));
  // Changes to any of a bot's lanes wait while that bot works locally, like its Bot Chat.
  assert.equal(botOf(`conv:${sessionId}`),'bot_atlas');assert.equal(botOf(`session:${sessionId}`),'bot_atlas');assert.equal(botOf('conv:bot_atlas'),'bot_atlas');
  const replica={sessions:[],conversations:{}};
  assert.equal(writeDocument(replica,`session:${sessionId}`,record,{}),true);assert.equal(writeDocument(replica,`conv:${sessionId}`,[{role:'user',content:'Room turn'}],{}),true);
  assert.deepEqual(replica.sessions,[record]);assert.equal(writeDocument(replica,`session:${sessionId}`,{...record,id:'other'},{}),false);
  // Deleting a bot removes its Bot Chat, every other lane and their records, and nothing of another bot.
  state.conversations.bot_scout=[];removeBotSessions(state,'bot_atlas');
  assert.deepEqual(Object.keys(state.conversations),['bot_scout']);assert.deepEqual(state.sessions,[]);
});
