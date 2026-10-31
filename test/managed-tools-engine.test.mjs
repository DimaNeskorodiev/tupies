import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { writeWorkspace } from '../lib/agent-tools.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const call=(id,name,args)=>({id,name,arguments:args});
async function until(predicate,timeout=20000) {const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=predicate();if(value)return value;await delay(5);}throw new Error('Managed tools fixture timed out.');}
async function fixture(t,complete,{tools=['workspace','terminal'],...options}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-managed-engine-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture-model'});for(const bot of state.bots){bot.connectionId='fixture';bot.tools=tools;bot.approvalPolicy='balanced';}});
  const engine=new NativeEngine(store,{runTimeout:20000,providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length);}},...options});
  await engine.recover();t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  async function run(decide=()=> 'once') {
    const started=await engine.start('bot_atlas','Use background verification and language intelligence to inspect the project.');let approvals=0;
    await until(()=>!isActive(store.state.runs.bot_atlas) || store.state.runs.bot_atlas.status==='waiting_for_approval');
    while(isActive(store.state.runs.bot_atlas)) {
      const current=store.state.runs.bot_atlas;
      // Denial resolves before the next persisted status; do not click a consumed prompt twice.
      if(current.status==='waiting_for_approval'&&engine.pending.get(current.id)?.promptId===current.pending_controls?.[0]?.prompt_id) {
        const request=current.pending_controls[0];approvals++;
        await engine.control('bot_atlas','approval',{runId:current.id,remoteRunId:current.remoteRunId,request_id:request.prompt_id,execution_generation:current.execution_generation,choice:decide(request,approvals)});
      }
      await delay(5);
    }
    await engine.tasks.get(started.id);return {run:store.state.runs.bot_atlas,approvals};
  }
  return {store,engine,requests,run};
}
const output=(request,id)=>JSON.parse(request.messages.findLast(message=>message.tool_call_id===id).content);

test('actual background command and bundled LSP execute through engine approvals and drain before success',async t=>{
  let processId,sessionId;
  const f=await fixture(t,async(request,index)=>{
    if(index===1)return {text:'Starting a verification command and the bundled language server.',toolCalls:[
      call('background','shell_start',{executable:process.execPath,args:['-e',"console.log('verification started');setTimeout(()=>{console.log('verification passed')},150)"],timeoutMs:10000}),
      call('language','lsp_start',{server:'typescript'}),
    ]};
    if(index===2){processId=output(request,'background').processId;sessionId=output(request,'language').sessionId;assert.ok(processId&&sessionId);return {text:'Inspecting the code and command output.',toolCalls:[call('status','shell_read',{processId,waitMs:1000}),call('definition','lsp_query',{sessionId,path:'main.ts',operation:'definition',line:2,character:23}),call('symbols','lsp_query',{sessionId,path:'main.ts',operation:'document_symbols'})]};}
    const command=JSON.parse(request.messages.findLast(message=>/^status/.test(message.tool_call_id || '')).content);
    if(command.status==='running')return {text:'Waiting for command cleanup.',toolCalls:[call(`status-${index}`,'shell_read',{processId,offset:command.retainedChars,waitMs:1000})]};
    assert.equal(command.status,'completed');assert.equal(command.exitCode,0);assert.ok(request.messages.filter(message=>/^status/.test(message.tool_call_id || '')).some(message=>JSON.parse(message.content).output.includes('verification passed')));
    const definition=output(request,'definition');assert.ok(definition.locations.some(location=>location.path==='main.ts' && location.range.start.line===1));assert.ok(output(request,'symbols').symbols.length>=2);
    return {text:'The command passed and real LSP navigation resolved the declaration.',toolCalls:[]};
  });
  await writeWorkspace(f.store,'bot_atlas','main.ts','export function greet(name: string) { return name; }\nexport const answer = greet("hello");\n');
  const result=await f.run();assert.equal(result.run.status,'completed',result.run.error);assert.equal(result.approvals,2);
  assert.equal(result.run.backgroundProcesses[0].status,'completed');assert.equal(result.run.languageServers[0].status,'stopped');
  assert.equal(f.engine.backgroundProcesses.hasActive(result.run.id),false);assert.equal(f.engine.languageServers.sessions.size,0);
});

