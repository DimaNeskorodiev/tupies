import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const read=name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8');
const [source,approvalSource,appRaw,index,css]=await Promise.all([read('connection-request.js'),read('approval-summary.js'),read('app.js'),read('index.html'),read('connection-request.css')]);
const appSource=appRaw.replace(/\nstart\(\);\s*$/,'\n');
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const KEY='sk-live-SECRET-should-never-render-1234567890';
const CLIENT_SECRET='client-secret-NEVER-IN-DOM-0987';
const HOSTILE='Step 1: open <img src=x onerror="window.hacked=1"> then <a href="javascript:alert(1)">this</a> javascript:alert(2)';

const gmailKey=(extra={})=>({id:'integration_gmail',name:'Gmail',type:'rest',baseUrl:'https://gmail.googleapis.com/gmail/v1',authType:'bearer',status:'needs_credentials',hasKey:false,hasOAuthClientSecret:false,ready:false,
  tools:[{name:'list_messages',description:'List recent <b>messages</b>.',method:'GET',path:'/users/me/messages'},{name:'send_message',description:'Send an email.',method:'POST',path:'/users/me/messages/send'}],
  proposedBy:{botId:'bot_atlas',botName:'Atlas',runId:'run_1',at:'2026-11-16T10:00:00Z'},setupNotes:HOSTILE,reason:'You asked me to read your <script>mail</script>.',...extra});
const gmailOAuth=(extra={})=>gmailKey({authType:'oauth2',oauth:{authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth',tokenUrl:'https://oauth2.googleapis.com/token',scopes:['https://www.googleapis.com/auth/gmail.readonly'],clientId:'',extraParams:{access_type:'offline'},tokenAuth:'body',connected:false},...extra});

function harness({integrations=[gmailKey()],requests=[{integrationId:'integration_gmail',name:'Gmail',how:'api_key'}],composer=true,later=false}={}){
  const dom=new JSDOM(`<main><div id="chat-thread"></div>${composer?'<form id="message-form" data-id="bot_atlas"><div id="composer-attachments"></div><textarea id="message-input"></textarea><button type="button" data-action="send-direction" hidden></button><button class="send" type="submit">Send</button></form>':''}<div id="dialog-root"></div></main>`,{runScripts:'outside-only',url:'http://localhost/'});
  const {window}=dom,{document}=window;
  const opened=[],calls=[],queue=[],submits=[];
  window.open=(...args)=>{opened.push(args);return null;};
  window.eval(approvalSource);window.eval(source);
  let data={integrations,bots:[{id:'bot_atlas',name:'Atlas'}]};
  const api=async(path,options={})=>{
    calls.push({path,method:options.method||'GET',body:options.body===undefined?undefined:JSON.parse(JSON.stringify(options.body))});
    const next=queue.find(item=>item.match(path,options));
    if(next){queue.splice(queue.indexOf(next),1);if(next.error)throw Object.assign(new Error(next.error.message),{status:next.error.status});return typeof next.result==='function'?next.result(options):next.result;}
    if(path==='/api/integrations/oauth/redirect')return {redirectUri:'http://127.0.0.1:4467/api/integrations/oauth/callback'};
    throw new Error('unexpected '+path);
  };
  let refreshes=0;const onRefresh=[];
  // Like the app, a state refresh replaces the workspace data object, so the module must read the context fresh.
  const base={api,errorText:error=>error?.message||'Something went wrong.',refresh:async()=>{refreshes++;for(const fn of onRefresh.splice(0))fn();data={...data,integrations:data.integrations.map(item=>structuredClone(item))};return true;},route:()=>({view:'bot',id:'bot_atlas'}),renderApp(){},
    openDialog(title,body){document.querySelector('#dialog-root').innerHTML=`<dialog open aria-label="${title}"><h2>${title}</h2>${body}</dialog>`;}};
  const ctx=()=>({...base,data});
  const thread=document.querySelector('#chat-thread');
  const draw=()=>{thread.innerHTML=`<article class="chat-message" data-message-key="message-abc"><div class="message-content">${window.StudioConnect.cards(requests,{botId:'bot_atlas',messageKey:'message-abc',ctx})}</div></article>${later?'<article class="chat-message user"><div class="message-content">later</div></article>':''}`;window.StudioConnect.mount(thread,ctx);};
  const form=document.querySelector('#message-form');
  if(form){form.requestSubmit=()=>submits.push(form.querySelector('#message-input').value);}
  const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
  const respond=(match,result,error)=>queue.push({match,result,error});
  const type=(field,value)=>{field.value=value;field.dispatchEvent(new window.Event('input',{bubbles:true}));};
  const submit=node=>node.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  const click=node=>node.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true}));
  return {window,document,get data(){return data;},ctx,calls,opened,submits,draw,thread,$,$$,respond,type,submit,click,onRefresh,get refreshes(){return refreshes;},connect:window.StudioConnect};
}
/** Every attribute value and all text in a subtree, to prove a secret never landed there. */
const everything=node=>[node.outerHTML,...[...node.querySelectorAll('*')].flatMap(element=>[...element.attributes].map(attribute=>attribute.value))].join('\n');

