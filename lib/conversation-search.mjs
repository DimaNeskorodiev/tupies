import { ensure, string } from './store.mjs';
import { chatSessionResolver } from './chat-sessions.mjs';

const SAFE=/^[a-zA-Z0-9_-]{1,120}$/;
/** Owner-facing display transcripts only. This is not a model tool or a permission change. */
export function searchConversations(state,input,{redact=value=>value,maxMessages=20000,maxChars=8000000}={}) {
  const query=string(input.query,'Search',200);ensure(query.length>=2,400,'Search for at least two characters.');
  const scope=input.scope || 'all',conversationId=input.conversationId || '',limit=Number(input.limit ?? 20);
  ensure(['all','bot','room'].includes(scope) && (!conversationId || SAFE.test(conversationId)),400,'Choose a valid conversation scope.');
  ensure(Number.isInteger(limit) && limit>=1 && limit<=30,400,'Search returns 1–30 results.');
  ensure(!conversationId || scope!=='all',400,'Choose a bot or room for a scoped search.');
  const conversations=[];
  if(scope!=='room')for(const bot of state.bots || [])if(SAFE.test(bot.id) && (!conversationId || bot.id===conversationId))conversations.push({scope:'bot',id:bot.id,name:bot.name,messages:state.messages?.[bot.id] || [],chatOf:chatSessionResolver(state.messages?.[bot.id] || [],bot.id)});
  if(scope!=='bot')for(const room of state.rooms || [])if(SAFE.test(room.id) && (!conversationId || room.id===conversationId))conversations.push({scope:'room',id:room.id,name:room.name,messages:state.roomMessages?.[room.id] || []});
  ensure(!conversationId || conversations.length,404,'Conversation not found.');
  const terms=[...new Set(query.toLocaleLowerCase().split(/\s+/u))],phrase=query.toLocaleLowerCase(),matches=[];
  ensure(terms.length<=20,400,'Use at most twenty search words.');
  let scanned=0,chars=0,truncated=false;
  // Interleave newest messages so one large bot cannot consume the entire search budget.
  const longest=Math.max(0,...conversations.map(item=>item.messages.length));
  outer:for(let offset=0;offset<longest;offset++)for(const conversation of conversations){
    const message=conversation.messages[conversation.messages.length-1-offset];if(!message)continue;
    if(scanned>=maxMessages){truncated=true;break outer;}scanned++;
    if(!SAFE.test(message.id || '') || !['user','assistant','system'].includes(message.role))continue;
    const raw=typeof message.content==='string'?message.content:typeof message.text==='string'?message.text:'';
    if(raw.length>200000 || chars+raw.length>maxChars){truncated=true;continue;}chars+=raw.length;
    // Redact before matching or shortening; excerpts must not expose part of a credential.
    const text=String(redact(raw)),lower=text.toLocaleLowerCase();if(!terms.every(term=>lower.includes(term)))continue;
    const first=Math.max(0,lower.indexOf(terms[0])),start=Math.max(0,first-90),excerpt=(start?'…':'')+text.slice(start,start+360)+(start+360<text.length?'…':'');
    const score=(lower.includes(phrase)?20:0)+terms.length;
    const date=typeof message.createdAt==='string'?Date.parse(message.createdAt):NaN;
    matches.push({scope:conversation.scope,conversationId:conversation.id,name:String(redact(conversation.name || 'Conversation')).slice(0,120),messageId:message.id,...(conversation.chatOf?{chatSessionId:conversation.chatOf(message)}:{}),role:message.role,createdAt:Number.isFinite(date)?new Date(date).toISOString():null,excerpt,score});
  }
  matches.sort((a,b)=>b.score-a.score || (Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0) || a.messageId.localeCompare(b.messageId));
  return {results:matches.slice(0,limit).map(({score,...result})=>result),total:matches.length,scanned,truncated,hasMore:matches.length>limit,notice:truncated?'Search covered a bounded part of the stored transcripts. Narrow the conversation or query to find older results.':''};
}
