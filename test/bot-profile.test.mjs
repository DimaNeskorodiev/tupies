import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { createStudioServer } from '../server.mjs';

const SECRET='profile-fixture-provider-key-never-shown';
const settled=async(rounds=4)=>{for(let i=0;i<rounds;i++)await new Promise(resolve=>setImmediate(resolve));};

async function studio(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-profile-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,requestTimeout:2000,runTimeout:5000});
  const {url}=await app.listen(0);let cookie='',csrf='';
  async function request(route,{method='GET',data,signedIn=true}={}){
    const response=await fetch(`${url}${route}`,{method,headers:{...(signedIn&&cookie?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...(signedIn&&csrf?{'X-CSRF-Token':csrf}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});
    const text=await response.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:response.status,body,text,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const setup=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'fixture-workspace-password'}});
  assert.equal(setup.status,201);cookie=setup.cookie;csrf=setup.body.csrf;
  t.after(async()=>{delete app.store.state.runs.bot_atlas;await app.close();await fs.rm(directory,{recursive:true,force:true});});
  return {app,directory,request,brain:path.join(directory,'workspaces','bot_atlas','brain')};
}
async function note(brain,relative,content){const file=path.join(brain,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);}
async function vault(brain){
  await note(brain,'projects/acme.md','---\ntitle: Acme launch\ntype: project\ntags: ["project/acme"]\ncreated: 2026-10-01T10:00:00Z\n---\n# Acme launch\n\nShip it with [[Ada Lovelace]] and [[Missing note]]. #launch\n\n```\n[[not-a-link]]\n```\n');
  await note(brain,'people/Ada Lovelace.md','---\naliases: [Ada]\n---\nAda leads analytics for [[acme]].\n');
  await note(brain,'daily/2026-10-26.md','- Met [[Ada]] about the launch\n');
  await note(brain,'.obsidian/workspace.md','Hidden settings [[acme]]\n');
  await note(brain,'readme.txt','Not a note.\n');
}

test('the notes overview is read-only, bounded and resolves links and backlinks like Obsidian',async t=>{
  const f=await studio(t);
  assert.equal((await f.request('/api/bots/bot_atlas/brain',{signedIn:false})).status,401);
  assert.equal((await f.request('/api/bots/bot_missing/brain')).status,404);
  const first=await f.request('/api/bots/bot_atlas/brain');
  assert.equal(first.status,200);
  assert.deepEqual([first.body.notes,first.body.total,first.body.tags,first.body.unresolved,first.body.truncated],[[],0,[],0,false]);
  await assert.rejects(fs.access(f.brain),{code:'ENOENT'});
  await vault(f.brain);
  const {body}=await f.request('/api/bots/bot_atlas/brain');
  assert.equal(body.total,3);assert.equal(body.limits.notes,2000);
  assert.deepEqual(body.notes.map(item=>item.path).sort(),['daily/2026-10-26.md','people/Ada Lovelace.md','projects/acme.md']);
  const acme=body.notes.find(item=>item.path==='projects/acme.md'),ada=body.notes.find(item=>item.path==='people/Ada Lovelace.md');
  assert.deepEqual({title:acme.title,folder:acme.folder,type:acme.type,tags:acme.tags,links:acme.links,backlinks:acme.backlinks},{title:'Acme launch',folder:'projects',type:'project',tags:['project/acme','launch'],links:['people/Ada Lovelace.md'],backlinks:1});
  assert.equal(ada.backlinks,2);assert.ok(acme.size>0);assert.match(acme.updated,/^\d{4}-\d\d-\d\dT/);
  assert.equal(body.unresolved,1);
  assert.deepEqual(body.tags,[{tag:'launch',notes:1},{tag:'project/acme',notes:1}]);
  // External edits (for example in Obsidian) appear on the next request.
  await note(f.brain,'daily/2026-10-26.md','- Met [[Ada]] about the launch\n- Reviewed [[projects/acme]] and [[Another missing]]\n');
  const updated=(await f.request('/api/bots/bot_atlas/brain')).body;
  assert.deepEqual(updated.notes.find(item=>item.path==='daily/2026-10-26.md').links.sort(),['people/Ada Lovelace.md','projects/acme.md']);
  assert.equal(updated.unresolved,2);
});

