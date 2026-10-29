// macOS/Xcode-only: actual LocalEngineController, isolated QA defaults and fake process spy.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {generateIdentity} from '../../../lib/sync/crypto.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),app=path.resolve(here,'../Tupies');
const out=path.resolve(here,'../build/local-engine-start-tests');
let scratch;const servers=[];
async function run(command,args,options={}){
 const chunks=[];const code=await new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],...options});child.stdout.on('data',v=>chunks.push(v));child.stderr.on('data',v=>chunks.push(v));child.once('error',reject);child.once('close',resolve);});
 const text=Buffer.concat(chunks).toString();if(code!==0){await fs.writeFile(path.join(out,'diagnostics.log'),text,{mode:0o600});throw Error('Native local-start regression failed; private diagnostics are in apps/apple/build/local-engine-start-tests.');}return text;
}
async function serve(handler){const server=createServer((req,res)=>{req.resume();handler(req,res);});servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;}
try{
 assert.equal(process.platform,'darwin');await fs.mkdir(out,{recursive:true});scratch=await fs.mkdtemp(path.join(tmpdir(),'tupies-local-start-'));
 const identity=generateIdentity(),other=generateIdentity();
 const info={product:'hermes-studio',version:'0.5.0',fingerprint:identity.fingerprint,publicKey:identity.publicKey,nodeId:'node_expected',protocols:{deviceSession:2}};
 const json=value=>(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 const online=await serve(json(info)),old=await serve(json({...info,protocols:{deviceSession:1}})),wrongNode=await serve(json({...info,nodeId:'node_other'})),wrongKey=await serve(json({...info,publicKey:other.publicKey,fingerprint:other.fingerprint}));
 const failed=await serve((_req,res)=>{res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"Synthetic failure"}');});
 const malformed=await serve((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"incomplete":true}');}),timeout=await serve(()=>{});
 const dead=createServer();await new Promise(resolve=>dead.listen(0,'127.0.0.1',resolve));const offline=`http://127.0.0.1:${dead.address().port}`;await new Promise(resolve=>dead.close(resolve));
 const bundle=path.join(scratch,'LocalStartProbe.app'),contents=path.join(bundle,'Contents'),resources=path.join(contents,'Resources'),binary=path.join(contents,'MacOS/Probe'),marker=path.join(scratch,'unexpected-process-created');
 await fs.mkdir(path.dirname(binary),{recursive:true});await fs.mkdir(path.join(resources,'Engine'),{recursive:true});await fs.mkdir(path.join(resources,'Runtime'),{recursive:true});
 await fs.writeFile(path.join(resources,'Engine/server.mjs'),'// synthetic process spy only\n');
 const shellQuote=value=>`'${value.replaceAll("'","'\\''")}'`;
 await fs.writeFile(path.join(resources,'Runtime/node'),`#!/bin/sh\n/usr/bin/touch ${shellQuote(marker)}\nexit 99\n`,{mode:0o700});
 const identifier='dev.tupies.qa.local-start.'+randomUUID().toLowerCase();
 const xml=`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>Probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`;
 await fs.writeFile(path.join(contents,'Info.plist'),xml);
 const sources=['Services/LocalEngine.swift','Services/LocalEnginePayload.swift','Services/LocalEngineStartPolicy.swift','Services/AppIdentity.swift','Services/EngineClient.swift','Services/PairingLink.swift','Services/ServerTrust.swift','Services/SigningMessages.swift','Models/Connection.swift','Models/EngineAPI.swift'].map(v=>path.join(app,v));
 await run('swiftc',['-parse-as-library','-module-cache-path',path.join(out,'ModuleCache'),'-o',binary,...sources,path.join(here,'LocalEngineStartTests.swift')]);
 await run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',bundle]);
 const input=path.join(scratch,'fixture.json');await fs.writeFile(input,JSON.stringify({online,old,wrongNode,wrongKey,failed,malformed,timeout,offline,fingerprint:identity.fingerprint,publicKey:identity.publicKey,marker}),{mode:0o600});
 await fs.mkdir(path.join(scratch,'support'),{mode:0o700});
 const env={...process.env,HERMES_STUDIO_APPLICATION_SUPPORT:path.join(scratch,'support'),HERMES_STUDIO_LOCAL_ENGINE_FILE:path.join(scratch,'no-discovery.json')};
 const output=await run(binary,[input],{env});assert.equal(await fs.stat(marker).then(()=>true,()=>false),false);console.log(output.trim());console.log('PASS isolated native controller never launched its process spy; no operational engines or defaults accessed');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{for(const server of servers)server.closeAllConnections();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));if(scratch)await fs.rm(scratch,{recursive:true,force:true});}
