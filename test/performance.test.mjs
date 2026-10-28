import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../server.mjs';
import { Store } from '../lib/store.mjs';

const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-performance-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,requestTimeout:2000});
  const {url}=await app.listen(0);
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const setup=await fetch(`${url}/api/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'fixture-workspace-password'})});
  assert.equal(setup.status,201);
  return {app,url,cookie:setup.headers.get('set-cookie').split(';')[0]};
}
// Node's fetch decodes bodies by itself, so raw requests show what actually crosses the network.
const raw=(url,headers={})=>new Promise((resolve,reject)=>http.get(url,{headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));}).on('error',reject));

test('static assets are compressed once per version and revalidated without a body',async t=>{
  const {url}=await fixture(t),original=await fs.readFile(path.join(ROOT,'public','app.js'));
  const br=await raw(`${url}/app.js`,{'Accept-Encoding':'gzip, deflate, br'});
  assert.equal(br.status,200);assert.equal(br.headers['content-encoding'],'br');assert.equal(br.headers['cache-control'],'no-cache');assert.match(br.headers.vary,/Accept-Encoding/);
  assert.ok(br.body.length<original.length/2);assert.deepEqual(brotliDecompressSync(br.body),original);
  const gzip=await raw(`${url}/app.js`,{'Accept-Encoding':'br;q=0, gzip'});
  assert.equal(gzip.headers['content-encoding'],'gzip');assert.deepEqual(gunzipSync(gzip.body),original);
  const plain=await raw(`${url}/app.js`);
  assert.equal(plain.headers['content-encoding'],undefined);assert.deepEqual(plain.body,original);
  assert.equal(plain.headers.etag,br.headers.etag);
  const cached=await raw(`${url}/app.js`,{'If-None-Match':br.headers.etag,'Accept-Encoding':'br'});
  assert.equal(cached.status,304);assert.equal(cached.body.length,0);
  assert.match(cached.headers['content-security-policy'],/default-src 'self'/);
});

test('chat polling answers 304 until the transcript itself changes',async t=>{
  const {app,url,cookie}=await fixture(t),route=`${url}/api/bots/bot_atlas/messages`;
  const first=await fetch(route,{headers:{Cookie:cookie}}),tag=first.headers.get('etag');
  assert.equal(first.status,200);assert.ok(tag);assert.deepEqual((await first.json()).messages,[]);
  assert.equal(first.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(route,{headers:{Cookie:cookie,'If-None-Match':tag}})).status,304);
  // A commit elsewhere in the workspace recomputes the tag, which still matches an unchanged transcript.
  await app.store.mutate(state=>{state.settings.unrelated=true;});
  assert.equal((await fetch(route,{headers:{Cookie:cookie,'If-None-Match':tag}})).status,304);
  await app.store.mutate(state=>{state.messages.bot_atlas=[{id:'message_fixture',role:'user',content:'Changed',createdAt:new Date().toISOString()}];});
  const changed=await fetch(route,{headers:{Cookie:cookie,'If-None-Match':tag}});
  assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),tag);assert.equal((await changed.json()).messages[0].content,'Changed');
  assert.equal((await fetch(route,{headers:{'If-None-Match':changed.headers.get('etag')}})).status,401);
  const room=await fetch(`${url}/api/rooms/room_missing/messages`,{headers:{Cookie:cookie}});
  assert.equal(room.status,404);
});

test('failed mutations restore committed state and run progress commits are marked local',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-store-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init(),commits=[];store.onCommit(change=>commits.push(change));
  await store.mutate(state=>{state.settings.kept='yes';});
  const revision=store.revision;
  await assert.rejects(store.mutate(state=>{state.settings.kept='no';state.bots.length=0;throw new Error('validation failed');}),/validation failed/);
  assert.equal(store.state.settings.kept,'yes');assert.equal(store.state.bots.length,3);assert.ok(store.revision>revision);
  await store.mutate(state=>{state.runs.bot_atlas={id:'run_fixture',status:'running'};},{local:true});
  assert.deepEqual(commits,[{local:false},{local:true}]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'state.json'),'utf8')).runs.bot_atlas,{id:'run_fixture',status:'running'});
});

test('redaction follows replaced credentials without keeping old plaintext',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-redact-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init();
  await store.mutate(state=>{state.connections.push({id:'conn_fixture',type:'openai',secret:store.seal('sk-first-secret-value'),oauthSecret:store.seal(JSON.stringify({access_token:'oauth-access-value',account:'not-a-secret'}))});});
  assert.equal(store.redact('a sk-first-secret-value b oauth-access-value not-a-secret'),'a [redacted] b [redacted] not-a-secret');
  await store.mutate(state=>{state.connections[0].secret=store.seal('sk-second-secret-value');});
  assert.equal(store.redact('sk-first-secret-value sk-second-secret-value'),'sk-first-secret-value [redacted]');
  assert.equal(store.secretCache.size,2);
  assert.deepEqual(store.redactValue({'sk-second-secret-value':['sk-second-secret-value',1]}),{'[redacted]':['[redacted]',1]});
});
