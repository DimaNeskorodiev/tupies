import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source=await readFile(new URL('../public/browser-control.js',import.meta.url),'utf8');
const imageBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1L8AAAAASUVORK5CYII=';
const identity={runId:'run_browser',remoteRunId:'remote_browser',request_id:'handoff_browser',execution_generation:4};
const view=(id='view_1')=>({imageBase64,width:1280,height:900,url:'https://example.test/sign-in',title:'Sign in',tabId:'tab_1',tabs:[{id:'tab_1',title:'Sign in',url:'https://example.test/sign-in'}],viewId:id,retained:false});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{api}={}) {
  const dom=new JSDOM('<div id="dialog-root"></div>',{url:'https://tupies.test',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom,requests=[],messages=[];let closed=0,valid=true;
  window.eval(source);
  const context={
    api:async(path,options)=>{requests.push({path,options});return api?api(path,options):view(`view_${requests.length}`);},
    openDialog(title,html){window.StudioBrowser.reset();window.document.querySelector('#dialog-root').innerHTML=`<dialog open>${html}</dialog>`;},
    closeDialog(){closed++;window.StudioBrowser.reset();window.document.querySelector('#dialog-root').replaceChildren();},
    async loadChat(id){messages.push(['load',id]);},toast(message){messages.push(['toast',message]);},valid:()=>valid,
  };
  const $=selector=>window.document.querySelector(selector);
  const open=async()=>{window.StudioBrowser.open(context,'bot_browser',identity);await tick();};
  const loaded=()=>{const image=$('.browser-control-image');image.dispatchEvent(new window.Event('load'));return image;};
  const click=async selector=>{$(selector).click();await tick();};
  t.after(()=>{window.StudioBrowser.reset();window.close();});
  return {window,requests,messages,$,open,loaded,click,context,get closed(){return closed;},invalidate(){valid=false;}};
}

test('browser handoff card escapes website-supplied reason and carries exact run identity',t=>{
  const h=fixture(t),run={id:identity.runId,remoteRunId:identity.remoteRunId,status:'waiting_for_input',execution_generation:4,pending_controls:[{kind:'browser',prompt_id:identity.request_id,reason:'Sign in <img src=x onerror=alert(1)>'}]};
  h.window.document.querySelector('#dialog-root').innerHTML=h.window.StudioBrowser.renderCard({id:'bot_browser',name:'QA <bot>'},run);
  assert.equal(h.$('img'),null);assert.match(h.$('.browser-handoff-card').textContent,/QA <bot>/);
  assert.deepEqual(JSON.parse(h.$('[data-action=browser-handoff]').dataset.browserIdentity),identity);
  assert.deepEqual(JSON.parse(h.$('[data-action=stop-run]').dataset.run),{runId:identity.runId,remoteRunId:identity.remoteRunId});
});

test('private typing goes only to the current browser action and is cleared before dispatch',async t=>{
  let resolveAction;
  const h=fixture(t,{api:async(path)=>path.endsWith('/action')?new Promise(resolve=>{resolveAction=resolve;}):view()});
  await h.open();h.loaded();
  assert.equal(h.$('[data-browser-text]').type,'password');
  h.$('[data-browser-text]').value='private-fixture-password';
  await h.click('[data-browser-action=text]');
  assert.equal(h.$('[data-browser-text]').value,'');
  assert.equal(h.requests.length,2);
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].options.body)),{...identity,viewId:'view_1',action:{type:'text',text:'private-fixture-password'}});
  assert.equal(h.requests[1].path,'/api/bots/bot_browser/browser/action');
  assert.equal(h.$('[data-browser-action=refresh]').disabled,true,'view refresh cannot overlap an input');
  assert.equal(h.$('[data-browser-resume=resume]').disabled,true,'resume cannot race an input');
  assert.equal(h.window.localStorage.length,0);assert.equal(h.window.sessionStorage.length,0);
  assert.ok(!h.window.document.body.textContent.includes('private-fixture-password'));
  resolveAction(view('view_after_input'));await tick();h.loaded();
  await h.click('[data-browser-action=key][data-key=Enter]');
  assert.equal(h.requests[2].options.body.viewId,'view_after_input');
  assert.equal(h.requests[2].options.body.action.key,'Enter');
  resolveAction(view('view_after_submit'));await tick();
});

test('uncertain input is never retried and requires a fresh view before another action',async t=>{
  const h=fixture(t,{api:async(path)=>{if(path.endsWith('/action'))throw new Error('Synthetic network loss');return view('fresh');}});
  await h.open();h.loaded();
  await h.click('[data-browser-action=key][data-key=Enter]');
  assert.match(h.$('[data-browser-status]').textContent,/could not be confirmed/);
  assert.equal(h.$('[data-browser-action=key]').disabled,true);
  assert.equal(h.requests.filter(item=>item.path.endsWith('/action')).length,1);
  assert.equal(h.$('[data-browser-action=refresh]').disabled,false);
  await h.click('[data-browser-action=refresh]');h.loaded();
  assert.equal(h.$('[data-browser-action=key]').disabled,false);
});