test('a note reads by path, link name or alias and refuses hidden, escaping and linked paths',async t=>{
  const f=await studio(t);await vault(f.brain);
  const read=await f.request('/api/bots/bot_atlas/brain/note?path=projects/acme');
  assert.equal(read.status,200);
  assert.equal(read.body.path,'projects/acme.md');assert.equal(read.body.workspacePath,'brain/projects/acme.md');
  assert.equal(read.body.title,'Acme launch');assert.equal(read.body.type,'project');assert.equal(read.body.created,'2026-10-01T10:00:00Z');
  assert.match(read.body.content,/^# Acme launch\n/);assert.doesNotMatch(read.body.content,/^---/);assert.equal(read.body.truncated,false);
  assert.deepEqual(read.body.links,[{target:'Ada Lovelace',path:'people/Ada Lovelace.md'},{target:'Missing note',path:null}]);
  assert.deepEqual(read.body.backlinks,['people/Ada Lovelace.md']);
  for(const target of ['Ada','[[Ada Lovelace]]','people/Ada Lovelace.md','/people/Ada Lovelace']) {
    const resolved=await f.request(`/api/bots/bot_atlas/brain/note?path=${encodeURIComponent(target)}`);
    assert.equal(resolved.body.path,'people/Ada Lovelace.md',target);assert.deepEqual(resolved.body.backlinks.sort(),['daily/2026-10-26.md','projects/acme.md']);
  }
  await fs.writeFile(path.join(f.directory,'outside.md'),'Outside the notes folder.');
  await fs.symlink(path.join(f.directory,'outside.md'),path.join(f.brain,'linked.md'));
  await fs.symlink(path.join(f.directory,'workspaces'),path.join(f.brain,'escape'));
  assert.ok(!(await f.request('/api/bots/bot_atlas/brain')).body.notes.some(item=>/linked|escape|obsidian/.test(item.path)));
  for(const target of ['../../state.json','../outside','.obsidian/workspace','projects/../../../state.json','projects/./acme','people/.hidden','linked','escape/bot_atlas/brain/projects/acme','a\\b',''])
    assert.equal((await f.request(`/api/bots/bot_atlas/brain/note?path=${encodeURIComponent(target)}`)).status,400,target);
  assert.equal((await f.request('/api/bots/bot_atlas/brain/note')).status,400);
  assert.equal((await f.request('/api/bots/bot_atlas/brain/note?path=nowhere')).status,404);
  assert.equal((await f.request('/api/bots/bot_atlas/brain/note?path=readme')).status,404);
});

test('note text is redacted and notes stay readable while the bot is busy',async t=>{
  const f=await studio(t);
  const provider=await f.request('/api/connections',{method:'POST',data:{name:'Fixture provider',type:'openai',baseUrl:'http://127.0.0.1:9/v1',apiKey:SECRET,defaultModel:'fixture-model'}});
  assert.equal(provider.status,201);
  await note(f.brain,`projects/${'keys'}.md`,`---\ntitle: Key ${SECRET}\n---\nThe key is ${SECRET} and [[acme]].\n`);
  await vault(f.brain);
  const read=await f.request('/api/bots/bot_atlas/brain/note?path=projects/keys');
  assert.equal(read.status,200);assert.ok(!read.text.includes(SECRET));
  assert.match(read.body.content,/The key is \[redacted\]/);assert.equal(read.body.title,'Key [redacted]');
  assert.ok(!(await f.request('/api/bots/bot_atlas/brain')).text.includes(SECRET));
  f.app.store.state.runs.bot_atlas={id:'run_busy_fixture',status:'running',botId:'bot_atlas',updatedAt:new Date().toISOString(),events:[]};
  assert.equal((await f.request('/api/bots/bot_atlas/brain')).status,200);
  assert.equal((await f.request('/api/bots/bot_atlas/brain/note?path=Ada')).status,200);
  const blocked=await f.request('/api/bots/bot_atlas/memory',{method:'PUT',data:{key:'Tone',value:'Warm'}});
  assert.equal(blocked.status,409);assert.match(blocked.body.error,/Wait for this bot/);
  delete f.app.store.state.runs.bot_atlas;
});

const profileSource=await readFile(new URL('../public/bot-profile.js',import.meta.url),'utf8');
const richSource=await readFile(new URL('../public/vendor/rich-content.js',import.meta.url),'utf8');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time='2026-10-27T10:00:00.000Z';
const overview={folder:'brain',total:3,indexed:3,skipped:0,truncated:false,linksTruncated:false,unresolved:1,limits:{notes:2000},tags:[{tag:'launch',notes:1},{tag:'project/acme',notes:1}],notes:[
  {path:'daily/2026-10-26.md',title:'2026-10-26',folder:'daily',tags:[],updated:time,size:40,links:['people/Ada Lovelace.md'],backlinks:0},
  {path:'people/Ada Lovelace.md',title:'Ada Lovelace',folder:'people',tags:[],updated:time,size:40,links:['projects/acme.md'],backlinks:2},
  {path:'projects/acme.md',title:'Acme <img src=x onerror=alert(1)>',folder:'projects',tags:['project/acme','launch'],type:'project',updated:time,size:90,links:['people/Ada Lovelace.md'],backlinks:1},
]};
const acmeNote={path:'projects/acme.md',workspacePath:'brain/projects/acme.md',title:'Acme <img src=x onerror=alert(1)>',folder:'projects',type:'project',tags:['project/acme','launch'],aliases:[],created:'2026-10-01T10:00:00Z',updated:time,size:90,content:'Ship it with [[Ada Lovelace|Ada]] and [[Missing note]]. #launch <script>window.hacked=1</script>\n\n`[[code]]`',truncated:false,links:[{target:'Ada Lovelace',path:'people/Ada Lovelace.md'},{target:'Missing note',path:null}],backlinks:['people/Ada Lovelace.md'],indexed:true};
const adaNote={...acmeNote,path:'people/Ada Lovelace.md',workspacePath:'brain/people/Ada Lovelace.md',title:'Ada Lovelace',folder:'people',type:undefined,tags:[],content:'Leads [[acme]].',links:[{target:'acme',path:'projects/acme.md'}],backlinks:['daily/2026-10-26.md','projects/acme.md']};

function ui(t,{hash='#/bots/bot_atlas',tools,rich=false,brain=overview,workspace=null,scripts=[]}={}){
  const dom=new JSDOM('<!doctype html><main id="main-content"></main><div id="dialog-root"></div>',{url:`http://studio.local/${hash}`,runScripts:'outside-only'});
  const win=dom.window,doc=win.document,context=dom.getInternalVMContext(),requests=[],toasts=[],calls=[],state={memoryStatus:200};
  if(rich)vm.runInContext(richSource,context,{filename:'rich-content.js'});
  else win.StudioRich={render:text=>`<p>${escape(text).replace(/`([^`]+)`/g,'<code>$1</code>')}</p>`,hydrate:async()=>{}};
  vm.runInContext(profileSource,context,{filename:'bot-profile.js'});
  const runs=[{id:'run_2',status:'completed',source:'chat',lane:'chat',task:'Draft the <launch> brief',finishedAt:time,durationMs:95_000,usage:{input_tokens:1200,output_tokens:300},questions:1},{id:'run_1',status:'failed',source:'routine',lane:'routine',task:'Morning digest',finishedAt:time,durationMs:4000,usage:{},error:'The model provider is <unavailable>.'}];
  const memory=[{id:'memory_tone',key:'Tone',value:'Plain and warm.',updatedAt:'2026-10-27T09:00:00.000Z'},{id:'memory_client',key:'Client',value:'Acme, see [[projects/acme]].',pinned:true,updatedAt:'2026-10-20T09:00:00.000Z'}];
  const data={bots:[{id:'bot_atlas',name:'Atlas',title:'Chief of staff',description:'Plans & <priorities>.',connectionId:'provider',tools:tools??['workspace','memory','delegation'],approvalPolicy:'strict',skills:['skill_brief'],collaborators:['bot_nova'],enabled:true},{id:'bot_nova',name:'Nova',title:'Research',connectionId:'provider'}],
    connections:[{id:'provider',type:'openai',name:'Fixture provider',status:'connected',defaultModel:'fixture-model'}],skills:[{id:'skill_brief',name:'Briefing'}],integrations:[],rooms:[{id:'room_launch',name:'Launch room',botIds:['bot_atlas','bot_nova']}],
    routines:[{id:'routine_daily',name:'Morning digest',botId:'bot_atlas',intervalMinutes:1440,enabled:true}],runs:{bot_atlas:{id:'run_1',status:'completed',updatedAt:time}},
    activity:[{id:'event_1',type:'memory.updated',title:'Atlas memory updated',botId:'bot_atlas',createdAt:time},{id:'event_2',type:'run.started',title:'Nova received a task',botId:'bot_nova',createdAt:time}]};
  const api=async(route,options={})=>{
    requests.push(JSON.parse(JSON.stringify({path:route,method:options.method||'GET',body:options.body})));
    const url=new URL(route,'http://studio.local');
    if(route==='/api/bots/bot_atlas/memory'&&options.method==='PUT'){if(state.memoryStatus!==200)throw Object.assign(new Error('Wait for this bot and its team task before changing its workspace.'),{status:state.memoryStatus});const entry={...memory.find(item=>item.key===options.body.key),...options.body,id:memory.find(item=>item.key===options.body.key)?.id||'memory_new',updatedAt:time};if(!entry.pinned)delete entry.pinned;return entry;}
    if(route.startsWith('/api/bots/bot_atlas/memory/')&&options.method==='DELETE')return {deleted:true};
    if(route==='/api/bots/bot_atlas/memory')return {entries:structuredClone(memory)};
    if(route==='/api/bots/bot_atlas/runs')return {data:structuredClone(runs)};
    if(route==='/api/bots/bot_atlas/proposals')return {proposals:structuredClone(state.proposals||[]),pending:(state.proposals||[]).filter(item=>item.status==='pending').length};
    if(url.pathname.startsWith('/api/bots/bot_atlas/proposals/')&&options.method==='POST'){if(state.decideError)throw state.decideError;const [,,,,,proposalId,decision]=url.pathname.split('/');const item=state.proposals.find(entry=>entry.id===proposalId);Object.assign(item,{status:{accept:'accepted',reject:'rejected',undo:'undone'}[decision],decidedAt:time,undoable:decision==='accept'});return {proposal:structuredClone(item)};}
    if(route==='/api/bots/bot_atlas/brain')return structuredClone(brain);
    if(route==='/api/bots/bot_atlas/workspace'){
      if(!workspace)throw Object.assign(new Error('Workspace categories unavailable.'),{status:404});
      if(options.method==='POST'){if(state.workspaceStatus===409)throw Object.assign(new Error('Wait for this bot and its team task before changing its workspace.'),{status:409});workspace={...workspace,folders:workspace.folders.map(folder=>({...folder,status:folder.status==='missing'?'ready':folder.status}))};}
      return structuredClone(workspace);
    }
    if(route==='/api/bots/bot_atlas/workshop')return structuredClone(state.workshop||{tools:[],catalog:[],items:[]});
    if(route.startsWith('/api/bots/bot_atlas/improvements/'))return options.method==='POST'?{format:'tupies-contribution-v1',...state.improvement}:structuredClone(state.improvement);
    if(route==='/api/bots/bot_atlas/scripts')return {scripts:structuredClone(state.scripts||scripts),truncated:Boolean(state.scriptsTruncated)};
    if(url.pathname.startsWith('/api/bots/bot_atlas/scripts/')){if(state.scriptError)throw new Error(state.scriptError);const found=(state.scripts||scripts).find(script=>script.id===decodeURIComponent(url.pathname.split('/').at(-1)));if(!found)throw new Error('Script not found.');return structuredClone(found);}
    if(url.pathname==='/api/bots/bot_atlas/brain/note'){const target=url.searchParams.get('path');if(['projects/acme.md','projects/acme'].includes(target))return structuredClone(acmeNote);if(['people/Ada Lovelace.md','Ada'].includes(target))return structuredClone(adaNote);throw Object.assign(new Error('Note not found.'),{status:404});}
    if(url.pathname==='/api/bots/bot_atlas/files'){const folder=url.searchParams.get('path');if(state.fileLists&&Object.hasOwn(state.fileLists,folder))return {path:folder,files:structuredClone(state.fileLists[folder])};return folder?{path:folder,files:[{name:'file_0123456789abcdef01-brief.pdf',path:'uploads/file_0123456789abcdef01-brief.pdf',kind:'file',size:2048,updatedAt:time}]}:{path:'',files:[{name:'.studio-temp.tmp',path:'.studio-temp.tmp',kind:'file',size:1,updatedAt:time},{name:'brain',path:'brain',kind:'directory',updatedAt:time},{name:'uploads',path:'uploads',kind:'directory',updatedAt:time},{name:'report.pdf',path:'report.pdf',kind:'file',size:120000,updatedAt:time},{name:'notes.txt',path:'notes.txt',kind:'file',size:12,updatedAt:time},{name:'data.bin',path:'data.bin',kind:'file',size:3,updatedAt:time},{name:'loop',path:'loop',kind:'blocked-symlink',updatedAt:time}]};}
    throw new Error(`Unexpected request ${route}`);
  };
  const botById=id=>data.bots.find(bot=>bot.id===id);
  const ctx={data,api,esc:escape,icon:name=>`<svg data-icon="${name}"></svg>`,avatar:(bot,size)=>`<span class="avatar ${size}" data-avatar="${escape(bot.id)}"></span>`,botById,botStatus:()=>state.status||{text:'Ready',className:'ready'},statusPill:()=>'<span class="status-pill ready">Ready</span>',
    relative:()=>'2h ago',timeLabel:()=>'10:00',shortDate:()=>'Oct 1',toast:(message,error)=>toasts.push([message,Boolean(error)]),errorText:error=>error?.message||'Something went wrong.',openDialog(){},closeDialog(){},
    documentPreview:async(...args)=>{calls.push(['preview',...args]);},fileEditor:async(...args)=>{calls.push(['editor',...args]);},openBotDraft:(...args)=>calls.push(['draft',...args]),routineDialog:(...args)=>calls.push(['routine',...args]),previewFormats:/\.(?:pdf|docx|pptx|xlsx|csv|md|markdown|png|jpe?g|webp)$/i,navigate(){},route:()=>({view:'bots',id:'bot_atlas'})};
  const root=doc.querySelector('#main-content');
  const show=async()=>{root.innerHTML=win.StudioBotProfile.render(ctx,'bot_atlas');win.StudioBotProfile.mount(ctx,'bot_atlas',root);await settled();};
  const click=async element=>{assert.ok(element,'missing element');element.dispatchEvent(new win.MouseEvent('click',{bubbles:true,cancelable:true}));await settled();};
  t.after(()=>win.close());
  return {win,doc,ctx,data,requests,toasts,calls,state,root,show,click,$:selector=>doc.querySelector(selector),$$:selector=>[...doc.querySelectorAll(selector)],text:selector=>{const node=doc.querySelector(selector);if(!node)return undefined;const parts=[],walker=doc.createTreeWalker(node,4);while(walker.nextNode())parts.push(walker.currentNode.data);return parts.join(' ').replace(/\s+/g,' ').trim();}};
}

test('profile tab focus and horizontal position survive asynchronous data and shell renders',async t=>{
  const h=ui(t);await h.show();
  h.$('#bp-tab-overview').focus();
  h.$('#bp-tab-overview').dispatchEvent(new h.win.KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));
  await settled();
  assert.equal(h.doc.activeElement.id,'bp-tab-workshop');
  assert.equal(h.$('#bp-tab-workshop').getAttribute('aria-selected'),'true');
  assert.equal(h.$('#bp-panel').getAttribute('aria-labelledby'),'bp-tab-workshop');
  h.$('#bp-tabs').scrollLeft=240;
  await h.show();
  assert.equal(h.$('#bp-tabs').scrollLeft,240);
  assert.equal(h.doc.activeElement.id,'bp-tab-workshop');
  h.doc.activeElement.dispatchEvent(new h.win.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));
  await settled();
  assert.equal(h.doc.activeElement.id,'bp-tab-scripts');
  assert.equal(h.$('#bp-tab-scripts').getAttribute('tabindex'),'0');
  assert.equal(h.$('#bp-tab-workshop').getAttribute('tabindex'),'-1');
});

test('a deep-linked profile tab is revealed without scrolling the whole page',async t=>{
  const h=ui(t,{hash:'#/bots/bot_atlas/scripts'});
  const original=h.win.Element.prototype.getBoundingClientRect;
  h.win.Element.prototype.getBoundingClientRect=function(){
    if(this.id==='bp-tabs')return {left:16,right:374,width:358};
    if(this.id==='bp-tab-scripts')return {left:600,right:680,width:80};
    return original.call(this);
  };
  await h.show();
  assert.equal(h.$('#bp-tabs').scrollLeft,314);
  assert.equal(h.win.scrollY,0);
  // Browsing elsewhere along the rail is retained during a routine rerender.
  h.$('#bp-tabs').scrollLeft=80;await h.show();
  assert.equal(h.$('#bp-tabs').scrollLeft,80);
});

test('the phone connection map starts collapsed and preserves its disclosure across filters and renders',async t=>{
  const h=ui(t,{hash:'#/bots/bot_atlas/brain'});
  h.win.matchMedia=()=>({matches:true});
  await h.show();
  assert.equal(h.$('.bp-map').open,false);
  h.$('.bp-map').open=true;
  await h.show();
  assert.equal(h.$('.bp-map').open,true);
  h.$('.bp-map').open=false;
  const search=h.$('[data-profile-input=brain-query]');search.value='Ada';
  search.dispatchEvent(new h.win.Event('input',{bubbles:true}));await settled();
  assert.equal(h.$('.bp-map').open,false);
  assert.equal(h.$$('.bp-note-row').length,1);
});

test('the overview shows a calm summary and keeps cached counts across app re-renders',async t=>{
  const h=ui(t);await h.show();
  assert.equal(h.$('.bot-profile').dataset.profileBot,'bot_atlas');
  assert.equal(h.text('.bp-hero h1'),'Atlas');assert.equal(h.text('.bp-intro'),'Plans & <priorities>.');
  assert.ok(h.$('.bp-hero [data-nav="/bot/bot_atlas"]'));assert.equal(h.$('.bp-hero [data-action="edit-bot"]'),null);
  const settings=h.$('.bp-settings-disclosure');assert.equal(settings.open,false);
  assert.match(settings.querySelector('summary').textContent,/Configuration summary/);
  assert.ok(settings.querySelector('[data-profile-action="tab"][data-tab="settings"]'));
  assert.equal(settings.querySelector('[data-action="toggle-bot-hidden"]'),null);
  assert.deepEqual(h.$$('[role=tab]').map(tab=>[tab.dataset.tab,tab.getAttribute('aria-selected')]),[['overview','true'],['settings','false'],['brain','false'],['memory','false'],['learning','false'],['files','false'],['scripts','false'],['workshop','false']]);
  assert.deepEqual(h.requests.map(item=>item.path).sort(),['/api/bots/bot_atlas/brain','/api/bots/bot_atlas/files?path=','/api/bots/bot_atlas/memory','/api/bots/bot_atlas/proposals','/api/bots/bot_atlas/runs']);
  assert.deepEqual(h.$$('.bp-stat strong').map(node=>node.textContent),['2','3','6','2h ago']);
  assert.match(h.text('.bp-stats'),/1 pinned/);
  assert.match(h.text('.bp-overview'),/fixture-model Workspace default/);assert.match(h.text('.bp-overview'),/Strict Asks before every file change/);
  assert.doesNotMatch(h.text('.bp-primary-column'),/fixture-model|Strict Asks before every file change/);
  assert.deepEqual(h.$$('.bp-card .bp-chips')[0].textContent,'FilesMemoryBot collaboration');
  assert.ok(h.$('.bp-person[data-nav="/bots/bot_nova"]'));assert.ok(h.$('[data-nav="/room/room_launch"]'));
  assert.match(h.text('.bp-events'),/Memory updated/);assert.doesNotMatch(h.text('.bp-events'),/Atlas memory updated/);assert.doesNotMatch(h.text('.bp-events'),/Nova received/);
  assert.match(h.text('.bp-plain-list'),/Morning digest daily/);
  settings.open=true;
  settings.querySelector('summary').focus();
  const before=h.requests.length;await h.show();
  assert.equal(h.requests.length,before);assert.equal(h.$$('.bp-stat strong')[0].textContent,'2');
  assert.equal(h.$('.bp-settings-disclosure').open,true,'an opened settings panel survives app refreshes');
  assert.equal(h.doc.activeElement,h.$('.bp-settings-disclosure > summary'),'keyboard focus stays on the settings disclosure');
});

test('recent tasks show what was asked, how it ended and what it cost, escaped',async t=>{
  const h=ui(t);await h.show();
  const rows=h.$$('.bp-tasks li');assert.equal(rows.length,2);
  assert.match(rows[0].textContent,/Done/);assert.match(rows[0].textContent,/Draft the <launch> brief/);assert.match(rows[0].textContent,/Chat · 2h ago · 2 min · 1,500 tokens · 1 question/);
  assert.match(rows[1].textContent,/Failed/);assert.match(rows[1].textContent,/Routine · 2h ago · 4s/);assert.match(h.$('.bp-task-error').textContent,/The model provider is <unavailable>\./);
  assert.equal(h.doc.querySelector('.bp-tasks img,.bp-tasks script'),null);
});

test('run history and answers are served per bot and removed with the bot',async t=>{
  const f=await studio(t);
  assert.deepEqual((await f.request('/api/bots/bot_atlas/runs')).body,{data:[]});
  await f.app.store.mutate(state=>{state.runHistory={bot_atlas:[{id:'run_old',status:'completed',task:'Earlier task'}]};});
  assert.deepEqual((await f.request('/api/bots/bot_atlas/runs')).body.data.map(item=>item.id),['run_old']);
  assert.equal((await f.request('/api/bots/bot_atlas/runs',{signedIn:false})).status,401);
  const answer=await f.request('/api/bots/bot_atlas/answer',{method:'POST',data:{runId:'run_old',remoteRunId:'run_old',request_id:'question_x',execution_generation:1,skip:true}});
  assert.equal(answer.status,409);assert.match(answer.body.error,/no active task/);
  assert.equal((await f.request('/api/bots/bot_atlas',{method:'DELETE',data:{}})).status,200);
  assert.equal(f.app.store.state.runHistory.bot_atlas,undefined);
});

test('the brain tab maps, filters and reads linked notes without trusting note text',async t=>{
  const h=ui(t);await h.show();
  await h.click(h.$('[data-profile-action=tab][data-tab=brain]'));
  assert.equal(h.win.location.hash,'#/bots/bot_atlas/brain');assert.equal(h.$('#bp-tab-brain').getAttribute('aria-selected'),'true');
  assert.equal(h.$$('.bp-graph .bp-node').length,3);assert.equal(h.$$('.bp-graph line').length,2);
  assert.equal(h.doc.querySelector('img'),null);assert.match(h.text('#bp-brain-results'),/Acme <img src=x onerror=alert\(1\)>/);
  const search=h.$('[data-profile-input="brain-query"]');search.focus();search.value='ada';search.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  assert.equal(h.$('[data-profile-input="brain-query"]'),search);assert.equal(h.doc.activeElement,search);
  assert.deepEqual(h.$$('.bp-note-row').map(row=>row.dataset.path),['people/Ada Lovelace.md']);
  assert.equal(h.$$('.bp-node.is-dim').length,2);
  search.value='';search.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  await h.click(h.$('.bp-node[data-path="projects/acme.md"] .bp-dot'));
  assert.ok(h.requests.some(item=>item.path==='/api/bots/bot_atlas/brain/note?path=projects%2Facme.md'));
  assert.match(h.text('.bp-reader h2'),/^Acme <img/);assert.equal(h.doc.querySelector('img'),null);
  assert.equal(h.$('.bp-node.is-active').dataset.path,'projects/acme.md');
  const links=h.$$('.bp-note-body .bp-wikilink');
  assert.deepEqual(links.map(link=>[link.textContent,link.dataset.path||null,link.classList.contains('is-missing')]),[['Ada','people/Ada Lovelace.md',false],['Missing note',null,true]]);
  assert.equal(h.$('.bp-note-body .bp-tagref').dataset.tag,'launch');assert.equal(h.text('.bp-note-body code'),'[[code]]');
  assert.equal(h.$('.bp-reader a[download]').getAttribute('href'),'/api/bots/bot_atlas/files/download?path=brain%2Fprojects%2Facme.md');
  assert.deepEqual(h.$$('.bp-reader-links section:last-child .bp-chip').map(chip=>chip.textContent),['Ada Lovelace']);
  assert.match(h.text('.bp-reader-links'),/Missing note/);
  // An app.js re-render keeps the tab, open note and filters without refetching fresh data.
  const count=h.requests.length;await h.show();
  assert.equal(h.requests.length,count);assert.equal(h.$('#bp-tab-brain').getAttribute('aria-selected'),'true');assert.match(h.text('.bp-reader h2'),/^Acme/);
  await h.click(links[0].isConnected?links[0]:h.$('.bp-note-body .bp-wikilink'));
  assert.equal(h.requests.at(-1).path,'/api/bots/bot_atlas/brain/note?path=people%2FAda%20Lovelace.md');assert.equal(h.text('.bp-reader h2'),'Ada Lovelace');
  await h.click(h.$('.bp-note-body .bp-wikilink'));assert.equal(h.text('.bp-reader h2').slice(0,4),'Acme');
  await h.click(h.$('.bp-reader [data-profile-action=tag][data-tag=launch]'));
  assert.deepEqual(h.$$('.bp-note-row').map(row=>row.dataset.path),['projects/acme.md']);assert.equal(h.$('.bp-tag-filter .bp-chip.active').dataset.tag,'launch');
  await h.click(h.$('[data-profile-action=clear-filters]'));assert.equal(h.$$('.bp-note-row').length,3);
  await h.click(h.$('[data-profile-action=sort][data-sort=linked]'));assert.equal(h.$('.bp-note-row').dataset.path,'people/Ada Lovelace.md');
  await h.click(h.$('[data-profile-action=close-note]'));assert.ok(h.$('.bp-summary'));
  await h.click(h.$('[data-profile-action=open-link]')??h.$('.bp-mini'));assert.ok(h.$('.bp-reader h2'));
});

test('real rendering keeps note scripts inert and still links [[notes]]',async t=>{
  const h=ui(t,{hash:'#/bots/bot_atlas/brain',rich:true});await h.show();
  await h.click(h.$('.bp-note-row[data-path="projects/acme.md"]'));
  assert.equal(h.doc.querySelector('.bp-note-body script'),null);assert.equal(h.win.hacked,undefined);
  assert.deepEqual(h.$$('.bp-note-body .bp-wikilink').map(link=>link.dataset.target),['Ada Lovelace','Missing note']);
  assert.equal(h.$('.bp-note-body code').textContent,'[[code]]');
});

test('notes-off and empty brains explain themselves and offer settings',async t=>{
  const empty={...overview,notes:[],total:0,tags:[],unresolved:0};
  const off=ui(t,{hash:'#/bots/bot_atlas/brain',tools:['workspace'],brain:empty});await off.show();
  assert.match(off.text('#bp-panel'),/Notes are off/);assert.ok(off.$('#bp-panel [data-action="edit-bot"][data-id="bot_atlas"]'));
  const fresh=ui(t,{hash:'#/bots/bot_atlas/brain',brain:empty});await fresh.show();
  assert.match(fresh.text('#bp-panel'),/No notes yet/);assert.ok(fresh.$('#bp-panel [data-nav="/bot/bot_atlas"]'));
  const kept=ui(t,{hash:'#/bots/bot_atlas/brain',tools:['workspace']});await kept.show();
  assert.match(kept.text('.bp-notice'),/Notes are off for Atlas/);assert.equal(kept.$$('.bp-note-row').length,3);
});

test('memory facts pin, edit, remove and jump to linked notes with friendly busy errors',async t=>{
  const h=ui(t,{hash:'#/bots/bot_atlas/memory'});await h.show();
  assert.equal(h.$('#bp-tab-memory').getAttribute('aria-selected'),'true');
  assert.deepEqual(h.$$('.bp-fact .bp-fact-head strong').map(node=>node.textContent),['Client','Tone']);
  assert.match(h.text('.bp-count'),/2 facts · 1 of 20 pinned/);
  await h.click(h.$('[data-profile-action=pin-fact][data-id=memory_tone]'));
  assert.deepEqual(h.requests.at(-1),{path:'/api/bots/bot_atlas/memory',method:'PUT',body:{key:'Tone',value:'Plain and warm.',pinned:true}});
  assert.equal(h.$$('.bp-fact.pinned').length,2);assert.deepEqual(h.toasts.at(-1),['Fact pinned.',false]);
  const search=h.$('[data-profile-input="memory-query"]');search.value='acme';search.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  assert.deepEqual(h.$$('.bp-fact .bp-fact-head strong').map(node=>node.textContent),['Client']);
  search.value='';search.dispatchEvent(new h.win.Event('input',{bubbles:true}));
  h.state.memoryStatus=409;
  await h.click(h.$('[data-profile-action=edit-fact][data-id=memory_tone]'));
  const form=h.$('[data-profile-form=fact]');assert.equal(form.elements.key.readOnly,true);form.elements.value.value='Short and kind.';
  form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await settled();
  assert.match(h.text('.bp-form-error'),/Atlas is working on a task right now\. You can change its memory when it finishes\./);
  assert.ok(h.$('[data-profile-form=fact]'));
  h.state.memoryStatus=200;await h.click(h.$('[data-profile-action=cancel-fact]'));
  await h.click(h.$('[data-profile-action=add-fact]'));
  const add=h.$('[data-profile-form=fact]');add.elements.key.value='Timezone';add.elements.value.value='Kyiv, see [[people/Ada Lovelace]]';add.elements.pinned.checked=false;
  add.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));await settled();
  assert.deepEqual(h.requests.at(-1).body,{key:'Timezone',value:'Kyiv, see [[people/Ada Lovelace]]',pinned:false});assert.equal(h.$('[data-profile-form=fact]'),null);assert.equal(h.$$('.bp-fact').length,3);
  await h.click(h.$('[data-profile-action=delete-fact][data-id=memory_tone]'));
  await h.click(h.$('[data-profile-action=confirm-delete][data-id=memory_tone]'));
  assert.deepEqual(h.requests.at(-1),{path:'/api/bots/bot_atlas/memory/memory_tone',method:'DELETE',body:{}});assert.equal(h.$$('.bp-fact').length,2);
  await h.click(h.$('.bp-fact [data-profile-action=memory-link][data-target="projects/acme"]'));
  assert.equal(h.win.location.hash,'#/bots/bot_atlas/brain');assert.ok(h.requests.some(item=>item.path==='/api/bots/bot_atlas/brain/note?path=projects%2Facme'));
  assert.match(h.text('.bp-reader h2'),/^Acme/);
});

test('files browse folders, hide dotfiles, route previews and point the notes folder to Brain',async t=>{
  const h=ui(t,{hash:'#/bots/bot_atlas/files'});await h.show();
  assert.ok(h.$('.bp-file.is-brain[data-profile-action=tab][data-tab=brain]'));assert.match(h.text('.bp-files'),/uploads Files you added/);
  assert.doesNotMatch(h.text('.bp-files'),/studio-temp/);assert.match(h.text('#bp-panel'),/1 hidden item not shown/);
  assert.ok(h.$('.bp-file.is-blocked'));assert.equal(h.$('a.bp-file[download]').getAttribute('href'),'/api/bots/bot_atlas/files/download?path=data.bin');
  await h.click(h.$('[data-profile-action=open-file][data-path="report.pdf"]'));
  await h.click(h.$('[data-profile-action=open-file][data-path="notes.txt"]'));
  assert.deepEqual(h.calls,[['preview','bot_atlas','report.pdf'],['editor','bot_atlas','notes.txt']]);
  await h.click(h.$('[data-profile-action=folder][data-path=uploads]'));
  assert.equal(h.requests.at(-1).path,'/api/bots/bot_atlas/files?path=uploads');assert.match(h.text('.bp-files'),/brief\.pdf/);assert.doesNotMatch(h.text('.bp-files'),/file_0123/);
  assert.match(h.text('.bp-crumbs'),/Workspace uploads/);
  await h.click(h.$('[data-profile-action=new-file]'));assert.deepEqual(h.calls.at(-1),['editor','bot_atlas','uploads',true]);
  await h.click(h.$('.bp-crumbs [data-profile-action=folder][data-path=""]'));
  await h.click(h.$('.bp-file.is-brain'));assert.equal(h.win.location.hash,'#/bots/bot_atlas/brain');assert.ok(h.$('.bp-graph'));
});

const workspaceFixture={version:1,memory:{kind:'collection',label:'Memory'},folders:[
  {path:'brain',label:'Brain',description:'Linked long-term knowledge.',status:'ready'},
  {path:'documents',label:'Documents',description:'Original source documents.',status:'ready'},
  {path:'scripts',label:'Scripts',description:'Reusable script packages.',status:'missing'},
  {path:'notes',label:'Notes',description:'Working notes.',status:'blocked'},
  {path:'.tmp',label:'Temporary',description:'Temporary files.',status:'missing'},
]};
const scriptFixture={id:'research-brief',title:'Research <img src=x onerror=bad()> brief',purpose:'Collect source notes & prepare a reusable brief.',interpreter:'python3',entrypoint:'scripts/research-brief/main.py',digest:'a'.repeat(64),manifestSha256:'b'.repeat(64),status:'registered',runtimeAvailable:true,dependencies:['python3'],inputs:[{name:'source',type:'path',description:'A local source document'}],outputs:['outputs/brief.md'],files:[{path:'scripts/research-brief/main.py',relativePath:'main.py',sha256:'c'.repeat(64),size:250}]};

test('workspace categories keep Memory native and existing document paths accessible; initialization handles busy refusals',async t=>{
  const h=ui(t,{hash:'#/bots/bot_atlas/files',workspace:structuredClone(workspaceFixture)});
  h.state.fileLists={'':[{name:'brain',path:'brain',kind:'directory'},{name:'documents',path:'documents',kind:'directory'},{name:'legacy-project',path:'legacy-project',kind:'directory'},{name:'notes',path:'notes',kind:'file',size:12}],documents:[{name:'original-strategy.pdf',path:'documents/original-strategy.pdf',kind:'file',size:2048}]};
  await h.show();
  assert.equal(h.$$('.bp-workspace-card').length,5,'Memory is a virtual native card, while the hidden temporary folder stays hidden');
  const memory=h.$('.bp-workspace-card[data-tab=memory]');assert.match(memory.textContent,/Core memory/);assert.equal(memory.hasAttribute('data-path'),false);
  assert.equal(h.$('.bp-workspace-card[data-path=notes]').disabled,true);assert.match(h.text('.bp-limit'),/existing file or link/);
  assert.ok(h.$('.bp-files [data-path="legacy-project"]'),'custom existing folders stay available');
  assert.ok(h.$('.bp-files a[href$="path=notes"]'),'a file colliding with a category remains downloadable');
  h.state.workspaceStatus=409;await h.click(h.$('[data-profile-action=initialize-workspace]'));
  assert.match(h.text('[role=status]'),/working on a task/);assert.equal(h.$('[data-profile-action=initialize-workspace]').disabled,false);
  h.state.workspaceStatus=200;await h.click(h.$('[data-profile-action=initialize-workspace]'));
  assert.match(h.text('#bp-panel'),/Existing files were kept in place/);
  assert.deepEqual(h.requests.filter(request=>request.method==='POST').map(request=>request.path),['/api/bots/bot_atlas/workspace','/api/bots/bot_atlas/workspace']);
  await h.click(h.$('.bp-workspace-card[data-path=documents]'));
  assert.ok(h.requests.some(request=>request.path==='/api/bots/bot_atlas/files?path=documents'));
  assert.equal(h.$('.bp-files a[download]').getAttribute('href'),'/api/bots/bot_atlas/files/download?path=documents%2Foriginal-strategy.pdf');
  await h.click(h.$('.bp-crumbs [data-path=""]'));await h.click(h.$('.bp-workspace-card[data-tab=memory]'));
  assert.equal(h.win.location.hash,'#/bots/bot_atlas/memory');assert.ok(h.$('.bp-fact'));
  assert.ok(!h.requests.some(request=>/files\?path=memory/.test(request.path)));
});

test('Scripts inspects escaped purpose and files, validates literal arguments and only prepares owner chat/routine drafts',async t=>{
  const h=ui(t,{hash:'#/bots/bot_atlas/scripts',tools:['workspace','terminal'],scripts:[structuredClone(scriptFixture)]});await h.show();
  assert.equal(h.$('#bp-tab-scripts').getAttribute('aria-selected'),'true');assert.match(h.text('.bp-script-list'),/Collect source notes & prepare/);assert.equal(h.doc.querySelector('img'),null);
  await h.click(h.$('[data-profile-action=inspect-script]'));
  assert.equal(h.requests.at(-1).path,'/api/bots/bot_atlas/scripts/research-brief');
  assert.match(h.text('.bp-script-detail'),/A local source document/);assert.match(h.text('.bp-script-detail'),/outputs\/brief.md/);
  await h.click(h.$('[data-profile-action=script-file]'));assert.deepEqual(h.calls.at(-1),['editor','bot_atlas','scripts/research-brief/main.py']);
  h.$('#bp-script-args').value='[42]';await h.click(h.$('[data-profile-action=script-chat]'));assert.match(h.text('.bp-form-error'),/literal string arguments/);assert.ok(!h.calls.some(call=>call[0]==='draft'));
  const field=h.$('#bp-script-args');field.value='["--source", "data/facts.csv"]';field.dispatchEvent(new h.win.Event('input',{bubbles:true}));await h.show();assert.equal(h.$('#bp-script-args').value,'["--source", "data/facts.csv"]');
  await h.click(h.$('[data-profile-action=script-chat]'));const draft=h.calls.at(-1);assert.equal(draft[0],'draft');assert.equal(draft[1],'bot_atlas');assert.match(draft[2],/scripts_run/);assert.ok(draft[2].includes(scriptFixture.digest));assert.ok(draft[2].includes('data/facts.csv'));
  await h.click(h.$('[data-profile-action=script-routine]'));const preset=h.calls.at(-1);assert.equal(preset[0],'routine');assert.equal(preset[2],'bot_atlas');assert.equal(preset[3].enabled,false);assert.deepEqual(JSON.parse(JSON.stringify(preset[3].workflow.steps)),[{id:'script',op:'script',scriptId:'research-brief',digest:scriptFixture.digest,args:['--source','data/facts.csv'],timeoutMs:120000}]);assert.equal(preset[3].workflow.mode,'agent');
  assert.ok(h.requests.every(request=>request.method==='GET'),'inspection and drafting do not dispatch a run or create a routine');
});

test('Scripts preserves restricted tool sets and blocks unregistered, changed or unavailable packages',async t=>{
  const restricted=ui(t,{hash:'#/bots/bot_atlas/scripts',tools:[],scripts:[structuredClone(scriptFixture)]});await restricted.show();await restricted.click(restricted.$('[data-profile-action=inspect-script]'));
  assert.match(restricted.text('.bp-script-detail'),/requires Files and Terminal/);assert.equal(restricted.$('[data-profile-action=script-chat]').disabled,true);assert.equal(restricted.$('[data-profile-action=script-routine]').disabled,true);assert.deepEqual(restricted.data.bots[0].tools,[]);
  const changed=ui(t,{hash:'#/bots/bot_atlas/scripts',tools:['workspace','terminal'],scripts:[{...structuredClone(scriptFixture),status:'changed',error:'Source <script>changed</script>.'}]});await changed.show();await changed.click(changed.$('[data-profile-action=inspect-script]'));
  assert.match(changed.text('.bp-script-detail'),/Files changed/);assert.equal(changed.$('[data-profile-action=script-chat]').disabled,true);assert.equal(changed.doc.querySelector('script'),null);
  changed.state.scriptError='Inspection unavailable.';await changed.click(changed.$('[data-profile-action=inspect-script]'));assert.match(changed.text('.bp-script-detail'),/Inspection unavailable/);assert.ok(changed.$('[data-profile-action=retry-script]'));
});

/* Learning */

const memoryProposal={id:'proposal_memory',botId:'bot_atlas',kind:'memory',status:'pending',current:true,createdAt:time,reason:'You asked for <warmer> answers.',source:{from:'routine',messageIds:['message_pref']},
  changes:[{key:'Tone',before:{value:'Formal.',pinned:false},after:{value:'Plain, see [[projects/acme]].',pinned:true}},{key:'Old client',before:{value:'Initech.',pinned:false},after:null}],
  sources:[{messageId:'message_pref',from:'owner',where:'Bot Chat',createdAt:time,excerpt:'Please keep answers <plain>.'}]};
const skillProposal={id:'proposal_skill',botId:'bot_atlas',kind:'skill',status:'pending',current:true,createdAt:time,reason:'Citations went stale.',source:{from:'chat',messageIds:[]},sources:[],usedBy:[{id:'bot_nova',name:'Nova'}],
  skill:{id:'skill_brief',name:'briefing',create:false,before:{content:'---\nname: briefing\n---\n\n1. Read.\n2. Cite sources.\n3. Send.'},after:{content:'---\nname: briefing\n---\n\n1. Read.\n2. Cite sources with dates.\n3. Send.'}}};

test('the Learning tab shows suggested memory and skill changes with their reasons, sources and diff',async t=>{
  const h=ui(t,{hash:'#/bots/bot_atlas/learning'});h.state.proposals=[structuredClone(memoryProposal),structuredClone(skillProposal),{...structuredClone(memoryProposal),id:'proposal_done',status:'accepted',undoable:true,decidedAt:time}];
  await h.show();
  assert.equal(h.$('[role=tab][aria-selected="true"]').dataset.tab,'learning');
  assert.equal(h.$('#bp-tab-learning span').textContent,'2');
  const [memory,skill,done]=h.$$('.bp-proposal');
  assert.match(h.text('.bp-proposal .bp-proposal-head'),/Memory Change 2 facts/);
  assert.match(memory.textContent,/You asked for <warmer> answers\./);assert.equal(memory.querySelector('script'),null);
  assert.deepEqual([...memory.querySelectorAll('.bp-change')].map(item=>item.className),['bp-change is-change','bp-change is-remove']);
  assert.match(memory.querySelector('.bp-change.is-change').textContent,/Now\s*Formal\.\s*Becomes\s*Plain, see/);
  assert.ok(memory.querySelector('.bp-change.is-change [data-profile-action="memory-link"][data-target="projects/acme"]'),'fact links open the note');
  assert.match(memory.querySelector('.bp-pin-label').textContent,/Pin/);
  assert.match(memory.querySelector('.bp-sources').textContent,/Based on 1 message.*You · Bot Chat · 2h ago.*Please keep answers <plain>\./s);
  assert.match(skill.textContent,/Improve the briefing skill/);assert.match(skill.textContent,/Nova also uses this skill/);
  assert.deepEqual([...skill.querySelectorAll('.bp-diff-line:not(.is-same) code')].map(node=>node.textContent),['2. Cite sources.','2. Cite sources with dates.']);
  assert.deepEqual([...skill.querySelectorAll('.bp-visually-hidden')].map(node=>node.textContent),['Removed: ','Added: ']);
  assert.ok(done.classList.contains('is-reviewed'));assert.ok(done.querySelector('details.bp-proposal-more'));assert.match(done.textContent,/Accepted/);
  assert.ok(h.$('[data-profile-action="setup-review"]'),'a bot with Memory tools offers a daily review');
});

test('accepting, declining and undoing post the decision and refresh the list',async t=>{
  const h=ui(t,{hash:'#/bots/bot_atlas/learning'});h.state.proposals=[structuredClone(memoryProposal),structuredClone(skillProposal)];
  await h.show();
  await h.click(h.$('[data-proposal="proposal_memory"] [data-decision="accept"]'));
  assert.deepEqual(h.requests.filter(item=>item.method==='POST').map(item=>item.path),['/api/bots/bot_atlas/proposals/proposal_memory/accept']);
  assert.deepEqual(h.toasts.at(-1),['Memory updated.',false]);
  await h.click(h.$('[data-proposal="proposal_skill"] [data-decision="reject"]'));
  assert.deepEqual(h.toasts.at(-1),['Suggestion declined.',false]);
  assert.equal(h.$('#bp-tab-learning span'),null,'nothing left to review');
  assert.match(h.text('.bp-panel'),/Nothing to review/);
  // Undo asks first.
  await h.click(h.$('[data-proposal="proposal_memory"] [data-decision="undo"]'));
  assert.match(h.text('[data-proposal="proposal_memory"] .bp-confirm'),/Put back what was there before\?/);
  assert.equal(h.requests.filter(item=>item.method==='POST').length,2);
  await h.click(h.$('[data-proposal="proposal_memory"] .bp-confirm [data-decision="undo"]'));
  assert.equal(h.requests.filter(item=>item.method==='POST').at(-1).path,'/api/bots/bot_atlas/proposals/proposal_memory/undo');
  assert.deepEqual(h.toasts.at(-1),['Change undone.',false]);
});

test('an out-of-date suggestion can only be declined, and a busy bot explains why accepting waits',async t=>{
  const h=ui(t,{hash:'#/bots/bot_atlas/learning'});h.state.proposals=[{...structuredClone(memoryProposal),current:false}];
  await h.show();
  assert.match(h.text('.bp-proposal-stale'),/Out of date: the facts have changed since Atlas suggested this/);
  assert.equal(h.$('[data-decision="accept"]'),null);assert.ok(h.$('[data-decision="reject"]'));
  const busy=ui(t,{hash:'#/bots/bot_atlas/learning'});busy.state.proposals=[structuredClone(memoryProposal)];busy.state.status={text:'Working',className:'working'};
  busy.state.decideError=Object.assign(new Error('Wait for this bot to finish its task before changing what it has learned.'),{status:409});
  await busy.show();
  assert.match(busy.text('.bp-panel'),/Atlas is working on a task\. You can read its suggestions now/);
  await busy.click(busy.$('[data-decision="accept"]'));
  assert.match(busy.text('.bp-form-error'),/Atlas is working on a task right now\. You can change its memory and skills when it finishes\./);
  assert.ok(busy.$('[data-decision="accept"]'),'the suggestion stays to accept later');
});

test('the daily review routine is offered once and opens a prepared routine dialog',async t=>{
  const h=ui(t,{hash:'#/bots/bot_atlas/learning'});h.state.proposals=[];
  h.ctx.routineDialog=(...args)=>h.calls.push(['routine',...args]);
  await h.show();
  assert.match(h.text('.bp-panel'),/Nothing to review/);
  await h.click(h.$('[data-profile-action="setup-review"]'));
  const [,id,botId,preset]=h.calls.at(-1);
  assert.equal(id,undefined);assert.equal(botId,'bot_atlas');assert.equal(preset.name,'Daily review');assert.deepEqual(JSON.parse(JSON.stringify(preset.schedule)),{kind:'daily',time:'21:00'});
  assert.match(preset.prompt,/memory_propose and skills_propose/);assert.match(preset.prompt,/Do not change memory or skills directly/);
  h.data.routines.push({id:'routine_review',name:'Daily review',botId:'bot_atlas',prompt:preset.prompt,schedule:preset.schedule,enabled:true});h.ctx.scheduleLabel=()=>'Every day at 21:00';
  await h.show();
  assert.equal(h.$('[data-profile-action="setup-review"]'),null);
  assert.match(h.text('.bp-panel'),/Daily review · Every day at 21:00/);assert.ok(h.$('[data-action="edit-routine"][data-id="routine_review"]'));
  const off=ui(t,{hash:'#/bots/bot_atlas/learning',tools:['workspace']});off.state.proposals=[];await off.show();
  assert.match(off.text('.bp-panel'),/Memory tools are off/);assert.equal(off.$('[data-profile-action="setup-review"]'),null);
});


test('workshop renders untrusted proposals as text and exports only the inspected revision',async t=>{
  const h=ui(t),digest='a'.repeat(64);
  h.state.workshop={tools:[],catalog:[],items:[{digest,title:'<img src=x onerror=alert(1)>',kind:'tool',summary:'Synthetic proposal'}]};
  h.state.improvement={digest,proposal:{source:'<script>window.hacked=true</script>',tests:[{input:3,expected:3}]}};
  h.win.URL.createObjectURL=()=> 'blob:fixture';h.win.URL.revokeObjectURL=()=>{};
  let download='';h.win.HTMLAnchorElement.prototype.click=function(){download=this.download;};
  await h.show();await h.click(h.$('#bp-tab-workshop'));
  assert.equal(h.$('[data-profile-action="export-improvement"]'),null);
  assert.equal(h.$('#bp-panel img'),null);
  await h.click(h.$('[data-profile-action="review-improvement"]'));
  assert.match(h.$('.bp-workshop-source').textContent,/<script>/);assert.equal(h.win.hacked,undefined);
  await h.click(h.$('[data-profile-action="export-improvement"]'));
  const exported=h.requests.find(x=>x.method==='POST'&&x.path.includes('/improvements/'));
  assert.deepEqual(exported.body,{digest,reviewedDigest:digest,includeSource:true});assert.equal(download,'tupies-contribution-aaaaaaaaaaaa.json');
});
test('workshop grants show the shared count and revoke the exact grant with escaped endpoint text',async t=>{
  const h=ui(t),id='grant_000000000000000000';
  h.state.workshop={tools:[],catalog:[],items:[],grants:[{id,tool:'read',status:'active',endpoint:'https://example.com/<script>bad</script>',used:2,maxRequests:3,expiresAt:'2026-11-01T20:00:00Z',botIds:['bot_atlas','bot_nova']}]};
  await h.show();await h.click(h.$('#bp-tab-workshop'));
  assert.match(h.text('#bp-panel'),/2 \/ 3 requests reserved/);assert.match(h.text('#bp-panel'),/Atlas, Nova/);assert.equal(h.$('#bp-panel script'),null);
  await h.click(h.$('[data-profile-action="revoke-workshop-grant"]'));
  assert.ok(h.requests.some(x=>x.method==='POST'&&x.path===`/api/bots/bot_atlas/workshop-grants/${id}/revoke`));
});
test('Engine candidates show limited check evidence instead of implying full Engine verification',async t=>{
  const h=ui(t,{tools:['engine_workshop']});h.state.workshop={tools:[],catalog:[],items:[{digest:'b'.repeat(64),title:'Candidate',kind:'engine',summary:'Synthetic edit',checks:{syntax:1,tests:2,fullSuite:false}}]};
  await h.show();await h.click(h.$('#bp-tab-workshop'));assert.match(h.text('#bp-panel'),/Engine workshop is enabled/);assert.match(h.text('#bp-panel'),/1 syntax checks · 2 pure-function tests · Full Engine suite not run/);
});
