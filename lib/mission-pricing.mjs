import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { ensure } from './store.mjs';
import { routineConnectionIdentity } from './routine-checkpoints.mjs';

const MAX_BYTES=65536,MAX_SCHEDULES=100;
const rowKeys=new Set(['connectionId','type','baseUrl','model','version','currency','inputMicrosPerMillion','outputMicrosPerMillion','cachedInputMicrosPerMillion','cacheCreationMicrosPerMillion','connectionIdentity']);
const rates=['inputMicrosPerMillion','outputMicrosPerMillion','cachedInputMicrosPerMillion','cacheCreationMicrosPerMillion'];
const plain=value=>value && typeof value==='object' && !Array.isArray(value);
const bounded=(value,max)=>typeof value==='string' && value.length>0 && value.length<=max && !/[\x00-\x1f\x7f]/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const inside=(root,file)=>file===root || file.startsWith(root+path.sep);
function safeOwner(stat){return stat.uid===0 || typeof process.getuid==='function' && stat.uid===process.getuid();}
const immutable=value=>Object.freeze(value);
async function ancestors(file){
  const result=[];let current=path.dirname(file);
  for(;;){const stat=await fs.lstat(current);ensure(stat.isDirectory() && !stat.isSymbolicLink() && safeOwner(stat),400,'Mission prices require trusted directory ancestors without symbolic links.');
    const writable=stat.mode&0o022,stickyRoot=stat.uid===0 && (stat.mode&0o1000)!==0;
    ensure(!writable || stickyRoot,400,'Mission prices require private or non-writable directory ancestors.');result.push({path:current,dev:stat.dev,ino:stat.ino});if(current===path.dirname(current))break;current=path.dirname(current);
  }
  return result;
}
function validateFile(stat){ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink===1 && safeOwner(stat) && (stat.mode&0o022)===0 && stat.size>0 && stat.size<=MAX_BYTES,400,'Mission prices require one trusted, non-writable regular file of at most 64 KiB.');}

/** Startup-only operator configuration. Never reads environment, model arguments, runtime data or remote prices. */
export async function loadMissionPricing({file,dataDir,state}={}){
  if(file===undefined || file===null || file==='')return immutable({configured:false,count:0,priceFor:()=>undefined});
  ensure(typeof file==='string' && path.isAbsolute(file) && !file.split(path.sep).includes('..') && !file.includes('\0'),400,'Use an absolute operator Mission prices file path without traversal.');
  ensure(typeof dataDir==='string' && path.isAbsolute(dataDir),400,'The runtime directory is required to exclude private execution data.');
  const target=path.resolve(file),runtime=await fs.realpath(dataDir);
  ensure(!inside(runtime,target) && !inside(path.resolve(dataDir),target),400,'The Mission prices file must be outside the entire runtime tree.');
  ensure(!target.split(path.sep).some(part=>['workspaces','skills','proposals','mission-evidence','process-homes'].includes(part)),400,'Mission prices cannot come from model-editable workspace, skill or proposal paths.');
  const parents=await ancestors(target),before=await fs.lstat(target);validateFile(before);
  ensure(await fs.realpath(target)===target,400,'Mission prices require an exact canonical path without symbolic links.');
  let bytes;const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const opened=await handle.stat();validateFile(opened);ensure(opened.dev===before.dev && opened.ino===before.ino,409,'The Mission prices file changed while opening it.');
    const buffer=Buffer.alloc(MAX_BYTES+1);let length=0;
    while(length<buffer.length){const read=await handle.read(buffer,length,buffer.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
    const after=await handle.stat();validateFile(after);
    ensure(length<=MAX_BYTES && length===opened.size && after.dev===opened.dev && after.ino===opened.ino && after.size===opened.size && after.mtimeMs===opened.mtimeMs && after.ctimeMs===opened.ctimeMs,409,'The Mission prices file changed while reading it.');
    const current=await fs.lstat(target);validateFile(current);ensure(current.dev===opened.dev && current.ino===opened.ino && await fs.realpath(target)===target,409,'The Mission prices path changed while reading it.');
    const checked=await ancestors(target);ensure(checked.length===parents.length && checked.every((item,index)=>item.path===parents[index].path && item.dev===parents[index].dev && item.ino===parents[index].ino),409,'The Mission prices directory changed while reading it.');
    bytes=buffer.subarray(0,length);
  }finally{await handle.close();}
  let document;try{document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{ensure(false,400,'Mission prices must contain valid bounded UTF-8 JSON.');}
  ensure(plain(document) && Object.keys(document).every(key=>['schemaVersion','schedules'].includes(key)) && document.schemaVersion===1 && Array.isArray(document.schedules) && document.schedules.length<=MAX_SCHEDULES,400,'Use Mission prices schema version 1 with at most 100 schedules.');
  ensure(Array.isArray(state?.connections),400,'The current engine connections are required to bind operator prices.');
  const schedules=new Map();
  for(const row of document.schedules){
    ensure(plain(row) && Object.keys(row).every(key=>rowKeys.has(key)) && bounded(row.connectionId,120) && bounded(row.type,80) && typeof row.baseUrl==='string' && row.baseUrl.length<=2000 && !/[\x00-\x1f\x7f]/.test(row.baseUrl) && bounded(row.model,240) && bounded(row.version,120) && row.currency==='USD',400,'Use exact connection/provider/model/version identities and USD in every Mission price row.');
    ensure(integer(row.inputMicrosPerMillion) && integer(row.outputMicrosPerMillion) && rates.every(key=>row[key]===undefined || integer(row[key])),400,'Mission price rates must be nonnegative safe integer microUSD per million tokens.');
    const connection=state.connections.find(item=>item.id===row.connectionId);
    ensure(connection && connection.type===row.type && (connection.baseUrl || '')===row.baseUrl,409,'A Mission price row does not match its current engine connection and destination.');
    ensure(connection.type!=='chatgpt',400,'Subscription connections cannot use Mission unit-price schedules or monetary-cap claims.');
    const identity=routineConnectionIdentity(connection);
    ensure(row.connectionIdentity===undefined || row.connectionIdentity===identity,409,'A Mission price row has a stale connection identity.');
    const key=JSON.stringify([identity,row.model]);ensure(!schedules.has(key),400,'Duplicate Mission price schedules for the same exact connection and model are not allowed.');
    const schedule=immutable({source:'operator',currency:'USD',version:row.version,model:row.model,...Object.fromEntries(rates.filter(name=>row[name]!==undefined).map(name=>[name,row[name]]))});schedules.set(key,schedule);
  }
  return immutable({configured:true,count:schedules.size,priceFor:(connection,model)=>{if(!connection || connection.type==='chatgpt')return undefined;return schedules.get(JSON.stringify([routineConnectionIdentity(connection),model]));}});
}
