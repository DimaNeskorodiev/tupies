import { imagesForModel, reasoningForModel, effectiveReasoningEffort } from './providers.mjs';
import { botReasoningPreference } from './store.mjs';
import { providerFailure } from './provider-failure.mjs';

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
      await engine.event(context,'model.waiting',{step,elapsedMs:idle,provider:context.connection?.type,model:context.inference?.model || 'provider-default'},{replace:true});
    }).catch(()=>{}).finally(()=>{busy=false;});
  },tick);
  timer.unref?.();
  return ()=>{stopped=true;clearInterval(timer);};
}

/** Short, static description of why the primary was given up on. */
export const failureLabel=error=>providerFailure(error)?.code || 'provider_error';
