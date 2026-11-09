import { randomBytes } from 'node:crypto';
import { ensure, now } from './store.mjs';
import { CHAT, isChatSession } from './sessions.mjs';

// Chat sessions of a bot's Bot Chat. Each session has its own model history (`state.conversations[sessionId]`) and a
// synced record in `state.sessions` ({id, botId, kind:'chat', key:'chat', title, titleSource, createdAt, updatedAt,
// activatedAt, archivedAt?, previous?} plus the existing compaction fields). The first session keeps the bot's id as its
// key, so the conversation that existed before sessions needs no data move. Later sessions are `<botId>--chat-<16 hex>`.
// The display transcript stays one list per bot (`state.messages[botId]`); a message names its chat session with
// `sessionId` (a request in a later session) or `chatSessionId` (other lanes' requests and engine notes), and replies
// follow their request's runId. A message without either belongs to the first session.
// The active session is the non-archived chat record with the newest `activatedAt`; without one it is the bot id.

const SAFE_ID=/^[a-zA-Z0-9_-]{1,120}$/;
const TITLE_MAX=80,POINTER_MAX=600;
const clip=(value,max)=>{const text=String(value ?? '').replace(/\s+/g,' ').trim();return text.length>max?`${text.slice(0,max-1).trimEnd()}…`:text;};

export const chatRecords=(state,botId)=>(state.sessions || []).filter(item=>item && item.botId===botId && item.kind===CHAT && isChatSession(item.id,botId));
const recordOf=(state,botId,sessionId)=>chatRecords(state,botId).find(item=>item.id===sessionId) || null;

/** The chat session new Bot Chat work continues. Every engine computes the same answer from the synced records. */
export function activeChatSession(state,botId) {
  let best=null;
  for(const record of chatRecords(state,botId)) {
    if(record.archivedAt || typeof record.activatedAt!=='string')continue;
    if(!best || record.activatedAt>best.activatedAt || record.activatedAt===best.activatedAt && record.id>best.id)best=record;
  }
  return best?.id || botId;
}

/** An activation time later than every existing one, so a switch within the same millisecond still wins. */
function activationTime(state,botId) {
  let at=Date.now();
  for(const record of chatRecords(state,botId)){const time=Date.parse(record.activatedAt);if(Number.isFinite(time) && time>=at)at=time+1;}
  return new Date(at).toISOString();
}

export function newChatSessionId(botId) {
  const sessionId=`${botId}--chat-${randomBytes(8).toString('hex')}`;
  ensure(SAFE_ID.test(sessionId),400,'This bot id is too long for a separate chat.');
  return sessionId;
}

/** An automatic title: the first line of the first request, shortened. */
export const autoTitle=text=>clip(String(text ?? '').split('\n').find(line=>line.trim()) || '',60);

/** Which chat session shows each display message. Built once per transcript; replies follow their request's runId. */
export function chatSessionResolver(messages,botId) {
  const own=message=>message?.chatSessionId || (message?.sessionId && isChatSession(message.sessionId,botId)?message.sessionId:null);
  const byRun=new Map();
  for(const message of messages || [])if(message?.runId && message.role==='user' && !byRun.has(message.runId))byRun.set(message.runId,own(message) || botId);
  return message=>own(message) || (message?.runId && byRun.get(message.runId)) || botId;
}

export function sessionMessages(messages,botId,sessionId) {
  const of=chatSessionResolver(messages,botId);
  return (messages || []).filter(message=>of(message)===sessionId);
}

/** Ensures the record of a chat session that is receiving work, and gives it a title from its first request. */
export function touchChatSession(state,botId,sessionId,{text='',at=now()}={}) {
  ensure(isChatSession(sessionId,botId),400,'Unknown chat session.');
  const sessions=state.sessions ||= [];
  let record=sessions.find(item=>item.id===sessionId);
  if(!record){record={id:sessionId,botId,kind:CHAT,key:CHAT,createdAt:at};sessions.push(record);}
  record.kind=CHAT;record.key ||= CHAT;
  if(!record.title){const title=autoTitle(text);if(title){record.title=title;record.titleSource='auto';}}
  record.activatedAt ||= at;
  record.updatedAt=at;
  return record;
}

