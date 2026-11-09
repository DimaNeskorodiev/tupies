import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { Providers } from '../lib/providers.mjs';
import { rememberFact } from '../lib/agent-tools.mjs';
import { decideProposal } from '../lib/learning.mjs';
import { memorySavePhrases, memoryReviewDefinition } from '../lib/memory-review.mjs';
import { estimateTokens } from '../lib/context-budget.mjs';

const call=(name,args)=>({id:'fixture_'+name,name,arguments:args});
const reviewed=(changes=[],claims=[],reason='Durable owner fact.')=>({text:'',toolCalls:[call('memory_review_result',{changes,claims,reason})],usage:{input_tokens:20,output_tokens:10}});
const claim=(text,key='owner-name',value='Owner name is Fixture.')=>({text,key,value});
const fact={key:'owner-name',value:'Owner name is Fixture.',evidence:'My name is Fixture.'};

async function fixture(t,{complete=async()=>({text:'Nice to meet you.',toolCalls:[]}),review=async()=>reviewed(),policy='balanced',memory=true}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-memory-review-')),store=await new Store(directory).init(),requests=[],reviews=[];
  await store.mutate(state=>{state.connections=[{id:'fixture_provider',type:'custom',defaultModel:'fixture-model'}];Object.assign(state.bots[0],{connectionId:'fixture_provider',tools:memory?['memory']:[],approvalPolicy:policy});state.memory[state.bots[0].id]=[];state.proposals=[];});
  const engine=new NativeEngine(store,{runTimeout:5000,providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length);},async reviewMemory(connection,request){reviews.push({connection,request});return review(request,reviews.length);}}});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const bot=store.state.bots[0];
  const run=async(text,options)=>{const admitted=await engine.start(bot.id,text,options);await engine.tasks.get(admitted.id);await engine.settleReviews();return store.state.runs[bot.id];};
  return {store,engine,bot,requests,reviews,run,directory};
}

test('a plain owner statement automatically produces a source-linked Learning suggestion, with no direct write',async t=>{
  const h=await fixture(t,{review:async()=>reviewed([fact])});
  const result=await h.run('My name is Fixture.');
  assert.equal(result.status,'completed');assert.equal(h.reviews.length,1);assert.equal(h.requests.length,1);
  assert.equal(h.store.state.memory[h.bot.id].length,0);assert.equal(h.store.state.proposals.length,1);
  const proposal=h.store.state.proposals[0],message=h.store.state.messages[h.bot.id].find(message=>message.role==='user');
  assert.equal(proposal.status,'pending');assert.deepEqual(proposal.source.messageIds,[message.id]);assert.equal(proposal.changes[0].after.value,fact.value);
  assert.deepEqual(result.memoryReview,{status:'reviewed',proposed:1,guarded:false});
  assert.equal(result.usage.input_tokens,20);assert.equal(h.store.state.runHistory[h.bot.id][0].diagnostics.memoryReview.proposed,1);
  const reopened=await new Store(h.directory).init();assert.equal(reopened.state.proposals.length,1);
  await decideProposal(h.store,{botId:h.bot.id,proposalId:proposal.id,action:'accept',idle(){}});
  await h.run('What is my name?');assert.doesNotMatch(h.requests.at(-1).messages[0].content,/Owner name is Fixture/);assert.match(h.requests.at(-1).turnContext,/Owner name is Fixture/);
});

test('Strict permits only a pending automatic suggestion and retains owner review',async t=>{
  const h=await fixture(t,{policy:'strict',review:async()=>reviewed([fact])});await h.run('My name is Fixture.');
  assert.equal(h.store.state.memory[h.bot.id].length,0);assert.equal(h.store.state.proposals[0].status,'pending');
  assert.ok(!h.store.state.runs[h.bot.id].events.some(event=>event.type==='approval.requested'));
});

test('an unsupported save confirmation is replaced in the reply, canonical history and streamed partials',async t=>{
  const saved='I have saved your name to long-term memory.';let h;const partials=[];
  h=await fixture(t,{complete:async request=>{await request.onDelta(saved);return {text:saved,toolCalls:[],providerItems:[{type:'message',role:'assistant',content:[{type:'output_text',text:saved}]}]};},review:async()=>reviewed([fact],[claim(saved)])});
  h.store.onCommit(()=>partials.push(h.store.state.runs[h.bot.id]?.partialOutput || ''));
  const result=await h.run('My name is Fixture.');assert.equal(result.status,'completed');
  assert.match(result.output,/not verified/);assert.ok(!partials.some(text=>text.includes(saved)));
  assert.ok(!JSON.stringify(h.store.state.conversations[h.bot.id]).includes(saved));assert.ok(!JSON.stringify(h.store.state.messages[h.bot.id]).includes(saved));
  assert.equal(h.store.state.conversations[h.bot.id].at(-1).providerItems,undefined);
});

