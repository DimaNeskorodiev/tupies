// `sandbox` execution backend: the bot's commands run under the operating system's own sandbox on
// this computer, as the same OS user, with the network open.
//
// macOS: a Seatbelt profile generated per bot and applied with /usr/bin/sandbox-exec. Default allow;
// all file writes denied; writes allowed again only under the real paths of the bot's workspace,
// its Engine-local process home and its private temporary folder; inside those, writes to Git hooks,
// Git config, shell profiles and .npmrc are denied again. Reads of the Engine data folder (state,
// vault key, logs, other bots' workspaces and process homes), the Engine's .env/.runtime and the
// user's ~/.ssh, ~/.aws, ~/.gnupg and ~/Library/Keychains are denied. Later rules win in Seatbelt.
//
// Linux: bubblewrap with the same rules: the system is mounted read-only, the workspace, process home
// and temporary folder read-write, and the Engine data folder is replaced by an empty tmpfs.
//
// Every path written into a profile is resolved with realpath first and refused (fail closed) when it
// cannot be resolved, is not absolute, or contains characters that cannot be quoted safely.
import { promises as fs, constants as FS } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../store.mjs';

export const SEATBELT_EXECUTABLE='/usr/bin/sandbox-exec';
export const BWRAP_CANDIDATES=Object.freeze(['/usr/bin/bwrap','/bin/bwrap','/usr/local/bin/bwrap']);
/** File names inside the writable roots that stay read-only: they run code later, outside the sandbox. */
export const PROTECTED_FILES=Object.freeze(['.zshrc','.bashrc','.profile','.zprofile','.bash_profile','.npmrc']);
/** Folders under the user's real home that are never readable from the sandbox. */
export const SECRET_HOME_FOLDERS=Object.freeze(['.ssh','.aws','.gnupg','Library/Keychains']);
const ENGINE_ROOT=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const FAILED_RECHECK_MS=60_000, PROBE_TIMEOUT_MS=5_000;

