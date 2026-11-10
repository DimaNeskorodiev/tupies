// Execution backends: where a bot's commands run (`terminal`, `execute_code`, `shell_run`,
// `shell_start`, background commands and `scripts_run`). Language servers and document workers are
// Engine-owned code and stay on the host.
//
// A registry entry is Engine code in this folder. Nothing is loaded from a workspace, state, a
// download or a model's output; the only per-bot input is the owner's choice `bot.execution.backend`.
//
// Backend interface (keep it small; Docker and SSH will implement the same shape):
//   id            stable string stored in bot.execution.backend
//   label         the choice shown in bot settings
//   noun          short name used in approval reasons ("this bot’s sandbox")
//   isolated      true when commands cannot change files outside the bot's own folders
//   available()   async, cheap and cached → {ok, reason}; reason is plain words for the owner
//   describe()    → {id, label, summary, isolated, ...} for the settings screen
//   check(paths)  async, optional: proves this bot's environment can be prepared, without starting
//                 anything; throws (status 409, code 'sandbox_unavailable') when it cannot
//   prepare({dataDir, botId, workspaceRoot, home, env, cwd, executable, args})
//                 async → {executable, args, env, cwd}: what the caller spawns instead of the
//                 original command. Callers keep their own spawn, timeout, process-group and Stop
//                 code, so the returned process must stay in the caller's process group (no setsid).
//                 It must throw rather than return a launch that is less isolated than promised.
import { hostBackend } from './host.mjs';
import { sandboxBackend } from './sandbox.mjs';
import { ensure } from '../store.mjs';

const REGISTRY=new Map([[hostBackend.id,hostBackend],[sandboxBackend.id,sandboxBackend]]);
const overrides=new Map();
export const EXECUTION_BACKEND_IDS=Object.freeze([...REGISTRY.keys()]);

/** Test seam only: replaces a registered backend in this process. Never reachable from requests or models. */
export function overrideExecutionBackendForTests(id,backend){ensure(REGISTRY.has(id),500,'Unknown execution backend.');if(backend)overrides.set(id,backend);else overrides.delete(id);}
export function executionBackend(id){return overrides.get(id) || REGISTRY.get(id) || null;}

/** Owner-only bot field. Absent or null means host (today's behaviour). Returns the value to store, or null to remove it. */
export function validateExecution(value) {
  if(value===null || value===undefined || value==='')return null;
  ensure(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(key=>key==='backend'),400,'Use {backend} for where commands run.');
  ensure(typeof value.backend==='string' && REGISTRY.has(value.backend),400,`Choose where commands run: ${EXECUTION_BACKEND_IDS.join(' or ')}.`);
  return value.backend==='host'?null:{backend:value.backend};
}

/**
 * Applies the owner's bot settings input: `execution` ({backend}) or the settings form's flat
 * `executionBackend`. An unchanged value is kept even when this engine lacks that backend (a bot synced
 * from another engine), so saving other settings never fails; that bot's commands then ask first here.
 */
export function applyExecutionInput(bot,input) {
  if(Object.hasOwn(input,'execution') || Object.hasOwn(input,'executionBackend')) {
    const requested=Object.hasOwn(input,'execution')?input.execution:input.executionBackend?{backend:input.executionBackend}:null;
    const unchanged=requested && typeof requested==='object' && Object.keys(requested).length===1 && typeof requested.backend==='string' && requested.backend===bot.execution?.backend;
    if(!unchanged){const execution=validateExecution(requested);if(execution)bot.execution=execution;else delete bot.execution;}
  }
  delete bot.executionBackend;
  return bot;
}

/** The backend a bot selects. Unknown ids are kept so they can be reported as unavailable, never as host. */
export function selectedBackend(bot){const id=bot?.execution?.backend;return typeof id==='string' && id?id:'host';}

/** Availability of every registered backend on this Engine, for GET /api/execution. */
export async function executionStatus() {
  return Promise.all(EXECUTION_BACKEND_IDS.map(async id=>{
    const backend=executionBackend(id);let status;
    try{status=await backend.available();}catch(error){status={ok:false,reason:error.message};}
    const description=backend.describe?.() || {};
    return {id,label:backend.label,available:Boolean(status?.ok),reason:status?.ok?'':String(status?.reason || 'Unavailable.'),isolated:Boolean(backend.isolated),summary:description.summary || ''};
  }));
}

