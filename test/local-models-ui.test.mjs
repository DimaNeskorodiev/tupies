import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

// Local models in the UI (public/local-models.js + the picker toggle) against a real DOM with fixtures.
// No engine, account, runtime or network is used.
const read=name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8');
const [localSource,pickerSource,appRaw,localCss,pickerCss,indexHtml]=await Promise.all([read('local-models.js'),read('model-picker.js'),read('app.js'),read('local-models.css'),read('model-picker.css'),read('index.html')]);
const appSource=appRaw.replace(/\nstart\(\);\s*$/,'\n');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settle=async()=>{for(let i=0;i<8;i++)await tick();};
const plain=value=>JSON.parse(JSON.stringify(value));
const CATALOG=[{type:'openrouter',name:'OpenRouter',auth:'api-key'},{type:'ollama',name:'Ollama',auth:'none'},{type:'mlx',name:'MLX LM',auth:'none'},{type:'custom',name:'OpenAI-compatible API',auth:'api-key'}];
const openrouter={id:'provider_openrouter',name:'OpenRouter',type:'openrouter',status:'connected',hasKey:true,defaultModel:'deepseek/deepseek-v4-pro'};
const macMlx={id:'provider_mac_mlx',name:'Mac · MLX',type:'mlx',status:'connected',baseUrl:'http://127.0.0.1:8080/v1',defaultModel:'mlx-community/Qwen3.8-27B-4bit'};
const cloudModels=[{id:'deepseek/deepseek-v4-pro',name:'DeepSeek V4 Pro'},{id:'qwen/qwen3-coder',name:'Qwen3 Coder'}];
const localModels=[
  {id:'mlx-community/Qwen3.8-27B-4bit',name:'mlx-community/Qwen3.8-27B-4bit',tools:true,reasoning:{supported:true,efforts:['low','medium','xhigh']},images:{supported:true,source:'provider'},contextWindow:32768},
  {id:'mlx-community/tiny-chat-1b-8bit',tools:false},
];

function page(html='<div id="host"></div>',{storage=true}={}){
  const dom=new JSDOM(`<!doctype html><div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>${html}`,{url:'http://studio.local/#/bot/bot_atlas',runScripts:'outside-only',pretendToBeVisual:true});
  const win=dom.window;win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});win.fetch=()=>{throw new Error('This UI fixture must not use the network.');};
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
  win.setInterval=()=>1;win.clearInterval=()=>{};win.scrollTo=()=>{};
  if(!storage)Object.defineProperty(win,'localStorage',{get(){throw new Error('Storage is blocked.');}});
  const context=dom.getInternalVMContext();vm.runInContext(localSource,context);vm.runInContext(pickerSource,context);
  return {dom,win,doc:win.document,context,local:win.StudioLocalModels,picker:win.StudioModelPicker};
}

test('local connections are recognized from the engine fields, and without them from the type or a loopback URL',t=>{
  const {win,local}=page();t.after(()=>win.close());
  assert.equal(local.isLocal({type:'ollama'}),true);assert.equal(local.isLocal({type:'mlx'}),true);
  assert.equal(local.isLocal({type:'custom',baseUrl:'http://127.0.0.1:1234/v1'}),true);assert.equal(local.isLocal({type:'custom',baseUrl:'https://api.example.test/v1'}),false);
  assert.equal(local.isLocal({type:'openrouter'}),false);assert.equal(local.isLocal(null),false);
  assert.equal(local.isLocal({type:'ollama',local:false}),false,'the engine’s own local flag wins');assert.equal(local.isLocal({type:'custom',baseUrl:'https://x.test',local:true}),true);
  assert.equal(local.hostOf({type:'mlx'}),null,'no host field means this engine');
  assert.equal(local.offline({type:'mlx',host:{nodeId:'n1',name:'Studio Mac',online:false,here:false}}),true);
  assert.equal(local.remote({type:'mlx',host:{nodeId:'n1',name:'Studio Mac',online:true,here:true}}),false);
});

