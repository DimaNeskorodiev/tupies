import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine, isActive, compactConversation } from '../lib/engine.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { Rooms, roomDelta } from '../lib/rooms.mjs';
import { sessionIdFor, sessionOwner, telegramLane } from '../lib/sessions.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=4000) {const until=Date.now()+timeout;while(Date.now()<until){const result=predicate();if(result)return result;await delay(5);}throw new Error('Fixture timed out waiting for agent state.');}
const call=(id,name,arguments_)=>({id,name,arguments:arguments_});
async function fixture(t,complete,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-native-engine-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'native-provider',type:'openai',name:'Fixture',model:'test-model',secret:store.seal('fixture-private-key')});for(const bot of state.bots){bot.connectionId='native-provider';bot.tools=['workspace','memory','skills','web','delegation'];bot.collaborators=[];bot.approvalPolicy='strict';}});
  const engine=new NativeEngine(store,{runTimeout:10_000,providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length,connection);}},...options});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,requests,directory};
}
const current=(store,botId='bot_atlas')=>store.state.runs[botId];
const decision=run=>({runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation});

test('independent engine runs its own model/tool loop and persists private memory/history',async t=>{
  const {engine,store,requests}=await fixture(t,async request=>request.messages.at(-1).role==='user' ? {text:'',toolCalls:[call('remember','memory_set',{key:'preferred-format',value:'Short plain paragraphs.'})],providerItems:[{type:'reasoning',id:'reasoning-fixture',summary:[]}]} : {text:'I remembered your writing preference.',toolCalls:[],usage:{input_tokens:10,output_tokens:8}});
  const run=await engine.start('bot_atlas','Remember my writing preference.');
  await waitFor(()=>current(store)?.status==='completed');
  assert.equal(current(store).engine,'studio-native');assert.equal(current(store).remoteRunId,run.id);
  assert.equal(store.state.memory.bot_atlas[0].value,'Short plain paragraphs.');assert.equal(store.state.memory.bot_nova,undefined);
  assert.equal(store.state.messages.bot_atlas.at(-1).content,'I remembered your writing preference.');
  assert.equal(requests.length,2);assert.equal(requests[1].messages.at(-1).role,'tool');
  assert.deepEqual(requests[1].messages.find(message=>message.role==='assistant').providerItems,[{type:'reasoning',id:'reasoning-fixture',summary:[]}]);
  assert.ok(current(store).events.some(event=>event.type==='tool.completed'));
  assert.equal(engine.capabilities().engine,'studio-native');
});

test('provider credential echoes cannot become plaintext tool arguments or durable memory',async t=>{
  const {engine,store}=await fixture(t,async request=>request.messages.at(-1).role==='user' ? {text:'',toolCalls:[call('echo-secret','memory_set',{key:'provider-data',value:'fixture-private-key'})]} : {text:'The returned service data was handled.',toolCalls:[]});
  await engine.start('bot_atlas','Process the service response.');await waitFor(()=>current(store)?.status==='completed');
  assert.equal(store.state.memory.bot_atlas[0].value,'[redacted]');
  assert.doesNotMatch(await fs.readFile(store.file,'utf8'),/fixture-private-key/);
});

test('stored credentials with quotes or backslashes are redacted from structured tool results',async t=>{
  const secret='svc"quoted\\credential-value';
  const {engine,store,requests}=await fixture(t,async request=>request.messages.at(-1).role==='user' ? {text:'',toolCalls:[call('read-config','workspace_read',{path:'service.json'})]} : {text:'Read the configuration.',toolCalls:[]});
  await store.mutate(state=>{state.integrations.push({id:'integration_fixture',name:'Fixture service',secret:store.seal(secret)});});
  await fs.writeFile(path.join(await getWorkspaceRoot(store,'bot_atlas'),'service.json'),`token: ${secret}\n`);
  await engine.start('bot_atlas','Check the service configuration.');await waitFor(()=>current(store)?.status==='completed');
  const result=requests[1].messages.at(-1).content;
  assert.match(result,/token: \[redacted\]/);assert.ok(!result.includes(JSON.stringify(secret).slice(1,-1)));assert.ok(!result.includes(secret));
  assert.ok(!JSON.stringify(store.state).includes(JSON.stringify(secret).slice(1,-1)));
});

test('internal display text is bounded and validated before starting a provider task',async t=>{
  const {engine,store,requests}=await fixture(t,async()=>({text:'Unused.',toolCalls:[]}));
  for(const displayText of [42,{},'', '   ','x'.repeat(100001)])await assert.rejects(engine.start('bot_atlas','Full internal context.',{displayText}),/Display task/);
  assert.equal(requests.length,0);assert.equal(store.state.runs.bot_atlas,undefined);assert.equal(store.state.messages.bot_atlas,undefined);
});

test('an incomplete model turn preserves its text but never executes accompanying tool calls',async t=>{
  const {engine,store,requests}=await fixture(t,async()=>({text:'The available partial response.',toolCalls:[call('incomplete-memory','memory_set',{key:'must-not-exist',value:'Never committed.'}),call('incomplete-file','workspace_write',{path:'never-written.txt',content:'Never committed.'})],finishReason:'length'}));
  await engine.start('bot_atlas','Handle an incomplete provider response safely.');
  await waitFor(()=>current(store)?.status==='failed');
  assert.equal(requests.length,1);assert.match(current(store).error,/incomplete/);
  assert.equal(current(store).output,'The available partial response.');assert.equal(current(store).partialOutput,'The available partial response.');
  assert.equal(store.state.memory.bot_atlas,undefined);
  await assert.rejects(fs.access(path.join(await getWorkspaceRoot(store,'bot_atlas'),'never-written.txt')));
  assert.ok(!current(store).events.some(event=>['tool.started','approval.request','run.completed'].includes(event.type)));
  const reconciled=store.state.conversations.bot_atlas.filter(message=>message.role==='tool');
  assert.equal(reconciled.length,2);assert.ok(reconciled.every(message=>message.content.includes('task failed')));
  const partial=store.state.messages.bot_atlas.find(message=>message.role==='assistant');
  assert.equal(partial.content,'The available partial response.');assert.equal(partial.partial,true);assert.equal(partial.runStatus,'failed');
});

