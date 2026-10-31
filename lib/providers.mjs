import { HttpError, ensure, string } from './store.mjs';
import { serviceRequest, requireSuccess, validateServiceUrl } from './provider-net.mjs';
import { ChatGPTSignIn } from './oauth.mjs';
import { catalogContextWindow, safeContextWindow } from './context-budget.mjs';
import {markProviderFailure,providerFailure,carryProviderFailure,clearProviderFailure,transportFailureCode} from './provider-failure.mjs';

const CATALOG=[
  {type:'openai',name:'OpenAI',baseUrl:'https://api.openai.com/v1',auth:'api-key',transport:'responses'},
  {type:'chatgpt',name:'ChatGPT / Codex subscription',baseUrl:'https://api.openai.com/v1',auth:'oauth',transport:'responses',setupMode:'local',note:'Continue with ChatGPT for eligible plan usage. Local/open-source self-hosted registration is supported; paid or remotely hosted offerings require OpenAI onboarding.'},
  {type:'anthropic',name:'Anthropic',baseUrl:'https://api.anthropic.com/v1',auth:'api-key',transport:'messages'},
  {type:'xai',name:'xAI Grok',baseUrl:'https://api.x.ai/v1',auth:'api-key',transport:'chat-completions'},
  {type:'openrouter',name:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1',auth:'api-key',transport:'chat-completions'},
  {type:'ollama',name:'Ollama',baseUrl:'http://127.0.0.1:11434/v1',auth:'none',transport:'chat-completions'},
  {type:'custom',name:'OpenAI-compatible API',baseUrl:'',auth:'api-key',transport:'chat-completions'}
];
const definition=type=>CATALOG.find(provider=>provider.type===type);
const CHATGPT_TOOL_NAMESPACE='tupies';
const textOf=content=>typeof content==='string'?content:Array.isArray(content)?content.map(block=>block.text || '').join(''):'';
const callsOf=(message,upstreamStatus=null)=>(message.tool_calls || []).map(call=>({id:call.id,name:call.function.name,arguments:parseArguments(call.function.arguments,upstreamStatus)}));
const EFFORTS=new Set(['none','minimal','low','medium','high','xhigh','max']);
const noReasoning=()=>({supported:false,efforts:[],defaultEffort:'',parameter:null,source:'unavailable'});
const reasoningParameter=type=>['openai','chatgpt'].includes(type)?'reasoning.effort':['xai','openrouter'].includes(type)?'reasoning_effort':null;

/** Use explicit catalog declarations only; a familiar model name is not a capability. */
export function modelReasoning(type,record={}) {
  const parameter=reasoningParameter(type);if(!parameter)return noReasoning();
  if(parameter==='reasoning_effort' && !(Array.isArray(record.supported_parameters) && record.supported_parameters.includes('reasoning_effort')))return noReasoning();
  const declared=Array.isArray(record.supported_reasoning_levels)?record.supported_reasoning_levels:Array.isArray(record.supported_reasoning_efforts)?record.supported_reasoning_efforts:[];
  const efforts=[...new Set(declared.slice(0,32).map(item=>typeof item==='string'?item:item?.effort).filter(value=>EFFORTS.has(value)))];
  if(!efforts.length)return noReasoning();
  const requestedDefault=record.default_reasoning_level ?? record.default_reasoning_effort;
  return {supported:true,efforts,defaultEffort:efforts.includes(requestedDefault)?requestedDefault:'',parameter,source:'provider'};
}

/** Recheck persisted capabilities before they become an outbound request field. */
export function safeReasoning(type,value) {
  const parameter=reasoningParameter(type);
  if(!parameter || value?.supported!==true || value.parameter!==parameter || value.source!=='provider' || !Array.isArray(value.efforts))return noReasoning();
  const efforts=[...new Set(value.efforts.filter(item=>EFFORTS.has(item)))].slice(0,7);
  return efforts.length?{supported:true,efforts,defaultEffort:efforts.includes(value.defaultEffort)?value.defaultEffort:'',parameter,source:'provider'}:noReasoning();
}
export function reasoningForModel(connection,model) {return safeReasoning(connection.type,connection.models?.find(item=>item.id===model)?.reasoning);}
/** Resolve a bot preference without guessing unsupported provider parameters or changing its saved choice. */
export function effectiveReasoningEffort(preference,reasoning) {
  const effort=preference==='auto' || preference===undefined?'high':preference;
  return reasoning?.supported===true && reasoning.efforts?.includes(effort)?effort:'';
}

/** Whether a catalog record says the model takes image input. A record that says nothing is unknown, not a no. */
export function modelImages(record={}) {
  for(const list of [record.input_modalities,record.architecture?.input_modalities,record.modalities?.input,record.capabilities?.input_modalities])
    if(Array.isArray(list))return {supported:list.some(item=>typeof item==='string' && /^image/i.test(item)),source:'provider'};
  if(Array.isArray(record.capabilities))return {supported:record.capabilities.includes('vision'),source:'provider'};
  for(const value of [record.capabilities?.vision,record.capabilities?.image_input?.supported])if(typeof value==='boolean')return {supported:value,source:'provider'};
  return null;
}
export function safeImages(value) {return value && typeof value.supported==='boolean' && ['provider','provider-error'].includes(value.source)?{supported:value.supported,source:value.source}:null;}
// Families known to take images, used only when the catalog says nothing. A wrong guess is caught: a refused image is
// retried without it and the model is remembered as text-only.
const KNOWN_IMAGE_MODELS=[['chatgpt',''],['openai','gpt-4o'],['openai','gpt-4.1'],['openai','gpt-4.5'],['openai','gpt-5'],['openai','gpt-6'],['openai','o1'],['openai','o3'],['openai','o4'],
  ['*','claude-3'],['*','claude-opus'],['*','claude-sonnet'],['*','claude-haiku'],['*','claude-fable'],['*','gemini'],['*','grok-4'],['*','grok-2-vision'],['*','grok-vision']];
const TEXT_ONLY_MODELS=/-spark|o1-mini|o3-mini|audio|realtime|transcribe|tts|embedding|search-preview/;
export function knownImageInput(type,model) {
  const id=String(model || '').toLowerCase();
  return !TEXT_ONLY_MODELS.test(id) && KNOWN_IMAGE_MODELS.some(([provider,fragment])=>(provider===type || provider==='*') && id.includes(fragment));
}
/** The owner's setting for the connection, then what the provider declared or refused, then a known family; otherwise no images. */
export function imagesForModel(connection,model) {
  if(connection?.imageInput==='on' || connection?.imageInput==='off')return {supported:connection.imageInput==='on',source:'owner'};
  const declared=safeImages(connection?.models?.find(item=>item.id===model)?.images);
  if(declared)return declared;
  return knownImageInput(connection?.type,model)?{supported:true,source:'known'}:{supported:false,source:'unknown'};
}
/** A provider refusal that names image input, as opposed to any other bad request. */
export function imageRejected(error) {
  const message=String(error?.message || '');
  return /HTTP (400|413|415|422)\b/.test(message) && /\b(image|images|vision|multimodal|multi-modal|modality|modalities|input_image|image_url)\b/i.test(message);
}

function catalogModel(type,item) {
  const id=item.id || item.slug || item.name;
  if(typeof id!=='string' || !id || id.length>200 || /[\x00-\x1f\x7f]/.test(id))return null;
  const label=item.display_name || item.name || id;
  const contextWindow=catalogContextWindow(item);
  const images=modelImages(item);
  return {id,name:(typeof label==='string'?label:id).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300),reasoning:modelReasoning(type,item),...(contextWindow?{contextWindow}:{}),...(images?{images}:{})};
}
function parseArguments(value,upstreamStatus=null){
  if(value && typeof value==='object' && !Array.isArray(value))return value;
  let parsed;try{parsed=JSON.parse(value || '{}');}catch{throw markProviderFailure(new HttpError(502,'The model returned invalid tool arguments. No tool was executed.'),'arguments_rejected',{upstreamStatus});}
  protocolEnsure(parsed && typeof parsed==='object' && !Array.isArray(parsed),'The model returned tool arguments that were not an object.','arguments_rejected',upstreamStatus);return parsed;
}
function protocolEnsure(condition,message,code='protocol_error',upstreamStatus=null){if(!condition)throw markProviderFailure(new HttpError(502,message),code,{upstreamStatus});}
export function responsesInput(messages,{namespace}={}){
  const input=[];
  const scoped=item=>{if(!namespace || item.type!=='function_call')return item;protocolEnsure(item.namespace==null || item.namespace===namespace,'Stored tool history has an unexpected function namespace.','namespace_rejected');return {...item,namespace};};
  for(const message of messages){
    if(['system','developer'].includes(message.role))continue;
    if(message.role==='tool'){input.push({type:'function_call_output',call_id:message.tool_call_id,output:textOf(message.content),...(namespace?{namespace}:{})});continue;}
    if(message.role==='assistant' && Array.isArray(message.providerItems) && message.providerItems.length && message.providerItems.every(item=>['message','function_call','reasoning','web_search_call','file_search_call'].includes(item.type))){input.push(...message.providerItems.map(scoped));continue;}
    if(message.role==='user' && message.imageParts?.length)input.push({role:'user',content:[...message.imageParts.map(image=>({type:'input_image',image_url:`data:${image.mediaType};base64,${image.data}`})),{type:'input_text',text:textOf(message.content)}]});
    else if(textOf(message.content))input.push({role:message.role,content:textOf(message.content)});
    for(const call of message.tool_calls || [])input.push(scoped({type:'function_call',call_id:call.id,name:call.function.name,arguments:call.function.arguments}));
  }
  return input;
}
export function anthropicMessages(messages){
  const result=[];
  const append=(role,blocks)=>{if(!blocks.length)return;const previous=result.at(-1);if(previous?.role===role)previous.content.push(...blocks);else result.push({role,content:blocks});};
  for(const message of messages){
    if(['system','developer'].includes(message.role))continue;
    if(message.role==='tool'){append('user',[{type:'tool_result',tool_use_id:message.tool_call_id,content:textOf(message.content),...(message.is_error===true?{is_error:true}:{})}]);continue;}
    let blocks=[];
    if(message.role==='assistant' && Array.isArray(message.providerItems) && message.providerItems.every(item=>['text','tool_use','thinking','redacted_thinking'].includes(item.type)))blocks=structuredClone(message.providerItems);
    else {
      if(message.role==='user')for(const image of message.imageParts || [])blocks.push({type:'image',source:{type:'base64',media_type:image.mediaType,data:image.data}});
      if(textOf(message.content))blocks.push({type:'text',text:textOf(message.content)});for(const call of message.tool_calls || [])blocks.push({type:'tool_use',id:call.id,name:call.function.name,input:parseArguments(call.function.arguments)});}
    append(message.role==='assistant'?'assistant':'user',blocks);
  }
  return result;
}