test('an API-key card names the bot, the host and the actions, and keeps the bot’s notes inert',()=>{
  const h=harness();h.draw();
  const card=h.$('.cr-card');
  assert.equal(h.$('.cr-title').textContent,'Connect Gmail');
  assert.match(card.textContent,/Atlas asked for this: You asked me to read your <script>mail<\/script>\./);
  assert.match(h.$('.cr-hosts').textContent,/Sends your key only to gmail\.googleapis\.com\./);
  const notes=h.$('.cr-notes');assert.ok(notes.closest('details'),'setup notes sit in a collapsible section');
  assert.match(notes.closest('details').querySelector('summary').textContent,/How to get the key/);
  assert.match(notes.closest('details').textContent,/Written by Atlas/);
  assert.equal(notes.textContent.includes('<img src=x onerror="window.hacked=1">'),true,'hostile markup is shown as text');
  assert.equal(card.querySelector('img,a,script,b'),null,'no element came from model-written text');
  assert.equal(h.window.hacked,undefined);
  const actions=h.$$('.cr-actions li').map(item=>item.textContent);
  assert.match(actions[0],/list messages/);assert.match(actions[0],/Reads/);assert.match(actions[0],/List recent <b>messages<\/b>\./);
  assert.match(actions[1],/send message/);assert.match(actions[1],/Makes changes/);
  const key=h.$('input[data-cr-field="key"]');
  assert.equal(key.type,'password');assert.equal(key.getAttribute('autocomplete'),'off');assert.equal(key.value,'');
  assert.ok(h.$(`label[for="${key.id}"]`),'the key field has a label');
  assert.equal(h.$('.cr-card button[type=submit]').textContent,'Connect');
  assert.equal(h.$('.cr-status').getAttribute('aria-live'),'polite');
});

test('Connect sends the key once, clears the field, never renders it, then the card turns into a confirmation',async()=>{
  const h=harness();h.draw();
  h.respond((path,options)=>path==='/api/integrations/integration_gmail'&&options.method==='PATCH',()=>{Object.assign(h.data.integrations[0],{hasKey:true,ready:true,status:'untested'});return {...h.data.integrations[0]};});
  const field=h.$('input[data-cr-field="key"]');h.type(field,`  ${KEY}  `);
  h.submit(h.$('form[data-cr-form="key"]'));await settle();
  const patch=h.calls.filter(call=>call.method==='PATCH');
  assert.equal(patch.length,1);assert.deepEqual(patch[0].body,{apiKey:KEY});
  assert.equal(field.value,'','the key field is cleared after sending');
  assert.equal(everything(h.document.documentElement).includes(KEY),false,'the key is not in the DOM');
  let stored='';try{stored=JSON.stringify({...h.window.sessionStorage},null,0)+JSON.stringify({...h.window.localStorage});}catch{}
  assert.equal(stored.includes(KEY),false,'the key is not in storage');
  assert.equal(h.window.location.href.includes(KEY),false);
  assert.match(h.$('.cr-done').textContent,/Gmail is connected/);
  assert.equal(h.$('.cr-continue').textContent,'Continue');
  assert.ok(h.refreshes>=1,'the workspace state was reloaded');
});

