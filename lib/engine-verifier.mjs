// Maintainer-owned Docker boundary. No model tool can choose an executable, image or socket.
import { spawn } from 'node:child_process';
import { promises as fs, constants as FS } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { ensure } from './store.mjs';
import { workshopDigest } from './workshop.mjs';

export const VERIFIER_POLICY=Object.freeze({version:3,seccompSha256:'68ecf0e34a56eb1135ebbba806df1406539f873104466cd5a4b9c3048afc627b',shm:268435456,memory:4294967296,cpus:2,pids:512,wallMs:1200000,outputBytes:65536});
const LABEL='dev.tupies.engine-verifier',JOB='dev.tupies.verifier-job';
const IMAGE=/^sha256:[a-f0-9]{64}$/;
const ID=/^[a-f0-9]{64}$/;
export function validateVerifierBundle(bundle,reviewedDigest){
  ensure(bundle&&bundle.format==='tupies-contribution-v1'&&bundle.proposal?.format==='tupies-improvement-v1'&&bundle.proposal.kind==='engine'&&bundle.proposal.candidate?.format==='tupies-engine-candidate-v1',400,'Choose an exported Engine candidate.');
  ensure(ID.test(reviewedDigest)&&bundle.digest===reviewedDigest&&workshopDigest(bundle.proposal)===reviewedDigest,409,'Review the exact contribution digest before verification.');
  ensure(Buffer.byteLength(JSON.stringify(bundle))<=150000,413,'Contribution exceeds 150 KB.');
  return structuredClone(bundle);
}
export async function readVerifierBundle(file,reviewedDigest){
  const handle=await fs.open(path.resolve(file),FS.O_RDONLY|FS.O_NOFOLLOW);
  try{const stat=await handle.stat();ensure(stat.isFile()&&stat.size<=150000,413,'Choose a regular contribution under 150 KB.');const bytes=await handle.readFile();ensure(bytes.length<=150000,413,'Contribution exceeds 150 KB.');return validateVerifierBundle(JSON.parse(bytes),reviewedDigest);}finally{await handle.close();}
}
export function verifierConfig({image,executable,socket}){
  ensure(IMAGE.test(image),400,'Pin a locally prepared verifier image by its full sha256 image ID; tags are refused.');
  for(const [name,value] of Object.entries({executable,socket}))ensure(typeof value==='string'&&path.isAbsolute(value)&&value.length<=500&&!/[\x00-\x1f\x7f]/.test(value),400,`Choose an absolute local ${name} path.`);
  ensure(socket.endsWith('.sock'),400,'Use an explicit local Unix Docker socket, not a remote daemon.');
  return {image,executable,socket};
}
export async function readVerifierSeccomp(){
  const bytes=await fs.readFile(new URL('../assets/engine-verifier/seccomp.json',import.meta.url));
  ensure(createHash('sha256').update(bytes).digest('hex')===VERIFIER_POLICY.seccompSha256,409,'The fixed verifier seccomp profile changed.');return bytes;
}
export function verifierCreateArgs(image,name,jobId,seccompPath){
  ensure(typeof seccompPath==='string'&&path.isAbsolute(seccompPath),400,'A fixed local verifier profile is required.');
  return ['create','--pull','never','--name',name,'--label',`${JOB}=${jobId}`,'--network','none','--log-driver','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges=true','--security-opt',`seccomp=${seccompPath}`,'--user','10001:10001','--pids-limit',String(VERIFIER_POLICY.pids),'--cpus','2','--memory',String(VERIFIER_POLICY.memory),'--memory-swap',String(VERIFIER_POLICY.memory),'--ulimit','nofile=4096:4096','--ipc','private','--shm-size',String(VERIFIER_POLICY.shm),'--init','--stop-timeout','2','--tmpfs','/work:rw,exec,nosuid,nodev,size=2147483648,uid=10001,gid=10001,mode=0700','--tmpfs','/tmp:rw,exec,nosuid,nodev,size=1073741824,uid=10001,gid=10001,mode=1777','--hostname',name,'--env','NODE_OPTIONS=','--env','TUPIES_BUILD_WEB_ONLY=1','--entrypoint','/usr/local/bin/node','-i',image,'/opt/tupies-verifier/runner.mjs'];
}
export function inspectVerifierContainer(value,{image,jobId}){
  const h=value?.HostConfig,c=value?.Config;
  ensure(ID.test(value?.Id)&&value.Image===image&&c?.Labels?.[JOB]===jobId,409,'Container ownership or image identity changed.');
  ensure(h?.NetworkMode==='none'&&h.LogConfig?.Type==='none'&&h.ReadonlyRootfs===true&&h.Privileged===false&&h.CapDrop?.includes('ALL')&&!h.CapAdd?.length&&!h.Binds?.length&&!h.Mounts?.length&&!h.Devices?.length&&!value.Mounts?.length&&!Object.keys(h.PortBindings || {}).length&&!h.PublishAllPorts,409,'Container isolation or mounts differ from the fixed policy.');
  ensure(c.User==='10001:10001'&&h.IpcMode==='private'&&h.ShmSize===VERIFIER_POLICY.shm&&h.PidMode===''&&h.UsernsMode===''&&h.Memory===VERIFIER_POLICY.memory&&h.MemorySwap===VERIFIER_POLICY.memory&&h.NanoCpus===2000000000&&h.PidsLimit===VERIFIER_POLICY.pids,409,'Container identities or resource limits differ from the fixed policy.');
  const security=h.SecurityOpt || [];let profile;try{profile=JSON.parse(security.find(item=>item.startsWith('seccomp='))?.slice(8));}catch{}
  ensure(security.length===2&&security.includes('no-new-privileges=true')&&profile&&workshopDigest(profile)==='7d5defd9bf31fe191452b3b2d9bce1c0b0c2aed9edae3ad49444673eecfabb80',409,'Required fixed container security options are missing or changed.');
  const args=verifierCreateArgs(image,'unused',jobId,'/unused/seccomp.json'),tmpfs=Object.fromEntries(args.flatMap((arg,index)=>arg==='--tmpfs'?[[args[index+1].split(':')[0],args[index+1].split(':')[1]]]:[]));
  ensure(workshopDigest(h.Tmpfs)===workshopDigest(tmpfs)&&JSON.stringify(c.Entrypoint)==='["/usr/local/bin/node"]'&&JSON.stringify(c.Cmd)==='["/opt/tupies-verifier/runner.mjs"]',409,'Container scratch space or entrypoint changed.');
  return value.Id;
}
function dockerClient(config,configDir){
  return (args,{input,signal,timeoutMs=20000}={})=>new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason || new Error('Verification cancelled.'));return;}
    const child=spawn(config.executable,['--host',`unix://${config.socket}`,'--config',configDir,...args],{env:{PATH:'/usr/local/bin:/usr/bin:/bin'},shell:false,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',bytes=0,failure;
    const stop=error=>{failure ||= error;child.kill('SIGKILL');};
    const abort=()=>stop(signal.reason || new Error('Verification cancelled.'));
    const timer=setTimeout(()=>stop(new Error('Verifier command timed out.')),timeoutMs);
    for(const [stream,key] of [[child.stdout,'out'],[child.stderr,'err']])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>VERIFIER_POLICY.outputBytes)return stop(new Error('Verifier output exceeded its limit.'));if(key==='out')stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8');});
    child.once('error',error=>{failure=error.code==='ENOENT'?new Error('Docker executable is unavailable; no host execution fallback exists.'):new Error('Could not start the local Docker client.');});
    child.stdin.on('error',()=>{});child.stdin.end(input);
    child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);failure?reject(failure):resolve({code,stdout,stderr});});
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}
async function jsonCommand(client,args,options){const result=await client(args,options);ensure(result.code===0,409,'Local verifier runtime command failed: '+String(result.stderr || '').slice(0,500));try{return JSON.parse(result.stdout);}catch{throw new Error('Verifier runtime returned invalid metadata.');}}
export function validateVerifierResult(value,digest){
  ensure(value?.format==='tupies-engine-verifier-result-v1'&&value.proposalDigest===digest&&Array.isArray(value.checks)&&value.checks.length<=5,409,'Verifier result identity or schema is invalid.');
  const expected=['syntax','tests-sequential','tests-concurrent','build'];
  ensure(value.checks.every((check,index)=>check.name===expected[index]&&Number.isInteger(check.exitCode)&&typeof check.passed==='boolean'&&typeof check.log==='string'&&check.log.length<=4096),409,'Verifier result checks are invalid.');
  const passed=value.checks.length===4&&value.checks.every(check=>check.passed&&check.exitCode===0)&&value.sourceUnchanged===true;
  for(const check of value.checks.filter(check=>check.name.startsWith('tests-')))ensure(Number.isSafeInteger(check.tests)&&check.tests>0&&check.failed===0&&check.skipped===0&&check.cancelled===0&&check.todo===0||!check.passed,409,'A passing suite must include tests with no failures, skips, cancellations or TODO tests.');
  ensure(value.passed===passed&&value.fullSuite===passed&&value.build===passed&&typeof value.sourceUnchanged==='boolean'&&(!passed||value.sourceUnchanged),409,'Verifier completion evidence is inconsistent.');
  return {passed,fullSuite:passed,build:passed,sourceUnchanged:value.sourceUnchanged,...(typeof value.error==='string'?{error:value.error.slice(0,500)}:{}),checks:value.checks.map(check=>({...check,log:check.log.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'')}))};
}
export async function runEngineVerification(bundle,options){
  bundle=validateVerifierBundle(bundle,options.reviewedDigest);const config=verifierConfig(options);
  const jobId=randomBytes(16).toString('hex'),name=`tupies-verify-${jobId}`,configDir=await fs.mkdtemp(path.join(tmpdir(),'tupies-verifier-client-'));
  const client=options.client || dockerClient(config,configDir),signal=options.signal;
  const report={format:'tupies-engine-verification-receipt-v1',proposalDigest:bundle.digest,image:config.image,jobId,policy:VERIFIER_POLICY,passed:false,fullSuite:false,build:false,outcome:'not-started',cleanup:'not-needed',checks:[],notice:'Container exit codes and fixed-runner results, not a security or semantic correctness certification. Logs and contributed tests are untrusted data. No source is applied or deployed.'};
  let attempted=false;
  try {
    const info=await jsonCommand(client,['info','--format','{{json .}}'],{signal});
    ensure(info.OSType==='linux'&&info.SecurityOptions?.some(item=>item.includes('seccomp'))&&(info.SecurityOptions.some(item=>item.includes('rootless')||item.includes('userns'))||/Docker Desktop/i.test(info.OperatingSystem || '')),409,'Use Linux Docker with rootless/user namespaces, or Docker Desktop, and seccomp. No weaker fallback is allowed.');
    const image=await jsonCommand(client,['image','inspect','--format','{{json .}}',config.image],{signal});
    ensure(image.Id===config.image&&image.Os==='linux'&&image.Config?.Labels?.[LABEL]==='1'&&!Object.keys(image.Config.Volumes || {}).length,409,'The pinned image is not a dedicated verifier image, or declares volumes.');
    ensure(!(image.Config.Env || []).some(item=>/^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|ENV|STUDIO_[A-Z_]+)=.+/.test(item)),409,'The verifier image contains unsafe inherited environment configuration.');
    const seccompPath=path.join(configDir,'seccomp.json');await fs.writeFile(seccompPath,await readVerifierSeccomp(),{flag:'wx',mode:0o600});
    signal?.throwIfAborted();attempted=true;report.outcome='unknown';
    const created=await client(verifierCreateArgs(config.image,name,jobId,seccompPath),{signal});ensure(created.code===0&&ID.test(created.stdout.trim()),409,'Container creation did not return a confirmed identity: '+String(created.stderr || '').slice(0,500));
    const container=await jsonCommand(client,['container','inspect','--format','{{json .}}',name],{signal});const containerId=inspectVerifierContainer(container,{image:config.image,jobId});ensure(containerId===created.stdout.trim(),409,'Created container identity changed.');
    const result=await client(['start','--attach','--interactive',containerId],{input:JSON.stringify(bundle),signal,timeoutMs:VERIFIER_POLICY.wallMs});
    const finished=await jsonCommand(client,['container','inspect','--format','{{json .}}',containerId],{signal});inspectVerifierContainer(finished,{image:config.image,jobId});
    ensure(finished.State?.Running===false&&!finished.State.OOMKilled&&finished.State.ExitCode===result.code,409,'Container completion is unknown, still running or memory-limited.');
    let evidence;try{evidence=validateVerifierResult(JSON.parse(result.stdout),bundle.digest);}catch{throw new Error('No valid complete verifier result was received; inspect the candidate before retrying.');}
    ensure(result.code===0?evidence.passed:!evidence.passed,409,'Container exit code and result disagree.');
    signal?.throwIfAborted();Object.assign(report,evidence,{outcome:evidence.passed?'completed':'failed'});
  }catch(error){report.error=String(error.message || 'Verification failed.').slice(0,500);if(signal?.aborted)report.outcome='interrupted';else if(!attempted)report.outcome='not-started';}
  finally {
    if(attempted){
      try{const owned=await jsonCommand(client,['container','inspect','--format','{{json .}}',name]);ensure(ID.test(owned.Id)&&owned.Config?.Labels?.[JOB]===jobId,409,'Cleanup ownership could not be confirmed.');const removed=await client(['rm','--force',owned.Id]);ensure(removed.code===0,409,'Container removal was not confirmed.');report.cleanup='removed';}
      catch{report.cleanup='unconfirmed';report.passed=false;report.fullSuite=false;report.build=false;report.outcome='unknown';report.error='Container cleanup could not be confirmed. Inspect the exact verifier job before starting another.';}
    }
    await fs.rm(configDir,{recursive:true,force:true});
  }
  if(signal?.aborted&&report.cleanup!=='unconfirmed'){report.passed=false;report.fullSuite=false;report.build=false;report.outcome='interrupted';report.error='Operator stopped verification.';}
  return report;
}
