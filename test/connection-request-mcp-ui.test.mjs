import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// Automatic sign-in for MCP servers: the engine finds the sign-in address from the server and registers itself.
// The owner sees where sign-in happens before anything opens, and never types a client ID or secret.
const read=name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8');
const [source,approvalSource,appRaw]=await Promise.all([read('connection-request.js'),read('approval-summary.js'),read('app.js')]);
const appSource=appRaw.replace(/\nstart\(\);\s*$/,'\n');
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const HOSTILE='<img src=x onerror="window.hacked=1"><script>window.hacked=2</script>';

const todo=(extra={})=>({id:'integration_todo',name:'Tasks',type:'mcp',baseUrl:'https://mcp.tasks.example/mcp',authType:'oauth2',status:'needs_credentials',ready:false,hasKey:false,hasOAuthClientSecret:false,
  oauth:{auto:true,connected:false,authorizationUrl:'',tokenUrl:'',scopes:[],clientId:''},proposedBy:{botId:'bot_atlas',botName:'Atlas'},reason:'Read your tasks.',setupNotes:'',...extra});
const discovered=(extra={})=>({auto:true,connected:false,authorizationUrl:'https://tasks.example/oauth/authorize',tokenUrl:'https://api.tasks.example/oauth/token',scopes:['data:read','data:write'],clientId:'fixture-client-id',issuer:'https://tasks.example',resource:'https://mcp.tasks.example/mcp',registration:'dynamic',discoveredAt:'2026-11-16T10:00:00Z',registeredRedirectUri:'http://127.0.0.1:4467/api/integrations/oauth/callback',...extra});
const found=(extra={})=>({authorizationHost:'tasks.example',tokenHost:'api.tasks.example',issuer:'https://tasks.example',scopes:['data:read','data:write'],registration:'dynamic',registered:true,...extra});

// A card waiting for sign-in polls on an interval; closing each window stops it so the run ends.
const windows=[];test.after(()=>{for(const window of windows)window.close();});
function harness(integrations=[todo()]){
  const dom=new JSDOM('<main><div id="chat-thread"></div><div id="dialog-root"></div></main>',{runScripts:'outside-only',url:'http://localhost/'});
  const {window}=dom,{document}=window;windows.push(window);
  const opened=[],calls=[],queue=[];
  window.open=(...args)=>{opened.push(args);return null;};
  window.eval(approvalSource);window.eval(source);
  let data={integrations,bots:[{id:'bot_atlas',name:'Atlas'}]};
  const api=async(path,options={})=>{
    calls.push({path,method:options.method||'GET',body:options.body===undefined?undefined:JSON.parse(JSON.stringify(options.body))});
    const next=queue.find(item=>item.match(path,options));
    if(next){queue.splice(queue.indexOf(next),1);if(next.error)throw Object.assign(new Error(next.error.message),next.error);return typeof next.result==='function'?next.result(options):next.result;}
    if(path==='/api/integrations/oauth/redirect')return {redirectUri:'http://127.0.0.1:4467/api/integrations/oauth/callback'};
    throw new Error('unexpected '+path);
  };
  const onRefresh=[];
  const base={api,errorText:error=>error?.message||'Something went wrong.',refresh:async()=>{for(const fn of onRefresh.splice(0))fn();data={...data,integrations:data.integrations.map(item=>structuredClone(item))};return true;},route:()=>({view:'bot',id:'bot_atlas'}),renderApp(){},openDialog(){}};
  const ctx=()=>({...base,data});
  const thread=document.querySelector('#chat-thread');
  const draw=()=>{thread.innerHTML=`<article class="chat-message"><div class="message-content">${window.StudioConnect.cards([{integrationId:'integration_todo',name:'Tasks',how:'oauth'}],{botId:'bot_atlas',messageKey:'m1',ctx})}</div></article>`;window.StudioConnect.mount(thread,ctx);};
  const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
  const respond=(match,result,error)=>queue.push({match,result,error});
  const click=node=>node.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true}));
  const set=fields=>{data.integrations[0]={...data.integrations[0],...fields};};
  const paths=()=>calls.map(call=>call.path).filter(path=>!path.endsWith('/oauth/redirect'));
  return {window,document,get data(){return data;},set,calls,paths,opened,draw,$,$$,respond,click,onRefresh};
}
const everything=node=>[node.outerHTML,...[...node.querySelectorAll('*')].flatMap(element=>[...element.attributes].map(attribute=>attribute.value))].join('\n');

