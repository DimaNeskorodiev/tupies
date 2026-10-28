import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { AgentTools, getWorkspaceRoot, writeWorkspace, readWorkspace } from '../lib/agent-tools.mjs';

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-workspace-code-')),store=await new Store(directory).init();
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot={...store.state.bots[0],approvalPolicy:'balanced'},tools=new AgentTools(store),root=await getWorkspaceRoot(store,bot.id);
  const execute=(name,args,options)=>tools.execute(bot,name,args,options);
  return {directory,store,bot,tools,root,execute};
}

test('approved terminal verification uses a private subfolder and bounded timeout',async t=>{
  const {root,bot,execute}=await fixture(t);bot.tools=['workspace','terminal'];
  await fs.mkdir(path.join(root,'project'));
  const args={executable:process.execPath,args:['-e','process.stdout.write(process.cwd())'],cwd:'project',timeoutMs:5000};
  await assert.rejects(execute('shell_run',args),/approval/);
  const result=await execute('shell_run',args,{approved:true});assert.equal(result.exitCode,0);assert.equal(result.stdout,await fs.realpath(path.join(root,'project')));
  await assert.rejects(execute('shell_run',{...args,cwd:'..'},{approved:true}),/cannot leave/);
  await assert.rejects(execute('shell_run',{...args,timeoutMs:120001},{approved:true}),/timeout/);
  const timed=await execute('shell_run',{...args,args:['-e','setInterval(()=>{},1000)'],timeoutMs:100},{approved:true});
  assert.equal(timed.timedOut,true);assert.notEqual(timed.exitCode,0);
});

test('recursive discovery supports bounded globs without following symlinks or sharing bot files',async t=>{
  const {directory,store,bot,tools,root,execute}=await fixture(t);
  for(const file of ['root.mjs','src/a.mjs','src/nested/b.mjs','src/a.js','src/.hidden.mjs','node_modules/lib.mjs','.git/config.mjs','.tmp/output.mjs'])await writeWorkspace(store,bot.id,file,'fixture');
  await fs.symlink(directory,path.join(root,'outside'));
  await fs.symlink(path.join(directory,'state.json'),path.join(root,'linked.mjs'));
  assert.deepEqual((await execute('workspace_glob',{pattern:'**/*.mjs'})).files,['root.mjs','src/a.mjs','src/nested/b.mjs']);
  assert.deepEqual((await execute('workspace_glob',{pattern:'src/?.mjs',path:'src'})).files,['src/a.mjs']);
  assert.ok((await execute('workspace_glob',{pattern:'**/*.mjs',includeHidden:true})).files.includes('src/.hidden.mjs'));
  const page=await execute('workspace_glob',{pattern:'**/*.mjs',limit:1});
  assert.equal(page.truncated,true);assert.equal(page.nextOffset,1);
  assert.deepEqual((await execute('workspace_glob',{pattern:'**/*.mjs',offset:page.nextOffset,limit:1})).files,['src/a.mjs']);
  assert.deepEqual((await tools.execute(store.state.bots[1],'workspace_glob',{pattern:'**/*'})).files,[]);
  for(const pattern of ['../*','/tmp/*','a/../../*','C:/*','src/**oops','[a-z]','a\\b'])await assert.rejects(execute('workspace_glob',{pattern}));
  await assert.rejects(execute('workspace_glob',{pattern:'**/*',path:'outside'}),/Symbolic links/);
  await assert.rejects(execute('workspace_glob',{pattern:'**/*',path:'../'}),/cannot leave/);
  await assert.rejects(execute('workspace_glob',{pattern:'**/*',limit:101}),/Result limit/);
  await assert.rejects(execute('workspace_glob',{pattern:'**/*',includeHidden:'true'}),/boolean/);
  await assert.rejects(tools.execute({...bot,tools:[]},'workspace_glob',{pattern:'**/*'}),/not enabled/);
});

