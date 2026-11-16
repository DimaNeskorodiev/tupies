// Approve for me ("Allowed"): in lanes the owner started (own chat, own Telegram DM, routines, rooms, owner-rooted
// teammate work), saved scripts, assigned service calls (GitHub and others, reads and writes) and ordinary GitHub
// writes from the terminal (non-force git push, gh pr/issue writes) run without a card. Deletion, credentials,
// billing, forced overwrites, sending messages to people, access changes and the Engine's own checkpoints keep
// asking in every lane; Balanced and Strict do not change. Fixtures only, plainly fake values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { decideAction, serviceActionGate, trustedLane, integrationApprovalHints } from '../lib/command-policy.mjs';
import { classifyCommand } from '../lib/command-classifier.mjs';
import { automaticReview } from '../lib/action-review.mjs';
import { scriptRunDecision, noteScriptDecision } from '../lib/script-ledger.mjs';

const FAKE_TOKEN='fixture-not-a-real-token';
const github={id:'github',name:'GitHub',type:'rest',baseUrl:'https://api.github.example',authType:'bearer',secret:'sealed-fixture',status:'configured',tools:[
  {name:'list_repositories',method:'GET',path:'/user/repos',inputSchema:{type:'object'}},
  {name:'create_issue',method:'POST',path:'/repos/{owner}/{repo}/issues',inputSchema:{type:'object'}},
  {name:'add_issue_comment',method:'POST',path:'/repos/{owner}/{repo}/issues/{number}/comments',inputSchema:{type:'object'}},
  {name:'update_ref',method:'PATCH',path:'/repos/{owner}/{repo}/git/refs/{ref}',inputSchema:{type:'object'}},
  {name:'remove_label',method:'POST',path:'/labels/remove',inputSchema:{type:'object'}},
  {name:'list_members',method:'GET',path:'/orgs/{org}/members',inputSchema:{type:'object'}},
  {name:'add_collaborator',method:'PUT',path:'/repos/{owner}/{repo}/collaborators/{user}',inputSchema:{type:'object'}},
  {name:'items',method:'DELETE',path:'/items',inputSchema:{type:'object'}},
]};
const mcp={id:'todo',name:'Todo MCP',type:'mcp',baseUrl:'https://mcp.todo.example',authType:'none',status:'connected',tools:[
  {name:'add-task',inputSchema:{type:'object'}},{name:'delete-task',inputSchema:{type:'object'}},{name:'deleteObject',inputSchema:{type:'object'}},
  {name:'get-api-token',inputSchema:{type:'object'}},{name:'create_invoice',inputSchema:{type:'object'}},{name:'list-members',inputSchema:{type:'object'}},
  {name:'send_email',inputSchema:{type:'object'}},{name:'slack_post_message',inputSchema:{type:'object'}},
]};
const gmail={id:'gmail',name:'Gmail',type:'rest',baseUrl:'https://gmail.example',authType:'none',status:'configured',tools:[
  {name:'search_messages',method:'GET',path:'/messages',inputSchema:{type:'object'}},{name:'send_message',method:'POST',path:'/messages/send',inputSchema:{type:'object'}},
  {name:'modify_labels',method:'POST',path:'/messages/{id}/modify',inputSchema:{type:'object'}},
]};
const tool=(integration,name)=>integration.tools.find(item=>item.name===name);
const bot=(approvalPolicy,extra={})=>({id:'bot',approvalPolicy,tools:['workspace','terminal','integrations'],integrationIds:['github','todo','gmail'],...extra});
const base=(policy,extra)=>({bot:bot(policy),runId:'run',...extra});
const trusted={
  owner:policy=>base(policy,{source:'chat',sessionId:'bot'}),
  ownerTelegram:policy=>base(policy,{source:'telegram',sessionId:'bot',lane:'chat'}),
  routine:policy=>base(policy,{source:'routine',sessionId:'bot',routine:{id:'r1'}}),
  room:policy=>base(policy,{source:'room',sessionId:'bot--room-1',roomId:'room1'}),
  ownerTeammate:policy=>base(policy,{source:'delegation',sessionId:'bot',delegation:{depth:1,rootTrusted:true}}),
};
const untrusted={
  otherTelegram:policy=>base(policy,{source:'telegram',sessionId:'bot--telegram-3fe0b335391b0a1a'}),
  teammateFromOtherTelegram:policy=>base(policy,{source:'delegation',sessionId:'bot',delegation:{depth:1,rootTrusted:false}}),
  untracedTeammate:policy=>base(policy,{source:'delegation',sessionId:'bot',delegation:{depth:1}}),
  otherSession:policy=>base(policy,{source:'chat',sessionId:'someone-else'}),
  backgroundReview:policy=>base(policy,{source:'chat',sessionId:'bot',fromBotId:'other'}),
};
const lanes={...trusted,...untrusted};
const call=(integration,name,args={})=>({id:'c',name:'integration_call',arguments:{integrationId:integration.id,tool:name,arguments:args}});
const decide=(context,integration,name,{current=context.bot,args}={})=>decideAction({context,call:call(integration,name,args),currentBot:current,integration});
const root='/srv/ws/bot';
const command=(context,text,current=context.bot)=>decideAction({context,call:{id:'t',name:'terminal',arguments:{command:text}},currentBot:current,session:{root,cwd:root}});

