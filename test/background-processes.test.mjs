import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Store } from '../lib/store.mjs';
import { BackgroundProcesses } from '../lib/background-processes.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=3000) {const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await delay(5);}throw new Error('Background fixture timed out.');}
async function fixture(t,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-background-')),store=await new Store(directory).init();
  await store.mutate(state=>{for(const bot of state.bots)state.runs[bot.id]={id:`run_${bot.id}`,botId:bot.id,status:'running'};});
  const manager=new BackgroundProcesses(store,options),bot=store.state.bots[0],runId=store.state.runs[bot.id].id,root=await getWorkspaceRoot(store,bot.id);
  t.after(async()=>{await manager.close();await fs.rm(directory,{recursive:true,force:true});});
  const start=(script,args={})=>manager.start(bot,runId,{executable:process.execPath,args:['-e',script],timeoutMs:5000,...args});
  return {directory,store,manager,bot,runId,root,start};
}

test('background commands return live handles, overlap and page captured output after real completion',async t=>{
  const {manager,bot,runId,root,start}=await fixture(t);
  const a=await start("const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync('go-a')){clearInterval(timer);process.stdout.write('alpha🙂omega');}},5)");
  const b=await start("const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync('go-b')){clearInterval(timer);process.stderr.write('stderr-result');}},5)");
  assert.equal(a.status,'running');assert.equal(b.status,'running');assert.equal(manager.hasActive(runId),true);
  assert.equal(manager.list(bot.id,runId).processes.filter(item=>item.status==='running').length,2);
  const waiting=manager.read(bot.id,runId,a.processId,{offset:0,limit:5,waitMs:1000});
  await fs.writeFile(path.join(root,'go-a'),'go');const first=await waiting;
  assert.equal(first.output,'alpha');assert.equal(first.nextOffset,5);
  await fs.writeFile(path.join(root,'go-b'),'go');
  const completed=await manager.wait(bot.id,runId,a.processId);assert.equal(completed.exitCode,0);assert.equal(completed.signal,null);assert.equal((await manager.wait(bot.id,runId,b.processId)).status,'completed');
  const rest=await manager.read(bot.id,runId,a.processId,{offset:first.nextOffset});assert.equal(rest.output,'🙂omega');assert.equal(rest.complete,true);assert.equal(rest.nextOffset,null);
  assert.equal((await manager.read(bot.id,runId,b.processId)).output,'stderr-result');assert.equal(manager.hasActive(runId),false);
});

test('process results distinguish failure, startup errors, timeouts and bounded output termination',async t=>{
  const {manager,bot,runId,start}=await fixture(t,{maxBytes:1000});
  const failed=await start("process.stderr.write('failed verification');process.exitCode=7");
  const result=await manager.wait(bot.id,runId,failed.processId);assert.equal(result.status,'failed');assert.equal(result.exitCode,7);
  assert.equal((await manager.read(bot.id,runId,failed.processId)).output,'failed verification');
  await assert.rejects(manager.start(bot,runId,{executable:'/this-executable-does-not-exist',args:[]}),/Could not start.*ENOENT/);
  const timed=await start('setInterval(()=>{},1000)',{timeoutMs:500});assert.equal((await manager.wait(bot.id,runId,timed.processId)).status,'timed_out');
  const flooded=await start("process.stdout.write('x'.repeat(20000));setInterval(()=>{},1000)");const ended=await manager.wait(bot.id,runId,flooded.processId);
  assert.equal(ended.status,'output_limit');assert.equal(ended.truncated,true);
  const output=await manager.read(bot.id,runId,flooded.processId);assert.ok(output.output.length<=1000);assert.equal(output.truncated,true);
});

test('background identities, private cwd and reserved concurrency cannot escape bot/run bounds',async t=>{
  const {manager,store,bot,runId,root,start}=await fixture(t,{maxPerRun:1,maxGlobal:1});
  await fs.mkdir(path.join(root,'project'));const child=await start("process.stdout.write(process.cwd());setInterval(()=>{},1000)",{cwd:'project'});
  await assert.rejects(start('process.exit(0)'),/concurrency limit/);
  const other=store.state.bots[1],otherRun=store.state.runs[other.id].id;
  await assert.rejects(manager.read(other.id,otherRun,child.processId),/another bot or run/);
  await assert.rejects(manager.stop(bot.id,'run_old',child.processId),/another or expired run/);
  await manager.read(bot.id,runId,child.processId,{waitMs:1000});
  await manager.stop(bot.id,runId,child.processId);assert.equal(manager.hasActive(runId),false);
  assert.equal((await manager.read(bot.id,runId,child.processId)).output,await fs.realpath(path.join(root,'project')));
  await assert.rejects(start('process.exit(0)',{cwd:'..'}),/cannot leave/);
  await fs.symlink(root,path.join(root,'alias'));await assert.rejects(start('process.exit(0)',{cwd:'alias'}),/Symbolic links/);
  await fs.symlink(root,path.join(root,'temp-alias'));await assert.rejects(start('process.exit(0)',{cwd:'/tmp'}),/cannot leave/);
  await assert.rejects(start('process.exit(0)',{timeoutMs:1800001}),/timeout/);
});

