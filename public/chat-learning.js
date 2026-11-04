/* Verified save receipts. No model text/HTML, timers or polling own this UI. */
(()=>{
  const seen=new Set(),followed=new Set(),escape=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const paths={brain:'M12 5a3 3 0 0 0-5-2 4 4 0 0 0-4 6 4 4 0 0 0 0 6 4 4 0 0 0 4 6 3 3 0 0 0 5-2V5Zm0 0a3 3 0 0 1 5-2 4 4 0 0 1 4 6 4 4 0 0 1 0 6 4 4 0 0 1-4 6 3 3 0 0 1-5-2M7 8c3 0 3 4 0 4m10-4c-3 0-3 4 0 4M7 17h1m8 0h1',memory:'M8 3h8l-1 6 4 5H5l4-5-1-6Zm4 11v7',skill:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z'};
  function rows(value){return Array.isArray(value)?value.filter(row=>row && typeof row.id==='string' && row.id.length<=180 && Object.hasOwn(paths,row.kind) && ['saved','installed','suggested'].includes(row.status)).slice(0,24):[];}
  const title=row=>row.status==='suggested'?(row.kind==='skill'?'Skill suggested':'Memory suggested'):row.kind==='brain'?'Saved to Brain':row.kind==='memory'?'Memory updated':row.status==='installed'?'Skill added':'Skill created';
  function render(value,botId){
    const items=rows(value);if(!items.length)return '';
    return `<div class="chat-learning" role="group" aria-label="What this task saved">${items.map(row=>{
      const tab=row.status==='suggested'?'learning':row.kind==='skill'?'skills':row.kind,href=tab==='skills'?`#/skills/${encodeURIComponent(botId)}`:`#/bots/${encodeURIComponent(botId)}/${tab}`;
      return `<a class="learning-chip is-${row.kind}${row.status==='suggested'?' is-suggestion':''}" href="${escape(href)}" data-message-key="${escape(row.id)}" data-learning-id="${escape(row.id)}" data-learning-at="${escape(row.createdAt)}" aria-label="${escape(title(row)+': '+String(row.label || '').slice(0,160)+'. Open '+tab)}"><span class="learning-glyph"><svg viewBox="0 0 24 24" aria-hidden="true"><path pathLength="1" d="${paths[row.kind]}"/></svg><span class="learning-check" aria-hidden="true">${row.status==='suggested'?'·':'✓'}</span></span><span class="learning-copy"><strong>${title(row)}</strong><span>${escape(String(row.label || '').slice(0,160))}</span></span><svg class="learning-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg></a>`;
    }).join('')}</div>`;
  }
  function mount(root,{liveRunId,active=false}={}){
    const live=active || followed.has(liveRunId);if(active&&liveRunId)followed.add(liveRunId);
    const announcements=[];
    for(const node of root.querySelectorAll('[data-learning-id]')){
      const id=node.dataset.learningId;if(seen.has(id))continue;seen.add(id);
      const age=Date.now()-Date.parse(node.dataset.learningAt);
      if(live && liveRunId && id.startsWith(`${liveRunId}:learning:`) && age>=0 && age<60000 && !document.hidden){
        node.classList.add('is-arriving');node.addEventListener('animationend',()=>node.classList.remove('is-arriving'),{once:true});
        announcements.push(node.querySelector('strong')?.textContent || 'Saved');
      }
    }
    while(followed.size>500)followed.delete(followed.values().next().value);
    while(seen.size>2000)seen.delete(seen.values().next().value);
    if(announcements.length){
      let status=root.querySelector('[data-learning-announcer]');
      if(!status){status=document.createElement('span');status.className='learning-sr';status.dataset.learningAnnouncer='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.append(status);}
      status.textContent=[...new Set(announcements)].join('. ');
    }
  }
  window.StudioChatLearning={render,mount};
})();
