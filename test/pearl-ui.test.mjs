import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createSpeechController} from '../public/speech.mjs';

const appSource=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const avatarSource=await readFile(new URL('../public/creature-avatars.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const plain=value=>JSON.parse(JSON.stringify(value));

// Run the actual forms and delegated events. Every request is deterministic and
// local to this DOM; no workspace, account, model or engine is contacted.
function ui(t,{phone=false,bot={},inferenceRequest,speechCatalog}={}) {
  const dom=new JSDOM('<!doctype html><div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'http://studio.local/#/bot/bot_atlas',runScripts:'outside-only',pretendToBeVisual:true});
  const win=dom.window,doc=win.document,requests=[],toasts=[];
  win.setInterval=()=>1;win.clearInterval=()=>{};
  win.matchMedia=()=>({matches:phone,addEventListener(){},removeEventListener(){}});
  win.fetch=()=>{throw new Error('This UI fixture must not use the network.');};
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
  const controller=createSpeechController(win);controller.setPreferences({engine:'browser'});win.StudioSpeech={controller};
  const context=dom.getInternalVMContext();vm.runInContext(avatarSource,context);vm.runInContext(appSource,context);
  const saved={id:'bot_atlas',name:'Atlas',title:'Chief of staff',description:'Plans useful work.',instructions:'Keep it concise.',icon:'roki',color:'coral',connectionId:'provider',model:'model-a',reasoningEffort:'high',approvalPolicy:'strict',contextLimit:'128k',tools:['workspace','memory','delegation','terminal'],skills:['skill_brief'],integrationIds:['integration_docs'],teamMode:'selected',collaborators:['bot_nova'],enabled:false,hidden:true,...bot};
  const fixture={settings:{defaultConnectionId:'provider'},bots:[saved,{id:'bot_nova',name:'Nova',title:'Research',connectionId:'provider'}],connections:[{id:'provider',name:'Fixture provider',type:'openai',status:'connected',defaultModel:'model-a',models:[{id:'model-a',name:'Model A'}]}],skills:[{id:'skill_brief',name:'Briefing'}],integrations:[{id:'integration_docs',name:'Docs',type:'mcp',enabled:true}],rooms:[],routines:[],activity:[],runs:{},roomDrives:{}};
  if(speechCatalog)fixture.connections.push({id:'router',name:'Speech fixture',type:'openrouter',hasKey:true});
  win.fixtureData=fixture;win.fixtureApi=async(path,options={})=>{
    requests.push(plain({path,...options}));
    if(speechCatalog&&path.startsWith('/api/speech/catalog'))return speechCatalog;
    if(path.endsWith('/inference')&&!options.method){
      if(inferenceRequest)return inferenceRequest();
      return {model:'model-a',effectiveModel:'model-a',defaultModel:'model-a',reasoningEffort:'high',models:[{id:'model-a',name:'Model A',reasoning:{supported:true,efforts:['low','high']}}],reasoning:{supported:true,efforts:['low','high']},context:{window:128000,compactAt:115200,source:'provider'},conversation:{tokens:12000}};
    }
    if(path.endsWith('/inference')&&options.method==='PATCH')return {bot:{...saved,...options.body}};
    if(path==='/api/bots/bot_atlas'&&options.method==='PATCH')return {...saved,...options.body};
    if(path==='/api/rooms/room_fixture'&&options.method==='PATCH')return {...fixture.rooms[0],...options.body};
    throw new Error(`Unexpected fixture request: ${path}`);
  };
  win.fixtureToast=(message,error)=>toasts.push({message,error:Boolean(error)});
  vm.runInContext('data={...initialState,...fixtureData};auth={authenticated:true,csrf:"fixture"};api=fixtureApi;toast=fixtureToast;refresh=async()=>{};renderApp=()=>{};',context);
  const run=code=>vm.runInContext(code,context);
  const chat=()=>{doc.querySelector('#app').innerHTML=run("renderChat('bot_atlas')");};
  const click=async element=>{assert.ok(element,'missing fixture control');element.click();await tick();};
  const key=(element,key)=>element.dispatchEvent(new win.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
  t.after(()=>{controller.cleanup();win.close();});
  return {win,doc,controller,requests,toasts,saved,fixture,run,chat,click,key};
}

test('closed advanced bot settings preserve the complete edited configuration on save',async t=>{
  const h=ui(t);h.run("botDialog('bot_atlas')");
  const form=h.doc.querySelector('#bot-form'),advanced=form.querySelector('.bot-advanced');
  assert.equal(advanced.open,false);assert.equal(form.querySelector('.bot-capabilities').open,false);
  const data=new h.win.FormData(form);
  assert.deepEqual(data.getAll('tool'),h.saved.tools);
  assert.equal(data.get('connectionId'),'provider');assert.equal(data.get('model'),'model-a');
  assert.equal(data.get('approvalPolicy'),'strict');assert.equal(data.get('contextLimit'),'128k');
  assert.deepEqual(data.getAll('collaborator'),['bot_nova']);assert.equal(data.get('teamMode'),'selected');
  assert.deepEqual(data.getAll('skill'),['skill_brief']);assert.deepEqual(data.getAll('integrationId'),['integration_docs']);
  assert.equal(data.has('enabled'),false);assert.equal(data.has('hidden'),true);
  assert.equal(h.requests.length,0,'opening or folding the editor does not save');
  h.doc.querySelector('#bot-description').value='An updated introduction.';
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(h.requests.length,1);const save=h.requests[0];
  assert.equal(save.path,'/api/bots/bot_atlas');assert.equal(save.method,'PATCH');
  for(const field of ['connectionId','model','approvalPolicy','contextLimit','icon','color','teamMode','enabled','hidden'])assert.equal(save.body[field],h.saved[field],`${field} survives the closed disclosure`);
  for(const field of ['tools','skills','integrationIds','collaborators'])assert.deepEqual(save.body[field],h.saved[field],`${field} survives the closed disclosure`);
  assert.equal(save.body.description,'An updated introduction.');assert.equal(h.toasts.some(item=>item.error),false);
});

test('a closed new-bot editor keeps inherited provider, safe tools and enabled visibility defaults',t=>{
  const h=ui(t);h.run('botDialog()');const form=h.doc.querySelector('#bot-form'),data=new h.win.FormData(form);
  assert.equal(form.querySelector('.bot-advanced').open,false);
  assert.equal(data.get('connectionId'),'provider');assert.equal(data.get('model'),'');
  assert.equal(data.get('approvalPolicy'),'balanced');assert.equal(data.get('teamMode'),'all');
  assert.deepEqual(data.getAll('tool'),['workspace','memory','skills','web','integrations','delegation','automation']);
  assert.equal(data.has('enabled'),true);assert.equal(data.has('hidden'),false);assert.equal(data.get('icon'),'companion:blue');
});

test('asynchronous chat options keep model and conversation controls collapsed and retain their form values',async t=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;}),h=ui(t,{inferenceRequest:()=>pending});
  h.chat();h.doc.querySelector('#message-input').value='A draft stays in the composer.';
  const loading=h.run("chatOptionsDialog('bot_atlas')"),form=h.doc.querySelector('#chat-options-form');
  assert.equal(form.dataset.inferenceReady,'false');assert.equal(form.querySelector('details').open,false);
  assert.equal(form.querySelector('#chat-model'),null);
  finish({model:'model-a',effectiveModel:'model-a',defaultModel:'model-a',reasoningEffort:'high',models:[{id:'model-a',name:'Model A',reasoning:{supported:true,efforts:['low','high']}}],reasoning:{supported:true,efforts:['low','high']},conversation:{tokens:12000}});await loading;
  const model=form.querySelector('#chat-inference-options').closest('details'),history=form.querySelector('#chat-context-tools');
  assert.equal(model.open,false);assert.equal(model.querySelector('summary').textContent,'Model & reasoning');
  assert.equal(history.open,false);assert.equal(history.querySelector('summary').textContent,'Conversation history');
  assert.deepEqual([...form.querySelectorAll('details')].map(details=>[details.querySelector('summary').textContent,details.open]),[['Model & reasoning',false],['Conversation history',false],['Voice & dictation',false]]);
  assert.equal(form.dataset.inferenceReady,'true');assert.match(history.textContent,/12K tokens/);
  const data=new h.win.FormData(form);assert.equal(data.get('model'),'model-a');assert.equal(data.get('reasoningEffort'),'high');
  assert.deepEqual([...history.querySelectorAll('button')].map(button=>[button.dataset.action,button.disabled]),[['compact-context',false],['new-topic',false]]);
  form.querySelector('#chat-reasoning').value='low';
  form.querySelector('#chat-reasoning').dispatchEvent(new h.win.Event('change',{bubbles:true}));
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.deepEqual(h.requests.find(request=>request.method==='PATCH')?.body,{model:'model-a',reasoningEffort:'low'},JSON.stringify(h.toasts));
  assert.equal(h.doc.querySelector('#message-input').value,'A draft stays in the composer.');
  assert.equal(h.toasts.some(item=>item.error),false);
});

test('saving voice preferences preserves an unavailable model override hidden in collapsed options',async t=>{
  const h=ui(t,{bot:{model:'retired-model'},inferenceRequest:()=>({model:'retired-model',effectiveModel:'retired-model',defaultModel:'model-a',reasoningEffort:'high',models:[{id:'model-a',name:'Model A'}],reasoning:{supported:false,efforts:[]}})});
  await h.run("chatOptionsDialog('bot_atlas')");const form=h.doc.querySelector('#chat-options-form');
  const model=form.querySelector('#chat-model');assert.equal(model.value,'retired-model');
  assert.equal(model.closest('details').open,false);assert.equal(form.dataset.inferenceDirty,'false');
  form.querySelector('#speech-language').value='uk-UA';form.querySelector('[name=autoRead]').checked=true;
  form.querySelector('#speech-language').dispatchEvent(new h.win.Event('change',{bubbles:true}));
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(h.requests.some(request=>request.method==='PATCH'),false,'voice-only save never clears a missing model override');
  assert.equal(h.run("botById('bot_atlas').model"),'retired-model');
  assert.equal(h.controller.preferences.language,'uk-UA');assert.equal(h.controller.preferences.autoRead,true);
  assert.equal(h.toasts.some(item=>item.error),false);
});

test('an inference-only save leaves unconfigured OpenRouter voice preferences untouched',async t=>{
  const h=ui(t);h.controller.setPreferences({engine:'openrouter',connectionId:'',cloudConsent:false,language:'pl-PL',autoRead:false});
  const before=plain(h.controller.preferences),setPreferences=h.controller.setPreferences;let voiceChanges=0;
  h.controller.setPreferences=function(update){voiceChanges++;return setPreferences.call(this,update);};
  await h.run("chatOptionsDialog('bot_atlas')");const form=h.doc.querySelector('#chat-options-form');
  assert.equal(form.querySelector('[data-voice-settings]').open,false);assert.equal(form.dataset.voiceDirty,'false');
  assert.equal(form.querySelector('[name=cloudSpeechConsent]').required,false,'untouched optional speech cannot block a basic model save');
  assert.equal(form.checkValidity(),true);
  const reasoning=form.querySelector('#chat-reasoning');reasoning.value='low';reasoning.dispatchEvent(new h.win.Event('change',{bubbles:true}));
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.deepEqual(h.requests.map(request=>[request.path,request.method||'GET']),[['/api/bots/bot_atlas/inference','GET'],['/api/bots/bot_atlas/inference','PATCH']]);
  assert.deepEqual(h.requests[1].body,{model:'model-a',reasoningEffort:'low'});
  assert.equal(voiceChanges,0);assert.deepEqual(plain(h.controller.preferences),before);
  assert.equal(h.doc.querySelector('dialog'),null);assert.equal(h.toasts.some(item=>item.error),false);
});

test('an explicit paid voice still requires consent before either voice or inference can save',async t=>{
  const catalog={connectionId:'router',speech:[{id:'elevenlabs/eleven-v4-turbo',name:'Eleven v4 Turbo',voices:['george','sarah']}],transcription:[{id:'elevenlabs/scribe-v2',name:'Scribe'}]};
  const h=ui(t,{speechCatalog:catalog});h.controller.setPreferences({engine:'openrouter',connectionId:'router',cloudConsent:false});
  const before=plain(h.controller.preferences);await h.run("chatOptionsDialog('bot_atlas')");await tick();
  const form=h.doc.querySelector('#chat-options-form'),voice=form.querySelector('#speech-ai-voice');
  assert.deepEqual([...voice.options].map(option=>option.value),['george','sarah']);
  voice.value='sarah';voice.dispatchEvent(new h.win.Event('change',{bubbles:true}));
  const reasoning=form.querySelector('#chat-reasoning');reasoning.value='low';reasoning.dispatchEvent(new h.win.Event('change',{bubbles:true}));
  assert.equal(form.dataset.voiceDirty,'true');assert.equal(form.querySelector('[name=cloudSpeechConsent]').required,true);assert.equal(form.checkValidity(),false);
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.match(form.querySelector('.form-error').textContent,/Allow OpenRouter speech processing/);
  assert.equal(h.requests.some(request=>request.method==='PATCH'),false);
  assert.equal(h.requests.some(request=>/synthesize|transcribe/.test(request.path)),false,'consent failure makes no paid speech request');
  assert.deepEqual(plain(h.controller.preferences),before);assert.equal(h.doc.querySelector('#chat-options-form'),form);
});

test('changing reasoning preserves the actual unavailable model value for engine validation',async t=>{
  const h=ui(t,{bot:{model:'retired-model'},inferenceRequest:()=>({model:'retired-model',effectiveModel:'retired-model',defaultModel:'model-a',reasoningEffort:'high',models:[{id:'model-a',name:'Model A'}],reasoning:{supported:true,efforts:['low','high']}})});
  await h.run("chatOptionsDialog('bot_atlas')");const form=h.doc.querySelector('#chat-options-form');
  assert.equal(form.querySelector('#chat-model').value,'retired-model');
  assert.equal(form.querySelector('#chat-model').selectedOptions[0].disabled,true);
  // This JSDOM version includes disabled selected options. Match browsers'
  // successful-control serialization to exercise the omitted-value boundary.
  const NativeFormData=h.win.FormData;h.win.FormData=class extends NativeFormData{constructor(element){super(element);if(element===form)this.delete('model');}};
  const reasoning=form.querySelector('#chat-reasoning');reasoning.value='low';reasoning.dispatchEvent(new h.win.Event('change',{bubbles:true}));
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.deepEqual(h.requests.find(request=>request.method==='PATCH')?.body,{model:'retired-model',reasoningEffort:'low'},'the engine receives the original override, never an implicit reset to default');
});

test('active work keeps history mutations disabled inside the collapsed conversation disclosure',async t=>{
  const h=ui(t,{inferenceRequest:()=>({model:'model-a',effectiveModel:'model-a',models:[{id:'model-a'}],reasoning:{supported:false,efforts:[]},activeRun:{id:'run_fixture',status:'running'}})});
  await h.run("chatOptionsDialog('bot_atlas')");const history=h.doc.querySelector('#chat-context-tools');
  assert.equal(history.open,false);
  assert.deepEqual([...history.querySelectorAll('button')].map(button=>[button.dataset.action,button.disabled]),[['compact-context',true],['new-topic',true]]);
  assert.equal(h.requests.length,1);
});

test('closed room collaboration settings preserve membership and the bounded handoff budget',async t=>{
  const h=ui(t);h.fixture.rooms.push({id:'room_fixture',name:'Product room',botIds:['bot_atlas','bot_nova'],autoCollaborate:true,maxRounds:6});
  h.run("roomDialog('room_fixture')");const form=h.doc.querySelector('#room-form');
  assert.equal(form.querySelector('details').open,false);const data=new h.win.FormData(form);
  assert.deepEqual(data.getAll('member'),['bot_atlas','bot_nova']);assert.equal(data.has('autoCollaborate'),true);assert.equal(data.get('maxRounds'),'6');
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].path,'/api/rooms/room_fixture');
  assert.deepEqual(h.requests[0].body,{name:'Product room',botIds:['bot_atlas','bot_nova'],autoCollaborate:true,maxRounds:6});
});

