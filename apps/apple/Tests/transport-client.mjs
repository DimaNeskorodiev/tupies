// Explicit macOS/Xcode regression: real Swift URLSession requests, disposable HTTP origins.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const app=path.resolve(here,'../Tupies');
const out=path.resolve(here,'../build/transport-client-tests');
const servers=[];
let directory;
async function run(command,args) {
  const chunks=[];
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>chunks.push(chunk));
    child.once('error',reject);child.once('close',resolve);
  });
  const output=Buffer.concat(chunks).toString();
  if(code!==0)throw new Error(`Native transport fixture failed (${command === 'swiftc' ? 'compile' : 'HTTP contract'}).`);
  return output;
}
async function listen(handler) {
  const server=createServer(handler);servers.push(server);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return `http://127.0.0.1:${server.address().port}`;
}
try {
  assert.equal(process.platform,'darwin','Requires macOS and Xcode.');
  await fs.mkdir(out,{recursive:true});
  const binary=path.join(out,'transport-client-tests');
  const sources=['Services/EngineClient.swift','Models/EngineAPI.swift','Models/Connection.swift','Services/ServerTrust.swift','Services/SigningMessages.swift'].map(name=>path.join(app,name));
  await run('swiftc',['-parse-as-library','-module-cache-path',path.join(out,'ModuleCache'),'-o',binary,...sources,path.join(here,'TransportClientTests.swift')]);
  let crossed=0;
  const foreign=await listen((req,res)=>{crossed++;req.resume();res.writeHead(200,{'content-type':'application/json'});res.end('{}');});
  const requests=[];
  const origin=await listen((req,res)=>{
    requests.push(req.url);req.resume();
    if(req.url==='/api/engine') {res.writeHead(307,{location:'/identity'});res.end();return;}
    if(req.url==='/identity') {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({product:'hermes-studio',fingerprint:'fixture',publicKey:'fixture'}));return;}
    res.writeHead(307,{location:`${foreign}/sink`});res.end();
  });
  directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-native-transport-'));
  const input=path.join(directory,'fixture.json');await fs.writeFile(input,JSON.stringify({url:origin}));
  let output, failure;
  try {output=await run(binary,[input]);} catch(error) {failure=error;}
  assert.equal(crossed,0,'A redirect must never send pairing/session/push credentials to a different origin.');
  if(failure)throw failure;
  assert.deepEqual(requests,['/api/engine','/identity','/api/pair','/api/device/session','/api/device/notifications']);
  console.log(output.trim());
  console.log('PASS native transport sent no requests to the foreign origin');
} catch(error) {
  console.error(error.message);process.exitCode=1;
} finally {
  await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
  if(directory)await fs.rm(directory,{recursive:true,force:true});
}
