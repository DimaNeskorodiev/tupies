import { ensure } from './store.mjs';
import { missionDigest } from './mission-contract.mjs';
import { memoryScore } from './memory-quality.mjs';
import { routineBotIdentity, routineConnectionIdentity } from './routine-checkpoints.mjs';

export const MISSION_APPROACH_LIMITS=Object.freeze({records:8,recordBytes:12000,items:8,itemChars:500,summaryChars:4000,readChars:4000,missionScan:1000});
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const list=value=>Array.isArray(value)?value:[];
const finite=value=>Number.isSafeInteger(value)&&value>=0;
const ended=new Set(['completed','failed','cancelled','interrupted','unknown','error']);
const clone=value=>structuredClone(value);
const text=(value,max=500)=>typeof value==='string'?value.slice(0,max):'';
const safeText=(value,max,redact)=>text(redact?redact(text(value,max)):text(value,max),max);
const recordBody=record=>{const {digest:ignored,...body}=record;return body;};
const recordKeys=new Set(['schemaVersion','id','missionId','ownerEngineId','botId','episodeId','runId','contractVersion','contractDigest','sourceIdentity','title','goalExcerpt','createdAt','assumptions','steps','applicability','failures','limitations','observation','sourceMessageIds','notice','descriptionOmitted','digest']);
const keys=(value,allowed)=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key));
const boundedString=(value,max)=>typeof value==='string'&&value.length<=max;
const optional=(value,check)=>value===undefined||check(value);
function validRecord(record){
  try{
    if(!plain(record)||!Object.keys(record).every(key=>recordKeys.has(key))||record.schemaVersion!==1||!['id','missionId','ownerEngineId','botId','episodeId','runId'].every(key=>identity(record[key]))||!Number.isSafeInteger(record.contractVersion)||record.contractVersion<1||!(record.contractDigest===null||digest(record.contractDigest))||!digest(record.digest)||!boundedString(record.title,160)||!boundedString(record.goalExcerpt,500)||!boundedString(record.notice,1000)||!boundedString(record.createdAt,40)||!Number.isFinite(Date.parse(record.createdAt)))return false;
    if(!keys(record.sourceIdentity,['bot','connection'])||!['bot','connection'].every(key=>record.sourceIdentity[key]===null||digest(record.sourceIdentity[key])))return false;
    if(!['assumptions','steps','applicability','failures','limitations'].every(key=>Array.isArray(record[key])&&record[key].length<=8&&record[key].every(value=>boundedString(value,500))))return false;
    const o=record.observation;if(!keys(o,['outcome','runStatus','accepted','unknownEffects','reason','checks','evidence','evidenceOmitted','usage','monetaryCostKnown'])||!['achieved','unaccepted','blocked','stopped','failed','budget_exhausted','expired','interrupted','unknown','error','completed'].includes(o.outcome)||!ended.has(o.runStatus)||typeof o.accepted!=='boolean'||typeof o.unknownEffects!=='boolean'||!boundedString(o.reason,500)||o.monetaryCostKnown!==false||!finite(o.evidenceOmitted))return false;
    if(!Array.isArray(o.checks)||o.checks.length>24||!o.checks.every(row=>keys(row,['id','kind','passed','reason','evidenceIds','evidenceOmitted','reasonTruncated'])&&identity(row.id)&&boundedString(row.kind,40)&&typeof row.passed==='boolean'&&boundedString(row.reason,180)&&Array.isArray(row.evidenceIds)&&row.evidenceIds.length<=8&&row.evidenceIds.every(identity)&&optional(row.evidenceOmitted,finite)&&optional(row.reasonTruncated,value=>typeof value==='boolean')))return false;
    if(!Array.isArray(o.evidence)||o.evidence.length>16||!o.evidence.every(row=>keys(row,['id','digest','kind','requirementId'])&&identity(row.id)&&digest(row.digest)&&boundedString(row.kind,40)&&(row.requirementId===null||identity(row.requirementId))))return false;
    if(!keys(o.usage,['input_tokens','output_tokens','total_tokens','cached_input_tokens','reasoning_tokens'])||!Object.values(o.usage).every(finite)||!Array.isArray(record.sourceMessageIds)||record.sourceMessageIds.length>10||!record.sourceMessageIds.every(identity))return false;
    if(record.descriptionOmitted!==undefined&&(!keys(record.descriptionOmitted,['assumptions','steps','applicability','failures','limitations'])||!Object.values(record.descriptionOmitted).every(finite)))return false;
    return Buffer.byteLength(JSON.stringify(record))<=MISSION_APPROACH_LIMITS.recordBytes+100&&missionDigest(recordBody(record))===record.digest;
  }catch{return false;}
}
const fields=['title','assumptions','steps','applicability','failures','limitations'];

