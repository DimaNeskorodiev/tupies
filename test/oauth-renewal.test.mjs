import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Providers } from '../lib/providers.mjs';
import { providerFailure } from '../lib/provider-failure.mjs';

const SCOPES=['resource.invoke','chatgpt.tokens.use.direct'],GOOD={access_token:'access-renewed',refresh_token:'refresh-replacement',token_type:'Bearer',expires_in:3600};
// A fake OpenAI token endpoint. `script` decides each refresh request: an object is a JSON answer, 'reset' kills the socket, a function is awaited first.
async function fixture(t,script,{expiresAt=Date.now()-1000}={}){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-oauth-renewal-')),store=await new Store(directory).init(),calls=[];let origin;
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;
    if(req.url==='/.well-known/openid-configuration'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({issuer:origin,token_endpoint:`${origin}/token`,jwks_uri:`${origin}/jwks`}));}
    calls.push(new URLSearchParams(raw).get('refresh_token'));const answer=await script(calls.length);
    if(answer==='reset'){req.socket.destroy();return;}
    res.writeHead(answer.status||200,{'content-type':'application/json'});res.end(JSON.stringify(answer.body));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  const providers=new Providers(store,{oauthIssuer:origin,allowTestOAuth:true,requestTimeout:2000});
  t.after(async()=>{await providers.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  const bundle={access_token:'access-initial',refresh_token:'refresh-initial',client_id:'issued-test-client',scopes:SCOPES,expiresAt,savedAt:new Date().toISOString()};
  const c={...providers.validate({name:'ChatGPT',type:'chatgpt'}),id:'oauth_renewal',status:'connected',oauthAccount:{planEnabled:true,needsLogin:false},oauthSecret:store.seal(JSON.stringify(bundle))};
  await store.mutate(state=>{state.connections.push(c);});
  const stored=()=>JSON.parse(store.unseal(store.state.connections.find(item=>item.id===c.id).oauthSecret)),account=()=>store.state.connections.find(item=>item.id===c.id).oauthAccount;
  return {providers,store,c,calls,stored,account,server,origin};
}
const rejection=async promise=>{try{await promise;}catch(error){return error;}assert.fail('Expected a rejection.');};

test('a transport failure keeps the bundle, records a backoff and throws a retryable error',async t=>{
  const f=await fixture(t,()=>({body:GOOD}));await f.providers.oauth.metadata();f.server.closeAllConnections();await new Promise(resolve=>f.server.close(resolve));
  const error=await rejection(f.providers.oauth.bearer(f.c));
  assert.equal(error.status,503);assert.match(error.message,/temporarily unavailable; retrying automatically/);assert.equal(providerFailure(error).code,'upstream_unavailable');
  const bundle=f.stored();assert.equal(bundle.refresh_token,'refresh-initial');assert.equal(bundle.refreshState,undefined);assert.equal(bundle.refreshFailures,1);
  const wait=bundle.nextRefreshAttemptAt-Date.now();assert.ok(wait>20_000 && wait<=30_000);assert.equal(f.account().needsLogin,false);assert.equal(f.providers.loginStatus(f.c).status,'connected');
});

test('backoff doubles per failure up to fifteen minutes and is honored without contacting the endpoint',async t=>{
  const f=await fixture(t,()=>({body:GOOD}));await f.providers.oauth.metadata();f.server.closeAllConnections();await new Promise(resolve=>f.server.close(resolve));
  const waits=[];
  for(const expected of [30,60,300,900,900]){
    await f.store.mutate(()=>{const bundle=f.stored();delete bundle.nextRefreshAttemptAt;f.store.state.connections[0].oauthSecret=f.store.seal(JSON.stringify(bundle));});
    await rejection(f.providers.oauth.bearer(f.c));waits.push(Math.round((f.stored().nextRefreshAttemptAt-Date.now())/10_000)*10);assert.equal(waits.at(-1),expected);
  }
  assert.equal(f.stored().refreshFailures,5);
  // Within the backoff an expired token fails fast with the same retryable error; no request is attempted.
  const before=f.stored().refreshFailures,error=await rejection(f.providers.oauth.bearer(f.c));assert.equal(error.status,503);assert.equal(f.stored().refreshFailures,before);
  // A still-valid token keeps working while the endpoint is left alone.
  await f.store.mutate(()=>{const bundle=f.stored();bundle.expiresAt=Date.now()+30_000;f.store.state.connections[0].oauthSecret=f.store.seal(JSON.stringify(bundle));});
  assert.equal(await f.providers.oauth.bearer(f.c),'access-initial');
});

test('a definitive 4xx answer marks the renewal uncertain and requires sign-in without replaying the token',async t=>{
  const f=await fixture(t,()=>({status:400,body:{error:'invalid_grant'}}));
  const error=await rejection(f.providers.oauth.bearer(f.c));assert.equal(error.status,401);assert.equal(f.calls.length,1);
  assert.equal(f.stored().refreshState,'uncertain');assert.equal(f.account().needsLogin,true);assert.equal(f.providers.loginStatus(f.c).status,'signed_out');
  await rejection(f.providers.oauth.bearer(f.c));assert.equal(f.calls.length,1);
});

test('an ambiguous failure is retried once with the same token and then succeeds',async t=>{
  for(const first of ['reset',{status:502,body:{error:'bad_gateway'}}]){
    const f=await fixture(t,count=>count===1?first:{body:GOOD});
    assert.equal(await f.providers.oauth.bearer(f.c),'access-renewed');assert.deepEqual(f.calls,['refresh-initial','refresh-initial']);
    const bundle=f.stored();assert.equal(bundle.refresh_token,'refresh-replacement');assert.equal(bundle.refreshState,undefined);assert.equal(bundle.refreshFailures,undefined);assert.equal(f.account().needsLogin,false);
  }
});

test('an ambiguous failure followed by invalid_grant requires sign-in; ambiguous twice keeps the bundle and backs off',async t=>{
  const f=await fixture(t,count=>count===1?'reset':{status:400,body:{error:'invalid_grant'}});
  await rejection(f.providers.oauth.bearer(f.c));assert.equal(f.calls.length,2);assert.equal(f.stored().refreshState,'uncertain');assert.equal(f.account().needsLogin,true);
  const g=await fixture(t,()=>'reset'),error=await rejection(g.providers.oauth.bearer(g.c));
  assert.equal(g.calls.length,2);assert.equal(error.status,503);assert.equal(g.stored().refresh_token,'refresh-initial');assert.equal(g.stored().refreshState,undefined);assert.equal(g.stored().refreshFailures,1);assert.equal(g.account().needsLogin,false);
});

test('status does not report signed out while a renewal is in progress',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,async()=>{await gate;return {body:GOOD};}),pending=f.providers.oauth.bearer(f.c);
  while(f.stored().refreshState!=='in_progress')await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(f.account().needsLogin,false);assert.equal(f.providers.loginStatus(f.store.state.connections.find(item=>item.id===f.c.id)).status,'connected');
  release();assert.equal(await pending,'access-renewed');
});