test('trusted lanes: the owner, the owner’s Telegram DM, routines, rooms and owner-rooted teammates; nothing else',()=>{
  for(const [lane,context] of Object.entries(trusted))assert.equal(trustedLane(context('auto')),true,lane);
  for(const [lane,context] of Object.entries(untrusted))assert.equal(trustedLane(context('auto')),false,lane);
  assert.equal(trustedLane(null),false);assert.equal(trustedLane({source:'chat',sessionId:'bot'}),false,'no bot snapshot');
  assert.equal(trustedLane(base('auto',{source:'mission',sessionId:'bot'})),false,'unknown sources keep their cards');
});

test('service gate: deletes in every naming style, credentials, billing, force, sends to people and access writes',()=>{
  const gate=(integration,name,args)=>serviceActionGate(integration,tool(integration,name)||{name},args)?.gate || null;
  for(const name of ['delete_task','delete-task','deleteTask','delete.task','delete-object','tasks/delete','purgeCache','remove_label','trash-note'])assert.equal(serviceActionGate(mcp,{name})?.gate,'delete',name);
  assert.equal(gate(github,'items'),'delete','REST DELETE asks whatever its name');
  assert.equal(gate(mcp,'get-api-token'),'secrets');assert.equal(serviceActionGate(mcp,{name:'rotateSecret'})?.gate,'secrets');
  assert.equal(gate(mcp,'create_invoice'),'billing');assert.equal(serviceActionGate(mcp,{name:'refund-payment'})?.gate,'billing');
  assert.equal(gate(github,'update_ref',{sha:'abc',force:true}),'force');assert.equal(gate(github,'update_ref',{sha:'abc'}),null);
  for(const name of ['send_email','slack_post_message','reply-to-thread','forwardMail','sendSms','post_chat'])assert.equal(serviceActionGate(mcp,{name})?.gate,'send',name);
  assert.equal(gate(gmail,'send_message'),'send');
  assert.equal(gate(gmail,'search_messages'),null,'a REST GET of messages only reads');
  assert.equal(gate(gmail,'modify_labels'),null,'sending is judged by the action name, not a /messages path');
  for(const name of ['create_issue','add_issue_comment'])assert.equal(gate(github,name),null,`${name}: GitHub issues and comments are not sends`);
  for(const name of ['comment_issue','create_pull_request_review','add-task','create_pull_request','merge_pull_request','push_files','payload_check','author_list'])assert.equal(serviceActionGate(mcp,{name}),null,name);
  assert.equal(gate(github,'add_collaborator'),'access');assert.equal(gate(mcp,'list-members'),'access','an MCP tool has no method, so it counts as a write');
  assert.equal(gate(github,'list_members'),null,'a REST GET of members is an ordinary read');
  assert.equal(gate(github,'list_repositories'),null);
  assert.equal(serviceActionGate(github,null).gate,'unknown');
});

