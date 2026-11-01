import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { KnowledgeService } from '../lib/knowledge.mjs';
import { MANAGED_KNOWLEDGE_FOLDER, protectedKnowledgeControlPath } from '../lib/knowledge-paths.mjs';
import { brainWrite } from '../lib/brain.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const sourceText='Canonical URLs consolidate duplicate signals. Use a self-referencing canonical on the preferred URL. Do not point a canonical to a non-indexable target. Unselected source-only canary: full-source-must-not-persist.';
const receipts=[{segmentId:'segment_1',sourceId:'source_1',sourceDigest:digest(sourceText),title:'Synthetic SEO handbook',locator:{pageStart:7,pageEnd:8},text:sourceText}];
function candidate(overrides={}) {return {id:'model-candidate-one',type:'principle',title:'Canonical target eligibility',content:'Choose an indexable preferred URL for canonical consolidation.',reason:'Supports the SEO bot’s technical audits.',scope:'Search engine canonical URLs',conditions:['The target must be indexable.'],exceptions:['A canonical is a hint rather than proof of indexing.'],aliases:['канонічна адреса'],evidence:[{segmentId:'segment_1',quote:'Do not point a canonical to a non-indexable target.'}],...overrides};}
async function fixture(t,policy='balanced') {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-knowledge-')),store=await new Store(directory).init();
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot=store.state.bots[0];bot.approvalPolicy=policy;
  const service=new KnowledgeService(store),context=await service.context(bot.id),tools=new AgentTools(store);
  const prepare=(job='study_1',values=[candidate()])=>service.prepare(bot.id,job,values,{sourceReceipts:receipts});
  const search=query=>tools.execute(bot,'brain_search',{query});
  return {directory,store,bot,service,context,tools,prepare,search};
}
async function allText(folder) {
  let result='';for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())result+=await allText(file);else if(entry.isFile())result+=await fs.readFile(file,'utf8');}return result;
}

test('selected knowledge is durable, source-backed, recallable and independent of full originals',async t=>{
  const {service,prepare,bot,context,tools,directory,search}=await fixture(t);
  await tools.execute(bot,'brain_write',{path:'legacy',content:'Preserve existing unrelated gardening knowledge.'});
  const plan=await prepare();assert.equal(plan.actions.length,1);assert.equal((await search('canonical')).results.length,0);
  const result=await service.publish(plan);assert.equal(result.status,'completed');assert.equal(result.committedCount,1);
  const {units}=await service.list(bot.id);assert.equal(units.length,1);assert.equal(units[0].revision,1);
  const read=await service.read(bot.id,units[0].id);assert.match(read.content,/indexable preferred URL/);assert.match(read.content,/pageStart/);
  assert.equal((await search('canonical')).results[0].path,units[0].path);
  assert.equal((await tools.recall(bot,{query:'Audit canonical target eligibility and indexable preferred URLs.'})).notes[0].path,units[0].path);
  assert.equal((await search('gardening')).results[0].path,'legacy.md');
  assert.doesNotMatch(await allText(path.join(directory,'knowledge')),/full-source-must-not-persist/);
  assert.doesNotMatch(await allText(path.join(context.root,'brain')),/full-source-must-not-persist/);
  assert.equal(JSON.stringify(read.manifest).includes('source_1'),true);
});

test('source IDs and quotes are validated, methods preserve process and examples cannot invent observations',async t=>{
  const {prepare,service}=await fixture(t);
  await assert.rejects(prepare('unknown',[candidate({evidence:[{segmentId:'invented',quote:'text'}]})]),/unknown source segment/);
  await assert.rejects(prepare('bad_quote',[candidate({evidence:[{segmentId:'segment_1',quote:'The book claims everything doubles revenue.'}]})]),/does not match/);
  await assert.rejects(prepare('bad_method',[candidate({type:'method'})]),/ordered steps/);
  await assert.rejects(prepare('fake_outcome',[candidate({type:'example',outcome:'observed'})]),/cannot establish an outcome/);
  const plan=await prepare('method',[candidate({type:'method',method:{inputs:['Preferred URL and crawl data'],steps:['Check the preferred URL is indexable.','Review canonical hints.'],outputs:['Scoped findings'],checks:['Do not report indexing as verified without observation.']}})]);
  const result=await service.publish(plan);assert.equal(result.status,'completed');
  const content=result.actions[0].args.content;assert.match(content,/1\. Check the preferred URL/);assert.match(content,/source-derived and untested/);
});

test('publication is idempotent and identical reimports add no active duplicates',async t=>{
  const {service,prepare,bot}=await fixture(t);
  const plan=await prepare();const first=await service.publish(plan),again=await service.publish(plan);
  assert.equal(first.actions[0].noteSha256,again.actions[0].noteSha256);assert.equal((await prepare()).id,plan.id);
  const repeated=await prepare('another_job');assert.equal(repeated.actions.length,0);assert.equal(repeated.duplicates.length,1);
  assert.equal((await service.publish(repeated)).status,'completed');assert.equal((await service.list(bot.id)).units.length,1);
  const empty=await prepare('nothing_useful',[]);assert.equal((await service.publish(empty)).committedCount,0);
});