test('local model names, capability badges and the no-tools explanation come from the catalog only',t=>{
  const {win,local}=page();t.after(()=>win.close());
  assert.equal(local.shortModelName('mlx-community/Qwen3.8-27B-4bit'),'Qwen3.8 27B');
  assert.equal(local.shortModelName('qwen3.8:27b'),'Qwen3.8 27B');
  assert.equal(local.shortModelName('llama3.2:latest'),'Llama3.2');
  assert.equal(local.shortModelName('anything','Named by catalog'),'Named by catalog');
  assert.deepEqual(plain(local.modelBadges(localModels[0])).map(item=>item.label),['Tools','Thinking','Vision','32K window']);
  assert.deepEqual(plain(local.modelBadges({id:'x',capabilities:['completion','tools','thinking'],contextLength:262144,parameterSize:'27.8B',quantization:'Q4_K_M'})).map(item=>item.label),['Tools','Thinking','256K window','27.8B · Q4_K_M']);
  assert.deepEqual(plain(local.modelBadges({id:'unknown'})),[],'unknown capabilities show nothing');
  assert.match(local.modelNote(localModels[1]),/can only chat/);assert.equal(local.modelNote({id:'unknown'}),'','unknown tool support is not called missing');
  assert.equal(local.failureText('node_offline','DeepSeek V4 Pro'),'The Mac is offline — answered by DeepSeek V4 Pro');
  assert.equal(local.failureText('node_lost'),'The Mac is offline');assert.equal(local.failureText('rate_limit','x'),'');
});

function cardHarness({runtimes,platform='darwin',connections=[],fail=false}={}){
  const h=page('<main id="main"></main>');const requests=[],toasts=[];let refreshed=0;
  const ctx={data:{connections,bots:[]},icon:name=>`<i data-icon="${name}"></i>`,errorText:error=>error.message,toast:(message,error)=>toasts.push({message,error:!!error}),refresh:async()=>{refreshed++;},
    api:async(path,options={})=>{requests.push(plain({path,...options}));
      if(path==='/api/local-runtimes'){if(fail)throw new Error('Engine unavailable.');return {platform,runtimes};}
      if(path==='/api/connections'&&options.method==='POST')return {id:'provider_new',...options.body};
      if(path==='/api/connections/provider_new/test')return {connected:true,models:[]};
      throw new Error(`Unexpected fixture request: ${path}`);}};
  const main=h.doc.querySelector('#main');main.innerHTML=h.local.card(ctx);h.local.mount(ctx,main);
  return {...h,ctx,main,requests,toasts,refreshed:()=>refreshed};
}
const ollamaRunning={type:'ollama',name:'Ollama',baseUrl:'http://127.0.0.1:11434/v1',running:true,version:'0.13.0',installed:true,models:[{id:'nomic-embed-text:latest',embedding:true},{id:'qwen3.8:27b',parameterSize:'27.8B'},{id:'llama3.2:3b'}],startCommand:'ollama serve',alternativeCommands:[],installUrl:'https://ollama.com/download'};
const mlxStopped={type:'mlx',name:'MLX LM',baseUrl:'http://127.0.0.1:8080/v1',running:false,installed:null,models:[],startCommand:'mlx_lm.server --model <model> --port 8080',alternativeCommands:['APC_ENABLED=1 mlx_vlm.server --model <model> --port 8080'],installUrl:'https://github.com/ml-explore/mlx-lm'};

test('the On this Mac card lists running and stopped runtimes, and Use adds the provider in one click',async t=>{
  const h=cardHarness({runtimes:[ollamaRunning,mlxStopped]});t.after(()=>h.win.close());
  assert.match(h.main.querySelector('[data-local-content]').textContent,/Checking this machine/);
  await settle();
  const card=h.main.querySelector('[data-local-models]');assert.equal(card.querySelector('h2').textContent,'On this Mac');
  const ollama=card.querySelector('[data-runtime="ollama"]'),mlx=card.querySelector('[data-runtime="mlx"]');
  assert.match(ollama.textContent,/Running · 2 models/,'embedding models are not counted as chat models');assert.match(ollama.textContent,/Qwen3\.8 27B, Llama3\.2 3B/);
  assert.match(mlx.textContent,/Not running/);
  assert.deepEqual([...mlx.querySelectorAll('code')].map(node=>node.textContent),['mlx_lm.server --model <model> --port 8080','APC_ENABLED=1 mlx_vlm.server --model <model> --port 8080']);
  assert.equal(mlx.querySelector('a').href,'https://github.com/ml-explore/mlx-lm');assert.equal(mlx.querySelector('[data-local-action="use"]'),null,'a stopped runtime cannot be added');
  ollama.querySelector('[data-local-action="use"]').click();await settle();
  const create=h.requests.find(item=>item.path==='/api/connections');
  assert.deepEqual(create.body,{type:'ollama',name:'Mac · Ollama',baseUrl:'http://127.0.0.1:11434/v1',defaultModel:'qwen3.8:27b'});
  assert.ok(h.requests.some(item=>item.path==='/api/connections/provider_new/test'&&item.method==='POST'),'the new provider is checked once');
  assert.equal(h.refreshed(),1);assert.match(h.toasts.at(-1).message,/Mac · Ollama added\. Choose it for a bot under On my Mac/);
  assert.equal(h.requests.some(item=>/serve|pull|start/.test(item.path)),false,'Tupies never starts a runtime');
});