test('matrix: assigned service calls by policy and lane; gated classes ask in every lane; Balanced and Strict unchanged',()=>{
  const plain=[[github,'list_repositories'],[github,'create_issue'],[github,'add_issue_comment'],[mcp,'add-task'],[gmail,'modify_labels']];
  const gated=[[github,'items'],[github,'remove_label'],[mcp,'delete-task'],[mcp,'deleteObject'],[mcp,'get-api-token'],[mcp,'create_invoice'],[github,'add_collaborator'],[mcp,'send_email'],[gmail,'send_message']];
  for(const [lane,context] of Object.entries(lanes)) {
    const isTrusted=Object.hasOwn(trusted,lane);
    for(const [integration,name] of plain) {
      const auto=decide(context('auto'),integration,name);
      if(isTrusted){assert.equal(auto.automatic,true,`${lane}/${name}`);assert.match(auto.reason,/^Approve for me: .* runs without asking \((read|write)\)\.$/);}
      else assert.equal(auto,null,`${lane}/${name} keeps the existing path (a card)`);
      for(const policy of ['balanced','strict'])assert.equal(decide(context(policy),integration,name),null,`${policy}/${lane}/${name}`);
    }
    for(const [integration,name] of gated) {
      const auto=decide(context('auto'),integration,name);
      assert.equal(auto.automatic,false,`${lane}/${name}`);assert.match(auto.reason,/Approve for me still asks/);assert.ok(auto.review.serviceGate);
      for(const policy of ['balanced','strict'])assert.equal(decide(context(policy),integration,name),null,`${policy}/${lane}/${name}`);
    }
  }
  assert.equal(decide(trusted.owner('auto'),github,'update_ref',{args:{sha:'abc'}}).automatic,true);
  assert.equal(decide(trusted.routine('auto'),github,'update_ref',{args:{sha:'abc',force:true}}).automatic,false);
  // An owner-marked GET keeps running in every lane under Balanced, and never under Strict.
  const marked={...github,tools:[{...tool(github,'list_repositories'),approval:'auto'}]};
  assert.equal(decide(untrusted.otherTelegram('balanced'),marked,'list_repositories').automatic,true);
  assert.equal(decide(trusted.routine('strict'),marked,'list_repositories'),null);
});

test('assignment and policy are read from both the task snapshot and the saved bot',()=>{
  const owner=trusted.owner('auto');
  assert.equal(decide(owner,github,'create_issue',{current:bot('auto',{integrationIds:['todo']})}),null,'unassigned on the saved bot');
  assert.equal(decide(owner,github,'create_issue',{current:bot('auto',{tools:['workspace']})}),null,'Integrations turned off on the saved bot');
  assert.equal(decide(owner,github,'create_issue',{current:bot('balanced')}),null,'switched to Balanced mid-task: the next action asks');
  assert.equal(decide(owner,github,'create_issue',{current:bot('strict')}),null);
  assert.equal(decide(trusted.owner('balanced'),github,'create_issue',{current:bot('auto')}),null,'switching to Approve for me never widens a running task');
  assert.equal(decide(owner,github,'create_issue',{current:null}),null);
  assert.equal(decide(owner,github,'no_such_action'),null);
  assert.equal(command(owner,'git push origin main',bot('balanced')).automatic,false,'a GitHub push follows the same rule');
});

