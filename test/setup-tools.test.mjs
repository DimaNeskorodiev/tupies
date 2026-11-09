import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, DEFAULT_BOT_TOOLS } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { dashboard } from '../lib/dashboard.mjs';
import { selfManagementGuidance, setupApprovalSummary } from '../lib/setup-tools.mjs';
import { createStudioServer } from '../server.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=4000) {const until=Date.now()+timeout;while(Date.now()<until){const result=predicate();if(result)return result;await delay(5);}throw new Error('Fixture timed out waiting for agent state.');}
const ORIGINAL=['workspace','memory','skills','web','integrations','delegation'];
const configure=store=>store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Fixture',model:'fixture-model',secret:store.seal('disposable-fixture-key')});state.settings.defaultConnectionId='fixture-provider';for(const bot of state.bots){bot.connectionId='fixture-provider';bot.approvalPolicy='balanced';}});

async function server(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-setup-tools-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers:{async complete(){return {text:'Done.',toolCalls:[]};}}});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  await configure(app.store);
  const bot=id=>app.store.state.bots.find(item=>item.id===id),tools=app.runtime.tools;
  return {app,store:app.store,tools,bot};
}

test('bots on an earlier default tool set gain Routines and Manage Tupies once; owner choices stay',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-tool-upgrade-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init();
  assert.deepEqual(store.state.bots[0].tools,DEFAULT_BOT_TOOLS);
  await store.mutate(state=>{
    const [atlas,nova,scout]=state.bots;
    for(const bot of state.bots)delete bot.toolGroupsVersion;
    atlas.tools=[...ORIGINAL];nova.tools=[...ORIGINAL,'automation'];scout.tools=['web'];
    state.bots.push({...structuredClone(atlas),id:'bot_quiet',name:'Quiet',tools:[]});
  });
  await store.queue;
  let reopened=await new Store(directory).init();
  const tools=id=>reopened.state.bots.find(bot=>bot.id===id).tools;
  assert.deepEqual(tools('bot_atlas'),DEFAULT_BOT_TOOLS,'the original default set gains Routines and Manage Tupies');
  assert.deepEqual(tools('bot_nova'),DEFAULT_BOT_TOOLS,'the later default set gains Manage Tupies');
  assert.deepEqual(tools('bot_scout'),['web'],'a custom selection is the owner’s');
  assert.deepEqual(tools('bot_quiet'),[],'no tools stays no tools');
  assert.ok(reopened.state.bots.every(bot=>bot.toolGroupsVersion===2));
  // The owner turns Manage Tupies off again: it stays off.
  await reopened.mutate(state=>{state.bots.find(bot=>bot.id==='bot_atlas').tools=[...ORIGINAL,'automation'];});await reopened.queue;
  reopened=await new Store(directory).init();
  assert.deepEqual(tools('bot_atlas'),[...ORIGINAL,'automation']);
});

