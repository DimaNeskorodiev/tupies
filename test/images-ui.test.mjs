import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// The real app code in a DOM; no engine, account or provider is involved.
function harness({imageVision=false,connection={}}={}) {
  const dom=new JSDOM('<div id="main-content"><div id="composer-attachments"></div></div><div id="dialog-root"></div><div id="toasts"></div>');
  const {window}=dom,requests=[];
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const ctx=vm.createContext({document:window.document,window,location:{hash:'#/bot/bot_qa'},URL,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(source,ctx,{filename:'app.js'});
  ctx.fixtureApi=async(path,options={})=>{requests.push({path,options});return {documents:{imageVision}};};
  ctx.fixtureConnection={id:'provider_qa',type:'ollama',name:'Local models',baseUrl:'http://127.0.0.1:11434/v1',status:'connected',defaultModel:'llava',...connection};
  vm.runInContext("data={...initialState,bots:[{id:'bot_qa',name:'QA Bot',connectionId:'provider_qa',tools:[],skills:[],enabled:true}],connections:[fixtureConnection],rooms:[]};activeBot='bot_qa';api=fixtureApi;",ctx);
  return {window,requests,run:code=>vm.runInContext(code,ctx),$:selector=>window.document.querySelector(selector)};
}

test('attaching an image to a bot whose model cannot see images says so in the composer',async()=>{
  const h=harness();
  h.run("composerAttachments.set('bot_qa',[{name:'notes.pdf',path:'notes.pdf'}])");
  await h.run("checkImageSight('bot_qa')");
  assert.equal(h.$('.attachment-note'),null,'documents alone need no note');
  h.run("composerAttachments.set('bot_qa',[{name:'screen.PNG',path:'uploads/screen.PNG'}])");await h.run("checkImageSight('bot_qa')");await tick();
  assert.equal(h.requests.at(-1).path,'/api/bots/bot_qa/capabilities');
  assert.match(h.$('.attachment-note').textContent,/QA Bot’s model can’t see images\. It gets only the file name\./);
  const seeing=harness({imageVision:true});
  seeing.run("composerAttachments.set('bot_qa',[{name:'screen.png',path:'screen.png'}])");await seeing.run("checkImageSight('bot_qa')");
  assert.equal(seeing.$('.attachment-note'),null);
});

test('Chat options says whether the selected model is shown attached images',()=>{
  const h=harness();
  h.run("globalThis.state={botId:'bot_qa',effectiveModel:'llava',context:{window:32000,source:'provider'},models:[{id:'llava',imageInput:{supported:true,source:'owner'}},{id:'llama3',imageInput:{supported:false,source:'unknown'}},{id:'old'}]}");
  assert.match(h.run("contextNoteText(state,'llava')"),/Attached images are shown to this model\.$/);
  assert.match(h.run("contextNoteText(state,'llama3')"),/This model gets only the names of attached images\.$/);
  assert.doesNotMatch(h.run("contextNoteText(state,'old')"),/image/);
});

test('provider settings offer image input as automatic, on or text only, showing the saved choice',()=>{
  const h=harness({connection:{imageInput:'off'}});
  h.run("connectionDialog('provider_qa')");
  const select=h.$('select[name="imageInput"]');
  assert.deepEqual([...select.options].map(option=>[option.value,option.textContent]),[['auto','Automatic'],['on','Models here can see images'],['off','Text only']]);
  assert.equal(select.value,'off');
  const fresh=harness();fresh.run("connectionDialog('provider_qa')");assert.equal(fresh.$('select[name="imageInput"]').value,'auto');
});
