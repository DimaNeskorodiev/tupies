import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createSpeechController} from '../public/speech.mjs';

const appSource=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const profileSource=await readFile(new URL('../public/bot-profile.js',import.meta.url),'utf8');
const avatarSource=await readFile(new URL('../public/creature-avatars.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const plain=value=>JSON.parse(JSON.stringify(value));

// Run the actual forms and delegated events. Every request is deterministic and
// local to this DOM; no workspace, account, model or engine is contacted.
function ui(t,{phone=false,bot={},inferenceRequest,speechCatalog,botPatchRequest}={}) {
  const dom=new JSDOM('<!doctype html><div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'http://studio.local/#/bot/bot_atlas',runScripts:'outside-only',pretendToBeVisual:true});
  const win=dom.window,doc=win.document,requests=[],toasts=[];
  win.setInterval=()=>1;win.clearInterval=()=>{};win.scrollTo=()=>{};
  win.matchMedia=()=>({matches:phone,addEventListener(){},removeEventListener(){}});
  win.fetch=()=>{throw new Error('This UI fixture must not use the network.');};
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
  const controller=createSpeechController(win);controller.setPreferences({engine:'browser'});win.StudioSpeech={controller};
  const context=dom.getInternalVMContext();vm.runInContext(avatarSource,context);vm.runInContext(profileSource,context);vm.runInContext(appSource,context);
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
    if(path==='/api/bots/bot_atlas'&&options.method==='PATCH')return botPatchRequest?botPatchRequest(options.body):{...saved,...options.body};
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
  assert.deepEqual(data.getAll('tool').sort(),[...h.saved.tools].sort());
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
  for(const field of ['tools','skills','integrationIds','collaborators'])assert.deepEqual([...save.body[field]].sort(),[...h.saved[field]].sort(),`${field} survives the closed disclosure`);
  assert.equal(save.body.description,'An updated introduction.');assert.equal(h.toasts.some(item=>item.error),false);
});

test('a closed new-bot editor keeps inherited provider, safe tools and enabled visibility defaults',t=>{
  const h=ui(t);h.run('botDialog()');const form=h.doc.querySelector('#bot-form'),data=new h.win.FormData(form);
  assert.equal(form.querySelector('.bot-advanced').open,false);
  assert.equal(data.get('connectionId'),'provider');assert.equal(data.get('model'),'');
  assert.equal(data.get('approvalPolicy'),'auto');assert.equal(data.get('teamMode'),'all');
  assert.deepEqual(data.getAll('tool').sort(),['workspace','memory','skills','web','integrations','delegation','automation','setup'].sort());
  assert.equal(data.has('enabled'),true);assert.equal(data.has('hidden'),false);assert.equal(data.get('icon'),'companion:blue');
});

test('the new-bot dialog skill search and access notice respond without losing selected skills',t=>{
  const h=ui(t);h.run('botDialog()');const form=h.doc.querySelector('#bot-form'),search=form.querySelector('[data-settings-skill-search]');
  search.value='No matching playbook';search.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  assert.equal([...form.querySelectorAll('[data-skill-option]')].filter(row=>!row.hidden).length,0);
  assert.match(form.querySelector('[data-settings-skill-results]').textContent,/No matching skills/);
  search.value='';search.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  const skill=form.querySelector('[name=skill]');skill.checked=true;skill.dispatchEvent(new h.win.Event('change',{bubbles:true}));
  const access=form.querySelector('[name=tool][value=skills]');access.checked=false;access.dispatchEvent(new h.win.Event('change',{bubbles:true}));
  assert.equal(form.querySelector('[data-skill-access-notice]').hidden,false);
  assert.deepEqual(new h.win.FormData(form).getAll('skill'),['skill_brief']);
});

function showBotSettings(h){
  h.win.history.replaceState(null,'','#/bots/bot_atlas/settings');
  h.doc.querySelector('#app').innerHTML=h.run("renderBotProfile('bot_atlas')");
  h.run("window.StudioBotProfile.mount(studioContext(),'bot_atlas',document)");
  return h.doc.querySelector('#bot-form');
}

test('bot Settings separates sections and saves one complete configuration including hidden sections',async t=>{
  const h=ui(t),before=plain(h.saved),form=showBotSettings(h);
  assert.equal(h.doc.querySelector('[role=tab][aria-selected=true]').dataset.tab,'settings');
  assert.deepEqual([...form.querySelectorAll('[data-bot-settings-section]')].map(section=>section.dataset.botSettingsSection),['general','instructions','model','tools','skills','memory','team','advanced','remove']);
  const removal=form.querySelector('[data-bot-settings-section=remove] [data-action=delete-bot]');
  assert.ok(removal);assert.equal(removal.closest('details'),null);assert.equal(removal.type,'button');
  const memory=form.querySelector('[name=tool][value=memory]'),episodes=form.querySelector('[name=episodicMemory]');
  assert.equal(form.querySelectorAll('[name=tool][value=memory]').length,1);
  assert.equal(memory.closest('details'),null);assert.equal(episodes.closest('details'),null);
  assert.equal(h.requests.length,0,'opening Settings changes no data');
  const instructions=form.querySelector('[name=instructions]');instructions.value='Prefer the browser for product comparisons.';instructions.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  episodes.checked=true;episodes.dispatchEvent(new h.win.Event('change',{bubbles:true}));
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(h.requests.length,1);const save=h.requests[0];
  assert.equal(save.path,'/api/bots/bot_atlas');assert.equal(save.method,'PATCH');
  assert.equal(save.body.instructions,instructions.value);assert.equal(save.body.episodicMemory,true);
  for(const key of ['connectionId','model','approvalPolicy','contextLimit','teamMode','enabled','hidden'])assert.equal(save.body[key],before[key]);
  for(const key of ['tools','skills','integrationIds','collaborators'])assert.deepEqual([...save.body[key]].sort(),[...before[key]].sort());
  assert.notEqual(form.dataset.settingsDirty,'true');
  Object.assign(h.saved,save.body);const reopened=showBotSettings(h);
  assert.equal(reopened.querySelector('[name=instructions]').value,save.body.instructions);assert.equal(reopened.querySelector('[name=episodicMemory]').checked,true);
  h.run('openDialog("Quick details",`<button data-action="edit-bot" data-id="bot_atlas">Bot settings</button>`)');
  h.doc.querySelector('dialog [data-action=edit-bot]').click();await tick();
  assert.equal(h.win.location.hash,'#/bots/bot_atlas/settings');assert.equal(h.doc.querySelector('dialog'),null,'an old details dialog cannot cover Settings');
});

test('unsaved Settings survive profile refreshes, tab switches and refused saves',async t=>{
  const h=ui(t);let form=showBotSettings(h),instructions=form.querySelector('[name=instructions]');
  await h.click(form.querySelector('[data-profile-action=settings-section][data-section=instructions]'));
  instructions.value='Keep this unsaved direction.';instructions.focus();instructions.setSelectionRange(5,9);instructions.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  form.querySelector('[name=episodicMemory]').checked=true;form.querySelector('[name=episodicMemory]').dispatchEvent(new h.win.Event('change',{bubbles:true}));
  form=showBotSettings(h);instructions=form.querySelector('[name=instructions]');
  assert.equal(instructions.value,'Keep this unsaved direction.');assert.equal(h.doc.activeElement,instructions);assert.equal(instructions.selectionStart,5);
  h.doc.querySelector('[role=tab][data-tab=memory]').click();await tick();
  h.doc.querySelector('[role=tab][data-tab=settings]').click();await tick();form=h.doc.querySelector('#bot-form');
  assert.equal(form.querySelector('[name=instructions]').value,'Keep this unsaved direction.');assert.equal(form.querySelector('[name=episodicMemory]').checked,true);
  assert.equal(h.requests.length,1,'switching to Memory makes its read request only');
  h.run('api=async()=>{throw new Error("Fixture save refused.")}');
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.match(form.querySelector('.form-error').textContent,/Fixture save refused/);
  assert.equal(form.querySelector('[name=instructions]').value,'Keep this unsaved direction.');
  assert.equal(h.saved.instructions,'Keep it concise.');
  h.doc.querySelector('[data-profile-action=discard-settings]').click();
  assert.equal(h.doc.querySelector('[name=instructions]').value,'Keep it concise.');assert.equal(h.doc.querySelector('[name=episodicMemory]').checked,false);
});

test('a pending bot Settings save locks edits, refuses duplicate submission and keeps failed changes retryable',async t=>{
  const h=ui(t),form=showBotSettings(h),instructions=form.querySelector('[name=instructions]');
  await h.click(form.querySelector('[data-profile-action=settings-section][data-section=instructions]'));
  instructions.value='Keep these changes if saving fails.';instructions.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  h.run(`const beforePendingSettingsApi=api;let settingsSaveAttempts=0,rejectPendingSettings;
    api=async(path,options={})=>{
      if(path==='/api/bots/bot_atlas'&&options.method==='PATCH'){
        settingsSaveAttempts++;
        if(settingsSaveAttempts===1)await new Promise((resolve,reject)=>{rejectPendingSettings=reject;});
      }
      return beforePendingSettingsApi(path,options);
    };`);
  const submit=()=>form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));
  submit();await tick();
  assert.equal(instructions.disabled,true,'the submitted snapshot cannot be edited while saving');
  assert.equal(form.querySelector('[data-profile-action=discard-settings]').disabled,true);
  assert.equal(form.querySelector('[type=submit]').disabled,true);
  await h.click(h.doc.querySelector('[role=tab][data-tab=memory]'));
  assert.equal(h.doc.querySelector('[role=tab][aria-selected=true]').dataset.tab,'settings','profile tabs cannot abandon the pending form');
  assert.equal(showBotSettings(h),form,'a shell refresh retains the exact pending form and its lock');
  assert.equal(instructions.disabled,true);
  submit();await tick();assert.equal(h.run('settingsSaveAttempts'),1,'a pending save is sent only once');
  h.run('rejectPendingSettings(new Error("Temporary settings failure."))');await tick();
  assert.match(form.querySelector('.form-error').textContent,/Temporary settings failure/);
  assert.equal(instructions.value,'Keep these changes if saving fails.');assert.equal(instructions.disabled,false);
  assert.equal(form.dataset.settingsDirty,'true');assert.equal(form.querySelector('[type=submit]').disabled,false);
  assert.equal(form.querySelector('[data-profile-action=discard-settings]').disabled,false);
  submit();await tick();
  assert.equal(h.run('settingsSaveAttempts'),2);
  assert.equal(h.requests.filter(request=>request.method==='PATCH').length,1);
  assert.equal(h.requests.find(request=>request.method==='PATCH').body.instructions,'Keep these changes if saving fails.');
  assert.notEqual(form.dataset.settingsDirty,'true');assert.equal(form.querySelector('[type=submit]').disabled,true);
});

