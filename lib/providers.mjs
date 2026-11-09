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
  // Direct API-key presets on the OpenAI-compatible transport. Base URLs follow each provider's OpenAI-compatibility docs
  // (api-docs.deepseek.com, ai.google.dev/gemini-api/docs/openai, console.groq.com/docs/openai, docs.mistral.ai, docs.together.ai,
  // docs.fireworks.ai, docs.z.ai, platform.kimi.ai/docs/api/overview, platform.minimax.io/docs/api-reference/text-openai-api).
  {type:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com',auth:'api-key',transport:'chat-completions'},
  {type:'gemini',name:'Google Gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai',auth:'api-key',transport:'chat-completions'},
  {type:'groq',name:'Groq',baseUrl:'https://api.groq.com/openai/v1',auth:'api-key',transport:'chat-completions'},
  {type:'mistral',name:'Mistral',baseUrl:'https://api.mistral.ai/v1',auth:'api-key',transport:'chat-completions'},
  {type:'together',name:'Together AI',baseUrl:'https://api.together.xyz/v1',auth:'api-key',transport:'chat-completions'},
  {type:'fireworks',name:'Fireworks AI',baseUrl:'https://api.fireworks.ai/inference/v1',auth:'api-key',transport:'chat-completions'},
  {type:'zai',name:'Z.ai (GLM)',baseUrl:'https://api.z.ai/api/paas/v4',auth:'api-key',transport:'chat-completions'},
  {type:'moonshot',name:'Moonshot (Kimi)',baseUrl:'https://api.moonshot.ai/v1',auth:'api-key',transport:'chat-completions'},
  {type:'minimax',name:'MiniMax',baseUrl:'https://api.minimax.io/v1',auth:'api-key',transport:'chat-completions'},
  {type:'ollama',name:'Ollama',baseUrl:'http://127.0.0.1:11434/v1',auth:'none',transport:'chat-completions'},
  {type:'custom',name:'OpenAI-compatible API',baseUrl:'',auth:'api-key',transport:'chat-completions'}
];
const definition=type=>CATALOG.find(provider=>provider.type===type);
const CHATGPT_TOOL_NAMESPACE='tupies';
// Keep the full native catalog (including Browser/Workshop/Missions) within a finite
// transport budget. 128 matches the documented Chat Completions function limit;
// the native-catalog regression checks every adapter as the Engine adds tools.
const MAX_PROVIDER_TOOLS=128;
const textOf=content=>typeof content==='string'?content:Array.isArray(content)?content.map(block=>block.text || '').join(''):'';
const callsOf=(message,upstreamStatus=null)=>(message.tool_calls || []).map(call=>({id:call.id,name:call.function.name,arguments:parseArguments(call.function.arguments,upstreamStatus)}));
const EFFORTS=new Set(['none','minimal','low','medium','high','xhigh','max']);
const noReasoning=()=>({supported:false,efforts:[],defaultEffort:'',parameter:null,source:'unavailable'});
const reasoningParameter=type=>['openai','chatgpt'].includes(type)?'reasoning.effort':['xai','openrouter'].includes(type)?'reasoning_effort':null;
// Request fields a preset profile may name per connection type ('custom' resolves its profile from the base-URL host).
// 'reasoning' = OpenRouter {effort}; 'thinking' = Anthropic thinking; 'thinking.type' = DeepSeek/GLM {type:'enabled'|'disabled'}.
const PRESET_PARAMETERS={openrouter:['reasoning'],anthropic:['thinking'],deepseek:['thinking.type'],zai:['thinking.type'],gemini:['reasoning_effort'],xai:['reasoning_effort'],custom:['reasoning','thinking.type','reasoning_effort']};
const PRESET_HOSTS={'openrouter.ai':'openrouter','api.deepseek.com':'deepseek','api.z.ai':'zai','open.bigmodel.cn':'zai','generativelanguage.googleapis.com':'gemini','api.x.ai':'xai'};
/** The preset profile a connection follows: its type, or for an OpenAI-compatible connection the provider its base URL names. */
export function presetKey(connection={}) {
  if(connection?.type!=='custom')return connection?.type || '';
  let host='';try{host=new URL(connection.baseUrl || '').hostname.toLowerCase();}catch{}
  return PRESET_HOSTS[host] || 'custom';
}
const modelTail=model=>String(model || '').toLowerCase().split('/').pop();
const capability=(parameter,efforts,source='preset')=>({supported:efforts.length>0,efforts,defaultEffort:'',parameter:efforts.length?parameter:null,source});
// Anthropic: manual budgets for Claude 3.7 and 4.0-4.5; adaptive thinking with output_config.effort for 4.6 and later, which
// reject (4.7+) or deprecate (4.6) budget_tokens. Claude 5 thinks by default and only returns thinking text with
// display:'summarized'. https://platform.claude.com/docs/en/build-with-claude/extended-thinking and .../thinking, .../effort
export const ANTHROPIC_BUDGETS={low:2048,medium:8192,high:16384,xhigh:32768};
const ANTHROPIC_BUDGET_MODELS=/^claude-(3-7-|(opus|sonnet)-4(-[015])?(-\d{8}|-latest)?$|haiku-4-5)/;
const ANTHROPIC_ADAPTIVE_MODELS=/^claude-((opus|sonnet)-4-[6-9]|(opus|sonnet|haiku|fable|mythos)-[5-9](-|$)|mythos-preview)/;
export function anthropicThinking(model) {
  const id=modelTail(model);
  if(ANTHROPIC_ADAPTIVE_MODELS.test(id)) {
    const alwaysOn=!/^claude-(opus|sonnet)-4-/.test(id),xhigh=!/^claude-(opus|sonnet)-4-6|mythos-preview/.test(id);
    return {mode:'adaptive',alwaysOn,efforts:[...(alwaysOn?[]:['none']),'low','medium','high',...(xhigh?['xhigh']:[]),'max']};
  }
  if(ANTHROPIC_BUDGET_MODELS.test(id))return {mode:'budget',alwaysOn:false,efforts:['none','low','medium','high','xhigh']};
  return null;
}
// OpenRouter normalizes reasoning:{effort} ('none' disables) across vendors: https://openrouter.ai/docs/use-cases/reasoning-tokens
// Used only when its catalog record does not say; a refreshed catalog's reasoning object or supported_parameters wins.
const OPENROUTER_REASONING=/deepseek-(r1|reasoner|v3\.[1-9]|v[4-9]|chat-v3\.[1-9])|claude-(3\.7|3-7|sonnet-4|opus-4|haiku-4\.5|[a-z]+-[5-9])|gpt-5|gpt-oss|(^|\/)o[134](-|$)|gemini-(2\.5|[3-9])|grok-(3-mini|4|code)|qwen3|qwq|glm-(4\.[5-9]|[5-9])|kimi-k2-thinking|kimi-k[3-9]|minimax-m[1-9]|magistral|-thinking|phi-4-reasoning/;
const OPENROUTER_EFFORTS=['none','low','medium','high'];
// Families that reason even when no effort is sent, so their visible answer needs room after the reasoning.
const REASONING_FAMILY=/deepseek-(reasoner|r1)|-thinking|(^|\/)o[134](-|$)|gpt-oss|qwq|-r1(-|$)/;
/** Provider preset capability for a model: provider type, base-URL host and model family; null when none applies. */
export function presetReasoning(connection,model) {
  const key=presetKey(connection),id=modelTail(model),full=String(model || '').toLowerCase();
  if(key==='openrouter')return OPENROUTER_REASONING.test(full)?capability('reasoning',OPENROUTER_EFFORTS):null;
  if(key==='anthropic'){const thinking=anthropicThinking(id);return thinking?capability('thinking',thinking.efforts):null;}
  // DeepSeek: thinking:{type} toggles thinking (on by default); reasoning_effort low/high/max sets depth.
  // https://api-docs.deepseek.com/guides/thinking_mode . Legacy deepseek-chat/-reasoner ids keep their fixed behaviour.
  if(key==='deepseek')return /^deepseek-(chat|reasoner)$/.test(id)?null:capability('thinking.type',['none','low','high','max']);
  // Z.ai GLM 4.5-5.2: thinking:{type:'enabled'|'disabled'}, no finer levels; GLM-5.3 always thinks. https://docs.z.ai/guides/capabilities/thinking-mode
  if(key==='zai')return /^glm-(4\.[5-9]|5(\.[0-2])?)(?![.\d])/.test(id)?capability('thinking.type',['none','high']):null;
  // Gemini OpenAI endpoint: reasoning_effort; only 2.5 Flash/Flash-Lite can turn thinking off. https://ai.google.dev/gemini-api/docs/openai
  if(key==='gemini')return /^gemini-(2\.5|[3-9])/.test(id)?capability('reasoning_effort',[...(/^gemini-2\.5-flash/.test(id)?['none']:[]),'low','medium','high']):null;
  // xAI: grok-3-mini takes reasoning_effort low/high; other Grok models reject it unless the catalog declares it. https://docs.x.ai/docs/guides/reasoning
  if(key==='xai')return /^grok-3-mini/.test(id)?capability('reasoning_effort',['low','high']):null;
  return null;
}
/** Whether this model reasons when no effort is sent (provider default), so its output needs a larger limit. */
export function reasonsByDefault(connection,model) {
  const key=presetKey(connection);
  if(REASONING_FAMILY.test(String(model || '').toLowerCase()))return true;
  if(key==='anthropic')return anthropicThinking(model)?.alwaysOn===true;
  return ['deepseek','zai','gemini'].includes(key) && !!presetReasoning(connection,model);
}

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
/** OpenRouter's catalog: a reasoning object (supported_efforts, mandatory, default_effort) or supported_parameters is authoritative. */
function openRouterReasoning(record={}) {
  const declared=record.reasoning;
  if(declared && typeof declared==='object' && !Array.isArray(declared)) {
    const listed=Array.isArray(declared.supported_efforts)?declared.supported_efforts.slice(0,32):OPENROUTER_EFFORTS;
    const efforts=[...new Set(listed.filter(value=>EFFORTS.has(value) && !(value==='none' && declared.mandatory===true)))];
    const result=capability('reasoning',efforts,'provider');
    return {...result,defaultEffort:efforts.includes(declared.default_effort) && declared.default_effort!=='none'?declared.default_effort:''};
  }
  if(Array.isArray(record.supported_parameters))return record.supported_parameters.includes('reasoning') || record.supported_parameters.includes('include_reasoning')?capability('reasoning',OPENROUTER_EFFORTS,'provider'):{...noReasoning(),source:'provider'};
  return null;
}
function catalogReasoning(connection,item,id) {
  const declared=modelReasoning(connection.type,item);if(declared.supported)return declared;
  if(presetKey(connection)==='openrouter'){const listed=openRouterReasoning(item);if(listed)return listed;}
  return presetReasoning(connection,id) || noReasoning();
}

