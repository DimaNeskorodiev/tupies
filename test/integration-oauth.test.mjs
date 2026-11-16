import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { oauthRedirectBase, oauthResultPage } from '../lib/integration-oauth.mjs';
import { createStudioServer } from '../server.mjs';

const CLIENT_SECRET='oauth-fixture-client-secret';
const REDIRECT_BASE='http://127.0.0.1:4999';
function json(res,data,status=200){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}

/** A fake OAuth provider: /token issues numbered tokens, /api/* checks the bearer token. Behaviour is switchable per test. */
async function provider(t){
  const p={tokenRequests:[],apiRequests:[],issued:0,expiresIn:3600,rotate:true,tokenDelay:0,refreshError:null,reject:new Set(),valid:new Set()};
  p.server=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const url=new URL(req.url,'http://fixture');
    if(url.pathname==='/token'){
      const form=Object.fromEntries(new URLSearchParams(raw));p.tokenRequests.push({form,headers:req.headers});
      if(p.tokenDelay)await new Promise(resolve=>setTimeout(resolve,p.tokenDelay));
      if(form.grant_type==='refresh_token' && p.refreshError)return json(res,{error:p.refreshError,error_description:'Token has been expired or revoked.'},400);
      if(form.grant_type==='authorization_code' && form.code==='bad-code')return json(res,{error:'invalid_grant'},400);
      const n=++p.issued,access=`access-${n}-${'x'.repeat(12)}`;p.valid.add(access);
      return json(res,{access_token:access,token_type:'Bearer',expires_in:p.expiresIn,...(form.grant_type==='authorization_code' || p.rotate?{refresh_token:`refresh-${n}-${'y'.repeat(12)}`}:{}),scope:'read write'});
    }
    const token=String(req.headers.authorization || '').replace(/^Bearer /,'');p.apiRequests.push({method:req.method,path:url.pathname,token,body:raw});
    if(!p.valid.has(token) || p.reject.has(token))return json(res,{error:'unauthorized'},401);
    return json(res,{ok:true,method:req.method,token});
  });
  await new Promise(resolve=>p.server.listen(0,'127.0.0.1',resolve));
  p.origin=`http://127.0.0.1:${p.server.address().port}`;
  t.after(()=>new Promise(resolve=>p.server.close(resolve)));
  return p;
}
async function fixture(t){
  const p=await provider(t);
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-integration-oauth-')),store=await new Store(directory).init();store.state.integrations=[];
  const integrations=new Integrations(store,{requestTimeout:2000,allowPrivateHttp:true,oauthRedirectBase:REDIRECT_BASE});
  // Servers and services close before their temporary folder is removed.
  t.after(async()=>{await integrations.close();await fs.rm(directory,{recursive:true,force:true});});
  return {p,store,integrations};
}
const tools=[{name:'read_items',method:'GET',path:'/api/items',inputSchema:{type:'object',properties:{}}},{name:'send_item',method:'POST',path:'/api/items',inputSchema:{type:'object',properties:{text:{type:'string'}}}}];
const oauthInput=(p,extra={})=>({name:'Mail fixture',type:'rest',baseUrl:p.origin,authType:'oauth2',oauth:{authorizationUrl:`${p.origin}/authorize`,tokenUrl:`${p.origin}/token`,scopes:['read','write'],clientId:'client-123',extraParams:{access_type:'offline',prompt:'consent'}},oauthClientSecret:CLIENT_SECRET,tools,...extra});
async function add(f,input=oauthInput(f.p)){const integration={...f.integrations.validate(input),id:'integration_oauth',createdAt:new Date().toISOString()};await f.store.mutate(state=>{state.integrations.push(integration);state.bots[0].integrationIds=[integration.id];});return integration;}
async function connect(f){const started=await f.integrations.oauth.start('integration_oauth');const state=new URL(started.authorizationUrl).searchParams.get('state');return {started,state,result:await f.integrations.oauth.callback({state,code:'good-code'})};}
const current=f=>f.store.state.integrations.find(item=>item.id==='integration_oauth');
const bundle=f=>JSON.parse(f.store.unseal(current(f).oauthSecret));
const call=(f,name,args={})=>f.integrations.call('integration_oauth',name,args,{approved:true,botId:'bot_atlas'});

