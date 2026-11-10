import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { proofOfWork } from '../lib/proof-of-work.mjs';
import { workReceipt, toolFailure, reconcileWork, executeQualityTool } from '../lib/work-quality.mjs';

const BOT='bot_atlas';
const call=(id,name,args={})=>({id,name,arguments:args});
// Receipts are made by the engine's own workReceipt so the shapes are the real ones.
const ok=(id,name,args,output={})=>workReceipt(call(id,name,args),output);
const failed=(id,name,args,error,options)=>workReceipt(call(id,name,args),toolFailure(error,options));

// ---- The pure summary ----------------------------------------------------------------------------
test('an all-successful task is checked, with each count from its own engine record',()=>{
  const run={status:'completed',workRecords:[
    ok('w1','workspace_write',{path:'notes/a.md',content:'x'},{path:'notes/a.md',written:true}),
    ok('w2','workspace_edit',{path:'notes/a.md',old:'x',new:'y'},{path:'notes/a.md',written:true}),
    ok('r1','workspace_read',{path:'notes/a.md'},{path:'notes/a.md',content:'y'}),
    ok('r2','http_fetch',{url:'https://example.com/a'},{status:200,body:'page'}),
    ok('r3','http_fetch',{url:'https://example.com/a'},{status:200,body:'page'}),
    ok('s1','web_search',{query:'tupies'},{results:[]}),
    ok('c1','shell_run',{executable:'npm',args:['test']},{exitCode:0,stdout:'ok'}),
    ok('m1','memory_set',{key:'k',value:'v'},{key:'k',remembered:true}),
    ok('i1','integration_call',{integrationId:'x',tool:'publish'},{ok:true}),
    ok('p1','task_plan_set',{steps:[]},{plan:{}}),
  ],artifacts:[{path:'reports/summary.pdf',name:'summary.pdf'}],verification:{coverage:'declared_checks',passed:true,checks:[{id:'file',kind:'file_exists',passed:true,detail:'Checked.'}]}};
  assert.deepEqual(proofOfWork(run),{status:'checked',attention:{},checked:{filesSaved:2,sourcesRead:2,searches:1,commandsRan:1,checksPassed:1,memorySaved:1,integrationCalls:1}});
});

test('a failed command that later succeeds unchanged needs no look; one never fixed does',()=>{
  const test=call('t','shell_run',{executable:'npm',args:['test']});
  const fixed={workRecords:[workReceipt(test,{exitCode:1,stdout:'1 failing'}),ok('e','workspace_edit',{path:'src/a.js'},{path:'src/a.js',written:true}),workReceipt({...test,id:'t2'},{exitCode:0})]};
  assert.deepEqual(proofOfWork(fixed),{status:'checked',attention:{},checked:{filesSaved:1,commandsRan:1}});
  const broken={workRecords:[workReceipt(test,{exitCode:1}),workReceipt({...test,id:'t2'},{exitCode:1}),ok('other','shell_run',{executable:'node',args:['x.js']},{exitCode:0})]};
  const proof=proofOfWork(broken);
  assert.equal(proof.status,'attention');
  // Two runs of the same failing command are one problem; a different, passing command does not settle it.
  assert.deepEqual(proof.attention,{commandsFailed:1});assert.deepEqual(proof.checked,{commandsRan:1});
  assert.deepEqual(proof.items,[{kind:'command_failed',tool:'shell_run',callId:'t'}]);
});

test('an action with an unknown result needs a look; a failed edit fixed on the same file does not',()=>{
  const post=failed('post','http_fetch',{url:'https://api.example.com/orders',method:'POST'},Object.assign(new Error('Gateway timeout'),{status:504}),{dispatched:true});
  assert.equal(post.outcome,'unknown');
  const edit=failed('e1','workspace_edit',{path:'src/a.js',old:'nope'},Object.assign(new Error('No match'),{status:422}));
  const run={workRecords:[post,edit],events:[{type:'tool.started',tool:'workspace_edit',toolCallId:'e1',arguments:{path:'src/a.js',old:'nope'}}]};
  const before=proofOfWork(run);
  assert.deepEqual(before.attention,{unknownResults:1,actionsFailed:1});
  assert.deepEqual(before.items,[{kind:'unknown_result',tool:'http_fetch',callId:'post'},{kind:'action_failed',tool:'workspace_edit',callId:'e1',path:'src/a.js'}]);
  run.workRecords.push(ok('e2','workspace_edit',{path:'src/a.js',old:'yes'},{path:'src/a.js',written:true}));
  assert.deepEqual(proofOfWork(run).attention,{unknownResults:1});
});

