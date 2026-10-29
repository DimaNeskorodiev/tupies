import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source=await readFile(new URL('../public/skills-store.js',import.meta.url),'utf8');
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const digest='a'.repeat(64);
const entry={catalogId:'tupies-source-check',title:'Source check',name:'source-check',description:'Check a claim against its original sources.',author:'Tupies',source:'bundled',version:'1.0.0',digest,examples:['Verify this announcement.'],compatibility:{status:'ready',reasons:[]}};
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
async function settled(){await turn();await turn();}
function harness(t,{api:override,entries=[entry],installed=[],routeId='bot_b',initialTab='installed'}={}){
  const dom=new JSDOM('<main id="main"></main><div id="dialogs"></div>',{url:`https://fixture.test/#/skills/${routeId}`,runScripts:'outside-only'});t.after(()=>dom.window.close());
  const {window}=dom,document=window.document,calls=[],toasts=[];
  window.eval(source);
  let route={view:'skills',id:routeId};
  const data={bots:[{id:'bot_a',name:'Atlas',skills:[],skillInstallPolicy:'ask'},{id:'bot_b',name:'Nova',skills:[],skillInstallPolicy:'ask'}],skills:installed};
  const ctx={data,esc,icon:()=>'<svg aria-hidden="true"></svg>',settingsHeading:()=>'<h1>Settings</h1>',route:()=>route,botById:id=>data.bots.find(bot=>bot.id===id),errorText:error=>error.message,
    api:async(path,options={})=>{calls.push({path,options:JSON.parse(JSON.stringify(options))});const value=await override?.(path,options);if(value!==undefined)return value;if(path.startsWith('/api/skills/catalog?'))return {skills:entries,categories:[{id:'research',name:'Research'}]};if(path.startsWith('/api/skills/installed?'))return {skills:installed};if(path==='/api/skills/inspect')return {...entry,content:'---\nname: source-check\n---\nInstructions',files:['SKILL.md']};if(path==='/api/skills/install')return {skill:{id:'immutable',title:entry.title}};if(path.startsWith('/api/bots/')||path==='/api/skills/assign')return {};throw new Error(`Unexpected API ${path}`);},
    navigate:path=>{const [,view,id]=path.split('/');route={view,id};},toast:(...args)=>toasts.push(args),closeDialog:()=>{document.querySelector('#dialogs').innerHTML='';},openDialog:(name,body)=>{document.querySelector('#dialogs').innerHTML=`<dialog open aria-label="${esc(name)}">${body}</dialog>`;},viewSkill:id=>calls.push({local:id}),importDialog:()=>calls.push({legacyImport:true}),confirmDelete:(kind,id)=>calls.push({confirmDelete:{kind,id}}),
  };
  const root=document.querySelector('#main');
  ctx.renderApp=()=>{root.innerHTML=window.StudioSkills.render(ctx);window.StudioSkills.mount(ctx,root);};
  ctx.refresh=async()=>{ctx.renderApp();};ctx.renderApp();
  if(initialTab!=='installed')document.querySelector(`[data-skills-action="tab"][data-tab="${initialTab}"]`).click();
  document.addEventListener('click',event=>{if(event.target.closest('[data-action="close-dialog"]'))ctx.closeDialog();});
  return {window,document,root,ctx,calls,toasts,data,click:selector=>{const node=document.querySelector(selector);assert.ok(node,selector);node.click();},route:value=>route=value};
}

test('catalog preselects the profile bot and keeps its tab, search and selection across host refreshes',async t=>{
  const h=harness(t);await settled();assert.equal(h.document.querySelector('#skills-target').value,'bot_b');
  h.click('[data-skills-action="tab"][data-tab="installed"]');
  const search=h.document.querySelector('#skills-search');search.value='written';search.dispatchEvent(new h.window.Event('input',{bubbles:true}));
  h.ctx.renderApp();assert.equal(h.document.querySelector('#skills-search').value,'written');assert.equal(h.document.querySelector('[data-tab="installed"]').getAttribute('aria-pressed'),'true');assert.equal(h.document.querySelector('#skills-target').value,'bot_b');
});

