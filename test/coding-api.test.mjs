import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStudioServer} from '../server.mjs';

const password='disposable-coding-api-password';
async function fixture(t,{platform='darwin',trustProxy='loopback'}={}){
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'tupies-coding-api-'))),home=path.join(directory,'home'),repo=path.join(directory,'repository');
  await fs.mkdir(home);await fs.mkdir(path.join(repo,'.git'),{recursive:true});let app;const discovery=[];
  t.after(async()=>{if(app)await app.close();await fs.rm(directory,{recursive:true,force:true});});
  app=await createStudioServer({dataDir:path.join(directory,'data'),scheduler:false,logErrors:false,trustProxy,localCoding:{platform,home,discover:async options=>{discovery.push(options);return {agents:[{id:'claude',label:'Claude Code',executable:process.execPath,detected:true},{id:'codex',label:'Codex',executable:process.execPath,detected:true}],projects:[{name:'Fixture repository',path:repo,source:'claude',organization:'fixture-org',project:'Fixture Project',repositoryName:'fixture-repo'}],truncated:false};}}});
  const {url}=await app.listen(0,'127.0.0.1');let cookie='',csrf='';
  const request=async(route,{method='GET',data,authenticated=true,csrfToken=true,headers={}}={})=>{
    const response=await fetch(url+route,{method,signal:AbortSignal.timeout(10000),headers:{...(authenticated&&cookie?{Cookie:cookie}:{}),...(csrfToken&&csrf?{'X-CSRF-Token':csrf}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  const setup=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password}});assert.equal(setup.status,201);cookie=setup.headers.get('set-cookie').split(';')[0];csrf=setup.body.csrf;
  const project=()=>({name:'Fixture project',path:repo,agent:'claude',organization:'fixture-org',project:'Fixture Project',repositoryName:'fixture-repo',baseBranch:'HEAD',botIds:[app.store.state.bots[0].id],checks:[]});
  return {app,url,request,directory,home,repo,discovery,project};
}

test('local coding routes require workspace authentication, exact CSRF and same-origin requests',async t=>{
  const f=await fixture(t);f.discovery.length=0;
  assert.equal((await f.request('/api/local-coding',{authenticated:false})).status,401);
  assert.equal((await f.request('/api/local-coding/discover',{method:'POST',authenticated:false,data:{includeClaudeProjects:true}})).status,401);
  const missing=await f.request('/api/local-coding/discover',{method:'POST',csrfToken:false,data:{includeClaudeProjects:true}});assert.equal(missing.status,403);assert.equal(missing.body.code,'csrf_mismatch');
  assert.equal((await f.request('/api/local-coding/discover',{method:'POST',headers:{'X-CSRF-Token':'incorrect'},data:{includeClaudeProjects:true}})).status,403);
  assert.equal((await f.request('/api/local-coding/discover',{method:'POST',headers:{Origin:'https://unrelated.example'},data:{includeClaudeProjects:true}})).status,403);
  assert.equal((await f.request('/api/local-coding/agents/claude',{method:'PUT',csrfToken:false,data:{executable:process.execPath,account:'existing'}})).status,403);
  assert.equal((await f.request('/api/local-coding/projects',{method:'POST',csrfToken:false,data:f.project()})).status,403);
  assert.equal(f.discovery.length,0);assert.deepEqual(f.app.runtime.localCoding.data.projects,[]);assert.deepEqual(f.app.runtime.localCoding.data.agents,{});
});

test('local owner metadata does not discover project locations until an explicit authenticated action',async t=>{
  const f=await fixture(t);f.discovery.length=0;
  const metadata=await f.request('/api/local-coding');assert.equal(metadata.status,200);assert.equal(metadata.body.available,true);assert.equal(metadata.body.agents.length,2);assert.deepEqual(metadata.body.projects,[]);assert.deepEqual(metadata.body.jobs,[]);
  assert.equal(f.discovery.length,1);assert.deepEqual(f.discovery[0].roots,[]);assert.equal(f.discovery[0].includeClaudeProjects,false);assert.equal(f.discovery[0].home,f.home);
  const found=await f.request('/api/local-coding/discover',{method:'POST',headers:{Origin:f.url},data:{includeClaudeProjects:true}});assert.equal(found.status,200);assert.equal(found.body.projects[0].path,f.repo);assert.equal(found.body.projects[0].source,'claude');assert.equal(f.discovery.at(-1).includeClaudeProjects,true);
  assert.deepEqual(f.app.runtime.localCoding.data.projects,[],'discovery must not grant a project connection');
});

test('trusted proxy forwarded clients cannot manage local coding through a loopback connection',async t=>{
  const f=await fixture(t);await f.app.access.setPublicPassword(true);f.discovery.length=0;
  for(const address of ['10.20.30.40','198.51.100.42','127.0.0.1, 10.20.30.40','invalid-address']){
    const headers={'X-Forwarded-For':address},metadata=await f.request('/api/local-coding',{headers});assert.equal(metadata.status,200,address);assert.deepEqual(metadata.body,{available:false,agents:[],projects:[],jobs:[]});
    const denied=await f.request('/api/local-coding/discover',{method:'POST',headers,data:{includeClaudeProjects:true}});assert.equal(denied.status,403,address);assert.match(denied.body.error,/only.*this Mac/i);
    assert.equal((await f.request('/api/local-coding/agents/claude',{method:'PUT',headers,data:{executable:process.execPath,account:'existing'}})).status,403,address);
    assert.equal((await f.request('/api/local-coding/projects',{method:'POST',headers,data:f.project()})).status,403,address);
  }
  assert.equal(f.discovery.length,0);assert.deepEqual(f.app.runtime.localCoding.data.projects,[]);assert.deepEqual(f.app.runtime.localCoding.data.agents,{});
});

test('untrusted forwarded headers do not override a direct local connection',async t=>{
  const f=await fixture(t,{trustProxy:'none'});const result=await f.request('/api/local-coding',{headers:{'X-Forwarded-For':'198.51.100.42'}});assert.equal(result.status,200);assert.equal(result.body.available,true);
});

test('invalid local coding routes and configurations fail without saving changes or searching',async t=>{
  const f=await fixture(t);f.discovery.length=0;
  for(const route of ['/api/local-coding/unknown','/api/local-coding/discover','/api/local-coding/projects/unknown/work-items'])assert.equal((await f.request(route)).status,404,route);
  for(const data of [{includeClaudeProjects:'yes'},{includeClaudeProjects:true,roots:['/unapproved']},{agentPaths:{claude:[process.execPath]}}])assert.equal((await f.request('/api/local-coding/discover',{method:'POST',data})).status,400);
  assert.equal((await f.request('/api/local-coding/discover',{method:'POST',data:{extra:'x'.repeat(2000)}})).status,413);
  for(const data of [{executable:'node',account:'existing'},{executable:process.execPath,account:'borrow-anything'},{executable:process.execPath,account:'existing',token:'unaccepted-field'}])assert.equal((await f.request('/api/local-coding/agents/claude',{method:'PUT',data})).status,400);
  for(const data of [{...f.project(),botIds:[]},{...f.project(),botIds:['missing-bot']},{...f.project(),path:'relative/path'},{...f.project(),organization:'https://evil.example'},{...f.project(),unexpected:true}])assert.equal((await f.request('/api/local-coding/projects',{method:'POST',data})).status,400);
  assert.equal(f.discovery.length,0);assert.deepEqual(f.app.runtime.localCoding.data.projects,[]);assert.deepEqual(f.app.runtime.localCoding.data.agents,{});
});

test('non-Mac engines expose unavailable metadata and refuse discovery and connection writes',async t=>{
  const f=await fixture(t,{platform:'linux'});const status=await f.request('/api/local-coding');assert.equal(status.status,200);assert.deepEqual(status.body,{available:false,agents:[],projects:[],jobs:[]});
  for(const [route,method,data]of [['/api/local-coding/discover','POST',{includeClaudeProjects:true}],['/api/local-coding/agents/claude','PUT',{executable:process.execPath,account:'existing'}],['/api/local-coding/projects','POST',f.project()]]){const result=await f.request(route,{method,data});assert.equal(result.status,409);assert.match(result.body.error,/local Mac engine/);}
  assert.equal(f.discovery.length,0);await assert.rejects(fs.access(path.join(f.directory,'data','local-coding')));
});

test('coding tool permission is opt-in through ordinary bot PATCH and persists without extra tool grants',async t=>{
  const f=await fixture(t),bot=f.app.store.state.bots[0],selected=['workspace','coding'];assert.ok(!bot.tools.includes('coding'));
  const updated=await f.request(`/api/bots/${bot.id}`,{method:'PATCH',data:{tools:selected}});assert.equal(updated.status,200,JSON.stringify(updated.body));assert.deepEqual(updated.body.tools,selected);assert.deepEqual(f.app.store.state.bots.find(value=>value.id===bot.id).tools,selected);
  const saved=JSON.parse(await fs.readFile(f.app.store.file,'utf8'));assert.deepEqual(saved.bots.find(value=>value.id===bot.id).tools,selected);
  const metadata=await f.request('/api/state');assert.deepEqual(metadata.body.bots.find(value=>value.id===bot.id).tools,selected);
  assert.equal((await f.request(`/api/bots/${bot.id}`,{method:'PATCH',data:{tools:['workspace']}})).status,200);assert.deepEqual(f.app.store.state.bots.find(value=>value.id===bot.id).tools,['workspace']);
});

test('owner project setup retains inferred repository name and never returns its Azure credential',async t=>{
  const f=await fixture(t),token='synthetic-coding-api-token';const connected=await f.request('/api/local-coding/agents/claude',{method:'PUT',data:{executable:process.execPath,account:'existing'}});assert.equal(connected.status,200);assert.equal(connected.body.configured,true);assert.equal(connected.body.account,'existing');
  const created=await f.request('/api/local-coding/projects',{method:'POST',data:{...f.project(),token}});assert.equal(created.status,200,JSON.stringify(created.body));assert.equal(created.body.repositoryName,'fixture-repo');assert.equal(created.body.azureConfigured,true);assert.ok(!Object.hasOwn(created.body,'secret'));assert.ok(!JSON.stringify(created.body).includes(token));
  const metadata=await f.request('/api/local-coding');assert.equal(metadata.body.projects[0].id,created.body.id);assert.ok(!JSON.stringify(metadata.body).includes(token));assert.ok(!JSON.stringify(metadata.body).includes(f.app.runtime.localCoding.data.projects[0].secret));
  const disk=await fs.readFile(path.join(f.directory,'data','local-coding','config.json'),'utf8');assert.ok(!disk.includes(token));assert.equal(f.app.store.unseal(JSON.parse(disk).projects[0].secret),token);
  assert.deepEqual((await f.request('/api/state')).body.integrations,[],'local coding credentials must not become a synced generic integration');
});
