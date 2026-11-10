// `docker` execution backend: each command runs in its own throw-away container started with the
// `docker` (or `podman`) command line. The Docker socket is never mounted into the container and the
// engine never talks to the daemon's API itself.
//
// What the container can see: the bot's workspace and the bot's Engine-local process home, both
// read-write, and nothing else from this computer. Both folders are mounted at the SAME absolute path
// they have on the host, so paths in the command text, in the terminal's saved state and in
// execute_code snippets mean the same thing inside and outside (a fixed /workspace would break those
// callers). The network stays open. Capabilities are dropped, privilege gain is blocked, and memory
// and process counts are limited. The image is the owner's: the Engine never pulls one (`--pull=never`).
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SandboxUnavailable } from './sandbox.mjs';
import { findExecutable, searchDirectories, runProbe, firstLine } from './client-tools.mjs';

export const DEFAULT_DOCKER_IMAGE='nikolaik/python-nodejs:python3.12-nodejs22-slim';
export const DOCKER_CLI_NAMES=Object.freeze(['docker','podman']);
export const DOCKER_CLI_DIRECTORIES=Object.freeze(['/usr/local/bin','/opt/homebrew/bin','/usr/bin']);
export const CONTAINER_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const FAILED_RECHECK_MS=15_000, READY_RECHECK_MS=60_000, PROBE_TIMEOUT_MS=8_000;
// Names that may enter the container. PATH is never copied: the image's own PATH applies.
const ENV_EXACT=new Set(['HOME','TMPDIR','LANG','PYTHONDONTWRITEBYTECODE','PYTHONNOUSERSITE']);
const ENV_PREFIXES=['XDG_','GIT_CONFIG_','TUPIES_','npm_config_','PIP_','LC_'];
// Settings of the docker/podman client itself (never sent into the container).
const CLIENT_PASSTHROUGH=['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','CONTAINER_HOST','XDG_RUNTIME_DIR'];
const NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;
const IMAGE=/^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,199}$/;
const refuse=message=>{throw new SandboxUnavailable(message);};
// Bind sources and targets are written as `--mount` CSV fields: no commas, quotes or control characters.
const UNSAFE_PATH=/[",\\\x00-\x1f\x7f]/;
function checkedPath(value,label) {
  if(typeof value!=='string' || !path.isAbsolute(value) || path.normalize(value)!==value || UNSAFE_PATH.test(value) || value==='/')refuse(`Docker cannot use the ${label} folder path.`);
  return value;
}
const inside=(child,parent)=>child===parent || child.startsWith(parent.endsWith('/')?parent:parent+'/');

/** The owner's settings from the engine's environment, validated. Returns {image, memory, pids}. */
export function dockerSettings(env=process.env) {
  const image=(env.STUDIO_EXEC_DOCKER_IMAGE || '').trim() || DEFAULT_DOCKER_IMAGE;
  if(!IMAGE.test(image))refuse('STUDIO_EXEC_DOCKER_IMAGE is not a valid image name.');
  const memory=(env.STUDIO_EXEC_DOCKER_MEMORY || '').trim() || '2g';
  if(!/^[1-9][0-9]{0,9}[bkmgBKMG]?$/.test(memory))refuse('STUDIO_EXEC_DOCKER_MEMORY must look like 2g or 512m.');
  const pidsText=(env.STUDIO_EXEC_DOCKER_PIDS || '').trim() || '512';
  if(!/^[1-9][0-9]{0,5}$/.test(pidsText))refuse('STUDIO_EXEC_DOCKER_PIDS must be a whole number.');
  return {image,memory,pids:Number(pidsText)};
}

/** Pure: the environment that enters the container, from an allow-list. Values are never interpolated into a shell. */
export function containerEnvironment(env) {
  const result={PATH:CONTAINER_PATH};
  for(const [name,value] of Object.entries(env || {})) {
    if(name==='PATH' || !NAME.test(name) || typeof value!=='string' || value.includes('\0'))continue;
    if(ENV_EXACT.has(name) || ENV_PREFIXES.some(prefix=>name.startsWith(prefix)))result[name]=value;
  }
  return result;
}

/**
 * Pure: arguments for `docker run` (without the CLI itself). `mounts` are {source,target}; `command`
 * entries stay separate argv entries after the image, so nothing is ever joined into a shell string.
 */
export function dockerRunArgs({image,name,memory='2g',pids=512,user=null,mounts,workdir,env,executable,args=[]}) {
  if(!IMAGE.test(image || ''))refuse('The Docker image name is not valid.');
  if(typeof executable!=='string' || !executable || executable.includes('\0') || !Array.isArray(args) || args.some(arg=>typeof arg!=='string' || arg.includes('\0')))refuse('Docker needs a command to run.');
  if(!Array.isArray(mounts) || !mounts.length)refuse('Docker needs at least one folder to mount.');
  const result=['run','--rm','-i','--init','--pull=never','--name',name,'--label','tupies-exec=1','--hostname','tupies-exec','--cap-drop','ALL','--security-opt','no-new-privileges','--memory',String(memory),'--pids-limit',String(pids)];
  if(user)result.push('--user',user);
  for(const {source,target} of mounts)result.push('--mount',`type=bind,source=${checkedPath(source,'mounted')},target=${checkedPath(target,'mounted')}`);
  result.push('--workdir',checkedPath(workdir,'working'));
  for(const [key,value] of Object.entries(env || {})) {
    if(!NAME.test(key) || typeof value!=='string' || value.includes('\0'))refuse('Docker received an environment variable it cannot pass safely.');
    result.push('--env',`${key}=${value}`);
  }
  result.push(image,executable,...args);
  return result;
}

const realFolder=async(value,label)=>{
  let real;try{real=await fs.realpath(value);}catch{refuse(`Docker could not resolve the ${label} folder.`);}
  let stat;try{stat=await fs.stat(real);}catch{refuse(`Docker could not read the ${label} folder.`);}
  if(!stat.isDirectory())refuse(`The ${label} path is not a folder.`);
  return real;
};

/** Factory so tests can inject the engine environment, PATH and platform; the Engine uses the default instance. */
export function createDockerBackend({env=process.env,platform=process.platform,searchDirs=null,clock=Date.now,probeTimeoutMs=PROBE_TIMEOUT_MS,userHome=os.homedir()}={}) {
  let cache=null,pending=null,cli=null;
  const dirs=()=>searchDirs || searchDirectories(env.PATH,DOCKER_CLI_DIRECTORIES);
  const user=()=>platform==='linux' && typeof process.getuid==='function'?`${process.getuid()}:${process.getgid()}`:null;
  function clientEnvironment() {
    const result={PATH:CONTAINER_PATH,HOME:userHome,DOCKER_CONFIG:env.DOCKER_CONFIG || path.join(userHome,'.docker')};
    for(const name of CLIENT_PASSTHROUGH)if(typeof env[name]==='string' && env[name])result[name]=env[name];
    return result;
  }
  async function check() {
    let settings;try{settings=dockerSettings(env);}catch(error){return {ok:false,reason:error.message};}
    cli=await findExecutable(DOCKER_CLI_NAMES,dirs());
    if(!cli)return {ok:false,reason:'The docker command is not installed on this computer. Install Docker (or Podman), then choose this again.'};
    const probeEnv=clientEnvironment();
    const server=await runProbe(cli,['version','--format','{{.Server.Version}}'],{env:probeEnv,timeoutMs:probeTimeoutMs});
    if(!server.ok)return {ok:false,reason:server.timedOut?'Docker did not answer in time. Is Docker running?':`Docker is not running${firstLine(server.stderr)?` (${firstLine(server.stderr)})`:''}. Start Docker, then try again.`};
    const image=await runProbe(cli,['image','inspect',settings.image,'--format','{{.Id}}'],{env:probeEnv,timeoutMs:probeTimeoutMs});
    if(!image.ok)return {ok:false,reason:`Image ${settings.image} is not on this computer. Run: ${path.basename(cli)} pull ${settings.image}`};
    return {ok:true,reason:''};
  }
  const backend={
    id:'docker',
    label:'Docker container',
    noun:'Docker container',
    isolated:true,
    /** Cached: a working Docker is re-checked after a minute, a failure after 15 seconds. */
    async available() {
      if(cache && clock()-cache.at<(cache.ok?READY_RECHECK_MS:FAILED_RECHECK_MS))return {ok:cache.ok,reason:cache.reason};
      pending ||= check().catch(error=>({ok:false,reason:`The Docker check failed: ${error.message}`})).then(result=>{cache={...result,at:clock()};pending=null;return result;});
      const result=await pending;return {ok:result.ok,reason:result.reason};
    },
    describe() {
      let image;try{image=dockerSettings(env).image;}catch{image=DEFAULT_DOCKER_IMAGE;}
      return {id:'docker',label:backend.label,summary:`Each command runs in a fresh container from the image ${image}. It can change only this bot’s own folders. The network stays open, and the image is yours to choose and keep safe.`,isolated:true,mechanism:'docker run',image,network:'open'};
    },
    /** Resolves every path and proves a launch can be built, without starting anything. */
    async check({dataDir,workspaceRoot,home}) {
      const status=await backend.available();if(!status.ok)refuse(status.reason);
      return plan({dataDir,workspaceRoot,home});
    },
    async prepare({dataDir,workspaceRoot,home,env:callerEnv,cwd,executable,args}) {
      const status=await backend.available();if(!status.ok)refuse(status.reason);
      const settings=dockerSettings(env),paths=await plan({dataDir,workspaceRoot,home});
      // The working folder must be inside the workspace or process home, lexically and after symlinks.
      const lexical=[paths.workspaceGiven,paths.homeGiven].some(root=>typeof cwd==='string' && inside(path.resolve(cwd),root));
      if(!lexical)refuse('Docker only runs commands in the bot’s own workspace or process home.');
      const realCwd=await realFolder(cwd,'working');
      if(!inside(realCwd,paths.workspace) && !inside(realCwd,paths.home))refuse('The working folder leads outside the bot’s own folders.');
      const workdir=path.resolve(cwd);
      const containerEnv=containerEnvironment({...callerEnv,HOME:paths.homeGiven});
      const name=`tupies-exec-${randomBytes(6).toString('hex')}`;
      const argv=dockerRunArgs({image:settings.image,name,memory:settings.memory,pids:settings.pids,user:user(),mounts:[{source:paths.workspace,target:paths.workspaceGiven},{source:paths.home,target:paths.homeGiven}],workdir,env:containerEnv,executable,args});
      // The client's own settings plus the container's variables: the terminal compares its saved variables with this.
      return {executable:cli,args:argv,env:{...clientEnvironment(),...containerEnv},cwd:realCwd};
    },
  };
  async function plan({dataDir,workspaceRoot,home}) {
    const workspaceGiven=path.normalize(String(workspaceRoot)),homeGiven=path.normalize(String(home));
    checkedPath(workspaceGiven,'workspace');checkedPath(homeGiven,'process home');
    const workspace=await realFolder(workspaceRoot,'workspace'),processHome=await realFolder(home,'process home');
    checkedPath(workspace,'workspace');checkedPath(processHome,'process home');
    const data=dataDir?await realFolder(dataDir,'Engine data'):null,realUser=await fs.realpath(userHome).catch(()=>path.resolve(userHome));
    for(const root of [workspace,processHome]) {
      if(data && inside(data,root))refuse('A mounted folder contains the Engine data folder.');
      if(inside(realUser,root))refuse('A mounted folder contains your home folder.');
    }
    return {workspace,home:processHome,workspaceGiven,homeGiven};
  }
  return Object.freeze(backend);
}

export const dockerBackend=createDockerBackend();
