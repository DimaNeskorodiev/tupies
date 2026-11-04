import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { Notifications } from '../lib/notifications.mjs';
import { currentMissionAttention } from '../lib/mission-attention.mjs';

const BASE = Date.parse('2026-11-01T12:00:00Z'), BOT = 'bot_atlas', MISSION = 'mission_fixture';
const iso = () => new Date(BASE).toISOString();
const registration = changes => ({ token: 'ab'.repeat(32), environment: 'sandbox', enabled: true, botReplies: true, routines: true, ...changes });
function install(state, kind = 'approval') {
  const mission = { id: MISSION, leadBotId: BOT, ownerEngineId: 'node_fixture', contractVersion: 1, revision: 1, attempt: 0, state: 'waiting', outcome: null, reason: kind === 'blocker' ? 'Private missing service/account detail.' : 'Review private approval arguments.', waitCondition: { kind: kind === 'approval' ? 'approval' : 'attention' }, episodeRefs: [{ id: 'episode_fixture', botId: BOT, runId: 'run_mission' }], createdAt: iso(), updatedAt: iso() };
  (state.missions ||= {})[MISSION] = mission;
  state.runs[BOT] = { id: 'run_mission', botId: BOT, source: 'mission', sessionId: 'bot_atlas--mission-fixture', missionId: MISSION, status: kind === 'approval' ? 'waiting_for_approval' : 'running', execution_generation: 3, createdAt: iso(), updatedAt: iso(), pending_controls: kind === 'approval' ? [{ kind: 'approval', prompt_id: 'approval_fixture', arguments: { private: 'Private approval argument bytes.' }, createdAt: iso() }] : [], approval: kind === 'approval' ? { request_id: 'approval_fixture' } : null };
  return mission;
}
async function fixture(t, { graceMs = 0, seed } = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'tupies-mission-notifications-')), store = await new Store(directory).init();
  const device = { id: 'device_fixture', kind: 'device', platform: 'ios' };
  await store.mutate(state => { state.devices.push(device); seed?.(state); });
  let time = BASE, role = 'hub'; const sent = [], forwarded = [];
  const sync = { nodeId: 'node_fixture', role: () => role, devices: { find: id => store.state.devices.find(item => item.id === id && !item.revokedAt) }, recordNotificationReads: ids => forwarded.push(...ids) };
  const transport = { available: true, environment: 'sandbox', async send(request) { sent.push(request); return { status: 200 }; }, close() {} };
  let notifications = await new Notifications(store, { sync, transport, now: () => time, graceMs, intervalMs: 1_000_000 }).init();
  t.after(async () => { await notifications.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await notifications.register(device, registration());
  return { directory, store, sent, forwarded, device, sync, get notifications() { return notifications; }, advance: amount => { time += amount; }, setRole: value => { role = value; }, async restart() { await notifications.close(); notifications = await new Notifications(store, { sync, transport, now: () => time, graceMs, intervalMs: 1_000_000 }).init(); } };
}

test('a local Mission approval alerts once with existing reply preference and static presentation only', async t => {
  const f = await fixture(t); await f.store.mutate(state => install(state)); await f.notifications.flush();
  assert.equal(f.sent.length, 1); const event = f.sent[0];
  assert.equal(event.payload.studio.kind, 'message'); assert.equal(event.payload.studio.missionId, MISSION); assert.equal(event.payload.studio.botId, BOT);
  assert.match(event.payload.aps.alert.body, /Mission needs approval/); assert.equal(event.payload.aps.alert.subtitle, 'Mission');
  const stored = await fs.readFile(f.notifications.file, 'utf8');
  for (const privateText of ['Private approval argument bytes.', 'Review private approval arguments.']) assert.ok(!stored.includes(privateText));
  for (let index = 0; index < 3; index++) { await f.store.mutate(state => { state.missions[MISSION].revision++; state.missions[MISSION].updatedAt = new Date(BASE + index).toISOString(); }); await f.notifications.flush(); }
  assert.equal(f.sent.length, 1); await f.restart(); await f.notifications.flush(); assert.equal(f.sent.length, 1);
});

test('approval attention binds exact generation, prompt, admitted lead run and execution engine', async t => {
  const f = await fixture(t); await f.store.mutate(state => install(state));
  const baseline = currentMissionAttention(f.store.state, MISSION, { ownerEngineId: 'node_fixture' }); assert.ok(baseline);
  assert.equal(currentMissionAttention(f.store.state, MISSION, { ownerEngineId: 'other_engine' }), null);
  for (const mutate of [state => { state.runs[BOT].delegation = { depth: 1 }; }, state => { state.runs[BOT].botId = 'bot_nova'; }, state => { state.missions[MISSION].episodeRefs = []; }, state => { state.runs[BOT].approval.request_id = 'other_prompt'; }, state => { state.runs[BOT].execution_generation = 0; }, state => { delete state.missions[MISSION]; (state.missionSummaries ||= {})[MISSION] = baseline; }]) {
    const state = structuredClone(f.store.state); mutate(state); assert.equal(currentMissionAttention(state, MISSION), null);
  }
  const changed = structuredClone(f.store.state); changed.runs[BOT].execution_generation++;
  assert.notEqual(currentMissionAttention(changed, MISSION).attentionId, baseline.attentionId);
  changed.runs[BOT].execution_generation--; changed.runs[BOT].pending_controls[0].prompt_id = 'new_prompt'; changed.runs[BOT].approval.request_id = 'new_prompt';
  assert.notEqual(currentMissionAttention(changed, MISSION).attentionId, baseline.attentionId);
});

for (const change of ['resolved', 'retry', 'stop', 'replacement', 'generation']) test(`stale Mission approval is cancelled before delivery after ${change}`, async t => {
  const f = await fixture(t, { graceMs: 8000 }); await f.store.mutate(state => install(state)); await f.notifications.flush();
  assert.equal(f.notifications.state.outbox.length, 1);
  await f.store.mutate(state => {
    if (change === 'resolved') { state.runs[BOT].status = 'running'; state.runs[BOT].pending_controls = []; }
    if (change === 'retry') { state.missions[MISSION].state = 'queued'; state.missions[MISSION].attempt++; state.runs[BOT].status = 'failed'; state.runs[BOT].pending_controls = []; }
    if (change === 'stop') { state.missions[MISSION].stopRequested = true; state.missions[MISSION].state = 'stopping'; }
    if (change === 'replacement') { state.runs[BOT].id = 'run_replaced'; }
    if (change === 'generation') { state.runs[BOT].execution_generation++; state.runs[BOT].status = 'running'; state.runs[BOT].pending_controls = []; }
  });
  f.advance(8001); await f.notifications.flush(); assert.equal(f.sent.length, 0); assert.equal(f.notifications.state.outbox[0].status, 'cancelled');
});

test('exact attended Mission receipt suppresses only its attention and preserves transcript unread', async t => {
  const f = await fixture(t, { graceMs: 8000, seed(state) { state.messages[BOT] = [{ id: 'old_owner', role: 'user', source: 'chat', runId: 'run_old', createdAt: iso() }, { id: 'old_reply', role: 'assistant', runId: 'run_old', content: 'An unread existing reply.', createdAt: iso() }]; } });
  await f.store.mutate(state => install(state)); await f.notifications.flush();
  const attention = currentMissionAttention(f.store.state, MISSION), receipt = { botId: BOT, missionId: MISSION, attentionId: attention.attentionId, messageIds: [] };
  assert.deepEqual(f.notifications.unreadBots(), { [BOT]: 'old_reply' });
  await f.notifications.acknowledge({ ...receipt, attentionId: '0'.repeat(32) }); assert.equal(f.notifications.state.outbox[0].status, 'pending');
  await f.notifications.acknowledge({ ...receipt, missionId: 'mission_other' }); assert.equal(f.notifications.state.outbox[0].status, 'pending');
  await f.notifications.acknowledge({ ...receipt, botId: 'bot_nova' }); assert.equal(f.notifications.state.outbox[0].status, 'pending');
  for (const fields of [{ questionId: 'question_other' }, { roomId: 'room_other' }, { messageIds: ['old_reply'] }, { missionId: undefined }]) await assert.rejects(f.notifications.acknowledge({ ...receipt, ...fields }), error => error.status === 400);
  await f.notifications.acknowledge(receipt); assert.equal(f.notifications.state.outbox[0].status, 'suppressed');
  assert.deepEqual(f.notifications.unreadBots(), { [BOT]: 'old_reply' }); assert.deepEqual(f.forwarded, [attention.attentionId]);
  f.advance(8001); await f.notifications.flush(); assert.equal(f.sent.length, 0);
});

test('reply preferences and home delivery authority also govern Mission attention', async t => {
  const f = await fixture(t); await f.notifications.register(f.device, registration({ botReplies: false }));
  await f.store.mutate(state => install(state)); await f.notifications.flush(); assert.equal(f.sent.length, 0);
  await f.notifications.register(f.device, registration()); f.setRole('replica');
  await f.store.mutate(state => { const run = state.runs[BOT]; run.pending_controls[0].prompt_id = 'approval_replica'; run.approval.request_id = 'approval_replica'; });
  await f.notifications.flush(); assert.equal(f.sent.length, 0); assert.equal(f.notifications.status(f.device).reason, 'home_server_only');
  f.setRole('hub'); await f.store.mutate(state => { const run = state.runs[BOT]; run.pending_controls[0].prompt_id = 'approval_home'; run.approval.request_id = 'approval_home'; });
  await f.notifications.flush(); assert.equal(f.sent.length, 1);
});

test('substantial failed/blocker attention has stable identity without leaking private reason', async t => {
  const f = await fixture(t); await f.store.mutate(state => { const mission = install(state, 'blocker'); mission.state = 'terminal'; mission.outcome = 'failed'; state.runs[BOT].status = 'failed'; });
  await f.notifications.flush(); assert.equal(f.sent.length, 1); assert.match(f.sent[0].payload.aps.alert.body, /Mission needs your attention/);
  const original = currentMissionAttention(f.store.state, MISSION).attentionId;
  await f.store.mutate(state => { state.missions[MISSION].revision++; state.missions[MISSION].updatedAt = new Date(BASE + 100).toISOString(); });
  assert.equal(currentMissionAttention(f.store.state, MISSION).attentionId, original); await f.notifications.flush(); assert.equal(f.sent.length, 1);
  assert.ok(!(await fs.readFile(f.notifications.file, 'utf8')).includes('Private missing service/account detail.'));
  await f.store.mutate(state => { state.missions[MISSION].attempt++; state.missions[MISSION].state = 'queued'; state.missions[MISSION].outcome = null; });
  assert.equal(currentMissionAttention(f.store.state, MISSION), null);
});

test('queued unavailable-coordinator blocker needs no invented run and resolves quietly when queued again', async t => {
  const f = await fixture(t, { graceMs: 8000 }); await f.store.mutate(state => { const mission = install(state, 'blocker'); mission.episodeRefs = []; delete state.runs[BOT]; });
  const attention = currentMissionAttention(f.store.state, MISSION); assert.ok(attention); assert.equal(attention.runId, undefined);
  await f.notifications.flush(); await f.store.mutate(state => { state.missions[MISSION].state = 'queued'; state.missions[MISSION].reason = ''; }); f.advance(8001); await f.notifications.flush();
  assert.equal(f.sent.length, 0); assert.equal(f.notifications.state.outbox[0].status, 'cancelled');
});

test('ordinary waits, progress, remote summaries, completed and stopped Missions produce no generic attention', async t => {
  const f = await fixture(t);
  for (const kind of ['owner_input', 'dependency', 'provider_recovery']) {
    await f.store.mutate(state => { const mission = install(state, 'blocker'); mission.waitCondition.kind = kind; }); await f.notifications.flush();
  }
  for (const outcome of ['achieved', 'stopped']) { await f.store.mutate(state => { const mission = install(state, 'blocker'); mission.state = 'terminal'; mission.outcome = outcome; }); await f.notifications.flush(); }
  await f.store.mutate(state => { const mission = install(state); mission.ownerEngineId = 'foreign_engine'; }); await f.notifications.flush();
  assert.equal(f.sent.length, 0); assert.deepEqual(f.notifications.unreadBots(), {});
});

test('an actual final reply is the sole completion notification and invalidates pending blocker attention', async t => {
  const f = await fixture(t, { graceMs: 8000 }); await f.store.mutate(state => install(state, 'blocker')); await f.notifications.flush();
  await f.store.mutate(state => {
    state.missions[MISSION].state = 'terminal'; state.missions[MISSION].outcome = 'blocked'; state.runs[BOT].status = 'completed';
    state.messages[BOT] = [{ id: 'mission_owner', role: 'user', source: 'mission', missionId: MISSION, runId: 'run_mission', createdAt: iso() }, { id: 'mission_final_reply', role: 'assistant', runId: 'run_mission', content: 'The exact final reply.', createdAt: iso() }];
  });
  assert.equal(currentMissionAttention(f.store.state, MISSION), null); await f.notifications.flush(); f.advance(8001); await f.notifications.flush();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].payload.aps.alert.body, 'The exact final reply.'); assert.equal(f.notifications.state.outbox.find(item => item.event.attentionId).status, 'cancelled');
});

