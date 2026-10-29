import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n'),tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setTimeout(resolve,0));};
function fixture(t){
  const dom=new JSDOM('<div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'https://studio.test/#/sync',runScripts:'outside-only'}),win=dom.window,context=dom.getInternalVMContext(),requests=[];let confirmed=false;
  win.matchMedia=()=>({matches:false,addEventListener(){}});win.setInterval=()=>1;win.scrollTo=()=>{};win.confirm=()=>confirmed;vm.runInContext(source,context);
  const status={node:{id:'node_fixture',name:'Fixture',role:'standalone',fingerprint:'fixture-fingerprint',automation:false,automationSuspended:true,enabledRoutines:2,enabledChannels:1,detachedChatGPT:1},hub:null,engines:[],pending:0,documents:25,skippedFiles:[]};
  win.fixtureApi=async(route,options={})=>{requests.push({route,options});if(route==='/api/sync/automation'){status.node.automation=true;status.node.automationSuspended=false;return status;}if(route==='/api/sync/status')return status;if(route==='/api/devices')return {devices:[],current:null};throw new Error('Unexpected fixture route');};
  vm.runInContext('auth={authenticated:true,csrf:"fixture"};data={...initialState};api=fixtureApi;refresh=async()=>{};renderApp()',context);t.after(()=>win.close());return {win,requests,status,query:selector=>win.document.querySelector(selector),confirm:value=>{confirmed=value;}};
}
test('unlinked Sync UI explains local suspension and requires explicit confirmation without transferring ChatGPT ownership',async t=>{
  const h=fixture(t);await tick();const text=h.query('.sync-page').textContent;assert.match(text,/2 enabled routines and 1 enabled messaging channels stay paused/);assert.doesNotMatch(text,/routines and channels run on the home server/);assert.match(text,/fresh ChatGPT sign-in/);
  h.query('[data-action="enable-local-automation"]').click();await tick();assert.equal(h.requests.some(item=>item.options.method==='POST'),false);h.confirm(true);h.query('[data-action="enable-local-automation"]').click();await tick();const request=h.requests.find(item=>item.route==='/api/sync/automation');assert.deepEqual(JSON.parse(JSON.stringify(request.options.body)),{enabled:true,confirm:true});assert.equal(h.query('[data-action="enable-local-automation"]'),null);assert.match(h.query('.sync-page').textContent,/ChatGPT needs a fresh sign-in here/);assert.match(h.query('.sync-page').textContent,/runs routines and messaging channels/);
});
