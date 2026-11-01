// Trusted wrapper. Candidate modules execute only in QuickJS/Wasm.
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { getQuickJS } from 'quickjs-emscripten';

let runtime,context;
try {
  const {files,test}=workerData;
  runtime=(await getQuickJS()).newRuntime();
  runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(256*1024);
  const deadline=Date.now()+2000;
  runtime.setInterruptHandler(()=>Date.now()>=deadline);
  runtime.setModuleLoader(name=>{
    if(!Object.hasOwn(files,name))throw new Error('Module is not in the candidate snapshot.');
    return files[name];
  },(base,name)=>{
    if(!name.startsWith('./')&&!name.startsWith('../'))throw new Error('Only relative candidate imports are supported.');
    const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(base),name));
    if(!Object.hasOwn(files,resolved))throw new Error('Module is not in the candidate snapshot.');
    return resolved;
  });
  context=runtime.newContext();
  const program=`import * as subject from ${JSON.stringify('./'+test.path)};\nconst value=subject[${JSON.stringify(test.exportName)}](JSON.parse(${JSON.stringify(JSON.stringify(test.input))}));\nif(value && typeof value.then==='function')throw new Error('Synchronous exports only');\nglobalThis.__candidate_result=JSON.stringify(value);`;
  const evaluated=context.evalCode(program,'candidate-test.mjs',{type:'module'});
  if(evaluated.error){evaluated.error.dispose();throw new Error('Candidate test failed.');}
  evaluated.value.dispose();
  const output=context.evalCode('if(typeof __candidate_result!=="string" || __candidate_result.length>65536)throw new Error("Invalid result"); __candidate_result;');
  if(output.error){output.error.dispose();throw new Error('Candidate test did not produce synchronous JSON.');}
  const serialized=context.getString(output.value);output.value.dispose();
  if(Buffer.byteLength(serialized)>65536)throw new Error('Candidate output exceeds its limit.');
  parentPort.postMessage({ok:true,output:serialized});
}catch{parentPort.postMessage({ok:false,error:'Candidate test failed, used an unavailable import, returned asynchronous data or exceeded its resource limits.'});}
finally{context?.dispose();runtime?.dispose();}
