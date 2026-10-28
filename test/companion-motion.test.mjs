import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const source=await readFile(new URL('../public/creature-avatars.js',import.meta.url),'utf8');
const preview=await readFile(new URL('../public/companions-preview.js',import.meta.url),'utf8');
const catalog=JSON.parse(await readFile(new URL('../assets/companions/catalog.json',import.meta.url),'utf8'));
const settle=()=>new Promise(resolve=>setImmediate(resolve));

function ui(t,{entries=catalog,observe=false,previewControls=false}={}){
  const dom=new JSDOM(`<!doctype html><div id="avatars"></div>${previewControls?'<select id="state"></select><input type="checkbox" id="paused"><p id="motion-status"></p><div id="companions"></div><div id="roster"></div>':''}`,{runScripts:'outside-only',pretendToBeVisual:true,url:'http://studio.local/companions-preview.html'});
  const win=dom.window,instances=[];let hidden=false,timers=0;
  Object.defineProperty(win.document,'hidden',{get:()=>hidden,configurable:true});
  win.setInterval=()=>{timers++;throw new Error('Avatar animation must not create a per-avatar timer.');};
  win.setTimeout=()=>{timers++;throw new Error('Avatar animation must not create a per-avatar timer.');};
  win.matchMedia=()=>({matches:false,addEventListener(){}});
  if(observe)win.IntersectionObserver=class{
    constructor(callback){this.callback=callback;this.targets=new Set();this.removed=[];this.disconnections=0;instances.push(this);}
    observe(node){this.targets.add(node);}
    unobserve(node){this.targets.delete(node);this.removed.push(node);}
    disconnect(){this.disconnections++;this.targets.clear();}
    show(node,visible){this.callback([{target:node,isIntersecting:visible}]);}
  };
  if(entries!==null)win.StudioCompanionCatalog=entries;
  const context=dom.getInternalVMContext();vm.runInContext(source,context,{filename:'creature-avatars.js'});
  const mount=(bot,size='tiny',options={})=>{const container=win.document.createElement('div');container.innerHTML=win.StudioAvatars.markup(bot,size,options);const node=container.firstElementChild;win.document.querySelector('#avatars').append(node);return node;};
  t.after(()=>{win.dispatchEvent(new win.Event('pagehide'));win.close();});
  return {win,doc:win.document,api:win.StudioAvatars,instances,mount,timers:()=>timers,hidden(value){hidden=value;win.document.dispatchEvent(new win.Event('visibilitychange'));},runPreview(){vm.runInContext(preview,context,{filename:'companions-preview.js'});}};
}

test('all explicit companion identities have bounded registered frames, while implicit identities stay in the original family',t=>{
  const h=ui(t),legacy=new Set(['blue','coral','jade','honey']);
  assert.equal(h.api.shapes.length,24);
  assert.deepEqual([...h.api.shapes].map(shape=>shape.id),catalog.map(item=>`companion:${item.id}`));
  assert.deepEqual([...h.api.shapes].map(shape=>shape.label),catalog.map(item=>item.label));
  for(const entry of catalog){
    const bot={id:'bot_saved_identity',icon:`companion:${entry.id}`,color:'rose'},before=JSON.stringify(bot);
    for(const presentation of ['portrait','mascot']){
      const node=h.mount(bot,'tiny',{presentation});
      assert.equal(node.dataset.creature,entry.id);assert.equal(node.dataset.companionMotion,entry.motion);
      assert.equal(node.querySelectorAll('img').length,entry.frames?4:1);
      const frames=[...node.querySelectorAll('img')];
      assert.deepEqual(frames.map(image=>image.classList[2]),entry.frames?['companion-frame-idle','companion-frame-blink','companion-frame-look','companion-frame-wave']:['companion-frame-idle']);
      for(const image of frames){
        assert.match(image.getAttribute('src'),new RegExp(`^/assets/companions/companion-${entry.id}-${presentation}(?:-(?:blink|look|wave))?-64\\.webp$`));
        assert.match(image.getAttribute('srcset'),new RegExp(`^/assets/companions/companion-${entry.id}-${presentation}(?:-(?:blink|look|wave))?-128\\.webp 2x$`));
        assert.equal(image.getAttribute('alt'),'');assert.equal(image.width,64);assert.equal(image.height,64);
      }
    }
    assert.equal(JSON.stringify(bot),before);
  }
  for(let index=0;index<64;index++)assert.ok(legacy.has(h.api.describe({id:`existing_imported_bot_${index}`,icon:'sparkles'}).variant),'adding choices must never reassign an existing bot to a new identity');
  assert.equal(h.timers(),0);
});

