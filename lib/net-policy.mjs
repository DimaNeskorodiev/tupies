import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ensure, HttpError } from './store.mjs';

/** Deliberately conservative public-address policy for model-selected URLs. */
export function isPublicAddress(address) {
  const ip=String(address).toLowerCase().split('%')[0];
  if (ip.startsWith('::ffff:')) {
    const tail=ip.slice(7);
    if(isIP(tail)===4)return isPublicAddress(tail);
    const parts=tail.split(':');
    if(parts.length===2 && parts.every(p=>/^[0-9a-f]{1,4}$/.test(p))) {
      const n=(parseInt(parts[0],16)*65536)+parseInt(parts[1],16);
      return isPublicAddress([n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.'));
    }
    return false;
  }
  if(isIP(ip)===4) {
    const [a,b,c]=ip.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 ||
      (a===100 && b>=64 && b<=127) || (a===169 && b===254) ||
      (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || b===0 || (b===88 && c===99))) ||
      (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
  }
  if(isIP(ip)===6) {
    // Only global unicast; exclude documentation, benchmark, transition and IETF special space.
    const halves=ip.split('::'),left=halves[0]?halves[0].split(':'):[],right=halves[1]?halves[1].split(':'):[];
    const words=(halves.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left).map(part=>parseInt(part,16));
    return /^[23][0-9a-f]{3}:/.test(ip) && words[0]!==0x2002 && words[0]!==0x3fff &&
      !(words[0]===0x2001 && (words[1]<0x0200 || words[1]===0x0db8));
  }
  return false;
}

export function assertPublicUrl(value) {
  let url;try{url=new URL(value);}catch{throw new HttpError(400,'Enter a valid public HTTPS URL.');}
  ensure(url.protocol==='https:' && !url.username && !url.password && !url.hash,400,'Web tools require a public HTTPS URL without credentials or fragments.');
  ensure(!url.port || url.port==='443',400,'Web tools only connect to the standard HTTPS port.');
  // A fully qualified name's trailing dot names the same host, so it cannot slip past the local-name checks.
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase().replace(/\.$/,'');
  ensure(host && host!=='localhost' && !/(?:^|\.)(?:localhost|local|internal|home|lan|invalid|test)$/.test(host),400,'Private and local web addresses are blocked.');
  if(isIP(host))ensure(isPublicAddress(host),400,'Private and reserved web addresses are blocked.');
  ensure(url.href.length<=8000,400,'Web URL is too long.');
  return url;
}

export async function resolvePublicAddress(hostname, resolver=lookup) {
  const host=hostname.replace(/^\[|\]$/g,'');
  const addresses=isIP(host) ? [{address:host,family:isIP(host)}] : await resolver(host,{all:true,verbatim:true});
  ensure(addresses.length>0 && addresses.every(item=>isPublicAddress(item.address)),400,'The web host resolves to a private or reserved address.');
  return addresses[0];
}

/** DNS is checked once and the admitted address is pinned to the TLS request's lookup. */
export async function publicFetch(value,{signal,maxBytes=1_000_000,timeoutMs=15_000,maxRedirects=3}={}) {
  let url=assertPublicUrl(value);
  for(let redirects=0;redirects<=maxRedirects;redirects++) {
    if(signal?.aborted)throw signal.reason || new Error('Request cancelled.');
    const address=await new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(callback,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);callback(value);};
      const abort=()=>finish(reject,signal.reason || new Error('Web request cancelled.'));
      const timer=setTimeout(()=>finish(reject,new HttpError(504,'Web DNS lookup timed out.')),timeoutMs);
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}
      resolvePublicAddress(url.hostname).then(value=>finish(resolve,value),error=>finish(reject,error));
    });
    const result=await new Promise((resolve,reject)=>{
      const request=https.request(url,{
        method:'GET',agent:false,
        headers:{'User-Agent':'Tupies/0.2 (+self-hosted-agent)','Accept':'text/html,application/json,text/plain;q=0.9','Accept-Encoding':'identity'},
        lookup:(_host,options,callback)=>options?.all ? callback(null,[address]) : callback(null,address.address,address.family),
        signal,
      },response=>{
        const status=response.statusCode || 0;
        if([301,302,303,307,308].includes(status)) {
          response.resume();resolve({status,location:response.headers.location});return;
        }
        const type=String(response.headers['content-type'] || '').toLowerCase();
        if(!/(?:^text\/|json|xml|javascript)/.test(type)) {
          response.destroy();reject(new HttpError(400,'The web tool only reads textual content.'));return;
        }
        const declared=Number(response.headers['content-length']);
        if(Number.isFinite(declared) && declared>maxBytes){response.destroy();reject(new HttpError(413,'Web response exceeds the size limit.'));return;}
        let size=0;const chunks=[];
        response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){response.destroy(new HttpError(413,'Web response exceeds the size limit.'));}else chunks.push(chunk);});
        response.once('error',reject);
        response.once('end',()=>resolve({status,contentType:type,text:Buffer.concat(chunks).toString('utf8')}));
      });
      const timer=setTimeout(()=>request.destroy(new HttpError(504,'Web request timed out.')),timeoutMs);
      request.once('close',()=>clearTimeout(timer));request.once('error',reject);request.end();
    });
    if(result.location) {
      ensure(redirects<maxRedirects,400,'Web redirect limit reached.');
      url=assertPublicUrl(new URL(result.location,url).href);continue;
    }
    return {url:url.href,...result};
  }
  throw new HttpError(400,'Web redirect limit reached.');
}
