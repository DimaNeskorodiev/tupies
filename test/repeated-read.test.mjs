import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { repeatedRead, noteCompletedRead } from '../lib/work-quality.mjs';

const call=(id,name,arguments_)=>({id,name,arguments:arguments_});
async function waitFor(predicate,timeout=5000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Timed out waiting for repeated-read fixture.');}

test('the third identical successful read is answered without running it again',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-repeated-read-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Fixture',model:'test-model'});state.bots[0].connectionId='fixture-provider';state.bots[0].tools=['workspace','memory'];});
  const engine=new NativeEngine(store,{runTimeout:10_000,providers:{async complete(_connection,request){requests.push(request);const step=requests.length;return step<=4?{text:'',toolCalls:[call(`same-${step}`,'memory_search',{query:'hyperliquid fees'}),...(step===4?[call('other-4','memory_search',{query:'different'})]:[])]}:{text:'Done with the earlier result.',toolCalls:[]};}}});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const executed=[];const execute=engine.tools.execute.bind(engine.tools);
  engine.tools.execute=async(bot,name,args,options)=>{executed.push(`${name}:${args.query}`);return execute(bot,name,args,options);};
  await engine.start('bot_atlas','Look up the fee schedule.');
  const run=await waitFor(()=>store.state.runs.bot_atlas?.status==='completed' && store.state.runs.bot_atlas);
  assert.deepEqual(executed,['memory_search:hyperliquid fees','memory_search:hyperliquid fees','memory_search:different']);
  const skipped=run.events.filter(event=>event.type==='tool.skipped');
  assert.deepEqual(skipped.map(event=>[event.toolCallId,event.reason]),[['same-3','repeated_read'],['same-4','repeated_read']]);
  const history=store.state.conversations.bot_atlas.filter(message=>message.role==='tool');
  const third=JSON.parse(history.find(message=>message.tool_call_id==='same-3').content);
  assert.equal(third.errorCode,'repeated_read');assert.equal(third.outcome,'not_started');assert.equal(third.retryable,false);assert.match(third.error,/already returned the same result twice/);
  const records=run.workRecords.filter(record=>record.errorCode==='repeated_read');
  assert.deepEqual(records.map(record=>record.callId),['same-3','same-4']);
  // A blocked duplicate is not counted as a failed read, so it never escalates into repeated_failure.
  assert.ok(!history.some(message=>JSON.parse(message.content).errorCode==='repeated_failure'));
});

test('mutating, paging and polling tools are never limited and state changes make reads fresh',()=>{
  const context={toolResults:new Map()};
  const twice=item=>{noteCompletedRead(context,item,{succeeded:true});noteCompletedRead(context,item,{succeeded:true});};
  for(const item of [call('w','workspace_write',{path:'a.txt',content:'x'}),call('p','tool_result_read',{resultId:'result_1',offset:0}),call('s','shell_read',{processId:'p1'}),call('d','delegation_status',{}),call('t','task_plan_get',{}),call('k','desktop_observe',{}),call('h','http_fetch',{url:'https://example.com/api',method:'POST'})]){twice(item);assert.equal(repeatedRead(context,item),null,item.name);}
  const read=call('r','workspace_read',{path:'notes.md'});twice(read);
  assert.equal(repeatedRead(context,read).errorCode,'repeated_read');
  assert.equal(repeatedRead(context,call('r2','workspace_read',{path:'other.md'})),null,'Changed arguments are a different read.');
  noteCompletedRead(context,call('w','workspace_write',{path:'notes.md',content:'y'}),{succeeded:true,stateChanging:true});
  assert.equal(repeatedRead(context,read),null,'A state-changing call makes earlier reads stale.');
  // Failed reads are counted by repeatedFailure instead.
  const fetch=call('f','http_fetch',{url:'https://example.com'});noteCompletedRead(context,fetch,{succeeded:false});noteCompletedRead(context,fetch,{succeeded:false});
  assert.equal(repeatedRead(context,fetch),null);
});

test('a shortened earlier result is referenced for paging while it is retained',()=>{
  const context={toolResults:new Map([['result_kept',{callId:'a',content:'x'.repeat(10),totalChars:20000}]])};
  const read=call('a','skills_read',{name:'research'});
  noteCompletedRead(context,read,{succeeded:true,resultId:'result_kept'});noteCompletedRead(context,read,{succeeded:true});
  const blocked=repeatedRead(context,read);
  assert.equal(blocked.previousResultId,'result_kept');assert.match(blocked.recovery,/tool_result_read/);
  context.toolResults.clear();
  assert.equal(repeatedRead(context,read).previousResultId,undefined,'An expired retained result is not offered.');
});
