import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, parseSkillPackage } from '../lib/store.mjs';
import { SkillsService, assertSkillIntegrity, skillCompatibility } from '../lib/skills.mjs';
import { bundledSkills, skillPackageManifest } from '../lib/skill-catalog.mjs';
import { NativeEngine } from '../lib/engine.mjs';

async function fixture(t,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-skills-'));
  const store=await new Store(directory).init(),service=new SkillsService(store,options);
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  return {store,service,directory,botId:store.state.bots[0].id};
}
const argsFor=(service,botId,index=0)=>{const entry=service.catalog[index];return {catalogId:entry.catalogId,version:entry.version,digest:entry.digest,botId};};
const external=(name,body='A reusable workflow.',provenance={kind:'upload',archiveSha256:'fixture'})=>({package:parseSkillPackage({content:`---\nname: ${name}\ndescription: An imported fixture.\n---\n\n${body}\n`}),provenance});

test('offline catalog provides useful packaged resources and deterministic exact identities',async t=>{
  const {service,botId}=await fixture(t),all=await service.search({botId});
  assert.equal(all.offline,true);assert.ok(all.skills.length>=8);assert.ok(all.categories.includes('Documents'));
  const brief=all.skills.find(skill=>skill.name==='research-brief');assert.equal(brief.compatibility.status,'ready');assert.equal(brief.assigned,false);
  const filtered=await service.search({query:'spreadsheet',category:'Documents',botId});assert.equal(filtered.skills.length,1);assert.equal(filtered.skills[0].name,'spreadsheet-audit');
  const inspected=await service.inspect({catalogId:brief.catalogId,botId});assert.ok(inspected.files.includes('references/claim-ledger.md'));assert.match(inspected.content,/claim ledger/);
  assert.equal(bundledSkills().find(skill=>skill.catalogId===brief.catalogId).digest,brief.digest);
});

test('owner install preserves exact bytes, assigns one bot and survives store reload',async t=>{
  const {store,service,botId}=await fixture(t),args=argsFor(service,botId),entry=service.catalog[0],result=await service.install(args);
  assert.ok(result.skill.immutable);assert.match(result.skill.id,/^tp-[a-z0-9-]+$/);assert.notEqual(result.skill.id,entry.name);
  assert.equal(result.skill.name,entry.name);assert.deepEqual(store.state.bots[0].skills,[result.skill.id]);assert.deepEqual(store.state.bots[1].skills,[]);
  const verified=await assertSkillIntegrity(store,result.skill);assert.equal(verified.verified,true);
  for(const file of entry.files)assert.deepEqual(verified.files.get(file.path),file.data);
  const reloaded=await new Store(store.directory).init();assert.equal(reloaded.state.skills.find(skill=>skill.id===result.skill.id).packageDigest,args.digest);
  assert.equal((await assertSkillIntegrity(reloaded,result.skill)).digest,args.digest);
});

test('exact version and digest are required; concurrent retries deduplicate the committed package',async t=>{
  const {store,service,botId}=await fixture(t),args=argsFor(service,botId);
  await assert.rejects(service.install({...args,version:'stale'}),/version changed/);
  await assert.rejects(service.install({...args,digest:'0'.repeat(64)}),/package changed/);
  const results=await Promise.all([service.install(args),service.install(args)]);
  assert.equal(results[0].skill.id,results[1].skill.id);assert.equal(store.state.skills.filter(skill=>skill.catalogId===args.catalogId).length,1);assert.equal(store.state.bots[0].skills.length,1);
});

test('bot auto-install requires both snapshot and live trusted policy and exact bundled bytes',async t=>{
  const {store,service,botId}=await fixture(t),args=argsFor(service,botId);
  assert.equal(service.canAutoInstall(store.state.bots[0],args),false);
  await store.mutate(state=>{state.bots[0].skillInstallPolicy='trusted';state.bots[0].approvalPolicy='balanced';});
  const snapshot=structuredClone(store.state.bots[0]);assert.equal(service.canAutoInstall(snapshot,args),true);
  assert.equal(service.canAutoInstall(snapshot,{...args,digest:'1'.repeat(64)}),false);
  await store.mutate(state=>{state.bots[0].skillInstallPolicy='ask';});assert.equal(service.canAutoInstall(snapshot,args),false);
  await store.mutate(state=>{state.bots[0].skillInstallPolicy='trusted';state.bots[0].approvalPolicy='strict';});assert.equal(service.canAutoInstall(snapshot,args),false);
});

