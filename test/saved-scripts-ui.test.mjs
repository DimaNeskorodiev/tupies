import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const read=name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8');
const [source,usageSource,approvalSource,app,index,css,profile]=await Promise.all([read('saved-scripts.js'),read('run-usage.js'),read('approval-summary.js'),read('app.js'),read('index.html'),read('saved-scripts.css'),read('bot-profile.js')]);
const REQUEST='Save what you just did as a script so next time it runs in seconds without the model. Pick a clear name, declare its inputs, and tell me how to run it.';
const ago=minutes=>new Date(Date.now()-minutes*60000).toISOString();
const base={id:'daily-report',title:'Daily report',purpose:'Builds the sales report.',status:'registered',language:'python',inputFields:[],version:'635e53af0009',approvedVersion:'635e53af0009',approvedAt:'2026-11-10T09:00:00Z',approvedHow:'owner-run',needsApproval:false,runnable:true,runtimeAvailable:true,runs:{count:12,lastAt:ago(120),lastStatus:'succeeded',lastDurationMs:3000},usedBy:[]};

function harness({scripts=[base],target='',detail=null,composer=''}={}){
  const dom=new JSDOM(`<main><section class="bot-profile" data-profile-bot="bot_atlas"><div id="bp-panel"></div></section><div id="thread"></div>${composer}</main>`,{runScripts:'outside-only',url:'http://localhost/'});
  const {window}=dom,{document}=window;
  for(const code of [usageSource,approvalSource,source])window.eval(code);
  const v={scripts,scriptTarget:target,script:detail,scriptLoading:false,scriptError:'',scriptQuery:'',scriptsError:'',scriptsTruncated:false};
  const bot={id:'bot_atlas',name:'Atlas'},calls=[],queue=[];
  const api=async(path,options={})=>{
    calls.push({path,method:options.method||'GET',body:options.body&&JSON.parse(JSON.stringify(options.body))});
    const next=queue.find(item=>item.match(path,options));
    if(!next){if(!options.method)return path.endsWith('/scripts')?{scripts:v.scripts}:structuredClone(v.script);throw new Error('unexpected '+path);}
    queue.splice(queue.indexOf(next),1);
    if(next.error)throw Object.assign(new Error(next.error.message),{status:next.error.status});
    return next.result;
  };
  const panel=document.querySelector('#bp-panel');
  const env={api,icon:name=>`<i data-icon="${name}"></i>`,errorText:error=>error?.message||'Something went wrong.',refresh:()=>{panel.innerHTML=window.StudioScripts.panel(bot,v,env);}};
  const draw=()=>env.refresh();
  const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));};
  const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
  const post=(match,result,error)=>queue.push({match:(path,options)=>options.method==='POST'&&match(options.body),result,error});
  return {window,document,v,bot,calls,env,draw,settle,$,$$,post,scripts:window.StudioScripts,open(script){v.scriptTarget=script.id;v.script=script;draw();}};
}
const full=(extra={})=>({...base,source:{path:'scripts/daily-report/main.py',content:'print("hi <b>there</b>")',truncated:false},history:[],...extra});

