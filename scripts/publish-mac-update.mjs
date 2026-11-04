// GitHub release event only. No Apple private certificate is needed/exported by this job.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {downloadUpdate} from '../lib/engine-updater.mjs';
import {hashFile,secureURL,sha256} from '../lib/update-artifacts.mjs';
import {releaseMacUpdate} from './release-mac-update.mjs';
async function run(command,args,{captureStderr=false}={}) {
  return new Promise((resolve,reject)=>{
    let text='';const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'en_US.UTF-8',...(command==='gh'?{GH_TOKEN:process.env.GH_TOKEN,GH_REPO:process.env.GH_REPO}:{})}});
    const collect=chunk=>{text+=chunk;if(text.length>1_000_000)child.kill('SIGKILL');};child.stdout.on('data',collect);child.stderr.on('data',chunk=>{if(captureStderr)collect(chunk);});child.once('error',reject);child.once('close',code=>code===0?resolve(text):reject(new Error(`${path.basename(command)} failed. Inspect the release/feed before retrying an uncertain operation.`)));
  });
}
let keyFile,mount;
try {
  const {RUNNER_TEMP,RELEASE_TAG,GH_REPO}=process.env,seed=Buffer.from(process.env.SPARKLE_KEY?.trim() || '','base64');delete process.env.SPARKLE_KEY;
  if(process.platform!=='darwin'||!RUNNER_TEMP||seed.length!==32||!/^v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(RELEASE_TAG||'')||GH_REPO!=='DimaNeskorodiev/tupies')throw new Error('A versioned Mac release and its configured Sparkle signing secret are required.');
  const configured=JSON.parse(await fs.readFile('assets/updates/release-channels.json','utf8')).mac;
  const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),type:'pkcs8',format:'der'});
  if(createPublicKey(key).export({type:'spki',format:'der'}).subarray(-32).toString('base64')!==configured.publicKey)throw new Error('Sparkle signing secret does not match the pinned public key.');
  const output=path.join(RUNNER_TEMP,'mac-update-publication');await fs.mkdir(output,{mode:0o700});
  keyFile=path.join(output,'sparkle.private.key');await fs.writeFile(keyFile,seed.toString('base64'),{mode:0o600,flag:'wx'});
  const origins=['https://github.com','https://release-assets.githubusercontent.com'],toolArchive=path.join(output,'sparkle.zip');
  await downloadUpdate('https://github.com/sparkle-project/Sparkle/releases/download/2.10.1/Sparkle-for-Swift-Package-Manager.zip',toolArchive,{origins,maxBytes:20_000_000});
  if(await hashFile(toolArchive)!=='4c2e48a3e50ebcc2c88a58a4c7264a1a99c3c31857ce754357afb9cdb323022a')throw new Error('Official Sparkle tool checksum mismatch.');
  const tools=path.join(output,'tools');await run('/usr/bin/unzip',['-q',toolArchive,'-d',tools]);
  const directory=path.join(output,'release');await fs.mkdir(directory,{mode:0o700});
  const url=`https://github.com/${GH_REPO}/releases/download/${RELEASE_TAG}/Tupies.dmg`,dmg=path.join(directory,'Tupies.dmg');await downloadUpdate(url,dmg,{origins,maxBytes:1024**3});
  await run('/usr/bin/xcrun',['stapler','validate',dmg]);await run('/usr/sbin/spctl',['--assess','--type','open','--context','context:primary-signature',dmg]);
  mount=path.join(output,'mounted');await fs.mkdir(mount,{mode:0o700});await run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,dmg]);
  const app=path.join(mount,'Tupies.app');await run('/usr/bin/codesign',['--verify','--deep','--strict',app]);await run('/usr/sbin/spctl',['--assess','--type','execute',app]);
  const signing=await run('/usr/bin/codesign',['-d','--verbose=4',app],{captureStderr:true}),team=signing.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
  if(!team||sha256(Buffer.from(`tupies-mac-signing-team:${team}`))!==configured.signingTeamSha256)throw new Error('The release changes the existing Tupies signing team.');
  const info=JSON.parse(await run('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')]));
  if(info.CFBundleIdentifier!=='dev.tupies.app'||info.SUPublicEDKey!==configured.publicKey||info.SUFeedURL!==configured.feedURL||info.SURequireSignedFeed!==true||info.SUVerifyUpdateBeforeExtraction!==true||!/^\d+$/.test(info.CFBundleVersion)||info.CFBundleShortVersionString!==RELEASE_TAG.slice(1).split('-')[0])throw new Error('The notarized app identity/version/update configuration does not match this release.');
  const feedURL=secureURL(info.SUFeedURL),feedName=path.posix.basename(feedURL.pathname);
  if(feedURL.origin!=='https://github.com'||feedURL.pathname!==`/${GH_REPO}/releases/download/update-feeds/${feedName}`||!/^mac-(beta|stable)\.xml$/.test(feedName))throw new Error('Unexpected Mac feed destination.');
  // The original signed app is verified above. Only its public metadata is copied into signing scratch.
  await fs.mkdir(path.join(directory,'Tupies.app/Contents'),{recursive:true});await fs.copyFile(path.join(app,'Contents/Info.plist'),path.join(directory,'Tupies.app/Contents/Info.plist'));
  await fs.writeFile(path.join(directory,'release.json'),JSON.stringify({schema:1,stage:'notarized',distributable:true,bundleIdentifier:info.CFBundleIdentifier,version:info.CFBundleShortVersionString,build:info.CFBundleVersion,minimumMacOS:info.LSMinimumSystemVersion,dmgSha256:await hashFile(dmg)}));
  await run('/usr/bin/hdiutil',['detach',mount]);mount=null;
  const signTool=path.join(tools,'bin/sign_update'),feedOutput=path.join(output,'feed');await releaseMacUpdate({release:directory,output:feedOutput,url,key:keyFile,'sign-tool':signTool});
  const target=JSON.parse(await run('gh',['release','view','update-feeds','--json','isDraft,assets']));if(target.isDraft)throw new Error('The update-feeds release must be public before advancing the feed.');
  if(target.assets.some(asset=>asset.name===feedName)) {
    const previous=path.join(output,'previous');await fs.mkdir(previous);await run('gh',['release','download','update-feeds','--pattern',feedName,'--dir',previous]);
    await run(signTool,['--ed-key-file',keyFile,'--verify',path.join(previous,feedName)]);
    const old=await fs.readFile(path.join(previous,feedName),'utf8'),build=old.match(/<sparkle:version>(\d+)<\/sparkle:version>/)?.[1];
    if(!build||BigInt(build)>=BigInt(info.CFBundleVersion))throw new Error('Mac build numbers must increase before publishing an update feed.');
  }
  const feed=path.join(feedOutput,feedName);await fs.rename(path.join(feedOutput,'appcast.xml'),feed);
  await run('gh',['release','upload','update-feeds',feed,'--clobber']);console.log(JSON.stringify({published:true,build:info.CFBundleVersion,feed:feedName}));
}catch(error){console.error(error.message);process.exitCode=1;}finally{if(mount)await run('/usr/bin/hdiutil',['detach',mount]).catch(()=>{});if(keyFile)await fs.rm(keyFile,{force:true});}