test('a bot creates a new bot through the same checks as the bot API, after approval',async t=>{
  const {store,tools,bot}=await server(t),atlas=bot('bot_atlas');
  const args={name:'Satoshi',title:'Crypto market watcher',description:'Tracks bitcoin and crypto prices.',instructions:'Watch crypto prices and report clearly.',color:'amber'};
  await assert.rejects(tools.execute(atlas,'bots_create',args),/approval/);
  await assert.rejects(tools.execute(atlas,'bots_create',{...args,tools:['web','terminal']},{approved:true}),error=>error.status===403 && /Only the owner/.test(error.message));
  await assert.rejects(tools.execute(atlas,'bots_create',{...args,tools:['engine_workshop']},{approved:true}),error=>error.status===403 && /Only the owner/.test(error.message));
  await assert.rejects(tools.execute(atlas,'bots_create',{...args,skills:['missing-skill']},{approved:true}),/Unknown skill/);
  assert.equal(store.state.bots.length,3);
  const result=await tools.execute(atlas,'bots_create',args,{approved:true}),created=bot(result.bot.id);
  assert.equal(result.created,true);
  assert.equal(created.name,'Satoshi');assert.equal(created.title,'Crypto market watcher');assert.equal(created.color,'amber');assert.equal(created.icon,'companion:blue');
  assert.deepEqual(created.tools,DEFAULT_BOT_TOOLS);assert.equal(created.toolGroupsVersion,2);
  assert.equal(created.connectionId,'fixture-provider','a new bot uses the owner’s default provider');
  assert.equal(created.approvalPolicy,'auto');assert.deepEqual(created.integrationIds,[]);
  assert.ok(store.state.activity.some(item=>item.type==='bot.created' && item.botId===created.id && item.source==='agent' && item.createdBy==='bot_atlas'));
  const listed=await tools.execute(atlas,'bots_list',{});
  assert.ok(listed.bots.some(item=>item.id===created.id && item.title==='Crypto market watcher'));
  assert.equal(listed.bots.find(item=>item.id==='bot_atlas').you,true);
  assert.ok(Array.isArray(listed.installedSkills));
  // Without Manage Tupies the tools are not offered at all.
  const limited={...atlas,tools:['workspace','automation']};
  assert.ok(!tools.definitions(limited).some(item=>item.name==='bots_create'));
  await assert.rejects(tools.execute(limited,'bots_create',args,{approved:true}),/not enabled/);
});

test('a bot changes another bot, but never itself, a busy bot or owner-only access',async t=>{
  const {app,store,tools,bot}=await server(t),atlas=bot('bot_atlas');
  await assert.rejects(tools.execute(atlas,'bots_update',{botId:'bot_atlas',name:'Renamed'},{approved:true}),error=>error.status===403 && /its own settings/.test(error.message));
  await assert.rejects(tools.execute(atlas,'bots_update',{botId:'bot_nova',addTools:['terminal']},{approved:true}),error=>error.status===403);
  await assert.rejects(tools.execute(atlas,'bots_update',{botId:'bot_nova'},{approved:true}),/what to change/);
  await assert.rejects(tools.execute(atlas,'bots_update',{botId:'bot_nova',name:'Nova Prime'}),/approval/);
  app.runtime.compactions.set('bot_nova',new AbortController());
  try {await assert.rejects(tools.execute(atlas,'bots_update',{botId:'bot_nova',name:'Nova Prime'},{approved:true}),error=>error.status===409);}
  finally {app.runtime.compactions.delete('bot_nova');}
  const result=await tools.execute(atlas,'bots_update',{botId:'bot_nova',name:'Nova Prime',removeTools:['web','setup'],enabled:false},{approved:true});
  const nova=bot('bot_nova');
  assert.equal(result.updated,true);assert.equal(nova.name,'Nova Prime');assert.equal(nova.enabled,false);
  assert.ok(!nova.tools.includes('web') && !nova.tools.includes('setup') && nova.tools.includes('memory'));
  await tools.execute(atlas,'bots_update',{botId:'bot_nova',addTools:['web'],enabled:true},{approved:true});
  assert.ok(bot('bot_nova').tools.includes('web'));assert.equal(bot('bot_nova').enabled,true);
  // Access the owner granted stays when a bot changes other tool groups.
  await store.mutate(state=>{state.bots.find(item=>item.id==='bot_scout').tools.push('terminal');});
  await tools.execute(atlas,'bots_update',{botId:'bot_scout',removeTools:['web']},{approved:true});
  assert.ok(bot('bot_scout').tools.includes('terminal'));
});

