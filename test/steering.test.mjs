import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { dashboard } from '../lib/dashboard.mjs';
import { backfillTaskOutcomes } from '../lib/task-outcomes.mjs';
import { createStudioServer } from '../server.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const answer=text=>({text,toolCalls:[]}),call=(id,name,arguments_)=>({id,name,arguments:arguments_});
const hold=(request,promise)=>Promise.race([promise,new Promise((_,reject)=>{const fail=()=>reject(request.signal.reason);if(request.signal.aborted)fail();else request.signal.addEventListener('abort',fail,{once:true});})]);
async function wait(predicate){const until=Date.now()+4000;while(Date.now()<until){const result=predicate();if(result)return result;await delay(5);}throw new Error('Guidance fixture timed out.');}
async function configure(store){await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',name:'Fixture',model:'fixture-model',secret:store.seal('disposable-fixture-key')});for(const bot of state.bots){bot.connectionId='fixture';bot.tools=['workspace','delegation'];}});}
async function fixture(t,complete){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-steering-')),store=await new Store(directory).init();await configure(store);const requests=[];
  const engine=new NativeEngine(store,{runTimeout:10000,providers:{async complete(connection,request){requests.push({connection:structuredClone(connection),request:structuredClone({...request,signal:undefined,onDelta:undefined})});return complete(request,requests.length);}}});
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});return {directory,store,engine,requests};
}
const input=(run,text='Keep the requested result concise.',clientUpdateId='guidance_update_001')=>({runId:run.id,remoteRunId:run.remoteRunId,clientUpdateId,text});

test('in-flight model actions are paired as unstarted after guidance and model/capability snapshots stay unchanged',async t=>{
  const blocked=gate(),f=await fixture(t,async(request,count)=>count===1?hold(request,blocked.promise):answer('The revised result.'));
  const run=await f.engine.start('bot_atlas','Original task title.');await wait(()=>f.requests.length===1);
  const updates=await Promise.all([f.engine.steer('bot_atlas',input(run)),f.engine.steer('bot_atlas',input(run))]);assert.equal(updates.filter(result=>result.duplicate).length,1);
  await assert.rejects(f.engine.steer('bot_atlas',input(run,'Changed under the same ID.')),error=>error.status===409);
  await f.store.mutate(state=>{state.bots[0].model='next-model';state.bots[0].tools=[];});
  blocked.resolve({text:'Old proposed work.',toolCalls:[call('old_write','workspace_write',{path:'old.txt',content:'Must not happen'})]});await wait(()=>f.store.state.runs.bot_atlas.status==='completed');
  await assert.rejects(fs.stat(path.join(f.directory,'workspaces/bot_atlas/old.txt')),error=>error.code==='ENOENT');assert.equal(f.requests.length,2);assert.ok(f.requests.every(item=>item.request.model==='fixture-model'));assert.ok(f.requests[1].request.tools.some(tool=>tool.name==='workspace_write'));
  const history=f.store.state.conversations.bot_atlas,result=history.find(message=>message.tool_call_id==='old_write');assert.equal(result.is_error,true);assert.equal(JSON.parse(result.content).outcome,'not_started');assert.ok(f.requests[1].request.messages.some(message=>message.role==='user'&&message.content.includes('Keep the requested result concise.')));
  const guidance=f.store.state.messages.bot_atlas.find(message=>message.kind==='steer');assert.equal(guidance.steerStatus,'applied');assert.equal(guidance.taskOutcome,undefined);assert.equal(f.store.state.messages.bot_atlas.filter(message=>message.role==='user'&&!message.kind).length,1);assert.equal(f.store.state.runs.bot_atlas.output,'The revised result.');
  backfillTaskOutcomes(f.store.state);assert.equal(guidance.taskOutcome,undefined);assert.ok(JSON.stringify(dashboard(f.store).activity).includes('Original task title'));assert.ok(!JSON.stringify(dashboard(f.store).activity).includes('Keep the requested result concise'));
});