test('a successful exact memory write keeps its verified confirmation and survives a fresh task',async t=>{
  const saved='I have saved your name to long-term memory.';
  const h=await fixture(t,{complete:async(_request,index)=>index===1?{text:'',toolCalls:[call('memory_set',{key:fact.key,value:fact.value})]}:{text:saved,toolCalls:[]},review:async()=>reviewed([],[claim(saved)])});
  const result=await h.run('Remember: My name is Fixture.');assert.equal(result.status,'completed');assert.equal(result.output,saved);assert.equal(result.memoryReview.guarded,false);
  assert.equal(h.reviews.length,1);assert.equal(h.store.state.memory[h.bot.id][0].value,fact.value);assert.equal(h.store.state.proposals.length,0);
});

test('a save confirmation with no memory write in the run is replaced without waiting for any model review',async t=>{
  const saved='Запам’ятав: твоє ім’я Fixture.';
  const h=await fixture(t,{complete:async()=>({text:saved,toolCalls:[]}),review:async()=>reviewed()});
  const result=await h.run('Мене звати Fixture.');assert.doesNotMatch(result.output,/Запам’ятав/);assert.match(result.output,/не підтверджено/);
});

test('review failure preserves the useful answer, suppresses unsupported confirmation and reports unavailable coverage',async t=>{
  const h=await fixture(t,{complete:async()=>({text:'Here is the answer. I have saved your name to memory.',toolCalls:[]}),review:async()=>{throw new Error('PRIVATE-PROVIDER-ERROR');}});
  const result=await h.run('My name is Fixture.');assert.equal(result.status,'completed');assert.match(result.output,/Here is the answer/);assert.match(result.output,/not verified/);
  assert.equal(result.memoryReview.status,'unavailable');assert.ok(!JSON.stringify(h.store.state).includes('PRIVATE-PROVIDER-ERROR'));
});

test('review calls cannot execute ordinary tools and malformed or oversized proposals are ignored atomically',async t=>{
  for(const response of [{toolCalls:[call('memory_set',{key:'injected',value:'Do not save.'})]},reviewed([fact,fact,fact,fact]),reviewed([{...fact,pinned:true}]),{...reviewed([fact]),finishReason:'length'}]) {
    const h=await fixture(t,{review:async()=>response});const result=await h.run('My name is Fixture.');
    assert.equal(result.status,'completed');assert.equal(result.memoryReview.status,'unavailable');assert.equal(h.store.state.memory[h.bot.id].length,0);assert.equal(h.store.state.proposals.length,0);
  }
});

test('inferred facts need exact current-owner evidence; assistant output and unrelated old messages are not evidence',async t=>{
  const h=await fixture(t,{review:async()=>reviewed([{...fact,evidence:'Evidence that is absent.'}])});await h.run('My name is Fixture.');assert.equal(h.store.state.proposals.length,0);
});

test('existing facts and pending suggestions are deduplicated even when a different key is returned',async t=>{
  const h=await fixture(t,{review:async()=>reviewed([fact])});await h.run('My name is Fixture.');await h.run('My name is Fixture.');assert.equal(h.store.state.proposals.length,1);
  await h.store.mutate(state=>rememberFact(state,h.bot.id,{key:'another-key',value:fact.value}));await h.run('My name is Fixture.');assert.equal(h.store.state.proposals.length,1);
});

test('a declined automatic suggestion respects the shared cooldown and is not recreated',async t=>{
  const h=await fixture(t,{review:async()=>reviewed([fact])});await h.run('My name is Fixture.');
  await decideProposal(h.store,{botId:h.bot.id,proposalId:h.store.state.proposals[0].id,action:'reject',idle(){}});
  await h.run('My name is Fixture.');assert.equal(h.store.state.proposals.length,1);assert.equal(h.store.state.proposals[0].status,'rejected');
});

test('review input is bounded, credential-redacted and uses the run model snapshot',async t=>{
  let h;h=await fixture(t,{review:async request=>{const input=JSON.parse(request.messages[1].content);assert.ok(input.ownerMessage.length<=6000);assert.ok(input.assistantAnswer.length<=4000);assert.ok(!JSON.stringify(request).includes('fixture-private-token'));assert.equal(request.model,'fixture-model');assert.equal(request.maxOutputTokens,1536);assert.deepEqual(request.tools.map(tool=>tool.name),['memory_review_result']);return reviewed();}});
  await h.store.mutate(state=>{state.connections[0].secret=h.store.seal('fixture-private-token');});
  const result=await h.run('My name is Fixture. fixture-private-token '+'x'.repeat(7000));assert.equal(result.memoryReview.status,'reviewed');
});

