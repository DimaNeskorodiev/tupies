// Engine-local record of saved scripts: which exact versions the owner approved, and recent runs.
//
// It lives in <dataDir>/script-ledger/<botId>.json (0600 in a 0700 folder), never in the workspace, a
// process home, state.json or a synced document. Sandboxed commands cannot write the data folder, and
// nothing a model, a synced manifest or a teammate writes reaches this file: only the owner's approval
// card (engine control), the owner's own Run/Approve/Revoke from the app, and the engine's run receipts.
//
// A version is a script package digest (lib/scripts.mjs packageDigest): any byte change of a source file
// or of the manifest metadata makes a new version, which has no approval.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite, ensure, now } from './store.mjs';
import { classifyCode, classifyCommand, riskRank } from './command-classifier.mjs';
import { executionBackend, selectedBackend } from './exec/index.mjs';

export const SCRIPT_RUN_TOOLS=new Set(['script_run','scripts_run']);
export const LEDGER_LIMITS=Object.freeze({runs:20,approvals:3,scripts:400,output:2000,source:65_536,diffLines:200,diffChars:12_000});
const SHA=/^[a-f0-9]{64}$/,SLUG=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,BOT=/^[a-zA-Z0-9_-]{1,100}$/;
const caches=new Map(),queues=new Map();
const empty=()=>({version:1,scripts:{}});
const fileFor=(store,botId)=>path.join(store.directory,'script-ledger',`${botId}.json`);
const keyFor=(store,botId)=>`${store.directory}\n${botId}`;
const clip=(value,max)=>String(value ?? '').slice(0,max);

function clean(value) {
  // A damaged or foreign file never grants anything: unknown shapes are dropped.
  const ledger=empty();
  if(!value || typeof value!=='object' || value.version!==1 || !value.scripts || typeof value.scripts!=='object')return ledger;
  for(const [id,entry] of Object.entries(value.scripts)) {
    if(!SLUG.test(id) || id.length>64 || !entry || typeof entry!=='object')continue;
    const approved=(Array.isArray(entry.approved)?entry.approved:[]).filter(item=>item && SHA.test(item.digest) && typeof item.approvedAt==='string').slice(0,LEDGER_LIMITS.approvals);
    const runs=(Array.isArray(entry.runs)?entry.runs:[]).filter(item=>item && typeof item.at==='string').slice(0,LEDGER_LIMITS.runs);
    ledger.scripts[id]={approved,runs,count:Number.isSafeInteger(entry.count) && entry.count>=0?entry.count:runs.length,...(typeof entry.updatedAt==='string'?{updatedAt:entry.updatedAt}:{})};
  }
  return ledger;
}

/** The bot's ledger, read once per process and then served from memory. */
export async function loadLedger(store,botId) {
  ensure(BOT.test(botId),400,'Invalid bot id.');
  const key=keyFor(store,botId);if(caches.has(key))return caches.get(key);
  let value;
  try{value=clean(JSON.parse(await fs.readFile(fileFor(store,botId),'utf8')));}catch(error){if(error.code!=='ENOENT' && !(error instanceof SyntaxError))throw error;value=empty();}
  if(!caches.has(key))caches.set(key,value);
  return caches.get(key);
}

/** Synchronous view for decisions that are re-checked inside approval; null until loaded. */
export function cachedLedger(store,botId){return caches.get(keyFor(store,botId)) || null;}

async function change(store,botId,mutate) {
  const key=keyFor(store,botId),previous=queues.get(key) || Promise.resolve();
  const operation=previous.catch(()=>{}).then(async()=>{
    const ledger=await loadLedger(store,botId),result=mutate(ledger);
    const ids=Object.keys(ledger.scripts);
    if(ids.length>LEDGER_LIMITS.scripts)for(const id of ids.sort((a,b)=>String(ledger.scripts[a].updatedAt || '').localeCompare(String(ledger.scripts[b].updatedAt || ''))).slice(0,ids.length-LEDGER_LIMITS.scripts))delete ledger.scripts[id];
    const folder=path.join(store.directory,'script-ledger');
    await fs.mkdir(folder,{recursive:true,mode:0o700});await fs.chmod(folder,0o700);
    ensure(!(await fs.lstat(folder)).isSymbolicLink(),500,'Script ledger storage cannot be a symbolic link.');
    await atomicWrite(fileFor(store,botId),JSON.stringify(ledger)+'\n');
    return result;
  });
  queues.set(key,operation);
  try{return await operation;}finally{if(queues.get(key)===operation)queues.delete(key);}
}
const entryOf=(ledger,id)=>ledger.scripts[id] ||= {approved:[],runs:[],count:0};

/** Approval record of this exact version, or null. */
export function approvalOf(ledger,id,digest){return ledger?.scripts?.[id]?.approved?.find(item=>item.digest===digest) || null;}
/** The most recently approved version of a script, or null. */
export function latestApproval(ledger,id){return ledger?.scripts?.[id]?.approved?.[0] || null;}

