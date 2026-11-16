import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudioServer } from '../server.mjs';
import { isActive } from '../lib/engine.mjs';
import { gmailDefinition } from '../lib/gmail.mjs';

// End-to-end acceptance for bot-authored connections: a real Engine server, a scripted model, owner approvals over HTTP
// and one local fixture that imitates Google's OAuth endpoints and the Gmail API closely enough for the whole flow.

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=15000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=predicate();if(value)return value;await delay(5);}throw new Error('Acceptance fixture timed out.');}
const bridged=(id,name,args)=>({id,name:'tool_call',arguments:{name,arguments:args}});
const output=(request,id)=>JSON.parse(request.messages.findLast(message=>message.tool_call_id===id).content);
const b64url=value=>Buffer.from(value).toString('base64url');
const json=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=UTF-8'});res.end(JSON.stringify(data));};

const CLIENT_ID='fixture-mail-client-id';
const CLIENT_SECRET='fixture-mail-client-secret';
const UKRAINIAN='Привіт, Дмитре! Зустріч перенесено на п’ятницю о 10:00. Візьми, будь ласка, звіт «Бюджет‑2027» і ключі від офісу?';
const HTML=`<p>${UKRAINIAN}</p>`;
const PNG=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,0xff,0xfe,0xfd]);
const REPLY=['To: anna@example.com','Subject: =?UTF-8?B?'+Buffer.from('Re: Зустріч').toString('base64')+'?=','Content-Type: text/plain; charset=UTF-8','','Дякую, Анно! Буду в п’ятницю о 10:00 зі звітом??? >>> Олег'].join('\r\n');

