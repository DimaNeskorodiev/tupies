import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {createRuntimeSnapshot,inspectRuntimeSnapshot,restoreRuntimeSnapshot} from '../lib/runtime-backup.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(here),settings={stateMib:22,batches:3,output:''};
for(let index=2;index<process.argv.length;index+=2){const key=process.argv[index],value=process.argv[index+1];if(!['--state-mib','--batches','--output'].includes(key)||!value)throw new Error('Use --state-mib 1–64, --batches 1–12 and optional --output PATH.');settings[key==='--state-mib'?'stateMib':key.slice(2)]=key==='--output'?value:Number(value);}
assert.ok(Number.isInteger(settings.stateMib)&&settings.stateMib>=1&&settings.stateMib<=64&&Number.isInteger(settings.batches)&&settings.batches>=1&&settings.batches<=12);
const identityFiles=['server.mjs','package-lock.json','scripts/runtime-verification-host.mjs','scripts/verify-runtime.mjs'];
for(const folder of ['lib','lib/sync','lib/exec'])for(const name of await fs.readdir(path.join(root,folder)))if(name.endsWith('.mjs'))identityFiles.push(`${folder}/${name}`);
async function identities(){return Object.fromEntries(await Promise.all(identityFiles.map(async file=>[file,createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex')])));}
const owned=new Set(),token=randomBytes(24).toString('hex'),directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-runtime-verification-'));
await fs.writeFile(path.join(directory,'verification-only.json'),JSON.stringify({token}),{mode:0o600});
const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('STUDIO_')&&!/API_KEY|ACCESS_TOKEN|SECRET/.test(name)));environment.TUPIES_VERIFICATION_TOKEN=token;
function host(operation,dataDirectory) {
  const child=fork(path.join(here,'runtime-verification-host.mjs'),[operation,dataDirectory,String(settings.stateMib),String(settings.batches)],{env:environment,execArgv:['--max-old-space-size=512'],stdio:['ignore','ignore','ignore','ipc']});owned.add(child);
  const closed=new Promise(resolve=>child.once('exit',(code,signal)=>{owned.delete(child);resolve({code,signal});}));
  const ready=new Promise((resolve,reject)=>{
    let settled=false;
    const deadline=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Runtime verification subprocess exceeded 120 seconds.'));},120_000);
    child.on('message',message=>{if(['done','crash-ready'].includes(message?.kind)){settled=true;clearTimeout(deadline);resolve(message);}else if(message?.kind==='failure'){settled=true;clearTimeout(deadline);reject(new Error(message.message));}});
    child.once('error',error=>{clearTimeout(deadline);reject(error);});
    child.once('exit',code=>{clearTimeout(deadline);if(!settled||code!==0)reject(new Error('Runtime verification subprocess failed.'));});
  });
  return {child,ready,closed};
}
let report;
try {
  const before=await identities(),source=path.join(directory,'runtime'),snapshot=path.join(directory,'snapshot'),restored=path.join(directory,'restored');
  const load=host('load',source),loaded=await load.ready;assert.equal((await load.closed).code,0);
  const backup=await createRuntimeSnapshot({source,target:snapshot}),inspection=await inspectRuntimeSnapshot({source:snapshot});assert.equal(inspection.summary.files,backup.files);
  await restoreRuntimeSnapshot({source:snapshot,target:restored});
  for(const file of inspection.contents.files)assert.equal((await fs.stat(path.join(restored,file.path))).mode&0o077,0);
  for(const folder of ['',...inspection.contents.directories])assert.equal((await fs.stat(path.join(restored,folder))).mode&0o077,0);
  const crashing=host('crash',restored),committed=await crashing.ready;
  await assert.rejects(createRuntimeSnapshot({source:restored,target:path.join(directory,'refused-live-snapshot')}),/Stop the engine/);
  crashing.child.kill('SIGKILL');assert.equal((await crashing.closed).signal,'SIGKILL');
  const recovering=host('recover',restored),recovered=await recovering.ready;assert.equal((await recovering.closed).code,0);assert.equal(recovered.metrics.committedSha256,committed.committedSha256);
  const after=await identities(),sourceStable=JSON.stringify(before)===JSON.stringify(after);report={schemaVersion:1,fixture:'runtime-recovery-v1',passed:sourceStable,sourceStable,sourceHashes:after,node:process.version,platform:process.platform,load:loaded.metrics,backup:{...backup,fullTreeVerified:true,credentialsVerified:true,privateModesVerified:true,encrypted:false},hostLoss:recovered.metrics,limits:{externalNetwork:false,realProvider:false,liveData:false,physicalPowerLoss:false,multiDay:false,subprocessTimeoutMs:120_000,v8HeapMiB:512}};
  if(!sourceStable)process.exitCode=1;
  if(settings.output){const output=path.resolve(settings.output);await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
  console.log(JSON.stringify(report));
} finally {
  for(const child of owned)child.kill('SIGKILL');await Promise.all([...owned].map(child=>new Promise(resolve=>child.once('exit',resolve))));
  await fs.rm(directory,{recursive:true,force:true});
}
