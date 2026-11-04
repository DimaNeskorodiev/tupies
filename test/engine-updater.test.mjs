import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {Store} from '../lib/store.mjs';
import {runEngineUpdate,downloadUpdate,validateUpdateConfig} from '../lib/engine-updater.mjs';
import {inventory,packFiles,hashFile,signedManifest} from '../lib/update-artifacts.mjs';

async function fixture(t) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'tupies-updater-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const config={schema:1,channel:'beta',service:'tupies.service',feedURL:'https://updates.example/beta.json',artifactOrigins:['https://updates.example'],releasesDir:path.join(root,'releases'),currentLink:path.join(root,'current'),dataDir:path.join(root,'data'),backupDir:path.join(root,'backups'),backupKeyFile:path.join(root,'backup.key'),stateDir:path.join(root,'updates'),publicKeyFile:path.join(root,'public.pem'),holdFile:path.join(root,'updates/hold')};
 for(const directory of [config.releasesDir,config.backupDir,config.stateDir])await fs.mkdir(directory,{mode:0o700});await new Store(config.dataDir).init();await fs.writeFile(config.backupKeyFile,randomBytes(32),{mode:0o600});
 const keys=generateKeyPairSync('ed25519'),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'});await fs.writeFile(config.publicKeyFile,keys.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
 const old={id:'fixture-1',sequence:1,dataEpoch:'1',version:'0.5.0'},previous=path.join(config.releasesDir,old.id);await fs.mkdir(previous);await fs.writeFile(path.join(previous,'engine-release.json'),JSON.stringify(old));await fs.symlink(previous,config.currentLink);await fs.writeFile(path.join(config.stateDir,'accepted.json'),JSON.stringify(old));
 const source=path.join(root,'payload');await fs.mkdir(source);await fs.writeFile(path.join(source,'server.mjs'),'// synthetic release');const files=await inventory(source),archive=path.join(root,'payload.gz');await packFiles(source,files,archive);
 let release={schema:1,product:'tupies-engine',id:'fixture-2',version:'0.5.1',sequence:2,channel:'beta',platform:process.platform,arch:process.arch,dataEpoch:'1',maintenanceProtocol:1,publishedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400_000).toISOString(),files,archive:{url:'https://updates.example/engine.gz',size:(await fs.stat(archive)).size,sha256:await hashFile(archive)}};
 let busy=false,held=false,active=false,failStart=false;const calls=[];
 const fetcher=async url=>new Response(new URL(url).pathname==='/beta.json'?JSON.stringify(signedManifest(release,privateKey)):await fs.readFile(archive),{status:200});
 const control=async(data,command,token)=>{
  calls.push(command);
  if(command==='update-claim')return {protocol:1,ready:!busy,token:!busy?'exact-token':undefined};
  if(command==='update-release'){assert.equal(token,'exact-token');return {protocol:1};}
  if(command==='update-status')return {protocol:1,held,release:JSON.parse(await fs.readFile(path.join(config.currentLink,'engine-release.json'),'utf8'))};
  if(command==='update-activate'){assert.equal(held,true);active=true;held=false;return {protocol:1};}
  throw new Error('unexpected command');
 };
 const service=async action=>{calls.push(action);if(action==='start'){held=!!await fs.stat(config.holdFile).catch(()=>null);if(failStart && (await fs.realpath(config.currentLink)).endsWith('fixture-2'))throw new Error('synthetic start failure');}};
 return {root,config,calls,fetcher,service,control,setBusy:value=>busy=value,setFailStart:value=>failStart=value,patch:value=>release={...release,...value},active:()=>active,previous};
}
test('verified release stops once, checks encrypted backup, starts held and activates exact candidate',async t=>{
 const f=await fixture(t),before=await hashFile(path.join(f.config.dataDir,'vault.key'));const result=await runEngineUpdate(f.config,f);assert.equal(result.status,'updated');assert.equal(f.active(),true);assert.equal(await hashFile(path.join(f.config.dataDir,'vault.key')),before);assert.equal((await fs.readdir(f.config.backupDir)).length,1);assert.deepEqual(f.calls,['update-claim','stop','start','update-status','update-activate']);assert.ok(await fs.stat(path.join(f.config.stateDir,'receipt-2.json')));assert.equal((await runEngineUpdate(f.config,f)).status,'current');assert.equal(f.calls.length,5);
});
test('busy Engine defers without service action, backup or retained candidate',async t=>{
 const f=await fixture(t);f.setBusy(true);assert.equal((await runEngineUpdate(f.config,f)).status,'deferred');assert.deepEqual(f.calls,['update-claim']);assert.deepEqual(await fs.readdir(f.config.backupDir),[]);assert.equal(await fs.realpath(f.config.currentLink),f.previous);
});
test('candidate start failure rolls back code with CURRENT data; never restores old data',async t=>{
 const f=await fixture(t);f.setFailStart(true);await fs.writeFile(path.join(f.config.dataDir,'new-user-file'),'retained');await assert.rejects(runEngineUpdate(f.config,f),/synthetic start failure/);assert.equal(await fs.realpath(f.config.currentLink),f.previous);assert.equal(await fs.readFile(path.join(f.config.dataDir,'new-user-file'),'utf8'),'retained');assert.equal(f.active(),true);assert.deepEqual(f.calls,['update-claim','stop','start','stop','start','update-status','update-activate']);
});
test('signature, archive corruption, different data epoch, downgrade and unfinished journal fail before stop',async t=>{
 for(const variant of ['epoch','hash','channel','journal','downgrade']) {
  const f=await fixture(t);
  if(variant==='epoch')f.patch({dataEpoch:'2'});if(variant==='hash')f.patch({archive:{url:'https://updates.example/engine.gz',size:10,sha256:'a'.repeat(64)}});if(variant==='channel')f.patch({channel:'stable'});if(variant==='journal')await fs.writeFile(path.join(f.config.stateDir,'pending.json'),'{}');if(variant==='downgrade')f.patch({sequence:1});
  if(variant==='downgrade')assert.equal((await runEngineUpdate(f.config,f)).status,'current');else await assert.rejects(runEngineUpdate(f.config,f));assert.deepEqual(f.calls,[]);
 }
});
test('download limits and every redirect enforce configured HTTPS origins',async t=>{
 const f=await fixture(t);await assert.rejects(downloadUpdate('https://updates.example/feed',path.join(f.root,'redirect'),{origins:['https://updates.example'],maxBytes:100,fetcher:async()=>new Response(null,{status:302,headers:{location:'https://untrusted.example/payload'}})}),/origin/);
 await assert.rejects(downloadUpdate('https://updates.example/feed',path.join(f.root,'too-large'),{origins:['https://updates.example'],maxBytes:2,fetcher:async()=>new Response('large')}),/limit/);
 assert.throws(()=>validateUpdateConfig({...f.config,dataDir:f.config.releasesDir}),/separate/);
});
test('a signed feed may follow the configured release-asset CDN redirect',async t=>{
 const f=await fixture(t);f.config.artifactOrigins.push('https://cdn.example');const original=f.fetcher;
 f.fetcher=async url=>new URL(url).href===f.config.feedURL?new Response(null,{status:302,headers:{location:'https://cdn.example/beta.json'}}):original(url);
 assert.equal((await runEngineUpdate(f.config,f)).status,'updated');
});
