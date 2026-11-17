/**
 * Per-key concurrency limiter for local model runtimes (docs/plans/local-models-20261117.md, L1/L2).
 * Each key (normally one runtime on this engine's machine) runs at most `limit` calls at once. Interactive calls are
 * admitted before background ones and each priority is first in, first out. Nothing here is persisted or retried.
 */
const PRIORITIES=['interactive','background'];

export class LocalQueue {
  constructor({limit=2}={}) {
    if(!Number.isInteger(limit) || limit<1)throw new TypeError('LocalQueue limit must be a positive whole number.');
    this.limit=limit;this.keys=new Map();
  }
  entry(key) {
    let entry=this.keys.get(key);
    if(!entry){entry={running:0,waiting:{interactive:[],background:[]}};this.keys.set(key,entry);}
    return entry;
  }
  /** Runs fn() when a slot for `key` is free. Interactive requests are admitted before background ones; FIFO within a priority. An aborted signal while waiting rejects with signal.reason and frees nothing (it never held a slot). */
  async run(key,{priority='interactive',signal}={},fn) {
    if(!PRIORITIES.includes(priority))throw new TypeError(`LocalQueue priority must be one of: ${PRIORITIES.join(', ')}.`);
    if(typeof fn!=='function')throw new TypeError('LocalQueue.run needs a function to run.');
    if(signal?.aborted)throw signal.reason ?? new Error('Request cancelled.');
    const entry=this.entry(key);
    if(entry.running<this.limit && !entry.waiting.interactive.length && !entry.waiting.background.length)entry.running++;
    else await new Promise((resolve,reject)=>{
      const waiter={admit:()=>{signal?.removeEventListener('abort',abort);resolve();}},queue=entry.waiting[priority];
      const abort=()=>{const index=queue.indexOf(waiter);if(index<0)return;queue.splice(index,1);this.prune(key);reject(signal.reason ?? new Error('Request cancelled.'));};
      queue.push(waiter);signal?.addEventListener('abort',abort,{once:true});
    });
    try{return await fn();}
    finally{this.release(key);}
  }
  /** Frees one slot and hands it straight to the next waiter, so a slot is never observed free while work waits. */
  release(key) {
    const entry=this.keys.get(key);if(!entry)return;
    const next=entry.waiting.interactive.shift() || entry.waiting.background.shift();
    if(next){next.admit();return;}
    entry.running--;this.prune(key);
  }
  prune(key) {
    const entry=this.keys.get(key);
    if(entry && !entry.running && !entry.waiting.interactive.length && !entry.waiting.background.length)this.keys.delete(key);
  }
  /** {running, waiting:{interactive,background}} for a key */
  stats(key) {
    const entry=this.keys.get(key);
    return {running:entry?.running || 0,waiting:{interactive:entry?.waiting.interactive.length || 0,background:entry?.waiting.background.length || 0}};
  }
}
