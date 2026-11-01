import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStudioServer } from '../server.mjs';
import { WORKSPACE_FOLDERS } from '../lib/workspace-layout.mjs';

const BOT='bot_atlas',SCRIPT='api-fixture';
const password='scripts-api-disposable-fixture-password';
const sha=value=>createHash('sha256').update(value).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
async function until(predicate){const deadline=Date.now()+8000;while(Date.now()<deadline){if(await predicate())return;await delay(5);}throw new Error('Script API fixture timed out.');}
async function absent(file){return fs.lstat(file).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;});}

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-scripts-api-'));let app,cookie='',csrf='';
  t.after(async()=>{if(app){app.runtime.starting.clear();app.runtime.compactions.clear();await app.close();}await fs.rm(directory,{recursive:true,force:true});});
  app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers:{async complete(){throw new Error('An owner catalog request must not invoke a model.');}}});
  const {url}=await app.listen(0,'127.0.0.1');
  async function request(route,{method='GET',data,authenticated=true,security=true,headers={}}={}) {
    const response=await fetch(url+route,{method,signal:AbortSignal.timeout(12000),headers:{...(authenticated&&cookie?{Cookie:cookie}:{}),...(security&&csrf?{'X-CSRF-Token':csrf}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});
    const result={status:response.status,body:await response.json(),headers:response.headers};
    if(route==='/api/setup'&&response.ok){cookie=response.headers.get('set-cookie').split(';')[0];csrf=result.body.csrf;}
    return result;
  }
  assert.equal((await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password}})).status,201);
  const root=path.join(directory,'workspaces',BOT);
  return {app,directory,root,request};
}

async function packageFiles(h) {
  const code='import fs from "node:fs";fs.writeFileSync("unexpected-api-execution","must never execute from a catalog route");\n';
  const readme='# API fixture\n\nPurpose: exercise descriptive registration. Inputs: none. Outputs: a forbidden execution marker if mistakenly run.\n';
  for(const [relative,content] of [['main.mjs',code],['README.md',readme]])assert.equal((await h.request(`/api/bots/${BOT}/files`,{method:'PUT',data:{path:`scripts/${SCRIPT}/${relative}`,content}})).status,200);
  return {id:SCRIPT,title:'API fixture program',purpose:'Exercise descriptive owner registration without executing source.',interpreter:'node',entrypoint:'main.mjs',files:[{path:'main.mjs',sha256:sha(code)},{path:'README.md',sha256:sha(readme)}],inputs:[],outputs:[],dependencies:[]};
}

test('workspace and script owner routes retain authentication, CSRF and origin checks without exposing a run endpoint',async t=>{
  const h=await fixture(t),base=`/api/bots/${BOT}`;
  for(const route of [`${base}/workspace`,`${base}/scripts`,`${base}/scripts/${SCRIPT}`])assert.equal((await h.request(route,{authenticated:false})).status,401);
  for(const [route,method] of [[`${base}/workspace`,'POST'],[`${base}/scripts`,'PUT']]) {
    assert.equal((await h.request(route,{method,data:{},authenticated:false})).status,401);
    assert.equal((await h.request(route,{method,data:{},security:false})).status,403);
    assert.equal((await h.request(route,{method,data:{},headers:{Origin:'https://untrusted.example'}})).status,403);
  }
  const registration=await packageFiles(h);
  assert.equal((await h.request(`${base}/scripts`,{method:'PUT',data:registration})).status,200);
  for(const route of [`${base}/scripts`,`${base}/scripts/${SCRIPT}`,`${base}/scripts/run`])assert.equal((await h.request(route,{method:'POST',data:{scriptId:SCRIPT,args:[]}})).status,405);
  assert.equal((await h.request(`${base}/scripts/${SCRIPT}/run`,{method:'POST',data:{}})).status,404);
  assert.equal(await absent(path.join(h.root,'unexpected-api-execution')),true);
  assert.equal(h.app.runtime.backgroundProcesses.entries.size,0);assert.equal(h.app.store.state.runs[BOT],undefined);
});

test('owner layout and script inspection do not populate missing child folders or alter an existing workspace',async t=>{
  const h=await fixture(t);await fs.mkdir(h.root,{recursive:true,mode:0o700});await fs.writeFile(path.join(h.root,'owner-note.txt'),'preserved owner draft');
  const before=await fs.readdir(h.root),layout=await h.request(`/api/bots/${BOT}/workspace`),scripts=await h.request(`/api/bots/${BOT}/scripts`);
  assert.equal(layout.status,200);assert.ok(layout.body.folders.every(folder=>folder.status==='missing'));assert.equal(layout.body.memory.kind,'collection');assert.deepEqual(scripts.body.scripts,[]);
  assert.equal((await h.request(`/api/bots/${BOT}/scripts/${SCRIPT}`)).status,404);
  assert.deepEqual(await fs.readdir(h.root),before);assert.equal(await fs.readFile(path.join(h.root,'owner-note.txt'),'utf8'),'preserved owner draft');
  assert.equal(h.app.store.state.activity.some(item=>item.type==='workspace.organized'),false);
});

