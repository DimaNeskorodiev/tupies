import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { modelHistoryForSession, sessionIdFor } from '../lib/sessions.mjs';

const PRIVATE='PRIVATE-TELEGRAM-CANARY-701';
async function fixture(t,complete) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-lane-context-')),store=await new Store(directory).init(),requests=[];
  const connection={id:'lane_provider',type:'custom',defaultModel:'fixture-model'};
  await store.mutate(state=>{state.connections.push(connection);for(const bot of state.bots){bot.connectionId=connection.id;bot.tools=['memory','workspace'];bot.approvalPolicy='balanced';}});
  const engine=new NativeEngine(store,{providers:{async complete(_connection,request){requests.push(request);return complete?complete(request):{text:'Owner-safe result.',toolCalls:[]};}}});
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const run=async(text,options={})=>{const started=await engine.start('bot_atlas',text,options);await engine.tasks.get(started.id);return store.state.runs.bot_atlas;};
  return {store,engine,connection,requests,run};
}

test('third-party Telegram work stays in its model lane and never reaches a later owner request',async t=>{
  const {store,requests,run}=await fixture(t,request=>({text:request.messages.some(message=>String(message.content).includes(PRIVATE))?`Private response ${PRIVATE}`:'Owner-safe result.',toolCalls:[]}));
  const stranger=await run(`A private task ${PRIVATE}`,{source:'telegram',lane:'telegram:channel:person'});assert.equal(stranger.status,'completed');
  const privateRequest=requests[0];assert.match(JSON.stringify(privateRequest),new RegExp(PRIVATE));
  assert.equal((store.state.conversations.bot_atlas || []).some(message=>String(message.content).includes(PRIVATE)),false);
  assert.equal((await run('Help with my own unrelated task.')).status,'completed');assert.doesNotMatch(JSON.stringify(requests[1]),new RegExp(PRIVATE));
  assert.ok(store.state.messages.bot_atlas.some(message=>String(message.content).includes(PRIVATE)),'the owner-visible display transcript is preserved');
});

test('room and routine completion bridges carry explicit trusted source scope',async t=>{
  const {store,run}=await fixture(t);
  await run('Prepare an owner routine report.',{source:'routine',lane:'routine:owner_report'});
  const bridge=store.state.conversations.bot_atlas.find(message=>message.sourceLane==='routine');
  assert.equal(bridge.sourceSessionId,sessionIdFor('bot_atlas','routine:owner_report'));assert.equal(bridge.runId,store.state.runs.bot_atlas.id);assert.match(bridge.content,/Elsewhere: routine/);
});

test('recognized legacy and tagged private bridges are filtered before model context and summary input',async t=>{
  const {store,engine,connection,requests,run}=await fixture(t);
  const legacy={role:'assistant',content:`[Elsewhere: a Telegram chat with someone else]\nAsked: ${PRIVATE}\nAnswered: ${PRIVATE}`};
  const tagged={role:'assistant',sourceLane:'telegram',sourceSessionId:sessionIdFor('bot_atlas','telegram:channel:person'),runId:'run_private',content:`Explicit scoped bridge ${PRIVATE}`};
  await store.mutate(state=>{
    state.messages.bot_atlas=[{id:'display_owner',role:'user',runId:'old_owner',content:'Keep PUBLIC-SOURCE-42.'},{id:'display_private',role:'user',runId:'run_private',sessionId:tagged.sourceSessionId,content:PRIVATE}];
    state.conversations.bot_atlas=[{role:'user',sourceMessageId:'display_owner',runId:'old_owner',content:'Keep PUBLIC-SOURCE-42.'},legacy,tagged,{role:'assistant',content:'PUBLIC-ANSWER-42.'}];
  });
  await run('Continue my own task.');assert.doesNotMatch(JSON.stringify(requests[0]),new RegExp(PRIVATE));assert.match(JSON.stringify(requests[0]),/PUBLIC-SOURCE-42/);
  assert.ok(store.state.conversations.bot_atlas.some(message=>message===legacy),'request filtering alone does not rewrite stored history');
  const beforeMessages=store.state.messages.bot_atlas.length;
  const result=await engine.compactSession({botId:'bot_atlas',sessionId:'bot_atlas',connection,model:'fixture-model',effective:16000,keepFrom:-1,topic:true});
  assert.equal(result.coverage.excludedPrivateBridges,2);assert.doesNotMatch(JSON.stringify(requests.at(-1)),new RegExp(PRIVATE));assert.doesNotMatch(JSON.stringify(store.state.conversations.bot_atlas),new RegExp(PRIVATE));
  assert.equal(store.state.messages.bot_atlas.length,beforeMessages+1);assert.ok(store.state.messages.bot_atlas.some(message=>message.content===PRIVATE));
});

test('lane filtering preserves the matching private lane and does not guess at ambiguous legacy summaries',()=>{
  const own=sessionIdFor('bot_atlas','telegram:own'),other=sessionIdFor('bot_atlas','telegram:other');
  const ownRecord={role:'assistant',sourceLane:'telegram',sourceSessionId:own,content:'Matching private record.'},otherRecord={role:'assistant',sourceLane:'telegram',sourceSessionId:other,content:'Other private record.'};
  assert.deepEqual(modelHistoryForSession([ownRecord,otherRecord],own),[ownRecord]);
  assert.deepEqual(modelHistoryForSession([{role:'assistant',sourceLane:'telegram',sourceSessionId:'bot_atlas',content:'Inconsistent private scope.'}],'bot_atlas'),[]);
  const summary={role:'user',compaction:true,content:'A preexisting generated summary with unknown source provenance.'};
  assert.deepEqual(modelHistoryForSession([summary],'bot_atlas'),[summary],'paraphrased historical summaries cannot be safely classified or erased by a marker filter');
});
