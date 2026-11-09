import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { createStudioServer } from '../server.mjs';
import { activeChatSession, archiveChatSession, chatSessionResolver, createChatSession, deleteChatSession, listChatSessions, migrateChatSessions, renameChatSession, resumeChatSession, sessionMessages } from '../lib/chat-sessions.mjs';
import { isBotChat, isChatSession, sessionKind, sessionOwner } from '../lib/sessions.mjs';
import { listDocuments, writeDocument, botOf } from '../lib/sync/docs.mjs';
import { sessionSearch } from '../lib/history.mjs';

// A fixture state shaped like a workspace from before sessions: one endless Bot Chat keyed by the bot id, a compaction
// record for it, a routine lane and a third-party Telegram lane.
function legacyState() {
  const routineLane='bot_atlas--routine-0123456789abcdef',telegramLane='bot_atlas--telegram-fedcba9876543210';
  return {
    bots:[{id:'bot_atlas',name:'Atlas',createdAt:'2026-10-01T00:00:00.000Z'},{id:'bot_quiet',name:'Quiet'}],
    messages:{bot_atlas:[
      {id:'m1',role:'user',content:'Plan the Lisbon offsite\nwith details',createdAt:'2026-11-01T09:00:00.000Z',runId:'r1',source:'chat'},
      {id:'m2',role:'assistant',content:'Here is the plan.',createdAt:'2026-11-01T09:01:00.000Z',runId:'r1'},
      {id:'m3',role:'user',content:'Morning digest',createdAt:'2026-11-02T07:00:00.000Z',runId:'r2',source:'routine',routineId:'rt',sessionId:routineLane},
      {id:'m4',role:'assistant',content:'Digest.',createdAt:'2026-11-02T07:01:00.000Z',runId:'r2'},
      {id:'m5',role:'user',content:'Private stranger request',createdAt:'2026-11-03T07:00:00.000Z',runId:'r3',source:'telegram',sessionId:telegramLane},
      {id:'m6',role:'system',kind:'compaction',content:'The earlier conversation was summarized.',createdAt:'2026-11-04T07:00:00.000Z'},
      {id:'m7',role:'user',content:'Book the flights',createdAt:'2026-11-08T10:00:00.000Z',runId:'r4',source:'chat'},
      {id:'m8',role:'assistant',content:'Flights booked as drafts.',createdAt:'2026-11-08T10:05:00.000Z',runId:'r4'},
    ]},
    conversations:{
      bot_atlas:[{role:'user',kind:'compaction_summary',content:'<conversation_summary>Goal: Lisbon offsite</conversation_summary>'},{role:'user',content:'Book the flights',sourceMessageId:'m7',runId:'r4'},{role:'assistant',content:'Flights booked as drafts.',runId:'r4'}],
      [routineLane]:[{role:'user',content:'Morning digest'}],
      [telegramLane]:[{role:'user',content:'Private stranger request'}],
    },
    sessions:[
      {id:'bot_atlas',botId:'bot_atlas',kind:'chat',key:'chat',createdAt:'2026-11-04T07:00:00.000Z',summary:'Goal: Lisbon offsite for twelve people in March.',compactedAt:'2026-11-04T07:00:00.000Z',compactions:1,compactMethod:'summary',updatedAt:'2026-11-04T07:00:00.000Z'},
      {id:routineLane,botId:'bot_atlas',kind:'routine',key:'routine:rt',createdAt:'2026-11-02T07:00:00.000Z',updatedAt:'2026-11-02T07:00:00.000Z'},
      {id:telegramLane,botId:'bot_atlas',kind:'telegram',key:'telegram:c:p',createdAt:'2026-11-03T07:00:00.000Z',updatedAt:'2026-11-03T07:00:00.000Z'},
    ],
    runs:{},
  };
}

