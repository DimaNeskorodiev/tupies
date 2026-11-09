// A bot's working context follows its model's own window: requests may use 95% of the window, and the conversation is
// summarized from a per-bot threshold (default 55%, like Hermes' 50%) towards a 20% target. Guessing a window too high fails requests; guessing too low only compacts
// earlier, so an unknown window is treated as 128K. Larger windows are capped by default because every model step
// resends the whole context.
export const DEFAULT_WINDOW=128_000;
export const DEFAULT_CEILING=272_000;
export const SMALL_WINDOW=64_000;
export const CONTEXT_LIMITS=['','128k','max'];
// Summary compaction starts at this share of the effective window; a bot's `compactThreshold` (30–90) overrides it.
export const DEFAULT_COMPACT_THRESHOLD=55;
export const COMPACT_THRESHOLDS={min:30,max:90};
// After a summary, the summary record and the kept recent turns aim at about this share of the effective window.
export const COMPACT_TARGET=20;

/** The bot's summary threshold in percent: a whole number between 30 and 90, otherwise the default. */
export function compactThreshold(bot={}) {
  const value=typeof bot?.compactThreshold==='string' && /^\d{1,3}$/.test(bot.compactThreshold)?Number(bot.compactThreshold):bot?.compactThreshold;
  return Number.isInteger(value) && value>=COMPACT_THRESHOLDS.min && value<=COMPACT_THRESHOLDS.max?value:DEFAULT_COMPACT_THRESHOLD;
}

/** The largest summary record, so summary plus the kept tail stay near the target (never below a tenth of the window). */
export const compactionSummaryTokens=(effective,tailTokens=0)=>Math.max(512,Math.floor(effective*0.1),Math.floor(effective*COMPACT_TARGET/100)-tailTokens);
const MIN_WINDOW=4_000,MAX_WINDOW=10_000_000;

// Fallback windows by provider and model family, used only when the provider's catalog does not state one.
// Longest matching fragment wins; '*' applies to every provider.
const KNOWN_WINDOWS=[
  ['chatgpt','',272_000],['chatgpt','-spark',128_000],
  ['openai','gpt-4o',128_000],['openai','gpt-4.1',1_047_576],['openai','gpt-5',400_000],['openai','gpt-6',400_000],['openai','o3',200_000],['openai','o4',200_000],
  ['*','claude',200_000],['*','claude-opus-4-6',1_000_000],['*','claude-sonnet-4-6',1_000_000],['*','claude-opus-4-7',1_000_000],['*','claude-opus-4-8',1_000_000],
  ['*','claude-opus-5',1_000_000],['*','claude-sonnet-5',1_000_000],['*','claude-fable-5',1_000_000],
  // Direct-provider families (vendor model cards): DeepSeek 128K, Gemini 2.5/3 1,048,576, GLM-4.5 128K and 4.6/4.7 200K,
  // Kimi K2 128K and K2-0905/K2-Thinking 256K, Llama 3.1/3.3 131,072, Mistral Large/Medium/Small 128K, Codestral 256K.
  ['*','deepseek',128_000],['*','gemini-2.5',1_048_576],['*','gemini-3',1_048_576],['*','glm-4.5',128_000],['*','glm-4.6',200_000],['*','glm-4.7',200_000],
  ['*','kimi-k2',128_000],['*','kimi-k2-0905',262_144],['*','kimi-k2-thinking',262_144],['*','llama-3.1',131_072],['*','llama-3.3',131_072],
  ['*','mistral-large',128_000],['*','mistral-medium',128_000],['*','mistral-small',128_000],['*','codestral',256_000],
  ['*','grok',131_072],['*','grok-build',256_000],['*','grok-4.3',1_000_000],['*','grok-4.20',1_000_000],['*','grok-4.5',500_000],['*','grok-4.6',500_000],['*','grok-4.7',500_000]
];

/** A context window is a plain token count within sane bounds; anything else is unknown. */
export function safeContextWindow(value) {
  const number=typeof value==='string' && /^\d{1,8}$/.test(value.trim())?Number(value):value;
  return Number.isInteger(number) && number>=MIN_WINDOW && number<=MAX_WINDOW?number:null;
}

