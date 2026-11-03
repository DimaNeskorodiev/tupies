import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, botReasoningPreference } from '../lib/store.mjs';
import { listDocuments, writeDocument } from '../lib/sync/docs.mjs';

test('fresh workspaces start with Roki and reopening preserves the owner’s existing bots',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-roki-seed-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const fresh=await new Store(directory).init();
  assert.equal(fresh.created,true);
  assert.equal(fresh.state.bots[0].id,'bot_atlas');
  assert.equal(fresh.state.bots[0].name,'Roki');
  assert.equal(fresh.state.bots[0].icon,'roki');
  assert.equal(fresh.state.bots[0].color,'slate');
  assert.match(fresh.state.bots[0].instructions,/^You are Roki,/);
  assert.deepEqual(fresh.state.bots.slice(1).map(bot=>bot.name),['Ops','Scout']);

  // Existing first-run defaults are owner data, not a migration target.
  await fresh.mutate(state=>Object.assign(state.bots[0],{
    name:'Atlas',icon:'creature:owner-choice',color:'mint',instructions:'Keep my instructions.',
  }));
  const existing=structuredClone(fresh.state.bots);
  const reopened=await new Store(directory).init();
  assert.equal(reopened.created,false);
  assert.deepEqual(reopened.state.bots,existing);
});

test('an existing workspace with a missing vault key refuses startup without creating a replacement',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-missing-vault-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init();
  await store.mutate(state=>state.connections.push({id:'fixture',type:'openai',secret:store.seal('disposable-recovery-secret')}));
  const original=await fs.readFile(store.file);await fs.rm(path.join(directory,'vault.key'));
  await assert.rejects(new Store(directory).init(),/vault key is missing.*Restore/i);
  assert.deepEqual(await fs.readFile(store.file),original);
  await assert.rejects(fs.stat(path.join(directory,'vault.key')),error=>error.code==='ENOENT');
});

test('a missing state file cannot bootstrap over retained runtime data, while a key-only interrupted first start can recover',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-missing-state-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init(),key=await fs.readFile(path.join(directory,'vault.key'));await fs.rm(store.file);
  await assert.rejects(new Store(directory).init(),/state file is missing.*Restore/i);
  await assert.rejects(fs.stat(store.file),error=>error.code==='ENOENT');assert.deepEqual(await fs.readFile(path.join(directory,'vault.key')),key);
  const fresh=path.join(directory,'interrupted-first-start');await fs.mkdir(fresh);await fs.writeFile(path.join(fresh,'vault.key'),key);
  assert.equal((await new Store(fresh).init()).created,true);
});

test('High defaults migrate legacy blank preferences once and preserve explicit provider defaults across sync and restart',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-reasoning-default-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init();
  assert.ok(store.state.bots.every(bot=>bot.reasoningEffort==='auto' && bot.reasoningEffortVersion===1));
  await store.mutate(state=>{
    delete state.bots[0].reasoningEffortVersion;state.bots[0].reasoningEffort='';
    delete state.bots[1].reasoningEffortVersion;state.bots[1].reasoningEffort='low';
    state.bots[2].reasoningEffort='';
  });
  const migrated=await new Store(directory).init();
  assert.deepEqual(migrated.state.bots.map(bot=>bot.reasoningEffort),['auto','low','']);
  const wire=structuredClone(listDocuments(migrated.state,migrated,'wire').get('bot:bot_scout'));
  assert.equal(wire.reasoningEffortVersion,1);assert.equal(wire.reasoningEffort,'');
  await migrated.mutate(state=>{state.bots[2].reasoningEffort='auto';assert.equal(writeDocument(state,'bot:bot_scout',wire,migrated),true);});
  const reopened=await new Store(directory).init();
  assert.deepEqual(reopened.state.bots.map(bot=>bot.reasoningEffort),['auto','low','']);
});


test('legacy sync preferences resolve to automatic High without changing replicated bytes',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-legacy-reasoning-sync-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init(),wire=structuredClone(store.state.bots[0]);
  wire.reasoningEffort='';delete wire.reasoningEffortVersion;
  const bytes=JSON.stringify(wire);assert.equal(writeDocument(store.state,`bot:${wire.id}`,wire,store),true);
  assert.equal(botReasoningPreference(store.state.bots[0]),'auto');
  assert.equal(JSON.stringify(wire),bytes);assert.equal(JSON.stringify(listDocuments(store.state,store,'wire').get(`bot:${wire.id}`)),bytes);
});
