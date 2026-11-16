/* One provider + model picker for Bot settings and the chat composer's model panel.
   - providerChoices() turns saved connections into distinguishable labels and marks the ones that can't run tasks
     (for example an unfinished ChatGPT sign-in) as an explicit error instead of a normal choice.
   - markup()/attach() render a native provider <select> plus an accessible model combobox: search by name and id,
     listbox/option roles with aria-activedescendant, ArrowUp/Down, Home/End, Enter, Escape, and loading, empty and
     error (with retry) states.
   Two modes: in a form (Bot settings) a choice fills the named fields and the form's Save button saves it; with
   onSelect (the chat panel) a choice is saved at once and the picker shows what the engine returned, or restores the
   previous value when the save fails. The engine stays the authority: models come from the provider's live catalog
   and every save is validated there. */
(()=>{
  'use strict';
  const esc=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const fold=value=>String(value ?? '').toLocaleLowerCase();
  const MAX_ROWS=200;
  const controllers=new WeakMap();
  let context={connections:()=>[],catalog:()=>[],loadModels:null,icon:()=>''};

  /* ---- providers ---- */
  function providerName(type){const meta=context.catalog().find(item=>item.type===type);return meta?.name||(type==='legacy-hermes'?'Previous Hermes gateway':String(type||'Model provider'));}
  /** Mirrors lib/providers.mjs connectionProblem() with the fields the browser can see. '' means usable. */
  function providerProblem(connection){
    if(!connection||!connection.type)return 'This provider is missing. Choose another one.';
    if(connection.type==='legacy-hermes')return 'This old Hermes gateway can’t run tasks. Replace it with a direct provider.';
    if(connection.type==='chatgpt'){
      if(connection.oauthBlocked)return 'This ChatGPT sign-in belongs to another engine. Sign in again here in Settings → Providers.';
      if(!connection.hasOAuth)return connection.oauthAccount?.subject?'Signed out of ChatGPT. Sign in again in Settings → Providers.':'ChatGPT sign-in was never finished. Finish it in Settings → Providers.';
      if(connection.oauthAccount?.needsLogin)return 'ChatGPT access expired. Sign in again in Settings → Providers.';
      if(!connection.oauthAccount?.planEnabled)return 'ChatGPT plan usage was not approved. Sign in again in Settings → Providers.';
      return '';
    }
    const meta=context.catalog().find(item=>item.type===connection.type);
    if(meta?.auth==='api-key'&&connection.type!=='custom'&&!connection.hasKey)return 'This provider’s API key is missing. Add it in Settings → Providers.';
    return '';
  }
  const problemTag=problem=>/API key/.test(problem)?'needs API key':/another engine/.test(problem)?'signed in on another engine':/never finished/.test(problem)?'sign-in not finished':/Hermes/.test(problem)?'needs replacing':'needs sign-in';
  const addedOn=iso=>{const time=Date.parse(iso);return Number.isFinite(time)?`added ${new Date(time).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}`:'';};
  /** Saved connections as picker choices. Same-looking entries get an account, date or id hint so they never look identical. */
  function providerChoices(connections=context.connections()){
    const rows=(Array.isArray(connections)?connections:[]).filter(item=>item&&item.id&&item.type!=='legacy-hermes').map(connection=>{
      const kind=providerName(connection.type),name=String(connection.name||kind),problem=providerProblem(connection);
      return {id:connection.id,type:connection.type,name,providerName:kind,base:fold(name)===fold(kind)?name:`${name} · ${kind}`,account:String(connection.oauthAccount?.email||''),createdAt:connection.createdAt||'',problem,usable:!problem,warning:!problem&&connection.status==='error'?'last check failed':''};
    });
    const groups=new Map();for(const row of rows)groups.set(fold(row.base),[...(groups.get(fold(row.base))||[]),row]);
    for(const group of groups.values())for(const row of group){
      const hints=[];
      if(group.length>1){
        if(row.account)hints.push(row.account);
        const twins=group.filter(other=>other!==row&&other.account===row.account);
        if(twins.length){const date=addedOn(row.createdAt);hints.push(date&&!twins.some(other=>addedOn(other.createdAt)===date)?date:`#${row.id.slice(-6)}`);}
      }
      row.hint=hints.join(' · ');
      row.title=[row.base,row.hint].filter(Boolean).join(' · ');
      row.label=row.title+(row.problem?` — ${problemTag(row.problem)}`:row.warning?` — ${row.warning}`:'');
    }
    return rows;
  }
  function providerLabel(connectionId,connections){return providerChoices(connections).find(item=>item.id===connectionId)?.label||'';}

  /* ---- model names ---- */
  const cachedModels=connectionId=>(context.connections().find(item=>item.id===connectionId)?.models||[]).filter(item=>item&&typeof item.id==='string');
  const modelName=(connectionId,model,models)=>((models||cachedModels(connectionId)).find(item=>item.id===model)?.name)||model;
  const defaultModelOf=(connectionId,catalog)=>catalog?.defaultModel||context.connections().find(item=>item.id===connectionId)?.defaultModel||'';
  function modelDisplay(connectionId,model,catalog){
    if(model)return modelName(connectionId,model,catalog?.models);
    const fallback=defaultModelOf(connectionId,catalog);return fallback?`Provider default · ${modelName(connectionId,fallback,catalog?.models)}`:'Provider default';
  }
  function savedLine(connectionId,model,catalog){
    if(!connectionId)return 'No provider chosen yet.';
    const provider=providerChoices().find(item=>item.id===connectionId),missing=model&&catalog&&!catalog.models.some(item=>item.id===model),name=modelDisplay(connectionId,model,catalog);
    return `Saved: <strong>${esc(provider?.title||'Unavailable provider')}</strong> · ${esc(name)}${model&&name!==model?` <small>${esc(model)}</small>`:''}${missing?' <small class="mp-warning">not in this provider’s current list</small>':''}`;
  }

  /* ---- markup ---- */
  /** Static markup so a form has its named fields at once; attach() adds behaviour on first use. */
  function markup({id='model-picker',connectionId='',model='',connectionName='',modelName:fieldName='',allowNone=false,inline=false,label='Model provider',note='',lockedReason=''}={}){
    const choices=providerChoices(),current=choices.find(item=>item.id===connectionId);
    const options=`${allowNone?`<option value="" ${connectionId?'':'selected'}>Choose later</option>`:connectionId?'':'<option value="" selected disabled>Choose a provider</option>'}${choices.map(item=>`<option value="${esc(item.id)}"${item.id===connectionId?' selected':''}${item.usable?'':' disabled'}>${esc(item.label)}</option>`).join('')}${connectionId&&!current?`<option value="${esc(connectionId)}" selected disabled>Unavailable provider — choose another</option>`:''}`;
    const problem=current?.problem||(connectionId&&!current?'This provider was removed. Choose another one.':'');
    const unusable=!connectionId||!!problem;
    return `<div class="model-picker${inline?' is-inline':''}" data-model-picker data-picker-id="${esc(id)}" data-saved-connection="${esc(connectionId)}" data-saved-model="${esc(model)}"${inline?' data-inline="true"':''}>
<div class="field mp-provider"><label for="${esc(id)}-connection">${esc(label)}</label><select id="${esc(id)}-connection" class="mp-provider-select"${connectionName?` name="${esc(connectionName)}"`:''} aria-describedby="${esc(id)}-provider-status"${lockedReason?' disabled':''}>${options}</select><p id="${esc(id)}-provider-status" class="mp-provider-status${problem?' is-error':''}" role="${problem?'alert':'status'}">${esc(problem||lockedReason)}</p></div>
<div class="field mp-model"><label id="${esc(id)}-model-label" for="${esc(id)}-model-search">Model</label><div class="mp-combobox"><span class="mp-search-icon" aria-hidden="true">${context.icon('search')}</span><input id="${esc(id)}-model-search" class="mp-search" type="text" role="combobox" aria-autocomplete="list" aria-expanded="${inline}" aria-controls="${esc(id)}-model-list" aria-describedby="${esc(id)}-model-state" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${inline?'Search models by name or id':'Search models'}" value="${inline||unusable?'':esc(modelDisplay(connectionId,model))}"${unusable?' disabled':''}>${inline?'':`<button type="button" class="mp-toggle" tabindex="-1" aria-label="Show models"${unusable?' disabled':''}>${context.icon('chevronDown')}</button>`}</div>${fieldName?`<input type="hidden" id="${esc(id)}-model" class="mp-model-value" name="${esc(fieldName)}" value="${esc(model)}">`:''}
<p class="mp-current" data-mp-current>${savedLine(connectionId,model)}</p>
<ul id="${esc(id)}-model-list" class="mp-list" role="listbox" aria-labelledby="${esc(id)}-model-label"${inline?'':' hidden'}></ul>
<p id="${esc(id)}-model-state" class="mp-state" role="status" aria-live="polite"></p>
<div class="mp-error" role="alert" hidden><p></p><button type="button" class="secondary-button mp-retry">Try again</button></div>
${note?`<p class="mp-note">${esc(note)}</p>`:''}</div></div>`;
  }

  /* ---- behaviour ---- */
  function attach(root,options={}){
    if(!root)return null;const existing=controllers.get(root);if(existing){Object.assign(existing.options,options);return existing;}
    const id=root.dataset.pickerId,$=selector=>root.querySelector(selector);
    const select=$('.mp-provider-select'),input=$('.mp-search'),list=$('.mp-list'),hidden=$('.mp-model-value'),stateLine=$('.mp-state'),errorBox=$('.mp-error'),savedNode=$('[data-mp-current]'),providerStatus=$('.mp-provider-status');
    const inline=root.dataset.inline==='true';
    // server: what the engine has saved. selected: the picker's current value (unsaved until the form is saved in Settings).
    const c={root,options,inline,server:{connectionId:root.dataset.savedConnection||'',model:root.dataset.savedModel||''},selected:{connectionId:select.value,model:hidden?hidden.value:(root.dataset.savedModel||'')},browsing:select.value,catalogs:new Map(),loading:false,error:'',query:'',filtered:[],active:-1,open:inline,request:0,busy:false};
    controllers.set(root,c);
    const catalogFor=connectionId=>c.catalogs.get(connectionId);
    const optionId=index=>`${id}-option-${index}`;
    const connectionOf=connectionId=>context.connections().find(item=>item.id===connectionId);
    const display=()=>c.browsing?modelDisplay(c.browsing,c.selected.connectionId===c.browsing?c.selected.model:'',catalogFor(c.browsing)):'';
    function setProviderStatus(){
      const chosen=providerChoices().find(item=>item.id===select.value),problem=select.value&&!chosen?'This provider was removed. Choose another one.':chosen?.problem||'';
      providerStatus.textContent=problem||c.options.lockedReason||'';providerStatus.classList.toggle('is-error',!!problem);providerStatus.setAttribute('role',problem?'alert':'status');
    }
    function entries(){
      const connectionId=c.browsing,catalog=catalogFor(connectionId),models=catalog?.models||[],fallback=defaultModelOf(connectionId,catalog);
      const rows=[{id:'',name:'Provider default',detail:fallback?`Follows the provider default · ${modelName(connectionId,fallback,models)}`:'Follows the provider’s default model'}];
      if(c.selected.connectionId===connectionId&&c.selected.model&&catalog&&!models.some(item=>item.id===c.selected.model))rows.push({id:c.selected.model,name:c.selected.model,detail:'Not in this provider’s current list',disabled:true});
      for(const item of models)rows.push({id:item.id,name:item.name||item.id,detail:item.name&&item.name!==item.id?item.id:''});
      return rows;
    }
    const isSelected=row=>c.selected.connectionId===c.browsing&&row.id===c.selected.model;
    const isSaved=row=>c.server.connectionId===c.browsing&&row.id===c.server.model;
    function render(){
      const words=fold(c.query).split(/\s+/).filter(Boolean),rows=entries();
      c.filtered=words.length?rows.filter(row=>{const text=fold(`${row.name} ${row.id}`);return words.every(word=>text.includes(word));}):rows;
      const catalog=catalogFor(c.browsing),shown=c.filtered.slice(0,MAX_ROWS),loading=c.loading&&!catalog,error=!catalog&&!c.loading?c.error:'';
      if(c.active>=shown.length)c.active=shown.length-1;
      list.innerHTML=loading||error?'':shown.map((row,index)=>`<li role="option" id="${esc(optionId(index))}" class="mp-option${index===c.active?' is-active':''}${isSelected(row)?' is-current':''}" data-value="${esc(row.id)}" aria-selected="${isSelected(row)}"${row.disabled?' aria-disabled="true"':''}><span><strong>${esc(row.name)}</strong>${row.detail?`<small>${esc(row.detail)}</small>`:''}</span>${isSelected(row)?`<span class="mp-check">${context.icon('check')}<span>${isSaved(row)?'Current':'Selected'}</span></span>`:''}</li>`).join('');
      list.hidden=!(c.open&&!loading&&!error&&c.browsing);
      input.setAttribute('aria-expanded',String(!list.hidden));
      if(c.active>=0&&!list.hidden){input.setAttribute('aria-activedescendant',optionId(c.active));list.children[c.active]?.scrollIntoView?.({block:'nearest'});}else input.removeAttribute('aria-activedescendant');
      const total=catalog?catalog.models.length:0;
      // Counts and empty-search hints describe the open list only; loading and an empty catalog are always shown.
      stateLine.textContent=loading?'Loading models…':!catalog?'':!total&&!c.query?'This provider lists no models. Provider default is still available.':list.hidden?'':!c.filtered.length?`No models match “${c.query.trim()}”. Try part of the name or id.`:c.filtered.length>MAX_ROWS?`Showing ${MAX_ROWS} of ${c.filtered.length}. Keep typing to narrow the list.`:c.query.trim()?`${c.filtered.length} matching`:'';
      stateLine.classList.toggle('is-loading',loading);
      errorBox.hidden=!error;if(error)errorBox.querySelector('p').textContent=`Couldn’t load models. ${error}`;
      root.classList.toggle('is-loading',loading);root.classList.toggle('has-error',!!error);
      savedNode.innerHTML=savedLine(c.server.connectionId,c.server.model,catalogFor(c.server.connectionId));
      if(!inline&&document.activeElement!==input)input.value=display();
      // A save in progress blocks choices but keeps focus in the search field; only an unusable provider disables it.
      const unusable=!c.browsing||!!providerProblem(connectionOf(c.browsing));
      input.disabled=unusable;const toggle=$('.mp-toggle');if(toggle)toggle.disabled=unusable;
      select.disabled=c.busy||!!c.options.lockedReason;
      root.setAttribute('aria-busy',String(c.busy||loading));
    }
    async function load(connectionId,{force=false}={}){
      if(!connectionId||providerProblem(connectionOf(connectionId)))return render();
      if(!force&&catalogFor(connectionId))return render();
      const request=++c.request;c.loading=true;c.error='';render();
      try{
        const loader=c.options.load||context.loadModels;if(!loader)throw new Error('Model lists are unavailable here.');
        const result=await loader(connectionId);if(request!==c.request||!root.isConnected)return;
        const models=(Array.isArray(result?.models)?result.models:[]).filter(item=>item&&typeof item.id==='string'&&item.id).map(item=>({id:item.id,name:String(item.name||item.id)}));
        c.catalogs.set(connectionId,{models,defaultModel:result?.defaultModel||defaultModelOf(connectionId)});
        const connection=connectionOf(connectionId);if(connection&&Array.isArray(result?.models)&&result.models.length)connection.models=result.models;
        root.dispatchEvent(new CustomEvent('modelpickerload',{bubbles:true,detail:{connectionId}}));
      }catch(error){if(request===c.request&&root.isConnected)c.error=error?.message||'The provider didn’t answer.';}
      finally{if(request===c.request){c.loading=false;if(root.isConnected)render();}}
    }
    function setOpen(open){if(inline)open=true;if(c.open!==open){c.open=open;if(!open){c.query='';c.active=-1;}}render();}
    function move(to){if(!c.open)c.open=true;const max=Math.min(c.filtered.length,MAX_ROWS)-1;c.active=max<0?-1:Math.max(0,Math.min(max,to));render();}
    /** Show a value. In a form this fills the named fields and announces the change; markSaved also records it as saved. */
    function set({connectionId,model},{announce=!c.options.onSelect}={}){
      const changed=connectionId!==c.selected.connectionId||model!==c.selected.model;
      c.selected={connectionId,model};c.browsing=connectionId;
      if(select.value!==connectionId){if(![...select.options].some(option=>option.value===connectionId))select.insertAdjacentHTML('beforeend',`<option value="${esc(connectionId)}" disabled>Unavailable provider</option>`);select.value=connectionId;}
      if(hidden)hidden.value=model;
      c.query='';c.active=-1;input.value=inline?'':display();setProviderStatus();render();
      if(changed&&announce&&hidden)hidden.dispatchEvent(new Event('change',{bubbles:true}));
    }
    function markSaved(value){c.server={connectionId:value.connectionId||'',model:value.model||''};root.dataset.savedConnection=c.server.connectionId;root.dataset.savedModel=c.server.model;set(c.server,{announce:false});}
    async function choose(row){
      if(!row||row.disabled||c.busy)return;
      const next={connectionId:c.browsing,model:row.id},previous={...c.selected};
      if(next.connectionId===previous.connectionId&&next.model===previous.model){if(!inline){setOpen(false);input.value=display();}return;}
      if(!c.options.onSelect){set(next);if(!inline)setOpen(false);return;}
      c.busy=true;render();
      try{const saved=await c.options.onSelect(next,previous);if(root.isConnected){markSaved(saved||next);if(!inline)setOpen(false);}}
      catch{if(root.isConnected)set(c.server,{announce:false});}
      finally{c.busy=false;if(root.isConnected)render();}
    }
    /** Re-read the form fields (for example after a restored Bot settings draft). */
    function sync(){c.selected={connectionId:select.value,model:hidden?hidden.value:c.selected.model};c.browsing=select.value;c.query='';c.active=-1;if(!inline)input.value=display();setProviderStatus();render();}

    select.addEventListener('change',()=>{
      c.browsing=select.value;c.query='';c.active=-1;if(inline)input.value='';setProviderStatus();
      // In a form a provider change takes effect at once with its default model; in the chat panel choosing
      // another provider only browses its catalog until a model is picked.
      if(!c.options.onSelect)set({connectionId:select.value,model:''});else render();
      if(c.browsing)void load(c.browsing);
    });
    input.addEventListener('focus',()=>{if(!inline){c.query='';input.select?.();}if(c.browsing)void load(c.browsing);});
    input.addEventListener('input',()=>{c.query=input.value;c.active=c.query.trim()?0:-1;c.open=true;render();});
    input.addEventListener('blur',()=>{if(!inline)window.setTimeout(()=>{if(!root.contains(document.activeElement))setOpen(false);},0);});
    input.addEventListener('keydown',event=>{
      const count=Math.min(c.filtered.length,MAX_ROWS);
      if(event.key==='ArrowDown'){event.preventDefault();move(c.open?c.active+1:Math.max(0,c.active));}
      else if(event.key==='ArrowUp'){event.preventDefault();move(c.active<0?count-1:c.active-1);}
      else if((event.key==='Home'||event.key==='End')&&c.open&&count&&!event.shiftKey){event.preventDefault();move(event.key==='Home'?0:count-1);}
      else if(event.key==='Enter'){event.preventDefault();if(c.open&&c.active>=0)void choose(c.filtered[c.active]);else setOpen(true);}
      else if(event.key==='Escape'){
        // Escape closes the list or clears the search before it reaches an enclosing dialog or panel.
        if(!inline&&c.open){event.preventDefault();event.stopPropagation();setOpen(false);input.value=display();input.select?.();}
        else if(inline&&input.value){event.preventDefault();event.stopPropagation();input.value='';c.query='';c.active=-1;render();}
      }
      else if(event.key==='Tab'&&!inline)setOpen(false);
    });
    list.addEventListener('pointerdown',event=>{if(event.target.closest('.mp-option'))event.preventDefault();});
    list.addEventListener('click',event=>{const option=event.target.closest('.mp-option');if(option)void choose(c.filtered[[...list.children].indexOf(option)]);});
    list.addEventListener('pointermove',event=>{const option=event.target.closest('.mp-option'),index=option?[...list.children].indexOf(option):-1;if(index<0||index===c.active)return;c.active=index;for(const [i,node] of [...list.children].entries())node.classList.toggle('is-active',i===index);input.setAttribute('aria-activedescendant',optionId(index));});
    $('.mp-toggle')?.addEventListener('click',()=>{if(c.open)setOpen(false);else{input.focus();setOpen(true);}});
    errorBox.querySelector('.mp-retry').addEventListener('click',()=>void load(c.browsing,{force:true}));

    Object.assign(c,{value:()=>({...c.selected}),saved:()=>({...c.server}),set,markSaved,restore:()=>set(c.server),sync,render,load,setBusy(busy){c.busy=!!busy;render();},setLocked(reason){c.options.lockedReason=reason||'';setProviderStatus();render();},focus(){input.focus();},catalog:catalogFor});
    setProviderStatus();render();if(c.browsing&&(inline||options.preload))void load(c.browsing);
    return c;
  }
  /* Attach on first use: forms rendered as HTML strings get behaviour when the owner first touches the picker.
     Listeners added here still run for this change/pointer event; focus has already fired before focusin, so it is replayed. */
  function lazy(event){
    const root=event.target?.closest?.('[data-model-picker]');if(!root||controllers.has(root))return;
    attach(root,{});if(event.type==='focusin'&&event.target.matches('.mp-search'))event.target.dispatchEvent(new Event('focus'));
  }
  for(const type of ['focusin','change','pointerdown'])document.addEventListener(type,lazy,true);
  function syncAll(scope=document){for(const root of scope.querySelectorAll('[data-model-picker]'))(controllers.get(root)||attach(root,{})).sync();}

  window.StudioModelPicker={configure(next){context={...context,...next};},providerChoices,providerProblem,providerLabel,markup,attach,syncAll,controller:root=>controllers.get(root)||null};
})();
