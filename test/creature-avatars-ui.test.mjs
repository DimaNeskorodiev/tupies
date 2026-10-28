import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import sharp from 'sharp';

const avatarSource=await readFile(new URL('../public/creature-avatars.js',import.meta.url),'utf8');
const profileSource=await readFile(new URL('../public/bot-profile.js',import.meta.url),'utf8');
const appSource=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');
const legacyBot={id:'bot_atlas',name:'Atlas',title:'Chief of staff',color:'mint',icon:'sparkles',enabled:true,skills:[],connectionId:'provider'};
const settled=()=>new Promise(resolve=>setImmediate(resolve));
const catalog=JSON.parse(await readFile(new URL('../assets/companions/catalog.json',import.meta.url),'utf8'));
const companionIds=catalog.map(item=>item.id),companionPattern=companionIds.join('|');
const catalogSource=await readFile(new URL('../public/companion-catalog.js',import.meta.url),'utf8');
const paletteIds=['mint','lavender','peach','blue','rose','amber','coral','ruby','tangerine','lemon','lime','forest','teal','ice','indigo','plum','orchid','slate'];

function harness(t,{room=false,chat=false}={}){
  const hash=room?'#/room/room_fixture':chat?'#/bot/bot_atlas':'#/bots';
  const dom=new JSDOM('<!doctype html><div id="app"></div><div id="dialog-root"></div><div id="toasts"></div>',{url:`http://studio.local/${hash}`,runScripts:'outside-only'});
  const win=dom.window,context=dom.getInternalVMContext();
  win.setInterval=()=>1;win.clearInterval=()=>{};win.setTimeout=()=>1;win.requests=[];
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
  let sequence=0;
  Object.defineProperty(win.crypto,'randomUUID',{value:()=>`${String(++sequence).padStart(8,'0')}-1234-4567-89ab-123456789abc`});
  vm.runInContext(catalogSource,context,{filename:'companion-catalog.js'});
  vm.runInContext(avatarSource,context,{filename:'creature-avatars.js'});
  vm.runInContext(profileSource,context,{filename:'bot-profile.js'});
  vm.runInContext(appSource,context,{filename:'app.js'});
  win.fixtureBot={...legacyBot};
  vm.runInContext(`data={...initialState,bots:[fixtureBot],connections:[{id:'provider',type:'openai',name:'Fixture',status:'connected',defaultModel:'model'}]};auth={authenticated:true,csrf:'fixture'};api=async(path,options={})=>{requests.push({path,...options});return {};};refresh=async()=>{};toast=()=>{};`,context);
  t.after(()=>dom.window.close());
  return {win,doc:win.document,run:code=>vm.runInContext(code,context),markup:(bot,size,options)=>win.StudioAvatars.markup(bot,size,options)};
}

// State changes retain mounted portrait artwork; identity is selected locally
// from a finite family without modifying the saved bot profile.
function artwork(node){
  return [...node.querySelectorAll('.companion-avatar img')].map(image=>[image.getAttribute('src'),image.getAttribute('srcset')]);
}
function mount(h,markup){const holder=h.doc.createElement('div');holder.innerHTML=markup;h.doc.querySelector('#app').append(holder);return holder;}
function submit(h,form){form.dispatchEvent(new h.win.Event('submit',{bubbles:true,cancelable:true}));return settled();}
function threadFixture(h,{room=false,messages=[]}={}){
  const counts={hydrations:0};
  h.win.StudioRich={render:text=>`<p>${text}</p>`,hydrate:async()=>{counts.hydrations++;},dispose(){}};
  h.win.fixtureMessages=messages;
  h.run(room
    ? "data.bots.push({...fixtureBot,id:'bot_nova',name:'Nova',icon:'orbit',color:'lavender'});data.rooms=[{id:'room_fixture',name:'Fixture team',botIds:['bot_atlas','bot_nova']}];roomChat={messages:fixtureMessages,drive:null,activeRun:null};document.querySelector('#app').innerHTML=renderRoom('room_fixture');"
    : "activeBot='bot_atlas';chat={messages:fixtureMessages,run:null};document.querySelector('#app').innerHTML=renderChat('bot_atlas');");
  const render=()=>h.run(room?"renderRoomThread('room_fixture')":"renderThread(botById('bot_atlas'))");
  render();
  return {counts,render,container:h.doc.querySelector(room?'#room-thread':'#chat-thread')};
}
function assertLocalCompanionAssets(doc){
  const avatars=[...doc.querySelectorAll('.companion-avatar')];
  assert.ok(avatars.length>0);
  const ids=avatars.flatMap(avatar=>[...avatar.querySelectorAll('[id]')].map(node=>node.id));
  assert.equal(new Set(ids).size,ids.length);
  for(const avatar of avatars){
    assert.ok(companionIds.includes(avatar.dataset.creature));
    assert.equal(avatar.getAttribute('aria-hidden'),'true');
    assert.ok(avatar.querySelector('img'));
    for(const image of avatar.querySelectorAll('img')){
      assert.match(image.getAttribute('src'),new RegExp(`^/assets/companions/companion-(${companionPattern})-(portrait|mascot)(?:-(?:blink|look|wave))?-(32|64|128|256|512)\\.webp$`));
      assert.equal(image.getAttribute('alt'),'');
      assert.equal(image.hasAttribute('onerror'),false);
    }
  }
}