test('a busy bot is explained in plain words and the typed key stays in its field',async()=>{
  const h=harness();h.draw();
  h.respond((path,options)=>options.method==='PATCH',null,{status:409,message:'Wait for bots using this integration to finish.'});
  const field=h.$('input[data-cr-field="key"]');h.type(field,KEY);field.focus();
  h.submit(h.$('form[data-cr-form="key"]'));await settle();
  assert.equal(h.$('.cr-status').textContent,'Wait for Atlas to finish its task, then try again.');
  assert.equal(h.$('.cr-status').getAttribute('role'),'alert');
  assert.equal(h.$('input[data-cr-field="key"]'),field,'the same field survives the redraw');
  assert.equal(field.value,KEY);assert.equal(everything(h.document.documentElement).includes(KEY),false);
  // An empty key is refused locally.
  field.value='';h.submit(h.$('form[data-cr-form="key"]'));await settle();
  assert.equal(h.$('.cr-status').textContent,'Paste the key first.');assert.equal(h.calls.filter(call=>call.method==='PATCH').length,1);
});

test('typed text survives redraws and new workspace data while the owner is typing',async()=>{
  const h=harness({integrations:[gmailOAuth()],requests:[{integrationId:'integration_gmail',name:'Gmail',how:'oauth'}]});h.draw();await settle();
  const client=h.$('input[data-cr-field="client"]'),secret=h.$('input[data-cr-field="secret"]');
  h.type(client,'my-client.apps');h.type(secret,CLIENT_SECRET);secret.focus();
  h.data.integrations[0]={...h.data.integrations[0],error:'Something changed upstream.'};
  h.connect.mount(h.thread,h.ctx);
  assert.equal(h.$('input[data-cr-field="secret"]'),secret);assert.equal(secret.value,CLIENT_SECRET);
  assert.equal(h.document.activeElement,secret,'focus stays in the field being typed');
  assert.equal(h.$('input[data-cr-field="client"]').value,'my-client.apps');
  assert.match(h.$('.cr-problem').textContent,/Something changed upstream\./);
  // A full thread redraw (new article node) keeps the remembered client ID but never the secret.
  h.draw();
  assert.equal(h.$('input[data-cr-field="client"]').value,'my-client.apps');assert.equal(h.$('input[data-cr-field="secret"]').value,'');
  assert.equal(everything(h.document.documentElement).includes(CLIENT_SECRET),false);
});

