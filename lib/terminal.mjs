// Terminal and execute_code runtime: `bash -lc` with per-task persistent folder and
// exported environment. Each command is its own process group, so a timeout or Stop kills
// exactly that command tree and the saved state of earlier commands survives.
//
// Persistence design: instead of one long-lived interactive bash per task, every command
// runs in a fresh `bash -lc` wrapper that restores the saved folder and exported variables,
// runs the command with `eval` in the same shell (so `cd` and `export` take effect), and on
// EXIT writes `pwd -P` and the exported environment to a private state folder. Restored
// values travel as data in the child environment, never as sourced shell code. This keeps
// cancellation, timeouts and output bounds per command, avoids prompt/sentinel parsing and
// stdin hangs, and a crashed or killed command cannot corrupt the session. Shell functions,
// aliases and unexported variables do not persist.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensure, HttpError } from './store.mjs';
import { getProcessHome, processEnvironment } from './process-environment.mjs';

// The same guardian as managed background commands: it owns the process group and kills it if the Engine disappears.
const SUPERVISOR=fileURLToPath(new URL('./process-supervisor.mjs',import.meta.url));
/** Model guidance for the terminal load group (lib/tool-catalog.mjs), shown only when terminal is offered. */
export const TERMINAL_GUIDANCE='terminal runs bash in a per-task session: cd and export persist, it starts in your workspace and defaults to a 10-minute timeout. Use execute_code for Python or Node snippets. Read-only commands run at once; dangerous ones (deleting, pushing, sending data, sudo) wait for the owner. Check exitCode before claiming success.';
export const TERMINAL_DEFAULT_TIMEOUT_MS=600_000;
export const TERMINAL_MAX_TIMEOUT_MS=1_800_000;
export const TERMINAL_HEAD_BYTES=12_000;
export const TERMINAL_TAIL_BYTES=12_000;
/** A runaway producer is stopped after this much output; only the head and tail are kept in memory. */
export const TERMINAL_HARD_OUTPUT_BYTES=64*1024*1024;
export const CODE_LANGUAGES={python:{extension:'.py'},node:{extension:'.mjs'}};
const MAX_SESSIONS=200, SESSION_TTL_MS=12*60*60*1000, MAX_ENV_VARS=300, MAX_ENV_VALUE=32_000, MAX_ENV_TOTAL=256_000;
const NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;
// Never carried between commands: shell bookkeeping, our own transport, variables that inject code,
// and the Engine's protective Git/Python settings (always restored from the base environment).
const VOLATILE=/^(?:PWD|OLDPWD|SHLVL|_|TUPIES_\w*|GIT_CONFIG\w*|PYTHONNOUSERSITE|BASH_FUNC_.*|BASH_ENV|ENV|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|PS4|IFS|LD_\w+|DYLD_\w+|COLUMNS|LINES)$/;

const WRAPPER=[
  '__tupies_state="$TUPIES_STATE_DIR"; __tupies_root="$TUPIES_ROOT"; __tupies_cwd="$TUPIES_CWD"; __tupies_command="$TUPIES_COMMAND"',
  'for __tupies_name in $TUPIES_UNSET; do unset "$__tupies_name"; done',
  'for __tupies_name in $TUPIES_KEEP; do __tupies_value="TUPIES_V_$__tupies_name"; export "$__tupies_name=${!__tupies_value}"; unset "$__tupies_value"; done',
  'unset TUPIES_STATE_DIR TUPIES_ROOT TUPIES_CWD TUPIES_COMMAND TUPIES_KEEP TUPIES_UNSET __tupies_name __tupies_value',
  'cd -- "$__tupies_cwd" 2>/dev/null || { printf "%s\\n" "tupies: the saved folder is unavailable; using the workspace folder." >&2; cd -- "$__tupies_root" || exit 125; }',
  '__tupies_save() { pwd -P > "$__tupies_state/cwd" 2>/dev/null; for __tupies_name in $(compgen -e); do printf "%s=%s\\0" "$__tupies_name" "${!__tupies_name}"; done > "$__tupies_state/env" 2>/dev/null; }',
  'trap __tupies_save EXIT',
  'eval "$__tupies_command"',
].join('\n');

