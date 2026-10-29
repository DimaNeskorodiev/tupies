// macOS/Xcode-only security contract: actual Swift transport and real disposable TLS engines.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {createServer as createHTTPServer} from 'node:http';
import {createServer as createHTTPSServer} from 'node:https';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStudioServer} from '../../../server.mjs';
import {generateIdentity} from '../../../lib/sync/crypto.mjs';
import {identityCertificate} from '../../../lib/sync/certificate.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(here,'../build/security-client-tests');
const sources=path.resolve(here,'../Tupies');
let directory;
const apps=[],servers=[];
async function run(command,args) {
  const chunks=[];
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>chunks.push(chunk));
    child.once('error',reject);child.once('close',resolve);
  });
  const output=Buffer.concat(chunks).toString();
  if(code!==0) {
    await fs.writeFile(path.join(out,'diagnostics.log'),output,{mode:0o600});
    throw new Error(`Native security contract failed (${command==='swiftc'?'compile':'Swift checks'}); diagnostics are in apps/apple/build/security-client-tests/diagnostics.log.`);
  }
  return output;
}
async function listen(server,scheme) {
  servers.push(server);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return `${scheme}://127.0.0.1:${server.address().port}`;
}
try {
  assert.equal(process.platform,'darwin','Requires macOS and Xcode.');
  await fs.mkdir(out,{recursive:true});
  directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-native-security-'));
  const binary=path.join(out,'security-client-tests');
  const files=['Services/EngineClient.swift','Services/PairingLink.swift','Services/SigningMessages.swift','Services/ServerTrust.swift','Models/Connection.swift','Models/EngineAPI.swift'].map(name=>path.join(sources,name));
  await run('swiftc',['-parse-as-library','-module-cache-path',path.join(out,'ModuleCache'),'-o',binary,...files,path.join(here,'SecurityClientTests.swift')]);
  const keyFile=path.join(directory,'key.json');
  await run(binary,['prepare',keyFile]);
  const key=JSON.parse(await fs.readFile(keyFile,'utf8'));
  const deviceId='dev_native_security_fixture';
  for(const name of ['a','b']) {
    const app=await createStudioServer({dataDir:path.join(directory,name),scheduler:false,tls:'engine',publicUrl:'',logErrors:false});
    apps.push(app);
    await app.store.mutate(state=>{state.devices.push({id:deviceId,name:'Native security fixture',kind:'device',platform:'ios',publicKey:key.publicKey});});
  }
  const [appA,appB]=apps;
  const a=await appA.listen(0),b=await appB.listen(0);
  const linkA=appA.sync.devices.createPairing({baseUrl:a.url}).link;
  const linkB=appB.sync.devices.createPairing({baseUrl:b.url}).link;
  assert.equal(new URL(linkA).searchParams.get('tls'),'engine','Actual emitted device links must require first-contact engine pinning.');
  let wrongRequests=0;
  const wrongIdentity=generateIdentity();
  const wrongTLS=await listen(createHTTPSServer({key:wrongIdentity.privateKey,cert:identityCertificate(wrongIdentity.privateKey,{hosts:['127.0.0.1']})},(req,res)=>{wrongRequests++;req.resume();res.end('{}');}),'https');
  const oldRequests=[];
  const oldEngine=await listen(createHTTPServer((req,res)=>{
    oldRequests.push({method:req.method,path:req.url});req.resume();res.setHeader('content-type','application/json');
    res.end(JSON.stringify({product:'hermes-studio',nodeId:appA.sync.nodeId,fingerprint:appA.sync.identity.fingerprint,publicKey:appA.sync.identity.publicKey}));
  }),'http');
  const input=path.join(directory,'input.json');
  await fs.writeFile(input,JSON.stringify({key,linkA,linkB,nodeA:appA.sync.nodeId,nodeB:appB.sync.nodeId,wrongTLS,oldEngine,deviceId}),{mode:0o600});
  const output=await run(binary,['test',input]);
  assert.equal(wrongRequests,0,'TLS mismatch must fail before HTTP headers or bodies.');
  assert.deepEqual(oldRequests,[{method:'GET',path:'/api/engine'}],'Old engines never receive a session proof or pairing code.');
  for(const app of apps)assert.equal(app.store.state.devices.filter(device=>device.id===deviceId&&!device.revokedAt).length,1,'Existing paired keys remain valid.');
  console.log(output.trim());
  console.log('PASS native security credential boundaries and existing-device preservation');
} catch(error) {
  console.error(error instanceof assert.AssertionError?'Native security fixture boundary assertion failed.':error.message);process.exitCode=1;
} finally {
  for(const app of apps)await app.close();
  for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(directory)await fs.rm(directory,{recursive:true,force:true});
}