export class SandboxUnavailable extends HttpError {
  constructor(message){super(409,message);this.code='sandbox_unavailable';}
}
const refuse=message=>{throw new SandboxUnavailable(message);};
const UNSAFE=/["\\\x00-\x1f\x7f]/;
function checkedPath(value,label) {
  if(typeof value!=='string' || !path.isAbsolute(value) || path.normalize(value)!==value || UNSAFE.test(value) || value==='/')refuse(`The sandbox cannot use the ${label} folder path.`);
  return value;
}
const inside=(child,parent)=>child===parent || child.startsWith(parent.endsWith('/')?parent:parent+'/');
const quoted=value=>`"${checkedPath(value,'requested')}"`;
// Seatbelt regexes are POSIX extended; letters are matched in either case because APFS usually is case-insensitive.
const regexText=value=>checkedPath(value,'requested').replace(/[.^$*+?()[\]{}|]/g,'\\$&');
const anyCase=text=>text.replace(/[A-Za-z]/g,letter=>`[${letter.toLowerCase()}${letter.toUpperCase()}]`);

/**
 * Pure: the Seatbelt profile for one bot. `writable` are real folder paths the commands may change;
 * `denyRead` are real paths they may not read; `traverse` are the real ancestor folders between a
 * denied folder and a writable root, whose metadata stays readable so the shell can enter its folder.
 */
export function seatbeltProfile({writable,denyRead=[],traverse=[]}) {
  if(!Array.isArray(writable) || !writable.length)refuse('The sandbox needs at least one writable folder.');
  const protectedNames=`(${anyCase('.git')}/(${anyCase('hooks')}(/.*)?|${anyCase('config')})|(${PROTECTED_FILES.map(name=>anyCase(name).replace(/\./g,'\\.')).join('|')}))`;
  const lines=[
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map(item=>`(subpath ${quoted(item)})`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/[0-9]+$") (regex #"^/dev/ttys[0-9]+$"))`,
    `(deny file-write* ${writable.map(item=>`(regex #"^${regexText(item)}(/.*)?/${protectedNames}$")`).join(' ')})`,
  ];
  if(denyRead.length) {
    lines.push(`(deny file-read* ${denyRead.map(item=>`(subpath ${quoted(item)})`).join(' ')})`);
    if(traverse.length)lines.push(`(allow file-read-metadata ${traverse.map(item=>`(literal ${quoted(item)})`).join(' ')})`);
    lines.push(`(allow file-read* ${writable.map(item=>`(subpath ${quoted(item)})`).join(' ')})`);
  }
  return lines.join('\n');
}

/**
 * Pure: bubblewrap arguments (without the bwrap executable itself). `hideFolders`/`hideFiles` and
 * `readOnly` must already exist; bubblewrap cannot mount over a missing path on a read-only root.
 * No --new-session: the command must stay in the Engine's process group so Stop ends all of it.
 */
export function bubblewrapArgs({writable,dataDir,hideFolders=[],hideFiles=[],readOnly=[],cwd,executable,args=[]}) {
  if(!Array.isArray(writable) || !writable.length)refuse('The sandbox needs at least one writable folder.');
  checkedPath(dataDir,'Engine data');checkedPath(cwd,'working');
  if(typeof executable!=='string' || !executable || executable.includes('\0'))refuse('The sandbox needs a command to run.');
  const result=['--die-with-parent','--unshare-pid','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--tmpfs',dataDir];
  for(const folder of hideFolders)result.push('--tmpfs',checkedPath(folder,'hidden'));
  for(const file of hideFiles)result.push('--ro-bind','/dev/null',checkedPath(file,'hidden'));
  for(const folder of writable)result.push('--bind',checkedPath(folder,'writable'),folder);
  for(const item of readOnly)result.push('--ro-bind',checkedPath(item,'protected'),item);
  result.push('--chdir',cwd,'--',executable,...args);
  return result;
}

async function realFolder(value,label) {
  let real;
  try{real=await fs.realpath(value);}catch{refuse(`The sandbox could not resolve the ${label} folder.`);}
  let stat;try{stat=await fs.stat(real);}catch{refuse(`The sandbox could not read the ${label} folder.`);}
  if(!stat.isDirectory())refuse(`The sandbox ${label} path is not a folder.`);
  return checkedPath(real,label);
}
const resolvedOrLiteral=async value=>{try{return await fs.realpath(value);}catch{return path.resolve(value);}};
const exists=async value=>{try{await fs.lstat(value);return true;}catch{return false;}};

/** Resolves and checks every path the sandbox needs for one bot. Throws SandboxUnavailable (fail closed). */
export async function sandboxPlan({dataDir,workspaceRoot,home,userHome=os.homedir(),engineRoot=ENGINE_ROOT}) {
  const data=await realFolder(dataDir,'Engine data'),workspace=await realFolder(workspaceRoot,'workspace'),processHome=await realFolder(home,'process home');
  const temp=await realFolder(path.join(home,'.tmp'),'temporary');
  const realUserHome=await resolvedOrLiteral(userHome);
  const writable=[...new Set([workspace,processHome,temp])].filter((item,_index,all)=>!all.some(other=>other!==item && inside(item,other)));
  for(const root of writable) {
    if(inside(data,root))refuse('A writable sandbox folder contains the Engine data folder.');
    if(path.isAbsolute(realUserHome) && inside(realUserHome,root))refuse('A writable sandbox folder contains your home folder.');
  }
  const secrets=[];
  for(const relative of SECRET_HOME_FOLDERS)secrets.push(checkedPath(await resolvedOrLiteral(path.join(realUserHome,relative)),'protected'));
  for(const root of writable)if(secrets.some(secret=>inside(root,secret)))refuse('A writable sandbox folder is inside a protected folder.');
  const engineSecrets=[];
  for(const name of ['.env','.runtime'])engineSecrets.push(checkedPath(await resolvedOrLiteral(path.join(engineRoot,name)),'Engine'));
  const denyRead=[...new Set([data,...secrets,...engineSecrets])];
  // Ancestors of each writable root inside a denied folder keep readable metadata so `cd`/`pwd -P` work.
  const traverse=new Set();
  for(const root of writable)for(const denied of denyRead)if(inside(root,denied) && root!==denied){let folder=path.dirname(root);while(inside(folder,denied)){traverse.add(folder);if(folder===denied)break;folder=path.dirname(folder);}}
  return {dataDir:data,workspace,home:processHome,temp,writable,denyRead,traverse:[...traverse],secrets,engineSecrets};
}

/** Existing paths that bubblewrap hides or keeps read-only (Linux can only mount over existing paths). */
async function bubblewrapMounts(plan) {
  const hideFolders=[],hideFiles=[],readOnly=[];
  for(const item of [...plan.secrets,...plan.engineSecrets]) {
    if(inside(item,plan.dataDir) || !(await exists(item)))continue;
    const stat=await fs.stat(item).catch(()=>null);if(!stat)continue;
    (stat.isDirectory()?hideFolders:hideFiles).push(item);
  }
  for(const root of plan.writable)for(const relative of ['.git/hooks','.git/config',...PROTECTED_FILES]){const candidate=path.join(root,relative);if(await exists(candidate))readOnly.push(await fs.realpath(candidate));}
  return {hideFolders,hideFiles,readOnly:readOnly.filter(item=>plan.writable.some(root=>inside(item,root)))};
}

function probe(executable,args) {
  return new Promise(resolve=>{
    let stderr='',settled=false;
    const finish=result=>{if(!settled){settled=true;clearTimeout(timer);resolve(result);}};
    let child;
    try{child=spawn(executable,args,{stdio:['ignore','ignore','pipe'],env:{PATH:'/usr/bin:/bin'}});}catch(error){finish({ok:false,reason:`It could not start (${error.code || 'unknown error'}).`});return;}
    const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}finish({ok:false,reason:'Its self-test did not finish.'});},PROBE_TIMEOUT_MS);timer.unref();
    child.stderr.on('data',chunk=>{if(stderr.length<500)stderr+=chunk.toString('utf8');});
    child.once('error',error=>finish({ok:false,reason:`It could not start (${error.code || 'unknown error'}).`}));
    child.once('close',code=>finish(code===0?{ok:true,reason:''}:{ok:false,reason:`Its self-test failed${stderr.trim()?`: ${stderr.trim().split('\n')[0].slice(0,200)}`:'.'}`}));
  });
}

