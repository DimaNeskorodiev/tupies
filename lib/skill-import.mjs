import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import https from 'node:https';
import { ensure, HttpError, parseSkillPackage } from './store.mjs';
import { assertPublicUrl, resolvePublicAddress } from './net-policy.mjs';

export const SKILL_IMPORT_LIMITS=Object.freeze({archiveBytes:10_000_000,archiveFiles:2000,expandedBytes:20_000_000,packageBytes:5_000_000,packageFiles:100});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const aborted=signal=>{if(signal?.aborted)throw signal.reason || new Error('Skill import cancelled.');};
const fatalUtf8=bytes=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new HttpError(400,'Skill text and archive paths must contain valid UTF-8.');}};
const sensitive=part=>/^\.env(?:\.|$)/i.test(part)||/^\.git$/i.test(part)||/^node_modules$/i.test(part)||/^\.venv$/i.test(part)||/private.*key/i.test(part)||/^(?:vault\.key|state\.json|auth\.json|credentials\.json|id_(?:rsa|ed25519|ecdsa))$/i.test(part)||/\.(?:pem|p12|pfx|key)$/i.test(part);
function safeRelative(value,{directory=false}={}) {
  ensure(typeof value==='string' && value.length>0 && value.length<=1024 && !/[\\\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') && !/^[a-z]:/i.test(value),400,'Skill archive paths must be safe relative paths.');
  const result=directory?value.replace(/\/$/,''):value,parts=result.split('/');
  ensure(parts.every(part=>part && part!=='.' && part!=='..'),400,'Skill archive paths must be safe relative paths.');
  ensure(!parts.some(sensitive),400,'Skill imports cannot include credentials, private keys, dependency trees or Git metadata.');
  return result;
}
function packageFromFiles(files) {
  for(const file of files)safeRelative(file.path);
  return parsePortableSkillPackage({files:files.map(({path,data})=>({path,contentBase64:data.toString('base64')}))});
}

/** Grok exports may have human-readable names. Keep their bytes/name; storage uses a separate engine identity. */
export function parsePortableSkillPackage(input) {
  try{return parseSkillPackage(input);}catch(error){
    if(error.status!==400 || !error.message.startsWith('Skill name must'))throw error;
    // parseSkillPackage already validated paths, byte counts, base64 and UTF-8 before reaching the name check.
    const content=Object.hasOwn(input,'files')?fatalUtf8(Buffer.from(input.files.find(file=>file.path==='SKILL.md').contentBase64,'base64')):input.content;
    const front=content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/),names=front[1].split(/\r?\n/).filter(line=>/^name:/.test(line));
    ensure(names.length===1,400,'A portable skill needs one name.');let name=names[0].slice(5).trim();
    if(name.startsWith('"')){try{name=JSON.parse(name);}catch{throw error;}}
    else if(name.startsWith("'") && name.endsWith("'"))name=name.slice(1,-1).replace(/''/g,"'");
    else name=name.replace(/\s+#.*$/,'').trim();
    ensure(typeof name==='string' && name.length>0 && name.length<=80 && !/[\x00-\x1f\x7f]/.test(name) && !/^[&*!>|]/.test(name),400,'Portable skill names must contain 1–80 printable characters.');
    const slug=name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64).replace(/-+$/,'') || 'imported-skill';
    const validatedContent=content.replace(/^name:[^\r\n]*/m,`name: ${slug}`),validatedInput=Object.hasOwn(input,'files')?{files:input.files.map(file=>file.path==='SKILL.md'?{...file,contentBase64:Buffer.from(validatedContent).toString('base64')}:file)}:{content:validatedContent};
    const parsed=parseSkillPackage(validatedInput);parsed.content=content;parsed.files.find(file=>file.path==='SKILL.md').data=Buffer.from(content);parsed.skill.name=name;parsed.skill.size=parsed.files.reduce((sum,file)=>sum+file.data.length,0);
    parsed.skill.formatWarnings=['The original skill name is preserved; Tupies assigns a separate internal package identity.'];return parsed;
  }
}

/** A conservative metadata reader, not a general YAML evaluator. Original source bytes are never rewritten. */
export function parseSkillMetadata(content) {
  const result={platforms:[],requiresTools:[],requiresToolsets:[],requiresBins:[],requiresEnv:[],requiresConfig:[],compatibility:'',license:'',unsupportedFeatures:[],diagnostics:[]};
  const front=typeof content==='string' && content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if(!front){result.diagnostics.push('The skill has no readable YAML frontmatter.');return result;}
  if(front[1].length>50_000){result.diagnostics.push('Extended metadata exceeds the inspection limit.');return result;}
  const fields=new Map(),stack=[],lines=front[1].split(/\r?\n/),relevant=/platform|requires|environment|compatibility|install|credential|config|allowed.tools/i;
  const put=(key,value)=>{const existing=fields.get(key);fields.set(key,existing===undefined?value:[...(Array.isArray(existing)?existing:[existing]),...(Array.isArray(value)?value:[value])]);};
  const scalar=value=>{
    value=value.trim().replace(/\s+#.*$/,'');
    if(!value)return '';
    if(/^[&*!]|(?:^|\s)[&*][A-Za-z0-9_-]+/.test(value)){result.unsupportedFeatures.push('yaml-aliases-or-tags');return '';}
    if(value.startsWith('"')){try{return JSON.parse(value);}catch{return undefined;}}
    if(value.startsWith("'") && value.endsWith("'"))return value.slice(1,-1).replace(/''/g,"'");
    if(value.startsWith('{')){try{return JSON.parse(value);}catch{return undefined;}}
    if(value.startsWith('[')){
      try{return JSON.parse(value);}catch{}
      if(!value.endsWith(']')||/[\[\]{}]/.test(value.slice(1,-1)))return undefined;
      return value.slice(1,-1).split(',').map(item=>scalar(item)).filter(item=>typeof item==='string' && item);
    }
    return value;
  };
  const flatten=(key,value,depth=0)=>{
    if(depth>8){result.diagnostics.push('Nested metadata exceeds the inspection limit.');return;}
    if(value && typeof value==='object' && !Array.isArray(value)){for(const [name,item]of Object.entries(value)){if(/^[A-Za-z0-9_-]+$/.test(name))flatten(`${key}.${name}`,item,depth+1);}return;}
    put(key,value);
  };
  for(let index=0;index<Math.min(lines.length,1000);index++){
    const line=lines[index];if(!line.trim() || /^\s*#/.test(line))continue;
    if(line.includes('\t')){result.diagnostics.push('Tab-indented metadata needs manual review.');continue;}
    const indent=line.length-line.trimStart().length,entry=line.trim().match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if(entry){
      while(stack.length && stack.at(-1).indent>=indent)stack.pop();
      const key=[...stack.map(item=>item.key),entry[1]].join('.'),value=entry[2] || '';
      if(['install','hooks'].includes(entry[1].toLowerCase()))result.unsupportedFeatures.push('automatic-setup');
      if(!value || /^[>|][+-]?$/.test(value)){
        if(value){const block=[];for(;index+1<lines.length && (!lines[index+1].trim() || lines[index+1].length-lines[index+1].trimStart().length>indent);index++)block.push(lines[index+1].trim());put(key,block.join(value[0]==='>'?' ':'\n').trim());}
        else stack.push({indent,key:entry[1]});
        continue;
      }
      const parsed=scalar(value);
      if(parsed===undefined){if(relevant.test(key))result.diagnostics.push(`The ${key} metadata needs manual review.`);}else flatten(key,parsed);
      continue;
    }
    const list=line.trim().match(/^-\s+(.*)$/);
    if(list && stack.length){
      while(stack.length>1 && stack.at(-1).indent>indent)stack.pop();
      const key=stack.map(item=>item.key).join('.'),parsed=scalar(list[1]);
      if(parsed===undefined || /:\s/.test(list[1]) || (typeof parsed!=='string' && !Array.isArray(parsed))){if(relevant.test(key))result.diagnostics.push(`The ${key} metadata needs manual review.`);}else put(key,parsed);
    }else if(relevant.test(stack.map(item=>item.key).join('.')))result.diagnostics.push('Some extended metadata could not be inspected.');
  }
  if(lines.length>1000)result.diagnostics.push('Extended metadata exceeds the line inspection limit.');
  const names=value=>{
    const entries=Array.isArray(value)?value:[value];
    if(entries.some(item=>typeof item!=='string'))result.diagnostics.push('A requirement has an unsupported metadata value and needs manual review.');
    const values=entries.flatMap(item=>typeof item==='string'?item.split(/[,\s]+/):[]).filter(Boolean);
    if(values.length>50 || values.some(item=>item.length>120))result.diagnostics.push('Some requirements exceed the metadata inspection limit.');
    return values.map(item=>item.slice(0,120));
  };
  for(const [path,value]of fields){
    const key=path.toLowerCase().replaceAll('-','_'),last=key.split('.').at(-1);
    if(key==='compatibility' && typeof value==='string')result.compatibility=value.slice(0,500);
    else if(key==='license' && typeof value==='string')result.license=value.slice(0,200);
    else if(['platforms','platform','os'].includes(last))result.platforms.push(...names(value));
    else if(['requires_tools','requirestools'].includes(last))result.requiresTools.push(...names(value));
    else if(['requires_toolsets','requirestoolsets'].includes(last))result.requiresToolsets.push(...names(value));
    else if(['requires_bins','requiresbins'].includes(last) || last==='bins' && /requires/.test(key))result.requiresBins.push(...names(value));
    else if(['required_environment_variables','requires_env','requiresenv'].includes(last) || last==='env' && /requires/.test(key))result.requiresEnv.push(...names(value));
    else if(['required_config','requires_config','config_fields','credential_files'].includes(last))result.requiresConfig.push(...names(value));
    else if(/(?:^|\.)(?:install|hooks)(?:\.|$)/.test(key))result.unsupportedFeatures.push('automatic-setup');
  }
  if(/!`[^`]+`/.test(content))result.unsupportedFeatures.push('inline-shell-expansion');
  if(/\$\{HERMES_HOME\}|\bhermes\s+setup\b|\b(?:from|import)\s+hermes(?:[._\s]|$)/m.test(content))result.unsupportedFeatures.push('hermes-runtime');
  for(const key of ['platforms','requiresTools','requiresToolsets','requiresBins','requiresEnv','requiresConfig','unsupportedFeatures','diagnostics'])result[key]=[...new Set(result[key])].slice(0,50);
  return result;
}

/** Validates all ZIP headers and expanded bounds before exposing any package. Nothing is written or executed. */
function archiveFiles(bytes) {
  const b=Buffer.from(bytes);ensure(b.length>=22 && b.length<=SKILL_IMPORT_LIMITS.archiveBytes,413,'Skill ZIP must be at most 10 MB.');
  let end=-1;for(let n=b.length-22;n>=Math.max(0,b.length-65557);n--)if(b.readUInt32LE(n)===0x06054b50 && n+22+b.readUInt16LE(n+20)===b.length){end=n;break;}
  ensure(end>=0,400,'Skill ZIP directory is missing or invalid.');
  ensure(!b.readUInt16LE(end+4) && !b.readUInt16LE(end+6) && b.readUInt16LE(end+8)===b.readUInt16LE(end+10),400,'Multipart skill ZIP files are unsupported.');
  const count=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),offset=b.readUInt32LE(end+16);
  ensure(count>0 && count<=SKILL_IMPORT_LIMITS.archiveFiles && count!==65535 && offset!==0xffffffff && offset+size===end,400,'Skill ZIP directory exceeds its safe limits.');
  let cursor=offset,total=0;const entries=[],names=new Set(),spans=[];
  for(let i=0;i<count;i++){
    ensure(cursor+46<=end && b.readUInt32LE(cursor)===0x02014b50,400,'Skill ZIP directory entry is invalid.');
    const flags=b.readUInt16LE(cursor+8),method=b.readUInt16LE(cursor+10),crc=b.readUInt32LE(cursor+16),compressed=b.readUInt32LE(cursor+20),expanded=b.readUInt32LE(cursor+24),length=b.readUInt16LE(cursor+28),extra=b.readUInt16LE(cursor+30),comment=b.readUInt16LE(cursor+32),external=b.readUInt32LE(cursor+38),local=b.readUInt32LE(cursor+42);
    ensure(cursor+46+length+extra+comment<=end,400,'Skill ZIP directory entry is truncated.');
    const name=fatalUtf8(b.subarray(cursor+46,cursor+46+length)),directory=name.endsWith('/'),relative=safeRelative(name,{directory});
    ensure(!names.has(relative.toLowerCase()),400,'Skill ZIP has duplicate or case-conflicting paths.');names.add(relative.toLowerCase());
    const kind=(external>>>16)&0xf000;
    ensure(!kind || kind===(directory?0x4000:0x8000),400,'Skill ZIP symlinks and special files are prohibited.');
    ensure(!/\.(?:zip|tar|tgz|gz|7z|rar)$/i.test(relative),400,'Nested archives are not supported in skill imports.');
    total+=expanded;
    ensure(!(flags&~(0x800|8|6)) && [0,8].includes(method) && expanded<=SKILL_IMPORT_LIMITS.packageBytes && total<=SKILL_IMPORT_LIMITS.expandedBytes && expanded<=Math.max(1,compressed)*250,413,'Skill ZIP compression exceeds its safe limits.');
    ensure(!directory || !expanded && !compressed,400,'Skill ZIP directory entries must be empty.');
    ensure(local+30<=offset && b.readUInt32LE(local)===0x04034b50,400,'Skill ZIP local header is invalid.');
    const localFlags=b.readUInt16LE(local+6),localMethod=b.readUInt16LE(local+8),localName=b.readUInt16LE(local+26),localExtra=b.readUInt16LE(local+28),start=local+30+localName+localExtra;
    ensure(localFlags===flags && localMethod===method && start+compressed<=offset && fatalUtf8(b.subarray(local+30,local+30+localName))===name,400,'Skill ZIP local and central headers disagree.');
    ensure((flags&8) || b.readUInt32LE(local+14)===crc && b.readUInt32LE(local+18)===compressed && b.readUInt32LE(local+22)===expanded,400,'Skill ZIP entry sizes or checksums disagree.');
    spans.push([local,start+compressed]);entries.push({name:relative,directory,method,expanded,start,compressed,crc});cursor+=46+length+extra+comment;
  }
  ensure(cursor===end,400,'Skill ZIP directory size is invalid.');
  spans.sort((a,b)=>a[0]-b[0]);for(let i=1;i<spans.length;i++)ensure(spans[i][0]>=spans[i-1][1],400,'Skill ZIP entries must not overlap.');
  for(const entry of entries){const parts=entry.name.split('/');parts.pop();while(parts.length){const parent=parts.join('/').toLowerCase();ensure(!entries.some(item=>!item.directory && item.name.toLowerCase()===parent),400,'A skill ZIP file conflicts with a directory.');parts.pop();}}
  const files=new Map();
  for(const entry of entries){
    if(entry.directory)continue;
    const packed=b.subarray(entry.start,entry.start+entry.compressed);let data;
    try{data=entry.method===0?Buffer.from(packed):inflateRawSync(packed,{maxOutputLength:Math.max(1,entry.expanded)});}catch{throw new HttpError(400,'A skill ZIP entry failed bounded decompression.');}
    ensure(data.length===entry.expanded && crc32(data)===entry.crc,400,'A skill ZIP entry has an invalid size or checksum.');files.set(entry.name,data);
  }
  return files;
}
let crcTable;
function crc32(data){crcTable ||= Uint32Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0;});let crc=0xffffffff;for(const byte of data)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}

export function parseSkillArchive(bytes,{skillPath,provenance={kind:'upload',format:'agent-skills-zip'}}={}) {
  const files=archiveFiles(bytes),manifestFiles=[...files.keys()].filter(name=>name==='openbot-import.json'||name.endsWith('/openbot-import.json'));
  let roots=[...files.keys()].filter(name=>name==='SKILL.md'||name.endsWith('/SKILL.md')).map(name=>name.slice(0,-'SKILL.md'.length).replace(/\/$/,''));
  let source=provenance;
  if(manifestFiles.length){
    ensure(manifestFiles.length===1,400,'Select an archive containing one OpenBot export manifest.');
    const manifestPath=manifestFiles[0],manifestBytes=files.get(manifestPath);ensure(manifestBytes.length<=250_000,413,'OpenBot export manifest exceeds the inspection limit.');
    let manifest;try{manifest=JSON.parse(fatalUtf8(manifestBytes));}catch{throw new HttpError(400,'OpenBot export manifest must be valid JSON.');}
    ensure(manifest?.format==='openbot-agent-import' && manifest.version===1 && Array.isArray(manifest.agents) && manifest.agents.length<=100,400,'OpenBot export manifest format is unsupported.');
    const base=manifestPath.slice(0,-'openbot-import.json'.length),listed=[];
    for(const agent of manifest.agents){
      ensure(agent && typeof agent.key==='string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(agent.key) && Array.isArray(agent.skills || []) && (agent.skills || []).length<=32,400,'OpenBot agent skill entries are invalid.');
      for(const folder of agent.skills || []){const relative=safeRelative(folder);ensure(relative.startsWith(`agents/${agent.key}/skills/`) && files.has(`${base}${relative}/SKILL.md`),400,'An exported skill points outside its agent folder or is missing SKILL.md.');listed.push(`${base}${relative}`);}
    }
    roots=[...new Set(listed)];source={...provenance,format:'openbot-agent-import',sourceApp:manifest.source?.app==='grok-bot'?'grok-bot':manifest.source?.app==='hermes-agent'?'hermes-agent':'openbot-export'};
  }
  ensure(roots.length>0 && roots.length<=100,400,'The archive needs at least one skill folder with SKILL.md.');
  if(skillPath!==undefined){ensure(typeof skillPath==='string' && roots.includes(skillPath),400,'Choose a skill path from the archive preview.');roots=[skillPath];}
  const packages=roots.map(root=>{
    const prefix=root?`${root}/`:'',selected=[...files].filter(([name])=>name.startsWith(prefix)).map(([name,data])=>({path:name.slice(prefix.length),data}));
    ensure(!selected.some(file=>file.path!=='SKILL.md' && file.path.endsWith('/SKILL.md')),400,'Nested skill folders must be imported individually.');
    const parsed=packageFromFiles(selected);return {key:root,label:parsed.skill.name,package:parsed,provenance:{...source,archiveSha256:digest(bytes),skillPath:root},metadata:parseSkillMetadata(parsed.content)};
  });
  return {packages,requiresSelection:packages.length>1};
}

function canonicalBase64(value,maxBytes,label) {
  ensure(typeof value==='string' && value.length<=Math.ceil(maxBytes/3)*4 && value.length%4===0 && !/[^A-Za-z0-9+/=]/.test(value),413,`${label} must be canonical base64 within its size limit.`);
  const bytes=Buffer.from(value,'base64');ensure(bytes.length<=maxBytes && bytes.toString('base64')===value,400,`${label} must be canonical padded base64.`);return bytes;
}
/** Binary counterpart to publicFetch: all DNS answers are public and the admitted address is pinned to TLS. */
async function publicSkillRequest(value,{signal,maxBytes=SKILL_IMPORT_LIMITS.archiveBytes,timeoutMs=15_000,headers={}}={}) {
  const url=assertPublicUrl(value),controller=new AbortController(),abort=()=>controller.abort(signal.reason || new Error('Skill import cancelled.'));
  const timer=setTimeout(()=>controller.abort(new HttpError(504,'Skill source request timed out.')),timeoutMs);timer.unref();
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{
    const address=await new Promise((resolve,reject)=>{
      const stop=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',stop,{once:true});
      if(controller.signal.aborted){stop();return;}
      resolvePublicAddress(url.hostname).then(value=>{controller.signal.removeEventListener('abort',stop);resolve(value);},error=>{controller.signal.removeEventListener('abort',stop);reject(error);});
    });aborted(controller.signal);
    return await new Promise((resolve,reject)=>{
      const request=https.request(url,{method:'GET',agent:false,headers,signal:controller.signal,lookup:(_host,options,callback)=>options?.all?callback(null,[address]):callback(null,address.address,address.family)},response=>{
        response.once('error',reject);response.once('aborted',()=>reject(new HttpError(502,'Skill source response was interrupted.')));
        const encoding=String(response.headers['content-encoding'] || 'identity').toLowerCase();
        if(encoding!=='identity'){response.destroy(new HttpError(400,'Compressed HTTP skill responses are unsupported.'));return;}
        const declared=Number(response.headers['content-length']);if(Number.isFinite(declared) && declared>maxBytes){response.destroy(new HttpError(413,'Skill source exceeds its size limit.'));return;}
        let total=0;const chunks=[];
        response.on('data',chunk=>{total+=chunk.length;if(total>maxBytes)response.destroy(new HttpError(413,'Skill source exceeds its size limit.'));else chunks.push(chunk);});
        response.once('end',()=>resolve({status:response.statusCode || 502,headers:response.headers,bytes:Buffer.concat(chunks)}));
      });request.once('error',reject);request.end();
    });
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
async function requestBytes(url,{signal,request=publicSkillRequest,maxBytes=SKILL_IMPORT_LIMITS.archiveBytes}={}) {
  const target=assertPublicUrl(url);ensure(!target.search,400,'Skill source URLs must not include query parameters.');aborted(signal);
  const response=await request(target.href,{signal,responseType:'bytes',timeoutMs:15_000,maxBytes,headers:{Accept:'application/octet-stream,application/json,text/plain','Accept-Encoding':'identity','User-Agent':'Tupies'}});aborted(signal);
  ensure(response.status>=200 && response.status<300,502,`Skill source returned HTTP ${Number(response.status)||502}.`);
  const bytes=Buffer.from(response.bytes || []);ensure(bytes.length<=maxBytes,413,'Skill source exceeds its size limit.');return bytes;
}

/** Downloads only public HTTPS content, never credentials, source-provided redirects, installers or executable hooks. */
export async function fetchSkillImport(value,{signal,request=publicSkillRequest,skillPath}={}) {
  const url=assertPublicUrl(value);ensure(!url.search,400,'Skill source URLs must not include query parameters.');
  if(url.hostname.toLowerCase()==='github.com'){
    const parts=url.pathname.split('/').filter(Boolean).map(part=>{try{return decodeURIComponent(part);}catch{throw new HttpError(400,'GitHub skill path is invalid.');}}),[owner,repo,kind,requestedRef,...rest]=parts;
    ensure(/^[A-Za-z0-9_.-]+$/.test(owner || '') && /^[A-Za-z0-9_.-]+$/.test(repo || '') && ['tree','blob'].includes(kind) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(requestedRef || ''),400,'Use a GitHub tree or SKILL.md link. Branch or tag names containing slashes need a link pinned to a full 40-character commit.');
    ensure(rest.length>0,400,'Choose the skill folder inside the GitHub repository.');
    if(kind==='blob')ensure(rest.pop()==='SKILL.md',400,'A GitHub file link must point to SKILL.md.');
    const folder=rest.join('/');if(folder)safeRelative(folder);
    let revision=requestedRef.toLowerCase();
    if(!/^[a-f0-9]{40}$/i.test(requestedRef)){
      aborted(signal);
      const endpoint=`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(requestedRef)}`;
      const response=await request(endpoint,{signal,responseType:'bytes',timeoutMs:15_000,maxBytes:4096,headers:{Accept:'application/vnd.github.sha','Accept-Encoding':'identity','User-Agent':'Tupies'}});aborted(signal);
      ensure(response.status>=200 && response.status<300,400,'The GitHub branch or tag could not be resolved. For names containing slashes, use a link pinned to a full 40-character commit.');
      const bytes=Buffer.from(response.bytes || []);ensure(bytes.length<=4096,413,'GitHub commit resolution exceeds its size limit.');
      const text=fatalUtf8(bytes).trim();revision=text;
      if(text.startsWith('{')){let resolved;try{resolved=JSON.parse(text);}catch{throw new HttpError(400,'GitHub returned an invalid commit resolution.');}revision=resolved?.sha;}
      ensure(typeof revision==='string' && /^[a-f0-9]{40}$/i.test(revision),400,'GitHub did not return a full immutable commit SHA.');revision=revision.toLowerCase();
    }
    const files=[],directories=[folder];let total=0,requests=0;
    while(directories.length){
      aborted(signal);ensure(++requests<=150,413,'The GitHub skill folder exceeds its traversal limit.');
      const current=directories.shift(),endpoint=`https://api.github.com/repos/${owner}/${repo}/contents/${current.split('/').map(encodeURIComponent).join('/')}?ref=${revision}`;
      // The query is generated by the engine from an already validated immutable commit, never copied from a skill.
      const response=await request(endpoint,{signal,responseType:'bytes',timeoutMs:15_000,maxBytes:500_000,headers:{Accept:'application/vnd.github+json','Accept-Encoding':'identity','User-Agent':'Tupies'}});aborted(signal);
      ensure(response.status>=200 && response.status<300,502,`GitHub returned HTTP ${Number(response.status)||502}.`);
      const listingBytes=Buffer.from(response.bytes || []);ensure(listingBytes.length<=500_000,413,'GitHub directory listing exceeds its size limit.');
      let listing;try{listing=JSON.parse(fatalUtf8(listingBytes));}catch{throw new HttpError(400,'GitHub returned an invalid skill directory listing.');}
      ensure(Array.isArray(listing) && listing.length<=150,400,'The GitHub link must identify a bounded skill folder.');
      for(const entry of listing){
        ensure(entry && ['dir','file'].includes(entry.type) && typeof entry.path==='string' && typeof entry.name==='string',400,'GitHub symlinks, submodules and special files are unsupported.');
        ensure(entry.path===`${current?`${current}/`:''}${entry.name}` && !entry.name.includes('/'),400,'GitHub directory entry points outside the selected skill.');safeRelative(entry.path);
        ensure(!entry.submodule_git_url && !entry.target,400,'GitHub symlinks and submodules are unsupported.');
        if(entry.type==='dir'){ensure(directories.length<100 && entry.path.split('/').length<=20,413,'GitHub skill folders exceed the depth limit.');directories.push(entry.path);continue;}
        ensure(files.length<SKILL_IMPORT_LIMITS.packageFiles && Number.isInteger(entry.size) && entry.size>=0 && total+entry.size<=SKILL_IMPORT_LIMITS.packageBytes,413,'GitHub skill exceeds the 100-file or 5 MB limit.');
        const raw=`https://raw.githubusercontent.com/${owner}/${repo}/${revision}/${entry.path.split('/').map(encodeURIComponent).join('/')}`,data=await requestBytes(raw,{signal,request,maxBytes:Math.min(SKILL_IMPORT_LIMITS.packageBytes-total,SKILL_IMPORT_LIMITS.packageBytes)});
        total+=data.length;ensure(total<=SKILL_IMPORT_LIMITS.packageBytes,413,'GitHub skill exceeds the 5 MB limit.');files.push({path:entry.path.slice(folder?folder.length+1:0),data});
      }
    }
    const parsed=packageFromFiles(files);return {packages:[{key:folder,label:parsed.skill.name,package:parsed,provenance:{kind:'github',url:url.href,repository:`${owner}/${repo}`,revision,requestedRef,skillPath:folder},metadata:parseSkillMetadata(parsed.content)}],requiresSelection:false};
  }
  const bytes=await requestBytes(url.href,{signal,request});
  if(/\.zip$/i.test(url.pathname)||bytes.length>=4 && bytes.readUInt32LE(0)===0x04034b50)return parseSkillArchive(bytes,{skillPath,provenance:{kind:'url',url:url.href,format:'agent-skills-zip'}});
  ensure(/\/SKILL\.md$/i.test(url.pathname),400,'Use a public SKILL.md URL, a ZIP URL, or a GitHub skill folder.');
  const content=fatalUtf8(bytes),parsed=parsePortableSkillPackage({content}),metadata=parseSkillMetadata(content);metadata.diagnostics.push('A standalone SKILL.md URL does not include supporting files. Import its folder if the skill needs resources.');
  return {packages:[{key:'',label:parsed.skill.name,package:parsed,provenance:{kind:'url',url:url.href,format:'standalone-skill',contentSha256:digest(bytes)},metadata}],requiresSelection:false};
}

export async function prepareSkillImport(input,{signal,request}={}) {
  ensure(input && typeof input==='object' && !Array.isArray(input),400,'Provide a skill package, ZIP or URL.');aborted(signal);
  const sources=['url','archiveBase64','files','content'].filter(key=>Object.hasOwn(input,key));ensure(sources.length===1,400,'Provide exactly one skill source: URL, ZIP, files or content.');
  if(sources[0]==='url')return fetchSkillImport(input.url,{signal,request,skillPath:input.skillPath});
  if(sources[0]==='archiveBase64')return parseSkillArchive(canonicalBase64(input.archiveBase64,SKILL_IMPORT_LIMITS.archiveBytes,'Skill ZIP'),{skillPath:input.skillPath});
  const parsed=parsePortableSkillPackage(input);for(const file of parsed.files)safeRelative(file.path);
  const lowered=new Set();for(const file of parsed.files){ensure(!lowered.has(file.path.toLowerCase()),400,'Skill package has case-conflicting paths.');lowered.add(file.path.toLowerCase());}
  return {packages:[{key:'',label:parsed.skill.name,package:parsed,provenance:{kind:'upload',format:'agent-skills'},metadata:parseSkillMetadata(parsed.content)}],requiresSelection:false};
}
