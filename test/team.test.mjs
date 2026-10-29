import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { Store } from '../lib/store.mjs';
import { NativeEngine, teammatesFor } from '../lib/engine.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=4000) {const until=Date.now()+timeout;while(Date.now()<until){const result=predicate();if(result)return result;await delay(5);}throw new Error('Fixture timed out waiting for agent state.');}
const call=(id,name,arguments_)=>({id,name,arguments:arguments_});
// Seeded bots without a team setting, exactly like workspaces created before it existed.
async function engineFixture(t,complete,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-team-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'native-provider',type:'openai',name:'Fixture',model:'test-model',secret:store.seal('fixture-private-key')});for(const bot of state.bots){bot.connectionId='native-provider';bot.tools=['workspace','memory','delegation'];bot.collaborators=[];delete bot.teamMode;}});
  const engine=new NativeEngine(store,{runTimeout:10_000,providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length,connection);}},...options});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,requests};
}

test('teammatesFor gives every other bot by default and only chosen bots in selected mode',()=>{
  const bots=[{id:'a'},{id:'b'},{id:'c'}];
  assert.deepEqual(teammatesFor({id:'a',collaborators:[]},bots).map(bot=>bot.id),['b','c']);
  assert.deepEqual(teammatesFor({id:'a',teamMode:'all',collaborators:['b']},bots).map(bot=>bot.id),['b','c']);
  assert.deepEqual(teammatesFor({id:'a',teamMode:'selected',collaborators:['c','a','missing']},bots).map(bot=>bot.id),['c']);
  assert.deepEqual(teammatesFor({id:'a',teamMode:'selected'},bots),[]);
});

test('a bot knows the whole team by default and really talks with a teammate it was never paired with',async t=>{
  const {engine,store,requests}=await engineFixture(t,async request=>{
    const atlas=request.messages[0].content.startsWith(`You are ${store.state.bots.find(bot=>bot.id==='bot_atlas').name}`);
    if(atlas&&request.messages.at(-1).role==='user')return {text:'',toolCalls:[call('ask-scout','delegate_task',{botId:'bot_scout',task:'Which source is most reliable?'})]};
    return {text:atlas?'Scout says the primary source is best.':'The primary source is most reliable.',toolCalls:[]};
  });
  await engine.start('bot_atlas','Ask the team which source to trust.');
  await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  const system=requests[0].messages[0].content;
  assert.match(system,/Your team \(every other bot in this workspace\)/);
  assert.match(system,/- bot_nova: Nova/);assert.match(system,/- bot_scout: Scout/);assert.doesNotMatch(system,/- bot_atlas:/);
  assert.match(system,/Talk to a teammate with delegate_task/);
  assert.equal(store.state.runs.bot_scout.output,'The primary source is most reliable.');
  const asked=store.state.messages.bot_scout.find(message=>message.role==='user');
  assert.equal(asked.content,'Which source is most reliable?');assert.equal(asked.fromBotId,'bot_atlas');assert.equal(asked.source,'delegation');
  assert.ok(requests[1].messages.findLast(message=>message.role==='user').content.includes(`A permitted teammate (${store.state.bots.find(bot=>bot.id==='bot_atlas').name}, `));
  assert.match(requests[1].messages.findLast(message=>message.role==='user').content,/\) is asking for your help/);
  // The user's own message never carries a teammate marker.
  assert.equal(store.state.messages.bot_atlas.find(message=>message.role==='user').fromBotId,undefined);
});

