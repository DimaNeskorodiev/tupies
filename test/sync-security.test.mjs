import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Store,atomicWrite } from '../lib/store.mjs';
import { Sync } from '../lib/sync/index.mjs';
import { validateSecurityRecord } from '../lib/sync/security.mjs';
import { createStudioServer } from '../server.mjs';
import { Clock } from '../lib/sync/clock.mjs';
import { generateIdentity,fingerprint,signMessage,verifyMessage,SESSION_MESSAGE,SESSION_REVOKED_MESSAGE,PAIR_MESSAGE,ENGINE_PAIR_MESSAGE,ENGINE_PAIR_CONTEXT,WRAPPED_KEY_PROOF,SYNC_KEY_CONTEXT,wrapWorkspaceKey,unwrapWorkspaceKey,sealJson,openJson,keyId } from '../lib/sync/crypto.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(predicate){const until=Date.now()+8000;while(Date.now()<until){if(await predicate())return;await delay(20);}throw new Error('Secure sync fixture timed out.');}
async function local(t,options={}){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-sync-security-')),store=await new Store(directory).init(),sync=await new Sync(store,{logErrors:false,...options}).init();let closed=false;
  const close=async()=>{if(!closed){closed=true;await sync.close();}};t.after(async()=>{await close();await fs.rm(directory,{recursive:true,force:true});});return {directory,store,sync,close};
}
const signed=(sync,deviceId,key)=>{const timestamp=Date.now(),nonce=randomBytes(18).toString('base64url'),engineNodeId=sync.nodeId,engineFingerprint=sync.identity.fingerprint;return {v:2,engineNodeId,engineFingerprint,deviceId,timestamp,nonce,signature:signMessage(key.privateKey,SESSION_MESSAGE(engineNodeId,engineFingerprint,deviceId,timestamp,nonce))};};
async function appPair(sync,key=generateIdentity()){
  const {code}=sync.devices.createPairing({baseUrl:'http://127.0.0.1'}),result=await sync.devices.pair({v:1,kind:'device',code,name:'Fixture app',platform:'ios',publicKey:key.publicKey,proof:signMessage(key.privateKey,PAIR_MESSAGE(code,key.publicKey))});return {key,result};
}
async function enginePair(sync,{nodeId=`node_${randomBytes(8).toString('hex')}`,key=generateIdentity(),ephemeral=generateIdentity()}={}){
  const {code,link}=sync.devices.createPairing({kind:'engine',baseUrl:'http://127.0.0.1'}),input={v:2,kind:'engine',code,name:'Fixture engine',platform:'engine',hubNodeId:sync.nodeId,hubFingerprint:sync.identity.fingerprint,nodeId,publicKey:key.publicKey,ephemeralKey:ephemeral.publicKey};input.proof=signMessage(key.privateKey,ENGINE_PAIR_MESSAGE(code,input.hubNodeId,input.hubFingerprint,nodeId,key.publicKey,ephemeral.publicKey));
  const result=await sync.devices.pair(input),context=ENGINE_PAIR_CONTEXT({...input,engineEphemeralKey:result.ephemeralKey,deviceId:result.deviceId,workspaceId:result.workspaceId,epoch:result.epoch,keyId:result.keyId});return {input,result,context,key,ephemeral,link};
}
function session(sync,pair){const issued=sync.devices.session(signed(sync,pair.result.deviceId,pair.key));return sync.devices.authenticate(`Bearer ${issued.token}`);}
const keyRequest=sync=>({v:2,engineNodeId:sync.nodeId,engineFingerprint:sync.identity.fingerprint,nonce:randomBytes(24).toString('base64url')});

