import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync, randomBytes, sign} from 'node:crypto';
import {Store} from '../lib/store.mjs';
import {Notifications, notificationPayload, notificationAvatar, previewText} from '../lib/notifications.mjs';
import {listDocuments} from '../lib/sync/docs.mjs';
import {createStudioServer} from '../server.mjs';
import {PAIR_MESSAGE, SESSION_MESSAGE,fingerprint} from '../lib/sync/crypto.mjs';
import {NativeEngine} from '../lib/engine.mjs';

const TOKEN = 'ab'.repeat(32), OTHER_TOKEN = 'cd'.repeat(32), BASE = Date.parse('2026-10-27T12:00:00Z');
const enrollment = overrides => ({token:TOKEN, environment:'sandbox', enabled:true, botReplies:true, routines:true, ...overrides});
const iso = n => new Date(BASE + n).toISOString();

async function fixture(t, {seed, available = true, role = 'hub', send, graceMs = 0} = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-notifications-'));
  const store = await new Store(directory).init();
  const device = {id:'dev_phone', kind:'device', platform:'ios', name:'Private phone'};
  await store.mutate(state => {state.devices.push(device); seed?.(state);});
  let time = BASE, currentRole = role;
  const sent = [], results = [];
  const transport = {available, environment:'sandbox', async send(request) {sent.push(request); if (send) return send(request); const next = results.shift(); if (next instanceof Error) throw next; return next || {status:200};}, close(){}};
  const sync = {nodeId:'node_fixture', role:() => currentRole, devices:{find:id => store.state.devices.find(device => device.id === id && !device.revokedAt)}};
  const notifications = await new Notifications(store, {sync, transport, now:() => time, graceMs, intervalMs:1_000_000}).init();
  t.after(async () => {await notifications.close(); await fs.rm(directory, {recursive:true, force:true});});
  const reply = async (id, {source='chat', botId='bot_atlas', at=0, partial=false, routineId, sessionId, fromBotId, user=true} = {}) => {
    await store.mutate(state => {
      const rows = state.messages[botId] ||= [];
      if (user) rows.push({id:`user_${id}`, role:'user', source, runId:`run_${id}`, content:'Private task content', createdAt:iso(at), ...(routineId ? {routineId} : {}), ...(sessionId ? {sessionId} : {}), ...(fromBotId ? {fromBotId} : {})});
      rows.push({id:`message_${id}`, role:'assistant', runId:`run_${id}`, content:'Secret assistant transcript', createdAt:iso(at), ...(partial ? {partial:true} : {})});
    });
    await notifications.flush();
  };
  return {directory, store, sync, device, transport, notifications, sent, results, reply,
    advance:ms => {time += ms;}, setRole:value => {currentRole = value;}};
}

