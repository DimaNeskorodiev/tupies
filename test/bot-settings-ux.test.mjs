import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const source=await readFile(new URL('../public/bot-profile.js',import.meta.url),'utf8');
const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));};
function fixture(t){
  const dom=new JSDOM('<main id="root"></main><div id="dialog-root"></div>',{url:'http://fixture.local/#/bots/bot_fixture/settings',runScripts:'outside-only'}),win=dom.window,doc=win.document;
  vm.runInContext(source,dom.getInternalVMContext());
  const bot={id:'bot_fixture',name:'Atlas',title:'Planner',instructions:'Be clear.',tools:['workspace','skills'],skills:['skill_brief','skill_missing']};
  const calls=[],data={bots:[bot],skills:[{id:'skill_brief',title:'Weekly <brief>',name:'Briefing',description:'Summarize <priorities>.',available:true},{id:'skill_other',name:'Research'}]},sections=['general','instructions','tools','skills'];
  const content={general:'<input name="name" value="Atlas" required><input name="title" value="Planner" required>',instructions:'<textarea name="instructions">Be clear.</textarea>',tools:'<details class="bot-capabilities"><summary>Everyday <span data-tool-count></span></summary><input name="tool" type="checkbox" value="workspace" checked><input name="tool" type="checkbox" value="web"></details>',skills:'<input name="tool" type="checkbox" value="skills" checked><p data-skill-access-notice hidden>Access is off</p><input type="search" data-settings-skill-search><select data-settings-skill-filter><option value="all">All</option><option value="assigned">Assigned</option></select><p data-settings-skill-results></p><div data-settings-skill-list><label data-skill-option><input name="skill" type="checkbox" value="skill_brief" checked><span>Briefing</span></label><label data-skill-option><input name="skill" type="checkbox" value="skill_other"><span>Research</span></label></div>'};
  const ctx={data,botById:id=>id===bot.id?bot:null,botStatus:()=>({className:'ready'}),statusPill:()=>'',avatar:()=>'<span class="avatar"></span>',icon:()=>'<svg></svg>',viewSkill:id=>calls.push(id),errorText:error=>error.message,toast:message=>calls.push(message),
    botSettingsForm:()=>`<form id="bot-form" data-embedded="true" data-id="${bot.id}"><nav class="bot-settings-nav">${sections.map(key=>`<button type="button" data-profile-action="settings-section" data-section="${key}">${key}</button>`).join('')}</nav>${sections.map(key=>`<section data-bot-settings-section="${key}"><h2 tabindex="-1">${key}</h2>${content[key]}</section>`).join('')}<div class="bot-settings-save"><p class="form-error"></p><span data-settings-status></span><button type="button" data-profile-action="discard-settings">Discard</button><button type="submit">Save</button></div></form>`};
  const root=doc.querySelector('#root'),show=()=>{root.innerHTML=win.StudioBotProfile.render(ctx,bot.id);win.StudioBotProfile.mount(ctx,bot.id,root);};
  const $=selector=>doc.querySelector(selector),$$=selector=>[...doc.querySelectorAll(selector)],click=async selector=>{$(selector).click();await settle();};
  const input=(selector,value)=>{const field=$(selector);if(field.type==='checkbox')field.checked=value;else field.value=value;field.dispatchEvent(new win.Event('input',{bubbles:true}));};
  t.after(()=>win.close());show();
  return {win,doc,bot,data,calls,show,$,$$,click,input,profile:win.StudioBotProfile};
}

test('settings show one section while preserving all fields for submission and revealing invalid hidden fields',async t=>{
  const h=fixture(t);
  assert.deepEqual(h.$$('[data-bot-settings-section]').filter(row=>!row.hidden).map(row=>row.dataset.botSettingsSection),['general']);
  await h.click('[data-section="instructions"]');
  assert.equal(h.$('[data-bot-settings-section="general"]').hidden,true);
  assert.equal(h.$('[data-section="instructions"]').getAttribute('aria-pressed'),'true');
  const form=h.$('#bot-form'),values=new h.win.FormData(form);
  assert.equal(values.get('name'),'Atlas');assert.deepEqual(values.getAll('tool'),['workspace','skills']);
  h.input('[name="title"]','');
  assert.equal(form.reportValidity(),false);
  assert.equal(h.$('[data-bot-settings-section="general"]').hidden,false);
});

