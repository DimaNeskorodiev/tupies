import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Channels } from '../lib/channels.mjs';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnop';
const update=(id,{chat='100',user='200',text='Hello',isBot=false}={})=>({update_id:id,message:{chat:{id:Number(chat)},from:{id:Number(user),is_bot:isBot},text}});
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-channels-')),store=await new Store(directory).init();store.state.channels=[];
  const remote={updates:[],requests:[],sent:[],hold:false,failSend:false};
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw || '{}'),method=req.url.split('/').at(-1);remote.requests.push({method,body,url:req.url});
    assert.ok(req.url.startsWith(`/bot${TOKEN}/`));res.setHeader('content-type','application/json');
    if(method==='getMe'){res.end(JSON.stringify({ok:true,result:{id:123456789,is_bot:true,username:'studio_fixture_bot',first_name:'Fixture'}}));return;}
    if(method==='getUpdates'){if(remote.hold)return;res.end(JSON.stringify({ok:true,result:remote.updates.filter(item=>item.update_id>=body.offset)}));return;}
    if(method==='sendMessage'){remote.sent.push(body);if(remote.failSend){req.socket.destroy();return;}res.end(JSON.stringify({ok:true,result:{message_id:remote.sent.length}}));return;}
    res.writeHead(404);res.end(JSON.stringify({ok:false,description:'Unknown operation'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const starts=[],runtime={starting:new Set(),async start(botId,text,options){const channel=store.state.channels[0];assert.ok(channel.offset>0,'Offset must be durable before admitting a task.');const persisted=JSON.parse(await fs.readFile(store.file,'utf8'));assert.equal(persisted.channels[0].offset,channel.offset);const run={id:`run_${starts.length+1}`,remoteRunId:`run_${starts.length+1}`,status:'running',botId};starts.push({botId,text,options});await store.mutate(state=>{state.runs[botId]=run;});return run;},async poll(botId){return store.state.runs[botId];}};
  const channels=new Channels(store,runtime,{telegramApiBase:`http://127.0.0.1:${server.address().port}`,channelLongPollSeconds:0,channelPollTimeoutMs:1000,channelRequestTimeout:1000});
  t.after(async()=>{await channels.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  async function add(enabled=true){const value={...channels.validate({name:'Telegram fixture',type:'telegram',token:TOKEN,botId:'bot_atlas',enabled,allowedChatIds:['100'],allowedUserIds:['200']}),id:'channel_test'};await store.mutate(state=>state.channels.push(value));return value;}
  async function tickAndPoll(){await channels.tick();await Promise.allSettled([...channels.polls.values()]);}
  return {store,channels,remote,runtime,starts,add,tickAndPoll,server,directory};
}

test('Telegram requires explicit chat AND user allowlists and consumes unauthorized updates without executing',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.channels.validate({name:'bad',token:TOKEN,botId:'bot_atlas',enabled:true,allowedChatIds:[],allowedUserIds:['200']}),/at least one/);
  assert.throws(()=>f.channels.validate({name:'bad',token:TOKEN,botId:'bot_atlas',enabled:true,allowedChatIds:['*'],allowedUserIds:['200']}),/explicit list/);
  const channel=await f.add();
  f.remote.updates=[update(1,{user:'999'}),update(2,{chat:'999'}),update(3,{isBot:true}),update(4,{text:''})];
  await f.tickAndPoll();assert.equal(f.starts.length,0);assert.equal(f.remote.sent.length,0);assert.equal(channel.offset,5);
  assert.ok(!(await fs.readFile(f.store.file,'utf8')).includes(TOKEN));
  assert.throws(()=>f.channels.validate({name:'duplicate',token:TOKEN,botId:'bot_scout'}),/already has a channel/);
});

test('the owner’s direct messages continue the Bot Chat while other chats and group members get their own lanes',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.channels.validate({name:'owner',token:TOKEN,botId:'bot_atlas',allowedChatIds:['200'],allowedUserIds:['200'],ownerUserId:'999'}),/must also be an allowed user/);
  assert.throws(()=>f.channels.validate({name:'owner',token:TOKEN,botId:'bot_atlas',allowedChatIds:['200'],allowedUserIds:['200'],ownerUserId:'me'}),/your own Telegram user id/i);
  const value={...f.channels.validate({name:'Telegram fixture',type:'telegram',token:TOKEN,botId:'bot_atlas',enabled:true,allowedChatIds:['200','201','-300'],allowedUserIds:['200','201'],ownerUserId:'200'}),id:'channel_test'};
  await f.store.mutate(state=>state.channels.push(value));
  const lanes=[];
  for(const [index,item] of [[1,{chat:'200',user:'200'}],[2,{chat:'201',user:'201'}],[3,{chat:'-300',user:'200'}]].entries()) {
    f.remote.updates=[update(index+1,item[1])];await f.tickAndPoll();
    lanes.push(f.starts.at(-1).options.lane);
    await f.store.mutate(state=>{state.runs.bot_atlas.status='completed';state.runs.bot_atlas.output='Done.';});await f.tickAndPoll();
  }
  assert.deepEqual(lanes,['chat','telegram:channel_test:201','telegram:channel_test:-300:200']);
  assert.equal(f.channels.validate({ownerUserId:''},value).ownerUserId,undefined);
});

