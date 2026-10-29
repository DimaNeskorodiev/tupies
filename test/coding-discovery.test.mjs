import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCoding } from '../lib/coding-discovery.mjs';

async function fixture(t) {
  const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'tupies-discovery-')));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const agentPaths={claude:[],codex:[]},run=options=>discoverCoding({home,agentPaths,...options});return {home,run,agentPaths};
}
async function repo(directory,url) {await fs.mkdir(path.join(directory,'.git'),{recursive:true});if(url)await fs.writeFile(path.join(directory,'.git','config'),`[core]\n repositoryformatversion = 0\n[remote "origin"]\n url = ${url}\n`);return directory;}

test('coding discovery lists local and Claude projects without retaining account or transcript fields',async t=>{
  const {home,run}=await fixture(t),local=await repo(path.join(home,'Documents','work','local'),'https://user:fixture-secret@dev.azure.com/acme/Client%20Project/_git/service'),claude=path.join(home,'elsewhere','claude-project');await fs.mkdir(claude,{recursive:true});
  await fs.writeFile(path.join(home,'.claude.json'),JSON.stringify({oauthAccount:{token:'fixture-private-token'},projects:{[claude]:{history:'fixture-transcript'},[local]:{}}}));
  const result=await run();assert.equal(result.projects.length,2);assert.equal(result.claudeConfigPresent,true);assert.equal(result.truncated,false);assert.equal(result.projects.find(p=>p.path===local).source,'claude');
  assert.deepEqual(result.projects.find(p=>p.path===local),{path:local,name:'local',source:'claude',organization:'acme',project:'Client Project',repositoryName:'service',azureRemote:'https://dev.azure.com/acme/Client%20Project/_git/service'});
  const serialized=JSON.stringify(result);for(const secret of ['fixture-secret','fixture-private-token','fixture-transcript','user:'])assert.ok(!serialized.includes(secret));assert.ok(result.agents.every(a=>!a.detected));
});

test('coding discovery reads Azure SSH remotes and never executes Git config commands or includes',async t=>{
  const {home,run}=await fixture(t),directory=await repo(path.join(home,'Code','example'),'git@ssh.dev.azure.com:v3/acme/Project/example');await fs.appendFile(path.join(directory,'.git','config'),'[include]\n path = /not/read\n[credential]\n helper = !touch /not/executed\n');
  const result=await run();assert.equal(result.projects[0].azureRemote,'https://dev.azure.com/acme/Project/_git/example');assert.equal(result.projects[0].repositoryName,'example');assert.ok(!JSON.stringify(result).includes('/not/'));
});

test('coding discovery ignores unsafe remotes, unrelated hosts and encoded path injection',async t=>{
  const {home,run}=await fixture(t),urls=['https://dev.azure.com.evil.example/acme/P/_git/repo','https://dev.azure.com/acme/P/_git/repo?secret=fixture','https://dev.azure.com/acme/P/_git/%2e%2e','https://dev.azure.com/acme/P/_git/a%2fb','file:///etc/passwd','ssh://secret@evil.example/x'];
  for(const [index,url] of urls.entries())await repo(path.join(home,'Projects',String(index)),url);
  const result=await run();assert.equal(result.projects.length,urls.length);assert.ok(result.projects.every(p=>!p.azureRemote));assert.ok(!JSON.stringify(result).includes('secret'));
});

test('coding discovery does not follow folder, metadata or Git-config symlinks',async t=>{
  const {home,run}=await fixture(t),outside=await repo(path.join(home,'outside'),'https://dev.azure.com/acme/P/_git/outside'),projects=path.join(home,'Projects');await fs.mkdir(projects);await fs.symlink(outside,path.join(projects,'linked'));
  const real=await repo(path.join(projects,'real'));await fs.symlink(path.join(outside,'.git','config'),path.join(real,'.git','config'));await fs.writeFile(path.join(home,'private.json'),JSON.stringify({projects:{[outside]:{}}}));await fs.symlink(path.join(home,'private.json'),path.join(home,'.claude.json'));
  const result=await run();assert.equal(result.projects.length,1);assert.equal(result.projects[0].path,real);assert.equal(result.projects[0].azureRemote,undefined);assert.equal(result.claudeConfigPresent,false);
});

test('coding discovery bounds entry count, project count, folder depth and excludes generated trees',async t=>{
  const {home,run}=await fixture(t),root=path.join(home,'Projects');await repo(path.join(root,'one'));await repo(path.join(root,'two'));await repo(path.join(root,'node_modules','hidden'));await repo(path.join(root,'data','hidden'));await repo(path.join(root,'.private','hidden'));await repo(path.join(root,'a','b','c','d','e','deep'));
  const result=await run({maxProjects:1});assert.equal(result.projects.length,1);assert.equal(result.truncated,true);
  const bounded=await run({maxEntries:1});assert.equal(bounded.projects.length,0);assert.equal(bounded.truncated,true);
  const normal=await run();assert.deepEqual(normal.projects.map(p=>p.name).sort(),['one','two']);
});

test('coding discovery resolves executable symlinks without launching them',async t=>{
  const {home,run,agentPaths}=await fixture(t),real=path.join(home,'installed','claude-real'),link=path.join(home,'bin','claude');await fs.mkdir(path.dirname(real));await fs.mkdir(path.dirname(link));await fs.writeFile(real,'#!/bin/sh\ntouch never-launched\n',{mode:0o700});await fs.symlink(real,link);agentPaths.claude.push(link);
  const result=await run({roots:[],includeClaudeProjects:false});assert.deepEqual(result.agents[0],{id:'claude',label:'Claude Code',executable:real,detected:true});await assert.rejects(fs.access(path.join(home,'never-launched')));assert.equal(result.agents[1].detected,false);
});

test('coding discovery refuses huge/special metadata and honors cancellation without leaking reason',async t=>{
  const {home,run}=await fixture(t);await fs.writeFile(path.join(home,'.claude.json'),'x'.repeat(2_000_001));const result=await run({roots:[]});assert.equal(result.projects.length,0);assert.ok(result.warnings.length);assert.ok(!JSON.stringify(result).includes('xxxx'));
  const controller=new AbortController();controller.abort(new Error('private cancellation reason'));await assert.rejects(run({signal:controller.signal}),error=>error.status===499 && !error.message.includes('private cancellation'));
  await assert.rejects(run({maxEntries:100_001}));await assert.rejects(run({roots:['../relative']}));
});

test('coding discovery recognizes worktrees without following external gitdir pointers',async t=>{
  const {home,run}=await fixture(t),project=path.join(home,'Developer','worktree');await fs.mkdir(project,{recursive:true});await fs.writeFile(path.join(project,'.git'),'gitdir: /private/unrelated/config');const result=await run();assert.equal(result.projects.length,1);assert.equal(result.projects[0].path,project);assert.equal(result.projects[0].azureRemote,undefined);assert.ok(!JSON.stringify(result).includes('/private/unrelated'));
});

test('coding discovery counts ignored entries and refuses a symlinked home',async t=>{
  const {home,run}=await fixture(t),root=path.join(home,'Projects');await fs.mkdir(root);for(let index=0;index<12;index++)await fs.writeFile(path.join(root,`.hidden-${index}`),'');
  const result=await run({roots:[root],includeClaudeProjects:false,maxEntries:5});assert.equal(result.truncated,true);assert.equal(result.projects.length,0);
  const link=path.join(home,'linked-home');await fs.symlink(home,link);await assert.rejects(run({home:link}),/without symbolic links/);
});
