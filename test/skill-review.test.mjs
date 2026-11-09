import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { Providers } from '../lib/providers.mjs';
import { skillReviewDefinition } from '../lib/skill-review.mjs';
import { recordLearningChange } from '../lib/learning-changes.mjs';
import { estimateTokens } from '../lib/context-budget.mjs';

const call=(name,args,id=name)=>({id,name,arguments:args});
const skill={worthSaving:true,name:'verified-report-workflow',description:'Use for repeatable reports with independently checked output.',reason:'This sequence can be reused for each new report.',instructions:'## When to use\nRepeatable report creation.\n## Inputs\nAn owner-approved report specification.\n## Steps\n1. Write the requested report.\n2. Read the output back.\n3. Check its listing.\n## Verification\nCompare the saved content with the request.\n## Limitations\nThis fixture establishes mechanics only; adapt inputs and verify each new report.',evidenceCallIds:['task-write','task-read','task-list']};
const response=(changes={})=>({text:'',toolCalls:[call('skill_review_result',{...skill,...changes})],usage:{input_tokens:25,output_tokens:35}});
async function fixture(t,{policy='auto',review=async()=>response(),tools=['workspace','memory','skills'],primary}={}){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-skill-review-')),store=await new Store(directory).init();let step=0;
  await store.mutate(state=>{state.connections=[{id:'fixture',type:'custom',defaultModel:'fixture-model'}];state.proposals=[];Object.assign(state.bots[0],{connectionId:'fixture',approvalPolicy:policy,tools});});
  const reviews=[],engine=new NativeEngine(store,{runTimeout:15000,providers:{async complete(connection,request){step++;if(primary)return primary(request,step);return step===1?{toolCalls:[call('workspace_write',{path:'report.txt',content:'Verified fixture report.'},'task-write')]}:step===2?{toolCalls:[call('workspace_read',{path:'report.txt'},'task-read')]}:step===3?{toolCalls:[call('workspace_list',{path:'.'},'task-list')]}:{text:'The requested report is ready.',toolCalls:[]};},async reviewSkill(connection,request){reviews.push(request);return review(request);}}});
  await engine.recover();t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot=store.state.bots[0],run=async(options)=>{step=0;const admitted=await engine.start(bot.id,'Create and verify a reusable report workflow.',options);await engine.tasks.get(admitted.id);await engine.settleReviews();return store.state.runs[bot.id];};
  return {store,engine,bot,reviews,run,directory};
}

test('substantial owner work becomes an owner-reviewed skill suggestion after the reply, even under auto policy',async t=>{
  const h=await fixture(t),run=await h.run();assert.equal(run.status,'completed');assert.equal(run.skillReview.status,'suggested');assert.equal(h.reviews.length,1);
  assert.equal(run.usage.input_tokens,25);assert.equal(run.usage.output_tokens,35);
  assert.equal(h.store.state.skills.some(row=>row.id===skill.name),false);assert.equal(h.store.state.proposals.length,1);assert.equal(h.store.state.proposals[0].status,'pending');
  assert.ok(!run.events.some(row=>row.type==='approval.automatic' && row.tool==='skills_create'));
  const owner=h.store.state.messages[h.bot.id].find(row=>row.runId===run.id && row.role==='user');assert.equal(owner.learningChanges[0].kind,'skill');assert.equal(owner.learningChanges[0].status,'suggested');
  const reopened=await new Store(h.directory).init();assert.equal(reopened.state.proposals.length,1);
});

test('Balanced saves only a proposal, while Strict review also uses the pending Learning path',async t=>{
  const h=await fixture(t,{policy:'balanced'});const run=await h.run();assert.equal(run.status,'completed');assert.equal(run.skillReview.status,'suggested');assert.equal(h.store.state.skills.some(row=>row.id===skill.name),false);
  assert.equal(h.store.state.proposals[0].status,'pending');assert.equal(run.learningChanges[0].status,'suggested');
  // All work was already observed; switch current policy before the reviewer
  // returns. It cannot use the original auto policy to bypass Strict.
  let strict;strict=await fixture(t,{review:async()=>{await strict.store.mutate(state=>{state.bots[0].approvalPolicy='strict';});return response();}});
  const final=await strict.run();assert.equal(final.status,'completed');assert.equal(final.skillReview.status,'suggested');assert.equal(strict.store.state.skills.some(row=>row.id===skill.name),false);
});