test('waiting for a teammate shows its live progress and does not spend the waiting bot\'s runtime',async t=>{
  const seen=[],runtime=600,parentStep=150,childWork=450;let parentWork=0;
  const {engine,store}=await engineFixture(t,async request=>{
    const atlas=request.messages[0].content.startsWith(`You are ${store.state.bots.find(bot=>bot.id==='bot_atlas').name}`);
    if(!atlas){seen.push(structuredClone(store.state.runs.bot_atlas));t.mock.timers.tick(childWork);return {text:'The primary source is most reliable.',toolCalls:[]};}
    parentWork+=parentStep;t.mock.timers.tick(parentStep);
    if(request.messages.at(-1).role==='user')return {text:'',toolCalls:[call('ask-scout','delegate_task',{botId:'bot_scout',task:'Which source is most reliable?'})]};
    return {text:'Scout says the primary source is best.',toolCalls:[]};
  },{runTimeout:runtime});
  // Exercise the real deadline/pause/resume logic without charging unrelated CPU/FS contention to this fixture.
  // Provider work advances the same clock/timers used by production; real Store writes still finish normally.
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  const started=await engine.start('bot_atlas','Ask Scout which source to trust.');
  await engine.tasks.get(started.id);
  const atlas=store.state.runs.bot_atlas;
  assert.equal(atlas.status,'completed',atlas.error);assert.equal(store.state.runs.bot_scout.status,'completed');
  assert.equal(parentWork,2*parentStep);assert.ok(parentWork<runtime,'the parent spent less than its own budget');assert.ok(childWork<runtime,'the child spent less than its own budget');
  assert.equal(Date.parse(atlas.finishedAt)-Date.parse(atlas.createdAt),parentWork+childWork);
  assert.ok(Date.parse(atlas.finishedAt)-Date.parse(atlas.createdAt)>runtime,'the whole conversation outlasted one runtime limit');
  assert.equal(seen[0].status,'waiting_for_delegate');
  assert.deepEqual({botId:seen[0].teammate.botId,status:seen[0].teammate.status,steps:seen[0].teammate.steps,event:seen[0].teammate.event},{botId:'bot_scout',status:'running',steps:1,event:'model.started'});
  assert.equal(Object.hasOwn(atlas,'teammate'),false);
});

test('a teammate that outlasts its own runtime limit fails without failing the bot that asked',async t=>{
  const {engine,store,requests}=await engineFixture(t,async request=>{
    const atlas=request.messages[0].content.startsWith(`You are ${store.state.bots.find(bot=>bot.id==='bot_atlas').name}`);
    if(!atlas){t.mock.timers.tick(500);return {text:'Too late.',toolCalls:[]};}
    if(request.messages.at(-1).role==='user')return {text:'',toolCalls:[call('ask-scout','delegate_task',{botId:'bot_scout',task:'Check every source.'})]};
    return {text:'Scout ran out of time, so I answered myself.',toolCalls:[]};
  },{runTimeout:300});
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  const started=await engine.start('bot_atlas','Ask Scout to check the sources.');
  await engine.tasks.get(started.id);
  assert.equal(store.state.runs.bot_atlas.status,'completed');assert.equal(store.state.runs.bot_scout.status,'failed');
  assert.match(requests.at(-1).messages.at(-1).content,/runtime limit/);
});

test('selected team mode limits who a bot knows and refuses everyone else',async t=>{
  const {engine,store,requests}=await engineFixture(t,async request=>request.messages.at(-1).role==='user'?{text:'',toolCalls:[call('outside','delegate_task',{botId:'bot_scout',task:'Help me.'})]}:{text:'I worked without Scout.',toolCalls:[]});
  await store.mutate(state=>{const atlas=state.bots.find(bot=>bot.id==='bot_atlas');atlas.teamMode='selected';atlas.collaborators=['bot_nova'];});
  await engine.start('bot_atlas','Get help.');
  await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  const system=requests[0].messages[0].content;
  assert.match(system,/Your owner chose these teammates for you/);assert.match(system,/- bot_nova: Nova/);assert.doesNotMatch(system,/bot_scout/);
  assert.equal(store.state.runs.bot_scout,undefined);
  assert.ok(store.state.conversations.bot_atlas.some(message=>message.role==='tool'&&message.content.includes('explicitly selected collaborators')));
});

test('a bot without the collaboration tool still knows its team but is told it cannot contact them',async t=>{
  const {engine,store,requests}=await engineFixture(t,async()=>({text:'Nova would be the right writer for this.',toolCalls:[]}));
  await store.mutate(state=>{state.bots.find(bot=>bot.id==='bot_atlas').tools=['workspace','memory'];});
  await engine.start('bot_atlas','Who should write this?');
  await waitFor(()=>store.state.runs.bot_atlas?.status==='completed');
  const system=requests[0].messages[0].content;
  assert.match(system,/- bot_nova: Nova/);assert.match(system,/Bot collaboration is turned off for you/);
  assert.ok(!(requests[0].tools||[]).some(tool=>tool.name==='delegate_task'));
});

