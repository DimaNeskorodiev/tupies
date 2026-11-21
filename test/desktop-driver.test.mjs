import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {desktopDriver,desktopExecutableIdentity,sameDriverIdentity} from '../lib/desktop-driver.mjs';
import {processEnvironment} from '../lib/process-environment.mjs';
import {installDesktopDriver} from '../scripts/install-desktop-driver.mjs';

async function fixture(t,body) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'tupies-desktop-driver-'))),executable=path.join(root,'agent-desktop');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(executable,`#!${process.execPath}\n${body}\n`,{mode:0o755});await fs.writeFile(path.join(root,'agent-desktop-macos-helper'),'synthetic helper',{mode:0o755});
  return {root,executable,identity:await desktopExecutableIdentity(executable),env:await processEnvironment(path.join(root,'home'))};
}
test('desktop driver uses the pinned executable and validates protocol, command and successful exit',async t=>{
  const f=await fixture(t,'process.stdout.write(JSON.stringify({version:"2.6",ok:true,command:process.argv[2],data:{version:"1.1.0"}}));');
  assert.deepEqual(await desktopDriver({...f,args:['version'],cwd:f.root}),{version:'1.1.0'});
  await fs.appendFile(f.executable,'// replaced code');await assert.rejects(desktopDriver({...f,args:['version'],cwd:f.root}),/changed/);
});
test('desktop helper replacement refuses dispatch too',async t=>{
  const f=await fixture(t,'process.exit(42)');await fs.writeFile(path.join(f.root,'agent-desktop-macos-helper'),'different native code');await assert.rejects(desktopDriver({...f,args:['version'],cwd:f.root}),/changed/);
});
test('a renumbered volume (st_dev) after a reboot keeps the driver pin valid',async t=>{
  const f=await fixture(t,'process.stdout.write(JSON.stringify({version:"2.6",ok:true,command:process.argv[2],data:{version:"1.1.0"}}));');
  const rebooted=f.identity.map(file=>({...file,device:file.device+3}));
  assert.deepEqual(await desktopDriver({...f,identity:rebooted,args:['version'],cwd:f.root}),{version:'1.1.0'});
  const legacy=f.identity.map(({path,sha256,device,inode})=>({path,sha256,device,inode}));assert.equal(sameDriverIdentity(legacy,rebooted),true);
});
test('changed bytes, inode, path or file set still refuse dispatch',async t=>{
  const f=await fixture(t,'process.stdout.write(JSON.stringify({version:"2.6",ok:true,command:process.argv[2],data:{version:"1.1.0"}}));'),run=identity=>desktopDriver({...f,identity,args:['version'],cwd:f.root});
  await assert.rejects(run([{...f.identity[0],sha256:'0'.repeat(64)},f.identity[1]]),e=>/changed/.test(e.message)&&e.notDelivered===true);
  await assert.rejects(run([f.identity[0],{...f.identity[1],inode:f.identity[1].inode+1}]),/changed/);
  await assert.rejects(run([f.identity[0]]),/changed/);
  const link=path.join(f.root,'linked-agent-desktop');await fs.symlink(f.executable,link);await assert.rejects(run([{...f.identity[0],path:link},f.identity[1]]),/changed/);
  // Same bytes in a new file (new inode) is a replacement, not the pinned file.
  const copy=path.join(f.root,'copy');await fs.copyFile(f.executable,copy);await fs.chmod(copy,0o755);await fs.rename(copy,f.executable);
  const replaced=await desktopExecutableIdentity(f.executable);assert.equal(replaced[0].sha256,f.identity[0].sha256);assert.notEqual(replaced[0].inode,f.identity[0].inode);
  await assert.rejects(run(f.identity),/changed/);
});
test('driver rejects malformed or mismatched output rather than certifying success',async t=>{
  for(const body of ['console.log("not a JSON receipt")','console.log(JSON.stringify({version:"1.0",ok:true,command:"version",data:{}}))','console.log(JSON.stringify({version:"2.6",ok:true,command:"click",data:{}}))','console.log(JSON.stringify({version:"2.6",ok:true,command:"version",data:{}}));process.exitCode=7;']) {
    const f=await fixture(t,body);await assert.rejects(desktopDriver({...f,args:['version'],cwd:f.root}));
  }
});
test('native refusal retains explicit non-delivery without granting automatic retries',async t=>{
  const f=await fixture(t,'console.log(JSON.stringify({version:"2.6",ok:false,command:"click",error:{code:"STALE_REF",message:"Synthetic stale target",disposition:{delivery:"not_delivered",retry:"safe"}}}));process.exitCode=1;');
  await assert.rejects(desktopDriver({...f,args:['click','@s1:e1'],cwd:f.root}),e=>e.notDelivered===true&&e.retryable===false&&e.driverCode==='STALE_REF');
});
test('Stop actually terminates a running driver process',async t=>{
  const f=await fixture(t,'setInterval(()=>{},1000);'),controller=new AbortController();const command=desktopDriver({...f,args:['version'],cwd:f.root,signal:controller.signal});const timer=setTimeout(()=>controller.abort(new Error('Synthetic desktop Stop')),100);try{await assert.rejects(command,/desktop Stop/);}finally{clearTimeout(timer);}
});
test('offline desktop installation refuses changed archives before creating executable files',async t=>{
  const f=await fixture(t,'process.exit(0)'),archive=path.join(f.root,'untrusted.tar.gz'),destination=path.join(f.root,'installed');await fs.writeFile(archive,'Not the pinned upstream archive');await assert.rejects(installDesktopDriver({archive,destination,arch:'arm64'}),/digest/);await assert.rejects(fs.access(destination));await assert.rejects(installDesktopDriver({archive,destination,arch:'x64'}),/arm64/);
});
