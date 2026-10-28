import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { AgentTools, getWorkspaceRoot, writeWorkspace, validateAttachments, MAX_DOCUMENT_BYTES } from '../lib/agent-tools.mjs';
import { createStudioServer } from '../server.mjs';

const call=(name,args,id=name)=>({id,name,arguments:args});
const answer=text=>({text,toolCalls:[]});
async function until(read,timeout=8000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Document pipeline fixture timed out.');}
async function engineFixture(t,complete=()=>answer('Ready.')){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-document-pipeline-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Offline fixture',model:'fixture-model'});for(const bot of state.bots){bot.connectionId='fixture-provider';bot.approvalPolicy='balanced';bot.tools=['workspace'];}});
  const engine=new NativeEngine(store,{runTimeout:15000,providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length,connection);}}});await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,store,engine,requests};
}
async function settled(engine,run){const task=engine.tasks.get(run.id);if(task)await task;}
const decision=run=>({runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation});

async function apiFixture(t,complete=()=>answer('The documents are available.')){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-document-api-')),requests=[];
  const providers={catalog:()=>[],async complete(connection,request){requests.push(request);return complete(request,requests.length);},async close(){}};
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers,runTimeout:15000});
  await app.store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Offline fixture'});for(const bot of state.bots)bot.connectionId='fixture-provider';});
  const {url}=await app.listen(0);let cookie='',csrf='';
  async function request(route,{method='GET',data,security=true,headers={}}={}){
    const response=await fetch(url+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...(security&&csrf?{'X-CSRF-Token':csrf}:{}),...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});
    const bytes=Buffer.from(await response.arrayBuffer());let body;try{body=JSON.parse(bytes.toString());}catch{body=bytes.toString();}return {status:response.status,body,bytes,response};
  }
  const setup=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'local-document-fixture-password'}});assert.equal(setup.status,201);cookie=setup.response.headers.get('set-cookie').split(';')[0];csrf=setup.body.csrf;
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  return {app,requests,request,directory};
}

test('attachment admission rejects escape paths, symlinks, duplicate files, unsupported formats and all size/count excess before history or inference',async t=>{
  const {store,engine,requests}=await engineFixture(t),root=await getWorkspaceRoot(store,'bot_atlas'),other=await getWorkspaceRoot(store,'bot_nova');
  await fs.writeFile(path.join(root,'source.txt'),'PRIVATE INPUT');await fs.writeFile(path.join(other,'secret.txt'),'OTHER BOT SECRET');await fs.symlink(path.join(other,'secret.txt'),path.join(root,'linked.txt'));await fs.symlink(other,path.join(root,'linked-folder'));
  await fs.writeFile(path.join(root,'bad.html'),'<script>bad()</script>');await fs.mkdir(path.join(root,'directory.txt'));await fs.link(path.join(root,'source.txt'),path.join(root,'hardlink.txt'));
  for(const name of ['large-a.txt','large-b.txt']){const handle=await fs.open(path.join(root,name),'w');await handle.truncate(10_000_001);await handle.close();}
  const handle=await fs.open(path.join(root,'oversize.txt'),'w');await handle.truncate(MAX_DOCUMENT_BYTES+1);await handle.close();
  const invalid=[
    [{path:'../bot_nova/secret.txt'}],[{path:path.join(other,'secret.txt')}],[{path:'linked.txt'}],[{path:'linked-folder/secret.txt'}],[{path:'bad.html'}],[{path:'directory.txt'}],[{path:'missing.txt'}],
    [{path:'source.txt'},{path:'source.txt'}],[{path:'source.txt'},{path:'hardlink.txt'}],[{path:'large-a.txt'},{path:'large-b.txt'}],[{path:'oversize.txt'}],Array.from({length:6},()=>({path:'source.txt'})),[{path:'source.txt',downloadUrl:'https://example.invalid'}]
  ];
  for(const attachments of invalid){await assert.rejects(engine.start('bot_atlas','Review.',{attachments}));assert.equal(store.state.messages.bot_atlas?.length||0,0);assert.equal(store.state.conversations.bot_atlas?.length||0,0);assert.equal(store.state.runs.bot_atlas,undefined);}
  assert.equal(requests.length,0);
});

