import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { OAuthDiscovery, parseChallenge, resourceMetadataUrls, authorizationServerUrls, resourceMatches } from '../lib/integration-oauth-discovery.mjs';
import { proposalApprovalSummary } from '../lib/integration-proposals.mjs';
import { createStudioServer } from '../server.mjs';
import { isActive } from '../lib/engine.mjs';

const REDIRECT_BASE='http://127.0.0.1:4999';
const PRM_PATHS={path:'/.well-known/oauth-protected-resource/mcp',root:'/.well-known/oauth-protected-resource',header:'/meta/resource.json'};
const AS_PATHS={'oauth-path':'/.well-known/oauth-authorization-server/tenant','oidc-insert':'/.well-known/openid-configuration/tenant','oidc-append':'/tenant/.well-known/openid-configuration',root:'/.well-known/oauth-authorization-server',legacy:'/.well-known/oauth-authorization-server'};
const TOOLS=[{name:'list_tasks',description:'List tasks.',inputSchema:{type:'object',properties:{}}},{name:'add_task',description:'Add a task.',inputSchema:{type:'object',properties:{title:{type:'string',maxLength:200}},required:['title']}}];
const sha=value=>createHash('sha256').update(value).digest('base64url');

/**
 * One spec-shaped MCP server and authorization server on a local port. `config` selects the discovery variant: challenge (true,
 * 'plain' or false), prm (path, root, header, none), as (oauth-path, oidc-insert, oidc-append, root, legacy, none), dcr (true,
 * false, 'refuse'), secret (registration issues a client secret), s256, cimd, issParam, open (MCP answers without a token), and
 * raw overrides for documents.
 */
async function service(t,config={}){
  const s={config:{challenge:true,prm:'path',as:'oauth-path',dcr:true,secret:false,s256:true,...config},log:[],registrations:[],tokens:[],codes:new Map(),valid:new Map(),refresh:new Map(),calls:[],issued:0};
  s.server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const url=new URL(req.url,'http://fixture'),c=s.config,o=s.origin,route=url.pathname;
    s.log.push({method:req.method,path:route,authorization:req.headers.authorization || ''});
    const send=(status,data,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(data===undefined?'':typeof data==='string'?data:JSON.stringify(data));};
    const issuer=['root','legacy'].includes(c.as)?o:`${o}/tenant`,resource=`${o}/mcp`;
    if(req.method==='GET' && c.prm!=='none' && route===PRM_PATHS[c.prm]){
      if(c.prmRaw!==undefined)return send(200,c.prmRaw,{'content-type':c.prmType || 'application/json'});
      return send(200,{resource:c.resource ?? resource,authorization_servers:[issuer],scopes_supported:['tasks:read','tasks:write'],...c.prmExtra});
    }
    if(req.method==='GET' && c.as!=='none' && route===AS_PATHS[c.as])return send(200,{issuer:c.issuer ?? issuer,authorization_endpoint:`${o}/authorize`,token_endpoint:`${o}/token`,...(c.dcr?{registration_endpoint:`${o}/register`}:{}),response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:c.s256?['S256']:['plain'],...(c.cimd?{client_id_metadata_document_supported:true}:{}),...(c.issParam?{authorization_response_iss_parameter_supported:true}:{}),...c.asExtra});
    if(req.method==='POST' && route==='/register'){
      if(!c.dcr)return send(404,{error:'not_found'});
      if(c.dcr==='refuse')return send(400,{error:'invalid_client_metadata',error_description:'Registration is closed.'});
      const body=JSON.parse(raw),n=s.registrations.push({body,headers:req.headers});
      return send(201,{client_id:`fixture-client-${n}`,redirect_uris:body.redirect_uris,token_endpoint_auth_method:c.secret?'client_secret_post':'none',...(c.secret?{client_secret:`fixture-registration-secret-${n}`,client_secret_expires_at:0}:{})});
    }
    if(req.method==='POST' && route==='/token'){
      const form=Object.fromEntries(new URLSearchParams(raw));s.tokens.push(form);
      const issue=()=>{const n=++s.issued,access=`fixture-access-${n}`,refresh=`fixture-refresh-${n}`;s.valid.set(access,form.resource);s.refresh.set(refresh,form.client_id);return send(200,{access_token:access,token_type:'Bearer',expires_in:c.expiresIn || 3600,refresh_token:refresh});};
      if(form.resource!==resource)return send(400,{error:'invalid_target'});
      if(c.secret && !String(form.client_secret || '').startsWith('fixture-registration-secret-'))return send(401,{error:'invalid_client'});
      if(form.grant_type==='authorization_code'){
        const grant=s.codes.get(form.code);s.codes.delete(form.code);
        if(!grant || sha(form.code_verifier || '')!==grant.challenge || grant.client_id!==form.client_id || grant.redirect_uri!==form.redirect_uri || grant.resource!==form.resource)return send(400,{error:'invalid_grant'});
        return issue();
      }
      if(form.grant_type==='refresh_token' && s.refresh.get(form.refresh_token)===form.client_id){s.refresh.delete(form.refresh_token);return issue();}
      return send(400,{error:'invalid_grant'});
    }
    if(route==='/mcp'){
      const token=String(req.headers.authorization || '').replace(/^Bearer /,'');
      if(!c.open && s.valid.get(token)!==resource){
        const challenge=c.challenge==='plain'?'Bearer realm="fixture"':c.challenge?`Bearer error="invalid_token", ${c.prm!=='none'?`resource_metadata="${o}${PRM_PATHS[c.prm==='header'?'header':c.prm]}", `:''}scope="tasks:read tasks:write"`:'';
        return send(401,{error:'unauthorized'},challenge?{'www-authenticate':challenge}:{});
      }
      const message=JSON.parse(raw || '{}');
      if(message.method==='notifications/initialized'){res.writeHead(202);return res.end();}
      if(message.method==='initialize')return send(200,{jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}},{'mcp-session-id':'fixture-session'});
      if(message.method==='tools/list')return send(200,{jsonrpc:'2.0',id:message.id,result:{tools:TOOLS}});
      if(message.method==='tools/call'){s.calls.push(message.params);return send(200,{jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:`Added ${message.params.arguments.title}`}]}});}
      return send(200,{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'unknown'}});
    }
    send(404,{error:'not_found'});
  });
  await new Promise(resolve=>s.server.listen(0,'127.0.0.1',resolve));
  s.origin=`http://127.0.0.1:${s.server.address().port}`;
  // The browser part of sign-in: the authorization server checks the request and issues a code for its exact PKCE challenge.
  s.authorize=authorizationUrl=>{
    const url=new URL(authorizationUrl),params=Object.fromEntries(url.searchParams);
    assert.equal(url.origin+url.pathname,`${s.origin}/authorize`);assert.equal(params.response_type,'code');assert.equal(params.code_challenge_method,'S256');
    const code=`fixture-code-${s.codes.size+s.issued+1}`;s.codes.set(code,{challenge:params.code_challenge,client_id:params.client_id,redirect_uri:params.redirect_uri,resource:params.resource});
    return {code,params};
  };
  t.after(()=>new Promise(resolve=>s.server.close(resolve)));
  return s;
}

