// Reports how much of each bot's Bot Chat its model would see, and which other lanes it has, without printing any content.
// Usage: npm run context:report                 reads data/state.json (or STUDIO_DATA_DIR)
// Read-only: it parses the state file and never starts an engine, a scheduler or a store.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactConversation } from '../lib/engine.mjs';
import { contextLimits, estimateTokens } from '../lib/context-budget.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=path.join(process.env.STUDIO_DATA_DIR || path.join(root,'data'),'state.json');
const state=JSON.parse(await fs.readFile(file,'utf8'));
// The real system prompt is built by the engine; this stands in for its usual size.
const SYSTEM='x'.repeat(14_000),TOOLS_TOKENS=8_000;

const rows=[];
for(const bot of state.bots || []) {
  const conversation=state.conversations?.[bot.id] || [],connection=(state.connections || []).find(item=>item.id===bot.connectionId) || {};
  const model=bot.model || connection.defaultModel || connection.model || '',limits=contextLimits(connection,model,bot);
  const tokens=conversation.reduce((sum,message)=>sum+estimateTokens(message),0),toolTokens=conversation.filter(message=>message.role==='tool').reduce((sum,message)=>sum+estimateTokens(message),0);
  let seen;
  try {
    const compact=compactConversation(SYSTEM,conversation,{limit:limits.compactAt-TOOLS_TOKENS,hard:limits.usable-TOOLS_TOKENS,measure:estimateTokens});
    seen={userTurns:compact.messages.filter(message=>message.role==='user').length,omittedTurns:compact.omitted,clearedOutputs:compact.cleared,shortenedOutputs:compact.shortened,sentTokens:estimateTokens(compact.messages)+TOOLS_TOKENS};
  } catch(error) {seen={error:error.message};}
  const usage=state.runs?.[bot.id]?.usage || {};
  rows.push({bot:bot.name,otherLanes:(state.sessions || []).filter(item=>item.botId===bot.id).map(item=>item.kind),model:model || '(provider default)',window:limits.window,windowSource:limits.source,compactAt:limits.compactAt,storedMessages:conversation.length,storedUserTurns:conversation.filter(message=>message.role==='user').length,storedTokens:tokens,toolShare:tokens?+(toolTokens/tokens).toFixed(2):0,...seen,lastRunInputTokensAllSteps:usage.input_tokens ?? usage.prompt_tokens ?? null,lastRunCachedTokensAllSteps:usage.cached_tokens ?? null});
}
console.log(JSON.stringify(rows,null,2));
