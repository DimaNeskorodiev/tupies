import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { AgentTools, getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { validateRoutine } from '../lib/routines.mjs';
import { createStudioServer } from '../server.mjs';

const hasPython=spawnSync('python3',['--version']).status===0;
const until=async(predicate,label='condition')=>{for(let i=0;i<2000;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Timed out waiting for ${label}.`);};
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

async function runtime(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-terminal-')),store=await new Store(directory).init();
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const bot={...store.state.bots[0],tools:['workspace','terminal']},tools=new AgentTools(store,{});
  const run=(command,options={})=>tools.execute(bot,'terminal',{command,...(options.timeoutMs?{timeoutMs:options.timeoutMs}:{})},{approved:true,runId:options.runId || 'run_a',signal:options.signal});
  const code=(language,source,runId='run_a')=>tools.execute(bot,'execute_code',{language,code:source},{approved:true,runId});
  return {store,bot,tools,run,code,root:await fs.realpath(await getWorkspaceRoot(store,bot.id))};
}

test('terminal keeps the folder and exported variables between commands of one task',async t=>{
  const h=await runtime(t);
  let result=await h.run('mkdir -p src/app && cd src/app && export GREETING="hello world" && echo started');
  assert.deepEqual([result.exitCode,result.cwd,result.output],[0,'src/app','started\n']);
  result=await h.run('pwd; echo "$GREETING"');
  assert.equal(result.output,`${h.root}/src/app\nhello world\n`);assert.equal(result.cwd,'src/app');
  result=await h.run('unset GREETING; cd ..; echo "${GREETING-unset}"; exit 3');
  assert.deepEqual([result.exitCode,result.cwd,result.output],[3,'src','unset\n']);
  result=await h.run('echo "${GREETING-unset}"; pwd');
  assert.equal(result.output,`unset\n${h.root}/src\n`,'state from an exiting command is kept');
  // Another task starts fresh in the workspace.
  result=await h.run('pwd; echo "${GREETING-none}"',{runId:'run_b'});
  assert.equal(result.output,`${h.root}\nnone\n`);
  assert.deepEqual(h.tools.terminal.peek(h.bot.id,'run_a'),{root:h.root,cwd:`${h.root}/src`});
  assert.ok(Number.isInteger(result.durationMs) && result.durationMs>=0);
});

test('protective process settings cannot be persisted away and injected variables are dropped',async t=>{
  const h=await runtime(t);
  await h.run('export GIT_CONFIG_COUNT=0 LD_PRELOAD=/tmp/x.so BASH_ENV=/tmp/evil; unset PYTHONNOUSERSITE; f(){ echo injected; }; export -f f');
  const result=await h.run('echo "$GIT_CONFIG_COUNT ${LD_PRELOAD-none} ${BASH_ENV-none} ${PYTHONNOUSERSITE-unset}"; type f >/dev/null 2>&1 && echo has-f || echo no-f');
  assert.equal(result.output,'4 none none 1\nno-f\n');
  const env=await h.run('env');
  assert.doesNotMatch(env.output,/TUPIES_/,'the transport variables are removed before the command runs');
});

test('output keeps a head and tail window, exit codes and timeouts are reported',async t=>{
  const h=await runtime(t);
  let result=await h.run('for i in $(seq 1 20000); do echo "line $i"; done; echo done >&2');
  assert.equal(result.truncated,true);assert.ok(result.omittedBytes>0);assert.match(result.output,/^line 1\n/);assert.match(result.output,/done\n$/);assert.match(result.output,/bytes omitted/);
  assert.ok(result.output.length<30000);
  result=await h.run('sleep 5',{timeoutMs:1000});
  assert.equal(result.timedOut,true);assert.notEqual(result.exitCode,0);assert.ok(result.durationMs<4000);
  result=await h.run('false');assert.equal(result.exitCode,1);
  await assert.rejects(h.run('echo x',{timeoutMs:10}),/1000/);
  await assert.rejects(h.tools.execute(h.bot,'terminal',{command:''},{approved:true,runId:'run_a'}),/bash command/);
  await assert.rejects(h.tools.execute(h.bot,'terminal',{command:'ls'},{runId:'run_a'}),/requires approval/,'execution always needs an engine decision');
});

test('Stop kills the whole command process group, including background children',async t=>{
  const h=await runtime(t),controller=new AbortController(),started=Date.now();
  const pending=h.run('sleep 30 & echo $! > child.pid; wait',{signal:controller.signal});
  await until(async()=>{try{return (await fs.readFile(path.join(h.root,'child.pid'),'utf8')).trim().length>0;}catch{return false;}},'the child pid');
  const child=Number((await fs.readFile(path.join(h.root,'child.pid'),'utf8')).trim());assert.ok(alive(child));
  controller.abort(new Error('Fixture Stop'));
  await assert.rejects(pending,/Fixture Stop/);
  assert.ok(Date.now()-started<10000);
  await until(()=>!alive(child),'the background child to exit');
});

test('a crashed Engine process cannot leave a terminal command running',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-terminal-crash-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const lib=path.dirname(fileURLToPath(import.meta.url)).replace(/test$/,'lib');
  const script=`const {Store}=await import(${JSON.stringify(path.join(lib,'store.mjs'))});const {AgentTools}=await import(${JSON.stringify(path.join(lib,'agent-tools.mjs'))});
const store=await new Store(${JSON.stringify(directory)}).init();const bot={...store.state.bots[0],tools:['workspace','terminal']};
await new AgentTools(store,{}).execute(bot,'terminal',{command:'sleep 30 & echo $! > child.pid; wait'},{approved:true,runId:'crash'});`;
  const engine=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});
  // Only the child process opens this data directory; find its workspace file without a second Store.
  let pidFile;
  await until(async()=>{try{for(const name of await fs.readdir(path.join(directory,'workspaces'))){const file=path.join(directory,'workspaces',name,'child.pid');if((await fs.readFile(file,'utf8').catch(()=>'')).trim()){pidFile=file;return true;}}}catch{}return false;},'the command to start');
  const child=Number((await fs.readFile(pidFile,'utf8')).trim());assert.ok(alive(child));
  engine.kill('SIGKILL');
  await until(()=>!alive(child),'the guardian to stop the orphaned command');
});

test('commands finishing normally do not leave background processes behind',async t=>{
  const h=await runtime(t);
  const result=await h.run('sleep 30 & echo $! > child.pid; echo spawned');
  assert.equal(result.output,'spawned\n');
  const child=Number((await fs.readFile(path.join(h.root,'child.pid'),'utf8')).trim());
  await until(()=>!alive(child),'the leftover child to be stopped');
});

test('execute_code runs Node and Python snippets from a temporary workspace file in the task folder',async t=>{
  const h=await runtime(t);
  await h.run('mkdir -p data && cd data && echo 41 > n.txt');
  let result=await h.code('node','import { readFileSync } from "node:fs";\nconsole.log(Number(readFileSync("n.txt","utf8"))+1, await Promise.resolve("ok"));');
  assert.deepEqual([result.exitCode,result.output,result.cwd,result.language],[0,'42 ok\n','data','node']);
  result=await h.code('node','const fs=require("fs");console.log(fs.existsSync("n.txt"))');
  assert.equal(result.output,'true\n');
  result=await h.code('node','throw new Error("boom")');
  assert.equal(result.exitCode,1);assert.match(result.output,/boom/);
  if(hasPython) {
    result=await h.code('python','import os\nprint(open("n.txt").read().strip(), os.path.basename(os.getcwd()))');
    assert.deepEqual([result.exitCode,result.output],[0,'41 data\n']);
  }
  assert.deepEqual(await fs.readdir(path.join(h.root,'.tmp','code')),[],'snippet files are removed');
  await assert.rejects(h.tools.execute(h.bot,'execute_code',{language:'ruby',code:'puts 1'},{approved:true,runId:'run_a'}),/python or node|allowed value|enum/i);
});

async function engineFixture(t,{policy='auto',calls,extra={}}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-terminal-engine-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections=[{id:'fixture',type:'custom',defaultModel:'fixture-model'}];Object.assign(state.bots[0],{connectionId:'fixture',approvalPolicy:policy,tools:['workspace','terminal'],...extra});});
  let step=0;const reviews=[];
  const engine=new NativeEngine(store,{runTimeout:30000,providers:{complete:async()=>{const call=calls[step++];return call?{toolCalls:[{id:`call_${step}`,...call}]}:{text:'Finished.',toolCalls:[]};},reviewAction:async request=>{reviews.push(request);throw new Error('The model reviewer must not run for terminal actions.');}}});
  await engine.recover();t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot=store.state.bots[0],run=()=>store.state.runs[bot.id];
  return {store,engine,bot,run,reviews,events:type=>run().events.filter(event=>event.type===type),root:async()=>fs.realpath(await getWorkspaceRoot(store,bot.id))};
}

test('engine: read-only commands run in Balanced without a prompt and without a model review',async t=>{
  const h=await engineFixture(t,{policy:'balanced',calls:[{name:'terminal',arguments:{command:'echo hello > /dev/null && ls -a'}},{name:'execute_code',arguments:{language:'node',code:'console.log(6 * 7)'}}]});
  const started=await h.engine.start(h.bot.id,'Look around.');await h.engine.tasks.get(started.id);
  assert.equal(h.run().status,'completed');assert.equal(h.events('approval.request').length,0);assert.equal(h.reviews.length,0);
  assert.deepEqual(h.events('approval.automatic').map(event=>event.reason),['Read-only command inside the workspace.','Read-only command inside the workspace.']);
  assert.ok(h.events('tool.completed').some(event=>event.tool==='execute_code' && event.preview.includes('42') && !event.error));
});

test('engine: dangerous commands wait for the exact owner approval even with Approve for me',async t=>{
  const h=await engineFixture(t,{calls:[{name:'terminal',arguments:{command:'mkdir -p build && rm -rf build && echo removed'}}]});
  const root=await h.root();await fs.mkdir(path.join(root,'build'),{recursive:true});
  const started=await h.engine.start(h.bot.id,'Clean the build.');await until(()=>h.run()?.status==='waiting_for_approval','approval');
  const run=h.run(),prompt=run.pending_controls[0];
  assert.equal(prompt.tool,'terminal');assert.equal(prompt.arguments.command,'mkdir -p build && rm -rf build && echo removed');
  assert.equal(prompt.review.command.risk,'dangerous');assert.equal(prompt.review.command.cwd,'.');assert.match(prompt.review.riskReason,/^Dangerous: rm deletes/);
  assert.equal(h.reviews.length,0);
  await fs.access(path.join(root,'build'));
  await h.engine.control(h.bot.id,'approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:prompt.prompt_id,execution_generation:run.execution_generation,choice:'once'});
  await h.engine.tasks.get(started.id);
  assert.equal(h.run().status,'completed');await assert.rejects(fs.access(path.join(root,'build')));
  assert.ok(h.events('tool.completed').some(event=>event.tool==='terminal' && event.preview.includes('removed')));
});

test('engine: ordinary commands run in the owner chat with Approve for me and ask in Balanced',async t=>{
  const command={name:'terminal',arguments:{command:'echo data > out.txt && cat out.txt'}};
  const auto=await engineFixture(t,{calls:[command]});
  let started=await auto.engine.start(auto.bot.id,'Write a file.');await auto.engine.tasks.get(started.id);
  assert.equal(auto.run().status,'completed');assert.match(auto.events('approval.automatic')[0].reason,/Approve for me/);assert.equal(auto.reviews.length,0);
  const balanced=await engineFixture(t,{policy:'balanced',calls:[command]});
  started=await balanced.engine.start(balanced.bot.id,'Write a file.');await until(()=>balanced.run()?.status==='waiting_for_approval','approval');
  assert.equal(balanced.run().pending_controls[0].review.command.risk,'normal');
  await balanced.engine.control(balanced.bot.id,'stop',{runId:balanced.run().id,remoteRunId:balanced.run().remoteRunId});await balanced.engine.tasks.get(started.id);
  // The owner's allowlist lets the same command run unattended.
  const allowed=await engineFixture(t,{policy:'balanced',calls:[{name:'terminal',arguments:{command:'node --eval "process.stdout.write(String(6*7))"'}}],extra:{commandAllowlist:['node --eval *']}});
  started=await allowed.engine.start(allowed.bot.id,'Compute.');await allowed.engine.tasks.get(started.id);
  assert.equal(allowed.run().status,'completed');assert.match(allowed.events('approval.automatic')[0].reason,/allowed command/);
});

test('engine: Stop during a running terminal command cancels the task and kills the process',async t=>{
  const h=await engineFixture(t,{calls:[{name:'terminal',arguments:{command:'sleep 30 & echo $! > child.pid; wait'}}]});
  const root=await h.root(),started=await h.engine.start(h.bot.id,'Wait.');
  await until(async()=>{try{return (await fs.readFile(path.join(root,'child.pid'),'utf8')).trim().length>0;}catch{return false;}},'the command to start');
  const child=Number((await fs.readFile(path.join(root,'child.pid'),'utf8')).trim());
  await h.engine.control(h.bot.id,'stop',{runId:h.run().id,remoteRunId:h.run().remoteRunId});await h.engine.tasks.get(started.id);
  assert.equal(h.run().status,'cancelled');await until(()=>!alive(child),'the command to be killed');
});

test('engine: a routine runs its pre-approved exact command unattended; other commands still wait',async t=>{
  const h=await engineFixture(t,{policy:'balanced',calls:[{name:'terminal',arguments:{command:'echo 2 > report.txt && cat report.txt'}},{name:'terminal',arguments:{command:'echo 4 > other.txt'}}]});
  await h.store.mutate(state=>{state.routines.push({...validateRoutine({name:'Report',botId:h.bot.id,prompt:'Run the report.',intervalMinutes:60,enabled:false,commands:['echo 2 > report.txt && cat report.txt']}),id:'routine_report'});});
  const started=await h.engine.runRoutine('routine_report');
  await until(()=>h.run()?.status==='waiting_for_approval','the second command to wait');
  assert.match(h.events('approval.automatic')[0].reason,/pre-approved this exact command/);
  assert.ok(h.events('tool.completed').some(event=>event.tool==='terminal' && event.preview.includes('2') && !event.error));
  assert.equal(h.run().pending_controls[0].arguments.command,'echo 4 > other.txt');
  await h.engine.control(h.bot.id,'stop',{runId:h.run().id,remoteRunId:h.run().remoteRunId});await h.engine.tasks.get(started.id);
});

test('owner API saves the command allowlist; bots cannot set it through Manage Tupies',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-allowlist-api-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0,'127.0.0.1');
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'synthetic-allowlist-password'})});
  const cookie=setup.headers.get('set-cookie').split(';')[0],{csrf}=await setup.json();
  const request=(endpoint,method,body,headers={Cookie:cookie,'X-CSRF-Token':csrf})=>fetch(url+endpoint,{method,headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const bot=await (await request('/api/bots','POST',{name:'Builder',title:'Fixture',tools:['workspace','terminal']})).json();
  let response=await request(`/api/bots/${bot.id}`,'PATCH',{commandAllowlist:['npm test','npm run *']});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).commandAllowlist,['npm test','npm run *']);
  assert.equal((await request(`/api/bots/${bot.id}`,'PATCH',{commandAllowlist:['npm test; rm -rf /']})).status,400);
  assert.equal((await request(`/api/bots/${bot.id}`,'PATCH',{commandAllowlist:['*']})).status,400);
  assert.equal((await request(`/api/bots/${bot.id}`,'PATCH',{commandAllowlist:['ls']},{Cookie:cookie})).status,403);
  // The Manage Tupies tool schema has no allowlist field (its handler forwards only fixed profile keys).
  const tools=new AgentTools(app.store,{});
  assert.throws(()=>tools.validate({...app.store.state.bots[0],tools:['setup']},'bots_update',{botId:bot.id,commandAllowlist:['rm *']}),/unknown arguments/);
});