/** Factory so tests can describe another platform; the Engine uses the default instance. */
export function createSandboxBackend({platform=process.platform,seatbelt=SEATBELT_EXECUTABLE,bwrapCandidates=BWRAP_CANDIDATES,runProbe=probe,clock=Date.now}={}) {
  let cache=null,pending=null,bwrap=null;
  const mechanism=platform==='darwin'?'Seatbelt (sandbox-exec)':platform==='linux'?'bubblewrap':'none';
  async function check() {
    if(platform==='darwin') {
      try{await fs.access(seatbelt,FS.X_OK);}catch{return {ok:false,reason:`${seatbelt} is missing on this Mac.`};}
      const result=await runProbe(seatbelt,['-p','(version 1)(allow default)','/usr/bin/true']);
      return result.ok?result:{ok:false,reason:`sandbox-exec is not working: ${result.reason}`};
    }
    if(platform==='linux') {
      bwrap=null;
      for(const candidate of bwrapCandidates){try{await fs.access(candidate,FS.X_OK);bwrap=candidate;break;}catch{}}
      if(!bwrap)return {ok:false,reason:'bubblewrap (bwrap) is not installed on this server.'};
      const result=await runProbe(bwrap,['--die-with-parent','--unshare-pid','--ro-bind','/','/','--dev','/dev','--proc','/proc','--','true']);
      return result.ok?result:{ok:false,reason:`bubblewrap is not working here (user namespaces may be disabled): ${result.reason}`};
    }
    return {ok:false,reason:'The sandbox works on macOS and Linux only.'};
  }
  const backend={
    id:'sandbox',
    label:'Sandbox on this computer (recommended)',
    noun:'sandbox',
    isolated:true,
    /** Cached: a working sandbox stays working for the Engine's lifetime; a failure is re-checked after a minute. */
    async available() {
      if(cache && (cache.ok || clock()-cache.at<FAILED_RECHECK_MS))return {ok:cache.ok,reason:cache.reason};
      pending ||= check().catch(error=>({ok:false,reason:`The sandbox check failed: ${error.message}`})).then(result=>{cache={...result,at:clock()};pending=null;return result;});
      const result=await pending;return {ok:result.ok,reason:result.reason};
    },
    /** The last availability result without waiting, or null before the first check. */
    cached(){return cache?{ok:cache.ok,reason:cache.reason}:null;},
    describe(){return {id:'sandbox',label:backend.label,summary:'Commands can change only this bot’s own folders and cannot read the Engine’s data or your keys. Ordinary commands run without asking, also in routines, Telegram, rooms and teammate work; dangerous ones still ask.',isolated:true,mechanism,network:'open'};},
    /** Builds the plan without starting anything: proves the profile can be built for this bot. */
    async check({dataDir,workspaceRoot,home}) {
      const status=await backend.available();if(!status.ok)refuse(status.reason);
      const plan=await sandboxPlan({dataDir,workspaceRoot,home});
      if(platform==='darwin')seatbeltProfile(plan);else bubblewrapArgs({...plan,cwd:plan.workspace,executable:'true',...(await bubblewrapMounts(plan))});
      return plan;
    },
    async prepare({dataDir,workspaceRoot,home,env,cwd,executable,args}) {
      const plan=await backend.check({dataDir,workspaceRoot,home});
      const sandboxEnv={...env,HOME:plan.home,TMPDIR:plan.temp,XDG_CACHE_HOME:path.join(plan.home,'.cache'),npm_config_cache:path.join(plan.home,'.npm'),PIP_CACHE_DIR:path.join(plan.home,'.cache','pip'),TUPIES_SANDBOX:'1'};
      // Apple's /usr/bin developer-tool shims (git, python3, …) keep a lookup cache in the shared user temp folder; keep it private.
      if(platform==='darwin')return {executable:seatbelt,args:['-p',seatbeltProfile(plan),executable,...args],env:{...sandboxEnv,xcrun_db:path.join(plan.home,'.cache','xcrun_db')},cwd};
      const realCwd=await fs.realpath(cwd).catch(()=>refuse('The sandbox could not resolve the working folder.'));
      return {executable:bwrap,args:bubblewrapArgs({...plan,...(await bubblewrapMounts(plan)),cwd:realCwd,executable,args}),env:sandboxEnv,cwd};
    },
  };
  return Object.freeze(backend);
}

export const sandboxBackend=createSandboxBackend();
