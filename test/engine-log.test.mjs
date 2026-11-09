import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { createEngineLog, logDay } from '../lib/engine-log.mjs';

const call=(id,name,arguments_)=>({id,name,arguments:arguments_});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=5000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=predicate();if(value)return value;await delay(5);}throw new Error('Timed out waiting for engine-log fixture.');}
const lines=async file=>(await fs.readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));

async function engineFixture(t,complete) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-engine-log-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Fixture',model:'test-model'});state.bots[0].connectionId='fixture-provider';state.bots[0].tools=['workspace','memory'];});
  const engine=new NativeEngine(store,{runTimeout:10_000,providers:{async complete(_connection,request){requests.push(request);return complete(request,requests.length,store);}}});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,store,engine,requests};
}

test('the engine log writes private daily JSONL, redacts strings, rotates and removes old files',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-log-unit-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const logs=path.join(directory,'logs');await fs.mkdir(logs,{recursive:true});
  let clock=new Date(2026,10,9,23,59,0);
  const old=path.join(logs,`engine-${logDay(new Date(2026,9,20))}.jsonl`),recent=path.join(logs,`engine-${logDay(new Date(2026,10,1))}.jsonl`),unrelated=path.join(logs,'notes.txt');
  for(const file of [old,recent,unrelated])await fs.writeFile(file,'{}\n');
  const log=createEngineLog({directory,redact:value=>value.replaceAll('sk-secret','[redacted]'),now:()=>clock});
  log.write({kind:'model.call',runId:'run_1',botId:'bot_a',error:'Bearer sk-secret rejected',nested:{detail:['sk-secret']},durationMs:12});
  await log.flush();
  await assert.rejects(fs.stat(old),error=>error.code==='ENOENT','Files older than 14 days are removed at startup.');
  await fs.stat(recent);await fs.stat(unrelated);
  assert.equal((await fs.stat(logs)).mode & 0o777,0o700);
  const first=path.join(logs,`engine-${logDay(clock)}.jsonl`);assert.equal((await fs.stat(first)).mode & 0o777,0o600);
  const [record]=await lines(first);
  assert.equal(record.kind,'model.call');assert.equal(record.error,'Bearer [redacted] rejected');assert.deepEqual(record.nested.detail,['[redacted]']);assert.ok(record.ts);
  // Crossing midnight writes a new file and runs retention again.
  clock=new Date(2026,10,16,0,1,0);
  log.write({kind:'tool.call',runId:'run_1',botId:'bot_a',tool:'web_search',outcome:'ok'});await log.flush();
  const second=path.join(logs,`engine-${logDay(clock)}.jsonl`);assert.equal((await lines(second))[0].tool,'web_search');
  await assert.rejects(fs.stat(recent),error=>error.code==='ENOENT','Rotation removes files that aged out.');
  log.write({kind:'tool.call',runId:'run_2',botId:'bot_b',tool:'workspace_read',outcome:'ok'});
  const read=await log.read({filter:item=>item.botId==='bot_a'});
  assert.deepEqual(read.map(item=>item.kind),['tool.call'],'Reads only today and yesterday, filtered.');
  // A broken directory never throws into the caller.
  const broken=createEngineLog({directory:path.join(first,'not-a-directory'),now:()=>clock});
  assert.doesNotThrow(()=>broken.write({kind:'tool.call'}));await broken.flush();
});

