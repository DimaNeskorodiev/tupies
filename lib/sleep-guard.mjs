import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Keeps a Mac awake while it runs a local model request (docs/plans/local-models-20261117.md, L2 item 10).
 *
 * While at least one local inference request or relayed job runs on this engine, one `/usr/bin/caffeinate -i -w <pid>`
 * holds a macOS idle-sleep assertion. `-w` ties it to the engine process, so it ends with the engine even after a crash.
 * The assertion is released a grace period after the last request finishes, so back-to-back steps do not respawn it.
 *
 * It only prevents idle sleep. A closed lid on battery, or the owner choosing Sleep, still sleeps the Mac; the home server
 * then reports `node_offline` / `node_lost` and the bot's fallback model answers. Elsewhere (Linux, no caffeinate) it
 * does nothing. Nothing here is persisted.
 */
export const CAFFEINATE='/usr/bin/caffeinate';
export const SLEEP_GRACE_MS=30_000;

export class SleepGuard {
  /** Options exist for tests: platform, spawn, exists, pid, graceMs. */
  constructor({platform=process.platform,spawn=spawnProcess,exists=existsSync,pid=process.pid,graceMs=SLEEP_GRACE_MS}={}) {
    this.platform=platform;this.spawn=spawn;this.exists=exists;this.pid=pid;this.graceMs=graceMs;
    this.count=0;this.child=null;this.timer=null;this.available=undefined;this.closed=false;
  }
  /** Only a Mac with the system caffeinate tool; checked once. */
  get supported() {
    if(this.available===undefined){try{this.available=this.platform==='darwin' && !!this.exists(CAFFEINATE);}catch{this.available=false;}}
    return this.available;
  }
  get holding(){return !!this.child;}
  /** Marks one request as running. Returns a release function that is safe to call more than once. */
  acquire() {
    if(this.closed || !this.supported)return ()=>{};
    this.count++;clearTimeout(this.timer);this.timer=null;
    if(!this.child)this.start();
    let released=false;
    return ()=>{if(released)return;released=true;this.release();};
  }
  /** Runs fn while holding the assertion. */
  async hold(fn){const release=this.acquire();try{return await fn();}finally{release();}}
  release() {
    this.count=Math.max(0,this.count-1);
    if(this.count || this.timer)return;
    this.timer=setTimeout(()=>{this.timer=null;if(!this.count)this.stop();},this.graceMs);this.timer.unref?.();
  }
  start() {
    let child;
    try{child=this.spawn(CAFFEINATE,['-i','-w',String(this.pid)],{stdio:'ignore'});}catch{return;}
    if(!child)return;
    this.child=child;
    // A failed or ended caffeinate is simply gone; the next request starts a new one.
    child.on?.('error',()=>{if(this.child===child)this.child=null;});
    child.on?.('exit',()=>{if(this.child===child)this.child=null;});
    // It must never keep the engine process alive on its own.
    child.unref?.();
  }
  stop() {
    const child=this.child;this.child=null;
    if(child){try{child.kill('SIGTERM');}catch{}}
  }
  close(){this.closed=true;clearTimeout(this.timer);this.timer=null;this.count=0;this.stop();}
}