test('oauth2 validation accepts a proposal without client or tokens and refuses reserved or unsafe settings',async t=>{
  const f=await fixture(t),{p}=f;
  const proposed=f.integrations.validate({...oauthInput(p),oauth:{...oauthInput(p).oauth,clientId:''},oauthClientSecret:undefined});
  assert.equal(proposed.status,'needs_credentials');assert.equal(proposed.oauth.connected,false);assert.equal(proposed.oauthSecret,undefined);assert.equal(proposed.secret,undefined);
  assert.deepEqual(proposed.oauth.extraParams,{access_type:'offline',prompt:'consent'});assert.equal(proposed.oauth.tokenAuth,'body');
  for(const key of ['client_id','redirect_uri','state','code_challenge','code_challenge_method','response_type','scope','client_secret'])assert.throws(()=>f.integrations.validate(oauthInput(p,{oauth:{...oauthInput(p).oauth,extraParams:{[key]:'x'}}})),/cannot be an extra/);
  assert.throws(()=>f.integrations.validate(oauthInput(p,{oauth:{...oauthInput(p).oauth,extraParams:Object.fromEntries([...Array(9)].map((_,i)=>[`k${i}`,'v']))}})),/up to 8/);
  assert.throws(()=>f.integrations.validate(oauthInput(p,{oauth:{...oauthInput(p).oauth,scopes:['has space']}})),/scopes/);
  assert.throws(()=>f.integrations.validate(oauthInput(p,{oauth:{...oauthInput(p).oauth,scopes:[...Array(41)].map((_,i)=>`s${i}`)}})),/scopes/);
  assert.throws(()=>f.integrations.validate(oauthInput(p,{oauth:{...oauthInput(p).oauth,tokenAuth:'jwt'}})),/body or basic/);
  assert.throws(()=>f.integrations.validate(oauthInput(p,{oauth:{...oauthInput(p).oauth,authorizationUrl:'https://user:pw@accounts.example.com/auth'}})),/credentials/);
  assert.throws(()=>f.integrations.validate(oauthInput(p,{oauth:{...oauthInput(p).oauth,authorizationUrl:'https://accounts.example.com/auth#frag'}})),/fragment/);
  assert.throws(()=>f.integrations.validate(oauthInput(p,{oauth:{...oauthInput(p).oauth,authorizationUrl:'https://accounts.example.com/auth?client_id=evil'}})),/cannot preset/);
  assert.throws(()=>f.integrations.validate(oauthInput(p,{oauth:{...oauthInput(p).oauth,tokenUrl:'https://169.254.169.254/token'}})),/metadata/);
  assert.throws(()=>f.integrations.validate(oauthInput(p,{authType:'kerberos'})),/OAuth sign-in/);
  const strict=new Integrations(f.store,{allowPrivateHttp:false});assert.throws(()=>strict.validate(oauthInput(p,{oauth:{...oauthInput(p).oauth,tokenUrl:'http://example.com/token'}})),/HTTPS/);assert.throws(()=>strict.validate(oauthInput(p,{oauth:{...oauthInput(p).oauth,tokenUrl:'http://10.0.0.5/token'}})),/HTTPS|private/i);
  await assert.rejects(f.integrations.oauth.start('integration_missing'),/not found/);
  await add(f,{...oauthInput(p),oauth:{...oauthInput(p).oauth,clientId:''}});
  await assert.rejects(f.integrations.oauth.start('integration_oauth'),/client ID/);
  await assert.rejects(call(f,'read_items'),/not connected yet/);assert.equal(p.apiRequests.length,0);
});