test('not discovered: one Find sign-in button, then the hosts, and Sign in only opens on a second click',async()=>{
  const h=harness();h.draw();await settle();
  assert.equal(h.$('.cr-title').textContent,'Connect Tasks');
  assert.match(h.$('.cr-card').textContent,/Tupies asks the server where you sign in\. You see the address before anything opens\./);
  assert.equal(h.$('[data-cr-act="sign-in"]'),null);assert.equal(h.$('input[data-cr-field="client"]'),null);assert.equal(h.$('input[data-cr-field="secret"]'),null);assert.equal(h.$('.cr-copy'),null,'no return-address step');
  assert.equal(h.$('.cr-hosts').textContent,'Requests go only to mcp.tasks.example.');
  const button=h.$('[data-cr-act="discover"]');assert.equal(button.textContent,'Find sign-in');assert.ok(button.classList.contains('primary-button'));
  let release;h.respond(path=>path==='/api/integrations/integration_todo/oauth/discover',()=>new Promise(resolve=>{release=()=>{h.set({oauth:discovered()});resolve({integration:h.data.integrations[0],...found()});};}));
  h.click(button);await settle();
  assert.equal(h.$('[data-cr-act="discover"]').textContent,'Finding…');assert.equal(h.$('[data-cr-act="discover"]').disabled,true);
  release();await settle();
  assert.deepEqual(h.calls.find(call=>call.path.endsWith('/oauth/discover')),{path:'/api/integrations/integration_todo/oauth/discover',method:'POST',body:{}});
  assert.equal(h.$('.cr-hosts').textContent,'You will sign in at tasks.example. Tokens come from api.tasks.example. Requests go only to mcp.tasks.example.');
  assert.equal(h.$('.cr-caution'),null,'the same site needs no caution');
  assert.deepEqual(h.$$('.cr-scopes code').map(node=>node.textContent),['data:read','data:write']);
  assert.equal(h.$('.cr-status').textContent,'Check where you will sign in, then press Sign in.');assert.equal(h.$('.cr-status').getAttribute('aria-live'),'polite');
  assert.equal(h.$('input[data-cr-field="client"]'),null);assert.equal(h.$('.cr-copy'),null);
  assert.equal(h.paths().some(path=>path.endsWith('/oauth/start')),false,'nothing opens before the owner presses Sign in');assert.equal(h.opened.length,0);
  const authorizationUrl='https://tasks.example/oauth/authorize?client_id=fixture-client-id&state=s1';
  h.respond(path=>path.endsWith('/oauth/start'),{authorizationUrl,redirectUri:'http://127.0.0.1:4467/api/integrations/oauth/callback',expiresAt:new Date(Date.now()+600000).toISOString()});
  const signIn=h.$('[data-cr-act="sign-in"]');assert.equal(signIn.textContent,'Sign in');
  h.click(signIn);await settle();
  assert.deepEqual(h.paths(),['/api/integrations/integration_todo/oauth/discover','/api/integrations/integration_todo/oauth/start']);
  assert.deepEqual(h.opened,[[authorizationUrl,'_blank','noopener,noreferrer']]);
  assert.match(h.$('.cr-waiting').textContent,/Waiting for sign-in/);assert.ok(h.$('details[data-cr-open="manual"]'),'Finish manually stays available');
  assert.equal(everything(h.$('.cr-card')).includes('state=s1'),false);
  // Signed in, but the server's tools are not listed yet: the card lists them, as Connect does after a pasted key.
  h.onRefresh.push(()=>h.set({ready:true,status:'connected',oauth:{...discovered(),connected:true,connectedAt:new Date().toISOString()}}));
  h.respond(path=>path.endsWith('/test'),()=>{h.set({discoveredTools:[{name:'list_tasks'},{name:'add_task'}]});return {connected:true,tools:[{name:'list_tasks'},{name:'add_task'}]};});
  h.window.dispatchEvent(new h.window.Event('focus'));await settle();
  assert.ok(h.paths().includes('/api/integrations/integration_todo/test'));
  assert.match(h.$('.cr-done').textContent,/Tasks is connected/);assert.ok(h.$('.cr-continue'));
});

