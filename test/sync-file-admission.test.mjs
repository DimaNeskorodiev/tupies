import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../lib/store.mjs';
import {Sync} from '../lib/sync/index.mjs';
import {Clock} from '../lib/sync/clock.mjs';
const key='file:workspaces/bot_atlas/brain/note.md',hash=value=>createHash('sha256').update(value).digest('hex'),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(predicate){const until=Date.now()+4000;while(Date.now()<until){if(await predicate())return;await delay(5);}throw new Error('File admission fixture timed out.');}
async function fixture(t){const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-file-admission-')),store=await new Store(directory).init(),sync=await new Sync(store,{engineName:'Fixture engine',logErrors:false,fileScanInterval:60_000}).init(),file=path.join(directory,'workspaces/bot_atlas/brain/note.md');await fs.mkdir(path.dirname(file),{recursive:true});t.after(async()=>{await sync.close();await fs.rm(directory,{recursive:true,force:true});});return {directory,store,sync,file};}
async function change(sync,text,base){const bytes=Buffer.from(text),sha=hash(bytes);await sync.files.stageBlob(sha,bytes);return {k:key,v:{sha,size:bytes.length},h:new Clock('node_remote',()=>Date.now()+1000).now(),o:'node_remote',...(base?{b:base}:{})};}

test('unscanned owner bytes survive a remote edit based on the previously advertised version',async t=>{
  const f=await fixture(t);await fs.writeFile(f.file,'Version A.');await f.sync.scan();const base=f.sync.meta.docs[key].h;await fs.writeFile(f.file,'Unscanned owner version B.');const incoming=await change(f.sync,'Remote version C.',base);await f.sync.applyRemote([incoming]);assert.equal(await fs.readFile(f.file,'utf8'),'Remote version C.');const copies=(await fs.readdir(path.dirname(f.file))).filter(name=>name.includes('(conflict '));assert.equal(copies.length,1);assert.equal(await fs.readFile(path.join(path.dirname(f.file),copies[0]),'utf8'),'Unscanned owner version B.');await f.sync.scan();const copyKey='file:workspaces/bot_atlas/brain/'+copies[0];assert.equal(f.sync.meta.docs[copyKey].d,hash('Unscanned owner version B.'));assert.equal(f.sync.meta.docs[copyKey].o,f.sync.nodeId);
});

test('an untracked local file is preserved before a new remote file takes its path',async t=>{
  const f=await fixture(t);assert.equal(f.sync.meta.docs[key],undefined);await fs.writeFile(f.file,'New local owner file.');await f.sync.applyRemote([await change(f.sync,'New remote file.')]);const copies=(await fs.readdir(path.dirname(f.file))).filter(name=>name.includes('(conflict '));assert.equal(copies.length,1);assert.equal(await fs.readFile(path.join(path.dirname(f.file),copies[0]),'utf8'),'New local owner file.');assert.equal(await fs.readFile(f.file,'utf8'),'New remote file.');
});

test('remote deletion cannot erase an unscanned local edit and advertises its actual retained hash',async t=>{
  const f=await fixture(t);await fs.writeFile(f.file,'Version A.');await f.sync.scan();const base=f.sync.meta.docs[key].h;await fs.writeFile(f.file,'Retained owner version B.');const removal={k:key,v:null,h:new Clock('node_remote',()=>Date.now()+1000).now(),o:'node_remote',b:base};await f.sync.applyRemote([removal]);assert.equal(await fs.readFile(f.file,'utf8'),'Retained owner version B.');assert.equal(f.sync.meta.docs[key].d,hash('Retained owner version B.'));assert.equal(f.sync.meta.docs[key].o,f.sync.nodeId);
});

test('failed conflict preservation leaves the current file and remote document stamp untouched',async t=>{
  const f=await fixture(t);await fs.writeFile(f.file,'Version A.');await f.sync.scan();const original=structuredClone(f.sync.meta.docs[key]);await fs.writeFile(f.file,'Unscanned owner B.');f.sync.files.conflictCopy=async()=>{throw new Error('Fixture full disk');};await assert.rejects(f.sync.applyRemote([await change(f.sync,'Remote C.',original.h)]),/full disk/);assert.equal(await fs.readFile(f.file,'utf8'),'Unscanned owner B.');assert.deepEqual(f.sync.meta.docs[key],original);
});

test('a false file apply never acknowledges its document or pull cursor; retry applies the same version once',async t=>{
  const f=await fixture(t);await fs.writeFile(f.file,'Version A.');await f.sync.scan();const original=structuredClone(f.sync.meta.docs[key]),incoming=await change(f.sync,'Remote C.',original.h),apply=f.sync.files.apply.bind(f.sync.files);f.sync.files.apply=async()=>false;f.sync.meta.cursor=7;f.sync.config.hub={protocol:2,nodeId:'node_remote',name:'Fixture home'};
  const peer={stopped:false,controller:new AbortController()};f.sync.request=async()=>({node:'node_remote',seq:99,changes:[incoming]});const first=f.sync.pullLoop(peer);try{await eventually(()=>f.sync.peerStatus.error);assert.equal(f.sync.meta.cursor,7);assert.deepEqual(f.sync.meta.docs[key],original);assert.equal(await fs.readFile(f.file,'utf8'),'Version A.');}finally{peer.stopped=true;peer.controller.abort();await first;}
  f.sync.files.apply=apply;const retry={stopped:false,controller:new AbortController()};let requests=0;f.sync.request=async()=>{if(++requests>1){retry.stopped=true;return {node:'node_remote',seq:99,changes:[]};}return {node:'node_remote',seq:99,changes:[incoming]};};await f.sync.pullLoop(retry);assert.equal(f.sync.meta.cursor,99);assert.equal(f.sync.meta.docs[key].h,incoming.h);assert.equal(await fs.readFile(f.file,'utf8'),'Remote C.');assert.equal((await fs.readdir(path.dirname(f.file))).some(name=>name.includes('(conflict ')),false);
});
