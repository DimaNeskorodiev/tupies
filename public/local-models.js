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
  const DRAFT=/(^|[-_/])(mtp|draft|eagle3?|dflash)([-_]|$)/i; // speculative-decoding draft heads, as DRAFT_MODEL in lib/local-models.mjs
  function isEmbedding(model){const id=typeof model==='string'?model:model?.id;return model?.embedding===true||EMBEDDING.test(String(id||''))||DRAFT.test(String(id||''));}

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

  /* ---- Settings › Models: On this Mac / On your Mac ---- */
  const fresh=()=>({checkedAt:0,loaded:false,loading:false,error:'',platform:'',engine:null,runtimes:[],macs:[],busy:'',setup:null,done:null,arrived:'',focus:''});
  let context=null,host=null,request=0,state=fresh();
  const current=()=>Boolean(context&&host?.isConnected&&host.querySelector('[data-local-models]'));
  const SHORT={ollama:'Ollama',mlx:'MLX'};
  const FALLBACK_START={ollama:'ollama serve',mlx:'mlx_lm.server --model <model> --port 8080'};
  const reduced=()=>{try{return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;}catch{return false;}};
  const errorOf=(ctx,error)=>ctx?.errorText?ctx.errorText(error):String(error?.message||error);
  const chatModels=runtime=>(runtime?.models||[]).filter(model=>!isEmbedding(model)&&!model.cloud);
  const cloudModels=runtime=>(runtime.models||[]).filter(model=>model.cloud);
  const cloudNote=runtime=>{const n=cloudModels(runtime).length;return n?`<p class="lm-hint">${n} cloud ${n===1?'model runs':'models run'} on ollama.com, not on this Mac, so ${n===1?'it is':'they are'} not listed here.</p>`:'';};
  /** The home server (hub) of linked engines. Its card lists the linked Macs' runtimes (`macs`), detected through the relay. */
  const hub=()=>state.engine?.role==='hub';
  const runtimesOf=list=>Array.isArray(list)?list.filter(item=>item&&LOCAL_TYPES.has(item.type)):[];
  /** #/connections?setup=local&bot=… → {bot}; null without the setup flag. */
  function setupFromHash(){
    const hash=String(window.location?.hash||''),at=hash.indexOf('?');if(at<0)return null;
    const params=new URLSearchParams(hash.slice(at+1));return params.get('setup')==='local'?{bot:String(params.get('bot')||'').slice(0,100)}:null;
  }
  const botOf=id=>id?(context?.botById?.(id)||(context?.data?.bots||[]).find(bot=>bot?.id===id)||null):null;
  /** "Mac · MLX" for a runtime on a Mac; "Server · MLX" for one the server runs itself. */
  function runtimeName(type,mac,platform=state.platform){return `${!mac&&platform&&platform!=='darwin'?'Server':'Mac'} · ${SHORT[type]||type}`;}
  /** A saved connection that already points at this runtime: on the linked Mac (`mac`), or on this engine. */
  function existing(runtime,mac=null){
    const connections=context?.data?.connections||[];
    if(mac)return connections.find(connection=>connection.type===runtime.type&&isLocal(connection)&&hostOf(connection)?.nodeId===mac.nodeId)||null;
    const origin=url=>{try{const parsed=new URL(url);return `${parsed.hostname.replace(/^localhost$/,'127.0.0.1')}:${parsed.port}`;}catch{return '';}};
    return connections.find(connection=>connection.type===runtime.type&&isLocal(connection)&&!remote(connection)&&origin(connection.baseUrl)===origin(runtime.baseUrl))||null;
  }
  function command(text,label){return `<div class="lm-command"><code>${esc(text)}</code><button type="button" class="text-button" data-local-action="copy" data-command="${esc(text)}" aria-label="Copy ${esc(label)}">${context.icon('copy')}Copy</button></div>`;}
  /** One runtime: running with Use, or stopped with its start command. `mac` is the linked Mac it runs on (hub only). */
  function runtimeRow(runtime,mac=null){
    const saved=existing(runtime,mac),models=chatModels(runtime),busy=state.busy===`${mac?.nodeId||''}:${runtime.type}`,bot=botOf(state.setup?.bot),where=mac?` on ${esc(mac.name||'your Mac')}`:'';
    let status,body='',action='';
    if(runtime.running){
      status=`<span class="status-pill ready"><i class="dot"></i>Running · ${models.length} ${models.length===1?'model':'models'}</span>`;
      body=models.length?`<p class="lm-models">${esc(models.slice(0,4).map(model=>shortModelName(model.id,model.name)).join(', '))}${models.length>4?` and ${models.length-4} more`:''}</p>`:`<p class="lm-hint">No models yet. ${runtime.type==='ollama'?'Download one with <code>ollama pull &lt;model&gt;</code>.':'Start the server with <code>--model</code> and a model from Hugging Face.'}</p>`;
      body+=runtime.type==='ollama'?cloudNote(runtime):'';
      action=saved?`<span class="tag">Added as ${esc(saved.name)}</span>${bot?`<button type="button" class="primary-button" data-local-action="assign" data-id="${esc(saved.id)}" ${state.busy?'disabled':''}>Use for ${esc(bot.name)}</button>`:`<button type="button" class="secondary-button" data-action="assign-provider" data-id="${esc(saved.id)}">Use for a bot</button>`}`:models.length?`<button type="button" class="primary-button" data-local-action="use" data-type="${esc(runtime.type)}"${mac?` data-node="${esc(mac.nodeId)}"`:''} ${busy?'disabled aria-busy="true"':state.busy?'disabled':''}>${busy?'Adding…':'Use'}</button>`:'';
    }else{
      const missing=runtime.installed===false;
      status=`<span class="status-pill"><i class="dot"></i>${missing?'Not installed':runtime.conflict?'Port in use by another program':'Not running'}</span>`;
      body=`${missing?`<p class="lm-hint"><a href="${esc(runtime.installUrl)}" target="_blank" rel="noopener noreferrer">Get ${esc(runtime.name)}</a>, then start it in Terminal${where}:</p>`:`<p class="lm-hint">Start it in Terminal${where}, then check again:</p>`}${command(runtime.startCommand||FALLBACK_START[runtime.type]||'',`${runtime.name} start command`)}${(runtime.alternativeCommands||[]).length?`<p class="lm-hint">Or, for images and a prefix cache, MLX VLM:</p>${runtime.alternativeCommands.map(text=>command(text,'MLX VLM start command')).join('')}`:''}${!missing&&runtime.installed!==true&&runtime.installUrl?`<p class="lm-hint">Not installed yet? <a href="${esc(runtime.installUrl)}" target="_blank" rel="noopener noreferrer">Get ${esc(runtime.name)}</a>.</p>`:''}`;
      action=saved?`<span class="tag">Added as ${esc(saved.name)}</span>`:'';
    }
    return `<article class="lm-runtime" data-runtime="${esc(runtime.type)}"${mac?` data-node="${esc(mac.nodeId)}"`:''}><div class="lm-runtime-head"><div><h3>${esc(runtime.name||SHORT[runtime.type]||runtime.type)}${runtime.version?` <small>${esc(runtime.version)}</small>`:''}</h3>${status}</div><div class="lm-runtime-actions">${action}</div></div>${body}</article>`;
  }
  /** Hub: each linked Mac with the runtimes it reported, or why there is nothing to show. */
  function macRows(){
    if(!state.macs.length)return `<p class="lm-hint lm-empty">No Mac is linked to this engine yet. Open Tupies on your Mac, link it to this engine in Settings › Devices &amp; sync, and start Ollama or MLX there. Its models then show up here.</p>`;
    return state.macs.map(mac=>{
      const name=mac.name||'Your Mac';
      if(!mac.online)return `<article class="lm-runtime lm-mac-offline" data-mac="${esc(mac.nodeId)}"><div class="lm-runtime-head"><div><h3>${esc(name)}</h3><span class="status-pill error"><i class="dot"></i>Offline</span></div></div><p class="lm-hint">Open Tupies on ${esc(name)} and keep the Mac awake, then choose Check again. Its models show up here while it is online.</p></article>`;
      const runtimes=runtimesOf(mac.runtimes);
      return `<div class="lm-mac" data-mac="${esc(mac.nodeId)}"><p class="lm-mac-name">${esc(name)}<span class="status-pill ready"><i class="dot"></i>Online</span></p>${mac.error?`<p class="lm-hint lm-mac-error">${esc(mac.error)}</p>`:''}${runtimes.map(runtime=>runtimeRow(runtime,mac)).join('')||(mac.error?'':`<p class="lm-hint">${esc(name)} didn’t report Ollama or MLX. Choose Check again in a moment.</p>`)}</div>`;
    }).join('');
  }
  /** Local connections hosted by another engine (the paired Mac), from the connections the engine shares. */
  function pairedRows(){
    const rows=(context?.data?.connections||[]).filter(connection=>remote(connection)&&!state.macs.some(mac=>mac.nodeId===hostOf(connection).nodeId));
    return rows.map(connection=>{const where=hostOf(connection),online=where.online!==false;return `<article class="lm-runtime" data-connection="${esc(connection.id)}"><div class="lm-runtime-head"><div><h3>${esc(connection.name)}</h3><span class="status-pill ${online?'ready':'error'}"><i class="dot"></i>${online?'Mac online':'Mac offline'}</span></div></div><p class="lm-hint">Runs on ${esc(where.name||'your Mac')}. ${online?'Bots here can use its models.':'Bots on its models use their fallback model until the Mac is back, or stop if they have none.'}</p></article>`;}).join('');
  }
  function content(){
    if(!state.loaded)return `<p class="lm-hint" role="status">${state.loading?'Checking this machine for Ollama and MLX…':esc(state.error||'Couldn’t check this machine.')}</p>`;
    if(hub()){const own=state.runtimes.filter(runtime=>runtime.running);return `${macRows()}${own.length?`<p class="lm-mac-name">On this server</p>${own.map(runtime=>runtimeRow(runtime)).join('')}`:''}${pairedRows()}`;}
    const mac=state.platform==='darwin',running=state.runtimes.some(runtime=>runtime.running),paired=pairedRows();
    if(!mac&&!running)return paired||`<p class="lm-hint">This engine is a server, not a Mac. Local models run on your Mac: open Tupies there, choose <strong>Use</strong> next to Ollama or MLX in Settings › Models, and bots here can use them once the Mac is linked to this engine.</p>`;
    return `${state.runtimes.map(runtime=>runtimeRow(runtime)).join('')}${paired}`;
  }
  /** "On your Mac" on the home server and on a server without a runtime; "On this Mac" on a Mac; "On this engine" otherwise. */
  const title=()=>hub()?'On your Mac':!state.platform||state.platform==='darwin'?'On this Mac':state.runtimes.some(runtime=>runtime.running)?'On this engine':'On your Mac';
  const description=()=>hub()?'Use the models running on your linked Mac with Ollama or MLX. They run on the Mac, and use is free.':'Run models on your own Mac with Ollama or MLX. Nothing leaves the machine, and use is free.';
  const doneText=done=>`${done.botName} now uses ${done.modelName?`${done.modelName} on your Mac`:done.connectionName}.`;
  /** Arrived from the chat (#/connections?setup=local&bot=…): what Use will do, or what it did. */
  function setupLine(){
    const done=state.done;
    if(done)return `<div class="lm-done${done.error?' is-warning':''}" role="status"><p>${done.error?`${esc(done.connectionName)} is added, but ${esc(done.botName)} couldn’t switch to it: ${esc(done.error)} Choose it in the chat’s model panel under On my Mac.`:`<strong>${esc(doneText(done))}</strong>`}</p><button type="button" class="primary-button" data-local-action="back" data-bot="${esc(done.botId)}">${context.icon('chat')}Back to chat</button></div>`;
    if(!state.setup)return '';const bot=botOf(state.setup.bot);
    return `<div class="lm-setup-line"><p>${bot?`Choose <strong>Use</strong> next to a running model, and ${esc(bot.name)} switches to it. There is nothing to fill in.`:'Choose <strong>Use</strong> next to a running model to add it. There is nothing to fill in.'}</p>${bot?`<button type="button" class="text-button" data-local-action="back" data-bot="${esc(bot.id)}">${context.icon('back')}Back to chat</button>`:''}</div>`;
  }
  function card(ctx){
    context=ctx;state.setup=setupFromHash();if(!state.setup)state.done=null;
    const setup=!!state.setup;
    return `<section class="glass-card lm-card${setup?' is-setup':''}" data-local-models aria-labelledby="lm-title"${setup?' tabindex="-1"':''}><div class="lm-card-head"><div><h2 id="lm-title">${title()}</h2><p class="lm-description">${description()}</p></div><button type="button" class="secondary-button" data-local-action="refresh" ${state.loading?'disabled':''}>${ctx.icon('sync')}Check again</button></div><div class="lm-setup" data-local-setup-line>${setupLine()}</div><p class="form-error lm-error" role="alert">${esc(state.loaded?state.error:'')}</p><div class="lm-runtimes" data-local-content aria-busy="${state.loading}">${content()}</div></section>`;
  }
  function paint(){
    if(!current())return;const root=host.querySelector('[data-local-models]');
    const heading=root.querySelector('#lm-title');if(heading)heading.textContent=title();
    const text=root.querySelector('.lm-description');if(text)text.textContent=description();
    const line=root.querySelector('[data-local-setup-line]');if(line)line.innerHTML=setupLine();
    const node=root.querySelector('[data-local-content]');node.innerHTML=content();node.setAttribute('aria-busy',String(state.loading));
    const error=root.querySelector('.lm-error');error.textContent=state.loaded?state.error:'';
    const refresh=root.querySelector('[data-local-action="refresh"]');if(refresh)refresh.disabled=state.loading;
    if(state.focus==='done'){const back=root.querySelector('.lm-done [data-local-action="back"]');if(back){state.focus='';back.focus?.({preventScroll:true});}}
  }
  /** GET /api/local-runtimes. The engine caches the answer for 30 s; `refresh` (Check again) asks it to look now. */
  async function detect(ctx,{refresh=false}={}){
    const result=await ctx.api(`/api/local-runtimes${refresh?'?refresh=1':''}`);
    const engine=result?.engine&&typeof result.engine==='object'?result.engine:null;
    const macs=(Array.isArray(result?.macs)?result.macs:[]).filter(mac=>mac&&typeof mac==='object'&&mac.nodeId).map(mac=>({...mac,name:String(mac.name||''),online:mac.online===true,runtimes:runtimesOf(mac.runtimes)}));
    return {platform:String(result?.platform||engine?.platform||''),engine,runtimes:runtimesOf(result?.runtimes),macs};
  }
  async function load({refresh=false}={}){
    const ctx=context,token=++request;state.loading=true;state.error='';paint();
    try{const result=await detect(ctx,{refresh});if(token!==request)return;Object.assign(state,result,{loaded:true,checkedAt:Date.now()});}
    catch(error){if(token===request){state.error=errorOf(ctx,error);state.loaded=state.loaded||false;}}
    finally{if(token===request){state.loading=false;paint();}}
  }
  /** Arriving from the chat focuses and highlights the card once; after a Use it focuses Back to chat. */
  function mount(ctx,root){
    context=ctx;host=root;const node=root.querySelector('[data-local-models]');if(!node)return;
    const hash=String(window.location?.hash||'');
    if(state.setup&&state.arrived!==hash){
      state.arrived=hash;node.classList.add('is-arriving');window.setTimeout(()=>node.classList.remove('is-arriving'),2400);
      node.focus?.({preventScroll:true});node.scrollIntoView?.({block:'start',behavior:reduced()?'auto':'smooth'});
    }
    paint();void load();
  }
  /** Switch the bot from the setup link to the new provider through the same validated route as the chat panel. */
  async function switchBot(ctx,bot,{id,name,defaultModel}){
    try{
      const result=await ctx.api(`/api/bots/${encodeURIComponent(bot.id)}/inference`,{method:'PATCH',body:{connectionId:id,model:defaultModel||''}});
      const model=result?.bot?.model||defaultModel||'';
      return {botId:bot.id,botName:bot.name,connectionName:name,modelName:model?shortModelName(model):'',error:''};
    }catch(error){return {botId:bot.id,botName:bot.name,connectionName:name,modelName:'',error:errorOf(ctx,error)};}
  }
  /** After a local provider is added (Use, or Connect in the dialog): check it once, then switch the setup bot to it. */
  async function connected(ctx,{id,name,defaultModel,test=null}){
    context=context||ctx;
    // The engine checks a new local provider while creating it and returns `test`; an older engine is asked once here.
    // A failed check still created the provider (status 'error'): it is shown with Test in the list below.
    let checked=true,problem='';
    if(test&&typeof test==='object'){checked=test.connected!==false;problem=checked?'':String(test.error||'');}
    else if(id){try{await ctx.api(`/api/connections/${encodeURIComponent(id)}/test`,{method:'POST',body:{}});}catch(error){checked=false;problem=errorOf(ctx,error);}}
    const setup=state.setup||setupFromHash(),bot=id?botOf(setup?.bot):null;
    // An empty model means the provider default; the engine picks one for a new local provider and returns it.
    const done=bot?await switchBot(ctx,bot,{id,name,defaultModel:defaultModel||''}):null;
    if(done){state.done=done;state.focus='done';}
    // A full render shows the new provider below and turns this runtime's Use into "Added as …".
    await ctx.refresh?.(true);
    if(!checked)ctx.toast(`${name} added, but its first check failed${problem?`: ${problem.replace(/\.$/,'')}`:''}. Test it again below.`,true);
    else if(done?.error)ctx.toast(`${name} added. ${done.botName} kept its model.`,true);
    else if(!done)ctx.toast(`${name} added. Choose it for a bot under On my Mac in the model picker.`);
    return done;
  }
  /** One click: add the running runtime as a provider ("Mac · Ollama" / "Mac · MLX") with its first chat model as default.
      On the home server the runtime belongs to a linked Mac (`hostNodeId`); that Mac serves it through the relay. */
  async function use(type,nodeId=''){
    const ctx=context,mac=nodeId?state.macs.find(item=>item.nodeId===nodeId):null,runtime=(mac?mac.runtimes:state.runtimes).find(item=>item.type===type);
    if(!ctx||!runtime||state.busy||(nodeId&&!mac))return;
    state.busy=`${nodeId}:${type}`;state.error='';paint();
    try{
      // The home server only adds a Mac's runtime it checked in the last 5 minutes; older data is checked again first.
      if(mac&&Date.now()-state.checkedAt>4*60_000){const result=await detect(ctx);Object.assign(state,result,{loaded:true,checkedAt:Date.now()});if(!state.macs.some(item=>item.nodeId===nodeId&&item.online))throw new Error(`${mac.name||'Your Mac'} is offline now. Open Tupies on it, then check again.`);}
      const name=runtimeName(type,mac),model=chatModels(runtime)[0]?.id||'';
      const created=await ctx.api('/api/connections',{method:'POST',body:{type,name,...(runtime.baseUrl?{baseUrl:runtime.baseUrl}:{}),...(mac?{hostNodeId:mac.nodeId}:{}),...(model?{defaultModel:model}:{})}});
      const saved=created?.connection||created||{};
      await connected(ctx,{id:saved.id,name:saved.name||name,defaultModel:saved.defaultModel||model,test:created?.test||saved.test||null});
    }catch(error){state.error=errorOf(ctx,error);}
    finally{state.busy='';paint();}
  }
  /** The runtime is already a provider: switch the setup bot to it. */
  async function assign(connectionId){
    const ctx=context,connection=(ctx?.data?.connections||[]).find(item=>item.id===connectionId),bot=botOf(state.setup?.bot);if(!ctx||!connection||!bot||state.busy)return;
    state.busy='assign';state.error='';paint();
    try{state.done=await switchBot(ctx,bot,{id:connection.id,name:connection.name,defaultModel:connection.defaultModel||''});state.focus='done';await ctx.refresh?.(true);}
    finally{state.busy='';paint();}
  }
  function back(botId){
    const ctx=context,done=state.done,notice=done&&!done.error&&done.botId===botId?doneText(done):'';if(!ctx||!botId)return;
    state.done=null;
    if(ctx.returnToChat)ctx.returnToChat(botId,notice);else{ctx.navigate?.(`/bot/${encodeURIComponent(botId)}`);if(notice)ctx.toast?.(notice);}
  }
  async function copy(text){
    try{await navigator.clipboard.writeText(text);context?.toast('Copied. Paste it into Terminal.');}
    catch{context?.toast('Copy is unavailable here. Select the command and copy it.',true);}
  }

  /* ---- Add provider › Ollama / MLX: one Connect button, no fields ---- */
  const isRuntimeType=type=>LOCAL_TYPES.has(type);
  /** Where a runtime of `type` was found: this engine, a linked Mac (hub), or why it wasn't. */
  function locate(type,found){
    const own=found.runtimes.find(item=>item.type===type)||null,server=!!found.platform&&found.platform!=='darwin';
    if(own?.running)return {runtime:own,mac:null,place:server?'this server':'this Mac',server};
    if(found.engine?.role==='hub'){
      const online=found.macs.filter(mac=>mac.online);
      for(const mac of online){const runtime=mac.runtimes.find(item=>item.type===type&&item.running);if(runtime)return {runtime,mac,place:mac.name||'your Mac'};}
      if(online.length){const mac=online[0];return {runtime:mac.runtimes.find(item=>item.type===type)||null,mac,place:mac.name||'your Mac'};}
      if(found.macs.length)return {offline:found.macs[0]};
      return {noMac:true};
    }
    return {runtime:own,mac:null,place:server?'this server':'this Mac',server};
  }
  function detectMarkup(type,label,where){
    const again=`<button type="button" class="text-button" data-local-action="detect">${context.icon('sync')}Check again</button>`,elsewhere='<p class="lm-hint">A model server at another address? Open <strong>Advanced</strong>.</p>';
    if(where.noMac)return `<p class="lm-hint">No Mac is linked to this engine yet. Open Tupies on your Mac and link it to this engine in Settings › Devices &amp; sync, then check again.</p>${again}${elsewhere}`;
    if(where.offline)return `<p class="lm-detect-status"><span class="status-pill error"><i class="dot"></i>${esc(where.offline.name||'Your Mac')} is offline</span></p><p class="lm-hint">Open Tupies on your Mac so this engine can reach it, then check again.</p>${again}`;
    const runtime=where.runtime,place=esc(where.place);
    if(runtime?.running){
      const models=chatModels(runtime),name=runtimeName(type,where.mac,where.server?'linux':'darwin');
      return `<p class="lm-detect-status"><span class="status-pill ready"><i class="dot"></i>Running on ${place} · ${models.length} ${models.length===1?'model':'models'}</span></p><p class="lm-hint">${models.length?`Connect adds it as “${esc(name)}” with ${esc(shortModelName(models[0].id,models[0].name))} as the default model. Bots can choose another of its models later.`:`It has no models yet. ${type==='ollama'?'Download one with <code>ollama pull &lt;model&gt;</code>':'Start the server with <code>--model</code> and a model from Hugging Face'}, then check again.`}</p>${models.length?'':again}`;
    }
    const start=runtime?.startCommand||FALLBACK_START[type]||'';
    return `<p class="lm-detect-status"><span class="status-pill"><i class="dot"></i>${runtime?.installed===false?'Not installed':'Not running'} on ${place}</span></p><p class="lm-hint">${esc(label)} isn’t running on ${place}. Start it in Terminal${where.mac?' on that Mac':''}, then check again:</p>${command(start,`${label} start command`)}${runtime?.installUrl&&runtime.installed!==true?`<p class="lm-hint">Not installed yet? <a href="${esc(runtime.installUrl)}" target="_blank" rel="noopener noreferrer">Get ${esc(runtime.name||label)}</a>.</p>`:''}${where.server?'<p class="lm-hint">Local models usually run on your Mac: open Tupies there and connect it from Settings › Models.</p>':''}${again}${elsewhere}`;
  }
  /** Fill the Connect dialog's status from GET /api/local-runtimes, and set its automatic name and host. */
  async function detectInto(ctx,form){
    if(!form)return;context=context||ctx;
    const type=form.dataset.localRuntime,label=form.dataset.localLabel||SHORT[type]||type,box=form.querySelector('[data-local-detect]');if(!box||!isRuntimeType(type))return;
    const token=String(Number(form.dataset.detectRequest||0)+1);form.dataset.detectRequest=token;
    box.setAttribute('aria-busy','true');box.innerHTML=`<p class="lm-hint">Looking for ${esc(label)}…</p>`;
    let found;
    try{found=await detect(ctx,{refresh:form.dataset.detectRequest!=='1'});}
    catch(error){if(form.isConnected&&form.dataset.detectRequest===token){box.setAttribute('aria-busy','false');box.innerHTML=`<p class="lm-hint">Couldn’t check for ${esc(label)}: ${esc(errorOf(ctx,error))}</p><button type="button" class="text-button" data-local-action="detect">${ctx.icon('sync')}Check again</button><p class="lm-hint">You can still connect, or set an address under <strong>Advanced</strong>.</p>`;}return;}
    if(!form.isConnected||form.dataset.detectRequest!==token)return;
    const where=locate(type,found),mac=where.mac||where.offline||null,hostField=form.querySelector('[name="hostNodeId"]'),nameField=form.querySelector('[name="name"]');
    if(hostField){hostField.value=mac?.nodeId||'';hostField.disabled=!mac;}
    if(nameField)nameField.value=runtimeName(type,mac,where.server?'linux':'darwin');
    form.dataset.detected=where.runtime?.running?'running':where.noMac?'no-mac':where.offline?'offline':'stopped';
    box.setAttribute('aria-busy','false');box.innerHTML=detectMarkup(type,label,where);
  }

  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-local-action]');if(!button||!context||button.disabled)return;
    event.preventDefault();const action=button.dataset.localAction;
    if(action==='refresh')void load({refresh:true});else if(action==='use')void use(button.dataset.type,button.dataset.node||'');else if(action==='copy')void copy(button.dataset.command||'');
    else if(action==='assign')void assign(button.dataset.id);else if(action==='back')back(button.dataset.bot);else if(action==='detect')void detectInto(context,button.closest('form'));
  });
  // Leaving the setup link forgets its arrival and result, so coming back from the chat starts fresh.
  window.addEventListener?.('hashchange',()=>{if(String(window.location?.hash||'')!==state.arrived){state.arrived='';state.done=null;}});
  function reset(){request++;context=null;host=null;state=fresh();}

  window.StudioLocalModels={isLocal,hostOf,offline,remote,shortModelName,modelBadges,modelNote,badgesMarkup,supportsTools,isEmbedding,failureText,stateText,card,mount,reset,isRuntimeType,detectInto,connected,_state:()=>state};
})();
