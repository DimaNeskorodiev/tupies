import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { KnowledgeService } from '../lib/knowledge.mjs';
import { managedKnowledgeConflictPath } from '../lib/knowledge-paths.mjs';
import { brainNote } from '../lib/brain.mjs';
import { FileReplica } from '../lib/sync/files.mjs';

test('generated managed conflict identities are recognized without capturing ordinary legacy names',()=>{
  const id=`unit-${'a'.repeat(32)}`,conflict=`${id} (conflict Mac owner ${'b'.repeat(16)}).md`;
  assert.equal(managedKnowledgeConflictPath(`brain/tupies-managed-knowledge/${conflict}`),true);
  assert.equal(managedKnowledgeConflictPath(`BRAIN\\TUPIES-MANAGED-KNOWLEDGE\\${conflict.toUpperCase()}`),true);
  assert.equal(managedKnowledgeConflictPath(`tupies-managed-knowledge/${id} (conflict  ${'b'.repeat(16)}).md`),true);
  for(const relative of [`tupies-managed-knowledge/${id}.md`,'tupies-managed-knowledge/legacy-guide.md','tupies-managed-knowledge/legacy-guide (conflict Mac bbbbbbbbbbbbbbbb).md',`ordinary/${conflict}`,`tupies-managed-knowledge/${id} (conflict owner).md`])assert.equal(managedKnowledgeConflictPath(relative),false,relative);
});

test('actual sync conflict copies never bypass active managed knowledge or rollback eligibility',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-knowledge-conflict-')),store=await new Store(directory).init();
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot=store.state.bots[0],service=new KnowledgeService(store),tools=new AgentTools(store),context=await service.context(bot.id),replica=new FileReplica(directory);
  const quote='Conflict fixture canonical targets must be indexable.',candidate={type:'principle',title:'Conflict fixture canonical targets',content:quote,reason:'Supports SEO audits.',scope:'Synthetic test',conditions:[],exceptions:[],evidence:[{segmentId:'segment_1',quote}]};
  const plan=await service.prepare(bot.id,'conflict_fixture',[candidate],{sourceReceipts:[{segmentId:'segment_1',sourceId:'source_1',sourceDigest:createHash('sha256').update(quote).digest('hex'),title:'Synthetic source',locator:{page:1},text:quote}]}),published=await service.publish(plan),unit=published.units[0];
  const original=await fs.readFile(path.join(context.root,'brain',unit.path)),key=`file:workspaces/${bot.id}/brain/${unit.path}`;
  // FileReplica sanitizes Unicode labels; nested copies exercise its stem truncation.
  const copies=[];
  copies.push(await replica.conflictCopy(key,original,'Київ'));
  copies.push(await replica.conflictCopy(copies[0],original,'🧠'));
  copies.push(await replica.conflictCopy(copies[1],original,'Second engine label that reaches forty characters'));
  const relative=copy=>copy.slice(`file:workspaces/${bot.id}/brain/`.length);
  for(const copy of copies)assert.equal(managedKnowledgeConflictPath(relative(copy)),true);
  const search=()=>tools.execute(bot,'brain_search',{query:'Conflict fixture canonical targets'});
  assert.deepEqual((await search()).results.map(item=>item.path),[unit.path]);
  assert.deepEqual((await tools.recall(bot,{query:quote})).notes.map(item=>item.path),[unit.path]);
  for(const copy of copies.slice(0,2)){
    await assert.rejects(tools.execute(bot,'brain_read',{path:relative(copy)}),/not active/);
    await assert.rejects(brainNote(context,{path:relative(copy)}),/not active/);
  }
  // The longer, truncated stem also exceeds the existing direct-note path cap.
  await assert.rejects(tools.execute(bot,'brain_read',{path:relative(copies[2])}),error=>error.status===400);
  await service.rollback(bot.id,published.id);
  assert.equal((await search()).results.length,0);
  assert.equal((await tools.recall(bot,{query:quote})).notes.length,0);
  // The owner can still inspect all conflict bytes through ordinary Files.
  for(const copy of copies)assert.deepEqual(await fs.readFile(path.join(directory,copy.slice(5))),original);
  await fs.writeFile(path.join(context.root,'brain','tupies-managed-knowledge','legacy-guide.md'),'Legacy unrelated gardening guide.');
  assert.equal((await tools.execute(bot,'brain_search',{query:'gardening'})).results[0].path,'tupies-managed-knowledge/legacy-guide.md');
});
