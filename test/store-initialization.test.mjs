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
