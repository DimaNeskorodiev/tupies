/* Settings › Chief of staff: pick the bot that oversees the team and optionally add a daily brief. Text is escaped; no animation. */
(()=>{
  'use strict';
  let context=null,request=0;
  const state={loaded:false,error:'',settings:null,busy:false,message:''};
  const e=value=>context.esc(String(value ?? ''));
  const bots=()=>(context.data?.bots || []).filter(bot=>!bot.hidden);
  const clock=schedule=>schedule?.kind==='daily' && /^\d{2}:\d{2}$/.test(schedule.time || '')?`every day at ${schedule.time}`:'on its schedule';
  function brief(settings){
    const routine=settings.brief;
    if(!settings.chiefOfStaff)return '<p class="chief-note">Choose a bot above to add a daily brief.</p>';
    if(!routine)return `<div class="chief-row"><p class="chief-note">A short summary each morning of what your bots did and what needs you. Off until you add it.</p><button class="secondary-button chief-button" type="button" data-chief-brief ${state.busy?'disabled':''}>Add a daily brief</button></div>`;
    return `<div class="chief-row"><p class="chief-note">${routine.enabled?'Daily brief is on':'Daily brief is paused'} · ${e(clock(routine.schedule))}</p><button class="secondary-button chief-button" type="button" data-action="edit-routine" data-id="${e(routine.id)}">Edit</button></div>`;
  }
  function body(){
    if(state.error)return `<p class="chief-note" role="alert">${e(state.error)}</p><button class="secondary-button chief-button" type="button" data-chief-retry>Try again</button>`;
    if(!state.loaded)return '<p class="chief-note" aria-busy="true">Loading…</p>';
    const settings=state.settings,chosen=settings.chiefOfStaffBotId || '';
    const auto=settings.chiefOfStaff && !chosen?` (${settings.chiefOfStaff.name})`:'';
    return `<label class="chief-field field"><span>Who is your chief of staff</span><select class="chief-select" data-chief-select ${state.busy?'disabled':''}><option value=""${chosen?'':' selected'}>${e(`Automatic${auto}`)}</option>${bots().map(bot=>`<option value="${e(bot.id)}"${bot.id===chosen?' selected':''}>${e(bot.name || 'Bot')}</option>`).join('')}</select></label>${brief(settings)}${state.message?`<p class="chief-note" role="status">${e(state.message)}</p>`:''}`;
  }
  const page=()=>`<section class="chief-card glass-card" data-chief-card aria-label="Chief of staff"><h2>Chief of staff</h2><p class="chief-note">Your chief of staff can see what your other bots did and what waits for you, hands work to the right teammate and brings you only decisions, failures and results.</p><div data-chief-body>${body()}</div></section>`;
  const paint=()=>{const host=document.querySelector('[data-chief-body]');if(host && context)host.innerHTML=body();};
  async function load(){
    const mine=++request;state.error='';
    try{const settings=await context.api('/api/settings/chief-of-staff');if(mine!==request)return;state.settings=settings;state.loaded=true;}
    catch(error){if(mine!==request)return;state.error=context.errorText?.(error) || 'Check the connection to this engine and try again.';}
    finally{if(mine===request)paint();}
  }
  async function act(run,done){
    state.busy=true;state.message='';paint();
    try{await run();state.message=done;}catch(error){state.message=context.errorText?.(error) || 'That did not work. Try again.';}
    state.busy=false;paint();
  }
  document.addEventListener('change',event=>{
    const select=event.target.closest?.('[data-chief-select]');if(!context || !select)return;
    void act(async()=>{state.settings=await context.api('/api/settings/chief-of-staff',{method:'PATCH',body:{botId:select.value}});},'Saved.');
  });
  document.addEventListener('click',event=>{
    if(!context)return;
    if(event.target.closest?.('[data-chief-retry]')){state.loaded=false;paint();void load();return;}
    if(event.target.closest?.('[data-chief-brief]'))void act(async()=>{state.settings=await context.api('/api/settings/chief-of-staff/brief',{method:'POST',body:{}});await context.refresh?.();},'Daily brief added.');
  });
  /** The card markup; it loads the current choice each time Settings opens. */
  function render(nextContext){context=nextContext;queueMicrotask(()=>void load());return page();}
  window.StudioChief={render};
})();
