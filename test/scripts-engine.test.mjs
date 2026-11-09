import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { writeWorkspace, getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { validateRoutine } from '../lib/routines.mjs';
import { groupGuidance } from '../lib/tool-catalog.mjs';

const BOT='bot_atlas',ID='collect-fixture';
const hash=value=>createHash('sha256').update(value).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const call=(id,name,args)=>({id,name,arguments:args});
const execute=promisify(execFile);
async function until(predicate,timeout=10000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await predicate();if(value)return value;await delay(5);}
  throw new Error('Script engine fixture timed out.');
}
const current=h=>h.store.state.runs[BOT];
function approval(run){return {runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation};}
async function fixture(t,code,complete,{tools=['workspace','terminal','automation'],contextWindow}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-scripts-engine-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections.push({id:'script-fixture',type:'openai',defaultModel:'fixture-model',...(contextWindow?{contextWindow}:{})});Object.assign(state.bots[0],{connectionId:'script-fixture',tools,approvalPolicy:'balanced'});});
  let turns=0;
  const engine=new NativeEngine(store,{runTimeout:10000,providers:{async complete(_connection,request){return complete(request,++turns);}}});
  await engine.recover();
  t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const readme='# Synthetic collection\n\nPurpose: collect fixture data. Inputs: literal arguments. Outputs: bounded JSON on stdout.\n';
  await writeWorkspace(store,BOT,`scripts/${ID}/main.mjs`,code);
  await writeWorkspace(store,BOT,`scripts/${ID}/README.md`,readme);
  const registered=await engine.tools.execute(store.state.bots[0],'scripts_register',{id:ID,title:'Collect fixture data',purpose:'Collect deterministic synthetic values and print bounded JSON.',interpreter:'node',entrypoint:'main.mjs',files:[{path:'main.mjs',sha256:hash(code)},{path:'README.md',sha256:hash(readme)}],inputs:['Literal fixture values.'],outputs:['Bounded JSON stdout.']},{approved:true});
  const args={scriptId:ID,digest:registered.script.digest,args:[],timeoutMs:5000};
  const settled=async started=>{await until(()=>current({store})?.id===started.id&&!isActive(current({store})));await engine.tasks.get(started.id);return store.state.runs[BOT];};
  return {directory,store,engine,args,settled,root:await getWorkspaceRoot(store,BOT)};
}

