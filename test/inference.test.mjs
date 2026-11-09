import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStudioServer } from '../server.mjs';
import { Store } from '../lib/store.mjs';

const KEY='inference-fixture-key-never-public';
const answer=text=>({id:'response-inference-fixture',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:4,output_tokens:3}});
const toolResult=()=>({id:'response-inference-tool',status:'completed',output:[{type:'function_call',call_id:'inference-memory',name:'memory_search',arguments:'{"query":""}'}]});
const reasoningModel=(id,efforts=['low','medium','high'])=>({id,name:`Fixture ${id}`,supported_reasoning_levels:efforts.map(effort=>({effort,description:`Fixture ${effort}`})),default_reasoning_level:efforts[0]});
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
const isReview=body=>(body?.tools || []).some(tool=>tool.name==='memory_review_result' || tool.function?.name==='memory_review_result' || tool.tools?.some(item=>item.name==='memory_review_result'));
const emptyReview={changes:[],claims:[],reason:'No durable fixture facts.'};
async function until(read,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){const value=read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Inference fixture timed out.');}

async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-inference-'));
  const remote={requests:[],models:{data:[reasoningModel('reasoning-a'),reasoningModel('reasoning-b'),{id:'plain-model',name:'Plain fixture'}]},modelStatus:200,beforeModels:null,handler:()=>answer('The fixture task completed.')};
  const provider=http.createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
      remote.requests.push({url:req.url,method:req.method,headers:req.headers,body});
      res.setHeader('content-type','application/json');
      if(req.url==='/v1/models'){
        if(remote.beforeModels)await remote.beforeModels();
        res.writeHead(remote.modelStatus);res.end(JSON.stringify(remote.models));return;
      }
      if(['/v1/responses','/v1/chat/completions','/v1/messages'].includes(req.url)){
        if(isReview(body)) {
          const result=req.url==='/v1/responses'?{status:'completed',output:[{type:'function_call',call_id:'fixture-review',name:'memory_review_result',arguments:JSON.stringify(emptyReview)}]}:req.url==='/v1/messages'?{content:[{type:'tool_use',id:'fixture-review',name:'memory_review_result',input:emptyReview}],stop_reason:'tool_use'}:{choices:[{message:{role:'assistant',tool_calls:[{id:'fixture-review',type:'function',function:{name:'memory_review_result',arguments:JSON.stringify(emptyReview)}}]},finish_reason:'tool_calls'}]};
          res.end(JSON.stringify(result));return;
        }
        const result=await remote.handler(body,req.url,remote);res.end(JSON.stringify(result));return;
      }
      res.writeHead(404);res.end(JSON.stringify({error:{message:'Unknown fixture endpoint'}}));
    }catch(error){res.writeHead(500);res.end(JSON.stringify({error:{message:error.message}}));}
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,runTimeout:10000,requestTimeout:3000,allowTestOAuth:true,...options});
  const {url}=await app.listen(0);let cookie='',csrf='';
  async function request(route,{method='GET',data,headers={},security=true,authenticated=true}={}){
    const response=await fetch(url+route,{method,headers:{...(authenticated&&cookie?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...(security&&csrf?{'X-CSRF-Token':csrf}:{}),...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});
    const raw=await response.text();let result;try{result=JSON.parse(raw);}catch{result=raw;}return {status:response.status,body:result,response};
  }
  async function connect(type='openai',name=`Fixture ${type}`){
    const added=await request('/api/connections',{method:'POST',data:{name,type,baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,...(type!=='chatgpt'&&type!=='ollama'?{apiKey:KEY}:{}),defaultModel:'reasoning-a'}});
    assert.equal(added.status,201,JSON.stringify(added.body));return added.body;
  }
  const setup=await request('/api/setup',{method:'POST',data:{token:app.bootstrapToken,password:'inference-fixture-workspace-password'}});assert.equal(setup.status,201);cookie=setup.response.headers.get('set-cookie').split(';')[0];csrf=setup.body.csrf;
  t.after(async()=>{await app.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  return {app,directory,remote,request,connect,provider};
}
const inference='/api/bots/bot_atlas/inference';
const modelRequests=remote=>remote.requests.filter(request=>request.method==='POST' && !isReview(request.body));
const savedBot=f=>f.app.store.state.bots.find(bot=>bot.id==='bot_atlas');
async function waitRun(f,run){await until(()=>['completed','failed','cancelled','interrupted'].includes(f.app.store.state.runs.bot_atlas?.status));return f.app.store.state.runs.bot_atlas;}

test('automatic memory review uses real provider adapters with isolated bounded context across protocols',async t=>{
  for(const type of ['openai','anthropic','custom'])await t.test(type,async t=>{
    const f=await fixture(t);await f.connect(type);
    f.remote.handler=()=>type==='anthropic'?{content:[{type:'text',text:'Hello, fixture owner.'}],stop_reason:'end_turn'}:type==='custom'?{choices:[{message:{role:'assistant',content:'Hello, fixture owner.'},finish_reason:'stop'}]}:answer('Hello, fixture owner.');
    await f.app.store.mutate(state=>{state.messages.bot_atlas=[{id:'old_private_fixture',role:'user',runId:'old_run',sessionId:'bot_atlas--telegram-private',content:'PRIVATE-REVIEW-CANARY'}];});
    const response=await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'My name is Fixture.'}});assert.equal(response.status,202);
    await waitRun(f,response.body.run);for(let i=0;i<200&&!f.app.store.state.runs.bot_atlas?.memoryReview;i++)await new Promise(r=>setTimeout(r,25));const finished=f.app.store.state.runs.bot_atlas;assert.equal(finished.status,'completed');assert.equal(finished.memoryReview.status,'reviewed');
    const review=f.remote.requests.find(request=>isReview(request.body));assert.ok(review);assert.ok(!JSON.stringify(review.body).includes('PRIVATE-REVIEW-CANARY'));
    assert.equal(review.body.max_output_tokens ?? review.body.max_tokens,1536);assert.equal(review.body.model,'reasoning-a');assert.equal(modelRequests(f.remote).length,1);
  });
});

