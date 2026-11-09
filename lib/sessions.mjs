import { createHash } from 'node:crypto';
import { ensure } from './store.mjs';

// A bot has one Bot Chat lane: the app, the owner's Telegram DMs and teammate requests share it. The lane holds chat
// sessions (lib/chat-sessions.mjs); the first keeps the bot's id as its model-history key, as before sessions existed. Other lanes (Telegram chats with other people, team rooms, routine
// runs) have their own history. Their ids are derived, so every engine computes the same id, and start with the bot's id,
// so sync can tell whose they are.
export const CHAT='chat';
const LANES=new Set(['telegram','room','routine','mission']);
const SAFE_ID=/^[a-zA-Z0-9_-]{1,120}$/;

export function laneKind(lane) {
  if(!lane || lane===CHAT)return CHAT;
  const kind=String(lane).split(':',1)[0];ensure(LANES.has(kind),400,'Unknown conversation lane.');
  return kind;
}

export function sessionIdFor(botId,lane=CHAT) {
  const kind=laneKind(lane);if(kind===CHAT)return botId;
  const sessionId=`${botId}--${kind}-${createHash('sha256').update(`${botId}\n${lane}`).digest('hex').slice(0,16)}`;
  ensure(SAFE_ID.test(sessionId),400,'This bot id is too long for a separate conversation.');
  return sessionId;
}

/** The bot a conversation belongs to: the Bot Chat is keyed by the bot itself, every other session starts with it. */
export const sessionOwner=sessionId=>String(sessionId).split('--',1)[0];

/** The kind of a stored conversation: chat for the Bot Chat, otherwise the kind named after the bot's id. */
export const sessionKind=sessionId=>{const rest=String(sessionId ?? '').split('--')[1];return rest?rest.split('-',1)[0]:CHAT;};

export const findSession=(state,sessionId)=>(state.sessions || []).find(item=>item.id===sessionId) || null;

/** A chat session of this bot: its legacy Bot Chat (keyed by the bot id) or a later `<botId>--chat-<hex>` session. */
export const isChatSession=(sessionId,botId)=>typeof sessionId==='string' && (sessionId===botId || sessionOwner(sessionId)===botId && sessionKind(sessionId)===CHAT && sessionId.startsWith(`${botId}--chat-`));
/** The owner's Bot Chat lane in any of its sessions: no lane id, the bot id, or one of the bot's chat sessions. */
export const isBotChat=(sessionId,botId)=>!sessionId || isChatSession(sessionId,botId);

/** Exclude explicitly private bridges and the exact legacy bridge shape from other model histories. Display data stays intact. */
export function modelHistoryForSession(messages,sessionId) {
  const telegram=sessionKind(sessionId)==='telegram';
  return messages.filter(message=>{
    if(message?.sourceLane==='telegram' || (message?.sourceSessionId && sessionKind(message.sourceSessionId)==='telegram'))return telegram && message.sourceSessionId===sessionId;
    const legacy=!telegram && message?.role==='assistant' && !message.compaction && !message.runId && !message.sourceLane && !message.sourceSessionId && !message.tool_calls?.length && typeof message.content==='string' && message.content.startsWith('[Elsewhere: a Telegram chat with someone else]\nAsked: ') && message.content.includes('\nAnswered: ');
    return !legacy;
  });
}

/** The owner's own direct messages continue the Bot Chat; every other chat, and each person in a group, gets its own lane. */
export function telegramLane(channel,message) {
  const chatId=String(message.chat.id),userId=String(message.from.id),direct=chatId===userId;
  if(direct && channel.ownerUserId && userId===channel.ownerUserId)return CHAT;
  return `telegram:${channel.id}:${chatId}${direct?'':`:${userId}`}`;
}

/** Removes every conversation and session record that belongs to a deleted bot. */
export function removeBotSessions(state,botId) {
  for(const key of Object.keys(state.conversations || {}))if(key===botId || key.startsWith(`${botId}--`))delete state.conversations[key];
  state.sessions=(state.sessions || []).filter(item=>item.botId!==botId);
}
