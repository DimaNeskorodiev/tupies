// Owned subprocess for verify-runtime.mjs. It refuses arbitrary operational directories.
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {createStudioServer,controlSocketPath} from '../server.mjs';
import {Store} from '../lib/store.mjs';

const [operation,directory,mibText,batchesText]=process.argv.slice(2),started=performance.now();
const marker=JSON.parse(await fs.readFile(path.join(path.dirname(directory),'verification-only.json'),'utf8'));
assert.ok(process.env.TUPIES_VERIFICATION_TOKEN && marker.token===process.env.TUPIES_VERIFICATION_TOKEN);
assert.ok(['load','crash','recover'].includes(operation));
const mib=Number(mibText),batches=Number(batchesText);assert.ok(Number.isInteger(mib)&&mib>=1&&mib<=64&&Number.isInteger(batches)&&batches>=1&&batches<=12);
const secret='disposable-runtime-verification-token',partial='A retained fixture partial answer.';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sum=bytes=>createHash('sha256').update(bytes).digest('hex');
const until=async predicate=>{const deadline=Date.now()+45_000;while(Date.now()<deadline){if(await predicate())return;await delay(10);}throw new Error('A bounded runtime verification condition timed out.');};
const transcriptText='Synthetic runtime transcript; no user data. '.repeat(48);
let calls=0,app;
function provider() {
  return {async complete(_connection,request) {
    calls++;
    if(!request.tools?.length)return {text:'A bounded synthetic context summary.',toolCalls:[]};
    const task=request.messages.findLast(message=>message.role==='user'&&String(message.content).startsWith('RUNTIME_'))?.content || '';
    const taskId=task.match(/RUNTIME_(?:LOAD|CRASH|APPROVAL) ([a-z0-9_-]+)/)?.[1];assert.ok(taskId);
    const callId=`write_${taskId}`,done=request.messages.some(message=>message.role==='tool'&&message.tool_call_id===callId);
    if(!done)return {text:'',toolCalls:[{id:callId,name:'workspace_write',arguments:{path:`verification/${taskId}.txt`,content:`Verified ${taskId}\n`}}]};
    if(String(task).startsWith('RUNTIME_CRASH')) {
      // Allow the engine's normal partial-output throttle to expire before the committed checkpoint.
      await delay(450);
      await request.onDelta?.(partial);
      await new Promise((resolve,reject)=>{request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});});
    }
    return {text:`Completed ${taskId}.`,toolCalls:[],usage:{input_tokens:20,output_tokens:8}};
  }};
}
async function open() {
  const networkDisabled=async()=>{throw new Error('External transport is disabled in runtime verification.');};
  // This fixture measures bounded no-replay recovery; autonomous continuation has separate engine boundary tests.
  app=await createStudioServer({dataDir:directory,scheduler:false,executionMode:'bounded',logErrors:false,publicUrl:'',tls:'off',secureCookie:false,providers:provider(),sync:{engineName:'Disposable verification engine',syncFetch:networkDisabled,fileScanInterval:600_000},notifications:{transport:{available:false,reason:'fixture_disabled',async send(){throw new Error('No APNs in fixtures.');},close(){}}}});
  const {url}=await app.listen(0,'127.0.0.1');await app.openControl(controlSocketPath(directory),url);return url;
}
try {
  if(operation==='load') {
    const store=await new Store(directory).init();
    await store.mutate(state=>{
      state.connections.push({id:'verification-provider',type:'openai',name:'Fixture',model:'fixture-model',contextWindow:8000,secret:store.seal(secret)});
      state.bots.push({...structuredClone(state.bots[0]),id:'bot_echo',name:'Echo'});
      // Keep this 8K no-replay workload independent of product starter roles and their optional skills.
      for(const bot of state.bots){bot.connectionId='verification-provider';bot.model='fixture-model';bot.instructions='Complete the requested disposable workspace verification and report the observed result.';bot.skills=[];bot.tools=['workspace'];bot.approvalPolicy='balanced';}
      const count=Math.ceil(mib*1024**2/(transcriptText.length*2));
      state.messages.bot_atlas=Array.from({length:count},(_,index)=>({id:`historical_${index}`,role:index%2?'assistant':'user',content:transcriptText,createdAt:new Date(1_700_000_000_000+index).toISOString()}));
      state.conversations.bot_atlas=state.messages.bot_atlas.map(({role,content})=>({role,content}));
      state.memory.bot_atlas=[{id:'verification_fact',key:'Fixture fact',value:'Retained after restore.',updatedAt:new Date().toISOString()}];
      state.routines.push({id:'verification_routine',botId:'bot_atlas',name:'Disabled fixture',prompt:'Never dispatch during recovery.',enabled:false,intervalMinutes:60});
    });
    await fs.mkdir(path.join(directory,'process-homes/bot_atlas/.config'),{recursive:true,mode:0o700});
    await fs.writeFile(path.join(directory,'process-homes/bot_atlas/.config/verification-state'),'Preserved opaque tool state.',{mode:0o600});
    await fs.mkdir(path.join(directory,'workspaces/bot_atlas/notes'),{recursive:true,mode:0o700});
    await fs.writeFile(path.join(directory,'workspaces/bot_atlas/notes/verification.md'),'# A retained fixture note\n',{mode:0o600});
    const stateBytes=(await fs.stat(store.file)).size,url=await open();
    const setup=await fetch(`${url}/api/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'disposable-verification-password'})});assert.equal(setup.status,201);
    const cookie=setup.headers.get('set-cookie').split(';')[0],timings=[];let samples=0,stop=false;
    const polling=(async()=>{while(!stop&&samples<24){const replies=await Promise.all(Array.from({length:4},()=>fetch(`${url}/api/state`,{headers:{Cookie:cookie}})));for(const reply of replies){assert.equal(reply.status,200);assert.ok((await reply.json()).bots.length===4);}JSON.parse(await fs.readFile(app.store.file,'utf8'));samples++;await delay(10);}})();
    const bots=app.store.state.bots.slice(0,4);
    try {
      for(let batch=0;batch<batches;batch++) {
        const at=performance.now();
        const accepted=await Promise.all(bots.map(bot=>app.runtime.submit(bot.id,`RUNTIME_LOAD batch_${batch}_${bot.id}`,{clientMessageId:`load_${batch}_${bot.id}`})));
        await Promise.all([...app.runtime.tasks.values()]);
        for(let index=0;index<bots.length;index++) {
          const bot=bots[index],run=app.store.state.runs[bot.id];assert.equal(run.status,'completed',`${bot.id}: ${run.error||run.status}`);
          assert.equal(await fs.readFile(path.join(directory,'workspaces',bot.id,'verification',`batch_${batch}_${bot.id}.txt`),'utf8'),`Verified batch_${batch}_${bot.id}\n`);
          const duplicate=await app.runtime.submit(bot.id,`RUNTIME_LOAD batch_${batch}_${bot.id}`,{clientMessageId:`load_${batch}_${bot.id}`});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.run.id,accepted[index].run.id);
        }
        timings.push(performance.now()-at);
      }
    } finally {stop=true;await polling;}
    const metrics={stateBytes,batches,concurrency:4,completedTasks:batches*4,pollBatches:samples,batchMs:timings,providerCalls:calls,rssBytes:process.memoryUsage().rss,elapsedMs:performance.now()-started};
    await app.close();app=null;process.send?.({kind:'done',metrics});
  } else if(operation==='crash') {
    await open();assert.equal(app.store.unseal(app.store.state.connections.find(entry=>entry.id==='verification-provider').secret),secret);
    assert.equal(await fs.readFile(path.join(directory,'process-homes/bot_atlas/.config/verification-state'),'utf8'),'Preserved opaque tool state.');
    await app.store.mutate(state=>{state.bots.find(bot=>bot.id==='bot_nova').approvalPolicy='strict';});
    const first=await app.runtime.submit('bot_atlas','RUNTIME_CRASH committed_before_loss',{clientMessageId:'crash_committed_001'});
    await app.runtime.submit('bot_nova','RUNTIME_APPROVAL never_approved',{clientMessageId:'crash_approval_001'});
    await until(()=>app.store.state.runs.bot_atlas?.partialOutput===partial&&app.store.state.runs.bot_nova?.status==='waiting_for_approval');
    await app.store.queue;
    const file=await fs.readFile(path.join(directory,'workspaces/bot_atlas/verification/committed_before_loss.txt'));
    process.send?.({kind:'crash-ready',runId:first.run.id,committedSha256:sum(file),statuses:['running','waiting_for_approval']});
    setInterval(()=>{},1000);
  } else {
    await open();
    assert.equal(calls,0,'Recovery must not dispatch a model request.');
    for(const botId of ['bot_atlas','bot_nova']){assert.equal(app.store.state.runs[botId].status,'interrupted');assert.equal(app.store.state.runs[botId].pending_controls,undefined);}
    assert.ok(app.store.state.messages.bot_atlas.some(message=>message.partial&&message.content===partial));
    const file=await fs.readFile(path.join(directory,'workspaces/bot_atlas/verification/committed_before_loss.txt'));
    await assert.rejects(fs.stat(path.join(directory,'workspaces/bot_nova/verification/never_approved.txt')),error=>error.code==='ENOENT');
    const original=await app.runtime.submit('bot_atlas','RUNTIME_CRASH committed_before_loss',{clientMessageId:'crash_committed_001'});assert.equal(original.duplicate,true);assert.equal(original.run.status,'interrupted');assert.equal(calls,0);
    await app.close();app=null;process.send?.({kind:'done',metrics:{recoveredStatuses:['interrupted','interrupted'],providerCalls:0,committedSha256:sum(file),unapprovedFileAbsent:true,partialRetained:true,receiptPreventedReplay:true}});
  }
} catch(error) {
  process.send?.({kind:'failure',message:`A disposable runtime verification check failed: ${String(error.message).slice(0,500)}`});process.exitCode=1;
  if(app)await app.close().catch(()=>{});
}
if(operation!=='crash'||process.exitCode)process.disconnect?.();