test('inference catalog exposes only explicit safe reasoning metadata and never infers model-name capabilities',async t=>{
  const f=await fixture(t);await f.connect();
  f.remote.models={data:[
    {...reasoningModel('reasoning-a',['low','medium','high','xhigh','max','ultra','bogus']),default_reasoning_level:'medium',extra:'not-public',secret:KEY},
    {id:'alias-model',display_name:'Alias fixture',supported_reasoning_efforts:['none','minimal','low','high','high','bogus'],default_reasoning_effort:'low'},
    {id:'gpt-5-reasoning-looking-name',name:'Unadvertised support'},
    {id:'boolean-support',capabilities:{reasoning:true}}
  ]};
  const result=await f.request(inference);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.appliesTo,'next-run');assert.equal(result.body.effectiveModel,'reasoning-a');
  const models=result.body.models,explicit=models.find(model=>model.id==='reasoning-a');assert.equal(explicit.reasoning.supported,true);assert.deepEqual(explicit.reasoning.efforts,['low','medium','high','xhigh','max']);assert.equal(explicit.reasoning.defaultEffort,'medium');assert.equal(explicit.reasoning.parameter,'reasoning.effort');assert.equal(explicit.reasoning.source,'provider');
  const alias=models.find(model=>model.id==='alias-model');assert.deepEqual(alias.reasoning.efforts,['none','minimal','low','high']);
  for(const id of ['gpt-5-reasoning-looking-name','boolean-support']){const cap=models.find(model=>model.id===id).reasoning;assert.equal(cap.supported,false);assert.deepEqual(cap.efforts,[]);}
  assert.ok(models.every(model=>Object.keys(model).every(key=>['id','name','reasoning','imageInput'].includes(key))));
  // Image input is the one capability a well-known family may imply, because a refused image is retried without it.
  assert.deepEqual(models.find(model=>model.id==='gpt-5-reasoning-looking-name').imageInput,{supported:true,source:'known'});
  assert.deepEqual(models.find(model=>model.id==='boolean-support').imageInput,{supported:false,source:'unknown'});assert.ok(!JSON.stringify(result.body).includes(KEY));assert.ok(!JSON.stringify(result.body).includes('not-public'));assert.equal(modelRequests(f.remote).length,0);
  const connectionModels=await f.request(`/api/connections/${result.body.connectionId}/models`);assert.deepEqual(connectionModels.body.models.find(model=>model.id==='reasoning-a').reasoning,explicit.reasoning);
});