test('exact approval gates file actions and a stale consent never authorizes the next tool',async t=>{
  const {engine,store}=await fixture(t,async request=>request.messages.at(-1).role==='user' ? {text:'I can write two files.',toolCalls:[call('write-a','workspace_write',{path:'a.txt',content:'  exact bytes\n'}),call('write-b','workspace_write',{path:'b.txt',content:'Never written'})]} : {text:'The approved file was written; the second action was denied.',toolCalls:[]});
  await engine.start('bot_atlas','Draft two files.');
  const first=await waitFor(()=>current(store)?.status==='waiting_for_approval' && current(store));
  const root=await getWorkspaceRoot(store,'bot_atlas'),a=decision(first);
  await assert.rejects(fs.access(path.join(root,'a.txt')));
  await assert.rejects(engine.control('bot_atlas','approval',{...a,execution_generation:0,choice:'once'}),/prompt changed/);
  await engine.control('bot_atlas','approval',{...a,choice:'once'});
  await waitFor(()=>current(store)?.status==='waiting_for_approval' && current(store).pending_controls[0].prompt_id!==a.request_id);
  await assert.rejects(engine.control('bot_atlas','approval',{...a,choice:'once'}),/prompt changed/);
  const b=decision(current(store));await engine.control('bot_atlas','approval',{...b,choice:'deny'});
  await waitFor(()=>current(store)?.status==='completed');
  assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'  exact bytes\n');await assert.rejects(fs.access(path.join(root,'b.txt')));
});

test('stop aborts a pending provider request and cannot act on a newer run',async t=>{
  const {engine,store,requests}=await fixture(t,async request=>new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true})));
  // The persisted model.started event precedes invocation of the provider. Wait for
  // the pending request itself so its mock abort listener is installed before Stop.
  const run=await engine.start('bot_atlas','Wait for a model.');await waitFor(()=>requests.length===1);
  await assert.rejects(engine.control('bot_atlas','stop',{runId:'old',remoteRunId:'old'}),/older run/);
  await engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});
  await waitFor(()=>current(store)?.status==='cancelled');assert.equal(isActive(current(store)),false);
});

test('a stopped streamed answer remains in transcript after another task and restart without being replayed as a completed answer',async t=>{
  let readyToStop=false;
  const {engine,store,requests,directory}=await fixture(t,async(request,index)=>{
    if(index>1)return {text:'AFTER_STOP',toolCalls:[]};
    await request.onDelta('Available streamed text; fixture-private-key must stay private.');
    return new Promise((resolve,reject)=>{request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});readyToStop=true;});
  });
  const stopped=await engine.start('bot_atlas','Stream an answer until I stop it.');
  await waitFor(()=>readyToStop && current(store)?.partialOutput);
  await engine.control('bot_atlas','stop',{runId:stopped.id,remoteRunId:stopped.remoteRunId});
  await engine.tasks.get(stopped.id);
  assert.equal(current(store).status,'cancelled');
  const partial=store.state.messages.bot_atlas.find(message=>message.runId===stopped.id&&message.partial);
  assert.equal(partial?.role,'assistant');assert.equal(partial.runStatus,'cancelled');
  assert.equal(partial.content,'Available streamed text; [redacted] must stay private.');
  const next=await engine.start('bot_atlas','Continue with a fresh task.');await engine.tasks.get(next.id);
  assert.equal(current(store).status,'completed');assert.notEqual(current(store).id,stopped.id);
  assert.equal(store.state.messages.bot_atlas.filter(message=>message.runId===stopped.id&&message.partial).length,1);
  assert.equal(store.state.messages.bot_atlas.filter(message=>message.runId===next.id&&message.role==='assistant').length,1);
  assert.equal(store.state.messages.bot_atlas.find(message=>message.runId===next.id&&message.role==='assistant').partial,undefined);
  assert.ok(!requests[1].messages.some(message=>String(message.content).includes('Available streamed text')));
  await engine.close();
  const restored=await new Store(directory).init(),restarted=new NativeEngine(restored,{providers:{complete(){throw new Error('Restart must not replay provider requests.');}}});
  await restarted.recover();await restarted.recover();
  assert.equal(restored.state.messages.bot_atlas.filter(message=>message.runId===stopped.id&&message.partial).length,1);
  assert.equal(restored.state.messages.bot_atlas.find(message=>message.runId===stopped.id&&message.partial).content,partial.content);
  assert.equal(restored.state.messages.bot_atlas.filter(message=>message.runId===next.id&&message.role==='assistant').length,1);
  await restarted.close();
});

test('restart recovery records interrupted partial text once without adding it to model history',async t=>{
  const {engine,store}=await fixture(t,async()=>{throw new Error('Recovery must not call the provider.');});
  await store.mutate(state=>{state.runs.bot_atlas={id:'crashed-run',botId:'bot_atlas',status:'running',partialOutput:'Crash partial fixture-private-key',pending_controls:[{prompt_id:'old'}]};});
  await engine.recover();await engine.recover();
  const partials=store.state.messages.bot_atlas.filter(message=>message.runId==='crashed-run'&&message.partial);
  assert.equal(partials.length,1);assert.equal(partials[0].runStatus,'interrupted');assert.equal(partials[0].content,'Crash partial [redacted]');
  assert.ok(!store.state.conversations.bot_atlas.some(message=>String(message.content).includes('Crash partial')));
  assert.equal(current(store).status,'interrupted');assert.equal(current(store).pending_controls,undefined);
});

test('stopping an approval does not execute it and restart recovery never replays actions',async t=>{
  const {engine,store}=await fixture(t,async()=>({text:'',toolCalls:[call('write','workspace_write',{path:'never.txt',content:'No.'})]}));
  const run=await engine.start('bot_atlas','Wait for approval.');await waitFor(()=>current(store)?.status==='waiting_for_approval');
  await engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});await waitFor(()=>current(store)?.status==='cancelled');
  await assert.rejects(fs.access(path.join(await getWorkspaceRoot(store,'bot_atlas'),'never.txt')));
  await store.mutate(state=>{state.runs.bot_atlas={id:'lost',remoteRunId:'lost',status:'waiting_for_approval',pending_controls:[{prompt_id:'old'}]};});
  await engine.recover();assert.equal(current(store).status,'interrupted');assert.equal(current(store).pending_controls,undefined);
});

