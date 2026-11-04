// Operator-only offline installation of the reviewed upstream release. No model tool downloads code.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

export const DESKTOP_ARCHIVES=Object.freeze({
  arm64:{filename:'agent-desktop-v1.1.0-aarch64-apple-darwin.tar.gz',sha256:'3048e00aa0741bf25ffe0326f78c966408be4490ce13513f3f94ecf2a0b5270d'},
});
const fail=message=>{throw new Error(message);};
export async function installDesktopDriver({archive,destination,arch=process.arch}) {
  // The arm64 archive has actual runtime protocol acceptance. Refuse other archives until checked.
  if(arch!=='arm64')fail('This installer currently supports the verified arm64 Mac archive only.');
  const pin=DESKTOP_ARCHIVES[arch],stat=await fs.lstat(archive);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>10_000_000)fail('Choose a bounded regular upstream archive.');
  const bytes=await fs.readFile(archive);if(createHash('sha256').update(bytes).digest('hex')!==pin.sha256)fail('The desktop archive does not match its pinned official release digest. Nothing was installed.');
  const tar=gunzipSync(bytes,{maxOutputLength:30_000_000}),files=new Map();let offset=0;
  while(offset+512<=tar.length&&tar.subarray(offset,offset+512).some(v=>v!==0)) {
    const header=tar.subarray(offset,offset+512),name=header.subarray(0,100).toString('utf8').split('\0')[0],type=header[156],size=parseInt(header.subarray(124,136).toString('ascii').replace(/\0.*$/s,'').trim(),8);
    if(!['agent-desktop','agent-desktop-macos-helper'].includes(name)||files.has(name)||![0,48].includes(type)||!Number.isSafeInteger(size)||size<=0||size>20_000_000||offset+512+size>tar.length)fail('The desktop archive contains an unexpected entry. Nothing was installed.');
    files.set(name,tar.subarray(offset+512,offset+512+size));offset+=512+Math.ceil(size/512)*512;
  }
  if(files.size!==2)fail('Both the driver and its macOS helper are required.');
  const parent=await fs.realpath(path.dirname(path.resolve(destination))),target=path.join(parent,path.basename(destination));
  await fs.mkdir(target,{mode:0o700});
  for(const [name,body] of files)await fs.writeFile(path.join(target,name),body,{mode:0o755,flag:'wx'});
  const receipt={version:'1.1.0',archiveSha256:pin.sha256,files:[...files].map(([name,body])=>({name,sha256:createHash('sha256').update(body).digest('hex')}))};
  await fs.writeFile(path.join(target,'provenance.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o644});
  return {executable:path.join(target,'agent-desktop'),...receipt};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{const args=process.argv.slice(2),options={};if(args.length!==4)fail('Use --archive FILE --destination NEW_DIRECTORY.');for(let i=0;i<args.length;i+=2){if(!['--archive','--destination'].includes(args[i])||options[args[i].slice(2)])fail('Use distinct archive and destination arguments.');options[args[i].slice(2)]=args[i+1];}console.log(JSON.stringify(await installDesktopDriver(options)));}catch(error){console.error(error.message);process.exitCode=1;}
}
