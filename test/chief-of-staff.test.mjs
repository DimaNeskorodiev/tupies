import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { JSDOM } from 'jsdom';
import { createStudioServer } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { chiefOfStaff, teamActivityReport, teamActivityAllowed, ensureDailyBrief, BRIEF_PROMPT, CHIEF_GUIDANCE, TEAM_ACTIVITY_LIMITS } from '../lib/chief-of-staff.mjs';
import { measurePrompt } from '../scripts/measure-prompt.mjs';

const call=(id,name,args)=>({id,name,arguments:args});
const waitFor=async(check,timeout=10_000)=>{const until=Date.now()+timeout;while(Date.now()<until){const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Chief-of-staff fixture timed out.');};
const NOW=Date.parse('2026-11-10T12:00:00Z');
const ago=hours=>new Date(NOW-hours*3_600_000).toISOString();
const meter=(costUsd,extra={})=>({steps:2,toolCalls:1,modelCalls:2,inputTokens:900,cachedTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:1000,cachePercent:0,...(costUsd===undefined?{}:{costUsd,costSource:'catalog'}),...extra});

test('the chief of staff is the chosen bot, else the seeded chief-of-staff bot while it exists, else none',()=>{
  const bots=[{id:'bot_atlas',name:'Roki',starterTemplate:'chief-of-staff'},{id:'bot_nova',name:'Ops'},{id:'x',name:'X'}];
  assert.equal(chiefOfStaff({bots,settings:{}}).id,'bot_atlas');
  assert.equal(chiefOfStaff({bots,settings:{chiefOfStaffBotId:'x'}}).id,'x');
  assert.equal(chiefOfStaff({bots,settings:{chiefOfStaffBotId:'gone'}}).id,'bot_atlas','a deleted choice falls back to automatic');
  assert.equal(chiefOfStaff({bots:bots.slice(1),settings:{}}),null,'no seeded bot and no choice means none');
  assert.equal(chiefOfStaff({bots:bots.slice(1),settings:{chiefOfStaffBotId:'x'}}).id,'x');
});

const SECRET='sk-secret-body-text-1234567890';
function fixtureState() {
  const row=(id,hoursAgo,extra={})=>({id,status:'completed',source:'chat',lane:'chat',sessionId:'bot_nova',task:`Task ${id}`,createdAt:ago(hoursAgo+0.1),finishedAt:ago(hoursAgo),steps:3,metering:meter(0.01),...extra});
  return {
    bots:[{id:'bot_atlas',name:'Roki',starterTemplate:'chief-of-staff',enabled:true},{id:'bot_nova',name:'Ops',enabled:true},{id:'bot_scout',name:'Scout',enabled:false},{id:'bot_hidden',name:'Hidden',hidden:true,enabled:true}],settings:{},
    messages:{bot_nova:[{role:'assistant',content:SECRET}]},
    runs:{bot_nova:{id:'r_live',status:'waiting_for_approval',updatedAt:ago(2),sessionId:'bot_nova',pending_controls:[{kind:'approval',tool:'workspace_write',review:{summary:'Write notes/plan.md'},preview:SECRET}]},
      bot_atlas:{id:'r_q',status:'waiting_for_input',updatedAt:ago(1),sessionId:'bot_atlas',pending_controls:[{kind:'question',questions:[{prompt:SECRET}]}]}},
    runHistory:{
      bot_nova:[
        row('n_ok',1),row('n_fail',3,{status:'failed',error:`Provider said no.\nSecond line ${'x'.repeat(400)}`,metering:meter(0.02)}),
        row('n_stop',5,{status:'cancelled'}),row('n_routine',6,{source:'routine'}),row('n_old',200),
        row('n_tg',2,{lane:'telegram',sessionId:'bot_nova--telegram-abc',source:'telegram',task:'Stranger asked something private'}),
        row('n_delegated',4,{delegatedBy:'bot_atlas',source:'chat'}),
      ],
      bot_atlas:[row('a_ok',0.5,{task:`  Long   ${'title '.repeat(60)}`,metering:meter()})],
    },
  };
}

test('the team report gives states, finished tasks, counts, costs and what waits, and never message text',()=>{
  const state=fixtureState(),report=teamActivityReport(state,{now:NOW,chiefId:'bot_atlas'});
  const byId=Object.fromEntries(report.bots.map(bot=>[bot.botId,bot]));
  assert.deepEqual(report.bots.map(bot=>bot.botId),['bot_atlas','bot_nova','bot_scout'],'hidden bots are left out');
  assert.equal(byId.bot_atlas.you,true);
  assert.deepEqual([byId.bot_atlas.state,byId.bot_nova.state,byId.bot_scout.state],['waiting_for_answer','waiting_for_approval','paused']);
  assert.equal(byId.bot_nova.since,ago(2));
  assert.deepEqual(byId.bot_nova.counts,{completed:3,failed:1,stopped:1});
  assert.equal(byId.bot_nova.tasks.length,5,'the old task and the foreign Telegram task are excluded');
  assert.ok(!report.bots.flatMap(bot=>bot.tasks).some(task=>task.runId==='n_tg' || task.runId==='n_old'));
  assert.equal(byId.bot_nova.estimatedCostUsd,0.06);assert.equal(byId.bot_atlas.estimatedCostUsd,null,'no price on the task means no total');
  const failed=byId.bot_nova.tasks.find(task=>task.runId==='n_fail');
  assert.equal(failed.status,'failed');assert.ok(failed.error.length<=160 && !failed.error.includes('\n'));
  assert.equal(byId.bot_nova.tasks.find(task=>task.runId==='n_delegated').source,'teammate');assert.equal(byId.bot_nova.tasks.find(task=>task.runId==='n_routine').source,'routine');
  assert.ok(byId.bot_nova.tasks[0].usage.totalTokens===1000 && byId.bot_atlas.tasks[0].task.length<=140);
  assert.deepEqual(report.waitingForOwner.map(item=>[item.botId,item.kind,item.tool,item.summary]),[['bot_atlas','question',undefined,undefined],['bot_nova','approval','workspace_write','Write notes/plan.md']]);
  const json=JSON.stringify(report);
  assert.ok(!json.includes(SECRET),'no message text, approval preview or question text');assert.ok(!json.includes('Stranger'));
  assert.equal(report.truncated,false);
  // The window and one bot filter.
  assert.equal(teamActivityReport(state,{hours:2,now:NOW}).bots.flatMap(bot=>bot.tasks).length,2);
  assert.deepEqual(teamActivityReport(state,{botId:'bot_nova',now:NOW}).bots.map(bot=>bot.botId),['bot_nova']);
  for(const bad of [0,169,1.5,'24'])assert.throws(()=>teamActivityReport(state,{hours:bad,now:NOW}),error=>error.status===400);
  assert.throws(()=>teamActivityReport(state,{botId:'nobody',now:NOW}),error=>error.status===404);
});

test('a foreign Telegram run is never summarized, even while it is waiting',()=>{
  const state=fixtureState();state.runs.bot_nova={id:'t',status:'waiting_for_approval',updatedAt:ago(1),sessionId:'bot_nova--telegram-abc',pending_controls:[{kind:'approval',tool:'terminal',review:{summary:'private'}}]};
  const report=teamActivityReport(state,{now:NOW});
  assert.equal(report.bots.find(bot=>bot.botId==='bot_nova').state,'working');assert.ok(!report.waitingForOwner.some(item=>item.botId==='bot_nova'));
});

test('the report shows at most 40 task rows and says when it was cut',()=>{
  const state=fixtureState();
  state.runHistory.bot_scout=Array.from({length:50},(_,index)=>({id:`s${index}`,status:'completed',source:'chat',lane:'chat',sessionId:'bot_scout',task:`S ${index}`,createdAt:ago(10),finishedAt:ago(10+index/100),steps:1}));
  const report=teamActivityReport(state,{now:NOW}),rows=report.bots.flatMap(bot=>bot.tasks);
  assert.equal(rows.length,TEAM_ACTIVITY_LIMITS.rows);assert.equal(report.truncated,true);assert.equal(report.totalTasks,56);
  assert.equal(report.bots.find(bot=>bot.botId==='bot_scout').counts.completed,50,'counts cover every task, not only the shown rows');
});

async function engineFixture(t,{chief}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-chief-')),store=await new Store(directory).init(),requests=[],scripts={};
  await store.mutate(state=>{
    state.connections.push({id:'fixture',type:'openai',defaultModel:'m'});
    for(const bot of state.bots){bot.connectionId='fixture';bot.model='m';bot.approvalPolicy='auto';}
    if(chief)state.settings.chiefOfStaffBotId=chief;
  });
  const engine=new NativeEngine(store,{runTimeout:15000,stallNudgeRounds:0,stallAskRounds:0,providers:{async complete(_connection,request){
    requests.push(request);const name=request.messages[0].content.match(/^You are ([^,]+),/)?.[1],queue=scripts[name];
    return queue?.length?queue.shift()(request):{text:'done',toolCalls:[]};
  }}});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,requests,scripts,directory};
}
const lastTool=(request,id)=>JSON.parse(request.messages.findLast(message=>message.tool_call_id===id).content);
/** Scripts a bot to load the team group and call team_activity through the bridge; resolves with what it saw. */
function probe(f,name){
  const seen={};
  f.scripts[name]=[()=>({text:'',toolCalls:[call('load','tools_load',{groups:['team']})]}),request=>{seen.loaded=lastTool(request,'load');return {text:'',toolCalls:[call('act','tool_call',{name:'team_activity',arguments:{hours:24}})]};},request=>{seen.result=lastTool(request,'act');return {text:'seen',toolCalls:[]};}];
  return seen;
}
const finished=(f,botId)=>waitFor(()=>['completed','failed'].includes(f.store.state.runs[botId]?.status) && f.store.state.runs[botId]);

test('team_activity is offered to the chief in the owner chat and admitted there; the offered tool list does not change',async t=>{
  const f=await engineFixture(t),seen=probe(f,'Roki');
  await f.engine.start('bot_atlas','What did my bots do?');await finished(f,'bot_atlas');
  assert.ok(seen.loaded.tools.some(tool=>tool.name==='team_activity'),'the team group lists it for the chief');
  assert.match(seen.loaded.guidance.team,/team_activity/);
  assert.ok(Array.isArray(seen.result.bots) && seen.result.bots.some(bot=>bot.botId==='bot_atlas' && bot.you===true),JSON.stringify(seen.result));
  assert.ok(!f.requests.some(request=>request.tools?.some(tool=>tool.name==='team_activity')),'never in the always-offered list');
  assert.ok(f.requests[0].messages[0].content.includes(CHIEF_GUIDANCE),'the chief prompt carries the guidance');
});

test('team_activity is not offered to another bot, and a direct call from it is refused',async t=>{
  const f=await engineFixture(t),seen=probe(f,'Ops');
  await f.engine.start('bot_nova','What did my bots do?');await finished(f,'bot_nova');
  assert.ok(!seen.loaded.tools.some(tool=>tool.name==='team_activity'));assert.ok(!seen.loaded.guidance.team?.includes('team_activity'));
  assert.ok(seen.result.error && !seen.result.bots,JSON.stringify(seen.result));assert.match(seen.result.error,/chief of staff/);
  assert.ok(!f.requests[0].messages[0].content.includes(CHIEF_GUIDANCE));
});

test('a chosen chief of staff gets the tool and the seeded one loses it',async t=>{
  const f=await engineFixture(t,{chief:'bot_nova'}),seen=probe(f,'Ops'),other=probe(f,'Roki');
  await f.engine.start('bot_nova','Brief me.');await finished(f,'bot_nova');
  assert.ok(seen.loaded.tools.some(tool=>tool.name==='team_activity'));
  await f.engine.start('bot_atlas','Brief me.');await finished(f,'bot_atlas');
  assert.ok(other.result.error,'the seeded bot is no longer the chief');
});

test('team_activity is not offered in Telegram lanes, rooms or delegated tasks',async t=>{
  const f=await engineFixture(t),telegram=probe(f,'Roki');
  await f.engine.start('bot_atlas','A stranger asks what the team did.',{source:'telegram',lane:'telegram:stranger'});await finished(f,'bot_atlas');
  assert.ok(!telegram.loaded.tools.some(tool=>tool.name==='team_activity') && telegram.result.error);
  const g=await engineFixture(t),room=probe(g,'Roki');
  await g.engine.start('bot_atlas','Coordinate the team.',{roomId:'team',source:'room'});await finished(g,'bot_atlas');
  assert.ok(!room.loaded.tools.some(tool=>tool.name==='team_activity') && room.result.error);
  // A delegated task: the chief asks Ops (made the chief for this fixture) to do a job; inside that job the tool is still withheld.
  const h=await engineFixture(t,{chief:'bot_nova'}),inner=probe(h,'Ops');
  h.scripts.Roki=[()=>({text:'',toolCalls:[call('d','delegate_task',{botId:'bot_nova',task:'Report what the team did.'})]}),()=>({text:'handed over',toolCalls:[]})];
  await h.engine.start('bot_atlas','Ask Ops for a report.');await finished(h,'bot_atlas');
  assert.ok(inner.loaded && !inner.loaded.tools.some(tool=>tool.name==='team_activity') && inner.result.error,JSON.stringify(inner));
  // Synthetic contexts for the remaining cases.
  const ctx=(extra={})=>({bot:{id:'bot_atlas'},source:'chat',lane:'chat',runId:'x',...extra});
  assert.equal(teamActivityAllowed(f.engine,ctx()),true);
  assert.equal(teamActivityAllowed(f.engine,ctx({delegation:{depth:1}})),false);
  assert.equal(teamActivityAllowed(f.engine,ctx({lane:'mission:m1'})),false);
  assert.equal(teamActivityAllowed(f.engine,ctx({source:'telegram'})),false);
  assert.equal(teamActivityAllowed(f.engine,ctx({source:'routine',lane:'routine:r1',routine:{botId:'bot_atlas'}})),true);
  assert.equal(teamActivityAllowed(f.engine,ctx({source:'routine',lane:'routine:r1',routine:{botId:'bot_nova'}})),false);
});

test("the chief's own daily-brief routine can call team_activity",async t=>{
  const f=await engineFixture(t),seen=probe(f,'Roki');
  const {routine}=await ensureDailyBrief(f.store);
  await f.engine.runRoutine(routine.id);await waitFor(()=>f.store.state.runs.bot_atlas?.source==='routine' && ['completed','failed'].includes(f.store.state.runs.bot_atlas.status));
  assert.ok(seen.loaded.tools.some(tool=>tool.name==='team_activity'),JSON.stringify(f.store.state.runs.bot_atlas.error));assert.ok(Array.isArray(seen.result.bots));
});

test('the default prompt of a non-chief bot is unchanged and the chief guidance is short',async t=>{
  assert.ok(CHIEF_GUIDANCE.length<=500,String(CHIEF_GUIDANCE.length));
  const withChief=await engineFixture(t),without=await engineFixture(t,{chief:'bot_scout'});
  const prompt=(f,id)=>{const bot=f.store.state.bots.find(item=>item.id===id);return f.engine.instructions(bot,{source:'chat',lane:'chat',bot,inference:{}},f.engine.toolDefinitions({source:'chat',lane:'chat',bot,inference:{}}));};
  assert.equal(prompt(withChief,'bot_nova'),prompt(without,'bot_nova'),'Ops is not the chief in either workspace');
  assert.ok(prompt(withChief,'bot_atlas').includes(CHIEF_GUIDANCE));assert.ok(!prompt(without,'bot_atlas').includes(CHIEF_GUIDANCE));
  const toolNames=id=>{const bot=withChief.store.state.bots.find(item=>item.id===id);return withChief.engine.toolDefinitions({source:'chat',lane:'chat',bot,inference:{}}).map(tool=>tool.name);};
  assert.deepEqual(toolNames('bot_atlas'),toolNames('bot_nova'),'the always-offered list is identical for chief and others');
  const measured=await measurePrompt({profile:'default'});assert.ok(measured.fixedTokens<=8000);
});

async function server(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-chief-api-'));
  const studio=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  t.after(async()=>{await studio.close();await fs.rm(directory,{recursive:true,force:true});});
  const {url}=await studio.listen(0);
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:studio.bootstrapToken,password:'chief-fixture-password'})});
  assert.equal(setup.status,201);
  const {csrf}=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  return {studio,url,headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf}};
}

