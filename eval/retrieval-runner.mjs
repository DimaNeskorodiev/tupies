import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { safePath } from '../lib/agent-tools.mjs';
import { brainRecall } from '../lib/brain.mjs';
import { coreMemorySelection, memoryTerms } from '../lib/memory-quality.mjs';
import { sessionSearch } from '../lib/history.mjs';
import { CORPUS_VERSION, FACTS, NOTES, HISTORY, QUERIES } from './retrieval-corpus.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),sha=value=>createHash('sha256').update(value).digest('hex');
const ratio=(count,denominator)=>({count,denominator,rate:denominator?count/denominator:null});
export function scoreRetrieval({retrieved=[],relevant=[],stale=[],excluded=[],k=4}={}) {
  if(!Number.isInteger(k) || k<1 || k>10)throw new Error('Use k from 1 to 10.');
  const ranked=retrieved.slice(0,k),unique=[...new Set(ranked)],wanted=new Set(relevant),hits=unique.filter(id=>wanted.has(id)).length;
  return {returned:ranked.length,hits,relevant:relevant.length,precisionAtK:relevant.length?ratio(hits,k):ratio(0,0),recallAtK:ratio(hits,relevant.length),sourceCorrectness:ratio(hits,ranked.length),staleCandidates:ratio(ranked.filter(id=>stale.includes(id)).length,ranked.length),excludedCandidates:ratio(ranked.filter(id=>excluded.includes(id)).length,ranked.length),duplicates:ranked.length-unique.length,...(!relevant.length?{correctAbstention:ranked.length===0}:{})};
}
export function aggregateRetrieval(rows) {
  const sum=name=>ratio(rows.reduce((n,row)=>n+row.metrics[name].count,0),rows.reduce((n,row)=>n+row.metrics[name].denominator,0));
  const abstentions=rows.filter(row=>row.metrics.correctAbstention!==undefined);
  return {queries:rows.length,precisionAtK:sum('precisionAtK'),recallAtK:sum('recallAtK'),sourceCorrectness:sum('sourceCorrectness'),staleCandidates:sum('staleCandidates'),excludedCandidates:sum('excludedCandidates'),sourceValidity:ratio(rows.reduce((n,row)=>n+row.validSourceCount,0),rows.reduce((n,row)=>n+row.metrics.returned,0)),negativeQueryAbstention:ratio(abstentions.filter(row=>row.metrics.correctAbstention).length,abstentions.length),staleFactUse:null,notice:'Candidate retrieval only. Stale candidates are not measured model use; source validity means a returned ID/version belongs to the scoped fixture, not that its content is current or relevant.'};
}

