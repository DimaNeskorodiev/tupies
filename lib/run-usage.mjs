// Token and cost accounting for one task, in one provider-neutral shape.
//
// Providers report usage differently: OpenAI-style totals include cached prompt tokens, Anthropic's `input_tokens`
// leave them out, DeepSeek names hits and misses, OpenRouter can state the charged cost. Every model call is reduced to
// four token counts (fresh input, cached input, cache writes, output) so cache reuse and spend are comparable across
// providers. Dollars are an estimate and only appear when every call of the task has a price from a named source: the
// provider's own cost report, the provider's model catalog, or the owner's price for the connection. A task with one
// unpriced call has no dollar total, never a partial sum. Subscription connections are never priced.

const count=value=>Number.isFinite(value) && value>=0?Math.round(value):0;
const first=(...values)=>values.find(value=>Number.isFinite(value) && value>=0);
const MAX_RATE=100_000;
const MICROS=1_000_000;

/** One model call's usage as {input, cached, cacheWrite, output, reasoning, costMicros?}; null when the provider reported nothing. */
export function usageCounts(usage) {
  if(!usage || typeof usage!=='object' || Array.isArray(usage))return null;
  const prompt=first(usage.input_tokens,usage.prompt_tokens),output=first(usage.output_tokens,usage.completion_tokens);
  if(prompt===undefined && output===undefined)return null;
  const details=usage.input_tokens_details || usage.prompt_tokens_details || {};
  const cached=count(first(usage.cache_read_input_tokens,details.cached_tokens,usage.prompt_cache_hit_tokens));
  const cacheWrite=count(first(usage.cache_creation_input_tokens,details.cache_write_tokens,details.cache_creation_tokens));
  // Anthropic reports fresh input only; OpenAI-style prompt totals already contain the cached and written segments.
  const separate=Number.isFinite(usage.cache_read_input_tokens) || Number.isFinite(usage.cache_creation_input_tokens);
  const input=separate?count(prompt):Math.max(0,count(prompt)-cached-cacheWrite);
  const reasoning=count(first(usage.output_tokens_details?.reasoning_tokens,usage.completion_tokens_details?.reasoning_tokens));
  // A provider that states what it charged (OpenRouter `usage.cost`, in USD) is the best price source there is.
  const reported=first(usage.cost,usage.total_cost);
  return {input,cached,cacheWrite,output:count(output),reasoning,...(reported!==undefined && reported<=10_000?{costMicros:Math.round(reported*MICROS)}:{})};
}

const rate=value=>{const number=typeof value==='string' && /^\d{1,7}(\.\d{1,12})?(e-?\d{1,2})?$/i.test(value.trim())?Number(value):value;return Number.isFinite(number) && number>=0 && number<=MAX_RATE?number:null;};

/**
 * Prices in USD per million tokens as {input, output, cachedInput?, cacheWrite?}, or null when unusable.
 * Accepts that shape, or a provider catalog's per-token strings (`prompt`, `completion`, `input_cache_read`,
 * `input_cache_write`), which is how OpenRouter publishes them.
 */
export function safePricing(value) {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const perToken=value.prompt!==undefined || value.completion!==undefined,scale=perToken?MICROS:1;
  const pick=key=>{const number=rate(value[key]);return number===null?null:Math.min(MAX_RATE,number*scale);};
  const input=pick(perToken?'prompt':'input'),output=pick(perToken?'completion':'output');
  if(input===null || output===null)return null;
  // A catalog row of zeros is a free or unpriced listing; it still counts as a price, at zero.
  const cachedInput=pick(perToken?'input_cache_read':'cachedInput'),cacheWrite=pick(perToken?'input_cache_write':'cacheWrite');
  const round=number=>Math.round(number*1e6)/1e6;
  return {input:round(input),output:round(output),...(cachedInput!==null?{cachedInput:round(cachedInput)}:{}),...(cacheWrite!==null?{cacheWrite:round(cacheWrite)}:{})};
}

/** The price that applies to one model on one connection and where it came from; null when there is none. */
export function priceFor(connection={},model='') {
  if(connection?.type==='chatgpt')return null;
  const own=safePricing(connection?.prices?.[model]) || safePricing(connection?.prices?.['*']);
  if(own)return {pricing:own,source:'owner'};
  const entry=Array.isArray(connection?.models)?connection.models.find(item=>item?.id===model):null;
  const listed=safePricing(entry?.pricing);
  return listed?{pricing:listed,source:'catalog'}:null;
}

/** Cost of one call in micro-dollars from list prices. Cached and written tokens fall back to the input price. */
export function callCostMicros(counts,pricing) {
  if(!counts || !pricing)return null;
  const micros=counts.input*pricing.input+counts.cached*(pricing.cachedInput ?? pricing.input)+counts.cacheWrite*(pricing.cacheWrite ?? pricing.input)+counts.output*pricing.output;
  return Math.round(micros);
}

