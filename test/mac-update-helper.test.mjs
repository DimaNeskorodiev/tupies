import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hashFile,decryptBackup} from '../lib/update-artifacts.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform==='darwin')test('Mac helper reserves and stops only its exact synthetic Engine PID, then verifies restorable encrypted data',async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'tupies-mac-update-'))),dataDir=path.join(directory,'data'),backupDir=path.join(directory,'backups'),keyFile=path.join(directory,'backup.key');let child;
 t.after(async()=>{if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}await fs.rm(directory,{recursive:true,force:true});});
 const code=`import {createStudioServer} from ${JSON.stringify(new URL('../server.mjs',import.meta.url).href)};import {controlSocketPath} from ${JSON.stringify(new URL('../lib/control.mjs',import.meta.url).href)};const app=await createStudioServer({dataDir:${JSON.stringify(dataDir)},scheduler:false,logErrors:false});const {url}=await app.listen(0);await app.openControl(controlSocketPath(${JSON.stringify(dataDir)}),url);process.send({ready:true});process.once('SIGTERM',async()=>{await app.close();process.exit(0);});`;
 const env={PATH:process.env.PATH,HOME:directory,TMPDIR:os.tmpdir()};
 child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:root,env,stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr.on('data',bytes=>errors+=bytes);
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('message',resolve);child.once('exit',()=>reject(new Error(errors || 'Fixture Engine exited.')));});
 const before=await hashFile(path.join(dataDir,'vault.key'));
 async function helper(pid){return new Promise((resolve,reject)=>{const processHelper=spawn(process.execPath,['scripts/prepare-mac-update.mjs','--data',dataDir,'--pid',String(pid),'--backup-dir',backupDir,'--key-file',keyFile],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';processHelper.stdout.on('data',bytes=>stdout+=bytes);processHelper.stderr.on('data',bytes=>stderr+=bytes);processHelper.once('error',reject);processHelper.once('close',code=>resolve({code,stdout,stderr}));});}
 const refused=await helper(child.pid+100_000);assert.equal(refused.code,1);assert.match(refused.stderr,/not the process owned/);assert.equal(child.exitCode,null);
 const result=await helper(child.pid);assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{ready:true,backupVerified:true});assert.equal(await hashFile(path.join(dataDir,'vault.key')),before);
 const backups=await fs.readdir(backupDir);assert.equal(backups.length,1);await decryptBackup({source:path.join(backupDir,backups[0]),keyFile,target:path.join(directory,'verification'),restoreTarget:path.join(directory,'restored')});assert.equal(await hashFile(path.join(directory,'restored/vault.key')),before);
});
