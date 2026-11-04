import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createStudioServer} from '../server.mjs';
import {controlSocketPath} from '../lib/control.mjs';
import {updateControl} from '../lib/update-control.mjs';
import {UpdateMaintenance} from '../lib/update-maintenance.mjs';
async function fixture(t,options={}){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-update-control-'));const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,...options});const {url}=await app.listen(0);await app.openControl(controlSocketPath(directory),url);t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});return {directory,app,url};}
test('idle reservation is exclusive, cannot stop busy work, expires and binds exact release identity',()=>{
 let busy=true,time=0;const update=new UpdateMaintenance({busy:()=>busy,clock:()=>time});assert.equal(update.claim().ready,false);assert.equal(update.paused,false);busy=false;const reservation=update.claim();assert.equal(reservation.ready,true);assert.throws(()=>update.assertAdmission(),/preparing/);assert.throws(()=>update.claim(),/already/);assert.throws(()=>update.release('wrong'),/expired/);update.release(reservation.token);assert.equal(update.paused,false);update.claim();time=120_001;assert.equal(update.paused,false);
});
test('only the private control socket can reserve updates; chat/room/study admission shares the gate',async t=>{
 const {directory,app,url}=await fixture(t);app.runtime.starting.add('fixture');assert.equal((await updateControl(directory,'update-claim')).ready,false);app.runtime.starting.clear();const claim=await updateControl(directory,'update-claim');assert.equal(claim.ready,true);assert.equal(claim.pid,process.pid);
 await assert.rejects(app.runtime.start('missing','test'),/preparing/);await assert.rejects(app.rooms.start('missing','test'),/preparing/);assert.throws(()=>app.runtime.studies.reserve(app.store.state.bots[0].id),/preparing/);assert.equal((await fetch(url+'/api/update/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);await assert.rejects(updateControl(directory,'update-release','wrong'),/expired/);await updateControl(directory,'update-release',claim.token);assert.equal((await updateControl(directory,'update-status')).paused,false);
});
test('an idle Telegram long poll does not starve updates or consume a message during reservation',async t=>{
 let answer,requested;const pending=new Promise(resolve=>requested=resolve),api=http.createServer((req,res)=>{answer=()=>res.end(JSON.stringify({ok:true,result:[{update_id:10,message:{chat:{id:123},from:{id:456},text:'synthetic incoming request'}}]}));requested();});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{api.closeAllConnections();api.close(resolve);}));
 const {directory,app}=await fixture(t,{telegramApiBase:`http://127.0.0.1:${api.address().port}`,channelPollTimeoutMs:5000});const bot=app.store.state.bots[0];await app.store.mutate(state=>state.channels.push({id:'fixture-channel',type:'telegram',name:'Synthetic',botId:bot.id,enabled:true,secret:app.store.seal('123456:synthetic-token'),allowedChatIds:['123'],allowedUserIds:['456'],offset:0}));
 await app.channels.tick();await pending;assert.equal(app.channels.requests.size,1);const claim=await updateControl(directory,'update-claim');assert.equal(claim.ready,true);answer();await Promise.allSettled([...app.channels.polls.values()]);assert.equal(app.store.state.channels[0].offset,0);assert.equal(app.store.state.channels[0].lastDispatch,undefined);await updateControl(directory,'update-release',claim.token);
});
test('a candidate starts held and performs no automatic recovery until operator activation',async t=>{
 const {directory,app}=await fixture(t,{updateHold:true});assert.equal((await updateControl(directory,'update-status')).held,true);assert.equal(app.runtime.options.automation(),false);await assert.rejects(app.runtime.start('missing','test'),/preparing/);await updateControl(directory,'update-activate');assert.equal((await updateControl(directory,'update-status')).held,false);assert.equal(app.runtime.options.automation(),true);await assert.rejects(updateControl(directory,'update-activate'),/not awaiting/);
});
test('linked idle sync long polls do not starve updates or resume after reservation',async t=>{
 const hub=await fixture(t,{sync:{longPollMs:25_000,fileScanInterval:600_000}}),replica=await fixture(t,{sync:{longPollMs:25_000,fileScanInterval:600_000}});
 const pairing=hub.app.sync.devices.createPairing({kind:'engine',baseUrl:hub.url});await replica.app.sync.connect(pairing.link);
 const until=Date.now()+8000;while(!hub.app.sync.waiters.size&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
 assert.ok(hub.app.sync.waiters.size,'real authenticated engine exchange is waiting');
 // Pairing may still be committing initial sync writes when its first read waiter appears.
 // Retry admission until that real bootstrap activity settles; a live long poll stays open.
 let claim;const idleDeadline=Date.now()+8000;
 do {claim=await updateControl(hub.directory,'update-claim');if(!claim.ready)await new Promise(resolve=>setTimeout(resolve,20));} while(!claim.ready&&Date.now()<idleDeadline);
 try {
  assert.equal(claim.ready,true,'a settled read wait must not keep an otherwise idle home server busy');
  for(const wake of [...hub.app.sync.waiters])wake();
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal((await updateControl(hub.directory,'update-status')).paused,true);
  assert.equal(hub.app.sync.waiters.size,0,'a waking exchange cannot reenter while reserved');
 } finally {if(claim.token)await updateControl(hub.directory,'update-release',claim.token);}
});
test('public setup requests block reservation while pending and are refused while reserved',async t=>{
 const {directory,app,url}=await fixture(t);let request;
 const arrived=new Promise(resolve=>app.server.once('request',resolve));
 const finished=new Promise((resolve,reject)=>{request=http.request(url+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'}},res=>{res.resume();res.once('end',resolve);});request.once('error',reject);request.write('{"token":');});finished.catch(()=>{});
 await arrived;await new Promise(resolve=>setImmediate(resolve));
 const pending=await updateControl(directory,'update-claim');
 try {assert.equal(pending.ready,false,'an in-flight public setup must finish before an update');}
 finally {request.destroy();if(pending.token)await updateControl(directory,'update-release',pending.token);}
 await finished.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));
 const claim=await updateControl(directory,'update-claim');assert.equal(claim.ready,true);
 try {
  for(const route of ['/api/setup','/api/login','/api/pair','/api/device/session'])assert.equal((await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,503,route);
  assert.equal(app.store.state.password,null);
  assert.equal((await fetch(url+'/api/engine')).status,200);assert.equal((await fetch(url+'/api/auth')).status,200);assert.equal((await fetch(url+'/api/state')).status,401);
 } finally {await updateControl(directory,'update-release',claim.token);}
});
test('sync writes still block reservation until pushed changes finish committing',async t=>{
 const hub=await fixture(t,{sync:{longPollMs:25_000,fileScanInterval:600_000}}),replica=await fixture(t,{sync:{longPollMs:25_000,fileScanInterval:600_000}});
 await replica.app.sync.connect(hub.app.sync.devices.createPairing({kind:'engine',baseUrl:hub.url}).link);
 let entered,release;const applying=new Promise(resolve=>entered=resolve),allowed=new Promise(resolve=>release=resolve),original=hub.app.sync.applyRemote.bind(hub.app.sync),botId=replica.app.store.state.bots[0].id;let blocked=false;
 hub.app.sync.applyRemote=async(changes,options)=>{if(!blocked&&changes.some(change=>change.k===`bot:${botId}`)){blocked=true;entered();await allowed;}return original(changes,options);};
 await replica.app.store.mutate(state=>{state.bots[0].description='Synthetic pending sync write';});
 const timer=setTimeout(()=>entered(),8000);try {await applying;assert.equal(blocked,true);assert.equal((await updateControl(hub.directory,'update-claim')).ready,false);}finally{clearTimeout(timer);release();}
 const until=Date.now()+8000;while(hub.app.store.state.bots.find(bot=>bot.id===botId)?.description!=='Synthetic pending sync write'&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(hub.app.store.state.bots.find(bot=>bot.id===botId)?.description,'Synthetic pending sync write');
});
