import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Store } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { codingToolDefinitions, executeCodingTool } from '../lib/coding-tools.mjs';
import { processEnvironment } from '../lib/process-environment.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=25_000){const end=Date.now()+timeout;while(Date.now()<end){const value=predicate();if(value)return value;await delay(5);}throw new Error('Coding engine fixture timed out.');}
const call=(id,name,args)=>({id,name,arguments:args});
const toolResult=(request,id)=>{const message=request.messages.findLast(item=>item.tool_call_id===id);assert.ok(message,`Missing tool result ${id}`);return JSON.parse(message.content);};
const final=text=>({text,toolCalls:[]});
const next=(id,name,args)=>({text:'',toolCalls:[call(id,name,args)]});
const current=store=>store.state.runs.bot_atlas;
const decision=run=>({runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation});
const check={name:'Actual answer check',executable:process.execPath,args:['-e','const fs=require("node:fs");if(fs.readFileSync("answer.txt","utf8")!=="42\\n")process.exit(17)']};

async function fixture(t,complete,{tools=['coding'],platform='darwin',worker,repository=false}={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'tupies-coding-engine-'))),directory=path.join(root,'data'),home=path.join(root,'home'),source=path.join(home,'Projects','fixture');
  await fs.mkdir(home);let discoveries=0;const workerCalls=[],requests=[],approvals=[];
  if(repository){
    await fs.mkdir(source,{recursive:true});const env=await processEnvironment(path.join(root,'git-home'));
    const git=args=>{const value=spawnSync('/usr/bin/git',args,{cwd:source,env,encoding:'utf8'});assert.equal(value.status,0,value.stderr);};
    git(['init','--initial-branch=main']);await fs.writeFile(path.join(source,'answer.txt'),'0\n');git(['add','answer.txt']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','Fixture baseline']);
  }
  const store=await new Store(directory).init();
  await store.mutate(state=>{state.connections.push({id:'coding-fixture-provider',type:'openai',defaultModel:'fixture-model'});for(const bot of state.bots){bot.connectionId='coding-fixture-provider';bot.tools=tools;bot.approvalPolicy='strict';bot.collaborators=[];}});
  const engine=new NativeEngine(store,{runTimeout:30_000,providers:{async complete(_connection,request){requests.push(request);return complete(request,requests.length);}},localCoding:{platform,home,discover:async()=>{discoveries++;return {agents:[{id:'claude',label:'Claude Code',executable:process.execPath,detected:true},{id:'codex',label:'Codex',executable:'',detected:false}],projects:repository?[{path:source,name:'Fixture',source:'folder'}]:[],truncated:false,warnings:[]};},worker:async input=>{workerCalls.push(input);if(worker)return worker(input);const approved=await input.approve({tool:'Bash',args:{command:'fixture implementation'},description:'Fixture exact action'});assert.equal(approved,true);await fs.writeFile(path.join(input.cwd,'answer.txt'),'42\n');return {status:'completed',sessionId:'11111111-2222-4333-8444-555555555555',output:'Changed answer.txt. Tupies still needs independent verification.'};}}});
  await engine.recover();t.after(async()=>{await engine.close();await fs.rm(root,{recursive:true,force:true});});
  async function settle(started,choose=()=> 'once') {
    await until(()=>current(store)?.id===started.id);const deadline=Date.now()+30_000;
    while(isActive(current(store))){
      if(Date.now()>deadline){await engine.control('bot_atlas','stop',{runId:started.id,remoteRunId:started.remoteRunId});throw new Error('Coding engine run did not settle.');}
      const run=current(store),prompt=run.pending_controls?.[0];
      if(run.status==='waiting_for_approval'&&prompt&&engine.pending.get(run.id)?.promptId===prompt.prompt_id){approvals.push(structuredClone(prompt));await engine.control('bot_atlas','approval',{...decision(run),choice:choose(prompt)});}
      await delay(5);
    }
    await engine.tasks.get(started.id);return current(store);
  }
  async function run(text='Perform the coding fixture.',choose){return settle(await engine.start('bot_atlas',text),choose);}
  async function connect(){await engine.localCoding.configureAgent('claude',{executable:process.execPath,account:'dedicated'});return engine.localCoding.configureProject({path:source,name:'Fixture',agent:'claude',baseBranch:'main',botIds:['bot_atlas'],checks:[check]});}
  return {root,directory,home,source,store,engine,workerCalls,requests,approvals,run,settle,connect,get discoveries(){return discoveries;}};
}