test('the list speaks plain words in every state and never shows hashes or jargon',()=>{
  const h=harness({scripts:[
    base,
    {...base,id:'fresh',title:'Fresh',status:'registered',runs:{count:0},needsApproval:true,approvedVersion:null,approvedAt:null},
    {...base,id:'edited',title:'Edited',needsApproval:true},
    {...base,id:'nope',title:'Nope',runtimeAvailable:false,runnable:false,error:'Python is not installed <here>'},
    {...base,id:'half',title:'Half',status:'draft',runnable:false},
    {...base,id:'used',title:'Used',usedBy:[{routineId:'r1',name:'Morning'},{routineId:'r2',name:'Evening'}],runs:{count:1,lastAt:ago(2),lastStatus:'failed'}},
    {id:'../bad'},null,'x',
  ]});
  h.draw();
  const rows=h.$$('.ss-row');assert.equal(rows.length,6);
  const text=rows.map(row=>row.textContent);
  assert.match(text[0],/Daily report/);assert.match(text[0],/Builds the sales report\./);assert.match(text[0],/Ran 12 times · last run 2 hours ago · succeeded/);
  assert.equal(h.$$('.ss-state').length,5,'a plain, approved, runnable script shows no state');
  assert.match(text[1],/Never run/);assert.match(text[1],/New — review before first run/);
  assert.match(text[2],/Changed since you approved it/);
  assert.match(text[3],/Can't run here: Python is not installed <here>/);assert.equal(h.$('.ss-row img,.ss-row here'),null);
  assert.match(text[4],/Not finished — ask the bot to save it again/);
  assert.match(text[5],/Used by 2 routines/);assert.match(text[5],/Ran 1 time · last run 2 minutes ago · failed/);
  assert.equal(/digest|manifest|registered|draft|receipt|script_run|635e53af0009/i.test(h.$('.ss-list').textContent),false);
  assert.equal(rows[0].dataset.profileAction,'inspect-script');assert.equal(rows[0].dataset.id,'daily-report');
});

test('an empty catalog explains scripts in two sentences; unusable data falls back to the old markup',()=>{
  const h=harness({scripts:[]});h.draw();
  assert.match(h.$('.ss-empty').textContent,/A script is a small program your bot keeps so it can repeat a task in seconds, without using the model\./);
  assert.match(h.$('.ss-empty').textContent,/Ask your bot to save a task as a script, or accept the suggestion that appears in chat/);
  assert.equal(h.scripts.panel(h.bot,{scripts:null},h.env),'');assert.equal(h.scripts.panel(h.bot,h.v,{}),'');assert.equal(h.scripts.panel(null,h.v,h.env),'');
  assert.ok(profile.includes("window.StudioScripts?.panel?.(bot,v,{api:ctx.api,icon,errorText:ctx.errorText,refresh});if(owned)return owned;"));
});

test('the form is built from the declared inputs and Run sends exactly those values',async()=>{
  const script=full({inputFields:[{name:'city',description:'Which <city> to report on',required:true},{name:'days',description:'How many days',default:'7'},{name:null,description:'A free-text note'}]});
  const h=harness({scripts:[script],target:script.id,detail:script});h.draw();
  const labels=h.$$('.ss-field label');assert.deepEqual(labels.map(label=>label.textContent.replace(/\s+/g,' ').trim()),['city * (required)','days']);
  const city=h.$('input[name=city]'),days=h.$('input[name=days]');
  assert.equal(days.value,'7');assert.equal(days.placeholder,'7');assert.equal(city.getAttribute('aria-required'),'true');
  assert.match(h.$('.ss-field small').textContent,/Which <city> to report on/);assert.equal(h.$('.ss-field small b,.ss-field small city'),null);
  assert.match(h.$('.ss-notes').textContent,/A free-text note/);assert.equal(h.$('textarea[data-ss-args]'),null,'no extra-arguments box when inputs are named');
  // A required field left empty is explained next to the form and nothing is sent.
  h.$('.ss-form').dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));await h.settle();
  assert.match(h.$('.ss-error').textContent,/Fill in “city”/);assert.equal(h.calls.length,0);
  h.$('input[name=city]').value='Kyiv <1>';h.$('input[name=city]').dispatchEvent(new h.window.Event('input',{bubbles:true}));
  h.post(body=>body.action==='run',{status:'succeeded',exitCode:0,output:'<b>done</b>\nline2',durationMs:3400,backend:'sandbox',version:'635e53af0009',modelCalls:0});
  h.$('.ss-run').click();await h.settle();
  const post=h.calls.find(call=>call.method==='POST');assert.equal(post.path,'/api/bots/bot_atlas/scripts/daily-report');
  assert.deepEqual(post.body,{action:'run',version:'635e53af0009',inputs:{city:'Kyiv <1>',days:'7'}});
  const result=h.$('.ss-result');assert.match(result.textContent,/Finished successfully · 3 s · in the sandbox · 0 model calls/);
  assert.equal(h.$('.ss-output').textContent,'<b>done</b>\nline2');assert.equal(h.$('.ss-output b'),null);
  assert.equal(h.$('input[name=city]').value,'Kyiv <1>','typed values survive the redraw');
  assert.equal(h.$('.ss-run').textContent,'Run');
});