test('migration turns the existing Bot Chat into the first session without moving data, and is idempotent',()=>{
  const state=legacyState(),before=structuredClone(state);
  assert.equal(migrateChatSessions(state),1);
  // Model history, display transcript and lanes are untouched; message kinds are preserved as they were.
  assert.deepEqual(state.conversations,before.conversations);assert.deepEqual(state.messages,before.messages);
  const record=state.sessions.find(item=>item.id==='bot_atlas');
  assert.equal(record.kind,'chat');assert.equal(record.title,'Plan the Lisbon offsite');assert.equal(record.titleSource,'auto');assert.equal(record.summary,before.sessions[0].summary);assert.equal(record.compactions,1);
  assert.equal(state.sessions.length,3,'a bot without history gets no record');
  const once=structuredClone(state);
  assert.equal(migrateChatSessions(state),0);assert.deepEqual(state,once);
  assert.equal(activeChatSession(state,'bot_atlas'),'bot_atlas');
  // A bot with history but no record gets one; a bot without any history stays without one.
  const fresh={bots:[{id:'bot_new',name:'New'}],messages:{bot_new:[{id:'x',role:'user',content:'Hello there',createdAt:'2026-11-05T00:00:00.000Z',runId:'rx'}]},conversations:{bot_new:[{role:'user',content:'Hello there'}]},sessions:[]};
  assert.equal(migrateChatSessions(fresh),1);assert.deepEqual(fresh.sessions[0],{id:'bot_new',botId:'bot_new',createdAt:'2026-11-05T00:00:00.000Z',kind:'chat',key:'chat',title:'Hello there',updatedAt:'2026-11-05T00:00:00.000Z',titleSource:'auto'});
});

test('the transcript resolves each message to its chat: requests name it, replies follow the runId, other lanes carry it',()=>{
  const state=legacyState();migrateChatSessions(state);
  const {record}=createChatSession(state,'bot_atlas');
  assert.ok(isChatSession(record.id,'bot_atlas') && sessionOwner(record.id)==='bot_atlas' && sessionKind(record.id)==='chat');
  assert.equal(isChatSession(record.id,'bot_other'),false);assert.equal(isChatSession('bot_atlas--routine-0123456789abcdef','bot_atlas'),false);
  assert.ok(isBotChat(undefined,'bot_atlas') && isBotChat('bot_atlas','bot_atlas') && isBotChat(record.id,'bot_atlas'));
  state.messages.bot_atlas.push(
    {id:'n1',role:'user',content:'Fresh question',createdAt:'2026-11-09T09:00:00.000Z',runId:'r5',source:'chat',sessionId:record.id},
    {id:'n2',role:'assistant',content:'Fresh answer',createdAt:'2026-11-09T09:01:00.000Z',runId:'r5'},
    {id:'n3',role:'user',content:'Room turn',createdAt:'2026-11-09T09:02:00.000Z',runId:'r6',source:'room',sessionId:'bot_atlas--room-aaaaaaaaaaaaaaaa',chatSessionId:record.id},
    {id:'n4',role:'assistant',content:'Room reply',createdAt:'2026-11-09T09:03:00.000Z',runId:'r6'},
  );
  const of=chatSessionResolver(state.messages.bot_atlas,'bot_atlas');
  assert.deepEqual(state.messages.bot_atlas.map(of),['bot_atlas','bot_atlas','bot_atlas','bot_atlas','bot_atlas','bot_atlas','bot_atlas','bot_atlas',record.id,record.id,record.id,record.id]);
  assert.deepEqual(sessionMessages(state.messages.bot_atlas,'bot_atlas',record.id).map(item=>item.id),['n1','n2','n3','n4']);
});

