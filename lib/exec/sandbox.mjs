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
// Linux: bubblewrap in new user, mount and PID namespaces (nothing else is unshared; the network stays
// open). The system is mounted read-only; the Engine data folder (or the service account's home that
// holds it) is replaced by an empty read-only tmpfs that can be crossed but not listed; the bot's
// workspace and process home are bound read-write at their real paths; /tmp is private; /dev and /proc
// are new. Secret folders are replaced by unreadable empty tmpfs mounts. Inside the writable folders,
// protected files are bound read-only: existing ones as themselves, missing ones (shell profiles, .npmrc,
// .gitconfig in the process home; .npmrc in the workspace root; hooks/config of Git repositories found
// by a bounded scan) as empty Engine-owned placeholders, because Linux can only mount over a path that
// exists. Each protected repository's folders are also bound onto themselves so they cannot be renamed
// away and replaced. When the Engine holds capabilities (a systemd unit with AmbientCapabilities=),
// bubblewrap refuses to start, so the launch drops them first with setpriv.
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
export const SETPRIV_CANDIDATES=Object.freeze(['/usr/bin/setpriv','/bin/setpriv']);
export const PROTECTED_FILES=Object.freeze(['.zshrc','.bashrc','.profile','.zprofile','.bash_profile','.npmrc','.bash_login','.bash_logout','.zshenv','.zlogin','.gitconfig']);
/** Process-home folders that stay read-only: Git's core.hooksPath for every bot command points at this one. */
export const PROTECTED_HOME_FOLDERS=Object.freeze(['disabled-git-hooks']);
/** Linux: missing protected files that get a read-only placeholder, per writable root. */
const HOME_PLACEHOLDER_FILES=PROTECTED_FILES,WORKSPACE_PLACEHOLDER_FILES=Object.freeze(['.npmrc']);
/** Linux: the bounded scan for Git repositories inside the workspace. */
export const REPOSITORY_SCAN=Object.freeze({maxDepth:4,maxFolders:200,skip:Object.freeze(['.git','node_modules'])});
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
export function seatbeltProfile({writable,denyRead=[],traverse=[],protectedFolders=[]}) {
  if(!Array.isArray(writable) || !writable.length)refuse('The sandbox needs at least one writable folder.');
  const protectedNames=`(${anyCase('.git')}/(${anyCase('hooks')}(/.*)?|${anyCase('config')})|(${PROTECTED_FILES.map(name=>anyCase(name).replace(/\./g,'\\.')).join('|')}))`;
  const lines=[
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map(item=>`(subpath ${quoted(item)})`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/[0-9]+$") (regex #"^/dev/ttys[0-9]+$"))`,
    `(deny file-write* ${writable.map(item=>`(regex #"^${regexText(item)}(/.*)?/${protectedNames}$")`).join(' ')}${protectedFolders.map(item=>` (subpath ${quoted(item)})`).join('')})`,
  ];
  if(denyRead.length) {
    lines.push(`(deny file-read* ${denyRead.map(item=>`(subpath ${quoted(item)})`).join(' ')})`);
    if(traverse.length)lines.push(`(allow file-read-metadata ${traverse.map(item=>`(literal ${quoted(item)})`).join(' ')})`);
    lines.push(`(allow file-read* ${writable.map(item=>`(subpath ${quoted(item)})`).join(' ')})`);
  }
  return lines.join('\n');
}

// Namespaces: user (bubblewrap is not setuid on Debian/Ubuntu, so it needs one for its mounts), mount and
// PID (a private /proc, and when the sandbox's first process ends the kernel kills everything left in it).
// No --new-session: callers already start each command in a fresh session with no controlling terminal
// and stop it by signalling that process group, which must include the command (see lib/exec/index.mjs).
export const BWRAP_NAMESPACES=Object.freeze(['--unshare-user','--unshare-pid','--die-with-parent']);
export const BWRAP_SYSTEM=Object.freeze(['--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp']);
/** The availability self-test: the same namespaces and system mounts, plus the tmpfs options hidden folders use. */
export const BWRAP_PROBE_ARGS=Object.freeze([...BWRAP_NAMESPACES,...BWRAP_SYSTEM,'--perms','0111','--tmpfs','/tmp/.tupies-probe','--remount-ro','/tmp/.tupies-probe','--','true']);
/** bubblewrap takes paths as separate arguments, so only NUL, relative and unnormalised paths are refused here. */
function mountPath(value,label) {
  if(typeof value!=='string' || !path.isAbsolute(value) || path.normalize(value)!==value || value.includes('\0') || value==='/')refuse(`The sandbox cannot use the ${label} path.`);
  return value;
}

/**
 * Pure: bubblewrap arguments (without the launcher). Order matters: hidden folders become empty tmpfs
 * mounts first, then the writable folders are bound back at their real paths, then each protected
 * repository folder is bound onto itself (a mount point cannot be renamed or removed), then protected
 * paths are bound read-only (`readOnly`: a path bound onto itself, or [source, target] for a
 * placeholder), and last the hidden tmpfs mounts are made read-only. A hidden folder that holds a
 * writable folder can be crossed but not listed (0111); any other is unreadable (0000).
 */
export function bubblewrapArgs({writable,dataDir,hideFolders=[],hideFiles=[],pins=[],readOnly=[],hiddenFile=null,cwd,executable,args=[]}) {
  if(!Array.isArray(writable) || !writable.length)refuse('The sandbox needs at least one writable folder.');
  checkedPath(dataDir,'Engine data');checkedPath(cwd,'working');
  if(typeof executable!=='string' || !executable || executable.includes('\0'))refuse('The sandbox needs a command to run.');
  const hidden=hideFolders.map(folder=>mountPath(folder,'hidden'));
  if(!hidden.some(folder=>inside(dataDir,folder)))hidden.unshift(dataDir);
  if(hideFiles.length && !hiddenFile)refuse('The sandbox needs its placeholder file to hide files.');
  const result=[...BWRAP_NAMESPACES,...BWRAP_SYSTEM];
  for(const folder of hidden)result.push('--perms',writable.some(root=>inside(root,folder))?'0111':'0000','--tmpfs',folder);
  for(const file of hideFiles)result.push('--ro-bind',mountPath(hiddenFile,'placeholder'),mountPath(file,'hidden'));
  for(const folder of writable)result.push('--bind',checkedPath(folder,'writable'),folder);
  for(const folder of pins)result.push('--bind',mountPath(folder,'protected'),folder);
  for(const item of readOnly){const [source,target]=Array.isArray(item)?item:[item,item];result.push('--ro-bind',mountPath(source,'protected'),mountPath(target,'protected'));}
  for(const folder of hidden)result.push('--remount-ro',folder);
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
  const protectedFolders=PROTECTED_HOME_FOLDERS.map(name=>path.join(processHome,name));
  return {dataDir:data,workspace,home:processHome,temp,writable,denyRead,traverse:[...traverse],secrets,engineSecrets,protectedFolders,userHome:realUserHome,engineRoot:await resolvedOrLiteral(engineRoot)};
}

/**
 * Git repositories inside `root`, breadth first: at most `maxDepth` folders deep and `maxFolders` folders
 * read, never following symbolic links, never entering .git or node_modules. → [{folder, type}] where type
 * is the kind of the `.git` entry: 'folder', 'file' (a worktree or submodule pointer), 'link' or 'other'.
 */
export async function findRepositories(root,{maxDepth=REPOSITORY_SCAN.maxDepth,maxFolders=REPOSITORY_SCAN.maxFolders}={}) {
  const found=[],queue=[[root,0]];let read=0;
  while(queue.length && read<maxFolders) {
    const [folder,depth]=queue.shift();read++;
    let entries;try{entries=await fs.readdir(folder,{withFileTypes:true});}catch{continue;}
    for(const entry of entries) {
      if(entry.name==='.git'){found.push({folder,type:entry.isDirectory()?'folder':entry.isFile()?'file':entry.isSymbolicLink()?'link':'other'});continue;}
      if(entry.isDirectory() && depth<maxDepth && !REPOSITORY_SCAN.skip.includes(entry.name))queue.push([path.join(folder,entry.name),depth+1]);
    }
  }
  return found;
}

/** Engine-owned placeholders outside every writable folder: an empty readable file, an unreadable one and an empty folder. */
async function placeholders(dataDir,create) {
  const folder=path.join(dataDir,'exec-sandbox');
  const result={emptyFile:path.join(folder,'empty-file'),hiddenFile:path.join(folder,'hidden-file'),emptyFolder:path.join(folder,'empty-folder')};
  if(!create)return result;
  const missingOk=error=>{if(error.code!=='EEXIST')throw error;};
  await fs.mkdir(folder,{mode:0o700}).catch(missingOk);
  await fs.mkdir(result.emptyFolder,{mode:0o500}).catch(missingOk);
  const folderStat=await fs.lstat(result.emptyFolder);
  if(!folderStat.isDirectory() || (await fs.readdir(result.emptyFolder)).length)refuse('The sandbox placeholder folder is not an empty folder.');
  await fs.chmod(result.emptyFolder,0o500);
  for(const [file,mode] of [[result.emptyFile,0o444],[result.hiddenFile,0o000]]) {
    const stat=await fs.lstat(file).catch(()=>null);
    if(stat && !(stat.isFile() && stat.size===0))await fs.rm(file,{force:true});
    if(!stat || !(stat.isFile() && stat.size===0))await fs.writeFile(file,'',{mode,flag:'wx'}).catch(missingOk);
    await fs.chmod(file,mode);
  }
  return result;
}

/**
 * What bubblewrap hides, pins and keeps read-only for one plan. With `create`, missing protected paths
 * get an empty mount point (file 0600, folder 0700) so the placeholder can be bound over them; without
 * it (admission checks) nothing on disk changes. A protected path that is a symbolic link fails closed.
 */
export async function bubblewrapMounts(plan,{create=false,executablePath=process.execPath}={}) {
  const holders=await placeholders(plan.dataDir,create);
  // Hide the folder holding the data folder when it is the service account's own home and holds neither
  // the Engine nor its Node (the VPS layout: home /var/lib/tupies, data /var/lib/tupies/data).
  const parent=path.dirname(plan.dataDir),node=await resolvedOrLiteral(executablePath);
  const hideParent=parent!=='/' && parent===plan.userHome && ![plan.engineRoot,node].some(item=>inside(item,parent)) && !plan.writable.some(root=>inside(parent,root));
  const hideFolders=[hideParent?parent:plan.dataDir],hideFiles=[],pins=new Set(),readOnly=[];
  for(const item of [...plan.secrets,...plan.engineSecrets]) {
    if(hideFolders.some(folder=>inside(item,folder)) || !(await exists(item)))continue;
    const stat=await fs.stat(item).catch(()=>null);if(!stat)continue;
    (stat.isDirectory()?hideFolders:hideFiles).push(item);
  }
  const protect=async(target,kind,placeholder) => {
    const stat=await fs.lstat(target).catch(()=>null);
    if(stat?.isSymbolicLink())refuse(`The sandbox cannot protect ${target} because it is a symbolic link. Replace it with a regular ${kind} or remove it.`);
    if(stat){readOnly.push(mountPath(target,'protected'));return;}
    if(!placeholder)return;
    if(create)await (kind==='folder'?fs.mkdir(target,{mode:0o700}):fs.writeFile(target,'',{mode:0o600,flag:'wx'})).catch(error=>{if(error.code!=='EEXIST')throw error;});
    readOnly.push([kind==='folder'?holders.emptyFolder:holders.emptyFile,mountPath(target,'protected')]);
  };
  for(const name of PROTECTED_FILES)await protect(path.join(plan.home,name),'file',HOME_PLACEHOLDER_FILES.includes(name));
  for(const folder of plan.protectedFolders)await protect(folder,'folder',true);
  if(plan.workspace!==plan.home)for(const name of PROTECTED_FILES)await protect(path.join(plan.workspace,name),'file',WORKSPACE_PLACEHOLDER_FILES.includes(name));
  for(const repository of await findRepositories(plan.workspace)) {
    const git=path.join(repository.folder,'.git');
    if(repository.type==='link')refuse(`The sandbox cannot protect ${git} because it is a symbolic link. Replace it with the repository folder or remove it.`);
    if(repository.type==='other')continue;
    // Bind the repository's folders onto themselves, shallowest first: a mount point cannot be renamed away.
    const chain=[];for(let folder=repository.folder;folder!==plan.workspace && inside(folder,plan.workspace);folder=path.dirname(folder))chain.unshift(folder);
    for(const folder of chain)pins.add(mountPath(folder,'protected'));
    if(repository.type==='file'){readOnly.push(mountPath(git,'protected'));continue;}
    pins.add(mountPath(git,'protected'));
    await protect(path.join(git,'hooks'),'folder',true);
    await protect(path.join(git,'config'),'file',true);
  }
  const depth=item=>item.split('/').length;
  return {hideFolders,hideFiles,pins:[...pins].sort((a,b)=>depth(a)-depth(b)),readOnly,hiddenFile:holders.hiddenFile};
}

function probe(executable,args) {
  return new Promise(resolve=>{
    let stderr='',settled=false;
    const finish=result=>{if(!settled){settled=true;clearTimeout(timer);resolve({stderr,...result});}};
    let child;
    try{child=spawn(executable,args,{stdio:['ignore','ignore','pipe'],env:{PATH:'/usr/bin:/bin'}});}catch(error){finish({ok:false,reason:`It could not start (${error.code || 'unknown error'}).`});return;}
    const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}finish({ok:false,reason:'Its self-test did not finish.'});},PROBE_TIMEOUT_MS);timer.unref();
    child.stderr.on('data',chunk=>{if(stderr.length<2000)stderr+=chunk.toString('utf8');});
    child.once('error',error=>finish({ok:false,reason:`It could not start (${error.code || 'unknown error'}).`}));
    child.once('close',code=>finish(code===0?{ok:true,reason:''}:{ok:false,reason:`Its self-test failed${stderr.trim()?`: ${stderr.trim().split('\n')[0].slice(0,200)}`:'.'}`}));
  });
}

