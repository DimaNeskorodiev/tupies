import { createHash } from 'node:crypto';

// Small, explicit lexical expansion. This is local ranking, not semantic/embedding retrieval.
const GROUPS=[
  ['budget','cost','price','pricing','expense','бюджет','вартість','цена','koszt'],
  ['deadline','due','launch','delivery','термін','срок','termin'],
  ['customer','client','клієнт','клиент','klient'],
  ['agenda','meeting','зустріч','встреча','spotkanie'],
  ['release','deploy','deployment','rollout'],
  ['font','typeface','typography'],
  ['preference','prefer','favorite','favourite','подобається','предпочтение'],
];
const STOP=new Set('a an and are as at be by can do for from how i in is it me my of on or please that the this to we what when with you your yes continue ahead'.split(' '));
const words=value=>(String(value ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(word=>word.length>1 && !STOP.has(word));
const clip=(text,max)=>String(text ?? '').length>max?`${String(text).slice(0,Math.max(0,max-15))} [… truncated]`:String(text ?? '');
const sha=value=>createHash('sha256').update(value).digest('hex');

export function memoryTerms(query,{expand=true}={}) {
  const original=[...new Set(words(String(query ?? '').slice(0,4000)))].slice(0,24),result=[...original];
  if(expand)for(const group of GROUPS)if(group.some(word=>original.includes(word)))for(const word of group)if(!result.includes(word) && result.length<48)result.push(word);
  return result;
}
export const expandMemoryQuery=query=>memoryTerms(query).join(' ');
const match=(word,term)=>word===term || (word.length>=4 && term.length>=4 && Math.abs(word.length-term.length)<=3 && (word.startsWith(term) || term.startsWith(word)));
export function memoryScore(text,query) {
  const terms=Array.isArray(query)?query:memoryTerms(query),body=words(String(text ?? '').slice(0,8000));
  return terms.reduce((sum,term)=>sum+Number(body.some(word=>match(word,term))),0);
}

/** Equal nontrivial values are review candidates, never an automatic merge/deletion decision. */
export function possibleDuplicateFacts(entries=[]) {
  const groups=new Map();
  for(const entry of entries.slice(0,200)) {
    const value=String(entry.value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
    if(value.length<20)continue;
    const group=groups.get(value) || [];group.push(entry.key);groups.set(value,group);
  }
  return [...groups.values()].filter(keys=>keys.length>1).slice(0,10).map(keys=>({keys:keys.slice(0,10),reason:'Same normalized value. Check meaning and sources before proposing a merge.'}));
}

export function renderCoreFact(entry,{keyChars=100,valueChars=500}={}) {
  return `- ${clip(entry.key,keyChars)}: ${clip(entry.value,valueChars)}`;
}

/** Pins retain priority; the remaining facts rank for this task, with recent edits breaking ties. */
export function coreMemorySelection(entries=[],{query='',limit=40,maxChars=10_000}={}) {
  const terms=memoryTerms(query),facts=entries.filter(entry=>entry && typeof entry.key==='string' && typeof entry.value==='string');
  const recent=facts.filter(entry=>!entry.pinned).map((entry,index)=>({entry,index,score:memoryScore(`${entry.key} ${entry.value}`,terms)})).sort((a,b)=>b.score-a.score || String(b.entry.updatedAt || '').localeCompare(String(a.entry.updatedAt || '')) || a.index-b.index);
  const candidates=[...facts.filter(entry=>entry.pinned),...recent.map(item=>item.entry)],selected=[],omittedPins=[];let used=0;
  for(const entry of candidates) {
    const size=renderCoreFact(entry).length+1;
    if(selected.length>=limit || used+size>maxChars){if(entry.pinned)omittedPins.push(entry.key);continue;}
    selected.push(entry);used+=size;
  }
  return {entries:selected,diagnostics:{selected:selected.length,total:facts.length,omitted:facts.length-selected.length,omittedPins,truncated:selected.filter(entry=>entry.key.length>100 || entry.value.length>500).map(entry=>entry.key),usedChars:used,relevant:selected.filter(entry=>memoryScore(`${entry.key} ${entry.value}`,terms)>0).length}};
}

/** Provenance is provided by engine/API code, never a memory tool argument. Legacy facts stay unknown. */
export function factSource(source) {
  const kind=['owner-edit','owner-chat','reviewed','unknown'].includes(source?.kind)?source.kind:'unknown';
  const ids=[...new Set(Array.isArray(source?.messageIds)?source.messageIds.filter(value=>typeof value==='string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value)):[])].slice(0,10);
  return {kind,...(ids.length?{messageIds:ids}:{}),...(Number.isFinite(Date.parse(source?.observedAt))?{observedAt:new Date(source.observedAt).toISOString()}:{}),...(kind==='reviewed' && /^[a-zA-Z0-9_-]{1,120}$/.test(source?.proposalId || '')?{proposalId:source.proposalId}:{})};
}

export function factRevision(entry) {
  if(!entry)return null;
  return sha(JSON.stringify([entry.key,entry.value,Boolean(entry.pinned),entry.provenance || null,entry.supersedes || null]));
}

/** Only the ordinary owner chat can directly mutate core memory. Other lanes use reviewed proposals. */
export function memoryWriteAllowed(context) {
  const source=context.source || 'chat',ownerLane=!context.sessionId || context.sessionId===context.bot?.id;
  return (source==='chat' || (source==='telegram' && context.sessionId===context.bot?.id)) && ownerLane && !context.fromBotId && !context.parentRunId;
}

export function memorySourceFor(state,context) {
  const request=(state.messages?.[context.bot.id] || []).find(message=>message.runId===context.runId && message.role==='user');
  return factSource({kind:memoryWriteAllowed(context)?'owner-chat':'unknown',messageIds:request?[request.id]:[],observedAt:request?.createdAt});
}

/** Merge already-scoped retrieval candidates, deduplicate text and keep the total presentation budget explicit. */
export function blendMemoryCandidates({facts=[],notes=[],history=[],query='',maxChars=6000,limit=12}={}) {
  const candidates=[...facts.map(entry=>({kind:'fact',id:entry.id || entry.key,text:`${entry.key}: ${entry.value}`,updatedAt:entry.updatedAt,source:entry.provenance})),...notes.map(note=>({kind:'note',id:note.path,text:note.excerpt,updatedAt:note.updatedAt,sha256:note.sha256,partial:Boolean(note.partial)})),...history.map(message=>({kind:'message',id:message.messageId,text:message.snippet,updatedAt:message.createdAt,partial:Boolean(message.partial)}))];
  const terms=memoryTerms(query),seen=new Set(),result=[];let used=0;
  for(const item of candidates.map((item,index)=>({...item,index,score:memoryScore(item.text,terms)})).filter(item=>item.score>0).sort((a,b)=>b.score-a.score || a.index-b.index)) {
    const identity=String(item.text).normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();if(seen.has(identity))continue;seen.add(identity);
    if(result.length>=limit || maxChars-used<80)break;
    const text=clip(item.text,Math.min(1200,maxChars-used));used+=text.length;
    const {index,...entry}=item;result.push({...entry,text,partial:item.partial || text!==item.text});
  }
  return {candidates:result,usedChars:used,total:candidates.length,truncated:result.length<candidates.length};
}
