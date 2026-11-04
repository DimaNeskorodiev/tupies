// Maintainer-only Mac distribution pipeline. Never installs or launches the stable app.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {packageAppleEngine} from './package-apple-engine.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exists=file=>fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const fail=message=>{throw new Error(message);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function macUpdateConfiguration(feed,key) {
  let url;try{url=new URL(feed);}catch{fail('Supply --update-feed with a permanent HTTPS appcast URL.');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||!url.hostname)fail('The Mac update feed must use HTTPS without credentials or fragments.');
  if(typeof key!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(key)||Buffer.from(key,'base64').length!==32)fail('Supply --update-public-key with the Sparkle public Ed25519 key.');
  return {feed:url.href,key};
}
export function buildNumber(value) {
  if(!/^[1-9][0-9]{0,7}$/.test(value||''))fail('Use an explicit positive, increasing --build-number.');
  return value;
}
export function developerIdentity(output,requested) {
  if(!/^[A-Fa-f0-9]{40}$/.test(requested||''))fail('Use the SHA-1 identity from security find-identity, not an account name.');
  const match=[...output.matchAll(/\b([A-Fa-f0-9]{40})\s+"Developer ID Application:[^"\n]*\(([A-Z0-9]{10})\)"/g)].find(item=>item[1].toLowerCase()===requested.toLowerCase());
  if(!match)fail('The selected identity is not an available Developer ID Application certificate with its private key.');
  return {hash:match[1],team:match[2]};
}
export function distributionProfile(profile,identity,at=Date.now()) {
  const prefix=profile.prefixes?.[0],entitlements=profile.entitlements||{};
  if(profile.allDevices!==true||profile.provisionedDevices||!profile.platforms?.some(value=>['OSX','macOS'].includes(value)))fail('Use a Developer ID profile for all Macs, not a development or App Store profile.');
  if(!profile.teams?.includes(identity.team)||!profile.certificates?.some(hash=>hash.toLowerCase()===identity.hash.toLowerCase()))fail('The distribution profile does not authorize this signing identity.');
  if(!Number.isFinite(Date.parse(profile.expires))||Date.parse(profile.expires)<=at)fail('The distribution profile is expired or has no valid expiry.');
  if(!/^[A-Za-z0-9]{1,128}$/.test(prefix||''))fail('The distribution profile has no valid App ID prefix.');
  const group=`${prefix}.dev.tupies.app`;
  if(entitlements['com.apple.application-identifier']!==group||entitlements['com.apple.developer.team-identifier']!==identity.team||entitlements['get-task-allow']===true||entitlements['com.apple.security.get-task-allow']===true)fail('The profile does not authorize the production Tupies identity.');
  if(!entitlements['keychain-access-groups']?.some(value=>value===group||value===`${prefix}.*`))fail('The profile does not authorize the Tupies Keychain group.');
  return {prefix,group};
}
async function run(command,args,log,{cwd=root,timeout=600_000}={}) {
  const handle=await fs.open(log,'a',0o600);
  try {
    return await new Promise((resolve,reject)=>{
      const env={...process.env};for(const key of Object.keys(env))if(/^(NODE_OPTIONS|NODE_PATH|DYLD_|STUDIO_|HERMES_STUDIO_)/.test(key))delete env[key];
      const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});let bytes=0,timedOut=false;const chunks=[];
      const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),5000).unref();},timeout);
      const append=chunk=>{bytes+=chunk.length;if(bytes>10_000_000){child.kill('SIGKILL');return;}chunks.push(chunk);};
      child.stdout.on('data',append);child.stderr.on('data',append);child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',async code=>{clearTimeout(timer);const output=Buffer.concat(chunks);try{await handle.write(output);}catch(error){return reject(error);}if(code!==0||timedOut||bytes>10_000_000)return reject(new Error(`${path.basename(command)} failed; inspect the private log ${log}.`));resolve(output.toString());});
    });
  } finally {await handle.close();}
}
async function tree(folder,base=folder) {
  const files=[];
  for(const name of (await fs.readdir(folder)).sort()) {
    const file=path.join(folder,name),stat=await fs.lstat(file),relative=path.relative(base,file);
    if(stat.isDirectory())files.push(...await tree(file,base));
    else if(stat.isSymbolicLink())files.push({path:relative,link:await fs.readlink(file)});
    else if(stat.isFile())files.push({path:relative,size:stat.size,sha256:digest(await fs.readFile(file))});
    else fail('Unexpected file type in release app.');
  }
  return files;
}
async function json(file,value) {await fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
async function copy(source,destination) {
  // APFS clones avoid keeping several physical copies of the complete runtime.
  if(await exists(destination))fail('Copy destination must be new; retain and inspect interrupted output before retrying.');
  await new Promise((resolve,reject)=>{
    const child=spawn('/bin/cp',['-cR',source,destination],{stdio:'ignore'});
    child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('APFS clone copy failed. Check free space and use a local APFS release directory.')));
  });
}
async function image(output,app,name,log) {
  const stage=path.join(output,`${name}-contents`),dmg=path.join(output,`${name}.dmg`);
  if(await exists(stage)||await exists(dmg))fail('Disk image output already exists. Choose a fresh release directory.');
  await fs.mkdir(stage);await copy(app,path.join(stage,'Tupies.app'));
  await fs.symlink('/Applications',path.join(stage,'Applications'));
  await fs.copyFile(path.join(root,'docs/setup/mac-quick-start.txt'),path.join(stage,'Start here.txt'));
  await run('/usr/bin/hdiutil',['create','-volname','Tupies','-srcfolder',stage,'-format','UDZO','-ov',dmg],log);
  await run('/usr/bin/hdiutil',['verify',dmg],log);
  return dmg;
}
async function readRelease(output) {
  const receipt=JSON.parse(await fs.readFile(path.join(output,'release.json'),'utf8'));
  if(receipt.schema!==1||receipt.bundleIdentifier!=='dev.tupies.app')fail('Not a supported Tupies release directory.');
  return receipt;
}
export async function prepare(options) {
  if(process.platform!=='darwin'||process.arch!=='arm64')fail('Prepare this release on an Apple Silicon Mac.');
  const build=buildNumber(options['build-number']),output=path.resolve(options.output||fail('Missing --output.'));
  const defaults=JSON.parse(await fs.readFile(path.join(root,'assets/updates/release-channels.json'),'utf8')).mac;
  const update=macUpdateConfiguration(options['update-feed'] || defaults.feedURL,options['update-public-key'] || defaults.publicKey);
  if(await exists(output))fail('Release output must not exist.');
  await fs.mkdir(output,{recursive:true,mode:0o700});
  const log=path.join(output,'prepare.private.log'),derived=path.join(output,'DerivedData');
  await run('/usr/bin/xcodebuild',['-project',path.join(root,'apps/apple/Tupies.xcodeproj'),'-scheme','Tupies','-configuration','Release','-destination','generic/platform=macOS','-derivedDataPath',derived,'ARCHS=arm64','ONLY_ACTIVE_ARCH=NO','CODE_SIGNING_ALLOWED=NO','CODE_SIGNING_REQUIRED=NO',`CURRENT_PROJECT_VERSION=${build}`,`TUPIES_UPDATE_FEED_URL=${update.feed}`,`TUPIES_UPDATE_PUBLIC_KEY=${update.key}`,'TUPIES_REQUIRE_TRANSFER=NO','build'],log);
  const app=path.join(output,'Tupies.app');await copy(path.join(derived,'Build/Products/Release/Tupies.app'),app);
  const payload=await packageAppleEngine({archive:options['node-archive'],checksums:options.checksums,output:path.join(output,'payload'),arch:'arm64',npmCLI:options['npm-cli'],repo:root});
  return assemblePreparedApp(output,build);
}
// Resume only the deterministic assembly after a successful native build and
// payload smoke (for example, after insufficient disk space). No signing runs.
export async function assemblePreparedApp(output,build) {
  buildNumber(build);
  if(await exists(path.join(output,'release.json')))fail('A release receipt already exists.');
  const app=path.join(output,'Tupies.app'),log=path.join(output,'prepare.private.log'),payload=JSON.parse(await fs.readFile(path.join(output,'payload/payload-manifest.json'),'utf8'));
  if(payload.hashScope!=='unsigned-payload-before-application-signing'||payload.node.arch!=='arm64'||!payload.smoke.startsWith('PASS packaged engine'))fail('A verified standalone payload is required.');
  for(const file of payload.files) {
    const location=path.resolve(output,'payload',file.path);
    if(!location.startsWith(path.resolve(output,'payload')+path.sep))fail('Payload path escapes its root.');
    if(file.symlink){if(await fs.readlink(location)!==file.symlink)fail('Payload link changed.');}
    else if(digest(await fs.readFile(location))!==file.sha256)fail('Payload bytes changed.');
  }
  for(const name of ['Engine','Runtime','payload-manifest.json'])await copy(path.join(output,'payload',name),path.join(app,'Contents/Resources',name));
  const info=JSON.parse(await run('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')],log));
  macUpdateConfiguration(info.SUFeedURL,info.SUPublicEDKey);
  if(info.SURequireSignedFeed!==true||info.SUVerifyUpdateBeforeExtraction!==true)fail('The Mac release must enforce signed feeds and archive verification before extraction.');
  if(info.CFBundleIdentifier!=='dev.tupies.app'||String(info.CFBundleVersion)!==build||info.TupiesRequiresLegacyTransfer!=='NO')fail('The native app identity, version or fresh-install mode does not match.');
  const files=await tree(app);await json(path.join(output,'unsigned-app-manifest.json'),files);
  const dmg=await image(output,app,'Tupies-UNSIGNED',log);
  const receipt={schema:1,bundleIdentifier:info.CFBundleIdentifier,version:info.CFBundleShortVersionString,build,architecture:'arm64',minimumMacOS:info.LSMinimumSystemVersion,stage:'unsigned-candidate',distributable:false,nodeVersion:payload.node.version,smoke:payload.smoke,appManifestSha256:digest(Buffer.from(JSON.stringify(files))),dmg:path.basename(dmg),dmgSha256:digest(await fs.readFile(dmg))};
  await json(path.join(output,'release.json'),receipt);return receipt;
}
export async function sign(options) {
  const output=path.resolve(options.output||fail('Missing --output.')),receipt=await readRelease(output),log=path.join(output,'sign.private.log');
  if(receipt.stage!=='unsigned-candidate')fail('Signing requires an untouched unsigned candidate.');
  const app=path.join(output,'Tupies.app');
  if(digest(Buffer.from(JSON.stringify(await tree(app))))!==receipt.appManifestSha256)fail('The prepared app changed. Prepare a new candidate before signing.');
  const identity=developerIdentity(await run('/usr/bin/security',['find-identity','-v','-p','codesigning'],log),options.identity);
  const pinnedTeam=JSON.parse(await fs.readFile(path.join(root,'assets/updates/release-channels.json'),'utf8')).mac.signingTeamSha256;
  if(digest(Buffer.from(`tupies-mac-signing-team:${identity.team}`))!==pinnedTeam)fail('The signing team differs from the existing Tupies distribution trust root.');
  if(!options['provisioning-profile'])fail('Supply the Developer ID --provisioning-profile; Tupies uses the restricted Keychain access-group entitlement.');
  const profileFile=path.resolve(options['provisioning-profile']),profileStat=await fs.lstat(profileFile);
  if(!profileStat.isFile()||profileStat.isSymbolicLink()||profileStat.size>2_000_000)fail('Use a regular bounded Developer ID provisioning profile.');
  const decoded=path.join(output,'distribution-profile.private.plist');
  await fs.writeFile(decoded,await run('/usr/bin/security',['cms','-D','-i',profileFile],log),{mode:0o600});
  const extract=async(key,format='json')=>{const text=await run('/usr/bin/plutil',['-extract',key,format,'-o','-',decoded],log);return format==='json'?JSON.parse(text):text.trim();};
  const xml=await fs.readFile(decoded,'utf8');
  const certificates=[...(await extract('DeveloperCertificates','xml1')).matchAll(/<data>([\s\S]*?)<\/data>/g)].map(match=>createHash('sha1').update(Buffer.from(match[1].replace(/\s/g,''),'base64')).digest('hex'));
  const profile=distributionProfile({allDevices:(await extract('ProvisionsAllDevices','raw'))==='true',provisionedDevices:xml.includes('<key>ProvisionedDevices</key>'),platforms:await extract('Platform'),teams:await extract('TeamIdentifier'),prefixes:await extract('ApplicationIdentifierPrefix'),expires:await extract('ExpirationDate','raw'),entitlements:await extract('Entitlements'),certificates},identity);
  const info=path.join(app,'Contents/Info.plist');
  // The verified profile owns the App ID prefix; do not guess it from the team.
  for(const [key,value] of [['TupiesKeychainGroup',profile.group],['TupiesLegacyKeychainGroup',`${profile.prefix}.dev.hermesstudio.app`]])await run('/usr/bin/plutil',['-replace',key,'-string',value,info],log);
  await fs.copyFile(profileFile,path.join(app,'Contents/embedded.provisionprofile'));
  const entitlements=path.join(output,'distribution.entitlements');
  await fs.writeFile(entitlements,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.application-identifier</key><string>${profile.group}</string><key>com.apple.developer.team-identifier</key><string>${identity.team}</string><key>keychain-access-groups</key><array><string>${profile.group}</string></array><key>com.apple.security.device.audio-input</key><true/></dict></plist>`,{mode:0o600});
  const files=await tree(app);
  // Sparkle's nested helpers/framework must use our Developer ID before sealing the app.
  const frameworks=path.join(app,'Contents/Frameworks');
  if(await exists(frameworks)) {
    for(const item of files.filter(item=>item.path.startsWith('Contents/Frameworks/')&&!item.link)) {
      const executable=path.join(app,item.path),handle=await fs.open(executable,'r'),magic=Buffer.alloc(4);
      try {await handle.read(magic,0,4,0);}finally{await handle.close();}
      if(['cffaedfe','cefaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic.toString('hex')))await run('/usr/bin/codesign',['--force','--sign',identity.hash,'--timestamp','--options','runtime','--preserve-metadata=entitlements',executable],log);
    }
    const bundles=[];
    async function walk(folder){for(const entry of await fs.readdir(folder,{withFileTypes:true})){if(!entry.isDirectory())continue;const directory=path.join(folder,entry.name);await walk(directory);if(/\.(xpc|app|framework)$/.test(entry.name))bundles.push(directory);}}
    await walk(frameworks);for(const bundle of bundles)await run('/usr/bin/codesign',['--force','--sign',identity.hash,'--timestamp','--options','runtime','--preserve-metadata=entitlements',bundle],log);
  }
  for(const file of files.filter(item=>/\.(node|dylib)$/.test(item.path)&&!item.link))await run('/usr/bin/codesign',['--force','--sign',identity.hash,'--timestamp','--options','runtime',path.join(app,file.path)],log);
  await run('/usr/bin/codesign',['--force','--sign',identity.hash,'--timestamp','--options','runtime','--entitlements',path.join(root,'apps/apple/Config/Tupies-node.entitlements'),path.join(app,'Contents/Resources/Runtime/node')],log);
  await run('/usr/bin/codesign',['--force','--sign',identity.hash,'--timestamp','--options','runtime','--entitlements',entitlements,app],log);
  await run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app],log);
  await json(path.join(output,'signed-app-manifest.json'),await tree(app));
  receipt.stage='developer-id-signed';receipt.distributable=false;receipt.signingIdentitySha1=identity.hash;receipt.distributionProfileSha256=digest(await fs.readFile(profileFile));
  await json(path.join(output,'release.json'),receipt);return receipt;
}
export async function packageSignedApp(options) {
  const output=path.resolve(options.output||fail('Missing --output.')),receipt=await readRelease(output),log=path.join(output,'package.private.log'),app=path.join(output,'Tupies.app');
  if(receipt.stage!=='developer-id-signed')fail('Packaging requires the Developer ID signed candidate.');
  const identity=developerIdentity(await run('/usr/bin/security',['find-identity','-v','-p','codesigning'],log),receipt.signingIdentitySha1);
  if(JSON.stringify(await tree(app))!==JSON.stringify(JSON.parse(await fs.readFile(path.join(output,'signed-app-manifest.json'),'utf8'))))fail('The signed app changed. Refusing notarization.');
  await run('/usr/bin/codesign',['--verify','--deep','--strict',app],log);
  const dmg=await image(output,app,'Tupies',log);
  await run('/usr/bin/codesign',['--force','--sign',identity.hash,'--timestamp',dmg],log);
  await run('/usr/bin/codesign',['--verify','--strict',dmg],log);
  receipt.stage='developer-id-packaged';receipt.dmg='Tupies.dmg';receipt.dmgSha256=digest(await fs.readFile(dmg));
  await json(path.join(output,'release.json'),receipt);return receipt;
}
export async function notarize(options) {
  const output=path.resolve(options.output||fail('Missing --output.')),log=path.join(output,'notarize.private.log');
  let receipt=await readRelease(output);
  if(!['developer-id-signed','developer-id-packaged'].includes(receipt.stage))fail('Notarization requires the Developer ID signed candidate or its packaged disk image.');
  if(!/^[A-Za-z0-9._-]{1,100}$/.test(options.profile||''))fail('Supply --profile with a locally stored notarytool Keychain profile name. Never pass passwords.');
  if(receipt.stage==='developer-id-signed')receipt=await packageSignedApp(options);
  const dmg=path.join(output,'Tupies.dmg');
  if(digest(await fs.readFile(dmg))!==receipt.dmgSha256)fail('The signed disk image changed. Refusing submission.');
  await run('/usr/bin/codesign',['--verify','--strict',dmg],log);
  // Authentication failures leave the ready image reusable. Once upload begins,
  // uncertainty requires inspecting Apple history instead of automatic resubmission.
  await run('/usr/bin/xcrun',['notarytool','history','--keychain-profile',options.profile,'--output-format','json'],log);
  receipt.stage='notarization-submitting';await json(path.join(output,'release.json'),receipt);
  // Submission is asynchronous; save the request ID before checking its outcome.
  const submitted=JSON.parse(await run('/usr/bin/xcrun',['notarytool','submit',dmg,'--keychain-profile',options.profile,'--output-format','json'],log));
  if(!/^[a-f0-9-]{36}$/i.test(submitted.id||''))fail('Apple did not return a notarization request ID; inspect the private log before retrying.');
  receipt.stage='notarization-submitted';receipt.notarizationId=submitted.id;receipt.dmg='Tupies.dmg';receipt.submittedDmgSha256=digest(await fs.readFile(dmg));await json(path.join(output,'release.json'),receipt);
  return receipt;
}
export async function finish(options) {
  const output=path.resolve(options.output||fail('Missing --output.')),receipt=await readRelease(output),log=path.join(output,'notarize.private.log');
  if(receipt.stage!=='notarization-submitted')fail('No pending notarization request.');
  if(!/^[A-Za-z0-9._-]{1,100}$/.test(options.profile||''))fail('Supply the same notarytool --profile.');
  const status=JSON.parse(await run('/usr/bin/xcrun',['notarytool','info',receipt.notarizationId,'--keychain-profile',options.profile,'--output-format','json'],log));
  if(status.status!=='Accepted')return {...receipt,appleStatus:status.status};
  const dmg=path.join(output,'Tupies.dmg');
  if(digest(await fs.readFile(dmg))!==receipt.submittedDmgSha256)fail('The submitted disk image changed. Refusing to label different bytes notarized.');
  await run('/usr/bin/xcrun',['stapler','staple',dmg],log);await run('/usr/bin/xcrun',['stapler','validate',dmg],log);
  await run('/usr/sbin/spctl',['--assess','--type','open','--context','context:primary-signature','--verbose=2',dmg],log);
  receipt.stage='notarized';receipt.distributable=true;receipt.dmgSha256=digest(await fs.readFile(dmg));
  await fs.writeFile(path.join(output,'SHA256SUMS'),`${receipt.dmgSha256}  Tupies.dmg\n`);await json(path.join(output,'release.json'),receipt);return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [command,...args]=process.argv.slice(2),options={};
    if(!['prepare','sign','package','notarize','finish'].includes(command)||args.length%2)fail('Use prepare|sign|package|notarize|finish with explicit --name value options. See docs/macos-release.md.');
    for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!args[i].startsWith('--')||!['output','build-number','node-archive','checksums','npm-cli','identity','profile','provisioning-profile','update-feed','update-public-key'].includes(key)||options[key]!==undefined)fail('Unknown or duplicate release option.');options[key]=args[i+1];}
    console.log(JSON.stringify(await ({prepare,sign,package:packageSignedApp,notarize,finish}[command])(options),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
