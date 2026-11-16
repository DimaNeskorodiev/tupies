/* Connecting a service a bot asked for: the "Connect <service>" card under a reply, the same card in a Settings dialog,
   and the small pieces Settings → Integrations shows (status chips, "Added by", OAuth fields).
   The bot never sees or supplies a credential: the owner types the key or signs in here, and the engine stores it sealed.
   Names, reasons, setup notes and action descriptions of a bot-proposed connection are written by the model: they are
   always escaped, shortened and shown as plain text (no links). Secrets live only in password fields' values while typed;
   they never enter state, markup, attributes, the address bar, storage or logs. */
(()=>{
  'use strict';
  const escape=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const enc=encodeURIComponent;
  const plain=value=>value && typeof value==='object' && !Array.isArray(value);
  const text=(value,max=300)=>{const string=typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,' '):'';return string.length>max?`${string.slice(0,max).trimEnd()}…`:string;};
  const line=(value,max)=>text(value,max).replace(/\s+/g,' ').trim();
  const host=value=>{try{const url=new URL(String(value));return ['https:','http:'].includes(url.protocol)?url.host:'';}catch{return '';}};
  const words=name=>String(name || '').replace(/[_.:-]+/g,' ').trim();
  const POLL_MS=3000,MAX_STATES=40,USED_KEY='tupies.connectionContinue.used';
  const states=new Map(),missing=new Map();
  /** The app's context, read fresh each time: the app replaces its workspace data object on every state refresh. */
  const C=()=>typeof ctxSource==='function'?ctxSource():ctxSource;
  const use=ctx=>{if(ctx)ctxSource=ctx;};
  let ctxSource=null,pollTimer=null,redirect={uri:'',error:'',loading:null};

  /* ---- what an integration needs, in plain words ---- */
  const tools=integration=>[...(Array.isArray(integration?.tools)?integration.tools:[]),...(Array.isArray(integration?.discoveredTools)?integration.discoveredTools:[])].filter(plain);
  /** An MCP server is only useful once its tools were discovered, even when it needs no key. */
  const done=integration=>plain(integration) && integration.ready===true && !(integration.type==='mcp' && !tools(integration).length && integration.status!=='connected');
  /** 'key' | 'oauth' | 'check' — what the owner still has to do. The integration's current sign-in method wins over the request's. */
  function need(integration,how){
    const auth=integration?.authType || (how==='oauth'?'oauth2':how==='none'?'none':'bearer');
    if(auth==='oauth2')return 'oauth';
    if(auth==='none' || integration?.hasKey)return 'check';
    return 'key';
  }
  const reauth=integration=>integration?.status==='needs_reauth' || integration?.oauth?.reauthSuggested===true;
  const by=integration=>line(integration?.proposedBy?.botName || integration?.changedBy?.botName,60);
  const name=integration=>line(integration?.name,60) || 'this service';

  /** Status chip for a Settings row; null keeps the page's own chip. */
  function chip(integration){
    if(!plain(integration))return null;
    if(integration.authType==='oauth2' && integration.status==='needs_reauth')return {text:'Sign in again',tone:'warn'};
    if(integration.ready===false)return integration.authType==='oauth2'?{text:'Needs sign-in',tone:'warn'}:{text:'Needs your key',tone:'warn'};
    if(integration.authType==='oauth2' && integration.oauth?.connected)return {text:'Connected',tone:'ready'};
    return null;
  }

  /* ---- per-integration state, kept across redraws and shared by the chat card and the Settings dialog (bounded) ---- */
  function stateOf(id){
    let st=states.get(id);
    if(st){states.delete(id);states.set(id,st);return st;}
    st={busy:'',error:'',notice:'',clientId:null,paste:'',waiting:null,signInUrl:'',open:{}};
    states.set(id,st);while(states.size>MAX_STATES)states.delete(states.keys().next().value);
    return st;
  }
  const used=()=>{try{const list=JSON.parse(sessionStorage.getItem(USED_KEY) || '[]');return Array.isArray(list)?list.filter(item=>typeof item==='string'):[];}catch{return [];}};
  function markUsed(key){if(!key)return;const list=used().filter(item=>item!==key);list.push(key);try{sessionStorage.setItem(USED_KEY,JSON.stringify(list.slice(-100)));}catch{}}

  /* ---- markup ---- */
  function actionList(integration){
    if(integration.type==='mcp'){const found=tools(integration);return found.length?list(found):'<p class="cr-quiet">Its tools are listed after you connect it.</p>';}
    return list(tools(integration));
    function list(items){
      if(!items.length)return '<p class="cr-quiet">No actions are declared yet.</p>';
      const rows=items.slice(0,10).map(tool=>{
        const method=String(tool.method || '').toUpperCase(),read=method==='GET';
        const kind=integration.type==='mcp'?'':`<span class="cr-kind ${read?'read':'write'}">${read?'Reads':'Makes changes'}</span>`;
        const about=line(tool.description,160);
        return `<li><span class="cr-action"><strong>${escape(line(words(tool.name),60))}</strong>${kind}</span>${about?`<small>${escape(about)}</small>`:''}</li>`;
      }).join('');
      return `<ul class="cr-actions">${rows}</ul>${items.length>10?`<p class="cr-quiet">And ${items.length-10} more.</p>`:''}`;
    }
  }
  function hosts(integration,need){
    const api=host(integration.baseUrl),signIn=host(integration.oauth?.authorizationUrl),token=host(integration.oauth?.tokenUrl);
    if(need==='oauth')return `<p class="cr-hosts">Sign-in happens at <strong>${escape(signIn || 'an unknown address')}</strong>${token && token!==signIn?` (tokens from <strong>${escape(token)}</strong>)`:''}. Requests go only to <strong>${escape(api || 'an unknown address')}</strong>.</p>`;
    if(need==='key')return `<p class="cr-hosts">Sends your key only to <strong>${escape(api || 'an unknown address')}</strong>.</p>`;
    return `<p class="cr-hosts">Connects to <strong>${escape(api || 'an unknown address')}</strong>.</p>`;
  }
  function about(integration,st,need){
    const who=by(integration),reason=line(integration.reason,300),notes=text(integration.setupNotes,2000).trim();
    const ask=who?`<p class="cr-why">${escape(who)} asked for this${reason?`: ${escape(reason)}`:'.'}</p>`:reason?`<p class="cr-why">${escape(reason)}</p>`:'';
    const how=notes?`<details class="cr-details" data-cr-open="how"${st.open.how?' open':''}><summary>How to get ${need==='oauth'?'the sign-in details':need==='key'?'the key':'this'}</summary><p class="cr-quiet">Written by ${escape(who || 'the bot')}. Check each step on the service’s own site.</p><p class="cr-notes">${escape(notes)}</p></details>`:'';
    const can=`<details class="cr-details" data-cr-open="can"${st.open.can?' open':''}><summary>What ${escape(who || 'the bot')} will be able to do</summary>${actionList(integration)}</details>`;
    return `${ask}${hosts(integration,need)}${how}${can}`;
  }
  function status(st){
    return `<p class="cr-status${st.error?' is-error':''}" role="${st.error?'alert':'status'}" aria-live="polite">${escape(st.error || st.notice)}</p>`;
  }
  function keyForm(integration,st,id){
    const label=integration.authType==='header'?`Key (sent in the ${escape(line(integration.headerName,60) || 'x-api-key')} header)`:'API key';
    return `<form class="cr-form" data-cr-form="key" novalidate><div class="cr-field"><label for="cr-key-${id}">${label}</label><input id="cr-key-${id}" type="password" data-cr-field="key" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="8192"${st.busy?' disabled':''}></div><div class="cr-buttons"><button type="submit" class="primary-button"${st.busy?' disabled':''}>${st.busy==='key'?'Connecting…':'Connect'}</button></div></form>`;
  }
  function checkForm(integration,st){
    return `<div class="cr-buttons"><button type="button" class="primary-button" data-cr-act="check"${st.busy?' disabled':''}>${st.busy==='check'?'Checking…':'Check connection'}</button></div>`;
  }
  function redirectRow(id){
    if(redirectStale())loadRedirect();
    const value=redirect.uri?`<div class="cr-copy"><input id="cr-redirect-${id}" type="text" readonly value="${escape(redirect.uri)}" aria-label="Return address" spellcheck="false"><button type="button" class="secondary-button" data-cr-act="copy">Copy</button></div>`:`<p class="cr-quiet">${escape(redirect.error || 'Loading the return address…')}</p>`;
    return value;
  }
  function oauthSteps(integration,st,id,{dialog=false}={}){
    const oauth=plain(integration.oauth)?integration.oauth:{},savedId=line(oauth.clientId,500),secret=integration.hasOAuthClientSecret===true;
    const clientId=st.clientId ?? savedId,again=reauth(integration);
    const saved=[savedId?'Client ID saved':'',secret?'client secret saved':''].filter(Boolean).join(' · ');
    const waiting=st.waiting?`<div class="cr-waiting"><p>Waiting for sign-in… Finish it in the window that opened. The link works until ${escape(clock(st.waiting.expiresAt))}.</p><button type="button" class="text-button cr-text" data-cr-act="reopen">Open the sign-in page again</button></div>`:'';
    const manual=`<details class="cr-details cr-manual" data-cr-open="manual"${st.open.manual?' open':''}><summary>Finish manually</summary><p class="cr-quiet">If the page after sign-in doesn’t load, copy its whole address from the browser bar and paste it here.</p><form class="cr-form" data-cr-form="complete" novalidate><div class="cr-field"><label for="cr-paste-${id}">Address after sign-in</label><input id="cr-paste-${id}" type="url" data-cr-field="paste" value="${escape(st.paste)}" autocomplete="off" spellcheck="false" maxlength="8000"${st.busy?' disabled':''}></div><div class="cr-buttons"><button type="submit" class="secondary-button"${st.busy?' disabled':''}>${st.busy==='complete'?'Finishing…':'Finish'}</button></div></form></details>`;
    const step1=again?'':`<li><h4>Add this return address to your OAuth app</h4>${redirectRow(id)}</li>`;
    const step2=again && savedId?'':`<li><h4>Enter the app’s client details</h4><form class="cr-form" data-cr-form="client" novalidate><div class="cr-field"><label for="cr-client-${id}">Client ID</label><input id="cr-client-${id}" type="text" data-cr-field="client" value="${escape(clientId)}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="500"${st.busy?' disabled':''}></div><div class="cr-field"><label for="cr-secret-${id}">Client secret <span class="cr-optional">${secret?'(saved — leave empty to keep it)':'(if the app has one)'}</span></label><input id="cr-secret-${id}" type="password" data-cr-field="secret" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="4096"${st.busy?' disabled':''}></div>${saved?`<p class="cr-saved">${escape(saved)}</p>`:''}<div class="cr-buttons"><button type="submit" class="secondary-button"${st.busy?' disabled':''}>${st.busy==='client'?'Saving…':'Save'}</button></div></form></li>`;
    const ready=Boolean(savedId);
    const step3=`<li><h4>${again?'Sign in again':'Sign in'}</h4><div class="cr-buttons"><button type="button" class="primary-button" data-cr-act="sign-in"${st.busy || !ready?' disabled':''}${ready?'':` aria-describedby="cr-needs-${id}"`}>${st.busy==='start'?'Opening…':again?'Sign in again':'Sign in'}</button>${dialog && oauth.connected?`<button type="button" class="secondary-button" data-cr-act="disconnect"${st.busy?' disabled':''}>Disconnect</button>`:''}</div>${ready?'':`<p class="cr-quiet" id="cr-needs-${id}">Save the client ID first.</p>`}${waiting}${manual}</li>`;
    return `<ol class="cr-steps">${step1}${step2}${step3}</ol>`;
  }
  function clock(iso){const time=Date.parse(iso);return Number.isFinite(time)?new Date(time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'soon';}
  function connectedRow(integration,request,st,{dialog,continueShown}){
    const label=name(integration);
    const since=integration.oauth?.connectedAt&&Number.isFinite(Date.parse(integration.oauth.connectedAt))?` · signed in ${new Date(integration.oauth.connectedAt).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}`:'';
    const cont=continueShown?`<button type="button" class="primary-button cr-continue" data-cr-act="continue">Continue</button>`:'';
    const disconnect=dialog && integration.authType==='oauth2'?`<button type="button" class="secondary-button" data-cr-act="disconnect"${st.busy?' disabled':''}>Disconnect</button>`:'';
    return `<div class="cr-done"><span class="cr-check" aria-hidden="true">✓</span><p><strong>${escape(label)} is connected</strong>${escape(since)}</p>${cont}${disconnect}</div>${status(st)}`;
  }
  /** The inside of one card. `request` is the reply's {integrationId,name,how}; `options.dialog` is the Settings dialog. */
  function inner(integration,request,options={}){
    const id=String(integration?.id || request?.integrationId || '').replace(/[^\w-]/g,'').slice(0,100) || 'x';
    if(!plain(integration))return missing.get(id)==='gone' || options.dialog?`<p class="cr-removed">${escape(line(request?.name,60) || 'This connection')} was removed.</p>`:`<p class="cr-quiet" role="status">Checking ${escape(line(request?.name,60) || 'this connection')}…</p>`;
    const st=stateOf(integration.id);
    if(done(integration) && !st.busy)return connectedRow(integration,request,st,options);
    const step=need(integration,request?.how),again=step==='oauth' && reauth(integration) && !integration.oauth?.connected;
    const title=again?`Sign in to ${name(integration)} again`:step==='check'?`Check ${name(integration)}`:`Connect ${name(integration)}`;
    const problem=integration.error && !st.error?`<p class="cr-problem">${escape(line(integration.error,240))}</p>`:'';
    const body=step==='oauth'?oauthSteps(integration,st,id,options):step==='key'?keyForm(integration,st,id):checkForm(integration,st);
    return `<h3 class="cr-title${again?' is-again':''}">${escape(title)}</h3>${again?'<p class="cr-why">The service stopped accepting the saved sign-in.</p>':''}${about(integration,st,step)}${problem}${body}${status(st)}`;
  }
  function find(ctx,id){return (ctx?.data?.integrations || []).find(item=>item?.id===id) || null;}
  const requestsOf=list=>(Array.isArray(list)?list:[]).filter(item=>plain(item) && typeof item.integrationId==='string' && /^[\w-]{1,100}$/.test(item.integrationId)).slice(0,5);

  /** Cards under a reply. Returns '' when there is nothing to show. */
  function cards(requests,{botId='',messageKey='',ctx}={}){
    const list=requestsOf(requests);if(!list.length)return '';
    use(ctx);
    return `<div class="cr-list">${list.map(request=>{
      const integration=find(C(),request.integrationId);
      return `<section class="cr-card" data-cr-id="${escape(request.integrationId)}" data-cr-name="${escape(line(request.name,60))}" data-cr-how="${escape(['api_key','oauth','none'].includes(request.how)?request.how:'')}" data-cr-bot="${escape(botId)}" data-cr-message="${escape(messageKey)}" aria-label="${escape(`Connect ${line(integration?.name || request.name,60) || 'a service'}`)}">${inner(integration,request)}</section>`;
    }).join('')}</div>`;
  }

  /* ---- keeping cards current without losing what is being typed ---- */
  function laterOwnerMessage(card){
    let node=card.closest?.('.chat-message')?.nextElementSibling;
    while(node){if(node.matches?.('.chat-message.user'))return true;node=node.nextElementSibling;}
    return false;
  }
  function continueShown(card,integration){
    if(card.dataset.crDialog==='true' || !done(integration))return false;
    const key=`${card.dataset.crMessage || ''}/${card.dataset.crId || ''}`;
    return !used().includes(key) && !laterOwnerMessage(card);
  }
  function patch(card,html){
    if(card.__crSource===html)return;
    const active=document.activeElement,focused=card.contains(active)?active?.dataset?.crField:'';
    const start=focused?active.selectionStart:null,end=focused?active.selectionEnd:null;
    const keep=new Map([...card.querySelectorAll('[data-cr-field]')].map(node=>[node.dataset.crField,node]));
    const template=document.createElement('template');template.innerHTML=html;
    for(const node of template.content.querySelectorAll('[data-cr-field]')){
      const old=keep.get(node.dataset.crField);if(!old || old.type!==node.type)continue;
      old.disabled=node.disabled;node.replaceWith(old);
    }
    card.replaceChildren(template.content);card.__crSource=html;
    if(focused){const field=card.querySelector(`[data-cr-field="${focused}"]`);if(field && !field.disabled){field.focus({preventScroll:true});try{if(start!==null)field.setSelectionRange(start,end);}catch{}}}
  }
  function update(card){
    const id=card.dataset.crId,integration=find(C(),id),request={integrationId:id,name:card.dataset.crName,how:card.dataset.crHow};
    if(integration)missing.delete(id);else if(!missing.has(id))recheck(id);
    patch(card,inner(integration,request,{dialog:card.dataset.crDialog==='true',continueShown:integration?continueShown(card,integration):false}));
  }
  /** A reply can arrive before the workspace state lists the connection it created: look once more before calling it removed. */
  function recheck(id){
    missing.set(id,'checking');
    Promise.resolve().then(()=>C()?.refresh?.(false)).catch(()=>{}).then(()=>{if(missing.get(id)==='checking' && !find(C(),id))missing.set(id,'gone');refreshCards();});
  }
  /** Brings every card inside `root` up to date with the workspace state. Called after the chat thread is drawn. */
  function mount(root,ctx){
    use(ctx);
    for(const card of root?.querySelectorAll?.('.cr-card') || [])update(card);
    schedule();
  }
  function refreshCards(){for(const card of document.querySelectorAll('.cr-card'))update(card);}

  /* ---- talking to the engine ---- */
  function message(error,fallback){return line(C()?.errorText?C().errorText(error):error?.message,300) || fallback;}
  async function reload(){
    const ctx=C();if(!ctx?.refresh)return;
    try{await ctx.refresh(ctx.route?.().view==='integrations');}catch{}
    refreshCards();
  }
  function botWorking(integration){
    const name=by(integration);return `Wait for ${name || 'the bot using it'} to finish its task, then try again.`;
  }
  function loadRedirect(){
    if(redirect.loading)return redirect.loading;
    if(!C()?.api)return Promise.resolve();
    redirect.loading=(async()=>{
      try{const result=await C().api('/api/integrations/oauth/redirect');redirect.uri=typeof result?.redirectUri==='string' && /^https?:\/\//.test(result.redirectUri)?result.redirectUri:'';redirect.error=redirect.uri?'':'The engine did not report a return address.';}
      catch(error){redirect.error=error?.status===503?'The return address appears once the engine is fully started. Reload in a moment.':message(error,'Could not load the return address.');}
      finally{redirect.at=Date.now();redirect.loading=null;refreshCards();}
    })();
    return redirect.loading;
  }
  const redirectStale=()=>!redirect.uri && !redirect.loading && (!redirect.error || Date.now()-(redirect.at || 0)>10_000);
  async function act(card,kind,run){
    const id=card.dataset.crId,st=stateOf(id);if(st.busy)return;
    st.busy=kind;st.error='';st.notice='';refreshCards();
    try{st.notice=(await run(st,find(C(),id))) || '';}
    catch(error){st.error=error?.status===409 && /wait for bots/i.test(String(error?.message))?botWorking(find(C(),id)):message(error,'That did not work. Try again.');}
    finally{st.busy='';}
    await reload();
  }
  const base=id=>`/api/integrations/${enc(id)}`;
  async function discover(id){
    const result=await C().api(`${base(id)}/test`,{method:'POST',body:{}});
    const count=Array.isArray(result?.tools)?result.tools.length:0;
    return result?.connected===false && result?.status!=='configured'?'Saved. It is not reachable yet.':Array.isArray(result?.tools)?`Connected. Found ${count} tool${count===1?'':'s'}.`:'Connected.';
  }
  function saveKey(card,form){
    const field=form.querySelector('[data-cr-field="key"]'),value=field?.value.trim() || '',id=card.dataset.crId;
    if(!value){const st=stateOf(id);st.error='Paste the key first.';st.notice='';refreshCards();field?.focus();return;}
    return act(card,'key',async(st,integration)=>{
      await C().api(base(id),{method:'PATCH',body:{apiKey:value}});
      if(field)field.value='';
      return integration?.type==='mcp'?discover(id):'Key saved.';
    });
  }
  function saveClient(card,form){
    const id=card.dataset.crId,clientId=form.querySelector('[data-cr-field="client"]')?.value.trim() || '',secretField=form.querySelector('[data-cr-field="secret"]'),secret=secretField?.value || '';
    if(!clientId){const st=stateOf(id);st.error='Enter the client ID from the service.';st.notice='';refreshCards();return;}
    return act(card,'client',async st=>{
      await C().api(base(id),{method:'PATCH',body:{oauth:{clientId},...(secret.trim()?{oauthClientSecret:secret.trim()}:{})}});
      if(secretField)secretField.value='';st.clientId=null;
      return 'Saved. Now sign in.';
    });
  }
  function openSignIn(url){
    let safe='';try{const parsed=new URL(url);if(['https:','http:'].includes(parsed.protocol))safe=parsed.href;}catch{}
    if(!safe)return false;
    window.open(safe,'_blank','noopener,noreferrer');return true;
  }
  function signIn(card){
    const id=card.dataset.crId;
    return act(card,'start',async st=>{
      const result=await C().api(`${base(id)}/oauth/start`,{method:'POST',body:{}});
      const expiresAt=typeof result?.expiresAt==='string'?result.expiresAt:new Date(Date.now()+600_000).toISOString();
      if(!openSignIn(result?.authorizationUrl))throw new Error('The service returned a sign-in address Tupies cannot open.');
      st.signInUrl=result.authorizationUrl;st.waiting={expiresAt};schedule();
      return '';
    });
  }
  function complete(card,form){
    const id=card.dataset.crId,field=form.querySelector('[data-cr-field="paste"]'),value=field?.value.trim() || '';
    if(!value){const st=stateOf(id);st.error='Paste the whole address from the browser bar.';refreshCards();return;}
    return act(card,'complete',async st=>{
      await C().api(`${base(id)}/oauth/complete`,{method:'POST',body:{redirectUrl:value}});
      st.paste='';if(field)field.value='';st.waiting=null;st.signInUrl='';st.open.manual=false;
      return 'Signed in.';
    });
  }
  function disconnect(card){
    const id=card.dataset.crId;
    return act(card,'disconnect',async st=>{await C().api(`${base(id)}/oauth/disconnect`,{method:'POST',body:{}});st.waiting=null;st.signInUrl='';return 'Disconnected. The client details are kept.';});
  }
  function check(card){const id=card.dataset.crId;return act(card,'check',()=>discover(id));}

  /* ---- waiting for the provider to send the owner back ---- */
  function waitingIds(){return [...states.entries()].filter(([,st])=>st.waiting).map(([id])=>id);}
  function schedule(){
    const any=waitingIds().length>0;
    if(any && !pollTimer)pollTimer=setInterval(poll,POLL_MS);
    if(!any && pollTimer){clearInterval(pollTimer);pollTimer=null;}
  }
  let polling=false;
  async function poll(){
    if(polling)return;polling=true;
    try{
      const ids=waitingIds();
      for(const id of ids){
        // A card that is gone (another chat, dialog closed) stops the wait; the engine keeps the link until it expires.
        if(![...document.querySelectorAll('.cr-card')].some(card=>card.dataset.crId===id))stateOf(id).waiting=null;
      }
      if(waitingIds().length && C()?.refresh){try{await C().refresh(false);}catch{}}
      for(const id of waitingIds()){
        const st=stateOf(id),integration=find(C(),id);
        if(!integration){st.waiting=null;continue;}
        if(integration.oauth?.connected){st.waiting=null;st.signInUrl='';st.error='';st.notice='Signed in.';}
        else if(Date.parse(st.waiting.expiresAt)<=Date.now()){st.waiting=null;st.signInUrl='';st.error='The sign-in link expired. Press Sign in to try again.';}
      }
      if(C()?.route?.().view==='integrations' && !waitingIds().length)try{C().renderApp?.();}catch{}
      refreshCards();
    }finally{polling=false;schedule();}
  }
  window.addEventListener?.('focus',()=>{if(waitingIds().length)poll();});

  /* ---- Continue: an ordinary owner message through the composer ---- */
  function sendContinue(card,button){
    const botId=card.dataset.crBot,integration=find(C(),card.dataset.crId),key=`${card.dataset.crMessage || ''}/${card.dataset.crId || ''}`;
    const form=document.getElementById('message-form'),field=form?.querySelector('#message-input'),st=stateOf(card.dataset.crId);
    if(!form || !field || form.dataset.id!==botId){st.notice='Open the chat with this bot to continue.';refreshCards();return;}
    const words=`${name(integration)} is connected — please continue.`;
    const direction=form.querySelector('[data-action="send-direction"]'),send=form.querySelector('.send'),attached=document.getElementById('composer-attachments')?.querySelector('.attachment-chip,.attachment-uploading');
    const busy=(direction && !direction.hidden) || !send || send.disabled || send.hidden;
    markUsed(key);button.disabled=true;
    if(field.value.trim() || attached || busy || typeof form.requestSubmit!=='function'){
      field.value=field.value.trim()?`${field.value.replace(/\s+$/,'')}\n\n${words}`:words;
      field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();
      st.notice=busy?'Added to the message box. Send it when the current task has finished.':'Added to the message box. Review it and send.';
    }else{
      field.value=words;field.dispatchEvent(new Event('input',{bubbles:true}));
      st.notice='';form.requestSubmit(send);
    }
    refreshCards();
  }

  /* ---- events ---- */
  const cardOf=node=>node?.closest?.('.cr-card');
  document.addEventListener?.('click',event=>{
    const button=event.target?.closest?.('[data-cr-act]');if(!button || button.disabled)return;
    const card=cardOf(button);if(!card)return;
    const act=button.dataset.crAct;event.preventDefault();
    if(act==='sign-in')signIn(card);
    else if(act==='reopen'){const st=stateOf(card.dataset.crId);if(st.signInUrl)openSignIn(st.signInUrl);}
    else if(act==='disconnect')disconnect(card);
    else if(act==='check')check(card);
    else if(act==='continue')sendContinue(card,button);
    else if(act==='copy')copy(card);
  });
  async function copy(card){
    const st=stateOf(card.dataset.crId),field=card.querySelector('input[readonly]');if(!redirect.uri)return;
    try{await navigator.clipboard.writeText(redirect.uri);st.notice='Return address copied.';}
    catch{field?.select?.();st.notice='Select the address and copy it.';}
    st.error='';refreshCards();
  }
  document.addEventListener?.('submit',event=>{
    const form=event.target?.closest?.('[data-cr-form]');if(!form)return;
    event.preventDefault();const card=cardOf(form);if(!card)return;
    const kind=form.dataset.crForm;
    if(kind==='key')saveKey(card,form);else if(kind==='client')saveClient(card,form);else if(kind==='complete')complete(card,form);
  });
  document.addEventListener?.('input',event=>{
    const field=event.target,kind=field?.dataset?.crField;if(!kind)return;
    const card=cardOf(field);if(!card)return;const st=stateOf(card.dataset.crId);
    // Only non-secret text is remembered; the key and client secret stay in their fields.
    if(kind==='client')st.clientId=field.value;else if(kind==='paste')st.paste=field.value;
    if(st.error){st.error='';const box=card.querySelector('.cr-status');if(box){box.textContent='';box.classList.remove('is-error');box.setAttribute('role','status');}}
  });
  document.addEventListener?.('toggle',event=>{
    const details=event.target;if(!details?.matches?.('details[data-cr-open]'))return;
    const card=cardOf(details);if(card)stateOf(card.dataset.crId).open[details.dataset.crOpen]=details.open;
  },true);

  /* ---- Settings → Integrations ---- */
  /** The status chip for a row, or '' to keep the page's own. */
  function pill(integration){
    const c=chip(integration);if(!c)return '';
    return `<span class="status-pill ${c.tone==='ready'?'ready':'cr-pill-warn'}"><i class="dot"></i>${escape(c.text)}</span>`;
  }
  /** "Added by <bot>" for a row's tags. */
  function rowTags(integration){
    const who=line(integration?.proposedBy?.botName,60);
    return who?`<span class="tag cr-added">Added by ${escape(who)}</span>`:'';
  }
  /** The primary Connect action for a row that still needs the owner. */
  function rowAction(integration,ctx){
    use(ctx);
    if(!plain(integration) || !(integration.ready===false || integration.status==='needs_reauth'))return '';
    const again=integration.status==='needs_reauth';
    return `<button class="primary-button" data-cr-open-dialog data-id="${escape(integration.id)}">${again?'Sign in again':'Connect'}</button>`;
  }
  /** The connect UI in a dialog (Settings rows, after saving an OAuth integration). */
  function openDialog(ctx,id){
    use(ctx);const c=C(),integration=find(c,id);if(!c?.openDialog || !integration)return false;
    const st=stateOf(id);st.error='';st.notice='';
    c.openDialog(`Connect ${name(integration)}`,`<div class="cr-dialog"><section class="cr-card" data-cr-dialog="true" data-cr-id="${escape(id)}" data-cr-name="${escape(name(integration))}" data-cr-how="">${inner(integration,null,{dialog:true})}</section></div><div class="modal-footer"><button class="primary-button" data-action="close-dialog">Done</button></div>`);
    mount(document.getElementById('dialog-root'),c);
    return true;
  }
  document.addEventListener?.('click',event=>{
    const button=event.target?.closest?.('[data-cr-open-dialog]');if(!button)return;
    event.preventDefault();event.stopPropagation();openDialog(null,button.dataset.id);
  },true);
  /** Read-only notes on a bot-proposed integration, for the integration dialog. */
  function proposalNote(integration){
    if(!plain(integration) || !(integration.proposedBy || integration.changedBy))return '';
    const who=by(integration),reason=line(integration.reason,300),notes=text(integration.setupNotes,2000).trim();
    return `<div class="cr-proposal"><p><strong>${escape(who || 'A bot')} ${integration.proposedBy?'added this connection':'changed this connection'}.</strong>${reason?` ${escape(reason)}`:''}</p>${notes?`<details class="cr-details"><summary>Setup notes from ${escape(who || 'the bot')}</summary><p class="cr-notes">${escape(notes)}</p></details>`:''}</div>`;
  }
  /** OAuth fields for the integration dialog. Hidden unless the sign-in method is OAuth. */
  function oauthFields(integration={},id='',ctx){
    use(ctx);
    const o=plain(integration.oauth)?integration.oauth:{},on=integration.authType==='oauth2';
    const extra=Object.entries(plain(o.extraParams)?o.extraParams:{}).map(([key,value])=>`${key}=${value}`).join('\n');
    const state=!id?'<p class="cr-quiet">Save, then sign in.</p>':o.connected?`<p class="cr-saved">Signed in${o.connectedAt?` since ${escape(new Date(o.connectedAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}))}`:''}. Changing the client ID, secret or addresses signs it out.</p>`:`<p class="cr-quiet">${integration.status==='needs_reauth'?'The sign-in expired. Save, then sign in again.':'Not signed in yet. Save, then sign in.'}</p>`;
    const disconnect=id && o.connected?`<button type="button" class="secondary-button" data-cr-dialog-disconnect data-id="${escape(id)}">Disconnect</button>`:'';
    return `<fieldset class="cr-oauth-fields" id="integration-oauth-field" ${on?'':'hidden'}><legend>OAuth 2.0 sign-in</legend>${redirectField()}<div class="field"><label for="integration-oauth-auth-url">Sign-in address (authorization URL)</label><input id="integration-oauth-auth-url" name="oauthAuthorizationUrl" type="url" value="${escape(o.authorizationUrl || '')}" placeholder="https://accounts.example.com/oauth/authorize" spellcheck="false"></div><div class="field"><label for="integration-oauth-token-url">Token address (token URL)</label><input id="integration-oauth-token-url" name="oauthTokenUrl" type="url" value="${escape(o.tokenUrl || '')}" placeholder="https://accounts.example.com/oauth/token" spellcheck="false"></div><div class="field"><label for="integration-oauth-scopes">Permissions (scopes)</label><input id="integration-oauth-scopes" name="oauthScopes" value="${escape((Array.isArray(o.scopes)?o.scopes:[]).join(' '))}" placeholder="read write" spellcheck="false"><small>Separate with spaces. Ask for as little as the bot needs.</small></div><div class="field"><label for="integration-oauth-client">Client ID</label><input id="integration-oauth-client" name="oauthClientId" value="${escape(o.clientId || '')}" autocomplete="off" spellcheck="false"></div><div class="field"><label for="integration-oauth-secret">Client secret <span class="optional-label">${integration.hasOAuthClientSecret?'saved':'optional'}</span></label><input id="integration-oauth-secret" name="oauthClientSecret" type="password" autocomplete="new-password" placeholder="${integration.hasOAuthClientSecret?'Leave empty to keep the saved secret':'If the app has one'}"></div><details class="cr-details"><summary>More sign-in options</summary><div class="field"><label for="integration-oauth-extra">Extra sign-in parameters</label><textarea id="integration-oauth-extra" name="oauthExtra" rows="2" spellcheck="false" placeholder="access_type=offline">${escape(extra)}</textarea><small>One name=value per line.</small></div><div class="field"><label for="integration-oauth-token-auth">Send the client secret</label><select id="integration-oauth-token-auth" name="oauthTokenAuth"><option value="body" ${o.tokenAuth!=='basic'?'selected':''}>In the request (most services)</option><option value="basic" ${o.tokenAuth==='basic'?'selected':''}>As a Basic login header</option></select></div></details><div class="cr-oauth-state" role="status" aria-live="polite">${state}${disconnect}</div></fieldset>`;
  }
  function redirectField(){
    if(redirectStale())loadRedirect().then(()=>{const node=document.getElementById('integration-oauth-redirect');if(node)node.outerHTML=redirectField();});
    return `<div class="field" id="integration-oauth-redirect"><span class="field-label">Return address</span>${redirect.uri?`<div class="cr-copy"><input type="text" readonly value="${escape(redirect.uri)}" aria-label="Return address" spellcheck="false"><button type="button" class="secondary-button" data-cr-copy-redirect>Copy</button></div>`:`<p class="cr-quiet">${escape(redirect.error || 'Loading…')}</p>`}<small>Register this address in the service’s OAuth app.</small></div>`;
  }
  document.addEventListener?.('click',async event=>{
    const copyButton=event.target?.closest?.('[data-cr-copy-redirect]');
    if(copyButton){event.preventDefault();try{await navigator.clipboard.writeText(redirect.uri);copyButton.textContent='Copied';}catch{copyButton.previousElementSibling?.select?.();}return;}
    const off=event.target?.closest?.('[data-cr-dialog-disconnect]');
    if(off && !off.disabled){
      event.preventDefault();off.disabled=true;const box=off.closest('.cr-oauth-state');
      try{await C().api(`/api/integrations/${enc(off.dataset.id)}/oauth/disconnect`,{method:'POST',body:{}});if(box)box.innerHTML='<p class="cr-quiet">Disconnected. Save, then sign in again.</p>';try{await C().refresh?.(false);}catch{}}
      catch(error){off.disabled=false;if(box){const p=document.createElement('p');p.className='cr-status is-error';p.textContent=message(error,'Could not disconnect.');box.append(p);}}
    }
  });
  /** The OAuth part of the integration form's save. Throws a plain error for unusable extra parameters. */
  function oauthPayload(form){
    const get=name=>String(form?.elements?.namedItem?.(name)?.value ?? '').trim();
    const extraParams={};
    for(const raw of get('oauthExtra').split('\n')){
      const entry=raw.trim();if(!entry)continue;
      const at=entry.indexOf('=');if(at<1)throw new Error('Write each extra sign-in parameter as name=value on its own line.');
      extraParams[entry.slice(0,at).trim()]=entry.slice(at+1).trim();
    }
    const payload={oauth:{authorizationUrl:get('oauthAuthorizationUrl'),tokenUrl:get('oauthTokenUrl'),scopes:get('oauthScopes').split(/[\s,]+/).filter(Boolean),clientId:get('oauthClientId'),extraParams,tokenAuth:get('oauthTokenAuth')==='basic'?'basic':'body'}};
    const secret=get('oauthClientSecret');if(secret)payload.oauthClientSecret=secret;
    return payload;
  }
  /** Shows the fields that belong to the chosen sign-in method. */
  function toggleAuth(form,value){
    const oauth=form?.querySelector?.('#integration-oauth-field'),key=form?.querySelector?.('#integration-key-field');
    if(oauth)oauth.hidden=value!=='oauth2';if(key)key.hidden=value==='none' || value==='oauth2';
  }
  /** A catalog preset with OAuth fills the OAuth fields; its setup notes show above the form. */
  function applyPreset(form,preset){
    if(!form || !plain(preset))return;
    toggleAuth(form,preset.authType || 'bearer');
    const set=(id,value)=>{const field=form.querySelector('#'+id);if(field)field.value=value;};
    if(preset.authType==='oauth2'){
      const o=plain(preset.oauth)?preset.oauth:{};
      set('integration-oauth-auth-url',o.authorizationUrl || '');set('integration-oauth-token-url',o.tokenUrl || '');
      set('integration-oauth-scopes',(Array.isArray(o.scopes)?o.scopes:[]).join(' '));set('integration-oauth-client',o.clientId || '');
      set('integration-oauth-extra',Object.entries(plain(o.extraParams)?o.extraParams:{}).map(([key,value])=>`${key}=${value}`).join('\n'));
      set('integration-oauth-token-auth',o.tokenAuth==='basic'?'basic':'body');set('integration-oauth-secret','');
    }
    let notes=form.querySelector('.cr-preset-notes');const value=text(preset.setupNotes,2000).trim();
    if(value){if(!notes){notes=document.createElement('div');notes.className='cr-preset-notes';form.prepend(notes);}notes.innerHTML=`<p class="cr-notes">${escape(value)}</p>`;}
    else notes?.remove();
  }
  function remember(ctx){use(ctx);}

  window.StudioConnect={cards,mount,openDialog,pill,rowTags,rowAction,proposalNote,oauthFields,oauthPayload,applyPreset,toggleAuth,remember,_internals:{inner,chip,done,need,states,redirect}};
})();