test('UTF-8 and known credentials split across chunks stay redacted in live reads and persisted previews',async t=>{
  const {manager,store,bot,runId,start,directory}=await fixture(t);const secret='fixture-split-provider-token';
  await store.mutate(state=>{state.connections.push({id:'fixture',secret:store.seal(secret)});});
  const script=`const data=Buffer.from(${JSON.stringify(`before🙂 ${secret} after`)});let i=0;const timer=setInterval(()=>{process.stdout.write(data.subarray(i,i+1));if(++i===data.length)clearInterval(timer)},2)`;
  const child=await start(script);let offset=0,seen='';
  while(manager.hasActive(runId)) {
    const page=await manager.read(bot.id,runId,child.processId,{offset,waitMs:1000});seen+=page.output;offset+=page.output.length;
    assert.doesNotMatch(page.output,/fixture-split-provider-token/);assert.doesNotMatch(await fs.readFile(path.join(directory,'state.json'),'utf8'),/fixture-split-provider-token/);
  }
  const final=await manager.read(bot.id,runId,child.processId,{offset});seen+=final.output;
  assert.equal(seen,'before🙂 [redacted] after');assert.doesNotMatch(seen,/�/);
  await manager.closeRun(runId);assert.equal(manager.entries.size,0);
  const persisted=await manager.read(bot.id,runId,child.processId);assert.equal(persisted.persistedPreview,true);assert.equal(persisted.output,seen);
});

test('truncated Unicode credential prefixes stay redacted when the byte budget cuts an astral token',async t=>{
  const {manager,store,bot,runId,start,directory}=await fixture(t,{maxBytes:100}),secret='🧩'.repeat(20)+'-fixture-key';
  await store.mutate(state=>{state.connections.push({id:'unicode',secret:store.seal(secret)});});
  for(const prefixLength of [80,81]) {
    const child=await start(`process.stdout.write('x'.repeat(${prefixLength})+${JSON.stringify(secret)});setInterval(()=>{},1000)`);await manager.wait(bot.id,runId,child.processId);
    const output=await manager.read(bot.id,runId,child.processId);assert.equal(output.status,'output_limit');assert.equal(output.truncated,true);
    assert.equal(output.output,'x'.repeat(prefixLength)+'[redacted partial]');assert.doesNotMatch(await fs.readFile(path.join(directory,'state.json'),'utf8'),/🧩/);
  }
});

test('long credentials hold only matching suffixes so short READY output is readable while running',async t=>{
  const {manager,store,bot,runId,start}=await fixture(t),secret='fixture-long-'+ 'x'.repeat(2000);
  await store.mutate(state=>{state.connections.push({id:'long',secret:store.seal(secret)});});
  const child=await start("process.stdout.write('READY\\n');setInterval(()=>{},1000)");
  const page=await manager.read(bot.id,runId,child.processId,{waitMs:1000});
  assert.equal(page.status,'running');assert.equal(page.output,'READY\n');assert.equal(page.complete,false);
  await manager.stop(bot.id,runId,child.processId);
});

test('rotated credentials split over live chunks remain redacted across page boundaries and retain old protection',async t=>{
  const {manager,store,bot,runId,root,start,directory}=await fixture(t),oldToken='fixture-old-token',newToken='fixture-new-token-with-a-longer-rotated-secret';
  await store.mutate(state=>{state.connections.push({id:'rotate',secret:store.seal(oldToken)});});
  const script="const fs=require('node:fs');process.stdout.write('READY\\n');const timer=setInterval(()=>{if(!fs.existsSync('go'))return;clearInterval(timer);const bytes=Buffer.from(fs.readFileSync('emit','utf8'));let at=0;const output=setInterval(()=>{process.stdout.write(bytes.subarray(at,at+1));if(++at===bytes.length){clearInterval(output);process.stdout.write('DONE\\n')}},2)},5)";
  const child=await start(script);const first=await manager.read(bot.id,runId,child.processId,{limit:6,waitMs:1000});assert.equal(first.output,'READY\n');
  await store.mutate(state=>{state.connections[0].secret=store.seal(newToken);});
  await fs.writeFile(path.join(root,'emit'),`${newToken}\n${oldToken}\n`);await fs.writeFile(path.join(root,'go'),'go');
  let output=first.output,offset=output.length;
  for(let attempt=0;attempt<100;attempt++) {
    const page=await manager.read(bot.id,runId,child.processId,{offset,limit:7,waitMs:1000});output+=page.output;offset+=page.output.length;
    assert.doesNotMatch(page.output,/fixture-new|fixture-old/);const persisted=await fs.readFile(path.join(directory,'state.json'),'utf8');assert.ok(!persisted.includes(oldToken) && !persisted.includes(newToken));
    if(page.complete && page.nextOffset===null)break;
  }
  assert.equal(output,'READY\n[redacted]\n[redacted]\nDONE\n');
});

