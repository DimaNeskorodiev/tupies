import { promises as fs, constants as FS } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensure, atomicWrite, id, now } from './store.mjs';
import { safePath, groupsFor } from './agent-tools.mjs';

const terminal=new Set(['completed','failed','cancelled','interrupted','unknown']);
const validId=value=>typeof value==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const digest=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
/** Engine-local owner grants. This ledger is never a synced document or a model tool. */
export class WorkshopGrants {
  constructor(engine){this.engine=engine;this.store=engine.store;this.epoch=randomUUID();this.queue=Promise.resolve();this.active=new Map();this.disabled=new Map();this.closed=false;}
  serial(fn){const next=this.queue.catch(()=>{}).then(fn);this.queue=next.catch(()=>{});return next;}
  async file(){return safePath(this.store.directory,'workshop-grants.json',{allowMissing:true});}
  async read(){
    let handle;try{handle=await fs.open(await this.file(),FS.O_RDONLY|FS.O_NOFOLLOW);}catch(error){if(error.code==='ENOENT')return [];throw error;}
    try{const stat=await handle.stat();ensure(stat.isFile()&&stat.size<=2_000_000,409,'The workshop grant ledger is invalid.');const data=JSON.parse(await handle.readFile('utf8'));
      ensure(data.version===1 && Array.isArray(data.grants) && data.grants.length<=128,409,'The workshop grant ledger is invalid.');
      for(const g of data.grants)ensure(validId(g.id)&&validId(g.ownerBotId)&&validId(g.rootRunId)&&digest(g.scopeIdentity)&&Array.isArray(g.botIds)&&g.botIds.length<=20&&g.botIds.every(validId)&&Number.isSafeInteger(g.maxRequests)&&g.maxRequests>=1&&g.maxRequests<=100&&Number.isSafeInteger(g.used)&&g.used>=0&&g.used<=g.maxRequests&&Array.isArray(g.attempts)&&g.attempts.length===g.used&&Number.isFinite(g.expiresAt)&&Number.isInteger(g.intervalMs)&&g.intervalMs>=0&&['pending','active','revoked','blocked'].includes(g.status),409,'The workshop grant ledger is damaged; no requests were authorized.');
      return data.grants;
    }finally{await handle.close();}
  }
  async save(grants){let bytes=JSON.stringify({version:1,grants});while(Buffer.byteLength(bytes)>2_000_000){const index=grants.findIndex((g,i)=>i<grants.length-1&&!['active','pending'].includes(this.status(g))&&!this.active.has(g.id));ensure(index>=0,413,'The grant ledger is full; no further request was authorized.');this.disabled.delete(grants[index].id);grants.splice(index,1);bytes=JSON.stringify({version:1,grants});}await atomicWrite(await this.file(),bytes);}
  root(context){const rootRunId=context.delegation?.rootRunId || context.runId,run=Object.values(this.store.state.runs || {}).find(item=>item.id===rootRunId);ensure(!this.closed && run && !terminal.has(run.status) && !run.stopRequested && this.engine.controllers.has(rootRunId),409,'The grant belongs to an inactive task.');this.engine.assertRunning(context);return rootRunId;}
  status(g){if(this.disabled.has(g.id))return this.disabled.get(g.id);if(!['pending','active'].includes(g.status))return g.status;if(g.epoch!==this.epoch || this.closed)return 'interrupted';if(g.expiresAt<=Date.now())return 'expired';const root=Object.values(this.store.state.runs || {}).find(run=>run.id===g.rootRunId);if(!root || terminal.has(root.status)||root.stopRequested||!this.engine.controllers.has(g.rootRunId))return 'task-ended';if(g.status==='pending')return 'pending';if(g.attempts.some(a=>a.status==='reserved')&&!this.active.has(g.id))return 'blocked';return g.used>=g.maxRequests?'exhausted':'active';}
  offer(context,args){this.root(context);return {maxRequests:100,maxMinutes:60,participants:this.store.state.bots.filter(bot=>bot.enabled!==false&&['workshop','integrations'].every(group=>groupsFor(bot).includes(group))&&bot.integrationIds?.includes(args.integrationId)).sort((a,b)=>Number(b.id===context.bot.id)-Number(a.id===context.bot.id)).slice(0,20).map(bot=>({id:bot.id,name:bot.name})),notice:'Exact repeated GET only. Shared request count, not a monetary spending limit. No writes or transactions. Ends with this task or Engine process.'};}
  async create(context,args,prepared,limits){
    ensure(limits && typeof limits==='object' && !Array.isArray(limits) && Object.keys(limits).every(key=>['maxRequests','minutes','intervalSeconds','botIds'].includes(key)),400,'Supply explicit bounded-read limits.');
    const {maxRequests,minutes,intervalSeconds,botIds}=limits;
    ensure(Number.isInteger(maxRequests)&&maxRequests>=1&&maxRequests<=100&&Number.isInteger(minutes)&&minutes>=1&&minutes<=60&&Number.isInteger(intervalSeconds)&&intervalSeconds>=0&&intervalSeconds<=60,400,'Choose 1–100 requests, 1–60 minutes and a 0–60 second minimum interval.');
    ensure(Array.isArray(botIds)&&botIds.length>=1&&botIds.length<=20&&new Set(botIds).size===botIds.length&&botIds.includes(context.bot.id),400,'Select the requesting bot and at most 19 additional participants.');
    return this.serial(async()=>{
      const rootRunId=this.root(context),offered=this.offer(context,args).participants.map(bot=>bot.id);ensure(botIds.every(botId=>offered.includes(botId)),403,'A selected bot no longer has the required API access.');
      ensure(digest(prepared.scopeIdentity),400,'A prepared Engine review is required.');
      const grants=await this.read();ensure(grants.filter(g=>['active','pending'].includes(this.status(g))).length<32,409,'Revoke an active grant before adding another.');
      // Replacing an identical scope is an explicit owner decision, never an automatic budget reset.
      for(const g of grants)if(g.rootRunId===rootRunId && g.scopeIdentity===prepared.scopeIdentity && g.status==='active'){g.status='revoked';this.disabled.set(g.id,'revoked');this.active.get(g.id)?.abort(new Error('The owner replaced this grant.'));}
      const grant={id:id('grant'),ownerBotId:context.bot.id,rootRunId,botIds:[...botIds],scopeIdentity:prepared.scopeIdentity,packageDigest:args.digest,endpoint:prepared.review.endpoint,tool:args.tool,maxRequests,used:0,expiresAt:Date.now()+minutes*60_000,intervalMs:intervalSeconds*1000,lastAttemptAt:0,createdAt:now(),status:'pending',epoch:this.epoch,attempts:[]};
      grants.push(grant);while(grants.length>128){const index=grants.findIndex(g=>!['active','pending'].includes(this.status(g))&&!this.active.has(g.id));ensure(index>=0,409,'The grant ledger is full.');this.disabled.delete(grants[index].id);grants.splice(index,1);}
      this.root(context);await this.save(grants);this.root(context);return grant.id;
    });
  }
  async activate(context,grantId){return this.serial(async()=>{const root=this.root(context),grants=await this.read(),g=grants.find(g=>g.id===grantId);ensure(g&&g.rootRunId===root&&g.ownerBotId===context.bot.id&&g.epoch===this.epoch&&g.status==='pending',409,'The pending grant changed.');g.status='active';await this.save(grants);this.root(context);});}
  async find(context,scopeIdentity){return this.serial(async()=>{const root=this.root(context),grants=await this.read();return grants.findLast(g=>g.rootRunId===root&&g.scopeIdentity===scopeIdentity&&g.botIds.includes(context.bot.id))?.id || null;});}
  async list(botId){return this.serial(async()=>({grants:(await this.read()).filter(g=>g.ownerBotId===botId||g.botIds.includes(botId)).map(g=>({id:g.id,ownerBotId:g.ownerBotId,rootRunId:g.rootRunId,botIds:g.botIds,endpoint:g.endpoint,tool:g.tool,packageDigest:g.packageDigest,maxRequests:g.maxRequests,used:g.used,remaining:g.maxRequests-g.used,expiresAt:new Date(g.expiresAt).toISOString(),intervalSeconds:g.intervalMs/1000,status:this.status(g),attempts:g.attempts}))}));}
  async revoke(botId,grantId){return this.serial(async()=>{const grants=await this.read(),g=grants.find(g=>g.id===grantId&&(g.ownerBotId===botId||g.botIds.includes(botId)));ensure(g,404,'Grant not found.');g.status='revoked';this.disabled.set(g.id,'revoked');this.active.get(g.id)?.abort(new Error('The owner revoked this grant.'));await this.save(grants);return {revoked:true,id:grantId};});}
  async revokeScope(rootRunId,scopeIdentity){return this.serial(async()=>{const grants=await this.read();let changed=false;for(const g of grants)if(g.rootRunId===rootRunId&&g.scopeIdentity===scopeIdentity&&['active','pending'].includes(g.status)){g.status='revoked';this.disabled.set(g.id,'revoked');changed=true;this.active.get(g.id)?.abort(new Error('The owner denied this request.'));}if(changed)await this.save(grants);});}
  async run(context,call,prepared,grantId,invoke){
    ensure(typeof call.id==='string'&&call.id.length>=1&&call.id.length<=200,400,'A bounded tool invocation identity is required.');
    const controller=new AbortController(),attemptKey=`${context.runId}:${call.id}`;
    const reservation=await this.serial(async()=>{
      const root=this.root(context),grants=await this.read(),g=grants.find(g=>g.id===grantId);
      ensure(g&&g.rootRunId===root&&g.botIds.includes(context.bot.id)&&g.scopeIdentity===prepared.scopeIdentity,403,'This grant does not authorize the exact task, bot and request.');
      ensure(this.status(g)==='active',409,`This bounded-read grant is ${this.status(g)}. Inspect its ledger; do not repeat the request or reset the budget automatically.`);
      ensure(!this.active.has(g.id),409,'Another participant is using this grant. Wait for its result.');
      ensure(!g.attempts.some(a=>a.key===attemptKey),409,'This exact tool invocation was already reserved and cannot be replayed.');
      ensure(Date.now()-g.lastAttemptAt>=g.intervalMs,429,'The shared minimum request interval has not elapsed.');
      g.used++;g.lastAttemptAt=Date.now();g.attempts.push({key:attemptKey,botId:context.bot.id,at:now(),status:'reserved'});
      await this.save(grants);this.active.set(g.id,controller);return {expiresAt:g.expiresAt,used:g.used,maxRequests:g.maxRequests};
    });
    const signal=AbortSignal.any([context.controller.signal,this.engine.controllers.get(context.delegation?.rootRunId || context.runId)?.signal || context.controller.signal,controller.signal,AbortSignal.timeout(Math.max(1,reservation.expiresAt-Date.now()))]);
    const check=()=>{this.root(context);signal.throwIfAborted();};
    try{
      check();const result=await invoke(signal);check();
      await this.serial(async()=>{check();const grants=await this.read(),g=grants.find(g=>g.id===grantId);ensure(g?.status==='active'&&g.epoch===this.epoch&&g.expiresAt>Date.now(),409,'The grant was revoked or expired before completion.');g.attempts.find(a=>a.key===attemptKey).status='succeeded';await this.save(grants);});
      check();return {...result,grant:{id:grantId,used:reservation.used,remaining:reservation.maxRequests-reservation.used},observedAt:now()};
    }catch(error){
      if(!this.disabled.has(grantId))this.disabled.set(grantId,'blocked');
      await this.serial(async()=>{const grants=await this.read(),g=grants.find(g=>g.id===grantId);if(g){if(g.status==='active')g.status='blocked';const attempt=g.attempts.find(a=>a.key===attemptKey);if(attempt)attempt.status='failed-or-unknown';await this.save(grants);}});
      throw error;
    }finally{this.active.delete(grantId);}
  }
  close(){this.closed=true;for(const controller of this.active.values())controller.abort(new Error('Engine stopped; bounded-read grants are not resumed.'));}
}
