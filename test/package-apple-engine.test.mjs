import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PACKAGED_NODE_VERSION,PACKAGED_NODE_SHA256,runtimeIdentity,verifyNodeArchive,verifyMachOArchitecture,stageEngineSource,packageAppleEngine} from '../scripts/package-apple-engine.mjs';

async function temporary(t) {const dir=await fs.mkdtemp(path.join(tmpdir(),'tupies-package-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('Apple runtime packaging verifies exact pinned release, checksum and architecture before execution',async t=>{
  const dir=await temporary(t),archive=path.join(dir,`node-v${PACKAGED_NODE_VERSION}-darwin-arm64.tar.gz`),checksums=path.join(dir,'SHASUMS256.txt'),bytes=Buffer.from('checksum fixture');
  await fs.writeFile(archive,bytes);await fs.writeFile(checksums,`${createHash('sha256').update(bytes).digest('hex')}  ${path.basename(archive)}\n`);
  assert.equal(runtimeIdentity(archive,'arm64').version,PACKAGED_NODE_VERSION);
  await assert.rejects(verifyNodeArchive(archive,checksums,'arm64'),/pinned official release digest/);
  await fs.writeFile(checksums,`${PACKAGED_NODE_SHA256[path.basename(archive)]}  ${path.basename(archive)}\n`);
  await assert.rejects(verifyNodeArchive(archive,checksums,'arm64'),/checksum/);
  assert.throws(()=>runtimeIdentity(archive,'x64'),/official/);assert.throws(()=>runtimeIdentity(archive,'other'),/architecture/);
  const executable=Buffer.alloc(32);executable.writeUInt32LE(0xfeedfacf,0);executable.writeUInt32LE(0x0100000c,4);
  assert.doesNotThrow(()=>verifyMachOArchitecture(executable,'arm64'));assert.throws(()=>verifyMachOArchitecture(executable,'x64'),/architecture/);assert.throws(()=>verifyMachOArchitecture(Buffer.from('script'),'arm64'),/architecture/);
  const output=path.join(dir,'existing');await fs.mkdir(output);await fs.writeFile(path.join(output,'keep'),'retained');
  await assert.rejects(packageAppleEngine({archive,checksums,output,arch:'arm64'}),/already exists/);assert.equal(await fs.readFile(path.join(output,'keep'),'utf8'),'retained');
});

test('Apple engine source staging includes runtime fonts and notices but excludes private and development data',async t=>{
  const dir=await temporary(t),repo=path.join(dir,'repo'),out=path.join(dir,'output');
  for(const folder of ['lib','public','assets/fonts','assets/licenses','scripts','data','node_modules','test','prototypes'])await fs.mkdir(path.join(repo,folder),{recursive:true});
  const files={'server.mjs':'// server','package.json':'{"name":"fixture"}','package-lock.json':'{"packages":{}}','LICENSE':'MIT','NOTICE':'notice','lib/engine.mjs':'// engine','public/app.js':'// app','assets/fonts/NotoSans-Regular.ttf':'font','assets/fonts/OFL.txt':'font license','assets/licenses/THIRD_PARTY_LICENSES.txt':'dependency notices','.env':'SECRET','data/state.json':'SECRET','data/vault.key':'SECRET','node_modules/private':'SECRET','test/private':'SECRET','prototypes/private':'SECRET','lib/.env':'SECRET','public/state.json':'SECRET','public/.private':'SECRET'};
  for(const [name,value] of Object.entries(files))await fs.writeFile(path.join(repo,name),value);
  for(const name of ['pair.mjs','link-engine.mjs','runtime-backup.mjs','eval-private.mjs'])await fs.writeFile(path.join(repo,'scripts',name),'// script fixture');
  await stageEngineSource(repo,out);
  for(const name of ['server.mjs','lib/engine.mjs','public/app.js','assets/fonts/NotoSans-Regular.ttf','assets/fonts/OFL.txt','assets/licenses/THIRD_PARTY_LICENSES.txt','LICENSE','NOTICE'])assert.ok(await fs.stat(path.join(out,name)));
  for(const name of ['.env','data','node_modules','test','prototypes','lib/.env','public/state.json','public/.private'])await assert.rejects(fs.lstat(path.join(out,name)),{code:'ENOENT'});
  for(const name of ['pair.mjs','link-engine.mjs','runtime-backup.mjs'])assert.ok(await fs.stat(path.join(out,'scripts',name)));
  await assert.rejects(fs.lstat(path.join(out,'scripts','eval-private.mjs')),{code:'ENOENT'});
  await fs.symlink(path.join(repo,'.env'),path.join(repo,'public','leak.txt'));
  await assert.rejects(stageEngineSource(repo,path.join(dir,'symlink-output')),/symlinks/);
});