test('first enrollment starts now, seals the token and never syncs notification state', async t => {
  const f = await fixture(t, {seed:state => {
    state.messages.bot_atlas = [{id:'old_user', role:'user', source:'chat', runId:'run_old', content:'Old task', createdAt:iso(-1000)}, {id:'old_message', role:'assistant', runId:'run_old', content:'Old private reply', createdAt:iso(-1000)}];
  }});
  const registered = await f.notifications.register(f.device, enrollment());
  assert.deepEqual({available:registered.available, registered:registered.registered, enabled:registered.enabled}, {available:true, registered:true, enabled:true});
  await f.notifications.flush(); assert.equal(f.sent.length, 0);
  await f.reply('new'); assert.equal(f.sent.length, 1);
  const saved = await fs.readFile(path.join(f.directory, 'notifications.json'), 'utf8');
  for (const privateValue of [TOKEN, 'Secret assistant transcript', 'Private task content', 'Private phone', 'Roki']) assert.ok(!saved.includes(privateValue));
  assert.equal((await fs.stat(path.join(f.directory, 'notifications.json'))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(f.store.publicState()).includes(TOKEN));
  const docs = [...listDocuments(f.store.state, f.store).values()];
  assert.ok(!JSON.stringify(docs).includes(TOKEN));
  assert.ok(![...listDocuments(f.store.state, f.store).keys()].some(key => /notification|push|outbox/.test(key)));
  const payload = f.sent[0].payload;
  assert.equal(payload.aps.alert.title, 'Roki');
  assert.equal(payload.aps.alert.body, 'Secret assistant transcript');
  assert.equal(payload.aps['mutable-content'], 1);
  assert.equal(payload.studio.kind, 'message');
  assert.deepEqual(Object.keys(payload.studio).sort(), ['avatar', 'botId', 'engineId', 'eventId', 'kind', 'v']);
  assert.equal(payload.studio.avatar, 'blue');
});

test('direct owner replies notify once; private lanes, delegation and partial output stay quiet', async t => {
  const f = await fixture(t); await f.notifications.register(f.device, enrollment());
  await f.reply('direct'); await f.notifications.flush(); assert.equal(f.sent.length, 1);
  await f.reply('explicit_main', {sessionId:'bot_atlas'}); assert.equal(f.sent.length, 2);
  await f.reply('telegram', {source:'telegram', sessionId:'bot_atlas--telegram-123'});
  await f.reply('delegate', {source:'delegation', fromBotId:'bot_nova'});
  await f.reply('room', {source:'room', sessionId:'bot_atlas--room-123'});
  await f.reply('partial', {partial:true});
  assert.equal(f.sent.length, 2);
});

test('a synced answer arriving before its request remains pending until source is known', async t => {
  const f = await fixture(t); await f.notifications.register(f.device, enrollment());
  await f.reply('orphan', {user:false}); assert.equal(f.sent.length, 0);
  assert.equal(f.notifications.state.orphans.length, 1);
  await f.store.mutate(state => state.messages.bot_atlas.push({id:'late_user', role:'user', source:'chat', runId:'run_orphan', content:'Owner task', createdAt:iso(-100)}));
  await f.notifications.flush(); await f.notifications.flush();
  assert.equal(f.sent.length, 1); assert.equal(f.notifications.state.orphans.length, 0);
});

test('new backdated synced replies use message IDs rather than a timestamp high-water mark', async t => {
  const f = await fixture(t); await f.notifications.register(f.device, enrollment());
  await f.reply('later', {at:10});
  await f.reply('earlier', {at:-1000});
  await f.reply('same_time', {at:10});
  await f.notifications.flush();
  assert.equal(f.sent.length, 3);
  assert.equal(new Set(f.sent.map(record => record.eventId)).size, 3);
  await f.reply('too_old', {at:-25*60*60_000}); assert.equal(f.sent.length, 3);
});

test('enrollment and per-kind re-enable suppress old orphans and late historical imports', async t => {
  const f = await fixture(t);
  await f.reply('before_enrollment', {user:false});
  await f.notifications.register(f.device, enrollment());
  await f.store.mutate(state => state.messages.bot_atlas.push({id:'late_owner', role:'user', source:'chat', runId:'run_before_enrollment', createdAt:iso(-1000)}));
  await f.notifications.flush(); assert.equal(f.sent.length, 0, 'an orphan first observed before enrollment stays historical');
  await f.notifications.register(f.device, enrollment({botReplies:false}));
  await f.reply('before_kind_enable', {user:false});
  await f.notifications.register(f.device, enrollment());
  await f.store.mutate(state => state.messages.bot_atlas.push({id:'late_kind_owner', role:'user', source:'chat', runId:'run_before_kind_enable', createdAt:iso(0)}));
  await f.notifications.flush(); assert.equal(f.sent.length, 0);
  await f.reply('historical_import', {at:-60*60_000}); assert.equal(f.sent.length, 0);
  await f.store.mutate(state => {
    state.rooms.push({id:'room_imported', botIds:['bot_atlas']});
    state.roomMessages.room_imported = [{id:'old_imported_room_reply', role:'assistant', botId:'bot_atlas', createdAt:iso(-60*60_000)}];
  });
  await f.notifications.flush(); assert.equal(f.sent.length, 0);
  await f.reply('within_clock_skew', {at:-1000}); assert.equal(f.sent.length, 1);
});

test('owner-visible final room replies notify with a room route, without private intermediates', async t => {
  const f = await fixture(t); await f.notifications.register(f.device, enrollment());
  await f.store.mutate(state => {
    state.rooms.push({id:'room_fixture', botIds:['bot_atlas', 'bot_nova']});
    state.roomMessages.room_fixture = [{id:'room_user', role:'user', content:'Private room task', createdAt:iso(0)}, {id:'room_final', role:'assistant', botId:'bot_atlas', content:'Private room reply', createdAt:iso(0)}, {id:'room_partial', role:'assistant', botId:'bot_nova', partial:true, content:'Partial', createdAt:iso(0)}];
  });
  await f.notifications.flush(); await f.notifications.flush();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].payload.studio.roomId, 'room_fixture');
  assert.equal(f.sent[0].payload.aps['thread-id'], 'studio-node_fixture-room_fixture');
  assert.equal(f.sent[0].payload.aps.alert.body, 'Private room reply');
});