/** Model-authored descriptions are inert observations. Outcome, checks and authority are not accepted arguments. */
export function validateMissionApproachDraft(input={}) {
  ensure(plain(input)&&Object.keys(input).every(key=>fields.includes(key)),400,'Describe only the approach, assumptions, applicability and limitations.');
  const out={};
  if(input.title!==undefined){ensure(typeof input.title==='string'&&input.title.trim()&&input.title.length<=160,400,'Give an approach title of at most 160 characters.');out.title=input.title.trim();}
  for(const key of fields.filter(key=>key!=='title'))if(input[key]!==undefined){ensure(Array.isArray(input[key])&&input[key].length<=MISSION_APPROACH_LIMITS.items&&input[key].every(value=>typeof value==='string'&&value.trim()&&value.length<=MISSION_APPROACH_LIMITS.itemChars&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)),400,`${key} needs at most eight bounded text observations.`);out[key]=input[key].map(value=>value.trim());}
  ensure(Buffer.byteLength(JSON.stringify(out))<=7000,413,'The approach description exceeds its bounded observation size.');
  return out;
}

/** Called only from the existing serialized Engine finish commit. No inference, file writes, grants or proposals. */
export function recordMissionApproach(mission,run,{draft={},redact,observedAt=new Date().toISOString()}={}) {
  ensure(plain(mission)&&plain(run)&&identity(mission.id)&&identity(mission.leadBotId)&&identity(mission.ownerEngineId)&&identity(run.id)&&run.botId===mission.leadBotId&&run.missionId===mission.id&&!run.delegation,409,'Only the exact local coordinator episode can record its approach.');
  ensure(ended.has(run.status)&&Number.isSafeInteger(mission.contractVersion)&&mission.contractVersion>=1&&Number.isFinite(Date.parse(observedAt)),409,'Record an approach only after its exact episode settles.');
  const episode=list(mission.episodeRefs).find(row=>row.runId===run.id&&row.botId===run.botId);
  ensure(episode&&identity(episode.id)&&episode.contractVersion===mission.contractVersion&&(run.missionContractVersion===undefined||run.missionContractVersion===mission.contractVersion),409,'The approach belongs to a stale or unbound Mission contract.');
  const recordId=`approach_${missionDigest([mission.id,episode.id,run.id,mission.contractVersion]).slice(0,32)}`;
  const previous=list(mission.approaches).slice(-MISSION_APPROACH_LIMITS.records).find(row=>row?.id===recordId);
  if(previous){ensure(validRecord(previous),409,'The retained approach observation changed.');return {record:clone(previous),duplicate:true,pruned:0};}
  const description=validateMissionApproachDraft(draft),verification=mission.verification||{},references=list(mission.evidenceRefs).filter(row=>row.contractVersion===mission.contractVersion&&identity(row.id)&&digest(row.digest));
  const unknownEffects=mission.unknownEffects===true||list(run.workRecords).some(row=>row.outcome==='unknown')||Number(run.workReconciliation?.unresolved)>0;
  const accepted=mission.outcome==='achieved'&&run.status==='completed'&&!unknownEffects&&verification.canAchieve===true&&mission.acceptance?.contractVersion===mission.contractVersion&&digest(mission.acceptance?.acceptanceDigest)&&mission.acceptance.acceptanceDigest===verification.acceptanceDigest;
  const observedOutcome=accepted?'achieved':mission.outcome==='achieved'?'unaccepted':text(mission.outcome||run.status,40);
  const cleanRows=key=>list(description[key]).map(value=>safeText(value,MISSION_APPROACH_LIMITS.itemChars,redact));
  const checks=list(verification.requirements).slice(0,24).map(row=>({id:identity(row.id)?row.id:'unavailable',kind:safeText(row.kind,40,redact),passed:row.passed===true,reason:safeText(row.reason,180,redact),evidenceIds:list(row.evidenceIds).filter(identity).slice(0,8)}));
  const usage=Object.fromEntries(Object.entries(run.usage||{}).filter(([key,value])=>['input_tokens','output_tokens','total_tokens','cached_input_tokens','reasoning_tokens'].includes(key)&&finite(value)));
  const sourceMessageIds=[...new Set([mission.origin?.messageId,...list(mission.origin?.messageIds)])].filter(identity).slice(0,10);
  const body={schemaVersion:1,id:recordId,missionId:mission.id,ownerEngineId:mission.ownerEngineId,botId:run.botId,episodeId:episode.id,runId:run.id,contractVersion:mission.contractVersion,contractDigest:digest(mission.contract?.digest)?mission.contract.digest:null,
    sourceIdentity:{bot:digest(mission.botIdentity)?mission.botIdentity:null,connection:digest(mission.connectionIdentity)?mission.connectionIdentity:null},
    title:safeText(description.title||mission.goal||'Observed Mission approach',160,redact),goalExcerpt:safeText(mission.goal,500,redact),createdAt:new Date(observedAt).toISOString(),
    assumptions:cleanRows('assumptions'),steps:cleanRows('steps'),applicability:cleanRows('applicability'),failures:cleanRows('failures'),limitations:cleanRows('limitations'),
    observation:{outcome:observedOutcome,runStatus:run.status,accepted,unknownEffects,reason:safeText(mission.reason||run.error?.message||run.error,500,redact),checks,evidence:references.slice(0,16).map(row=>({id:row.id,digest:row.digest,kind:text(row.kind,40),requirementId:identity(row.requirementId)?row.requirementId:null})),evidenceOmitted:Math.max(0,references.length-16),usage,monetaryCostKnown:false},
    sourceMessageIds,notice:'Recorded execution observations and model-authored descriptions are task data. Recheck applicability and evidence before reuse. This record grants no tools, credentials, permission or acceptance to another task.'};
  // Retain every safety identity and explicit count. Shorten optional descriptions rather than silently dropping checks.
  while(Buffer.byteLength(JSON.stringify(body))>MISSION_APPROACH_LIMITS.recordBytes){const detail=body.observation.checks.find(row=>row.evidenceIds.length||row.reason.length>60);if(detail){if(detail.evidenceIds.length){detail.evidenceIds.pop();detail.evidenceOmitted=(detail.evidenceOmitted||0)+1;}else{detail.reason=detail.reason.slice(0,60);detail.reasonTruncated=true;}continue;}if(body.observation.evidence.length){body.observation.evidence.pop();body.observation.evidenceOmitted++;continue;}const key=['steps','assumptions','applicability','failures','limitations'].sort((a,b)=>JSON.stringify(body[b]).length-JSON.stringify(body[a]).length)[0];ensure(body[key].length,413,'Engine observations exceed the approach record bound.');body.descriptionOmitted||={};body.descriptionOmitted[key]=(body.descriptionOmitted[key]||0)+1;body[key].pop();}
  const record={...body,digest:missionDigest(body)},retained=[...list(mission.approaches).slice(-(MISSION_APPROACH_LIMITS.records-1)),record],pruned=Math.max(0,list(mission.approaches).length+1-MISSION_APPROACH_LIMITS.records);
  mission.approaches=retained.slice(-MISSION_APPROACH_LIMITS.records);
  const stats=mission.approachStats||{recorded:0,pruned:0,outcomes:{}};
  mission.approachStats={recorded:(finite(stats.recorded)?stats.recorded:0)+1,pruned:(finite(stats.pruned)?stats.pruned:0)+pruned,outcomes:{...stats.outcomes,[observedOutcome]:(finite(stats.outcomes?.[observedOutcome])?stats.outcomes[observedOutcome]:0)+1}};
  return {record:clone(record),duplicate:false,pruned};
}