test('late credential discovery re-redacts the complete retained result before slicing and rejects stale cursors',async t=>{
  const {manager,store,bot,runId,root,start,directory}=await fixture(t),token='fixture-late-discovered-provider-credential';
  await fs.writeFile(path.join(root,'emit'),`${'A'.repeat(11990)}${token}TAIL`);
  const child=await start("process.stdout.write(require('node:fs').readFileSync('emit'));/*"+'x'.repeat(160)+'*/');await manager.wait(bot.id,runId,child.processId);
  assert.equal(child.argsPreviewTruncated,true);
  const first=await manager.read(bot.id,runId,child.processId,{limit:12000});assert.equal(first.nextOffset,12000);
  await store.mutate(state=>{state.connections.push({id:'late',secret:store.seal(token)});});
  await assert.rejects(manager.read(bot.id,runId,child.processId,{offset:12000,outputVersion:first.outputVersion}),/Output changed.*Restart reading/);
  const reset=await manager.read(bot.id,runId,child.processId,{offset:0,limit:12000});assert.ok(reset.outputVersion>first.outputVersion);assert.equal(reset.output,'A'.repeat(11990)+'[redacted]');
  await assert.rejects(manager.read(bot.id,runId,child.processId,{offset:12000}),/Output changed/);
  const rest=await manager.read(bot.id,runId,child.processId,{offset:12000,outputVersion:reset.outputVersion});assert.equal(rest.output,'TAIL');assert.equal(rest.nextOffset,null);
  assert.ok(!(await fs.readFile(path.join(directory,'state.json'),'utf8')).includes(token));
});