test('multiple attachments keep their actual file identity and original user text while provider context lists private paths without pre-reading content',async t=>{
  const {store,engine,requests}=await engineFixture(t);await writeWorkspace(store,'bot_atlas','uploads/file_0123456789abcdef01-notes.txt','NEVER PRELOAD THIS CONTENT');await writeWorkspace(store,'bot_atlas','table.csv','a,b\n1,2');
  const userText='  Review the attached files.\n';
  const run=await engine.start('bot_atlas',userText,{attachments:[{path:'uploads/file_0123456789abcdef01-notes.txt',name:'pretend.pdf'},{path:'table.csv',name:'other.xlsx'}]});await settled(engine,run);
  const message=store.state.messages.bot_atlas.find(message=>message.role==='user');assert.equal(message.content,userText);assert.equal(message.attachments.length,2);
  assert.deepEqual(message.attachments.map(file=>[file.name,file.format,file.size]),[['notes.txt','txt',26],['table.csv','csv',7]]);
  for(const file of message.attachments){assert.ok(file.downloadUrl.startsWith('/api/bots/bot_atlas/files/download?path='));assert.ok(file.previewUrl.startsWith('/api/bots/bot_atlas/documents/preview?path='));assert.ok(file.mime);}
  const content=requests[0].messages.findLast(message=>message.role==='user').content;assert.ok(content.startsWith(userText));assert.match(content,/documents_read/);assert.match(content,/notes\.txt/);assert.ok(!content.includes('NEVER PRELOAD THIS CONTENT'));assert.ok(!content.includes('pretend.pdf'));
  assert.equal(store.state.messages.bot_nova?.length||0,0);
  const empty=await engine.start('bot_atlas','',{attachments:[{path:'table.csv'}]});await settled(engine,empty);assert.equal(store.state.messages.bot_atlas.find(message=>message.runId===empty.id&&message.role==='user').content,'');
});

test('real native document creation and same-turn reads automatically attach a verified file without a model-provided link',async t=>{
  const document={title:'Delivery review',content:'# Delivery review\n\nA real exported document.\n\n| Team | Done |\n| --- | --- |\n| Atlas | 7 |'};
  const {store,engine,requests}=await engineFixture(t,(_request,index)=>index===1?{text:'',toolCalls:[call('documents_create',{path:'reports/review.docx',document},'make-document')]}:index===2?{text:'',toolCalls:[call('documents_read',{path:'reports/review.docx',maxChars:4000},'read-document')]}:answer('The review is ready.'));
  const run=await engine.start('bot_atlas','Export and verify a Word document.');await settled(engine,run);
  const finalRun=store.state.runs.bot_atlas;assert.equal(finalRun.status,'completed',finalRun.error);assert.equal(requests.length,3);assert.ok(!finalRun.events.some(event=>event.type==='approval.request'));
  const readResult=JSON.parse(requests[2].messages.find(message=>message.tool_call_id==='read-document').content);assert.match(readResult.text,/real exported document/);
  const file=finalRun.artifacts[0],message=store.state.messages.bot_atlas.at(-1);assert.equal(finalRun.artifacts.length,1);assert.equal(file.path,'reports/review.docx');assert.equal(file.name,'review.docx');assert.equal(file.format,'docx');assert.match(file.mime,/wordprocessingml/);assert.ok(file.size>100);assert.deepEqual(message.attachments,[file]);assert.equal(message.content,'The review is ready.');
  const bytes=await fs.readFile(path.join(await getWorkspaceRoot(store,'bot_atlas'),file.path));assert.equal(bytes.subarray(0,2).toString(),'PK');assert.equal(bytes.length,file.size);assert.equal((await fs.stat(path.join(await getWorkspaceRoot(store,'bot_atlas'),file.path))).mode&0o777,0o600);
  await assert.rejects(validateAttachments(store,'bot_nova',[{path:file.path}]),/not found/);
});

