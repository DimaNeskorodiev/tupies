import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createStudioServer } from '../server.mjs';
import { Store, ensure } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { usageReport, localDay } from '../lib/usage-report.mjs';
import { usageSummary, addModelCall } from '../lib/run-usage.mjs';
import { TONES, validateTone, toneGuidance } from '../lib/bot-tone.mjs';
import { rememberFact, undoFact } from '../lib/agent-tools.mjs';
import { systemPrompt } from '../lib/prompt-context.mjs';

const read=name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8');
const app=await read('app.js'),index=await read('index.html');

// ---- G1 Usage per bot and per day ---------------------------------------------------------------------

const used=(tokens,costUsd,extra={})=>({steps:2,toolCalls:1,modelCalls:2,inputTokens:tokens,cachedTokens:tokens,cacheWriteTokens:0,outputTokens:100,totalTokens:tokens*2+100,cachePercent:50,...(costUsd===null?{}:{costUsd,costSource:'catalog'}),...extra});
const at=(daysAgo,hour=10)=>{const date=new Date(2026,10,10,hour,0,0);date.setDate(date.getDate()-daysAgo);return date.toISOString();};
const NOW=new Date(2026,10,10,18,0,0).getTime();

test('the usage report adds finished tasks per bot and per local day, without counting a task twice',()=>{
  const state={bots:[{id:'a',name:'Roki'},{id:'b',name:'Ops'},{id:'c',name:'Idle'}],
    runHistory:{a:[
      {id:'run1',status:'completed',source:'chat',task:'  Summarise   the report ',createdAt:at(0,9),finishedAt:at(0),metering:used(1000,0.01)},
      {id:'run2',status:'failed',source:'routine',task:'Nightly check',createdAt:at(1),finishedAt:at(1),metering:used(5000,0.05)},
      {id:'old',status:'completed',task:'Too old',createdAt:at(30),finishedAt:at(30),metering:used(9000,9)},
      {id:'nometer',status:'completed',task:'Before metering existed',createdAt:at(0),finishedAt:at(0)}]},
    messages:{a:[
      {id:'m0',role:'user',content:'Summarise the report',createdAt:at(0,9)},
      {id:'m1',role:'assistant',content:'Done.',runId:'run1',createdAt:at(0),usage:used(1000,0.01)},
      {id:'m2',role:'user',content:'An older request that left the run history',createdAt:at(2,8)},
      {id:'m3',role:'assistant',content:'Done.',runId:'run0',createdAt:at(2),usage:used(2000,0.02)}],
      b:[{id:'n1',role:'user',content:'Hello',createdAt:at(0,8)},{id:'n2',role:'assistant',content:'Hi.',runId:'runb',createdAt:at(0),usage:used(300,0.003)}]}};
  const report=usageReport(state,{days:7,now:NOW});
  assert.equal(report.days,7);assert.equal(report.rankedBy,'cost');
  // run1 is in both the history and the chat and is counted once; the 30-day-old task and the unmetered one are left out.
  assert.deepEqual([report.totals.tasks,report.totals.totalTokens,report.totals.costUsd,report.totals.unpricedTasks,report.totals.cachePercent],[4,17_000,0.083,0,50]);
  assert.deepEqual(report.bots.map(row=>[row.name,row.tasks,row.costUsd]),[['Roki',3,0.08],['Ops',1,0.003]]);
  assert.equal(report.daily.length,7);assert.equal(report.daily.at(-1).day,localDay(NOW));
  assert.deepEqual(report.daily.slice(-3).map(row=>row.tasks),[1,1,2]);assert.equal(report.daily[0].tasks,0);
  assert.deepEqual(report.top.map(row=>[row.botName,row.task,row.status,row.source]),[['Roki','Nightly check','failed','routine'],['Roki','An older request that left the run history','completed','chat'],['Roki','Summarise the report','completed','chat'],['Ops','Hello','completed','chat']]);
  // Titles are bounded and never include reply text.
  assert.equal(JSON.stringify(report).includes('Done.'),false);
  assert.equal(usageReport(state,{days:1,now:NOW}).totals.tasks,2);
  assert.equal(usageReport({bots:[]},{now:NOW}).totals.tasks,0);
  // An out-of-range period falls back to the default instead of scanning everything.
  assert.equal(usageReport(state,{days:5000,now:NOW}).days,14);
});

