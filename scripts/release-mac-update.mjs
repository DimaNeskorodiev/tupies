import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createPrivateKey,createPublicKey,verify} from 'node:crypto';
import {hashFile,privateFile,secureURL} from '../lib/update-artifacts.mjs';
import {fileURLToPath} from 'node:url';
const escape=value=>String(value).replace(/[<>&"']/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[char]));
async function run(tool,args) {return new Promise((resolve,reject)=>{let output='';const child=spawn(tool,args,{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME}});child.stdout.on('data',bytes=>{output+=bytes;if(output.length>100_000)child.kill('SIGKILL');});child.stderr.on('data',()=>{});child.once('error',reject);child.once('close',code=>code===0?resolve(output):reject(new Error('Sparkle update signing failed. Inspect your private key and official signing tool.')));});}
export async function releaseMacUpdate(options) {
  const directory=path.resolve(options.release),output=path.resolve(options.output),receipt=JSON.parse(await fs.readFile(path.join(directory,'release.json'),'utf8'));
  if(receipt.stage!=='notarized'||receipt.distributable!==true||receipt.bundleIdentifier!=='dev.tupies.app'||!/^\d+$/.test(receipt.build))throw new Error('Only a final notarized Tupies release may enter the update feed.');
  const url=secureURL(options.url).href,dmg=path.join(directory,'Tupies.dmg');if(await hashFile(dmg)!==receipt.dmgSha256)throw new Error('The notarized disk image changed.');
  const seed=Buffer.from((await privateFile(options.key)).toString().trim(),'base64');if(seed.length!==32)throw new Error('Use a Sparkle Ed25519 seed key.');
  const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),type:'pkcs8',format:'der'}),publicKey=createPublicKey(key);
  const infoFile=path.join(directory,'Tupies.app/Contents/Info.plist');
  const info=await run('/usr/bin/plutil',['-convert','json','-o','-',infoFile]),metadata=JSON.parse(info);
  if(metadata.SUPublicEDKey!==publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64'))throw new Error('The signing key does not match the public key embedded in this app.');
  secureURL(metadata.SUFeedURL);
  const tool=path.resolve(options['sign-tool']),signatureOutput=await run(tool,['--ed-key-file',path.resolve(options.key),dmg]),match=signatureOutput.match(/sparkle:edSignature="([A-Za-z0-9+/=]+)"\s+length="(\d+)"/);
  if(!match||Number(match[2])!==(await fs.stat(dmg)).size||!verify(null,await fs.readFile(dmg),publicKey,Buffer.from(match[1],'base64')))throw new Error('Sparkle archive signature did not independently verify.');
  await fs.mkdir(output,{mode:0o700});
  const xml=`<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Tupies Updates</title><item><title>Tupies ${escape(receipt.version)}</title><pubDate>${new Date().toUTCString()}</pubDate><sparkle:version>${escape(receipt.build)}</sparkle:version><sparkle:shortVersionString>${escape(receipt.version)}</sparkle:shortVersionString><sparkle:minimumSystemVersion>${escape(receipt.minimumMacOS || '14.0')}</sparkle:minimumSystemVersion><enclosure url="${escape(url)}" sparkle:edSignature="${match[1]}" length="${match[2]}" type="application/octet-stream"/></item></channel></rss>\n`;
  const feed=path.join(output,'appcast.xml');await fs.writeFile(feed,xml,{flag:'wx',mode:0o644});
  // Sparkle 2.10.1 signs the XML feed in place. Archive and feed share the pinned key.
  await run(tool,['--ed-key-file',path.resolve(options.key),feed]);await run(tool,['--ed-key-file',path.resolve(options.key),'--verify',feed]);
  return {ready:true,build:receipt.build,feedURL:metadata.SUFeedURL,archiveURL:url,feedFile:feed};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{const args=process.argv.slice(2),options={};if(args.length%2)throw new Error('Use explicit --name value options.');for(let i=0;i<args.length;i+=2){const key=args[i].slice(2);if(!['release','output','url','key','sign-tool'].includes(key)||options[key])throw new Error('Unknown or duplicate Mac feed option.');options[key]=args[i+1];}console.log(JSON.stringify(await releaseMacUpdate(options)));}catch(error){console.error(error.message);process.exitCode=1;}
}
