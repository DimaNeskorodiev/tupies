import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const source=await readFile(new URL('../public/study-learning.js',import.meta.url),'utf8');
const settle=async(rounds=10)=>{for(let i=0;i<rounds;i++)await new Promise(resolve=>setImmediate(resolve));};
const inert=value=>JSON.parse(JSON.stringify(value));
function job(overrides={}){return {id:'study_123456789012345678',runId:'run-study-1',status:'completed',phase:'finished',focus:'SEO audit methods',processed:3,candidates:2,retained:2,cleanup:'removed',sources:[{name:'Synthetic handbook.pdf',status:'ready',coverage:{segments:3,readable:3,failed:0},warnings:[]}],...overrides};}
function fixture(t,{jobs=[],api,skills=true,clock=false}={}){
  const dom=new JSDOM('<!doctype html><div id="page"></div>',{url:'https://tupies.test/#/bots/bot_atlas/learning',runScripts:'outside-only'}),w=dom.window,calls=[],timers=new Map();let now=10000,nextTimer=0;
  t.after(()=>w.close());Object.defineProperty(w.document,'visibilityState',{value:'visible',configurable:true});
  if(clock){w.Date.now=()=>now;w.setTimeout=(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id;};w.clearTimeout=id=>timers.delete(id);}
  vm.runInContext(source,dom.getInternalVMContext(),{filename:'study-learning.js'});
  const bot={id:'bot_atlas',name:'Atlas',title:'SEO specialist',tools:['workspace','memory','skills'],skills:['learning-1']};
  const data={skills:skills?[{id:'learning-1',catalogId:'tupies-learn-from-material'}]:[]},state={jobs},ctx={data,botStatus:()=>({className:'ready'}),errorText:error=>error.message,shortDate:value=>value.slice(0,10),toast:()=>{},api:async(route,options={})=>{calls.push({route,...options});if(api){const result=await api(route,options,state);if(result!==undefined)return result;}if(route.endsWith('/studies')&&!options.method)return {jobs:state.jobs};if(route.endsWith('/studies')&&options.method==='POST'){const current=job({status:'running',phase:'reading',processed:0,candidates:0,retained:0});state.jobs=[current];return {job:current,run:{id:current.runId}};}if(route.endsWith('/stop')){state.jobs=state.jobs.map(value=>({...value,status:'cancelled'}));return {stopped:true};}throw new Error(`Unexpected fixture request ${route}`);}};
  const page=w.document.getElementById('page'),component=w.StudioStudyLearning;
  function render(){page.innerHTML=component.render(bot,ctx);component.mount(bot,ctx,page);}
  render();
  const find=selector=>page.querySelector(selector),click=selector=>find(selector).click(),input=(key,value)=>{const field=find(`[data-study-input="${key}"]`);field.value=value;field.dispatchEvent(new w.Event('input',{bubbles:true}));return field;};
  function select(files){const field=find('[data-study-input="files"]');Object.defineProperty(field,'files',{value:files,configurable:true});field.dispatchEvent(new w.Event('change',{bubbles:true}));}
  function submit(name='start'){find(`[data-study-form="${name}"]`).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));}
  async function tick(){now+=2100;const entry=[...timers].find(([,timer])=>timer.delay===2000);if(entry){timers.delete(entry[0]);entry[1].fn();await settle();}}
  return {w,dom,bot,ctx,state,calls,timers,page,component,render,find,click,input,select,submit,tick};
}

