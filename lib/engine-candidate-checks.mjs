import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';
import { ensure } from './store.mjs';

let active=0;
async function syntax(source,{signal}={}) {
  signal?.throwIfAborted();
  // A fixed syntax-only invocation: no imports, project config, preload or candidate execution.
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','--check'],{env:{},stdio:['pipe','pipe','pipe'],shell:false});
    let failure,bytes=0;
    const abort=()=>{failure=signal.reason || new Error('Cancelled');child.kill('SIGKILL');};
    const timer=setTimeout(()=>{failure=new Error('Syntax check timed out.');child.kill('SIGKILL');},5000);
    signal?.addEventListener('abort',abort,{once:true});
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>8192){failure=new Error('Syntax diagnostic limit exceeded.');child.kill('SIGKILL');}});
    child.stdin.on('error',()=>{});
    child.once('error',error=>{failure=error;});
    child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(failure || code!==0)reject(failure || new Error('JavaScript syntax check failed.'));else resolve();});
    child.stdin.end(source);if(signal?.aborted)abort();
  });
}
async function pureTest(files,test,{signal}={}) {
  signal?.throwIfAborted();
  const worker=new Worker(new URL('./engine-candidate-worker.mjs',import.meta.url),{workerData:{files,test},execArgv:[],env:{},stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:2}});
  return new Promise((resolve,reject)=>{
    let settled=false,bytes=0;
    const finish=async(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);await worker.terminate();error?reject(error):resolve(value);};
    const abort=()=>void finish(signal.reason || new Error('Cancelled'));
    const timer=setTimeout(()=>void finish(new Error('Candidate test timed out.')),8000);
    worker.once('message',message=>{try{ensure(message?.ok&&typeof message.output==='string'&&Buffer.byteLength(message.output)<=65536,422,'Candidate test failed or exceeded its limits.');void finish(null,JSON.parse(message.output));}catch(error){void finish(error);}});
    worker.once('error',()=>void finish(new Error('Candidate worker failed.')));
    worker.once('exit',()=>{if(!settled)void finish(new Error('Candidate worker exited without a result.'));});
    for(const stream of [worker.stdout,worker.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096)void finish(new Error('Candidate diagnostic limit exceeded.'));});
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}
export async function checkEngineCandidate(files,changedPaths,tests,{signal}={}) {
  ensure(active<2,429,'Engine candidate checks are busy. Wait for the current checks.');active++;
  try {
    const checks=[];
    for(const name of changedPaths){signal?.throwIfAborted();try{if(/\.m?js$/.test(name))await syntax(files[name],{signal});else if(name.endsWith('.json'))JSON.parse(files[name]);checks.push({path:name,check:/\.m?js$/.test(name)?'node-syntax':name.endsWith('.json')?'json-parse':'text-only',passed:true});}catch(error){throw new Error(`${name}: ${error.message}`);}}
    const results=[];
    for(const [index,test] of tests.entries()){const actual=await pureTest(files,test,{signal});ensure(isDeepStrictEqual(actual,test.expected),422,`Candidate synthetic test ${index+1} failed.`);results.push({test:index+1,path:test.path,exportName:test.exportName,passed:true});}
    signal?.throwIfAborted();
    return {passed:true,checks,tests:results,runtime:'quickjs-wasm-module-v1',fullSuite:false,build:false,scope:'Syntax/text checks and author-supplied pure-module tests only. No full Engine execution, build, integration tests or security certification.'};
  }finally{active--;}
}