const EMPTY=()=>({calls:0,input:0,cached:0,cacheWrite:0,output:0,reasoning:0,costMicros:0,pricedCalls:0,unpricedCalls:0,unreportedCalls:0});
const SOURCES=['provider','owner','catalog'];

/** Adds one model call to a task's meter and returns the new meter; the previous value is not changed. */
export function addModelCall(meter,usage,{connection,model}={}) {
  const next={...EMPTY(),...(meter && typeof meter==='object'?meter:{})};
  for(const key of Object.keys(EMPTY()))next[key]=count(next[key]);
  next.calls++;
  const counts=usageCounts(usage);
  if(!counts){next.unreportedCalls++;next.unpricedCalls++;return next;}
  for(const key of ['input','cached','cacheWrite','output','reasoning'])next[key]+=counts[key];
  const subscription=connection?.type==='chatgpt';
  const listed=subscription?null:priceFor(connection,model);
  const cost=subscription?null:counts.costMicros ?? callCostMicros(counts,listed?.pricing);
  if(subscription)next.subscription=true;
  if(cost===null || cost===undefined){next.unpricedCalls++;return next;}
  const source=counts.costMicros!==undefined?'provider':listed.source;
  next.costMicros+=cost;next.pricedCalls++;
  // The weakest source used names the estimate: one catalog-priced call makes the whole total a catalog estimate.
  next.costSource=SOURCES[Math.max(SOURCES.indexOf(source),SOURCES.indexOf(next.costSource ?? 'provider'))];
  return next;
}

/** Share of prompt tokens served from the provider's cache, 0–100, or null when no prompt tokens were reported. */
export function cachePercent(meter) {
  const prompt=count(meter?.input)+count(meter?.cached)+count(meter?.cacheWrite);
  return prompt?Math.round(count(meter.cached)*100/prompt):null;
}

/** A task's dollar estimate, only when every call was priced. */
export function costUsd(meter) {
  if(!meter || !count(meter.calls) || count(meter.unpricedCalls) || !count(meter.pricedCalls))return null;
  return Math.round(count(meter.costMicros))/MICROS;
}

/**
 * The compact, display-only record kept on a finished reply and in the run history.
 * It carries counts and an estimate only; it never authorizes anything and holds no content.
 */
export function usageSummary(meter,{steps=0,toolCalls=0,durationMs=null,model='',provider=''}={}) {
  if(!meter || !count(meter.calls) && meter.modelFree!==true)return null;
  const cost=costUsd(meter),cache=cachePercent(meter);
  return {
    steps:count(steps),toolCalls:count(toolCalls),modelCalls:count(meter.calls),
    inputTokens:count(meter.input),cachedTokens:count(meter.cached),cacheWriteTokens:count(meter.cacheWrite),outputTokens:count(meter.output),
    ...(count(meter.reasoning)?{reasoningTokens:count(meter.reasoning)}:{}),
    totalTokens:count(meter.input)+count(meter.cached)+count(meter.cacheWrite)+count(meter.output),
    ...(cache!==null?{cachePercent:cache}:{}),
    ...(cost!==null?{costUsd:cost,costSource:meter.costSource}:meter.subscription?{costSource:'subscription'}:{}),
    ...(count(meter.unreportedCalls)?{unreportedCalls:count(meter.unreportedCalls)}:{}),
    ...(Number.isFinite(durationMs) && durationMs>=0?{durationMs:Math.round(durationMs)}:{}),
    ...(typeof model==='string' && model?{model:model.slice(0,200)}:{}),...(typeof provider==='string' && provider?{provider:provider.slice(0,80)}:{}),
  };
}

/** The meter of a task that finished without any model call (a routine of only script/fetch steps): its summary says modelCalls 0. */
export function modelFreeMeter(){return {...EMPTY(),modelFree:true};}

/** Sums display summaries (for example a bot's finished tasks of one day). Dollars stay null if any task had none. */
export function sumSummaries(items=[]) {
  const total={tasks:0,steps:0,toolCalls:0,inputTokens:0,cachedTokens:0,cacheWriteTokens:0,outputTokens:0,totalTokens:0,costUsd:0,unpricedTasks:0};
  for(const item of items) {
    if(!item || typeof item!=='object')continue;
    total.tasks++;
    for(const key of ['steps','toolCalls','inputTokens','cachedTokens','cacheWriteTokens','outputTokens','totalTokens'])total[key]+=count(item[key]);
    if(Number.isFinite(item.costUsd) && item.costUsd>=0)total.costUsd+=item.costUsd;else if(item.costSource!=='subscription')total.unpricedTasks++;
  }
  const prompt=total.inputTokens+total.cachedTokens+total.cacheWriteTokens;
  return {...total,costUsd:Math.round(total.costUsd*MICROS)/MICROS,...(prompt?{cachePercent:Math.round(total.cachedTokens*100/prompt)}:{})};
}