test('start builds a PKCE S256 authorization URL; the callback exchanges once and stores sealed tokens only',async t=>{
  const f=await fixture(t),{p}=f;await add(f);
  const {started,state,result}=await connect(f);
  const auth=new URL(started.authorizationUrl);
  assert.equal(auth.origin+auth.pathname,`${p.origin}/authorize`);
  assert.equal(started.redirectUri,`${REDIRECT_BASE}/api/integrations/oauth/callback`);
  for(const [key,value] of Object.entries({response_type:'code',client_id:'client-123',redirect_uri:started.redirectUri,scope:'read write',code_challenge_method:'S256',access_type:'offline',prompt:'consent'}))assert.equal(auth.searchParams.get(key),value);
  assert.ok(Date.parse(started.expiresAt)-Date.now()<=600_000);
  const exchange=p.tokenRequests[0].form;
  assert.equal(exchange.grant_type,'authorization_code');assert.equal(exchange.code,'good-code');assert.equal(exchange.redirect_uri,started.redirectUri);assert.equal(exchange.client_id,'client-123');assert.equal(exchange.client_secret,CLIENT_SECRET);
  assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'),auth.searchParams.get('code_challenge'),'the verifier matches the challenge');
  assert.deepEqual(result,{integrationId:'integration_oauth',name:'Mail fixture',status:'connected'});
  const stored=current(f);assert.equal(stored.status,'connected');assert.equal(stored.oauth.connected,true);assert.match(stored.oauth.connectionId,/^oauthconn_/);assert.ok(stored.oauth.expiresAt);
  assert.deepEqual(Object.keys(bundle(f)).sort(),['access_token','client_secret','refresh_token']);
  // Single use: the same state can never be exchanged again.
  await assert.rejects(f.integrations.oauth.callback({state,code:'good-code'}),/expired or was already used/);assert.equal(p.tokenRequests.length,1);
  const disk=await fs.readFile(f.store.file,'utf8');for(const secret of [CLIENT_SECRET,'access-1-','refresh-1-'])assert.ok(!disk.includes(secret));
  const pub=f.store.integrationPublic(stored);assert.equal(pub.oauthSecret,undefined);assert.equal(pub.hasOAuthClientSecret,true);assert.equal(pub.oauth.clientId,'client-123');
  const state_=JSON.stringify(f.store.publicState());for(const secret of [CLIENT_SECRET,'access-1-','refresh-1-',stored.oauthSecret])assert.ok(!state_.includes(secret));
  assert.ok(!JSON.stringify(f.store.state.activity).includes('access-1-'));assert.equal(f.store.state.activity[0].type,'integration.oauth_connected');
  const response=await call(f,'read_items');assert.equal(response.ok,true);assert.equal(response.token,'[redacted]','tokens echoed by a service are redacted');
  assert.equal(p.apiRequests.at(-1).token,bundle(f).access_token);
});