test('classifier: ordinary GitHub writes are marked; force, deletion, other repos, wrappers and chains are not',()=>{
  const at=text=>classifyCommand(text,{workspaceRoot:root,cwd:root});
  for(const text of ['git push','git push origin main','git push -u origin feature/x','git push origin HEAD:refs/heads/x','git push --tags','git push --follow-tags origin main','git push -o ci.skip origin main','git push -- origin main',
    'gh pr create --title Fix --body "Ready for review"','gh pr edit 3 --title Better','gh pr comment 3 --body Thanks','gh pr merge 3 --squash','gh issue create --title Bug --body Steps','gh issue edit 4 --add-label bug','gh issue comment 4 --body-file notes.md','gh issue close 4','gh issue reopen 4','git push origin main && gh pr create --fill']) {
    const result=at(text);assert.equal(result.risk,'dangerous',text);assert.equal(result.githubWrite,true,text);
  }
  for(const text of ['git push origin +main','git push -f','git push --force','git push -fu origin x','git push --force-with-lease','git push --force-if-includes','git push origin :branch','git push origin x:','git push --delete origin x','git push -d origin x','git push --mirror','git push --prune','git push --receive-pack=other','git push $REMOTE main',
    'git push origin main && rm -rf build','rm -rf build; git push','git -C /tmp/other push','git -c core.sshCommand=x push','GIT_SSH_COMMAND=x git push','timeout 60 git push',
    'gh pr merge 3 --admin','gh pr merge 3 --delete-branch','gh pr merge 3 -sd','gh pr close 3','gh issue delete 4','gh issue transfer 4 other/repo','gh issue comment 4 --delete-last','gh issue comment 4 --body-file /etc/hosts','gh issue comment 4 --body-file=~/notes.md','gh issue create --title "$TITLE"',
    'gh repo delete owner/repo','gh repo edit --visibility public','gh repo archive','gh release create v1','gh api -X POST /repos/o/r/issues','gh api repos/o/r/issues -f title=x','npm publish','git send-email x.patch']) {
    const result=at(text);assert.equal(result.risk,'dangerous',text);assert.equal(result.githubWrite,undefined,text);
  }
  assert.match(at('git push origin main && rm -rf build').reasons[0],/^rm/,'the card leads with the hard hazard');
  assert.match(at('git push --force').reasons[0],/^git push uses --force: it can overwrite or delete remote history/);
});

test('GitHub terminal writes run under Approve for me in trusted lanes only; force and deletes always ask',()=>{
  const allowed=['git push origin main','gh pr create --fill','gh issue comment 4 --body Done'];
  const gated=['git push --force-with-lease','git push origin +main','git push origin :old','git push --delete origin old','git push origin main && rm -rf build','gh repo delete o/r','gh release create v1','npm publish'];
  for(const [lane,context] of Object.entries(lanes)) {
    for(const text of allowed) {
      const decision=command(context('auto'),text);
      assert.equal(decision.automatic,Object.hasOwn(trusted,lane),`${lane}: ${text}: ${decision.reason}`);
      if(decision.automatic)assert.match(decision.reason,/^Approve for me: (git push sends commits|gh (pr|issue) \w+ writes to GitHub)/);
      for(const policy of ['balanced','strict'])assert.equal(command(context(policy),text).automatic,false,`${policy}/${lane}: ${text}`);
    }
    for(const text of gated)for(const policy of ['auto','balanced','strict']){const decision=command(context(policy),text);assert.equal(decision.automatic,false,`${policy}/${lane}: ${text}`);assert.match(decision.reason,/^Dangerous/);}
  }
  assert.equal(command(trusted.owner('auto'),'git push',{...bot('auto'),tools:['workspace']}).automatic,false,'Terminal turned off on the saved bot');
});