test('file selection stays local, drafts and file references survive profile rerenders, and Start admits exact bytes',async t=>{
  const f=fixture(t);await settle();
  const file=new f.w.File(['Synthetic useful SEO source.'],'handbook.txt',{type:'text/plain'});f.select([file]);
  const focus=f.input('focus','Retain useful audit prerequisites.');focus.focus();focus.setSelectionRange(7,13);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
  f.render();assert.equal(f.find('[data-study-input="focus"]').value,'Retain useful audit prerequisites.');assert.equal(f.w.document.activeElement,f.find('[data-study-input="focus"]'));assert.equal(f.w.document.activeElement.selectionStart,7);assert.match(f.find('[data-study-files]').textContent,/handbook.txt/);
  f.submit();await settle(20);
  const post=f.calls.find(call=>call.method==='POST');assert.match(post.route,/\/studies$/);assert.deepEqual(inert(post.body.sources.map(source=>source.name)),['handbook.txt']);assert.equal(Buffer.from(post.body.sources[0].contentBase64,'base64').toString(),'Synthetic useful SEO source.');assert.equal(post.body.keepOriginal,false);assert.equal(post.body.focus,'Retain useful audit prerequisites.');
  assert.match(f.find('[data-study-notice]').textContent,/Learning started/);assert.match(f.find('[data-study-files]').textContent,/No files/);
});

test('file and URL admission limits prevent requests and missing capabilities are actionable',async t=>{
  const f=fixture(t);await settle();const large=new f.w.File(['tiny'],'large.pdf');Object.defineProperty(large,'size',{value:24_000_001});f.select([large]);f.submit();await settle();
  assert.match(f.find('[data-study-error]').textContent,/24 MB/);assert.equal(f.calls.some(call=>call.method==='POST'),false);assert.equal(f.find('[data-study-start]').disabled,true);
  f.click('[data-study-action="remove-file"]');f.input('url','https://private.invalid/video');f.submit();await settle();assert.match(f.find('[data-study-error]').textContent,/public HTTPS YouTube/);assert.equal(f.calls.some(call=>call.method==='POST'),false);
  const missing=fixture(t,{skills:false});await settle();assert.match(missing.find('[data-study-capability]').textContent,/Install Learn from material/);assert.equal(missing.find('[data-study-start]').disabled,true);
});

test('read failures preserve selected files and do not claim learning started',async t=>{
  const f=fixture(t,{api:async(_route,options)=>{if(options.method==='POST')throw new Error('The selected provider is unavailable.');}});await settle();f.select([new f.w.File(['content'],'source.txt')]);f.submit();await settle(20);
  assert.match(f.find('[data-study-error]').textContent,/provider is unavailable/);assert.match(f.find('[data-study-files]').textContent,/source.txt/);assert.equal(f.find('[data-study-notice]').textContent,'');
});

test('job warnings, filenames, focus and retained outputs render as bounded text with honest media and retention labels',async t=>{
  const f=fixture(t,{jobs:[job({status:'partial',focus:'<img src=x onerror=alert(1)>',sources:[{name:'<script>source</script>',status:'partial',coverage:{readable:2,failed:1},warnings:['Only captions were processed; frames were not inspected.']}],cleanup:'retained',expiresAt:'2026-11-08T12:00:00Z'})]});await settle();
  assert.equal(f.page.querySelector('img,script'),null);assert.match(f.find('[data-study-jobs]').textContent,/Partial result/);assert.match(f.find('[data-study-jobs]').textContent,/2 saved/);assert.match(f.find('[data-study-jobs]').textContent,/Only captions were processed/);assert.match(f.find('[data-study-jobs]').textContent,/Recovery expiry: 2026-11-08/);assert.match(f.page.textContent,/YouTube path does not inspect audio or video frames/);
});

test('Stop uses the selected job exact run identity and preserves already saved outputs in its message',async t=>{
  const current=job({status:'running',phase:'checking'}),f=fixture(t,{jobs:[current]});await settle();f.click('[data-study-action="stop"]');await settle();
  const stop=f.calls.find(call=>call.route.endsWith('/stop'));assert.deepEqual(inert(stop.body),{runId:current.runId,remoteRunId:current.runId});assert.match(f.find('[data-study-notice]').textContent,/saved knowledge is preserved/);assert.match(f.find('[data-study-jobs]').textContent,/Stopped/);
});

