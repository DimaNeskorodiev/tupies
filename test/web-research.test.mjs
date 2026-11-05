import test from 'node:test';
import assert from 'node:assert/strict';
import { noteWebResearch, webResearchSummary } from '../lib/web-research.mjs';

const search=(query,results)=>[{name:'web_search',arguments:{query}},{results:results.map(url=>({url,title:'Discovery candidate'}))}];
const read=(url,text,extra={})=>[{name:'http_fetch',arguments:{url}},{url,status:200,text,contentType:'text/plain',...extra}];

test('changing query words and mirror hosts cannot evade consecutive failure/empty observations',()=>{
  let state;
  for(let i=0;i<6;i++) {
    const [call,output]=i%2?search(`different query ${i}`,[]):read(`https://mirror${i}.example/api?q=${i}`,'',{error:'Timed out',errorCode:'transient_read'});
    state=noteWebResearch(state,call,output);assert.equal(state.blocked,i===5);if(i===2)assert.equal(state.warning,true);
  }
  assert.equal(state.failed,3);assert.equal(state.empty,3);assert.equal(state.seen.length,0);
  assert.match(webResearchSummary(state).notice,/completion is not verified/);
});

test('same source body and tracking-only variations of discovery links are duplicates',()=>{
  let state=noteWebResearch(undefined,...search('first',['https://example.com/cafe?utm_source=one#top']));
  state=noteWebResearch(state,...search('changed words',['https://example.com/cafe?utm_source=two#other']));assert.equal(state.duplicates,1);
  state=noteWebResearch(state,...read('https://example.com/cafe','Saturday 08:00–14:00'));
  state=noteWebResearch(state,...read('https://other.example/copy','Saturday   08:00–14:00'));assert.equal(state.duplicates,2);assert.equal(state.novel,2);
});

test('HTTP 200 empty API results and empty extraction are not new evidence',()=>{
  let state;
  for(const body of ['[]','{}','null','{"type":"FeatureCollection","features":[]}','{"version":0.6,"osm3s":{"timestamp":"new"},"elements":[]}'])state=noteWebResearch(state,...read('https://example.com/api',body,{contentType:'application/json'}));
  state=noteWebResearch(state,...read('https://example.com/app','',{extraction:{empty:true}}));
  assert.equal(state.blocked,true);assert.equal(state.empty,6);assert.equal(state.novel,0);
  const meaningful=noteWebResearch(undefined,...read('https://example.com/api','{"name":"Café","openingHours":"08:00","items":[]}',{contentType:'application/json'}));assert.equal(meaningful.novel,1);
});

test('rolling sparse novelty cannot perpetuate a largely unproductive web loop',()=>{
  let state;
  for(let i=0;i<8;i++)state=noteWebResearch(state,...(i===2 || i===5?read(`https://example.com/${i}`,`Useful source ${i}`):search(`changed ${i}`,[])));
  assert.equal(state.streak,2);assert.equal(state.blocked,true);
});

test('successful substantial research stays unbounded and bookkeeping contains no source bodies, queries or URLs',()=>{
  let state;
  for(let i=0;i<400;i++){state=noteWebResearch(state,...read(`https://example.com/private-query-${i}`,`Distinct observed content ${i}`));assert.equal(state.blocked,false);}
  assert.equal(state.calls,400);assert.equal(state.seen.length,256);assert.equal(state.recent.length,8);
  assert.doesNotMatch(JSON.stringify(state),/https:|private-query|Distinct observed/);
  assert.match(webResearchSummary(state).notice,/exact missing user-required fact/);
  assert.equal(noteWebResearch(state,{name:'workspace_write'},{written:true}),state,'unrelated actions cannot reset research bookkeeping');
});

test('novel observations clear an early warning but cannot clear an already blocked task',()=>{
  let state;for(let i=0;i<3;i++)state=noteWebResearch(state,...search(`empty ${i}`,[]));
  assert.equal(state.warning,true);state=noteWebResearch(state,...read('https://example.com/cafe','New supported source'));assert.equal(state.warning,false);assert.equal(state.streak,0);
  state={...state,blocked:true};assert.equal(noteWebResearch(state,...read('https://example.com/other','Different source')).blocked,true);
});

test('retained web pages count only when the Engine binds them to a web result, with body-only novelty',()=>{
  const call={name:'tool_result_read',arguments:{resultId:'retained',offset:0}};
  assert.equal(noteWebResearch(undefined,call,{content:'Non-web workspace content'}),undefined);
  let state;
  for(let i=0;i<7;i++)state=noteWebResearch(state,{...call,arguments:{...call.arguments,offset:i}},{content:'Identical retained evidence',offset:i,resultId:`different_${i}`},{researchPage:true});
  assert.equal(state.pages,7);assert.equal(state.novel,1);assert.equal(state.duplicates,6);assert.equal(state.blocked,true);
});


test('Engine-budgeted Missions retain advisory counters without replacing their own evidence/budget gate',()=>{
  let state;
  for(let i=0;i<40;i++)state=noteWebResearch(state,...read(`https://example.com/required-source-${i}`,'Same syndicated facts'),{enforce:false});
  assert.equal(state.blocked,false);assert.equal(state.warning,true);assert.equal(state.duplicates,39);
  const summary=webResearchSummary(state);assert.equal(summary.guard,'mission_budget');assert.match(summary.notice,/individually required sources/);
});