const firstStderrLine=text=>String(text || '').split('\n').map(line=>line.trim()).find(Boolean)?.slice(0,200) || '';
const SYSCTL_FILE='/etc/sysctl.d/90-tupies-sandbox.conf';
export const BWRAP_REASONS=Object.freeze({
  notInstalled:'The sandbox needs bubblewrap. On Debian or Ubuntu: sudo apt install bubblewrap',
  service:'The Engine’s service may not create the user, mount and PID namespaces the sandbox needs. Allow them with RestrictNamespaces=user pid net mnt in the service drop-in (for example /etc/systemd/system/tupies.service.d/browser.conf), then run sudo systemctl daemon-reload and restart the service.',
  userns:`This server’s kernel does not allow unprivileged user namespaces (kernel.unprivileged_userns_clone is 0), which the sandbox needs. Allow them: echo kernel.unprivileged_userns_clone=1 | sudo tee ${SYSCTL_FILE} && sudo sysctl --system`,
  maxUserns:`This server allows no user namespaces (user.max_user_namespaces is 0), which the sandbox needs. Allow them: echo user.max_user_namespaces=10000 | sudo tee ${SYSCTL_FILE} && sudo sysctl --system`,
  apparmor:`AppArmor blocks unprivileged user namespaces here (kernel.apparmor_restrict_unprivileged_userns is 1), so bubblewrap cannot set up the sandbox. Load an AppArmor profile that allows user namespaces for /usr/bin/bwrap, or lift the restriction: echo kernel.apparmor_restrict_unprivileged_userns=0 | sudo tee ${SYSCTL_FILE} && sudo sysctl --system`,
  proc:'bubblewrap could not mount a private /proc. The Engine’s service probably hides parts of /proc (ProtectKernelTunables=, ProtectProc= or ProcSubset=), or the Engine runs inside a container; remove those service settings, then run sudo systemctl daemon-reload and restart the service.',
  capabilities:'The Engine holds extra capabilities (for example AmbientCapabilities=CAP_NET_BIND_SERVICE in its service), which bubblewrap refuses, and setpriv is not installed to drop them for commands. On Debian or Ubuntu: sudo apt install util-linux',
});

