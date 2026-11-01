/* Native learning inside the bot profile. Draft files stay in browser memory until Start. */
(()=>{
const states=new Map(),ACTIVE=new Set(['preparing','running','waiting_approval','awaiting_approval']);
const PHASE={reading:'Reading material',selecting:'Selecting useful knowledge',comparing:'Comparing with existing knowledge',checking:'Checking knowledge',saving:'Saving knowledge',finished:'Finished'};
const STATUS={completed:'Complete',partial:'Partial result',failed:'Could not finish',blocked:'Needs attention',cancelled:'Stopped',interrupted:'Interrupted',expired:'Sources expired',preparing:'Preparing',running:'Learning'};
const DEFAULT_GROUPS=['workspace','memory','skills'];
const LIMITS={sources:20,sourceBytes:24_000_000,requestBytes:42_000_000};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const enc=encodeURIComponent;
const count=(value,word)=>`${Number(value)||0} ${word}${Number(value)===1?'':'s'}`;
const bytes=value=>`${((Number(value)||0)/1_000_000).toFixed(1)} MB`;
const errorText=(v,error)=>v.ctx?.errorText?v.ctx.errorText(error):error?.message||'The request could not finish.';
const apiPath=v=>`/api/bots/${enc(v.bot.id)}`;
function changed(v,kind){try{Promise.resolve(v.ctx.studyChanged?.(kind)).catch(()=>{});}catch{}}
const current=v=>!v.disposed&&states.get(v.bot.id)===v;
function staleView(){const error=new Error('This learning view belongs to an earlier session.');error.name='AbortError';return error;}
async function request(v,route,options){if(!current(v))throw staleView();const result=await v.ctx.api(route,options);if(!current(v))throw staleView();return result;}
function state(bot,ctx){
  let v=states.get(bot.id);
  if(!v){v={bot,ctx,disposed:false,readers:new Set(),files:[],focus:'',url:'',keepOriginal:false,audio:{enabled:false,connectionId:'',model:'',language:'',consent:false,catalog:[],loading:false,error:'',open:false},jobs:[],loaded:false,loading:false,lastFetched:0,error:'',notice:'',submitting:false,stopping:'',openJobs:new Set(),details:new Map(),timer:null,root:null,preview:null,reviewBusy:false,reviewError:'',inViewport:true};states.set(bot.id,v);}
  v.bot=bot;v.ctx=ctx;
  while(states.size>8){const [id,old]=states.entries().next().value;if(old===v)break;dispose(old);states.delete(id);}
  return v;
}
function capabilities(v){
  const groups=Array.isArray(v.bot.tools)?v.bot.tools:DEFAULT_GROUPS,missing=DEFAULT_GROUPS.filter(g=>!groups.includes(g));
  if(v.bot.enabled===false)return 'Resume this bot before starting learning.';
  if(missing.length)return 'Enable Files, Memory and Skills in this bot’s settings to learn from material.';
  const skills=v.ctx?.data?.skills;
  if(Array.isArray(skills)&&!skills.some(s=>(v.bot.skills||[]).includes(s.id)&&s.catalogId==='tupies-learn-from-material'))return 'Install Learn from material for this bot from the Skills catalog.';
  return '';
}
function busy(v){return v.jobs.some(job=>ACTIVE.has(job.status)) || v.ctx?.botStatus?.(v.bot)?.className==='working';}
function validation(v){
  const total=v.files.reduce((sum,file)=>sum+(Number(file.size)||0),0);
  if(v.files.length+(v.url.trim()?1:0)>LIMITS.sources)return `Choose at most ${LIMITS.sources} sources, including the video link.`;
  if(v.files.some(file=>!file.size||file.size>LIMITS.sourceBytes))return 'Choose nonempty files of at most 24 MB each.';
  if(total>LIMITS.requestBytes)return 'Choose files with a combined size of at most 42 MB per study.';
  if(v.files.some(file=>/\.wav$/i.test(file.name))&&!v.audio.enabled)return 'For WAV audio, enable audio transcription and choose its connection and model.';
  if(v.audio.enabled){if(!v.audio.connectionId||!v.audio.model||!v.audio.catalog.some(item=>item.id===v.audio.model))return 'Choose an available transcription connection and model.';if(v.audio.language&&!/^[a-z]{2,3}$/.test(v.audio.language))return 'Use a two- or three-letter lowercase language code, such as uk or en.';if(!v.audio.consent)return 'Allow the selected audio service to process this study before starting.';}
  if(v.url.trim())try{const url=new URL(v.url.trim());if(url.protocol!=='https:'||url.username||url.password||url.port||!['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(url.hostname.toLowerCase()))return 'Use a public HTTPS YouTube link, or upload a transcript.';}catch{return 'Enter a complete YouTube link beginning with https://.';}
  return '';
}
function fileList(v){return v.files.length?`<ul class="study-files">${v.files.map((file,index)=>`<li><span><strong>${esc(file.name)}</strong><small>${bytes(file.size)}</small></span><button type="button" class="text-button" data-study-action="remove-file" data-index="${index}" aria-label="Remove ${esc(file.name)}">Remove</button></li>`).join('')}</ul>`:'<p class="study-muted">No files selected.</p>';}
function audioHTML(v,id){
  const a=v.audio,connections=(v.ctx?.data?.connections||[]).filter(item=>item.type==='openrouter'&&item.hasKey),selected=connections.find(item=>item.id===a.connectionId);
  return `<details class="study-audio" data-study-audio-details${a.open?' open':''}><summary>Audio transcription <span class="study-optional">optional</span></summary><label class="bp-check"><input type="checkbox" data-study-input="audio-enabled"${a.enabled?' checked':''}><span>Transcribe uploaded PCM16 WAV audio<small>The selected speech service processes audio before this bot studies its transcript. YouTube links still use caption text.</small></span></label>${a.enabled?`<div class="study-audio-fields"><div class="field"><label for="${id}-audio-connection">OpenRouter connection</label><select id="${id}-audio-connection" data-study-input="audio-connection"><option value="">Choose a connection</option>${connections.map(item=>`<option value="${esc(item.id)}"${item.id===a.connectionId?' selected':''}>${esc(item.name)}</option>`).join('')}</select>${!connections.length?'<small>Add an OpenRouter connection in Models to configure transcription.</small>':''}</div><div class="field"><label for="${id}-audio-model">Transcription model</label><select id="${id}-audio-model" data-study-input="audio-model"${a.loading?' disabled':''}><option value="">${a.loading?'Loading available models…':'Choose a transcription model'}</option>${a.catalog.map(item=>`<option value="${esc(item.id)}"${item.id===a.model?' selected':''}>${esc(item.name||item.id)}</option>`).join('')}</select></div><div class="field"><label for="${id}-audio-language">Language code <span class="study-optional">optional</span></label><input id="${id}-audio-language" data-study-input="audio-language" value="${esc(a.language)}" placeholder="uk" maxlength="3" pattern="[a-z]{2,3}" autocomplete="off"></div><p class="bp-form-error" role="alert">${esc(a.error)}</p><label class="bp-check"><input type="checkbox" data-study-input="audio-consent"${a.consent?' checked':''}><span>Allow ${esc(selected?.name||'the selected OpenRouter connection')} and the selected model provider to process this study’s audio.<small>API usage is billed to this connection. No microphone recording or automatic service selection is used.</small></span></label></div>`:''}</details>`;
}
async function audioCatalog(v){
  const a=v.audio,connectionId=a.connectionId;a.catalog=[];a.model='';a.consent=false;a.error='';if(!connectionId){patch(v,'[data-study-audio]',audioHTML(v,`study-${v.bot.id}`));return;}a.loading=true;patch(v,'[data-study-audio]',audioHTML(v,`study-${v.bot.id}`));
  try{const catalog=await request(v,`/api/speech/catalog?connectionId=${enc(connectionId)}`);if(a.connectionId!==connectionId)return;a.catalog=Array.isArray(catalog.transcription)?catalog.transcription:[];if(!a.catalog.length)a.error='This connection has no available transcription models.';}catch(error){if(current(v)&&a.connectionId===connectionId)a.error=errorText(v,error);}finally{if(current(v)&&a.connectionId===connectionId){a.loading=false;patch(v,'[data-study-audio]',audioHTML(v,`study-${v.bot.id}`));controls(v);}}
}
function visible(v){return Boolean(v.root?.isConnected&&document.visibilityState!=='hidden'&&v.inViewport!==false&&!v.root.closest('[hidden]'));}
function dispose(v){v.disposed=true;clearTimeout(v.timer);v.timer=null;v.observer?.disconnect();v.root=null;for(const reader of v.readers)try{reader.abort();}catch{}v.readers.clear();v.files=[];v.focus='';v.url='';v.unit=null;v.preview=null;v.ctx=null;}
function capture(v){
  const active=document.activeElement;
  if(v.root?.contains(active)&&active.dataset.studyInput)v.focused={key:active.dataset.studyInput,start:active.selectionStart,end:active.selectionEnd};
}
function render(bot,ctx){
  const v=state(bot,ctx);capture(v);const id=`study-${bot.id.replace(/[^a-zA-Z0-9_-]/g,'')}`,off=capabilities(v);
  return `<section class="glass-card bp-card study-learning" data-study-learning data-study-bot="${esc(bot.id)}" aria-labelledby="${id}-heading">
    <header class="study-heading"><div><h2 id="${id}-heading">Learn from material</h2><p>Keep useful knowledge, methods and exceptions for ${esc(bot.name)}’s work.</p></div><button type="button" class="text-button" data-nav="/skills">Skills catalog</button></header>
    ${off?`<p class="study-capability" data-study-capability>${esc(off)}</p>`:''}
    <form data-study-form="start" class="study-form">
      <div class="field"><label for="${id}-files">Documents, images or transcripts</label><input id="${id}-files" type="file" multiple accept=".pdf,.docx,.md,.txt,.vtt,.srt,.png,.jpg,.jpeg,.webp,.wav" data-study-input="files" aria-describedby="${id}-file-hint"><small id="${id}-file-hint">PDF, DOCX, Markdown/text, VTT/SRT, PNG/JPEG/WebP or PCM16 WAV. Up to 20 sources, 24 MB per file and 42 MB combined. Images and scanned pages need supported image input; unreadable visuals stay explicit.</small><div data-study-files>${fileList(v)}</div></div>
      <div class="field"><label for="${id}-url">YouTube link <span class="study-optional">optional</span></label><input id="${id}-url" type="url" value="${esc(v.url)}" data-study-input="url" maxlength="2000" placeholder="https://www.youtube.com/watch?v=…" inputmode="url" autocomplete="off"><small>Uses accessible captions. The YouTube path does not inspect audio or video frames.</small></div>
      <div data-study-audio>${audioHTML(v,id)}</div>
      <div class="field"><label for="${id}-focus">Learning focus <span class="study-optional">optional</span></label><textarea id="${id}-focus" data-study-input="focus" maxlength="4000" rows="3" placeholder="What should ${esc(bot.name)} use this knowledge for?">${esc(v.focus)}</textarea><small>Leave blank to use this bot’s current role. Add a platform, project or topic to narrow what it retains.</small></div>
      <label class="bp-check study-retention"><input type="checkbox" data-study-input="keep"${v.keepOriginal?' checked':''}><span>Keep a local source copy<small>Otherwise complete, verified studies remove temporary originals and full extracts. Selected knowledge and short evidence remain. Incomplete studies retain local recovery material temporarily.</small></span></label>
      <p class="study-local-note">Selecting files keeps them on this device until you choose Start learning. Processing uses the bot’s configured model and permissions.</p>
      <p class="bp-form-error" data-study-error role="alert">${esc(v.error)}</p><p class="study-notice" data-study-notice role="status">${esc(v.notice)}</p>
      <div class="study-start"><span data-study-selection>${v.files.length?`${count(v.files.length,'file')} · ${bytes(v.files.reduce((sum,file)=>sum+file.size,0))}`:'Choose a file or add a video link.'}</span><button type="submit" class="primary-button" data-study-start${off||busy(v)||v.submitting||validation(v)||!v.files.length&&!v.url.trim()?' disabled':''}>${v.submitting?'Starting…':'Start learning'}</button></div>
    </form>
    <section class="study-history" aria-label="Learning studies"><div class="study-history-heading"><h3>Studies</h3><button type="button" class="text-button" data-study-action="refresh">Refresh</button></div><div data-study-jobs aria-live="polite">${jobsHTML(v)}</div></section>
    <div data-study-review>${reviewHTML(v)}</div><div data-study-unit>${unitHTML(v)}</div>
  </section>`;
}
function jobsHTML(v){
  if(!v.loaded)return `<p class="study-muted" role="status">${v.loading?'Opening studies…':'Your studies will appear here.'}</p>`;
  if(!v.jobs.length)return '<p class="study-muted">No studies yet. Start with material you want this bot to use in future tasks.</p>';
  return `<div class="study-jobs">${v.jobs.map(job=>jobHTML(v,job)).join('')}</div>`;
}
function jobHTML(v,job){
  const sources=Array.isArray(job.sources)?job.sources:[],active=ACTIVE.has(job.status),retained=Number(job.retained??job.result?.committedCount)||0,total=sources.reduce((sum,s)=>sum+(Number(s.coverage?.segments)||0),0),warnings=[...new Set(sources.flatMap(source=>source.warnings||[]).filter(value=>typeof value==='string'))],batches=job.result?.batches||[];
  const title=job.focus||sources[0]?.name||'Learning study',label=active?PHASE[job.phase]||STATUS[job.status]||'Learning':STATUS[job.status]||'Needs attention';
  const units=batches.flatMap(batch=>batch.units||[]).filter(unit=>unit.path&&unit.status==='committed');
  return `<article class="study-job" data-study-job="${esc(job.id)}"><header><strong>${esc(title)}</strong><span class="study-status${active?' is-active':''}${['partial','failed','blocked','interrupted'].includes(job.status)?' needs-attention':''}">${esc(label)}</span></header>
    <p class="study-counts">${count(sources.length,'source')} · ${Number(job.processed)||0}${total?` / ${total}`:''} segments processed · ${Number(job.candidates)||0} selected · ${retained} saved</p>
    ${job.error?`<p class="study-job-error">${esc(job.error)}</p>`:''}${warnings.length?`<p class="study-warning">${esc(warnings[0])}${warnings.length>1?' More details below.':''}</p>`:''}
    ${job.status==='completed'&&!retained?'<p class="study-muted">Processing finished without new retained knowledge.</p>':''}
    <details class="study-source-details" data-study-details="${esc(job.id)}"${v.openJobs.has(job.id)?' open':''}><summary>Sources, coverage and retention</summary><ul>${sources.map(source=>`<li><strong>${esc(source.name||'Source')}</strong><span>${esc(source.status||'Pending')}${source.availability==='expired'?' · original expired':''}${source.coverage?` · ${Number(source.coverage.readable)||0} readable segments · ${Number(source.coverage.failed)||0} gaps`:''}</span>${(source.warnings||[]).map(warning=>`<p>${esc(warning)}</p>`).join('')}</li>`).join('')}</ul><p>${job.cleanup==='expired'?'Temporary sources expired and are unavailable. Verified saved knowledge is preserved.':job.cleanup==='removed'?'Temporary originals and full extracts were removed. Compact evidence remains.':job.keepOriginal?'Source copies are kept locally on this engine by your choice.':job.cleanup==='retained'?'Source copies remain on this engine for review or recovery.':'Source copies are local while processing is incomplete.'}${job.expiresAt&&!['removed','expired'].includes(job.cleanup)&&!job.keepOriginal?` Recovery expiry: ${esc(v.ctx?.shortDate?v.ctx.shortDate(job.expiresAt):new Date(job.expiresAt).toLocaleDateString())}.`:''}</p></details>
    ${units.length?`<div class="study-unit-links" aria-label="Saved knowledge">${units.slice(0,8).map(unit=>`<button type="button" class="text-button" data-profile-action="open-note" data-path="${esc(unit.path)}">${esc(unit.title||'Open knowledge')}</button><button type="button" class="text-button study-manage-unit" data-study-action="unit" data-unit="${esc(unit.id)}" aria-label="Review or correct ${esc(unit.title||'knowledge')}">Review</button>`).join('')}${units.length>8?`<button type="button" class="text-button" data-profile-action="tab" data-tab="brain">All saved knowledge</button>`:''}</div>`:''}
    <div class="study-job-actions">${active?`<button type="button" class="secondary-button" data-study-action="stop" data-job="${esc(job.id)}"${v.stopping===job.id?' disabled':''}>${v.stopping===job.id?'Stopping…':'Stop'}</button>`:''}<button type="button" class="text-button" data-nav="/bot/${esc(v.bot.id)}">${active?'Open chat for details or approvals':'Open chat'}</button>${!active?batches.filter(batch=>batch.committedCount>0).map((batch,index)=>`<button type="button" class="text-button" data-study-action="rollback" data-batch="${esc(batch.id)}"${v.reviewBusy?' disabled':''}>Revert${batches.length>1?` batch ${index+1}`:' saved knowledge'}</button>`).join(''):''}</div>
  </article>`;
}
function reviewHTML(v){
  if(!v.preview)return v.reviewError?`<p class="bp-form-error" role="alert">${esc(v.reviewError)}</p>`:'';
  const {plan,kind}=v.preview,revert=kind==='rollback';
  return `<section class="study-review" aria-label="Review knowledge changes"><h3>${revert?'Review revert':'Review correction'}</h3><p>${revert?'Review the exact changes before reverting this batch. Newer edits are protected; saved source files are preserved.':'Review this exact correction before saving it to Brain.'}</p><details data-study-preview-details${v.preview.open?' open':''}><summary>${count(plan.actions?.length||0,'change')} to review</summary>${(plan.actions||[]).map(action=>`<div class="study-preview-action"><strong>${action.tool==='knowledge_deactivate'?'Remove from active recall':'Write knowledge revision'}</strong><code>${esc(action.args?.path)}</code><pre tabindex="0">${esc(action.args?.content||JSON.stringify(action.args,null,2))}</pre></div>`).join('')}</details><p class="bp-form-error" role="alert">${esc(v.reviewError)}</p><div class="study-review-actions"><button type="button" class="secondary-button" data-study-action="cancel-review"${v.reviewBusy?' disabled':''}>Cancel</button><button type="button" class="${revert?'danger-button':'primary-button'}" data-study-action="confirm-review"${v.reviewBusy?' disabled':''}>${v.reviewBusy?'Saving…':revert?'Confirm revert':'Save correction'}</button></div></section>`;
}
function methodCorrectionHTML(id,draft){
  return `<p class="study-muted">Review the method’s sequence and checks along with its explanation. Keep one item per line; steps run in the order shown.</p>${[['inputs','Method inputs',20,false],['steps','Ordered method steps',30,true],['outputs','Expected method outputs',20,false],['checks','Method verification checks',20,true]].map(([key,label,max,required])=>`<div class="field"><label for="${id}-method-${key}">${label} <span class="study-optional">${required?'required · ':''}one per line</span></label><textarea id="${id}-method-${key}" data-study-input="correction-method-${key}" rows="${key==='steps'?4:2}" maxlength="${max*1001}"${required?' required':''}>${esc(draft.method[key])}</textarea><small>${required?'1':0}–${max} items, up to 1000 characters each.</small></div>`).join('')}`;
}
function unitHTML(v){
  const detail=v.unit;if(!detail)return '';
  if(detail.loading)return '<p class="study-muted" role="status">Opening saved knowledge…</p>';
  if(detail.error)return `<p class="bp-form-error" role="alert">${esc(detail.error)}</p>`;
  const current=detail.value,unit=current.unit,draft=detail.draft,id=`study-unit-${current.id}`,scope=typeof unit.scope==='string'?unit.scope:JSON.stringify(unit.scope),method=unit.type==='method';
  return `<section class="study-unit-review" aria-labelledby="${id}"><header><h3 id="${id}">${esc(unit.title)}</h3><button type="button" class="text-button" data-study-action="close-unit">Close</button></header><p class="study-muted">Revision ${Number(current.revision)||1} · ${esc(unit.support)} support${method?' · source-derived, untested method':''}</p><p class="study-unit-content">${esc(unit.content)}</p><p class="study-muted">Applicability: ${esc(scope||'Not further specified')}</p>
    <details data-study-unit-disclosure="correction"${detail.open?.has('correction')?' open':''}><summary>Correct or scope this knowledge</summary><form data-study-form="correction"><div class="field"><label for="${id}-category">What changes?</label><select id="${id}-category" data-study-input="correction-category"><option value="incorrect"${draft.category==='incorrect'?' selected':''}>Incorrect claim</option><option value="missing-detail"${draft.category==='missing-detail'?' selected':''}>Missing condition or detail</option><option value="wrong-application"${draft.category==='wrong-application'?' selected':''}>Wrong application</option><option value="project-preference"${draft.category==='project-preference'?' selected':''}>Project-specific preference</option></select></div><div class="field"><label for="${id}-content">Corrected knowledge</label><textarea id="${id}-content" data-study-input="correction-content" rows="5" maxlength="12000" required>${esc(draft.content)}</textarea></div><div class="field"><label for="${id}-scope">Applicable project or scope</label><input id="${id}-scope" data-study-input="correction-scope" value="${esc(draft.scope)}" maxlength="3000"></div><div class="field"><label for="${id}-reason">Reason for the correction</label><textarea id="${id}-reason" data-study-input="correction-reason" rows="2" maxlength="1500" required>${esc(draft.reason)}</textarea></div><div class="field"><label for="${id}-conditions">Conditions <span class="study-optional">one per line</span></label><textarea id="${id}-conditions" data-study-input="correction-conditions" rows="2" maxlength="20000">${esc(draft.conditions)}</textarea></div><div class="field"><label for="${id}-exceptions">Exceptions <span class="study-optional">one per line</span></label><textarea id="${id}-exceptions" data-study-input="correction-exceptions" rows="2" maxlength="20000">${esc(draft.exceptions)}</textarea></div>${method?methodCorrectionHTML(id,draft):''}<button type="submit" class="secondary-button"${v.reviewBusy?' disabled':''}>Review correction</button></form></details>
    ${method?`<details data-study-unit-disclosure="method"${detail.open?.has('method')?' open':''}><summary>Propose a reusable Skill</summary><p class="study-muted">Creates a single-file suggestion for owner review. The method remains source-derived and untested; this does not install a skill or permit execution.</p><form data-study-form="method"><div class="field"><label for="${id}-name">New skill name</label><input id="${id}-name" data-study-input="method-name" value="${esc(draft.name)}" pattern="[a-z0-9][a-z0-9-]{0,63}" maxlength="64" required></div><div class="field"><label for="${id}-description">When to use it</label><textarea id="${id}-description" data-study-input="method-description" rows="2" maxlength="1000" required>${esc(draft.description)}</textarea></div><button type="submit" class="secondary-button"${v.reviewBusy?' disabled':''}>Propose for review</button></form></details>`:''}
    <p class="bp-form-error" data-study-unit-error role="alert">${esc(detail.notice||'')}</p></section>`;
}
function patch(v,selector,html){const node=v.root?.querySelector(selector);if(node&&node.innerHTML!==html)node.innerHTML=html;}
function controls(v){
  if(!v.root?.isConnected)return;
  const button=v.root.querySelector('[data-study-start]');if(button){button.disabled=Boolean(v.submitting||capabilities(v)||busy(v)||validation(v)||!v.files.length&&!v.url.trim());button.textContent=v.submitting?'Starting…':'Start learning';}
  const error=v.root.querySelector('[data-study-error]');if(error)error.textContent=v.error;
  const notice=v.root.querySelector('[data-study-notice]');if(notice)notice.textContent=v.notice;
  const selected=v.root.querySelector('[data-study-selection]');if(selected)selected.textContent=v.files.length?`${count(v.files.length,'file')} · ${bytes(v.files.reduce((sum,file)=>sum+file.size,0))}`:v.url.trim()?'1 video link selected.':'Choose a file or add a video link.';
  for(const field of v.root.querySelectorAll('.study-form [data-study-input]'))field.disabled=v.submitting||field.dataset.studyInput==='audio-model'&&v.audio.loading;
}
function schedule(v){clearTimeout(v.timer);v.timer=null;if(visible(v)&&v.jobs.some(job=>ACTIVE.has(job.status)))v.timer=setTimeout(()=>{v.timer=null;if(visible(v))void load(v);},2000);}
async function load(v,{force=false}={}){
  if(!visible(v)||v.loading)return;if(!force&&v.loaded&&Date.now()-v.lastFetched<1500){schedule(v);return;}
  v.loading=true;
  try{const result=await request(v,`${apiPath(v)}/studies`);v.jobs=Array.isArray(result.jobs)?result.jobs:[];v.loaded=true;v.lastFetched=Date.now();v.listError='';}
  catch(error){if(current(v)){v.listError=errorText(v,error);v.loaded=true;}}
  finally{if(current(v)){v.loading=false;patch(v,'[data-study-jobs]',`${v.listError?`<p class="bp-form-error" role="alert">${esc(v.listError)}</p>`:''}${jobsHTML(v)}`);controls(v);schedule(v);}}
}
function fileBytes(v,file){return new Promise((resolve,reject)=>{if(!current(v))return reject(staleView());const reader=new FileReader();v.readers.add(reader);const done=()=>v.readers.delete(reader);reader.onload=()=>{done();if(!current(v))return reject(staleView());resolve(String(reader.result||'').split(',')[1]||'');};reader.onerror=()=>{done();reject(new Error(`Could not read ${file.name}.`));};reader.onabort=()=>{done();reject(new Error('Reading the selected file was cancelled.'));};reader.readAsDataURL(file);});}
async function start(v){
  if(!current(v)||v.submitting)return;v.error=capabilities(v)||validation(v)||(!v.files.length&&!v.url.trim()?'Choose a file or add a video link.':'');if(!v.error&&busy(v))v.error='Wait for this bot’s current task before starting learning.';
  if(v.error){controls(v);return;}
  const selected={files:[...v.files],url:v.url.trim(),focus:v.focus.trim(),keepOriginal:v.keepOriginal,...(v.audio.enabled?{transcription:{connectionId:v.audio.connectionId,model:v.audio.model,...(v.audio.language?{language:v.audio.language}:{}),consent:true}}:{})};v.submitting=true;v.notice='';controls(v);
  try{const sources=[];for(const file of selected.files)sources.push({name:file.name,contentBase64:await fileBytes(v,file)});if(selected.url)sources.push({url:selected.url});const result=await request(v,`${apiPath(v)}/studies`,{method:'POST',body:{sources,focus:selected.focus,keepOriginal:selected.keepOriginal,...(selected.transcription?{transcription:selected.transcription}:{})}});if(result.job){v.jobs=[result.job,...v.jobs.filter(job=>job.id!==result.job.id)];v.loaded=true;}v.files=[];v.url='';v.root?.querySelector('[data-study-input="url"]')?.setAttribute('value','');const url=v.root?.querySelector('[data-study-input="url"]');if(url)url.value='';const input=v.root?.querySelector('[data-study-input="files"]');if(input)input.value='';patch(v,'[data-study-files]',fileList(v));v.notice='Learning started. Open chat for any requested approvals.';v.ctx.toast?.('Learning started.');changed(v,'study');}
  catch(error){if(current(v))v.error=errorText(v,error);}
  finally{if(current(v)){v.submitting=false;patch(v,'[data-study-jobs]',jobsHTML(v));controls(v);schedule(v);}}
}
async function stop(v,id){
  const job=v.jobs.find(item=>item.id===id);if(!current(v)||!job?.runId||v.stopping)return;v.stopping=id;patch(v,'[data-study-jobs]',jobsHTML(v));
  try{await request(v,`${apiPath(v)}/stop`,{method:'POST',body:{runId:job.runId,remoteRunId:job.remoteRunId||job.runId}});v.notice='Stop requested. Already saved knowledge is preserved.';await load(v,{force:true});changed(v,'study');}catch(error){if(current(v))v.error=errorText(v,error);}finally{if(current(v)){v.stopping='';controls(v);patch(v,'[data-study-jobs]',jobsHTML(v));}}
}
async function previewRollback(v,batchId){
  if(!current(v)||v.reviewBusy)return;v.reviewBusy=true;v.reviewError='';patch(v,'[data-study-jobs]',jobsHTML(v));
  try{const plan=await request(v,`${apiPath(v)}/knowledge/preview-rollback`,{method:'POST',body:{batchId}});v.preview={kind:'rollback',plan};}
  catch(error){if(current(v))v.reviewError=errorText(v,error);}
  finally{if(current(v)){v.reviewBusy=false;patch(v,'[data-study-review]',reviewHTML(v));patch(v,'[data-study-jobs]',jobsHTML(v));v.root?.querySelector('.study-review')?.scrollIntoView?.({block:'nearest',behavior:'auto'});}}
}
async function confirmReview(v){
  if(!current(v)||!v.preview||v.reviewBusy)return;v.reviewBusy=true;v.reviewError='';patch(v,'[data-study-review]',reviewHTML(v));
  try{const {plan,kind}=v.preview;await request(v,`${apiPath(v)}/knowledge/publish`,{method:'POST',body:{planId:plan.id,approvalDigest:plan.approvalDigest}});v.notice=kind==='rollback'?'Knowledge batch reverted. Original source files were preserved.':'Knowledge correction saved.';v.preview=null;v.unit=null;await load(v,{force:true});if(current(v))changed(v,'knowledge');}
  catch(error){if(current(v))v.reviewError=errorText(v,error);}
  finally{if(current(v)){v.reviewBusy=false;patch(v,'[data-study-review]',reviewHTML(v));patch(v,'[data-study-unit]',unitHTML(v));controls(v);}}
}
async function openUnit(v,id){
  if(!current(v))return;v.unit={loading:true};patch(v,'[data-study-unit]',unitHTML(v));
  try{const value=await request(v,`${apiPath(v)}/knowledge/units/${enc(id)}`),unit=value.unit,slug=String(unit.title||'learned-method').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50)||`learned-method-${id.slice(-8)}`;v.unit={value,draft:{category:'incorrect',content:unit.content,scope:typeof unit.scope==='string'?unit.scope:JSON.stringify(unit.scope),reason:'',conditions:(unit.conditions||[]).join('\n'),exceptions:(unit.exceptions||[]).join('\n'),...(unit.type==='method'?{method:Object.fromEntries(['inputs','steps','outputs','checks'].map(key=>[key,(unit.method?.[key]||[]).join('\n')]))}:{}),name:slug,description:`Use this source-derived method for ${typeof unit.scope==='string'?unit.scope:unit.title}.`.slice(0,1000)}};}
  catch(error){if(current(v))v.unit={error:errorText(v,error)};}
  if(current(v)){patch(v,'[data-study-unit]',unitHTML(v));v.root?.querySelector('.study-unit-review')?.scrollIntoView?.({block:'nearest',behavior:'auto'});}
}
async function correction(v){
  if(!current(v)||!v.unit?.value||v.reviewBusy)return;v.reviewBusy=true;v.reviewError='';const saved=v.unit.value,d=v.unit.draft;
  try{const lines=value=>value.split('\n').map(line=>line.trim()).filter(Boolean);let method;
    if(saved.unit.type==='method'){method=Object.fromEntries(['inputs','steps','outputs','checks'].map(key=>[key,lines(d.method[key])]));for(const key of ['inputs','steps','outputs','checks']){const min=['steps','checks'].includes(key)?1:0,max=key==='steps'?30:20;if(method[key].length<min||method[key].length>max||method[key].some(item=>item.length>1000))throw new Error(`Method ${key} need ${min}–${max} lines of at most 1000 characters each.`);}}
    const plan=await request(v,`${apiPath(v)}/knowledge/preview-correction`,{method:'POST',body:{unitId:saved.id,expectedSha256:saved.sha256,category:d.category,content:d.content,scope:d.scope,reason:d.reason,conditions:lines(d.conditions),exceptions:lines(d.exceptions),...(method?{method}:{})}});v.preview={kind:'correction',plan};}
  catch(error){if(current(v))v.reviewError=errorText(v,error);}
  finally{if(current(v)){v.reviewBusy=false;patch(v,'[data-study-review]',reviewHTML(v));}}
}
async function propose(v){
  if(!current(v)||!v.unit?.value||v.reviewBusy)return;v.reviewBusy=true;const saved=v.unit.value,d=v.unit.draft;
  try{await request(v,`${apiPath(v)}/knowledge/propose-method`,{method:'POST',body:{unitId:saved.id,expectedSha256:saved.sha256,name:d.name,description:d.description}});v.unit.notice='Skill suggested for owner review. It has not been installed or authorized to run.';v.ctx.toast?.('Skill suggested for review.');changed(v,'proposal');}
  catch(error){if(current(v)&&v.unit)v.unit.notice=errorText(v,error);}
  finally{if(current(v)){v.reviewBusy=false;patch(v,'[data-study-unit]',unitHTML(v));}}
}
function mount(bot,ctx,page=document){
  const v=state(bot,ctx),root=[...page.querySelectorAll('[data-study-learning]')].find(node=>node.dataset.studyBot===bot.id);if(!root)return;
  if(v.root!==root){clearTimeout(v.timer);v.observer?.disconnect();v.root=root;v.inViewport=true;if(window.IntersectionObserver){v.observer=new IntersectionObserver(entries=>{v.inViewport=entries[0]?.isIntersecting!==false;if(v.inViewport){schedule(v);if(!v.loaded)void load(v);}else{clearTimeout(v.timer);v.timer=null;}});v.observer.observe(root);}}
  if(!root.dataset.studyMounted){root.dataset.studyMounted='true';
    root.addEventListener('input',event=>{const key=event.target.dataset.studyInput;if(key==='focus')v.focus=event.target.value;if(key==='url')v.url=event.target.value;if(key==='audio-language')v.audio.language=event.target.value.trim().toLowerCase();if(key?.startsWith('correction-method-')&&v.unit?.draft?.method)v.unit.draft.method[key.slice(18)]=event.target.value;else if(key?.startsWith('correction-')&&v.unit?.draft)v.unit.draft[key.slice(11)]=event.target.value;if(key?.startsWith('method-')&&v.unit?.draft)v.unit.draft[key.slice(7)]=event.target.value;controls(v);});
    root.addEventListener('change',event=>{const key=event.target.dataset.studyInput;if(key==='files'){const selected=[...event.target.files||[]];for(const file of selected)if(!v.files.some(item=>item.name===file.name&&item.size===file.size&&item.lastModified===file.lastModified))v.files.push(file);event.target.value='';v.error=validation(v);patch(v,'[data-study-files]',fileList(v));}if(key==='keep')v.keepOriginal=event.target.checked;if(key==='audio-enabled'){v.audio.enabled=event.target.checked;v.audio.open=true;patch(v,'[data-study-audio]',audioHTML(v,`study-${v.bot.id}`));}if(key==='audio-connection'){v.audio.connectionId=event.target.value;void audioCatalog(v);}if(key==='audio-model'){v.audio.model=event.target.value;v.audio.consent=false;patch(v,'[data-study-audio]',audioHTML(v,`study-${v.bot.id}`));}if(key==='audio-consent')v.audio.consent=event.target.checked;if(key==='correction-category'&&v.unit?.draft)v.unit.draft.category=event.target.value;controls(v);});
    root.addEventListener('submit',event=>{const form=event.target.dataset.studyForm;if(!form)return;event.preventDefault();if(form==='start')void start(v);if(form==='correction')void correction(v);if(form==='method')void propose(v);});
    root.addEventListener('click',event=>{const button=event.target.closest('[data-study-action]');if(!button||!root.contains(button)||button.disabled)return;const action=button.dataset.studyAction;if(action==='remove-file'){v.files.splice(Number(button.dataset.index),1);v.error=validation(v);patch(v,'[data-study-files]',fileList(v));controls(v);}if(action==='refresh')void load(v,{force:true});if(action==='stop')void stop(v,button.dataset.job);if(action==='rollback')void previewRollback(v,button.dataset.batch);if(action==='cancel-review'){v.preview=null;v.reviewError='';patch(v,'[data-study-review]',reviewHTML(v));}if(action==='confirm-review')void confirmReview(v);if(action==='unit')void openUnit(v,button.dataset.unit);if(action==='close-unit'){v.unit=null;patch(v,'[data-study-unit]','');}});
    root.addEventListener('toggle',event=>{const id=event.target.dataset.studyDetails;if(id){if(event.target.open)v.openJobs.add(id);else v.openJobs.delete(id);}if(event.target.hasAttribute('data-study-audio-details'))v.audio.open=event.target.open;if(event.target.hasAttribute('data-study-preview-details')&&v.preview)v.preview.open=event.target.open;const disclosure=event.target.dataset.studyUnitDisclosure;if(disclosure&&v.unit){v.unit.open||=new Set();if(event.target.open)v.unit.open.add(disclosure);else v.unit.open.delete(disclosure);}},true);
  }
  if(v.focused){const field=[...root.querySelectorAll('[data-study-input]')].find(node=>node.dataset.studyInput===v.focused.key);if(field){field.focus({preventScroll:true});try{field.setSelectionRange(v.focused.start,v.focused.end);}catch{}}v.focused=null;}
  controls(v);if(!v.loaded||Date.now()-v.lastFetched>5000)void load(v);else schedule(v);
}
document.addEventListener('visibilitychange',()=>{for(const v of states.values()){clearTimeout(v.timer);v.timer=null;if(visible(v)){if(v.jobs.some(job=>ACTIVE.has(job.status)))void load(v,{force:true});else schedule(v);}}});
window.addEventListener('pagehide',()=>{for(const v of states.values())dispose(v);states.clear();});
window.StudioStudyLearning={render,mount,clear(){for(const v of states.values())dispose(v);states.clear();}};
})();
