// Trusted wrapper only. Guest source runs inside QuickJS/Wasm, never in Node eval/vm.
import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';

const {source,input,timeoutMs}=workerData;
let runtime,context;
try {
  const quickjs=await getQuickJS();
  runtime=quickjs.newRuntime();
  runtime.setMemoryLimit(16*1024*1024);
  runtime.setMaxStackSize(256*1024);
  const deadline=Date.now()+timeoutMs;
  runtime.setInterruptHandler(()=>Date.now()>=deadline);
  context=runtime.newContext();
  // No host functions, module loader, WASI, credentials, filesystem or network imports.
  // Serialize inside the guest so hostile getters/toJSON remain under its interrupt/memory budget.
  const result=context.evalCode(`"use strict";\nconst input=JSON.parse(${JSON.stringify(input)});\nconst transform=(${source}\n);\nconst output=transform(input);\nif (output && typeof output.then === 'function') throw new Error('Return synchronous JSON, not a Promise.');\nconst serialized=JSON.stringify(output);\nif (typeof serialized !== 'string' || serialized.length>65536) throw new Error('Return JSON within 65536 characters.');\nserialized;`,'workshop.js');
  if(result.error){result.error.dispose();throw new Error('The tool failed, exceeded its memory/time limit, or returned invalid JSON.');}
  const output=context.getString(result.value);result.value.dispose();
  if(Buffer.byteLength(output)>65536)throw new Error('Tool output exceeds 64 KiB.');
  parentPort.postMessage({ok:true,output});
} catch(error) {
  // Never dump guest errors into the host: getters and huge/cyclic structures are untrusted.
  parentPort.postMessage({ok:false,error:String(error.message || 'Tool execution failed.').slice(0,300)});
} finally {
  context?.dispose();runtime?.dispose();
}
