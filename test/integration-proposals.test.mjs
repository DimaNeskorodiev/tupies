import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { automaticReview } from '../lib/action-review.mjs';
import { setupApprovalSummary } from '../lib/setup-tools.mjs';
import { integrationReady } from '../lib/integration-readiness.mjs';
import { integrationPrecheck, proposalApprovalSummary, connectionRequests, MAX_PROPOSED_PER_BOT, PROPOSAL_TOOL_DEFINITION } from '../lib/integration-proposals.mjs';
import { catalogGroups, groupGuidance, loadGroupOf } from '../lib/tool-catalog.mjs';

const read={name:'list_messages',description:'List recent messages.',method:'GET',path:'/v1/messages',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:50}},additionalProperties:false}};
const write={name:'send_message',description:'Send a message.',method:'POST',path:'/v1/messages/send',inputSchema:{type:'object',properties:{to:{type:'string'},text:{type:'string'}},required:['to','text'],additionalProperties:false}};
const proposal=(overrides={})=>Object.fromEntries(Object.entries({name:'Fixture Mail',baseUrl:'https://mail.example.com/api',authType:'bearer',tools:[read,write],setupNotes:'Open Fixture Mail settings, create an API key with read and send access.',reason:'The owner asked me to check their mail.',...overrides}).filter(([,value])=>value!==undefined));
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-integration-proposals-')),store=await new Store(directory).init();
  await store.mutate(state=>{state.integrations=[];for(const bot of state.bots)bot.approvalPolicy='auto';});
  const integrations=new Integrations(store,{requestTimeout:1000}),tools=new AgentTools(store,{integrations});
  t.after(async()=>{await integrations.close();await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot=()=>structuredClone(store.state.bots.find(item=>item.id==='bot_atlas'));
  return {store,integrations,tools,bot,propose:(args,snapshot=bot(),runId='run_fixture')=>tools.execute(snapshot,'integration_propose',args,{approved:true,runId}).then(result=>({result,snapshot}))};
}
const ownerChat=bot=>({source:'chat',sessionId:bot.id,bot});

test('integration_propose is a loadable integrations tool that always needs the owner’s exact approval',async t=>{
  const f=await fixture(t),bot=f.bot();
  assert.ok(f.tools.definitions(bot).some(item=>item.name==='integration_propose'));
  assert.equal(loadGroupOf('integration_propose'),'integrations');
  const {core}=catalogGroups(f.tools.definitions(bot));assert.ok(!core.some(item=>item.name==='integration_propose'),'the offered core tool list does not change');
  assert.ok(PROPOSAL_TOOL_DEFINITION.description.length<=200);
  for(const policy of ['auto','balanced','strict'])assert.equal(f.tools.requiresApproval('integration_propose',{...bot,approvalPolicy:policy},proposal()),true);
  const review=automaticReview({approvalPolicy:'auto'},{approvalPolicy:'auto'},'integration_propose',proposal());
  assert.equal(review.automatic,false);assert.equal(review.reviewable,undefined,'the model risk reviewer never answers it');
  await assert.rejects(f.tools.execute(bot,'integration_propose',proposal(),{runId:'run_fixture'}),/requires approval/);
  assert.equal(f.store.state.integrations.length,0);
  assert.match(groupGuidance('integrations',new Set(['integration_list','integration_call','integration_propose'])),/do not just say you cannot.*integration_propose/);
  assert.doesNotMatch(groupGuidance('integrations',new Set(['integration_list','integration_call'])),/integration_propose/);
  await assert.rejects(f.tools.execute({...bot,tools:['workspace']},'integration_propose',proposal(),{approved:true}),/not enabled/);
});

test('credentials and automatic approval can never be proposed by the model',async t=>{
  const f=await fixture(t),context=ownerChat(f.bot());
  for(const args of [proposal({apiKey:'sk-fixture'}),proposal({token:'x'}),proposal({password:'x'}),proposal({secret:'x'}),proposal({authType:'oauth2',oauth:{authorizationUrl:'https://a.example.com/auth',tokenUrl:'https://a.example.com/token',scopes:[],clientSecret:'x'}}),proposal({oauth:{oauthClientSecret:'x'}}),proposal({headers:{Authorization:'Bearer sk-fixture'}}),proposal({headers:{'X-Api-Key':'sk'}})]) {
    const refused=integrationPrecheck(f.store.state,context,{name:'integration_propose',arguments:args});
    assert.equal(refused?.errorCode,'credential_not_allowed',JSON.stringify(args));assert.match(refused.error,/Only the owner enters credentials/);
  }
  assert.equal(integrationPrecheck(f.store.state,context,{name:'integration_propose',arguments:proposal({headers:{'Notion-Version':'2022-06-28'}})}),null);
  await assert.rejects(f.propose(proposal({headers:{'X-Auth-Token':'x'}})),/only the owner enters credentials/);
  await assert.rejects(f.propose(proposal({tools:[{...read,approval:'auto'}]})),/Only the owner can let an action run without asking/);
  await assert.rejects(f.propose(proposal({oauth:{authorizationUrl:'https://a.example.com',tokenUrl:'https://a.example.com',scopes:[]}})),/oauth applies only to authType oauth2/);
  await assert.rejects(f.propose(proposal({setupNotes:undefined})),/Write setupNotes/);
  await assert.rejects(f.propose({reason:'x',name:'No URL',authType:'none',tools:[read]}),/baseUrl/);
  assert.equal(f.store.state.integrations.length,0);
});

test('only the owner’s direct chat can propose; routines, teammates and rooms cannot',async t=>{
  const f=await fixture(t),bot=f.bot(),call={name:'integration_propose',arguments:proposal()};
  assert.equal(integrationPrecheck(f.store.state,ownerChat(bot),call),null);
  for(const context of [{source:'routine',sessionId:`${bot.id}--routine-r1`,routine:{id:'r1'},bot},{source:'delegation',sessionId:bot.id,fromBotId:'bot_scout',parentRunId:'run_parent',delegation:{depth:1},bot},{source:'room',sessionId:'room_1',bot},{source:'chat',sessionId:'bot_scout',bot}])
    assert.equal(integrationPrecheck(f.store.state,context,call)?.errorCode,'owner_chat_required',context.source);
  assert.equal(integrationPrecheck(f.store.state,{...ownerChat(bot),bot:{...bot,tools:['workspace']}},call),null,'a disabled group is refused by ordinary tool validation');
});

test('an approved proposal creates a credential-less integration assigned to the bot, and calls wait for the owner',async t=>{
  const f=await fixture(t);
  const {result,snapshot}=await f.propose(proposal());
  assert.deepEqual(Object.keys(result).sort(),['actions','authType','connect','integrationId','name','notice','status','type']);
  assert.equal(result.status,'needs_credentials');assert.deepEqual(result.connect,{required:true,how:'api_key'});assert.deepEqual(result.actions,['list_messages','send_message']);
  assert.match(result.notice,/card under this reply or in Settings → Integrations.*Never ask for keys.*integration_list/);
  const saved=f.store.state.integrations[0];
  assert.equal(saved.id,result.integrationId);assert.equal(saved.secret,undefined);assert.equal(saved.type,'rest');assert.equal(saved.baseUrl,'https://mail.example.com/api');
  assert.deepEqual({botId:saved.proposedBy.botId,runId:saved.proposedBy.runId},{botId:'bot_atlas',runId:'run_fixture'});assert.match(saved.setupNotes,/API key/);assert.match(saved.reason,/check their mail/);
  assert.ok(f.store.state.bots.find(item=>item.id==='bot_atlas').integrationIds.includes(saved.id));assert.ok(snapshot.integrationIds.includes(saved.id),'the running task snapshot gains only this assignment');
  assert.equal(f.store.state.activity[0].type,'integration.proposed');
  assert.equal(integrationReady(saved),false);assert.equal(f.integrations.ready(saved),false);
  const listed=f.integrations.listTools(f.store.state.bots[0]);
  assert.deepEqual(listed,[{integrationId:saved.id,integrationName:'Fixture Mail',ready:false,status:'needs_credentials',actions:['list_messages','send_message'],notice:listed[0].notice}]);assert.match(listed[0].notice,/“Fixture Mail” is not connected yet/);
  await assert.rejects(f.integrations.call(saved.id,'list_messages',{},{approved:true,botId:'bot_atlas'}),error=>error.status===409 && error.code==='integration_not_connected' && /“Fixture Mail” is not connected yet\. The owner connects it in the card in this chat or in Settings → Integrations\./.test(error.message));
  await assert.rejects(f.integrations.discover(saved.id),/not connected yet/);
  const refused=integrationPrecheck(f.store.state,ownerChat(f.store.state.bots[0]),{name:'integration_call',arguments:{integrationId:saved.id,tool:'list_messages',arguments:{}}});
  assert.equal(refused.errorCode,'integration_not_connected');assert.equal(refused.outcome,'not_started');
  assert.deepEqual(connectionRequests(f.store.state,{id:'run_fixture'}),[{integrationId:saved.id,name:'Fixture Mail',how:'api_key'}]);assert.deepEqual(connectionRequests(f.store.state,{id:'run_other'}),[]);
  // The owner's key makes it ready; the listed shape is then the ordinary per-action one.
  const keyed=f.integrations.validate({apiKey:'owner-entered-key'},saved);
  await f.store.mutate(state=>{state.integrations[0]=keyed;});
  assert.equal(integrationReady(keyed),true);assert.deepEqual(f.integrations.listTools(f.store.state.bots[0]).map(item=>[item.name,item.requiresApproval]),[['list_messages',true],['send_message',true]]);
  assert.deepEqual(connectionRequests(f.store.state,{id:'run_fixture'}),[]);
  assert.ok(!(await fs.readFile(f.store.file,'utf8')).includes('owner-entered-key'));
});

test('no-auth REST proposals are ready at once; MCP proposals wait for discovery; limits hold',async t=>{
  const f=await fixture(t);
  const open=(await f.propose(proposal({name:'Open data',authType:'none',setupNotes:undefined,tools:[read]}))).result;
  assert.equal(open.status,'configured');assert.deepEqual(open.connect,{required:false,how:'none'});assert.match(open.notice,/is ready/);
  assert.equal(f.integrations.listTools(f.store.state.bots[0])[0].name,'list_messages');
  const mcp=(await f.propose({type:'mcp',name:'Remote MCP',baseUrl:'https://mcp.example.com/mcp',authType:'bearer',setupNotes:'Create a token.',reason:'Needed.'})).result;
  assert.equal(mcp.type,'mcp');assert.equal(mcp.status,'needs_credentials');assert.deepEqual(mcp.actions,[]);
  await assert.rejects(f.propose({type:'mcp',name:'x',baseUrl:'https://mcp.example.com/mcp',authType:'none',tools:[read],reason:'x'}),/discovered/);
  const openMcp=(await f.propose({type:'mcp',name:'Open MCP',baseUrl:'https://mcp2.example.com/mcp',authType:'none',reason:'x'})).result;
  assert.equal(openMcp.status,'untested');assert.deepEqual(openMcp.connect,{required:true,how:'none'});
  assert.match(f.integrations.listTools(f.store.state.bots[0]).find(item=>item.integrationId===openMcp.integrationId).notice,/No tools discovered yet/);
  await f.store.mutate(state=>{for(let index=state.integrations.length;index<MAX_PROPOSED_PER_BOT;index++)state.integrations.push({id:`integration_fill_${index}`,name:'Filler',type:'rest',baseUrl:'https://fill.example.com',authType:'none',tools:[read],proposedBy:{botId:'bot_atlas'}});});
  await assert.rejects(f.propose(proposal({name:'Thirteenth'})),/already proposed 12 connections/);
  const scout=structuredClone(f.store.state.bots.find(item=>item.id==='bot_scout'));
  await f.store.mutate(state=>{for(let index=state.integrations.length;index<100;index++)state.integrations.push({id:`integration_owner_${index}`,name:'Owner',type:'rest',baseUrl:'https://owner.example.com',authType:'none',tools:[read]});});
  await assert.rejects(f.tools.execute(scout,'integration_propose',proposal(),{approved:true}),/up to 100 integrations/);
});

test('changing an assigned integration names the changes, drops a credential when the address moves and never exposes it',async t=>{
  const f=await fixture(t);
  const owner={...f.integrations.validate({type:'rest',name:'Owner CRM',baseUrl:'https://crm.example.com',authType:'bearer',apiKey:'crm-owner-key',tools:[read,write]}),id:'integration_crm',createdAt:'2026-11-01T00:00:00.000Z',status:'configured'};
  await f.store.mutate(state=>{state.integrations.push(owner,{...owner,id:'integration_other',name:'Not assigned'});state.bots[0].integrationIds=['integration_crm'];});
  await assert.rejects(f.propose({integrationId:'integration_other',reason:'x',name:'Mine now'}),/only an integration assigned to you/);
  const edit={integrationId:'integration_crm',reason:'Add archiving.',tools:[{...read,description:'List recent messages with paging.'},{name:'archive',description:'Archive one message.',method:'POST',path:'/v1/archive',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}}]};
  const summary=setupApprovalSummary(f.store.state,'integration_propose',edit);
  assert.match(summary,/^Change the connection “Owner CRM” at crm\.example\.com: add archive, change list_messages, remove send_message, then 2 actions \(1 read, 1 can change things\)\. Sign-in: API key \(bearer token\)\.$/);
  const {result}=await f.propose(edit);
  assert.equal(result.status,'configured');assert.equal(result.credentialRemoved,undefined);assert.deepEqual(result.actions,['list_messages','archive']);assert.ok(!JSON.stringify(result).includes('crm-owner-key'));
  const kept=f.store.state.integrations.find(item=>item.id==='integration_crm');assert.equal(kept.secret,owner.secret);assert.equal(kept.changedBy.botId,'bot_atlas');assert.equal(kept.proposedBy,undefined);
  const move={integrationId:'integration_crm',reason:'Use the new host.',baseUrl:'https://crm2.example.com',tools:[read]};
  assert.match(setupApprovalSummary(f.store.state,'integration_propose',move),/move it to crm2\.example\.com.*Its saved key or sign-in will be removed and you connect it again\./);
  const moved=(await f.propose(move)).result;
  assert.equal(moved.credentialRemoved,true);assert.equal(moved.status,'needs_credentials');assert.equal(f.store.state.integrations.find(item=>item.id==='integration_crm').secret,undefined);
  assert.deepEqual(connectionRequests(f.store.state,{id:'run_fixture'}),[{integrationId:'integration_crm',name:'Owner CRM',how:'api_key'}]);
});

