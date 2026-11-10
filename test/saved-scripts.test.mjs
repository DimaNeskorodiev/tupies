import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { getWorkspaceRoot, writeWorkspace } from '../lib/agent-tools.mjs';
import { validateRoutine } from '../lib/routines.mjs';
import { inspectScript } from '../lib/scripts.mjs';
import { overrideExecutionBackendForTests } from '../lib/exec/index.mjs';
import { catalogGroups, groupGuidance } from '../lib/tool-catalog.mjs';
import { usageSummary, modelFreeMeter } from '../lib/run-usage.mjs';
import { formatInput, parseInputs, buildInvocation, ownerListScripts, ownerInspectScript, SCRIPT_SUGGESTION_REQUEST, SCRIPTS_FIRST_GUIDANCE } from '../lib/saved-scripts.mjs';
import { loadLedger, approveVersion, recordScriptRun, scriptRunDecision, noteScriptDecision, LEDGER_LIMITS } from '../lib/script-ledger.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const until=async(predicate,label='condition')=>{for(let i=0;i<4000;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Timed out waiting for ${label}.`);};
const ECHO='process.stdout.write(JSON.stringify({argv:process.argv.slice(2),inputs:JSON.parse(process.env.TUPIES_SCRIPT_INPUTS||"null"),sandbox:process.env.TUPIES_FIXTURE_SANDBOX||""}));\n';

const fakeSandbox=()=>({id:'sandbox',label:'Sandbox on this computer (recommended)',noun:'sandbox',isolated:true,
  async available(){return {ok:true,reason:''};},describe(){return {summary:'fixture'};},async check(){},
  async prepare(launch){return {executable:launch.executable,args:launch.args,env:{...launch.env,TUPIES_FIXTURE_SANDBOX:'1'},cwd:launch.cwd};}});

/** A disposable engine; `queue` holds the provider's tool calls in order, null meaning "reply and finish". */
async function fixture(t,{policy='balanced',sandbox=true,tools=['workspace','terminal','automation']}={}) {
  if(sandbox){overrideExecutionBackendForTests('sandbox',fakeSandbox());t.after(()=>overrideExecutionBackendForTests('sandbox',null));}
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-saved-scripts-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections=[{id:'fixture',type:'custom',defaultModel:'fixture-model'}];Object.assign(state.bots[0],{connectionId:'fixture',approvalPolicy:policy,tools,...(sandbox?{execution:{backend:'sandbox'}}:{})});});
  const queue=[];let n=0;
  const engine=new NativeEngine(store,{runTimeout:30000,providers:{complete:async()=>{const call=queue.shift();return call?{toolCalls:[{id:`call_${++n}`,...call}]}:{text:'Finished.',toolCalls:[]};},reviewAction:async()=>{throw new Error('No model reviewer for scripts.');}}});
  await engine.recover();t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot=store.state.bots[0],run=()=>store.state.runs[bot.id];
  const events=type=>(run()?.events || []).filter(event=>event.type===type);
  const result=callId=>{const row=(store.state.conversations[bot.id] || []).concat(...Object.values(store.state.conversations)).find(item=>item.role==='tool' && item.tool_call_id===callId);return row?JSON.parse(row.content):null;};
  const allow=async(choice='once')=>{const current=run(),prompt=current.pending_controls[0];await engine.control(bot.id,'approval',{runId:current.id,remoteRunId:current.remoteRunId,request_id:prompt.prompt_id,execution_generation:current.execution_generation,choice});};
  const save=(args)=>engine.tools.execute(store.state.bots[0],'script_save',args,{approved:true});
  const task=async(calls,{answer}={})=>{
    queue.push(...calls);const started=await engine.start(bot.id,'Run the saved fixture.');
    if(answer){await until(()=>run()?.status==='waiting_for_approval' || ['completed','failed'].includes(run()?.status),'approval');if(run().status==='waiting_for_approval')await answer(run().pending_controls[0]);}
    await engine.tasks.get(started.id);return run();
  };
  return {directory,store,engine,bot,run,events,result,allow,save,task,queue,root:()=>getWorkspaceRoot(store,bot.id)};
}
const saveArgs=(code=ECHO,extra={})=>({id:'echo-args',title:'Echo arguments',purpose:'Print the literal arguments and inputs it receives.',language:'node',code,inputs:[{name:'target',description:'Where to look.',required:true},{name:'mode',description:'How to look.',default:'fast'}],...extra});

