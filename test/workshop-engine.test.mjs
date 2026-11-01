import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine,isActive } from '../lib/engine.mjs';
import { Integrations } from '../lib/integrations.mjs';
const definition={id:'double-value',title:'Double value',description:'A synthetic pure numeric transform.',source:'x=>2*x',tests:[{input:3,expected:6}]};
const call=(id,name,args)=>({id,name,arguments:args});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const deadline=Date.now()+12000;while(Date.now()<deadline){const value=fn();if(value)return value;await delay(10);}throw new Error('Workshop fixture timed out');}
async function fixture(t,complete,{strict=false}={}){const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-workshop-engine-')),store=await new Store(directory).init();await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture'});Object.assign(state.bots[0],{tools:['workspace','workshop'],connectionId:'fixture',approvalPolicy:strict?'strict':'balanced'});});let turn=0;const engine=new NativeEngine(store,{providers:{async complete(_c,request){return complete(request,++turn);}}});await engine.recover();t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});return {engine,store,bot:store.state.bots[0],settled:async started=>{await until(()=>!isActive(store.state.runs.bot_atlas));await engine.tasks.get(started.id);return store.state.runs.bot_atlas;}};}
test('a bot autonomously builds, tests, uses and proposes a reusable tool in the real Engine',async t=>{
  let digest;const h=await fixture(t,async(request,turn)=>{
    assert.ok(request.tools.some(x=>x.name==='workshop_build'));
    const result=id=>JSON.parse(request.messages.findLast(x=>x.tool_call_id===id).content);
    if(turn===1)return {text:'',toolCalls:[call('build','workshop_build',definition)]};
    if(turn===2){digest=result('build').digest;assert.ok(digest);return {text:'',toolCalls:[call('run','workshop_run',{digest,input:21})]};}
    if(turn===3){assert.equal(result('run').output,42);return {text:'',toolCalls:[call('propose','improvement_propose',{kind:'tool',title:'Double numbers',summary:'Generic reusable transform.',toolDigest:digest})]};}
    assert.equal(result('propose').status,'local-review');return {text:'Computed 42 and saved a local proposal.',toolCalls:[]};
  });
  const run=await h.engine.start(h.bot.id,'Build a double-value tool and propose it for reuse.');const done=await h.settled(run);assert.equal(done.status,'completed',done.error);assert.equal(done.workRecords.filter(x=>x.status==='succeeded').length,3);assert.equal(done.events.some(x=>x.type==='approval.request'),false);
});
test('Strict package creation waits for exact approval and denial does not persist a package',async t=>{
  const h=await fixture(t,async(_request,turn)=>turn===1?{text:'',toolCalls:[call('build','workshop_build',definition)]}:{text:'Creation was declined.',toolCalls:[]},{strict:true});
  const run=await h.engine.start(h.bot.id,'Create a pure local tool.');await until(()=>h.store.state.runs[h.bot.id]?.status==='waiting_for_approval');const pending=h.store.state.runs[h.bot.id];assert.equal(pending.pending_controls[0].tool,'workshop_build');await h.engine.control(h.bot.id,'approval',{runId:pending.id,remoteRunId:pending.remoteRunId,request_id:pending.pending_controls[0].prompt_id,execution_generation:pending.execution_generation,choice:'deny'});await h.settled(run);assert.equal((await h.engine.tools.execute(h.bot,'workshop_list',{})).tools.length,0);
});
test('Stop cancels isolated computation, preserves the package and never marks the task successful',async t=>{
  let digest;const h=await fixture(t,async()=>({text:'',toolCalls:[call('loop','workshop_run',{digest,input:true})]}));
  const built=await h.engine.tools.execute(h.bot,'workshop_build',{...definition,source:'x=>{if(x)while(true){};return 0}',tests:[{input:false,expected:0}]});digest=built.digest;
  const run=await h.engine.start(h.bot.id,'Run the cancellable fixture.');await until(()=>h.store.state.runs[h.bot.id]?.events?.some(x=>x.type==='tool.started'&&x.tool==='workshop_run'));await delay(100);await h.engine.control(h.bot.id,'stop',{runId:run.id,remoteRunId:run.remoteRunId});assert.equal((await h.settled(run)).status,'cancelled');assert.equal((await h.engine.tools.execute(h.bot,'workshop_run',{digest,input:false})).output,0);
});

