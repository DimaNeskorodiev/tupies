import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { AgentTools, rememberFact } from '../lib/agent-tools.mjs';
import { coreMemorySelection, renderCoreFact, factRevision, memoryWriteAllowed, memorySourceFor, blendMemoryCandidates, possibleDuplicateFacts } from '../lib/memory-quality.mjs';
import { proposeMemory, decideProposal, listProposals } from '../lib/learning.mjs';
import { listDocuments, writeDocument } from '../lib/sync/docs.mjs';
import { sessionSearch } from '../lib/history.mjs';
import { sessionIdFor } from '../lib/sessions.mjs';

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-memory-quality-')),store=await new Store(directory).init();
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await store.mutate(state=>{state.memory.bot_atlas=[];state.messages.bot_atlas=[{id:'message_owner',role:'user',content:'Remember that our font is Inter.',createdAt:'2026-10-01T09:00:00Z',runId:'run_memory',source:'chat'}];});
  const bot={...store.state.bots.find(item=>item.id==='bot_atlas'),tools:['workspace','memory'],approvalPolicy:'balanced',episodicMemory:true};
  const context={bot,source:'chat',sessionId:bot.id,runId:'run_memory'};
  return {directory,store,bot,context,tools:new AgentTools(store)};
}

test('core recall retains pins then selects older task-relevant facts before recent unrelated ones',()=>{
  const entries=[{key:'safety',value:'Ask before spending.',pinned:true},{key:'font',value:'The typeface is Inter.',updatedAt:'2020-01-01'},{key:'lunch',value:'Soup.',updatedAt:'2026-10-28'}];
  assert.deepEqual(coreMemorySelection(entries,{query:'What typography do we use?',limit:2}).entries.map(entry=>entry.key),['safety','font']);
  assert.deepEqual(coreMemorySelection(entries,{limit:2}).entries.map(entry=>entry.key),['safety','lunch']);
});

test('core fact presentation marks truncation and reports omitted pins and a bounded prompt budget',()=>{
  const entries=[{key:'long',value:'x'.repeat(900),pinned:true},{key:'second',value:'y'.repeat(500),pinned:true},{key:'short',value:'usable'}];
  const result=coreMemorySelection(entries,{maxChars:550});
  assert.ok(result.diagnostics.usedChars<=550);assert.deepEqual(result.diagnostics.omittedPins,['second']);
  assert.deepEqual(result.diagnostics.truncated,['long']);assert.match(renderCoreFact(result.entries[0]),/truncated/);
  assert.equal(entries[0].value.length,900,'rendering does not rewrite stored facts');
});

test('equal-value duplicate candidates are disclosed for source review and known credentials are redacted',async t=>{
  const {store,tools,bot}=await fixture(t),value='Ada reviews the launch documents.';
  assert.deepEqual(possibleDuplicateFacts([{key:'reviewer',value},{key:'contact',value:value.toUpperCase()},{key:'yes',value:'yes'},{key:'also-yes',value:'yes'}]).map(item=>item.keys),[['reviewer','contact']]);
  await store.mutate(state=>state.connections.push({id:'fixture-memory-key',type:'openai',secret:store.seal('fixture-secret-memory-token')}));
  await tools.execute(bot,'memory_set',{key:'credential',value:'Never retain fixture-secret-memory-token.'});
  assert.ok(!JSON.stringify(store.state.memory.bot_atlas).includes('fixture-secret-memory-token'));
});

test('direct owner provenance is source-linked, bounded and changes preserve a superseded revision',async t=>{
  const {store,context,tools,bot}=await fixture(t),source=memorySourceFor(store.state,context);
  await tools.execute(bot,'memory_set',{key:'font',value:'Inter.'},{memorySource:source});
  const first=structuredClone(store.state.memory.bot_atlas[0]);assert.deepEqual(first.provenance,{kind:'owner-chat',messageIds:['message_owner'],observedAt:'2026-10-01T09:00:00.000Z'});
  await store.mutate(state=>rememberFact(state,bot.id,{key:'font',value:'SF Pro.',source:{kind:'owner-edit',observedAt:'2026-10-02T00:00:00Z'}}));
  const next=store.state.memory.bot_atlas[0];assert.equal(next.id,first.id);assert.equal(next.supersedes.revision,factRevision(first));assert.notEqual(next.revision,first.revision);
  assert.equal(next.provenance.kind,'owner-edit');
});