test('catalogue failure retains explicit identities and rejects untrusted profile paths or catalogue IDs',t=>{
  const missing=ui(t,{entries:null});
  for(const entry of catalog)assert.equal(missing.api.describe({icon:`companion:${entry.id}`}).variant,entry.id);
  const unsafe=ui(t,{entries:[{id:'../../private',label:'Injected',motion:'url(https://invalid.example)',frames:true},{id:'blue',frames:true,motion:'url(https://invalid.example)'}]});
  assert.equal(unsafe.api.shapes.length,24);
  const node=unsafe.mount({id:'bot_unknown',icon:'companion:../../private'});
  assert.ok(['blue','coral','jade','honey'].includes(node.dataset.creature));
  assert.equal(node.querySelectorAll('img').length,1);assert.equal(unsafe.api.describe({icon:'companion:blue'}).frames,false);
  assert.ok(!node.outerHTML.includes('private'));assert.ok(!node.outerHTML.includes('invalid.example'));
});

test('live task-state changes preserve the registered image layers and the companion identity',t=>{
  const h=ui(t),node=h.mount({id:'bot_live',icon:'companion:cloud'},'small'),body=node.querySelector('.companion-body'),images=[...node.querySelectorAll('img')];
  const paths=images.map(image=>image.getAttribute('src'));
  for(const state of ['thinking','working','look','greeting','success','sad','floating','blink','idle']){
    h.api.setState(node,state);assert.equal(node.dataset.companionState,state);assert.equal(node.dataset.rokiState,state);
    assert.equal(node.querySelector('.companion-body'),body);assert.deepEqual([...node.querySelectorAll('img')],images);
    assert.deepEqual(images.map(image=>image.getAttribute('src')),paths);assert.equal(node.dataset.creature,'cloud');
  }
  h.api.setState(node,'curious');assert.equal(node.dataset.companionState,'look');
  h.api.setState(node,'untrusted-state');assert.equal(node.dataset.companionState,'idle');
  assert.equal(h.timers(),0);
});

test('one visibility observer pauses offscreen avatars and releases detached nodes and page lifecycles',async t=>{
  const h=ui(t,{observe:true}),first=h.mount({icon:'companion:cloud'}),second=h.mount({icon:'companion:azure'});await settle();
  assert.equal(h.instances.length,1);const watcher=h.instances[0];
  assert.equal(watcher.targets.size,2);assert.equal(first.classList.contains('companion-offscreen'),true);
  watcher.show(first,true);assert.equal(first.classList.contains('companion-offscreen'),false);
  watcher.show(first,false);assert.equal(first.classList.contains('companion-offscreen'),true);
  h.hidden(true);assert.equal(h.doc.documentElement.classList.contains('companion-tab-hidden'),true);
  h.hidden(false);assert.equal(h.doc.documentElement.classList.contains('companion-tab-hidden'),false);
  first.remove();await settle();assert.ok(watcher.removed.includes(first));assert.equal(watcher.targets.has(first),false);
  h.win.dispatchEvent(new h.win.Event('pagehide'));assert.equal(watcher.disconnections,1);assert.equal(watcher.targets.size,0);
  h.win.dispatchEvent(new h.win.Event('pageshow'));assert.equal(h.instances.length,2);assert.deepEqual([...h.instances[1].targets],[second]);
  assert.equal(h.timers(),0);
});

test('the full preview controls pause and change every rendered companion, including interface sizes',t=>{
  const h=ui(t,{previewControls:true});h.runPreview();
  assert.equal(h.doc.querySelectorAll('#companions article').length,24);
  assert.equal(h.doc.querySelectorAll('#companions .companion-avatar.large').length,24);
  assert.equal(h.doc.querySelectorAll('#companions .companion-avatar.small').length,24);
  assert.equal(h.doc.querySelectorAll('#companions .companion-avatar.tiny').length,24);
  assert.deepEqual([...h.doc.querySelectorAll('.animation-download')].map(link=>link.getAttribute('href')),catalog.filter(item=>item.frames).map(item=>`/assets/companions/companion-${item.id}-animated.webp`));
  const state=h.doc.querySelector('#state');state.value='greeting';state.dispatchEvent(new h.win.Event('change'));
  for(const node of h.doc.querySelectorAll('.companion-avatar'))assert.equal(node.dataset.companionState,'greeting');
  const paused=h.doc.querySelector('#paused');paused.checked=true;paused.dispatchEvent(new h.win.Event('change'));
  for(const node of h.doc.querySelectorAll('.companion-avatar'))assert.equal(node.classList.contains('is-paused'),true);
  assert.match(h.doc.querySelector('#motion-status').textContent,/All animation is paused/);
  paused.checked=false;paused.dispatchEvent(new h.win.Event('change'));
  for(const node of h.doc.querySelectorAll('.companion-avatar'))assert.equal(node.classList.contains('is-paused'),false);
  assert.equal(h.timers(),0);
});
