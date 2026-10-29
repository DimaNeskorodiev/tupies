import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { Rooms } from '../lib/rooms.mjs';

for(const delegated of [false,true])test(`${delegated?'a delegated specialist':'a room member'} delivers its verified document in the shared room`,async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-room-artifacts-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Fixture',model:'fixture-model',secret:store.seal('disposable-fixture-key')});for(const bot of state.bots){bot.connectionId='fixture-provider';bot.tools=['workspace','delegation'];}state.rooms.push({id:'room_fixture',name:'Artifact team',botIds:['bot_atlas','bot_nova'],autoCollaborate:true,maxRounds:2});});
  const counts={},coordinator=store.state.bots.find(bot=>bot.id==='bot_atlas').name;
  const engine=new NativeEngine(store,{providers:{async complete(_connection,request){
    const parent=request.messages[0].content.startsWith(`You are ${coordinator},`),owner=parent?'bot_atlas':'bot_nova',step=counts[owner]=(counts[owner] || 0)+1;
    if(parent&&delegated&&step===1)return {text:'',toolCalls:[{id:'fixture-delegate',name:'delegate_task',arguments:{botId:'bot_nova',task:'Create the team report as a Markdown document.'}}]};
    if((!parent||!delegated)&&step===1)return {text:'',toolCalls:[{id:'fixture-document',name:'documents_create',arguments:{path:'reports/team.md',document:{title:'Team report',content:'Verified team result.'}}}]};
    return {text:'The team report is ready.',toolCalls:[]};
  }}}),rooms=new Rooms(store,engine);engine.roomManager=rooms;
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  await rooms.start('room_fixture','Create a downloadable team report.');
  const until=Date.now()+5000;
  while(Date.now()<until&&!['completed','failed'].includes(store.state.roomDrives.room_fixture.status)){await rooms.tick();await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(store.state.roomDrives.room_fixture.status,'completed',store.state.roomDrives.room_fixture.error);
  const botId=delegated?'bot_nova':'bot_atlas',run=store.state.runs[botId],reply=store.state.roomMessages.room_fixture.find(message=>message.runId===run.id&&message.role==='assistant');
  assert.ok(reply);assert.deepEqual(reply.attachments,run.artifacts);assert.equal(reply.attachments.length,1);
  assert.equal(reply.botId,botId);assert.equal(reply.attachments[0].path,'reports/team.md');
  assert.match(reply.attachments[0].downloadUrl,new RegExp(`/api/bots/${botId}/files/download`));
  assert.match(await fs.readFile(path.join(directory,'workspaces',botId,'reports/team.md'),'utf8'),/Verified team result/);
  assert.equal(store.state.roomMessages.room_fixture.filter(message=>message.runId===run.id&&message.attachments?.length).length,1,'A verified artifact is forwarded once.');
  assert.equal(reply.delegated,delegated?true:undefined);
});
