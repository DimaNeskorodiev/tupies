// Approve for me ("Allowed"): saved scripts and assigned service calls (GitHub and others, reads and writes) run
// without a card in the owner's own chat; deletion, credentials, billing, forced overwrites, access changes and the
// Engine's own checkpoints keep asking; Balanced and Strict do not change. Fixtures only, plainly fake values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { decideAction, serviceActionGate } from '../lib/command-policy.mjs';
import { automaticReview } from '../lib/action-review.mjs';
import { scriptRunDecision, noteScriptDecision } from '../lib/script-ledger.mjs';

const FAKE_TOKEN='fixture-not-a-real-token';
const github={id:'github',name:'GitHub',type:'rest',baseUrl:'https://api.github.example',authType:'bearer',secret:'sealed-fixture',status:'configured',tools:[
  {name:'list_repositories',method:'GET',path:'/user/repos',inputSchema:{type:'object'}},
  {name:'create_issue',method:'POST',path:'/repos/{owner}/{repo}/issues',inputSchema:{type:'object'}},
  {name:'update_ref',method:'PATCH',path:'/repos/{owner}/{repo}/git/refs/{ref}',inputSchema:{type:'object'}},
  {name:'remove_label',method:'POST',path:'/labels/remove',inputSchema:{type:'object'}},
  {name:'list_members',method:'GET',path:'/orgs/{org}/members',inputSchema:{type:'object'}},
  {name:'add_collaborator',method:'PUT',path:'/repos/{owner}/{repo}/collaborators/{user}',inputSchema:{type:'object'}},
  {name:'items',method:'DELETE',path:'/items',inputSchema:{type:'object'}},
]};
const mcp={id:'todo',name:'Todo MCP',type:'mcp',baseUrl:'https://mcp.todo.example',authType:'none',status:'connected',tools:[
  {name:'add-task',inputSchema:{type:'object'}},{name:'delete-task',inputSchema:{type:'object'}},{name:'deleteObject',inputSchema:{type:'object'}},
  {name:'get-api-token',inputSchema:{type:'object'}},{name:'create_invoice',inputSchema:{type:'object'}},{name:'list-members',inputSchema:{type:'object'}},
]};
const tool=(integration,name)=>integration.tools.find(item=>item.name===name);
const bot=(approvalPolicy,extra={})=>({id:'bot',approvalPolicy,tools:['workspace','terminal','integrations'],integrationIds:['github','todo'],...extra});
const lanes={
  owner:policy=>({bot:bot(policy),source:'chat',sessionId:'bot',runId:'run'}),
  routine:policy=>({bot:bot(policy),source:'routine',sessionId:'bot',runId:'run',routine:{id:'r1'}}),
  teammate:policy=>({bot:bot(policy),source:'delegation',sessionId:'bot',runId:'run',delegation:{depth:1}}),
  telegram:policy=>({bot:bot(policy),source:'telegram',sessionId:'telegram:42',runId:'run'}),
};
const call=(integration,name,args={})=>({id:'c',name:'integration_call',arguments:{integrationId:integration.id,tool:name,arguments:args}});
const decide=(context,integration,name,{current=context.bot,args}={})=>decideAction({context,call:call(integration,name,args),currentBot:current,integration});