test('an already admitted action settles once and later proposed actions are skipped before applying guidance',async t=>{
  const written=gate(),release=gate(),f=await fixture(t,async(_request,count)=>count===1?{text:'',toolCalls:[call('first_write','workspace_write',{path:'first.txt',content:'Committed once'}),call('later_write','workspace_write',{path:'later.txt',content:'Must not happen'})]}:answer('The first write finished; later work was revised.'));
  const execute=f.engine.tools.execute.bind(f.engine.tools);let writes=0;f.engine.tools.execute=async(bot,name,args,options)=>{const result=await execute(bot,name,args,options);if(name==='workspace_write'&&args.path==='first.txt'){writes++;written.resolve();await release.promise;}return result;};
  const run=await f.engine.start('bot_atlas','Write two files.');await written.promise;const update=await f.engine.steer('bot_atlas',input(run,'Do not start the second write.'));assert.deepEqual(update.admittedActions,['workspace_write']);release.resolve();await wait(()=>f.store.state.runs.bot_atlas.status==='completed');
  assert.equal(writes,1);assert.equal(await fs.readFile(path.join(f.directory,'workspaces/bot_atlas/first.txt'),'utf8'),'Committed once');await assert.rejects(fs.stat(path.join(f.directory,'workspaces/bot_atlas/later.txt')),error=>error.code==='ENOENT');assert.equal(f.store.state.runs.bot_atlas.workRecords.filter(record=>record.callId==='first_write'&&record.status==='succeeded').length,1);assert.equal(JSON.parse(f.store.state.conversations.bot_atlas.find(message=>message.tool_call_id==='later_write').content).outcome,'not_started');
});

for(const question of [false,true])test(`guidance committed before ${question?'question':'approval'} publication prevents a stale prompt`,async t=>{
  const ready=gate(),release=gate(),name=question?'ask_user':'workspace_write',args=question?{questions:[{id:'q',header:'Format',prompt:'Which format?'}]}:{path:'strict.txt',content:'Do not execute'},f=await fixture(t,async(_request,count)=>count===1?{text:'',toolCalls:[call('pending_action',name,args)]}:answer('Followed the additional guidance.'));
  await f.store.mutate(state=>{state.bots[0].approvalPolicy='strict';});const event=f.engine.event.bind(f.engine);f.engine.event=async(context,type,details)=>{await event(context,type,details);if(type==='tool.started'&&details.toolCallId==='pending_action'){ready.resolve();await release.promise;}};
  const run=await f.engine.start('bot_atlas','A task with a prompt.');await ready.promise;await f.engine.steer('bot_atlas',input(run,'Continue without that proposed prompt.'));release.resolve();await wait(()=>f.store.state.runs.bot_atlas.status==='completed');
  assert.ok(!f.store.state.runs.bot_atlas.events.some(event=>event.type===(question?'question.request':'approval.request')));assert.equal(f.store.state.messages.bot_atlas.find(message=>message.kind==='steer').steerStatus,'applied');if(!question)await assert.rejects(fs.stat(path.join(f.directory,'workspaces/bot_atlas/strict.txt')),error=>error.code==='ENOENT');
});

