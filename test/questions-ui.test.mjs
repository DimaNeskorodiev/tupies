import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const waitingRun=()=>({id:'run_qa',remoteRunId:'remote_qa',botId:'bot_qa',status:'waiting_for_input',execution_generation:3,events:[],pending_controls:[{kind:'question',prompt_id:'question_qa',questions:[
  {id:'format',header:'Format',prompt:'Which <format> should the report use?',options:[{id:'pdf',label:'PDF',description:'Fixed layout'},{id:'docx',label:'Word <doc>'}]},
  {id:'sections',header:'Sections',prompt:'Which sections?',options:[{id:'summary',label:'Summary'},{id:'risks',label:'Risks'}],multiSelect:true},
  {id:'audience',header:'Audience',prompt:'Who will read it?'},
]}]});

// The real chat renderer and click handling in a DOM; no engine, account or provider is involved.
function harness(run=waitingRun()) {
  const dom=new JSDOM('<div id="chat-thread"></div><form id="message-form"><button class="send"></button></form><div id="dialog-root"></div><div id="toasts"></div>');
  const {window}=dom,requests=[],toasts=[],refreshes=[];
  // A rich-content stub turns on the renderer's keyed DOM reuse, as in the app.
  window.StudioRich={hydrate:async()=>{},dispose(){}};
  const ctx=vm.createContext({document:window.document,window,location:{hash:'#/bot/bot_qa'},URL,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(source,ctx,{filename:'app.js'});
  ctx.fixtureBot={id:'bot_qa',name:'QA Bot',title:'QA',connectionId:'fixture',color:'mint',tools:[],skills:[],enabled:true};ctx.fixtureRun=run;
  ctx.fixtureApi=async(path,options={})=>{requests.push({path,options:JSON.parse(JSON.stringify(options))});return {resolved:1};};
  ctx.fixtureToast=(message,error)=>toasts.push({message,error});ctx.fixtureLoadChat=async id=>refreshes.push(id);
  vm.runInContext("data={...initialState,bots:[fixtureBot],connections:[{id:'fixture',type:'openai',status:'connected',defaultModel:'qa'}],rooms:[]};chat={messages:[{role:'user',content:'Make the report.',runId:'run_qa'}],run:fixtureRun};activeBot='bot_qa';api=fixtureApi;toast=fixtureToast;loadChat=fixtureLoadChat;",ctx);
  const execute=code=>vm.runInContext(code,ctx),render=()=>{execute('renderThread(fixtureBot)');return window.document.querySelector('#chat-thread').innerHTML;};
  const $=selector=>window.document.querySelector(selector),$$=selector=>[...window.document.querySelectorAll(selector)];
  const click=async selector=>{const button=$(selector);assert.ok(button,selector);button.click();await tick();return button;};
  return {window,requests,toasts,refreshes,execute,render,$,$$,click};
}

test('a waiting question renders as an escaped card with choices, free text, Skip and Stop',()=>{
  const h=harness(),html=h.render();
  assert.match(html,/QA Bot has a few questions/);assert.match(html,/Which &lt;format&gt; should the report use\?/);assert.match(html,/Word &lt;doc&gt;/);
  assert.equal(h.window.document.querySelectorAll('script,img[onerror]').length,0);
  assert.deepEqual(h.$$('.question-item').map(item=>item.dataset.questionId),['format','sections','audience']);
  assert.deepEqual(h.$$('.question-item[data-question-id="format"] input').map(input=>input.type),['radio','radio']);
  assert.deepEqual(h.$$('.question-item[data-question-id="sections"] input').map(input=>input.type),['checkbox','checkbox']);
  assert.equal(h.$$('.question-item[data-question-id="audience"] input').length,0);assert.equal(h.$('.question-item[data-question-id="audience"] textarea').getAttribute('rows'),'2');
  assert.deepEqual(JSON.parse(h.$('.question-card').dataset.question),{runId:'run_qa',remoteRunId:'remote_qa',request_id:'question_qa',execution_generation:3});
  assert.ok(h.$('[data-action="skip-question"]'));assert.ok(h.$('.question-card [data-action="stop-run"]'));
  assert.doesNotMatch(html,/thinking-stop/,'the card replaces the working animation');
  assert.equal(h.$('#message-form .send').disabled,true);
});

test('what was typed survives a refresh while the same question waits',()=>{
  const h=harness();h.render();
  const field=h.$('.question-item[data-question-id="audience"] textarea');field.value='The board';h.$('input[value="pdf"]').checked=true;
  h.execute("chat.messages=[...chat.messages,{role:'assistant',content:'Earlier note.',id:'message_extra'}]");h.render();
  assert.equal(h.$('.question-item[data-question-id="audience"] textarea'),field);assert.equal(field.value,'The board');assert.equal(h.$('input[value="pdf"]').checked,true);
});

test('Send posts the exact prompt identity with every answer, and refuses an unanswered question',async()=>{
  const h=harness();h.render();
  h.$('input[value="pdf"]').checked=true;
  await h.click('[data-action="answer-question"]');
  assert.equal(h.requests.length,0);assert.match(h.toasts.at(-1).message,/Answer each question, or choose Skip/);
  h.$('input[value="summary"]').checked=true;h.$('input[value="risks"]').checked=true;h.$('.question-item[data-question-id="audience"] textarea').value='  The board  ';
  h.$('.question-item[data-question-id="format"] textarea').value='Landscape';
  await h.click('[data-action="answer-question"]');
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].path,'/api/bots/bot_qa/answer');assert.equal(h.requests[0].options.method,'POST');
  assert.deepEqual(h.requests[0].options.body,{runId:'run_qa',remoteRunId:'remote_qa',request_id:'question_qa',execution_generation:3,answers:[
    {questionId:'format',optionIds:['pdf'],text:'Landscape'},{questionId:'sections',optionIds:['summary','risks'],text:''},{questionId:'audience',optionIds:[],text:'The board'}]});
  assert.deepEqual(h.refreshes,['bot_qa']);assert.equal(h.toasts.at(-1).message,'Answer sent.');
});

test('Skip sends no answers',async()=>{
  const h=harness();h.render();
  await h.click('[data-action="skip-question"]');
  assert.deepEqual(h.requests[0].options.body,{runId:'run_qa',remoteRunId:'remote_qa',request_id:'question_qa',execution_generation:3,skip:true});
  assert.equal(h.toasts.at(-1).message,'Question skipped.');
});

test('a bot waiting for an answer reads as needing you, and an answer record is not taken for the task',()=>{
  const h=harness();h.render();
  assert.deepEqual(JSON.parse(JSON.stringify(h.execute('botStatus(fixtureBot)'))),{text:'Needs your answer',className:'working attention'});
  const prompts=[];h.window.StudioActivityModel={build:(bot,run,options)=>{prompts.push(options.prompt);return null;}};
  h.execute("fixtureRun.status='running';fixtureRun.pending_controls=[];chat.messages=[...chat.messages,{role:'user',kind:'answer',content:'> Which format?\\n\\nPDF',runId:'run_qa'}]");
  h.render();assert.deepEqual(prompts,['Make the report.']);
});
