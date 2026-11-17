import { isLocalConnection, LOCAL_DEFAULTS } from './local-models.mjs';
import { reasoningForModel } from './providers.mjs';

/**
 * Request fields for one background review (action, memory or skill) on a local runtime, or null for any other
 * connection, which keeps its request unchanged. The review stays on the task's own connection and model. With
 * thinking on, a local 27B model took 80–135 s per review; with thinking off it took 11–16 s
 * (docs/research/local-qwen38-27b-20261117.md), so thinking is turned off when the model can turn it off, the limit is
 * the local one and the request waits behind interactive work in the local queue.
 * `limit` is a key of LOCAL_DEFAULTS.review: 'actionMs', 'memoryMs' or 'skillMs'.
 */
export function localReviewRequest(context,limit) {
  if(!isLocalConnection(context?.connection))return null;
  const limitMs=LOCAL_DEFAULTS.review[limit];
  const capability=reasoningForModel(context.connection,context.inference?.model || context.connection.defaultModel);
  const off=capability.supported===true && capability.efforts.includes('none');
  return {limitMs,fields:{...(off?{reasoningCapabilities:capability,reasoningEffort:'none'}:{}),timeoutMs:limitMs,priority:limit==='actionMs'?'interactive':'background'}};
}
