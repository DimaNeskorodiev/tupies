import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { ensure, HttpError, id, now } from './store.mjs';
import { getWorkspaceRoot, safePath, closePipesAfterExit } from './agent-tools.mjs';
import { getProcessHome, processEnvironment } from './process-environment.mjs';

const SUPERVISOR=fileURLToPath(new URL('./process-supervisor.mjs',import.meta.url));
const FINAL=new Set(['completed','failed','stopped','timed_out','output_limit','interrupted']);
const abortError=()=>Object.assign(new Error('Background command cancelled.'),{name:'AbortError'});
const integer=(value,fallback,min,max,label)=>{const result=value ?? fallback;ensure(Number.isSafeInteger(result) && result>=min && result<=max,400,`${label} must be ${min}–${max}.`);return result;};
const checkSignal=signal=>{if(signal?.aborted)throw signal.reason || abortError();};
const knownSecrets=store=>{
  const values=[];
  for(const item of [...(store.state.connections || []),...(store.state.integrations || []),...(store.state.channels || [])]) {
    try{const value=store.unseal(item.secret);if(value)values.push(value);}catch{}
    if(item.oauthSecret)try{for(const [key,value] of Object.entries(JSON.parse(store.unseal(item.oauthSecret))))if(/token|secret/i.test(key) && typeof value==='string' && value)values.push(value);}catch{}
  }
  return [...new Set(values)].sort((a,b)=>b.length-a.length);
};
function prefixSuffixLength(content,secret) {
  // UTF-16 KMP keeps partial credential checks linear, including astral text.
  const failure=new Uint32Array(secret.length);let matched=0;
  for(let index=1;index<secret.length;index++){while(matched && secret[index]!==secret[matched])matched=failure[matched-1];if(secret[index]===secret[matched])matched++;failure[index]=matched;}
  matched=0;
  for(let index=0;index<content.length;index++){const char=content[index];while(matched && char!==secret[matched])matched=failure[matched-1];if(char===secret[matched])matched++;if(matched===secret.length)matched=failure[matched-1] || 0;}
  return matched;
}
function redactTrailingPrefix(content,secrets) {
  let cut=content.length;
  for(const secret of secrets){const matched=prefixSuffixLength(content,secret);if(matched>=Math.min(4,secret.length))cut=Math.min(cut,content.length-matched);}
  return cut<content.length?content.slice(0,cut)+'[redacted partial]':content;
}

