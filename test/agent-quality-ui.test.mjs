import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { Store } from '../lib/store.mjs';
import { dashboard } from '../lib/dashboard.mjs';

const profileSource=await readFile(new URL('../public/bot-profile.js',import.meta.url),'utf8');
const appSource=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
const at='2026-10-28T15:00:00.000Z';

function profile(t,runs){
  const dom=new JSDOM('<main id="main"></main>',{url:'http://studio.local/#/bots/bot_atlas',runScripts:'outside-only'}),win=dom.window,doc=win.document;
  vm.runInContext(profileSource,dom.getInternalVMContext());
  const data={bots:[{id:'bot_atlas',name:'Atlas',title:'Assistant',tools:['memory'],skills:[],collaborators:[],enabled:true}],connections:[],skills:[],routines:[],rooms:[],integrations:[],runs:{},activity:[]};
  const calls=[],ctx={data,botById:id=>data.bots.find(bot=>bot.id===id),botStatus:()=>({text:'Ready',className:'ready'}),statusPill:()=>'<span>Ready</span>',icon:()=>'<svg></svg>',avatar:()=>'<span></span>',relative:()=>'just now',errorText:error=>error.message,
    routineDialog:(...args)=>calls.push(args),api:async route=>route.endsWith('/runs')?{data:runs}:route.endsWith('/brain')?{notes:[],total:0,tags:[]}:route.includes('/files')?{files:[]}:route.endsWith('/proposals')?{proposals:[]}:{entries:[]}};
  const show=async()=>{doc.querySelector('#main').innerHTML=win.StudioBotProfile.render(ctx,'bot_atlas');win.StudioBotProfile.mount(ctx,'bot_atlas',doc);await tick();};
  t.after(()=>win.close());return {win,doc,ctx,calls,show};
}

test('task results expose only declared check coverage with escaped collapsed observations',async t=>{
  const h=profile(t,[{id:'run_checked',status:'completed',source:'chat',task:'Prepare <report>',finishedAt:at,verification:{coverage:'declared_checks',passed:true,checks:[{id:'report',kind:'file_contains',passed:true,detail:'Checked <report>.'}]},workRecords:[
    {tool:'workspace_write',status:'succeeded',outcome:'observed',path:'reports/report.md'},
    {tool:'integration_call',status:'failed',outcome:'unknown',error:'Lost after dispatch <img src=x onerror=alert(1)>.'},
    {tool:'workspace_read',status:'succeeded',path:'/private/host/location'},
  ]}]);
  await h.show();
  assert.equal(h.doc.querySelector('.bp-task-title').textContent,'Prepare <report>');
  assert.equal(h.doc.querySelector('.bp-task-checks').textContent,'1 declared check passed');
  const details=h.doc.querySelector('[data-task-evidence]');assert.equal(details.open,false);
  assert.match(details.textContent,/Tool activity|tool activity/);assert.match(details.textContent,/Outcome uncertain/);
  assert.match(details.textContent,/neither proves every part/);assert.match(details.textContent,/Checked <report>/);
  assert.doesNotMatch(details.textContent,/private\/host/);assert.equal(h.doc.querySelectorAll('img,script').length,0);
  details.open=true;await h.show();assert.equal(h.doc.querySelector('[data-task-evidence]').open,true,'open observations survive refresh');
});

test('failed, undeclared and malformed checks never render as verified task success',async t=>{
  const h=profile(t,[
    {id:'failed',status:'failed',task:'Report',verification:{coverage:'declared_checks',passed:false,checks:[{id:'report',kind:'file_exists',passed:false,detail:'Missing file.'}]}},
    {id:'legacy',status:'completed',task:'Chat response',verification:{coverage:'not_declared',passed:null,checks:[]}},
    {id:'unconfirmed',status:'completed',task:'Unknown coverage',verification:{coverage:'declared_checks',checks:[{id:'not_run',kind:'file_exists'}]}},
  ]);
  await h.show();const text=h.doc.querySelector('.bp-tasks').textContent;
  assert.match(text,/1 declared check failed/);assert.match(text,/No mechanical checks declared/);assert.match(text,/Some declared checks are unverified/);
  assert.doesNotMatch(text,/declared checks? passed/);
});