test('large fact and pending collections stay within the separate total review evidence budget',async t=>{
  const h=await fixture(t,{complete:async()=>({text:'Ж'.repeat(4000),toolCalls:[]}),review:async request=>{assert.ok(estimateTokens(request.messages)+estimateTokens(request.tools)<=6000);return reviewed();}});
  await h.store.mutate(state=>{
    for(let index=0;index<40;index++)rememberFact(state,h.bot.id,{key:`fixture_${index}`,value:'Ж'.repeat(3000)});
    state.proposals=Array.from({length:20},(_,index)=>({id:`pending_${index}`,botId:h.bot.id,status:'pending',kind:'memory',changes:[{key:`p_${index}`,after:{value:'Ж'.repeat(4000)}}]}));
  });
  const result=await h.run('My name is Fixture. '+'Ж'.repeat(5900));assert.equal(result.status,'completed');assert.equal(result.memoryReview.status,'reviewed');
});

test('disabled Memory, third-party lanes, rooms and unattended tasks never start automatic review',async t=>{
  const disabled=await fixture(t,{memory:false});await disabled.run('My name is Fixture.');assert.equal(disabled.reviews.length,0);
  const h=await fixture(t);for(const options of [{source:'telegram',lane:'telegram:channel:42'},{source:'room',lane:'room:fixture',roomId:'fixture'},{source:'routine',lane:'routine:fixture'}])await h.run('My name is Fixture.',options);
  assert.equal(h.reviews.length,0);assert.equal(h.store.state.proposals.length,0);
});

test('the reply is delivered before the review runs, and shutdown during review commits no proposal',async t=>{
  let entered,release;const started=new Promise(resolve=>entered=resolve),pending=new Promise(resolve=>release=resolve);
  const h=await fixture(t,{review:async()=>{entered();await pending;return reviewed([fact]);}});
  const admitted=await h.engine.start(h.bot.id,'My name is Fixture.');await started;await h.engine.tasks.get(admitted.id);
  assert.equal(h.store.state.runs[h.bot.id].status,'completed');assert.ok(h.store.state.messages[h.bot.id].some(message=>message.role==='assistant'));assert.equal(h.store.state.proposals.length,0);
  const closing=h.engine.close();release();await closing;
  assert.equal(h.store.state.proposals.length,0);
});

test('a review runs once per finished run on the auxiliary model when one is configured',async t=>{
  const h=await fixture(t,{review:async()=>reviewed([fact])});
  await h.store.mutate(state=>{state.connections.push({id:'cheap_provider',type:'custom',defaultModel:'cheap-model'});state.settings.auxiliary={connectionId:'cheap_provider',model:'cheap-model'};});
  await h.run('My name is Fixture.');
  assert.equal(h.reviews.length,1);assert.equal(h.reviews[0].request.model,'cheap-model');assert.equal(h.reviews[0].connection.id,'cheap_provider');assert.equal(h.requests[0].model,'fixture-model');
  assert.equal(h.store.state.proposals.length,1);
});

test('without an auxiliary setting the review uses the bot’s own model',async t=>{
  const h=await fixture(t,{review:async()=>reviewed()});await h.run('My name is Fixture.');
  assert.equal(h.reviews[0].request.model,'fixture-model');
});

test('automatic review cannot overflow the pending queue or run after a failed primary completion',async t=>{
  const h=await fixture(t,{review:async()=>reviewed([fact])});
  await h.store.mutate(state=>{state.proposals=Array.from({length:20},(_,index)=>({id:`pending_${index}`,botId:h.bot.id,status:'pending',kind:'memory',changes:[],signature:`fixture_${index}`}));});
  const result=await h.run('My name is Fixture.');assert.equal(result.status,'completed');assert.equal(result.memoryReview.status,'capacity');assert.equal(h.store.state.proposals.length,20);
  const failed=await fixture(t,{complete:async()=>({text:'An incomplete answer.',toolCalls:[],finishReason:'length'})});
  assert.equal((await failed.run('My name is Fixture.')).status,'failed');assert.equal(failed.reviews.length,0);
});

test('fallback recognises common confirmations without rewriting file saves, negations or code examples',()=>{
  for(const text of ['Запам’ятав: твоє ім’я Fixture.','Я зберіг це в пам’яті.','Сохранил в памяти.','I have saved this to memory.','I have saved to memory that you do not like red.'])assert.equal(memorySavePhrases(text).length,1,text);
  for(const text of ['I saved the report.','I have not saved this to memory.','Я не зберіг це в пам’яті.','> Запам’ятав: приклад.','```text\nЗапам’ятав: приклад.\n```'])assert.equal(memorySavePhrases(text).length,0,text);
});

test('the production provider review surface preserves the selected connection and bounded request',async()=>{
  const connection={id:'fixture'},request={model:'fixture-model',tools:[memoryReviewDefinition],maxOutputTokens:1536};let seen;
  const result=await Providers.prototype.reviewMemory.call({complete:async(c,r)=>{seen=[c,r];return reviewed();}},connection,request);
  assert.deepEqual(seen,[connection,request]);assert.equal(result.toolCalls[0].name,'memory_review_result');
});
