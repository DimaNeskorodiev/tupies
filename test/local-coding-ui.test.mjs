import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const source=await readFile(new URL('../public/local-coding.js',import.meta.url),'utf8');
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
async function settle(){await turn();await turn();}
function harness(t,{snapshot,api:override}={}){
  const dom=new JSDOM('<main id="main"></main><div id="dialogs"></div>',{url:'https://fixture.test/#/coding',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const {window}=dom,document=window.document,calls=[],toasts=[],copies=[];window.eval(source);
  Object.defineProperty(window.navigator,'clipboard',{value:{writeText:async value=>copies.push(value)}});
  const data={bots:[{id:'atlas',name:'Atlas',tools:['coding']},{id:'nova',name:'Nova',tools:['workspace']} ]};
  const value=snapshot||{available:true,agents:[{id:'claude',label:'Claude Code',detected:true,executable:'/usr/local/bin/claude',setupCommand:'HOME=/tmp/fixture claude auth login'},{id:'codex',label:'Codex',detected:false,executable:''}],projects:[],jobs:[]};
  let route={view:'coding'};
  const ctx={data,esc:escape,icon:()=>'<svg aria-hidden="true"></svg>',settingsHeading:()=>'<h1>Settings</h1>',route:()=>route,relative:()=> 'Just now',errorText:error=>error.message,
    api:async(path,options={})=>{calls.push({path,options:JSON.parse(JSON.stringify(options))});const result=await override?.(path,options);if(result!==undefined)return result;if(path==='/api/local-coding')return value;if(path==='/api/local-coding/projects')return {project:options.body};if(path.startsWith('/api/local-coding/agents/')){Object.assign(value.agents.find(agent=>path.endsWith(agent.id)),{...options.body,configured:true});return {agent:options.body};}throw new Error(`Unexpected API ${path}`);},
    openDialog:(title,body)=>document.querySelector('#dialogs').innerHTML=`<dialog open aria-label="${escape(title)}">${body}</dialog>`,closeDialog:()=>document.querySelector('#dialogs').innerHTML='',toast:(...args)=>toasts.push(args),navigate:path=>route={view:path.split('/')[1],id:path.split('/')[2]},
  };
  const root=document.querySelector('#main');ctx.renderApp=()=>{root.innerHTML=window.TupiesCoding.render(ctx);window.TupiesCoding.mount(ctx,root);};ctx.renderApp();
  const click=selector=>{const node=document.querySelector(selector);assert.ok(node,selector);node.click();};
  const submit=selector=>document.querySelector(selector).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  return {window,document,root,ctx,calls,toasts,copies,data,value,click,submit};
}

test('coding setup discovers nothing until the owner explicitly requests it',async t=>{
  const h=harness(t,{api:async path=>path==='/api/local-coding/discover'?{projects:[{name:'My app',path:'/Users/fixture/Projects/app',source:'claude',repositoryName:'fixture-app'}],truncated:false}:undefined});await settle();
  assert.equal(h.calls.length,1);assert.match(h.root.textContent,/Let Tupies find the context/);assert.match(h.root.textContent,/Connect the account you already use/);assert.equal(h.document.querySelector('#coding-project-form'),null);
  h.click('[data-coding-action="discover"]');await settle();assert.deepEqual(h.calls.find(call=>call.path.endsWith('/discover')).options,{method:'POST',body:{includeClaudeProjects:true}});assert.match(h.root.textContent,/Referenced by Claude Code/);
  h.click('[data-coding-action="use-discovered"]');const form=h.document.querySelector('#coding-project-form');assert.equal(form.querySelector('[name=path]').value,'/Users/fixture/Projects/app');assert.equal(form.querySelector('[name=organization]').required,false);assert.equal(form.querySelector('.coding-advanced').open,false);form.querySelector('[name=botId]').checked=true;h.submit('#coding-project-form');await settle();assert.equal(h.calls.find(call=>call.path==='/api/local-coding/projects').options.body.repositoryName,'fixture-app');
});

test('using an existing account is an explicit saved connection and never copies credentials',async t=>{
  const h=harness(t);await settle();h.click('[data-coding-action="agent"][data-id="claude"]');assert.equal(h.document.querySelector('[name=account]').value,'existing');assert.equal(h.calls.filter(call=>call.options.method).length,0);
  h.submit('#coding-agent-form');await settle();assert.deepEqual(h.calls.find(call=>call.path==='/api/local-coding/agents/claude').options,{method:'PUT',body:{executable:'/usr/local/bin/claude',account:'existing'}});assert.equal(h.copies.length,0);assert.equal(h.document.querySelector('dialog'),null);
});

test('separate sign-in shows a copyable setup command only after choosing it',async t=>{
  const h=harness(t);await settle();h.click('[data-coding-action="agent"][data-id="claude"]');assert.equal(h.document.querySelector('[data-coding-action="copy-login"]'),null);h.document.querySelector('[name=account]').value='dedicated';h.submit('#coding-agent-form');await settle();
  h.click('[data-coding-action="copy-login"]');await settle();assert.deepEqual(h.copies,['HOME=/tmp/fixture claude auth login']);assert.match(h.document.querySelector('dialog').textContent,/Sign in from Terminal/);
});

test('local-only project setup sends exact selected bots and checks without changing bot permissions',async t=>{
  const h=harness(t);await settle();h.click('[data-coding-action="project"]');const form=h.document.querySelector('#coding-project-form');for(const [name,value]of Object.entries({name:'Demo',path:'/Users/fixture/demo',agent:'claude',baseBranch:'main'}))form.querySelector(`[name=${name}]`).value=value;
  form.querySelector('[name=botId][value=nova]').checked=true;h.click('[data-coding-action="add-check"]');form.querySelector('[name=checkName]').value='Tests';form.querySelector('[name=checkExecutable]').value='npm';form.querySelector('[name=checkArgs]').value='["test"]';h.submit('#coding-project-form');await settle();
  const saved=h.calls.find(call=>call.path==='/api/local-coding/projects').options.body;assert.deepEqual(saved,{name:'Demo',path:'/Users/fixture/demo',agent:'claude',organization:'',project:'',repositoryId:'',baseBranch:'main',botIds:['nova'],checks:[{name:'Tests',executable:'npm',args:['test']}]});assert.equal(h.calls.some(call=>call.path.startsWith('/api/bots/')),false);
});

test('project secrets are submitted only when typed and are not retained after success',async t=>{
  const snapshot={available:true,agents:[{id:'claude',label:'Claude Code'}],projects:[{id:'project_one',name:'App',path:'/tmp/app',agent:'claude',organization:'org',project:'project',botIds:['atlas'],checks:[],azureConfigured:true}],jobs:[]};const h=harness(t,{snapshot});await settle();
  h.click('[data-coding-action="project"]');assert.equal(h.document.querySelector('[name=token]').type,'password');assert.equal(h.document.querySelector('[name=token]').value,'');h.submit('#coding-project-form');await settle();assert.equal(Object.hasOwn(h.calls.find(call=>call.path==='/api/local-coding/projects').options.body,'token'),false);
  h.click('[data-coding-action="project"]');h.document.querySelector('[name=token]').value='synthetic-token';h.submit('#coding-project-form');await settle();assert.equal(h.calls.filter(call=>call.path==='/api/local-coding/projects').at(-1).options.body.token,'synthetic-token');assert.ok(!h.root.textContent.includes('synthetic-token'));assert.equal(h.document.querySelector('[name=token]'),null);
});

test('untrusted project, work item and progress content is displayed only as text',async t=>{
  const malicious='<img src=x onerror=alert(1)>',snapshot={available:true,agents:[{id:'claude',label:'Claude Code'}],projects:[{id:'p',name:malicious,path:'/tmp/<script>',agent:'claude',botIds:['atlas'],azureConfigured:true}],jobs:[{id:'j',projectId:'p',agent:'claude',status:'failed',workItemTitle:malicious,error:'<script>failure</script>',events:[{type:'<b>event</b>',text:'<iframe src=x>'}]}]};const h=harness(t,{snapshot,api:async path=>path.endsWith('/work-items')?{items:[{id:42,title:malicious,state:'Active'}]}:undefined});await settle();assert.equal(h.root.querySelectorAll('img,script,iframe,b').length,0);
  h.click('[data-coding-action="job"]');assert.equal(h.document.querySelector('dialog').querySelectorAll('img,script,iframe,b').length,0);assert.match(h.document.querySelector('dialog').textContent,/Needs attention/);
  h.click('[data-coding-action="items"]');await settle();assert.equal(h.document.querySelector('dialog').querySelectorAll('img,script,iframe,b').length,0);h.click('[data-coding-action="copy-task"]');await settle();assert.match(h.copies[0],/work item #42/);assert.equal(h.calls.filter(call=>call.options.method==='POST').length,0);
});

test('failed saves retain all entered fields and never claim success or retry the write',async t=>{
  const h=harness(t,{api:async path=>{if(path==='/api/local-coding/projects')throw new Error('Repository cannot be accessed.');}});await settle();h.click('[data-coding-action="project"]');const form=h.document.querySelector('#coding-project-form');form.querySelector('[name=name]').value='Keep my draft';form.querySelector('[name=path]').value='/missing/repo';h.submit('#coding-project-form');await settle();assert.equal(form.querySelector('[name=name]').value,'Keep my draft');assert.match(form.querySelector('.form-error').textContent,/cannot be accessed/);assert.equal(form.querySelector('[type=submit]').disabled,false);assert.equal(h.toasts.length,0);assert.equal(h.calls.filter(call=>call.path==='/api/local-coding/projects').length,1);
});

test('late discovery cannot restore private project metadata after sign-out',async t=>{
  let resolve;const pending=new Promise(done=>resolve=done),h=harness(t,{api:async path=>path.endsWith('/discover')?pending:undefined});await settle();h.click('[data-coding-action="discover"]');await turn();h.window.TupiesCoding.reset();h.root.innerHTML='<p>Signed out</p>';resolve({projects:[{path:'/private/project',name:'Private app'}]});await settle();assert.equal(h.root.textContent,'Signed out');
});

test('refresh leaves a project dialog draft intact and non-Mac engines expose no action forms',async t=>{
  const h=harness(t);await settle();h.click('[data-coding-action="project"]');h.document.querySelector('[name=name]').value='Draft';h.click('[data-coding-action="refresh"]');await settle();assert.equal(h.document.querySelector('[name=name]').value,'Draft');
  h.value.available=false;h.ctx.closeDialog();h.click('[data-coding-action="refresh"]');await settle();assert.match(h.root.textContent,/Use the This Mac engine/);assert.equal(h.root.querySelector('[data-coding-action="discover"]'),null);assert.equal(h.root.querySelector('[data-coding-action="agent"]'),null);
});

test('leaving during setup loading does not strand the page in a loading state',async t=>{
  let resolve,count=0;const pending=new Promise(done=>resolve=done),h=harness(t,{api:async path=>path==='/api/local-coding'&&++count===1?pending:undefined});await turn();h.ctx.navigate('/settings');resolve({available:true,agents:[],projects:[],jobs:[]});await settle();h.ctx.navigate('/coding');h.ctx.renderApp();await settle();assert.equal(count,2);assert.match(h.root.textContent,/Your coding apps/);assert.doesNotMatch(h.root.textContent,/Checking this engine/);
});

test('a late save preserves a newer dialog while recording successful setup',async t=>{
  let resolve;const pending=new Promise(done=>resolve=done),h=harness(t,{api:async path=>path==='/api/local-coding/projects'?pending:undefined});await settle();h.click('[data-coding-action="project"]');h.submit('#coding-project-form');await turn();h.ctx.closeDialog();h.click('[data-coding-action="agent"][data-id="claude"]');resolve({});await settle();assert.ok(h.document.querySelector('#coding-agent-form'));assert.equal(h.document.querySelector('#coding-project-form'),null);assert.ok(h.toasts.some(([message])=>message==='Coding project saved.'));
});

test('detected unsupported agents cannot be connected and completed worker output is not labelled verified',async t=>{
  const h=harness(t,{snapshot:{available:true,agents:[{id:'claude',label:'Claude Code',detected:true,configured:false,account:'dedicated'},{id:'codex',label:'Codex',detected:true,supported:false,reason:'Exact command approvals unavailable.'}],projects:[],jobs:[{id:'pending',agent:'claude',status:'needs_verification',summary:'Agent finished.'},{id:'checked',agent:'claude',status:'ready_for_review'}]}});await settle();
  const unavailable=h.document.querySelector('[data-coding-action="agent"][data-id="codex"]');assert.equal(unavailable.disabled,true);assert.match(h.root.textContent,/Exact command approvals unavailable/);assert.match(h.root.textContent,/Needs verification/);assert.match(h.root.textContent,/Ready for review/);h.click('[data-coding-action="agent"][data-id="claude"]');assert.equal(h.document.querySelector('[name=account]').value,'existing');
});
