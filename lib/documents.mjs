import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { getWorkspaceRoot, safePath } from './agent-tools.mjs';
import { ensure, HttpError } from './store.mjs';
import { DOCUMENT_LIMITS, FORMATS, validateDocumentSpec } from './document-spec.mjs';

export { validateDocumentSpec } from './document-spec.mjs';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const worker=path.join(app,'lib','document-worker.mjs');
const pending=[];let active=0;
const abortError=()=>Object.assign(new Error('Document operation cancelled.'),{name:'AbortError',status:499});
export function supportedDocumentFormats(){return Object.entries(FORMATS).map(([format,mime])=>({format,mime,extensions:[format],read:true,create:true}));}
export function documentFormat(relative){
  ensure(typeof relative==='string',400,'Document path must be text.');
  const extension=path.extname(relative).slice(1).toLowerCase();
  ensure(Object.hasOwn(FORMATS,extension),415,'Supported document formats: PDF, DOCX, PPTX, XLSX, Markdown, text, CSV and JSON. Legacy and macro-enabled binaries are not supported.');
  return {format:extension,extension,mime:FORMATS[extension]};
}

function admit(job,signal){
  if(signal?.aborted)return Promise.reject(abortError());
  if(active>=2&&pending.length>=2)return Promise.reject(new HttpError(429,'Document workers are busy. Try again shortly.'));
  return new Promise((resolve,reject)=>{
    const item={run:()=>{signal?.removeEventListener('abort',cancel);active++;job().then(resolve,reject).finally(()=>{active--;pending.shift()?.run();});}};
    const cancel=()=>{const index=pending.indexOf(item);if(index>=0){pending.splice(index,1);reject(abortError());}};
    if(active<2)item.run();else {pending.push(item);signal?.addEventListener('abort',cancel,{once:true});}
  });
}

function runWorker(request,{signal}={}){
  if(signal?.aborted)throw abortError();
  return new Promise((resolve,reject)=>{
    // Node's permission gate is defense in depth for application code; native renderers are trusted
    // dependencies, so this is not a general-purpose hostile-code sandbox. The child receives bytes
    // through stdin, never a workspace path or provider environment.
    const permissionFlag=Number(process.versions.node.split('.')[0])>=23?'--permission':'--experimental-permission';
    const args=['--max-old-space-size=256',permissionFlag,'--allow-addons',
      `--allow-fs-read=${path.join(app,'lib')}`,`--allow-fs-read=${path.join(app,'node_modules')}`,
      `--allow-fs-read=${path.join(app,'assets','fonts')}`,`--allow-fs-read=${path.join(app,'package.json')}`,worker];
    const child=spawn(process.execPath,args,{cwd:app,env:{NODE_ENV:'production',TZ:'UTC'},stdio:['pipe','pipe','pipe'],windowsHide:true});
    let finished=false,bytes=0;const chunks=[];let stderr='';
    const settle=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(error){child.kill('SIGKILL');reject(error);}else resolve(value);};
    const cancel=()=>settle(abortError());
    const timer=setTimeout(()=>settle(new HttpError(408,'Document processing exceeded 25 seconds.')),25000);timer.unref();
    signal?.addEventListener('abort',cancel,{once:true});
    child.on('error',()=>settle(new HttpError(500,'The document worker could not start.')));
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>Math.ceil(DOCUMENT_LIMITS.outputBytes*4/3)+1_000_000)return settle(new HttpError(413,'Document output exceeds 20 MB.'));chunks.push(chunk);});
    child.stderr.on('data',chunk=>{if(stderr.length<8000)stderr+=chunk.toString();});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{
      if(finished)return;
      if(code!==0)return settle(new HttpError(422,'The document could not be processed within the worker resource limits.'));
      try{const reply=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!reply.ok)return settle(new HttpError([400,413,415,422].includes(reply.status)?reply.status:422,reply.error||'The document could not be processed.'));settle(null,reply.result);}
      catch{return settle(new HttpError(422,'The document worker returned an invalid response.'));}
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// Prepared images by file and version, so a conversation's images are fitted once rather than on every task.
const preparedImages=new Map();
/**
 * One private workspace image fitted for a model in the worker: `{mediaType,data,width,height,bytes}`. An expected size
 * that no longer matches means the file changed after it was attached, and it is refused rather than shown.
 */
export async function prepareImage(store,botId,relative,{signal,expectedSize}={}){
  ensure(typeof relative==='string' && ['png','jpg','jpeg','webp'].includes(path.extname(relative).slice(1).toLowerCase()),415,'Only PNG, JPEG and WebP images can be shown to a model.');
  const root=await getWorkspaceRoot(store,botId),file=await safePath(root,relative),stat=await fs.stat(file);
  ensure(stat.isFile() && stat.size<=DOCUMENT_LIMITS.inputBytes,413,'Choose a regular image up to 20 MB.');
  ensure(expectedSize===undefined || stat.size===expectedSize,409,'The image changed after it was attached.');
  const key=`${file}\n${stat.size}\n${stat.mtimeMs}`,cached=preparedImages.get(key);
  if(cached){preparedImages.delete(key);preparedImages.set(key,cached);return cached;}
  const result=await admit(async()=>{
    let handle;
    try{
      handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const admitted=Number((await handle.stat()).size),buffer=Buffer.allocUnsafe(admitted+1);let length=0;
      while(length<buffer.length){const part=await handle.read(buffer,length,buffer.length-length,length);if(!part.bytesRead)break;length+=part.bytesRead;}
      ensure(length===stat.size,409,'The image changed while it was being read.');
      return await runWorker({operation:'image',data:buffer.subarray(0,length).toString('base64')},{signal});
    }finally{await handle?.close();}
  },signal);
  preparedImages.set(key,result);
  for(let total=[...preparedImages.values()].reduce((sum,item)=>sum+item.data.length,0);preparedImages.size>1 && (preparedImages.size>24 || total>40_000_000);){
    const [oldest,item]=preparedImages.entries().next().value;preparedImages.delete(oldest);total-=item.data.length;
  }
  return result;
}