test('the selected settings section remains visible in the horizontal nav after a resize',async t=>{
  const h=fixture(t),nav=h.$('.bot-settings-nav'),selected=h.$('[data-section="skills"]');let width=288;
  Object.defineProperty(nav,'clientWidth',{get:()=>width});
  nav.getBoundingClientRect=()=>({left:16,right:16+width,width});
  selected.getBoundingClientRect=()=>({left:400-nav.scrollLeft,right:470-nav.scrollLeft,width:70});
  await h.click('[data-section="skills"]');assert.equal(nav.scrollLeft,174);
  width=240;h.win.dispatchEvent(new h.win.Event('resize'));assert.equal(nav.scrollLeft,222);
  assert.equal(h.win.scrollY,0);
});

test('dirty state follows saved values, search is presentation only, and filters never remove assignments',async t=>{
  const h=fixture(t),form=h.$('#bot-form'),save=h.$('button[type="submit"]');
  assert.equal(save.disabled,true);
  h.input('[name="name"]','A new name');assert.equal(form.dataset.settingsDirty,'true');assert.equal(save.disabled,false);
  h.input('[name="name"]','Atlas');assert.equal(form.dataset.settingsDirty,'false');assert.equal(save.disabled,true);
  await h.click('[data-section="skills"]');
  h.input('[data-settings-skill-search]','Research');
  assert.equal(form.dataset.settingsDirty,'false');assert.equal(h.$$('[data-skill-option]').filter(row=>!row.hidden).length,1);
  assert.deepEqual(new h.win.FormData(form).getAll('skill'),['skill_brief']);
  h.input('[name="skill"][value="skill_other"]',true);assert.equal(form.dataset.settingsDirty,'true');
  assert.match(h.$('[data-settings-skill-results]').textContent,/2 assigned/);
  h.input('[name="tool"][value="skills"]',false);assert.equal(h.$('[data-skill-access-notice]').hidden,false);
  h.input('[name="tool"][value="web"]',true);assert.equal(h.$('[data-tool-count]').textContent,'2 of 2 enabled');
});

test('settings retain draft, selected section, search, focus and disclosure state across profile tabs and renders',async t=>{
  const h=fixture(t);
  await h.click('[data-section="instructions"]');h.input('[name="instructions"]','Keep this draft.');
  await h.click('[data-section="skills"]');h.input('[data-settings-skill-search]','Research');h.$('[data-settings-skill-search]').focus();
  h.$('details').open=true;h.show();
  assert.equal(h.doc.activeElement,h.$('[data-settings-skill-search]'));assert.equal(h.$('[data-settings-skill-search]').value,'Research');
  assert.equal(h.$('details').open,true);assert.equal(h.$('#bot-form').dataset.settingsSection,'skills');
  await h.click('#bp-tab-skills');await h.click('#bp-tab-settings');
  assert.equal(h.$('[name="instructions"]').value,'Keep this draft.');assert.equal(h.$('#bot-form').dataset.settingsSection,'skills');
  assert.equal(h.$('[data-settings-skill-search]').value,'Research');assert.equal(h.$('button[type="submit"]').disabled,false);
  await h.click('[data-profile-action="discard-settings"]');
  assert.equal(h.$('[name="instructions"]').value,'Be clear.');assert.equal(h.$('#bot-form').dataset.settingsSection,'skills');assert.equal(h.$('button[type="submit"]').disabled,true);
});

