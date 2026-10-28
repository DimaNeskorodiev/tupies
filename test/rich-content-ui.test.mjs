import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
function harness(){
  const dom=new JSDOM('<!doctype html><div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'http://studio.local/#/bot/bot_test',runScripts:'outside-only'}),window=dom.window;
  window.setInterval=()=>1;window.clearInterval=()=>{};window.setTimeout=()=>1;window.requests=[];
  vm.runInContext(source,dom.getInternalVMContext());
  vm.runInContext(`data={...initialState,bots:[{id:'bot_test',name:'Atlas',color:'sage',connectionId:'provider_test',skills:[],enabled:true}],connections:[{id:'provider_test',type:'openai',name:'Provider',status:'connected',defaultModel:'model'}]};auth={authenticated:true,csrf:'token'};activeBot='bot_test';chat={messages:[],run:null};document.querySelector('#app').innerHTML=renderChat('bot_test');api=async(path,options={})=>{requests.push({path,...options});if(path.endsWith('/attachments'))return {files:[{path:'uploads/brief.pdf',name:'brief.pdf',format:'pdf',size:100}]};if(path.endsWith('/messages')&&options.method!=='POST')return {messages:[],run:null};return {};};`,dom.getInternalVMContext());
  return {dom,window,run:code=>vm.runInContext(code,dom.getInternalVMContext()),close:()=>dom.window.close()};
}
test('composer exposes real multi-file attachment selection without opening the file manager',()=>{
  const h=harness(),doc=h.window.document;
  assert.ok(doc.querySelector('[data-action="attach-files"]'));assert.equal(doc.querySelector('#chat-attachments').multiple,true);assert.match(doc.querySelector('#chat-attachments').accept,/\.pdf/);assert.equal(doc.querySelector('#message-input').required,false);h.close();
});
test('uploading an attachment stages a removable chip and only Send includes it in model input',async()=>{
  const h=harness();h.window.uploadFixture=new h.window.File(['brief'],'brief.pdf',{type:'application/pdf'});
  await h.run("uploadFiles('bot_test',[uploadFixture],{attach:true})");
  assert.equal(h.window.requests.length,1);assert.match(h.window.requests[0].path,/attachments$/);assert.equal(h.window.document.querySelector('.attachment-chip').textContent.trim(),'brief.pdf');assert.equal(h.window.document.querySelector('#message-input').value,'');
  h.run("document.querySelector('#message-input').value='Read this file';document.querySelector('#message-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
  await new Promise(resolve=>setTimeout(resolve,0));
  const sent=h.window.requests.find(request=>request.method==='POST'&&request.path.endsWith('/messages'));
  assert.equal(sent.body.text,'Read this file');assert.equal(JSON.stringify(sent.body.attachments),JSON.stringify([{path:'uploads/brief.pdf',name:'brief.pdf'}]));assert.equal(h.window.document.querySelectorAll('.attachment-chip').length,0);h.close();
});
test('attachment-only sends are supported and removed files never enter a message',async()=>{
  const h=harness();h.run("composerAttachments.set('bot_test',[{path:'uploads/a.pdf',name:'a.pdf'},{path:'uploads/b.pdf',name:'b.pdf'}]);refreshComposerAttachments('bot_test');document.querySelector('[data-action=remove-attachment]').click()");
  h.run("document.querySelector('#message-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");await new Promise(resolve=>setTimeout(resolve,0));
  const sent=h.window.requests.find(r=>r.method==='POST'&&r.path.endsWith('/messages'));assert.equal(sent.body.text,'');assert.equal(sent.body.attachments.length,1);assert.equal(sent.body.attachments[0].path,'uploads/b.pdf');h.close();
});
test('attachment limits fail before upload and preserve the draft',async()=>{
  const h=harness();h.window.tooMany=Array.from({length:6},(_,i)=>new h.window.File(['a'],i+'.txt'));
  await assert.rejects(h.run("uploadFiles('bot_test',tooMany,{attach:true})"),/up to 5 files/);assert.equal(h.window.requests.length,0);
  h.window.tooLarge=[{name:'large.pdf',size:20000001}];await assert.rejects(h.run("uploadFiles('bot_test',tooLarge,{attach:true})"),/20 MB/);assert.equal(h.window.requests.length,0);h.close();
});
test('polling preserves rich message DOM, copied state and mounted visuals when run status changes',()=>{
  const h=harness();let hydrations=0;h.window.StudioRich={render:text=>'<p>'+text+'</p>',hydrate:async()=>{hydrations++;},dispose(){}};
  h.run("chat={messages:[{id:'message_1',role:'assistant',content:'Stable answer'}],run:null};renderThread(botById('bot_test'))");const message=h.window.document.querySelector('[data-message-key]');message.querySelector('p').dataset.userState='copied';
  h.run("chat.run={id:'run_1',status:'running',events:[]};renderThread(botById('bot_test'))");assert.equal(h.window.document.querySelector('[data-message-key]'),message);assert.equal(message.querySelector('p').dataset.userState,'copied');assert.equal(hydrations,2);
  h.run("renderThread(botById('bot_test'))");assert.equal(hydrations,2);h.close();
});

test('only active bot output passes streaming mode to the rich renderer',()=>{
  const h=harness(),calls=[];h.window.StudioRich={render:(text,options)=>{calls.push({text,...options});return '<p>'+text+'</p>';},hydrate:async()=>{},dispose(){}};
  h.run("chat={messages:[{role:'assistant',content:'Final transcript'}],run:{id:'run_1',status:'running',partialOutput:'Live partial',events:[]}};renderThread(botById('bot_test'))");
  assert.equal(calls.find(c=>c.text==='Final transcript').streaming,false);assert.equal(calls.find(c=>c.text==='Live partial').streaming,true);
  calls.length=0;h.run("chat.run.status='cancelled';renderThread(botById('bot_test'))");assert.equal(calls.find(c=>c.text==='Live partial').streaming,false);h.close();
});