/** Recheck persisted capabilities before they become an outbound request field. */
export function safeReasoning(type,value) {
  const source=value?.source,allowed=source==='provider'?[reasoningParameter(type),...(type==='openrouter' || type==='custom'?['reasoning']:[])]:source==='preset'?PRESET_PARAMETERS[type] || []:[];
  if(value?.supported!==true || !value.parameter || !allowed.includes(value.parameter) || !Array.isArray(value.efforts))return noReasoning();
  const efforts=[...new Set(value.efforts.filter(item=>EFFORTS.has(item)))].slice(0,7);
  return efforts.length?{supported:true,efforts,defaultEffort:efforts.includes(value.defaultEffort)?value.defaultEffort:'',parameter:value.parameter,source}:noReasoning();
}
/** Catalog-declared capability, then the provider preset profile, then none. A catalog that explicitly lists no reasoning wins. */
export function reasoningForModel(connection,model) {
  const record=connection?.models?.find(item=>item.id===model)?.reasoning,declared=safeReasoning(connection?.type,record);
  if(declared.supported && declared.source==='provider')return declared;
  if(record?.source==='provider' && record.supported===false)return noReasoning();
  return presetReasoning(connection,model) || noReasoning();
}
/** Resolve a bot preference without guessing unsupported provider parameters or changing its saved choice.
 * 'auto' means High only on OpenAI/ChatGPT Responses; elsewhere it sends nothing so the provider default applies. */