test('coding tools require Mac, explicit opt-in, direct owner chat and current access',async t=>{
  const f=await fixture(t,async()=>final('Unused.')),bot=structuredClone(f.store.state.bots.find(item=>item.id==='bot_atlas'));
  assert.ok(codingToolDefinitions(f.engine,{bot,source:'chat'}).some(item=>item.name==='coding_run'));
  for(const source of ['routine','delegation','room','telegram']){
    const context={bot,source};assert.deepEqual(codingToolDefinitions(f.engine,context),[]);
    await assert.rejects(executeCodingTool(f.engine,context,'coding_discover',{}),error=>error.status===403);
  }
  assert.deepEqual(codingToolDefinitions(f.engine,{bot:{...bot,tools:['workspace']},source:'chat'}),[]);
  f.engine.localCoding.options.platform='linux';assert.deepEqual(codingToolDefinitions(f.engine,{bot,source:'chat'}),[]);await assert.rejects(executeCodingTool(f.engine,{bot,source:'chat'},'coding_discover',{}),error=>error.status===403);
  f.engine.localCoding.options.platform='darwin';await f.store.mutate(state=>{state.bots.find(item=>item.id===bot.id).tools=['workspace'];});
  await assert.rejects(executeCodingTool(f.engine,{bot,source:'chat'},'coding_discover',{}),error=>error.status===403);
  assert.equal(f.discoveries,0);assert.equal(f.workerCalls.length,0);
});

test('denied discovery cannot read account/project metadata or create a coding connection',async t=>{
  const f=await fixture(t,async(request,index)=>{if(index===1)return next('discover','coding_discover',{includeClaudeProjects:true});assert.match(toolResult(request,'discover').error,/denied/i);return final('Discovery was denied.');});
  const run=await f.run('Find coding tools.',()=> 'deny');assert.equal(run.status,'completed',run.error);
  assert.equal(f.approvals.length,1);assert.equal(f.approvals[0].tool,'coding_discover');assert.deepEqual(f.approvals[0].arguments,{includeClaudeProjects:true});
  assert.equal(f.discoveries,0);assert.equal(f.workerCalls.length,0);assert.equal(f.engine.localCoding.data.projects.length,0);
});

test('engine discovers, connects, delegates, inspects and independently verifies through exact approvals',async t=>{
  let projectId,jobId;
  const f=await fixture(t,async(request,index)=>{
    // Coding tools are reached on demand (directly or through tool_call); the offered list never changes.
    assert.equal(request.tools.some(tool=>tool.name==='coding_run'),false);
    if(index===1)assert.ok(request.tools.find(tool=>tool.name==='tools_load').parameters.properties.groups.items.enum.includes('coding'));
    if(index===1)return next('discover','coding_discover',{includeClaudeProjects:true});
    if(index===2){assert.equal(toolResult(request,'discover').projects[0].path,f.source);return next('connect','coding_connect',{path:f.source,agent:'claude',account:'dedicated'});}
    if(index===3){const connected=toolResult(request,'connect');assert.equal(typeof connected.id,'string',JSON.stringify(connected));projectId=connected.id;return next('implement','coding_run',{projectId,instructions:'Change answer.txt to 42.'});}
    if(index===4){const job=toolResult(request,'implement');jobId=job.id;assert.equal(job.status,'needs_verification',JSON.stringify(job));return next('inspect','coding_inspect',{jobId});}
    if(index===5){assert.match(toolResult(request,'inspect').snapshot.diff,/\+42/);return next('verify','coding_verify',{jobId,checks:[check]});}
    assert.equal(index,6);const verified=toolResult(request,'verify');assert.equal(verified.status,'ready_for_review');assert.equal(verified.verification.checks[0].exitCode,0);return final('The change passed its independent acceptance check.');
  },{repository:true});
  const run=await f.run();assert.equal(run.status,'completed',run.error);assert.equal(f.workerCalls.length,1);
  assert.deepEqual(f.approvals.map(item=>item.tool),['coding_discover','coding_connect','coding_run','Bash','coding_verify']);
  assert.equal(f.approvals.find(item=>item.tool==='Bash').arguments.command,'fixture implementation');assert.equal(f.approvals.find(item=>item.tool==='coding_verify').arguments.checks[0].executable,process.execPath);
  assert.equal(await fs.readFile(path.join(f.source,'answer.txt'),'utf8'),'0\n');
  const job=f.engine.localCoding.data.jobs.find(item=>item.id===jobId);assert.equal(job.projectId,projectId);assert.equal(job.verification.passed,true);assert.equal(job.status,'ready_for_review');assert.equal(await fs.readFile(path.join(job.checkout,'answer.txt'),'utf8'),'42\n');
  assert.equal(f.engine.localCoding.active.size,0);assert.equal(f.engine.pending.size,0);assert.ok(run.events.some(event=>event.type==='coding.progress'));
});