test('catalog and detail content are escaped and never rendered as active package HTML',async t=>{
  const dangerous={...entry,title:'<img src=x onerror=alert(1)>',description:'<script>bad()</script>',author:'<b>author</b>'};
  const h=harness(t,{initialTab:'catalog',entries:[dangerous],api:async path=>path==='/api/skills/inspect'?{...dangerous,content:'<img src=x onerror=alert(2)>',files:['<script>.js'],examples:['<iframe src=x>']}:undefined});
  await settled();assert.equal(h.root.querySelectorAll('img,script,b').length,0);assert.ok(h.root.textContent.includes(dangerous.title));
  h.click('[data-skills-action="inspect"]');await settled();const dialog=h.document.querySelector('dialog');assert.equal(dialog.querySelectorAll('img,script,iframe').length,0);assert.ok(dialog.querySelector('pre').textContent.includes('<img'));
});

test('one click installs the rendered exact revision for the selected bot',async t=>{
  const h=harness(t,{initialTab:'catalog'});await settled();h.click('[data-skills-action="install"]');await settled();
  const call=h.calls.find(item=>item.path==='/api/skills/install');assert.deepEqual(call.options.body,{catalogId:entry.catalogId,version:'1.0.0',digest,botId:'bot_b'});assert.match(h.toasts[0][0],/added to Nova/);
});

test('detail install retains the inspected version when the catalog changes',async t=>{
  const entries=[{...entry}],h=harness(t,{initialTab:'catalog',entries});await settled();h.click('[data-skills-action="inspect"]');await settled();
  entries[0]={...entry,version:'2.0.0',digest:'b'.repeat(64)};
  h.click('dialog [data-skills-action="install"]');await settled();
  assert.equal(h.calls.find(item=>item.path==='/api/skills/install').options.body.digest,digest);assert.equal(h.calls.find(item=>item.path==='/api/skills/install').options.body.version,'1.0.0');
});

test('failed installation is shown without automatically retrying or claiming success',async t=>{
  const h=harness(t,{initialTab:'catalog',api:async path=>{if(path==='/api/skills/install')throw new Error('This bot is working.');}});await settled();h.click('[data-skills-action="install"]');await settled();
  assert.equal(h.calls.filter(item=>item.path==='/api/skills/install').length,1);assert.match(h.root.querySelector('[data-skills-notice]').textContent,/bot is working/);assert.equal(h.toasts[0][1],true);assert.equal(h.document.querySelector('[data-skills-action="install"]').disabled,false);
});

test('a late catalog response cannot survive a sign-out reset',async t=>{
  let resolve;const pending=new Promise(done=>resolve=done);const h=harness(t,{api:async path=>path.startsWith('/api/skills/catalog?')?pending:undefined});await turn();
  h.window.StudioSkills.reset();h.root.innerHTML='<p>Signed out</p>';resolve({skills:[entry],categories:[]});await settled();assert.equal(h.root.textContent,'Signed out');
});

test('the selected bot policy sends only an explicit owner setting',async t=>{
  const h=harness(t,{initialTab:'preferences'});await settled();const policy=h.document.querySelector('#skills-policy');policy.value='trusted';policy.dispatchEvent(new h.window.Event('change',{bubbles:true}));await settled();
  const call=h.calls.find(item=>item.path==='/api/bots/bot_b');assert.deepEqual(call.options.body,{skillInstallPolicy:'trusted'});assert.match(h.root.textContent,/Scripts, account connections and outside actions keep their own approvals/);
});