test('the reusable scripts module can be imported independently without an initialization-order cycle',async()=>{
  const moduleUrl=new URL('../lib/scripts.mjs',import.meta.url).href;
  await execute(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(moduleUrl)})`],{timeout:10000});
});

test('an 8K workspace model completes a write and reply with the full script catalog and unchanged schema constraints',async t=>{
  let h,observed=0;
  h=await fixture(t,'process.stdout.write("unused");',async(request,turn)=>{
    // The 8K model first sees the core catalog and loads the files group, whose schemas keep their constraints.
    if(turn===1){const load=request.tools.find(tool=>tool.name==='tools_load');assert.ok(load.parameters.properties.groups.items.enum.includes('files'));assert.equal(Object.hasOwn(load,'description'),true);assert.equal(request.tools.some(tool=>tool.name==='scripts_register'),false);observed++;return {text:'',toolCalls:[call('load','tools_load',{groups:['files']})]};}
    assert.match(JSON.parse(request.messages.findLast(message=>message.tool_call_id==='load').content).guidance.files,/scripts_register/);
    const registration=request.tools.find(tool=>tool.name==='scripts_register'),original=h.engine.tools.definitions(h.store.state.bots[0]).find(tool=>tool.name==='scripts_register');
    assert.equal(registration.description,original.description);assert.equal(registration.parameters.additionalProperties,false);
    assert.deepEqual(registration.parameters.required,original.parameters.required);assert.equal(registration.parameters.properties.purpose.maxLength,2000);
    assert.equal(registration.parameters.properties.files.minItems,2);assert.equal(registration.parameters.properties.files.items.properties.sha256.maxLength,64);
    assert.equal(registration.parameters.properties.interpreter.enum.includes('python3'),true);assert.equal(Object.hasOwn(registration.parameters.properties.purpose,'description'),false);
    assert.equal(typeof original.parameters.properties.purpose.description,'string');assert.equal(request.tools.some(tool=>tool.name==='scripts_inspect'),true);assert.equal(request.tools.some(tool=>tool.name==='scripts_run'),false);observed++;
    return turn===2?{text:'',toolCalls:[call('small-write','workspace_write',{path:'outputs/small-window.txt',content:'Verified at 8K.\n'})]}:{text:'The requested file was written.',toolCalls:[]};
  },{tools:['workspace'],contextWindow:8000});
  const started=await h.engine.start(BOT,'Create the requested private fixture output.');
  const finished=await h.settled(started);assert.equal(finished.status,'completed',finished.error);assert.equal(observed,3);assert.ok(finished.events.some(event=>event.type==='tools.loaded' && event.reason==='requested' && event.groups[0]==='files'));
  assert.equal(await fs.readFile(path.join(h.root,'outputs/small-window.txt'),'utf8'),'Verified at 8K.\n');
});

test('a registered script never grants missing Terminal access or prompts to execute an unavailable tool',async t=>{
  let h;
  h=await fixture(t,'process.stdout.write("must remain unexecuted");',async(request,turn)=>{
    if(turn===1)return {text:'',toolCalls:[call('unavailable','scripts_run',h.args)]};
    const result=JSON.parse(request.messages.findLast(message=>message.tool_call_id==='unavailable').content);assert.equal(result.errorCode,'denied');assert.equal(result.outcome,'not_started');return {text:'The source is registered; Terminal remains disabled.',toolCalls:[]};
  },{tools:['workspace']});
  const started=await h.engine.start(BOT,'Use the prepared fixture if permitted.');
  const finished=await h.settled(started);assert.equal(finished.status,'completed');assert.equal(finished.backgroundProcesses,undefined);assert.equal(finished.events.some(event=>event.type==='approval.request'),false);assert.deepEqual(h.store.state.bots[0].tools,['workspace']);
  // Script guidance arrives with the files group; neither system prompt names a tool it does not offer.
  assert.equal(h.engine.instructions({...h.store.state.bots[0],tools:[]}).includes('- files:'),false);
  assert.equal(h.engine.instructions(h.store.state.bots[0]).includes('scripts_register'),false);assert.equal(h.engine.instructions(h.store.state.bots[0]).includes('- files:'),true);
  assert.match(groupGuidance('files',new Set(['scripts_register'])),/scripts_register/);
});

test('engine binds script approval to source details and records real command verification',async t=>{
  let h;
  h=await fixture(t,'process.stdout.write(JSON.stringify({count:3}));process.stderr.write("fixture diagnostic");',async(request,turn)=>{
    if(turn===1)return {text:'',toolCalls:[call('execute','scripts_run',h.args)]};
    if(turn===2){const result=JSON.parse(request.messages.findLast(message=>message.tool_call_id==='execute').content);assert.equal(result.stdout,'{"count":3}');assert.equal(result.stderr,'fixture diagnostic');assert.equal(result.digest,h.args.digest);return {text:'',toolCalls:[call('verify','task_outcome_set',{checks:[{id:'script-exit',kind:'command_success',callId:'execute'}]})]};}
    return {text:'The registered script completed with the verified fixture result.',toolCalls:[]};
  });
  const started=await h.engine.start(BOT,'Execute the registered fixture.');
  await until(()=>current(h)?.status==='waiting_for_approval');
  const pending=current(h).pending_controls[0];
  assert.equal(pending.tool,'scripts_run');assert.equal(pending.review.script.title,'Collect fixture data');assert.equal(pending.review.script.digest,h.args.digest);assert.match(pending.review.script.purpose,/synthetic/);assert.equal(pending.review.script.files.length,2);
  await h.engine.control(BOT,'approval',{...approval(current(h)),choice:'once'});
  const finished=await h.settled(started);assert.equal(finished.status,'completed',finished.error);assert.equal(finished.verification.passed,true);
  assert.equal(finished.workRecords.find(record=>record.callId==='execute').exitCode,0);assert.equal(h.engine.backgroundProcesses.hasActive(started.id),false);
});

test('source changes during script approval refuse dispatch and a denial launches no process',async t=>{
  let h;
  h=await fixture(t,'process.stdout.write("original");',async(request,turn)=>{
    if(turn===1)return {text:'',toolCalls:[call('execute','scripts_run',h.args)]};
    const result=JSON.parse(request.messages.findLast(message=>message.tool_call_id==='execute').content);assert.equal(result.errorCode,'stale_state');assert.equal(result.outcome,'not_started');
    return {text:'The source changed while approval was pending; no execution was started.',toolCalls:[]};
  });
  const started=await h.engine.start(BOT,'Execute the original reviewed fixture.');
  await until(()=>current(h)?.status==='waiting_for_approval');
  await writeWorkspace(h.store,BOT,`scripts/${ID}/main.mjs`,'process.stdout.write("changed after review");');
  await h.engine.control(BOT,'approval',{...approval(current(h)),choice:'once'});
  const finished=await h.settled(started);assert.equal(finished.status,'completed');assert.equal(finished.backgroundProcesses,undefined);assert.equal(finished.workRecords.find(record=>record.callId==='execute').outcome,'not_started');
  let denied;
  denied=await fixture(t,'process.stdout.write("must not run");',async(request,turn)=>{
    if(turn===1)return {text:'',toolCalls:[call('denied','scripts_run',denied.args)]};
    assert.equal(JSON.parse(request.messages.findLast(message=>message.tool_call_id==='denied').content).errorCode,'denied');return {text:'Execution was denied.',toolCalls:[]};
  });
  const no=await denied.engine.start(BOT,'Ask before running.');await until(()=>current(denied)?.status==='waiting_for_approval');await denied.engine.control(BOT,'approval',{...approval(current(denied)),choice:'deny'});
  assert.equal((await denied.settled(no)).backgroundProcesses,undefined);
});

test('Stop drains the script process before removing its private source snapshot',async t=>{
  let h;
  h=await fixture(t,'import fs from "node:fs";fs.writeFileSync("script-started","ready");setInterval(()=>{},1000);',async()=>({text:'',toolCalls:[call('long','scripts_run',h.args)]}));
  const started=await h.engine.start(BOT,'Start the fixture and wait.');await until(()=>current(h)?.status==='waiting_for_approval');await h.engine.control(BOT,'approval',{...approval(current(h)),choice:'once'});
  await until(()=>fs.stat(path.join(h.root,'script-started')).then(()=>true,()=>false));
  await h.engine.control(BOT,'stop',{runId:started.id,remoteRunId:started.remoteRunId});
  const finished=await h.settled(started);assert.equal(finished.status,'cancelled');assert.equal(h.engine.backgroundProcesses.hasActive(started.id),false);
  const home=path.join(h.directory,'process-homes',BOT);assert.ok(!(await fs.readdir(home)).some(name=>name.startsWith('.script-run-')));
});

test('each routine occurrence retains exact script approval and successful stdout reaches a model-free report',async t=>{
  const h=await fixture(t,'import fs from "node:fs";fs.appendFileSync("routine-calls.txt","x");process.stdout.write("{\\"count\\":3}");',async()=>assert.fail('report routine must not invoke a model'));
  await h.store.mutate(state=>state.routines.push(validateRoutine({name:'Registered fixture report',botId:BOT,prompt:'Collect and report the fixture count.',intervalMinutes:60,enabled:false,workflow:{version:1,mode:'report',steps:[{id:'collect',op:'script',...h.args},{id:'parsed',op:'json',from:'collect',path:'stdout'}],report:'Count: {{parsed.count}}'}},{id:'script-routine'})));
  const first=await h.engine.runRoutine('script-routine');await until(()=>current(h)?.status==='waiting_for_approval');assert.equal(current(h).pending_controls[0].tool,'scripts_run');await h.engine.control(BOT,'approval',{...approval(current(h)),choice:'once'});
  const done=await h.settled(first);assert.equal(done.status,'completed',done.error);assert.equal(done.output,'Count: 3');assert.equal(await fs.readFile(path.join(h.root,'routine-calls.txt'),'utf8'),'x');
  const second=await h.engine.runRoutine('script-routine');await until(()=>current(h)?.status==='waiting_for_approval');assert.equal(await fs.readFile(path.join(h.root,'routine-calls.txt'),'utf8'),'x');await h.engine.control(BOT,'approval',{...approval(current(h)),choice:'deny'});
  assert.equal((await h.settled(second)).status,'failed');assert.equal(await fs.readFile(path.join(h.root,'routine-calls.txt'),'utf8'),'x');
});