test('a state expires, is bound to its integration and to unchanged settings, and declined sign-ins are reported',async t=>{
  const f=await fixture(t),{p}=f;await add(f);
  let started=await f.integrations.oauth.start('integration_oauth'),state=new URL(started.authorizationUrl).searchParams.get('state');
  f.integrations.oauth.pending.get('integration_oauth').expiresAt=Date.now()-1;
  await assert.rejects(f.integrations.oauth.callback({state,code:'good-code'}),/expired/);
  await assert.rejects(f.integrations.oauth.callback({state:'guess',code:'good-code'}),/expired or was already used/);
  // An attempt completed under a different integration id is refused and burned.
  await f.store.mutate(state=>{state.integrations.push({...current(f),id:'integration_other'});});
  started=await f.integrations.oauth.start('integration_oauth');state=new URL(started.authorizationUrl).searchParams.get('state');
  await assert.rejects(f.integrations.oauth.complete('integration_other',{state,code:'good-code'}),/different integration/);
  await assert.rejects(f.integrations.oauth.callback({state,code:'good-code'}),/already used/);
  // A newer start retires the earlier link.
  const first=new URL((await f.integrations.oauth.start('integration_oauth')).authorizationUrl).searchParams.get('state');
  const second=new URL((await f.integrations.oauth.start('integration_oauth')).authorizationUrl).searchParams.get('state');
  await assert.rejects(f.integrations.oauth.callback({state:first,code:'good-code'}),/already used/);
  // Settings changed between start and callback.
  const updated=f.integrations.validate({oauthClientSecret:'another-client-secret'},current(f));await f.store.mutate(s=>{s.integrations[s.integrations.findIndex(i=>i.id==='integration_oauth')]=updated;});
  await assert.rejects(f.integrations.oauth.callback({state:second,code:'good-code'}),/settings changed/);
  started=await f.integrations.oauth.start('integration_oauth');state=new URL(started.authorizationUrl).searchParams.get('state');
  await assert.rejects(f.integrations.oauth.callback({state,error:'access_denied'}),/declined/);
  started=await f.integrations.oauth.start('integration_oauth');state=new URL(started.authorizationUrl).searchParams.get('state');
  await assert.rejects(f.integrations.oauth.callback({state,code:'bad-code'}),/did not accept the sign-in \(invalid_grant\)/);
  assert.equal(current(f).oauth.connected,false);
  const page=oauthResultPage({ok:false,title:'<b>x</b>',message:'"&<script>'});assert.ok(!page.includes('<script>') && page.includes('&lt;b&gt;') && page.includes('&quot;&amp;&lt;script&gt;'));
});

test('tokens renew a minute before expiry, concurrent callers share one renewal, and a rotated refresh token is kept',async t=>{
  const f=await fixture(t),{p}=f;await add(f);p.expiresIn=30;await connect(f);
  p.expiresIn=3600;p.tokenDelay=50;const before=bundle(f).refresh_token,fingerprint=f.integrations.fingerprint(current(f));
  const results=await Promise.all([1,2,3,4,5].map(()=>call(f,'read_items')));
  assert.ok(results.every(result=>result.ok));
  const refreshes=p.tokenRequests.filter(request=>request.form.grant_type==='refresh_token');
  assert.equal(refreshes.length,1,'one renewal for five concurrent calls');assert.equal(refreshes[0].form.refresh_token,before);assert.equal(refreshes[0].form.client_secret,CLIENT_SECRET);
  assert.equal(bundle(f).refresh_token,'refresh-2-yyyyyyyyyyyy');assert.equal(bundle(f).access_token,'access-2-xxxxxxxxxxxx');
  assert.ok(Date.parse(current(f).oauth.expiresAt)>Date.now()+3_000_000);
  assert.equal(f.integrations.fingerprint(current(f)),fingerprint,'approvals stay bound across a renewal');
  assert.ok(p.apiRequests.every(request=>request.token==='access-2-xxxxxxxxxxxx'));
  // Without a rotated refresh token the old one is kept.
  p.rotate=false;p.tokenDelay=0;await f.store.mutate(s=>{s.integrations[0].oauth.expiresAt=new Date(Date.now()+1000).toISOString();});
  await call(f,'read_items');assert.equal(bundle(f).refresh_token,'refresh-2-yyyyyyyyyyyy');assert.equal(bundle(f).access_token,'access-3-xxxxxxxxxxxx');
});

