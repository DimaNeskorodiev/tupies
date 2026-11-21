// Regression for 16–19 November 2026: the iPhone moved to a Release build (Apple production push) while the
// home server kept its sandbox-only key. Every alert was dropped as environment_mismatch with no visible trace.
// Fixtures only: plainly fake tokens, no Apple connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { Notifications } from '../lib/notifications.mjs';
import { createStudioServer } from '../server.mjs';

const TOKEN='ab'.repeat(32),BASE=Date.parse('2026-11-16T12:00:00Z');
const iso=n=>new Date(BASE+n).toISOString();
const enrollment=overrides=>({token:TOKEN,environment:'production',enabled:true,botReplies:true,routines:true,...overrides});

async function fixture(t,{environments=['sandbox']}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-push-delivery-'));
  const store=await new Store(directory).init();
  const device={id:'dev_phone',kind:'device',platform:'ios',name:'Fixture phone'};
  await store.mutate(state=>{state.devices.push(device);});
  let time=BASE;const sent=[],log=[];
  const transport={available:true,environments,get environment(){return this.environments[0];},supports(environment){return this.environments.includes(environment);},async send(request){sent.push(request);return {status:200};},close(){}};
  const sync={nodeId:'node_fixture',role:()=>'hub',devices:{find:id=>store.state.devices.find(item=>item.id===id && !item.revokedAt)}};
  const notifications=await new Notifications(store,{sync,transport,now:()=>time,graceMs:0,intervalMs:1_000_000,log:entry=>log.push(entry)}).init();
  t.after(async()=>{await notifications.close();await fs.rm(directory,{recursive:true,force:true});});
  const reply=async(id,at=0)=>{await store.mutate(state=>{const rows=state.messages.bot_atlas ||= [];rows.push({id:`user_${id}`,role:'user',source:'chat',runId:`run_${id}`,content:'Fixture request',createdAt:iso(at)},{id:`reply_${id}`,role:'assistant',runId:`run_${id}`,content:'Fixture reply',createdAt:iso(at)});});await notifications.flush();};
  return {store,device,transport,notifications,sent,log,reply,advance:ms=>{time+=ms;}};
}

test('a production iPhone on a sandbox-only engine is recorded as missing alerts, never silently dropped',async t=>{
  const f=await fixture(t);
  const status=await f.notifications.register(f.device,enrollment());
  assert.equal(status.available,false);assert.equal(status.reason,'environment_mismatch');
  assert.deepEqual(f.log.map(entry=>entry.kind),[]);
  await f.reply('one');await f.reply('two',1000);
  assert.equal(f.sent.length,0);assert.equal(f.notifications.state.outbox.length,0,'nothing is queued that Apple would reject');
  const after=f.notifications.status(f.device);
  assert.equal(after.delivery.status,'undelivered');assert.equal(after.delivery.lastError,'environment_mismatch');assert.equal(after.delivery.missed,2);
  assert.deepEqual(f.notifications.alert(),{reason:'environment_mismatch',missed:2});
  const health=f.notifications.health();
  assert.deepEqual(health.apple,{configured:true,environments:['sandbox']});
  assert.equal(health.devices.length,1);assert.equal(health.devices[0].name,'Fixture phone');assert.equal(health.devices[0].environment,'production');
  assert.equal(health.devices[0].ready,false);assert.equal(health.devices[0].missed.count,2);assert.equal(health.devices[0].reason,'environment_mismatch');
  assert.ok(!JSON.stringify(health).includes(TOKEN));
  // Exactly one diagnostic line for the whole stretch, not one per alert.
  assert.deepEqual(f.log.filter(entry=>entry.kind==='push.undelivered').map(({reason,environment})=>({reason,environment})),[{reason:'environment_mismatch',environment:'production'}]);
  const saved=await fs.readFile(f.notifications.file,'utf8');assert.ok(!saved.includes(TOKEN) && !saved.includes('Fixture reply'));
});

