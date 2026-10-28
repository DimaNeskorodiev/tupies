// macOS/Xcode-only regression. Explicitly invoked; not part of npm test on non-Apple hosts.
// Runs the actual Swift EngineClient against real Tupies HTTP routes and disposable data.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStudioServer} from '../../../server.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../../..');
const out=path.resolve(here,'../build/notification-client-tests');
const appSources=path.resolve(here,'../Tupies');
const log=path.join(out,'notification-client.log');
let app, directory;

async function run(command,args) {
  const chunks=[];
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>chunks.push(chunk));
    child.once('error',reject);child.once('close',resolve);
  });
  const output=Buffer.concat(chunks).toString();
  if(code!==0){await fs.writeFile(log,output,{mode:0o600});throw new Error('Native client regression failed; private diagnostics are in apps/apple/build/notification-client-tests/notification-client.log.');}
  return output;
}

try {
  assert.equal(process.platform,'darwin','This explicit native-client regression requires macOS and Xcode.');
  await fs.mkdir(out,{recursive:true});
  const binary=path.join(out,'notification-client-tests');
  const sources=[
    'Services/EngineClient.swift','Models/EngineAPI.swift','Models/Connection.swift',
    'Services/ServerTrust.swift','Services/SigningMessages.swift',
  ].map(name=>path.join(appSources,name));
  await run('swiftc',['-parse-as-library','-module-cache-path',path.join(out,'ModuleCache'),'-o',binary,...sources,path.join(here,'NotificationClientTests.swift')]);

  directory=await fs.mkdtemp(path.join(tmpdir(),'studio-native-notification-client-'));
  const transport={available:true,environment:'sandbox',async send(){return {status:200};},close(){}};
  app=await createStudioServer({dataDir:directory,scheduler:false,tls:'off',publicUrl:'',logErrors:false,notifications:{transport}});
  const deviceId='dev_native_notification_fixture';
  await app.store.mutate(state=>{state.devices.push({id:deviceId,name:'Native client fixture',kind:'device',platform:'ios'});});
  const token='hsd_'+randomBytes(32).toString('base64url');
  app.sync.devices.sessions.set(token,{deviceId,expires:Date.now()+60_000});
  const requests=[];
  app.server.on('request',req=>{
    if(req.url==='/api/device/notifications')requests.push({method:req.method,json:req.headers['content-type']==='application/json',bytes:Number(req.headers['content-length'] || 0),bearer:req.headers.authorization===`Bearer ${token}`});
  });
  const {url}=await app.listen(0);
  const input=path.join(directory,'native-client-input.json');
  await fs.writeFile(input,JSON.stringify({url,token}),{mode:0o600});
  const output=await run(binary,[input]);
  assert.deepEqual(requests.map(request=>request.method),['GET','PUT','GET','DELETE','GET']);
  assert.ok(requests.every(request=>request.bearer),'Every native call must carry its paired-device bearer.');
  assert.equal(requests[1].json,true);assert.ok(requests[1].bytes>0);
  assert.equal(requests[3].json,true,'Native DELETE must declare JSON.');
  assert.equal(requests[3].bytes,2,'Native DELETE must send the empty JSON object.');
  assert.equal(Object.keys(app.notifications.state.subscriptions).length,0);
  assert.equal(output.trim().split('\n').length,3);
  assert.ok(output.trim().split('\n').every(line=>line.startsWith('PASS native notification ')));
  console.log(output.trim());
  console.log('PASS native notification bearer and JSON HTTP contract');
} catch(error) {
  // EngineClient intentionally emits only static messages. Do not dump requests, tokens or state.
  console.error(error instanceof assert.AssertionError ? 'Native notification HTTP contract assertion failed.' : error.message);
  process.exitCode=1;
} finally {
  if(app)await app.close();
  if(directory)await fs.rm(directory,{recursive:true,force:true});
}