test('literal workspace search returns useful lines, pages and context with explicit skips',async t=>{
  const {directory,store,bot,root,execute}=await fixture(t);
  await writeWorkspace(store,bot.id,'src/a.txt','before\nNeedle [a-z]+\nafter\nneedle [a-z]+\n');
  await writeWorkspace(store,bot.id,'src/b.txt',`${'x'.repeat(800)}Needle [a-z]+ tail`);
  await writeWorkspace(store,bot.id,'src/.hidden.txt','Needle [a-z]+');
  await writeWorkspace(store,bot.id,'binary.bin',Buffer.from([0,255,0]));
  await fs.writeFile(path.join(root,'oversized.txt'),'x'.repeat(1_000_001));
  await fs.symlink(directory,path.join(root,'outside'));
  const page=await execute('workspace_search',{query:'Needle [a-z]+',contextLines:1,limit:1});
  assert.equal(page.matches.length,1);assert.equal(page.matches[0].line,2);assert.equal(page.matches[0].column,1);
  assert.deepEqual(page.matches[0].context.map(line=>line.text),['before','Needle [a-z]+','after']);
  assert.equal(page.nextOffset,1);assert.equal(page.skippedFiles,2);
  const next=await execute('workspace_search',{query:'Needle [a-z]+',offset:page.nextOffset});
  assert.equal(next.matches[0].path,'src/b.txt');assert.equal(next.matches[0].column,801);assert.match(next.matches[0].text,/Needle \[a-z\]\+/);assert.equal(next.matches[0].lineTruncated,true);
  assert.equal((await execute('workspace_search',{query:'needle [a-z]+',caseSensitive:false,glob:'src/a.txt'})).matches.length,2);
  assert.equal((await execute('workspace_search',{query:'Needle [a-z]+',includeHidden:true})).matches.length,3);
  await assert.rejects(execute('workspace_search',{query:'a\nb'}),/single-line/);
  await assert.rejects(execute('workspace_search',{query:'x',path:'outside'}),/Symbolic links/);
  await assert.rejects(execute('workspace_search',{query:'x',contextLines:3}),/Context lines/);
  await assert.rejects(execute('workspace_search',{query:'x',regex:true}),/unknown arguments/);
});

test('paged text reads return full-file revisions and resume long lines without dropping text',async t=>{
  const {store,bot,execute}=await fixture(t),content=`${'a'.repeat(12001)}\nsecond\r\nthird\n`;
  await writeWorkspace(store,bot.id,'long.txt',content);
  const first=await execute('workspace_read',{path:'long.txt'});
  assert.equal(first.content.length,12000);assert.equal(first.nextOffset,1);assert.equal(first.nextColumn,12001);
  assert.equal(first.sha256,createHash('sha256').update(content).digest('hex'));
  const second=await execute('workspace_read',{path:'long.txt',offset:first.nextOffset,column:first.nextColumn});
  assert.equal(first.content+second.content,content);assert.equal(second.nextOffset,null);assert.equal(second.truncated,false);
  const lines=await execute('workspace_read',{path:'long.txt',offset:2,limit:1});assert.equal(lines.content,'second\r');assert.equal(lines.nextOffset,3);assert.equal(lines.nextColumn,1);
  await assert.rejects(execute('workspace_read',{path:'long.txt',offset:0}),/Line offset/);
  await assert.rejects(execute('workspace_read',{path:'long.txt',offset:20}),/file length/);
  await assert.rejects(execute('workspace_read',{path:'long.txt',offset:2,column:999}),/Column/);
  await writeWorkspace(store,bot.id,'binary.txt',Buffer.from([0,1,2]));await assert.rejects(execute('workspace_read',{path:'binary.txt'}),/binary/);
});

