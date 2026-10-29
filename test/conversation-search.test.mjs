import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {promises as fs} from 'node:fs';
import {searchConversations} from '../lib/conversation-search.mjs';
import {createStudioServer} from '../server.mjs';

const message=(id,content,createdAt='2026-10-28T12:00:00Z',role='assistant')=>({id,content,createdAt,role});
function state(){return {bots:[{id:'bot_one',name:'One'},{id:'bot_hidden',name:'Hidden',hidden:true}],rooms:[{id:'room_one',name:'Team'}],messages:{bot_one:[message('older_phrase','Alpha beta requirements.','2026-10-01'),message('newer_terms','Alpha, different wording, beta.')],bot_hidden:[message('hidden_match','Alpha beta hidden history.')]},roomMessages:{room_one:[message('room_match','Alpha beta room decision.')]},conversations:{bot_one:[message('canonical_secret','Alpha beta model-only instructions.')]}};}

test('owner search covers visible/hidden bot and room display transcripts, scopes exactly, and ranks phrase before recency',()=>{
  const data=state(),result=searchConversations(data,{query:'ALPHA beta',limit:2});
  assert.deepEqual(result.results.map(item=>item.messageId),['hidden_match','room_match']);assert.equal(result.total,4);assert.equal(result.hasMore,true);assert.equal(result.truncated,false);
  const bot=searchConversations(data,{query:'alpha beta',scope:'bot',conversationId:'bot_one'});assert.deepEqual(bot.results.map(item=>item.messageId),['older_phrase','newer_terms']);assert.equal(bot.results[0].createdAt,'2026-10-01T00:00:00.000Z');
  assert.deepEqual(searchConversations(data,{query:'alpha',scope:'room'}).results.map(item=>item.messageId),['room_match']);
  assert.equal(searchConversations(data,{query:'model-only'}).total,0,'Canonical model context is not a searchable display transcript.');
  assert.equal(searchConversations(data,{query:'nothing here'}).total,0);
});

test('search redacts before matching and excerpting and bounds presentation metadata',()=>{
  const secret='synthetic-search-credential',data=state();data.bots[0].name=`${secret} ${'N'.repeat(180)}`;data.messages.bot_one=[message('message_safe','prefix '.repeat(70)+`Needle ${secret} <img src=x onerror=alert(1)> `+'tail '.repeat(100),'not a date')];data.bots=data.bots.slice(0,1);data.rooms=[];
  const redact=value=>String(value).split(secret).join('[redacted]'),result=searchConversations(data,{query:'needle'},{redact});
  assert.equal(result.total,1);assert.ok(result.results[0].excerpt.length<=362);assert.ok(result.results[0].name.length<=120);assert.equal(result.results[0].createdAt,null);
  assert.ok(!JSON.stringify(result).includes(secret));assert.match(result.results[0].excerpt,/\[redacted\]/);assert.equal(searchConversations(data,{query:secret.slice(0,12)},{redact}).total,0);
});

test('bounded search interleaves newest messages and discloses partial coverage instead of silently dropping work',()=>{
  const data=state();data.rooms=[];data.messages.bot_one=[message('old','Needle older.'),message('new','Needle newest.')];data.messages.bot_hidden=[message('other_new','Needle other bot.')];
  const limited=searchConversations(data,{query:'needle'},{maxMessages:2});assert.equal(limited.scanned,2);assert.deepEqual(new Set(limited.results.map(item=>item.messageId)),new Set(['new','other_new']));assert.equal(limited.truncated,true);assert.match(limited.notice,/bounded part/);
  data.messages.bot_one=[message('small','Needle fits.'),message('oversize','Needle '+'x'.repeat(200001))];const chars=searchConversations(data,{query:'needle'},{maxChars:40});assert.equal(chars.truncated,true);assert.ok(!chars.results.some(item=>item.messageId==='oversize'));assert.ok(chars.results.some(item=>item.messageId==='small'));
});

test('invalid scope, limits, identifiers and overlong word sets are explicit errors',()=>{
  const data=state();for(const input of [{query:'x'},{query:'x'.repeat(201)},{query:Array.from({length:21},(_,i)=>`w${i}`).join(' ')},{query:'alpha',scope:'tool'},{query:'alpha',scope:'all',conversationId:'bot_one'},{query:'alpha',scope:'bot',conversationId:'../other'},{query:'alpha',limit:31},{query:'alpha',limit:0}])assert.throws(()=>searchConversations(data,input),error=>error.status===400);
  assert.throws(()=>searchConversations(data,{query:'alpha',scope:'bot',conversationId:'missing'}),error=>error.status===404);
});

test('HTTP search requires owner authentication, stays read-only, returns redacted bounded results and never invokes a model',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-owner-search-'));let inferences=0;
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,providers:{async complete(){inferences++;throw new Error('Search must not invoke a model.');}}});const {url}=await app.listen(0);
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});let cookie='';
  const request=async(route,options={})=>{const response=await fetch(url+route,{...options,headers:{...(cookie?{Cookie:cookie}:{}),...options.headers}});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  assert.equal((await request('/api/conversations/search?query=needle')).status,401);
  const setup=await request('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'disposable-search-password'})});cookie=setup.cookie;
  await app.store.mutate(state=>{state.connections.push({id:'search_provider',type:'openai',secret:app.store.seal('synthetic-http-search-credential')});state.messages.bot_atlas=[message('message_search_1','Needle synthetic-http-search-credential decision.')];});
  const before=JSON.stringify(app.store.state),found=await request('/api/conversations/search?query=needle&scope=bot&conversationId=bot_atlas');assert.equal(found.status,200);assert.equal(found.body.results[0].messageId,'message_search_1');assert.match(found.body.results[0].excerpt,/\[redacted\]/);assert.ok(!JSON.stringify(found.body).includes('synthetic-http-search-credential'));assert.equal(JSON.stringify(app.store.state),before);assert.equal(inferences,0);
  assert.equal((await request('/api/conversations/search?query=needle&scope=room&conversationId=bot_atlas')).status,404);
  assert.equal((await request(`/api/conversations/search?query=${encodeURIComponent(Array.from({length:21},(_,i)=>`w${i}`).join(' '))}`)).status,400);
  assert.equal((await request('/api/conversations/search?query=needle',{headers:{Origin:'https://foreign.invalid'}})).status,403);
});
