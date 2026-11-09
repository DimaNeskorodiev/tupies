import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { publicFetch } from '../lib/net-policy.mjs';
import { readableWebContent } from '../lib/web-content.mjs';

/** A public IP literal skips DNS; https.request is redirected to a loopback HTTP server so streaming, limits and redirects are real. */
async function server(t,handler) {
  const seen=[],origin=http.createServer((req,res)=>{
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));
    req.on('end',()=>{const body=Buffer.concat(chunks).toString('utf8');seen.push({method:req.method,url:req.url,headers:req.headers,body});handler(req,res,body);});
  });
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
  const original=https.request;
  https.request=(url,options,callback)=>http.request({host:'127.0.0.1',port:origin.address().port,path:url.pathname+url.search,method:options.method,headers:options.headers,signal:options.signal},callback);
  t.after(async()=>{https.request=original;origin.closeAllConnections();await new Promise(resolve=>origin.close(resolve));});
  return seen;
}
const URL_='https://8.8.8.8/api';

test('POST sends a JSON object with content-type and reports method and status',async t=>{
  const seen=await server(t,(req,res)=>{res.writeHead(201,{'content-type':'application/json; charset=utf-8'});res.end('{"ok":true}');});
  const result=await publicFetch(URL_,{method:'POST',body:{a:1}});
  assert.equal(seen[0].method,'POST');assert.equal(seen[0].body,'{"a":1}');assert.equal(seen[0].headers['content-type'],'application/json');
  assert.equal(result.status,201);assert.equal(result.method,'POST');assert.equal(result.text,'{"ok":true}');assert.equal(result.url,URL_);
  await publicFetch(URL_,{method:'POST',body:'a=1',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Trace':'1'}});
  assert.equal(seen[1].headers['content-type'],'application/x-www-form-urlencoded');assert.equal(seen[1].headers['x-trace'],'1');assert.equal(seen[1].body,'a=1');
});

test('headers and body are validated before any connection',async()=>{
  for(const name of ['Authorization','cookie','Proxy-Authorization','host','content-length','transfer-encoding'])await assert.rejects(publicFetch(URL_,{headers:{[name]:'x'}}),/not allowed|Integrations/);
  await assert.rejects(publicFetch(URL_,{headers:Object.fromEntries(Array.from({length:9},(_,i)=>[`x-h${i}`,'1']))}),/at most 8/);
  await assert.rejects(publicFetch(URL_,{headers:{'x-a':'a'.repeat(1500),'x-b':'b'.repeat(1000)}}),/2 KB/);
  await assert.rejects(publicFetch(URL_,{headers:{'x-a':'line\r\nbreak'}}),/single-line/);
  await assert.rejects(publicFetch(URL_,{method:'POST',body:'x'.repeat(200_001)}),/200 KB/);
  await assert.rejects(publicFetch(URL_,{method:'PUT'}),/GET or POST/);
  await assert.rejects(publicFetch(URL_,{body:'x'}),/Only POST/);
});

test('307 keeps POST and body, 303 switches to GET without body',async t=>{
  const seen=await server(t,(req,res)=>{
    if(req.url==='/keep')res.writeHead(307,{location:'/final'}).end();
    else if(req.url==='/switch')res.writeHead(303,{location:'/final'}).end();
    else res.writeHead(200,{'content-type':'text/plain'}).end('done');
  });
  const kept=await publicFetch('https://8.8.8.8/keep',{method:'POST',body:{x:1}});
  assert.deepEqual(seen.map(item=>[item.method,item.url,item.body]),[['POST','/keep','{"x":1}'],['POST','/final','{"x":1}']]);assert.equal(kept.method,'POST');
  seen.length=0;
  const switched=await publicFetch('https://8.8.8.8/switch',{method:'POST',body:{x:1}});
  assert.deepEqual(seen.map(item=>[item.method,item.url,item.body]),[['POST','/switch','{"x":1}'],['GET','/final','']]);assert.equal(switched.method,'GET');assert.equal(seen[1].headers['content-type'],undefined);
});

test('non-2xx statuses are returned with their body, not thrown',async t=>{
  await server(t,(req,res)=>res.writeHead(405,{'content-type':'application/json'}).end('{"error":"POST only"}'));
  const result=await publicFetch(URL_);assert.equal(result.status,405);assert.match(result.text,/POST only/);
});

test('responses over maxBytes abort with the 5 MB message, declared or streamed',async t=>{
  await server(t,(req,res)=>{
    res.writeHead(200,{'content-type':'text/plain',...(req.url==='/declared'?{'content-length':'6000'}:{})});
    if(req.url==='/declared')res.end('x'.repeat(6000));else{res.write('x'.repeat(4000));res.write('x'.repeat(4000));res.end('x'.repeat(4000));}
  });
  for(const route of ['/declared','/streamed'])await assert.rejects(publicFetch(`https://8.8.8.8${route}`,{maxBytes:5000}),error=>error.status===413 && /exceeds the 5 MB limit; request a narrower resource or page it/.test(error.message));
});

test('binary responses are refused with 415, text types and unlabeled UTF-8 are accepted',async t=>{
  await server(t,(req,res)=>{
    if(req.url==='/image')res.writeHead(200,{'content-type':'image/png'}).end(Buffer.from([137,80,78,71]));
    else if(req.url==='/zip')res.writeHead(200,{'content-type':'application/octet-stream'}).end('PK');
    else if(req.url==='/unlabeled-binary')res.writeHead(200).end(Buffer.from([0,1,2,3,255,254,0,0]));
    else if(req.url==='/unlabeled')res.writeHead(200).end('Привіт, plain text without a content type. '.repeat(30));
    else if(req.url==='/ld')res.writeHead(200,{'content-type':'application/ld+json'}).end('{}');
    else if(req.url==='/nd')res.writeHead(200,{'content-type':'application/x-ndjson'}).end('{}\n{}');
    else res.writeHead(200,{'content-type':'application/vnd.api+json'}).end('{"data":[]}');
  });
  await assert.rejects(publicFetch('https://8.8.8.8/image'),error=>error.status===415 && /The response is binary \(image\/png\); use the browser or documents tools for files\./.test(error.message));
  await assert.rejects(publicFetch('https://8.8.8.8/zip'),/binary \(application\/octet-stream\)/);
  await assert.rejects(publicFetch('https://8.8.8.8/unlabeled-binary'),error=>error.status===415);
  const sniffed=await publicFetch('https://8.8.8.8/unlabeled');assert.equal(sniffed.contentType,'');assert.match(sniffed.text,/^Привіт/);
  for(const route of ['/ld','/nd','/vnd'])assert.equal((await publicFetch(`https://8.8.8.8${route}`)).status,200);
});

test('private and non-HTTPS targets stay blocked for POST',async()=>{
  await assert.rejects(publicFetch('https://127.0.0.1/x',{method:'POST',body:'x'}),/Private and reserved/);
  await assert.rejects(publicFetch('http://8.8.8.8/x',{method:'POST'}),/HTTPS/);
});

test('JSON passes through unchanged and long HTML or JSON keep a head/tail window with the omitted count',()=>{
  const json=JSON.stringify({items:Array.from({length:50},(_,i)=>({i}))});
  assert.equal(readableWebContent({url:URL_,status:200,contentType:'application/json',text:json}).text,json);
  const html=readableWebContent({url:URL_,status:200,contentType:'text/html',text:`<p>HEAD${'a'.repeat(99_000)}TAIL</p>`});
  assert.equal(html.extraction.limited,true);assert.equal(html.extraction.omittedChars,99_008-80_000);assert.match(html.text,/^HEAD/);assert.match(html.text,/TAIL$/);
  assert.match(html.text,/\n\[… 19008 characters omitted …\]\n/);assert.match(html.notice,/tool_result_read/);
  const long=`{"start":"${'j'.repeat(450_000)}","end":1}`,windowed=readableWebContent({url:URL_,status:200,contentType:'application/json',text:long});
  assert.equal(windowed.extraction.omittedChars,long.length-400_000);assert.match(windowed.text,/characters omitted/);assert.ok(windowed.text.startsWith('{"start"'));assert.ok(windowed.text.endsWith('"end":1}'));
  assert.match(windowed.notice,/tool_result_read/);assert.equal(windowed.status,200);
  assert.equal(readableWebContent({url:URL_,status:200,contentType:'text/plain',text:'short'}).text,'short');
});

test('http_fetch validates method, headers and body and requires approval for POST unless Approve for me',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-fetch-')),store=await new Store(directory).init();
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const calls=[],tools=new AgentTools(store,{publicFetch:async(url,options)=>{calls.push({url,options});return {url,status:200,method:options.method||'GET',contentType:'application/json',text:'{"ok":1}'};}});
  const bot={...store.state.bots[0],tools:[...new Set([...(store.state.bots[0].tools||[]),'http_fetch','web'])]};
  const withPolicy=approvalPolicy=>({...bot,approvalPolicy});
  assert.equal(tools.requiresApproval('http_fetch',withPolicy('balanced'),{url:URL_}),false);
  assert.equal(tools.requiresApproval('http_fetch',withPolicy('balanced'),{url:URL_,method:'GET'}),false);
  for(const policy of ['balanced','strict'])assert.equal(tools.requiresApproval('http_fetch',withPolicy(policy),{url:URL_,method:'POST'}),true);
  assert.equal(tools.requiresApproval('http_fetch',withPolicy('auto'),{url:URL_,method:'POST'}),false);
  const definition=tools.definitions(bot).find(item=>item.name==='http_fetch');
  assert.ok(definition.description.length<=420);assert.deepEqual(definition.parameters.properties.method.enum,['GET','POST']);assert.equal(definition.parameters.properties.headers.maxProperties,8);
  const strict=withPolicy('balanced');
  await assert.rejects(tools.execute(strict,'http_fetch',{url:URL_,method:'POST',body:{a:1}}),/requires approval/);
  const ok=await tools.execute(strict,'http_fetch',{url:URL_,method:'POST',headers:{Accept:'application/json'},body:{a:1}},{approved:true});
  assert.equal(ok.status,200);assert.equal(ok.method,'POST');assert.deepEqual(calls[0].options.body,{a:1});assert.deepEqual(calls[0].options.headers,{Accept:'application/json'});
  await tools.execute(withPolicy('auto'),'http_fetch',{url:URL_,method:'POST',body:'x=1'});assert.equal(calls.length,2);
  await tools.execute(strict,'http_fetch',{url:URL_});assert.equal(calls[2].options.method,undefined);
  for(const bad of [{method:'DELETE'},{method:'GET',body:'x'},{method:'POST',body:[1]},{method:'POST',body:5},{headers:{authorization:'x'}},{headers:{cookie:'a'}},{headers:[1]}])
    await assert.rejects(tools.execute(withPolicy('auto'),'http_fetch',{url:URL_,...bad}),error=>error.status===400,JSON.stringify(bad));
  await assert.rejects(tools.execute(withPolicy('auto'),'http_fetch',{url:URL_,method:'POST',body:'x'.repeat(200_001)}),error=>error.status===413);
  assert.equal(calls.length,3);
});
