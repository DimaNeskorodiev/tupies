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
import {randomBytes} from 'node:crypto';
import {generateIdentity,signMessage,PAIR_MESSAGE,SESSION_MESSAGE} from '../lib/sync/crypto.mjs';
import {OAUTH_CALLBACK_PATH} from '../lib/integration-oauth.mjs';
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
const JSON_POST={method:'POST',headers:{'Content-Type':'application/json'}};
/** A public POST whose JSON body is still arriving: only `first` is sent until the test ends or destroys it. */
function slowPost(url,route,first){
 const request=http.request(url+route,JSON_POST);
 const reply=new Promise((resolve,reject)=>{request.once('response',res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.once('end',()=>resolve({status:res.statusCode,text,cookie:res.headers['set-cookie']}));});request.once('error',reject);});
 reply.catch(()=>{});request.write(first);return {request,reply};
}
/** Resolves once the engine's handler has started on `count` more requests. */
const arrivals=(server,count)=>new Promise(resolve=>{let seen=0;const on=()=>{if(++seen===count){server.off('request',on);setImmediate(resolve);}};server.on('request',on);});
/** Holds the first store mutation whose source names `marker` (an audit kind) without holding the store queue. */
function gateMutation(store,marker){
 const original=store.mutate;let release,reached;const opened=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>reached=resolve);
 store.mutate=function(fn,...rest){if(!String(fn).includes(marker))return original.call(store,fn,...rest);store.mutate=original;reached();return opened.then(()=>original.call(store,fn,...rest));};
 return {entered,release};
}
async function claimWhenIdle(directory){let claim;const until=Date.now()+4000;do {claim=await updateControl(directory,'update-claim');if(!claim.ready)await new Promise(resolve=>setTimeout(resolve,20));} while(!claim.ready&&Date.now()<until);return claim;}
const devicePairing=(app,url,key=generateIdentity())=>{const {code}=app.sync.devices.createPairing({baseUrl:url});return {key,input:{v:1,kind:'device',code,name:'Fixture app',platform:'ios',publicKey:key.publicKey,proof:signMessage(key.privateKey,PAIR_MESSAGE(code,key.publicKey))}};};
const deviceSignIn=(app,deviceId,key)=>{const timestamp=Date.now(),nonce=randomBytes(18).toString('base64url'),engineNodeId=app.sync.nodeId,engineFingerprint=app.sync.identity.fingerprint;return {v:2,engineNodeId,engineFingerprint,deviceId,timestamp,nonce,signature:signMessage(key.privateKey,SESSION_MESSAGE(engineNodeId,engineFingerprint,deviceId,timestamp,nonce))};};
const PASSWORD='fixture-password-0001';
test('anonymous or slowly sent public requests never postpone an update; verified ones are refused while reserved',async t=>{
 const {directory,app,url}=await fixture(t),pairing=devicePairing(app,url);
 // An internet client keeps unauthenticated bodies arriving on every public sign-in, pairing and setup route.
 const arrived=arrivals(app.server,3);
 const setup=slowPost(url,'/api/setup','{"token":'),pair=slowPost(url,'/api/pair','{"v":1,'),session=slowPost(url,'/api/device/session','{"v":2,');
 await arrived;
 const claim=await updateControl(directory,'update-claim');
 try {
  assert.equal(claim.ready,true,'request bodies still arriving without a verified credential must not postpone an update');
  // Bodies completed after the reservation are verified, then refused before anything is consumed or recorded.
  setup.request.end(`${JSON.stringify(app.bootstrapToken)},"password":"${PASSWORD}"}`);
  assert.equal((await setup.reply).status,503);
  pair.request.end(JSON.stringify(pairing.input).slice('{"v":1,'.length));
  assert.equal((await pair.reply).status,503);
  session.request.destroy();
  for(const route of ['/api/setup','/api/login','/api/pair','/api/device/session'])assert.equal((await fetch(url+route,{...JSON_POST,body:'{}'})).status,503,route);
  assert.equal(app.store.state.password,null);assert.equal(app.store.state.devices?.length || 0,0);
  assert.equal((await fetch(url+'/api/engine')).status,200);assert.equal((await fetch(url+'/api/auth')).status,200);assert.equal((await fetch(url+'/api/state')).status,401);
 } finally {session.request.destroy();setup.request.destroy();pair.request.destroy();if(claim.token)await updateControl(directory,'update-release',claim.token);}
 // The refused pairing did not consume its single-use code; setup still accepts its token.
 assert.equal((await fetch(url+'/api/pair',{...JSON_POST,body:JSON.stringify(pairing.input)})).status,201);
 assert.equal((await fetch(url+'/api/setup',{...JSON_POST,body:JSON.stringify({token:app.bootstrapToken,password:PASSWORD})})).status,201);
 // A slow sign-in with the right password is not counted until verified, and gets no session while reserved.
 const loginArrived=arrivals(app.server,1),login=slowPost(url,'/api/login','{"password":');await loginArrived;
 const second=await claimWhenIdle(directory);
 try {
  assert.equal(second.ready,true,'a password sign-in still arriving must not postpone an update');
  login.request.end(`${JSON.stringify(PASSWORD)}}`);
  const refused=await login.reply;assert.equal(refused.status,503);assert.equal(refused.cookie,undefined);
 } finally {login.request.destroy();if(second.token)await updateControl(directory,'update-release',second.token);}
});
test('verified public writes still postpone an update until they are recorded, even when the client leaves',async t=>{
 const {directory,app,url}=await fixture(t);
 // Setup: the bootstrap token is verified, so recording the password holds the update until it is saved and answered.
 const setupGate=gateMutation(app.store,'security.setup');
 const setup=fetch(url+'/api/setup',{...JSON_POST,body:JSON.stringify({token:app.bootstrapToken,password:PASSWORD})});
 await setupGate.entered;
 assert.equal((await updateControl(directory,'update-claim')).ready,false,'a verified setup still being recorded must finish before an update');
 setupGate.release();assert.equal((await setup).status,201);assert.ok(app.store.state.password);
 let claim=await claimWhenIdle(directory);assert.equal(claim.ready,true);await updateControl(directory,'update-release',claim.token);
 // Pairing: the code and key proof are verified; the device record holds the update even after the app disconnects.
 const pairing=devicePairing(app,url),pairGate=gateMutation(app.store,'device.paired');
 const closed=new Promise(resolve=>app.server.once('request',(req,res)=>res.once('close',resolve)));
 const request=http.request(url+'/api/pair',JSON_POST);request.on('error',()=>{});request.end(JSON.stringify(pairing.input));
 await pairGate.entered;request.destroy();await closed;
 assert.equal((await updateControl(directory,'update-claim')).ready,false,'a verified pairing still being recorded must finish before an update');
 pairGate.release();
 claim=await claimWhenIdle(directory);
 try {assert.equal(claim.ready,true,'the hold ends with the write; a departed client cannot leave it counted');}
 finally {if(claim.token)await updateControl(directory,'update-release',claim.token);}
 const device=app.store.state.devices.find(item=>item.publicKey===pairing.key.publicKey);assert.ok(device);
 // A verified device sign-in is answered and leaves nothing counted.
 const signedIn=await fetch(url+'/api/device/session',{...JSON_POST,body:JSON.stringify(deviceSignIn(app,device.id,pairing.key))});
 assert.equal(signedIn.status,200);assert.match((await signedIn.json()).token,/^hsd_/);
 claim=await claimWhenIdle(directory);assert.equal(claim.ready,true);await updateControl(directory,'update-release',claim.token);
});
test('a verified integration sign-in callback postpones an update until its token exchange is recorded',async t=>{
 let tokenRequested,answer;const requested=new Promise(resolve=>tokenRequested=resolve);
 const provider=http.createServer(async(req,res)=>{for await(const chunk of req)void chunk;answer=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({access_token:'fixture-access-value',token_type:'Bearer',expires_in:3600,refresh_token:'fixture-refresh-value',scope:'read'}));};tokenRequested();});
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
 const origin=`http://127.0.0.1:${provider.address().port}`,{directory,app,url}=await fixture(t,{allowPrivateHttp:true});
 const setup=await fetch(url+'/api/setup',{...JSON_POST,body:JSON.stringify({token:app.bootstrapToken,password:PASSWORD})});assert.equal(setup.status,201);
 const {csrf}=await setup.json(),headers={'Content-Type':'application/json',Cookie:setup.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':csrf};
 const created=await fetch(url+'/api/integrations',{method:'POST',headers,body:JSON.stringify({name:'OAuth fixture',type:'rest',baseUrl:origin,authType:'oauth2',oauth:{authorizationUrl:`${origin}/authorize`,tokenUrl:`${origin}/token`,scopes:['read'],clientId:'fixture-client'},oauthClientSecret:'fixture-client-value',tools:[{name:'read_items',method:'GET',path:'/api/items',inputSchema:{type:'object',properties:{}}}]})});
 assert.equal(created.status,201);const integrationId=(await created.json()).id;
 const started=await fetch(url+`/api/integrations/${integrationId}/oauth/start`,{method:'POST',headers,body:'{}'});assert.equal(started.status,200);
 const state=new URL((await started.json()).authorizationUrl).searchParams.get('state');
 // A forged callback is refused at once and holds nothing.
 assert.equal((await fetch(`${url}${OAUTH_CALLBACK_PATH}?state=forged-state&code=forged`)).status,400);
 let claim=await claimWhenIdle(directory);assert.equal(claim.ready,true);await updateControl(directory,'update-release',claim.token);
 const page=fetch(`${url}${OAUTH_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=fixture-code`);
 await requested;
 assert.equal((await updateControl(directory,'update-claim')).ready,false,'a callback with a matching state holds the update during its exchange');
 answer();assert.equal((await page).status,200);
 assert.equal(app.store.state.integrations.find(item=>item.id===integrationId).oauth.connected,true);
 claim=await claimWhenIdle(directory);assert.equal(claim.ready,true);await updateControl(directory,'update-release',claim.token);
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