test('device session v2 binds both target identity fields and refuses v1 without consuming a valid v2 nonce',async t=>{
  const a=await local(t),b=await local(t),paired=await appPair(a.sync),record=structuredClone(a.store.state.devices[0]);await b.store.mutate(state=>state.devices.push(record));
  const input=signed(a.sync,paired.result.deviceId,paired.key);
  assert.throws(()=>a.sync.devices.session({...input,v:1}),error=>error.status===426);assert.throws(()=>b.sync.devices.session(input),error=>error.status===401);
  assert.throws(()=>b.sync.devices.session({...input,engineNodeId:b.sync.nodeId,engineFingerprint:b.sync.identity.fingerprint}),error=>error.status===401);
  assert.match(a.sync.devices.session(input).token,/^hsd_/);assert.throws(()=>a.sync.devices.session(input),error=>error.status===401);
  assert.match(b.sync.devices.session(signed(b.sync,paired.result.deviceId,paired.key)).token,/^hsd_/);
});

test('question and teammate waits retain engine ownership in synced bot presence',async t=>{
  const {sync,store}=await local(t);for(const status of ['waiting_for_input','waiting_for_delegate']){await store.mutate(state=>{state.runs.bot_atlas={id:'run_waiting',status,createdAt:new Date().toISOString()};});assert.deepEqual(sync.activeBots(),['bot_atlas']);assert.equal(sync.presence().active.bot_atlas.runId,'run_waiting');assert.equal(sync.locallyActive('bot_atlas'),true);}
});

test('engine pairing uses signed ephemeral ECDH; a public/code transcript cannot unwrap its group key',async t=>{
  const {sync}=await local(t),paired=await enginePair(sync);
  assert.equal(new URL(paired.link).searchParams.get('v'),'2');assert.ok(verifyMessage(sync.identity.publicKey,WRAPPED_KEY_PROOF(paired.context,paired.result.workspaceKey),paired.result.engineProof));
  assert.deepEqual(unwrapWorkspaceKey(paired.ephemeral.privateKey,paired.result.ephemeralKey,paired.context,paired.result.workspaceKey),sync.workspaceKey);
  assert.throws(()=>unwrapWorkspaceKey(generateIdentity().privateKey,paired.result.ephemeralKey,paired.context,paired.result.workspaceKey),/authenticated/);
  for(const context of [paired.context.replace(paired.input.nodeId,'node_wrong'),paired.context.replace(`"${paired.result.epoch}"`,'"999"'),`${paired.context}changed`])if(context!==paired.context)assert.equal(verifyMessage(sync.identity.publicKey,WRAPPED_KEY_PROOF(context,paired.result.workspaceKey),paired.result.engineProof),false);
  const legacy=sync.devices.createPairing({kind:'engine',baseUrl:'http://127.0.0.1'});await assert.rejects(sync.devices.pair({...paired.input,v:1,code:legacy.code}),error=>error.status===426);
  await assert.rejects(sync.devices.pair({...paired.input,code:legacy.code,hubNodeId:'node_wrong'}),error=>error.status===403);
});

test('journal replacement atomically rotates/revokes and startup repairs a stale workspace-key mirror',async t=>{
  const fixture=await local(t),{sync,store,directory}=fixture,paired=await enginePair(sync),deviceId=paired.result.deviceId,before=Buffer.from(sync.workspaceKey),oldEpoch=sync.security.record.epoch;
  const write=sync.security.write;sync.security.write=async()=>{throw new Error('Fixture failure before replacement');};
  await assert.rejects(sync.devices.revoke(deviceId),/before replacement/);assert.deepEqual(sync.workspaceKey,before);assert.ok(sync.devices.find(deviceId));
  sync.security.write=async(file,bytes)=>{if(file.endsWith('workspace.key'))throw new Error('Fixture crash after journal replacement');return write(file,bytes);};
  await assert.rejects(sync.devices.revoke(deviceId),/after journal replacement/);assert.equal(sync.security.record.epoch,oldEpoch+1);assert.equal(sync.devices.find(deviceId),undefined);assert.notDeepEqual(sync.workspaceKey,before);assert.deepEqual(await fs.readFile(path.join(directory,'sync/workspace.key')),before);
  assert.deepEqual(validateSecurityRecord(store,JSON.parse(await fs.readFile(path.join(directory,'sync/security.json'),'utf8'))).key,sync.workspaceKey,'Read-only backup validation uses the canonical journal, not the stale mirror.');
  await fixture.close();const restoredStore=await new Store(directory).init(),restored=await new Sync(restoredStore,{logErrors:false}).init();
  try{assert.deepEqual(await fs.readFile(path.join(directory,'sync/workspace.key')),restored.workspaceKey);assert.equal(restored.devices.find(deviceId),undefined);assert.ok(restoredStore.state.devices.find(device=>device.id===deviceId).revokedAt);assert.equal(restored.nodeId,sync.nodeId);assert.equal(restored.identity.publicKey,sync.identity.publicKey);assert.equal(restoredStore.state.bots.length,store.state.bots.length);}finally{await restored.close();}
});

