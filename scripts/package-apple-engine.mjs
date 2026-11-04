// Build Resources/Engine + Resources/Runtime from explicit, checksum-verified inputs.
// Never downloads a runtime, signs an app, installs it, or reads operational account data.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

export const PACKAGED_NODE_VERSION='22.23.4';
// Official https://nodejs.org/dist/v22.23.4/SHASUMS256.txt; the explicit checksum file must agree too.
export const PACKAGED_NODE_SHA256=Object.freeze({
  'node-v22.23.4-darwin-arm64.tar.gz':'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
  'node-v22.23.4-darwin-arm64.tar.xz':'037650d0839f457747396f052073fb48333d31bf5abd3c98b74da20d89ebb1ad',
  'node-v22.23.4-darwin-x64.tar.gz':'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
  'node-v22.23.4-darwin-x64.tar.xz':'f42abca7aaac61efc57d49fb42ea84fc53bbeba9a749cb03a291ce6e4e7a69c1',
});
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw new Error(message);};
const exists=async file=>fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const isWithin=(base,file)=>file===base||file.startsWith(base+path.sep);

export function runtimeIdentity(archive,arch) {
  if(!['arm64','x64'].includes(arch))fail('Choose the arm64 or x64 macOS runtime architecture.');
  const prefix=`node-v${PACKAGED_NODE_VERSION}-darwin-${arch}`;
  if(![`${prefix}.tar.gz`,`${prefix}.tar.xz`].includes(path.basename(archive)))fail(`Expected the official ${prefix} archive.`);
  return {prefix,version:PACKAGED_NODE_VERSION,arch,filename:path.basename(archive)};
}

export async function verifyNodeArchive(archive,checksums,arch) {
  const identity=runtimeIdentity(archive,arch),stat=await fs.lstat(archive);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>200_000_000)fail('The Node archive must be a regular bounded file.');
  const checksumStat=await fs.lstat(checksums);
  if(!checksumStat.isFile()||checksumStat.size>1_000_000)fail('Use the official bounded SHASUMS256.txt file.');
  const matches=(await fs.readFile(checksums,'utf8')).split(/\r?\n/).map(line=>line.match(/^([a-f0-9]{64})\s+\*?([^\s]+)\s*$/)).filter(match=>match?.[2]===identity.filename);
  if(matches.length!==1)fail('The checksum file must name the exact Node archive once.');
  if(matches[0][1]!==PACKAGED_NODE_SHA256[identity.filename])fail('The checksum file disagrees with the pinned official release digest. Nothing was executed.');
  const digest=sha256(await fs.readFile(archive));
  if(digest!==matches[0][1])fail('The Node archive does not match its official checksum. Nothing was executed.');
  return {...identity,sha256:digest};
}

export function verifyMachOArchitecture(bytes,arch) {
  const cpu=arch==='arm64'?0x0100000c:arch==='x64'?0x01000007:null;
  if(bytes.length<32||bytes.readUInt32LE(0)!==0xfeedfacf||bytes.readUInt32LE(4)!==cpu)fail('The extracted Node executable has the wrong macOS architecture. Nothing was executed.');
}

const deniedName=name=>name.startsWith('.')||/^(?:data|backups?|workspaces?|process-homes|state\.json|vault\.key|credentials?\.json|notifications\.json)$/i.test(name);
const publicExtensions=new Set(['.js','.mjs','.css','.html','.json','.svg','.png','.webp','.ttf','.woff','.woff2','.wasm','.bcmap','.pfb','.txt']);
async function copyTree(source,destination,allowed) {
  const stat=await fs.lstat(source);
  if(stat.isSymbolicLink())fail('Source payload symlinks are not allowed.');
  if(stat.isDirectory()) {
    await fs.mkdir(destination,{recursive:true,mode:0o755});
    for(const entry of (await fs.readdir(source)).sort())if(!deniedName(entry))await copyTree(path.join(source,entry),path.join(destination,entry),allowed);
  } else if(stat.isFile()&&allowed(path.basename(source))) {
    await fs.copyFile(source,destination);await fs.chmod(destination,0o644);
  }
}