test('two-second polling stops when hidden or detached and resumes visibly for active jobs',async t=>{
  const f=fixture(t,{jobs:[job({status:'running',phase:'selecting'})],clock:true});await settle();assert.ok([...f.timers.values()].some(timer=>timer.delay===2000));const before=f.calls.length;await f.tick();assert.equal(f.calls.length,before+1);
  Object.defineProperty(f.w.document,'visibilityState',{value:'hidden',configurable:true});f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));assert.equal(f.timers.size,0);const hidden=f.calls.length;await f.tick();assert.equal(f.calls.length,hidden);
  Object.defineProperty(f.w.document,'visibilityState',{value:'visible',configurable:true});f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));await settle();assert.equal(f.calls.length,hidden+1);
  f.page.innerHTML='';const detached=f.calls.length;await f.tick();assert.equal(f.calls.length,detached);assert.equal(f.timers.size,0);
});

test('batch revert requires a concrete preview and explicit confirm, while cancel makes no publication call',async t=>{
  const batchId='kp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',plan={id:'kp-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',approvalDigest:'c'.repeat(64),actions:[{tool:'knowledge_deactivate',args:{path:'tupies-managed-knowledge/unit.md',expectedSha256:'d'.repeat(64),status:'superseded'}}]},f=fixture(t,{jobs:[job({result:{committedCount:1,batches:[{id:batchId,committedCount:1,units:[]}]}})],api:async(route,options)=>{if(route.endsWith('/preview-rollback'))return plan;if(route.endsWith('/knowledge/publish'))return {status:'completed'};}});await settle();
  f.click('[data-study-action="rollback"]');await settle();assert.match(f.find('[data-study-review]').textContent,/Review revert/);assert.equal(f.calls.some(call=>call.route.endsWith('/knowledge/publish')),false);
  f.click('[data-study-action="cancel-review"]');assert.equal(f.find('[data-study-review]').textContent,'');assert.equal(f.calls.some(call=>call.route.endsWith('/knowledge/publish')),false);
  f.click('[data-study-action="rollback"]');await settle();f.click('[data-study-action="confirm-review"]');await settle();const publish=f.calls.find(call=>call.route.endsWith('/knowledge/publish'));assert.deepEqual(inert(publish.body),{planId:plan.id,approvalDigest:plan.approvalDigest});assert.match(f.find('[data-study-notice]').textContent,/Original source files were preserved/);
});

test('owner correction keeps the exact knowledge revision and uses preview before saving',async t=>{
  const unitId=`unit-${'a'.repeat(32)}`,sha='b'.repeat(64),plan={id:'kp-'+ 'c'.repeat(32),approvalDigest:'d'.repeat(64),actions:[]},unit={type:'principle',title:'Canonical target',content:'Old source-derived explanation.',support:'direct',scope:'SEO',conditions:['Indexable target'],exceptions:['Canonical is a hint']};
  const f=fixture(t,{jobs:[job({result:{committedCount:1,batches:[{id:'batch',committedCount:1,units:[{id:unitId,path:`tupies-managed-knowledge/${unitId}.md`,title:unit.title,status:'committed'}]}]}})],api:async(route)=>{if(route.includes('/knowledge/units/'))return {id:unitId,sha256:sha,revision:2,unit};if(route.endsWith('/preview-correction'))return plan;if(route.endsWith('/knowledge/publish'))return {status:'completed'};}});await settle();
  f.click('[data-study-action="unit"]');await settle();f.input('correction-content','Corrected scoped knowledge.');f.input('correction-reason','Owner verified the missing qualification.');f.submit('correction');await settle();
  assert.equal(f.find('[data-study-input="correction-method-steps"]'),null);
  const preview=f.calls.find(call=>call.route.endsWith('/preview-correction'));assert.equal(preview.body.expectedSha256,sha);assert.equal(preview.body.unitId,unitId);assert.equal(preview.body.content,'Corrected scoped knowledge.');assert.deepEqual(inert(preview.body.conditions),['Indexable target']);assert.equal(f.calls.some(call=>call.route.endsWith('/knowledge/publish')),false);
  f.click('[data-study-action="confirm-review"]');await settle();assert.match(f.find('[data-study-notice]').textContent,/correction saved/);
});

