import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuckDuckGoResults, duckDuckGoSearch, duckDuckGoDefinition } from '../lib/web-search.mjs';
import { HttpError } from '../lib/store.mjs';

const page=`<!DOCTYPE html><html><body>
<script>globalThis.executed = true;</script>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fprimary%3Fx%3D1%26y%3D2&amp;rut=fixture" class="result__a">Primary &amp; <b>reference</b></a>
<a class="result__snippet" href="https://example.com/primary">A <b>bounded</b> snippet &#x2014; with entities.</a>
<a class="result__a" href="https://example.org/second">Second source</a><div class="result__snippet">Second snippet.</div>
<a class="result__a" href="https://127.0.0.1/private">Private</a><a class="result__a" href="javascript:alert(1)">Script</a>
<a class="result__a" href="https://example.org/second#again">Duplicate</a>
</body></html>`;

test('DDG parser extracts inert bounded source candidates and decodes wrapped URLs',()=>{
  const result=parseDuckDuckGoResults(page,{query:'fixture',count:2});assert.equal(globalThis.executed,undefined);assert.equal(result.provider,'DuckDuckGo');assert.equal(result.returned,2);assert.equal(result.results[0].title,'Primary & reference');assert.equal(result.results[0].url,'https://example.com/primary?x=1&y=2');assert.equal(result.results[0].snippet,'A bounded snippet — with entities.');assert.equal(result.results[1].snippet,'Second snippet.');assert.equal(result.omitted,3);assert.equal(result.noResults,false);assert.equal(result.moreResultsAvailable,null);assert.match(result.notice,/not fetched page evidence/);
  const bounded=parseDuckDuckGoResults(page,{count:1});assert.equal(bounded.results.length,1);assert.equal(bounded.omitted,4);
});

test('DDG challenge, rate limit, malformed layout and real no-results are distinct',()=>{
  assert.throws(()=>parseDuckDuckGoResults('<form id="challenge-form">Select ducks</form>'),error=>error.code==='search_challenge');
  assert.throws(()=>parseDuckDuckGoResults('<p>Too many requests.</p>',{status:429}),error=>error.code==='search_rate_limited');
  assert.throws(()=>parseDuckDuckGoResults('<p>Unexpected page</p>'),error=>error.code==='search_layout_unavailable');
  assert.throws(()=>parseDuckDuckGoResults('<p>Service unavailable</p>',{status:503}),error=>error.code==='search_unavailable');
  const empty=parseDuckDuckGoResults('<div class="no-results"><h1>No results found for this query</h1></div>');assert.equal(empty.noResults,true);assert.deepEqual(empty.results,[]);
  assert.throws(()=>parseDuckDuckGoResults('<a class="result__a" href="https://localhost/private">Unsafe</a>'),error=>error.code==='search_layout_unavailable');
});

test('DDG request uses only fixed public endpoint and existing bounded fetch policy',async()=>{
  const requests=[];const result=await duckDuckGoSearch({query:'a & b',count:1},{fetch:async(url,options)=>{requests.push({url,options});return {status:200,text:page};}});
  assert.equal(requests.length,1);const url=new URL(requests[0].url);assert.equal(url.origin,'https://html.duckduckgo.com');assert.equal(url.pathname,'/html/');assert.equal(url.searchParams.get('q'),'a & b');assert.equal(requests[0].options.maxBytes,512000);assert.equal(requests[0].options.maxRedirects,0);assert.equal(requests[0].options.timeoutMs,15000);assert.equal(result.results.length,1);
  await assert.rejects(duckDuckGoSearch({query:'fixture'},{fetch:async()=>({status:202,text:'<form id="challenge-form"></form>'})}),error=>error.code==='search_challenge');
  assert.equal(duckDuckGoDefinition().parameters.required.join(','),'query');assert.equal(duckDuckGoDefinition().parameters.properties.integrationId,undefined);
});

test('DDG can use the official Lite layout after HTML challenge, with two bounded same-provider requests',async()=>{
  const endpoints=[],lite=`<table><tr><td><a class='result-link' href='https://example.com/reference'>Lite source</a></td></tr><tr><td class='result-snippet'>A <b>Lite</b> snippet.</td></tr></table>`;
  const result=await duckDuckGoSearch({query:'fixture',count:2},{fetch:async(url,options)=>{const host=new URL(url).hostname;endpoints.push(host);assert.ok(options.timeoutMs<=15000);assert.equal(options.maxRedirects,0);return host==='html.duckduckgo.com'?{status:202,text:'<form id="challenge-form"></form>'}:{status:200,text:lite};}});
  assert.deepEqual(endpoints,['html.duckduckgo.com','lite.duckduckgo.com']);assert.equal(result.endpoint,'lite');assert.equal(result.results[0].snippet,'A Lite snippet.');assert.deepEqual(result.attempts,[{endpoint:'html',status:'search_challenge'},{endpoint:'lite',status:'results'}]);
  let requests=0;await assert.rejects(duckDuckGoSearch({query:'fixture'},{fetch:async()=>{requests++;return {status:429,text:'Rate limited'};}}),error=>error.code==='search_rate_limited');assert.equal(requests,1,'explicit provider rate limit must not trigger another endpoint');
  requests=0;await assert.rejects(duckDuckGoSearch({query:'fixture'},{fetch:async()=>{requests++;return {status:202,text:'<form id="challenge-form"></form>'};}}),error=>error.code==='search_challenge' && error.searchAttempts.length===2);assert.equal(requests,2);
});

test('DDG invalid input, oversize markup and cancellation stop without network replay',async()=>{
  let calls=0;const fetch=async()=>{calls++;return {status:200,text:page};};for(const args of [{query:''},{query:'x',count:11},{query:'x\nheader'},{query:'fixture',url:'https://elsewhere.example'}])await assert.rejects(duckDuckGoSearch(args,{fetch}));assert.equal(calls,0);
  assert.throws(()=>parseDuckDuckGoResults('x'.repeat(512001)),error=>error.code==='search_response_too_large');
  assert.throws(()=>parseDuckDuckGoResults(`<a ${'x'.repeat(5000)}>`),error=>error.code==='search_layout_unavailable');
  const controller=new AbortController(),pending=duckDuckGoSearch({query:'fixture'},{signal:controller.signal,fetch:async(_url,options)=>{calls++;assert.equal(options.signal.aborted,false);return new Promise(()=>{});}});controller.abort(new Error('fixture stop'));await assert.rejects(pending,/fixture stop/);assert.equal(calls,1);
  const already=new AbortController();already.abort(new Error('already cancelled'));await assert.rejects(duckDuckGoSearch({query:'fixture'},{signal:already.signal,fetch}),/already cancelled/);assert.equal(calls,1);
});

test('DDG classifies actual fetch DNS/socket deadlines while preserving policy refusals',async()=>{
  let requests=0;
  await assert.rejects(duckDuckGoSearch({query:'fixture'},{fetch:async()=>{requests++;throw new HttpError(504,'Web DNS lookup timed out.');}}),error=>error.code==='search_timeout' && error.status===504 && error.searchAttempts[0].status==='search_timeout');
  assert.equal(requests,1,'a transport deadline does not retry the primary endpoint');
  const refusal=new HttpError(400,'The web host resolves to a private or reserved address.');
  await assert.rejects(duckDuckGoSearch({query:'fixture'},{fetch:async()=>{throw refusal;}}),error=>error===refusal && error.searchStatus===undefined);
});
