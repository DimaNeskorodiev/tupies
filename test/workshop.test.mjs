import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { AgentTools,writeWorkspace } from '../lib/agent-tools.mjs';
import { sandboxTransform } from '../lib/workshop-sandbox.mjs';
import { listWorkshopTools,inspectWorkshopTool,listImprovements,readImprovement,exportImprovement,workshopDigest } from '../lib/workshop.mjs';
const definition={id:'add-fixture',title:'Add fixture',description:'Adds one to a synthetic number.',source:'x=>x+1',tests:[{input:1,expected:2},{input:-1,expected:0}]};
async function fixture(t){const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-workshop-'));const store=await new Store(directory).init();const bot=store.state.bots[0];Object.assign(bot,{tools:['workspace','workshop'],approvalPolicy:'balanced'});const tools=new AgentTools(store);t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});return {directory,store,bot,tools};}
test('QuickJS computes JSON without Node, network, native imports or host constructor escape',async()=>{
  const result=await sandboxTransform(`()=>({process:typeof process,require:typeof require,fetch:typeof fetch,wasm:typeof WebAssembly,buffer:typeof Buffer,escape:({}).constructor.constructor('return typeof process')()})`,null);
  assert.deepEqual(result,{process:'undefined',require:'undefined',fetch:'undefined',wasm:'undefined',buffer:'undefined',escape:'undefined'});
  await assert.rejects(sandboxTransform(`()=>import('node:fs')`,null),/failed|Promise/);
});
test('guest input injection remains data and prototypes cannot cross the serialization boundary',async()=>{
  const value='\"); process.exit(); //';assert.equal(await sandboxTransform('x=>x',value),value);
  const result=await sandboxTransform(`()=>JSON.parse('{"__proto__":{"polluted":true}}')`,null);
  assert.equal(Object.prototype.polluted,undefined);assert.equal(Object.hasOwn(result,'__proto__'),true);
});
test('infinite loops, hostile getters, huge outputs and memory exhaustion are bounded',async()=>{
  for(const source of ['()=>{while(true){}}','()=>({get x(){while(true){}}})','()=>"x".repeat(70000)','()=>{const x=[];while(true)x.push("x".repeat(100000));}'])await assert.rejects(sandboxTransform(source,null,{timeoutMs:30}),/failed|limit|exceeds/);
  await assert.rejects(sandboxTransform('x=>x','x'.repeat(70000)),/limit/);
  await assert.rejects(sandboxTransform('()=>undefined',null),/failed/);
});
test('Stop terminates the worker before returning and leaves capacity available',async()=>{
  const controller=new AbortController();const promise=sandboxTransform('()=>{while(true){}}',null,{signal:controller.signal});setTimeout(()=>controller.abort(new Error('Fixture stopped')),30);
  await assert.rejects(promise,/Fixture stopped/);assert.equal(await sandboxTransform('x=>x',42),42);
  const stopped=new AbortController();stopped.abort(new Error('Already stopped'));await assert.rejects(sandboxTransform('x=>x',0,{signal:stopped.signal}),/Already stopped/);
});
test('packages are immutable, test failures do not register, and exact source identities are checked',async t=>{
  const f=await fixture(t);await assert.rejects(f.tools.execute(f.bot,'workshop_build',{...definition,tests:[{input:1,expected:9}]}),/test 1 failed/);
  assert.equal((await listWorkshopTools(f.store,f.bot.id)).tools.length,0);
  const built=await f.tools.execute(f.bot,'workshop_build',definition);assert.equal(built.verification.passed,true);
  const output=await f.tools.execute(f.bot,'workshop_run',{digest:built.digest,input:8});assert.equal(output.output,9);
  const rebuilt=await f.tools.execute(f.bot,'workshop_build',definition);assert.equal(rebuilt.digest,built.digest);assert.equal((await listWorkshopTools(f.store,f.bot.id)).tools.length,1);
  const record=await inspectWorkshopTool(f.store,f.bot.id,built.digest);record.package.source='()=>99';await fs.writeFile(path.join(f.directory,'workshop',f.bot.id,'packages',`${built.digest}.json`),JSON.stringify(record));
  await assert.rejects(f.tools.execute(f.bot,'workshop_run',{digest:built.digest,input:0}),/revision changed/);
  await assert.rejects(f.tools.execute(f.bot,'workshop_build',definition),/damaged/);
});
test('workshop is owner opt-in, keeps Strict writes approved, and revocation beats a run snapshot',async t=>{
  const f=await fixture(t);assert.equal(f.tools.definitions({...f.bot,tools:['workspace']}).some(x=>x.name.startsWith('workshop_')),false);
  const strict={...f.bot,approvalPolicy:'strict'};await assert.rejects(f.tools.execute(strict,'workshop_build',definition),/approval/);
  const built=await f.tools.execute(strict,'workshop_build',definition,{approved:true});assert.equal((await f.tools.execute(strict,'workshop_run',{digest:built.digest,input:1})).output,2);
  await assert.rejects(f.tools.execute(strict,'improvement_propose',{kind:'tool',title:'Add',summary:'Reusable addition',toolDigest:built.digest}),/approval/);
  const snapshot=structuredClone(f.bot);f.bot.tools=['workspace'];await assert.rejects(f.tools.execute(snapshot,'workshop_run',{digest:built.digest,input:1}),/owner must enable/);
  await assert.rejects(f.tools.execute(snapshot,'workshop_build',definition),/owner must enable/);
});
test('only explicit bounded private files reach the guest, no path escapes or symlinks',async t=>{
  const f=await fixture(t);const built=await f.tools.execute(f.bot,'workshop_build',{...definition,source:'x=>Object.values(x.files).join(\"\")',tests:[{input:{data:null,files:{'a.txt':'fixture'}},expected:'fixture'}]});
  await writeWorkspace(f.store,f.bot.id,'documents/fixture.txt','private-fixture');
  const result=await f.tools.execute(f.bot,'workshop_run',{digest:built.digest,input:null,files:['documents/fixture.txt']});assert.equal(result.output,'private-fixture');
  for(const file of ['../state.json','/etc/passwd'])await assert.rejects(f.tools.execute(f.bot,'workshop_run',{digest:built.digest,input:null,files:[file]}));
  await fs.symlink(path.join(f.directory,'state.json'),path.join(f.directory,'workspaces',f.bot.id,'escape.json'));
  await assert.rejects(f.tools.execute(f.bot,'workshop_run',{digest:built.digest,input:null,files:['escape.json']}),/Symbolic/);
  await assert.rejects(f.tools.execute({...f.bot,tools:['workshop']},'workshop_run',{digest:built.digest,input:null,files:['documents/fixture.txt']}),/Files access/);
});
test('proposal export is exact-reviewed and excludes execution input, owner identity and transcripts',async t=>{
  const f=await fixture(t);const built=await f.tools.execute(f.bot,'workshop_build',definition);
  await f.tools.execute(f.bot,'workshop_run',{digest:built.digest,input:987654321});
  const proposed=await f.tools.execute(f.bot,'improvement_propose',{kind:'tool',title:'Reusable addition',summary:'Generic numeric utility',toolDigest:built.digest});
  assert.equal((await listImprovements(f.store,f.bot.id)).items.length,1);
  const read=await readImprovement(f.store,f.bot.id,proposed.digest);assert.equal(read.proposal.toolDigest,built.digest);
  for(const args of [{digest:proposed.digest},{digest:proposed.digest,reviewedDigest:'0'.repeat(64),includeSource:true}])await assert.rejects(exportImprovement(f.store,f.bot.id,args),/Review/);
  const exported=await exportImprovement(f.store,f.bot.id,{digest:proposed.digest,reviewedDigest:proposed.digest,includeSource:true});
  const serialized=JSON.stringify(exported);assert.ok(!serialized.includes('987654321'));assert.ok(!serialized.includes(f.bot.id));assert.ok(!serialized.includes(f.directory));assert.equal(workshopDigest(exported.proposal),exported.digest);
  assert.equal(exported.proposal.verification.scope.includes('not a security'),true);
});
test('engine improvements stay inert, secrets are rejected, and other bots cannot use local packages',async t=>{
  const f=await fixture(t),built=await f.tools.execute(f.bot,'workshop_build',definition);
  const other=f.store.state.bots[1];other.tools=['workshop'];await assert.rejects(f.tools.execute(other,'workshop_run',{digest:built.digest,input:1}));
  await assert.rejects(f.tools.execute(f.bot,'workshop_build',{...definition,source:'()=>"sk-abcdefghijklmnopqrstuvwxyz0123456789"'}),/credentials/);
  const patch='diff --git a/lib/example.mjs b/lib/example.mjs\n--- a/lib/example.mjs\n+++ b/lib/example.mjs\n@@ -1 +1 @@\n-old\n+new\n';
  const proposed=await f.tools.execute(f.bot,'improvement_propose',{kind:'engine',title:'Example change',summary:'Illustrative proposal',patch,validation:'Not executed'});
  const record=await readImprovement(f.store,f.bot.id,proposed.digest);assert.equal(record.proposal.verification.passed,false);assert.equal(record.proposal.patch,patch);
});
test('shared product catalog installs only an exact digest and re-runs its tests',async t=>{
  const f=await fixture(t),catalog=(await listWorkshopTools(f.store,f.bot.id)).catalog,entry=catalog.find(x=>x.id==='summarize-numbers');assert.ok(entry);
  await assert.rejects(f.tools.execute(f.bot,'workshop_install',{id:entry.id,digest:'0'.repeat(64)}),/revision changed/);
  const installed=await f.tools.execute(f.bot,'workshop_install',{id:entry.id,digest:entry.digest});assert.equal(installed.verification.tests.length,3);
  assert.deepEqual((await f.tools.execute(f.bot,'workshop_run',{digest:installed.digest,input:[10,20]})).output,{count:2,sum:30,mean:15,min:10,max:20});
});


test('current Strict policy cannot be bypassed by an older Balanced task snapshot',async t=>{
  const f=await fixture(t),snapshot=structuredClone(f.bot);f.bot.approvalPolicy='strict';
  await assert.rejects(f.tools.execute(snapshot,'workshop_build',definition),/approval/);
  const created=await f.tools.execute(snapshot,'workshop_build',definition,{approved:true});assert.equal(created.registered,true);
});
test('persisted packages survive restart without re-executing a registration',async t=>{
  const f=await fixture(t);const built=await f.tools.execute(f.bot,'workshop_build',definition);await f.store.mutate(()=>{});await f.store.queue;
  const reopened=await new Store(f.directory).init();const tools=new AgentTools(reopened);assert.equal((await tools.execute(reopened.state.bots[0],'workshop_run',{digest:built.digest,input:9})).output,10);await reopened.queue;
});
test('workshop storage refuses symlinked package roots',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.directory,'workshop',f.bot.id),{recursive:true});await fs.symlink(f.directory,path.join(f.directory,'workshop',f.bot.id,'packages'));
  await assert.rejects(f.tools.execute(f.bot,'workshop_build',definition),/Symbolic|real directory/);
});

