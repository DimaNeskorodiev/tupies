import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStudioServer } from '../server.mjs';

const KEY='studio-model-fixture-key-never-public';
const answer=text=>({id:'response-fixture',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:10,output_tokens:5}});
const call=(name,args,id='call-fixture')=>({id:'response-tools',status:'completed',output:[{type:'function_call',call_id:id,name,arguments:JSON.stringify(args)}],usage:{input_tokens:10,output_tokens:3}});
async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-native-api-'));
  const remote={requests:[],handler:()=>answer('A real fixture model response.'),malformed:false,modelResponse:{data:[{id:'fixture-model',name:'Fixture model'}]},modelStatus:200,beforeModels:null};
  const provider=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const input=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
    remote.requests.push({url:req.url,method:req.method,input,headers:req.headers});
    res.setHeader('content-type','application/json');
    if(req.headers.authorization!==`Bearer ${KEY}`){res.writeHead(401);res.end(JSON.stringify({error:{message:'Unauthorized'}}));return;}
    if(req.url==='/v1/models'){if(remote.beforeModels)await remote.beforeModels();res.writeHead(remote.modelStatus);res.end(JSON.stringify(remote.modelResponse));return;}
    if(req.url==='/v1/responses'&&req.method==='POST'){
      if(remote.malformed){res.end('invalid json');return;}
      try{const result=await remote.handler(input,remote);res.end(JSON.stringify(result));}catch(error){res.writeHead(500);res.end(JSON.stringify({error:{message:error.message}}));}return;
    }
    res.writeHead(404);res.end(JSON.stringify({error:{message:'Not found'}}));
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,requestTimeout:2000,runTimeout:5000,...options});
  const {url}=await app.listen(0);let cookie='',csrf='';
  async function request(route,{method='GET',data,headers={},security=true}={}){
    const response=await fetch(`${url}${route}`,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...(security&&csrf?{'X-CSRF-Token':csrf}:{}),...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});
    const text=await response.text();let result;try{result=JSON.parse(text);}catch{result=text;}return {status:response.status,body:result,response};
  }
  async function setup(){const result=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'fixture-workspace-password'}});assert.equal(result.status,201);cookie=result.response.headers.get('set-cookie').split(';')[0];csrf=result.body.csrf;return result;}
  async function connect(){const result=await request('/api/connections',{method:'POST',data:{name:'Direct fixture provider',type:'openai',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:KEY,defaultModel:'fixture-model'}});assert.equal(result.status,201,JSON.stringify(result.body));return result.body;}
  async function wait(botId='bot_atlas',predicate=run=>['completed','failed','cancelled','interrupted'].includes(run?.status)){
    const deadline=Date.now()+4000;
    while(Date.now()<deadline){const run=app.store.state.runs[botId];if(predicate(run))return run;await new Promise(resolve=>setTimeout(resolve,5));}
    throw new Error(`Task did not reach expected state: ${JSON.stringify(app.store.state.runs[botId])}`);
  }
  t.after(async()=>{await app.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  return {app,remote,directory,url,request,setup,connect,wait,provider,get cookie(){return cookie;}};
}

test('bootstrap, sessions, CSRF, origin, and static paths protect the independent engine',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.request('/api/auth')).body,{setupRequired:true,authenticated:false,csrf:null,passwordSignIn:true});
  assert.equal((await f.request('/api/state')).status,401);
  assert.equal((await f.request('/api/setup',{method:'POST',data:{token:'é'.repeat(f.app.bootstrapToken.length),password:'long-fixture-password'}})).status,403);
  assert.equal((await f.request('/api/setup',{method:'POST',data:{token:f.app.bootstrapToken,password:'short'}})).status,400);
  assert.match((await f.setup()).response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const state=(await f.request('/api/state')).body;
  assert.equal(state.engine.independent,true);assert.equal(state.version,2);assert.equal(state.bots.length,3);
  assert.equal((await f.request('/api/bots',{method:'POST',data:{name:'No',title:'CSRF'},security:false})).status,403);
  assert.equal((await f.request('/api/bots',{method:'POST',data:{name:'No',title:'Origin'},headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await f.request('/data/state.json')).status,404);
  assert.equal((await f.request('/%2e%2e%2fdata%2fstate.json')).status,404);
  assert.equal((await f.request('/api/setup',{method:'POST',data:{token:f.app.bootstrapToken,password:'another-long-password'}})).status,409);
});

test('a new tab session rejects stale CSRF before mutation and only the matching token permits one change',async t=>{
  const f=await fixture(t),original=await f.setup(),oldCsrf=original.body.csrf;
  const login=await f.request('/api/login',{method:'POST',data:{password:'fixture-workspace-password'}});
  assert.equal(login.status,200);
  const newCookie=login.response.headers.get('set-cookie').split(';')[0],newCsrf=login.body.csrf;
  assert.notEqual(newCookie,f.cookie);assert.notEqual(newCsrf,oldCsrf);
  const before=structuredClone(f.app.store.state),data={name:'One accepted mutation',title:'Multi-tab regression'};

  const stale=await f.request('/api/bots',{method:'POST',data,headers:{Cookie:newCookie,'X-CSRF-Token':oldCsrf}});
  assert.equal(stale.status,403);assert.equal(stale.body.code,'csrf_mismatch');
  assert.deepEqual(f.app.store.state,before,'Stale-token rejection must happen before any route mutation.');

  const current=(await f.request('/api/auth',{headers:{Cookie:newCookie}})).body;
  assert.equal(current.authenticated,true);assert.equal(current.csrf,newCsrf);
  const accepted=await f.request('/api/bots',{method:'POST',data,headers:{Cookie:newCookie,'X-CSRF-Token':newCsrf}});
  assert.equal(accepted.status,201);
  assert.equal(f.app.store.state.bots.length,before.bots.length+1);
  assert.equal(f.app.store.state.bots.filter(bot=>bot.name===data.name).length,1);

  const after=structuredClone(f.app.store.state);
  const foreign=await f.request('/api/bots',{method:'POST',data:{name:'Foreign mutation',title:'Rejected origin'},headers:{Cookie:newCookie,'X-CSRF-Token':newCsrf,Origin:'https://foreign.example'}});
  assert.equal(foreign.status,403);assert.equal(foreign.body.code,undefined);
  assert.deepEqual(f.app.store.state,after,'An Origin failure must not be mistaken for a retryable CSRF mismatch.');
});

test('direct provider setup encrypts keys, lists models without inference, and serves no gateway routes',async t=>{
  const f=await fixture(t);await f.setup();const connection=await f.connect();
  assert.equal(connection.hasKey,true);assert.equal(connection.secret,undefined);
  const result=await f.request(`/api/connections/${connection.id}/test`,{method:'POST',data:{}});
  assert.equal(result.status,200);assert.equal(result.body.models[0].id,'fixture-model');
  assert.equal(f.remote.requests.filter(r=>r.url.endsWith('/responses')).length,0);
  assert.ok(!JSON.stringify((await f.request('/api/state')).body).includes(KEY));
  assert.ok(!(await fs.readFile(path.join(f.directory,'state.json'),'utf8')).includes(KEY));
  assert.equal((await fs.stat(path.join(f.directory,'vault.key'))).mode&0o777,0o600);
  assert.equal((await fs.stat(path.join(f.directory,'state.json'))).mode&0o777,0o600);
  assert.equal((await f.request('/api/connections',{method:'POST',data:{name:'Metadata',type:'openai',baseUrl:'http://169.254.169.254/v1',apiKey:KEY}})).status,400);
});

test('one provider serves separate native bot memories and workspace histories',async t=>{
  const f=await fixture(t);await f.setup();const connection=await f.connect();
  const state=(await f.request('/api/state')).body;
  assert.ok(state.bots.every(bot=>bot.connectionId===connection.id));
  const memory=await f.request('/api/bots/bot_atlas/memory',{method:'PUT',data:{key:'writing-style',value:'Use plain language.'}});assert.equal(memory.status,200);
  assert.equal((await f.request('/api/bots/bot_atlas/memory',{method:'PUT',data:{key:'writing-style',value:'Use plain language.',pinned:true}})).body.pinned,true);
  assert.equal((await f.request('/api/bots/bot_atlas/memory',{method:'PUT',data:{key:'writing-style',value:'Use plain, short language.'}})).body.pinned,true);
  assert.equal((await f.request('/api/bots/bot_atlas/memory',{method:'PUT',data:{key:'writing-style',value:'Use plain language.',pinned:'yes'}})).status,400);
  assert.equal((await f.request('/api/bots/bot_atlas/memory',{method:'PUT',data:{key:'writing-style',value:'Use plain language.',pinned:false}})).body.pinned,undefined);
  assert.equal((await f.request('/api/bots/bot_scout/memory')).body.entries.length,0);
  assert.equal((await f.request('/api/bots/bot_atlas/files',{method:'PUT',data:{path:'notes/hello.txt',content:'Atlas private file.'}})).status,200);
  assert.equal((await f.request('/api/bots/bot_atlas/files/content?path=notes/hello.txt')).body.content,'Atlas private file.');
  const exact='  indented text\n\n';await f.request('/api/bots/bot_atlas/files',{method:'PUT',data:{path:'notes/whitespace.txt',content:exact}});assert.equal((await f.request('/api/bots/bot_atlas/files/content?path=notes/whitespace.txt')).body.content,exact);
  assert.equal((await f.request('/api/bots/bot_scout/files/content?path=notes/hello.txt')).status,404);
  assert.equal((await f.request('/api/bots/bot_atlas/files/content?path=../state.json')).status,400);
  const upload=await f.request('/api/bots/bot_atlas/attachments',{method:'POST',data:{files:[{name:'binary.bin',contentBase64:Buffer.from([0,255,1]).toString('base64')}]}});assert.equal(upload.status,201);
  assert.equal(upload.body.files[0].size,3);
  const download=await fetch(`${f.url}/api/bots/bot_atlas/files/download?path=${encodeURIComponent(upload.body.files[0].path)}`,{headers:{Cookie:f.cookie}});assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from([0,255,1]));
  assert.equal((await f.request('/api/bots/bot_atlas/memory/'+memory.body.id,{method:'DELETE'})).status,200);
});