/** Run current production rankers on public, explicitly labeled local fixtures; no provider, account or network. */
export async function runRetrievalEvaluation({k=4}={}) {
  if(!Number.isInteger(k) || k<1 || k>10)throw new Error('Use k from 1 to 10.');
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-retrieval-')),rows=[],comparatorRows=[];
  const state={messages:{corpus_bot:HISTORY.map(item=>({id:item.id,role:'user',content:item.text,createdAt:`${item.date}T12:00:00.000Z`,...(item.private?{sessionId:'corpus_bot--telegram-other'}:{})}))},sessions:[],rooms:[],routines:[]};
  const context={bot:{id:'corpus_bot'},sessionId:'corpus_bot',runId:'corpus_current'},notesById=new Map();
  try {
    for(const item of NOTES) {
      const relative=`brain/${item.id}`,target=path.join(directory,relative),content=`---\ncreated: ${item.date}\nupdated: ${item.date}\n---\n${item.text}\n`;
      await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,content);await fs.utimes(target,new Date(`${item.date}T12:00:00Z`),new Date(`${item.date}T12:00:00Z`));notesById.set(item.id,{...item,sha256:sha(content)});
    }
    const validIds={facts:new Set(FACTS.map(item=>item.id)),notes:new Set(NOTES.map(item=>item.id)),history:new Set(HISTORY.filter(item=>!item.private).map(item=>item.id))};
    for(const item of QUERIES) {
      const effectiveQuery=memoryTerms(item.query).length<3 && item.previous?`${item.query}\n${item.previous}`:item.query,sources=item.sources || ['facts','notes','history'];
      const ranked={};
      if(sources.includes('facts'))ranked.facts=coreMemorySelection(FACTS,{query:effectiveQuery,limit:k,maxChars:10000}).entries.map(entry=>entry.id);
      if(sources.includes('notes'))ranked.notes=(await brainRecall({root:directory,resolve:safePath},{query:item.query,previous:item.previous || '',limit:k,maxChars:4000})).notes;
      if(sources.includes('history'))ranked.history=sessionSearch(state,context,{query:effectiveQuery.slice(0,500),limit:k}).results.map(entry=>entry.messageId);
      for(const source of sources) {
        const raw=ranked[source],ids=source==='notes'?raw.map(note=>note.path):raw;
        const validSourceCount=source==='notes'?raw.filter(note=>notesById.get(note.path)?.sha256===note.sha256).length:ids.filter(id=>validIds[source].has(id)).length;
        rows.push({queryId:item.id,source,query:item.query,...(item.previous?{previous:item.previous}:{}),effectiveQuery,retrieved:ids,relevant:item.relevant[source] || [],metrics:scoreRetrieval({retrieved:ids,relevant:item.relevant[source] || [],stale:item.stale?.[source],excluded:item.excluded?.[source],k}),validSourceCount});
      }
      if(sources.includes('facts')) {
        // Explicit comparator, not a claim about any shipped historical release: pins, then newest unpinned facts.
        const recent=[...FACTS.filter(entry=>entry.pinned),...FACTS.filter(entry=>!entry.pinned).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))].slice(0,k).map(entry=>entry.id);
        comparatorRows.push({queryId:item.id,source:'facts',retrieved:recent,metrics:scoreRetrieval({retrieved:recent,relevant:item.relevant.facts || [],k}),validSourceCount:recent.length});
      }
    }
    const sourceIdentities=await Promise.all(['eval/retrieval-corpus.mjs','eval/retrieval-runner.mjs','lib/memory-quality.mjs','lib/brain.mjs','lib/history.mjs','lib/sessions.mjs','lib/agent-tools.mjs'].map(async name=>({path:name,sha256:sha(await fs.readFile(path.join(ROOT,name)))})));
    return {schemaVersion:1,corpusVersion:CORPUS_VERSION,corpusSha256:sha(JSON.stringify({FACTS,NOTES,HISTORY,QUERIES})),k,queryCount:QUERIES.length,labels:'Explicit agent-authored public relevance/currentness/scope labels; not inferred from ranking output.',humanReview:{status:'pending',notice:'These fixture labels have not been verified by a human. Human relevance claims require review of the versioned labels.'},sourceIdentities,rows,overall:aggregateRetrieval(rows),bySource:Object.fromEntries(['facts','notes','history'].map(source=>[source,aggregateRetrieval(rows.filter(row=>row.source===source))])),factComparator:{name:'Explicit recency-only comparator: same pins and k, newest unpinned facts; not a historical live release.',rows:comparatorRows,metrics:aggregateRetrieval(comparatorRows)},limitations:['Finite retrieval-candidate measurements only; no model answer, embedding, cost, latency or Grok-quality claim.','Labels are agent-authored fixtures awaiting human review, not a human-validated benchmark.','Precision@k uses fixed k on positive queries; negative labels are measured separately as abstention.','Recall denominator is the explicitly labeled relevant IDs, not all potentially useful knowledge.','Source correctness is relevance of returned IDs; source validity separately checks readable fixture IDs and actual note hashes.','Stale candidate retrieval is observable; stale-fact use by a model remains unknown.','The corpus includes deliberately difficult paraphrases and absent-topic cases; low scores are retained, never tuned away.']};
  }finally{await fs.rm(directory,{recursive:true,force:true});}
}