test('daily review requests source-backed note consolidation suggestions without direct note edits',async t=>{
  const h=profile(t,[]);await h.show();h.win.location.hash='#/bots/bot_atlas/learning';await h.show();
  h.doc.querySelector('[data-profile-action="setup-review"]').click();await tick();
  assert.equal(h.calls.length,1);const prompt=h.calls[0][2].prompt;
  assert.match(prompt,/Search existing Brain notes/);assert.match(prompt,/exact note paths and source messages/);assert.match(prompt,/do not merge, edit or delete notes/);assert.match(prompt,/memory_propose and skills_propose/);
});

test('episodic task notes default off and the advanced checkbox saves and reloads both choices',async t=>{
  const dom=new JSDOM('<div id="dialog-root"></div><div id="toasts"></div>',{url:'http://studio.local/#/bots',runScripts:'outside-only'}),win=dom.window,doc=win.document;
  win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});win.setInterval=()=>1;
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const context=dom.getInternalVMContext();vm.runInContext(appSource,context);
  win.fixtureData={bots:[{id:'bot_atlas',name:'Atlas',title:'Assistant',skills:[],tools:['workspace','memory'],collaborators:[],enabled:true}],connections:[],integrations:[],skills:[],runs:{},routines:[],rooms:[],settings:{}};
  const saves=[];win.fixtureApi=async(route,options)=>{saves.push(options.body);Object.assign(win.fixtureData.bots[0],options.body);return win.fixtureData.bots[0];};
  vm.runInContext('data={...initialState,...fixtureData};auth={authenticated:true,csrf:"fixture"};api=fixtureApi;refresh=async()=>{};renderApp=()=>{};toast=()=>{};',context);
  const open=()=>vm.runInContext("botDialog('bot_atlas')",context);
  open();assert.equal(doc.querySelector('[name="episodicMemory"]').checked,false);assert.equal(doc.querySelector('.bot-advanced').open,false);
  doc.querySelector('[name="episodicMemory"]').checked=true;doc.querySelector('#bot-form').dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(saves[0].episodicMemory,true);open();assert.equal(doc.querySelector('[name="episodicMemory"]').checked,true);
  doc.querySelector('[name="episodicMemory"]').checked=false;doc.querySelector('#bot-form').dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));await tick();
  assert.equal(saves[1].episodicMemory,false);open();assert.equal(doc.querySelector('[name="episodicMemory"]').checked,false);
  t.after(()=>win.close());
});

test('dashboard reports declared result checks and readable current tool steps',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'tupies-quality-dashboard-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init(),state=store.state,bot=state.bots[0],id=bot.id;
  state.activity=[{id:'activity_checked',type:'run.completed',botId:id,runId:'run_checked',createdAt:at,title:'Completed'}];
  state.messages[id]=[{id:'message_task',role:'user',source:'chat',runId:'run_checked',content:'Create a report.',createdAt:at,taskOutcome:{status:'completed',finishedAt:at,checks:{passed:1,failed:0}}}];
  state.runs[id]={id:'run_checked',botId:id,status:'completed',verification:{coverage:'declared_checks',passed:true,checks:[{id:'file',passed:true}]}};
  assert.match(dashboard(store).activity[0].detail,/1 declared check passed/);
  state.runHistory={[id]:[{...state.runs[id]}]};state.runs[id]={id:'new_run',botId:id,status:'running',createdAt:at,events:[]};
  const steps={task_outcome_check:'Checking the result',task_outcome_set:'Preparing result checks',work_records_read:'Reviewing earlier work',web_search:'Searching the web',workspace_image:'Looking at picture.png'};
  for(const [tool,expected] of Object.entries(steps)){state.runs[id].events=[{type:'tool.started',tool,arguments:{path:'picture.png'}}];assert.equal(dashboard(store).working[0].step,expected);}
  assert.match(dashboard(store).activity[0].detail,/1 declared check passed/,'shared outcome counts remain visible after a newer local run starts');
});