/**
 * Records the owner's approval of one exact version. `how` is 'card' (an approval card in a task),
 * 'owner-run' (the owner pressed Run on this version) or 'owner' (Approve in the app). Callers are
 * Engine code paths that only the owner can reach; nothing here is reachable from model output.
 */
export async function approveVersion(store,botId,id,{digest,how,runId,entrypoint,entrySource}) {
  ensure(SLUG.test(id) && SHA.test(digest) && ['card','owner-run','owner'].includes(how),400,'Invalid script approval.');
  return change(store,botId,ledger=>{
    const entry=entryOf(ledger,id),at=now();
    const record={digest,approvedAt:at,how,...(runId?{runId:clip(runId,120)}:{}),...(entrypoint?{entrypoint:clip(entrypoint,180)}:{}),...(typeof entrySource==='string' && entrySource.length<=LEDGER_LIMITS.source?{entrySource}:{})};
    entry.approved=[record,...entry.approved.filter(item=>item.digest!==digest)].slice(0,LEDGER_LIMITS.approvals);
    // Only the newest approval keeps its source for later diffs.
    entry.approved=entry.approved.map((item,index)=>index===0?item:(({entrySource,...rest})=>rest)(item));
    entry.updatedAt=at;
    return record;
  });
}

/** Removes the approval of one version (or every version when digest is omitted). */
export async function revokeVersion(store,botId,id,digest) {
  ensure(SLUG.test(id) && (digest===undefined || SHA.test(digest)),400,'Invalid script approval.');
  return change(store,botId,ledger=>{
    const entry=entryOf(ledger,id),before=entry.approved.length;
    entry.approved=digest?entry.approved.filter(item=>item.digest!==digest):[];entry.updatedAt=now();
    return {revoked:before-entry.approved.length};
  });
}

/** Head and tail of a run's output, at most `max` characters, already redacted by the caller. */
export function outputExcerpt(text,max=LEDGER_LIMITS.output) {
  const value=String(text ?? '');if(value.length<=max)return value;
  const half=Math.floor((max-20)/2);return `${value.slice(0,half)}\n…[truncated]…\n${value.slice(-half)}`;
}

/** Adds one run record; keeps the newest LEDGER_LIMITS.runs and a total counter. Records carry no model usage. */
export async function recordScriptRun(store,botId,id,record) {
  if(!SLUG.test(id))return null;
  const run={at:record.at || now(),startedBy:['bot','routine','owner','teammate'].includes(record.startedBy)?record.startedBy:'bot',...(record.runId?{runId:clip(record.runId,120)}:{}),...(record.routineId?{routineId:clip(record.routineId,120)}:{}),
    ...(SHA.test(record.digest)?{digest:record.digest,version:record.digest.slice(0,12)}:{}),status:clip(record.status || 'failed',40),exitCode:Number.isInteger(record.exitCode)?record.exitCode:null,
    durationMs:Number.isFinite(record.durationMs) && record.durationMs>=0?Math.round(record.durationMs):null,backend:clip(record.backend || 'host',40),output:outputExcerpt(store.redact(String(record.output ?? '')))};
  return change(store,botId,ledger=>{const entry=entryOf(ledger,id);entry.runs=[run,...entry.runs].slice(0,LEDGER_LIMITS.runs);entry.count=(entry.count || 0)+1;entry.updatedAt=run.at;return run;});
}

/** Owner-facing run counters. */
export function runSummary(ledger,id) {
  const entry=ledger?.scripts?.[id],last=entry?.runs?.[0];
  return {count:entry?.count || 0,lastAt:last?.at || null,lastStatus:last?.status || null,lastDurationMs:last?.durationMs ?? null};
}

/** Worst classifier verdict over a package's code files. Large or unreadable code counts as dangerous. */
export function classifyPackage(files) {
  let worst={risk:'read_only',reasons:[]};
  for(const [relative,bytes] of files) {
    const text=Buffer.isBuffer(bytes)?bytes.toString('utf8'):String(bytes);
    const verdict=/\.py$/.test(relative)?classifyCode('python',text):/\.(?:mjs|cjs|js)$/.test(relative)?classifyCode('node',text):/\.sh$/.test(relative)?classifyCommand(text):null;
    if(!verdict)continue;
    if(riskRank(verdict.risk)>riskRank(worst.risk))worst={risk:verdict.risk,reasons:verdict.reasons.map(reason=>`${relative}: ${reason}`)};
    else if(verdict.risk===worst.risk && verdict.risk!=='read_only')worst.reasons.push(...verdict.reasons.map(reason=>`${relative}: ${reason}`));
  }
  return {risk:worst.risk,reasons:worst.reasons.slice(0,6)};
}

/** Plain words for how a version relates to what the owner approved. */
export function versionState(ledger,id,digest) {
  if(approvalOf(ledger,id,digest))return {state:'approved',approval:approvalOf(ledger,id,digest)};
  const latest=latestApproval(ledger,id);
  return latest?{state:'changed',approval:latest}:{state:'new',approval:null};
}