test('an interrupted tool batch is reconciled before the next model request',async t=>{
  const {engine,store,requests}=await fixture(t,async request=>request.messages.at(-1).content==='Resume safely.' ? {text:'I can continue without assuming the interrupted file was written.',toolCalls:[]} : {text:'',toolCalls:[call('pending-file','workspace_write',{path:'pending.txt',content:'Unapproved'})]});
  const first=await engine.start('bot_atlas','Prepare a file.');await waitFor(()=>current(store)?.status==='waiting_for_approval');
  await engine.control('bot_atlas','stop',{runId:first.id,remoteRunId:first.remoteRunId});await waitFor(()=>current(store)?.status==='cancelled');
  await engine.start('bot_atlas','Resume safely.');await waitFor(()=>current(store)?.status==='completed');
  const history=requests.at(-1).messages,tool=history.find(message=>message.role==='tool' && message.tool_call_id==='pending-file');
  assert.match(tool.content,/interrupted/);
  assert.ok(history.indexOf(tool)<history.findIndex(message=>message.role==='user' && message.content==='Resume safely.'));
});

test('autonomous collaboration invokes a real collaborator loop and blocks delegation cycles',async t=>{
  const {engine,store,requests}=await fixture(t,async request=>{
    const atlas=request.messages[0].content.startsWith(`You are ${store.state.bots.find(bot=>bot.id==='bot_atlas').name}`);
    if(request.messages.at(-1).role==='user')return {text:'',toolCalls:[call(atlas?'ask-nova':'cycle','delegate_task',{botId:atlas?'bot_nova':'bot_atlas',task:'Research the task.'})]};
    return {text:atlas?'I reviewed Nova’s real findings.':'Actual research from Nova.',toolCalls:[]};
  });
  await store.mutate(state=>{state.bots.find(bot=>bot.id==='bot_atlas').collaborators=['bot_nova'];state.bots.find(bot=>bot.id==='bot_nova').collaborators=['bot_atlas'];});
  await engine.start('bot_atlas','Work with Nova.');await waitFor(()=>current(store)?.status==='completed');
  assert.equal(current(store,'bot_nova').output,'Actual research from Nova.');
  assert.ok(store.state.conversations.bot_nova.some(message=>message.role==='tool' && message.content.includes('cycle')));
  assert.ok(requests.at(-1).messages.some(message=>message.role==='tool' && message.content.includes('Actual research from Nova.')));
  assert.ok(current(store).events.some(event=>event.type==='delegation.completed' && event.childRunId===current(store,'bot_nova').id));
});

test('autonomous room consent scopes collaborators without changing global bot permissions and bounds cost',async t=>{
  const {engine,store}=await fixture(t,async request=>{
    const atlas=request.messages[0].content.startsWith(`You are ${store.state.bots.find(bot=>bot.id==='bot_atlas').name}`);
    if(atlas && request.messages.at(-1).role==='user')return {text:'',toolCalls:[call('first','delegate_task',{botId:'bot_scout',task:'Check the task.'}),call('over-budget','delegate_task',{botId:'bot_scout',task:'Repeat the same work.'})]};
    return {text:atlas?'Reviewed one specialist result.':'Scout checked the task.',toolCalls:[]};
  });
  await store.mutate(state=>{state.rooms.push({id:'team',name:'Team',botIds:['bot_atlas','bot_scout'],autoCollaborate:true,maxRounds:1});});
  await engine.start('bot_atlas','Coordinate the team.',{roomId:'team',source:'room'});await waitFor(()=>current(store)?.status==='completed');
  assert.deepEqual(store.state.bots.find(bot=>bot.id==='bot_atlas').collaborators,[]);
  assert.ok(store.state.conversations.bot_atlas.some(message=>message.role==='tool' && message.content.includes('delegation budget')));
  assert.equal(current(store).events.filter(event=>event.type==='delegation.completed').length,1);
});

test('an incomplete delegated specialist stays marked partial in its room and an incomplete coordinator cannot complete the drive',async t=>{
  let delegatedResult;
  const {engine,store,requests}=await fixture(t,async request=>{
    const coordinator=request.messages[0].content.startsWith(`You are ${store.state.bots.find(bot=>bot.id==='bot_atlas').name}`);
    if(!coordinator)return {text:'Scout only reached a partial finding.',toolCalls:[call('never-commit','memory_set',{key:'unconfirmed',value:'Must not be saved.'})],finishReason:'length'};
    if(request.messages.at(-1).role==='user')return {text:'',toolCalls:[call('ask-specialist','delegate_task',{botId:'bot_scout',task:'Verify the source before we finish.'})]};
    delegatedResult=JSON.parse(request.messages.at(-1).content);
    return {text:'The specialist response is incomplete; the review is unfinished.',toolCalls:[],finishReason:'length'};
  });
  const rooms=new Rooms(store,engine);engine.roomManager=rooms;
  await store.mutate(state=>{state.rooms.push({id:'partial-team',name:'Partial team',botIds:['bot_atlas','bot_scout'],autoCollaborate:true,maxRounds:2});});
  await rooms.start('partial-team','Coordinate a verified review with the specialist.');
  await waitFor(()=>current(store)?.status==='failed'&&!rooms.working.has('partial-team'));
  await rooms.advance('partial-team');await rooms.advance('partial-team');
  const specialist=current(store,'bot_scout'),coordinator=current(store),drive=store.state.roomDrives['partial-team'];
  assert.equal(requests.length,3);assert.equal(specialist.status,'failed');assert.equal(coordinator.status,'failed');
  assert.equal(store.state.messages.bot_atlas.find(message=>message.role==='user').content,'Coordinate a verified review with the specialist.');
  assert.equal(store.state.messages.bot_scout.find(message=>message.role==='user').content,'Verify the source before we finish.');
  assert.match(requests[0].messages.findLast(message=>message.role==='user').content,/participating in the team room "Partial team"/);
  assert.match(requests[0].messages.findLast(message=>message.role==='user').content,/New in this room since your last turn/);
  // The coordinator's room turn lives in its room conversation; its Bot Chat history is untouched by a failed room turn.
  assert.equal(store.state.conversations[sessionIdFor('bot_atlas','room:partial-team')][0].role,'user');assert.equal((store.state.conversations.bot_atlas || []).length,0);
  assert.ok(requests[1].messages.findLast(message=>message.role==='user').content.includes(`A permitted teammate (${store.state.bots.find(bot=>bot.id==='bot_atlas').name}, `));
  assert.match(requests[1].messages.findLast(message=>message.role==='user').content,/\) is asking for your help/);
  assert.match(requests[1].messages.findLast(message=>message.role==='user').content,/Verify the source before we finish\./);
  assert.equal(delegatedResult.status,'failed');assert.match(delegatedResult.error,/incomplete/);
  assert.equal(delegatedResult.output,'Scout only reached a partial finding.');
  assert.equal(store.state.memory.bot_scout,undefined);
  const shared=store.state.roomMessages['partial-team'].filter(message=>message.role==='assistant');
  assert.equal(shared.length,1);assert.equal(shared[0].botId,'bot_scout');assert.equal(shared[0].runId,specialist.id);
  assert.equal(shared[0].content,'Scout only reached a partial finding.');assert.equal(shared[0].partial,true);assert.equal(shared[0].runStatus,'failed');assert.equal(shared[0].delegated,true);
  assert.equal(drive.status,'failed');assert.match(drive.error,/incomplete/);
  assert.ok(!specialist.events.some(event=>event.type==='tool.started'||event.type==='run.completed'));
  assert.ok(!coordinator.events.some(event=>event.type==='run.completed'));
});

