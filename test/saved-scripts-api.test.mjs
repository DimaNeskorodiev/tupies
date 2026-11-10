import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudioServer } from '../server.mjs';
import { validateRoutine } from '../lib/routines.mjs';
import { loadLedger } from '../lib/script-ledger.mjs';

const BOT='bot_atlas',ID='echo-owner';
const CODE='process.stdout.write(JSON.stringify({argv:process.argv.slice(2),inputs:JSON.parse(process.env.TUPIES_SCRIPT_INPUTS||"null")}));\n';

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-saved-scripts-api-'));let app,cookie='',csrf='';
  t.after(async()=>{if(app){app.runtime.starting.clear();await app.close();}await fs.rm(directory,{recursive:true,force:true});});
  app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers:{async complete(){throw new Error('An owner script run must not invoke a model.');}}});
  const {url}=await app.listen(0,'127.0.0.1');
  async function request(route,{method='GET',data,authenticated=true}={}) {
    const response=await fetch(url+route,{method,signal:AbortSignal.timeout(15000),headers:{...(authenticated&&cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});
    const result={status:response.status,body:await response.json()};
    if(route==='/api/setup'&&response.ok){cookie=response.headers.get('set-cookie').split(';')[0];csrf=result.body.csrf;}
    return result;
  }
  const base=`/api/bots/${BOT}/scripts`;
  for(const [route,method] of [[base,'GET'],[`${base}/${ID}`,'GET'],[`${base}/${ID}`,'POST']])assert.equal((await request(route,{method,...(method==='POST'?{data:{action:'run'}}:{})})).status,401,`${method} ${route}`);
  assert.equal((await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'saved-scripts-api-disposable-password'}})).status,201);
  await app.store.mutate(state=>{Object.assign(state.bots.find(bot=>bot.id===BOT),{tools:['workspace','terminal'],approvalPolicy:'balanced'});});
  const save=code=>app.runtime.tools.execute(app.store.state.bots.find(bot=>bot.id===BOT),'script_save',{id:ID,title:'Echo for the owner',purpose:'Print what it receives.',language:'node',code,inputs:[{name:'target',description:'What to check.',required:true}]},{approved:true});
  return {app,request,base,save,root:path.join(directory,'workspaces',BOT)};
}

