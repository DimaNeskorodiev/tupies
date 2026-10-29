import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';

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
  assert.deepEqual(fresh.state.bots.slice(1).map(bot=>bot.name),['Nova','Scout']);

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
