// What this Engine is, whether a newer signed release exists, and a way to ask the server's own updater to run now.
// It never downloads, unpacks or installs code. Installing stays with the separate operator updater (lib/engine-updater.mjs),
// the Mac app (Sparkle) or the person who deployed this copy.
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPublicKey,verify} from 'node:crypto';
import {downloadUpdate} from './engine-updater.mjs';
import {verifyManifest,secureURL} from './update-artifacts.mjs';
import {ensure} from './store.mjs';

const ARTIFACT_ORIGINS=['https://github.com','https://release-assets.githubusercontent.com'];
const REQUEST_INTERVAL_MS=60_000;
const readJSON=file=>fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const isoTime=value=>Number.isFinite(Date.parse(value))?new Date(Date.parse(value)).toISOString():null;

/** "0.5.0-engine.beta.10" reads as "0.5.0 beta 10"; anything unexpected is shown as written. */
export function releaseLabel(id) {
  const match=/^(\d+\.\d+\.\d+)(?:-(?:engine\.)?(alpha|beta|rc)\.(\d+))?$/.exec(id||'');
  return match?(match[2]?`${match[1]} ${match[2]} ${match[3]}`:match[1]):String(id||'');
}

/** A signed feed whose 30-day validity has run out still tells us honestly which release was the last one published. */
function expiredRelease(envelope,key,channel,now) {
  try {
    const bytes=Buffer.from(envelope.payload,'base64');
    if(!verify(null,bytes,createPublicKey(key),Buffer.from(envelope.signature,'base64')))return null;
    const release=JSON.parse(bytes),published=Date.parse(release.publishedAt),expires=Date.parse(release.expiresAt);
    if(release.schema!==1||release.product!=='tupies-engine'||release.channel!==channel||!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(release.id)||!Number.isSafeInteger(release.sequence)||release.sequence<1||!(published<=now+300_000)||!(expires<=now))return null;
    return release;
  } catch {return null;}
}

export class EngineUpdates {
  constructor({root,env=process.env,fetcher=fetch,clock=Date.now,maintenance=null}={}) {
    Object.assign(this,{root,env,fetcher,clock,maintenance,latest:null,checkedAt:null,error:'',requestedAt:null,checking:null,identity:null});
  }

  /** The installed copy. A signed release names itself; a staged build names its commit; a source checkout has neither. */
  async installed() {
    if(this.identity)return this.identity;
    const [pkg,release,build]=await Promise.all(['package.json','engine-release.json','assets/updates/build.json'].map(name=>readJSON(path.join(this.root,name))));
    const version=typeof pkg?.version==='string'?pkg.version:'';
    if(release&&typeof release.id==='string'&&Number.isSafeInteger(release.sequence))this.identity={kind:'release',version,id:release.id,label:releaseLabel(release.id),sequence:release.sequence,releasedAt:new Date(release.sequence).toISOString()};
    else if(build&&/^[a-f0-9]{7,64}$/.test(build.commit||'')) {
      const id=typeof build.release==='string'&&/^[a-z0-9][a-z0-9.-]{0,99}$/.test(build.release)?build.release:null;
      this.identity={kind:'build',version,id,label:id?releaseLabel(id):`${version} (${build.commit.slice(0,7)})`,sequence:null,commit:build.commit.slice(0,12),builtAt:isoTime(build.committedAt)};
    } else this.identity={kind:'development',version,id:null,label:`${version} development copy`,sequence:null};
    return this.identity;
  }

  /** How a newer release reaches this copy: "request" (Update now works), "automatic" (the server's timer) or "manual". */
  installMode() {
    const file=this.env.STUDIO_UPDATE_REQUEST_FILE;
    if(file&&path.isAbsolute(file)&&path.normalize(file)===file)return 'request';
    return this.env.STUDIO_UPDATE_HOLD_FILE?'automatic':'manual';
  }

  /** true, false, or null when this copy cannot be placed in the release order (a source checkout). */
  updateAvailable(installed) {
    const latest=this.latest;
    if(!latest)return null;
    if(installed.sequence)return latest.sequence>installed.sequence;
    if(installed.id&&installed.id===latest.id)return false;
    // A copy built from the very commit a release was cut from is that release, whatever it was called when built.
    if(installed.commit&&latest.commit?.startsWith(installed.commit))return false;
    if(installed.builtAt)return Date.parse(latest.publishedAt)>Date.parse(installed.builtAt);
    return null;
  }