test('routine completion, failure and admission error notify without duplicate result alerts', async t => {
  const f = await fixture(t); await f.notifications.register(f.device, enrollment());
  await f.store.mutate(state => state.routines.push({id:'routine_fixture', botId:'bot_atlas', lastRunAt:iso(0)}));
  await f.reply('routine_success', {source:'routine', routineId:'routine_fixture', sessionId:'bot_atlas--routine-123'});
  await f.store.mutate(state => {state.runs.bot_atlas = {id:'run_routine_success', botId:'bot_atlas', source:'routine', routineId:'routine_fixture', status:'completed', createdAt:iso(0), finishedAt:iso(0)};});
  await f.notifications.flush(); assert.equal(f.sent.length, 1);
  await f.store.mutate(state => {state.runs.bot_atlas = {id:'run_failed', botId:'bot_atlas', source:'routine', routineId:'routine_fixture', status:'failed', error:'Private error', createdAt:iso(0), finishedAt:iso(0)};});
  await f.notifications.flush(); assert.equal(f.sent.length, 2);
  await f.store.mutate(state => {Object.assign(state.routines[0], {lastRunAt:iso(100), lastError:'A private failed admission'});});
  await f.notifications.flush(); await f.notifications.flush(); assert.equal(f.sent.length, 3);
  for (const sent of f.sent) {assert.equal(sent.payload.studio.kind, 'routine'); assert.equal(sent.payload.studio.routineId, 'routine_fixture'); assert.ok(!JSON.stringify(sent.payload).includes('Private'));}
});

test('a routine retry clears its previous error with durable admission and sends only the new outcome', async t => {
  const f = await fixture(t, {seed:state => state.routines.push({id:'routine_retry', botId:'bot_atlas', intervalMinutes:5, prompt:'Fixture routine', lastRunAt:iso(-1000), lastError:'Previous failure'})});
  f.advance(Date.now()-BASE);
  await f.notifications.register(f.device, enrollment());
  let release, entered;
  const started = new Promise(resolve => {entered = resolve;});
  const admission = new Promise(resolve => {release = resolve;});
  await f.store.mutate(state=>{state.connections.push({id:'fixture_provider',type:'openai',name:'Fixture',model:'fixture',secret:f.store.seal('synthetic-fixture-key')});state.bots[0].connectionId='fixture_provider';state.bots[0].tools=[];});
  const engine=new NativeEngine(f.store,{providers:{async complete(){assert.equal(Object.hasOwn(f.store.state.routines[0],'lastError'),false);assert.equal(f.store.state.routines[0].lastRunId,f.store.state.runs.bot_atlas.id);entered();await admission;return {text:'Actual routine retry completed.',toolCalls:[]};}}});
  try {
    const run=await engine.runRoutine('routine_retry');await started;await f.notifications.flush();assert.equal(f.sent.length,0,'An admitted retry is not another admission-failure alert.');
    release();const until=Date.now()+4000;while(f.store.state.runs.bot_atlas.status!=='completed'&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.store.state.runs.bot_atlas.status,'completed');assert.equal(f.store.state.runs.bot_atlas.id,run.id);
    await f.notifications.flush();assert.equal(f.sent.length,1);
  } finally { release();await engine.close(); }
  await f.store.mutate(state => {state.routines = [];}); await f.notifications.flush();
  assert.equal(Object.keys(f.notifications.state.routines).length, 0, 'deleted routine cursors are removed');
});

