/* Models that run on the owner's Mac (Ollama, MLX LM / MLX VLM).
   - isLocal()/hostOf(): which saved connections are local, and on which engine they run. The engine is the authority
     (`local` and `host` on each connection); without those fields a local type or a loopback custom URL counts as local
     and `host` null means "on this engine".
   - The "On this Mac" card at the top of Settings › Models: what runs here, a copyable start command or an install
     link, and Use, which adds the runtime as a provider in one click. Tupies never starts a runtime or downloads weights.
   - Labels and badges the model picker and the chat use: "Mac · Qwen3.8 27B", tools/thinking/vision/window badges,
     the plain words for a Mac that is offline, and the live step states ("Loading the model on this Mac…").
   - Embedding models a runtime lists next to chat models are hidden from local model lists. */
(()=>{
  'use strict';
  const LOCAL_TYPES=new Set(['ollama','mlx']);
  const LOOPBACK=new Set(['localhost','127.0.0.1','::1','[::1]']);
  const NODE_CODES=new Set(['node_offline','node_lost']);
  const esc=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

  /* ---- connections ---- */
  function isLocal(connection){
    if(!connection||typeof connection!=='object')return false;
    if(typeof connection.local==='boolean')return connection.local;
    if(LOCAL_TYPES.has(connection.type))return true;
    if(connection.type!=='custom')return false;
    try{return LOOPBACK.has(new URL(connection.baseUrl||'').hostname.toLowerCase());}catch{return false;}
  }
  /** {nodeId,name,online,here} when the engine says which engine hosts the runtime; null means this engine. */
  function hostOf(connection){const host=connection?.host;return host&&typeof host==='object'?host:null;}
  const offline=connection=>isLocal(connection)&&hostOf(connection)?.online===false;
  const remote=connection=>isLocal(connection)&&!!hostOf(connection)&&hostOf(connection).here!==true;

  /* ---- model names and badges ---- */
  /** A readable name for a local model id: "mlx-community/Qwen3.8-27B-4bit" → "Qwen3.8 27B", "qwen3.8:27b" → "Qwen3.8 27B". */
  function shortModelName(id,name){
    if(name&&name!==id)return String(name);
    let text=String(id||'').split('/').pop().replace(/:latest$/i,'');
    for(let i=0;i<4;i++)text=text.replace(/[-_.](?:\d+(?:\.\d+)?-?bits?|mlx|dwq|gguf|awq|fp16|bf16|q\d[\w]*)$/i,'');
    text=text.replace(/[:_-]+/g,' ').replace(/\b(\d+(?:\.\d+)?)b\b/gi,'$1B').trim();
    return text?text[0].toUpperCase()+text.slice(1):String(id||'');
  }
  const caps=model=>Array.isArray(model?.capabilities)?model.capabilities.map(String):null;
  function supportsTools(model){if(typeof model?.tools==='boolean')return model.tools;const list=caps(model);return list?list.includes('tools'):null;}
  function supportsThinking(model){
    if(typeof model?.thinking==='boolean')return model.thinking;const list=caps(model);if(list&&list.includes('thinking'))return true;
    const reasoning=model?.reasoning;return reasoning&&(reasoning.supported===true||Array.isArray(reasoning.efforts)&&reasoning.efforts.length>0)?true:list?false:null;
  }
  function supportsVision(model){
    if(typeof model?.vision==='boolean')return model.vision;const list=caps(model);if(list)return list.includes('vision');
    for(const value of [model?.images,model?.imageInput])if(value&&typeof value.supported==='boolean'&&value.source!=='family')return value.supported;
    return null;
  }
  const windowLabel=tokens=>{const n=Number(tokens);return Number.isFinite(n)&&n>0?`${n>=1_000_000?`${+(n/1_048_576).toFixed(1)}M`:`${Math.round(n/1024)}K`} window`:'';};
  /** Badges for a local model row, from whatever the catalog reports. Unknown capabilities show nothing rather than a guess. */
  function modelBadges(model){
    const badges=[];
    if(/[:-]cloud$/i.test(String(model?.id||'')))badges.push({key:'cloud',label:'Runs on ollama.com'});
    if(supportsTools(model)===true)badges.push({key:'tools',label:'Tools'});
    if(supportsThinking(model)===true)badges.push({key:'thinking',label:'Thinking'});
    if(supportsVision(model)===true)badges.push({key:'vision',label:'Vision'});
    const window=windowLabel(model?.contextWindow||model?.contextLength);if(window)badges.push({key:'window',label:window});
    const size=[model?.parameterSize,model?.quantization].filter(Boolean).join(' · ');if(size)badges.push({key:'size',label:size});
    return badges;
  }
  const NO_TOOLS='Can’t use tools: a bot on this model can only chat. Files, web and actions need a model with tool support.';
  function modelNote(model){return supportsTools(model)===false?NO_TOOLS:'';}
  function badgesMarkup(model){const list=modelBadges(model);return list.length?`<span class="lm-badges">${list.map(item=>`<span class="lm-badge is-${esc(item.key)}">${esc(item.label)}</span>`).join('')}</span>`:'';}

  /* ---- embedding models ---- */
  /** Same pattern as isEmbeddingModel in lib/local-models.mjs: embedding models cannot chat, so local model lists hide them. */
  const EMBEDDING=/(^|[^a-z])(embed|embedding|bge|e5|minilm|nomic-embed)([^a-z]|$)/i;
  function isEmbedding(model){const id=typeof model==='string'?model:model?.id;return model?.embedding===true||EMBEDDING.test(String(id||''));}

  /* ---- chat words ---- */
  /** Plain words for a local model step that waits: queued, loading the model, or reading the prompt. "" for other states. */
  function stateText(state,{tokens,host}={}){
    const here=host?.here===true,name=!here&&typeof host?.name==='string'&&host.name.trim()?host.name.trim():'';
    const where=here?(host.mac===false?'':'this Mac'):name?`“${name}”`:'the Mac';
    if(state==='queued')return where?`Waiting for ${where}…`:'Waiting for the local model…';
    if(state==='loading')return where?`Loading the model on ${where}…`:'Loading the model…';
    if(state==='reading'){const n=Number(tokens);return Number.isFinite(n)&&n>0?`Reading the conversation (about ${n>=1000?`${Math.round(n/1000)}K`:Math.round(n)} tokens)…`:'Reading the conversation…';}
    return '';
  }
  /** Plain words for a relay failure: "The Mac is offline — answered by ‹fallback›", or "" for other codes. */
  function failureText(code,fallbackModel=''){
    if(!NODE_CODES.has(code))return '';
    return fallbackModel?`The Mac is offline — answered by ${fallbackModel}`:'The Mac is offline';
  }

  /* ---- Settings › Models: On this Mac ---- */
  let context=null,host=null,request=0,state={loaded:false,loading:false,error:'',platform:'',runtimes:[],busy:''};
  const current=()=>Boolean(context&&host?.isConnected&&host.querySelector('[data-local-models]'));
  const SHORT={ollama:'Ollama',mlx:'MLX'};
  const chatModels=runtime=>(runtime.models||[]).filter(model=>!isEmbedding(model)&&!model.cloud);
  const cloudModels=runtime=>(runtime.models||[]).filter(model=>model.cloud);
  const cloudNote=runtime=>{const n=cloudModels(runtime).length;return n?`<p class="lm-hint">${n} cloud ${n===1?'model runs':'models run'} on ollama.com, not on this Mac, so ${n===1?'it is':'they are'} not listed here.</p>`:'';};
  /** A saved connection that already points at this runtime on this engine. */
  function existing(runtime){
    const origin=url=>{try{const parsed=new URL(url);return `${parsed.hostname.replace(/^localhost$/,'127.0.0.1')}:${parsed.port}`;}catch{return '';}};
    return (context?.data?.connections||[]).find(connection=>connection.type===runtime.type&&isLocal(connection)&&!remote(connection)&&origin(connection.baseUrl)===origin(runtime.baseUrl))||null;
  }
  function command(text,label){return `<div class="lm-command"><code>${esc(text)}</code><button type="button" class="text-button" data-local-action="copy" data-command="${esc(text)}" aria-label="Copy ${esc(label)}">${context.icon('copy')}Copy</button></div>`;}
  function runtimeRow(runtime){
    const saved=existing(runtime),models=chatModels(runtime),busy=state.busy===runtime.type;
    let status,body='',action='';
    if(runtime.running){
      status=`<span class="status-pill ready"><i class="dot"></i>Running · ${models.length} ${models.length===1?'model':'models'}</span>`;
      body=models.length?`<p class="lm-models">${esc(models.slice(0,4).map(model=>shortModelName(model.id,model.name)).join(', '))}${models.length>4?` and ${models.length-4} more`:''}</p>`:`<p class="lm-hint">No models yet. ${runtime.type==='ollama'?'Download one with <code>ollama pull &lt;model&gt;</code>.':'Start the server with <code>--model</code> and a model from Hugging Face.'}</p>`;
      body+=runtime.type==='ollama'?cloudNote(runtime):'';
      action=saved?`<span class="tag">Added as ${esc(saved.name)}</span><button type="button" class="secondary-button" data-action="assign-provider" data-id="${esc(saved.id)}">Use for a bot</button>`:models.length?`<button type="button" class="primary-button" data-local-action="use" data-type="${esc(runtime.type)}" ${busy?'disabled aria-busy="true"':''}>${busy?'Adding…':'Use'}</button>`:'';
    }else{
      const missing=runtime.installed===false;
      status=`<span class="status-pill"><i class="dot"></i>${missing?'Not installed':runtime.conflict?'Port in use by another program':'Not running'}</span>`;
      body=`${missing?`<p class="lm-hint"><a href="${esc(runtime.installUrl)}" target="_blank" rel="noopener noreferrer">Get ${esc(runtime.name)}</a>, then start it in Terminal:</p>`:`<p class="lm-hint">Start it in Terminal, then check again:</p>`}${command(runtime.startCommand,`${runtime.name} start command`)}${(runtime.alternativeCommands||[]).length?`<p class="lm-hint">Or, for images and a prefix cache, MLX VLM:</p>${runtime.alternativeCommands.map(text=>command(text,'MLX VLM start command')).join('')}`:''}${!missing&&runtime.installed!==true?`<p class="lm-hint">Not installed yet? <a href="${esc(runtime.installUrl)}" target="_blank" rel="noopener noreferrer">Get ${esc(runtime.name)}</a>.</p>`:''}`;
      action=saved?`<span class="tag">Added as ${esc(saved.name)}</span>`:'';
    }
    return `<article class="lm-runtime" data-runtime="${esc(runtime.type)}"><div class="lm-runtime-head"><div><h3>${esc(runtime.name)}${runtime.version?` <small>${esc(runtime.version)}</small>`:''}</h3>${status}</div><div class="lm-runtime-actions">${action}</div></div>${body}</article>`;
  }
  /** Local connections hosted by another engine (the paired Mac), from the connections the engine shares. */
  function pairedRows(){
    const rows=(context?.data?.connections||[]).filter(remote);
    return rows.map(connection=>{const where=hostOf(connection),online=where.online!==false;return `<article class="lm-runtime" data-connection="${esc(connection.id)}"><div class="lm-runtime-head"><div><h3>${esc(connection.name)}</h3><span class="status-pill ${online?'ready':'error'}"><i class="dot"></i>${online?'Mac online':'Mac offline'}</span></div></div><p class="lm-hint">Runs on ${esc(where.name||'your Mac')}. ${online?'Bots here can use its models.':'Bots on its models use their fallback model until the Mac is back, or stop if they have none.'}</p></article>`;}).join('');
  }
  function content(){
    if(!state.loaded)return `<p class="lm-hint" role="status">${state.loading?'Checking this machine for Ollama and MLX…':esc(state.error||'Couldn’t check this machine.')}</p>`;
    const mac=state.platform==='darwin',running=state.runtimes.some(runtime=>runtime.running),paired=pairedRows();
    if(!mac&&!running)return paired||`<p class="lm-hint">This engine is a server, not a Mac. Local models run on your Mac: open Tupies there, choose <strong>Use</strong> next to Ollama or MLX in Settings › Models, and bots here can use them once the Mac is linked to this engine.</p>`;
    return `${state.runtimes.map(runtimeRow).join('')}${paired}`;
  }
  /** "On this Mac" on a Mac engine; "On this engine" when a server runs a runtime itself; "On your Mac" otherwise. */
  const title=()=>!state.platform||state.platform==='darwin'?'On this Mac':state.runtimes.some(runtime=>runtime.running)?'On this engine':'On your Mac';
  function card(ctx){
    context=ctx;
    return `<section class="glass-card lm-card" data-local-models aria-labelledby="lm-title"><div class="lm-card-head"><div><h2 id="lm-title">${title()}</h2><p>Run models on your own Mac with Ollama or MLX. Nothing leaves the machine, and use is free.</p></div><button type="button" class="secondary-button" data-local-action="refresh" ${state.loading?'disabled':''}>${ctx.icon('sync')}Check again</button></div><p class="form-error lm-error" role="alert">${esc(state.loaded?state.error:'')}</p><div class="lm-runtimes" data-local-content aria-busy="${state.loading}">${content()}</div></section>`;
  }
  function paint(){
    if(!current())return;const root=host.querySelector('[data-local-models]');
    const heading=root.querySelector('#lm-title');if(heading)heading.textContent=title();
    const node=root.querySelector('[data-local-content]');node.innerHTML=content();node.setAttribute('aria-busy',String(state.loading));
    const error=root.querySelector('.lm-error');error.textContent=state.loaded?state.error:'';
    const refresh=root.querySelector('[data-local-action="refresh"]');if(refresh)refresh.disabled=state.loading;
  }
  async function load(){
    const ctx=context,token=++request;state.loading=true;state.error='';paint();
    try{const result=await ctx.api('/api/local-runtimes');if(token!==request)return;state.platform=String(result?.platform||'');state.runtimes=Array.isArray(result?.runtimes)?result.runtimes.filter(item=>item&&LOCAL_TYPES.has(item.type)):[];state.loaded=true;}
    catch(error){if(token===request){state.error=ctx.errorText?ctx.errorText(error):String(error?.message||error);state.loaded=state.loaded||false;}}
    finally{if(token===request){state.loading=false;paint();}}
  }
  function mount(ctx,root){context=ctx;host=root;if(!root.querySelector('[data-local-models]'))return;void load();}
  /** One click: add the running runtime as a provider named "Mac · Ollama" / "Mac · MLX", with its first chat model as default. */
  async function use(type){
    const ctx=context,runtime=state.runtimes.find(item=>item.type===type);if(!ctx||!runtime||state.busy)return;
    state.busy=type;state.error='';paint();
    try{
      const name=`Mac · ${SHORT[type]||runtime.name}`,model=chatModels(runtime)[0]?.id||'';
      const created=await ctx.api('/api/connections',{method:'POST',body:{type,name,baseUrl:runtime.baseUrl,...(model?{defaultModel:model}:{})}});
      const id=created?.id||created?.connection?.id;let checked=true;
      if(id){try{await ctx.api(`/api/connections/${encodeURIComponent(id)}/test`,{method:'POST',body:{}});}catch{checked=false;}}
      await ctx.refresh?.(false);
      ctx.toast(checked?`${name} added. Choose it for a bot under On my Mac in the model picker.`:`${name} added, but its first check failed. Test it below.`,!checked);
    }catch(error){state.error=ctx.errorText?ctx.errorText(error):String(error?.message||error);}
    finally{state.busy='';paint();}
  }
  async function copy(text){
    try{await navigator.clipboard.writeText(text);context?.toast('Copied. Paste it into Terminal.');}
    catch{context?.toast('Copy is unavailable here. Select the command and copy it.',true);}
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-local-action]');if(!button||!context||button.disabled)return;
    event.preventDefault();const action=button.dataset.localAction;
    if(action==='refresh')void load();else if(action==='use')void use(button.dataset.type);else if(action==='copy')void copy(button.dataset.command||'');
  });
  function reset(){request++;context=null;host=null;state={loaded:false,loading:false,error:'',platform:'',runtimes:[],busy:''};}

  window.StudioLocalModels={isLocal,hostOf,offline,remote,shortModelName,modelBadges,modelNote,badgesMarkup,supportsTools,isEmbedding,failureText,stateText,card,mount,reset,_state:()=>state};
})();
