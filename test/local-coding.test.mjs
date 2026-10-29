import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { LocalCoding } from '../lib/local-coding.mjs';
import { processEnvironment } from '../lib/process-environment.mjs';
import { codingCommand } from '../lib/coding-process.mjs';

const TOKEN='local-coding-fixture-azure-token',SESSION='11111111-2222-3333-4444-555555555555';
const REPOSITORY='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const check={name:'Answer acceptance',executable:process.execPath,args:['-e',"if(require('node:fs').readFileSync('answer.txt','utf8').trim()!=='42')process.exit(7)"]};
const discovery=async()=>({agents:[{id:'claude',label:'Claude Code',executable:process.execPath,detected:true},{id:'codex',label:'Codex',executable:'',detected:false}],projects:[],truncated:false,warnings:[]});
async function fixture(t,{worker,project={},agentExecutable}={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'tupies-local-coding-'))),home=path.join(root,'home'),source=path.join(root,'source'),data=path.join(root,'data');
  await fs.mkdir(home);await fs.mkdir(source);const env=await processEnvironment(path.join(root,'git-home'));
  const git=async(args,cwd=source)=>{const result=await codingCommand({executable:'/usr/bin/git',args,cwd,env,timeoutMs:10000,maxBytes:200000});assert.equal(result.exitCode,0,result.output);return result.output;};
  await git(['init','--initial-branch=main']);await fs.writeFile(path.join(source,'answer.txt'),'0\n');await git(['add','answer.txt']);await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','Fixture baseline']);
  const base=(await git(['rev-parse','HEAD'])).trim(),store=await new Store(data).init(),workerCalls=[],commands=[],approvals=[];
  const options={platform:'darwin',home,discover:discovery,worker:async input=>{workerCalls.push(input);if(worker)return worker(input,workerCalls.length);await fs.writeFile(path.join(input.cwd,'answer.txt'),'42\n');return {status:'completed',sessionId:SESSION,output:'Updated answer.txt; Tupies should verify it.'};},command:async input=>{commands.push(input);return codingCommand(input);}};
  const service=new LocalCoding(store,options);await service.init();await service.configureAgent('claude',{executable:agentExecutable || process.execPath,account:'dedicated'});
  const connected=await service.configureProject({name:'Fixture project',path:source,agent:'claude',baseBranch:'main',botIds:['bot_atlas'],checks:[check],...project});
  const approve=async request=>{approvals.push(request);return true;};
  const run=(input={},settings={})=>service.run({projectId:connected.id,instructions:'Set answer.txt to 42.',...input},{botId:'bot_atlas',runId:'run_fixture',approve,...settings});
  t.after(async()=>{await service.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,home,source,data,store,service,project:connected,options,workerCalls,commands,approvals,approve,run,git,base};
}
async function publicationFixture(t,{pushFailure=false,prResult,checks,worker}={}) {
  const f=await fixture(t,{worker,project:{organization:'fixture-org',project:'Fixture Project',repositoryName:'fixture-repo',token:TOKEN,...(checks?{checks}:{})}}),azureCalls=[],pushes=[];
  f.service.azure=()=>({
    workItem:async id=>({id:Number(id),rev:7,title:'Assigned fixture task',description:'Implement answer 42.',acceptanceCriteria:'Answer must be 42.',assignedToMe:true}),
    resolveRepository:async name=>{azureCalls.push({method:'resolveRepository',name});return {id:REPOSITORY,name:'fixture-repo',remoteUrl:`https://dev.azure.com/fixture-org/Fixture%20Project/_git/${REPOSITORY}`};},
    pullRequest:async(input,options)=>{azureCalls.push({method:'pullRequest',input,options});return prResult ?? {id:17,pullRequestId:17,status:'active',isDraft:true,verified:true,workItemLinked:true,outcome:'created',url:`https://dev.azure.com/fixture-org/Fixture%20Project/_git/${REPOSITORY}/pullrequest/17`};}
  });
  const actual=f.options.command;f.options.command=async input=>{if(input.executable==='/usr/bin/git' && input.args[0]==='push'){f.commands.push(input);pushes.push(input);if(pushFailure)throw new Error('Fixture push acknowledgement was lost.');return {exitCode:0,output:'Fixture branch accepted.',stdout:'Fixture branch accepted.',stderr:''};}return actual(input);};
  const job=await f.run({workItemId:42});await f.service.verify(job.id,undefined,{botId:'bot_atlas',approve:f.approve});
  const publish=(settings={})=>f.service.publish(job.id,{title:'Implement assigned task',description:'Implemented and independently checked answer 42.',targetBranch:'main'},{botId:'bot_atlas',runId:'run_fixture',approve:f.approve,...settings});
  return {...f,job,publish,azureCalls,pushes};
}