test('strict exports show exact arguments before overwriting and denied or stale approval cannot change a file',async t=>{
  const args={path:'existing.txt',document:{title:'Approved title',content:'  EXACT NEW CONTENT\n'}};
  let stage=0;const {store,engine}=await engineFixture(t,request=>request.messages.at(-1).role==='user'?{text:'',toolCalls:[call('documents_create',args,`create-${++stage}`)]}:answer('The action was handled.'));
  await store.mutate(state=>{state.bots[0].approvalPolicy='strict';});await writeWorkspace(store,'bot_atlas','existing.txt','KEEP ORIGINAL');
  const root=await getWorkspaceRoot(store,'bot_atlas'),first=await engine.start('bot_atlas','Prepare a replacement.');await until(()=>store.state.runs.bot_atlas?.status==='waiting_for_approval');
  const prompt=store.state.runs.bot_atlas;assert.deepEqual(prompt.pending_controls[0].arguments,args);assert.equal(await fs.readFile(path.join(root,'existing.txt'),'utf8'),'KEEP ORIGINAL');
  const stale=decision(prompt);await engine.control('bot_atlas','approval',{...stale,choice:'deny'});await settled(engine,first);assert.equal(await fs.readFile(path.join(root,'existing.txt'),'utf8'),'KEEP ORIGINAL');assert.equal(store.state.runs.bot_atlas.artifacts.length,0);
  const next=await engine.start('bot_atlas','Replace it now.');await until(()=>store.state.runs.bot_atlas?.status==='waiting_for_approval');await assert.rejects(engine.control('bot_atlas','approval',{...stale,choice:'once'}),/older run/);
  await engine.control('bot_atlas','approval',{...decision(store.state.runs.bot_atlas),choice:'once'});await settled(engine,next);assert.equal(store.state.runs.bot_atlas.status,'completed',store.state.runs.bot_atlas.error);assert.match(await fs.readFile(path.join(root,'existing.txt'),'utf8'),/EXACT NEW CONTENT/);assert.equal(store.state.messages.bot_atlas.at(-1).attachments.length,1);
});

test('already created artifacts survive a stopped or failed response with explicit partial status, and restart does not duplicate them',async t=>{
  let later=false;const {store,engine,directory}=await engineFixture(t,async(request,index)=>{
    if(index===1)return {text:'',toolCalls:[call('documents_create',{path:'cancelled.txt',document:{content:'SAVED BEFORE STOP'}})]};
    later=true;return new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));
  });
  const run=await engine.start('bot_atlas','Export, then continue thinking.');await until(()=>later && store.state.runs.bot_atlas.artifacts.length===1);await engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});await settled(engine,run);
  const partial=store.state.messages.bot_atlas.at(-1);assert.equal(store.state.runs.bot_atlas.status,'cancelled');assert.equal(partial.partial,true);assert.equal(partial.runStatus,'cancelled');assert.equal(partial.content,'');assert.equal(partial.attachments[0].path,'cancelled.txt');assert.equal(store.state.runs.bot_atlas.events.some(event=>event.type==='run.completed'),false);
  await engine.recover();await engine.recover();assert.equal(store.state.messages.bot_atlas.filter(message=>message.runId===run.id&&message.partial).length,1);
  const restored=await new Store(directory).init();assert.equal(restored.state.messages.bot_atlas.at(-1).attachments[0].path,'cancelled.txt');
  const failed=await engineFixture(t,(_request,index)=>index===1?{text:'',toolCalls:[call('documents_create',{path:'partial.md',document:{content:'A useful draft'}})]}:{text:'Only a partial review.',toolCalls:[],finishReason:'length'});
  const failedRun=await failed.engine.start('bot_atlas','Export and fully review.');await settled(failed.engine,failedRun);const failure=failed.store.state.messages.bot_atlas.at(-1);assert.equal(failed.store.state.runs.bot_atlas.status,'failed');assert.equal(failure.runStatus,'failed');assert.equal(failure.partial,true);assert.equal(failure.attachments[0].path,'partial.md');
});

