// "Scripts first": the simple save/run tools on top of the script package format in lib/scripts.mjs.
//
// script_save writes the entry file (and a README when none is given), computes every hash itself and registers the
// package in one call. script_run runs the current registered version through the execution backend registry with
// literal arguments; named inputs arrive as `--name value` argument pairs and as one JSON object in the environment
// variable TUPIES_SCRIPT_INPUTS. Nothing is ever interpolated into a shell string.
//
// Approval is per exact version (package digest) and is kept engine-locally in lib/script-ledger.mjs. This module also
// keeps the per-script run history, the owner's API (run/approve/revoke from the app, no model involved) and the small
// display-only "save this as a script" suggestion attached to a finished chat reply.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensure, HttpError } from './store.mjs';
import { safePath, getWorkspaceRoot, groupsFor, writeWorkspace } from './agent-tools.mjs';
import { readText } from './workspace-code.mjs';
import { getProcessHome, processEnvironment } from './process-environment.mjs';
import { executionReadiness, prepareLaunch, selectedBackend } from './exec/index.mjs';
import { SCRIPT_LIMITS, scriptInternals, listScripts, inspectScript, registerScript, prepareScriptRun, runScript } from './scripts.mjs';
import { loadLedger, approvalOf, latestApproval, approveVersion, revokeVersion, recordScriptRun, runSummary, classifyPackage, versionState, unifiedDiff, noteScriptDecision, forgetScriptDecision, outputExcerpt, LEDGER_LIMITS } from './script-ledger.mjs';
import { ownerChat } from './command-policy.mjs';
import { sessionMessages } from './chat-sessions.mjs';

export const SCRIPT_INPUTS_ENV='TUPIES_SCRIPT_INPUTS';
const LANGUAGES=Object.freeze({python:{interpreter:'python3',ext:'py'},node:{interpreter:'node',ext:'mjs'},bash:{interpreter:'bash',ext:'sh'}});
const LANGUAGE_OF=Object.freeze({python3:'python',node:'node',bash:'bash'});
const INPUT_NAME=/^[a-z][a-z0-9_]{0,39}$/,README_MARK='<!-- Written by script_save; edit freely, or pass readme to replace it. -->';
const OWNER_TIMEOUT_MAX=600_000,OWNER_OUTPUT_MAX=1_000_000,OWNER_STREAM_RETURN=64_000;
const pendingRuns=new WeakMap(),runInfo=new WeakMap();
const check=(condition,message,status=400)=>ensure(condition,status,message);
const plainText=(value,max,label,{required=true}={})=>{if(value===undefined && !required)return undefined;check(typeof value==='string' && (!required || value.trim()) && value.length<=max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value),`${label} must contain ${required?1:0}–${max} text characters.`);return value.trim();};
const shortVersion=digest=>typeof digest==='string'?digest.slice(0,12):null;

// ---- Inputs: stored in the manifest's existing `inputs` text list in a fixed, parseable form ----

