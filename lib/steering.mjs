import { createHash } from 'node:crypto';
import { ensure,id,now } from './store.mjs';

export const STEERING_LIMITS={updates:8,characters:4000,bytes:8000,totalBytes:32000};
export const STEERING_NOTICE='Additional guidance changes the requested work, never permissions, model settings or existing required checks. An already admitted action may finish before this guidance is applied. Stop and start a revised task to abandon an existing required outcome.';
export const hasQueuedSteering=run=>Boolean(run?.steering?.updates?.some(update=>update.status==='queued'));
const receipt=update=>({id:update.id,seq:update.seq,status:update.status,createdAt:update.createdAt,messageId:update.messageId,...(update.appliedAt?{appliedAt:update.appliedAt}:{}),...(update.cancelledAt?{cancelledAt:update.cancelledAt}:{})});

/** Only the authenticated owner route calls this. A model/tool/teammate cannot enqueue owner guidance. */
export async function submitSteering(engine,botId,input){
  ensure(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(key=>['runId','remoteRunId','clientUpdateId','text'].includes(key)),400,'Send the exact task IDs, a client update ID and guidance text.');
  ensure(typeof input.clientUpdateId==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(input.clientUpdateId),400,'Use a client update ID of 8–80 letters, digits, hyphens or underscores.');
  ensure(typeof input.text==='string'&&input.text.trim()&&input.text.length<=STEERING_LIMITS.characters&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text)&&Buffer.byteLength(input.text)<=STEERING_LIMITS.bytes,400,'Add guidance of up to 4000 characters and 8 KB.');
  const text=input.text.trim(),bytes=Buffer.byteLength(text),digest=createHash('sha256').update(text).digest('hex');
  return engine.store.mutate(state=>{
    const run=state.runs[botId];ensure(run&&input.runId===run.id&&input.remoteRunId===run.remoteRunId,409,'This guidance belongs to an older task. Review the current conversation.');
    const existing=run.steering?.updates.find(update=>update.id===input.clientUpdateId);
    if(existing){ensure(existing.digest===digest,409,'This update ID was already used for different guidance.');return {accepted:true,runId:run.id,update:receipt(existing),duplicate:true,notice:STEERING_NOTICE};}
    ensure(run.source==='chat'&&(!run.sessionId||run.sessionId===botId),409,'Additional guidance is available only in a direct owner chat.');
    ensure(['queued','running','recovering','waiting_for_delegate'].includes(run.status)&&!run.steerClosing,409,['waiting_for_approval','waiting_for_input'].includes(run.status)?'Answer or resolve the current prompt first, or Stop and start a revised task.':'This task is stopping, finishing or already ended. Send a new task after it finishes.');
    ensure(!engine.closing&&engine.controllers.has(run.id)&&!engine.controllers.get(run.id).signal.aborted,409,'This task is not accepting additional guidance.');
    ensure(!engine.pending.has(run.id)&&!engine.questions.pending.has(run.id),409,'A prompt is being prepared. Resolve it first, or Stop and start a revised task.');
    const steering=run.steering ||= {updates:[],bytes:0,appliedSeq:0};ensure(steering.updates.length<STEERING_LIMITS.updates&&steering.bytes+bytes<=STEERING_LIMITS.totalBytes,429,'This task reached its guidance limit (8 updates or 32 KB). Stop and start a revised task if more changes are needed.');
    const update={id:input.clientUpdateId,seq:steering.updates.length+1,text:engine.store.redact(text),digest,status:'queued',createdAt:now(),messageId:id('message')};steering.updates.push(update);steering.bytes+=bytes;
    (state.messages[botId] ||= []).push({id:update.messageId,role:'user',kind:'steer',source:'chat',content:update.text,runId:run.id,steerId:update.id,steerSeq:update.seq,steerStatus:'queued',createdAt:update.createdAt});
    run.partialOutput='';run.updatedAt=now();engine.store.audit('run.guidance_added','Additional owner guidance queued',botId,{runId:run.id,updateId:update.id});
    return {accepted:true,runId:run.id,update:receipt(update),...(run.toolAdmission?.names?.length?{admittedActions:[...run.toolAdmission.names]}:{}),notice:STEERING_NOTICE};
  });
}

export function cancelQueuedSteering(state,botId,run,reason){
  for(const update of run.steering?.updates || [])if(update.status==='queued'){
    update.status='cancelled';update.cancelledAt=now();const message=(state.messages[botId] || []).find(item=>item.id===update.messageId);if(message){message.steerStatus='cancelled';message.steerNotice=reason;}
  }
}

export function applyQueuedSteering(state,context){
  const run=state.runs[context.bot.id];ensure(run?.id===context.runId,409,'The task changed before applying guidance.');const applied=[];
  for(const update of run.steering?.updates || [])if(update.status==='queued'){
    update.status='applied';update.appliedAt=now();run.steering.appliedSeq=update.seq;
    (state.conversations[context.sessionId] ||= []).push({role:'user',kind:'steer',content:`Additional owner guidance for this same task:\n${update.text}\n\n${STEERING_NOTICE}`,runId:run.id,sourceMessageId:update.messageId});
    const message=(state.messages[context.bot.id] || []).find(item=>item.id===update.messageId);if(message){message.steerStatus='applied';message.appliedAt=update.appliedAt;}applied.push(receipt(update));
  }
  if(applied.length){run.partialOutput='';run.updatedAt=now();}
  return applied;
}