test('a pending save preserves its exact locked form across refreshes and blocks profile navigation',async t=>{
  const h=fixture(t);h.input('[name="name"]','Saved name');const form=h.$('#bot-form');
  form.dataset.settingsSaving='true';for(const field of form.elements)field.disabled=true;h.profile.syncSettings(form);
  h.show();assert.equal(h.$('#bot-form'),form);assert.equal(h.$('[name="name"]').disabled,true);
  await h.click('#bp-tab-skills');assert.ok(h.$('#bot-form'));assert.equal(h.$('#bp-tab-settings').getAttribute('aria-selected'),'true');
  h.profile.settingsSaved(h.bot.id);delete form.dataset.settingsSaving;for(const field of form.elements)field.disabled=false;h.profile.syncSettings(form);
  assert.equal(h.$('[name="name"]').disabled,false);assert.equal(h.$('button[type="submit"]').disabled,true);
  h.input('[name="name"]','Another name');assert.equal(h.$('button[type="submit"]').disabled,false);
});

test('save completion resets its detached originating form before returning during the pending refresh',async t=>{
  const h=fixture(t);h.input('[name="name"]','Saved name');const form=h.$('#bot-form');
  form.dataset.settingsSaving='true';for(const field of form.elements)field.disabled=true;h.profile.syncSettings(form);
  h.$('#root').innerHTML='<p>A different page</p>';
  h.profile.settingsSaved(h.bot.id,form);
  h.show();assert.equal(h.$('#bot-form'),form);assert.equal(form.dataset.settingsDirty,'false');
  delete form.dataset.settingsSaving;for(const field of form.elements)field.disabled=false;h.profile.syncSettings(form);
  assert.equal(form.dataset.settingsDirty,'false');assert.equal(h.$('button[type="submit"]').disabled,true);
});

test('a detached failed save keeps the draft and refusal text when returning to settings',async t=>{
  const h=fixture(t);h.input('[name="instructions"]','A draft to retry.');const form=h.$('#bot-form');
  form.dataset.settingsSaving='true';for(const field of form.elements)field.disabled=true;h.profile.syncSettings(form);
  h.$('#root').innerHTML='<p>A different page</p>';
  delete form.dataset.settingsSaving;for(const field of form.elements)field.disabled=false;h.profile.syncSettings(form);
  form.querySelector('.form-error').textContent='The bot is still working. Try again when it finishes.';h.profile.syncSettings(form);
  h.show();assert.notEqual(h.$('#bot-form'),form);
  assert.equal(h.$('[name="instructions"]').value,'A draft to retry.');
  assert.match(h.$('.form-error').textContent,/The bot is still working/);assert.equal(h.$('button[type="submit"]').disabled,false);
});

test('an empty Skills library has one empty state while a filtered library shows a no-match result',async t=>{
  const h=fixture(t),form=h.$('#bot-form');
  const empty=h.doc.createElement('p');empty.dataset.settingsSkillEmpty='';empty.textContent='No installed skills yet.';form.append(empty);
  h.input('[data-settings-skill-search]','No such playbook');assert.equal(empty.hidden,true);assert.equal(h.$('[data-settings-skill-results]').hidden,false);assert.match(h.$('[data-settings-skill-results]').textContent,/No matching skills/);
  h.$('[data-settings-skill-list]').replaceChildren();h.profile.syncSettings(form);
  assert.equal(empty.hidden,false);assert.equal(h.$('[data-settings-skill-results]').hidden,true);
});

test('Skills profile shows escaped assigned playbooks, unavailable files and a direct assignment route',async t=>{
  const h=fixture(t);await h.click('#bp-tab-skills');
  assert.equal(h.$$('.bp-skill-card').length,2);assert.match(h.$('.bp-skill-card h2').textContent,/Weekly <brief>/);assert.equal(h.$('.bp-skill-card brief'),null);
  assert.equal(h.$('[data-profile-action="view-skill"][data-id="skill_missing"]').disabled,true);
  await h.click('[data-profile-action="view-skill"][data-id="skill_brief"]');assert.deepEqual(h.calls,['skill_brief']);
  await h.click('[data-profile-action="manage-skills"]');assert.equal(h.$('#bot-form').dataset.settingsSection,'skills');
});
