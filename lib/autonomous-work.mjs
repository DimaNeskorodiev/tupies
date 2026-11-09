import { createHash } from 'node:crypto';
import { providerFailure } from './provider-failure.mjs';

const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const freeze=value=>Object.freeze(value);
const MAX_RETRY_DELAY=300_000;
const DIGEST=/^[a-f0-9]{64}$/;
const VOLATILE=new Set(['toolCallId','tool_call_id','callId','call_id','requestId','request_id','runId','run_id','createdAt','created_at','updatedAt','updated_at','startedAt','started_at','finishedAt','finished_at','observedAt','observed_at','checkedAt','checked_at','readAt','read_at','timestamp','duration','durationMs','duration_ms','elapsed','elapsedMs','seq','sequence','execution_generation']);
const valid=(condition,message)=>{if(!condition)throw new TypeError(message);};
function positiveInteger(value,label,{zero=false}={}) {
  valid(Number.isSafeInteger(value) && value>=(zero?0:1),`${label} must be a ${zero?'nonnegative':'positive'} whole number.`);
  return value;
}
function override(options,key,current,{zero=false}={}) {
  if(!own(options,key) || options[key]===undefined || options[key]===null)return current;
  const value=positiveInteger(options[key],key,{zero});
  return value===0 ? null : value;
}

/**
 * No task-duration or turn-count deadline is implied by legacy numeric defaults.
 * Only explicit bounded mode (or an operator/test override) supplies a bound.
 * This policy never changes individual tool, network or approval safeguards.
 */
export function executionPolicy({limits={},bot={},options={},source='chat'}={}) {
  const mode=limits.mode ?? options.executionMode ?? 'autonomous';
  valid(['autonomous','bounded'].includes(mode),'Execution mode must be autonomous or bounded.');
  let maxRuntimeMs=null,maxModelTurns=null,maxToolCalls=null;
  if(mode==='bounded') {
    const minutes=positiveInteger(limits.runtimeMinutes ?? 30,'runtimeMinutes');
    valid(minutes<=120,'runtimeMinutes must be at most 120 in bounded mode.');
    maxRuntimeMs=minutes*60_000;
    maxModelTurns=positiveInteger(limits.modelTurns ?? (source==='routine'?50:20),'modelTurns');
    maxToolCalls=positiveInteger(limits.toolCalls ?? (source==='routine'?200:60),'toolCalls');
  }
  if(source!=='routine' && bot.maxSteps!==undefined && bot.maxSteps!==null)maxModelTurns=positiveInteger(bot.maxSteps,'maxSteps');
  maxRuntimeMs=override(options,'runTimeout',maxRuntimeMs,{zero:true});
  maxModelTurns=override(options,'maxTurns',maxModelTurns,{zero:true});
  maxToolCalls=override(options,'maxToolCalls',maxToolCalls,{zero:true});
  return freeze({mode,maxRuntimeMs,maxModelTurns,maxToolCalls});
}

// Hash source bodies transiently rather than copying them into a progress journal.
// Resource bounds protect bookkeeping even when a tool returns unusually deep data.
function dataDigest(value) {
  const hash=createHash('sha256');let nodes=0;
  const visit=(item,depth)=>{
    if(++nodes>10000 || depth>16){hash.update('[structure-limit]');return;}
    if(item===null || item===undefined){hash.update('null;');return;}
    if(typeof item==='string') {
      hash.update(`string:${item.length}:`);
      if(item.length<=1_000_000)hash.update(item);else hash.update(item.slice(0,32768)).update(item.slice(-32768));
      hash.update(';');return;
    }
    if(typeof item==='number' || typeof item==='boolean'){hash.update(`${typeof item}:${String(item)};`);return;}
    if(Array.isArray(item)) {hash.update(`array:${item.length}:[`);for(const child of item.slice(0,10000))visit(child,depth+1);hash.update(']');return;}
    if(typeof item==='object') {
      hash.update('{');
      const keys=Object.keys(item).filter(key=>!VOLATILE.has(key)).sort().slice(0,10000);
      for(const key of keys) {
        const descriptor=Object.getOwnPropertyDescriptor(item,key);
        hash.update(`${key.length}:${key}:`);
        if(descriptor && 'value' in descriptor)visit(descriptor.value,depth+1);else hash.update('[non-data]');
      }
      hash.update('}');return;
    }
    hash.update(`[${typeof item}]`);
  };
  visit(value,0);return hash.digest('hex');
}

