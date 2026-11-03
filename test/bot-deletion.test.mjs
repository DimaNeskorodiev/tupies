import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createStudioServer} from '../server.mjs';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
function ui(t) {
  const dom=new JSDOM('<div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'https://fixture.test/#/bots/bot_atlas/settings',runScripts:'outside-only'});
  const win=dom.window,requests=[],state={failure:null};win.scrollTo=()=>{};
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
  const context=dom.getInternalVMContext();
  vm.runInContext(source,context);
  win.fixtureAPI=async(route,options)=>{requests.push({route,options:JSON.parse(JSON.stringify(options))});if(state.failure)throw new Error(state.failure);return {deleted:true};};
  vm.runInContext(`auth={authenticated:true};data={...initialState,bots:[{id:'bot_atlas',name:'Atlas',title:'Chief of staff',connectionId:'fixture'}],connections:[{id:'fixture',type:'openai',status:'connected'}]};api=window.fixtureAPI;refresh=async()=>{data.bots=[];renderApp();};renderApp();`,context);
  t.after(()=>win.close());
  return {win,requests,state,run:code=>vm.runInContext(code,context),$:selector=>win.document.querySelector(selector),click:async selector=>{const button=win.document.querySelector(selector);assert.ok(button,selector);button.click();await tick();}};
}

test('bot settings expose removal outside Advanced and bot options lead to the same confirmation',t=>{
  const h=ui(t);
  const form=h.run('botSettingsForm("bot_atlas",{embedded:true})');
  h.$('#app').innerHTML=form;
  const remove=h.$('[data-bot-settings-section="remove"] [data-action="delete-bot"]');
  assert.ok(remove);assert.equal(remove.closest('details'),null);assert.equal(remove.type,'button');
  assert.ok(h.$('[data-profile-action="settings-section"][data-section="remove"]'));
  h.run('openMenu=(anchor,items)=>{globalThis.fixtureMenu=items;};chatMenu({},"bot_atlas");');
  assert.match(h.run('fixtureMenu'),/data-action="delete-bot" data-id="bot_atlas"/);
  assert.equal(h.requests.length,0);
});

test('bot removal requires confirmation, keeps Cancel inert, and shows busy refusal with a working retry',async t=>{
  const h=ui(t);
  h.run('document.querySelector("#app").innerHTML=botSettingsForm("bot_atlas",{embedded:true});');
  await h.click('[data-action="delete-bot"]');
  assert.equal(h.requests.length,0);assert.equal(h.$('dialog').getAttribute('aria-label'),'Remove Atlas?');
  assert.match(h.$('dialog').textContent,/Saved workspace files remain on this engine/);
  await h.click('dialog .modal-footer [data-action="close-dialog"]');
  assert.equal(h.$('dialog'),null);assert.equal(h.requests.length,0);
  await h.click('[data-action="delete-bot"]');
  h.state.failure='Stop the active run and room turn before removing this bot.';
  await h.click('[data-action="confirm-delete"]');
  assert.match(h.$('dialog .form-error').textContent,/Stop the active run/);
  assert.equal(h.$('[data-action="confirm-delete"]').disabled,false);
  assert.equal(h.win.location.hash,'#/bots/bot_atlas/settings');
  assert.equal(h.run('data.bots.length'),1);
  h.state.failure=null;
  await h.click('[data-action="confirm-delete"]');
  assert.equal(h.$('dialog'),null);assert.equal(h.win.location.hash,'#/bots');
  assert.equal(h.run('data.bots.length'),0);
  assert.deepEqual(h.requests.map(item=>({route:item.route,method:item.options.method,body:item.options.body})),[
    {route:'/api/bots/bot_atlas',method:'DELETE',body:{}},{route:'/api/bots/bot_atlas',method:'DELETE',body:{}},
  ]);
});

test('bot deletion protects active work and removes only its state while retaining saved files',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'tupies-bot-deletion-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  t.after(async()=>{delete app.store.state.runs.bot_atlas;await app.close();await rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0);let cookie='',csrf='';
  async function request(route,{method='GET',body,signedIn=true}={}) {
    const response=await fetch(url+route,{method,headers:{...(signedIn&&cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const setup=await request('/api/setup',{method:'POST',body:{token:app.bootstrapToken,password:'disposable-deletion-fixture-password'}});
  cookie=setup.cookie;csrf=setup.body.csrf;
  const endpoint='/api/bots/bot_atlas';
  assert.equal((await request(endpoint,{method:'DELETE',signedIn:false})).status,401);
  for(const status of ['running','waiting_for_input','waiting_for_approval']) {
    app.store.state.runs.bot_atlas={id:'deletion_active',botId:'bot_atlas',status,events:[]};
    const result=await request(endpoint,{method:'DELETE'});assert.equal(result.status,409,status);
    assert.match(result.body.error,/Stop the active run/);assert.ok(app.store.state.bots.some(bot=>bot.id==='bot_atlas'));
  }
  delete app.store.state.runs.bot_atlas;
  const savedFile=path.join(directory,'workspaces','bot_atlas','documents','saved.txt');
  await mkdir(path.dirname(savedFile),{recursive:true});await writeFile(savedFile,'Keep this saved file.');
  await app.store.mutate(state=>{
    state.messages.bot_atlas=[{id:'atlas_message',role:'user',content:'Remove this bot chat.'}];
    state.messages.bot_nova=[{id:'nova_message',role:'user',content:'Keep this other bot chat.'}];
    state.memory.bot_atlas=[{id:'atlas_fact',key:'Fact',value:'Remove this fact.'}];
    state.routines.push({id:'atlas_routine',name:'Atlas routine',botId:'bot_atlas',enabled:false});
    (state.proposals ||= []).push({id:'atlas_proposal',botId:'bot_atlas',status:'pending'});
    state.bots.find(bot=>bot.id==='bot_nova').collaborators=['bot_atlas'];
    state.rooms.push({id:'fixture_room',name:'Room',botIds:['bot_atlas','bot_nova']});
    state.channels.push({id:'fixture_channel',botId:'bot_atlas',enabled:true});
  });
  const result=await request(endpoint,{method:'DELETE'});assert.equal(result.status,200);assert.equal(result.body.deleted,true);
  const state=app.store.state;
  assert.ok(!state.bots.some(bot=>bot.id==='bot_atlas'));assert.equal(state.messages.bot_atlas,undefined);assert.equal(state.memory.bot_atlas,undefined);
  assert.ok(!state.routines.some(item=>item.botId==='bot_atlas'));assert.ok(!state.proposals.some(item=>item.botId==='bot_atlas'));
  assert.deepEqual(state.bots.find(bot=>bot.id==='bot_nova').collaborators,[]);
  assert.deepEqual(state.rooms.find(item=>item.id==='fixture_room').botIds,['bot_nova']);
  assert.equal(state.channels.find(item=>item.id==='fixture_channel').enabled,false);
  assert.equal(state.messages.bot_nova[0].content,'Keep this other bot chat.');assert.equal(await readFile(savedFile,'utf8'),'Keep this saved file.');
  assert.equal((await request(endpoint,{method:'DELETE'})).status,404);
});
