import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createStudioServer} from '../server.mjs';

async function fixture(t,{platform='darwin'}={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-desktop-api-'));const calls=[];
  const app=await createStudioServer({dataDir:path.join(directory,'data'),scheduler:false,logErrors:false,trustProxy:'loopback',desktop:{platform,identity:async executable=>[{path:executable,sha256:'a'.repeat(64)}],driver:async input=>{calls.push(input.args);return input.args[0]==='version'?{version:'1.1.0'}:{version:'1.1.0',permissions:{accessibility:{state:'denied'}}};}}});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});const {url}=await app.listen(0,'127.0.0.1');let cookie='',csrf='';
  const request=async(route,{method='GET',body,auth=true,headers={},token=true}={})=>{const response=await fetch(url+route,{method,headers:{...(auth?{Cookie:cookie}:{}),...(token?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json(),headers:response.headers};};
  const setup=await request('/api/setup',{method:'POST',body:{token:app.bootstrapToken,password:'synthetic-desktop-test-password'}});cookie=setup.headers.get('set-cookie').split(';')[0];csrf=setup.body.csrf;
  const config={enabled:true,executable:path.join(directory,'driver'),apps:[{name:'Fixture',botIds:[app.store.state.bots[0].id]}]};return {app,request,config,calls};
}
test('desktop setup retains authentication, CSRF and Origin boundaries',async t=>{
  const f=await fixture(t);assert.equal((await f.request('/api/desktop',{auth:false})).status,401);
  for(const options of [{token:false},{headers:{Origin:'https://elsewhere.invalid'}}])assert.equal((await f.request('/api/desktop',{...options,method:'PUT',body:f.config})).status,403);
  assert.equal(f.calls.length,0);assert.equal((await f.request('/api/desktop',{method:'PUT',body:f.config})).status,200);
  assert.equal((await f.request('/api/desktop/check',{method:'POST',body:{}})).body.driver.permissions.accessibility.state,'denied');
});
test('proxy-aware remote clients cannot inspect local assignments or configure a driver',async t=>{
  const f=await fixture(t);await f.app.access.setPublicPassword(true);const headers={'X-Forwarded-For':'198.51.100.8'};
  assert.deepEqual((await f.request('/api/desktop',{headers})).body,{available:false,enabled:false,apps:[]});assert.equal((await f.request('/api/desktop',{method:'PUT',body:f.config,headers})).status,403);assert.equal((await f.request('/api/desktop/check',{method:'POST',body:{},headers})).status,403);assert.equal(f.calls.length,0);
});
test('desktop setup refuses unknown fields, bot identities and unsupported platforms',async t=>{
  const f=await fixture(t);for(const body of [{...f.config,command:'arbitrary'},{...f.config,apps:[{name:'Fixture',botIds:['unknown']}]},{...f.config,enabled:'true'}])assert.equal((await f.request('/api/desktop',{method:'PUT',body})).status,400);
  assert.equal((await f.request('/api/desktop/check',{method:'POST',body:{command:'launch'}})).status,400);assert.equal(f.calls.length,0);
  const linux=await fixture(t,{platform:'linux'});assert.deepEqual((await linux.request('/api/desktop')).body,{available:false,enabled:false,apps:[]});assert.equal((await linux.request('/api/desktop',{method:'PUT',body:linux.config})).status,409);
});
test('desktop opt-in persists through ordinary bot settings without granting terminal access',async t=>{
  const f=await fixture(t),bot=f.app.store.state.bots[0],result=await f.request(`/api/bots/${bot.id}`,{method:'PATCH',body:{tools:['desktop']}});assert.equal(result.status,200);assert.deepEqual(result.body.tools,['desktop']);assert.equal(f.app.runtime.desktop.ready(),false);
});