/** Stable digest of engine-observed work; call IDs and telemetry do not show progress. */
export function progressFingerprint(input={}) {
  const {calls=[],results=[],ending='',plan=null}=Array.isArray(input)?{calls:input}:input;
  valid(Array.isArray(calls),'Progress calls must be an array.');
  const normalized=calls.slice(0,1000).map(call=>{
    let args=call?.arguments ?? call?.function?.arguments ?? {};
    if(typeof args==='string'){try{args=JSON.parse(args);}catch{/* Invalid arguments stay distinct data, never code. */}}
    return {name:call?.name ?? call?.function?.name ?? '',argumentsDigest:dataDigest(args)};
  });
  return dataDigest({calls:normalized,resultsDigest:dataDigest(results),endingDigest:dataDigest(ending),planDigest:dataDigest(plan)});
}

/** `hasProgress` is supplied only by engine observations, never model assertions. */
export function noteAutonomousProgress(previous,{fingerprint,hasProgress=false}={},{windowSize=12,maxRepeats=4}={}) {
  valid(Number.isSafeInteger(windowSize) && windowSize>=2 && windowSize<=64,'Progress window must be 2–64.');
  valid(Number.isSafeInteger(maxRepeats) && maxRepeats>=2 && maxRepeats<=windowSize,'Progress repeat limit must be 2–window size.');
  valid(typeof hasProgress==='boolean','Progress evidence must be boolean.');
  valid(typeof fingerprint==='string' && DIGEST.test(fingerprint),'Progress fingerprint must be SHA-256.');
  const recent=hasProgress?[]:[...(Array.isArray(previous?.recent)?previous.recent.filter(item=>typeof item==='string' && DIGEST.test(item)).slice(-(windowSize-1)):[]),fingerprint];
  const blocked=!hasProgress && recent.filter(item=>item===fingerprint).length>=maxRepeats;
  return freeze({recent:freeze(recent),blocked,reason:blocked?'repeated_unchanged_work':hasProgress?'progress':'working'});
}

export const MAX_RETRY_ATTEMPTS=6;
/**
 * Retry only a trusted transient provider failure, without replaying any tool.
 * At most `maxAttempts` retries run per consecutive failure streak (successful progress resets it), with
 * exponential backoff, jitter and the provider's Retry-After. After the cap the failure is final (`exhausted`)
 * so the caller can try a fallback model or fail clearly.
 */
export function autonomousRetryPolicy(error,{attempt=0,hasProgress=false,signal,maxAttempts=MAX_RETRY_ATTEMPTS,random=Math.random}={}) {
  positiveInteger(attempt,'Retry attempt',{zero:true});
  positiveInteger(maxAttempts,'Retry cap');
  valid(typeof hasProgress==='boolean','Progress evidence must be boolean.');
  const prior=hasProgress?0:attempt;
  if(signal?.aborted)return freeze({retry:false,blocked:false,attempt:prior,delayMs:0,reason:'cancelled'});
  const failure=providerFailure(error);
  if(!failure)return freeze({retry:false,blocked:true,attempt:prior,delayMs:0,reason:'unclassified_error'});
  const upstream=Number.isInteger(failure.upstreamStatus)?failure.upstreamStatus:0;
  const transient=['timeout','dns_error','transport_error','stream_interrupted','rate_limit','upstream_unavailable'].includes(failure.code) || ['http_error','response_failed'].includes(failure.code) && (upstream===429 || upstream>=500 && upstream<=599);
  if(!transient)return freeze({retry:false,blocked:true,attempt:prior,delayMs:0,reason:`provider_${failure.code}`});
  const retryAfter=Number.isFinite(error?.retryAfterMs) && error.retryAfterMs>0?error.retryAfterMs:0;
  if(prior>=maxAttempts)return freeze({retry:false,blocked:true,exhausted:true,transient:true,attempt:prior,delayMs:0,reason:'retry_limit',maxAttempts});
  // A provider asking for a longer wait than one backoff window will not recover inside this run's retry budget.
  if(retryAfter>MAX_RETRY_DELAY)return freeze({retry:false,blocked:true,exhausted:true,transient:true,attempt:prior,delayMs:0,reason:'retry_after_too_long',maxAttempts});
  const next=prior+1,jitter=0.8+0.4*Math.min(1,Math.max(0,random())),base=Math.round(2000*2**(next-1)*jitter);
  const delayMs=Math.min(MAX_RETRY_DELAY,Math.max(base,retryAfter));
  return freeze({retry:true,blocked:false,transient:true,attempt:next,delayMs,reason:`provider_${failure.code}`,maxAttempts});
}

