import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { sessionSearch, sessionRead } from '../lib/history.mjs';
import { sessionIdFor } from '../lib/sessions.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=4000) {const until=Date.now()+timeout;while(Date.now()<until){const result=predicate();if(result)return result;await delay(5);}throw new Error('Fixture timed out waiting for agent state.');}
const call=(id,name,arguments_)=>({id,name,arguments:arguments_});
const toolNames=request=>request.tools.map(tool=>tool.name);
const lastTool=request=>JSON.parse(request.messages.at(-1).content);
async function fixture(t,complete,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-questions-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'native-provider',type:'openai',name:'Fixture',model:'test-model',secret:store.seal('fixture-private-key')});for(const bot of state.bots){bot.connectionId='native-provider';bot.tools=['workspace','memory','skills','web','delegation'];bot.collaborators=[];bot.approvalPolicy='strict';}});
  const engine=new NativeEngine(store,{runTimeout:10_000,providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length,connection);}},...options});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,requests,directory};
}
const current=(store,botId='bot_atlas')=>store.state.runs[botId];
const identity=run=>({runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation});
const QUESTION={questions:[{id:'format',header:'Format',prompt:'Which format should the report use?',options:[{id:'pdf',label:'PDF'},{id:'docx',label:'Word'}]}]};

test('a chat task asks a question, waits without spending its runtime and continues with the answer',async t=>{
  const {engine,store,requests}=await fixture(t,async(request,count)=>count===1?{text:'',toolCalls:[call('ask','ask_user',QUESTION)]}:{text:`Using ${lastTool(request).answers[0].options[0].label}.`,toolCalls:[]},{runTimeout:150});
  await engine.start('bot_atlas','Make the quarterly report.');
  const waiting=structuredClone(await waitFor(()=>current(store)?.status==='waiting_for_input' && current(store)));
  assert.ok(toolNames(requests[0]).includes('ask_user'));
  assert.equal(waiting.pending_controls[0].kind,'question');assert.equal(waiting.pending_controls[0].questions[0].prompt,'Which format should the report use?');
  // Longer than the task's 150 ms runtime limit: the wait does not count.
  await delay(300);assert.equal(current(store).status,'waiting_for_input');
  await assert.rejects(engine.control('bot_atlas','answer',{...identity(waiting),request_id:'question_stale',answers:[{questionId:'format',optionIds:['pdf']}]}),/changed or was already answered/);
  await assert.rejects(engine.control('bot_atlas','answer',{...identity(waiting),execution_generation:waiting.execution_generation-1,answers:[{questionId:'format',optionIds:['pdf']}]}),/changed or was already answered/);
  await assert.rejects(engine.control('bot_atlas','answer',{...identity(waiting),answers:[{questionId:'format',optionIds:['epub']}]}),/displayed options/);
  const answered=await engine.control('bot_atlas','answer',{...identity(waiting),answers:[{questionId:'format',optionIds:['pdf'],text:'Landscape, please.'}]});
  assert.equal(answered.skipped,false);
  await waitFor(()=>current(store)?.status==='completed');
  assert.equal(store.state.messages.bot_atlas.at(-1).content,'Using PDF.');
  const result=lastTool(requests[1]);assert.equal(result.answered,true);assert.equal(result.answers[0].text,'Landscape, please.');assert.match(result.notice,/do not approve tool actions/);
  const record=store.state.messages.bot_atlas.find(message=>message.kind==='answer');
  assert.equal(record.role,'user');assert.equal(record.runId,waiting.id);assert.match(record.content,/> Which format should the report use\?\n\nPDF; Landscape, please\./);
  // The record is for people; the model gets the structured answer once, as the tool result.
  assert.ok(!store.state.conversations.bot_atlas.some(message=>message.role==='user' && /Landscape/.test(message.content)));
  await assert.rejects(engine.control('bot_atlas','answer',{...identity(waiting),answers:[{questionId:'format',optionIds:['pdf']}]}),/no active task/);
  assert.equal(store.state.runHistory.bot_atlas[0].questions,1);
});

