import { fork } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SUPERVISOR=fileURLToPath(new URL('./process-supervisor.mjs',import.meta.url));
const TOOLS=['Read','Glob','Grep','Edit','Write','Bash'];
const SESSION=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES=4_000_000,MAX_FRAME=256_000,MAX_MESSAGES=4096,MAX_OUTPUT=200_000,MAX_APPROVALS=60;
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const bounded=(value,max)=>typeof value==='string' && value.length<=max;

export class CodingWorkerError extends Error {
  constructor(code,message){super(message);this.name='CodingWorkerError';this.code=code;}
}
const error=(code,message)=>new CodingWorkerError(code,message);
const check=(condition,code,message)=>{if(!condition)throw error(code,message);};

/** Protocol support is separate from installation, authentication and model access. */
export function workerCapabilities(agent) {
  if(agent==='claude')return {agent,supported:true,protocol:'claude-stream-json',approvals:'exact-tool-input',requires:['restricted','safe-mode','setting-sources','permission-prompt-tool'],notice:'An owner-configured Claude Code executable and authorized account are required. Commands retain host-account permissions.'};
  if(agent==='codex')return {agent,supported:false,reason:'The Codex adapter cannot yet enforce an exact approval for every terminal command. Codex remains unavailable until that permission boundary is implemented.'};
  return {agent,supported:false,reason:'This coding worker is not supported.'};
}

