import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { workshopDigest } from '../lib/workshop.mjs';
import { VERIFIER_POLICY, readVerifierSeccomp, verifierConfig, verifierCreateArgs, validateVerifierBundle, readVerifierBundle, inspectVerifierContainer, validateVerifierResult, runEngineVerification } from '../lib/engine-verifier.mjs';
import { parseVerifierArguments, verifyCandidateCLI } from '../scripts/verify-engine-candidate.mjs';
import { parseTestSummary, assertVerifierKernel, collectVerifierTests, verifierDiagnosticLog } from '../scripts/engine-verifier-runner.mjs';

const seccomp=JSON.parse(await readVerifierSeccomp());
const image='sha256:'+'a'.repeat(64),id='b'.repeat(64),jobLabel='dev.tupies.verifier-job';
const config={image,executable:'/fixture/no-docker',socket:'/fixture/docker.sock'};
function bundle(){const proposal={format:'tupies-improvement-v1',kind:'engine',candidate:{format:'tupies-engine-candidate-v1',request:{changes:[],dependencies:[],tests:[]}}};return {format:'tupies-contribution-v1',proposal,digest:workshopDigest(proposal)};}
function evidence(digest){return {format:'tupies-engine-verifier-result-v1',proposalDigest:digest,passed:true,fullSuite:true,build:true,sourceUnchanged:true,checks:['syntax','tests-sequential','tests-concurrent','build'].map(name=>({name,exitCode:0,passed:true,log:'fixture',...(name.startsWith('tests-')?{tests:10,failed:0,skipped:0,cancelled:0,todo:0}:{})}))};}
function container(jobId){return {Id:id,Image:image,Config:{Labels:{[jobLabel]:jobId},User:'10001:10001',Entrypoint:['/usr/local/bin/node'],Cmd:['/opt/tupies-verifier/runner.mjs']},HostConfig:{NetworkMode:'none',LogConfig:{Type:'none'},ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],IpcMode:'private',ShmSize:VERIFIER_POLICY.shm,Memory:VERIFIER_POLICY.memory,MemorySwap:VERIFIER_POLICY.memory,NanoCpus:2000000000,PidsLimit:512,SecurityOpt:['no-new-privileges=true','seccomp='+JSON.stringify(seccomp)],Tmpfs:{'/work':'rw,nosuid,nodev,size=2147483648,uid=10001,gid=10001,mode=0700','/tmp':'rw,nosuid,nodev,size=1073741824,uid=10001,gid=10001,mode=1777'}},Mounts:[],State:{Running:false,OOMKilled:false,ExitCode:0}};}
// Protocol fixtures never create a real container or assert kernel-level acceptance.
function runtime(changes={}){
  const calls=[],state={};const client=async(args,options={})=>{
    calls.push({args,options});const json=value=>({code:0,stdout:JSON.stringify(value),stderr:''});
    if(args[0]==='info')return json(changes.info || {OSType:'linux',SecurityOptions:['name=seccomp,profile=builtin','name=rootless']});
    if(args[0]==='image')return json(changes.image || {Id:image,Os:'linux',Config:{Labels:{'dev.tupies.engine-verifier':'1'},Env:[],Volumes:{}}});
    if(args[0]==='create'){state.job=args[args.indexOf('--label')+1].split('=')[1];state.container=container(state.job);changes.container?.(state.container);if(changes.createError)throw new Error('Fixture creation reply lost');return {code:0,stdout:id+'\n'};}
    if(args[0]==='container'){if(changes.inspectError)throw new Error('Fixture unavailable metadata');return json(state.container);}
    if(args[0]==='start'){assert.equal(options.timeoutMs,VERIFIER_POLICY.wallMs);state.started=true;const input=JSON.parse(options.input);assert.equal(input.digest,workshopDigest(input.proposal));if(changes.start)return changes.start(state,options);const result=evidence(input.digest);changes.result?.(result);state.container.State.ExitCode=result.passed?0:1;return {code:state.container.State.ExitCode,stdout:JSON.stringify(result)};}
    if(args[0]==='rm'){assert.equal(options.signal,undefined);if(changes.cleanup)await changes.cleanup(state,options);return {code:changes.cleanupError?1:0,stdout:id};}
    throw new Error('Unexpected fixture command');
  };return {client,calls,state};
}
async function run(changes={},options={}){const f=runtime(changes),b=bundle(),report=await runEngineVerification(b,{...config,reviewedDigest:b.digest,client:f.client,...options});return {...f,report};}
async function directory(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-verifier-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('verifier requires a reviewed exact Engine export and pinned local runtime configuration',()=>{
  const b=bundle();assert.deepEqual(validateVerifierBundle(b,b.digest),b);
  for(const other of [{...b,digest:'0'.repeat(64)},{...b,proposal:{...b.proposal,kind:'tool'}},{...b,format:'other'}])assert.throws(()=>validateVerifierBundle(other,b.digest));
  assert.throws(()=>validateVerifierBundle(b,'wrong'));
  const large=bundle();large.proposal.padding='x'.repeat(150000);large.digest=workshopDigest(large.proposal);assert.throws(()=>validateVerifierBundle(large,large.digest),/150 KB/);
  for(const patch of [{image:'node:latest'},{image:'sha256:abc'},{executable:'docker'},{socket:'tcp://host:2375'},{socket:'/tmp/not-a-socket'},{executable:'/tmp/bad\ncommand'}])assert.throws(()=>verifierConfig({...config,...patch}));
});
test('bundle admission rejects symlinks, oversized files and stale reviewed identities',async t=>{
  const dir=await directory(t),file=path.join(dir,'bundle.json'),b=bundle();await fs.writeFile(file,JSON.stringify(b));
  assert.deepEqual(await readVerifierBundle(file,b.digest),b);await assert.rejects(readVerifierBundle(file,'0'.repeat(64)),/digest/);
  await fs.symlink(file,path.join(dir,'link'));await assert.rejects(readVerifierBundle(path.join(dir,'link'),b.digest));
  await fs.writeFile(file,'x'.repeat(150001));await assert.rejects(readVerifierBundle(file,b.digest),/150 KB/);
});
test('operator CLI is inert by default, refuses ambiguous flags and never overwrites receipts',async t=>{
  const dir=await directory(t),file=path.join(dir,'bundle.json'),b=bundle();await fs.writeFile(file,JSON.stringify(b));
  const args=[file,'--reviewed',b.digest,'--image',image,'--docker',config.executable,'--socket',config.socket];
  assert.equal((await verifyCandidateCLI(args)).planOnly,true);
  for(const tail of [['--run'],['--shell','sh'],['--image',image],['--run','--run']])assert.throws(()=>parseVerifierArguments([...args,...tail]));
  const output=path.join(dir,'receipt.json');await fs.writeFile(output,'keep');await assert.rejects(verifyCandidateCLI([...args,'--run','--output',output]),/new receipt/);assert.equal(await fs.readFile(output,'utf8'),'keep');
});
test('missing Docker saves a failed receipt without host execution fallback',async t=>{
  const dir=await directory(t),file=path.join(dir,'bundle.json'),output=path.join(dir,'receipt.json'),b=bundle();await fs.writeFile(file,JSON.stringify(b));
  const result=await verifyCandidateCLI([file,'--reviewed',b.digest,'--image',image,'--docker',path.join(dir,'absent-docker'),'--socket',path.join(dir,'docker.sock'),'--run','--output',output]);
  assert.equal(result.passed,false);assert.equal(result.outcome,'not-started');assert.equal(result.cleanup,'not-needed');assert.match(result.error,/unavailable/);assert.equal((await fs.stat(output)).mode&0o777,0o600);
  assert.equal(JSON.parse(await fs.readFile(output,'utf8')).proposalDigest,b.digest);
});
test('real client launch drops inherited credentials and contexts and removes its empty configuration directory',async t=>{
  const dir=await directory(t),executable=path.join(dir,'fixture-client'),record=path.join(dir,'observed.json'),b=bundle();
  const fixture=`#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),env:process.env,configFiles:fs.readdirSync(process.argv[5])})); console.log(JSON.stringify({OSType:'fixture-refusal'}));\n`;
  await fs.writeFile(executable,fixture,{mode:0o700});
  const report=await runEngineVerification(b,{...config,executable,reviewedDigest:b.digest});assert.equal(report.outcome,'not-started');
  const observed=JSON.parse(await fs.readFile(record,'utf8'));assert.deepEqual(Object.fromEntries(Object.entries(observed.env).filter(([key])=>process.platform!=='darwin'||key!=='__CF_USER_TEXT_ENCODING')),{PATH:'/usr/local/bin:/usr/bin:/bin'});assert.deepEqual(observed.args.slice(0,3),['--host','unix:///fixture/docker.sock','--config']);assert.deepEqual(observed.configFiles,[]);
  await assert.rejects(fs.stat(observed.args[3]),/ENOENT/);
});
test('fixed container plan has no pulls, bind mounts, external networking or privilege expansion',()=>{
  const args=verifierCreateArgs(image,'fixture','job','/fixture/seccomp.json');
  for(const [flag,value] of [['--pull','never'],['--network','none'],['--log-driver','none'],['--cap-drop','ALL'],['--user','10001:10001'],['--memory-swap',String(VERIFIER_POLICY.memory)]])assert.equal(args[args.indexOf(flag)+1],value);
  for(const flag of ['--privileged','--volume','-v','--mount','--device','--publish','--pid','--userns'])assert.equal(args.includes(flag),false);
  assert.equal(inspectVerifierContainer(container('job'),{image,jobId:'job'}),id);
});
test('complete fixed checks return a digest-bound receipt only after exact owned cleanup',async()=>{
  const f=await run();assert.equal(f.report.passed,true);assert.equal(f.report.fullSuite,true);assert.equal(f.report.cleanup,'removed');assert.equal(f.report.outcome,'completed');
  assert.deepEqual(f.calls.at(-1).args,['rm','--force',id]);assert.equal(f.calls.filter(c=>c.args[0]==='start').length,1);assert.match(f.report.notice,/not a security/);
});
test('weak daemons, unknown images, image volumes and inherited execution configuration never create jobs',async()=>{
  const images=[{Id:'sha256:'+'c'.repeat(64),Os:'linux',Config:{}},{Id:image,Os:'linux',Config:{Labels:{'dev.tupies.engine-verifier':'1'},Volumes:{'/data':{}}}},{Id:image,Os:'linux',Config:{Labels:{'dev.tupies.engine-verifier':'1'},Env:['NODE_OPTIONS=--import=/bad.mjs']}}];
  for(const change of [{info:{OSType:'linux',SecurityOptions:['name=seccomp']}},{info:{OSType:'linux',SecurityOptions:['name=rootless']}},{info:{OSType:'windows',SecurityOptions:['name=seccomp','name=rootless']}},...images.map(image=>({image}))]){const f=await run(change);assert.equal(f.report.passed,false);assert.equal(f.report.outcome,'not-started');assert.equal(f.calls.some(c=>c.args[0]==='create'),false);}
  assert.equal((await run({info:{OSType:'linux',OperatingSystem:'Docker Desktop',SecurityOptions:['name=seccomp']}})).report.passed,true);
});
test('unexpected mounts, networking, capabilities, user or resource configuration prevent start',async()=>{
  const changes=[c=>c.HostConfig.NetworkMode='host',c=>c.HostConfig.LogConfig.Type='json-file',c=>c.Mounts=[{Source:'/private'}],c=>c.HostConfig.Binds=['/private:/private'],c=>c.HostConfig.Privileged=true,c=>c.HostConfig.CapAdd=['SYS_ADMIN'],c=>c.HostConfig.Memory=0,c=>c.HostConfig.PidsLimit=-1,c=>c.HostConfig.NanoCpus=0,c=>c.HostConfig.SecurityOpt=[],c=>c.HostConfig.IpcMode='host',c=>c.HostConfig.ShmSize=0,c=>c.HostConfig.SecurityOpt=['no-new-privileges=true','seccomp=unconfined'],c=>c.HostConfig.SecurityOpt=['no-new-privileges=true','seccomp='+JSON.stringify({...seccomp,defaultAction:'SCMP_ACT_ALLOW'})],c=>c.HostConfig.ReadonlyRootfs=false,c=>c.Config.User='0',c=>c.HostConfig.UsernsMode='host',c=>c.HostConfig.Tmpfs['/work']='rw',c=>c.Config.Cmd=['evil'],c=>c.HostConfig.PortBindings={'80/tcp':[{}]}];
  for(const change of changes){const f=await run({container:change});assert.equal(f.report.passed,false);assert.equal(f.state.started,undefined);assert.equal(f.report.cleanup,'removed');}
});
test('lost create reply cleans only the matching job and never retries execution',async()=>{
  const f=await run({createError:true});assert.equal(f.report.passed,false);assert.equal(f.report.outcome,'unknown');assert.equal(f.report.cleanup,'removed');assert.equal(f.calls.filter(c=>c.args[0]==='create').length,1);assert.equal(f.state.started,undefined);
});
test('ownership mismatch and unconfirmed cleanup cannot produce success or remove unrelated containers',async()=>{
  const f=await run({container:c=>c.Config.Labels[jobLabel]='other'});assert.equal(f.report.cleanup,'unconfirmed');assert.equal(f.calls.some(c=>c.args[0]==='rm'),false);
  const failed=await run({cleanupError:true});assert.equal(failed.report.passed,false);assert.equal(failed.report.fullSuite,false);assert.equal(failed.report.outcome,'unknown');
});
test('Stop during execution and cleanup keeps the receipt interrupted and cleanup independent of cancelled signal',async()=>{
  for(const phase of ['start','cleanup']){
    const controller=new AbortController();const f=await run({[phase]:async()=>{controller.abort(new Error('fixture stop'));if(phase==='start')throw controller.signal.reason;}},{signal:controller.signal});
    assert.equal(f.report.passed,false);assert.equal(f.report.outcome,'interrupted');assert.equal(f.report.cleanup,'removed');assert.equal(f.calls.filter(c=>c.args[0]==='start').length,1);
  }
});
test('unknown completion, memory kills, corrupt output and exit disagreement remain failures',async()=>{
  for(const start of [async s=>{s.container.State.OOMKilled=true;return {code:0,stdout:JSON.stringify(evidence(bundle().digest))};},async s=>{s.container.State.Running=true;return {code:0,stdout:'{}'};},async()=>({code:0,stdout:'not json'}),async s=>{s.container.State.ExitCode=1;return {code:1,stdout:JSON.stringify(evidence(bundle().digest))};}]){const f=await run({start});assert.equal(f.report.passed,false);assert.equal(f.report.cleanup,'removed');assert.equal(f.report.outcome,'unknown');}
});
test('result validation rejects forged identity, incomplete sequences, skipped tests and inconsistent claims',()=>{
  const digest=bundle().digest;
  for(const edit of [v=>v.proposalDigest='0'.repeat(64),v=>v.checks.pop(),v=>v.checks[0].name='build',v=>v.checks[1].skipped=1,v=>v.checks[1].tests=0,v=>v.checks[1].cancelled=1,v=>v.checks[1].failed=1,v=>v.checks[1].todo=1,v=>v.checks[0].log='x'.repeat(4097),v=>v.sourceUnchanged=false]){const value=evidence(digest);edit(value);assert.throws(()=>validateVerifierResult(value,digest));}
  const changed=evidence(digest);Object.assign(changed,{sourceUnchanged:false,passed:false,fullSuite:false,build:false});assert.equal(validateVerifierResult(changed,digest).passed,false);
});
test('failed checks retain bounded diagnostic evidence without claiming complete suite or build',async()=>{
  const f=await run({result:r=>{r.checks=r.checks.slice(0,2);r.checks[1].failed=1;r.checks[1].passed=false;r.checks[1].exitCode=1;r.passed=r.fullSuite=r.build=false;r.error='fixture failure';}});
  assert.equal(f.report.outcome,'failed');assert.equal(f.report.checks.length,2);assert.equal(f.report.error,'fixture failure');assert.equal(f.report.cleanup,'removed');
});
test('guest kernel preflight refuses missing seccomp, privileges, limits and external interfaces',()=>{
  const valid={platform:'linux',uid:10001,status:'NoNewPrivs:\t1\nSeccomp:\t2\n',memory:'4294967296',pids:'512',cpu:'200000 100000',interfaces:{lo:[]}};
  assert.doesNotThrow(()=>assertVerifierKernel(valid));
  for(const patch of [{platform:'darwin'},{uid:0},{status:'NoNewPrivs:\t0\nSeccomp:\t2\n'},{memory:'max'},{pids:'max'},{cpu:'max 100000'},{cpu:'300000 100000'},{interfaces:{lo:[],eth0:[]}}])assert.throws(()=>assertVerifierKernel({...valid,...patch}));
});
test('test summary parser requires unambiguous complete TAP aggregate counts',()=>{
  const text='# tests 20\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n';assert.deepEqual(parseTestSummary(text),{tests:20,failed:0,skipped:0,cancelled:0,todo:0});
  for(const bad of ['',text+'# tests 20\n',text.replace('# skipped 0\n','')])assert.throws(()=>parseTestSummary(bad),/summary/);
});

test('full verifier discovers nested candidate tests and refuses linked test trees',async t=>{
  const dir=await directory(t);await fs.mkdir(path.join(dir,'test/nested'),{recursive:true});
  await fs.writeFile(path.join(dir,'test/top.test.mjs'),'');await fs.writeFile(path.join(dir,'test/nested/candidate.test.mjs'),'');await fs.writeFile(path.join(dir,'test/helper.mjs'),'');
  assert.deepEqual(await collectVerifierTests(dir),['test/nested/candidate.test.mjs','test/top.test.mjs']);
  await fs.symlink(path.join(dir,'test/nested'),path.join(dir,'test/link'));await assert.rejects(collectVerifierTests(dir),/symlinks/);
});

test('failed verifier output retains the first failure cause and final summary within the log bound',()=>{
  const text='ok 1 - fixture\n'.repeat(1000)+'not ok 2 - browser\nerror: sandbox unavailable\n'+'ok 3 - fixture\n'.repeat(1000)+'# fail 1\n';
  const log=verifierDiagnosticLog(text,false);assert.match(log,/sandbox unavailable/);assert.match(log,/# fail 1/);assert.ok(log.length<=4096);assert.equal(verifierDiagnosticLog(text,true),text.slice(-4096));
});

 test('fixed Chromium policy retains default denial and clone3 fallback without granting outer capabilities',()=>{
  assert.equal(seccomp.defaultAction,'SCMP_ACT_ERRNO');
  const extra=seccomp.syscalls.at(-1);assert.deepEqual(extra.names,['clone','setns','unshare','chroot']);assert.equal(extra.action,'SCMP_ACT_ALLOW');
  assert.ok(seccomp.syscalls.some(rule=>rule.names.includes('clone3')&&rule.action==='SCMP_ACT_ERRNO'&&rule.errnoRet===38));
  for(const syscall of ['mount','bpf','ptrace'])assert.ok(!seccomp.syscalls.some(rule=>rule.names.includes(syscall)&&rule.action==='SCMP_ACT_ALLOW'&&!rule.includes));
});
