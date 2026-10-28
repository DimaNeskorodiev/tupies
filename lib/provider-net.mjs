import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { HttpError, ensure } from './store.mjs';

const localNames = new Set(['localhost', '127.0.0.1', '::1']);
/** The IPv4 address that NAT64, IPv4-compatible and 6to4 IPv6 forms reach through translation, so it gets the IPv4 checks. */
function embeddedIPv4(address) {
  if(isIP(address)!==6)return null;
  const parse=part=>part?part.split(':').flatMap(group=>{if(!group.includes('.'))return [parseInt(group,16)];const [a,b,c,d]=group.split('.').map(Number);return [a<<8|b,c<<8|d];}):[];
  const [head,tail]=address.split('::'),left=parse(head),right=tail===undefined?[]:parse(tail);
  const groups=tail===undefined?left:[...left,...Array(Math.max(0,8-left.length-right.length)).fill(0),...right];
  if(groups.length!==8)return null;
  const ipv4=(high,low)=>`${high>>8}.${high&255}.${low>>8}.${low&255}`;
  if(groups[0]===0x64 && groups[1]===0xff9b && (groups[2]===1 || groups.slice(2,6).every(group=>group===0)))return ipv4(groups[6],groups[7]);
  if(groups[0]===0x2002)return ipv4(groups[1],groups[2]);
  if(groups.slice(0,6).every(group=>group===0) && (groups[6] || groups[7]>1))return ipv4(groups[6],groups[7]);
  return null;
}
export function isRestrictedAddress(value){
  const address=String(value).toLowerCase().replace(/^\[|\]$/g,''),embedded=embeddedIPv4(address);
  if(embedded)return isRestrictedAddress(embedded);
  // Reject mapped IPv6 and all link-local/metadata destinations even in private-network mode.
  if(address.startsWith('::ffff:') || /^(fe[89ab]|ff)/.test(address) || address==='::')return true;
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return a===0 || a===169 && b===254 || a>=224;}
  return false;
}
export function isPrivateAddress(value) {
  let address=String(value).toLowerCase().replace(/^\[|\]$/g,'');
  if(address.startsWith('::ffff:'))address=address.slice(7);
  const embedded=embeddedIPv4(address);if(embedded)return isPrivateAddress(embedded) || address.startsWith('64:ff9b:1:');
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return a===0 || a===10 || a===127 || a===169 && b===254 || a===172 && b>=16 && b<=31 || a===192 && b===168 || a===100 && b>=64 && b<=127 || a>=224;}
  return address==='::' || address==='::1' || /^(fc|fd|fe[89a-f])/.test(address) || address.startsWith('64:ff9b:1:') || !isIP(address);
}
export function validateServiceUrl(value,{allowPrivateHttp=false,allowQuery=false}={}) {
  let url;try{url=new URL(value);}catch{throw new HttpError(400,'Enter a valid service URL.');}
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  ensure(!url.username && !url.password && !url.hash && (allowQuery || !url.search),400,'Service URL must not contain credentials, a fragment, or unexpected query parameters.');
  ensure(!isRestrictedAddress(hostname),400,'Cloud metadata, link-local and unspecified addresses are not allowed.');
  ensure(url.protocol==='https:' || url.protocol==='http:' && (localNames.has(hostname) || allowPrivateHttp),400,'Use HTTPS for remote services. Local loopback HTTP is supported.');
  if(isIP(hostname) && isPrivateAddress(hostname))ensure(localNames.has(hostname) || allowPrivateHttp,400,'Private network services require the operator private-network setting.');
  return url;
}

