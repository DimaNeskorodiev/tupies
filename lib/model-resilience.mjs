import { imagesForModel, reasoningForModel, effectiveReasoningEffort } from './providers.mjs';
import { botReasoningPreference } from './store.mjs';
import { providerFailure } from './provider-failure.mjs';
import { isLocalConnection } from './local-models.mjs';

/**
 * Model-call resilience helpers: the fallback model and the live "waiting for the model" notices.
 * Nothing here runs a tool. A fallback only re-sends one model request to another configured model.
 */

/** Bot setting `{connectionId, model}` resolved against current connections; null when unset or unusable. */
export function fallbackTarget(store,bot) {
  const setting=bot?.fallback;
  if(!setting || typeof setting.connectionId!=='string' || typeof setting.model!=='string' || !setting.connectionId || !setting.model.trim())return null;
  const connection=store.state.connections.find(item=>item.id===setting.connectionId);
  if(!connection || !connection.type || connection.type==='legacy-hermes' || connection.type==='none')return null;
  const model=setting.model.trim(),reasoning=reasoningForModel(connection,model);
  return {
    connection:structuredClone(connection),
    inference:{model,reasoning,reasoningEffort:effectiveReasoningEffort(botReasoningPreference(bot),reasoning),images:imagesForModel(connection,model).supported===true},
  };
}

/** Validate an owner-supplied fallback; returns the stored shape or null to clear it. Throws a 400 via `ensure`. */
export function validateFallback(value,{connections,ensure,primary}) {
  if(value===null || value===undefined || value==='' || (typeof value==='object' && !value.connectionId && !value.model))return null;
  ensure(value && typeof value==='object' && !Array.isArray(value),400,'Choose a provider and a model for the fallback.');
  ensure(typeof value.connectionId==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.connectionId),400,'Choose a provider for the fallback model.');
  ensure(typeof value.model==='string' && value.model.trim() && value.model.length<=200,400,'Choose a model for the fallback.');
  const connection=connections.find(item=>item.id===value.connectionId);
  ensure(connection,400,'The fallback provider does not exist. Choose a configured provider.');
  ensure(connection.type && connection.type!=='legacy-hermes',400,'Choose a direct model provider for the fallback.');
  const model=value.model.trim();
  ensure(!(primary && primary.connectionId===connection.id && (primary.model||'')===model && model),400,'The fallback must differ from this bot’s primary model.');
  return {connectionId:connection.id,model};
}

/**
 * While one model call is in flight, tell the run when nothing has arrived for a while. The chat strip shows
 * "waiting for model · 45 s" from these events. Older waiting events are dropped so a long stall cannot flood the log.
 */
export function watchModelWait(engine,context,step) {
  const options=engine.options || {},notice=options.waitNoticeMs ?? 15_000,tick=options.waitTickMs ?? Math.max(10,Math.min(5000,Math.floor(notice/3)));
  const started=Date.now();context.modelActivityAt=started;
  let lastEmit=0,announced=false,stopped=false,busy=false;
  const timer=setInterval(()=>{
    if(stopped || busy || context.controller.signal.aborted)return;
    const now=Date.now(),idle=now-(context.modelActivityAt || started);
    if(idle<notice){
      if(announced && context.modelActivityAt>lastEmit){announced=false;busy=true;engine.event(context,'model.resumed',{step}).catch(()=>{}).finally(()=>{busy=false;});}
      return;
    }
    if(now-lastEmit<notice)return;
    lastEmit=now;announced=true;busy=true;
    Promise.resolve().then(async()=>{
      await engine.event(context,'model.waiting',{step,elapsedMs:idle,...(context.relayState || {}),provider:context.connection?.type,model:context.inference?.model || 'provider-default'},{replace:true});
    }).catch(()=>{}).finally(()=>{busy=false;});
  },tick);
  timer.unref?.();
  return ()=>{stopped=true;clearInterval(timer);};
}

/** True when a step on this connection runs on a local runtime: on this engine, or relayed to the engine that hosts it. */
export function localStep(providers,connection){return isLocalConnection(connection) || !!providers?.hostedElsewhere?.(connection);}

const NOTICE_STATES=new Set(['queued','loading','reading']);
/**
 * Live states of one local or relayed model step (lib/inference-relay.mjs `onRelayState`) as chat notices.
 * queued, loading and reading each become one `model.waiting` event (replacing the previous one) with `state`, `host` and,
 * for reading, `tokens` (the runtime's estimate, else the engine's). The host repeats its state in every heartbeat;
 * only a change is written. The first streamed text (or a 'generating' state) clears the notice with `model.resumed`.
 * Only the task step passes this; reviews, compaction and other background calls never write notices.
 */
export function watchRelayState(engine,context,step,{estimate}={}) {
  let last='',done=false,chain=Promise.resolve();
  const emit=(type,details,options)=>{chain=chain.then(()=>done?null:engine.event(context,type,details,options)).catch(()=>{});};
  const clear=()=>{last='generating';if(!context.relayState)return;context.relayState=null;emit('model.resumed',{step});};
  return {
    onRelayState(value) {
      if(done || context.controller?.signal.aborted || !value || typeof value!=='object')return;
      if(value.state==='generating'){clear();return;}
      if(!NOTICE_STATES.has(value.state) || last==='generating')return;
      const tokens=value.state!=='reading'?undefined:Number.isSafeInteger(value.tokens) && value.tokens>0?value.tokens:Number.isFinite(estimate) && estimate>0?Math.round(estimate):undefined;
      const key=`${value.state}:${tokens ?? ''}`;if(key===last)return;last=key;
      const host=value.host?.here===true?{here:true,mac:value.host.mac===true}:{here:false,...(typeof value.host?.name==='string' && value.host.name.trim()?{name:value.host.name.trim().slice(0,80)}:{})};
      context.relayState={state:value.state,...(tokens!==undefined?{tokens}:{}),host};
      emit('model.waiting',{step,elapsedMs:0,...context.relayState,provider:context.connection?.type,model:context.inference?.model || 'provider-default'},{replace:true});
    },
    /** Text or reasoning arrived: the model is answering, so the notice goes. */
    activity(){if(!done && last!=='generating')clear();},
    stop(){done=true;context.relayState=null;},
  };
}

/** Short, static description of why the primary was given up on. */
export const failureLabel=error=>providerFailure(error)?.code || 'provider_error';
