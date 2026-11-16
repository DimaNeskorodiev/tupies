import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

// The shared provider + model picker against a real DOM with deterministic fixtures. No engine, account or network.
const read=name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8');
const [pickerSource,appRaw,css]=await Promise.all([read('model-picker.js'),read('app.js'),read('model-picker.css')]);
const appSource=appRaw.replace(/\nstart\(\);\s*$/,'\n');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settle=async()=>{for(let i=0;i<6;i++)await tick();};
const plain=value=>JSON.parse(JSON.stringify(value));
const CATALOG=[{type:'chatgpt',name:'ChatGPT / Codex subscription',auth:'oauth'},{type:'openrouter',name:'OpenRouter',auth:'api-key'},{type:'openai',name:'OpenAI',auth:'api-key'}];
// Fixture shapes follow /api/state: sealed fields are replaced by hasKey/hasOAuth.
const signedIn={id:'provider_codex_main',name:'ChatGPT / Codex subscription',type:'chatgpt',status:'connected',hasOAuth:true,oauthAccount:{subject:'fixture-subject',email:'owner@example.test',planEnabled:true,needsLogin:false},createdAt:'2026-11-01T09:00:00Z',defaultModel:'codex-model'};
const unfinished={id:'provider_codex_retry',name:'ChatGPT / Codex subscription',type:'chatgpt',status:'untested',hasOAuth:false,createdAt:'2026-11-09T09:00:00Z'};
const openrouter={id:'provider_openrouter',name:'OpenRouter',type:'openrouter',status:'connected',hasKey:true,defaultModel:'deepseek/deepseek-v4-pro'};
const bigCatalog=[{id:'deepseek/deepseek-v4-pro',name:'DeepSeek V4 Pro'},{id:'anthropic/claude-sonnet-fixture',name:'Claude Sonnet fixture'},{id:'qwen/qwen3-coder',name:'Qwen3 Coder'},...Array.from({length:300},(_,i)=>({id:`vendor/model-${String(i).padStart(3,'0')}`,name:`Fixture model ${i}`}))];
const codexModels=[{id:'codex-model',name:'Codex model',reasoning:{supported:true,efforts:['low','medium','high'],defaultEffort:'low',parameter:'reasoning.effort',source:'provider'}},{id:'codex-fast',name:'Codex fast',reasoning:{supported:true,efforts:['low','medium'],defaultEffort:'low',parameter:'reasoning.effort',source:'provider'}}];

