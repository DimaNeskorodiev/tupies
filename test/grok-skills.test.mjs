import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { SkillsService, assertSkillIntegrity } from '../lib/skills.mjs';
import { bundledSkills, skillPackageManifest } from '../lib/skill-catalog.mjs';

const SOURCE='https://x.ai/bot/marketplace/bots/';
const REQUESTED=[
  ['dr-eggbot','dr-eggbot-v2','dr eggbot','Lauren Tan'],
  ['projects-manager','projects-manager','Projects Manager','Eric Zakariasson'],
  ['seo-aeo-desk','seo-aeo-desk','SEO & AEO Desk','Adam Tanguay'],
  ['figma-bro','figma-bro','figma bro','John Bai'],
  ['ai-search-visibility','ai-search-visibility','AI Search Visibility','Adam Tanguay'],
  ['researchy','researchy','Researchy','Farzad']
];
const ORIGINAL_DIGESTS={
  'tupies-research-brief':'68a094a9e7407422dd9ac248a7e56ad609be707209bc72e6b29af20e89514abb',
  'tupies-document-report':'c7761e4698f26bb7577c2228e8fd6c8a569f10cf91b35b23a8f601da64342afd',
  'tupies-spreadsheet-audit':'3057a97ea22c8203e4de7bc0cf2d536113418ad89570b76edc4fed4d46b48965',
  'tupies-meeting-actions':'9584ad24e795e42e5d4b5bb59fcf9425961236e65361c2c9c5f41ceca0e18485',
  'tupies-project-plan':'4328645d59a49e4020f4812ba859b79c0c3aae3e197da8a8080169f9c99196ad',
  'tupies-compare-options':'0b45f4b462776b6049b7fdcea8fbb3738d927e96a62b362bdde61132eccd5af0',
  'tupies-writing-editor':'b7df6dc82730bf21ec5eb791b4fecc2059fbd8e93b8423daabce0c9f1dfe0f93',
  'tupies-code-review':'d3bddbbdea2207e888d3b79c032e5fe28447d78667310ed152393b46442937f9',
  'tupies-knowledge-note':'aff27a65238959cea7cdbe798a2ea8de5fc9ec4389ad9329a95047cb8f937609',
  'tupies-daily-review':'bc89cd443a25541530e8389cd0573917498df0dc66d0eb00d22cee2fef5b9e89'
};
const selected=()=>bundledSkills().filter(entry=>entry.catalogId.startsWith('tupies-grok-'));
const text=entry=>entry.files.map(file=>file.data.toString('utf8')).join('\n');
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-grok-skills-')),store=await new Store(directory).init(),service=new SkillsService(store),tools=new AgentTools(store,{skills:service});
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  return {store,service,tools,botId:store.state.bots[0].id};
}