test('local coding keeps account setup and sealed Azure access out of public/synced state',async t=>{
  const f=await fixture(t,{project:{organization:'fixture-org',project:'Fixture Project',token:TOKEN}}),disk=await fs.readFile(path.join(f.data,'local-coding','config.json'),'utf8'),state=await fs.readFile(f.store.file,'utf8'),view=await f.service.status();
  assert.ok(!disk.includes(TOKEN));assert.ok(!state.includes(TOKEN));assert.ok(!state.includes(f.source));assert.ok(!state.includes('local-coding'));
  assert.equal(view.projects[0].azureConfigured,true);assert.equal(view.projects[0].secret,undefined);assert.ok(!JSON.stringify(view).includes(TOKEN));assert.equal(view.agents.find(agent=>agent.id==='claude').account,'dedicated');
  assert.equal((await fs.stat(path.join(f.data,'local-coding','config.json'))).mode&0o777,0o600);
  const changed=await f.service.configureProject({id:f.project.id,path:f.source,name:'Renamed fixture',agent:'claude',botIds:['bot_atlas'],organization:'fixture-org',project:'Fixture Project'});
  assert.equal(changed.id,f.project.id);assert.equal(changed.azureConfigured,true);assert.equal(changed.secret,undefined);
});

test('local coding enforces bot assignment and detects replaced source folders',async t=>{
  const f=await fixture(t);await assert.rejects(f.run({}, {botId:'bot_scout'}),error=>error.status===403);assert.equal(f.workerCalls.length,0);
  await fs.rename(f.source,`${f.source}-original`);await fs.mkdir(f.source);await fs.mkdir(path.join(f.source,'.git'));
  await assert.rejects(f.run(),/moved or was replaced/);assert.equal(f.workerCalls.length,0);
});

test('local coding requires explicit launch approval before any worker starts',async t=>{
  const f=await fixture(t);await assert.rejects(f.run({}, {approve:async()=>false}),/denied|approval/i);assert.equal(f.workerCalls.length,0);assert.equal(f.commands.length,0);assert.equal(f.service.active.size,0);
  const jobs=(await f.service.status()).jobs;assert.ok(jobs.every(job=>job.status!=='needs_verification'&&job.status!=='ready_for_review'));
});

test('local coding detects replaced executables and refuses a symlinked source connection',async t=>{
  const f=await fixture(t),agent=path.join(f.root,'fixture-agent'),alias=path.join(f.root,'source-alias');await fs.writeFile(agent,'#!/bin/sh\nexit 0\n',{mode:0o700});await f.service.configureAgent('claude',{executable:agent,account:'dedicated'});await fs.rename(agent,`${agent}-old`);await fs.writeFile(agent,'#!/bin/sh\nexit 1\n',{mode:0o700});await assert.rejects(f.run(),/agent changed/);assert.equal(f.workerCalls.length,0);
  await fs.symlink(f.source,alias);await assert.rejects(f.service.configureProject({path:alias,botIds:['bot_atlas']}),/symbolic link/);
});

