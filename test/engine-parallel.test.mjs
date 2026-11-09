import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';

const call=(id,name,arguments_)=>({id,name,arguments:arguments_});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function waitFor(predicate,timeout=4000) {const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Timed out waiting for parallel tool fixture.');}
const current=store=>store.state.runs.bot_atlas;
const decision=run=>({runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation});

async function fixture(t,firstCalls,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-parallel-tools-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Fixture',model:'test-model'});state.bots[0].connectionId='fixture-provider';state.bots[0].tools=['workspace','memory'];state.bots[0].approvalPolicy='strict';});
  const engine=new NativeEngine(store,{runTimeout:10_000,providers:{async complete(_connection,request){requests.push(request);return requests.length===1?{text:'',toolCalls:firstCalls}:{text:'The tools finished.',toolCalls:[]};}},...options});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {engine,store,requests};
}

test('independent reads overlap in bounded batches and their history retains provider call order',async t=>{
  const calls=Array.from({length:6},(_,index)=>call(`read-${index}`,'memory_search',{query:String(index)}));
  const {engine,store,requests}=await fixture(t,calls),gates=calls.map(()=>deferred()),started=[],finished=[];
  let active=0,peak=0;
  const execute=engine.tools.execute.bind(engine.tools);
  engine.tools.execute=async(bot,name,args,options)=>{
    const index=Number(args.query);started.push(index);active++;peak=Math.max(peak,active);
    try{await gates[index].promise;finished.push(index);return await execute(bot,name,args,options);}finally{active--;}
  };
  await engine.start('bot_atlas','Read six independent sources.');
  await waitFor(()=>started.length===4);assert.equal(active,4);assert.deepEqual(started,[0,1,2,3]);
  for(const index of [3,2,1,0]){gates[index].resolve();await waitFor(()=>finished.includes(index));}
  await waitFor(()=>started.length===6);gates[5].resolve();await waitFor(()=>finished.includes(5));gates[4].resolve();
  await waitFor(()=>current(store)?.status==='completed');
  assert.equal(peak,4);assert.deepEqual(finished,[3,2,1,0,5,4]);
  assert.deepEqual(requests[1].messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id),calls.map(item=>item.id));
  assert.equal(current(store).events.filter(event=>event.type==='tool.started').length,6);
  assert.equal(current(store).events.filter(event=>event.type==='tool.completed').length,6);
});

test('mutations form barriers and each strict write keeps its own exact approval',async t=>{
  const calls=[call('before','memory_search',{query:'before'}),call('write-a','workspace_write',{path:'a.txt',content:'approved bytes'}),call('after','workspace_read',{path:'a.txt'}),call('write-b','workspace_write',{path:'b.txt',content:'denied bytes'}),call('last','memory_search',{query:'last'})];
  const {engine,store,requests}=await fixture(t,calls),gate=deferred(),started=[];
  const execute=engine.tools.execute.bind(engine.tools);
  engine.tools.execute=async(bot,name,args,options)=>{started.push(name==='memory_search'?args.query:name);if(args.query==='before')await gate.promise;return execute(bot,name,args,options);};
  await engine.start('bot_atlas','Read, write, verify and write another file.');
  await waitFor(()=>started.includes('before'));assert.deepEqual(started,['before']);assert.equal(current(store).status,'running');
  gate.resolve();await waitFor(()=>current(store)?.status==='waiting_for_approval');
  const first=decision(current(store));assert.deepEqual(started,['before']);
  await engine.control('bot_atlas','approval',{...first,choice:'once'});
  await waitFor(()=>current(store)?.status==='waiting_for_approval' && current(store).pending_controls[0].prompt_id!==first.request_id);
  assert.deepEqual(started,['before','workspace_write','workspace_read']);
  await assert.rejects(engine.control('bot_atlas','approval',{...first,choice:'once'}),/prompt changed/);
  await engine.control('bot_atlas','approval',{...decision(current(store)),choice:'deny'});
  await waitFor(()=>current(store)?.status==='completed');
  assert.deepEqual(started,['before','workspace_write','workspace_read','last']);
  const results=requests[1].messages.filter(message=>message.role==='tool');assert.equal(JSON.parse(results[2].content).content,'approved bytes');assert.equal(results[3].is_error,true);assert.match(results[3].content,/denied/);
  await assert.rejects(fs.access(path.join(await getWorkspaceRoot(store,'bot_atlas'),'b.txt')));
});