test('saving from another page resets the originating form before returning during state refresh',async t=>{
  const h=ui(t),form=showBotSettings(h),instructions=form.querySelector('[name=instructions]');
  instructions.value='Saved while viewing another page.';instructions.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  h.run(`const beforeDetachedSettingsApi=api;let finishDetachedSettings,finishSettingsRefresh;
    api=async(path,options={})=>{
      if(path==='/api/bots/bot_atlas'&&options.method==='PATCH')await new Promise(resolve=>{finishDetachedSettings=resolve;});
      return beforeDetachedSettingsApi(path,options);
    };
    refresh=()=>new Promise(resolve=>{finishSettingsRefresh=resolve;});`);
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  h.win.history.replaceState(null,'','#/bots');h.doc.querySelector('#app').innerHTML='<p>Another page</p>';
  h.run('finishDetachedSettings()');await tick();
  assert.equal(h.run('botById("bot_atlas").instructions'),'Saved while viewing another page.');
  assert.equal(showBotSettings(h),form,'returning before refresh completes restores the original locked form');
  h.run('finishSettingsRefresh()');await tick();
  assert.notEqual(form.dataset.settingsDirty,'true');assert.equal(form.querySelector('[type=submit]').disabled,true);
  assert.equal(form.querySelector('[data-settings-status]').textContent,'All changes saved');
});