/** One declared input as manifest text: `name (required) (default "x"): description`. Older free-text inputs stay valid. */
export function formatInput({name,description,required=false,default:fallback}) {
  return `${name}${required?' (required)':''}${fallback!==undefined?` (default ${JSON.stringify(fallback)})`:''}: ${description}`;
}
/** Structured inputs from the manifest text list; free-text entries are returned without a name. */
export function parseInputs(lines=[]) {
  return (Array.isArray(lines)?lines:[]).map(line=>{
    const match=typeof line==='string' && line.match(/^([a-z][a-z0-9_]{0,39})( \(required\))?(?: \(default ("(?:[^"\\]|\\.)*")\))?: ([\s\S]+)$/);
    if(!match)return {name:null,description:String(line)};
    let fallback;if(match[3]!==undefined)try{fallback=JSON.parse(match[3]);}catch{fallback=undefined;}
    return {name:match[1],description:match[4],required:Boolean(match[2]),...(typeof fallback==='string'?{default:fallback}:{})};
  });
}
function validInputs(value) {
  if(value===undefined)return [];
  check(Array.isArray(value) && value.length<=12,'Declare at most 12 inputs.');
  const seen=new Set();
  return value.map(item=>{
    check(item && typeof item==='object' && !Array.isArray(item) && Object.keys(item).every(key=>['name','description','required','default'].includes(key)),'Each input is {name, description, required?, default?}.');
    check(typeof item.name==='string' && INPUT_NAME.test(item.name) && !seen.has(item.name),'Input names are distinct lowercase words such as url or max_items.');seen.add(item.name);
    check(item.required===undefined || typeof item.required==='boolean','Input required must be true or false.');
    const description=plainText(item.description,300,'Input description'),fallback=plainText(item.default,500,'Input default',{required:false});
    check(!/[\r\n]/.test(description),'Keep each input description on one line.');
    return {name:item.name,description,required:item.required===true,...(fallback!==undefined?{default:fallback}:{})};
  });
}

/**
 * The literal argument vector and input object for one run. Declared inputs are checked (unknown names, missing
 * required values) and defaults applied; values are passed as two literal arguments each, never through a shell.
 */
export function buildInvocation(declared,{args,inputs}={}) {
  const positional=args===undefined?[]:args;
  check(Array.isArray(positional) && positional.length<=20 && positional.every(value=>typeof value==='string' && value.length<=2000 && !value.includes('\0')),'Give up to 20 literal text arguments.');
  check(inputs===undefined || inputs && typeof inputs==='object' && !Array.isArray(inputs),'Give inputs as an object of names and values.');
  const named=declared.filter(item=>item.name),known=new Set(named.map(item=>item.name)),values={};
  for(const [name,value] of Object.entries(inputs || {})) {
    check(INPUT_NAME.test(name),`Input name ${JSON.stringify(name).slice(0,60)} is not valid.`);
    check(!named.length || known.has(name),`This script has no input named ${name}. Its inputs: ${[...known].join(', ') || 'none'}.`);
    check(['string','number','boolean'].includes(typeof value),`Input ${name} must be text, a number or true/false.`);
    const text=String(value);check(text.length<=2000 && !text.includes('\0'),`Input ${name} must be at most 2000 characters.`);
    values[name]=text;
  }
  for(const item of named)if(values[item.name]===undefined && item.default!==undefined)values[item.name]=item.default;
  const missing=named.filter(item=>item.required && values[item.name]===undefined).map(item=>item.name);
  check(!missing.length,`Missing required input: ${missing.join(', ')}.`);
  const order=[...named.map(item=>item.name).filter(name=>values[name]!==undefined),...Object.keys(values).filter(name=>!known.has(name))];
  const argv=[...order.flatMap(name=>[`--${name}`,values[name]]),...positional];
  check(argv.length<=30,'A run takes at most 30 literal arguments in total (each input counts as two).');
  return {argv,inputs:Object.fromEntries(order.map(name=>[name,values[name]]))};
}

// ---- script_save ----

function generatedReadme({title,purpose,language,entrypoint,inputs}) {
  const usage=inputs.length?inputs.map(item=>`- \`--${item.name}\`${item.required?' (required)':''}${item.default!==undefined?` (default \`${item.default}\`)`:''}: ${item.description}`).join('\n'):'- none';
  return `# ${title}\n\n${README_MARK}\n\n${purpose}\n\n## Run\n\n${language} \`${entrypoint}\`, started in the bot's workspace folder.\n\n## Inputs\n\n${usage}\n\nEach named input arrives as the two arguments \`--name value\`, and all inputs together as a JSON object in the \`${SCRIPT_INPUTS_ENV}\` environment variable. Other literal arguments follow.\n`;
}

async function readCatalog(base,signal) {
  try {
    const raw=await readText({root:base,resolve:safePath,signal},scriptInternals.MANIFEST);
    let value=null;try{value=JSON.parse(raw.content);}catch{value=null;}
    return {sha256:raw.sha256,value};
  } catch(error){if(error.code==='ENOENT' || error.status===404)return null;throw error;}
}

/** script_save: writes the entry file and README, computes the hashes and registers the package. Never runs anything. */
export async function saveScript(store,bot,args,{signal}={}) {
  check(groupsFor(bot).includes('workspace') && groupsFor(bot).includes('terminal'),'Enable Files and Terminal to save scripts.',403);
  const id=scriptInternals.scriptId(args?.id),language=LANGUAGES[args?.language];
  check(language,'Choose python, node or bash.');
  const title=plainText(args.title,160,'Script title'),purpose=plainText(args.purpose,2000,'Script purpose');
  check(typeof args.code==='string' && args.code.trim() && Buffer.byteLength(args.code)<=SCRIPT_LIMITS.fileBytes && !args.code.includes('\0'),'Give the complete script source (up to 1 MB of text).');
  const inputs=validInputs(args.inputs),readme=plainText(args.readme,20000,'README',{required:false});
  check(args.files===undefined || Array.isArray(args.files) && args.files.length<=30 && args.files.every(item=>typeof item==='string'),'List up to 30 extra package files.');
  for(const item of args.files || [])check(item.length<=180 && !path.isAbsolute(item) && !/[\\:\r\n\0]/.test(item) && item!==scriptInternals.MANIFEST && item.split('/').every(part=>part && part!=='.' && part!=='..' && !part.startsWith('.')),'Extra files must be fixed package-relative paths inside scripts/<id>/, without hidden files or traversal.');
  check(store.redact(args.code)===args.code && store.redact(readme || '')===(readme || ''),'Do not put connection credentials in script source.');
  const root=await getWorkspaceRoot(store,bot.id);
  const base=await safePath(root,`scripts/${id}`,{createParents:true,allowMissing:true});
  await fs.mkdir(base,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const folder=await fs.lstat(base);check(folder.isDirectory() && !folder.isSymbolicLink(),'A script package must be a real folder.');
  let before=await readCatalog(base,signal),previous=null;
  if(before){
    check(before.value && typeof before.value==='object','The existing scripts/'+id+'/script.json is not valid JSON. Fix or remove it, then save again.',409);
    try{previous=(await scriptInternals.registered(store,bot.id,id,signal)).entry;}catch{previous=null;}
  }
  const keep=before?.value?.interpreter===language.interpreter && typeof before.value.entrypoint==='string'?before.value.entrypoint:null;
  const entrypoint=keep || `main.${language.ext}`;
  await writeWorkspace(store,bot.id,`scripts/${id}/${entrypoint}`,args.code);
  const readmePath=`scripts/${id}/README.md`;
  const existing=await readText({root,resolve:safePath,signal},readmePath).then(file=>file.content,error=>{if(error.code==='ENOENT' || error.status===404)return null;throw error;});
  if(readme!==undefined)await writeWorkspace(store,bot.id,readmePath,readme.endsWith('\n')?readme:readme+'\n');
  else if(existing===null || existing.includes(README_MARK))await writeWorkspace(store,bot.id,readmePath,generatedReadme({title,purpose,language:args.language,entrypoint,inputs}));
  const paths=[...new Set([entrypoint,'README.md',...(args.files || [])])];
  const files=[];
  for(const relative of paths){const file=await readText({root:base,resolve:safePath,signal},relative);files.push({path:relative,sha256:file.sha256});}
  const result=await registerScript(store,bot.id,{id,title,purpose,interpreter:language.interpreter,entrypoint,files,inputs:inputs.map(formatInput),outputs:Array.isArray(before?.value?.outputs)?before.value.outputs:[],dependencies:Array.isArray(before?.value?.dependencies)?before.value.dependencies:[],...(before?{expectedManifestSha256:before.sha256}:{})},{signal});
  const script=result.script,ledger=await loadLedger(store,bot.id);
  const changed=!previous || previous.registeredDigest!==script.digest;
  return {saved:true,script:{id,title:script.title,purpose:script.purpose,language:args.language,entrypoint:script.entrypoint,inputs:inputs.map(({name,description,required,default:fallback})=>({name,description,required,...(fallback!==undefined?{default:fallback}:{})})),version:shortVersion(script.digest),digest:script.digest,files:script.files.map(file=>file.path)},
    newVersion:changed,...(previous?{previousVersion:shortVersion(previous.registeredDigest)}:{}),approved:Boolean(approvalOf(ledger,id,script.digest)),
    notice:changed?'Saved. Nothing ran. The first script_run of this version shows the owner one approval card.':'Saved with no change; the version is the same.'};
}

// ---- script_run (bot tasks) ----

const startedByOf=context=>context.routine?.id || context.source==='routine'?'routine':context.delegation?.depth?'teammate':'bot';

/** Engine: resolves a script_run call to the current registered version and the legacy prepared run. */
export async function prepareSavedScriptRun(engine,context,args,{signal}={}) {
  const store=engine.store,bot=context.bot;
  check(groupsFor(bot).includes('workspace') && groupsFor(bot).includes('terminal'),'Enable Files and Terminal to run a script.',403);
  const id=scriptInternals.scriptId(args?.id);
  check(args.timeoutMs===undefined || Number.isSafeInteger(args.timeoutMs) && args.timeoutMs>=100 && args.timeoutMs<=1_800_000,'Script timeout must be 100–1800000 milliseconds.');
  const pkg=await scriptInternals.registered(store,bot.id,id,signal);
  check(pkg.entry.status==='registered',`scripts/${id} changed since it was saved. Save it again with script_save (that makes a new version) before running it.`,409);
  const {argv,inputs}=buildInvocation(scriptInputs(pkg.meta),args);
  for(const value of argv)check(store.redact(value)===value,'Do not pass connection credentials as script arguments.');
  const legacyArgs={scriptId:id,digest:pkg.entry.digest,args:argv,timeoutMs:args.timeoutMs ?? 120_000};
  const prepared=await prepareScriptRun(store,bot,legacyArgs,{signal,runId:context.runId});
  pendingRuns.set(prepared.identity,{args:JSON.stringify(args),legacyArgs,env:{[SCRIPT_INPUTS_ENV]:JSON.stringify(inputs)}});
  return {...prepared,pkg,review:{...prepared.review,summary:`Run script ${pkg.meta.title} · ${pkg.meta.interpreter} · version ${shortVersion(pkg.entry.digest)}`,script:{...prepared.review.script,inputValues:inputs}}};
}
const scriptInputs=meta=>parseInputs(meta.inputs);

/**
 * Engine: the approval step for script_run and scripts_run. Adds what changed since the approved version to the card,
 * lets lib/script-ledger.mjs decide (through engineActionDecision), and records the version as approved only when the
 * owner allowed it on a card. Automatic decisions never approve a version.
 */
export async function approveScriptRun(engine,context,call,prepared,{signal}={}) {
  const store=engine.store,botId=context.bot.id,script=prepared.review.script,id=script.id,digest=script.digest;
  const pkg=prepared.pkg?.entry?.digest===digest?prepared.pkg:await scriptInternals.registered(store,botId,id,signal).catch(()=>null);
  const ledger=await loadLedger(store,botId),version=versionState(ledger,id,digest);
  const files=pkg?.entry?.digest===digest?pkg.source.bytes:new Map(),entrySource=files.get(pkg?.meta?.entrypoint)?.toString('utf8');
  const danger=pkg?.entry?.digest===digest?classifyPackage(files):{risk:'dangerous',reasons:['the package could not be read for review']};
  const readiness=selectedBackend(context.bot)==='host'?{backend:'host',isolated:false,ready:true,reason:''}:await executionReadiness({store,bot:context.bot});
  const diff=version.state==='changed' && typeof version.approval.entrySource==='string' && typeof entrySource==='string'?unifiedDiff(version.approval.entrySource,entrySource,{from:`approved ${shortVersion(version.approval.digest)}`,to:`current ${shortVersion(digest)}`}):'';
  const words=version.state==='new'?'New script':version.state==='changed'?'Changed since the version you approved':'Approved version';
  const review={...prepared.review,summary:`${words} · ${prepared.review.summary}`,script:{...script,version:shortVersion(digest),risk:danger,change:{state:version.state,words,...(version.approval?{approvedVersion:shortVersion(version.approval.digest),approvedAt:version.approval.approvedAt}:{}),...(diff?{diff}:{})}}};
  noteScriptDecision(call,{id,title:pkg?.meta?.title || script.title,digest,danger,readiness});
  let automatic=false,approved;
  try{approved=await engine.approve(context,call,{review,onAutomatic:()=>{automatic=true;}});}
  finally{forgetScriptDecision(call);}
  if(approved===true && !automatic)await approveVersion(store,botId,id,{digest,how:'card',runId:context.runId,entrypoint:pkg?.meta?.entrypoint,entrySource});
  runInfo.set(prepared.identity,{startedBy:startedByOf(context),runId:context.runId,...(context.routine?.id?{routineId:context.routine.id}:{})});
  return approved;
}

function historyStatus(result) {
  if(result.timedOut || result.status==='timed_out')return 'timed_out';
  if(result.status==='stopped')return 'stopped';
  return result.exitCode===0 && !result.truncated?'succeeded':'failed';
}
const combined=(stdout,stderr)=>`${stdout || ''}${stderr?`${stdout?'\n':''}[stderr]\n${stderr}`:''}`;
const durationOf=(result,started)=>{const a=Date.parse(result?.startedAt),b=Date.parse(result?.finishedAt);return Number.isFinite(a) && Number.isFinite(b) && b>=a?b-a:Date.now()-started;};

/** scripts_run (and script_run underneath): runs through lib/scripts.mjs and keeps a bounded history record. */
export async function runRecordedScript(store,bot,args,options={}) {
  const started=Date.now(),info=runInfo.get(options.approvedScript) || {startedBy:'bot',runId:options.runId};
  const note=async record=>{try{await recordScriptRun(store,bot.id,args?.scriptId,{...info,digest:args?.digest,...record});}catch{/* History never changes the run's result. */}};
  try {
    const result=await runScript(store,bot,args,options);
    await note({status:historyStatus(result),exitCode:result.exitCode,durationMs:durationOf(result,started),backend:result.backend || 'host',output:combined(result.stdout,result.stderr)});
    return result;
  } catch(error) {
    if(error.scriptDispatched)await note({status:'failed',exitCode:null,durationMs:Date.now()-started,output:error.message});
    throw error;
  }
}

/** agent-tools: executes an approved script_run. */
export async function runSavedScript(store,bot,args,{signal,runId,processes,approvedScript}={}) {
  const pending=pendingRuns.get(approvedScript);
  check(pending && pending.args===JSON.stringify(args),'This script requires its exact engine-prepared approval.',403);
  pendingRuns.delete(approvedScript);
  const result=await runRecordedScript(store,bot,pending.legacyArgs,{signal,runId,processes,approvedScript,env:pending.env});
  return {...result,id:pending.legacyArgs.scriptId,version:shortVersion(result.digest)};
}

// ---- Model views ----

/** scripts_list / scripts_inspect for the model: runs only as a count and the last status. */
export async function modelScriptView(store,botId,value) {
  const ledger=await loadLedger(store,botId);
  const add=entry=>entry && typeof entry==='object' && entry.id?{...entry,runs:{count:runSummary(ledger,entry.id).count,lastStatus:runSummary(ledger,entry.id).lastStatus}}:entry;
  return Array.isArray(value?.scripts)?{...value,scripts:value.scripts.map(add)}:add(value);
}

// ---- Owner API ----

function usedBy(state,botId,id) {
  return (state.routines || []).filter(routine=>routine.botId===botId && Array.isArray(routine.workflow?.steps) && routine.workflow.steps.some(step=>step?.op==='script' && step.scriptId===id)).map(routine=>({routineId:routine.id,name:routine.name || routine.id}));
}
function ownerFields(state,botId,entry,ledger) {
  const digest=entry.digest,registered=entry.status==='registered',latest=latestApproval(ledger,entry.id);
  return {...entry,language:LANGUAGE_OF[entry.interpreter] || null,inputFields:parseInputs(entry.inputs),version:shortVersion(digest),approvedVersion:latest?shortVersion(latest.digest):null,...(latest?{approvedAt:latest.approvedAt,approvedHow:latest.how}:{}),
    needsApproval:registered && !approvalOf(ledger,entry.id,digest),runnable:registered && Boolean(entry.runtimeAvailable),runs:runSummary(ledger,entry.id),usedBy:usedBy(state,botId,entry.id)};
}

/** GET /api/bots/:id/scripts */
export async function ownerListScripts(store,botId) {
  const listed=await listScripts(store,botId),ledger=await loadLedger(store,botId);
  return {...listed,scripts:listed.scripts.map(entry=>entry.status==='invalid'?{...entry,runs:runSummary(ledger,entry.id),usedBy:usedBy(store.state,botId,entry.id),needsApproval:false,runnable:false}:ownerFields(store.state,botId,entry,ledger))};
}

/** GET /api/bots/:id/scripts/:scriptId */
export async function ownerInspectScript(store,botId,id) {
  const entry=await inspectScript(store,botId,id),ledger=await loadLedger(store,botId),fields=ownerFields(store.state,botId,entry,ledger);
  let source=null;
  if(entry.entrypointRelative)try{
    const root=await getWorkspaceRoot(store,botId),file=await readText({root,resolve:safePath},`scripts/${id}/${entry.entrypointRelative}`);
    source={path:`scripts/${id}/${entry.entrypointRelative}`,content:file.content.slice(0,LEDGER_LIMITS.source),truncated:file.content.length>LEDGER_LIMITS.source};
  }catch{source=null;}
  const latest=latestApproval(ledger,id);
  const diff=latest && latest.digest!==entry.digest && typeof latest.entrySource==='string' && source && !source.truncated?unifiedDiff(latest.entrySource,source.content,{from:`approved ${shortVersion(latest.digest)}`,to:`current ${shortVersion(entry.digest)}`}):'';
  return {...fields,source,history:structuredClone(ledger.scripts[id]?.runs || []),...(diff?{diff}:{})};
}

function matchVersion(digest,version) {
  check(typeof version==='string' && /^[a-f0-9]{12,64}$/.test(version),'Give the script version you reviewed.');
  return digest.startsWith(version);
}

/** Runs one exact version for the owner, with no model and no task, through the bot's selected backend. */
async function spawnOwnerRun({store,bot,pkg,argv,inputs,timeoutMs}) {
  ensure(pkg.hostRuntime,409,`The ${pkg.meta.interpreter} interpreter is unavailable on this engine.`);
  const root=await getWorkspaceRoot(store,bot.id),home=await getProcessHome(store,bot.id),env={...await processEnvironment(home),[SCRIPT_INPUTS_ENV]:JSON.stringify(inputs)};
  const where=await executionReadiness({store,bot}),hostFallback=where.ready?null:(where.reason || 'unavailable');
  const execution=await fs.mkdtemp(path.join(home,'.script-run-'));
  try {
    for(const [relative,bytes] of pkg.source.bytes){const target=path.join(execution,relative);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});}
    const launch=await prepareLaunch({store,bot,workspaceRoot:root,home,env,cwd:root,executable:pkg.hostRuntime.path,args:[path.join(execution,pkg.meta.entrypoint),...argv],hostFallback});
    const started=Date.now();
    return await new Promise((resolve,reject)=>{
      const streams={stdout:'',stderr:''};let bytes=0,truncated=false,timedOut=false,settled=false;
      const child=spawn(launch.executable,launch.args,{cwd:launch.cwd,env:launch.env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],windowsHide:true});
      const kill=()=>{try{process.platform!=='win32'?process.kill(-child.pid,'SIGKILL'):child.kill('SIGKILL');}catch{/* already gone */}};
      const timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);timer.unref();
      const collect=name=>chunk=>{if(truncated)return;const room=OWNER_OUTPUT_MAX-bytes;bytes+=chunk.length;streams[name]+=chunk.subarray(0,Math.max(0,room)).toString('utf8');if(bytes>OWNER_OUTPUT_MAX){truncated=true;kill();}};
      child.stdout.on('data',collect('stdout'));child.stderr.on('data',collect('stderr'));
      child.once('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(new HttpError(409,`The script could not start: ${error.code || error.message}.`));});
      child.once('close',(code,signal)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({exitCode:Number.isInteger(code)?code:null,signal:signal || null,timedOut,truncated,stdout:streams.stdout,stderr:streams.stderr,durationMs:Date.now()-started,backend:launch.backend,...(launch.fallbackReason?{sandboxUnavailable:launch.fallbackReason}:{})});});
    });
  } finally {await fs.rm(execution,{recursive:true,force:true});}
}