test('tasks without a price are ranked by tokens and never turned into dollars',()=>{
  const state={bots:[{id:'a',name:'Roki'}],runHistory:{a:[
    {id:'r1',task:'Small priced',createdAt:at(0),finishedAt:at(0),metering:used(100,0.5)},
    {id:'r2',task:'Large unpriced',createdAt:at(0),finishedAt:at(0),metering:used(50_000,null)},
    {id:'r3',task:'Subscription',createdAt:at(0),finishedAt:at(0),metering:used(700,null,{costSource:'subscription'})}]},messages:{}};
  const report=usageReport(state,{days:7,now:NOW});
  assert.equal(report.rankedBy,'tokens');assert.deepEqual(report.top.map(row=>row.task),['Large unpriced','Subscription','Small priced']);
  // The subscription task is not "unpriced"; the unknown one is.
  assert.deepEqual([report.totals.costUsd,report.totals.unpricedTasks],[0.5,1]);
});

async function server(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'studio-quick-wins-'));
  const studio=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});
  t.after(async()=>{await studio.close();await rm(directory,{recursive:true,force:true});});
  const {url}=await studio.listen(0);
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:studio.bootstrapToken,password:'quick-wins-fixture-password'})});
  assert.equal(setup.status,201);
  const {csrf}=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  return {studio,url,headers:{'Content-Type':'application/json','Cookie':cookie,'X-CSRF-Token':csrf},cookie};
}

test('GET /api/usage needs a signed-in owner and validates the period',async t=>{
  const {studio,url,cookie}=await server(t);
  assert.equal((await fetch(url+'/api/usage')).status,401);
  await studio.store.mutate(state=>{(state.runHistory ||= {}).bot_atlas=[{id:'r1',status:'completed',task:'A task',createdAt:new Date().toISOString(),finishedAt:new Date().toISOString(),metering:usageSummary(addModelCall(undefined,{prompt_tokens:900,completion_tokens:100}),{steps:1})}];});
  const response=await fetch(url+'/api/usage?days=7',{headers:{Cookie:cookie}});
  assert.equal(response.status,200);
  const report=await response.json();
  assert.deepEqual([report.days,report.totals.tasks,report.totals.totalTokens,report.bots[0].botId,report.top[0].task],[7,1,1000,'bot_atlas','A task']);
  for(const bad of ['0','91','abc','1.5'])assert.equal((await fetch(`${url}/api/usage?days=${bad}`,{headers:{Cookie:cookie}})).status,400,bad);
  assert.equal((await (await fetch(url+'/api/usage',{headers:{Cookie:cookie}})).json()).days,14);
});

test('the usage screen is a settings tab drawn from numbers, with a table behind the chart',async()=>{
  assert.ok(app.includes("['usage','Usage','activity']"));assert.ok(app.includes("case 'usage':return window.StudioUsage?.render(studioContext())"));
  assert.match(index,/<script defer src="\/usage\.js"><\/script>/);assert.match(index,/<link rel="stylesheet" href="\/usage\.css">/);
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only'});
  dom.window.eval(await read('run-usage.js'));dom.window.eval(await read('usage.js'));
  const report=usageReport({bots:[{id:'a',name:'Ro<b>ki'}],runHistory:{a:[{id:'r1',task:'<img src=x onerror=alert(1)>',createdAt:at(0),finishedAt:at(0),metering:used(1000,0.01)}]},messages:{}},{days:7,now:NOW});
  let resolve;const loaded=new Promise(done=>{resolve=done;});
  const context={esc:value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),icon:()=>'',route:()=>({view:'usage'}),settingsHeading:()=>'',errorText:error=>error.message,api:async pathname=>{assert.equal(pathname,'/api/usage?days=14');queueMicrotask(resolve);return report;}};
  const root=dom.window.document.querySelector('main');root.innerHTML=dom.window.StudioUsage.render(context);
  assert.ok(root.querySelector('[aria-busy="true"]'));
  await loaded;await new Promise(done=>setTimeout(done,0));
  assert.equal(root.querySelectorAll('img,b').length,0,'names and titles are escaped');
  assert.match(root.textContent,/Tasks1/);assert.match(root.textContent,/≈ \$0\.01/);assert.match(root.textContent,/By bot/);assert.match(root.textContent,/Tasks that cost the most/);assert.match(root.textContent,/By day/);
  // One series: no legend, every column carries its exact value for hover and keyboard, and the day table repeats it.
  const bars=[...root.querySelectorAll('.usage-bar')];
  assert.equal(bars.length,7);assert.ok(bars.every(bar=>bar.getAttribute('tabindex')==='0' && bar.getAttribute('aria-label') && bar.dataset.label));
  assert.match(bars.at(-1).dataset.label,/2\.1K tokens, 1 task$/);
  dom.window.close();
});

// ---- G2 Approval cards in plain words ---------------------------------------------------------------