test('Tupies owns the actual model/tool loop and supplies memory, skills, and persistent continuation',async t=>{
  const f=await fixture(t);await f.setup();await f.connect();
  await f.request('/api/bots/bot_atlas',{method:'PATCH',data:{skills:['source-check']}});
  await f.request('/api/bots/bot_atlas/memory',{method:'PUT',data:{key:'preference',value:'Verify primary sources.'}});
  f.remote.handler=input=>input.input.some(item=>item.type==='function_call_output')?answer('The assigned skill was read.'):call('skills_read',{skillId:'source-check'});
  assert.equal((await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Read the assigned skill and report.'}})).status,202);
  const run=await f.wait();assert.equal(run.status,'completed',run.error);assert.equal(run.engine,'studio-native');
  const first=f.remote.requests.find(r=>r.url.endsWith('/responses')).input;
  assert.match(first.instructions,/Verify primary sources/);assert.ok(first.tools.some(tool=>tool.name==='skills_read'));
  assert.ok(f.remote.requests.some(r=>r.input?.input?.some(item=>item.type==='function_call_output'&&item.output.includes('source-check'))));
  assert.ok(run.events.some(event=>event.type==='tool.completed'));
  f.remote.handler=()=>answer('The earlier task is in my native history.');
  await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Continue from the earlier task.'}});await f.wait();
  const last=f.remote.requests.filter(r=>r.url.endsWith('/responses') && !r.input?.tools?.some(tool=>tool.name==='memory_review_result')).at(-1).input;
  assert.ok(last.input.some(item=>item.role==='user'&&item.content.includes('Read the assigned skill')));
  assert.equal((await f.request('/api/bots/bot_atlas/messages')).body.messages.filter(m=>m.role==='assistant').length,2);
});

test('exact native approvals prevent stale consent and stop cannot cancel a later task',async t=>{
  const f=await fixture(t);await f.setup();await f.connect();
  f.remote.handler=input=>input.input.some(item=>item.type==='function_call_output')?answer('Deletion was denied.'):call('workspace_delete',{path:'private.txt'});
  await f.request('/api/bots/bot_atlas/files',{method:'PUT',data:{path:'private.txt',content:'Preserve this.'}});
  await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Delete the private file.'}});
  const pending=await f.wait('bot_atlas',run=>run?.status==='waiting_for_approval');
  const identity={runId:pending.id,remoteRunId:pending.remoteRunId,request_id:pending.pending_controls[0].prompt_id,execution_generation:pending.execution_generation};
  assert.equal((await f.request('/api/bots/bot_atlas/approval',{method:'POST',data:{...identity,request_id:'stale',choice:'once'}})).status,409);
  assert.equal((await f.request('/api/bots/bot_atlas/approval',{method:'POST',data:{...identity,choice:'deny'}})).status,200);
  assert.equal((await f.wait()).status,'completed');
  assert.equal((await f.request('/api/bots/bot_atlas/files/content?path=private.txt')).body.content,'Preserve this.');
  f.remote.handler=()=>call('workspace_delete',{path:'private.txt'},'later-call');
  await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'New task with its own approval.'}});
  const later=await f.wait('bot_atlas',run=>run?.status==='waiting_for_approval');
  assert.equal((await f.request('/api/bots/bot_atlas/stop',{method:'POST',data:{runId:identity.runId,remoteRunId:identity.remoteRunId}})).status,409);
  assert.equal((await f.request('/api/bots/bot_atlas/stop',{method:'POST',data:{runId:later.id,remoteRunId:later.remoteRunId}})).status,200);
  assert.equal((await f.wait()).status,'cancelled');
});

