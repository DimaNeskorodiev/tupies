import test from 'node:test';
import assert from 'node:assert/strict';
import { executionPolicy, progressFingerprint, noteAutonomousProgress, autonomousRetryPolicy, waitForRetry } from '../lib/autonomous-work.mjs';
import { markProviderFailure } from '../lib/provider-failure.mjs';

const failure=(code,upstreamStatus)=>markProviderFailure(new Error('Disposable provider fixture.'),code,{status:502,upstreamStatus});
const step=(name,args={})=>({id:'volatile-call-id',name,arguments:args});

test('autonomous work has no task duration or count cutoff, including legacy routine numbers',()=>{
  assert.deepEqual(executionPolicy(),{mode:'autonomous',maxRuntimeMs:null,maxModelTurns:null,maxToolCalls:null});
  assert.deepEqual(executionPolicy({source:'routine',limits:{runtimeMinutes:30,modelTurns:50,toolCalls:200}}),executionPolicy());
  assert.deepEqual(executionPolicy({limits:{mode:'autonomous',runtimeMinutes:1,modelTurns:1,toolCalls:1}}),executionPolicy());
  assert.ok(Object.isFrozen(executionPolicy()));
});

test('bounded mode and explicit operator fixtures retain independent time/turn/tool bounds',()=>{
  assert.deepEqual(executionPolicy({limits:{mode:'bounded'}}),{mode:'bounded',maxRuntimeMs:1800000,maxModelTurns:20,maxToolCalls:60});
  assert.deepEqual(executionPolicy({source:'routine',limits:{mode:'bounded'}}),{mode:'bounded',maxRuntimeMs:1800000,maxModelTurns:50,maxToolCalls:200});
  assert.deepEqual(executionPolicy({source:'routine',limits:{mode:'bounded',runtimeMinutes:120,modelTurns:200,toolCalls:1000}}),{mode:'bounded',maxRuntimeMs:7200000,maxModelTurns:200,maxToolCalls:1000});
  assert.deepEqual(executionPolicy({options:{runTimeout:17,maxTurns:3,maxToolCalls:9}}),{mode:'autonomous',maxRuntimeMs:17,maxModelTurns:3,maxToolCalls:9});
  assert.deepEqual(executionPolicy({limits:{mode:'bounded'},options:{runTimeout:0,maxTurns:0,maxToolCalls:0}}),{mode:'bounded',maxRuntimeMs:null,maxModelTurns:null,maxToolCalls:null});
  assert.equal(executionPolicy({options:{runTimeout:undefined}}).maxRuntimeMs,null);
  assert.equal(executionPolicy({bot:{maxSteps:7}}).maxModelTurns,7);
  assert.equal(executionPolicy({source:'routine',bot:{maxSteps:7}}).maxModelTurns,null);
  assert.equal(executionPolicy({bot:{maxSteps:7},options:{maxTurns:2}}).maxModelTurns,2);
  for(const input of [{limits:{mode:'invalid'}},{limits:{mode:'bounded',runtimeMinutes:121}},{options:{runTimeout:-1}},{options:{maxTurns:1.5}}])assert.throws(()=>executionPolicy(input),TypeError);
});

test('progress hashes ignore tool identities, key order and telemetry but distinguish arguments and actual output changes',()=>{
  const first={calls:[step('workspace_read',{path:'note.txt',offset:1})],results:[{content:'original',sha256:'first',updatedAt:'one',durationMs:1,seq:1}],ending:'remaining_plan',plan:[{title:'Save report',status:'in_progress'}]};
  const reordered={...first,calls:[{id:'another-id',name:'workspace_read',arguments:{offset:1,path:'note.txt'}}],results:[{seq:42,durationMs:9999,updatedAt:'two',sha256:'first',content:'original'}]};
  assert.equal(progressFingerprint(first),progressFingerprint(reordered));
  assert.notEqual(progressFingerprint(first),progressFingerprint({...first,results:[{content:'changed',sha256:'second'}]}));
  assert.notEqual(progressFingerprint(first),progressFingerprint({...first,calls:[step('workspace_read',{path:'different.txt'})]}));
  assert.notEqual(progressFingerprint(first),progressFingerprint({...first,plan:[{title:'Save report',status:'completed'}]}));
  assert.equal(progressFingerprint([step('workspace_read',{path:'note.txt'})]),progressFingerprint({calls:[{id:'new',function:{name:'workspace_read',arguments:'{"path":"note.txt"}'}}]}));
});