test('a bot Settings refusal received on another page remains visible with its retryable draft',async t=>{
  const h=ui(t),form=showBotSettings(h),instructions=form.querySelector('[name=instructions]');
  instructions.value='Keep my refused draft.';instructions.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  h.run('let rejectDetachedSettings;api=()=>new Promise((resolve,reject)=>{rejectDetachedSettings=reject;});');
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  h.win.history.replaceState(null,'','#/bots');h.doc.querySelector('#app').innerHTML='<p>Another page</p>';
  h.run('rejectDetachedSettings(new Error("The bot settings could not be saved."))');await tick();
  const reopened=showBotSettings(h);
  assert.equal(reopened.querySelector('[name=instructions]').value,'Keep my refused draft.');
  assert.match(reopened.querySelector('.form-error').textContent,/The bot settings could not be saved/);
  assert.equal(reopened.querySelector('[type=submit]').disabled,false);
});

test('asynchronous chat options expose model and reasoning while retaining form values',async t=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;}),h=ui(t,{inferenceRequest:()=>pending});
  h.chat();h.doc.querySelector('#message-input').value='A draft stays in the composer.';
  const loading=h.run("chatOptionsDialog('bot_atlas')"),form=h.doc.querySelector('#chat-options-form');
  assert.equal(form.dataset.inferenceReady,'false');assert.equal(form.querySelector('details').open,true);
  assert.equal(form.querySelector('#chat-model'),null);
  finish({model:'model-a',effectiveModel:'model-a',defaultModel:'model-a',reasoningEffort:'high',models:[{id:'model-a',name:'Model A',reasoning:{supported:true,efforts:['low','high']}}],reasoning:{supported:true,efforts:['low','high']},conversation:{tokens:12000}});await loading;
  const model=form.querySelector('#chat-inference-options').closest('details'),history=form.querySelector('#chat-context-tools');
  assert.equal(model.open,true);assert.equal(model.querySelector('summary').textContent,'Model & reasoning');
  assert.equal(history.open,false);assert.equal(history.querySelector('summary').textContent,'Conversation history');
  assert.deepEqual([...form.querySelectorAll('details')].map(details=>[details.querySelector('summary').textContent,details.open]),[['Model & reasoning',true],['Conversation history',false],['Voice & dictation',false]]);
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