/**
 * POST /api/bots/:id/scripts/:scriptId — {action:'run'|'approve'|'revoke', version, ...}. The owner pressing Run on
 * an exact version is the approval of that version; `approve: true` confirms running a version not approved yet.
 * `write` is the route's workspace reservation (bot idle, files writable) for runs.
 */
export async function ownerScriptAction(store,bot,id,input,{write}) {
  scriptInternals.scriptId(id);
  check(input && typeof input==='object' && !Array.isArray(input) && ['run','approve','revoke'].includes(input.action),'Choose action run, approve or revoke.');
  if(input.action==='revoke') {
    check(Object.keys(input).every(key=>['action','version'].includes(key)),'Revoke takes only a version.');
    const ledger=await loadLedger(store,bot.id),targets=input.version===undefined?[undefined]:(ledger.scripts[id]?.approved || []).filter(item=>matchVersion(item.digest,input.version)).map(item=>item.digest);
    let revoked=0;for(const digest of targets)revoked+=(await revokeVersion(store,bot.id,id,digest)).revoked;
    await store.mutate(()=>store.audit('script.approval_revoked',`Revoked approval of ${id}`,bot.id,{scriptId:id,revoked}));
    return {revoked,script:await ownerInspectScript(store,bot.id,id)};
  }
  const pkg=await scriptInternals.registered(store,bot.id,id);
  check(pkg.entry.status==='registered','This script changed since it was saved. Save or register the current files first.',409);
  check(matchVersion(pkg.entry.digest,input.version),'This version is no longer current. Review the current version.',409);
  const digest=pkg.entry.digest,entrySource=pkg.source.bytes.get(pkg.meta.entrypoint)?.toString('utf8');
  if(input.action==='approve') {
    check(Object.keys(input).every(key=>['action','version'].includes(key)),'Approve takes only a version.');
    await approveVersion(store,bot.id,id,{digest,how:'owner',entrypoint:pkg.meta.entrypoint,entrySource});
    await store.mutate(()=>store.audit('script.approved',`Approved ${pkg.meta.title}`,bot.id,{scriptId:id,digest}));
    return {approved:true,script:await ownerInspectScript(store,bot.id,id)};
  }
  check(Object.keys(input).every(key=>['action','version','args','inputs','approve','timeoutMs'].includes(key)),'Run takes version, args, inputs, approve and timeoutMs.');
  const timeoutMs=input.timeoutMs ?? 120_000;check(Number.isSafeInteger(timeoutMs) && timeoutMs>=100 && timeoutMs<=OWNER_TIMEOUT_MAX,`Timeout must be 100–${OWNER_TIMEOUT_MAX} milliseconds.`);
  const {argv,inputs}=buildInvocation(parseInputs(pkg.meta.inputs),input);
  for(const value of argv)check(store.redact(value)===value,'Do not pass connection credentials as script arguments.');
  const ledger=await loadLedger(store,bot.id);
  check(approvalOf(ledger,id,digest) || input.approve===true,'This version is not approved yet. Review it and run again with approve: true.',428);
  return write(async()=>{
    if(!approvalOf(await loadLedger(store,bot.id),id,digest))await approveVersion(store,bot.id,id,{digest,how:'owner-run',entrypoint:pkg.meta.entrypoint,entrySource});
    let result;
    try {result=await spawnOwnerRun({store,bot,pkg,argv,inputs,timeoutMs});}
    catch(error){await recordScriptRun(store,bot.id,id,{startedBy:'owner',digest,status:'failed',exitCode:null,durationMs:0,output:error.message}).catch(()=>{});throw error;}
    const status=historyStatus(result),stdout=store.redact(result.stdout),stderr=store.redact(result.stderr);
    await recordScriptRun(store,bot.id,id,{startedBy:'owner',digest,status,exitCode:result.exitCode,durationMs:result.durationMs,backend:result.backend,output:combined(stdout,stderr)});
    await store.mutate(()=>store.audit('script.run',`Ran ${pkg.meta.title}`,bot.id,{scriptId:id,digest,status}));
    return {status,exitCode:result.exitCode,output:outputExcerpt(combined(stdout,stderr),OWNER_STREAM_RETURN),stdout:stdout.slice(0,OWNER_STREAM_RETURN),stderr:stderr.slice(0,OWNER_STREAM_RETURN),timedOut:result.timedOut,truncated:result.truncated || stdout.length>OWNER_STREAM_RETURN || stderr.length>OWNER_STREAM_RETURN,
      durationMs:result.durationMs,backend:result.backend,...(result.sandboxUnavailable?{sandboxUnavailable:result.sandboxUnavailable}:{}),version:shortVersion(digest),modelCalls:0};
  });
}