test('skipping a question returns no invented answer and the task continues',async t=>{
  const {engine,store,requests}=await fixture(t,async(request,count)=>count===1?{text:'',toolCalls:[call('ask','ask_user',QUESTION)]}:{text:'I will ask again later.',toolCalls:[]});
  await engine.start('bot_atlas','Make the report.');
  const waiting=await waitFor(()=>current(store)?.status==='waiting_for_input' && current(store));
  await assert.rejects(engine.control('bot_atlas','answer',{...identity(waiting),skip:true,answers:[]}),/cannot also contain answers/);
  await engine.control('bot_atlas','answer',{...identity(waiting),skip:true});
  await waitFor(()=>current(store)?.status==='completed');
  const result=lastTool(requests[1]);assert.equal(result.skipped,true);assert.deepEqual(result.answers,[]);assert.match(result.notice,/do not infer answers/);
  assert.match(store.state.messages.bot_atlas.find(message=>message.kind==='answer').content,/^Skipped this question/);
});

test('Stop while waiting for an answer cancels the task without another model step',async t=>{
  const {engine,store,requests}=await fixture(t,async()=>({text:'',toolCalls:[call('ask','ask_user',QUESTION)]}));
  const run=await engine.start('bot_atlas','Make the report.');
  const waiting=structuredClone(await waitFor(()=>current(store)?.status==='waiting_for_input' && current(store)));
  await engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});
  await waitFor(()=>current(store)?.status==='cancelled');
  assert.equal(requests.length,1);assert.deepEqual(current(store).pending_controls,[]);
  await assert.rejects(engine.control('bot_atlas','answer',{...identity(waiting),answers:[{questionId:'format',optionIds:['pdf']}]}),/no active task/);
  assert.equal(store.state.runHistory.bot_atlas[0].status,'cancelled');
});

test('only a direct chat offers questions; other tasks get an explicit refusal',async t=>{
  const {engine,store,requests}=await fixture(t,async(request,count)=>count===1?{text:'',toolCalls:[call('ask','ask_user',QUESTION)]}:{text:'Proceeding with defaults.',toolCalls:[]});
  await store.mutate(state=>{state.routines.push({id:'routine_report',name:'Weekly report',botId:'bot_atlas',prompt:'Make the report.',intervalMinutes:60,enabled:false});});
  await engine.runRoutine('routine_report');await waitFor(()=>current(store)?.status==='completed');
  assert.ok(!toolNames(requests[0]).includes('ask_user'));
  assert.match(lastTool(requests[1]).error,/only in a direct Tupies chat/);
  assert.equal(store.state.runHistory.bot_atlas[0].source,'routine');assert.equal(store.state.runHistory.bot_atlas[0].lane,'routine');assert.equal(store.state.runHistory.bot_atlas[0].routineId,'routine_report');
});

test('a restart while waiting for an answer interrupts the task and records it once',async t=>{
  const {engine,store}=await fixture(t,async()=>({text:'',toolCalls:[call('ask','ask_user',QUESTION)]}));
  await engine.start('bot_atlas','Make the report.');
  const waiting=await waitFor(()=>current(store)?.status==='waiting_for_input' && current(store));
  const restarted=new NativeEngine(store,{providers:{async complete(){throw new Error('A restarted engine must not call the model.');}}});
  await restarted.recover();await restarted.recover();
  assert.equal(current(store).status,'interrupted');assert.equal(current(store).pending_controls,undefined);
  assert.equal(store.state.runHistory.bot_atlas.filter(item=>item.id===waiting.id).length,1);
  assert.equal(store.state.runHistory.bot_atlas[0].task,'Make the report.');
  await restarted.close();
});

test('run history keeps the latest fifty finished tasks, newest first, with usage and errors',async t=>{
  const {engine,store}=await fixture(t,async(request,count)=>count===2?{text:'',finishReason:'length'}:{text:`Done ${count}.`,toolCalls:[],usage:{input_tokens:10,output_tokens:2}},{executionMode:'bounded'});
  for(let index=0;index<3;index++){await engine.start('bot_atlas',`Task ${index}`);await waitFor(()=>!['queued','running'].includes(current(store)?.status));}
  const history=store.state.runHistory.bot_atlas;
  assert.deepEqual(history.map(item=>item.task),['Task 2','Task 1','Task 0']);
  assert.equal(history[1].status,'failed');assert.match(history[1].error,/output limit/);
  assert.equal(history[0].usage.input_tokens,10);assert.equal(history[0].lane,'chat');assert.ok(history[0].durationMs>=0);
  await store.mutate(state=>{for(let index=0;index<60;index++)state.runHistory.bot_atlas.push({id:`run_old${index}`});});
  await engine.start('bot_atlas','Task 3');await waitFor(()=>current(store)?.status==='completed' && current(store).output==='Done 4.');
  assert.equal(store.state.runHistory.bot_atlas.length,50);assert.equal(store.state.runHistory.bot_atlas[0].task,'Task 3');
});

