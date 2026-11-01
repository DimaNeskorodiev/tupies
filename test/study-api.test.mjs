import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStudioServer } from '../server.mjs';
import { bundledSkills } from '../lib/skill-catalog.mjs';
import { writeWorkspace } from '../lib/agent-tools.mjs';

const BOT='bot_atlas',OTHER='bot_nova',password='study-api-disposable-fixture-password',sourceText='Canonical targets must be indexable. Preserve the platform-specific exception.';
const sha=value=>createHash('sha256').update(value).digest('hex');
const upload=text=>({name:'canonical-seo.txt',contentBase64:Buffer.from(text).toString('base64')});
const until=async(predicate,label='study API fixture')=>{const deadline=Date.now()+10_000;while(Date.now()<deadline){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Timed out: ${label}`);};
async function fixture(t,{complete=()=>{throw new Error('An owner knowledge request must not invoke a model.');}}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-study-api-')),requests=[];let app,url,cookie='',csrf='';
  const start=async()=>{app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers:{async complete(connection,request){requests.push(request);return complete(request);}}});({url}=await app.listen(0,'127.0.0.1'));};
  t.after(async()=>{if(app)await app.close();await fs.rm(directory,{recursive:true,force:true});});await start();
  const request=async(route,{method='GET',data,authenticated=true,security=true,headers={}}={})=>{const response=await fetch(url+route,{method,signal:AbortSignal.timeout(12_000),headers:{...(authenticated&&cookie?{Cookie:cookie}:{}),...(security&&csrf?{'X-CSRF-Token':csrf}:{}),...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})}),result={status:response.status,body:await response.json(),headers:response.headers};if(['/api/setup','/api/login'].includes(route)&&response.ok){cookie=response.headers.get('set-cookie').split(';')[0];csrf=result.body.csrf;}return result;};
  assert.equal((await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password}})).status,201);
  await app.store.mutate(state=>{state.connections.push({id:'provider_api_study',type:'openai',model:'fixture',contextWindow:128_000});Object.assign(state.bots[0],{connectionId:'provider_api_study',model:'fixture',tools:['workspace','memory','skills'],approvalPolicy:'balanced'});});
  return {get app(){return app;},directory,requests,request,restart:async()=>{await app.close();await start();assert.equal((await request('/api/login',{method:'POST',data:{password}})).status,200);},install:async()=>{const entry=bundledSkills().find(item=>item.catalogId==='tupies-learn-from-material');return app.skills.install({catalogId:entry.catalogId,version:entry.version,digest:entry.digest,botId:BOT});}};
}
async function seed(h,{type='principle',strict=false}={}){
  if(strict)await h.app.store.mutate(state=>{state.bots[0].approvalPolicy='strict';});
  const service=h.app.runtime.studies.knowledge,candidate={type,title:'Canonical target eligibility',content:'Use an indexable target for canonical consolidation.',reason:'Supports technical SEO checks.',scope:'Canonical URL audits',conditions:['The preferred target is indexable.'],exceptions:['A canonical remains a hint.'],evidence:[{segmentId:'api_segment_one',quote:'Canonical targets must be indexable.'}],...(type==='method'?{method:{inputs:['Candidate target URL'],steps:['Check whether the target is indexable.'],outputs:['Scoped finding'],checks:['Verify the actual target before claiming success.']}}:{})};
  const plan=await service.prepare(BOT,'api_seed',[candidate],{sourceReceipts:[{segmentId:'api_segment_one',sourceId:'api_source_one',sourceDigest:sha(sourceText),title:'Synthetic canonical handbook',locator:{page:3},text:sourceText}]}),published=await service.publish(plan,{...(strict?{approvedDigest:plan.approvalDigest}:{})}),unit=(await service.list(BOT)).units[0],read=await service.read(BOT,unit.id);return {service,plan,published,unit,read};
}

test('study and knowledge routes retain authentication, CSRF and Origin checks',async t=>{
  const h=await fixture(t),base=`/api/bots/${BOT}`;
  for(const route of [`${base}/studies`,`${base}/knowledge`,`${base}/knowledge/units`,`${base}/knowledge/batches`])assert.equal((await h.request(route,{authenticated:false})).status,401,route);
  for(const route of [`${base}/studies`,`${base}/knowledge/preview-correction`,`${base}/knowledge/preview-rollback`,`${base}/knowledge/publish`,`${base}/knowledge/propose-method`]){
    assert.equal((await h.request(route,{method:'POST',data:{},authenticated:false})).status,401,route);assert.equal((await h.request(route,{method:'POST',data:{},security:false})).status,403,route);assert.equal((await h.request(route,{method:'POST',data:{},headers:{Origin:'https://untrusted.example'}})).status,403,route);
  }
  assert.equal(h.requests.length,0);assert.deepEqual((await h.request(`${base}/studies`)).body.jobs,[]);assert.deepEqual((await h.request(`${base}/knowledge`)).body.units,[]);
});

test('native study API refuses missing learning assignment or tool groups before model dispatch',async t=>{
  const h=await fixture(t),route=`/api/bots/${BOT}/studies`,input={sources:[upload(sourceText)]};assert.equal((await h.request(route,{method:'POST',data:input})).status,409);await h.install();await h.app.store.mutate(state=>{state.bots[0].tools=['workspace','skills'];});assert.equal((await h.request(route,{method:'POST',data:input})).status,403);assert.equal(h.requests.length,0);assert.equal(h.app.store.state.runs[BOT],undefined);
});

test('knowledge correction previews exact changes, preserves Strict approval and rejects stale or cross-bot publication',async t=>{
  const h=await fixture(t),{read,unit}=await seed(h,{strict:true}),base=`/api/bots/${BOT}/knowledge`,correction={unitId:unit.id,expectedSha256:read.sha256,category:'missing-detail',content:'Use an indexable target within the reviewed platform scope.',reason:'Preserve the platform boundary.'};
  const preview=await h.request(`${base}/preview-correction`,{method:'POST',data:correction});assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.requiresApproval,true);assert.equal((await h.request(`${base}/units/${unit.id}`)).body.sha256,read.sha256);
  assert.equal((await h.request(`${base}/publish`,{method:'POST',data:{planId:preview.body.id,approvalDigest:'0'.repeat(64)}})).status,409);
  assert.equal((await h.request(`/api/bots/${OTHER}/knowledge/publish`,{method:'POST',data:{planId:preview.body.id,approvalDigest:preview.body.approvalDigest}})).status,404);
  const committed=await h.request(`${base}/publish`,{method:'POST',data:{planId:preview.body.id,approvalDigest:preview.body.approvalDigest}});assert.equal(committed.status,200,JSON.stringify(committed.body));assert.equal(committed.body.committedCount,1);
  const current=(await h.request(`${base}/units/${unit.id}`)).body;assert.equal(current.revision,2);assert.match(current.content,/reviewed platform scope/);assert.notEqual(current.sha256,read.sha256);assert.equal((await h.request(`${base}/preview-correction`,{method:'POST',data:correction})).status,409);
  assert.equal((await h.request(`${base}/preview-correction`,{method:'POST',data:{...correction,expectedSha256:current.sha256,category:'project-preference'}})).status,400);assert.equal(h.requests.length,0);
});

test('rollback is bot-scoped, uses exact preview identity and preserves later owner revisions',async t=>{
  const h=await fixture(t),{read,unit,plan}=await seed(h),base=`/api/bots/${BOT}/knowledge`;
  assert.equal((await h.request(`/api/bots/${OTHER}/knowledge/preview-rollback`,{method:'POST',data:{batchId:plan.id}})).status,404);
  const preview=await h.request(`${base}/preview-correction`,{method:'POST',data:{unitId:unit.id,expectedSha256:read.sha256,category:'incorrect',content:'Owner-corrected scoped canonical knowledge.',reason:'Correct the retained explanation.'}});assert.equal(preview.status,200);
  assert.equal((await h.request(`${base}/publish`,{method:'POST',data:{planId:preview.body.id,approvalDigest:preview.body.approvalDigest}})).status,200);
  assert.equal((await h.request(`${base}/preview-rollback`,{method:'POST',data:{batchId:plan.id}})).status,409,'Original batch must not overwrite a newer correction.');
  const rollback=await h.request(`${base}/preview-rollback`,{method:'POST',data:{batchId:preview.body.id}});assert.equal(rollback.status,200,JSON.stringify(rollback.body));assert.equal((await h.request(`${base}/publish`,{method:'POST',data:{planId:rollback.body.id,approvalDigest:'f'.repeat(64)}})).status,409);
  const reverted=await h.request(`${base}/publish`,{method:'POST',data:{planId:rollback.body.id,approvalDigest:rollback.body.approvalDigest}});assert.equal(reverted.status,200,JSON.stringify(reverted.body));const restored=(await h.request(`${base}/units/${unit.id}`)).body;assert.equal(restored.revision,3);assert.equal(restored.unit.content,read.unit.content);assert.equal(h.requests.length,0);
});

test('publication metadata cannot be forged through owner file writes or ordinary workspace/document tools',async t=>{
  const h=await fixture(t),{unit}=await seed(h),root=path.join(h.directory,'workspaces',BOT),relative=`brain/${unit.path.replace(/\.md$/,'.manifest.json')}`,file=path.join(root,relative),before=await fs.readFile(file),bot=h.app.store.state.bots[0],tools=h.app.runtime.tools;
  assert.equal((await h.request(`/api/bots/${BOT}/files`,{method:'PUT',data:{path:relative,content:'{}'}})).status,403);
  await assert.rejects(writeWorkspace(h.app.store,BOT,relative,'{}'),error=>error.status===403);
  await assert.rejects(tools.execute(bot,'documents_create',{path:relative,document:{title:'Forged manifest',content:'{}'}}),error=>error.status===403);
  await assert.rejects(tools.execute(bot,'workspace_edit',{path:relative,expectedSha256:sha(before),oldText:'active',newText:'superseded'}),error=>error.status===403);
  assert.deepEqual(await fs.readFile(file),before);assert.equal((await h.app.runtime.studies.knowledge.list(BOT)).total,1);
});

test('source-derived method proposals remain pending owner learning without enabling tools or executing scripts',async t=>{
  const h=await fixture(t),{read,unit}=await seed(h,{type:'method'}),before=structuredClone({skills:h.app.store.state.bots[0].skills,tools:h.app.store.state.bots[0].tools}),input={unitId:unit.id,expectedSha256:read.sha256,name:'review-canonical-target',description:'Review whether a canonical target is indexable.'};
  assert.equal((await h.request(`/api/bots/${OTHER}/knowledge/propose-method`,{method:'POST',data:input})).status,404);
  const proposed=await h.request(`/api/bots/${BOT}/knowledge/propose-method`,{method:'POST',data:input});assert.equal(proposed.status,200,JSON.stringify(proposed.body));assert.equal(proposed.body.status,'pending');const stored=h.app.store.state.proposals.find(item=>item.id===proposed.body.proposalId);assert.equal(stored.kind,'skill');assert.deepEqual(stored.source.knowledgeReferences,[{unitId:unit.id,sha256:read.sha256,revision:1}]);assert.match(stored.skill.after.content,/source-derived|Source-derived/);assert.deepEqual({skills:h.app.store.state.bots[0].skills,tools:h.app.store.state.bots[0].tools},before);assert.equal(h.app.runtime.backgroundProcesses.entries.size,0);assert.equal(h.requests.length,0);
});

test('completed publication recovers after source cleanup acknowledgement is lost without rereading or republishing',async t=>{
  const complete=request=>{const input=JSON.parse(request.messages.at(-1).content);return {text:JSON.stringify(input.phase==='check'?{acceptedIds:input.candidates.map(candidate=>candidate.id)}:{candidates:[{type:'principle',title:'Indexable canonical target',content:'Canonical targets must be indexable.',reason:'Supports SEO audits.',scope:'Canonical targets',conditions:[],exceptions:[],evidence:[{segmentId:input.segment.id,quote:'Canonical targets must be indexable.'}]}]})};};
  const h=await fixture(t,{complete});await h.install();const engine=h.app.runtime,cleanup=engine.studies.sources.cleanup.bind(engine.studies.sources);let interrupted=false;
  engine.studies.sources.cleanup=async(...args)=>{const result=await cleanup(...args);if(!interrupted){interrupted=true;engine.closing=true;const run=engine.store.state.runs[BOT],controller=engine.controllers.get(run.id);controller.abort(new DOMException('Simulated shutdown after committed cleanup.','AbortError'));throw controller.signal.reason;}return result;};
  const started=await h.request(`/api/bots/${BOT}/studies`,{method:'POST',data:{sources:[upload(sourceText)]}});assert.equal(started.status,202,JSON.stringify(started.body));const jobId=started.body.job.id;await until(()=>!engine.tasks.size);const saved=await engine.studies.read(BOT,jobId);assert.equal(saved.status,'interrupted');assert.equal(saved.publicationComplete,true);assert.equal((await engine.studies.knowledge.list(BOT)).total,1);assert.equal(h.requests.length,2);
  await h.restart();await until(()=>!h.app.runtime.tasks.size);const restored=await h.app.runtime.studies.read(BOT,jobId);assert.equal(restored.status,'completed',restored.error);assert.equal(h.app.store.state.runs[BOT].status,'completed');assert.equal(h.requests.length,2,'Recovery must not fetch discarded source text or repeat model calls.');assert.equal((await h.app.runtime.studies.knowledge.list(BOT)).total,1);assert.equal((await h.request(`/api/bots/${OTHER}/studies/${jobId}`)).status,404);
});

test('method corrections replace the exact procedure and proposed skills use the corrected inputs steps outputs and checks',async t=>{
  const h=await fixture(t),{read,unit}=await seed(h,{type:'method'}),base=`/api/bots/${BOT}/knowledge`,method={inputs:['An owner-selected target URL'],steps:['Verify target indexability first.','Inspect its canonical only after that verification.'],outputs:['A scoped canonical finding'],checks:['Confirm the verified target matches the owner input.']},input={unitId:unit.id,expectedSha256:read.sha256,category:'wrong-application',content:'Check indexability before interpreting canonical eligibility.',reason:'Correct the ordered procedure.',method};
  const invalid=await h.request(`${base}/preview-correction`,{method:'POST',data:{...input,method:{...method,checks:[]}}});assert.equal(invalid.status,400);const preview=await h.request(`${base}/preview-correction`,{method:'POST',data:input});assert.equal(preview.status,200,JSON.stringify(preview.body));const saved=await h.request(`${base}/publish`,{method:'POST',data:{planId:preview.body.id,approvalDigest:preview.body.approvalDigest}});assert.equal(saved.status,200);const corrected=(await h.request(`${base}/units/${unit.id}`)).body;assert.deepEqual(corrected.unit.method.steps,method.steps);assert.deepEqual(corrected.unit.method.checks,method.checks);
  const proposed=await h.request(`${base}/propose-method`,{method:'POST',data:{unitId:unit.id,expectedSha256:corrected.sha256,name:'corrected-canonical-review',description:'Use the corrected scoped canonical procedure.'}});assert.equal(proposed.status,200);const content=h.app.store.state.proposals.find(item=>item.id===proposed.body.proposalId).skill.after.content;for(const value of Object.values(method).flat())assert.ok(content.includes(value));assert.equal(h.requests.length,0);
});