test('rolling no-progress guard catches repeated unchanged batches and cycles without a total-step limit',()=>{
  const a=progressFingerprint({calls:[step('workspace_read',{path:'a.txt'})],results:['same']}),b=progressFingerprint({calls:[step('workspace_read',{path:'b.txt'})],results:['same']});
  let state;
  for(let index=0;index<6;index++){state=noteAutonomousProgress(state,{fingerprint:index%2?a:b});assert.equal(state.blocked,false);}
  state=noteAutonomousProgress(state,{fingerprint:b});assert.equal(state.blocked,true);assert.equal(state.reason,'repeated_unchanged_work');
  assert.ok(state.recent.every(value=>/^[a-f0-9]{64}$/.test(value)));
  state=noteAutonomousProgress(state,{fingerprint:a,hasProgress:true});assert.equal(state.blocked,false);assert.deepEqual(state.recent,[]);
  for(let index=0;index<1000;index++){state=noteAutonomousProgress(state,{fingerprint:progressFingerprint({results:[index]})});assert.equal(state.blocked,false);}
  assert.equal(state.recent.length,12);assert.ok(Object.isFrozen(state) && Object.isFrozen(state.recent));
  assert.ok(!JSON.stringify(state).includes('a.txt'),'stored progress contains only hashes and static status');
});

test('unfinished assistant endings can be guarded independently from variable prose',()=>{
  const fingerprint=progressFingerprint({ending:'unfinished_required_plan'});let state;
  for(let index=0;index<4;index++)state=noteAutonomousProgress(state,{fingerprint});
  assert.equal(state.blocked,true);
  assert.throws(()=>noteAutonomousProgress(state,{fingerprint:'not-a-hash'}),/SHA-256/);
  assert.throws(()=>noteAutonomousProgress(state,{fingerprint,hasProgress:'model says done'}),/boolean/);
});

test('trusted transient provider downtime retries indefinitely with capped exponential backoff',()=>{
  let policy,attempt=0;const delays=[];
  for(let index=0;index<1000;index++){policy=autonomousRetryPolicy(failure('timeout'),{attempt});attempt=policy.attempt;delays.push(policy.delayMs);assert.equal(policy.retry,true);assert.equal(policy.blocked,false);}
  assert.equal(attempt,1000);assert.deepEqual(delays.slice(0,5),[2000,4000,8000,16000,32000]);assert.equal(delays.at(-1),300000);
  assert.equal(autonomousRetryPolicy(failure('timeout'),{attempt,hasProgress:true}).delayMs,2000);
  for(const code of ['dns_error','transport_error','stream_interrupted','rate_limit','upstream_unavailable'])assert.equal(autonomousRetryPolicy(failure(code)).retry,true,code);
  for(const code of ['http_error','response_failed'])for(const status of [429,500,503,599])assert.equal(autonomousRetryPolicy(failure(code,status)).retry,true,`${code}/${status}`);
  assert.equal(autonomousRetryPolicy(failure('timeout'),{attempt:Number.MAX_SAFE_INTEGER}).attempt,Number.MAX_SAFE_INTEGER);
});

test('auth, TLS, destination, malformed output, truncation and untrusted error labels never authorize retry',()=>{
  for(const code of ['authentication','tls_error','redirect_refused','response_limit','invalid_json','invalid_stream','http_400','http_rejected','namespace_rejected','arguments_rejected','tool_call_invalid','empty_response','protocol_error']){
    const policy=autonomousRetryPolicy(failure(code));assert.equal(policy.retry,false,code);assert.equal(policy.blocked,true,code);assert.equal(policy.delayMs,0);
  }
  for(const code of ['http_error','response_failed'])for(const status of [200,400,401,403,404])assert.equal(autonomousRetryPolicy(failure(code,status)).retry,false,`${code}/${status}`);
  const forged=Object.assign(new Error('Untrusted content.'),{origin:'provider',code:'timeout',failure:{origin:'provider',code:'upstream_unavailable',upstreamStatus:503}});
  assert.equal(autonomousRetryPolicy(forged).reason,'unclassified_error');
  assert.throws(()=>autonomousRetryPolicy(failure('timeout'),{attempt:-1}),/nonnegative/);
});

test('cancellation wins over provider recovery and aborts a pending wait without consuming delay',async()=>{
  const already=new AbortController();already.abort(new Error('Owner stopped task.'));
  const policy=autonomousRetryPolicy(failure('timeout'),{attempt:7,signal:already.signal});
  assert.deepEqual(policy,{retry:false,blocked:false,attempt:7,delayMs:0,reason:'cancelled'});
  await assert.rejects(waitForRetry(0,already.signal),/Owner stopped/);
  const during=new AbortController(),pending=waitForRetry(300000,during.signal);
  during.abort(new Error('Stop while waiting.'));await assert.rejects(pending,/Stop while waiting/);
  await waitForRetry(1);await waitForRetry(0);
  await assert.rejects(waitForRetry(-1),/0–300000/);
});