/** The window a provider's catalog record declares, in the field names Codex, OpenRouter and Anthropic-style catalogs use. */
export function catalogContextWindow(record={}) {
  for(const value of [record.context_window,record.context_length,record.top_provider?.context_length,record.max_input_tokens,record.max_context_window]) {
    const window=safeContextWindow(value);if(window)return window;
  }
  return null;
}

export function knownContextWindow(type,model) {
  const id=String(model || '').toLowerCase();let best=null;
  for(const [provider,fragment,window] of KNOWN_WINDOWS)if((provider===type || provider==='*') && id.includes(fragment) && (!best || fragment.length>best[0].length))best=[fragment,window];
  return best?.[1] ?? null;
}

/** Working-context limits for one bot on one model, in tokens. An explicit connection setting wins over the catalog. */
export function contextLimits(connection={},model='',bot={}) {
  const entry=connection.models?.find(item=>item?.id===model);
  const [window,source]=safeContextWindow(connection.contextWindow)?[safeContextWindow(connection.contextWindow),'connection']
    :safeContextWindow(entry?.contextWindow)?[safeContextWindow(entry.contextWindow),entry.contextSource==='provider-error'?'provider-error':'provider']
    :knownContextWindow(connection.type,model)?[knownContextWindow(connection.type,model),'known']:[DEFAULT_WINDOW,'default'];
  const effective=bot.contextLimit==='max'?window:Math.min(window,bot.contextLimit==='128k'?128_000:DEFAULT_CEILING);
  const output=Number.isInteger(connection.maxOutputTokens) && connection.maxOutputTokens>0?connection.maxOutputTokens:4096;
  const usable=Math.min(Math.floor(effective*0.95),effective-output>effective/2?effective-output:effective);
  const threshold=compactThreshold(bot);
  // compactAt starts summary compaction; fitAt is where a request is shaped (earlier outputs cleared, oldest turns dropped).
  return {window,source,effective,usable,compactAt:Math.min(Math.floor(effective*threshold/100),usable),fitAt:Math.min(Math.floor(effective*0.9),usable),compactThreshold:threshold,compactTarget:Math.floor(effective*COMPACT_TARGET/100),small:window<SMALL_WINDOW};
}

/** A rough token count: UTF-8 bytes over four, so Cyrillic and other multi-byte text counts denser than English. */
export function estimateTokens(value) {
  const text=typeof value==='string'?value:JSON.stringify(value) ?? '';
  return Math.ceil(Buffer.byteLength(text,'utf8')/4);
}

/** Prompt tokens a provider reported, counting Anthropic's cached segments that its input_tokens leaves out. */
export function promptTokens(usage={}) {
  const base=usage.input_tokens ?? usage.prompt_tokens;
  if(!Number.isFinite(base))return null;
  return base+(Number.isFinite(usage.cache_read_input_tokens)?usage.cache_read_input_tokens:0)+(Number.isFinite(usage.cache_creation_input_tokens)?usage.cache_creation_input_tokens:0);
}

const OVERFLOW=/context[ _-]?(length|window)|maximum context|prompt is too long|too many (input )?tokens|input (is )?too long|exceeds? the (model'?s? )?(maximum|context)/i;
const LIMIT_PATTERNS=[/maximum context length is (\d[\d,]*)/i,/>\s*(\d[\d,]*)\s*maximum/i,/context (?:window|length|limit) (?:of|is) (\d[\d,]*)/i,/limit (?:of|is) (\d[\d,]*) tokens/i];

/** Whether a provider error says the request outgrew the model's context, and the limit it names when it names one. */
export function contextOverflow(error) {
  const message=String(error?.message || '');
  // Token rate limits also talk about tokens; they are not a context overflow.
  if(!OVERFLOW.test(message) || /rate limit|per[- ]minute|\bTPM\b|HTTP 429/i.test(message))return null;
  for(const pattern of LIMIT_PATTERNS) {
    const limit=safeContextWindow(Number(pattern.exec(message)?.[1]?.replaceAll(',','')));
    if(limit)return {limit};
  }
  return {limit:null};
}