test('the card shows not installed, an existing connection, a failed check and the server explanation',async t=>{
  const missing=cardHarness({runtimes:[{...ollamaRunning,running:false,installed:false,models:[]},mlxStopped],connections:[{...macMlx}]});t.after(()=>missing.win.close());await settle();
  const ollama=missing.main.querySelector('[data-runtime="ollama"]');assert.match(ollama.textContent,/Not installed/);assert.equal(ollama.querySelector('a').href,'https://ollama.com/download');assert.equal(ollama.querySelector('code').textContent,'ollama serve');
  assert.match(missing.main.querySelector('[data-runtime="mlx"]').textContent,/Added as Mac · MLX/);

  const server=cardHarness({platform:'linux',runtimes:[{...ollamaRunning,running:false,installed:null,models:[]},mlxStopped]});t.after(()=>server.win.close());await settle();
  assert.equal(server.main.querySelector('h2').textContent,'On your Mac');assert.match(server.main.textContent,/This engine is a server, not a Mac/);assert.equal(server.main.querySelector('[data-runtime]'),null);

  const paired=cardHarness({platform:'linux',runtimes:[mlxStopped],connections:[{...macMlx,host:{nodeId:'node_mac',name:'Studio Mac',online:false,here:false}}]});t.after(()=>paired.win.close());await settle();
  const row=paired.main.querySelector('[data-connection="provider_mac_mlx"]');assert.match(row.textContent,/Mac offline/);assert.match(row.textContent,/Runs on Studio Mac/);assert.match(row.textContent,/fallback model/);

  const failed=cardHarness({fail:true});t.after(()=>failed.win.close());await settle();
  assert.match(failed.main.textContent,/Engine unavailable\./);
});

function scopePicker({connections,model='',connectionId,form=false,storage=true,memoryKey='bot_atlas',localList=localModels,cloudList=cloudModels}={}){
  const h=page(form?'<form id="form"><div id="host"></div></form>':'<div id="host"></div>',{storage});const loads=[],saves=[];
  h.picker.configure({connections:()=>connections,catalog:()=>CATALOG,icon:()=>'',loadModels:async id=>{loads.push(id);return {models:id===macMlx.id?localList:cloudList};}});
  h.doc.querySelector('#host').innerHTML=h.picker.markup({id:'p',connectionId,model,inline:!form,memoryKey,...(form?{connectionName:'connectionId',modelName:'model',allowNone:true}:{})});
  const root=h.doc.querySelector('[data-model-picker]');
  const controller=h.picker.attach(root,form?{}:{onSelect:async next=>{saves.push(next);return next;}});
  const segment=value=>root.querySelector(`[data-mp-scope="${value}"]`);
  return {...h,root,controller,loads,saves,segment,options:()=>[...root.querySelectorAll('.mp-provider-select option')].map(option=>option.value),note:()=>root.querySelector('.mp-scope-note').textContent.trim()};
}

test('the Cloud | On my Mac toggle is disabled with a setup link when no local model exists',async t=>{
  const h=scopePicker({connections:[openrouter],connectionId:openrouter.id,model:'qwen/qwen3-coder'});t.after(()=>h.win.close());await settle();
  assert.equal(h.segment('cloud').getAttribute('aria-pressed'),'true');assert.equal(h.segment('local').disabled,true);
  assert.match(h.note(),/No model runs on your Mac yet/);assert.equal(h.root.querySelector('.mp-scope-setup').dataset.nav,'/connections');
  assert.equal(h.segment('local').getAttribute('aria-describedby'),'p-scope-note');
});