test('new proposal revision guards notice a provenance-only change and undo restores exact fact metadata',async t=>{
  const {store,context}=await fixture(t);
  await store.mutate(state=>rememberFact(state,context.bot.id,{key:'font',value:'Inter.',source:{kind:'owner-edit',observedAt:'2026-10-01T00:00:00Z'}}));
  const before=structuredClone(store.state.memory.bot_atlas[0]);
  const first=await proposeMemory(store,context,{changes:[{key:'font',value:'SF Pro.'}],reason:'Updated preference.',sourceMessageIds:['message_owner']});
  await store.mutate(state=>rememberFact(state,context.bot.id,{key:'font',value:'Inter.',source:{kind:'owner-edit',observedAt:'2026-10-02T00:00:00Z'}}));
  await assert.rejects(decideProposal(store,{botId:context.bot.id,proposalId:first.proposalId,action:'accept',idle(){}}),/changed since/);
  const current=structuredClone(store.state.memory.bot_atlas[0]);
  const second=await proposeMemory(store,context,{changes:[{key:'font',value:'SF Pro.'}],reason:'Updated preference.',sourceMessageIds:['message_owner']});
  await decideProposal(store,{botId:context.bot.id,proposalId:second.proposalId,action:'accept',idle(){}});
  assert.equal(store.state.memory.bot_atlas[0].provenance.kind,'reviewed');assert.deepEqual(store.state.memory.bot_atlas[0].provenance.messageIds,['message_owner']);
  assert.equal((await listProposals(store,context.bot.id)).proposals.find(item=>item.id===second.proposalId).undoable,true);
  await decideProposal(store,{botId:context.bot.id,proposalId:second.proposalId,action:'undo',idle(){}});
  assert.deepEqual(store.state.memory.bot_atlas[0],current);assert.notDeepEqual(current.provenance,before.provenance);
});

test('fact provenance and review revisions round-trip through existing sync documents without syncing runs',async t=>{
  const {store,context}=await fixture(t);
  await store.mutate(state=>rememberFact(state,context.bot.id,{key:'font',value:'Inter.',source:memorySourceFor(state,context)}));
  const [key,value]=[...listDocuments(store.state,store)].find(([key])=>key.startsWith('mem:'));
  const replica={};assert.equal(writeDocument(replica,key,structuredClone(value),store),true);
  assert.deepEqual(replica.memory.bot_atlas[0],store.state.memory.bot_atlas[0]);assert.equal(replica.runs,undefined);assert.equal(value.provenance.runId,undefined);
});

test('undo restoring exact metadata still refuses a full core-memory collection atomically',async t=>{
  const {store,context}=await fixture(t);
  await store.mutate(state=>rememberFact(state,context.bot.id,{key:'font',value:'Inter.',source:{kind:'owner-edit'}}));
  const proposal=await proposeMemory(store,context,{changes:[{key:'font',remove:true}],reason:'No longer needed.'});
  await decideProposal(store,{botId:context.bot.id,proposalId:proposal.proposalId,action:'accept',idle(){}});
  await store.mutate(state=>{for(let index=0;index<200;index++)rememberFact(state,context.bot.id,{key:`other-${index}`,value:'Current.'});});
  await assert.rejects(decideProposal(store,{botId:context.bot.id,proposalId:proposal.proposalId,action:'undo',idle(){}}),/memory is full/);
  assert.equal(store.state.memory.bot_atlas.length,200);assert.equal(store.state.proposals[0].status,'accepted');
});