test('quick details supports keyboard menu navigation and Escape returns focus to chat options',async t=>{
  const h=ui(t);h.chat();const anchor=h.doc.querySelector('.chat-more');anchor.focus();await h.click(anchor);
  const menu=h.doc.querySelector('[role=menu]'),items=[...menu.querySelectorAll('[role=menuitem]')];
  assert.equal(anchor.getAttribute('aria-expanded'),'true');assert.equal(h.doc.activeElement,items[0]);
  h.key(h.doc.activeElement,'End');assert.equal(h.doc.activeElement,items.at(-1));
  h.key(h.doc.activeElement,'Home');assert.equal(h.doc.activeElement,items[0]);
  const detailsIndex=items.findIndex(item=>item.dataset.action==='toggle-inspector');assert.ok(detailsIndex>0);
  for(let index=1;index<=detailsIndex;index++){h.key(h.doc.activeElement,'ArrowDown');assert.equal(h.doc.activeElement,items[index]);}
  assert.equal(h.doc.activeElement.dataset.action,'toggle-inspector');await h.click(h.doc.activeElement);
  const inspector=h.doc.querySelector('.bot-inspector');
  assert.equal(h.doc.querySelector('[role=menu]'),null);assert.equal(anchor.getAttribute('aria-expanded'),'false');
  assert.equal(inspector.classList.contains('open'),true);assert.equal(h.doc.activeElement,inspector);
  h.key(inspector,'Escape');assert.equal(inspector.classList.contains('open'),false);assert.equal(h.doc.activeElement,anchor);
  await h.click(anchor);h.key(h.doc.activeElement,'Escape');
  assert.equal(h.doc.querySelector('[role=menu]'),null);assert.equal(h.doc.activeElement,anchor);
});

