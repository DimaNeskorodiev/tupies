import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { executeIntegrationProposal, proposalApprovalSummary, integrationPrecheck } from '../lib/integration-proposals.mjs';
import { listWorkshopSources } from '../lib/workshop-gateway.mjs';
import { gmailPreset, gmailDefinition, GMAIL_API, GOOGLE_AUTHORIZATION_URL, GOOGLE_TOKEN_URL, GMAIL_MODIFY_SCOPE } from '../lib/gmail.mjs';
import { createStudioServer } from '../server.mjs';

// Focused rules where the three parts of bot-authored connections meet: presets, what a bot's update keeps, readiness
// and the hints the model sees.

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-integration-connections-')),store=await new Store(directory).init();store.state.integrations=[];
  const integrations=new Integrations(store,{allowPrivateHttp:true,oauthRedirectBase:'http://127.0.0.1:4999'});
  t.after(async()=>{await integrations.close();await fs.rm(directory,{recursive:true,force:true});});
  const bot=store.state.bots[0];
  return {store,integrations,bot,tools:{store,options:{integrations}}};
}
const definition=gmailDefinition({baseUrl:'https://mail.example.com',authorizationUrl:'https://accounts.example.com/auth',tokenUrl:'https://oauth.example.com/token'});
/** A Gmail-like integration the bot proposed, with the owner's client and a stored sign-in. */
async function connected(f) {
  const integration={...f.integrations.validate({...definition,oauth:{...definition.oauth,clientId:'client-1'},oauthClientSecret:'client-secret-1'},{},{allowMissingCredential:true}),id:'integration_mail',createdAt:new Date().toISOString(),proposedBy:{botId:f.bot.id}};
  integration.oauthSecret=f.store.seal(JSON.stringify({client_secret:'client-secret-1',access_token:'access-token-1',refresh_token:'refresh-token-1'}));
  integration.oauth={...integration.oauth,connected:true,connectionId:'oauthconn_1',connectedAt:new Date().toISOString()};integration.status='connected';
  await f.store.mutate(state=>{state.integrations=[integration];state.bots[0].integrationIds=[integration.id];});
  f.bot.integrationIds=[integration.id];
  return integration;
}
const current=f=>f.store.state.integrations.find(item=>item.id==='integration_mail');
const bundle=f=>Object.keys(JSON.parse(f.store.unseal(current(f).oauthSecret))).sort();

test('the Gmail preset uses Google endpoints, one scope and no delete, and every catalog preset validates once completed',async t=>{
  const f=await fixture(t),catalog=f.integrations.catalog(),gmail=catalog.find(item=>item.id==='gmail');
  assert.deepEqual(gmail,gmailPreset());
  assert.deepEqual({baseUrl:gmail.baseUrl,authType:gmail.authType,authorizationUrl:gmail.oauth.authorizationUrl,tokenUrl:gmail.oauth.tokenUrl,scopes:gmail.oauth.scopes,extra:gmail.oauth.extraParams},{baseUrl:GMAIL_API,authType:'oauth2',authorizationUrl:GOOGLE_AUTHORIZATION_URL,tokenUrl:GOOGLE_TOKEN_URL,scopes:[GMAIL_MODIFY_SCOPE],extra:{access_type:'offline',prompt:'consent'}});
  assert.deepEqual(gmail.tools.map(tool=>`${tool.method} ${tool.name}`),['GET search_messages','GET read_message','POST send_message','POST modify_labels']);
  assert.ok(!gmail.tools.some(tool=>tool.method==='DELETE'),'permanent delete is not in the preset');assert.match(gmail.setupNotes,/Web application/);
  for(const preset of catalog) {
    const input={...preset,baseUrl:preset.baseUrl || 'https://service.example.com',...(preset.type==='rest' && !preset.tools?{tools:[{name:'read',method:'GET',path:'/items',inputSchema:{type:'object',properties:{}}}]}:{}),...(preset.authType==='oauth2'?{oauth:{...preset.oauth,clientId:'dummy-client'},oauthClientSecret:'dummy-client-secret'}:preset.authType==='none'?{}:{apiKey:'dummy-key'})};
    const value=f.integrations.validate(input);assert.equal(value.type,preset.type,preset.id);
    if(preset.id==='gmail')assert.deepEqual({status:value.status,tools:value.tools.length,clientId:value.oauth.clientId},{status:'needs_credentials',tools:4,clientId:'dummy-client'});
  }
  // The owner's catalog route serves it.
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-integration-catalog-')),app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0,'127.0.0.1');
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'integration-catalog-fixture-password'})});
  const served=await (await fetch(url+'/api/integrations/catalog',{headers:{Cookie:setup.headers.get('set-cookie').split(';')[0]}})).json();
  assert.deepEqual(served.integrations.find(item=>item.id==='gmail'),JSON.parse(JSON.stringify(gmailPreset())));
});