test('a script with no named inputs offers one optional box for extra arguments, one per line',async()=>{
  const script=full();const h=harness({scripts:[script],target:script.id,detail:script});h.draw();
  const box=h.$('textarea[data-ss-args]');assert.ok(box);assert.match(h.$('.ss-field label').textContent,/Extra arguments/);assert.match(h.$('.ss-field label').textContent,/optional/);assert.match(h.$('.ss-field small').textContent,/One argument per line/);
  box.value='--fast\n\n  two words  \n';box.dispatchEvent(new h.window.Event('input',{bubbles:true}));
  h.post(()=>true,{status:'failed',exitCode:2,output:'',durationMs:900,backend:'host'});
  h.$('.ss-run').click();await h.settle();
  assert.deepEqual(h.calls.find(call=>call.method==='POST').body,{action:'run',version:'635e53af0009',args:['--fast','  two words  ']});
  assert.match(h.$('.ss-result').textContent,/Failed \(exit code 2\) · 900 ms · on this computer · 0 model calls/);assert.match(h.$('.ss-result').textContent,/It printed nothing/);
  // Without any extra text nothing but the version is sent.
  const quiet=harness({scripts:[script],target:script.id,detail:script});quiet.draw();quiet.post(()=>true,{status:'succeeded',output:'',backend:'container'});quiet.$('.ss-run').click();await quiet.settle();
  assert.deepEqual(quiet.calls.find(call=>call.method==='POST').body,{action:'run',version:'635e53af0009'});assert.match(quiet.$('.ss-result').textContent,/in a container/);
});

