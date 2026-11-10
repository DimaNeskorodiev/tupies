import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const read=name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8');
const [source,app,index,css]=await Promise.all([read('proof-of-work.js'),read('app.js'),read('index.html'),read('proof-of-work.css')]);

function page(composer='') {
  const dom=new JSDOM(`<main><div id="thread"></div>${composer}</main>`,{runScripts:'outside-only'});
  dom.window.eval(source);
  return {dom,window:dom.window,document:dom.window.document,proof:dom.window.StudioProof};
}
const composer=({text='',busy=false,attachment=false,id='bot_atlas'}={})=>`<form id="message-form" data-id="${id}"><div id="composer-attachments">${attachment?'<span class="attachment-chip">a.pdf</span>':''}</div><textarea id="message-input" name="text">${text}</textarea><button type="button" data-action="send-direction" ${busy?'':'hidden'}>d</button><button class="send" type="submit">s</button></form>`;
const attention={status:'attention',checked:{filesSaved:1,sourcesRead:2},attention:{commandsFailed:1,unknownResults:1},notes:{couldNotRead:1},items:[{kind:'command_failed',tool:'shell_run',callId:'call_tests'},{kind:'unknown_result',tool:'workspace_write',callId:'call_save',path:'notes/<b>today</b>.md'}]};

test('a checked task shows one quiet line of counts and nothing to click',()=>{
  const {document,proof}=page();
  const html=proof.footer({status:'checked',checked:{filesSaved:2,sourcesRead:3,commandsRan:4,searches:1},attention:{}},{botId:'bot_atlas'});
  document.querySelector('#thread').innerHTML=html;
  const line=document.querySelector('.proof-of-work.checked');
  assert.ok(line);assert.equal(line.textContent,'Checked:2 files saved3 sources read1 search4 commands ran');
  assert.equal(line.getAttribute('aria-label'),'Checked by Tupies: 2 files saved, 3 sources read, 1 search, 4 commands ran');
  assert.equal(document.querySelectorAll('button,details').length,0);
  // Singular forms and a neutral note.
  assert.match(proof.footer({status:'checked',checked:{filesSaved:1,commandsRan:1},attention:{},notes:{couldNotRead:1}}),/1 file saved<\/span><span>1 command ran<\/span><span class="proof-note">1 source could not be read/);
});

test('a task that needs a look lists the items in plain words and offers Ask to redo',()=>{
  const {document,proof}=page();
  document.querySelector('#thread').innerHTML=proof.footer(attention,{botId:'bot_atlas',messageKey:'message-abc'});
  const block=document.querySelector('details.proof-of-work.attention');
  assert.ok(block);assert.equal(block.open,false,'collapsed until the owner opens it');
  assert.equal(block.querySelector('summary').textContent,'Needs a look:1 command failed1 action with an unknown result');
  assert.deepEqual([...block.querySelectorAll('li')].map(item=>item.textContent),['Failed: Command','Result unknown: File save · notes/<b>today</b>.md']);
  assert.equal(block.querySelectorAll('b').length,0,'a path is text, never markup');
  assert.match(block.textContent,/Also checked: 1 file saved · 2 sources read/);assert.match(block.textContent,/1 source could not be read/);
  const button=block.querySelector('button[data-proof-redo]');
  assert.equal(button.textContent,'Ask to redo');assert.equal(button.dataset.botId,'bot_atlas');assert.equal(button.dataset.messageKey,'message-abc');
  assert.equal(button.hasAttribute('data-action'),false,'the chat’s own click switch never sees it');
  const text=button.dataset.redoText;
  assert.equal(text,proof.redoText(attention));
  assert.match(text,/^Please re-check your last task and redo what did not work\./);
  assert.match(text,/- Failed \(shell_run, call call_tests\)\. Find out why and redo it\./);
  assert.match(text,/- Result unknown \(workspace_write, call call_save, notes\/<b>today<\/b>\.md\)\. It may or may not have happened: check the current state first/);
  // Plain words only.
  assert.equal(/receipt|outcome check/i.test(block.textContent+text),false);
});

