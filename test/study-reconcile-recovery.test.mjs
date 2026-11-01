import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { SkillsService } from '../lib/skills.mjs';
import { bundledSkills } from '../lib/skill-catalog.mjs';
import { brainWrite } from '../lib/brain.mjs';

const botId='bot_atlas',sha=text=>createHash('sha256').update(text).digest('hex');
const oldCanonical='Choose an indexable canonical URL for duplicate product pages.';
const oldMobile='Keep mobile SEO audits scoped to mobile product pages.';
const newCanonical='Use the secure HTTPS canonical URL when it is available.';
const newMobile='Include the actual mobile viewport in the SEO audit.';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const waitFor=async predicate=>{const until=Date.now()+10_000;while(Date.now()<until){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Timed out waiting for the disposable study recovery fixture.');};
const untilAborted=signal=>new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason||new Error('Synthetic shutdown.'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
const candidate=(title,content,segmentId)=>({type:'principle',title,content,reason:'Preserve complete SEO audit requirements.',scope:'Public product pages',conditions:[],exceptions:[],aliases:[],evidence:[{segmentId,quote:content}]});
function answer(request){
  const input=JSON.parse(request.messages.at(-1).content);
  if(input.phase==='select')return {text:JSON.stringify({candidates:[candidate('Canonical URL HTTPS requirement',newCanonical,input.segment.id),candidate('Mobile SEO viewport requirement',newMobile,input.segment.id)]})};
  if(input.phase==='check')return {text:JSON.stringify({acceptedIds:input.candidates.map(unit=>unit.id)})};
  assert.equal(input.phase,'reconcile');
  const decisions=input.candidates.filter(item=>input.pairs.some(pair=>pair.candidateId===item.id)).map(item=>{
    const title=item.unit.content===newCanonical?'Canonical URL eligibility':'Mobile SEO scope',existing=input.existing.find(other=>other.unit.title===title);
    assert.ok(existing,`Missing retained fixture knowledge ${title}`);
    assert.ok(input.pairs.some(pair=>pair.candidateId===item.id&&pair.otherId===existing.id));
    return {candidateId:item.id,otherId:existing.id,action:'enrich'};
  });
  return {text:JSON.stringify({decisions})};
}
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-reconcile-recovery-')),store=await new Store(directory).init(),skills=new SkillsService(store),requests=[],engines=[];
  await store.mutate(state=>{state.connections.push({id:'provider_reconcile_fixture',type:'openai',model:'fixture',contextWindow:128_000});Object.assign(state.bots[0],{connectionId:'provider_reconcile_fixture',model:'fixture',tools:['workspace','memory','skills'],approvalPolicy:'balanced',instructions:'Learn complete supported SEO audit knowledge.'});});
  const method=bundledSkills().find(item=>item.catalogId==='tupies-learn-from-material');await skills.install({catalogId:method.catalogId,version:method.version,digest:method.digest,botId});
  const make=currentStore=>{const engine=new NativeEngine(currentStore,{skills:new SkillsService(currentStore),providers:{async complete(_connection,request){requests.push(request);return answer(request);}}});engines.push(engine);return engine;},engine=make(store);await engine.recover();
  t.after(async()=>{for(const item of engines)await item.close();await Promise.all(engines.map(item=>item.store.queue));await fs.rm(directory,{recursive:true,force:true});});
  const candidates=[candidate('Canonical URL eligibility',oldCanonical,'old_canonical'),candidate('Mobile SEO scope',oldMobile,'old_mobile')],sourceReceipts=candidates.map(unit=>({segmentId:unit.evidence[0].segmentId,sourceId:unit.evidence[0].segmentId,sourceDigest:sha(unit.content),title:'Synthetic prior SEO guidance',locator:{page:1},text:unit.content}));
  await engine.studies.knowledge.publish(await engine.studies.knowledge.prepare(botId,'seed',candidates,{sourceReceipts}));
  const prior=(await engine.studies.knowledge.list(botId)).units;
  return {directory,store,engine,make,requests,prior};
}
async function resume(f,started){
  await f.engine.close();await f.store.queue;
  const interrupted=await f.engine.studies.read(botId,started.job.id);assert.equal(interrupted.status,'interrupted');
  const planId=interrupted.publicationPlans?.[0]||interrupted.planIds[0],calls=f.requests.length;
  const store=await new Store(f.directory).init(),next=f.make(store);await next.recover();await next.recoverAutonomous();await waitFor(()=>!next.tasks.size);
  const finished=await next.studies.read(botId,started.job.id),run=store.state.runs[botId];
  assert.equal(run.status,'completed',run.error);assert.equal(finished.status,'completed',finished.error);assert.equal(f.requests.length,calls,'Recovery must reuse selection and reconciliation without inference.');
  assert.equal(finished.result.batches.length,1);assert.equal(finished.result.batches[0].id,planId);assert.equal(finished.result.committedCount,2);
  const units=(await next.studies.knowledge.list(botId)).units;assert.equal(units.length,2);assert.deepEqual(units.map(unit=>unit.id).sort(),f.prior.map(unit=>unit.id).sort());assert.ok(units.every(unit=>unit.revision===2));
  for(const unit of units){assert.equal(unit.unit.evidence.length,2);assert.ok(unit.unit.content.includes(unit.unit.title==='Canonical URL eligibility'?oldCanonical:oldMobile));assert.ok(unit.unit.content.includes(unit.unit.title==='Canonical URL eligibility'?newCanonical:newMobile));}
  return {next,finished,planId};
}

test('restart after one semantic revision reuses its original publication journal without replay',async t=>{
  const f=await fixture(t),entered=deferred(),publish=f.engine.studies.knowledge.publish.bind(f.engine.studies.knowledge);let firstHash,unitId;
  f.engine.studies.knowledge.publish=async(plan,options={})=>{let turns=0;return publish(plan,{...options,guard:async()=>{await options.guard?.();if(++turns!==2)return;unitId=plan.actions[0].unitId;firstHash=(await f.engine.studies.knowledge.read(botId,unitId)).sha256;entered.resolve();await untilAborted(options.signal);}});};
  const started=await f.engine.studies.start(botId,{sources:[{name:'new-guidance.md',contentBase64:Buffer.from(`${newCanonical}\n\n${newMobile}`).toString('base64')}]});
  await waitFor(()=>firstHash);await entered.promise;
  const {next}=await resume(f,started);assert.equal((await next.studies.knowledge.read(botId,unitId)).sha256,firstHash,'The first committed revision must not be written again.');
});

test('restart reconciles an exact semantic note write interrupted before manifest activation',async t=>{
  const f=await fixture(t),entered=deferred(),state=f.engine.studies.knowledge.state.bind(f.engine.studies.knowledge);let held=false,writtenHash,unitId;
  f.engine.studies.knowledge.state=async(context,id)=>{const current=await state(context,id);if(!held&&current.note&&current.manifest&&!current.active&&current.note.content.includes(newCanonical)){held=true;unitId=id;writtenHash=current.note.sha256;entered.resolve();await untilAborted(context.signal);}return current;};
  const started=await f.engine.studies.start(botId,{sources:[{name:'new-guidance.md',contentBase64:Buffer.from(`${newCanonical}\n\n${newMobile}`).toString('base64')}]});
  await waitFor(()=>held);await entered.promise;
  const {next}=await resume(f,started);assert.equal((await next.studies.knowledge.read(botId,unitId)).sha256,writtenHash,'The exact interrupted note bytes must activate without rewriting.');
});

test('a knowledge journal with a read set activates its own exact staged write without rewriting',async t=>{
  const f=await fixture(t),knowledge=f.engine.studies.knowledge,saved=await knowledge.read(botId,f.prior.find(unit=>unit.title==='Canonical URL eligibility').id);
  const incoming={...saved.unit,targetId:saved.id,expectedSha256:saved.sha256,content:newCanonical,evidence:[{segmentId:'new_canonical',quote:newCanonical}]},plan=await knowledge.prepare(botId,'direct_activation_recovery',[incoming],{readSet:[{unitId:saved.id,sha256:saved.sha256,revision:saved.revision}],sourceReceipts:[{segmentId:'new_canonical',sourceId:'source_new',sourceDigest:sha(newCanonical),title:'Synthetic new source',locator:{page:2},text:newCanonical}]});
  // Match the durable checkpoint immediately preceding the real Brain write.
  const journal=await knowledge.load(plan.id);journal.status='publishing';journal.actions[0].status='writing';await knowledge.save(journal);
  const written=await brainWrite(await knowledge.context(botId),plan.actions[0].args);
  await assert.rejects(knowledge.read(botId,saved.id),error=>error.status===404);
  const recovered=await knowledge.publish(plan),current=await knowledge.read(botId,saved.id);
  assert.equal(recovered.status,'completed');assert.equal(current.revision,2);assert.equal(current.sha256,written.sha256);assert.equal(current.unit.content,newCanonical);
  assert.equal(f.requests.length,0);
});