test('new, resume, rename, archive and delete keep exactly one active chat',()=>{
  const state=legacyState();migrateChatSessions(state);
  const first=createChatSession(state,'bot_atlas');
  assert.equal(first.reused,false);assert.equal(activeChatSession(state,'bot_atlas'),first.record.id);assert.deepEqual(state.conversations[first.record.id],[]);
  // The new chat points at the previous one: its title and a short digest (here the existing compaction summary).
  assert.equal(first.record.previous.id,'bot_atlas');assert.equal(first.record.previous.title,'Plan the Lisbon offsite');assert.match(first.record.previous.summary,/Lisbon offsite for twelve/);assert.ok(first.record.previous.summary.length<=600);
  // An empty active chat is reused instead of creating blanks.
  const again=createChatSession(state,'bot_atlas');assert.equal(again.reused,true);assert.equal(again.record.id,first.record.id);
  assert.equal(listChatSessions(state,'bot_atlas').filter(item=>item.active).length,1);
  resumeChatSession(state,'bot_atlas','bot_atlas');assert.equal(activeChatSession(state,'bot_atlas'),'bot_atlas');
  renameChatSession(state,'bot_atlas','bot_atlas','Offsite planning');assert.equal(listChatSessions(state,'bot_atlas')[0].title,'Offsite planning');
  assert.throws(()=>renameChatSession(state,'bot_atlas','bot_atlas',''),/title/);assert.throws(()=>resumeChatSession(state,'bot_atlas','bot_quiet--chat-0000000000000000'),/Chat not found/);
  // Archiving the active chat activates the most recent remaining one; archived chats leave the default list.
  archiveChatSession(state,'bot_atlas','bot_atlas');assert.equal(activeChatSession(state,'bot_atlas'),first.record.id);
  assert.deepEqual(listChatSessions(state,'bot_atlas').map(item=>item.id),[first.record.id]);assert.equal(listChatSessions(state,'bot_atlas',{archived:true}).length,2);
  resumeChatSession(state,'bot_atlas','bot_atlas');assert.equal(activeChatSession(state,'bot_atlas'),'bot_atlas');assert.equal(state.sessions.find(item=>item.id==='bot_atlas').archivedAt,undefined);
  // Deleting a chat removes its model history, display messages and record, and only those.
  state.messages.bot_atlas.push({id:'z1',role:'user',content:'In the new chat',createdAt:'2026-11-09T11:00:00.000Z',runId:'rz',sessionId:first.record.id},{id:'z2',role:'assistant',content:'Reply',createdAt:'2026-11-09T11:01:00.000Z',runId:'rz'});
  state.conversations[first.record.id].push({role:'user',content:'In the new chat'});
  deleteChatSession(state,'bot_atlas',first.record.id);
  assert.equal(state.conversations[first.record.id],undefined);assert.ok(!state.messages.bot_atlas.some(item=>['z1','z2'].includes(item.id)));assert.equal(state.messages.bot_atlas.length,8);
  assert.ok(!state.sessions.some(item=>item.id===first.record.id));assert.equal(state.sessions.length,3);
  // Deleting the active first chat leaves an empty history under the bot id, so a reload never rebuilds it from other lanes.
  state.taskCheckpoints={bot_atlas:{sessionId:'bot_atlas',runId:'r4'}};
  deleteChatSession(state,'bot_atlas','bot_atlas');
  assert.deepEqual(state.conversations.bot_atlas,[]);assert.equal(state.taskCheckpoints.bot_atlas,undefined);
  // Everything shown in that chat goes, including routine and Telegram messages that appeared there; their lanes keep their own model histories.
  assert.deepEqual(state.messages.bot_atlas,[]);assert.equal(state.conversations['bot_atlas--telegram-fedcba9876543210'].length,1);
  assert.equal(activeChatSession(state,'bot_atlas'),'bot_atlas');assert.equal(state.conversations['bot_atlas--routine-0123456789abcdef'].length,1);
});

test('chat records and histories replicate as ordinary session and conversation documents',()=>{
  const store={key:Buffer.alloc(32),unseal:value=>value,seal:value=>value};
  const state=legacyState();migrateChatSessions(state);const {record}=createChatSession(state,'bot_atlas');state.conversations[record.id].push({role:'user',content:'New chat request'});
  const docs=listDocuments(state,store);
  assert.deepEqual(docs.get(`session:${record.id}`),record);assert.deepEqual(docs.get(`conv:${record.id}`),[{role:'user',content:'New chat request'}]);
  assert.equal(botOf(`session:${record.id}`),'bot_atlas');assert.equal(botOf(`conv:${record.id}`),'bot_atlas');
  // A replica applying those documents computes the same active chat.
  const replica=legacyState();
  for(const [key,value] of docs)if(key.startsWith('session:') || key.startsWith('conv:'))assert.equal(writeDocument(replica,key,structuredClone(value),store),true);
  assert.equal(activeChatSession(replica,'bot_atlas'),record.id);
  // A record written by an older engine (no chat fields) does not change which chat is active.
  writeDocument(replica,'session:bot_atlas',{id:'bot_atlas',botId:'bot_atlas',kind:'chat',key:'chat',summary:'Old engine summary',compactedAt:'2026-11-09T00:00:00.000Z'},store);
  assert.equal(activeChatSession(replica,'bot_atlas'),record.id);
});

