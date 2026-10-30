import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { AgentTools, getWorkspaceRoot, listWorkspace, readWorkspace, writeWorkspace, safePath, executeProcess } from '../lib/agent-tools.mjs';
import { assertPublicUrl, isPublicAddress, resolvePublicAddress } from '../lib/net-policy.mjs';

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-native-tools-'));
  const store=await new Store(directory).init();
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  store.state.bots[0].approvalPolicy='strict';
  return {store,tools:new AgentTools(store),bot:store.state.bots[0],directory};
}

test('workspace tools keep paths private, preserve exact contents, and require mutation approval',async t=>{
  const {store,tools,bot,directory}=await fixture(t);
  await assert.rejects(tools.execute(bot,'workspace_write',{path:'notes/a.txt',content:'hello'}),/approval/);
  const content='  spaces matter\n\n';
  await tools.execute(bot,'workspace_write',{path:'notes/a.txt',content},{approved:true});
  assert.equal((await readWorkspace(store,bot.id,'notes/a.txt')).content,content);
  assert.equal((await listWorkspace(store,bot.id,'notes')).files[0].type,'file');
  await assert.rejects(tools.execute(bot,'workspace_read',{path:'../state.json'}),/cannot leave/);
  const root=await getWorkspaceRoot(store,bot.id);
  await fs.symlink(path.join(directory,'state.json'),path.join(root,'secret-link'));
  await assert.rejects(readWorkspace(store,bot.id,'secret-link'),/Symbolic links/);
  await fs.symlink(directory,path.join(root,'directory-link'));
  await assert.rejects(safePath(root,'directory-link/state.json'),/Symbolic links/);
  await assert.rejects(tools.execute({...bot,tools:[]},'workspace_read',{path:'notes/a.txt'}),/not enabled/);
  const second=store.state.bots[1];
  await assert.rejects(readWorkspace(store,second.id,'notes/a.txt'),/not found/);
  await writeWorkspace(store,bot.id,'uploaded.bin',Buffer.from([0,255,1]));
  assert.deepEqual(await fs.readFile(path.join(root,'uploaded.bin')),Buffer.from([0,255,1]));
});

test('native memory is persistent, bounded and isolated by bot',async t=>{
  const {store,tools,bot}=await fixture(t);
  await tools.execute(bot,'memory_set',{key:'writing-style',value:'Use plain language.'});
  assert.equal((await tools.execute(bot,'memory_search',{query:'plain'})).entries[0].key,'writing-style');
  assert.deepEqual((await tools.execute(store.state.bots[1],'memory_search',{query:''})).entries,[]);
  const reloaded=await new Store(store.directory).init();
  assert.equal(reloaded.state.memory[bot.id][0].value,'Use plain language.');
  await tools.execute(bot,'memory_delete',{key:'writing-style'});
  assert.deepEqual((await tools.execute(bot,'memory_search',{query:''})).entries,[]);
});

test('assigned skill resources can be read and approved scripts really execute without inherited secrets',async t=>{
  const {store,tools,bot}=await fixture(t);
  const skillId='native-resource',root=path.join(store.directory,'skills',skillId);
  await fs.mkdir(path.join(root,'references'),{recursive:true});
  await fs.mkdir(path.join(root,'scripts'));
  await fs.writeFile(path.join(root,'SKILL.md'),'---\nname: native-resource\ndescription: A native resource fixture.\n---\nRead references/info.txt.');
  await fs.writeFile(path.join(root,'references/info.txt'),'Actual reference data.');
  await fs.writeFile(path.join(root,'scripts/read.mjs'),"import fs from 'node:fs'; console.log(fs.readFileSync('references/info.txt','utf8')); console.log(process.env.ENGINE_TEST_SECRET || 'secret-not-inherited');");
  await store.mutate(state=>{state.skills.push({id:skillId,name:skillId,description:'Native resource fixture',files:['SKILL.md','references/info.txt','scripts/read.mjs']});state.bots[0].skills=[skillId];});
  const current=store.state.bots[0];
  assert.equal((await tools.execute(current,'skills_file',{skillId,path:'references/info.txt'})).content,'Actual reference data.');
  const arguments_={skillId,path:'scripts/read.mjs',interpreter:'node',args:[]};
  await assert.rejects(tools.execute(current,'skills_run',arguments_),/approval/);
  const prior=process.env.ENGINE_TEST_SECRET;process.env.ENGINE_TEST_SECRET='do-not-forward-this-fixture';
  try {
    const result=await tools.execute(current,'skills_run',arguments_,{approved:true});
    assert.equal(result.exitCode,0);assert.match(result.stdout,/Actual reference data/);assert.match(result.stdout,/secret-not-inherited/);assert.doesNotMatch(result.stdout,/do-not-forward/);
  } finally {if(prior===undefined)delete process.env.ENGINE_TEST_SECRET;else process.env.ENGINE_TEST_SECRET=prior;}
  await assert.rejects(tools.execute(store.state.bots[1],'skills_read',{skillId}),/not assigned/);
  await assert.rejects(tools.execute(current,'skills_file',{skillId,path:'../../state.json'}),/cannot leave/);
});