test('legacy profile icons display the assigned cushion companion without migrating saved bot data',t=>{
  const h=harness(t),first=mount(h,h.markup(legacyBot));
  assert.equal(first.querySelector('.companion-avatar').dataset.creature,'blue');
  for(const icon of ['sparkles','orbit','compass','creature:fixture-42','creature:sj-fixture','roki','']){
    const bot={...legacyBot,icon};
    const before=JSON.stringify(bot),node=mount(h,h.markup(bot));
    assert.equal(h.win.StudioAvatars.describe(bot).variant,'blue');
    assert.deepEqual(artwork(node),artwork(first));
    assert.equal(JSON.stringify(bot),before);
  }
  assert.deepEqual(artwork(mount(h,h.markup({...legacyBot,name:'Renamed Atlas'}))),artwork(first));
  h.run("botDialog('bot_atlas')");
  assert.deepEqual(artwork(h.doc.querySelector('#bot-avatar-preview')),artwork(first));
  assert.equal(h.doc.querySelector('#bot-icon').value,'sparkles');
  assert.equal(h.win.requests.length,0);
  assert.equal(h.run("botById('bot_atlas').icon"),'sparkles');
});

test('the four named teammates have distinct companions and unknown teammates keep a deterministic identity',t=>{
  const h=harness(t),expected={atlas:'blue',nova:'coral',scout:'jade',echo:'honey'},sources=new Set();
  for(const [name,variant] of Object.entries(expected)){
    const bot={id:`bot_${name}`,name:'A renamed teammate',icon:'roki',color:'slate'},before=JSON.stringify(bot);
    const node=mount(h,h.markup(bot));
    assert.equal(h.win.StudioAvatars.describe(bot).variant,variant);
    assert.equal(node.querySelector('.companion-avatar').dataset.creature,variant);
    sources.add(node.querySelector('img').getAttribute('src'));
    assert.equal(JSON.stringify(bot),before);
    assert.equal(h.win.StudioAvatars.describe({id:`imported_${name}`,name}).variant,variant);
  }
  assert.equal(sources.size,4);
  const unknown={id:'bot_fixture_unknown',name:'A new teammate',icon:'sparkles',color:'rose'};
  const first=h.win.StudioAvatars.describe(unknown);
  assert.ok(Object.values(expected).includes(first.variant));
  assert.equal(h.win.StudioAvatars.describe({...unknown,name:'Renamed teammate',color:'mint'}).variant,first.variant);
  assert.equal(h.win.StudioAvatars.describe({...unknown}).identity,first.identity);
});

test('explicit companion seeds keep preview artwork stable when the server assigns a new ID',t=>{
  const h=harness(t);
  for(const variant of ['blue','coral','jade','honey']){
    const bot={name:'Draft teammate',icon:`companion:${variant}`,color:'slate'};
    assert.equal(h.win.StudioAvatars.describe(bot).variant,variant);
    assert.deepEqual(artwork(mount(h,h.markup(bot))),artwork(mount(h,h.markup({...bot,id:'server_assigned_id'}))));
  }
});

