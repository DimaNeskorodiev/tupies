import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { SkillsService, assertSkillIntegrity, skillCompatibility } from '../lib/skills.mjs';
import { bundledSkills, skillPackageManifest } from '../lib/skill-catalog.mjs';
import { parseSkillMetadata, prepareSkillImport } from '../lib/skill-import.mjs';
import { proposeSkill } from '../lib/learning.mjs';

const catalogId='tupies-learn-from-material';
const entryFor=()=>bundledSkills().find(entry=>entry.catalogId===catalogId);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const argsFor=(entry,botId)=>({catalogId:entry.catalogId,version:entry.version,digest:entry.digest,botId});
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-learning-skill-'));
  const store=await new Store(directory).init(),service=new SkillsService(store),tools=new AgentTools(store,{skills:service});
  await store.mutate(state=>{state.bots[0].tools=['workspace','memory','skills'];});
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  return {store,service,tools,directory,botId:store.state.bots[0].id};
}

test('the learning package appends exact portable resources while retaining the previous product revision',async()=>{
  const entries=bundledSkills(),entry=entryFor();
  assert.equal(entries.length,18);assert.equal(entries.at(-1).catalogId,catalogId);
  assert.equal(entries[16].catalogId,'tupies-product');
  assert.equal(entries[16].digest,'53ee538e1b01742f0f6005273e787d8681ca5f88a9cfd4b0eba02849588c97a3');
  assert.deepEqual(entry.files.map(file=>file.path),['SKILL.md','references/learning-rules.md','references/documents.md','references/video.md','references/knowledge-template.md','references/apply-and-correct.md']);
  assert.deepEqual(parseSkillMetadata(entry.content).requiresToolsets,['workspace','memory']);
  assert.equal(entry.digest,skillPackageManifest(entry.files).digest);
  for(const file of entry.files) {
    assert.deepEqual(file.data,await fs.readFile(new URL(`../lib/skills/tupies-learning/${file.path}`,import.meta.url)));
    for(const match of file.data.toString('utf8').matchAll(/\]\((references\/[^)]+\.md)\)/g))assert.ok(entry.files.some(resource=>resource.path===match[1]),`Missing ${match[1]}`);
  }
  const digest=entry.digest;entry.files[0].data.fill(0);
  assert.equal(skillPackageManifest(entryFor().files).digest,digest);
});

test('learning discovery and readiness use the bot capabilities without requiring Terminal or installing anything',async t=>{
  const {store,service,tools,botId}=await fixture(t),before=structuredClone(store.state.bots[0]),skillsBefore=structuredClone(store.state.skills);
  for(const query of ['learn','Вивчи','Навчися','відео']) {
    const found=await tools.execute(store.state.bots[0],'skills_search',{query});
    assert.ok(found.skills.some(entry=>entry.catalogId===catalogId),query);
  }
  const inspected=await tools.execute(store.state.bots[0],'skills_inspect',{catalogId});
  assert.equal(inspected.compatibility.status,'ready');
  assert.deepEqual(store.state.bots[0],before);assert.deepEqual(store.state.skills,skillsBefore);
  assert.equal(tools.definitions(store.state.bots[0]).some(tool=>tool.name==='scripts_run'),false);
  await store.mutate(state=>{state.bots[0].tools=['skills','workspace'];});
  const missingMemory=await service.inspect({catalogId,botId});
  assert.equal(missingMemory.compatibility.status,'needs_setup');
  assert.deepEqual(missingMemory.compatibility.reasons,['Enable the memory tools for this bot.']);
});

test('exact learning installation preserves resources, provenance and bot scope across reload',async t=>{
  const {store,service,tools,directory,botId}=await fixture(t),entry=entryFor(),args=argsFor(entry,botId);
  const before=structuredClone({tools:store.state.bots.map(bot=>bot.tools),connections:store.state.connections,integrations:store.state.integrations,routines:store.state.routines});
  await assert.rejects(service.install({...args,digest:'0'.repeat(64)}),/package changed/);
  await assert.rejects(service.install({...args,version:'obsolete'}),/version changed/);
  const {skill}=await service.install(args),verified=await assertSkillIntegrity(store,skill);
  assert.equal(skill.immutable,true);assert.equal(skill.catalogVersion,'1.0.0');
  assert.deepEqual(skill.provenance,{source:'tupies',catalogId,version:entry.version,digest:entry.digest});
  assert.deepEqual(store.state.bots[0].skills,[skill.id]);assert.deepEqual(store.state.bots[1].skills,['tupies-product']);
  for(const file of entry.files) {
    assert.deepEqual(verified.files.get(file.path),file.data);
    const result=await tools.execute(store.state.bots[0],file.path==='SKILL.md'?'skills_read':'skills_file',{skillId:skill.id,...(file.path==='SKILL.md'?{}:{path:file.path})});
    assert.equal(result.content,file.data.toString('utf8'));assert.equal(result.sha256,sha256(file.data));assert.equal(result.packageDigest,entry.digest);
  }
  assert.deepEqual({tools:store.state.bots.map(bot=>bot.tools),connections:store.state.connections,integrations:store.state.integrations,routines:store.state.routines},before);
  const reloaded=await new Store(directory).init(),saved=reloaded.state.skills.find(item=>item.id===skill.id);
  assert.equal((await assertSkillIntegrity(reloaded,saved)).digest,entry.digest);
  assert.deepEqual(saved.provenance,skill.provenance);
  await assert.rejects(tools.execute(store.state.bots[1],'skills_file',{skillId:skill.id,path:'references/learning-rules.md'}),/not assigned/);
});

