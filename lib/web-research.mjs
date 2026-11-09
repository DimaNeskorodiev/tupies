import { createHash } from 'node:crypto';
import { callSites, refusalsIn } from './site-access.mjs';

export const WEB_RESEARCH_GUIDANCE=`Web research workflow: identify the requested place/topic and the facts needed for the answer. Start with one or two short searches, then read a few relevant primary pages. Search snippets are discovery candidates; verify decision-critical facts on the source. http_fetch extracts readable HTML, links and structured data; JSON APIs remain JSON. Check actual content and extraction limits, not just HTTP status. Use raw format only to inspect literal source code. Do not outsource a page to a third-party proxy merely to strip HTML. Keep each additional search tied to a specific missing fact. For a simple recommendation, give a short useful selection once supported; identify uncertain hours, prices or distances rather than researching indefinitely. Do not introduce geospatial APIs for an ordinary nearby recommendation unless precise mapping is necessary. After repeated failures or empty results, abandon that approach; changing query wording, mirror hosts or coordinates alone is not progress. The turn context reports observed research effort and novelty; these counters do not certify relevance, truth or task completion.`;
/** Added when the Engine offers web_extract (an owner-configured Exa connection). */
export const WEB_EXTRACT_GUIDANCE=`Read pages, articles, documentation and PDFs with web_extract: it returns clean text, also for script-rendered pages; pass query to get the most relevant passages and follow nextOffset for long pages; set fresh for live prices or availability. Keep http_fetch for JSON APIs, POST requests and raw source. web_search accepts includeDomains, category (news for current events) and startPublishedDate when recency matters; search results already include excerpts, so read only the sources you need.`;

const hash=value=>createHash('sha256').update(value).digest('hex');
const normalize=value=>String(value ?? '').normalize('NFKC').replace(/\s+/g,' ').trim();
const OUTCOMES=new Set(['novel','failed','empty','duplicate']);
const EMPTY_ARRAY_KEYS=['results','items','features','elements','data'];
function sourceKey(value) {
  try {const url=new URL(value);url.hash='';for(const key of [...url.searchParams.keys()])if(/^(?:utm_.+|fbclid|gclid)$/i.test(key))url.searchParams.delete(key);url.searchParams.sort();return url.href;}catch{return null;}
}
function emptyJSON(text) {
  try {
    const value=JSON.parse(text);
    if(value===null || Array.isArray(value) && value.length===0)return true;
    if(!value || typeof value!=='object' || Array.isArray(value))return false;
    if(!Object.keys(value).length)return true;
    const arrays=EMPTY_ARRAY_KEYS.filter(key=>Array.isArray(value[key]));
    return arrays.length>0 && arrays.every(key=>value[key].length===0) && Object.keys(value).every(key=>arrays.includes(key) || ['version','generator','copyright','attribution','licence','license','timestamp','osm3s','type','status','total','count','query','bbox'].includes(key));
  }catch{return false;}
}

