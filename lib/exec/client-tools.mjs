// Small helpers shared by the Docker and SSH execution backends: find a command-line client and run
// one bounded self-test with it. Engine code only; nothing here comes from a bot, a workspace or a model.
import { promises as fs, constants as FS } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

/** First executable file called one of `names` in `dirs` (in that order), or null. */
export async function findExecutable(names,dirs) {
  for(const dir of dirs)for(const name of names) {
    if(!path.isAbsolute(dir))continue;
    const candidate=path.join(dir,name);
    try{await fs.access(candidate,FS.X_OK);if((await fs.stat(candidate)).isFile())return candidate;}catch{}
  }
  return null;
}

/** Directories from a PATH value (absolute entries only) followed by the usual install locations. */
export function searchDirectories(pathValue,extra) {
  const listed=String(pathValue || '').split(path.delimiter).filter(Boolean);
  return [...new Set([...listed,...extra])];
}

/**
 * Runs `executable args` without a shell, stdin closed, and resolves {ok, code, stdout, stderr, timedOut}.
 * Never rejects. The child is killed when it does not exit within `timeoutMs`.
 */
export function runProbe(executable,args,{env,timeoutMs=5000}={}) {
  return new Promise(resolve=>{
    let stdout='',stderr='',settled=false,timedOut=false,child;
    const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);resolve({stdout,stderr,timedOut,...result});};
    const timer=setTimeout(()=>{timedOut=true;try{child?.kill('SIGKILL');}catch{}finish({ok:false,code:null});},timeoutMs);timer.unref();
    try{child=spawn(executable,args,{shell:false,stdio:['ignore','pipe','pipe'],env});}catch(error){finish({ok:false,code:null,error:error.code || 'error'});return;}
    child.stdout.on('data',chunk=>{if(stdout.length<2000)stdout+=chunk.toString('utf8');});
    child.stderr.on('data',chunk=>{if(stderr.length<2000)stderr+=chunk.toString('utf8');});
    child.once('error',error=>finish({ok:false,code:null,error:error.code || 'error'}));
    child.once('exit',code=>finish({ok:code===0,code}));
  });
}

/** First non-empty line of a client's complaint, bounded, for a one-sentence reason. */
export const firstLine=text=>String(text || '').split('\n').map(line=>line.trim()).find(Boolean)?.slice(0,200) || '';