test('maintainer intake rejects tampering and fake verification, re-tests tools and never applies Engine patches',async t=>{
  const {reviewContribution}=await import('../scripts/review-contribution.mjs');
  const f=await fixture(t),built=await f.tools.execute(f.bot,'workshop_build',definition);
  const saved=await f.tools.execute(f.bot,'improvement_propose',{kind:'tool',title:'Reusable addition',summary:'Generic utility',toolDigest:built.digest});
  const bundle=await exportImprovement(f.store,f.bot.id,{digest:saved.digest,reviewedDigest:saved.digest,includeSource:true});
  const file=path.join(f.directory,'contribution.json'),catalogDirectory=path.join(f.directory,'catalog');await fs.mkdir(catalogDirectory);await fs.writeFile(file,JSON.stringify(bundle));
  assert.equal((await reviewContribution(file)).digest,bundle.digest);assert.deepEqual(await fs.readdir(catalogDirectory),[]);
  await assert.rejects(reviewContribution(file,{catalogDirectory,acceptDigest:'0'.repeat(64)}),/exact reviewed/);
  assert.equal((await reviewContribution(file,{catalogDirectory,acceptDigest:bundle.digest})).accepted,true);
  await assert.rejects(reviewContribution(file,{catalogDirectory,acceptDigest:bundle.digest}),error=>error.code==='EEXIST');
  bundle.proposal.package.source='()=>999';bundle.proposal.toolDigest=workshopDigest(bundle.proposal.package);bundle.digest=workshopDigest(bundle.proposal);await fs.writeFile(file,JSON.stringify(bundle));
  await assert.rejects(reviewContribution(file,{catalogDirectory,acceptDigest:bundle.digest}),/test 1 failed/);
  const engine={format:'tupies-improvement-v1',kind:'engine',title:'Inert patch',summary:'Not applied',patch:'diff --git a/a b/a\n+new',validation:'Not executed'};const digest=workshopDigest(engine);await fs.writeFile(file,JSON.stringify({format:'tupies-contribution-v1',proposal:engine,digest}));
  await assert.rejects(reviewContribution(file,{catalogDirectory,acceptDigest:digest}),/Engine patches require normal source review/);
});
