import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { SkillsService } from '../lib/skills.mjs';
import { prepareSkillImport } from '../lib/skill-import.mjs';
import { proposeSkill } from '../lib/learning.mjs';
import { createStudioServer } from '../server.mjs';

const waitFor=async predicate=>{const until=Date.now()+6000;while(Date.now()<until){if(predicate())return predicate();await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Skill fixture timed out.');};
const call=(name,args)=>({id:`call-${name}`,name,arguments:args});
async function storeFixture(t,{cleanup=true}={}){const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-skills-engine-')),store=await new Store(directory).init();if(cleanup)t.after(()=>fs.rm(directory,{recursive:true,force:true}));return {store,directory};}
async function engineFixture(t,{policy='ask',strict=false}={}){
  const {store,directory}=await storeFixture(t,{cleanup:false}),skills=new SkillsService(store),entry=(await skills.search({botId:'bot_atlas'})).skills[0],requests=[];
  await store.mutate(state=>{state.connections.push({id:'provider_fixture',type:'openai',model:'fixture'});Object.assign(state.bots[0],{connectionId:'provider_fixture',skillInstallPolicy:policy,approvalPolicy:strict?'strict':'balanced'});});
  const engine=new NativeEngine(store,{skills,runTimeout:15000,providers:{async complete(connection,request){
    requests.push(request);const n=requests.length;
    if(n===1)return {text:'',toolCalls:[call('skills_search',{query:''})]};
    if(n===2)return {text:'',toolCalls:[call('skills_inspect',{catalogId:entry.catalogId})]};
    if(n===3)return {text:'',toolCalls:[call('skills_install',{catalogId:entry.catalogId,version:entry.version,digest:entry.digest})]};
    if(n===4){const output=JSON.parse(request.messages.filter(item=>item.role==='tool').at(-1).content);return output.skill?{text:'',toolCalls:[call('skills_read',{skillId:output.skill.id})]}:{text:'Installation was declined.',toolCalls:[]};}
    return {text:'Installed and read the verified skill.',toolCalls:[]};
  }}});await engine.recover();t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});return {store,directory,skills,entry,engine,requests};
}
const decision=run=>({runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation});

test('a bot discovers, installs and reads a trusted catalog skill in one run without expanding its tools',async t=>{
  const {store,engine,requests}=await engineFixture(t,{policy:'trusted'}),groups=[...store.state.bots[0].tools];
  await engine.start('bot_atlas','Find a reusable workflow and use it.');await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  assert.equal(requests.length,5);const run=store.state.runs.bot_atlas;
  assert.ok(!run.events.some(event=>event.type==='approval.request'));assert.equal(run.skillInstallCount,1);
  assert.deepEqual(store.state.bots[0].tools,groups);assert.deepEqual(store.state.bots[1].skills,[]);
  const toolMessages=store.state.conversations.bot_atlas.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content));
  assert.ok(toolMessages[2].skill.packageDigest);assert.equal(toolMessages[3].packageDigest,toolMessages[2].skill.packageDigest);
  assert.match(toolMessages[3].content,/^---/);assert.match(requests[4].turnContext,/Skills assigned during this task/);
});

test('ask policy gates an exact catalog version and denial leaves no skill or assignment',async t=>{
  const {store,engine}=await engineFixture(t);
  await engine.start('bot_atlas','Find and install a useful workflow.');await waitFor(()=>store.state.runs.bot_atlas?.status==='waiting_for_approval');
  const run=store.state.runs.bot_atlas;assert.equal(run.pending_controls[0].tool,'skills_install');
  const before=store.state.skills.length;
  await engine.control('bot_atlas','approval',{...decision(run),choice:'deny'});await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  assert.equal(store.state.skills.length,before);assert.deepEqual(store.state.bots[0].skills,[]);
});

test('Strict still requires approval with trusted installation enabled and approved installs continue the same run',async t=>{
  const {store,engine}=await engineFixture(t,{policy:'trusted',strict:true});
  await engine.start('bot_atlas','Use a skill.');await waitFor(()=>store.state.runs.bot_atlas?.status==='waiting_for_approval');
  const run=store.state.runs.bot_atlas,id=run.id;
  await engine.control('bot_atlas','approval',{...decision(run),choice:'once'});await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  assert.equal(store.state.runs.bot_atlas.id,id);assert.equal(store.state.bots[0].skills.length,1);
});

test('managed script packages execute verified local copies, retain script approval and reject Learning overwrite',async t=>{
  const {store}=await storeFixture(t),skills=new SkillsService(store),tools=new AgentTools(store,{skills});
  const [prepared]=(await prepareSkillImport({files:[
    {path:'SKILL.md',contentBase64:Buffer.from('---\nname: imported-runner\ndescription: Read a bundled fixture.\n---\nUse scripts/read.mjs.\n').toString('base64')},
    {path:'references/data.txt',contentBase64:Buffer.from('verified package bytes').toString('base64')},
    {path:'scripts/read.mjs',contentBase64:Buffer.from("import fs from 'node:fs'; console.log(fs.readFileSync('references/data.txt','utf8')); console.log(process.cwd());").toString('base64')}
  ]})).packages;
  const installed=await skills.installPrepared(prepared,{botId:'bot_atlas'}),bot=structuredClone(store.state.bots[0]);
  const args={skillId:installed.skill.id,path:'scripts/read.mjs',interpreter:'node',args:[]};
  await assert.rejects(tools.execute(bot,'skills_run',args),/approval/);
  const result=await tools.execute(bot,'skills_run',args,{approved:true});assert.equal(result.exitCode,0);assert.match(result.stdout,/verified package bytes/);assert.match(result.stdout,/process-homes/);assert.doesNotMatch(result.stdout,new RegExp(`/skills/${installed.skill.id}`));
  const read=await tools.execute(bot,'skills_read',{skillId:installed.skill.id});
  await assert.rejects(proposeSkill(store,{bot,runId:'unused',source:'chat',sessionId:bot.id},{skillId:installed.skill.id,expectedSha256:read.sha256,content:read.content+'Edited.',reason:'Customize.'}),/immutable/);
  await fs.writeFile(path.join(store.directory,'skills',installed.skill.id,'references/data.txt'),'tampered');
  await assert.rejects(tools.execute(bot,'skills_read',{skillId:installed.skill.id}),/incomplete or changed/);
  await assert.rejects(tools.execute(bot,'skills_run',args,{approved:true}),/incomplete or changed/);
});