test('allowed Telegram task is admitted once and returns only its actual redacted result',async t=>{
  const f=await fixture(t),channel=await f.add();f.remote.updates=[update(10,{text:'Check my plan.'})];
  assert.equal((await f.channels.test(channel.id)).username,'studio_fixture_bot');
  await f.tickAndPoll();assert.equal(f.starts.length,1);assert.equal(f.starts[0].options.source,'telegram');assert.match(f.starts[0].text,/Check my plan/);assert.equal(channel.pending.runId,'run_1');assert.equal(channel.offset,11);
  await f.store.mutate(state=>{state.runs.bot_atlas.status='completed';state.runs.bot_atlas.output=`The actual result. Credential ${TOKEN}`;});
  await f.tickAndPoll();assert.equal(f.remote.sent.length,1);assert.ok(f.remote.sent[0].text.includes('The actual result.'));assert.ok(!f.remote.sent[0].text.includes(TOKEN));assert.equal(f.remote.sent[0].chat_id,'100');assert.equal(f.remote.sent[0].parse_mode,undefined);assert.equal(channel.lastDelivery.status,'sent');assert.equal(channel.pending,undefined);
  await f.tickAndPoll();assert.equal(f.starts.length,1);assert.equal(f.remote.sent.length,1);
});

test('restart never replays consumed ingress or a reply whose delivery was already claimed',async t=>{
  const f=await fixture(t),channel=await f.add();f.remote.updates=[update(7)];await f.tickAndPoll();
  await f.store.mutate(state=>{state.channels[0].pending.replyClaimedAt=new Date().toISOString();state.channels[0].lastDelivery={runId:'run_1',status:'sending'};});
  const restarted=new Channels(f.store,f.runtime,{telegramApiBase:`http://127.0.0.1:${f.server.address().port}`,channelLongPollSeconds:0});
  await restarted.recover();await restarted.tick();await Promise.allSettled([...restarted.polls.values()]);await restarted.close();
  assert.equal(channel.pending,undefined);assert.equal(channel.lastDelivery.status,'unknown');assert.equal(f.starts.length,1);assert.equal(f.remote.sent.length,0);
});

test('uncertain send is not retried and long results remain bounded',async t=>{
  const f=await fixture(t),channel=await f.add();f.remote.updates=[update(1)];await f.tickAndPoll();
  await f.store.mutate(state=>{state.runs.bot_atlas.status='completed';state.runs.bot_atlas.output='A'.repeat(20_000);});
  f.remote.failSend=true;await f.tickAndPoll();assert.equal(f.remote.sent.length,1);assert.equal(channel.lastDelivery.status,'unknown');assert.equal(channel.pending,undefined);
  await f.tickAndPoll();assert.equal(f.remote.sent.length,1);
  assert.ok(f.remote.sent[0].text.length<4000);
});

test('disabled channels make no external requests and suppress unsent task replies',async t=>{
  const f=await fixture(t),channel=await f.add(false);await f.tickAndPoll();assert.equal(f.remote.requests.length,0);
  await f.store.mutate(state=>{state.channels[0].pending={runId:'run_old',chatId:'100',userId:'200'};state.runs.bot_atlas={id:'run_old',status:'completed',output:'Do not send.'};});
  await f.tickAndPoll();assert.equal(f.remote.requests.length,0);assert.equal(channel.pending,undefined);assert.equal(channel.lastDelivery.status,'suppressed');
});

test('close aborts the owned long poll and waits for all channel activity',async t=>{
  const f=await fixture(t);await f.add();f.remote.hold=true;
  await f.channels.tick();assert.equal(f.channels.polls.size,1);
  const start=Date.now();await f.channels.close();assert.ok(Date.now()-start<500);assert.equal(f.channels.polls.size,0);assert.equal(f.channels.requests.size,0);
});

test('editing a channel cancels the old poll and a changed token resets its cursor',async t=>{
  const f=await fixture(t),channel=await f.add();
  await f.store.mutate(()=>{channel.offset=500;});
  const replacement=f.channels.validate({token:'987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnop',enabled:false},channel);assert.equal(replacement.offset,0);
  f.remote.hold=true;await f.channels.tick();assert.equal(f.channels.polls.size,1);
  await f.channels.cancel(channel.id);assert.equal(f.channels.polls.size,0);assert.equal(f.channels.requests.size,0);
  await f.store.mutate(state=>{state.channels[0]=replacement;});
  await f.channels.receive(channel.id,update(600),undefined,channel.secret);
  assert.equal(f.starts.length,0);assert.equal(f.store.state.channels[0].offset,0);
});