async function withGateway(h,request) {
  const integrations=new Integrations(h.store);
  integrations.request=request;
  const integration={id:'synthetic_api',...integrations.validate({name:'Synthetic API',type:'rest',baseUrl:'https://example.com',authType:'none',tools:[{name:'read',method:'GET',path:'/items',inputSchema:{type:'object',properties:{},additionalProperties:false}}]})};
  await h.store.mutate(state=>{state.integrations=[integration];Object.assign(state.bots[0],{tools:['workspace','workshop','integrations'],integrationIds:[integration.id]});});
  h.engine.tools.options.integrations=integrations;
  const built=await h.engine.tools.execute(h.store.state.bots[0],'workshop_build',{...definition,source:'x=>x.response.value*x.data',tests:[{input:{data:2,response:{value:3}},expected:6}]});
  return {digest:built.digest,integrationId:integration.id,tool:'read',arguments:{},input:2};
}
async function pendingApproval(h) {
  await until(()=>h.store.state.runs[h.bot.id]?.status==='waiting_for_approval');return h.store.state.runs[h.bot.id];
}
test('real Engine reads exact source, checks a candidate and records its local proposal without changing live source',async t=>{
  let sha;const h=await fixture(t,async(request,turn)=>{
    const previous=()=>JSON.parse(request.messages.findLast(x=>x.role==='tool').content);
    if(turn===1)return {text:'',toolCalls:[call('sources','engine_source_list',{prefix:'lib/fixture'})]};
    if(turn===2){sha=previous().files[0].sha256;return {text:'',toolCalls:[call('source','engine_source_read',{path:'lib/fixture.mjs',sha256:sha})]};}
    if(turn===3){assert.match(previous().content,/x\+1/);return {text:'',toolCalls:[call('candidate','engine_candidate_build',{title:'Fixture increment',summary:'Synthetic candidate',changes:[{path:'lib/fixture.mjs',sha256:sha,oldText:'x+1',newText:'x+2'}],dependencies:[],tests:[{path:'lib/fixture.mjs',exportName:'increment',input:40,expected:42}]})]};}
    assert.equal(previous().verification.tests[0].passed,true);assert.equal(previous().verification.fullSuite,false);return {text:'Candidate saved for review; full Engine tests still required.',toolCalls:[]};
  });
  const root=h.store.directory+'-fixture-source';t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'lib'),{recursive:true});await fs.writeFile(path.join(root,'lib/fixture.mjs'),'export const increment=x=>x+1;\n');
  h.engine.tools.options.engineSourceRoot=root;await h.store.mutate(state=>{state.bots[0].tools=['engine_workshop'];});
  const run=await h.engine.start(h.bot.id,'Prepare an isolated source improvement.'),done=await h.settled(run);
  assert.equal(done.status,'completed',done.error);assert.equal(done.events.some(x=>x.type==='approval.request'),false);assert.equal(done.workRecords.find(x=>x.tool==='engine_candidate_build').status,'succeeded');assert.equal(await fs.readFile(path.join(root,'lib/fixture.mjs'),'utf8'),'export const increment=x=>x+1;\n');
});
test('Strict Engine candidate denial and Stop never publish a proposal',async t=>{
  for(const decision of ['deny','stop']){
    const h=await fixture(t,async(_request,turn)=>turn===1?{text:'',toolCalls:[call('candidate','engine_candidate_build',{title:'Fixture',summary:'New synthetic module',changes:[{path:'lib/new.mjs',sha256:null,oldText:'',newText:'export const value=x=>x;'}],dependencies:[],tests:[]})]}:{text:'Candidate was not created.',toolCalls:[]},{strict:true});
    await h.store.mutate(state=>{state.bots[0].tools=['engine_workshop'];});const run=await h.engine.start(h.bot.id,'Prepare a candidate.'),pending=await pendingApproval(h);
    assert.equal(pending.pending_controls[0].tool,'engine_candidate_build');if(decision==='deny')await decide(h,pending,'deny');else await h.engine.control(h.bot.id,'stop',{runId:run.id,remoteRunId:run.remoteRunId});await h.settled(run);
    await assert.rejects(fs.stat(path.join(h.store.directory,'workshop',h.bot.id,'candidates')),/ENOENT/);
  }
});
async function decide(h,pending,choice) {
  return h.engine.control(h.bot.id,'approval',{runId:pending.id,remoteRunId:pending.remoteRunId,request_id:pending.pending_controls[0].prompt_id,execution_generation:pending.execution_generation,choice});
}
test('real Engine waits for exact gateway approval and records one processed response',async t=>{
  let args,requests=0;const h=await fixture(t,async(request,turn)=>{
    if(turn===1)return {text:'',toolCalls:[call('api','workshop_read_api',args)]};
    const result=JSON.parse(request.messages.findLast(x=>x.tool_call_id==='api').content);assert.equal(result.output,42);return {text:'Processed the approved response: 42.',toolCalls:[]};
  });
  args=await withGateway(h,async()=>{requests++;return {data:{value:21},streaming:false};});
  const run=await h.engine.start(h.bot.id,'Read the assigned API and process its JSON.'),pending=await pendingApproval(h);
  assert.equal(requests,0);assert.equal(pending.pending_controls[0].tool,'workshop_read_api');assert.equal(pending.pending_controls[0].review.packageDigest,args.digest);
  await decide(h,pending,'once');const done=await h.settled(run);assert.equal(done.status,'completed',done.error);assert.equal(requests,1);assert.equal(done.workRecords.find(x=>x.tool==='workshop_read_api').status,'succeeded');
});
test('denying a gateway read sends no external request',async t=>{
  let args,requests=0;const h=await fixture(t,async(_request,turn)=>turn===1?{text:'',toolCalls:[call('api','workshop_read_api',args)]}:{text:'The read was declined.',toolCalls:[]});
  args=await withGateway(h,async()=>{requests++;return {data:{value:21}};});const run=await h.engine.start(h.bot.id,'Read the assigned API.'),pending=await pendingApproval(h);
  await decide(h,pending,'deny');await h.settled(run);assert.equal(requests,0);
});
test('Engine rejects changed destination after owner approval and never silently retries transport failure',async t=>{
  for(const scenario of ['changed','failure']){
    let args,requests=0,result;const h=await fixture(t,async(request,turn)=>{
      if(turn===1)return {text:'',toolCalls:[call('api','workshop_read_api',args)]};
      result=JSON.parse(request.messages.findLast(x=>x.tool_call_id==='api').content);return {text:'The read failed; no successful result is available.',toolCalls:[]};
    });
    args=await withGateway(h,async()=>{requests++;throw Object.assign(new Error('Synthetic timeout'),{code:'ETIMEDOUT'});});const run=await h.engine.start(h.bot.id,'Read the assigned API.'),pending=await pendingApproval(h);
    if(scenario==='changed')await h.store.mutate(state=>{state.integrations[0].tools[0].path='/different';});
    await decide(h,pending,'once');await h.settled(run);assert.ok(result.error);assert.equal(requests,scenario==='changed'?0:1);assert.equal(h.store.state.runs[h.bot.id].events.some(x=>x.type==='tool.retry'),false);
  }
});
test('Stop while awaiting gateway approval sends no request',async t=>{
  let args,requests=0;const h=await fixture(t,async()=>({text:'',toolCalls:[call('api','workshop_read_api',args)]}));
  args=await withGateway(h,async()=>{requests++;return {data:{value:21}};});const run=await h.engine.start(h.bot.id,'Read the assigned API.');await pendingApproval(h);
  await h.engine.control(h.bot.id,'stop',{runId:run.id,remoteRunId:run.remoteRunId});assert.equal((await h.settled(run)).status,'cancelled');assert.equal(requests,0);
});

