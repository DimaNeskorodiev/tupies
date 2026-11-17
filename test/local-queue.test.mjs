import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalQueue} from '../lib/local-queue.mjs';

function gate(){let open;const opened=new Promise(resolve=>{open=resolve;});return {opened,open};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('a key never runs more than its limit at once',async()=>{
  const queue=new LocalQueue({limit:2}),gates=[gate(),gate(),gate(),gate()];let active=0,peak=0;
  const runs=gates.map((g,index)=>queue.run('mlx',{},async()=>{active++;peak=Math.max(peak,active);await g.opened;active--;return index;}));
  await tick();
  assert.deepEqual(queue.stats('mlx'),{running:2,waiting:{interactive:2,background:0}});
  for(const g of gates)g.open();
  assert.deepEqual(await Promise.all(runs),[0,1,2,3]);
  assert.equal(peak,2);
  assert.deepEqual(queue.stats('mlx'),{running:0,waiting:{interactive:0,background:0}});
});

test('interactive work is admitted before background work, first in first out within a priority',async()=>{
  const queue=new LocalQueue({limit:1}),first=gate(),order=[];
  const held=queue.run('mlx',{},()=>first.opened);
  const runs=[['b1','background'],['i1','interactive'],['b2','background'],['i2','interactive']]
    .map(([name,priority])=>queue.run('mlx',{priority},async()=>{order.push(name);}));
  await tick();
  assert.deepEqual(queue.stats('mlx'),{running:1,waiting:{interactive:2,background:2}});
  first.open();await held;await Promise.all(runs);
  assert.deepEqual(order,['i1','i2','b1','b2']);
});

test('aborting while waiting rejects with the exact reason and never takes or frees a slot',async()=>{
  const queue=new LocalQueue({limit:1}),first=gate(),controller=new AbortController(),reason=new Error('Synthetic owner stop.');let ran=false;
  const held=queue.run('mlx',{},()=>first.opened);
  const waiting=queue.run('mlx',{signal:controller.signal},async()=>{ran=true;});
  const after=queue.run('mlx',{priority:'background'},async()=>'after');
  await tick();
  controller.abort(reason);
  await assert.rejects(waiting,error=>error===reason);
  assert.deepEqual(queue.stats('mlx'),{running:1,waiting:{interactive:0,background:1}});
  first.open();await held;
  assert.equal(await after,'after');assert.equal(ran,false);
  assert.deepEqual(queue.stats('mlx'),{running:0,waiting:{interactive:0,background:0}});
});

test('an already aborted signal rejects before queueing',async()=>{
  const queue=new LocalQueue(),controller=new AbortController(),reason=new Error('Synthetic early stop.');
  controller.abort(reason);let ran=false;
  await assert.rejects(queue.run('mlx',{signal:controller.signal},async()=>{ran=true;}),error=>error===reason);
  assert.equal(ran,false);assert.deepEqual(queue.stats('mlx'),{running:0,waiting:{interactive:0,background:0}});
});

test('an abort after admission does not affect the running call',async()=>{
  const queue=new LocalQueue({limit:1}),controller=new AbortController();
  const result=await queue.run('mlx',{signal:controller.signal},async()=>{controller.abort(new Error('late'));await tick();return 'done';});
  assert.equal(result,'done');assert.deepEqual(queue.stats('mlx'),{running:0,waiting:{interactive:0,background:0}});
});

test('errors from fn propagate and always release the slot',async()=>{
  const queue=new LocalQueue({limit:1}),failure=new Error('Synthetic runtime failure.');
  const failing=queue.run('mlx',{},async()=>{await tick();throw failure;});
  const syncFailing=queue.run('mlx',{},()=>{throw failure;});
  const next=queue.run('mlx',{},async()=>'next');
  await assert.rejects(failing,error=>error===failure);
  await assert.rejects(syncFailing,error=>error===failure);
  assert.equal(await next,'next');
  assert.deepEqual(queue.stats('mlx'),{running:0,waiting:{interactive:0,background:0}});
});

test('keys are independent',async()=>{
  const queue=new LocalQueue({limit:1}),held=gate();
  const mlx=queue.run('mlx',{},()=>held.opened);
  assert.equal(await queue.run('ollama',{},async()=>'ollama'),'ollama');
  assert.deepEqual(queue.stats('mlx'),{running:1,waiting:{interactive:0,background:0}});
  assert.deepEqual(queue.stats('ollama'),{running:0,waiting:{interactive:0,background:0}});
  held.open();await mlx;
});

test('invalid limits and priorities are refused',async()=>{
  assert.throws(()=>new LocalQueue({limit:0}),TypeError);
  assert.throws(()=>new LocalQueue({limit:1.5}),TypeError);
  await assert.rejects(new LocalQueue().run('mlx',{priority:'urgent'},async()=>{}),TypeError);
  assert.equal(new LocalQueue().limit,2);
});
