import { promises as fs, constants as FS } from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { ensure, HttpError, id, now } from './store.mjs';
import { closePipesAfterExit } from './agent-tools.mjs';

const require=createRequire(import.meta.url);
const MAX_FRAME=2_000_000,MAX_PROTOCOL_BYTES=16_000_000,MAX_FILE=1_000_000,MAX_RESULTS=100,MAX_RESULT_CHARS=60000;
const terminal=new Set(['completed','failed','cancelled','interrupted','unknown']);
const integer=(value,min,max)=>Number.isSafeInteger(value) && value>=min && value<=max;
const aborted=signal=>{if(signal?.aborted)throw signal.reason || new HttpError(409,'Language-server request cancelled.');};
const inside=(root,file)=>file===root || file.startsWith(root+path.sep);
const supported=value=>value===true || Boolean(value && typeof value==='object' && !Array.isArray(value));
const languageId=file=>({'.ts':'typescript','.mts':'typescript','.cts':'typescript','.tsx':'typescriptreact','.js':'javascript','.mjs':'javascript','.cjs':'javascript','.jsx':'javascriptreact','.json':'json','.py':'python','.rs':'rust','.go':'go','.c':'c','.h':'c','.cpp':'cpp','.java':'java'})[path.extname(file).toLowerCase()] || 'plaintext';
const methods={definition:['textDocument/definition','definitionProvider'],type_definition:['textDocument/typeDefinition','typeDefinitionProvider'],implementation:['textDocument/implementation','implementationProvider'],references:['textDocument/references','referencesProvider'],hover:['textDocument/hover','hoverProvider'],document_symbols:['textDocument/documentSymbol','documentSymbolProvider'],workspace_symbols:['workspace/symbol','workspaceSymbolProvider'],prepare_call_hierarchy:['textDocument/prepareCallHierarchy','callHierarchyProvider']};
const digest=value=>createHash('sha256').update(value).digest('hex');