test('exact edits enforce current content, uniqueness, policy and private tool access',async t=>{
  const {store,bot,tools,execute}=await fixture(t),content='\ufefffirst\r\nrepeat\r\nrepeat\r\n';
  await writeWorkspace(store,bot.id,'code.txt',content);
  const read=await execute('workspace_read',{path:'code.txt'}),args={path:'code.txt',oldText:'first',newText:'changed',expectedSha256:read.sha256};
  await assert.rejects(tools.execute({...bot,approvalPolicy:'strict'},'workspace_edit',args),/approval/);
  await assert.rejects(tools.execute({...bot,tools:[]},'workspace_edit',args,{approved:true}),/not enabled/);
  await assert.rejects(execute('workspace_edit',{...args,expectedSha256:'0'.repeat(64)}),/changed since/);
  await assert.rejects(execute('workspace_edit',{...args,oldText:'repeat'}),/more than once/);
  await assert.rejects(execute('workspace_edit',{...args,oldText:'missing'}),/not found/);
  await assert.rejects(execute('workspace_edit',{...args,oldText:''}),/Old text/);
  await assert.rejects(execute('workspace_edit',{...args,newText:'\0'}),/binary NUL/);
  const edited=await tools.execute({...bot,approvalPolicy:'strict'},'workspace_edit',args,{approved:true});
  assert.equal(edited.replacements,1);assert.equal((await readWorkspace(store,bot.id,'code.txt')).content,content.replace('first','changed').replace(/^\ufeff/,''));
  const bytes=await fs.readFile(path.join(await getWorkspaceRoot(store,bot.id),'code.txt'),'utf8');assert.equal(bytes,content.replace('first','changed'));
  await assert.rejects(execute('workspace_edit',args),/changed since/);
  const replaced=await execute('workspace_edit',{path:'code.txt',oldText:'repeat',newText:'',expectedSha256:edited.sha256,replaceAll:true});
  assert.equal(replaced.replacements,2);assert.match((await readWorkspace(store,bot.id,'code.txt')).content,/changed\r\n\r\n\r\n/);
  const root=await getWorkspaceRoot(store,bot.id);assert.equal((await fs.readdir(root)).some(name=>name.startsWith('.studio-')),false);
});

test('concurrent exact edits serialize and reject the stale competing change',async t=>{
  const {store,bot,execute}=await fixture(t);await writeWorkspace(store,bot.id,'shared.txt','initial');
  const read=await execute('workspace_read',{path:'shared.txt'});
  const results=await Promise.allSettled(['first','second'].map(newText=>execute('workspace_edit',{path:'shared.txt',oldText:'initial',newText,expectedSha256:read.sha256})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const failure=results.find(result=>result.status==='rejected');assert.equal(failure.reason.status,409);
  assert.equal((await readWorkspace(store,bot.id,'shared.txt')).content,['first','second'][results.findIndex(result=>result.status==='fulfilled')]);
});

test('search byte budget includes binary files and pagination can advance beyond 4000 matching lines',async t=>{
  const {store,bot,root,execute}=await fixture(t);
  await fs.mkdir(path.join(root,'binary'));
  for(let index=0;index<10;index++)await fs.writeFile(path.join(root,'binary',`${index}.bin`),Buffer.alloc(900000));
  const binary=await execute('workspace_search',{query:'absent',path:'binary'});
  assert.equal(binary.matches.length,0);assert.equal(binary.scanTruncated,true);assert.equal(binary.skippedFiles,8);assert.equal(binary.scannedBytes,7200000);assert.ok(binary.scannedBytes<=binary.limits.totalBytes);
  await writeWorkspace(store,bot.id,'lines.txt','match\n'.repeat(4050));
  const page=await execute('workspace_search',{query:'match',glob:'lines.txt',offset:4001,limit:1});assert.equal(page.matches[0].line,4002);assert.equal(page.nextOffset,4002);
});

test('discovery exposes incomplete traversal and cancellation without reading special files',async t=>{
  const {root,execute}=await fixture(t);await fs.mkdir(path.join(root,'many'));
  await Promise.all(Array.from({length:4001},(_,index)=>fs.writeFile(path.join(root,'many',`file-${index}.txt`),'')));
  const found=await execute('workspace_glob',{pattern:'**/*',path:'many',limit:100});assert.equal(found.scanTruncated,true);assert.equal(found.truncated,true);assert.ok(found.scannedEntries<=4001);
  const controller=new AbortController();controller.abort(new Error('Cancelled fixture'));
  await assert.rejects(execute('workspace_glob',{pattern:'**/*'},{signal:controller.signal}),/Cancelled fixture/);
  await assert.rejects(execute('workspace_search',{query:'x'},{signal:controller.signal}),/Cancelled fixture/);
});