test('a worker saying done cannot let the engine finish without independent verification',async t=>{
  let project;
  const f=await fixture(t,async(request,index)=>index===1?next('implement','coding_run',{projectId:project.id,instructions:'Change answer.txt to 42.'}):final('The worker says it is done.'),{repository:true});
  project=await f.connect();const run=await f.run();assert.equal(run.status,'failed');assert.match(run.error,/independent checks/i);
  assert.equal(f.engine.localCoding.data.jobs[0].status,'needs_verification');assert.equal(f.engine.localCoding.active.size,0);assert.equal(f.workerCalls.length,1);
});

test('verification in a later engine run cannot evade that run’s completion gate',async t=>{
  let project,jobId,phase='implement';
  const failedCheck={name:'Intentional acceptance failure',executable:process.execPath,args:['-e','process.exit(19)']};
  const f=await fixture(t,async(request)=>{
    if(phase==='implement'){phase='first-final';return next('implement','coding_run',{projectId:project.id,instructions:'Change answer.txt to 42.'});}
    if(phase==='first-final')return final('Implementation still needs verification.');
    if(phase==='verify'){phase='second-final';return next('later-verify','coding_verify',{jobId,checks:[failedCheck]});}
    assert.equal(toolResult(request,'later-verify').status,'checks_failed');return final('This task is complete.');
  },{repository:true});
  project=await f.connect();const first=await f.run('Implement the fixture.');assert.equal(first.status,'failed');jobId=f.engine.localCoding.data.jobs[0].id;phase='verify';
  const second=await f.run('Now verify the prior coding job.');assert.notEqual(second.id,first.id);assert.equal(second.status,'failed');assert.match(second.error,/independent checks/i);
  assert.equal(f.engine.localCoding.data.jobs[0].verification.checks[0].exitCode,19);assert.equal(f.engine.localCoding.data.jobs[0].status,'checks_failed');
});

test('scoped worker approval cancellation clears pending controls and refuses the stale owner decision',async t=>{
  let project,scope,providerContinued=false,releaseProvider;
  const holdProvider=new Promise(resolve=>{releaseProvider=resolve;});
  const f=await fixture(t,async(request,index)=>{if(index===1)return next('implement','coding_run',{projectId:project.id,instructions:'Ask for an action then withdraw it.'});assert.match(toolResult(request,'implement').error,/withdrawn/i);providerContinued=true;await Promise.race([holdProvider,new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}))]);return final('The coding worker withdrew its action.');},{repository:true,worker:async input=>{scope=new AbortController();await input.approve({tool:'Bash',args:{command:'must not run'},description:'Withdrawn fixture command',signal:scope.signal});throw new Error('A withdrawn action must never be approved.');}});
  project=await f.connect();const started=await f.engine.start('bot_atlas','Handle a withdrawn worker action.');
  await until(()=>current(f.store)?.status==='waiting_for_approval'&&current(f.store).pending_controls?.[0]?.tool==='coding_run');await f.engine.control('bot_atlas','approval',{...decision(current(f.store)),choice:'once'});
  await until(()=>current(f.store)?.status==='waiting_for_approval'&&current(f.store).pending_controls?.[0]?.tool==='Bash');const stale=decision(current(f.store));
  scope.abort(new Error('Worker action withdrawn.'));await until(()=>providerContinued);
  assert.equal(f.engine.pending.has(started.id),false);assert.deepEqual(current(f.store).pending_controls,[]);assert.equal(current(f.store).approval,null);assert.equal(current(f.store).status,'running');
  await assert.rejects(f.engine.control('bot_atlas','approval',{...stale,choice:'once'}),/prompt changed/);
  releaseProvider();await f.engine.tasks.get(started.id);assert.equal(current(f.store).status,'failed');assert.equal(f.engine.localCoding.active.size,0);assert.equal(f.engine.pending.size,0);
});

test('failed dispatched coding work is uncertain and cannot replay the same call unchanged',async t=>{
  let project;
  const f=await fixture(t,async(request,index)=>{
    if(index===1)return next('first','coding_run',{projectId:project.id,instructions:'Work that fails after making a change.'});
    if(index===2){assert.equal(toolResult(request,'first').outcome,'unknown');return next('replay','coding_run',{projectId:project.id,instructions:'Work that fails after making a change.'});}
    assert.equal(toolResult(request,'replay').errorCode,'repeated_failure');return final('The interrupted work must be inspected.');
  },{repository:true,worker:async input=>{await fs.writeFile(path.join(input.cwd,'partial.txt'),'committed partial bytes');throw new Error('Fixture failed after writing.');}});
  project=await f.connect();const run=await f.run();assert.equal(run.status,'failed');assert.equal(f.workerCalls.length,1);assert.equal(f.engine.localCoding.data.jobs.length,1);
  assert.equal(await fs.readFile(path.join(f.engine.localCoding.data.jobs[0].checkout,'partial.txt'),'utf8'),'committed partial bytes');
});
