import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createSshBackend, shellQuote, sshSettings, sshArgs, remoteFolder, remoteEnvironment, remoteCommand } from '../lib/exec/ssh.mjs';

const temp=async t=>{const dir=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-ssh-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;};
const SETTINGS={STUDIO_EXEC_SSH_HOST:'build.example.test',STUDIO_EXEC_SSH_USER:'tupies',STUDIO_EXEC_SSH_PORT:'2222',STUDIO_EXEC_SSH_KEY:'/keys/id_tupies',STUDIO_EXEC_SSH_DIR:'/srv/tupies'};
/** A fake `ssh`: logs its arguments; `mode` picks how the connection test ends. */
async function fakeSsh(dir,mode='ok') {
  const bin=path.join(dir,'bin');await fs.mkdir(bin,{recursive:true});
  const body={ok:'exit 0',hostkey:'echo "Host key verification failed." >&2; exit 255',denied:'echo "tupies@x: Permission denied (publickey)." >&2; exit 255',refused:'echo "ssh: connect to host x port 22: Connection refused" >&2; exit 255',hang:'exec sleep 30'}[mode];
  await fs.writeFile(path.join(bin,'ssh'),`#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/calls.log"\n${body}\n`,{mode:0o755});return bin;
}

const HOSTILE=['plain',"it's",'a\'b\'\'c','',' ','$(id)','`id`','${HOME}','a;b|c&d>e<f','-rf','--help','new\nline','tab\there','back\\slash','"dq"','*?[x]','~/x','é ü 日本語 🙂','\'; rm -rf / #','$\'x\'','=x','a\\\'b'];
test('shellQuote: a real POSIX shell reads back exactly the original text for hostile inputs',()=>{
  for(const text of HOSTILE) {
    const result=spawnSync('/bin/sh',['-c',`printf %s ${shellQuote(text)}`],{encoding:'utf8'});
    assert.equal(result.status,0,text);assert.equal(result.stdout,text,JSON.stringify(text));
  }
  // Several words stay separate arguments, never re-split or expanded.
  const args=HOSTILE.filter(text=>text!=='').map(shellQuote).join(' ');
  const count=spawnSync('/bin/sh',['-c',`set -- ${args}; printf %s "$#"`],{encoding:'utf8'}).stdout;
  assert.equal(Number(count),HOSTILE.filter(text=>text!=='').length);
  assert.equal(shellQuote("it's"),`'it'\\''s'`);
  assert.throws(()=>shellQuote('a\0b'),/NUL/);assert.throws(()=>shellQuote(5),TypeError);
});

test('settings: not configured, partly configured, invalid and valid',()=>{
  assert.equal(sshSettings({}),null);
  assert.throws(()=>sshSettings({STUDIO_EXEC_SSH_HOST:'h'}),/only partly set up/);
  for(const bad of [{STUDIO_EXEC_SSH_HOST:'-oProxyCommand=x'},{STUDIO_EXEC_SSH_HOST:'a b'},{STUDIO_EXEC_SSH_USER:'a b'},{STUDIO_EXEC_SSH_USER:'-x'},{STUDIO_EXEC_SSH_PORT:'0'},{STUDIO_EXEC_SSH_PORT:'99999'},{STUDIO_EXEC_SSH_KEY:'relative'},{STUDIO_EXEC_SSH_DIR:'../x'},{STUDIO_EXEC_SSH_DIR:'/'},{STUDIO_EXEC_SSH_DIR:'-x'},{STUDIO_EXEC_SSH_DIR:'a\nb'}])
    assert.throws(()=>sshSettings({STUDIO_EXEC_SSH_HOST:'h',STUDIO_EXEC_SSH_USER:'u',...bad}),/STUDIO_EXEC_SSH/,JSON.stringify(bad));
  assert.deepEqual(sshSettings(SETTINGS),{host:'build.example.test',user:'tupies',port:2222,key:'/keys/id_tupies',dir:'/srv/tupies'});
  assert.deepEqual(sshSettings({STUDIO_EXEC_SSH_HOST:'h',STUDIO_EXEC_SSH_USER:'u'}),{host:'h',user:'u',port:22,key:'',dir:'tupies'});
  assert.equal(sshSettings({...SETTINGS,STUDIO_EXEC_SSH_DIR:'/srv/tupies/'}).dir,'/srv/tupies');
});