/** A short deterministic pointer to an earlier session: its title and a one-paragraph digest, never a model call. */
export function sessionPointer(state,botId,sessionId) {
  const record=recordOf(state,botId,sessionId),rows=sessionMessages(state.messages?.[botId] || [],botId,sessionId).filter(row=>['user','assistant'].includes(row.role) && !row.partial && row.kind!=='progress' && typeof row.content==='string' && row.content.trim());
  if(!rows.length && !record?.summary)return null;
  let summary='';
  if(record?.summary)summary=clip(String(record.summary).replace(/<[^>]*>/g,' '),POINTER_MAX);
  else {
    const request=rows.findLast(row=>row.role==='user'),reply=rows.findLast(row=>row.role==='assistant');
    summary=clip(`${rows.length} messages. Last request: ${clip(request?.content,240)}${reply?` Last reply: ${clip(reply.content,300)}`:''}`,POINTER_MAX);
  }
  return {id:sessionId,title:clip(record?.title || autoTitle(rows.find(row=>row.role==='user')?.content) || 'Chat',TITLE_MAX),endedAt:record?.updatedAt || rows.at(-1)?.createdAt || null,summary};
}

const isEmpty=(state,botId,sessionId)=>!(state.conversations?.[sessionId] || []).length && !sessionMessages(state.messages?.[botId] || [],botId,sessionId).length;

/** Starts a new chat and makes it active. An active chat that is still empty is reused instead of piling up blanks. */
export function createChatSession(state,botId,{title=''}={}) {
  const previous=activeChatSession(state,botId);
  if(isEmpty(state,botId,previous)) {
    const record=touchChatSession(state,botId,previous,{});
    if(title){record.title=title;record.titleSource='owner';}
    return {record,reused:true};
  }
  const at=now(),sessionId=newChatSessionId(botId),pointer=sessionPointer(state,botId,previous);
  const record={id:sessionId,botId,kind:CHAT,key:CHAT,title,...(title?{titleSource:'owner'}:{}),createdAt:at,updatedAt:at,activatedAt:activationTime(state,botId),...(pointer?{previous:pointer}:{})};
  (state.sessions ||= []).push(record);
  (state.conversations ||= {})[sessionId]=[];
  return {record,reused:false};
}

function requireSession(state,botId,sessionId) {
  ensure(typeof sessionId==='string' && isChatSession(sessionId,botId),404,'Chat not found.');
  const record=recordOf(state,botId,sessionId);
  ensure(record || sessionId===botId && (state.conversations?.[botId] || state.messages?.[botId]?.length),404,'Chat not found.');
  return record || touchChatSession(state,botId,sessionId,{at:state.messages?.[botId]?.at(-1)?.createdAt || now()});
}

/** Makes an earlier chat the active one again; an archived chat is restored. */
export function resumeChatSession(state,botId,sessionId) {
  const record=requireSession(state,botId,sessionId);
  delete record.archivedAt;record.activatedAt=activationTime(state,botId);
  return record;
}

export function renameChatSession(state,botId,sessionId,title) {
  ensure(typeof title==='string' && title.trim() && title.length<=TITLE_MAX,400,`Use a chat title of 1–${TITLE_MAX} characters.`);
  const record=requireSession(state,botId,sessionId);
  record.title=clip(title,TITLE_MAX);record.titleSource='owner';
  return record;
}