class OutputWindow {
  constructor(head=TERMINAL_HEAD_BYTES,tail=TERMINAL_TAIL_BYTES){this.headLimit=head;this.tailLimit=tail;this.head=[];this.headSize=0;this.tail=[];this.tailSize=0;this.total=0;}
  push(chunk) {
    this.total+=chunk.length;
    if(this.headSize<this.headLimit){const take=chunk.subarray(0,this.headLimit-this.headSize);this.head.push(take);this.headSize+=take.length;chunk=chunk.subarray(take.length);}
    if(!chunk.length)return;
    this.tail.push(chunk);this.tailSize+=chunk.length;
    while(this.tailSize-this.tail[0].length>=this.tailLimit){this.tailSize-=this.tail.shift().length;}
  }
  result() {
    const head=Buffer.concat(this.head),tailBuffer=Buffer.concat(this.tail),tail=tailBuffer.subarray(Math.max(0,tailBuffer.length-this.tailLimit));
    const omitted=this.total-head.length-tail.length;
    if(omitted<=0)return {output:Buffer.concat([head,tail]).toString('utf8'),truncated:false,outputBytes:this.total};
    return {output:`${head.toString('utf8')}\n… [${omitted} bytes omitted; showing the first ${head.length} and last ${tail.length} bytes] …\n${tail.toString('utf8')}`,truncated:true,outputBytes:this.total,omittedBytes:omitted};
  }
}