test('ssh arguments: never prompts, never trusts a new host, shares one connection inside the data folder',()=>{
  const settings=sshSettings(SETTINGS),argv=sshArgs({settings,controlPath:'/data/exec-ssh/c-1234abcd',command:'true'});
  const options=argv.filter((_item,index)=>argv[index-1]==='-o');
  for(const required of ['BatchMode=yes','StrictHostKeyChecking=yes','PasswordAuthentication=no','ControlMaster=auto','ControlPath=/data/exec-ssh/c-1234abcd','ControlPersist=60','IdentitiesOnly=yes','ConnectTimeout=8','ForwardAgent=no'])assert.ok(options.includes(required),required);
  assert.equal(argv[0],'-T');
  assert.ok(!options.some(option=>/StrictHostKeyChecking=(no|accept-new|off)/.test(option)));
  assert.deepEqual(argv.slice(argv.indexOf('-p')),['-p','2222','-i','/keys/id_tupies','-l','tupies','--','build.example.test','true']);
  const agent=sshArgs({settings:sshSettings({...SETTINGS,STUDIO_EXEC_SSH_KEY:''}),controlPath:null,command:'true'});
  assert.ok(!agent.includes('-i') && !agent.some(item=>item.startsWith('ControlMaster')) && !agent.includes('IdentitiesOnly=yes'));
});

