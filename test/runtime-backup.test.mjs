import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {Store} from '../lib/store.mjs';
import {controlSocketPath} from '../lib/control.mjs';
import {createRuntimeSnapshot,inspectRuntimeSnapshot,restoreRuntimeSnapshot} from '../lib/runtime-backup.mjs';
import {keyId,generateIdentity} from '../lib/sync/crypto.mjs';

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tb-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const source=path.join(directory,'runtime'),snapshot=path.join(directory,'snapshot'),target=path.join(directory,'restore'),store=await new Store(source).init();
  await store.mutate(state=>{
    state.connections.push({id:'fixture-provider',type:'openai',secret:store.seal('disposable-provider-token'),oauthSecret:store.seal(JSON.stringify({access_token:'disposable-oauth-token'}))});
    state.memory.bot_atlas=[{id:'memory_fixture',key:'Fixture',value:'Keep this memory.'}];
    state.messages.bot_atlas=[{id:'message_fixture',role:'user',content:'Keep this transcript.'}];
  });
  for(const name of ['sync','workspaces/bot_atlas/notes','skills/private-skill','process-homes/bot_atlas/.config'])await fs.mkdir(path.join(source,name),{recursive:true,mode:0o700});
  const identity=generateIdentity();await fs.writeFile(path.join(source,'sync/identity.json'),JSON.stringify({nodeId:'node_fixture',publicKey:identity.publicKey,privateKey:store.seal(identity.privateKey)}));
  await fs.writeFile(path.join(source,'sync/workspace.key'),Buffer.alloc(32,12));
  await fs.writeFile(path.join(source,'sync/config.json'),JSON.stringify({hub:null}));
  await fs.writeFile(path.join(source,'notifications.json'),JSON.stringify({subscriptions:{device_fixture:{secret:store.seal('disposable-apns-token')}}}));
  await fs.writeFile(path.join(source,'workspaces/bot_atlas/notes/daily.md'),'# Private fixture note\n');
  await fs.writeFile(path.join(source,'workspaces/bot_atlas/fixture.bin'),Buffer.from([0,1,127,255]));
  await fs.writeFile(path.join(source,'skills/private-skill/SKILL.md'),'---\nname: private-skill\ndescription: Fixture\n---\n');
  await fs.writeFile(path.join(source,'process-homes/bot_atlas/.config/tool-state'),'disposable-tool-state');
  return {directory,source,snapshot,target,store};
}

test('offline backup and restore preserve complete runtime bytes, sealed credentials and private modes',async t=>{
  const {source,snapshot,target,store}=await fixture(t),state=await fs.readFile(store.file),key=await fs.readFile(path.join(source,'vault.key'));
  const result=await createRuntimeSnapshot({source,target:snapshot});assert.equal(result.files,16);
  const inspection=await inspectRuntimeSnapshot({source:snapshot});assert.equal(inspection.summary.files,result.files);
  const restored=await restoreRuntimeSnapshot({source:snapshot,target});assert.deepEqual(restored,result);
  assert.deepEqual(await fs.readFile(path.join(target,'state.json')),state);assert.deepEqual(await fs.readFile(path.join(target,'vault.key')),key);
  const recovered=await new Store(target).init();assert.equal(recovered.unseal(recovered.state.connections[0].secret),'disposable-provider-token');
  assert.equal(recovered.state.messages.bot_atlas[0].content,'Keep this transcript.');
  assert.equal(await fs.readFile(path.join(target,'process-homes/bot_atlas/.config/tool-state'),'utf8'),'disposable-tool-state');
  for(const file of inspection.contents.files){const stat=await fs.stat(path.join(target,file.path));assert.equal(stat.mode&0o077,0);}
  assert.equal((await fs.stat(target)).mode&0o777,0o700);
  assert.deepEqual(await fs.readFile(store.file),state,'Backing up never initializes or changes the source.');
});

test('restore refuses modified, missing and added files without creating a destination',async t=>{
  const {source,snapshot,target}=await fixture(t);await createRuntimeSnapshot({source,target:snapshot});
  await fs.appendFile(path.join(snapshot,'data/workspaces/bot_atlas/fixture.bin'),'changed');
  await assert.rejects(restoreRuntimeSnapshot({source:snapshot,target}),/manifest/);
  await assert.rejects(fs.stat(target),error=>error.code==='ENOENT');
  await fs.writeFile(path.join(snapshot,'data/workspaces/bot_atlas/fixture.bin'),Buffer.from([0,1,127,255]));
  await fs.writeFile(path.join(snapshot,'data/extra-file'),'added');await assert.rejects(inspectRuntimeSnapshot({source:snapshot}),/manifest/);
  await fs.rm(path.join(snapshot,'data/extra-file'));await fs.rm(path.join(snapshot,'data/vault.key'));await assert.rejects(inspectRuntimeSnapshot({source:snapshot}),/manifest/);
});