/** The integration service alone, with an automatic-sign-in MCP integration assigned to bot_atlas. */
async function unit(t,config,options={}){
  const s=await service(t,config);
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-mcp-oauth-')),store=await new Store(directory).init();store.state.integrations=[];
  const integrations=new Integrations(store,{requestTimeout:3000,oauthDiscoveryTimeout:3000,oauthRedirectBase:REDIRECT_BASE,...options});
  t.after(async()=>{await integrations.close();await fs.rm(directory,{recursive:true,force:true});});
  const integration={...integrations.validate({name:'Fixture Tasks',type:'mcp',baseUrl:`${s.origin}/mcp`,authType:'oauth2'}),id:'integration_mcp',createdAt:new Date().toISOString()};
  await store.mutate(state=>{state.integrations.push(integration);state.bots[0].integrationIds=[integration.id];});
  const current=()=>store.state.integrations.find(item=>item.id==='integration_mcp');
  const bundle=()=>current().oauthSecret?JSON.parse(store.unseal(current().oauthSecret)):{};
  const connect=async(extra={})=>{const started=await integrations.oauth.start('integration_mcp'),{code,params}=s.authorize(started.authorizationUrl);return {started,params,result:await integrations.oauth.callback({state:params.state,code,...extra})};};
  const save=async input=>{const updated=integrations.validate(input,current());await store.mutate(state=>{state.integrations[0]=updated;});return updated;};
  return {s,store,integrations,current,bundle,connect,save,discover:()=>integrations.oauth.discover('integration_mcp')};
}
const rejectsWith=(promise,code,pattern)=>assert.rejects(promise,error=>{assert.equal(error.code,code,error.message);if(pattern)assert.match(error.message,pattern);return true;});

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=15000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=predicate();if(value)return value;await delay(5);}throw new Error('MCP OAuth fixture timed out.');}
const bridged=(id,name,args)=>({id,name:'tool_call',arguments:{name,arguments:args}});
const output=(request,id)=>JSON.parse(request.messages.findLast(message=>message.tool_call_id===id).content);

