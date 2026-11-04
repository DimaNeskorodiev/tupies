import { missionEffortSummary } from './mission-effort.mjs';
const clone=value=>structuredClone(value);
const safeId=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const plain=value=>value && typeof value==='object' && !Array.isArray(value);
const bounded=(value,max)=>String(value ?? '').slice(0,max);
/** Presentation-only allowlist. Never copy runtime, approvals, credentials or evidence payloads to sync. */
export function missionSummary(mission) {
  const progress=(!mission.verification?.contractVersion || mission.verification.contractVersion===mission.contractVersion?mission.verification?.progress:null) || {verified:0,total:mission.contract?.requirements?.length?mission.contract.requirements.length+1:0,percent:0};
  const achieved=mission.outcome==='achieved';
  const observed=mission.observedWork,work=observed && ['steps','actions','sources'].every(key=>Number.isSafeInteger(observed[key]) && observed[key]>=0)?`Coordinator: ${observed.steps} model steps, ${observed.actions} successful actions, ${observed.sources} source reads. Final acceptance pending.`:'';
  return {id:mission.id,title:bounded(mission.goal.split('\n')[0],100),goal:bounded(mission.goal,20000),leadBotId:mission.leadBotId,revision:mission.revision,
    contractVersion:mission.contractVersion,ownerEngineId:mission.ownerEngineId,originEngineName:mission.ownerEngineName,
    status:mission.outcome || (mission.reason && mission.state==='waiting' && ['attention','owner_input','approval'].includes(mission.waitCondition?.kind)?'needs_attention':mission.state),executionState:mission.state,outcome:mission.outcome || null,
    createdAt:mission.createdAt,updatedAt:mission.updatedAt,...(mission.archivedAt?{archivedAt:mission.archivedAt}:{}),
    effort:missionEffortSummary(mission),
    progress:{outcomesTotal:mission.contract?.requirements?.length || 0,outcomesVerified:achieved?mission.contract?.requirements?.length || 0:Math.min(mission.contract?.requirements?.length || 0,progress.verified || 0),acceptancePending:!achieved,verified:achieved?progress.total:progress.verified,total:progress.total,percent:achieved?100:Math.max(0,Math.min(99,progress.percent || 0)),label:progress.total?`${achieved?progress.total:progress.verified} of ${progress.total} outcomes verified`:'Defining acceptance criteria'},
    participants:(mission.participantAssignments || []).map(item=>({botId:item.botId,name:bounded(item.name,100),role:item.role,status:item.status})),
    requirements:(mission.contract?.requirements || []).map(item=>({id:item.id,title:item.text,status:mission.verification?.requirements?.find(result=>result.id===item.id)?.passed?'verified':'pending'})),
    results:(mission.results || []).slice(-40).map(item=>({id:item.id,title:bounded(item.title,200),summary:bounded(item.summary,4000),botId:item.botId,verified:!!item.verified,...(item.file?{file:{botId:item.file.botId,path:item.file.path,name:item.file.name,format:item.file.format,size:item.file.size,verified:item.file.verified===true,snapshotUrl:item.file.snapshotUrl}}:{})})),
    activity:(mission.activity || []).slice(-80).map(item=>({id:item.id,type:item.type,text:bounded(item.text,1000),at:item.at,botId:item.botId})),
    ...(['timer','dependency','file_change'].includes(mission.waitCondition?.kind)?{wait:{kind:mission.waitCondition.kind,nextWakeAt:mission.waitCondition.nextWakeAt,deadlineAt:mission.waitCondition.deadlineAt}}:{}),
    currentStep:bounded(mission.reason || (mission.state==='queued'?'Waiting for the coordinator':mission.state==='verifying'?'Checking the result against the goal':!mission.outcome?work:''),1000),
    ...(mission.reason && mission.state==='waiting' && ['attention','owner_input','approval'].includes(mission.waitCondition?.kind)?{attention:{kind:'blocked',title:'Needs attention',detail:bounded(mission.reason,1000)}}:{})};
}

