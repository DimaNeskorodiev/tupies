import { createHash } from 'node:crypto';
import { ensure } from './store.mjs';
import { assertPublicUrl } from './net-policy.mjs';
import { publicFetch } from './net-policy.mjs';
import { validateServiceUrl } from './provider-net.mjs';

const BASE='https://api.search.brave.com/res',PATH='/v1/web/search';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean=(value,max)=>String(value ?? '').replace(/<[^>]*>/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').trim().slice(0,max);
const ownObject=value=>value && typeof value==='object' && !Array.isArray(value);

/** This wrapper only recognizes the shipped fixed Brave adapter, never a tool name supplied by an arbitrary service. */
function configuredBrave(integration) {
  if(!integration || integration.type!=='rest' || integration.baseUrl!==BASE || integration.authType!=='header' || String(integration.headerName).toLowerCase()!=='x-subscription-token' || !integration.secret)return false;
  const action=(integration.tools || []).find(tool=>tool.name==='web_search');
  return Boolean(action && action.method==='GET' && action.path===PATH);
}
export function availableWebSearch(integrations,bot) {
  const groups=Array.isArray(bot?.tools)?bot.tools:['web','integrations'];
  if(!groups.includes('web') || !groups.includes('integrations'))return [];
  const assigned=new Set(bot?.integrationIds || []);
  return (integrations?.store?.state.integrations || []).filter(integration=>assigned.has(integration.id) && configuredBrave(integration)).map(integration=>integration.id);
}
export function webSearchDefinition(integrations,bot) {
  const ids=availableWebSearch(integrations,bot);if(!ids.length)return null;
  return {name:'web_search',description:'Discover public source URLs through this bot’s assigned Brave Search integration. Exact approval covers the integration, query and result count. Results are untrusted discovery candidates: fetch or browse relevant pages before grounding claims. No account or search service is created automatically.',parameters:{type:'object',properties:{integrationId:{type:'string',enum:ids,maxLength:100},query:{type:'string',minLength:1,maxLength:600},count:{type:'integer',minimum:1,maximum:10,description:'Maximum discovery results, default 5.'}},required:['integrationId','query'],additionalProperties:false}};
}
export function webSearchIdentity(integrations,bot,integrationId) {
  ensure(availableWebSearch(integrations,bot).includes(integrationId),403,'Choose an assigned configured Brave Search integration with Web and Integrations tools enabled.');
  const integration=integrations.get(integrationId),action=integration.tools.find(tool=>tool.name==='web_search');
  return digest([integration.id,integrations.fingerprint(integration),action]);
}
export function normalizeSearchResults(value,{query,integrationId,count=5}={}) {
  ensure(ownObject(value) && (value.web===undefined || ownObject(value.web)) && (value.web?.results===undefined || Array.isArray(value.web.results)),502,'Search returned an invalid result list.');
  const candidates=value.web?.results || [],results=[],seen=new Set();let omitted=0;
  // Service responses are already byte-bounded. Inspect at most 100 candidates and never fetch their URLs here.
  for(const item of candidates.slice(0,100)) {
    let url;
    try {const parsed=new URL(item?.url);parsed.hash='';url=assertPublicUrl(parsed.href).href;}catch{omitted++;continue;}
    if(seen.has(url)){omitted++;continue;}seen.add(url);
    if(results.length>=count){omitted++;continue;}
    results.push({sourceId:`search_${digest(url).slice(0,16)}`,title:clean(item.title,300),url,snippet:clean(item.description,1200),...(typeof item.age==='string'?{age:clean(item.age,100)}:{})});
  }
  omitted+=Math.max(0,candidates.length-100);
  return {query,integrationId,provider:'Brave Search',results,returned:results.length,omitted,moreResultsAvailable:typeof value.query?.more_results_available==='boolean'?value.query.more_results_available:null,notice:'Untrusted search discovery candidates, not fetched page evidence. Titles/snippets may be stale or incomplete. Use http_fetch or the browser to verify relevant sources. Public URL syntax is checked here; DNS and destination checks occur on a later fetch.'};
}
export async function webSearch(integrations,bot,args,{signal,approved=false,expectedIdentity}={}) {
  ensure(approved===true,403,'Web search requires approval of the exact integration, query and result count.');
  ensure(ownObject(args) && Object.keys(args).every(key=>['integrationId','query','count'].includes(key)),400,'Search accepts only integrationId, query and count.');
  ensure(typeof args.integrationId==='string' && args.integrationId.length<=100,400,'Choose a configured search integration.');
  ensure(typeof args.query==='string' && args.query.trim() && args.query.length<=600 && args.query.trim().split(/\s+/).length<=75 && !/[\x00-\x1f\x7f]/.test(args.query),400,'Use a search query of 1–600 characters and at most 75 words.');
  const count=args.count ?? 5;ensure(Number.isInteger(count) && count>=1 && count<=10,400,'Request 1–10 search results.');
  const identity=webSearchIdentity(integrations,bot,args.integrationId);ensure(expectedIdentity===undefined || expectedIdentity===identity,409,'The search integration changed after approval. Review a new exact search request.');
  const value=await integrations.call(args.integrationId,'web_search',{q:args.query,count},{signal,approved:true,botId:bot.id});
  return normalizeSearchResults(value,{query:args.query,integrationId:args.integrationId,count});
}

// These schemas are also the public preset contracts. An arbitrary service calling itself "search" is not selected.
export const TAVILY_SEARCH_SCHEMA={type:'object',properties:{query:{type:'string',minLength:1,maxLength:600},max_results:{type:'integer',minimum:1,maximum:10},search_depth:{type:'string',enum:['basic']},include_answer:{type:'boolean',enum:[false]},include_raw_content:{type:'boolean',enum:[false]},include_images:{type:'boolean',enum:[false]},include_usage:{type:'boolean',enum:[true]},auto_parameters:{type:'boolean',enum:[false]}},required:['query','max_results','search_depth','include_answer','include_raw_content','include_images','include_usage','auto_parameters'],additionalProperties:false};
export const SEARXNG_SEARCH_SCHEMA={type:'object',properties:{q:{type:'string',minLength:1,maxLength:600},format:{type:'string',enum:['json']},safesearch:{type:'integer',enum:[1]},pageno:{type:'integer',enum:[1]}},required:['q','format','safesearch','pageno'],additionalProperties:false};
const canonical=value=>Array.isArray(value)?value.map(canonical):ownObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const schemaMatches=(schema,expected)=>ownObject(schema) && digest(canonical(schema))===digest(canonical(expected));
function fallbackProvider(integrations,integration) {
  if(configuredBrave(integration))return 'Brave Search';
  if(!integration || integration.type!=='rest')return null;
  const action=(integration.tools || []).find(tool=>tool.name==='web_search');
  if(!action)return null;
  if(integration.baseUrl==='https://api.tavily.com' && integration.authType==='bearer' && integration.secret && action.method==='POST' && action.path==='/search' && schemaMatches(action.inputSchema,TAVILY_SEARCH_SCHEMA))return 'Tavily';
  if(action.method!=='GET' || action.path!=='/search' || !schemaMatches(action.inputSchema,SEARXNG_SEARCH_SCHEMA) || !['none','bearer','header'].includes(integration.authType) || (integration.authType!=='none' && !integration.secret))return null;
  try {validateServiceUrl(integration.baseUrl,{allowPrivateHttp:integrations?.options?.allowPrivateHttp ?? process.env.STUDIO_ALLOW_PRIVATE_HTTP==='true'});}catch{return null;}
  return 'SearXNG';
}

/** Only integrations explicitly assigned to this bot and declared as one of these fixed API contracts are candidates. */
export function availableSearchFallbacks(integrations,bot) {
  const groups=Array.isArray(bot?.tools)?bot.tools:['web','integrations'];
  if(!groups.includes('web') || !groups.includes('integrations'))return [];
  const assigned=new Set(bot?.integrationIds || []);
  return (integrations?.store?.state.integrations || []).filter(item=>assigned.has(item.id)).flatMap(item=>{
    const provider=fallbackProvider(integrations,item);return provider?[{id:item.id,name:clean(item.name || provider,100),provider}]:[];
  });
}
export function searchFallbackIdentity(integrations,bot,integrationId) {
  ensure(availableSearchFallbacks(integrations,bot).some(item=>item.id===integrationId),403,'Choose an assigned configured search fallback with Web and Integrations tools enabled.');
  const integration=integrations.get(integrationId),action=integration.tools.find(tool=>tool.name==='web_search');
  return digest([integration.id,integrations.fingerprint(integration),action,fallbackProvider(integrations,integration)]);
}

/** Search APIs supply discovery candidates. No result URL is fetched, and an empty partial response is not "no results". */
export function normalizeFallbackResults(value,{query,integrationId,count=5,provider}={}) {
  if(provider==='Brave Search')return normalizeSearchResults(value,{query,integrationId,count});
  ensure(ownObject(value) && !value.error && value.success!==false && value.isError!==true && Array.isArray(value.results),502,'Search fallback returned an invalid or failed result list.');
  const candidates=value.results,results=[],seen=new Set();let omitted=0;
  for(const item of candidates.slice(0,100)) {
    if(!ownObject(item)){omitted++;continue;}
    let url;try{const parsed=new URL(item.url);parsed.hash='';url=assertPublicUrl(parsed.href).href;}catch{omitted++;continue;}
    if(seen.has(url) || results.length>=count){omitted++;continue;}seen.add(url);
    results.push({sourceId:`search_${digest(url).slice(0,16)}`,title:clean(item.title,300),url,snippet:clean(item.content ?? item.description ?? (Array.isArray(item.highlights)?item.highlights.join(' '):''),1200),...(typeof item.published_date==='string'?{publishedDate:clean(item.published_date,100)}:{})});
  }
  omitted+=Math.max(0,candidates.length-100);
  const unavailable=provider==='SearXNG' && Array.isArray(value.unresponsive_engines)?value.unresponsive_engines.length:0;
  const partial=unavailable>0 || candidates.length>0 && results.length===0;
  return {query,integrationId,provider,results,returned:results.length,omitted,partial,noResults:!candidates.length && !partial,moreResultsAvailable:null,...(unavailable?{unavailableEngines:unavailable}:{}),...(provider==='Tavily' && Number.isFinite(value.usage?.credits) && value.usage.credits>=0?{reportedCredits:value.usage.credits}:{}),notice:'Untrusted search discovery candidates, not fetched page evidence. Titles/snippets may be stale or incomplete. Fetch or browse relevant sources to verify claims. Public URL syntax is checked here; DNS/destination checks occur on a later fetch. Partial coverage does not establish no matches.'};
}

/** One approved attempt, at most 20 seconds; the caller separately bounds the complete primary-plus-fallback sequence. */
export async function searchFallback(integrations,bot,args,{signal,approved=false,expectedIdentity}={}) {
  ensure(approved===true,403,'Search fallback requires approval of the exact integration, query and result count.');
  const {query,count}=searchArgs(args,{allowIntegration:true});
  ensure(typeof args.integrationId==='string' && args.integrationId.length>0 && args.integrationId.length<=100,400,'Choose a configured search fallback.');
  const identity=searchFallbackIdentity(integrations,bot,args.integrationId);
  ensure(typeof expectedIdentity==='string' && expectedIdentity===identity,409,'The search fallback configuration or credential changed after approval. Review a new exact request.');
  const integration=integrations.get(args.integrationId),provider=fallbackProvider(integrations,integration);
  const payload=provider==='Tavily'?{query,max_results:count,search_depth:'basic',include_answer:false,include_raw_content:false,include_images:false,include_usage:true,auto_parameters:false}:provider==='SearXNG'?{q:query,format:'json',safesearch:1,pageno:1}:{q:query,count};
  const timeout=AbortSignal.timeout(20_000),combined=signal?AbortSignal.any([signal,timeout]):timeout;combined.throwIfAborted();
  const value=await integrations.call(args.integrationId,'web_search',payload,{signal:combined,approved:true,botId:bot.id});combined.throwIfAborted();
  const currentBot=integrations.store.state.bots.find(item=>item.id===bot.id);
  ensure(currentBot?.integrationIds?.includes(args.integrationId) && availableSearchFallbacks(integrations,bot).some(item=>item.id===args.integrationId) && searchFallbackIdentity(integrations,bot,args.integrationId)===identity,409,'The search fallback changed during the request. Its response cannot verify the approved configuration; do not retry automatically.');
  return normalizeFallbackResults(value,{query,integrationId:args.integrationId,count,provider});
}

const DDG_ENDPOINT='https://html.duckduckgo.com/html/',DDG_LITE_ENDPOINT='https://lite.duckduckgo.com/lite/',DDG_BYTES=512_000,DDG_TIMEOUT=20_000,DDG_REQUEST_TIMEOUT=15_000;
const DDG_HOSTS=new Set(['duckduckgo.com','html.duckduckgo.com','lite.duckduckgo.com']);
const ENTITIES={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',ndash:'–',mdash:'—',hellip:'…'};
const entityText=value=>String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(all,entity)=>{
  if(entity[0]!=='#')return ENTITIES[entity.toLowerCase()] ?? all;
  const code=entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);
  return code>0 && code<=0x10ffff && (code<0xd800 || code>0xdfff)?String.fromCodePoint(code):'';
});
const plain=(value,max)=>entityText(value).replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
function searchError(code,message,status=503){const error=Object.assign(new Error(message),{status,code,searchStatus:code,retryable:false});return error;}
function searchArgs(args,{allowIntegration=false}={}) {
  ensure(ownObject(args) && Object.keys(args).every(key=>['query','count',...(allowIntegration?['integrationId']:[])].includes(key)),400,'Search accepts a query and optional result count.');
  ensure(typeof args.query==='string' && args.query.trim() && args.query.length<=600 && args.query.trim().split(/\s+/).length<=75 && !/[\x00-\x1f\x7f]/.test(args.query),400,'Use a search query of 1–600 characters and at most 75 words.');
  const count=args.count ?? 5;ensure(Number.isInteger(count) && count>=1 && count<=10,400,'Request 1–10 search results.');return {query:args.query,count};
}