test('published and publishing prompts refuse guidance instead of validating an old action under new intent',async t=>{
  const ready=gate(),release=gate(),f=await fixture(t,async(_request,count)=>count===1?{text:'',toolCalls:[call('strict_write','workspace_write',{path:'strict.txt',content:'No'})]}:answer('Denied.'));
  await f.store.mutate(state=>{state.bots[0].approvalPolicy='strict';});const update=f.engine.update.bind(f.engine);f.engine.update=async(context,changes,options)=>{if(changes.status==='waiting_for_approval'){ready.resolve();await release.promise;}return update(context,changes,options);};
  const run=await f.engine.start('bot_atlas','Wait for exact approval.');await ready.promise;await assert.rejects(f.engine.steer('bot_atlas',input(run)),error=>error.status===409);release.resolve();await wait(()=>f.store.state.runs.bot_atlas.status==='waiting_for_approval');await assert.rejects(f.engine.steer('bot_atlas',input(run)),error=>error.status===409);
  const current=f.store.state.runs.bot_atlas,prompt=current.pending_controls[0];await f.engine.control('bot_atlas','approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:prompt.prompt_id,execution_generation:current.execution_generation,choice:'deny'});await wait(()=>f.store.state.runs.bot_atlas.status==='completed');assert.equal(f.store.state.messages.bot_atlas.filter(message=>message.kind==='steer').length,0);
});

test('an outstanding question rejects guidance until the exact owner answer or Skip is supplied',async t=>{
  const f=await fixture(t,async(_request,count)=>count===1?{text:'',toolCalls:[call('question','ask_user',{questions:[{id:'q',header:'Format',prompt:'Which format?'}]})]}:answer('Finished after the answer.')),run=await f.engine.start('bot_atlas','Ask a question.');await wait(()=>f.store.state.runs.bot_atlas.status==='waiting_for_input');await assert.rejects(f.engine.steer('bot_atlas',input(run)),error=>error.status===409);
  const current=f.store.state.runs.bot_atlas,prompt=current.pending_controls[0];await f.engine.control('bot_atlas','answer',{runId:run.id,remoteRunId:run.remoteRunId,request_id:prompt.prompt_id,execution_generation:current.execution_generation,skip:true});await wait(()=>f.store.state.runs.bot_atlas.status==='completed');assert.ok(!f.store.state.messages.bot_atlas.some(message=>message.kind==='steer'));
});

test('additional owner guidance cannot erase a previously declared required check',async t=>{
  const blocked=gate(),f=await fixture(t,async(request,count)=>count===1?hold(request,blocked.promise):answer('I ignored the required file and finished.')),run=await f.engine.start('bot_atlas','A verified task.');await wait(()=>f.requests.length===1);
  const required={id:'required_file',kind:'file_exists',path:'required.txt'};await f.store.mutate(state=>{state.runs.bot_atlas.outcomeChecks=[required];});await f.engine.steer('bot_atlas',input(run,'Ignore the old required file check.'));blocked.resolve(answer('An obsolete final response.'));await wait(()=>f.store.state.runs.bot_atlas.status==='failed');assert.deepEqual(f.store.state.runs.bot_atlas.outcomeChecks,[required]);assert.equal(f.store.state.runs.bot_atlas.verification.passed,false);assert.equal(f.store.state.messages.bot_atlas.find(message=>message.kind==='steer').steerStatus,'applied');
});

test('Stop cancels the already admitted child and queued owner guidance together',async t=>{
  const blocked=gate(),f=await fixture(t,async(request,count)=>request.messages[0].content.startsWith('You are Nova,')?hold(request,blocked.promise):count===1?{text:'',toolCalls:[call('delegate','delegate_task',{botId:'bot_nova',task:'An admitted specialist task.'})]}:answer('No replay.')),run=await f.engine.start('bot_atlas','Ask Nova.');await wait(()=>f.store.state.runs.bot_atlas.status==='waiting_for_delegate'&&f.store.state.runs.bot_nova?.status==='running'&&f.requests.length===2);await f.engine.steer('bot_atlas',input(run,'Add a clarification after this action.'));await f.engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});await wait(()=>f.store.state.runs.bot_atlas.status==='cancelled'&&f.store.state.runs.bot_nova.status==='cancelled');assert.equal(f.store.state.messages.bot_atlas.find(message=>message.kind==='steer').steerStatus,'cancelled');assert.equal(f.requests.length,2);
});

test('guidance before final-success admission supersedes the old final result',async t=>{
  const ready=gate(),release=gate(),f=await fixture(t,async(_request,count)=>answer(count===1?'Old final result.':'Updated final result.')),finish=f.engine.finish.bind(f.engine);let first=true;
  f.engine.finish=async(context,status,details)=>{if(status==='completed'&&first){first=false;ready.resolve();await release.promise;}return finish(context,status,details);};
  const run=await f.engine.start('bot_atlas','Finish this task.');await ready.promise;await f.engine.steer('bot_atlas',input(run,'Revise the wording before finishing.'));release.resolve();await wait(()=>f.store.state.runs.bot_atlas.status==='completed');assert.equal(f.store.state.runs.bot_atlas.output,'Updated final result.');assert.equal(f.store.state.messages.bot_atlas.filter(message=>message.role==='assistant'&&!message.partial).length,1);
});

test('finalization closes guidance admission and a concurrent Stop cannot commit success',async t=>{
  const ready=gate(),release=gate(),f=await fixture(t,async()=>answer('A final result.')),close=f.engine.backgroundProcesses.closeRun.bind(f.engine.backgroundProcesses);
  f.engine.backgroundProcesses.closeRun=async(...args)=>{ready.resolve();await release.promise;return close(...args);};const run=await f.engine.start('bot_atlas','Finish.');await ready.promise;assert.equal(f.store.state.runs.bot_atlas.steerClosing,true);await assert.rejects(f.engine.steer('bot_atlas',input(run)),error=>error.status===409);await f.engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});release.resolve();await wait(()=>f.store.state.runs.bot_atlas.status==='cancelled');assert.equal(f.store.state.messages.bot_atlas.some(message=>message.role==='assistant'&&!message.partial),false);
});