test('OAuth: return address with Copy, client details, Sign in opens the provider and the card notices the sign-in',async()=>{
  const h=harness({integrations:[gmailOAuth()],requests:[{integrationId:'integration_gmail',name:'Gmail',how:'oauth'}]});h.draw();await settle();
  assert.match(h.$('.cr-hosts').textContent,/Sign-in happens at accounts\.google\.com \(tokens from oauth2\.googleapis\.com\)\. Requests go only to gmail\.googleapis\.com\./);
  assert.equal(h.$('.cr-copy input').value,'http://127.0.0.1:4467/api/integrations/oauth/callback');assert.ok(h.$('.cr-copy input').readOnly);
  assert.ok(h.$('[data-cr-act="copy"]'));
  const signIn=h.$('[data-cr-act="sign-in"]');assert.equal(signIn.disabled,true,'sign-in waits for a client ID');assert.match(h.$('.cr-steps').textContent,/Save the client ID first\./);
  assert.equal(h.$('input[data-cr-field="secret"]').type,'password');
  h.respond((path,options)=>options.method==='PATCH',options=>{Object.assign(h.data.integrations[0],{hasOAuthClientSecret:true,oauth:{...h.data.integrations[0].oauth,clientId:options.body.oauth.clientId}});return h.data.integrations[0];});
  h.type(h.$('input[data-cr-field="client"]'),' my-client.apps ');h.type(h.$('input[data-cr-field="secret"]'),CLIENT_SECRET);
  h.submit(h.$('form[data-cr-form="client"]'));await settle();
  const save=h.calls.find(call=>call.method==='PATCH');
  assert.deepEqual(save.body,{oauth:{clientId:'my-client.apps'},oauthClientSecret:CLIENT_SECRET});
  assert.equal(h.$('input[data-cr-field="secret"]').value,'');assert.equal(everything(h.document.documentElement).includes(CLIENT_SECRET),false);
  assert.match(h.$('.cr-saved').textContent,/Client ID saved · client secret saved/);
  assert.match(h.$('label[for^="cr-secret-"]').textContent,/saved — leave empty to keep it/);
  const authorizationUrl='https://accounts.google.com/o/oauth2/v2/auth?client_id=my-client.apps&state=s1';
  h.respond(path=>path==='/api/integrations/integration_gmail/oauth/start',{authorizationUrl,redirectUri:'http://127.0.0.1:4467/api/integrations/oauth/callback',expiresAt:new Date(Date.now()+600000).toISOString()});
  h.click(h.$('[data-cr-act="sign-in"]'));await settle();
  assert.deepEqual(h.opened,[[authorizationUrl,'_blank','noopener,noreferrer']]);
  assert.match(h.$('.cr-waiting').textContent,/Waiting for sign-in… Finish it in the window that opened\. The link works until/);
  assert.equal(everything(h.$('.cr-card')).includes('state=s1'),false,'the sign-in link is not written into the page');
  h.click(h.$('[data-cr-act="reopen"]'));assert.equal(h.opened.length,2);
  // The provider sent the owner back: the next state refresh shows the connection.
  h.onRefresh.push(()=>{h.data.integrations[0]={...h.data.integrations[0],ready:true,status:'connected',oauth:{...h.data.integrations[0].oauth,connected:true,connectedAt:new Date().toISOString()}};});
  h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  assert.match(h.$('.cr-done').textContent,/Gmail is connected/);assert.ok(h.$('.cr-continue'));
});

test('OAuth: a javascript: sign-in address is never opened, and Finish manually posts the pasted address',async()=>{
  const h=harness({integrations:[gmailOAuth({oauth:{...gmailOAuth().oauth,clientId:'saved-client'}})],requests:[{integrationId:'integration_gmail',name:'Gmail',how:'oauth'}]});h.draw();await settle();
  h.respond(path=>path.endsWith('/oauth/start'),{authorizationUrl:'javascript:alert(1)',expiresAt:new Date(Date.now()+600000).toISOString()});
  h.click(h.$('[data-cr-act="sign-in"]'));await settle();
  assert.equal(h.opened.length,0);assert.match(h.$('.cr-status').textContent,/cannot open/);
  const manual=h.$('details[data-cr-open="manual"]');assert.match(manual.querySelector('summary').textContent,/Finish manually/);
  h.respond(path=>path.endsWith('/oauth/complete'),()=>{Object.assign(h.data.integrations[0],{ready:true,status:'connected',oauth:{...h.data.integrations[0].oauth,connected:true}});return {status:'connected'};});
  h.type(h.$('input[data-cr-field="paste"]'),'http://127.0.0.1:4467/api/integrations/oauth/callback?code=abc&state=s2');
  h.submit(h.$('form[data-cr-form="complete"]'));await settle();
  assert.deepEqual(h.calls.find(call=>call.path.endsWith('/oauth/complete')).body,{redirectUrl:'http://127.0.0.1:4467/api/integrations/oauth/callback?code=abc&state=s2'});
  assert.match(h.$('.cr-done').textContent,/Gmail is connected/);
});

test('a sign-in the service stopped accepting asks to sign in again without repeating the client setup',async()=>{
  const h=harness({integrations:[gmailOAuth({status:'needs_reauth',error:'“Gmail” needs the owner to sign in again in Settings → Integrations.',hasOAuthClientSecret:true,oauth:{...gmailOAuth().oauth,clientId:'saved-client'}})],requests:[{integrationId:'integration_gmail',name:'Gmail',how:'oauth'}]});
  h.draw();await settle();
  assert.equal(h.$('.cr-title').textContent,'Sign in to Gmail again');
  assert.match(h.$('.cr-card').textContent,/The service stopped accepting the saved sign-in\./);
  assert.equal(h.$('input[data-cr-field="client"]'),null);assert.equal(h.$('.cr-copy'),null);
  const button=h.$('[data-cr-act="sign-in"]');assert.equal(button.textContent,'Sign in again');assert.equal(button.disabled,false);
});

