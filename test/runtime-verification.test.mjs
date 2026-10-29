import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('disposable runtime verification exercises complete restore, concurrent work and abrupt host loss without replay',async()=>{
  const script=fileURLToPath(new URL('../scripts/verify-runtime.mjs',import.meta.url));
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,'--state-mib','1','--batches','1'],{stdio:['ignore','pipe','pipe']}),out=[],errors=[];
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Runtime verification exceeded the test deadline.'));},45_000);
    child.stdout.on('data',chunk=>out.push(chunk));child.stderr.on('data',chunk=>errors.push(chunk));child.once('error',reject);
    child.once('exit',code=>{clearTimeout(timer);if(code!==0)return reject(new Error(Buffer.concat(errors).toString().slice(0,2000)||'Runtime verification failed.'));try{resolve(JSON.parse(Buffer.concat(out).toString()));}catch(error){reject(error);}});
  });
  assert.equal(result.passed,true);assert.equal(result.sourceStable,true);assert.equal(result.load.completedTasks,4);assert.equal(result.load.concurrency,4);assert.ok(result.load.stateBytes>=1024**2);
  assert.equal(result.backup.fullTreeVerified,true);assert.equal(result.backup.credentialsVerified,true);assert.equal(result.backup.privateModesVerified,true);
  assert.equal(result.hostLoss.providerCalls,0);assert.equal(result.hostLoss.receiptPreventedReplay,true);assert.equal(result.hostLoss.partialRetained,true);assert.equal(result.hostLoss.unapprovedFileAbsent,true);
  assert.deepEqual(result.hostLoss.recoveredStatuses,['interrupted','interrupted']);assert.equal(result.limits.realProvider,false);assert.equal(result.limits.externalNetwork,false);assert.equal(result.limits.liveData,false);
});