test('service gate: deletes in snake, kebab, dotted and camelCase names, HTTP DELETE, credentials, billing, force and access writes',()=>{
  const gate=(integration,name,args)=>serviceActionGate(integration,tool(integration,name)||{name},args)?.gate || null;
  for(const name of ['delete_task','delete-task','deleteTask','delete.task','delete-object','tasks/delete','purgeCache','remove_label','trash-note'])assert.equal(serviceActionGate(mcp,{name})?.gate,'delete',name);
  assert.equal(gate(github,'items'),'delete','REST DELETE asks whatever its name');
  assert.equal(gate(mcp,'get-api-token'),'secrets');assert.equal(serviceActionGate(mcp,{name:'rotateSecret'})?.gate,'secrets');
  assert.equal(gate(mcp,'create_invoice'),'billing');assert.equal(serviceActionGate(mcp,{name:'refund-payment'})?.gate,'billing');
  assert.equal(gate(github,'update_ref',{sha:'abc',force:true}),'force');assert.equal(gate(github,'update_ref',{sha:'abc'}),null);
  assert.equal(gate(github,'add_collaborator'),'access');assert.equal(gate(mcp,'list-members'),'access','an MCP tool has no method, so it counts as a write');
  assert.equal(gate(github,'list_members'),null,'a REST GET of members is an ordinary read');
  for(const name of ['list_repositories','create_issue'])assert.equal(gate(github,name),null,name);
  for(const name of ['add-task','create_pull_request','merge_pull_request','push_files','payload_check','author_list'])assert.equal(serviceActionGate(mcp,{name}),null,name);
  assert.equal(serviceActionGate(github,null).gate,'unknown');
});

test('matrix: assigned service calls by policy and lane; gated classes ask everywhere; Balanced and Strict unchanged',()=>{
  // [GitHub read, GitHub write, MCP write] → true automatic / null existing path (card or reviewer) / false card now.
  const plain=[[github,'list_repositories'],[github,'create_issue'],[mcp,'add-task']];
  const gated=[[github,'items'],[github,'remove_label'],[mcp,'delete-task'],[mcp,'deleteObject'],[mcp,'get-api-token'],[mcp,'create_invoice'],[github,'add_collaborator']];
  for(const [lane,context] of Object.entries(lanes)) {
    for(const [integration,name] of plain) {
      const auto=decide(context('auto'),integration,name);
      if(lane==='owner'){assert.equal(auto.automatic,true,`${lane}/${name}`);assert.match(auto.reason,/^Approve for me: .* runs without asking in your chat \((read|write)\)\.$/);}
      else assert.equal(auto,null,`${lane}/${name} keeps the existing path (the reviewer refuses foreign lanes)`);
      for(const policy of ['balanced','strict'])assert.equal(decide(context(policy),integration,name),null,`${policy}/${lane}/${name}`);
    }
    for(const [integration,name] of gated) {
      const auto=decide(context('auto'),integration,name);
      assert.equal(auto.automatic,false,`${lane}/${name}`);assert.match(auto.reason,/Approve for me still asks/);assert.ok(auto.review.serviceGate);
      for(const policy of ['balanced','strict'])assert.equal(decide(context(policy),integration,name),null,`${policy}/${lane}/${name}`);
    }
  }
  // Force is decided from the exact arguments.
  assert.equal(decide(lanes.owner('auto'),github,'update_ref',{args:{sha:'abc'}}).automatic,true);
  assert.equal(decide(lanes.owner('auto'),github,'update_ref',{args:{sha:'abc',force:true}}).automatic,false);
  // An owner-marked GET keeps running in every lane under Balanced, and never under Strict.
  const marked={...github,tools:[{...tool(github,'list_repositories'),approval:'auto'}]};
  assert.equal(decide(lanes.routine('balanced'),marked,'list_repositories').automatic,true);
  assert.equal(decide(lanes.routine('strict'),marked,'list_repositories'),null);
});

test('assignment and policy are read from both the task snapshot and the saved bot',()=>{
  const owner=lanes.owner('auto');
  assert.equal(decide(owner,github,'create_issue',{current:bot('auto',{integrationIds:['todo']})}),null,'unassigned on the saved bot');
  assert.equal(decide(owner,github,'create_issue',{current:bot('auto',{tools:['workspace']})}),null,'Integrations turned off on the saved bot');
  assert.equal(decide(owner,github,'create_issue',{current:bot('balanced')}),null,'switched to Balanced mid-task: the next action asks');
  assert.equal(decide(owner,github,'create_issue',{current:bot('strict')}),null);
  assert.equal(decide(lanes.owner('balanced'),github,'create_issue',{current:bot('auto')}),null,'switching to Approve for me never widens a running task');
  assert.equal(decide(owner,github,'create_issue',{current:null}),null);
  assert.equal(decide(owner,github,'no_such_action'),null);
});