test('missing secure journal or identity fails closed instead of regenerating engine trust',async t=>{
  for(const name of ['security.json','identity.json']){const fixture=await local(t);await fixture.close();await fs.rm(path.join(fixture.directory,'sync',name));const store=await new Store(fixture.directory).init();await assert.rejects(new Sync(store,{logErrors:false}).init(),/missing|Restore/);assert.equal(await fs.access(path.join(fixture.directory,'sync',name)).then(()=>true,()=>false),false);}
});

test('a committed journal remains authoritative when directory durability acknowledgement fails',async t=>{
  const {sync,directory}=await local(t),paired=await enginePair(sync),before=Buffer.from(sync.workspaceKey);
  sync.security.write=async(file,bytes)=>{await atomicWrite(file,bytes);throw Object.assign(new Error('Fixture directory sync failure after replacement'),{journalCommitted:true});};
  await assert.rejects(sync.devices.revoke(paired.result.deviceId),/after replacement/);assert.equal(sync.devices.find(paired.result.deviceId),undefined);assert.notDeepEqual(sync.workspaceKey,before);assert.equal(JSON.parse(await fs.readFile(path.join(directory,'sync/security.json'),'utf8')).epoch,sync.security.record.epoch);
});

test('legacy engine upgrade preserves workspace and node identity but requires explicit secure relinking',async t=>{
  const fixture=await local(t),{directory,sync}=fixture;await fixture.close();const identityFile=path.join(directory,'sync/identity.json'),identity=JSON.parse(await fs.readFile(identityFile,'utf8'));delete identity.securityProtocol;await atomicWrite(identityFile,JSON.stringify(identity));await fs.rm(path.join(directory,'sync/security.json'));const oldKey=await fs.readFile(path.join(directory,'sync/workspace.key'));
  await atomicWrite(path.join(directory,'sync/config.json'),JSON.stringify({hub:{url:'http://127.0.0.1:1',nodeId:'node_legacy',deviceId:'dev_legacy',fingerprint:generateIdentity().fingerprint}}));
  const store=await new Store(directory).init(),upgraded=await new Sync(store,{logErrors:false}).init();try{assert.equal(upgraded.nodeId,sync.nodeId);assert.equal(upgraded.identity.publicKey,sync.identity.publicKey);assert.equal(store.state.bots.length,3);assert.equal(upgraded.peer,null);assert.match(upgraded.status().hub.error,/re-link/);assert.notDeepEqual(upgraded.workspaceKey,oldKey);await assert.rejects(upgraded.peerSession(),error=>error.status===426);}finally{await upgraded.close();}
});