test('per-bot inference selection persists without changing workspace defaults, provider defaults or other bots',async t=>{
  const f=await fixture(t),connection=await f.connect();
  const before=structuredClone(f.app.store.state),changed=await f.request(inference,{method:'PATCH',data:{model:'reasoning-b',reasoningEffort:'high'}});
  assert.equal(changed.status,200,JSON.stringify(changed.body));assert.equal(changed.body.bot.model,'reasoning-b');assert.equal(changed.body.bot.reasoningEffort,'high');assert.equal(savedBot(f).model,'reasoning-b');assert.equal(savedBot(f).reasoningEffort,'high');
  assert.equal(f.app.store.state.connections.find(item=>item.id===connection.id).defaultModel,'reasoning-a');assert.deepEqual(f.app.store.state.settings,before.settings);
  for(const bot of before.bots.filter(bot=>bot.id!=='bot_atlas'))assert.deepEqual(f.app.store.state.bots.find(item=>item.id===bot.id),bot);
  const restored=await new Store(f.directory).init();assert.equal(restored.state.bots.find(bot=>bot.id==='bot_atlas').reasoningEffort,'high');
  const cleared=await f.request(inference,{method:'PATCH',data:{model:'',reasoningEffort:''}});assert.equal(cleared.status,200,JSON.stringify(cleared.body));assert.equal(cleared.body.effectiveModel,'reasoning-a');assert.equal(savedBot(f).model,'');assert.equal(savedBot(f).reasoningEffort,'');assert.equal(modelRequests(f.remote).length,0);
});

test('inference changes require authentication and CSRF and reject unknown models, unsupported efforts and failed catalogs atomically',async t=>{
  const f=await fixture(t);await f.connect();
  assert.equal((await f.request(inference,{authenticated:false})).status,401);
  assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-b',reasoningEffort:'high'},security:false})).status,403);
  assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-b',reasoningEffort:'high'},headers:{Origin:'https://foreign.invalid'}})).status,403);
  const before=structuredClone(savedBot(f));
  for(const data of [
    {model:'missing-model',reasoningEffort:''},{model:'plain-model',reasoningEffort:'high'},{model:'reasoning-a',reasoningEffort:'ultra'},{model:'reasoning-a',reasoningEffort:'bogus'},
    {model:3,reasoningEffort:''},{model:'reasoning-a',reasoningEffort:null},{model:'reasoning-a',reasoningEffort:'high',connectionId:'unrelated'}
  ]){const rejected=await f.request(inference,{method:'PATCH',data});assert.equal(rejected.status,400,JSON.stringify(rejected.body));assert.deepEqual(savedBot(f),before);}
  f.remote.models={data:[]};assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-a',reasoningEffort:''}})).status,409);assert.deepEqual(savedBot(f),before);
  f.remote.modelStatus=503;f.remote.models={error:{message:'Fixture discovery unavailable'}};assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-a',reasoningEffort:''}})).status,502);assert.deepEqual(savedBot(f),before);assert.equal(modelRequests(f.remote).length,0);
});