test('owner API: list and inspect fields, run with stale version, approval on Run, approve and revoke',async t=>{
  const h=await fixture(t),first=await h.save(CODE);
  await h.app.store.mutate(state=>state.routines.push(validateRoutine({name:'Uses echo',botId:BOT,prompt:'Echo.',intervalMinutes:60,enabled:false,workflow:{version:1,mode:'report',steps:[{id:'echo',op:'script',scriptId:ID,digest:first.script.digest,args:[]}],report:'{{echo.stdout}}'}},{id:'echo-routine'})));
  let list=await h.request(h.base);assert.equal(list.status,200);
  const entry=list.body.scripts.find(item=>item.id===ID);
  assert.deepEqual({language:entry.language,version:entry.version,approvedVersion:entry.approvedVersion,needsApproval:entry.needsApproval,runnable:entry.runnable,runs:entry.runs,usedBy:entry.usedBy,inputFields:entry.inputFields,inputs:entry.inputs},
    {language:'node',version:first.script.digest.slice(0,12),approvedVersion:null,needsApproval:true,runnable:true,runs:{count:0,lastAt:null,lastStatus:null,lastDurationMs:null},usedBy:[{routineId:'echo-routine',name:'Uses echo'}],inputFields:[{name:'target',description:'What to check.',required:true}],inputs:['target (required): What to check.']});
  let inspect=await h.request(`${h.base}/${ID}`);
  assert.equal(inspect.body.source.content,CODE);assert.equal(inspect.body.source.path,`scripts/${ID}/main.mjs`);assert.deepEqual(inspect.body.history,[]);assert.equal(inspect.body.diff,undefined);
  // Run needs an exact current version; a new version needs the owner's explicit approve: true.
  const run=data=>h.request(`${h.base}/${ID}`,{method:'POST',data:{action:'run',...data}});
  assert.equal((await run({version:'0'.repeat(12),inputs:{target:'x'}})).status,409);
  const unapproved=await run({version:entry.version,inputs:{target:'x'}});assert.equal(unapproved.status,428);assert.match(unapproved.body.error,/approve: true/);
  assert.equal((await run({version:entry.version,inputs:{}, approve:true})).status,400,'a missing required input runs nothing');
  const ran=await run({version:entry.version,inputs:{target:'$(id); rm -rf x'},args:['`whoami`'],approve:true});
  assert.equal(ran.status,200,JSON.stringify(ran.body));
  assert.deepEqual(JSON.parse(ran.body.stdout),{argv:['--target','$(id); rm -rf x','`whoami`'],inputs:{target:'$(id); rm -rf x'}});
  assert.deepEqual([ran.body.status,ran.body.exitCode,ran.body.backend,ran.body.modelCalls,ran.body.version],['succeeded',0,'host',0,entry.version]);
  assert.ok(Number.isInteger(ran.body.durationMs));assert.equal(typeof ran.body.output,'string');
  inspect=await h.request(`${h.base}/${ID}`);
  assert.deepEqual([inspect.body.approvedVersion,inspect.body.approvedHow,inspect.body.needsApproval,inspect.body.runs.count,inspect.body.runs.lastStatus],[entry.version,'owner-run',false,1,'succeeded']);
  assert.deepEqual(inspect.body.history.map(item=>[item.startedBy,item.status,item.backend,item.version]),[['owner','succeeded','host',entry.version]]);
  assert.equal(Object.hasOwn(inspect.body.history[0],'usage'),false);
  // An approved version runs again without approve: true.
  assert.equal((await run({version:entry.version,inputs:{target:'again'}})).status,200);
  // A changed version shows a bounded diff against the approved source.
  const second=await h.save(CODE+'console.log("v2");\n');
  inspect=await h.request(`${h.base}/${ID}`);
  assert.deepEqual([inspect.body.version,inspect.body.approvedVersion,inspect.body.needsApproval],[second.script.digest.slice(0,12),entry.version,true]);
  assert.match(inspect.body.diff,/^--- approved [a-f0-9]{12}\n\+\+\+ current [a-f0-9]{12}\n@@[\s\S]*\+console\.log\("v2"\);/);
  assert.equal((await run({version:entry.version,inputs:{target:'stale'}})).status,409,'the old version is no longer current');
  // Approve and revoke an exact version without running.
  const approved=await h.request(`${h.base}/${ID}`,{method:'POST',data:{action:'approve',version:second.script.digest}});
  assert.equal(approved.status,200);assert.equal(approved.body.script.needsApproval,false);assert.equal(approved.body.script.approvedHow,'owner');
  const revoked=await h.request(`${h.base}/${ID}`,{method:'POST',data:{action:'revoke',version:second.script.digest.slice(0,12)}});
  assert.equal(revoked.status,200);assert.equal(revoked.body.revoked,1);assert.equal(revoked.body.script.needsApproval,true);
  assert.equal((await h.request(`${h.base}/${ID}`,{method:'POST',data:{action:'approve',version:entry.version}})).status,409);
  assert.equal((await h.request(`${h.base}/${ID}`,{method:'POST',data:{action:'delete',version:entry.version}})).status,400);
  const ledger=await loadLedger(h.app.store,BOT);assert.equal(ledger.scripts[ID].count,2);
  assert.equal(h.app.store.state.runs[BOT],undefined,'no task and no model call was involved');
});

test('owner API: a run respects the bot-busy guard and reserves admission while it runs',async t=>{
  const h=await fixture(t),saved=await h.save('setTimeout(()=>process.stdout.write("done"),300);\n'),version=saved.script.digest.slice(0,12);
  await h.app.store.mutate(state=>{state.runs[BOT]={id:'fixture-active',status:'running'};});
  assert.equal((await h.request(`${h.base}/${ID}`,{method:'POST',data:{action:'run',version,inputs:{target:'x'},approve:true}})).status,409);
  await h.app.store.mutate(state=>{delete state.runs[BOT];});
  const pending=h.request(`${h.base}/${ID}`,{method:'POST',data:{action:'run',version,inputs:{target:'x'},approve:true}});
  for(let i=0;i<400 && !h.app.runtime.starting.has(BOT);i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(h.app.runtime.starting.has(BOT),true,'admission is reserved during the owner run');
  const result=await pending;assert.equal(result.status,200);assert.equal(result.body.stdout,'done');assert.equal(h.app.runtime.starting.has(BOT),false);
  const timed=await h.request(`${h.base}/${ID}`,{method:'POST',data:{action:'run',version,inputs:{target:'x'},timeoutMs:100}});
  assert.equal(timed.body.status,'timed_out');assert.equal(timed.body.timedOut,true);
});
