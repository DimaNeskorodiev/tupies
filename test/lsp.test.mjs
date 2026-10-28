import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { Store } from '../lib/store.mjs';
import { getWorkspaceRoot,writeWorkspace } from '../lib/agent-tools.mjs';
import { LanguageServers } from '../lib/lsp.mjs';

const serverFile=fileURLToPath(new URL('./fixtures/lsp-server.mjs',import.meta.url));
async function fixture(t,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-lsp-')),store=await new Store(directory).init(),owner={botId:'bot_atlas',runId:'run_lsp_fixture'};
  await store.mutate(state=>{state.runs.bot_atlas={id:owner.runId,status:'running'};});
  const root=await getWorkspaceRoot(store,owner.botId),servers=new LanguageServers(store,{requestTimeoutMs:3000,diagnosticsWaitMs:100,...options});
  t.after(async()=>{await servers.close();await fs.rm(directory,{recursive:true,force:true});});
  const start=async(mode='normal',more={})=>servers.start({...owner,server:'custom',executable:process.execPath,args:[serverFile,mode],...more});
  const query=(sessionId,operation,more={},options={})=>servers.query({...owner,sessionId,path:'main.ts',operation,...more},options);
  await writeWorkspace(store,owner.botId,'main.ts','broken fixture text');
  return {directory,store,owner,root,servers,start,query};
}

test('LSP exchanges fragmented standard frames, normalizes locations and resynchronizes changed files',async t=>{
  const {store,owner,servers,start,query}=await fixture(t),session=await start('fragmented');
  assert.equal(session.status,'ready');assert.equal(session.capabilities.definition,true);
  const definition=await query(session.id,'definition',{line:1,character:1});assert.equal(definition.locations[0].path,'main.ts');assert.deepEqual(definition.locations[0].range.start,{line:1,character:1});
  const diagnostic=await query(session.id,'diagnostics');assert.equal(diagnostic.received,true);assert.equal(diagnostic.version,1);assert.match(diagnostic.diagnostics[0].message,/Broken/);
  await writeWorkspace(store,owner.botId,'main.ts','fixed new contents');
  const hover=await query(session.id,'hover');assert.match(hover.content,/fixed new contents/);assert.match(hover.content,/🔍/);
  const fixed=await query(session.id,'diagnostics');assert.equal(fixed.version,2);assert.deepEqual(fixed.diagnostics,[]);
  const symbols=await query(session.id,'document_symbols');assert.deepEqual(symbols.symbols.map(item=>item.name),['outer','nested']);
  const workspace=await query(session.id,'workspace_symbols',{query:'outer'});assert.equal(workspace.symbols[0].path,'main.ts');
  await writeWorkspace(store,owner.botId,'main.ts','updated before workspace symbols');
  const freshSymbols=await query(session.id,'workspace_symbols',{query:'__contents__'});assert.equal(freshSymbols.symbols[0].name,'updated before workspace symbols');
  assert.equal((await query(session.id,'implementation')).locations[0].path,'main.ts');
  assert.equal((await query(session.id,'type_definition')).locations[0].path,'main.ts');
  await servers.closeRun(owner.runId);assert.equal(store.state.runs.bot_atlas.languageServers[0].status,'stopped');assert.equal(servers.sessions.size,0);
});

test('call hierarchy uses private session handles, roundtrips opaque server data and refuses stale items',async t=>{
  const {store,owner,start,query}=await fixture(t),session=await start(),prepared=await query(session.id,'prepare_call_hierarchy');
  assert.equal(prepared.items[0].name,'caller');assert.equal(prepared.items[0].path,'main.ts');assert.equal(prepared.items[0].data,undefined);
  const incoming=await query(session.id,'incoming_calls',{itemId:prepared.items[0].itemId});assert.equal(incoming.items[0].item.name,'opaque roundtrip succeeded');assert.equal(incoming.items[0].fromRanges[0].start.line,1);
  const outgoing=await query(session.id,'outgoing_calls',{itemId:prepared.items[0].itemId});assert.equal(outgoing.items[0].item.path,'main.ts');
  await assert.rejects(query(session.id,'incoming_calls',{itemId:'invented-item'}),/unavailable or expired/);
  await writeWorkspace(store,owner.botId,'main.ts','updated hierarchy source');
  await assert.rejects(query(session.id,'outgoing_calls',{itemId:prepared.items[0].itemId}),/file changed/);
  const wide=await start('wide-hierarchy'),widePrepared=await query(wide.id,'prepare_call_hierarchy'),manyCalls=await query(wide.id,'incoming_calls',{itemId:widePrepared.items[0].itemId});
  assert.equal(manyCalls.truncated,true);assert.equal(manyCalls.items[0].rangesTruncated,true);assert.equal(manyCalls.items[0].fromRanges.length,20);
});