test('the six requested public bot adaptations have exact attribution and self-contained portable resources',()=>{
  const entries=selected();assert.equal(bundledSkills().length,18);assert.equal(entries.length,6);
  for(const [id,slug,title,author] of REQUESTED){
    const entry=entries.find(item=>item.catalogId===`tupies-grok-${id}`);assert.ok(entry,id);
    assert.deepEqual(entry.attribution,{title,author,url:SOURCE+slug,kind:'public-profile-adaptation',reviewedAt:'2026-10-29'});
    assert.equal(entry.author,'Tupies');assert.equal(entry.license,'MIT');
    assert.ok(entry.capabilityNotes.length>=2);assert.ok(entry.examples.length>=2);
    assert.ok(entry.files.some(file=>file.path==='SKILL.md'));
    const source=entry.files.find(file=>file.path.endsWith('/SOURCE.md')),runtime=entry.files.find(file=>file.path.endsWith('/TUPIES-RUNTIME.md'));
    assert.ok(source,`${id} source provenance`);assert.ok(runtime,`${id} runtime contract`);
    assert.match(source.data.toString('utf8'),new RegExp(slug));assert.ok(source.data.toString('utf8').includes(author));
    assert.ok(entry.files.length>=5,`${id} has usable templates in addition to instructions and provenance`);
    assert.ok(entry.files.every(file=>!/^scripts\//.test(file.path)),`${id} contains no automatically executable dependency`);
    assert.equal(skillPackageManifest(entry.files).digest,entry.digest);
    assert.match(text(entry),/public|profile|published/i);
  }
});

test('adding Grok adaptations preserves every existing playbook digest and installed identity',()=>{
  const entries=bundledSkills();
  for(const [id,digest] of Object.entries(ORIGINAL_DIGESTS))assert.equal(entries.find(entry=>entry.catalogId===id)?.digest,digest,id);
});

test('all six adaptations install and read their exact resources without creating tools, providers or routines',async t=>{
  const {store,service,tools,botId}=await fixture(t),before={tools:[...store.state.bots[0].tools],connections:structuredClone(store.state.connections),integrations:structuredClone(store.state.integrations),routines:structuredClone(store.state.routines)};
  for(const entry of selected()){
    const result=await service.install({catalogId:entry.catalogId,version:entry.version,digest:entry.digest,botId});
    assert.equal(result.compatibility.status,'ready',entry.catalogId);
    assert.deepEqual(result.skill.attribution,entry.attribution);
    assert.deepEqual(result.skill.capabilityNotes,entry.capabilityNotes);
    const verified=await assertSkillIntegrity(store,result.skill);assert.equal(verified.digest,entry.digest);
    for(const file of entry.files){
      assert.deepEqual(verified.files.get(file.path),file.data);
      const read=await tools.execute(store.state.bots[0],file.path==='SKILL.md'?'skills_read':'skills_file',{skillId:result.skill.id,...(file.path==='SKILL.md'?{}:{path:file.path})});
      assert.equal(read.content,file.data.toString('utf8'));assert.equal(read.packageDigest,entry.digest);
    }
  }
  assert.equal(store.state.bots[0].skills.length,6);assert.deepEqual(store.state.bots[1].skills,['tupies-product']);
  assert.deepEqual(store.state.bots[0].tools,before.tools);assert.deepEqual(store.state.connections,before.connections);assert.deepEqual(store.state.integrations,before.integrations);assert.deepEqual(store.state.routines,before.routines);
});

test('core requirements are enforced while optional external integrations do not prevent file-based use',async t=>{
  const {store,service,botId}=await fixture(t);
  await store.mutate(state=>{state.bots[0].tools=['skills'];});
  for(const entry of selected())assert.equal((await service.inspect({catalogId:entry.catalogId,botId})).compatibility.status,'needs_setup',entry.catalogId);
  await store.mutate(state=>{state.bots[0].tools=['skills','workspace','web','delegation'];});
  for(const entry of selected()){
    const inspected=await service.inspect({catalogId:entry.catalogId,botId});assert.equal(inspected.compatibility.status,'ready',entry.catalogId);
    assert.deepEqual(inspected.attribution,entry.attribution);assert.deepEqual(inspected.capabilityNotes,entry.capabilityNotes);
  }
  assert.deepEqual(store.state.integrations,[]);
});

test('adaptations use native execution and preserve evidence and approval boundaries',()=>{
  const entries=selected(),egg=entries.find(entry=>entry.name==='grok-dr-eggbot'),research=entries.find(entry=>entry.name==='grok-researchy'),visibility=entries.find(entry=>entry.name==='grok-ai-search-visibility'),figma=entries.find(entry=>entry.name==='grok-figma-bro');
  for(const entry of entries){
    assert.match(text(entry),/approval|approve|permission/i,entry.name);
    assert.match(text(entry),/documents_create|workspace_write/,entry.name);
    assert.match(text(entry),/timezone|time zone|schedule|routine/i,entry.name);
    assert.doesNotMatch(entry.content,/(?:^|\n)\s*(?:grok|pstack)\s+.*--(?:always-approve|create)/m);
  }
  assert.match(text(egg),/profile|bot.*design|design.*bot/i);assert.match(text(egg),/CreateAgent|pstack|automatic|health.?check/i);
  assert.match(text(research),/current|selected|configured/i);assert.match(text(research),/live|search/i);
  assert.match(text(visibility),/unavailable/i);assert.match(text(visibility),/partial/i);assert.match(text(visibility),/denominator/i);assert.match(text(visibility),/pasted/i);
  assert.match(text(figma),/export|paste/i);assert.match(text(figma),/image|vision|screenshot/i);
});