test('synced metadata cannot activate a package until every resource is present and verified',async t=>{
  const source=await storeFixture(t),target=await storeFixture(t),skills=new SkillsService(source.store),entry=(await skills.search({botId:'bot_atlas'})).skills[0];
  const {skill}=await skills.install({...entry,botId:'bot_atlas'});
  await target.store.mutate(state=>{state.skills.push(structuredClone(skill));state.bots[0].skills=[skill.id];});
  const directory=path.join(target.directory,'skills',skill.id);await fs.mkdir(directory);
  await fs.copyFile(path.join(source.directory,'skills',skill.id,'SKILL.md'),path.join(directory,'SKILL.md'));
  const tools=new AgentTools(target.store);await assert.rejects(tools.execute(target.store.state.bots[0],'skills_read',{skillId:skill.id}),/not available/);
  for(const file of skill.files.filter(file=>file!=='SKILL.md')){await fs.mkdir(path.dirname(path.join(directory,file)),{recursive:true});await fs.copyFile(path.join(source.directory,'skills',skill.id,file),path.join(directory,file));}
  assert.equal((await tools.execute(target.store.state.bots[0],'skills_read',{skillId:skill.id})).packageDigest,skill.packageDigest);
});

async function apiFixture(t){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-skills-api-')),app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false}),{url}=await app.listen(0);let cookie='',csrf='';
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const request=async(route,{method='GET',data,security=true}={})=>{const response=await fetch(url+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...(security&&csrf?{'X-CSRF-Token':csrf}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json(),response};};
  const setup=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'fixture-skills-password'}});cookie=setup.response.headers.get('set-cookie').split(';')[0];csrf=setup.body.csrf;
  return {app,request};
}

test('catalog API installs exact versions, rejects CSRF and stale digests, and assigns only the selected bot',async t=>{
  const {app,request}=await apiFixture(t),entry=(await request('/api/skills/catalog?botId=bot_atlas')).body.skills[0];
  const args={catalogId:entry.catalogId,version:entry.version,digest:entry.digest,botId:'bot_atlas'};
  assert.equal((await request('/api/skills/install',{method:'POST',data:args,security:false})).status,403);
  assert.equal((await request('/api/skills/install',{method:'POST',data:{...args,digest:'0'.repeat(64)}})).status,409);
  const installed=await request('/api/skills/install',{method:'POST',data:args});assert.equal(installed.status,201,JSON.stringify(installed.body));
  assert.deepEqual(app.store.state.bots[0].skills,[installed.body.skill.id]);assert.deepEqual(app.store.state.bots[1].skills,[]);
  const second=await request('/api/skills/assign',{method:'POST',data:{skillId:installed.body.skill.id,botId:'bot_nova'}});assert.equal(second.status,200,JSON.stringify(second.body));
  assert.equal((await request('/api/bots/bot_atlas',{method:'PATCH',data:{skillInstallPolicy:'anything'}})).status,400);
  assert.equal((await request('/api/bots/bot_atlas',{method:'PATCH',data:{skillInstallPolicy:'trusted'}})).status,200);
  assert.equal((await request('/api/skills/assign',{method:'POST',data:{skillId:installed.body.skill.id,botId:'bot_atlas',enabled:false}})).status,200);
  assert.deepEqual(app.store.state.bots[0].skills,[]);assert.equal(app.store.state.bots[1].skills.length,1);
});

test('import API previews inert bytes, pins the selected bot, installs once and exports the original package',async t=>{
  const {app,request}=await apiFixture(t),content='---\nname: external-fixture\ndescription: An import fixture.\n---\nKeep these exact original bytes.\n';
  const preview=await request('/api/skills/import/preview',{method:'POST',data:{content,botId:'bot_atlas'}});assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.equal(app.store.state.skills.some(skill=>skill.name==='external-fixture'),false);
  const args={importId:preview.body.importId,key:preview.body.packages[0].key,botId:'bot_atlas'};
  assert.equal((await request('/api/skills/import',{method:'POST',data:{...args,botId:'bot_nova'}})).status,409);
  const result=await request('/api/skills/import',{method:'POST',data:args});assert.equal(result.status,201,JSON.stringify(result.body));
  assert.equal((await request('/api/skills/import',{method:'POST',data:args})).status,409);
  const exported=(await request(`/api/skills/${result.body.skill.id}/export`)).body;
  assert.equal(Buffer.from(exported.files[0].contentBase64,'base64').toString(),content);
  assert.equal((await request('/api/skills/import/preview',{method:'POST',data:{url:'https://127.0.0.1/SKILL.md',botId:'bot_atlas'}})).status,400);
});