test('saved scripts: Approve for me in the owner chat runs any non-dangerous version, on the host too, without approving it',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-allowed-scripts-')),store=await new Store(directory).init();t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const saved={id:'bot',tools:['workspace','terminal'],approvalPolicy:'auto'};
  const run=({name='script_run',policy='auto',ownerLane=true,danger='normal',current=saved,state='new'}={})=>{
    const c={name};noteScriptDecision(c,{id:'fixture',title:'Fixture',digest:(state==='new'?'a':'b').repeat(64),danger:{risk:danger,reasons:danger==='dangerous'?['main.mjs: starts other commands']:[]},readiness:{backend:'host',isolated:false,ready:true}});
    return scriptRunDecision({store,context:{bot:saved,source:'chat',sessionId:'bot'},call:c,currentBot:current,policy,ownerLane});
  };
  const allowed=run();assert.equal(allowed.automatic,true);assert.match(allowed.reason,/^Approve for me: “Fixture” \(new script\) runs without asking in your chat\. It runs on this computer without isolation\.$/);
  assert.equal(run({name:'scripts_run'}).automatic,true,'the legacy tool follows the same rule');
  assert.equal(run({danger:'dangerous'}).automatic,false);assert.match(run({danger:'dangerous'}).reason,/^Dangerous/);
  assert.equal(run({current:{...saved,tools:['workspace']}}).automatic,false,'Terminal turned off');
  assert.equal(run({ownerLane:false}).automatic,false,'routines, teammates and other chats keep asking on the host');
  assert.equal(run({name:'scripts_run',ownerLane:false}),null,'legacy tool outside the owner chat keeps its old path');
  assert.equal(run({policy:'balanced'}).automatic,false);assert.equal(run({policy:'strict'}).automatic,false);
});

test('Engine checkpoints and owner-only changes still ask under Approve for me',()=>{
  const auto={approvalPolicy:'auto'};
  for(const name of ['site_access_review','task_budget','task_checkpoint','integration_propose']){const result=automaticReview(auto,auto,name,{});assert.equal(result.automatic,false,name);assert.ok(!result.reviewable,name);}
  for(const args of [{addTools:['terminal']},{removeTools:['browser']},{enabled:false},{approvalPolicy:'auto'}]){const result=automaticReview(auto,auto,'bots_update',args);assert.equal(result.automatic,false);assert.ok(!result.reviewable,JSON.stringify(args));}
  for(const name of ['workspace_delete','routines_delete','skills_install','coding_publish']){const result=automaticReview(auto,auto,name,{});assert.equal(result.automatic,false,name);assert.ok(!result.reviewable,name);}
});