test('catalog selection cannot commit after its provider credentials or bot provider binding changed',async t=>{
  const f=await fixture(t),connection=await f.connect(),other=await f.connect('openai','Another fixture provider');
  let entered=false;const held=gate();f.remote.beforeModels=async()=>{entered=true;await held.promise;};
  const choosing=f.request(inference,{method:'PATCH',data:{model:'reasoning-b',reasoningEffort:'high'}});await until(()=>entered);
  await f.app.store.mutate(state=>{state.connections.find(item=>item.id===connection.id).secret=f.app.store.seal('replacement-fixture-secret');});held.release();const changed=await choosing;assert.equal(changed.status,409,JSON.stringify(changed.body));assert.equal(savedBot(f).model,'');assert.equal(savedBot(f).reasoningEffort,'auto');
  entered=false;const heldAgain=gate();f.remote.beforeModels=async()=>{entered=true;await heldAgain.promise;};
  const moving=f.request(inference,{method:'PATCH',data:{model:'reasoning-b',reasoningEffort:'high'}});await until(()=>entered);
  await f.app.store.mutate(state=>{state.bots.find(bot=>bot.id==='bot_atlas').connectionId=other.id;});heldAgain.release();const moved=await moving;assert.equal(moved.status,409,JSON.stringify(moved.body));assert.equal(savedBot(f).connectionId,other.id);assert.equal(savedBot(f).model,'');assert.equal(modelRequests(f.remote).length,0);
});

test('an active run keeps its model and reasoning for tool continuation while edits apply to the next task',async t=>{
  const f=await fixture(t);await f.connect();
  assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-a',reasoningEffort:'low'}})).status,200);
  const held=gate();let entered=false,posts=0;
  f.remote.handler=async()=>{posts++;if(posts===1){entered=true;await held.promise;return toolResult();}return answer(posts===2?'First run continued.':'Second run completed.');};
  const started=await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Use a tool, then finish.'}});assert.equal(started.status,202);await until(()=>entered);
  // New selections refresh the catalog; the admitted run must retain its earlier capability snapshot.
  f.remote.models={data:[{id:'reasoning-a',name:'Previous metadata no longer advertised'},reasoningModel('reasoning-b')]};
  const changed=await f.request(inference,{method:'PATCH',data:{model:'reasoning-b',reasoningEffort:'high'}});assert.equal(changed.status,200,JSON.stringify(changed.body));assert.equal(savedBot(f).model,'reasoning-b');held.release();
  const finished=await waitRun(f,started.body.run);assert.equal(finished.status,'completed',finished.error);
  const first=modelRequests(f.remote);assert.equal(first.length,2);for(const request of first){assert.equal(request.body.model,'reasoning-a');assert.deepEqual(request.body.reasoning,{effort:'low'});assert.equal(request.body.reasoning_effort,undefined);}
  const next=await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Use the next selection.'}});assert.equal(next.status,202);assert.equal((await waitRun(f,next.body.run)).status,'completed');const later=modelRequests(f.remote).at(-1);assert.equal(later.body.model,'reasoning-b');assert.deepEqual(later.body.reasoning,{effort:'high'});
});

test('ChatGPT Responses uses explicit catalog reasoning support without exposing OAuth secrets',async t=>{
  const f=await fixture(t),connection=await f.connect('chatgpt');
  await f.app.store.mutate(state=>{const current=state.connections.find(item=>item.id===connection.id);current.oauthSecret=f.app.store.seal('isolated-fixture-oauth-state');current.oauthAccount={planEnabled:true,needsLogin:false};});
  f.app.providers.oauth.bearer=async()=>KEY;
  const saved=await f.request(inference,{method:'PATCH',data:{model:'reasoning-a',reasoningEffort:'medium'}});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.ok(!JSON.stringify(saved.body).includes('isolated-fixture-oauth-state'));assert.ok(!JSON.stringify(saved.body).includes(KEY));
  const run=await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Use plan fixture reasoning.'}});assert.equal(run.status,202);assert.equal((await waitRun(f,run.body.run)).status,'completed');const request=modelRequests(f.remote).at(-1);assert.equal(request.url,'/v1/responses');assert.deepEqual(request.body.reasoning,{effort:'medium'});assert.equal(request.headers.authorization,`Bearer ${KEY}`);
});