test('On my Mac lists only local providers with badges; Cloud goes back to the saved provider',async t=>{
  const h=scopePicker({connections:[openrouter,macMlx],connectionId:openrouter.id,model:'qwen/qwen3-coder'});t.after(()=>h.win.close());await settle();
  assert.deepEqual(h.options(),[openrouter.id]);assert.equal(h.note(),'');assert.equal(h.root.querySelector('.mp-scope-badge').hidden,true);
  h.segment('local').click();await settle();
  assert.equal(h.segment('local').getAttribute('aria-pressed'),'true');assert.deepEqual(h.options(),[macMlx.id]);assert.equal(h.saves.length,0,'switching segments only browses in chat');
  const qwen=h.root.querySelector('.mp-option[data-value="mlx-community/Qwen3.8-27B-4bit"]');
  assert.match(qwen.querySelector('strong').textContent,/^Qwen3\.8 27B$/);assert.deepEqual([...qwen.querySelectorAll('.lm-badge')].map(node=>node.textContent),['Tools','Thinking','Vision','32K window']);
  const tiny=h.root.querySelector('.mp-option[data-value="mlx-community/tiny-chat-1b-8bit"]');assert.ok(tiny,'a model without tools stays visible');assert.equal(tiny.getAttribute('aria-disabled'),null);assert.match(tiny.querySelector('.mp-model-note').textContent,/can only chat/);
  qwen.click();await settle();assert.deepEqual(plain(h.saves),[{connectionId:macMlx.id,model:'mlx-community/Qwen3.8-27B-4bit'}]);
  // Back to Cloud: the last cloud choice is remembered for this bot, one more tap saves it.
  h.segment('cloud').click();await settle();
  assert.deepEqual(h.options(),[openrouter.id]);assert.match(h.root.querySelector('.mp-option[data-value="qwen/qwen3-coder"]').textContent,/Last used here/);
  assert.equal(h.root.querySelector('.mp-option .lm-badge'),null,'cloud rows keep their plain look');
});

test('a hosted local provider whose Mac is offline says so in the toggle and the provider list',async t=>{
  const offline={...macMlx,host:{nodeId:'node_mac',name:'Studio Mac',online:false,here:false}};
  const h=scopePicker({connections:[openrouter,offline],connectionId:offline.id,model:'mlx-community/Qwen3.8-27B-4bit',storage:false});t.after(()=>h.win.close());await settle();
  assert.equal(h.segment('local').getAttribute('aria-pressed'),'true');assert.equal(h.root.querySelector('.mp-scope-badge').hidden,false);
  assert.match(h.root.querySelector('.mp-scope-badge').textContent,/Mac offline/);assert.match(h.note(),/^Mac offline\. Tasks on these models use the bot’s fallback model/);
  assert.match(h.root.querySelector('.mp-provider-select option').textContent,/^Mac · MLX · MLX LM — Mac offline$/);
  h.segment('cloud').click();await settle();assert.equal(h.note(),'','blocked storage only loses the convenience');assert.deepEqual(h.options(),[openrouter.id]);
});

test('in Bot settings a segment switch fills the form fields, and a running task locks the toggle',async t=>{
  const h=scopePicker({connections:[openrouter,macMlx],connectionId:openrouter.id,model:'qwen/qwen3-coder',form:true,memoryKey:'bot_form'});t.after(()=>h.win.close());await settle();
  assert.deepEqual(h.options(),['',openrouter.id],'Choose later stays available');
  h.segment('local').click();await settle();
  assert.equal(h.doc.querySelector('.mp-provider-select').value,macMlx.id);assert.equal(h.doc.querySelector('.mp-model-value').value,'');
  h.segment('cloud').click();await settle();
  assert.equal(h.doc.querySelector('.mp-provider-select').value,openrouter.id);assert.equal(h.doc.querySelector('.mp-model-value').value,'qwen/qwen3-coder','switching back restores the saved choice');
  h.controller.setLocked('Switch providers after the current task finishes.');
  assert.equal(h.segment('local').disabled,true);assert.equal(h.segment('cloud').disabled,true);
});

function appHarness({connections,bot,run=null}){
  const h=page('');const context=h.context;vm.runInContext(appSource,context,{filename:'app.js'});
  h.win.fixtureData={settings:{},bots:[bot],connections,integrations:[],channels:[],routines:[],skills:[],activity:[],rooms:[],runs:run?{[bot.id]:run}:{},roomDrives:{}};
  vm.runInContext('data={...initialState,...fixtureData};providerCatalog='+JSON.stringify(CATALOG)+';auth={authenticated:true,csrf:"fixture"};api=async()=>{throw new Error("no network")};toast=()=>{};refresh=async()=>false;renderApp=()=>{};updateChatReview=()=>{};',context);
  return {...h,run:code=>vm.runInContext(code,context)};
}

