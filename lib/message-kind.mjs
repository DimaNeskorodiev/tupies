// Engine-injected conversation messages are stored as role:'user' because providers only know that role, but they are not
// the owner's requests. Each carries `kind` so history logic never mistakes them for the start of a task.
export const MESSAGE_KINDS=Object.freeze({feedback:'engine_feedback',earlier:'earlier_context',summary:'compaction_summary'});
const KINDS=new Set(Object.values(MESSAGE_KINDS));

// Conservative shapes of messages stored before `kind` existed; they must match the engine's own text exactly at the start.
const LEGACY=[
  [/^Engine execution feedback for this same task \(no new permission\): /,MESSAGE_KINDS.feedback],
  [/^Engine recovery of the same authorized task: /,MESSAGE_KINDS.feedback],
  [/^Deterministic routine preparation has finished\. /,MESSAGE_KINDS.feedback],
  [/^<earlier_task_context>\n/,MESSAGE_KINDS.earlier],
  [/^<conversation_summary>\n/,MESSAGE_KINDS.summary]
];

/** The engine-injected kind of a stored conversation message, or null for a real user/assistant/tool message. */
export function messageKind(message) {
  if(!message || message.role!=='user')return null;
  if(KINDS.has(message.kind))return message.kind;
  if(message.compaction===true)return MESSAGE_KINDS.summary;
  // A real owner message carries sourceMessageId; engine-injected ones never do.
  if(typeof message.content!=='string' || message.sourceMessageId!==undefined)return null;
  for(const [pattern,kind] of LEGACY)if(pattern.test(message.content))return kind;
  return null;
}

export const isEngineInjected=message=>messageKind(message)!==null;
/** A user message that starts a task: the owner's, not feedback, earlier-task background or a summary. */
export const isTurnStart=message=>message?.role==='user' && !isEngineInjected(message);
/** Messages that must survive whole-turn dropping and stay at the head of the history. */
export const isPinnedContext=message=>{const kind=messageKind(message);return kind===MESSAGE_KINDS.summary || kind===MESSAGE_KINDS.earlier;};

/** Providers never see the marker. */
export function withoutKind(messages) {
  return messages.map(message=>{
    if(!message || !KINDS.has(message.kind))return message;
    const {kind,...rest}=message;return rest;
  });
}
