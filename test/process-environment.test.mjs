import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../lib/store.mjs';
import { AgentTools, executeProcess, getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { BackgroundProcesses } from '../lib/background-processes.mjs';
import { LanguageServers } from '../lib/lsp.mjs';
import { getProcessHome, processEnvironment } from '../lib/process-environment.mjs';

const inspection="JSON.stringify({home:require('node:os').homedir(),cwd:process.cwd(),temp:process.env.TMPDIR,python:process.env.PYTHONNOUSERSITE,git:process.env.GIT_CONFIG_NOSYSTEM,global:process.env.GIT_CONFIG_GLOBAL,secret:process.env.TUPIES_PROCESS_FIXTURE_SECRET||null})";
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-process-home-')),store=await new Store(directory).init(),bot=store.state.bots[0],runId='run_process_environment';
  await store.mutate(state=>{state.bots[0].tools=['workspace','terminal','skills'];state.runs[bot.id]={id:runId,status:'running'};});
  const cleanup=[];t.after(async()=>{for(const close of cleanup)await close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,store,bot,runId,workspace:await getWorkspaceRoot(store,bot.id),tools:new AgentTools(store),cleanup};
}

test('approved commands and skill scripts share an engine-local home outside model-editable files',async t=>{
  const {directory,store,bot,workspace,tools}=await fixture(t),home=path.join(directory,'process-homes',bot.id);
  await fs.writeFile(path.join(workspace,'.gitconfig'),'[tupies]\npoison = workspace-startup\n');
  const old=process.env.TUPIES_PROCESS_FIXTURE_SECRET;process.env.TUPIES_PROCESS_FIXTURE_SECRET='must-not-inherit';
  try {
    const result=await tools.execute(bot,'shell_run',{executable:process.execPath,args:['-e',`console.log(${inspection})`]},{approved:true});
    assert.equal(result.exitCode,0);const env=JSON.parse(result.stdout);
    assert.equal(env.home,home);assert.equal(env.cwd,await fs.realpath(workspace));assert.equal(env.temp,path.join(home,'.tmp'));assert.equal(env.secret,null);assert.equal(env.python,'1');assert.equal(env.git,'1');assert.equal(env.global,path.join(home,'.gitconfig'));
    const named=await tools.execute(bot,'shell_run',{executable:'node',args:['-p','process.execPath']},{approved:true});assert.equal(named.exitCode,0);assert.equal(named.stdout.trim(),await fs.realpath(process.execPath));
    const git=await executeProcess('git',['config','--global','--get','tupies.poison'],{cwd:workspace,home});
    assert.equal(git.exitCode,1);assert.equal(git.stdout,'','Workspace .gitconfig must not become global process configuration.');
    const skill='environment-fixture',root=path.join(directory,'skills',skill);await fs.mkdir(root);
    await fs.writeFile(path.join(root,'inspect.cjs'),`console.log(${inspection});`);
    await store.mutate(state=>{state.skills.push({id:skill,name:skill});state.bots[0].skills=[skill];});
    const script=await tools.execute(store.state.bots[0],'skills_run',{skillId:skill,path:'inspect.cjs',interpreter:'node',args:[]},{approved:true});
    assert.equal(script.exitCode,0);assert.equal(JSON.parse(script.stdout).home,home);assert.equal(JSON.parse(script.stdout).cwd,await fs.realpath(root));
    await fs.writeFile(path.join(home,'tool-state.txt'),'retained on this engine');assert.equal(await getProcessHome(store,bot.id),home);assert.equal(await fs.readFile(path.join(home,'tool-state.txt'),'utf8'),'retained on this engine');
    assert.equal(await fs.readFile(path.join(workspace,'.gitconfig'),'utf8'),'[tupies]\npoison = workspace-startup\n');
  } finally {if(old===undefined)delete process.env.TUPIES_PROCESS_FIXTURE_SECRET;else process.env.TUPIES_PROCESS_FIXTURE_SECRET=old;}
});

test('managed commands and actual language servers use the same private environment',async t=>{
  const {directory,store,bot,runId,workspace,cleanup}=await fixture(t),home=await getProcessHome(store,bot.id),manager=new BackgroundProcesses(store),servers=new LanguageServers(store);
  cleanup.push(()=>manager.close(),()=>servers.close());
  // A model-created workspace temporary symlink is irrelevant to engine-owned process storage.
  await fs.symlink(directory,path.join(workspace,'.tmp'));
  const command=await manager.start(bot,runId,{executable:process.execPath,args:['-e',`console.log(${inspection})`]});
  assert.equal((await manager.wait(bot.id,runId,command.processId)).exitCode,0);
  const env=JSON.parse((await manager.read(bot.id,runId,command.processId)).output);assert.equal(env.home,home);assert.equal(env.temp,path.join(home,'.tmp'));
  const script=path.join(directory,'fixture-language-server.mjs'),lsp=fileURLToPath(new URL('./fixtures/lsp-server.mjs',import.meta.url));
  await fs.writeFile(script,`import fs from 'node:fs';fs.writeFileSync('server-environment.json',JSON.stringify({home:process.env.HOME,temp:process.env.TMPDIR,python:process.env.PYTHONNOUSERSITE,git:process.env.GIT_CONFIG_NOSYSTEM}));await import(${JSON.stringify(pathToFileURL(lsp).href)});`);
  const session=await servers.start({botId:bot.id,runId,server:'custom',executable:process.execPath,args:[script]});assert.equal(session.status,'ready');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspace,'server-environment.json'),'utf8')),{home,temp:path.join(home,'.tmp'),python:'1',git:'1'});
});