/**
 * Pure: a plain-language reason for a failed bubblewrap self-test. `settings` holds the kernel values
 * read from /proc/sys (strings, or null when the setting does not exist on this kernel).
 */
export function bubblewrapFailureReason({stderr='',reason='',settings={}}={}) {
  const line=firstStderrLine(stderr),text=String(stderr || '');
  const off=name=>String(settings[name] ?? '').trim()==='0',on=name=>String(settings[name] ?? '').trim()==='1';
  if(/No permissions to creat|Creating new namespace failed|unshare.*(?:Operation not permitted|Permission denied)/i.test(text)) {
    if(off('kernel.unprivileged_userns_clone'))return BWRAP_REASONS.userns;
    if(off('user.max_user_namespaces'))return BWRAP_REASONS.maxUserns;
    return `${BWRAP_REASONS.service} (bubblewrap said: ${line})`;
  }
  if(/Unexpected capabilities but not setuid/i.test(text))return BWRAP_REASONS.capabilities;
  if(on('kernel.apparmor_restrict_unprivileged_userns'))return `${BWRAP_REASONS.apparmor} (bubblewrap said: ${line || reason})`;
  if(/mount proc|proc on \/newroot\/proc|\/newroot\/proc/i.test(text))return `${BWRAP_REASONS.proc} (bubblewrap said: ${line})`;
  if(/setting up uid map|Operation not permitted/i.test(text) && (off('kernel.unprivileged_userns_clone') || off('user.max_user_namespaces')))return off('kernel.unprivileged_userns_clone')?BWRAP_REASONS.userns:BWRAP_REASONS.maxUserns;
  return `bubblewrap is not working here: ${line || reason || 'its self-test failed.'}`;
}