test('local coding changes an isolated committed checkout and verifies actual independent Node checks',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.source,'answer.txt'),'owner draft\n');await fs.writeFile(path.join(f.source,'private-draft.txt'),'owner-only uncommitted file');
  const job=await f.run();assert.equal(job.status,'needs_verification');assert.equal(job.baseCommit,f.base);assert.notEqual(job.checkout,f.source);assert.ok(job.checkout.startsWith(path.join(f.data,'local-coding','checkouts')+path.sep));
  assert.equal(await fs.readFile(path.join(f.source,'answer.txt'),'utf8'),'owner draft\n');assert.equal(await fs.readFile(path.join(f.source,'private-draft.txt'),'utf8'),'owner-only uncommitted file');await assert.rejects(fs.access(path.join(job.checkout,'private-draft.txt')));
  assert.equal(await fs.readFile(path.join(job.checkout,'answer.txt'),'utf8'),'42\n');assert.equal(job.snapshot.hasChanges,true);assert.ok(f.approvals.length>=1,'launch must be approved inside the service');assert.equal(f.service.hasUnfinished('run_fixture'),true);
  const verified=await f.service.verify(job.id,undefined,{botId:'bot_atlas',approve:f.approve});assert.equal(verified.status,'ready_for_review');assert.equal(verified.verification.passed,true);assert.equal(verified.verification.unchanged,true);assert.equal(verified.verification.checks[0].exitCode,0);assert.equal(f.service.hasUnfinished('run_fixture'),false);
  assert.ok(f.commands.some(command=>command.executable===process.execPath && command.cwd===job.checkout));assert.equal((await f.git(['rev-parse','HEAD'])).trim(),f.base);
});

test('local coding keeps failed or file-mutating checks below ready for review',async t=>{
  const f=await fixture(t),job=await f.run();const failed=await f.service.verify(job.id,[{name:'Fail intentionally',executable:process.execPath,args:['-e','process.exit(9)']}],{botId:'bot_atlas',approve:f.approve});assert.equal(failed.status,'checks_failed');assert.equal(failed.verification.passed,false);assert.equal(failed.verification.checks[0].exitCode,9);
  const changed=await f.service.verify(job.id,[{name:'Change during verification',executable:process.execPath,args:['-e',"require('node:fs').writeFileSync('answer.txt','43\\n')"]}],{botId:'bot_atlas',approve:f.approve});assert.equal(changed.status,'checks_failed');assert.equal(changed.verification.unchanged,false);assert.equal(changed.verification.passed,false);
  const before=f.commands.filter(command=>command.executable===process.execPath).length;await assert.rejects(f.service.verify(job.id,[check],{botId:'bot_atlas',approve:async()=>false}),/denied/);assert.equal(f.commands.filter(command=>command.executable===process.execPath).length,before);
});

test('local coding invalidates old verification when the checkout changes',async t=>{
  const f=await fixture(t),job=await f.run();await f.service.verify(job.id,undefined,{botId:'bot_atlas',approve:f.approve});await fs.writeFile(path.join(job.checkout,'answer.txt'),'44\n');const inspected=await f.service.inspect(job.id,{botId:'bot_atlas'});assert.equal(inspected.status,'needs_verification');assert.equal(inspected.verification.passed,false);
  await assert.rejects(f.service.inspect(job.id,{botId:'bot_scout'}),error=>error.status===403);
});

test('local coding never treats a failed or malformed worker response as success',async t=>{
  const f=await fixture(t,{worker:async()=>({status:'running',output:'I claim success'})});await assert.rejects(f.run(),/did not confirm completion/);assert.equal(f.workerCalls.length,1);assert.equal(f.service.data.jobs[0].status,'failed');assert.equal(f.service.data.jobs[0].verification,undefined);assert.equal(f.service.active.size,0);
});

test('local coding bounds correction attempts and reuses only the owned checkout',async t=>{
  const f=await fixture(t);let job=await f.run();const checkout=job.checkout;
  for(let attempt=2;attempt<=4;attempt++){job=await f.run({jobId:job.id,instructions:`Correction attempt ${attempt}.`});assert.equal(job.attempts,attempt);assert.equal(job.checkout,checkout);}
  await assert.rejects(f.run({jobId:job.id}),/four-attempt/);assert.equal(f.workerCalls.length,4);assert.equal(f.service.data.jobs.length,1);
});

