import { promises as fs, constants as FS } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ensure, HttpError } from './store.mjs';
import { readText, workspaceReadPage } from './workspace-code.mjs';
import { expandMemoryQuery } from './memory-quality.mjs';
import { managedKnowledgeId, managedKnowledgeConflictPath, managedKnowledgeManifestPath, knowledgeManifestMatches } from './knowledge-paths.mjs';

// Second-level memory: an Obsidian-compatible Markdown vault inside each bot's private workspace.
export const BRAIN_FOLDER='brain';
export const BRAIN_LIMITS={notes:2000,noteBytes:500_000,indexedBytes:32_000_000,depth:8,entries:6000};
const SEGMENT=/^[\p{L}\p{N}][\p{L}\p{N} _.,()&'+-]{0,99}$/u, TAG=/^[\p{L}\p{N}_/-]{1,60}$/u, TYPE=/^[a-z0-9][a-z0-9_-]{0,39}$/;
const WIKILINK=/!?\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|[^\[\]\n]*)?\]\]/g, INLINE_TAG=/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu, LIST_ITEM=/^\s*(?:[-*+]|\d+[.)])\s/;
const vaults=new Map(), noteQueues=new Map(), ROOT={path:''};
// Common English, Ukrainian and Russian function words carry no recall signal.
const STOPWORDS=new Set(`about above after again all also am an and any are as at be because been before being between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how if in into is it its just me more most my no nor not now of off on once only or other our out over own please same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours make want need tell give get let like і й та а але або в у на з із за до від по про для що це як не так ти я ми ви він вона воно вони його її їх мені мене тобі нам вам цей ця ці той ті був була було були є бути буде може треба будь ласка також ще вже лише тільки коли де хто чи бо и во что он с со все его но да к же бы ее было вот от меня еще нет о из ему теперь даже ну ли если уже или ни был него до вас нибудь опять уж ведь там потом себя ничего ей они тут есть надо ней мы тебя их чем сам чтоб без чего раз тоже себе под тогда кто этот того потому этого какой ним здесь этом один мой тем чтобы нее сейчас куда зачем всех можно при об другой хоть после над больше тот через эти нас про всего них какая много эту моя свою этой перед такой им более всегда между пожалуйста`.split(/\s+/));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const cancelled=signal=>{if(signal?.aborted)throw signal.reason || new Error('Tool cancelled.');};
const integer=(value,fallback,min,max,label)=>{const result=value===undefined?fallback:value;ensure(Number.isInteger(result) && result>=min && result<=max,400,`${label} must be a whole number from ${min} to ${max}.`);return result;};
const stamp=()=>new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
const lookup=value=>value.normalize('NFC').toLowerCase();
export const linkTargets=text=>[...String(text).matchAll(WIKILINK)].map(match=>match[1].trim()).filter(Boolean);
export const tokens=value=>(String(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(token=>token.length>1 || /\d/.test(token));

/** Vault-relative note path such as projects/acme; .md is implied and hidden or dotted segments are refused. */
export function notePath(value) {
  ensure(typeof value==='string' && !/[\\\x00-\x1f\x7f]/.test(value),400,'Use a note path such as projects/acme.');
  let cleaned=value.trim().normalize('NFC').replace(/^brain\//,'');
  if(!cleaned.endsWith('.md'))cleaned+='.md';
  const parts=cleaned.split('/');
  ensure(cleaned.length<=200 && parts.length<=BRAIN_LIMITS.depth && parts.every(part=>SEGMENT.test(part) && part===part.trim() && !part.endsWith('.')),400,'Note paths use up to 8 levels of letters, numbers, spaces and simple punctuation, such as projects/acme.');
  return cleaned;
}

function folderPrefix(value) {
  ensure(typeof value==='string' && value.length<=200,400,'Use a folder such as people.');
  const cleaned=value.trim().normalize('NFC').replace(/^brain\//,'').replace(/\/+$/,'');
  ensure(cleaned.split('/').every(part=>SEGMENT.test(part)),400,'Use a folder such as people.');
  return `${lookup(cleaned)}/`;
}

function normalTag(value) {
  ensure(typeof value==='string',400,'Tags must be text.');
  const cleaned=value.trim().replace(/^#/,'').replace(/\/+$/,'').toLowerCase();
  ensure(TAG.test(cleaned) && /\D/.test(cleaned),400,'Tags use letters, numbers, _, - and / without spaces, such as project/acme.');
  return cleaned;
}

function textList(value,label,max,check) {
  ensure(Array.isArray(value) && value.length<=max,400,`${label} must be a list of at most ${max} items.`);
  return [...new Set(value.map(check))];
}

function noteText(value,label,max,context) {
  ensure(typeof value==='string' && value.trim() && value.length<=max && !value.includes('\0'),400,`${label} must contain 1–${max} characters.`);
  return context.redact ? context.redact(value) : value;
}

/** Tolerant frontmatter split; unknown properties keep their original lines. */
export function splitNote(content) {
  const match=content.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/);
  if(!match)return {entries:null,body:content};
  const entries=[];
  for(const line of (match[1] ?? '').split(/\r?\n/)) {
    const field=line.match(/^([^\s#:-][^:]{0,99}):(?:[ \t]+(.*)|[ \t]*)$/);
    if(field)entries.push({key:field[1].trim(),value:(field[2] || '').trim(),lines:[line]});
    else if(entries.length)entries.at(-1).lines.push(line);
    else entries.push({key:null,value:'',lines:[line]});
  }
  return {entries,body:content.slice(match[0].length)};
}

function unquote(value) {
  if(value.length>=2 && value.startsWith('"') && value.endsWith('"')){try{return String(JSON.parse(value));}catch{return value.slice(1,-1);}}
  if(value.length>=2 && value.startsWith("'") && value.endsWith("'"))return value.slice(1,-1).replace(/''/g,"'");
  const comment=value.search(/\s#/);
  return (comment<0?value:value.slice(0,comment)).trim();
}
/**
 * An ATX heading as [hashes, text] without its closing #s. Note text is untrusted and parsed on every recall, so this
 * runs in linear time; the equivalent single regex backtracks cubically on long runs of spaces.
 */
function atxHeading(line) {
  const open=/^(#{1,6})\s+/.exec(line);if(!open)return null;
  const text=line.slice(open[0].length).trimEnd();let end=text.length;
  while(end && text[end-1]==='#')end--;
  const title=text.slice(0,end).trimEnd();
  // A heading of only #s or spaces keeps its first character, as the earlier pattern did, so sections end in the same places.
  if(title)return [open[1],title];
  if(text)return [open[1],text[0]];
  return open[0].length-open[1].length>=2?[open[1],open[0].at(-1)]:null;
}

function property(entries,...keys) {
  const entry=entries?.find(item=>keys.includes(item.key?.toLowerCase()));if(!entry)return undefined;
  const {value,lines}=entry;
  if(!value)return lines.slice(1).map(line=>line.match(/^\s*-\s+(.*)$/)?.[1]).filter(item=>item!==undefined).map(unquote);
  if(value.startsWith('[') && value.endsWith(']')){try{const parsed=JSON.parse(value);if(Array.isArray(parsed))return parsed.map(String);}catch{}return value.slice(1,-1).split(',').map(item=>unquote(item.trim())).filter(Boolean);}
  return unquote(value);
}
const listProperty=value=>Array.isArray(value)?value:typeof value==='string' && value?value.split(value.includes(',')?',':/\s+/).map(item=>item.trim()).filter(Boolean):[];

function withProperties(entries,values) {
  const result=(entries || []).map(entry=>({...entry}));
  for(const [key,value] of Object.entries(values)) {
    if(value===undefined)continue;
    const line=`${key}: ${Array.isArray(value)?`[${value.map(item=>JSON.stringify(item)).join(', ')}]`:value}`,existing=result.find(entry=>entry.key?.toLowerCase()===key);
    if(existing)Object.assign(existing,{key,lines:[line]});else result.push({key,lines:[line]});
  }
  return result;
}
const frontmatter=entries=>entries?.length?`---\n${entries.flatMap(entry=>entry.lines).join('\n')}\n---\n`:'';

/** Prose lines outside fenced code, with inline code removed, so examples never become links or tags. */
function prose(body) {
  const lines=[];let fence=null;
  for(const line of body.split('\n')) {
    const marker=line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if(marker){if(!fence)fence=marker[0];else if(marker[0]===fence)fence=null;continue;}
    if(!fence)lines.push(line.replace(/`[^`\n]*`/g,''));
  }
  return lines;
}

export function parseNote(relative,content) {
  const {entries,body}=splitNote(content),lines=prose(body),text=lines.join('\n');
  const tags=new Set();
  for(const tag of [...listProperty(property(entries,'tags','tag')),...[...text.matchAll(INLINE_TAG)].map(match=>match[1])]){try{tags.add(normalTag(String(tag)));}catch{}}
  const links=[...new Set([...text.matchAll(WIKILINK)].map(match=>match[1].trim()).filter(target=>target && !/\.(?!md$)[a-z0-9]{1,5}$/i.test(target)))].slice(0,500);
  const headings=lines.map(line=>atxHeading(line)?.[1]).filter(Boolean);
  const title=String(property(entries,'title') || '') || path.posix.basename(relative,'.md');
  const aliases=listProperty(property(entries,'aliases','alias')).map(String).filter(alias=>alias.length<=200).slice(0,20);
  const terms=new Map();let length=0;
  const add=(value,weight)=>{for(const term of tokens(value)){terms.set(term,(terms.get(term) || 0)+weight);length+=weight;}};
  add(title,3);add(aliases.join(' '),3);add([...tags].join(' ').replaceAll('/',' '),2);add(headings.join(' '),2);add(path.posix.dirname(relative).replace(/^\.$/,''),1);add(text,1);
  return {path:relative,title,aliases,tags:[...tags].slice(0,100),type:String(property(entries,'type') || ''),links,terms,length};
}

async function scan(context) {
  const {root,resolve,signal}=context;let base;
  try{base=await resolve(root,BRAIN_FOLDER);}catch(error){if(error.status===404)return {base:null,files:[],truncated:false};throw error;}
  ensure((await fs.lstat(base)).isDirectory(),400,'The brain path must be a folder.');
  const files=[];let entries=0,truncated=false;
  async function walk(folder,depth) {
    cancelled(signal);
    // Revalidate every directory before opening it; never follow discovered symlinks.
    await resolve(root,path.relative(root,folder).split(path.sep).join('/'));
    const items=[],handle=await fs.opendir(folder);
    try{for await(const entry of handle){if(++entries>BRAIN_LIMITS.entries){truncated=true;break;}items.push(entry);}}finally{await handle.close().catch(()=>{});}
    items.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    for(const entry of items) {
      if(entry.name.startsWith('.') || entry.isSymbolicLink())continue;
      const absolute=path.join(folder,entry.name);
      if(entry.isDirectory()){if(depth+1<BRAIN_LIMITS.depth)await walk(absolute,depth+1);else truncated=true;continue;}
      if(!entry.isFile() || !entry.name.endsWith('.md'))continue;
      if(files.length>=BRAIN_LIMITS.notes){truncated=true;continue;}
      const stat=await fs.lstat(absolute).catch(()=>null);
      if(stat?.isFile())files.push({path:path.relative(base,absolute).split(path.sep).join('/'),size:stat.size,mtimeMs:stat.mtimeMs,ino:stat.ino});
    }
  }
  await walk(base,0);return {base,files,truncated};
}

function graph(notes) {
  const byPath=new Map(),byName=new Map(),byAlias=new Map();
  for(const note of notes) {
    const key=lookup(note.path).slice(0,-3),name=path.posix.basename(key);byPath.set(key,note);
    if(!byName.has(name))byName.set(name,[]);byName.get(name).push(note);
    for(const alias of note.aliases)if(!byAlias.has(lookup(alias)))byAlias.set(lookup(alias),note);
  }
  // Obsidian resolution order: exact path, nearest note with the same name, then alias.
  const resolveLink=(source,target)=>{
    const key=lookup(target).replace(/\.md$/,'').replace(/^\/+/,'');
    if(byPath.has(key))return byPath.get(key);
    const candidates=byName.get(path.posix.basename(key));
    if(candidates?.length){const folder=path.posix.dirname(lookup(source.path));return candidates.find(note=>path.posix.dirname(lookup(note.path))===folder) || [...candidates].sort((a,b)=>a.path.length-b.path.length)[0];}
    return byAlias.get(key) || null;
  };
  const outgoing=new Map(),incoming=new Map();
  for(const note of notes) {
    const links=note.links.map(target=>({target,note:resolveLink(note,target)}));outgoing.set(note.path,links);
    for(const link of links)if(link.note && link.note!==note){if(!incoming.has(link.note.path))incoming.set(link.note.path,new Set());incoming.get(link.note.path).add(note.path);}
  }
  return {byPath,outgoing,incoming,resolve:resolveLink};
}

// Managed files can arrive before their manifest through sync. Never downgrade an
// unpublished, superseded or externally edited revision into an ordinary note.
async function managedEligible(context,relative,sha256) {
  if(managedKnowledgeConflictPath(relative))return false;
  if(!managedKnowledgeId(relative))return true;
  try {
    const read=await readText(context,managedKnowledgeManifestPath(relative));
    if(read.size>64_000)return false;
    return knowledgeManifestMatches(JSON.parse(read.content),relative,sha256,path.basename(context.root));
  } catch(error) {cancelled(context.signal);return false;}
}

/** Refresh the in-memory index from file metadata, so external edits (for example in Obsidian) are seen without a restart. */
async function vault(context) {
  const {base,files,truncated}=await scan(context);
  if(!base)return {notes:[],count:0,skipped:0,truncated:false,graph:graph([])};
  let cache=vaults.get(base) || {notes:new Map()};vaults.delete(base);vaults.set(base,cache);
  while(vaults.size>32)vaults.delete(vaults.keys().next().value);
  const seen=new Set();let bytes=0,skipped=0,indexTruncated=truncated;
  for(const file of files) {
    seen.add(file.path);
    if(file.size>BRAIN_LIMITS.noteBytes || bytes+file.size>BRAIN_LIMITS.indexedBytes){cache.notes.delete(file.path);skipped++;if(file.size<=BRAIN_LIMITS.noteBytes)indexTruncated=true;continue;}
    try {
      const cached=cache.notes.get(file.path),managed=managedKnowledgeId(file.path) || managedKnowledgeConflictPath(file.path);
      // Recheck both managed bytes and manifest even when note metadata is unchanged.
      let read=managed?await readText(context,`${BRAIN_FOLDER}/${file.path}`):null;
      if(managed && !await managedEligible(context,file.path,read.sha256)){cache.notes.delete(file.path);continue;}
      if(cached && cached.size===file.size && cached.mtimeMs===file.mtimeMs && cached.ino===file.ino && (!managed || cached.sha256===read.sha256)){bytes+=file.size;continue;}
      read||=await readText(context,`${BRAIN_FOLDER}/${file.path}`);
      cache.notes.set(file.path,{...parseNote(file.path,read.content),sha256:read.sha256,size:read.size,mtimeMs:read.stat.mtimeMs,ino:read.stat.ino});bytes+=read.size;
    } catch(error) {
      cancelled(context.signal);
      if(!(error instanceof HttpError) && !['ENOENT','ELOOP','EACCES','EPERM'].includes(error.code))throw error;
      cache.notes.delete(file.path);skipped++;
    }
  }
  for(const key of cache.notes.keys())if(!seen.has(key))cache.notes.delete(key);
  const notes=[...cache.notes.values()];
  return {notes,count:files.length,skipped,truncated:indexTruncated,graph:graph(notes)};
}

async function snippet(context,note,terms) {
  let read;try{read=await readText(context,`${BRAIN_FOLDER}/${note.path}`);}catch{cancelled(context.signal);return '';}
  if(!await managedEligible(context,note.path,read.sha256))return '';
  const lines=prose(splitNote(read.content).body).map(line=>line.trim()).filter(Boolean);
  let best=lines.find(line=>!line.startsWith('#')) || lines[0] || '',hits=0;
  for(const line of terms.length?lines:[]){const words=tokens(line),count=terms.filter(term=>words.some(word=>related(term,word))).length;if(count>hits){best=line;hits=count;}}
  if(best.length<=280)return best;
  const position=Math.max(0,...terms.map(term=>best.toLowerCase().indexOf(term)).filter(index=>index>=0).slice(0,1)),start=Math.max(0,position-80);
  return `${start?'…':''}${best.slice(start,start+277)}…`;
}

/** Without per-language stemmers, a long shared stem stands in for inflection (project/projects, проєкт/проєкту). */
function related(term,word) {
  if(word.startsWith(term))return true;
  if(term.length<4 || word.length<4)return false;
  let common=0;while(common<term.length && term[common]===word[common])common++;
  return common>=Math.max(4,Math.ceil(0.75*Math.min(term.length,word.length)));
}

const summary=(note,graph)=>({path:note.path,title:note.title,type:note.type || undefined,tags:note.tags.slice(0,12),updatedAt:new Date(note.mtimeMs).toISOString(),links:(graph.outgoing.get(note.path) || []).filter(link=>link.note).length,backlinks:graph.incoming.get(note.path)?.size || 0});

/** BM25 over titles, aliases, tags, headings and text, with stem-tolerant matching and a small boost for linked notes. */
function rank(notes,pool,terms,links,boost=new Set()) {
  const vocabulary=new Set();for(const note of notes)for(const term of note.terms.keys())vocabulary.add(term);
  const words=terms.map(term=>({term,prefixes:term.length>=3?[...vocabulary].filter(word=>word!==term && related(term,word)).slice(0,50):[]}));
  const frequency=note=>words.map(({term,prefixes})=>(note.terms.get(term) || 0)+0.5*prefixes.reduce((sum,word)=>sum+(note.terms.get(word) || 0),0));
  const rows=new Map(notes.map(note=>[note,frequency(note)])),total=notes.length,average=notes.reduce((sum,note)=>sum+note.length,0)/Math.max(1,total) || 1;
  const idf=words.map((_,index)=>{const df=[...rows.values()].filter(row=>row[index]>0).length;return Math.log(1+(total-df+0.5)/(df+0.5));});
  return pool.map(note=>{
    const row=rows.get(note),matched=row.filter(value=>value>0).length;if(!matched)return null;
    const score=row.reduce((sum,tf,index)=>sum+idf[index]*tf*2.2/(tf+1.2*(0.25+0.75*note.length/average)),0);
    return {note,matched,score:score*(0.5+0.5*matched/terms.length)*(1+0.05*Math.min(links.incoming.get(note.path)?.size || 0,10))*(boost.has(note.path)?1.5:1)};
  }).filter(Boolean).sort((a,b)=>b.score-a.score || b.note.mtimeMs-a.note.mtimeMs);
}

export async function brainSearch(context,args) {
  ensure(typeof args.query==='string' && args.query.length<=300,400,'Search for 0–300 characters.');
  const query=args.query.trim(),limit=integer(args.limit,8,1,20,'Result limit');
  const tag=args.tag===undefined?null:normalTag(args.tag),folder=args.folder===undefined?null:folderPrefix(args.folder);
  const {notes,count,skipped,truncated,graph:links}=await vault(context);
  const pool=notes.filter(note=>(!tag || note.tags.some(item=>item===tag || item.startsWith(`${tag}/`))) && (!folder || lookup(note.path).startsWith(folder)));
  const terms=[...new Set(tokens(query))].slice(0,20);
  const ranked=terms.length?rank(notes,pool,terms,links):pool.sort((a,b)=>b.mtimeMs-a.mtimeMs).map(note=>({note,score:null}));
  const results=[];
  for(const {note,score} of ranked.slice(0,limit))results.push({...summary(note,links),score:score===null?undefined:Math.round(score*1000)/1000,snippet:await snippet(context,note,terms)});
  return {query,results,total:ranked.length,notes:count,truncated:ranked.length>limit || truncated,indexTruncated:truncated,skippedNotes:skipped,folder:BRAIN_FOLDER};
}

/** Distinctive task words that occur in the vault, rarest first; words found in most notes add noise rather than recall. */
function informative(text,notes) {
  const vocabulary=new Set();for(const note of notes)for(const term of note.terms.keys())vocabulary.add(term);
  const candidates=[...new Set(tokens(String(text).slice(0,4000)))].filter(term=>!STOPWORDS.has(term) && (term.length>=3 || /\d/.test(term))).slice(0,60);
  return candidates.map(term=>{
    const words=[...vocabulary].filter(word=>word===term || (term.length>=3 && related(term,word))).slice(0,50);
    return {term,df:words.length?notes.filter(note=>words.some(word=>note.terms.has(word))).length:0};
  }).filter(({df})=>df>0 && (notes.length<5 || df/notes.length<=0.6)).sort((a,b)=>a.df-b.df).slice(0,12).map(({term})=>term);
}

/** The most relevant paragraphs of a note, in their original order, within a character budget. */
function excerpt(content,terms,maxChars) {
  const blocks=prose(splitNote(content).body).join('\n').split(/\n[ \t]*\n/).map(block=>block.trim()).filter(Boolean).slice(0,400);
  const scored=blocks.map((block,index)=>{const words=tokens(block);return {block,index,hits:terms.filter(term=>words.some(word=>related(term,word))).length};});
  const chosen=[];let used=0;
  for(const item of scored.sort((a,b)=>b.hits-a.hits || a.index-b.index)) {
    // Each block may also need a separator and a gap marker.
    const room=maxChars-used-5;if(room<40)break;
    const block=item.block.length>room?`${item.block.slice(0,room-1)}…`:item.block;
    chosen.push({...item,block});used+=block.length+5;
    if(block!==item.block)break;
  }
  return chosen.sort((a,b)=>a.index-b.index).map((item,position,list)=>`${position && item.index!==list[position-1].index+1?'…\n\n':''}${item.block}`).join('\n\n');
}

/** Notes worth placing in front of the model for a task: strong matches, notes named in the task and matching notes linked from core memory. */
export async function brainRecall(context,{query,previous='',links:targets=[],limit=4,maxChars=4000}={}) {
  const {notes,graph:links}=await vault(context);if(!notes.length)return {notes:[],terms:[]};
  let terms=informative(expandMemoryQuery(query),notes);
  if(terms.length<3 && previous)terms=[...new Set([...terms,...informative(previous,notes)])].slice(0,12);
  if(!terms.length)return {notes:[],terms};
  const linked=new Set(targets.map(target=>links.resolve(ROOT,target)?.path).filter(Boolean)),ranked=rank(notes,notes,terms,links,linked);
  const named=note=>tokens(`${note.title} ${note.aliases.join(' ')}`).some(word=>terms.some(term=>/\D/.test(term) && related(term,word)));
  const selected=ranked.filter(({note,matched,score})=>score>=ranked[0].score*0.3 && (matched>=Math.min(2,terms.length) || named(note) || linked.has(note.path))).slice(0,limit);
  const budget=Math.max(400,Math.floor(maxChars/Math.max(1,selected.length))),result=[];
  for(const {note} of selected) {
    let read;try{read=await readText(context,`${BRAIN_FOLDER}/${note.path}`);}catch{cancelled(context.signal);continue;}
    if(!await managedEligible(context,note.path,read.sha256))continue;
    const selectedText=excerpt(read.content,terms,budget);
    result.push({path:note.path,title:note.title,tags:note.tags.slice(0,8),updatedAt:new Date(note.mtimeMs).toISOString(),sha256:read.sha256,partial:selectedText!==splitNote(read.content).body.trim(),linked:linked.has(note.path),excerpt:selectedText});
  }
  return {notes:result,terms};
}

/** Read by exact path, or resolve a [[link]] name or alias the way Obsidian does. */
export async function brainRead(context,args) {
  ensure(typeof args.path==='string',400,'Use a note path such as projects/acme.');
  const target=args.path.trim().replace(/^!?\[\[([^\[\]|#]+)(?:[#|][^\[\]]*)?\]\]$/,'$1').trim(),{graph:links}=await vault(context);
  let requested=null,page=null,resolvedFrom;try{requested=notePath(target);}catch{}
  let relative=(requested && links.byPath.get(lookup(requested).slice(0,-3))?.path) || requested;
  const read=file=>workspaceReadPage(context,{path:`${BRAIN_FOLDER}/${file}`,offset:args.offset,limit:args.limit});
  if(relative){try{page=await read(relative);}catch(error){if(error.status!==404)throw error;}}
  if(!page) {
    const resolved=links.resolve(ROOT,target);
    if(!resolved)notePath(target);
    ensure(resolved,404,'Note not found. Use brain_search to find its path.');
    relative=resolved.path;resolvedFrom=target;page=await read(relative);
  }
  const note=links.byPath.get(lookup(relative).slice(0,-3));
  ensure(await managedEligible(context,relative,page.sha256),404,'This managed knowledge revision is not active or has changed.');
  return {...page,path:relative,resolvedFrom,workspacePath:`${BRAIN_FOLDER}/${relative}`,title:note?.title ?? path.posix.basename(relative,'.md'),type:note?.type || undefined,tags:note?.tags ?? [],aliases:note?.aliases ?? [],
    links:(links.outgoing.get(note?.path) || []).slice(0,100).map(link=>({target:link.target,path:link.note?.path ?? null})),
    backlinks:[...(links.incoming.get(note?.path) || [])].slice(0,100).map(source=>({path:source,title:links.byPath.get(lookup(source).slice(0,-3))?.title})),indexed:Boolean(note)};
}

const OVERVIEW_LINKS=50, OVERVIEW_EDGES=20_000, NOTE_CHARS=100_000;
const plainFolder=relative=>{const folder=path.posix.dirname(relative);return folder==='.'?'':folder;};

/** Read-only vault map for the owner's profile view: note metadata with resolved links, tag counts and bounds. */
export async function brainOverview(context) {
  const {notes,count,skipped,truncated,graph:links}=await vault(context);
  const tags=new Map();let unresolved=0,edges=0,linksTruncated=false;
  const list=[...notes].sort((a,b)=>b.mtimeMs-a.mtimeMs || (a.path<b.path?-1:1)).map(note=>{
    for(const tag of note.tags)tags.set(tag,(tags.get(tag) || 0)+1);
    const outgoing=links.outgoing.get(note.path) || [];unresolved+=outgoing.filter(link=>!link.note).length;
    let targets=[...new Set(outgoing.filter(link=>link.note && link.note!==note).map(link=>link.note.path))];
    const room=Math.max(0,Math.min(OVERVIEW_LINKS,OVERVIEW_EDGES-edges));
    if(targets.length>room){targets=targets.slice(0,room);linksTruncated=true;}
    edges+=targets.length;
    return {path:note.path,title:note.title,folder:plainFolder(note.path),tags:note.tags.slice(0,12),type:note.type || undefined,updated:new Date(note.mtimeMs).toISOString(),size:note.size,links:targets,backlinks:links.incoming.get(note.path)?.size || 0};
  });
  return {folder:BRAIN_FOLDER,notes:list,total:count,indexed:notes.length,skipped,truncated,linksTruncated,unresolved,
    tags:[...tags].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,100).map(([tag,notes])=>({tag,notes})),
    limits:{notes:BRAIN_LIMITS.notes,noteBytes:BRAIN_LIMITS.noteBytes,indexedBytes:BRAIN_LIMITS.indexedBytes,linksPerNote:OVERVIEW_LINKS,links:OVERVIEW_EDGES,noteChars:NOTE_CHARS}};
}

/** One note for reading: an exact path, or a [[link]] name or alias resolved like Obsidian. Hidden, dotted and escaping paths are refused. */
export async function brainNote(context,{path:requested}) {
  ensure(typeof requested==='string' && requested.length<=300,400,'Use a note path such as projects/acme.');
  const target=requested.trim().replace(/^!?\[\[([^\[\]|#]+)(?:[#|][^\[\]]*)?\]\]$/,'$1').trim().replace(/^\/+/,'');
  ensure(target && !/[\\\x00-\x1f\x7f]/.test(target) && target.split('/').every(part=>part.trim() && !part.trim().startsWith('.')),400,'Use a note path such as projects/acme.');
  const {graph:links}=await vault(context);
  let relative=null;try{relative=notePath(target);}catch{}
  let note=relative && links.byPath.get(lookup(relative).slice(0,-3)),read=null;
  if(note)relative=note.path;
  else if(relative)read=await readText(context,`${BRAIN_FOLDER}/${relative}`).catch(error=>{if(error.status===404 || error.code==='ENOENT')return null;throw error;});
  if(!note && !read) {
    note=links.resolve(ROOT,target);
    if(!note)notePath(target);
    ensure(note,404,'Note not found.');
    relative=note.path;
  }
  read||=await readText(context,`${BRAIN_FOLDER}/${relative}`);
  ensure(await managedEligible(context,relative,read.sha256),404,'This managed knowledge revision is not active or has changed.');
  const parsed=note || parseNote(relative,read.content),{entries,body}=splitNote(read.content),created=property(entries,'created');
  const outgoing=note?links.outgoing.get(note.path) || []:parsed.links.map(link=>({target:link,note:links.resolve(parsed,link)}));
  return {path:relative,workspacePath:`${BRAIN_FOLDER}/${relative}`,resolvedFrom:target===relative || `${target}.md`===relative?undefined:target,title:parsed.title,folder:plainFolder(relative),type:parsed.type || undefined,tags:parsed.tags,aliases:parsed.aliases,
    created:typeof created==='string' && created?created:undefined,updated:new Date(read.stat.mtimeMs).toISOString(),size:read.size,content:body.slice(0,NOTE_CHARS),truncated:body.length>NOTE_CHARS,
    links:outgoing.slice(0,200).map(link=>({target:link.target,path:link.note?.path ?? null})),backlinks:[...(links.incoming.get(relative) || [])].slice(0,200),indexed:Boolean(note)};
}

async function existingNote(context,workspacePath) {
  try{return await readText(context,workspacePath);}catch(error){if(error.status===404 || error.code==='ENOENT')return null;throw error;}
}

/** One writer per note; a changed file is never overwritten, and a new note never replaces one created meanwhile. */
async function saveNote(context,relative,compose) {
  const workspacePath=`${BRAIN_FOLDER}/${relative}`,file=await context.resolve(context.root,workspacePath,{createParents:true,allowMissing:true});
  const previous=noteQueues.get(file) || Promise.resolve();
  const job=previous.catch(()=>{}).then(async()=>{
    cancelled(context.signal);
    const existing=await existingNote(context,workspacePath);
    if(!existing)ensure((await scan(context)).files.length<BRAIN_LIMITS.notes,400,'This bot’s notes reached the 2000-note limit. Merge or remove old notes first.');
    const composed=await compose(existing);
    if(composed===null)return {path:relative,workspacePath,skipped:true,sha256:existing?.sha256};
    const bytes=Buffer.from(composed);
    ensure(bytes.length<=BRAIN_LIMITS.noteBytes,413,'A note can contain at most 500 KB. Split it into linked notes.');
    const temporary=path.join(path.dirname(file),`.studio-${randomBytes(10).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temporary,bytes,{mode:0o600,flag:'wx'});
      if(existing) {
        const current=await existingNote(context,workspacePath);
        ensure(current?.sha256===existing.sha256 && current.stat.ino===existing.stat.ino && current.stat.dev===existing.stat.dev,409,'The note changed while saving. Read it again.');
        cancelled(context.signal);await context.resolve(context.root,workspacePath);await fs.rename(temporary,file);
      } else {
        cancelled(context.signal);await context.resolve(context.root,workspacePath,{allowMissing:true});
        try{await fs.link(temporary,file);}
        catch(error) {
          if(error.code==='EEXIST')throw new HttpError(409,'A note was created at this path meanwhile. Read it before changing it.');
          if(!['EPERM','ENOTSUP','EXDEV','ENOSYS'].includes(error.code))throw error;
          try{await fs.copyFile(temporary,file,FS.COPYFILE_EXCL);}catch(copyError){if(copyError.code==='EEXIST')throw new HttpError(409,'A note was created at this path meanwhile. Read it before changing it.');throw copyError;}
        }
      }
    } finally {await fs.rm(temporary,{force:true}).catch(()=>{});}
    return {path:relative,workspacePath,created:!existing,size:bytes.length,sha256:digest(bytes)};
  });
  noteQueues.set(file,job);
  try{return await job;}finally{if(noteQueues.get(file)===job)noteQueues.delete(file);}
}

export async function brainWrite(context,args) {
  const relative=notePath(args.path),content=noteText(args.content,'Note content',100_000,context);
  const tags=args.tags===undefined?undefined:textList(args.tags,'Tags',20,normalTag);
  const aliases=args.aliases===undefined?undefined:textList(args.aliases,'Aliases',10,alias=>{ensure(typeof alias==='string' && alias.trim() && alias.length<=100 && !/[\x00-\x1f\x7f]/.test(alias),400,'Aliases must be single-line text of 1–100 characters.');return context.redact?context.redact(alias.trim()):alias.trim();});
  ensure(args.type===undefined || (typeof args.type==='string' && TYPE.test(args.type)),400,'Note type must be a lowercase word such as person, project or decision.');
  ensure(args.expectedSha256===undefined || (typeof args.expectedSha256==='string' && /^[a-f0-9]{64}$/.test(args.expectedSha256)),400,'Use the sha256 returned by brain_read.');
  return saveNote(context,relative,existing=>{
    if(existing)ensure(args.expectedSha256===existing.sha256,409,args.expectedSha256?'The note changed since it was read. Read it again before replacing it.':'This note already exists. Read it with brain_read and pass its sha256 as expectedSha256, or add to it with brain_append.');
    else ensure(args.expectedSha256===undefined,409,'The note no longer exists. Search the notes again before replacing it.');
    const supplied=splitNote(content),entries=existing?splitNote(existing.content).entries || []:[];
    for(const entry of supplied.entries || []){const index=entry.key?entries.findIndex(item=>item.key?.toLowerCase()===entry.key.toLowerCase()):-1;if(index>=0)entries[index]=entry;else entries.push(entry);}
    const time=stamp();
    return frontmatter(withProperties(entries,{type:args.type,tags,aliases,created:property(entries,'created')?undefined:time,updated:time}))+supplied.body.replace(/^\s*\n/,'');
  });
}

function joined(text,addition) {
  const trimmed=text.trimEnd();if(!trimmed)return addition;
  return `${trimmed}${LIST_ITEM.test(trimmed.split('\n').at(-1)) && LIST_ITEM.test(addition)?'\n':'\n\n'}${addition}`;
}

/** Append at the end of the note, or at the end of the named section (created when missing). */
export function appendToBody(body,addition,heading=null) {
  if(!heading)return `${joined(body,addition)}\n`;
  const lines=body.split('\n'),wanted=heading.toLowerCase();let start=-1,end=lines.length,level=0,fence=false;
  for(let index=0;index<lines.length;index++) {
    if(/^\s{0,3}(```|~~~)/.test(lines[index]))fence=!fence;if(fence)continue;
    const match=atxHeading(lines[index]);if(!match)continue;
    if(start<0){if(match[1].toLowerCase()===wanted){start=index;level=match[0].length;}}
    else if(match[0].length<=level){end=index;break;}
  }
  if(start<0)return `${joined(body,`## ${heading}\n\n${addition}`)}\n`;
  const rest=lines.slice(end).join('\n');
  return `${joined(lines.slice(0,end).join('\n'),addition)}\n${rest?`\n${rest}`:''}`;
}

export async function brainAppend(context,args) {
  const relative=notePath(args.path),addition=noteText(args.content,'Appended text',20_000,context).trimEnd();
  ensure(args.heading===undefined || (typeof args.heading==='string' && args.heading.trim() && args.heading.length<=120 && !/[\x00-\x1f\x7f]/.test(args.heading)),400,'Section heading must be single-line text of 1–120 characters.');
  const heading=args.heading===undefined?null:args.heading.trim().replace(/^#+\s*/,'');
  return saveNote(context,relative,existing=>{
    const time=stamp();
    if(!existing)return frontmatter(withProperties([],{created:time,updated:time}))+appendToBody('',addition,heading);
    const {entries,body}=splitNote(existing.content);
    return frontmatter(entries?withProperties(entries,{updated:time}):null)+appendToBody(body,addition,heading);
  });
}

/** Opt-in engine observations only; one bounded record per phase, no inferred preferences or model calls. */
export async function brainEpisode(context,{runId,phase='finish',status,request='',sourceMessageIds=[],artifacts=[],date=new Date().toISOString().slice(0,10)}={}) {
  ensure(typeof runId==='string' && runId.length<=120 && ['finish','compaction'].includes(phase),400,'Invalid episodic record identity.');
  ensure(/^\d{4}-\d\d-\d\d$/.test(date),400,'Invalid episodic note date.');
  const allowed=['running','completed','failed','cancelled','interrupted','unknown'];ensure(allowed.includes(status),400,'Invalid observed task status.');
  const marker=`<!-- tupies-episode:${digest(`${runId}:${phase}`).slice(0,32)} -->`,ids=[...new Set(sourceMessageIds.filter(value=>typeof value==='string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value)))].slice(0,10);
  const files=artifacts.filter(item=>item && typeof item.path==='string' && item.path.length<=250 && !/[\x00-\x1f`]/.test(item.path)).slice(0,10);
  const clean=value=>(context.redact?context.redact(String(value)):String(value)).replace(/[\r\n]+/g,' ').slice(0,700);
  const addition=[marker,`### Task observation (${phase})`,`Observed task status: ${status}. This records execution state, not proof that every requested outcome is correct.`,`Request excerpt (user data): ${clean(request)}`,ids.length?`Source messages: ${ids.join(', ')}`:'Source messages: unavailable.',files.length?`Engine-recorded output paths: ${files.map(item=>`\`${clean(item.path)}\``).join(', ')}`:'No verified output files recorded.'].join('\n\n');
  let skipped='';
  const result=await saveNote(context,notePath(`daily/${date}`),existing=>{
    if(existing?.content.includes(marker)){skipped='duplicate';return null;}
    const count=(existing?.content.match(/<!-- tupies-episode:/g) || []).length;
    if(count>=20 || (existing?.content.length || 0)+addition.length>40_000){skipped='daily-limit';return null;}
    const {entries,body}=splitNote(existing?.content || ''),time=stamp();
    return frontmatter(withProperties(entries || [],{created:property(entries,'created')?undefined:time,updated:time}))+appendToBody(body,addition,'Task observations');
  });
  return {saved:!result.skipped,...(skipped?{skipped}:{}),path:result.path,sha256:result.sha256};
}

/** Link neighbourhood of one note, or a whole-vault overview for maintenance. */
export async function brainLinks(context,args) {
  const {notes,count,truncated,graph:links}=await vault(context);
  if(args.path===undefined) {
    const tags=new Map(),unresolved=new Map();
    for(const note of notes){for(const tag of note.tags)tags.set(tag,(tags.get(tag) || 0)+1);for(const link of links.outgoing.get(note.path))if(!link.note)unresolved.set(link.target,(unresolved.get(link.target) || 0)+1);}
    const isolated=note=>!(links.outgoing.get(note.path) || []).some(link=>link.note && link.note!==note) && !links.incoming.get(note.path)?.size;
    return {notes:count,indexTruncated:truncated,
      tags:[...tags].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,40).map(([tag,notes])=>({tag,notes})),
      hubs:notes.filter(note=>links.incoming.get(note.path)?.size).sort((a,b)=>links.incoming.get(b.path).size-links.incoming.get(a.path).size).slice(0,10).map(note=>summary(note,links)),
      orphans:notes.filter(isolated).sort((a,b)=>b.mtimeMs-a.mtimeMs).slice(0,30).map(note=>note.path),
      unresolved:[...unresolved].sort((a,b)=>b[1]-a[1]).slice(0,30).map(([target,sources])=>({target,sources}))};
  }
  const relative=notePath(args.path),depth=integer(args.depth,1,1,2,'Link depth'),start=links.byPath.get(lookup(relative).slice(0,-3));
  ensure(start,404,'Note not found. Use brain_search to find its path.');
  const distance=new Map([[start,0]]),edges=new Map();let frontier=[start];
  for(let level=1;level<=depth && frontier.length;level++) {
    const next=[];
    for(const note of frontier) {
      const neighbours=[...(links.outgoing.get(note.path) || []).filter(link=>link.note && link.note!==note).map(link=>[note,link.note]),...[...(links.incoming.get(note.path) || [])].map(source=>[links.byPath.get(lookup(source).slice(0,-3)),note])];
      for(const [from,to] of neighbours) {
        if(edges.size<200)edges.set(`${from.path}\n${to.path}`,{from:from.path,to:to.path});
        const other=from===note?to:from;
        if(!distance.has(other) && distance.size<60){distance.set(other,level);next.push(other);}
      }
    }
    frontier=next;
  }
  const included=new Set([...distance.keys()].map(note=>note.path));
  return {path:start.path,depth,nodes:[...distance].map(([note,level])=>({...summary(note,links),distance:level})),edges:[...edges.values()].filter(edge=>included.has(edge.from) && included.has(edge.to)),
    unresolved:(links.outgoing.get(start.path) || []).filter(link=>!link.note).map(link=>link.target).slice(0,50)};
}
