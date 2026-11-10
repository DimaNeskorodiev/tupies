import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { validateRoutine } from '../lib/routines.mjs';
import { decideAction } from '../lib/command-policy.mjs';
import { overrideExecutionBackendForTests } from '../lib/exec/index.mjs';
import { createStudioServer } from '../server.mjs';

const seatbelt=process.platform==='darwin' && existsSync('/usr/bin/sandbox-exec');
const until=async(predicate,label='condition')=>{for(let i=0;i<2000;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Timed out waiting for ${label}.`);};

// ---- Pure policy ----
const root='/srv/ws/bot';
const bot=(approvalPolicy='balanced',extra={})=>({id:'bot',approvalPolicy,tools:['workspace','terminal'],execution:{backend:'sandbox'},...extra});
const terminal=command=>({id:'call',name:'terminal',arguments:{command}});
const owner=(policy,extra)=>({bot:bot(policy,extra),source:'chat',sessionId:'bot',runId:'run'});
const READY={backend:'sandbox',isolated:true,ready:true,reason:''},DOWN={backend:'sandbox',isolated:false,ready:false,reason:'fixture outage'};
const decide=({context,call,current=context.bot,execution=READY})=>decideAction({context,call,currentBot:current,session:{root,cwd:root},execution});

test('policy: inside a ready sandbox read-only and ordinary commands run in every lane; dangerous and Strict still ask',()=>{
  const lanes={owner,routine:policy=>({...owner(policy),source:'routine',routine:{id:'r1'}}),teammate:policy=>({...owner(policy),source:'delegation',delegation:{depth:1}}),telegram:policy=>({...owner(policy),source:'telegram'}),room:policy=>({...owner(policy),source:'room',roomId:'room'})};
  const commands=['ls','echo data > out.txt && npm install left-pad','rm -rf build'];
  for(const policy of ['auto','balanced','strict'])for(const [lane,make] of Object.entries(lanes)) {
    const got=commands.map(command=>decide({context:make(policy),call:terminal(command)}).automatic);
    assert.deepEqual(got,policy==='strict'?[false,false,false]:[true,true,false],`${policy} ${lane}`);
  }
  const ordinary=decide({context:lanes.routine('balanced'),call:terminal('echo data > out.txt')});
  assert.match(ordinary.reason,/Ordinary command in this bot’s sandbox/);assert.equal(ordinary.backend,'sandbox');
  const dangerous=decide({context:lanes.routine('auto'),call:terminal('rm -rf build')});
  assert.match(dangerous.reason,/^Dangerous: .*It will run in this bot’s sandbox\.$/);assert.equal(dangerous.backend,'sandbox');
  assert.match(decide({context:owner('strict'),call:terminal('ls')}).reason,/^Strict review.*sandbox\.$/);
  // execute_code and the literal-argument tools follow the same rule.
  assert.equal(decide({context:lanes.routine('balanced'),call:{name:'execute_code',arguments:{language:'python',code:'open("x","w").write("1")'}}}).automatic,true);
  for(const name of ['shell_run','shell_start'])assert.equal(decide({context:lanes.telegram('balanced'),call:{name,arguments:{executable:'npm',args:['test']}}}).automatic,true,name);
  assert.equal(decide({context:lanes.telegram('balanced'),call:{name:'shell_run',arguments:{executable:'rm',args:['-rf','x']}}}).automatic,false);
});

test('policy: the sandbox counts only when snapshot and saved bot select it and it is ready at admission',()=>{
  const routine={...owner('balanced'),source:'routine',routine:{id:'r1'}},call=terminal('echo data > out.txt');
  const host=bot('balanced',{execution:undefined});
  assert.equal(decide({context:routine,call,current:host}).automatic,false,'the owner switched the saved bot back to asking');
  assert.equal(decide({context:{...routine,bot:host},call,current:bot('balanced')}).automatic,false,'the task started before the sandbox was chosen');
  const down=decide({context:routine,call,execution:DOWN});
  assert.equal(down.automatic,false);assert.equal(down.backend,'host');
  assert.match(down.reason,/The sandbox is unavailable \(fixture outage\), so this command would run on this computer without isolation\.$/);
  assert.match(decide({context:routine,call,execution:null}).reason,/unavailable \(not checked yet\)/);
  assert.equal(decide({context:routine,call:terminal('ls'),execution:DOWN}).automatic,true,'read-only keeps its host meaning');
  assert.equal(decide({context:routine,call,execution:{...READY,backend:'docker'}}).automatic,false,'readiness of another backend does not count');
  assert.equal(decide({context:{...routine,bot:bot('balanced',{tools:['workspace']})},call,current:bot('balanced',{tools:['workspace']})}).automatic,false,'terminal access is still required');
  // Without a setting nothing changes and the reasons carry no execution note.
  const plain=decideAction({context:{...routine,bot:host},call,currentBot:host,session:{root,cwd:root}});
  assert.equal(plain.automatic,false);assert.equal(plain.reason,'This command can change files or run code. Review this exact action, or add it to the bot’s allowed commands.');assert.equal(plain.backend,'host');
});

// ---- Engine ----
const fakeSandbox=({ok=true,reason='',calls=[]}={})=>({id:'sandbox',label:'Sandbox on this computer (recommended)',noun:'sandbox',isolated:true,
  async available(){return {ok,reason};},describe(){return {summary:'fixture'};},async check(paths){calls.push(['check',paths.botId]);},
  async prepare(launch){calls.push(['prepare',launch.executable]);return {executable:launch.executable,args:launch.args,env:{...launch.env,TUPIES_FIXTURE_SANDBOX:'1'},cwd:launch.cwd};}});

async function engineFixture(t,{policy='balanced',calls,extra={execution:{backend:'sandbox'}},backend=fakeSandbox()}) {
  if(backend){overrideExecutionBackendForTests('sandbox',backend);t.after(()=>overrideExecutionBackendForTests('sandbox',null));}
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-policy-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections=[{id:'fixture',type:'custom',defaultModel:'fixture-model'}];Object.assign(state.bots[0],{connectionId:'fixture',approvalPolicy:policy,tools:['workspace','terminal'],...extra});});
  let step=0;const reviews=[];
  const engine=new NativeEngine(store,{runTimeout:30000,providers:{complete:async()=>{const call=calls[step++];return call?{toolCalls:[{id:`call_${step}`,...call}]}:{text:'Finished.',toolCalls:[]};},reviewAction:async request=>{reviews.push(request);throw new Error('The model reviewer must not run for terminal actions.');}}});
  await engine.recover();t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot=store.state.bots[0],run=()=>store.state.runs[bot.id];
  await store.mutate(state=>{state.routines.push({...validateRoutine({name:'Report',botId:bot.id,prompt:'Run the report.',intervalMinutes:60,enabled:false}),id:'routine_report'});});
  return {store,engine,bot,run,reviews,events:type=>(run()?.events || []).filter(event=>event.type===type),root:async()=>fs.realpath(await getWorkspaceRoot(store,bot.id))};
}
const allow=async h=>{const run=h.run(),prompt=run.pending_controls[0];await h.engine.control(h.bot.id,'approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:prompt.prompt_id,execution_generation:run.execution_generation,choice:'once'});};
const stop=async(h,started)=>{await h.engine.control(h.bot.id,'stop',{runId:h.run().id,remoteRunId:h.run().remoteRunId});await h.engine.tasks.get(started.id);};

test('engine: with the sandbox an ordinary command in a routine runs with no approval card and its receipt says sandbox',async t=>{
  const calls=[],backend=fakeSandbox({calls});
  const h=await engineFixture(t,{backend,calls:[{name:'terminal',arguments:{command:'echo "$TUPIES_FIXTURE_SANDBOX" > report.txt && cat report.txt'}}]});
  const started=await h.engine.runRoutine('routine_report');await h.engine.tasks.get(started.id);
  assert.equal(h.run().status,'completed');assert.equal(h.events('approval.request').length,0);assert.equal(h.reviews.length,0);
  assert.match(h.events('approval.automatic')[0].reason,/Ordinary command in this bot’s sandbox/);
  assert.equal(await fs.readFile(path.join(await h.root(),'report.txt'),'utf8'),'1\n','the command was started through the backend');
  const receipt=h.run().workRecords.find(record=>record.tool==='terminal');
  assert.deepEqual([receipt.status,receipt.backend],['succeeded','sandbox']);
  assert.deepEqual(calls,[['check',h.bot.id],['prepare','bash']],'readiness was checked at admission, then the launch was prepared');
});

test('engine: a dangerous command still waits for its exact card inside the sandbox',async t=>{
  const h=await engineFixture(t,{policy:'auto',calls:[{name:'terminal',arguments:{command:'mkdir -p build && rm -rf build && echo removed'}}]});
  const started=await h.engine.runRoutine('routine_report');await until(()=>h.run()?.status==='waiting_for_approval','approval');
  const prompt=h.run().pending_controls[0];
  assert.equal(prompt.arguments.command,'mkdir -p build && rm -rf build && echo removed');assert.equal(prompt.review.command.risk,'dangerous');
  assert.match(prompt.review.riskReason,/^Dangerous: .*It will run in this bot’s sandbox\.$/);
  await allow(h);await h.engine.tasks.get(started.id);
  assert.equal(h.run().status,'completed');
  assert.equal(h.run().workRecords.find(record=>record.tool==='terminal').backend,'sandbox','the approved command also ran in the sandbox');
});

test('engine: Strict still asks for every command inside the sandbox',async t=>{
  const h=await engineFixture(t,{policy:'strict',calls:[{name:'terminal',arguments:{command:'ls'}}]});
  const started=await h.engine.runRoutine('routine_report');await until(()=>h.run()?.status==='waiting_for_approval','approval');
  assert.match(h.run().pending_controls[0].review.riskReason,/^Strict review/);
  await stop(h,started);
});

test('engine: an unavailable sandbox falls back to asking, says why, and runs on the host only after approval',async t=>{
  const h=await engineFixture(t,{backend:fakeSandbox({ok:false,reason:'fixture outage'}),calls:[{name:'terminal',arguments:{command:'echo "[$TUPIES_FIXTURE_SANDBOX]" > report.txt && cat report.txt'}}]});
  const started=await h.engine.runRoutine('routine_report');await until(()=>h.run()?.status==='waiting_for_approval','approval');
  assert.match(h.run().pending_controls[0].review.riskReason,/The sandbox is unavailable \(fixture outage\), so this command would run on this computer without isolation\./);
  assert.equal(existsSync(path.join(await h.root(),'report.txt')),false);
  await allow(h);await h.engine.tasks.get(started.id);
  assert.equal(h.run().status,'completed');
  assert.equal(await fs.readFile(path.join(await h.root(),'report.txt'),'utf8'),'[]\n');
  const receipt=h.run().workRecords.find(record=>record.tool==='terminal');assert.equal(receipt.backend,'host');
});

test('engine: a sandbox that breaks after admission fails closed instead of running on the host',async t=>{
  let ok=true;const backend={...fakeSandbox(),async available(){return {ok,reason:ok?'':'broke'};},async prepare(){throw Object.assign(new Error('profile could not be built'),{code:'sandbox_unavailable'});}};
  const h=await engineFixture(t,{backend,calls:[{name:'terminal',arguments:{command:'echo ran > report.txt'}}]});
  const started=await h.engine.runRoutine('routine_report');await h.engine.tasks.get(started.id);
  assert.equal(h.events('approval.request').length,0);
  const receipt=h.run().workRecords.find(record=>record.tool==='terminal');
  assert.equal(receipt.status,'failed');assert.match(receipt.error,/Nothing ran on this computer/);
  assert.equal(existsSync(path.join(await h.root(),'report.txt')),false);
});

test('engine: without the setting a routine command behaves exactly as before',async t=>{
  const h=await engineFixture(t,{extra:{},calls:[{name:'terminal',arguments:{command:'echo 4 > other.txt'}}]});
  const started=await h.engine.runRoutine('routine_report');await until(()=>h.run()?.status==='waiting_for_approval','approval');
  assert.equal(h.run().pending_controls[0].review.riskReason,'This command can change files or run code. Review this exact action, or add it to the bot’s allowed commands.');
  await allow(h);await h.engine.tasks.get(started.id);
  const receipt=h.run().workRecords.find(record=>record.tool==='terminal');
  assert.equal(receipt.status,'succeeded');assert.equal(Object.hasOwn(receipt,'backend'),false);
});

test('engine: on this Mac a routine changes its workspace in the real sandbox and cannot read the Engine state',{skip:seatbelt?false:'Seatbelt needs macOS with /usr/bin/sandbox-exec.'},async t=>{
  const h=await engineFixture(t,{backend:null,calls:[{name:'terminal',arguments:{command:'python3 -c "open(\'report.txt\',\'w\').write(\'ok\')" && cat report.txt'}},{name:'terminal',arguments:{command:'cat ../../state.json'}}]});
  const started=await h.engine.runRoutine('routine_report');await h.engine.tasks.get(started.id);
  assert.equal(h.events('approval.request').length,0,'cat of an outside path is ordinary, and runs unattended in the sandbox');
  const receipts=h.run().workRecords.filter(record=>record.tool==='terminal');
  assert.deepEqual(receipts.map(record=>[record.status,record.backend]),[['succeeded','sandbox'],['failed','sandbox']]);
  assert.equal(await fs.readFile(path.join(await h.root(),'report.txt'),'utf8'),'ok');
  assert.ok(h.events('tool.completed').some(event=>event.tool==='terminal' && /Operation not permitted/.test(event.preview || '')));
});

test('API: GET /api/execution reports the backends and the owner sets where a bot’s commands run',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-api-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0,'127.0.0.1');
  assert.equal((await fetch(url+'/api/execution')).status,401);
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'synthetic-execution-password'})});
  const cookie=setup.headers.get('set-cookie').split(';')[0],{csrf}=await setup.json();
  const request=(endpoint,method,body)=>fetch(url+endpoint,{method,headers:{'content-type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},...(body?{body:JSON.stringify(body)}:{})});
  const status=await (await request('/api/execution','GET')).json();
  assert.deepEqual(status.backends.map(item=>item.id),['host','sandbox','docker','ssh']);
  assert.deepEqual(Object.keys(status.backends[1]).sort(),['available','id','isolated','label','reason','summary']);
  assert.equal(status.backends[0].available,true);assert.equal(status.backends[1].label,'Sandbox on this computer (recommended)');
  assert.equal(status.backends[1].available,seatbelt || status.backends[1].available);
  const bot=await (await request('/api/bots','POST',{name:'Builder',title:'Fixture',tools:['workspace','terminal']})).json();
  assert.equal(Object.hasOwn(bot,'execution'),false,'new bots keep today’s behaviour');
  let response=await request(`/api/bots/${bot.id}`,'PATCH',{execution:{backend:'sandbox'}});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).execution,{backend:'sandbox'});
  // The settings form sends a flat field; empty or host clears the setting.
  response=await request(`/api/bots/${bot.id}`,'PATCH',{executionBackend:'host'});
  const cleared=await response.json();assert.equal(Object.hasOwn(cleared,'execution'),false);assert.equal(Object.hasOwn(cleared,'executionBackend'),false);
  assert.deepEqual((await (await request(`/api/bots/${bot.id}`,'PATCH',{executionBackend:'sandbox'})).json()).execution,{backend:'sandbox'});
  for(const bad of [{execution:{backend:'vm'}},{execution:'sandbox'},{execution:{backend:'sandbox',path:'/'}},{executionBackend:'kubernetes'}])
    assert.equal((await request(`/api/bots/${bot.id}`,'PATCH',bad)).status,400,JSON.stringify(bad));
  assert.deepEqual(app.store.state.bots.find(item=>item.id===bot.id).execution,{backend:'sandbox'});
});

test('UI: the settings field offers both choices, keeps a synced unknown choice and words the status plainly',async()=>{
  const vm=await import('node:vm');
  const source=await fs.readFile(new URL('../public/execution.js',import.meta.url),'utf8'),app=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8'),index=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const window={},document={readyState:'complete',documentElement:{},addEventListener(){},querySelectorAll:()=>[]};
  vm.runInNewContext(source,{window,document,MutationObserver:class{observe(){}},fetch:()=>{throw new Error('not in this test');},console});
  const {fieldHTML,statusText}=window.StudioExecution;
  const host=fieldHTML({});
  assert.match(host,/<label for="bot-execution">Where commands run<\/label><select id="bot-execution" name="executionBackend"/);
  assert.match(host,/<option value="host" selected>This computer, ask me<\/option><option value="sandbox" >Sandbox on this computer \(recommended\)<\/option>/);
  assert.match(fieldHTML({execution:{backend:'sandbox'}}),/<option value="sandbox" selected>/);
  assert.match(fieldHTML({execution:{backend:'docker"<x>'}}),/<option value="docker&quot;&lt;x&gt;" selected>docker&quot;&lt;x&gt; \(not on this engine\)<\/option>/);
  assert.deepEqual({...statusText('sandbox',[{id:'sandbox',available:true}])},{state:'ready',text:'Sandbox ready.'});
  assert.match(statusText('sandbox',[{id:'sandbox',available:false,reason:'bubblewrap (bwrap) is not installed on this server.'}]).text,/^Sandbox not available here: bubblewrap .* asks you before every command that can change files\.$/);
  assert.equal(statusText('host',[]).state,'host');
  assert.ok(app.includes("${window.StudioExecution?.fieldHTML(bot)||''}"),'one insertion in the Automation & development group');
  assert.ok(index.indexOf('/usage.js')<index.indexOf('/execution.js') && index.includes('/execution.css'));
});