test('a sign-in page on a different site gets a calm caution, and the card never blocks',async()=>{
  const h=harness([todo({oauth:discovered({authorizationUrl:'https://login.other-idp.example/authorize',tokenUrl:'https://login.other-idp.example/token',issuer:'https://login.other-idp.example'})})]);h.draw();await settle();
  assert.equal(h.$('.cr-hosts').textContent,'You will sign in at login.other-idp.example. Tokens come from login.other-idp.example. Requests go only to mcp.tasks.example.');
  assert.match(h.$('.cr-caution').textContent,/different site than the server\. Check that it is Tasks’s real sign-in page/);
  assert.equal(h.$('[data-cr-act="sign-in"]').disabled,false);
  // Country-code domains compare by their real site.
  const uk=harness([todo({baseUrl:'https://mcp.shop.co.uk/mcp',oauth:discovered({authorizationUrl:'https://auth.shop.co.uk/authorize',tokenUrl:'https://auth.shop.co.uk/token'})})]);uk.draw();await settle();
  assert.equal(uk.$('.cr-caution'),null);
  const other=harness([todo({baseUrl:'https://mcp.shop.co.uk/mcp',oauth:discovered({authorizationUrl:'https://auth.other.co.uk/authorize'})})]);other.draw();await settle();
  assert.ok(other.$('.cr-caution'));
});

test('a server that needs an app registered by hand shows the manual steps',async()=>{
  const h=harness();h.draw();await settle();
  h.respond(path=>path.endsWith('/oauth/discover'),()=>{h.set({oauth:discovered({clientId:'',registration:'manual_required'})});return {integration:h.data.integrations[0],...found({registration:'manual_required',registered:false})};});
  h.click(h.$('[data-cr-act="discover"]'));await settle();
  assert.match(h.$('.cr-card').textContent,/This server needs an app registered by hand before you can sign in\./);
  assert.equal(h.$('.cr-copy input').value,'http://127.0.0.1:4467/api/integrations/oauth/callback');assert.ok(h.$('[data-cr-act="copy"]'));
  assert.ok(h.$('input[data-cr-field="client"]'));assert.equal(h.$('input[data-cr-field="secret"]').type,'password');
  assert.equal(h.$('[data-cr-act="sign-in"]').disabled,true);assert.match(h.$('.cr-steps').textContent,/Save the client ID first\./);
  assert.match(h.$('.cr-hosts').textContent,/You will sign in at tasks\.example/);
});