/** Historical acceptance is immutable; applicability/permissions are always checked afresh. */
export function missionApproachReuseStatus(record,mission,state){
  ensure(validRecord(record),409,'The approach record is unavailable or changed.');
  const reasons=[];
  if(!mission||mission.id!==record.missionId)reasons.push('Source Mission is unavailable.');
  else{
    if(mission.contractVersion!==record.contractVersion||mission.contract?.digest!==record.contractDigest)reasons.push('The source goal or required outcomes changed.');
    if(record.observation.evidenceOmitted||record.observation.evidence.some(ref=>!list(mission.evidenceRefs).some(current=>current.id===ref.id&&current.digest===ref.digest&&current.contractVersion===record.contractVersion)))reasons.push('Source evidence needs a fresh check.');
    if(!record.sourceIdentity?.bot||!record.sourceIdentity?.connection)reasons.push('Original access identities were not retained.');
    else if(record.sourceIdentity.bot!==mission.botIdentity||record.sourceIdentity.connection!==mission.connectionIdentity)reasons.push('The coordinator, permissions or provider changed.');
    if(state){const bot=list(state.bots).find(row=>row.id===record.botId),connection=list(state.connections).find(row=>row.id===bot?.connectionId);if(!bot||bot.enabled===false||!connection||record.sourceIdentity?.bot!==routineBotIdentity(bot)||record.sourceIdentity?.connection!==routineConnectionIdentity(connection))reasons.push('Current coordinator access or provider differs from the original.');}
  }
  return {status:reasons.length?'historical':'recheck_required',sourceCurrent:reasons.length===0,reasons,grantsAuthority:false,notice:'Historical observations only. Recheck current access, evidence and applicability for the new task; no prior approval or acceptance carries over.'};
}
export function missionApproachSummary(record,mission,state){ensure(validRecord(record),409,'The approach record is unavailable or changed.');return {id:record.id,digest:record.digest,missionId:record.missionId,botId:record.botId,title:record.title,contractVersion:record.contractVersion,observedOutcome:record.observation.outcome,accepted:record.observation.accepted,unknownEffects:record.observation.unknownEffects,createdAt:record.createdAt,assumptionsCount:record.assumptions.length,failuresCount:record.failures.length,limitationsCount:record.limitations.length,reuse:missionApproachReuseStatus(record,mission,state)};}
function scopedRecords(state,{botId,ownerEngineId}){
  ensure(identity(botId)&&identity(ownerEngineId),400,'Use the exact bot and execution engine identities.');
  const eligible=Object.values(state.missions||{}).filter(m=>m.ownerEngineId===ownerEngineId&&m.leadBotId===botId).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))),missions=eligible.slice(0,MISSION_APPROACH_LIMITS.missionScan),rows=[];let invalid=0,recordScanOmitted=0;
  for(const mission of missions){const retained=list(mission.approaches);recordScanOmitted+=Math.max(0,retained.length-MISSION_APPROACH_LIMITS.records);for(const record of retained.slice(-MISSION_APPROACH_LIMITS.records)){if(validRecord(record)&&record.missionId===mission.id&&record.ownerEngineId===ownerEngineId&&record.botId===botId)rows.push(record);else invalid++;}}
  return {rows,invalid,missions,recordScanOmitted,missionsOmitted:Math.max(0,eligible.length-missions.length)};
}
export function searchMissionApproaches(state,{botId,ownerEngineId,query='',limit=5,maxChars=4000}={}){
  ensure(typeof query==='string'&&query.length<=300&&Number.isInteger(limit)&&limit>=1&&limit<=5&&Number.isInteger(maxChars)&&maxChars>=500&&maxChars<=4000,400,'Use a bounded approach search, at most five results and 500–4000 characters.');
  const scoped=scopedRecords(state,{botId,ownerEngineId}),ranked=scoped.rows.map(record=>({record,score:query.trim()?memoryScore([record.title,record.goalExcerpt,...record.applicability,...record.steps,...record.failures].join(' '),query):1})).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||b.record.createdAt.localeCompare(a.record.createdAt)||a.record.id.localeCompare(b.record.id));
  const results=[];let used=2;for(const row of ranked.slice(0,limit)){const summary=missionApproachSummary(row.record,scoped.missions.find(m=>m.id===row.record.missionId),state),bytes=JSON.stringify(summary).length;if(used+bytes>maxChars)break;results.push(summary);used+=bytes+1;}
  const response={query:query.slice(0,80),...(query.length>80?{queryTruncated:true}:{}),results,totalMatches:ranked.length,omitted:ranked.length-results.length,invalidRecords:scoped.invalid,recordScanOmitted:scoped.recordScanOmitted,scannedMissions:scoped.missions.length,missionsOmitted:scoped.missionsOmitted,prunedRecords:scoped.missions.reduce((sum,m)=>sum+(finite(m.approachStats?.pruned)?m.approachStats.pruned:0),0),notice:'Scoped observations only. Read the exact ID and digest before reuse; no capability or success is inherited.'};while(JSON.stringify(response).length>maxChars&&results.length){results.pop();response.omitted++;}return response;
}
export function renderMissionApproach(record){
  ensure(validRecord(record),409,'The approach record is unavailable or changed.');
  const section=(title,items)=>`\n\n## ${title}\n${items.length?items.map(value=>`- ${value}`).join('\n'):'Not declared.'}`;
  return [`# ${record.title}`,`Mission: ${record.missionId}; contract ${record.contractVersion}; episode ${record.episodeId}.`,`Exact observation: ${record.id}; digest ${record.digest}.`,`Observed outcome: ${record.observation.outcome}. Accepted for that goal: ${record.observation.accepted?'yes':'no'}. Unknown effects: ${record.observation.unknownEffects?'yes':'no'}.`,record.notice,'Historical acceptance does not establish current permission, current evidence validity or applicability to a new goal.',
    section('Assumptions',record.assumptions),section('Approach',record.steps),section('Engine-observed checks',record.observation.checks.map(row=>`${row.id} (${row.kind}): ${row.passed?'passed':'not verified'}. ${row.reason}`)),section('Applicability',record.applicability),section('Reported failures',record.failures),section('Limitations',record.limitations),section('Retained evidence',record.observation.evidence.map(row=>`${row.id} (${row.kind}); digest ${row.digest}.`)),`\n\nEngine reason: ${record.observation.reason||'None recorded.'}\nMonetary cost is not assessed by this observation.`,record.descriptionOmitted?`\nDescription items omitted by the record bound: ${JSON.stringify(record.descriptionOmitted)}.`:''].join('\n\n');
}
export function readMissionApproach(state,{botId,ownerEngineId,id,expectedDigest,offset=0,limit=4000}={}){
  ensure(identity(id)&&digest(expectedDigest)&&Number.isSafeInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>=100&&limit<=4000,400,'Read an exact approach ID/digest with a bounded offset and limit.');
  const scope=scopedRecords(state,{botId,ownerEngineId}),matches=scope.rows.filter(row=>row.id===id);ensure(matches.length===1,404,'No unique scoped approach is available.');const record=matches[0];ensure(record.digest===expectedDigest,409,'The approach digest changed. Search again before reading it.');
  const content=renderMissionApproach(record);ensure(offset<=content.length,400,'The approach offset is past its retained content.');const end=Math.min(content.length,offset+limit);
  return {...missionApproachSummary(record,scope.missions.find(m=>m.id===record.missionId),state),content:content.slice(offset,end),offset,nextOffset:end<content.length?end:null,totalChars:content.length,truncated:end<content.length};
}