test('the approval summary names the service, its hosts, actions and sign-in in plain words',()=>{
  const state={integrations:[]};
  const gmail={name:'Gmail',baseUrl:'https://gmail.googleapis.com/gmail/v1',authType:'oauth2',oauth:{authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth',tokenUrl:'https://oauth2.googleapis.com/token',scopes:['https://www.googleapis.com/auth/gmail.modify']},tools:[read,{...read,name:'get_message'},write,{...write,name:'trash',method:'POST'}],reason:'x',setupNotes:'x'};
  assert.equal(proposalApprovalSummary(state,gmail),'Add a connection “Gmail” to gmail.googleapis.com — 4 actions (2 read, 2 can change things). Sign-in: OAuth at accounts.google.com (tokens from oauth2.googleapis.com). You enter the key or sign in yourself afterwards.');
  assert.equal(setupApprovalSummary(state,'integration_propose',gmail),proposalApprovalSummary(state,gmail));
  assert.match(proposalApprovalSummary(state,{name:'Docs',type:'mcp',baseUrl:'https://mcp.example.com/mcp',authType:'header',headerName:'X-Docs-Key'}),/to mcp\.example\.com — an MCP server; its tools are discovered after you connect it\. Sign-in: API key in the X-Docs-Key header\./);
  assert.match(proposalApprovalSummary(state,{name:'Open',baseUrl:'https://data.example.org',authType:'none',tools:[read]}),/1 action \(1 read, 0 can change things\)\. Sign-in: none\.$/);
  assert.match(proposalApprovalSummary(state,{name:'Bad',baseUrl:'not a url',tools:'x'}),/to not a url — 0 actions/);
});
