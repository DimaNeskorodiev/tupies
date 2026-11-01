import { promises as fs, constants as FS } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensure, atomicWrite } from './store.mjs';
import { brainWrite, brainOverview, BRAIN_LIMITS, splitNote } from './brain.mjs';
import { readText } from './workspace-code.mjs';
import { MANAGED_KNOWLEDGE_FOLDER, KNOWLEDGE_UNIT_ID, knowledgeManifestMatches } from './knowledge-paths.mjs';

export const KNOWLEDGE_LIMITS=Object.freeze({candidates:100,contentChars:12_000,evidence:8,quoteChars:1600,manifestBytes:64_000,planBytes:2_000_000});
const SHA=/^[a-f0-9]{64}$/, ID=/^[a-zA-Z0-9_-]{1,120}$/, PLAN=/^kp-[a-f0-9]{32}$/;
const TYPES=new Set(['principle','fact','scoped-fact','decision-rule','method','example','caveat']);
const queues=new Map();
const hash=value=>createHash('sha256').update(typeof value==='string' || Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const cancelled=signal=>{if(signal?.aborted)throw signal.reason || new Error('Study publication cancelled.');};
const plain=value=>Boolean(value && typeof value==='object' && !Array.isArray(value));
const clone=value=>structuredClone(value);
function text(value,label,max,{optional=false,redact=value=>value}={}) {
  if(optional && (value===undefined || value===null || value===''))return '';
  ensure(typeof value==='string' && value.trim() && value.length<=max && !value.includes('\0'),400,`${label} must contain 1–${max} characters.`);
  return redact(value.trim());
}
function strings(value,label,{max=20,chars=1000,redact}={}) {
  ensure(value===undefined || Array.isArray(value) && value.length<=max,400,`${label} must be a bounded list.`);
  return [...new Set((value || []).map(item=>text(item,label,chars,{redact})))];
}
function redactedData(value,redact,depth=0) {
  ensure(depth<=5,400,'Knowledge metadata is nested too deeply.');
  if(typeof value==='string')return redact(value);
  if(value===null || typeof value==='boolean' || typeof value==='number' && Number.isFinite(value))return value;
  if(Array.isArray(value)){ensure(value.length<=30,400,'Knowledge metadata has too many values.');return value.map(item=>redactedData(item,redact,depth+1));}
  ensure(plain(value) && Object.keys(value).length<=30,400,'Knowledge metadata must be bounded inert data.');
  return Object.fromEntries(Object.entries(value).map(([key,item])=>{ensure(key.length<=100,400,'Knowledge metadata key is too large.');return [redact(key),redactedData(item,redact,depth+1)];}));
}
function scopeValue(value,redact) {
  if(value===undefined)return '';
  ensure(typeof value==='string' || plain(value),400,'Applicability must be text or a structured object.');
  const encoded=JSON.stringify(value);ensure(encoded.length<=3000,400,'Applicability is too large.');
  // JSON roundtrip also limits the durable object to inert data.
  return redactedData(value,redact);
}
function sourceEvidence(candidate,receipts,redact) {
  ensure(Array.isArray(candidate.evidence) && candidate.evidence.length>=1 && candidate.evidence.length<=KNOWLEDGE_LIMITS.evidence,400,'Each knowledge unit needs bounded evidence from admitted source segments.');
  return candidate.evidence.map(item=>{
    ensure(plain(item),400,'Invalid source evidence.');
    const segmentId=item.segmentId ?? item.id,receipt=receipts.get(segmentId);
    ensure(receipt,400,'Knowledge evidence refers to an unknown source segment.');
    const quote=text(item.quote ?? item.excerpt,'Supporting quote',KNOWLEDGE_LIMITS.quoteChars);
    ensure(receipt.text.includes(quote),400,'The supporting quote does not match its admitted source segment.');
    const cleaned=redact(quote);
    return {...receipt.source,segmentId,quote:cleaned,...(cleaned!==quote?{redacted:true}:{})};
  });
}
function receiptMap(values,redact) {
  ensure(Array.isArray(values) && values.length<=20_000,400,'Provide the engine-validated source segment receipts.');
  const map=new Map();
  for(const value of values) {
    ensure(plain(value),400,'Invalid source segment receipt.');
    const segmentId=value.segmentId ?? value.id;
    ensure(typeof segmentId==='string' && ID.test(segmentId) && !map.has(segmentId),400,'Source segment IDs must be unique engine identities.');
    const sourceId=text(value.sourceId,'Source identity',120),sourceDigest=value.sourceDigest ?? value.digest;
    ensure(SHA.test(sourceDigest || ''),400,'Source receipts need the admitted content digest.');
    const sourceText=value.text ?? value.content;
    ensure(typeof sourceText==='string' && sourceText.length<=1_000_000 && !sourceText.includes('\0'),400,'A source segment must contain bounded extracted text.');
    let locator=value.locator;
    if(locator===undefined)locator={...(value.pageStart===undefined?{}:{pageStart:value.pageStart}),...(value.pageEnd===undefined?{}:{pageEnd:value.pageEnd}),...(value.startSeconds===undefined?{}:{startSeconds:value.startSeconds}),...(value.endSeconds===undefined?{}:{endSeconds:value.endSeconds})};
    ensure((typeof locator==='string' && locator.trim() || plain(locator) && Object.keys(locator).length) && JSON.stringify(locator).length<=1000,400,'Source segments need an engine-supplied page, heading or time locator.');
    const source={sourceId:redact(sourceId),sourceDigest,title:text(value.title || sourceId,'Source title',300,{redact}),locator:redactedData(locator,redact)};
    for(const key of ['url','filename','publicationDate','edition'])if(value[key]!==undefined)source[key]=text(value[key],`Source ${key}`,key==='url'?2000:300,{redact});
    map.set(segmentId,{text:sourceText,source});
  }
  return map;
}
function normalizeCandidate(value,receipts,redact) {
  ensure(plain(value),400,'Knowledge candidates must be objects.');
  const type=value.type || 'principle';ensure(TYPES.has(type),400,'Unsupported knowledge unit type.');
  const unit={type,title:text(value.title,'Knowledge title',180,{redact}),content:text(value.content ?? value.explanation,'Knowledge explanation',KNOWLEDGE_LIMITS.contentChars,{redact}),reason:text(value.reason ?? value.usefulness,'Role relevance',1500,{redact}),scope:scopeValue(value.scope ?? value.applicability,redact),conditions:strings(value.conditions,'Conditions',{redact}),exceptions:strings(value.exceptions,'Exceptions',{redact}),aliases:strings(value.aliases,'Aliases',{max:10,chars:100,redact}),support:value.support || 'direct',status:value.status || 'active',evidence:sourceEvidence(value,receipts,redact)};
  ensure(['direct','synthesis','inference'].includes(unit.support),400,'Specify whether the knowledge is supported, synthesized or inferred.');
  ensure(['active','disputed'].includes(unit.status),400,'New knowledge must be active or explicitly disputed.');
  if(value.relations!==undefined){ensure(Array.isArray(value.relations)&&value.relations.length<=20,400,'Knowledge relations must be bounded.');unit.relations=value.relations.map(item=>{ensure(plain(item)&&['conflicts-with','supplements','scoped-alternative'].includes(item.kind)&&KNOWLEDGE_UNIT_ID.test(item.unitId||'')&&(item.sha256===undefined||SHA.test(item.sha256))&&(item.revision===undefined||Number.isSafeInteger(item.revision)&&item.revision>=1),400,'Knowledge relations need verified unit identities.');return {kind:item.kind,unitId:item.unitId,...(item.sha256?{sha256:item.sha256}:{}),...(item.revision?{revision:item.revision}:{})};});}
  if(type==='method') {
    const method=value.method || value;
    unit.method={inputs:strings(method.inputs,'Method inputs',{redact}),steps:strings(method.steps,'Method steps',{max:30,redact}),outputs:strings(method.outputs,'Method outputs',{redact}),checks:strings(method.checks,'Method checks',{redact}),verification:'source-derived-untested'};
    ensure(unit.method.steps.length && unit.method.checks.length,400,'A method needs ordered steps and verification checks.');
  }
  if(type==='example'){unit.outcome=value.outcome || 'reported';ensure(['reported','hypothetical','observed'].includes(unit.outcome),400,'Specify the example outcome provenance.');ensure(unit.outcome!=='observed',400,'Source material alone cannot establish an outcome observed by Tupies.');}
  return unit;
}
function coalesceCandidates(values){
  const unique=new Map();
  for(const value of values){const key=value.candidate.targetId||knowledgeUnitId(value.unit),previous=unique.get(key);if(!previous){unique.set(key,value);continue;}
    const core=unit=>{const {evidence,reason,aliases,...rest}=unit;return rest;};
    ensure(hash(core(previous.unit))===hash(core(value.unit))&&previous.candidate.expectedSha256===value.candidate.expectedSha256,409,'Repeated knowledge has conflicting applicability or method details. Review it before publication.');
    previous.unit.evidence=[...new Map([...previous.unit.evidence,...value.unit.evidence].map(item=>[hash(item),item])).values()].slice(0,KNOWLEDGE_LIMITS.evidence);
    previous.unit.aliases=[...new Set([...previous.unit.aliases,...value.unit.aliases])].slice(0,10);
  }
  return [...unique.values()];
}
export function knowledgeUnitId(unit) {
  return `unit-${hash({type:unit.type,title:unit.title,content:unit.content,scope:unit.scope,conditions:unit.conditions,exceptions:unit.exceptions,...(unit.method?{method:unit.method}:{}),...(unit.outcome?{outcome:unit.outcome}:{})}).slice(0,32)}`;
}
export function renderKnowledgeUnit(unit,{unitId,revision,operationId}) {
  const list=values=>values.length?values.map(value=>`- ${value}`).join('\n'):'- None identified; do not infer universal applicability.';
  const lines=[`# ${unit.title}`,`<!-- tupies-knowledge-operation:${operationId} -->`,`Knowledge ID: ${unitId}; revision ${revision}. Status: ${unit.status}.`,`## Knowledge`,unit.content,`## Why this helps`,unit.reason,`## Applicability`,typeof unit.scope==='string'?unit.scope || 'Scope not further specified.':JSON.stringify(unit.scope),`## Conditions`,list(unit.conditions),`## Exceptions`,list(unit.exceptions),`Support: ${unit.support}. Source support does not establish project applicability or a measured result.`];
  if(unit.method)for(const [key,label] of [['inputs','Inputs'],['steps','Steps'],['outputs','Expected outputs'],['checks','Checks']])lines.push(`## ${label}`,key==='steps'?unit.method[key].map((item,index)=>`${index+1}. ${item}`).join('\n'):list(unit.method[key]));
  if(unit.method)lines.push('Method verification: source-derived and untested in Tupies.');
  if(unit.outcome)lines.push(`Example outcome: ${unit.outcome}.`);
  if(unit.relations?.length)lines.push('## Related knowledge',...unit.relations.map(item=>`- ${item.kind}: [[tupies-managed-knowledge/${item.unitId}]]${item.revision?` (source revision ${item.revision})`:''}. Linked knowledge must be read in its current scope and revision.`));
  lines.push('## Sources and bounded evidence');
  for(const evidence of unit.evidence)lines.push(`- ${evidence.title} (${evidence.sourceId}; segment ${evidence.segmentId}; ${typeof evidence.locator==='string'?evidence.locator:JSON.stringify(evidence.locator)}; content SHA-256 ${evidence.sourceDigest}).${evidence.url?` Source URL: ${evidence.url}`:''}`,`> ${evidence.quote.replace(/\n/g,'\n> ')}`);
  lines.push('Only the selected knowledge and bounded evidence are retained here. An original may be unavailable; its digest is an identity, not proof of truth or a readable copy.');
  return `${lines.join('\n\n')}\n`;
}

async function serial(key,fn) {
  const previous=queues.get(key) || Promise.resolve(),job=previous.catch(()=>{}).then(fn);queues.set(key,job);
  try{return await job;}finally{if(queues.get(key)===job)queues.delete(key);}
}
async function maybeText(context,relative) {
  try{return await readText(context,relative);}catch(error){if(error.status===404 || error.code==='ENOENT')return null;throw error;}
}
function planView(plan) {
  return {id:plan.id,botId:plan.botId,jobId:plan.jobId,status:plan.status,approvalDigest:plan.approvalDigest,requiresApproval:Boolean(plan.approvalRequired && plan.actions.length),createdAt:plan.createdAt,completedAt:plan.completedAt,rollbackOf:plan.rollbackOf,unitCount:plan.actions.length,committedCount:plan.actions.filter(action=>action.status==='committed').length,units:plan.actions.map(action=>({id:action.unitId,path:action.args.path,title:action.unit.title,status:action.status,revision:action.revision})),actions:plan.actions.map(action=>({operationId:action.operationId,unitId:action.unitId,tool:action.kind==='deactivate'?'knowledge_deactivate':'brain_write',args:clone(action.args),status:action.status,noteSha256:action.receipt?.noteSha256})),duplicates:plan.duplicates || [],error:plan.error};
}

export class KnowledgeService {
  constructor(store){this.store=store;}
  async context(botId,signal) {
    ensure(typeof botId==='string' && ID.test(botId),400,'Invalid bot identity.');
    const bot=this.store.state.bots.find(item=>item.id===botId);ensure(bot,404,'Bot not found.');
    const {getWorkspaceRoot,safePath}=await import('./agent-tools.mjs');
    return {root:await getWorkspaceRoot(this.store,botId),resolve:safePath,signal,redact:value=>this.store.redact(value),bot};
  }
  async local(relative,{parents=false,missing=false}={}) {
    const {safePath}=await import('./agent-tools.mjs'),base=path.join(this.store.directory,'knowledge');
    await fs.mkdir(base,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    ensure((await fs.lstat(base)).isDirectory() && !(await fs.lstat(base)).isSymbolicLink(),400,'Knowledge storage must be a private real directory.');
    return safePath(base,relative,{createParents:parents,allowMissing:missing});
  }
  async load(id) {
    ensure(PLAN.test(id || ''),400,'Invalid publication plan identity.');
    const file=await this.local(`plans/${id}.json`),handle=await fs.open(file,FS.O_RDONLY | (FS.O_NOFOLLOW || 0));
    try{const stat=await handle.stat();ensure(stat.isFile() && stat.size<=KNOWLEDGE_LIMITS.planBytes,413,'Publication journal is too large.');const plan=JSON.parse(await handle.readFile('utf8'));ensure(plan.id===id && this.digest(plan)===plan.approvalDigest,409,'Publication plan identity changed.');return plan;}finally{await handle.close();}
  }
  digest(plan){return hash({schema:plan.schema,id:plan.id,botId:plan.botId,jobId:plan.jobId,rollbackOf:plan.rollbackOf,approvalRequired:plan.approvalRequired,memoryEnabled:plan.memoryEnabled,...(plan.readSet?.length?{readSet:plan.readSet}:{}),actions:plan.actions.map(({operationId,unitId,kind,args,unit,revision,before})=>({operationId,unitId,kind,args,unit,revision,before}))});}
  access(plan,approvedDigest) {
    const bot=this.store.state.bots.find(item=>item.id===plan.botId);ensure(bot,404,'Bot not found.');
    if(!plan.actions.length)return;
    ensure(plan.memoryEnabled && (!Array.isArray(bot.tools) || bot.tools.includes('memory')),403,'Enable Memory tools to publish knowledge.');
    if(plan.approvalRequired || bot.approvalPolicy==='strict')ensure(approvedDigest===plan.approvalDigest,403,'Strict publication needs approval of this exact concrete publication preview.');
    if(approvedDigest!==undefined)ensure(approvedDigest===plan.approvalDigest,409,'Publication approval does not match the current preview.');
  }
  async save(plan) {
    const data=JSON.stringify(plan);ensure(Buffer.byteLength(data)<=KNOWLEDGE_LIMITS.planBytes,413,'Publication batch exceeds the journal limit.');
    await atomicWrite(await this.local(`plans/${plan.id}.json`,{parents:true,missing:true}),data);
  }
  async state(context,unitId) {
    ensure(KNOWLEDGE_UNIT_ID.test(unitId || ''),400,'Invalid managed knowledge identity.');
    const relative=`${MANAGED_KNOWLEDGE_FOLDER}/${unitId}.md`,note=await maybeText(context,`brain/${relative}`),manifestRead=await maybeText(context,`brain/${MANAGED_KNOWLEDGE_FOLDER}/${unitId}.manifest.json`);
    let manifest=null;if(manifestRead){ensure(manifestRead.size<=KNOWLEDGE_LIMITS.manifestBytes,413,'Knowledge manifest exceeds its limit.');try{manifest=JSON.parse(manifestRead.content);}catch{ensure(false,409,'Managed knowledge has a malformed manifest.');}}
    return {relative,note,manifestRead,manifest,active:Boolean(note && knowledgeManifestMatches(manifest,relative,note.sha256,context.bot.id))};
  }
  async prepare(botId,jobId,candidates,{sourceReceipts=[],readSet=[],signal}={}) {
    ensure(typeof jobId==='string' && ID.test(jobId),400,'Invalid study job identity.');
    ensure(Array.isArray(candidates) && candidates.length<=KNOWLEDGE_LIMITS.candidates,400,`Publish at most ${KNOWLEDGE_LIMITS.candidates} candidates in one batch.`);
    return serial(`${this.store.directory}:${botId}`,async()=>{
      const context=await this.context(botId,signal),receipts=receiptMap(sourceReceipts,context.redact),normalized=coalesceCandidates(candidates.map(value=>({candidate:value,unit:normalizeCandidate(value,receipts,context.redact)})));
      ensure(Array.isArray(readSet)&&readSet.length<=2000&&readSet.every(item=>plain(item)&&KNOWLEDGE_UNIT_ID.test(item.unitId||'')&&SHA.test(item.sha256||'')&&Number.isSafeInteger(item.revision)&&item.revision>=1)&&new Set(readSet.map(item=>item.unitId)).size===readSet.length,400,'Reconciliation references must be bounded verified revisions.');
      readSet=readSet.map(({unitId,sha256,revision})=>({unitId,sha256,revision}));await this.checkReadSet(context,{readSet,actions:[]});
      const id=`kp-${hash({botId,jobId,normalized,...(readSet.length?{readSet}:{})}).slice(0,32)}`;
      const existing=await this.load(id).catch(error=>{if(error.status===404 || error.code==='ENOENT')return null;throw error;});
      if(existing)return planView(existing);
      const plan={schema:1,id,botId,jobId,status:'prepared',approvalRequired:context.bot.approvalPolicy==='strict',memoryEnabled:!Array.isArray(context.bot.tools) || context.bot.tools.includes('memory'),createdAt:new Date().toISOString(),...(readSet.length?{readSet}:{}),actions:[],duplicates:[]},seen=new Set();let newBytes=0,newNotes=0;
      for(const {candidate,unit} of normalized) {
        cancelled(signal);
        const unitId=candidate.targetId || knowledgeUnitId(unit);ensure(!seen.has(unitId),400,'A publication batch may change each knowledge unit only once.');seen.add(unitId);
        const current=await this.state(context,unitId);
        if(!candidate.targetId && current.active && hash({...current.manifest.unit,evidence:[]})===hash({...unit,evidence:[]})){plan.duplicates.push(unitId);continue;}
        if(current.note || current.manifestRead) {
          const withdrawn=!candidate.targetId&&current.manifest?.status==='superseded'&&current.note&&knowledgeManifestMatches({...current.manifest,status:'active'},current.relative,current.note.sha256,botId);
          ensure(candidate.targetId&&current.active||withdrawn,409,'A managed knowledge identity already exists or is unavailable; inspect it before merging.');
          if(!withdrawn)ensure(candidate.expectedSha256===current.note.sha256,409,'Knowledge changed since it was read. Recompute this merge.');
        } else ensure(!candidate.targetId && candidate.expectedSha256===undefined,409,'The knowledge being updated no longer exists.');
        const revision=(current.manifest?.revision || 0)+1,operationId=`op-${hash(`${id}:${unitId}`).slice(0,32)}`,content=renderKnowledgeUnit(unit,{unitId,revision,operationId});
        const args={path:current.relative,content,type:'knowledge',tags:['knowledge',unit.type],aliases:unit.aliases,...(current.note?{expectedSha256:current.note.sha256}:{})};
        const before={noteSha256:current.note?.sha256 || null,manifestSha256:current.manifestRead?.sha256 || null,manifest:current.manifest};
        plan.actions.push({operationId,unitId,kind:'write',args,unit,revision,before,status:'pending'});newNotes+=Number(!current.note);newBytes+=Math.max(0,Buffer.byteLength(content)+500-(current.note?.size || 0));
      }
      const overview=await brainOverview(context);
      ensure(!overview.truncated && !overview.skipped && overview.total+newNotes<=BRAIN_LIMITS.notes,413,'Brain capacity is unavailable; publish fewer units or reorganize notes first.');
      const inventory=await this.brainBytes(context);ensure(inventory+newBytes<=BRAIN_LIMITS.indexedBytes,413,'Knowledge would exceed the Brain indexed-byte limit.');
      plan.approvalDigest=this.digest(plan);await this.save(plan);return planView(plan);
    });
  }
  async brainBytes(context) {
    let bytes=0;const walk=async(relative,depth=0)=>{if(depth>8)return;let folder;try{folder=await context.resolve(context.root,relative);}catch(error){if(error.status===404)return;throw error;}for(const entry of await fs.readdir(folder,{withFileTypes:true})){if(entry.name.startsWith('.') || entry.isSymbolicLink())continue;const next=`${relative}/${entry.name}`;if(entry.isDirectory())await walk(next,depth+1);else if(entry.isFile() && entry.name.endsWith('.md'))bytes+=(await fs.lstat(await context.resolve(context.root,next))).size;}};await walk('brain');return bytes;
  }
  async readPlan(plan){return planView(await this.load(typeof plan==='string'?plan:plan?.id));}
  async checkReadSet(context,plan){for(const reference of plan.readSet||[]){cancelled(context.signal);const current=await this.state(context,reference.unitId);if(current.active&&current.note.sha256===reference.sha256&&current.manifest.revision===reference.revision)continue;const action=plan.actions.find(item=>item.unitId===reference.unitId),staged=action?.kind==='write'&&action.status==='writing'&&action.before.noteSha256===reference.sha256&&current.manifestRead?.sha256===action.before.manifestSha256&&current.note&&splitNote(current.note.content).body===action.args.content;ensure(staged||current.active&&action&&current.manifest.planId===plan.id&&current.manifest.operationId===action.operationId&&current.note.sha256===current.manifest.noteSha256,409,'Knowledge used for reconciliation changed; recompute the comparison before publication.');}}
  async publish(input,{approvedDigest,signal,guard}={}) {
    const id=typeof input==='string'?input:input?.id,initial=await this.load(id);
    if(typeof input==='object')ensure(input.approvalDigest===initial.approvalDigest,409,'The concrete publication preview changed.');
    return serial(`${this.store.directory}:${initial.botId}`,async()=>{
      const plan=await this.load(id),context=await this.context(plan.botId,signal);
      this.access(plan,approvedDigest);
      try {
        if(!plan.actions.length)await guard?.();await this.checkReadSet(context,plan);
        plan.status='publishing';await this.save(plan);
        for(const action of plan.actions){cancelled(signal);await guard?.();await this.checkReadSet(context,plan);this.access(plan,approvedDigest);await this.commit(context,plan,action,()=>this.access(plan,approvedDigest));}
        for(const action of plan.actions){const current=await this.state(context,action.unitId);ensure(current.note?.sha256===action.receipt.noteSha256 && current.manifestRead?.sha256===action.receipt.manifestSha256,409,'Knowledge changed before final publication verification.');}
        cancelled(signal);await this.checkReadSet(context,plan);plan.status='completed';plan.completedAt=new Date().toISOString();delete plan.error;await this.save(plan);return planView(plan);
      } catch(error) {plan.status=signal?.aborted?'stopped':'partial';plan.error=context.redact(String(error.message)).slice(0,500);await this.save(plan);error.knowledge=planView(plan);throw error;}
    });
  }
  async commit(context,plan,action,access=()=>{}) {
    let current=await this.state(context,action.unitId);
    if(action.status==='committed'){ensure(current.note?.sha256===action.receipt.noteSha256 && current.manifestRead?.sha256===action.receipt.manifestSha256,409,'A committed knowledge revision changed; do not replay it.');return;}
    const recovery=current.manifest?.planId===plan.id && current.manifest?.operationId===action.operationId;
    if(recovery){ensure(current.note && current.manifest.noteSha256===current.note.sha256,409,'A partially published note changed.');action.receipt={noteSha256:current.note.sha256,manifestSha256:current.manifestRead.sha256};action.status='committed';await this.save(plan);return;}
    ensure((current.manifestRead?.sha256 || null)===action.before.manifestSha256,409,'Knowledge manifest changed since the merge preview.');
    const recoveringWrite=action.kind==='write' && current.note && splitNote(current.note.content).body===action.args.content;
    ensure(recoveringWrite || (current.note?.sha256 || null)===action.before.noteSha256,409,'Knowledge changed since the merge preview; newer edits are preserved.');
    if(action.status==='pending') {
      // Full old bytes stay engine-local, outside the search/sync roots.
      if(current.note && !recoveringWrite)await atomicWrite(await this.local(`revisions/${plan.botId}/${action.unitId}/${action.before.noteSha256}.md`,{parents:true,missing:true}),current.note.content);
      action.status='writing';await this.save(plan);
    }
    access();if(action.kind==='write' && !recoveringWrite)await brainWrite(context,action.args);
    current=await this.state(context,action.unitId);ensure(current.note,409,'The publication note is missing.');
    if(action.kind==='write')ensure(splitNote(current.note.content).body===action.args.content,409,'The note changed during publication.');
    const noteHash=current.note.sha256;
    const manifest={schema:1,botId:plan.botId,unitId:action.unitId,path:current.relative,revision:action.revision,status:action.kind==='deactivate'?'superseded':'active',noteSha256:noteHash,planId:plan.id,jobId:plan.jobId,operationId:action.operationId,publishedAt:new Date().toISOString(),unit:action.unit,previousRevision:action.before.manifest?.revision || null};
    const data=JSON.stringify(manifest);ensure(Buffer.byteLength(data)<=KNOWLEDGE_LIMITS.manifestBytes,413,'Knowledge evidence exceeds its manifest limit.');
    cancelled(context.signal);
    const latest=await this.state(context,action.unitId);ensure(latest.note?.sha256===noteHash && (latest.manifestRead?.sha256 || null)===action.before.manifestSha256,409,'Knowledge changed before activation.');
    access();const file=await context.resolve(context.root,`brain/${MANAGED_KNOWLEDGE_FOLDER}/${action.unitId}.manifest.json`,{createParents:true,allowMissing:true});await atomicWrite(file,data);
    const verified=await this.state(context,action.unitId);ensure(verified.note?.sha256===noteHash && verified.manifestRead?.sha256===hash(data),409,'Publication verification failed.');
    action.status='committed';action.receipt={noteSha256:noteHash,manifestSha256:hash(data)};await this.save(plan);
  }
  async list(botId,{includeInactive=false,signal}={}) {
    const context=await this.context(botId,signal);let folder;try{folder=await context.resolve(context.root,`brain/${MANAGED_KNOWLEDGE_FOLDER}`);}catch(error){if(error.status===404)return {units:[],total:0};throw error;}
    const units=[];for(const entry of (await fs.readdir(folder,{withFileTypes:true})).slice(0,BRAIN_LIMITS.entries)){cancelled(signal);const id=entry.name.match(/^(unit-[a-f0-9]{32})\.manifest\.json$/)?.[1];if(!id || !entry.isFile() || entry.isSymbolicLink())continue;const current=await this.state(context,id);if(!current.manifest || !includeInactive && !current.active)continue;units.push({id,path:current.relative,revision:current.manifest.revision,status:current.active?current.manifest.unit?.status || 'active':'unavailable',sha256:current.note?.sha256,title:current.manifest.unit?.title,unit:current.manifest.unit});}
    return {units,total:units.length};
  }
  async read(botId,unitId,{signal}={}) {
    const current=await this.state(await this.context(botId,signal),unitId);ensure(current.active,404,'Managed knowledge is unavailable or has changed.');
    return {id:unitId,path:current.relative,sha256:current.note.sha256,revision:current.manifest.revision,content:current.note.content,unit:clone(current.manifest.unit),manifest:clone(current.manifest)};
  }
  async batches(botId) {
    await this.context(botId);let folder;try{folder=await this.local('plans');}catch(error){if(error.status===404)return {batches:[]};throw error;}
    const batches=[];for(const name of (await fs.readdir(folder)).slice(0,2000)){const id=name.replace(/\.json$/,'');if(!PLAN.test(id))continue;const plan=await this.load(id);if(plan.botId===botId)batches.push(planView(plan));}return {batches:batches.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};
  }
  async prepareRollback(botId,batchId,{signal}={}) {
    return serial(`${this.store.directory}:${botId}`,async()=>{
      const original=await this.load(batchId);ensure(original.botId===botId,404,'Knowledge batch not found for this bot.');
      ensure(original.actions.some(action=>action.status==='committed'),409,'This batch has no committed knowledge to revert.');
      const id=`kp-${hash(`rollback:${batchId}`).slice(0,32)}`,existing=await this.load(id).catch(error=>{if(error.status===404 || error.code==='ENOENT')return null;throw error;});if(existing)return planView(existing);
      const context=await this.context(botId,signal),plan={schema:1,id,botId,jobId:`rollback-${batchId}`,rollbackOf:batchId,status:'prepared',approvalRequired:context.bot.approvalPolicy==='strict',memoryEnabled:!Array.isArray(context.bot.tools) || context.bot.tools.includes('memory'),createdAt:new Date().toISOString(),actions:[],duplicates:[]};
      for(const previous of [...original.actions].reverse()) {
        if(previous.status!=='committed')continue;cancelled(signal);const current=await this.state(context,previous.unitId);
        ensure(current.note?.sha256===previous.receipt.noteSha256 && current.manifestRead?.sha256===previous.receipt.manifestSha256,409,'Newer knowledge or owner edits prevent this rollback.');
        const unit=previous.before.manifest?.unit || previous.unit,revision=current.manifest.revision+1,operationId=`op-${hash(`${id}:${previous.unitId}`).slice(0,32)}`,kind=previous.before.manifest?'write':'deactivate';
        const args=kind==='write'?{path:current.relative,content:renderKnowledgeUnit(unit,{unitId:previous.unitId,revision,operationId}),expectedSha256:current.note.sha256,type:'knowledge',tags:['knowledge',unit.type],aliases:unit.aliases}:{path:current.relative,expectedSha256:current.note.sha256,status:'superseded'};
        plan.actions.push({operationId,unitId:previous.unitId,kind,args,unit,revision,before:{noteSha256:current.note.sha256,manifestSha256:current.manifestRead.sha256,manifest:current.manifest},status:'pending'});
      }
      plan.approvalDigest=this.digest(plan);await this.save(plan);return planView(plan);
    });
  }
  async rollback(botId,batchId,options={}){const plan=await this.prepareRollback(botId,batchId,options);if((plan.requiresApproval || (await this.context(botId)).bot.approvalPolicy==='strict') && !options.approvedDigest)return {...plan,requiresApproval:true};return this.publish(plan,options);}
}
