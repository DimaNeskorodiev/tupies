import {promises as fs,createWriteStream} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {randomBytes} from 'node:crypto';
import {privateDirectory,privateFile,verifyManifest,secureURL,hashFile,unpackFiles,encryptedBackup} from './update-artifacts.mjs';
import {updateControl} from './update-control.mjs';

const fail=message=>{throw new Error(message);};
async function space(directory,bytes) {const stat=await fs.statfs(directory);if(stat.bavail*stat.bsize<bytes+512*1024**2)fail('Insufficient free disk space for a verified update and recovery scratch.');}
async function runtimeBytes(directory) {let total=0,count=0;async function walk(folder){for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name),stat=await fs.lstat(file);if(stat.isDirectory())await walk(file);else if(stat.isFile())total+=stat.size;else if(!stat.isSocket()||entry.name!=='control.sock')fail('Runtime backup requires ordinary files and folders.');if(++count>100_000)fail('Runtime backup file-count limit exceeded.');}}await walk(directory);return total;}
async function syncDirectory(directory) {const handle=await fs.open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
export async function writeUpdateJSON(file,value) {const temporary=`${file}.${randomBytes(8).toString('hex')}`,handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}await fs.rename(temporary,file);await syncDirectory(path.dirname(file));}
export async function downloadUpdate(url,target,{origins,maxBytes,fetcher=fetch}={}) {
  const timeout=AbortSignal.timeout(120_000);let response;
  for(let hop=0;hop<5;hop++) {
    const parsed=secureURL(url);if(!origins.includes(parsed.origin))fail('Update download origin is not allowed.');
    response=await fetcher(parsed,{redirect:'manual',signal:timeout,headers:{'User-Agent':'Tupies-Updater/1','Accept':'application/octet-stream'}});
    if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');await response.body?.cancel();if(!next)fail('Invalid update redirect.');url=new URL(next,parsed).href;continue;}
    if(response.status!==200){await response.body?.cancel();fail('Update download failed.');}
    let size=0;await pipeline(Readable.fromWeb(response.body),new Transform({transform(bytes,encoding,done){size+=bytes.length;done(size>maxBytes?new Error('Update download exceeds its size limit.'):null,bytes);}}),createWriteStream(target,{flags:'wx',mode:0o600}));return size;
  }
  fail('Too many update redirects.');
}
export function validateUpdateConfig(config) {
  if(config.schema!==1||!['beta','stable'].includes(config.channel)||!/^[a-zA-Z0-9_-]+\.service$/.test(config.service)||!Array.isArray(config.artifactOrigins)||!config.artifactOrigins.length)fail('Invalid updater configuration.');
  secureURL(config.feedURL);for(const origin of config.artifactOrigins)if(secureURL(origin).origin!==origin)fail('Artifact origins must be exact HTTPS origins.');
  for(const key of ['releasesDir','currentLink','dataDir','backupDir','backupKeyFile','stateDir','publicKeyFile','holdFile'])if(typeof config[key]!=='string'||!path.isAbsolute(config[key])||path.normalize(config[key])!==config[key])fail('Updater paths must be explicit normalized absolute paths.');
  const trees=[config.releasesDir,config.dataDir,config.backupDir,config.stateDir];
  for(let i=0;i<trees.length;i++)for(let j=i+1;j<trees.length;j++)if(trees[i]===trees[j]||trees[i].startsWith(trees[j]+path.sep)||trees[j].startsWith(trees[i]+path.sep))fail('Release, data, backup and updater state trees must be separate.');
  if(path.dirname(config.holdFile)!==config.stateDir||path.dirname(config.currentLink)===config.releasesDir)fail('The hold file must be in updater state; current must be outside releases.');
  for(const file of [config.backupKeyFile,config.publicKeyFile])if([config.dataDir,config.backupDir,config.releasesDir].some(root=>file===root||file.startsWith(root+path.sep)))fail('Operator keys must stay outside Engine data, release payloads and backup storage.');
  return config;
}
async function systemctl(action,unit) {
  await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/systemctl',[action,unit],{stdio:'ignore',env:{PATH:'/usr/bin:/bin',LANG:'C'}}),timer=setTimeout(()=>child.kill('SIGKILL'),90_000);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Engine service ${action} failed. Inspect the service and update journal before retrying.`));});});
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function health(config,release,control) {
  const until=Date.now()+45_000;let status;
  while(Date.now()<until){try{status=await control(config.dataDir,'update-status');if(status.held && status.release?.id===release.id && status.release?.sequence===release.sequence)return status;}catch{}await delay(500);}
  fail('The new Engine did not pass held-start release verification.');
}
async function switchRelease(link,target) {const next=`${link}.next-${randomBytes(8).toString('hex')}`;await fs.symlink(target,next);await fs.rename(next,link);await syncDirectory(path.dirname(link));}

/** Independent operator process. An unfinished journal requires inspection instead of replaying stop/start. */
export async function runEngineUpdate(config,{fetcher=fetch,service=systemctl,control=updateControl}={}) {
  validateUpdateConfig(config);
  for(const directory of [config.releasesDir,config.backupDir,config.stateDir,path.dirname(config.currentLink)])await privateDirectory(directory);
  if(!secureURL(config.feedURL).origin)fail('Invalid feed.');
  const key=await privateFile(config.publicKeyFile),stateFile=path.join(config.stateDir,'accepted.json'),journalFile=path.join(config.stateDir,'pending.json'),lock=path.join(config.stateDir,'update.lock');
  const lockHandle=await fs.open(lock,'wx',0o600).catch(error=>{if(error.code==='EEXIST')fail('An updater lock already exists. Inspect its owner/journal before retrying.');throw error;});
  let scratch=null,staged=null,journal=null,claim=null,stopped=false,switched=false,oldTarget,newRelease,activated=false;
  async function record(phase,extra={}) {journal={...journal,...extra,phase,updatedAt:new Date().toISOString()};await writeUpdateJSON(journalFile,journal);}
  try {
    if(await fs.lstat(journalFile).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))fail('An unfinished update needs operator inspection. No service action was replayed.');
    await space(config.stateDir,24_000_000);scratch=await fs.mkdtemp(path.join(config.stateDir,'.download-'));
    const accepted=JSON.parse(await fs.readFile(stateFile,'utf8'));
    const linkStat=await fs.lstat(config.currentLink);if(!linkStat.isSymbolicLink())fail('Current Engine must be an operator-managed release link.');
    oldTarget=await fs.realpath(config.currentLink);if(path.dirname(oldTarget)!==config.releasesDir)fail('Current Engine escapes the releases directory.');
    await privateDirectory(oldTarget);
    const current=JSON.parse(await fs.readFile(path.join(oldTarget,'engine-release.json'),'utf8'));
    if(accepted.id!==current.id||accepted.sequence!==current.sequence||accepted.dataEpoch!==current.dataEpoch)fail('Installed release does not match the accepted update state.');
    const envelopeFile=path.join(scratch,'manifest.json');await downloadUpdate(config.feedURL,envelopeFile,{origins:[...new Set([secureURL(config.feedURL).origin,...config.artifactOrigins])],maxBytes:24_000_000,fetcher});
    newRelease=verifyManifest(JSON.parse(await fs.readFile(envelopeFile,'utf8')),key,{channel:config.channel});
    if(newRelease.sequence<=accepted.sequence)return {status:'current'};
    if(newRelease.dataEpoch!==accepted.dataEpoch)fail('This release changes data compatibility and requires a manual upgrade.');
    await space(config.stateDir,newRelease.archive.size);await space(config.releasesDir,newRelease.files.reduce((total,file)=>total+file.size,0));
    const archive=path.join(scratch,'payload.gz'),size=await downloadUpdate(newRelease.archive.url,archive,{origins:config.artifactOrigins,maxBytes:newRelease.archive.size,fetcher});
    if(size!==newRelease.archive.size||await hashFile(archive)!==newRelease.archive.sha256)fail('Update archive checksum or size mismatch.');
    staged=path.join(config.releasesDir,`.staging-${randomBytes(12).toString('hex')}`);await unpackFiles(archive,newRelease.files,staged);
    // Release/source files are root/operator-owned, readable by the Engine service.
    await writeUpdateJSON(path.join(staged,'engine-release.json'),{id:newRelease.id,sequence:newRelease.sequence,dataEpoch:newRelease.dataEpoch,version:newRelease.version});
    await fs.chmod(path.join(staged,'engine-release.json'),0o644);
    async function readable(folder){await fs.chmod(folder,0o755);for(const entry of await fs.readdir(folder,{withFileTypes:true}))if(entry.isDirectory())await readable(path.join(folder,entry.name));}
    await readable(staged);
    const destination=path.join(config.releasesDir,newRelease.id);
    if(await fs.lstat(destination).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))fail('Release destination already exists. Inspect the retained candidate before retrying.');
    await space(config.backupDir,6*await runtimeBytes(config.dataDir));
    claim=await control(config.dataDir,'update-claim');if(!claim.ready)return {status:'deferred',reason:'Engine is busy'};
    await record('reserved',{previous:oldTarget,candidate:destination,sequence:newRelease.sequence,dataEpoch:newRelease.dataEpoch});
    await fs.rename(staged,destination);staged=null;
    await fs.writeFile(config.holdFile,'Tupies updater verification\n',{flag:'wx',mode:0o644});
    await record('stopping');await service('stop',config.service);stopped=true;
    await record('backing-up');const backup=await encryptedBackup({dataDir:config.dataDir,backupDir:config.backupDir,keyFile:config.backupKeyFile});
    await record('backed-up',{backup:backup.file});
    await switchRelease(config.currentLink,destination);switched=true;await record('starting-held');
    await service('start',config.service);await health(config,newRelease,control);
    await record('accepted-held');
    await writeUpdateJSON(stateFile,{id:newRelease.id,sequence:newRelease.sequence,dataEpoch:newRelease.dataEpoch});
    // From here, never automatically roll back: the candidate may have admitted real work.
    await record('activating');activated=true;
    await fs.rm(config.holdFile);await control(config.dataDir,'update-activate');
    await record('complete');await fs.rename(journalFile,path.join(config.stateDir,`receipt-${newRelease.sequence}.json`));
    return {status:'updated',version:newRelease.version,release:newRelease.id};
  } catch(error) {
    if(journal && !activated) {
      // Stop/start uncertainty stays journaled. Roll back only after a confirmed stop,
      // with the same data epoch and CURRENT data. Never restore backup data automatically.
      if(stopped){try{await service('stop',config.service);if(switched)await switchRelease(config.currentLink,oldTarget);await writeUpdateJSON(stateFile,JSON.parse(await fs.readFile(path.join(oldTarget,'engine-release.json'),'utf8')));await service('start',config.service);const old=JSON.parse(await fs.readFile(path.join(oldTarget,'engine-release.json'),'utf8'));await health(config,old,control);await fs.rm(config.holdFile,{force:true});await control(config.dataDir,'update-activate');await record('rolled-back',{reason:'Candidate verification failed; current data retained.'});await fs.rename(journalFile,path.join(config.stateDir,`failed-${Date.now()}.json`));}catch{await record('needs-operator');}}
      else await record('needs-operator');
    }
    throw error;
  } finally {
    if(claim?.token&&!journal)await control(config.dataDir,'update-release',claim.token).catch(()=>{});
    try {if(staged)await fs.rm(staged,{recursive:true,force:true});if(scratch)await fs.rm(scratch,{recursive:true,force:true});}finally{await lockHandle.close();await fs.rm(lock,{force:true});}
  }
}