test('the composer trigger reads “Mac · model” for a local model and keeps cloud names unchanged',t=>{
  const bot={id:'bot_atlas',name:'Atlas',connectionId:macMlx.id,model:'mlx-community/Qwen3.8-27B-4bit',reasoningEffort:'auto',reasoningEffortVersion:1,tools:[],skills:[],enabled:true};
  const h=appHarness({connections:[{...macMlx,models:localModels},openrouter],bot});t.after(()=>h.win.close());
  h.doc.querySelector('#app').innerHTML=h.run("chatInferenceBar(botById('bot_atlas'))");
  assert.equal(h.doc.querySelector('#chat-model-label').textContent,'Mac · Qwen3.8 27B');
  h.run("data.bots[0]={...data.bots[0],connectionId:'provider_openrouter',model:'deepseek/deepseek-v4-pro'};data.connections[1].models="+JSON.stringify(cloudModels));
  h.doc.querySelector('#app').innerHTML=h.run("chatInferenceBar(botById('bot_atlas'))");
  assert.equal(h.doc.querySelector('#chat-model-label').textContent,'DeepSeek V4 Pro');
});

test('chat run status says the Mac is offline, with the fallback that answered',t=>{
  const bot={id:'bot_atlas',name:'Atlas',connectionId:macMlx.id,model:'',tools:[],skills:[],enabled:true};
  const h=appHarness({connections:[macMlx,openrouter],bot});t.after(()=>h.win.close());
  const wait=h.run("runActivity({events:[{type:'model.started',step:1,model:'q'},{type:'model.fallback',reason:'node_offline',to:{model:'deepseek/deepseek-v4-pro'},createdAt:new Date().toISOString()}]}).wait");
  assert.equal(h.run(`runWaitLabel(${JSON.stringify(wait)})`),'The Mac is offline — answered by deepseek/deepseek-v4-pro');
  assert.equal(h.run("runWaitLabel({kind:'fallback',model:'x',reason:'timeout'})"),'switched to fallback model · x','other reasons keep the existing words');
  assert.equal(h.run("localRunNote({status:'completed',fallback:{reason:'node_lost',to:{model:'deepseek/deepseek-v4-pro'}}})"),'The Mac is offline — answered by deepseek/deepseek-v4-pro');
  assert.match(h.run("localRunNote({status:'failed',failure:{code:'node_offline'},error:'Request failed.'})"),/^The Mac is offline\. Start it again, or add a fallback model/);
  assert.equal(h.run("localRunNote({status:'failed',failure:{code:'timeout'}})"),'');
  assert.equal(h.run("localRunNote({status:'completed',fallback:{reason:'rate_limit',to:{model:'x'}}})"),'');
});

test('the page loads the local-models script before the picker, and the styles respect phones and reduced motion',()=>{
  assert.ok(indexHtml.indexOf('/local-models.js')>0&&indexHtml.indexOf('/local-models.js')<indexHtml.indexOf('/model-picker.js'));
  assert.match(indexHtml,/href="\/local-models\.css"/);
  assert.match(pickerCss,/@media\(max-width:760px\)\{\.mp-scope-option\{min-height:44px\}\}/);assert.match(pickerCss,/prefers-reduced-motion:reduce\)\{\.mp-scope-option\{transition:none\}/);
  assert.match(localCss,/@media\(max-width:760px\)/);assert.match(localCss,/\.lm-command code\{[^}]*overflow-x:auto/);
});

test('Ollama cloud models are not counted or offered as local, and say where they run',async t=>{
  const runtime={...ollamaRunning,models:[{id:'gemma4:cloud',cloud:true},{id:'qwen3.8:27b'}]};
  const h=cardHarness({runtimes:[runtime,mlxStopped]});t.after(()=>h.win.close());
  await settle();
  const ollama=h.main.querySelector('[data-local-models] [data-runtime="ollama"]');
  assert.match(ollama.textContent,/Running · 1 model(?!s)/);assert.match(ollama.textContent,/1 cloud model runs on ollama\.com, not on this Mac/);
  assert.doesNotMatch(ollama.querySelector('.lm-models').textContent,/Gemma/i);
  assert.deepEqual([...h.win.StudioLocalModels.modelBadges({id:'gemma4:cloud'})].map(item=>item.label),['Runs on ollama.com']);
});