test('inputs: manifest text round-trips and invocations are literal argument pairs with defaults and checks',()=>{
  const declared=[{name:'url',description:'Page to check.',required:true},{name:'limit',description:'Max items.',default:'10'},{name:'note',description:'Free "text": with colons.'}];
  const lines=declared.map(formatInput);
  assert.deepEqual(lines,['url (required): Page to check.','limit (default "10"): Max items.','note: Free "text": with colons.']);
  assert.deepEqual(parseInputs([...lines,'Literal CSV path in data/.']),[{name:'url',description:'Page to check.',required:true},{name:'limit',description:'Max items.',required:false,default:'10'},{name:'note',description:'Free "text": with colons.',required:false},{name:null,description:'Literal CSV path in data/.'}]);
  const parsed=parseInputs(lines);
  assert.deepEqual(buildInvocation(parsed,{inputs:{url:'; rm -rf x'},args:['$(id)']}),{argv:['--url','; rm -rf x','--limit','10','$(id)'],inputs:{url:'; rm -rf x',limit:'10'}});
  assert.throws(()=>buildInvocation(parsed,{inputs:{}}),/Missing required input: url/);
  assert.throws(()=>buildInvocation(parsed,{inputs:{url:'a',other:'b'}}),/no input named other/);
  assert.throws(()=>buildInvocation(parsed,{inputs:{url:{nested:true}}}),/text, a number/);
  assert.throws(()=>buildInvocation([],{args:Array(21).fill('x')}),/up to 20/);
  assert.deepEqual(buildInvocation(parseInputs(['Free text input.']),{inputs:{any_name:5}}).argv,['--any_name','5'],'scripts without structured inputs accept named values');
});

test('script_save writes a registered package with engine-computed hashes; changed code is a new version; nothing runs',async t=>{
  const h=await fixture(t,{sandbox:false});
  const first=await h.save(saveArgs());
  assert.equal(first.saved,true);assert.equal(first.newVersion,true);assert.equal(first.approved,false);assert.match(first.notice,/Nothing ran/);
  assert.deepEqual([...first.script.files].sort(),['scripts/echo-args/README.md','scripts/echo-args/main.mjs']);
  const root=await h.root(),base=path.join(root,'scripts','echo-args');
  const manifest=JSON.parse(await fs.readFile(path.join(base,'script.json'),'utf8'));
  assert.equal(manifest.interpreter,'node');assert.equal(manifest.entrypoint,'main.mjs');
  assert.deepEqual(manifest.inputs,['target (required): Where to look.','mode (default "fast"): How to look.']);
  for(const file of manifest.files)assert.equal(file.sha256,sha(await fs.readFile(path.join(base,file.path))),file.path);
  assert.match(await fs.readFile(path.join(base,'README.md'),'utf8'),/--target.*required[\s\S]*TUPIES_SCRIPT_INPUTS/);
  const inspected=await inspectScript(h.store,h.bot.id,'echo-args');assert.equal(inspected.status,'registered');assert.equal(inspected.digest,first.script.digest);
  const same=await h.save(saveArgs());assert.equal(same.newVersion,false);assert.equal(same.script.digest,first.script.digest);
  const changed=await h.save(saveArgs(ECHO+'// v2\n'));assert.equal(changed.newVersion,true);assert.notEqual(changed.script.digest,first.script.digest);assert.equal(changed.previousVersion,first.script.version);
  // An owner-written README is kept; extra files already in the folder are adopted with engine hashes.
  await writeWorkspace(h.store,h.bot.id,'scripts/echo-args/README.md','# Mine\n');await writeWorkspace(h.store,h.bot.id,'scripts/echo-args/helper.mjs','export const x=1;\n');
  const adopted=await h.save(saveArgs(ECHO,{files:['helper.mjs']}));
  assert.equal(await fs.readFile(path.join(base,'README.md'),'utf8'),'# Mine\n');assert.ok(adopted.script.files.includes('scripts/echo-args/helper.mjs'));
  assert.equal((await inspectScript(h.store,h.bot.id,'echo-args')).status,'registered');
  await assert.rejects(h.save(saveArgs(ECHO+'// never written\n',{files:['../escape.mjs']})),/fixed package-relative paths/);assert.doesNotMatch(await fs.readFile(path.join(base,'main.mjs'),'utf8'),/never written/,'refused before writing');
  await assert.rejects(h.save({...saveArgs(),language:'ruby'}),/python, node or bash/);
  assert.equal((await fs.readdir(root)).includes('unexpected'),false);assert.equal(h.engine.backgroundProcesses.entries.size,0);
  // Saving needs no approval beyond writing files: Balanced/Approve for me write at once, Strict asks.
  assert.equal(h.engine.tools.requiresApproval('script_save',{...h.bot,approvalPolicy:'balanced'}),false);
  assert.equal(h.engine.tools.requiresApproval('script_save',{...h.bot,approvalPolicy:'strict'}),true);
  assert.equal(h.engine.tools.requiresApproval('script_run',{...h.bot,approvalPolicy:'auto'}),true,'script_run always goes through its version decision');
});