// ---- "Save this as a script" suggestion ----

/** The follow-up the suggestion card sends as an ordinary owner chat message. */
export const SCRIPT_SUGGESTION_REQUEST='Save what you just did as a script with script_save so next time it runs in seconds without the model. Pick a clear name, declare its inputs, and tell me how to run it.';
const SUGGESTION_COMMANDS=new Set(['terminal','execute_code','shell_run']),SCRIPT_TOOLS=new Set(['script_save','script_run','scripts_run','scripts_register']);

/**
 * Display-only record for a finished owner-chat reply, or null. Rule: the owner's own chat, the bot (snapshot and saved)
 * has Files and Terminal, the task made at least 3 successful terminal/execute_code/shell_run calls and no script tool
 * call, and the last two suggestions among this chat's last 20 replies were not both ignored (ignored = no later owner
 * message starting with SCRIPT_SUGGESTION_REQUEST).
 */
export function scriptSuggestion(state,context,run) {
  if(!ownerChat(context))return null;
  const current=state.bots.find(bot=>bot.id===context.bot.id);
  if(![context.bot,current].every(bot=>bot && groupsFor(bot).includes('workspace') && groupsFor(bot).includes('terminal')))return null;
  const records=Array.isArray(run?.workRecords)?run.workRecords:[];
  if(records.some(record=>SCRIPT_TOOLS.has(record.tool)))return null;
  const commands=records.filter(record=>SUGGESTION_COMMANDS.has(record.tool) && record.status==='succeeded').length;
  if(commands<3)return null;
  const rows=sessionMessages(state.messages?.[context.bot.id] || [],context.bot.id,context.sessionId);
  const replies=rows.filter(row=>row.role==='assistant' && row.runId!==run.id).slice(-20),offered=replies.filter(row=>row.scriptSuggestion).slice(-2);
  const taken=row=>rows.slice(rows.indexOf(row)+1).some(next=>next.role==='user' && typeof next.content==='string' && next.content.startsWith(SCRIPT_SUGGESTION_REQUEST.slice(0,40)));
  if(offered.length===2 && offered.every(row=>!taken(row)))return null;
  return {reason:'repeated_commands',commands};
}