test('repeated copies share local companion assets without duplicate document identifiers',t=>{
  const h=harness(t);
  mount(h,Array.from({length:5},()=>h.markup(legacyBot)).join(''));
  assert.equal(h.doc.querySelectorAll('.companion-avatar').length,5);
  assertLocalCompanionAssets(h.doc);
});

test('untrusted profile fields cannot inject markup, asset locations or avatar classes',t=>{
  const h=harness(t),attack='\"><script>window.injected=true</script><img onerror="attack()" src="https://example.invalid/attack">';
  const holder=mount(h,h.markup({id:attack,name:attack,color:attack,icon:attack},attack,{state:attack,presentation:attack,instanceKey:attack}));
  assert.equal(holder.querySelectorAll('script,foreignObject,[onload],[onerror]').length,0);
  assert.equal(holder.innerHTML.includes('attack'),false);
  assert.equal(h.win.injected,undefined);
  assert.equal(holder.querySelector('.companion-avatar').dataset.rokiState,'idle');
  assert.equal(holder.querySelector('.companion-avatar').dataset.rokiPresentation,'portrait');
  assertLocalCompanionAssets(holder);
});

test('saved palette colors remain available to activity visuals without recoloring the companion',t=>{
  const h=harness(t),published=Array.from(h.win.StudioAvatars.palettes,palette=>palette.id),activityColors=new Set();
  assert.deepEqual(new Set(published),new Set(paletteIds));
  let baseline;
  for(const color of paletteIds){
    const bot={...legacyBot,color},node=mount(h,h.markup(bot));
    assert.equal(h.win.StudioAvatars.describe(bot).palette,color);
    if(baseline)assert.deepEqual(artwork(node),baseline);else baseline=artwork(node);
    const colors=Array.from(h.win.StudioAvatars.colors(bot));
    assert.equal(colors.length,4);
    assert.ok(colors.every(value=>/^#[a-f0-9]{6}$/i.test(value)));
    activityColors.add(colors.join(','));
  }
  assert.equal(activityColors.size,paletteIds.length);
});

test('all shipped companion icon sizes are transparent square images with visible artwork',async()=>{
  for(const variant of ['blue','coral','jade','honey'])for(const presentation of ['portrait','mascot'])for(const size of [32,64,128,256,512]){
    const file=new URL(`../public/assets/companions/companion-${variant}-${presentation}-${size}.png`,import.meta.url);
    const {data,info}=await sharp(await readFile(file)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(info.width,size);assert.equal(info.height,size);assert.equal(info.channels,4);
    const alpha=Uint8Array.from({length:size*size},(_,pixel)=>data[pixel*4+3]);
    assert.ok(alpha.some(value=>value===0),`${size}px icon needs transparent surrounding pixels`);
    assert.ok(alpha.some(value=>value>240),`${size}px icon needs opaque character pixels`);
    assert.equal(alpha[0],0);assert.equal(alpha[size-1],0);
  }
});

test('every rendered companion source and retina candidate is shipped with transparent alpha at its declared resolution',async t=>{
  const h=harness(t),sources=new Set();
  for(const variant of ['blue','coral','jade','honey'])for(const presentation of ['portrait','mascot'])for(const size of ['', 'small','tiny','large']){
    const holder=mount(h,h.markup({...legacyBot,icon:`companion:${variant}`},size,{presentation})),avatar=holder.querySelector('.companion-avatar');
    for(const state of h.win.StudioAvatars.states){
      h.win.StudioAvatars.setState(avatar,state);
      for(const image of avatar.querySelectorAll('img')){
        sources.add(image.getAttribute('src'));
        for(const candidate of image.getAttribute('srcset').split(',')){
          const [source,density]=candidate.trim().split(/\s+/);
          assert.match(density,/^[12]x$/);
          sources.add(source);
        }
      }
    }
  }
  assert.equal(sources.size,32,'Four identities need both presentations at list/full-size sources and retina resolutions');
  for(const source of sources){
    const match=/^\/assets\/companions\/companion-(?:blue|coral|jade|honey)-(?:portrait|mascot)-(32|64|128|256|512)\.webp$/.exec(source);
    assert.ok(match,`Unexpected nonlocal or unbounded avatar source: ${source}`);
    const bytes=await readFile(new URL('../public'+source,import.meta.url)),metadata=await sharp(bytes).metadata();
    assert.equal(metadata.format,'webp');assert.equal(metadata.width,Number(match[1]));assert.equal(metadata.height,Number(match[1]));
    assert.equal(metadata.hasAlpha,true,`${source} must preserve its transparent background`);
  }
});

test('companions support the bounded task-state catalogue and updates the mounted avatar in place',t=>{
  const h=harness(t),holder=mount(h,h.markup(legacyBot)),avatar=holder.querySelector('.companion-avatar');
  const states=['idle','blink','look','thinking','working','success','greeting','sad','floating'];
  for(const state of states){
    h.win.StudioAvatars.setState(avatar,state);
    assert.equal(holder.querySelector('.companion-avatar'),avatar);
    assert.equal(avatar.dataset.rokiState,state);
    assertLocalCompanionAssets(holder);
    assert.equal(mount(h,h.markup(legacyBot,'',{state})).querySelector('.companion-avatar').dataset.rokiState,state);
  }
  h.win.StudioAvatars.setState(avatar,'"><script>bad()</script>');
  assert.equal(avatar.dataset.rokiState,'idle');
  assert.equal(holder.querySelector('script'),null);
});


test('working UI keeps compact portraits and reserves the full mascot for explicit contexts',t=>{
  const h=harness(t);
  for(const size of ['', 'small','tiny','large']){
    const holder=mount(h,h.markup(legacyBot,size,{state:'working',working:true})),avatar=holder.querySelector('.companion-avatar');
    assert.equal(avatar.dataset.rokiPresentation,'portrait');
    assert.equal(avatar.querySelectorAll('img').length,1);
    assert.equal(avatar.querySelector('.companion-blink,.companion-greeting,.companion-shadow'),null);
    assert.match(avatar.querySelector('img').getAttribute('src'),/^\/assets\/companions\/companion-blue-portrait-/);
  }
  const mascot=mount(h,h.markup(legacyBot,'large',{presentation:'mascot',state:'greeting'})).querySelector('.companion-avatar');
  assert.equal(mascot.dataset.rokiPresentation,'mascot');
  assert.match(mascot.querySelector('.companion-art').getAttribute('src'),/^\/assets\/companions\/companion-blue-mascot-/);
  h.run("document.querySelector('#app').innerHTML=renderBots();botDialog('bot_atlas');");
  assert.ok(h.doc.querySelectorAll('.bot-card .companion-avatar').length);
  assert.ok([...h.doc.querySelectorAll('.bot-card .companion-avatar,#bot-avatar-preview .companion-avatar')].every(node=>node.dataset.rokiPresentation==='portrait'));
});

test('original portrait artwork remains mounted during task-state changes',t=>{
  const h=harness(t),holder=mount(h,h.markup(legacyBot,'small')),avatar=holder.querySelector('.companion-avatar'),image=avatar.querySelector('img');
  const before=image.getAttribute('src');
  for(const state of h.win.StudioAvatars.states){
    h.win.StudioAvatars.setState(avatar,state);
    assert.equal(avatar.querySelector('img'),image);
    assert.equal(avatar.dataset.rokiState,state);
    assert.equal(image.getAttribute('src'),before);
    assert.equal(avatar.dataset.companionState,state);
    assert.equal(avatar.querySelectorAll('img').length,1);
    assert.equal(avatar.querySelector('.roki-blink,.roki-greeting,.roki-shadow'),null);
  }
});

test('chat welcomes and profile heroes show the mascot while chrome, team lists and replies use portraits',t=>{
  const h=harness(t,{chat:true}),thread=threadFixture(h);
  assert.equal(thread.container.querySelector('.chat-welcome .companion-avatar').dataset.rokiPresentation,'mascot');
  assert.ok([...h.doc.querySelectorAll('.chat-header .companion-avatar,.bot-inspector .companion-avatar')].every(node=>node.dataset.rokiPresentation==='portrait'));
  h.run("chat.messages=[{id:'portrait_reply',role:'assistant',content:'A saved reply'}];renderThread(botById('bot_atlas'));data.bots.push({...fixtureBot,id:'bot_nova',name:'Nova'});document.querySelector('#app').innerHTML+=renderBotProfile('bot_atlas');");
  assert.equal(h.doc.querySelector('.chat-message .companion-avatar').dataset.rokiPresentation,'portrait');
  assert.equal(h.doc.querySelector('.bp-hero-avatar .companion-avatar').dataset.rokiPresentation,'mascot');
  assert.equal(h.doc.querySelectorAll('.bp-person .companion-avatar').length,1);
  assert.ok([...h.doc.querySelectorAll('.bp-person .companion-avatar')].every(node=>node.dataset.rokiPresentation==='portrait'));
  const room=harness(t,{room:true}),roomThread=threadFixture(room,{room:true});
  assert.equal(roomThread.container.querySelectorAll('.chat-welcome .companion-avatar').length,2);
  assert.ok([...roomThread.container.querySelectorAll('.chat-welcome .companion-avatar')].every(node=>node.dataset.rokiPresentation==='portrait'));
});

test('bot appearance previews its cushion companion while preserving saved appearance fields',t=>{
  const h=harness(t);h.run("botDialog('bot_atlas')");
  const form=h.doc.querySelector('#bot-form');
  assert.equal(form.querySelector('#bot-avatar-preview .companion-avatar').dataset.rokiPresentation,'portrait');
  assert.equal(form.querySelector('#bot-shape,[data-action="shuffle-avatar"],[data-color]'),null);
  assert.equal(form.querySelector('[name=color]').value,'mint');
  assert.match(form.textContent,/companion/i);
  assert.equal(h.win.requests.length,0);
});

test('saving an existing bot preserves its saved avatar and activity color fields',async t=>{
  const h=harness(t);h.run("botDialog('bot_atlas')");
  await submit(h,h.doc.querySelector('#bot-form'));
  assert.equal(h.win.requests.length,1);
  assert.equal(h.win.requests[0].body.icon,'sparkles');
  assert.equal(h.win.requests[0].body.color,'mint');
});

test('choosing a companion updates only the requested identity and saves the original activity color',async t=>{
  const h=harness(t);h.run("botDialog('bot_atlas')");
  const form=h.doc.querySelector('#bot-form'),before=JSON.stringify(h.run("botById('bot_atlas')"));
  for(const variant of ['coral','jade','honey']){
    form.querySelector(`[data-action="choose-companion"][data-variant="${variant}"]`).click();
    await settled();
    assert.equal(form.querySelector('#bot-icon').value,`companion:${variant}`);
    assert.equal(form.querySelector('#bot-avatar-preview .companion-avatar').dataset.creature,variant);
    const selected=[...form.querySelectorAll('.companion-choice[aria-pressed="true"]')];
    assert.equal(selected.length,1);assert.equal(selected[0].dataset.variant,variant);
    assert.equal(form.querySelector('[name="color"]').value,'mint');
    assert.equal(h.win.requests.length,0);
    assert.equal(JSON.stringify(h.run("botById('bot_atlas')")),before);
  }
  await submit(h,form);
  assert.equal(h.win.requests.length,1);
  assert.equal(h.win.requests[0].body.icon,'companion:honey');
  assert.equal(h.win.requests[0].body.color,'mint');
});

test('a new bot saves its bounded companion seed and retains its preview after the server assigns its ID',async t=>{
  const h=harness(t);h.run('botDialog()');
  const preview=artwork(h.doc.querySelector('#bot-avatar-preview'));
  assert.equal(h.doc.querySelector('#bot-icon').value,'companion:blue');
  assert.equal(h.doc.querySelector('[name=color]').value,'slate');
  h.doc.querySelector('#bot-name').value='New teammate';h.doc.querySelector('#bot-title').value='Planner';
  await submit(h,h.doc.querySelector('#bot-form'));
  const save=h.win.requests[0];
  assert.equal(save.path,'/api/bots');assert.equal(save.method,'POST');assert.equal(save.body.icon,'companion:blue');assert.equal(save.body.color,'slate');
  assert.deepEqual(artwork(mount(h,h.markup({...save.body,id:'bot_assigned_after_save'}))),preview);
});

test('run motion updates existing companion nodes without replacing them or changing unrelated bots',t=>{
  const h=harness(t);
  h.run("document.querySelector('#app').innerHTML=avatar(botById('bot_atlas'))+avatar(botById('bot_atlas'),'small')+avatar({id:'other',name:'Other'})");
  const nodes=[...h.doc.querySelectorAll('[data-avatar-bot="bot_atlas"]')],before=artwork(nodes[0]),other=h.doc.querySelector('[data-avatar-bot="other"]');
  h.run("data.runs.bot_atlas={id:'run_fixture',status:'running'};syncBotAvatarMotion(botById('bot_atlas'))");
  assert.ok(nodes.every(node=>node.classList.contains('is-working')));
  assert.equal(other.classList.contains('is-working'),false);
  h.run("data.runs.bot_atlas.status='completed';syncBotAvatarMotion(botById('bot_atlas'))");
  assert.ok(nodes.every(node=>!node.classList.contains('is-working')));
  h.run("botById('bot_atlas').enabled=false;syncBotAvatarMotion(botById('bot_atlas'))");
  assert.ok(nodes.every(node=>node.classList.contains('is-paused')));
  assert.equal(h.doc.querySelector('[data-avatar-bot="bot_atlas"]'),nodes[0]);
  assert.deepEqual(artwork(nodes[0]),before);
});

test('companions follow actual run phases and returns to idle after transient outcomes',t=>{
  const h=harness(t);
  h.run("document.querySelector('#app').innerHTML=avatar(botById('bot_atlas'))+avatar(botById('bot_atlas'),'large','thread-welcome')");
  const avatar=h.doc.querySelector('[data-avatar-bot="bot_atlas"]'),welcome=h.doc.querySelector('[data-avatar-context="welcome"]');
  assert.equal(avatar.dataset.rokiState,'idle');assert.equal(welcome.dataset.rokiState,'greeting');
  const phase=(run,state)=>{
    h.win.fixtureRun=run;
    h.run("data.runs.bot_atlas=fixtureRun;syncBotAvatarMotion(botById('bot_atlas'))");
    assert.equal(h.doc.querySelector('[data-avatar-bot="bot_atlas"]'),avatar);
    assert.equal(avatar.dataset.rokiState,state);
  };
  phase({status:'running',events:[{type:'model.started'}]},'thinking');
  phase({status:'running',events:[{type:'model.started'},{type:'tool.started'}]},'working');
  phase({status:'running',partialOutput:'Visible reply'},'working');
  phase({status:'waiting_for_approval'},'look');
  phase({status:'waiting_for_delegate'},'look');
  phase({status:'stopping'},'idle');
  phase({status:'completed',finishedAt:new Date().toISOString()},'success');
  phase({status:'failed',finishedAt:new Date().toISOString()},'sad');
  phase({status:'cancelled',finishedAt:new Date().toISOString()},'idle');
  phase({status:'completed',finishedAt:new Date(Date.now()-60000).toISOString()},'idle');
  assert.equal(welcome.dataset.rokiState,'greeting');
  h.run("botById('bot_atlas').enabled=false;syncBotAvatarMotion(botById('bot_atlas'))");
  assert.equal(avatar.dataset.rokiState,'idle');assert.equal(welcome.dataset.rokiState,'idle');
  assert.ok(avatar.classList.contains('is-paused'));
});

test('unchanged bot and room welcomes preserve animated nodes and skip repeated hydration',t=>{
  for(const room of [false,true]){
    const h=harness(t,{room,chat:!room}),thread=threadFixture(h,{room});
    const welcome=thread.container.querySelector('.chat-welcome'),avatars=[...welcome.querySelectorAll('.creature-avatar')],source=thread.container.__studioSource;
    thread.render();thread.render();
    assert.equal(thread.container.querySelector('.chat-welcome'),welcome);
    assert.deepEqual([...welcome.querySelectorAll('.creature-avatar')],avatars);
    assert.equal(thread.container.__studioSource,source);
    assert.equal(thread.counts.hydrations,1);
    assertLocalCompanionAssets(h.doc);
  }
});

test('unchanged settled bot and room transcripts retain message DOM without extra hydration',t=>{
  const messages=[{id:'reply_one',role:'assistant',botId:'bot_atlas',content:'First saved reply'},{id:'reply_two',role:'assistant',botId:'bot_atlas',content:'Second saved reply'}];
  for(const room of [false,true]){
    const h=harness(t,{room,chat:!room}),thread=threadFixture(h,{room,messages});
    const nodes=[...thread.container.querySelectorAll('[data-message-key]')],source=thread.container.__studioSource;
    thread.render();thread.render();
    assert.equal(thread.counts.hydrations,1);
    assert.equal(thread.container.__studioSource,source);
    assert.deepEqual([...thread.container.querySelectorAll('[data-message-key]')],nodes);
    assertLocalCompanionAssets(h.doc);
  }
});

test('thread scopes stay unique alongside roster and settings avatars when retained messages are reordered',t=>{
  const h=harness(t,{chat:true});
  h.win.StudioRich={render:text=>`<p>${text}</p>`,hydrate:async()=>{},dispose(){}};
  h.run("activeBot='bot_atlas';loadChat=()=>{};renderApp();chat={messages:[],run:null};renderThread(botById('bot_atlas'));botDialog('bot_atlas');");
  assert.ok(h.doc.querySelector('.roster .creature-avatar'));
  assert.ok(h.doc.querySelector('.chat-welcome .creature-avatar'));
  assert.ok(h.doc.querySelector('#bot-avatar-preview .creature-avatar'));
  assertLocalCompanionAssets(h.doc);
  h.win.fixtureMessages=[{id:'reply_one',role:'assistant',content:'First saved reply'},{id:'reply_two',role:'assistant',content:'Second saved reply'}];
  h.run("chat.messages=fixtureMessages;renderThread(botById('bot_atlas'))");
  const retained=[...h.doc.querySelectorAll('#chat-thread [data-message-key]')];
  assertLocalCompanionAssets(h.doc);
  h.win.fixtureMessages=[{id:'reply_new',role:'assistant',content:'Inserted saved reply'},h.win.fixtureMessages[1],h.win.fixtureMessages[0]];
  h.run("chat.messages=fixtureMessages;renderThread(botById('bot_atlas'))");
  const reordered=[...h.doc.querySelectorAll('#chat-thread [data-message-key]')];
  assert.equal(reordered[1],retained[1]);assert.equal(reordered[2],retained[0]);
  assertLocalCompanionAssets(h.doc);
});


test('all twenty new identities are selectable without changing the saved bot until Save',async t=>{
  const h=harness(t);h.run("botDialog('bot_atlas')");const form=h.doc.querySelector('#bot-form'),library=form.querySelector('.companion-library'),before=JSON.stringify(h.run("botById('bot_atlas')"));
  assert.equal(library.open,false,'the larger library starts collapsed');
  assert.equal(library.querySelectorAll('.companion-choice').length,24);library.open=true;
  for(const {id} of catalog.filter(item=>item.frames)){
    form.querySelector(`[data-variant="${id}"]`).click();await settled();
    assert.equal(form.querySelector('#bot-icon').value,`companion:${id}`);
    assert.equal(form.querySelector('#bot-avatar-preview .companion-avatar').dataset.creature,id);
    assert.equal(form.querySelector('#bot-avatar-preview .companion-avatar').querySelectorAll('img').length,4);
    assert.equal(form.querySelectorAll('.companion-choice[aria-pressed="true"]').length,1);
    assert.equal(h.win.requests.length,0);assert.equal(JSON.stringify(h.run("botById('bot_atlas')")),before);assert.equal(form.querySelector('[name=color]').value,'mint');
  }
  await submit(h,form);assert.equal(h.win.requests[0].body.icon,'companion:silver');assert.equal(h.win.requests[0].body.color,'mint');
});