async function engineFixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-chat-sessions-')),store=await new Store(directory).init(),requests=[];
  const connection={id:'chat_provider',type:'custom',defaultModel:'fixture-model'};
  await store.mutate(state=>{state.connections.push(connection);for(const bot of state.bots){bot.connectionId=connection.id;bot.tools=['memory','workspace'];bot.approvalPolicy='balanced';}});
  const engine=new NativeEngine(store,{providers:{async complete(_connection,request){requests.push(request);const text=JSON.stringify(request.messages);return {text:`Answer ${requests.length}${text.includes('FIRST-CHAT-SECRET-77')?' (saw first chat)':''}`,toolCalls:[]};}}});
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const run=async(text,options={})=>{const started=await engine.start('bot_atlas',text,options);await engine.tasks.get(started.id);return store.state.runs.bot_atlas;};
  return {store,engine,requests,run};
}

test('a new chat runs with a fresh model history, a short pointer to the previous chat and shared memory',async t=>{
  const {store,engine,requests,run}=await engineFixture(t);
  await store.mutate(state=>{state.memory.bot_atlas=[{key:'favorite_city',value:'Lisbon',pinned:true}];});
  assert.equal((await run('Remember FIRST-CHAT-SECRET-77 for the offsite plan.')).status,'completed');
  assert.equal(activeChatSession(store.state,'bot_atlas'),'bot_atlas');assert.equal(store.state.sessions.find(item=>item.id==='bot_atlas').title,'Remember FIRST-CHAT-SECRET-77 for the offsite plan.');
  const {record}=await store.mutate(state=>createChatSession(state,'bot_atlas'));
  const second=await run('What should we do next?');
  assert.equal(second.status,'completed');assert.equal(second.sessionId,record.id);
  const request=JSON.stringify(requests.at(-1));
  // The previous chat's request is not replayed as history, but its pointer and core memory are in the reference data.
  assert.equal(requests.at(-1).messages.filter(message=>message.role!=='system' && String(message.content).includes('FIRST-CHAT-SECRET-77') && !String(message.content).includes('turn_context') && !String(message.content).startsWith('<reference_data>')).length,0);
  assert.match(request,/previousChat/);assert.match(request,/Lisbon/);
  assert.deepEqual(store.state.conversations[record.id].map(message=>message.role),['user','assistant']);
  assert.equal(store.state.conversations.bot_atlas.length,2,'the first chat keeps its own history');
  // Display messages resolve to the right chats and the new chat got its title from its first request.
  assert.deepEqual(sessionMessages(store.state.messages.bot_atlas,'bot_atlas',record.id).map(item=>item.role),['user','assistant']);
  assert.equal(store.state.sessions.find(item=>item.id===record.id).title,'What should we do next?');
  // session_search reaches the earlier chat from the new one, labelled with its title.
  const found=sessionSearch(store.state,{bot:{id:'bot_atlas'},sessionId:record.id,runId:'other'},{query:'FIRST-CHAT-SECRET-77'});
  assert.ok(found.results.length>=1);assert.equal(found.results[0].chat,'Remember FIRST-CHAT-SECRET-77 for the offsite plan.');
  // Resuming the first chat continues its own history.
  await store.mutate(state=>resumeChatSession(state,'bot_atlas','bot_atlas'));
  const third=await run('And the flights?');assert.equal(third.sessionId,undefined);assert.equal(store.state.conversations.bot_atlas.length,4);
  assert.match(JSON.stringify(requests.at(-1).messages),/FIRST-CHAT-SECRET-77/);
  // Owner compaction applies to the active chat.
  assert.equal((await engine.compactChat('bot_atlas')).compacted,false);
});

