// Mac reconnect handoff: bounded message drafts only, in page/native memory. Never submits a task.
(() => {
'use strict';
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
function files(value) {
  if(!Array.isArray(value))return [];
  return value.slice(0,5).filter(file=>typeof file?.path==='string'&&file.path.length<=240&&!file.path.startsWith('/')&&!file.path.includes('://')&&!/[\\\x00-\x1f\x7f]/.test(file.path)&&file.path.split('/').every(part=>part&&part!=='.'&&part!=='..')&&typeof file.name==='string'&&file.name.length>0&&file.name.length<=255).map(({path,name})=>({path,name}));
}
function createUpdateDraftBridge({window,getAttachments,setAttachments,onRestore}) {
  const recovered=new Map();let observer=null;
  const key=entry=>`${entry.form}/${entry.id}`;
  function apply() {
    for(const [id,entry] of recovered) {
      const form=window.document.getElementById(entry.form),field=form?.querySelector('textarea');
      if(!field||form.dataset.id!==entry.id||field.value)continue;
      field.value=entry.text;field.dispatchEvent(new window.Event('input',{bubbles:true}));recovered.delete(id);
    }
    if(!recovered.size){observer?.disconnect();observer=null;}
  }
  function watch() {
    if(!recovered.size)return;
    if(!observer){observer=new window.MutationObserver(apply);observer.observe(window.document.body,{childList:true,subtree:true});}
    window.queueMicrotask(apply);
  }
  window.addEventListener('hashchange',watch);
  function capture() {
    const entries=new Map(recovered);
    for(const form of window.document.querySelectorAll('#message-form, #room-message-form')) {
      const field=form.querySelector('textarea');if(!validId(form.dataset.id)||!field?.value)continue;
      const entry={form:form.id,id:form.dataset.id,text:field.value.slice(0,20_000)};entries.set(key(entry),entry);
    }
    const attachments=[...getAttachments()].filter(([id])=>validId(id)).slice(0,30).map(([id,value])=>({id,files:files(value)})).filter(entry=>entry.files.length);
    if(!entries.size&&!attachments.length)return null;
    return {v:1,route:window.location.hash,forms:[...entries.values()].slice(0,30),attachments};
  }
  function restore(snapshot) {
    if(snapshot?.v!==1||!Array.isArray(snapshot.forms)||!Array.isArray(snapshot.attachments)||snapshot.forms.length>30||snapshot.attachments.length>30)return false;
    for(const entry of snapshot.forms)if(['message-form','room-message-form'].includes(entry?.form)&&validId(entry.id)&&typeof entry.text==='string'&&entry.text.length<=20_000&&entry.text)recovered.set(key(entry),{form:entry.form,id:entry.id,text:entry.text});
    for(const entry of snapshot.attachments)if(validId(entry?.id)){const retained=files(entry.files);if(retained.length)setAttachments(entry.id,retained);}
    if(typeof snapshot.route==='string'&&/^#\/(?:bot|room)\/[A-Za-z0-9_-]{1,100}$/.test(snapshot.route)&&['','#/dashboard'].includes(window.location.hash))window.location.hash=snapshot.route;
    onRestore();watch();return true;
  }
  function clear(){recovered.clear();observer?.disconnect();observer=null;}
  return {capture,restore,clear};
}
window.StudioUpdateDrafts={create:createUpdateDraftBridge};
})();