test('artifact links are reconstructed by the engine, overwrites deduplicate, and removed files are excluded from the final reply',async t=>{
  const {store,engine}=await engineFixture(t,(_request,index)=>index===1?{text:'',toolCalls:[call('documents_create',{path:'real.txt',document:{content:'first'}},'first'),call('documents_create',{path:'real.txt',document:{content:'second longer version'}},'overwrite')]}:answer('Ready without a pasted link.'));
  const execute=engine.tools.execute.bind(engine.tools);engine.tools.execute=async(...args)=>{const result=await execute(...args);if(result?.artifact)Object.assign(result.artifact,{name:'fake.html',downloadUrl:'https://untrusted.invalid/file',previewUrl:'javascript:bad()'});return result;};
  const run=await engine.start('bot_atlas','Create a file and update it.');await settled(engine,run);const artifact=store.state.runs.bot_atlas.artifacts[0];assert.equal(store.state.runs.bot_atlas.artifacts.length,1);assert.equal(artifact.name,'real.txt');assert.ok(artifact.downloadUrl.startsWith('/api/bots/bot_atlas/'));assert.ok(artifact.previewUrl.startsWith('/api/bots/bot_atlas/'));assert.equal(artifact.size,(await fs.stat(path.join(await getWorkspaceRoot(store,'bot_atlas'),'real.txt'))).size);assert.match(await fs.readFile(path.join(await getWorkspaceRoot(store,'bot_atlas'),'real.txt'),'utf8'),/second longer version/);
  const removed=await engineFixture(t,(_request,index)=>index===1?{text:'',toolCalls:[call('documents_create',{path:'removed.txt',document:{content:'temporary'}},'create')]}:index===2?{text:'',toolCalls:[call('workspace_delete',{path:'removed.txt'},'remove')]}:answer('The temporary document was removed.'));
  const deleted=await removed.engine.start('bot_atlas','Create then remove.');await until(()=>removed.store.state.runs.bot_atlas.status==='waiting_for_approval');await removed.engine.control('bot_atlas','approval',{...decision(removed.store.state.runs.bot_atlas),choice:'once'});await settled(removed.engine,deleted);assert.equal(removed.store.state.runs.bot_atlas.artifacts.length,0);assert.equal(removed.store.state.messages.bot_atlas.at(-1).attachments,undefined);
});

test('cancellation immediately after atomic export still records the committed artifact',async t=>{
  const {store,engine,requests}=await engineFixture(t,()=>({text:'',toolCalls:[call('documents_create',{path:'committed.txt',document:{content:'Committed exactly once'}})]}));
  const execute=engine.tools.execute.bind(engine.tools);engine.tools.execute=async(...args)=>{
    const result=await execute(...args);
    if(args[1]==='documents_create')engine.controllers.get(store.state.runs.bot_atlas.id).abort(Object.assign(new Error('Stopped after commit.'),{name:'AbortError'}));
    return result;
  };
  const run=await engine.start('bot_atlas','Export a file.');await settled(engine,run);
  assert.equal(requests.length,1);assert.equal(store.state.runs.bot_atlas.status,'cancelled');assert.equal(store.state.runs.bot_atlas.artifacts[0].path,'committed.txt');
  const message=store.state.messages.bot_atlas.at(-1);assert.equal(message.partial,true);assert.equal(message.runStatus,'cancelled');assert.equal(message.attachments[0].path,'committed.txt');
  assert.match(await fs.readFile(path.join(await getWorkspaceRoot(store,'bot_atlas'),'committed.txt'),'utf8'),/Committed exactly once/);
});

test('document tools share workspace permissions and reject malformed and oversized requests',async t=>{
  const {store}=await engineFixture(t),tools=new AgentTools(store),bot=store.state.bots[0];
  assert.ok(tools.definitions(bot).some(tool=>tool.name==='documents_read'));assert.ok(tools.definitions(bot).some(tool=>tool.name==='documents_create'));assert.equal(tools.requiresApproval('documents_create',bot),false);assert.equal(tools.requiresApproval('documents_create',{...bot,approvalPolicy:'strict'}),true);
  await assert.rejects(tools.execute({...bot,tools:[]},'documents_read',{path:'private.txt'}),/not enabled/);
  await assert.rejects(tools.execute({...bot,approvalPolicy:'strict'},'documents_create',{path:'private.txt',document:{content:'unapproved'}}),/requires approval/);
  await assert.rejects(tools.execute(bot,'documents_read',{path:'x.txt',maxChars:0}),/100–100000/);
  await assert.rejects(tools.execute(bot,'documents_create',{path:'x.txt',document:{content:'x'.repeat(160000)}}),/size limit/);
});