test('approval per exact version in a ready sandbox: first run asks, then runs without a card, an edit asks again with a diff',async t=>{
  const h=await fixture(t);await h.save(saveArgs());
  const literal=['; rm -rf x','$(id)'];
  let run=await h.task([{name:'script_run',arguments:{id:'echo-args',args:literal,inputs:{target:'`whoami` && echo pwned'}}},null],{answer:async prompt=>{
    assert.equal(prompt.tool,'script_run');assert.equal(prompt.review.script.change.state,'new');assert.match(prompt.review.riskReason,/^New script “Echo arguments”.*It will run in this bot’s sandbox\.$/);
    assert.deepEqual(prompt.review.script.inputValues,{target:'`whoami` && echo pwned',mode:'fast'});await h.allow();}});
  assert.equal(run.status,'completed',run.error);
  const first=h.result('call_1');
  assert.deepEqual(JSON.parse(first.stdout),{argv:['--target','`whoami` && echo pwned','--mode','fast',...literal],inputs:{target:'`whoami` && echo pwned',mode:'fast'},sandbox:'1'},'values arrive literally, never through a shell');
  assert.equal(first.id,'echo-args');assert.equal(first.backend,'sandbox');assert.equal(existsSync(path.join(await h.root(),'pwned')),false);
  let ledger=await loadLedger(h.store,h.bot.id);assert.equal(ledger.scripts['echo-args'].approved[0].how,'card');assert.equal(ledger.scripts['echo-args'].approved[0].digest,first.digest);
  // Second run of the approved version: no card, an automatic decision that names the version.
  run=await h.task([{name:'script_run',arguments:{id:'echo-args',inputs:{target:'b'}}},null]);
  assert.equal(run.status,'completed');assert.equal(h.events('approval.request').length,0);
  assert.match(h.events('approval.automatic')[0].reason,/approved this exact version of “Echo arguments”; it runs in this bot’s sandbox/);
  assert.equal(run.workRecords.find(record=>record.tool==='script_run').status,'succeeded');
  // An edit makes a new version: one card that says what changed and shows the diff.
  await h.save(saveArgs(ECHO+'console.error("v2");\n'));
  run=await h.task([{name:'script_run',arguments:{id:'echo-args',inputs:{target:'c'}}},null],{answer:async prompt=>{
    assert.equal(prompt.review.script.change.state,'changed');assert.equal(prompt.review.script.change.approvedVersion,first.digest.slice(0,12));
    assert.match(prompt.review.script.change.diff,/\+console\.error\("v2"\);/);assert.match(prompt.review.riskReason,/changed since the version you approved/);await h.allow('deny');}});
  assert.equal(h.events('approval.request').length,1);
  ledger=await loadLedger(h.store,h.bot.id);assert.equal(ledger.scripts['echo-args'].approved.length,1,'a denied card approves nothing');
  // History: two runs so far, newest first, with backend, duration and a bounded output excerpt; no usage fields.
  const history=ledger.scripts['echo-args'];
  assert.equal(history.count,2);assert.deepEqual(history.runs.map(item=>[item.startedBy,item.status,item.backend]),[['bot','succeeded','sandbox'],['bot','succeeded','sandbox']]);
  assert.ok(history.runs.every(item=>Number.isInteger(item.durationMs) && item.output.length<=2000 && !('usage' in item) && !('metering' in item)));
  // The model sees only a count and the last status.
  run=await h.task([{name:'scripts_list',arguments:{}},null]);
  const listed=h.result(run.workRecords.find(record=>record.tool==='scripts_list').callId).scripts.find(item=>item.id==='echo-args');
  assert.deepEqual(listed.runs,{count:2,lastStatus:'succeeded'});
});

