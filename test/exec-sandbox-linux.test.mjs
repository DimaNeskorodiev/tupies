// The Linux command sandbox (bubblewrap). The availability reasons run everywhere with a fake `bwrap`;
// the real cases run only on Linux when the self-test says bubblewrap works, and are skipped with the
// reason otherwise. With TUPIES_REQUIRE_LINUX_SANDBOX=1 (the Linux sandbox workflow) a sandbox that
// cannot run fails instead of skipping, so the workflow can never pass on skipped tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os, { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { AgentTools, getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { BackgroundProcesses } from '../lib/background-processes.mjs';
import { getProcessHome, processEnvironment } from '../lib/process-environment.mjs';
import { validateRoutine } from '../lib/routines.mjs';
import { createSandboxBackend, sandboxBackend, bubblewrapFailureReason, holdsCapabilities, findRepositories, BWRAP_REASONS, BWRAP_PROBE_ARGS, SETPRIV_ARGS, SECRET_HOME_FOLDERS } from '../lib/exec/sandbox.mjs';

const linux=process.platform==='linux',required=process.env.TUPIES_REQUIRE_LINUX_SANDBOX==='1';
const status=linux?await sandboxBackend.available():{ok:false,reason:'not Linux'};
const skipLinux=!linux?'bubblewrap runs only on Linux.':status.ok?false:`bubblewrap cannot run here: ${status.reason}`;
// Platform-bound cases are defined only where they can run. The release verifier counts a skipped test as a failed
// suite, so a case that cannot apply on this platform is not registered instead of being skipped.
// The real bubblewrap cases run where the self-test passes, and always in .github/workflows/linux-sandbox.yml, which
// sets TUPIES_REQUIRE_LINUX_SANDBOX=1 so a sandbox that is not ready fails there instead of going unnoticed.
const linuxTest=linux && (status.ok || required)?test:()=>{},readinessTest=linux && required?test:()=>{};
if(linux)console.log(`# Linux sandbox self-test: ${status.ok?'ready':status.reason}`);
const until=async(predicate,label)=>{for(let i=0;i<2000;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Timed out waiting for ${label}.`);};
const notFound=/No such file or directory|Directory nonexistent|Permission denied|Read-only file system/;

// ---- Availability reasons (any platform) ----
async function fakeTools(t,{bwrapStderr=null,setpriv=false}={}) {
  const folder=await fs.mkdtemp(path.join(tmpdir(),'tupies-fake-bwrap-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const bwrap=path.join(folder,'bwrap'),log=path.join(folder,'calls.log');
  await fs.writeFile(bwrap,bwrapStderr===null?`#!/bin/sh\necho "bwrap $*" >> '${log}'\nexit 0\n`:`#!/bin/sh\necho "bwrap $*" >> '${log}'\necho ${JSON.stringify(bwrapStderr)} >&2\nexit 1\n`,{mode:0o755});
  const fakeSetpriv=path.join(folder,'setpriv');
  if(setpriv)await fs.writeFile(fakeSetpriv,`#!/bin/sh\necho "setpriv $1 $2 $3" >> '${log}'\nshift 3\nexec "$@"\n`,{mode:0o755});
  return {bwrap,setpriv:fakeSetpriv,folder,calls:async()=>(await fs.readFile(log,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean)};
}
const NO_CAPS='CapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t000001ffffffffff\nCapAmb:\t0000000000000000\n';
const NET_BIND='CapInh:\t0000000000000400\nCapPrm:\t0000000000000400\nCapEff:\t0000000000000400\nCapBnd:\t0000000000000400\nCapAmb:\t0000000000000400\n';
const linuxBackend=(tools,options={})=>createSandboxBackend({platform:'linux',bwrapCandidates:[tools.bwrap],setprivCandidates:[tools.setpriv],readStatus:async()=>NO_CAPS,uid:1000,readSetting:async()=>null,...options});

test('Linux availability: bubblewrap not installed names the package to install',async t=>{
  const tools=await fakeTools(t);
  const backend=linuxBackend(tools,{bwrapCandidates:[path.join(tools.folder,'missing','bwrap')]});
  assert.deepEqual(await backend.available(),{ok:false,reason:'The sandbox needs bubblewrap. On Debian or Ubuntu: sudo apt install bubblewrap'});
});

test('Linux availability: a service that may not create namespaces names RestrictNamespaces with mnt',async t=>{
  for(const stderr of ['bwrap: No permissions to creating new namespace, likely because the kernel does not allow non-privileged user namespaces. On e.g. debian this can be enabled with \'sysctl kernel.unprivileged_userns_clone=1\'.','bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.','bwrap: Creating new namespace failed: Operation not permitted']) {
    const tools=await fakeTools(t,{bwrapStderr:stderr});
    const result=await linuxBackend(tools,{readSetting:async name=>name==='kernel.unprivileged_userns_clone'?'1':null}).available();
    assert.equal(result.ok,false);
    assert.ok(result.reason.startsWith(BWRAP_REASONS.service),result.reason);
    assert.match(result.reason,/RestrictNamespaces=user pid net mnt/);assert.match(result.reason,/sudo systemctl daemon-reload/);
    // The self-test used the same namespaces and mounts as a real command.
    assert.deepEqual(await tools.calls(),[`bwrap ${BWRAP_PROBE_ARGS.join(' ')}`]);
  }
});

test('Linux availability: kernel and AppArmor settings, /proc, capabilities and anything else get their own reason',async t=>{
  const denied='bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.';
  let tools=await fakeTools(t,{bwrapStderr:denied});
  assert.equal((await linuxBackend(tools,{readSetting:async name=>name==='kernel.unprivileged_userns_clone'?'0':null}).available()).reason,BWRAP_REASONS.userns);
  assert.match(BWRAP_REASONS.userns,/kernel\.unprivileged_userns_clone=1 \| sudo tee \/etc\/sysctl\.d\/90-tupies-sandbox\.conf && sudo sysctl --system$/);
  assert.equal((await linuxBackend(tools,{readSetting:async name=>name==='user.max_user_namespaces'?'0':'1'}).available()).reason,BWRAP_REASONS.maxUserns);
  tools=await fakeTools(t,{bwrapStderr:'bwrap: setting up uid map: Permission denied'});
  assert.ok((await linuxBackend(tools,{readSetting:async()=>'1'}).available()).reason.startsWith(BWRAP_REASONS.apparmor));
  tools=await fakeTools(t,{bwrapStderr:'bwrap: Can\'t mount proc on /newroot/proc: Operation not permitted'});
  assert.ok((await linuxBackend(tools).available()).reason.startsWith(BWRAP_REASONS.proc));
  tools=await fakeTools(t,{bwrapStderr:'bwrap: Unknown option --perms'});
  assert.equal((await linuxBackend(tools).available()).reason,'bubblewrap is not working here: bwrap: Unknown option --perms');
  assert.equal(bubblewrapFailureReason({stderr:'bwrap: Unexpected capabilities but not setuid, old file caps config?'}),BWRAP_REASONS.capabilities);
  assert.equal(bubblewrapFailureReason({reason:'Its self-test did not finish.'}),'bubblewrap is not working here: Its self-test did not finish.');
});

test('Linux availability: an Engine with ambient capabilities starts bubblewrap through setpriv, or says what is missing',async t=>{
  assert.equal(holdsCapabilities(NET_BIND,1000),true);assert.equal(holdsCapabilities(NO_CAPS,1000),false);assert.equal(holdsCapabilities(NET_BIND,0),false,'root runs bubblewrap directly');
  let tools=await fakeTools(t);
  assert.deepEqual(await linuxBackend(tools,{readStatus:async()=>NET_BIND}).available(),{ok:false,reason:BWRAP_REASONS.capabilities});
  tools=await fakeTools(t,{setpriv:true});
  assert.deepEqual(await linuxBackend(tools,{readStatus:async()=>NET_BIND}).available(),{ok:true,reason:''});
  assert.deepEqual(await tools.calls(),[`setpriv ${SETPRIV_ARGS.join(' ')}`,`bwrap ${BWRAP_PROBE_ARGS.join(' ')}`]);
  assert.deepEqual(SETPRIV_ARGS,['--inh-caps=-all','--ambient-caps=-all','--']);
});

test('Linux availability: a failure is cached and re-checked after a minute, success is kept',async t=>{
  const tools=await fakeTools(t,{bwrapStderr:'bwrap: No permissions to create a new namespace'});
  let now=0;const backend=linuxBackend(tools,{clock:()=>now});
  await backend.available();await backend.available();now=59_000;await backend.available();
  assert.equal((await tools.calls()).length,1,'one self-test within the minute');
  now=61_000;await backend.available();assert.equal((await tools.calls()).length,2,'re-checked after the minute');
  assert.equal(backend.cached().ok,false);
});

test('the repository scan is bounded, breadth first and never follows symbolic links',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'tupies-repo-scan-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const folder of ['.git/hooks','a/.git','a/b/c/d/.git','a/b/c/d/e/.git','node_modules/x/.git','w'])await fs.mkdir(path.join(root,folder),{recursive:true});
  await fs.writeFile(path.join(root,'w','.git'),'gitdir: ../.git/worktrees/w\n');
  const elsewhere=await fs.mkdtemp(path.join(tmpdir(),'tupies-repo-elsewhere-'));t.after(()=>fs.rm(elsewhere,{recursive:true,force:true}));
  await fs.mkdir(path.join(elsewhere,'.git'));await fs.symlink(elsewhere,path.join(root,'linked'));
  await fs.mkdir(path.join(root,'s'));await fs.symlink(path.join(root,'a','.git'),path.join(root,'s','.git'));
  const found=(await findRepositories(root)).map(item=>[path.relative(root,item.folder) || '.',item.type]);
  assert.deepEqual(found.sort(),[['.','folder'],['a','folder'],['a/b/c/d','folder'],['s','link'],['w','file']].sort(),'depth 4 is the limit; node_modules and symlinked folders are not entered');
  assert.deepEqual(await findRepositories(root,{maxFolders:1}),[{folder:root,type:'folder'}],'at most maxFolders folders are read');
});

// ---- Real bubblewrap (Linux only) ----
readinessTest('the Linux sandbox is ready on this runner',{skip:linux && required?false:'only checked where TUPIES_REQUIRE_LINUX_SANDBOX=1 on Linux.'},()=>{
  assert.equal(status.ok,true,`The sandbox self-test failed: ${status.reason}`);
});

async function fixture(t,{execution={backend:'sandbox'}}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-linux-')),store=await new Store(directory).init();
  const outside=await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-linux-outside-'));
  // Anything still running is stopped before the folders go: a failing after hook skips the ones registered after it.
  const closers=[],closeFirst=close=>closers.push(close);
  t.after(async()=>{try{for(const close of closers.reverse())await close();}finally{await fs.rm(directory,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}});
  await store.mutate(state=>{for(const bot of state.bots)state.runs[bot.id]={id:'run_a',botId:bot.id,status:'running'};});
  const bot={...store.state.bots[0],tools:['workspace','terminal'],...(execution?{execution}:{})},tools=new AgentTools(store,{});
  const run=(command,options={})=>tools.execute(bot,'terminal',{command},{approved:true,runId:'run_a',signal:options.signal});
  return {store,bot,tools,run,outside,closeFirst,directory:await fs.realpath(directory),root:await fs.realpath(await getWorkspaceRoot(store,bot.id)),home:await fs.realpath(await getProcessHome(store,bot.id))};
}
function spawnLaunch(launch) {
  return new Promise(resolve=>{
    const child=spawn(launch.executable,launch.args,{cwd:launch.cwd,env:launch.env,detached:true,stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    child.once('error',error=>resolve({exitCode:null,output:error.message}));child.once('close',exitCode=>resolve({exitCode,output}));
  });
}
const hostPids=token=>readdirSync('/proc').filter(name=>/^\d+$/.test(name)).filter(pid=>{try{return readFileSync(`/proc/${pid}/cmdline`,'utf8').includes(token);}catch{return false;}});

linuxTest('Linux: commands change the workspace and process home but nothing else',{skip:skipLinux},async t=>{
  const h=await fixture(t);
  let result=await h.run('mkdir -p data && echo hello > data/out.txt && cat data/out.txt');
  assert.deepEqual([result.exitCode,result.output,result.backend],[0,'hello\n','sandbox'],result.output);
  assert.equal(await fs.readFile(path.join(h.root,'data','out.txt'),'utf8'),'hello\n');
  result=await h.run('echo cached > "$HOME/note.txt" && echo tmp > "$TMPDIR/t.txt" && cat "$HOME/note.txt"');
  assert.deepEqual([result.exitCode,result.output],[0,'cached\n'],result.output);
  assert.equal(await fs.readFile(path.join(h.home,'note.txt'),'utf8'),'cached\n');
  result=await h.run('printf "%s\\n" "$HOME" "$TMPDIR" "$npm_config_cache" "$PIP_CACHE_DIR" "$XDG_CACHE_HOME" && echo "$TUPIES_SANDBOX"');
  assert.ok(result.output.trim().split('\n').slice(0,5).every(line=>line.startsWith(h.home)),result.output);
  // Writes elsewhere fail: next to the Engine's own Node (a global install location), an outside folder, the data folder.
  for(const target of [path.join(path.dirname(process.execPath),`tupies-sandbox-probe-${process.pid}`),path.join(h.outside,'escape.txt'),path.join(h.directory,'planted.txt'),path.join(os.homedir(),`tupies-sandbox-probe-${process.pid}`)]) {
    result=await h.run(`echo x > '${target}'`);
    assert.notEqual(result.exitCode,0,target);assert.match(result.output,notFound,target);assert.equal(existsSync(target),false,target);
  }
  // /tmp is private: a write there succeeds inside and never reaches this computer's /tmp.
  result=await h.run(`echo x > /tmp/tupies-sandbox-probe-${process.pid} && ls /tmp`);
  assert.equal(result.exitCode,0,result.output);assert.equal(existsSync(`/tmp/tupies-sandbox-probe-${process.pid}`),false);
  assert.equal(result.output.includes(path.basename(h.outside)),false,`the host /tmp is not visible: ${result.output}`);
});

linuxTest('Linux: the Engine data folder, the vault key, other bots and the user’s keys cannot be read or listed',{skip:skipLinux},async t=>{
  const h=await fixture(t);
  await fs.access(path.join(h.directory,'vault.key'));
  const other=h.store.state.bots[1];await fs.writeFile(path.join(await getWorkspaceRoot(h.store,other.id),'private.txt'),'other bot secret');
  for(const command of [`cat '${h.directory}/vault.key'`,`cat '${h.directory}/state.json'`,`ls '${h.directory}'`,`ls '${h.directory}/workspaces/${other.id}'`,`cat '${h.directory}/workspaces/${other.id}/private.txt'`,`ls '${h.directory}/process-homes/${other.id}'`]) {
    const result=await h.run(command);
    assert.notEqual(result.exitCode,0,command);assert.match(result.output,notFound,command);
    for(const leak of ['BEGIN','other bot secret'])assert.equal(result.output.includes(leak),false,`${command} leaked ${leak}`);
  }
  const listing=await h.run(`ls -A '${h.directory}/workspaces' '${h.directory}/process-homes'`);
  assert.equal(listing.exitCode,0,listing.output);assert.equal(listing.output.includes(other.id),false,'only this bot’s own folders exist inside the hidden data folder');
  for(const folder of SECRET_HOME_FOLDERS) {
    const real=path.join(os.homedir(),folder);if(!existsSync(real))continue;
    const listed=await h.run(`ls -A '${real}'`);assert.notEqual(listed.exitCode,0,`${folder}: ${listed.output}`);
  }
});

linuxTest('Linux: in the VPS layout the service home holding the data, a fixture ~/.ssh and the Engine’s .env stay hidden',{skip:skipLinux},async t=>{
  // home /var/lib/tupies → base, data /var/lib/tupies/data → base/data, release /opt/tupies/app → engine.
  const base=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-vps-'))),engine=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-release-')));
  t.after(async()=>{await fs.rm(base,{recursive:true,force:true});await fs.rm(engine,{recursive:true,force:true});});
  await fs.mkdir(path.join(base,'.ssh'));await fs.writeFile(path.join(base,'.ssh','id_ed25519'),'BEGIN FIXTURE KEY');await fs.mkdir(path.join(base,'backups'));await fs.writeFile(path.join(base,'backups','state.json'),'BEGIN BACKUP');
  await fs.writeFile(path.join(engine,'.env'),'STUDIO_SECRET=BEGIN ENV');await fs.mkdir(path.join(engine,'.runtime'));await fs.writeFile(path.join(engine,'.runtime','pid'),'BEGIN RUNTIME');
  const store=await new Store(path.join(base,'data')).init(),bot=store.state.bots[0];
  const paths={dataDir:path.join(base,'data'),workspaceRoot:await fs.realpath(await getWorkspaceRoot(store,bot.id)),home:await fs.realpath(await getProcessHome(store,bot.id))};
  const backend=createSandboxBackend({userHome:base,engineRoot:engine});
  assert.equal((await backend.available()).ok,true);
  const run=async command=>spawnLaunch(await backend.prepare({...paths,env:await processEnvironment(paths.home),cwd:paths.workspaceRoot,executable:'bash',args:['-c',command]}));
  let result=await run('echo ok > inside.txt && cat inside.txt');assert.deepEqual([result.exitCode,result.output],[0,'ok\n']);
  for(const command of [`ls -A '${base}'`,`cat '${base}/.ssh/id_ed25519'`,`ls '${base}/.ssh'`,`cat '${base}/backups/state.json'`,`cat '${engine}/.env'`,`ls -A '${engine}/.runtime'`,`cat '${engine}/.runtime/pid'`]) {
    result=await run(command);
    assert.notEqual(result.exitCode,0,`${command}: ${result.output}`);assert.equal(result.output.includes('BEGIN'),false,command);
  }
  // Only the mount points leading to this bot's own folders exist inside the hidden home.
  result=await run(`ls -A '${base}/data'`);assert.deepEqual(result.output.trim().split(/\s+/).sort(),['process-homes','workspaces'],result.output);
});

linuxTest('Linux: Git hooks and config, shell profiles, .gitconfig and .npmrc stay read-only and cannot be created or swapped',{skip:skipLinux},async t=>{
  const h=await fixture(t);
  await fs.mkdir(path.join(h.root,'.git','hooks'),{recursive:true});await fs.writeFile(path.join(h.root,'.git','config'),'[core]\n');await fs.writeFile(path.join(h.root,'.git','HEAD'),'ref: refs/heads/main\n');
  await fs.mkdir(path.join(h.root,'nested','repo','.git','hooks'),{recursive:true});await fs.writeFile(path.join(h.root,'nested','repo','.git','config'),'[core]\n');
  await fs.mkdir(path.join(h.root,'nohooks','.git'),{recursive:true});await fs.writeFile(path.join(h.root,'nohooks','.git','config'),'[core]\n');
  await fs.writeFile(path.join(h.root,'.bashrc'),'# owner profile\n');
  for(const command of ['echo evil > .git/hooks/pre-commit','echo evil > .git/config','echo evil > nested/repo/.git/hooks/pre-push','echo evil >> nested/repo/.git/config','echo evil > nohooks/.git/hooks/post-merge','echo evil > .npmrc','echo evil >> .bashrc',
    'echo evil > "$HOME/.bash_profile"','echo evil > "$HOME/.bashrc"','echo evil > "$HOME/.profile"','echo evil > "$HOME/.zshenv"','echo evil > "$HOME/.npmrc"','echo evil > "$HOME/.gitconfig"','echo evil > "$HOME/disabled-git-hooks/pre-commit"',
    'mv .git .git-old','mv nested nested-old','mv nested/repo nested/repo-old','rm -rf nested/repo/.git','rm -f .npmrc','rm -f "$HOME/.bashrc"','mv "$HOME/disabled-git-hooks" "$HOME/old-hooks"']) {
    const result=await h.run(`${command} 2>&1; echo "exit=$?"`);
    assert.doesNotMatch(result.output,/exit=0\n$/,`${command} succeeded: ${result.output}`);
  }
  assert.equal(await fs.readFile(path.join(h.root,'.git','config'),'utf8'),'[core]\n');assert.equal(await fs.readFile(path.join(h.root,'nested','repo','.git','config'),'utf8'),'[core]\n');
  assert.equal(await fs.readFile(path.join(h.root,'.bashrc'),'utf8'),'# owner profile\n');
  for(const absent of ['.git/hooks/pre-commit','nested/repo/.git/hooks/pre-push','nohooks/.git/hooks/post-merge','.git-old','nested-old'])assert.equal(existsSync(path.join(h.root,absent)),false,absent);
  for(const empty of [path.join(h.root,'.npmrc'),path.join(h.home,'.bash_profile'),path.join(h.home,'.gitconfig')])assert.equal(await fs.readFile(empty,'utf8'),'','a missing protected file stays an empty placeholder');
  assert.deepEqual(await fs.readdir(path.join(h.home,'disabled-git-hooks')),[]);
  // Ordinary files in .git and ordinary dotfiles stay writable; Git itself still works for reads and commits of objects.
  assert.equal((await h.run('echo "ref: refs/heads/main" > .git/HEAD && echo x > .gitignore && mkdir -p .git/objects && touch .git/objects/x')).exitCode,0);
  // Known Linux limit: a repository created after the sandbox started is not protected (macOS protects it).
  assert.equal((await h.run('mkdir -p fresh/.git/hooks && echo ok > fresh/.git/hooks/pre-commit')).exitCode,0);
  // A symlink inside the workspace cannot reach outside.
  await fs.mkdir(path.join(h.outside,'target'));await fs.symlink(path.join(h.outside,'target'),path.join(h.root,'link'));
  const escaped=await h.run('echo escaped > link/file.txt');
  assert.notEqual(escaped.exitCode,0);assert.equal(existsSync(path.join(h.outside,'target','file.txt')),false);
  // A protected name that is a symbolic link cannot be protected, so the sandbox refuses to start.
  await fs.rm(path.join(h.root,'.npmrc'));await fs.symlink(path.join(h.root,'data.txt'),path.join(h.root,'.npmrc'));
  await assert.rejects(h.run('true'),error=>error.code==='sandbox_unavailable' && /symbolic link/.test(error.message) && /Nothing ran on this computer/.test(error.message));
});

linuxTest('Linux: Stop ends the whole sandboxed tree, including a grandchild that ignores TERM and one in its own session',{skip:skipLinux},async t=>{
  const h=await fixture(t),controller=new AbortController(),token=`tupies-stop-${process.pid}-${Date.now()}`;
  const command=`(trap '' TERM; exec -a ${token}-grandchild sleep 60) & setsid bash -c "trap '' TERM; exec -a ${token}-detached sleep 60" & echo started > started.txt; wait`;
  const started=Date.now(),pending=h.run(command,{signal:controller.signal});
  await until(()=>hostPids(token).length>=2,'both sandboxed sleepers');
  controller.abort(new Error('Fixture Stop'));
  await assert.rejects(pending,/Fixture Stop/);
  await until(()=>hostPids(token).length===0,'every sandboxed process to exit');
  assert.ok(Date.now()-started<9000,'Stop did not wait for the sleepers');
});

linuxTest('Linux: execute_code, shell_run and background commands run in the sandbox too',{skip:skipLinux},async t=>{
  const h=await fixture(t);
  const code=await h.tools.execute(h.bot,'execute_code',{language:'node',code:`import fs from 'node:fs';fs.writeFileSync('code.txt','ok');try{fs.readFileSync(${JSON.stringify(path.join(h.directory,'vault.key'))});console.log('read');}catch(error){console.log(error.code);}`},{approved:true,runId:'run_a'});
  assert.equal(code.exitCode,0,code.output);assert.equal(code.backend,'sandbox');assert.match(code.output.trim(),/^(ENOENT|EACCES)$/);
  assert.equal(await fs.readFile(path.join(h.root,'code.txt'),'utf8'),'ok');
  const shell=await h.tools.execute(h.bot,'shell_run',{executable:'sh',args:['-c',`echo ok > shell.txt; echo x > '${h.outside}/shell.txt'`]},{approved:true,runId:'run_a'});
  assert.equal(shell.backend,'sandbox');assert.match(shell.stderr,notFound);
  assert.equal(existsSync(path.join(h.root,'shell.txt')),true);assert.equal(existsSync(path.join(h.outside,'shell.txt')),false);
  const manager=new BackgroundProcesses(h.store);h.closeFirst(()=>manager.close());
  const started=await manager.start(h.bot,'run_a',{executable:'sh',args:['-c',`echo bg > bg.txt; echo x > '${h.outside}/bg.txt'; exit 3`]});
  assert.equal(started.backend,'sandbox');
  const done=await manager.wait(h.bot.id,'run_a',started.processId);
  assert.deepEqual([done.status,done.exitCode,done.backend],['failed',3,'sandbox']);
  assert.equal(existsSync(path.join(h.root,'bg.txt')),true);assert.equal(existsSync(path.join(h.outside,'bg.txt')),false);
});

linuxTest('Linux: a real engine routine changes its workspace in the sandbox with no approval and cannot read the Engine state',{skip:skipLinux},async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-linux-engine-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections=[{id:'fixture',type:'custom',defaultModel:'fixture-model'}];Object.assign(state.bots[0],{connectionId:'fixture',approvalPolicy:'balanced',tools:['workspace','terminal'],execution:{backend:'sandbox'}});});
  const calls=[{name:'terminal',arguments:{command:'echo ok > report.txt && cat report.txt'}},{name:'terminal',arguments:{command:'cat ../../state.json'}}];let step=0;
  const engine=new NativeEngine(store,{runTimeout:30000,providers:{complete:async()=>{const call=calls[step++];return call?{toolCalls:[{id:`call_${step}`,...call}]}:{text:'Finished.',toolCalls:[]};},reviewAction:async()=>{throw new Error('The model reviewer must not run for terminal actions.');}}});
  await engine.recover();t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot=store.state.bots[0],run=()=>store.state.runs[bot.id],events=type=>(run()?.events || []).filter(event=>event.type===type);
  await store.mutate(state=>{state.routines.push({...validateRoutine({name:'Report',botId:bot.id,prompt:'Run the report.',intervalMinutes:60,enabled:false}),id:'routine_report'});});
  const started=await engine.runRoutine('routine_report');await engine.tasks.get(started.id);
  assert.equal(events('approval.request').length,0,'ordinary commands run unattended in the sandbox');
  const receipts=run().workRecords.filter(record=>record.tool==='terminal');
  assert.deepEqual(receipts.map(record=>[record.status,record.backend]),[['succeeded','sandbox'],['failed','sandbox']]);
  assert.equal(await fs.readFile(path.join(await getWorkspaceRoot(store,bot.id),'report.txt'),'utf8'),'ok\n');
  assert.ok(events('tool.completed').some(event=>event.tool==='terminal' && notFound.test(event.preview || '')));
});
