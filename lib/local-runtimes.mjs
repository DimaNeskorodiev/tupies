/**
 * Which local model runtimes answer on this engine's own machine: Ollama and MLX LM / MLX VLM.
 * Used by Settings › Models ("On this Mac") so the owner can add a running runtime in one click.
 *
 * Boundaries:
 * - Only loopback addresses are ever probed. A configured non-loopback URL is refused, not dialled.
 * - Every request is a bounded GET with a short timeout (1.5 s by default) and a small response cap.
 * - Tupies never starts a runtime and never downloads weights. Start commands and install links are text for the owner.
 * - On a server without these runtimes (a Linux VPS) everything simply reports "not running".
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOOPBACK=new Set(['127.0.0.1','localhost','::1']);
const MAX_BYTES=1_000_000;
const MAX_MODELS=200;
export const PROBE_TIMEOUT_MS=1500;

/** The runtimes Tupies knows how to detect. `probeUrl` is the server origin; `baseUrl` is what a connection uses. */
export const LOCAL_RUNTIMES=Object.freeze([
  Object.freeze({
    type:'ollama',name:'Ollama',probeUrl:'http://127.0.0.1:11434',
    startCommand:'ollama serve',alternativeCommands:[],
    installUrl:'https://ollama.com/download',
    binaries:['ollama'],apps:['/Applications/Ollama.app'],
  }),
  Object.freeze({
    type:'mlx',name:'MLX LM',probeUrl:'http://127.0.0.1:8080',
    startCommand:'mlx_lm.server --model <model> --port 8080',
    // mlx_vlm also serves Qwen3.8 with vision; it needs APC_ENABLED=1 for a prefix cache (docs/research/local-qwen38-27b-20261117.md).
    alternativeCommands:['APC_ENABLED=1 mlx_vlm.server --model <model> --port 8080'],
    installUrl:'https://github.com/ml-explore/mlx-lm',
    binaries:['mlx_lm.server','mlx_vlm.server'],apps:[],
  }),
]);

/** True when a URL's host is this machine's loopback interface. */
export function isLoopbackUrl(value) {
  try{const url=new URL(value);return url.protocol==='http:' && LOOPBACK.has(url.hostname.replace(/^\[|\]$/g,'').toLowerCase());}catch{return false;}
}

/** One bounded loopback GET. Resolves {status, data} where data is parsed JSON or null; rejects on network errors and timeouts. */
function getJson(origin,pathname,timeoutMs) {
  return new Promise((resolve,reject)=>{
    const url=new URL(pathname,origin);
    if(!isLoopbackUrl(url.href)){reject(new Error('Only loopback runtimes are probed.'));return;}
    const request=http.request(url,{method:'GET',headers:{Accept:'application/json'},agent:false,timeout:timeoutMs},response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>MAX_BYTES){request.destroy(new Error('Runtime response too large.'));return;}chunks.push(chunk);});
      response.on('end',()=>{let data=null;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}resolve({status:response.statusCode || 0,data});});
      response.on('error',reject);
    });
    const timer=setTimeout(()=>request.destroy(new Error('Runtime probe timed out.')),timeoutMs);timer.unref?.();
    request.on('timeout',()=>request.destroy(new Error('Runtime probe timed out.')));
    request.on('error',error=>{clearTimeout(timer);reject(error);});
    request.on('close',()=>clearTimeout(timer));
    request.end();
  });
}
const attempt=promise=>promise.then(value=>value,()=>null);
const ok=result=>result && result.status>=200 && result.status<300 && result.data && typeof result.data==='object';
const text=(value,limit=200)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,limit):'';
const embedding=id=>/(^|[^a-z])(embed|embedding|bge|e5|minilm|nomic-embed)([^a-z]|$)/i.test(id);

