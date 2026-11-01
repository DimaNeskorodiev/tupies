import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { AgentTools, getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { listScripts, inspectScript, registerScript, prepareScriptRun, runScript } from '../lib/scripts.mjs';

const ID='summarize-fixture-data';
const README='# Summarize fixture data\n\nPurpose: summarize local input.\nInputs: data/input.json.\nOutputs: outputs/summary.json.\nUsage: run the registered entrypoint.\n';
const MAIN="import {format} from './helpers/format.mjs';\nconsole.log(format('fixture'));\n";
const HELPER="export const format=value=>'summary:'+value;\n";
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

async function fixture(t,{id=ID,files={'README.md':README,'index.mjs':MAIN,'helpers/format.mjs':HELPER}}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-script-security-')),store=await new Store(directory).init();
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot=store.state.bots[0];bot.tools=['workspace','terminal'];bot.approvalPolicy='balanced';
  const root=await getWorkspaceRoot(store,bot.id),base=path.join(root,'scripts',id),tools=new AgentTools(store);
  for(const [relative,content]of Object.entries(files)){const file=path.join(base,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);}
  const input={id,title:'Summarize fixture data',purpose:'Summarize the supplied local input without changing its source.',interpreter:'node',entrypoint:'index.mjs',files:[] ,inputs:['data/input.json'],outputs:['outputs/summary.json'],dependencies:[]};
  for(const relative of Object.keys(files)){const read=await tools.execute(bot,'workspace_read',{path:`scripts/${id}/${relative}`});input.files.push({path:relative,sha256:read.sha256});}
  return {directory,store,bot,root,base,tools,input};
}

function processFixture(onStart) {
  const calls=[];
  return {calls,async start(bot,runId,args,options){const entry={botId:bot.id,runId,args,options};calls.push(entry);if(onStart)await onStart(entry);return {processId:'process_fixture'};},async waitResult(){return {processId:'process_fixture',status:'completed',exitCode:0,timedOut:false,truncated:false,stdout:'{"fixture":true}\n',stderr:''};}};
}

async function registered(t,options) {const f=await fixture(t,options),result=await registerScript(f.store,f.bot.id,f.input);return {...f,entry:result.script,args:{scriptId:f.input.id,digest:result.script.digest,args:[]}};}

test('documented script packages move from draft to registered and expose actual source identities',async t=>{
  const f=await fixture(t),draft=await inspectScript(f.store,f.bot.id,ID);
  assert.equal(draft.status,'draft');assert.equal(draft.files.length,3);
  const result=await f.tools.execute(f.bot,'scripts_register',f.input,{approved:true});
  assert.equal(result.registered,true);assert.equal(result.script.status,'registered');assert.equal(result.script.digest,result.script.registeredDigest);
  assert.match(result.script.digest,/^[a-f0-9]{64}$/);assert.match(result.script.manifestSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(result.script.files.map(file=>file.relativePath).sort(),['helpers/format.mjs','index.mjs','README.md'].sort());
  const listing=await listScripts(f.store,f.bot.id);assert.equal(listing.scripts.length,1);assert.equal(listing.scripts[0].status,'registered');assert.equal(listing.truncated,false);
  assert.equal(f.store.state.skills.some(skill=>skill.id===ID),false,'Registering source must not create a skill or grant capabilities.');
  await assert.rejects(f.tools.execute(f.bot,'scripts_run',{scriptId:ID,digest:result.script.digest,args:[]},{approved:true,runId:'run_fixture'}),/exact engine-prepared approval/);
});

test('helper edits change the package digest and require CAS registration against current source hashes',async t=>{
  const f=await registered(t),manifest=path.join(f.base,'script.json'),before=JSON.parse(await fs.readFile(manifest,'utf8'));
  await fs.writeFile(path.join(f.base,'helpers/format.mjs'),"export const format=value=>'revised:'+value;\n");
  const changed=await inspectScript(f.store,f.bot.id,ID);assert.equal(changed.status,'changed');assert.notEqual(changed.digest,f.entry.digest);assert.equal(changed.registeredDigest,f.entry.digest);
  await assert.rejects(prepareScriptRun(f.store,f.bot,f.args),error=>error.status===409);
  await assert.rejects(registerScript(f.store,f.bot.id,{...f.input,expectedManifestSha256:f.entry.manifestSha256}),error=>error.status===409);
  const files=changed.files.map(file=>({path:file.relativePath,sha256:file.sha256}));
  await assert.rejects(registerScript(f.store,f.bot.id,{...f.input,files,expectedManifestSha256:'0'.repeat(64)}),error=>error.status===409);
  const next=await registerScript(f.store,f.bot.id,{...f.input,files,expectedManifestSha256:changed.manifestSha256});
  assert.equal(next.script.status,'registered');assert.equal(next.script.digest,changed.digest);
  assert.equal(JSON.parse(await fs.readFile(manifest,'utf8')).createdAt,before.createdAt);
});

test('competing registrations cannot both consume the same manifest revision',async t=>{
  const f=await registered(t),expectedManifestSha256=f.entry.manifestSha256;
  const results=await Promise.allSettled([
    registerScript(f.store,f.bot.id,{...f.input,purpose:'First reviewed revision.',expectedManifestSha256}),
    registerScript(f.store,f.bot.id,{...f.input,purpose:'Competing reviewed revision.',expectedManifestSha256}),
  ]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const rejected=results.find(result=>result.status==='rejected');assert.equal(rejected.reason.status,409);
  assert.equal((await inspectScript(f.store,f.bot.id,ID)).purpose,'First reviewed revision.');
});

test('registration needs exact source hashes plus a README and matching entrypoint',async t=>{
  const f=await fixture(t);
  for(const input of [
    {...f.input,files:f.input.files.filter(file=>file.path!=='README.md')},
    {...f.input,entrypoint:'main.py'},
    {...f.input,files:f.input.files.map(file=>({...file,sha256:'0'.repeat(64)}))},
    {...f.input,files:[...f.input.files,f.input.files[0]]},
  ])await assert.rejects(registerScript(f.store,f.bot.id,input));
  await assert.rejects(fs.stat(path.join(f.base,'script.json')),error=>error.code==='ENOENT');
});

test('script packages reject unsafe names and escaping or hidden resource paths',async t=>{
  const f=await fixture(t);
  for(const scriptId of ['../other-bot','/absolute','Two Words','_hidden','name--gap','name/child'])await assert.rejects(inspectScript(f.store,f.bot.id,scriptId));
  for(const relative of ['../outside.mjs','/outside.mjs','helper\\outside.mjs','.env','node_modules/helper.mjs','a/../../outside.mjs','script.json']){
    await assert.rejects(registerScript(f.store,f.bot.id,{...f.input,files:[...f.input.files,{path:relative,sha256:'0'.repeat(64)}]}));
  }
  assert.deepEqual(await fs.readdir(f.root),['scripts']);
});

test('source names cannot collide through case folding or Unicode normalization across engines',async t=>{
  const f=await fixture(t);
  for(const pair of [['README.md','readme.md'],['helpers/café.mjs','helpers/cafe\u0301.mjs']]){
    const files=f.input.files.filter(file=>!pair.includes(file.path));
    for(const relative of pair)files.push({path:relative,sha256:'0'.repeat(64)});
    await assert.rejects(registerScript(f.store,f.bot.id,{...f.input,files}),/distinct on both Mac and Linux/);
  }
  await assert.rejects(fs.stat(path.join(f.base,'script.json')),error=>error.code==='ENOENT');
});

test('registered source paths respect the complete workspace path limit at its boundary',async t=>{
  const id='a'.repeat(64),relative='x'.repeat(163)+'.mjs';
  assert.equal(`scripts/${id}/${relative}`.length,240);
  const f=await fixture(t,{id,files:{'README.md':README,'index.mjs':'console.log("fixture");\n',[relative]:'export const fixture=true;\n'}});
  const result=await registerScript(f.store,f.bot.id,f.input);assert.equal(result.script.status,'registered');
  assert.ok(result.script.files.some(file=>file.path.length===240));
  const tooLong='x'.repeat(164)+'.mjs';
  await assert.rejects(registerScript(f.store,f.bot.id,{...f.input,files:[...f.input.files,{path:tooLong,sha256:'0'.repeat(64)}],expectedManifestSha256:result.script.manifestSha256}),/240-character workspace path limit/);
});

test('symlinked entrypoints, helpers and manifests are refused without touching their targets',async t=>{
  for(const relative of ['index.mjs','helpers/format.mjs','script.json'])await t.test(relative,async t=>{
    const f=await fixture(t),outside=path.join(f.directory,'outside-fixture.txt');await fs.writeFile(outside,'Protected fixture contents.');
    const target=path.join(f.base,relative);await fs.rm(target,{force:true});await fs.symlink(outside,target);
    await assert.rejects(registerScript(f.store,f.bot.id,f.input),/Symbolic links/);
    assert.equal(await fs.readFile(outside,'utf8'),'Protected fixture contents.');
    assert.equal((await fs.lstat(target)).isSymbolicLink(),true);
  });
});

test('missing files and invalid manifests remain unavailable rather than becoming runnable drafts',async t=>{
  const f=await registered(t);await fs.unlink(path.join(f.base,'helpers/format.mjs'));
  const incomplete=await listScripts(f.store,f.bot.id);assert.equal(incomplete.scripts[0].status,'invalid');
  await assert.rejects(prepareScriptRun(f.store,f.bot,f.args));
  await fs.writeFile(path.join(f.base,'script.json'),'{broken JSON');
  const broken=await listScripts(f.store,f.bot.id);assert.equal(broken.scripts[0].status,'invalid');assert.match(broken.scripts[0].error,/valid JSON/);
});

test('known connection credentials are rejected in source and raw metadata before storage',async t=>{
  for(const secret of ['fixture-private-credential-123456','fixture-quoted-"credential"\nsecond-line'])await t.test(secret.includes('\n')?'escaped credential':'ordinary credential',async t=>{
    const f=await fixture(t);f.store.state.connections.push({id:'fixture-secret',name:'Fixture',type:'openai',secret:f.store.seal(secret)});
    await assert.rejects(registerScript(f.store,f.bot.id,{...f.input,title:secret}),/credentials/);
    await assert.rejects(registerScript(f.store,f.bot.id,{...f.input,dependencies:[secret]}),/credentials/);
    await fs.writeFile(path.join(f.base,'helpers/format.mjs'),'// '+secret+'\n');
    await assert.rejects(registerScript(f.store,f.bot.id,f.input),/credentials/);
    await assert.rejects(fs.stat(path.join(f.base,'script.json')),error=>error.code==='ENOENT');
  });
});

test('parsed manifests cannot smuggle escaped connection credentials into list or inspection results',async t=>{
  const f=await registered(t),secret='fixture-secret-with-"quotes"\nand-newline';
  f.store.state.connections.push({id:'fixture-secret',name:'Fixture',type:'openai',secret:f.store.seal(secret)});
  const filename=path.join(f.base,'script.json'),manifest=JSON.parse(await fs.readFile(filename,'utf8'));manifest.purpose=secret;await fs.writeFile(filename,JSON.stringify(manifest));
  await assert.rejects(inspectScript(f.store,f.bot.id,ID),/credentials/);
  const listing=await listScripts(f.store,f.bot.id);assert.equal(listing.scripts[0].status,'invalid');assert.ok(!JSON.stringify(listing).includes(secret));
});

test('all stored metadata fields reject escaped credentials, including preserved timestamps',async t=>{
  const f=await registered(t),secret='fixture-"timestamp-secret"\nprivate-value';
  f.store.state.connections.push({id:'fixture-secret',name:'Fixture',type:'openai',secret:f.store.seal(secret)});
  const filename=path.join(f.base,'script.json'),manifest=JSON.parse(await fs.readFile(filename,'utf8'));manifest.createdAt=secret;await fs.writeFile(filename,JSON.stringify(manifest));
  await assert.rejects(inspectScript(f.store,f.bot.id,ID),/credentials/);
});

test('catalog writes and registration always need exact approval under Balanced policy',async t=>{
  const f=await fixture(t),relative=`scripts/${ID}/script.json`;
  assert.equal(f.tools.requiresApproval('scripts_register',f.bot,f.input),true);
  await assert.rejects(f.tools.execute(f.bot,'scripts_register',f.input),/exact arguments/);
  for(const name of ['workspace_write','workspace_edit','documents_create'])assert.equal(f.tools.requiresApproval(name,f.bot,{path:relative}),true,name);
  await assert.rejects(f.tools.execute(f.bot,'workspace_write',{path:relative,content:'{}'}),/exact arguments/);
  assert.equal(f.tools.requiresApproval('workspace_write',f.bot,{path:`scripts/${ID}/index.mjs`}),false,'Ordinary source edits are allowed, but invalidate their registered digest.');
  assert.equal((await inspectScript(f.store,f.bot.id,ID)).status,'draft');
});

test('script discovery and execution cannot cross bot scope or expand required groups',async t=>{
  const f=await registered(t),other={...f.store.state.bots[1],tools:['workspace','terminal']};
  assert.deepEqual((await listScripts(f.store,other.id)).scripts,[]);
  await assert.rejects(inspectScript(f.store,other.id,ID));
  for(const tools of [[],['workspace'],['terminal']])await assert.rejects(prepareScriptRun(f.store,{...f.bot,tools},f.args),error=>error.status===403);
  await assert.rejects(f.tools.execute({...f.bot,tools:['workspace']},'scripts_run',f.args,{approved:true}),/not enabled/);
  await assert.rejects(f.tools.execute({...f.bot,tools:['terminal']},'scripts_list',{}),/not enabled/);
  const prepared=await prepareScriptRun(f.store,f.bot,f.args),processes=processFixture();
  await assert.rejects(runScript(f.store,other,f.args,{approvedScript:prepared.identity,runId:'run_fixture',processes}),error=>error.status===403);assert.equal(processes.calls.length,0);
});

test('opaque script approval cannot be forged, changed or reused',async t=>{
  const f=await registered(t),processes=processFixture(),options={runId:'run_fixture',processes},prepared=await prepareScriptRun(f.store,f.bot,f.args);
  for(const identity of [{},Object.create(prepared.identity),JSON.parse(JSON.stringify(prepared.identity))])await assert.rejects(runScript(f.store,f.bot,f.args,{...options,approvedScript:identity}),error=>error.status===403);
  await assert.rejects(runScript(f.store,f.bot,{...f.args,args:['changed']},{...options,approvedScript:prepared.identity}),error=>error.status===403);
  const fresh=await prepareScriptRun(f.store,f.bot,f.args),result=await runScript(f.store,f.bot,f.args,{...options,approvedScript:fresh.identity});assert.equal(result.exitCode,0);assert.equal(processes.calls.length,1);
  await assert.rejects(runScript(f.store,f.bot,f.args,{...options,approvedScript:fresh.identity}),error=>error.status===403);assert.equal(processes.calls.length,1);
});

test('the same opaque proof cannot authorize two concurrent dispatches',async t=>{
  const f=await registered(t),prepared=await prepareScriptRun(f.store,f.bot,f.args),processes=processFixture();
  const results=await Promise.allSettled([1,2].map(()=>runScript(f.store,f.bot,f.args,{approvedScript:prepared.identity,runId:'run_fixture',processes})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);assert.equal(processes.calls.length,1);
});

test('an opaque proof remains bound to its originating store even with matching bot and package bytes',async t=>{
  const first=await registered(t),second=await fixture(t),prepared=await prepareScriptRun(first.store,first.bot,first.args),processes=processFixture();
  await fs.copyFile(path.join(first.base,'script.json'),path.join(second.base,'script.json'));
  assert.equal((await inspectScript(second.store,second.bot.id,ID)).digest,first.entry.digest);
  await assert.rejects(runScript(second.store,second.bot,first.args,{approvedScript:prepared.identity,runId:'run_fixture',processes}),error=>error.status===403);assert.equal(processes.calls.length,0);
});

test('an opaque proof cannot move to a different task or cancellation scope',async t=>{
  const f=await registered(t),first=new AbortController(),second=new AbortController(),processes=processFixture();
  const prepared=await prepareScriptRun(f.store,f.bot,f.args,{runId:'run_current',signal:first.signal});
  await assert.rejects(runScript(f.store,f.bot,f.args,{approvedScript:prepared.identity,runId:'run_other',signal:first.signal,processes}),error=>error.status===403);
  await assert.rejects(runScript(f.store,f.bot,f.args,{approvedScript:prepared.identity,runId:'run_current',signal:second.signal,processes}),error=>error.status===403);
  assert.equal(processes.calls.length,0);
});

test('known credentials cannot be passed as process arguments even for a registered script',async t=>{
  const f=await registered(t),secret='fixture-argument-"secret"\nprivate-value';
  f.store.state.connections.push({id:'fixture-secret',name:'Fixture',type:'openai',secret:f.store.seal(secret)});
  await assert.rejects(prepareScriptRun(f.store,f.bot,{...f.args,args:[secret]}),/credentials/);
});

test('a source or catalog change during approval refuses dispatch without a fallback run',async t=>{
  for(const relative of ['index.mjs','helpers/format.mjs','script.json'])await t.test(relative,async t=>{
    const f=await registered(t),prepared=await prepareScriptRun(f.store,f.bot,f.args),processes=processFixture();
    await fs.appendFile(path.join(f.base,relative),'\n');
    await assert.rejects(runScript(f.store,f.bot,f.args,{approvedScript:prepared.identity,runId:'run_fixture',processes}),error=>error.status===409);assert.equal(processes.calls.length,0);
  });
});

test('dispatch uses the exact verified package copy when workspace code changes after staging',async t=>{
  const f=await registered(t),prepared=await prepareScriptRun(f.store,f.bot,f.args);let stagedDirectory;
  const processes=processFixture(async({args,options})=>{
    await fs.writeFile(path.join(f.base,'index.mjs'),'throw new Error("Unapproved replacement must not execute");\n');
    stagedDirectory=path.dirname(args.args[0]);
    assert.match(stagedDirectory,/process-homes/);assert.ok(!stagedDirectory.startsWith(f.root+path.sep));
    assert.equal(await fs.readFile(args.args[0],'utf8'),MAIN);
    assert.equal(await fs.readFile(path.join(stagedDirectory,'helpers/format.mjs'),'utf8'),HELPER);
    assert.equal(await fs.readFile(path.join(stagedDirectory,'README.md'),'utf8'),README);
    assert.equal(sha(await fs.readFile(args.args[0])),f.input.files.find(file=>file.path==='index.mjs').sha256);
    assert.equal(args.cwd,'.');assert.equal(args.executable,await fs.realpath(process.execPath));assert.equal(options.captureStreams,true);
  });
  const result=await runScript(f.store,f.bot,f.args,{approvedScript:prepared.identity,runId:'run_fixture',processes});
  assert.equal(result.exitCode,0);assert.equal(processes.calls.length,1);assert.equal(result.digest,f.entry.digest);
  await assert.rejects(fs.stat(stagedDirectory),error=>error.code==='ENOENT');
  assert.equal((await inspectScript(f.store,f.bot.id,ID)).status,'changed');
});