test('URL import previews server packages and installs only the opaque reviewed preview identity',async t=>{
  const h=harness(t,{api:async path=>path==='/api/skills/import/preview'?{importId:'import_fixture',packages:[{key:'folder/source-check',skill:{name:'source-check',description:'Original workflow'},compatibility:{status:'needs_setup',reasons:['Connect the source service.']}}]}:path==='/api/skills/import'?{skill:{id:'imported'}}:undefined});await settled();h.click('[data-skills-action="import"]');
  const form=h.document.querySelector('#skills-import-form');form.querySelector('[name="url"]').value='https://example.com/SKILL.md';form.dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));await settled();
  assert.match(h.document.querySelector('dialog').textContent,/Connect the source service/);h.click('[data-skills-action="import-install"]');await settled();
  const call=h.calls.find(item=>item.path==='/api/skills/import');assert.deepEqual(call.options.body,{importId:'import_fixture',key:'folder/source-check',botId:'bot_b'});assert.ok(!Object.hasOwn(call.options.body,'files'));
});

test('installed skills can be added and removed without touching other assignments',async t=>{
  const installed=[{id:'local-workflow',name:'Workflow',description:'An imported workflow',compatibility:{status:'ready',reasons:[]}}],h=harness(t,{installed});h.data.bots[1].skills=['existing'];await settled();h.click('[data-skills-action="manage"]');h.click('[data-skills-field="assignment"][data-bot-id="bot_b"]');await settled();
  assert.deepEqual(h.calls.find(item=>item.path==='/api/skills/assign').options.body,{skillId:'local-workflow',botId:'bot_b',enabled:true});
  assert.deepEqual([...h.data.bots[1].skills],['existing','local-workflow']);assert.deepEqual(h.data.bots[0].skills,[]);
  h.click('[data-skills-field="assignment"][data-bot-id="bot_b"]');await settled();assert.equal(h.calls.filter(item=>item.path==='/api/skills/assign').at(-1).options.body.enabled,false);assert.deepEqual([...h.data.bots[1].skills],['existing']);
});

test('folder import preserves relative resource bytes and reviews the exact server instruction text',async t=>{
  const instruction='---\nname: portable\ndescription: A portable workflow\n---\n<img src=x onerror=alert(1)>',h=harness(t,{api:async path=>path==='/api/skills/import/preview'?{importId:'import_folder',packages:[{key:'',skill:{name:'portable',description:'A portable workflow'},content:instruction,files:['SKILL.md','assets/sample.bin'],compatibility:{status:'ready',reasons:[]}}]}:undefined});await settled();h.click('[data-skills-action="import"]');
  const form=h.document.querySelector('#skills-import-form'),input=form.querySelector('[name="folder"]'),files=[new h.window.File([instruction],'SKILL.md'),new h.window.File([new Uint8Array([0,255,13])],'sample.bin')];
  Object.defineProperty(files[0],'webkitRelativePath',{value:'portable/SKILL.md'});Object.defineProperty(files[1],'webkitRelativePath',{value:'portable/assets/sample.bin'});Object.defineProperty(input,'files',{value:files});input.dispatchEvent(new h.window.Event('change',{bubbles:true}));form.dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));
  for(let i=0;i<20&&!h.calls.some(item=>item.path==='/api/skills/import/preview');i++)await new Promise(resolve=>setTimeout(resolve,10));await settled();
  const body=h.calls.find(item=>item.path==='/api/skills/import/preview').options.body;assert.equal(body.botId,'bot_b');assert.equal(body.files.length,2);assert.equal(body.files[0].path,'SKILL.md');assert.equal(body.files[1].path,'assets/sample.bin');assert.equal(body.files[1].contentBase64,'AP8N');
  const dialog=h.document.querySelector('dialog');assert.equal(dialog.querySelector('pre').textContent,instruction);assert.equal(dialog.querySelector('img'),null);assert.match(dialog.textContent,/assets\/sample.bin/);
});

