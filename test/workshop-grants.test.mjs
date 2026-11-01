import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { WorkshopGrants } from '../lib/workshop-grants.mjs';

const scope='a'.repeat(64),args={digest:'b'.repeat(64),integrationId:'fixture_api',tool:'read'},prepared={scopeIdentity:scope,review:{endpoint:'https://example.com/items'}};
const limits={maxRequests:2,minutes:1,intervalSeconds:0,botIds:['bot_atlas','bot_nova']};
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-grants-')),store=await new Store(directory).init();
  await store.mutate(state=>{for(const bot of state.bots)Object.assign(bot,{tools:['workshop','integrations'],integrationIds:['fixture_api']});state.runs={bot_atlas:{id:'root_run',status:'running'},bot_nova:{id:'child_run',status:'running'}};});
  const controllers=new Map([['root_run',new AbortController()],['child_run',new AbortController()]]);
  const engine={store,controllers,assertRunning(c){c.controller.signal.throwIfAborted();assert.equal(store.state.runs[c.bot.id].id,c.runId);assert.equal(store.state.runs[c.bot.id].status,'running');}};
  const context=(botId,runId)=>({bot:structuredClone(store.state.bots.find(b=>b.id===botId)),runId,controller:controllers.get(runId),delegation:{rootRunId:'root_run'}});
  const owner=context('bot_atlas','root_run'),child=context('bot_nova','child_run'),grants=new WorkshopGrants(engine);
  t.after(async()=>{grants.close();await grants.queue;await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,grants,owner,child,create:async input=>{const id=await grants.create(owner,args,prepared,input||limits);await grants.activate(owner,id);return id;},ledger:path.join(directory,'workshop-grants.json')};
}
test('owner grant shares one durably reserved budget across explicit participants and never resets it per child',async t=>{
  const f=await fixture(t),id=await f.create();let calls=0;
  const invoke=async()=>{calls++;const ledger=JSON.parse(await fs.readFile(f.ledger));assert.equal(ledger.grants[0].used,calls);assert.equal(ledger.grants[0].attempts.at(-1).status,'reserved');return {output:calls};};
  assert.equal(await f.grants.find(f.child,scope),id);
  assert.equal((await f.grants.run(f.owner,{id:'one'},prepared,id,invoke)).grant.remaining,1);
  assert.equal((await f.grants.run(f.child,{id:'two'},prepared,id,invoke)).grant.remaining,0);
  await assert.rejects(f.grants.run(f.owner,{id:'three'},prepared,id,invoke),/exhausted/);assert.equal(calls,2);
  const item=(await f.grants.list('bot_nova')).grants[0];assert.equal(item.used,2);assert.deepEqual(item.attempts.map(a=>a.status),['succeeded','succeeded']);
});
test('different task, bot, request or package scope cannot consume a grant',async t=>{
  const f=await fixture(t),id=await f.create({...limits,botIds:['bot_atlas']});const invoke=()=>assert.fail('must not dispatch');
  await assert.rejects(f.grants.run(f.child,{id:'one'},prepared,id,invoke),/does not authorize/);
  await assert.rejects(f.grants.run(f.owner,{id:'one'},{...prepared,scopeIdentity:'c'.repeat(64)},id,invoke),/does not authorize/);
  await assert.rejects(f.grants.run({...f.owner,delegation:{rootRunId:'other'}},{id:'one'},prepared,id,invoke),/inactive task/);
  assert.equal((await f.grants.list('bot_atlas')).grants[0].used,0);
});
test('concurrent participants cannot race or exceed the shared budget',async t=>{
  const f=await fixture(t),id=await f.create({...limits,maxRequests:1});let finish,started;const ready=new Promise(resolve=>started=resolve);
  const first=f.grants.run(f.owner,{id:'one'},prepared,id,async()=>{started();return new Promise(resolve=>finish=()=>resolve({output:1}));});await ready;
  await assert.rejects(f.grants.run(f.child,{id:'two'},prepared,id,()=>assert.fail()),/exhausted|Another participant/);finish();await first;assert.equal((await f.grants.list('bot_atlas')).grants[0].used,1);
});
test('a failed or uncertain attempt consumes a slot and blocks subsequent dispatch',async t=>{
  const f=await fixture(t),id=await f.create();await assert.rejects(f.grants.run(f.owner,{id:'one'},prepared,id,async()=>{throw new Error('uncertain fixture response');}),/uncertain fixture/);
  await assert.rejects(f.grants.run(f.owner,{id:'two'},prepared,id,()=>assert.fail()),/blocked/);const g=(await f.grants.list('bot_atlas')).grants[0];assert.equal(g.used,1);assert.equal(g.attempts[0].status,'failed-or-unknown');
});
test('owner revocation aborts in-flight transport and discards unfinished results',async t=>{
  const f=await fixture(t),id=await f.create();let started;const ready=new Promise(resolve=>started=resolve);
  const pending=f.grants.run(f.child,{id:'one'},prepared,id,signal=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});started();}));
  const rejected=assert.rejects(pending,/revoked/);await ready;await f.grants.revoke('bot_atlas',id);await rejected;
  assert.equal((await f.grants.list('bot_atlas')).grants[0].status,'revoked');await assert.rejects(f.grants.run(f.owner,{id:'two'},prepared,id,()=>assert.fail()),/revoked/);
});
test('root Stop cancels child use even without a child abort signal',async t=>{
  const f=await fixture(t),id=await f.create();let started;const ready=new Promise(resolve=>started=resolve);
  const pending=f.grants.run(f.child,{id:'one'},prepared,id,signal=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});started();}));
  const rejected=assert.rejects(pending,/root stopped/);await ready;f.engine.controllers.get('root_run').abort(new Error('root stopped'));await rejected;assert.equal((await f.grants.list('bot_atlas')).grants[0].used,1);
});
test('expiry, interval and replay checks do not spend another request',async t=>{
  const f=await fixture(t),id=await f.create({...limits,intervalSeconds:60});await f.grants.run(f.owner,{id:'one'},prepared,id,async()=>({output:1}));
  await assert.rejects(f.grants.run(f.owner,{id:'one'},prepared,id,()=>assert.fail()),/already reserved/);
  await assert.rejects(f.grants.run(f.owner,{id:'two'},prepared,id,()=>assert.fail()),/interval/);
  const ledger=JSON.parse(await fs.readFile(f.ledger));ledger.grants[0].expiresAt=Date.now()-1;await fs.writeFile(f.ledger,JSON.stringify(ledger));
  await assert.rejects(f.grants.run(f.owner,{id:'two'},prepared,id,()=>assert.fail()),/expired/);assert.equal((await f.grants.list('bot_atlas')).grants[0].used,1);
});
test('restart retains evidence but cannot restore authority; ending a task invalidates grants',async t=>{
  const f=await fixture(t),id=await f.create();await f.grants.run(f.owner,{id:'one'},prepared,id,async()=>({output:1}));
  const restarted=new WorkshopGrants(f.engine);assert.equal((await restarted.list('bot_atlas')).grants[0].status,'interrupted');await assert.rejects(restarted.run(f.owner,{id:'two'},prepared,id,()=>assert.fail()),/interrupted/);restarted.close();
  f.store.state.runs.bot_atlas.status='completed';assert.equal((await f.grants.list('bot_atlas')).grants[0].status,'task-ended');await assert.rejects(f.grants.run(f.child,{id:'two'},prepared,id,()=>assert.fail()),/inactive task/);
});
test('invalid limits, participant expansion, damaged ledger and symlinks fail closed',async t=>{
  const f=await fixture(t);
  for(const change of [{maxRequests:101},{minutes:0},{intervalSeconds:-1},{botIds:['bot_nova']},{botIds:['bot_atlas','missing']},{costLimit:10}])await assert.rejects(f.create({...limits,...change}));
  const id=await f.create();await fs.writeFile(f.ledger,'{"version":1,"grants":[{}]}');await assert.rejects(f.grants.run(f.owner,{id:'one'},prepared,id,()=>assert.fail()),/damaged/);
  await fs.rm(f.ledger);const target=path.join(f.store.directory,'synthetic-target');await fs.writeFile(target,'untouched');await fs.symlink(target,f.ledger);await assert.rejects(f.grants.list('bot_atlas'));assert.equal(await fs.readFile(target,'utf8'),'untouched');
});
test('a prepared owner grant has no authority until the approval commit activates it',async t=>{
  const f=await fixture(t),id=await f.grants.create(f.owner,args,prepared,limits);
  await assert.rejects(f.grants.run(f.owner,{id:'one'},prepared,id,()=>assert.fail()),/pending/);
  await f.grants.activate(f.owner,id);await f.grants.run(f.owner,{id:'one'},prepared,id,async()=>({output:1}));
  await f.grants.revokeScope('root_run',scope);await assert.rejects(f.grants.run(f.child,{id:'two'},prepared,id,()=>assert.fail()),/revoked/);
});
test('receipt persistence failure blocks further requests even before restart',async t=>{
  const f=await fixture(t),id=await f.create(),save=f.grants.save.bind(f.grants);let saves=0,calls=0;
  f.grants.save=async grants=>{if(++saves>1)throw new Error('synthetic disk failure');return save(grants);};
  await assert.rejects(f.grants.run(f.owner,{id:'one'},prepared,id,async()=>{calls++;return {output:1};}),/disk failure/);
  f.grants.save=save;
  await assert.rejects(f.grants.run(f.child,{id:'two'},prepared,id,()=>assert.fail()),/blocked/);assert.equal(calls,1);
  const record=JSON.parse(await fs.readFile(f.ledger)).grants[0];assert.equal(record.used,1);assert.equal(record.attempts[0].status,'reserved');
});
test('large teams retain the requesting bot in the bounded participant picker',async t=>{
  const f=await fixture(t);f.store.state.bots.unshift(...Array.from({length:25},(_,i)=>({id:`extra_${i}`,name:'Synthetic teammate',tools:['workshop','integrations'],integrationIds:['fixture_api']})));
  const offer=f.grants.offer(f.owner,args);assert.equal(offer.participants.length,20);assert.equal(offer.participants[0].id,'bot_atlas');
});
