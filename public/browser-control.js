/* Owner-operated browser handoff. Page pixels and typed values stay in this live panel. */
(() => {
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const keys=new Set(['Enter','Tab','Shift+Tab','Backspace','Delete','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Space','Control+A','Meta+A']);
  let active=null;
  const identityFor=(run,control)=>({runId:run.id,remoteRunId:run.remoteRunId||run.id,request_id:control.prompt_id,execution_generation:run.execution_generation});
  function renderCard(bot,run) {
    const control=run.pending_controls?.find(item=>item?.kind==='browser');if(!control)return '';
    const identity=escape(JSON.stringify(identityFor(run,control))),stop=escape(JSON.stringify({runId:run.id,remoteRunId:run.remoteRunId||run.id}));
    return `<section class="browser-handoff-card" data-message-key="browser-${escape(control.prompt_id)}"><h3>${escape(bot.name)} needs your help in the browser</h3><p>${escape(control.reason||'Complete the sign-in or verification, then return control to your bot.')}</p><p class="subtle-label">Open the same browser to sign in, enter a verification code or complete a CAPTCHA.</p><div class="approval-actions"><button type="button" class="primary-button" data-action="browser-handoff" data-id="${escape(bot.id)}" data-browser-identity="${identity}">Open browser</button><button type="button" class="text-button" data-action="stop-run" data-id="${escape(bot.id)}" data-run="${stop}">Stop task</button></div></section>`;
  }
  function reset() {
    const state=active;active=null;if(!state)return;
    clearTimeout(state.timer);state.abort.abort();state.view=null;state.pointer=null;
    state.image.onload=null;state.image.onerror=null;state.image.removeAttribute('src');
    state.panel.querySelectorAll('input').forEach(input=>{input.value='';});
    state.panel.querySelector('[data-browser-url]').textContent='';
    state.panel.querySelector('[data-browser-tabs]').replaceChildren();
  }
  function current(state) {return active===state&&state.panel.isConnected&&state.dialog.open&&(!state.context.valid||state.context.valid());}
  function controls(state) {
    const locked=state.busy||state.loading||!state.view;
    state.panel.querySelectorAll('[data-browser-action]').forEach(button=>{const type=button.dataset.browserAction;button.disabled=state.busy||(type!=='refresh'&&(locked||(state.dialogInfo&&type!=='dialog')));});
    state.panel.querySelector('[data-browser-tabs]').disabled=locked||!!state.dialogInfo;
    state.image.setAttribute('aria-disabled',String(locked||!!state.dialogInfo));
    state.panel.querySelectorAll('[data-browser-resume]').forEach(button=>{button.disabled=state.busy;});
    state.panel.setAttribute('aria-busy',String(state.busy||state.loading));
  }
  function status(state,text,error=false) {const node=state.panel.querySelector('[data-browser-status]');node.textContent=text;node.classList.toggle('has-error',error);}
  function schedule(state) {
    clearTimeout(state.timer);
    const editing=state.panel.contains(document.activeElement)&&document.activeElement.matches('input,select');
    if(current(state)&&!state.busy&&!state.loading&&!state.pointer&&!document.hidden&&!editing&&state.view)state.timer=setTimeout(()=>void refresh(state),2200);
  }
  function show(state,result) {
    if(!current(state))return;
    const base64=result?.imageBase64;
    if(typeof base64!=='string'||base64.length>20_000_000||!/^iVBOR[0-9A-Za-z+/=]+$/.test(base64)||typeof result.viewId!=='string'||!Number.isFinite(result.width)||!Number.isFinite(result.height)||result.width<1||result.height<1||result.width>4096||result.height>4096)throw new Error('The engine returned an unreadable browser view. Refresh to try again.');
    state.view=null;state.loading=true;
    const dialogInfo=result.dialog&&typeof result.dialog==='object'?result.dialog:null,dialogStamp=dialogInfo?JSON.stringify([dialogInfo.type,dialogInfo.message]):'';
    state.dialogInfo=dialogInfo;const prompt=state.panel.querySelector('[data-browser-site-dialog]');prompt.hidden=!dialogInfo;
    prompt.querySelector('[data-browser-site-message]').textContent=String(dialogInfo?.message||'').slice(0,2000);
    prompt.querySelector('[data-browser-site-type]').textContent=dialogInfo?.type==='prompt'?'The website asks for a response':'The website asks for a decision';
    prompt.querySelector('[data-browser-site-input]').hidden=dialogInfo?.type!=='prompt';
    if(dialogStamp!==state.dialogStamp)prompt.querySelector('input').value='';state.dialogStamp=dialogStamp;
    state.panel.querySelector('[data-browser-url]').textContent=String(result.url||'about:blank');
    const tabs=state.panel.querySelector('[data-browser-tabs]');tabs.replaceChildren();
    for(const tab of (Array.isArray(result.tabs)?result.tabs:[]).slice(0,12)) {const option=document.createElement('option');option.value=String(tab.id);option.textContent=String(tab.title||tab.url||'Untitled tab').slice(0,200);option.selected=tab.id===result.tabId;tabs.append(option);}
    if(!state.retentionSet){state.panel.querySelector('[data-browser-retain]').checked=result.retained===true;state.retentionSet=true;}
    state.image.width=result.width;state.image.height=result.height;
    state.image.onload=()=>{if(!current(state))return;state.loading=false;state.view={viewId:result.viewId,width:result.width,height:result.height};status(state,state.dialogInfo?'Respond to the website’s dialog to continue.':'You have control. Click the page, or insert text into its selected field.');controls(state);schedule(state);};
    state.image.onerror=()=>{if(!current(state))return;state.loading=false;state.view=null;status(state,'The image could not be displayed. Refresh the view before acting.',true);controls(state);};
    state.image.src=`data:image/png;base64,${base64}`;controls(state);
  }
  async function request(state,endpoint,body={}) {
    if(!current(state)||state.busy)return;
    clearTimeout(state.timer);state.busy=true;controls(state);
    try {
      const result=await state.context.api(`/api/bots/${encodeURIComponent(state.botId)}/browser/${endpoint}`,{method:'POST',body:{...state.identity,...body},signal:state.abort.signal});
      if(!current(state))return;
      if(endpoint==='resume') {const ctx=state.context,botId=state.botId;ctx.closeDialog();await ctx.loadChat(botId);ctx.toast(body.skip?'Browser help skipped.':'Control returned to your bot.');return;}
      if(endpoint==='action'&&result?.inputSent===true&&result.viewUnavailable===true){state.view=null;state.loading=false;status(state,'Input sent. The page is updating or its view is unavailable. Refresh to inspect the result before acting again.');return;}
      show(state,result);
    } catch(error) {
      if(!current(state)||state.abort.signal.aborted)return;
      state.view=null;state.loading=false;
      status(state,endpoint==='action'?(error?.status===409?'The browser view changed. Refresh to inspect the page before acting again.':'The action could not be confirmed. Refresh the browser before deciding what to do next.'):String(error?.message||'The browser view is unavailable. Refresh to try again.'),true);
    } finally {if(current(state)){state.busy=false;controls(state);schedule(state);}}
  }
  async function refresh(state) {if(state.pointer||document.hidden)return;schedule(state);return request(state,'view');}
  function action(state,value) {
    if(!current(state)||state.busy||state.loading||!state.view||(state.dialogInfo&&value.type!=='dialog'))return;
    const viewId=state.view.viewId;state.view=null;
    return request(state,'action',{action:value,viewId});
  }
  function point(state,event) {
    const rect=state.image.getBoundingClientRect(),view=state.view;
    if(!view||!rect.width||!rect.height)return null;
    return {x:Math.max(0,Math.min(view.width-1,Math.floor((event.clientX-rect.left)*view.width/rect.width))),y:Math.max(0,Math.min(view.height-1,Math.floor((event.clientY-rect.top)*view.height/rect.height)))};
  }
  function open(context,botId,identity) {
    reset();
    context.openDialog('Browser · your control',`<section class="browser-control-panel"><p class="browser-control-intro">Your bot is paused. Enter passwords and verification codes here, and complete any CAPTCHA on the page. Your keystrokes are not added to the chat. The bot can read the page after you resume.</p><div class="browser-control-location"><label for="browser-control-tabs">Tab</label><select id="browser-control-tabs" data-browser-tabs aria-label="Browser tab"></select><button type="button" class="secondary-button" data-browser-action="refresh">Refresh</button></div><p class="browser-control-url" data-browser-url aria-label="Current website">Opening browser…</p><section class="browser-control-site-dialog" data-browser-site-dialog hidden><h3 data-browser-site-type></h3><p data-browser-site-message></p><label data-browser-site-input>Response<input type="password" maxlength="2000" autocomplete="off" data-browser-site-prompt></label><div class="browser-control-entry-row"><button type="button" class="secondary-button" data-browser-action="dialog" data-accept="false">Dismiss</button><button type="button" class="primary-button" data-browser-action="dialog" data-accept="true">Accept</button></div></section><div class="browser-control-viewport"><img class="browser-control-image" alt="Live view of the task browser. Click or drag to interact." tabindex="0" draggable="false"></div><p class="browser-control-status" data-browser-status role="status" aria-live="polite">Reading the browser view…</p><div class="browser-control-keys" aria-label="Browser keys">${[['Tab','Tab'],['Shift+Tab','Back tab'],['Enter','Enter'],['Backspace','Backspace'],['Escape','Escape'],['ArrowLeft','←'],['ArrowRight','→'],['ArrowUp','↑'],['ArrowDown','↓']].map(([key,label])=>`<button type="button" class="secondary-button" data-browser-action="key" data-key="${key}" aria-label="Send ${escape(key)}">${label}</button>`).join('')}<button type="button" class="secondary-button" data-browser-action="scroll" data-direction="up">Scroll up</button><button type="button" class="secondary-button" data-browser-action="scroll" data-direction="down">Scroll down</button></div><div class="browser-control-entry"><label for="browser-control-text">Text for the selected page field</label><div class="browser-control-entry-row"><input id="browser-control-text" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="10000" data-browser-text placeholder="Select a field on the page first"><button type="button" class="secondary-button" data-browser-toggle aria-pressed="false">Show</button><button type="button" class="primary-button" data-browser-action="text">Insert text</button></div><small>Inserts text without submitting the page. Use Enter or click the page’s button to continue.</small></div><details class="browser-control-navigation"><summary>Open another address</summary><div class="browser-control-entry-row"><input type="url" aria-label="HTTPS website address" placeholder="https://example.com" maxlength="2000" autocomplete="off" data-browser-address><button type="button" class="secondary-button" data-browser-action="navigate">Go</button></div></details><label class="browser-control-retain"><input type="checkbox" data-browser-retain><span>Keep this sign-in on this engine<small>Allows this bot to reuse its browser profile on this Mac or server. It does not sync to other engines.</small></span></label><div class="browser-control-footer"><button type="button" class="secondary-button" data-browser-resume="skip">Skip help</button><button type="button" class="primary-button" data-browser-resume="resume">Resume bot</button></div></section>`,{wide:true});
    const panel=document.querySelector('.browser-control-panel'),dialog=panel.closest('dialog'),image=panel.querySelector('img');
    const state={context,botId,identity:{...identity},panel,dialog,image,abort:new AbortController(),busy:false,loading:false,view:null,timer:null,pointer:null,retentionSet:false};active=state;dialog.classList.add('browser-control-dialog');
    dialog.addEventListener('close',()=>{if(active===state)reset();},{once:true});
    panel.addEventListener('focusin',event=>{if(event.target.matches('input,select'))clearTimeout(state.timer);});
    panel.addEventListener('focusout',()=>schedule(state));
    panel.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button||button.disabled)return;
      if(button.hasAttribute('data-browser-toggle')){const input=panel.querySelector('[data-browser-text]'),visible=input.type==='password';input.type=visible?'text':'password';button.textContent=visible?'Hide':'Show';button.setAttribute('aria-pressed',String(visible));return;}
      if(button.hasAttribute('data-browser-resume')){panel.querySelector('[data-browser-text]').value='';void request(state,'resume',{keepSession:panel.querySelector('[data-browser-retain]').checked,...(button.dataset.browserResume==='skip'?{skip:true}:{})});return;}
      const type=button.dataset.browserAction;
      if(type==='refresh')void refresh(state);
      if(type==='dialog'){const input=panel.querySelector('[data-browser-site-prompt]'),promptText=input.value;input.value='';void action(state,{type:'dialog',accept:button.dataset.accept==='true',...(state.dialogInfo?.type==='prompt'?{promptText}:{})});}
      if(type==='key')void action(state,{type:'key',key:button.dataset.key});
      if(type==='scroll')void action(state,{type:'scroll',deltaY:button.dataset.direction==='up'?-600:600,deltaX:0});
      if(type==='text'){const input=panel.querySelector('[data-browser-text]'),text=input.value;input.value='';if(text)void action(state,{type:'text',text});}
      if(type==='navigate'){const input=panel.querySelector('[data-browser-address]');try{const url=new URL(input.value.trim());if(url.protocol!=='https:'||url.username||url.password)throw new Error();input.value='';void action(state,{type:'navigate',url:url.href});}catch{status(state,'Enter a public HTTPS address without embedded credentials.',true);}}
    });
    panel.querySelector('[data-browser-tabs]').addEventListener('change',event=>void action(state,{type:'tab',tabId:event.target.value}));
    panel.querySelector('[data-browser-text]').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();panel.querySelector('[data-browser-action="text"]').click();}});
    image.addEventListener('pointerdown',event=>{if(event.button!==0||state.busy||state.loading)return;const start=point(state,event);if(!start)return;event.preventDefault();image.focus({preventScroll:true});state.pointer={...start,id:event.pointerId};clearTimeout(state.timer);image.setPointerCapture?.(event.pointerId);});
    image.addEventListener('pointerup',event=>{const start=state.pointer;if(!start||start.id!==event.pointerId)return;event.preventDefault();const end=point(state,event);state.pointer=null;image.releasePointerCapture?.(event.pointerId);if(!end)return;schedule(state);void action(state,Math.hypot(end.x-start.x,end.y-start.y)>6?{type:'drag',x:start.x,y:start.y,toX:end.x,toY:end.y}:{type:'click',x:end.x,y:end.y});});
    image.addEventListener('pointercancel',()=>{state.pointer=null;schedule(state);});
    image.addEventListener('keydown',event=>{const key=event.key===' ' ? 'Space':event.key==='Tab'&&event.shiftKey?'Shift+Tab':event.key.toLowerCase()==='a'&&event.metaKey?'Meta+A':event.key.toLowerCase()==='a'&&event.ctrlKey?'Control+A':event.key;if(keys.has(key)){event.preventDefault();void action(state,{type:'key',key});}});
    void refresh(state);
  }
  function observeRun(botId,run) {const state=active;if(!state||state.botId!==botId)return;const control=run?.pending_controls?.find(item=>item?.kind==='browser');if(run?.status!=='waiting_for_input'||!control||JSON.stringify(identityFor(run,control))!==JSON.stringify(state.identity)){const ctx=state.context;reset();ctx.closeDialog();}}
  document.addEventListener('visibilitychange',()=>{const state=active;if(!state)return;if(document.hidden){clearTimeout(state.timer);state.pointer=null;state.panel.querySelector('[data-browser-text]').value='';}else void refresh(state);});
  window.StudioBrowser={renderCard,open,reset,observeRun};
})();