test('saved scripts: Approve for me runs any non-dangerous version in trusted lanes, on the host too, without approving it',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-allowed-scripts-')),store=await new Store(directory).init();t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const saved={id:'bot',tools:['workspace','terminal'],approvalPolicy:'auto'};
  const run=({name='script_run',policy='auto',trusted=true,danger='normal',current=saved}={})=>{
    const c={name};noteScriptDecision(c,{id:'fixture',title:'Fixture',digest:'a'.repeat(64),danger:{risk:danger,reasons:danger==='dangerous'?['main.mjs: starts other commands']:[]},readiness:{backend:'host',isolated:false,ready:true}});
    return scriptRunDecision({store,context:{bot:saved,source:'chat',sessionId:'bot'},call:c,currentBot:current,policy,trusted});
  };
  const allowed=run();assert.equal(allowed.automatic,true);assert.match(allowed.reason,/^Approve for me: “Fixture” \(new script\) runs without asking\. It runs on this computer without isolation\.$/);
  assert.equal(run({name:'scripts_run'}).automatic,true,'the legacy tool follows the same rule');
  assert.equal(run({danger:'dangerous'}).automatic,false);assert.match(run({danger:'dangerous'}).reason,/^Dangerous/);
  assert.equal(run({current:{...saved,tools:['workspace']}}).automatic,false,'Terminal turned off');
  assert.equal(run({trusted:false}).automatic,false,'another person’s chat keeps asking on the host');
  assert.equal(run({name:'scripts_run',trusted:false}),null,'the legacy tool in an untrusted lane keeps its old path');
  assert.equal(run({policy:'balanced'}).automatic,false);assert.equal(run({policy:'strict'}).automatic,false);
});

test('Engine checkpoints and owner-only changes still ask under Approve for me',()=>{
  const auto={approvalPolicy:'auto'};
  for(const name of ['site_access_review','task_budget','task_checkpoint','integration_propose']){const result=automaticReview(auto,auto,name,{});assert.equal(result.automatic,false,name);assert.ok(!result.reviewable,name);}
  for(const args of [{addTools:['terminal']},{removeTools:['browser']},{enabled:false},{approvalPolicy:'auto'}]){const result=automaticReview(auto,auto,'bots_update',args);assert.equal(result.automatic,false);assert.ok(!result.reviewable,JSON.stringify(args));}
  for(const name of ['workspace_delete','routines_delete','skills_install','coding_publish']){const result=automaticReview(auto,auto,name,{});assert.equal(result.automatic,false,name);assert.ok(!result.reviewable,name);}
});

test('integration_list hints report the effective approval for this policy and lane, with the gate reason',()=>{
  const listing=[...github.tools,...mcp.tools].map(item=>({integrationId:github.tools.includes(item)?'github':'todo',integrationName:'x',name:item.name,requiresApproval:true}));
  listing.push({integrationId:'gmail',integrationName:'Gmail',ready:false,status:'needs_credentials',actions:['send_message']});
  const hints=(context,current=context.bot)=>Object.fromEntries(integrationApprovalHints(listing,{context,currentBot:current,integrations:[github,mcp,gmail]}).filter(item=>item.name).map(item=>[item.name,item]));
  let shown=hints(trusted.owner('auto'));
  for(const name of ['list_repositories','create_issue','add_issue_comment','update_ref','list_members','add-task'])assert.equal(shown[name].requiresApproval,false,name);
  for(const name of ['delete-task','deleteObject','items','get-api-token','create_invoice','send_email','add_collaborator']){assert.equal(shown[name].requiresApproval,true,name);assert.match(shown[name].approvalReason,/Approve for me still asks/,name);}
  for(const context of [trusted.owner('balanced'),untrusted.otherTelegram('auto')]){shown=hints(context);assert.ok(Object.values(shown).every(item=>item.requiresApproval===true));}
  shown=hints(trusted.owner('auto'),bot('balanced'));assert.equal(shown.create_issue.requiresApproval,true,'the saved bot moved to Balanced');
  assert.deepEqual(integrationApprovalHints(listing,{context:trusted.owner('auto'),currentBot:bot('auto'),integrations:[github,mcp,gmail]}).at(-1),listing.at(-1),'a not-ready row is unchanged');
});