test('failed checks and unverified teammate deliverables need a look; passed ones are counted',()=>{
  const run={workRecords:[ok('d1','delegate_task',{botId:'bot_scout'},{runId:'child_1',status:'completed',deliverable:{id:'deliverable_1',status:'completed'}})],
    verification:{coverage:'declared_checks',passed:false,checks:[{id:'tests',kind:'command_success',passed:false,detail:'x'},{id:'file',kind:'file_exists',passed:true,detail:'y'}]},
    requiredDeliverables:[{id:'deliverable_1',botId:'bot_scout',status:'completed'},{id:'deliverable_2',botId:'bot_scout',status:'partial'}]};
  const proof=proofOfWork(run);
  assert.deepEqual([proof.status,proof.checked,proof.attention],['attention',{checksPassed:1,teammatesVerified:1},{checksFailed:1,deliverablesMissing:1}]);
  assert.deepEqual(proof.items,[{kind:'check_failed',checkId:'tests',check:'command_success'},{kind:'deliverable_missing',deliverableId:'deliverable_2'}]);
});

test('after an interruption, cut-off actions need a look while unapplied reads and unanswered approvals do not',()=>{
  const run={events:[
    {type:'tool.started',tool:'workspace_read',toolCallId:'read',arguments:{path:'a.md'}},
    {type:'tool.started',tool:'integration_call',toolCallId:'act',arguments:{integrationId:'x'}},
    {type:'tool.started',tool:'workspace_write',toolCallId:'ask',arguments:{path:'b.md',content:'x'}},
  ],pending_controls:[{kind:'approval',tool:'workspace_write',arguments:{path:'b.md',content:'x'}}],workRecords:[]};
  reconcileWork(run,'Stopped.');
  assert.deepEqual(run.workRecords.map(record=>record.outcome),['not_applied','unknown','not_started']);
  const proof=proofOfWork(run);
  assert.deepEqual([proof.status,proof.attention,proof.items],['attention',{interrupted:1},[{kind:'interrupted',tool:'integration_call',callId:'act'}]]);
  // Starts beyond the retained receipt limit are counted as interrupted too.
  assert.equal(proofOfWork({workRecords:[],workReconciliation:{unresolved:3}}).attention.interrupted,3);
  // A background command read to a clean exit settles its own interrupted start.
  const background={workRecords:[{...workReceipt(call('start','shell_start'),{status:'running',processId:'process_1'}),status:'interrupted',outcome:'unknown',errorCode:'interrupted'},ok('poll','shell_read',{processId:'process_1'},{status:'exited',exitCode:0,processId:'process_1'})]};
  assert.deepEqual(proofOfWork(background),{status:'checked',attention:{},checked:{commandsRan:1}});
});

test('failed reads and refusals are notes, not problems; blocked repeats add nothing',()=>{
  const run={workRecords:[
    failed('r','http_fetch',{url:'https://example.com/missing'},Object.assign(new Error('Not found'),{status:404}),{read:true}),
    failed('d','integration_call',{integrationId:'x'},Object.assign(new Error('Refused'),{status:403}),{denied:true}),
    {...ok('x','workspace_read',{path:'a'}),status:'failed',errorCode:'repeated_read',outcome:'not_started'},
    ok('s','web_search',{query:'q'},{results:[]}),
  ]};
  assert.deepEqual(proofOfWork(run),{status:'checked',attention:{},checked:{searches:1},notes:{couldNotRead:1,refused:1}});
});

test('a plain answer, bookkeeping-only work and hostile input show nothing or stay bounded',()=>{
  for(const empty of [undefined,null,'x',[],{},{workRecords:[]},{workRecords:'nope',events:5,artifacts:{},verification:'x'},{workRecords:[ok('p','task_plan_set',{}),ok('o','task_outcome_check',{}),ok('m','mission_status',{})]},{verification:{coverage:'not_declared',passed:null,checks:[]}}])assert.equal(proofOfWork(empty),null);
  const many=Array.from({length:5000},(_,index)=>({callId:`c${index}`,tool:'integration_call',status:'failed',outcome:'not_started',requestDigest:`d${index}`}));
  const hostile=proofOfWork({workRecords:[{callId:'<script>',tool:'<img src=x>',status:'failed'},{callId:'x'.repeat(5000),tool:'workspace_write',status:'failed',outcome:'not_started',path:'\u0000/etc'},...many],workReconciliation:{unresolved:Infinity}});
  assert.equal(hostile.status,'attention');
  assert.equal(hostile.attention.actionsFailed,1999,'only the first 2000 records are read and the unnamed tool is skipped');
  assert.equal(hostile.attention.interrupted,undefined);
  assert.equal(hostile.items.length,8);
  assert.deepEqual(hostile.items[0],{kind:'action_failed',tool:'workspace_write'},'an oversized call ID and a control-character path are dropped');
  assert.ok(JSON.stringify(hostile).length<2000);
  const huge=proofOfWork({workRecords:Array.from({length:2000},(_,index)=>ok(`r${index}`,'workspace_read',{path:`f${index}`},{path:`f${index}`}))});
  assert.equal(huge.checked.sourcesRead,2000);
});