test('concurrent engine admission and revocation retain the new peer grant and rotate exactly once',async t=>{
  const {sync}=await local(t),first=await enginePair(sync),initial=sync.security.record.epoch;
  const [second]=await Promise.all([enginePair(sync),sync.devices.revoke(first.result.deviceId)]);assert.equal(sync.security.record.epoch,initial+1);assert.equal(sync.devices.find(first.result.deviceId),undefined);assert.ok(sync.devices.find(second.result.deviceId));
  const request=keyRequest(sync),bundle=await sync.keyForPeer(session(sync,second),request),context=SYNC_KEY_CONTEXT(bundle);assert.equal(bundle.epoch,sync.security.record.epoch);assert.ok(verifyMessage(sync.identity.publicKey,WRAPPED_KEY_PROOF(context,bundle.wrapped),bundle.proof));assert.deepEqual(unwrapWorkspaceKey(second.key.privateKey,sync.identity.publicKey,context,bundle.wrapped),sync.workspaceKey);
});

test('synced engine aliases and revoked/tombstoned grant edits cannot regain sync or key access',async t=>{
  const {sync,store}=await local(t),paired=await enginePair(sync),cached=session(sync,paired),deviceId=paired.result.deviceId,original=structuredClone(store.state.devices.find(device=>device.id===deviceId));await sync.devices.revoke(deviceId);await sync.scan();
  const clock=new Clock('node_stale',()=>Date.now()+1000),revived={...original};delete revived.revokedAt;
  await sync.applyRemote([{k:`device:${deviceId}`,v:null,h:clock.now(),o:'node_stale'},{k:`device:${deviceId}`,v:revived,h:clock.now(),o:'node_stale'},{k:'device:dev_alias',v:{...revived,id:'dev_alias'},h:clock.now(),o:'node_stale'}]);
  await sync.applyRemote([{k:`presence:${original.nodeId}`,v:{name:'Removed engine',active:{bot_atlas:{runId:'old'}}},h:clock.now(),o:'node_stale'}]);assert.equal(sync.busyElsewhere('bot_atlas'),null);assert.ok(!sync.engines().some(engine=>engine.nodeId===original.nodeId));
  assert.equal(sync.devices.find(deviceId),undefined);assert.equal(sync.devices.find('dev_alias'),undefined);assert.ok(store.state.devices.find(device=>device.id===deviceId).revokedAt);await assert.rejects(sync.keyForPeer(cached,keyRequest(sync)),error=>error.status===401);
});

test('an app revocation survives synced deletion/revival and concurrent same-workspace key recovery',async t=>{
  const {sync,store}=await local(t),paired=await appPair(sync),deviceId=paired.result.deviceId,original=structuredClone(store.state.devices.find(device=>device.id===deviceId)),epoch=sync.security.record.epoch;
  await Promise.all([sync.devices.revoke(deviceId),sync.security.adopt(sync.security.record,Buffer.from(sync.workspaceKey))]);assert.equal(sync.security.record.epoch,epoch,'Removing an app does not rotate the engine group key.');await sync.scan();
  const clock=new Clock('node_stale',()=>Date.now()+1000);await sync.applyRemote([{k:`device:${deviceId}`,v:null,h:clock.now(),o:'node_stale'},{k:`device:${deviceId}`,v:original,h:clock.now(),o:'node_stale'}]);assert.equal(sync.devices.find(deviceId),undefined);assert.ok(store.state.devices.find(device=>device.id===deviceId).revokedAt);assert.throws(()=>sync.devices.session(signed(sync,deviceId,paired.key)),error=>error.status===401);
});