/** Abortable backoff. Cancellation wins even when the configured delay is zero. */
export async function waitForRetry(ms,signal) {
  valid(Number.isSafeInteger(ms) && ms>=0 && ms<=MAX_RETRY_DELAY,'Retry delay must be 0–300000 milliseconds.');
  const reason=()=>signal?.reason || new DOMException('Task cancelled.','AbortError');
  if(signal?.aborted)throw reason();
  if(ms===0)return;
  await new Promise((resolve,reject)=>{
    let timer;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);};
    const onAbort=()=>{cleanup();reject(reason());};
    signal?.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>{cleanup();resolve();},ms);
    if(signal?.aborted)onAbort();
  });
}

export const STALL_NUDGE_ROUNDS=12;
export const STALL_ASK_ROUNDS=24;
const planIdentity=plan=>Array.isArray(plan?.steps)?plan.steps.map(step=>[step?.id ?? null,step?.status ?? null,step?.title ?? null]):null;
/** The plan step being worked on, if any. */
export const activePlanStep=plan=>Array.isArray(plan?.steps)?plan.steps.find(step=>step?.status==='in_progress') || null:null;

/**
 * Counts model steps that ran tools while the task plan stayed exactly the same. Any plan edit, or an
 * answer from the owner (`reset`), starts a new count. A step that produced new research evidence
 * (`productive`) does not count. Engine-observed only: a model cannot report progress.
 */
export function noteStall(previous,{plan=null,turn=0,reset=false,productive=false,now=Date.now()}={}) {
  valid(Number.isSafeInteger(turn) && turn>=0,'Stall turn must be a nonnegative whole number.');
  const key=dataDigest(planIdentity(plan));
  if(reset || !previous || previous.key!==key)return freeze({key,rounds:0,lastTurn:turn,since:now});
  if(previous.lastTurn===turn)return previous;
  if(productive)return freeze({...previous,lastTurn:turn});
  return freeze({key,rounds:previous.rounds+1,lastTurn:turn,since:previous.since});
}

/** Per-step note once a task has worked through `nudgeRounds` tool steps without changing its plan. */
export function stallNote(state,plan,{nudgeRounds=STALL_NUDGE_ROUNDS,askRounds=STALL_ASK_ROUNDS,now=Date.now()}={}) {
  if(!nudgeRounds || !state || state.rounds<nudgeRounds)return '';
  const step=activePlanStep(plan),minutes=Math.max(1,Math.round((now-state.since)/60_000));
  const status=step?`plan step “${String(step.title).slice(0,160)}” has stayed in progress for ${state.rounds} tool steps`:Array.isArray(plan?.steps)?`the task plan has not changed for ${state.rounds} tool steps`:`this task has run ${state.rounds} tool steps without a plan`;
  const options=Array.isArray(plan?.steps)?'complete the step with evidence, revise the plan to a different approach':'set a plan with task_plan_set, finish with what you have';
  return `Engine progress checkpoint: ${status} (about ${minutes} min). Before more tools, either ${options}, or ask the owner with ask_user.${askRounds && Array.isArray(plan?.steps)?` At ${askRounds} steps without a plan change the engine pauses and asks the owner whether to continue.`:''}`;
}