test('Strict, the host backend and a dangerous script always ask, even for an approved version',async t=>{
  for(const [label,options,code,reason] of [['strict',{policy:'strict'},ECHO,/^Strict review/],['host',{sandbox:false},ECHO,/outside a ready sandbox each run waits.*without isolation\.$/],['dangerous',{policy:'auto'},'require("node:child_process").execSync("echo hi");\n',/^Dangerous: main\.mjs: starts other commands/]])await t.test(label,async t=>{
    const h=await fixture(t,options),saved=await h.save(saveArgs(code));
    const pkg=await (await import('../lib/scripts.mjs')).scriptInternals.registered(h.store,h.bot.id,'echo-args');
    await approveVersion(h.store,h.bot.id,'echo-args',{digest:saved.script.digest,how:'owner'});
    const run=await h.task([{name:'script_run',arguments:{id:'echo-args',inputs:{target:'x'}}},null],{answer:async prompt=>{assert.match(prompt.review.riskReason,reason);assert.equal(prompt.review.script.change.state,'approved');await h.allow('deny');}});
    assert.equal(h.events('approval.request').length,1,label);assert.equal(run.workRecords.find(record=>record.tool==='script_run').status,'failed');
    assert.ok(pkg.entry.digest===saved.script.digest);
  });
});

test('pure decision: approvals are bound to the digest and need terminal, a ready isolated backend and agreement of the saved bot',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-script-decision-')),store=await new Store(directory).init();t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const digest='a'.repeat(64),bot={id:'bot_atlas',tools:['workspace','terminal'],approvalPolicy:'balanced',execution:{backend:'sandbox'}};
  await approveVersion(store,bot.id,'fixture',{digest,how:'owner'});
  const decide=({call={name:'script_run'},details={},current=bot,policy='balanced',context={bot,source:'routine',routine:{id:'r'}}}={})=>{noteScriptDecision(call,{id:'fixture',title:'Fixture',digest,danger:{risk:'normal',reasons:[]},readiness:{backend:'sandbox',isolated:true,ready:true},...details});return scriptRunDecision({store,context,call,currentBot:current,policy});};
  assert.equal(decide().automatic,true);
  assert.equal(decide({details:{digest:'b'.repeat(64)}}).automatic,false,'one changed byte is another version');
  assert.equal(decide({current:{...bot,execution:undefined}}).automatic,false,'the saved bot moved back to the host');
  assert.equal(decide({details:{readiness:{backend:'sandbox',ready:false,reason:'down'}}}).automatic,false);
  assert.equal(decide({current:{...bot,tools:['workspace']}}).automatic,false);
  assert.equal(decide({policy:'strict'}).automatic,false);
  assert.equal(decide({details:{danger:{risk:'dangerous',reasons:['x']}}}).automatic,false);
  // The legacy tool keeps its earlier rules (null) wherever no ready isolated backend is involved.
  assert.equal(decide({call:{name:'scripts_run'},details:{readiness:{backend:'sandbox',ready:false}}}),null);
  assert.equal(decide({call:{name:'scripts_run'}}).automatic,true);
  assert.equal(scriptRunDecision({store,context:{bot},call:{name:'script_run'},currentBot:bot,policy:'balanced'}).automatic,false,'no prepared details means a card');
  // History is bounded per script with a running counter.
  for(let i=0;i<25;i++)await recordScriptRun(store,bot.id,'fixture',{startedBy:'owner',status:'succeeded',exitCode:0,durationMs:i,output:'x'.repeat(5000)});
  const ledger=await loadLedger(store,bot.id);
  assert.equal(ledger.scripts.fixture.runs.length,LEDGER_LIMITS.runs);assert.equal(ledger.scripts.fixture.count,25);assert.ok(ledger.scripts.fixture.runs.every(item=>item.output.length<=2000));
  assert.equal(ledger.scripts.fixture.runs[0].durationMs,24);
  const file=path.join(directory,'script-ledger','bot_atlas.json');assert.equal((await fs.stat(file)).mode&0o077,0);
});