export function effectiveReasoningEffort(preference,reasoning) {
  if(reasoning?.supported!==true)return '';
  const effort=preference==='auto' || preference===undefined?(reasoning.parameter==='reasoning.effort'?'high':''):preference;
  return effort && reasoning.efforts?.includes(effort)?effort:'';
}
/** Chat-completions request fields for one effort. DeepSeek depth beyond on/off travels as reasoning_effort (high is its default). */
function compatibleReasoning(parameter,effort) {
  if(!effort)return {};
  if(parameter==='reasoning_effort')return {reasoning_effort:effort};
  if(parameter==='reasoning')return {reasoning:{effort}};
  if(parameter==='thinking.type')return {thinking:{type:effort==='none'?'disabled':'enabled'},...(['low','max'].includes(effort)?{reasoning_effort:effort}:{})};
  return {};
}
/** Anthropic thinking fields and the output floor they need; an unknown family or 'none' sends nothing. */
export function anthropicThinkingRequest(model,effort) {
  const thinking=anthropicThinking(model);if(!thinking)return {body:{},minTokens:0};
  if(thinking.mode==='budget'){const budget=ANTHROPIC_BUDGETS[effort];return budget?{body:{thinking:{type:'enabled',budget_tokens:budget}},minTokens:budget+4096}:{body:{},minTokens:0};}
  if(effort && effort!=='none')return {body:{thinking:{type:'adaptive',display:'summarized'},output_config:{effort}},minTokens:16_384};
  return thinking.alwaysOn?{body:{thinking:{type:'adaptive',display:'summarized'}},minTokens:16_384}:{body:{},minTokens:0};
}
/** Reasoning kept on a result: full length, text bounded to its head and tail. */
function boundedReasoning(head,tail,chars,redact) {
  if(!chars)return null;
  if(chars<=8000)return {text:redact(head),chars};
  return {text:`${redact(head).slice(0,6000)} […] ${redact(tail).slice(-2000)}`,chars};
}
const reasoningOf=delta=>{
  if(!delta || typeof delta!=='object')return '';
  for(const value of [delta.reasoning_content,delta.reasoning])if(typeof value==='string' && value)return value;
  return Array.isArray(delta.reasoning_details)?delta.reasoning_details.map(item=>typeof item?.text==='string'?item.text:typeof item?.summary==='string'?item.summary:'').join(''):'';
};
const outputLimitRejected=error=>{const message=String(error?.message || '');return /HTTP 400\b/.test(message) && /max_tokens/.test(message) && /max_completion_tokens|unsupported|not supported|unrecognized|unknown|not allowed|not permitted/i.test(message);};

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

