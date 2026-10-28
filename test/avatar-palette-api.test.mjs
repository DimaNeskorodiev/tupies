import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudioServer } from '../server.mjs';

test('all eighteen avatar palettes save through the authenticated API and unknown colors leave the bot unchanged',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'studio-avatar-palettes-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0);
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'avatar-palette-fixture-password'})});
  assert.equal(setup.status,201);
  const {csrf}=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  const headers={'Content-Type':'application/json','Cookie':cookie,'X-CSRF-Token':csrf};
  const colors=['mint','lavender','peach','blue','rose','amber','coral','ruby','tangerine','lemon','lime','forest','teal','ice','indigo','plum','orchid','slate'];
  for(const color of colors){
    const response=await fetch(url+'/api/bots/bot_atlas',{method:'PATCH',headers,body:JSON.stringify({color})});
    assert.equal(response.status,200,`Expected ${color} to be accepted`);
    assert.equal((await response.json()).color,color);
    const state=await (await fetch(url+'/api/state',{headers:{Cookie:cookie}})).json();
    assert.equal(state.bots.find(bot=>bot.id==='bot_atlas').color,color);
  }
  const before=structuredClone(app.store.state.bots.find(bot=>bot.id==='bot_atlas'));
  const rejected=await fetch(url+'/api/bots/bot_atlas',{method:'PATCH',headers,body:JSON.stringify({color:'url(https://example.invalid/injected)'})});
  assert.equal(rejected.status,400);
  assert.deepEqual(app.store.state.bots.find(bot=>bot.id==='bot_atlas'),before);
});

test('Roki identity persists through authenticated creation, edits and a store reload',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'studio-roki-avatar-'));
  let app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0);
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'roki-avatar-fixture-password'})});
  assert.equal(setup.status,201);
  const {csrf}=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  const headers={'Content-Type':'application/json','Cookie':cookie,'X-CSRF-Token':csrf};
  const created=await fetch(url+'/api/bots',{method:'POST',headers,body:JSON.stringify({name:'Roki fixture',title:'Planner',icon:'roki',color:'slate'})});
  assert.equal(created.status,201);
  const bot=await created.json();
  assert.equal(bot.icon,'roki');assert.equal(bot.color,'slate');
  const defaultCreated=await fetch(url+'/api/bots',{method:'POST',headers,body:JSON.stringify({name:'Default fixture',title:'Planner'})});
  assert.equal(defaultCreated.status,201);
  const defaults=await defaultCreated.json();
  assert.equal(defaults.icon,'roki');assert.equal(defaults.color,'slate');
  const edited=await fetch(url+'/api/bots/'+bot.id,{method:'PATCH',headers,body:JSON.stringify({title:'Updated planner'})});
  assert.equal(edited.status,200);
  assert.equal((await edited.json()).icon,'roki');
  const image=await fetch(url+'/assets/roki/roki-idle-128.webp');
  assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/webp');
  const bytes=Buffer.from(await image.arrayBuffer());
  assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WEBP');
  const etag=image.headers.get('etag');assert.ok(etag);
  const cached=await fetch(url+'/assets/roki/roki-idle-128.webp',{headers:{'If-None-Match':etag}});
  assert.equal(cached.status,304);
  await app.close();
  app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  const reloaded=app.store.state.bots.find(value=>value.id===bot.id);
  assert.equal(reloaded.icon,'roki');assert.equal(reloaded.color,'slate');assert.equal(reloaded.title,'Updated planner');
});