const killGroup=(child,signal)=>{try{if(process.platform!=='win32' && child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{}};

/** Per-task terminal sessions. State is engine memory only: a restart starts fresh in the workspace. */
export class TerminalSessions {
  constructor(store,{getWorkspaceRoot,clock=Date.now}={}) {this.store=store;this.getWorkspaceRoot=getWorkspaceRoot;this.clock=clock;this.sessions=new Map();this.roots=new Map();}
  /** The resolved workspace root from an earlier session of this bot, if any. */
  rootHint(botId){return this.roots.get(botId) || null;}
  key(botId,runId){return `${botId}\n${runId || 'direct'}`;}
  /** Synchronous view for policy decisions: the folder the next command starts in. */
  peek(botId,runId) {
    const session=this.sessions.get(this.key(botId,runId));
    if(!session || this.clock()-session.updatedAt>SESSION_TTL_MS)return null;
    return {root:session.root,cwd:session.cwd};
  }
  end(botId,runId){this.sessions.delete(this.key(botId,runId));}
  async session(botId,runId) {
    const key=this.key(botId,runId);let session=this.sessions.get(key);
    if(session && this.clock()-session.updatedAt>SESSION_TTL_MS){this.sessions.delete(key);session=null;}
    if(!session) {
      ensure(typeof this.getWorkspaceRoot==='function',500,'Terminal workspace resolution is unavailable.');
      const root=await fs.realpath(await this.getWorkspaceRoot(this.store,botId));
      session={root,cwd:root,env:{},unset:[],updatedAt:this.clock()};
      this.roots.delete(botId);this.roots.set(botId,root);while(this.roots.size>MAX_SESSIONS)this.roots.delete(this.roots.keys().next().value);
    }
    // Map order is recency order; the oldest idle session is dropped first.
    this.sessions.delete(key);this.sessions.set(key,session);
    while(this.sessions.size>MAX_SESSIONS)this.sessions.delete(this.sessions.keys().next().value);
    return session;
  }
  relative(session,folder) {
    const relative=path.relative(session.root,folder);
    return relative===''?'.':relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)?folder:relative.split(path.sep).join('/');
  }

  /** Runs one bash command in the task's persistent session. */
  async run(botId,runId,{command,timeoutMs},{signal}={}) {
    ensure(typeof command==='string' && command.trim() && command.length<=20_000 && !command.includes('\0'),400,'Give one bash command of at most 20000 characters.');
    const timeout=timeoutMs ?? TERMINAL_DEFAULT_TIMEOUT_MS;
    ensure(Number.isInteger(timeout) && timeout>=1000 && timeout<=TERMINAL_MAX_TIMEOUT_MS,400,`Terminal timeout must be 1000–${TERMINAL_MAX_TIMEOUT_MS} milliseconds.`);
    const session=await this.session(botId,runId);
    const result=await this.execute(botId,session,command,{signal,timeoutMs:timeout,persist:true});
    return {command,...result};
  }

  /** Runs a Python or Node snippet from a private temporary file in the workspace, in the session's folder. */
  async code(botId,runId,{language,code,timeoutMs},{signal}={}) {
    ensure(Object.hasOwn(CODE_LANGUAGES,language),400,'Choose python or node.');
    ensure(typeof code==='string' && code.trim() && Buffer.byteLength(code)<=100_000 && !code.includes('\0'),400,'Give code of at most 100 KB.');
    const timeout=timeoutMs ?? TERMINAL_DEFAULT_TIMEOUT_MS;
    ensure(Number.isInteger(timeout) && timeout>=1000 && timeout<=TERMINAL_MAX_TIMEOUT_MS,400,`Code timeout must be 1000–${TERMINAL_MAX_TIMEOUT_MS} milliseconds.`);
    const session=await this.session(botId,runId);
    const folder=path.join(session.root,'.tmp','code');
    await fs.mkdir(folder,{recursive:true,mode:0o700});
    const stat=await fs.lstat(folder);ensure(stat.isDirectory() && !stat.isSymbolicLink(),400,'The workspace code folder must be a real directory.');
    const extension=language==='node' && !/^\s*(?:import|export)\s|\bawait\b/m.test(code) && /\brequire\s*\(/.test(code)?'.cjs':CODE_LANGUAGES[language].extension;
    const file=path.join(folder,`snippet-${randomBytes(8).toString('hex')}${extension}`);
    await fs.writeFile(file,code,{mode:0o600,flag:'wx'});
    const interpreter=language==='python'?'python3':quote(process.execPath);
    try {
      const result=await this.execute(botId,session,`${interpreter} ${quote(file)}`,{signal,timeoutMs:timeout,persist:false});
      return {language,...result};
    } finally {await fs.rm(file,{force:true});}
  }

  async execute(botId,session,command,{signal,timeoutMs,persist}) {
    if(signal?.aborted)throw signal.reason || new Error('Command cancelled.');
    const home=await getProcessHome(this.store,botId),base=await processEnvironment(home);
    const state=await fs.mkdtemp(path.join(home,'.tmp','terminal-'));
    let cwd=session.cwd;try{if(!(await fs.stat(cwd)).isDirectory())cwd=session.root;}catch{cwd=session.root;}
    const keep=Object.keys(session.env);
    const env={...base,...Object.fromEntries(keep.map(name=>[`TUPIES_V_${name}`,session.env[name]])),TUPIES_KEEP:keep.join(' '),TUPIES_UNSET:session.unset.join(' '),TUPIES_STATE_DIR:state,TUPIES_ROOT:session.root,TUPIES_CWD:session.cwd,TUPIES_COMMAND:command};
    const started=Date.now();
    try {
      const outcome=await new Promise((resolve,reject)=>{
        const window=new OutputWindow();let settled=false,timedOut=false,outputLimit=false,killTimer,exited=null,startError=null;
        const child=fork(SUPERVISOR,[],{cwd,execArgv:[],detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env});
        child.on('message',message=>{if(message?.type==='exited')exited=message;else if(message?.type==='start_error')startError=message.code || 'unknown error';});
        child.once('spawn',()=>{try{child.send({type:'start',executable:'bash',args:['-lc',WRAPPER]});}catch{}});
        const kill=()=>{killGroup(child,'SIGTERM');killTimer=setTimeout(()=>killGroup(child,'SIGKILL'),500);killTimer.unref();};
        const abort=()=>kill();signal?.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);timer.unref();
        const collect=chunk=>{window.push(chunk);if(window.total>TERMINAL_HARD_OUTPUT_BYTES && !outputLimit){outputLimit=true;kill();}};
        child.stdout.on('data',collect);child.stderr.on('data',collect);
        // A descendant that leaves the group can hold the pipes open; close them shortly after the shell exits.
        child.once('exit',()=>{const drain=setTimeout(()=>{child.stdout?.destroy();child.stderr?.destroy();},1000);drain.unref();child.once('close',()=>clearTimeout(drain));});
        const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
        child.once('error',error=>{if(settled)return;settled=true;cleanup();clearTimeout(killTimer);reject(new HttpError(400,`Could not start bash: ${error.code || 'unknown error'}.`));});
        child.once('close',(_code,terminationSignal)=>{
          if(settled)return;settled=true;cleanup();
          // Make sure nothing in the command's process group outlives it.
          killGroup(child,'SIGKILL');clearTimeout(killTimer);
          if(signal?.aborted){reject(signal.reason || new Error('Command cancelled.'));return;}
          if(startError){reject(new HttpError(400,`Could not start bash: ${startError}.`));return;}
          resolve({exitCode:exited?exited.exitCode:null,signal:exited?exited.signal:terminationSignal,timedOut,outputLimit,...window.result()});
        });
      });
      if(persist)await this.capture(session,state,base);
      session.updatedAt=this.clock();
      const result={cwd:this.relative(session,session.cwd),exitCode:outcome.exitCode,durationMs:Date.now()-started,output:outcome.output,truncated:outcome.truncated,outputBytes:outcome.outputBytes,
        ...(outcome.omittedBytes?{omittedBytes:outcome.omittedBytes}:{}),...(outcome.signal?{signal:outcome.signal}:{}),...(outcome.timedOut?{timedOut:true,notice:`Stopped after ${timeoutMs} ms. The command did not finish.`}:{}),...(outcome.outputLimit?{outputLimit:true,notice:'Stopped after producing too much output.'}:{})};
      return this.store.redactValue(result);
    } finally {await fs.rm(state,{recursive:true,force:true});}
  }

  async capture(session,state,base) {
    // State files are data written by the wrapper; validate before trusting them.
    let cwd;
    try{cwd=(await fs.readFile(path.join(state,'cwd'),'utf8')).replace(/\n$/,'');}catch{return;}
    try{if(cwd && path.isAbsolute(cwd) && (await fs.stat(cwd)).isDirectory())session.cwd=cwd;}catch{}
    let raw;try{raw=await fs.readFile(path.join(state,'env'));}catch{return;}
    if(raw.length>4*MAX_ENV_TOTAL)return;
    const seen=new Map();
    for(const entry of raw.toString('utf8').split('\0')) {
      const index=entry.indexOf('=');if(index<1)continue;
      const name=entry.slice(0,index),value=entry.slice(index+1);
      if(!NAME.test(name) || VOLATILE.test(name))continue;
      seen.set(name,value);
    }
    const env={};let total=0;
    for(const [name,value] of seen) {
      if(base[name]===value)continue;
      if(value.length>MAX_ENV_VALUE || Object.keys(env).length>=MAX_ENV_VARS || (total+=name.length+value.length)>MAX_ENV_TOTAL)continue;
      env[name]=value;
    }
    session.env=env;
    session.unset=Object.keys(base).filter(name=>!seen.has(name) && NAME.test(name) && !VOLATILE.test(name));
  }
}

export function quote(value){return `'${String(value).replaceAll("'","'\\''")}'`;}