test('a standalone SKILL.md follows the same preview and selected-bot installation flow',async t=>{
  const h=harness(t,{api:async path=>path==='/api/skills/import/preview'?{importId:'import_document',packages:[{key:'',skill:{name:'standalone'},content:'Instructions',files:['SKILL.md'],compatibility:{status:'ready',reasons:[]}}]}:undefined});await settled();h.click('[data-skills-action="import"]');
  const form=h.document.querySelector('#skills-import-form'),input=form.querySelector('[name="document"]');Object.defineProperty(input,'files',{value:[new h.window.File(['Instructions'],'SKILL.md')]});input.dispatchEvent(new h.window.Event('change',{bubbles:true}));form.dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));
  for(let i=0;i<20&&!h.calls.some(item=>item.path==='/api/skills/import/preview');i++)await new Promise(resolve=>setTimeout(resolve,10));await settled();assert.deepEqual(h.calls.find(item=>item.path==='/api/skills/import/preview').options.body,{files:[{path:'SKILL.md',contentBase64:'SW5zdHJ1Y3Rpb25z'}],botId:'bot_b'});assert.equal(h.calls.some(item=>item.path==='/api/skills'),false);
});

test('import errors scroll fully into view and installed cards show catalog version metadata',async t=>{
  const h=harness(t,{installed:[{id:'catalog-revision',name:'Research brief',catalogVersion:'1.0.0',compatibility:{status:'ready',reasons:[]}}],api:async path=>{if(path==='/api/skills/import/preview')throw new Error('Private network addresses are blocked.');}});await settled();
  h.click('[data-tab="installed"]');assert.match(h.root.querySelector('.skills-card-source').textContent,/v1\.0\.0/);h.click('[data-skills-action="import"]');
  const form=h.document.querySelector('#skills-import-form'),error=form.querySelector('.form-error');let scroll;error.scrollIntoView=options=>scroll=options;form.querySelector('[name="url"]').value='https://127.0.0.1/SKILL.md';form.dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));await settled();assert.match(error.textContent,/addresses are blocked/);assert.equal(scroll.block,'center');assert.equal(scroll.inline,'nearest');
});

test('Download package JSON reimports through preview without changing binary resource bytes',async t=>{
  const exported={files:[{path:'SKILL.md',contentBase64:Buffer.from('---\nname: roundtrip\ndescription: A roundtrip\n---\nOriginal instructions').toString('base64')},{path:'assets/sample.bin',contentBase64:Buffer.from([0,255,13,128]).toString('base64')}]};
  const h=harness(t,{api:async path=>path==='/api/skills/import/preview'?{importId:'import_roundtrip',packages:[{key:'',skill:{name:'roundtrip'},content:'Original instructions',files:exported.files.map(file=>file.path),compatibility:{status:'ready',reasons:[]}}]}:path==='/api/skills/import'?{skill:{id:'roundtrip'}}:undefined});await settled();h.click('[data-skills-action="import"]');
  const form=h.document.querySelector('#skills-import-form'),input=form.querySelector('[name="document"]');assert.match(input.accept,/\.skill\.json/);Object.defineProperty(input,'files',{value:[new h.window.File([JSON.stringify(exported)],'roundtrip.skill.json',{type:'application/json'})]});form.dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));
  for(let i=0;i<20&&!h.calls.some(item=>item.path==='/api/skills/import/preview');i++)await new Promise(resolve=>setTimeout(resolve,10));await settled();assert.deepEqual(h.calls.find(item=>item.path==='/api/skills/import/preview').options.body,{...exported,botId:'bot_b'});h.click('[data-skills-action="import-install"]');await settled();assert.deepEqual(h.calls.find(item=>item.path==='/api/skills/import').options.body,{importId:'import_roundtrip',key:'',botId:'bot_b'});
});

test('arbitrary JSON documents are refused before import preview dispatch',async t=>{
  const h=harness(t);await settled();h.click('[data-skills-action="import"]');const form=h.document.querySelector('#skills-import-form'),input=form.querySelector('[name="document"]');Object.defineProperty(input,'files',{value:[new h.window.File(['{"settings":{"tools":"all"}}'],'unrelated.json',{type:'application/json'})]});form.dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));
  for(let i=0;i<20&&!form.querySelector('.form-error').textContent;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.match(form.querySelector('.form-error').textContent,/portable \.skill\.json export/);assert.equal(h.calls.some(item=>item.path==='/api/skills/import/preview'),false);
});