test('local coding restart marks unfinished work interrupted without replaying commands',async t=>{
  const f=await fixture(t),job=await f.run();const current=f.service.data.jobs.find(item=>item.id===job.id);current.status='running';await f.service.save();await f.service.close();let replayed=0;
  const recovered=new LocalCoding(f.store,{...f.options,worker:async()=>{replayed++;throw new Error('must not replay');},command:async()=>{replayed++;throw new Error('must not replay');}});t.after(()=>recovered.close());await recovered.init();const status=await recovered.status();assert.equal(status.jobs[0].status,'interrupted');assert.match(status.jobs[0].error,/No command.*replayed/);assert.equal(replayed,0);assert.equal(status.jobs[0].checkout,job.checkout);
});

test('local coding cancellation reaches the worker and preserves a cancelled partial job',async t=>{
  let started;const ready=new Promise(resolve=>{started=resolve;});
  const f=await fixture(t,{worker:async input=>{await fs.writeFile(path.join(input.cwd,'partial.txt'),'partial work');started();return new Promise((resolve,reject)=>{if(input.signal.aborted)reject(input.signal.reason);else input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});});}}),controller=new AbortController();
  const running=f.run({}, {signal:controller.signal}),outcome=running.then(result=>({result}),error=>({error}));await Promise.race([ready,outcome.then(value=>{throw value.error || new Error('Worker completed before cancellation.');})]);controller.abort(new Error('fixture cancellation'));assert.match((await outcome).error.message,/fixture cancellation/);const job=f.service.data.jobs[0];assert.equal(job.status,'cancelled');assert.equal(f.service.active.size,0);assert.equal(await fs.readFile(path.join(job.checkout,'partial.txt'),'utf8'),'partial work');assert.equal(job.verification,undefined);
});

test('local coding worker environment excludes host and Azure credentials and uses a dedicated account home',async t=>{
  const previous=process.env.AZURE_DEVOPS_EXT_PAT;process.env.AZURE_DEVOPS_EXT_PAT='host-fixture-private-token';t.after(()=>{if(previous===undefined)delete process.env.AZURE_DEVOPS_EXT_PAT;else process.env.AZURE_DEVOPS_EXT_PAT=previous;});
  const f=await fixture(t,{project:{organization:'fixture-org',project:'Fixture Project',token:TOKEN},worker:async input=>{await input.onEvent({type:'progress',text:`Reflected ${TOKEN}`});return {status:'completed',sessionId:SESSION,output:`Reflected ${TOKEN}`};}});const job=await f.run();const input=f.workerCalls[0];assert.equal(input.env.AZURE_DEVOPS_EXT_PAT,undefined);assert.equal(input.env.OPENAI_API_KEY,undefined);assert.equal(input.env.ANTHROPIC_API_KEY,undefined);assert.ok(!JSON.stringify(input.env).includes(TOKEN));assert.ok(!input.prompt.includes(TOKEN));assert.equal(input.env.HOME,path.join(f.data,'local-coding','homes','claude'));assert.equal(input.env.CLAUDE_CONFIG_DIR,path.join(input.env.HOME,'.claude'));assert.equal(input.env.GIT_CONFIG_VALUE_5,'false');assert.equal(job.status,'needs_verification');assert.ok(!JSON.stringify(job).includes(TOKEN));assert.match(job.summary,/\[redacted\]/);assert.ok(!(await fs.readFile(path.join(f.data,'local-coding','config.json'),'utf8')).includes(TOKEN));
});