/**
 * A bounded unified diff of two texts (line based, common prefix/suffix trimmed, LCS in between).
 * Returns '' when equal; a short note when the changed region is too large to compare.
 */
export function unifiedDiff(before,after,{from='approved',to='current'}={}) {
  if(before===after)return '';
  const a=String(before ?? '').split('\n'),b=String(after ?? '').split('\n');
  let start=0;while(start<a.length && start<b.length && a[start]===b[start])start++;
  let endA=a.length,endB=b.length;while(endA>start && endB>start && a[endA-1]===b[endB-1]){endA--;endB--;}
  const x=a.slice(start,endA),y=b.slice(start,endB),lines=[`--- ${from}`,`+++ ${to}`];
  const context=Math.max(0,start-3),tail=Math.min(a.length,endA+3);
  lines.push(`@@ -${context+1} +${context+1} @@`);
  for(let i=context;i<start;i++)lines.push(` ${a[i]}`);
  if(x.length*y.length>2_250_000) {
    for(const line of x)lines.push(`-${line}`);for(const line of y)lines.push(`+${line}`);
  } else {
    const width=y.length+1,table=new Uint32Array((x.length+1)*width);
    for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)table[i*width+j]=x[i]===y[j]?table[(i+1)*width+j+1]+1:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
    let i=0,j=0;
    while(i<x.length || j<y.length) {
      if(i<x.length && j<y.length && x[i]===y[j]){lines.push(` ${x[i]}`);i++;j++;}
      else if(i<x.length && (j>=y.length || table[(i+1)*width+j]>=table[i*width+j+1])){lines.push(`-${x[i]}`);i++;}
      else {lines.push(`+${y[j]}`);j++;}
    }
  }
  for(let i=endA;i<tail;i++)lines.push(` ${a[i]}`);
  let text='',count=0;
  for(const line of lines){if(count>=LEDGER_LIMITS.diffLines || text.length+line.length+1>LEDGER_LIMITS.diffChars){text+='… diff truncated\n';break;}text+=line+'\n';count++;}
  return text;
}

// Decisions prepared by lib/saved-scripts.mjs for the call that is being approved, keyed by the call object.
const prepared=new WeakMap();
export function noteScriptDecision(call,details){prepared.set(call,details);}
export function forgetScriptDecision(call){prepared.delete(call);}

/**
 * Synchronous approval decision for script_run / scripts_run, called through engineActionDecision (and re-checked
 * inside approval). Returns null to keep the legacy path (scripts_run on the host), else {automatic, reason}.
 * Rules: Terminal off, a dangerous classifier verdict, Strict, or a version the owner has not approved always ask.
 * An approved version runs without a card only when snapshot and saved bot select the same ready isolated backend
 * under Balanced or Approve for me (every lane). On the host every script_run asks.
 */
export function scriptRunDecision({store,context,call,currentBot,policy}) {
  const details=prepared.get(call);
  if(!details)return call?.name==='scripts_run'?null:{automatic:false,reason:'Review this exact script run.'};
  const ledger=cachedLedger(store,context.bot.id),version=versionState(ledger,details.id,details.digest);
  const wanted=selectedBackend(context.bot),label=executionBackend(wanted)?.noun || wanted;
  const ready=wanted!=='host' && details.readiness?.backend===wanted && details.readiness.ready===true;
  const isolated=ready && Boolean(details.readiness.isolated) && selectedBackend(currentBot)===wanted;
  const where=wanted==='host'?' It runs on this computer without isolation.':ready?` It will run in this bot’s ${label}.`:` The ${label} is unavailable (${details.readiness?.reason || 'not checked yet'}), so it would run on this computer without isolation.`;
  const manual=reason=>({automatic:false,reason:reason+where,review:{scriptVersion:version.state}});
  const title=details.title || details.id;
  // The legacy tool keeps exactly its earlier rules wherever no ready isolated backend is involved.
  if(call.name==='scripts_run' && !isolated)return null;
  if(!currentBot || !Array.isArray(currentBot.tools) || !currentBot.tools.includes('terminal'))return manual('Terminal access is no longer enabled for this bot. Review this exact script.');
  if(details.danger?.risk==='dangerous')return manual(`Dangerous: ${details.danger.reasons.join('; ') || 'unclassified risk'}. Review this exact script.`);
  if(policy==='strict')return manual('Strict review: every script run waits for your approval.');
  if(version.state==='new')return manual(`New script “${title}”: you have not approved any version of it. Allowing it approves this exact version.`);
  if(version.state==='changed')return manual(`“${title}” changed since the version you approved. Allowing it approves this exact version.`);
  if(isolated)return {automatic:true,reason:`You approved this exact version of “${title}”; it runs in this bot’s ${label}.`};
  return manual(`You approved this version of “${title}”, but outside a ready sandbox each run waits for your approval.`);
}