/** When the active chat goes away, the most recently used remaining chat becomes active, or a new empty one. */
function replaceActive(state,botId,removed) {
  const next=chatRecords(state,botId).filter(item=>item.id!==removed && !item.archivedAt).sort((a,b)=>String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  if(next){next.activatedAt=activationTime(state,botId);return;}
  createChatSession(state,botId);
}

export function archiveChatSession(state,botId,sessionId,archived=true) {
  const record=requireSession(state,botId,sessionId),wasActive=activeChatSession(state,botId)===sessionId;
  if(!archived){delete record.archivedAt;return record;}
  record.archivedAt=now();
  if(wasActive){const next=chatRecords(state,botId).filter(item=>item.id!==sessionId && !item.archivedAt).sort((a,b)=>String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];if(next)next.activatedAt=activationTime(state,botId);else createChatSession(state,botId);}
  return record;
}

/**
 * Permanently removes a chat: its model history, its display messages and its record. The first session keeps an empty
 * history under the bot id so a later load never rebuilds it from other sessions' messages. Engine-local saved work for
 * that chat is discarded; nothing is replayed.
 */
export function deleteChatSession(state,botId,sessionId) {
  requireSession(state,botId,sessionId);
  const wasActive=activeChatSession(state,botId)===sessionId;
  const of=chatSessionResolver(state.messages?.[botId] || [],botId);
  if(state.messages?.[botId])state.messages[botId]=state.messages[botId].filter(message=>of(message)!==sessionId);
  if(sessionId===botId)(state.conversations ||= {})[botId]=[];else delete state.conversations?.[sessionId];
  state.sessions=(state.sessions || []).filter(item=>item.id!==sessionId);
  if(state.taskCheckpoints?.[botId]?.sessionId===sessionId)delete state.taskCheckpoints[botId];
  if(wasActive)replaceActive(state,botId,sessionId);
  return {deleted:true,id:sessionId};
}

/** The owner's list of a bot's chats, newest activity first. */
export function listChatSessions(state,botId,{archived=false}={}) {
  const active=activeChatSession(state,botId),messages=state.messages?.[botId] || [],of=chatSessionResolver(messages,botId),counts=new Map(),last=new Map();
  for(const message of messages) {
    if(!['user','assistant'].includes(message?.role))continue;
    const sessionId=of(message);counts.set(sessionId,(counts.get(sessionId) || 0)+1);
    if(String(message.createdAt || '')>String(last.get(sessionId) || ''))last.set(sessionId,message.createdAt);
  }
  const records=chatRecords(state,botId);
  if(!records.some(item=>item.id===active))records.push({id:active,botId,kind:CHAT,createdAt:null,updatedAt:null});
  return records.filter(item=>archived || !item.archivedAt || item.id===active).map(item=>({
    id:item.id,title:item.title || '',createdAt:item.createdAt || null,updatedAt:last.get(item.id) || item.updatedAt || item.createdAt || null,
    messageCount:counts.get(item.id) || 0,active:item.id===active,...(item.archivedAt?{archivedAt:item.archivedAt}:{}),
    ...(item.compactedAt?{compactedAt:item.compactedAt,compactions:item.compactions || 0}:{}),...(item.previous?{previous:{id:item.previous.id,title:item.previous.title}}:{}),
  })).sort((a,b)=>Number(b.active)-Number(a.active) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

/**
 * Idempotent migration: the conversation each bot had before sessions becomes its first session (id = bot id). Only a
 * record is added; the model history and display transcript stay exactly where they were.
 */
export function migrateChatSessions(state) {
  let changed=0;
  for(const bot of state.bots || []) {
    const botId=bot?.id;if(typeof botId!=='string' || !SAFE_ID.test(botId))continue;
    const sessions=state.sessions ||= [],existing=sessions.find(item=>item.id===botId);
    const rows=sessionMessages(state.messages?.[botId] || [],botId,botId).filter(row=>['user','assistant'].includes(row.role));
    if(!existing && !rows.length && !(state.conversations?.[botId] || []).length)continue;
    if(existing && existing.kind===CHAT && existing.title!==undefined && existing.key)continue;
    const first=rows.find(row=>row.role==='user' && !row.fromBotId && row.source!=='delegation');
    const record=existing || {id:botId,botId,createdAt:rows[0]?.createdAt || bot.createdAt || now()};
    Object.assign(record,{kind:CHAT,key:record.key || CHAT,title:record.title ?? (first?autoTitle(first.content):''),updatedAt:record.updatedAt || rows.at(-1)?.createdAt || record.createdAt});
    if(record.title && !record.titleSource)record.titleSource='auto';
    if(!existing)sessions.push(record);
    changed++;
  }
  return changed;
}
