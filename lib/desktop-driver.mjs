import {promises as fs,constants as FS} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {codingCommand} from './coding-process.mjs';
import {ensure} from './store.mjs';

export const DESKTOP_DRIVER_VERSION='1.1.0';
export const DESKTOP_PROTOCOL_VERSION='2.6';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Owner-selected native code, outside bot-editable workspaces. Pin both executables. */
export async function desktopExecutableIdentity(executable) {
  ensure(typeof executable==='string'&&path.isAbsolute(executable)&&executable.length<=2000&&!/[\x00-\x1f\x7f]/.test(executable),400,'Choose the absolute agent-desktop executable.');
  const real=await fs.realpath(executable),files=[];
  for(const file of [real,path.join(path.dirname(real),'agent-desktop-macos-helper')]) {
    const stat=await fs.lstat(file);ensure(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=30_000_000,400,'Desktop executables must be regular files under 30 MB.');await fs.access(file,FS.X_OK);
    files.push({path:file,sha256:hash(await fs.readFile(file)),device:stat.dev,inode:stat.ino});
  }
  return files;
}

/** Literal, bounded subprocesses only. Never inherit provider credentials or shell startup. */
export async function desktopDriver({identity,args,cwd,env,signal}) {
  try{const actual=await desktopExecutableIdentity(identity[0].path);ensure(JSON.stringify(actual)===JSON.stringify(identity),409,'The desktop driver changed. Reconnect it in Desktop settings before executing anything.');}catch(error){throw Object.assign(error,{notDelivered:true});}
  const result=await codingCommand({executable:identity[0].path,args,cwd,env,signal,timeoutMs:15_000,maxBytes:1_500_000});
  let envelope;try{envelope=JSON.parse(result.stdout);}catch{throw Object.assign(new Error('The desktop driver returned no valid receipt. Inspect the app before retrying an action.'),{code:'desktop_protocol'});}
  ensure(envelope&&envelope.version===DESKTOP_PROTOCOL_VERSION&&typeof envelope.ok==='boolean'&&envelope.command===args[0],502,'Unsupported desktop driver receipt.');
  if(!envelope.ok){const safe=envelope.error;throw Object.assign(new Error(typeof safe?.message==='string'?safe.message.slice(0,600):'The desktop action failed.'),{code:'desktop_driver',driverCode:String(safe?.code||'unknown').slice(0,80),notDelivered:safe?.disposition?.delivery==='not_delivered',retryable:false});}
  ensure(result.exitCode===0&&!result.signal&&envelope.data&&typeof envelope.data==='object',502,'The desktop driver did not confirm a successful command.');
  return envelope.data;
}
