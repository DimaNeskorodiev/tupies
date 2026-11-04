// Called only by the Mac app for its own managed process, never by a model tool.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {updateControl} from '../lib/update-control.mjs';
import {controlSocketLive,controlSocketPath} from '../lib/control.mjs';
import {encryptedBackup,privateDirectory} from '../lib/update-artifacts.mjs';

try {
  const args=process.argv.slice(2),options={};
  if(args.length%2)throw new Error('Invalid Mac update options.');
  for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!['data','pid','backup-dir','key-file'].includes(key)||options[key])throw new Error('Invalid Mac update option.');options[key]=args[i+1];}
  if(process.platform!=='darwin'||!/^\d+$/.test(options.pid||''))throw new Error('Use the Mac app to prepare its own Engine update.');
  for(const key of ['data','backup-dir','key-file'])if(!options[key]||!path.isAbsolute(options[key]))throw new Error('Explicit Mac update paths are required.');
  await privateDirectory(path.dirname(options['backup-dir']));
  await fs.mkdir(options['backup-dir'],{mode:0o700,recursive:true});await privateDirectory(options['backup-dir']);
  try{await fs.writeFile(options['key-file'],randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  const pid=Number(options.pid),live=await controlSocketLive(controlSocketPath(options.data));
  if(pid>0) {
    if(!live)throw new Error('The managed Engine stopped before update preparation. Try again.');
    const claim=await updateControl(options.data,'update-claim');
    if(!claim.ready)throw new Error('Wait for local tasks, rooms and sign-ins to finish, then install the downloaded update.');
    if(claim.pid!==pid){await updateControl(options.data,'update-release',claim.token);throw new Error('The running Engine is not the process owned by this app.');}
    process.kill(pid,'SIGTERM');
    const until=Date.now()+45_000;
    while(Date.now()<until){let alive=true;try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}if(!alive&&!await controlSocketLive(controlSocketPath(options.data)))break;await new Promise(resolve=>setTimeout(resolve,100));}
    try{process.kill(pid,0);throw new Error('The managed Engine did not stop. The update was postponed.');}catch(error){if(error.code!=='ESRCH')throw error;}
  } else if(live)throw new Error('Another process owns this Engine. Quit that process before updating.');
  await encryptedBackup({dataDir:options.data,backupDir:options['backup-dir'],keyFile:options['key-file']});
  console.log(JSON.stringify({ready:true,backupVerified:true}));
}catch(error){console.error(error.message);process.exitCode=1;}