test('HTTP 401 renews once: GET is sent again, POST is not replayed',async t=>{
  const f=await fixture(t),{p}=f;await add(f);await connect(f);
  p.reject.add('access-1-xxxxxxxxxxxx');
  const read=await call(f,'read_items');assert.equal(read.ok,true);
  assert.deepEqual(p.apiRequests.map(request=>[request.method,request.token]),[['GET','access-1-xxxxxxxxxxxx'],['GET','access-2-xxxxxxxxxxxx']]);
  p.reject.add('access-2-xxxxxxxxxxxx');
  await assert.rejects(call(f,'send_item',{text:'hello'}),error=>error.status===409 && /not sent again; it is safe to call it again/.test(error.message));
  assert.equal(p.apiRequests.filter(request=>request.method==='POST').length,1,'the POST reached the service once');
  assert.equal(bundle(f).access_token,'access-3-xxxxxxxxxxxx','the sign-in was renewed for the next call');
  const sent=await call(f,'send_item',{text:'hello'});assert.equal(sent.method,'POST');
  // A GET rejected again after renewal is not retried a second time.
  p.reject.add('access-3-xxxxxxxxxxxx');p.reject.add('access-4-xxxxxxxxxxxx');const count=p.apiRequests.length;
  await assert.rejects(call(f,'read_items'),/HTTP 401/);assert.equal(p.apiRequests.length-count,2);
});

test('invalid_grant or a missing refresh token asks the owner to sign in again',async t=>{
  const f=await fixture(t),{p}=f;await add(f);await connect(f);
  p.refreshError='invalid_grant';await f.store.mutate(s=>{s.integrations[0].oauth.expiresAt=new Date(Date.now()+5000).toISOString();});
  const count=p.apiRequests.length;
  await assert.rejects(call(f,'read_items'),/Mail fixture needs the owner to sign in again in Settings → Integrations/);
  assert.equal(p.apiRequests.length,count,'nothing was sent with an expiring token');
  const stored=current(f);assert.equal(stored.status,'needs_reauth');assert.equal(stored.oauth.connected,false);assert.equal(stored.oauth.connectionId,undefined);
  assert.deepEqual(Object.keys(bundle(f)),['client_secret'],'tokens are forgotten, the client secret stays');
  const event=f.store.state.activity.find(item=>item.type==='integration.oauth_refresh_failed');assert.equal(event.reason,'invalid_grant');assert.ok(!JSON.stringify(event).includes('refresh-1-'));
  await assert.rejects(call(f,'read_items'),/sign in again/);
  // A saved edit keeps needs_reauth visible until the owner signs in.
  assert.equal(f.integrations.validate({name:'Mail fixture'},stored).status,'needs_reauth');
  // Reconnect, then lose the refresh token: a 401 cannot renew and also asks for sign-in.
  p.refreshError=null;await connect(f);await f.store.mutate(s=>{const i=s.integrations[0];i.oauthSecret=f.store.seal(JSON.stringify({client_secret:CLIENT_SECRET,access_token:'access-2-xxxxxxxxxxxx'}));});
  p.reject.add('access-2-xxxxxxxxxxxx');
  await assert.rejects(call(f,'read_items'),/sign in again/);assert.equal(current(f).status,'needs_reauth');
});