/** One local server imitating accounts.google.com, oauth2.googleapis.com and gmail.googleapis.com. */
async function google(t) {
  const g={issued:0,codes:new Map(),access:new Map(),refresh:new Set(),tokenRequests:[],authorizations:[],api:[],refreshError:null,expiresIn:3599,sent:[],issuedSecrets:[]};
  const message={id:'msg-anna-1',threadId:'thread-anna',labelIds:['INBOX','UNREAD','IMPORTANT'],snippet:'Привіт, Дмитре! Зустріч перенесено',payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:'Anna <anna@example.com>'},{name:'Subject',value:'Зустріч'}],body:{size:0},parts:[
    {partId:'0',mimeType:'multipart/alternative',body:{size:0},parts:[{partId:'0.0',mimeType:'text/plain',body:{size:Buffer.byteLength(UKRAINIAN),data:b64url(UKRAINIAN)}},{partId:'0.1',mimeType:'text/html',body:{size:Buffer.byteLength(HTML),data:b64url(HTML)}}]},
    {partId:'1',mimeType:'image/png',filename:'logo.png',body:{attachmentId:'att-1',size:PNG.length,data:b64url(PNG)}},
  ]}};
  g.message=message;
  g.expireAll=()=>{for(const entry of g.access.values())entry.expired=true;};
  g.server=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const url=new URL(req.url,'http://fixture');
    if(url.pathname==='/o/oauth2/v2/auth' && req.method==='GET') {
      const params=Object.fromEntries(url.searchParams);g.authorizations.push(params);
      if(params.response_type!=='code' || params.client_id!==CLIENT_ID || params.code_challenge_method!=='S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge || ''))return json(res,{error:'invalid_request'},400);
      const code=`4/0Afixture-code-${g.codes.size+1}-${'c'.repeat(20)}`;g.codes.set(code,{challenge:params.code_challenge,redirectUri:params.redirect_uri,scope:params.scope});g.issuedSecrets.push(code);
      res.writeHead(302,{location:`${params.redirect_uri}?state=${encodeURIComponent(params.state)}&code=${encodeURIComponent(code)}&scope=${encodeURIComponent(params.scope)}`});return res.end();
    }
    if(url.pathname==='/token' && req.method==='POST') {
      const form=Object.fromEntries(new URLSearchParams(raw));g.tokenRequests.push(form);if(form.code_verifier)g.issuedSecrets.push(form.code_verifier);
      if(form.client_id!==CLIENT_ID || form.client_secret!==CLIENT_SECRET)return json(res,{error:'invalid_client',error_description:'The OAuth client was not found.'},401);
      const issue=withRefresh=>{const n=++g.issued,access=`ya29.fixture-access-${n}-${'a'.repeat(24)}`,refresh=withRefresh?`1//fixture-refresh-${n}-${'r'.repeat(24)}`:undefined;g.access.set(access,{expired:false});if(refresh)g.refresh.add(refresh);g.issuedSecrets.push(access,...(refresh?[refresh]:[]));return {access_token:access,expires_in:g.expiresIn,token_type:'Bearer',scope:'https://www.googleapis.com/auth/gmail.modify',...(refresh?{refresh_token:refresh}:{})};};
      if(form.grant_type==='authorization_code') {
        const issued=g.codes.get(form.code);g.codes.delete(form.code);
        if(!issued || issued.redirectUri!==form.redirect_uri || createHash('sha256').update(form.code_verifier || '').digest('base64url')!==issued.challenge)return json(res,{error:'invalid_grant',error_description:'Bad code, redirect or verifier.'},400);
        return json(res,issue(true));
      }
      if(form.grant_type==='refresh_token') {
        if(g.refreshError || !g.refresh.has(form.refresh_token))return json(res,{error:g.refreshError || 'invalid_grant',error_description:'Token has been expired or revoked.'},400);
        // Google keeps the refresh token: a renewal returns only a new access token.
        return json(res,issue(false));
      }
      return json(res,{error:'unsupported_grant_type'},400);
    }
    const token=String(req.headers.authorization || '').replace(/^Bearer /,''),entry={method:req.method,path:url.pathname,query:url.searchParams,body:raw,token};g.api.push(entry);
    if(!g.access.has(token) || g.access.get(token).expired){entry.status=401;return json(res,{error:{code:401,message:'Request had invalid authentication credentials.',status:'UNAUTHENTICATED'}},401);}
    entry.status=200;
    const prefix='/gmail/v1/users/me';
    if(req.method==='GET' && url.pathname===`${prefix}/messages`)return json(res,{messages:[{id:'msg-anna-1',threadId:'thread-anna'},{id:'msg-news-2',threadId:'thread-news'}],resultSizeEstimate:2});
    if(req.method==='GET' && url.pathname===`${prefix}/messages/msg-anna-1`)return json(res,structuredClone(message));
    if(req.method==='GET' && url.pathname===`${prefix}/labels`)return json(res,{labels:[{id:'INBOX',name:'INBOX'}]});
    if(req.method==='POST' && url.pathname===`${prefix}/messages/send`) {
      const body=JSON.parse(raw);if(typeof body.raw!=='string' || !/^[A-Za-z0-9_-]+$/.test(body.raw))return json(res,{error:{code:400,message:'Invalid raw'}},400);
      g.sent.push({raw:body.raw,text:Buffer.from(body.raw,'base64url').toString('utf8'),threadId:body.threadId});return json(res,{id:'msg-sent-1',threadId:body.threadId || 'thread-new',labelIds:['SENT']});
    }
    const modify=url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/modify$/);
    if(req.method==='POST' && modify){const body=JSON.parse(raw);return json(res,{id:decodeURIComponent(modify[1]),labelIds:['INBOX','IMPORTANT',...(body.addLabelIds || [])].filter(label=>!(body.removeLabelIds || []).includes(label))});}
    if(req.method==='DELETE' && /^\/gmail\/v1\/users\/me\/messages\/[^/]+$/.test(url.pathname)){res.writeHead(204);return res.end();}
    return json(res,{error:{code:404,message:'Not found'}},404);
  });
  await new Promise(resolve=>g.server.listen(0,'127.0.0.1',resolve));
  g.port=g.server.address().port;g.origin=`http://127.0.0.1:${g.port}`;
  // The browser-facing authorization host differs from the token and API host, as at Google. The Engine never fetches it.
  g.authorizationUrl=`http://localhost:${g.port}/o/oauth2/v2/auth`;
  return g;
}

