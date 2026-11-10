import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDockerBackend, dockerRunArgs, dockerSettings, containerEnvironment, DEFAULT_DOCKER_IMAGE, CONTAINER_PATH } from '../lib/exec/docker.mjs';

const temp=async t=>{const dir=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'tupies-exec-docker-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;};
/** A fake `docker` CLI: behaviour chosen by files next to it, so each test can describe a daemon state. */
async function fakeCli(dir,{daemon=true,image=true,name='docker'}={}) {
  const bin=path.join(dir,'bin');await fs.mkdir(bin,{recursive:true});
  const script=`#!/bin/sh
echo "$@" >> "${dir}/calls.log"
case "$1" in
  version) ${daemon?'echo 27.0.0; exit 0':'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; exit 1'};;
  image) ${image?'echo sha256:abc; exit 0':'echo "Error: No such image" >&2; exit 1'};;
esac
exit 2
`;
  await fs.writeFile(path.join(bin,name),script,{mode:0o755});return bin;
}
const mounts=[{source:'/srv/ws/bot',target:'/srv/ws/bot'},{source:'/srv/home/bot',target:'/srv/home/bot'}];
const base={image:'img:1',name:'tupies-exec-abc',mounts,workdir:'/srv/ws/bot/sub',env:{HOME:'/srv/home/bot'},executable:'bash',args:['-lc','echo hi; rm -rf /']};

test('docker run arguments: fixed isolation flags, two mounts, no socket, command as separate argv entries',()=>{
  const argv=dockerRunArgs({...base,user:'1000:1000'});
  assert.deepEqual(argv,['run','--rm','-i','--init','--pull=never','--name','tupies-exec-abc','--label','tupies-exec=1','--hostname','tupies-exec','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','2g','--pids-limit','512','--user','1000:1000','--mount','type=bind,source=/srv/ws/bot,target=/srv/ws/bot','--mount','type=bind,source=/srv/home/bot,target=/srv/home/bot','--workdir','/srv/ws/bot/sub','--env','HOME=/srv/home/bot','img:1','bash','-lc','echo hi; rm -rf /']);
  assert.equal(argv.filter(item=>item==='--mount').length,2);
  assert.ok(!argv.some(item=>/docker\.sock|--privileged|--network|--volume|^-v$/.test(item)),'no socket, no privilege, network left at its default');
  assert.equal(dockerRunArgs(base).includes('--user'),false,'no user flag where Docker maps ownership itself');
  assert.ok(argv.slice(argv.indexOf('img:1')).every(item=>typeof item==='string') && argv.at(-1)==='echo hi; rm -rf /','the script stays one literal argument');
});

test('docker run arguments: hostile paths, names and values are refused or passed literally',()=>{
  for(const bad of ['relative/path','/a/../b','/with,comma','/with"quote','/new\nline','/tmp//x','/'])
    assert.throws(()=>dockerRunArgs({...base,mounts:[{source:bad,target:'/x'}]}),/cannot use the mounted folder path/,bad);
  assert.throws(()=>dockerRunArgs({...base,workdir:'/a,b'}),/working folder path/);
  assert.throws(()=>dockerRunArgs({...base,image:'-v /:/host'}),/image name/);
  assert.throws(()=>dockerRunArgs({...base,image:'img --privileged'}),/image name/);
  assert.throws(()=>dockerRunArgs({...base,env:{'BAD NAME':'x'}}),/environment variable/);
  assert.throws(()=>dockerRunArgs({...base,env:{GOOD:'a\0b'}}),/environment variable/);
  assert.throws(()=>dockerRunArgs({...base,args:['a\0b']}),/command to run/);
  assert.throws(()=>dockerRunArgs({...base,mounts:[]}),/at least one folder/);
  const literal=dockerRunArgs({...base,env:{TUPIES_COMMAND:'$(id) `id` ; "q" \'s\'\nnext'},executable:'-weird',args:['--rm','$(x)','a b']});
  assert.ok(literal.includes('TUPIES_COMMAND=$(id) `id` ; "q" \'s\'\nnext'));
  assert.deepEqual(literal.slice(-4),['-weird','--rm','$(x)','a b']);
});

test('container environment: an allow-list, never PATH or provider keys',()=>{
  const env=containerEnvironment({PATH:'/Users/x/node/bin:/usr/bin',HOME:'/h',TMPDIR:'/h/.tmp',LANG:'C.UTF-8',XDG_CACHE_HOME:'/h/.cache',GIT_CONFIG_COUNT:'4',TUPIES_STATE_DIR:'/h/.tmp/t',TUPIES_V_FOO:'bar',OPENAI_API_KEY:'sk-secret',AWS_SECRET_ACCESS_KEY:'x',SSH_AUTH_SOCK:'/tmp/agent','bad name':'x',npm_config_cache:'/h/.npm'});
  assert.deepEqual(Object.keys(env).sort(),['GIT_CONFIG_COUNT','HOME','LANG','PATH','TMPDIR','TUPIES_STATE_DIR','TUPIES_V_FOO','XDG_CACHE_HOME','npm_config_cache']);
  assert.equal(env.PATH,CONTAINER_PATH);
});

test('docker settings: defaults and validation',()=>{
  assert.deepEqual(dockerSettings({}),{image:DEFAULT_DOCKER_IMAGE,memory:'2g',pids:512});
  assert.deepEqual(dockerSettings({STUDIO_EXEC_DOCKER_IMAGE:'tupies-exec',STUDIO_EXEC_DOCKER_MEMORY:'512m',STUDIO_EXEC_DOCKER_PIDS:'64'}),{image:'tupies-exec',memory:'512m',pids:64});
  for(const env of [{STUDIO_EXEC_DOCKER_IMAGE:'--privileged'},{STUDIO_EXEC_DOCKER_IMAGE:'a b'},{STUDIO_EXEC_DOCKER_MEMORY:'lots'},{STUDIO_EXEC_DOCKER_PIDS:'-1'}])assert.throws(()=>dockerSettings(env),/STUDIO_EXEC_DOCKER/);
});

test('available(): CLI missing, daemon not answering, image missing with the exact pull hint, and ready',async t=>{
  const dir=await temp(t),empty=path.join(dir,'empty');await fs.mkdir(empty);
  const make=(searchDirs,env={})=>createDockerBackend({env,searchDirs,userHome:dir,probeTimeoutMs:3000});
  assert.deepEqual(await make([empty]).available(),{ok:false,reason:'The docker command is not installed on this computer. Install Docker (or Podman), then choose this again.'});
  const down=await fakeCli(path.join(dir,'a'),{daemon:false});
  const reason=(await make([down]).available()).reason;
  assert.match(reason,/^Docker is not running \(Cannot connect to the Docker daemon.*\)\. Start Docker, then try again\.$/);
  const noImage=await fakeCli(path.join(dir,'b'),{image:false});
  assert.deepEqual(await make([noImage]).available(),{ok:false,reason:`Image ${DEFAULT_DOCKER_IMAGE} is not on this computer. Run: docker pull ${DEFAULT_DOCKER_IMAGE}`});
  assert.deepEqual(await make([noImage],{STUDIO_EXEC_DOCKER_IMAGE:'tupies-exec'}).available(),{ok:false,reason:'Image tupies-exec is not on this computer. Run: docker pull tupies-exec'});
  const ready=await fakeCli(path.join(dir,'c'));
  assert.deepEqual(await make([ready]).available(),{ok:true,reason:''});
  const podman=await fakeCli(path.join(dir,'d'),{name:'podman',image:false});
  assert.match((await make([podman]).available()).reason,/Run: podman pull /);
  assert.match((await make([ready],{STUDIO_EXEC_DOCKER_IMAGE:'--bad'}).available()).reason,/STUDIO_EXEC_DOCKER_IMAGE/);
});

test('available(): the answer is cached, a failure is re-checked sooner, the engine never pulls',async t=>{
  const dir=await temp(t),bin=await fakeCli(dir);let now=1000;
  const backend=createDockerBackend({env:{},searchDirs:[bin],userHome:dir,clock:()=>now});
  await backend.available();const first=(await fs.readFile(path.join(dir,'calls.log'),'utf8')).split('\n').filter(Boolean).length;
  await backend.available();assert.equal((await fs.readFile(path.join(dir,'calls.log'),'utf8')).split('\n').filter(Boolean).length,first);
  now+=61_000;await backend.available();assert.ok((await fs.readFile(path.join(dir,'calls.log'),'utf8')).split('\n').filter(Boolean).length>first);
  assert.ok(!(await fs.readFile(path.join(dir,'calls.log'),'utf8')).includes('pull'),'only version and image inspect were called');
  assert.equal(backend.describe().isolated,true);assert.equal(backend.label,'Docker container');
});

test('prepare(): builds the launch from the real folders and refuses a working folder outside them',async t=>{
  const dir=await temp(t),bin=await fakeCli(dir);
  const data=path.join(dir,'data'),workspace=path.join(data,'workspaces','bot'),home=path.join(data,'process-homes','bot'),outside=path.join(dir,'elsewhere');
  for(const folder of [path.join(workspace,'sub'),home,outside])await fs.mkdir(folder,{recursive:true});
  await fs.symlink(outside,path.join(workspace,'escape'));
  const userHome=path.join(dir,'user');await fs.mkdir(userHome);
  const backend=createDockerBackend({env:{DOCKER_HOST:'unix:///x.sock',OPENAI_API_KEY:'sk-secret'},platform:'linux',searchDirs:[bin],userHome});
  const launch=await backend.prepare({dataDir:data,botId:'bot',workspaceRoot:workspace,home,env:{PATH:'/host/bin',HOME:home,TUPIES_CWD:path.join(workspace,'sub'),OPENAI_API_KEY:'sk-secret'},cwd:path.join(workspace,'sub'),executable:'bash',args:['-lc','pwd']});
  assert.equal(launch.executable,path.join(bin,'docker'));
  assert.equal(launch.args[0],'run');
  assert.deepEqual(launch.args.slice(-3),['bash','-lc','pwd']);
  assert.ok(launch.args.includes(`type=bind,source=${workspace},target=${workspace}`) && launch.args.includes(`type=bind,source=${home},target=${home}`));
  assert.equal(launch.args[launch.args.indexOf('--workdir')+1],path.join(workspace,'sub'));
  assert.equal(launch.args[launch.args.indexOf('--user')+1],`${process.getuid()}:${process.getgid()}`);
  assert.ok(!launch.args.join(' ').includes('sk-secret') && !launch.args.includes('PATH=/host/bin'));
  assert.ok(launch.args.includes(`HOME=${home}`) && launch.args.includes(`PATH=${CONTAINER_PATH}`));
  assert.equal(launch.env.DOCKER_HOST,'unix:///x.sock');assert.equal(launch.env.OPENAI_API_KEY,undefined);assert.equal(launch.env.DOCKER_CONFIG,path.join(userHome,'.docker'));
  assert.equal(launch.args.includes('--user'),true);
  const mac=createDockerBackend({env:{},platform:'darwin',searchDirs:[bin],userHome});
  assert.equal((await mac.prepare({dataDir:data,botId:'bot',workspaceRoot:workspace,home,env:{},cwd:workspace,executable:'ls',args:[]})).args.includes('--user'),false);
  const request=cwd=>backend.prepare({dataDir:data,botId:'bot',workspaceRoot:workspace,home,env:{},cwd,executable:'ls',args:[]});
  await assert.rejects(request(outside),/only runs commands in the bot’s own workspace or process home/);
  await assert.rejects(request(path.join(workspace,'escape')),/leads outside the bot’s own folders/);
  await assert.rejects(request(path.join(workspace,'..')),/only runs/);
  await assert.rejects(request(path.join(workspace,'missing')),/could not resolve the working folder/);
  await assert.rejects(backend.prepare({dataDir:data,botId:'bot',workspaceRoot:dir,home,env:{},cwd:dir,executable:'ls',args:[]}),/contains the Engine data folder/);
  await assert.rejects(backend.prepare({dataDir:data,botId:'bot',workspaceRoot:userHome,home,env:{},cwd:userHome,executable:'ls',args:[]}),/contains your home folder|Docker cannot/);
  await assert.rejects(backend.check({dataDir:data,botId:'bot',workspaceRoot:path.join(dir,'nope'),home}),/could not resolve the workspace/);
});

// A real container, only when a daemon is already running and the configured image is already on this computer.
const docker=['/usr/local/bin','/opt/homebrew/bin','/usr/bin'].map(dir=>path.join(dir,'docker')).find(file=>spawnSync('test',['-x',file]).status===0);
const probeReal=()=>{if(!docker)return false;const image=process.env.STUDIO_EXEC_DOCKER_IMAGE || DEFAULT_DOCKER_IMAGE;return spawnSync(docker,['version','--format','{{.Server.Version}}'],{timeout:8000,stdio:'ignore'}).status===0 && spawnSync(docker,['image','inspect',image],{timeout:8000,stdio:'ignore'}).status===0;};
const realDocker=probeReal();
// Platform-bound cases are defined only where they can run. The release verifier counts a skipped test as a failed
// suite, so a case that cannot apply on this platform is not registered instead of being skipped.
(realDocker?test:()=>{})('real Docker: a container sees only the two folders and cannot reach the socket',{skip:realDocker?false:'no running Docker daemon with the image already present locally'},async t=>{
  const dir=await temp(t),data=path.join(dir,'data'),workspace=path.join(data,'workspaces','bot'),home=path.join(data,'process-homes','bot');
  await fs.mkdir(workspace,{recursive:true});await fs.mkdir(home,{recursive:true});await fs.writeFile(path.join(dir,'secret.txt'),'nope');
  const backend=createDockerBackend({searchDirs:[path.dirname(docker)]});
  const launch=await backend.prepare({dataDir:data,botId:'bot',workspaceRoot:workspace,home,env:{HOME:home},cwd:workspace,executable:'bash',args:['-c',`echo ok > made.txt; test -e ${JSON.stringify(path.join(dir,'secret.txt'))} && echo LEAK; test -e /var/run/docker.sock && echo SOCKET; echo $HOME`]});
  const result=spawnSync(launch.executable,launch.args,{cwd:launch.cwd,env:launch.env,encoding:'utf8',timeout:60_000});
  assert.equal(result.status,0,result.stderr);assert.ok(!/LEAK|SOCKET/.test(result.stdout),result.stdout);assert.match(result.stdout,new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.equal((await fs.readFile(path.join(workspace,'made.txt'),'utf8')).trim(),'ok');
});
