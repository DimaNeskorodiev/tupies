import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const decode=value=>String(value||'').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const attribute=(tag,name)=>decode(tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1]);

// Execute the browser's real dialog and event code with deterministic API fixtures.
// These small DOM doubles only model form state; no account or network is used.
function harness({connection={},models=[{id:'model-latest',name:'Latest model'},{id:'model-fast',name:'Fast model'}],request}={}) {
  const listeners=new Map(),dialogs=[],requests=[],toasts=[];
  const dom={dialog:null,form:null};
  class Form {
    constructor(html){
      const tag=html.match(/<form\b[^>]*>/)?.[0]||'';
      this.id=attribute(tag,'id');this.dataset={id:attribute(tag,'data-id')};this.isConnected=true;
      this.submit={disabled:false,isConnected:true};this.error={textContent:''};
      this.radios=[...html.matchAll(/<input\b[^>]*type="radio"[^>]*>/g)].map(([tag])=>({id:attribute(tag,'id'),name:attribute(tag,'name'),value:attribute(tag,'value'),checked:/\schecked(?:\s|>)/.test(tag),closest:selector=>selector==='form'||selector===`#${this.id}`?this:null}));
      this.checkboxes=[...html.matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)].map(([tag])=>({name:attribute(tag,'name'),value:attribute(tag,'value')||'on',checked:/\schecked(?:\s|>)/.test(tag)}));
      this.fields=[...html.matchAll(/<input\b[^>]*>/g)].filter(([tag])=>!tag.includes('type="radio"')&&!tag.includes('type="checkbox"')).map(([tag])=>[attribute(tag,'name'),attribute(tag,'value')]).filter(([name])=>name);
    }
    querySelector(selector){
      if(selector==='button[type=submit]')return this.submit;
      if(selector==='.form-error')return this.error;
      if(selector.includes(':checked'))return this.radios.find(r=>r.checked)||null;
      return null;
    }
    querySelectorAll(selector){if(selector.includes('input'))return this.radios;return [];}
    select(value){for(const r of this.radios)r.checked=r.value===value;return this.radios.find(r=>r.checked);}
  }
  class Data {
    constructor(form){this.entries=[...form.fields,...[...form.radios,...form.checkboxes].filter(r=>r.checked).map(r=>[r.name,r.value])];}
    [Symbol.iterator](){return this.entries[Symbol.iterator]();}
    getAll(name){return this.entries.filter(([key])=>key===name).map(([,value])=>value);}
    has(name){return this.entries.some(([key])=>key===name);}
  }
  const document={
    hidden:false,activeElement:null,
    addEventListener(name,fn){listeners.set(name,fn);},
    querySelector(selector){
      if(selector==='dialog')return dom.dialog;
      if(selector==='#default-model-form')return dom.form?.id==='default-model-form'?dom.form:null;
      if(selector==='#default-model-form button[type=submit]')return dom.form?.id==='default-model-form'?dom.form.submit:null;
      if(selector.startsWith('#')&&selector.includes(':checked'))return dom.form?.querySelector(selector)||null;
      return null;
    },
    querySelectorAll(){return [];}
  };
  const ctx=vm.createContext({document,window:{addEventListener(){}},location:{hash:'#/connections'},HTMLFormElement:Form,FormData:Data,URL,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},console});
  vm.runInContext(source,ctx,{filename:'app.js'});
  const provider={id:'provider_chatgpt',type:'chatgpt',name:'My ChatGPT',status:'connected',hasOAuth:true,defaultModel:'',...connection};
  ctx.fixtureData={settings:{},bots:[],connections:[provider],integrations:[],channels:[],routines:[],skills:[],activity:[],rooms:[],runs:{},roomDrives:{}};
  ctx.fixtureApi=async(path,options={})=>{requests.push({path,...options});if(request)return request(path,options);if(path.endsWith('/models'))return {models};if(path.endsWith('/default-model'))return {model:options.body.model,appliedBotIds:[],defaultConnectionId:provider.id};throw new Error(`Unexpected request: ${path}`);};
  ctx.fixtureOpen=(title,html,options)=>{
    if(dom.form){dom.form.isConnected=false;dom.form.submit.isConnected=false;}
    dom.dialog={title,html,options};dom.form=html.includes('<form')?new Form(html):null;dialogs.push(dom.dialog);
  };
  ctx.fixtureClose=()=>{if(dom.form){dom.form.isConnected=false;dom.form.submit.isConnected=false;}dom.dialog=null;dom.form=null;};
  ctx.fixtureToast=(message,error)=>toasts.push({message,error});ctx.refreshCount=0;
  vm.runInContext('data={...initialState,...fixtureData};auth={authenticated:true,csrf:"fixture"};api=fixtureApi;openDialog=fixtureOpen;closeDialog=fixtureClose;toast=fixtureToast;refresh=async()=>{refreshCount++};renderApp=()=>{};',ctx);
  return {ctx,dom,dialogs,requests,toasts,provider,run:code=>vm.runInContext(code,ctx),change:target=>listeners.get('change')({target}),click:(action,id)=>{const el={dataset:{action,id},isConnected:true,closest(){return this;}};return listeners.get('click')({target:el});},submit:()=>listeners.get('submit')({target:dom.form,preventDefault(){}})};
}
const settled=()=>new Promise(resolve=>setImmediate(resolve));

