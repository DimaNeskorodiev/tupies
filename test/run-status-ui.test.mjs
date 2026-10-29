import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const activityModel=await readFile(new URL('../public/activity-flow-model.js',import.meta.url),'utf8');

// Run the actual browser rendering code against small deterministic DOM targets.
// No account, provider or browser session is used by these regression tests.
function harness(run,messages=[{role:'user',content:'Please work on this task.'}]) {
  const thread={innerHTML:'',scrollTop:0,clientHeight:500,scrollHeight:500,querySelector(){return null;}};
  const send={disabled:false};
  const document={
    hidden:false,activeElement:null,addEventListener(){},querySelectorAll(){return [];},
    querySelector(selector){if(selector==='#chat-thread'||selector==='#room-thread')return thread;if(selector==='#message-form .send'||selector==='#room-message-form .send')return send;return null;}
  };
  const ctx=vm.createContext({document,window:{addEventListener(){}},location:{hash:'#/bot/bot_qa'},URL,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(source,ctx,{filename:'app.js'});
  ctx.fixtureBot={id:'bot_qa',name:'QA Bot',title:'Test specialist',connectionId:'provider_qa',model:'',color:'mint',tools:[],skills:[],enabled:true};
  ctx.fixtureRun=run;ctx.fixtureMessages=messages;
  ctx.fixtureOpen=(title,html)=>{ctx.dialog={title,html};};
  vm.runInContext("data={...initialState,bots:[fixtureBot],connections:[{id:'provider_qa',type:'openai',name:'QA Provider',status:'connected',defaultModel:'qa-model'}],rooms:[{id:'room_qa',name:'QA Room',botIds:['bot_qa'],maxRounds:8}]};chat={messages:fixtureMessages,run:fixtureRun};activeBot=fixtureBot.id;openDialog=fixtureOpen;",ctx);
  const render=()=>{vm.runInContext('renderThread(fixtureBot)',ctx);return thread.innerHTML;};
  return {ctx,thread,send,render,run:code=>vm.runInContext(code,ctx)};
}

test('stopping a run keeps its escaped partial answer visible and enables another message',()=>{
  const h=harness({id:'run_stopped',status:'cancelled',partialOutput:'Partial <answer> & detail',events:[]});
  const html=h.render();
  assert.match(html,/Partial response/);assert.match(html,/Partial &lt;answer&gt; &amp; detail/);
  assert.match(html,/Task stopped\. Any available partial response is shown above\./);
  assert.doesNotMatch(html,/data-action="stop-run"/);assert.equal(h.send.disabled,false);
});

test('a failed turn displays preserved output and the provider error without marking it completed',()=>{
  const h=harness({id:'run_failed',status:'failed',partialOutput:'',output:'Available incomplete answer',error:{message:'The model reached its <limit>.'},events:[]});
  const html=h.render();
  assert.match(html,/Partial response/);assert.match(html,/Available incomplete answer/);
  assert.match(html,/The model reached its &lt;limit&gt;\./);assert.match(html,/run-status run-error/);
  assert.doesNotMatch(html,/data-action="stop-run"/);assert.equal(h.send.disabled,false);
});

test('a completed answer appears once even when its final text is also retained as partial output',()=>{
  const answer='One final answer from the actual transcript.';
  const h=harness({id:'run_complete',status:'completed',partialOutput:answer,output:answer,events:[]},[{role:'user',content:'Complete this task.'},{role:'assistant',content:answer}]);
  const html=h.render();
  assert.equal(html.split(answer).length-1,1);assert.doesNotMatch(html,/partial-message|Partial response|run-error/);
  assert.equal(h.send.disabled,false);
});

test('a persisted partial answer is labeled and never duplicated by the current stopped run',()=>{
  const partial='Persisted stopped text <with detail>';
  const h=harness({id:'run_stopped',status:'cancelled',partialOutput:partial,events:[]},[{role:'user',content:'Work until stopped.'},{role:'assistant',content:partial,partial:true,runStatus:'cancelled',runId:'run_stopped'}]);
  const html=h.render();
  assert.equal(html.split('Persisted stopped text &lt;with detail&gt;').length-1,1);
  assert.equal(html.split('Partial response').length-1,1);assert.match(html,/Task stopped/);
  assert.equal(h.send.disabled,false);
});

test('an earlier persisted partial remains visible once after a later task completes',()=>{
  const partial='An earlier incomplete answer.',complete='The next task completed normally.';
  const h=harness({id:'run_next',status:'completed',partialOutput:complete,output:complete,events:[]},[
    {role:'user',content:'First task.'},
    {role:'assistant',content:partial,partial:true,runStatus:'cancelled',runId:'run_old'},
    {role:'user',content:'Next task.'},
    {role:'assistant',content:complete,runId:'run_next'}
  ]);
  const html=h.render();
  assert.equal(html.split(partial).length-1,1);assert.equal(html.split(complete).length-1,1);
  assert.equal(html.split('Partial response').length-1,1);
  assert.ok(html.indexOf(partial)<html.indexOf(complete));assert.equal(h.send.disabled,false);
});

test('an active turn shows streamed text and Stop while preventing a concurrent message',()=>{
  const h=harness({id:'run_active',remoteRunId:'remote_active',status:'running',partialOutput:'Live streamed answer',events:[]});
  const html=h.render();
  assert.match(html,/Live streamed answer/);assert.match(html,/>Working</);assert.match(html,/QA Bot is writing/);assert.match(html,/data-energy="write"/);assert.match(html,/class="chat-message thinking-message is-compact"/);
  assert.match(html,/data-action="stop-run"/);assert.match(html,/&quot;runId&quot;:&quot;run_active&quot;/);
  assert.match(html,/&quot;remoteRunId&quot;:&quot;remote_active&quot;/);assert.equal(h.send.disabled,true);
  h.run("chat.run={...chat.run,status:'cancelled'}");
  const stopped=h.render();assert.match(stopped,/Live streamed answer/);assert.match(stopped,/Task stopped/);assert.equal(h.send.disabled,false);
});

test('long current steps stay in collapsed details while the graph uses a short status',()=>{
  const title='Перевірити шиномонтажі Вроцлава, включаючи ціни, години роботи, доступність зимових шин та способи запису цього тижня <details>';
  const h=harness({id:'run_long_plan',status:'running',events:[{type:'tool.started',tool:'task_plan_set'}],plan:{steps:[{id:'one',title,status:'in_progress'}]}});
  vm.runInContext(activityModel,h.ctx);
  const html=h.render(),copy=html.match(/<div class="thinking-copy">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(copy);assert.match(copy,/Working on step 1 of 1/);assert.ok(!copy.includes(title));
  assert.ok(html.includes(title.replace('<details>','&lt;details&gt;')));
  assert.doesNotMatch(copy,/visible plan steps|thinking-context/);assert.doesNotMatch(copy,/data-action="stop-run"|<canvas|<details>/);
  assert.match(html,/data-action="stop-run"/);assert.match(html,/Step 1 · In progress/);
});

test('new and edited team rooms offer the supported one-to-eight handoff range',()=>{
  const h=harness(null);
  h.run('roomDialog()');
  const create=h.ctx.dialog.html.match(/<input[^>]*id="room-rounds"[^>]*>/)?.[0];
  assert.ok(create);assert.match(create,/min="1"/);assert.match(create,/max="8"/);assert.match(create,/value="4"/);
  h.run('roomDialog("room_qa")');
  const edit=h.ctx.dialog.html.match(/<input[^>]*id="room-rounds"[^>]*>/)?.[0];
  assert.ok(edit);assert.match(edit,/min="1"/);assert.match(edit,/max="8"/);assert.match(edit,/value="8"/);
});

test('a delegated partial in the shared room renders once with its label and failed-drive notice',()=>{
  const h=harness(null);
  h.run("location.hash='#/room/room_qa';roomChat={messages:[{role:'user',content:'Verify this task.'},{role:'assistant',botId:'bot_qa',content:'Incomplete <finding>',partial:true,runStatus:'failed',delegated:true,runId:'run_child'}],drive:{id:'drive_qa',status:'failed',error:'The coordinator review is incomplete.'},activeRun:null};renderRoomThread('room_qa')");
  const html=h.thread.innerHTML;
  assert.match(html,/QA Bot/);assert.match(html,/Incomplete &lt;finding&gt;/);assert.match(html,/The coordinator review is incomplete\./);
  assert.equal(html.split('Partial response').length-1,1);assert.equal(html.split('Incomplete &lt;finding&gt;').length-1,1);
  assert.equal(h.send.disabled,false);
});

test('a durable plan renders escaped steps and preserves unfinished progress after Stop',()=>{
  const h=harness({id:'run_plan',status:'cancelled',events:[],plan:{steps:[{id:'one',title:'Inspect <script>alert(1)</script>',status:'completed'},{id:'two',title:'Verify & test',status:'in_progress'},{id:'three',title:'Report',status:'pending'}],explanation:'Keep <unfinished> steps visible.'}});
  const html=h.render();assert.match(html,/aria-label="Task plan"/);assert.match(html,/1 of 3 steps done/);
  assert.match(html,/Inspect &lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
  assert.match(html,/Verify &amp; test/);assert.match(html,/In progress/);assert.match(html,/Keep &lt;unfinished&gt;/);
  assert.match(html,/Task stopped/);assert.equal(h.send.disabled,false);
});

test('one collapsed panel contains the plan and short activity, keeping expansion only for its task',()=>{
  const h=harness({id:'run_details',status:'running',events:[
    {type:'model.started'},{type:'model.delta',text:'not activity'},
    {type:'tool.started',tool:'integration_call',arguments:{integrationId:'duckduckgo',tool:'web_search'}},
    {type:'tool.started',tool:'integration_call',arguments:{integrationId:'duckduckgo',tool:'web_search'}},
    {type:'tool.completed',tool:'integration_call',preview:'private raw result'},
  ],plan:{steps:[{id:'one',title:'Find useful sources',status:'in_progress'}]}});
  vm.runInContext(activityModel,h.ctx);
  const html=h.run('renderTimeline(fixtureRun)'),dom=new JSDOM(html),panel=dom.window.document.querySelector('details');
  try{
    assert.equal(panel.open,false);assert.equal(dom.window.document.querySelectorAll('details').length,1);
    assert.match(panel.querySelector('summary').textContent,/Task details.*0\/1 steps/);
    assert.equal(panel.querySelectorAll('.task-activity li').length,1);
    assert.match(panel.textContent,/Searching the internet/);assert.doesNotMatch(panel.textContent,/Work log|duckduckgo|integration_call|private raw result|model\.started/);
    h.ctx.fixtureContainer=dom.window.document.body;panel.open=true;
    assert.equal(h.run('taskDetailsOpen(fixtureContainer,fixtureRun)'),true);
    assert.equal(h.run("taskDetailsOpen(fixtureContainer,{id:'a_new_task'})"),false);
    h.ctx.document=dom.window.document;panel.querySelector('summary').focus();
    h.run('updateThreadContent(fixtureContainer,renderTimeline(fixtureRun,true))');
    assert.equal(dom.window.document.activeElement.tagName,'SUMMARY','a refresh preserves keyboard focus on the disclosure');
  }finally{dom.window.close();}
});