test('remote command: folders map under <dir>/<botId>, environment is allow-listed, every word is quoted',()=>{
  const settings=sshSettings(SETTINGS),root='/data/workspaces/bot';
  assert.deepEqual(remoteFolder({settings,botId:'bot',workspaceRoot:root,local:root}),{botDir:'/srv/tupies/bot',cwd:'/srv/tupies/bot'});
  assert.equal(remoteFolder({settings,botId:'bot',workspaceRoot:root,local:`${root}/a b/c`}).cwd,'/srv/tupies/bot/a b/c');
  for(const outside of ['/data/workspaces/other','/data/workspaces/bot/..','/data/workspaces/botx','/etc','/data/workspaces'])assert.throws(()=>remoteFolder({settings,botId:'bot',workspaceRoot:root,local:outside}),/own workspace/,outside);
  assert.throws(()=>remoteFolder({settings,botId:'../x',workspaceRoot:root,local:root}),/valid bot id/);
  const env=remoteEnvironment({settings,botId:'bot',workspaceRoot:root,env:{PATH:'/Users/me/bin',HOME:'/data/h',TMPDIR:'/data/h/.tmp',OPENAI_API_KEY:'sk-secret',GIT_CONFIG_GLOBAL:'/data/h/.gitconfig',LANG:'C.UTF-8',TUPIES_ROOT:root,TUPIES_CWD:`${root}/sub`,TUPIES_STATE_DIR:'/data/h/.tmp/terminal-abc',TUPIES_COMMAND:'echo $(x)\'y\'',TUPIES_V_A:'1'}});
  assert.deepEqual(env,{LANG:'C.UTF-8',TUPIES_ROOT:'/srv/tupies/bot',TUPIES_CWD:'/srv/tupies/bot/sub',TUPIES_STATE_DIR:'/srv/tupies/bot/.tmp/terminal-abc',TUPIES_COMMAND:'echo $(x)\'y\'',TUPIES_V_A:'1'});
  const folders={botDir:'/srv/tupies/bot',cwd:'/srv/tupies/bot/sub dir'};
  const command=remoteCommand({folders,env:{TUPIES_COMMAND:"it's $(id)"},executable:'bash',args:['-lc','echo "$HOME"; `x`','--','-n']});
  assert.equal(command,`mkdir -p -- '/srv/tupies/bot' '/srv/tupies/bot/sub dir' && cd -- '/srv/tupies/bot/sub dir' && exec env 'TUPIES_COMMAND=it'\\''s $(id)' 'bash' '-lc' 'echo "$HOME"; \`x\`' '--' '-n'`);
  for(const bad of ['-x','A=b','']) assert.throws(()=>remoteCommand({folders,env:{},executable:bad,args:[]}),/plain command/,bad);
  assert.throws(()=>remoteCommand({folders,env:{'A B':'x'},executable:'ls',args:[]}),/cannot pass safely/);
  // End to end in a local shell: the assembled text runs the command with literal arguments in the mapped folder.
  return fs.mkdtemp(path.join(tmpdir(),'tupies-ssh-shell-')).then(async dir=>{
    try{
      const local=await fs.realpath(dir),assembled=remoteCommand({folders:{botDir:`${local}/bot`,cwd:`${local}/bot/we ird`},env:{TUPIES_X:"a'b $(echo pwned)"},executable:'sh',args:['-c','printf "%s|%s|%s" "$TUPIES_X" "$1" "$(pwd -P)"','_','$(echo pwned)\nsecond']});
      const result=spawnSync('/bin/sh',['-c',assembled],{encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,`a'b $(echo pwned)|$(echo pwned)\nsecond|${local}/bot/we ird`);
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  });
});

test('available(): not configured, client missing, connection failing (several ways) and ready',async t=>{
  const dir=await temp(t),empty=path.join(dir,'empty');await fs.mkdir(empty);
  const make=(searchDirs,env=SETTINGS,extra={})=>createSshBackend({env,searchDirs,userHome:dir,probeTimeoutMs:3000,...extra});
  assert.deepEqual(await make([empty],{}).available(),{ok:false,reason:'SSH is not set up on this engine. Set STUDIO_EXEC_SSH_HOST and STUDIO_EXEC_SSH_USER (and optionally STUDIO_EXEC_SSH_KEY, _PORT and _DIR), then restart the engine.'});
  assert.match((await make([empty],{STUDIO_EXEC_SSH_HOST:'h'}).available()).reason,/only partly set up/);
  assert.deepEqual(await make([empty]).available(),{ok:false,reason:'The ssh command is not installed on this computer.'});
  const hostkey=await fakeSsh(path.join(dir,'a'),'hostkey');
  assert.deepEqual(await make([hostkey]).available(),{ok:false,reason:'This engine does not trust build.example.test yet. Connect once yourself with: ssh -p 2222 tupies@build.example.test (check the host key it shows), then try again.'});
  assert.match((await make([await fakeSsh(path.join(dir,'b'),'denied')]).available()).reason,/refused the key for tupies\. Password sign-in is never used/);
  assert.equal((await make([await fakeSsh(path.join(dir,'c'),'refused')]).available()).reason,'The connection to build.example.test failed (ssh: connect to host x port 22: Connection refused).');
  assert.equal((await make([await fakeSsh(path.join(dir,'d'),'hang')],SETTINGS,{probeTimeoutMs:300}).available()).reason,'build.example.test did not answer in time.');
  const ready=await fakeSsh(path.join(dir,'e'));
  assert.deepEqual(await make([ready]).available(),{ok:true,reason:''});
  const call=(await fs.readFile(path.join(dir,'e','calls.log'),'utf8')).trim();
  assert.match(call,/-T -o BatchMode=yes -o StrictHostKeyChecking=yes .* -p 2222 -i \/keys\/id_tupies -l tupies -- build\.example\.test true$/);
});

test('available(): cached for a minute, failures re-checked sooner; describe() says files stay on that machine',async t=>{
  const dir=await temp(t),bin=await fakeSsh(dir);let now=1000;
  const backend=createSshBackend({env:SETTINGS,searchDirs:[bin],userHome:dir,clock:()=>now});
  const calls=async()=>(await fs.readFile(path.join(dir,'calls.log'),'utf8')).split('\n').filter(Boolean).length;
  await backend.available();await backend.available();assert.equal(await calls(),1);
  now+=61_000;await backend.available();assert.equal(await calls(),2);
  const description=backend.describe();
  assert.match(description.summary,/files the bot creates there stay on that machine/);assert.equal(description.isolated,true);assert.equal(backend.label,'Another machine (SSH)');
});

test('prepare(): the control socket lives in the data folder and a working folder outside the workspace is refused',async t=>{
  const dir=await fs.realpath(await fs.mkdtemp('/tmp/tex-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const bin=await fakeSsh(dir),data=path.join(dir,'d'),workspace=path.join(data,'workspaces','bot');
  await fs.mkdir(workspace,{recursive:true});
  const backend=createSshBackend({env:SETTINGS,searchDirs:[bin],userHome:dir,probeTimeoutMs:3000});
  const launch=await backend.prepare({dataDir:data,botId:'bot',workspaceRoot:workspace,home:path.join(data,'h'),env:{HOME:'/x',OPENAI_API_KEY:'sk-secret',TUPIES_CWD:path.join(workspace,'sub')},cwd:path.join(workspace,'sub'),executable:'python3',args:['-c','print(1)']});
  assert.equal(launch.executable,path.join(bin,'ssh'));
  assert.ok(launch.args.some(item=>/^ControlPath=\/.*\/d\/exec-ssh\/c-[0-9a-f]{8}$/.test(item)));
  assert.ok((await fs.stat(path.join(data,'exec-ssh'))).isDirectory());
  assert.equal(launch.args.at(-1),`mkdir -p -- '/srv/tupies/bot' '/srv/tupies/bot/sub' && cd -- '/srv/tupies/bot/sub' && exec env 'TUPIES_CWD=/srv/tupies/bot/sub' 'python3' '-c' 'print(1)'`);
  assert.ok(!launch.args.join(' ').includes('sk-secret'));assert.equal(launch.env.OPENAI_API_KEY,undefined);
  for(const cwd of [dir,path.join(workspace,'..'),'/etc'])await assert.rejects(backend.prepare({dataDir:data,botId:'bot',workspaceRoot:workspace,home:'/h',env:{},cwd,executable:'ls',args:[]}),/only runs commands in the bot’s own workspace/);
  const off=createSshBackend({env:{},searchDirs:[bin],userHome:dir});
  await assert.rejects(off.prepare({dataDir:data,botId:'bot',workspaceRoot:workspace,home:'/h',env:{},cwd:workspace,executable:'ls',args:[]}),/SSH is not set up on this engine/);
  // A data folder whose socket path would be too long for a unix socket: no sharing, still a valid launch.
  const long=path.join(dir,'x'.repeat(80));await fs.mkdir(long);
  const unshared=await backend.prepare({dataDir:long,botId:'bot',workspaceRoot:workspace,home:'/h',env:{},cwd:workspace,executable:'ls',args:[]});
  assert.ok(!unshared.args.some(item=>item.startsWith('ControlMaster')));
});