test('key recovery binds target, peer, nonce, epoch and workspace; stale/conflicting versions cannot roll back',async t=>{
  const {sync}=await local(t),a=await enginePair(sync),b=await enginePair(sync),request=keyRequest(sync),bundle=await sync.keyForPeer(session(sync,a),request),context=SYNC_KEY_CONTEXT(bundle);
  await assert.rejects(sync.keyForPeer(session(sync,a),{...request,engineNodeId:'node_wrong'}),error=>error.status===400);
  assert.throws(()=>unwrapWorkspaceKey(b.key.privateKey,sync.identity.publicKey,context,bundle.wrapped),/authenticated/);
  for(const changed of [{...bundle,nonce:'another_nonce_12345678'},{...bundle,nodeId:b.input.nodeId},{...bundle,epoch:bundle.epoch+1}])assert.equal(verifyMessage(sync.identity.publicKey,WRAPPED_KEY_PROOF(SYNC_KEY_CONTEXT(changed),bundle.wrapped),bundle.proof),false);
  const key=Buffer.from(sync.workspaceKey);await sync.devices.revoke(b.result.deviceId);await assert.rejects(sync.security.adopt(bundle,key),/roll back/);
  const conflicting=randomBytes(32);await assert.rejects(sync.security.adopt({...sync.security.record,keyId:keyId(conflicting)},conflicting),/conflicting/);await assert.rejects(sync.security.adopt({...sync.security.record,workspaceId:randomBytes(18).toString('base64url')},sync.workspaceKey),/workspace identity/);
});

test('the actual replica recovery path rejects a replayed nonce and a valid wrapper for another peer',async t=>{
  const hub=await local(t),replica=await local(t),paired=await enginePair(hub.sync,{nodeId:replica.sync.nodeId,key:replica.sync.identity}),other=await enginePair(hub.sync);
  const key=unwrapWorkspaceKey(paired.ephemeral.privateKey,paired.result.ephemeralKey,paired.context,paired.result.workspaceKey);await replica.sync.security.adopt(paired.result,key,{allowNewWorkspace:true});
  replica.sync.config={hub:{url:'http://127.0.0.1',protocol:2,workspaceId:paired.result.workspaceId,nodeId:hub.sync.nodeId,fingerprint:hub.sync.identity.fingerprint,publicKey:hub.sync.identity.publicKey,deviceId:paired.result.deviceId}};replica.sync.peer={token:'fixture-token',controller:new AbortController()};
  const bundle=await hub.sync.keyForPeer(session(hub.sync,paired),keyRequest(hub.sync));replica.sync.engineFetch=async()=>({ok:true,json:async()=>bundle});await assert.rejects(replica.sync.refreshWorkspaceKey(),/different engine, request or workspace/);
  replica.sync.engineFetch=async(_url,init)=>{const request=JSON.parse(init.body),wrong=await hub.sync.keyForPeer(session(hub.sync,other),request);return {ok:true,json:async()=>wrong};};await assert.rejects(replica.sync.refreshWorkspaceKey(),/different engine, request or workspace/);assert.deepEqual(replica.sync.workspaceKey,key);
});

test('secure engine connect refuses absent version advertisement before sending its pairing code',async t=>{
  const hub=await local(t),replica=await local(t),link=hub.sync.devices.createPairing({kind:'engine',baseUrl:'http://127.0.0.1'}).link,calls=[];
  replica.sync.engineFetch=async(url,init)=>{calls.push({url,init});return {json:async()=>({product:'hermes-studio',nodeId:hub.sync.nodeId,fingerprint:hub.sync.identity.fingerprint,publicKey:hub.sync.identity.publicKey})};};
  await assert.rejects(replica.sync.connect(link),error=>error.status===426);assert.equal(calls.length,1);assert.equal(calls[0].init.body,undefined);assert.equal(replica.sync.config.hub,null);
});