test('a removed connection says so; MCP and no-key services offer Check connection',async()=>{
  const gone=harness({integrations:[]});gone.draw();
  assert.equal(gone.$('.cr-card').textContent.trim(),'Checking Gmail…','a reply can arrive before the state lists its connection');
  await settle();assert.equal(gone.refreshes,1);assert.equal(gone.$('.cr-card').textContent.trim(),'Gmail was removed.');
  const late=harness({integrations:[]});late.onRefresh.push(()=>late.data.integrations.push(gmailKey()));late.draw();await settle();
  assert.equal(late.$('.cr-title').textContent,'Connect Gmail');assert.equal(gone.$('button'),gone.$('#message-form button'));
  const mcp={id:'integration_tools',name:'Docs MCP',type:'mcp',baseUrl:'https://mcp.example.com/mcp',authType:'none',status:'untested',ready:true,hasKey:false,proposedBy:{botId:'bot_atlas',botName:'Atlas'},setupNotes:'',reason:'Search the docs.'};
  const h=harness({integrations:[mcp],requests:[{integrationId:'integration_tools',name:'Docs MCP',how:'none'}]});h.draw();
  assert.equal(h.$('.cr-title').textContent,'Check Docs MCP');assert.match(h.$('.cr-card').textContent,/Its tools are listed after you connect it\./);
  h.respond(path=>path==='/api/integrations/integration_tools/test',()=>{Object.assign(mcp,{status:'connected',discoveredTools:[{name:'search'}]});return {connected:true,tools:[{name:'search'}]};});
  h.click(h.$('[data-cr-act="check"]'));await settle();
  assert.match(h.$('.cr-done').textContent,/Docs MCP is connected/);
});

test('Continue sends one ordinary owner message through the composer and then goes away',async()=>{
  const h=harness({integrations:[gmailKey({ready:true,hasKey:true,status:'configured'})]});h.draw();
  const button=h.$('.cr-continue');assert.ok(button);
  h.click(button);h.click(button);await settle();
  assert.deepEqual(h.submits,['Gmail is connected — please continue.']);
  assert.equal(h.$('.cr-continue'),null,'the button is gone once used');
  h.draw();assert.equal(h.$('.cr-continue'),null,'and stays gone after a redraw');
  // A chat that has moved on shows no Continue.
  const moved=harness({integrations:[gmailKey({ready:true,hasKey:true,status:'configured'})],later:true});moved.draw();
  assert.match(moved.$('.cr-done').textContent,/Gmail is connected/);assert.equal(moved.$('.cr-continue'),null);
  // While the bot is busy, Continue only fills the box.
  const busy=harness({integrations:[gmailKey({ready:true,hasKey:true,status:'configured'})]});busy.$('.send').disabled=true;busy.draw();
  busy.click(busy.$('.cr-continue'));await settle();
  assert.deepEqual(busy.submits,[]);assert.equal(busy.$('#message-input').value,'Gmail is connected — please continue.');
  assert.match(busy.$('.cr-status').textContent,/Added to the message box/);
});

test('nothing is drawn for missing or malformed requests',()=>{
  const h=harness();
  assert.equal(h.connect.cards(undefined,{ctx:h.ctx}),'');assert.equal(h.connect.cards([],{ctx:h.ctx}),'');
  assert.equal(h.connect.cards([{integrationId:'../x'},null,'x'],{ctx:h.ctx}),'');
  assert.equal((h.connect.cards(Array.from({length:9},()=>({integrationId:'integration_gmail',name:'Gmail',how:'api_key'})),{ctx:h.ctx}).match(/class="cr-card"/g)||[]).length,5);
});