/** No target scripts, styles or event handlers are executed; the parser walks bounded text only. */
function htmlTokens(html,emit) {
  const lower=html.toLowerCase();let cursor=0,tags=0;
  while(cursor<html.length) {
    const start=html.indexOf('<',cursor);
    if(start<0){emit({text:html.slice(cursor)});break;}
    if(start>cursor)emit({text:html.slice(cursor,start)});
    if(html.startsWith('<!--',start)){const end=html.indexOf('-->',start+4);if(end<0)break;cursor=end+3;continue;}
    let end=start+1,quote='';
    for(;end<html.length && end-start<=4096;end++) {const char=html[end];if(quote){if(char===quote)quote='';}else if(char==='"' || char==="'")quote=char;else if(char==='>')break;}
    if(end>=html.length || end-start>4096)throw searchError('search_layout_unavailable','DuckDuckGo returned an unsupported or incomplete search page.');
    if(++tags>15000)throw searchError('search_layout_unavailable','DuckDuckGo search markup exceeded its parsing limit.');
    const raw=html.slice(start+1,end),match=/^\s*(\/?)\s*([a-z][\w:-]*)\b/i.exec(raw);cursor=end+1;
    if(!match)continue;
    const closing=Boolean(match[1]),name=match[2].toLowerCase(),attrs=Object.create(null);
    if(!closing)for(const attr of raw.slice(match[0].length).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attrs[attr[1].toLowerCase()]=entityText(attr[2] ?? attr[3] ?? attr[4] ?? '');
    if(!closing && ['script','style','noscript'].includes(name)){const close=lower.indexOf(`</${name}`,cursor);if(close<0)break;const finish=html.indexOf('>',close);if(finish<0)break;cursor=finish+1;continue;}
    emit({name,closing,attrs});
  }
}
function ddgTarget(value) {
  const wrapped=new URL(value,DDG_ENDPOINT);let target=wrapped;
  if(DDG_HOSTS.has(wrapped.hostname)) {
    if(wrapped.pathname!=='/l/' || wrapped.searchParams.getAll('uddg').length!==1)return null;
    target=new URL(wrapped.searchParams.get('uddg'));
  }
  target.hash='';return assertPublicUrl(target.href).href;
}

export function duckDuckGoDefinition(integrations,bot) {
  const ids=availableSearchFallbacks(integrations,bot).map(item=>item.id);
  return {name:'web_search',description:'Search the public web with DuckDuckGo without an API key. Returns bounded source URLs/snippets as untrusted discovery candidates; fetch or browse pages to verify claims. Search may report a challenge, rate limit or unavailable layout rather than invent an empty result. An explicitly assigned search integration is optional and still requires exact approval.',parameters:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:600},count:{type:'integer',minimum:1,maximum:10,description:'Maximum results, default 5.'},...(ids.length?{integrationId:{type:'string',enum:ids,maxLength:100,description:'Optional assigned search integration; omitting this uses DuckDuckGo.'}}:{})},required:['query'],additionalProperties:false}};
}

