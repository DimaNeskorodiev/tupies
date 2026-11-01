import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Store } from '../lib/store.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { listImprovements, readImprovement, exportImprovement, workshopDigest } from '../lib/workshop.mjs';
import { verifyEngineCandidate } from '../lib/engine-workshop.mjs';
import { reviewContribution } from '../scripts/review-contribution.mjs';

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-engine-candidate-')),root=path.join(directory,'source'),store=await new Store(path.join(directory,'runtime')).init();
  for(const name of ['lib','test','public','docs'])await fs.mkdir(path.join(root,name),{recursive:true});
  await fs.writeFile(path.join(root,'lib/math.mjs'),'export const add = x => x + 1;\n');
  await fs.writeFile(path.join(root,'lib/number.mjs'),'export const step = 2;\n');
  await fs.writeFile(path.join(root,'docs/local-workspace.md'),'private fixture data');await fs.writeFile(path.join(root,'.env'),'PRIVATE_FIXTURE=true');
  const bot=store.state.bots[0];Object.assign(bot,{tools:['engine_workshop'],approvalPolicy:'balanced'});
  const tools=new AgentTools(store,{engineSourceRoot:root});
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const listed=await tools.execute(bot,'engine_source_list',{}),sha256=listed.files.find(x=>x.path==='lib/math.mjs').sha256;
  const args={title:'Add two',summary:'Synthetic pure module change.',changes:[{path:'lib/math.mjs',sha256,oldText:'x + 1',newText:'x + 2'}],dependencies:[],tests:[{path:'lib/math.mjs',exportName:'add',input:40,expected:42}]};
  return {directory,root,store,bot,tools,args,listed,build:(argsOverride=args,options={})=>tools.execute(bot,'engine_candidate_build',argsOverride,options)};
}
test('Engine source access is separate owner opt-in and exposes only exact bounded source revisions',async t=>{
  const f=await fixture(t);assert.deepEqual(f.listed.files.map(x=>x.path),['lib/math.mjs','lib/number.mjs']);
  assert.equal(f.tools.definitions({...f.bot,tools:['workshop']}).some(x=>x.name.startsWith('engine_')),false);
  const read=await f.tools.execute(f.bot,'engine_source_read',{path:'lib/math.mjs',sha256:f.args.changes[0].sha256});assert.match(read.content,/x \+ 1/);assert.equal(read.nextOffset,null);
  for(const name of ['.env','docs/local-workspace.md','../state.json','/etc/passwd','lib/../../state.json','node_modules/package/index.mjs','lib/.private.mjs'])await assert.rejects(f.tools.execute(f.bot,'engine_source_read',{path:name,sha256:f.args.changes[0].sha256}));
  await assert.rejects(f.tools.execute(f.bot,'engine_source_read',{path:'lib/math.mjs',sha256:'0'.repeat(64)}),/changed/);
  const snapshot=structuredClone(f.bot);f.bot.tools=[];await assert.rejects(f.tools.execute(snapshot,'engine_source_list',{}),/owner must enable/);
});
test('candidate tests execute the actual changed module, preserve live bytes and export independent recheck inputs',async t=>{
  const f=await fixture(t),before=await fs.readFile(path.join(f.root,'lib/math.mjs'),'utf8'),built=await f.build();
  assert.equal(built.verification.tests[0].passed,true);assert.equal(built.verification.fullSuite,false);assert.equal(await fs.readFile(path.join(f.root,'lib/math.mjs'),'utf8'),before);
  const snapshot=JSON.parse(await fs.readFile(path.join(f.store.directory,'workshop',f.bot.id,'candidates',built.candidateDigest+'.json'),'utf8'));assert.match(snapshot.files['lib/math.mjs'],/x \+ 2/);assert.equal(workshopDigest(snapshot),built.candidateDigest);
  const proposal=await readImprovement(f.store,f.bot.id,built.digest);assert.match(proposal.proposal.patch,/^-export const add = x => x \+ 1;/m);assert.match(proposal.proposal.patch,/^\+export const add = x => x \+ 2;/m);
  const bundle=await exportImprovement(f.store,f.bot.id,{digest:built.digest,reviewedDigest:built.digest,includeSource:true}),file=path.join(f.directory,'contribution.json');await fs.writeFile(file,JSON.stringify(bundle));
  const checked=await reviewContribution(file,{checkEngineDigest:built.digest,sourceRoot:f.root});assert.equal(checked.verification.tests[0].passed,true);assert.equal(await fs.readFile(path.join(f.root,'lib/math.mjs'),'utf8'),before);
  const diff=path.join(f.directory,'candidate.patch');await fs.writeFile(diff,proposal.proposal.patch);assert.equal(spawnSync('git',['apply','--check',diff],{cwd:f.root}).status,0);
  assert.equal((await f.build()).candidateDigest,built.candidateDigest);assert.equal((await listImprovements(f.store,f.bot.id)).items.length,1);
});
test('pure candidate imports use only exact selected source snapshots and expose no host functions',async t=>{
  const f=await fixture(t),dep=f.listed.files.find(x=>x.path==='lib/number.mjs');
  f.args.changes[0].oldText='export const add = x => x + 1;';f.args.changes[0].newText='import {step} from "./number.mjs"; export const add = x => ({value:x+step,process:typeof process,fetch:typeof fetch,require:typeof require});';
  f.args.dependencies=[{path:dep.path,sha256:dep.sha256}];f.args.tests[0].expected={value:42,process:'undefined',fetch:'undefined',require:'undefined'};
  assert.equal((await f.build()).verification.tests.length,1);
  f.args.dependencies=[];await assert.rejects(f.build(),/test failed/);
});
test('failed syntax, wrong expected values and unavailable host imports save no proposals or candidates',async t=>{
  const f=await fixture(t);
  for(const change of [{newText:'('},{newText:'x + 7'},{newText:'process.env.PRIVATE_VALUE'}])await assert.rejects(f.build({...f.args,changes:[{...f.args.changes[0],...change}]}));
  const imports={...f.args,changes:[{...f.args.changes[0],oldText:'export const add = x => x + 1;',newText:'import fs from "node:fs"; export const add = x => fs.readFileSync("/etc/passwd");'}]};await assert.rejects(f.build(imports),/test failed/);
  assert.equal((await listImprovements(f.store,f.bot.id)).items.length,0);await assert.rejects(fs.stat(path.join(f.store.directory,'workshop',f.bot.id,'candidates')),/ENOENT/);
});
test('syntax-only checks never execute hostile top-level code or load imports',async t=>{
  const f=await fixture(t),marker=path.join(f.directory,'must-not-exist');
  f.args.changes[0]={...f.args.changes[0],oldText:'export const add = x => x + 1;',newText:`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'bad'); while(true){}; export const add=x=>x;`};f.args.tests=[];
  const built=await f.build();assert.deepEqual(built.verification.tests,[]);assert.equal(built.verification.checks[0].check,'node-syntax');assert.equal(built.verification.build,false);await assert.rejects(fs.stat(marker),/ENOENT/);
});
test('base hashes, unique edits, missing new files and changed dependency hashes fail closed',async t=>{
  const f=await fixture(t);
  for(const patch of [{sha256:'0'.repeat(64)},{oldText:'missing'},{oldText:''},{sha256:null,oldText:''},{path:'lib/../escape.mjs'}])await assert.rejects(f.build({...f.args,changes:[{...f.args.changes[0],...patch}]}));
  await assert.rejects(f.build({...f.args,dependencies:[{path:'lib/number.mjs',sha256:'0'.repeat(64)}]}),/revision changed/);
  await assert.rejects(f.build({...f.args,changes:[...f.args.changes,...f.args.changes]}),/once/);
  await assert.rejects(f.build({...f.args,tests:[{...f.args.tests[0],path:'lib/number.mjs'}]}),/edited/);
  assert.equal((await listImprovements(f.store,f.bot.id)).items.length,0);
});
test('symlinked source files and symlinked candidate storage cannot escape roots',async t=>{
  const f=await fixture(t);await fs.symlink(path.join(f.root,'lib/number.mjs'),path.join(f.root,'lib/link.mjs'));
  await assert.rejects(f.tools.execute(f.bot,'engine_source_read',{path:'lib/link.mjs',sha256:f.listed.files[1].sha256}),/Symbolic/);
  await fs.mkdir(path.join(f.store.directory,'workshop',f.bot.id),{recursive:true});await fs.symlink(f.root,path.join(f.store.directory,'workshop',f.bot.id,'candidates'));
  await assert.rejects(f.build(),/Symbolic/);assert.equal((await listImprovements(f.store,f.bot.id)).items.length,0);
});
test('Strict creation requires approval and model arguments cannot forge verification or select a host root',async t=>{
  const f=await fixture(t),strict={...f.bot,approvalPolicy:'strict'};
  await assert.rejects(f.tools.execute(strict,'engine_candidate_build',f.args),/approval/);
  for(const extra of [{root:'/etc'},{verification:{passed:true}},{approved:true}])await assert.rejects(f.build({...f.args,...extra},{approved:true}),/unknown arguments/);
  assert.equal((await f.tools.execute(strict,'engine_candidate_build',f.args,{approved:true})).verification.passed,true);
});
test('Stop terminates infinite guest execution and leaves no accepted candidate',async t=>{
  const f=await fixture(t),controller=new AbortController();f.args.changes[0].newText='(()=>{while(true){} return x;})()';
  const pending=f.build(f.args,{signal:controller.signal});setTimeout(()=>controller.abort(new Error('Fixture stop')),150);
  await assert.rejects(pending,/Fixture stop/);assert.equal((await listImprovements(f.store,f.bot.id)).items.length,0);
  assert.equal((await f.build({...f.args,changes:[{...f.args.changes[0],newText:'x + 2'}]})).verification.tests.length,1);
});
test('new files and missing final newlines produce applicable exact diffs without writing source',async t=>{
  const f=await fixture(t);
  for(const [name,source] of [['lib/new.mjs','export const add=x=>x+2;\n'],['lib/unterminated.mjs','export const add=x=>x+2;']]){
    const args={...f.args,changes:[{path:name,sha256:null,oldText:'',newText:source}],tests:[{...f.args.tests[0],path:name}]};
    const built=await f.build(args),proposal=await readImprovement(f.store,f.bot.id,built.digest),diff=path.join(f.directory,'new.patch');await fs.writeFile(diff,proposal.proposal.patch);assert.equal(spawnSync('git',['apply','--check',diff],{cwd:f.root}).status,0);await assert.rejects(fs.stat(path.join(f.root,name)),/ENOENT/);
  }
});
test('maintainer refuses changed base, altered diff and accepting an Engine patch as a tool',async t=>{
  const f=await fixture(t),built=await f.build(),bundle=await exportImprovement(f.store,f.bot.id,{digest:built.digest,reviewedDigest:built.digest,includeSource:true}),file=path.join(f.directory,'bundle.json');
  await fs.writeFile(file,JSON.stringify(bundle));await assert.rejects(reviewContribution(file,{acceptDigest:built.digest}),/tool contribution/);
  bundle.proposal.patch+='malformed\n';bundle.digest=workshopDigest(bundle.proposal);await fs.writeFile(file,JSON.stringify(bundle));await assert.rejects(reviewContribution(file,{checkEngineDigest:bundle.digest,sourceRoot:f.root}),/differs/);
  await fs.writeFile(path.join(f.root,'lib/math.mjs'),'export const add = x => x + 3;\n');await assert.rejects(verifyEngineCandidate(f.args,{root:f.root}),/Unknown/);
  await assert.rejects(reviewContribution(file,{checkEngineDigest:bundle.digest,sourceRoot:f.root}),/revision changed/);
});
test('source changes and permission revocation during checks prevent publication',async t=>{
  for(const action of ['source','permission']){
    const f=await fixture(t);f.args.changes[0].newText='(()=>{const end=Date.now()+250;while(Date.now()<end){};return x+2;})()';
    const pending=f.build();const change=new Promise(resolve=>setTimeout(async()=>{if(action==='source')await fs.writeFile(path.join(f.root,'lib/math.mjs'),'export const add=x=>x+3;\n');else f.bot.tools=[];resolve();},100));
    await assert.rejects(pending,/[Ss]ource.*changed|owner must enable/);await change;assert.equal((await listImprovements(f.store,f.bot.id)).items.length,0);
  }
});
test('newline changes generate diffs that reproduce exact candidate bytes',async t=>{
  const f=await fixture(t);
  for(const [before,after] of [['export const n=1;\n','export const n=1;'],['export const n=1;','export const n=1;\n'],['// first\nexport const n=1;\n','// other\nexport const n=1;'],['// first\nexport const n=1;','// other\nexport const n=1;\n']]){
    const target=path.join(f.root,'lib/newline.mjs');await fs.writeFile(target,before);const listed=await f.tools.execute(f.bot,'engine_source_list',{prefix:'lib/newline'}),request={changes:[{path:'lib/newline.mjs',sha256:listed.files[0].sha256,oldText:before,newText:after}],dependencies:[],tests:[]};
    const checked=await verifyEngineCandidate(request,{root:f.root}),diff=path.join(f.directory,'newline.patch');await fs.writeFile(diff,checked.patch);const applied=spawnSync('git',['apply',diff],{cwd:f.root});assert.equal(applied.status,0,applied.stderr.toString());assert.equal(await fs.readFile(target,'utf8'),after);
  }
});
test('custom runtime directories inside the source tree and nested node_modules stay inaccessible',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-nested-runtime-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await new Store(path.join(directory,'lib/runtime')).init(),bot=store.state.bots[0];bot.tools=['engine_workshop'];
  const privateFile=path.join(store.directory,'private.mjs');await fs.writeFile(privateFile,'export const secret="private fixture";\n');
  await fs.mkdir(path.join(directory,'lib/node_modules'),{recursive:true});await fs.writeFile(path.join(directory,'lib/node_modules/private.mjs'),'export const secret=1;\n');
  const tools=new AgentTools(store,{engineSourceRoot:directory});const listed=await tools.execute(bot,'engine_source_list',{});assert.deepEqual(listed.files,[]);
  for(const name of ['lib/runtime/private.mjs','lib/node_modules/private.mjs'])await assert.rejects(tools.execute(bot,'engine_source_read',{path:name,sha256:'0'.repeat(64)}),/Runtime data|supported/);
  await assert.rejects(tools.execute(bot,'engine_candidate_build',{title:'Blocked',summary:'Must not read runtime files',changes:[{path:'lib/runtime/new.mjs',sha256:null,oldText:'',newText:'export const value=1;'}],dependencies:[],tests:[]}),/Runtime data/);
  await store.queue;
});

test('new nested candidates preserve absent live directories and refuse linked or non-directory ancestors',async t=>{
  const f=await fixture(t),name='lib/new/nested/add.mjs';
  const args={...f.args,changes:[{path:name,sha256:null,oldText:'',newText:'export const add=x=>x+2;'}],tests:[{path:name,exportName:'add',input:40,expected:42}]};
  assert.equal((await f.build(args)).verification.tests[0].passed,true);
  await assert.rejects(fs.stat(path.join(f.root,'lib/new')),/ENOENT/);
  await fs.symlink(path.join(f.root,'test'),path.join(f.root,'lib/new'));
  await assert.rejects(f.build(args),/Symbolic/);await fs.unlink(path.join(f.root,'lib/new'));
  await fs.writeFile(path.join(f.root,'lib/new'),'not a directory');await assert.rejects(f.build(args),/directory/);
});
