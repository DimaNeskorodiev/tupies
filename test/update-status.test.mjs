import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {createStudioServer} from '../server.mjs';
import {EngineUpdates,releaseLabel} from '../lib/update-status.mjs';
import {signedManifest} from '../lib/update-artifacts.mjs';
import {classify,projectVersion,versionProblems,markdown,releaseOutcome,mergeReleaseNotes} from '../scripts/update-impact.mjs';

const DAY=86400_000,NOW=Date.parse('2026-11-16T10:00:00Z');
const keys=generateKeyPairSync('ed25519'),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}),publicKey=keys.publicKey.export({type:'spki',format:'pem'});
const FEED='https://updates.example/engine-beta-linux-x64.json';
const manifest=(overrides={})=>({schema:1,product:'tupies-engine',id:'0.5.0-engine.beta.11',version:'0.5.0-engine.beta.11',sequence:NOW-DAY,channel:'beta',platform:'linux',arch:'x64',dataEpoch:'1',maintenanceProtocol:1,publishedAt:new Date(NOW-DAY).toISOString(),expiresAt:new Date(NOW+29*DAY).toISOString(),files:[{path:'server.mjs',size:1,mode:0o644,sha256:'a'.repeat(64)}],archive:{url:'https://updates.example/engine.gz',size:10,sha256:'b'.repeat(64)},...overrides});

/** A throwaway installed copy: package.json, the pinned channel and whichever identity file the case needs. */
async function installedCopy(t,{release,build,apps}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-update-status-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'assets/updates'),{recursive:true});
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'tupies',version:'0.5.0'}));
  await fs.writeFile(path.join(root,'assets/updates/release-channels.json'),JSON.stringify({schema:1,channel:'beta',engine:{feedURL:FEED,publicKey}}));
  if(release)await fs.writeFile(path.join(root,'engine-release.json'),JSON.stringify(release));
  if(build)await fs.writeFile(path.join(root,'assets/updates/build.json'),JSON.stringify(build));
  if(apps)await fs.writeFile(path.join(root,'assets/updates/native-apps.json'),JSON.stringify(apps));
  return root;
}
const feed=(release,key=privateKey)=>async()=>new Response(JSON.stringify(signedManifest(release,key)),{status:200});
const beta10={id:'0.5.0-engine.beta.10',sequence:NOW-5*DAY,dataEpoch:'1',version:'0.5.0-engine.beta.10'};

test('release names read as people say them',()=>{
  assert.equal(releaseLabel('0.5.0-engine.beta.10'),'0.5.0 beta 10');
  assert.equal(releaseLabel('1.2.0-rc.1'),'1.2.0 rc 1');
  assert.equal(releaseLabel('1.2.0'),'1.2.0');
  assert.equal(releaseLabel('fixture-2'),'fixture-2');
});

test('an installed release learns about a newer signed release and nothing is fetched until asked',async t=>{
  let fetched=0;const publish=feed(manifest());
  const updates=new EngineUpdates({root:await installedCopy(t,{release:beta10}),env:{},clock:()=>NOW,fetcher:(...args)=>{fetched++;return publish(...args);}});
  const before=await updates.status();
  assert.deepEqual([before.installed.kind,before.installed.label,before.latest,before.updateAvailable,before.checkedAt,fetched],['release','0.5.0 beta 10',null,null,null,0]);
  const after=await updates.check();
  assert.equal(fetched,1);assert.equal(after.updateAvailable,true);assert.equal(after.error,'');
  assert.deepEqual([after.latest.id,after.latest.label,after.latest.expired],['0.5.0-engine.beta.11','0.5.0 beta 11',false]);
  assert.equal(after.install.mode,'manual');
});

test('the same release is up to date, and a feed signed by another key is refused without changing what is known',async t=>{
  const root=await installedCopy(t,{release:{...beta10,id:'0.5.0-engine.beta.11',sequence:NOW-DAY}});
  const current=await new EngineUpdates({root,env:{},clock:()=>NOW,fetcher:feed(manifest())}).check();
  assert.equal(current.updateAvailable,false);
  const other=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});
  const forged=await new EngineUpdates({root,env:{},clock:()=>NOW,fetcher:feed(manifest({sequence:NOW}),other)}).check();
  assert.equal(forged.latest,null);assert.equal(forged.updateAvailable,null);assert.match(forged.error,/Could not read the release channel/);
});