test('authenticated APIs preserve upload intent, enforce combined bounds and metadata identity, and serve safe previews and MIME types',async t=>{
  const f=await apiFixture(t),prefix='/api/bots/bot_atlas',files=[{name:'notes.txt',contentBase64:Buffer.from('PRIVATE CONTENT ONLY AFTER SEND').toString('base64')},{name:'table.csv',contentBase64:Buffer.from('a,b\n1,2').toString('base64')}];
  assert.equal((await f.request(prefix+'/attachments',{method:'POST',data:{files},security:false})).status,403);
  assert.equal((await f.request(prefix+'/attachments',{method:'POST',data:{files},headers:{Origin:'https://foreign.invalid'}})).status,403);
  const upload=await f.request(prefix+'/attachments',{method:'POST',data:{files}});assert.equal(upload.status,201,JSON.stringify(upload.body));assert.equal(f.requests.length,0);assert.equal(f.app.store.state.messages.bot_atlas?.length||0,0);
  const attachments=upload.body.files.map(file=>({path:file.path,name:'untrusted-other.pdf'}));assert.equal((await f.request(prefix+'/messages',{method:'POST',data:{text:'Review these.',attachments:[attachments[0],attachments[0]]}})).status,400);assert.equal(f.app.store.state.messages.bot_atlas?.length||0,0);
  const sent=await f.request(prefix+'/messages',{method:'POST',data:{text:'',attachments}});assert.equal(sent.status,202,JSON.stringify(sent.body));await settled(f.app.runtime,sent.body.run);assert.equal(f.app.store.state.messages.bot_atlas[0].attachments[0].name,'notes.txt');
  const preview=await f.request(prefix+'/documents/preview?path='+encodeURIComponent(attachments[0].path));assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.preview.kind,'text');assert.match(preview.body.text,/PRIVATE CONTENT/);
  const download=await f.request(prefix+'/files/download?path='+encodeURIComponent(attachments[0].path));assert.match(download.response.headers.get('content-type'),/^text\/plain/);assert.match(download.response.headers.get('content-disposition'),/attachment; filename="notes.txt"/);assert.equal(download.body,'PRIVATE CONTENT ONLY AFTER SEND');
  await writeWorkspace(f.app.store,'bot_atlas','unsafe.svg',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>'));const dangerous=await f.request(prefix+'/files/view?path=unsafe.svg');assert.equal(dangerous.status,200);assert.match(dangerous.response.headers.get('content-disposition'),/^attachment/);assert.equal(dangerous.response.headers.get('content-type'),'application/octet-stream');assert.equal((await f.request(prefix+'/documents/preview?path=unsafe.svg')).status,415);
  await writeWorkspace(f.app.store,'bot_atlas','sample.pdf',Buffer.from('%PDF-1.4\nfixture'));const pdf=await f.request(prefix+'/files/view?path=sample.pdf');assert.equal(pdf.response.headers.get('content-type'),'application/pdf');assert.match(pdf.response.headers.get('content-disposition'),/^inline/);
  await writeWorkspace(f.app.store,'bot_atlas','pixel.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XuAAAAAASUVORK5CYII=','base64'));const image=await f.request(prefix+'/documents/preview?path=pixel.png');assert.equal(image.body.preview.kind,'image');assert.match(image.body.warnings[0],/OCR/);assert.equal((await f.request(prefix+'/files/view?path=pixel.png')).response.headers.get('content-type'),'image/png');
  assert.equal((await f.request('/api/bots/bot_nova/files/download?path='+encodeURIComponent(attachments[0].path))).status,404);assert.equal((await f.request(prefix+'/files/download?path=../bot_nova/private.txt')).status,400);
  const count=await f.request(prefix+'/attachments',{method:'POST',data:{files:Array.from({length:6},()=>files[0])}});assert.equal(count.status,400);
  const large=Buffer.alloc(10_000_001,97).toString('base64'),over=await f.request(prefix+'/attachments',{method:'POST',data:{files:[{name:'a.txt',contentBase64:large},{name:'b.txt',contentBase64:large}]}});assert.equal(over.status,413);assert.match(over.body.error,/combined 20 MB/);
  const five=await f.request(prefix+'/attachments',{method:'POST',data:{files:Array.from({length:5},(_,i)=>({name:`item-${i}.txt`,contentBase64:Buffer.from('ok').toString('base64')}))}});assert.equal(five.status,201);
  const cap=(await f.request('/api/capabilities')).body;assert.equal(cap.version,JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version);assert.equal(cap.documents.maxBytes,20_000_000);assert.equal(cap.documents.maxAttachments,5);assert.equal(cap.documents.imageVision,false);
  assert.equal(download.response.headers.get('permissions-policy'),'camera=(), microphone=(self), geolocation=()');assert.match(download.response.headers.get('content-security-policy'),/worker-src 'self' blob:/);assert.match(download.response.headers.get('content-security-policy'),/script-src 'self';/);
});
