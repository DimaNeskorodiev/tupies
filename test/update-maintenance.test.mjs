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