// Lazy to avoid an import cycle with agent-tools.mjs (which imports the terminal, which imports this).
async function botPaths(store,botId) {
  const [{getWorkspaceRoot},{getProcessHome,processEnvironment}]=await Promise.all([import('../agent-tools.mjs'),import('../process-environment.mjs')]);
  const workspaceRoot=await getWorkspaceRoot(store,botId),home=await getProcessHome(store,botId);
  await processEnvironment(home);
  return {dataDir:store.directory,botId,workspaceRoot,home};
}

/**
 * Whether the bot's selected backend can run its next command, checked at admission by the policy.
 * {backend, isolated, ready, reason}. Host is always ready and never isolated.
 */
export async function executionReadiness({store,bot}) {
  const id=selectedBackend(bot);
  if(id==='host')return {backend:'host',isolated:false,ready:true,reason:''};
  const backend=executionBackend(id);
  if(!backend)return {backend:id,isolated:false,ready:false,reason:'This engine does not have that place to run commands.'};
  try {
    const status=await backend.available();
    if(!status.ok)return {backend:id,isolated:false,ready:false,reason:status.reason || 'Unavailable.'};
    await backend.check?.(await botPaths(store,bot.id));
    return {backend:id,isolated:Boolean(backend.isolated),ready:true,reason:''};
  } catch(error){return {backend:id,isolated:false,ready:false,reason:error.message || 'Unavailable.'};}
}

// Commands whose approval was decided while the selected backend was not ready: the owner (or the
// host policy) accepted running them on the host, so they may fall back. Keyed by the exact call
// arguments object the Engine later executes; every other command fails closed instead.
const disclosedFallbacks=new WeakMap();
export function noteHostFallback(args,reason){if(args && typeof args==='object')disclosedFallbacks.set(args,String(reason || 'The selected place to run commands is unavailable.'));}
export function clearHostFallback(args){if(args && typeof args==='object')disclosedFallbacks.delete(args);}
export function hostFallbackFor(args){return args && typeof args==='object'?disclosedFallbacks.get(args) || null:null;}

/**
 * Turns one process start into what the caller spawns. Returns {executable,args,env,cwd,backend} and,
 * after a disclosed fallback, `fallbackReason`. Host bots get exactly the original launch.
 * When the bot selects another backend and it cannot be used, the start fails unless `hostFallback`
 * says the approval already covered running on the host.
 */
export async function prepareLaunch({store,bot,botId=bot?.id,workspaceRoot,home,env,cwd,executable,args,hostFallback=null}) {
  const id=selectedBackend(bot),launch={executable,args:[...args],env:{...env},cwd};
  if(id==='host')return {...await hostBackend.prepare(launch),backend:'host'};
  const backend=executionBackend(id);
  try {
    if(!backend)throw Object.assign(new Error('This engine does not have that place to run commands.'),{status:409,code:'sandbox_unavailable'});
    const status=await backend.available();
    if(!status.ok)throw Object.assign(new Error(status.reason || 'Unavailable.'),{status:409,code:'sandbox_unavailable'});
    const prepared=await backend.prepare({dataDir:store.directory,botId,workspaceRoot,home,...launch});
    return {...prepared,backend:id};
  } catch(error) {
    if(hostFallback)return {...await hostBackend.prepare(launch),backend:'host',fallbackReason:hostFallback};
    const failure=new Error(`Not run: this bot’s commands must run in its ${backend?.label || id}, which is unavailable (${error.message}). Nothing ran on this computer.`);
    throw Object.assign(failure,{status:409,code:'sandbox_unavailable'});
  }
}

/** Fields added to a command result so receipts show where it ran. Nothing is added for plain host bots. */
export function launchReceipt(launch){return launch.backend!=='host'?{backend:launch.backend}:launch.fallbackReason?{backend:'host',sandboxUnavailable:launch.fallbackReason}:{};}
