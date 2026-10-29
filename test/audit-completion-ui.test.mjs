import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { Integrations } from '../lib/integrations.mjs';

const appSource=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const profileSource=await readFile(new URL('../public/bot-profile.js',import.meta.url),'utf8');
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
const plain=value=>JSON.parse(JSON.stringify(value));
const catalog=new Integrations({state:{integrations:[]}}).catalog();
function ui(t,{catalogRequest}={}) {
  const dom=new JSDOM('<div id="dialog-root"></div><div id="toasts"></div>',{url:'http://studio.local/#/bots',runScripts:'outside-only'}),win=dom.window,doc=win.document;
  win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});win.setInterval=()=>1;
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
  const context=dom.getInternalVMContext();vm.runInContext(appSource,context);
  win.fixtureData={bots:[{id:'bot_atlas',name:'Atlas',title:'Assistant',skills:[],tools:['workspace','web','integrations'],integrationIds:[],collaborators:[],enabled:true}],connections:[],integrations:[{...catalog.find(item=>item.id==='searxng'),id:'search_fixture',name:'Private search',baseUrl:'https://search.example.com'}],skills:[],runs:{},routines:[],rooms:[],settings:{}};
  const calls=[],toasts=[];win.fixtureApi=async(route,options={})=>{
    calls.push(plain({route,...options}));
    if(route==='/api/integrations/catalog')return catalogRequest?catalogRequest():{integrations:catalog};
    if(options.method==='PATCH'){Object.assign(win.fixtureData.bots[0],options.body);return win.fixtureData.bots[0];}
    throw new Error(`Unexpected request ${route}`);
  };
  win.fixtureToast=(text,error)=>toasts.push({text,error});
  vm.runInContext('data={...initialState,...fixtureData};auth={authenticated:true,csrf:"fixture"};api=fixtureApi;refresh=async()=>{};renderApp=()=>{};toast=fixtureToast;',context);
  const run=code=>vm.runInContext(code,context),submit=async()=>{doc.querySelector('#bot-form').dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));await tick();};
  t.after(()=>win.close());return {win,doc,calls,toasts,run,submit};
}

test('search fallback is optional, saves with an owner assignment, reloads and clears when unassigned',async t=>{
  const h=ui(t);h.run("botDialog('bot_atlas')");let select=h.doc.querySelector('[name="searchFallbackIntegrationId"]');assert.equal(select.value,'');
  assert.match(select.closest('.field').textContent,/exact approval/);select.value='search_fixture';await h.submit();
  const save=h.calls.find(item=>item.method==='PATCH');assert.equal(save.body.searchFallbackIntegrationId,'search_fixture');assert.ok(save.body.integrationIds.includes('search_fixture'));
  h.run("botDialog('bot_atlas')");select=h.doc.querySelector('[name="searchFallbackIntegrationId"]');assert.equal(select.value,'search_fixture');
  const assigned=h.doc.querySelector('[name="integrationId"][value="search_fixture"]');assert.equal(assigned.checked,true);assigned.checked=false;assigned.dispatchEvent(new h.win.Event('change',{bubbles:true}));await tick();assert.equal(select.value,'');
  await h.submit();const last=h.calls.filter(item=>item.method==='PATCH').at(-1);assert.equal(last.body.searchFallbackIntegrationId,'');assert.ok(!last.body.integrationIds.includes('search_fixture'));
  h.run("botDialog('bot_atlas')");assert.equal(h.doc.querySelector('[name="searchFallbackIntegrationId"]').value,'');
});

test('search presets fill exact backend catalog definitions without inventing an endpoint or token',async t=>{
  const h=ui(t);h.run("integrationDialog(undefined,'rest')");const select=h.doc.querySelector('#integration-preset');select.value='searxng';
  await h.run("applyIntegrationPreset(document.querySelector('#integration-preset'))");
  assert.equal(h.doc.querySelector('#integration-type').value,'rest');assert.equal(h.doc.querySelector('#integration-name').value,'SearXNG (your instance)');assert.equal(h.doc.querySelector('#integration-url').value,'');assert.equal(h.doc.querySelector('#integration-auth').value,'none');assert.equal(h.doc.querySelector('#integration-key-field').hidden,true);
  const actions=JSON.parse(h.doc.querySelector('#integration-tools').value);assert.deepEqual(actions,plain(catalog.find(item=>item.id==='searxng').tools));assert.equal(actions[0].path,'/search');assert.ok(h.doc.querySelector('#integration-tools').required);
  h.doc.querySelector('#integration-key').value='a-token-typed-for-another-service';select.value='tavily';await h.run("applyIntegrationPreset(document.querySelector('#integration-preset'))");assert.equal(h.doc.querySelector('#integration-url').value,'https://api.tavily.com');assert.equal(h.doc.querySelector('#integration-auth').value,'bearer');assert.equal(h.doc.querySelector('#integration-key-field').hidden,false);assert.equal(h.doc.querySelector('#integration-key').value,'');
});