test('creating a native bot initializes private standard folders without granting Terminal or changing existing bots',async t=>{
  const h=await fixture(t),before=structuredClone(h.app.store.state.bots);
  const created=await h.request('/api/bots',{method:'POST',data:{name:'Filesystem fixture',title:'Disposable owner-created bot'}});
  assert.equal(created.status,201,JSON.stringify(created.body));assert.equal(created.body.tools.includes('terminal'),false);
  assert.deepEqual(h.app.store.state.bots.filter(bot=>bot.id!==created.body.id),before);
  const root=path.join(h.directory,'workspaces',created.body.id),entries=await fs.readdir(root);
  assert.deepEqual(entries.sort(),WORKSPACE_FOLDERS.map(folder=>folder.path).sort());
  for(const folder of WORKSPACE_FOLDERS){const stat=await fs.lstat(path.join(root,folder.path));assert.equal(stat.isDirectory(),true);assert.equal(stat.isSymbolicLink(),false);assert.equal(stat.mode&0o077,0);}
  const layout=await h.request(`/api/bots/${created.body.id}/workspace`);assert.ok(layout.body.folders.every(folder=>folder.status==='ready'));
});

test('explicit layout initialization preserves collisions, symlinks, owner files and existing permissions',async t=>{
  const h=await fixture(t),outside=path.join(h.directory,'outside');await fs.mkdir(h.root,{recursive:true,mode:0o700});await fs.mkdir(outside);await fs.writeFile(path.join(outside,'untouched'),'outside original');
  await fs.writeFile(path.join(h.root,'notes'),'existing notes file');await fs.symlink(outside,path.join(h.root,'scripts'));await fs.mkdir(path.join(h.root,'documents'),{mode:0o750});await fs.writeFile(path.join(h.root,'documents','original.txt'),'original document');
  const notesBefore=await fs.lstat(path.join(h.root,'notes')),documentsBefore=await fs.stat(path.join(h.root,'documents'));
  assert.equal((await h.request(`/api/bots/${BOT}/workspace`,{method:'POST',data:{force:true}})).status,400);
  const initialized=await h.request(`/api/bots/${BOT}/workspace`,{method:'POST',data:{}});assert.equal(initialized.status,200);
  const statuses=Object.fromEntries(initialized.body.folders.map(folder=>[folder.path,folder.status]));assert.equal(statuses.notes,'blocked');assert.equal(statuses.scripts,'blocked');assert.equal(statuses.documents,'ready');
  assert.equal(await fs.readFile(path.join(h.root,'notes'),'utf8'),'existing notes file');assert.equal((await fs.lstat(path.join(h.root,'notes'))).ino,notesBefore.ino);assert.equal((await fs.stat(path.join(h.root,'documents'))).mode,documentsBefore.mode);
  assert.equal(await fs.readlink(path.join(h.root,'scripts')),outside);assert.equal(await fs.readFile(path.join(outside,'untouched'),'utf8'),'outside original');assert.equal(await fs.readFile(path.join(h.root,'documents','original.txt'),'utf8'),'original document');
  const repeated=await h.request(`/api/bots/${BOT}/workspace`,{method:'POST',data:{}});assert.deepEqual(repeated.body.created,[]);
});