test('symlinked process homes and temporary/config directories fail before process launch',async t=>{
  const {directory,store,bot}=await fixture(t),outside=await fs.mkdtemp(path.join(tmpdir(),'tupies-outside-home-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  const parent=path.join(directory,'process-homes');await fs.symlink(outside,parent);await assert.rejects(getProcessHome(store,bot.id),/real directories/);await fs.unlink(parent);
  await fs.mkdir(parent);await fs.symlink(outside,path.join(parent,bot.id));await assert.rejects(getProcessHome(store,bot.id),/real directories/);await fs.unlink(path.join(parent,bot.id));
  const home=await getProcessHome(store,bot.id);await fs.symlink(outside,path.join(home,'.tmp'));await assert.rejects(processEnvironment(home),/real directories/);assert.deepEqual(await fs.readdir(outside),[]);
  await fs.unlink(path.join(home,'.tmp'));await fs.symlink(outside,path.join(home,'.config'));await assert.rejects(processEnvironment(home),/real directories/);assert.deepEqual(await fs.readdir(outside),[]);
  await assert.rejects(getProcessHome(store,'../escaped'),/Invalid bot/);
});

test('Git automatic-execution configuration requires review and imported fsmonitor cannot run during status',async t=>{
  const {directory,store,bot,workspace,tools}=await fixture(t),balanced={...bot,approvalPolicy:'balanced'},home=await getProcessHome(store,bot.id);
  for(const target of ['.git/config','project/.git/hooks/pre-commit','.git','.gitconfig','project/.gitattributes']){
    assert.equal(tools.requiresApproval('workspace_write',balanced,{path:target}),true);
    await assert.rejects(tools.execute(balanced,'workspace_write',{path:target,content:'unapproved executable configuration'}),/exact arguments/);
  }
  assert.equal(tools.requiresApproval('workspace_write',balanced,{path:'src/index.js'}),false);
  assert.equal((await executeProcess('git',['init','--quiet'],{cwd:workspace,home})).exitCode,0);
  await fs.writeFile(path.join(workspace,'tracked.txt'),'tracked');
  assert.equal((await executeProcess('git',['add','tracked.txt'],{cwd:workspace,home})).exitCode,0);
  const marker=path.join(directory,'unexpected-execution'),config=path.join(workspace,'.git','config');
  await fs.appendFile(config,`\n[core]\nfsmonitor = touch ${marker}\n`);
  const status=await tools.execute(balanced,'shell_run',{executable:'git',args:['status','--short']},{approved:true});
  assert.equal(status.exitCode,0);assert.match(status.stdout,/tracked.txt/);
  await assert.rejects(fs.stat(marker),error=>error.code==='ENOENT');
});