test('an approval is described in a sentence with its inputs, and the exact request stays under Details',async()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only'});dom.window.eval(await read('approval-summary.js'));
  const ui=dom.window.StudioApprovals,root=dom.window.document.querySelector('main');
  const show=(tool,args,review)=>{const control={tool,arguments:args,...(review?{review}:{})};root.innerHTML=ui.body(control,JSON.stringify({tool,arguments:args},null,2));return {title:ui.title(control),text:root.textContent};};
  let card=show('terminal',{command:'npm test -- --watch=false',cwd:'app',timeoutMs:120000});
  assert.equal(card.title,'Run a command');assert.match(card.text,/Run this command in the bot’s terminal\./);
  assert.deepEqual([...root.querySelectorAll('.approval-inputs dt')].map(node=>node.textContent),['Command','Folder','Time limit']);
  assert.equal(root.querySelector('.approval-inputs dd.is-block').textContent,'npm test -- --watch=false');assert.match(card.text,/120 s/);
  // The exact request is present but collapsed.
  assert.equal(root.querySelector('details.approval-raw').open,false);assert.match(root.querySelector('details.approval-raw pre').textContent,/"tool": "terminal"/);
  card=show('http_fetch',{url:'https://api.example.com/orders?id=1',method:'post',body:{item:1}});
  assert.equal(card.title,'Send a web request');assert.match(card.text,/Send a POST request to api\.example\.com\./);
  card=show('workspace_delete',{path:'notes/old.md'});assert.match(card.text,/Delete notes\/old\.md\. This cannot be undone here\./);
  // The engine's own summary wins over the generic sentence; internal identifiers are not listed as inputs.
  card=show('browser_click',{ref:'e12',revision:7,label:'Place order'},{summary:'Click “Place order” on shop.example.com.',riskReason:'This may submit a purchase.'});
  assert.match(card.text,/Click “Place order” on shop\.example\.com\./);assert.match(card.text,/This may submit a purchase\./);
  assert.deepEqual([...root.querySelectorAll('.approval-inputs dt')].map(node=>node.textContent),['Label']);
  // An unknown tool is still readable, and nothing from the request becomes markup.
  card=show('some_new_tool',{note:'<img src=x onerror=alert(1)>',count:3});
  assert.equal(card.title,'Some new tool');assert.match(card.text,/Allow the action “some new tool”\./);assert.equal(root.querySelectorAll('img').length,0);
  assert.equal(ui.body(null,''),'');assert.equal(ui.body({arguments:{}},''),'');
  dom.window.close();
  assert.ok(app.includes("control?.tool!=='workshop_poll_api'&&window.StudioApprovals?.body(control,detail)"));
  assert.match(index,/<script defer src="\/approval-summary\.js"><\/script>/);
});

// ---- G3 "I'll remember that" with Undo ------------------------------------------------------------------

test('a replaced fact keeps the value it replaced, and Undo restores it or removes a new fact',()=>{
  const state={memory:{}},source={kind:'owner-chat',observedAt:'2026-11-10T10:00:00.000Z'};
  const first=rememberFact(state,'bot',{key:'coffee',value:'flat white',source});
  assert.equal(first.previous,undefined);
  const second=rememberFact(state,'bot',{key:'coffee',value:'oat latte',source});
  assert.equal(second.id,first.id);assert.equal(second.previous.value,'flat white');
  // Saving the same value again, or only pinning, keeps the earlier previous value.
  assert.equal(rememberFact(state,'bot',{key:'coffee',value:'oat latte',pinned:true,source}).previous.value,'flat white');
  const current=state.memory.bot[0];
  // A stale revision is refused, so a fact changed since is never overwritten.
  assert.throws(()=>undoFact(state,'bot',current.id,second.revision),error=>error.status===409);
  assert.throws(()=>undoFact(state,'bot','missing',current.revision),error=>error.status===404);
  assert.deepEqual(undoFact(state,'bot',current.id,current.revision),{undone:true,restored:true,key:'coffee'});
  assert.deepEqual([state.memory.bot[0].value,Boolean(state.memory.bot[0].pinned),state.memory.bot[0].previous],['flat white',false,undefined]);
  // Undoing a fact that was new removes it.
  const fresh=rememberFact(state,'bot',{key:'tea',value:'none',source});
  assert.deepEqual(undoFact(state,'bot',fresh.id,fresh.revision),{undone:true,restored:false,key:'tea'});
  assert.deepEqual(state.memory.bot.map(entry=>entry.key),['coffee']);
});