/** A real Engine server on a temporary data folder with a scripted model and owner approvals over HTTP. */
async function engineFixture(t,{policy='balanced',services=[]}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-gmail-acceptance-'));
  const requests=[],queue=[],responses=[];
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,allowPrivateHttp:true,providers:{
    async complete(connection,request){requests.push(request);const step=queue.shift();if(!step)throw new Error('The scripted model has no step left.');return step(request);},
    async reviewAction(){throw new Error('No automatic review is expected under this policy.');},
  }});
  // Servers close before their temporary folder is removed.
  t.after(async()=>{await app.close();for(const service of services)await new Promise(resolve=>service.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0,'127.0.0.1');let cookie='',csrf='';
  async function request(route,{method='GET',data}={}) {
    const response=await fetch(url+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(csrf && method!=='GET'?{'X-CSRF-Token':csrf}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
    const text=await response.text();responses.push(text);
    return {status:response.status,body:text?JSON.parse(text):null,headers:response.headers};
  }
  const setup=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'gmail-acceptance-fixture-password'}});assert.equal(setup.status,201);cookie=setup.headers.get('set-cookie').split(';')[0];csrf=setup.body.csrf;
  await app.store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture-model'});state.integrations=[];for(const bot of state.bots){bot.connectionId='fixture';bot.approvalPolicy=policy;}});
  const store=app.store,run=botId=>store.state.runs[botId],events=[];
  /** Send an owner message with its scripted model steps; decide(control) answers each approval card. */
  async function send(text,steps,decide=()=> 'once',botId='bot_atlas') {
    queue.push(...steps);
    const sent=await request(`/api/bots/${botId}/messages`,{method:'POST',data:{text}});assert.equal(sent.status,202,JSON.stringify(sent.body));const runId=sent.body.run.id,controls=[];
    while(true) {
      await until(()=>run(botId)?.id!==runId || !isActive(run(botId)) || run(botId).status==='waiting_for_approval' && app.runtime.pending.get(runId)?.promptId===run(botId).pending_controls?.[0]?.prompt_id);
      const current=run(botId);if(current.id!==runId || !isActive(current))break;
      const control=current.pending_controls[0];controls.push(structuredClone(control));
      const answered=await request(`/api/bots/${botId}/approval`,{method:'POST',data:{runId,remoteRunId:current.remoteRunId,request_id:control.prompt_id,execution_generation:current.execution_generation,choice:decide(control)}});assert.equal(answered.status,200);
      await until(()=>run(botId).pending_controls?.[0]?.prompt_id!==control.prompt_id);
    }
    await app.runtime.tasks.get(runId);
    const finished=store.state.runs[botId];events.push(...structuredClone(finished.events || []));
    assert.equal(queue.length,0,'every scripted model step ran');
    return {run:finished,controls,reply:store.state.messages[botId].findLast(message=>message.role==='assistant' && message.runId===runId)};
  }
  return {app,store,url,request,send,requests,responses,events};
}

/** The owner's browser: start sign-in, follow the provider's consent redirect, then the callback without a session cookie. */
async function signIn(f,g,integrationId) {
  const started=await f.request(`/api/integrations/${integrationId}/oauth/start`,{method:'POST',data:{}});assert.equal(started.status,200,JSON.stringify(started.body));
  const authorization=new URL(started.body.authorizationUrl);
  const consent=await fetch(`${g.origin}${authorization.pathname}${authorization.search}`,{redirect:'manual'});assert.equal(consent.status,302);
  const location=consent.headers.get('location');assert.ok(location.startsWith(`${started.body.redirectUri}?`),'the provider returns to the registered redirect');
  const page=await fetch(location);const html=await page.text();f.responses.push(html);
  return {started,authorization,page,html};
}

