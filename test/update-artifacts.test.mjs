import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {Store} from '../lib/store.mjs';
import {inventory,packFiles,unpackFiles,signedManifest,verifyManifest,hashFile,encryptedBackup,decryptBackup,validateFiles} from '../lib/update-artifacts.mjs';
const keys=generateKeyPairSync('ed25519'),secret=keys.privateKey.export({type:'pkcs8',format:'pem'}),publicKey=keys.publicKey.export({type:'spki',format:'pem'});
async function fixture(t){const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'tupies-update-')));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
export function manifest(files){return {schema:1,product:'tupies-engine',id:'fixture-2',version:'0.5.1',sequence:2,channel:'beta',platform:process.platform,arch:process.arch,dataEpoch:'1',maintenanceProtocol:1,publishedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400_000).toISOString(),files,archive:{url:'https://updates.example/engine.gz',size:100,sha256:'a'.repeat(64)}};}
test('release signatures bind bytes, channel, platform, architecture, expiry and data epoch',()=>{
 const files=[{path:'server.mjs',size:0,sha256:'a'.repeat(64),mode:0o644}],valid=manifest(files);
 assert.equal(verifyManifest(signedManifest(valid,secret),publicKey,{channel:'beta'}).id,valid.id);
 for(const patch of [{channel:'stable'},{platform:'foreign'},{arch:'foreign'},{sequence:0},{dataEpoch:'not-a-version'},{expiresAt:'2000-01-01'},{maintenanceProtocol:2}])assert.throws(()=>verifyManifest(signedManifest({...valid,...patch},secret),publicKey,{channel:'beta'}));
 const envelope=signedManifest(valid,secret);envelope.payload=Buffer.from(JSON.stringify({...valid,sequence:999})).toString('base64');assert.throws(()=>verifyManifest(envelope,publicKey,{channel:'beta'}),/signature/);
 assert.throws(()=>verifyManifest(signedManifest({...valid,archive:{...valid.archive,url:'http://updates.example/payload'}},secret),publicKey,{channel:'beta'}),/HTTPS/);
});
test('streamed bundles preserve file bytes and executable mode; refuse traversal, collisions, corruption and extra bytes',async t=>{
 const root=await fixture(t),source=path.join(root,'source');await fs.mkdir(source);await fs.mkdir(path.join(source,'lib'));await fs.writeFile(path.join(source,'server.mjs'),'server');await fs.writeFile(path.join(source,'lib','tool'),'executable',{mode:0o755});await fs.writeFile(path.join(source,'empty'),'');
 const files=await inventory(source),archive=path.join(root,'payload.gz');await packFiles(source,files,archive);const target=path.join(root,'target');await unpackFiles(archive,files,target);
 assert.equal(await fs.readFile(path.join(target,'lib/tool'),'utf8'),'executable');assert.equal((await fs.stat(path.join(target,'lib/tool'))).mode&0o777,0o755);
 for(const name of ['../outside','/absolute','lib/../../outside','a\\b','./file'])assert.throws(()=>validateFiles([{...files[0],path:name}]),/file/);
 assert.throws(()=>validateFiles([{...files[0],path:'lib'},{...files[0],path:'lib/x'}]),/collision/);
 await assert.rejects(unpackFiles(archive,files.map((file,i)=>i===0?{...file,sha256:'0'.repeat(64)}:file),path.join(root,'bad')),/checksum/);
 await assert.rejects(unpackFiles(archive,files.slice(0,-1),path.join(root,'extra')),/trailing/);
 await fs.writeFile(path.join(source,'server.mjs'),'changed');await assert.rejects(packFiles(source,files,path.join(root,'changed.gz')),/changed/);
});
test('encrypted stopped backup authenticates and restores complete data, sealed credentials and empty directories',async t=>{
 const root=await fixture(t),data=path.join(root,'data'),backups=path.join(root,'backups'),keyFile=path.join(root,'backup.key');await fs.mkdir(backups,{mode:0o700});await fs.writeFile(keyFile,randomBytes(32),{mode:0o600});const store=await new Store(data).init();await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',secret:store.seal('synthetic-secret')});});await fs.mkdir(path.join(data,'workspaces','empty'),{recursive:true});await fs.writeFile(path.join(data,'workspaces','file.txt'),'synthetic workspace');
 const backup=await encryptedBackup({dataDir:data,backupDir:backups,keyFile});assert.equal(backup.verified,true);const target=path.join(root,'verification'),restored=path.join(root,'restored');await decryptBackup({source:backup.file,keyFile,target,restoreTarget:restored});
 assert.equal(await hashFile(path.join(restored,'state.json')),await hashFile(path.join(data,'state.json')));assert.equal(await hashFile(path.join(restored,'vault.key')),await hashFile(path.join(data,'vault.key')));assert.ok((await fs.stat(path.join(restored,'workspaces','empty'))).isDirectory());assert.equal((await fs.readdir(backups)).length,1);
 const changed=await fs.readFile(backup.file);changed[30]^=1;const corrupt=path.join(root,'corrupt');await fs.writeFile(corrupt,changed);await assert.rejects(decryptBackup({source:corrupt,keyFile,target:path.join(root,'bad-verify')}));await assert.rejects(fs.stat(path.join(root,'bad-verify','snapshot')),{code:'ENOENT'});
});
test('dependency executable links retain relative semantics and cannot escape the signed tree',async t=>{
 const root=await fixture(t),source=path.join(root,'source');await fs.mkdir(path.join(source,'node_modules/.bin'),{recursive:true});await fs.mkdir(path.join(source,'node_modules/tool'));await fs.writeFile(path.join(source,'node_modules/tool/cli'),'#!/usr/bin/env node\n',{mode:0o755});await fs.symlink('../tool/cli',path.join(source,'node_modules/.bin/tool'));
 const files=await inventory(source,{dependencies:true}),archive=path.join(root,'links.gz');await packFiles(source,files,archive);const target=path.join(root,'restored');await unpackFiles(archive,files,target);assert.equal(await fs.readlink(path.join(target,'node_modules/.bin/tool')),'../tool/cli');assert.equal(await fs.readFile(path.join(target,'node_modules/.bin/tool'),'utf8'),'#!/usr/bin/env node\n');
 const link=files.find(file=>file.link);assert.throws(()=>validateFiles([{...link,link:'../../../outside'}]),/Unsafe/);await fs.symlink('/etc/passwd',path.join(source,'node_modules/leak'));await assert.rejects(inventory(source,{dependencies:true}),/escapes/);
});