test('Stop cancels queued guidance, and restart never applies or replays its pending instruction',async t=>{
  const blocked=gate(),f=await fixture(t,request=>hold(request,blocked.promise));const run=await f.engine.start('bot_atlas','A task.');await wait(()=>f.requests.length===1);await f.engine.steer('bot_atlas',input(run));await f.engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});await wait(()=>f.store.state.runs.bot_atlas.status==='cancelled');assert.equal(f.store.state.messages.bot_atlas.find(message=>message.kind==='steer').steerStatus,'cancelled');assert.ok(!f.store.state.conversations.bot_atlas.some(message=>message.kind==='steer'));
  await f.store.mutate(state=>{const current=state.runs.bot_atlas;current.status='running';current.steering.updates[0].status='queued';state.messages.bot_atlas.find(message=>message.kind==='steer').steerStatus='queued';});const before=f.requests.length;await f.engine.recover();await f.engine.recoverAutonomous();assert.equal(f.requests.length,before);assert.equal(f.store.state.runs.bot_atlas.status,'cancelled');assert.equal(f.store.state.runs.bot_atlas.stopRequested,true);assert.equal(f.store.state.messages.bot_atlas.find(message=>message.kind==='steer').steerStatus,'cancelled');
});

test('guidance bounds and lane/run identities are enforced without starting another task',async t=>{
  const blocked=gate(),f=await fixture(t,request=>hold(request,blocked.promise)),run=await f.engine.start('bot_atlas','Bounded task.');await wait(()=>f.requests.length===1);
  await assert.rejects(f.engine.steer('bot_atlas',{...input(run),runId:'old_run'}),error=>error.status===409);await assert.rejects(f.engine.steer('bot_atlas',input(run,'x'.repeat(4001))),error=>error.status===400);
  for(let i=0;i<8;i++)await f.engine.steer('bot_atlas',input(run,'x'.repeat(4000),`guidance_update_${i}`));await assert.rejects(f.engine.steer('bot_atlas',input(run,'One too many.','guidance_update_9')),error=>error.status===429);assert.equal(f.store.state.runs.bot_atlas.id,run.id);assert.equal(f.store.state.runs.bot_atlas.steering.bytes,32000);
  await f.engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});await wait(()=>f.store.state.runs.bot_atlas.status==='cancelled');await assert.rejects(f.engine.steer('bot_atlas',input(run,'After the task ended.','guidance_new_terminal')),error=>error.status===409);
  const next=await f.engine.start('bot_nova','Room task.',{source:'room'});await assert.rejects(f.engine.steer('bot_nova',input(next)),error=>error.status===409);await f.engine.control('bot_nova','stop',{runId:next.id,remoteRunId:next.remoteRunId});
});

test('the owner guidance route enforces session, CSRF, current run identity and idempotent receipts',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-steering-http-')),blocked=gate(),app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers:{complete:(_connection,request)=>hold(request,blocked.promise)}});const {url}=await app.listen(0);let cookie='',csrf='';
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const request=async(route,{data,authenticated=true,csrfValid=true}={})=>{const response=await fetch(`${url}${route}`,{method:'POST',headers:{...(authenticated?{Cookie:cookie}:{}),...(csrfValid?{'X-CSRF-Token':csrf}:{}),'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  const setup=await request('/api/setup',{data:{token:app.bootstrapToken,password:'disposable-fixture-password'}});cookie=setup.cookie;csrf=setup.body.csrf;await configure(app.store);const start=await request('/api/bots/bot_atlas/messages',{data:{text:'A real HTTP task.'}}),run=start.body.run,endpoint='/api/bots/bot_atlas/steer';
  assert.equal((await request(endpoint,{data:input(run),authenticated:false})).status,401);assert.equal((await request(endpoint,{data:input(run),csrfValid:false})).status,403);assert.equal((await request(endpoint,{data:input(run)})).status,202);const repeated=await request(endpoint,{data:input(run)});assert.equal(repeated.status,200);assert.equal(repeated.body.duplicate,true);assert.equal((await request(endpoint,{data:input(run,'Different.')})).status,409);
  await request('/api/bots/bot_atlas/stop',{data:{runId:run.id,remoteRunId:run.remoteRunId}});await wait(()=>app.store.state.runs.bot_atlas.status==='cancelled');assert.equal(app.store.state.messages.bot_atlas.filter(message=>message.kind==='steer').length,1);
});