test('autonomous room coordinator actually delegates to a specialist and brings back its result',async t=>{
  const f=await fixture(t);await f.setup();await f.connect();
  f.remote.handler=input=>{
    if(input.instructions.startsWith('You are Scout'))return answer('Scout verified the primary source.');
    if(input.input.some(item=>item.type==='function_call_output'))return answer('Atlas reviewed Scout’s verified result and completed the plan.');
    return call('delegate_task',{botId:'bot_scout',task:'Verify the source and report evidence.'});
  };
  const room=(await f.request('/api/rooms',{method:'POST',data:{name:'Autonomous team',botIds:['bot_atlas','bot_scout'],autoCollaborate:true,maxRounds:3}})).body;
  assert.equal((await f.request(`/api/rooms/${room.id}/messages`,{method:'POST',data:{text:'Research and produce a reviewed plan.'}})).status,202);
  await f.wait();await f.app.rooms.advance(room.id);
  const result=(await f.request(`/api/rooms/${room.id}/messages`)).body;
  assert.equal(result.drive.status,'completed',result.drive.error);
  assert.equal(result.messages.filter(m=>m.role==='assistant').length,2);
  assert.ok(result.messages.some(m=>m.botId==='bot_scout'&&m.content.includes('verified')));
  assert.ok(result.messages.some(m=>m.botId==='bot_atlas'&&m.content.includes('reviewed')));
  assert.equal(f.app.store.state.runs.bot_scout.source,'delegation');
});

