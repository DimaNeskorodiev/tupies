import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {decryptBackup} from '../lib/update-artifacts.mjs';
let scratch;
try {
  const [command,...args]=process.argv.slice(2),options={};if(!['verify','restore'].includes(command)||args.length%2)throw new Error('Use verify|restore --source ENCRYPTED_BACKUP --key-file KEY [--target NEW_RESTORE_DIRECTORY].');
  for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!['source','key-file','target'].includes(key)||options[key])throw new Error('Unsupported or repeated backup option.');options[key]=args[i+1];}
  if(!options.source||!options['key-file']||command==='restore'&&!options.target||command==='verify'&&options.target)throw new Error('Supply explicit backup paths and a NEW restore target.');
  scratch=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-backup-verify-'));
  await decryptBackup({source:options.source,keyFile:options['key-file'],target:path.join(scratch,'verified'),restoreTarget:options.target});
  console.log(JSON.stringify({verified:true,restored:command==='restore',engineStarted:false}));
}catch(error){console.error(error.message);process.exitCode=1;}finally{if(scratch)await fs.rm(scratch,{recursive:true,force:true});}
