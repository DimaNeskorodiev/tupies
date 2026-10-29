import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { createStudioServer } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { dashboard } from '../lib/dashboard.mjs';

const KEY='studio-dashboard-fixture-key-never-public';
const SECRET='dashboard-secret-value-must-never-leave-1234567890';
const answer=text=>({id:'response-fixture',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:10,output_tokens:5}});
const call=(name,args,id='call-fixture')=>({id:'response-tools',status:'completed',output:[{type:'function_call',call_id:id,name,arguments:JSON.stringify(args)}],usage:{input_tokens:10,output_tokens:3}});
const ago=minutes=>new Date(Date.now()-minutes*60_000).toISOString();
const artifact=(botId,file,size=2400)=>({path:file,name:file.split('/').at(-1),format:file.split('.').at(-1),mime:'application/octet-stream',size,downloadUrl:`/api/bots/${botId}/files/download?path=${encodeURIComponent(file)}`});

async function serverFixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-dashboard-api-'));
  const remote={handler:()=>answer('A fixture answer.')};
  const provider=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const input=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
    res.setHeader('content-type','application/json');
    if(req.headers.authorization!==`Bearer ${KEY}`){res.writeHead(401);res.end(JSON.stringify({error:{message:'Unauthorized'}}));return;}
    if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'fixture-model',name:'Fixture model'}]}));return;}
    if(req.url==='/v1/responses'){res.end(JSON.stringify(await remote.handler(input)));return;}
    res.writeHead(404);res.end('{}');
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,requestTimeout:2000,runTimeout:5000});
  const {url}=await app.listen(0);let cookie='',csrf='';
  async function request(route,{method='GET',data,headers={}}={}) {
    const response=await fetch(`${url}${route}`,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...(csrf&&method!=='GET'?{'X-CSRF-Token':csrf}:{}),...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});
    const text=await response.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:response.status,body,response};
  }
  const setup=async()=>{const result=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'fixture-workspace-password'}});assert.equal(result.status,201);cookie=result.response.headers.get('set-cookie').split(';')[0];csrf=result.body.csrf;};
  const connect=async()=>{const result=await request('/api/connections',{method:'POST',data:{name:'Fixture provider',type:'openai',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:KEY,defaultModel:'fixture-model'}});assert.equal(result.status,201,JSON.stringify(result.body));};
  const wait=async(predicate,botId='bot_atlas')=>{const deadline=Date.now()+4000;while(Date.now()<deadline){const run=app.store.state.runs[botId];if(predicate(run))return run;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Run did not reach the expected state: ${JSON.stringify(app.store.state.runs[botId]?.status)}`);};
  t.after(async()=>{await app.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  return {app,remote,request,setup,connect,wait,url,get cookie(){return cookie;}};
}

async function storeFixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-dashboard-store-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init(),state=store.state;
  state.connections.push({id:'conn_fixture',type:'openai',name:'Fixture provider',status:'connected',secret:store.seal(SECRET)});
  for(const bot of state.bots)bot.connectionId='conn_fixture';
  return store;
}

test('the dashboard requires a session and answers 304 until its own content changes',async t=>{
  const f=await serverFixture(t);
  assert.equal((await f.request('/api/dashboard')).status,401);
  await f.setup();
  const first=await f.request('/api/dashboard'),tag=first.response.headers.get('etag');
  assert.equal(first.status,200);assert.ok(tag);assert.equal(first.response.headers.get('cache-control'),'no-store');
  assert.deepEqual(Object.keys(first.body).sort(),['activity','counts','files','needs','routines','working']);
  // The three seed bots have no provider yet, which is exactly one thing the owner must fix.
  const [chief,nova,scout]=f.app.store.state.bots;
  assert.equal(first.body.needs.length,1);assert.equal(first.body.needs[0].kind,'setup');assert.equal(first.body.needs[0].title,`${chief.name}, ${nova.name} and ${scout.name} need a model provider`);
  assert.equal((await f.request('/api/dashboard',{headers:{'If-None-Match':tag}})).status,304);
  // An unrelated commit recomputes the tag, which still matches unchanged dashboard content.
  await f.app.store.mutate(state=>{state.settings.unrelated=true;});
  assert.equal((await f.request('/api/dashboard',{headers:{'If-None-Match':tag}})).status,304);
  await f.app.store.mutate(state=>{state.routines.push({id:'routine_fixture',name:'Morning digest',botId:'bot_atlas',prompt:'Summarize.',intervalMinutes:60,enabled:true,nextRunAt:new Date(Date.now()+3_600_000).toISOString()});});
  const changed=await f.request('/api/dashboard',{headers:{'If-None-Match':tag}});
  assert.equal(changed.status,200);assert.notEqual(changed.response.headers.get('etag'),tag);assert.equal(changed.body.routines[0].status,'scheduled');
  assert.equal((await fetch(`${f.url}/api/dashboard`,{headers:{'If-None-Match':changed.response.headers.get('etag')}})).status,401);
});

test('a real document run shows its verified file and a readable timeline entry; approvals point at the exact action',async t=>{
  const f=await serverFixture(t);await f.setup();await f.connect();
  f.remote.handler=input=>input.input.some(item=>item.type==='function_call_output')?answer('The brief is ready.'):call('documents_create',{path:'reports/launch-brief.md',document:{content:'# Launch brief\n\nReady.'}});
  assert.equal((await f.request('/api/bots/bot_nova/messages',{method:'POST',data:{text:'Draft the launch brief\nwith the latest positioning.'}})).status,202);
  const run=await f.wait(value=>value?.status==='completed','bot_nova');
  assert.equal(run.artifacts.length,1);
  const {body}=await f.request('/api/dashboard');
  assert.equal(body.files.length,1);
  assert.deepEqual({botId:body.files[0].botId,name:body.files[0].name,path:body.files[0].path,format:body.files[0].format,runId:body.files[0].runId},{botId:'bot_nova',name:'launch-brief.md',path:'reports/launch-brief.md',format:'md',runId:run.id});
  assert.equal(body.files[0].downloadUrl,'/api/bots/bot_nova/files/download?path=reports%2Flaunch-brief.md');
  const created=body.activity.find(item=>item.kind==='file');
  assert.equal(created.subject,'Nova');assert.equal(created.text,'created launch-brief.md');assert.equal(created.detail,'Draft the launch brief');
  assert.equal(created.files[0].path,'reports/launch-brief.md');
  assert.ok(!body.activity.some(item=>item.text==='started a task'),'a finished run is shown once');
  assert.ok(!JSON.stringify(body).includes(f.app.store.directory),'no host paths');

  f.remote.handler=input=>input.input.some(item=>item.type==='function_call_output')?answer('Handled.'):call('workspace_delete',{path:'notes.md'});
  await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Tidy the workspace'}});
  const waiting=await f.wait(value=>value?.status==='waiting_for_approval');
  const needs=(await f.request('/api/dashboard')).body.needs.filter(item=>item.kind==='approval');
  assert.equal(needs.length,1);
  assert.deepEqual({botId:needs[0].botId,runId:needs[0].runId,title:needs[0].title,task:needs[0].task,nav:needs[0].nav,action:needs[0].action},{botId:'bot_atlas',runId:waiting.id,title:'Delete notes.md',task:'Tidy the workspace',nav:'/bot/bot_atlas',action:'Review action'});
  assert.ok(!(await f.request('/api/dashboard')).body.working.some(item=>item.botId==='bot_atlas'),'a bot waiting on you is listed once, under Needs you');
  assert.equal((await f.request('/api/bots/bot_atlas/stop',{method:'POST',data:{runId:waiting.id,remoteRunId:waiting.remoteRunId}})).status,200);
  await f.wait(value=>value?.status==='cancelled');
});

test('needs, working and routines map run state into plain words',async t=>{
  const store=await storeFixture(t),state=store.state;
  state.bots.push({...state.bots[0],id:'bot_flux',name:'Flux'},{...state.bots[0],id:'bot_sage',name:'Sage'},{...state.bots[0],id:'bot_echo',name:'Echo',connectionId:''});
  state.messages.bot_atlas=[{id:'m1',role:'user',content:'Run project checks',runId:'run_atlas',createdAt:ago(5),source:'chat'}];
  state.runs.bot_atlas={id:'run_atlas',botId:'bot_atlas',status:'waiting_for_approval',createdAt:ago(5),updatedAt:ago(1),pending_controls:[{kind:'approval',prompt_id:'approval_1',tool:'shell_run',arguments:{executable:'/opt/homebrew/bin/npm',args:['test','--','--watch=false']}}],events:[{type:'approval.request',createdAt:ago(2)}]};
  state.runs.bot_nova={id:'run_nova',botId:'bot_nova',status:'waiting_for_input',source:'chat',createdAt:ago(9),updatedAt:ago(3),pending_controls:[{kind:'question',prompt_id:'question_1',questions:[{id:'scope',header:'Scope',prompt:'Which projects belong in the weekly review?'},{id:'tone',header:'Tone',prompt:'Formal?'}]}],events:[{type:'question.request',createdAt:ago(3)}]};
  state.messages.bot_scout=[{id:'m2',role:'user',content:'## Compare launch channels\nUse public data.',runId:'run_scout',createdAt:ago(4)}];
  state.runs.bot_scout={id:'run_scout',botId:'bot_scout',status:'running',createdAt:ago(4),updatedAt:ago(0),plan:{version:2,steps:[{id:'a',title:'Collect sources',status:'completed'},{id:'b',title:'Reading source 4 of 6',status:'in_progress'},{id:'c',title:'Summarize',status:'pending'}]},events:[]};
  state.runs.bot_flux={id:'run_flux',botId:'bot_flux',status:'running',source:'routine',routineId:'routine_digest',createdAt:ago(2),updatedAt:ago(0),events:[{type:'model.started'},{type:'tool.started',tool:'documents_create',arguments:{path:'reports/sprint plan.xlsx'}}]};
  state.runs.bot_sage={id:'run_sage',botId:'bot_sage',status:'waiting_for_delegate',createdAt:ago(1),updatedAt:ago(0),events:[{type:'delegation.started',targetBotId:'bot_scout'}]};
  state.rooms.push({id:'room_launch',name:'Launch room',botIds:['bot_atlas','bot_nova'],autoCollaborate:true,maxRounds:4});
  state.roomDrives.room_launch={id:'drive_1',roomId:'room_launch',status:'queued',botIds:['bot_atlas','bot_nova'],remaining:['bot_atlas'],currentBotId:null,createdAt:ago(1),updatedAt:ago(1)};
  state.roomMessages.room_launch=[{id:'rm1',role:'user',content:'Plan the launch week',driveId:'drive_1',createdAt:ago(1)}];
  state.connections.push({id:'conn_broken',type:'anthropic',name:'Backup provider',status:'error',error:`Rejected credential ${SECRET}`});
  state.bots.find(bot=>bot.id==='bot_sage').connectionId='conn_broken';
  state.routines.push(
    {id:'routine_digest',name:'Morning digest',botId:'bot_flux',prompt:'Digest.',intervalMinutes:1440,enabled:true,lastRunAt:ago(30),nextRunAt:new Date(Date.now()+3*3_600_000).toISOString(),lastRunId:'run_old_digest'},
    {id:'routine_review',name:'Weekly review',botId:'bot_atlas',prompt:'Review.',intervalMinutes:10080,enabled:true,lastRunAt:ago(10),nextRunAt:ago(-60),lastRunId:'run_atlas'},
    {id:'routine_broken',name:'Inbox sweep',botId:'bot_scout',prompt:'Sweep.',intervalMinutes:60,enabled:true,lastRunAt:ago(20),nextRunAt:ago(-40),lastError:`Provider rejected ${SECRET}`},
    {id:'routine_new',name:'Quarterly plan',botId:'bot_scout',prompt:'Plan.',intervalMinutes:43200,enabled:false,nextRunAt:null},
  );
  state.messages.bot_flux=[{id:'m3',role:'user',content:'Digest.',runId:'run_old_digest',source:'routine',createdAt:ago(30)},{id:'m4',role:'assistant',content:'Done.',runId:'run_old_digest',createdAt:ago(29),attachments:[artifact('bot_flux','digest.pdf')]}];
  state.activity.unshift({id:'event_old',type:'run.completed',title:'Flux: completed',botId:'bot_flux',runId:'run_old_digest',createdAt:ago(29)});

  const result=dashboard(store,{busy:{bot_echo:'Mac mini',bot_scout:'Ignored because it is active here'}});
  const approval=result.needs.find(item=>item.kind==='approval');
  assert.equal(approval.title,'Run npm test -- --watch=false');assert.equal(approval.task,'Run project checks');assert.equal(approval.nav,'/bot/bot_atlas');
  const question=result.needs.find(item=>item.kind==='question');
  assert.equal(question.title,'Which projects belong in the weekly review?');assert.equal(question.detail,'And 1 more question.');assert.equal(question.action,'Reply');
  assert.deepEqual(result.needs.slice(0,2).map(item=>item.kind),['question','approval'],'the longest wait comes first');
  const setup=result.needs.filter(item=>item.kind==='setup');
  assert.equal(setup.length,2);assert.match(setup[0].title,/Backup provider has a connection problem/);assert.equal(setup[0].detail,'Rejected credential [redacted]');
  assert.equal(setup[1].title,'Echo needs a model provider');

  const working=Object.fromEntries(result.working.map(item=>[item.id,item]));
  assert.deepEqual([working['run:run_scout'].title,working['run:run_scout'].step,working['run:run_scout'].progress],['Compare launch channels','Reading source 4 of 6',{done:1,total:3}]);
  assert.deepEqual([working['run:run_flux'].title,working['run:run_flux'].step],['Morning digest routine','Creating sprint plan.xlsx']);
  assert.equal(working['run:run_sage'].step,'Waiting for Scout');
  assert.deepEqual([working['elsewhere:bot_echo'].elsewhere,working['elsewhere:bot_echo'].step],['Mac mini','On Mac mini']);
  assert.ok(!working['elsewhere:bot_scout'],'a bot active here is not also listed as busy elsewhere');
  assert.deepEqual([working['room:drive_1'].roomName,working['room:drive_1'].title,working['room:drive_1'].nav],['Launch room','Plan the launch week','/room/room_launch']);
  assert.ok(!result.working.some(item=>['run:run_atlas','run:run_nova'].includes(item.id)));

  const routines=Object.fromEntries(result.routines.map(item=>[item.id,item]));
  assert.deepEqual([routines.routine_digest.status,routines.routine_digest.files[0].name],['completed','digest.pdf']);
  assert.equal(routines.routine_review.status,'needs_input');
  assert.deepEqual([routines.routine_broken.status,routines.routine_broken.detail],['failed','Provider rejected [redacted]']);
  assert.deepEqual([routines.routine_new.status,routines.routine_new.nextRunAt],['paused',null]);
  assert.deepEqual(result.routines.map(item=>item.id),['routine_review','routine_broken','routine_digest','routine_new'],'latest results first');
  assert.deepEqual(result.counts,{files:1,activity:result.activity.length,needs:4,working:5,routines:4});
  assert.ok(!JSON.stringify(result).includes('/opt/homebrew'),'host executable paths are reduced to their name');
});

test('every text from runs and messages is redacted before it is shortened',async t=>{
  const store=await storeFixture(t),state=store.state,padding='x'.repeat(108);
  state.messages.bot_atlas=[{id:'m1',role:'user',content:`${padding} ${SECRET} tail`,runId:'run_atlas',createdAt:ago(3)}];
  state.runs.bot_atlas={id:'run_atlas',status:'running',createdAt:ago(3),plan:{steps:[{id:'s',title:`Use ${SECRET}`,status:'in_progress'}]},events:[]};
  state.messages.bot_nova=[{id:'m2',role:'user',content:'Check access',runId:'run_nova',createdAt:ago(2)}];
  state.runs.bot_nova={id:'run_nova',status:'waiting_for_input',createdAt:ago(2),pending_controls:[{kind:'question',questions:[{id:'q',header:'Key',prompt:`Is ${SECRET} still valid?`}]}],events:[]};
  state.messages.bot_scout=[{id:'m3',role:'user',content:'Fetch the report',runId:'run_scout',createdAt:ago(9),taskOutcome:{status:'failed',finishedAt:ago(8),error:`Upstream echoed ${SECRET}`}}];
  state.runs.bot_scout={id:'run_scout',status:'failed',error:`Upstream echoed ${SECRET}`,createdAt:ago(9),finishedAt:ago(8),events:[]};
  state.activity.unshift({id:'event_fail',type:'run.failed',title:'Scout: failed',botId:'bot_scout',runId:'run_scout',createdAt:ago(8)});
  const json=JSON.stringify(dashboard(store));
  assert.ok(!json.includes(SECRET.slice(0,12)),'neither the secret nor a clipped prefix of it leaks');
  assert.ok(json.includes('[redacted]'));
  assert.match(json,/Upstream echoed \[redacted\]/);
});

test('recent files come only from verified run artifacts, newest first, de-duplicated and bounded',async t=>{
  const store=await storeFixture(t),state=store.state;
  state.messages.bot_atlas=[
    {id:'u1',role:'user',content:'Here is my upload',runId:'run_up',createdAt:ago(50),attachments:[artifact('bot_atlas','uploads/mine.pdf')]},
    {id:'a0',role:'assistant',content:'No run id',createdAt:ago(49),attachments:[artifact('bot_atlas','orphan.pdf')]},
    {id:'a1',role:'assistant',content:'Unsafe',runId:'run_bad',createdAt:ago(48),attachments:[artifact('bot_atlas','../escape.pdf'),artifact('bot_atlas','/etc/hosts.txt'),{name:'missing-path.pdf'}]},
    ...Array.from({length:16},(_,index)=>({id:`a${index+2}`,role:'assistant',content:'Made it',runId:`run_${index}`,createdAt:ago(40-index),attachments:[artifact('bot_atlas',`reports/file-${index}.docx`)]})),
    {id:'a99',role:'assistant',content:'Updated again',runId:'run_again',createdAt:ago(1),attachments:[artifact('bot_atlas','reports/file-3.docx',9999)]},
  ];
  state.messages.bot_removed=[{id:'x',role:'assistant',content:'Gone',runId:'run_gone',createdAt:ago(0),attachments:[artifact('bot_removed','gone.pdf')]}];
  const {files}=dashboard(store);
  assert.equal(files.length,12);
  assert.deepEqual(files.slice(0,3).map(file=>[file.path,file.runId]),[['reports/file-3.docx','run_again'],['reports/file-15.docx','run_15'],['reports/file-14.docx','run_14']]);
  assert.equal(files.filter(file=>file.path==='reports/file-3.docx').length,1);
  for(const file of files){assert.match(file.path,/^reports\/file-\d+\.docx$/);assert.equal(file.botId,'bot_atlas');assert.equal(file.downloadUrl,`/api/bots/bot_atlas/files/download?path=${encodeURIComponent(file.path)}`);}
});

test('the timeline uses shared task outcomes, ignores local audit noise and never guesses an unanswered task ended',async t=>{
  const store=await storeFixture(t),state=store.state,chief=state.bots.find(bot=>bot.id==='bot_atlas').name;
  state.messages.bot_atlas=[
    {id:'u1',role:'user',content:'Summarize competitor research',runId:'run_done',createdAt:ago(12),taskOutcome:{status:'completed',finishedAt:ago(10),checks:{passed:2,failed:0}}},
    {id:'answer1',role:'user',kind:'answer',content:'A clarification, not the task title',runId:'run_done',createdAt:ago(11)},
    {id:'a1',role:'assistant',content:'Done',runId:'run_done',createdAt:ago(10)},
    {id:'u2',role:'user',content:'Check the inbox',runId:'run_lost',createdAt:ago(9)},
    {id:'u3',role:'user',content:'Stopped task',runId:'run_stop',createdAt:ago(8),taskOutcome:{status:'cancelled',finishedAt:ago(7)}},
    {id:'a3',role:'assistant',content:'Partial work',runId:'run_stop',partial:true,runStatus:'cancelled',createdAt:ago(7)},
    {id:'u4',role:'user',content:'Legacy success',runId:'run_old',createdAt:ago(6)},
    {id:'a4',role:'assistant',content:'Done',runId:'run_old',createdAt:ago(5)},
    {id:'u5',role:'user',content:'Legacy partial',runId:'run_partial',createdAt:ago(4)},
    {id:'a5',role:'assistant',content:'Some progress',partial:true,runStatus:'failed',runId:'run_partial',createdAt:ago(3)},
    {id:'bad',role:'user',content:'Bad legacy status',runId:'run_invalid',createdAt:ago(2)},
    {id:'badreply',role:'assistant',partial:true,runStatus:'completed',content:'Partial only',runId:'run_invalid',createdAt:ago(1)},
    {id:'u6',role:'user',content:'No output before failure',runId:'run_failed',createdAt:ago(2),taskOutcome:{status:'failed',finishedAt:ago(1),error:'Provider unavailable'}},
  ];
  state.runs.bot_atlas={id:'run_newer',status:'completed',createdAt:ago(0)};
  state.activity=[{id:'e1',type:'run.completed',title:'Atlas: completed',botId:'bot_atlas',runId:'run_done',createdAt:ago(0)},
    {id:'e2',type:'run.started',title:'Atlas received a task',botId:'bot_atlas',runId:'run_lost',createdAt:ago(9)},
    {id:'e3',type:'run.approval',title:'Action denied',botId:'bot_atlas',runId:'run_done',createdAt:ago(0)},
    {id:'e4',type:'memory.updated',title:'Atlas memory updated',botId:'bot_atlas',createdAt:ago(0)}];
  const {activity}=dashboard(store);
  assert.deepEqual(activity.map(item=>[item.id,`${item.subject} ${item.text}`]),[
    ['run:run_failed',`${chief} couldn’t finish a task`],['run:run_partial',`${chief} couldn’t finish a task`],
    ['run:run_old',`${chief} finished a task`],['run:run_stop',`${chief} stopped working on a task`],['run:run_done',`${chief} finished a task`],
  ]);
  assert.equal(activity[0].detail,'Provider unavailable');
  assert.equal(activity.at(-1).detail,'Summarize competitor research · 2 declared checks passed');
  assert.equal(activity.at(-1).at,state.messages.bot_atlas[0].taskOutcome.finishedAt,'use the shared terminal time, not the local audit timestamp');
  assert.ok(!activity.some(item=>item.id==='run:run_lost'),'a newer local run cannot turn an unanswered synced request into an interruption');
  const remote={state:structuredClone(state),redact:store.redact.bind(store),redactValue:store.redactValue.bind(store)};
  remote.state.runs={};remote.state.runHistory={};remote.state.activity=[];
  assert.deepEqual(dashboard(remote).activity,activity,'local execution and audit records cannot change the shared timeline');
});

test('room outcomes sync without inferring room completion from a member reply; activity order and bounds are stable',async t=>{
  const store=await storeFixture(t),state=store.state;
  state.rooms.push({id:'room_x',name:'Launch room',botIds:['bot_atlas','bot_nova']});
  state.roomMessages.room_x=[
    {id:'rm1',role:'user',content:'Plan launch',driveId:'drive_done',createdAt:ago(5),taskOutcome:{status:'completed',finishedAt:ago(3)}},
    {id:'rm2',role:'assistant',botId:'bot_atlas',content:'My part is done',driveId:'drive_pending',createdAt:ago(1)},
    {id:'rm3',role:'user',content:'Another task',driveId:'drive_pending',createdAt:ago(2)},
    {id:'rm4',role:'user',content:'Interrupted task',driveId:'drive_restart',createdAt:ago(1),taskOutcome:{status:'interrupted',finishedAt:ago(0)}},
  ];
  state.activity=[{type:'room.completed',roomId:'room_x',driveId:'drive_pending',createdAt:ago(0)}];
  assert.deepEqual(dashboard(store).activity.map(item=>[item.id,item.text]),[['room:drive_restart','was interrupted'],['room:drive_done','finished a team task']]);
  const at=ago(1);
  state.messages.bot_atlas=Array.from({length:500},(_,index)=>({id:`message_${index}`,role:'user',content:`Task ${index}`,runId:`run_${String(index).padStart(3,'0')}`,createdAt:at,taskOutcome:{status:'completed',finishedAt:at}}));
  const first=dashboard(store).activity;
  assert.equal(first.length,80);
  // Keep the same 400-message scan window while reversing iteration order.
  state.messages.bot_atlas=state.messages.bot_atlas.slice(-400).reverse();
  assert.deepEqual(dashboard(store).activity,first);
  for(let index=0;index<30;index++){state.bots.push({...state.bots[0],id:`bot_extra_${index}`,name:`Extra ${index}`});state.runs[`bot_extra_${index}`]={id:`run_extra_${index}`,status:'waiting_for_approval',createdAt:ago(1),pending_controls:[{kind:'approval',tool:'workspace_delete',arguments:{path:'a.md'}}]};}
  const bounded=dashboard(store);assert.equal(bounded.needs.length,20);assert.equal(bounded.counts.needs,20);
});

// Browser module: the real public/dashboard.js runs in a DOM with a stubbed app.js context.
const dashboardSource=await readFile(new URL('../public/dashboard.js',import.meta.url),'utf8');
const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function uiHarness(t,responses) {
  const dom=new JSDOM('<!doctype html><main id="main-content"></main><div id="dialog-root"></div>',{url:'http://studio.local/#/dashboard',runScripts:'outside-only',pretendToBeVisual:true});
  const win=dom.window,intervals=[],requests=[],previews=[],toasts=[];
  win.setInterval=fn=>{intervals.push(fn);return intervals.length;};win.clearInterval=()=>{};
  vm.runInContext(dashboardSource,dom.getInternalVMContext(),{filename:'dashboard.js'});
  const bots=[{id:'bot_nova',name:'Nova'},{id:'bot_atlas',name:'Atlas'}];
  let view='dashboard';
  const ctx={data:{bots},esc:escape,icon:name=>`<svg data-icon="${name}"></svg>`,avatar:(bot,size,key)=>`<span class="avatar creature-avatar ${size}" data-key="${key||''}">${escape(bot.name)}</span>`,
    botById:id=>bots.find(bot=>bot.id===id),relative:()=>'4m ago',timeLabel:value=>new Date(value).toISOString().slice(11,16),shortDate:()=>'Oct 1',toast:(message,error)=>toasts.push([message,error]),errorText:error=>error?.message || 'Failed',
    documentPreview:async(botId,filePath)=>{previews.push([botId,filePath]);},fileEditor:async()=>{},previewFormats:/\.(?:pdf|md)$/i,navigate:()=>{},route:()=>({view}),openDialog:()=>{},closeDialog:()=>{},
    api:(route,options)=>{requests.push({route,options});const next=responses.shift();return typeof next==='function'?next():next instanceof Error?Promise.reject(next):Promise.resolve(next);}};
  const root=win.document.querySelector('#main-content');
  const mount=()=>{root.innerHTML=win.StudioDashboard.render(ctx);win.StudioDashboard.mount(ctx,root);};
  t.after(()=>win.close());
  let offset=0;const realNow=win.Date.now.bind(win.Date);win.Date.now=()=>realNow()+offset;
  return {win,doc:win.document,root,ctx,intervals,requests,previews,toasts,mount,setView:value=>{view=value;},advance:ms=>{offset+=ms;},settle:()=>new Promise(resolve=>setTimeout(resolve,0))};
}
const sample=()=>({counts:{},files:[
  {botId:'bot_nova',botName:'Nova',name:'Launch brief.pdf',path:'reports/Launch brief.pdf',format:'pdf',size:2_400_000,createdAt:new Date().toISOString(),runId:'run_1'},
  {botId:'bot_atlas',botName:'Atlas',name:'<img src=x onerror=alert(1)>.xlsx',path:'odd/<img src=x>.xlsx',format:'xlsx',size:1200,createdAt:ago(60*30),runId:'run_2'},
],activity:[
  {id:'e1',at:new Date().toISOString(),kind:'file',tone:'ok',actor:'bot',botId:'bot_nova',subject:'Nova',text:'created Launch brief.pdf',detail:'Draft the launch brief',files:[{botId:'bot_nova',name:'Launch brief.pdf',path:'reports/Launch brief.pdf',format:'pdf',size:2_400_000}],moreFiles:0,nav:'/bot/bot_nova'},
  {id:'e2',at:ago(60*24*3),kind:'approval',tone:'neutral',actor:'you',botId:'bot_atlas',subject:'You',text:'approved an action for Atlas',detail:''},
],needs:[{id:'approval:run_3',kind:'approval',botId:'bot_atlas',botName:'Atlas',title:'Run npm test',detail:'Paused until you review this action.',at:ago(4),nav:'/bot/bot_atlas',action:'Review action'}],
working:[{id:'run:run_4',kind:'run',botId:'bot_nova',botName:'Nova',status:'running',title:'Draft product update',step:'Writing recommendations',progress:{done:1,total:3},since:ago(2),nav:'/bot/bot_nova'}],
routines:[{id:'routine_1',name:'Morning digest',botId:'bot_atlas',botName:'Atlas',status:'completed',detail:'',lastRunAt:ago(30),nextRunAt:new Date(Date.now()+3*3_600_000).toISOString(),enabled:true,files:[],nav:'/bot/bot_atlas'}]});

test('the dashboard page renders a skeleton first, then escaped live sections with plain actions',async t=>{
  const h=uiHarness(t,[{body:sample(),etag:'"v1"'}]);
  h.mount();
  assert.ok(h.root.querySelector('[data-dash-page] .dash-skeleton'));assert.equal(h.root.querySelectorAll('[aria-busy="true"]').length,5);
  assert.equal(h.requests[0].route,'/api/dashboard');assert.equal(h.requests[0].options.etag,'');
  await h.settle();
  const page=h.root.querySelector('[data-dash-page]');
  assert.equal(page.querySelector('h1').textContent,'Dashboard');assert.ok(!page.querySelector('.dash-skeleton'));
  assert.deepEqual([...page.querySelectorAll('.pearl-home-teammate')].map(node=>node.dataset.nav),['/bot/bot_nova','/bot/bot_atlas']);
  assert.ok(page.querySelector('.pearl-home-hero [data-nav="/bots"]'));
  assert.equal(page.querySelector('.dash-routine-disclosure').open,false,'routine setup is a secondary disclosure');
  assert.ok([...page.children].indexOf(page.querySelector('.dash-priority'))<[...page.children].indexOf(page.querySelector('.dash-files')),'attention comes before outputs');
  assert.deepEqual([...page.querySelectorAll('.dash-file strong')].map(node=>node.textContent),['Launch brief.pdf','<img src=x onerror=alert(1)>.xlsx']);
  assert.equal(page.querySelectorAll('img').length,0);
  assert.ok(![...page.querySelectorAll('*')].some(node=>[...node.attributes].some(attribute=>attribute.name.startsWith('on'))),'no inline handlers');
  assert.ok(page.querySelector('.dash-file .dash-kind-pdf') && page.querySelector('.dash-file .dash-kind-sheet'));
  const download=page.querySelector('.dash-file a[download]');
  assert.equal(download.getAttribute('href'),'/api/bots/bot_nova/files/download?path=reports%2FLaunch%20brief.pdf');
  assert.equal(page.querySelector('.dash-event-text').textContent,'Nova created Launch brief.pdf');
  assert.equal(page.querySelector('.dash-event .dash-subject').getAttribute('href'),'#/bot/bot_nova');
  assert.equal(page.querySelector('.dash-day-label').textContent,'Today');
  assert.match(page.querySelector('.dash-inline-file small').textContent,/PDF · 2\.4 MB/);
  assert.equal(page.querySelector('.dash-needs .dash-count').textContent,'1');
  assert.equal(page.querySelector('.dash-needs [data-nav]').getAttribute('data-nav'),'/bot/bot_atlas');
  assert.match(page.querySelector('.dash-needs .dash-row-detail').textContent,/Paused until you review this action\. · 4m ago/);
  assert.match(page.querySelector('.dash-working .dash-step').textContent,/Writing recommendations1 of 3/);
  assert.match(page.querySelector('.dash-routines .dash-badge').textContent,/Completed/);
  assert.match(page.querySelector('.dash-routines .dash-row-detail').textContent,/Next in 3h/);
  assert.ok(!page.querySelector('[data-action]'),'dashboard controls never trigger app.js actions');
  page.querySelector('[data-dash-action="preview"]').click();await h.settle();
  assert.deepEqual(h.previews,[['bot_nova','reports/Launch brief.pdf']]);
});

test('range control, conditional refresh, stale replies and leaving the route behave predictably',async t=>{
  let releaseSlow;
  const slow=new Promise(resolve=>{releaseSlow=resolve;}),initial=sample(),updated=structuredClone(initial);updated.working=[];
  const h=uiHarness(t,[{body:initial,etag:'"v1"'},{notModified:true},()=>slow,{body:updated,etag:'"v3"'},{notModified:true}]);
  h.mount();await h.settle();
  const page=h.root.querySelector('[data-dash-page]'),files=page.querySelector('[data-dash-section="files"]');
  assert.equal(page.querySelectorAll('.dash-event').length,1,'today is shown first when something happened today');
  page.querySelector('[data-range="week"]').click();
  assert.equal(h.root.querySelectorAll('.dash-event').length,2);
  assert.equal(h.root.querySelector('[data-range="week"]').getAttribute('aria-pressed'),'true');
  assert.equal(h.root.querySelector('[data-dash-section="files"]'),files,'unchanged sections are kept');

  h.intervals[0]();await h.settle();
  assert.equal(h.requests[1].options.etag,'"v1"');assert.equal(h.root.querySelector('[data-dash-section="files"]'),files,'a 304 leaves the page alone');
  h.intervals[0]();await h.settle();
  assert.equal(h.requests.length,3);
  h.win.StudioDashboard.mount(h.ctx,h.root);h.intervals[0]();await h.settle();
  assert.equal(h.requests.length,3,'no second request while one is in flight');
  // A request stuck for longer than the refresh window is superseded; its late reply is ignored.
  h.advance(16_000);h.intervals[0]();await h.settle();
  assert.equal(h.requests[3].options.etag,'"v1"');
  assert.match(h.root.querySelector('.dash-working').textContent,/Everyone’s free/);
  assert.equal(h.root.querySelector('.dash-working').hidden,true,'an empty work section does not occupy the dashboard');
  releaseSlow({body:{...sample(),working:[{...sample().working[0],step:'Stale step'}]},etag:'"v2"'});await h.settle();
  assert.match(h.root.querySelector('.dash-working').textContent,/Everyone’s free/);
  assert.equal(h.root.querySelector('[data-dash-section="files"]'),files);
  h.intervals[0]();await h.settle();
  assert.equal(h.requests[4].options.etag,'"v3"');

  h.setView('bots');h.root.innerHTML='<section class="page">Bots</section>';
  h.intervals[0]();await h.settle();
  assert.equal(h.requests.length,5,'the timer stops once the dashboard is gone');
  assert.equal(h.root.textContent,'Bots');
});

test('a quiet dashboard keeps direct teammate entry and one honest empty state',async t=>{
  const h=uiHarness(t,[{body:{counts:{},files:[],activity:[],needs:[],working:[],routines:[]},etag:'"empty"'}]);
  h.ctx.data.bots.push({id:'bot_hidden',name:'Hidden',hidden:true});
  h.mount();await h.settle();
  assert.equal(h.root.querySelectorAll('.pearl-home-teammate').length,2);
  assert.ok(!h.root.querySelector('.pearl-home-teammate[data-nav="/bot/bot_hidden"]'));
  assert.deepEqual([...h.root.querySelectorAll('[data-dash-section][hidden]')].map(node=>node.dataset.dashSection),['needs','working','files','routines']);
  assert.match(h.root.querySelector('.dash-activity').textContent,/No activity yet/);
  assert.ok(h.root.querySelector('.dash-activity [data-nav="/bots"]'));
});

test('routine disclosure stays open and keeps keyboard focus during a live refresh',async t=>{
  const updated=sample();updated.routines[0].detail='A new result is ready.';
  const h=uiHarness(t,[{body:sample(),etag:'"v1"'},{body:updated,etag:'"v2"'}]);
  h.mount();await h.settle();
  const disclosure=h.root.querySelector('.dash-routine-disclosure');disclosure.open=true;
  disclosure.querySelector('summary').focus();await h.settle();
  h.intervals[0]();await h.settle();
  assert.equal(h.root.querySelector('.dash-routine-disclosure').open,true);
  assert.equal(h.doc.activeElement,h.root.querySelector('.dash-routine-disclosure > summary'));
  assert.match(h.root.querySelector('.dash-routine-content').textContent,/A new result is ready/);
});

test('a failed first load offers a retry and a later failure keeps the last data',async t=>{
  const h=uiHarness(t,[new Error('Tupies is offline.'),{body:sample(),etag:'"v1"'},new Error('Network down')]);
  h.mount();await h.settle();
  assert.match(h.root.querySelector('[role="alert"]').textContent,/The dashboard didn’t load.*Tupies is offline\./s);
  h.root.querySelector('[data-dash-action="retry"]').click();await h.settle();
  assert.ok(h.root.querySelector('[data-dash-section="activity"]'));assert.ok(!h.root.querySelector('[role="alert"]'));
  h.intervals[0]();await h.settle();
  assert.ok(h.root.querySelector('.dash-status'));assert.equal(h.root.querySelectorAll('.dash-file').length,2);
});