/** A routine finished without any model call (report/skip workflow): its usage line can say "0 model calls". */
export function modelFreeRun(context,run) {
  return Boolean(context?.routine?.workflow && context.workflowPrepared && context.finalOutput!==undefined && !run?.metering && !(context.usedModelTurns>0));
}

// ---- Guidance (shown only when the tools it names are permitted) ----
export const SCRIPTS_FIRST_GUIDANCE='Scripts first: for fully determined work (fetching and parsing, calculations, file conversion, bulk edits, checks over many items) write and run one script instead of repeating tool calls. Reuse a saved script when one fits: check scripts_list, then call script_run with its inputs. When you do the same kind of work a second time, save it with script_save and tell the owner. Each new or changed version waits once for owner approval.';
export const SAVED_ROUTINE_SCRIPT_GUIDANCE='A routine step {id,op:"script",scriptId,digest,args:[]} runs a saved script with no model call; take the digest from scripts_inspect. A version the owner approved runs without a new card in a ready sandbox; elsewhere each run asks.';
export const SCRIPTS_FIRST_HINT='For fully determined work such as fetching and parsing, calculations, conversions, bulk edits or checks over many items, prefer one script over many tool calls; the terminal group can save scripts and rerun them later without the model.';
/** Older tools the catalog stops offering to the model where script_run is permitted (still callable and used by routine steps). */
export const LEGACY_SCRIPT_TOOLS=Object.freeze(['scripts_register','scripts_run']);