test('a failed parallel read has error metadata while successful siblings remain usable',async t=>{
  const {engine,store,requests}=await fixture(t,[call('invalid','memory_search',{query:42}),call('valid','memory_search',{query:''}),call('disabled','skills_list',{})]);
  await engine.start('bot_atlas','Handle bad tool inputs and retain useful results.');await waitFor(()=>current(store)?.status==='completed');
  const results=requests[1].messages.filter(message=>message.role==='tool');
  assert.deepEqual(results.map(message=>message.tool_call_id),['invalid','valid','disabled']);
  assert.equal(results[0].is_error,true);assert.match(results[0].content,/Memory query/);
  const valid=JSON.parse(results[1].content);assert.deepEqual(valid.entries,[]);assert.equal(valid.totalMatches,0);assert.equal(valid.truncated,false);assert.equal(results[1].is_error,undefined);
  assert.equal(results[2].is_error,true);assert.match(results[2].content,/not enabled/);
});

test('stop drains all started reads, blocks later writes and settles every admitted tool once',async t=>{
  const calls=[call('first','memory_search',{query:'first'}),call('second','memory_search',{query:'second'}),call('never-write','workspace_write',{path:'never.txt',content:'must not exist'})];
  const {engine,store}=await fixture(t,calls),drain=deferred(),started=[],aborted=[],settled=[];
  engine.tools.execute=async(_bot,_name,args,{signal})=>{
    started.push(args.query);
    await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted.push(args.query);resolve();},{once:true}));
    await drain.promise;settled.push(args.query);throw signal.reason;
  };
  const run=await engine.start('bot_atlas','Read two sources before writing.');await waitFor(()=>started.length===2);
  await engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});await waitFor(()=>aborted.length===2);
  assert.equal(current(store).status,'stopping');assert.equal(isActive(current(store)),true);assert.deepEqual(settled,[]);
  drain.resolve();await waitFor(()=>current(store)?.status==='cancelled');
  // Terminal status is committed before the final event and optional task note.
  // Wait for settlement before asserting that all finishing work is observable.
  await engine.tasks.get(run.id);
  assert.equal(settled.length,2);assert.deepEqual(started,['first','second']);
  const results=store.state.conversations.bot_atlas.filter(message=>message.role==='tool');
  assert.deepEqual(results.map(message=>message.tool_call_id),calls.map(item=>item.id));assert.ok(results.every(message=>message.is_error===true && /cancelled/.test(message.content)));
  await assert.rejects(fs.access(path.join(await getWorkspaceRoot(store,'bot_atlas'),'never.txt')));
  assert.equal(current(store).events.at(-1).type,'run.cancelled');
  const next=await engine.start('bot_atlas','Continue with the preserved history.');await waitFor(()=>current(store)?.id===next.id && current(store).status==='completed');
});

test('parallel reads cannot exceed the per-task tool-call budget',async t=>{
  // Distinct queries: identical successful reads are separately limited by the repeated-read guard.
  let round=0;const {engine,store}=await fixture(t,[],{executionMode:'bounded',maxToolCalls:60,providers:{async complete(){round++;return {text:'',toolCalls:Array.from({length:8},(_,index)=>call(`read-${index}`,'memory_search',{query:`q${round}-${index}`}))};}}});
  let executed=0;const execute=engine.tools.execute.bind(engine.tools);
  engine.tools.execute=async(...args)=>{executed++;return execute(...args);};
  await engine.start('bot_atlas','Keep reading until the bounded budget is reached.');await waitFor(()=>current(store)?.status==='failed');
  assert.equal(executed,60);assert.match(current(store).error,/tool-call limit/);
  assert.equal(current(store).events.filter(event=>event.type==='tool.started').length,60);
});
