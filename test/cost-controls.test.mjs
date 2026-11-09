import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { PRUNED_OUTPUT } from '../lib/compaction.mjs';

const BOT='bot_atlas';
// An earlier task: one request, one tool call with a large output and the answer.
const earlierTask=(index,{output='',request=`Earlier request ${index}.`}={})=>[
  {role:'user',content:request,runId:`run_old_${index}`,sourceMessageId:`message_old_${index}`},
  {role:'assistant',content:'',runId:`run_old_${index}`,tool_calls:[{id:`old_${index}`,type:'function',function:{name:'http_fetch',arguments:'{"url":"https://example.com"}'}}]},
  {role:'tool',tool_call_id:`old_${index}`,runId:`run_old_${index}`,content:output},
  {role:'assistant',content:`Answer ${index}.`,runId:`run_old_${index}`}
];
const isSummaryRequest=request=>!request.tools?.length && /summar/i.test(String(request.messages?.[0]?.content || ''));

async function fixture(t,history) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-cost-controls-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{
    // "The model's full window" sends the whole stored history (no bounded earlier-task projection), like the Finance bot.
    // A 40K window: summary compaction starts at 55% (22K tokens) and the protected tail is 8K tokens.
    state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture-model',contextWindow:40_000});
    for(const bot of state.bots){bot.connectionId='fixture';bot.approvalPolicy='balanced';bot.contextLimit='max';}
    state.conversations[BOT]=history;
  });
  const engine=new NativeEngine(store,{runTimeout:20_000,executionMode:'bounded',providers:{async complete(_connection,request){
    requests.push(request);
    if(isSummaryRequest(request))return {text:'## Goal\nEarlier work, summarized.',toolCalls:[]};
    return {text:'Done.',toolCalls:[]};
  }}});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const run=async text=>{const started=await engine.start(BOT,text);await engine.tasks.get(started.id);return store.state.runs[BOT];};
  return {store,engine,requests,run};
}

test('old tool outputs are cleared without a model call when that brings the history well under the threshold',async t=>{
  const history=[...earlierTask(1,{output:'x'.repeat(60_000)}),...earlierTask(2,{output:'y'.repeat(60_000)}),...earlierTask(3,{output:'recent result'})];
  const f=await fixture(t,history),run=await f.run('A new question.');
  assert.equal(run.status,'completed',run.error);
  assert.ok(run.events.some(event=>event.type==='context.pruned' && event.prunedResults===2),JSON.stringify(run.events.map(event=>event.type)));
  assert.equal(f.requests.filter(isSummaryRequest).length,0,'no summary model call was needed');
  const conversation=f.store.state.conversations[BOT],outputs=conversation.filter(message=>message.role==='tool').map(message=>message.content);
  assert.deepEqual(outputs,[PRUNED_OUTPUT,PRUNED_OUTPUT,'recent result']);
  assert.ok(!conversation.some(message=>message.compaction),'no summary record');
  // Requests and answers stay, and the model saw the pruned history.
  for(const text of ['Earlier request 1.','Answer 2.','Earlier request 3.'])assert.ok(conversation.some(message=>message.content===text),text);
  assert.ok(!JSON.stringify(f.requests.at(-1).messages).includes('x'.repeat(1000)));
});

test('when pruning is not enough, the summary still runs after it',async t=>{
  const long=index=>`Earlier request ${index}: ${'detail '.repeat(4_000)}`;
  const history=[...earlierTask(1,{output:'x'.repeat(20_000),request:long(1)}),...earlierTask(2,{output:'y'.repeat(20_000),request:long(2)}),...earlierTask(3,{output:'recent'})];
  const f=await fixture(t,history),run=await f.run('Another question.');
  assert.equal(run.status,'completed',run.error);
  assert.ok(run.events.some(event=>event.type==='context.pruned'));
  assert.equal(f.requests.filter(isSummaryRequest).length,1);
  assert.ok(f.store.state.conversations[BOT][0].compaction,'the older part became a summary');
});