test('a task that saves a fact leaves a receipt with what was learned, and the owner can undo it over the API',async t=>{
  const {studio,url,headers}=await server(t);
  const store=studio.store,BOT='bot_atlas';
  await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'m'});for(const bot of state.bots){bot.connectionId='fixture';bot.model='m';bot.tools=['memory'];}rememberFact(state,BOT,{key:'report_day',value:'Friday',source:{kind:'owner-edit',observedAt:new Date().toISOString()}});});
  const directory=await mkdtemp(path.join(tmpdir(),'studio-quick-wins-engine-'));let engine;
  t.after(async()=>{try{await engine?.close();}finally{await rm(directory,{recursive:true,force:true});}});
  let calls=0;
  engine=new NativeEngine(store,{providers:{async complete(){calls++;return calls===1?{text:'',toolCalls:[{id:'save',name:'memory_set',arguments:{key:'report_day',value:'Monday'}}]}:{text:'Understood: reports on Monday from now on.',toolCalls:[]};}},runTimeout:10000});
  const started=await engine.start(BOT,'No, send the weekly report on Monday, not Friday.');await engine.tasks.get(started.id);
  assert.equal(store.state.runs[BOT].status,'completed');
  const owner=store.state.messages[BOT].find(message=>message.runId===started.id && message.role==='user');
  const receipt=owner.learningChanges.find(row=>row.kind==='memory');
  const entry=store.state.memory[BOT].find(item=>item.key==='report_day');
  assert.deepEqual([receipt.status,receipt.label,receipt.value,receipt.replaced,receipt.entryId,receipt.revision],['saved','report_day','Monday',true,entry.id,entry.revision]);
  const post=body=>fetch(`${url}/api/bots/${BOT}/memory/${entry.id}`,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await post({undo:true})).status,400);assert.equal((await post({undo:true,revision:'0'.repeat(64)})).status,409);
  assert.equal(store.state.memory[BOT].find(item=>item.key==='report_day').value,'Monday');
  const undone=await post({undo:true,revision:entry.revision});
  assert.equal(undone.status,200);assert.deepEqual(await undone.json(),{undone:true,restored:true,key:'report_day'});
  assert.equal(store.state.memory[BOT].find(item=>item.key==='report_day').value,'Friday');
  // The receipt now says it was undone, and a second Undo is refused.
  assert.equal(store.state.messages[BOT].find(message=>message.runId===started.id && message.role==='user').learningChanges.find(row=>row.kind==='memory').status,'undone');
  assert.equal((await post({undo:true,revision:entry.revision})).status,409);
});

test('the remember receipt shows what was learned with an Undo button, and an undone one stays without it',async()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only'});dom.window.eval(await read('chat-learning.js'));
  const ui=dom.window.StudioChatLearning,root=dom.window.document.querySelector('main');
  const row={id:'run:learning:1',kind:'memory',status:'saved',label:'report_day',value:'Monday <b>',target:'report_day',entryId:'memory_1',revision:'a'.repeat(64),replaced:true,createdAt:new Date().toISOString()};
  root.innerHTML=ui.render([row],'bot_test');
  assert.match(root.textContent,/I’ll remember that/);assert.match(root.textContent,/report_day: Monday <b>/);assert.equal(root.querySelectorAll('b').length,0);
  const button=root.querySelector('button.learning-undo');
  assert.deepEqual([button.dataset.action,button.dataset.id,button.dataset.entry,button.dataset.revision,button.textContent],['undo-memory','bot_test','memory_1','a'.repeat(64),'Undo']);
  root.innerHTML=ui.render([{...row,status:'undone'}],'bot_test');
  assert.match(root.textContent,/Earlier memory restored/);assert.equal(root.querySelector('button.learning-undo'),null);assert.ok(root.querySelector('.learning-chip.is-undone'));
  root.innerHTML=ui.render([{...row,status:'undone',replaced:false}],'bot_test');assert.match(root.textContent,/Forgotten/);
  // An older receipt without the recorded revision has no Undo.
  root.innerHTML=ui.render([{id:'run:learning:2',kind:'memory',status:'saved',label:'k',createdAt:new Date().toISOString()}],'bot_test');assert.equal(root.querySelector('button.learning-undo'),null);
  dom.window.close();
  assert.ok(app.includes("case 'undo-memory':"));
});

// ---- G4 Tones of voice ----------------------------------------------------------------------------------