test('LSP owner and private-root checks block cross-run files, symlinks, and server-originated edits',async t=>{
  const {root,store,owner,servers,start,query}=await fixture(t);await writeWorkspace(store,owner.botId,'victim.txt','unchanged');
  await fs.symlink(path.join(root,'victim.txt'),path.join(root,'linked.txt'));
  const session=await start('malicious');
  const definition=await query(session.id,'definition');assert.equal(definition.blockedLocations,2);assert.deepEqual(definition.locations.map(item=>item.path),['main.ts']);
  const hover=await query(session.id,'hover');assert.match(hover.content,/applied:false/);assert.doesNotMatch(hover.content,/file:\/\/|\/etc\/passwd/);
  assert.equal(await fs.readFile(path.join(root,'victim.txt'),'utf8'),'unchanged');
  await assert.rejects(servers.query({...owner,runId:'run_other',sessionId:session.id,path:'main.ts',operation:'hover'}),/active task/);
  await assert.rejects(query(session.id,'hover',{path:'../state.json'}),/cannot leave/);
  await assert.rejects(query(session.id,'hover',{path:'linked.txt'}),/Symbolic links/);
  await fs.mkdir(path.join(root,'project'));await writeWorkspace(store,owner.botId,'project/file.ts','const n = 1;');
  const scoped=await start('normal',{rootPath:'project'});
  await assert.rejects(query(scoped.id,'hover'),/selected project root/);
});

test('LSP launch refuses symlinked private temporary storage',async t=>{
  const {directory,root,start}=await fixture(t);await fs.symlink(directory,path.join(root,'.tmp'));
  await assert.rejects(start(),/Symbolic links/);
});

test('LSP text clipping remains explicit for diagnostic messages and symbol names',async t=>{
  const {start,query}=await fixture(t),session=await start('wide-text');
  const report=await query(session.id,'diagnostics');assert.equal(report.diagnostics[0].message.length,4000);assert.equal(report.diagnostics[0].textTruncated,true);assert.equal(report.truncated,true);
  const symbols=await query(session.id,'document_symbols');assert.equal(symbols.symbols[0].name.length,240);assert.equal(symbols.symbols[0].textTruncated,true);assert.equal(symbols.truncated,true);
});

test('LSP closes deleted open dependencies and keeps other file queries usable',async t=>{
  const {start,query,store,owner,root}=await fixture(t),session=await start();await writeWorkspace(store,owner.botId,'other.ts','deleted source');
  await query(session.id,'hover',{path:'other.ts'});await fs.unlink(path.join(root,'other.ts'));
  const next=await query(session.id,'hover');assert.deepEqual(next.closedDocuments,['other.ts']);assert.match(next.content,/closed:1/);
  await assert.rejects(query(session.id,'hover',{path:'other.ts'}),/not found/);
});

test('LSP unknown capabilities and absent diagnostic reports are explicit, not invented success',async t=>{
  const {start,query}=await fixture(t),empty=await start('empty');
  assert.equal(empty.capabilities.hover,false);await assert.rejects(query(empty.id,'hover'),/does not advertise hover/);
  const silent=await start('no-diagnostics'),result=await query(silent.id,'diagnostics');
  assert.equal(result.received,false);assert.equal(result.versioned,false);assert.match(result.notice,/does not prove/);
});

test('LSP requests time out or cancel without orphaning the active server',async t=>{
  const {start,query,servers}=await fixture(t,{requestTimeoutMs:500}),session=await start('timeout');
  await assert.rejects(query(session.id,'hover'),/timed out/);
  const recovery=await query(session.id,'hover');assert.match(recovery.content,/cancelled:1/);assert.equal(servers.sessions.get(session.id).connection.pending.size,0);
  const second=await start('timeout'),controller=new AbortController(),request=query(second.id,'hover',{}, {signal:controller.signal});
  setTimeout(()=>controller.abort(new Error('fixture query cancelled')),30);await assert.rejects(request,/fixture query cancelled/);
  const after=await query(second.id,'hover');assert.match(after.content,/cancelled:1/);
});

test('malformed protocol or process failure closes sessions and never persists stderr secrets',async t=>{
  const {start,store,servers}=await fixture(t);
  await store.mutate(state=>state.connections.push({id:'fixture',type:'openai',secret:store.seal('fixture-private-token')}));
  await assert.rejects(start('bad-frame'),/frame exceeded/);
  await assert.rejects(start('exit-secret'),/exited/);
  assert.equal(servers.sessions.size,0);assert.doesNotMatch(JSON.stringify(store.state.runs),/fixture-private-token/);
  assert.ok(store.state.runs.bot_atlas.languageServers.every(session=>session.status==='failed'));
});

test('LSP recovery marks persisted sessions interrupted and never launches historical processes',async t=>{
  const {store,servers}=await fixture(t);
  await store.mutate(state=>{state.runs.bot_atlas.languageServers=[{id:'lsp_historical',status:'ready',server:'custom'}];});
  await servers.recover();assert.equal(servers.sessions.size,0);assert.equal(store.state.runs.bot_atlas.languageServers[0].status,'interrupted');
});

test('LSP startup admission is bounded and a closing run cannot launch a late server',async t=>{
  const {start,servers,owner}=await fixture(t),first=start(),second=start();
  await assert.rejects(start(),/two language-server sessions/);await Promise.all([first,second]);
  await servers.closeRun(owner.runId);assert.equal(servers.sessions.size,0);await assert.rejects(start(),/already closed/);
  const another=await fixture(t),pending=another.start();pending.catch(()=>{});await another.servers.closeRun(another.owner.runId);
  await assert.rejects(pending,/closed/);assert.equal(another.servers.sessions.size,0);assert.equal(another.servers.starting.size,0);
});