async function probeOllama(origin,timeoutMs) {
  const [version,tags]=await Promise.all([attempt(getJson(origin,'/api/version',timeoutMs)),attempt(getJson(origin,'/api/tags',timeoutMs))]);
  const running=ok(version) && typeof version.data.version==='string' || ok(tags) && Array.isArray(tags.data.models);
  const models=ok(tags) && Array.isArray(tags.data.models)?tags.data.models.slice(0,MAX_MODELS).map(item=>{
    const id=text(item?.model || item?.name);if(!id)return null;
    const details=item.details && typeof item.details==='object'?item.details:{};
    return {id,...(text(item.name) && text(item.name)!==id?{name:text(item.name)}:{}),...(Number.isFinite(item.size)&&item.size>0?{sizeBytes:item.size}:{}),...(text(details.parameter_size,40)?{parameterSize:text(details.parameter_size,40)}:{}),...(text(details.quantization_level,40)?{quantization:text(details.quantization_level,40)}:{}),...(text(details.family,60)?{family:text(details.family,60)}:{}),...(embedding(`${id} ${details.family || ''}`)?{embedding:true}:{})};
  }).filter(Boolean):[];
  return {running:!!running,...(ok(version) && text(version.data.version,40)?{version:text(version.data.version,40)}:{}),models,...(!running && (version || tags)?{conflict:true}:{})};
}

async function probeMlx(origin,timeoutMs) {
  const [list,health]=await Promise.all([attempt(getJson(origin,'/v1/models',timeoutMs)),attempt(getJson(origin,'/health',timeoutMs))]);
  const listed=ok(list) && Array.isArray(list.data.data);
  const running=listed || ok(health);
  const models=listed?list.data.data.slice(0,MAX_MODELS).map(item=>{const id=text(item?.id);return id?{id,...(embedding(id)?{embedding:true}:{})}:null;}).filter(Boolean):[];
  return {running:!!running,models,...(!running && (list || health)?{conflict:true}:{})};
}

/** Whether a runtime's program is on this machine: true, false, or null when it cannot be told (non-Mac, or MLX in a virtual env). */
async function installed(runtime,{platform,pathEnv,home,exists}) {
  if(platform!=='darwin')return null;
  const dirs=new Set([...String(pathEnv || '').split(path.delimiter).filter(Boolean),'/opt/homebrew/bin','/usr/local/bin',path.join(home,'.local','bin')]);
  if(runtime.type==='mlx'){try{for(const entry of await fs.readdir(path.join(home,'Library','Python')))dirs.add(path.join(home,'Library','Python',entry,'bin'));}catch{}}
  const candidates=[...runtime.apps,...[...dirs].flatMap(dir=>runtime.binaries.map(binary=>path.join(dir,binary)))];
  for(const candidate of candidates)if(await exists(candidate))return true;
  // Ollama installs to fixed places; MLX is often inside a project's virtual environment, so absence is not proof.
  return runtime.type==='ollama'?false:null;
}
const fileExists=async file=>{try{await fs.access(file);return true;}catch{return false;}};

/**
 * Detect local runtimes. Options exist for tests: `urls` ({ollama, mlx} origins, loopback only), `timeoutMs`,
 * `platform`, `pathEnv`, `home` and `exists`.
 */
export async function detectLocalRuntimes(options={}) {
  const timeoutMs=Math.max(50,Math.min(PROBE_TIMEOUT_MS,Number(options.timeoutMs) || PROBE_TIMEOUT_MS));
  const platform=options.platform || process.platform,home=options.home || os.homedir(),pathEnv=options.pathEnv ?? process.env.PATH,exists=options.exists || fileExists;
  const runtimes=await Promise.all(LOCAL_RUNTIMES.map(async runtime=>{
    const origin=String(options.urls?.[runtime.type] || runtime.probeUrl).replace(/\/+$/,'');
    const loopback=isLoopbackUrl(origin);
    const probe=loopback?await (runtime.type==='ollama'?probeOllama:probeMlx)(origin,timeoutMs):{running:false,models:[]};
    const found=probe.running?true:await installed(runtime,{platform,pathEnv,home,exists}).catch(()=>null);
    return {
      type:runtime.type,name:runtime.name,baseUrl:`${origin}/v1`,running:probe.running,
      ...(probe.version?{version:probe.version}:{}),
      models:probe.models,
      ...(probe.conflict?{conflict:true}:{}),
      installed:found,
      startCommand:runtime.startCommand,alternativeCommands:[...runtime.alternativeCommands],installUrl:runtime.installUrl,
    };
  }));
  return {platform,checkedAt:new Date().toISOString(),runtimes};
}