test('simple work, disabled Skills and non-owner lanes do not trigger review',async t=>{
  const simple=await fixture(t,{primary:async()=>({text:'A short answer.',toolCalls:[]})});await simple.run();assert.equal(simple.reviews.length,0);
  const disabled=await fixture(t,{tools:['workspace']});await disabled.run();assert.equal(disabled.reviews.length,0);
  const unattended=await fixture(t);await unattended.run({source:'routine',lane:'routine:fixture'});assert.equal(unattended.reviews.length,0);
});

test('reviewer can decline saving and cannot invent evidence, exceed bounds or execute a tool',async t=>{
  for(const answer of [response({worthSaving:false}),response({evidenceCallIds:['invented','task-read','task-list']}),response({instructions:'x'.repeat(10001)}),{toolCalls:[call('skills_create',skill)]},response({extra:'not allowed'})]){
    const h=await fixture(t,{review:async()=>answer});const run=await h.run();assert.equal(run.status,'completed');assert.equal(h.store.state.skills.some(row=>row.id===skill.name),false);assert.equal(h.store.state.proposals.length,0);assert.ok(!run.learningChanges?.length);
  }
});

test('review failure keeps the primary answer and never exposes provider errors',async t=>{
  const h=await fixture(t,{review:async()=>{throw new Error('PRIVATE-REVIEW-ERROR');}});const run=await h.run();assert.equal(run.status,'completed');assert.equal(run.output,'The requested report is ready.');assert.equal(run.skillReview.status,'unavailable');assert.ok(!JSON.stringify(h.store.state).includes('PRIVATE-REVIEW-ERROR'));
});

test('the reply is delivered before the review runs; shutdown or revoked Skills during review publish nothing',async t=>{
  for(const action of ['close','revoke']){
    let enter,release;const entered=new Promise(resolve=>enter=resolve),pending=new Promise(resolve=>release=resolve);
    const h=await fixture(t,{review:async()=>{enter();await pending;return response();}}),admitted=await h.engine.start(h.bot.id,'Create a checked report.');await entered;
    // The run already finished and answered while the review is still in flight.
    await h.engine.tasks.get(admitted.id);assert.equal(h.store.state.runs[h.bot.id].status,'completed');assert.equal(h.store.state.runs[h.bot.id].output,'The requested report is ready.');
    let closing;
    if(action==='close')closing=h.engine.close();
    if(action==='revoke')await h.store.mutate(state=>{state.bots[0].tools=['workspace','memory'];});
    release();await closing;await h.engine.settleReviews();
    assert.equal(h.store.state.skills.some(row=>row.id===skill.name),false);assert.equal(h.store.state.proposals.length,0);assert.equal(h.reviews.length,1);
  }
});

test('review uses original model, bounded redacted evidence and instruction-only schema',async t=>{
  let h;h=await fixture(t,{review:async request=>{assert.equal(request.model,'fixture-model');assert.equal(request.maxOutputTokens,3000);assert.deepEqual(request.tools,[skillReviewDefinition]);assert.ok(estimateTokens(request.messages)+estimateTokens(request.tools)<=7000);assert.ok(!JSON.stringify(request).includes('private-fixture-secret'));return response({worthSaving:false});}});
  await h.store.mutate(state=>{state.connections[0].secret=h.store.seal('private-fixture-secret');});await h.run();
  let seen;await Providers.prototype.reviewSkill.call({complete:async(c,r)=>{seen=[c,r];return response();}},{id:'fixture'},{model:'fixture-model'});assert.equal(seen[1].model,'fixture-model');
});

test('Brain and memory acknowledgements require actual saves and survive failed subsequent work',async t=>{
  const h=await fixture(t,{primary:async(_,step)=>step===1?{toolCalls:[call('brain_write',{path:'methods/fixture',content:'# A retained lesson\nRead back saved output.'})]}:step===2?{toolCalls:[call('memory_set',{key:'preferred-format',value:'Markdown'})]}:Promise.reject(new Error('Fixture completion failed.'))});
  const run=await h.run();assert.equal(run.status,'failed');assert.deepEqual(run.learningChanges.map(row=>row.kind),['brain','memory']);
  const owner=h.store.state.messages[h.bot.id].find(row=>row.runId===run.id&&row.role==='user');assert.equal(owner.learningChanges.length,2);
  const context={bot:h.bot,runId:run.id};for(const output of [{error:'failed'},{path:'fake.md',sha256:'invalid'},{alreadyCompleted:true,path:'fixture.md',sha256:'a'.repeat(64)}])await recordLearningChange(h.engine,context,{name:'brain_write'},output);
  assert.equal(h.store.state.runs[h.bot.id].learningChanges.length,2);
});
