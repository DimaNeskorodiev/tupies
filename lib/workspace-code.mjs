import { promises as fs, constants as FS } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ensure, HttpError } from './store.mjs';

const MAX_FILE_BYTES=1_000_000, MAX_SCAN_BYTES=8_000_000, MAX_ENTRIES=4000, MAX_DEPTH=20, MAX_PAGE_CHARS=12000;
const editQueues=new Map();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const cancelled=signal=>{if(signal?.aborted)throw signal.reason || new Error('Tool cancelled.');};
const integer=(value,fallback,min,max,label)=>{const result=value===undefined?fallback:value;ensure(Number.isInteger(result) && result>=min && result<=max,400,`${label} must be a whole number from ${min} to ${max}.`);return result;};
const boolean=(value,fallback,label)=>{ensure(value===undefined || typeof value==='boolean',400,`${label} must be a boolean.`);return value ?? fallback;};

function globPattern(value='**/*') {
  ensure(typeof value==='string' && value.length>0 && value.length<=240 && !/[\\\x00-\x1f\x7f\[\]{}]/.test(value),400,'Use a relative glob of at most 240 characters with only *, ** and ? wildcards.');
  const parts=value.split('/');
  ensure(!/^[a-zA-Z]:/.test(value) && parts.every(part=>part && part!=='.' && part!=='..') && parts.length<=MAX_DEPTH,400,'Glob paths cannot leave the workspace or exceed 20 components.');
  ensure(parts.every(part=>!part.includes('**') || part==='**'),400,'The ** wildcard must occupy a complete path component.');
  return parts;
}

// Bounded dynamic programming avoids model-supplied regular expressions and backtracking.
function componentMatches(pattern,value) {
  let row=Array(value.length+1).fill(false);row[0]=true;
  for(const char of pattern) {
    const next=Array(value.length+1).fill(false);next[0]=char==='*' && row[0];
    for(let index=1;index<=value.length;index++)next[index]=char==='*' ? row[index] || next[index-1] : row[index-1] && (char==='?' || char===value[index-1]);
    row=next;
  }
  return row[value.length];
}

function globMatches(pattern,relative) {
  const parts=relative.split('/');let row=Array(parts.length+1).fill(false);row[0]=true;
  for(const part of pattern) {
    const next=Array(parts.length+1).fill(false);next[0]=part==='**' && row[0];
    for(let index=1;index<=parts.length;index++)next[index]=part==='**' ? row[index] || next[index-1] : row[index-1] && componentMatches(part,parts[index-1]);
    row=next;
  }
  return row[parts.length];
}

async function inventory({root,resolve,signal},relative='.',includeHidden=false) {
  const base=await resolve(root,relative,{allowRoot:true});
  ensure((await fs.lstat(base)).isDirectory(),400,'Choose a folder to search.');
  const files=[],state={entries:0,skipped:0,truncated:false};
  async function walk(folder,depth) {
    cancelled(signal);
    // Revalidate every directory before opening it; never follow discovered symlinks.
    await resolve(root,path.relative(root,folder).split(path.sep).join('/') || '.',{allowRoot:true});
    const entries=[],handle=await fs.opendir(folder);
    try {
      for await(const entry of handle) {
        if(++state.entries>MAX_ENTRIES){state.truncated=true;break;}
        entries.push(entry);
      }
    } finally {await handle.close().catch(()=>{});}
    entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    for(const entry of entries) {
      cancelled(signal);
      const absolute=path.join(folder,entry.name),relativePath=path.relative(root,absolute).split(path.sep).join('/');
      if(relativePath.length>240 || entry.name==='node_modules' || entry.name==='.git' || entry.name==='.tmp' || (!includeHidden && entry.name.startsWith('.'))){state.skipped++;continue;}
      if(entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())){state.skipped++;continue;}
      if(entry.isDirectory()) {
        if(depth>=MAX_DEPTH){state.truncated=true;continue;}
        if(state.entries<MAX_ENTRIES)await walk(absolute,depth+1);else state.truncated=true;
      } else files.push(relativePath);
    }
  }
  await walk(base,0);files.sort();return {files,...state};
}