/** Positive source allowlist: no .env, data, workspaces, tests, prototypes or installed dependencies. */
export async function stageEngineSource(repo,destination) {
  if(await exists(destination))fail('The source staging destination already exists.');
  await fs.mkdir(destination,{recursive:true,mode:0o755});
  for(const name of ['server.mjs','package.json','package-lock.json','LICENSE']) {
    const source=path.join(repo,name),stat=await fs.lstat(source);
    if(!stat.isFile()||stat.isSymbolicLink())fail(`Required source file ${name} must be a regular file.`);
    await fs.copyFile(source,path.join(destination,name));await fs.chmod(path.join(destination,name),0o644);
  }
  if(await exists(path.join(repo,'NOTICE')))await copyTree(path.join(repo,'NOTICE'),path.join(destination,'NOTICE'),()=>true);
  await fs.mkdir(path.join(destination,'scripts'),{recursive:true,mode:0o755});
  for(const name of ['pair.mjs','link-engine.mjs','runtime-backup.mjs','prepare-mac-update.mjs','update-backup.mjs']) {
    const source=path.join(repo,'scripts',name),stat=await fs.lstat(source);
    if(!stat.isFile()||stat.isSymbolicLink())fail(`Operational script ${name} must be a regular file.`);
    await fs.copyFile(source,path.join(destination,'scripts',name));await fs.chmod(path.join(destination,'scripts',name),0o644);
  }
  await copyTree(path.join(repo,'lib'),path.join(destination,'lib'),name=>name.endsWith('.mjs'));
  // These reviewed packages are runtime input for the catalog loaders. Do not widen
  // the general lib allowlist to arbitrary Markdown or other local files.
  for(const packageName of ['tupies-product','tupies-learning']) {
    const skillRoot=path.join('lib','skills',packageName);
    if(await exists(path.join(repo,skillRoot)))await copyTree(path.join(repo,skillRoot),path.join(destination,skillRoot),name=>name.endsWith('.md'));
  }
  await copyTree(path.join(repo,'public'),path.join(destination,'public'),name=>publicExtensions.has(path.extname(name))||/^(?:LICENSE|NOTICE)(?:_|$)/.test(name));
  await copyTree(path.join(repo,'assets','fonts'),path.join(destination,'assets','fonts'),name=>['.ttf','.woff','.woff2'].includes(path.extname(name))||/^(?:OFL|LICENSE|NOTICE)(?:\.|_|$)/.test(name));
  if(await exists(path.join(repo,'assets','tool-catalog')))await copyTree(path.join(repo,'assets','tool-catalog'),path.join(destination,'assets','tool-catalog'),name=>name.endsWith('.json'));
  await fs.mkdir(path.join(destination,'assets','licenses'),{recursive:true,mode:0o755});
  for(const name of ['THIRD_PARTY_LICENSES.txt','dependencies.json']) {
    const source=path.join(repo,'assets','licenses',name);
    if(await exists(source))await copyTree(source,path.join(destination,'assets','licenses',name),()=>true);
  }
  const lock=JSON.parse(await fs.readFile(path.join(destination,'package-lock.json'),'utf8'));
  for(const item of Object.values(lock.packages||{})) {
    if(item.link)fail('Local linked packages cannot enter the distributable engine.');
    if(item.resolved) {
      let url;try{url=new URL(item.resolved);}catch{}
      if(!url||url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.port||url.username||url.password||url.search||url.hash||!url.pathname.includes('/-/'))fail('Production dependencies must use the public npm registry lockfile, without credentials or local paths.');
    }
    if(item.resolved&&!/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(item.integrity||''))fail('Every downloaded dependency requires lockfile integrity.');
  }
}

