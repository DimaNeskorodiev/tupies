import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APNs } from '../lib/apns.mjs';

const pair = generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const PRIVATE = pair.privateKey.export({type:'pkcs8',format:'pem'});
const DEVICE_TOKEN = 'a1'.repeat(32);
const PAYLOAD = {aps:{alert:{title:'Bot reply',body:'Open Tupies to read the update.'},sound:'default'},studio:{v:1,engineId:'engine_fixture',botId:'bot_atlas',kind:'message',eventId:'event_fixture'}};
const request = (extra = {}) => ({token:DEVICE_TOKEN,environment:'sandbox',payload:PAYLOAD,eventId:'message:fixture',...extra});

function fixture(options = {}) {
  const connections = [], streams = [];
  let respond = stream => {stream.emit('response',{':status':200});stream.emit('end');};
  class Stream extends EventEmitter {
    close() {if (this.closed) return;this.closed=true;this.emit('close');}
    end(bytes) {this.body=Buffer.from(bytes);queueMicrotask(()=>{if(!this.closed)respond(this);});}
  }
  class Session extends EventEmitter {
    request(headers) {const stream=new Stream();stream.headers=headers;stream.session=this;streams.push(stream);return stream;}
    setTimeout(ms, callback) {this.idleTimeout=ms;this.idle=callback;}
    close() {this.closed=true;this.emit('close');}
    destroy() {if(this.destroyed)return;this.destroyed=true;for(const stream of streams.filter(item=>item.session===this))stream.close();this.emit('close');}
  }
  const provider = new APNs({env:{},keyFile:'operator-private-key.p8',keyId:'KEY1234567',teamId:'TEAM123456',readKey:async()=>PRIVATE,
    connect:(url,settings)=>{const session=new Session();connections.push({url,settings,session});return session;},...options});
  return {provider,connections,streams,set respond(value){respond=value;}};
}

test('APNs stays unavailable without operator configuration and sanitizes invalid credentials',async()=>{
  let read=false,connected=false;
  const absent=await new APNs({env:{},readKey:()=>{read=true;},connect:()=>{connected=true;}}).init();
  assert.equal(absent.available,false);assert.equal(absent.reason,'not_configured');assert.equal(read,false);assert.equal(connected,false);
  await assert.rejects(absent.send(request()),{code:'apns_unavailable'});
  const secret='private-key-content-and-location-never-returned';
  const invalid=await new APNs({env:{STUDIO_APNS_KEY_FILE:secret,STUDIO_APNS_KEY_ID:'KEY1234567',STUDIO_APNS_TEAM_ID:'TEAM123456'},readKey:async()=>{throw new Error(secret);}}).init();
  assert.equal(invalid.available,false);assert.equal(invalid.reason,'invalid_configuration');assert.ok(!invalid.configError.includes(secret));
  await assert.rejects(invalid.send(request()),error=>error.code==='apns_unavailable'&&!error.message.includes(secret));
  for(const options of [{keyId:'invalid'},{teamId:'invalid'},{environment:'https://attacker.invalid'},{topic:'bad\r\nheader'}]) {
    const f=fixture(options);await f.provider.init();assert.equal(f.provider.available,false);assert.equal(f.provider.reason,'invalid_configuration');assert.equal(f.connections.length,0);assert.ok(['sandbox','production'].includes(f.provider.environment));
  }
});

test('APNs requires a private P-256 key and reads only a bounded ordinary configured file',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'studio-apns-key-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'AuthKey.p8');await writeFile(file,PRIVATE,{mode:0o600});
  const config={env:{},keyFile:file,keyId:'KEY1234567',teamId:'TEAM123456'};
  const valid=await new APNs(config).init();assert.equal(valid.available,true);valid.close();
  const wrong=generateKeyPairSync('ec',{namedCurve:'secp384r1'}).privateKey.export({type:'pkcs8',format:'pem'});
  await writeFile(file,wrong);assert.equal((await new APNs(config).init()).available,false);
  await writeFile(file,Buffer.alloc(65537));assert.equal((await new APNs(config).init()).available,false);
  assert.equal((await new APNs({...config,keyFile:directory}).init()).available,false);
  const publicOnly=fixture({readKey:async()=>pair.publicKey.export({type:'spki',format:'pem'})});await publicOnly.provider.init();assert.equal(publicOnly.provider.available,false);
});

