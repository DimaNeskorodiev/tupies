import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { Store, ensure } from './store.mjs';
import { controlSocketPath, controlSocketLive } from './control.mjs';
import { validateSecurityRecord } from './sync/security.mjs';
import { publicKeyObject } from './sync/crypto.mjs';

const FORMAT='tupies-runtime-snapshot',VERSION=1;
const DEFAULT_LIMITS={maxFiles:100_000,maxBytes:100*1024**3};
const within=(root,target)=>target===root || target.startsWith(root+path.sep);
const missing=error=>{if(error.code==='ENOENT')return null;throw error;};
const safePath=value=>typeof value==='string' && value.length<=4096 && value.split('/').every(part=>part && part!=='.' && part!=='..' && !part.includes('\\') && !/[\x00-\x1f\x7f]/.test(part)) && !path.isAbsolute(value);
const privateMode=stat=>(stat.mode&0o100)?0o700:0o600;

async function rootDirectory(value) {
  const absolute=path.resolve(value),stat=await fs.lstat(absolute);
  ensure(stat.isDirectory() && !stat.isSymbolicLink(),400,'Choose an ordinary runtime or snapshot directory.');
  return fs.realpath(absolute);
}
async function newTarget(value,source) {
  const absolute=path.resolve(value),parent=await fs.realpath(path.dirname(absolute)),target=path.join(parent,path.basename(absolute));
  ensure(!within(source,target) && !within(target,source),400,'Source and destination must be separate directory trees.');
  ensure(!await fs.lstat(target).catch(missing),409,'The destination already exists. Choose a new directory; nothing was overwritten.');
  return target;
}
async function stopped(directory,original=directory) {
  // Long Unix socket names are hashed from the configured path. Preserve its spelling too
  // (for example macOS /var versus /private/var) instead of probing only the realpath hash.
  for(const socket of new Set([controlSocketPath(directory),controlSocketPath(original)]))ensure(!await controlSocketLive(socket),409,'Stop the engine before taking or restoring a runtime snapshot.');
}
async function hashFile(file) {
  const handle=await fs.open(file,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat=await handle.stat();ensure(stat.isFile(),400,'Runtime snapshots contain ordinary files only.');
    const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
    return hash.digest('hex');
  } finally {await handle.close();}
}
async function inventory(directory,limits=DEFAULT_LIMITS) {
  const files=[],directories=[];let bytes=0;
  async function walk(relative='') {
    const entries=await fs.readdir(path.join(directory,relative),{withFileTypes:true});entries.sort((a,b)=>a.name.localeCompare(b.name,'en'));
    for(const entry of entries) {
      const name=relative?`${relative}/${entry.name}`:entry.name;ensure(safePath(name),400,'A runtime path cannot be represented safely in this snapshot.');
      const file=path.join(directory,...name.split('/')),stat=await fs.lstat(file);
      if(name==='control.sock' && stat.isSocket())continue; // Process-local control endpoint, never restored.
      ensure(!stat.isSymbolicLink(),400,'Remove runtime symlinks before taking or restoring a snapshot.');
      if(stat.isDirectory()){directories.push(name);ensure(files.length+directories.length<=limits.maxFiles,413,'Runtime snapshot file-count limit exceeded.');await walk(name);}
      else {
        ensure(stat.isFile(),400,'Runtime snapshots cannot copy sockets, devices or other special files.');
        bytes+=stat.size;ensure(Number.isSafeInteger(stat.size)&&bytes<=limits.maxBytes&&files.length+directories.length<limits.maxFiles,413,'Runtime snapshot size or file-count limit exceeded.');
        files.push({path:name,size:stat.size,mode:privateMode(stat),sha256:await hashFile(file)});
      }
    }
  }
  await walk();return {files,directories,bytes};
}
async function validateCredentials(directory) {
  const key=await fs.readFile(path.join(directory,'vault.key')),state=JSON.parse(await fs.readFile(path.join(directory,'state.json'),'utf8'));
  ensure(key.length===32 && state && typeof state==='object' && !Array.isArray(state) && Array.isArray(state.bots),400,'The runtime state or vault key is invalid. Restore a complete backup.');
  const store=new Store(directory);store.key=key;
  for(const entry of [...(state.connections || []),...(state.integrations || []),...(state.channels || [])])for(const name of ['secret','oauthSecret'])if(entry[name])store.unseal(entry[name]);
  const identity=await fs.readFile(path.join(directory,'sync','identity.json'),'utf8').catch(missing);
  const journal=await fs.readFile(path.join(directory,'sync','security.json'),'utf8').catch(missing);
  if(!identity){const retained=await fs.readdir(path.join(directory,'sync')).catch(missing);ensure(!retained?.length,400,'The engine identity is missing from retained sync state. Restore a complete backup.');}
  if(identity){
    const value=JSON.parse(identity);ensure(typeof value.privateKey==='string'&&typeof value.nodeId==='string'&&value.nodeId.length>0,400,'The engine identity is invalid.');
    const privateKey=createPrivateKey(store.unseal(value.privateKey));publicKeyObject(value.publicKey);
    ensure(privateKey.asymmetricKeyType==='ec'&&privateKey.asymmetricKeyDetails?.namedCurve==='prime256v1'&&createPublicKey(privateKey).export({type:'spki',format:'der'}).toString('base64')===value.publicKey,400,'The engine identity key pair is invalid.');
    if(journal)validateSecurityRecord(store,JSON.parse(journal)); // Canonical journal can repair a missing/stale mirror at startup.
    else {ensure(value.securityProtocol!==2,400,'The canonical sync security journal is missing.');const workspaceKey=await fs.readFile(path.join(directory,'sync','workspace.key'));ensure(workspaceKey.length===32,400,'The sync workspace key is invalid.');}
  }
  const notifications=await fs.readFile(path.join(directory,'notifications.json'),'utf8').catch(missing);
  if(notifications)for(const value of Object.values(JSON.parse(notifications).subscriptions || {}))if(value.secret)store.unseal(value.secret);
}
async function copyInventory(source,target,contents) {
  await fs.mkdir(target,{mode:0o700});
  for(const directory of contents.directories)await fs.mkdir(path.join(target,...directory.split('/')),{mode:0o700});
  for(const file of contents.files){const destination=path.join(target,...file.path.split('/'));await fs.copyFile(path.join(source,...file.path.split('/')),destination,constants.COPYFILE_EXCL);await fs.chmod(destination,file.mode);}
}
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
function summary(contents){return {files:contents.files.length,directories:contents.directories.length,bytes:contents.bytes};}
async function staged(target,operation) {
  const staging=path.join(path.dirname(target),`.tupies-snapshot-${randomBytes(12).toString('hex')}`);
  let reserved=false,installed=false;
  try {
    await fs.mkdir(staging,{mode:0o700});await operation(staging);
    // Exclusive reservation closes rename's empty-directory overwrite race.
    await fs.mkdir(target,{mode:0o700});reserved=true;
    await fs.rename(staging,target);installed=true;
  } finally {
    await fs.rm(staging,{recursive:true,force:true});
    if(reserved&&!installed)await fs.rmdir(target).catch(()=>{});
  }
}