test('managed notes fail closed before manifest arrival, on tamper and on direct reads while legacy notes remain searchable',async t=>{
  const {service,prepare,context,bot,tools,search}=await fixture(t);
  const result=await service.publish(await prepare()),action=result.actions[0];
  const noteFile=path.join(context.root,'brain',action.args.path),manifestFile=noteFile.replace(/\.md$/,'.manifest.json'),manifest=await fs.readFile(manifestFile,'utf8'),original=await fs.readFile(noteFile,'utf8');
  assert.equal((await search('canonical')).results.length,1);
  await fs.unlink(manifestFile);assert.equal((await search('canonical')).results.length,0);
  await assert.rejects(tools.execute(bot,'brain_read',{path:action.args.path}),/not active/);
  await fs.writeFile(manifestFile,manifest);assert.equal((await search('canonical')).results.length,1);
  await fs.unlink(noteFile);assert.equal((await search('canonical')).results.length,0);
  await fs.writeFile(noteFile,original);assert.equal((await search('canonical')).results.length,1);
  await fs.writeFile(noteFile,original.replace('indexable preferred URL','hostile arbitrary URL'));assert.equal((await search('canonical')).results.length,0);
  await fs.writeFile(noteFile,original);assert.equal((await search('canonical')).results.length,1);
  await fs.writeFile(manifestFile,JSON.stringify({...JSON.parse(manifest),status:'superseded'}));assert.equal((await search('canonical')).results.length,0);
  await fs.writeFile(path.join(context.root,'brain',MANAGED_KNOWLEDGE_FOLDER,'legacy-guide.md'),'Legacy ordinary knowledge remains available.');
  assert.equal((await search('Legacy ordinary knowledge')).results[0].path,`${MANAGED_KNOWLEDGE_FOLDER}/legacy-guide.md`);
});

test('Strict requires the exact concrete publication digest and current Memory capability',async t=>{
  const {service,prepare,bot,search}=await fixture(t,'strict');const plan=await prepare();
  await assert.rejects(service.publish(plan,{approved:true}),/exact concrete publication/);
  await assert.rejects(service.publish(plan,{approvedDigest:'0'.repeat(64)}),/exact concrete publication/);
  assert.equal((await search('canonical')).results.length,0);
  assert.equal((await service.publish(plan,{approvedDigest:plan.approvalDigest})).status,'completed');
  bot.tools=['workspace'];const other=await prepare('other',[candidate({title:'A different useful rule'})]);
  await assert.rejects(service.publish(other,{approvedDigest:other.approvalDigest}),/Enable Memory/);
});

test('permission snapshots never expand and revocation between writes preserves partial outputs',async t=>{
  const {service,prepare,bot}=await fixture(t,'strict'),strict=await prepare();
  bot.approvalPolicy='balanced';await assert.rejects(service.publish(strict),/Strict publication needs approval/);
  await service.publish(strict,{approvedDigest:strict.approvalDigest});
  const plan=await prepare('two_new',[candidate({title:'New one'}),candidate({title:'New two'})]);let count=0;
  await assert.rejects(service.publish(plan,{guard:()=>{if(++count===2)bot.tools=['workspace'];}}),/Enable Memory/);
  assert.equal((await service.readPlan(plan.id)).committedCount,1);
});

test('nested metadata and evidence redact known credentials without retaining full sources',async t=>{
  const {service,store,bot,prepare,directory}=await fixture(t),secret='synthetic"private\\credential';
  await store.mutate(state=>{state.connections.push({id:'knowledge-fixture-key',type:'openai',name:'Synthetic',secret:store.seal(secret)});});
  const plan=await prepare('redaction',[candidate({scope:{project:secret,platforms:[secret]}})]);await service.publish(plan);
  const retained=await allText(path.join(directory,'knowledge'));assert.equal(retained.includes(JSON.stringify(secret).slice(1,-1)),false);
  assert.match((await service.list(bot.id)).units[0].unit.scope.project,/redacted/);
});

test('stale merge previews preserve external owner edits and hide changed managed notes',async t=>{
  const {service,prepare,bot,context}=await fixture(t);
  await service.publish(await prepare());const current=(await service.list(bot.id)).units[0];
  const next=await prepare('new_edition',[candidate({targetId:current.id,expectedSha256:current.sha256,content:'Use a different scoped recommendation with current evidence.'})]);
  const noteFile=path.join(context.root,'brain',current.path),original=await fs.readFile(noteFile,'utf8');await fs.writeFile(noteFile,`${original}\nOwner correction after preview.\n`);
  await assert.rejects(service.publish(next),/newer edits are preserved/);
  assert.match(await fs.readFile(noteFile,'utf8'),/Owner correction after preview/);assert.equal((await service.list(bot.id)).units.length,0);
});