/**
 * Anthropic caches a prompt prefix only up to explicit breakpoints (four at most, one is the system prompt). Mark the last
 * three messages, skipping the engine's per-step turn context so each mark falls on content the next step repeats.
 */
export function anthropicCacheMarks(messages){
  let marks=0;
  for(let index=messages.length-1;index>=0 && marks<3;index--){
    const blocks=messages[index].content,target=blocks.findLastIndex(block=>!(block.type==='text' && block.text.startsWith('<turn_context>')));
    if(target<0 || ['thinking','redacted_thinking'].includes(blocks[target].type))continue;
    blocks[target]={...blocks[target],cache_control:{type:'ephemeral'}};marks++;
  }
  return messages;
}

export class Providers {
  constructor(store,options={}){this.store=store;this.options=options;this.oauth=new ChatGPTSignIn(store,options);}
  catalog(){return CATALOG.map(provider=>({...provider,...(provider.type==='chatgpt'?{setupMode:(this.options.hostedDeployment ?? process.env.STUDIO_DEPLOYMENT_MODE==='hosted')?'hosted':'local'}:{})}));}
  defaults(type){const provider=definition(type);ensure(provider,400,'Choose a supported model provider.');return {...provider};}
  validate(input,previous={}){
    const type=input.type || previous.type || 'openai',provider=this.defaults(type),changed=!!previous.type && previous.type!==type;
    const value={...previous,type,name:Object.hasOwn(input,'name')?string(input.name,'Provider name',100):previous.name || provider.name};
    if(changed){delete value.secret;delete value.oauthSecret;delete value.oauthAccount;delete value.models;value.status='untested';}
    value.baseUrl=(Object.hasOwn(input,'baseUrl')?string(input.baseUrl,'API base URL',2000,false):changed?provider.baseUrl:previous.baseUrl || provider.baseUrl).replace(/\/+$/,'');
    if(!value.baseUrl)value.baseUrl=provider.baseUrl;
    if(previous.baseUrl && value.baseUrl!==previous.baseUrl){delete value.secret;delete value.oauthSecret;delete value.oauthAccount;value.status='untested';}
    const url=validateServiceUrl(value.baseUrl,{allowPrivateHttp:this.options.allowPrivateHttp ?? process.env.STUDIO_ALLOW_PRIVATE_HTTP==='true'});
    ensure(!url.search && !url.hash,400,'Provider base URL must not contain query parameters or fragments.');
    if(type==='chatgpt')ensure(value.baseUrl===provider.baseUrl || this.options.allowTestOAuth===true,400,'ChatGPT access tokens can only be sent to the official OpenAI API.');
    if(Object.hasOwn(input,'defaultModel'))value.defaultModel=string(input.defaultModel,'Default model',200,false);
    value.defaultModel ||= '';
    if(Object.hasOwn(input,'maxOutputTokens')){ensure(Number.isInteger(input.maxOutputTokens) && input.maxOutputTokens>=256 && input.maxOutputTokens<=32768,400,'Output limit must be 256–32768 tokens.');value.maxOutputTokens=input.maxOutputTokens;}
    value.maxOutputTokens ||= 4096;
    // A local or compatible service may not publish its window; the owner can state it. Empty means automatic.
    if(Object.hasOwn(input,'contextWindow')){const window=safeContextWindow(input.contextWindow);ensure(window || input.contextWindow==='' || input.contextWindow===null,400,'Context window must be 4000–10000000 tokens, or empty for automatic.');if(window)value.contextWindow=window;else delete value.contextWindow;}
    // Whether models on this connection see attached images: automatic (catalog and known families), or the owner's choice.
    if(Object.hasOwn(input,'imageInput')){ensure(['auto','on','off'].includes(input.imageInput),400,'Image input must be automatic, on or off.');if(input.imageInput==='auto')delete value.imageInput;else value.imageInput=input.imageInput;}
    if(Object.hasOwn(input,'apiKey') && input.apiKey){const key=string(input.apiKey,'API key',8192);ensure(!/[\x00-\x1f\x7f]/.test(key),400,'API key cannot contain control characters.');ensure(type!=='chatgpt',400,'Use Continue with ChatGPT for subscription access.');value.secret=this.store.seal(key);value.status='untested';}
    if(provider.auth==='api-key' && type!=='custom')ensure(value.secret,400,'Add this provider’s API key.');
    if(changed || value.baseUrl!==previous.baseUrl || value.defaultModel!==previous.defaultModel){value.status='untested';delete value.models;delete value.error;}
    return value;
  }
  current(connection){return this.store.state.connections.find(item=>item.id===connection.id) || connection;}
  async headers(connection){
    connection=this.current(connection);const provider=this.defaults(connection.type);
    if(connection.type==='chatgpt')return {Authorization:`Bearer ${await this.oauth.bearer(connection)}`};
    const key=connection.secret?this.store.unseal(connection.secret):'';
    if(provider.auth==='api-key' && connection.type!=='custom')ensure(key,401,'Configure the provider API key before sending a task.');
    return connection.type==='anthropic'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:key?{Authorization:`Bearer ${key}`}:{ };
  }
  async request(connection,path,{signal,body,onSSE,method='GET',inference=false,timeoutMs}={}){
    connection=this.current(connection);this.defaults(connection.type);
    const base=connection.baseUrl || this.defaults(connection.type).baseUrl;
    if(connection.type==='chatgpt')ensure(base===definition('chatgpt').baseUrl || this.options.allowTestOAuth===true,400,'ChatGPT credentials require the official API endpoint.');
    let headersReady=false;
    try {
      const authorization=await this.headers(connection);headersReady=true;
      // Generation may reason silently or stream for several minutes. Catalog and sign-in requests keep their shorter limits.
      const configuredTimeout=inference?(this.options.inferenceTimeout || this.options.requestTimeout || 900_000):(this.options.requestTimeout || 120_000);
      const totalTimeout=timeoutMs===undefined?configuredTimeout:Math.min(configuredTimeout,timeoutMs);
      const response=await serviceRequest(`${base.replace(/\/+$/,'')}${path}`,{method,headers:{Accept:onSSE?'application/json, text/event-stream':'application/json',...authorization,...(body!==undefined?{'Content-Type':'application/json'}:{})},body,signal,onSSE,allowPrivateHttp:this.options.allowPrivateHttp ?? process.env.STUDIO_ALLOW_PRIVATE_HTTP==='true',timeoutMs:totalTimeout,...(inference?{idleTimeoutMs:Math.min(this.options.inferenceIdleTimeout || 300_000,totalTimeout)}:{})});
      return requireSuccess(response,this.defaults(connection.type).name);
    } catch(error){
      if(signal?.aborted){clearProviderFailure(error);throw signal.reason || error;}
      if(!providerFailure(error))markProviderFailure(error,headersReady?transportFailureCode(error):'authentication',{status:error instanceof HttpError?error.status:502});
      throw carryProviderFailure(error,new HttpError(error.status || 502,this.store.redact(error instanceof HttpError?error.message:'The provider could not be reached. Check its URL, credentials, and network access.')));
    }
  }
  async models(connection){
    const result=await this.request(connection,'/models');
    const records=Array.isArray(result.data?.data)?result.data.data:Array.isArray(result.data?.models)?result.data.models:[];
    ensure(records.length<=10_000,502,'Provider model catalog exceeded its size limit.');
    const models=records.filter(item=>item && typeof item==='object' && (connection.type!=='chatgpt' || !item.visibility || item.visibility==='list')).map(item=>catalogModel(connection.type,item)).filter(Boolean);
    return {models,source:'provider'};
  }
  async test(connection){const result=await this.models(connection);return {connected:true,...result,...(connection.type==='chatgpt'?{account:connection.oauthAccount || null}:{})};}
  /** Separate inference surface for bounded memory review, with the same credentialed transport. */
  async reviewMemory(connection,request){return this.complete(connection,request);}
  async complete(connection,{model,messages,turnContext='',tools=[],signal,onDelta,reasoningEffort='',reasoningCapabilities,cacheKey='',maxOutputTokens,timeoutMs}={}){
    let emissions=Promise.resolve();const consumerFailures=new Set();
    const emit=text=>{if(text && onDelta){const clean=this.store.redact(String(text));emissions=emissions.then(async()=>{try{await onDelta(clean);}catch(error){consumerFailures.add(error);throw error;}});void emissions.catch(()=>{});}};
    try {
    connection=this.current(connection);model=model || connection.defaultModel;ensure(typeof model==='string' && model.trim(),409,'Choose a model for this provider before sending a task.');
    if(timeoutMs!==undefined)ensure(Number.isFinite(timeoutMs)&&timeoutMs>=1,400,'Per-request timeout must be a positive duration.');
    if(maxOutputTokens!==undefined){ensure(Number.isInteger(maxOutputTokens) && maxOutputTokens>=256 && maxOutputTokens<=32768,400,'Per-request output limit must be 256–32768 tokens.');connection={...connection,maxOutputTokens:Math.min(connection.maxOutputTokens || 4096,maxOutputTokens)};}
    ensure(Array.isArray(messages) && messages.length && messages.length<=1000,400,'The provider needs a bounded conversation.');
    ensure(Array.isArray(tools) && tools.length<=100,400,'The provider tool catalog is too large.');
    const reasoning=safeReasoning(connection.type,reasoningCapabilities ?? reasoningForModel(connection,model));
    ensure(typeof reasoningEffort==='string' && (!reasoningEffort || (reasoning.supported && reasoning.efforts.includes(reasoningEffort))),409,'The selected model does not advertise this reasoning effort. Refresh its model settings.');
      // The engine's per-step context goes after the stored conversation; each protocol places a trailing user message itself.
      if(typeof turnContext==='string' && turnContext)messages=[...messages,{role:'user',content:turnContext.slice(0,200_000)}];
      const params={model,messages,tools,signal,emit,reasoningEffort,reasoning,timeoutMs,cacheKey:typeof cacheKey==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(cacheKey)?cacheKey:''};
      const result=await (['openai','chatgpt'].includes(connection.type)?this.responses(connection,params):connection.type==='anthropic'?this.anthropic(connection,params):this.compatible(connection,params));
      await emissions;return result;
    } catch(error){
      await emissions.catch(()=>{});
      if(signal?.aborted){clearProviderFailure(error);clearProviderFailure(signal.reason);throw signal.reason || error;}
      if(!consumerFailures.has(error))markProviderFailure(error,'protocol_error',{status:error instanceof HttpError?error.status:502});
      throw error;
    }
  }
  async responses(connection,{model,messages,tools,signal,emit,reasoningEffort,reasoning,cacheKey,timeoutMs}){
    let completed=null,failed=null;const outputItems=new Map();let streamed='';
    const subscription=connection.type==='chatgpt',functions=tools.map(tool=>({type:'function',name:tool.name,description:tool.description,parameters:tool.parameters,strict:false}));
    const streamItem=event=>outputItems.get(event.output_index) || [...outputItems.values()].find(item=>item.id && item.id===event.item_id);
    const response=await this.request(connection,'/responses',{method:'POST',signal,inference:true,timeoutMs,body:{model,...(reasoningEffort && reasoning.parameter==='reasoning.effort'?{reasoning:{effort:reasoningEffort}}:{}),instructions:messages.filter(message=>['system','developer'].includes(message.role)).map(message=>textOf(message.content)).join('\n\n'),input:responsesInput(messages,subscription?{namespace:CHATGPT_TOOL_NAMESPACE}:{}),...(cacheKey?{prompt_cache_key:cacheKey}:{}),...(tools.length?{tools:subscription?[{type:'namespace',name:CHATGPT_TOOL_NAMESPACE,description:'Tupies engine tools. Each action retains its engine permission checks.',tools:functions}]:functions,parallel_tool_calls:true}:{}),...(!subscription?{max_output_tokens:connection.maxOutputTokens || 4096}:{}),store:false,stream:true,include:['reasoning.encrypted_content']},onSSE:event=>{
      if(event.type==='response.output_text.delta'){streamed+=event.delta || '';emit(event.delta);}
      if(['response.output_item.added','response.output_item.done'].includes(event.type) && event.item && typeof event.item==='object')outputItems.set(event.output_index,structuredClone(event.item));
      if(event.type==='response.function_call_arguments.delta'){const item=streamItem(event);if(item?.type==='function_call')item.arguments=(item.arguments||'')+(event.delta||'');}
      if(event.type==='response.function_call_arguments.done'){const item=streamItem(event);if(item?.type==='function_call' && typeof event.arguments==='string')item.arguments=event.arguments;}
      if(event.type==='response.completed' || event.type==='response.incomplete')completed=event.response;
      if(event.type==='response.failed' || event.type==='error')failed=event.error || event.response?.error || {message:'The model request failed.'};
    }});
    const result=response.streaming?completed:response.data;
    if(failed)throw markProviderFailure(new HttpError(502,this.store.redact(`The model request failed: ${failed.message || 'provider error'}`)),'response_failed',{upstreamStatus:response.status});
    protocolEnsure(result && ['completed','incomplete'].includes(result.status),'The provider stream ended before a completed response. The request was not replayed.',result?.status==='failed'?'response_failed':'stream_interrupted',response.status);
    if(result.output!==undefined)protocolEnsure(Array.isArray(result.output),'The provider returned invalid response items.','protocol_error',response.status);
    const output=result.output?.length?result.output:[...outputItems.entries()].sort((a,b)=>a[0]-b[0]).map(([,item])=>item);
    protocolEnsure(Array.isArray(output),'The provider returned invalid response items.','protocol_error',response.status);
    const text=output.filter(item=>item.type==='message').flatMap(item=>item.content || []).filter(item=>['output_text','refusal'].includes(item.type)).map(item=>item.text || item.refusal || '').join('') || result.output_text || streamed;
    const toolCalls=output.filter(item=>item.type==='function_call').map(item=>{
      if(subscription)protocolEnsure(item.namespace===CHATGPT_TOOL_NAMESPACE && tools.some(tool=>tool.name===item.name),'The subscription provider returned a function outside the offered Tupies namespace.','namespace_rejected',response.status);
      return {id:item.call_id,name:item.name,arguments:parseArguments(item.arguments,response.status)};
    });
    for(const call of toolCalls)protocolEnsure(typeof call.id==='string' && typeof call.name==='string','The provider returned an incomplete tool call.','tool_call_invalid',response.status);
    if(result.status==='completed' && !text.trim() && !toolCalls.length){
      const knownTypes=['message','reasoning','function_call','web_search_call','file_search_call'],knownEvents=['response.created','response.in_progress','response.output_item.added','response.output_item.done','response.content_part.added','response.content_part.done','response.output_text.delta','response.output_text.done','response.function_call_arguments.delta','response.function_call_arguments.done','response.reasoning_summary_part.added','response.reasoning_summary_text.delta','response.reasoning_summary_text.done','response.reasoning_summary_part.done','response.completed','response.incomplete','response.failed','error'];
      const eventCounts={};for(const event of response.events||[]){const type=knownEvents.includes(event.type)?event.type:'other';eventCounts[type]=(eventCounts[type]||0)+1;}
      const types=[...new Set(output.map(item=>knownTypes.includes(item.type)?item.type:'other'))].join(',')||'none';
      throw markProviderFailure(new HttpError(502,`The provider completed without text or a tool call (final items: ${result.output?.length||0}; streamed items: ${outputItems.size}; types: ${types}; stream events: ${JSON.stringify(eventCounts)}).`),'empty_response',{upstreamStatus:response.status});
    }
    if(!response.streaming)emit(text);
    return {text:this.store.redact(text),toolCalls,usage:result.usage || {},providerItems:output,finishReason:result.status==='incomplete'?'length':toolCalls.length?'tool_calls':'stop',...(subscription?{outputLimit:{requestedTokens:connection.maxOutputTokens || 4096,enforcedByProvider:false,responseByteLimit:8_000_000}}:{})};
  }
  async anthropic(connection,{model,messages,tools,signal,emit,timeoutMs}){
    const blocks=new Map();let usage={},stopReason=null,finished=false,providerError=null;
    const system=messages.filter(message=>['system','developer'].includes(message.role)).map(message=>textOf(message.content)).join('\n\n');
    const response=await this.request(connection,'/messages',{method:'POST',signal,inference:true,timeoutMs,body:{model,max_tokens:connection.maxOutputTokens || 4096,system:system?[{type:'text',text:system,cache_control:{type:'ephemeral'}}]:'',messages:anthropicCacheMarks(anthropicMessages(messages)),...(tools.length?{tools:tools.map(tool=>({name:tool.name,description:tool.description,input_schema:tool.parameters}))}:{}),stream:true},onSSE:event=>{
      if(event.type==='message_start')usage={...event.message?.usage};
      if(event.type==='content_block_start')blocks.set(event.index,{...event.content_block,_input:''});
      if(event.type==='content_block_delta'){
        const block=blocks.get(event.index);if(!block)return;
        if(event.delta?.type==='text_delta'){block.text=(block.text || '')+event.delta.text;emit(event.delta.text);}
        if(event.delta?.type==='input_json_delta')block._input+=event.delta.partial_json || '';
        if(event.delta?.type==='thinking_delta')block.thinking=(block.thinking || '')+(event.delta.thinking || '');
        if(event.delta?.type==='signature_delta')block.signature=(block.signature || '')+(event.delta.signature || '');
      }
      if(event.type==='message_delta'){stopReason=event.delta?.stop_reason;usage={...usage,...event.usage};}
      if(event.type==='message_stop')finished=true;
      if(event.type==='error')providerError=event.error;
    }});
    if(providerError)throw markProviderFailure(new HttpError(502,this.store.redact(`Anthropic request failed: ${providerError.message || 'provider error'}`)),'response_failed',{upstreamStatus:response.status});
    protocolEnsure(!response.streaming || finished,'Anthropic stream ended before completion. The request was not replayed.','stream_interrupted',response.status);
    const content=response.streaming?[...blocks.entries()].sort((a,b)=>a[0]-b[0]).map(([,block])=>{const {_input,...item}=block;if(item.type==='tool_use' && _input)item.input=parseArguments(_input,response.status);return item;}):response.data?.content;
    protocolEnsure(Array.isArray(content),'Anthropic returned an invalid message.','protocol_error',response.status);
    const text=content.filter(item=>item.type==='text').map(item=>item.text).join(''),toolCalls=content.filter(item=>item.type==='tool_use').map(item=>({id:item.id,name:item.name,arguments:parseArguments(item.input,response.status)}));
    if(!response.streaming){emit(text);usage=response.data.usage || {};stopReason=response.data.stop_reason;}
    return {text:this.store.redact(text),toolCalls,usage,providerItems:content,finishReason:stopReason==='max_tokens'?'length':toolCalls.length?'tool_calls':'stop'};
  }
  async compatible(connection,{model,messages,tools,signal,emit,reasoningEffort,reasoning,timeoutMs}){
    let text='',finishReason=null,usage={};const calls=new Map();let done=false;
    const canonical=messages.map(({role,content,tool_calls,tool_call_id,imageParts})=>({role,content:role==='user' && imageParts?.length?[...imageParts.map(image=>({type:'image_url',image_url:{url:`data:${image.mediaType};base64,${image.data}`}})),{type:'text',text:textOf(content)}]:content || '',...(tool_calls?{tool_calls}:{}),...(tool_call_id?{tool_call_id}:{})}));
    const response=await this.request(connection,'/chat/completions',{method:'POST',signal,inference:true,timeoutMs,body:{model,...(reasoningEffort && reasoning.parameter==='reasoning_effort'?{reasoning_effort:reasoningEffort}:{}),messages:canonical,...(tools.length?{tools:tools.map(tool=>({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters}})),parallel_tool_calls:true}:{}),stream:true,stream_options:{include_usage:true},max_tokens:connection.maxOutputTokens || 4096},onSSE:(event,transport={})=>{
      if(event.error)throw markProviderFailure(new HttpError(502,String(event.error.message || 'The model request failed.')),'response_failed',{upstreamStatus:transport.status});
      if(event.usage)usage=event.usage;
      const choice=event.choices?.[0];if(!choice)return;
      if(choice.delta?.content){text+=choice.delta.content;emit(choice.delta.content);}
      for(const fragment of choice.delta?.tool_calls || []){const call=calls.get(fragment.index) || {id:'',name:'',arguments:''};if(fragment.id)call.id=fragment.id;if(fragment.function?.name)call.name+=fragment.function.name;call.arguments+=fragment.function?.arguments || '';calls.set(fragment.index,call);}
      if(choice.finish_reason){finishReason=choice.finish_reason;done=true;}
    }});
    let toolCalls;
    if(response.streaming){protocolEnsure(done,'The provider stream ended before a final result. The request was not replayed.','stream_interrupted',response.status);toolCalls=[...calls.values()].map(call=>({...call,arguments:parseArguments(call.arguments,response.status)}));}
    else {const choice=response.data?.choices?.[0];protocolEnsure(choice?.message,'The provider returned an invalid completion.','protocol_error',response.status);text=textOf(choice.message.content);toolCalls=callsOf(choice.message,response.status);usage=response.data.usage || {};finishReason=choice.finish_reason;emit(text);}
    return {text:this.store.redact(text),toolCalls,usage,finishReason:finishReason==='length'?'length':toolCalls.length?'tool_calls':'stop'};
  }
  loginStart(connection,params){ensure(connection.type==='chatgpt',400,'This provider uses an API key, not ChatGPT sign-in.');return this.oauth.start(this.current(connection),params);}
  loginStatus(connection){return this.oauth.status(this.current(connection));}
  loginCancel(connection){return this.oauth.cancel(this.current(connection));}
  loginCallback(params){return this.oauth.callback(params);}
  logout(connection){return this.oauth.logout(this.current(connection));}
  async close(){await this.oauth.close();}
}