/** A disposable engine whose provider issues `calls` in order, then finishes. */
async function fixture(t,{policy='auto',calls,beforeCall,bots}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-allowed-mode-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.connections=[{id:'fixture',type:'custom',defaultModel:'fixture-model'}];Object.assign(state.bots[0],{connectionId:'fixture',approvalPolicy:policy,tools:['workspace','integrations'],integrationIds:['github','todo']});if(bots)bots(state);state.integrations=[structuredClone(github),structuredClone(mcp)];});
  const queue=[...calls],reviews=[],sent=[],lists=[];let step=0;
  const engine=new NativeEngine(store,{runTimeout:15000,providers:{complete:async()=>{const next=queue.shift();if(next){await beforeCall?.(step++,store);return {toolCalls:[next]};}return {text:'Done.',toolCalls:[]};},reviewAction:async(_c,request)=>{reviews.push(request);throw new Error('No model reviewer in this fixture.');}}});
  engine.tools.options.integrations={call:async(integrationId,name,args,options)=>{assert.equal(options.approved,true);sent.push([integrationId,name]);if(args.fail)throw new Error('Fixture service refused the request.');return {ok:true,token:FAKE_TOKEN.length};},
    listTools:bot=>{lists.push(bot.id);return [{integrationId:'github',integrationName:'GitHub',name:'create_issue',requiresApproval:true},{integrationId:'todo',integrationName:'Todo MCP',name:'delete-task',requiresApproval:true}];}};
  await engine.recover();t.after(async()=>{await engine.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const b=store.state.bots[0],run=(id=b.id)=>store.state.runs[id],events=(type,id=b.id)=>(run(id)?.events || []).filter(row=>row.type===type);
  const until=async predicate=>{for(let i=0;i<2000;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Fixture timed out.');};
  const stop=async()=>{await engine.control(b.id,'stop',{runId:run().id,remoteRunId:run().remoteRunId});};
  const result=callId=>{const row=Object.values(store.state.conversations).flat().find(item=>item.role==='tool' && item.tool_call_id===callId);return row?JSON.parse(row.content):null;};
  return {store,engine,bot:b,run,events,until,stop,reviews,sent,result,start:()=>engine.start(b.id,'Open an issue for the failing build and tidy my tasks.')};
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
  assert.match(automatic[0].reason,/GitHub · list_repositories runs without asking \(read\)/);assert.match(automatic[1].reason,/GitHub · create_issue runs without asking \(write\)/);
  assert.deepEqual(h.events('tool.started').filter(row=>row.tool==='integration_call').map(row=>row.arguments.tool),['list_repositories','create_issue','add-task'],'exact arguments are recorded');
  const completed=h.events('tool.completed').filter(row=>row.tool==='integration_call');
  assert.deepEqual(completed.map(row=>[row.toolCallId,Boolean(row.error)]),[['read',false],['write',false],['mcp',true]]);
  assert.match(completed[2].preview,/Fixture service refused the request/);
});

test('engine: integration_list tells the model which actions run without a card',async t=>{
  const h=await fixture(t,{calls:[{id:'list',name:'integration_list',arguments:{}}]});
  const started=await h.start();await h.engine.tasks.get(started.id);
  const listed=h.result('list');
  assert.deepEqual(listed.map(item=>[item.name,item.requiresApproval]),[['create_issue',false],['delete-task',true]]);
  assert.match(listed[1].approvalReason,/delete or remove data/);
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

test('engine: a teammate working for the owner’s chat request runs its assigned GitHub write without a card',async t=>{
  const h=await fixture(t,{calls:[{id:'ask',name:'delegate_task',arguments:{botId:'worker',task:'Open the issue for the failing build.'}},engineCall('worker-write','github','create_issue',{title:'Build fails'})],
    bots:state=>{state.bots[0].tools=['workspace','integrations','delegation'];state.bots.push({id:'worker',name:'Worker',title:'Fixture teammate',connectionId:'fixture',tools:['workspace','integrations'],integrationIds:['github'],approvalPolicy:'auto',enabled:true,skills:[]});}});
  const started=await h.start();await h.engine.tasks.get(started.id);
  assert.equal(h.run().status,'completed',h.run().error);
  assert.deepEqual(h.sent,[['github','create_issue']]);
  const worker=h.run('worker');assert.equal(worker.delegation.rootTrusted,true);
  assert.equal(h.events('approval.request','worker').length,0);
  assert.match(h.events('approval.automatic','worker')[0].reason,/GitHub · create_issue runs without asking \(write\)/);
});