test('the chief-of-staff settings routes need the owner, validate and clear',async t=>{
  const {studio,url,headers}=await server(t),route=url+'/api/settings/chief-of-staff';
  assert.equal((await fetch(route)).status,401);assert.equal((await fetch(route,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);assert.equal((await fetch(route+'/brief',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const get=async()=>(await fetch(route,{headers})).json(),patch=body=>fetch(route,{method:'PATCH',headers,body:JSON.stringify(body)});
  let settings=await get();assert.equal(settings.chiefOfStaffBotId,null);assert.equal(settings.chiefOfStaff.id,'bot_atlas');assert.equal(settings.brief,null);
  assert.equal((await patch({botId:'nobody'})).status,400);assert.equal((await patch({botId:5})).status,400);assert.equal((await patch({other:1})).status,400);
  const saved=await patch({botId:'bot_nova'});assert.equal(saved.status,200);assert.equal((await saved.json()).chiefOfStaff.id,'bot_nova');
  assert.equal(studio.store.state.settings.chiefOfStaffBotId,'bot_nova');
  settings=await (await patch({botId:''})).json();assert.equal(settings.chiefOfStaffBotId,null);assert.equal(settings.chiefOfStaff.id,'bot_atlas');
  assert.equal(studio.store.state.settings.chiefOfStaffBotId,undefined);
});

test('the daily brief is optional, creates one enabled routine at 08:30 and never a duplicate',async t=>{
  const {studio,url,headers}=await server(t),route=url+'/api/settings/chief-of-staff/brief';
  assert.equal(studio.store.state.routines.length,0,'nothing is created automatically');
  await studio.store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'m'});for(const bot of state.bots){bot.connectionId='fixture';bot.model='m';}state.settings.timezone='Europe/Warsaw';});
  const first=await fetch(route,{method:'POST',headers,body:'{}'});assert.equal(first.status,201);
  const created=await first.json();
  assert.deepEqual([created.created,created.routine.name,created.routine.botId,created.routine.enabled,created.routine.schedule,created.routine.timezone,created.routine.prompt],[true,'Daily brief','bot_atlas',true,{kind:'daily',time:'08:30'},'Europe/Warsaw',BRIEF_PROMPT]);
  assert.ok(created.routine.nextRunAt);assert.equal(created.brief.id,created.routine.id);
  const second=await fetch(route,{method:'POST',headers,body:'{}'});assert.equal(second.status,200);
  const again=await second.json();assert.equal(again.created,false);assert.equal(again.routine.id,created.routine.id);
  assert.equal(studio.store.state.routines.length,1);
  // An owner edit survives; asking again returns the edited routine.
  await studio.store.mutate(state=>{state.routines[0].enabled=false;});
  assert.equal((await (await fetch(route,{method:'POST',headers,body:'{}'})).json()).routine.enabled,false);
  assert.equal(studio.store.state.routines.length,1);
  assert.match(BRIEF_PROMPT,/team_activity/);assert.match(BRIEF_PROMPT,/Nothing to report since yesterday\./);assert.match(BRIEF_PROMPT,/ten lines/);
});

test('the Chief of staff settings card is escaped, picks a bot and adds the brief',async()=>{
  const read=name=>readFileSync(new URL(`../public/${name}`,import.meta.url),'utf8');
  assert.match(read('index.html'),/<script defer src="\/chief-of-staff\.js"><\/script>/);assert.match(read('index.html'),/<link rel="stylesheet" href="\/chief-of-staff\.css">/);
  assert.ok(read('app.js').includes('window.StudioChief?.render(studioContext())'));
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only'});dom.window.eval(read('chief-of-staff.js'));
  const calls=[];let settings={chiefOfStaffBotId:null,chiefOfStaff:{id:'a',name:'Ro<b>ki'},brief:null};
  const context={esc:value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),data:{bots:[{id:'a',name:'Ro<b>ki'},{id:'b',name:'Ops'}]},errorText:error=>error.message,refresh:async()=>{calls.push('refresh');},
    api:async(pathname,options={})=>{
      calls.push(`${options.method||'GET'} ${pathname} ${JSON.stringify(options.body||'')}`);
      if(options.method==='PATCH')settings={...settings,chiefOfStaffBotId:options.body.botId||null,chiefOfStaff:{id:options.body.botId||'a',name:options.body.botId==='b'?'Ops':'Ro<b>ki'}};
      if(options.method==='POST')settings={...settings,brief:{id:'routine_1',enabled:true,schedule:{kind:'daily',time:'08:30'}}};
      return structuredClone(settings);}};
  const root=dom.window.document.querySelector('main');root.innerHTML=dom.window.StudioChief.render(context);
  const flush=()=>new Promise(done=>setTimeout(done,0));await flush();await flush();
  assert.equal(root.querySelectorAll('b,img').length,0,'names are escaped');
  assert.match(root.textContent,/Chief of staff/);assert.match(root.textContent,/Automatic \(Ro<b>ki\)/);
  const select=root.querySelector('[data-chief-select]');assert.deepEqual([...select.options].map(option=>option.textContent),['Automatic (Ro<b>ki)','Ro<b>ki','Ops']);
  select.value='b';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await flush();await flush();
  assert.ok(calls.includes('PATCH /api/settings/chief-of-staff {"botId":"b"}'));assert.equal(root.querySelector('[data-chief-select]').value,'b');
  const add=root.querySelector('[data-chief-brief]');assert.equal(add.textContent,'Add a daily brief');
  add.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));await flush();await flush();
  assert.ok(calls.includes('POST /api/settings/chief-of-staff/brief {}'));assert.ok(calls.includes('refresh'));
  assert.match(root.textContent,/Daily brief is on · every day at 08:30/);
  const edit=root.querySelector('[data-action="edit-routine"]');assert.equal(edit.dataset.id,'routine_1');assert.equal(root.querySelector('[data-chief-brief]'),null);
  assert.match(read('chief-of-staff.css'),/min-height:44px/);
});