const adapted={...entry,catalogId:'tupies-figma-bro',name:'figma-bro',title:'Figma Bro',attribution:{title:'figma bro',author:'John Bai',url:'https://x.ai/bot/marketplace/bots/figma-bro',kind:'public-profile-adaptation',reviewedAt:'2026-10-29'},capabilityNotes:['Works from supplied design exports. A Figma connection is optional and is not installed with this skill.','Screenshots require a model that can see images; unavailable values stay unknown.']};

test('adapted ready skills show source authors and optional access limits without changing exact installation',async t=>{
  const h=harness(t,{initialTab:'catalog',entries:[adapted],api:async path=>path==='/api/skills/inspect'?{...adapted,content:'New Tupies workflow',files:['SKILL.md']}:undefined});await settled();
  assert.match(h.root.querySelector('.skills-card-source').textContent,/Adapted for Tupies · John Bai/);assert.equal(h.root.querySelector('[data-skills-action="install"]').disabled,false);
  h.click('[data-skills-action="inspect"]');await settled();const dialog=h.document.querySelector('dialog'),origin=dialog.querySelector('.skills-attribution');
  assert.match(origin.textContent,/public figma bro profile by John Bai/);assert.match(origin.textContent,/newly written Tupies workflow/);assert.match(origin.textContent,/private original playbooks and service connections are not included/);
  const link=origin.querySelector('a');assert.equal(link.href,adapted.attribution.url);assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');
  assert.match(dialog.querySelector('.skills-capability-notes').textContent,/Figma connection is optional/);assert.match(dialog.querySelector('.skills-compat-ready').textContent,/Ready to use/);assert.equal(dialog.querySelector('[data-skills-action="install"]').disabled,false);
  h.click('dialog [data-skills-action="install"]');await settled();assert.deepEqual(h.calls.find(item=>item.path==='/api/skills/install').options.body,{catalogId:adapted.catalogId,version:adapted.version,digest:adapted.digest,botId:'bot_b'});
});

test('installed detail metadata works without a store context and never links hostile source URLs or renders source HTML',t=>{
  const h=harness(t);h.window.StudioSkills.reset();
  const badUrls=['javascript:alert(1)','http://x.ai/bot/marketplace/bots/figma-bro','https://x.ai.evil.test/bot/marketplace/bots/figma-bro','https://name:secret@x.ai/bot/marketplace/bots/figma-bro','https://x.ai:8443/bot/marketplace/bots/figma-bro','https://x.ai/bot/marketplace/bots/figma-bro?token=secret','https://x.ai/bot/marketplace/bots/figma-bro#fragment','https://x.ai/bot/marketplace/bots/figma-bro/extra','https://x.ai/bot/marketplace/bots/%3Cimg%3E'];
  for(const url of badUrls){
    const hostile={...adapted,attribution:{...adapted.attribution,url,title:'<svg onload=alert(1)>',author:'<img src=x onerror=alert(1)>',reviewedAt:'<script>bad()</script>'},capabilityNotes:['<iframe src=x>','Use supplied exports only.']},holder=h.document.createElement('div');
    holder.innerHTML=h.window.StudioSkills.metadata(hostile,{esc});assert.equal(holder.querySelector('a'),null,url);assert.equal(holder.querySelector('svg,img,script,iframe,[onload],[onerror]'),null,url);assert.ok(holder.textContent.includes(hostile.attribution.author));assert.ok(holder.textContent.includes(hostile.attribution.title));assert.match(holder.textContent,/<iframe src=x>/);
  }
  const holder=h.document.createElement('div');holder.innerHTML=h.window.StudioSkills.metadata(adapted,{esc});assert.equal(holder.querySelector('a').href,adapted.attribution.url);assert.equal(h.window.StudioSkills.metadata(null,{esc}),'');
});