test('preferences, environment and home-server authority gate delivery truthfully', async t => {
  const f = await fixture(t, {available:false});
  await f.notifications.register(f.device, enrollment());
  assert.equal(f.notifications.status(f.device).reason, 'not_configured');
  await f.reply('unconfigured'); assert.equal(f.sent.length, 0);
  f.transport.available = true;
  await f.notifications.register(f.device, enrollment({environment:'production'}));
  assert.equal(f.notifications.status(f.device).reason, 'environment_mismatch');
  await f.reply('wrong_env'); assert.equal(f.sent.length, 0);
  await f.notifications.register(f.device, enrollment({botReplies:false}));
  await f.reply('muted'); assert.equal(f.sent.length, 0);
  await f.notifications.register(f.device, enrollment());
  f.setRole('replica'); assert.equal(f.notifications.status(f.device).reason, 'home_server_only');
  await f.reply('replica'); assert.equal(f.sent.length, 0);
  f.setRole('hub'); await f.notifications.flush(); assert.equal(f.sent.length, 0, 'excluded history is not replayed when a setting changes');
  await f.reply('ready'); assert.equal(f.sent.length, 1);
});

test('revocation and token rotation cancel pending delivery without exposing a token', async t => {
  const f = await fixture(t); await f.notifications.register(f.device, enrollment());
  f.results.push({status:503}); await f.reply('pending'); assert.equal(f.sent.length, 1);
  await f.notifications.register(f.device, enrollment({token:OTHER_TOKEN}));
  f.advance(16*60_000); await f.notifications.flush(); assert.equal(f.sent.length, 1);
  await f.reply('fresh'); assert.equal(f.sent.length, 2); assert.equal(f.sent[1].token, OTHER_TOKEN);
  await f.store.mutate(state => {state.devices[0].revokedAt = iso(0);});
  await f.notifications.flush(); assert.equal(Object.keys(f.notifications.state.subscriptions).length, 0);
  await f.reply('revoked'); assert.equal(f.sent.length, 2);
  assert.throws(() => f.notifications.status(f.device), {status:403});
});

test('native disable is not blocked behind an in-flight APNs request', async t => {
  let release, started;
  const began = new Promise(resolve => {started = resolve;});
  const pending = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, {send:async () => {started(); return pending;}});
  await f.notifications.register(f.device, enrollment());
  const writing = f.reply('inflight'); await began;
  const removed = await Promise.race([f.notifications.unregister(f.device), new Promise((_, reject) => setTimeout(() => reject(new Error('Unregister blocked behind push transport.')), 500))]);
  assert.equal(removed.registered, false);
  release({status:200}); await writing;
  await f.reply('after_disable'); assert.equal(f.sent.length, 1);
});

test('explicit APNs retries keep event identity, wait at least 15 minutes after 5xx and honor 429', async t => {
  const f = await fixture(t); await f.notifications.register(f.device, enrollment());
  f.results.push({status:503}, {status:200}); await f.reply('retry');
  f.advance(14*60_000); await f.notifications.flush(); assert.equal(f.sent.length, 1);
  f.advance(60_000); await f.notifications.flush(); assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].eventId, f.sent[1].eventId);
  f.results.push({status:429, retryAfter:120}, {status:200}); await f.reply('rate_limit');
  f.advance(60_000); await f.notifications.flush(); assert.equal(f.sent.length, 3);
  f.advance(60_000); await f.notifications.flush(); assert.equal(f.sent.length, 4);
});

test('ambiguous dispatch is not retried after an engine restart and token rejection unregisters', async t => {
  const f = await fixture(t); await f.notifications.register(f.device, enrollment());
  f.results.push(new Error('Transport ambiguity with secret details')); await f.reply('unknown');
  assert.equal(f.notifications.status(f.device).delivery.status, 'unknown');
  assert.equal(f.notifications.status(f.device).delivery.lastError, 'delivery_unknown');
  await f.notifications.close();
  const resumed = await new Notifications(f.store, {sync:f.sync, transport:f.transport, now:() => BASE, graceMs:0, intervalMs:1_000_000}).init();
  t.after(() => resumed.close()); await resumed.flush(); assert.equal(f.sent.length, 1);
  f.results.push({status:410, reason:'Unregistered'});
  await f.store.mutate(state => state.messages.bot_atlas.push({id:'new_user', role:'user', source:'chat', runId:'run_new', createdAt:iso(0)}, {id:'new_answer', role:'assistant', runId:'run_new', createdAt:iso(0)}));
  await resumed.flush(); assert.equal(f.sent.length, 2); assert.equal(resumed.status(f.device).registered, false);
});

