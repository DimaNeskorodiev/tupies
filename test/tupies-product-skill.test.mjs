import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { SkillsService, assertSkillIntegrity } from '../lib/skills.mjs';
import { bundledSkills, skillPackageManifest } from '../lib/skill-catalog.mjs';
import { prepareSkillImport } from '../lib/skill-import.mjs';

const ORIGINAL_PACKAGES=[
  ['tupies-research-brief','68a094a9e7407422dd9ac248a7e56ad609be707209bc72e6b29af20e89514abb'],
  ['tupies-document-report','c7761e4698f26bb7577c2228e8fd6c8a569f10cf91b35b23a8f601da64342afd'],
  ['tupies-spreadsheet-audit','3057a97ea22c8203e4de7bc0cf2d536113418ad89570b76edc4fed4d46b48965'],
  ['tupies-meeting-actions','9584ad24e795e42e5d4b5bb59fcf9425961236e65361c2c9c5f41ceca0e18485'],
  ['tupies-project-plan','4328645d59a49e4020f4812ba859b79c0c3aae3e197da8a8080169f9c99196ad'],
  ['tupies-compare-options','0b45f4b462776b6049b7fdcea8fbb3738d927e96a62b362bdde61132eccd5af0'],
  ['tupies-writing-editor','b7df6dc82730bf21ec5eb791b4fecc2059fbd8e93b8423daabce0c9f1dfe0f93'],
  ['tupies-code-review','d3bddbbdea2207e888d3b79c032e5fe28447d78667310ed152393b46442937f9'],
  ['tupies-knowledge-note','aff27a65238959cea7cdbe798a2ea8de5fc9ec4389ad9329a95047cb8f937609'],
  ['tupies-daily-review','bc89cd443a25541530e8389cd0573917498df0dc66d0eb00d22cee2fef5b9e89'],
  ['tupies-grok-dr-eggbot','638b623c7669a94a34028dcb5af2e9946ba5f9bb938865c8c6e46212152f2319'],
  ['tupies-grok-projects-manager','126b82dab9bc0637dce79f432cf7b8232b6126e2cd066340b9a9a2a62d4230af'],
  ['tupies-grok-seo-aeo-desk','e02c2ed921405c57338abf5c0e5a2eb65614f72a78828922d0aabd70c984f5b4'],
  ['tupies-grok-figma-bro','8e1ada0ed794e66bc62588250d2805d6e4fa24b1aa3b656444e450d846cf17fb'],
  ['tupies-grok-ai-search-visibility','1a870e1e0363342f5f72ab78b97db60af317af4cd15330ab6d4971b1344fcae3'],
  ['tupies-grok-researchy','e99aab862eb30c5e2dd8fd3ff5dc73608448be89527e5856bb5d422d00029f23'],
];
const packageEntry=()=>bundledSkills().find(entry=>entry.catalogId==='tupies-product');
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-product-skill-'));
  const store=await new Store(directory).init(),service=new SkillsService(store),tools=new AgentTools(store,{skills:service});
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  return {store,service,tools,botId:store.state.bots[0].id};
}

test('the product guide appends a portable package without changing existing catalog identities',()=>{
  const entries=bundledSkills(),entry=packageEntry();
  assert.deepEqual(entries.slice(0,16).map(({catalogId,digest})=>[catalogId,digest]),ORIGINAL_PACKAGES);
  assert.equal(entries.at(-1).catalogId,'tupies-product');
  assert.deepEqual(entry.files.map(file=>file.path),['SKILL.md','references/product-workflows.md','references/troubleshooting.md','references/operator-recovery.md']);
  assert.equal(entry.digest,skillPackageManifest(entry.files).digest);
  const digest=entry.digest;entry.files[0].data.fill(0);
  assert.equal(skillPackageManifest(packageEntry().files).digest,digest);
});

test('bots can discover the product guide in either language without extra tool requirements or assignment',async t=>{
  const {store,service,botId}=await fixture(t);
  await store.mutate(state=>{state.bots[0].tools=['skills'];});
  for(const query of ['Tupies','користуватися','рутина','provider']) {
    const search=await service.search({query,botId});
    assert.equal(search.offline,true);assert.ok(search.skills.some(entry=>entry.catalogId==='tupies-product'),query);
  }
  const inspected=await service.inspect({catalogId:'tupies-product',botId});
  assert.equal(inspected.compatibility.status,'ready');
  assert.deepEqual(store.state.bots[0].tools,['skills']);
  assert.equal(store.state.skills.some(entry=>entry.catalogId==='tupies-product'),false);
  assert.ok(store.state.bots.every(bot=>bot.skills.length===0));
});

test('exact installation makes every guide resource readable without changing tools or services',async t=>{
  const {store,service,tools,botId}=await fixture(t),entry=packageEntry();
  const before=structuredClone({tools:store.state.bots.map(bot=>bot.tools),connections:store.state.connections,integrations:store.state.integrations,routines:store.state.routines});
  const {skill}=await service.install({catalogId:entry.catalogId,version:entry.version,digest:entry.digest,botId});
  const verified=await assertSkillIntegrity(store,skill);
  for(const file of entry.files) {
    assert.deepEqual(verified.files.get(file.path),file.data);
    const read=await tools.execute(store.state.bots[0],file.path==='SKILL.md'?'skills_read':'skills_file',{skillId:skill.id,...(file.path==='SKILL.md'?{}:{path:file.path})});
    assert.equal(read.content,file.data.toString('utf8'));assert.equal(read.packageDigest,entry.digest);
  }
  assert.deepEqual(store.state.bots[0].skills,[skill.id]);assert.deepEqual(store.state.bots[1].skills,[]);
  assert.deepEqual({tools:store.state.bots.map(bot=>bot.tools),connections:store.state.connections,integrations:store.state.integrations,routines:store.state.routines},before);
});

test('portable export bytes reinstall through the normal inspected import pipeline',async t=>{
  const {store,service,botId}=await fixture(t),entry=packageEntry();
  const installed=await service.install({catalogId:entry.catalogId,version:entry.version,digest:entry.digest,botId});
  const verified=await assertSkillIntegrity(store,installed.skill);
  const exported={files:[...verified.files].map(([path,data])=>({path,contentBase64:data.toString('base64')}))};
  const preview=await prepareSkillImport(exported);
  assert.equal(preview.packages.length,1);
  const targetBot=store.state.bots[1].id,imported=await service.installPrepared(preview.packages[0],{botId:targetBot});
  assert.notEqual(imported.skill.id,installed.skill.id);
  assert.equal(imported.skill.packageDigest,entry.digest);
  assert.equal(imported.compatibility.status,'ready');
  assert.deepEqual(store.state.bots[1].skills,[imported.skill.id]);
  const roundtrip=await assertSkillIntegrity(store,imported.skill);
  for(const file of entry.files)assert.deepEqual(roundtrip.files.get(file.path),file.data);
});
