// Release-event entrypoint. Source and deps were verified/staged by the workflow.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createPublicKey,createPrivateKey} from 'node:crypto';
import {releaseEngine} from './release-engine.mjs';
const run=args=>new Promise((resolve,reject)=>{const child=spawn('gh',args,{stdio:'inherit'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('GitHub release publication failed. Inspect the release/feed before retrying an uncertain upload.')));});
let keyFile;
try {
  const {RUNNER_TEMP,RELEASE_KEY,RELEASE_TAG,RELEASE_PUBLISHED,RELEASE_PRERELEASE,GH_REPO}=process.env;
  if(process.platform!=='linux'||process.arch!=='x64'||!RUNNER_TEMP||!RELEASE_KEY||!/^v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(RELEASE_TAG||'')||!/^DimaNeskorodiev\/tupies$/.test(GH_REPO||''))throw new Error('Only a versioned Tupies release with the configured signing secret may publish updates.');
  const channel=RELEASE_PRERELEASE==='true'?'beta':'stable',sequence=Date.parse(RELEASE_PUBLISHED);
  if(!Number.isSafeInteger(sequence)||sequence<1||sequence>Date.now()+300_000)throw new Error('Invalid release publication time.');
  const pinned=JSON.parse(await fs.readFile('assets/updates/release-channels.json','utf8')).engine.publicKey;
  if(createPublicKey(createPrivateKey(RELEASE_KEY)).export({type:'spki',format:'pem'})!==pinned)throw new Error('The release signing secret does not match the pinned public key.');
  keyFile=path.join(RUNNER_TEMP,'engine-update-signing.private.pem');await fs.writeFile(keyFile,RELEASE_KEY,{mode:0o600,flag:'wx'});delete process.env.RELEASE_KEY;
  const output=path.join(RUNNER_TEMP,'engine-output'),url=`https://github.com/${GH_REPO}/releases/download/${RELEASE_TAG}/engine-linux-x64.tupies.gz`;
  await releaseEngine({source:path.join(RUNNER_TEMP,'engine-source'),output,sequence:String(sequence),id:RELEASE_TAG.slice(1),version:RELEASE_TAG.slice(1),channel,arch:'x64','data-epoch':'1',url,key:keyFile});
  await fs.rename(path.join(output,'engine.tupies.gz'),path.join(output,'engine-linux-x64.tupies.gz'));
  const feed=`engine-${channel}-linux-x64.json`;await fs.rename(path.join(output,'engine-update.json'),path.join(output,feed));
  await run(['release','upload',RELEASE_TAG,path.join(output,'engine-linux-x64.tupies.gz'),path.join(output,feed),path.join(output,'engine-release.json')]);
  // This tag is created once by the maintainer. Never silently create a new release/channel.
  await run(['release','view','update-feeds','--json','tagName']);
  await run(['release','upload','update-feeds',path.join(output,feed),'--clobber']);
}catch(error){console.error(error.message);process.exitCode=1;}finally{if(keyFile)await fs.rm(keyFile,{force:true});}