test('a tone of voice is one of a short list plus an optional note, and only shapes wording',()=>{
  assert.deepEqual(Object.keys(TONES),['','plain','warm','brisk','playful']);
  assert.deepEqual(validateTone({},ensure),{tone:'',toneNote:''});
  assert.deepEqual(validateTone({tone:'brisk',toneNote:'  dry, never uses emoji '},ensure),{tone:'brisk',toneNote:'dry, never uses emoji'});
  for(const bad of [{tone:'angry'},{tone:5},{tone:'constructor'},{toneNote:'x'.repeat(301)},{toneNote:'line\u0007bell'},{toneNote:{}}])assert.throws(()=>validateTone(bad,ensure),error=>error.status===400,JSON.stringify(bad));
  assert.equal(toneGuidance({}),'');assert.equal(toneGuidance({tone:'nonsense'}),'');
  assert.match(toneGuidance({tone:'warm'}),/^Voice: warm and personable\./);
  assert.match(toneGuidance({tone:'playful',toneNote:'a bit sarcastic'}),/never joke about problems, risks or failures\. The owner describes the voice they want: a bit sarcastic$/);
  for(const tone of Object.values(TONES))assert.ok(tone.guidance.length<=200);
});

test('the tone reaches the system prompt after the bot’s own instructions and saves through the API',async t=>{
  const bot={id:'b',name:'Roki',title:'Chief of Staff',instructions:'Keep answers under five lines.',tone:'brisk',toneNote:'no emoji'};
  const parts={offered:new Set(),available:[],permittedGroups:[]},prompt=systemPrompt({bot,...parts});
  const where=prompt.indexOf('Keep answers under five lines.'),voice=prompt.indexOf('Voice: brisk.');
  assert.ok(where>=0 && voice>where);assert.ok(prompt.includes('The owner describes the voice they want: no emoji'));
  assert.equal(systemPrompt({bot:{...bot,tone:undefined,toneNote:undefined},...parts}).includes('Voice:'),false);
  const {studio,url,headers}=await server(t);
  const patch=body=>fetch(url+'/api/bots/bot_atlas',{method:'PATCH',headers,body:JSON.stringify(body)});
  assert.equal((await patch({tone:'warm',toneNote:'call me Dima'})).status,200);
  assert.deepEqual([studio.store.state.bots[0].tone,studio.store.state.bots[0].toneNote],['warm','call me Dima']);
  assert.equal((await patch({tone:'shouty'})).status,400);assert.equal(studio.store.state.bots[0].tone,'warm');
  // Changing only the note keeps the tone; empty values clear both.
  assert.equal((await patch({toneNote:''})).status,200);assert.deepEqual([studio.store.state.bots[0].tone,studio.store.state.bots[0].toneNote],['warm',undefined]);
  assert.equal((await patch({tone:''})).status,200);assert.equal(studio.store.state.bots[0].tone,undefined);
  assert.ok(app.includes('name="tone"') && app.includes('name="toneNote"'));
});

// ---- G5 Avatar states ------------------------------------------------------------------------------------

test('compact avatars carry one of four states, decided from the same status the roster writes out',async()=>{
  const start=app.indexOf('function botAttention(bot){'),end=app.indexOf('function botStatus(bot) {');
  assert.ok(start>0 && end>start);
  const botAttention=vm.runInNewContext(`(botStatus,botHasUnread)=>{${app.slice(start,end)};return botAttention;}`)(bot=>bot.status,id=>id==='unread');
  assert.equal(botAttention({id:'x',status:{text:'Working',className:'working'}}),'working');
  assert.equal(botAttention({id:'x',status:{text:'Needs approval',className:'working attention'}}),'waiting');
  assert.equal(botAttention({id:'x',status:{text:'Connection issue',className:'error'}}),'blocked');
  assert.equal(botAttention({id:'unread',status:{text:'',className:'ready'}}),'unread');
  assert.equal(botAttention({id:'x',status:{text:'',className:'ready'}}),'');
  assert.equal(botAttention({id:'unread',enabled:false,status:{text:'Paused',className:''}}),'');assert.equal(botAttention(null),'');
  // Welcome and profile artwork stay undecorated; live updates use the same function.
  assert.ok(app.includes("${context?'':`data-avatar-status=\"${botAttention(bot)}\" `}"));
  assert.ok(app.includes("if(!element.dataset.avatarContext)element.dataset.avatarStatus=botAttention(bot);"));
  const css=await read('creature-avatars.css');
  for(const state of ['working','waiting','blocked','unread'])assert.ok(css.includes(`[data-avatar-status="${state}"]{--avatar-status:`),state);
  // Waiting and blocked also differ by shape, not only by colour.
  assert.match(css,/\[data-avatar-status="waiting"\]::after\{border-radius:35%\}/);assert.match(css,/\[data-avatar-status="blocked"\]::after\{[^}]*rotate\(45deg\)\}/);
});