test('owner script registration validates source hashes and catalog CAS while inspection reports source changes',async t=>{
  const h=await fixture(t),input=await packageFiles(h),route=`/api/bots/${BOT}/scripts`,registered=await h.request(route,{method:'PUT',data:input});
  assert.equal(registered.status,200,JSON.stringify(registered.body));const first=registered.body.script;
  assert.equal(first.status,'registered');assert.match(first.digest,/^[a-f0-9]{64}$/);assert.equal((await h.request(`${route}/${SCRIPT}`)).body.purpose,input.purpose);assert.equal((await h.request(route)).body.scripts.length,1);
  const manifest=path.join(h.root,'scripts',SCRIPT,'script.json'),before=await fs.readFile(manifest);
  assert.equal((await h.request(route,{method:'PUT',data:{...input,title:'Unreviewed replacement'}})).status,409);
  assert.equal((await h.request(route,{method:'PUT',data:{...input,expectedManifestSha256:'0'.repeat(64)}})).status,409);
  assert.deepEqual(await fs.readFile(manifest),before);
  const changed='process.stdout.write("a reviewed new version");\n';
  assert.equal((await h.request(`/api/bots/${BOT}/files`,{method:'PUT',data:{path:`scripts/${SCRIPT}/main.mjs`,content:changed}})).status,200);
  const inspected=await h.request(`${route}/${SCRIPT}`);assert.equal(inspected.body.status,'changed');assert.notEqual(inspected.body.digest,first.digest);
  assert.equal((await h.request(route,{method:'PUT',data:{...input,expectedManifestSha256:first.manifestSha256}})).status,409);assert.deepEqual(await fs.readFile(manifest),before);
  const updated={...input,files:input.files.map(file=>file.path==='main.mjs'?{...file,sha256:sha(changed)}:file),expectedManifestSha256:first.manifestSha256};
  const next=await h.request(route,{method:'PUT',data:updated});assert.equal(next.status,200,JSON.stringify(next.body));assert.equal(next.body.script.status,'registered');assert.notEqual(next.body.script.digest,first.digest);
  assert.equal((await h.request(route,{method:'PUT',data:{...updated,env:{KEY:'forbidden'},expectedManifestSha256:next.body.script.manifestSha256}})).status,400);
  assert.equal(h.app.runtime.backgroundProcesses.entries.size,0);assert.equal(await absent(path.join(h.root,'unexpected-api-execution')),true);
});

test('local admission, active tasks, compaction, rooms, routines and remote ownership block owner filesystem mutations',async t=>{
  const h=await fixture(t),input=await packageFiles(h),originalBusy=h.app.sync.busyElsewhere;
  for(const kind of ['starting','active','compacting','room','routine','remote'])await t.test(kind,async()=>{
    try {
      if(kind==='starting')h.app.runtime.starting.add(BOT);
      if(kind==='compacting')h.app.runtime.compactions.set(BOT,{});
      if(kind==='routine')h.app.runtime.routineAdmissions.set(BOT,{});
      if(kind==='remote')h.app.sync.busyElsewhere=id=>id===BOT?{name:'Other fixture engine'}:null;
      if(kind==='active')await h.app.store.mutate(state=>{state.runs[BOT]={id:'fixture-active',status:'running'};});
      if(kind==='room')await h.app.store.mutate(state=>{state.roomDrives.fixture={roomId:'fixture',status:'queued',botIds:[BOT],remaining:[]};});
      assert.equal((await h.request(`/api/bots/${BOT}/workspace`,{method:'POST',data:{}})).status,409);
      assert.equal((await h.request(`/api/bots/${BOT}/scripts`,{method:'PUT',data:input})).status,409);
      assert.equal((await h.request(`/api/bots/${BOT}/workspace`)).status,200);assert.equal((await h.request(`/api/bots/${BOT}/scripts`)).status,200);
      assert.equal(await absent(path.join(h.root,'scripts',SCRIPT,'script.json')),true);
    } finally {
      h.app.runtime.starting.delete(BOT);h.app.runtime.compactions.delete(BOT);h.app.runtime.routineAdmissions.delete(BOT);h.app.sync.busyElsewhere=originalBusy;
      await h.app.store.mutate(state=>{delete state.runs[BOT];delete state.roomDrives.fixture;});
    }
  });
});

test('a pending owner registration reserves task admission through the final audit commit and releases afterward',async t=>{
  const h=await fixture(t),input=await packageFiles(h),gate=deferred(),entered=deferred();
  await h.app.store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',defaultModel:'fixture-model'});state.bots[0].connectionId='fixture-provider';});
  const blocker=h.app.store.mutate(async()=>{entered.resolve();await gate.promise;});await entered.promise;
  let pending;
  try {
    pending=h.request(`/api/bots/${BOT}/scripts`,{method:'PUT',data:input});
    await until(()=>h.app.runtime.starting.has(BOT));
    await assert.rejects(h.app.runtime.start(BOT,'This task must not be admitted during owner registration.'),/active task/);
    assert.equal((await h.request(`/api/bots/${BOT}/workspace`,{method:'POST',data:{}})).status,409);
    assert.equal(h.app.store.state.runs[BOT],undefined);
    gate.resolve();await blocker;assert.equal((await pending).status,200);
    assert.equal(h.app.runtime.starting.has(BOT),false);
  } finally {gate.resolve();await blocker.catch(()=>{});if(pending)await pending.catch(()=>{});}
});