test('a routine run records which chat was active, and its bridge goes into that chat',async t=>{
  const {store,run}=await engineFixture(t);
  const {record}=await store.mutate(state=>{state.messages.bot_atlas=[{id:'seed',role:'user',content:'seed',createdAt:'2026-11-01T00:00:00.000Z',runId:'seed'}];state.conversations.bot_atlas=[{role:'user',content:'seed'}];return createChatSession(state,'bot_atlas');});
  await run('Prepare the digest.',{source:'routine',lane:'routine:digest'});
  const request=store.state.messages.bot_atlas.find(item=>item.content==='Prepare the digest.');
  assert.equal(request.chatSessionId,record.id);assert.ok(store.state.conversations[record.id].some(item=>item.sourceLane==='routine'));
  assert.ok(!store.state.conversations.bot_atlas.some(item=>item.sourceLane==='routine'));
  assert.deepEqual(sessionMessages(store.state.messages.bot_atlas,'bot_atlas',record.id).map(item=>item.role),['user','assistant']);
});

const KEY='chat-sessions-fixture-key';
const answer=text=>({id:'response-fixture',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:10,output_tokens:5}});
test('owner session routes list, create, rename, resume, read and delete chats with authentication and CSRF',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'chat-sessions-api-'));
  const provider=http.createServer(async(req,res)=>{for await(const _ of req);res.setHeader('content-type','application/json');if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;}res.end(JSON.stringify(answer('A fixture reply.')));});
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,requestTimeout:2000,runTimeout:5000});
  t.after(async()=>{await app.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0);let cookie='',csrf='';
  const request=async(route,{method='GET',data,security=true}={})=>{const response=await fetch(`${url}${route}`,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...(security&&csrf?{'X-CSRF-Token':csrf}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});const text=await response.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:response.status,body};};
  assert.equal((await request('/api/bots/bot_atlas/sessions')).status,401);
  const setupResponse=await fetch(`${url}/api/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'fixture-workspace-password'})});
  cookie=setupResponse.headers.get('set-cookie').split(';')[0];csrf=(await setupResponse.json()).csrf;
  const connection=await request('/api/connections',{method:'POST',data:{name:'Fixture',type:'openai',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:KEY,defaultModel:'fixture-model'}});assert.equal(connection.status,201,JSON.stringify(connection.body));
  const wait=async()=>{const deadline=Date.now()+4000;while(Date.now()<deadline){const run=app.store.state.runs.bot_atlas;if(['completed','failed','cancelled','interrupted'].includes(run?.status))return run;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Task did not finish.');};
  assert.equal((await request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'First chat request'}})).status,202);assert.equal((await wait()).status,'completed');
  let list=await request('/api/bots/bot_atlas/sessions');assert.equal(list.status,200);assert.equal(list.body.active,'bot_atlas');assert.equal(list.body.data[0].title,'First chat request');assert.equal(list.body.data[0].messageCount,2);
  // Mutations require the CSRF token.
  assert.equal((await request('/api/bots/bot_atlas/sessions',{method:'POST',data:{},security:false})).status,403);
  assert.equal((await request('/api/bots/bot_atlas/sessions',{method:'POST',data:{title:5}})).status,400);
  const created=await request('/api/bots/bot_atlas/sessions',{method:'POST',data:{}});assert.equal(created.status,201,JSON.stringify(created.body));
  const sessionId=created.body.session.id;assert.match(sessionId,/^bot_atlas--chat-[0-9a-f]{16}$/);
  // The default messages endpoint follows the active chat, so older clients see the new empty chat.
  let messages=await request('/api/bots/bot_atlas/messages');assert.equal(messages.body.session.id,sessionId);assert.deepEqual(messages.body.messages,[]);
  assert.equal((await request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Second chat request'}})).status,202);await wait();
  messages=await request('/api/bots/bot_atlas/messages');assert.deepEqual(messages.body.messages.map(item=>item.content),['Second chat request','A fixture reply.']);
  const earlier=await request('/api/bots/bot_atlas/messages?session=bot_atlas');assert.equal(earlier.body.session.active,false);assert.equal(earlier.body.messages[0].content,'First chat request');
  assert.deepEqual((await request('/api/bots/bot_atlas/sessions/bot_atlas/messages')).body.messages.map(item=>item.content),['First chat request','A fixture reply.']);
  assert.equal((await request(`/api/bots/bot_atlas/sessions/${sessionId}`,{method:'PATCH',data:{title:'Renamed'}})).body.session.title,'Renamed');
  assert.equal((await request(`/api/bots/bot_atlas/sessions/${sessionId}`,{method:'PATCH',data:{color:'red'}})).status,400);
  assert.equal((await request('/api/bots/bot_atlas/sessions/bot_other--chat-0000000000000000/resume',{method:'POST',data:{}})).status,404);
  assert.equal((await request('/api/bots/bot_atlas/messages?session=bot_nova')).status,404);assert.equal(earlier.body.session.title,'First chat request');
  // Switching waits while the bot works.
  await app.store.mutate(state=>{state.runs.bot_atlas={...state.runs.bot_atlas,status:'running'};});
  assert.equal((await request('/api/bots/bot_atlas/sessions/bot_atlas/resume',{method:'POST',data:{}})).status,409);
  assert.equal((await request('/api/bots/bot_atlas/sessions',{method:'POST',data:{}})).status,409);
  await app.store.mutate(state=>{state.runs.bot_atlas.status='completed';});
  const resumed=await request('/api/bots/bot_atlas/sessions/bot_atlas/resume',{method:'POST',data:{}});assert.equal(resumed.status,200);
  list=await request('/api/bots/bot_atlas/sessions');assert.equal(list.body.active,'bot_atlas');assert.deepEqual(list.body.data.map(item=>item.title),['First chat request','Renamed']);
  const deleted=await request(`/api/bots/bot_atlas/sessions/${sessionId}`,{method:'DELETE'});assert.equal(deleted.status,200);assert.equal(deleted.body.active,'bot_atlas');
  assert.equal(app.store.state.conversations[sessionId],undefined);assert.ok(!app.store.state.messages.bot_atlas.some(item=>item.content==='Second chat request'));
  // Per-bot summary threshold is validated with the other bot settings.
  assert.equal((await request('/api/bots/bot_atlas',{method:'PATCH',data:{compactThreshold:'95'}})).status,400);
  const patched=await request('/api/bots/bot_atlas',{method:'PATCH',data:{compactThreshold:'40'}});assert.equal(patched.status,200,JSON.stringify(patched.body));assert.equal(patched.body.compactThreshold,40);
  assert.equal((await request('/api/bots/bot_atlas/inference')).body.context.compactThreshold,40);
});

test('summary compaction starts at the default 55% threshold, long before the 90% request-fitting point',async t=>{
  const {store,requests,run}=await engineFixture(t);
  // About 62% of the assumed 128K window: below the old 90% point, above the new 55% one.
  const history=Array.from({length:20},(_,i)=>[{role:'user',content:`topic ${i} ${'u'.repeat(200)}`},{role:'assistant',content:`reply ${i} ${'r'.repeat(15_000)}`}]).flat();
  await store.mutate(state=>{state.conversations.bot_atlas=history;});
  assert.equal((await run('Continue.')).status,'completed');
  assert.ok(requests.some(request=>!request.tools?.length),'a summary request was made');
  assert.ok(store.state.conversations.bot_atlas.length<history.length);assert.equal(store.state.sessions.find(item=>item.id==='bot_atlas').compactions,1);
  // With a 90% threshold the same history is sent as it is.
  const second=await engineFixture(t);
  await second.store.mutate(state=>{state.conversations.bot_atlas=structuredClone(history);state.bots.find(bot=>bot.id==='bot_atlas').compactThreshold=90;});
  assert.equal((await second.run('Continue.')).status,'completed');
  assert.ok(second.requests.every(request=>request.tools?.length));assert.equal(second.store.state.conversations.bot_atlas.length,history.length+2);
});
