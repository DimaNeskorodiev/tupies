// Operator-only release/backup formats. Importing this module never starts an engine.
import {promises as fs,createReadStream,createWriteStream,constants} from 'node:fs';
import path from 'node:path';
import {createHash,sign,verify,createPublicKey,createPrivateKey,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {createRuntimeSnapshot,inspectRuntimeSnapshot,restoreRuntimeSnapshot} from './runtime-backup.mjs';

const fail=message=>{throw new Error(message);};
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function hashFile(file) {const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
export const safeEntry=name=>typeof name==='string' && name.length<=4096 && !path.isAbsolute(name) && !/[\\\x00-\x1f\x7f]/.test(name) && name.split('/').every(part=>part && part!=='.' && part!=='..');
export async function privateFile(file,{bytes}={}) {
  const handle=await fs.open(file,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {const stat=await handle.stat();if(!stat.isFile() || stat.size>2_000_000 || stat.mode&0o077 || process.getuid?.()!==undefined && stat.uid!==process.getuid())fail('Use a private regular file owned by this account.');const data=await handle.readFile();if(bytes && data.length!==bytes)fail('Invalid key length.');return data;} finally {await handle.close();}
}
export async function privateDirectory(directory) {
  const stat=await fs.lstat(directory);if(!stat.isDirectory() || stat.isSymbolicLink() || stat.mode&0o022 || process.getuid?.()!==undefined && stat.uid!==process.getuid())fail('Use a real directory owned by this account without group/other write access.');
  if(await fs.realpath(directory)!==path.resolve(directory))fail('Update directories must not traverse symbolic links.');
}
export async function inventory(root,{dependencies=false,maxBytes=8*1024**3}={}) {
  const files=[];let total=0;
  async function walk(relative='') {
    for(const name of (await fs.readdir(path.join(root,relative))).sort()) {
      const entry=relative?`${relative}/${name}`:name;if(!safeEntry(entry))fail('Unsafe bundle path.');
      const file=path.join(root,entry),stat=await fs.lstat(file);
      if(stat.isSymbolicLink()) {
        if(!dependencies || !entry.startsWith('node_modules/'))fail('Bundle symlinks are forbidden outside dependencies.');
        const target=await fs.realpath(file);if(!target.startsWith(path.resolve(root,'node_modules')+path.sep))fail('A dependency link escapes its tree.');
        const targetStat=await fs.stat(file);if(!targetStat.isFile())fail('Only dependency file links are allowed.');
        const link=await fs.readlink(file);files.push({path:entry,link,size:0,mode:0o644,sha256:sha256(Buffer.from(link))});continue;
      } else if(stat.isDirectory()){await walk(entry);continue;}
      else if(!stat.isFile())fail('Bundle contains a special file.');
      const actual=await fs.stat(file);total+=actual.size;if(files.length>=100_000 || total>maxBytes)fail('Bundle is too large.');
      files.push({path:entry,size:actual.size,mode:actual.mode&0o111?0o755:0o644,sha256:await hashFile(file)});
    }
  }
  await walk();return files;
}
export function validateFiles(files,{maxBytes=8*1024**3}={}) {
  if(!Array.isArray(files)||!files.length||files.length>100_000)fail('Invalid bundle inventory.');
  const names=new Set();let total=0;
  for(const file of files) {
    if(!safeEntry(file.path)||names.has(file.path)||!Number.isSafeInteger(file.size)||file.size<0||![0o644,0o755].includes(file.mode)||!/^[a-f0-9]{64}$/.test(file.sha256))fail('Invalid bundle file.');
    names.add(file.path);total+=file.size;
    if(file.link!==undefined && (typeof file.link!=='string'||!file.link||!file.path.startsWith('node_modules/')||path.posix.isAbsolute(file.link)||/[\\\x00-\x1f\x7f]/.test(file.link)||!path.posix.normalize(path.posix.join(path.posix.dirname(file.path),file.link)).startsWith('node_modules/')||file.size!==0||file.sha256!==sha256(Buffer.from(file.link))))fail('Unsafe dependency link.');
  }
  if(total>maxBytes)fail('Expanded bundle is too large.');
  for(const name of names){let parent=path.posix.dirname(name);while(parent!=='.'){if(names.has(parent))fail('Bundle file/directory collision.');parent=path.posix.dirname(parent);}}
  for(const file of files)if(file.link && !names.has(path.posix.normalize(path.posix.join(path.posix.dirname(file.path),file.link))))fail('Dependency links must resolve inside the signed inventory.');
  return total;
}
export async function packFiles(root,files,target) {
  validateFiles(files,{maxBytes:100*1024**3});
  async function* chunks(){for(const file of files){if(file.link){if(await fs.readlink(path.join(root,file.path))!==file.link)fail('Source link changed during packaging.');continue;}if(await hashFile(path.join(root,file.path))!==file.sha256)fail('Source changed during packaging.');yield* createReadStream(path.join(root,file.path));}}
  await pipeline(Readable.from(chunks()),createGzip(),createWriteStream(target,{flags:'wx',mode:0o600}));
}
export async function unpackFiles(archive,files,target,{maxBytes}={}) {
  validateFiles(files,{maxBytes});await fs.mkdir(target,{mode:0o700});
  const source=createReadStream(archive),stream=createGunzip();source.on('error',error=>stream.destroy(error));source.pipe(stream);const iterator=stream[Symbol.asyncIterator]();let pending=Buffer.alloc(0);
  try {
    for(const file of files) {
      const destination=path.join(target,file.path);await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
      if(file.link)continue;
      const output=await fs.open(destination,'wx',file.mode),hash=createHash('sha256');let remaining=file.size;
      try {while(remaining){if(!pending.length){const next=await iterator.next();if(next.done)fail('Truncated update bundle.');pending=next.value;}const bytes=pending.subarray(0,Math.min(remaining,pending.length));await output.writeFile(bytes);hash.update(bytes);remaining-=bytes.length;pending=pending.subarray(bytes.length);}}finally{await output.close();}
      if(hash.digest('hex')!==file.sha256)fail('Update file checksum mismatch.');
      await fs.chmod(destination,file.mode);
    }
    if(pending.length || !(await iterator.next()).done)fail('Unexpected trailing bundle bytes.');
    for(const file of files.filter(file=>file.link))await fs.symlink(file.link,path.join(target,file.path));
    for(const file of files.filter(file=>file.link)) {const real=await fs.realpath(path.join(target,file.path));if(!real.startsWith(path.resolve(target,'node_modules')+path.sep)||!(await fs.stat(real)).isFile())fail('Invalid dependency link target.');}
  } finally {source.destroy();stream.destroy();}
}
export function signedManifest(manifest,key) {
  const privateKey=createPrivateKey(key);if(privateKey.asymmetricKeyType!=='ed25519')fail('Use an Ed25519 release signing key.');
  const bytes=Buffer.from(JSON.stringify(manifest));return {payload:bytes.toString('base64'),signature:sign(null,bytes,privateKey).toString('base64')};
}
export function verifyManifest(envelope,key,{channel,platform=process.platform,arch=process.arch,now=Date.now()}={}) {
  if(typeof envelope?.payload!=='string'||typeof envelope.signature!=='string'||envelope.payload.length>24_000_000)fail('Invalid signed release envelope.');
  const publicKey=createPublicKey(key),bytes=Buffer.from(envelope.payload,'base64');
  if(publicKey.asymmetricKeyType!=='ed25519'||!verify(null,bytes,publicKey,Buffer.from(envelope.signature,'base64')))fail('Release signature is invalid.');
  const release=JSON.parse(bytes);
  if(release.schema!==1||release.product!=='tupies-engine'||release.channel!==channel||release.platform!==platform||release.arch!==arch||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(release.version)||!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(release.id)||!Number.isSafeInteger(release.sequence)||release.sequence<1||!Number.isFinite(Date.parse(release.expiresAt))||Date.parse(release.expiresAt)<=now||!Number.isFinite(Date.parse(release.publishedAt))||Date.parse(release.publishedAt)>now+300_000||Date.parse(release.expiresAt)-Date.parse(release.publishedAt)>32*86400_000||typeof release.dataEpoch!=='string'||!/^\d{1,9}$/.test(release.dataEpoch)||release.maintenanceProtocol!==1)fail('Release metadata is expired, incompatible or invalid.');
  validateFiles(release.files);
  if(!release.files.some(file=>file.path==='server.mjs')||release.files.some(file=>!['server.mjs','package.json','package-lock.json','LICENSE','NOTICE'].includes(file.path)&&!['lib/','public/','assets/','scripts/','node_modules/'].some(prefix=>file.path.startsWith(prefix))))fail('Release contains unsupported paths.');
  if(!Number.isSafeInteger(release.archive?.size)||release.archive.size<1||release.archive.size>2*1024**3||!/^[a-f0-9]{64}$/.test(release.archive.sha256))fail('Invalid update archive.');
  secureURL(release.archive.url);return release;
}
export function secureURL(value) {const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.hash)fail('Updates require HTTPS URLs without credentials or fragments.');return url;}

/** Encrypt a complete stopped snapshot, authenticate a fresh decrypt and verify its files/credentials. */
export async function encryptedBackup({dataDir,backupDir,keyFile}) {
  await privateDirectory(backupDir);const key=await privateFile(keyFile,{bytes:32});
  const scratch=await fs.mkdtemp(path.join(backupDir,'.verify-')),snapshot=path.join(scratch,'snapshot'),archive=path.join(scratch,'snapshot.gz');
  const target=path.join(backupDir,`runtime-${Date.now()}-${randomBytes(6).toString('hex')}.tupies-backup`);
  try {
    await createRuntimeSnapshot({source:dataDir,target:snapshot});
    const files=await inventory(snapshot,{maxBytes:100*1024**3}),header=Buffer.from(JSON.stringify({schema:1,files}));
    await packFiles(snapshot,files,archive);
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),prefix=Buffer.alloc(8);prefix.write('TUPB');prefix.writeUInt32BE(header.length,4);
    cipher.setAAD(prefix);
    async function* plaintext(){yield header;yield* createReadStream(archive);}
    const output=await fs.open(target,'wx',0o600);await output.writeFile(Buffer.concat([prefix,iv]));await output.close();
    await pipeline(Readable.from(plaintext()),cipher,createWriteStream(target,{flags:'a'}));await fs.appendFile(target,cipher.getAuthTag());
    await decryptBackup({source:target,keyFile,target:path.join(scratch,'verified')});
    return {file:target,verified:true,encrypted:true};
  } catch(error) {await fs.rm(target,{force:true});throw error;} finally {await fs.rm(scratch,{recursive:true,force:true});}
}
export async function decryptBackup({source,keyFile,target,restoreTarget}) {
  const key=await privateFile(keyFile,{bytes:32}),handle=await fs.open(source,'r'),stat=await handle.stat(),prefix=Buffer.alloc(20),tag=Buffer.alloc(16);
  try {await handle.read(prefix,0,20,0);await handle.read(tag,0,16,stat.size-16);}finally{await handle.close();}
  const length=prefix.readUInt32BE(4);if(prefix.subarray(0,4).toString()!=='TUPB'||length<1||length>32*1024**2||stat.size<37)fail('Invalid encrypted backup.');
  const decipher=createDecipheriv('aes-256-gcm',key,prefix.subarray(8,20));decipher.setAAD(prefix.subarray(0,8));decipher.setAuthTag(tag);
  await fs.mkdir(target,{mode:0o700});const plain=path.join(target,'authenticated');
  // No archive content is parsed or extracted until GCM authentication succeeds.
  await pipeline(createReadStream(source,{start:20,end:stat.size-17}),decipher,createWriteStream(plain,{flags:'wx',mode:0o600}));
  const input=await fs.open(plain,'r'),bytes=Buffer.alloc(length);try{if((await input.read(bytes,0,length,0)).bytesRead!==length)fail('Truncated backup header.');}finally{await input.close();}
  const metadata=JSON.parse(bytes);if(metadata.schema!==1)fail('Unsupported backup.');
  const archive=path.join(target,'archive.gz');await pipeline(createReadStream(plain,{start:length}),createWriteStream(archive,{flags:'wx',mode:0o600}));
  const snapshot=path.join(target,'snapshot');await unpackFiles(archive,metadata.files,snapshot,{maxBytes:100*1024**3});
  // Preserve empty runtime directories recorded by the canonical manifest.
  const manifest=JSON.parse(await fs.readFile(path.join(snapshot,'manifest.json'),'utf8'));
  for(const name of manifest.directories || []){if(!safeEntry(name))fail('Unsafe backup directory.');await fs.mkdir(path.join(snapshot,'data',name),{recursive:true,mode:0o700});}
  await inspectRuntimeSnapshot({source:snapshot});if(restoreTarget)await restoreRuntimeSnapshot({source:snapshot,target:restoreTarget});
  return {verified:true,snapshot};
}
