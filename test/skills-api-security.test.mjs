import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudioServer } from '../server.mjs';
import { skillPackageManifest } from '../lib/skill-catalog.mjs';

const password='fixture-skills-security-password';
const content='---\nname: remote-workflow\ndescription: A public import fixture.\n---\n\nReview available source material.\n';
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function waitFor(predicate){const deadline=Date.now()+6000;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Skill API fixture timed out.');}

async function fixture(t,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-skills-security-')),cleanups=[];let app;
  // Register before constructing or listening, so setup/listen failures also release the temporary runtime.
  t.after(async()=>{
    for(const cleanup of cleanups.reverse())await Promise.resolve().then(cleanup).catch(()=>{});
    if(app){app.runtime.starting.clear();await app.close();}
    await fs.rm(directory,{recursive:true,force:true});
  });
  app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,...options});const {url}=await app.listen(0,'127.0.0.1');
  function client(){
    let cookie='',csrf='';
    const request=async(route,{method='GET',data}={})=>{
      const response=await fetch(url+route,{method,signal:AbortSignal.timeout(12000),headers:{...(cookie?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});
      const result={status:response.status,body:await response.json()};
      if((route==='/api/setup' || route==='/api/login') && response.ok){cookie=response.headers.get('set-cookie').split(';')[0];csrf=result.body.csrf;}
      return result;
    };
    return {request,login:()=>request('/api/login',{method:'POST',data:{password}})};
  }
  const owner=client(),setup=await owner.request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password}});assert.equal(setup.status,201);
  const install=async(botId='bot_atlas')=>{const entry=(await app.skills.search({botId})).skills[0];return app.skills.install({catalogId:entry.catalogId,version:entry.version,digest:entry.digest,botId});};
  return {app,directory,owner,client,install,cleanups};
}

test('bot creation and PATCH cannot assign an incomplete managed package through legacy configuration fields',async t=>{
  const {app,directory,owner,install}=await fixture(t),{skill}=await install(),resource=skill.files.find(file=>file!=='SKILL.md'),location=path.join(directory,'skills',skill.id,resource),bytes=await fs.readFile(location),before=app.store.state.bots.length;
  await fs.rm(location);
  const patch=await owner.request('/api/bots/bot_scout',{method:'PATCH',data:{skills:[skill.id]}});assert.equal(patch.status,409,JSON.stringify(patch.body));assert.deepEqual(app.store.state.bots.find(bot=>bot.id==='bot_scout').skills,[]);
  const creation={name:'Skill fixture',title:'Fixture assistant',skills:[skill.id]};
  const rejected=await owner.request('/api/bots',{method:'POST',data:creation});assert.equal(rejected.status,409,JSON.stringify(rejected.body));assert.equal(app.store.state.bots.length,before);
  await fs.writeFile(location,bytes);
  assert.equal((await owner.request('/api/bots/bot_scout',{method:'PATCH',data:{skills:[skill.id]}})).status,200);
  assert.equal((await owner.request('/api/bots',{method:'POST',data:creation})).status,201);
});

test('bot configuration cannot activate two installed versions of the same catalog skill',async t=>{
  const {app,owner,install}=await fixture(t),first=(await install()).skill,entry=app.skills.catalog[0];
  entry.version='2.0.0';entry.content+='\nA revised fixture instruction.\n';entry.files[0].data=Buffer.from(entry.content);Object.assign(entry,skillPackageManifest(entry.files));
  const second=(await install('bot_nova')).skill;assert.notEqual(first.id,second.id);
  const skills=[first.id,second.id];
  const patch=await owner.request('/api/bots/bot_scout',{method:'PATCH',data:{skills}});assert.equal(patch.status,409,JSON.stringify(patch.body));assert.match(patch.body.error,/one version/);
  const creation=await owner.request('/api/bots',{method:'POST',data:{name:'Version fixture',title:'Fixture assistant',skills}});assert.equal(creation.status,409,JSON.stringify(creation.body));
  assert.equal((await owner.request('/api/bots/bot_scout',{method:'PATCH',data:{skills:[first.id]}})).status,200);
});

