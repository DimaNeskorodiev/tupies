import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {macUpdateConfiguration} from '../scripts/release-macos.mjs';
import {releaseEngine} from '../scripts/release-engine.mjs';
import {releaseMacUpdate} from '../scripts/release-mac-update.mjs';
import {verifyManifest,unpackFiles} from '../lib/update-artifacts.mjs';
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'tupies-release-update-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('Mac distribution requires a permanent secure feed and a valid embedded public key',()=>{
 const key=randomBytes(32).toString('base64');assert.deepEqual(macUpdateConfiguration('https://updates.example/beta.xml',key),{feed:'https://updates.example/beta.xml',key});
 for(const url of ['http://example.com/feed','https://user:secret@example.com/feed','https://example.com/#fragment','invalid'])assert.throws(()=>macUpdateConfiguration(url,key));for(const invalid of ['',Buffer.alloc(16).toString('base64'),'$(command)'])assert.throws(()=>macUpdateConfiguration('https://example.com/feed',invalid));
});
test('Engine builder signs only the staged matching version, excludes private paths and packages safe dependency links',async t=>{
 const root=await fixture(t),source=path.join(root,'source');await fs.mkdir(path.join(source,'node_modules/.bin'),{recursive:true});await fs.mkdir(path.join(source,'node_modules/tool'));await fs.writeFile(path.join(source,'node_modules/tool/cli'),'// fixture');await fs.symlink('../tool/cli',path.join(source,'node_modules/.bin/tool'));await fs.writeFile(path.join(source,'server.mjs'),'// disposable fixture');await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'tupies',version:'0.5.0'}));
 const keys=generateKeyPairSync('ed25519'),key=path.join(root,'private.pem');await fs.writeFile(key,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});const options={source,output:path.join(root,'output'),key,id:'0.5.0-beta.2',version:'0.5.0-beta.2',sequence:'2',channel:'beta',arch:'x64','data-epoch':'1',url:'https://updates.example/payload.gz'};
 await releaseEngine(options);const signed=JSON.parse(await fs.readFile(path.join(options.output,'engine-update.json'),'utf8')),release=verifyManifest(signed,keys.publicKey.export({type:'spki',format:'pem'}),{channel:'beta',platform:'linux',arch:'x64'});await unpackFiles(path.join(options.output,'engine.tupies.gz'),release.files,path.join(root,'unpacked'));assert.equal(await fs.readlink(path.join(root,'unpacked/node_modules/.bin/tool')),'../tool/cli');
 await fs.writeFile(path.join(source,'.env'),'SYNTHETIC_NOT_A_SECRET');await assert.rejects(releaseEngine({...options,output:path.join(root,'refused')}),/private files/);await fs.rm(path.join(source,'.env'));await assert.rejects(releaseEngine({...options,version:'0.6.0',output:path.join(root,'bad-version')}),/version/);
});
test('Mac feed publication refuses an unsigned release before any signer or network can run',async t=>{
 const root=await fixture(t);await fs.writeFile(path.join(root,'release.json'),JSON.stringify({stage:'unsigned-candidate',distributable:false,bundleIdentifier:'dev.tupies.app',build:'13'}));await assert.rejects(releaseMacUpdate({release:root,output:path.join(root,'feed'),url:'https://example.com/app.dmg',key:'/missing','sign-tool':'/missing'}),/final notarized/);
});