test('snapshot paths cannot overlap, replace a directory or follow runtime symlinks',async t=>{
  const {directory,source,snapshot,target}=await fixture(t);
  await assert.rejects(createRuntimeSnapshot({source,target:path.join(source,'backup')}),/separate/);
  await fs.mkdir(target);await fs.writeFile(path.join(target,'keep'),'owner file');
  await assert.rejects(createRuntimeSnapshot({source,target}),/already exists/);assert.equal(await fs.readFile(path.join(target,'keep'),'utf8'),'owner file');
  await fs.symlink(path.join(directory,'outside'),path.join(source,'workspaces/bot_atlas/link'));
  await assert.rejects(createRuntimeSnapshot({source,target:snapshot}),/symlinks/);await assert.rejects(fs.stat(snapshot),error=>error.code==='ENOENT');
});

test('a live engine control socket refuses backup and file limits are enforced',async t=>{
  const {source,snapshot}=await fixture(t),file=controlSocketPath(source),server=net.createServer(socket=>socket.end());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(file,resolve);});
  try{await assert.rejects(createRuntimeSnapshot({source,target:snapshot}),/Stop the engine/);}finally{await new Promise(resolve=>server.close(resolve));}
  await assert.rejects(createRuntimeSnapshot({source,target:snapshot,maxBytes:1}),/limit/);await assert.rejects(fs.stat(snapshot),error=>error.code==='ENOENT');
});

test('a live hashed control socket is checked using the configured runtime spelling',async t=>{
  const fixture_=await fixture(t),source=path.join(fixture_.directory,'long-runtime-directory-name-that-requires-a-hashed-unix-control-socket');
  await fs.rename(fixture_.source,source);const file=controlSocketPath(source),server=net.createServer(socket=>socket.end());
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(file,resolve);});
  try{await assert.rejects(createRuntimeSnapshot({source,target:fixture_.snapshot}),/Stop the engine/);}finally{await new Promise(resolve=>server.close(resolve));}
});

test('invalid snapshot manifests cannot select outside files and a missing key is never repaired by backup',async t=>{
  const {source,snapshot,target,store}=await fixture(t);await createRuntimeSnapshot({source,target:snapshot});
  const manifest=JSON.parse(await fs.readFile(path.join(snapshot,'manifest.json'),'utf8'));manifest.files[0].path='../outside';
  await fs.writeFile(path.join(snapshot,'manifest.json'),JSON.stringify(manifest));await assert.rejects(restoreRuntimeSnapshot({source:snapshot,target}),/manifest/);
  await fs.rm(path.join(source,'vault.key'));await assert.rejects(createRuntimeSnapshot({source,target:path.join(path.dirname(snapshot),'second')}),error=>error.code==='ENOENT');
  await assert.rejects(fs.stat(path.join(source,'vault.key')),error=>error.code==='ENOENT');assert.ok(await fs.stat(store.file));
});

test('canonical security journals are verified read-only even when their compatibility mirror is missing or stale',async t=>{
  const {directory,source,snapshot,store}=await fixture(t),key=Buffer.alloc(32,19),journal={v:2,workspaceId:'fixture_workspace_0001',epoch:3,keyId:keyId(key),key:store.seal(key.toString('base64')),grants:{},revoked:{}};
  const identityFile=path.join(source,'sync/identity.json'),identity=JSON.parse(await fs.readFile(identityFile,'utf8'));identity.securityProtocol=2;await fs.writeFile(identityFile,JSON.stringify(identity));
  await fs.writeFile(path.join(source,'sync/security.json'),JSON.stringify(journal));await fs.rm(path.join(source,'sync/workspace.key'));
  await createRuntimeSnapshot({source,target:snapshot});await inspectRuntimeSnapshot({source:snapshot});
  await assert.rejects(fs.stat(path.join(source,'sync/workspace.key')),error=>error.code==='ENOENT','Validation must not repair the source.');
  await fs.writeFile(path.join(source,'sync/workspace.key'),Buffer.alloc(32,20));await createRuntimeSnapshot({source,target:path.join(directory,'stale-mirror')});
  journal.key=store.seal(Buffer.alloc(32,21).toString('base64'));await fs.writeFile(path.join(source,'sync/security.json'),JSON.stringify(journal));
  await assert.rejects(createRuntimeSnapshot({source,target:path.join(directory,'bad-journal')}),/sync security key is invalid/);
});

test('hash-valid snapshots cannot certify missing or mismatched engine identities',async t=>{
  const {directory,source,snapshot}=await fixture(t),identityFile=path.join(source,'sync/identity.json'),identity=JSON.parse(await fs.readFile(identityFile,'utf8'));
  identity.publicKey=generateIdentity().publicKey;await fs.writeFile(identityFile,JSON.stringify(identity));
  await assert.rejects(createRuntimeSnapshot({source,target:snapshot}),/key pair is invalid/);
  await fs.rm(identityFile);await assert.rejects(createRuntimeSnapshot({source,target:path.join(directory,'missing-identity')}),/identity is missing/);
});