test('a bot assigns installed skills to another bot, never to itself mid-task',async t=>{
  const {store,tools,bot}=await server(t),atlas=bot('bot_atlas'),skill=store.state.skills[0];
  assert.ok(skill,'the workspace has installed starter skills');
  await assert.rejects(tools.execute(atlas,'skills_assign',{skillId:skill.id,botId:'bot_atlas'},{approved:true}),error=>error.status===403);
  await assert.rejects(tools.execute(atlas,'skills_assign',{skillId:skill.id,botId:'bot_nova'}),/approval/);
  await tools.execute(atlas,'skills_assign',{skillId:skill.id,botId:'bot_nova'},{approved:true});
  assert.ok(bot('bot_nova').skills.includes(skill.id));
  await tools.execute(atlas,'skills_assign',{skillId:skill.id,botId:'bot_nova',enabled:false},{approved:true});
  assert.ok(!bot('bot_nova').skills.includes(skill.id));
});

test('with Manage Tupies a bot schedules, changes and removes routines for other bots',async t=>{
  const {store,tools,bot}=await server(t),atlas=bot('bot_atlas'),nova=bot('bot_nova');
  const args={name:'Bitcoin price',prompt:'Fetch the bitcoin price in USD and report it.',schedule:{kind:'interval',minutes:10},botId:'bot_scout'};
  const withoutSetup={...nova,tools:['workspace','web','automation']};
  await assert.rejects(tools.execute(withoutSetup,'routines_create',args,{approved:true}),/Manage Tupies/);
  await assert.rejects(tools.execute(atlas,'routines_create',{...args,botId:'bot_missing'},{approved:true}),/not found/);
  const created=await tools.execute(atlas,'routines_create',args,{approved:true}),routine=created.routine;
  assert.equal(routine.botId,'bot_scout');assert.equal(created.runsAs,'Scout');assert.equal(created.schedule,'Every 10 minutes');
  assert.ok(Math.abs(Date.parse(routine.nextRunAt)-(Date.now()+600_000))<5000);
  const listed=(await tools.execute(atlas,'routines_list',{})).routines;
  assert.equal(listed[0].botName,'Scout');assert.equal(listed[0].when,'Every 10 minutes');
  assert.deepEqual((await tools.execute(withoutSetup,'routines_list',{})).routines,[],'without Manage Tupies other bots’ routines stay private');
  await assert.rejects(tools.execute(withoutSetup,'routines_update',{routineId:routine.id,enabled:false},{approved:true}),error=>error.status===403);
  await assert.rejects(tools.execute(atlas,'routines_update',{routineId:routine.id,enabled:false}),/approval/);
  const paused=await tools.execute(atlas,'routines_update',{routineId:routine.id,enabled:false},{approved:true});
  assert.equal(paused.enabled,false);assert.equal(store.state.routines[0].nextRunAt,null);
  const changed=await tools.execute(atlas,'routines_update',{routineId:routine.id,enabled:true,schedule:{kind:'daily',time:'08:30'},name:'Morning bitcoin'},{approved:true});
  assert.equal(changed.routine.name,'Morning bitcoin');assert.match(changed.schedule,/^Every day at 08:30/);assert.equal(store.state.routines[0].id,routine.id);
  await assert.rejects(tools.execute(atlas,'routines_update',{routineId:routine.id,schedule:{kind:'interval',minutes:2}},{approved:true}),/interval/);
  await tools.execute(atlas,'routines_delete',{routineId:routine.id},{approved:true});
  assert.equal(store.state.routines.length,0);
});