/** Managed commands are run-owned trusted host processes, not a sandbox. */
export class BackgroundProcesses {
  constructor(store,options={}) {
    this.store=store;this.entries=new Map();this.previews=new Map();this.closed=false;this.secretSources=null;this.currentSecrets=[];
    this.maxBytes=integer(options.maxBytes,250000,100,250000,'Output limit');
    this.maxPerRun=integer(options.maxPerRun,4,1,4,'Per-run process limit');
    this.maxGlobal=integer(options.maxGlobal,8,1,8,'Global process limit');
    this.startupTimeoutMs=integer(options.startupTimeoutMs,10000,100,30000,'Startup timeout');
  }
  _run(botId,runId) {
    ensure(typeof botId==='string' && typeof runId==='string' && runId.length<=200,400,'Use a valid bot and run identity.');
    const run=this.store.state.runs[botId];ensure(run?.id===runId,409,'This command belongs to another or expired run.');return run;
  }
  _owned(botId,runId,processId) {
    this._run(botId,runId);ensure(typeof processId==='string' && processId.length<=100,400,'Use a valid process ID.');
    const entry=this.entries.get(processId);
    if(entry){ensure(entry.botId===botId && entry.runId===runId,403,'This background command belongs to another bot or run.');return entry;}
    const saved=this._run(botId,runId).backgroundProcesses?.find(item=>item.processId===processId);
    ensure(saved,404,'Background command not found.');
    ensure(FINAL.has(saved.status),409,'This command is not owned by this Tupies process. Restart recovery must interrupt it.');
    const preview=this.previews.get(processId);if(preview)return preview;
    const result={...saved,saved:true,botId,runId,output:saved.output || '',settled:true,waiters:new Set(),secrets:[]};
    this.previews.set(processId,result);while(this.previews.size>100)this.previews.delete(this.previews.keys().next().value);return result;
  }
  hasActive(runId) {return [...this.entries.values()].some(entry=>entry.runId===runId && !entry.settled);}
  _refreshSecrets(entry) {
    const records=[...(this.store.state.connections || []),...(this.store.state.integrations || []),...(this.store.state.channels || [])],sources=records.flatMap(item=>[item.secret,item.oauthSecret]);
    if(!this.secretSources || sources.length!==this.secretSources.length || sources.some((value,index)=>value!==this.secretSources[index])){this.secretSources=sources;this.currentSecrets=knownSecrets(this.store);}
    entry.secrets=[...new Set([...(entry.secrets || []),...this.currentSecrets])].sort((a,b)=>b.length-a.length);
  }
  _redact(entry,value) {for(const secret of entry.secrets)value=value.split(secret).join('[redacted]');return this.store.redact(value);}
  _view(entry) {
    this._refreshSecrets(entry);let output=this._redact(entry,entry.output || '');
    if(entry.settled)output=redactTrailingPrefix(output,entry.secrets);
    else {let held=0;for(const secret of entry.secrets)held=Math.max(held,prefixSuffixLength(output,secret));if(held)output=output.slice(0,-held);}
    if(output.length>this.maxBytes){output=output.slice(0,this.maxBytes);entry.truncated=true;this._terminate(entry,'output_limit','The background command exceeded its output limit.');}
    const previous=entry.publicOutput ?? entry.output ?? '';
    if(!output.startsWith(previous))entry.outputVersion=(entry.outputVersion || 0)+1;
    entry.publicOutput=output;return output;
  }
  _metadata(entry,{persist=false}={}) {
    const output=this._view(entry),preview=output.slice(0,12000),argsPreview=entry.argsPreview?.map(value=>redactTrailingPrefix(this._redact(entry,value),entry.secrets));
    return this.store.redactValue({id:entry.processId,processId:entry.processId,botId:entry.botId,runId:entry.runId,status:entry.status,executable:entry.executable,argsPreview,argsPreviewTruncated:!!entry.argsPreviewTruncated,cwd:entry.cwd,timeoutMs:entry.timeoutMs,startedAt:entry.startedAt,...(entry.finishedAt?{finishedAt:entry.finishedAt}:{}),exitCode:entry.exitCode ?? null,signal:entry.terminationSignal ?? entry.signal ?? null,timedOut:!!entry.timedOut,truncated:!!entry.truncated,totalBytes:entry.totalBytes || 0,retainedChars:output.length,outputVersion:entry.outputVersion || 0,...(entry.reason?{reason:entry.reason}:{}),...(entry.error?{error:entry.error}:{}),outputPreview:preview.slice(0,2000),...(persist?{output:preview,outputPreviewTruncated:preview.length<output.length}:{})});
  }
  async _persist(entry) {
    const saved=await this.store.mutate(state=>{
      const run=state.runs[entry.botId];if(run?.id!==entry.runId)return false;
      // Compute the redacted snapshot under the same mutation ordering as token updates.
      const metadata=this._metadata(entry,{persist:true});
      const records=run.backgroundProcesses ||= [],at=records.findIndex(item=>item.processId===entry.processId);
      if(at>=0)records[at]=metadata;else records.push(metadata);
      run.updatedAt=now();return true;
    });
    if(saved)entry.persisted=true;
  }
  _notify(entry) {for(const waiter of [...entry.waiters])waiter();}
  _append(entry,which,text,final=false) {
    this._refreshSecrets(entry);const stream=entry.streams[which];stream.pending=this._redact(entry,stream.pending+text);
    let held=0;if(!final)for(const secret of entry.secrets)held=Math.max(held,prefixSuffixLength(stream.pending,secret));
    const end=stream.pending.length-held;
    if(!end)return;
    let content=stream.pending.slice(0,end);stream.pending=stream.pending.slice(end);
    if(final)content=redactTrailingPrefix(content,entry.secrets);
    const available=this.maxBytes-entry.output.length;
    entry.output+=content.slice(0,Math.max(0,available));
    if(content.length>available){entry.truncated=true;this._terminate(entry,'output_limit','The background command exceeded its output limit.');}
    this._notify(entry);
  }
  _terminate(entry,status='stopped',reason='The background command was stopped.') {
    if(entry.settled)return;
    if(!entry.stopStatus){entry.stopStatus=status;entry.reason=this.store.redact(String(reason).slice(0,500));}
    if(status==='timed_out')entry.timedOut=true;
    if(entry.finishing)return;
    if(!entry.child)return;
    if(entry.child.connected)try{entry.child.send({type:'stop'});}catch{}
    if(!entry.forceTimer) {
      entry.forceTimer=setTimeout(()=>{try{if(process.platform!=='win32' && entry.child.pid)process.kill(-entry.child.pid,'SIGKILL');else entry.child.kill('SIGKILL');}catch{}},1000);
      entry.forceTimer.unref();
    }
  }
  async _finish(entry,code,signal) {
    if(entry.finishing)return;entry.finishing=true;
    clearTimeout(entry.timer);clearTimeout(entry.startupTimer);clearTimeout(entry.forceTimer);
    entry.abortSignal?.removeEventListener('abort',entry.onAbort);
    for(const which of ['stdout','stderr']){
      const tail=entry.streams[which].decoder.end();
      // A byte cap can bisect a multibyte character; omit that incomplete tail
      // before credential-prefix redaction rather than appending a replacement.
      this._append(entry,which,entry.truncated?tail.replace(/�$/,''):tail,true);
    }
    entry.exitCode=entry.targetExit?.exitCode ?? null;entry.terminationSignal=entry.targetExit?entry.targetExit.signal:signal || null;
    entry.status=entry.stopStatus || (entry.startError || !entry.targetExit ? 'failed' : entry.targetExit.exitCode===0?'completed':'failed');
    if(!entry.targetExit && !entry.error)entry.error=entry.startError || 'The background supervisor ended without a confirmed command result.';
    entry.finishedAt=now();entry.settled=true;
    entry.rejectReady(new HttpError(400,entry.error || 'The background command ended before startup was confirmed.'));
    this._notify(entry);
    try{await this._persist(entry);entry.resolveDone(this._metadata(entry));}catch(error){entry.rejectDone(error);}
    // The captured values remain protected after credential rotation; clear raw tails.
    entry.streams=null;
  }
  async start(bot,runId,args,{signal}={}) {
    ensure(!this.closed,503,'Background command service is closing.');checkSignal(signal);
    const botId=typeof bot==='string'?bot:bot?.id,run=this._run(botId,runId);
    ensure(!['completed','failed','cancelled','interrupted','unknown','stopping'].includes(run.status),409,'The task is no longer accepting commands.');
    ensure(args && typeof args==='object' && !Array.isArray(args) && Object.keys(args).every(key=>['executable','args','cwd','timeoutMs'].includes(key)),400,'Use supported background command arguments.');
    ensure(typeof args.executable==='string' && args.executable.length>0 && args.executable.length<=240 && !/[\x00-\x1f\x7f]/.test(args.executable),400,'Choose a valid executable.');
    ensure(Array.isArray(args.args) && args.args.length<=50 && args.args.every(arg=>typeof arg==='string' && arg.length<=2000 && !arg.includes('\0')),400,'Use bounded literal process arguments.');
    const timeoutMs=integer(args.timeoutMs,300000,100,1800000,'Process timeout');
    const active=[...this.entries.values()].filter(entry=>!entry.settled);
    ensure(active.length<this.maxGlobal && active.filter(entry=>entry.runId===runId).length<this.maxPerRun,429,'The background command concurrency limit was reached.');
    ensure((run.backgroundProcesses?.length || 0)+active.filter(entry=>entry.runId===runId && !run.backgroundProcesses?.some(saved=>saved.processId===entry.processId)).length<20,429,'This task reached its background command history limit.');
    for(const [key,entry] of this.previews)if(this.store.state.runs[entry.botId]?.id!==entry.runId)this.previews.delete(key);
    const processId=id('process'),secrets=knownSecrets(this.store);
    let resolveReady,rejectReady,resolveDone,rejectDone;
    const entry={processId,botId,runId,status:'starting',executable:this.store.redact(args.executable),argsPreview:args.args.map(value=>this.store.redact(value).slice(0,120)).slice(0,8),argsPreviewTruncated:args.args.length>8 || args.args.slice(0,8).some(value=>value.length>120),cwd:this.store.redact(args.cwd ?? '.'),timeoutMs,startedAt:now(),output:'',publicOutput:'',outputVersion:0,totalBytes:0,settled:false,waiters:new Set(),secrets,streams:{stdout:{decoder:new StringDecoder('utf8'),pending:''},stderr:{decoder:new StringDecoder('utf8'),pending:''}},abortSignal:signal};
    entry.ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});entry.resolveReady=resolveReady;entry.rejectReady=rejectReady;void entry.ready.catch(()=>{});
    entry.done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});entry.resolveDone=resolveDone;entry.rejectDone=rejectDone;void entry.done.catch(()=>{});
    // Reserve capacity before the first asynchronous path/persistence operation.
    this.entries.set(processId,entry);
    const accepting=()=>{
      checkSignal(signal);ensure(!this.closed && !entry.stopStatus,409,'The task stopped accepting this background command.');
      const current=this._run(botId,runId);ensure(!['completed','failed','cancelled','interrupted','unknown','stopping'].includes(current.status),409,'The task stopped accepting this background command.');
    };
    try {
      const root=await getWorkspaceRoot(this.store,botId),cwd=await safePath(root,args.cwd ?? '.',{allowRoot:true});ensure((await fs.lstat(cwd)).isDirectory(),400,'Choose a workspace folder for the command.');
      const env=await processEnvironment(await getProcessHome(this.store,botId));
      accepting();await this._persist(entry);accepting();
      entry.onAbort=()=>this._terminate(entry,'stopped',signal.reason?.message || 'The parent task was cancelled.');signal?.addEventListener('abort',entry.onAbort,{once:true});
      entry.child=fork(SUPERVISOR,[],{cwd,execArgv:[],detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env});
      const collect=which=>chunk=>{
        if(entry.settled)return;entry.totalBytes+=chunk.length;
        const allowed=Math.max(0,Math.min(chunk.length,this.maxBytes-(entry.totalBytes-chunk.length)));
        if(allowed)this._append(entry,which,entry.streams[which].decoder.write(chunk.subarray(0,allowed)));
        if(entry.totalBytes>this.maxBytes){entry.truncated=true;this._terminate(entry,'output_limit','The background command exceeded its output limit.');}
      };
      entry.child.stdout.on('data',collect('stdout'));entry.child.stderr.on('data',collect('stderr'));
      entry.child.on('message',message=>{
        if(message?.type==='started'){if(!entry.stopStatus)entry.status='running';entry.resolveReady();this._notify(entry);}
        if(message?.type==='start_error'){entry.startError=`Could not start the selected executable: ${String(message.code).slice(0,100)}.`;entry.error=entry.startError;entry.rejectReady(new HttpError(400,entry.startError));}
        if(message?.type==='exited')entry.targetExit={exitCode:Number.isInteger(message.exitCode)?message.exitCode:null,signal:typeof message.signal==='string'?message.signal:null};
      });
      entry.child.once('error',error=>{entry.error=`Could not start the background supervisor: ${error.code || 'unknown error'}.`;entry.rejectReady(new HttpError(400,entry.error));void this._finish(entry,null,null);});
      entry.child.once('close',(code,terminationSignal)=>{void this._finish(entry,code,terminationSignal);});closePipesAfterExit(entry.child);
      entry.child.once('spawn',()=>{try{if(entry.stopStatus){entry.child.send({type:'stop'});return;}entry.child.send({type:'start',executable:args.executable,args:args.args});}catch(error){entry.rejectReady(error);this._terminate(entry,'failed','The background supervisor could not receive its command.');}});
      entry.timer=setTimeout(()=>this._terminate(entry,'timed_out','The background command reached its runtime limit.'),timeoutMs);entry.timer.unref();
      entry.startupTimer=setTimeout(()=>{entry.rejectReady(new HttpError(504,'Background command startup timed out.'));this._terminate(entry,'timed_out','Background command startup timed out.');},this.startupTimeoutMs);entry.startupTimer.unref();
      if(signal?.aborted)entry.onAbort();
      await entry.ready;clearTimeout(entry.startupTimer);accepting();await this._persist(entry);return this._metadata(entry);
    } catch(error) {
      if(entry.child){this._terminate(entry,signal?.aborted?'stopped':'failed',error.message);await entry.done.catch(()=>{});}
      else {
        entry.settled=true;entry.status=entry.stopStatus || 'failed';entry.finishedAt=now();
        if(!entry.stopStatus)entry.error=this.store.redact(error.message || 'Background command admission failed.');
        this.entries.delete(processId);entry.rejectReady(error);this._notify(entry);
        if(entry.persisted)try{await this._persist(entry);}catch{}
        entry.resolveDone(this._metadata(entry));entry.secrets=[];entry.streams=null;
      }
      throw error;
    }
  }
  async _wait(entry,offset,waitMs,signal) {
    checkSignal(signal);if(entry.settled || this._view(entry).length>offset || !waitMs)return;
    await new Promise((resolve,reject)=>{
      let timer;
      const cleanup=()=>{clearTimeout(timer);entry.waiters.delete(changed);signal?.removeEventListener('abort',aborted);};
      const changed=()=>{if(this._view(entry).length>offset || entry.settled){cleanup();resolve();}};
      const aborted=()=>{cleanup();reject(signal.reason || abortError());};
      entry.waiters.add(changed);signal?.addEventListener('abort',aborted,{once:true});timer=setTimeout(()=>{cleanup();resolve();},waitMs);timer.unref();
      changed();if(signal?.aborted)aborted();
    });
  }
  async read(botId,runId,processId,args={},options={}) {
    ensure(args && typeof args==='object' && !Array.isArray(args) && Object.keys(args).every(key=>['offset','limit','waitMs','outputVersion'].includes(key)),400,'Use supported output paging arguments.');
    const offset=integer(args.offset,0,0,250000,'Output offset'),limit=integer(args.limit,12000,1,12000,'Output page limit'),waitMs=integer(args.waitMs,0,0,10000,'Wait duration');
    ensure(args.outputVersion===undefined || (Number.isSafeInteger(args.outputVersion) && args.outputVersion>=0),400,'Use a valid output version.');
    const entry=this._owned(botId,runId,processId);
    const checkVersion=()=>{this._view(entry);ensure(offset===0 || ((entry.outputVersion || 0)===0 && args.outputVersion===undefined) || args.outputVersion===(entry.outputVersion || 0),409,'Output changed after credential redaction. Restart reading at offset 0 and use its outputVersion.');ensure(offset<=entry.publicOutput.length,400,'The output offset exceeds the retained length.');};
    checkVersion();
    await this._wait(entry,offset,waitMs,options.signal);checkSignal(options.signal);
    if(!entry.saved)await this._persist(entry);
    checkSignal(options.signal);checkVersion();const output=entry.publicOutput.slice(offset,offset+limit),nextOffset=offset+output.length<entry.publicOutput.length ? offset+output.length : null;
    return {...this._metadata(entry),output,offset,nextOffset,limit,complete:entry.settled,persistedPreview:!!entry.saved,truncated:!!entry.truncated || !!entry.outputPreviewTruncated,...(entry.saved?{outputPreviewTruncated:!!entry.outputPreviewTruncated}:{})};
  }
  list(botId,runId) {
    const run=this._run(botId,runId);
    const records=new Map((run.backgroundProcesses || []).map(entry=>[entry.processId,this._metadata(this._owned(botId,runId,entry.processId))]));
    for(const entry of this.entries.values())if(entry.botId===botId && entry.runId===runId)records.set(entry.processId,this._metadata(entry));
    return {processes:[...records.values()]};
  }
  async wait(botId,runId,processId) {const entry=this._owned(botId,runId,processId);return entry.saved?this._metadata(entry):entry.done;}
  async stop(botId,runId,processId,{reason='The background command was stopped.'}={}) {
    const entry=this._owned(botId,runId,processId);if(entry.saved)return this._metadata(entry);
    this._terminate(entry,'stopped',reason);await entry.done;return this._metadata(entry);
  }
  async closeRun(runId,{reason='The parent task ended.'}={}) {
    const entries=[...this.entries.values()].filter(entry=>entry.runId===runId);
    for(const entry of entries)if(!entry.settled)this._terminate(entry,'stopped',reason);
    await Promise.all(entries.map(entry=>entry.done));const processes=entries.map(entry=>this._metadata(entry));
    for(const entry of entries){entry.secrets=[];this.entries.delete(entry.processId);}for(const [key,entry] of this.previews)if(entry.runId===runId)this.previews.delete(key);return {processes};
  }
  async recover() {
    await this.store.mutate(state=>{
      for(const run of Object.values(state.runs))for(const entry of run.backgroundProcesses || []){delete entry.pid;if(!FINAL.has(entry.status)){entry.status='interrupted';entry.finishedAt=now();entry.reason='Tupies restarted. This command was not replayed and no stored PID was adopted.';}}
    });
  }
  async close() {this.closed=true;for(const entry of this.entries.values())if(!entry.settled)this._terminate(entry,'stopped','Tupies is shutting down.');await Promise.all([...this.entries.values()].map(entry=>entry.done));this.entries.clear();this.previews.clear();this.currentSecrets=[];this.secretSources=null;}
}