test('reasoning streams into the run, resets per step and is kept only on display messages',async t=>{
  const seen=[];
  const f=await engineFixture(t,async(request,count,store)=>{
    seen.push({step:count,partialReasoning:store.state.runs.bot_atlas.partialReasoning});
    if(count===1){
      await request.onReasoning?.('Comparing ');await request.onReasoning?.('two fee tables.');
      await waitFor(()=>store.state.runs.bot_atlas.partialReasoning==='Comparing two fee tables.' || store.state.runs.bot_atlas.partialReasoning==='Comparing ');
      seen.push({step:1,flushed:store.state.runs.bot_atlas.partialReasoning});
      return {text:'Checking the notes first.',toolCalls:[call('read-1','memory_search',{query:'fees'})]};
    }
    await request.onReasoning?.('Short final thought.');
    return {text:'The maker fee is lower.',toolCalls:[],reasoning:{text:'Provider summary of the final step.',chars:120}};
  });
  await f.engine.start('bot_atlas','Compare the fees.');
  const run=await waitFor(()=>f.store.state.runs.bot_atlas?.status==='completed' && f.store.state.runs.bot_atlas);
  assert.equal(seen[0].partialReasoning,'');assert.ok(seen[1].flushed.startsWith('Comparing'),'Reasoning is flushed while the model is still working.');
  assert.equal(seen[2].partialReasoning,'','Each model step starts with an empty reasoning buffer.');
  const messages=f.store.state.messages.bot_atlas.filter(message=>message.runId===run.id && message.role==='assistant');
  const progress=messages.find(message=>message.kind==='progress'),final=messages.find(message=>!message.kind && !message.partial);
  assert.equal(progress.content,'Checking the notes first.');assert.equal(progress.reasoning,'Comparing two fee tables.');
  assert.equal(final.content,'The maker fee is lower.');assert.equal(final.reasoning,'Provider summary of the final step.');
  assert.ok(!JSON.stringify(f.store.state.conversations.bot_atlas).includes('fee tables'),'Reasoning never enters model history.');
  assert.deepEqual(run.events.filter(event=>event.type==='model.completed').map(event=>event.reasoningChars),[25,120]);
  // The run.finished record is written just after the completed status is committed.
  let records=[];for(let attempt=0;attempt<400 && !records.some(record=>record.kind==='run.finished' && record.runId===run.id);attempt++){await f.engine.engineLog.flush();records=await lines(path.join(f.directory,'logs',`engine-${logDay()}.jsonl`)).catch(()=>[]);if(!records.some(record=>record.kind==='run.finished'))await delay(10);}
  const models=records.filter(record=>record.kind==='model.call' && record.runId===run.id);
  assert.equal(models.length,2);assert.deepEqual(models[0].toolCalls,['memory_search']);assert.equal(models[1].reasoningChars,120);
  for(const record of models){assert.equal(record.botId,'bot_atlas');assert.equal(record.provider,'openai');assert.ok(Number.isFinite(record.durationMs));assert.ok(Number.isFinite(record.ttftMs));assert.ok(Number.isFinite(record.promptTokensEstimate));}
  const tool=records.find(record=>record.kind==='tool.call' && record.runId===run.id);
  assert.equal(tool.tool,'memory_search');assert.equal(tool.outcome,'ok');assert.ok(tool.bytes>0);assert.equal(tool.step,1);
  const finished=records.find(record=>record.kind==='run.finished' && record.runId===run.id);
  assert.equal(finished.status,'completed');assert.equal(finished.steps,2);assert.equal(finished.toolCalls,1);
});

test('runs_inspect returns only this bot’s runs, current timings and matching log records',async t=>{
  let inspected;
  const f=await engineFixture(t,async(request,count)=>{
    if(count===1)return {text:'',toolCalls:[call('first-read','memory_search',{query:'earlier'})]};
    if(count===2)return {text:'Earlier task done.',toolCalls:[]};
    if(count===3)return {text:'',toolCalls:[call('inspect','runs_inspect',{limit:3})]};
    inspected=JSON.parse(request.messages.findLast(message=>message.role==='tool' && message.tool_call_id==='inspect').content);
    return {text:'Here is what took time.',toolCalls:[]};
  });
  const catalogContext={bot:f.store.state.bots[0],source:'chat',runId:'x',connection:f.store.state.connections[0],inference:{model:'test-model'}};
  assert.ok(f.engine.permittedTools(catalogContext).some(tool=>tool.name==='runs_inspect'));
  assert.ok(!f.engine.toolDefinitions(catalogContext).some(tool=>tool.name==='runs_inspect'),'diagnostics load on demand with the quality group');
  await f.engine.start('bot_atlas','Earlier task.');
  const earlier=await waitFor(()=>f.store.state.runs.bot_atlas?.status==='completed' && f.store.state.runs.bot_atlas);
  await f.store.mutate(state=>{(state.runHistory ||= {}).bot_scout=[{id:'run_other_bot',status:'failed',source:'chat',model:'x',createdAt:new Date().toISOString(),finishedAt:new Date().toISOString(),steps:9,toolCalls:9}];});
  await f.engine.start('bot_atlas','Why was the last answer slow?');
  const current=await waitFor(()=>f.store.state.runs.bot_atlas?.id!==earlier.id && f.store.state.runs.bot_atlas?.status==='completed' && f.store.state.runs.bot_atlas);
  assert.equal(inspected.botId,'bot_atlas');
  assert.deepEqual(inspected.runs.map(run=>run.runId),[earlier.id]);
  assert.equal(inspected.runs[0].status,'completed');assert.equal(inspected.runs[0].steps,2);assert.equal(inspected.runs[0].toolCalls,1);assert.ok(Number.isFinite(inspected.runs[0].durationMs));
  assert.ok(!JSON.stringify(inspected).includes('run_other_bot'),'Other bots’ runs are never shown.');
  assert.equal(inspected.current.runId,current.id);assert.equal(inspected.current.timeline.steps[0].step,1);assert.ok(Number.isFinite(inspected.current.timeline.steps[0].durationMs));
  assert.equal(inspected.current.timeline.tools[0].tool,'runs_inspect');assert.equal(inspected.current.timeline.tools[0].outcome,'running');
  assert.equal(inspected.log.available,true);
  const logged=inspected.log.records;
  assert.ok(logged.some(record=>record.kind==='tool.call' && record.runId===earlier.id && record.tool==='memory_search'));
  assert.ok(logged.some(record=>record.kind==='model.call' && record.runId===current.id));
  assert.ok(logged.every(record=>record.botId==='bot_atlas'));
});
