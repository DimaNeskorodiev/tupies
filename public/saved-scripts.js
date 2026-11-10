/* Saved scripts for owners: the bot profile's Scripts tab (list, form, Run, review, history) and the "Save this as a script" card in chat.
   bot-profile.js owns the tab and the data; this module only turns what the engine reports into plain words and sends the owner's own clicks.
   Nothing here runs or saves a script without a click. */
(()=>{
  'use strict';
  const escape=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const enc=encodeURIComponent;
  const plain=value=>value && typeof value==='object' && !Array.isArray(value);
  const text=(value,max=300)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,' ').slice(0,max):'';
  const SAVE_REQUEST='Save what you just did as a script so next time it runs in seconds without the model. Pick a clear name, declare its inputs, and tell me how to run it.';
  const WHO={owner:'you',bot:'the bot',routine:'a routine',teammate:'a teammate'};
  const STATUS={succeeded:'Succeeded',failed:'Failed',timed_out:'Timed out',stopped:'Stopped'};
  const MAX_STATES=40;
  const states=new Map(),contexts=new Map();

  /* ---- plain-words helpers ---- */
  function ago(iso,now=Date.now()){
    const time=Date.parse(iso);if(!Number.isFinite(time))return '';
    const seconds=Math.max(0,Math.round((now-time)/1000));
    if(seconds<60)return 'just now';
    const minutes=Math.round(seconds/60);if(minutes<60)return `${minutes} minute${minutes===1?'':'s'} ago`;
    const hours=Math.round(minutes/60);if(hours<24)return `${hours} hour${hours===1?'':'s'} ago`;
    const days=Math.round(hours/24);if(days<30)return `${days} day${days===1?'':'s'} ago`;
    return new Date(time).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  }
  function day(iso){const time=Date.parse(iso);return Number.isFinite(time)?new Date(time).toLocaleDateString('en-GB',{day:'numeric',month:'short'}):'';}
  function seconds(ms){
    if(!Number.isFinite(ms) || ms<0)return '';
    if(ms<1000)return `${Math.round(ms)} ms`;
    const s=Math.round(ms/1000);if(s<60)return `${s} s`;
    return s%60?`${Math.floor(s/60)} min ${s%60} s`:`${s/60} min`;
  }
  function where(backend){
    const name=String(backend ?? '').toLowerCase();if(!name)return '';
    return name==='sandbox'?'in the sandbox':name==='host'?'on this computer':/^(container|docker|podman)/.test(name)?'in a container':'on another machine';
  }
  const count=(n,one,many)=>`${n} ${n===1?one:many}`;
  const valid=script=>plain(script) && typeof script.id==='string' && /^[\w.-]{1,80}$/.test(script.id);
  const titleOf=script=>text(script.title,120) || script.id;
  const fields=script=>(Array.isArray(script.inputFields)?script.inputFields:[]).filter(plain);
  const named=script=>fields(script).filter(field=>typeof field.name==='string' && /^[\w.-]{1,64}$/.test(field.name)).slice(0,20);
  const routines=script=>(Array.isArray(script.usedBy)?script.usedBy:[]).filter(item=>plain(item) && typeof item.name==='string');

  /** The one state worth mentioning for a script, in plain words; '' when nothing is worth saying. */
  function problem(script){
    if(['draft','invalid','changed'].includes(script.status) && script.runnable!==true)return {text:'Not finished — ask the bot to save it again',tone:'warn'};
    if(script.runtimeAvailable===false)return {text:`Can't run here: ${text(script.error,160) || `${script.language==='node'?'Node':script.language==='bash'?'Bash':'Python'} isn't available on this computer`}`,tone:'warn'};
    if(script.runnable===false)return {text:`Can't run here${script.error?`: ${text(script.error,160)}`:''}`,tone:'warn'};
    if(script.needsApproval)return script.approvedVersion?{text:'Changed since you approved it',tone:'note'}:{text:'New — review before first run',tone:'note'};
    return null;
  }
  function runLine(script){
    const runs=plain(script.runs)?script.runs:{};
    if(!Number.isFinite(runs.count) || runs.count<1)return 'Never run';
    const parts=[`Ran ${count(runs.count,'time','times')}`];
    const when=ago(runs.lastAt);if(when)parts.push(`last run ${when}`);
    if(STATUS[runs.lastStatus])parts.push(STATUS[runs.lastStatus].toLowerCase());
    return parts.join(' · ');
  }

  /* ---- per-script state (kept while the owner is on the tab; bounded) ---- */
  function stateOf(botId,id){
    const key=`${botId}/${id}`;let st=states.get(key);
    if(st){states.delete(key);states.set(key,st);return st;}
    st={inputs:{},args:'',running:false,result:null,error:'',review:null,revoking:false,notice:'',open:{}};
    states.set(key,st);while(states.size>MAX_STATES)states.delete(states.keys().next().value);
    return st;
  }

  /* ---- markup ---- */
  function listRow(script,{v,icon}){
    const issue=problem(script),used=routines(script);
    const small=[issue?`<span class="ss-state ${issue.tone}">${escape(issue.text)}</span>`:'',used.length?`<span class="ss-state">Used by ${escape(count(used.length,'routine','routines'))}</span>`:''].join('');
    return `<button type="button" class="bp-script-row ss-row${v.scriptTarget===script.id?' active':''}" data-profile-action="inspect-script" data-id="${escape(script.id)}" aria-pressed="${v.scriptTarget===script.id}"><span class="bp-script-symbol">${icon('code')}</span><span><strong>${escape(titleOf(script))}</strong><small>${escape(text(script.purpose,240) || 'No description yet')}</small><span class="ss-meta">${escape(runLine(script))}</span>${small}</span>${icon('chevron')}</button>`;
  }
  function empty(icon){
    return `<section class="glass-card ss-empty">${icon('code')}<h2>No saved scripts yet</h2><p>A script is a small program your bot keeps so it can repeat a task in seconds, without using the model.</p><p>Ask your bot to save a task as a script, or accept the suggestion that appears in chat after a long task.</p></section>`;
  }
  function form(script,st,env){
    const list=named(script),busy=st.running;
    const free=fields(script).filter(field=>!list.includes(field) && text(field.description,300));
    const rows=list.map((field,index)=>{
      const name=field.name,id=`ss-in-${index}`,value=Object.hasOwn(st.inputs,name)?st.inputs[name]:field.default===undefined||field.default===null?'':String(field.default);
      const required=field.required===true && (field.default===undefined || field.default===null);
      const hint=text(field.description,300);
      return `<div class="field ss-field"><label for="${id}">${escape(name)}${field.required===true?'<span class="ss-required" aria-hidden="true"> *</span><span class="ss-sr"> (required)</span>':''}</label><input id="${id}" type="text" name="${escape(name)}" data-ss-input="${escape(name)}" value="${escape(value)}"${field.default!==undefined && field.default!==null?` placeholder="${escape(String(field.default))}"`:''}${required?' aria-required="true"':''}${hint?` aria-describedby="${id}-help"`:''} autocomplete="off" spellcheck="false" maxlength="2000"${busy?' disabled':''}>${hint?`<small id="${id}-help">${escape(hint)}</small>`:''}</div>`;
    }).join('');
    const extra=list.length?'':`<div class="field ss-field"><label for="ss-args">Extra arguments <span class="ss-optional">(optional)</span></label><textarea id="ss-args" rows="2" data-ss-args spellcheck="false" maxlength="20000"${busy?' disabled':''}>${escape(st.args)}</textarea><small>One argument per line. Leave empty if the script needs none.</small></div>`;
    const notes=free.length?`<ul class="ss-notes">${free.map(field=>`<li>${escape(text(field.description,300))}</li>`).join('')}</ul>`:'';
    const runnable=script.runnable!==false && script.runtimeAvailable!==false;
    return `<form class="ss-form" data-ss-form novalidate>${notes}${rows}${extra}${st.error?`<p class="bp-form-error ss-error" role="alert">${escape(st.error)}</p>`:''}${st.notice?`<p class="ss-notice" role="status">${escape(st.notice)}</p>`:''}<div class="ss-actions"><button type="submit" class="primary-button ss-run"${busy||!runnable?' disabled':''}>${busy?'Running…':'Run'}</button></div></form>`;
  }
  function diffMarkup(diff){
    return String(diff).split('\n').slice(0,200).map(line=>`<span class="${/^\+(?!\+\+)/.test(line)?'ss-add':/^-(?!--)/.test(line)?'ss-del':''}">${escape(line)}</span>`).join('\n');
  }
  function review(script,st){
    const changed=Boolean(script.approvedVersion);
    const diff=typeof script.diff==='string' && script.diff.trim()?script.diff:'',code=plain(script.source) && typeof script.source.content==='string'?script.source.content:'';
    const block=diff?`<pre class="ss-code" tabindex="0" aria-label="What changed">${diffMarkup(diff)}</pre>`:code?`<pre class="ss-code" tabindex="0" aria-label="The code">${escape(code)}</pre>`:'';
    return `<section class="ss-review" role="group" aria-labelledby="ss-review-title"><h3 id="ss-review-title" tabindex="-1" data-ss-focus>${changed?'Changed since you approved it':'This version has not run before'}</h3><p>${changed?'Read what changed before it runs again.':'Read the code before it runs for the first time. It only asks once for each version.'}</p>${block}${plain(script.source) && script.source.truncated?'<p class="ss-quiet">Only the first part of the code is shown.</p>':''}<div class="ss-actions"><button type="button" class="primary-button" data-ss-act="confirm-run"${st.running?' disabled':''}>${st.running?'Running…':'Review done — run it'}</button><button type="button" class="secondary-button" data-ss-act="cancel-review"${st.running?' disabled':''}>Cancel</button></div></section>`;
  }
  function result(res){
    if(!plain(res))return '';
    const status=res.status==='succeeded'?'Finished successfully':res.status==='timed_out' || res.timedOut?'Timed out':`Failed${Number.isInteger(res.exitCode)?` (exit code ${res.exitCode})`:''}`;
    const bits=[status,seconds(res.durationMs),where(res.backend)].filter(Boolean);
    const out=typeof res.output==='string'?res.output:[res.stdout,res.stderr].filter(value=>typeof value==='string' && value).join('\n');
    return `<section class="ss-result${res.status==='succeeded'?' ok':' bad'}" role="status" aria-live="polite"><p class="ss-result-line"><strong>${escape(bits.join(' · '))}</strong> · 0 model calls</p>${res.sandboxUnavailable?'<p class="ss-quiet">The sandbox was not available, so this ran on this computer.</p>':''}${out.trim()?`<pre class="ss-output" tabindex="0" aria-label="Output">${escape(out.slice(0,20000))}</pre>`:'<p class="ss-quiet">It printed nothing.</p>'}${res.truncated?'<p class="ss-quiet">The output was cut short.</p>':''}</section>`;
  }
  function history(script,st){
    const items=(Array.isArray(script.history)?script.history:[]).filter(plain).slice(0,20);
    if(!items.length)return '<section class="ss-section"><h3>Runs</h3><p class="ss-quiet">No runs yet.</p></section>';
    const rows=items.map((run,index)=>{
      const key=`run-${index}`,line=[ago(run.at),`started by ${WHO[run.startedBy] || 'someone'}`,STATUS[run.status] || '',seconds(run.durationMs),where(run.backend)].filter(Boolean).map(part=>`<span>${escape(part)}</span>`).join('');
      const out=typeof run.output==='string'?run.output:'';
      return `<li><details data-ss-key="${key}"${st.open[key]?' open':''}><summary>${line}</summary>${out.trim()?`<pre class="ss-output" tabindex="0">${escape(out.slice(0,2000))}</pre>`:'<p class="ss-quiet">It printed nothing.</p>'}</details></li>`;
    }).join('');
    return `<section class="ss-section"><h3>Runs</h3><ul class="ss-runs">${rows}</ul></section>`;
  }
  function versionLine(script,st){
    const version=typeof script.version==='string'?script.version.slice(0,12):'';
    const approved=script.approvedVersion?(script.approvedVersion===script.version?`approved by you${day(script.approvedAt)?` on ${day(script.approvedAt)}`:''}`:'a different version was approved'):'not approved yet';
    const button=script.approvedVersion?`<button type="button" class="text-button ss-text" data-ss-act="revoke-ask"${st.revoking?' hidden':''}>Remove approval</button>`:'';
    const confirm=st.revoking?`<span class="ss-confirm" role="group" aria-label="Remove approval"><span>Remove approval? It will ask for a review again before the next run.</span> <button type="button" class="secondary-button ss-small" data-ss-act="revoke-yes" data-ss-focus>Remove approval</button> <button type="button" class="text-button ss-text" data-ss-act="revoke-no">Keep it</button></span>`:'';
    return `<p class="ss-version">${version?`Version ${escape(version)} · `:''}${escape(approved)} ${button}${confirm}</p>`;
  }
  function detail(script,st,env){
    const issue=problem(script),used=routines(script);
    const source=plain(script.source) && typeof script.source.content==='string'?script.source:null;
    const code=source?`<details class="ss-section ss-codeblock" data-ss-key="code"${st.open.code?' open':''}><summary>View code</summary><p class="ss-quiet">${escape(text(source.path,200))} · read-only</p><pre class="ss-code" tabindex="0">${escape(source.content)}</pre>${source.truncated?'<p class="ss-quiet">Only the first part of the file is shown.</p>':''}</details>`:'';
    const usedBy=used.length?`<section class="ss-section"><h3>Used by</h3><ul class="ss-used">${used.map(item=>`<li><button type="button" class="text-button ss-text" data-nav="/routines">${escape(text(item.name,120))}</button></li>`).join('')}</ul></section>`:'';
    return `<article class="glass-card bp-script-detail ss-detail" data-ss-script="${escape(script.id)}"><header><h2>${escape(titleOf(script))}</h2><p>${escape(text(script.purpose,400) || 'No description yet')}</p>${issue?`<p class="ss-state ${issue.tone}">${escape(issue.text)}</p>`:''}<p class="ss-meta">${escape(runLine(script))}</p></header>${st.review?review(script,st):`${form(script,st,env)}${result(st.result)}`}${history(script,st)}${usedBy}${code}${versionLine(script,st)}</article>`;
  }
  function welcome(icon){return `<section class="glass-card bp-script-detail ss-detail ss-welcome">${icon('code')}<h2>Pick a script</h2><p>Choose one to fill in its inputs and run it, or to see when it last ran.</p></section>`;}

  /** The whole Scripts tab. Returns '' when the data is not usable, so bot-profile.js falls back to its older markup. */
  function panel(bot,v,env){
    if(!plain(bot) || !plain(v) || !Array.isArray(v.scripts) || !env || typeof env.api!=='function' || typeof env.icon!=='function')return '';
    contexts.set(bot.id,{bot,v,env});
    const icon=env.icon,items=v.scripts.filter(valid);
    const toolbar=`<div class="bp-toolbar"><label class="bp-search">${icon('search')}<input type="search" data-profile-input="script-query" value="${escape(v.scriptQuery || '')}" placeholder="Search scripts" aria-label="Search scripts" autocomplete="off"></label><button type="button" class="secondary-button" data-profile-action="script-folder">${icon('folder')}Browse script files</button></div>`;
    if(!items.length)return `${v.scriptsError?`<p class="bp-limit" role="alert">${escape(v.scriptsError)}</p>`:''}${empty(icon)}`;
    const query=String(v.scriptQuery || '').toLowerCase().trim();
    const shown=items.filter(script=>!query || `${titleOf(script)} ${text(script.purpose,240)}`.toLowerCase().includes(query));
    const rows=shown.map(script=>listRow(script,{v,icon})).join('');
    let right=welcome(icon);
    if(v.scriptTarget){
      if(v.scriptLoading)right=`<section class="glass-card bp-script-detail ss-detail"><p class="ss-quiet" role="status">Opening the script…</p></section>`;
      else if(v.scriptError || !valid(v.script) || v.script.id!==v.scriptTarget)right=`<section class="glass-card bp-script-detail ss-detail"><p class="bp-form-error" role="alert">${escape(v.scriptError || 'This script is unavailable.')}</p><button type="button" class="secondary-button" data-profile-action="retry-script">Try again</button></section>`;
      else right=detail(v.script,stateOf(bot.id,v.script.id),env);
    }
    return `<div class="ss-root" data-ss-bot="${escape(bot.id)}">${toolbar}${v.scriptsError?`<p class="bp-limit" role="alert">${escape(v.scriptsError)}</p>`:''}<div class="bp-scripts-layout"><div class="glass-card bp-script-list ss-list" aria-label="Saved scripts">${rows || '<p class="bp-muted">No scripts match this search.</p>'}</div>${right}</div>${v.scriptsTruncated?'<p class="bp-limit">Only some scripts are listed. Browse the script files to see the rest.</p>':''}</div>`;
  }

  /* ---- behaviour ---- */
  const base=(bot,id)=>`/api/bots/${enc(bot.id)}/scripts/${enc(id)}`;
  function rerender(botId){
    const c=contexts.get(botId);if(!c)return;
    c.env.refresh?.(botId);
    const root=[...document.querySelectorAll('.ss-root')].find(node=>node.dataset.ssBot===botId);
    root?.querySelector('[data-ss-focus]')?.focus?.();
  }
  /** Fetches the list and the open script again without the tab's loading state. */
  async function reloadData(c,id){
    const {bot,v,env}=c;
    try{
      const [list,one]=await Promise.all([env.api(`/api/bots/${enc(bot.id)}/scripts`),env.api(base(bot,id))]);
      if(Array.isArray(list?.scripts)){v.scripts=list.scripts;v.scriptsTruncated=Boolean(list.truncated);v.scriptsAt=Date.now();}
      if(valid(one) && v.scriptTarget===id)v.script=one;
    }catch{}
  }
  async function run(botId,approve=false){
    const c=contexts.get(botId);if(!c)return;
    const {bot,v,env}=c,script=v.script;if(!valid(script) || v.scriptTarget!==script.id)return;
    const st=stateOf(bot.id,script.id);if(st.running)return;
    const list=named(script),inputs={};
    if(list.length){
      for(const field of list){
        const value=Object.hasOwn(st.inputs,field.name)?st.inputs[field.name]:field.default===undefined||field.default===null?'':String(field.default);
        if(value.trim()!=='')inputs[field.name]=value;
        else if(field.required===true && (field.default===undefined || field.default===null)){st.error=`Fill in “${text(field.name,64)}” to run this script.`;st.notice='';rerender(bot.id);return;}
      }
    }
    const args=list.length?[]:st.args.split('\n').map(line=>line.replace(/\r$/,'')).filter(line=>line.trim()!=='');
    if(args.length>30 || args.some(item=>item.length>2000)){st.error='Use at most 30 arguments, each up to 2,000 characters.';rerender(bot.id);return;}
    if(!approve && script.needsApproval){st.review=true;st.error='';st.notice='';rerender(bot.id);return;}
    const sent=script.version;
    const body={action:'run',version:sent,...(list.length && Object.keys(inputs).length?{inputs}:{}),...(args.length?{args}:{}),...(approve?{approve:true}:{})};
    st.running=true;st.error='';st.notice='';st.result=null;rerender(bot.id);
    try{
      const res=await env.api(base(bot,script.id),{method:'POST',body});
      st.running=false;st.review=null;st.result=plain(res)?res:null;
      await reloadData(c,script.id);
    }catch(error){
      st.running=false;
      const message=text(env.errorText?env.errorText(error):error?.message,300);
      if(error?.status===428){st.review=true;await reloadData(c,script.id);}
      else if(error?.status===409){
        await reloadData(c,script.id);
        if(contexts.get(bot.id)?.v.script?.version!==sent){st.review=null;st.result=null;st.notice='This script changed. Review the new version.';}
        else st.error=message || 'This bot is busy right now. Try again in a moment.';
      }else{st.error=message || 'The script could not be run.';if(st.review)st.review=null;}
    }
    rerender(bot.id);
  }
  async function revoke(botId){
    const c=contexts.get(botId);if(!c)return;
    const {bot,v,env}=c,script=v.script;if(!valid(script))return;
    const st=stateOf(bot.id,script.id);
    try{
      await env.api(base(bot,script.id),{method:'POST',body:{action:'revoke',...(script.approvedVersion?{version:script.approvedVersion}:{})}});
      st.revoking=false;st.notice='Approval removed. The next run will ask you to review it.';st.error='';
      await reloadData(c,script.id);
    }catch(error){st.revoking=false;st.error=text(env.errorText?env.errorText(error):error?.message,300) || 'Could not remove the approval.';}
    rerender(bot.id);
  }
  function ownerOf(element){
    const page=element.closest?.('.bot-profile'),botId=page?.dataset?.profileBot,c=botId?contexts.get(botId):null;
    const script=c?.v.script;return c && valid(script)?{botId,c,st:stateOf(botId,script.id)}:null;
  }
  document.addEventListener?.('click',event=>{
    const button=event.target?.closest?.('[data-ss-act]');if(!button)return;
    const o=ownerOf(button);if(!o)return;
    const act=button.dataset.ssAct;
    if(act==='confirm-run'){event.preventDefault();run(o.botId,true);}
    else if(act==='cancel-review'){o.st.review=null;rerender(o.botId);}
    else if(act==='revoke-ask'){o.st.revoking=true;rerender(o.botId);}
    else if(act==='revoke-no'){o.st.revoking=false;rerender(o.botId);}
    else if(act==='revoke-yes'){event.preventDefault();revoke(o.botId);}
  });
  document.addEventListener?.('submit',event=>{
    const form=event.target?.closest?.('[data-ss-form]');if(!form)return;
    event.preventDefault();const o=ownerOf(form);if(o)run(o.botId,false);
  });
  document.addEventListener?.('input',event=>{
    const target=event.target;if(!target?.dataset)return;
    if(target.dataset.ssInput===undefined && target.dataset.ssArgs===undefined)return;
    const o=ownerOf(target);if(!o)return;
    if(target.dataset.ssArgs!==undefined)o.st.args=target.value;else o.st.inputs[target.dataset.ssInput]=target.value;
    o.st.error='';
  });
  // toggle does not bubble; the capture phase still sees it. Open blocks stay open when the tab redraws.
  document.addEventListener?.('toggle',event=>{
    const details=event.target;if(!details?.matches?.('details[data-ss-key]'))return;
    const o=ownerOf(details);if(o)o.st.open[details.dataset.ssKey]=details.open;
  },true);

  /* ---- the chat card ---- */
  const DISMISS_KEY='tupies.scriptSuggestions.dismissed',MAX_DISMISSED=100;
  const dismissed=()=>{try{const list=JSON.parse(sessionStorage.getItem(DISMISS_KEY) || '[]');return Array.isArray(list)?list.filter(item=>typeof item==='string'):[];}catch{return [];}};
  function remember(key){
    if(!key)return;const list=dismissed().filter(item=>item!==key);list.push(key);
    try{sessionStorage.setItem(DISMISS_KEY,JSON.stringify(list.slice(-MAX_DISMISSED)));}catch{}
  }
  function suggestion(record,{botId='',messageKey=''}={}){
    if(!plain(record) || record.reason!=='repeated_commands' || !Number.isSafeInteger(record.commands) || record.commands<1)return '';
    if(messageKey && dismissed().includes(messageKey))return '';
    const n=Math.min(record.commands,999);
    return `<div class="script-suggestion" role="note" aria-label="Save this as a script"><p>You ran ${count(n,'command','commands')} for this. Save it as a script so next time it runs in seconds without the model.</p><div class="script-suggestion-actions"><button type="button" class="script-suggestion-save" data-ss-save data-bot-id="${escape(botId)}" data-message-key="${escape(messageKey)}" data-save-text="${escape(SAVE_REQUEST)}">Save as a script</button><button type="button" class="script-suggestion-dismiss" data-ss-dismiss data-message-key="${escape(messageKey)}">Not now</button><span class="script-suggestion-status" role="status"></span></div></div>`;
  }
  /** Same rules as "Ask to redo": send through the chat's own submit path only when the box is free; otherwise fill the box. */
  function save(button){
    const message=button.dataset.saveText || '',botId=button.dataset.botId || '',status=button.parentElement?.querySelector('.script-suggestion-status');
    const say=value=>{if(status)status.textContent=value;};
    const form=document.getElementById('message-form'),field=form?.querySelector('#message-input');
    if(message!==SAVE_REQUEST)return;
    if(!form || !field || form.dataset.id!==botId){say('Open the chat with this bot to save it as a script.');return;}
    const direction=form.querySelector('[data-action="send-direction"]'),send=form.querySelector('.send'),attached=document.getElementById('composer-attachments')?.querySelector('.attachment-chip,.attachment-uploading');
    const busy=(direction && !direction.hidden) || !send || send.disabled || send.hidden;
    if(field.value.trim() || attached || busy || typeof form.requestSubmit!=='function'){
      field.value=field.value.trim()?`${field.value.replace(/\s+$/,'')}\n\n${message}`:message;
      field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();
      say(busy?'Added to the message box. Send it when the current task has finished.':'Added to the message box. Review it and send.');
      return;
    }
    field.value=message;field.dispatchEvent(new Event('input',{bubbles:true}));
    button.disabled=true;setTimeout(()=>{button.disabled=false;},3000);say('Sending…');
    form.requestSubmit(send);
  }
  document.addEventListener?.('click',event=>{
    const saveButton=event.target?.closest?.('[data-ss-save]');
    if(saveButton){if(!saveButton.disabled){event.preventDefault();save(saveButton);}return;}
    const dismiss=event.target?.closest?.('[data-ss-dismiss]');
    if(dismiss){event.preventDefault();remember(dismiss.dataset.messageKey);dismiss.closest('.script-suggestion')?.remove();}
  });

  window.StudioScripts={panel,suggestion,SAVE_REQUEST,_internals:{problem,runLine,where,ago}};
})();