test('model output exhaustion and step limits do not report successful completion',async t=>{
  const {engine,store}=await fixture(t,async()=>({text:'A partial answer.',toolCalls:[],finishReason:'length'}));
  await engine.start('bot_atlas','Answer a long task.');await waitFor(()=>current(store)?.status==='failed');
  assert.equal(current(store).output,'A partial answer.');assert.match(current(store).error,/incomplete/);
});

test('balanced policy allows useful private workspace writes without an approval interruption',async t=>{
  const {engine,store}=await fixture(t,async request=>request.messages.at(-1).role==='user' ? {text:'',toolCalls:[call('draft','workspace_write',{path:'draft.md',content:'# A useful draft\n'})]} : {text:'The draft is ready in your workspace.',toolCalls:[]});
  await store.mutate(state=>{state.bots[0].approvalPolicy='balanced';});
  await engine.start('bot_atlas','Create a draft.');await waitFor(()=>current(store)?.status==='completed');
  assert.equal(await fs.readFile(path.join(await getWorkspaceRoot(store,'bot_atlas'),'draft.md'),'utf8'),'# A useful draft\n');
  assert.equal(current(store).events.some(event=>event.type==='approval.request'),false);
});

test('repeated model tool calls stop at the configured step budget without claiming success',async t=>{
  const {engine,store,requests}=await fixture(t,async(_request,index)=>({text:'',toolCalls:[call(`search-${index}`,'memory_search',{query:''})]}),{maxTurns:2});
  await engine.start('bot_atlas','Search without finishing.');await waitFor(()=>current(store)?.status==='failed');
  assert.equal(requests.length,2);assert.match(current(store).error,/model-step limit/);assert.equal(store.state.messages.bot_atlas.filter(message=>message.role==='assistant').length,0);
});

test('a room mention cannot silently extend consent to unselected room members',async t=>{
  const {engine,store}=await fixture(t,async request=>request.messages.at(-1).role==='user' ? {text:'',toolCalls:[call('unselected','delegate_task',{botId:'bot_scout',task:'Get involved.'})]} : {text:'I handled my selected part alone.',toolCalls:[]});
  await store.mutate(state=>{state.rooms.push({id:'solo',name:'Room',botIds:['bot_atlas','bot_scout'],autoCollaborate:true,maxRounds:4});state.roomDrives.solo={botIds:['bot_atlas']};state.bots[0].collaborators=['bot_scout'];});
  await engine.start('bot_atlas','Only Atlas should answer.',{roomId:'solo',source:'room'});await waitFor(()=>current(store)?.status==='completed');
  assert.equal(current(store,'bot_scout'),undefined);
  assert.ok(store.state.conversations.bot_atlas.some(message=>message.role==='tool' && message.content.includes('explicitly selected collaborators')));
});

test('context compaction retains complete tool-call/result turns and current task',()=>{
  const conversation=[];
  for(let i=0;i<6;i++)conversation.push({role:'user',content:`task ${i} ${'a'.repeat(1000)}`},{role:'assistant',content:'',tool_calls:[{id:`t${i}`,type:'function',function:{name:'memory_search',arguments:'{"query":""}'}}]},{role:'tool',tool_call_id:`t${i}`,content:'data'},{role:'assistant',content:'answer'});
  const compact=compactConversation('Standing rules.',conversation,3000);
  assert.ok(compact.omitted>0);assert.equal(compact.messages[1].role,'user');assert.ok(compact.messages.some(message=>message.content?.startsWith('task 5')));
  for(const message of compact.messages.filter(message=>message.role==='tool'))assert.ok(compact.messages.some(item=>item.tool_calls?.some(call=>call.id===message.tool_call_id)));
});