function launchArguments(sessionId) {
  // Explicit ask rules include read-only Bash commands. Sandboxing must not
  // silently substitute for those approvals. Do not load project/user startup
  // hooks, skills, plugins or MCP servers from the selected repository/account.
  const settings={disableAllHooks:true,permissions:{defaultMode:'default',allow:[],ask:TOOLS,deny:['mcp__*'],disableBypassPermissionsMode:'disable',disableAutoMode:'disable',blockReadsOutsideWorkingDirectories:true},sandbox:{autoAllowBashIfSandboxed:false}};
  return ['--print','--verbose','--input-format','stream-json','--output-format','stream-json','--include-partial-messages','--permission-prompt-tool','stdio','--permission-mode','default','--restricted','--safe-mode','--setting-sources=','--settings',JSON.stringify(settings),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--no-chrome','--tools',TOOLS.join(','),'--max-turns','50',...(sessionId?[`--resume=${sessionId}`]:[])];
}

/**
 * Run one owned worker turn. The caller authorizes launch, supplies the isolated
 * HOME and redacts events/results before exposing them. No persisted PID or
 * session is adopted automatically: sessionId is an explicit continuation only.
 * A worker result is execution evidence, not independent acceptance of its work.
 * Protocol: Anthropic's public claude-agent-sdk-python control protocol
 * (_internal/query.py and types.py), checked against official docs 2026-10-29.
 */
export async function runCodingWorker({agent,executable,cwd,env,prompt,sessionId,signal,timeoutMs=300_000,onEvent=async()=>{},approve}={}) {
  const capability=workerCapabilities(agent);
  check(capability.supported,'unsupported_worker',capability.reason);
  check(typeof executable==='string' && path.isAbsolute(executable) && !executable.includes('\0'),'invalid_worker','Choose an absolute coding worker executable.');
  check(typeof cwd==='string' && path.isAbsolute(cwd) && !cwd.includes('\0'),'invalid_worker','Choose an absolute managed checkout directory.');
  check(object(env) && typeof env.HOME==='string' && path.isAbsolute(env.HOME),'invalid_worker','An explicit isolated process HOME is required.');
  check(bounded(prompt,60_000) && prompt.trim(),'invalid_worker','Give the worker a task of 1–60000 characters.');
  check(sessionId===undefined || SESSION.test(sessionId),'invalid_worker','Use an exact worker session UUID, not a transcript path or session name.');
  check(Number.isSafeInteger(timeoutMs) && timeoutMs>=100 && timeoutMs<=1_800_000,'invalid_worker','Worker timeout must be 100–1800000 milliseconds.');
  check(typeof approve==='function' && typeof onEvent==='function','invalid_worker','An exact-action approval handler is required.');
  if(signal?.aborted)throw error('cancelled','The coding worker was cancelled before launch.');

  // The caller supplies only its deliberately constructed process environment.
  // Never merge process.env: that could expose account tokens or shell startup.
  const childEnv={...env,CLAUDE_CODE_SDK_READS_SESSION_STATE:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  delete childEnv.CLAUDECODE;delete childEnv.NODE_OPTIONS;delete childEnv.NODE_CHANNEL_FD;delete childEnv.NODE_CHANNEL_SERIALIZATION_MODE;
  const child=fork(SUPERVISOR,[],{cwd,env:childEnv,execArgv:[],detached:process.platform!=='win32',windowsHide:true,stdio:['pipe','pipe','pipe','ipc']});
  const decoder=new StringDecoder('utf8'),stderrDecoder=new StringDecoder('utf8');
  const lifecycle=new AbortController();
  let failure=null,result=null,session=sessionId || null,output='',stderr='',bytes=0,messages=0,buffer='',queued=0,approvals=0;
  let started=false,closed=false,workerExit=null,resultSeen=false,initialized=false,userSent=false,chain=Promise.resolve(),stopTimer;
  const requestIds=new Set();
  let initResolve,initReject;
  const initializedPromise=new Promise((resolve,reject)=>{initResolve=resolve;initReject=reject;});
  // Attach immediately; initialization failure can precede awaiting the promise.
  initializedPromise.catch(()=>{});
  let closeResolve;
  const closedPromise=new Promise(resolve=>{closeResolve=resolve;});
  const abortPromise=new Promise((_,reject)=>{lifecycle.signal.addEventListener('abort',()=>reject(lifecycle.signal.reason),{once:true});});
  abortPromise.catch(()=>{});
  function stop() {
    if(closed)return;
    try{if(child.connected)child.send({type:'stop'});}catch{}
    stopTimer ||= setTimeout(()=>{try{if(process.platform!=='win32' && child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();},1500);
    stopTimer.unref();
  }
  function fail(reason) {
    if(failure)return;
    failure=reason instanceof CodingWorkerError?reason:error('worker_failed',reason?.message || 'The coding worker failed.');
    lifecycle.abort(failure);initReject(failure);stop();
  }
  const alive=()=>{if(failure)throw failure;check(!closed,'worker_exited','The coding worker exited before the request was delivered.');};
  const guarded=promise=>Promise.race([promise,abortPromise]);
  function send(message) {
    alive();const line=JSON.stringify(message)+'\n';
    check(Buffer.byteLength(line)<=MAX_FRAME,'protocol_limit','The coding worker input exceeded its frame limit.');
    return guarded(new Promise((resolve,reject)=>child.stdin.write(line,err=>err?reject(error('worker_input','The coding worker input stream closed.')):resolve())));
  }
  function observeSession(value) {
    if(value===undefined || value==='')return;
    check(typeof value==='string' && SESSION.test(value),'invalid_protocol','The coding worker returned an invalid session identity.');
    check(!session || session===value,'invalid_protocol','The coding worker changed its session identity.');session=value;
  }
  async function emit(event) {await guarded(Promise.resolve().then(()=>onEvent({agent,...event})));}
  async function control(message) {
    check(initialized && userSent && !resultSeen,'invalid_protocol','A worker requested an action outside its active turn.');
    const id=message.request_id,request=message.request;
    check(bounded(id,160) && id && !requestIds.has(id),'invalid_protocol','The coding worker reused or omitted an approval identity.');
    requestIds.add(id);
    check(object(request),'invalid_protocol','The coding worker returned an invalid control request.');
    if(request.subtype!=='can_use_tool') {
      await send({type:'control_response',response:{subtype:'error',request_id:id,error:'This control request is unsupported by Tupies.'}});
      throw error('unsupported_control','The coding worker requested an unsupported interactive capability.');
    }
    check(TOOLS.includes(request.tool_name) && object(request.input) && Buffer.byteLength(JSON.stringify(request.input))<=64_000,'unsupported_tool','The coding worker requested an unsupported tool or oversized arguments.');
    check(++approvals<=MAX_APPROVALS,'approval_limit','The coding worker reached its 60-action approval limit.');
    // Background work would outlive the confirmed result. A separate durable
    // job protocol is required before it can be enabled.
    check(request.input.run_in_background!==true,'unsupported_tool','Background commands are not supported by this coding worker.');
    const args=structuredClone(request.input),tool=request.tool_name;
    const accepted=await guarded(Promise.resolve().then(()=>approve({agent,tool,args:structuredClone(args),description:`Claude Code requests ${tool} in the selected checkout.`,requestId:id,sessionId:session,signal:lifecycle.signal})));
    alive();
    await send({type:'control_response',response:{subtype:'success',request_id:id,response:accepted===true?{behavior:'allow',updatedInput:args}:{behavior:'deny',message:'The owner did not approve this exact action.',interrupt:true}}});
    await emit({type:'approval',tool,approved:accepted===true,requestId:id});
    if(accepted!==true)throw error('approval_denied','The owner denied the coding worker action. The run is incomplete.');
  }
  async function handle(message) {
    if(failure)return;
    check(object(message) && typeof message.type==='string','invalid_protocol','The coding worker returned an invalid protocol message.');
    if(message.type==='control_response') {
      check(!initialized && message.response?.request_id==='tupies_initialize' && message.response?.subtype==='success' && object(message.response.response),'invalid_protocol','The coding worker did not acknowledge initialization.');
      initialized=true;initResolve();return;
    }
    if(message.type==='control_request'){await control(message);return;}
    observeSession(message.session_id);
    if(message.type==='system') {
      if(message.subtype==='task_started')throw error('unsupported_tool','The coding worker started unsupported background work.');
      if(message.subtype==='init')await emit({type:'session',sessionId:session});
      return;
    }
    check(initialized && userSent,'invalid_protocol','The coding worker emitted a result before the task was sent.');
    if(message.type==='stream_event') {
      const delta=message.event?.type==='content_block_delta' && message.event.delta;
      if(delta?.type==='text_delta') {
        check(bounded(delta.text,MAX_OUTPUT),'protocol_limit','The coding worker text exceeded its output limit.');
        check(output.length+delta.text.length<=MAX_OUTPUT,'protocol_limit','The coding worker text exceeded its output limit.');
        output+=delta.text;await emit({type:'text',text:delta.text});
      }
      return;
    }
    if(message.type==='assistant') {
      check(object(message.message) && Array.isArray(message.message.content),'invalid_protocol','The coding worker returned an invalid assistant message.');
      if(message.error==='authentication_failed')throw error('worker_authentication','Claude Code could not authenticate. Complete the approved account setup before retrying.');
      if(message.error)throw error('worker_failed','Claude Code reported a model or account error.');
      for(const block of message.message.content)if(block?.type==='text')check(bounded(block.text,MAX_OUTPUT),'protocol_limit','The coding worker message exceeded its output limit.');
      return;
    }
    if(message.type==='result') {
      check(!resultSeen,'invalid_protocol','The coding worker returned duplicate final results.');resultSeen=true;
      check(message.subtype==='success' && message.is_error===false,'worker_failed',`Claude Code did not complete successfully (${bounded(message.subtype,80)?message.subtype:'unknown result'}).`);
      check(session && bounded(message.result,MAX_OUTPUT) && message.result.trim(),'unconfirmed_result','Claude Code did not return a confirmed final response and session.');
      result={status:'completed',agent,sessionId:session,output:message.result,approvals,verification:'worker-reported; independent checks required'};
      await emit({type:'result',sessionId:session,text:message.result});
      child.stdin.end();return;
    }
    // These are observations, not permission or completion signals.
    check(['user','rate_limit_event','tool_progress','tool_use_summary','auth_status'].includes(message.type),'invalid_protocol','The coding worker returned an unsupported protocol message.');
  }
  function consume(chunk) {
    if(failure)return;
    bytes+=chunk.length;if(bytes>MAX_BYTES){fail(error('protocol_limit','The coding worker exceeded its 4 MB output limit.'));return;}
    buffer+=decoder.write(chunk);
    while(buffer.includes('\n') && !failure) {
      const index=buffer.indexOf('\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+1);
      if(!line.trim())continue;
      if(Buffer.byteLength(line)>MAX_FRAME || ++messages>MAX_MESSAGES || ++queued>128){fail(error('protocol_limit','The coding worker exceeded its protocol message limit.'));return;}
      let message;try{message=JSON.parse(line);}catch{fail(error('invalid_protocol','The coding worker returned malformed JSON.'));return;}
      // A cancelled permission must never receive a late approval, even while
      // the serialized handler waits for the owner.
      if(message?.type==='control_cancel_request'){fail(error('approval_cancelled','The coding worker cancelled its pending approval.'));return;}
      chain=chain.then(()=>handle(message)).catch(fail).finally(()=>{queued--;});
    }
    if(Buffer.byteLength(buffer)>MAX_FRAME)fail(error('protocol_limit','The coding worker exceeded its protocol frame limit.'));
  }
  const cancel=()=>fail(error('cancelled','The coding worker was cancelled.'));
  const timer=setTimeout(()=>fail(error('worker_timeout','The coding worker reached its runtime limit.')),timeoutMs);timer.unref();
  signal?.addEventListener('abort',cancel,{once:true});
  child.stdin.on('error',()=>{if(!resultSeen && !failure)fail(error('worker_input','The coding worker input stream closed.'));});
  child.stdout.on('data',consume);
  child.stdout.on('end',()=>{buffer+=decoder.end();if(buffer.trim())fail(error('invalid_protocol','The coding worker ended with an incomplete protocol frame.'));});
  child.stderr.on('data',chunk=>{
    bytes+=chunk.length;if(bytes>MAX_BYTES){fail(error('protocol_limit','The coding worker exceeded its 4 MB output limit.'));return;}
    stderr=(stderr+stderrDecoder.write(chunk)).slice(-4000);
  });
  child.once('error',()=>fail(error('worker_start','The coding worker supervisor could not start.')));
  child.on('message',message=>{
    if(message?.type==='started'){started=true;}
    if(message?.type==='start_error')fail(error('worker_start',`The coding worker could not start (${bounded(message.code,40)?message.code:'unknown error'}).`));
    if(message?.type==='exited')workerExit={exitCode:message.exitCode,signal:message.signal};
  });
  child.once('close',()=>{closed=true;closeResolve();});
  child.once('spawn',()=>{try{child.send({type:'start',executable,args:launchArguments(sessionId),stdin:'pipe'});}catch{fail(error('worker_start','The coding worker supervisor could not receive its launch request.'));}});
  let handshakeTimer;
  try {
    handshakeTimer=setTimeout(()=>fail(error('protocol_timeout','Claude Code did not acknowledge its control protocol. Check that the installed version supports restricted and safe modes.')),Math.min(15_000,timeoutMs));handshakeTimer.unref();
    await send({type:'control_request',request_id:'tupies_initialize',request:{subtype:'initialize',hooks:null,skills:[]}});
    await Promise.race([initializedPromise,closedPromise.then(()=>{throw error('worker_exited','Claude Code exited before initialization.');})]);
    clearTimeout(handshakeTimer);alive();userSent=true;
    await send({type:'user',session_id:session || '',parent_tool_use_id:null,message:{role:'user',content:prompt},client_composed:true});
    await guarded(closedPromise);
    await guarded(chain);
    if(failure)throw failure;
    check(started && workerExit?.exitCode===0,'worker_failed',`Claude Code exited without success${Number.isInteger(workerExit?.exitCode)?` (exit ${workerExit.exitCode})`:''}.`);
    check(result,'unconfirmed_result','Claude Code exited without a confirmed successful result.');
    return {...result,exitCode:0};
  } catch(reason) {
    fail(reason);
    // Preserve bounded partial text and diagnostic data for caller redaction.
    Object.assign(failure,{sessionId:session,output,stderr});throw failure;
  } finally {
    clearTimeout(timer);clearTimeout(handshakeTimer);signal?.removeEventListener('abort',cancel);
    stop();await closedPromise;clearTimeout(stopTimer);
  }
}
