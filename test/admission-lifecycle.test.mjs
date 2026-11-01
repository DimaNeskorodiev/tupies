import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { createStudioServer } from '../server.mjs';

const gate=()=>{let release;return {promise:new Promise(resolve=>{release=resolve;}),release:()=>release()};};
const configure=store=>store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Fixture',model:'fixture-model',secret:store.seal('disposable-fixture-key')});for(const bot of state.bots)bot.connectionId='fixture-provider';});

for(const change of ['removed','reconfigured'])test(`a bot ${change} during admission leaves no orphan task or submission receipt`,async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-admission-')),store=await new Store(directory).init();
  await configure(store);let inferences=0;
  const engine=new NativeEngine(store,{providers:{async complete(){inferences++;return {text:'Done.',toolCalls:[]};}}});
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const waiting=gate(),queued=store.mutate(async state=>{await waiting.promise;if(change==='removed')state.bots=state.bots.filter(bot=>bot.id!=='bot_atlas');else state.bots=state.bots.map(bot=>bot.id==='bot_atlas'?{...bot,tools:[]}:bot);});
  const starting=engine.submit('bot_atlas','A task racing an owner edit.',{clientMessageId:'admission_fixture_001'});
  assert.equal(engine.starting.has('bot_atlas'),true);
  waiting.release();await queued;
  await assert.rejects(starting,error=>error.status===409 && /changed|removed/.test(error.message));
  assert.equal(store.state.runs.bot_atlas,undefined);assert.equal(store.state.messages.bot_atlas?.length || 0,0);
  assert.equal(engine.receipt('bot_atlas','admission_fixture_001'),null);assert.equal(inferences,0);
});

test('owner bot edits and deletion wait for asynchronous admission and explicit compaction',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-admission-api-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers:{async complete(){return {text:'Done.',toolCalls:[]};}}});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0);let cookie='',csrf='';
  const request=async(method,data)=>{const response=await fetch(`${url}/api/bots/bot_atlas`,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json()};};
  const setup=await fetch(`${url}/api/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'disposable-fixture-password'})});
  cookie=setup.headers.get('set-cookie').split(';')[0];csrf=(await setup.json()).csrf;await configure(app.store);
  // Keep the actual start's durable admission waiting while HTTP handles the conflicting edits.
  const waiting=gate(),queued=app.store.serialize(()=>waiting.promise),starting=app.runtime.submit('bot_atlas','An admitted task.');
  assert.equal(app.runtime.starting.has('bot_atlas'),true);
  try {
    assert.equal((await request('PATCH',{name:'Racing edit'})).status,409);
    assert.equal((await request('DELETE')).status,409);
  } finally {waiting.release();}
  await queued;await starting;await Promise.allSettled([...app.runtime.tasks.values()]);
  app.runtime.compactions.set('bot_atlas',new AbortController());
  try {
    assert.equal((await request('PATCH',{name:'During summary'})).status,409);
    assert.equal((await request('DELETE')).status,409);
    assert.equal((await request('PATCH',{hidden:true})).status,200,'Visibility changes are still safe while summarizing.');
    assert.equal((await request('PATCH',{favorite:true})).status,200,'Favorites do not alter execution settings.');
    assert.equal(app.store.state.bots.find(bot=>bot.id==='bot_atlas').favorite,true);
    assert.equal((await request('PATCH',{favorite:'yes'})).status,400);
    assert.equal((await request('PATCH',{favorite:false,tools:[]})).status,409,'List preferences cannot bypass execution-setting guards.');
  } finally {app.runtime.compactions.delete('bot_atlas');}
  assert.ok(app.store.state.bots.some(bot=>bot.id==='bot_atlas'));
});
