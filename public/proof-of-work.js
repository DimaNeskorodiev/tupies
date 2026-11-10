/* What the engine saw a finished task do: one quiet line under the reply, and a short list when something needs a look.
   Every number comes from the engine's record; nothing is read from the reply. "Ask to redo" sends only when the owner clicks. */
(()=>{
  const escape=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const whole=value=>Number.isSafeInteger(value) && value>0?Math.min(value,9999):0;
  const CHECKED=[
    ['filesSaved','file saved','files saved'],['filesRemoved','file removed','files removed'],['sourcesRead','source read','sources read'],
    ['searches','search','searches'],['commandsRan','command ran','commands ran'],['checksPassed','check passed','checks passed'],
    ['teammatesVerified','teammate result confirmed','teammate results confirmed'],['memorySaved','memory saved','memories saved'],
    ['integrationCalls','call to a connected app','calls to connected apps'],['otherActions','other step done','other steps done'],
  ];
  const ATTENTION=[
    ['commandsFailed','command failed','commands failed'],['actionsFailed','action did not go through','actions did not go through'],
    ['unknownResults','action with an unknown result','actions with an unknown result'],['interrupted','step was interrupted','steps were interrupted'],
    ['checksFailed','check did not pass','checks did not pass'],['deliverablesMissing','teammate result not confirmed','teammate results not confirmed'],
  ];
  const NOTES=[['couldNotRead','source could not be read','sources could not be read'],['refused','action was refused','actions were refused']];
  const TOOLS={shell_run:'Command',terminal:'Command',execute_code:'Code run',skills_run:'Skill script',scripts_run:'Script',shell_read:'Background command',shell_start:'Background command',
    workspace_write:'File save',workspace_edit:'File edit',workspace_delete:'File removal',documents_create:'Document',http_fetch:'Web request',web_extract:'Web page read',
    integration_call:'Connected app call',delegate_task:'Teammate task',post_message:'Message',memory_set:'Memory',brain_write:'Note',brain_append:'Note',
    browser_click:'Browser click',browser_fill:'Browser form',browser_type:'Browser typing',browser_open:'Web page',browser_upload:'Browser upload',browser_download:'Download'};
  const KINDS={command_failed:'Failed',action_failed:'Did not go through',unknown_result:'Result unknown',interrupted:'Interrupted',check_failed:'Check did not pass',deliverable_missing:'Teammate result not confirmed'};
  const toolLabel=tool=>typeof tool==='string' && /^[a-z][a-z0-9_]{0,63}$/.test(tool)?TOOLS[tool] || tool.replace(/_/g,' ').replace(/^./,char=>char.toUpperCase()):'Step';
  const clean=value=>typeof value==='string' && value.length<=240 && !/[\x00-\x1f\x7f]/.test(value)?value.slice(0,160):'';
  const counts=(group,labels)=>labels.flatMap(([key,one,many])=>{const count=whole(group?.[key]);return count?[`${count} ${count===1?one:many}`]:[];});
  function valid(proof){return proof && typeof proof==='object' && !Array.isArray(proof) && ['checked','attention'].includes(proof.status);}
  function items(proof){return (Array.isArray(proof.items)?proof.items:[]).slice(0,8).filter(item=>item && typeof item==='object' && KINDS[item.kind]);}
  function itemText(item){
    if(item.kind==='check_failed')return `${KINDS.check_failed}${clean(item.checkId)?`: ${clean(item.checkId)}`:''}`;
    if(item.kind==='deliverable_missing')return KINDS.deliverable_missing;
    return `${KINDS[item.kind]}: ${toolLabel(item.tool)}${clean(item.path)?` · ${clean(item.path)}`:''}`;
  }
  /** The follow-up the owner sends with "Ask to redo": exactly the listed items, with what the bot needs to find them. */
  function redoText(proof){
    if(!valid(proof) || proof.status!=='attention')return '';
    const lines=items(proof).map(item=>{
      const ref=[typeof item.tool==='string' && /^[a-z][a-z0-9_]{0,63}$/.test(item.tool)?item.tool:'',/^[\w.:-]{1,120}$/.test(item.callId || '')?`call ${item.callId}`:'',clean(item.path)].filter(Boolean).join(', ');
      if(item.kind==='check_failed')return `- A check did not pass${/^[\w-]{1,64}$/.test(item.checkId || '')?`: ${item.checkId}`:''}. Fix the work and run the check again.`;
      if(item.kind==='deliverable_missing')return `- A required teammate result was not confirmed${/^[\w.:-]{1,120}$/.test(item.deliverableId || '')?` (${item.deliverableId})`:''}. Get it repaired and confirmed.`;
      if(item.kind==='unknown_result' || item.kind==='interrupted')return `- ${KINDS[item.kind]} (${ref || 'step'}). It may or may not have happened: check the current state first and only redo it if it did not happen.`;
      return `- ${KINDS[item.kind]} (${ref || 'step'}). Find out why and redo it.`;
    });
    const more=Object.values(proof.attention || {}).reduce((sum,value)=>sum+whole(value),0)-lines.length;
    return ['Please re-check your last task and redo what did not work. The engine recorded:',...lines,...(more>0?[`- ${more} more item${more===1?'':'s'} in your work records for that task.`]:[]),'Look at your work records for these calls before acting, do not repeat anything that already worked, and tell me what you verified.'].join('\n').slice(0,3800);
  }
  function footer(proof,{botId='',messageKey=''}={}){
    if(!valid(proof))return '';
    const done=counts(proof.checked,CHECKED),notes=counts(proof.notes,NOTES);
    if(proof.status==='checked'){
      if(!done.length && !notes.length)return '';
      const parts=[...done.map(part=>`<span>${escape(part)}</span>`),...notes.map(part=>`<span class="proof-note">${escape(part)}</span>`)].join('');
      return `<div class="proof-of-work checked" role="note" aria-label="${escape(`Checked by Tupies: ${[...done,...notes].join(', ')}`)}"><span class="proof-mark" aria-hidden="true"></span><span class="proof-lead">Checked:</span>${parts}</div>`;
    }
    const problems=counts(proof.attention,ATTENTION);if(!problems.length)return '';
    const list=items(proof).map(item=>`<li>${escape(itemText(item))}</li>`).join('');
    const also=done.length?`<p>Also checked: ${escape(done.join(' · '))}</p>`:'';
    const noted=notes.length?`<p>${escape(notes.join(' · '))}</p>`:'';
    const redo=redoText(proof);
    return `<details class="proof-of-work attention"><summary aria-label="${escape(`Needs a look: ${problems.join(', ')}`)}"><span class="proof-mark" aria-hidden="true"></span><span class="proof-lead">Needs a look:</span>${problems.map(part=>`<span>${escape(part)}</span>`).join('')}</summary><div class="proof-detail">${list?`<ul>${list}</ul>`:''}${also}${noted}${redo?`<div class="proof-actions"><button type="button" class="proof-redo" data-proof-redo data-bot-id="${escape(botId)}" data-message-key="${escape(messageKey)}" data-redo-text="${escape(redo)}">Ask to redo</button><span class="proof-status" role="status"></span></div>`:''}</div></details>`;
  }
  /** Sends through the chat's own submit path when the box is free; otherwise puts the text in the box for review. */
  function redo(button){
    const text=button.dataset.redoText || '',botId=button.dataset.botId || '',status=button.parentElement?.querySelector('.proof-status');
    const say=message=>{if(status)status.textContent=message;};
    const form=document.getElementById('message-form'),field=form?.querySelector('#message-input');
    if(!text)return;
    if(!form || !field || form.dataset.id!==botId){say('Open the chat with this bot to ask for a redo.');return;}
    const direction=form.querySelector('[data-action="send-direction"]'),send=form.querySelector('.send'),attached=document.getElementById('composer-attachments')?.querySelector('.attachment-chip,.attachment-uploading');
    const busy=(direction && !direction.hidden) || !send || send.disabled || send.hidden;
    if(field.value.trim() || attached || busy || typeof form.requestSubmit!=='function'){
      field.value=field.value.trim()?`${field.value.replace(/\s+$/,'')}\n\n${text}`:text;
      field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();
      say(busy?'Added to the message box. Send it when the current task has finished.':'Added to the message box. Review it and send.');
      return;
    }
    field.value=text;field.dispatchEvent(new Event('input',{bubbles:true}));
    // The pause only absorbs a double tap; the chat's own send path reports a failure and keeps the text in the box.
    button.disabled=true;setTimeout(()=>{button.disabled=false;},3000);say('Sending…');
    form.requestSubmit(send);
  }
  document.addEventListener?.('click',event=>{const button=event.target?.closest?.('[data-proof-redo]');if(!button || button.disabled)return;event.preventDefault();redo(button);});
  window.StudioProof={footer,redoText};
})();
