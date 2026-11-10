// `ssh` execution backend: each command runs on another machine through the system `ssh` client.
//
// Settings belong to the engine, not to a bot (environment variables): STUDIO_EXEC_SSH_HOST,
// STUDIO_EXEC_SSH_USER, STUDIO_EXEC_SSH_PORT (default 22), STUDIO_EXEC_SSH_KEY (private key file; when
// absent the owner's ssh-agent and default keys are used) and STUDIO_EXEC_SSH_DIR (base folder on the
// remote machine, absolute or relative to the remote home; default "tupies"). Each bot works in
// <dir>/<botId>/ there. The local workspace is NOT synced: files the bot creates stay on that machine.
//
// The client never prompts and never trusts a new host: BatchMode=yes, StrictHostKeyChecking=yes (the
// owner adds the host key once, themselves), no password authentication. Repeated commands share one
// connection (ControlMaster=auto with a control socket inside the Engine data folder). The remote side
// is a shell, so every word is single-quoted by `shellQuote` and environment goes through `env`.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SandboxUnavailable } from './sandbox.mjs';
import { findExecutable, searchDirectories, runProbe, firstLine } from './client-tools.mjs';

export const SSH_CLI_DIRECTORIES=Object.freeze(['/usr/bin','/usr/local/bin','/opt/homebrew/bin']);
const CLIENT_PATH='/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin';
const FAILED_RECHECK_MS=15_000, READY_RECHECK_MS=60_000, PROBE_TIMEOUT_MS=12_000, CONNECT_TIMEOUT_S=8;
// Unix socket paths are limited to about 104 bytes, and ssh binds a temporary name 17 characters longer than ControlPath.
const MAX_CONTROL_DIRECTORY_BYTES=103-17-1-'c-12345678'.length;
const NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;
// Only these variables travel to the remote machine. Local paths (HOME, TMPDIR, XDG_*, GIT_CONFIG_*) mean nothing there.
const ENV_EXACT=new Set(['LANG','PYTHONDONTWRITEBYTECODE','PYTHONNOUSERSITE']);
const ENV_PREFIXES=['TUPIES_'];
const HOST=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/, USER=/^[A-Za-z_][A-Za-z0-9._-]{0,63}$/;
const refuse=message=>{throw new SandboxUnavailable(message);};

/** The one POSIX single-quote escaper: the result is a single shell word that expands to exactly `value`. */
export function shellQuote(value) {
  if(typeof value!=='string')throw new TypeError('Only strings can be quoted.');
  if(value.includes('\0'))refuse('A command part contains a NUL character and cannot be sent.');
  return `'${value.replaceAll("'","'\\''")}'`;
}

/** The owner's settings from the engine's environment, or null when SSH is not set up. Throws when set up wrongly. */
export function sshSettings(env=process.env) {
  const host=(env.STUDIO_EXEC_SSH_HOST || '').trim(),user=(env.STUDIO_EXEC_SSH_USER || '').trim();
  if(!host && !user)return null;
  if(!host || !user)refuse('SSH is only partly set up on this engine: set both STUDIO_EXEC_SSH_HOST and STUDIO_EXEC_SSH_USER.');
  if(!HOST.test(host))refuse('STUDIO_EXEC_SSH_HOST is not a valid host name or address.');
  if(!USER.test(user))refuse('STUDIO_EXEC_SSH_USER is not a valid user name.');
  const portText=(env.STUDIO_EXEC_SSH_PORT || '').trim() || '22';
  if(!/^[0-9]{1,5}$/.test(portText) || Number(portText)<1 || Number(portText)>65535)refuse('STUDIO_EXEC_SSH_PORT must be a port number.');
  const key=(env.STUDIO_EXEC_SSH_KEY || '').trim();
  if(key && (!path.isAbsolute(key) || /[\x00-\x1f]/.test(key)))refuse('STUDIO_EXEC_SSH_KEY must be the full path of a private key file.');
  let dir=(env.STUDIO_EXEC_SSH_DIR || '').trim() || 'tupies';
  if(/[\x00-\x1f\x7f]/.test(dir) || dir.startsWith('-') || dir.startsWith('~') || dir.split('/').includes('..'))refuse('STUDIO_EXEC_SSH_DIR must be a plain folder path without ".." (absolute, or relative to the remote home).');
  dir=dir.length>1?dir.replace(/\/+$/,''):dir;
  if(!dir || dir==='/' || dir==='.')refuse('STUDIO_EXEC_SSH_DIR must be a dedicated folder, not the root or the home folder.');
  return {host,user,port:Number(portText),key,dir};
}