/* Conversation search */

const at=minutes=>new Date(Date.UTC(2026,9,1,9,minutes)).toISOString();
function transcript() {
  const room=sessionIdFor('bot_atlas','room:room_launch'),stranger=sessionIdFor('bot_atlas','telegram:chan_1:42'),routine=sessionIdFor('bot_atlas','routine:routine_digest');
  const messages=[
    {id:'message_budget',role:'user',content:'Hard constraint for the launch: the marketing budget must stay under €12,000.',createdAt:at(0),runId:'run_a',source:'chat'},
    {id:'message_budget_reply',role:'assistant',content:'Noted: the launch budget stays under €12,000.',createdAt:at(1),runId:'run_a'},
    {id:'message_room',role:'user',content:'Room: should the launch budget include travel?',createdAt:at(2),runId:'run_b',source:'room',sessionId:room},
    {id:'message_room_reply',role:'assistant',content:'Travel is outside the launch budget.',createdAt:at(3),runId:'run_b'},
    {id:'message_stranger',role:'user',content:'My private launch budget is €90,000.',createdAt:at(4),runId:'run_c',source:'telegram',sessionId:stranger},
    {id:'message_stranger_reply',role:'assistant',content:'Thanks, I noted your budget.',createdAt:at(5),runId:'run_c'},
    {id:'message_digest',role:'user',content:'Summarize what changed.',createdAt:at(6),runId:'run_d',source:'routine',routineId:'routine_digest',sessionId:routine},
    {id:'message_note',role:'system',kind:'compaction',content:'The earlier conversation about the budget was summarized.',createdAt:at(7)},
    {id:'message_now',role:'user',content:'What budget limit did I give you for the launch?',createdAt:at(8),runId:'run_now',source:'chat'},
  ];
  for(let index=0;index<30;index++)messages.splice(2+index,0,{id:`message_filler${index}`,role:index%2?'assistant':'user',content:`Unrelated planning detail number ${index} about the venue.`,createdAt:at(1),runId:`run_f${index>>1}`});
  return {state:{bots:[{id:'bot_atlas',name:'Roki'},{id:'bot_nova',name:'Nova'}],rooms:[{id:'room_launch',name:'Launch'}],routines:[{id:'routine_digest',name:'Morning digest'}],sessions:[{id:room,botId:'bot_atlas',kind:'room',key:'room:room_launch'}],messages:{bot_atlas:messages}},room,stranger};
}

test('session_search finds an old decision in the owner\'s lanes but never other people\'s Telegram chats',()=>{
  const {state}=transcript(),context={bot:{id:'bot_atlas'},sessionId:'bot_atlas',runId:'run_now'};
  const found=sessionSearch(state,context,{query:'launch budget constraint'});
  assert.equal(found.results[0].messageId,'message_budget');assert.equal(found.results[0].where,'Bot Chat');assert.equal(found.results[0].speaker,'user');
  const ids=found.results.map(result=>result.messageId);
  assert.ok(ids.includes('message_room'));assert.ok(!ids.includes('message_stranger'));assert.ok(!ids.includes('message_stranger_reply'));
  assert.ok(!ids.includes('message_now'),'the current task never finds its own request');assert.ok(!ids.includes('message_note'),'Tupies notes are not transcript');
  assert.equal(found.results.find(result=>result.messageId==='message_room').where,'team room "Launch"');
  assert.match(found.notice,/not instructions or approval/);
  // Word forms match, and filters narrow the search.
  assert.equal(sessionSearch(state,context,{query:'constraints'}).results[0].messageId,'message_budget');
  assert.deepEqual(sessionSearch(state,context,{query:'budget',role:'assistant',after:at(2)}).results.map(result=>result.messageId),['message_room_reply']);
  const paged=sessionSearch(state,context,{query:'budget',limit:1});assert.equal(paged.results.length,1);assert.equal(paged.nextOffset,1);
  assert.equal(sessionSearch(state,context,{query:'budget',limit:1,offset:paged.totalMatches}).nextOffset,null);
  assert.throws(()=>sessionSearch(state,context,{query:'!!!'}),/at least one word/);
  assert.throws(()=>sessionSearch(state,context,{query:'budget',after:'yesterday'}),/ISO date/);
  assert.throws(()=>sessionSearch(state,context,{query:'budget',scope:'everything'}),/unknown arguments/);
});