test('Run is disabled while it runs and for scripts that cannot run here',async()=>{
  const script=full();const h=harness({scripts:[script],target:script.id,detail:script});h.draw();
  let release;h.queueBlock=new Promise(resolve=>{release=resolve;});
  const original=h.env.api;h.env.api=async(path,options)=>{if(options?.method==='POST'){await h.queueBlock;return {status:'succeeded',output:'ok',backend:'host'};}return original(path,options);};
  h.$('.ss-run').click();await h.settle();
  assert.equal(h.$('.ss-run').disabled,true);assert.equal(h.$('.ss-run').textContent,'Running…');assert.equal(h.$('.ss-form textarea').disabled,true);
  release();await h.settle();assert.equal(h.$('.ss-run').textContent,'Run');assert.equal(h.$('.ss-run').disabled,false);
  const blocked=full({runnable:false,runtimeAvailable:false,error:'Python missing'});const b=harness({scripts:[blocked],target:blocked.id,detail:blocked});b.draw();
  assert.equal(b.$('.ss-run').disabled,true);assert.match(b.$('.ss-detail').textContent,/Can't run here: Python missing/);
});

test('a new version opens the review step before it ever runs; the confirm resends with approval',async()=>{
  const script=full({needsApproval:true,approvedVersion:null,approvedAt:null});
  const h=harness({scripts:[script],target:script.id,detail:script});h.draw();
  assert.match(h.$('.ss-version').textContent,/Version 635e53af0009 · not approved yet/);
  h.$('.ss-run').click();await h.settle();
  assert.equal(h.calls.filter(call=>call.method==='POST').length,0,'pressing Run alone sends nothing');
  const review=h.$('.ss-review');assert.ok(review);assert.match(review.textContent,/This version has not run before/);
  assert.equal(review.querySelector('.ss-code').textContent,'print("hi <b>there</b>")');assert.equal(review.querySelector('b'),null);
  assert.deepEqual([...review.querySelectorAll('button')].map(button=>button.textContent),['Review done — run it','Cancel']);
  assert.equal(h.document.activeElement,h.$('#ss-review-title'),'focus moves to the review step');
  h.post(body=>body.approve===true,{status:'succeeded',output:'ok',durationMs:1000,backend:'sandbox'});
  h.v.script={...script,needsApproval:false,approvedVersion:'635e53af0009',approvedAt:'2026-11-10T10:00:00Z',approvedHow:'owner-run'};
  h.$('[data-ss-act=confirm-run]').click();await h.settle();
  const post=h.calls.find(call=>call.method==='POST');assert.deepEqual(post.body,{action:'run',version:'635e53af0009',approve:true});
  assert.equal(h.$('.ss-review'),null);assert.match(h.$('.ss-version').textContent,/approved by you on 10 Nov/);assert.match(h.$('.ss-result').textContent,/Finished successfully/);
  // Cancel closes the review and sends nothing.
  const c=harness({scripts:[script],target:script.id,detail:script});c.draw();c.$('.ss-run').click();await c.settle();c.$('[data-ss-act=cancel-review]').click();
  assert.equal(c.$('.ss-review'),null);assert.equal(c.calls.filter(call=>call.method==='POST').length,0);
});

test('a changed version shows the diff; a 428 from the engine opens the same step',async()=>{
  const script=full({needsApproval:true,diff:'--- a/main.py\n+++ b/main.py\n@@\n-print("old")\n+print("<new>")'});
  const h=harness({scripts:[script],target:script.id,detail:script});h.draw();h.$('.ss-run').click();await h.settle();
  assert.match(h.$('.ss-review').textContent,/Changed since you approved it/);
  assert.equal(h.$('.ss-review .ss-add').textContent,'+print("<new>")');assert.equal(h.$('.ss-review .ss-del').textContent,'-print("old")');assert.equal(h.$('.ss-review new'),null);
  // The page thought the version was approved, the engine disagrees.
  const stale=full();const g=harness({scripts:[stale],target:stale.id,detail:stale});g.draw();
  g.post(body=>!body.approve,undefined,{status:428,message:'Review needed'});
  g.v.script=full({needsApproval:true,approvedVersion:null});
  g.$('.ss-run').click();await g.settle();
  assert.ok(g.$('.ss-review'));assert.match(g.$('.ss-review').textContent,/has not run before/);
  g.post(body=>body.approve===true,{status:'succeeded',output:'ok',backend:'host'});g.$('[data-ss-act=confirm-run]').click();await g.settle();
  assert.equal(g.calls.filter(call=>call.method==='POST').at(-1).body.approve,true);
});

test('409 reloads: a new version says so, a busy bot keeps its own message; 400 shows next to the form',async()=>{
  const script=full();const h=harness({scripts:[script],target:script.id,detail:script});h.draw();
  h.post(()=>true,undefined,{status:409,message:'Version is not current'});
  h.$('.ss-run').click();h.v.script=full({version:'aaaaaaaaaaaa',needsApproval:true,approvedVersion:'635e53af0009'});await h.settle();
  assert.match(h.$('.ss-notice').textContent,/This script changed\. Review the new version\./);assert.match(h.$('.ss-version').textContent,/Version aaaaaaaaaaaa/);
  const g=harness({scripts:[script],target:script.id,detail:script});g.draw();g.post(()=>true,undefined,{status:409,message:'Atlas is busy with a task.'});g.$('.ss-run').click();await g.settle();
  assert.match(g.$('.ss-error').textContent,/Atlas is busy with a task\./);
  const b=harness({scripts:[script],target:script.id,detail:script});b.draw();b.post(()=>true,undefined,{status:400,message:'Unknown input “x”'});b.$('.ss-run').click();await b.settle();
  assert.match(b.$('.ss-form .ss-error').textContent,/Unknown input “x”/);assert.equal(b.$('.ss-run').disabled,false);
});

test('the history, who started it, where it ran, routines and the code are plain, escaped and collapsed',()=>{
  const script=full({usedBy:[{routineId:'r1',name:'Morning <b>run</b>'}],source:{path:'scripts/x/main.py',content:'print("<script>alert(1)</script>")',truncated:true},history:[
    {at:ago(5),startedBy:'owner',status:'succeeded',durationMs:2000,backend:'sandbox',output:'<img src=x onerror=1>',version:'635e53af0009',digest:'z'.repeat(64)},
    {at:ago(500),startedBy:'routine',status:'timed_out',durationMs:120000,backend:'host',output:''},
    {at:ago(3000),startedBy:'teammate',status:'failed',durationMs:50,backend:'remote',output:'x'},
    {at:ago(9000),startedBy:'bot',status:'stopped'},
  ]});
  const h=harness({scripts:[script],target:script.id,detail:script});h.draw();
  const runs=h.$$('.ss-runs li');assert.equal(runs.length,4);
  assert.equal(runs[0].querySelector('summary').textContent,'5 minutes agostarted by youSucceeded2 sin the sandbox');
  assert.match(runs[1].textContent,/started by a routine.*Timed out.*2 min.*on this computer/);assert.match(runs[2].textContent,/started by a teammate.*Failed.*50 ms.*on another machine/);assert.match(runs[3].textContent,/started by the bot.*Stopped/);
  assert.equal(runs[0].querySelector('details').open,false);assert.equal(runs[0].querySelector('pre').textContent,'<img src=x onerror=1>');assert.equal(h.$('.ss-runs img'),null);
  const used=h.$('.ss-used button');assert.equal(used.textContent,'Morning <b>run</b>');assert.equal(used.dataset.nav,'/routines');assert.equal(h.$('.ss-used b'),null);
  const code=h.$('.ss-codeblock');assert.equal(code.open,false);assert.equal(code.querySelector('summary').textContent,'View code');
  assert.equal(code.querySelector('pre').textContent,'print("<script>alert(1)</script>")');assert.equal(h.$('.ss-codeblock script'),null);assert.match(code.textContent,/Only the first part of the file is shown/);
  assert.equal(/zzzz|digest/.test(h.$('.ss-detail').textContent),false);
  code.open=true;code.dispatchEvent(new h.window.Event('toggle'));h.draw();assert.equal(h.$('.ss-codeblock').open,true,'an open block stays open when the tab redraws');
});

test('removing approval asks first, then revokes that version',async()=>{
  const script=full();const h=harness({scripts:[script],target:script.id,detail:script});h.draw();
  assert.match(h.$('.ss-version').textContent,/Version 635e53af0009 · approved by you on 10 Nov/);
  h.$('[data-ss-act=revoke-ask]').click();assert.match(h.$('.ss-confirm').textContent,/Remove approval\?/);assert.equal(h.calls.length,0);
  h.$('[data-ss-act=revoke-no]').click();assert.equal(h.$('.ss-confirm'),null);
  h.$('[data-ss-act=revoke-ask]').click();
  h.post(body=>body.action==='revoke',{revoked:1,script:{}});
  h.$('[data-ss-act=revoke-yes]').click();h.v.script=full({needsApproval:true,approvedVersion:null});await h.settle();
  assert.deepEqual(h.calls.find(call=>call.method==='POST').body,{action:'revoke',version:'635e53af0009'});
  assert.match(h.$('.ss-version').textContent,/not approved yet/);assert.equal(h.$('[data-ss-act=revoke-ask]'),null);assert.match(h.$('.ss-notice').textContent,/Approval removed/);
});

function chat(options){
  const h=harness({composer:`<form id="message-form" data-id="bot_atlas"><div id="composer-attachments"></div><textarea id="message-input" name="text">${options?.text||''}</textarea><button type="button" data-action="send-direction" hidden>d</button><button class="send" type="submit">s</button></form>`});
  return h;
}
test('the suggestion card offers one button with the exact request and Not now hides it for this message',()=>{
  const h=chat();const {scripts,document}=h;
  assert.equal(scripts.SAVE_REQUEST,REQUEST);
  document.querySelector('#thread').innerHTML=scripts.suggestion({reason:'repeated_commands',commands:4},{botId:'bot_atlas',messageKey:'m1'})+scripts.suggestion({reason:'repeated_commands',commands:1},{botId:'bot_atlas',messageKey:'m2'});
  const cards=[...document.querySelectorAll('.script-suggestion')];assert.equal(cards.length,2);
  assert.match(cards[0].querySelector('p').textContent,/^You ran 4 commands for this\. Save it as a script so next time it runs in seconds without the model\.$/);assert.match(cards[1].querySelector('p').textContent,/^You ran 1 command for this/);
  const save=cards[0].querySelector('[data-ss-save]');assert.equal(save.textContent,'Save as a script');assert.equal(save.dataset.saveText,REQUEST);assert.equal(save.hasAttribute('data-action'),false);
  const later=cards[0].querySelector('[data-ss-dismiss]');assert.equal(later.textContent,'Not now');
  later.click();assert.equal(document.querySelectorAll('.script-suggestion').length,1,'the card is gone');
  assert.equal(scripts.suggestion({reason:'repeated_commands',commands:4},{botId:'bot_atlas',messageKey:'m1'}),'','it stays hidden when the thread redraws');
  assert.notEqual(scripts.suggestion({reason:'repeated_commands',commands:4},{botId:'bot_atlas',messageKey:'m3'}),'');
  assert.deepEqual(JSON.parse(h.window.sessionStorage.getItem('tupies.scriptSuggestions.dismissed')),['m1']);
  assert.equal(document.querySelector('#message-input').value,'','nothing is sent or filled without the Save click');
  for(let i=0;i<130;i++)scripts.suggestion({reason:'repeated_commands',commands:2},{messageKey:'x'+i});
  for(let i=0;i<130;i++){const wrap=document.createElement('div');wrap.innerHTML=scripts.suggestion({reason:'repeated_commands',commands:2},{messageKey:'y'+i});wrap.querySelector('[data-ss-dismiss]').click();}
  assert.ok(JSON.parse(h.window.sessionStorage.getItem('tupies.scriptSuggestions.dismissed')).length<=100,'bounded');
});

test('Save as a script sends through the chat form when the box is free, otherwise only fills the box',()=>{
  const h=chat();let submitted=null;
  h.document.querySelector('#message-form').addEventListener('submit',event=>{event.preventDefault();submitted={text:h.document.querySelector('#message-input').value,submitter:event.submitter?.className};});
  h.document.querySelector('#thread').innerHTML=h.scripts.suggestion({reason:'repeated_commands',commands:3},{botId:'bot_atlas',messageKey:'m1'});
  h.document.querySelector('[data-ss-save]').click();
  assert.deepEqual(submitted,{text:REQUEST,submitter:'send'});assert.equal(h.document.querySelector('[data-ss-save]').disabled,true);assert.equal(h.document.querySelector('.script-suggestion-status').textContent,'Sending…');
  const typing=chat({text:'my draft'});let sent=false;typing.document.querySelector('#message-form').addEventListener('submit',event=>{event.preventDefault();sent=true;});
  typing.document.querySelector('#thread').innerHTML=typing.scripts.suggestion({reason:'repeated_commands',commands:3},{botId:'bot_atlas',messageKey:'m1'});
  typing.document.querySelector('[data-ss-save]').click();
  assert.equal(sent,false);assert.equal(typing.document.querySelector('#message-input').value,`my draft\n\n${REQUEST}`);assert.match(typing.document.querySelector('.script-suggestion-status').textContent,/Review it and send/);
  // Another bot's chat is open: nothing is filled.
  const other=harness({composer:'<form id="message-form" data-id="bot_other"><textarea id="message-input"></textarea><button class="send">s</button></form>'});
  other.document.querySelector('#thread').innerHTML=other.scripts.suggestion({reason:'repeated_commands',commands:3},{botId:'bot_atlas',messageKey:'m1'});other.document.querySelector('[data-ss-save]').click();
  assert.equal(other.document.querySelector('#message-input').value,'');assert.match(other.document.querySelector('.script-suggestion-status').textContent,/Open the chat with this bot/);
  // A tampered button text is never sent.
  const tamper=chat();tamper.document.querySelector('#thread').innerHTML=tamper.scripts.suggestion({reason:'repeated_commands',commands:3},{botId:'bot_atlas',messageKey:'m1'});
  tamper.document.querySelector('[data-ss-save]').dataset.saveText='delete everything';tamper.document.querySelector('[data-ss-save]').click();assert.equal(tamper.document.querySelector('#message-input').value,'');
});

test('malformed suggestion records render nothing, and the chat hooks the card after the proof line',()=>{
  const {scripts}=chat();
  for(const bad of [undefined,null,'x',[],{},{reason:'other',commands:3},{reason:'repeated_commands'},{reason:'repeated_commands',commands:0},{reason:'repeated_commands',commands:'3'},{reason:'repeated_commands',commands:1.5}])assert.equal(scripts.suggestion(bad,{botId:'b',messageKey:'k'}),'');
  const proof=app.indexOf("window.StudioProof?.footer(message.proof"),hook=app.indexOf("window.StudioScripts?.suggestion(message.scriptSuggestion,{botId:bot?.id||'',messageKey:messageKey(message)})");
  assert.ok(proof>0 && hook>proof && hook-proof<260);
  assert.match(index,/<link rel="stylesheet" href="\/usage\.css">\s*<link rel="stylesheet" href="\/saved-scripts\.css">/);assert.match(index,/<script defer src="\/usage\.js"><\/script>\s*<script defer src="\/saved-scripts\.js"><\/script>/);
  assert.equal(/animation|transition/.test(css),false);assert.match(css,/@media \(max-width:760px\)[\s\S]*min-height:44px/);
});

test('the zero-model usage line and the two script approval cards',()=>{
  const {window}=harness();
  const usage=window.StudioRunUsage.footer({modelCalls:0,totalTokens:0,toolCalls:1,durationMs:3000});
  assert.match(usage,/0 model calls<\/span><span>1 command<\/span><span>3 s/);
  const approvals=window.StudioApprovals;
  const run={tool:'script_run',arguments:{id:'daily-report',inputs:{city:'Kyiv <b>',days:'7'},args:['--fast']},review:{summary:'Run Daily report with 2 inputs.',riskReason:'It has not run before.',script:{id:'daily-report',title:'Daily report',version:'635e53af0009',change:{state:'changed',words:'Changed: 2 lines added, 1 removed.',approvedVersion:'aaaaaaaaaaaa',diff:'-old\n+<new>'}}}};
  assert.equal(approvals.title(run),'Run a saved script');
  const html=approvals.body(run,'');const box=window.document.createElement('div');box.innerHTML=html;
  assert.equal(box.querySelector('.approval-sentence').textContent,'Run Daily report with 2 inputs.');
  assert.deepEqual([...box.querySelectorAll('.approval-inputs div')].map(row=>row.textContent),['cityKyiv <b>','days7','Extra arguments--fast']);assert.equal(box.querySelector('.approval-inputs b'),null);
  assert.match(box.querySelector('.approval-raw .approval-change').textContent,/Changed: 2 lines added, 1 removed\./);assert.equal(box.querySelector('.approval-raw .approval-diff').textContent,'-old\n+<new>');
  assert.equal(box.querySelector('.approval-raw').open,false);
  const plainRun=window.document.createElement('div');plainRun.innerHTML=approvals.body({tool:'script_run',arguments:{id:'daily-report'},review:{script:{title:'Daily report'}}},'');
  assert.equal(plainRun.querySelector('.approval-sentence').textContent,'Run the saved script Daily report.');assert.equal(plainRun.querySelector('.approval-diff'),null);
  const noTitle=approvals.describe('script_run',{id:'x-y'});assert.equal(noTitle.sentence,'Run the saved script x-y.');
  const save={tool:'script_save',arguments:{id:'daily-report',title:'Daily report',language:'python',purpose:'Builds it',code:'x'.repeat(5000)+'<b>'}};
  assert.equal(approvals.title(save),'Save a script');
  const card=window.document.createElement('div');card.innerHTML=approvals.body(save,'');
  assert.equal(card.querySelector('.approval-sentence').textContent,'Save the script Daily report in the bot’s workspace. Nothing runs.');
  const rows=[...card.querySelectorAll('.approval-inputs div')].map(row=>row.querySelector('dt').textContent);assert.ok(rows.includes('Language'));assert.ok(rows.includes('Code'));
  assert.ok(card.querySelector('.approval-inputs dd.is-block').textContent.length<=1201,'the code preview is clipped');assert.equal(card.querySelector('b'),null);
});