test('scheduled routines execute through the same independent engine',async t=>{
  const f=await fixture(t);await f.setup();await f.connect();
  const created=await f.request('/api/routines',{method:'POST',data:{name:'Daily review',botId:'bot_atlas',prompt:'Review the available context.',intervalMinutes:1440,enabled:true}});assert.equal(created.status,201);
  const dispatched=await f.request(`/api/routines/${created.body.id}/run`,{method:'POST',data:{}});assert.equal(dispatched.status,202);
  assert.equal((await f.wait()).status,'completed');
  const routine=f.app.store.state.routines.find(r=>r.id===created.body.id);assert.ok(Date.parse(routine.nextRunAt)>Date.now());assert.ok(routine.lastRunId);
});

test('malformed provider acceptance never triggers an automatic repeated model request',async t=>{
  const f=await fixture(t);await f.setup();await f.connect();f.remote.malformed=true;
  await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Handle this once.'}});
  const run=await f.wait();assert.equal(run.status,'failed');assert.equal(f.remote.requests.filter(r=>r.url.endsWith('/responses')).length,1);
});

test('skill package API preserves resources and rejects traversal',async t=>{
  const f=await fixture(t);await f.setup();const content='---\nname: portable-api\ndescription: Portable resource skill.\n---\nRead references/data.txt.';
  const files=[{path:'SKILL.md',contentBase64:Buffer.from(content).toString('base64')},{path:'references/data.txt',contentBase64:Buffer.from('Evidence').toString('base64')}];
  assert.equal((await f.request('/api/skills',{method:'POST',data:{files}})).status,201);
  assert.deepEqual((await f.request('/api/skills/portable-api/export')).body.files,files);
  assert.equal((await f.request('/api/skills',{method:'POST',data:{files:[...files,{path:'../bad',contentBase64:'YQ=='}]}})).status,400);
});

test('legacy data migrates without adopting gateway keys as provider credentials',async t=>{
  const f=await fixture(t);await f.setup();
  await f.app.store.mutate(state=>{state.version=1;state.connections.push({id:'legacy',name:'Old gateway',baseUrl:'http://127.0.0.1:8642',secret:f.app.store.seal('old-gateway-key')});});
  const {Store}=await import('../lib/store.mjs');const migrated=await new Store(f.directory).init();
  assert.equal(migrated.state.version,2);assert.equal(migrated.state.connections[0].type,'legacy-hermes');assert.equal(migrated.state.connections[0].status,'migration_required');
  assert.ok((await fs.stat(path.join(f.directory,'state.v1-backup.json'))).isFile());
});