test('recognized compatible providers send reasoning_effort only with explicit model parameter support',async t=>{
  for(const type of ['xai','openrouter'])await t.test(type,async t=>{
    const f=await fixture(t);await f.connect(type);f.remote.models={data:[{...reasoningModel('reasoning-a'),supported_parameters:['reasoning_effort']},{...reasoningModel('advertised-levels-only'),supported_parameters:['temperature']},{...reasoningModel('misleading-parameter-string'),supported_parameters:'not_reasoning_effort'}]};
    const result=await f.request(inference);assert.equal(result.status,200);assert.equal(result.body.models.find(model=>model.id==='reasoning-a').reasoning.parameter,'reasoning_effort');assert.equal(result.body.models.find(model=>model.id==='advertised-levels-only').reasoning.supported,false);assert.equal(result.body.models.find(model=>model.id==='misleading-parameter-string').reasoning.supported,false);
    const changed=await f.request(inference,{method:'PATCH',data:{model:'reasoning-a',reasoningEffort:'high'}});assert.equal(changed.status,200,JSON.stringify(changed.body));f.remote.handler=()=>({choices:[{message:{role:'assistant',content:'Compatible fixture completed.'},finish_reason:'stop'}]});
    const started=await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Use explicit compatible effort.'}});assert.equal(started.status,202);assert.equal((await waitRun(f,started.body.run)).status,'completed');const request=modelRequests(f.remote).at(-1);assert.equal(request.url,'/v1/chat/completions');assert.equal(request.body.reasoning_effort,'high');assert.equal(request.body.reasoning,undefined);
  });
});

test('unknown compatible and Anthropic transports retain provider defaults and never receive speculative reasoning fields',async t=>{
  for(const type of ['custom','ollama','anthropic'])await t.test(type,async t=>{
    const f=await fixture(t);await f.connect(type);f.remote.models={data:[{...reasoningModel('reasoning-a'),supported_parameters:['reasoning_effort']}]};
    const current=await f.request(inference);assert.equal(current.status,200);assert.equal(current.body.reasoning.supported,false);assert.deepEqual(current.body.reasoning.efforts,[]);
    assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-a',reasoningEffort:'high'}})).status,400);assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-a',reasoningEffort:''}})).status,200);
    f.remote.handler=()=>type==='anthropic'?{content:[{type:'text',text:'Anthropic fixture default.'}],stop_reason:'end_turn',usage:{output_tokens:3}}:{choices:[{message:{role:'assistant',content:'Compatible fixture default.'},finish_reason:'stop'}]};
    const run=await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Use the provider default.'}});assert.equal(run.status,202);const finished=await waitRun(f,run.body.run);assert.equal(finished.status,'completed',finished.error);const request=modelRequests(f.remote).at(-1);assert.equal(request.body.reasoning,undefined);assert.equal(request.body.reasoning_effort,undefined);assert.equal(request.body.thinking,undefined);
  });
});