test('bot installs are task-owned, exact-approved or trusted, and do not change tool permissions',async t=>{
  const {store,service,botId}=await fixture(t),args=argsFor(service,botId);
  await store.mutate(state=>{state.runs[botId]={id:'run-current',status:'running'};});
  const tools=[...store.state.bots[0].tools];
  await assert.rejects(service.install(args,{actor:'bot',runId:'old',approved:true}),/older or stopped/);
  await assert.rejects(service.install(args,{actor:'bot',runId:'run-current'}),/exact approval/);
  const result=await service.install(args,{actor:'bot',runId:'run-current',approved:true});assert.equal(result.assignedTo,botId);assert.deepEqual(store.state.bots[0].tools,tools);
  assert.equal(store.state.runs[botId].skillInstallCount,1);
  await assert.rejects(service.installPrepared(external('external'),{actor:'bot',botId,runId:'run-current',approved:true}),/only an exact inspected catalog/);
});

test('one autonomous task can assign at most three new catalog skills',async t=>{
  const {store,service,botId}=await fixture(t);
  await store.mutate(state=>{state.bots[0].skillInstallPolicy='trusted';state.runs[botId]={id:'run-bounded',status:'running'};});
  for(let index=0;index<3;index++)await service.install(argsFor(service,botId,index),{actor:'bot',runId:'run-bounded'});
  await assert.rejects(service.install(argsFor(service,botId,3),{actor:'bot',runId:'run-bounded'}),/limit of three/);
  const repeated=await service.install(argsFor(service,botId,0),{actor:'bot',runId:'run-bounded'});assert.equal(repeated.alreadyAssigned,true);assert.equal(store.state.runs[botId].skillInstallCount,3);
});

test('owner installs refuse active, reserved and remote bot work, including future active states',async t=>{
  let reserved=false,remote=false;
  const {store,service,botId}=await fixture(t,{isBusy:()=>reserved,busyElsewhere:()=>remote}),args=argsFor(service,botId);
  reserved=true;await assert.rejects(service.install(args),/working/);reserved=false;
  remote=true;await assert.rejects(service.install(args),/another Engine/);remote=false;
  await store.mutate(state=>{state.runs[botId]={id:'run',status:'future-active-state'};});await assert.rejects(service.install(args),/working/);
  await store.mutate(state=>{state.runs[botId].status='completed';});assert.ok((await service.install(args)).skill);
});

test('failed state commit removes a new package and rolls back its assignment',async t=>{
  const {store,service,botId,directory}=await fixture(t),args=argsFor(service,botId),save=store.save;
  store.save=async()=>{throw new Error('fixture disk failure');};
  try{await assert.rejects(service.install(args),/disk failure/);}finally{store.save=save;}
  assert.equal(store.state.skills.some(skill=>skill.catalogId===args.catalogId),false);assert.deepEqual(store.state.bots[0].skills,[]);
  assert.equal((await fs.readdir(path.join(directory,'skills'))).some(name=>name.startsWith('tp-') || name.startsWith('.import-')),false);
});

test('cancellation before commit leaves no new files or assignment',async t=>{
  const controller=new AbortController();let admissions=0;
  const {store,service,botId,directory}=await fixture(t,{assertAdmission:()=>{if(++admissions===3)controller.abort(new Error('fixture stopped'));}}),args=argsFor(service,botId);
  await assert.rejects(service.install(args,{signal:controller.signal}),/fixture stopped/);
  assert.equal(store.state.skills.some(skill=>skill.catalogId===args.catalogId),false);assert.deepEqual(store.state.bots[0].skills,[]);
  assert.equal((await fs.readdir(path.join(directory,'skills'))).some(name=>name.startsWith('tp-') || name.startsWith('.import-')),false);
});

