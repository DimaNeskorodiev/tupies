import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {Providers,presetKey} from '../lib/providers.mjs';
import {knownContextWindow} from '../lib/context-budget.mjs';

const KEY='provider-preset-fixture-key';
const PRESETS={deepseek:'https://api.deepseek.com',gemini:'https://generativelanguage.googleapis.com/v1beta/openai',groq:'https://api.groq.com/openai/v1',mistral:'https://api.mistral.ai/v1',together:'https://api.together.xyz/v1',fireworks:'https://api.fireworks.ai/inference/v1',zai:'https://api.z.ai/api/paas/v4',moonshot:'https://api.moonshot.ai/v1',minimax:'https://api.minimax.io/v1'};
async function store(t){const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-provider-presets-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return new Store(directory).init();}

test('direct provider presets are API-key chat-completions entries with fixed default URLs and a required key',async t=>{
  const providers=new Providers(await store(t)),catalog=providers.catalog();
  for(const [type,baseUrl] of Object.entries(PRESETS)) {
    const entry=catalog.find(item=>item.type===type);assert.ok(entry,type);
    assert.equal(entry.auth,'api-key');assert.equal(entry.transport,'chat-completions');assert.equal(entry.baseUrl,baseUrl);
    assert.throws(()=>providers.validate({type,name:type}),/API key/,type);
    const value=providers.validate({type,name:type,apiKey:KEY});assert.equal(value.baseUrl,baseUrl);assert.notEqual(value.secret,KEY);assert.equal(presetKey(value),type);
    const headers=await providers.headers({...value,id:`fixture-${type}`});assert.deepEqual(headers,{Authorization:`Bearer ${KEY}`});
    await assert.rejects(providers.headers({type,baseUrl,id:'missing'}),/API key/);
  }
  // Existing entries are unchanged.
  for(const type of ['openai','chatgpt','anthropic','xai','openrouter','ollama','custom'])assert.ok(catalog.some(item=>item.type===type));
});

test('Gemini catalog ids lose the models/ prefix and requests never send it',async t=>{
  const s=await store(t),requests=[];
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push({url:req.url,body:JSON.parse(raw || '{}')});res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url.endsWith('/models')?{object:'list',data:[{id:'models/gemini-2.5-flash',object:'model',owned_by:'google'},{id:'models/gemini-3-pro-preview'},{id:'models/text-embedding-004'}]}:{choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const providers=new Providers(s,{requestTimeout:5000}),connection={id:'gemini-fixture',type:'gemini',name:'Gemini',baseUrl:`http://127.0.0.1:${server.address().port}/v1beta/openai`,secret:s.seal(KEY),defaultModel:'models/gemini-2.5-flash'};
  await s.mutate(state=>{state.connections.push(connection);});
  const {models}=await providers.models(connection);
  assert.deepEqual(models.map(model=>model.id),['gemini-2.5-flash','gemini-3-pro-preview','text-embedding-004']);
  assert.deepEqual(models[0].reasoning,{supported:true,efforts:['none','low','medium','high'],defaultEffort:'',parameter:'reasoning_effort',source:'preset'});
  assert.equal(models[2].reasoning.supported,false);
  await providers.complete(connection,{messages:[{role:'user',content:'Hi.'}],reasoningEffort:'low'});
  assert.equal(requests.at(-1).body.model,'gemini-2.5-flash');assert.equal(requests.at(-1).body.reasoning_effort,'low');assert.equal(requests.at(-1).body.max_tokens,16_384);
});

test('known context windows cover the direct-provider families',()=>{
  for(const [type,model,window] of [['deepseek','deepseek-v4-flash',128_000],['gemini','gemini-2.5-pro',1_048_576],['gemini','gemini-3-flash',1_048_576],['openrouter','google/gemini-2.5-flash',1_048_576],
    ['zai','glm-4.5-air',128_000],['zai','glm-4.6',200_000],['moonshot','kimi-k2-0905-preview',262_144],['moonshot','kimi-k2-turbo',128_000],['groq','llama-3.3-70b-versatile',131_072],['mistral','mistral-large-latest',128_000],['mistral','codestral-latest',256_000]])
    assert.equal(knownContextWindow(type,model),window,`${type} ${model}`);
  assert.equal(knownContextWindow('minimax','MiniMax-M2'),null);
});
