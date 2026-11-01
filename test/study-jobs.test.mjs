import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { SkillsService } from '../lib/skills.mjs';
import { bundledSkills } from '../lib/skill-catalog.mjs';
import { FileReplica } from '../lib/sync/files.mjs';
import { listDocuments } from '../lib/sync/docs.mjs';

const botId='bot_atlas',quote='Keep mobile SEO checks scoped to mobile.';
const upload=text=>({name:'mobile-seo.md',contentBase64:Buffer.from(text).toString('base64')});
const waitFor=async(predicate,label='study fixture')=>{const until=Date.now()+10_000;while(Date.now()<until){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Timed out: ${label}`);};
const decision=run=>({runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation});
function response(request){const input=JSON.parse(request.messages.at(-1).content);if(input.phase==='reconcile')return {text:JSON.stringify({decisions:[]})};if(input.phase==='check')return {text:JSON.stringify({acceptedIds:input.candidates.map(candidate=>candidate.id)}),usage:{input_tokens:10,output_tokens:5}};if(input.phase==='select')return {text:JSON.stringify({candidates:input.segment.text.includes(quote)?[{type:'principle',title:'Mobile SEO scope',content:quote,reason:'Avoid applying mobile checks outside the relevant platform.',scope:'Mobile SEO audits',conditions:['The current audit targets mobile.'],exceptions:[],aliases:['мобільний SEO'],evidence:[{segmentId:input.segment.id,quote}]}]:[]}),usage:{input_tokens:10,output_tokens:5}};throw new Error('Unexpected fixture model request.');}
function waitUntilAborted(signal){return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason||Object.assign(new Error('Fixture request cancelled.'),{name:'AbortError'}));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
async function fixture(t,{strict=false,install=true,complete=response}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-study-jobs-')),store=await new Store(directory).init(),skills=new SkillsService(store),requests=[];
  await store.mutate(state=>{state.connections.push({id:'provider_study_fixture',type:'openai',model:'fixture',contextWindow:128_000});Object.assign(state.bots[0],{connectionId:'provider_study_fixture',model:'fixture',tools:['workspace','memory','skills'],approvalPolicy:strict?'strict':'balanced',instructions:'Study source-backed SEO knowledge and preserve scope.'});});
  if(install){const entry=bundledSkills().find(item=>item.catalogId==='tupies-learn-from-material');await skills.install({catalogId:entry.catalogId,version:entry.version,digest:entry.digest,botId});}
  const engines=[],make=(currentStore,handler=complete)=>{const engine=new NativeEngine(currentStore,{skills:new SkillsService(currentStore),providers:{async complete(connection,request){requests.push(request);return handler(request,requests.length);}}});engines.push(engine);return engine;},engine=make(store);await engine.recover();
  t.after(async()=>{for(const item of engines)await item.close();await Promise.all(engines.map(item=>item.store.queue));await fs.rm(directory,{recursive:true,force:true});});return {directory,store,skills,engine,requests,make};
}
async function settled(engine,jobId){await waitFor(()=>!engine.tasks.size,'study task completion');const job=await engine.studies.read(botId,jobId);return {job,run:engine.store.state.runs[botId]};}

test('native learning publishes usable scoped knowledge without Terminal or raw-input sync',async t=>{
  const {engine,store,requests,directory}=await fixture(t),canary='RAW-STUDY-CANARY-DO-NOT-PERSIST-TO-TRANSCRIPTS',beforeMemory=structuredClone(store.state.memory),started=await engine.studies.start(botId,{sources:[upload(`${quote}\n\nUnrelated raw source: ${canary}.`)],focus:'Learn scope for SEO audits.'}),{job,run}=await settled(engine,started.job.id);
  assert.equal(run.status,'completed',run.error);assert.equal(job.status,'completed');assert.equal(job.cleanup,'removed');assert.equal(job.result.committedCount,1);assert.equal(requests.length,2);assert.ok(requests.every(request=>request.tools.length===0));assert.ok(!store.state.bots[0].tools.includes('terminal'));assert.deepEqual(store.state.memory,beforeMemory);
  const learned=await engine.studies.knowledge.list(botId);assert.equal(learned.total,1);assert.match(JSON.stringify(learned),/Mobile SEO/);const found=await engine.tools.execute(store.state.bots[0],'brain_search',{query:'mobile SEO'});assert.equal(found.results.length,1);
  assert.doesNotMatch(JSON.stringify(store.state),new RegExp(canary));assert.doesNotMatch(JSON.stringify([...listDocuments(store.state,store)]),new RegExp(canary));
  const sync=new FileReplica(directory),files=await sync.scan();assert.ok(![...files.keys()].some(key=>key.includes('study-staging')||key.includes('study-jobs')));for(const key of files.keys())if(key.startsWith('file:workspaces/'))assert.doesNotMatch(await fs.readFile(path.join(directory,key.slice(5)),'utf8'),new RegExp(canary));
  await assert.rejects(fs.stat(path.join(directory,'study-staging',job.id)),error=>error.code==='ENOENT');
});

test('relearning identical supported knowledge adds no duplicate active unit',async t=>{
  const {engine}=await fixture(t),input={sources:[upload(quote)],focus:'SEO scope.'};const first=await engine.studies.start(botId,input);assert.equal((await settled(engine,first.job.id)).run.status,'completed');const second=await engine.studies.start(botId,input),result=await settled(engine,second.job.id);assert.equal(result.run.status,'completed',result.run.error);assert.equal(result.job.result.committedCount,0);assert.equal((await engine.studies.knowledge.list(botId)).total,1);
});

test('Strict publication waits for exact current approval and denial commits no knowledge',async t=>{
  const {engine,store}=await fixture(t,{strict:true}),started=await engine.studies.start(botId,{sources:[upload(quote)]});await waitFor(()=>store.state.runs[botId]?.status==='waiting_for_approval');let run=store.state.runs[botId];assert.equal(run.pending_controls[0].tool,'knowledge_publish');assert.equal((await engine.studies.knowledge.list(botId)).total,0);
  await assert.rejects(engine.control(botId,'approval',{...decision(run),request_id:'stale-identity',choice:'once'}),error=>error.status===409);
  await engine.control(botId,'approval',{...decision(run),choice:'deny'});const result=await settled(engine,started.job.id);assert.equal(result.run.status,'failed');assert.equal(result.job.status,'blocked');assert.equal((await engine.studies.knowledge.list(botId)).total,0);assert.ok(result.run.deniedCalls.length>0);
});

test('a file created after Strict preview is preserved and stale publication fails',async t=>{
  const {engine,store,directory}=await fixture(t,{strict:true}),started=await engine.studies.start(botId,{sources:[upload(quote)]});await waitFor(()=>store.state.runs[botId]?.status==='waiting_for_approval');const run=store.state.runs[botId],action=run.pending_controls[0].arguments.actions[0],file=path.join(directory,'workspaces',botId,'brain',action.args.path);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'Owner edit wins.');
  await engine.control(botId,'approval',{...decision(run),choice:'once'});const result=await settled(engine,started.job.id);assert.equal(result.run.status,'failed');assert.equal(await fs.readFile(file,'utf8'),'Owner edit wins.');assert.equal((await engine.studies.knowledge.list(botId)).total,0);
});

test('Stop is durable, cancels model work and does not resume or publish after restart',async t=>{
  const {engine,store,directory,requests,make}=await fixture(t,{complete:request=>waitUntilAborted(request.signal)}),started=await engine.studies.start(botId,{sources:[upload(quote)]});await waitFor(()=>requests.length===1);const current=store.state.runs[botId];await engine.control(botId,'stop',{runId:current.id,remoteRunId:current.remoteRunId});const result=await settled(engine,started.job.id);assert.equal(result.run.status,'cancelled');assert.equal(result.run.stopRequested,true);assert.equal(result.job.status,'cancelled');assert.equal((await engine.studies.knowledge.list(botId)).total,0);
  await engine.close();await store.queue;const reloaded=await new Store(directory).init(),next=make(reloaded);await next.recover();await next.recoverAutonomous();assert.equal(requests.length,1);assert.equal(reloaded.state.runs[botId].status,'cancelled');assert.equal((await next.studies.read(botId,started.job.id)).status,'cancelled');
});

test('restart resumes the same study and retains checked segments without duplicate publication',async t=>{
  let hold=true;const {engine,store,directory,requests,make}=await fixture(t,{complete:request=>{const input=JSON.parse(request.messages.at(-1).content);if(input.phase==='select'&&!input.segment.text.includes(quote)&&hold)return waitUntilAborted(request.signal);return response(request);}}),started=await engine.studies.start(botId,{sources:[upload(`${quote}\n\n${'Background exposition without another reusable rule. '.repeat(110)}`)]});
  await waitFor(async()=>{const job=await engine.studies.read(botId,started.job.id);return job.processed.length>=1&&requests.length>=3;},'first checked source segment');await engine.close();await store.queue;const interrupted=await engine.studies.read(botId,started.job.id);assert.equal(interrupted.status,'interrupted');assert.ok(interrupted.candidates.length>=1);const retainedSegment=interrupted.processed[0],callsBefore=requests.length;
  hold=false;const reloaded=await new Store(directory).init(),next=make(reloaded,request=>response(request));await next.recover();await next.recoverAutonomous();const result=await settled(next,started.job.id);assert.equal(result.run.id,started.run.id);assert.equal(result.run.status,'completed',result.run.error);assert.equal(result.job.status,'completed');assert.equal((await next.studies.knowledge.list(botId)).total,1);assert.ok(!requests.slice(callsBefore).some(request=>{const input=JSON.parse(request.messages.at(-1).content);return input.segment?.id===retainedSegment;}));
});

test('changed learning package prevents recovery of an interrupted study',async t=>{
  const {engine,store,directory,requests,make}=await fixture(t,{complete:request=>waitUntilAborted(request.signal)}),started=await engine.studies.start(botId,{sources:[upload(quote)]});await waitFor(()=>requests.length===1);await engine.close();await store.queue;const skill=store.state.skills.find(item=>item.catalogId==='tupies-learn-from-material');await fs.appendFile(path.join(directory,'skills',skill.id,'references/learning-rules.md'),'\nChanged after interruption.');
  const reloaded=await new Store(directory).init(),next=make(reloaded,request=>response(request));await next.recover();await next.recoverAutonomous();assert.equal(requests.length,1);assert.equal((await next.studies.read(botId,started.job.id)).status,'blocked');assert.equal((await next.studies.knowledge.list(botId)).total,0);
});

test('missing learning assignment or capabilities refuse intake before inference',async t=>{
  const {engine,store,requests}=await fixture(t,{install:false});await assert.rejects(engine.studies.start(botId,{sources:[upload(quote)]}),error=>error.status===409);assert.equal(requests.length,0);await store.mutate(state=>{state.bots[0].tools=['workspace','skills'];});await assert.rejects(engine.studies.start(botId,{sources:[upload(quote)]}),error=>error.status===403);assert.equal(requests.length,0);
});

test('Strict approval commits only the exact reviewed publication and then clears the prompt',async t=>{
  const {engine,store}=await fixture(t,{strict:true}),started=await engine.studies.start(botId,{sources:[upload(quote)]});await waitFor(()=>store.state.runs[botId]?.status==='waiting_for_approval');const run=store.state.runs[botId],approved=decision(run);assert.ok(run.pending_controls[0].arguments.approvalDigest);await engine.control(botId,'approval',{...approved,choice:'once'});
  const result=await settled(engine,started.job.id);assert.equal(result.run.status,'completed',result.run.error);assert.equal(result.job.result.committedCount,1);assert.deepEqual(result.run.pending_controls,[]);assert.equal((await engine.studies.knowledge.list(botId)).total,1);await assert.rejects(engine.control(botId,'approval',{...approved,choice:'once'}),error=>error.status===409);
});

test('an unsupported scan remains partial with zero inference or invented retained knowledge',async t=>{
  const {engine,requests,directory}=await fixture(t),started=await engine.studies.start(botId,{sources:[{name:'scan.png',contentBase64:Buffer.from('synthetic scan bytes').toString('base64')}]}),result=await settled(engine,started.job.id);
  assert.equal(result.job.status,'partial');assert.equal(result.run.status,'failed');assert.equal(result.job.result.committedCount,0);assert.equal(requests.length,0);assert.equal((await engine.studies.knowledge.list(botId)).total,0);assert.equal(result.job.coverage.partial[0].status,'unavailable');assert.equal(result.job.cleanup,'retained');assert.ok((await fs.stat(path.join(directory,'study-staging',result.job.id))).isDirectory());
});

test('invented source quotes fail candidate validation before publication',async t=>{
  const {engine}=await fixture(t,{complete:request=>{const result=response(request),input=JSON.parse(request.messages.at(-1).content);if(input.phase==='select'){const value=JSON.parse(result.text);value.candidates[0].evidence[0].quote='A quotation not present in the source.';result.text=JSON.stringify(value);}return result;}}),started=await engine.studies.start(botId,{sources:[upload(quote)]}),result=await settled(engine,started.job.id);assert.equal(result.run.status,'failed');assert.equal(result.job.candidates.length,0);assert.equal((await engine.studies.knowledge.list(botId)).total,0);
});

test('study work reserves the bot against another study or ordinary chat',async t=>{
  const {engine,store,requests}=await fixture(t,{complete:request=>waitUntilAborted(request.signal)}),started=await engine.studies.start(botId,{sources:[upload(quote)]});await waitFor(()=>requests.length===1);await assert.rejects(engine.studies.start(botId,{sources:[upload(quote)]}),error=>error.status===409);await assert.rejects(engine.start(botId,'Another task'),error=>error.status===409);assert.equal(store.state.runs[botId].id,started.run.id);const current=store.state.runs[botId];await engine.control(botId,'stop',{runId:current.id,remoteRunId:current.remoteRunId});await settled(engine,started.job.id);
});

test('repeated material in one study coalesces equal units and retains both source receipts',async t=>{
  const {engine}=await fixture(t),started=await engine.studies.start(botId,{sources:[upload(quote),upload(quote)]}),result=await settled(engine,started.job.id);assert.equal(result.run.status,'completed',result.run.error);assert.equal(result.job.processed.length,2);assert.equal(result.job.result.committedCount,1);const saved=await engine.studies.knowledge.list(botId);assert.equal(saved.total,1);assert.equal(saved.units[0].unit.evidence.length,2);
});

test('Stop owns and cancels intake before any source or inference is completed',async t=>{
  const {engine,store,requests}=await fixture(t);let intakeSignal;engine.studies.sources.stage=async(jobId,sources,{signal})=>{intakeSignal=signal;await waitUntilAborted(signal);};const started=await engine.studies.start(botId,{sources:[upload(quote)]});await waitFor(()=>intakeSignal);const run=store.state.runs[botId];assert.equal(run.id,started.run.id);await engine.control(botId,'stop',{runId:run.id,remoteRunId:run.remoteRunId});const result=await settled(engine,started.job.id);assert.equal(intakeSignal.aborted,true);assert.equal(result.job.status,'cancelled');assert.equal(result.run.status,'cancelled');assert.equal(requests.length,0);
});

test('expiry removes only owned temporary originals and preserves retained knowledge and explicit copies',async t=>{
  const {engine,directory}=await fixture(t);const first=await engine.studies.start(botId,{sources:[upload(quote)],keepOriginal:true});await settled(engine,first.job.id);const second=await engine.studies.start(botId,{sources:[{name:'unavailable.png',contentBase64:Buffer.from('unreadable').toString('base64')}]});await settled(engine,second.job.id);const ownerFile=path.join(directory,'workspaces',botId,'notes','owner.md');await fs.mkdir(path.dirname(ownerFile),{recursive:true});await fs.writeFile(ownerFile,'Owner content.');await engine.studies.expire({at:Date.now()+8*86400000});const expired=await engine.studies.read(botId,second.job.id);assert.equal(expired.cleanup,'expired');assert.equal(expired.candidates.length,0);assert.equal(expired.inventory.sources[0].availability,'expired');await assert.rejects(fs.stat(path.join(directory,'study-staging',second.job.id)),error=>error.code==='ENOENT');assert.ok((await fs.stat(path.join(directory,'study-staging',first.job.id))).isDirectory());assert.equal((await engine.studies.knowledge.list(botId)).total,1);assert.equal(await fs.readFile(ownerFile,'utf8'),'Owner content.');
});

test('image-capable study uses the pinned provider and retains interpretation provenance',async t=>{
  const {engine,store,requests}=await fixture(t,{complete:request=>{const input=JSON.parse(request.messages.at(-1).content);return input.phase==='visual-read'?{text:JSON.stringify({text:quote,warnings:[],uncertain:false})}:response(request);}});await store.mutate(state=>{state.connections[0].imageInput='on';});const {default:sharp}=await import('sharp'),{randomBytes}=await import('node:crypto'),bytes=await sharp(randomBytes(500*500*3),{raw:{width:500,height:500,channels:3}}).png().toBuffer(),started=await engine.studies.start(botId,{sources:[{name:'scan.png',contentBase64:bytes.toString('base64')}]}),result=await settled(engine,started.job.id);assert.equal(result.run.status,'completed',result.run.error);assert.ok(requests[0].messages.at(-1).imageParts[0].data);assert.equal(requests[0].tools.length,0);const learned=await engine.studies.knowledge.list(botId);assert.equal(learned.units[0].unit.evidence[0].locator.interpretation.kind,'model-visual-interpretation');assert.doesNotMatch(JSON.stringify(store.state),/Model visual interpretation/);
});

test('WAV study requires explicit transcription consent and pins the chosen connection',async t=>{
  const {engine,store,requests}=await fixture(t);let audioCalls=0;engine.options.speech={connection(connectionId){const value=store.state.connections.find(item=>item.id===connectionId);assert.ok(value);return value;},async transcribe(input,{signal}){audioCalls++;assert.equal(input.consent,true);assert.equal(input.model,'fixture-transcribe');assert.equal(signal.aborted,false);const bytes=Buffer.from(input.audio,'base64');assert.equal(bytes.readUInt32LE(24),16000);return {text:quote};}};
  const header=Buffer.alloc(44),pcm=Buffer.alloc(32000);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);const sources=[{name:'lesson.wav',contentBase64:Buffer.concat([header,pcm]).toString('base64')}],transcription={connectionId:'provider_study_fixture',model:'fixture-transcribe',consent:true};
  await assert.rejects(engine.studies.start(botId,{sources,transcription:{...transcription,consent:false}}),error=>error.status===400);assert.equal(audioCalls,0);const started=await engine.studies.start(botId,{sources,transcription}),result=await settled(engine,started.job.id);assert.equal(result.run.status,'completed',result.run.error);assert.equal(audioCalls,1);assert.equal(requests.length,2);const learned=await engine.studies.knowledge.list(botId);assert.equal(learned.units[0].unit.evidence[0].locator.interpretation.kind,'model-audio-transcription');assert.equal(result.job.audioIntervals,1);
});

test('a truncated billed response retains actual usage without publishing or claiming success',async t=>{
  const {engine,requests}=await fixture(t,{complete:()=>({text:'{"candidates":[',finishReason:'length',usage:{input_tokens:321,output_tokens:99}})}),started=await engine.studies.start(botId,{sources:[upload(quote)]}),result=await settled(engine,started.job.id);assert.equal(result.run.status,'failed');assert.equal(result.run.usage.input_tokens,321);assert.equal(result.run.usage.output_tokens,99);assert.equal(requests.length,1);assert.equal((await engine.studies.knowledge.list(botId)).total,0);
});

test('partial publication exposes actual saved units and keeps their batch for review',async t=>{
  const {engine}=await fixture(t,{complete:request=>{const result=response(request),input=JSON.parse(request.messages.at(-1).content);if(input.phase==='select'){const value=JSON.parse(result.text);value.candidates.push({...structuredClone(value.candidates[0]),title:'A second supported scope reminder'});result.text=JSON.stringify(value);}return result;}}),publish=engine.studies.knowledge.publish.bind(engine.studies.knowledge);let actions=0;engine.studies.knowledge.publish=(plan,options)=>publish(plan,{...options,guard:async()=>{await options.guard?.();if(++actions===2)throw new Error('Synthetic interruption after first committed unit.');}});
  const started=await engine.studies.start(botId,{sources:[upload(quote)]}),result=await settled(engine,started.job.id),view=engine.studies.view(result.job);assert.equal(result.run.status,'failed');assert.equal((await engine.studies.knowledge.list(botId)).total,1);assert.equal(view.retained,1);assert.equal(view.result.batches.length,1);assert.equal(view.result.batches[0].units.filter(unit=>unit.status==='committed').length,1);assert.equal(view.cleanup,undefined);
});

test('failed inline source intake records a terminal study instead of a ghost running job',async t=>{
  let chatCalls=0;const {engine}=await fixture(t,{complete:request=>{assert.ok(request.tools.length>0);return ++chatCalls===1?{text:'',toolCalls:[{id:'missing-source',name:'study_material',arguments:{sources:[{workspacePath:'documents/missing-learning-source.md'}]}}]}:{text:'The requested source was unavailable; no knowledge was saved.',toolCalls:[]};}}),started=await engine.start(botId,'Learn from the specified workspace source.');await engine.tasks.get(started.id);const jobs=await engine.studies.list(botId);assert.equal(jobs.jobs.length,1);assert.equal(jobs.jobs[0].status,'failed');assert.ok(jobs.jobs[0].error);assert.equal((await engine.studies.knowledge.list(botId)).total,0);
});