test('discovery failed: the token path asks first, then switches to a pasted token and keeps the name and address',async()=>{
  const h=harness();h.draw();await settle();
  h.respond(path=>path.endsWith('/oauth/discover'),null,{status:502,code:'oauth_discovery_failed',message:'The server did not publish sign-in information.'});
  h.click(h.$('[data-cr-act="discover"]'));await settle();
  const failed=h.$('.cr-failed');assert.equal(failed.getAttribute('role'),'alert');
  assert.equal(failed.textContent,'mcp.tasks.example did not say how to sign in. It may take a token instead, or need sign-in details entered by hand.');
  assert.equal(h.$('.cr-status').textContent,'','the raw engine message is not repeated');
  const manual=h.$('[data-cr-manual]');assert.equal(manual.dataset.action,'edit-integration');assert.equal(manual.dataset.id,'integration_todo');assert.equal(manual.textContent,'Enter details by hand');
  assert.equal(h.$('[data-cr-act="discover"]').textContent,'Ask the server again');
  h.click(h.$('[data-cr-act="token-ask"]'));await settle();
  assert.equal(h.calls.filter(call=>call.method==='PATCH').length,0,'asking is not switching');
  assert.match(h.$('.cr-failed').textContent,/Use a token for Tasks instead of signing in\? The name and address stay/);
  assert.equal(h.document.activeElement,h.$('[data-cr-act="token"]'));
  h.click(h.$('[data-cr-act="token-cancel"]'));await settle();assert.ok(h.$('[data-cr-act="token-ask"]'));
  h.click(h.$('[data-cr-act="token-ask"]'));await settle();
  h.respond((path,options)=>options.method==='PATCH',options=>{h.set({authType:options.body.authType,oauth:undefined,status:'needs_credentials'});return h.data.integrations[0];});
  h.click(h.$('[data-cr-act="token"]'));await settle();
  const patch=h.calls.filter(call=>call.method==='PATCH');
  assert.deepEqual(patch,[{path:'/api/integrations/integration_todo',method:'PATCH',body:{authType:'bearer'}}]);
  assert.ok(h.$('input[data-cr-field="key"]'),'the card now asks for the token');assert.equal(h.$('.cr-status').textContent,'Now paste the token from the service.');
  assert.match(h.$('.cr-hosts').textContent,/Sends your key only to mcp\.tasks\.example/);
  // A shell without error codes still recognises the failure from the status.
  const old=harness();old.draw();await settle();
  old.respond(path=>path.endsWith('/oauth/discover'),null,{status:502,message:'No sign-in information found.'});
  old.click(old.$('[data-cr-act="discover"]'));await settle();assert.ok(old.$('[data-cr-act="token-ask"]'));
});

test('registration refused: only the by-hand path, with a way to ask again',async()=>{
  const h=harness();h.draw();await settle();
  h.respond(path=>path.endsWith('/oauth/discover'),null,{status:502,code:'oauth_registration_failed',message:'Registration was refused.'});
  h.click(h.$('[data-cr-act="discover"]'));await settle();
  assert.match(h.$('.cr-failed').textContent,/did not let Tupies register itself for sign-in\. Register an app with the service, then enter its details by hand\./);
  assert.equal(h.$('[data-cr-act="token-ask"]'),null);assert.ok(h.$('[data-cr-manual]'));
  h.respond(path=>path.endsWith('/oauth/discover'),()=>{h.set({oauth:discovered()});return {integration:h.data.integrations[0],...found()};});
  h.click(h.$('[data-cr-act="discover"]'));await settle();
  assert.equal(h.$('.cr-failed'),null);assert.ok(h.$('[data-cr-act="sign-in"]'));
});

