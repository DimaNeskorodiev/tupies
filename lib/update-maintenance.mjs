import {randomBytes} from 'node:crypto';
import {ensure} from './store.mjs';

/** Engine-local operator authority. Never stored in workspace state or exposed to models. */
export class UpdateMaintenance {
  constructor({busy,held=false,clock=Date.now}={}) {this.busy=busy;this.held=held;this.clock=clock;this.lease=null;}
  get paused() {
    if(this.lease && this.lease.expires<=this.clock())this.lease=null;
    return this.held || !!this.lease;
  }
  assertAdmission() {ensure(!this.paused,503,'Tupies is preparing an update. Try again after it reconnects.');}
  status() {return {protocol:1,pid:process.pid,held:this.held,paused:this.paused,busy:!!this.busy()};}
  claim() {
    ensure(!this.paused,409,'Another update is already being prepared.');
    // Claim only an idle engine. Existing families/rooms keep admitting their children until idle.
    if(this.busy())return {...this.status(),ready:false};
    this.lease={token:randomBytes(32).toString('hex'),expires:this.clock()+120_000};
    return {...this.status(),ready:true,token:this.lease.token};
  }
  release(token) {
    void this.paused;
    ensure(this.lease && token===this.lease.token,409,'This update reservation expired or changed.');
    this.lease=null;return this.status();
  }
  activate() {ensure(this.held,409,'This engine is not awaiting update acceptance.');this.held=false;return this.status();}
}
