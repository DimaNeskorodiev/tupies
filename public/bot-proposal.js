/* Create a bot by describing it. Step 1 asks one question; step 2 shows a proposal to confirm, edit or open in the full form.
   The engine only proposes (POST /api/bots/proposal). The bot is created here through the ordinary POST /api/bots. */
(()=>{
  'use strict';
  const EXAMPLES=['Triage my inbox every morning','Research competitors and write a weekly summary','Keep my project notes organised'];
  const TOOL_LABELS={workspace:'Files',skills:'Skills',memory:'Memory',web:'Web',terminal:'Terminal',integrations:'Connected services',delegation:'Team work',automation:'Routines',browser:'Browser'};
  const DAY_NAMES={mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday',sun:'Sunday'};
  const MAX=2000;
  let ctx=null,state=null,seq=0;

  const e=value=>ctx.esc(String(value ?? ''));
  const root=()=>document.querySelector('[data-bot-proposal]');
  const connection=()=>{const data=ctx.data||{},id=data.settings?.defaultConnectionId;return (data.connections||[]).find(item=>item.id===id)||null;};

  /** "every day at 08:00", "every Monday and Friday at 09:00". */
  function when(schedule){
    if(!schedule)return '';
    if(schedule.kind==='daily')return `every day at ${schedule.time}`;
    if(schedule.kind==='weekly'){const days=(schedule.days||[]).map(day=>DAY_NAMES[day]||day);return `every ${days.length===7?'day':days.length>1?`${days.slice(0,-1).join(', ')} and ${days.at(-1)}`:days[0]||'week'} at ${schedule.time}`;}
    return '';
  }
  const chip=(kind,value,label)=>`<span class="bprop-chip"><span>${e(label)}</span><button type="button" data-bprop-remove="${e(kind)}" data-value="${e(value)}" aria-label="Remove ${e(label)}">×</button></span>`;

  function stepDescribe(){
    return `<div class="bprop-step" data-bprop-step="describe">
      <label class="bprop-label" for="bprop-description">What should this bot do?</label>
      <textarea id="bprop-description" class="bprop-description" rows="4" maxlength="${MAX}" placeholder="Describe its job in a sentence or two" data-bprop-description>${e(state.description)}</textarea>
      <div class="bprop-examples" role="group" aria-label="Examples">${EXAMPLES.map(text=>`<button type="button" class="bprop-example" data-bprop-example="${e(text)}">${e(text)}</button>`).join('')}</div>
      ${state.error?`<p class="form-error bprop-error" role="alert">${e(state.error)}</p>`:''}
      <div class="bprop-actions"><button type="button" class="primary-button" data-bprop-propose>Propose a bot</button><button type="button" class="bprop-link" data-bprop-manual>Set up by hand</button></div>
    </div>`;
  }
  function stepLoading(){
    return `<div class="bprop-step bprop-loading" data-bprop-step="loading" role="status" aria-busy="true"><p>Drafting a proposal…</p><p class="bprop-quiet">Nothing is created until you confirm.</p><div class="bprop-actions"><button type="button" class="secondary-button" data-bprop-back>Cancel</button></div></div>`;
  }
  function stepProposal(){
    const p=state.proposal,model=connection(),skills=ctx.data?.skills||[],services=ctx.data?.integrations||[];
    const skillLabel=id=>{const skill=skills.find(item=>item.id===id);return skill?.title||skill?.name||id;};
    const serviceLabel=id=>services.find(item=>item.id===id)?.name||id;
    const chips=[...p.tools.filter(tool=>tool!=='skills'||!p.skills.length).map(tool=>chip('tool',tool,TOOL_LABELS[tool]||tool)),...p.skills.map(id=>chip('skill',id,`Skill: ${skillLabel(id)}`)),...p.integrationIds.map(id=>chip('integration',id,serviceLabel(id)))];
    const routine=p.routine?`<label class="bprop-routine"><input type="checkbox" data-bprop-routine ${state.routine?'checked':''}><span><strong>Also set up a routine</strong><small>${e(p.routine.name)}: ${e(when(p.routine.schedule))}. ${e(p.routine.prompt)}</small></span></label>`:'';
    const notes=p.notes.filter(note=>!/without a model/.test(note));
    return `<div class="bprop-step" data-bprop-step="proposal">
      ${p.source==='rules'?`<p class="bprop-banner" role="status">Suggested without a model — adjust anything you like.</p>`:''}
      <div class="bprop-card glass-card">
        <div class="bprop-head"><span class="bprop-avatar" aria-hidden="true">${ctx.avatar({name:p.name,color:'slate',icon:state.icon},'large')}</span>
          <div class="bprop-fields"><div class="field"><label for="bprop-name">Name</label><input id="bprop-name" data-bprop-name maxlength="60" value="${e(p.name)}" autocomplete="off"></div><div class="field"><label for="bprop-title">Role</label><input id="bprop-title" data-bprop-title maxlength="100" value="${e(p.title)}" autocomplete="off"></div></div></div>
        <details class="bprop-how"><summary>How it will work</summary><div class="field"><label for="bprop-instructions" class="bprop-sr">Instructions</label><textarea id="bprop-instructions" data-bprop-instructions rows="8" maxlength="4000">${e(p.instructions)}</textarea></div></details>
        <div class="bprop-section"><span class="bprop-label">What it can use</span><div class="bprop-chips" data-bprop-chips>${chips.join('')||'<span class="bprop-quiet">No tools. It can only chat.</span>'}</div></div>
        ${routine}
        <p class="bprop-model">${model?`Will think with ${e(model.name)}${model.defaultModel?` · ${e(model.defaultModel)}`:''}, the workspace default. You can change this later in the bot’s settings.`:'No model is connected yet. The bot is still created; connect a provider before you chat with it.'}</p>
        ${notes.length?`<ul class="bprop-notes">${notes.map(note=>`<li>${e(note)}</li>`).join('')}</ul>`:''}
      </div>
      ${state.error?`<p class="form-error bprop-error" role="alert">${e(state.error)}</p>`:''}
      <div class="bprop-actions"><button type="button" class="primary-button" data-bprop-create ${state.busy?'disabled':''}>Create bot</button><button type="button" class="secondary-button" data-bprop-customize ${state.busy?'disabled':''}>Customize</button><button type="button" class="secondary-button" data-bprop-back ${state.busy?'disabled':''}>Back</button></div>
    </div>`;
  }
  const view=()=>state.step==='loading'?stepLoading():state.step==='proposal'?stepProposal():stepDescribe();
  function paint(focus){
    const host=root();if(!host)return;
    host.innerHTML=view();
    const target=focus==='description'?host.querySelector('[data-bprop-description]'):focus==='heading'?host.querySelector('[data-bprop-step]'):focus==='name'?host.querySelector('[data-bprop-name]'):host.querySelector(focus||'[data-bprop-step] button');
    if(target){if(!target.matches('input,textarea,button,summary'))target.tabIndex=-1;target.focus?.();}
  }
  /** Reads the edited fields back so a re-render never loses what the owner typed. */
  function sync(){
    const host=root();if(!host)return;
    if(state.step==='describe'){const field=host.querySelector('[data-bprop-description]');if(field)state.description=field.value;return;}
    if(state.step!=='proposal')return;
    const read=(selector,key)=>{const field=host.querySelector(selector);if(field)state.proposal[key]=field.value;};
    read('[data-bprop-name]','name');read('[data-bprop-title]','title');read('[data-bprop-instructions]','instructions');
    const box=host.querySelector('[data-bprop-routine]');if(box)state.routine=box.checked;
  }

  async function propose(){
    sync();
    const description=state.description.trim();
    if(!description){state.error='Describe what the bot should do first.';paint('description');return;}
    state.error='';state.step='loading';const mine=++seq;paint('[data-bprop-back]');
    try{
      const proposal=await ctx.api('/api/bots/proposal',{method:'POST',body:{description}});
      if(mine!==seq||!root())return;
      state.proposal={...proposal,tools:[...(proposal.tools||[])],skills:[...(proposal.skills||[])],integrationIds:[...(proposal.integrationIds||[])],notes:[...(proposal.notes||[])]};
      state.routine=false;state.step='proposal';state.icon=pickIcon(state.proposal.name);paint('[data-bprop-name]');
    }catch(error){
      if(mine!==seq||!root())return;
      state.step='describe';state.error=`Could not draft a proposal. ${ctx.errorText(error)} You can try again or set it up by hand.`;paint('description');
    }
  }
  function pickIcon(name){
    const ids=(window.StudioAvatars?.shapes||[]).map(item=>item.id).filter(Boolean);
    if(!ids.length)return 'companion:blue';
    let hash=0;for(const char of String(name))hash=(hash*31+char.charCodeAt(0))>>>0;
    return ids[hash%ids.length];
  }
  /** What would be created: the edited proposal as POST /api/bots fields. */
  function botFields(){
    const p=state.proposal,input={name:p.name.trim(),title:p.title.trim(),description:p.description||'',instructions:p.instructions.trim(),tools:[...p.tools],skills:[...p.skills],integrationIds:[...p.integrationIds],color:'slate',icon:state.icon};
    if(p.tone)input.tone=p.tone;
    return input;
  }
  function remove(kind,value){
    sync();const p=state.proposal;
    if(kind==='tool'){p.tools=p.tools.filter(item=>item!==value);if(value==='skills')p.skills=[];if(value==='integrations')p.integrationIds=[];if(value==='automation')state.routine=false;}
    if(kind==='skill')p.skills=p.skills.filter(item=>item!==value);
    if(kind==='integration')p.integrationIds=p.integrationIds.filter(item=>item!==value);
    paint('[data-bprop-chips] button');
  }
  function invalid(){
    const p=state.proposal;
    if(!p.name.trim())return 'Give the bot a name.';
    if(!p.title.trim())return 'Give the bot a role, such as “Research assistant”.';
    return '';
  }
  async function create(){
    sync();const problem=invalid();
    if(problem){state.error=problem;paint('[data-bprop-name]');return;}
    state.error='';state.busy=true;paint('[data-bprop-create]');
    let bot;
    try{
      const result=await ctx.api('/api/bots',{method:'POST',body:botFields()});
      bot=result.bot||result;
    }catch(error){
      state.busy=false;state.error=`The bot was not created. ${ctx.errorText(error)}`;if(root())paint('[data-bprop-create]');return;
    }
    let routineError='';
    if(state.routine&&state.proposal.routine){
      try{await ctx.api('/api/routines',{method:'POST',body:{name:state.proposal.routine.name,botId:bot.id,prompt:state.proposal.routine.prompt,schedule:state.proposal.routine.schedule,enabled:true,timezone:browserZone()}});}
      catch(error){routineError=ctx.errorText(error);}
    }
    state.busy=false;ctx.closeDialog();
    try{await ctx.refresh();}catch{/* the list catches up on the next refresh */}
    ctx.navigate(`/bot/${encodeURIComponent(bot.id)}`);
    ctx.toast(routineError?`${bot.name} was created, but the routine was not: ${routineError} Add it from Routines.`:`${bot.name} is ready.`,Boolean(routineError));
    focusMessage(bot.id);
  }
  const browserZone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};
  /** The chat opens after navigation; wait briefly for its message field. */
  function focusMessage(botId,tries=0){
    const field=document.querySelector('#message-input'),form=document.querySelector('#message-form');
    if(field&&(!form?.dataset.id||form.dataset.id===botId)){field.focus();return;}
    if(tries<30)setTimeout(()=>focusMessage(botId,tries+1),100);
  }
  function customize(){
    sync();const p=state.proposal;
    if(state.routine&&p.routine)ctx.toast('The routine is not part of the full form. Add it from Routines after you create the bot.');
    const template={name:p.name,title:p.title,description:p.description||'',instructions:p.instructions,tools:[...p.tools],skills:[...p.skills],integrationIds:[...p.integrationIds],tone:p.tone||'',toneNote:'',color:'slate',icon:state.icon};
    ctx.botDialog(undefined,template);
  }
  function manual(){ctx.botDialog();}

  function click(event){
    const button=event.target.closest('[data-bprop-propose],[data-bprop-manual],[data-bprop-example],[data-bprop-remove],[data-bprop-create],[data-bprop-customize],[data-bprop-back]');
    if(!button||!root()?.contains(button))return;
    if(button.hasAttribute('data-bprop-propose'))propose();
    else if(button.hasAttribute('data-bprop-manual'))manual();
    else if(button.hasAttribute('data-bprop-example')){state.description=button.dataset.bpropExample;paint('description');}
    else if(button.hasAttribute('data-bprop-remove'))remove(button.dataset.bpropRemove,button.dataset.value);
    else if(button.hasAttribute('data-bprop-create'))create();
    else if(button.hasAttribute('data-bprop-customize'))customize();
    else if(button.hasAttribute('data-bprop-back')){sync();seq++;state.step='describe';state.error='';paint('description');}
  }
  function keydown(event){
    if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.target.matches?.('[data-bprop-description]')){event.preventDefault();propose();}
  }

  function open(context){
    ctx=context;seq++;
    state={step:'describe',description:'',proposal:null,routine:false,error:'',busy:false,icon:'companion:blue'};
    ctx.openDialog('New bot',`<div class="bprop" data-bot-proposal>${stepDescribe()}</div>`,{wide:true});
    const host=root();if(!host)return;
    host.addEventListener('click',click);host.addEventListener('keydown',keydown);
    host.querySelector('[data-bprop-description]')?.focus();
  }
  window.StudioBotProposal={open,when,_state:()=>state};
})();
