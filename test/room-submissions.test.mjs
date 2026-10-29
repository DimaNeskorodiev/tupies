import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { Rooms } from '../lib/rooms.mjs';
import { createStudioServer } from '../server.mjs';
import { listDocuments } from '../lib/sync/docs.mjs';

const ID='room_message_0001',roomId='room_fixture',delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const options={providers:{async complete(){return {text:'A completed room result.',toolCalls:[]};}}};
async function configure(store){await store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Fixture',model:'fixture-model',secret:store.seal('disposable-fixture-key')});for(const bot of state.bots)bot.connectionId='fixture-provider';state.rooms.push({id:roomId,name:'Fixture room',botIds:['bot_atlas','bot_nova'],autoCollaborate:true,maxRounds:2});});}
async function fixture(t){const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-room-submissions-')),store=await new Store(directory).init();await configure(store);const engine=new NativeEngine(store,options),rooms=new Rooms(store,engine);engine.roomManager=rooms;t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});return {store,engine,rooms};}
async function completed(rooms){const until=Date.now()+4000;while(Date.now()<until){await rooms.tick();if(rooms.store.state.roomDrives[roomId]?.status==='completed')return;await delay(5);}throw new Error('Room fixture did not finish.');}

test('concurrent repeats and conflicting room payloads admit exactly one drive and one user message',async t=>{
  const {store,rooms}=await fixture(t);let release;const queued=store.serialize(()=>new Promise(resolve=>{release=resolve;}));await delay(0);
  const pending=[1,2,3].map(()=>rooms.submit(roomId,'Only once.',{clientMessageId:ID}));
  await assert.rejects(rooms.submit(roomId,'Different payload.',{clientMessageId:ID}),error=>error.status===409);
  assert.equal(store.state.roomMessages[roomId]?.length || 0,0);release();await queued;
  const replies=await Promise.all(pending);assert.equal(new Set(replies.map(reply=>reply.drive.id)).size,1);assert.equal(replies.filter(reply=>reply.duplicate).length,2);
  await completed(rooms);assert.equal(store.state.roomMessages[roomId].filter(message=>message.role==='user').length,1);
  await assert.rejects(rooms.submit(roomId,'Only once.',{clientMessageId:'bad!'}),error=>error.status===400);
  assert.deepEqual(Object.keys(store.state.roomSubmissions[roomId][0]).sort(),['createdAt','digest','driveId','id']);
  assert.ok(!JSON.stringify(listDocuments({...store.state,connections:[]},{})).includes(ID),'Receipts remain engine-local.');
});

test('room receipts survive restart and return the original outcome after a newer room task',async t=>{
  const {store,engine,rooms}=await fixture(t),first=await rooms.submit(roomId,'First task.',{clientMessageId:ID});await completed(rooms);
  await rooms.submit(roomId,'Second task.',{clientMessageId:'room_message_0002'});await completed(rooms);await engine.close();
  const restartedStore=await new Store(store.directory).init(),restartedEngine=new NativeEngine(restartedStore,options),restarted=new Rooms(restartedStore,restartedEngine);restartedEngine.roomManager=restarted;await restartedEngine.recover();await restarted.recover();
  try{const repeat=await restarted.submit(roomId,'First task.',{clientMessageId:ID});assert.equal(repeat.duplicate,true);assert.equal(repeat.drive.id,first.drive.id);assert.equal(repeat.drive.status,'completed');assert.equal(restartedStore.state.roomMessages[roomId].filter(message=>message.role==='user').length,2);assert.equal(restartedEngine.tasks.size,0);}finally{await restartedEngine.close();}
});

test('refused room admission writes no receipt and new admission bounds expired and excess receipts',async t=>{
  const {store,rooms}=await fixture(t);await store.mutate(state=>{state.bots.find(bot=>bot.id==='bot_atlas').enabled=false;});
  await assert.rejects(rooms.submit(roomId,'Paused.',{clientMessageId:ID}),/paused/);assert.equal(rooms.receipt(roomId,ID),null);
  await store.mutate(state=>{state.bots.find(bot=>bot.id==='bot_atlas').enabled=true;state.roomSubmissions={[roomId]:[{id:'expired_message',digest:'expired',driveId:'old',createdAt:new Date(Date.now()-8*86_400_000).toISOString()},...Array.from({length:200},(_,index)=>({id:`retained_message_${index}`,digest:'fixture',driveId:'old',createdAt:new Date().toISOString()}))]};});
  assert.equal(rooms.receipt(roomId,'expired_message'),null);await rooms.submit(roomId,'Admitted now.',{clientMessageId:ID});assert.equal(store.state.roomSubmissions[roomId].length,200);assert.equal(store.state.roomSubmissions[roomId].at(-1).id,ID);assert.ok(!store.state.roomSubmissions[roomId].some(receipt=>receipt.id==='expired_message'));await completed(rooms);
});

test('a room removed during queued admission leaves no orphan drive, message or receipt',async t=>{
  const {store,rooms}=await fixture(t);let release;const gate=new Promise(resolve=>{release=resolve;}),removing=store.mutate(async state=>{await gate;state.rooms=state.rooms.filter(room=>room.id!==roomId);});
  const submitting=rooms.submit(roomId,'A task racing room removal.',{clientMessageId:ID});release();await removing;
  await assert.rejects(submitting,error=>error.status===409&&/changed|removed/.test(error.message));assert.equal(store.state.roomDrives[roomId],undefined);assert.equal(store.state.roomMessages[roomId],undefined);assert.equal(rooms.receipt(roomId,ID),null);assert.equal(rooms.submitting.size,0);
});

test('room HTTP submission returns a receipt, rejects conflicting IDs and removes receipts with the room',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-room-submissions-http-')),app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,...options});const {url}=await app.listen(0);let cookie='',csrf='';
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const request=async(route,{method='GET',data,authenticated=true}={})=>{const response=await fetch(`${url}${route}`,{method,headers:{...(authenticated?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  const setup=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'disposable-fixture-password'}});cookie=setup.cookie;csrf=setup.body.csrf;await configure(app.store);
  const endpoint=`/api/rooms/${roomId}`,receiptPath=`${endpoint}/submissions/${ID}`;assert.equal((await request(receiptPath,{authenticated:false})).status,401);assert.equal((await request(receiptPath)).status,404);
  const first=await request(`${endpoint}/messages`,{method:'POST',data:{text:'A reliable room task.',clientMessageId:ID}});assert.equal(first.status,202);
  const repeat=await request(`${endpoint}/messages`,{method:'POST',data:{text:'A reliable room task.',clientMessageId:ID}});assert.equal(repeat.status,200);assert.equal(repeat.body.duplicate,true);assert.equal(repeat.body.drive.id,first.body.drive.id);
  const receipt=await request(receiptPath);assert.equal(receipt.status,200);assert.equal(receipt.body.received,true);assert.equal(receipt.body.driveId,first.body.drive.id);
  assert.equal((await request(`${endpoint}/messages`,{method:'POST',data:{text:'Different.',clientMessageId:ID}})).status,409);assert.equal((await request(`${endpoint}/messages`,{method:'POST',data:{text:'Invalid ID.',clientMessageId:'bad!'}})).status,400);
  await completed(app.rooms);assert.equal((await request(endpoint,{method:'DELETE',data:{}})).status,200);assert.equal(app.store.state.roomSubmissions[roomId],undefined);
});