test('original catalog entries stay unlabelled while installed adaptations retain their source credit',async t=>{
  const installed=[{...adapted,id:'installed-figma',catalogVersion:'1.0.0'}],h=harness(t,{initialTab:'catalog',installed});await settled();
  assert.doesNotMatch(h.root.querySelector('.skills-card-source').textContent,/Adapted/);assert.match(h.root.querySelector('.skills-card-source').textContent,/Tupies/);
  h.click('[data-skills-action="inspect"]');await settled();assert.equal(h.document.querySelector('.skills-attribution'),null);assert.equal(h.document.querySelector('.skills-capability-notes'),null);assert.equal(h.document.querySelector('dialog [data-skills-action="install"]').disabled,false);h.ctx.closeDialog();
  h.click('[data-tab="installed"]');assert.match(h.root.querySelector('.skills-card-source').textContent,/Adapted for Tupies · John Bai/);h.click('[data-skills-action="local"]');assert.equal(h.calls.find(item=>item.local).local,'installed-figma');
});

const localSkill={id:'local-workflow',name:'Workflow',description:'An installed workflow',available:true,compatibility:{status:'ready',reasons:[]}};
const assignments=h=>h.calls.filter(item=>item.path==='/api/skills/assign');

test('Skills opens the installed library and scopes it by bot or unassigned status',async t=>{
  const h=harness(t,{installed:[localSkill,{...localSkill,id:'unused-workflow',name:'Unassigned workflow'}]});h.data.bots[1].skills=[localSkill.id];await settled();
  assert.equal(h.root.querySelector('[data-tab="installed"]').getAttribute('aria-pressed'),'true');assert.equal(h.root.querySelectorAll('.skills-installed-row').length,2);assert.equal(h.root.querySelector('#skills-policy'),null);assert.equal(h.root.querySelector('[data-skills-action="install"]'),null);
  const scope=h.root.querySelector('#skills-scope');scope.value='selected';scope.dispatchEvent(new h.window.Event('change',{bubbles:true}));assert.equal(h.root.querySelectorAll('.skills-installed-row').length,1);assert.match(h.root.querySelector('.skills-installed-row').textContent,/Assigned to Nova/);
  const unassigned=h.root.querySelector('#skills-scope');unassigned.value='unassigned';unassigned.dispatchEvent(new h.window.Event('change',{bubbles:true}));assert.equal(h.root.querySelectorAll('.skills-installed-row').length,1);assert.match(h.root.querySelector('.skills-installed-row').textContent,/Unassigned workflow/);
});

test('opening and closing assignment management sends no changes',async t=>{
  const h=harness(t,{installed:[localSkill]});h.data.bots[0].skills=[localSkill.id];await settled();h.click('[data-skills-action="manage"]');
  const dialog=h.document.querySelector('dialog');assert.equal(dialog.querySelectorAll('[data-skills-field="assignment"]').length,2);assert.equal(dialog.querySelector('[data-bot-id="bot_a"]').checked,true);assert.equal(dialog.querySelector('[data-bot-id="bot_b"]').checked,false);assert.match(dialog.textContent,/Changes save immediately/);assert.equal(assignments(h).length,0);
  h.click('dialog [data-action="close-dialog"]');assert.equal(h.document.querySelector('dialog'),null);assert.equal(assignments(h).length,0);
});

