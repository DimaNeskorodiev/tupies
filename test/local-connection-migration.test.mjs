import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { isLocalConnection } from '../lib/local-models.mjs';

// Fixture values only.
test('loopback compatible endpoints saved before local models keep their earlier behaviour; later ones are detected',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'tupies-local-migration-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const first=await new Store(directory).init();
  await first.mutate(state=>{state.connections.push(
    {id:'proxy',type:'custom',name:'Local proxy',baseUrl:'http://127.0.0.1:4000/v1'},
    {id:'remote',type:'custom',name:'Remote',baseUrl:'https://api.example.com/v1'},
    {id:'mlx',type:'mlx',name:'Mac · MLX',baseUrl:'http://127.0.0.1:8080/v1'},
    {id:'chosen',type:'custom',name:'Chosen',baseUrl:'http://localhost:1234/v1',local:true});
    delete state.localConnectionsMarked;});
  const second=await new Store(directory).init();
  const byId=id=>second.state.connections.find(item=>item.id===id);
  assert.equal(byId('proxy').local,false);assert.equal(isLocalConnection(byId('proxy')),false);
  assert.equal(byId('remote').local,undefined);assert.equal(byId('mlx').local,undefined);assert.equal(isLocalConnection(byId('mlx')),true);
  assert.equal(byId('chosen').local,true);assert.equal(second.state.localConnectionsMarked,true);
  await second.mutate(state=>{state.connections.push({id:'later',type:'custom',name:'Later',baseUrl:'http://127.0.0.1:8090/v1'});});
  const third=await new Store(directory).init();
  const later=third.state.connections.find(item=>item.id==='later');
  assert.equal(later.local,undefined);assert.equal(isLocalConnection(later),true,'a loopback endpoint added after the upgrade is local');
});
