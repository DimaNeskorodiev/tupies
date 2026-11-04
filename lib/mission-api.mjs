import { readMissionApproach, prepareMissionApproachPublication } from './mission-learning.mjs';
import { ensure } from './store.mjs';
import { publicMissions } from './mission-presentation.mjs';
import { readMissionEvidenceFile } from './mission-evidence.mjs';

/** Called only behind the existing authenticated workspace/CSRF/Origin/Host boundary. */
export async function missionApi(req,res,url,{runtime,store,body,json}) {
  if(!url.pathname.startsWith('/api/missions'))return false;
  const reply=(value,status=200)=>{json(res,value,status);return true;};
  if(url.pathname==='/api/missions'){
    if(req.method==='GET')return reply({missions:publicMissions(store.state),admission:runtime.missions.enabled()});
    if(req.method==='POST'){const result=await runtime.missions.create(await body(req,100000));return reply(result,result.duplicate?200:202);}
  }
  if(url.pathname==='/api/missions/adopt' && req.method==='POST'){
    const input=await body(req,4000);ensure(input && Object.keys(input).every(key=>['botId','runId','effort'].includes(key)),400,'Give the current bot and run IDs.');return reply(await runtime.missions.adopt(input),202);
  }
  const approach=url.pathname.match(/^\/api\/missions\/(mission_[a-f0-9]{18})\/approaches\/(approach_[a-f0-9]{32})(?:\/(export))?$/);
  if(approach && req.method==='GET'){const [,missionId,approachId,publication]=approach,mission=runtime.missions.get(missionId);const record=(mission.approaches || []).find(item=>item.id===approachId);ensure(record && record.missionId===missionId,404,'No exact local approach belongs to this Mission.');const digest=url.searchParams.get('digest');const detail=readMissionApproach(store.state,{botId:mission.leadBotId,ownerEngineId:runtime.missions.ownerEngineId,id:approachId,expectedDigest:digest,offset:Number(url.searchParams.get('offset') || 0),limit:Number(url.searchParams.get('limit') || 4000)});ensure(detail.missionId===missionId && detail.digest===record.digest,409,'The exact approach source changed.');return reply(publication?prepareMissionApproachPublication(record,{kind:url.searchParams.get('kind') || 'skill',name:url.searchParams.get('name') || `mission-${approachId.slice(-12)}`}):detail);}
  const download=url.pathname.match(/^\/api\/missions\/(mission_[a-f0-9]{18})\/evidence\/(evidence_[a-f0-9]{64})\/download$/);
  if(download && req.method==='GET'){
    const [,missionId,evidenceId]=download,mission=runtime.missions.get(missionId);
    const reference=[...(mission.artifactRefs || []),...(mission.evidenceRefs || [])].find(item=>item.id===evidenceId && item.kind==='file');
    ensure(reference && reference.botId===mission.leadBotId,404,'No saved result belongs to this Mission.');
    const {bytes,metadata}=await readMissionEvidenceFile({store,reference,missionId});
    res.writeHead(200,{'Content-Type':metadata.mime || 'application/octet-stream','Content-Length':bytes.length,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(metadata.name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return true;
  }
  const route=url.pathname.match(/^\/api\/missions\/(mission_[a-f0-9]{18})(?:\/(control))?$/);
  if(route){
    const [,missionId,action]=route;
    if(req.method==='GET' && !action){if(!store.state.missions?.[missionId]){const remote=publicMissions(store.state).find(item=>item.id===missionId);if(remote)return reply({mission:remote});}return reply({mission:runtime.missions.view(missionId,{detail:true})});}
    if(req.method==='POST' && action==='control')return reply(await runtime.missions.control(missionId,await body(req,100000)),202);
  }
  ensure(false,405,'Use the supported Mission list, detail, creation or control route.');
}