test('method corrections expose the saved sequence and checks and preview explicit reordered fields',async t=>{
  const unitId=`unit-${'e'.repeat(32)}`,sha='f'.repeat(64),unit={type:'method',title:'Review canonical eligibility',content:'Check the canonical target.',support:'direct',scope:'SEO',conditions:[],exceptions:[],method:{inputs:['Preferred URL'],steps:['Inspect canonical hints.','Check indexability.'],outputs:['Audit finding'],checks:['Confirm the actual response.']}},plan={id:'kp-'+ 'a'.repeat(32),approvalDigest:'b'.repeat(64),actions:[]};
  const f=fixture(t,{jobs:[job({result:{committedCount:1,batches:[{id:'batch',committedCount:1,units:[{id:unitId,path:`tupies-managed-knowledge/${unitId}.md`,title:unit.title,status:'committed'}]}]}})],api:async(route)=>{if(route.includes('/knowledge/units/'))return {id:unitId,sha256:sha,revision:1,unit};if(route.endsWith('/preview-correction'))return plan;}});await settle();
  f.click('[data-study-action="unit"]');await settle();
  assert.equal(f.find('[data-study-input="correction-method-steps"]').value,'Inspect canonical hints.\nCheck indexability.');
  assert.equal(f.find('[data-study-input="correction-method-checks"]').value,'Confirm the actual response.');
  assert.equal(f.find('[data-study-input="correction-method-inputs"]').required,false);
  assert.equal(f.find('[data-study-input="correction-method-steps"]').required,true);
  f.input('correction-method-steps',' Check indexability.\n\nInspect canonical hints. ');f.input('correction-method-checks','Confirm the response.\nVerify indexability.');f.input('correction-method-inputs','Preferred URL\nLive response');f.input('correction-method-outputs','Scoped audit finding');f.input('correction-reason','Owner corrected the required order.');
  f.render();assert.equal(f.find('[data-study-input="correction-method-steps"]').value,' Check indexability.\n\nInspect canonical hints. ');
  f.submit('correction');await settle();const preview=f.calls.find(call=>call.route.endsWith('/preview-correction'));
  assert.equal(preview.body.expectedSha256,sha);assert.deepEqual(inert(preview.body.method),{inputs:['Preferred URL','Live response'],steps:['Check indexability.','Inspect canonical hints.'],outputs:['Scoped audit finding'],checks:['Confirm the response.','Verify indexability.']});
  assert.equal(f.calls.some(call=>call.route.endsWith('/knowledge/publish')),false);assert.match(f.find('[data-study-review]').textContent,/Review correction/);
  f.input('correction-method-checks',' ');f.submit('correction');await settle();assert.match(f.find('[data-study-review]').textContent,/Method checks need 1–20 lines/);assert.equal(f.calls.filter(call=>call.route.endsWith('/preview-correction')).length,1);
  f.input('correction-method-checks','Verify the actual response.');f.input('correction-method-steps',Array.from({length:31},(_,i)=>`Step ${i+1}`).join('\n'));f.submit('correction');await settle();assert.match(f.find('[data-study-review]').textContent,/Method steps need 1–30 lines/);assert.equal(f.calls.filter(call=>call.route.endsWith('/preview-correction')).length,1);
  f.input('correction-method-steps','x'.repeat(1001));f.submit('correction');await settle();assert.match(f.find('[data-study-review]').textContent,/at most 1000 characters/);assert.equal(f.calls.filter(call=>call.route.endsWith('/preview-correction')).length,1);
});