async function run(command,args,{cwd,env,timeout=300_000,maxBytes=2_000_000}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']}),chunks=[];let size=0,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('A packaging command timed out.'));},timeout);
    const append=chunk=>{size+=chunk.length;if(size>maxBytes){child.kill('SIGKILL');finish(new Error('A packaging command exceeded its output limit.'));}else chunks.push(chunk);};
    child.stdout.on('data',append);child.stderr.on('data',append);child.once('error',error=>finish(error));
    child.once('close',code=>{
      const output=Buffer.concat(chunks);let error;
      if(code!==0){error=new Error(`Packaging command failed (${path.basename(command)} ${path.basename(args[0]||'')}, exit ${code}).`);error.packagingOutput=output;}
      finish(error,output);
    });
  });
}

async function manifestFiles(root,folder=root) {
  const records=[];
  for(const name of (await fs.readdir(folder)).sort()) {
    const file=path.join(folder,name),stat=await fs.lstat(file),relative=path.relative(root,file).split(path.sep).join('/');
    if(stat.isSymbolicLink()) {
      const target=await fs.realpath(file);if(!isWithin(root,target))fail('A dependency symlink escapes the payload.');
      records.push({path:relative,symlink:await fs.readlink(file)});
    } else if(stat.isDirectory())records.push(...await manifestFiles(root,file));
    else if(stat.isFile())records.push({path:relative,size:stat.size,sha256:sha256(await fs.readFile(file))});
    else fail('The payload contains a non-file artifact.');
  }
  return records;
}

async function defaultNpmCLI() {
  const candidate=process.env.npm_execpath||path.join(path.dirname(process.execPath),'npm');
  return fs.realpath(candidate).catch(()=>fail('Pass --npm-cli pointing to a trusted installed npm-cli.js.'));
}