export function publicMissions(state) {
  const locals=Object.values(state.missions || {}).map(mission=>({...missionSummary(mission),canControl:true})),ids=new Set(locals.map(item=>item.id));
  return [...locals,...Object.values(state.missionSummaries || {}).filter(item=>!ids.has(item.id)).map(sanitizeMissionSummary).filter(Boolean).map(item=>({...item,remote:true,canControl:false}))].sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
export function sanitizeMissionSummary(value) {
  if(!plain(value) || !safeId(value.id) || !safeId(value.ownerEngineId) || !safeId(value.leadBotId) || !Number.isSafeInteger(value.revision) || value.revision<1)return null;
  // Reconstruct through the same presentation allowlist, stripping all unknown authority fields.
  const allowed=['id','leadBotId','revision','contractVersion','ownerEngineId'];
  const out=Object.fromEntries(allowed.filter(key=>Object.hasOwn(value,key)).map(key=>[key,clone(value[key])]));
  for(const [key,max] of Object.entries({title:100,goal:20000,originEngineName:100,status:40,executionState:40,outcome:40,createdAt:40,updatedAt:40,archivedAt:40,currentStep:1000}))if(typeof value[key]==='string')out[key]=bounded(value[key],max);
  const progress=value.progress || {};out.progress={verified:Number.isSafeInteger(progress.verified)?Math.max(0,Math.min(25,progress.verified)):0,total:Number.isSafeInteger(progress.total)?Math.max(0,Math.min(25,progress.total)):0,percent:Number.isFinite(progress.percent)?Math.max(0,Math.min(value.status==='achieved'?100:99,progress.percent)):0,label:bounded(progress.label,200)};
  if(Number.isSafeInteger(progress.outcomesTotal) && progress.outcomesTotal>=0 && progress.outcomesTotal<=20 && Number.isSafeInteger(progress.outcomesVerified) && progress.outcomesVerified>=0 && progress.outcomesVerified<=progress.outcomesTotal)Object.assign(out.progress,{outcomesTotal:progress.outcomesTotal,outcomesVerified:progress.outcomesVerified,acceptancePending:value.status!=='achieved'});
  if(plain(value.effort) && ['low','medium','high','ultra'].includes(value.effort.level) && Number.isFinite(value.effort.percent))out.effort={level:value.effort.level,percent:Math.max(0,Math.min(100,value.effort.percent)),finishing:value.effort.finishing===true,exhausted:value.effort.exhausted===true};
  out.participants=(Array.isArray(value.participants)?value.participants:[]).slice(0,100).filter(item=>plain(item) && safeId(item.botId)).map(item=>({botId:item.botId,name:bounded(item.name,100),role:bounded(item.role,40),status:bounded(item.status,40)}));
  out.requirements=(Array.isArray(value.requirements)?value.requirements:[]).slice(0,24).filter(item=>plain(item) && safeId(item.id)).map(item=>({id:item.id,title:bounded(item.title,2000),status:bounded(item.status,40)}));
  out.activity=(Array.isArray(value.activity)?value.activity:[]).slice(-80).filter(plain).map(item=>({id:bounded(item.id,120),type:bounded(item.type,60),text:bounded(item.text,1000),at:bounded(item.at,40),botId:safeId(item.botId)?item.botId:''}));
  if(plain(value.wait) && ['timer','dependency','file_change'].includes(value.wait.kind) && Number.isSafeInteger(value.wait.nextWakeAt) && Number.isSafeInteger(value.wait.deadlineAt))out.wait={kind:value.wait.kind,nextWakeAt:value.wait.nextWakeAt,deadlineAt:value.wait.deadlineAt};
  if(plain(value.attention))out.attention={kind:bounded(value.attention.kind,40),title:bounded(value.attention.title,200),detail:bounded(value.attention.detail,1000)};
  // Remote artifacts are references only; never download them through this engine's private file routes.
  out.results=(Array.isArray(value.results)?value.results:[]).slice(0,40).filter(plain).map(item=>({id:bounded(item.id,120),title:bounded(item.title,200),summary:bounded(item.summary,4000),botId:safeId(item.botId)?item.botId:'',verified:item.verified===true}));
  if(Buffer.byteLength(JSON.stringify(out))>100000)return null;
  return out;
}

