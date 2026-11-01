// Installed outside the candidate tree in a dedicated immutable verifier image.
// Never invoke this file on a host: main() refuses non-container kernel/resource evidence.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const BASE='/opt/tupies-source',WORK='/work/project';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function parseTestSummary(text){
  const value=key=>{const matches=[...text.matchAll(new RegExp(`^# ${key} (\\d+)$`,'gm'))];if(matches.length!==1)throw new Error('Missing or ambiguous test summary.');return Number(matches[0][1]);};
  return {tests:value('tests'),failed:value('fail'),skipped:value('skipped'),cancelled:value('cancelled'),todo:value('todo')};
}
export function assertVerifierKernel({platform,uid,status,memory,pids,cpu,interfaces}){
  if(platform!=='linux'||uid!==10001||!/^NoNewPrivs:\s+1$/m.test(status)||!/^Seccomp:\s+2$/m.test(status))throw new Error('Required kernel isolation is unavailable.');
  if(!/^\d+$/.test(memory)||Number(memory)<=0||Number(memory)>4294967296||!/^\d+$/.test(pids)||Number(pids)<=0||Number(pids)>512)throw new Error('Memory and process limits are not enforced.');
  const [quota,period]=cpu.split(/\s+/).map(Number);if(!Number.isFinite(quota)||quota<=0||!Number.isFinite(period)||period<=0||quota/period>2)throw new Error('CPU quota is not enforced.');
  if(Object.keys(interfaces).some(name=>name!=='lo'))throw new Error('An external network interface is present.');
}
export async function collectVerifierTests(root){
  const files=[];let visited=0;
  async function walk(dir,depth=0){if(depth>12)throw new Error('Test discovery nesting exceeds its limit.');for(const entry of await fs.readdir(path.join(root,dir),{withFileTypes:true})){if(++visited>4096)throw new Error('Test discovery exceeds its limit.');const name=path.posix.join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('Test symlinks are refused.');if(entry.isDirectory())await walk(name,depth+1);else if(entry.isFile()&&name.endsWith('.test.mjs'))files.push(name);}}
  await walk('test');return files.sort();
}
async function kernel(){assertVerifierKernel({platform:process.platform,uid:process.getuid?.(),status:await fs.readFile('/proc/self/status','utf8'),memory:(await fs.readFile('/sys/fs/cgroup/memory.max','utf8')).trim(),pids:(await fs.readFile('/sys/fs/cgroup/pids.max','utf8')).trim(),cpu:(await fs.readFile('/sys/fs/cgroup/cpu.max','utf8')).trim(),interfaces:os.networkInterfaces()});}
async function input(){let bytes=0;const chunks=[];for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>150000)throw new Error('Contribution exceeds its input bound.');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
async function sourceHashes(root,selected=[]){
  const result={};async function walk(relative){for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){const name=path.posix.join(relative,entry.name);if(entry.isDirectory())await walk(name);else if(entry.isFile()&&/\.(?:m?js|json)$/.test(name))result[name]=hash(await fs.readFile(path.join(root,name)));}}
  for(const dir of ['lib','test','scripts'])await walk(dir);
  for(const name of ['server.mjs','package.json','package-lock.json'])result[name]=hash(await fs.readFile(path.join(root,name)));
  for(const name of selected)result[name]=hash(await fs.readFile(path.join(root,name)));
  return result;
}
export function verifierDiagnosticLog(text,passed){
  if(passed)return text.slice(-4096);
  const failure=text.search(/^[ \t]*not ok /m),names=[...text.matchAll(/^[ \t]*not ok [^\n]+/gm)].slice(0,10).map(match=>match[0].slice(0,100)).join('\n');return failure<0?text.slice(-4096):(text.slice(failure,failure+2200)+'\n… failing checks …\n'+names+'\n… final summary …\n'+text.slice(-600)).slice(0,4096);
}
async function command(name,exe,args,{cwd=WORK,timeoutMs=600000,input}={}){
  const started=Date.now();return new Promise(resolve=>{
    const child=spawn(exe,args,{cwd,env:{PATH:'/usr/local/bin:/usr/bin:/bin',TUPIES_BUILD_WEB_ONLY:'1',TMPDIR:'/work',LANG:'C.UTF-8'},shell:false,detached:true,stdio:['pipe','pipe','pipe']});
    child.stdin.on('error',()=>{});child.stdin.end(input);
    let text='',bytes=0,failure=false;
    const kill=()=>{failure=true;try{process.kill(-child.pid,'SIGKILL');}catch{}};
    const timer=setTimeout(kill,timeoutMs);
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>4000000)kill();else text+=chunk.toString('utf8');});
    child.once('error',()=>{failure=true;});
    child.once('close',code=>{clearTimeout(timer);const result={name,exitCode:Number.isInteger(code)?code:1,passed:code===0&&!failure,durationMs:Date.now()-started,log:''};
      if(name.startsWith('tests-')){try{Object.assign(result,parseTestSummary(text));result.passed&&=result.tests>0&&result.failed===0&&result.skipped===0&&result.cancelled===0&&result.todo===0;}catch{result.passed=false;}}
      result.log=verifierDiagnosticLog(text,result.passed);resolve(result);
    });
  });
}
export async function verifyDocumentWorker(root){
  const sharp=createRequire(path.join(root,'package.json'))('sharp');
  const pixel=await sharp({create:{width:16,height:16,channels:3,background:'#e02020'}}).png().toBuffer();
  const worker=await command('document-worker-preflight',process.execPath,['--max-old-space-size=256','--experimental-permission','--allow-addons',...['lib','node_modules','assets/fonts','package.json'].map(name=>'--allow-fs-read='+path.join(root,name)),path.join(root,'lib/document-worker.mjs')],{cwd:root,input:JSON.stringify({operation:'image',data:pixel.toString('base64')})});
  if(!worker.passed||!worker.log.includes('"ok":true'))throw new Error('Restricted document worker: '+worker.log.replace(/^.*ExperimentalWarning.*$/gm,'').replace(/^.*Use `node.*$/gm,'').trim().slice(0,460));
}
export async function verifierMain(){
  const result={format:'tupies-engine-verifier-result-v1',proposalDigest:'',passed:false,fullSuite:false,build:false,sourceUnchanged:false,checks:[]};
  try {
    const bundle=await input();result.proposalDigest=bundle.digest;await kernel();
    const {validateVerifierBundle}=await import(pathToFileURL(BASE+'/lib/engine-verifier.mjs'));
    const {verifyEngineCandidate}=await import(pathToFileURL(BASE+'/lib/engine-workshop.mjs'));
    const {workshopDigest}=await import(pathToFileURL(BASE+'/lib/workshop.mjs'));
    validateVerifierBundle(bundle,bundle.digest);
    if(bundle.proposal.candidate.request.changes.some(change=>change.path==='package.json'))throw new Error('Dependency or npm script changes require a separately reviewed verifier image.');
    const candidate=await verifyEngineCandidate(bundle.proposal.candidate.request,{root:BASE});
    if(candidate.patch!==bundle.proposal.patch||workshopDigest(candidate.base)!==workshopDigest(bundle.proposal.candidate.base))throw new Error('Exported edits or base hashes do not match the immutable image.');
    const {BrowserSession}=await import(pathToFileURL(BASE+'/lib/browser.mjs'));
    try{const browser=await BrowserSession.start({executable:'/usr/bin/chromium',profileRoot:'/tmp/verifier-browser-probe',noSandbox:false});await browser.close();}
    catch(error){const diagnostic=await command('browser-diagnostic','/usr/bin/chromium',['--headless=new','--no-first-run','--disable-background-networking','--disable-extensions','--user-data-dir=/tmp/verifier-browser-diagnostic','--dump-dom','about:blank'],{cwd:'/tmp',timeoutMs:15000});throw new Error(error.message+' '+diagnostic.log.slice(0,440));}
    await fs.rm('/tmp/verifier-browser-probe',{recursive:true,force:true});
    await fs.cp(BASE,WORK,{recursive:true,verbatimSymlinks:true,errorOnExist:true,force:false});
    for(const change of candidate.request.changes){const target=path.join(WORK,change.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,candidate.files[change.path]);}
    const selected=candidate.base.map(entry=>entry.path),before=await sourceHashes(WORK,selected),sequential=['browser-control.test.mjs','lsp.test.mjs','questions-history.test.mjs','team.test.mjs'];
    const rest=(await collectVerifierTests(WORK)).filter(name=>!sequential.some(file=>name==='test/'+file));
    await verifyDocumentWorker(WORK);
    const checks=[['syntax',process.execPath,['scripts/check.mjs']],['tests-sequential',process.execPath,['--test','--test-reporter=tap','--test-concurrency=1',...sequential.map(name=>'test/'+name)]],['tests-concurrent',process.execPath,['--test','--test-reporter=tap','--test-concurrency=4',...rest]],['build','/usr/local/bin/npm',['run','build']]];
    for(const args of checks){const checked=await command(...args);result.checks.push(checked);if(!checked.passed)break;}
    result.sourceUnchanged=workshopDigest(before)===workshopDigest(await sourceHashes(WORK,selected));
    result.passed=result.checks.length===4&&result.checks.every(check=>check.passed)&&result.sourceUnchanged;result.fullSuite=result.passed;result.build=result.passed;
  }catch(error){result.error=String(error.message || 'Verifier failed.').slice(0,500);}
  process.stdout.write(JSON.stringify(result)+'\n');return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){const result=await verifierMain();process.exitCode=result.passed?0:1;}