test('a bot proposes a hosted MCP server; the owner sees the hosts, signs in, and an approved tool call reaches it',async t=>{
  const s=await service(t,{secret:true});let integrationId;
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-mcp-oauth-api-')),requests=[];
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers:{
    async complete(connection,request){
      requests.push(request);const index=requests.length;
      if(index===1)return {text:'I will propose the task server.',toolCalls:[bridged('propose','integration_propose',{name:'Fixture Tasks',type:'mcp',baseUrl:`${s.origin}/mcp`,authType:'oauth2',setupNotes:'Press Sign in; no key is needed.',reason:'You asked me to add tasks.'})]};
      if(index===2){const result=output(request,'propose');integrationId=result.integrationId;assert.deepEqual({status:result.status,connect:result.connect,actions:result.actions},{status:'needs_credentials',connect:{required:true,how:'oauth'},actions:[]});return {text:'Connect Fixture Tasks in the card below.',toolCalls:[]};}
      if(index===3)return {text:'',toolCalls:[bridged('add','integration_call',{integrationId,tool:'add_task',arguments:{title:'Buy milk'}})]};
      assert.equal(output(request,'add').content[0].text,'Added Buy milk');return {text:'Added the task.',toolCalls:[]};
    },
    async reviewAction(connection,request){const payload=JSON.parse(request.messages[1].content);return {toolCalls:[{name:'action_review_result',arguments:{actionDigest:payload.actionDigest,decision:'approve',risks:[],reason:'Fixture approves.'}}],usage:{input_tokens:1,output_tokens:1}};},
  }});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0,'127.0.0.1');let cookie='',csrf='';
  const api=async(route,{method='GET',data}={})=>{const response=await fetch(url+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json(),headers:response.headers};};
  const setup=await api('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'mcp-oauth-fixture-password'}});cookie=setup.headers.get('set-cookie').split(';')[0];csrf=setup.body.csrf;
  const store=app.store,run=()=>store.state.runs.bot_atlas;
  await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture-model'});state.integrations=[];for(const bot of state.bots){bot.connectionId='fixture';bot.approvalPolicy='auto';}});
  async function say(text){
    const sent=await api('/api/bots/bot_atlas/messages',{method:'POST',data:{text}});assert.equal(sent.status,202,JSON.stringify(sent.body));const runId=sent.body.run.id,controls=[];
    while(true){
      await until(()=>run()?.id!==runId || !isActive(run()) || run().status==='waiting_for_approval' && app.runtime.pending.get(runId)?.promptId===run().pending_controls?.[0]?.prompt_id);
      if(run().id!==runId || !isActive(run()))break;
      const control=run().pending_controls[0];controls.push(structuredClone(control));
      assert.equal((await api('/api/bots/bot_atlas/approval',{method:'POST',data:{runId,remoteRunId:run().remoteRunId,request_id:control.prompt_id,execution_generation:run().execution_generation,choice:'once'}})).status,200);
      await until(()=>run().pending_controls?.[0]?.prompt_id!==control.prompt_id);
    }
    await app.runtime.tasks.get(runId);return {run:run(),controls,reply:store.state.messages.bot_atlas.findLast(message=>message.role==='assistant' && message.runId===runId)};
  }
  const first=await say('Add my tasks to Fixture Tasks.');
  assert.equal(first.run.status,'completed',first.run.error);assert.equal(first.controls.length,1);
  const host=new URL(s.origin).host;
  assert.equal(first.controls[0].review.summary,`Add a connection “Fixture Tasks” to ${host} — its tools are discovered after you sign in. Sign-in: found from the server when you connect; you see the sign-in address before you sign in.`);
  assert.deepEqual(first.reply.connectionRequests,[{integrationId,name:'Fixture Tasks',how:'oauth'}]);
  assert.equal(s.log.length,0,'no request reached the proposed server before the owner asked for discovery');
  let listed=store.state.integrations.find(item=>item.id===integrationId);
  assert.deepEqual(listed.oauth,{auto:true,authorizationUrl:'',tokenUrl:'',scopes:[],clientId:'',extraParams:{},tokenAuth:'body',connected:false});assert.equal(listed.status,'needs_credentials');
  // Sign-in cannot start before the owner has seen where it leads.
  const early=await api(`/api/integrations/${integrationId}/oauth/start`,{method:'POST',data:{}});
  assert.equal(early.status,409);assert.equal(early.body.code,'oauth_discovery_required');assert.equal(s.log.length,0);
  const found=await api(`/api/integrations/${integrationId}/oauth/discover`,{method:'POST',data:{}});
  assert.equal(found.status,200,JSON.stringify(found.body));
  assert.deepEqual({authorizationHost:found.body.authorizationHost,tokenHost:found.body.tokenHost,issuer:found.body.issuer,scopes:found.body.scopes,registration:found.body.registration,registered:found.body.registered},{authorizationHost:host,tokenHost:host,issuer:`${s.origin}/tenant`,scopes:['tasks:read','tasks:write'],registration:'dynamic',registered:true});
  const oauth=found.body.integration.oauth;
  assert.deepEqual({auto:oauth.auto,authorizationUrl:oauth.authorizationUrl,tokenUrl:oauth.tokenUrl,clientId:oauth.clientId,issuer:oauth.issuer,resource:oauth.resource,registration:oauth.registration,registeredRedirectUri:oauth.registeredRedirectUri,connected:oauth.connected},{auto:true,authorizationUrl:`${s.origin}/authorize`,tokenUrl:`${s.origin}/token`,clientId:'fixture-client-1',issuer:`${s.origin}/tenant`,resource:`${s.origin}/mcp`,registration:'dynamic',registeredRedirectUri:`${url}/api/integrations/oauth/callback`,connected:false});
  assert.ok(Date.parse(oauth.discoveredAt));assert.equal(found.body.integration.hasOAuthClientSecret,true);
  assert.deepEqual(s.log.map(entry=>`${entry.method} ${entry.path}`),['POST /mcp','GET /.well-known/oauth-protected-resource/mcp','GET /.well-known/oauth-authorization-server/tenant','POST /register']);
  assert.ok(s.log.every(entry=>!entry.authorization),'discovery and registration carry no credential');
  assert.deepEqual(s.registrations[0].body,{client_name:'Tupies',redirect_uris:[`${url}/api/integrations/oauth/callback`],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',application_type:'native'});
  // Idempotent: the registered client fits, so nothing is registered again.
  const again=await api(`/api/integrations/${integrationId}/oauth/discover`,{method:'POST',data:{}});
  assert.equal(again.body.registered,false);assert.equal(again.body.integration.oauth.clientId,'fixture-client-1');assert.equal(s.registrations.length,1);
  const started=await api(`/api/integrations/${integrationId}/oauth/start`,{method:'POST',data:{}});assert.equal(started.status,200);
  const {code,params}=s.authorize(started.body.authorizationUrl);
  assert.deepEqual({client_id:params.client_id,resource:params.resource,scope:params.scope,redirect_uri:params.redirect_uri},{client_id:'fixture-client-1',resource:`${s.origin}/mcp`,scope:'tasks:read tasks:write',redirect_uri:`${url}/api/integrations/oauth/callback`});
  const page=await fetch(`${url}/api/integrations/oauth/callback?state=${encodeURIComponent(params.state)}&code=${code}&iss=${encodeURIComponent(`${s.origin}/tenant`)}`);
  assert.equal(page.status,200);assert.match(await page.text(),/Connected — you can close this tab/);
  assert.deepEqual(s.tokens[0],{grant_type:'authorization_code',code,redirect_uri:`${url}/api/integrations/oauth/callback`,code_verifier:s.tokens[0].code_verifier,client_id:'fixture-client-1',client_secret:'fixture-registration-secret-1',resource:`${s.origin}/mcp`});
  listed=store.state.integrations.find(item=>item.id===integrationId);
  assert.equal(listed.status,'connected');assert.deepEqual(listed.tools.map(tool=>tool.name),['list_tasks','add_task'],'tools are listed right after sign-in');
  assert.ok(store.state.activity.some(event=>event.type==='integration.oauth_registered' && event.integrationId===integrationId));
  const second=await say('Connected. Add “Buy milk”.');
  assert.equal(second.run.status,'completed',second.run.error);assert.equal(second.reply.content,'Added the task.');
  assert.deepEqual(s.calls,[{name:'add_task',arguments:{title:'Buy milk'}}]);
  assert.ok(s.log.filter(entry=>entry.path==='/mcp' && entry.authorization).every(entry=>entry.authorization==='Bearer fixture-access-1'),'the MCP server gets only its own token');
  assert.ok(s.log.filter(entry=>entry.path!=='/mcp').every(entry=>!entry.authorization),'no other request carries the token');
  // No secret appears anywhere the owner, the model or the logs can read.
  const secrets=['fixture-registration-secret-1','fixture-access-1','fixture-refresh-1',code,s.tokens[0].code_verifier];
  const state=JSON.stringify((await api('/api/state')).body),run_=JSON.stringify(second.run),events=JSON.stringify(store.state.activity),disk=await fs.readFile(store.file,'utf8');
  for(const secret of secrets)for(const [where,text] of Object.entries({discover:JSON.stringify([found.body,again.body,started.body]),state,run:run_,events,model:JSON.stringify(requests),disk}))assert.ok(!text.includes(secret),`${where} must not contain ${secret}`);
  // Error codes travel to the owner as JSON.
  const bearer=await api('/api/integrations',{method:'POST',data:{name:'Plain',type:'mcp',baseUrl:`${s.origin}/mcp`,authType:'bearer',apiKey:'fixture-plain-key'}});
  const refused=await api(`/api/integrations/${bearer.body.id}/oauth/discover`,{method:'POST',data:{}});assert.equal(refused.status,409);assert.equal(refused.body.code,'not_auto_oauth');
  // No public HTTPS origin, so no client ID metadata document is served.
  const document=await fetch(`${url}/api/integrations/oauth/client.json`);assert.equal(document.status,404);
});

test('discovery follows each well-known variant in the specification order',async t=>{
  for(const [config,expected] of [
    [{challenge:'plain',prm:'path',as:'oidc-append'},['POST /mcp','GET /.well-known/oauth-protected-resource/mcp','GET /.well-known/oauth-authorization-server/tenant','GET /.well-known/openid-configuration/tenant','GET /tenant/.well-known/openid-configuration']],
    [{challenge:false,prm:'root',as:'oidc-insert'},['POST /mcp','GET /.well-known/oauth-protected-resource/mcp','GET /.well-known/oauth-protected-resource','GET /.well-known/oauth-authorization-server/tenant','GET /.well-known/openid-configuration/tenant']],
    [{prm:'header',as:'root',resource:'ORIGIN'},['POST /mcp','GET /meta/resource.json','GET /.well-known/oauth-authorization-server']],
  ]){
    const f=await unit(t,config);if(config.resource)f.s.config.resource=f.s.origin;
    const result=await f.discover();
    assert.deepEqual(f.s.log.filter(entry=>entry.path!=='/register').map(entry=>`${entry.method} ${entry.path}`),expected,JSON.stringify(config));
    assert.equal(result.registration,'dynamic');assert.equal(f.current().oauth.resource,config.resource?f.s.origin:`${f.s.origin}/mcp`);
    assert.deepEqual(result.scopes,['tasks:read','tasks:write'],'challenge scope, else the resource’s scopes_supported');
  }
});

test('2025-03-26 servers: metadata at the MCP origin, or the default endpoints there',async t=>{
  const legacy=await unit(t,{challenge:'plain',prm:'none',as:'legacy'});
  const found=await legacy.discover();
  assert.deepEqual(legacy.s.log.map(entry=>`${entry.method} ${entry.path}`),['POST /mcp','GET /.well-known/oauth-protected-resource/mcp','GET /.well-known/oauth-protected-resource','GET /.well-known/oauth-authorization-server','POST /register']);
  assert.equal(found.issuer,legacy.s.origin);assert.equal(legacy.current().oauth.resource,`${legacy.s.origin}/mcp`);
  await legacy.connect();assert.equal(legacy.current().status,'connected');assert.equal(legacy.s.tokens[0].resource,`${legacy.s.origin}/mcp`);
  const defaults=await unit(t,{challenge:'plain',prm:'none',as:'none'});
  const result=await defaults.discover();
  assert.deepEqual({authorizationUrl:defaults.current().oauth.authorizationUrl,tokenUrl:defaults.current().oauth.tokenUrl,registration:result.registration},{authorizationUrl:`${defaults.s.origin}/authorize`,tokenUrl:`${defaults.s.origin}/token`,registration:'dynamic'});
  await defaults.connect();assert.equal(defaults.current().status,'connected');assert.equal(defaults.current().tools.length,2);
});

test('a server without usable metadata is refused in plain words',async t=>{
  const none=await unit(t,{challenge:'plain',prm:'none',as:'none',dcr:false});
  await rejectsWith(none.discover(),'oauth_discovery_failed',/may need a token instead/);
  assert.equal(none.current().oauth.discoveredAt,undefined);
  // An open server with nothing published is not guessed at either: no default endpoints without a 401.
  const open=await unit(t,{open:true,prm:'none',as:'none'});
  await rejectsWith(open.discover(),'oauth_discovery_failed',/may need a token instead/);assert.equal(open.s.registrations.length,0);
  for(const [config,pattern] of [
    [{s256:false},/PKCE with S256/],
    [{issuer:'https://honest.example'},/different issuer/],
    [{resource:'http://127.0.0.1:1/other'},/different resource/],
    [{prmRaw:'<html>not json</html>',prmType:'text/html'},/not valid JSON/],
    [{prmRaw:'{}',prmType:'text/plain'},/not a JSON object/],
    [{prmRaw:'[1,2]'},/not a JSON object/],
    [{prmRaw:JSON.stringify({resource:'x',pad:'y'.repeat(300_000)})},/larger than 256 KB/],
    [{prmExtra:{authorization_servers:'not a list'}},/names no authorization server/],
    [{asExtra:{authorization_endpoint:'https://169.254.169.254/authorize'}},/unsafe authorization endpoint/],
    [{asExtra:{authorization_endpoint:'https://auth.example/authorize?client_id=evil'}},/presets sign-in parameters/],
  ]){
    const f=await unit(t,config);
    await rejectsWith(f.discover(),'oauth_discovery_failed',pattern);
    assert.equal(f.current().oauth.discoveredAt,undefined,JSON.stringify(config).slice(0,80));assert.equal(f.s.registrations.length,0);
  }
  // A malicious document cannot pollute prototypes; unknown keys are ignored.
  const polluted=await unit(t,{prmExtra:JSON.parse('{"__proto__":{"polluted":true}}')});await polluted.discover();assert.equal(({}).polluted,undefined);
});

test('remote URLs are validated: public HTTPS only, no private or loopback targets from a public server',()=>{
  const strict=new OAuthDiscovery({baseUrl:'https://mcp.example.com/mcp'});
  for(const value of ['http://auth.example.com/authorize','https://10.0.0.5/token','https://127.0.0.1/token','http://localhost:4310/api','https://user:pw@auth.example.com/x','https://auth.example.com/x#frag','',42])assert.throws(()=>strict.url(value,'token endpoint'),error=>error.code==='oauth_discovery_failed',String(value));
  assert.equal(strict.url('https://auth.example.com/token','token endpoint').host,'auth.example.com');
  assert.throws(()=>strict.url('https://auth.example.com/token?x=1','token endpoint'),/unsafe/);
  const local=new OAuthDiscovery({baseUrl:'http://127.0.0.1:9000/mcp'});assert.equal(local.url('http://127.0.0.1:9000/token','token endpoint').port,'9000');
  const privateNet=new OAuthDiscovery({baseUrl:'https://mcp.internal.example/mcp',allowPrivateHttp:true});assert.equal(privateNet.url('http://10.0.0.5/token','token endpoint').host,'10.0.0.5');
  assert.deepEqual(parseChallenge('Bearer error="invalid_token", resource_metadata="https://a.example/.well-known/oauth-protected-resource/mcp", scope="files:read files:write"'),{resourceMetadata:'https://a.example/.well-known/oauth-protected-resource/mcp',scopes:['files:read','files:write']});
  assert.deepEqual(parseChallenge(['Basic realm="x"','Bearer resource_metadata=https://b.example/m']),{resourceMetadata:'https://b.example/m',scopes:[]});
  assert.deepEqual(parseChallenge(undefined),{resourceMetadata:'',scopes:[]});
  assert.deepEqual(resourceMetadataUrls('https://a.example/public/mcp'),['https://a.example/.well-known/oauth-protected-resource/public/mcp','https://a.example/.well-known/oauth-protected-resource']);
  assert.deepEqual(resourceMetadataUrls('https://a.example'),['https://a.example/.well-known/oauth-protected-resource']);
  assert.deepEqual(authorizationServerUrls('https://auth.example.com/tenant1'),['https://auth.example.com/.well-known/oauth-authorization-server/tenant1','https://auth.example.com/.well-known/openid-configuration/tenant1','https://auth.example.com/tenant1/.well-known/openid-configuration']);
  assert.deepEqual(authorizationServerUrls('https://auth.example.com/'),['https://auth.example.com/.well-known/oauth-authorization-server','https://auth.example.com/.well-known/openid-configuration']);
  for(const [resource,ok] of [['https://mcp.example.com/mcp',true],['https://MCP.example.com',true],['https://mcp.example.com/',true],['https://mcp.example.com/m',false],['https://mcp.example.com/mcp/v2',false],['https://evil.example.com/mcp',false],['https://mcp.example.com/mcp#x',false]])assert.equal(resourceMatches(resource,'https://mcp.example.com/mcp'),ok,resource);
});

test('no registration endpoint: the owner enters a client ID; a refused registration is reported',async t=>{
  const f=await unit(t,{dcr:false});
  const result=await f.discover();
  assert.deepEqual({registration:result.registration,registered:result.registered,clientId:f.current().oauth.clientId,authorizationUrl:f.current().oauth.authorizationUrl},{registration:'manual_required',registered:false,clientId:'',authorizationUrl:`${f.s.origin}/authorize`});
  await assert.rejects(f.integrations.oauth.start('integration_mcp'),/Add the OAuth client ID/);
  assert.throws(()=>f.integrations.validate({oauth:{tokenUrl:'https://elsewhere.example/token'}},f.current()),/come from the server/);
  await f.save({oauth:{clientId:'fixture-owner-client'}});
  await f.connect();assert.equal(f.current().status,'connected');assert.equal(f.s.tokens[0].client_id,'fixture-owner-client');
  // Running discovery again keeps the owner's client and the sign-in while the server stays the same.
  await f.discover();assert.equal(f.current().oauth.clientId,'fixture-owner-client');assert.equal(f.current().oauth.connected,true);
  const refused=await unit(t,{dcr:'refuse'});
  await rejectsWith(refused.discover(),'oauth_registration_failed',/refused to register Tupies as an app \(invalid_client_metadata\)/);
  assert.equal(refused.current().oauth.discoveredAt,undefined);
});

test('a changed address clears discovery, registration and tokens; a changed return address registers again',async t=>{
  const f=await unit(t,{secret:true});await f.discover();await f.connect();
  assert.equal(f.current().oauth.connected,true);
  const moved=f.integrations.validate({baseUrl:`${f.s.origin}/mcp2`},f.current());
  assert.deepEqual(moved.oauth,{auto:true,authorizationUrl:'',tokenUrl:'',scopes:[],clientId:'',extraParams:{},tokenAuth:'body',connected:false});
  assert.equal(moved.oauthSecret,undefined,'the registered secret and tokens are forgotten');assert.equal(moved.status,'needs_credentials');
  // A renamed integration keeps everything; owner edits of discovered fields are refused, echoes of them are accepted.
  const echoed=f.integrations.validate({name:'Renamed',oauth:{...f.current().oauth}},f.current());assert.equal(echoed.oauth.connected,true);assert.equal(echoed.oauth.clientId,'fixture-client-1');
  assert.throws(()=>f.integrations.validate({oauth:{clientId:'other'}},f.current()),/registered its own client/);
  assert.throws(()=>f.integrations.validate({oauthClientSecret:'fixture-other-secret'},f.current()),/no client secret/);
  assert.throws(()=>f.integrations.validate({oauth:{extraParams:{resource:'https://evil.example'}}},f.current()),/set by Tupies/);
  // The engine is now reached at another address: sign-in waits for discovery, which registers for the new return address.
  f.integrations.oauth.redirectBase=()=>'http://127.0.0.1:5999';
  await rejectsWith(f.integrations.oauth.start('integration_mcp'),'oauth_discovery_required',/return address changed/);
  const result=await f.discover();
  assert.equal(result.registered,true);assert.equal(f.s.registrations.length,2);assert.deepEqual(f.s.registrations[1].body.redirect_uris,['http://127.0.0.1:5999/api/integrations/oauth/callback']);
  assert.equal(f.current().oauth.clientId,'fixture-client-2');assert.equal(f.current().oauth.connected,false,'a new client needs a new sign-in');
  assert.deepEqual(Object.keys(f.bundle()),['client_secret']);
  // Turning automatic sign-in off keeps the discovered endpoints as editable manual values.
  const manual=f.integrations.validate({oauth:{auto:false}},f.current());
  assert.equal(manual.oauth.auto,undefined);assert.equal(manual.oauth.tokenUrl,`${f.s.origin}/token`);assert.equal(manual.oauth.resource,`${f.s.origin}/mcp`);
});

test('renewals send the resource, a mismatched issuer response is dropped, and the iss parameter is enforced when promised',async t=>{
  const f=await unit(t,{issParam:true,expiresIn:30});await f.discover();
  assert.equal(f.current().oauth.issParameter,true);
  const started=await f.integrations.oauth.start('integration_mcp'),{code,params}=f.s.authorize(started.authorizationUrl);
  await assert.rejects(f.integrations.oauth.callback({state:params.state,code}),/did not name its sign-in server/);
  const again=await f.integrations.oauth.start('integration_mcp'),second=f.s.authorize(again.authorizationUrl);
  await assert.rejects(f.integrations.oauth.callback({state:second.params.state,code:second.code,iss:'https://attacker.example'}),/different sign-in server/);
  assert.equal(f.s.tokens.length,0,'no code reached a token endpoint');
  await f.connect({iss:`${f.s.origin}/tenant`});assert.equal(f.current().status,'connected');
  // The 30-second token renews before the next call, with the same resource.
  await f.integrations.call('integration_mcp','list_tasks',{},{approved:true,botId:'bot_atlas'});
  const refresh=f.s.tokens.find(form=>form.grant_type==='refresh_token');assert.equal(refresh.resource,`${f.s.origin}/mcp`);assert.equal(refresh.client_id,'fixture-client-1');
  // A token the server stops accepting and cannot renew asks for sign-in again; it never re-runs discovery.
  f.s.valid.clear();f.s.refresh.clear();const before=f.s.log.length;
  await assert.rejects(f.integrations.call('integration_mcp','add_task',{title:'x'},{approved:true,botId:'bot_atlas'}),/sign in again/);
  assert.equal(f.current().status,'needs_reauth');
  assert.ok(f.s.log.slice(before).every(entry=>!entry.path.includes('.well-known') && entry.path!=='/register'));
});

test('with a public HTTPS origin a metadata-document client is used; REST cannot use automatic sign-in',async t=>{
  const f=await unit(t,{cimd:true},{oauthPublicOrigin:'https://tupies.example.com',oauthRedirectBase:'https://tupies.example.com'});
  const result=await f.discover();
  assert.deepEqual({registration:result.registration,registered:result.registered,clientId:f.current().oauth.clientId},{registration:'metadata_document',registered:false,clientId:'https://tupies.example.com/api/integrations/oauth/client.json'});
  assert.equal(f.s.registrations.length,0);
  assert.deepEqual(f.integrations.oauth.clientMetadata(),{client_id:'https://tupies.example.com/api/integrations/oauth/client.json',client_name:'Tupies',redirect_uris:['https://tupies.example.com/api/integrations/oauth/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'});
  const started=await f.integrations.oauth.start('integration_mcp');assert.equal(new URL(started.authorizationUrl).searchParams.get('client_id'),'https://tupies.example.com/api/integrations/oauth/client.json');
  // Without CIMD support at the server, the same engine falls back to dynamic registration with a web application type.
  const dcr=await unit(t,{},{oauthPublicOrigin:'https://tupies.example.com',oauthRedirectBase:'https://tupies.example.com'});
  assert.equal((await dcr.discover()).registration,'dynamic');assert.equal(dcr.s.registrations[0].body.application_type,'web');
  assert.throws(()=>f.integrations.validate({name:'REST',type:'rest',baseUrl:'https://api.example.com',authType:'oauth2',oauth:{auto:true},tools:[{name:'read',method:'GET',path:'/x',inputSchema:{type:'object'}}]}),/only for MCP servers/);
  assert.throws(()=>f.integrations.validate({name:'REST',type:'rest',baseUrl:'https://api.example.com',authType:'oauth2',tools:[{name:'read',method:'GET',path:'/x',inputSchema:{type:'object'}}]}),/authorization and token URLs/);
  assert.equal(proposalApprovalSummary({integrations:[]},{name:'Todoist',type:'mcp',baseUrl:'https://ai.todoist.net/mcp',authType:'oauth2'}),'Add a connection “Todoist” to ai.todoist.net — its tools are discovered after you sign in. Sign-in: found from the server when you connect; you see the sign-in address before you sign in.');
  // The served document over HTTP, without a session.
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-mcp-oauth-cimd-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,publicUrl:'https://tupies.example.com',secureCookie:false});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0,'127.0.0.1');
  const response=await fetch(`${url}/api/integrations/oauth/client.json`);assert.equal(response.status,200);
  assert.deepEqual(await response.json(),f.integrations.oauth.clientMetadata());
});

