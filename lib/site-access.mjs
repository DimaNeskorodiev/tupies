// Per-task ledger of websites that refused automated access (WAF blocks, rate limits, "disallowed").
// After a site refuses repeatedly, the next attempt to reach it by any route (fetch, browser, terminal
// or code) waits for the owner: working around a refusal is sometimes fine, but it is the owner's call
// for this request, never the model's and never "Approve for me". Only site names and short engine-chosen
// reasons are kept; page bodies never enter the ledger.

export const SITE_REFUSAL_THRESHOLD=3;
const MAX_SITES=32;
const URL_PATTERN=/https?:\/\/[^\s'"`<>\\)\]}]+/gi;
const SECOND_LEVEL=new Set(['com','co','net','org','gov','edu','ac','in','ltd','plc','gen','biz','info','kiev','kyiv']);
const FETCH_TOOLS=new Set(['http_fetch']);
const BROWSER_TOOLS=new Set(['browser_open','browser_new_tab']);
const COMMAND_TOOLS=new Set(['terminal','execute_code','shell_run','shell_start']);
export const SITE_GATED_TOOLS=new Set([...FETCH_TOOLS,...BROWSER_TOOLS,...COMMAND_TOOLS]);
const REFUSED_STATUS=new Set([403,429,451]);
// Phrases that block pages and anti-bot APIs actually return. Generic words such as "captcha" or
// "forbidden" alone are excluded: ordinary pages and source code contain them.
const BLOCK_TEXT=/request blocked|request could not be satisfied|access denied|403 forbidden|429 too many requests|too many requests|rate limit exceeded|disallowed for this user|attention required! \| cloudflare|cf-chl-|are you a robot|unusual traffic from your|you have been blocked|bot protection/i;
const BLOCK_STATUS=/(?:HTTP\/[\d.]+\s+|"status"\s*:\s*|__S(?:TATUS)?:|http_code[=:\s]+|status code\s+)(403|429|451)\b/i;
const PAGE_BLOCK_TITLE=/^(?:403\b|429\b|access denied|attention required|just a moment|request blocked|forbidden|too many requests)/i;

function isPrivateV4(host) {
  const [a,b]=host.split('.').map(Number);
  return a===10 || a===127 || a===0 || a===169 && b===254 || a===172 && b>=16 && b<=31 || a===192 && b===168 || a===100 && b>=64 && b<=127;
}

/** The registrable site for a URL (`m.olx.ua` and `www.olx.ua` are both `olx.ua`). Local addresses are never gated. */
export function siteKey(input) {
  let host;
  try {host=new URL(String(input)).hostname.toLowerCase().replace(/\.$/,'');}catch{return null;}
  if(!host || host==='localhost' || /\.(?:localhost|local|test|internal)$/.test(host))return null;
  if(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host))return isPrivateV4(host)?null:host;
  if(host.startsWith('[') || host.includes(':'))return /^\[?(?:::1|fe80:|fc|fd)/i.test(host)?null:host;
  const labels=host.split('.');
  if(labels.length<=2)return host;
  const take=labels.at(-1).length===2 && SECOND_LEVEL.has(labels.at(-2))?3:2;
  return labels.slice(-take).join('.');
}

function urlsIn(value) {
  const text=typeof value==='string'?value:(()=>{try{return JSON.stringify(value) ?? '';}catch{return '';}})();
  return (text.slice(0,200_000).match(URL_PATTERN) || []).slice(0,50);
}

/** Sites a call would contact. Only network-capable tools are considered. */
export function callSites(call) {
  if(!SITE_GATED_TOOLS.has(call?.name))return [];
  const args=call.arguments || {};
  const urls=FETCH_TOOLS.has(call.name) || BROWSER_TOOLS.has(call.name)?[args.url]:urlsIn(args);
  return [...new Set(urls.map(siteKey).filter(Boolean))];
}

function commandText(output) {
  if(!output || typeof output!=='object')return '';
  return [output.output,output.stdout,output.stderr,output.text].filter(item=>typeof item==='string').join('\n').slice(-200_000);
}

/** Engine-observed refusals in one tool result: [{site, reason}]. Never model assertions. */
export function refusalsIn(call,output) {
  if(!SITE_GATED_TOOLS.has(call?.name) || !output || typeof output!=='object')return [];
  const args=call.arguments || {};
  if(FETCH_TOOLS.has(call.name)) {
    const site=siteKey(output.url || args.url),status=output.status;
    if(!site || !Number.isInteger(status))return [];
    if(REFUSED_STATUS.has(status))return [{site,reason:`HTTP ${status}`}];
    if(status>=400 && BLOCK_TEXT.test(String(output.text || '').slice(0,20_000)))return [{site,reason:`HTTP ${status} block page`}];
    return [];
  }
  if(BROWSER_TOOLS.has(call.name)) {
    const site=siteKey(output.url || args.url);if(!site || output.error)return [];
    if(output.challenge===true)return [{site,reason:'bot challenge page'}];
    if(PAGE_BLOCK_TITLE.test(String(output.title || '').trim()) || BLOCK_TEXT.test(String(output.outline || output.text || '').slice(0,4000)))return [{site,reason:'block page'}];
    return [];
  }
  const sites=callSites(call);if(!sites.length)return [];
  const text=commandText(output);
  const status=text.match(BLOCK_STATUS),phrase=text.match(BLOCK_TEXT);
  if(!status && !phrase)return [];
  const reason=status?`HTTP ${status[1]}`:`“${phrase[0].slice(0,40)}”`;
  return sites.map(site=>({site,reason}));
}

/** Adds one call's refusals to the ledger. Returns `previous` unchanged when nothing was refused. */
export function noteSiteRefusals(previous,call,output) {
  const found=refusalsIn(call,output);
  if(!found.length)return previous;
  const sites={...(previous?.sites || {})};
  for(const {site,reason} of found) {
    if(!sites[site] && Object.keys(sites).length>=MAX_SITES)continue;
    const current=sites[site] || {refusals:0,decision:null};
    sites[site]={...current,refusals:current.refusals+1,lastReason:reason};
  }
  return {sites};
}

export function decideSite(previous,site,decision) {
  const current=previous?.sites?.[site] || {refusals:0};
  return {sites:{...(previous?.sites || {}),[site]:{...current,decision}}};
}

/** What the gate must do before this call: deny it (owner said no), ask the owner, or nothing. */
export function siteAccessCheck(state,call,{threshold=SITE_REFUSAL_THRESHOLD}={}) {
  if(!state?.sites || !threshold)return null;
  const sites=callSites(call);
  const denied=sites.find(site=>state.sites[site]?.decision==='denied');
  if(denied)return {action:'deny',site:denied,entry:state.sites[denied]};
  const ask=sites.find(site=>(state.sites[site]?.refusals || 0)>=threshold && !state.sites[site].decision);
  return ask?{action:'ask',site:ask,entry:state.sites[ask]}:null;
}

/** Short per-step note for the model. Empty when no site refused yet. */
export function siteAccessNote(state) {
  const entries=Object.entries(state?.sites || {});
  if(!entries.length)return '';
  const lines=entries.slice(0,8).map(([site,entry])=>`${site}: refused ${entry.refusals}× (last: ${entry.lastReason || 'refused'})${entry.decision==='allowed'?'; the owner allowed working around this for the current request':entry.decision==='denied'?'; the owner declined workarounds — do not contact this site again in this task':''}`);
  return `Sites that refused automated access in this task (engine-observed):\n${lines.join('\n')}\nAfter ${SITE_REFUSAL_THRESHOLD} refusals the engine asks the owner before any further attempt to reach that site, by any tool, in this request.`;
}

export function siteAccessSummary(state) {
  const sites=Object.entries(state?.sites || {}).map(([site,entry])=>({site,refusals:entry.refusals,decision:entry.decision || null,lastReason:entry.lastReason || null}));
  return sites.length?{sites}:null;
}