test('an expired feed still names the last release but cannot be installed from the app',async t=>{
  const file=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'tupies-update-request-')),'request');t.after(()=>fs.rm(path.dirname(file),{recursive:true,force:true}));
  const old=manifest({publishedAt:new Date(NOW-40*DAY).toISOString(),expiresAt:new Date(NOW-10*DAY).toISOString(),sequence:NOW-40*DAY});
  const updates=new EngineUpdates({root:await installedCopy(t,{release:{...beta10,sequence:NOW-60*DAY}}),env:{STUDIO_UPDATE_REQUEST_FILE:file},clock:()=>NOW,fetcher:feed(old)});
  const status=await updates.check();
  assert.equal(status.latest.expired,true);assert.equal(status.updateAvailable,true);
  await assert.rejects(updates.requestInstall(),error=>error.status===409);
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
});

test('a staged build is compared by its commit time, and a source checkout makes no claim',async t=>{
  const build={commit:'8c17afecce3e75b211958a1feb528a05f6aaab76',committedAt:new Date(NOW-3*DAY).toISOString()};
  const older=await new EngineUpdates({root:await installedCopy(t,{build}),env:{},clock:()=>NOW,fetcher:feed(manifest())}).check();
  assert.deepEqual([older.installed.kind,older.installed.label,older.updateAvailable],['build','0.5.0 (8c17afe)',true]);
  const tagged=await new EngineUpdates({root:await installedCopy(t,{build:{...build,release:'0.5.0-engine.beta.11'}}),env:{},clock:()=>NOW,fetcher:feed(manifest())}).check();
  assert.deepEqual([tagged.installed.label,tagged.updateAvailable],['0.5.0 beta 11',false]);
  // Built from the release's own commit, three days before it was published and without knowing its name.
  const same=await new EngineUpdates({root:await installedCopy(t,{build}),env:{},clock:()=>NOW,fetcher:feed(manifest({commit:build.commit}))}).check();
  assert.deepEqual([same.installed.label,same.installed.id,same.updateAvailable],['0.5.0 beta 11','0.5.0-engine.beta.11',false]);
  const source=await new EngineUpdates({root:await installedCopy(t),env:{},clock:()=>NOW,fetcher:feed(manifest())}).check();
  assert.deepEqual([source.installed.kind,source.installed.label,source.updateAvailable],['development','0.5.0 development copy',null]);
});

test('Update now only touches the operator’s request file, only for a known newer release, at most once a minute',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-update-request-')),file=path.join(folder,'request');t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  let time=NOW;
  const updates=new EngineUpdates({root:await installedCopy(t,{release:beta10}),env:{STUDIO_UPDATE_REQUEST_FILE:file,STUDIO_UPDATE_HOLD_FILE:path.join(folder,'hold')},clock:()=>time,fetcher:feed(manifest()),maintenance:{paused:false}});
  assert.equal((await updates.status()).install.mode,'request');
  await assert.rejects(updates.requestInstall(),error=>error.status===409&&/Check for updates first/.test(error.message));
  await updates.check();
  const requested=await updates.requestInstall();
  assert.equal(requested.install.requestedAt,new Date(NOW).toISOString());
  assert.equal(await fs.readFile(file,'utf8'),`${new Date(NOW).toISOString()}\n`);
  assert.deepEqual((await fs.readdir(folder)).sort(),['request']);
  await assert.rejects(updates.requestInstall(),error=>error.status===429);
  time+=61_000;await updates.requestInstall();
  assert.equal(await fs.readFile(file,'utf8'),`${new Date(time).toISOString()}\n`);
  const automatic=new EngineUpdates({root:updates.root,env:{STUDIO_UPDATE_HOLD_FILE:path.join(folder,'hold')},clock:()=>NOW,fetcher:feed(manifest())});
  assert.equal((await automatic.check()).install.mode,'automatic');
  await assert.rejects(automatic.requestInstall(),error=>error.status===409);
  const relative=new EngineUpdates({root:updates.root,env:{STUDIO_UPDATE_REQUEST_FILE:'request'},clock:()=>NOW});
  assert.equal(relative.installMode(),'manual');
});

