import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {StudySources} from '../lib/study-sources.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const upload=text=>({name:'reference.md',contentBase64:Buffer.from(text).toString('base64')});
const outcome=promise=>{let settled=false;const result=promise.then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});return {result,get settled(){return settled;}};};
async function fixture(t,publicFetch){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-study-admission-')),sources=new StudySources(directory,{publicFetch});t.after(async()=>{await sources.queue;await fs.rm(directory,{recursive:true,force:true});});return {directory,sources};}

test('queued intake and extraction abort before another bot releases the source queue',async t=>{
  const entered=deferred(),release=deferred(),{directory,sources}=await fixture(t,async()=>{entered.resolve();await release.promise;return {status:200,text:'No accessible captions.'};});
  const first=await sources.stage('active',[{url:'https://www.youtube.com/watch?v=abcdefghijk'}]),second=await sources.stage('queued_extract',[upload('Untouched queued source.')]);
  const active=sources.extract('active',first.sources[0].id);await entered.promise;
  const stageController=new AbortController(),extractController=new AbortController();
  const stage=outcome(sources.stage('queued_upload',[upload('Do not retain this cancelled upload.')],{signal:stageController.signal})),extract=outcome(sources.extract('queued_extract',second.sources[0].id,{signal:extractController.signal}));
  const later=outcome(sources.stage('later',[upload('Runs only after the first extraction drains.')]));
  try{
    stageController.abort();extractController.abort();await turn();
    assert.equal(stage.settled,true,'queued upload must settle while the other extraction remains held');
    assert.equal(extract.settled,true,'queued extraction must settle while the other extraction remains held');
    assert.equal((await stage.result).error.name,'AbortError');assert.equal((await extract.result).error.name,'AbortError');
    assert.equal(later.settled,false,'cancelled callers must not release the shared serialization tail');
    await assert.rejects(fs.stat(path.join(directory,'study-staging','queued_upload')),error=>error.code==='ENOENT');
    await assert.rejects(fs.stat(path.join(directory,'study-staging','later')),error=>error.code==='ENOENT');
    assert.equal((await sources.inspect('queued_extract')).sources[0].status,'staged');
  }finally{release.resolve();await active;await later.result;}
  assert.ok((await later.result).value.sources[0]);
  assert.equal((await sources.inspect('queued_extract')).sources[0].segments.length,0);
  await assert.rejects(fs.stat(path.join(directory,'study-staging','queued_upload')),error=>error.code==='ENOENT');
});

test('active cancellation waits for adapter drain and interruption checkpoint before admitting later work',async t=>{
  const entered=deferred(),aborted=deferred(),drain=deferred(),{directory,sources}=await fixture(t,async(url,{signal})=>{
    entered.resolve();await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve();});
    aborted.resolve();await drain.promise;throw signal.reason;
  });
  const staged=await sources.stage('active',[{url:'https://www.youtube.com/watch?v=abcdefghijk'}]),controller=new AbortController(),active=outcome(sources.extract('active',staged.sources[0].id,{signal:controller.signal}));
  await entered.promise;const later=outcome(sources.stage('later',[upload('A separate bot waits for active cancellation to drain.')]));
  try{
    controller.abort();await aborted.promise;await turn();
    assert.equal(active.settled,false,'active adapter work must drain before its caller rejects');
    assert.equal(later.settled,false,'later work must retain the same serialization owner during drain');
    await assert.rejects(fs.stat(path.join(directory,'study-staging','later')),error=>error.code==='ENOENT');
  }finally{drain.resolve();await active.result;await later.result;}
  assert.equal((await active.result).error.name,'AbortError');
  assert.equal((await sources.inspect('active')).sources[0].status,'interrupted');
  assert.ok((await later.result).value.sources[0]);
});

test('already aborted admission never creates source staging',async t=>{
  const {directory,sources}=await fixture(t,async()=>{assert.fail('An aborted source must not fetch.');}),controller=new AbortController();controller.abort();
  await assert.rejects(sources.stage('never_admitted',[upload('Discard before admission.')],{signal:controller.signal}),error=>error.name==='AbortError');
  await sources.queue;await assert.rejects(fs.stat(path.join(directory,'study-staging')),error=>error.code==='ENOENT');
});