export async function readText(context,relative,{admitBytes}={}) {
  const {root,resolve,signal}=context;cancelled(signal);
  const file=await resolve(root,relative),before=await fs.lstat(file);
  ensure(before.isFile() && before.size<=MAX_FILE_BYTES,413,'Choose a regular text file up to 1 MB.');
  const handle=await fs.open(file,FS.O_RDONLY | (FS.O_NOFOLLOW || 0) | (FS.O_NONBLOCK || 0));
  try {
    const stat=await handle.stat();ensure(stat.isFile() && stat.size<=MAX_FILE_BYTES,413,'Choose a regular text file up to 1 MB.');
    if(admitBytes && !admitBytes(stat.size))return null;
    const bytes=Buffer.alloc(stat.size+1);let offset=0;
    while(offset<bytes.length){cancelled(signal);const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}
    const after=await handle.stat();
    ensure(offset===stat.size && stat.size===after.size && stat.mtimeMs===after.mtimeMs,409,'The file changed while reading. Read it again.');
    const data=bytes.subarray(0,offset);let content;
    try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);}catch{throw new HttpError(400,'This file is binary; choose a UTF-8 text file.');}
    ensure(!content.includes('\0'),400,'This file is binary; choose a UTF-8 text file.');
    return {file,path:relative,content,size:data.length,sha256:digest(data),stat};
  } finally {await handle.close();}
}

export async function workspaceGlob(context,args) {
  const pattern=globPattern(args.pattern),offset=integer(args.offset,0,0,MAX_ENTRIES,'Result offset'),limit=integer(args.limit,50,1,100,'Result limit');
  const found=await inventory(context,args.path ?? '.',boolean(args.includeHidden,false,'Include hidden files'));
  const matching=found.files.filter(file=>globMatches(pattern,file)),files=[];let chars=0;
  for(const file of matching.slice(offset,offset+limit)){if(chars+file.length>10000)break;files.push(file);chars+=file.length;}
  const more=offset+files.length<matching.length;
  return {files,offset,nextOffset:more?offset+files.length:null,truncated:more || found.truncated,scanTruncated:found.truncated,scannedEntries:found.entries,skippedEntries:found.skipped,limits:{entries:MAX_ENTRIES,depth:MAX_DEPTH}};
}

export async function workspaceReadPage(context,args) {
  const offset=integer(args.offset,1,1,MAX_FILE_BYTES+1,'Line offset'),limit=integer(args.limit,200,1,1000,'Line limit'),column=integer(args.column,1,1,MAX_FILE_BYTES+1,'Column');
  const read=await readText(context,args.path),lines=read.content.split('\n');
  ensure(offset<=lines.length+1,400,'Line offset exceeds the file length.');
  ensure(column===1 || (offset<=lines.length && column<=lines[offset-1].length+1),400,'Column exceeds the selected line length.');
  const selected=lines.slice(offset-1,offset-1+limit);if(selected.length)selected[0]=selected[0].slice(column-1);
  const text=selected.join('\n'),content=text.slice(0,MAX_PAGE_CHARS);let nextOffset=null,nextColumn=null;
  if(content.length<text.length) {
    const pieces=content.split('\n');nextOffset=offset+pieces.length-1;nextColumn=pieces.length===1?column+content.length:pieces.at(-1).length+1;
  } else if(offset-1+selected.length<lines.length){nextOffset=offset+selected.length;nextColumn=1;}
  return {path:args.path,content,size:read.size,sha256:read.sha256,offset,column,totalLines:lines.length,nextOffset,nextColumn,truncated:nextOffset!==null};
}