test('saving voice preferences preserves an unavailable model override in visible options',async t=>{
  const h=ui(t,{bot:{model:'retired-model'},inferenceRequest:()=>({model:'retired-model',effectiveModel:'retired-model',defaultModel:'model-a',reasoningEffort:'high',models:[{id:'model-a',name:'Model A'}],reasoning:{supported:false,efforts:[]}})});
  await h.run("chatOptionsDialog('bot_atlas')");const form=h.doc.querySelector('#chat-options-form');
  const model=form.querySelector('#chat-model');assert.equal(model.value,'retired-model');
  assert.equal(model.closest('details').open,true);assert.equal(form.dataset.inferenceDirty,'false');
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

test('the chat profile menu supports keyboard navigation and Escape returns focus to chat options',async t=>{
  const h=ui(t);h.chat();const anchor=h.doc.querySelector('.chat-more');anchor.focus();await h.click(anchor);
  const menu=h.doc.querySelector('[role=menu]'),items=[...menu.querySelectorAll('[role=menuitem]')];
  assert.equal(anchor.getAttribute('aria-expanded'),'true');assert.equal(h.doc.activeElement,items[0]);
  assert.equal(items[0].dataset.nav,'/bots/bot_atlas');assert.match(items[0].textContent,/Bot profile/);
  h.key(h.doc.activeElement,'End');assert.equal(h.doc.activeElement,items.at(-1));
  h.key(h.doc.activeElement,'Home');assert.equal(h.doc.activeElement,items[0]);
  for(let index=1;index<items.length;index++){h.key(h.doc.activeElement,'ArrowDown');assert.equal(h.doc.activeElement,items[index]);}
  h.key(h.doc.activeElement,'ArrowDown');assert.equal(h.doc.activeElement,items[0]);
  h.key(h.doc.activeElement,'ArrowUp');assert.equal(h.doc.activeElement,items.at(-1));
  h.key(h.doc.activeElement,'Escape');
  assert.equal(h.doc.querySelector('[role=menu]'),null);assert.equal(anchor.getAttribute('aria-expanded'),'false');assert.equal(h.doc.activeElement,anchor);
  await h.click(anchor);await h.click(h.doc.activeElement);
  assert.equal(h.win.location.hash,'#/bots/bot_atlas');assert.equal(h.doc.querySelector('[role=menu]'),null);
  assert.equal(anchor.getAttribute('aria-expanded'),'false');assert.equal(h.requests.length,0,'opening a profile does not change bot settings');
});

test('phone chat menu dismissal and profile navigation preserve the message draft',async t=>{
  const h=ui(t,{phone:true});h.chat();const composer=h.doc.querySelector('#message-input');composer.value='Keep this draft.';
  const anchor=h.doc.querySelector('.chat-more');anchor.focus();await h.click(anchor);
  h.key(h.doc.activeElement,'Escape');assert.equal(h.doc.querySelector('[role=menu]'),null);assert.equal(h.doc.activeElement,anchor);
  assert.equal(composer.value,'Keep this draft.');
  await h.click(anchor);await h.click(h.doc.querySelector('[role=menu] [data-nav="/bots/bot_atlas"]'));
  assert.equal(h.win.location.hash,'#/bots/bot_atlas');assert.equal(h.doc.querySelector('[role=menu]'),null);
  assert.equal(composer.value,'Keep this draft.');assert.equal(h.requests.length,0);
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

test('Action review is visible in General, saves per bot and survives reopening',async t=>{
  const h=ui(t,{bot:{approvalPolicy:'auto'}}),form=showBotSettings(h);
  const policy=form.querySelector('[name=approvalPolicy]');
  assert.equal(policy.closest('[data-bot-settings-section]').dataset.botSettingsSection,'general');
  assert.equal(policy.closest('[data-bot-settings-section]').hidden,false);
  assert.equal(policy.value,'auto');assert.match(policy.selectedOptions[0].textContent,/Approve for me/);
  assert.match(form.querySelector('#bot-approval-help').textContent,/across chats and restarts/);
  policy.value='balanced';policy.dispatchEvent(new h.win.Event('change',{bubbles:true}));
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  const save=h.requests.find(request=>request.method==='PATCH');assert.equal(save.body.approvalPolicy,'balanced');
  h.saved.approvalPolicy='balanced';h.run("data.bots[0].approvalPolicy='balanced'");
  const reopened=showBotSettings(h);assert.equal(reopened.querySelector('[name=approvalPolicy]').value,'balanced');
  const timeline=h.run("renderTimeline({id:'auto-test',events:[{type:'approval.automatic'}]})");assert.match(timeline,/Approved automatically/);
});


test('chat review selector saves the same bot setting without touching the message draft or attachments',async t=>{
  const h=ui(t,{bot:{approvalPolicy:'auto'}});h.chat();
  const field=h.doc.querySelector('#chat-approval-policy'),draft=h.doc.querySelector('#message-input');
  assert.equal(field.value,'auto');assert.equal(field.getAttribute('aria-label'),'Action review');
  draft.value='Keep my unfinished message.';
  h.run("composerAttachments.set('bot_atlas',[{path:'input.txt',name:'input.txt'}])");
  field.value='strict';field.dispatchEvent(new h.win.Event('change',{bubbles:true}));await tick();
  assert.equal(h.requests.length,1);assert.deepEqual(h.requests[0].body,{approvalPolicy:'strict'});
  assert.equal(h.run("botById('bot_atlas').approvalPolicy"),'strict');assert.equal(field.value,'strict');
  assert.equal(h.doc.querySelector('#message-input'),draft);assert.equal(draft.value,'Keep my unfinished message.');
  assert.equal(h.run("composerAttachments.get('bot_atlas').length"),1);
  const form=showBotSettings(h);assert.equal(form.querySelector('[name=approvalPolicy]').value,'strict');
  h.chat();assert.equal(h.doc.querySelector('#chat-approval-policy').value,'strict');
});

test('chat review locks while saving and blocks Send until acknowledgement',async t=>{
  let finish;const h=ui(t,{bot:{approvalPolicy:'balanced'},botPatchRequest:()=>new Promise(resolve=>{finish=resolve;})});h.chat();
  const field=h.doc.querySelector('#chat-approval-policy'),draft=h.doc.querySelector('#message-input');draft.value='Wait for the saved mode.';
  field.value='auto';field.dispatchEvent(new h.win.Event('change',{bubbles:true}));await tick();
  assert.equal(field.disabled,true);assert.match(h.doc.querySelector('#chat-approval-status').textContent,/Saving/);
  await h.run("saveChatReview('bot_atlas','strict')");assert.equal(h.requests.length,1);
  h.doc.querySelector('#message-form').dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(h.requests.length,1);assert.equal(draft.value,'Wait for the saved mode.');
  assert.ok(h.toasts.some(item=>/action review.*saving/.test(item.message)));
  finish({...h.saved,approvalPolicy:'auto'});await tick();assert.equal(field.disabled,false);assert.equal(field.value,'auto');
  assert.equal(h.doc.querySelector('#chat-approval-status').hidden,true);
});

test('chat review preserves the saved mode after refusal and refuses changes during active work',async t=>{
  const h=ui(t,{botPatchRequest:()=>{throw Object.assign(new Error('Wait for this bot to finish.'),{status:409});}});h.chat();
  const field=h.doc.querySelector('#chat-approval-policy');field.value='auto';field.dispatchEvent(new h.win.Event('change',{bubbles:true}));await tick();
  assert.equal(field.value,'strict');assert.match(h.doc.querySelector('#chat-approval-status').textContent,/Wait for this bot/);
  h.run("chat.run={id:'active',status:'waiting_for_approval'};updateChatReview(botById('bot_atlas'))");assert.equal(field.disabled,true);
  await h.run("saveChatReview('bot_atlas','auto')");assert.equal(h.requests.length,1);
  h.run("chat.run={id:'active',status:'completed'};chatReviewErrors.clear();updateChatReview(botById('bot_atlas'))");assert.equal(field.disabled,false);
  h.run("chat.elsewhere={name:'Home'};updateChatReview(botById('bot_atlas'))");assert.equal(field.disabled,true);
});

test('chat review ignores late sign-out responses and stale workspace snapshots',async t=>{
  let finish;const h=ui(t,{botPatchRequest:()=>new Promise(resolve=>{finish=resolve;})});h.chat();
  const promise=h.run("saveChatReview('bot_atlas','auto')");await tick();finish({...h.saved,approvalPolicy:'auto'});await promise;
  assert.equal(h.run("applyWorkspaceState(fixtureData,0)"),false);assert.equal(h.run("botById('bot_atlas').approvalPolicy"),'auto');
  const late=h.run("saveChatReview('bot_atlas','balanced')");await tick();h.run('renderAuth()');
  finish({...h.saved,approvalPolicy:'balanced'});await late;
  assert.equal(h.run("botById('bot_atlas')?.approvalPolicy"),'auto','late response cannot overwrite the retained cached mode after sign-out');
  assert.equal(h.doc.querySelector('#chat-approval-policy'),null);
});