test('endpoint, client or secret changes drop tokens; scope changes keep them and suggest a new sign-in; disconnect keeps the client',async t=>{
  const f=await fixture(t),{p}=f;await add(f);await connect(f);
  const fingerprint=f.integrations.fingerprint(current(f));
  const scoped=f.integrations.validate({oauth:{scopes:['read','write','admin']}},current(f));
  assert.equal(scoped.oauth.connected,true);assert.equal(scoped.oauth.reauthSuggested,true);assert.equal(scoped.status,'connected');
  assert.notEqual(f.integrations.fingerprint(scoped),fingerprint);
  for(const change of [{oauth:{clientId:'client-456'}},{oauth:{tokenUrl:`${p.origin}/token2`}},{oauth:{authorizationUrl:`${p.origin}/authorize2`}},{oauthClientSecret:'rotated-client-secret'},{baseUrl:`${p.origin}/v2`,tools}]){
    const changed=f.integrations.validate(change,current(f));
    assert.equal(changed.oauth.connected,false,JSON.stringify(change));assert.equal(changed.status,'needs_credentials');
    const kept=changed.oauthSecret?JSON.parse(f.store.unseal(changed.oauthSecret)):{};assert.equal(kept.access_token,undefined);assert.equal(kept.refresh_token,undefined);
  }
  assert.equal(f.integrations.validate({oauthClientSecret:null},current(f)).oauthSecret,undefined,'null clears the client secret');
  const bearer=f.integrations.validate({authType:'bearer',apiKey:'plain-key',tools},current(f));assert.equal(bearer.oauth,undefined);assert.equal(bearer.oauthSecret,undefined);
  const result=await f.integrations.oauth.disconnect('integration_oauth');
  assert.deepEqual(result,{integrationId:'integration_oauth',status:'needs_credentials',connected:false});
  assert.deepEqual(bundle(f),{client_secret:CLIENT_SECRET});assert.equal(current(f).oauth.clientId,'client-123');
  assert.notEqual(f.integrations.fingerprint(current(f)),fingerprint);
  assert.equal(f.store.state.activity[0].type,'integration.oauth_disconnected');
  await assert.rejects(call(f,'read_items'),/not connected yet/);
});

test('basic client authentication and an MCP server use the same bearer path',async t=>{
  const f=await fixture(t),{p}=f;
  await add(f,{...oauthInput(p),type:'mcp',baseUrl:`${p.origin}/api/mcp`,tools:undefined,oauth:{...oauthInput(p).oauth,tokenAuth:'basic'}});
  await connect(f);
  const exchange=p.tokenRequests[0];assert.equal(exchange.form.client_id,undefined);assert.equal(exchange.form.client_secret,undefined);
  assert.equal(exchange.headers.authorization,`Basic ${Buffer.from(`client-123:${CLIENT_SECRET}`).toString('base64')}`);
  // The fake answers a JSON object, not JSON-RPC, so discovery fails after the bearer is accepted.
  await assert.rejects(f.integrations.discover('integration_oauth'),/MCP/);
  assert.equal(p.apiRequests[0].token,'access-1-xxxxxxxxxxxx');assert.equal(p.apiRequests[0].method,'POST');
});

test('redirect URI uses the public origin or the served loopback address, never a Host header',()=>{
  assert.equal(oauthRedirectBase({publicOrigin:'https://tupies.example.com',port:4310}),'https://tupies.example.com');
  assert.equal(oauthRedirectBase({address:'127.0.0.1',port:4310}),'http://127.0.0.1:4310');
  assert.equal(oauthRedirectBase({address:'0.0.0.0',port:4310}),'http://127.0.0.1:4310');
  assert.equal(oauthRedirectBase({address:'::1',port:4310,scheme:'https'}),'https://[::1]:4310');
  assert.throws(()=>oauthRedirectBase({}),/not listening/);
});

