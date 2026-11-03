import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { Store, DEFAULT_BOT_TOOLS } from '../lib/store.mjs';
import { BOT_TEMPLATES } from '../lib/bot-templates.mjs';
import { assertSkillIntegrity } from '../lib/skills.mjs';
import { listDocuments } from '../lib/sync/docs.mjs';
import { createStudioServer } from '../server.mjs';

async function fresh(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-onboarding-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return new Store(directory).init();
}
test('new workspace starters have a verified product guide and no additional access or scheduled work',async t=>{
  const store=await fresh(t),ops=store.state.bots.find(bot=>bot.starterTemplate==='ops');
  assert.equal(store.state.bots[0].title,'Chief of Staff');assert.equal(ops.name,'Ops');
  assert.deepEqual(ops.tools,DEFAULT_BOT_TOOLS);assert.deepEqual(ops.integrationIds,[]);
  assert.deepEqual(ops.skills,['tupies-product']);
  const verified=await assertSkillIntegrity(store,store.state.skills.find(skill=>skill.id===ops.skills[0]));
  assert.equal(verified.verified,true);assert.equal(verified.files.size,4);
  assert.deepEqual(store.state.connections,[]);assert.deepEqual(store.state.routines,[]);assert.deepEqual(store.state.runs,{});
  assert.deepEqual(store.publicState().onboarding,{version:1,dismissed:false});
  assert.equal(listDocuments(store.state,store).has('onboarding'),false,'guidance preference stays engine-local');
  const publicTemplates=store.publicState().botTemplates;publicTemplates[0].name='Mutated';
  assert.equal(BOT_TEMPLATES[0].name,'Roki','presentation cannot mutate the product templates');
});
test('the first reply step excludes failed sends, progress, partial text and teammate work',async t=>{
  const store=await fresh(t),messages=store.state.messages.bot_atlas=[];
  messages.push({role:'user',runId:'direct',source:'chat',content:'Help me plan.'});
  assert.equal(store.publicState().onboardingProgress.firstReply,false);
  messages.push({role:'assistant',runId:'direct',content:'Checking…',kind:'progress'},{role:'assistant',runId:'direct',content:'Interrupted',partial:true},{role:'user',runId:'child',source:'delegation',fromBotId:'bot_nova',content:'Review.'},{role:'assistant',runId:'child',content:'Reviewed.'});
  assert.equal(store.publicState().onboardingProgress.firstReply,false);
  messages.push({role:'assistant',runId:'direct',content:'Here are the next actions.'});
  assert.equal(store.publicState().onboardingProgress.firstReply,true);
});
test('old workspaces are not opted into onboarding and owner profiles and skill assignments survive restart',async t=>{
  const store=await fresh(t);
  await store.mutate(state=>{delete state.onboarding;state.bots[1].name='Nova';state.bots[1].instructions='My instructions';state.bots[1].skills=[];});
  const before=structuredClone(store.state.bots),reopened=await new Store(store.directory).init();
  assert.equal(reopened.publicState().onboarding,null);assert.deepEqual(reopened.state.bots,before);
});
test('onboarding preference requires owner authentication and CSRF, rejects other fields, and persists without altering execution',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-onboarding-api-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0,'127.0.0.1');
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'synthetic-onboarding-password'})});
  const cookie=setup.headers.get('set-cookie').split(';')[0],{csrf}=await setup.json();
  const patch=(value,headers={Cookie:cookie,'X-CSRF-Token':csrf})=>fetch(url+'/api/onboarding',{method:'PATCH',headers:{'content-type':'application/json',...headers},body:JSON.stringify(value)});
  assert.equal((await patch({dismissed:true},{})).status,401);
  assert.equal((await patch({dismissed:true},{Cookie:cookie})).status,403);
  for(const input of [null,[],{dismissed:'yes'},{dismissed:true,tools:['terminal']},{completed:true}])assert.equal((await patch(input)).status,400);
  const before=JSON.stringify({bots:app.store.state.bots,runs:app.store.state.runs,settings:app.store.state.settings});
  assert.equal((await patch({dismissed:true})).status,200);assert.equal((await patch({dismissed:true})).status,200);
  assert.equal(JSON.stringify({bots:app.store.state.bots,runs:app.store.state.runs,settings:app.store.state.settings}),before);
  assert.deepEqual(JSON.parse(await fs.readFile(app.store.file,'utf8')).onboarding,{version:1,dismissed:true});
});

