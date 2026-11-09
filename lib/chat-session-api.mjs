import { ensure } from './store.mjs';
import { findSession, isChatSession } from './sessions.mjs';
import { activeChatSession, archiveChatSession, createChatSession, deleteChatSession, listChatSessions, renameChatSession, resumeChatSession, sessionMessages } from './chat-sessions.mjs';

const SESSION_ID=/^[a-zA-Z0-9_-]{1,120}$/;

/** The display messages of one chat session; `sessionId` defaults to the active session so older clients keep working. */
export function chatMessages(state,botId,sessionId) {
  const active=activeChatSession(state,botId),selected=sessionId || active;
  ensure(SESSION_ID.test(selected) && isChatSession(selected,botId),404,'Chat not found.');
  return {session:{id:selected,active:selected===active,title:findSession(state,selected)?.title || ''},messages:sessionMessages(state.messages?.[botId] || [],botId,selected)};
}

/**
 * Owner chat-session routes under /api/bots/:id/sessions. Authentication and CSRF are enforced by the server before this
 * runs. Switching, starting, archiving and deleting wait until the bot is idle, so a running task keeps its own session.
 */
export async function handleChatSessions({method,botId,sessionId,action,url,input,store,idle}) {
  const bot=store.state.bots.find(item=>item.id===botId);ensure(bot,404,'Bot not found.');
  if(!sessionId) {
    if(method==='GET')return {status:200,body:{data:listChatSessions(store.state,botId,{archived:url.searchParams.get('archived')==='1'}),active:activeChatSession(store.state,botId)}};
    if(method==='POST') {
      const body=await input();ensure(body && typeof body==='object' && !Array.isArray(body) && Object.keys(body).every(key=>key==='title'),400,'Send {title?: string}.');
      ensure(body.title===undefined || typeof body.title==='string' && body.title.length<=80,400,'Use a chat title of up to 80 characters.');
      idle();
      const result=await store.mutate(state=>{idle();const {record,reused}=createChatSession(state,botId,{title:(body.title || '').trim()});store.audit('chat.created',`${bot.name}: new chat`,botId,{sessionId:record.id});return {session:structuredClone(record),reused};});
      return {status:result.reused?200:201,body:result};
    }
    ensure(false,405,'Method not allowed.');
  }
  ensure(SESSION_ID.test(sessionId),404,'Chat not found.');
  if(action==='messages' && method==='GET')return {status:200,body:chatMessages(store.state,botId,sessionId)};
  if(action==='resume' && method==='POST') {
    idle();
    const session=await store.mutate(state=>{idle();const record=resumeChatSession(state,botId,sessionId);store.audit('chat.resumed',`${bot.name}: chat resumed`,botId,{sessionId});return structuredClone(record);});
    return {status:200,body:{session}};
  }
  if(!action && method==='PATCH') {
    const body=await input();ensure(body && typeof body==='object' && !Array.isArray(body) && Object.keys(body).length && Object.keys(body).every(key=>['title','archived'].includes(key)),400,'Send {title?: string, archived?: boolean}.');
    ensure(body.archived===undefined || typeof body.archived==='boolean',400,'archived must be true or false.');
    if(body.archived===true)idle();
    const session=await store.mutate(state=>{
      let record;
      if(body.title!==undefined)record=renameChatSession(state,botId,sessionId,body.title);
      if(body.archived!==undefined){if(body.archived)idle();record=archiveChatSession(state,botId,sessionId,body.archived);}
      store.audit('chat.updated',`${bot.name}: chat updated`,botId,{sessionId});
      return structuredClone(record);
    });
    return {status:200,body:{session,active:activeChatSession(store.state,botId)}};
  }
  if(!action && method==='DELETE') {
    idle();
    const result=await store.mutate(state=>{idle();const deleted=deleteChatSession(state,botId,sessionId);store.audit('chat.deleted',`${bot.name}: chat deleted`,botId,{sessionId});return deleted;});
    return {status:200,body:{...result,active:activeChatSession(store.state,botId)}};
  }
  ensure(false,405,'Method not allowed.');
}