test('owner API: error codes reach the JSON body; the settings dialog can switch sign-in modes',async t=>{
  const s=await service(t,{dcr:'refuse'}),bare=await service(t,{challenge:'plain',prm:'none',as:'none',dcr:false});
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-mcp-oauth-modes-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0,'127.0.0.1');
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'mcp-oauth-modes-password'})});
  const {csrf}=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  const api=async(route,method='GET',data)=>{const response=await fetch(url+route,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json()};};
  const create=async origin=>(await api('/api/integrations','POST',{name:'Tasks',type:'mcp',baseUrl:`${origin}/mcp`,authType:'oauth2'})).body;
  const refused=await create(s.origin),failed=await create(bare.origin);
  for(const [integration,status,code] of [[refused,502,'oauth_registration_failed'],[failed,502,'oauth_discovery_failed']]){
    const response=await api(`/api/integrations/${integration.id}/oauth/discover`,'POST',{});
    assert.equal(response.status,status);assert.equal(response.body.code,code);assert.equal(typeof response.body.error,'string');
  }
  // The dialog saves automatic sign-in as {auto:true}; before discovery the endpoints are empty strings.
  let saved=await api(`/api/integrations/${failed.id}`,'PATCH',{authType:'oauth2',oauth:{auto:true}});
  assert.equal(saved.status,200);assert.deepEqual([saved.body.oauth.auto,saved.body.oauth.authorizationUrl,saved.body.oauth.tokenUrl],[true,'','']);
  // Manual path: the usual fields plus auto:false, on MCP and on REST.
  const manual={auto:false,authorizationUrl:`${bare.origin}/authorize`,tokenUrl:`${bare.origin}/token`,scopes:['tasks'],clientId:'fixture-manual-client'};
  saved=await api(`/api/integrations/${failed.id}`,'PATCH',{authType:'oauth2',oauth:manual});
  assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.oauth.auto,undefined);assert.equal(saved.body.oauth.clientId,'fixture-manual-client');
  const rest=await api('/api/integrations','POST',{name:'REST',type:'rest',baseUrl:bare.origin,authType:'oauth2',oauth:manual,tools:[{name:'read',method:'GET',path:'/x',inputSchema:{type:'object'}}]});
  assert.equal(rest.status,201,JSON.stringify(rest.body));assert.equal(rest.body.oauth.auto,undefined);
  const restAuto=await api(`/api/integrations/${rest.body.id}`,'PATCH',{oauth:{auto:true}});assert.equal(restAuto.status,400);
  // "Use a token instead": bearer alone keeps the name and address, drops all OAuth state and waits for the key.
  saved=await api(`/api/integrations/${refused.id}`,'PATCH',{authType:'bearer'});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.deepEqual({name:saved.body.name,baseUrl:saved.body.baseUrl,authType:saved.body.authType,oauth:saved.body.oauth,status:saved.body.status,ready:saved.body.ready},{name:'Tasks',baseUrl:`${s.origin}/mcp`,authType:'bearer',oauth:undefined,status:'needs_credentials',ready:false});
});
