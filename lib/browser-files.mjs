import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ensure, HttpError } from './store.mjs';
import { getWorkspaceRoot, safePath, readWorkspaceBytes, groupsFor } from './agent-tools.mjs';

const MAX_BYTES=20_000_000;
const ref={type:'string',maxLength:12},revision={type:'integer',minimum:1},file={type:'string',maxLength:240};
const schema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const browserFileDefinitions=[
  {name:'browser_upload',description:'Upload one workspace file to a visible file input after exact approval. Supply its SHA-256; changed bytes are refused. At most 20 MB; the site may receive it immediately.',parameters:schema({ref,revision,path:file,sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}})},
  {name:'browser_download',description:'Click an exact visible direct download link after approval and save the bytes as a new workspace file (20 MB, 45 s). A timeout is an unknown outcome; never replay it.',parameters:schema({ref,revision,path:file})},
];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const abort=signal=>{if(signal?.aborted)throw signal.reason || new HttpError(499,'Task cancelled.');};

export async function validateBrowserFileAction({store,bot,signal},name,args) {
  abort(signal);ensure(groupsFor(bot).includes('workspace'),403,'Browser file transfers require Workspace tools.');
  ensure(typeof args.path==='string' && args.path.length<=240,400,'Use a private relative file path.');
  if(name==='browser_upload') {
    ensure(typeof args.sha256==='string' && /^[a-f0-9]{64}$/.test(args.sha256),400,'Supply the exact file SHA-256 from a workspace read.');
    const bytes=await readWorkspaceBytes(store,bot.id,args.path,{maxBytes:MAX_BYTES});
    ensure(digest(bytes)===args.sha256,409,'The upload file changed. Read it again before requesting approval.');
    return {path:args.path,sha256:args.sha256,bytes:bytes.length};
  }
  const root=await getWorkspaceRoot(store,bot.id);
  // Parent creation is postponed until execution; validate every existing component now.
  const parts=args.path.split('/');
  ensure(parts.every(part=>part && part!=='.' && part!=='..') && !/[\\\x00-\x1f\x7f]/.test(args.path) && !path.isAbsolute(args.path) && !/^[a-zA-Z]:/.test(args.path),400,'Use a private relative file path.');
  let existing=root;
  for(const part of parts) {
    existing=path.join(existing,part);
    const stat=await fs.lstat(existing).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(stat)ensure(!stat.isSymbolicLink() && (existing===path.join(root,args.path)?false:stat.isDirectory()),409,'Choose a new download path with real directory parents.');
  }
  return {path:args.path,maxBytes:MAX_BYTES};
}