test('parent cancellation drains process groups including descendants that ignore SIGTERM',async t=>{
  if(process.platform==='win32')return;
  const {manager,bot,runId,root,start}=await fixture(t);const controller=new AbortController();
  const grandchild="const fs=require('node:fs');process.on('SIGTERM',()=>{});let n=0;setInterval(()=>fs.writeFileSync('heartbeat',String(++n)),10)";
  const script=`const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const child=await manager.start(bot,runId,{executable:process.execPath,args:['-e',script],timeoutMs:5000},{signal:controller.signal});
  await until(async()=>fs.readFile(path.join(root,'heartbeat'),'utf8').catch(()=>null));controller.abort(new Error('Fixture parent stopped.'));
  const ended=await manager.wait(bot.id,runId,child.processId);assert.equal(ended.status,'stopped');assert.equal(manager.hasActive(runId),false);
  const beat=await fs.readFile(path.join(root,'heartbeat'),'utf8');await delay(75);assert.equal(await fs.readFile(path.join(root,'heartbeat'),'utf8'),beat);
  await assert.rejects(manager.read(bot.id,runId,child.processId,{waitMs:1000},{signal:controller.signal}),/Fixture parent stopped/);
  await assert.rejects(start('process.exit(0)',{timeoutMs:1}),/timeout/);
});

test('recovery interrupts metadata without replaying commands or adopting a saved PID',async t=>{
  const {manager,store,bot,runId,root}=await fixture(t);
  await store.mutate(state=>{state.runs[bot.id].backgroundProcesses=[{id:'process_saved',processId:'process_saved',status:'running',pid:process.pid,executable:process.execPath,output:'retained prefix',retainedChars:15,totalBytes:15}];});
  await manager.recover();const list=manager.list(bot.id,runId).processes;assert.equal(list[0].status,'interrupted');assert.equal(list[0].pid,undefined);
  assert.equal((await manager.read(bot.id,runId,'process_saved')).output,'retained prefix');assert.equal(manager.entries.size,0);
  assert.deepEqual(await fs.readdir(root),[]);
});

test('stopping reserved commands during persistence admission never launches their executable',async t=>{
  for(const mode of ['stop','run','service','replace']) {
    const {manager,store,bot,runId,root,start}=await fixture(t);const original=store.mutate.bind(store);
    let admit,release;const entered=new Promise(resolve=>{admit=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    store.mutate=async fn=>{admit();await gate;return original(fn);};
    const starting=start("require('node:fs').writeFileSync('must-not-exist','side effect')");
    await entered;const processId=[...manager.entries.keys()][0];
    let closing;
    if(mode==='stop')closing=manager.stop(bot.id,runId,processId);
    if(mode==='run')closing=manager.closeRun(runId);
    if(mode==='service')closing=manager.close();
    if(mode==='replace')store.state.runs[bot.id]={id:'replacement',status:'running'};
    release();await assert.rejects(starting,/stopped accepting|another or expired run/);await closing;
    await assert.rejects(fs.access(path.join(root,'must-not-exist')));assert.equal(manager.hasActive(runId),false);
    store.mutate=original;
  }
});

test('completed command previews expose reduced coverage after run cleanup and history stays bounded',async t=>{
  const {manager,store,bot,runId,start}=await fixture(t);const child=await start("process.stdout.write('z'.repeat(20000))");await manager.wait(bot.id,runId,child.processId);
  const full=await manager.read(bot.id,runId,child.processId,{offset:12000});assert.equal(full.output.length,8000);assert.equal(full.truncated,false);
  await manager.closeRun(runId);const saved=await manager.read(bot.id,runId,child.processId);assert.equal(saved.output.length,12000);assert.equal(saved.truncated,true);assert.equal(saved.outputPreviewTruncated,true);assert.equal(saved.persistedPreview,true);
  await store.mutate(state=>{state.runs[bot.id].backgroundProcesses=Array.from({length:20},(_,index)=>({id:`saved${index}`,processId:`saved${index}`,status:'completed'}));});
  await assert.rejects(start('process.exit(0)'),/history limit/);assert.equal(manager.entries.size,0);
});

test('guardian kills the owned command after an abrupt host crash, then recovery preserves interruption',async t=>{
  if(process.platform==='win32')return;
  const {directory,manager,store,bot,runId,root}=await fixture(t);
  const storeUrl=new URL('../lib/store.mjs',import.meta.url).href,managerUrl=new URL('../lib/background-processes.mjs',import.meta.url).href;
  const command="const fs=require('node:fs');process.on('SIGTERM',()=>{});let n=0;setInterval(()=>fs.writeFileSync('crash-heartbeat',String(++n)),10)";
  const hostScript=`const {Store}=await import(${JSON.stringify(storeUrl)});const {BackgroundProcesses}=await import(${JSON.stringify(managerUrl)});const store=await new Store(${JSON.stringify(directory)}).init();const manager=new BackgroundProcesses(store);const child=await manager.start(${JSON.stringify(bot.id)},${JSON.stringify(runId)},{executable:process.execPath,args:['-e',${JSON.stringify(command)}],timeoutMs:5000});console.log(JSON.stringify({id:child.processId,guardian:manager.entries.get(child.processId).child.pid}));setInterval(()=>{},1000)`;
  const host=spawn(process.execPath,['--input-type=module','-e',hostScript],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='',guardian;
  host.stdout.on('data',chunk=>{stdout+=chunk;});host.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(()=>{try{host.kill('SIGKILL');}catch{}if(guardian)try{process.kill(-guardian,'SIGKILL');}catch{}});
  const metadata=await until(()=>{try{return JSON.parse(stdout.trim());}catch{return null;}});guardian=metadata.guardian;
  await until(async()=>fs.readFile(path.join(root,'crash-heartbeat'),'utf8').catch(()=>null));host.kill('SIGKILL');
  await new Promise(resolve=>host.once('close',resolve));assert.equal(stderr,'');await delay(450);
  const beat=await fs.readFile(path.join(root,'crash-heartbeat'),'utf8');await delay(80);assert.equal(await fs.readFile(path.join(root,'crash-heartbeat'),'utf8'),beat);
  const reloaded=await new Store(directory).init(),restarted=new BackgroundProcesses(reloaded);await restarted.recover();
  assert.equal(reloaded.state.runs[bot.id].backgroundProcesses[0].status,'interrupted');assert.equal(restarted.entries.size,0);await restarted.close();
  // The original in-test store was not the crashed host and must not overwrite its fixture state.
  assert.equal(manager.hasActive(runId),false);assert.equal(store.state.runs[bot.id].id,runId);
});