test('missing or changed learning references fail closed for reads and new assignments',async t=>{
  const {store,service,tools,directory,botId}=await fixture(t),entry=entryFor();
  const {skill}=await service.install(argsFor(entry,botId)),file=entry.files.find(file=>file.path==='references/video.md'),location=path.join(directory,'skills',skill.id,file.path);
  await fs.rm(location);
  await assert.rejects(tools.execute(store.state.bots[0],'skills_read',{skillId:skill.id}),/not available/);
  await assert.rejects(service.assign({skillId:skill.id,botId:store.state.bots[1].id}),/not available/);
  await fs.writeFile(location,file.data);assert.equal((await assertSkillIntegrity(store,skill)).verified,true);
  await fs.writeFile(location,'A changed resource');
  await assert.rejects(tools.execute(store.state.bots[0],'skills_file',{skillId:skill.id,path:'references/learning-rules.md'}),/incomplete or changed/);
});

test('a portable learning package retains its requirements and bytes without acquiring catalog trust',async t=>{
  const {store,service,botId}=await fixture(t),entry=entryFor();
  const exported={files:entry.files.map(file=>({path:file.path,contentBase64:file.data.toString('base64')}))};
  const preview=await prepareSkillImport(exported);assert.equal(preview.packages.length,1);
  const installed=await service.installPrepared(preview.packages[0],{botId});
  assert.equal(installed.skill.trustedCatalog,undefined);assert.equal(installed.skill.source,'imported');
  assert.equal(installed.skill.packageDigest,entry.digest);assert.equal(installed.compatibility.status,'ready');
  assert.deepEqual(installed.skill.compatibilityMetadata.requiresToolsets,['workspace','memory']);
  const verified=await assertSkillIntegrity(store,installed.skill);
  for(const file of entry.files)assert.deepEqual(verified.files.get(file.path),file.data);
  assert.deepEqual(store.state.bots[0].tools,['workspace','memory','skills']);
});

test('current workspace and script requirements map to actual tool groups rather than foreign tools',async t=>{
  const {store,tools}=await fixture(t),bot=store.state.bots[0];
  const readAndRegistration=['workspace_structure','workspace_initialize','scripts_list','scripts_inspect','scripts_register'];
  for(const name of readAndRegistration)assert.ok(tools.definitions(bot).some(tool=>tool.name===name),name);
  const required={compatibilityMetadata:{requiresTools:readAndRegistration}};
  assert.equal(skillCompatibility(store,required,bot).status,'ready');
  const runner={compatibilityMetadata:{requiresToolsets:['workspace'],requiresTools:['scripts_run']}};
  assert.deepEqual(skillCompatibility(store,runner,bot).reasons,['Enable the terminal tools required by scripts_run.']);
  const executable={...bot,tools:[...bot.tools,'terminal']};
  assert.ok(tools.definitions(executable).some(tool=>tool.name==='scripts_run'));
  assert.equal(skillCompatibility(store,runner,executable).status,'ready');
  assert.equal(tools.requiresApproval('scripts_register',bot),true);
  assert.equal(tools.requiresApproval('scripts_run',executable),true);
});

test('learning cannot rewrite its immutable foundation through a mutable Skill proposal',async t=>{
  const {store,service,tools,botId}=await fixture(t),entry=entryFor(),{skill}=await service.install(argsFor(entry,botId));
  const read=await tools.execute(store.state.bots[0],'skills_read',{skillId:skill.id});
  await assert.rejects(proposeSkill(store,{bot:structuredClone(store.state.bots[0]),runId:'fixture-learning'},{skillId:skill.id,expectedSha256:read.sha256,content:read.content+'\nA source-derived replacement.\n',reason:'A supplied document suggests another workflow.'}),/immutable/);
  assert.equal((store.state.proposals || []).length,0);
  assert.equal((await assertSkillIntegrity(store,skill)).digest,entry.digest);
});