test('OAuth completion immediately displays live account models in provider order without choosing one',async()=>{
  const h=harness({models:[{id:'z-current',name:'Current <model>'},{id:'a-fast',name:'Fast & small'}]});
  h.run('renderProviderLogin("provider_chatgpt",{status:"completed"},{chooseModel:true})');await settled();
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].path,'/api/connections/provider_chatgpt/models');
  assert.equal(h.dom.dialog.title,'Choose your default model');
  assert.deepEqual(h.dom.form.radios.map(r=>r.value),['z-current','a-fast']);
  assert.match(h.dom.dialog.html,/Current &lt;model&gt;/);assert.match(h.dom.dialog.html,/Fast &amp; small/);
  assert.equal(h.dom.form.radios.some(r=>r.checked),false);assert.equal(h.dom.form.submit.disabled,true);
  assert.equal(h.dom.form.checkboxes.find(c=>c.name==='applyToAllBots')?.checked,true);
  assert.equal(h.requests.some(r=>r.path.endsWith('/default-model')),false);
});

test('current default is selected only when still present in the fresh catalog',async()=>{
  const known=harness({connection:{defaultModel:'model-fast'}});await known.run('defaultModelDialog("provider_chatgpt")');
  assert.deepEqual(known.dom.form.radios.filter(r=>r.checked).map(r=>r.value),['model-fast']);assert.equal(known.dom.form.submit.disabled,false);
  const removed=harness({connection:{defaultModel:'removed-model'}});await removed.run('defaultModelDialog("provider_chatgpt")');
  assert.equal(removed.dom.form.radios.some(r=>r.checked),false);assert.equal(removed.dom.form.submit.disabled,true);
});

test('selecting a radio enables save and posts its actual model id as the workspace default',async()=>{
  const h=harness();await h.run('defaultModelDialog("provider_chatgpt")');
  const selected=h.dom.form.select('model-fast');await h.change(selected);
  assert.equal(h.dom.form.submit.disabled,false);
  await h.submit();
  const save=h.requests.find(r=>r.path.endsWith('/default-model'));
  assert.ok(save);assert.equal(save.method,'POST');assert.deepEqual({...save.body},{model:'model-fast',applyToAllBots:true});
  assert.equal(h.ctx.refreshCount,1);assert.equal(h.dom.dialog,null);assert.equal(h.toasts.some(t=>t.error),false);
  assert.equal(h.requests.filter(r=>r.method==='PATCH').length,0);
});

test('unchecking apply to all preserves individual bot choices through an explicit false flag',async()=>{
  const h=harness();await h.run('defaultModelDialog("provider_chatgpt")');
  await h.change(h.dom.form.select('model-fast'));
  h.dom.form.checkboxes.find(c=>c.name==='applyToAllBots').checked=false;
  await h.submit();
  const save=h.requests.find(r=>r.path.endsWith('/default-model'));
  assert.deepEqual({...save.body},{model:'model-fast',applyToAllBots:false});
});

test('failed default save keeps the selected choice and displays a recoverable form error',async()=>{
  const h=harness({request:async path=>{if(path.endsWith('/models'))return {models:[{id:'model-fast',name:'Fast model'}]};throw new Error('Wait for active tasks to finish.');}});
  await h.run('defaultModelDialog("provider_chatgpt")');await h.change(h.dom.form.select('model-fast'));
  const form=h.dom.form;await h.submit();
  assert.equal(h.dom.form,form);assert.equal(form.radios[0].checked,true);assert.equal(form.submit.disabled,false);
  assert.match(form.error.textContent,/active tasks/);assert.equal(h.ctx.refreshCount,0);
});

test('empty or unavailable model catalogs offer retry without changing the connected account',async()=>{
  for(const request of [async()=>({models:[]}),async()=>{throw new Error('Model catalog is temporarily unavailable.');}]){
    const h=harness({request});await h.run('defaultModelDialog("provider_chatgpt")');
    assert.equal(h.dom.form,null);assert.match(h.dom.dialog.html,/data-action="choose-default-model"/);
    assert.match(h.dom.dialog.html,/account is still connected/);assert.equal(h.provider.status,'connected');
    assert.equal(h.requests.length,1);assert.equal(h.requests.some(r=>r.method==='POST'),false);
  }
});

test('new bot dialog inherits the workspace provider and leaves its model override empty',()=>{
  const h=harness({connection:{defaultModel:'model-fast'}});h.run('data.settings={defaultConnectionId:"provider_chatgpt",defaultModel:"model-fast"};botDialog()');
  assert.match(h.dom.dialog.html,/<option value="provider_chatgpt"\s+selected>/);
  assert.match(h.dom.dialog.html,/<input id="bot-model" name="model" value=""/);
});


test('already connected accounts without a default recover the picker once per page session',async()=>{
  const h=harness();await h.run('offerDefaultModel()');
  assert.equal(h.dom.form.id,'default-model-form');assert.equal(h.requests.length,1);
  h.run('closeDialog()');await h.run('offerDefaultModel()');
  assert.equal(h.dom.dialog,null);assert.equal(h.requests.length,1);
  const configured=harness({connection:{defaultModel:'model-fast'}});await configured.run('offerDefaultModel()');
  assert.equal(configured.requests.length,0);
});

test('retry action reloads a failed catalog and opens model choices',async()=>{
  let attempts=0;const h=harness({request:async()=>{if(++attempts===1)throw new Error('Temporary failure');return {models:[{id:'available-now',name:'Available now'}]};}});
  await h.run('defaultModelDialog("provider_chatgpt")');assert.equal(h.dom.form,null);
  await h.click('choose-default-model','provider_chatgpt');
  assert.deepEqual(h.dom.form.radios.map(r=>r.value),['available-now']);assert.equal(attempts,2);
});

test('a late model response cannot reopen a picker the user closed',async()=>{
  let complete;const h=harness({request:()=>new Promise(resolve=>{complete=resolve;})});
  const pending=h.run('defaultModelDialog("provider_chatgpt")');h.run('closeDialog()');
  complete({models:[{id:'late-model',name:'Late model'}]});await pending;
  assert.equal(h.dom.dialog,null);assert.equal(h.dom.form,null);
});