export function parseDuckDuckGoResults(html,{query='',count=5,status=200}={}) {
  if(typeof html!=='string' || Buffer.byteLength(html)>DDG_BYTES)throw searchError('search_response_too_large','DuckDuckGo search response exceeded its size limit.',413);
  if(status===429)throw searchError('search_rate_limited','DuckDuckGo rate-limited this search. Try again later.',429);
  if(/anomaly-modal|id\s*=\s*["']challenge-form["']|\/anomaly\.js|bots use DuckDuckGo too|complete the following challenge/i.test(html))throw searchError('search_challenge','DuckDuckGo requested a challenge. No search results could be verified; try again later.');
  if(status!==200)throw searchError('search_unavailable',`DuckDuckGo search is unavailable (HTTP ${Number.isInteger(status)?status:'unknown'}).`);
  const candidates=[];let title=null,snippet=null,pending=null,explicitEmpty=false;
  htmlTokens(html,token=>{
    if(token.text!==undefined){if(title && title.text.length<12000)title.text+=token.text;if(snippet && snippet.text.length<12000)snippet.text+=token.text;return;}
    const classes=(token.attrs?.class || '').split(/\s+/);
    if(!token.closing && classes.some(name=>['no-results','no-results__message'].includes(name)))explicitEmpty=true;
    if(title && token.closing && token.name==='a') {pending={url:title.href,title:plain(title.text,300),description:''};candidates.push(pending);title=null;}
    if(snippet && token.closing && token.name===snippet.name){pending.description=plain(snippet.text,1200);snippet=null;}
    if(!token.closing && token.name==='a' && classes.some(name=>['result__a','result-link'].includes(name)))title={href:token.attrs.href || '',text:''};
    if(!token.closing && pending && classes.some(name=>['result__snippet','result-snippet'].includes(name)))snippet={name:token.name,text:''};
  });
  if(!candidates.length && !explicitEmpty)throw searchError('search_layout_unavailable','DuckDuckGo returned no recognized search results or explicit no-results marker. Its page layout may have changed.');
  const results=[],seen=new Set();let omitted=0;
  for(const item of candidates.slice(0,100)) {
    let url;try{url=ddgTarget(item.url);}catch{omitted++;continue;}
    if(!url || seen.has(url) || !item.title || results.length>=count){omitted++;continue;}seen.add(url);
    results.push({sourceId:`search_${digest(url).slice(0,16)}`,title:item.title,url,snippet:item.description});
  }
  omitted+=Math.max(0,candidates.length-100);
  if(candidates.length && !results.length)throw searchError('search_layout_unavailable','DuckDuckGo returned result markup, but no usable public HTTPS source URLs.');
  return {query,provider:'DuckDuckGo',results,returned:results.length,omitted,moreResultsAvailable:null,noResults:!results.length && explicitEmpty,notice:'Untrusted search discovery candidates, not fetched page evidence. Titles/snippets may be stale or incomplete. Fetch or browse relevant sources to verify claims. Public URL syntax is checked here; DNS/destination checks occur on a later fetch. Search coverage and ranking are provider-controlled.'};
}

export async function duckDuckGoSearch(args,{signal,fetch:fetcher=publicFetch}={}) {
  const {query,count}=searchArgs(args);signal?.throwIfAborted();
  const deadline=Date.now()+DDG_TIMEOUT,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(searchError('search_timeout','DuckDuckGo search timed out.',504)),DDG_TIMEOUT);
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  let abortListener;
  try {
    const cancelled=new Promise((_,reject)=>{abortListener=()=>reject(combined.reason);combined.addEventListener('abort',abortListener,{once:true});if(combined.aborted)abortListener();});
    const attempts=[];
    for(const [index,endpoint] of [DDG_ENDPOINT,DDG_LITE_ENDPOINT].entries()) {
      combined.throwIfAborted();const url=new URL(endpoint);url.searchParams.set('q',query);const name=index===0?'html':'lite';
      try {
        const response=await Promise.race([fetcher(url.href,{signal:combined,maxBytes:DDG_BYTES,timeoutMs:Math.min(DDG_REQUEST_TIMEOUT,Math.max(1,deadline-Date.now())),maxRedirects:0}),cancelled]);
        combined.throwIfAborted();
        const result=parseDuckDuckGoResults(response.text,{query,count,status:response.status});attempts.push({endpoint:name,status:result.noResults?'no_results':'results'});
        return {...result,endpoint:name,attempts};
      } catch(error) {
        combined.throwIfAborted();
        // publicFetch reports DNS/socket deadlines as HttpError(504), without a transport code.
        // Classify those consistently with the outer deadline, after honoring caller cancellation.
        if(error.status===504 && !error.searchStatus)error=searchError('search_timeout','DuckDuckGo search timed out.',504);
        attempts.push({endpoint:name,status:error.searchStatus || 'request_failed'});
        // Both are official read-only DDG layouts under the same egress checks. Never solve a challenge, forward cookies,
        // ignore a rate-limit response, or silently send the query to another search vendor.
        if(index===0 && ['search_challenge','search_layout_unavailable','search_unavailable'].includes(error.code))continue;
        error.searchAttempts=attempts;throw error;
      }
    }
  } finally {clearTimeout(timeout);if(abortListener)combined.removeEventListener('abort',abortListener);}
}