/** Pure: arguments for the ssh client (without the executable), ending with `-- host command`. */
export function sshArgs({settings,controlPath=null,command}) {
  const options=['BatchMode=yes','StrictHostKeyChecking=yes','PasswordAuthentication=no','KbdInteractiveAuthentication=no',`ConnectTimeout=${CONNECT_TIMEOUT_S}`,'ServerAliveInterval=15','ServerAliveCountMax=3','ForwardAgent=no','ForwardX11=no','ClearAllForwardings=yes','PermitLocalCommand=no','LogLevel=ERROR'];
  if(settings.key)options.push('IdentitiesOnly=yes');
  if(controlPath)options.push('ControlMaster=auto',`ControlPath=${controlPath}`,'ControlPersist=60');
  const result=['-T'];
  for(const option of options)result.push('-o',option);
  result.push('-p',String(settings.port));
  if(settings.key)result.push('-i',settings.key);
  result.push('-l',settings.user,'--',settings.host);
  if(command!==undefined)result.push(command);
  return result;
}

const within=(child,parent)=>child===parent || child.startsWith(parent.endsWith('/')?parent:parent+'/');
/** Pure: maps a local folder inside the workspace to the bot's remote folder, or throws. */
export function remoteFolder({settings,botId,workspaceRoot,local}) {
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(String(botId)))refuse('SSH needs a valid bot id.');
  const botDir=`${settings.dir}/${botId}`,root=path.resolve(workspaceRoot),folder=path.resolve(local);
  if(!within(folder,root))refuse('SSH only runs commands in the bot’s own workspace folder.');
  const relative=path.relative(root,folder);
  if(relative.includes('\0'))refuse('The working folder cannot be sent.');
  return {botDir,cwd:relative?`${botDir}/${relative.split(path.sep).join('/')}`:botDir};
}

/** Pure: the environment sent to the remote machine, from the allow-list, with local paths mapped. */
export function remoteEnvironment({env,settings,botId,workspaceRoot}) {
  const result={},{botDir}=remoteFolder({settings,botId,workspaceRoot,local:workspaceRoot});
  for(const [name,value] of Object.entries(env || {})) {
    if(!NAME.test(name) || typeof value!=='string' || value.includes('\0'))continue;
    if(!(ENV_EXACT.has(name) || ENV_PREFIXES.some(prefix=>name.startsWith(prefix))))continue;
    if(name==='TUPIES_ROOT')result[name]=botDir;
    else if(name==='TUPIES_CWD')result[name]=within(path.resolve(value),path.resolve(workspaceRoot))?remoteFolder({settings,botId,workspaceRoot,local:value}).cwd:botDir;
    else if(name==='TUPIES_STATE_DIR')result[name]=`${botDir}/.tmp/${path.basename(value)}`;
    else result[name]=value;
  }
  return result;
}

/** Pure: the one shell command the remote side runs. Every word is quoted by shellQuote. */
export function remoteCommand({folders,env,executable,args=[]}) {
  if(typeof executable!=='string' || !executable || executable.startsWith('-') || executable.includes('=') || !Array.isArray(args))refuse('SSH needs a plain command to run.');
  const make=[...new Set([folders.botDir,folders.cwd,...(env.TUPIES_STATE_DIR?[env.TUPIES_STATE_DIR]:[])])];
  const assignments=Object.entries(env).map(([name,value])=>{if(!NAME.test(name))refuse('SSH received an environment variable it cannot pass safely.');return shellQuote(`${name}=${value}`);});
  return `mkdir -p -- ${make.map(shellQuote).join(' ')} && cd -- ${shellQuote(folders.cwd)} && exec env ${[...assignments,shellQuote(executable),...args.map(shellQuote)].join(' ')}`;
}

function failureReason(result,settings) {
  const line=firstLine(result.stderr);
  if(result.timedOut)return `${settings.host} did not answer in time.`;
  if(/host key verification failed|remote host identification has changed/i.test(result.stderr))return `This engine does not trust ${settings.host} yet. Connect once yourself with: ssh -p ${settings.port} ${settings.user}@${settings.host} (check the host key it shows), then try again.`;
  if(/permission denied/i.test(result.stderr))return `${settings.host} refused the key for ${settings.user}. Password sign-in is never used; add the key to that account.`;
  return `The connection to ${settings.host} failed${line?` (${line})`:''}.`;
}

