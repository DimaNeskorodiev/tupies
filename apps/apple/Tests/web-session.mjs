// Explicit macOS-only WebKit regression. --compile-only never starts an engine or WebKit.
// --run-webkit uses disposable local engines, a unique app identity/home and RAM-only keys.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import http from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStudioServer} from '../../../server.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../../..'),appSources=path.join(here,'../Tupies');
assert.equal(process.platform,'darwin','This explicit WebKit fixture requires macOS.');
assert.ok([3,4].includes(process.argv.length)&&['--compile-only','--run-webkit'].includes(process.argv[2])&&(process.argv.length===3||['--baseline-v7','--baseline-v8-web'].includes(process.argv[3])),'Choose --compile-only or --run-webkit explicitly.');
const runWebKit=process.argv[2]==='--run-webkit';
const baseline=process.argv[3]==='--baseline-v7';
const baselineWeb=process.argv[3]==='--baseline-v8-web';
let baselineWebSource;
if(baselineWeb){const archive=path.join(root,'.runtime/production-hardening-20261028');const manifestBytes=await fs.readFile(path.join(archive,'release-manifest-v8.json'));assert.equal(createHash('sha256').update(manifestBytes).digest('hex'),'bdfbec2e0f1b381e9077473aa8e74289a38250ba22e14cd2ac1444339a2fe97f');const entry=JSON.parse(manifestBytes).files.find(file=>file.path==='public/app.js');baselineWebSource=await fs.readFile(path.join(archive,'release-v8/public/app.js'));assert.equal(createHash('sha256').update(baselineWebSource).digest('hex'),entry.sha256);}
for(const name of Object.keys(process.env))if(name.startsWith('STUDIO_'))delete process.env[name];
const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-web-session-fixture-'));
await fs.chmod(directory,0o700);
const appBundle=path.join(directory,'WebSessionFixture.app'),macOS=path.join(appBundle,'Contents/MacOS');
const binary=path.join(macOS,'WebSessionFixture'),fixtures=[];
let controls;
const controlSecret=randomBytes(32).toString('base64url');
const cleanEnvironment={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(directory,'home'),CFFIXED_USER_HOME:path.join(directory,'home'),TMPDIR:path.join(directory,'tmp'),LANG:'en_US.UTF-8'};
await Promise.all([macOS,cleanEnvironment.HOME,cleanEnvironment.TMPDIR].map(p=>fs.mkdir(p,{recursive:true,mode:0o700})));

async function run(command,args,{input,env,timeout=120_000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,env,stdio:['pipe','pipe','pipe']}),output=[];
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Synthetic native fixture timed out.'));},timeout);
    child.stdout.on('data',b=>output.push(b));child.stderr.on('data',b=>output.push(b));
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',async code=>{clearTimeout(timer);const text=Buffer.concat(output).toString();if(code!==0){const logs=path.join(here,'../build/web-session-tests');await fs.mkdir(logs,{recursive:true,mode:0o700});await fs.chmod(logs,0o700);await fs.writeFile(path.join(logs,'last-failure.log'),text,{mode:0o600});reject(new Error('Synthetic native fixture failed; private fixture diagnostics are in apps/apple/build/web-session-tests/last-failure.log.'));}else resolve(text);});
    child.stdin.end(input);
  });
}

