import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('opt-in task observation is saved before automatic compaction, with running status',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-episode-engine-')),store=await new Store(directory).init();
  await store.mutate(state=>{
    state.connections=[{id:'provider_fixture',type:'custom',defaultModel:'test-model',contextWindow:16000}];
    Object.assign(state.bots[0],{connectionId:'provider_fixture',model:'test-model',tools:['workspace','memory'],approvalPolicy:'balanced',episodicMemory:true});
    state.conversations.bot_atlas=[];
    for(let index=0;index<50;index++)state.conversations.bot_atlas.push({role:'user',content:`Keep fixture requirement ${index}: ${'historical material '.repeat(100)}`},{role:'assistant',content:'Recorded as background.'});
  });
  const root=await getWorkspaceRoot(store,'bot_atlas'),note=path.join(root,'brain','daily',`${new Date().toISOString().slice(0,10)}.md`);let summaries=0,beforeSummary='';
  const engine=new NativeEngine(store,{runTimeout:5000,providers:{async complete(_connection,request){if(!request.tools.length){summaries++;beforeSummary=await fs.readFile(note,'utf8');return {text:'Earlier fixture requirements remain background; use stored sources for exact details.',toolCalls:[]};}return {text:'The current task finished.',toolCalls:[]};}}});
  await engine.recover();t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const admitted=await engine.start('bot_atlas','Continue the current fixture task.');
  const until=Date.now()+5000;while(isActive(store.state.runs.bot_atlas) && Date.now()<until)await delay(5);
  await engine.tasks.get(admitted.id);
  assert.ok(summaries>0,'the fixture must actually trigger automatic compaction');assert.match(beforeSummary,/Task observation \(compaction\)/);assert.match(beforeSummary,/Observed task status: running/);
  const saved=await fs.readFile(note,'utf8');assert.equal((saved.match(/Task observation \(compaction\)/g) || []).length,1);assert.match(saved,/Task observation \(finish\)/);assert.ok(!store.state.runs.bot_atlas.events.some(event=>event.type==='memory.episode_unavailable'));
});