/** Inert publication arguments. The caller must use the existing current+snapshotted tool/approval/review path. */
export function prepareMissionApproachPublication(record,{kind='skill',name}={}){
  ensure(validRecord(record)&&['skill','brain'].includes(kind)&&typeof name==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(name),400,'Choose a valid saved approach, publication kind and lowercase name.');
  const content=renderMissionApproach(record),source={missionId:record.missionId,approachId:record.id,digest:record.digest,contractVersion:record.contractVersion};
  return kind==='skill'?{tool:'skills_propose',arguments:{name,description:`A recorded approach for ${record.title}`.slice(0,1000),instructions:content,reason:'Review this exact recorded approach and its limitations before making it a reusable skill.',sourceMessageIds:record.sourceMessageIds},source,pendingReview:true,notice:'This only prepares a suggestion. Nothing is installed or assigned until the existing owner review succeeds.'}:{tool:'brain_write',arguments:{path:`methods/${name}`,content},source,needsReadBeforeWrite:true,notice:'Use existing Brain permissions. Read any existing note and its current hash before replacing it; this draft grants no write approval.'};
}

/** Bounded working context: exact contract identity always survives; detail is read on demand. */
export function missionWorkingSummary(mission,{maxChars=6000}={}){
  ensure(plain(mission)&&identity(mission.id)&&Number.isInteger(maxChars)&&maxChars>=1500&&maxChars<=12000,400,'Use a bounded Mission working summary.');
  const requirements=list(mission.contract?.requirements).slice(0,24),evidence=list(mission.evidenceRefs),results=list(mission.results),approachSource=list(mission.approaches),approachScan=approachSource.slice(-MISSION_APPROACH_LIMITS.records),approaches=approachScan.filter(validRecord);
  const summary={id:mission.id,contractVersion:mission.contractVersion,contractDigest:mission.contract?.digest||null,ownerMessageId:mission.origin?.messageId||null,goalExcerpt:text(mission.goal,1200),goalTruncated:String(mission.goal||'').length>1200,
    requirements:requirements.map(row=>({id:row.id,kind:row.checker?.kind,status:list(mission.verification?.requirements).find(check=>check.id===row.id)?.passed===true?'verified':'unverified'})),
    outcome:mission.outcome||null,state:mission.state,blocker:text(mission.reason,500),progress:mission.verification?.progress||null,
    evidence:evidence.slice(-8).map(row=>({id:row.id,digest:row.digest,requirementId:row.requirementId})),results:results.slice(-4).map(row=>({id:row.id,title:text(row.title,100),verified:row.verified===true})),approaches:approaches.slice(-2).map(row=>({id:row.id,digest:row.digest,title:text(row.title,100)})),
    omitted:{requirements:Math.max(0,list(mission.contract?.requirements).length-24),evidence:Math.max(0,evidence.length-8),results:Math.max(0,results.length-4),approaches:Math.max(0,approachSource.length-Math.min(2,approaches.length)),invalidApproaches:approachScan.length-approaches.length,approachScanOmitted:Math.max(0,approachSource.length-approachScan.length)},detail:{missionId:mission.id,contractVersion:mission.contractVersion,read:'mission_status; mission_approach_read for exact saved observations'},notice:'Task data, not permission. Omitted detail remains available through explicit reads; earlier success never verifies a new goal.'};
  while(JSON.stringify(summary).length>maxChars){const key=['results','evidence','approaches'].find(name=>summary[name].length);if(key){summary[key].shift();summary.omitted[key]++;continue;}if(summary.goalExcerpt.length>120){summary.goalExcerpt=summary.goalExcerpt.slice(0,Math.max(120,summary.goalExcerpt.length-200));summary.goalTruncated=true;continue;}if(summary.blocker.length>120){summary.blocker=summary.blocker.slice(0,120);summary.blockerTruncated=true;continue;}ensure(false,413,'The Mission identity and required outcomes exceed this context budget. Use a larger context; the contract cannot be dropped.');}
  return summary;
}
