import { promises as fs } from 'node:fs';
import path from 'node:path';

// Structured per-engine JSONL log of model calls, tool calls and finished runs. Local only, redacted, never replicated.
// A logging failure is swallowed: diagnostics must never change a task's outcome.
const FILE=/^engine-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_PENDING=2000,MAX_STRING=4000,READ_TAIL=4_000_000;
const pad=value=>String(value).padStart(2,'0');
export const logDay=(date=new Date())=>`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
const scrub=(value,redact,depth=0)=>typeof value==='string'?redact(value).slice(0,MAX_STRING):Array.isArray(value)?(depth>6?[]:value.slice(0,50).map(item=>scrub(item,redact,depth+1))):value && typeof value==='object'?(depth>6?{}:Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined && typeof item!=='function').map(([key,item])=>[key,scrub(item,redact,depth+1)]))):typeof value==='number' && !Number.isFinite(value)?null:value;

/** Creates an append-only JSONL logger under `<directory>/logs` with daily files and 14-day retention. */
export function createEngineLog({directory,redact=value=>value,now=()=>new Date(),retainDays=14}={}) {
  if(!directory)return null;
  const logs=path.join(directory,'logs'),safeRedact=value=>{try{return String(redact(value));}catch{return '[redacted]';}};
  let queue=Promise.resolve(),pending=0,ready=null,currentDay=null,dropped=0,closed=false;
  const ensureDirectory=()=>ready ||= (async()=>{await fs.mkdir(logs,{recursive:true,mode:0o700});await fs.chmod(logs,0o700);})().catch(error=>{ready=null;throw error;});
  const cleanup=async()=>{
    const cutoff=logDay(new Date(now().getTime()-retainDays*86_400_000));
    for(const name of await fs.readdir(logs).catch(()=>[])){const match=FILE.exec(name);if(match && match[1]<cutoff)await fs.rm(path.join(logs,name),{force:true}).catch(()=>{});}
  };
  const enqueue=task=>{queue=queue.then(task).catch(()=>{});return queue;};
  const append=async line=>{
    await ensureDirectory();
    const day=logDay(now());
    if(day!==currentDay){currentDay=day;await cleanup();}
    const file=path.join(logs,`engine-${day}.jsonl`);
    await fs.appendFile(file,line,{mode:0o600});await fs.chmod(file,0o600);
  };
  enqueue(async()=>{await ensureDirectory();await cleanup();});
  return {
    directory:logs,
    /** Queues one record; never throws and never waits. */
    write(record) {
      try {
        if(closed || !record || typeof record!=='object')return;
        if(pending>=MAX_PENDING){dropped++;return;}
        const line=`${JSON.stringify(scrub({ts:now().toISOString(),...record,...(dropped?{droppedBefore:dropped}:{})},safeRedact))}\n`;dropped=0;
        pending++;enqueue(()=>append(line)).finally(()=>{pending--;});
      } catch { /* Logging never fails the engine. */ }
    },
    flush(){return queue;},
    async close(){closed=true;await queue;},
    /** Reads matching records from today's and yesterday's files, newest last, capped at `limit`. */
    async read({filter=()=>true,limit=200}={}) {
      await queue;
      const today=now(),days=[logDay(new Date(today.getTime()-86_400_000)),logDay(today)],records=[];
      for(const day of days) {
        const file=path.join(logs,`engine-${day}.jsonl`);
        let text='';
        try {
          const handle=await fs.open(file,'r');
          try{const {size}=await handle.stat(),start=Math.max(0,size-READ_TAIL),buffer=Buffer.alloc(size-start);await handle.read(buffer,0,buffer.length,start);text=buffer.toString('utf8');if(start>0)text=text.slice(text.indexOf('\n')+1);}finally{await handle.close();}
        } catch { continue; }
        for(const line of text.split('\n')){if(!line)continue;try{const record=JSON.parse(line);if(filter(record))records.push(record);}catch { /* A torn line is skipped. */ }}
      }
      return records.slice(-Math.max(1,Math.min(1000,limit)));
    },
  };
}