const KERNEL_SETTINGS=Object.freeze(['kernel.unprivileged_userns_clone','user.max_user_namespaces','kernel.apparmor_restrict_unprivileged_userns']);
const readKernelSetting=name=>fs.readFile(`/proc/sys/${name.replace(/\./g,'/')}`,'utf8').then(value=>value.trim(),()=>null);
const readProcessStatus=()=>fs.readFile('/proc/self/status','utf8');
/** Whether this process holds capabilities a non-setuid bubblewrap refuses to start with (never for root). */
export function holdsCapabilities(status,uid) {
  if(uid===0)return false;
  const value=name=>{const match=String(status || '').match(new RegExp(`^${name}:\\s*([0-9a-fA-F]+)\\s*$`,'m'));return match?BigInt(`0x${match[1]}`):0n;};
  return value('CapPrm')!==0n || value('CapAmb')!==0n;
}
/** Drops the Engine's inheritable and ambient capabilities before bubblewrap starts (setpriv then execs it in place). */
export const SETPRIV_ARGS=Object.freeze(['--inh-caps=-all','--ambient-caps=-all','--']);

/** Factory so tests can describe another platform; the Engine uses the default instance. */
export function createSandboxBackend({platform=process.platform,seatbelt=SEATBELT_EXECUTABLE,bwrapCandidates=BWRAP_CANDIDATES,setprivCandidates=SETPRIV_CANDIDATES,runProbe=probe,clock=Date.now,readSetting=readKernelSetting,readStatus=readProcessStatus,uid=process.getuid?.(),userHome,engineRoot}={}) {
  let cache=null,pending=null,launcher=null;
  const planFor=paths=>sandboxPlan({...paths,...(userHome?{userHome}:{}),...(engineRoot?{engineRoot}:{})});
  const findExecutable=async candidates=>{for(const candidate of candidates){try{await fs.access(candidate,FS.X_OK);return candidate;}catch{}}return null;};
  const mechanism=platform==='darwin'?'Seatbelt (sandbox-exec)':platform==='linux'?'bubblewrap':'none';
  async function check() {
    if(platform==='darwin') {
      try{await fs.access(seatbelt,FS.X_OK);}catch{return {ok:false,reason:`${seatbelt} is missing on this Mac.`};}
      const result=await runProbe(seatbelt,['-p','(version 1)(allow default)','/usr/bin/true']);
      return result.ok?result:{ok:false,reason:`sandbox-exec is not working: ${result.reason}`};
    }
    if(platform==='linux') {
      launcher=null;
      const bwrap=await findExecutable(bwrapCandidates);
      if(!bwrap)return {ok:false,reason:BWRAP_REASONS.notInstalled};
      let next={executable:bwrap,prefix:[]};
      if(holdsCapabilities(await readStatus().catch(()=>''),uid)) {
        const setpriv=await findExecutable(setprivCandidates);
        if(!setpriv)return {ok:false,reason:BWRAP_REASONS.capabilities};
        next={executable:setpriv,prefix:[...SETPRIV_ARGS,bwrap]};
      }
      const result=await runProbe(next.executable,[...next.prefix,...BWRAP_PROBE_ARGS]);
      if(result.ok){launcher=next;return {ok:true,reason:''};}
      const settings={};for(const name of KERNEL_SETTINGS)settings[name]=await readSetting(name);
      return {ok:false,reason:bubblewrapFailureReason({stderr:result.stderr,reason:result.reason,settings})};
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
      const plan=await planFor({dataDir,workspaceRoot,home});
      if(platform==='darwin')seatbeltProfile(plan);else bubblewrapArgs({...plan,cwd:plan.workspace,executable:'true',...(await bubblewrapMounts(plan))});
      return plan;
    },
    async prepare({dataDir,workspaceRoot,home,env,cwd,executable,args}) {
      const plan=await backend.check({dataDir,workspaceRoot,home});
      const sandboxEnv={...env,HOME:plan.home,TMPDIR:plan.temp,XDG_CACHE_HOME:path.join(plan.home,'.cache'),npm_config_cache:path.join(plan.home,'.npm'),PIP_CACHE_DIR:path.join(plan.home,'.cache','pip'),TUPIES_SANDBOX:'1'};
      // Apple's /usr/bin developer-tool shims (git, python3, …) keep a lookup cache in the shared user temp folder; keep it private.
      if(platform==='darwin')return {executable:seatbelt,args:['-p',seatbeltProfile(plan),executable,...args],env:{...sandboxEnv,xcrun_db:path.join(plan.home,'.cache','xcrun_db')},cwd};
      const realCwd=await fs.realpath(cwd).catch(()=>refuse('The sandbox could not resolve the working folder.'));
      if(!launcher)refuse('The sandbox has not been checked on this server yet.');
      return {executable:launcher.executable,args:[...launcher.prefix,...bubblewrapArgs({...plan,...(await bubblewrapMounts(plan,{create:true})),cwd:realCwd,executable,args})],env:sandboxEnv,cwd};
    },
  };
  return Object.freeze(backend);
}

export const sandboxBackend=createSandboxBackend();