// Browser rendering, run from the shipped app.js against small DOM doubles.
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const avatarSource=await readFile(new URL('../public/creature-avatars.js',import.meta.url),'utf8');
const activityModelSource=await readFile(new URL('../public/activity-flow-model.js',import.meta.url),'utf8');
const fixtureData={bots:[
  {id:'bot_nova',name:'Nova',title:'Writer',connectionId:'provider_1',enabled:true,color:'lavender'},
  {id:'bot_atlas',name:'Atlas',title:'Planner',connectionId:'provider_1',enabled:true,color:'mint',teamMode:'selected',collaborators:['bot_nova']},
  {id:'bot_echo',name:'Echo',title:'Archivist',connectionId:'provider_1',enabled:true,hidden:true},
],connections:[{id:'provider_1',name:'Fixture',type:'openai',status:'connected',defaultModel:'fixture-model'}],activity:[],runs:{},rooms:[],routines:[],skills:[],integrations:[],channels:[],sync:null};
function ui(hash='',{activityFlow=false}={}) {
  const app={innerHTML:''},main={innerHTML:''},thread={innerHTML:'',scrollTop:0,clientHeight:500,scrollHeight:500,querySelector(){return null;}};
  const document={hidden:false,activeElement:null,addEventListener(){},querySelectorAll(){return [];},body:{classList:{add(){},remove(){}}},
    querySelector(selector){if(selector==='#app')return app;if(selector==='#main-content')return main;if(selector==='#chat-thread'||selector==='#room-thread')return thread;return null;}};
  const ctx=vm.createContext({document,window:{addEventListener(){}},location:{hash},URL,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(avatarSource,ctx,{filename:'creature-avatars.js'});
  if(activityFlow)vm.runInContext(activityModelSource,ctx,{filename:'activity-flow-model.js'});
  vm.runInContext(source,ctx,{filename:'app.js'});
  ctx.fixture=structuredClone(fixtureData);
  vm.runInContext('data={...initialState,...fixture};auth={authenticated:true,csrf:"fixture"};loadChat=()=>{};loadRoomChat=()=>{};loadSyncPage=()=>{};',ctx);
  return {app,thread,run:code=>vm.runInContext(code,ctx),ctx};
}
const decodeAttribute=value=>value.replace(/&(?:amp|lt|gt|quot|#39);/g,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[entity]));
const flowFromMarkup=html=>JSON.parse(decodeAttribute(html.match(/\bdata-flow="([^"]*)"/)[1]));
const flowKey=html=>html.match(/class="chat-message thinking-message [^"]*" data-message-key="([^"]*)"/)[1];

test('hidden bots leave the sidebar and the Bots grid but stay one filter away',()=>{
  const h=ui('#/bots');h.run('renderApp()');
  const sidebar=h.app.innerHTML.match(/<aside[\s\S]*<\/aside>/)[0];
  assert.match(sidebar,/roster-name">Nova</);assert.doesNotMatch(sidebar,/Echo/);
  assert.match(sidebar,/data-nav="\/bots"[\s\S]*?nav-count">2</);
  const grid=h.run('renderBots()');
  assert.match(grid,/data-filter="all">All <span>2<\/span>/);assert.match(grid,/data-filter="hidden">Hidden <span>1<\/span>/);
  assert.doesNotMatch(grid,/Echo/);
  // The whole tile and Chat open the conversation; secondary actions live in More.
  assert.match(grid,/<article class="glass-card bot-card " data-nav="\/bot\/bot_nova"/);
  assert.match(grid,/class="open-chat" data-nav="\/bot\/bot_nova"/);
  assert.match(grid,/data-action="chat-menu" data-id="bot_nova" aria-haspopup="menu"/);
  h.run("filter='hidden'");const hidden=h.run('renderBots()');
  assert.match(hidden,/bot-card is-hidden" data-nav="\/bot\/bot_echo"/);assert.match(hidden,/data-action="chat-menu" data-id="bot_echo"/);
  assert.doesNotMatch(hidden,/bot_nova/);assert.match(hidden,/Hidden bots keep their chats, routines and team roles/);
  // With nothing hidden the Hidden filter disappears and falls back to every bot.
  h.run("data.bots=data.bots.map(bot=>({...bot,hidden:false}))");const shown=h.run('renderBots()');
  assert.doesNotMatch(shown,/data-filter="hidden"/);assert.match(shown,/bot_echo/);assert.equal(h.run('filter'),'all');
});

test('bot settings default to the whole team and reveal the checklist only for selected teammates',()=>{
  const h=ui('#/bots');let dialog='';h.ctx.capture=(title,html)=>{dialog=html;};h.run('openDialog=capture');
  h.run("botDialog('bot_nova')");
  assert.match(dialog,/name="teamMode" value="all" checked/);assert.doesNotMatch(dialog,/name="teamMode" value="selected" checked/);
  assert.match(dialog,/class="skill-checklist team-checklist" hidden/);assert.match(dialog,/name="hidden" >/);
  h.run("botDialog('bot_atlas')");
  assert.match(dialog,/name="teamMode" value="selected" checked/);assert.match(dialog,/class="skill-checklist team-checklist" >/);
  assert.match(dialog,/name="collaborator" value="bot_nova" checked/);assert.match(dialog,/name="collaborator" value="bot_echo" >/);
  h.run("botDialog('bot_echo')");assert.match(dialog,/name="hidden" checked/);
  assert.deepEqual(JSON.parse(h.run("JSON.stringify(botTeammates(botById('bot_atlas')).map(bot=>bot.id))")),['bot_nova']);
  assert.deepEqual(JSON.parse(h.run("JSON.stringify(botTeammates(botById('bot_nova')).map(bot=>bot.id))")),['bot_atlas','bot_echo']);
});

test('a teammate request is shown as coming from that bot, not from you',()=>{
  const h=ui('#/bot/bot_nova');
  const asked=h.run("messageMarkup({id:'m1',role:'user',content:'Can you <draft> this?',fromBotId:'bot_atlas',source:'delegation'},botById('bot_nova'),'thread-m1')");
  assert.match(asked,/class="chat-message from-teammate"/);assert.match(asked,/Atlas<span class="teammate-label">/);
  assert.doesNotMatch(asked,/>You</);assert.doesNotMatch(asked,/read-message/);assert.match(asked,/Can you &lt;draft&gt; this\?/);
  const mine=h.run("messageMarkup({id:'m2',role:'user',content:'Hello'},botById('bot_nova'),'thread-m2')");
  assert.match(mine,/class="chat-message user"/);assert.match(mine,/>You</);
});

test('the thinking card follows what the bot is doing and keeps one canvas per run',()=>{
  const h=ui('#/bot/bot_atlas');
  const render=run=>{h.run(`chat={messages:[{role:'user',content:'Work on it.'}],run:${JSON.stringify(run)}};activeBot='bot_atlas';renderThread(botById('bot_atlas'))`);return h.thread.innerHTML;};
  const base={id:'run_1',remoteRunId:'run_1',createdAt:'2026-10-27T10:00:00.000Z'};
  let html=render({...base,status:'queued',events:[]});
  assert.match(html,/Atlas is getting ready/);assert.match(html,/data-energy="calm"/);
  assert.match(html,/data-thinking="run_1" data-keep="thinking-run_1"/);assert.match(html,/data-colors="#a4f5d5,#21c6a1,#087a77,#c4ffe7"/);
  assert.match(html,/data-started="2026-10-27T10:00:00.000Z"/);assert.match(html,/class="thinking-stop" data-action="stop-run" data-id="bot_atlas"/);
  html=render({...base,status:'running',events:[{type:'model.started'}]});assert.match(html,/Atlas is thinking/);assert.match(html,/data-energy="think"/);
  html=render({...base,status:'running',events:[{type:'model.started'},{type:'tool.started',tool:'http_fetch'}]});assert.match(html,/Atlas is reading the web/);assert.match(html,/data-energy="act"/);
  html=render({...base,status:'waiting_for_delegate',events:[{type:'delegation.started',botId:'bot_nova',targetBotId:'bot_nova'}]});
  assert.match(html,/Atlas is talking with Nova/);assert.match(html,/data-energy="talk"/);assert.match(html,/data-peer-colors="#d9baff,#9970ed,#5931ad,#efdcff"/);
  html=render({...base,status:'stopping',events:[]});assert.match(html,/Atlas is stopping/);assert.match(html,/class="thinking-stop"[^>]*disabled/);
  // Approval and finished turns show no waves.
  html=render({...base,status:'waiting_for_approval',pending_controls:[{kind:'approval',prompt_id:'p1'}],events:[]});assert.doesNotMatch(html,/thinking-card/);assert.match(html,/approval-card/);
  html=render({...base,status:'completed',output:'Done.',events:[]});assert.doesNotMatch(html,/thinking-card/);
});

test('a team room shows the thinking card for the bot taking its turn with a room Stop',()=>{
  const h=ui('#/room/room_1');
  h.run("data.rooms=[{id:'room_1',name:'Launch',botIds:['bot_atlas','bot_nova']}];data.runs={bot_nova:{id:'run_n',status:'running',createdAt:'2026-10-27T10:00:00.000Z',events:[{type:'tool.started',tool:'documents_create'}]}}");
  h.run("roomChat={messages:[],drive:{id:'drive_1',status:'running',activeBotId:'bot_nova',createdAt:'2026-10-27T09:59:00.000Z'},activeRun:null};renderRoomThread('room_1')");
  const html=h.thread.innerHTML;
  assert.match(html,/Nova is making a document/);assert.match(html,/data-thinking="room-drive_1"/);assert.match(html,/data-started="2026-10-27T10:00:00.000Z"/);
  assert.match(html,/class="thinking-stop" data-action="stop-room" data-id="room_1"/);
  h.run("roomChat.drive.status='stopping';renderRoomThread('room_1')");assert.match(h.thread.innerHTML,/Nova is stopping/);
});

test('the live activity graph classifies only the task admitted to the current bot run',()=>{
  const h=ui('#/bot/bot_atlas',{activityFlow:true});
  h.ctx.messages=[
    {id:'current',role:'user',runId:'run_current',content:'Analyze the budget CSV.'},
    {id:'other',role:'user',runId:'run_other',content:'Delegate to a teammate.'},
    {id:'unadmitted',role:'user',content:'Choose a strategy.'},
  ];
  h.run("chat={messages,run:{id:'run_current',status:'running',events:[{type:'model.started'}]}};renderThread(botById('bot_atlas'))");
  const graph=flowFromMarkup(h.thread.innerHTML);
  assert.equal(graph.kind,'analysis');assert.equal(graph.nodes.find(node=>node.id==='input').value,'Analyze the budget CSV.');
  assert.doesNotMatch(JSON.stringify(graph),/Delegate to a teammate|Choose a strategy/);
  // A run without an admitted message gets neutral context, never the latest unrelated message.
  h.run("chat.run.id='run_missing';renderThread(botById('bot_atlas'))");
  const missing=flowFromMarkup(h.thread.innerHTML);
  assert.equal(missing.kind,'research');assert.equal(missing.nodes.find(node=>node.id==='input').value,'Current task');
});

test('actual results update activity markup without changing the retained canvas or exact Stop identity',()=>{
  const h=ui('#/bot/bot_atlas',{activityFlow:true});
  h.ctx.activeRun={id:'run_42',remoteRunId:'remote_81',status:'running',createdAt:'2026-10-27T10:00:00Z',events:[
    {id:'started',type:'tool.started',tool:'http_fetch',toolCallId:'fetch_1',arguments:{url:'https://example.test/data?token=fixture-secret#fixture-secret'}},
  ]};
  h.run("chat={messages:[{id:'task',role:'user',runId:'run_42',content:'Read the source.'}],run:activeRun};renderThread(botById('bot_atlas'))");
  const before=h.thread.innerHTML,pending=flowFromMarkup(before);
  assert.equal(pending.nodes.filter(node=>node.kind==='fact').length,0);
  h.ctx.result={type:'tool.completed',tool:'http_fetch',toolCallId:'fetch_1',preview:JSON.stringify({status:200,text:JSON.stringify({temperature:17,condition:'<svg onload="alert(1)">&'})})};
  h.run("chat.run.events.push(result);renderThread(botById('bot_atlas'))");
  const after=h.thread.innerHTML,finished=flowFromMarkup(after),attribute=after.match(/\bdata-flow="([^"]*)"/)[1];
  assert.ok(finished.nodes.some(node=>node.label==='temperature'&&node.value==='17'));
  assert.ok(finished.nodes.some(node=>node.label==='condition'&&node.value==='<svg onload="alert(1)">&'));
  assert.ok(attribute.includes(String.raw`&lt;svg onload=\&quot;alert(1)\&quot;&gt;&amp;`));assert.doesNotMatch(attribute,/[<>]/);
  assert.doesNotMatch(JSON.stringify(finished),/fixture-secret|10,000|Warsaw|Venue/);
  assert.notEqual(finished.signature,pending.signature);assert.notEqual(flowKey(after),flowKey(before));
  for(const html of [before,after]){
    assert.match(html,/data-thinking="run_42" data-keep="thinking-run_42"/);
    const stop=html.match(/<button class="thinking-stop"[^>]+>/)[0];
    assert.match(stop,/data-action="stop-run" data-id="bot_atlas"/);
    assert.deepEqual(JSON.parse(decodeAttribute(stop.match(/data-run="([^"]*)"/)[1])),{runId:'run_42',remoteRunId:'remote_81'});
  }
  // Polling-only timestamps do not replace the animated card.
  h.run("chat.run.updatedAt='2026-10-27T10:01:00Z';renderThread(botById('bot_atlas'))");
  assert.equal(flowKey(h.thread.innerHTML),flowKey(after));
});

test('team room activity receives the full active run and the task scoped to its drive',()=>{
  const h=ui('#/room/room_flow',{activityFlow:true});
  h.run("data.rooms=[{id:'room_flow',name:'Research',botIds:['bot_atlas','bot_nova']}];data.runs={bot_nova:{id:'stale',status:'running',events:[{type:'tool.started',tool:'documents_create'}]}}");
  h.ctx.roomFixture={messages:[
    {id:'task',role:'user',driveId:'drive_current',content:'Read the current source.'},
    {id:'old',role:'user',driveId:'drive_other',content:'Delegate to a teammate.'},
  ],drive:{id:'drive_current',status:'running',activeBotId:'bot_nova',createdAt:'2026-10-27T10:00:00Z'},activeRun:{
    id:'run_room',status:'running',createdAt:'2026-10-27T10:00:10Z',events:[
      {type:'tool.started',tool:'http_fetch',toolCallId:'room_fetch',arguments:{url:'https://example.test/room'}},
      {type:'tool.completed',tool:'http_fetch',toolCallId:'room_fetch',preview:JSON.stringify({status:200,text:JSON.stringify({wind:8})})},
    ],
  }};
  h.run("roomChat=roomFixture;renderRoomThread('room_flow')");
  const html=h.thread.innerHTML,graph=flowFromMarkup(html);
  assert.equal(graph.kind,'research');assert.equal(graph.nodes.find(node=>node.id==='input').value,'Read the current source.');
  assert.ok(graph.nodes.some(node=>node.label==='wind'&&node.value==='8'));
  assert.ok(graph.nodes.some(node=>node.value==='https://example.test/room'));
  assert.doesNotMatch(JSON.stringify(graph),/documents_create|Delegate to a teammate/);
  assert.match(html,/data-thinking="room-drive_current" data-keep="thinking-room-drive_current"/);
  assert.match(html,/data-started="2026-10-27T10:00:10Z"/);
  const stop=html.match(/<button class="thinking-stop"[^>]+>/)[0];
  assert.match(stop,/data-action="stop-room" data-id="room_flow"/);
  assert.deepEqual(JSON.parse(decodeAttribute(stop.match(/data-drive="([^"]*)"/)[1])),{driveId:'drive_current'});
});

test('activity flow yields to the existing exact approval controls and completed replies',()=>{
  const h=ui('#/bot/bot_atlas',{activityFlow:true});
  h.run("chat={messages:[],run:{id:'run_approval',remoteRunId:'remote_approval',execution_generation:3,status:'waiting_for_approval',pending_controls:[{kind:'approval',prompt_id:'exact_request',tool:'workspace_delete',preview:'Delete report.txt'}]}};renderThread(botById('bot_atlas'))");
  const html=h.thread.innerHTML;
  assert.doesNotMatch(html,/data-flow=|thinking-card/);assert.match(html,/approval-card/);
  const identity=JSON.parse(decodeAttribute(html.match(/data-approval="([^"]*)"/)[1]));
  assert.deepEqual(identity,{runId:'run_approval',remoteRunId:'remote_approval',request_id:'exact_request',execution_generation:3});
  h.run("chat.run={...chat.run,status:'completed',output:'Done.'};renderThread(botById('bot_atlas'))");
  assert.doesNotMatch(h.thread.innerHTML,/data-flow=|thinking-card|data-action="approve"/);
});

// The animation itself, against a canvas double that records drawing.
const wavesSource=await readFile(new URL('../public/thinking-waves.js',import.meta.url),'utf8');
function wavesHarness({reduced=false}={}) {
  const frames=[],timers=[],calls={stroke:0,arc:0};
  const gradient={addColorStop(offset){assert.ok(offset>=0&&offset<=1,`gradient stop ${offset}`);}};
  const context=new Proxy({},{get(target,name){if(name in target)return target[name];if(name==='createLinearGradient'||name==='createRadialGradient')return ()=>gradient;return (...args)=>{if(name in calls)calls[name]++;for(const value of args)assert.ok(Number.isFinite(value)||typeof value!=='number',`${String(name)} received ${value}`);};},set(target,name,value){target[name]=value;return true;}});
  const card={dataset:{energy:'think',colors:'#a4f5d5,#21c6a1,#087a77,#c4ffe7',started:new Date(Date.now()-75_000).toISOString()},elapsed:{textContent:''},querySelector(){return this.elapsed;}};
  const canvas={dataset:{thinking:'run_1'},isConnected:true,clientWidth:520,clientHeight:112,width:0,height:0,getContext:()=>context,closest:()=>card,parentElement:card};
  const window={devicePixelRatio:2,matchMedia:()=>({matches:reduced})};
  const ctx=vm.createContext({window,requestAnimationFrame:callback=>frames.push(callback),setTimeout:callback=>timers.push(callback),Date,Math,Number,String,Array,Proxy});
  vm.runInContext(wavesSource,ctx,{filename:'thinking-waves.js'});
  const root={querySelectorAll:()=>[canvas]};
  return {ctx,canvas,card,frames,timers,calls,mount:()=>window.StudioThinking.mount(root)};
}

test('thinking waves animate in the bot colors, start once per canvas and stop when the card leaves',()=>{
  const h=wavesHarness();h.mount();h.mount();
  assert.equal(h.frames.length,1,'a canvas is started only once');
  assert.equal(h.canvas.width,1040);assert.equal(h.canvas.height,224);
  for(let time=16;time<=3200;time+=16){const frame=h.frames.shift();assert.ok(frame,'the loop keeps running while connected');frame(time);}
  assert.ok(h.calls.stroke>1000);assert.ok(h.calls.arc>100);
  assert.equal(h.card.elapsed.textContent,'1m 15s');
  h.card.dataset.energy='talk';h.card.dataset.peerColors='#d9baff,#9970ed,#5931ad,#efdcff';h.frames.shift()(3216);
  h.canvas.isConnected=false;h.frames.shift()(3232);
  assert.equal(h.frames.length,0,'a removed card stops its loop');
});

test('reduced motion draws one still frame and keeps only the elapsed time ticking',()=>{
  const h=wavesHarness({reduced:true});h.mount();
  assert.equal(h.frames.length,0);assert.ok(h.calls.stroke>0);
  const drawn=h.calls.stroke;assert.equal(h.timers.length,1);
  h.timers.shift()();assert.equal(h.calls.stroke,drawn,'an unchanged size is not redrawn');
  h.canvas.clientWidth=300;h.timers.shift()();assert.ok(h.calls.stroke>drawn,'a resize redraws the still frame');
  h.canvas.isConnected=false;h.timers.shift()();assert.equal(h.timers.length,0);
});