test('stale sign-in details: start asks for discovery, the card shows the hosts and waits for a second click',async()=>{
  const h=harness([todo({oauth:discovered({authorizationUrl:'https://old.tasks.example/authorize'})})]);h.draw();await settle();
  h.respond(path=>path.endsWith('/oauth/start'),null,{status:409,code:'oauth_discovery_required',message:'Find the sign-in details again.'});
  h.respond(path=>path.endsWith('/oauth/discover'),()=>{h.set({oauth:discovered({authorizationUrl:'https://login.other-idp.example/authorize'})});return {integration:h.data.integrations[0],...found({authorizationHost:'login.other-idp.example'})};});
  h.click(h.$('[data-cr-act="sign-in"]'));await settle();
  assert.deepEqual(h.paths(),['/api/integrations/integration_todo/oauth/start','/api/integrations/integration_todo/oauth/discover']);
  assert.equal(h.opened.length,0,'never chained to a redirect');
  assert.match(h.$('.cr-hosts').textContent,/You will sign in at login\.other-idp\.example\./);assert.ok(h.$('.cr-caution'));
  assert.equal(h.$('.cr-status').textContent,'Check where you will sign in, then press Sign in.');
  h.respond(path=>path.endsWith('/oauth/start'),{authorizationUrl:'https://login.other-idp.example/authorize?state=s2',expiresAt:new Date(Date.now()+600000).toISOString()});
  h.click(h.$('[data-cr-act="sign-in"]'));await settle();
  assert.equal(h.opened.length,1);assert.equal(h.paths().at(-1),'/api/integrations/integration_todo/oauth/start');
});

test('sign in again asks the server first, shows the hosts, then signs in',async()=>{
  const h=harness([todo({status:'needs_reauth',error:'“Tasks” needs the owner to sign in again.',oauth:discovered()})]);h.draw();await settle();
  assert.equal(h.$('.cr-title').textContent,'Sign in to Tasks again');
  assert.match(h.$('.cr-card').textContent,/Tupies asks the server again where you sign in\./);
  assert.equal(h.$('[data-cr-act="sign-in"]'),null);
  h.respond(path=>path.endsWith('/oauth/discover'),()=>({integration:h.data.integrations[0],...found()}));
  h.click(h.$('[data-cr-act="discover"]'));await settle();
  assert.match(h.$('.cr-hosts').textContent,/You will sign in at tasks\.example\./);
  assert.equal(h.$('[data-cr-act="sign-in"]').textContent,'Sign in again');assert.equal(h.opened.length,0);
});

test('hostile hosts, scopes, issuer and names from the server stay inert text',async()=>{
  const scopes=[`${HOSTILE}`,'a','b','c','d','javascript:alert(1)'];
  const h=harness([todo({name:`Tasks ${HOSTILE}`,oauth:{auto:true,connected:false,authorizationUrl:'',tokenUrl:'',scopes:[],clientId:''}})]);h.draw();await settle();
  h.respond(path=>path.endsWith('/oauth/discover'),()=>({authorizationHost:HOSTILE,tokenHost:'"><img src=x>',issuer:'javascript:alert(1)',scopes,registration:'dynamic',registered:true}));
  h.click(h.$('[data-cr-act="discover"]'));await settle();
  // A host that is not plainly a host is never shown as the sign-in address; the owner is asked again.
  assert.ok(h.$('[data-cr-act="discover"]'));assert.equal(h.$('[data-cr-act="sign-in"]'),null);
  h.respond(path=>path.endsWith('/oauth/discover'),()=>{h.set({oauth:discovered({scopes,issuer:HOSTILE})});return {authorizationHost:'tasks.example',tokenHost:'api.tasks.example',issuer:HOSTILE,scopes,registration:'dynamic'};});
  h.click(h.$('[data-cr-act="discover"]'));await settle();
  const card=h.$('.cr-card');
  assert.equal(card.querySelector('img,script,a,b'),null);assert.equal(h.window.hacked,undefined);
  const list=h.$('details[data-cr-open="scopes"]');assert.ok(list,'a long permission list is collapsible');assert.match(list.querySelector('summary').textContent,/Permissions it asks for \(6\)/);
  assert.equal(list.querySelector('code').textContent,HOSTILE);
  assert.doesNotMatch(h.$('.cr-hosts').textContent,/Sign-in provider/,'an issuer that is not an address is left out');
  assert.match(card.getAttribute('aria-label'),/Connect Tasks <img/);
});

