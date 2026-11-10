import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { validateRoutine } from '../lib/routines.mjs';
import { decideAction } from '../lib/command-policy.mjs';
import { EXECUTION_BACKEND_IDS, validateExecution, executionReadiness, prepareLaunch, overrideExecutionBackendForTests } from '../lib/exec/index.mjs';
import { createDockerBackend } from '../lib/exec/docker.mjs';
import { createSshBackend } from '../lib/exec/ssh.mjs';
import { createStudioServer } from '../server.mjs';

const until=async(predicate,label='condition')=>{for(let i=0;i<2000;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Timed out waiting for ${label}.`);};
// Backends that cannot work on any machine: no CLI anywhere, no SSH settings.
const NOWHERE={docker:()=>createDockerBackend({env:{},searchDirs:['/nonexistent-bin']}),ssh:()=>createSshBackend({env:{},searchDirs:['/nonexistent-bin']})};
const hide=(t,id)=>{overrideExecutionBackendForTests(id,NOWHERE[id]());t.after(()=>overrideExecutionBackendForTests(id,null));};

test('registry: docker and ssh are valid choices next to host and sandbox',()=>{
  assert.deepEqual(EXECUTION_BACKEND_IDS,['host','sandbox','docker','ssh']);
  assert.deepEqual(validateExecution({backend:'docker'}),{backend:'docker'});assert.deepEqual(validateExecution({backend:'ssh'}),{backend:'ssh'});
  assert.throws(()=>validateExecution({backend:'vm'}),/Choose where commands run: host or sandbox or docker or ssh\./);
});

test('readiness and launch: an unavailable docker or ssh fails closed, and falls back to the host only after a disclosed approval',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-reg-')),store=await new Store(directory).init();
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const root=path.join(directory,'ws'),home=path.join(directory,'home');await fs.mkdir(root);await fs.mkdir(home);
  for(const id of ['docker','ssh']) {
    hide(t,id);
    const bot={id:'bot',execution:{backend:id}};
    const readiness=await executionReadiness({store,bot});
    assert.equal(readiness.ready,false);assert.equal(readiness.isolated,false);assert.equal(readiness.backend,id);
    assert.match(readiness.reason,id==='docker'?/docker command is not installed/:/SSH is not set up on this engine/);
    await assert.rejects(prepareLaunch({store,bot,workspaceRoot:root,home,env:{},cwd:root,executable:'ls',args:[]}),error=>error.status===409 && error.code==='sandbox_unavailable' && /Nothing ran on this computer/.test(error.message));
    const fallback=await prepareLaunch({store,bot,workspaceRoot:root,home,env:{A:'1'},cwd:root,executable:'ls',args:['-l'],hostFallback:'approved'});
    assert.equal(fallback.backend,'host');assert.equal(fallback.executable,'ls');assert.equal(fallback.fallbackReason,'approved');
    // The policy: an unavailable backend never counts as isolation, and the reason names it.
    const context={bot:{id:'bot',approvalPolicy:'balanced',tools:['workspace','terminal'],execution:{backend:id}},source:'chat',sessionId:'bot',runId:'run'};
    const decision=decideAction({context,call:{id:'c',name:'terminal',arguments:{command:'echo x > y'}},currentBot:context.bot,session:{root:'/srv',cwd:'/srv'},execution:readiness});
    assert.equal(decision.automatic,false);assert.match(decision.reason,id==='docker'?/The Docker container is unavailable \(/:/The remote machine is unavailable \(/);
  }
});

test('engine: a routine on an unavailable Docker bot asks first, exactly as with the sandbox',async t=>{
  hide(t,'docker');
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-reg-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections=[{id:'fixture',type:'custom',defaultModel:'fixture-model'}];Object.assign(state.bots[0],{connectionId:'fixture',approvalPolicy:'balanced',tools:['workspace','terminal'],execution:{backend:'docker'}});});
  let step=0;const calls=[{name:'terminal',arguments:{command:'echo ran > report.txt'}}];
  const engine=new NativeEngine(store,{runTimeout:30000,providers:{complete:async()=>{const call=calls[step++];return call?{toolCalls:[{id:`call_${step}`,...call}]}:{text:'Finished.',toolCalls:[]};}}});
  await engine.recover();t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot=store.state.bots[0],run=()=>store.state.runs[bot.id];
  await store.mutate(state=>{state.routines.push({...validateRoutine({name:'Report',botId:bot.id,prompt:'Run the report.',intervalMinutes:60,enabled:false}),id:'routine_report'});});
  const started=await engine.runRoutine('routine_report');await until(()=>run()?.status==='waiting_for_approval','approval');
  assert.match(run().pending_controls[0].review.riskReason,/The Docker container is unavailable \(The docker command is not installed on this computer\./);
  assert.equal(existsSync(path.join(await getWorkspaceRoot(store,bot.id),'report.txt')),false);
  const pending=run().pending_controls[0];
  await engine.control(bot.id,'approval',{runId:run().id,remoteRunId:run().remoteRunId,request_id:pending.prompt_id,execution_generation:run().execution_generation,choice:'once'});
  await engine.tasks.get(started.id);
  assert.equal(run().status,'completed');
  assert.equal(run().workRecords.find(record=>record.tool==='terminal').backend,'host');
});

test('API: /api/execution lists all four backends and bots can select docker and ssh',async t=>{
  hide(t,'docker');hide(t,'ssh');
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-api2-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0,'127.0.0.1');
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'synthetic-execution-password'})});
  const cookie=setup.headers.get('set-cookie').split(';')[0],{csrf}=await setup.json();
  const request=(endpoint,method,body)=>fetch(url+endpoint,{method,headers:{'content-type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},...(body?{body:JSON.stringify(body)}:{})});
  const {backends}=await (await request('/api/execution','GET')).json();
  assert.deepEqual(backends.map(item=>item.id),['host','sandbox','docker','ssh']);
  const docker=backends.find(item=>item.id==='docker'),ssh=backends.find(item=>item.id==='ssh');
  assert.equal(docker.label,'Docker container');assert.equal(docker.available,false);assert.match(docker.reason,/docker command is not installed/);assert.equal(docker.isolated,true);
  assert.equal(ssh.label,'Another machine (SSH)');assert.equal(ssh.available,false);assert.match(ssh.reason,/SSH is not set up on this engine/);assert.match(ssh.summary,/stay on that machine/);
  const bot=await (await request('/api/bots','POST',{name:'Builder',title:'Fixture',tools:['workspace','terminal']})).json();
  for(const id of ['docker','ssh'])assert.deepEqual((await (await request(`/api/bots/${bot.id}`,'PATCH',{execution:{backend:id}})).json()).execution,{backend:id});
  assert.deepEqual((await (await request(`/api/bots/${bot.id}`,'PATCH',{executionBackend:'ssh'})).json()).execution,{backend:'ssh'});
});

test('UI: both new choices are offered with plain explanations and status lines',async()=>{
  const source=await fs.readFile(new URL('../public/execution.js',import.meta.url),'utf8');
  const window={},document={readyState:'complete',documentElement:{},addEventListener(){},querySelectorAll:()=>[]};
  vm.runInNewContext(source,{window,document,MutationObserver:class{observe(){}},fetch:()=>{throw new Error('not in this test');},console});
  const {fieldHTML,statusText}=window.StudioExecution;
  assert.match(fieldHTML({}),/<option value="sandbox" >Sandbox on this computer \(recommended\)<\/option><option value="docker" >Docker container<\/option><option value="ssh" >Another machine \(SSH\)<\/option>/);
  assert.match(fieldHTML({execution:{backend:'docker'}}),/<option value="docker" selected>Docker container<\/option>/);
  assert.match(fieldHTML({execution:{backend:'docker'}}),/fresh Docker container that can change only this bot’s own folders/);
  assert.match(fieldHTML({execution:{backend:'ssh'}}),/<option value="ssh" selected>Another machine \(SSH\)<\/option>.*Files the bot creates there stay on that machine/);
  assert.deepEqual({...statusText('docker',[{id:'docker',available:true}])},{state:'ready',text:'Docker ready.'});
  assert.deepEqual({...statusText('ssh',[{id:'ssh',available:true}])},{state:'ready',text:'The other machine is ready.'});
  const down=statusText('docker',[{id:'docker',available:false,reason:'Docker is not running. Start Docker, then try again.'}]);
  assert.equal(down.state,'down');assert.equal(down.text,'Docker is not running. Start Docker, then try again. Until this works, this bot asks you before every command that can change files.');
  assert.match(statusText('docker',[{id:'docker',available:false,reason:'Image tupies-exec is not on this computer. Run: docker pull tupies-exec'}]).text,/^Image tupies-exec is not on this computer\. Run: docker pull tupies-exec Until this works, this bot asks you before every command/);
  assert.match(statusText('ssh',[{id:'ssh',available:false,reason:'SSH is not set up on this engine.'}]).text,/^SSH is not set up on this engine\. Until this works, this bot asks you before every command that can change files\.$/);
  assert.match(statusText('ssh',[]).text,/cannot run commands there/);
});