/** A disposable engine whose provider issues `calls` in order, then finishes. */
async function fixture(t,{policy='auto',calls,beforeCall}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-allowed-mode-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections=[{id:'fixture',type:'custom',defaultModel:'fixture-model'}];Object.assign(state.bots[0],{connectionId:'fixture',approvalPolicy:policy,tools:['workspace','integrations'],integrationIds:['github','todo']});state.integrations=[structuredClone(github),structuredClone(mcp)];});
  const queue=[...calls],reviews=[],sent=[];let step=0;
  const engine=new NativeEngine(store,{runTimeout:15000,providers:{complete:async()=>{const next=queue.shift();if(next){await beforeCall?.(step++,store);return {toolCalls:[next]};}return {text:'Done.',toolCalls:[]};},reviewAction:async(_c,request)=>{reviews.push(request);throw new Error('No model reviewer in this fixture.');}}});
  engine.tools.options.integrations={call:async(integrationId,name,args,options)=>{assert.equal(options.approved,true);sent.push([integrationId,name]);if(args.fail)throw new Error('Fixture service refused the request.');return {ok:true,token:FAKE_TOKEN.length};}};
  await engine.recover();t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const b=store.state.bots[0],run=()=>store.state.runs[b.id],events=type=>(run()?.events || []).filter(row=>row.type===type);
  const until=async predicate=>{for(let i=0;i<2000;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Fixture timed out.');};
  const stop=async()=>{await engine.control(b.id,'stop',{runId:run().id,remoteRunId:run().remoteRunId});};
  return {store,engine,bot:b,run,events,until,stop,reviews,sent,start:()=>engine.start(b.id,'Open an issue for the failing build and tidy my tasks.')};
}
const engineCall=(id,integrationId,name,args={})=>({id,name:'integration_call',arguments:{integrationId,tool:name,arguments:args}});

test('engine: GitHub read and write and an MCP write run without a card, each with an audit trail of result and error',async t=>{
  const h=await fixture(t,{calls:[engineCall('read','github','list_repositories'),engineCall('write','github','create_issue',{title:'Build fails'}),engineCall('mcp','todo','add-task',{fail:true})]});
  const started=await h.start();await h.engine.tasks.get(started.id);
  assert.equal(h.run().status,'completed',h.run().error);
  assert.equal(h.events('approval.request').length,0);assert.equal(h.reviews.length,0,'no model review either');
  assert.deepEqual(h.sent,[['github','list_repositories'],['github','create_issue'],['todo','add-task']]);
  const automatic=h.events('approval.automatic');
  assert.deepEqual(automatic.map(row=>row.toolCallId),['read','write','mcp']);
  assert.match(automatic[0].reason,/GitHub · list_repositories runs without asking in your chat \(read\)/);assert.match(automatic[1].reason,/GitHub · create_issue .*\(write\)/);
  assert.deepEqual(h.events('tool.started').filter(row=>row.tool==='integration_call').map(row=>row.arguments.tool),['list_repositories','create_issue','add-task'],'exact arguments are recorded');
  const completed=h.events('tool.completed').filter(row=>row.tool==='integration_call');
  assert.deepEqual(completed.map(row=>[row.toolCallId,Boolean(row.error)]),[['read',false],['write',false],['mcp',true]]);
  assert.match(completed[2].preview,/Fixture service refused the request/);
});

test('engine: a kebab-case MCP delete still waits for the owner under Approve for me; Balanced still asks for a write',async t=>{
  await t.test('delete-task',async t=>{
    const h=await fixture(t,{calls:[engineCall('del','todo','delete-task',{id:'1'})]});
    const started=await h.start();await h.until(()=>h.run()?.status==='waiting_for_approval');
    assert.match(h.run().pending_controls[0].review.riskReason,/delete or remove data\. Approve for me still asks/);assert.equal(h.reviews.length,0);
    await h.stop();await h.engine.tasks.get(started.id);assert.deepEqual(h.sent,[]);
  });
  await t.test('balanced',async t=>{
    const h=await fixture(t,{policy:'balanced',calls:[engineCall('write','github','create_issue',{title:'x'})]});
    const started=await h.start();await h.until(()=>h.run()?.status==='waiting_for_approval');
    assert.equal(h.events('approval.automatic').length,0);await h.stop();await h.engine.tasks.get(started.id);assert.deepEqual(h.sent,[]);
  });
});

test('engine: switching the saved bot to Balanced mid-task makes the next service write ask',async t=>{
  const h=await fixture(t,{calls:[engineCall('first','github','create_issue',{title:'one'}),engineCall('second','github','create_issue',{title:'two'})],
    beforeCall:async(step,store)=>{if(step===1)await store.mutate(state=>{state.bots[0].approvalPolicy='balanced';});}});
  const started=await h.start();await h.until(()=>h.run()?.status==='waiting_for_approval');
  assert.deepEqual(h.sent,[['github','create_issue']],'the first write ran before the switch');
  assert.equal(h.run().pending_controls[0].arguments.arguments.title,'two');
  await h.stop();await h.engine.tasks.get(started.id);assert.equal(h.sent.length,1);
});