export async function workspaceSearch(context,args) {
  ensure(typeof args.query==='string' && args.query.length>0 && args.query.length<=500 && !/[\r\n\0]/.test(args.query),400,'Search for a literal single-line phrase of 1–500 characters.');
  const pattern=globPattern(args.glob),offset=integer(args.offset,0,0,MAX_SCAN_BYTES,'Result offset'),limit=integer(args.limit,20,1,50,'Result limit');
  const caseSensitive=boolean(args.caseSensitive,true,'Case sensitive search'),contextLines=integer(args.contextLines,0,0,2,'Context lines');
  const found=await inventory(context,args.path ?? '.',boolean(args.includeHidden,false,'Include hidden files'));
  // Escaped literal matching preserves original Unicode column coordinates when folding case.
  const folded=caseSensitive?null:new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'iu');
  const matches=[];let scannedBytes=0,searchedFiles=0,skippedFiles=0,seen=0,chars=0,more=false,scanTruncated=found.truncated;
  outer: for(const relative of found.files) {
    cancelled(context.signal);if(!globMatches(pattern,relative))continue;
    let read,budgetExceeded=false;
    try{read=await readText(context,relative,{admitBytes:size=>{if(scannedBytes+size>MAX_SCAN_BYTES){budgetExceeded=true;return false;}scannedBytes+=size;return true;}});}catch(error){cancelled(context.signal);if(error instanceof HttpError || ['ENOENT','ELOOP','EACCES','EPERM'].includes(error.code)){skippedFiles++;continue;}throw error;}
    if(budgetExceeded){scanTruncated=true;break;}
    searchedFiles++;const lines=read.content.split('\n');
    for(let index=0;index<lines.length;index++) {
      const source=lines[index],position=caseSensitive?source.indexOf(args.query):(folded.exec(source)?.index ?? -1);if(position<0)continue;
      if(seen++<offset)continue;
      if(matches.length>=limit){more=true;break outer;}
      // Center long-line excerpts on the match so minified files still provide useful evidence.
      const start=Math.max(0,position-80),snippet=source.slice(start,start+500);
      const match={path:relative,line:index+1,column:position+1,text:snippet,textColumn:start+1,lineTruncated:start>0 || start+snippet.length<source.length};
      if(contextLines)match.context=lines.slice(Math.max(0,index-contextLines),index+contextLines+1).map((text,at)=>({line:Math.max(0,index-contextLines)+at+1,text:text.slice(0,250),truncated:text.length>250}));
      const size=JSON.stringify(match).length;
      if(chars+size>10000){more=true;break outer;}matches.push(match);chars+=size;
    }
  }
  return {matches,offset,nextOffset:more?offset+matches.length:null,truncated:more || scanTruncated,scanTruncated,searchedFiles,scannedBytes,skippedFiles,skippedEntries:found.skipped,limits:{entries:MAX_ENTRIES,fileBytes:MAX_FILE_BYTES,totalBytes:MAX_SCAN_BYTES}};
}

export async function workspaceEdit(context,args) {
  ensure(typeof args.expectedSha256==='string' && /^[a-f0-9]{64}$/.test(args.expectedSha256),400,'Supply the expectedSha256 returned by workspace_read.');
  ensure(typeof args.oldText==='string' && args.oldText.length>0 && args.oldText.length<=100000,400,'Old text must contain 1–100000 exact characters.');
  ensure(typeof args.newText==='string' && args.newText.length<=100000 && !args.newText.includes('\0'),400,'New text must contain at most 100000 characters without binary NUL bytes.');
  const replaceAll=boolean(args.replaceAll,false,'Replace all'),key=await context.resolve(context.root,args.path),previous=editQueues.get(key) || Promise.resolve();
  const job=previous.catch(()=>{}).then(async()=>{
    cancelled(context.signal);const read=await readText(context,args.path);
    ensure(read.sha256===args.expectedSha256,409,'The file changed since it was read. Read it again before editing.');
    let count=0,at=0;
    while((at=read.content.indexOf(args.oldText,at))!==-1){count++;at+=args.oldText.length;}
    ensure(count>0,409,'The exact old text was not found. Read the file again.');
    ensure(replaceAll || count===1,409,'The old text occurs more than once. Include more context or explicitly set replaceAll.');
    const content=read.content.split(args.oldText).join(args.newText);
    ensure(Buffer.byteLength(content)<=MAX_FILE_BYTES,413,'Edited text files must stay within 1 MB.');
    const temporary=path.join(path.dirname(read.file),`.studio-${randomBytes(10).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temporary,content,{mode:0o600,flag:'wx'});
      // Recheck after preparing the atomic replacement, including external changes during IO.
      const current=await readText(context,args.path);
      ensure(current.sha256===read.sha256 && current.stat.ino===read.stat.ino && current.stat.dev===read.stat.dev,409,'The file changed while editing. Read it again.');
      cancelled(context.signal);await context.resolve(context.root,args.path);await fs.rename(temporary,read.file);
      return {path:args.path,written:true,replacements:count,size:Buffer.byteLength(content),sha256:digest(Buffer.from(content))};
    } finally {await fs.rm(temporary,{force:true}).catch(()=>{});}
  });
  editQueues.set(key,job);
  try{return await job;}finally{if(editQueues.get(key)===job)editQueues.delete(key);}
}