test('audio requires an explicit connection, available model and fresh consent with no automatic choices',async t=>{
  const f=fixture(t,{api:async(route)=>route.startsWith('/api/speech/catalog')?{transcription:[{id:'speech-fixture-model',name:'Synthetic transcription'}]}:undefined});
  f.ctx.data.connections=[{id:'speech-fixture',type:'openrouter',hasKey:true,name:'Fixture audio connection'}];await settle();f.render();f.select([new f.w.File(['synthetic wav placeholder'],'recording.wav')]);f.submit();await settle();assert.equal(f.calls.some(call=>call.method==='POST'),false);assert.match(f.find('[data-study-error]').textContent,/enable audio transcription/);
  const check=(key,value)=>{const field=f.find(`[data-study-input="${key}"]`);field.checked=value;field.dispatchEvent(new f.w.Event('change',{bubbles:true}));},choose=(key,value)=>{const field=f.find(`[data-study-input="${key}"]`);field.value=value;field.dispatchEvent(new f.w.Event('change',{bubbles:true}));};
  check('audio-enabled',true);assert.equal(f.find('[data-study-input="audio-connection"]').value,'');choose('audio-connection','speech-fixture');await settle();assert.equal(f.find('[data-study-input="audio-model"]').value,'');choose('audio-model','speech-fixture-model');assert.equal(f.find('[data-study-input="audio-consent"]').checked,false);check('audio-consent',true);f.input('audio-language','uk');f.submit();await settle(20);
  const post=f.calls.find(call=>call.route.endsWith('/studies')&&call.method==='POST');assert.deepEqual(inert(post.body.transcription),{connectionId:'speech-fixture',model:'speech-fixture-model',language:'uk',consent:true});
});

test('expired recovery sources and explicitly kept originals have distinct retention language',async t=>{
  const f=fixture(t,{jobs:[job({status:'expired',cleanup:'expired',expiresAt:'2026-11-08T00:00:00Z'}),job({id:'study_999999999999999999',keepOriginal:true,cleanup:'retained',expiresAt:'2026-11-08T00:00:00Z'})]});await settle();
  assert.match(f.find('[data-study-jobs]').textContent,/Sources expired/);assert.match(f.find('[data-study-jobs]').textContent,/Temporary sources expired and are unavailable/);assert.match(f.find('[data-study-jobs]').textContent,/kept locally on this engine by your choice/);assert.doesNotMatch(f.find('[data-study-jobs]').textContent,/Recovery expiry/);
});

test('session clear drops unsent files and drafts, aborts encoding and prevents a stale upload in the next session',async t=>{
  const f=fixture(t);await settle();let reader;
  f.w.FileReader=class {constructor(){reader=this;}readAsDataURL(){}abort(){this.aborted=true;this.onabort?.();}};
  f.select([new f.w.File(['previous session private source'],'private-source.txt')]);f.input('focus','Previous session private focus');f.submit();assert.ok(reader);
  f.component.clear();assert.equal(reader.aborted,true);f.render();await settle();
  assert.equal(f.find('[data-study-input="focus"]').value,'');assert.match(f.find('[data-study-files]').textContent,/No files/);assert.equal(f.calls.some(call=>call.method==='POST'),false);assert.doesNotMatch(f.page.textContent,/Previous session private focus|private-source.txt/);
  reader.result='data:text/plain;base64,c3RhbGU=';reader.onload?.();await settle();assert.equal(f.calls.some(call=>call.method==='POST'),false);
});

test('a list response from a cleared session cannot populate the same bot in a later session',async t=>{
  let release,first=true;const f=fixture(t,{api:async(route,options)=>{if(route.endsWith('/studies')&&!options.method&&first){first=false;return new Promise(resolve=>{release=resolve;});}}});
  assert.ok(release);f.component.clear();f.render();await settle();release({jobs:[job({focus:'Previous session private study'})]});await settle();assert.doesNotMatch(f.find('[data-study-jobs]').textContent,/Previous session private study/);
});