test('the update routes need the owner’s session and report the native app builds this web UI expects',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-update-api-'));
  const root=await installedCopy(t,{release:beta10,apps:{schema:1,ios:{version:'0.5.0',build:12,minimumBuild:10,testflightURL:'https://testflight.apple.com/join/AbCd1234'},mac:{version:'0.5.0',build:12,minimumBuild:10,testflightURL:'javascript:alert(1)'}}});
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,updates:{root,env:{},clock:()=>NOW,fetcher:feed(manifest())}});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await app.listen(0,'127.0.0.1');
  for(const [route,method] of [['/api/update','GET'],['/api/update/check','POST'],['/api/update/install','POST']])assert.equal((await fetch(url+route,{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})})).status,401);
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'update-status-disposable-password'})});
  assert.equal(setup.status<300,true,`setup returned ${setup.status}`);
  const headers={Cookie:setup.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':(await setup.json()).csrf,'Content-Type':'application/json'};
  const status=await (await fetch(url+'/api/update',{headers})).json();
  assert.deepEqual([status.installed.label,status.latest,status.install.mode,status.install.installing],['0.5.0 beta 10',null,'manual',false]);
  assert.deepEqual(status.apps,{ios:{version:'0.5.0',build:12,minimumBuild:10,testflightURL:'https://testflight.apple.com/join/AbCd1234'},mac:{version:'0.5.0',build:12,minimumBuild:10}});
  const checked=await (await fetch(url+'/api/update/check',{method:'POST',headers,body:'{}'})).json();
  assert.equal(checked.updateAvailable,true);assert.equal(checked.latest.label,'0.5.0 beta 11');
  assert.equal((await fetch(url+'/api/update/install',{method:'POST',headers,body:'{}'})).status,409);
});

test('a change is sorted into Engine, iPhone app and Mac app; documentation and tests reach none',()=>{
  const sorted=classify(['lib/runtime.mjs','public/app.js','assets/updates/native-apps.json','scripts/check-sandbox.mjs','scripts/update-impact.mjs','docs/updates.md','test/a.test.mjs','.github/workflows/ci.yml','apps/apple/README.md','apps/apple/Tests/WebSessionTests.swift','apps/apple/Tupies/Views/Web/EngineWebSession.swift','apps/apple/NotificationService/NotificationService.swift','apps/apple/Tupies/Services/MacUpdates.swift','apps/apple/Tupies.xcodeproj/project.pbxproj']);
  assert.deepEqual(sorted.engine,['lib/runtime.mjs','public/app.js','assets/updates/native-apps.json','scripts/check-sandbox.mjs']);
  assert.deepEqual(sorted.ios,['apps/apple/Tupies/Views/Web/EngineWebSession.swift','apps/apple/NotificationService/NotificationService.swift','apps/apple/Tupies.xcodeproj/project.pbxproj']);
  assert.deepEqual(sorted.mac,['apps/apple/Tupies/Views/Web/EngineWebSession.swift','apps/apple/Tupies/Services/MacUpdates.swift','apps/apple/Tupies.xcodeproj/project.pbxproj']);
});