export async function inspectDocument(store,botId,relative,{signal,maxChars=60000}={}){
  const info=documentFormat(relative);
  ensure(Number.isInteger(maxChars)&&maxChars>=100&&maxChars<=DOCUMENT_LIMITS.textChars,400,'Document text limit must be 100–200000 characters.');
  if(signal?.aborted)throw abortError();
  // Admission precedes file allocation, so simultaneous requests cannot bypass the memory bound.
  return admit(async()=>{
    const root=await getWorkspaceRoot(store,botId),file=await safePath(root,relative);
    let handle;
    try{
    handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();
    ensure(stat.isFile()&&stat.size<=DOCUMENT_LIMITS.inputBytes,413,'Choose a regular document up to 20 MB.');
    // Read at most one byte beyond the admitted size, even if another writer grows the file.
    const admitted=Number(stat.size),buffer=Buffer.allocUnsafe(admitted+1);let length=0;
    while(length<buffer.length){const part=await handle.read(buffer,length,buffer.length-length,length);if(!part.bytesRead)break;length+=part.bytesRead;}
    ensure(length<=admitted&&length<=DOCUMENT_LIMITS.inputBytes,413,'Document changed or exceeds 20 MB. Try reading it again.');
    const bytes=buffer.subarray(0,length);
    const result=await runWorker({operation:'inspect',format:info.format,name:path.basename(relative),data:bytes.toString('base64'),maxChars},{signal});
    return {path:relative,name:path.basename(relative),...info,size:bytes.length,...result};
    }finally{await handle?.close();}
  },signal);
}

export async function createDocument(store,botId,{path:relative,document},{signal}={}){
  const info=documentFormat(relative),spec=validateDocumentSpec(document);
  if(signal?.aborted)throw abortError();
  const root=await getWorkspaceRoot(store,botId);
  // Validate the path before doing expensive work, without creating directories yet.
  ensure(typeof relative==='string'&&relative.length<=240&&!/[\\\x00-\x1f\x7f]/.test(relative)&&!path.isAbsolute(relative)&&!/^[a-z]:/i.test(relative)&&relative.split('/').every(p=>p&&p!=='.'&&p!=='..'),400,'Use a safe relative document path.');
  let candidate=root;const parts=relative.split('/');
  for(let i=0;i<parts.length;i++){
    candidate=path.join(candidate,parts[i]);let stat;
    try{stat=await fs.lstat(candidate);}catch(error){if(error.code==='ENOENT')break;throw error;}
    ensure(!stat.isSymbolicLink(),400,'Symbolic links are not allowed in document paths.');
    if(i===parts.length-1)ensure(stat.isFile()&&stat.nlink===1,422,'Choose an ordinary document file, without hard links, to replace.');
    else ensure(stat.isDirectory(),422,'A document parent path must be a directory.');
  }
  const result=await admit(()=>runWorker({operation:'create',format:info.format,document:spec},{signal}),signal);
  const bytes=Buffer.from(result.data,'base64');ensure(bytes.length<=DOCUMENT_LIMITS.outputBytes,413,'Document output exceeds 20 MB.');
  if(signal?.aborted)throw abortError();
  const file=await safePath(root,relative,{createParents:true,allowMissing:true}),temp=path.join(path.dirname(file),`.document-${randomBytes(12).toString('hex')}.tmp`);
  try{
    await fs.writeFile(temp,bytes,{mode:0o600,flag:'wx'});
    if(signal?.aborted)throw abortError();
    await safePath(root,relative,{allowMissing:true});
    try{const stat=await fs.lstat(file);ensure(stat.isFile()&&stat.nlink===1,422,'Choose an ordinary document file, without hard links, to replace.');}catch(error){if(error.code!=='ENOENT')throw error;}
    await fs.rename(temp,file);
  }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
  // Once committed, return the artifact even if cancellation arrives immediately afterward.
  const query=`path=${encodeURIComponent(relative)}`,base=`/api/bots/${encodeURIComponent(botId)}`;
  return {path:relative,size:bytes.length,written:true,...(result.warnings?.length?{warnings:result.warnings}:{}),artifact:{path:relative,name:path.basename(relative),format:info.format,mime:info.mime,size:bytes.length,downloadUrl:`${base}/files/download?${query}`,previewUrl:`${base}/documents/preview?${query}`}};
}