test('assignment management targets each chosen bot without replacing unrelated skills',async t=>{
  const h=harness(t,{installed:[localSkill]});h.data.bots[0].skills=['atlas-private'];h.data.bots[1].skills=['nova-private'];await settled();h.click('[data-skills-action="manage"]');
  h.click('[data-skills-field="assignment"][data-bot-id="bot_a"]');await settled();assert.deepEqual(assignments(h)[0].options.body,{skillId:localSkill.id,botId:'bot_a',enabled:true});assert.deepEqual([...h.data.bots[0].skills],['atlas-private',localSkill.id]);assert.deepEqual([...h.data.bots[1].skills],['nova-private']);
  h.click('[data-skills-field="assignment"][data-bot-id="bot_b"]');await settled();assert.deepEqual(assignments(h)[1].options.body,{skillId:localSkill.id,botId:'bot_b',enabled:true});assert.deepEqual([...h.data.bots[0].skills],['atlas-private',localSkill.id]);assert.deepEqual([...h.data.bots[1].skills],['nova-private',localSkill.id]);assert.match(h.document.querySelector('[data-skills-assignment-status]').textContent,/Assigned to Nova/);
});

test('assignment saves preserve keyboard focus without stealing focus after the owner moves on',async t=>{
  const pending=[],h=harness(t,{installed:[localSkill],api:async path=>path==='/api/skills/assign'?new Promise(resolve=>pending.push(resolve)):undefined});await settled();h.click('[data-skills-action="manage"]');
  const original=h.document.querySelector('[data-skills-field="assignment"][data-bot-id="bot_a"]');original.focus();original.click();assert.equal(pending.length,1);pending.shift()({replacedSkillIds:[]});await settled();
  const replacement=h.document.querySelector('[data-skills-field="assignment"][data-bot-id="bot_a"]');assert.notEqual(replacement,original);assert.equal(h.document.activeElement,replacement);assert.equal(replacement.checked,true);
  replacement.click();assert.equal(pending.length,1);const done=h.document.querySelector('dialog [data-action="close-dialog"]');done.focus();pending.shift()({replacedSkillIds:[]});await settled();assert.equal(h.document.activeElement,done);assert.equal(h.document.querySelector('[data-skills-field="assignment"][data-bot-id="bot_a"]').checked,false);
});

test('a failed later assignment preserves saved bots and restores the failed checkbox',async t=>{
  const h=harness(t,{installed:[localSkill],api:async(path,options)=>{if(path==='/api/skills/assign'&&options.body.botId==='bot_b')throw new Error('This bot is working.');}});await settled();h.click('[data-skills-action="manage"]');h.click('[data-skills-field="assignment"][data-bot-id="bot_a"]');await settled();
  h.click('[data-skills-field="assignment"][data-bot-id="bot_b"]');await settled();const status=h.document.querySelector('[data-skills-assignment-status]');assert.match(status.textContent,/This bot is working/);assert.doesNotMatch(status.textContent,/Assigned to Nova/);assert.equal(status.classList.contains('form-error'),true);assert.equal(h.document.querySelector('[data-bot-id="bot_a"]').checked,true);assert.equal(h.document.querySelector('[data-bot-id="bot_b"]').checked,false);assert.deepEqual([...h.data.bots[0].skills],[localSkill.id]);assert.deepEqual([...h.data.bots[1].skills],[]);assert.equal(assignments(h).length,2);
});

test('a saved assignment remains visible when refreshing its library fails',async t=>{
  const h=harness(t,{installed:[localSkill]});await settled();h.click('[data-skills-action="manage"]');h.ctx.refresh=async()=>{throw new Error('Engine connection lost.');};h.click('[data-skills-field="assignment"][data-bot-id="bot_a"]');await settled();
  assert.match(h.document.querySelector('[data-skills-assignment-status]').textContent,/Assignment saved\. Could not refresh the library: Engine connection lost/);assert.equal(h.document.querySelector('[data-bot-id="bot_a"]').checked,true);assert.deepEqual([...h.data.bots[0].skills],[localSkill.id]);assert.equal(assignments(h).length,1);
});