test('a bot update keeps the sign-in unless the address or endpoints change, and the approval card says exactly that',async t=>{
  const f=await fixture(t);await connected(f);
  const host='mail.example.com',login='Sign-in: OAuth at accounts.example.com (tokens from oauth.example.com).';
  const propose=args=>{const summary=proposalApprovalSummary(f.store.state,{integrationId:'integration_mail',reason:'Test.',...args});return executeIntegrationProposal(f.tools,f.bot,{integrationId:'integration_mail',reason:'Test.',...args}).then(result=>({summary,result}));};
  // Identical settings resent: nothing changes, nothing is removed.
  let {summary,result}=await propose({oauth:structuredClone(definition.oauth)});
  assert.equal(summary,`Change the connection “Gmail” at ${host}. ${login}`);
  assert.deepEqual({status:result.status,removed:result.credentialRemoved,connected:current(f).oauth.connected,id:current(f).oauth.connectionId},{status:'connected',removed:undefined,connected:true,id:'oauthconn_1'});
  assert.deepEqual(bundle(f),['access_token','client_secret','refresh_token']);
  // A narrower or wider scope keeps the sign-in and suggests a new one.
  ({summary,result}=await propose({oauth:{...definition.oauth,scopes:[GMAIL_MODIFY_SCOPE,'https://www.googleapis.com/auth/gmail.labels']}}));
  assert.equal(summary,`Change the connection “Gmail” at ${host}: change its sign-in. ${login} It asks for different permissions: the current sign-in keeps working, and you sign in again to grant them.`);
  assert.deepEqual({removed:result.credentialRemoved,connected:current(f).oauth.connected,reauth:current(f).oauth.reauthSuggested,status:current(f).status},{removed:undefined,connected:true,reauth:true,status:'connected'});
  // A new authorization endpoint forgets the tokens but keeps the client secret, which is sent only to the unchanged token endpoint.
  ({summary,result}=await propose({oauth:{...definition.oauth,authorizationUrl:'https://accounts.example.com/v2/auth'}}));
  assert.equal(summary,`Change the connection “Gmail” at ${host}: change its sign-in. ${login} Its saved key or sign-in will be removed and you connect it again.`);
  assert.deepEqual({removed:result.credentialRemoved,status:result.status,connected:current(f).oauth.connected},{removed:true,status:'needs_credentials',connected:false});
  assert.deepEqual(bundle(f),['client_secret']);
  // A new token endpoint also removes the client secret, so it can never be sent to an address the owner did not set it up for.
  await connected(f);
  ({summary,result}=await propose({oauth:{...definition.oauth,tokenUrl:'https://elsewhere.example.net/token'}}));
  assert.equal(summary,`Change the connection “Gmail” at ${host}: change its sign-in. Sign-in: OAuth at accounts.example.com (tokens from elsewhere.example.net). Its saved key or sign-in will be removed and you connect it again. Its saved OAuth client secret will be removed too.`);
  assert.equal(result.credentialRemoved,true);assert.equal(current(f).oauthSecret,undefined);assert.equal(f.store.integrationPublic(current(f)).hasOAuthClientSecret,false);assert.equal(current(f).oauth.clientId,'client-1');
});

test('needs_reauth survives a bot update and reads differently in integration_list; encoded inputs carry a hint',async t=>{
  const f=await fixture(t);await connected(f);
  await f.store.mutate(state=>{const item=state.integrations[0];item.oauth={...item.oauth,connected:false};delete item.oauth.connectionId;item.oauthSecret=f.store.seal(JSON.stringify({client_secret:'client-secret-1'}));item.status='needs_reauth';});
  const result=await executeIntegrationProposal(f.tools,f.bot,{integrationId:'integration_mail',tools:definition.tools.slice(0,2),reason:'Fewer actions.'});
  assert.deepEqual({status:result.status,connect:result.connect},{status:'needs_reauth',connect:{required:true,how:'oauth'}});
  const [entry]=f.integrations.listTools(f.bot);assert.deepEqual({ready:entry.ready,status:entry.status},{ready:false,status:'needs_reauth'});assert.match(entry.notice,/needs the owner to sign in again/);
  await connected(f);
  const listed=f.integrations.listTools(f.bot),send=listed.find(item=>item.name==='send_message'),read=listed.find(item=>item.name==='read_message');
  assert.equal(send.description,`${definition.tools[2].description} (raw: write plain text; it is sent base64url-encoded.)`);assert.equal(read.description,definition.tools[1].description);
});

test('only credential-like extra sign-in parameters are refused; ordinary provider settings pass',()=>{
  const context={bot:{id:'bot_atlas',tools:['integrations'],integrationIds:[]},source:'chat',sessionId:'bot_atlas'};
  const check=extraParams=>integrationPrecheck({integrations:[]},context,{name:'integration_propose',arguments:{...definition,oauth:{...definition.oauth,extraParams},reason:'x'}})?.errorCode;
  for(const name of ['access_type','prompt','token_access_type','include_granted_scopes','login_hint','audience','response_mode','duration'])assert.notEqual(check({[name]:'x'}),'credential_not_allowed',name);
  for(const name of ['client_secret','api_key','apiKey','access_token','refresh_token','id_token','password','client_assertion'])assert.equal(check({[name]:'x'}),'credential_not_allowed',name);
  for(const header of ['Authorization','X-Api-Key','Cookie','X-Auth-Token'])assert.equal(integrationPrecheck({integrations:[]},context,{name:'integration_propose',arguments:{...definition,headers:{[header]:'x'},reason:'x'}})?.errorCode,'credential_not_allowed',header);
});

test('Workshop API reads list only connected integrations',async t=>{
  const f=await fixture(t);
  const waiting={...f.integrations.validate({name:'Items',type:'rest',baseUrl:'https://items.example.com',authType:'bearer',tools:[{name:'list',method:'GET',path:'/items',inputSchema:{type:'object',properties:{}}}]},{},{allowMissingCredential:true}),id:'integration_items',status:'needs_credentials'};
  await f.store.mutate(state=>{state.integrations=[waiting];Object.assign(state.bots[0],{tools:['workshop','integrations'],integrationIds:['integration_items']});});
  const bot=f.store.state.bots[0];
  assert.deepEqual(listWorkshopSources(f.store,bot,f.integrations).sources,[]);
  await f.store.mutate(state=>{state.integrations[0].secret=f.store.seal('items-key');});
  assert.deepEqual(listWorkshopSources(f.store,bot,f.integrations).sources.map(item=>item.tool),['list']);
});
