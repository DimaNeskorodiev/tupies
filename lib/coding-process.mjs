import { fork } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { ensure } from './store.mjs';

const supervisor=fileURLToPath(new URL('./process-supervisor.mjs',import.meta.url));
/** Trusted, already approved host execution. The guardian kills ordinary descendants on host loss. */
export async function codingCommand({executable,args,cwd,env,signal,timeoutMs=120000,maxBytes=1000000}) {
  signal?.throwIfAborted();
  ensure(typeof executable==='string' && Array.isArray(args),400,'Use a literal coding command.');
  return new Promise((resolve,reject)=>{
    const child=fork(supervisor,[],{cwd,env,execArgv:[],detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc']});
    let output='',bytes=0,result=null,failure=null,settled=false;const captured={stdout:'',stderr:''};
    const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
    const stop=()=>{if(child.connected)try{child.send({type:'stop'});}catch{}};
    const abort=()=>{failure=signal.reason || new Error('Coding command cancelled.');stop();};
    const timer=setTimeout(()=>{failure=new Error('Coding command reached its time limit.');stop();},timeoutMs);timer.unref();
    signal?.addEventListener('abort',abort,{once:true});
    for(const stream of ['stdout','stderr'])child[stream].on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){failure=new Error('Coding command exceeded its output limit.');stop();return;}const text=decoders[stream].write(chunk);output+=text;captured[stream]+=text;});
    child.on('message',message=>{if(message?.type==='exited')result={exitCode:message.exitCode,signal:message.signal};if(message?.type==='start_error')failure=new Error(`Coding command could not start (${String(message.code).slice(0,50)}).`);});
    child.once('spawn',()=>{if(signal?.aborted){abort();return;}child.send({type:'start',executable,args});});
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error || failure || !result){reject(error || failure || new Error('Coding command ended without a confirmed result.'));return;}for(const [stream,decoder] of Object.entries(decoders)){const text=decoder.end();output+=text;captured[stream]+=text;}resolve({...result,output,...captured});};
    child.once('error',finish);child.once('close',()=>finish());
    child.once('exit',()=>{const timer=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();},1000);timer.unref();child.once('close',()=>clearTimeout(timer));});
  });
}