test('one long turn sheds its oldest tool outputs instead of failing the task',()=>{
  const conversation=[{role:'user',content:'Research this thoroughly.'}];
  for(let i=0;i<40;i++)conversation.push({role:'assistant',content:'',tool_calls:[{id:`r${i}`,type:'function',function:{name:'http_fetch',arguments:'{}'}}]},{role:'tool',tool_call_id:`r${i}`,content:i===0?JSON.stringify({shortened:true,resultId:'result_first',preview:'x'.repeat(9000)}):`page ${i} ${'b'.repeat(9000)}`});
  const toolsOf=compact=>compact.messages.filter(message=>message.role==='tool');
  // A moderate overflow only shortens the oldest outputs; the newest stay whole.
  const moderate=compactConversation('Standing rules.',conversation,200_000),mild=toolsOf(moderate);
  assert.equal(moderate.omitted,0);assert.ok(moderate.shortened>0 && moderate.shortened<40);assert.ok(JSON.stringify(moderate.messages).length<=200_000+1000);
  assert.match(mild[0].content,/result_first[\s\S]*\[Tool output shortened to fit working context\.\]$/);assert.match(mild.at(-1).content,/^page 39 b{9000}$/);
  // A severe overflow omits the oldest outputs and keeps a retained result's handle.
  const compact=compactConversation('Standing rules.',conversation,60_000),tools=toolsOf(compact);
  assert.equal(compact.omitted,0);assert.ok(JSON.stringify(compact.messages).length<=60_000+1000);
  assert.equal(compact.messages[1].content,'Research this thoroughly.');assert.match(compact.note,/tool output\(s\) in this conversation were shortened or omitted/);assert.equal(compact.messages[0].content,'Standing rules.');
  assert.equal(tools.length,40);
  assert.match(tools[0].content,/^\[Earlier tool output omitted.*tool_result_read resultId result_first/);
  assert.match(tools.at(-1).content,/^page 39 b{3990}/);
  for(const message of tools)assert.ok(compact.messages.some(item=>item.tool_calls?.some(call=>call.id===message.tool_call_id)));
  // The stored transcript itself is never rewritten.
  assert.match(conversation[2].content,/result_first/);assert.equal(conversation[4].content.length,9007);
});

// Earlier research tasks: each turn asks, reads three long pages and answers.
function researchHistory(turns) {
  const conversation=[];
  for(let i=0;i<turns;i++) {
    conversation.push({role:'user',content:`question ${i} ${'q'.repeat(200)}`});
    for(let j=0;j<3;j++)conversation.push({role:'assistant',content:'',tool_calls:[{id:`h${i}-${j}`,type:'function',function:{name:'http_fetch',arguments:'{}'}}]},{role:'tool',tool_call_id:`h${i}-${j}`,content:j===0?JSON.stringify({shortened:true,resultId:`result_${i}`,preview:'p'.repeat(9000)}):`page ${i}-${j} ${'c'.repeat(9000)}`});
    conversation.push({role:'assistant',content:`answer ${i} ${'a'.repeat(1500)}`});
  }
  return conversation;
}

test('earlier tasks give up their tool outputs before any of the conversation is dropped',()=>{
  const conversation=researchHistory(21),users=messages=>messages.filter(message=>message.role==='user');
  const compact=compactConversation('Standing rules.',conversation,180_000),tools=compact.messages.filter(message=>message.role==='tool');
  assert.equal(compact.omitted,0);assert.equal(users(compact.messages).length,21);
  assert.equal(compact.cleared,60);assert.equal(compact.shortened,0);
  assert.ok(compact.messages.some(message=>message.content===`answer 0 ${'a'.repeat(1500)}`));
  // The current task keeps its outputs whole; earlier ones are cleared without a stale result handle.
  assert.deepEqual(tools.slice(-3).map(message=>message.content),conversation.slice(-7,-1).filter(message=>message.role==='tool').map(message=>message.content));
  for(const message of tools.slice(0,60))assert.match(message.content,/^\[Tool output from an earlier task cleared/);
  assert.ok(!tools.slice(0,60).some(message=>message.content.includes('resultId')));
  assert.match(compact.note,/60 tool output\(s\) from earlier tasks were cleared/);
  for(const message of tools)assert.ok(compact.messages.some(item=>item.tool_calls?.some(call=>call.id===message.tool_call_id)));
  // Within budget nothing is cleared.
  assert.equal(compactConversation('Standing rules.',conversation.slice(0,10),180_000).cleared,0);
});

test('clearing earlier outputs keeps the context prefix stable while a task continues',()=>{
  const conversation=researchHistory(21),before=compactConversation('Standing rules.',conversation,180_000);
  const later=compactConversation('Standing rules.',[...conversation,{role:'assistant',content:'',tool_calls:[{id:'more',type:'function',function:{name:'http_fetch',arguments:'{}'}}]},{role:'tool',tool_call_id:'more',content:'short'}],180_000);
  assert.deepEqual(later.messages.slice(1,before.messages.length),before.messages.slice(1));
});

test('the system prompt stays fixed through a task while the plan travels in an unstored turn context',async t=>{
  const {engine,store,requests}=await fixture(t,async(_request,index)=>index===1
    ? {text:'',toolCalls:[call('plan','task_plan_set',{steps:[{id:'only',title:'Answer the question',status:'completed'}]})],usage:{input_tokens:5000,input_tokens_details:{cached_tokens:0}}}
    : {text:'Answered.',toolCalls:[],usage:{input_tokens:5200,input_tokens_details:{cached_tokens:4800}}});
  await engine.start('bot_atlas','Plan, then answer.');await waitFor(()=>current(store)?.status==='completed');
  assert.equal(requests.length,2);assert.equal(requests[0].messages[0].content,requests[1].messages[0].content);
  assert.doesNotMatch(requests[0].messages[0].content,/Current run plan|Today is \d/);
  assert.match(requests[0].turnContext,/Current run plan \(progress data only\):\nnull/);
  assert.match(requests[1].turnContext,/Answer the question/);assert.match(requests[1].turnContext,/Today is \d{4}-\d\d-\d\d\./);
  assert.equal(requests[0].cacheKey,requests[1].cacheKey);assert.match(requests[0].cacheKey,/^[0-9a-f]{32}$/);assert.doesNotMatch(requests[0].cacheKey,/atlas/);
  assert.ok(!JSON.stringify(store.state.conversations.bot_atlas).includes('turn_context'));
  assert.equal(current(store).usage.cached_tokens,4800);assert.equal(current(store).usage.input_tokens,10_200);
  assert.equal(current(store).context.window,128_000);assert.equal(current(store).context.source,'default');
});

test('a separate lane keeps its own history and leaves a short record in the Bot Chat',async t=>{
  const {engine,store,requests}=await fixture(t,async(_request,index)=>({text:index===1?'Chat answer.':'Lane answer.',toolCalls:[]}));
  await engine.start('bot_atlas','Hello in the app.');await waitFor(()=>current(store)?.status==='completed');
  const lane='telegram:channel_x:555',sessionId=sessionIdFor('bot_atlas',lane);
  await engine.start('bot_atlas','Question from someone else.',{source:'telegram',lane});await waitFor(()=>current(store)?.status==='completed');
  // The other person's chat does not see the owner's conversation.
  assert.deepEqual(requests[1].messages.slice(1).map(message=>message.content),['Question from someone else.']);
  assert.equal(current(store).sessionId,sessionId);assert.equal(sessionOwner(sessionId),'bot_atlas');assert.match(sessionId,/^bot_atlas--telegram-[0-9a-f]{16}$/);
  assert.deepEqual(store.state.conversations[sessionId].map(message=>message.role),['user','assistant']);
  assert.deepEqual(store.state.sessions.map(({id,botId,kind,key})=>({id,botId,kind,key})),[{id:sessionId,botId:'bot_atlas',kind:'telegram',key:lane}]);
  // The Bot Chat keeps its own turns plus a record of the reply given elsewhere.
  const chat=store.state.conversations.bot_atlas;
  assert.deepEqual(chat.slice(0,2).map(message=>message.content),['Hello in the app.','Chat answer.']);
  assert.match(chat.at(-1).content,/^\[Elsewhere: a Telegram chat with someone else\]\nAsked: Question from someone else\.\nAnswered: Lane answer\.$/);
  assert.equal(store.state.messages.bot_atlas.filter(message=>message.role==='user').at(-1).sessionId,sessionId);
  assert.notEqual(requests[0].cacheKey,requests[1].cacheKey);
});

test('each routine run starts fresh in its own lane and carries the previous output forward',async t=>{
  const {engine,store,requests}=await fixture(t,async(_request,index)=>({text:`Report number ${index}.`,toolCalls:[]}));
  await store.mutate(state=>{state.routines.push({id:'routine_digest',name:'Morning digest',botId:'bot_atlas',prompt:'Summarize what changed.',intervalMinutes:60,enabled:false});});
  await engine.runRoutine('routine_digest');await waitFor(()=>current(store)?.status==='completed');
  await engine.runRoutine('routine_digest');await waitFor(()=>current(store)?.status==='completed' && requests.length===2);
  assert.equal(requests[0].messages.at(-1).content,'Summarize what changed.');
  const second=requests[1].messages.slice(1);
  assert.equal(second.length,1);assert.match(second[0].content,/^Summarize what changed\.\n\nThe previous run of this routine returned[\s\S]*<previous_output>\nReport number 1\.\n<\/previous_output>$/);
  const sessionId=sessionIdFor('bot_atlas','routine:routine_digest');
  assert.equal(store.state.conversations[sessionId].length,2);
  assert.deepEqual(store.state.messages.bot_atlas.filter(message=>message.role==='user').map(message=>[message.content,message.routineId]),[['Summarize what changed.','routine_digest'],['Summarize what changed.','routine_digest']]);
  assert.match(store.state.conversations.bot_atlas.at(-1).content,/^\[Elsewhere: routine "Morning digest"\]/);
});

test('room members read only what is new since their own last turn',async t=>{
  const {engine,store,requests}=await fixture(t,async request=>({text:`Reply from ${request.messages[0].content.slice(4,request.messages[0].content.indexOf(','))}.`,toolCalls:[]}));
  const rooms=new Rooms(store,engine);engine.roomManager=rooms;
  await store.mutate(state=>{state.rooms.push({id:'team',name:'Team',botIds:['bot_atlas','bot_scout']});});
  const turn=async text=>{await rooms.start('team',text);await waitFor(()=>store.state.roomDrives.team?.status==='completed' || (rooms.tick(),false),4000).catch(async()=>{for(let i=0;i<50 && store.state.roomDrives.team.status!=='completed';i++){await rooms.advance('team');await delay(10);}});};
  await turn('@all first question');await turn('@all second question');
  const prompts=requests.map(request=>request.messages.findLast(message=>message.role==='user').content),[atlasFirst,scoutFirst,atlasSecond]=prompts;
  assert.match(atlasFirst,/Latest user task:\n@all first question\n\nNew in this room since your last turn \(oldest first\):\n\(nothing besides the task above\)/);
  assert.match(scoutFirst,/New in this room[\s\S]*: Reply from/);
  // Atlas's second turn carries Scout's reply and nothing it has already seen or written itself.
  assert.match(atlasSecond,/Latest user task:\n@all second question/);
  assert.doesNotMatch(atlasSecond,/first question/);assert.equal((atlasSecond.match(/Reply from/g) || []).length,1);
  const sessionId=sessionIdFor('bot_atlas','room:team');
  assert.equal(store.state.conversations[sessionId].filter(message=>message.role==='user').length,2);
  assert.equal(store.state.sessions.find(item=>item.id===sessionId).roomSeen.id,store.state.roomMessages.team.at(-3).id);
});

test('room deltas keep the newest messages within bounds and cut one long message to an excerpt',()=>{
  const author=message=>message.role==='user'?'User':message.botId;
  const messages=Array.from({length:250},(_,i)=>({id:`m${i}`,role:i%2?'assistant':'user',botId:i%2?'bot_scout':undefined,content:`message ${i}`,createdAt:`2026-10-27T10:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}Z`}));
  let delta=roomDelta(messages,{botId:'bot_atlas',author});
  assert.equal(delta.count,200);assert.equal(delta.omitted,50);assert.match(delta.text,/^User: message 50\n\n/);
  delta=roomDelta(messages,{seen:{id:'m247'},botId:'bot_atlas',author});assert.equal(delta.text,'User: message 248\n\nbot_scout: message 249');
  // Own replies and the task shown separately are not repeated; an unknown watermark falls back to its timestamp.
  delta=roomDelta(messages,{seen:{id:'gone',createdAt:messages[245].createdAt},botId:'bot_scout',exclude:'m248',author});assert.equal(delta.text,'User: message 246');
  const long=[{id:'a',role:'user',content:'x'.repeat(20_000)},{id:'b',role:'user',content:'y'.repeat(30_000)}];
  delta=roomDelta(long,{botId:'bot_atlas',author});assert.equal(delta.count,2);assert.equal(delta.omitted,0);assert.match(delta.text,/^User: x{8000}\n\[Message shortened to fit this turn\.\]\n\nUser: y{8000}\n\[Message shortened to fit this turn\.\]$/);
  // The 32K character budget keeps the newest whole messages and counts the rest as left out.
  const wide=Array.from({length:5},(_,i)=>({id:`w${i}`,role:'user',content:String(i).repeat(7_900)}));
  delta=roomDelta(wide,{botId:'bot_atlas',author});assert.equal(delta.count,4);assert.equal(delta.omitted,1);assert.match(delta.text,/^User: 1{7900}/);
  assert.equal(telegramLane({id:'c',ownerUserId:'1'},{chat:{id:1},from:{id:1}}),'chat');
});

const longChat=turns=>Array.from({length:turns},(_,i)=>[{role:'user',content:`topic ${i} ${'u'.repeat(200)}`},{role:'assistant',content:`reply ${i} ${'r'.repeat(4000)}`}]).flat();
const summaryReply=text=>async request=>request.tools.length===0?{text,toolCalls:[]}:{text:'Answered with the summary in mind.',toolCalls:[]};

test('older turns that no longer fit are summarized by the bot model instead of dropped',async t=>{
  const history=longChat(30),{engine,store,requests}=await fixture(t,summaryReply('## Goal\nKeep the thread going.\n## Done\n- Covered the early topics.'));
  await store.mutate(state=>{state.connections[0].contextWindow=40_000;state.conversations.bot_atlas=history;});
  await engine.start('bot_atlas','Continue.');await waitFor(()=>current(store)?.status==='completed');
  assert.equal(requests.length,2);assert.equal(requests[0].tools.length,0);assert.match(requests[0].messages[0].content,/handoff summary/);assert.match(requests[0].messages[1].content,/User: topic 0 u+/);
  const sent=requests[1].messages;
  assert.match(sent[1].content,/^<conversation_summary>\nEarlier messages of this conversation \(\d+\) were compacted[\s\S]*Covered the early topics\.[\s\S]*## Earlier user messages \(verbatim, oldest first\)\n- topic 0 u+/);
  assert.equal(sent.at(-1).content,'Continue.');assert.match(sent.at(-2).content,/^reply 29 r+$/);
  assert.doesNotMatch(requests[1].turnContext,/turn\(s\) were omitted/);
  const stored=store.state.conversations.bot_atlas;
  assert.equal(stored[0].compaction,true);assert.ok(stored.length<history.length);assert.equal(stored.at(-1).content,'Answered with the summary in mind.');
  const session=store.state.sessions.find(item=>item.id==='bot_atlas');
  assert.deepEqual([session.kind,session.compactMethod,session.compactions],['chat','summary',1]);assert.match(session.summary,/Covered the early topics/);
  assert.equal(store.state.messages.bot_atlas.filter(message=>message.role==='system' && message.kind==='compaction').length,1);
  assert.ok(current(store).events.some(event=>event.type==='context.compacted' && event.method==='summary' && event.summarizedMessages>0));
});

test('a failed automatic summary falls back to a plain record instead of dropping turns',async t=>{
  const {engine,store,requests}=await fixture(t,async request=>{if(!request.tools.length)throw new HttpError(502,'OpenAI returned HTTP 500: overloaded');return {text:'Still answered.',toolCalls:[]};});
  await store.mutate(state=>{state.connections[0].contextWindow=40_000;state.conversations.bot_atlas=longChat(30);});
  await engine.start('bot_atlas','Continue.');await waitFor(()=>current(store)?.status==='completed');
  // The plain record lists recent requests and answers; the user's own messages are still quoted from the first one.
  assert.match(requests[1].messages[1].content,/^<conversation_summary>[\s\S]*## Requests\n- topic \d+ u+[\s\S]*## Answers \(excerpts\)\n- reply \d+ r+[\s\S]*## Earlier user messages \(verbatim, oldest first\)\n- topic 0 u+/);
  assert.equal(store.state.sessions.find(item=>item.id==='bot_atlas').compactMethod,'fallback');
});

test('the owner can summarize older messages or start a new topic in the same conversation',async t=>{
  const {engine,store,requests}=await fixture(t,async(request,index)=>({text:`Summary number ${index}.`,toolCalls:[]}));
  await store.mutate(state=>{state.conversations.bot_atlas=longChat(30);state.conversations.bot_nova=longChat(1);});
  assert.deepEqual(await engine.compactChat('bot_nova'),{compacted:false,reason:'The conversation is still short enough to keep as it is.'});
  const compacted=await engine.compactChat('bot_atlas');
  assert.equal(compacted.compacted,true);assert.equal(compacted.method,'summary');assert.ok(compacted.kept>=2 && compacted.kept<20);
  assert.equal(store.state.conversations.bot_atlas.length,compacted.kept+1);assert.match(store.state.conversations.bot_atlas.at(-1).content,/^reply 29/);
  // A new topic folds everything, including the earlier summary, into one background summary.
  const topic=await engine.compactChat('bot_atlas',{topic:true});
  assert.equal(topic.kept,0);assert.equal(store.state.conversations.bot_atlas.length,1);
  assert.match(store.state.conversations.bot_atlas[0].content,/started a new topic[\s\S]*Summary number 2\./);
  assert.match(requests.at(-1).messages[1].content,/^<previous_summary>\nSummary number 1\.\n<\/previous_summary>/);
  assert.match(store.state.messages.bot_atlas.at(-1).content,/^New topic\./);assert.equal(store.state.sessions.find(item=>item.id==='bot_atlas').compactions,2);
  assert.ok(store.state.activity.some(entry=>entry.type==='context.compacted'));
});

test('a manual summary that fails changes nothing, and no task starts while one is being written',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const {engine,store}=await fixture(t,async request=>{if(request.tools.length)return {text:'Done.',toolCalls:[]};await gate;throw new HttpError(502,'OpenAI returned HTTP 500: overloaded');});
  const history=longChat(30);await store.mutate(state=>{state.conversations.bot_atlas=history;});
  const pending=engine.compactChat('bot_atlas');await delay(20);
  await assert.rejects(engine.start('bot_atlas','Too early.'),/summarizing its conversation/);
  await assert.rejects(engine.compactChat('bot_atlas'),/finish its current work/);
  release();await assert.rejects(pending,/overloaded/);
  assert.equal(store.state.conversations.bot_atlas.length,60);assert.equal(store.state.sessions.some(item=>item.id==='bot_atlas'),false);
  await engine.start('bot_atlas','Now it can run.');await waitFor(()=>current(store)?.status==='completed');
});

test('a provider context overflow is compacted to the stated limit and the model step is sent once more',async t=>{
  // A long plain conversation that fits the assumed 128K window but not the model's real 64K one.
  const history=Array.from({length:30},(_,i)=>[{role:'user',content:`topic ${i} ${'u'.repeat(200)}`},{role:'assistant',content:`reply ${i} ${'r'.repeat(12_000)}`}]).flat();
  const {engine,store,requests}=await fixture(t,async(_request,index)=>{
    if(index===1)throw new HttpError(502,"OpenAI returned HTTP 400: This model's maximum context length is 64,000 tokens. However, your messages resulted in 150,000 tokens.");
    return {text:'Answered within the real window.',toolCalls:[],usage:{input_tokens:40_000,output_tokens:20}};
  });
  await store.mutate(state=>{state.connections[0].models=[{id:'test-model',name:'Test model',reasoning:{supported:false,efforts:[]}}];state.conversations.bot_atlas=history;});
  await engine.start('bot_atlas','Continue.');await waitFor(()=>current(store)?.status==='completed');
  // The learned window no longer holds the older turns, so they are summarized before the step is sent again.
  assert.equal(requests.length,3);assert.equal(requests[1].tools.length,0);
  const size=messages=>Math.ceil(Buffer.byteLength(JSON.stringify(messages))/4);
  assert.ok(size(requests[2].messages)<64_000*0.9 && size(requests[0].messages)>size(requests[2].messages));
  assert.match(requests[2].messages[1].content,/^<conversation_summary>/);
  assert.equal(requests[2].messages.filter(message=>message.role==='user').at(-1).content,'Continue.');
  assert.ok(current(store).events.some(event=>event.type==='context.overflow' && event.limit===64_000));
  assert.deepEqual(store.state.connections[0].models[0],{id:'test-model',name:'Test model',reasoning:{supported:false,efforts:[]},contextWindow:64_000,contextSource:'provider-error'});
  assert.equal(current(store).context.window,64_000);assert.equal(current(store).context.source,'provider-error');
});

test('a second context overflow in one task fails it instead of retrying again',async t=>{
  // Earlier turns give the retry something to shed; the system prompt and tools alone no longer fit the smallest learned window.
  const history=Array.from({length:12},(_,i)=>[{role:'user',content:`topic ${i}`},{role:'assistant',content:`reply ${i} ${'r'.repeat(8_000)}`}]).flat();
  const {engine,store,requests}=await fixture(t,async()=>{throw new HttpError(502,'OpenAI returned HTTP 400: The input exceeds the context window.');});
  await store.mutate(state=>{state.conversations.bot_atlas=history;});
  await engine.start('bot_atlas','Too large.');await waitFor(()=>current(store)?.status==='failed');
  // Task steps carry tools; a summary request does not. The first attempt and exactly one retry.
  assert.equal(requests.filter(request=>request.tools.length).length,2);assert.match(current(store).error,/context window/);
});

test('whole earlier turns are dropped only when cleared outputs are still not enough',()=>{
  const conversation=researchHistory(21);
  const compact=compactConversation('Standing rules.',conversation,40_000),users=compact.messages.filter(message=>message.role==='user');
  assert.ok(compact.omitted>0);assert.equal(users.at(-1).content,`question 20 ${'q'.repeat(200)}`);
  assert.ok(JSON.stringify(compact.messages).length<=40_000+1000);
  assert.equal(compact.messages[1].role,'user');assert.match(compact.note,/earlier conversation turn\(s\) were omitted/);
});

test('an approved newly learned skill can be read during the same independent agent turn',async t=>{
  const {engine,store,requests}=await fixture(t,async request=>request.messages.at(-1).role==='user' ? {text:'',toolCalls:[
    call('learn','skills_create',{name:'same-turn-review',description:'A reusable way to review a draft.',instructions:'Read the draft. Check claims. Return a concise review.'}),
    call('read-learned','skills_read',{skillId:'same-turn-review'})
  ]} : {text:'I saved the approved workflow and read it back.',toolCalls:[]});
  await engine.start('bot_atlas','Learn this reusable review workflow.');await waitFor(()=>current(store)?.status==='waiting_for_approval');
  assert.equal(store.state.skills.some(skill=>skill.id==='same-turn-review'),false);
  await engine.control('bot_atlas','approval',{...decision(current(store)),choice:'once'});
  await waitFor(()=>current(store)?.status==='completed');
  const next=requests.at(-1).messages;assert.ok(next.some(message=>message.role==='tool' && message.tool_call_id==='read-learned' && message.content.includes('Check claims')));
  // The system prompt stays as it was when the task started; the newly assigned skill is announced in the turn context.
  assert.doesNotMatch(next[0].content,/same-turn-review/);assert.match(requests.at(-1).turnContext,/Skills assigned during this task:\nsame-turn-review: A reusable way/);
  assert.equal(requests[0].messages[0].content,next[0].content);assert.ok(store.state.bots[0].skills.includes('same-turn-review'));
});

test('natural-language routine creation is approved before scheduling and dispatches through the native engine',async t=>{
  const {engine,store}=await fixture(t,async request=>{
    const last=request.messages.at(-1);
    if(last.role==='user' && last.content==='Schedule a daily review.')return {text:'',toolCalls:[call('schedule','routines_create',{name:'Daily review',prompt:'Do the review now.',intervalMinutes:1440})]};
    return {text:last.role==='user'?'Review completed with the available context.':'The approved daily review is scheduled.',toolCalls:[]};
  });
  await store.mutate(state=>{state.bots[0].tools.push('automation');});
  await engine.start('bot_atlas','Schedule a daily review.');await waitFor(()=>current(store)?.status==='waiting_for_approval');
  assert.equal(store.state.routines.length,0);
  await engine.control('bot_atlas','approval',{...decision(current(store)),choice:'once'});await waitFor(()=>current(store)?.status==='completed');
  const original=current(store).id,routineId=store.state.routines[0].id;
  await store.mutate(state=>{state.routines[0].nextRunAt=new Date(Date.now()-1000).toISOString();});
  await engine.tick();await waitFor(()=>current(store)?.id!==original && current(store)?.status==='completed');
  assert.equal(current(store).source,'routine');assert.equal(current(store).routineId,routineId);assert.equal(current(store).output,'Review completed with the available context.');
  assert.ok(Date.parse(store.state.routines[0].nextRunAt)>Date.now());
  const completed=current(store).id;await engine.tick();assert.equal(current(store).id,completed);
});