/** Executes only after the caller verifies the exact approved page/control identity. */
export async function executeBrowserFileTool(session,context,name,args) {
  const {store,bot,signal}=context;
  await validateBrowserFileAction(context,name,args);abort(signal);
  if(name==='browser_upload') {
    const bytes=await readWorkspaceBytes(store,bot.id,args.path,{maxBytes:MAX_BYTES});
    ensure(digest(bytes)===args.sha256,409,'The upload file changed after approval.');
    const staging=await fs.mkdtemp(path.join(session.scratch,'upload-'));
    const staged=path.join(staging,path.basename(args.path));
    try {
      await fs.writeFile(staged,bytes,{flag:'wx',mode:0o600});
      const backendNodeId=await session.fileInput(args.ref,args.revision);abort(signal);
      session.dispatchCount++;
      await session.pipe.send('DOM.setFileInputFiles',{backendNodeId,files:[staged]},session.fileInputSession || session.session);
      // Keep the bytes for the session: browsers can defer reading a selected file until submission.
      return {uploaded:true,path:args.path,bytes:bytes.length,sha256:args.sha256,notice:'The selected bytes were supplied to this file input. Verify the site’s upload/submission result before claiming delivery.'};
    } catch(error){await fs.rm(staging,{recursive:true,force:true});throw error;}
  }
  const targetInfo=await session.target(args.ref,args.revision);
  ensure(typeof targetInfo.href==='string' && /^(?:https?:|blob:https?:)/.test(targetInfo.href),400,'Choose a direct download link with an observed web or blob URL.');
  const normalize=value=>{try{const url=new URL(value);url.hash='';return url.href;}catch{return '';}};
  const expectedUrl=normalize(targetInfo.href),allowedUrls=new Set([expectedUrl]),requests=new Set();
  const staging=await fs.mkdtemp(path.join(session.scratch,'download-'));
  let guid=null,settled=false,timer,resolve,reject;
  const complete=new Promise((yes,no)=>{resolve=yes;reject=no;});void complete.catch(()=>{});
  const fail=error=>{if(settled)return;settled=true;reject(error);};
  const cancel=()=>{if(guid)void session.pipe.send('Browser.cancelDownload',{guid}).catch(()=>{});};
  const onAbort=()=>{cancel();fail(signal.reason || new HttpError(499,'Task cancelled.'));};
  const expectedFrame=session.frameId || session.mainFrame;
  const expectedSession=await session.frameSession(expectedFrame);
  const handler=message=>{
    if(message.method==='Network.requestWillBeSent' && message.sessionId===expectedSession && message.params.frameId===expectedFrame) {
      const url=normalize(message.params.request.url);
      if(url===expectedUrl || requests.has(message.params.requestId)){requests.add(message.params.requestId);allowedUrls.add(url);}
    } else if(message.method==='Browser.downloadWillBegin') {
      if(message.params.frameId!==expectedFrame || !allowedUrls.has(normalize(message.params.url))){void session.pipe.send('Browser.cancelDownload',{guid:message.params.guid}).catch(()=>{});fail(new HttpError(409,'An unrelated download started. The approved link’s download was not verified.'));return;}
      if(guid){void session.pipe.send('Browser.cancelDownload',{guid:message.params.guid}).catch(()=>{});return;}
      guid=message.params.guid;
    } else if(message.method==='Browser.downloadProgress' && message.params.guid===guid) {
      const {receivedBytes,totalBytes,state}=message.params;
      if(receivedBytes>MAX_BYTES || totalBytes>MAX_BYTES){cancel();fail(new HttpError(413,'The download exceeds 20 MB.'));}
      else if(state==='canceled')fail(new HttpError(502,'The browser cancelled the download.'));
      else if(state==='completed' && !settled){settled=true;resolve();}
    }
  };
  session.pipe.handlers.add(handler);signal?.addEventListener('abort',onAbort,{once:true});
  try {
    await session.pipe.send('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:staging,eventsEnabled:true});abort(signal);
    timer=setTimeout(()=>{cancel();fail(new HttpError(504,'No complete download was verified within 45 seconds. Inspect the site before retrying.'));},45_000);
    await session.click(args.ref,args.revision);await complete;abort(signal);
    ensure(typeof guid==='string' && /^[a-zA-Z0-9-]{1,100}$/.test(guid),502,'The browser returned an invalid download identity.');
    const handle=await fs.open(path.join(staging,guid),constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let bytes;
    try {const stat=await handle.stat();ensure(stat.isFile() && stat.size<=MAX_BYTES,413,'The download is not a bounded regular file.');const buffer=Buffer.alloc(MAX_BYTES+1);let size=0;while(size<buffer.length){const result=await handle.read(buffer,size,buffer.length-size,size);if(!result.bytesRead)break;size+=result.bytesRead;}ensure(size<=MAX_BYTES,413,'The download exceeds 20 MB.');bytes=buffer.subarray(0,size);} finally {await handle.close();}
    const root=await getWorkspaceRoot(store,bot.id),target=await safePath(root,args.path,{createParents:true,allowMissing:true}),temp=`${target}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp,bytes,{flag:'wx',mode:0o600});abort(signal);
      await safePath(root,args.path,{allowMissing:true});
      // link publishes atomically and refuses replacement if another writer created this path.
      await fs.link(temp,target).catch(error=>{if(error.code==='EEXIST')throw new HttpError(409,'The destination now exists. The download did not replace it.');throw error;});
    } finally {await fs.rm(temp,{force:true});}
    return {downloaded:true,path:args.path,bytes:bytes.length,sha256:digest(bytes),notice:'Actual downloaded bytes were saved. The file has not been executed; read it with the appropriate file/document tools.'};
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',onAbort);session.pipe.handlers.delete(handler);
    if(!settled)cancel();
    await session.pipe.send('Browser.setDownloadBehavior',{behavior:'deny',eventsEnabled:false}).catch(()=>{});
    await fs.rm(staging,{recursive:true,force:true}).catch(()=>{});
  }
}