test('version numbers must agree, and native changes after a release need a new build number',()=>{
  const project=projectVersion('CURRENT_PROJECT_VERSION = 12;\nMARKETING_VERSION = 0.5.0;\nCURRENT_PROJECT_VERSION = 12;\nMARKETING_VERSION = 0.5.0;');
  assert.deepEqual(project,{version:'0.5.0',build:12});
  assert.throws(()=>projectVersion('CURRENT_PROJECT_VERSION = 12;\nCURRENT_PROJECT_VERSION = 13;\nMARKETING_VERSION = 0.5.0;'),/share one numeric CURRENT_PROJECT_VERSION/);
  const apps={ios:{version:'0.5.0',build:12,minimumBuild:10,testflightURL:''},mac:{version:'0.5.0',build:12,minimumBuild:10}};
  assert.deepEqual(versionProblems({packageVersion:'0.5.0',project,nativeApps:apps,nativeChanged:true,releasedBuild:11}),[]);
  assert.match(versionProblems({packageVersion:'0.5.0',project,nativeApps:apps,nativeChanged:true,releasedBuild:12})[0],/Raise the build number/);
  assert.deepEqual(versionProblems({packageVersion:'0.5.0',project,nativeApps:apps,nativeChanged:false,releasedBuild:12}),[]);
  assert.match(versionProblems({packageVersion:'0.6.0',project,nativeApps:apps,nativeChanged:false,releasedBuild:12})[0],/package\.json says 0\.6\.0/);
  assert.equal(versionProblems({packageVersion:'0.5.0',project,nativeApps:{...apps,ios:{...apps.ios,build:11}},nativeChanged:false,releasedBuild:null}).length,1);
  assert.match(versionProblems({packageVersion:'0.5.0',project,nativeApps:{...apps,ios:{...apps.ios,testflightURL:'https://example.com/join/x'}},nativeChanged:false,releasedBuild:null})[0],/testflightURL/);
});

test('the note says in words whether the iPhone app needs a new build',()=>{
  const base={project:{version:'0.5.0',build:12},problems:[]};
  const webOnly=markdown({...base,engine:true,ios:false,mac:false});
  assert.match(webOnly,/\| iPhone app \| No \| No new build\. Pull down/);
  const native=markdown({...base,engine:true,ios:true,mac:true},{heading:'What to update after this merges'});
  assert.match(native,/^### What to update after this merges/);assert.match(native,/\| iPhone app \| \*\*Yes\*\* \| Needs a new build: \*\*0\.5\.0 \(12\)\*\*/);
  assert.match(markdown({...base,engine:false,ios:false,mac:false}),/Nothing reaches an installed Engine or app/);
  assert.match(markdown({...base,engine:false,ios:true,mac:true,problems:['Raise the build number.']}),/\*\*Needs attention:\*\*\n- Raise the build number\./);
});

test('a release says what was published and what is still to do, and rewrites only its own note',()=>{
  const project={version:'0.5.0',build:12};
  const webOnly=releaseOutcome({project,ios:false,mac:false},{engine:'success',mac:'skipped',iphone:'skipped'});
  assert.deepEqual(webOnly,['- **Engine:** published. Servers install it by themselves when idle.','- **Mac app:** unchanged.','- **iPhone app:** unchanged. No new build is needed.']);
  const native=releaseOutcome({project,ios:true,mac:true},{engine:'success',mac:'skipped',iphone:'skipped',testflight:false});
  assert.match(native[1],/build 0\.5\.0 \(12\) is needed, but no `Tupies\.dmg` was attached/);
  assert.match(native[2],/build 0\.5\.0 \(12\) is needed\. TestFlight upload is not switched on/);
  assert.match(releaseOutcome({project,ios:true,mac:false},{engine:'failure',iphone:'success'}).join('\n'),/not published[\s\S]*uploaded to TestFlight/);
  assert.match(releaseOutcome({project,ios:true,mac:false},{iphone:'failure'})[0],/TestFlight upload failed/);
  const first=mergeReleaseNotes('Beta 11.\n\nWhat changed.\n','### What to update\nfirst');
  assert.equal(first,'Beta 11.\n\nWhat changed.\n\n<!-- tupies-update-guide -->\n### What to update\nfirst\n<!-- /tupies-update-guide -->\n');
  assert.equal(mergeReleaseNotes(first,'### What to update\nsecond'),first.replace('first','second'));
  assert.equal(mergeReleaseNotes('','note'),'<!-- tupies-update-guide -->\nnote\n<!-- /tupies-update-guide -->\n');
});