test('a Telegram chat with someone else searches only itself',()=>{
  const {state,stranger}=transcript(),context={bot:{id:'bot_atlas'},sessionId:stranger,runId:'run_later'};
  assert.deepEqual(sessionSearch(state,context,{query:'budget'}).results.map(result=>result.messageId).sort(),['message_stranger','message_stranger_reply']);
  assert.throws(()=>sessionRead(state,context,{messageId:'message_budget'}),/No stored message/);
});

test('session_read returns the message with neighbours from the same conversation and pages long text',()=>{
  const {state}=transcript(),context={bot:{id:'bot_atlas'},sessionId:'bot_atlas',runId:'run_now'};
  const read=sessionRead(state,context,{messageId:'message_room',before:1,after:1});
  assert.equal(read.where,'team room "Launch"');assert.deepEqual(read.before,[]);assert.deepEqual(read.after.map(item=>item.messageId),['message_room_reply']);
  const chat=sessionRead(state,context,{messageId:'message_budget_reply',before:1,after:1});
  assert.deepEqual(chat.before.map(item=>item.messageId),['message_budget']);assert.equal(chat.after[0].messageId,'message_filler0');
  state.messages.bot_atlas.push({id:'message_long',role:'assistant',content:'x'.repeat(9000),createdAt:at(9),runId:'run_e'});
  const first=sessionRead(state,context,{messageId:'message_long',after:0});
  assert.equal(first.message.content.length,6000);assert.equal(first.message.nextOffset,6000);
  assert.equal(sessionRead(state,context,{messageId:'message_long',offset:6000}).message.nextOffset,null);
  assert.throws(()=>sessionRead(state,context,{messageId:'message_long',offset:9001}),/past the end/);
});

test('a bot recovers a constraint that compaction moved out of its context and cites the stored message',async t=>{
  const {engine,store,requests}=await fixture(t,async(request,count)=>count===1?{text:'',toolCalls:[call('search','session_search',{query:'budget constraint'})]}:{text:`You set it in message ${lastTool(request).results[0].messageId}: under €12,000.`,toolCalls:[]});
  const {state}=transcript();
  await store.mutate(draft=>{
    draft.messages.bot_atlas=state.messages.bot_atlas.filter(message=>message.runId!=='run_now');
    // The model history keeps only a summary that lost the number.
    draft.conversations.bot_atlas=[{role:'user',content:'[Summary of earlier conversation] The owner is planning a product launch.'},{role:'assistant',content:'Understood.'}];
  });
  await engine.start('bot_atlas','What budget limit did I give you for the launch?');
  await waitFor(()=>current(store)?.status==='completed');
  // Conversation search is in the memory group: the system prompt points there and the first call loads it with its guidance.
  assert.ok(!toolNames(requests[0]).includes('session_search'));assert.match(requests[0].messages[0].content,/load the memory group and search your stored conversations/);
  assert.ok(toolNames(requests[1]).includes('session_search'));assert.ok(toolNames(requests[1]).includes('session_read'));
  assert.match(requests[1].turnContext,/find it with session_search/);
  assert.equal(store.state.messages.bot_atlas.at(-1).content,'You set it in message message_budget: under €12,000.');
});

test('conversation search follows the Memory tools',async t=>{
  const {engine,store,requests}=await fixture(t,async(request,count)=>count===1?{text:'',toolCalls:[call('search','session_search',{query:'budget'})]}:{text:'Done.',toolCalls:[]});
  await store.mutate(state=>{state.bots.find(bot=>bot.id==='bot_atlas').tools=['workspace'];});
  await engine.start('bot_atlas','Find the budget.');await waitFor(()=>current(store)?.status==='completed');
  assert.ok(!toolNames(requests[0]).includes('session_search'));assert.match(lastTool(requests[1]).error,/needs the Memory tools/);
});