test('phone quick details opens a dismissible dialog while preserving the message draft',async t=>{
  const h=ui(t,{phone:true});h.chat();h.doc.querySelector('#message-input').value='Keep this draft.';
  await h.click(h.doc.querySelector('.chat-more'));
  await h.click(h.doc.querySelector('[data-action=toggle-inspector]'));
  const dialog=h.doc.querySelector('dialog');assert.ok(dialog);assert.equal(dialog.getAttribute('aria-label'),'About your teammate');
  const dismiss=dialog.querySelector('[aria-label="Close bot details"]');assert.equal(dismiss.dataset.action,'close-dialog');
  await h.click(dismiss);assert.equal(h.doc.querySelector('dialog'),null);
  assert.equal(h.doc.querySelector('#message-input').value,'Keep this draft.');assert.equal(h.requests.length,0);
});

for(const [route,disclosure,label] of [['settings','settings-more','More settings'],['connections','settings-sections','Models']]) {
  test(`${label} disclosure preserves its state and summary focus during a page refresh`,t=>{
    const h=ui(t);h.run(`location.hash='#/${route}'`);
    h.doc.querySelector('#app').innerHTML=`<main id="main-content">${h.run('renderPage()')}</main>`;
    const selector=`details[data-disclosure="${disclosure}"]`,original=h.doc.querySelector(selector);
    assert.ok(original);assert.equal(original.open,false);
    original.open=true;original.querySelector('summary').focus();
    h.run('showPage()');const refreshed=h.doc.querySelector(selector);
    assert.notEqual(refreshed,original,'the fixture exercises replacement during a data refresh');
    assert.equal(refreshed.open,true);assert.equal(h.doc.activeElement,refreshed.querySelector('summary'));
    refreshed.open=false;h.run('showPage()');
    const closed=h.doc.querySelector(selector);assert.equal(closed.open,false);
    assert.equal(h.doc.activeElement,closed.querySelector('summary'),'keyboard focus survives a refresh while collapsed, too');
    assert.equal(h.requests.length,0);
  });
}