test('reasoning history survives same-model effort changes and becomes canonical across model switches or unmarked legacy history',async t=>{
  const f=await fixture(t);await f.connect();assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-a',reasoningEffort:'low'}})).status,200);
  let posts=0;f.remote.handler=()=>{
    posts++;
    if(posts===1)return {id:'reasoning-history-fixture',status:'completed',output:[
      {type:'reasoning',id:'old-reasoning',encrypted_content:'opaque-for-model-a'},
      {type:'message',role:'assistant',content:[{type:'output_text',text:'Canonical pre-tool answer.'}]},
      {type:'function_call',call_id:'inference-memory',name:'memory_search',arguments:'{"query":""}'}
    ]};
    return answer('Canonical final answer.');
  };
  async function run(text){const response=await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text}});assert.equal(response.status,202);const finished=await waitRun(f,response.body.run);assert.equal(finished.status,'completed',finished.error);return modelRequests(f.remote).at(-1).body;}
  const continued=await run('Remember the completed tool history.');assert.ok(continued.input.some(item=>item.encrypted_content==='opaque-for-model-a'));
  const original=f.app.store.state.conversations.bot_atlas.find(message=>message.providerItems?.some(item=>item.encrypted_content==='opaque-for-model-a'));
  assert.deepEqual(original.providerContext,{connectionId:savedBot(f).connectionId,provider:'openai',model:'reasoning-a'});

  assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-a',reasoningEffort:'high'}})).status,200);
  const sameModel=await run('Change effort while keeping the same model.');assert.deepEqual(sameModel.reasoning,{effort:'high'});assert.ok(sameModel.input.some(item=>item.encrypted_content==='opaque-for-model-a'));

  assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-b',reasoningEffort:'high'}})).status,200);
  const switched=await run('Use the next model with canonical prior history.');assert.equal(switched.model,'reasoning-b');assert.ok(!switched.input.some(item=>item.encrypted_content==='opaque-for-model-a'));
  assert.ok(switched.input.some(item=>item.role==='assistant'&&item.content==='Canonical pre-tool answer.'));assert.ok(switched.input.some(item=>item.type==='function_call'&&item.call_id==='inference-memory'));assert.ok(switched.input.some(item=>item.type==='function_call_output'&&item.call_id==='inference-memory'));

  await f.app.store.mutate(state=>state.conversations.bot_atlas.push(
    {role:'assistant',content:'Legacy canonical answer.',providerItems:[{type:'reasoning',id:'legacy-reasoning',encrypted_content:'unmarked-legacy-opaque'}],tool_calls:[{id:'legacy-call',type:'function',function:{name:'memory_search',arguments:'{"query":""}'}}]},
    {role:'tool',tool_call_id:'legacy-call',content:'Legacy tool result.'}
  ));
  const legacy=await run('Continue safely from imported old history.');assert.ok(!legacy.input.some(item=>item.encrypted_content==='unmarked-legacy-opaque'));assert.ok(legacy.input.some(item=>item.role==='assistant'&&item.content==='Legacy canonical answer.'));assert.ok(legacy.input.some(item=>item.type==='function_call'&&item.call_id==='legacy-call'));assert.ok(legacy.input.some(item=>item.type==='function_call_output'&&item.call_id==='legacy-call'));
  assert.ok(f.app.store.state.conversations.bot_atlas.some(message=>message.providerItems?.some(item=>item.encrypted_content==='unmarked-legacy-opaque')),'Normalization should preserve the durable transcript rather than rewrite its opaque history.');
});

test('generic bot edits cannot bypass effort validation and model or workspace-default changes preserve reasoning preferences',async t=>{
  const f=await fixture(t),connection=await f.connect();
  assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-a',reasoningEffort:'high'}})).status,200);
  const bypass=await f.request('/api/bots/bot_atlas',{method:'PATCH',data:{reasoningEffort:'ultra'}});assert.equal(bypass.status,400);assert.equal(savedBot(f).reasoningEffort,'high');
  assert.equal((await f.request('/api/bots/bot_atlas',{method:'PATCH',data:{model:'plain-model'}})).status,200);assert.equal(savedBot(f).model,'plain-model');assert.equal(savedBot(f).reasoningEffort,'high');
  assert.equal((await f.request(inference)).body.effectiveReasoningEffort,'');
  assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-a',reasoningEffort:'low'}})).status,200);
  const other=await f.connect('openai','Alternative fixture');assert.equal((await f.request('/api/bots/bot_atlas',{method:'PATCH',data:{connectionId:other.id}})).status,200);assert.equal(savedBot(f).reasoningEffort,'low');
  assert.equal((await f.request(inference,{method:'PATCH',data:{model:'reasoning-a',reasoningEffort:'medium'}})).status,200);
  const changed=await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'reasoning-b',applyToAllBots:true}});assert.equal(changed.status,200,JSON.stringify(changed.body));assert.equal(savedBot(f).model,'');assert.equal(savedBot(f).reasoningEffort,'medium');assert.equal(savedBot(f).connectionId,connection.id);
});