test('APNs signs a valid ES256 JWT and sends bounded alert metadata only to fixed TLS endpoints',async()=>{
  const now=Date.UTC(2026,9,27,12),f=fixture({now:()=>now});
  await f.provider.init();const result=await f.provider.send(request());
  assert.deepEqual(result,{status:200});assert.equal(f.connections.length,1);
  assert.equal(f.connections[0].url,'https://api.sandbox.push.apple.com');
  assert.deepEqual(f.connections[0].settings,{rejectUnauthorized:true,minVersion:'TLSv1.2',servername:'api.sandbox.push.apple.com'});
  const stream=f.streams[0],headers=stream.headers;
  assert.equal(headers[':method'],'POST');assert.equal(headers[':path'],'/3/device/'+DEVICE_TOKEN);
  assert.equal(headers['apns-topic'],'dev.hermesstudio.app');assert.equal(headers['apns-push-type'],'alert');assert.equal(headers['apns-priority'],'5');
  assert.equal(headers['apns-expiration'],String(now/1000+86400));assert.match(headers['apns-id'],/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(Buffer.byteLength(headers['apns-collapse-id']),64);assert.equal(headers['content-length'],String(stream.body.length));assert.deepEqual(JSON.parse(stream.body),PAYLOAD);
  const token=headers.authorization.replace(/^bearer /,''),[head,claims,signature]=token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head,'base64url')),{alg:'ES256',kid:'KEY1234567'});
  assert.deepEqual(JSON.parse(Buffer.from(claims,'base64url')),{iss:'TEAM123456',iat:now/1000});
  assert.equal(Buffer.from(signature,'base64url').length,64);
  assert.ok(verify('sha256',Buffer.from(`${head}.${claims}`),{key:pair.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')));
  f.provider.close();
  const production=fixture({environment:'production'});await production.provider.send(request({environment:'production'}));assert.equal(production.connections[0].url,'https://api.push.apple.com');production.provider.close();
});

test('APNs reuses a token for fifty minutes and a persistent session; event collapse identities are stable',async()=>{
  let now=Date.UTC(2026,9,27,12);const f=fixture({now:()=>now});
  await f.provider.send(request());const initial=f.streams[0].headers;
  now+=19*60_000;await f.provider.send(request());assert.equal(f.streams[1].headers.authorization,initial.authorization);
  now+=30*60_000;await f.provider.send(request());assert.equal(f.streams[2].headers.authorization,initial.authorization);
  now+=60_000;await f.provider.send(request({eventId:'another-event'}));
  assert.notEqual(f.streams[3].headers.authorization,initial.authorization);assert.equal(f.connections.length,1);
  assert.equal(f.streams[1].headers['apns-id'],initial['apns-id']);assert.equal(f.streams[2].headers['apns-collapse-id'],initial['apns-collapse-id']);
  assert.notEqual(f.streams[3].headers['apns-id'],initial['apns-id']);assert.notEqual(f.streams[3].headers['apns-collapse-id'],initial['apns-collapse-id']);f.provider.close();
});

test('APNs refuses malformed tokens, environment mismatches and oversized payloads before connecting',async()=>{
  const f=fixture();
  for(const invalid of [{token:'not-a-token'},{token:'a'.repeat(65)},{token:'a'.repeat(514)},{eventId:'x\nheader'},{eventId:''},{payload:null},{payload:{aps:{},value:'x'.repeat(4096)}}])
    await assert.rejects(f.provider.send(request(invalid)));
  await assert.rejects(f.provider.send(request({environment:'production'})),{code:'apns_environment_mismatch'});
  assert.equal(f.connections.length,0);f.provider.close();
});

test('APNs returns explicit provider status and safe reason codes without echoing response data',async()=>{
  const f=fixture();
  f.respond=stream=>{stream.emit('response',{':status':410});stream.emit('data',Buffer.from(JSON.stringify({reason:'Unregistered',timestamp:123,private:'private detail'})));stream.emit('end');};
  assert.deepEqual(await f.provider.send(request()),{status:410,reason:'Unregistered'});
  f.respond=stream=>{stream.emit('response',{':status':429,'retry-after':'45'});stream.emit('data',Buffer.from('{"reason":"TooManyRequests"}'));stream.emit('end');};
  assert.deepEqual(await f.provider.send(request()),{status:429,reason:'TooManyRequests',retryAfter:45});
  f.respond=stream=>{stream.emit('response',{':status':503,'retry-after':'999999999'});stream.emit('data',Buffer.from('{"reason":"private-key-secret-from-provider"}'));stream.emit('end');};
  assert.deepEqual(await f.provider.send(request()),{status:503,reason:'APNsRejected',retryAfter:86400});
  f.respond=stream=>{stream.emit('response',{':status':500});stream.emit('data',Buffer.from('invalid JSON'));stream.emit('end');};
  assert.deepEqual(await f.provider.send(request()),{status:500,reason:'APNsRejected'});
  f.respond=stream=>{stream.emit('response',{':status':302});stream.emit('end');};
  assert.deepEqual(await f.provider.send(request()),{status:302,reason:'APNsRejected'});assert.equal(f.connections.length,1);f.provider.close();
});

test('APNs bounds provider bodies and transport errors without replaying a request',async()=>{
  const f=fixture();
  f.respond=stream=>{stream.emit('response',{':status':503});stream.emit('data',Buffer.alloc(4097));};
  await assert.rejects(f.provider.send(request()),{code:'apns_delivery_unknown'});assert.equal(f.streams.length,1);assert.equal(f.connections[0].session.destroyed,true);
  f.respond=stream=>stream.emit('error',new Error('transport echoed private payload '+DEVICE_TOKEN));
  await assert.rejects(f.provider.send(request()),error=>error.code==='apns_delivery_unknown'&&!error.message.includes(DEVICE_TOKEN));
  assert.equal(f.streams.length,2);f.provider.close();
});

test('APNs serializes bounded streams and closes active and queued work without dispatching it',async()=>{
  const f=fixture();f.respond=()=>{};
  const first=f.provider.send(request()),second=f.provider.send(request({eventId:'second-event'}));
  // Both asynchronous init and slot acquisition settle before a fake response is emitted.
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.streams.length,1);
  f.provider.close();
  await assert.rejects(first,{code:'apns_closed'});await assert.rejects(second,{code:'apns_closed'});assert.equal(f.streams.length,1);
  await assert.rejects(f.provider.send(request()),{code:'apns_unavailable'});
});

test('APNs retires an idle/GOAWAY connection and a timeout has an unknown delivery outcome',async()=>{
  const f=fixture();await f.provider.send(request());
  f.connections[0].session.emit('goaway');await f.provider.send(request());assert.equal(f.connections.length,2);f.provider.close();
  const timeout=fixture({timeoutMs:10});timeout.respond=()=>{};
  const keepAlive=setTimeout(()=>{},1000);
  try {await assert.rejects(timeout.provider.send(request()),{code:'apns_delivery_unknown'});assert.equal(timeout.streams.length,1);}
  finally {clearTimeout(keepAlive);timeout.provider.close();}
});
