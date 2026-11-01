import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadMissionPricing } from '../lib/mission-pricing.mjs';
import { routineConnectionIdentity } from '../lib/routine-checkpoints.mjs';

const row=()=>({connectionId:'synthetic',type:'openai',baseUrl:'https://provider.invalid/v1',model:'fixture-model',version:'synthetic-rates-v1',currency:'USD',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:2_000_000,cachedInputMicrosPerMillion:100_000,cacheCreationMicrosPerMillion:1_250_000});
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'tupies-mission-pricing-')));await fs.chmod(root,0o700);const dataDir=path.join(root,'runtime');await fs.mkdir(dataDir,{mode:0o700});const file=path.join(root,'prices.json'),connection={id:'synthetic',type:'openai',baseUrl:'https://provider.invalid/v1'},state={connections:[connection]};
  t.after(()=>fs.rm(root,{recursive:true,force:true}));const write=async document=>fs.writeFile(file,typeof document==='string'?document:JSON.stringify(document),{mode:0o600});await write({schemaVersion:1,schedules:[row()]});return {root,dataDir,file,state,connection,write,load:()=>loadMissionPricing({file,dataDir,state})};}

test('absent startup pricing does not read runtime or invent rates',async()=>{
  const result=await loadMissionPricing({file:undefined,dataDir:'/does/not/exist',state:null});assert.equal(result.configured,false);assert.equal(result.count,0);assert.equal(result.priceFor({id:'missing'},'fixture'),undefined);assert.equal(Object.isFrozen(result),true);
});

test('startup rates bind exact provider identity/model, freeze values and never hot reload',async t=>{
  const h=await fixture(t),result=await h.load(),schedule=result.priceFor(h.connection,'fixture-model');assert.equal(result.configured,true);assert.equal(result.count,1);assert.equal(schedule.source,'operator');assert.equal(schedule.version,'synthetic-rates-v1');assert.equal(Object.isFrozen(schedule),true);assert.throws(()=>{schedule.inputMicrosPerMillion=0;},TypeError);
  assert.equal(result.priceFor(h.connection,'other-model'),undefined);assert.equal(result.priceFor({...h.connection,baseUrl:'https://other.invalid'},'fixture-model'),undefined);assert.equal(result.priceFor({...h.connection,type:'anthropic'},'fixture-model'),undefined);assert.equal(result.priceFor({...h.connection,oauthAccount:'changed-account'},'fixture-model'),undefined);
  await h.write({schemaVersion:1,schedules:[{...row(),version:'changed',inputMicrosPerMillion:9}]});assert.equal(result.priceFor(h.connection,'fixture-model').inputMicrosPerMillion,1_000_000);assert.equal((await h.load()).priceFor(h.connection,'fixture-model').inputMicrosPerMillion,9);
});

test('optional identity hash and duplicate exact schedule are validated at startup',async t=>{
  const h=await fixture(t);await h.write({schemaVersion:1,schedules:[{...row(),connectionIdentity:routineConnectionIdentity(h.connection)}]});assert.equal((await h.load()).count,1);
  for(const schedules of [[{...row(),connectionIdentity:'a'.repeat(64)}],[row(),row()],[{...row(),baseUrl:'https://changed.invalid'}],[{...row(),connectionId:'unknown'}]]){await h.write({schemaVersion:1,schedules});await assert.rejects(h.load());}
});

test('unknown keys, schemas, noninteger/negative/overflow rates and malformed UTF-8 fail without logging payloads',async t=>{
  const h=await fixture(t),privateMarker='synthetic-private-marker';
  for(const document of [{schemaVersion:2,schedules:[]},{schemaVersion:1,schedules:[],grant:'all'},{schemaVersion:1,schedules:[{...row(),apiKey:privateMarker}]},{schemaVersion:1,schedules:Array(101).fill(row())},...[-1,NaN,Infinity,0.1,Number.MAX_SAFE_INTEGER+1].map(value=>({schemaVersion:1,schedules:[{...row(),inputMicrosPerMillion:value}]}))]){
    await h.write(document);await assert.rejects(h.load(),error=>{assert.doesNotMatch(error.message,new RegExp(privateMarker));return true;});
  }
  await h.write('{');await assert.rejects(h.load(),/valid bounded UTF-8 JSON/);await fs.writeFile(h.file,Buffer.from([0xff]),{mode:0o600});await assert.rejects(h.load(),/valid bounded UTF-8 JSON/);
});

test('file must be bounded, private regular single-link bytes',async t=>{
  const h=await fixture(t);await fs.chmod(h.file,0o660);await assert.rejects(h.load(),/trusted, non-writable regular file/);await fs.chmod(h.file,0o600);
  const link=path.join(h.root,'hardlink.json');await fs.link(h.file,link);await assert.rejects(h.load(),/regular file/);await fs.unlink(link);
  await h.write(' '.repeat(65537));await assert.rejects(h.load(),/64 KiB/);await h.write('');await assert.rejects(h.load(),/regular file/);
});

test('runtime and every model-editable path class are excluded',async t=>{
  const h=await fixture(t);
  for(const folder of [h.dataDir,...['workspaces','skills','proposals','mission-evidence','process-homes'].map(name=>path.join(h.root,name))]){await fs.mkdir(folder,{mode:0o700,recursive:true});const file=path.join(folder,'prices.json');await fs.writeFile(file,JSON.stringify({schemaVersion:1,schedules:[row()]}),{mode:0o600});await assert.rejects(loadMissionPricing({file,dataDir:h.dataDir,state:h.state}),/runtime tree|model-editable/);}
});

test('relative/traversal/symlink paths and writable ancestors are refused',async t=>{
  const h=await fixture(t);await assert.rejects(loadMissionPricing({file:'prices.json',dataDir:h.dataDir,state:h.state}),/absolute/);await assert.rejects(loadMissionPricing({file:`${h.root}/nested/../prices.json`,dataDir:h.dataDir,state:h.state}),/traversal/);
  const fileLink=path.join(h.root,'linked.json');await fs.symlink(h.file,fileLink);await assert.rejects(loadMissionPricing({file:fileLink,dataDir:h.dataDir,state:h.state}),/regular file|symbolic/);
  const directoryLink=path.join(h.root,'linked-directory');await fs.symlink(h.root,directoryLink);await assert.rejects(loadMissionPricing({file:path.join(directoryLink,'prices.json'),dataDir:h.dataDir,state:h.state}),/symbolic/);
  await fs.chmod(h.root,0o770);await assert.rejects(h.load(),/non-writable directory/);await fs.chmod(h.root,0o700);
});

test('subscription identity never receives an invented unit-price resolver',async t=>{
  const h=await fixture(t);h.state.connections[0].type='chatgpt';await h.write({schemaVersion:1,schedules:[{...row(),type:'chatgpt'}]});await assert.rejects(h.load(),/Subscription connections/);
});