test('automatic High is the default for new bots, follows model changes and keeps explicit provider default selectable',async t=>{
  const f=await fixture(t),connection=await f.connect();
  const created=await f.request('/api/bots',{method:'POST',data:{name:'Default reasoning',title:'Fixture helper',connectionId:connection.id}});
  assert.equal(created.status,201);assert.equal(created.body.reasoningEffort,'auto');assert.equal(created.body.reasoningEffortVersion,1);
  const current=await f.request(inference);assert.equal(current.body.reasoningEffort,'auto');assert.equal(current.body.effectiveReasoningEffort,'high');
  async function run(text){const response=await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text}});assert.equal(response.status,202);const finished=await waitRun(f,response.body.run);assert.equal(finished.status,'completed',finished.error);return {body:modelRequests(f.remote).at(-1).body,run:finished};}
  const automatic=await run('Use the default.');assert.deepEqual(automatic.body.reasoning,{effort:'high'});assert.equal(automatic.run.reasoningEffort,'high');
  const plain=await f.request(inference,{method:'PATCH',data:{model:'plain-model'}});assert.equal(plain.status,200);assert.equal(plain.body.reasoningEffort,'auto');assert.equal(plain.body.effectiveReasoningEffort,'');
  assert.equal((await run('Use an unsupported model.')).body.reasoning,undefined);
  const switched=await f.request(inference,{method:'PATCH',data:{model:'reasoning-b'}});assert.equal(switched.status,200);assert.equal(switched.body.effectiveReasoningEffort,'high');
  assert.deepEqual((await run('Use High again.')).body.reasoning,{effort:'high'});
  const provider=await f.request(inference,{method:'PATCH',data:{reasoningEffort:''}});assert.equal(provider.status,200);assert.equal(provider.body.effectiveReasoningEffort,'');
  assert.equal((await run('Use the explicit provider default.')).body.reasoning,undefined);
  assert.equal((await new Store(f.directory).init()).state.bots.find(bot=>bot.id==='bot_atlas').reasoningEffort,'');
  const reset=await f.request(inference,{method:'PATCH',data:{reasoningEffort:'auto'}});assert.equal(reset.status,200);assert.equal(reset.body.effectiveReasoningEffort,'high');
  assert.deepEqual((await run('Restore automatic High.')).body.reasoning,{effort:'high'});
});

test('catalog refresh caches current reasoning metadata and retains configured models beyond the first 200',async t=>{
  const f=await fixture(t),connection=await f.connect();
  const unused=Array.from({length:205},(_,index)=>({id:`unused-${index}`}));
  f.remote.models={data:[...unused,reasoningModel('reasoning-a'),reasoningModel('reasoning-b')]};
  await f.app.store.mutate(state=>{state.bots.find(bot=>bot.id==='bot_nova').model='reasoning-b';});
  const refreshed=await f.request(inference);assert.equal(refreshed.status,200);assert.equal(refreshed.body.effectiveReasoningEffort,'high');
  let cached=f.app.store.state.connections.find(item=>item.id===connection.id).models;
  assert.equal(cached.length,200);assert.equal(cached.find(model=>model.id==='reasoning-a').reasoning.supported,true);assert.equal(cached.find(model=>model.id==='reasoning-b').reasoning.supported,true);
  const tested=await f.request(`/api/connections/${connection.id}/test`,{method:'POST',data:{}});assert.equal(tested.status,200);
  cached=f.app.store.state.connections.find(item=>item.id===connection.id).models;
  assert.ok(cached.some(model=>model.id==='reasoning-a'));assert.ok(cached.some(model=>model.id==='reasoning-b'));
  const started=await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text:'Use the metadata shown in Chat options.'}});assert.equal(started.status,202);assert.equal((await waitRun(f,started.body.run)).status,'completed');
  assert.deepEqual(modelRequests(f.remote).at(-1).body.reasoning,{effort:'high'});
});