test('a claimed-but-unconfirmed intention becomes unknown after restart instead of replaying', async t => {
  const f = await fixture(t); await f.notifications.register(f.device, enrollment());
  f.transport.available = false;
  f.notifications.state.outbox.push({id:'claimed', deviceId:f.device.id, tokenHash:f.notifications.state.subscriptions[f.device.id].tokenHash, event:{id:'1'.repeat(32), kind:'message', botId:'bot_atlas'}, status:'claimed', attempts:1, createdAt:BASE, nextAttemptAt:BASE});
  await f.notifications.save(); await f.notifications.close();
  f.transport.available = true;
  const resumed = await new Notifications(f.store, {sync:f.sync, transport:f.transport, now:() => BASE, graceMs:0, intervalMs:1_000_000}).init();
  t.after(() => resumed.close()); await resumed.flush();
  assert.equal(f.sent.length, 0); assert.equal(resumed.state.outbox[0].status, 'unknown');
});

test('current preferences, authority and environment are checked after a durable claim', async t => {
  for (const change of ['preference', 'authority', 'environment']) {
    const f = await fixture(t); await f.notifications.register(f.device, enrollment());
    const save = f.notifications.save.bind(f.notifications); let changed = false;
    f.notifications.save = async () => {
      await save();
      if (!changed && f.notifications.state.outbox.some(item => item.status === 'claimed')) {
        changed = true;
        if (change === 'preference') f.notifications.state.subscriptions[f.device.id].botReplies = false;
        if (change === 'authority') f.setRole('replica');
        if (change === 'environment') f.transport.environment = 'production';
      }
    };
    await f.reply(`claim_${change}`); assert.equal(f.sent.length, 0, change);
  }
});

test('startup snapshots are serialized and a commit during metadata save is caught up', async t => {
  const f = await fixture(t); await f.notifications.register(f.device, enrollment()); await f.notifications.close();
  const resumed = new Notifications(f.store, {sync:f.sync, transport:f.transport, now:() => BASE, graceMs:0, intervalMs:1_000_000});
  t.after(() => resumed.close());
  const serialize = f.store.serialize.bind(f.store); let serialized = 0;
  f.store.serialize = fn => {serialized++; return serialize(fn);};
  const save = resumed.save.bind(resumed); let committed = false;
  resumed.save = async () => {
    await save();
    if (!committed) {
      committed = true;
      await f.store.mutate(state => state.messages.bot_atlas = [{id:'startup_user', role:'user', source:'chat', runId:'run_startup', createdAt:iso(0)}, {id:'startup_reply', role:'assistant', runId:'run_startup', createdAt:iso(0)}]);
    }
  };
  await resumed.init(); await resumed.flush();
  assert.ok(serialized >= 2); assert.equal(f.sent.length, 1);
});

test('damaged or symlinked push metadata disables only pushes and preserves the file', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-notification-damaged-'));
  const store = await new Store(directory).init();
  const device = {id:'dev_phone', kind:'device', platform:'ios'};
  await store.mutate(state => state.devices.push(device));
  const sync = {nodeId:'node_fixture', role:() => 'hub', devices:{find:id => store.state.devices.find(device => device.id === id)}};
  const file = path.join(directory, 'notifications.json');
  t.after(() => fs.rm(directory, {recursive:true, force:true}));
  for (const symlink of [false, true]) {
    const target = symlink ? path.join(directory, 'untouched.json') : file;
    if (symlink) await fs.rm(file);
    await fs.writeFile(target, '{damaged push metadata');
    if (symlink) await fs.symlink(target, file);
    const notifications = await new Notifications(store, {sync, transport:{available:true, environment:'sandbox', close(){}}}).init();
    assert.equal(notifications.status(device).available, false);
    assert.equal(notifications.status(device).reason, 'storage_unavailable');
    await assert.rejects(notifications.register(device, enrollment()), {status:503});
    await assert.rejects(notifications.unregister(device), {status:503});
    await store.mutate(state => {state.settings.normalWorkStillCommits = true;});
    await notifications.flush(); await notifications.close();
    assert.equal(await fs.readFile(target, 'utf8'), '{damaged push metadata');
    if (symlink) assert.ok((await fs.lstat(file)).isSymbolicLink());
  }
});