test('approval card: an MCP server with automatic sign-in reads in plain words',()=>{
  const h=harness();
  const control={tool:'integration_propose',arguments:{type:'mcp',name:'Tasks',baseUrl:'https://mcp.tasks.example/mcp',authType:'oauth2',setupNotes:'',reason:'Read your tasks.'},review:{summary:'Add a connection “Tasks” to mcp.tasks.example. Sign-in is found from the server when you connect it.'}};
  const box=h.document.createElement('div');box.innerHTML=h.window.StudioApprovals.body(control,'raw');
  const rows=Object.fromEntries([...box.querySelectorAll('.approval-inputs>div')].map(row=>[row.querySelector('dt').textContent,row.querySelector('dd').textContent]));
  assert.equal(rows['Sign-in'],'Found from the server when you connect. You see the sign-in address before anything opens.');
  assert.equal(rows.Actions,'Its tools are listed after you connect it.');
  assert.equal(rows.Address,'https://mcp.tasks.example/mcp');
  // An HTTP API with OAuth details keeps its old row.
  const rest=h.document.createElement('div');rest.innerHTML=h.window.StudioApprovals.body({tool:'integration_propose',arguments:{type:'rest',name:'X',baseUrl:'https://api.x.example',authType:'oauth2',oauth:{authorizationUrl:'https://login.x.example/a'}}},'raw');
  assert.match(rest.textContent,/OAuth sign-in at login\.x\.example/);
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
    if(options.method==='PATCH'||options.method==='POST')return {id:route.split('/')[3]||'integration_new',...options.body};
    throw new Error(`Unexpected request ${route}`);
  };
  vm.runInContext('data={...initialState,...fixtureData};auth={authenticated:true,csrf:"fixture"};api=fixtureApi;refresh=async()=>{};renderApp=()=>{};toast=()=>{};',context);
  t.after(()=>win.close());
  const change=node=>node.dispatchEvent(new win.Event('change',{bubbles:true}));
  return {win,doc,calls,change,run:code=>vm.runInContext(code,context)};
}

test('integration dialog: Find sign-in automatically for MCP saves oauth.auto, and off shows the discovered details',async t=>{
  const h=settings(t,[todo({oauth:discovered()})]);
  h.run("integrationDialog('integration_todo')");await settle();
  let form=h.doc.querySelector('#integration-form');
  const box=form.querySelector('#integration-oauth-auto');
  assert.equal(box.checked,true);assert.equal(form.querySelector('#integration-oauth-auto-field').hidden,false);
  assert.ok(form.querySelector('label.checkbox-field').contains(box));
  assert.equal(form.querySelector('#integration-oauth-manual').hidden,true,'the manual fields are hidden');
  assert.ok(form.querySelector('#integration-oauth-manual #integration-oauth-auth-url'));assert.ok(form.querySelector('#integration-oauth-manual #integration-oauth-redirect'));
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await settle();
  let save=h.calls.filter(call=>call.method==='PATCH').at(-1);
  assert.equal(save.body.authType,'oauth2');assert.deepEqual(save.body.oauth,{auto:true});assert.equal(Object.hasOwn(save.body,'oauthClientSecret'),false);
  assert.equal(h.doc.querySelector('#dialog-root dialog h2').textContent,'Connect Tasks','saving leads to the Connect dialog');
  assert.ok(h.doc.querySelector('.cr-card[data-cr-dialog="true"] [data-cr-act="sign-in"]'));
  // Off: the manual fields show, filled from what the server reported.
  h.run("integrationDialog('integration_todo')");await settle();form=h.doc.querySelector('#integration-form');
  const off=form.querySelector('#integration-oauth-auto');off.checked=false;h.change(off);
  assert.equal(form.querySelector('#integration-oauth-manual').hidden,false);
  assert.equal(form.querySelector('[name=oauthAuthorizationUrl]').value,'https://tasks.example/oauth/authorize');assert.equal(form.querySelector('[name=oauthClientId]').value,'fixture-client-id');
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await settle();
  save=h.calls.filter(call=>call.method==='PATCH').at(-1);
  assert.deepEqual(save.body.oauth,{auto:false,authorizationUrl:'https://tasks.example/oauth/authorize',tokenUrl:'https://api.tasks.example/oauth/token',scopes:['data:read','data:write'],clientId:'fixture-client-id',extraParams:{},tokenAuth:'body'});
  // An HTTP API is never offered automatic sign-in; switching the type to MCP offers it.
  h.run("integrationDialog(undefined,'rest')");await settle();form=h.doc.querySelector('#integration-form');
  const auth=form.querySelector('#integration-auth');auth.value='oauth2';h.change(auth);
  assert.equal(form.querySelector('#integration-oauth-auto-field').hidden,true);assert.equal(form.querySelector('#integration-oauth-manual').hidden,false);
  const type=form.querySelector('#integration-type');type.value='mcp';h.change(type);
  assert.equal(form.querySelector('#integration-oauth-auto-field').hidden,false);assert.equal(form.querySelector('#integration-oauth-auto').checked,true,'on by default for a new MCP server');assert.equal(form.querySelector('#integration-oauth-manual').hidden,true);
  type.value='rest';h.change(type);assert.equal(form.querySelector('#integration-oauth-auto-field').hidden,true);assert.equal(form.querySelector('#integration-oauth-manual').hidden,false);
  // A new MCP server defaults to automatic sign-in.
  h.run("integrationDialog(undefined,'mcp')");await settle();form=h.doc.querySelector('#integration-form');
  assert.equal(form.querySelector('#integration-oauth-auto').checked,true);
});

