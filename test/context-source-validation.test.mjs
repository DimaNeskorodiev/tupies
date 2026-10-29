import test from 'node:test';
import assert from 'node:assert/strict';
import { historySourceScope } from '../lib/history.mjs';
import { sessionIdFor } from '../lib/sessions.mjs';
import { scopedHistorySources, contextHandoff } from '../lib/context-handoff.mjs';
import { summarizeHistory } from '../lib/compaction.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';

test('engine summary citation scopes include current readable messages and exclude other people’s lanes',()=>{
  const bot={id:'bot_a'},privateLane=sessionIdFor(bot.id,'telegram:channel:stranger'),room=sessionIdFor(bot.id,'room:team');
  const state={messages:{bot_a:[
    {id:'owner_1',role:'user',runId:'run_owner',content:'Owner request.'},
    {id:'current',role:'user',runId:'run_current',content:'Current request.'},
    {id:'private_1',role:'user',runId:'run_private',sessionId:privateLane,content:'Private request.'},
    {id:'private_2',role:'assistant',runId:'run_private',content:'Private reply.'},
    {id:'room_1',role:'user',runId:'run_room',sessionId:room,content:'Room request.'},
  ]}};
  const owner=historySourceScope(state,{bot,sessionId:bot.id,runId:'run_current'});
  assert.deepEqual([...owner.messageIds],['owner_1','current','room_1']);assert.deepEqual([...owner.runIds],['run_owner','run_current','run_room']);
  const stranger=historySourceScope(state,{bot,sessionId:privateLane});assert.deepEqual([...stranger.messageIds],['private_1','private_2']);assert.deepEqual([...stranger.runIds],['run_private']);
});

test('unreadable current and inherited source identities downgrade without changing the original history or excerpts',()=>{
  const inherited=contextHandoff([{role:'user',sourceMessageId:'private_1',runId:'run_private',content:'Must preserve budget EUR 42.'}]);
  const messages=[{role:'user',compaction:true,compactionHandoff:inherited,content:'Earlier summary.'},{role:'user',sourceMessageId:'invented',runId:'run_unknown',content:'Keep the export unfinished.'},{role:'user',sourceMessageId:'owner_1',runId:'run_owner',content:'Never publish it.'}],before=structuredClone(messages);
  const scoped=scopedHistorySources(messages,{messageIds:new Set(['owner_1']),runIds:new Set(['run_owner'])});
  assert.deepEqual(messages,before);assert.equal(scoped.messages[1].sourceMessageId,undefined);assert.equal(scoped.messages[1].runId,undefined);assert.equal(scoped.messages[2].sourceMessageId,'owner_1');
  assert.equal(scoped.messages[0].compactionHandoff.requirements[0].source.messageId,undefined);assert.equal(scoped.messages[0].compactionHandoff.requirements[0].source.runId,undefined);
  assert.match(scoped.messages[0].compactionHandoff.requirements[0].text,/budget EUR 42/);assert.ok(scoped.diagnostics.rejectedMessageReferences>=2);assert.ok(scoped.diagnostics.rejectedRunReferences>=2);
});

test('production summary requests and handoffs only expose source IDs in the trusted scope',async()=>{
  const requests=[],result=await summarizeHistory({messages:[{role:'user',sourceMessageId:'private_1',runId:'private_run',content:'Must retain number AX-42.'},{role:'user',sourceMessageId:'owner_1',runId:'owner_run',content:'Keep work incomplete.'}],sourceScope:{messageIds:new Set(['owner_1']),runIds:new Set(['owner_run'])},complete:async request=>{requests.push(request);return {text:'Pending work.'};}});
  assert.doesNotMatch(JSON.stringify(requests),/private_1|private_run/);assert.match(JSON.stringify(requests),/owner_1/);assert.match(JSON.stringify(requests),/AX-42/);
  assert.equal(result.handoff.requirements[0].source.messageId,undefined);assert.equal(result.handoff.requirements[1].source.messageId,'owner_1');assert.equal(result.coverage.sourceReferences.validated,true);assert.equal(result.coverage.sourceReferences.rejectedMessageReferences,1);assert.match(result.summary,/unverified source reference/);
});

test('a failed final merge cannot report complete summary coverage',async()=>{
  const messages=Array.from({length:40},(_,index)=>({role:'user',content:`Must retain budget ${index}. ${'text '.repeat(200)}`}));
  const result=await summarizeHistory({messages,effective:8000,fallback:true,complete:async(_request,metadata)=>{if(metadata.stage==='merge')throw new Error('Merge unavailable.');return {text:'Exact chunk observations remain pending.'};}});
  assert.ok(result.coverage.summaryCalls>1);assert.equal(result.method,'partial-summary');assert.equal(result.coverage.mergeFailed,true);assert.equal(result.coverage.complete,false);assert.equal(result.coverage.failedChunks,0);assert.match(result.summary,/final merge failed/);
});

test('engine compaction validates citation availability before invoking its provider',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-context-scope-')),store=await new Store(directory).init(),requests=[];
  const connection={id:'scope_provider',type:'custom',defaultModel:'fixture-model'},privateLane=sessionIdFor('bot_atlas','telegram:channel:stranger');
  await store.mutate(state=>{
    state.connections.push(connection);
    state.messages.bot_atlas=[{id:'owner_source',role:'user',runId:'run_owner',content:'Must keep identifier OWNER-42.'},{id:'private_source',role:'user',runId:'run_private',sessionId:privateLane,content:'Private task.'}];
    state.conversations.bot_atlas=[{role:'user',sourceMessageId:'owner_source',runId:'run_owner',content:'Must keep identifier OWNER-42.'},{role:'user',sourceMessageId:'private_source',runId:'run_private',content:'Keep the export unfinished.'}];
  });
  const engine=new NativeEngine(store,{providers:{async complete(_connection,request){requests.push(request);return {text:'The owner export remains unfinished.'};}}});
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const result=await engine.compactSession({botId:'bot_atlas',sessionId:'bot_atlas',connection,model:'fixture-model',effective:16000,keepFrom:-1,topic:true});
  assert.equal(result.coverage.sourceReferences.validated,true);assert.equal(result.coverage.sourceReferences.rejectedMessageReferences,1);
  assert.doesNotMatch(JSON.stringify(requests),/private_source|run_private/);assert.match(JSON.stringify(requests),/owner_source/);
  assert.equal(store.state.messages.bot_atlas.length,3,'the complete stored transcript and compaction notice remain');
});
