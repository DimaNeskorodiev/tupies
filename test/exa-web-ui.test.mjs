import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { Integrations } from '../lib/integrations.mjs';

const appSource=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
const catalog=new Integrations({state:{integrations:[]}}).catalog();
const exa={...catalog.find(item=>item.id==='exa'),id:'exa_owned',name:'Exa',hasKey:true,status:'configured'};

function ui(t,integrations=[]) {
  const dom=new JSDOM('<div id="dialog-root"></div><div id="toasts"></div>',{url:'http://studio.local/#/settings/integrations',runScripts:'outside-only'}),win=dom.window,doc=win.document;
  win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});win.setInterval=()=>1;
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
  const context=dom.getInternalVMContext();vm.runInContext(appSource,context);
  win.fixtureData={bots:[{id:'bot_atlas',name:'Atlas',title:'Assistant',skills:[],tools:['web'],integrationIds:[],collaborators:[],enabled:true}],connections:[],integrations,skills:[],routines:[],channels:[]};
  win.fixtureApi=async route=>{if(route==='/api/integrations/catalog')return {integrations:catalog};throw new Error(`Unexpected request ${route}`);};
  vm.runInContext('data={...initialState,...fixtureData};auth={authenticated:true,csrf:"fixture"};api=fixtureApi;refresh=async()=>{};renderApp=()=>{};toast=()=>{};',context);
  t.after(()=>win.close());
  return {win,doc,run:code=>vm.runInContext(code,context)};
}

test('Integrations offers Exa as the default web search and marks the configured connection',async t=>{
  const empty=ui(t);
  const before=empty.run('renderIntegrations()');
  assert.match(before,/Web search · Exa/);assert.match(before,/DuckDuckGo stays as fallback/);assert.doesNotMatch(before,/Default web search/);
  const configured=ui(t,[exa,{...exa,id:'exa_second',name:'Second Exa'}]);
  const page=configured.run('renderIntegrations()'),cards=page.split('connection-card').slice(1);
  assert.match(cards[0],/Default web search/);assert.match(cards[0],/All bots with Web tools/);
  assert.doesNotMatch(cards[1],/Default web search/,'only the first Exa connection is the default');
  assert.match(page,/Exa is your bots’ default search and page reader/);
  const keyless=ui(t,[{...exa,hasKey:false}]);assert.doesNotMatch(keyless.run('renderIntegrations()'),/Default web search/);
});

test('the Exa template opens the integration form with the Exa preset applied',async t=>{
  const h=ui(t);h.doc.body.insertAdjacentHTML('beforeend',h.run('renderIntegrations()'));
  h.doc.querySelector('[data-preset="exa"]').dispatchEvent(new h.win.MouseEvent('click',{bubbles:true}));await tick();
  const form=h.doc.querySelector('#integration-form');assert.ok(form);
  assert.equal(form.querySelector('#integration-preset').value,'exa');
  assert.equal(form.querySelector('#integration-url').value,'https://api.exa.ai');
  assert.equal(form.querySelector('#integration-auth').value,'bearer');
  assert.equal(form.querySelector('#integration-key-field').hidden,false);
  assert.deepEqual(JSON.parse(form.querySelector('#integration-tools').value).map(tool=>tool.name),['web_search','web_extract']);
  assert.match(h.doc.querySelector('.modal-subtitle').textContent,/default web search and page reader for every bot with Web tools/);
});
