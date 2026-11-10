/* Approval cards in plain words: one sentence for what will happen, its inputs as a short list, the exact request behind Details.
   Presentation only. The engine binds an approval to the exact request, whatever this text says. */
(()=>{
  'use strict';
  const escape=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const text=value=>typeof value==='string'?value:value===undefined || value===null?'':typeof value==='object'?JSON.stringify(value):String(value);
  const clip=(value,max)=>{const string=text(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,' ');return string.length>max?`${string.slice(0,max)}…`:string;};
  const plain=value=>value && typeof value==='object' && !Array.isArray(value);
  const host=value=>{try{return new URL(String(value)).hostname;}catch{return '';}};
  const words=name=>String(name || '').replace(/[_-]+/g,' ').trim();
  const size=value=>{const length=text(value).length;return length>=1000?`${(length/1000).toFixed(length<10_000?1:0).replace(/\.0$/,'')}K characters`:`${length} characters`;};
  const LABELS={path:'File',url:'Address',method:'Method',command:'Command',cwd:'Folder',folder:'Folder',timeoutMs:'Time limit',language:'Language',code:'Code',content:'Content',oldText:'Replace',newText:'With',body:'Body',headers:'Headers',query:'Search',integrationId:'Connection',tool:'Action',name:'Name',prompt:'Instructions',text:'Text',value:'Value',key:'Key',id:'Item',botId:'Bot',schedule:'Schedule',title:'Title',description:'Description',arguments:'Inputs',args:'Arguments',executable:'Program',site:'Site',refusals:'Refusals so far'};
  const LONG=new Set(['command','code','content','oldText','newText','body','prompt','instructions']);
  const HIDDEN=new Set(['ref','revision','expectedSha256','expectedVersion','digest','approvedDigest','frameId','tabId']);

  /** A short title and a sentence for the tools that ask most often; anything else is described from its name. */
  function describe(tool,args){
    const a=plain(args)?args:{},file=clip(a.path,160),site=host(a.url);
    switch(tool){
      case 'terminal':return {title:'Run a command',sentence:'Run this command in the bot’s terminal.',keys:['command','cwd','timeoutMs']};
      case 'execute_code':return {title:'Run code',sentence:`Run a short ${a.language==='node'?'JavaScript':a.language==='python'?'Python':'code'} program.`,keys:['code','language','timeoutMs']};
      case 'shell_run':case 'shell_start':return {title:tool==='shell_start'?'Start a background command':'Run a program',sentence:tool==='shell_start'?'Start this program and keep it running in the background.':'Run this program once.',keys:['executable','command','args','cwd','timeoutMs']};
      case 'scripts_run':return {title:'Run a saved script',sentence:`Run the saved script ${clip(a.id ?? a.script ?? a.name,80) || 'named below'}.`,keys:['id','script','name','args','arguments']};
      case 'workspace_write':return {title:'Write a file',sentence:file?`Write the file ${file}.`:'Write a file in the bot’s workspace.',keys:['path','content']};
      case 'workspace_edit':return {title:'Change a file',sentence:file?`Change the file ${file}.`:'Change a file in the bot’s workspace.',keys:['path','oldText','newText','replaceAll']};
      case 'workspace_delete':return {title:'Delete a file',sentence:file?`Delete ${file}. This cannot be undone here.`:'Delete a file from the bot’s workspace.',keys:['path']};
      case 'documents_create':return {title:'Create a document',sentence:file?`Create the document ${file}.`:'Create a document in the bot’s workspace.',keys:['path','title','format']};
      case 'http_fetch':return {title:'Send a web request',sentence:`Send a ${clip(a.method || 'GET',10).toUpperCase()} request${site?` to ${site}`:''}.`,keys:['url','method','body','headers']};
      case 'integration_call':return {title:'Use a connected service',sentence:`Use the connected service${a.tool?`: ${clip(words(a.tool),80)}`:''}.`,keys:['integrationId','tool','arguments']};
      case 'web_search':return {title:'Search with a connected service',sentence:'Run this search through the bot’s fallback search service.',keys:['query','integrationId','count']};
      case 'site_access_review':return {title:'A site keeps refusing',sentence:`Keep trying ${clip(a.site,120) || 'this site'} by other routes?`,keys:['site','refusals','lastReason']};
      case 'browser_click':return {title:'Click in the browser',sentence:'Click this control on the page the bot has open.',keys:['label','text','name']};
      case 'browser_fill':case 'browser_type':return {title:'Type in the browser',sentence:'Type this text into a field on the page the bot has open.',keys:['text','label','name']};
      case 'browser_select':case 'browser_check':return {title:'Change a form field',sentence:'Change this field on the page the bot has open.',keys:['values','checked','label','name']};
      case 'browser_key':return {title:'Press a key in the browser',sentence:`Press ${clip(a.key,30) || 'a key'} on the page the bot has open.`,keys:['key']};
      default:{const name=words(tool);return {title:name?name[0].toUpperCase()+name.slice(1):'Action',sentence:name?`Allow the action “${name}”.`:'Allow this action.',keys:null};}
    }
  }

  function row(key,value){
    const label=LABELS[key] || (words(key).replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,char=>char.toUpperCase()));
    let shown=key==='timeoutMs' && Number.isFinite(value)?`${Math.round(value/1000)} s`:key==='content' && text(value).length>400?`${clip(value,400)} (${size(value)})`:clip(value,LONG.has(key)?1200:300);
    if(!shown)return '';
    return `<div><dt>${escape(label)}</dt><dd${LONG.has(key)?' class="is-block"':''}>${escape(shown)}</dd></div>`;
  }

  /** The inputs as a list: the tool's known inputs first, then anything else it was given, without internal identifiers. */
  function inputs(tool,args,keys){
    if(!plain(args))return '';
    const order=[...(keys || []).filter(key=>Object.hasOwn(args,key)),...Object.keys(args).filter(key=>!(keys || []).includes(key) && !HIDDEN.has(key))].slice(0,12);
    const rows=order.map(key=>row(key,args[key])).filter(Boolean).join('');
    return rows?`<dl class="approval-inputs">${rows}</dl>`:'';
  }

  /** Title for the card heading. */
  function title(control){return describe(control?.tool,control?.arguments).title;}
  /** Sentence, optional reason, inputs and the exact request. `raw` is the engine's own preview text. */
  function body(control,raw){
    if(!control || typeof control.tool!=='string')return '';
    const described=describe(control.tool,control.arguments);
    const sentence=typeof control.review?.summary==='string' && control.review.summary.trim()?control.review.summary:described.sentence;
    const reason=typeof control.review?.riskReason==='string' && control.review.riskReason.trim()?`<p class="approval-reason">${escape(clip(control.review.riskReason,600))}</p>`:'';
    const exact=text(raw) || JSON.stringify({tool:control.tool,arguments:control.arguments},null,2);
    return `<p class="approval-sentence"><strong>${escape(clip(sentence,600))}</strong></p>${reason}${inputs(control.tool,control.arguments,described.keys)}<details class="approval-raw"><summary>Details</summary><pre>${escape(clip(exact,20_000))}</pre></details>`;
  }
  window.StudioApprovals={title,body,describe};
})();