test('a missing or changed synced resource prevents reads and assignment until the entire package verifies',async t=>{
  const {store,service,botId,directory}=await fixture(t),result=await service.install(argsFor(service,botId)),skill=result.skill;
  const resource=service.catalog[0].files[1],location=path.join(directory,'skills',skill.id,resource.path);
  await fs.rm(location);await assert.rejects(assertSkillIntegrity(store,skill),/not available/);
  await assert.rejects(service.assign({skillId:skill.id,botId:store.state.bots[1].id}),/not available/);
  const listed=await service.installed({botId});assert.equal(listed.skills.find(item=>item.id===skill.id).available,false);
  await fs.writeFile(location,resource.data);const verified=await assertSkillIntegrity(store,skill);
  await fs.writeFile(location,'changed');assert.deepEqual(verified.files.get(resource.path),resource.data);
  await assert.rejects(assertSkillIntegrity(store,skill),/incomplete or changed/);
});

test('immutable package integrity refuses symlinked resources and storage roots',async t=>{
  const {store,service,botId,directory}=await fixture(t),result=await service.install(argsFor(service,botId)),skill=result.skill;
  const resource=service.catalog[0].files[1],location=path.join(directory,'skills',skill.id,resource.path),outside=path.join(directory,'fixture-outside.txt');
  await fs.writeFile(outside,resource.data);await fs.rm(location);await fs.symlink(outside,location);
  await assert.rejects(assertSkillIntegrity(store,skill),/not available/);
  await fs.rm(location);await fs.writeFile(location,resource.data);
  await fs.rename(path.join(directory,'skills'),path.join(directory,'original-skills'));await fs.symlink(path.join(directory,'original-skills'),path.join(directory,'skills'));
  await assert.rejects(assertSkillIntegrity(store,skill),/real directory/);
});

test('same-named packages and identical bytes from different sources retain independent identities',async t=>{
  const {store,service,botId}=await fixture(t),first=external('shared-name','First source',{kind:'url',url:'https://one.example/SKILL.md'}),second=external('shared-name','Second source',{kind:'url',url:'https://two.example/SKILL.md'});
  const a=await service.installPrepared(first,{botId}),b=await service.installPrepared(second,{botId});assert.notEqual(a.skill.id,b.skill.id);assert.equal(a.skill.name,b.skill.name);
  const entry=service.catalog[0],imported=await service.installPrepared({package:{files:entry.files},provenance:{kind:'upload'}},{botId}),catalog=await service.install(argsFor(service,botId));
  assert.notEqual(imported.skill.id,catalog.skill.id);assert.equal(imported.skill.packageDigest,catalog.skill.packageDigest);
  assert.equal(store.state.bots[0].skills.length,4);
});

test('catalog updates replace only the selected bot assignment and retain rollback versions',async t=>{
  const {store,service,botId}=await fixture(t),old=await service.install(argsFor(service,botId)),other=store.state.bots[1].id;
  await service.assign({skillId:old.skill.id,botId:other});
  const entry=service.catalog[0];entry.version='1.1.0';entry.content+='\nA revised checklist.\n';entry.files[0].data=Buffer.from(entry.content);Object.assign(entry,skillPackageManifest(entry.files));
  const updated=await service.install(argsFor(service,botId));assert.notEqual(updated.skill.id,old.skill.id);assert.deepEqual(updated.replacedSkillIds,[old.skill.id]);
  assert.deepEqual(store.state.bots[0].skills,[updated.skill.id]);assert.deepEqual(store.state.bots[1].skills,[old.skill.id]);
  const library=await service.installed({botId});assert.ok(library.skills.some(skill=>skill.id===old.skill.id && !skill.assigned));
  await service.assign({skillId:old.skill.id,botId});assert.deepEqual(store.state.bots[0].skills,[old.skill.id]);assert.ok(store.state.skills.some(skill=>skill.id===updated.skill.id));
});