export async function packageAppleEngine({archive,checksums,output,arch=process.arch,repo=ROOT,npmCLI}) {
  if(!archive||!checksums||!output)fail('Required: --node-archive, --checksums and --output.');
  output=path.resolve(output);repo=path.resolve(repo);
  if(await exists(output))fail('The output already exists. Choose a new payload destination.');
  const identity=await verifyNodeArchive(path.resolve(archive),path.resolve(checksums),arch);
  if(process.platform!=='darwin'||process.arch!==arch)fail('Build the payload on a Mac matching its Node architecture.');
  const parent=path.dirname(output);await fs.mkdir(parent,{recursive:true});
  const staging=path.join(parent,`.${path.basename(output)}-staging-${randomUUID()}`);
  await fs.mkdir(staging,{mode:0o700});
  try {
    const engine=path.join(staging,'Engine'),runtime=path.join(staging,'Runtime'),buildHome=path.join(staging,'.build-home');
    await fs.mkdir(runtime,{mode:0o755});await fs.mkdir(buildHome,{mode:0o700});
    const userConfig=path.join(buildHome,'user.npmrc'),globalConfig=path.join(buildHome,'global.npmrc');
    await fs.writeFile(userConfig,'',{mode:0o600});await fs.writeFile(globalConfig,'',{mode:0o600});
    const env={HOME:buildHome,TMPDIR:buildHome,PATH:`${runtime}:/usr/bin:/bin:/usr/sbin:/sbin`,LANG:'en_US.UTF-8',NPM_CONFIG_USERCONFIG:userConfig,NPM_CONFIG_GLOBALCONFIG:globalConfig,NPM_CONFIG_CACHE:path.join(buildHome,'cache'),NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/'};
    const listing=(await run('/usr/bin/tar',['-tf',path.resolve(archive)],{env})).toString().split(/\r?\n/);
    for(const member of [`${identity.prefix}/bin/node`,`${identity.prefix}/LICENSE`])if(listing.filter(item=>item===member).length!==1)fail('The verified archive must contain each selected runtime member exactly once.');
    const nodeBytes=await run('/usr/bin/tar',['-xOf',path.resolve(archive),`${identity.prefix}/bin/node`],{env,maxBytes:200_000_000});
    verifyMachOArchitecture(nodeBytes,arch);
    const node=path.join(runtime,'node');await fs.writeFile(node,nodeBytes,{mode:0o755});
    const license=await run('/usr/bin/tar',['-xOf',path.resolve(archive),`${identity.prefix}/LICENSE`],{env,maxBytes:5_000_000});
    await fs.writeFile(path.join(runtime,'LICENSE'),license,{mode:0o644});
    if((await run(node,['--version'],{env})).toString().trim()!==`v${PACKAGED_NODE_VERSION}`)fail('The verified runtime did not report the pinned Node version.');
    await stageEngineSource(repo,engine);
    const npm=path.resolve(npmCLI||await defaultNpmCLI());
    const npmVersion=(await run(node,[npm,'--version'],{env})).toString().trim();
    await run(node,[npm,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:engine,env});
    // Real production dependency, native-library, font and document-worker check with fresh private data.
    const smoke=path.join(staging,'.smoke.mjs'),data=path.join(buildHome,'smoke-data');
    await fs.writeFile(smoke,`import assert from 'node:assert/strict';import {createRequire} from 'node:module';const sharp=createRequire(${JSON.stringify(path.join(engine,'package.json'))})('sharp');const image=await sharp({create:{width:2,height:2,channels:4,background:'#8ab4ff'}}).png().toBuffer();assert.equal((await sharp(image).metadata()).width,2);const {createStudioServer}=await import(${JSON.stringify(pathToFileURL(path.join(engine,'server.mjs')).href)});const {createDocument}=await import(${JSON.stringify(pathToFileURL(path.join(engine,'lib/documents.mjs')).href)});const {AgentTools}=await import(${JSON.stringify(pathToFileURL(path.join(engine,'lib/agent-tools.mjs')).href)});const app=await createStudioServer({dataDir:${JSON.stringify(data)},scheduler:false,tls:'off',publicUrl:'',logErrors:false});try{const {url}=await app.listen(0);const info=await fetch(url+'/api/engine').then(r=>r.json());assert.equal(info.protocols.deviceSession,2);const doc=await createDocument(app.store,app.store.state.bots[0].id,{path:'bundle-smoke.pdf',document:{title:'Bundle smoke',content:'# Bundled engine\\n\\nGenerated with packaged dependencies and fonts.'}});assert.equal(doc.artifact?.format,'pdf');assert.ok(doc.size>0);const bot={...app.store.state.bots[0],tools:['workspace','terminal']};const command=await new AgentTools(app.store).execute(bot,'shell_run',{executable:'node',args:['-p','process.execPath']},{approved:true});assert.equal(command.exitCode,0);assert.equal(command.stdout.trim(),process.execPath);console.log('PASS packaged engine, native image dependency, fonts, PDF worker and named Node command');}finally{await app.close();}`);
    const smokeOutput=(await run(node,[smoke],{env,timeout:90_000})).toString().trim();
    await fs.rm(smoke);await fs.rm(buildHome,{recursive:true,force:true});
    const files=await manifestFiles(staging);
    await fs.writeFile(path.join(staging,'payload-manifest.json'),JSON.stringify({version:1,hashScope:'unsigned-payload-before-application-signing',engineVersion:JSON.parse(await fs.readFile(path.join(engine,'package.json'),'utf8')).version,node:{version:identity.version,arch:identity.arch,archive:identity.filename,sha256:identity.sha256},npmVersion,smoke:smokeOutput,files},null,2)+'\n',{mode:0o644});
    await fs.chmod(staging,0o755);await fs.rename(staging,output);
    return {output,nodeVersion:identity.version,arch,files:files.length,smoke:smokeOutput};
  } catch(error) {
    if(error.packagingOutput)await fs.writeFile(`${output}.packaging-failure.log`,error.packagingOutput,{mode:0o600});
    await fs.rm(staging,{recursive:true,force:true});throw error;
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2),values={};
    for(let index=0;index<args.length;index+=2) {
      if(!['--node-archive','--checksums','--output','--arch','--npm-cli'].includes(args[index])||!args[index+1])fail('Use --node-archive PATH --checksums PATH --output NEW_PATH [--arch arm64|x64] [--npm-cli PATH].');
      values[args[index].slice(2)]=args[index+1];
    }
    console.log(JSON.stringify(await packageAppleEngine({archive:values['node-archive'],checksums:values.checksums,output:values.output,arch:values.arch,npmCLI:values['npm-cli']})));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