test('LSP guardian terminates its owned server after the Tupies host crashes', {skip:process.platform==='win32'}, async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-lsp-crash-'));
  const host=fork(fileURLToPath(new URL('./fixtures/lsp-host.mjs',import.meta.url)),[directory],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
  t.after(async()=>{try{host.kill('SIGKILL');}catch{}await fs.rm(directory,{recursive:true,force:true});});
  const target=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('LSP host fixture did not initialize.')),5000);host.once('message',message=>{clearTimeout(timer);resolve(message.pid);});host.once('error',reject);host.once('exit',code=>{clearTimeout(timer);reject(new Error(`LSP host fixture exited: ${code}`));});});
  assert.ok(Number.isInteger(target));host.kill('SIGKILL');
  let alive=true;const until=Date.now()+4000;
  while(Date.now()<until){try{process.kill(target,0);}catch{alive=false;break;}await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(alive,false,'An owned language server survived its crashed host.');
});

test('bundled TypeScript LSP provides real navigation and fresh diagnostics without workspace compiler/plugin execution',async t=>{
  const {store,owner,servers,query,root}=await fixture(t,{requestTimeoutMs:15000,diagnosticsWaitMs:8000});
  await writeWorkspace(store,owner.botId,'tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2022',strict:true,noEmit:true,plugins:[{name:'fixture-untrusted-plugin'}]}}));
  await writeWorkspace(store,owner.botId,'node_modules/fixture-untrusted-plugin/package.json',JSON.stringify({name:'fixture-untrusted-plugin',version:'1.0.0',main:'index.js'}));
  await writeWorkspace(store,owner.botId,'node_modules/fixture-untrusted-plugin/index.js',"require('node:fs').writeFileSync('plugin-executed.txt','must not run');module.exports=()=>({create:info=>info.languageService});");
  await writeWorkspace(store,owner.botId,'node_modules/typescript/package.json',JSON.stringify({name:'typescript',version:'6.0.3'}));
  await writeWorkspace(store,owner.botId,'node_modules/typescript/lib/tsserver.js',"require('node:fs').writeFileSync('compiler-executed.txt','must not run');process.exit(1);");
  const source="export function double(value: number): number { return value * 2; }\nconst wrong: string = 42;\nconst result = double(2);\n";
  await writeWorkspace(store,owner.botId,'main.ts',source);
  const session=await servers.start({...owner,server:'typescript'});
  const definition=await query(session.id,'definition',{line:3,character:16});assert.ok(definition.locations.some(item=>item.path==='main.ts' && item.range.start.line===1));
  const references=await query(session.id,'references',{line:1,character:17,includeDeclaration:true});assert.ok(references.locations.length>=2);
  const hover=await query(session.id,'hover',{line:3,character:16});assert.match(hover.content,/double.*number/s);
  const symbols=await query(session.id,'document_symbols');assert.ok(symbols.symbols.some(item=>item.name==='double'));
  const diagnostics=await query(session.id,'diagnostics');assert.equal(diagnostics.received,true);assert.ok(diagnostics.diagnostics.some(item=>String(item.code)==='2322'));
  await writeWorkspace(store,owner.botId,'main.ts',source.replace('const wrong: string = 42;','const wrong: string = "fixed";'));
  const fixed=await query(session.id,'diagnostics');assert.equal(fixed.received,true);assert.ok(!fixed.diagnostics.some(item=>String(item.code)==='2322'));
  const navigation='export interface Counter { count(): number; }\nexport class LiveCounter implements Counter { count(): number { return 1; } }\nexport function readCounter(counter: Counter): number { return counter.count(); }\nconst counter = new LiveCounter();\nreadCounter(counter);\n';
  await writeWorkspace(store,owner.botId,'nav.ts',navigation);
  const implementations=await query(session.id,'implementation',{path:'nav.ts',line:1,character:18});assert.ok(implementations.locations.some(item=>item.path==='nav.ts' && item.range.start.line===2));
  const type=await query(session.id,'type_definition',{path:'nav.ts',line:4,character:7});assert.ok(type.locations.some(item=>item.path==='nav.ts' && item.range.start.line===2));
  const prepared=await query(session.id,'prepare_call_hierarchy',{path:'nav.ts',line:3,character:17});assert.ok(prepared.items.some(item=>item.name==='readCounter'));
  const itemId=prepared.items.find(item=>item.name==='readCounter').itemId;
  const incoming=await query(session.id,'incoming_calls',{itemId});assert.ok(incoming.items.some(item=>item.item.path==='nav.ts'));
  const outgoing=await query(session.id,'outgoing_calls',{itemId});assert.ok(outgoing.items.some(item=>item.item.path==='nav.ts'));
  await assert.rejects(fs.access(path.join(root,'plugin-executed.txt')));await assert.rejects(fs.access(path.join(root,'compiler-executed.txt')));
});
