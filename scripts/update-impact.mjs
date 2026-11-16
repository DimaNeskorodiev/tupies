// Says which parts of Tupies a change reaches: the Engine (and its web UI), the iPhone app, the Mac app.
// CI posts the answer on every pull request and release; people and coding agents run it before reporting a change.
//
//   node scripts/update-impact.mjs                      what the working tree changes since the last release
//   node scripts/update-impact.mjs --base origin/main   what this branch changes
//   node scripts/update-impact.mjs --check              also fail when version numbers disagree or a build number is stale
//   node scripts/update-impact.mjs --bump               raise the native build number everywhere it is written
//
// It reads git and repository files only. It never builds, signs, uploads or installs anything.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PROJECT='apps/apple/Tupies.xcodeproj/project.pbxproj',NATIVE_APPS='assets/updates/native-apps.json';
/** Engine scripts that ship in a release (scripts/package-apple-engine.mjs has the authoritative list). */
const SHIPPED_SCRIPTS=new Set(['pair.mjs','link-engine.mjs','runtime-backup.mjs','prepare-mac-update.mjs','update-backup.mjs','check-sandbox.mjs']);
const IOS_ONLY=[/^apps\/apple\/NotificationService\//,/^apps\/apple\/Config\/NotificationService/,/^apps\/apple\/Config\/Tupies(?:-transfer)?-iOS\.entitlements$/,/Tupies-iOS\.xcscheme$/];
const MAC_ONLY=[/^apps\/apple\/Tupies\/Services\/(?:MacUpdates|LocalEngine[A-Za-z]*)\.swift$/,/^apps\/apple\/Config\/Tupies(?:-transfer)?-macOS\.entitlements$/,/^apps\/apple\/Config\/Tupies-node\.entitlements$/,/Tupies\.xcscheme$/];

/** Which shipped part each changed path belongs to. Documentation, tests, workflows and build tooling reach none. */
export function classify(files) {
  const result={engine:[],ios:[],mac:[]};
  for(const file of files) {
    if(file.startsWith('apps/apple/')) {
      if(file==='apps/apple/README.md'||file.startsWith('apps/apple/Tests/')||file.startsWith('apps/apple/build/'))continue;
      if(!MAC_ONLY.some(rule=>rule.test(file)))result.ios.push(file);
      if(!IOS_ONLY.some(rule=>rule.test(file)))result.mac.push(file);
    } else if(file==='server.mjs'||file==='package.json'||file==='package-lock.json'||/^(?:lib|public)\//.test(file)||/^assets\/(?:fonts|tool-catalog|licenses|updates)\//.test(file)||(file.startsWith('scripts/')&&SHIPPED_SCRIPTS.has(file.slice(8)))) {
      result.engine.push(file);
    }
  }
  return result;
}

/** The single version and build number an Xcode project declares, or the reason it has none. */
export function projectVersion(text) {
  const values=key=>[...new Set([...text.matchAll(new RegExp(`\\b${key} = "?([^";]+)"?;`,'g'))].map(match=>match[1]))];
  const builds=values('CURRENT_PROJECT_VERSION'),versions=values('MARKETING_VERSION');
  if(builds.length!==1||!/^\d+$/.test(builds[0]))throw new Error(`Every target in ${PROJECT} must share one numeric CURRENT_PROJECT_VERSION (found: ${builds.join(', ')||'none'}).`);
  if(versions.length!==1)throw new Error(`Every target in ${PROJECT} must share one MARKETING_VERSION (found: ${versions.join(', ')||'none'}).`);
  return {version:versions[0],build:Number(builds[0])};
}

/** Problems that would make a release report the wrong version or reuse a native build number. */
export function versionProblems({packageVersion,project,nativeApps,nativeChanged,releasedBuild}) {
  const problems=[];
  if(project.version!==packageVersion)problems.push(`The Xcode project says version ${project.version} but package.json says ${packageVersion}. They must match.`);
  for(const platform of ['ios','mac']) {
    const app=nativeApps?.[platform];
    if(!app){problems.push(`${NATIVE_APPS} has no "${platform}" entry.`);continue;}
    if(app.version!==project.version||app.build!==project.build)problems.push(`${NATIVE_APPS} says the ${platform==='ios'?'iPhone':'Mac'} app is ${app.version} (${app.build}) but the Xcode project builds ${project.version} (${project.build}). Run: node scripts/update-impact.mjs --bump ${project.build}`);
    if(!Number.isInteger(app.minimumBuild)||app.minimumBuild<1||app.minimumBuild>app.build)problems.push(`${NATIVE_APPS}: ${platform}.minimumBuild must be a build number no newer than ${app.build}.`);
  }
  if(typeof nativeApps?.ios?.testflightURL!=='string'||(nativeApps.ios.testflightURL&&!/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/.test(nativeApps.ios.testflightURL)))problems.push(`${NATIVE_APPS}: ios.testflightURL must be empty or a https://testflight.apple.com/join/… link.`);
  if(nativeChanged&&Number.isInteger(releasedBuild)&&project.build<=releasedBuild)problems.push(`The iPhone/Mac app sources changed since the last release, which already used build ${releasedBuild}. Raise the build number: node scripts/update-impact.mjs --bump`);
  return problems;
}

const yesNo=value=>value?'**Yes**':'No';
/** The note CI posts on a pull request or appends to a release. */
export function markdown(result,{heading='What to update'}={}) {
  const {engine,ios,mac,project}=result,build=`${project.version} (${project.build})`;
  const rows=[
    ['Engine (server and web UI)',yesNo(engine),engine?'Reaches servers through an Engine release. They install it by themselves when idle; **Settings → Version & updates → Update now** does it at once.':'Nothing to install.'],
    ['iPhone app',yesNo(ios),ios?`Needs a new build: **${build}**. The release uploads it to TestFlight when that is switched on; otherwise build and install from Xcode.`:engine?'No new build. Pull down in the app (or Settings → Reload) to load the new web UI.':'No new build.'],
    ['Mac app',yesNo(mac),mac?`Needs a new build: **${build}**. Attach the notarized \`Tupies.dmg\` to the release so Macs update themselves.`:engine?'No new build. Press ⌘R to load the new web UI. A Mac that runs its own included Engine gets Engine changes with the next Mac app build.':'No new build.'],
  ];
  const lines=[`### ${heading}`,'','| Part | Update needed | What to do |','| --- | --- | --- |',...rows.map(row=>`| ${row.join(' | ')} |`)];
  if(result.problems.length)lines.push('','**Needs attention:**',...result.problems.map(problem=>`- ${problem}`));
  if(!engine&&!ios&&!mac)lines.push('','Only documentation, tests or tooling changed. Nothing reaches an installed Engine or app.');
  return lines.join('\n')+'\n';
}

/** One sentence per release job, so the release page says what actually happened and what is still to do. */
export function releaseOutcome(result,{engine,mac,iphone,testflight=false}={}) {
  const lines=[],build=`${result.project.version} (${result.project.build})`;
  if(engine==='success')lines.push('- **Engine:** published. Servers install it by themselves when idle.');
  else if(engine)lines.push('- **Engine:** not published. The release job did not finish; see its run before retrying.');
  if(mac==='success')lines.push('- **Mac app:** update feed published. Macs offer the new build by themselves.');
  else if(mac==='skipped')lines.push(result.mac?`- **Mac app:** build ${build} is needed, but no \`Tupies.dmg\` was attached to this release, so Macs are not offered it yet.`:'- **Mac app:** unchanged.');
  else if(mac)lines.push('- **Mac app:** the update feed was not published; see the release run.');
  if(iphone==='success')lines.push(`- **iPhone app:** build ${build} uploaded to TestFlight. It appears there after Apple finishes processing it.`);
  else if(iphone==='skipped')lines.push(result.ios?`- **iPhone app:** build ${build} is needed. ${testflight?'The TestFlight upload did not run; start it from the Release workflow.':'TestFlight upload is not switched on, so build and install it from Xcode.'}`:'- **iPhone app:** unchanged. No new build is needed.');
  else if(iphone)lines.push(`- **iPhone app:** build ${build} is needed, but the TestFlight upload failed; see the release run.`);
  return lines;
}
const BLOCK_START='<!-- tupies-update-guide -->',BLOCK_END='<!-- /tupies-update-guide -->';
/** Puts the note at the end of a release's own description, replacing an earlier copy of the note. */
export function mergeReleaseNotes(body,block) {
  const start=body.indexOf(BLOCK_START),end=body.indexOf(BLOCK_END);
  const own=(start>=0&&end>start?body.slice(0,start)+body.slice(end+BLOCK_END.length):body).trimEnd();
  return `${own}${own?'\n\n':''}${BLOCK_START}\n${block.trim()}\n${BLOCK_END}\n`;
}

function git(args,{allowFailure=false}={}) {
  return new Promise((resolve,reject)=>execFile('git',args,{cwd:ROOT,maxBuffer:16*1024**2},(error,stdout)=>{
    if(error&&!allowFailure)reject(new Error(`git ${args.join(' ')} failed: ${error.message.split('\n')[0]}`));
    else resolve(error?null:stdout);
  }));
}
const lines=text=>(text||'').split('\n').map(line=>line.trim()).filter(Boolean);
const show=async(ref,file)=>ref?git(['show',`${ref}:${file}`],{allowFailure:true}):fs.readFile(path.join(ROOT,file),'utf8').catch(()=>null);

/** Changed paths between a base ref and either a head ref or, with no head, the working tree including untracked files. */
async function changedFiles(base,head) {
  const from=lines(await git(['merge-base',base,head||'HEAD'],{allowFailure:true}))[0]||base;
  if(head)return lines(await git(['diff','--name-only',from,head]));
  return [...new Set([...lines(await git(['diff','--name-only',from])),...lines(await git(['ls-files','--others','--exclude-standard']))])];
}
/** The newest versioned release tag before `ref` (the persistent `update-feeds` tag is not a version). */
async function lastRelease(ref,{before=false}={}) {
  return lines(await git(['describe','--tags','--abbrev=0','--match','v[0-9]*',before?`${ref}^`:ref],{allowFailure:true}))[0]||null;
}

/**
 * `base`/`head` bound the change being described. The stale-build check always compares with the last release,
 * so two pull requests that both touch the native app cannot ship under one build number.
 */
export async function updateImpact({base,head,beforeHead=false}={}) {
  const release=await lastRelease(head||'HEAD',{before:beforeHead}),from=base||release;
  if(!from)throw new Error('No base to compare with. Pass --base REF, or fetch the release tags (git fetch --tags).');
  const changed=classify(await changedFiles(from,head));
  const sinceRelease=release?(release===from?changed:classify(await changedFiles(release,head))):null;
  const projectText=await show(head,PROJECT),nativeText=await show(head,NATIVE_APPS),packageText=await show(head,'package.json');
  if(!projectText||!packageText)throw new Error('The Xcode project and package.json are required.');
  const project=projectVersion(projectText),releasedText=release?await show(release,PROJECT):null;
  let releasedBuild=null;try{if(releasedText)releasedBuild=projectVersion(releasedText).build;}catch{}
  const problems=versionProblems({packageVersion:JSON.parse(packageText).version,project,nativeApps:nativeText?JSON.parse(nativeText):null,nativeChanged:!!sinceRelease&&(sinceRelease.ios.length>0||sinceRelease.mac.length>0),releasedBuild});
  return {base:from,head:head||'working tree',release,engine:changed.engine.length>0,ios:changed.ios.length>0,mac:changed.mac.length>0,files:changed,project,releasedBuild,problems};
}

/** Writes one build number to every place that declares it. */
export async function bump(build) {
  const projectFile=path.join(ROOT,PROJECT),appsFile=path.join(ROOT,NATIVE_APPS),text=await fs.readFile(projectFile,'utf8'),current=projectVersion(text);
  const next=build??current.build+1;
  if(!Number.isInteger(next)||next<current.build)throw new Error(`Choose a build number of at least ${current.build}.`);
  await fs.writeFile(projectFile,text.replace(/\bCURRENT_PROJECT_VERSION = \d+;/g,`CURRENT_PROJECT_VERSION = ${next};`));
  const apps=JSON.parse(await fs.readFile(appsFile,'utf8'));
  for(const platform of ['ios','mac'])apps[platform]={...apps[platform],version:current.version,build:next};
  await fs.writeFile(appsFile,JSON.stringify(apps,null,2)+'\n');
  return {version:current.version,build:next};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2),options={format:'markdown'};
    for(let index=0;index<args.length;index++) {
      const name=args[index];
      if(name==='--check')options.check=true;
      else if(name==='--before-head')options.beforeHead=true;
      else if(name==='--bump'){options.bump=true;if(/^\d+$/.test(args[index+1]||''))options.build=Number(args[++index]);}
      else if(['--base','--head','--format','--heading','--outcome','--merge-into'].includes(name)&&args[index+1])options[name.slice(2)]=args[++index];
      else throw new Error('Usage: node scripts/update-impact.mjs [--base REF] [--head REF] [--before-head] [--format markdown|json|github] [--heading TEXT] [--check] [--bump [BUILD]] [--outcome engine=success,mac=skipped,iphone=skipped,testflight=true] [--merge-into RELEASE_BODY_FILE]');
    }
    if(options.bump) {
      const result=await bump(options.build);
      console.log(`The iPhone and Mac apps now build ${result.version} (${result.build}).`);
    } else {
      const result=await updateImpact(options);
      if(options.format==='json')console.log(JSON.stringify(result,null,2));
      else if(options.format==='github')console.log([`engine=${result.engine}`,`ios=${result.ios}`,`mac=${result.mac}`,`build=${result.project.build}`,`version=${result.project.version}`].join('\n'));
      else {
        let note=markdown(result,options.heading?{heading:options.heading}:{});
        if(options.outcome) {
          const outcome=Object.fromEntries(options.outcome.split(',').map(pair=>pair.split('=')));
          note+=['','**This release:**',...releaseOutcome(result,{...outcome,testflight:outcome.testflight==='true'})].join('\n')+'\n';
        }
        console.log(options['merge-into']?mergeReleaseNotes(await fs.readFile(options['merge-into'],'utf8'),note):note);
      }
      if(options.check&&result.problems.length){for(const problem of result.problems)console.error(`::error::${problem}`);process.exitCode=1;}
    }
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