test('bounded final answers cannot silently abandon a running command or report its task successful',async t=>{
  const f=await fixture(t,async(request,index)=>index===1?{text:'',toolCalls:[call('long','shell_start',{executable:process.execPath,args:['-e',"console.log('partial progress');setInterval(()=>{},1000)"],timeoutMs:10000})]}:{text:'An available partial answer.',toolCalls:[]},{executionMode:'bounded'});
  const result=await f.run();assert.equal(result.run.status,'failed');assert.match(result.run.error,/background commands were still running/);assert.equal(result.run.partialOutput,'An available partial answer.');
  assert.equal(f.engine.backgroundProcesses.hasActive(result.run.id),false);assert.notEqual(result.run.backgroundProcesses[0].status,'running');assert.equal(result.approvals,1);
});

test('denied process/server launches never create runtime handles, and tool groups remain enforced',async t=>{
  const f=await fixture(t,async(request,index)=>index===1?{text:'',toolCalls:[call('background','shell_start',{executable:process.execPath,args:['-e','process.exit(0)']}),call('server','lsp_start',{server:'typescript'})]}:{text:'Both launches were denied.',toolCalls:[]});
  const result=await f.run(()=> 'deny');assert.equal(result.approvals,2);assert.equal(result.run.backgroundProcesses,undefined);assert.equal(result.run.languageServers,undefined);
  assert.equal(f.engine.backgroundProcesses.hasActive(result.run.id),false);assert.equal(f.engine.languageServers.sessions.size,0);
  const bot={...f.store.state.bots[0],tools:['workspace']};assert.ok(!f.engine.tools.definitions(bot).some(item=>item.name==='lsp_start'));
  await assert.rejects(f.engine.tools.execute(bot,'shell_start',{executable:process.execPath,args:[]},{runId:result.run.id,approved:true}),/not enabled/);
  await assert.rejects(f.engine.tools.execute({...bot,tools:['terminal']},'lsp_start',{server:'typescript'},{runId:result.run.id,approved:true}),/Workspace as well as Terminal/);
});

test('Stop cancels background children before the owning run is terminal',async t=>{
  let providerEntered;const providerWaiting=new Promise(resolve=>{providerEntered=resolve;});
  const f=await fixture(t,async(request,index)=>{
    if(index===1)return {text:'',toolCalls:[call('long','shell_start',{executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeoutMs:10000})]};
    providerEntered();await new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));
  });
  const run=await f.engine.start('bot_atlas','Start work and wait for Stop.');
  const approval=await until(()=>f.store.state.runs.bot_atlas.status==='waiting_for_approval' && f.store.state.runs.bot_atlas);
  await f.engine.control('bot_atlas','approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:approval.pending_controls[0].prompt_id,execution_generation:approval.execution_generation,choice:'once'});
  await providerWaiting;assert.equal(f.engine.backgroundProcesses.hasActive(run.id),true);
  await f.engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});await f.engine.tasks.get(run.id);
  assert.equal(f.store.state.runs.bot_atlas.status,'cancelled');assert.equal(f.engine.backgroundProcesses.hasActive(run.id),false);assert.notEqual(f.store.state.runs.bot_atlas.backgroundProcesses[0].status,'running');
});

test('nonzero background exit is an explicit provider error result while its captured evidence stays available',async t=>{
  let processId,poll=0;
  const f=await fixture(t,async(request,index)=>{
    if(index===1)return {text:'',toolCalls:[call('bad','shell_start',{executable:process.execPath,args:['-e',"console.error('expected failure');process.exit(7)"],timeoutMs:5000})]};
    if(index===2){processId=output(request,'bad').processId;return {text:'',toolCalls:[call('read0','shell_read',{processId,waitMs:1000})]};}
    const message=request.messages.findLast(item=>/^read/.test(item.tool_call_id || '')),result=JSON.parse(message.content);
    if(result.status==='running')return {text:'',toolCalls:[call(`read${++poll}`,'shell_read',{processId,offset:result.retainedChars,waitMs:1000})]};
    assert.equal(result.exitCode,7);assert.equal(result.status,'failed');assert.equal(message.is_error,true);
    return {text:'The verification command failed with exit code 7; its error output is preserved.',toolCalls:[]};
  });
  const {run}=await f.run();assert.equal(run.status,'completed',run.error);assert.equal(run.backgroundProcesses[0].exitCode,7);
  assert.match(run.backgroundProcesses[0].output,/expected failure/);
});