test('legacy synced defaults resolve to High while an explicit new provider-default choice stays empty',async t=>{
  const f=await fixture(t);await f.connect();
  await f.app.store.mutate(state=>{const bot=state.bots.find(bot=>bot.id==='bot_atlas');bot.reasoningEffort='';delete bot.reasoningEffortVersion;});
  const legacy=await f.request(inference);assert.equal(legacy.body.reasoningEffort,'auto');assert.equal(legacy.body.effectiveReasoningEffort,'high');
  const selected=await f.request(inference,{method:'PATCH',data:{reasoningEffort:''}});assert.equal(selected.status,200);assert.equal(selected.body.reasoningEffort,'');assert.equal(selected.body.effectiveReasoningEffort,'');assert.equal(savedBot(f).reasoningEffortVersion,1);
});

test('changing the shared default retains metadata for unaffected bot overrides beyond the catalog prefix',async t=>{
  const f=await fixture(t),connection=await f.connect();
  f.remote.models={data:[...Array.from({length:205},(_,i)=>({id:`plain-${i}`})),reasoningModel('reasoning-a'),reasoningModel('reasoning-b')]};
  await f.app.store.mutate(state=>{const bot=state.bots.find(bot=>bot.id==='bot_nova');bot.model='reasoning-b';});
  const selected=await f.request(`/api/connections/${connection.id}/default-model`,{method:'POST',data:{model:'reasoning-a',applyToAllBots:false}});assert.equal(selected.status,200);
  const cached=f.app.store.state.connections.find(item=>item.id===connection.id).models;
  assert.ok(cached.some(item=>item.id==='reasoning-b'&&item.reasoning.efforts.includes('high')));
});

test('preset reasoning reaches the inference API and requests: OpenRouter reasoning.effort and Anthropic thinking, with auto sending nothing',async t=>{
  for(const [type,model,record,effort,expected] of [
    ['openrouter','deepseek/deepseek-v4.1-flash',{id:'deepseek/deepseek-v4.1-flash',name:'DeepSeek flash',reasoning:{supported_efforts:['high','medium','low','none'],mandatory:false}},'medium',body=>assert.deepEqual(body.reasoning,{effort:'medium'})],
    ['anthropic','claude-sonnet-4-5',{id:'claude-sonnet-4-5',display_name:'Claude Sonnet 4.5'},'high',body=>{assert.deepEqual(body.thinking,{type:'enabled',budget_tokens:16384});assert.equal(body.max_tokens,16384+4096);}]
  ])await t.test(type,async t=>{
    const f=await fixture(t);await f.connect(type);f.remote.models={data:[record]};
    f.remote.handler=()=>type==='anthropic'?{content:[{type:'text',text:'Preset fixture.'}],stop_reason:'end_turn',usage:{output_tokens:3}}:{choices:[{message:{role:'assistant',content:'Preset fixture.'},finish_reason:'stop'}]};
    const automatic=await f.request(inference,{method:'PATCH',data:{model,reasoningEffort:'auto'}});assert.equal(automatic.status,200,JSON.stringify(automatic.body));
    assert.equal(automatic.body.reasoning.supported,true);assert.ok(automatic.body.reasoning.efforts.includes(effort));assert.equal(automatic.body.effectiveReasoningEffort,'');
    async function run(text){const response=await f.request('/api/bots/bot_atlas/messages',{method:'POST',data:{text}});assert.equal(response.status,202);const finished=await waitRun(f,response.body.run);assert.equal(finished.status,'completed',finished.error);return modelRequests(f.remote).at(-1).body;}
    const plain=await run('Use the provider default.');assert.equal(plain.reasoning,undefined);assert.equal(plain.reasoning_effort,undefined);assert.equal(plain.thinking,undefined);
    const chosen=await f.request(inference,{method:'PATCH',data:{reasoningEffort:effort}});assert.equal(chosen.status,200,JSON.stringify(chosen.body));assert.equal(chosen.body.effectiveReasoningEffort,effort);
    expected(await run('Use the chosen effort.'));
  });
});
