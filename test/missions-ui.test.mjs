import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const source=await readFile(new URL('../public/missions.js',import.meta.url),'utf8');
const appSource=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
const at='2026-11-01T12:00:00Z';
const fixture=()=>({id:'mission_qa',title:'A clear research report',goal:'Compare sources and produce a report.',leadBotId:'bot_atlas',revision:2,status:'running',updatedAt:at,canControl:true,currentRun:{id:'run_qa',missionId:'mission_qa',botId:'bot_atlas',status:'running'},participants:[{botId:'bot_atlas',role:'Lead'},{botId:'bot_echo',role:'Reviewer'}],progress:{verified:1,total:3,percent:33},requirements:[{id:'r1',title:'Read sources',status:'verified'},{id:'r2',title:'Write report',status:'pending'}],results:[],activity:[]});
function harness(t,{mission=fixture(),detail=false,api}={}){
 const dom=new JSDOM('<div id="main"></div><div id="dialog-root"></div>',{url:`http://fixture.local/#/missions${detail?'/'+mission.id:''}`,runScripts:'outside-only'}),win=dom.window,doc=win.document,requests=[];
 win.setInterval=()=>1;win.clearInterval=()=>{};vm.runInContext(source,dom.getInternalVMContext());
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const data={missions:[mission],bots:[{id:'bot_atlas',name:'Atlas'},{id:'bot_echo',name:'Echo'},{id:'bot_nova',name:'Nova'}]};
 const ctx={data,esc,icon:()=>'<svg aria-hidden="true"></svg>',avatar:b=>`<span class="avatar">${esc(b.name)}</span>`,botById:id=>data.bots.find(b=>b.id===id),relative:()=> 'Just now',route:()=>{const [view,id]=win.location.hash.slice(2).split('/');return {view,id};},toast(){},errorText:e=>e.message,navigate:path=>{win.location.hash=path;},closeDialog:()=>{doc.querySelector('#dialog-root').innerHTML='';},openDialog:(title,html)=>{doc.querySelector('#dialog-root').innerHTML=html;},api:async(path,options)=>{requests.push({path,options});return api?api(path,options):path==='/api/missions'?{missions:[mission]}:{mission};}};
 const root=doc.querySelector('#main'),show=()=>{root.innerHTML=win.StudioMissions.render(ctx);win.StudioMissions.mount(ctx,root);};
 t.after(()=>dom.window.close());return {dom,win,doc,ctx,root,show,requests,mission};
}
test('Mission renders five main routes and shares escaped cards by identity',async t=>{
 const h=harness(t);const context=h.dom.getInternalVMContext();h.win.matchMedia=()=>({matches:false,addEventListener(){}});h.doc.body.innerHTML='<div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>';h.win.scrollTo=()=>{};
 vm.runInContext(appSource,context);h.win.qaData={...h.ctx.data,connections:[],routines:[],rooms:[],runs:{},skills:[],settings:{}};
 vm.runInContext('data={...initialState,...qaData};auth={authenticated:true};bootPending=false;renderApp();',context);
 assert.deepEqual([...h.doc.querySelectorAll('.tabbar .tab')].map(n=>n.dataset.nav),['/dashboard','/bots','/missions','/rooms','/routines']);
 assert.equal(h.doc.querySelector('.tabbar [aria-current]').dataset.nav,'/missions');
 assert.match(h.win.StudioMissions.chatCard(h.ctx,{missionId:'mission_qa'}),/#\/missions\/mission_qa/);
 assert.doesNotMatch(h.win.StudioMissions.chatCard(h.ctx,{missionId:'mission_qa'}),/Pause|budget/);
});
test('search, filters and actual participants use received Engine state',async t=>{
 const h=harness(t);h.show();await tick();assert.match(h.root.textContent,/1 of 3 outcomes verified/);assert.match(h.root.textContent,/Atlas/);assert.doesNotMatch(h.root.textContent,/Nova/);
 const input=h.doc.querySelector('[data-mission-search]');input.value='missing';input.dispatchEvent(new h.win.Event('input',{bubbles:true}));assert.match(h.root.textContent,/No matching Missions/);
 h.doc.querySelector('[data-mission-action="clear-search"]').click();assert.equal(h.doc.querySelector('[data-mission-search]').value,'');assert.match(h.root.textContent,/A clear research report/);
 h.doc.querySelector('[data-mission-filter="attention"]').click();assert.match(h.root.textContent,/Nothing needs your attention/);
});
test('unknown progress and unverified files never become claimed evidence or file actions',async t=>{
 const m=fixture();m.progress={verified:2,total:0,percent:100};m.title='<img src=x onerror=alert(1)>';m.results=[{id:'fake',title:'<script>bad</script>',verified:false,file:{botId:'bot_atlas',path:'guessed.pdf'}}];
 const h=harness(t,{mission:m,detail:true});h.show();await tick();assert.equal(h.doc.querySelector('[role=progressbar]').hasAttribute('aria-valuenow'),false);assert.match(h.root.textContent,/Defining the outcomes/);assert.equal(h.doc.querySelectorAll('img,script').length,0);assert.equal(h.doc.querySelector('[data-mission-action="preview"]'),null);
 m.results[0].verified=true;await h.win.StudioMissions.reload();assert.equal(h.doc.querySelector('.mission-result a'),null);m.results[0].file.verified=true;m.results[0].file.snapshotUrl='/api/missions/mission_qa/evidence/evidence_'+ 'a'.repeat(64)+'/download';await h.win.StudioMissions.reload();assert.ok(h.doc.querySelector('.mission-result a[download]'));
});
test('direction draft and focus survive live updates, navigation and control revision rejection',async t=>{
 let rejection=false;const h=harness(t,{detail:true,api:async(path,options)=>{if(options){if(rejection)throw Object.assign(new Error('Mission changed. Review current requirements.'),{status:409});return {mission:h.mission};}return {mission:h.mission};}});h.show();await tick();
 const field=h.doc.querySelector('[data-mission-direction] textarea');field.value='Keep source citations';field.focus();field.dispatchEvent(new h.win.Event('input',{bubbles:true}));h.mission.revision=3;h.mission.progress={verified:0,total:3,percent:0};await h.win.StudioMissions.reload();assert.equal(h.doc.querySelector('[data-mission-direction] textarea'),field);assert.equal(field.value,'Keep source citations');assert.equal(h.doc.activeElement,field);assert.match(h.root.textContent,/0 of 3 outcomes verified/);
 rejection=true;field.closest('form').dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(field.value,'Keep source citations');assert.match(field.closest('form').textContent,/Mission changed/);assert.equal(h.requests.find(r=>r.options)?.options.body.revision,3);
 h.win.location.hash='#/missions';h.show();h.win.location.hash='#/missions/mission_qa';h.show();assert.equal(h.doc.querySelector('[data-mission-direction] textarea').value,'Keep source citations');
});
test('create preserves draft across dialog close and reuses id after a lost acknowledgement',async t=>{
 let attempts=0;const h=harness(t,{api:async(path,options)=>{if(!options)return {missions:[]};attempts++;if(attempts===1)throw new Error('Lost acknowledgement');return {mission:fixture()};}});h.show();await tick();h.win.StudioMissions.create(h.ctx);
 const goal=h.doc.querySelector('[name=goal]');goal.value='Prepare a checked report';goal.dispatchEvent(new h.win.Event('input',{bubbles:true}));h.ctx.closeDialog();h.win.StudioMissions.create(h.ctx);assert.equal(h.doc.querySelector('[name=goal]').value,'Prepare a checked report');
 const form=h.doc.querySelector('[data-mission-create]');form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.match(form.textContent,/Lost acknowledgement/);form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();const creates=h.requests.filter(r=>r.options);assert.equal(creates.length,2);assert.equal(creates[0].options.body.clientMessageId,creates[1].options.body.clientMessageId);assert.equal(h.win.location.hash,'#/missions/mission_qa');
});
test('remote summary exposes no owner controls and reset discards late responses',async t=>{
 const m=fixture();m.remote=true;let resolve;const h=harness(t,{mission:m,detail:true,api:()=>new Promise(r=>{resolve=r;})});h.show();assert.equal(h.doc.querySelector('[data-mission-action="stop"]'),null);assert.equal(h.doc.querySelector('[data-mission-direction]'),null);assert.match(h.root.textContent,/Summary from another engine/);
 h.win.StudioMissions.reset();resolve({mission:m});await tick();h.ctx.data.missions=[];h.win.location.hash='#/missions';h.root.innerHTML=h.win.StudioMissions.render(h.ctx);assert.doesNotMatch(h.root.textContent,/A clear research report/);
});
test('pending owner question nodes survive only while the exact prompt identity matches',async t=>{
 const h=harness(t,{detail:true});h.mission.currentRun={id:'run_qa',execution_generation:1,pending_controls:[{kind:'question',prompt_id:'q1'}]};h.ctx.missionControls=m=>`<div data-question="${m.currentRun.pending_controls[0].prompt_id}"><textarea>answer</textarea></div>`;h.show();await tick();const question=h.doc.querySelector('[data-question]');await h.win.StudioMissions.reload();assert.equal(h.doc.querySelector('[data-question]'),question);h.mission.currentRun.pending_controls[0].prompt_id='q2';await h.win.StudioMissions.reload();assert.notEqual(h.doc.querySelector('[data-question]'),question);assert.equal(h.doc.querySelector('[data-question]').dataset.question,'q2');
});

test('newer create and direction drafts survive a receipt for the submitted text',async t=>{
 let resolve;const h=harness(t,{api:async(path,options)=>options?new Promise(r=>{resolve=r;}):{missions:[fixture()]}});h.show();await tick();h.win.StudioMissions.create(h.ctx);
 const goal=h.doc.querySelector('[name=goal]');goal.value='First goal';goal.dispatchEvent(new h.win.Event('input',{bubbles:true}));const form=goal.closest('form');form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();goal.value='Newer unsent goal';goal.dispatchEvent(new h.win.Event('input',{bubbles:true}));resolve({mission:fixture()});await tick();assert.equal(goal.value,'Newer unsent goal');assert.ok(form.isConnected);assert.match(form.textContent,/newer goal draft is preserved/);assert.equal(h.win.location.hash,'#/missions');
});
test('terminal blocked outcomes remain reviewable without active execution controls',async t=>{
 const m=fixture();m.status='blocked';m.executionState='terminal';m.currentRun.status='completed';const h=harness(t,{mission:m,detail:true});h.show();await tick();assert.equal(h.doc.querySelector('[data-mission-action="stop"]'),null);assert.equal(h.doc.querySelector('[data-mission-direction]'),null);assert.match(h.root.textContent,/Needs attention/);assert.ok(h.doc.querySelector('[data-mission-action="archive"]'));
});

test('settled Mission retry is explicit, revision guarded and unavailable for current achieved or remote work',async t=>{
 const m=fixture();m.status='failed';m.executionState='terminal';m.currentRun={id:'run_old',status:'failed'};let pending;
 const h=harness(t,{mission:m,detail:true,api:async(path,options)=>options?new Promise(resolve=>{pending=resolve;}):{mission:m}});h.show();await tick();
 const button=h.doc.querySelector('[data-mission-action="run-again"]');assert.ok(button);button.click();button.click();await tick();assert.equal(h.requests.filter(r=>r.options).length,1);assert.deepEqual(JSON.parse(JSON.stringify(h.requests.find(r=>r.options).options.body)),{action:'retry',revision:2});
 pending({mission:{...m,revision:3,status:'running',executionState:'running',currentRun:{id:'run_new',missionId:m.id,botId:m.leadBotId,status:'running'}}});await tick();assert.equal(h.doc.querySelector('[data-mission-action="run-again"]'),null);assert.equal(h.doc.querySelector('[data-mission-direction] [type=submit]').disabled,false);
 m.status='achieved';await h.win.StudioMissions.reload();assert.equal(h.doc.querySelector('[data-mission-action="run-again"]'),null);assert.ok(h.doc.querySelector('[data-mission-action="change-goal"]'));
 m.remote=true;await h.win.StudioMissions.reload();assert.equal(h.doc.querySelector('[data-mission-action="change-goal"]'),null);
});

test('goal revisions preserve edited drafts and base revision after conflict or lost acknowledgement',async t=>{
 const m=fixture();m.status='achieved';m.executionState='terminal';m.currentRun.status='completed';let failure=409;const h=harness(t,{mission:m,detail:true,api:async(path,options)=>{if(options){if(failure)throw Object.assign(new Error(failure===409?'Mission changed':'Lost acknowledgement'),{status:failure===409?409:undefined});return {mission:{...m,goal:options.body.text,revision:5,status:'needs_attention',executionState:'waiting',progress:{verified:0,total:0,percent:0}}};}return {mission:m};}});h.show();await tick();h.doc.querySelector('[data-mission-action="change-goal"]').click();
 let form=h.doc.querySelector('[data-mission-revise]'),field=form.elements.text;field.value='A revised owner goal';field.dispatchEvent(new h.win.Event('input',{bubbles:true}));form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(field.value,'A revised owner goal');assert.match(form.textContent,/draft is preserved/);assert.equal(h.requests.find(r=>r.options).options.body.revision,2);
 h.ctx.closeDialog();m.revision=4;await h.win.StudioMissions.reload();h.doc.querySelector('[data-mission-action="change-goal"]').click();form=h.doc.querySelector('[data-mission-revise]');assert.equal(form.elements.text.value,'A revised owner goal');assert.equal(form.dataset.revision,'4');failure=500;form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();const before=h.requests.filter(r=>r.options).at(-1).options.body.clientMessageId;
 failure=0;form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(h.requests.filter(r=>r.options).at(-1).options.body.clientMessageId,before);assert.equal(h.doc.querySelector('[data-mission-revise]'),null);assert.ok(h.doc.querySelector('[data-mission-action="run-again"]'));assert.equal(h.doc.querySelector('[role=progressbar]').hasAttribute('aria-valuenow'),false);
});

test('notification attention identities appear only on exact local detail controls or blocker panels',async t=>{
 const m=fixture();m.status='needs_attention';m.executionState='waiting';m.currentRun={id:'run_approval',missionId:m.id,botId:m.leadBotId,status:'waiting_for_approval',execution_generation:3};m.notificationAttention={kind:'approval',attentionId:'a'.repeat(32),missionId:m.id,botId:m.leadBotId,runId:'run_approval',generation:3};
 const h=harness(t,{mission:m,detail:true});h.ctx.missionControls=()=>'<button>Review exact action</button>';h.show();await tick();assert.equal(h.doc.querySelector('[data-notification-attention-id]').dataset.notificationAttentionId,'a'.repeat(32));assert.equal(h.win.StudioMissions.attendance().notificationAttention.attentionId,'a'.repeat(32));
 m.notificationAttention.generation=4;await h.win.StudioMissions.reload();assert.equal(h.doc.querySelector('[data-notification-attention-id]'),null);
 m.currentRun=null;m.notificationAttention={kind:'blocker',attentionId:'b'.repeat(32),missionId:m.id,botId:m.leadBotId,title:'Coordinator unavailable',detail:'Choose an available provider before trying again.'};await h.win.StudioMissions.reload();assert.ok(h.doc.querySelector('[data-notification-attention-id]'));assert.match(h.root.textContent,/Coordinator unavailable/);
 m.remote=true;await h.win.StudioMissions.reload();assert.equal(h.doc.querySelector('[data-notification-attention-id]'),null);assert.equal(h.win.StudioMissions.attendance(),null);
});

test('Pause and Resume use exact local detail revision while remote summaries cannot control',async t=>{
 const m=fixture();m.canPause=true;const h=harness(t,{mission:m,detail:true,api:async(path,options)=>{if(options){m.revision++;m.status=options.body.action==='pause'?'paused':'running';m.canPause=m.status==='running';m.canResume=m.status==='paused';}return {mission:m};}});h.show();await tick();
 h.doc.querySelector('[data-mission-action=pause]').click();await tick();assert.equal(h.requests.find(r=>r.options).options.body.revision,2);assert.equal(h.requests.find(r=>r.options).options.body.action,'pause');assert.match(h.root.textContent,/Paused/);h.doc.querySelector('[data-mission-action=resume]').click();await tick();assert.equal(h.requests.filter(r=>r.options)[1].options.body.revision,3);
 m.remote=true;await h.win.StudioMissions.reload();assert.equal(h.doc.querySelector('[data-mission-action=pause]'),null);assert.equal(h.doc.querySelector('[data-mission-action=wait]'),null);
});
test('resource quantities stay honest and owner limit drafts survive revision conflict and close',async t=>{
 const m=fixture();m.resources={limits:{tokens:4000},used:{tokens:100,moneyMicros:0},reserved:{tokens:200,moneyMicros:0},unknown:{tokens:300,moneyMicros:0,requests:1},remaining:{tokens:3400},moneyBasis:'estimated_not_provider_bill',unknownUnbounded:['moneyMicros','requests'],readiness:[{dimension:'moneyMicros',status:'unavailable',detail:'Prices are unknown. A monetary limit cannot admit new work.'}],priceNotice:'Subscription balance and bill are unavailable.',canEdit:true};
 const h=harness(t,{mission:m,detail:true,api:async(path,options)=>{if(options)throw Object.assign(new Error('The Mission changed.'),{status:409});return {mission:m};}});h.show();await tick();assert.match(h.root.textContent,/Subscription balance/);assert.doesNotMatch(h.root.textContent,/\$0\.000000/);assert.match(h.root.textContent,/Active tool\/model time/);const requestRow=[...h.doc.querySelectorAll('.mission-resource-row')].find(row=>row.textContent.includes('API requests'));assert.equal(requestRow.querySelectorAll('dd')[2].textContent,'Unknown');
 h.doc.querySelector('[data-mission-action=limits]').click();let form=h.doc.querySelector('[data-mission-owner-form]');form.elements.tokens.value='6000';form.elements.moneyMicros.value='0.000029';form.elements.tokens.dispatchEvent(new h.win.Event('input',{bubbles:true}));form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(h.requests.find(r=>r.options).options.body.limits.tokens,6000);assert.equal(h.requests.find(r=>r.options).options.body.limits.moneyMicros,29);assert.equal(h.requests.find(r=>r.options).options.body.revision,2);assert.match(form.textContent,/draft is preserved/);h.ctx.closeDialog();m.revision=5;await h.win.StudioMissions.reload();h.doc.querySelector('[data-mission-action=limits]').click();form=h.doc.querySelector('[data-mission-owner-form]');assert.equal(form.elements.tokens.value,'6000');assert.equal(form.dataset.revision,'5');
});
test('Timer and private file wait forms submit typed bounded owner requests',async t=>{
 const m=fixture();m.canPause=true;const h=harness(t,{mission:m,detail:true});h.show();await tick();h.doc.querySelector('[data-mission-action=wait]').click();let form=h.doc.querySelector('[data-mission-owner-form]');form.elements.delaySeconds.value='3600';form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.deepEqual(JSON.parse(JSON.stringify(h.requests.find(r=>r.options).options.body)),{action:'wait',revision:2,wait:{kind:'timer',delayMs:3600000}});
 h.doc.querySelector('[data-mission-action=wait]').click();form=h.doc.querySelector('[data-mission-owner-form]');form.elements.kind.value='file_change';form.elements.path.value='outputs/source.txt';form.elements.intervalSeconds.value='2';form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.deepEqual(JSON.parse(JSON.stringify(h.requests.filter(r=>r.options).at(-1).options.body.wait)),{kind:'file_change',path:'outputs/source.txt',intervalMs:2000});
});
test('approach review uses exact paged digest, escaped content and an unsent reuse draft',async t=>{
 const m=fixture(),digest='a'.repeat(64);m.approaches=[{id:'approach_a',digest,title:'A <hostile> method',observedOutcome:'failed',accepted:false,contractVersion:1,reuse:{status:'historical'}}];let opened;
 const h=harness(t,{mission:m,detail:true,api:async path=>path.includes('/approaches/')?{id:'approach_a',digest,content:'<script>untrusted</script>\nUnknown effects remain.',offset:0,nextOffset:null,totalChars:49}:{mission:m}});h.ctx.openBotDraft=(botId,prompt)=>{opened={botId,prompt};};h.show();await tick();h.doc.querySelector('[data-mission-action=read-approach]').click();await tick();assert.match(h.requests.at(-1).path,/digest=a{64}&offset=0&limit=4000/);assert.equal(h.doc.querySelector('[data-mission-approach-detail] script'),null);assert.match(h.doc.querySelector('.mission-approach-content').textContent,/<script>/);h.doc.querySelector('[data-mission-action=use-approach]').click();await tick();assert.equal(opened.botId,m.leadBotId);assert.match(opened.prompt,/mission_approach_read/);assert.match(opened.prompt,/a{64}/);assert.match(opened.prompt,/My new goal:/);assert.equal(h.requests.filter(r=>r.options).length,0);
});

test('durable saved waits offer Resume without ordinary retry, goal replacement or inactive wait controls',async t=>{
 const m=fixture();m.status='waiting';m.executionState='waiting';m.canPause=true;m.canResume=true;m.wait={kind:'timer',nextWakeAt:at,deadline:at,reason:'Waiting for the saved timer.'};m.currentRun.status='interrupted';const h=harness(t,{mission:m,detail:true});h.show();await tick();assert.ok(h.doc.querySelector('[data-mission-action=resume]'));assert.equal(h.doc.querySelector('[data-mission-action=run-again]'),null);assert.equal(h.doc.querySelector('[data-mission-action=change-goal]'),null);assert.equal(h.doc.querySelector('[data-mission-action=wait]'),null);assert.match(h.root.textContent,/Waiting for a timer/);
});

test('actual participant requests link to their existing exact bot chat',async t=>{
 const m=fixture();m.participants[1].status='waiting_for_approval';const h=harness(t,{mission:m,detail:true});h.show();await tick();const link=h.doc.querySelector('.mission-people [data-nav="/bot/bot_echo"]');assert.ok(link);assert.equal(link.textContent,'Echo');assert.match(link.closest('li').textContent,/Needs approval/);assert.equal(h.doc.querySelector('.mission-people [data-nav="/bot/bot_nova"]'),null);
});