/** Factory so tests can inject the engine environment and client search path; the Engine uses the default instance. */
export function createSshBackend({env=process.env,searchDirs=null,clock=Date.now,probeTimeoutMs=PROBE_TIMEOUT_MS,userHome=os.homedir()}={}) {
  let cache=null,pending=null,cli=null,cacheKey='';
  const clientEnvironment=()=>({PATH:CLIENT_PATH,HOME:userHome,...(env.SSH_AUTH_SOCK?{SSH_AUTH_SOCK:env.SSH_AUTH_SOCK}:{})});
  // One short socket name per connection target (host, port, user), inside the Engine data folder; null when the path would be too long.
  const controlPathFor=(dataDir,settings)=>{const dir=path.join(dataDir,'exec-ssh');return Buffer.byteLength(dir)<=MAX_CONTROL_DIRECTORY_BYTES?path.join(dir,`c-${createHash('sha1').update(`${settings.user}@${settings.host}:${settings.port}`).digest('hex').slice(0,8)}`):null;};
  async function check(dataDir) {
    let settings;try{settings=sshSettings(env);}catch(error){return {ok:false,reason:error.message};}
    if(!settings)return {ok:false,reason:'SSH is not set up on this engine. Set STUDIO_EXEC_SSH_HOST and STUDIO_EXEC_SSH_USER (and optionally STUDIO_EXEC_SSH_KEY, _PORT and _DIR), then restart the engine.'};
    cli=await findExecutable(['ssh'],searchDirs || searchDirectories(env.PATH,SSH_CLI_DIRECTORIES));
    if(!cli)return {ok:false,reason:'The ssh command is not installed on this computer.'};
    const control=dataDir?controlPathFor(dataDir,settings):null;
    if(control)await fs.mkdir(path.dirname(control),{recursive:true,mode:0o700}).catch(()=>{});
    const result=await runProbe(cli,sshArgs({settings,controlPath:control,command:'true'}),{env:clientEnvironment(),timeoutMs:probeTimeoutMs});
    return result.ok?{ok:true,reason:''}:{ok:false,reason:failureReason(result,settings)};
  }
  const backend={
    id:'ssh',
    label:'Another machine (SSH)',
    noun:'remote machine',
    isolated:true,
    /** Cached: a working connection is re-checked after a minute, a failure after 15 seconds. `dataDir` only places the shared-connection socket. */
    async available(dataDirHint) {
      const key=`${env.STUDIO_EXEC_SSH_HOST}|${env.STUDIO_EXEC_SSH_USER}|${env.STUDIO_EXEC_SSH_PORT}|${env.STUDIO_EXEC_SSH_KEY}`;
      if(cache && key===cacheKey && clock()-cache.at<(cache.ok?READY_RECHECK_MS:FAILED_RECHECK_MS))return {ok:cache.ok,reason:cache.reason};
      if(!pending){cacheKey=key;pending=check(dataDirHint).catch(error=>({ok:false,reason:`The SSH check failed: ${error.message}`})).then(result=>{cache={...result,at:clock()};pending=null;return result;});}
      const result=await pending;return {ok:result.ok,reason:result.reason};
    },
    describe() {
      let settings=null;try{settings=sshSettings(env);}catch{}
      return {id:'ssh',label:backend.label,summary:`Each command runs on ${settings?`${settings.host} as ${settings.user}`:'another machine'}, in a folder of its own for this bot (${settings?`${settings.dir}/…`:'set STUDIO_EXEC_SSH_DIR'}). The bot’s local files are not copied there: files the bot creates there stay on that machine. The remote account keeps all of its own rights.`,isolated:true,mechanism:'ssh',host:settings?.host || null,network:'remote'};
    },
    async check({dataDir,botId}) {
      const status=await backend.available(dataDir);if(!status.ok)refuse(status.reason);
      const settings=sshSettings(env);
      remoteFolder({settings,botId,workspaceRoot:'/w',local:'/w'});
      return {host:settings.host};
    },
    async prepare({dataDir,botId,workspaceRoot,env:callerEnv,cwd,executable,args}) {
      const status=await backend.available(dataDir);if(!status.ok)refuse(status.reason);
      const settings=sshSettings(env),folders=remoteFolder({settings,botId,workspaceRoot,local:cwd});
      const remote=remoteEnvironment({env:callerEnv,settings,botId,workspaceRoot});
      const command=remoteCommand({folders,env:remote,executable,args});
      const control=controlPathFor(dataDir,settings);
      if(control)await fs.mkdir(path.dirname(control),{recursive:true,mode:0o700}).catch(()=>{});
      // The ssh client runs in the caller's process group; killing the group ends the local session.
      return {executable:cli,args:sshArgs({settings,controlPath:control,command}),env:clientEnvironment(),cwd:path.resolve(workspaceRoot)};
    },
  };
  return Object.freeze(backend);
}

export const sshBackend=createSshBackend();