test('a routine of an approved script in a ready sandbox runs with no approval request and reports 0 model calls',async t=>{
  const h=await fixture(t),saved=await h.save(saveArgs('process.stdout.write(JSON.stringify({count:3}));\n',{inputs:[]}));
  await approveVersion(h.store,h.bot.id,'echo-args',{digest:saved.script.digest,how:'owner'});
  await h.store.mutate(state=>state.routines.push(validateRoutine({name:'Count report',botId:h.bot.id,prompt:'Report the count.',intervalMinutes:60,enabled:false,workflow:{version:1,mode:'report',steps:[{id:'collect',op:'script',scriptId:'echo-args',digest:saved.script.digest,args:[],timeoutMs:5000},{id:'parsed',op:'json',from:'collect',path:'stdout'}],report:'Count: {{parsed.count}}'}},{id:'count-routine'})));
  const started=await h.engine.runRoutine('count-routine');await h.engine.tasks.get(started.id);
  const run=h.run();assert.equal(run.status,'completed',run.error);assert.equal(run.output,'Count: 3');
  assert.equal(h.events('approval.request').length,0);assert.match(h.events('approval.automatic')[0].reason,/approved this exact version/);
  const reply=h.store.state.messages[h.bot.id].findLast(message=>message.runId===run.id);
  assert.equal(reply.usage.modelCalls,0);assert.equal(reply.usage.totalTokens,0);assert.equal(reply.scriptSuggestion,undefined);
  assert.equal(h.store.state.runHistory[h.bot.id][0].metering.modelCalls,0);
  const ledger=await loadLedger(h.store,h.bot.id);assert.deepEqual(ledger.scripts['echo-args'].runs.map(item=>[item.startedBy,item.routineId,item.status]),[['routine','count-routine','succeeded']]);
  // A task that simply has no meter still has no summary.
  assert.equal(usageSummary(undefined),null);assert.equal(usageSummary({calls:0}),null);assert.equal(usageSummary(modelFreeMeter()).modelCalls,0);
});

test('a package registered the old way still lists, inspects and runs, and keeps a card on first run in the sandbox',async t=>{
  const h=await fixture(t),code='process.stdout.write("legacy ok");\n',readme='# Legacy\n\nPurpose: legacy fixture.\n';
  await writeWorkspace(h.store,h.bot.id,'scripts/legacy-fixture/main.mjs',code);await writeWorkspace(h.store,h.bot.id,'scripts/legacy-fixture/README.md',readme);
  const registered=await h.engine.tools.execute(h.store.state.bots[0],'scripts_register',{id:'legacy-fixture',title:'Legacy fixture',purpose:'Print a fixed line.',interpreter:'node',entrypoint:'main.mjs',files:[{path:'main.mjs',sha256:sha(code)},{path:'README.md',sha256:sha(readme)}],inputs:['Nothing.']},{approved:true});
  const listed=(await ownerListScripts(h.store,h.bot.id)).scripts.find(item=>item.id==='legacy-fixture');
  assert.deepEqual([listed.status,listed.language,listed.needsApproval,listed.approvedVersion,listed.inputFields],['registered','node',true,null,[{name:null,description:'Nothing.'}]]);
  assert.equal((await ownerInspectScript(h.store,h.bot.id,'legacy-fixture')).source.content,code);
  const args={scriptId:'legacy-fixture',digest:registered.script.digest,args:[],timeoutMs:5000};
  let run=await h.task([{name:'scripts_run',arguments:args},null],{answer:async prompt=>{assert.equal(prompt.tool,'scripts_run');assert.equal(prompt.review.script.change.state,'new');await h.allow();}});
  assert.equal(run.status,'completed');assert.equal(h.result('call_1').stdout,'legacy ok');
  run=await h.task([{name:'scripts_run',arguments:args},null]);
  assert.equal(h.events('approval.request').length,0,'the legacy tool also runs an approved version without a card in the sandbox');
  // script_run runs the same package by id.
  run=await h.task([{name:'script_run',arguments:{id:'legacy-fixture'}},null]);
  assert.equal(h.events('approval.request').length,0);assert.equal(run.workRecords.find(record=>record.tool==='script_run').status,'succeeded');
});