test('embedding models are hidden from local model lists and never become the Use default; cloud lists are unchanged',async t=>{
  const embedding={id:'sentence-transformers/all-MiniLM-L6-v2'};
  const h=scopePicker({connections:[openrouter,macMlx],connectionId:macMlx.id,model:'mlx-community/Qwen3.8-27B-4bit',localList:[embedding,...localModels],cloudList:[...cloudModels,{id:'openai/text-embedding-3-small'}]});t.after(()=>h.win.close());await settle();
  assert.equal(h.segment('local').getAttribute('aria-pressed'),'true');
  assert.equal(h.root.querySelector(`.mp-option[data-value="${embedding.id}"]`),null,'the embedding model is not offered');
  assert.ok(h.root.querySelector('.mp-option[data-value="mlx-community/Qwen3.8-27B-4bit"]'),'chat models stay');
  assert.ok(h.root.querySelector('.mp-option[data-value="mlx-community/tiny-chat-1b-8bit"]'));
  h.segment('cloud').click();await settle();h.root.querySelector('.mp-provider-select').value=openrouter.id;h.root.querySelector('.mp-provider-select').dispatchEvent(new h.win.Event('change',{bubbles:true}));await settle();
  assert.ok(h.root.querySelector('.mp-option[data-value="openai/text-embedding-3-small"]'),'cloud catalogs are not filtered');
  for(const id of ['sentence-transformers/all-MiniLM-L6-v2','nomic-embed-text:latest','bge-m3','mxbai-embed-large'])assert.equal(h.local.isEmbedding({id}),true,id);
  for(const id of ['qwen3.8:27b','mlx-community/Qwen3.8-27B-4bit','llama3.2:3b'])assert.equal(h.local.isEmbedding({id}),false,id);

  // Use picks the first chat model, even when the runtime lists an embedding model first without the probe's flag.
  const runtime={...ollamaRunning,models:[{id:'all-minilm:latest'},{id:'qwen3.8:27b'}]};
  const card=cardHarness({runtimes:[runtime,mlxStopped]});t.after(()=>card.win.close());await settle();
  assert.match(card.main.querySelector('[data-runtime="ollama"]').textContent,/Running · 1 model(?!s)/);
  card.main.querySelector('[data-local-action="use"]').click();await settle();
  assert.equal(card.requests.find(item=>item.path==='/api/connections').body.defaultModel,'qwen3.8:27b');
});

test('a local step’s live state reads as plain text in the chat strip, by where the model runs',t=>{
  const bot={id:'bot_atlas',name:'Atlas',connectionId:macMlx.id,model:'',tools:[],skills:[],enabled:true};
  const h=appHarness({connections:[macMlx,openrouter],bot});t.after(()=>h.win.close());
  const at=new Date().toISOString();
  const label=event=>h.run(`runWaitLabel(runActivity({events:[{type:'model.started',step:1,model:'q'},${JSON.stringify({type:'model.waiting',createdAt:at,step:1,elapsedMs:0,...event})}]}).wait)`);
  assert.equal(label({state:'queued',host:{here:true,mac:true}}),'Waiting for this Mac…');
  assert.equal(label({state:'queued',host:{here:false,name:'Studio Mac'}}),'Waiting for “Studio Mac”…');
  assert.equal(label({state:'queued',host:{here:false}}),'Waiting for the Mac…');
  assert.equal(label({state:'loading',host:{here:true,mac:true}}),'Loading the model on this Mac…');
  assert.equal(label({state:'loading',host:{here:false,name:'Studio Mac'}}),'Loading the model on “Studio Mac”…');
  assert.equal(label({state:'reading',tokens:24_300,host:{here:true,mac:true}}),'Reading the conversation (about 24K tokens)…');
  assert.equal(label({state:'reading',tokens:640,host:{here:true,mac:true}}),'Reading the conversation (about 640 tokens)…');
  assert.equal(label({state:'reading',host:{here:true,mac:true}}),'Reading the conversation…');
  assert.equal(label({state:'reading',tokens:5000,elapsedMs:45_000,host:{here:true,mac:true}}),'Reading the conversation (about 5K tokens)… · 45 s','a long wait shows its time');
  assert.equal(label({state:'queued',host:{here:true,mac:false}}),'Waiting for the local model…','a server running the runtime itself is not called a Mac');
  assert.equal(label({elapsedMs:45_000}),'waiting for model · 45 s','cloud waits keep their words');
  assert.equal(label({state:'generating',elapsedMs:15_000}),'waiting for model · 15 s','an unknown state is not shown as a local state');
  assert.equal(h.run(`runActivity({events:[{type:'model.started',step:1},${JSON.stringify({type:'model.waiting',createdAt:at,state:'reading',tokens:100})},{type:'model.resumed',step:1}]}).wait`),null,'streamed text clears the notice');
});