function catalogModel(connection,item) {
  let id=item.id || item.slug || item.name;
  // Gemini's OpenAI endpoint lists ids as models/<id> but takes the bare id in requests.
  if(typeof id==='string' && presetKey(connection)==='gemini')id=id.replace(/^models\//,'');
  if(typeof id!=='string' || !id || id.length>200 || /[\x00-\x1f\x7f]/.test(id))return null;
  const label=item.display_name || item.name || id;
  const contextWindow=catalogContextWindow(item);
  const images=modelImages(item);
  return {id,name:(typeof label==='string'?label:id).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300),reasoning:catalogReasoning(connection,item,id),...(contextWindow?{contextWindow}:{}),...(images?{images}:{})};
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
  constructor(store,options={}){this.store=store;this.options=options;this.oauth=new ChatGPTSignIn(store,options);this.outputParameters=new Map();}
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
    const models=records.filter(item=>item && typeof item==='object' && (connection.type!=='chatgpt' || !item.visibility || item.visibility==='list')).map(item=>catalogModel(connection,item)).filter(Boolean);
    return {models,source:'provider'};
  }
  async test(connection){const result=await this.models(connection);return {connected:true,...result,...(connection.type==='chatgpt'?{account:connection.oauthAccount || null}:{})};}
  /** Separate inference surface for bounded memory review, with the same credentialed transport. */
  async reviewMemory(connection,request){return this.complete(connection,request);}
  async reviewSkill(connection,request){return this.complete(connection,request);}
  async reviewAction(connection,request){return this.complete(connection,request);}
  async complete(connection,{model,messages,turnContext='',tools=[],signal,onDelta,onReasoning,reasoningEffort='',reasoningCapabilities,cacheKey='',maxOutputTokens,timeoutMs}={}){
    let emissions=Promise.resolve();const consumerFailures=new Set();
    const deliver=(consumer,text)=>{const clean=this.store.redact(String(text));emissions=emissions.then(async()=>{try{await consumer(clean);}catch(error){consumerFailures.add(error);throw error;}});void emissions.catch(()=>{});};
    const emit=text=>{if(text && onDelta)deliver(onDelta,text);};
    // Reasoning shares the ordered emission chain with text; the result keeps its full length and a bounded head and tail.
    let reasoningHead='',reasoningTail='',reasoningChars=0;
    const emitReasoning=text=>{if(!text || typeof text!=='string')return;reasoningChars+=text.length;if(reasoningHead.length<1_000_000)reasoningHead+=text;reasoningTail=(reasoningTail+text).slice(-4000);if(typeof onReasoning==='function')deliver(onReasoning,text);};
    const reasoningText=()=>reasoningChars<=reasoningHead.length?reasoningHead:'';
    try {
    connection=this.current(connection);model=model || connection.defaultModel;ensure(typeof model==='string' && model.trim(),409,'Choose a model for this provider before sending a task.');
    if(timeoutMs!==undefined)ensure(Number.isFinite(timeoutMs)&&timeoutMs>=1,400,'Per-request timeout must be a positive duration.');
    if(maxOutputTokens!==undefined){ensure(Number.isInteger(maxOutputTokens) && maxOutputTokens>=256 && maxOutputTokens<=32768,400,'Per-request output limit must be 256–32768 tokens.');connection={...connection,maxOutputTokens:Math.min(connection.maxOutputTokens || 4096,maxOutputTokens)};}
    ensure(Array.isArray(messages) && messages.length && messages.length<=1000,400,'The provider needs a bounded conversation.');
    ensure(Array.isArray(tools),400,'The provider tool catalog must be an array.');
    ensure(tools.length<=MAX_PROVIDER_TOOLS,400,`The provider tool catalog is too large (${tools.length} tools; maximum ${MAX_PROVIDER_TOOLS}). Disable unused tool groups in bot settings and start a new task.`);
    // The capability captured for the run, then the current resolution, so a stale stored record never blocks a preset effort.
    const candidates=[...(reasoningCapabilities!==undefined && reasoningCapabilities!==null?[safeReasoning(connection.type,reasoningCapabilities)]:[]),reasoningForModel(connection,model)];
    const reasoning=(reasoningEffort && candidates.find(item=>item.supported && item.efforts.includes(reasoningEffort))) || candidates[0];
    ensure(typeof reasoningEffort==='string' && (!reasoningEffort || (reasoning.supported && reasoning.efforts.includes(reasoningEffort))),409,'The selected model does not advertise this reasoning effort. Refresh its model settings.');
      // The engine's per-step context goes after the stored conversation; each protocol places a trailing user message itself.
      if(typeof turnContext==='string' && turnContext)messages=[...messages,{role:'user',content:turnContext.slice(0,200_000)}];
      const params={model,messages,tools,signal,emit,emitReasoning,reasoningText,reasoningEffort,reasoning,timeoutMs,cacheKey:typeof cacheKey==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(cacheKey)?cacheKey:''};
      const result=await (['openai','chatgpt'].includes(connection.type)?this.responses(connection,params):connection.type==='anthropic'?this.anthropic(connection,params):this.compatible(connection,params));
      await emissions;const bounded=boundedReasoning(reasoningHead,reasoningTail,reasoningChars,text=>this.store.redact(text));
      return bounded?{...result,reasoning:bounded}:result;
    } catch(error){
      await emissions.catch(()=>{});
      if(signal?.aborted){clearProviderFailure(error);clearProviderFailure(signal.reason);throw signal.reason || error;}
      if(!consumerFailures.has(error))markProviderFailure(error,'protocol_error',{status:error instanceof HttpError?error.status:502});
      throw error;
    }
  }
  async responses(connection,{model,messages,tools,signal,emit,emitReasoning,reasoningEffort,reasoning,cacheKey,timeoutMs}){
    let summaryParts=0;
    let completed=null,failed=null;const outputItems=new Map();let streamed='';
    const subscription=connection.type==='chatgpt',functions=tools.map(tool=>({type:'function',name:tool.name,description:tool.description,parameters:tool.parameters,strict:false}));
    const streamItem=event=>outputItems.get(event.output_index) || [...outputItems.values()].find(item=>item.id && item.id===event.item_id);
    const response=await this.request(connection,'/responses',{method:'POST',signal,inference:true,timeoutMs,body:{model,...(reasoningEffort && reasoning.parameter==='reasoning.effort'?{reasoning:{effort:reasoningEffort}}:{}),instructions:messages.filter(message=>['system','developer'].includes(message.role)).map(message=>textOf(message.content)).join('\n\n'),input:responsesInput(messages,subscription?{namespace:CHATGPT_TOOL_NAMESPACE}:{}),...(cacheKey?{prompt_cache_key:cacheKey}:{}),...(tools.length?{tools:subscription?[{type:'namespace',name:CHATGPT_TOOL_NAMESPACE,description:'Tupies engine tools. Each action retains its engine permission checks.',tools:functions}]:functions,parallel_tool_calls:true}:{}),...(!subscription?{max_output_tokens:connection.maxOutputTokens || 4096}:{}),store:false,stream:true,include:['reasoning.encrypted_content']},onSSE:event=>{
      if(event.type==='response.output_text.delta'){streamed+=event.delta || '';emit(event.delta);}
      if(event.type==='response.reasoning_summary_part.added' && summaryParts++)emitReasoning('\n\n');
      if(event.type==='response.reasoning_summary_text.delta' && typeof event.delta==='string')emitReasoning(event.delta);
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
    if(!response.streaming){emitReasoning(output.filter(item=>item.type==='reasoning').flatMap(item=>Array.isArray(item.summary)?item.summary:[]).map(item=>typeof item?.text==='string'?item.text:'').filter(Boolean).join('\n\n'));emit(text);}
    return {text:this.store.redact(text),toolCalls,usage:result.usage || {},providerItems:output,finishReason:result.status==='incomplete'?'length':toolCalls.length?'tool_calls':'stop',...(subscription?{outputLimit:{requestedTokens:connection.maxOutputTokens || 4096,enforcedByProvider:false,responseByteLimit:8_000_000}}:{})};
  }
  async anthropic(connection,{model,messages,tools,signal,emit,emitReasoning,reasoningEffort,timeoutMs}){
    // Thinking needs room for the answer after it; temperature/top_k are never sent with thinking.
    const thinking=anthropicThinkingRequest(model,reasoningEffort);
    const blocks=new Map();let usage={},stopReason=null,finished=false,providerError=null;
    const system=messages.filter(message=>['system','developer'].includes(message.role)).map(message=>textOf(message.content)).join('\n\n');
    const response=await this.request(connection,'/messages',{method:'POST',signal,inference:true,timeoutMs,body:{model,max_tokens:Math.max(connection.maxOutputTokens || 4096,thinking.minTokens),...thinking.body,system:system?[{type:'text',text:system,cache_control:{type:'ephemeral'}}]:'',messages:anthropicCacheMarks(anthropicMessages(messages)),...(tools.length?{tools:tools.map(tool=>({name:tool.name,description:tool.description,input_schema:tool.parameters}))}:{}),stream:true},onSSE:event=>{
      if(event.type==='message_start')usage={...event.message?.usage};
      if(event.type==='content_block_start')blocks.set(event.index,{...event.content_block,_input:''});
      if(event.type==='content_block_delta'){
        const block=blocks.get(event.index);if(!block)return;
        if(event.delta?.type==='text_delta'){block.text=(block.text || '')+event.delta.text;emit(event.delta.text);}
        if(event.delta?.type==='input_json_delta')block._input+=event.delta.partial_json || '';
        if(event.delta?.type==='thinking_delta'){block.thinking=(block.thinking || '')+(event.delta.thinking || '');emitReasoning(event.delta.thinking);}
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
    if(!response.streaming){emitReasoning(content.filter(item=>item.type==='thinking' && typeof item.thinking==='string').map(item=>item.thinking).join('\n\n'));emit(text);usage=response.data.usage || {};stopReason=response.data.stop_reason;}
    return {text:this.store.redact(text),toolCalls,usage,providerItems:content,finishReason:stopReason==='max_tokens'?'length':toolCalls.length?'tool_calls':'stop'};
  }
  outputParameter(connection,model){
    const record=this.current(connection).models?.find(item=>item?.id===model);
    return record?.outputParameter==='max_completion_tokens' || this.outputParameters.get(`${connection.id}\u0000${model}`)==='max_completion_tokens'?'max_completion_tokens':'max_tokens';
  }
  /** Remember a strict endpoint's output field on the model record; never awaited, so a caller inside a mutation cannot deadlock. */
  rememberOutputParameter(connection,model,parameter){
    this.outputParameters.set(`${connection.id}\u0000${model}`,parameter);
    if(typeof this.store.mutate!=='function')return;
    void Promise.resolve().then(()=>this.store.mutate(state=>{const record=state.connections?.find(item=>item.id===connection.id)?.models?.find(item=>item?.id===model);if(record)record.outputParameter=parameter;})).catch(()=>{});
  }
  async compatible(connection,{model,messages,tools,signal,emit,emitReasoning,reasoningText,reasoningEffort,reasoning,timeoutMs}){
    const key=presetKey(connection);if(key==='gemini')model=model.replace(/^models\//,'');
    // Reasoning is never echoed into later requests, except that DeepSeek requires reasoning_content back on assistant turns of
    // tool-using conversations (https://api-docs.deepseek.com/guides/thinking_mode); history keeps it only for the same model.
    const echoReasoning=key==='deepseek';
    const canonical=messages.map(({role,content,tool_calls,tool_call_id,imageParts,providerItems})=>{
      const echoed=echoReasoning && role==='assistant' && Array.isArray(providerItems)?providerItems.find(item=>item?.type==='reasoning_content' && typeof item.text==='string'):null;
      return {role,content:role==='user' && imageParts?.length?[...imageParts.map(image=>({type:'image_url',image_url:{url:`data:${image.mediaType};base64,${image.data}`}})),{type:'text',text:textOf(content)}]:content || '',...(echoed?{reasoning_content:echoed.text}:{}),...(tool_calls?{tool_calls}:{}),...(tool_call_id?{tool_call_id}:{})};
    });
    // Reasoning counts against the output limit, so thinking requests get room for the visible answer after it.
    const thinking=(reasoningEffort && reasoningEffort!=='none') || (reasoningEffort!=='none' && reasonsByDefault(connection,model)) || REASONING_FAMILY.test(String(model).toLowerCase());
    const outputTokens=thinking?Math.max(connection.maxOutputTokens || 4096,16_384):connection.maxOutputTokens || 4096;
    const fields=reasoningEffort?compatibleReasoning(reasoning.parameter,reasoningEffort):{};
    let text='',finishReason=null,usage={};const calls=new Map();let done=false;
    const send=outputParameter=>this.request(connection,'/chat/completions',{method:'POST',signal,inference:true,timeoutMs,body:{model,...fields,messages:canonical,...(tools.length?{tools:tools.map(tool=>({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters}})),parallel_tool_calls:true}:{}),stream:true,stream_options:{include_usage:true},[outputParameter]:outputTokens},onSSE:(event,transport={})=>{
      if(event.error)throw markProviderFailure(new HttpError(502,String(event.error.message || 'The model request failed.')),'response_failed',{upstreamStatus:transport.status});
      if(event.usage)usage=event.usage;
      const choice=event.choices?.[0];if(!choice)return;
      emitReasoning(reasoningOf(choice.delta));
      if(choice.delta?.content){text+=choice.delta.content;emit(choice.delta.content);}
      for(const fragment of choice.delta?.tool_calls || []){const call=calls.get(fragment.index) || {id:'',name:'',arguments:''};if(fragment.id)call.id=fragment.id;if(fragment.function?.name)call.name+=fragment.function.name;call.arguments+=fragment.function?.arguments || '';calls.set(fragment.index,call);}
      if(choice.finish_reason){finishReason=choice.finish_reason;done=true;}
    }});
    const outputParameter=this.outputParameter(connection,model);let response;
    try{response=await send(outputParameter);}
    catch(error){
      // A strict OpenAI-compatible endpoint refused max_tokens before generating anything; resend the model call once. No tool ran.
      if(signal?.aborted || outputParameter!=='max_tokens' || !outputLimitRejected(error))throw error;
      response=await send('max_completion_tokens');this.rememberOutputParameter(connection,model,'max_completion_tokens');
    }
    let toolCalls;
    if(response.streaming){protocolEnsure(done,'The provider stream ended before a final result. The request was not replayed.','stream_interrupted',response.status);toolCalls=[...calls.values()].map(call=>({...call,arguments:parseArguments(call.arguments,response.status)}));}
    else {const choice=response.data?.choices?.[0];protocolEnsure(choice?.message,'The provider returned an invalid completion.','protocol_error',response.status);emitReasoning(reasoningOf(choice.message));text=textOf(choice.message.content);toolCalls=callsOf(choice.message,response.status);usage=response.data.usage || {};finishReason=choice.finish_reason;emit(text);}
    const echoed=echoReasoning?this.store.redact(reasoningText()).slice(0,200_000):'';
    return {text:this.store.redact(text),toolCalls,usage,finishReason:finishReason==='length'?'length':toolCalls.length?'tool_calls':'stop',...(echoed?{providerItems:[{type:'reasoning_content',text:echoed}]}:{})};
  }
  loginStart(connection,params){ensure(connection.type==='chatgpt',400,'This provider uses an API key, not ChatGPT sign-in.');return this.oauth.start(this.current(connection),params);}
  loginStatus(connection){return this.oauth.status(this.current(connection));}
  loginCancel(connection){return this.oauth.cancel(this.current(connection));}
  loginCallback(params){return this.oauth.callback(params);}
  logout(connection){return this.oauth.logout(this.current(connection));}
  async close(){await this.oauth.close();}
}
