import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { sessionIdFor } from '../lib/sessions.mjs';

const call=(id,query)=>({id,name:'memory_refresh',arguments:{query}});
async function fixture(t,complete,{memory=true}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-memory-refresh-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'refresh_provider',type:'custom',defaultModel:'fixture-model'});for(const bot of state.bots){bot.connectionId='refresh_provider';bot.tools=memory?['workspace','memory']:['workspace'];bot.approvalPolicy='balanced';}});
  const engine=new NativeEngine(store,{providers:{async complete(_connection,request){requests.push(request);return complete(request,requests.length);}}}),tools=new AgentTools(store),bot=store.state.bots[0];
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const run=async task=>{const started=await engine.start(bot.id,task);await engine.tasks.get(started.id);return store.state.runs[bot.id];};
  return {store,engine,tools,bot,requests,run};
}

test('explicit subtopic recall refreshes within the shared three-pass budget and keeps the cached system prefix',async t=>{
  const {store,tools,bot,run,requests}=await fixture(t,async(request,index)=>{
    // memory_refresh belongs to the memory group: the first call loads it for the following steps.
    assert.equal(request.tools.some(tool=>tool.name==='memory_refresh'),index>1);
    if(index===1)return {text:'',toolCalls:[call('garden','tomatoes watering')]};
    if(index===2){assert.match(request.turnContext,/Tomatoes need regular watering/);return {text:'',toolCalls:[call('launch','launch budget')]};}
    if(index===3){assert.match(request.turnContext,/launch budget is EUR 42/);return {text:'',toolCalls:[call('limit','another subtopic')]};}
    const result=JSON.parse(request.messages.find(message=>message.tool_call_id==='limit').content);assert.equal(result.refreshed,false);assert.equal(result.remaining,0);return {text:'Completed using scoped recalled evidence.',toolCalls:[]};
  });
  await tools.execute(bot,'brain_write',{path:'projects/launch',content:'# Launch\nThe launch budget is EUR 42.'});await tools.execute(bot,'brain_write',{path:'topics/garden',content:'# Tomatoes\nTomatoes need regular watering.'});
  const result=await run('Prepare the launch budget.');assert.equal(result.status,'completed');assert.equal(requests.length,4,'recall does not make additional model calls');
  assert.ok(requests.every(request=>request.messages[0].content===requests[0].messages[0].content));assert.equal(result.events.filter(event=>event.type==='memory.recalled').length,3);assert.equal(result.memoryDiagnostics.refreshes,3);assert.equal(result.memoryDiagnostics.reason,'subtopic');assert.equal(store.state.runHistory[bot.id][0].diagnostics.memory.refreshes,3);
});

test('explicit owner recall cannot read a third-party transcript and disabled Memory cannot refresh',async t=>{
  const h=await fixture(t,async(request,index)=>index===1?{text:'',toolCalls:[call('private','private canary')] }:{text:'No private evidence was used.',toolCalls:[]});
  await h.store.mutate(state=>{state.messages[h.bot.id]=[{id:'private_message',role:'user',runId:'private_run',sessionId:sessionIdFor(h.bot.id,'telegram:channel:person'),content:'private canary PRIVATE-CONTEXT-922'}];});
  assert.equal((await h.run('Find private canary evidence if readable.')).status,'completed');assert.doesNotMatch(JSON.stringify(h.requests),/PRIVATE-CONTEXT-922|private_message/);
  const disabled=await fixture(t,async(request,index)=>{assert.ok(!request.tools.some(tool=>tool.name==='memory_refresh'));return index===1?{text:'',toolCalls:[call('refuse','launch budget')]}:{text:'Memory is disabled.',toolCalls:[]};},{memory:false});
  const result=await disabled.run('Refresh memory.');assert.equal(result.status,'completed');assert.equal(result.workRecords.find(record=>record.callId==='refuse').errorCode,'denied');
});