test('a stale catalog response cannot fill a newer preset choice or a replacement dialog',async t=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});const h=ui(t,{catalogRequest:()=>pending});
  h.run("integrationDialog(undefined,'rest')");const select=h.doc.querySelector('#integration-preset');select.value='searxng';const applying=h.run("applyIntegrationPreset(document.querySelector('#integration-preset'))");
  select.value='custom';h.doc.querySelector('#integration-name').value='Owner typed service';release({integrations:catalog});await applying;
  assert.equal(h.doc.querySelector('#integration-name').value,'Owner typed service');
  let finish;h.win.fixtureApi=async()=>new Promise(resolve=>{finish=resolve;});h.run('api=fixtureApi');select.value='tavily';const old=h.run("applyIntegrationPreset(document.querySelector('#integration-preset'))");h.run("botDialog('bot_atlas')");finish({integrations:catalog});await old;
  assert.ok(h.doc.querySelector('#bot-form'));assert.equal(h.doc.querySelector('#integration-form'),null);assert.equal(h.toasts.length,0);
});

function profile(t,{runs=[],memory=[]}={}) {
  const dom=new JSDOM('<main id="main"></main>',{url:'http://studio.local/#/bots/bot_atlas',runScripts:'outside-only'}),win=dom.window,doc=win.document;
  vm.runInContext(profileSource,dom.getInternalVMContext());
  const data={bots:[{id:'bot_atlas',name:'Atlas',title:'Assistant',tools:['memory'],skills:[],collaborators:[],enabled:true}],connections:[],skills:[],routines:[],rooms:[],integrations:[],runs:{},activity:[]};
  const ctx={data,botById:id=>data.bots.find(bot=>bot.id===id),botStatus:()=>({text:'Ready',className:'ready'}),statusPill:()=>'<span>Ready</span>',icon:()=>'<svg></svg>',avatar:()=>'<span></span>',relative:()=>'just now',errorText:error=>error.message,
    api:async route=>route.endsWith('/runs')?{data:runs}:route.endsWith('/brain')?{notes:[],total:0,tags:[]}:route.includes('/files')?{files:[]}:route.endsWith('/proposals')?{proposals:[]}:{entries:memory}};
  const show=async(tab='overview')=>{win.location.hash=`#/bots/bot_atlas${tab==='overview'?'':`/${tab}`}`;doc.querySelector('#main').innerHTML=win.StudioBotProfile.render(ctx,'bot_atlas');win.StudioBotProfile.mount(ctx,'bot_atlas',doc);await tick();};
  t.after(()=>win.close());return {win,doc,show};
}

test('task context and recall diagnostics disclose actual limits without claiming complete understanding',async t=>{
  const h=profile(t,{runs:[{id:'diagnostic_run',status:'completed',task:'Prepare a report.',diagnostics:{context:{tokens:1234,effective:16000},memory:{selected:2,total:5,omitted:3,refreshes:3,omittedPins:['budget'],truncated:['details']},compaction:{coverage:{complete:false,summaryCalls:3,mergeFailed:true}}}}]});
  await h.show();const details=h.doc.querySelector('[data-task-evidence]');assert.equal(details.open,false);
  assert.match(details.textContent,/Context and memory coverage/);assert.match(details.textContent,/1234 estimated context tokens/);assert.match(details.textContent,/2 of 5 facts selected; 3 omitted/);assert.match(details.textContent,/3 recall passes/);assert.match(details.textContent,/1 pinned facts did not fit/);assert.match(details.textContent,/1 fact excerpts were shortened/);assert.match(details.textContent,/partial; read original sources/);assert.match(details.textContent,/Summary merge failed/);assert.doesNotMatch(details.textContent,/complete within the selected sources/);
});

test('memory provenance is a collapsed escaped origin disclosure, and legacy facts stay unknown',async t=>{
  const h=profile(t,{memory:[{id:'fact_new',key:'Writing',value:'Use clear prose.',updatedAt:'2026-10-28T12:00:00Z',provenance:{kind:'owner-chat',observedAt:'2026-10-28T12:00:00Z',messageIds:['message_owner','<img src=x onerror=alert(1)>']},supersedes:{revision:'earlier'}},{id:'fact_legacy',key:'Legacy',value:'Existing fact.',updatedAt:'2026-10-27T12:00:00Z'}]});
  await h.show('memory');const details=[...h.doc.querySelectorAll('.bp-fact details')];assert.equal(details.length,2);assert.ok(details.every(item=>!item.open));
  const text=details.map(item=>item.textContent).join('\n');assert.match(text,/Source and changes/);assert.match(text,/Saved from your conversation/);assert.match(text,/Replaces an earlier revision/);assert.match(text,/message_owner/);assert.match(text,/Source not recorded/);assert.match(text,/does not grant permission/);assert.equal(h.doc.querySelectorAll('img,script').length,0);
});
