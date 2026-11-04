import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const source=await readFile(new URL('../public/chat-learning.js',import.meta.url),'utf8');
function fixture(t){const dom=new JSDOM('<main></main>',{runScripts:'outside-only',pretendToBeVisual:true});dom.window.eval(source);t.after(()=>dom.window.close());return {window:dom.window,root:dom.window.document.querySelector('main'),ui:dom.window.StudioChatLearning};}
const row=(kind,status='saved',index=1)=>({id:`run:learning:${index}`,kind,status,label:'A useful method',target:'method',createdAt:new Date().toISOString()});
test('receipts distinguish saved work and pending suggestions, escape text and link to their actual sections',t=>{
  const {root,ui}=fixture(t);root.innerHTML=ui.render([row('brain'),row('memory','saved',2),row('skill','saved',3),{...row('skill','suggested',4),label:'<img src=x onerror=alert(1)>'}], 'bot_test');
  assert.equal(root.querySelectorAll('a').length,4);assert.equal(root.querySelectorAll('img').length,0);
  assert.deepEqual([...root.querySelectorAll('a')].map(a=>a.getAttribute('href')),['#/bots/bot_test/brain','#/bots/bot_test/memory','#/skills/bot_test','#/bots/bot_test/learning']);
  assert.match(root.textContent,/Saved to Brain/);assert.match(root.textContent,/Memory updated/);assert.match(root.textContent,/Skill created/);assert.match(root.textContent,/Skill suggested/);
  assert.equal(ui.render([{...row('brain'),status:'running'},{...row('brain'),kind:'__proto__'}],'bot_test'),'');
});
test('a fresh live receipt animates once, with no replay after polling, DOM replacement or opening old history',t=>{
  const {root,ui,window}=fixture(t),saved=row('skill');root.innerHTML=ui.render([saved],'bot_test');ui.mount(root,{liveRunId:'run',active:true});
  assert.ok(root.querySelector('.is-arriving'));assert.match(root.querySelector('[role=status]').textContent,/Skill created/);
  root.querySelector('a').dispatchEvent(new window.Event('animationend'));assert.equal(root.querySelector('.is-arriving'),null);
  ui.mount(root,{liveRunId:'run'});assert.equal(root.querySelector('.is-arriving'),null);
  root.innerHTML=ui.render([saved],'bot_test');ui.mount(root,{liveRunId:'run'});assert.equal(root.querySelector('.is-arriving'),null);
  root.innerHTML=ui.render([{...row('brain','saved',2),createdAt:'2020-01-01T00:00:00.000Z'}],'bot_test');ui.mount(root,{liveRunId:'run'});assert.equal(root.querySelector('.is-arriving'),null);
});
test('static history stays quiet and reduced motion disables every animated layer',async t=>{
  const {root,ui}=fixture(t);root.innerHTML=ui.render([row('brain')],'bot_test');ui.mount(root);assert.equal(root.querySelector('.is-arriving'),null);
  const css=await readFile(new URL('../public/chat-learning.css',import.meta.url),'utf8');assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);assert.match(css,/animation:none!important/);assert.match(css,/:focus-visible/);
});