// ---- The engine attaches it to the reply, the run history and runs_inspect ------------------------
async function fixture(t,complete,{tools=['workspace'],execute}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-proof-of-work-')),store=await new Store(directory).init();
  await store.mutate(state=>{
    state.connections.push({id:'primary',type:'openrouter',defaultModel:'cheap',models:[{id:'cheap'}]});
    for(const bot of state.bots){bot.connectionId='primary';bot.model='cheap';bot.tools=tools;bot.approvalPolicy='auto';}
  });
  const engine=new NativeEngine(store,{providers:{async complete(connection,request){return complete(request);}},runTimeout:10000,retryDelay:0});
  if(execute){const original=engine.tools.execute.bind(engine.tools);engine.tools.execute=async(bot,name,args,options)=>execute(name,args)??original(bot,name,args,options);}
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  let step=0;
  const run=async text=>{step=0;const started=await engine.start(BOT,text);await engine.tasks.get(started.id);return store.state.runs[BOT];};
  return {store,engine,run,next:()=>++step};
}

test('a task that writes a file and reads it back carries a checked summary on the reply and in the run history',async t=>{
  let f;f=await fixture(t,async()=>{const step=f.next();return step===1?{text:'',toolCalls:[call('write','workspace_write',{path:'notes/today.md',content:'Hello'})]}
    :step===2?{text:'',toolCalls:[call('read','workspace_read',{path:'notes/today.md'})]}:{text:'Saved and checked notes/today.md.',toolCalls:[]};});
  const run=await f.run('Write a note and check it.');
  assert.equal(run.status,'completed');
  const reply=f.store.state.messages[BOT].at(-1);
  assert.equal(reply.role,'assistant');
  assert.deepEqual(reply.proof,{status:'checked',checked:{filesSaved:1,sourcesRead:1},attention:{}});
  assert.deepEqual(f.store.state.runHistory[BOT][0].proof,reply.proof);
  // A bot asked what it actually did reads the same summary from its records.
  const context={bot:f.store.state.bots.find(bot=>bot.id===BOT),runId:'later',sessionId:BOT,controller:new AbortController()};
  const inspected=await executeQualityTool({...f.engine,store:f.store,engineLog:null,current:()=>null,assertRunning(){}},context,'runs_inspect',{limit:1});
  assert.deepEqual(inspected.runs[0].proof,reply.proof);
});

test('a plain conversational answer carries no summary',async t=>{
  const f=await fixture(t,async()=>({text:'Hello there.',toolCalls:[]}));
  await f.run('Say hello.');
  const reply=f.store.state.messages[BOT].at(-1);
  assert.equal(reply.proof,undefined);assert.equal(f.store.state.runHistory[BOT][0].proof,undefined);
});

test('a command that fails and is never fixed marks the reply as needing a look',async t=>{
  let f;f=await fixture(t,async()=>{const step=f.next();return step===1?{text:'',toolCalls:[call('tests','shell_run',{executable:'npm',args:['test']})]}:{text:'All tests pass.',toolCalls:[]};},
    {tools:['workspace','terminal'],execute:name=>name==='shell_run'?{exitCode:1,stdout:'',stderr:'1 failing',timedOut:false,truncated:false}:undefined});
  const run=await f.run('Run the tests.');
  assert.equal(run.status,'completed');
  const reply=f.store.state.messages[BOT].at(-1);
  // The reply claims success; the summary reports only what the engine recorded.
  assert.equal(reply.content,'All tests pass.');
  assert.deepEqual(reply.proof,{status:'attention',checked:{},attention:{commandsFailed:1},items:[{kind:'command_failed',tool:'shell_run',callId:'tests'}]});
  assert.deepEqual(f.store.state.runHistory[BOT][0].proof,reply.proof);
});

test('a partial reply kept from a stopped or failed task carries its summary too',async t=>{
  const f=await fixture(t,async()=>({text:'unused',toolCalls:[]}));
  const run={id:'run_partial',status:'cancelled',events:[{type:'tool.started',tool:'integration_call',toolCallId:'act',arguments:{integrationId:'x'}}],workRecords:[ok('r','workspace_read',{path:'a.md'},{path:'a.md'})],artifacts:[]};
  await f.store.mutate(state=>{reconcileWork(run,'Stopped.');f.engine.preservePartial(state,BOT,run,'Half of the answer');});
  const kept=f.store.state.messages[BOT].at(-1);
  assert.deepEqual([kept.partial,kept.content],[true,'Half of the answer']);
  assert.deepEqual(kept.proof,{status:'attention',checked:{sourcesRead:1},attention:{interrupted:1},items:[{kind:'interrupted',tool:'integration_call',callId:'act'}]});
});