test('input sent with an unavailable view requires inspection and never resends input',async t=>{
  const h=fixture(t,{api:async(path)=>path.endsWith('/action')?{inputSent:true,viewUnavailable:true}:view('fresh')});
  await h.open();h.loaded();await h.click('[data-browser-action=key][data-key=Enter]');
  assert.match(h.$('[data-browser-status]').textContent,/Input sent.*Refresh to inspect the result/);
  assert.equal(h.$('[data-browser-status]').classList.contains('has-error'),false);
  assert.equal(h.$('[data-browser-action=key]').disabled,true);assert.equal(h.$('[data-browser-action=refresh]').disabled,false);
  await h.click('[data-browser-action=refresh]');h.loaded();
  assert.equal(h.$('[data-browser-action=key]').disabled,false);assert.equal(h.requests.filter(item=>item.path.endsWith('/action')).length,1);
});

test('a stale view is distinguished from an uncertain input without exposing API details',async t=>{
  const h=fixture(t,{api:async(path)=>{if(path.endsWith('/action'))throw Object.assign(new Error('Private URL and form input'),{status:409});return view();}});
  await h.open();h.loaded();await h.click('[data-browser-action=key][data-key=Enter]');
  assert.match(h.$('[data-browser-status]').textContent,/browser view changed/);
  assert.ok(!h.$('[data-browser-status]').textContent.includes('Private URL'));
  assert.equal(h.requests.filter(item=>item.path.endsWith('/action')).length,1);
});

test('scaled pointer clicks and drags use screenshot pixel coordinates',async t=>{
  const h=fixture(t);await h.open();const image=h.loaded();
  image.getBoundingClientRect=()=>({left:10,top:20,width:640,height:450});
  const pointer=(type,x,y)=>{const event=new h.window.MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:1});image.dispatchEvent(event);};
  pointer('pointerdown',330,245);pointer('pointerup',330,245);await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].options.body.action)),{type:'click',x:640,y:450});
  h.loaded();pointer('pointerdown',110,120);pointer('pointerup',210,170);await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[2].options.body.action)),{type:'drag',x:200,y:200,toX:400,toY:300});
});

test('retaining a sign-in is opt-in, with exact identity, and resume discards typed text',async t=>{
  const h=fixture(t);await h.open();h.loaded();
  assert.equal(h.$('[data-browser-retain]').checked,false);
  h.$('[data-browser-retain]').checked=true;h.$('[data-browser-text]').value='unsent private text';
  await h.click('[data-browser-resume=resume]');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].options.body)),{...identity,keepSession:true});
  assert.equal(h.requests[1].path,'/api/bots/bot_browser/browser/resume');
  assert.equal(h.closed,1);assert.equal(h.$('.browser-control-panel'),null);
  assert.deepEqual(h.messages[0],['load','bot_browser']);
});

test('closed or expired dialogs abort pending reads and cannot display a late screenshot',async t=>{
  let resolveView;
  const h=fixture(t,{api:async()=>new Promise(resolve=>{resolveView=resolve;})});
  await h.open();const signal=h.requests[0].options.signal;
  h.context.closeDialog();assert.equal(signal.aborted,true);
  resolveView(view());await tick();assert.equal(h.$('img'),null);
  await h.open();h.invalidate();resolveView(view());await tick();
  assert.equal(h.$('img').hasAttribute('src'),false);
});

test('stopping the exact waiting run closes owner control, and page titles stay text',async t=>{
  const h=fixture(t,{api:async()=>({...view(),tabs:[{id:'tab_1',title:'<img src=x onerror=alert(1)>',url:'https://example.test/'}]})});
  await h.open();h.loaded();
  assert.equal(h.window.document.querySelectorAll('img').length,1);
  assert.equal(h.$('[data-browser-tabs] option').textContent,'<img src=x onerror=alert(1)>');
  h.window.StudioBrowser.observeRun('bot_browser',{id:identity.runId,status:'cancelled',pending_controls:[]});
  assert.equal(h.closed,1);assert.equal(h.$('img'),null);
});

test('a website dialog renders as text and sends its private prompt only with the exact view',async t=>{
  const h=fixture(t,{api:async()=>({...view(),dialog:{type:'prompt',message:'Enter <strong>verification</strong>'}})});
  await h.open();h.loaded();
  assert.equal(h.$('[data-browser-site-dialog]').hidden,false);
  assert.equal(h.$('[data-browser-site-message]').textContent,'Enter <strong>verification</strong>');
  assert.equal(h.$('[data-browser-site-message] strong'),null);
  assert.equal(h.$('[data-browser-action=text]').disabled,true);
  h.$('[data-browser-site-prompt]').value='fixture-code';
  await h.click('[data-browser-action=dialog][data-accept=true]');
  assert.equal(h.$('[data-browser-site-prompt]').value,'');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].options.body)),{...identity,viewId:'view_1',action:{type:'dialog',accept:true,promptText:'fixture-code'}});
});
