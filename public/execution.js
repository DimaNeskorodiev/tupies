/* Bot settings › Tools › "Where commands run": the owner's choice and whether it works on this engine (GET /api/execution). */
(()=>{
  'use strict';
  const escape=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const CHOICES=[['host','This computer, ask me'],['sandbox','Sandbox on this computer (recommended)'],['docker','Docker container'],['ssh','Another machine (SSH)']];
  const HELP={sandbox:'In the sandbox, commands can change only this bot’s own folders and cannot read your keys or the engine’s data, so ordinary commands run without asking, also in routines and Telegram. Dangerous commands still ask. The network stays open.',docker:'Each command runs in a fresh Docker container that can change only this bot’s own folders. The network stays open, and the container image is yours to choose. Ordinary commands run without asking; dangerous ones still ask.',ssh:'Each command runs on another machine you set up for this engine, in a folder of its own for this bot. Files the bot creates there stay on that machine, and the remote account keeps all of its rights. Ordinary commands run without asking; dangerous ones still ask.'};
  let report=null,loadedAt=0,pending=null;

  /** The settings field; the status line is filled in once the engine has answered. */
  function fieldHTML(bot){
    const current=typeof bot?.execution?.backend==='string'&&bot.execution.backend?bot.execution.backend:'host';
    // A choice synced from another engine stays selected so saving other settings keeps it.
    const choices=CHOICES.some(([id])=>id===current)?CHOICES:[...CHOICES,[current,`${current} (not on this engine)`]];
    return `<div class="field execution-field" data-execution-field><label for="bot-execution">Where commands run</label><select id="bot-execution" name="executionBackend" aria-describedby="bot-execution-help bot-execution-status">${choices.map(([id,label])=>`<option value="${escape(id)}" ${id===current?'selected':''}>${escape(label)}</option>`).join('')}</select><small id="bot-execution-help">${escape(HELP[current] || HELP.sandbox)}</small><p class="subtle-label execution-status" id="bot-execution-status" data-execution-status role="status" aria-live="polite">Checking this engine…</p></div>`;
  }

  async function load(){
    if(report && Date.now()-loadedAt<30_000)return report;
    pending ||= fetch('/api/execution',{credentials:'same-origin',headers:{Accept:'application/json'}}).then(async response=>{
      if(!response.ok)throw new Error(`The engine answered ${response.status}.`);
      const body=await response.json();report=Array.isArray(body?.backends)?body.backends:[];loadedAt=Date.now();return report;
    }).finally(()=>{pending=null;});
    return pending;
  }

  function statusText(id,backends){
    if(id==='host')return {state:'host',text:'Commands run with your account’s permissions. Anything that can change files asks you first.'};
    const backend=backends.find(item=>item.id===id);
    if(!backend)return {state:'down',text:'This engine cannot run commands there, so this bot asks you before every command that can change files.'};
    if(backend.available)return {state:'ready',text:id==='sandbox'?'Sandbox ready.':id==='docker'?'Docker ready.':id==='ssh'?'The other machine is ready.':'Ready.'};
    if(id==='docker'||id==='ssh')return {state:'down',text:`${backend.reason||'Not available here.'} Until this works, this bot asks you before every command that can change files.`};
    return {state:'down',text:`${id==='sandbox'?'Sandbox':'This choice is'} not available here: ${backend.reason||'unknown reason'} Until it is, this bot asks you before every command that can change files.`};
  }

  async function refresh(field){
    const select=field.querySelector('select'),status=field.querySelector('[data-execution-status]');
    if(!select||!status)return;
    field.dataset.executionReady='true';
    try{
      const backends=await load(),{state,text}=statusText(select.value,backends);
      status.textContent=text;status.dataset.state=state;
      const help=field.querySelector('#bot-execution-help');if(help&&HELP[select.value])help.textContent=HELP[select.value];
    }catch(error){status.textContent=`Could not check this engine: ${error.message}`;status.dataset.state='down';field.dataset.executionReady='';}
  }

  const scan=()=>{for(const field of document.querySelectorAll('[data-execution-field]:not([data-execution-ready])'))void refresh(field);};
  document.addEventListener('change',event=>{const field=event.target.closest?.('[data-execution-field]');if(field)void refresh(field);});
  new MutationObserver(scan).observe(document.documentElement,{childList:true,subtree:true});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',scan,{once:true});else scan();

  window.StudioExecution={fieldHTML,statusText};
})();