test('approval cards and the system prompt describe self-management plainly',()=>{
  const state={bots:[{id:'bot_scout',name:'Scout'}],routines:[{id:'routine_1',name:'Bitcoin price'}],skills:[{id:'market-brief',name:'market-brief',title:'Market brief'}],settings:{timezone:'Europe/Warsaw'}};
  assert.equal(setupApprovalSummary(state,'routines_create',{name:'Bitcoin price',schedule:{kind:'interval',minutes:10}}),'Schedule “Bitcoin price”: Every 10 minutes');
  assert.equal(setupApprovalSummary(state,'routines_create',{name:'Digest',schedule:{kind:'daily',time:'08:30'},botId:'bot_scout'}),'Schedule “Digest”: Every day at 08:30 (Europe/Warsaw) for Scout');
  assert.equal(setupApprovalSummary(state,'routines_update',{routineId:'routine_1',enabled:false}),'Change the “Bitcoin price” routine: pause it');
  assert.equal(setupApprovalSummary(state,'bots_create',{name:'Satoshi',title:'Crypto watcher'}),'Create a new bot “Satoshi” · Crypto watcher');
  assert.equal(setupApprovalSummary(state,'bots_update',{botId:'bot_scout',addTools:['automation'],enabled:false}),'Change Scout: pause it, turn on automation');
  assert.equal(setupApprovalSummary(state,'skills_assign',{skillId:'market-brief',botId:'bot_scout'}),'Give the “Market brief” skill to Scout');
  assert.equal(setupApprovalSummary(state,'workspace_write',{path:'a.txt'}),'');
  const on=selfManagementGuidance(['automation','setup']),off=selfManagementGuidance(['web']);
  assert.match(on,/routines_create/);assert.match(on,/bots_create/);assert.match(on,/instead of describing the steps/);
  assert.match(off,/Routines are turned off/);assert.match(off,/turn on Manage Tupies/);assert.doesNotMatch(off,/call routines_create/);
});

test('“check the bitcoin price every 10 minutes” in chat becomes an approved routine',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-bitcoin-routine-')),store=await new Store(directory).init(),requests=[];
  await configure(store);
  const call={id:'schedule',name:'routines_create',arguments:{name:'Bitcoin price',prompt:'Fetch the current bitcoin price in USD from https://api.coinbase.com/v2/prices/BTC-USD/spot with http_fetch and report it in one line.',schedule:{kind:'interval',minutes:10}}};
  const engine=new NativeEngine(store,{runTimeout:10_000,providers:{async complete(connection,request){requests.push(request);return requests.length===1?{text:'',toolCalls:[call]}:{text:'Done: Bitcoin price runs every 10 minutes.',toolCalls:[]};}}});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  await engine.start('bot_atlas','Create a routine to check the bitcoin price every 10 minutes');
  await waitFor(()=>store.state.runs.bot_atlas?.status==='waiting_for_approval');
  const system=requests[0].system || requests[0].instructions || JSON.stringify(requests[0].messages[0]);
  // The system prompt names the routines group; calling routines_create loads it and shows its guidance once.
  assert.match(system,/- automation: create, change, pause and remove routines/);assert.match(system,/instead of describing the steps/);assert.doesNotMatch(system,/routines_create|bots_create/);
  assert.ok(!requests[0].tools.some(tool=>(tool.name || tool.function?.name)==='routines_create'));
  assert.ok(engine.permittedTools({bot:store.state.bots.find(bot=>bot.id==='bot_atlas'),source:'chat',inference:{}}).some(tool=>tool.name==='routines_create'));
  const run=store.state.runs.bot_atlas,control=run.pending_controls[0];
  assert.equal(control.review.summary,'Schedule “Bitcoin price”: Every 10 minutes');
  assert.equal(dashboard(store).needs[0].title,'Schedule “Bitcoin price”: Every 10 minutes');
  assert.equal(store.state.routines.length,0,'nothing is scheduled before approval');
  await engine.control('bot_atlas','approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:control.prompt_id,execution_generation:run.execution_generation,choice:'once'});
  await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  assert.ok(requests[1].tools.some(tool=>tool.name==='routines_create'));assert.match(requests[1].turnContext,/check the bitcoin price every 10 minutes/);
  const routine=store.state.routines[0];
  assert.equal(routine.name,'Bitcoin price');assert.equal(routine.botId,'bot_atlas');assert.equal(routine.enabled,true);
  assert.deepEqual(routine.schedule,{kind:'interval',minutes:10});
  assert.ok(Math.abs(Date.parse(routine.nextRunAt)-(Date.now()+600_000))<10_000);
});
