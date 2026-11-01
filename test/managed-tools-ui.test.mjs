import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const processIdentity={botId:'bot_qa',runId:'run_qa',remoteRunId:'remote_qa',processId:'process_qa'};
const background={id:'process_qa',botId:'bot_qa',runId:'run_qa',executable:'node',args:['verify.js'],cwd:'project',status:'running',outputPreview:'First output'};
const currentRun=()=>({id:'run_qa',remoteRunId:'remote_qa',botId:'bot_qa',status:'running',events:[],backgroundProcesses:[background],languageServers:[{id:'lsp_qa',server:'TypeScript',rootPath:'project',status:'ready'}]});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness({run=currentRun(),request=async()=>({status:'running',output:'First page',nextOffset:null})}={}) {
  const dom=new JSDOM('<div id="chat-thread"></div><form id="message-form"><button class="send"></button></form><div id="dialog-root"></div><div id="toasts"></div>');
  const {window}=dom;window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
  const requests=[],toasts=[],refreshes=[];
  const ctx=vm.createContext({document:window.document,window,location:{hash:'#/bot/bot_qa'},URL,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(source,ctx,{filename:'app.js'});
  ctx.realFixtureApi=vm.runInContext('api',ctx);
  ctx.fixtureBot={id:'bot_qa',name:'QA Bot',title:'QA',connectionId:'fixture',color:'mint',tools:[],skills:[],enabled:true};ctx.fixtureRun=run;ctx.fixtureIdentity=processIdentity;
  ctx.fixtureApi=async(path,options={})=>{requests.push({path,options:JSON.parse(JSON.stringify(options))});return request(path,options);};ctx.fixtureToast=(message,error)=>toasts.push({message,error});ctx.fixtureLoadChat=async id=>refreshes.push({type:'bot',id});ctx.fixtureLoadRoom=async id=>refreshes.push({type:'room',id});
  vm.runInContext("data={...initialState,bots:[fixtureBot],connections:[{id:'fixture',type:'openai',status:'connected',defaultModel:'qa'}],rooms:[{id:'room_qa',name:'QA Room',botIds:['bot_qa']}]};chat={messages:[{role:'user',content:'Run checks.'}],run:fixtureRun};activeBot='bot_qa';api=fixtureApi;toast=fixtureToast;loadChat=fixtureLoadChat;loadRoomChat=fixtureLoadRoom;",ctx);
  const execute=code=>vm.runInContext(code,ctx),render=()=>{execute('renderThread(fixtureBot)');return window.document.querySelector('#chat-thread').innerHTML;};
  const click=async selector=>{const button=window.document.querySelector(selector);assert.ok(button,selector);button.click();await tick();return button;};
  return {ctx,window,document:window.document,requests,toasts,refreshes,execute,render,click};
}

test('managed command and language-server cards render bounded escaped state in the real chat renderer',()=>{
  const run=currentRun();run.backgroundProcesses[0]={...background,executable:'<script>bad()</script>',args:['<img src=x onerror=bad()>'],cwd:'<project>',outputPreview:'<svg onload=bad()>'+ 'x'.repeat(2000),status:'running'};run.languageServers[0].server='<img src=x onerror=bad()>';run.languageServers[0].rootPath='a & b';
  const h=harness({run}),html=h.render();
  assert.match(html,/Background commands/);assert.match(html,/1 running/);assert.match(html,/Code intelligence/);assert.match(html,/Ready/);
  // The thread includes a trusted local mascot image; process output may never
  // introduce an image, script or event handler into the actual document.
  assert.equal(h.document.querySelectorAll('script,[onload],[onerror],.managed-tools img').length,0);assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);assert.match(html,/Folder: &lt;project&gt;/);assert.match(html,/a &amp; b/);
  assert.equal(h.document.querySelector('.managed-process-preview').textContent.length,1200);
  assert.deepEqual(JSON.parse(h.document.querySelector('[data-action="stop-process"]').dataset.process),processIdentity);
  assert.equal(h.document.querySelector('#message-form .send').disabled,true);
});

test('finished and interrupted tasks retain process evidence but never offer a stale Stop command',()=>{
  for(const status of ['completed','failed','cancelled','interrupted']){
    const run=currentRun();run.status=status;run.backgroundProcesses=[{...background,status:'interrupted',exitCode:7,truncated:true}];run.languageServers[0].status='stopped';
    const h=harness({run}),html=h.render();assert.match(html,/Interrupted/);assert.match(html,/Exit 7/);assert.match(html,/Output truncated/);assert.match(html,/View output/);assert.doesNotMatch(html,/data-action="stop-process"/);assert.equal(h.document.querySelector('#message-form .send').disabled,false);
  }
});

test('compact command metadata uses argsPreview and stopped sessions offer no stop action',()=>{
  const run=currentRun();run.backgroundProcesses=[{...background,args:undefined,argsPreview:['verify.js','--fast'],status:'stopped'}];run.languageServers[0].status='stopping';
  const h=harness({run}),html=h.render();assert.match(html,/node verify.js --fast/);assert.match(html,/Stopped/);assert.match(html,/Stopping/);assert.doesNotMatch(html,/data-action="stop-process"/);
});

test('clipped command arguments are displayed as a preview with an ellipsis',()=>{
  const run=currentRun();run.backgroundProcesses=[{...background,args:undefined,argsPreview:['-e','x'.repeat(120)],argsPreviewTruncated:true}];
  const h=harness({run});h.render();const command=h.document.querySelector('.managed-process-heading strong').textContent;
  assert.equal(command,'node -e '+ 'x'.repeat(120)+'…');assert.doesNotMatch(command,/-e,/);
});

test('a header loaded while awaiting approval clears its status after completion without replacing the draft',()=>{
  const run=currentRun();run.status='waiting_for_approval';const h=harness({run});
  h.document.body.insertAdjacentHTML('afterbegin','<header class="chat-header"><span class="chat-tools"><span class="status-pill">Old status</span></span></header><textarea id="message-input">Keep my next draft.</textarea>');
  h.render();assert.equal(h.document.querySelector('.chat-header .status-pill').textContent,'Needs approval');const draft=h.document.querySelector('#message-input');
  h.execute("chat.run={...chat.run,status:'completed'}");h.render();
  assert.equal(h.document.querySelector('.chat-header .status-pill'),null);assert.equal(h.document.querySelector('#message-input'),draft);assert.equal(draft.value,'Keep my next draft.');assert.equal(h.document.querySelector('#message-form .send').disabled,false);
  assert.equal(h.execute('data.runs.bot_qa.status'),'completed');
});

test('process output dialog uses scoped HTTP identity, escapes output, pages and refreshes',async()=>{
  const h=harness({request:async path=>path.includes('offset=7')?{status:'completed',output:'second',nextOffset:null,exitCode:0}:{status:'running',output:'<first>',nextOffset:7,truncated:true}});h.render();
  await h.click('[data-action="process-output"]');
  const content=h.document.querySelector('#managed-output-content');assert.equal(content.textContent,'<first>');assert.equal(content.innerHTML,'&lt;first&gt;');assert.match(h.document.querySelector('#managed-output-status').textContent,/truncated/);
  assert.equal(h.requests[0].path,'/api/bots/bot_qa/processes/process_qa?runId=run_qa&offset=0&limit=12000');
  await h.click('[data-action="process-output-more"]');assert.equal(content.textContent,'<first>second');assert.match(h.document.querySelector('#managed-output-status').textContent,/Exit 0/);assert.equal(h.document.querySelector('#managed-output-more').disabled,true);
  await h.click('[data-action="process-output-refresh"]');assert.equal(content.textContent,'<first>');assert.equal(h.requests.length,3);
});

test('process output pages carry outputVersion and Refresh obtains a new version from offset zero',async()=>{
  let firstPage=0;const h=harness({request:async path=>path.includes('offset=8')?{status:'running',output:'second',nextOffset:null,outputVersion:4}:{status:'running',output:++firstPage===1?'version4':'version5',nextOffset:8,outputVersion:firstPage===1?4:5}});h.render();
  await h.click('[data-action="process-output"]');await h.click('[data-action="process-output-more"]');
  assert.match(h.requests[1].path,/offset=8&limit=12000&outputVersion=4$/);assert.equal(h.document.querySelector('#managed-output-content').textContent,'version4second');
  await h.click('[data-action="process-output-refresh"]');assert.match(h.requests[2].path,/offset=0&limit=12000$/);assert.doesNotMatch(h.requests[2].path,/outputVersion=/);assert.equal(h.document.querySelector('#managed-output-content').textContent,'version5');
  assert.equal(h.execute('managedOutputView.outputVersion'),5);
});

test('redaction revision conflicts clear stale pages and require Refresh before reading further',async()=>{
  let requestCount=0;const h=harness({request:async()=>{if(++requestCount===1)return {status:'running',output:'Older projection',nextOffset:16,outputVersion:0};if(requestCount===2)throw Object.assign(new Error('Output changed after credential redaction.'),{status:409});return {status:'running',output:'New redacted projection',nextOffset:null,outputVersion:1};}});h.render();
  await h.click('[data-action="process-output"]');await h.click('[data-action="process-output-more"]');
  assert.match(h.requests[1].path,/outputVersion=0$/);
  assert.equal(h.document.querySelector('#managed-output-content').textContent,'');assert.match(h.document.querySelector('#managed-output-status').textContent,/Select Refresh/);assert.equal(h.document.querySelector('#managed-output-more').disabled,true);assert.equal(h.execute('managedOutputView.outputVersion'),undefined);
  await h.click('[data-action="process-output-refresh"]');assert.doesNotMatch(h.requests[2].path,/outputVersion=/);assert.equal(h.document.querySelector('#managed-output-content').textContent,'New redacted projection');
});

test('the browser API retains HTTP conflict status for redaction-aware output handling',async()=>{
  const h=harness();h.ctx.fetch=async()=>({ok:false,status:409,json:async()=>({error:'Output changed after credential redaction.'})});
  await assert.rejects(h.execute("realFixtureApi('/api/bots/bot_qa/processes/process_qa')"),error=>error.status===409&&/credential redaction/.test(error.message));
});

test('a changed projection version is never appended even if a server returns it without a conflict status',async()=>{
  let count=0;const h=harness({request:async()=>++count===1?{status:'running',output:'Old',nextOffset:3,outputVersion:1}:{status:'running',output:'Different revision',nextOffset:null,outputVersion:2}});h.render();
  await h.click('[data-action="process-output"]');await h.click('[data-action="process-output-more"]');assert.equal(h.document.querySelector('#managed-output-content').textContent,'');assert.match(h.document.querySelector('#managed-output-status').textContent,/Select Refresh/);assert.equal(h.document.querySelector('#managed-output-more').disabled,true);
});

test('Stop command sends exact current-run identities without stopping the whole task',async()=>{
  const h=harness({request:async()=>({stopped:true})});h.render();await h.click('[data-action="stop-process"]');
  assert.deepEqual(h.requests,[{path:'/api/bots/bot_qa/processes/process_qa/stop',options:{method:'POST',body:{runId:'run_qa',remoteRunId:'remote_qa'}}}]);
  assert.deepEqual(h.refreshes,[{type:'bot',id:'bot_qa'}]);assert.equal(h.toasts[0].message,'Stop requested for this command.');
  assert.equal(h.document.querySelector('#message-form .send').disabled,true);
  h.execute("chat.run={...chat.run,id:'new_run'}");await h.click('[data-action="stop-process"]');assert.equal(h.requests.length,1);assert.match(h.toasts.at(-1).message,/older or finished task/);
});

test('late output responses cannot overwrite a replacement dialog or a newer output request',async()=>{
  const pending=[];const h=harness({request:async()=>new Promise(resolve=>pending.push(resolve))});h.render();
  const first=h.execute('processOutputDialog(fixtureIdentity)');await tick();assert.equal(pending.length,1);
  const second=h.execute('loadProcessOutput(managedOutputView,0,false)');await tick();pending[1]({status:'running',output:'Newer output',nextOffset:null});await second;pending[0]({status:'running',output:'Stale output',nextOffset:null});await first;
  assert.equal(h.document.querySelector('#managed-output-content').textContent,'Newer output');
  const third=h.execute('loadProcessOutput(managedOutputView,0,false)');await tick();h.execute("openDialog('Different dialog','<p id=\"replacement\">Keep this view</p>')");pending[2]({status:'completed',output:'Late process output',nextOffset:null});await third;
  assert.equal(h.document.querySelector('#replacement').textContent,'Keep this view');assert.equal(h.document.querySelector('#managed-output-content'),null);
});

test('late output respects a stopped process and refuses to appear under a replacement run',async()=>{
  const pending=[];const h=harness({request:async()=>new Promise(resolve=>pending.push(resolve))});h.render();
  const first=h.execute('processOutputDialog(fixtureIdentity)');await tick();h.execute("chat.run.backgroundProcesses=[{...chat.run.backgroundProcesses[0],status:'stopped'}]");pending[0]({status:'running',output:'Retained before Stop',nextOffset:null});await first;
  assert.match(h.document.querySelector('#managed-output-status').textContent,/stopped/);assert.equal(h.document.querySelector('#managed-output-content').textContent,'Retained before Stop');
  const second=h.execute('loadProcessOutput(managedOutputView,0,false)');await tick();h.execute("chat.run={...chat.run,id:'replacement_run'}");pending[1]({status:'running',output:'Stale older output',nextOffset:null});await second;
  assert.match(h.document.querySelector('#managed-output-status').textContent,/task changed/);assert.equal(h.document.querySelector('#managed-output-content').textContent,'Retained before Stop');
});

test('room process controls target the owning bot and refresh only the current room',async()=>{
  const h=harness({request:async()=>({stopped:true})});h.execute("location.hash='#/room/room_qa';roomChat={messages:[{role:'user',content:'Verify.'}],drive:{id:'drive_qa',status:'running',currentBotId:'bot_qa'},activeRun:fixtureRun};document.querySelector('#chat-thread').id='room-thread';renderRoomThread('room_qa')");
  await h.click('[data-action="stop-process"]');assert.equal(h.requests[0].path,'/api/bots/bot_qa/processes/process_qa/stop');assert.deepEqual(h.refreshes,[{type:'room',id:'room_qa'}]);
});
