import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createSpeechController} from '../public/speech.mjs';

const appSource=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const avatarSource=await readFile(new URL('../public/creature-avatars.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const plain=value=>JSON.parse(JSON.stringify(value));
const at=seconds=>new Date(Date.UTC(2026,10,9,7,49,seconds)).toISOString();

// The live run loop against a real DOM. Timers are captured, never run on their own,
// and every request is answered by a local fixture: no engine, account or model is used.
function ui(t,{events}={}) {
  const dom=new JSDOM('<!doctype html><div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:'http://studio.local/#/bot/bot_atlas',runScripts:'outside-only',pretendToBeVisual:true});
  const win=dom.window,doc=win.document,requests=[],timers=[];
  win.setInterval=()=>1;win.clearInterval=()=>{};win.scrollTo=()=>{};
  win.setTimeout=(fn,ms)=>{timers.push({fn,ms,cleared:false});return timers.length;};win.clearTimeout=id=>{if(timers[id-1])timers[id-1].cleared=true;};
  win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  win.fetch=()=>{throw new Error('This UI fixture must not use the network.');};
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  win.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const controller=createSpeechController(win);controller.setPreferences({engine:'browser'});win.StudioSpeech={controller};
  const context=dom.getInternalVMContext();vm.runInContext(avatarSource,context);vm.runInContext(appSource,context);
  const bot={id:'bot_atlas',name:'Atlas',title:'Chief of staff',description:'Plans useful work.',icon:'roki',color:'coral',connectionId:'provider',model:'model-a',tools:[],skills:[],enabled:true};
  win.fixtureData={settings:{defaultConnectionId:'provider'},bots:[bot,{id:'bot_nova',name:'Nova',title:'Research',connectionId:'provider',tools:[],skills:[]}],connections:[{id:'provider',name:'Fixture provider',type:'openai',status:'connected',defaultModel:'model-a'}]};
  const state={messages:{messages:[],run:null}};
  win.fixtureApi=async(path,options={})=>{
    requests.push(plain({path,...options}));
    if(path.startsWith('/api/bots/bot_atlas/events?'))return events(path,requests);
    if(path==='/api/bots/bot_atlas/messages')return {body:state.messages,etag:'"fixture"'};
    if(path.endsWith('/inference'))return {model:'model-a',effectiveModel:'model-a',defaultModel:'model-a',models:[],reasoning:{supported:false,efforts:[]},context:{window:128000,compactAt:115200,source:'provider'}};
    if(path==='/api/state')return {};
    throw new Error(`Unexpected fixture request: ${path}`);
  };
  vm.runInContext('data={...initialState,...fixtureData};auth={authenticated:true,csrf:"fixture"};api=fixtureApi;toast=()=>{};refresh=async()=>false;renderApp=()=>{};refreshUnread=async()=>{};',context);
  const run=code=>vm.runInContext(code,context);
  const open=(chatState)=>{doc.querySelector('#app').innerHTML=run("renderChat('bot_atlas')");win.fixtureChat=chatState;run("activeBot='bot_atlas';chat={loaded:true,...fixtureChat};renderThread(botById('bot_atlas'))");};
  const pending=()=>timers.filter(timer=>timer.ms===500&&!timer.cleared&&!timer.ran);
  const fire=async()=>{const [timer]=pending();assert.ok(timer,'expected a scheduled live poll');timer.ran=true;timer.fn();for(let i=0;i<6;i++)await tick();};
  t.after(()=>{controller.cleanup();win.close();});
  return {win,doc,requests,timers,state,run,open,pending,fire};
}

const liveRun={id:'run_live',status:'running',createdAt:at(0),partialOutput:'Looking at',events:[{id:'run_live:1',seq:1,type:'model.started',step:1,provider:'openrouter',model:'deepseek-v4.1-flash',createdAt:at(1)}]};
const toolEvents=[
  {id:'run_live:2',seq:2,type:'model.completed',step:1,toolCalls:1,createdAt:at(3)},
  {id:'run_live:3',seq:3,type:'tool.started',tool:'web_search',toolCallId:'call_1',arguments:{query:'hyperliquid vault apr',count:5},createdAt:at(3)},
  {id:'run_live:4',seq:4,type:'tool.completed',tool:'web_search',toolCallId:'call_1',preview:'ten results',createdAt:at(5)},
  {id:'run_live:5',seq:5,type:'model.started',step:2,model:'deepseek-v4.1-flash',createdAt:at(6)},
  {id:'run_live:6',seq:6,type:'tool.started',tool:'http_fetch',toolCallId:'call_2',arguments:JSON.stringify({url:'https://api.hyperliquid.xyz/info',method:'POST',body:{type:'vaultDetails'}}),createdAt:at(7)},
  {id:'run_live:7',seq:7,type:'tool.retry',tool:'http_fetch',attempt:2,createdAt:at(9)},
  {id:'run_live:8',seq:8,type:'tool.completed',tool:'http_fetch',toolCallId:'call_2',error:'HTTP 405',createdAt:at(12)},
  {id:'run_live:9',seq:9,type:'tool.started',tool:'skills_read',toolCallId:'call_3',arguments:{skillId:'market-data'},createdAt:at(12)},
  {id:'run_live:10',seq:10,type:'tool.skipped',tool:'skills_read',toolCallId:'call_3',reason:'duplicate read',createdAt:at(12)},
  {id:'run_live:11',seq:11,type:'tool.started',tool:'workspace_read',toolCallId:'call_4',arguments:{path:'reports/vault.md',secret:'never shown'},createdAt:at(13)}
];

test('the events loop patches the live message in place without rebuilding the thread',async t=>{
  let reply={runId:'run_live',status:'running',events:toolEvents,partialOutput:'Looking at the vault <page>',partialReasoning:'The info API is POST-only, so <fetch> needs a body.'};
  const h=ui(t,{events:()=>reply});
  h.open({messages:[{id:'m1',role:'user',content:'Track this vault',runId:'run_live'}],run:structuredClone(liveRun)});
  const thread=h.doc.querySelector('#chat-thread'),live=thread.querySelector('[data-live-run="run_live"]'),userMessage=thread.querySelector('[data-message-key]');
  assert.ok(live,'live message rendered');assert.equal(h.pending().length,1,'one live poll scheduled');
  assert.match(live.querySelector('[data-live-strip]').textContent,/^Step 1 · deepseek-v4\.1-flash · \d/);
  assert.equal(live.querySelector('[data-live-thinking]').hidden,true,'no reasoning yet');

  await h.fire();
  assert.deepEqual(h.requests.map(request=>request.path).filter(path=>!path.endsWith('/inference')),['/api/bots/bot_atlas/events?after=1']);
  assert.equal(h.doc.querySelector('#chat-thread'),thread);assert.equal(thread.querySelector('[data-live-run="run_live"]'),live,'live node kept');assert.equal(thread.querySelector('[data-message-key]'),userMessage,'transcript nodes kept');
  assert.match(live.querySelector('[data-live-text]').textContent,/Looking at the vault <page>/);
  const thinking=live.querySelector('[data-live-thinking]');
  assert.equal(thinking.hidden,false);assert.equal(thinking.open,true);assert.equal(thinking.querySelector('summary').textContent,'Thinking…');
  assert.equal(thinking.querySelector('[data-live-reasoning]').textContent,reply.partialReasoning);assert.equal(thinking.querySelector('[data-live-reasoning]').children.length,0,'reasoning stays plain text');
  const strip=live.querySelector('[data-live-strip]').textContent;
  assert.match(strip,/Step 2 · deepseek-v4\.1-flash · \d/);assert.match(strip,/workspace_read · reports\/vault\.md · \d/);assert.doesNotMatch(strip,/never shown/);
  const tools=live.querySelector('[data-run-activity]');assert.equal(tools.hidden,false);assert.match(tools.querySelector('summary').textContent,/4 tool calls/);
  assert.equal(h.pending().length,1,'next poll scheduled');

  // Unchanged response: no request overlap, no duplicate events.
  reply={runId:'run_live',status:'running',events:toolEvents.slice(-2),partialOutput:'Looking at the vault <page>'};
  await h.fire();assert.equal(h.requests.at(-1).path,'/api/bots/bot_atlas/events?after=11');assert.equal(h.run('chat.run.events.length'),11);

  // The run finishes: the fast loop stops and one transcript refresh draws the result.
  reply={runId:'run_live',status:'completed',events:[]};
  h.state.messages={messages:[{id:'m1',role:'user',content:'Track this vault',runId:'run_live'},{id:'m2',role:'assistant',content:'The vault is up 4% this week.',reasoning:'Compared <two> snapshots.',runId:'run_live'}],run:{...liveRun,status:'completed',partialOutput:'',events:[...liveRun.events,...toolEvents,{id:'run_live:12',seq:12,type:'tool.completed',tool:'workspace_read',toolCallId:'call_4',createdAt:at(14)}]}};
  await h.fire();
  assert.equal(h.requests.at(-1).path,'/api/bots/bot_atlas/messages');assert.equal(h.pending().length,0,'no fast poll after completion');
  assert.equal(thread.querySelector('[data-live-run]'),null);
  const answer=[...thread.querySelectorAll('.chat-message')].find(node=>node.textContent.includes('up 4%')),saved=answer.querySelector('.thinking-block');
  assert.equal(saved.open,false);assert.equal(saved.querySelector('summary').textContent,'Thinking');assert.equal(saved.querySelector('.thinking-text').textContent,'Compared <two> snapshots.');
  const activity=answer.nextElementSibling;assert.ok(activity.matches('.run-activity-attached'),'activity attached to the run’s last message');
  assert.equal(activity.querySelector('details').open,false);assert.match(activity.querySelector('summary').textContent,/Activity4 tool calls/);
});

test('the fast loop never polls without an active run and stops on a bot switch',async t=>{
  const h=ui(t,{events:()=>{throw new Error('must not poll');}});
  h.open({messages:[],run:{id:'run_done',status:'completed',events:liveRun.events}});
  assert.equal(h.pending().length,0);
  h.open({messages:[],run:{id:'run_wait',status:'waiting_for_approval',events:[]}});
  assert.equal(h.pending().length,0,'a human wait uses the normal poll');
  h.open({messages:[],run:structuredClone(liveRun)});assert.equal(h.pending().length,1);
  h.run("activeBot='bot_nova'");await h.fire();
  assert.equal(h.requests.filter(request=>request.path.includes('/events')).length,0);assert.equal(h.pending().length,0);
});

test('a transcript poll keeps newer live text and events for the same run',t=>{
  const h=ui(t,{events:()=>({})});
  const merged=h.run(`mergeLiveRun(${JSON.stringify({...liveRun,partialOutput:'Looking at the vault',partialReasoning:'Two steps',events:[...liveRun.events,...toolEvents]})},${JSON.stringify(liveRun)})`);
  assert.equal(merged.partialOutput,'Looking at the vault');assert.equal(merged.partialReasoning,'Two steps');assert.equal(merged.events.length,11);
  const newer=h.run(`mergeLiveRun(${JSON.stringify({...liveRun,partialOutput:'Stale text'})},${JSON.stringify({...liveRun,partialOutput:'',events:[...liveRun.events,toolEvents[0]]})})`);
  assert.equal(newer.partialOutput,'','newer events win, including a reset partial');
});

test('the activity list summarizes arguments, durations and outcomes from run events',t=>{
  const h=ui(t,{events:()=>({})});
  h.win.fixtureRun={...liveRun,events:[...liveRun.events,...toolEvents]};
  const activity=h.run('runActivity(fixtureRun)');
  assert.equal(activity.step,2);assert.deepEqual(plain(activity.tools.map(item=>[item.tool,item.argument,item.outcome,item.retries])),[['web_search','hyperliquid vault apr','ok',0],['http_fetch','https://api.hyperliquid.xyz/info','error',1],['skills_read','market-data','skipped',0],['workspace_read','reports/vault.md','running',0]]);
  const strip=h.run(`runActivityStrip(runActivity(fixtureRun),Date.parse(${JSON.stringify(at(16))}))`);
  assert.equal(h.doc.createRange().createContextualFragment(strip).textContent,'Step 2 · deepseek-v4.1-flash · 10sworkspace_read · reports/vault.md · 3.0s');
  const list=h.doc.createElement('ol');list.innerHTML=h.run(`runActivityItems(runActivity(fixtureRun),{now:Date.parse(${JSON.stringify(at(16))})})`);
  assert.deepEqual([...list.children].map(item=>item.textContent),['web_searchhyperliquid vault apr2.0sok','http_fetchhttps://api.hyperliquid.xyz/info5.0serror · 1 retry','skills_readmarket-data0.0sskipped','workspace_readreports/vault.md3.0srunning']);
  assert.doesNotMatch(list.innerHTML,/vaultDetails|never shown/);
  list.innerHTML=h.run('runActivityItems(runActivity(fixtureRun),{final:true})');assert.equal(list.lastElementChild.textContent,'workspace_readreports/vault.mdstopped');
  assert.equal(h.run(`toolArgumentSummary({command:'ls -la',args:['x']})`),'');
});

test('provider presets render generically from the catalog',t=>{
  const h=ui(t,{events:()=>({})});
  h.run(`providerCatalog=[{type:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com/v1',auth:'api-key',transport:'chat-completions'},{type:'lmstudio',name:'LM Studio',baseUrl:'http://127.0.0.1:1234/v1',auth:'none',transport:'chat-completions'},{type:'chatgpt',name:'ChatGPT / Codex subscription',auth:'oauth'},{type:'custom',name:'OpenAI-compatible API',baseUrl:'',auth:'api-key'}];data.connections=[{id:'c1',name:'Research key',type:'deepseek',status:'connected',hasKey:true},{id:'c2',name:'Desk',type:'lmstudio',status:'connected'},{id:'c3',name:'Odd',type:'futurecloud',status:'error'}];`);
  const page=h.doc.createElement('div');page.innerHTML=h.run('renderConnections()');
  const choices=[...page.querySelectorAll('.provider-choice')].map(item=>[item.dataset.type,item.querySelector('strong').textContent,item.querySelector('small').textContent,item.querySelector('.provider-letter').textContent]);
  assert.deepEqual(choices,[['deepseek','DeepSeek','API key','D'],['lmstudio','LM Studio','Local endpoint','L'],['chatgpt','ChatGPT / Codex subscription','Sign in with your plan','C'],['custom','OpenAI-compatible API','API key','O']]);
  const cards=[...page.querySelectorAll('.connection-card')].map(card=>[card.querySelector('.connection-info p').textContent,card.querySelector('.connection-capabilities .tag').textContent]);
  assert.deepEqual(cards,[['DeepSeek','Key encrypted on server'],['LM Studio','Local endpoint'],['futurecloud','Credentials needed']]);
  h.run("chooseProviderDialog()");assert.deepEqual([...h.doc.querySelectorAll('dialog .provider-choice small')].map(item=>item.textContent),['API key','Local endpoint','Sign in with your plan','API key']);
  h.run("connectionDialog(undefined,'lmstudio')");let form=h.doc.querySelector('#connection-form');
  assert.equal(form.querySelector('[name=apiKey]'),null);assert.equal(form.querySelector('[name=baseUrl]').value,'http://127.0.0.1:1234/v1');assert.equal(form.querySelector('[name=baseUrl]').required,true);assert.equal(form.querySelector('[name=name]').value,'LM Studio');
  h.run("connectionDialog(undefined,'deepseek')");form=h.doc.querySelector('#connection-form');
  assert.ok(form.querySelector('[name=apiKey]'));assert.equal(form.querySelector('[name=baseUrl]').required,false);assert.equal(form.querySelector('.advanced-fields').open,false);
  h.run("connectionDialog(undefined,'custom')");form=h.doc.querySelector('#connection-form');
  assert.equal(form.querySelector('[name=baseUrl]').required,true);assert.equal(form.querySelector('.advanced-fields').open,true);
});