test('registration refuses token/topic/identity injection and notification routing validates IDs', async t => {
  const f = await fixture(t);
  for (const input of [enrollment({deviceId:'dev_other'}), enrollment({topic:'other.app'}), enrollment({token:'not-hex'}), enrollment({environment:'https://example.test'}), enrollment({enabled:'true'})]) await assert.rejects(f.notifications.register(f.device, input), {status:400});
  await assert.rejects(f.notifications.register({...f.device, platform:'macos'}, enrollment()), {status:403});
  assert.throws(() => notificationPayload({id:'x', kind:'message', botId:'bot_atlas'}, 'node_fixture'));
  assert.throws(() => notificationPayload({id:'1'.repeat(32), kind:'message', botId:'../../private'}, 'node_fixture'));
});

test('notification routes require the current paired iOS bearer and preserve browser/engine boundaries', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-notification-api-'));
  const transport = {available:true, environment:'sandbox', async send(){return {status:200};}, close(){}};
  const app = await createStudioServer({dataDir:directory, scheduler:false, logErrors:false, notifications:{transport}});
  const {url} = await app.listen(0);
  t.after(async () => {await app.close(); await fs.rm(directory, {recursive:true, force:true});});
  const request = async (route, {method='GET', bearer, cookie, csrf, data, headers={}} = {}) => {
    const response = await fetch(url+route, {method, redirect:'manual', headers:{...(bearer ? {Authorization:`Bearer ${bearer}`} : {}), ...(cookie ? {Cookie:cookie} : {}), ...(csrf ? {'X-CSRF-Token':csrf} : {}), ...(data !== undefined ? {'Content-Type':'application/json'} : {}), ...headers}, ...(data !== undefined ? {body:JSON.stringify(data)} : {})});
    const body = await response.json().catch(() => null); return {response, body, status:response.status};
  };
  const setup = await request('/api/setup', {method:'POST', data:{token:app.bootstrapToken, password:'notification-fixture-password'}});
  const cookie = setup.response.headers.get('set-cookie').split(';')[0], csrf = setup.body.csrf;
  assert.equal((await request('/api/device/notifications')).status, 401);
  assert.equal((await request('/api/notifications/read', {method:'POST', data:{botId:'bot_atlas',messageIds:[]}})).status,401);
  assert.equal((await request('/api/notifications/read', {method:'POST',cookie,data:{botId:'bot_atlas',messageIds:[]}})).status,403);
  assert.equal((await request('/api/notifications/read', {cookie})).status,405);
  assert.equal((await request('/api/notifications/read', {method:'POST',cookie,csrf,data:{botId:'bot_atlas',messageIds:[]}})).status,200);
  assert.equal((await request('/api/device/notifications', {cookie})).status, 403);
  assert.equal((await request('/api/device/notifications', {method:'PUT', cookie, csrf, data:enrollment()})).status, 403);
  const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve:'prime256v1'});
  const publicDer = publicKey.export({type:'spki', format:'der'}).toString('base64');
  const signText = value => sign('sha256', Buffer.from(value), privateKey).toString('base64');
  const pairing = app.sync.devices.createPairing({baseUrl:url});
  const paired = await request('/api/pair', {method:'POST', data:{v:1, code:pairing.code, name:'Fixture phone', platform:'ios', publicKey:publicDer, proof:signText(PAIR_MESSAGE(pairing.code, publicDer))}});
  const deviceId = paired.body.deviceId, timestamp = Date.now(), nonce = randomBytes(16).toString('base64url');
  const engineNodeId=app.sync.nodeId,engineFingerprint=app.sync.identity.fingerprint;
  const session = await request('/api/device/session', {method:'POST', data:{v:2,engineNodeId,engineFingerprint,deviceId, timestamp, nonce, signature:signText(SESSION_MESSAGE(engineNodeId,engineFingerprint,deviceId,timestamp,nonce))}});
  const bearer = session.body.token;
  const registered = await request('/api/device/notifications', {method:'PUT', bearer, data:enrollment()});
  assert.equal(registered.status, 200); assert.equal(registered.body.registered, true); assert.ok(!JSON.stringify(registered.body).includes(TOKEN));
  assert.equal((await request('/api/device/notifications', {bearer, headers:{Origin:'https://attacker.test'}})).status, 403);
  const ticket = await request('/api/device/web-ticket', {method:'POST', bearer, data:{}});
  const web = await fetch(url+ticket.body.path, {redirect:'manual'}), webCookie = web.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/device/notifications', {cookie:webCookie})).status, 403);
  const removed = await request('/api/device/notifications', {method:'DELETE', bearer, data:{}});
  assert.equal(removed.body.registered, false); assert.equal(removed.body.enabled, false);
  const engineToken = 'hsd_'+'x'.repeat(43);
  const engineDevice={id:'dev_engine',kind:'engine',platform:'engine',protocolVersion:2,nodeId:'node_engine_fixture',publicKey:publicDer,fingerprint:fingerprint(publicDer)};
  await app.sync.security.add(engineDevice);await app.store.mutate(state => state.devices.push(engineDevice));
  app.sync.devices.sessions.set(engineToken, {deviceId:'dev_engine', expires:Date.now()+60000});
  assert.equal((await request('/api/device/notifications', {bearer:engineToken})).status, 403);
  assert.equal((await request('/api/notifications/read', {method:'POST',bearer:engineToken,data:{botId:'bot_atlas',messageIds:[]}})).status,403);
  await app.sync.devices.revoke(deviceId);
  assert.equal((await request('/api/device/notifications', {bearer})).status, 401);
});