test('messaging channel setup is paused, sealed, explicitly allowlisted, and never exposed in browser state',async t=>{
  const f=await fixture(t);await f.setup();const token='123456789:abcdefghijklmnopqrstuvwxyz_123456';
  const created=await f.request('/api/channels',{method:'POST',data:{name:'Owner Telegram',type:'telegram',botId:'bot_atlas',token,enabled:false,allowedChatIds:[],allowedUserIds:[]}});
  assert.equal(created.status,201,JSON.stringify(created.body));assert.equal(created.body.secret,undefined);assert.equal(created.body.token,undefined);assert.equal(created.body.hasToken,true);
  assert.ok(!JSON.stringify((await f.request('/api/state')).body).includes(token));
  assert.equal((await f.request(`/api/channels/${created.body.id}`,{method:'PATCH',data:{enabled:true}})).status,400);
  assert.equal((await f.request(`/api/channels/${created.body.id}`,{method:'PATCH',data:{allowedChatIds:['123'],allowedUserIds:['456'],enabled:true}})).status,200);
  assert.equal((await f.request(`/api/channels/${created.body.id}`,{method:'PATCH',data:{enabled:false}})).status,200);
  assert.equal((await f.request(`/api/channels/${created.body.id}`,{method:'DELETE'})).status,200);
  assert.equal(f.app.store.state.channels.length,0);
});

test('channel edits keep the ingress cursor and admitted work that settle while its old poll is cancelled',async t=>{
  const f=await fixture(t);await f.setup();
  const created=(await f.request('/api/channels',{method:'POST',data:{name:'Pause safely',botId:'bot_atlas',token:'123456789:abcdefghijklmnopqrstuvwxyz_123456',enabled:false,allowedChatIds:['123'],allowedUserIds:['456']}})).body;
  f.app.channels.cancel=async()=>f.app.store.mutate(state=>{const channel=state.channels.find(c=>c.id===created.id);channel.offset=42;channel.pending={runId:'admitted-during-cancel',chatId:'123',userId:'456'};});
  assert.equal((await f.request(`/api/channels/${created.id}`,{method:'PATCH',data:{enabled:false}})).status,200);
  const saved=f.app.store.state.channels.find(c=>c.id===created.id);assert.equal(saved.offset,42);assert.equal(saved.pending.runId,'admitted-during-cancel');
  assert.equal((await f.request(`/api/channels/${created.id}`,{method:'DELETE'})).status,409);
});