test('the save-as-a-script suggestion appears after 3 successful commands in owner chat and stops after two are ignored',async t=>{
  const h=await fixture(t);
  const commands=count=>[...Array(count)].map((_,i)=>({name:'terminal',arguments:{command:`echo step${i} > step${i}.txt`}}));
  let run=await h.task([...commands(2),null]);
  assert.equal(h.store.state.messages[h.bot.id].findLast(message=>message.runId===run.id).scriptSuggestion,undefined,'two commands are not enough');
  run=await h.task([...commands(3),null]);
  assert.deepEqual(h.store.state.messages[h.bot.id].findLast(message=>message.runId===run.id).scriptSuggestion,{reason:'repeated_commands',commands:3});
  run=await h.task([...commands(3),{name:'script_save',arguments:saveArgs()},null]);
  assert.equal(h.store.state.messages[h.bot.id].findLast(message=>message.runId===run.id).scriptSuggestion,undefined,'not when the task saved a script');
  run=await h.task([...commands(4),null]);
  assert.equal(h.store.state.messages[h.bot.id].findLast(message=>message.runId===run.id).scriptSuggestion.commands,4);
  run=await h.task([...commands(3),null]);
  assert.equal(h.store.state.messages[h.bot.id].findLast(message=>message.runId===run.id).scriptSuggestion,undefined,'the previous two suggestions were ignored');
  // Taking a suggestion (the follow-up request) re-enables them.
  h.queue.push(null);const followed=await h.engine.start(h.bot.id,SCRIPT_SUGGESTION_REQUEST);await h.engine.tasks.get(followed.id);
  run=await h.task([...commands(3),null]);
  assert.equal(h.store.state.messages[h.bot.id].findLast(message=>message.runId===run.id).scriptSuggestion.commands,3);
  // A routine lane never gets one.
  await h.store.mutate(state=>state.routines.push(validateRoutine({name:'Lane',botId:h.bot.id,prompt:'Do it.',intervalMinutes:60,enabled:false},{id:'lane-routine'})));
  h.queue.push(...commands(3),null);const routine=await h.engine.runRoutine('lane-routine');await h.engine.tasks.get(routine.id);
  assert.equal(h.store.state.messages[h.bot.id].findLast(message=>message.runId===routine.id)?.scriptSuggestion,undefined);
});

test('catalog: with Terminal the model is offered script_save/script_run instead of the hash-ritual tools; guidance stays bounded',async t=>{
  const h=await fixture(t,{sandbox:false});
  const context={bot:h.store.state.bots[0],source:'chat',runId:'x',sessionId:h.bot.id,connection:{id:'fixture',type:'custom'},inference:{model:'fixture-model'}};
  const {groups,names}=catalogGroups(h.engine.permittedTools(context));
  const terminal=groups.get('terminal').map(tool=>tool.name),files=groups.get('files').map(tool=>tool.name);
  assert.ok(terminal.includes('script_save') && terminal.includes('script_run'));assert.ok(!terminal.includes('scripts_run') && !files.includes('scripts_register'));
  assert.ok(files.includes('scripts_list') && files.includes('scripts_inspect'));
  const guidance=groupGuidance('terminal',names);assert.ok(guidance.includes(SCRIPTS_FIRST_GUIDANCE.slice(0,60)));assert.ok(SCRIPTS_FIRST_GUIDANCE.length<=600);
  assert.doesNotMatch(groupGuidance('files',names),/scripts_register|source hashes/);assert.match(groupGuidance('files',names),/script_save/);
  assert.match(h.engine.instructions(h.store.state.bots[0],context,h.engine.toolDefinitions(context)),/prefer one script over many tool calls/);
  // Without Terminal nothing changes: the files group keeps the older registration guidance.
  const workspaceOnly=new Set(['scripts_list','scripts_inspect','scripts_register','workspace_read']);
  assert.match(groupGuidance('files',workspaceOnly),/scripts_register/);assert.doesNotMatch(groupGuidance('files',workspaceOnly),/script_save|script_run/);
});

test('the saved-scripts module imports on its own without an initialization-order cycle',async()=>{
  for(const name of ['saved-scripts.mjs','script-ledger.mjs'])await promisify(execFile)(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL(`../lib/${name}`,import.meta.url).href)})`],{timeout:10000});
});
