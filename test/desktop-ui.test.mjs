import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source=readFileSync(new URL('../public/desktop.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
async function fixture(t,{api}={}) {
  const dom=new JSDOM('<main id="root"></main>',{runScripts:'outside-only',url:'http://localhost/desktop'});t.after(()=>dom.window.close());const {window}=dom,root=window.document.getElementById('root'),calls=[],toasts=[];
  const snapshot={available:true,enabled:false,configured:false,executable:'/tmp/driver',requiredVersion:'1.1.0',apps:[{id:'fixture',name:'Fixture',botIds:['atlas']}],driver:null};
  const ctx={data:{bots:[{id:'atlas',name:'Atlas'},{id:'nova',name:'Nova'}]},esc,route:()=>({view:'desktop'}),errorText:err=>err.message,toast:text=>toasts.push(text),api:async(path,options={})=>{calls.push({path,options});return (await api?.(path,options))??snapshot;}};
  window.eval(source);const render=()=>{root.innerHTML=window.TupiesDesktop.render(ctx);window.TupiesDesktop.mount(ctx,root);};render();await tick();
  const input=(selector,value)=>{const el=root.querySelector(selector);if(typeof value==='boolean')el.checked=value;else el.value=value;el.dispatchEvent(new window.Event('input',{bubbles:true}));};
  const submit=()=>root.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));const click=selector=>root.querySelector(selector).click();
  return {window,root,calls,toasts,render,input,submit,click,snapshot};
}
test('desktop settings preserve edited app assignments through ordinary page refresh',async t=>{
  const f=await fixture(t);f.input('[name=appName]','My editor');f.input('[name=enabled]',true);f.input('[value=nova]',true);f.render();assert.equal(f.root.querySelector('[name=appName]').value,'My editor');assert.equal(f.root.querySelector('[value=nova]').checked,true);f.submit();await tick();const saved=f.calls.find(c=>c.options.method==='PUT').options.body;assert.equal(saved.enabled,true);assert.equal(saved.apps[0].name,'My editor');assert.deepEqual([...saved.apps[0].botIds],['atlas','nova']);
});
test('desktop pending saves stay locked across rerender and cannot be duplicated',async t=>{
  let resolve;const pending=new Promise(done=>resolve=done),f=await fixture(t,{api:async(_path,options)=>options.method==='PUT'?pending:undefined});f.submit();f.render();assert.equal(f.root.querySelector('fieldset').disabled,true);f.submit();assert.equal(f.calls.filter(c=>c.options.method==='PUT').length,1);resolve(f.snapshot);await tick();assert.equal(f.root.querySelector('fieldset').disabled,false);assert.equal(f.toasts.length,1);
});
test('desktop save failure retains the exact draft, and check permissions does not overwrite it',async t=>{
  const f=await fixture(t,{api:async(path,options)=>{if(options.method==='PUT')throw new Error('Synthetic rejected setup');if(path.endsWith('/check'))return {driver:{permissions:{accessibility:{state:'denied'}}}};}});f.input('[name=appName]','Keep this draft');f.click('[data-desktop-action=check]');await tick();assert.equal(f.root.querySelector('[name=appName]').value,'Keep this draft');f.submit();await tick();assert.equal(f.root.querySelector('[name=appName]').value,'Keep this draft');assert.match(f.root.querySelector('.form-error').textContent,/rejected/);assert.equal(f.toasts.length,0);
});
test('desktop setup content is escaped and a late save cannot restore it after signout',async t=>{
  let resolve;const pending=new Promise(done=>resolve=done),malicious='<img src=x onerror=alert(1)>',f=await fixture(t,{api:async(path,options)=>options.method==='PUT'?pending:undefined});f.input('[name=appName]',malicious);f.render();assert.equal(f.root.querySelectorAll('img,script').length,0);f.submit();f.window.TupiesDesktop.reset();f.root.innerHTML='Signed out';resolve({...f.snapshot,apps:[{name:malicious,botIds:['atlas']}]});await tick();assert.equal(f.root.textContent,'Signed out');assert.equal(f.toasts.length,0);
});
test('unavailable engines have no desktop setup forms',async t=>{
  const f=await fixture(t,{api:async()=>({available:false,enabled:false,apps:[]})});assert.equal(f.root.querySelector('form'),null);assert.match(f.root.textContent,/local Mac/);
});