test('queued skill deletion rechecks task admission, active work and room reservation before touching files',async t=>{
  const {app,directory,owner,install,cleanups}=await fixture(t),{skill}=await install();
  for(const kind of ['starting','active','reserved'])await t.test(kind,async()=>{
    const release=deferred(),entered=deferred();cleanups.push(()=>release.resolve());
    const blocker=app.store.mutate(async state=>{
      entered.resolve();await release.promise;
      if(kind==='starting')app.runtime.starting.add('bot_atlas');
      if(kind==='active')state.runs.bot_atlas={id:'fixture-running',status:'running'};
      if(kind==='reserved')state.roomDrives.fixture={roomId:'fixture-room',status:'queued',botIds:['bot_atlas'],remaining:[]};
    });
    await entered.promise;const before=app.store.queue,pending=owner.request(`/api/skills/${skill.id}`,{method:'DELETE'});
    try {
      await waitFor(()=>app.store.queue!==before);release.resolve();await blocker;
      const result=await pending;assert.equal(result.status,409,JSON.stringify(result.body));
      assert.ok(app.store.state.skills.some(item=>item.id===skill.id));assert.ok((await fs.stat(path.join(directory,'skills',skill.id,'SKILL.md'))).isFile());
    } finally {
      release.resolve();await blocker.catch(()=>{});app.runtime.starting.delete('bot_atlas');
      await app.store.mutate(state=>{delete state.runs.bot_atlas;delete state.roomDrives.fixture;});
    }
  });
});

test('import preview reserves capacity before starting downloads and includes retained previews in its cap',async t=>{
  const gates=[];let downloads=0,open=false;
  const {app,owner,cleanups}=await fixture(t,{skillImportRequest:async()=>{downloads++;const gate=deferred();gates.push(gate);if(!open)await gate.promise;return {status:200,bytes:Buffer.from(content)};}});
  cleanups.push(()=>{open=true;for(const gate of gates)gate.resolve();});
  const requests=Array.from({length:4},(_,index)=>owner.request('/api/skills/import/preview',{method:'POST',data:{botId:'bot_atlas',url:`https://public.example/fixture-${index}/SKILL.md`}}));
  await waitFor(()=>downloads===4);
  const rejected=await owner.request('/api/skills/import/preview',{method:'POST',data:{botId:'bot_atlas',url:'https://public.example/fifth/SKILL.md'}});assert.equal(rejected.status,429);assert.equal(downloads,4);
  open=true;for(const gate of gates)gate.resolve();const previews=await Promise.all(requests);assert.ok(previews.every(result=>result.status===200),JSON.stringify(previews));
  assert.equal((await owner.request('/api/skills/import/preview',{method:'POST',data:{botId:'bot_atlas',content}})).status,429);
  const first=previews[0].body,installed=await owner.request('/api/skills/import',{method:'POST',data:{importId:first.importId,key:first.packages[0].key,botId:'bot_atlas'}});assert.equal(installed.status,201,JSON.stringify(installed.body));
  assert.equal((await owner.request('/api/skills/import/preview',{method:'POST',data:{botId:'bot_atlas',content}})).status,200);
  assert.equal(app.store.state.bots.find(bot=>bot.id==='bot_atlas').skills.length,1);
});

test('import previews belong to one session, and logout clears its retained slots',async t=>{
  const {app,owner,client}=await fixture(t),second=client();assert.equal((await second.login()).status,200);
  const preview=(await owner.request('/api/skills/import/preview',{method:'POST',data:{botId:'bot_atlas',content}})).body,args={importId:preview.importId,key:preview.packages[0].key,botId:'bot_atlas'};
  assert.equal((await second.request('/api/skills/import',{method:'POST',data:args})).status,409);assert.deepEqual(app.store.state.bots[0].skills,[]);
  for(let index=0;index<3;index++)assert.equal((await owner.request('/api/skills/import/preview',{method:'POST',data:{botId:'bot_atlas',content}})).status,200);
  assert.equal((await second.request('/api/skills/import/preview',{method:'POST',data:{botId:'bot_atlas',content}})).status,429);
  assert.equal((await owner.request('/api/logout',{method:'POST',data:{}})).status,200);
  assert.equal((await owner.request('/api/skills/import',{method:'POST',data:args})).status,401);
  assert.equal((await second.request('/api/skills/import',{method:'POST',data:args})).status,409);
  assert.equal((await second.request('/api/skills/import/preview',{method:'POST',data:{botId:'bot_atlas',content}})).status,200);
});

test('a download finishing after logout cannot create a retained import preview',async t=>{
  const gate=deferred();let downloads=0;
  const {app,owner,client,cleanups}=await fixture(t,{skillImportRequest:async()=>{downloads++;await gate.promise;return {status:200,bytes:Buffer.from(content)};}});cleanups.push(()=>gate.resolve());
  const pending=owner.request('/api/skills/import/preview',{method:'POST',data:{botId:'bot_atlas',url:'https://public.example/SKILL.md'}});await waitFor(()=>downloads===1);
  assert.equal((await owner.request('/api/logout',{method:'POST',data:{}})).status,200);gate.resolve();const result=await pending;assert.equal(result.status,401,JSON.stringify(result.body));
  const next=client();assert.equal((await next.login()).status,200);
  for(let index=0;index<4;index++)assert.equal((await next.request('/api/skills/import/preview',{method:'POST',data:{botId:'bot_atlas',content}})).status,200);
  assert.equal(app.store.state.skills.some(skill=>skill.name==='remote-workflow'),false);
});
