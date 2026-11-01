import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { inspectWorkspaceLayout, ensureWorkspaceLayout, WORKSPACE_FOLDERS } from '../lib/workspace-layout.mjs';
import { Store } from '../lib/store.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';

async function fixture(t) {
  const parent=await fs.mkdtemp(path.join(tmpdir(),'tupies-workspace-layout-')),root=path.join(parent,'workspace');
  await fs.mkdir(root,{mode:0o750});
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  return {parent,root};
}

test('layout inspection is read-only and exposes core Memory as a collection',async t=>{
  const {root}=await fixture(t),before=await fs.stat(root),result=await inspectWorkspaceLayout(root);
  assert.equal(result.version,1);
  assert.deepEqual(result.folders.map(folder=>folder.path),['brain','notes','scripts','projects','documents','data','outputs','uploads','.tmp']);
  assert.ok(result.folders.every(folder=>folder.status==='missing' && folder.label && folder.description));
  assert.deepEqual(result.memory,{kind:'collection',label:'Memory'});
  assert.equal(result.folders.find(folder=>folder.path==='.tmp').hidden,true);
  assert.deepEqual(await fs.readdir(root),[]);
  assert.equal((await fs.stat(root)).mtimeMs,before.mtimeMs);
});

test('initialization creates only private empty folders and is idempotent',async t=>{
  const {root}=await fixture(t),rootMode=(await fs.stat(root)).mode&0o777,first=await ensureWorkspaceLayout(root);
  assert.deepEqual(first.created,WORKSPACE_FOLDERS.map(folder=>folder.path));
  assert.ok(first.folders.every(folder=>folder.status==='ready'));
  for(const folder of first.folders){assert.deepEqual(await fs.readdir(path.join(root,folder.path)),[]);assert.equal((await fs.stat(path.join(root,folder.path))).mode&0o077,0);}
  const file=path.join(root,'notes','owner-note.md');await fs.writeFile(file,'Keep the owner’s existing note.');
  await fs.chmod(path.join(root,'notes'),0o750);
  const before=await fs.stat(file),second=await ensureWorkspaceLayout(root);
  assert.deepEqual(second.created,[]);
  assert.equal(await fs.readFile(file,'utf8'),'Keep the owner’s existing note.');
  assert.equal((await fs.stat(file)).mtimeMs,before.mtimeMs);
  assert.equal((await fs.stat(path.join(root,'notes'))).mode&0o777,0o750);
  assert.equal((await fs.stat(root)).mode&0o777,rootMode);
  assert.ok(!(await fs.readdir(root)).includes('memory'));
});

test('file collisions are blocked without deleting or relocating owner data',async t=>{
  const {root}=await fixture(t);await fs.writeFile(path.join(root,'scripts'),'Existing file, not a folder.');
  const inspected=await inspectWorkspaceLayout(root);assert.equal(inspected.folders.find(folder=>folder.path==='scripts').status,'blocked');
  const result=await ensureWorkspaceLayout(root);
  assert.equal(result.folders.find(folder=>folder.path==='scripts').status,'blocked');
  assert.ok(!result.created.includes('scripts'));
  assert.equal(await fs.readFile(path.join(root,'scripts'),'utf8'),'Existing file, not a folder.');
  assert.equal(result.created.length,8);
});

test('child directory and dangling symlinks stay blocked and are never followed',async t=>{
  const {parent,root}=await fixture(t),outside=path.join(parent,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'owner.txt'),'Do not touch.');
  await fs.symlink(outside,path.join(root,'documents'));
  await fs.symlink(path.join(parent,'missing-target'),path.join(root,'data'));
  const result=await ensureWorkspaceLayout(root);
  for(const name of ['documents','data']){assert.equal(result.folders.find(folder=>folder.path===name).status,'blocked');assert.ok(!result.created.includes(name));assert.equal((await fs.lstat(path.join(root,name))).isSymbolicLink(),true);}
  assert.deepEqual(await fs.readdir(outside),['owner.txt']);
  assert.equal(await fs.readFile(path.join(outside,'owner.txt'),'utf8'),'Do not touch.');
  await assert.rejects(fs.stat(path.join(parent,'missing-target')),error=>error.code==='ENOENT');
});

test('missing, symlinked and file roots fail without creating folders',async t=>{
  const {parent,root}=await fixture(t),missing=path.join(parent,'absent'),linked=path.join(parent,'linked'),file=path.join(parent,'file');
  await fs.symlink(root,linked);await fs.writeFile(file,'Owner file.');
  for(const inspect of [inspectWorkspaceLayout,ensureWorkspaceLayout]){
    await assert.rejects(inspect(missing),error=>error.status===404);
    for(const invalid of [linked,file])await assert.rejects(inspect(invalid),/real directory/);
    for(const invalid of ['',null,'relative/workspace'])await assert.rejects(inspect(invalid),/absolute private workspace path/);
  }
  assert.deepEqual(await fs.readdir(root),[]);await assert.rejects(fs.stat(missing),error=>error.code==='ENOENT');
  assert.equal(await fs.readFile(file,'utf8'),'Owner file.');
});

test('workspace lookup does not silently initialize an existing bot layout',async t=>{
  const {parent}=await fixture(t),store=await new Store(path.join(parent,'runtime')).init();
  t.after(()=>store.queue);
  const root=await getWorkspaceRoot(store,store.state.bots[0].id);
  assert.deepEqual(await fs.readdir(root),[]);
  await inspectWorkspaceLayout(root);
  await getWorkspaceRoot(store,store.state.bots[0].id);
  assert.deepEqual(await fs.readdir(root),[]);
});