async function fixture(passwordRequired){
  const item={index:fixtures.length,passwordRequired,dataDir:path.join(directory,`data-${fixtures.length}`),app:null,port:0,holds:new Set(),waiting:new Set(),refuseTickets:false,authFalse:0,counts:{pair:0,session:0,ticket:0,auth:0,authFalse:0,state:0,mutation:0}};
  fixtures.push(item);
  const start=async()=>{
    item.app=await createStudioServer({dataDir:item.dataDir,scheduler:false,tls:'off',publicUrl:'',logErrors:false,apns:{env:{}},sync:{engineName:'Synthetic WebKit engine'}});
    const original=item.app.server.listeners('request');assert.equal(original.length,1);item.app.server.removeAllListeners('request');
    item.app.server.on('request',async(req,res)=>{
      const pathname=new URL(req.url,'http://127.0.0.1').pathname;
      if(baselineWebSource&&pathname==='/app.js'){res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});res.end(baselineWebSource);return;}
      const key=({'/api/pair':'pair','/api/device/session':'session','/api/device/web-ticket':'ticket','/api/auth':'auth','/api/state':'state'})[pathname];if(key)item.counts[key]++;
      if(!['GET','HEAD'].includes(req.method)&&!['/api/pair','/api/device/session','/api/device/web-ticket','/api/setup'].includes(pathname))item.counts.mutation++;
      if(item.holds.has(pathname))await new Promise(resolve=>{const waiter={pathname,resolve};item.waiting.add(waiter);res.once('close',()=>{item.waiting.delete(waiter);resolve();});});
      if(res.destroyed)return;
      if(pathname==='/__fixture/download'){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="synthetic-webkit.txt"','Cache-Control':'no-store'});res.end('SYNTHETIC_WEBKIT_DOWNLOAD');return;}
      if(pathname==='/auth/device'&&item.refuseTickets){res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'Synthetic ticket refusal'}));return;}
      if(pathname==='/api/auth'&&item.authFalse>0){item.authFalse--;item.counts.authFalse++;res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({authenticated:false,setupRequired:!passwordRequired,csrf:null,passwordSignIn:true}));return;}
      original[0](req,res);
    });
    const listening=await item.app.listen(item.port,'127.0.0.1');item.port=listening.port;item.url=listening.url;
  };
  item.start=start;await start();
  if(passwordRequired){const response=await fetch(item.url+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:item.app.bootstrapToken,password:'synthetic-webkit-only-password'})});assert.equal(response.status,201);}
  await item.app.store.mutate(state=>{
    state.messages.bot_atlas=[{id:'message_webkit_bot',role:'assistant',content:'SYNTHETIC_WEBKIT_BOT_CONTENT',createdAt:new Date().toISOString()}];
    state.rooms.push({id:'room_webkit',name:'Synthetic WebKit room',botIds:['bot_atlas','bot_nova'],autoCollaborate:false,maxRounds:1});
    state.roomMessages.room_webkit=[{id:'message_webkit_room',role:'assistant',botId:'bot_atlas',content:'SYNTHETIC_WEBKIT_ROOM_CONTENT',createdAt:new Date().toISOString()}];
  });
  const pairing=item.app.sync.devices.createPairing({kind:'device',baseUrl:item.url});
  return {index:item.index,url:item.url,code:pairing.code,fingerprint:pairing.fingerprint,passwordRequired};
}

async function handleControl(req,res){
  try{
    assert.equal(req.method,'POST');assert.equal(req.url,'/fixture');assert.equal(req.headers.authorization,`Bearer ${controlSecret}`);
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;assert.ok(size<4096);chunks.push(chunk);}
    const command=JSON.parse(Buffer.concat(chunks).toString()),item=fixtures[command.index];assert.ok(item);
    if(command.action==='hold-auth')item.holds.add('/api/auth');
    else if(command.action==='hold-state')item.holds.add('/api/state');
    else if(command.action==='hold-page')item.holds.add('/');
    else if(command.action==='release'){item.holds.clear();for(const waiter of item.waiting)waiter.resolve();item.waiting.clear();}
    else if(command.action==='add-late-bot'){await item.app.store.mutate(state=>{assert.ok(!state.bots.some(bot=>bot.id==='bot_late_webkit'));state.bots.push({...structuredClone(state.bots[0]),id:'bot_late_webkit',name:'Late WebKit bot',hidden:false});state.messages.bot_late_webkit=[{id:'message_late_webkit',role:'assistant',content:'SYNTHETIC_WEBKIT_LATE_BOT_CONTENT',createdAt:new Date().toISOString()}];});}
    else if(command.action==='add-late-room'){await item.app.store.mutate(state=>{assert.ok(!state.rooms.some(room=>room.id==='room_late_webkit'));state.rooms.push({id:'room_late_webkit',name:'Late WebKit room',botIds:['bot_atlas','bot_nova'],autoCollaborate:false,maxRounds:1});state.roomMessages.room_late_webkit=[{id:'message_late_room_webkit',role:'assistant',botId:'bot_atlas',content:'SYNTHETIC_WEBKIT_LATE_ROOM_CONTENT',createdAt:new Date().toISOString()}];});}
    else if(command.action==='auth-false-once')item.authFalse=1;
    else if(command.action==='refuse-tickets')item.refuseTickets=true;
    else if(command.action==='restart'){assert.equal(item.waiting.size,0);await item.app.close();await item.start();}
    else assert.equal(command.action,'status');
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,counts:item.counts,waiting:[...item.waiting].map(x=>x.pathname)}));
  }catch{res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":"Synthetic control refused"}');}
}