test('a corrupt notification file does not prevent engine startup or normal workspace API work', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'studio-notification-startup-'));
  await new Store(directory).init();
  const file = path.join(directory, 'notifications.json'), original = '{unreadable optional push metadata';
  await fs.writeFile(file, original);
  const app = await createStudioServer({dataDir:directory, scheduler:false, logErrors:false});
  const {url} = await app.listen(0);
  t.after(async () => {await app.close(); await fs.rm(directory, {recursive:true, force:true});});
  const setup = await fetch(url+'/api/setup', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:app.bootstrapToken, password:'notification-startup-fixture-password'})});
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const state = await fetch(url+'/api/state', {headers:{Cookie:cookie}});
  assert.equal(state.status, 200); assert.equal((await state.json()).engine.independent, true);
  assert.equal(app.notifications.readOnly, true);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('read receipts suppress only an actually read final reply during the grace period', async t => {
  const f = await fixture(t, {graceMs:8000}); await f.notifications.register(f.device, enrollment());
  await f.reply('read'); assert.equal(f.sent.length, 0);
  await f.notifications.acknowledge({botId:'bot_atlas', messageIds:['message_read']});
  f.advance(8000); await f.notifications.flush();
  assert.equal(f.sent.length, 0); assert.equal(f.notifications.state.outbox[0].status, 'suppressed');
  await f.reply('away'); f.advance(7999); await f.notifications.flush(); assert.equal(f.sent.length, 0);
  f.advance(1); await f.notifications.flush(); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].payload.aps.alert.body, 'Secret assistant transcript');
  await f.notifications.close();
  const resumed = await new Notifications(f.store, {sync:f.sync, transport:f.transport, now:() => BASE+16000}).init();
  t.after(() => resumed.close()); await resumed.flush(); assert.equal(f.sent.length, 1, 'restart cannot replay the read reply');
});

test('reads arriving before synced replies suppress the exact event and cannot approve or cancel work', async t => {
  const f = await fixture(t, {graceMs:8000}); await f.notifications.register(f.device, enrollment());
  await f.reply('early');
  const event = f.notifications.state.outbox[0].event;
  f.notifications.state.outbox = [];
  await f.notifications.markRead([event.id]);
  f.notifications.add(event); assert.equal(f.notifications.state.outbox.length, 0);
  const before = JSON.stringify(f.store.state);
  await f.notifications.acknowledge({botId:'bot_nova', messageIds:['message_early']});
  await f.notifications.acknowledge({botId:'bot_atlas', messageIds:['invented']});
  assert.equal(JSON.stringify(f.store.state), before);
  for (const bad of [{botId:['bot_atlas'],messageIds:[]},{botId:'bot_atlas',messageIds:[],token:TOKEN},{botId:'bot_atlas',messageIds:['../secret']},{botId:'bot_atlas',roomId:4,messageIds:[]}]) await assert.rejects(f.notifications.acknowledge(bad), {status:400});
});