test('a ChatGPT catalog choice becomes the workspace default without copying model pins or changing OAuth credentials',async t=>{
  const f=await fixture(t,{allowTestOAuth:true});await f.setup();const connection=await f.connect();
  const other=(await f.request('/api/connections',{method:'POST',data:{name:'Explicit alternative',type:'openai',baseUrl:connection.baseUrl,apiKey:KEY,defaultModel:'fixture-model'}})).body;
  await f.request('/api/bots/bot_nova',{method:'PATCH',data:{model:'explicit-specialist-model'}});
  await f.request('/api/bots/bot_scout',{method:'PATCH',data:{connectionId:other.id}});
  const extra=(await f.request('/api/bots',{method:'POST',data:{name:'Default follower',title:'General helper',connectionId:''}})).body;
  let sealedOAuth;
  await f.app.store.mutate(state=>{const current=state.connections.find(c=>c.id===connection.id);current.type='chatgpt';current.status='connected';current.oauthSecret=f.app.store.seal(JSON.stringify({access_token:KEY,scopes:['resource.invoke','chatgpt.tokens.use.direct'],expiresAt:Date.now()+3600000}));current.oauthAccount={subject:'fixture-account',planEnabled:true,needsLogin:false};sealedOAuth=current.oauthSecret;});
  f.remote.modelResponse={models:[{slug:'fixture-model',display_name:'First fixture model',visibility:'list'},{slug:'fixture-next',display_name:'Next fixture model',visibility:'list'},{slug:'hidden-model',display_name:'Hidden fixture model',visibility:'hidden'}]};
  const result=await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-next',applyToAllBots:false}});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.model,'fixture-next');assert.equal(result.body.defaultConnectionId,connection.id);
  assert.ok(result.body.appliedBotIds.includes('bot_atlas'));assert.ok(result.body.appliedBotIds.includes(extra.id));assert.ok(!result.body.appliedBotIds.includes('bot_nova'));assert.ok(!result.body.appliedBotIds.includes('bot_scout'));
  assert.equal(result.body.connection.status,'connected');assert.equal(result.body.connection.secret,undefined);assert.equal(result.body.connection.oauthSecret,undefined);
  const state=f.app.store.state,current=state.connections.find(c=>c.id===connection.id);
  assert.equal(current.oauthSecret,sealedOAuth);assert.equal(current.defaultModel,'fixture-next');assert.equal(current.oauthAccount.planEnabled,true);
  assert.deepEqual(state.settings,{defaultConnectionId:connection.id,defaultModel:'fixture-next'});
  assert.equal(state.bots.find(b=>b.id==='bot_atlas').model,'');assert.equal(state.bots.find(b=>b.id===extra.id).model,'');
  assert.equal(state.bots.find(b=>b.id==='bot_nova').model,'explicit-specialist-model');assert.equal(state.bots.find(b=>b.id==='bot_scout').connectionId,other.id);
  assert.ok(!current.models.some(model=>model.id==='hidden-model'));
  assert.equal(f.remote.requests.filter(r=>r.url.endsWith('/responses')).length,0,'Choosing a catalog model must not perform paid inference.');
  f.remote.handler=()=>answer('Using the inherited model.');
  assert.equal((await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Check the selected default.'}})).status,202);
  assert.equal((await f.wait()).status,'completed');
  assert.equal(f.remote.requests.filter(r=>r.url.endsWith('/responses')).at(-1).input.model,'fixture-next');
  assert.equal((await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-model',applyToAllBots:false}})).status,200);
  assert.equal(state.bots.find(b=>b.id==='bot_atlas').model,'','A subsequent default choice must remain inherited.');
});

test('default model selection rejects unknown, empty and failed catalogs without changing defaults or credentials',async t=>{
  const f=await fixture(t);await f.setup();const connection=await f.connect();
  const before=JSON.stringify(f.app.store.state);
  const catalogRequests=f.remote.requests.length;
  for(const applyToAllBots of ['false',null,0,{},[]])assert.equal((await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-model',applyToAllBots}})).status,400);
  assert.equal(f.remote.requests.length,catalogRequests,'Invalid apply-to-all flags must be rejected before provider discovery.');
  assert.equal(JSON.stringify(f.app.store.state),before);
  assert.equal((await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'not-in-the-current-catalog'}})).status,400);
  assert.equal(JSON.stringify(f.app.store.state),before);
  f.remote.modelResponse={data:[]};
  assert.equal((await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-model'}})).status,409);
  assert.equal(JSON.stringify(f.app.store.state),before);
  f.remote.modelStatus=503;f.remote.modelResponse={error:{message:'Fixture discovery unavailable'}};
  assert.equal((await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-model'}})).status,502);
  assert.equal(JSON.stringify(f.app.store.state),before);
  assert.equal(f.remote.requests.filter(r=>r.url.endsWith('/responses')).length,0);
});

test('workspace defaults reject active affected bots and reserved rooms atomically',async t=>{
  const f=await fixture(t);await f.setup();const connection=await f.connect();
  await f.app.store.mutate(state=>{state.runs.bot_atlas={id:'run_fixture_active',botId:'bot_atlas',connectionId:connection.id,status:'running'};});
  const before=JSON.stringify(f.app.store.state);
  assert.equal((await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-model'}})).status,409);
  assert.equal(JSON.stringify(f.app.store.state),before);
  await f.app.store.mutate(state=>{state.runs={};state.roomDrives.reserved={id:'drive_fixture',roomId:'reserved',botIds:['bot_atlas'],remaining:['bot_atlas'],status:'running'};});
  const reserved=JSON.stringify(f.app.store.state);
  assert.equal((await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-model'}})).status,409);
  assert.equal(JSON.stringify(f.app.store.state),reserved);
});

test('a provider edit during model discovery cannot save a choice from stale credentials',async t=>{
  const f=await fixture(t);await f.setup();const connection=await f.connect();
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  f.remote.beforeModels=async()=>{entered();await gate;};
  const choosing=f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-model'}});
  await waiting;
  const edited=await f.request(`/api/connections/${connection.id}`,{method:'PATCH',data:{apiKey:'replacement-fixture-key'}});assert.equal(edited.status,200);
  release();
  assert.equal((await choosing).status,409);
  assert.equal(f.app.store.state.settings?.defaultConnectionId,undefined);
  assert.equal(f.app.store.unseal(f.app.store.state.connections.find(c=>c.id===connection.id).secret),'replacement-fixture-key');
});

test('removing the workspace default clears stale default references atomically and preserves other preferences',async t=>{
  const f=await fixture(t);await f.setup();const connection=await f.connect();
  assert.equal((await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-model'}})).status,200);
  await f.app.store.mutate(state=>{state.settings.theme='fixture-theme';});
  assert.equal((await f.request(`/api/connections/${connection.id}`,{method:'DELETE'})).status,409);
  assert.equal(f.app.store.state.settings.defaultConnectionId,connection.id,'A blocked deletion must preserve the workspace default.');
  for(const bot of f.app.store.state.bots)assert.equal((await f.request(`/api/bots/${bot.id}`,{method:'PATCH',data:{connectionId:''}})).status,200);
  assert.equal((await f.request(`/api/connections/${connection.id}`,{method:'DELETE'})).status,200);
  assert.equal(f.app.store.state.settings.defaultConnectionId,'');assert.equal(f.app.store.state.settings.defaultModel,'');assert.equal(f.app.store.state.settings.theme,'fixture-theme');
  assert.ok(!f.app.store.state.connections.some(c=>c.id===connection.id));
  const fresh=await f.request('/api/bots',{method:'POST',data:{name:'After removal',title:'General helper'}});assert.equal(fresh.status,201);assert.equal(fresh.body.connectionId,'');assert.equal(fresh.body.model,'');
});

test('new server-created bots inherit the selected provider default without pinning its current model',async t=>{
  const f=await fixture(t);await f.setup();const connection=await f.connect();
  assert.equal((await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-model'}})).status,200);
  const created=await f.request('/api/bots',{method:'POST',data:{name:'Late arrival',title:'Default helper'}});assert.equal(created.status,201,JSON.stringify(created.body));
  assert.equal(created.body.connectionId,connection.id);assert.equal(created.body.model,'');
  const explicit=await f.request('/api/bots',{method:'POST',data:{name:'Pinned specialist',title:'Specialist',model:'explicit-specialist-model'}});assert.equal(explicit.status,201);assert.equal(explicit.body.connectionId,connection.id);assert.equal(explicit.body.model,'explicit-specialist-model');
  const other=(await f.request('/api/connections',{method:'POST',data:{name:'Another provider',type:'openai',baseUrl:connection.baseUrl,apiKey:KEY,defaultModel:'fixture-model'}})).body;
  const override=await f.request('/api/bots',{method:'POST',data:{name:'Other provider helper',title:'Specialist',connectionId:other.id}});assert.equal(override.status,201);assert.equal(override.body.connectionId,other.id);
  f.remote.modelResponse={data:[{id:'fixture-model',name:'First model'},{id:'fixture-next',name:'Next model'}]};
  assert.equal((await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-next',applyToAllBots:false}})).status,200);
  assert.equal(f.app.store.state.bots.find(b=>b.id===created.body.id).model,'');assert.equal(f.app.store.state.bots.find(b=>b.id===explicit.body.id).model,'explicit-specialist-model');assert.equal(f.app.store.state.bots.find(b=>b.id===override.body.id).connectionId,other.id);
  await f.request(`/api/bots/${created.body.id}/messages`,{method:'POST',data:{text:'Use the changed workspace default.'}});assert.equal((await f.wait(created.body.id)).status,'completed');
  assert.equal(f.remote.requests.filter(r=>r.url.endsWith('/responses')).at(-1).input.model,'fixture-next');
});

test('choosing a workspace default applies to every existing bot by default and replaces old copied model pins',async t=>{
  const f=await fixture(t);await f.setup();const connection=await f.connect();
  const other=(await f.request('/api/connections',{method:'POST',data:{name:'Previously assigned provider',type:'openai',baseUrl:connection.baseUrl,apiKey:KEY,defaultModel:'old-model'}})).body;
  await f.app.store.mutate(state=>{for(const bot of state.bots){bot.connectionId=other.id;bot.model='old-copied-model';}});
  const botIds=f.app.store.state.bots.map(bot=>bot.id).sort();
  const result=await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-model'}});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.applyToAllBots,true);assert.deepEqual(result.body.appliedBotIds.sort(),botIds);
  for(const bot of f.app.store.state.bots){assert.equal(bot.connectionId,connection.id);assert.equal(bot.model,'','Existing model pins must become inherited workspace defaults.');}
  assert.equal(f.app.store.state.settings.defaultConnectionId,connection.id);assert.equal(f.app.store.state.settings.defaultModel,'fixture-model');
  assert.equal(f.app.store.state.connections.find(c=>c.id===other.id).defaultModel,'old-model','Changing bot assignments must preserve other provider configurations.');
  assert.equal(f.remote.requests.filter(r=>r.url.endsWith('/responses')).length,0);
  await f.request('/api/bots/bot_nova/messages',{method:'POST',data:{text:'Use the workspace model after replacing the old pin.'}});assert.equal((await f.wait('bot_nova')).status,'completed');
  assert.equal(f.remote.requests.filter(r=>r.url.endsWith('/responses')).at(-1).input.model,'fixture-model');
});

test('apply to all checks active bots with explicit overrides before changing any provider or bot',async t=>{
  const f=await fixture(t);await f.setup();const connection=await f.connect();
  const other=(await f.request('/api/connections',{method:'POST',data:{name:'Busy specialist provider',type:'openai',baseUrl:connection.baseUrl,apiKey:KEY,defaultModel:'specialist-model'}})).body;
  await f.app.store.mutate(state=>{const bot=state.bots.find(b=>b.id==='bot_nova');bot.connectionId=other.id;bot.model='specialist-model';state.runs[bot.id]={id:'run_busy_override',botId:bot.id,connectionId:other.id,status:'running'};});
  const before=JSON.stringify(f.app.store.state);
  const result=await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'fixture-model',applyToAllBots:true}});
  assert.equal(result.status,409);assert.equal(JSON.stringify(f.app.store.state),before);
  assert.equal(f.remote.requests.filter(r=>r.url.endsWith('/responses')).length,0);
});

test('bots save their team setting and can be hidden even while they work',async t=>{
  const f=await fixture(t);await f.setup();await f.connect();
  const created=await f.request('/api/bots',{method:'POST',data:{name:'Iris',title:'Researcher'}});
  assert.equal(created.status,201);assert.equal(created.body.teamMode,'all');assert.equal(created.body.hidden,false);
  assert.equal((await f.request(`/api/bots/${created.body.id}`,{method:'PATCH',data:{teamMode:'everyone'}})).status,400);
  assert.equal((await f.request(`/api/bots/${created.body.id}`,{method:'PATCH',data:{hidden:'yes'}})).status,400);
  const selected=await f.request(`/api/bots/${created.body.id}`,{method:'PATCH',data:{teamMode:'selected',collaborators:['bot_nova']}});
  assert.equal(selected.status,200);assert.equal(selected.body.teamMode,'selected');assert.deepEqual(selected.body.collaborators,['bot_nova']);
  f.remote.handler=input=>input.input.some(item=>item.type==='function_call_output')?answer('Deletion was denied.'):call('workspace_delete',{path:'private.txt'});
  await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Delete the private file.'}});
  const pending=await f.wait('bot_atlas',run=>run?.status==='waiting_for_approval');
  // Editing still waits for the task; hiding only changes where the bot is listed.
  assert.equal((await f.request('/api/bots/bot_atlas',{method:'PATCH',data:{title:'Changed mid-task'}})).status,409);
  const hidden=await f.request('/api/bots/bot_atlas',{method:'PATCH',data:{hidden:true}});
  assert.equal(hidden.status,200);assert.equal(hidden.body.hidden,true);assert.equal(hidden.body.title,'Chief of staff');
  assert.equal(f.app.store.state.runs.bot_atlas.status,'waiting_for_approval');
  assert.equal((await f.request('/api/state')).body.bots.find(bot=>bot.id==='bot_atlas').hidden,true);
  const identity={runId:pending.id,remoteRunId:pending.remoteRunId,request_id:pending.pending_controls[0].prompt_id,execution_generation:pending.execution_generation};
  assert.equal((await f.request('/api/bots/bot_atlas/approval',{method:'POST',data:{...identity,choice:'deny'}})).status,200);
  assert.equal((await f.wait()).status,'completed');
  assert.equal((await f.request('/api/bots/bot_atlas',{method:'PATCH',data:{hidden:false}})).body.hidden,false);
});

test('the compact route summarizes a bot chat for the owner and refuses malformed or busy requests',async t=>{
  const f=await fixture(t);await f.setup();await f.connect();
  f.remote.handler=input=>answer(input.tools?.length?'Task reply.':'## Goal\nThe summary of the earlier chat.');
  await f.app.store.mutate(state=>{state.conversations.bot_atlas=Array.from({length:20},(_,i)=>[{role:'user',content:`topic ${i}`},{role:'assistant',content:`reply ${i}`}]).flat();});
  assert.equal((await f.request('/api/bots/bot_atlas/compact',{method:'POST',data:{topic:'yes'}})).status,400);
  assert.equal((await f.request('/api/bots/bot_atlas/compact',{method:'POST',data:{topic:true},security:false})).status,403);
  const result=await f.request('/api/bots/bot_atlas/compact',{method:'POST',data:{topic:true}});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.compacted,true);assert.equal(result.body.kept,0);
  assert.match(f.app.store.state.conversations.bot_atlas[0].content,/The summary of the earlier chat\./);
  const inference=await f.request('/api/bots/bot_atlas/inference');
  assert.equal(inference.body.conversation.compactions,1);assert.ok(inference.body.conversation.tokens>0);assert.equal(typeof inference.body.context.compactAt,'number');
  assert.equal((await f.request('/api/bots/missing_bot/compact',{method:'POST',data:{}})).status,404);
});