try{
  const sources=['Services/EngineClient.swift','Models/EngineAPI.swift','Models/Connection.swift','Services/ServerTrust.swift','Services/SigningMessages.swift','Models/NotificationDestination.swift','Views/Web/EngineWebSession.swift'];
  // The production lifecycle type is included when present, never a copied implementation.
  for(const name of ['Services/WebSessionReadiness.swift'])if(await fs.stat(path.join(appSources,name)).then(()=>true,()=>false))sources.push(name);
  let compileSources=sources.map(name=>path.join(appSources,name));
  if(baseline){
    const frozen=path.join(root,'.runtime/production-hardening-20261028'),manifestBytes=await fs.readFile(path.join(frozen,'release-manifest-v7.json'));
    assert.equal(createHash('sha256').update(manifestBytes).digest('hex'),'9ce4c7d41d458bb3e5d8266e4095ec99cabc7e357922be92df1d2dadaa184dfe');
    const manifest=JSON.parse(manifestBytes);
    const name='apps/apple/Tupies/Views/Web/EngineWebSession.swift',source=path.join(frozen,'release-v7',name),entry=manifest.files.find(file=>file.path===name);
    assert.ok(entry);assert.equal(createHash('sha256').update(await fs.readFile(source)).digest('hex'),entry.sha256);
    compileSources=compileSources.map(file=>file===path.join(appSources,'Views/Web/EngineWebSession.swift')?source:file);
    const shim=path.join(directory,'BaselineQueueObservation.swift');
    await fs.writeFile(shim,'import Foundation\n@MainActor extension EngineWebSession { var pendingNotification: NotificationDestination? { Mirror(reflecting: self).children.first { $0.label == "notificationNavigation" }.flatMap { ($0.value as? NotificationNavigation)?.pending } } }\n',{mode:0o600});
    compileSources.push(shim);
  }
  const bundleID=`dev.tupies.synthetic.web-session.${randomUUID().toLowerCase()}`;
  await fs.writeFile(path.join(appBundle,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleID}</string><key>CFBundleExecutable</key><string>WebSessionFixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`,{mode:0o600});
  const swiftSources=[...compileSources,path.join(here,'WebSessionTests.swift')];
  const sourceHashes=await Promise.all(swiftSources.map(async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex')));
  const verifyCompiledSources=async()=>{assert.deepEqual(await Promise.all(swiftSources.map(async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex'))),sourceHashes,'Compiled native sources must remain unchanged throughout the real fixture.');};
  await run('/usr/bin/xcrun',['swiftc','-parse-as-library','-module-cache-path',path.join(directory,'ModuleCache'),'-o',binary,...swiftSources],{timeout:180_000});
  await verifyCompiledSources();
  console.log('PASS actual EngineWebSession isolated native harness compilation');
  if(runWebKit){
    const inputs=[await fixture(false),await fixture(true)];
    controls=http.createServer((req,res)=>{handleControl(req,res).catch(()=>res.destroy());});
    await new Promise(resolve=>controls.listen(0,'127.0.0.1',resolve));
    const output=await run(binary,[],{input:JSON.stringify({fixtures:inputs,controlURL:`http://127.0.0.1:${controls.address().port}/fixture`,controlSecret,expectedHome:cleanEnvironment.HOME}),env:cleanEnvironment,timeout:180_000});
    const lines=output.split('\n').filter(x=>x.startsWith('PASS synthetic WebKit '));assert.equal(lines.length,21,'The complete real WebKit scenarios must run.');
    for(const item of fixtures){assert.equal(item.counts.pair,1);assert.ok(item.counts.session>=2);assert.equal(item.counts.mutation,0);}
    console.log(lines.join('\n'));console.log('PASS synthetic WebKit no task/provider/push mutations');
  }
  await verifyCompiledSources();
  console.log('PASS actual native source binding remained unchanged');
}catch(error){console.error(error instanceof assert.AssertionError?'Synthetic native WebKit assertion failed.':error.message);process.exitCode=1;}
finally{
  for(const item of fixtures){item.holds.clear();for(const waiter of item.waiting)waiter.resolve();await item.app?.close();}
  if(controls)await new Promise(resolve=>controls.close(resolve));
  // WebKit's own helper processes can finish cache writes just after the fixture
  // executable exits. Retry removal of this uniquely owned temporary tree only.
  await fs.rm(directory,{recursive:true,force:true,maxRetries:12,retryDelay:100});
}