test('batch rollback restores prior knowledge under a fresh revision and never deletes new-note bytes',async t=>{
  const {service,prepare,bot,context,search}=await fixture(t);
  const first=await service.publish(await prepare()),current=(await service.list(bot.id)).units[0];
  const update=await service.publish(await prepare('updated',[candidate({targetId:current.id,expectedSha256:current.sha256,content:'A newer scoped canonical rule, supported by the same illustrative excerpt.'})]));
  assert.equal((await service.read(bot.id,current.id)).revision,2);
  const rollback=await service.prepareRollback(bot.id,update.id);await service.publish(rollback);
  const restored=await service.read(bot.id,current.id);assert.equal(restored.revision,3);assert.equal(restored.unit.content,candidate().content);
  assert.ok((await fs.readdir(path.join(service.store.directory,'knowledge','revisions',bot.id,current.id))).length>=2);
  // A new batch can be reversed without deleting its workspace file.
  const separate=await service.publish(await prepare('separate',[candidate({title:'Distinct source lesson'})]));
  const noteFile=path.join(context.root,'brain',separate.actions[0].args.path);
  await service.rollback(bot.id,separate.id);assert.ok((await fs.stat(noteFile)).isFile());
  assert.equal((await search('Distinct source lesson')).results.some(item=>item.path===separate.actions[0].args.path),false);
  await assert.rejects(service.prepareRollback(bot.id,first.id),/Newer knowledge/);
});

test('Stop preserves exact committed units and the remaining publication can reconcile without replay',async t=>{
  const {service,prepare,bot}=await fixture(t),controller=new AbortController();
  const plan=await prepare('two_units',[candidate(),candidate({title:'Separate canonical lesson'})]);let turns=0;
  await assert.rejects(service.publish(plan,{signal:controller.signal,guard:()=>{if(++turns===2)controller.abort(new Error('Owner stopped learning.'));}}),/stopped learning/);
  const partial=await service.readPlan(plan.id);assert.equal(partial.status,'stopped');assert.equal(partial.committedCount,1);assert.equal((await service.list(bot.id)).units.length,1);
  const firstHash=partial.actions[0].noteSha256,recovered=await service.publish(plan);assert.equal(recovered.status,'completed');assert.equal(recovered.actions[0].noteSha256,firstHash);
});

test('a crash after a note write but before activation reconciles its exact operation without rewriting',async t=>{
  const {service,prepare,context,bot,search}=await fixture(t),plan=await prepare();
  const written=await brainWrite(context,plan.actions[0].args);
  assert.equal((await search('canonical')).results.length,0);
  const recovered=await service.publish(plan);assert.equal(recovered.actions[0].noteSha256,written.sha256);assert.equal((await service.list(bot.id)).units.length,1);
});

test('managed manifest guards cover case aliases but leave ordinary note edits alone',()=>{
  const id=`unit-${'a'.repeat(32)}`;
  assert.equal(protectedKnowledgeControlPath(`brain/tupies-managed-knowledge/${id}.manifest.json`),true);
  assert.equal(protectedKnowledgeControlPath(`BRAIN/TUPIES-MANAGED-KNOWLEDGE/${id.toUpperCase()}.MANIFEST.JSON`),true);
  assert.equal(protectedKnowledgeControlPath(`brain/tupies-managed-knowledge/${id}.md`),false);
  assert.equal(protectedKnowledgeControlPath('notes/manual.json'),false);
});

test('explicit relearning reactivates an untampered withdrawn unit as a guarded new revision',async t=>{
  const {service,prepare,bot,context}=await fixture(t,'strict'),plan=await prepare();await service.publish(plan,{approvedDigest:plan.approvalDigest});const rollback=await service.prepareRollback(bot.id,plan.id);await service.publish(rollback,{approvedDigest:rollback.approvalDigest});assert.equal((await service.list(bot.id)).total,0);
  const relearn=await prepare('explicit_relearn');assert.equal(relearn.actions.length,1);assert.equal(relearn.units[0].revision,3);await assert.rejects(service.publish(relearn),error=>error.status===403);await service.publish(relearn,{approvedDigest:relearn.approvalDigest});assert.equal((await service.list(bot.id)).total,1);assert.equal((await service.read(bot.id,relearn.units[0].id)).revision,3);
});

test('reconciliation read dependencies reject changed knowledge even for a zero-write duplicate plan',async t=>{
  const {service,prepare,bot}=await fixture(t),first=await prepare();await service.publish(first);const read=await service.read(bot.id,first.units[0].id),readSet=[{unitId:read.id,sha256:read.sha256,revision:read.revision}],empty=await service.prepare(bot.id,'duplicate_comparison',[],{readSet});
  const update=await service.prepare(bot.id,'owner_revision',[candidate({targetId:read.id,expectedSha256:read.sha256,content:'A newer owner-scoped statement.'})],{sourceReceipts:receipts});await service.publish(update);await assert.rejects(service.publish(empty),error=>error.status===409);assert.equal((await service.read(bot.id,read.id)).revision,2);
});
