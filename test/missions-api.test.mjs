import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStudioServer } from '../server.mjs';
import { listDocuments, writeDocument, parseKey } from '../lib/sync/docs.mjs';
import { sanitizeMissionSummary, publicMissions } from '../lib/mission-presentation.mjs';

test('Mission API preserves owner authentication/CSRF, durable idempotency, revision guards and queued Stop',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-missions-api-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  const {url}=await app.listen(0);let cookie='',csrf='';
  t.after(async()=>{app.runtime.starting.clear();await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const request=async(route,{method='GET',data,authenticated=true,token=true}={})=>{const response=await fetch(url+route,{method,headers:{...(authenticated&&cookie?{Cookie:cookie}:{}),...(token&&csrf?{'X-CSRF-Token':csrf}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  const setup=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'mission-fixture-password'}});cookie=setup.cookie;csrf=setup.body.csrf;
  await app.store.mutate(state=>{state.connections.push({id:'fixture_provider',name:'Fixture',type:'openai',model:'fixture-model',secret:app.store.seal('mission_fixture_redaction_secret')});state.bots[0].connectionId='fixture_provider';state.bots[0].tools=['workspace'];});
  app.runtime.providers={async complete(){return {text:'Fixture',toolCalls:[]};}};
  // Occupy the bot through the same admission guard, without dispatching a fake Mission episode.
  app.runtime.starting.add('bot_atlas');
  const input={leadBotId:'bot_atlas',goal:'Prepare a source-backed research report.',clientMessageId:'mission_api_request_001'};
  assert.equal((await request('/api/missions',{authenticated:false})).status,401);
  assert.equal((await request('/api/missions',{method:'POST',data:input,token:false})).status,403);
  const first=await request('/api/missions',{method:'POST',data:input});assert.equal(first.status,202,JSON.stringify(first.body));
  const mission=first.body.mission;assert.equal(mission.status,'queued');assert.equal(mission.progress.percent,0);
  assert.equal(mission.ownerEngineId,app.sync.nodeId);assert.equal(mission.originEngineName,app.sync.identity.name);
  const otherDirectory=await fs.mkdtemp(path.join(tmpdir(),'tupies-mission-other-engine-')),other=await createStudioServer({dataDir:otherDirectory,scheduler:false,logErrors:false});
  try{assert.notEqual(other.sync.nodeId,app.sync.nodeId);assert.equal(other.runtime.missions.ownerEngineId,other.sync.nodeId);assert.notEqual(other.runtime.missions.ownerEngineId,app.runtime.missions.ownerEngineId);}finally{await other.close();await fs.rm(otherDirectory,{recursive:true,force:true});}
  const repeated=await request('/api/missions',{method:'POST',data:input});assert.equal(repeated.status,200);assert.equal(repeated.body.mission.id,mission.id);
  assert.equal((await request('/api/missions',{method:'POST',data:{...input,goal:'Changed'}})).status,409);
  assert.equal((await request(`/api/missions/${mission.id}/control`,{method:'POST',data:{action:'stop',revision:mission.revision-1}})).status,409);
  const stopped=await request(`/api/missions/${mission.id}/control`,{method:'POST',data:{action:'stop',revision:mission.revision}});assert.equal(stopped.status,202);assert.equal(stopped.body.mission.status,'stopped');
  app.runtime.starting.delete('bot_atlas');await app.runtime.tick();assert.equal(app.store.state.runs.bot_atlas,undefined);
  const later=await request('/api/missions',{method:'POST',data:input});assert.equal(later.body.mission.id,mission.id);assert.equal(later.body.mission.status,'stopped');
  await app.store.queue;const saved=JSON.parse(await fs.readFile(path.join(directory,'state.json'),'utf8'));assert.equal(saved.missions[mission.id].stopRequested,true);assert.equal(saved.missions[mission.id].origin.submissionId,input.clientMessageId);
  let author=0;
  app.runtime.providers={async complete(_connection,request){
    if(request.messages[0].content.includes('You independently assess an agent result')){const payload=JSON.parse(request.messages[1].content);return {text:JSON.stringify({coveragePassed:true,requirements:payload.contract.requirements.map(item=>({id:item.id,passed:true,reason:'Exact deterministic saved-file fixture.'})),reason:'Synthetic fixture acceptance.'}),toolCalls:[]};}
    if(author++===0)return {text:'',toolCalls:[{id:'save_report',name:'documents_create',arguments:{path:'report.txt',document:{title:'Saved report',content:'Exact saved Mission report bytes.'}}}]};
    return {text:'The real saved Mission report is complete.',toolCalls:[]};
  }};
  const second=await request('/api/missions',{method:'POST',data:{leadBotId:'bot_atlas',goal:'Create saved Mission report.',requirements:['Create saved Mission report.'],clientMessageId:'mission_api_request_002'}});assert.equal(second.status,202,JSON.stringify(second.body));
  const until=Date.now()+10000;while(Date.now()<until && !['completed','failed','cancelled'].includes(app.store.state.runs.bot_atlas?.status))await new Promise(resolve=>setTimeout(resolve,10));
  await Promise.all([...app.runtime.tasks.values()]);await app.store.queue;
  const final=(await request(`/api/missions/${second.body.mission.id}`)).body.mission;assert.equal(final.status,'achieved',JSON.stringify(final));
  const approach=final.approaches[0];assert.ok(approach.id);const approachRoute=`/api/missions/${final.id}/approaches/${approach.id}?digest=${approach.digest}`;
  assert.equal((await request(approachRoute,{authenticated:false})).status,401);assert.equal((await fetch(url+approachRoute,{headers:{Cookie:cookie,Origin:'https://attacker.test'}})).status,403);
  assert.equal((await request(approachRoute.replace(approach.digest,'0'.repeat(64)))).status,409);assert.equal((await request(approachRoute.replace(final.id,mission.id))).status,404);
  const read=await request(approachRoute);assert.equal(read.status,200);assert.equal(read.body.missionId,final.id);
  const beforeDraft=JSON.stringify({skills:app.store.state.skills,brain:app.store.state.brain});
  for(const kind of ['skill','brain']){const exported=await request(`/api/missions/${final.id}/approaches/${approach.id}/export?digest=${approach.digest}&kind=${kind}`);assert.equal(exported.status,200,JSON.stringify(exported.body));assert.equal(exported.body.tool,kind==='skill'?'skills_propose':'brain_write');assert.equal(kind==='skill'?exported.body.pendingReview:exported.body.needsReadBeforeWrite,true);}
  assert.equal(JSON.stringify({skills:app.store.state.skills,brain:app.store.state.brain}),beforeDraft);
  const oldAcceptance=structuredClone(app.store.state.missions[final.id].acceptance);
  const revised=await request(`/api/missions/${final.id}/control`,{method:'POST',data:{action:'revise',revision:final.revision,text:'Create a revised saved report.',requirements:['Create a revised saved report.']}});
  assert.equal(revised.status,202);assert.equal(revised.body.mission.outcome,null);assert.ok(revised.body.mission.results.every(item=>!item.verified));assert.deepEqual(app.store.state.missions[final.id].acceptanceHistory,[oldAcceptance]);assert.equal(app.store.state.missions[final.id].acceptance,undefined);
  const file=final.results.find(item=>item.file)?.file;assert.ok(file.snapshotUrl);assert.equal(file.verified,true);
  const raw=(route,extra={})=>fetch(url+route,{headers:{Cookie:cookie,...extra}});
  const download=await raw(file.snapshotUrl);assert.equal(download.status,200);assert.match(download.headers.get('content-type'),/^text\/plain/);assert.match(download.headers.get('content-disposition'),/^attachment;/);const savedBytes=await fs.readFile(path.join(directory,'workspaces','bot_atlas','report.txt'),'utf8');assert.equal(await download.text(),savedBytes);
  await fs.writeFile(path.join(directory,'workspaces','bot_atlas','report.txt'),'Changed workspace bytes.');
  assert.equal(await (await raw(file.snapshotUrl)).text(),savedBytes);
  assert.equal((await fetch(url+file.snapshotUrl)).status,401);assert.equal((await raw(file.snapshotUrl,{Origin:'https://attacker.test'})).status,403);
  assert.equal((await raw(file.snapshotUrl.replace(second.body.mission.id,mission.id))).status,404);
  const blob=(await fs.readdir(path.join(directory,'mission-evidence'))).find(name=>name.endsWith('.bin'));assert.ok(blob);await fs.writeFile(path.join(directory,'mission-evidence',blob),'Tampered');
  assert.notEqual((await raw(file.snapshotUrl)).status,200);
  app.runtime.starting.add('bot_atlas');
  const redacted=await request('/api/missions',{method:'POST',data:{leadBotId:'bot_atlas',goal:'Protect mission_fixture_redaction_secret.',requirements:['Protect mission_fixture_redaction_secret.'],clientMessageId:'mission_api_request_003'}});
  assert.equal(redacted.status,202);assert.equal(redacted.body.mission.goal,'Protect [redacted].');assert.ok(!JSON.stringify(app.store.publicState()).includes('mission_fixture_redaction_secret'));
  app.runtime.starting.delete('bot_atlas');

});

test('Mission sync is an explicit bounded presentation with no execution authority or private lane history',()=>{
  const summary={id:'mission_test',leadBotId:'bot_atlas',ownerEngineId:'node_owner',revision:2,contractVersion:1,title:'Goal',goal:'Research',status:'running',executionState:'running',createdAt:'2026-11-01',updatedAt:'2026-11-01',progress:{verified:0,total:2,percent:0,ledger:{grant:'secret'}},participants:[],requirements:[],results:[{id:'result',title:'Result',summary:'Partial',verified:true,file:{botId:'bot_atlas',path:'private.txt'},grant:'bad'}],activity:[],pending_controls:[{kind:'approval'}],resourceLedger:{authority:true},resourceJournal:{authority:true},missionPricing:{secret:true},runtimeCheckpoints:{authority:true},approaches:[{private:true}],wait:{kind:'file_change',nextWakeAt:1000,deadlineAt:2000,path:'private.txt',cursor:9,id:'wait_secret'},checkpoint:{automatic:true}};
  const safe=sanitizeMissionSummary(summary);assert.equal(safe.pending_controls,undefined);assert.equal(safe.resourceLedger,undefined);assert.equal(safe.results[0].file,undefined);assert.equal(safe.results[0].grant,undefined);assert.equal(safe.progress.ledger,undefined);for(const key of ['resourceJournal','missionPricing','runtimeCheckpoints','approaches'])assert.equal(safe[key],undefined);assert.deepEqual(safe.wait,{kind:'file_change',nextWakeAt:1000,deadlineAt:2000});
  const state={missions:{},missionSummaries:{mission_test:summary},sessions:[{id:'bot_atlas--mission-abc',kind:'mission'}],conversations:{'bot_atlas--mission-abc':[{role:'tool',content:'private Mission evidence'}],bot_atlas:[{role:'user',content:'Owner chat'}]}};
  const docs=listDocuments(state,{});assert.ok(docs.has('mission:mission_test'));assert.equal(docs.has('conv:bot_atlas--mission-abc'),false);assert.equal(docs.has('session:bot_atlas--mission-abc'),false);assert.ok(docs.has('conv:bot_atlas'));
  assert.deepEqual(parseKey('mission:mission_test'),{kind:'mission',id:'mission_test'});
  const remote={};assert.equal(writeDocument(remote,'mission:mission_test',summary,{}),true);assert.equal(remote.missions,undefined);assert.equal(remote.missionRuntime,undefined);assert.equal(publicMissions(remote)[0].canControl,false);assert.equal(publicMissions(remote)[0].remote,true);
  const local={missions:{mission_test:{state:'queued'}},missionSummaries:{}};assert.equal(writeDocument(local,'mission:mission_test',summary,{}),false);assert.equal(local.missions.mission_test.state,'queued');
  assert.equal(writeDocument(remote,'conv:bot_atlas--mission-abc',[{role:'user',content:'restart now'}],{}),false);
  const oversized={...summary,results:Array.from({length:40},(_,index)=>({id:`result_${index}`,summary:'x'.repeat(4000)}))};assert.equal(sanitizeMissionSummary(oversized),null);
});