  async status() {
    let installed=await this.installed();
    if(installed.kind==='build'&&this.latest?.commit?.startsWith(installed.commit))installed={...installed,id:this.latest.id,label:this.latest.label};
    const apps=await readJSON(path.join(this.root,'assets/updates/native-apps.json'));
    const app=value=>value&&Number.isInteger(value.build)?{version:String(value.version||''),build:value.build,minimumBuild:Number.isInteger(value.minimumBuild)?value.minimumBuild:1,...(typeof value.testflightURL==='string'&&/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/.test(value.testflightURL)?{testflightURL:value.testflightURL}:{})}:null;
    return {
      installed,latest:this.latest,checkedAt:this.checkedAt?new Date(this.checkedAt).toISOString():null,error:this.error,
      updateAvailable:this.updateAvailable(installed),
      install:{mode:this.installMode(),requestedAt:this.requestedAt?new Date(this.requestedAt).toISOString():null,installing:!!this.maintenance?.paused},
      apps:{ios:app(apps?.ios),mac:app(apps?.mac)},
    };
  }

  async fetchLatest() {
    const channels=await readJSON(path.join(this.root,'assets/updates/release-channels.json'));
    ensure(channels?.engine?.feedURL&&channels.engine.publicKey&&['beta','stable'].includes(channels.channel),503,'This copy of Tupies has no update channel. Reinstall it from a published release.');
    const feed=secureURL(channels.engine.feedURL),scratch=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-update-check-'));
    let envelope;
    try {
      const file=path.join(scratch,'feed.json');
      await downloadUpdate(feed.href,file,{origins:[...new Set([feed.origin,...ARTIFACT_ORIGINS])],maxBytes:24_000_000,fetcher:this.fetcher});
      envelope=JSON.parse(await fs.readFile(file,'utf8'));
    } finally {await fs.rm(scratch,{recursive:true,force:true});}
    // Releases are built for Linux servers; a Mac engine reads the same feed only to learn which release is newest.
    const now=this.clock();let release,expired=false;
    try {release=verifyManifest(envelope,channels.engine.publicKey,{channel:channels.channel,platform:'linux',arch:'x64',now});}
    catch(error) {release=expiredRelease(envelope,channels.engine.publicKey,channels.channel,now);if(!release)throw error;expired=true;}
    return {id:release.id,version:release.version,label:releaseLabel(release.id),sequence:release.sequence,publishedAt:isoTime(release.publishedAt),channel:release.channel,expired,...(/^[a-f0-9]{40,64}$/.test(release.commit||'')?{commit:release.commit}:{})};
  }

  /** Reads the signed release channel. Concurrent callers share one request. */
  async check() {
    this.checking ||= (async()=>{
      try {this.latest=await this.fetchLatest();this.error='';}
      catch(error) {this.error=error.status===503?error.message:'Could not read the release channel. Check this engine’s internet connection and try again.';}
      finally {this.checkedAt=this.clock();this.checking=null;}
    })();
    await this.checking;
    return this.status();
  }

  /**
   * Touches the request file a systemd path unit watches. The updater that then starts still verifies the signature,
   * waits for an idle Engine and takes its backup; this grants the Engine nothing except "check sooner".
   */
  async requestInstall() {
    ensure(this.installMode()==='request',409,'This engine does not take update requests from the app.');
    const status=await this.status();
    ensure(status.updateAvailable===true&&!this.latest.expired,409,'No newer release is known. Check for updates first.');
    const now=this.clock();
    ensure(!this.requestedAt||now-this.requestedAt>=REQUEST_INTERVAL_MS,429,'An update was requested a moment ago. It installs as soon as no task is running.');
    try {await fs.writeFile(this.env.STUDIO_UPDATE_REQUEST_FILE,`${new Date(now).toISOString()}\n`,{mode:0o600});}
    catch {ensure(false,503,'The update request could not be written. The server still installs the update by itself when idle.');}
    this.requestedAt=now;
    return this.status();
  }
}

/** Owner-authenticated routes behind Settings → Version & updates. */
export async function updateApi(req,res,url,{updates,body,json}) {
  const route=url.pathname,method=req.method;
  if(!updates||!route.startsWith('/api/update'))return false;
  if(route==='/api/update'&&method==='GET'){json(res,await updates.status());return true;}
  if(route==='/api/update/check'&&method==='POST'){await body(req);json(res,await updates.check());return true;}
  if(route==='/api/update/install'&&method==='POST'){await body(req);json(res,await updates.requestInstall(),202);return true;}
  return false;
}