/** Offline, full-tree, private plaintext snapshot. Never starts the engine or reads .env. */
export async function createRuntimeSnapshot({source,target,...limits}) {
  const configuredSource=path.resolve(source);source=await rootDirectory(source);target=await newTarget(target,source);await stopped(source,configuredSource);await validateCredentials(source);
  const bounds={...DEFAULT_LIMITS,...limits},before=await inventory(source,bounds);
  await staged(target,async staging=>{
    await copyInventory(source,path.join(staging,'data'),before);
    ensure(same(before,await inventory(path.join(staging,'data'),bounds)) && same(before,await inventory(source,bounds)),409,'The runtime changed during backup. Stop all writers and try again.');
    await stopped(source,configuredSource);
    await fs.writeFile(path.join(staging,'manifest.json'),JSON.stringify({format:FORMAT,version:VERSION,createdAt:new Date().toISOString(),...before}),{mode:0o600,flag:'wx'});
  });
  return summary(before);
}

/** Validates a snapshot without loading the engine or modifying its contents. */
export async function inspectRuntimeSnapshot({source,...limits}) {
  source=await rootDirectory(source);const bounds={...DEFAULT_LIMITS,...limits};
  const stat=await fs.lstat(path.join(source,'manifest.json'));ensure(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=32*1024**2,400,'The snapshot manifest is invalid or too large.');
  const manifest=JSON.parse(await fs.readFile(path.join(source,'manifest.json'),'utf8'));
  ensure(manifest.format===FORMAT && manifest.version===VERSION && Array.isArray(manifest.files) && Array.isArray(manifest.directories),400,'Unsupported runtime snapshot.');
  const data=await rootDirectory(path.join(source,'data')),contents=await inventory(data,bounds);
  ensure(same(contents.files,manifest.files) && same(contents.directories,manifest.directories) && contents.bytes===manifest.bytes,400,'Snapshot contents do not match the manifest. Nothing was restored.');
  await validateCredentials(data);return {source,data,contents,summary:summary(contents)};
}

/** Restores only into a new directory; it never starts schedules, channels or sync. */
export async function restoreRuntimeSnapshot({source,target,...limits}) {
  const snapshot=await inspectRuntimeSnapshot({source,...limits});target=await newTarget(target,snapshot.source);await stopped(target);
  await staged(target,async staging=>{
    // staged() creates this directory; copyInventory() requires an absent data root.
    const data=path.join(staging,'restored');await copyInventory(snapshot.data,data,snapshot.contents);
    ensure(same(snapshot.contents,await inventory(data,{...DEFAULT_LIMITS,...limits})),400,'The copied runtime failed verification. Nothing was restored.');
    await validateCredentials(data);
    for(const name of await fs.readdir(data))await fs.rename(path.join(data,name),path.join(staging,name));await fs.rmdir(data);
    await inspectRuntimeSnapshot({source:snapshot.source,...limits});
  });
  return snapshot.summary;
}