test('local coding review snapshot includes approved commits made by the worker',async t=>{
  const f=await fixture(t,{worker:async input=>{await fs.writeFile(path.join(input.cwd,'answer.txt'),'42\n');for(const args of [['add','answer.txt'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','Worker implementation']]){const result=await codingCommand({executable:'/usr/bin/git',args,cwd:input.cwd,env:input.env,timeoutMs:10000,maxBytes:100000});assert.equal(result.exitCode,0,result.output);}return {status:'completed',sessionId:SESSION,output:'Committed implementation.'};}});
  const job=await f.run();assert.notEqual(job.snapshot.head,f.base);assert.equal(job.snapshot.hasChanges,true);assert.match(job.snapshot.diff,/answer\.txt/);assert.match(job.snapshot.diff,/\+42/);assert.equal((await f.git(['rev-parse','HEAD'])).trim(),f.base);
});

test('local coding reserves one active job before asynchronous preparation',async t=>{
  const f=await fixture(t),results=await Promise.allSettled([f.run({instructions:'First task.'}),f.run({instructions:'Second task.'})]);
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);assert.equal(results.filter(value=>value.status==='rejected' && value.reason.status===409).length,1);assert.equal(f.workerCalls.length,1);assert.equal(f.service.active.size,0);
});

test('local coding Stop waits for worker settlement and persisted cancellation',async t=>{
  let began,settled=false;const ready=new Promise(resolve=>{began=resolve;});
  const f=await fixture(t,{worker:async input=>{began();return new Promise((resolve,reject)=>{input.signal.addEventListener('abort',()=>setTimeout(()=>{settled=true;reject(input.signal.reason);},20),{once:true});});}});
  const outcome=f.run().then(value=>({value}),error=>({error}));await Promise.race([ready,outcome.then(value=>{throw value.error || new Error('Worker ended early.');})]);await f.service.closeRun('run_fixture');assert.equal(settled,true);assert.equal(f.service.active.size,0);assert.equal(f.service.data.jobs[0].status,'cancelled');assert.match((await outcome).error.message,/owning task stopped/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.data,'local-coding','config.json'),'utf8')).jobs[0].status,'cancelled');
});

test('local coding Stop cancels an unanswered launch approval without waiting for its reply',async t=>{
  const f=await fixture(t);let asked,release;const ready=new Promise(resolve=>{asked=resolve;}),answer=new Promise(resolve=>{release=resolve;});
  const outcome=f.run({}, {approve:async()=>{asked();return answer;}}).then(value=>({value}),error=>({error}));await Promise.race([ready,outcome.then(value=>{throw value.error || new Error('Job ended before its approval.');})]);
  let stopped=false;const stopping=f.service.closeRun('run_fixture').then(()=>{stopped=true;});let timer;try{await Promise.race([stopping,new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}finally{clearTimeout(timer);}
  const cancelledWithoutReply=stopped;release(false);await stopping;await outcome;assert.equal(cancelledWithoutReply,true,'Stop must not depend on the owner answering an approval');assert.equal(f.workerCalls.length,0);assert.equal(f.service.data.jobs[0].status,'cancelled');
});

test('local coding publication approves exact effects, commits and repeats real checks before one push and draft PR',async t=>{
  const f=await publicationFixture(t),result=await f.publish();assert.equal(result.status,'published');assert.equal(result.publicationAttempted,true);assert.equal(result.publication.pushed,true);assert.equal(result.publication.pullRequest.isDraft,true);assert.notEqual(result.publication.commit,f.base);
  assert.equal((await f.git(['rev-parse','HEAD'])).trim(),f.base);assert.equal((await f.git(['status','--porcelain'],result.checkout)).trim(),'');assert.equal((await f.git(['log','-1','--format=%s'],result.checkout)).trim(),'Implement assigned task');
  assert.equal(f.commands.filter(command=>command.executable===process.execPath).length,2,'Check must run once before review and again on the commit');assert.equal(f.pushes.length,1);assert.deepEqual(f.azureCalls.map(call=>call.method),['resolveRepository','pullRequest']);assert.equal(f.azureCalls[1].options.approved,true);assert.equal(f.azureCalls[1].input.workItemId,42);
  const approval=f.approvals.find(request=>request.tool==='coding_publish');assert.ok(approval);assert.equal(approval.args.workItemId,42);assert.equal(approval.args.digest,f.job.snapshot.digest);assert.ok(approval.args.commands.some(command=>command.executable===process.execPath));assert.ok(approval.args.commands.some(command=>command.args[0]==='push'));
  const push=f.pushes[0];assert.equal(push.env.GIT_TERMINAL_PROMPT,'0');const gitConfig=Object.fromEntries(Array.from({length:Number(push.env.GIT_CONFIG_COUNT)},(_,index)=>[push.env[`GIT_CONFIG_KEY_${index}`],push.env[`GIT_CONFIG_VALUE_${index}`]]));assert.equal(gitConfig['http.followRedirects'],'false');assert.equal(gitConfig[`http.${push.args[2]}.extraHeader`],`Authorization: Basic ${Buffer.from(`:${TOKEN}`).toString('base64')}`);assert.equal(gitConfig['http.extraHeader'],undefined);assert.ok(!push.args.join(' ').includes(TOKEN));assert.ok(!JSON.stringify(result).includes(TOKEN));
  for(const command of f.commands.filter(command=>command!==push))assert.ok(!JSON.stringify(command.env).includes(TOKEN));
});

test('local coding denied publication performs no commit, push or PR mutation',async t=>{
  const f=await publicationFixture(t),before=(await f.git(['rev-parse','HEAD'],f.job.checkout)).trim();await assert.rejects(f.publish({approve:async request=>request.tool!=='coding_publish'}),/denied/);assert.equal(f.pushes.length,0);assert.ok(f.azureCalls.every(call=>call.method!=='pullRequest'));assert.equal((await f.git(['rev-parse','HEAD'],f.job.checkout)).trim(),before);assert.equal(f.service.data.jobs[0].publicationAttempted,undefined);
});

test('local coding failed checks on the prepared commit prevent all external writes',async t=>{
  const f=await publicationFixture(t),marker=path.join(f.root,'check-condition');await fs.writeFile(marker,'pass');const conditional={name:'External acceptance condition',executable:process.execPath,args:['-e',`if(require('node:fs').readFileSync(${JSON.stringify(marker)},'utf8')!=='pass')process.exit(9)`]};
  await f.service.verify(f.job.id,[conditional],{botId:'bot_atlas',approve:f.approve});await fs.writeFile(marker,'fail');await assert.rejects(f.publish(),/check failed on the prepared commit/);assert.equal(f.service.data.jobs[0].status,'checks_failed');assert.equal(f.pushes.length,0);assert.ok(f.azureCalls.every(call=>call.method!=='pullRequest'));assert.equal(f.service.data.jobs[0].publicationAttempted,undefined);
});

test('local coding lost push acknowledgement records unknown and refuses a publication retry',async t=>{
  const f=await publicationFixture(t,{pushFailure:true});await assert.rejects(f.publish(),/acknowledgement was lost/);assert.equal(f.service.data.jobs[0].status,'unknown');assert.equal(f.service.data.jobs[0].publicationAttempted,true);assert.equal(f.pushes.length,1);assert.ok(f.azureCalls.every(call=>call.method!=='pullRequest'));
  await assert.rejects(f.publish(),/requires changed files|already attempted|current passing/);assert.equal(f.pushes.length,1);const journal=JSON.parse(await fs.readFile(path.join(f.data,'local-coding','config.json'),'utf8'));assert.equal(journal.jobs[0].status,'unknown');assert.equal(journal.jobs[0].publicationAttempted,true);
});

test('local coding incomplete PR evidence cannot mark publication successful',async t=>{
  const f=await publicationFixture(t,{prResult:{}});await assert.rejects(f.publish(),/verified|draft|pull request/i);assert.equal(f.pushes.length,1);assert.equal(f.service.data.jobs[0].status,'unknown');assert.equal(f.service.data.jobs[0].publicationAttempted,true);
});

test('local coding refuses a worker Git URL rewrite before snapshot and preserves source configuration',async t=>{
  const f=await fixture(t,{worker:async input=>{await fs.appendFile(path.join(input.cwd,'.git','config'),'\n[url "https://untrusted.invalid/"]\n insteadOf = https://dev.azure.com/\n');return {status:'completed',sessionId:SESSION,output:'Modified Git configuration.'};}}),original=await fs.readFile(path.join(f.source,'.git','config'),'utf8');
  await assert.rejects(f.run(),/Git|configuration|metadata|checkout/i);assert.equal(f.service.data.jobs[0].status,'failed');assert.equal(f.service.data.jobs[0].snapshot,undefined);assert.equal(await fs.readFile(path.join(f.source,'.git','config'),'utf8'),original);assert.ok(!f.commands.some(command=>command.args[0]==='push'));
});

test('local coding refuses a replaced Git metadata directory even when its configuration bytes match',async t=>{
  const f=await fixture(t,{worker:async input=>{const git=path.join(input.cwd,'.git'),old=path.join(input.cwd,'.git-previous');await fs.rename(git,old);await fs.cp(old,git,{recursive:true});return {status:'completed',sessionId:SESSION,output:'Replaced Git metadata.'};}});
  await assert.rejects(f.run(),/Git|configuration|metadata|checkout/i);assert.equal(f.service.data.jobs[0].status,'failed');assert.equal((await f.git(['rev-parse','HEAD'])).trim(),f.base);
});

test('local coding rejects a Git URL rewrite introduced by publication checks before credentials or push',async t=>{
  const f=await publicationFixture(t),original=await fs.readFile(path.join(f.source,'.git','config'),'utf8'),marker=path.join(f.root,'rewrite-during-publication');
  const rewrite={name:'Fixture conditional configuration change',executable:process.execPath,args:['-e',`const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(marker)}))fs.appendFileSync('.git/config','\\n[url "https://untrusted.invalid/"]\\n insteadOf = https://dev.azure.com/\\n');`]};
  await f.service.verify(f.job.id,[rewrite],{botId:'bot_atlas',approve:f.approve});await fs.writeFile(marker,'activate fixture rewrite');await assert.rejects(f.publish(),/Git|configuration|metadata|checkout/i);
  assert.equal(f.service.data.jobs[0].status,'checks_failed');assert.equal(f.pushes.length,0);assert.ok(f.azureCalls.every(call=>call.method!=='pullRequest'));assert.equal(f.service.data.jobs[0].publicationAttempted,undefined);assert.equal(await fs.readFile(path.join(f.source,'.git','config'),'utf8'),original);
  assert.ok(f.commands.every(command=>!Object.values(command.env || {}).some(value=>typeof value==='string' && value.includes(Buffer.from(`:${TOKEN}`).toString('base64')))));
});

test('local coding publication uses fresh Git configuration instead of the worker global URL rewrite',async t=>{
  const f=await publicationFixture(t,{worker:async input=>{await fs.writeFile(path.join(input.cwd,'answer.txt'),'42\n');await fs.writeFile(path.join(input.env.HOME,'.gitconfig'),'[url "https://untrusted.invalid/"]\n insteadOf = https://dev.azure.com/\n');return {status:'completed',sessionId:SESSION,output:'Fixture edited worker global Git settings.'};}}),result=await f.publish();
  assert.equal(result.status,'published');assert.equal(f.pushes.length,1);const push=f.pushes[0];assert.notEqual(push.env.HOME,f.workerCalls[0].env.HOME);assert.notEqual(push.env.GIT_CONFIG_GLOBAL,f.workerCalls[0].env.GIT_CONFIG_GLOBAL);const global=await fs.readFile(push.env.GIT_CONFIG_GLOBAL,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});assert.ok(!global.includes('untrusted.invalid'));
  assert.equal(push.args[2],`https://dev.azure.com/fixture-org/Fixture%20Project/_git/${REPOSITORY}`);
});