test('the approval card for a proposed connection reads in plain words and stays inert',()=>{
  const h=harness();
  const control={tool:'integration_propose',arguments:{name:'Gmail <img src=x onerror=alert(1)>',baseUrl:'https://gmail.googleapis.com/gmail/v1',authType:'oauth2',oauth:{authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth',tokenUrl:'https://oauth2.googleapis.com/token',scopes:['https://www.googleapis.com/auth/gmail.readonly']},tools:gmailKey().tools,setupNotes:HOSTILE,reason:'Read your mail.'},review:{summary:'Add a connection “Gmail” to gmail.googleapis.com — 2 actions (1 read, 1 can change things). Sign-in: OAuth at accounts.google.com (tokens from oauth2.googleapis.com). You enter the key or sign in yourself afterwards.'}};
  assert.equal(h.window.StudioApprovals.title(control),'Add a connection');
  const box=h.document.createElement('div');box.innerHTML=h.window.StudioApprovals.body(control,'raw');
  assert.match(box.querySelector('.approval-sentence').textContent,/gmail\.googleapis\.com — 2 actions/);
  const rows=Object.fromEntries([...box.querySelectorAll('.approval-inputs>div')].map(row=>[row.querySelector('dt').textContent,row.querySelector('dd').textContent]));
  assert.equal(rows.Address,'https://gmail.googleapis.com/gmail/v1');
  assert.match(rows['Sign-in'],/OAuth sign-in at accounts\.google\.com · permissions: https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly/);
  assert.match(rows.Actions,/Reads · list messages — List recent <b>messages<\/b>\.\nChanges · send message — Send an email\./);
  assert.equal(rows.Why,'Read your mail.');assert.match(rows['Setup notes'],/<img src=x/);
  assert.equal(box.querySelector('img,a,b,script'),null);
  assert.equal(h.window.StudioApprovals.title({tool:'integration_propose',arguments:{integrationId:'integration_gmail'}}),'Change a connection');
});

function settings(t,integrations){
  const dom=new JSDOM('<div id="dialog-root"></div><div id="toasts"></div>',{url:'http://studio.local/#/integrations',runScripts:'outside-only'}),win=dom.window,doc=win.document;
  win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});win.setInterval=()=>1;
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
  win.eval(source);
  const context=dom.getInternalVMContext();vm.runInContext(appSource,context);
  const calls=[];
  win.fixtureData={bots:[{id:'bot_atlas',name:'Atlas',title:'Assistant',skills:[],tools:['integrations'],integrationIds:integrations.map(item=>item.id),collaborators:[],enabled:true}],connections:[],integrations,skills:[],routines:[],channels:[],runs:{},rooms:[],settings:{}};
  win.fixtureApi=async(route,options={})=>{
    calls.push({route,method:options.method||'GET',body:options.body&&JSON.parse(JSON.stringify(options.body))});
    if(route==='/api/integrations/oauth/redirect')return {redirectUri:'https://studio.example.com/api/integrations/oauth/callback'};
    if(route==='/api/integrations/catalog')return {integrations:[{id:'gmail',name:'Gmail',type:'rest',baseUrl:'https://gmail.googleapis.com/gmail/v1',authType:'oauth2',oauth:{authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth',tokenUrl:'https://oauth2.googleapis.com/token',scopes:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'],extraParams:{access_type:'offline',prompt:'consent'}},setupNotes:'Create an OAuth client in Google Cloud.',tools:gmailKey().tools}]};
    if(options.method==='PATCH'||options.method==='POST')return {id:route.split('/')[3]||'integration_new',...options.body};
    throw new Error(`Unexpected request ${route}`);
  };
  vm.runInContext('data={...initialState,...fixtureData};auth={authenticated:true,csrf:"fixture"};api=fixtureApi;refresh=async()=>{};renderApp=()=>{};toast=()=>{};',context);
  t.after(()=>win.close());
  return {win,doc,calls,run:code=>vm.runInContext(code,context)};
}

test('Settings rows say who added a connection and what it needs, with a Connect action',t=>{
  const h=settings(t,[gmailKey(),gmailOAuth({id:'integration_mail2',name:'Mail OAuth'}),gmailOAuth({id:'integration_mail3',name:'Mail again',status:'needs_reauth',oauth:{...gmailOAuth().oauth,clientId:'c'}}),gmailOAuth({id:'integration_mail4',name:'Mail done',ready:true,status:'connected',proposedBy:undefined,oauth:{...gmailOAuth().oauth,clientId:'c',connected:true}}),{id:'integration_plain',name:'Plain API',type:'rest',baseUrl:'https://api.example.com',authType:'bearer',status:'configured',hasKey:true,ready:true,tools:[]}]);
  const page=h.run('renderIntegrations()'),cards=page.split('connection-card').slice(1);
  assert.match(cards[0],/Added by Atlas/);assert.match(cards[0],/Needs your key/);assert.match(cards[0],/data-cr-open-dialog data-id="integration_gmail">Connect</);
  assert.match(cards[1],/Needs sign-in/);assert.match(cards[1],/>Connect</);
  assert.match(cards[2],/Sign in again/);assert.match(cards[2],/data-cr-open-dialog data-id="integration_mail3">Sign in again</);
  assert.match(cards[3],/status-pill ready"><i class="dot"><\/i>Connected/);assert.doesNotMatch(cards[3],/Added by|data-cr-open-dialog/);
  assert.match(cards[4],/Configured/);assert.doesNotMatch(cards[4],/data-cr-open-dialog|Needs/);
  // The row's Connect opens the same connect card in a dialog.
  h.doc.body.insertAdjacentHTML('beforeend',`<div id="rows">${page}</div>`);
  h.doc.querySelector('[data-cr-open-dialog][data-id="integration_gmail"]').dispatchEvent(new h.win.MouseEvent('click',{bubbles:true,cancelable:true}));
  const dialog=h.doc.querySelector('#dialog-root dialog');assert.ok(dialog);
  assert.equal(dialog.querySelector('h2').textContent,'Connect Gmail');assert.ok(dialog.querySelector('.cr-card[data-cr-dialog="true"] input[data-cr-field="key"]'));
});

test('the integration dialog offers OAuth sign-in, keeps bearer/header/none, shows the bot’s notes and fills an OAuth preset',async t=>{
  const h=settings(t,[gmailOAuth({hasOAuthClientSecret:true,oauth:{...gmailOAuth().oauth,clientId:'saved-client'}}),{id:'integration_plain',name:'Plain API',type:'rest',baseUrl:'https://api.example.com',authType:'bearer',status:'configured',hasKey:true,ready:true,tools:[{name:'get',description:'Get',method:'GET',path:'/x'}]}]);
  h.run("integrationDialog('integration_gmail')");await settle();
  const form=h.doc.querySelector('#integration-form');
  assert.deepEqual([...form.querySelector('#integration-auth').options].map(option=>option.value),['bearer','header','none','oauth2']);
  assert.equal(form.querySelector('#integration-auth').value,'oauth2');
  assert.equal(form.querySelector('#integration-oauth-field').hidden,false);assert.equal(form.querySelector('#integration-key-field').hidden,true);
  assert.equal(form.querySelector('[name=oauthClientId]').value,'saved-client');assert.equal(form.querySelector('[name=oauthClientSecret]').type,'password');
  assert.match(form.querySelector('[name=oauthClientSecret]').placeholder,/Leave empty to keep the saved secret/);
  assert.equal(form.querySelector('[name=oauthScopes]').value,'https://www.googleapis.com/auth/gmail.readonly');assert.equal(form.querySelector('[name=oauthExtra]').value,'access_type=offline');
  assert.equal(form.querySelector('#integration-oauth-redirect input[readonly]').value,'https://studio.example.com/api/integrations/oauth/callback');assert.ok(form.querySelector('[data-cr-copy-redirect]'));
  const note=form.querySelector('.cr-proposal');assert.match(note.textContent,/Atlas added this connection\. You asked me to read your <script>mail<\/script>\./);
  assert.equal(note.querySelector('img,a,script'),null);assert.match(note.querySelector('.cr-notes').textContent,/javascript:alert\(2\)/);
  // Switching the method shows only its own fields.
  const auth=form.querySelector('#integration-auth');auth.value='bearer';auth.dispatchEvent(new h.win.Event('change',{bubbles:true}));await settle();
  assert.equal(form.querySelector('#integration-oauth-field').hidden,true);assert.equal(form.querySelector('#integration-key-field').hidden,false);
  auth.value='oauth2';auth.dispatchEvent(new h.win.Event('change',{bubbles:true}));await settle();
  // Saving sends the OAuth settings, the secret only when typed, and opens the connect dialog.
  form.querySelector('[name=oauthScopes]').value='a b  c';form.querySelector('[name=oauthExtra]').value='access_type=offline\n\nprompt=consent';
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await settle();
  const save=h.calls.find(call=>call.method==='PATCH');
  assert.equal(save.route,'/api/integrations/integration_gmail');
  assert.deepEqual(save.body.oauth,{authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth',tokenUrl:'https://oauth2.googleapis.com/token',scopes:['a','b','c'],clientId:'saved-client',extraParams:{access_type:'offline',prompt:'consent'},tokenAuth:'body'});
  assert.equal(Object.hasOwn(save.body,'oauthClientSecret'),false);assert.equal(save.body.authType,'oauth2');
  assert.equal(h.doc.querySelector('#dialog-root dialog h2').textContent,'Connect Gmail');
  // An unusable extra parameter is explained.
  const payload=h.win.StudioConnect.oauthPayload;const bad=h.doc.createElement('form');bad.innerHTML='<textarea name="oauthExtra">no-equals</textarea>';
  assert.throws(()=>payload(bad),/name=value/);
  // Bearer integrations save exactly as before, without a key unless one is typed.
  h.run("integrationDialog('integration_plain')");await settle();
  const plain=h.doc.querySelector('#integration-form');assert.equal(plain.querySelector('#integration-oauth-field').hidden,true);assert.equal(plain.querySelector('#integration-key-field').hidden,false);
  plain.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await settle();
  const plainSave=h.calls.filter(call=>call.method==='PATCH').at(-1);
  assert.deepEqual(Object.keys(plainSave.body).sort(),['authType','baseUrl','name','tools','type']);
  // A preset with OAuth fills the OAuth fields and shows its notes.
  h.run("integrationDialog(undefined,'rest')");const select=h.doc.querySelector('#integration-preset');select.value='gmail';
  await h.run("applyIntegrationPreset(document.querySelector('#integration-preset'))");
  const fresh=h.doc.querySelector('#integration-form');
  assert.equal(fresh.querySelector('#integration-auth').value,'oauth2');assert.equal(fresh.querySelector('#integration-oauth-field').hidden,false);assert.equal(fresh.querySelector('#integration-key-field').hidden,true);
  assert.equal(fresh.querySelector('[name=oauthScopes]').value,'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send');
  assert.equal(fresh.querySelector('[name=oauthExtra]').value,'access_type=offline\nprompt=consent');
  assert.match(fresh.querySelector('.cr-preset-notes').textContent,/Create an OAuth client in Google Cloud\./);
});

test('the module is registered, wired into replies and threads, and phrased for the thinking line',()=>{
  assert.match(index,/<link rel="stylesheet" href="\/approval-summary\.css">\s*<link rel="stylesheet" href="\/connection-request\.css">/);
  assert.match(index,/<script defer src="\/approval-summary\.js"><\/script>\s*<script defer src="\/connection-request\.js"><\/script>/);
  assert.ok(appRaw.includes("message.connectionRequests?window.StudioConnect?.cards(message.connectionRequests,{botId:bot?.id||'',messageKey:messageKey(message),ctx:studioContext})||'':''"));
  assert.ok(appRaw.includes('window.StudioConnect?.mount(container,studioContext);'));
  assert.ok(appRaw.indexOf("[/^integration_propose$/,'setting up a connection','act']")<appRaw.indexOf("[/^integration_/,'using an integration','act']"));
  assert.match(css,/@media \(max-width:760px\)/);assert.match(css,/min-height:44px/);
  assert.doesNotMatch(source,/localStorage|console\.|innerHTML\s*=\s*[^`'"]*value/);
});