test('an offline trusted engine recovers the rotated key and catches up without letting the removed engine rejoin',async t=>{
  const servers=[];for(let i=0;i<3;i++){const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-sync-rotation-http-')),app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,sync:{longPollMs:100,fileScanInterval:200}}),{url}=await app.listen(0);servers.push({directory,app,url});}
  t.after(async()=>{for(const server of servers)await server.app.close();for(const server of servers)await fs.rm(server.directory,{recursive:true,force:true});});const [hub,removed,trusted]=servers;
  for(const peer of [removed,trusted])await peer.app.sync.connect(hub.app.sync.devices.createPairing({kind:'engine',baseUrl:hub.url}).link);
  await eventually(()=>trusted.app.sync.peerStatus.connected&&removed.app.sync.peerStatus.connected);await trusted.app.sync.stopPeer();
  await trusted.app.store.mutate(state=>{state.bots[0].title='An offline trusted edit';});await trusted.app.sync.scan();
  const removedId=removed.app.sync.config.hub.deviceId,oldKey=Buffer.from(removed.app.sync.workspaceKey),oldToken=removed.app.sync.peer.token,epoch=hub.app.sync.security.record.epoch;
  await assert.rejects(trusted.app.sync.devices.revoke(removedId),error=>error.status===503,'An offline replica cannot claim a hub revocation succeeded.');
  await hub.app.sync.devices.revoke(removedId);assert.equal(hub.app.sync.security.record.epoch,epoch+1);await removed.app.sync.stopPeer();
  const denied=await fetch(`${hub.url}/api/sync/key`,{method:'POST',headers:{Authorization:`Bearer ${oldToken}`,'Content-Type':'application/json','X-Tupies-Sync-Version':'2'},body:JSON.stringify(keyRequest(hub.app.sync))});assert.equal(denied.status,401);
  assert.throws(()=>openJson(oldKey,sealJson(hub.app.sync.workspaceKey,{future:'After revocation'},'fixture-future'),'fixture-future'),/authenticated/);
  await hub.app.store.mutate(state=>{state.memory.bot_atlas=[{id:'future_fact',key:'fixture',value:'After revocation'}];});await hub.app.sync.scan();trusted.app.sync.startPeer();
  await eventually(()=>trusted.app.sync.security.record.epoch===hub.app.sync.security.record.epoch&&hub.app.store.state.bots[0].title==='An offline trusted edit'&&trusted.app.store.state.memory.bot_atlas?.[0]?.value==='After revocation');
  assert.deepEqual(trusted.app.sync.workspaceKey,hub.app.sync.workspaceKey);assert.equal(hub.app.sync.devices.find(removedId),undefined);
  const trustedId=trusted.app.sync.config.hub.deviceId,beforeDisconnect=hub.app.sync.security.record.epoch;await trusted.app.sync.disconnect();assert.equal(hub.app.sync.devices.find(trustedId),undefined);assert.equal(hub.app.sync.security.record.epoch,beforeDisconnect+1);assert.equal(trusted.app.sync.config.hub,null);assert.equal(trusted.app.store.state.bots[0].title,'An offline trusted edit');
});

test('plain-HTTP sync refuses redirects before forwarding bodies and applies a bounded request deadline',async t=>{
  const {sync}=await local(t,{syncRequestTimeout:100}),receiver=http.createServer((_req,res)=>{receiver.requests++;res.end('{}');});receiver.requests=0;await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
  const source=http.createServer((req,res)=>{if(req.url==='/hang')return;res.writeHead(307,{Location:`http://127.0.0.1:${receiver.address().port}/capture`});res.end();});await new Promise(resolve=>source.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const server of [source,receiver]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
  const origin=`http://127.0.0.1:${source.address().port}`;assert.throws(()=>sync.engineFetch(`${origin}/redirect`,{method:'POST',body:'synthetic-private-pairing'},generateIdentity().fingerprint,true),/requires HTTPS/);assert.equal((await sync.engineFetch(`${origin}/redirect`,{method:'POST',body:'synthetic-private-pairing'})).status,307);assert.equal(receiver.requests,0);await assert.rejects(sync.engineFetch(`${origin}/hang`),error=>error.name==='TimeoutError');
});

test('only a fresh valid original engine signature obtains a durable journal-bound revocation proof',async t=>{
  const {sync,store}=await local(t),paired=await enginePair(sync),deviceId=paired.result.deviceId;await sync.devices.revoke(deviceId);
  // Synced records are not the authority for this proof, including after deletion/key replacement.
  await store.mutate(state=>{state.devices=state.devices.filter(device=>device.id!==deviceId);});
  const input=signed(sync,deviceId,paired.key);let refusal;try{sync.devices.session(input);}catch(error){refusal=error;}
  assert.equal(refusal?.code,'engine_revoked');assert.equal(refusal.revocation.nodeId,paired.input.nodeId);assert.equal(refusal.revocation.nonce,input.nonce);assert.equal(refusal.revocation.timestamp,input.timestamp);assert.equal(refusal.revocation.revokedAt,sync.security.record.revoked[deviceId]);assert.ok(verifyMessage(sync.identity.publicKey,SESSION_REVOKED_MESSAGE(refusal.revocation),refusal.revocation.proof));
  for(const invalid of [input,{...signed(sync,deviceId,paired.key),timestamp:Date.now()-600_000},{...signed(sync,deviceId,paired.key),engineNodeId:'node_wrong'},signed(sync,deviceId,generateIdentity())])assert.throws(()=>sync.devices.session(invalid),error=>!error.revocation);
  const forged=generateIdentity();await store.mutate(state=>state.devices.push({id:deviceId,kind:'engine',protocolVersion:2,nodeId:'node_forged',publicKey:forged.publicKey,fingerprint:forged.fingerprint}));assert.throws(()=>sync.devices.session(signed(sync,deviceId,forged)),error=>!error.revocation);
});

test('unsigned, forged, stale, wrong-target and wrong-request revocation refusals cannot finish local unlink',async t=>{
  const hub=await local(t),copy=await local(t),paired=await enginePair(hub.sync,{nodeId:copy.sync.nodeId,key:copy.sync.identity}),hubConfig={protocol:2,url:'http://127.0.0.1',workspaceId:paired.result.workspaceId,nodeId:hub.sync.nodeId,fingerprint:hub.sync.identity.fingerprint,publicKey:hub.sync.identity.publicKey,deviceId:paired.result.deviceId};
  copy.sync.config={hub:hubConfig};copy.sync.peer={token:'fixture-expired-bearer',tokenExpires:Date.now()+3_600_000,controller:new AbortController()};
  for(const change of ['unsigned','forged','device','node','hub','fingerprint','nonce','timestamp','futureRevocation']){
    copy.sync.engineFetch=async(url,init)=>{
      if(url.endsWith('/api/sync/revoke-engine'))return {ok:false,status:401,json:async()=>({error:'Bearer expired'})};
      const input=JSON.parse(init.body),value={v:2,engineNodeId:hub.sync.nodeId,engineFingerprint:hub.sync.identity.fingerprint,deviceId:hubConfig.deviceId,nodeId:copy.sync.nodeId,fingerprint:copy.sync.identity.fingerprint,timestamp:input.timestamp,nonce:input.nonce,revokedAt:new Date().toISOString()};
      if(change==='device')value.deviceId='dev_wrong';if(change==='node')value.nodeId='node_wrong';if(change==='hub')value.engineNodeId='node_other_hub';if(change==='fingerprint')value.fingerprint=generateIdentity().fingerprint;if(change==='nonce')value.nonce='old_request_nonce_123456789';if(change==='timestamp')value.timestamp-=600_000;if(change==='futureRevocation')value.revokedAt=new Date(Date.now()+600_000).toISOString();
      value.proof=signMessage(change==='forged'?generateIdentity().privateKey:hub.sync.identity.privateKey,SESSION_REVOKED_MESSAGE(value));return {ok:false,status:401,json:async()=>change==='unsigned'?{error:'Unstructured refusal'}:{code:'engine_revoked',revocation:value}};
    };
    await assert.rejects(copy.sync.disconnect(),error=>error.code!=='engine_revoked_verified');assert.equal(copy.sync.config.hub,hubConfig,change);assert.equal(copy.sync.config.automationSuspended,true);assert.ok(hub.sync.devices.find(hubConfig.deviceId),'An ordinary authentication failure cannot claim the live grant was removed.');
  }
});
