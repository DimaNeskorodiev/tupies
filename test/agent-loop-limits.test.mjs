import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';

const call=(id,name,arguments_)=>({id,name,arguments:arguments_});
async function fixture(t,complete) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-agent-loop-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'loop_provider',type:'custom',defaultModel:'fixture-model'});for(const bot of state.bots){bot.connectionId='loop_provider';bot.tools=['workspace','memory'];bot.approvalPolicy='balanced';}});
  const engine=new NativeEngine(store,{providers:{async complete(_connection,request){requests.push(request);return complete(request,requests.length);}}}),bot=store.state.bots[0];
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const run=async task=>{const started=await engine.start(bot.id,task);await engine.tasks.get(started.id);return store.state.runs[bot.id];};
  return {store,engine,bot,requests,run};
}

test('a step proposing more than eight tools runs the first eight and answers each remaining call as not started',async t=>{
  const calls=Array.from({length:11},(_,index)=>call(`read-${index}`,'memory_search',{query:String(index)}));
  const {requests,run,store,bot}=await fixture(t,async(_request,index)=>index===1?{text:'',toolCalls:calls}:{text:'Done.',toolCalls:[]});
  const result=await run('List the workspace eleven times.');
  assert.equal(result.status,'completed');
  const conversation=store.state.conversations[bot.id],results=conversation.filter(message=>message.role==='tool');
  // Every proposed id gets exactly one result, in the model's order, so providers accept the history.
  assert.deepEqual(results.map(message=>message.tool_call_id),calls.map(item=>item.id));
  const outcomes=results.map(message=>JSON.parse(message.content));
  assert.ok(outcomes.slice(0,8).every(output=>output.outcome!=='not_started'));
  for(const output of outcomes.slice(8)){assert.equal(output.outcome,'not_started');assert.equal(output.errorCode,'step_call_limit');assert.match(output.error,/Re-issue it in a later step/);}
  assert.equal(requests[1].messages.filter(message=>message.role==='tool').length,11);
  assert.ok(requests[1].messages.every(message=>!('kind' in message)));
});

test('memory_refresh budget is not spent by plan edits and exhaustion is explained',async t=>{
  const plan=(id,status)=>call(id,'task_plan_set',{steps:[{id:'only',title:'Refresh recall',status}]});
  const {run,store,bot}=await fixture(t,async(request,index)=>{
    if(index===1)return {text:'',toolCalls:[plan('p1','in_progress')]};
    if(index===2)return {text:'',toolCalls:[plan('p2','pending')]};
    if(index===3)return {text:'',toolCalls:[plan('p3','in_progress')]};
    if(index===4)return {text:'',toolCalls:[call('r1','memory_refresh',{query:'first subtopic'})]};
    if(index===5)return {text:'',toolCalls:[call('r2','memory_refresh',{query:'second subtopic'})]};
    if(index===6){const reply=JSON.parse(request.messages.find(message=>message.tool_call_id==='r2').content);assert.equal(reply.refreshed,true);assert.equal(reply.remaining,1);return {text:'',toolCalls:[plan('p4','completed')]};}
    return {text:'Finished.',toolCalls:[]};
  });
  const result=await run('Edit the plan several times, then refresh recall.');
  assert.equal(result.status,'completed');
  const reasons=result.events.filter(event=>event.type==='memory.recalled').map(event=>event.reason);
  assert.ok(reasons.filter(reason=>reason==='subtopic').length===2,JSON.stringify(reasons));
  assert.ok(reasons.includes('plan_changed'));
  assert.equal(result.memoryDiagnostics.refreshes,2);
  assert.ok(store.state.conversations[bot.id].some(message=>message.tool_call_id==='r1'));
});
