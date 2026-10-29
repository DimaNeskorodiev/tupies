import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensure, now } from '../store.mjs';
import { keyId,publicKeyObject,fingerprint } from './crypto.mjs';

const SAFE_ID=/^[A-Za-z0-9_-]{1,120}$/;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
async function durableWrite(file,bytes){
  const temporary=`${file}.${randomBytes(8).toString('hex')}.tmp`;let handle,renamed=false;
  try{
    handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await fs.rename(temporary,file);renamed=true;
    const directory=await fs.open(path.dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
  }catch(error){if(renamed)error.journalCommitted=true;throw error;}
  finally{await handle?.close().catch(()=>{});await fs.rm(temporary,{force:true}).catch(()=>{});}
}
/** Read-only backup/startup validation; never repairs files, changes trust or generates keys. */
export function validateSecurityRecord(store,record){
  const validDate=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
  ensure(object(record)&&record.v===2&&Number.isSafeInteger(record.epoch)&&record.epoch>=1&&/^[A-Za-z0-9_-]{16,120}$/.test(record.workspaceId)&&object(record.grants)&&object(record.revoked)&&(!record.revokedNodes||object(record.revokedNodes)),500,'The sync security journal is invalid. Restore the complete runtime backup.');
  for(const [id,grant] of Object.entries(record.grants)){
    ensure(SAFE_ID.test(id)&&object(grant)&&SAFE_ID.test(grant.nodeId)&&!record.revoked[id],500,'The sync engine grants are invalid. Restore the complete runtime backup.');
    try{publicKeyObject(grant.publicKey);ensure(grant.fingerprint===fingerprint(grant.publicKey),500,'Invalid grant fingerprint.');}catch{ensure(false,500,'The sync engine grant identity is invalid. Restore the complete runtime backup.');}
  }
  for(const [id,at] of Object.entries(record.revoked))ensure(SAFE_ID.test(id)&&validDate(at),500,'The sync revocation journal is invalid. Restore the complete runtime backup.');
  for(const [node,at] of Object.entries(record.revokedNodes || {}))ensure(SAFE_ID.test(node)&&validDate(at),500,'The sync node revocation journal is invalid. Restore the complete runtime backup.');
  ensure(!record.revokedGrants || object(record.revokedGrants),500,'The revoked-engine identity journal is invalid.');
  for(const [id,grant] of Object.entries(record.revokedGrants || {})){
    ensure(SAFE_ID.test(id)&&record.revoked[id]&&!record.grants[id]&&object(grant)&&SAFE_ID.test(grant.nodeId),500,'The revoked-engine identity journal is invalid.');
    try{publicKeyObject(grant.publicKey);ensure(grant.fingerprint===fingerprint(grant.publicKey),500,'Invalid revoked grant fingerprint.');}catch{ensure(false,500,'The revoked-engine identity journal is invalid.');}
  }
  let key;try{const encoded=store.unseal(record.key);key=Buffer.from(encoded,'base64');ensure(key.toString('base64')===encoded,500,'Invalid key encoding.');}catch{ensure(false,500,'The sync security key could not be opened. Restore the complete runtime backup.');}
  ensure(key.length===32&&keyId(key)===record.keyId,500,'The sync security key is invalid. Restore the complete runtime backup.');return {record,key};
}

/** Authoritative local key/grant journal. One atomic write revokes access and replaces the shared key. */
export class SyncSecurity {
  constructor(store,directory,{write=durableWrite}={}){this.store=store;this.directory=directory;this.file=path.join(directory,'security.json');this.write=write;this.queue=Promise.resolve();}
  async init({identity,createdIdentity,legacyKey,existingSecurePeers=false}){
    let record;try{record=JSON.parse(await fs.readFile(this.file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(record){
      const validated=validateSecurityRecord(this.store,record);this.record=record;this.key=validated.key;
    }else{
      ensure(createdIdentity||identity.securityProtocol!==2&&!existingSecurePeers,500,'The sync security journal is missing. Restore it from the complete runtime backup; do not reset engine keys.');
      // Legacy code-only wraps may have exposed the old group key; the secure protocol begins with a fresh key.
      ensure(createdIdentity||legacyKey?.length===32,500,'The existing sync workspace key is missing. Restore the complete runtime backup.');
      await this.commit({v:2,workspaceId:randomBytes(18).toString('base64url'),epoch:1,grants:{},revoked:{},revokedNodes:{},revokedGrants:{},createdAt:now()},randomBytes(32));
    }
    await this.mirror();return this;
  }
  async mirror(){await this.write(path.join(this.directory,'workspace.key'),this.key);}
  async commit(record,key=this.key){
    const next={...record,keyId:keyId(key),key:this.store.seal(key.toString('base64'))};
    try{await this.write(this.file,JSON.stringify(next,null,2));}
    catch(error){if(error.journalCommitted){this.record=next;this.key=Buffer.from(key);}throw error;}
    this.record=next;this.key=Buffer.from(key);
    // The journal is authoritative if a crash leaves this compatibility mirror behind.
    await this.mirror();
  }
  grant(device){const grant=this.record.grants[device.id];return grant&&grant.nodeId===device.nodeId&&grant.fingerprint===device.fingerprint&&grant.publicKey===device.publicKey&&!this.record.revoked[device.id]?grant:null;}
  serialize(operation){const pending=this.queue.then(operation);this.queue=pending.catch(()=>{});return pending;}
  add(device){return this.serialize(()=>this.commit({...this.record,grants:{...this.record.grants,[device.id]:{nodeId:device.nodeId,fingerprint:device.fingerprint,publicKey:device.publicKey}}}));}
  revoke(deviceIds,{at}={}){return this.serialize(async()=>{
    const grants={...this.record.grants},revoked={...this.record.revoked},revokedNodes={...this.record.revokedNodes},revokedGrants={...this.record.revokedGrants};let changed=false;
    const timestamp=typeof at==='string'&&at.length<=40&&Number.isFinite(Date.parse(at))?at:now();
    for(const id of deviceIds){if(grants[id]){changed=true;revokedNodes[grants[id].nodeId] ||= timestamp;revokedGrants[id]={...grants[id]};}delete grants[id];revoked[id] ||= timestamp;}
    await this.commit({...this.record,grants,revoked,revokedNodes,revokedGrants,...(changed?{epoch:this.record.epoch+1,rotatedAt:now()}:{})},changed?randomBytes(32):this.key);
    return changed;
  });}
  adopt({workspaceId,epoch,keyId:expectedId},key,{allowNewWorkspace=false}={}){return this.serialize(async()=>{
    ensure(key.length===32&&keyId(key)===expectedId,502,'The home server sent an invalid workspace key.');
    ensure(Number.isSafeInteger(epoch)&&epoch>=1&&/^[A-Za-z0-9_-]{16,120}$/.test(workspaceId),502,'The home server sent invalid key-version metadata.');
    ensure(allowNewWorkspace||this.record.workspaceId===workspaceId,409,'The home server changed workspace identity. Re-link explicitly after checking its backup.');
    if(this.record.workspaceId===workspaceId){ensure(epoch>=this.record.epoch,409,'The home server attempted to roll back the workspace key.');ensure(epoch!==this.record.epoch||expectedId===this.record.keyId,409,'The home server returned a conflicting workspace key version.');}
    const sameWorkspace=this.record.workspaceId===workspaceId;
    await this.commit({...this.record,workspaceId,epoch,grants:{},revoked:sameWorkspace?this.record.revoked:{},revokedNodes:sameWorkspace?this.record.revokedNodes || {}:{},revokedGrants:sameWorkspace?this.record.revokedGrants || {}:{}},key);
  });}
}
