// Offline bootstrap staging only: verifies signed bytes, never starts/stops an Engine or edits current.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {privateFile,privateDirectory,verifyManifest,hashFile,unpackFiles} from '../lib/update-artifacts.mjs';
try {
  const args=process.argv.slice(2),options={};if(args.length%2)throw new Error('Use explicit --name value options.');
  for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!['manifest','archive','public-key','output','channel'].includes(key)||options[key])throw new Error('Unknown or duplicate staging option.');options[key]=args[i+1];}
  if(!options.output||!path.isAbsolute(options.output))throw new Error('Choose an explicit NEW absolute output directory.');
  await privateDirectory(path.dirname(options.output));
  const manifestStat=await fs.lstat(options.manifest);if(!manifestStat.isFile()||manifestStat.isSymbolicLink()||manifestStat.size>24_000_000)throw new Error('Use a bounded regular signed manifest.');
  const release=verifyManifest(JSON.parse(await fs.readFile(options.manifest,'utf8')),await privateFile(options['public-key']),{channel:options.channel});
  const archiveStat=await fs.lstat(options.archive);if(!archiveStat.isFile()||archiveStat.isSymbolicLink()||archiveStat.size!==release.archive.size||await hashFile(options.archive)!==release.archive.sha256)throw new Error('Signed archive size/checksum mismatch.');
  await unpackFiles(options.archive,release.files,options.output);
  async function readable(folder){await fs.chmod(folder,0o755);for(const entry of await fs.readdir(folder,{withFileTypes:true}))if(entry.isDirectory())await readable(path.join(folder,entry.name));}
  await readable(options.output);
  await fs.writeFile(path.join(options.output,'engine-release.json'),JSON.stringify({id:release.id,sequence:release.sequence,dataEpoch:release.dataEpoch,version:release.version})+'\n',{mode:0o644,flag:'wx'});await fs.chmod(path.join(options.output,'engine-release.json'),0o644);
  console.log(JSON.stringify({staged:true,release:release.id,engineStarted:false,currentChanged:false}));
}catch(error){console.error(error.message);process.exitCode=1;}