test('a bot adds Gmail itself: proposal, owner approval and OAuth sign-in, real calls, token renewal and safe updates',async t=>{
  const g=await google(t),f=await engineFixture(t,{services:[g.server]});
  const definition=gmailDefinition({baseUrl:g.origin,authorizationUrl:g.authorizationUrl,tokenUrl:`${g.origin}/token`,remove:true});
  const proposal={...definition,reason:'You asked me to check your Gmail, and no mail connection exists yet.'};
  const apiHost=`127.0.0.1:${g.port}`,authHost=`localhost:${g.port}`;
  assert.match(b64url(UKRAINIAN),/[-_]/,'the fixture text exercises base64url-only characters');
  assert.match(Buffer.from(REPLY).toString('base64'),/[+/]/,'the reply would differ in standard base64');
  let integrationId;

  // 1–4. The owner asks; the bot loads the integrations group, finds nothing, proposes Gmail and tries a call too early.
  const first=await f.send('Check my Gmail for anything unread from Anna.',[
    ()=>({text:'',toolCalls:[{id:'load',name:'tools_load',arguments:{groups:['integrations']}}]}),
    request=>{const loaded=output(request,'load');assert.ok(loaded.tools.some(tool=>tool.name==='integration_propose'));assert.match(JSON.stringify(loaded.guidance),/integration_propose/);
      return {text:'',toolCalls:[bridged('list1','integration_list',{})]};},
    request=>{assert.deepEqual(output(request,'list1'),[]);return {text:'There is no mail connection yet; I will propose Gmail.',toolCalls:[bridged('propose','integration_propose',proposal)]};},
    request=>{const result=output(request,'propose');integrationId=result.integrationId;
      assert.deepEqual({status:result.status,connect:result.connect,actions:result.actions,authType:result.authType},{status:'needs_credentials',connect:{required:true,how:'oauth'},actions:['search_messages','read_message','send_message','modify_labels','delete_message'],authType:'oauth2'});
      return {text:'',toolCalls:[bridged('early','integration_call',{integrationId,tool:'search_messages',arguments:{q:'from:anna is:unread'}})]};},
    request=>{const early=output(request,'early');assert.equal(early.errorCode,'integration_not_connected');assert.match(early.error,/“Gmail” is not connected yet/);
      return {text:'Please connect Gmail with the card below, then tell me.',toolCalls:[]};},
  ],control=>{assert.equal(f.store.state.integrations.length,0,'nothing exists before approval');return 'once';});
  assert.equal(first.run.status,'completed',first.run.error);
  assert.equal(first.controls.length,1,'one card: the proposal; the premature call raised none');
  const [card]=first.controls;assert.equal(card.tool,'integration_propose');assert.deepEqual(card.arguments,proposal,'the exact proposal is on the card');
  assert.equal(card.review.summary,`Add a connection “Gmail” to ${apiHost} — 5 actions (2 read, 3 can change things). Sign-in: OAuth at ${authHost} (tokens from ${apiHost}). You enter the key or sign in yourself afterwards.`);
  assert.deepEqual(Object.keys(card.review),['summary']);

  // 3. The integration exists, waits for the owner, is assigned to the bot, and the reply asks to connect it.
  let stored=f.store.state.integrations.find(item=>item.id===integrationId);
  assert.deepEqual({status:stored.status,connected:stored.oauth.connected,proposedBy:stored.proposedBy.botId,extra:stored.oauth.extraParams,scopes:stored.oauth.scopes},{status:'needs_credentials',connected:false,proposedBy:'bot_atlas',extra:{access_type:'offline',prompt:'consent'},scopes:definition.oauth.scopes});
  assert.ok(f.store.state.bots.find(bot=>bot.id==='bot_atlas').integrationIds.includes(integrationId));
  assert.deepEqual(first.reply.connectionRequests,[{integrationId,name:'Gmail',how:'oauth'}]);
  let listed=(await f.request('/api/state')).body.integrations.find(item=>item.id===integrationId);
  assert.deepEqual({ready:listed.ready,hasKey:listed.hasKey,client:listed.hasOAuthClientSecret,sealed:'oauthSecret' in listed,secret:'secret' in listed,notes:listed.setupNotes},{ready:false,hasKey:false,client:false,sealed:false,secret:false,notes:definition.setupNotes});
  assert.equal(g.api.length+g.tokenRequests.length,0,'nothing reached Google before the owner connected it');

  // 5. The owner saves the OAuth client, signs in at the provider, and the provider's redirect completes it without a session.
  const saved=await f.request(`/api/integrations/${integrationId}`,{method:'PATCH',data:{oauth:{clientId:CLIENT_ID},oauthClientSecret:CLIENT_SECRET}});
  assert.equal(saved.status,200,JSON.stringify(saved.body));assert.deepEqual({status:saved.body.status,ready:saved.body.ready,client:saved.body.hasOAuthClientSecret,clientId:saved.body.oauth.clientId},{status:'needs_credentials',ready:false,client:true,clientId:CLIENT_ID});
  const redirect=(await f.request('/api/integrations/oauth/redirect')).body.redirectUri;assert.equal(redirect,`${f.url}/api/integrations/oauth/callback`);
  const signed=await signIn(f,g,integrationId),auth=signed.authorization.searchParams;
  assert.equal(`${signed.authorization.host}${signed.authorization.pathname}`,`${authHost}/o/oauth2/v2/auth`);
  assert.deepEqual({response_type:auth.get('response_type'),client_id:auth.get('client_id'),redirect_uri:auth.get('redirect_uri'),scope:auth.get('scope'),access_type:auth.get('access_type'),prompt:auth.get('prompt'),method:auth.get('code_challenge_method')},{response_type:'code',client_id:CLIENT_ID,redirect_uri:redirect,scope:definition.oauth.scopes.join(' '),access_type:'offline',prompt:'consent',method:'S256'});
  assert.match(auth.get('state'),/^[A-Za-z0-9_-]{43}$/);assert.match(auth.get('code_challenge'),/^[A-Za-z0-9_-]{43}$/);
  assert.equal(signed.page.status,200);assert.match(signed.html,/Connected — you can close this tab/);
  assert.equal(g.tokenRequests.length,1);assert.equal(g.tokenRequests[0].grant_type,'authorization_code');assert.equal(g.tokenRequests[0].redirect_uri,redirect);
  listed=(await f.request('/api/state')).body.integrations.find(item=>item.id===integrationId);
  assert.deepEqual({status:listed.status,ready:listed.ready,connected:listed.oauth.connected},{status:'connected',ready:true,connected:true});
  const connectionId=f.store.state.integrations.find(item=>item.id===integrationId).oauth.connectionId;

  // 6. The bot lists the five actions and uses each with an approval: search, read, send, modify, delete.
  const call=(id,tool,args)=>bridged(id,'integration_call',{integrationId,tool,arguments:args});
  const second=await f.send('Connected. Check unread mail from Anna, reply that I will come, mark it read and delete the newsletter.',[
    ()=>({text:'',toolCalls:[bridged('list2','integration_list',{})]}),
    request=>{const actions=output(request,'list2');assert.deepEqual(actions.map(action=>action.name),['search_messages','read_message','send_message','modify_labels','delete_message']);
      assert.ok(actions.every(action=>action.integrationId===integrationId && action.requiresApproval===true));
      assert.match(actions[2].description,/raw: write plain text; it is sent base64url-encoded/);assert.doesNotMatch(actions[1].description,/encoded/);
      return {text:'',toolCalls:[call('search','search_messages',{q:'from:anna is:unread',maxResults:5,labelIds:['INBOX','UNREAD']})]};},
    request=>{assert.deepEqual(output(request,'search').messages.map(item=>item.id),['msg-anna-1','msg-news-2']);return {text:'',toolCalls:[call('read','read_message',{id:'msg-anna-1',format:'full'})]};},
    request=>{const message=output(request,'read'),[alternative,attachment]=message.payload.parts;
      assert.equal(alternative.parts[0].body.data,UKRAINIAN,'the text part arrives as decoded Ukrainian text');assert.equal(alternative.parts[1].body.data,HTML);
      assert.equal(attachment.body.data,b64url(PNG),'binary data stays encoded and untouched');assert.equal(message.snippet,g.message.snippet);
      return {text:'',toolCalls:[call('send','send_message',{raw:REPLY,threadId:'thread-anna'})]};},
    request=>{assert.equal(output(request,'send').id,'msg-sent-1');return {text:'',toolCalls:[call('modify','modify_labels',{id:'msg-anna-1',addLabelIds:['Label_7'],removeLabelIds:['UNREAD']})]};},
    request=>{assert.deepEqual(output(request,'modify').labelIds,['INBOX','IMPORTANT','Label_7']);return {text:'',toolCalls:[call('delete','delete_message',{id:'msg-news-2'})]};},
    request=>{assert.deepEqual(output(request,'delete'),{status:204,note:'The service accepted the request and returned no content.'});return {text:'Replied to Anna, marked her message read and deleted the newsletter.',toolCalls:[]};},
  ]);
  assert.equal(second.run.status,'completed',second.run.error);
  assert.deepEqual(second.controls.map(control=>[control.tool,control.arguments.tool]),[['integration_call','search_messages'],['integration_call','read_message'],['integration_call','send_message'],['integration_call','modify_labels'],['integration_call','delete_message']]);
  assert.equal(second.controls[2].arguments.arguments.raw,REPLY,'the card shows the plain text the bot wrote');
  const api=g.api.filter(entry=>entry.status===200);
  assert.deepEqual(api.map(entry=>[entry.method,entry.path]),[['GET','/gmail/v1/users/me/messages'],['GET','/gmail/v1/users/me/messages/msg-anna-1'],['POST','/gmail/v1/users/me/messages/send'],['POST','/gmail/v1/users/me/messages/msg-anna-1/modify'],['DELETE','/gmail/v1/users/me/messages/msg-news-2']]);
  assert.deepEqual(api[0].query.getAll('labelIds'),['INBOX','UNREAD'],'repeated query parameters');assert.equal(api[0].query.get('q'),'from:anna is:unread');assert.equal(api[0].query.get('maxResults'),'5');
  assert.equal(api[1].query.get('format'),'full');
  assert.deepEqual(g.sent,[{raw:b64url(REPLY),text:REPLY,threadId:'thread-anna'}],'Gmail received base64url of the exact text');
  assert.deepEqual(JSON.parse(api[3].body),{addLabelIds:['Label_7'],removeLabelIds:['UNREAD']});assert.equal(api[4].body,'');

  // 7. Expiry: a GET renews once and is resent; a POST is not resent; invalid_grant asks the owner to sign in again.
  let refreshes=()=>g.tokenRequests.filter(form=>form.grant_type==='refresh_token').length;
  const sendsBefore=g.api.filter(entry=>entry.path.endsWith('/send')).length;
  const third=await f.send('Check for new mail again and send Anna the agenda.',[
    ()=>{g.expireAll();return {text:'',toolCalls:[call('search2','search_messages',{q:'is:unread'})]};},
    request=>{assert.equal(output(request,'search2').resultSizeEstimate,2);assert.equal(refreshes(),1,'exactly one refresh request');
      g.expireAll();return {text:'',toolCalls:[call('send2','send_message',{raw:REPLY})]};},
    request=>{const result=output(request,'send2');assert.match(result.error,/not sent again; it is safe to call it again/);
      assert.equal(g.api.filter(entry=>entry.path.endsWith('/send')).length-sendsBefore,1,'the POST reached Gmail once and was not resent');assert.equal(refreshes(),2);
      g.refreshError='invalid_grant';g.expireAll();return {text:'',toolCalls:[call('search3','search_messages',{q:'is:unread'})]};},
    request=>{assert.match(output(request,'search3').error,/Gmail needs the owner to sign in again/);return {text:'',toolCalls:[bridged('list3','integration_list',{})]};},
    request=>{const [entry]=output(request,'list3');assert.deepEqual({ready:entry.ready,status:entry.status},{ready:false,status:'needs_reauth'});assert.match(entry.notice,/needs the owner to sign in again/);
      return {text:'',toolCalls:[call('search4','search_messages',{q:'from:anna'})]};},
    request=>{const result=output(request,'search4');assert.equal(result.errorCode,'integration_not_connected');assert.match(result.error,/needs the owner to sign in again/);
      return {text:'Gmail needs you to sign in again before I can send the agenda.',toolCalls:[]};},
  ]);
  assert.equal(third.run.status,'completed',third.run.error);
  assert.deepEqual(third.controls.map(control=>control.arguments.tool),['search_messages','send_message','search_messages'],'the refused call after needs_reauth raised no card');
  assert.equal(g.sent.length,1,'the agenda was not sent');
  stored=f.store.state.integrations.find(item=>item.id===integrationId);assert.deepEqual({status:stored.status,connected:stored.oauth.connected},{status:'needs_reauth',connected:false});
  const dashboard=await f.request('/api/dashboard');assert.equal(dashboard.status,200);assert.ok(JSON.stringify(dashboard.body).includes(`integration:${integrationId}`),'the Dashboard lists the sign-in that needs the owner');

  // 8. After signing in again, the bot adds an action and resends its sign-in settings unchanged: the sign-in is kept.
  g.refreshError=null;await signIn(f,g,integrationId);
  const reconnected=f.store.state.integrations.find(item=>item.id===integrationId).oauth.connectionId;assert.notEqual(reconnected,connectionId);
  const listLabels={name:'list_labels',description:'List the mailbox labels and their ids.',method:'GET',path:'/gmail/v1/users/me/labels',inputSchema:{type:'object',properties:{},additionalProperties:false}};
  const tools=[...definition.tools,listLabels],moved=`http://localhost:${g.port}`;
  const kept=()=>{const current=f.store.state.integrations.find(item=>item.id===integrationId);assert.deepEqual({connected:current.oauth.connected,connectionId:current.oauth.connectionId,status:current.status},{connected:true,connectionId:reconnected,status:'connected'});};
  const fourth=await f.send('Also let yourself list my Gmail labels.',[
    ()=>({text:'',toolCalls:[bridged('update1','integration_propose',{integrationId,tools,reason:'To find label ids before changing labels.'})]}),
    request=>{const result=output(request,'update1');assert.deepEqual({status:result.status,required:result.connect.required,removed:result.credentialRemoved},{status:'connected',required:false,removed:undefined});kept();
      return {text:'',toolCalls:[bridged('update2','integration_propose',{integrationId,oauth:structuredClone(definition.oauth),reason:'Confirm the sign-in settings.'})]};},
    request=>{assert.equal(output(request,'update2').credentialRemoved,undefined);kept();
      return {text:'',toolCalls:[bridged('labels','integration_call',{integrationId,tool:'list_labels',arguments:{}})]};},
    request=>{assert.deepEqual(output(request,'labels').labels,[{id:'INBOX',name:'INBOX'}]);
      return {text:'',toolCalls:[bridged('update3','integration_propose',{integrationId,baseUrl:moved,tools,reason:'Use the other API address.'})]};},
    request=>{const result=output(request,'update3');assert.deepEqual({status:result.status,connect:result.connect,removed:result.credentialRemoved},{status:'needs_credentials',connect:{required:true,how:'oauth'},removed:true});
      return {text:'The new address needs you to sign in again.',toolCalls:[]};},
  ]);
  assert.equal(fourth.run.status,'completed',fourth.run.error);
  const summaries=fourth.controls.filter(control=>control.tool==='integration_propose').map(control=>control.review.summary);
  assert.equal(summaries[0],`Change the connection “Gmail” at ${apiHost}: add list_labels, then 6 actions (3 read, 3 can change things). Sign-in: OAuth at ${authHost} (tokens from ${apiHost}).`,'adding an action keeps the sign-in');
  assert.equal(summaries[1],`Change the connection “Gmail” at ${apiHost}. Sign-in: OAuth at ${authHost} (tokens from ${apiHost}).`,'identical sign-in settings are not a change');
  assert.equal(summaries[2],`Change the connection “Gmail” at ${apiHost}: move it to ${authHost}, then 6 actions (3 read, 3 can change things). Sign-in: OAuth at ${authHost} (tokens from ${apiHost}). Its saved key or sign-in will be removed and you connect it again.`);
  stored=f.store.state.integrations.find(item=>item.id===integrationId);
  assert.deepEqual({status:stored.status,connected:stored.oauth.connected,baseUrl:stored.baseUrl,clientId:stored.oauth.clientId},{status:'needs_credentials',connected:false,baseUrl:moved,clientId:CLIENT_ID});
  assert.deepEqual(Object.keys(JSON.parse(f.store.unseal(stored.oauthSecret))),['client_secret'],'tokens are gone; the client secret for the unchanged token endpoint stays');
  assert.deepEqual(fourth.reply.connectionRequests,[{integrationId,name:'Gmail',how:'oauth'}]);

  // 9. No secret appears in anything observable: API responses, the callback pages, public state, run events, activity, transcript, model requests or the state file.
  const secrets=[CLIENT_SECRET,...new Set(g.issuedSecrets)];assert.ok(secrets.length>=10);
  const observed={responses:f.responses.join('\n'),state:JSON.stringify((await f.request('/api/state')).body),events:JSON.stringify(f.events),activity:JSON.stringify(f.store.state.activity),messages:JSON.stringify((await f.request('/api/bots/bot_atlas/messages')).body),transcript:JSON.stringify(f.store.state.messages),models:JSON.stringify(f.requests),memory:JSON.stringify(f.store.state),file:await fs.readFile(f.store.file,'utf8')};
  for(const [where,text] of Object.entries(observed))for(const secret of secrets)assert.ok(!text.includes(secret),`${where} must not contain ${secret.slice(0,18)}…`);
  assert.ok(f.store.state.activity.some(event=>event.type==='integration.proposed') && f.store.state.activity.some(event=>event.type==='integration.oauth_refresh_failed'));
});