const onboardingSource=await fs.readFile(new URL('../public/onboarding.js',import.meta.url),'utf8');
const appSource=(await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
function ui(t,{connected=false}={}) {
  const dom=new JSDOM('<div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'http://localhost/#/welcome',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());
  const context=dom.getInternalVMContext();context.matchMedia=()=>({matches:false});context.scrollTo=()=>{};context.HTMLDialogElement.prototype.showModal=function(){this.open=true;};context.HTMLElement.prototype.scrollTo=()=>{};
  context.fixture={...{settings:{},rooms:[],routines:[],skills:[],integrations:[],channels:[],activity:[],runs:{},roomDrives:{},botLastMessageAt:{},connections:[]},onboarding:{version:1,dismissed:false},botTemplates:structuredClone(BOT_TEMPLATES),bots:BOT_TEMPLATES.map((template,i)=>({...template,id:'bot_'+i,starterTemplate:template.id,tools:[...DEFAULT_BOT_TOOLS],skills:[],connectionId:connected?'provider':''}))};
  if(connected)context.fixture.connections=[{id:'provider',type:'openai',status:'connected',defaultModel:'fixture'}];
  context.calls=[];
  vm.runInContext(onboardingSource,context);vm.runInContext(appSource,context);
  const run=code=>vm.runInContext(code,context);
  run("auth={authenticated:true};data={...initialState,...fixture};loadChat=async()=>{};refreshUnread=async()=>{};api=async(path,options)=>{calls.push({path,options});return {};};renderApp();");
  return {window:dom.window,document:dom.window.document,run,calls:context.calls};
}
test('guidance derives readiness from a verified model, survives missing bots, and escapes owner names',t=>{
  const h=ui(t);
  assert.equal(h.document.querySelectorAll('[data-action="onboarding-prompt"]:disabled').length,2);
  h.run("data.connections=[{id:'p',type:'chatgpt',status:'connected',defaultModel:'model',hasOAuth:false}];data.bots[0].connectionId='p';");
  assert.equal(h.run('window.StudioOnboarding.progress(studioContext()).model'),false);
  h.run("data.connections[0].hasOAuth=true;data.connections[0].oauthAccount={planEnabled:true};data.bots[0].name='<img src=x onerror=alert(1)>';data.bots.pop();renderApp();");
  assert.equal(h.run('window.StudioOnboarding.progress(studioContext()).model'),true);
  assert.equal(h.run('window.StudioOnboarding.progress(studioContext()).introduced'),false);
  assert.equal(h.document.querySelectorAll('.onboarding-bot img[onerror]').length,0);
  assert.match(h.document.querySelector('.onboarding-bot h3').textContent,/<img/);
  assert.ok(h.document.querySelector('[data-action="starter-template"][data-template="ops"]'));
});
test('first-task prompts navigate into an editable chat draft without dispatching work or replacing a draft',async t=>{
  const h=ui(t,{connected:true});
  h.document.querySelector('[data-action="onboarding-prompt"]').click();
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(h.window.location.hash,'#/bot/bot_0');
  const input=h.document.querySelector('#message-input');assert.equal(input.value,BOT_TEMPLATES[0].prompt);
  input.value='My existing notes';
  h.run("openBotDraft('bot_0',data.botTemplates[1].prompt)");
  assert.equal(input.value,'My existing notes\n\n'+BOT_TEMPLATES[1].prompt);
  assert.ok(!h.calls.some(call=>call.path.includes('/messages')),'no send or paid inference from a prompt click');
});
test('template selection pre-fills an editable normal bot form without creating a bot',t=>{
  const h=ui(t,{connected:true});
  h.run("botDialog(undefined,'ops')");
  assert.equal(h.document.querySelector('#bot-name').value,'Ops');
  assert.equal(h.document.querySelector('#bot-title').value,'Tupies operator');
  assert.equal(h.document.querySelector('[name="instructions"]').value,BOT_TEMPLATES[1].instructions);
  assert.ok(!h.calls.some(call=>call.path==='/api/bots'));
});