test('alerts resume once the engine also serves production, and the missing-alerts marker clears',async t=>{
  const f=await fixture(t);await f.notifications.register(f.device,enrollment());
  await f.reply('missed');assert.equal(f.notifications.alert().reason,'environment_mismatch');
  f.transport.environments=['sandbox','production'];f.advance(1000);
  assert.equal(f.notifications.status(f.device).available,true);
  await f.reply('delivered',2000);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].environment,'production');assert.equal(f.sent[0].payload.aps.alert.body,'Fixture reply');
  assert.equal(f.notifications.alert(),null);assert.equal(f.notifications.status(f.device).delivery.status,'sent');
  assert.equal(f.notifications.health().devices[0].ready,true);
  assert.ok(f.log.some(entry=>entry.kind==='push.restored' && entry.environment==='production'));
  assert.ok(!f.notifications.state.subscriptions.dev_phone.undelivered);
});

test('switching the phone back to a sandbox build delivers at once and logs the environment change',async t=>{
  const f=await fixture(t);await f.notifications.register(f.device,enrollment());await f.reply('missed');
  await f.notifications.register(f.device,enrollment({environment:'sandbox'}));
  assert.ok(f.log.some(entry=>entry.kind==='push.registration' && entry.environment==='sandbox' && entry.previousEnvironment==='production'));
  await f.reply('sandbox',1000);assert.equal(f.sent.length,1);assert.equal(f.sent[0].environment,'sandbox');
  assert.equal(f.notifications.alert(),null,'a new registration starts without the old marker');
});

test('an engine without Apple push setup says so for an enrolled phone instead of staying quiet',async t=>{
  const f=await fixture(t);f.transport.available=false;f.transport.environments=[];
  await f.notifications.register(f.device,enrollment({environment:'sandbox'}));await f.reply('quiet');
  assert.equal(f.sent.length,0);assert.equal(f.notifications.alert().reason,'not_configured');
  assert.equal(f.notifications.health().apple.configured,false);
});

test('a real chat run on the home server reaches a production iPhone through the engine, and the owner can read delivery health',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-push-e2e-'));
  const sent=[];
  const transport={available:true,environments:['sandbox','production'],environment:'sandbox',supports(environment){return this.environments.includes(environment);},async send(request){sent.push(request);return {status:200};},close(){}};
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,sleepGuard:false,notifications:{transport,graceMs:0},providers:{async complete(){return {text:'Fixture final answer.',toolCalls:[]};}}});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  await app.store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Fixture',model:'fixture-model',secret:app.store.seal('fixture-not-a-real-key')});for(const bot of state.bots)bot.connectionId='fixture-provider';state.devices.push({id:'dev_phone',kind:'device',platform:'ios',name:'Fixture phone'});});
  await app.notifications.register({id:'dev_phone',kind:'device',platform:'ios'},enrollment());
  await app.runtime.submit('bot_atlas','A fixture task.');await Promise.allSettled([...app.runtime.tasks.values()]);
  await app.notifications.flush();
  assert.equal(sent.length,1);assert.equal(sent[0].environment,'production');assert.equal(sent[0].payload.studio.botId,'bot_atlas');assert.equal(sent[0].payload.aps.alert.body,'Fixture final answer.');
  const {url}=await app.listen(0);
  assert.equal((await fetch(`${url}/api/notifications/health`)).status,401);
  const setup=await fetch(`${url}/api/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'fixture-workspace-password'})});
  const cookie=setup.headers.get('set-cookie').split(';')[0];
  const health=await (await fetch(`${url}/api/notifications/health`,{headers:{Cookie:cookie}})).json();
  assert.equal(health.sends,true);assert.deepEqual(health.apple.environments,['sandbox','production']);
  assert.equal(health.devices[0].last.status,'sent');assert.ok(!JSON.stringify(health).includes(TOKEN));
  const state=await (await fetch(`${url}/api/state`,{headers:{Cookie:cookie}})).json();assert.equal(state.pushAlert,null);
});