test('a bearer-key service with a path parameter and a fixed version header, proposed by the bot and keyed by the owner',async t=>{
  const KEY='secret_notion-fixture-key-91c2',seen=[];
  const service=http.createServer((req,res)=>{seen.push({method:req.method,url:req.url,authorization:req.headers.authorization,version:req.headers['notion-version']});
    if(req.headers.authorization!==`Bearer ${KEY}` || req.headers['notion-version']!=='2022-06-28')return json(res,{object:'error',status:401,code:'unauthorized'},401);
    json(res,{object:'page',id:decodeURIComponent(req.url.split('/').pop()),properties:{title:'Плани на тиждень'}});});
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${service.address().port}`;
  const f=await engineFixture(t,{services:[service]});let integrationId;
  const proposal={name:'Notion',baseUrl:`${origin}/notion`,authType:'bearer',headers:{'Notion-Version':'2022-06-28'},tools:[{name:'get_page',description:'Read one page by id.',method:'GET',path:'/v1/pages/{page_id}',inputSchema:{type:'object',properties:{page_id:{type:'string',maxLength:100}},required:['page_id'],additionalProperties:false}}],setupNotes:'Create an internal integration at notion.so/my-integrations and share the page with it.',reason:'You asked me to read your Notion plan.'};
  const first=await f.send('Read my weekly plan in Notion.',[
    ()=>({text:'',toolCalls:[bridged('leaky','integration_propose',{...proposal,headers:{'Notion-Version':'2022-06-28',Authorization:'Bearer sk-model-made-up'}})]}),
    request=>{assert.equal(output(request,'leaky').errorCode,'credential_not_allowed');return {text:'',toolCalls:[bridged('propose','integration_propose',proposal)]};},
    request=>{const result=output(request,'propose');integrationId=result.integrationId;assert.deepEqual(result.connect,{required:true,how:'api_key'});return {text:'Connect Notion with the card below.',toolCalls:[]};},
  ]);
  assert.equal(first.run.status,'completed',first.run.error);assert.equal(first.controls.length,1,'the credential attempt raised no card');
  assert.equal(first.controls[0].review.summary,`Add a connection “Notion” to ${new URL(origin).host} — 1 action (1 read, 0 can change things). Sign-in: API key (bearer token). You enter the key or sign in yourself afterwards.`);
  assert.deepEqual(first.reply.connectionRequests,[{integrationId,name:'Notion',how:'api_key'}]);
  const keyed=await f.request(`/api/integrations/${integrationId}`,{method:'PATCH',data:{apiKey:KEY}});assert.equal(keyed.status,200);assert.equal(keyed.body.ready,true);assert.deepEqual(keyed.body.headers,{'Notion-Version':'2022-06-28'});
  const second=await f.send('Done, read it now.',[
    ()=>({text:'',toolCalls:[bridged('page','integration_call',{integrationId,tool:'get_page',arguments:{page_id:'59833787-2cf9-4fdf-8782-e53db20768a5'}})]}),
    request=>{assert.equal(output(request,'page').properties.title,'Плани на тиждень');return {text:'Your plan is ready.',toolCalls:[]};},
  ]);
  assert.equal(second.run.status,'completed',second.run.error);assert.equal(second.controls.length,1);
  assert.deepEqual(seen,[{method:'GET',url:'/notion/v1/pages/59833787-2cf9-4fdf-8782-e53db20768a5',authorization:`Bearer ${KEY}`,version:'2022-06-28'}]);
  for(const text of [f.responses.join('\n'),JSON.stringify(f.store.state),JSON.stringify(f.requests)])assert.ok(!text.includes(KEY));
});

test('a proposed MCP server waits for the owner key, then discovers its tools and serves an approved call',async t=>{
  const KEY='mcp-fixture-bearer-key-5b7e',calls=[];
  const service=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;
    if(req.headers.authorization!==`Bearer ${KEY}`)return json(res,{error:'unauthorized'},401);
    const message=JSON.parse(raw);calls.push(message.method);
    if(message.method==='notifications/initialized'){res.writeHead(202);return res.end();}
    const result=message.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:message.method==='tools/list'?{tools:[{name:'lookup_order',description:'Find an order by number.',inputSchema:{type:'object',properties:{number:{type:'string'}},required:['number']}}]}:{content:[{type:'text',text:`Order ${message.params.arguments.number}: shipped`}]};
    res.writeHead(200,{'content-type':'application/json',...(message.method==='initialize'?{'mcp-session-id':'session-1'}:{})});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));});
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));const endpoint=`http://127.0.0.1:${service.address().port}/mcp`;
  const f=await engineFixture(t,{services:[service]});let integrationId;
  const first=await f.send('Connect my shop’s order server.',[
    ()=>({text:'',toolCalls:[bridged('propose','integration_propose',{name:'Shop orders',type:'mcp',baseUrl:endpoint,authType:'bearer',setupNotes:'Create a read-only token in the shop admin.',reason:'You asked about your orders.'})]}),
    request=>{const result=output(request,'propose');integrationId=result.integrationId;assert.deepEqual({status:result.status,actions:result.actions,connect:result.connect},{status:'needs_credentials',actions:[],connect:{required:true,how:'api_key'}});return {text:'Add the key in the card below.',toolCalls:[]};},
  ]);
  assert.equal(first.run.status,'completed',first.run.error);
  assert.match(first.controls[0].review.summary,/an MCP server; its tools are discovered after you connect it/);
  // Testing before the key is refused without marking the connection broken.
  const early=await f.request(`/api/integrations/${integrationId}/test`,{method:'POST',data:{}});assert.equal(early.status,409);assert.match(early.body.error,/not connected yet/);
  assert.equal(f.store.state.integrations[0].status,'needs_credentials');assert.equal(calls.length,0);
  const keyed=await f.request(`/api/integrations/${integrationId}`,{method:'PATCH',data:{apiKey:KEY}});assert.deepEqual({ready:keyed.body.ready,status:keyed.body.status},{ready:true,status:'untested'});
  const tested=await f.request(`/api/integrations/${integrationId}/test`,{method:'POST',data:{}});assert.equal(tested.status,200,JSON.stringify(tested.body));assert.deepEqual(tested.body.tools.map(tool=>tool.name),['lookup_order']);
  const second=await f.send('Connected. Where is order 1042?',[
    ()=>({text:'',toolCalls:[bridged('list','integration_list',{})]}),
    request=>{assert.deepEqual(output(request,'list').map(tool=>tool.name),['lookup_order']);return {text:'',toolCalls:[bridged('order','integration_call',{integrationId,tool:'lookup_order',arguments:{number:'1042'}})]};},
    request=>{assert.equal(output(request,'order').content[0].text,'Order 1042: shipped');return {text:'Order 1042 has shipped.',toolCalls:[]};},
  ]);
  assert.equal(second.run.status,'completed',second.run.error);assert.equal(second.controls.length,1);
  assert.ok(calls.includes('tools/call'));for(const text of [f.responses.join('\n'),JSON.stringify(f.store.state)])assert.ok(!text.includes(KEY));
});