test('imports preserve compatibility restrictions and diagnose foreign runtimes without executing anything',async t=>{
  const {store,service,botId}=await fixture(t),prepared=external('hermes-dependent','Use ${HERMES_HOME} and run hermes setup.');
  prepared.metadata={diagnostics:['Supporting files were not included.'],requiresConfig:['google-workspace'],requiresEnv:['REQUIRED_FIXTURE_KEY']};
  const preview=service.inspectPrepared(prepared,{botId});assert.equal(preview.compatibility.status,'unsupported');assert.ok(preview.compatibility.reasons.some(reason=>reason.includes('Supporting files')));assert.ok(preview.compatibility.reasons.some(reason=>reason.includes('google-workspace')));
  const result=await service.installPrepared(prepared,{botId});assert.equal(result.compatibility.status,'unsupported');assert.equal(result.skill.trustedCatalog,undefined);
  const osOnly=skillCompatibility(store,{compatibilityMetadata:{platforms:['windows']}},store.state.bots[0],{platform:'linux'});assert.equal(osOnly.status,'unsupported');
});

test('portable Grok display names are preserved while storage identity remains a safe separate slug',async t=>{
  const {store,service,botId}=await fixture(t),content='---\nname: "Weekly Account Review — Team A"\ndescription: A portable Grok skill.\n---\n\nReview the available sources.\n';
  const prepared={package:{files:[{path:'SKILL.md',data:Buffer.from(content)}]},provenance:{kind:'upload',format:'openbot-agent-import',sourceApp:'grok-bot'}};
  const result=await service.installPrepared(prepared,{botId});assert.equal(result.skill.name,'Weekly Account Review — Team A');assert.match(result.skill.id,/^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.equal((await assertSkillIntegrity(store,result.skill)).files.get('SKILL.md').toString(),content);
});

test('legacy library entries inspect current metadata instead of falsely reporting foreign requirements ready',async t=>{
  const {store,service,botId,directory}=await fixture(t),root=path.join(directory,'skills','legacy-hermes');await fs.mkdir(root);
  await fs.writeFile(path.join(root,'SKILL.md'),'---\nname: legacy-hermes\ndescription: A legacy fixture.\n---\nUse ${HERMES_HOME} and hermes setup.\n');
  await store.mutate(state=>{state.skills.push({id:'legacy-hermes',name:'legacy-hermes',description:'A legacy fixture.',files:['SKILL.md']});});
  const entry=(await service.installed({botId})).skills.find(skill=>skill.id==='legacy-hermes');assert.equal(entry.compatibility.status,'unsupported');assert.equal(entry.available,true);
  await fs.rm(path.join(root,'SKILL.md'));assert.equal((await service.installed({botId})).skills.find(skill=>skill.id==='legacy-hermes').available,false);
});

test('an explicit install denial remains denied if a replicated standing grant changes while approval is open',async t=>{
  const {store,service,botId}=await fixture(t),args=argsFor(service,botId);let requests=0;
  await store.mutate(state=>{state.connections.push({id:'provider_fixture',type:'openai',model:'fixture'});Object.assign(state.bots[0],{connectionId:'provider_fixture',skillInstallPolicy:'trusted',approvalPolicy:'balanced'});});
  const engine=new NativeEngine(store,{skills:service,providers:{async complete(){
    if(++requests===1){await store.mutate(state=>{state.bots[0].skillInstallPolicy='ask';});const {botId:unused,...arguments_}=args;return {text:'',toolCalls:[{id:'install-fixture',name:'skills_install',arguments:arguments_}]};}
    return {text:'The installation decision was received.',toolCalls:[]};
  }}});
  const waitFor=async predicate=>{const deadline=Date.now()+6000;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Approval fixture timed out.');};
  try {
    await engine.recover();await engine.start(botId,'Find a useful skill.');await waitFor(()=>store.state.runs[botId]?.status==='waiting_for_approval');
    const run=structuredClone(store.state.runs[botId]);await store.mutate(state=>{state.bots[0].skillInstallPolicy='trusted';});
    await engine.control(botId,'approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation,choice:'deny'});
    await waitFor(()=>store.state.runs[botId]?.status==='completed');
    assert.equal(store.state.skills.some(skill=>skill.catalogId===args.catalogId),false);assert.deepEqual(store.state.bots[0].skills,[]);
  } finally {await engine.close();}
});