function page(html='<div id="host"></div>'){
  const dom=new JSDOM(`<!doctype html><div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>${html}`,{url:'http://studio.local/#/bot/bot_atlas',runScripts:'outside-only',pretendToBeVisual:true});
  const win=dom.window;win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});win.fetch=()=>{throw new Error('This UI fixture must not use the network.');};
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
  win.setInterval=()=>1;win.clearInterval=()=>{};win.scrollTo=()=>{};
  vm.runInContext(pickerSource,dom.getInternalVMContext());
  return {dom,win,doc:win.document,picker:win.StudioModelPicker,key:(target,key,extra={})=>target.dispatchEvent(new win.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}))};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('two subscription connections are labelled apart and the unfinished one is an explicit error, not a normal choice',t=>{
  const h=page();t.after(()=>h.win.close());
  h.picker.configure({connections:()=>[signedIn,unfinished,openrouter],catalog:()=>CATALOG});
  const choices=h.picker.providerChoices();
  const main=choices.find(item=>item.id===signedIn.id),retry=choices.find(item=>item.id===unfinished.id);
  assert.notEqual(main.label,retry.label);
  assert.equal(main.label,'ChatGPT / Codex subscription · owner@example.test');assert.equal(main.usable,true);
  assert.equal(retry.label,'ChatGPT / Codex subscription — sign-in not finished');assert.equal(retry.usable,false);assert.match(retry.problem,/never finished/);
  assert.equal(choices.find(item=>item.id===openrouter.id).label,'OpenRouter','a unique provider keeps its plain name');

  // In the select the broken entry is disabled; when it is the saved one the picker says why instead of offering models.
  h.doc.querySelector('#host').innerHTML=h.picker.markup({id:'bot',connectionId:unfinished.id,model:'',connectionName:'connectionId',modelName:'model'});
  const options=[...h.doc.querySelectorAll('#bot-connection option')];
  assert.deepEqual(options.map(option=>[option.value,option.disabled]),[[signedIn.id,false],[unfinished.id,true],[openrouter.id,false]]);
  const status=h.doc.querySelector('.mp-provider-status');assert.equal(status.getAttribute('role'),'alert');assert.ok(status.classList.contains('is-error'));assert.match(status.textContent,/never finished/);
  assert.equal(h.doc.querySelector('.mp-search').disabled,true);

  // Same-named working connections without an account still differ (date, then id).
  const twins=h.picker.providerChoices([{...openrouter,id:'provider_router_a',createdAt:'2026-11-01T00:00:00Z'},{...openrouter,id:'provider_router_b',createdAt:'2026-11-01T05:00:00Z'}]);
  assert.notEqual(twins[0].label,twins[1].label);assert.match(twins[0].label,/^OpenRouter · #uter_a$/);
  // Other broken states are explicit too.
  for(const [connection,pattern] of [[{...signedIn,id:'p1',oauthAccount:{...signedIn.oauthAccount,needsLogin:true}},/expired/],[{...signedIn,id:'p2',oauthBlocked:true},/another engine/],[{...openrouter,id:'p3',hasKey:false},/API key/]])
    assert.match(h.picker.providerProblem(connection),pattern);
});

test('the combobox searches a large catalog by name and id with full keyboard support and listbox semantics',async t=>{
  const h=page('<form id="form"><div id="host"></div><button type="submit">Save</button></form>');t.after(()=>h.win.close());
  const pending=deferred(),changes=[];let submits=0;
  h.picker.configure({connections:()=>[signedIn,openrouter],catalog:()=>CATALOG,loadModels:()=>pending.promise});
  h.doc.querySelector('#host').innerHTML=h.picker.markup({id:'bot',connectionId:openrouter.id,model:'qwen/qwen3-coder',connectionName:'connectionId',modelName:'model'});
  h.doc.querySelector('#form').addEventListener('submit',event=>{event.preventDefault();submits++;});
  h.doc.addEventListener('change',event=>{if(event.target.name==='model')changes.push(event.target.value);});
  const input=h.doc.querySelector('#bot-model-search'),list=h.doc.querySelector('#bot-model-list'),state=h.doc.querySelector('#bot-model-state');
  assert.equal(input.getAttribute('role'),'combobox');assert.equal(input.getAttribute('aria-controls'),'bot-model-list');assert.equal(list.getAttribute('role'),'listbox');
  input.focus();await tick();
  assert.equal(state.textContent,'Loading models…');assert.equal(list.hidden,true);assert.equal(h.doc.querySelector('[data-model-picker]').getAttribute('aria-busy'),'true');
  pending.resolve({models:bigCatalog,defaultModel:'deepseek/deepseek-v4-pro'});await settle();
  h.key(input,'ArrowDown');
  assert.equal(list.hidden,false);assert.equal(input.getAttribute('aria-expanded'),'true');
  assert.equal(list.querySelectorAll('[role=option]').length,200,'long catalogs render a bounded window');assert.match(state.textContent,/Showing 200 of 304/);
  const current=list.querySelector('[aria-selected=true]');assert.equal(current.dataset.value,'qwen/qwen3-coder');assert.match(current.textContent,/Current/);
  assert.equal(list.querySelectorAll('[aria-selected=true]').length,1);

  // Type-to-filter by id fragment and by name words.
  input.value='claude-sonnet';input.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  assert.deepEqual([...list.querySelectorAll('[role=option]')].map(item=>item.dataset.value),['anthropic/claude-sonnet-fixture']);
  input.value='qwen coder';input.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  assert.deepEqual([...list.querySelectorAll('[role=option]')].map(item=>item.dataset.value),['qwen/qwen3-coder']);
  input.value='model-29';input.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  assert.deepEqual([...list.querySelectorAll('[role=option]')].map(item=>item.dataset.value),Array.from({length:10},(_,i)=>`vendor/model-29${i}`));
  assert.match(state.textContent,/^10 matching$/);
  assert.equal(input.getAttribute('aria-activedescendant'),list.querySelector('[role=option]').id);
  h.key(input,'End');assert.equal(input.getAttribute('aria-activedescendant'),list.lastElementChild.id);assert.ok(list.lastElementChild.classList.contains('is-active'));
  h.key(input,'Home');assert.equal(input.getAttribute('aria-activedescendant'),list.firstElementChild.id);
  h.key(input,'ArrowDown');h.key(input,'ArrowDown');h.key(input,'ArrowUp');assert.equal(input.getAttribute('aria-activedescendant'),list.children[1].id);
  input.value='no such model';input.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  assert.equal(list.children.length,0);assert.match(state.textContent,/No models match “no such model”/);
  input.value='v4 pro';input.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  // Enter picks the active option, fills the form field once and never submits the form.
  assert.equal(h.key(input,'Enter'),false);await settle();
  assert.equal(h.doc.querySelector('#bot-model').value,'deepseek/deepseek-v4-pro');assert.deepEqual(changes,['deepseek/deepseek-v4-pro']);assert.equal(submits,0);
  assert.equal(list.hidden,true);assert.equal(input.value,'DeepSeek V4 Pro');
  assert.match(h.doc.querySelector('.mp-current').textContent,/Saved: OpenRouter · Qwen3 Coder/,'the saved line still shows the engine’s value until the form is saved');
  // Escape closes an open list and is not passed on to an enclosing dialog.
  let escaped=0;h.doc.addEventListener('keydown',event=>{if(event.key==='Escape')escaped++;});
  h.key(input,'ArrowDown');assert.equal(list.hidden,false);h.key(input,'Escape');assert.equal(list.hidden,true);assert.equal(escaped,0);
  assert.equal(input.value,'DeepSeek V4 Pro');
  // Provider default is a real choice.
  h.key(input,'ArrowDown');h.key(input,'Home');h.key(input,'Enter');await settle();assert.equal(h.doc.querySelector('#bot-model').value,'');assert.match(input.value,/^Provider default · DeepSeek V4 Pro$/);
});

test('a failed catalog shows an error with retry that cannot be mistaken for a list, and an empty catalog says so',async t=>{
  const h=page();t.after(()=>h.win.close());let attempts=0;
  h.picker.configure({connections:()=>[openrouter],catalog:()=>CATALOG,loadModels:async()=>{attempts++;if(attempts===1)throw new Error('OpenRouter did not answer (502).');return attempts===2?{models:[]}:{models:bigCatalog};}});
  h.doc.querySelector('#host').innerHTML=h.picker.markup({id:'picker',connectionId:openrouter.id,model:'',inline:true});
  const root=h.doc.querySelector('[data-model-picker]');h.picker.attach(root,{});await settle();
  const error=h.doc.querySelector('.mp-error'),list=h.doc.querySelector('.mp-list');
  assert.equal(error.hidden,false);assert.equal(error.getAttribute('role'),'alert');assert.match(error.textContent,/Couldn’t load models\. OpenRouter did not answer \(502\)\./);
  assert.equal(list.hidden,true);assert.equal(list.children.length,0);assert.equal(h.doc.querySelector('.mp-state').textContent,'');assert.ok(root.classList.contains('has-error'));
  error.querySelector('.mp-retry').click();await settle();
  assert.equal(error.hidden,true);assert.match(h.doc.querySelector('.mp-state').textContent,/lists no models\. Provider default is still available/);
  assert.deepEqual([...list.children].map(item=>item.dataset.value),[''],'Provider default stays available');
  h.picker.controller(root).load(openrouter.id,{force:true});await settle();assert.equal(list.children.length,200);assert.equal(attempts,3);
});

function chatHarness({run=null}={}){
  const h=page('');const {win,doc}=h,requests=[];
  const context=h.dom.getInternalVMContext();vm.runInContext(appSource,context,{filename:'app.js'});
  const bot={id:'bot_atlas',name:'Atlas',connectionId:signedIn.id,model:'codex-model',reasoningEffort:'auto',reasoningEffortVersion:1,tools:[],skills:[],enabled:true};
  win.fixtureData={settings:{},bots:[bot],connections:[{...signedIn,models:codexModels},unfinished,{...openrouter}],integrations:[],channels:[],routines:[],skills:[],activity:[],rooms:[],runs:run?{bot_atlas:run}:{},roomDrives:{}};
  const routerModels=bigCatalog.map(item=>({...item,reasoning:{supported:false,efforts:[]}}));
  const state=(target,models,extra={})=>({connectionId:target.connectionId,savedConnectionId:target.connectionId,model:target.model||'',savedModel:target.model||'',effectiveModel:target.model||models[0].id,defaultModel:models[0].id,models,reasoning:models[0].reasoning,reasoningEffort:target.reasoningEffort||'auto',appliesTo:'next-run',...extra});
  win.patchResult=null;
  win.fixtureApi=async(path,options={})=>{requests.push(plain({path,...options}));const method=options.method||'GET';
    if(path===`/api/bots/bot_atlas/inference?connectionId=${openrouter.id}`)return {...state({connectionId:openrouter.id,model:''},routerModels),savedConnectionId:signedIn.id,savedModel:'codex-model',preview:true};
    if(path==='/api/bots/bot_atlas/inference'&&method==='GET'){const current=win.eval('botById("bot_atlas")');return state(current,current.connectionId===openrouter.id?routerModels:codexModels);}
    if(path==='/api/bots/bot_atlas/inference'&&method==='PATCH'){if(win.patchResult)return win.patchResult(options.body);const current=win.eval('botById("bot_atlas")'),next={...current,...options.body};const models=next.connectionId===openrouter.id?routerModels:codexModels;return {bot:next,...state(next,models)};}
    throw new Error(`Unexpected fixture request: ${path}`);
  };
  vm.runInContext('data={...initialState,...fixtureData};providerCatalog='+JSON.stringify(CATALOG)+';auth={authenticated:true,csrf:"fixture"};api=fixtureApi;toast=()=>{};refresh=async()=>false;renderApp=()=>{};updateChatReview=()=>{};',context);
  const runCode=code=>vm.runInContext(code,context);
  doc.querySelector('#app').innerHTML=runCode("chatInferenceBar(botById('bot_atlas'))");
  return {...h,requests,run:runCode,open:async()=>{runCode("openInferencePicker(document.querySelector('.inference-trigger'),'bot_atlas')");await settle();doc.querySelector('[data-picker="models"]').click();await settle();}};
}

test('the chat panel switches provider and model through the same picker, showing what the engine saved',async t=>{
  const h=chatHarness();t.after(()=>{h.run('closeInferencePicker(true,false)');h.win.close();});
  assert.match(h.doc.querySelector('.inference-trigger').getAttribute('aria-label'),/ChatGPT \/ Codex subscription · owner@example\.test, Codex model/);
  await h.open();
  const panel=h.doc.querySelector('.inference-panel'),select=panel.querySelector('.mp-provider-select');
  assert.match(panel.querySelector('.mp-note').textContent,/same choice as Bot settings.*next task; a running task keeps its own/);
  assert.deepEqual([...select.options].map(option=>[option.textContent,option.disabled]),[['ChatGPT / Codex subscription · owner@example.test',false],['ChatGPT / Codex subscription — sign-in not finished',true],['OpenRouter',false]]);
  assert.equal(panel.querySelector('.mp-option[aria-selected=true]').dataset.value,'codex-model');
  // Choosing OpenRouter only browses its catalog; nothing is saved yet.
  select.value=openrouter.id;select.dispatchEvent(new h.win.Event('change',{bubbles:true}));await settle();
  assert.ok(h.requests.some(item=>item.path===`/api/bots/bot_atlas/inference?connectionId=${openrouter.id}`));assert.equal(h.requests.some(item=>item.method==='PATCH'),false);
  const search=panel.querySelector('.mp-search');search.value='deepseek-v4';search.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  h.key(search,'Enter');await settle();
  const patch=h.requests.find(item=>item.method==='PATCH');assert.deepEqual(patch.body,{connectionId:openrouter.id,model:'deepseek/deepseek-v4-pro'});
  assert.equal(h.run("botById('bot_atlas').connectionId"),openrouter.id);
  // Back on the reasoning view the saved provider and model are shown explicitly.
  const heading=h.doc.querySelector('.inference-model-open');assert.match(heading.textContent,/OpenRouter/);assert.match(heading.textContent,/DeepSeek V4 Pro/);
  assert.match(h.doc.querySelector('.inference-trigger').getAttribute('aria-label'),/OpenRouter, DeepSeek V4 Pro/);
});

test('a refused chat save shows an alert and puts the picker back on the saved provider and model',async t=>{
  const h=chatHarness();t.after(()=>{h.run('closeInferencePicker(true,false)');h.win.close();});
  h.win.patchResult=()=>{throw new Error('Wait for this bot’s current task to finish before switching its provider.');};
  await h.open();const panel=h.doc.querySelector('.inference-panel'),select=panel.querySelector('.mp-provider-select');
  select.value=openrouter.id;select.dispatchEvent(new h.win.Event('change',{bubbles:true}));await settle();
  panel.querySelector('.mp-option[data-value="qwen/qwen3-coder"]').click();await settle();
  const note=h.doc.querySelector('.inference-note');assert.equal(note.getAttribute('role'),'alert');assert.ok(note.classList.contains('is-error'));assert.match(note.textContent,/current task to finish/);
  assert.equal(h.run("botById('bot_atlas').connectionId"),signedIn.id);assert.equal(h.run("botById('bot_atlas').model"),'codex-model');
  assert.equal(select.value,signedIn.id,'the provider select shows the saved provider again');
  await settle();assert.equal(panel.querySelector('.mp-option[aria-selected=true]')?.dataset.value,'codex-model');
  assert.match(panel.querySelector('.mp-current').textContent,/Saved: ChatGPT \/ Codex subscription · owner@example\.test · Codex model/);
});

test('while a task runs the chat panel locks the provider and says why, but models on the same provider stay choosable',async t=>{
  const h=chatHarness({run:{id:'run_fixture',status:'running',model:'codex-model',reasoningEffort:'high'}});t.after(()=>{h.run('closeInferencePicker(true,false)');h.win.close();});
  await h.open();const panel=h.doc.querySelector('.inference-panel');
  assert.equal(panel.querySelector('.mp-provider-select').disabled,true);assert.match(panel.querySelector('.mp-provider-status').textContent,/after the current task finishes/);
  panel.querySelector('.mp-option[data-value="codex-fast"]').click();await settle();
  assert.deepEqual(h.requests.find(item=>item.method==='PATCH').body,{model:'codex-fast'});
});

test('Bot settings use the same picker: a provider switch is validated through the inference route and a refusal restores the saved choice',async t=>{
  const h=chatHarness();t.after(()=>h.win.close());
  h.win.settingsRequests=[];h.win.failInference=true;const requests=h.win.settingsRequests;
  h.run(`api=async(path,options={})=>{settingsRequests.push(JSON.parse(JSON.stringify({path,...options})));if(path==='/api/bots/bot_atlas'&&options.method==='PATCH')return {...botById('bot_atlas'),...options.body};if(path.startsWith('/api/connections/')&&path.endsWith('/models'))return {models:${JSON.stringify(bigCatalog)}};if(path==='/api/bots/bot_atlas/inference'&&options.method==='PATCH'){if(failInference)throw new Error('OpenRouter returned no available models. Refresh its catalog and try again.');return {bot:{...botById('bot_atlas'),...options.body},models:[]};}throw new Error('Unexpected settings request: '+path);};`);
  h.win.toasts=[];h.run('toast=(message,error)=>toasts.push({message,error:!!error})');
  h.run("botDialog('bot_atlas')");
  const form=h.doc.querySelector('#bot-form'),select=form.querySelector('#bot-connection');
  assert.equal(form.querySelector('#bot-model').type,'hidden');assert.equal(select.name,'connectionId');
  assert.match(form.querySelector('.mp-current').textContent,/Saved: ChatGPT \/ Codex subscription · owner@example\.test · Codex model/);
  select.value=openrouter.id;select.dispatchEvent(new h.win.Event('change',{bubbles:true}));await settle();
  assert.equal(form.querySelector('#bot-model').value,'','a new provider starts on its default model');
  const input=form.querySelector('#bot-model-search');input.focus();input.value='qwen3';input.dispatchEvent(new h.win.Event('input',{bubbles:true}));h.key(input,'Enter');await settle();
  assert.equal(form.querySelector('#bot-model').value,'qwen/qwen3-coder');
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await settle();
  const saves=requests.filter(item=>item.method==='PATCH');
  assert.equal(saves[0].path,'/api/bots/bot_atlas');assert.equal(Object.hasOwn(saves[0].body,'connectionId'),false);assert.equal(Object.hasOwn(saves[0].body,'model'),false);
  assert.equal(saves[1].path,'/api/bots/bot_atlas/inference');assert.equal(JSON.stringify(saves[1].body),JSON.stringify({connectionId:openrouter.id,model:'qwen/qwen3-coder'}));
  assert.match(form.querySelector('.form-error').textContent,/Bot settings saved\. The model change wasn’t saved: OpenRouter returned no available models/);
  assert.equal(select.value,signedIn.id,'the refused provider switch is undone in the picker');assert.equal(form.querySelector('#bot-model').value,'codex-model');
  assert.equal(h.run("botById('bot_atlas').connectionId"),signedIn.id);assert.equal(h.win.toasts.some(item=>!item.error),false,'a refused save never shows a success toast');
  // A successful retry shows what the engine saved.
  h.win.failInference=false;select.value=openrouter.id;select.dispatchEvent(new h.win.Event('change',{bubbles:true}));await settle();
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await settle();
  assert.equal(h.run("botById('bot_atlas').connectionId"),openrouter.id);assert.equal(h.win.toasts.at(-1).message,'Changes saved.');
  assert.match(form.querySelector('.mp-current').textContent,/Saved: OpenRouter · Provider default/,'the saved line follows the engine’s answer');
});

test('the picker stylesheet keeps error, active and current states visually distinct',()=>{
  assert.match(css,/\.mp-error\{[^}]*border:1px solid rgba\(180,71,63/);
  assert.match(css,/\.mp-option\.is-active\{[^}]*outline/);
  assert.match(css,/\.mp-check\{[^}]*color:var\(--green/);
  assert.match(css,/prefers-reduced-motion/);
});