test('the engine lane predicate refuses routine, room, teammate and third-party direct core writes',()=>{
  const bot={id:'bot_atlas'};
  assert.equal(memoryWriteAllowed({bot,source:'chat',sessionId:bot.id}),true);
  assert.equal(memoryWriteAllowed({bot,source:'telegram',sessionId:bot.id}),true,'authenticated owner DMs use the trusted Bot Chat lane');
  for(const context of [{source:'routine'},{source:'delegation'},{source:'telegram'},{source:'chat',sessionId:'session_other'},{source:'chat',parentRunId:'run_parent'},{source:'chat',fromBotId:'bot_nova'}])assert.equal(memoryWriteAllowed({bot,...context}),false);
});

test('blended candidates deduplicate and stay bounded while caller-scoped history excludes third-party messages',async t=>{
  const {store,context}=await fixture(t),telegram=sessionIdFor(context.bot.id,'telegram:channel:42');
  await store.mutate(state=>state.messages.bot_atlas.push({id:'message_private',role:'user',content:'The secret font is Private.',runId:'run_other',sessionId:telegram,createdAt:'2026-10-01T10:00:00Z'}));
  const history=sessionSearch(store.state,{...context,runId:'run_new'},{query:'font'}).results;
  assert.ok(!history.some(item=>item.messageId==='message_private'));
  const result=blendMemoryCandidates({query:'font',facts:[{key:'font',value:'Inter.'}],notes:[{path:'font.md',excerpt:'font: Inter.'},{path:'other.md',excerpt:'font '.repeat(1000)}],history,maxChars:300});
  assert.equal(result.candidates.filter(item=>item.text==='font: Inter.').length,1);assert.ok(result.usedChars<=300);assert.equal(result.truncated,true);
  assert.ok(!JSON.stringify(result).includes('Private'));
});

test('automatic note recall expands explicit lexical alternatives and returns source versions/partial coverage',async t=>{
  const {tools,bot}=await fixture(t);
  await tools.execute(bot,'brain_write',{path:'project/cost',content:'# Project cost\n\nThe project expense ceiling is 100 EUR.\n\n'+'Other details. '.repeat(300)});
  const recalled=await tools.recall(bot,{query:'What is the project budget?',maxChars:500});
  assert.equal(recalled.notes[0].path,'project/cost.md');assert.match(recalled.notes[0].sha256,/^[a-f0-9]{64}$/);assert.equal(recalled.notes[0].partial,true);assert.ok(recalled.notes[0].excerpt.length<=500);
});

test('opt-in episodic notes preserve actual status, deduplicate concurrent phases and never write private/strict lanes',async t=>{
  const {tools,bot,context,store}=await fixture(t);
  assert.equal((await tools.recordEpisode({...context,bot:{...bot,episodicMemory:false}},{status:'completed'})).skipped,'disabled');
  assert.equal((await tools.recordEpisode({...context,source:'telegram'},{status:'completed'})).skipped,'private-lane');
  assert.equal((await tools.recordEpisode({...context,bot:{...bot,approvalPolicy:'strict'}},{status:'completed'})).skipped,'exact-approval-required');
  const results=await Promise.all([tools.recordEpisode(context,{status:'failed'}),tools.recordEpisode(context,{status:'failed'})]);
  assert.equal(results.filter(item=>item.saved).length,1);assert.equal(results.filter(item=>item.skipped==='duplicate').length,1);
  const daily=await tools.execute(bot,'brain_read',{path:results[0].path});
  assert.match(daily.content,/Observed task status: failed/);assert.match(daily.content,/not proof that every requested outcome is correct/);assert.match(daily.content,/message_owner/);
  assert.equal((daily.content.match(/<!-- tupies-episode:/g) || []).length,1);assert.ok(!daily.content.includes(context.runId));
  for(let index=0;index<20;index++)await store.mutate(state=>state.messages.bot_atlas.push({id:`message_${index}`,role:'user',content:'Task.',runId:`run_${index}`}));
  for(let index=0;index<19;index++)assert.equal((await tools.recordEpisode({...context,runId:`run_${index}`},{status:'completed'})).saved,true);
  assert.equal((await tools.recordEpisode({...context,runId:'run_19'},{status:'completed'})).skipped,'daily-limit');
});