/** Bounded HTTP with pinned DNS, no redirects, no cookies, and optional SSE decoding. */
export async function serviceRequest(value,{method='GET',headers={},body,signal,timeoutMs=45_000,maxBytes=8_000_000,allowPrivateHttp=false,onSSE,responseType='json'}={}) {
  const url=validateServiceUrl(value,{allowPrivateHttp,allowQuery:true}),hostname=url.hostname.replace(/^\[|\]$/g,'');
  if(signal?.aborted)throw signal.reason || new Error('Request cancelled.');
  const resolution= isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await Promise.race([
    lookup(hostname,{all:true}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new HttpError(502,'Service DNS lookup timed out.')),Math.min(timeoutMs,10_000));timer.unref();})
  ]);
  ensure(resolution.length,502,'Service DNS lookup returned no address.');
  const explicitLocal=localNames.has(hostname);
  ensure(resolution.every(record=>!isPrivateAddress(record.address) || explicitLocal || allowPrivateHttp),400,'Service resolved to a private or restricted network address.');
  if(url.protocol==='http:' && !explicitLocal)ensure(allowPrivateHttp && resolution.every(record=>isPrivateAddress(record.address)),400,'Unencrypted HTTP is allowed only on explicitly enabled private networks.');
  ensure(resolution.every(record=>!isRestrictedAddress(record.address)),400,'Cloud metadata, link-local and unspecified addresses are not allowed.');
  const pinned=resolution.find(record=>record.family===4) || resolution[0];
  return new Promise((resolve,reject)=>{
    let settled=false,total=0,sseBuffer='',raw=[];const events=[],decoder=new StringDecoder('utf8');
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const transport=url.protocol==='https:'?https:http;
    const request=transport.request(url,{method,headers,agent:false,lookup:(_host,options,done)=>options?.all?done(null,[pinned]):done(null,pinned.address,pinned.family)},response=>{
      const status=response.statusCode || 502,contentType=String(response.headers['content-type']||'').split(';')[0].trim().toLowerCase();
      // Some streaming proxies omit the MIME header. Only sniff successful requests
      // that explicitly expect events; metadata/OAuth JSON remains ordinary JSON.
      let streaming=status>=200 && status<300 && contentType==='text/event-stream',mode=responseType==='bytes' && status>=200 && status<300?'bytes':streaming?'sse':onSSE && status>=200 && status<300 && ['', 'text/plain', 'application/octet-stream'].includes(contentType)?'pending':'json';
      const fail=error=>{finish(error);request.destroy(error);};
      const sniff=()=>{
        const sample=sseBuffer.replace(/^\uFEFF/,'').trimStart(),prefixes=['data:','event:',':','id:','retry:'];
        if(prefixes.some(prefix=>sample.startsWith(prefix))){streaming=true;mode='sse';raw=[];return;}
        if(sample && !prefixes.some(prefix=>prefix.startsWith(sample)))mode='json';
      };
      const parseFrame=frame=>{
        const data=frame.replace(/^\uFEFF/,'').split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if(!data || data==='[DONE]')return true;
        let event;try{event=JSON.parse(data);}catch{fail(new HttpError(502,'Service returned invalid stream data.'));return false;}
        events.push(event);if(events.length>50_000){fail(new HttpError(502,'Service stream exceeded its event limit.'));return false;}
        try{if(status>=200 && status<300)onSSE?.(event);}catch(error){fail(error);return false;}
        return !settled;
      };
      const parseFrames=()=>{sseBuffer=sseBuffer.replace(/\r\n/g,'\n');let boundary;while((boundary=sseBuffer.indexOf('\n\n'))>=0){if(!parseFrame(sseBuffer.slice(0,boundary)))return;sseBuffer=sseBuffer.slice(boundary+2);}};
      response.on('data',chunk=>{
        if(settled)return;
        total+=chunk.length;if(total>maxBytes){fail(new HttpError(502,'Service response exceeded its size limit.'));return;}
        if(mode==='json'||mode==='bytes'){raw.push(chunk);return;}
        if(mode==='pending')raw.push(chunk);
        sseBuffer+=decoder.write(chunk);
        if(mode==='pending')sniff();
        if(mode==='sse')parseFrames();
      });
      response.on('end',()=>{
        if(settled)return;
        if(mode==='bytes'){finish(null,{status,headers:response.headers,bytes:Buffer.concat(raw),data:null,events:[],streaming:false});return;}
        if(mode!=='json'){sseBuffer+=decoder.end();if(mode==='pending')sniff();if(mode==='sse'){parseFrames();if(settled)return;if(sseBuffer.trim()&&!parseFrame(sseBuffer))return;}}
        if(settled)return;
        if(status>=300 && status<400){finish(new HttpError(502,'Service redirects are refused to protect credentials.'));return;}
        let data=null;
        if(!streaming){const text=Buffer.concat(raw).toString('utf8');try{data=text?JSON.parse(text.replace(/^\uFEFF/,'')):null;}catch{if(status<200 || status>=300){finish(null,{status,headers:response.headers,data:null,events:[],streaming:false});return;}const reportedType=String(response.headers['content-type']||'missing').slice(0,100),encoding=String(response.headers['content-encoding']||'identity').slice(0,40),format=/^\s*</.test(text)?'HTML/XML':/^\s*[\[{]/.test(text)?'JSON-like':'text';finish(new HttpError(502,`Service returned invalid JSON (HTTP ${status}; Content-Type: ${reportedType}; Content-Encoding: ${encoding}; Body format: ${format}).`));return;}}
        finish(null,{status,headers:response.headers,data,events,streaming});
      });
      response.on('error',error=>finish(error));
      response.on('aborted',()=>finish(new HttpError(502,'Service response was interrupted. The request was not replayed.')));
    });
    const abort=()=>{const error=signal.reason || new Error('Request cancelled.');finish(error);request.destroy(error);};
    const timer=setTimeout(()=>{const error=new HttpError(504,'Service request timed out.');finish(error);request.destroy(error);},timeoutMs);timer.unref();
    signal?.addEventListener('abort',abort,{once:true});request.on('error',error=>finish(error));if(signal?.aborted){abort();return;}
    if(body!==undefined)request.write(typeof body==='string' || Buffer.isBuffer(body)?body:JSON.stringify(body));request.end();
  });
}

export function requireSuccess(response,label='Service') {
  if(response.status>=200 && response.status<300)return response;
  const detail=typeof response.data?.error==='string'?response.data.error:response.data?.error?.message;
  throw new HttpError(response.status===401 || response.status===403?401:502,`${label} returned HTTP ${response.status}${detail?`: ${String(detail).slice(0,300)}`:'. Check the account and service settings.'}`);
}
