import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudioServer } from '../server.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate) {const deadline=Date.now()+5000;while(Date.now()<deadline){const value=predicate();if(value)return value;await delay(5);}throw new Error('API process fixture timed out.');}

test('background output and Stop APIs enforce authentication, CSRF, current identities and process ownership',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-managed-api-'));let entered;const providerWaiting=new Promise(resolve=>{entered=resolve;});let turn=0;
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers:{async complete(connection,request){
    if(++turn===1)return {text:'',toolCalls:[{id:'start',name:'shell_start',arguments:{executable:process.execPath,args:['-e',"console.log('visible output '.repeat(20));setInterval(()=>{},1000)"],timeoutMs:10000}}]};
    entered();await new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));
  }}});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});const {url}=await app.listen(0);
  let cookie='',csrf='';
  async function request(route,{method='GET',data,authenticated=true,security=true}={}) {
    const response=await fetch(url+route,{method,headers:{...(authenticated&&cookie?{Cookie:cookie}:{}),...(security&&csrf?{'X-CSRF-Token':csrf}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
    return {status:response.status,body:await response.json(),headers:response.headers};
  }
  const setup=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'managed-tools-fixture-password'}});assert.equal(setup.status,201);cookie=setup.headers.get('set-cookie').split(';')[0];csrf=setup.body.csrf;
  await app.store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture-model'});state.bots[0].connectionId='fixture';state.bots[0].tools=['workspace','terminal'];state.bots[0].approvalPolicy='balanced';});
  const sent=await request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Start a fixture command and wait.'}});assert.equal(sent.status,202);const {id:runId,remoteRunId}=sent.body.run;
  const approval=await until(()=>app.store.state.runs.bot_atlas.status==='waiting_for_approval' && app.store.state.runs.bot_atlas);
  const approved=await request('/api/bots/bot_atlas/approval',{method:'POST',data:{runId,remoteRunId,request_id:approval.pending_controls[0].prompt_id,execution_generation:approval.execution_generation,choice:'once'}});assert.equal(approved.status,200);
  await providerWaiting;const processId=app.store.state.runs.bot_atlas.backgroundProcesses[0].processId,route=`/api/bots/bot_atlas/processes/${processId}`;
  assert.equal((await request(route+`?runId=${runId}`,{authenticated:false})).status,401);
  assert.equal((await request(route+'?runId=run_old')).status,409);
  assert.equal((await request(`/api/bots/bot_nova/processes/${processId}?runId=${runId}`)).status,409);
  assert.equal((await request(route+`?runId=${runId}&offset=-1`)).status,400);
  const page=await request(route+`?runId=${runId}&limit=50`);assert.equal(page.status,200);assert.equal(page.body.processId,processId);assert.equal(page.body.status,'running');assert.ok(page.body.output.length<=50);
  assert.equal((await request(route+'/stop',{method:'POST',data:{runId,remoteRunId},security:false})).status,403);
  assert.equal((await request(route+'/stop',{method:'POST',data:{runId,remoteRunId:'old'}})).status,409);assert.equal(app.runtime.backgroundProcesses.hasActive(runId),true);
  const stopped=await request(route+'/stop',{method:'POST',data:{runId,remoteRunId}});assert.equal(stopped.status,200);assert.equal(stopped.body.status,'stopped');assert.equal(app.runtime.backgroundProcesses.hasActive(runId),false);
  await request('/api/bots/bot_atlas/stop',{method:'POST',data:{runId,remoteRunId}});await app.runtime.tasks.get(runId);
  const persisted=await request(route+`?runId=${runId}`);assert.equal(persisted.status,200);assert.equal(persisted.body.status,'stopped');assert.equal(persisted.body.persistedPreview,true);
  assert.equal((await request(route+'/stop',{method:'POST',data:{runId,remoteRunId}})).status,409);
});