function expire(state){const mission=install(state,'blocker');Object.assign(mission,{state:'terminal',outcome:'expired',stopRequested:true,expiryRequested:true,reason:'The shared Mission deadline expired.'});state.runs[BOT].status='interrupted';return mission;}
test('C/D ordinary wait and pause states stay quiet while real expiry and resource blockers retain attention',async t=>{
 const f=await fixture(t);for(const status of ['pausing','paused','waiting'])for(const kind of ['timer','dependency','file_change']){await f.store.mutate(state=>{const m=install(state,'blocker');m.state=status;m.waitCondition={kind};});assert.equal(currentMissionAttention(f.store.state,MISSION),null);}await f.store.mutate(expire);assert.ok(currentMissionAttention(f.store.state,MISSION));
 const stopped=structuredClone(f.store.state);stopped.missions[MISSION].outcome='stopped';assert.equal(currentMissionAttention(stopped,MISSION),null);const forged=structuredClone(f.store.state);forged.missions[MISSION].expiryRequested=false;assert.equal(currentMissionAttention(forged,MISSION),null);
 await f.store.mutate(state=>{const m=install(state,'blocker');m.state='terminal';m.outcome='budget_exhausted';});assert.ok(currentMissionAttention(f.store.state,MISSION));
});
test('expired attention retains exact attended/home identity and does not clear real unread replies',async t=>{
 const f=await fixture(t,{graceMs:8000,seed(state){state.messages[BOT]=[{id:'old_owner',role:'user',source:'chat',runId:'old_run',createdAt:iso()},{id:'old_reply',role:'assistant',runId:'old_run',content:'Real unread reply.',createdAt:iso()}];}});await f.store.mutate(expire);let attention=currentMissionAttention(f.store.state,MISSION);assert.equal(currentMissionAttention(f.store.state,MISSION,{ownerEngineId:'other_engine'}),null);f.setRole('replica');await f.notifications.flush();assert.equal(f.sent.length,0);assert.equal(f.notifications.status(f.device).reason,'home_server_only');f.setRole('hub');await f.store.mutate(state=>{state.missions[MISSION].attempt++;});attention=currentMissionAttention(f.store.state,MISSION);await f.notifications.flush();
 const receipt={botId:BOT,missionId:MISSION,attentionId:attention.attentionId,messageIds:[]};await f.notifications.acknowledge({...receipt,attentionId:'0'.repeat(32)});assert.equal(f.notifications.state.outbox[0].status,'pending');await f.notifications.acknowledge(receipt);assert.equal(f.notifications.state.outbox[0].status,'suppressed');assert.deepEqual(f.notifications.unreadBots(),{[BOT]:'old_reply'});f.advance(8001);await f.notifications.flush();assert.equal(f.sent.length,0);
});
test('retry cancels stale expiry attention and an actual final reply remains the sole completion push',async t=>{
 const f=await fixture(t,{graceMs:8000});await f.store.mutate(expire);await f.notifications.flush();await f.store.mutate(state=>{Object.assign(state.missions[MISSION],{state:'queued',outcome:null,stopRequested:false,expiryRequested:false});});f.advance(8001);await f.notifications.flush();assert.equal(f.sent.length,0);assert.equal(f.notifications.state.outbox[0].status,'cancelled');
 await f.store.mutate(state=>{const m=expire(state);m.attempt=1;});await f.notifications.flush();await f.store.mutate(state=>{state.messages[BOT]=[{id:'expired_owner',role:'user',source:'mission',missionId:MISSION,runId:'run_mission',createdAt:new Date(BASE+8001).toISOString()},{id:'expired_final',role:'assistant',runId:'run_mission',content:'The deadline expired; saved partial work remains.',createdAt:new Date(BASE+8001).toISOString()}];});assert.equal(currentMissionAttention(f.store.state,MISSION),null);await f.notifications.flush();f.advance(8001);await f.notifications.flush();assert.equal(f.sent.length,1);assert.equal(f.sent[0].payload.aps.alert.body,'The deadline expired; saved partial work remains.');
});

test('effort exhaustion is actionable attention while an ordinary owner pause stays quiet',async t=>{
 const f=await fixture(t);await f.store.mutate(state=>{const mission=install(state,'blocker');Object.assign(mission,{state:'paused',outcome:'budget_exhausted',pauseRequested:true,waitCondition:null,effort:{exhausted:true}});state.runs[BOT].status='interrupted';});
 const attention=currentMissionAttention(f.store.state,MISSION);assert.equal(attention.kind,'blocker');await f.notifications.flush();assert.ok(currentMissionAttention(f.store.state,MISSION));
 await f.store.mutate(state=>{const mission=state.missions[MISSION];mission.effort.exhausted=false;mission.outcome=null;});assert.equal(currentMissionAttention(f.store.state,MISSION),null);
});