test('room and routine reads use exact conversation and run identities; partial and private replies never mute', async t => {
  const f = await fixture(t, {graceMs:8000}); await f.notifications.register(f.device, enrollment());
  await f.store.mutate(state => {state.rooms.push({id:'room_read', name:'Team', botIds:['bot_atlas']});state.roomMessages.room_read=[{id:'room_final',botId:'bot_atlas',role:'assistant',content:'Done',createdAt:iso(0)}]; state.routines.push({id:'routine_read',name:'Daily briefing',botId:'bot_atlas'});});
  await f.notifications.flush();
  await f.notifications.acknowledge({botId:'bot_nova',roomId:'room_read',messageIds:['room_final']});
  assert.equal(f.notifications.state.outbox[0].status, 'pending');
  await f.notifications.acknowledge({botId:'bot_atlas',roomId:'room_read',messageIds:['room_final']});
  await f.reply('routine_read', {source:'routine',routineId:'routine_read'});
  await f.notifications.acknowledge({botId:'bot_atlas',messageIds:['message_routine_read']});
  await f.reply('partial_read', {partial:true});
  await f.notifications.acknowledge({botId:'bot_atlas',messageIds:['message_partial_read']});
  assert.equal(Object.keys(f.notifications.state.read).length, 2);
  f.advance(8000); await f.notifications.flush(); assert.equal(f.sent.length,0);
});

test('rich previews use bounded redacted committed content and finite portraits without persisting names or text', async t => {
  const f = await fixture(t, {graceMs:8000}); await f.notifications.register(f.device, enrollment());
  await f.store.mutate(state => {state.bots[0].name='Preview bot';state.bots[0].icon='companion:cloud';state.routines.push({id:'routine_preview',name:'Morning briefing',botId:'bot_atlas'});});
  await f.reply('preview', {source:'routine',routineId:'routine_preview'});
  await f.store.mutate(state => {state.messages.bot_atlas.at(-1).content='**Ready** [report](https://private.example/token)\n```secret code```\n'+ '🦉'.repeat(300);});
  f.advance(8000); await f.notifications.flush();
  const payload = f.sent[0].payload;
  assert.equal(payload.aps.alert.title,'Preview bot');assert.equal(payload.aps.alert.subtitle,'Routine · Morning briefing');assert.equal(payload.studio.avatar,'cloud');
  assert.ok(payload.aps.alert.body.startsWith('Ready report [Code]'));assert.ok([...payload.aps.alert.body].length<=240);
  assert.ok(Buffer.byteLength(JSON.stringify(payload))<4096);
  assert.ok(!JSON.stringify(payload).includes('https:'));assert.ok(!JSON.stringify(payload).includes('secret code'));
  const disk=await fs.readFile(f.notifications.file,'utf8');for(const value of ['Preview bot','Morning briefing','secret code','🦉'])assert.ok(!disk.includes(value));
  assert.equal(notificationAvatar({id:'bot_atlas',name:'Different'}),'blue');assert.equal(notificationAvatar({id:'custom',icon:'companion:../../secret'}), notificationAvatar({id:'custom'}));
  assert.equal(previewText('<b>Hello</b>\u202e\nworld',40),'Hello world');
});

test('a read arriving after the durable claim is rechecked before the Apple transport', async t => {
  const f=await fixture(t);await f.notifications.register(f.device,enrollment());
  const save=f.notifications.save.bind(f.notifications);
  f.notifications.save=async()=>{await save();const item=f.notifications.state.outbox.find(row=>row.status==='claimed');if(item)f.notifications.state.read[item.event.id]=BASE;};
  await f.reply('claimed_read');assert.equal(f.sent.length,0);assert.equal(f.notifications.state.outbox[0].status,'suppressed');
});