test('model-selected web requests reject private DNS, mapped addresses, metadata and unsafe ports',async()=>{
  for(const address of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','fe80::1','fd00::1','::ffff:127.0.0.1','::ffff:7f00:1','2001:db8::1','2001::1','2001:1f::1','3fff::1'])assert.equal(isPublicAddress(address),false,address);
  assert.equal(isPublicAddress('8.8.8.8'),true);assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
  for(const url of ['http://example.com','https://localhost','https://169.254.169.254','https://example.com:8443','https://user:pass@example.com'])assert.throws(()=>assertPublicUrl(url));
  await assert.rejects(resolvePublicAddress('public-looking.example',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]),/private or reserved/);
  const admitted=await resolvePublicAddress('public.example',async()=>[{address:'8.8.8.8',family:4}]);assert.equal(admitted.address,'8.8.8.8');
});

test('approved learning creates a portable skill and updates only the caller’s live capability snapshot',async t=>{
  const {store,tools,bot}=await fixture(t),snapshot=structuredClone(bot);
  const args={name:'learned-workflow',description:'A reusable review workflow.',instructions:'# Review\n\nCheck the evidence, list decisions, and ask before sending anything.'};
  await assert.rejects(tools.execute(snapshot,'skills_create',args),/approval/);
  assert.equal(store.state.skills.some(skill=>skill.id===args.name),false);
  await tools.execute(snapshot,'skills_create',args,{approved:true});
  assert.ok(snapshot.skills.includes(args.name));assert.ok(store.state.bots[0].skills.includes(args.name));assert.equal(store.state.bots[1].skills.includes(args.name),false);
  assert.match((await tools.execute(snapshot,'skills_read',{skillId:args.name})).content,/# Review/);
  const reloaded=await new Store(store.directory).init();assert.equal(reloaded.state.skills.find(skill=>skill.id===args.name).source,'learned');assert.ok(reloaded.state.bots[0].skills.includes(args.name));
  await assert.rejects(tools.execute(snapshot,'skills_create',{...args,instructions:'Overwrite?'},{approved:true}),/already exists/);
  await assert.rejects(tools.execute(snapshot,'skills_create',{...args,name:'../escape'},{approved:true}),/lowercase slug/);
  assert.match((await tools.execute(snapshot,'skills_read',{skillId:args.name})).content,/Check the evidence/);
});

test('automation tools require consent for future work and cannot inspect or remove another bot’s schedules',async t=>{
  // Without Manage Tupies a bot sees and changes only its own routines.
  const {store,tools,bot}=await fixture(t);bot.tools=['workspace','memory','skills','web','integrations','delegation','automation'];
  const second=store.state.bots[1];second.tools=['workspace','memory','skills','web','integrations','delegation','automation'];
  const args={name:'Evidence review',prompt:'Review the available evidence and report changes.',intervalMinutes:60};
  await assert.rejects(tools.execute(bot,'routines_create',args),/approval/);assert.equal(store.state.routines.length,0);
  await assert.rejects(tools.execute(bot,'routines_create',{...args,intervalMinutes:4},{approved:true}),/interval/);
  const created=await tools.execute(bot,'routines_create',args,{approved:true}),routine=created.routine;
  assert.equal(routine.enabled,true);assert.equal(routine.botId,bot.id);assert.ok(Date.parse(routine.nextRunAt)>Date.now()+59*60000);
  assert.equal((await tools.execute(bot,'routines_list',{})).routines.length,1);
  assert.deepEqual((await tools.execute(second,'routines_list',{})).routines,[]);
  await assert.rejects(tools.execute(second,'routines_delete',{routineId:routine.id},{approved:true}),/their own/);
  assert.equal(store.state.routines.length,1);
  await assert.rejects(tools.execute(bot,'routines_delete',{routineId:routine.id}),/approval/);
  await tools.execute(bot,'routines_delete',{routineId:routine.id},{approved:true});assert.equal(store.state.routines.length,0);
});

test('an approved process settles after it exits even when a descendant escaped its group with the output pipes',{skip:process.platform==='win32'},async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-escape-'));let escaped=0;
  t.after(async()=>{try{if(escaped)process.kill(escaped,'SIGKILL');}catch{}await fs.rm(directory,{recursive:true,force:true});});
  const script="const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'inherit'});console.log(c.pid);c.unref();";
  const started=Date.now(),result=await executeProcess(process.execPath,['-e',script],{cwd:directory,home:directory,timeoutMs:15000});
  escaped=Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(escaped) && escaped>0);assert.equal(result.exitCode,0);assert.equal(result.timedOut,false);
  assert.ok(Date.now()-started<5000,`settled after ${Date.now()-started} ms`);
});
