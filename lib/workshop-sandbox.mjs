import { Worker } from 'node:worker_threads';
import { ensure, HttpError } from './store.mjs';

let active=0;
export const WORKSHOP_LIMITS=Object.freeze({sourceBytes:32768,jsonBytes:65536,tests:8,timeoutMs:2000,wallMs:8000,memoryBytes:16*1024*1024,concurrency:2,packages:64,proposals:64});
export function boundedJSON(value,limit=WORKSHOP_LIMITS.jsonBytes) {
  let serialized;
  try{serialized=JSON.stringify(value);}catch{throw new HttpError(400,'Supply JSON data.');}
  ensure(typeof serialized==='string' && Buffer.byteLength(serialized)<=limit,413,'JSON data exceeds the workshop limit.');
  return serialized;
}
export async function sandboxTransform(source,input,{signal,timeoutMs=WORKSHOP_LIMITS.timeoutMs}={}) {
  ensure(typeof source==='string' && Buffer.byteLength(source)<=WORKSHOP_LIMITS.sourceBytes,413,'Tool source exceeds 32 KiB.');
  ensure(Number.isInteger(timeoutMs) && timeoutMs>=10 && timeoutMs<=WORKSHOP_LIMITS.timeoutMs,400,'Invalid workshop timeout.');
  const serialized=boundedJSON(input);
  signal?.throwIfAborted();
  ensure(active<WORKSHOP_LIMITS.concurrency,429,'The local workshop is busy. Wait for current tools to finish.');
  active++;
  let worker;
  try {
    worker=new Worker(new URL('./workshop-worker.mjs',import.meta.url),{
      workerData:{source,input:serialized,timeoutMs},execArgv:[],env:{},
      resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:2},
      stdout:true,stderr:true,
    });
    return await new Promise((resolve,reject)=>{
      let settled=false;
      const finish=async(error,value)=>{
        if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
        await worker.terminate();
        if(error)reject(error);else resolve(value);
      };
      const abort=()=>void finish(signal.reason || new HttpError(409,'Workshop execution cancelled.'));
      const timer=setTimeout(()=>void finish(new HttpError(408,'Workshop execution exceeded its wall-time limit.')),WORKSHOP_LIMITS.wallMs);
      worker.once('message',message=>{
        if(!message?.ok)return void finish(new HttpError(422,message?.error || 'Tool failed.'));
        try{ensure(typeof message.output==='string' && Buffer.byteLength(message.output)<=WORKSHOP_LIMITS.jsonBytes,413,'Tool output exceeds the limit.');void finish(null,JSON.parse(message.output));}catch(error){void finish(error);}
      });
      worker.once('error',()=>void finish(new HttpError(422,'The isolated workshop worker failed.')));
      worker.once('exit',()=>{if(!settled)void finish(new HttpError(422,'The isolated worker exited without a result.'));});
      // No wrapper diagnostics are surfaced; bounded draining prevents pipe backpressure.
      let diagnosticBytes=0;
      for(const stream of [worker.stdout,worker.stderr])stream.on('data',chunk=>{diagnosticBytes+=chunk.length;if(diagnosticBytes>4096)void finish(new HttpError(413,'Worker diagnostic limit exceeded.'));});
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
  } finally {active--;}
}