/** A standard Content-Length JSON-RPC connection; it never honors server actions. */
class StdioConnection {
  constructor(child,{onNotification,onFailure,requestTimeoutMs}) {
    this.child=child;this.onNotification=onNotification;this.onFailure=onFailure;this.requestTimeoutMs=requestTimeoutMs;
    this.buffer=Buffer.alloc(0);this.length=null;this.bytes=0;this.stderrBytes=0;this.counter=0;this.pending=new Map();this.closed=false;this.stderr='';
    child.stdout.on('data',chunk=>this.receive(chunk));
    child.stderr.on('data',chunk=>{if(this.closed)return;this.stderrBytes+=chunk.length;this.stderr=(this.stderr+chunk.toString('utf8')).slice(-32000);if(this.stderrBytes>1_000_000)this.fail(new HttpError(413,'Language-server error output exceeded its session limit.'));});
    child.stdin.on('error',()=>this.fail(new HttpError(502,'Language-server input closed.')));
    child.on('error',error=>this.fail(new HttpError(400,`Could not start language server (${error.code || 'process error'}).`)));
    child.once('close',(code,signal)=>this.fail(new HttpError(502,`Language server exited (${signal || (code ?? 'unknown')}).`)));
  }
  send(message) {
    ensure(!this.closed,409,'The language-server session is closed.');
    const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',...message}));ensure(bytes.length<=MAX_FRAME,413,'Language-server request exceeds its frame limit.');
    if(this.child.stdin.writableLength+bytes.length>4_000_000){const error=new HttpError(413,'Language-server input queue exceeded its limit.');this.fail(error);throw error;}
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`),bytes]));
  }
  notify(method,params) {this.send({method,params});}
  request(method,params,{signal,timeoutMs=this.requestTimeoutMs}={}) {
    aborted(signal);ensure(!this.closed,409,'The language-server session is closed.');ensure(this.pending.size<8,429,'Too many language-server requests are pending.');
    const requestId=++this.counter;
    return new Promise((resolve,reject)=>{
      let timer;
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.pending.delete(requestId);};
      const finish=(error,result)=>{cleanup();error?reject(error):resolve(result);};
      const cancel=error=>{if(!this.pending.has(requestId))return;try{this.notify('$/cancelRequest',{id:requestId});}catch{}finish(error);};
      const abort=()=>cancel(signal.reason || new HttpError(409,'Language-server request cancelled.'));
      this.pending.set(requestId,{finish});signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>cancel(new HttpError(504,'The language-server request timed out.')),timeoutMs);timer.unref();
      try{this.send({id:requestId,method,params});}catch(error){finish(error);}
      if(signal?.aborted)abort();
    });
  }
  receive(chunk) {
    if(this.closed)return;
    try {
      this.bytes+=chunk.length;ensure(this.bytes<=MAX_PROTOCOL_BYTES,413,'Language-server output exceeded its session limit.');
      this.buffer=Buffer.concat([this.buffer,chunk]);
      while(this.buffer.length) {
        if(this.length===null) {
          const end=this.buffer.indexOf('\r\n\r\n');ensure(end>=0 || this.buffer.length<=4096,502,'Language-server header exceeded its limit.');if(end<0)return;
          ensure(end<=4096,502,'Language-server header exceeded its limit.');
          const header=this.buffer.subarray(0,end).toString('ascii'),lengths=[...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
          ensure(lengths.length===1,502,'Language server sent an invalid Content-Length header.');
          const length=Number(lengths[0][1]);ensure(integer(length,1,MAX_FRAME),413,'Language-server frame exceeded its limit.');
          const type=header.match(/^Content-Type:\s*(.+)$/im)?.[1];ensure(!type || !/charset=/i.test(type) || /charset\s*=\s*utf-?8\b/i.test(type),502,'Language server sent an unsupported encoding.');
          this.length=length;this.buffer=this.buffer.subarray(end+4);
        }
        if(this.buffer.length<this.length)return;
        const bytes=this.buffer.subarray(0,this.length);this.buffer=this.buffer.subarray(this.length);this.length=null;
        let message;try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new HttpError(502,'Language server sent malformed JSON.');}
        ensure(message && typeof message==='object' && !Array.isArray(message) && message.jsonrpc==='2.0',502,'Language server sent an invalid JSON-RPC message.');
        if(typeof message.method==='string') {
          ensure(message.method.length<=200,502,'Language server sent an invalid method.');
          if(Object.hasOwn(message,'id'))this.respond(message);else this.onNotification?.(message.method,message.params);
        } else if(this.pending.has(message.id)) {
          const pending=this.pending.get(message.id);
          pending.finish(message.error?new HttpError(502,`Language-server request failed (${integer(message.error.code,-2147483648,2147483647)?message.error.code:'protocol error'}).`):null,message.result);
        }
      }
    } catch(error){this.fail(error);}
  }
  respond(message) {
    // No LSP message may become a write, command, download, UI action or approval.
    if(message.method==='workspace/applyEdit')this.send({id:message.id,result:{applied:false,failureReason:'Workspace edits require Tupies tools and exact engine authorization.'}});
    else if(message.method==='window/workDoneProgress/create' || message.method==='window/showMessageRequest')this.send({id:message.id,result:null});
    else this.send({id:message.id,error:{code:-32601,message:'This server-initiated request is not supported by Tupies.'}});
  }
  fail(error) {
    if(this.closed)return;this.closed=true;
    for(const pending of [...this.pending.values()])pending.finish(error);
    this.buffer=Buffer.alloc(0);this.onFailure?.(error);
  }
}

export class LanguageServers {
  constructor(store,options={}) {this.store=store;this.options=options;this.sessions=new Map();this.starting=new Map();this.closedRuns=new Set();this.closing=false;}
  assertOwner({botId,runId}) {
    ensure(typeof botId==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(botId) && typeof runId==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(runId),400,'Use a valid language-server owner and run.');
    const run=this.store.state.runs[botId];ensure(run?.id===runId && !terminal.has(run.status),409,'Language servers belong to the current active task only.');
    ensure(!this.closedRuns.has(runId),409,'Language-server work for this task is already closed.');
  }
  session(args) {this.assertOwner(args);const session=this.sessions.get(args.sessionId);ensure(session && session.botId===args.botId && session.runId===args.runId,404,'Language-server session not found for this bot and run.');ensure(session.status==='ready',409,'The language-server session is not ready.');return session;}
  clean(session,value,max=4000) {
    return this.store.redact(String(value ?? '')).split(session.workspace).join('.').split(session.root).join('.').replace(/file:\/\/[^\s"'<>`)]*/gi,'[file URI omitted]').replace(/\b[A-Za-z]:[\\/][^\s"'<>`)]*/g,'[host path omitted]').replace(/\/(?:Users|home|private|var|tmp|etc|usr|opt|Volumes|root|mnt|srv|proc|dev)\/[^\s"'<>`)]*/g,'[host path omitted]').slice(0,max);
  }
  metadata(session) {return {id:session.id,sessionId:session.id,server:session.server,rootPath:session.rootPath,status:session.status,createdAt:session.createdAt,updatedAt:now(),...(session.capabilities?{capabilities:session.capabilities}:{}),...(session.error?{error:this.clean(session,session.error,1000)}:{})};}
  async persist(session) {await this.store.mutate(state=>{const run=state.runs[session.botId];if(run?.id!==session.runId)return;const items=run.languageServers ||= [],index=items.findIndex(item=>item.id===session.id),record=this.metadata(session);if(index>=0)items[index]=record;else {ensure(items.length<20,400,'This task reached its language-server session limit.');items.push(record);}run.updatedAt=now();});}
  async recover() {await this.store.mutate(state=>{for(const run of Object.values(state.runs))for(const session of run?.languageServers || [])if(['starting','ready','stopping'].includes(session.status))Object.assign(session,{status:'interrupted',updatedAt:now(),error:'Tupies restarted; this language server was not relaunched.'});});}
  async start(args,{signal}={}) {
    this.assertOwner(args);aborted(signal);ensure(!this.closing,503,'Language-server service is closing.');
    const admissions=[...this.starting.values()].filter(item=>!item.sessionId);
    ensure(this.sessions.size+admissions.length<(this.options.maxServers || 4),429,'The language-server process limit has been reached.');
    ensure([...this.sessions.values(),...admissions].filter(item=>item.runId===args.runId).length<2,429,'This task already has two language-server sessions.');
    ensure(['typescript','custom'].includes(args.server),400,'Choose typescript or an explicitly approved custom language server.');
    const admission=id('lspstart'),controller=new AbortController();signal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;this.starting.set(admission,{runId:args.runId,controller,sessionId:null});let session;
    try {
      const {getWorkspaceRoot,safePath}=await import('./agent-tools.mjs');
      const workspace=await fs.realpath(await getWorkspaceRoot(this.store,args.botId)),rootPath=args.rootPath ?? '.',root=await safePath(workspace,rootPath,{allowRoot:true});
      ensure((await fs.lstat(root)).isDirectory(),400,'Choose a workspace folder for the language server.');
      let executable,processArgs,initializationOptions={};
      if(args.server==='typescript') {
        ensure(args.executable===undefined && args.args===undefined,400,'The bundled TypeScript server does not accept custom executable arguments.');
        const cli=fileURLToPath(import.meta.resolve('typescript-language-server/lib/cli.mjs')),tsserver=require.resolve('typescript/lib/tsserver.js');
        executable=process.execPath;processArgs=[cli,'--stdio','--log-level','1'];
        initializationOptions={hostInfo:'Tupies',disableAutomaticTypingAcquisition:true,plugins:[],maxTsServerMemory:256,tsserver:{path:tsserver,fallbackPath:tsserver,logVerbosity:'off',trace:'off',useClientFileWatcher:false}};
      } else {
        ensure(typeof args.executable==='string' && args.executable.length>0 && args.executable.length<=240 && !/[\x00-\x1f\x7f]/.test(args.executable),400,'Choose a valid custom language-server executable.');
        ensure(Array.isArray(args.args) && args.args.length<=50 && args.args.every(value=>typeof value==='string' && value.length<=2000 && !value.includes('\0')),400,'Language-server arguments must be bounded literal strings.');
        executable=args.executable;processArgs=args.args;
      }
      this.assertOwner(args);aborted(signal);
      const temp=await safePath(workspace,'.tmp',{allowMissing:true});await fs.mkdir(temp,{recursive:true,mode:0o700});
      await safePath(workspace,'.tmp');ensure((await fs.lstat(temp)).isDirectory(),400,'Language-server temporary storage must be a real directory.');
      session={id:id('lsp'),botId:args.botId,runId:args.runId,server:args.server,rootPath,root,workspace,status:'starting',createdAt:now(),documents:new Map(),diagnostics:new Map(),hierarchyItems:new Map(),waiters:new Set(),queue:Promise.resolve(),signal};
      await this.persist(session);this.assertOwner(args);aborted(signal);
      const child=fork(fileURLToPath(new URL('./process-supervisor.mjs',import.meta.url)),[],{execArgv:[],cwd:root,detached:process.platform!=='win32',windowsHide:true,stdio:['pipe','pipe','pipe','ipc'],env:{PATH:'/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin',HOME:workspace,TMPDIR:temp,LANG:'C.UTF-8',NODE_OPTIONS:'--max-old-space-size=256',TSS_LOG:'',TSC_NONPOLLING_WATCHER:'true'}});
      session.child=child;session.closed=new Promise(resolve=>child.once('close',resolve));closePipesAfterExit(child);this.sessions.set(session.id,session);
      this.starting.get(admission).sessionId=session.id;
      session.connection=new StdioConnection(child,{requestTimeoutMs:this.options.requestTimeoutMs || 10000,onNotification:(method,params)=>this.notification(session,method,params),onFailure:error=>{if(!['stopping','stopped'].includes(session.status)){session.status='failed';session.error=error.message;void this.terminate(session).catch(()=>{});}}});
      child.on('message',message=>{if(message?.type==='start_error')session.connection.fail(new HttpError(400,`Could not start language server (${String(message.code || 'process error').slice(0,100)}).`));else if(message?.type==='exited')session.connection.fail(new HttpError(502,`Language server exited (${message.signal || (message.exitCode ?? 'unknown')}).`));});
      child.send({type:'start',executable,args:processArgs,stdin:'pipe'},error=>{if(error)session.connection.fail(new HttpError(502,'Could not initialize the language-server supervisor.'));});
      session.onAbort=()=>{session.cancelled=true;session.error='Language server cancelled with its task.';void this.terminate(session).catch(()=>{});};signal?.addEventListener('abort',session.onAbort,{once:true});
      const timerMs=Math.min(this.options.sessionTimeoutMs || 1_800_000,1_800_000);session.timer=setTimeout(()=>{session.error='Language-server session reached its time limit.';void this.terminate(session).catch(()=>{});},timerMs);session.timer.unref();
      const initialized=await session.connection.request('initialize',{processId:process.pid,clientInfo:{name:'Tupies',version:'0.4.0'},rootUri:pathToFileURL(root).href,workspaceFolders:[{uri:pathToFileURL(root).href,name:path.basename(root)}],capabilities:{general:{positionEncodings:['utf-16']},workspace:{applyEdit:false,configuration:false,workspaceFolders:true},textDocument:{synchronization:{dynamicRegistration:false,didSave:false},definition:{dynamicRegistration:false,linkSupport:true},typeDefinition:{dynamicRegistration:false,linkSupport:true},implementation:{dynamicRegistration:false,linkSupport:true},callHierarchy:{dynamicRegistration:false},references:{dynamicRegistration:false},hover:{dynamicRegistration:false,contentFormat:['plaintext']},documentSymbol:{dynamicRegistration:false,hierarchicalDocumentSymbolSupport:true},publishDiagnostics:{versionSupport:true,relatedInformation:false},diagnostic:{dynamicRegistration:false}}},initializationOptions},{signal});
      ensure(initialized?.capabilities && typeof initialized.capabilities==='object',502,'Language server did not return capabilities.');
      ensure(!initialized.capabilities.positionEncoding || initialized.capabilities.positionEncoding==='utf-16',502,'The language server requires an unsupported position encoding.');
      session.rawCapabilities=initialized.capabilities;
      session.capabilities=Object.fromEntries(Object.entries(methods).map(([name,[,key]])=>[name,supported(initialized.capabilities[key])]));session.capabilities.incoming_calls=session.capabilities.prepare_call_hierarchy;session.capabilities.outgoing_calls=session.capabilities.prepare_call_hierarchy;session.capabilities.diagnostics=supported(initialized.capabilities.diagnosticProvider)?'pull':'push';
      session.connection.notify('initialized',{});session.status='ready';await this.persist(session);aborted(signal);ensure(session.status==='ready' && !session.connection.closed,502,'The language server exited during initialization.');return this.metadata(session);
    } catch(error) {
      if(session){session.status='failed';session.error=error.message;await this.terminate(session).catch(()=>{});}
      throw new HttpError(error.status || 502,this.store.redact(error.message || 'Language-server initialization failed.'));
    } finally {this.starting.delete(admission);}
  }
  notification(session,method,params) {
    if(method!=='textDocument/publishDiagnostics' || !params || typeof params.uri!=='string' || !Array.isArray(params.diagnostics))return;
    const document=session.documents.get(params.uri);if(!document)return;
    if(params.version!==undefined && params.version!==document.version)return;
    session.diagnostics.set(params.uri,{version:params.version ?? null,receivedAt:Date.now(),items:params.diagnostics.slice(0,500),truncated:params.diagnostics.length>500});
    for(const waiter of [...session.waiters])waiter();
  }
  async read(session,relative) {
    const {safePath}=await import('./agent-tools.mjs');const file=await safePath(session.workspace,relative);ensure(inside(session.root,file),403,'Language-server files must stay inside the selected project root.');
    const handle=await fs.open(file,FS.O_RDONLY | (FS.O_NOFOLLOW || 0) | (FS.O_NONBLOCK || 0));
    try {const stat=await handle.stat();ensure(stat.isFile() && stat.size<=MAX_FILE,413,'Language-server files must be regular UTF-8 files up to 1 MB.');const bytes=Buffer.alloc(stat.size+1);let size=0;
      while(size<bytes.length){const result=await handle.read(bytes,size,bytes.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}
      const after=await handle.stat();ensure(size===stat.size && after.size===stat.size && after.mtimeMs===stat.mtimeMs,409,'The file changed while synchronizing. Read it again.');
      let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size));}catch{throw new HttpError(400,'Language-server documents must use UTF-8 text.');}ensure(!content.includes('\0'),400,'Language-server documents cannot contain binary data.');return {file,content,uri:pathToFileURL(file).href};
    } finally {await handle.close();}
  }
  async sync(session,relative) {
    const read=await this.read(session,relative),previous=session.documents.get(read.uri);ensure(previous || session.documents.size<20,400,'This language-server session already has 20 open documents.');
    if(!previous){session.documents.set(read.uri,{...read,path:relative,version:1});session.connection.notify('textDocument/didOpen',{textDocument:{uri:read.uri,languageId:languageId(read.file),version:1,text:read.content}});}
    else if(previous.content!==read.content){session.diagnostics.delete(read.uri);Object.assign(previous,read,{version:previous.version+1});session.connection.notify('textDocument/didChange',{textDocument:{uri:read.uri,version:previous.version},contentChanges:[{text:read.content}]});}
    return session.documents.get(read.uri);
  }
  closeDocument(session,document) {
    session.connection.notify('textDocument/didClose',{textDocument:{uri:document.uri}});session.documents.delete(document.uri);session.diagnostics.delete(document.uri);
    for(const [key,value] of session.hierarchyItems)if(value.path===document.path)session.hierarchyItems.delete(key);
  }
  async uriPath(session,uri) {
    if(typeof uri!=='string' || uri.length>8000)return null;
    try {const parsed=new URL(uri);if(parsed.protocol!=='file:' || parsed.host || parsed.search || parsed.hash)return null;const file=fileURLToPath(parsed);if(!inside(session.root,file))return null;const relative=path.relative(session.workspace,file).split(path.sep).join('/');const {safePath}=await import('./agent-tools.mjs');const resolved=await safePath(session.workspace,relative);if(!(await fs.lstat(resolved)).isFile())return null;return relative;}catch{return null;}
  }
  range(value) {if(!value || ![value.start,value.end].every(point=>point && integer(point.line,0,1000000) && integer(point.character,0,1000000)) || value.end.line<value.start.line || (value.end.line===value.start.line && value.end.character<value.start.character))return null;return {start:{line:value.start.line+1,character:value.start.character+1},end:{line:value.end.line+1,character:value.end.character+1}};}
  async locations(session,value) {
    const values=value===null?[]:Array.isArray(value)?value:[value],locations=[];let blockedLocations=0,chars=0;
    for(const item of values.slice(0,500)){const relative=await this.uriPath(session,item?.targetUri ?? item?.uri),range=this.range(item?.targetSelectionRange ?? item?.targetRange ?? item?.range);if(!relative || !range){blockedLocations++;continue;}const location={path:relative,range};chars+=JSON.stringify(location).length;if(locations.length>=MAX_RESULTS || chars>MAX_RESULT_CHARS)break;locations.push(location);}
    return {locations,blockedLocations,truncated:values.length>500 || locations.length+blockedLocations<values.length};
  }
  async symbols(session,values,documentPath) {
    const symbols=[];let blockedLocations=0,visited=0,chars=0,truncated=false;
    const walk=async(items,parent='',depth=0)=>{if(!Array.isArray(items))return;for(const item of items){if(++visited>500 || depth>10 || symbols.length>=MAX_RESULTS || chars>MAX_RESULT_CHARS){truncated=true;break;}const relative=item?.location?await this.uriPath(session,item.location.uri):documentPath,range=this.range(item?.location?.range ?? item?.selectionRange ?? item?.range);if(!relative || !range){blockedLocations++;continue;}const name=this.clean(session,item.name,MAX_FRAME),detail=typeof item.detail==='string'?this.clean(session,item.detail,MAX_FRAME):null,textTruncated=name.length>240 || (detail?.length || 0)>1000;if(textTruncated)truncated=true;const symbol={name:name.slice(0,240),kind:integer(item.kind,1,26)?item.kind:null,path:relative,range,...(parent?{containerName:parent}:{}),...(detail!==null?{detail:detail.slice(0,1000)}:{}),...(textTruncated?{textTruncated:true}:{})};chars+=JSON.stringify(symbol).length;symbols.push(symbol);if(item.children)await walk(item.children,symbol.name,depth+1);}};
    await walk(values);return {symbols,blockedLocations,truncated};
  }
  async hierarchyItem(session,item,revisions) {
    const relative=await this.uriPath(session,item?.uri),range=this.range(item?.range),selectionRange=this.range(item?.selectionRange);
    if(!relative || !range || !selectionRange || JSON.stringify(item).length>16000)return null;
    let revision=revisions.get(relative);if(!revision){revision=digest((await this.read(session,relative)).content);revisions.set(relative,revision);}
    const itemId=id('call');session.hierarchyItems.set(itemId,{item:structuredClone(item),path:relative,revision});
    while(session.hierarchyItems.size>100)session.hierarchyItems.delete(session.hierarchyItems.keys().next().value);
    const name=this.clean(session,item.name,MAX_FRAME),detail=typeof item.detail==='string'?this.clean(session,item.detail,MAX_FRAME):null,textTruncated=name.length>240 || (detail?.length || 0)>1000;
    return {itemId,name:name.slice(0,240),kind:integer(item.kind,1,26)?item.kind:null,path:relative,range,selectionRange,...(detail!==null?{detail:detail.slice(0,1000)}:{}),...(textTruncated?{textTruncated:true}:{})};
  }
  async hierarchy(session,values,operation) {
    const list=Array.isArray(values)?values:[],items=[],revisions=new Map();let blockedLocations=0,chars=0,truncated=list.length>30;
    for(const entry of list.slice(0,30)){const item=await this.hierarchyItem(session,operation==='prepare_call_hierarchy'?entry:operation==='incoming_calls'?entry?.from:entry?.to,revisions);if(!item){blockedLocations++;continue;}const rawRanges=Array.isArray(entry.fromRanges)?entry.fromRanges:[],fromRanges=rawRanges.slice(0,20).map(value=>this.range(value)).filter(Boolean),rangesTruncated=rawRanges.length>20 || fromRanges.length!==rawRanges.length;const normalized=operation==='prepare_call_hierarchy'?item:{item,fromRanges,rangesTruncated};if(rangesTruncated || item.textTruncated)truncated=true;const size=JSON.stringify(normalized).length;if(chars+size>MAX_RESULT_CHARS){truncated=true;break;}chars+=size;items.push(normalized);}
    return {items,blockedLocations,truncated};
  }
  async diagnostics(session,document,{signal}) {
    let report,source;
    if(session.capabilities.diagnostics==='pull') {const response=await session.connection.request('textDocument/diagnostic',{textDocument:{uri:document.uri}},{signal});if(response?.kind==='full' && Array.isArray(response.items))report={items:response.items,version:document.version,truncated:false};source='pull';}
    else {
      source='push';const current=()=>session.diagnostics.get(document.uri);
      if(!current())await new Promise((resolve,reject)=>{let timer;const done=error=>{clearTimeout(timer);session.waiters.delete(check);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};const check=error=>{if(error)done(error);else if(current())done();};const abort=()=>done(signal.reason || new HttpError(409,'Language-server request cancelled.'));session.waiters.add(check);signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>done(),this.options.diagnosticsWaitMs ?? 2000);timer.unref();if(signal?.aborted)abort();else check();});
      report=current();
    }
    const diagnostics=[];let chars=0,truncated=!!report?.truncated;
    for(const item of report?.items || []){if(diagnostics.length>=MAX_RESULTS || chars>MAX_RESULT_CHARS){truncated=true;break;}const range=this.range(item?.range);if(!range){truncated=true;continue;}const message=this.clean(session,item.message,MAX_FRAME),code=typeof item.code==='string' || typeof item.code==='number'?this.clean(session,item.code,MAX_FRAME):null,source=typeof item.source==='string'?this.clean(session,item.source,MAX_FRAME):null,textTruncated=message.length>4000 || (code?.length || 0)>100 || (source?.length || 0)>100;if(textTruncated)truncated=true;const diagnostic={range,message:message.slice(0,4000),severity:integer(item.severity,1,4)?item.severity:null,...(code!==null?{code:code.slice(0,100)}:{}),...(source!==null?{source:source.slice(0,100)}:{}),...(textTruncated?{textTruncated:true}:{})};chars+=JSON.stringify(diagnostic).length;diagnostics.push(diagnostic);}
    return {diagnostics,source,received:!!report,version:report?.version ?? null,versioned:report?.version!==undefined && report?.version!==null,truncated,...(!report?{notice:'No diagnostic report arrived within the bounded wait. This does not prove the file has no errors.'}:{})};
  }
  async query(args,{signal}={}) {
    const session=this.session(args);aborted(signal);ensure(['diagnostics','incoming_calls','outgoing_calls',...Object.keys(methods)].includes(args.operation),400,'Choose a supported language-server operation.');
    const closedDocuments=[],previous=session.queue,job=previous.catch(()=>{}).then(async()=>{
      this.session(args);aborted(signal);
      // Workspace and hierarchy operations must see edits to already-open dependencies too.
      const primaryPath=['workspace_symbols','incoming_calls','outgoing_calls'].includes(args.operation)?null:args.path;
      for(const document of [...session.documents.values()]) {
        try{await this.sync(session,document.path);}catch(error){if(document.path!==primaryPath && (error.status===404 || error.code==='ENOENT')){this.closeDocument(session,document);closedDocuments.push(document.path);}else throw error;}
      }
      if(['incoming_calls','outgoing_calls'].includes(args.operation)) {
        ensure(session.capabilities[args.operation],400,'This language server does not advertise call hierarchy.');ensure(typeof args.itemId==='string',400,'Use an itemId returned by this session’s call hierarchy.');const selected=session.hierarchyItems.get(args.itemId);ensure(selected,404,'This call-hierarchy item is unavailable or expired. Prepare the hierarchy again.');
        const current=await this.sync(session,selected.path);ensure(digest(current.content)===selected.revision,409,'The call-hierarchy file changed. Prepare the hierarchy again.');
        const response=await session.connection.request(args.operation==='incoming_calls'?'callHierarchy/incomingCalls':'callHierarchy/outgoingCalls',{item:selected.item},{signal});return {operation:args.operation,...await this.hierarchy(session,response,args.operation)};
      }
      if(args.operation==='workspace_symbols') {ensure(session.capabilities.workspace_symbols,400,'This language server does not advertise workspace symbols.');ensure(typeof args.query==='string' && args.query.length<=200,400,'Use a workspace-symbol query up to 200 characters.');const result=await session.connection.request('workspace/symbol',{query:args.query},{signal});return {operation:args.operation,...await this.symbols(session,result,null)};}
      ensure(typeof args.path==='string',400,'Choose a private relative file path.');
      const document=await this.sync(session,args.path);
      if(args.operation==='diagnostics')return {operation:args.operation,path:args.path,...await this.diagnostics(session,document,{signal})};
      ensure(session.capabilities[args.operation],400,`This language server does not advertise ${args.operation}.`);
      let params={textDocument:{uri:document.uri}};
      if(['definition','type_definition','implementation','references','hover','prepare_call_hierarchy'].includes(args.operation)) {const line=args.line ?? 1,character=args.character ?? 1,lines=document.content.split('\n');ensure(integer(line,1,lines.length) && integer(character,1,lines[line-1].length+1),400,'Use a valid 1-based line and UTF-16 character position.');params.position={line:line-1,character:character-1};}
      if(args.operation==='references'){ensure(args.includeDeclaration===undefined || typeof args.includeDeclaration==='boolean',400,'includeDeclaration must be a boolean.');params.context={includeDeclaration:args.includeDeclaration ?? true};}
      const result=await session.connection.request(methods[args.operation][0],params,{signal});aborted(signal);
      if(['definition','type_definition','implementation','references'].includes(args.operation))return {operation:args.operation,path:args.path,...await this.locations(session,result)};
      if(args.operation==='document_symbols')return {operation:args.operation,path:args.path,...await this.symbols(session,result,args.path)};
      if(args.operation==='prepare_call_hierarchy')return {operation:args.operation,path:args.path,...await this.hierarchy(session,result,args.operation)};
      const parts=Array.isArray(result?.contents)?result.contents:[result?.contents],content=parts.map(part=>typeof part==='string'?part:typeof part?.value==='string'?part.value:'').join('\n\n');
      const cleaned=this.clean(session,content,MAX_FRAME);return {operation:args.operation,path:args.path,content:cleaned.slice(0,12000),range:this.range(result?.range),truncated:cleaned.length>12000};
    });
    session.queue=job;return job.then(result=>closedDocuments.length?{...result,closedDocuments}:result);
  }
  list(args) {this.assertOwner(args);return {sessions:[...this.sessions.values()].filter(session=>session.botId===args.botId && session.runId===args.runId).map(session=>this.metadata(session))};}
  async terminate(session) {
    if(session.termination)return session.termination;
    session.termination=(async()=>{
      const failed=session.status==='failed' || (!!session.error && !session.cancelled);session.status='stopping';clearTimeout(session.timer);session.signal?.removeEventListener('abort',session.onAbort);
      const child=session.child;
      if(child){const kill=signal=>{try{if(process.platform!=='win32' && child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{}};try{if(child.connected)child.send({type:'stop'},error=>{if(error)kill('SIGTERM');});else kill('SIGTERM');}catch{kill('SIGTERM');}const timer=setTimeout(()=>kill('SIGKILL'),750);timer.unref();await session.closed;clearTimeout(timer);session.connection?.fail(new HttpError(409,'Language-server session closed.'));}
      session.status=failed?'failed':'stopped';for(const waiter of [...session.waiters])waiter(new HttpError(409,'Language-server session closed.'));session.waiters.clear();session.documents.clear();session.diagnostics.clear();session.hierarchyItems.clear();this.sessions.delete(session.id);await this.persist(session);
    })();return session.termination;
  }
  async stop(args) {const session=this.session(args);await this.terminate(session);return this.metadata(session);}
  async closeRun(runId) {this.closedRuns.add(runId);while(this.closedRuns.size>2000)this.closedRuns.delete(this.closedRuns.values().next().value);for(const admission of this.starting.values())if(admission.runId===runId)admission.controller.abort(new HttpError(409,'Language-server task closed.'));await Promise.allSettled([...this.sessions.values()].filter(session=>session.runId===runId).map(session=>this.terminate(session)));while([...this.starting.values()].some(item=>item.runId===runId))await new Promise(resolve=>setTimeout(resolve,5));}
  async close() {this.closing=true;for(const admission of this.starting.values())admission.controller.abort(new HttpError(409,'Language-server service closed.'));while(this.starting.size)await new Promise(resolve=>setTimeout(resolve,5));await Promise.allSettled([...this.sessions.values()].map(session=>this.terminate(session)));}
}