test('owner grants two fresh reads once, Engine shares the budget and refuses a third without dispatch',async t=>{
  let args,requests=0;const results=[];
  const h=await fixture(t,async(request,turn)=>{
    if(turn>1)results.push(JSON.parse(request.messages.findLast(x=>x.role==='tool').content));
    if(turn<=3)return {text:'',toolCalls:[call('poll-'+turn,'workshop_poll_api',args)]};
    return {text:'Two approved observations completed. The third was blocked by the request limit.',toolCalls:[]};
  });
  args=await withGateway(h,async()=>({data:{value:++requests},streaming:false}));const run=await h.engine.start(h.bot.id,'Observe twice and confirm the request limit blocks a third attempt.'),pending=await pendingApproval(h);
  assert.ok(pending.pending_controls[0].review.grantOffer);assert.equal(requests,0);
  const input={runId:pending.id,remoteRunId:pending.remoteRunId,request_id:pending.pending_controls[0].prompt_id,execution_generation:pending.execution_generation,choice:'bounded-read',grant:{maxRequests:2,minutes:1,intervalSeconds:0,botIds:[h.bot.id]}};
  const decisions=await Promise.allSettled([h.engine.control(h.bot.id,'approval',input),h.engine.control(h.bot.id,'approval',input)]);
  assert.equal(decisions.filter(x=>x.status==='fulfilled').length,1);
  const done=await h.settled(run);assert.equal(done.status,'completed',done.error);assert.equal(requests,2);assert.deepEqual(results.slice(0,2).map(x=>x.output),[2,4]);assert.match(results[2].error,/exhausted/);
  assert.equal(done.events.filter(x=>x.type==='approval.request').length,1);assert.equal((await h.engine.workshopGrants.list(h.bot.id)).grants[0].used,2);
});
test('bounded-read choice cannot authorize ordinary writes and invalid limits leave the exact prompt usable',async t=>{
  let args;const h=await fixture(t,async(_request,turn)=>turn===1?{text:'',toolCalls:[call('poll','workshop_poll_api',args)]}:{text:'Read once.',toolCalls:[]});
  args=await withGateway(h,async()=>({data:{value:1},streaming:false}));const run=await h.engine.start(h.bot.id,'Read a synthetic value.'),pending=await pendingApproval(h);
  await assert.rejects(h.engine.control(h.bot.id,'approval',{runId:pending.id,remoteRunId:pending.remoteRunId,request_id:pending.pending_controls[0].prompt_id,execution_generation:pending.execution_generation,choice:'bounded-read',grant:{maxRequests:1000,minutes:1,intervalSeconds:0,botIds:[h.bot.id]}}),/1–100/);
  await decide(h,pending,'once');await h.settled(run);assert.equal((await h.engine.workshopGrants.list(h.bot.id)).grants.length,0);
  const strict=await fixture(t,async(_request,turn)=>turn===1?{text:'',toolCalls:[call('build','workshop_build',definition)]}:{text:'Declined.',toolCalls:[]},{strict:true});
  const write=await strict.engine.start(strict.bot.id,'Build a synthetic tool.'),approval=await pendingApproval(strict);
  await assert.rejects(strict.engine.control(strict.bot.id,'approval',{runId:approval.id,remoteRunId:approval.remoteRunId,request_id:approval.pending_controls[0].prompt_id,execution_generation:approval.execution_generation,choice:'bounded-read',grant:{maxRequests:1,minutes:1,intervalSeconds:0,botIds:[strict.bot.id]}}),/does not offer/);
  await decide(strict,approval,'deny');await strict.settled(write);
});
test('denying the ordinary read revokes its matching grant and cannot be bypassed with the polling alias',async t=>{
  let args,requests=0,denied;
  const h=await fixture(t,async(request,turn)=>{
    if(turn===1)return {text:'',toolCalls:[call('poll-1','workshop_poll_api',args)]};
    if(turn===2)return {text:'',toolCalls:[call('single','workshop_read_api',args)]};
    if(turn===3)return {text:'',toolCalls:[call('poll-2','workshop_poll_api',args)]};
    denied=JSON.parse(request.messages.findLast(x=>x.role==='tool').content);return {text:'The request was denied; no further observation was made.',toolCalls:[]};
  });
  args=await withGateway(h,async()=>({data:{value:++requests},streaming:false}));const run=await h.engine.start(h.bot.id,'Exercise a synthetic grant and deny further reading.'),pending=await pendingApproval(h);
  await h.engine.control(h.bot.id,'approval',{runId:pending.id,remoteRunId:pending.remoteRunId,request_id:pending.pending_controls[0].prompt_id,execution_generation:pending.execution_generation,choice:'bounded-read',grant:{maxRequests:3,minutes:1,intervalSeconds:0,botIds:[h.bot.id]}});
  await until(()=>h.store.state.runs[h.bot.id]?.pending_controls?.[0]?.tool==='workshop_read_api');await decide(h,h.store.state.runs[h.bot.id],'deny');await h.settled(run);
  assert.equal(requests,1);assert.match(denied.error,/denied/);assert.equal((await h.engine.workshopGrants.list(h.bot.id)).grants[0].status,'revoked');
});