async function engine(t,options={}){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-integration-oauth-api-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,allowPrivateHttp:true,...options});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0,'127.0.0.1');
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'integration-oauth-fixture-password'})});
  assert.equal(setup.status,201);
  const {csrf}=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  const headers={'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf};
  const api=async(route,{method='GET',body}={})=>{const response=await fetch(url+route,{method,headers:method==='GET'?{Cookie:cookie}:headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json(),text:null};};
  return {app,url,api,cookie};
}

test('owner API: redirect, start, browser callback without a session, manual completion and disconnect never expose secrets',async t=>{
  const p=await provider(t),e=await engine(t);
  assert.deepEqual((await e.api('/api/integrations/oauth/redirect')).data,{redirectUri:`${e.url}/api/integrations/oauth/callback`});
  assert.equal((await fetch(e.url+'/api/integrations/oauth/redirect')).status,401,'the owner routes need a session');
  const created=await e.api('/api/integrations',{method:'POST',body:oauthInput(p)});
  assert.equal(created.status,201);assert.equal(created.data.status,'needs_credentials');assert.equal(created.data.hasOAuthClientSecret,true);assert.equal(created.data.oauthSecret,undefined);
  const integrationId=created.data.id;
  const started=await e.api(`/api/integrations/${integrationId}/oauth/start`,{method:'POST',body:{}});
  assert.equal(started.status,200);assert.equal(started.data.redirectUri,`${e.url}/api/integrations/oauth/callback`);
  const state=new URL(started.data.authorizationUrl).searchParams.get('state');
  // The provider's redirect: a top-level navigation without the owner's cookie.
  const page=await fetch(`${e.url}/api/integrations/oauth/callback?state=${encodeURIComponent(state)}&code=good-code`);
  assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);
  const html=await page.text();assert.match(html,/Connected — you can close this tab/);for(const secret of ['access-1-','refresh-1-',CLIENT_SECRET,state])assert.ok(!html.includes(secret));
  const replay=await fetch(`${e.url}/api/integrations/oauth/callback?state=${encodeURIComponent(state)}&code=good-code`);
  assert.equal(replay.status,400);assert.match(await replay.text(),/expired or was already used/);
  const forged=await fetch(`${e.url}/api/integrations/oauth/callback?state=%3Cscript%3E&error=%3Cimg%3E`);assert.equal(forged.status,400);assert.ok(!(await forged.text()).includes('<script>'));
  const state1=await e.api('/api/state');const listed=state1.data.integrations.find(item=>item.id===integrationId);
  assert.equal(listed.status,'connected');assert.equal(listed.oauth.connected,true);assert.equal(listed.oauthSecret,undefined);assert.equal(listed.hasOAuthClientSecret,true);
  for(const secret of ['access-1-','refresh-1-',CLIENT_SECRET])assert.ok(!JSON.stringify(state1.data).includes(secret));
  const disconnected=await e.api(`/api/integrations/${integrationId}/oauth/disconnect`,{method:'POST',body:{}});
  assert.deepEqual(disconnected.data,{integrationId,status:'needs_credentials',connected:false});
  // Manual fallback: paste the address the browser showed when the redirect could not reach the engine.
  const again=await e.api(`/api/integrations/${integrationId}/oauth/start`,{method:'POST',body:{}});
  const pasted=`https://unreachable.example/api/integrations/oauth/callback?state=${encodeURIComponent(new URL(again.data.authorizationUrl).searchParams.get('state'))}&code=good-code&scope=read`;
  const completed=await e.api(`/api/integrations/${integrationId}/oauth/complete`,{method:'POST',body:{redirectUrl:pasted}});
  assert.equal(completed.status,200);assert.deepEqual(completed.data,{integrationId,name:'Mail fixture',status:'connected'});
  assert.equal((await e.api(`/api/integrations/${integrationId}/oauth/complete`,{method:'POST',body:{redirectUrl:pasted}})).status,400);
  assert.equal((await e.api(`/api/integrations/${integrationId}/oauth/complete`,{method:'POST',body:{redirectUrl:'not a url'}})).status,400);
  assert.equal((await e.api('/api/integrations/integration_missing/oauth/start',{method:'POST',body:{}})).status,404);
  const patched=await e.api(`/api/integrations/${integrationId}`,{method:'PATCH',body:{name:'Renamed mail'}});
  assert.equal(patched.data.status,'connected');assert.equal(patched.data.oauthSecret,undefined);
  const activity=JSON.stringify(e.app.store.state.activity);for(const secret of ['access-','refresh-',CLIENT_SECRET])assert.ok(!activity.includes(secret));
});

test('a configured public origin becomes the redirect base',async t=>{
  const e=await engine(t,{publicUrl:'https://tupies.example.com',secureCookie:false});
  assert.deepEqual((await e.api('/api/integrations/oauth/redirect')).data,{redirectUri:'https://tupies.example.com/api/integrations/oauth/callback'});
});