test('missing, invalid or empty records render nothing',()=>{
  const {proof}=page();
  for(const empty of [undefined,null,'x',[],{},{status:'verified'},{status:'checked',checked:{}},{status:'checked',checked:{filesSaved:-1,sourcesRead:'3',searches:1.5}},{status:'attention',attention:{}},{status:'attention',attention:{commandsFailed:0}}])assert.equal(proof.footer(empty),'',JSON.stringify(empty));
  assert.equal(proof.redoText({status:'checked',checked:{filesSaved:1}}),'');
  // Huge numbers are capped and unknown item kinds and odd fields are dropped.
  const html=proof.footer({status:'attention',attention:{commandsFailed:1e12},items:[{kind:'<script>'},{kind:'command_failed',tool:'<img src=x onerror=alert(1)>',callId:'"><x>'}]},{botId:'"><img>'});
  assert.equal(/<img|<script|<x>/.test(html),false);assert.match(html,/9999 commands failed/);
  const {document}=page();document.body.innerHTML=html;
  assert.deepEqual([...document.querySelectorAll('li')].map(item=>item.textContent),['Failed: Step']);
  assert.equal(document.querySelector('[data-proof-redo]').dataset.botId,'"><img>');
});

test('Ask to redo sends through the chat form when the box is free',()=>{
  const {window,document,proof}=page(composer());
  document.querySelector('#thread').innerHTML=proof.footer(attention,{botId:'bot_atlas'});
  let submitted=null;document.querySelector('#message-form').addEventListener('submit',event=>{event.preventDefault();submitted={text:document.querySelector('#message-input').value,submitter:event.submitter?.className};});
  const button=document.querySelector('[data-proof-redo]');button.click();
  assert.deepEqual(submitted,{text:proof.redoText(attention),submitter:'send'});
  assert.equal(button.disabled,true,'a double tap is absorbed');assert.equal(document.querySelector('.proof-status').textContent,'Sending…');
  window.close();
});

test('Ask to redo only fills the box when the owner is typing, has files attached or a task is running',()=>{
  for(const state of [{text:'my draft'},{attachment:true},{busy:true}]) {
    const {window,document,proof}=page(composer(state));
    document.querySelector('#thread').innerHTML=proof.footer(attention,{botId:'bot_atlas'});
    let submitted=false;document.querySelector('#message-form').addEventListener('submit',event=>{event.preventDefault();submitted=true;});
    document.querySelector('[data-proof-redo]').click();
    assert.equal(submitted,false,JSON.stringify(state));
    const value=document.querySelector('#message-input').value;
    assert.ok(value.endsWith(proof.redoText(attention)));if(state.text)assert.ok(value.startsWith('my draft\n\n'),'the draft is kept');
    assert.match(document.querySelector('.proof-status').textContent,state.busy?/when the current task has finished/:/Review it and send/);
    window.close();
  }
  // Another bot's chat is never used.
  const {window,document,proof}=page(composer({id:'bot_scout'}));
  document.querySelector('#thread').innerHTML=proof.footer(attention,{botId:'bot_atlas'});
  document.querySelector('[data-proof-redo]').click();
  assert.equal(document.querySelector('#message-input').value,'');assert.match(document.querySelector('.proof-status').textContent,/Open the chat with this bot/);
  window.close();
});

test('the chat shows the line under bot replies, partial ones included, and loads its assets',()=>{
  assert.ok(app.includes("${!user&&!system&&!asked&&message.proof?window.StudioProof?.footer(message.proof,{botId:bot?.id||'',messageKey:messageKey(message)})||'':''}"));
  assert.ok(index.indexOf('<script defer src="/proof-of-work.js"></script>')>index.indexOf('<script defer src="/run-usage.js"></script>'));
  assert.match(index,/<link rel="stylesheet" href="\/proof-of-work\.css">/);
  assert.match(css,/@media \(max-width:760px\)\{\.proof-of-work>summary\{min-height:44px\}\.proof-actions \.proof-redo\{min-height:44px\}\}/);
  assert.equal(/animation|transition/.test(css),false);
});