test('assigning an installed catalog revision switches only its chosen bot',async t=>{
  const previous={...localSkill,id:'catalog-old',catalogId:entry.catalogId,catalogVersion:'1.0.0'},next={...previous,id:'catalog-new',catalogVersion:'2.0.0'},h=harness(t,{installed:[previous,next],api:async(path,options)=>path==='/api/skills/assign'?{replacedSkillIds:options.body.enabled?[previous.id]:[]}:undefined});h.data.bots[0].skills=[previous.id,'atlas-private'];h.data.bots[1].skills=[previous.id];await settled();h.click(`[data-skills-action="manage"][data-id="${next.id}"]`);assert.match(h.document.querySelector('dialog').textContent,/Using v1\.0\.0 · assigning switches this bot/);
  h.click('[data-skills-field="assignment"][data-bot-id="bot_a"]');await settled();assert.deepEqual(assignments(h)[0].options.body,{skillId:next.id,botId:'bot_a',enabled:true});assert.deepEqual([...h.data.bots[0].skills],['atlas-private',next.id]);assert.deepEqual([...h.data.bots[1].skills],[previous.id]);assert.equal(h.data.skills.length,2);
});

test('unavailable package files prevent new assignments while allowing existing assignments to be removed',async t=>{
  const h=harness(t,{installed:[{...localSkill,available:false,compatibility:{status:'needs_setup',reasons:['Wait for sync.']}}]});h.data.bots[0].skills=[localSkill.id];await settled();h.click('[data-skills-action="manage"]');
  assert.equal(h.document.querySelector('[data-bot-id="bot_a"]').disabled,false);assert.equal(h.document.querySelector('[data-bot-id="bot_b"]').disabled,true);assert.equal(h.document.querySelector('dialog [data-skills-action="local"]').disabled,true);assert.match(h.document.querySelector('dialog').textContent,/Existing assignments can still be removed/);
  h.click('[data-skills-field="assignment"][data-bot-id="bot_a"]');await settled();assert.deepEqual(assignments(h)[0].options.body,{skillId:localSkill.id,botId:'bot_a',enabled:false});assert.deepEqual([...h.data.bots[0].skills],[]);assert.equal(h.document.querySelector('[data-bot-id="bot_a"]').disabled,true);assert.equal(h.document.querySelector('[data-bot-id="bot_b"]').disabled,true);
});

test('removing an installed skill opens the existing confirmation instead of deleting immediately',async t=>{
  const h=harness(t,{installed:[localSkill]});await settled();h.click('[data-skills-action="manage"]');h.click('[data-skills-action="remove"]');assert.deepEqual(h.calls.find(item=>item.confirmDelete).confirmDelete,{kind:'skill',id:localSkill.id});assert.equal(h.calls.some(item=>item.options?.method==='DELETE'),false);
});

test('failed installation preference restores the saved policy and displays its error',async t=>{
  const h=harness(t,{initialTab:'preferences',api:async path=>{if(path==='/api/bots/bot_b')throw new Error('Wait for this bot to finish.');}});await settled();const policy=h.document.querySelector('#skills-policy');policy.value='trusted';policy.dispatchEvent(new h.window.Event('change',{bubbles:true}));await settled();
  assert.equal(policy.value,'ask');assert.equal(policy.disabled,false);assert.equal(h.data.bots[1].skillInstallPolicy,'ask');assert.match(h.document.querySelector('[data-skills-policy-error]').textContent,/Wait for this bot to finish/);assert.equal(h.toasts.length,0);
});

test('a late assignment response cannot change state or restore the skill manager after sign-out',async t=>{
  let resolve;const pending=new Promise(done=>resolve=done),h=harness(t,{installed:[localSkill],api:async path=>path==='/api/skills/assign'?pending:undefined});await settled();h.click('[data-skills-action="manage"]');h.click('[data-skills-field="assignment"][data-bot-id="bot_a"]');assert.equal(assignments(h).length,1);
  h.window.StudioSkills.reset();h.ctx.closeDialog();h.root.innerHTML='<p>Signed out</p>';resolve({replacedSkillIds:[]});await settled();assert.equal(h.root.textContent,'Signed out');assert.equal(h.document.querySelector('dialog'),null);assert.deepEqual(h.data.bots[0].skills,[]);assert.equal(h.toasts.length,0);
});