test('Enter details by hand opens the integration dialog with automatic sign-in off; rows read Needs sign-in, then Connected',async t=>{
  const h=settings(t,[todo({oauth:discovered()}),todo({id:'integration_done',name:'Done',ready:true,status:'connected',proposedBy:undefined,discoveredTools:[{name:'x'}],oauth:discovered({connected:true})})]);
  h.doc.body.insertAdjacentHTML('beforeend','<button type="button" data-action="edit-integration" data-cr-manual data-id="integration_todo">Enter details by hand</button>');
  h.doc.querySelector('[data-cr-manual]').dispatchEvent(new h.win.MouseEvent('click',{bubbles:true,cancelable:true}));await settle();
  const form=h.doc.querySelector('#integration-form');
  assert.equal(form.querySelector('#integration-oauth-auto').checked,false);assert.equal(form.querySelector('#integration-oauth-manual').hidden,false);
  // The next ordinary open shows the saved choice again.
  h.run("integrationDialog('integration_todo')");await settle();assert.equal(h.doc.querySelector('#integration-oauth-auto').checked,true);
  const page=h.run('renderIntegrations()'),cards=page.split('connection-card').slice(1);
  assert.match(cards[0],/Needs sign-in/);assert.match(cards[0],/data-cr-open-dialog data-id="integration_todo">Connect</);
  assert.match(cards[1],/status-pill ready"><i class="dot"><\/i>Connected/);assert.doesNotMatch(cards[1],/data-cr-open-dialog/);
  h.doc.body.insertAdjacentHTML('beforeend',`<div id="rows">${page}</div>`);
  h.doc.querySelector('[data-cr-open-dialog][data-id="integration_todo"]').dispatchEvent(new h.win.MouseEvent('click',{bubbles:true,cancelable:true}));
  const dialog=h.doc.querySelector('#dialog-root dialog');assert.equal(dialog.querySelector('h2').textContent,'Connect Tasks');
  assert.match(dialog.querySelector('.cr-hosts').textContent,/You will sign in at tasks\.example\./);
});

test('the shell passes the engine’s error code through and the dialog knows the connection type',()=>{
  assert.ok(appRaw.includes("{status:response.status,...(typeof result.code==='string'?{code:result.code}:{})}"));
  assert.ok(appRaw.includes('window.StudioConnect?.oauthFields(i,id,studioContext,selected)'));
});
