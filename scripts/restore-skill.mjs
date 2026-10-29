import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parsePortableSkillPackage } from '../lib/skill-import.mjs';

/** Restore a Tupies skill export as a native SKILL.md directory, without executing it. */
export async function restoreSkill(packagePath, destination) {
  const source=path.resolve(packagePath), target=path.resolve(destination), parent=path.dirname(target);
  const stat=await fs.stat(source);
  if(!stat.isFile() || stat.size>7_100_000)throw new Error('Choose a Tupies skill JSON export under 7.1 MB.');
  const input=JSON.parse(await fs.readFile(source,'utf8'));
  if(!input || typeof input!=='object' || Array.isArray(input))throw new Error('The export must contain a files array.');
  const {skill,files}=parsePortableSkillPackage(input);
  await fs.access(parent);
  try {await fs.lstat(target);throw new Error('Destination already exists. Choose a new directory.');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const staging=path.join(parent,`.studio-skill-${randomBytes(12).toString('hex')}`);
  await fs.mkdir(staging,{mode:0o700});
  try {
    for(const file of files){
      const filePath=path.join(staging,file.path);
      await fs.mkdir(path.dirname(filePath),{recursive:true,mode:0o700});
      await fs.writeFile(filePath,file.data,{flag:'wx',mode:0o600});
    }
    // Reserve the destination exclusively, so a concurrent writer cannot be overwritten.
    await fs.mkdir(target,{mode:0o700});
    try {for(const entry of await fs.readdir(staging)){await fs.rename(path.join(staging,entry),path.join(target,entry));}}
    catch(error){throw new Error(`Restoration stopped: ${error.message}. Review the partial destination before retrying.`);}
  } finally {await fs.rm(staging,{recursive:true,force:true});}
  return {name:skill.name,directory:target,fileCount:files.length};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [packagePath,destination]=process.argv.slice(2);
  if(!packagePath || !destination){console.error('Usage: node scripts/restore-skill.mjs <name.skill.json> <new-directory>');process.exitCode=1;}
  else try{const result=await restoreSkill(packagePath,destination);console.log(`Restored ${result.name}: ${result.fileCount} files in ${result.directory}`);console.log('Resources are preserved without execution. Review them before installing in a Hermes profile.');}
  catch(error){console.error(error.message);process.exitCode=1;}
}