/** Observations come from Engine tool results, never a model's assertion of progress. Only hashes are retained. */
const BROWSER_READS=new Set(['browser_open','browser_new_tab']);
const COMMANDS=new Set(['terminal','execute_code','shell_run']);
const FETCH_VERB=/\b(?:curl|wget|requests\.|urllib|httpx|aiohttp|fetch\(|http\.get|Invoke-WebRequest)/i;
/** A terminal/code call that fetches a public URL. Local addresses are never research. */
export function networkCommand(call) {
  if(!COMMANDS.has(call?.name))return false;
  let text='';try{text=JSON.stringify(call.arguments ?? {});}catch{return false;}
  return FETCH_VERB.test(text) && callSites(call).length>0;
}

export function noteWebResearch(previous,call,output,{researchPage=false,enforce=true}={}) {
  const page=call?.name==='tool_result_read' && researchPage,browser=BROWSER_READS.has(call?.name),command=networkCommand(call);
  if(!page && !browser && !command && !['web_search','http_fetch','web_extract'].includes(call?.name))return previous;
  const refused=refusalsIn(call,output).length>0;
  // A command's ordinary failure (a build or script error) is a coding signal, not research evidence.
  if(command && !refused && (output?.error || output?.timedOut || Object.hasOwn(output || {},'exitCode') && output.exitCode!==0))return previous;
  const state={calls:0,reads:0,searches:0,pages:0,browsed:0,commands:0,novel:0,failed:0,empty:0,duplicates:0,streak:0,recent:[],seen:[],...previous};
  state.recent=(state.recent || []).filter(item=>OUTCOMES.has(item)).slice(-7);
  state.seen=(state.seen || []).filter(item=>typeof item==='string' && /^[a-f0-9]{64}$/.test(item)).slice(-256);
  state.enforced=enforce;
  state.calls++;if(page)state.pages++;else if(browser)state.browsed++;else if(command)state.commands++;else if(call.name==='http_fetch' || call.name==='web_extract')state.reads++;else state.searches++;
  let outcome='empty',keys=[];
  if(refused || output?.error || !command && Number.isInteger(output?.status) && (output.status<200 || output.status>=300))outcome='failed';
  else if(browser) {
    const text=normalize(output?.outline ?? output?.text);if(text)keys=[hash(`page:${text}`)];
  } else if(command) {
    const text=normalize(output?.output ?? output?.stdout);if(text)keys=[hash(`command:${text}`)];
  } else if(page) {
    const text=normalize(output?.content);if(text)keys=[hash(`page:${text}`)];
  } else if(call.name==='web_search') {
    keys=(Array.isArray(output?.results)?output.results:[]).map(item=>sourceKey(item?.url)).filter(Boolean).map(url=>hash(`discovery:${url}`));
  } else {
    const text=normalize(output?.text),structured=Array.isArray(output?.structuredData)?output.structuredData:[];
    if(!output?.extraction?.empty && (text || structured.length) && !emptyJSON(text))keys=[hash(`source:${text}\n${JSON.stringify(structured)}`)];
  }
  if(outcome!=='failed' && keys.length)outcome=keys.some(key=>!state.seen.includes(key))?'novel':'duplicate';
  state.seen=[...new Set([...state.seen,...keys])].slice(-256);
  if(outcome==='novel'){state.novel++;state.streak=0;}else {state[outcome==='duplicate'?'duplicates':outcome]++;state.streak++;}
  state.recent.push(outcome);
  const unproductive=state.recent.filter(item=>item!=='novel').length;
  state.warning=state.streak>=3 || state.recent.length>=6 && unproductive>=4;
  state.blocked=Boolean(previous?.blocked || enforce && (state.streak>=6 || state.recent.length===8 && unproductive>=6 && state.recent.slice(-2).every(item=>item!=='novel')));
  return state;
}

export function webResearchSummary(state) {
  if(!state)return null;
  const {calls,reads,searches,pages,browsed=0,commands=0,novel,failed,empty,duplicates,streak,warning,blocked,enforced}=state;
  return {calls,reads,searches,pages,browsed,commands,novel,failed,empty,duplicates,guard:enforced===false?'mission_budget':'observed_progress',consecutiveUnproductive:streak,warning:Boolean(warning),blocked:Boolean(blocked),notice:blocked?'Research stopped after repeated failed, empty or duplicate observations. Findings and partial work are preserved; completion is not verified.':enforced===false?'Mission research counters are advisory: duplicate content can occur across individually required sources. Close the exact contract gaps and respect the shared Mission effort/resource budget; these counters do not certify completion.':warning?'Repeated reads or searches are not adding evidence. Change the approach or answer from verified findings with explicit gaps.':calls>=12?'Research effort checkpoint: identify the exact missing user-required fact before another call. If existing evidence supports the answer, finish now and state remaining uncertainty.':'Counts describe observations only. Novel content can be irrelevant or wrong; assess the requested result.'};
}
