/**
 * Local model runtimes (Ollama, MLX LM / MLX VLM) and model-family presets for models that run on the owner's Mac.
 * Shared contract for the local-models work (docs/plans/local-models-20261117.md). Measurements behind the defaults:
 * docs/research/local-qwen38-27b-20261117.md.
 *
 * Nothing here sends a request. Callers decide what to send; these helpers only describe local behaviour.
 */

/** Connection types whose preset is a runtime on the same machine as the engine that hosts it. */
export const LOCAL_TYPES=new Set(['ollama','mlx']);

/** Defaults measured in L0 on a 48 GB M4 Pro with Qwen3.8-27B 4-bit. */
export const LOCAL_DEFAULTS=Object.freeze({
  contextWindow:32_768,          // a cold 76K prompt pushed a 48 GB Mac to 18% free memory
  largeWindowWarning:65_536,     // windows at or above this get a memory warning
  totalTimeoutMs:45*60_000,      // model load + cold prefill (about 125 tok/s) + generation
  firstTokenTimeoutMs:15*60_000, // measured to the first data event, not to response headers
  concurrency:2,                 // both MLX runtimes batch decoding; cold prefills compete
  thinkingOutputFloor:16_384,
  review:Object.freeze({memoryMs:30_000,skillMs:30_000,actionMs:45_000}),
});

const LOOPBACK=new Set(['localhost','127.0.0.1','::1','[::1]']);

/** True for a connection that talks to a runtime on its host engine's own machine. */
export function isLocalConnection(connection={}) {
  if(LOCAL_TYPES.has(connection.type))return true;
  if(connection.local===true)return true;
  if(connection.type!=='custom')return false;
  try{return LOOPBACK.has(new URL(connection.baseUrl || '').hostname.toLowerCase());}catch{return false;}
}

/**
 * Model families with known local behaviour, keyed by a test on the model id. Efforts are in intensity order and
 * include 'none' (thinking off) so engine-internal callers such as reviews can turn thinking off explicitly.
 */
const FAMILIES=[
  {
    id:'qwen3.8',
    test:id=>/(^|[/:_-])qwen3\.8([/:_-]|$)/i.test(id),
    reasoning:{efforts:['none','low','medium','xhigh'],defaultEffort:'xhigh',thinkingByDefault:true},
    contextWindow:262_144,
    tools:true,
    images:true,
    // Model card: https://huggingface.co/Qwen/Qwen3.8-27B
    sampling:{
      thinking:{temperature:1.0,top_p:0.95,top_k:20,min_p:0,presence_penalty:0},
      plain:{temperature:0.7,top_p:0.8,top_k:20,min_p:0,presence_penalty:1.5},
    },
  },
];

/** The family preset for a model id, or null. */
export function localFamily(model) {
  const id=String(model || '');
  return FAMILIES.find(family=>family.test(id)) || null;
}

/**
 * Request-body fields that control thinking on a local OpenAI-compatible runtime.
 * `effort` is '' (runtime/model default), 'none' (off) or a named effort.
 * `chat_template_kwargs.enable_thinking` is the one control that works on both mlx_lm.server and mlx_vlm.server (L0).
 */
export function localThinkingFields(connection,model,effort) {
  if(!isLocalConnection(connection) || connection.type==='ollama')return {};
  const family=localFamily(model);if(!family?.reasoning)return {};
  if(effort==='none')return {chat_template_kwargs:{enable_thinking:false}};
  if(effort)return {chat_template_kwargs:{enable_thinking:true},reasoning_effort:effort};
  return {chat_template_kwargs:{enable_thinking:family.reasoning.thinkingByDefault}};
}

/** Sampling fields for a local runtime, or {} when the family is unknown or the owner chose the runtime default. */
export function localSamplingFields(connection,model,{thinking}={}) {
  if(!isLocalConnection(connection) || connection.sampling==='runtime')return {};
  const family=localFamily(model);if(!family?.sampling)return {};
  return {...(thinking?family.sampling.thinking:family.sampling.plain)};
}

/** Request parameter id for local thinking: the request carries localThinkingFields(...) instead of a provider field. */
export const LOCAL_THINKING_PARAMETER='local-thinking';

/**
 * The reasoning capability the slider offers for a known thinking family on a local runtime, or null. Ollama is left out
 * until its native transport sends `think` (plan L1.2): its /v1 endpoint has no measured thinking control.
 */
export function localReasoning(connection,model) {
  if(!isLocalConnection(connection) || connection.type==='ollama')return null;
  const reasoning=localFamily(model)?.reasoning;if(!reasoning)return null;
  return {supported:true,efforts:[...reasoning.efforts],defaultEffort:reasoning.defaultEffort,parameter:LOCAL_THINKING_PARAMETER,source:'preset'};
}

/** Whether a known family thinks on this local connection when no effort is chosen (Tupies then sends thinking on). */
export function localThinksByDefault(connection,model) {
  return isLocalConnection(connection) && localFamily(model)?.reasoning?.thinkingByDefault===true;
}

/** Catalog facts a family preset adds for a model id on a local connection; mlx_lm lists ids only. */
export function localCatalogFacts(connection,model) {
  if(!isLocalConnection(connection))return null;
  const family=localFamily(model);if(!family)return null;
  return {family:family.id,contextWindow:family.contextWindow,images:family.images,tools:family.tools,reasoning:!!family.reasoning};
}

/** True when a window on a local connection is large enough to warn about the Mac's memory (L0: 76K → 18% free on 48 GB). */
export function largeLocalWindow(connection,window) {
  return isLocalConnection(connection) && Number.isFinite(window) && window>=LOCAL_DEFAULTS.largeWindowWarning;
}
