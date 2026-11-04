import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inventory,packFiles,hashFile,signedManifest,privateFile,verifyManifest} from '../lib/update-artifacts.mjs';
import {createPublicKey,createPrivateKey} from 'node:crypto';

/** Package a separately built, tested Linux staging tree with production node_modules. */
export async function releaseEngine(options) {
  const source=path.resolve(options.source),output=path.resolve(options.output),sequence=Number(options.sequence);
  if(!Number.isSafeInteger(sequence)||sequence<1||!['x64','arm64'].includes(options.arch)||!['beta','stable'].includes(options.channel))throw new Error('Choose a positive release sequence, architecture and channel.');
  const sourceStat=await fs.lstat(source);if(!sourceStat.isDirectory()||sourceStat.isSymbolicLink()||output.startsWith(source+path.sep))throw new Error('Use separate staging and new output directories.');
  const allowed=new Set(['server.mjs','package.json','package-lock.json','LICENSE','NOTICE','lib','public','assets','scripts','node_modules']);
  const packageInfo=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8'));if(packageInfo.name!=='tupies'||packageInfo.version!==options.version?.split('-')[0])throw new Error('The staged package version must match the release version.');
  if((await fs.readdir(source)).some(name=>!allowed.has(name)))throw new Error('Stage only release source/assets and production dependencies; operational/private files are forbidden.');
  if(!await fs.stat(path.join(source,'node_modules')).catch(()=>null))throw new Error('Stage Linux production dependencies before packaging.');
  const files=await inventory(source,{dependencies:true});
  if(files.some(file=>file.path.split('/').some(part=>/^(?:\.env(?:\..*)?|state\.json|vault\.key|notifications\.json)$/i.test(part))))throw new Error('Private runtime paths cannot enter a release.');
  const now=new Date(),release={schema:1,product:'tupies-engine',id:options.id,version:options.version,sequence,channel:options.channel,platform:'linux',arch:options.arch,dataEpoch:options['data-epoch'],maintenanceProtocol:1,publishedAt:now.toISOString(),expiresAt:new Date(+now+30*86400_000).toISOString(),files,archive:{url:options.url,size:1,sha256:'0'.repeat(64)}};
  const key=await privateFile(options.key);const publicKey=createPublicKey(createPrivateKey(key)).export({type:'spki',format:'pem'});
  verifyManifest(signedManifest(release,key),publicKey,{channel:release.channel,platform:'linux',arch:release.arch});
  await fs.mkdir(output,{mode:0o700});const archive=path.join(output,'engine.tupies.gz');await packFiles(source,files,archive);
  release.archive.size=(await fs.stat(archive)).size;release.archive.sha256=await hashFile(archive);
  await fs.writeFile(path.join(output,'engine-update.json'),JSON.stringify(signedManifest(release,key))+'\n',{flag:'wx',mode:0o644});
  await fs.writeFile(path.join(output,'engine-release.json'),JSON.stringify({id:release.id,sequence:release.sequence,dataEpoch:release.dataEpoch,version:release.version})+'\n',{flag:'wx',mode:0o644});
  return {release:release.id,sequence,files:files.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const args=process.argv.slice(2),options={};if(args.length%2)throw new Error('Use explicit --name value options.');for(let i=0;i<args.length;i+=2){const name=args[i].slice(2);if(!['source','output','sequence','id','version','channel','arch','data-epoch','url','key'].includes(name)||options[name])throw new Error('Unknown or duplicate release option.');options[name]=args[i+1];}console.log(JSON.stringify(await releaseEngine(options)));}catch(error){console.error(error.message);process.exitCode=1;}
}
