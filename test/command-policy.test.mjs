import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAction, effectiveApprovalPolicy, ownerChat, allowlisted, validateCommandAllowlist, validateRoutineCommands, commandDigest, classifyToolCall } from '../lib/command-policy.mjs';
import { classifyCommand } from '../lib/command-classifier.mjs';
import { validateRoutine } from '../lib/routines.mjs';
import { setupApprovalSummary } from '../lib/setup-tools.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';

const root='/srv/ws/bot';
const bot=(approvalPolicy='auto',extra={})=>({id:'bot',approvalPolicy,tools:['workspace','terminal','integrations'],...extra});
const terminal=command=>({id:'call',name:'terminal',arguments:{command}});
const owner=(policy='auto',extra={})=>({bot:bot(policy,extra),source:'chat',sessionId:'bot',runId:'run'});
const decide=({context=owner(),call,current=context.bot,routine,session={root,cwd:root},integration})=>decideAction({context,call,currentBot:current,currentRoutine:routine,session,integration});

test('policy is the stricter of the task snapshot and the saved bot; unknown means strict',()=>{
  assert.equal(effectiveApprovalPolicy({approvalPolicy:'auto'},{approvalPolicy:'auto'}),'auto');
  assert.equal(effectiveApprovalPolicy({approvalPolicy:'auto'},{approvalPolicy:'balanced'}),'balanced');
  assert.equal(effectiveApprovalPolicy({approvalPolicy:'strict'},{approvalPolicy:'auto'}),'strict');
  assert.equal(effectiveApprovalPolicy({approvalPolicy:'auto'},null),'strict');
  assert.equal(effectiveApprovalPolicy({approvalPolicy:'invented'},{approvalPolicy:'auto'}),'strict');
  assert.equal(ownerChat(owner()),true);
  for(const context of [{...owner(),source:'routine'},{...owner(),source:'telegram'},{...owner(),sessionId:'someone-else'},{...owner(),delegation:{depth:1}},{...owner(),roomId:'room'},{...owner(),fromBotId:'other'}])assert.equal(ownerChat(context),false);
});

test('decision matrix: read-only, ordinary and dangerous commands across policies and lanes',()=>{
  const lanes={owner:owner,routine:policy=>({...owner(policy),source:'routine',routine:{id:'r1'}}),teammate:policy=>({...owner(policy),source:'delegation',delegation:{depth:1}}),telegram:policy=>({...owner(policy),source:'telegram',sessionId:'telegram:42'})};
  const expected={
    // [read_only, normal, dangerous] automatic?
    auto:{owner:[true,true,false],routine:[true,false,false],teammate:[true,false,false],telegram:[true,false,false]},
    balanced:{owner:[true,false,false],routine:[true,false,false],teammate:[true,false,false],telegram:[true,false,false]},
    strict:{owner:[false,false,false],routine:[false,false,false],teammate:[false,false,false],telegram:[false,false,false]},
  };
  for(const [policy,byLane] of Object.entries(expected))for(const [lane,results] of Object.entries(byLane)) {
    ['git status','npm test','rm -rf build'].forEach((command,index)=>{
      const context=lanes[lane](policy),decision=decide({context,call:terminal(command)});
      assert.equal(decision.automatic,results[index],`${policy}/${lane}/${command}: ${decision.reason}`);
    });
  }
  const dangerous=decide({call:terminal('git push')});
  assert.match(dangerous.reason,/^Dangerous: git push/);assert.equal(dangerous.review.command.risk,'dangerous');assert.equal(dangerous.review.command.cwd,'.');
  assert.equal(decide({call:terminal('ls'),session:{root,cwd:`${root}/src`}}).review.command.cwd,'src');
});

test('terminal access revoked on the saved bot stops automatic execution',()=>{
  const decision=decide({call:terminal('ls'),current:{...bot('auto'),tools:['workspace']}});
  assert.equal(decision.automatic,false);assert.match(decision.reason,/no longer enabled/);
  assert.equal(decide({call:terminal('ls'),current:null}).automatic,false);
});

test('owner allowlist auto-runs matching ordinary commands in every lane except strict, never dangerous ones',()=>{
  const allow={commandAllowlist:['npm test','npm run *','python3 scripts/*.py']};
  const routine={...owner('balanced',allow),source:'routine',routine:{id:'r1'}};
  for(const command of ['npm test','npm run build','npm run lint -- --fix','python3 scripts/report.py','git status && npm test','timeout 600 npm test'])assert.equal(decide({context:routine,call:terminal(command)}).automatic,true,command);
  for(const command of ['npm install','python3 other.py','npm test && npm publish','npm run build; rm -rf dist','python3 scripts/x.py > /etc/x','echo hi > out.txt','$CMD test'])assert.equal(decide({context:routine,call:terminal(command)}).automatic,false,command);
  assert.match(decide({context:routine,call:terminal('npm test')}).reason,/allowed command “npm test”/);
  // Both the task snapshot and the saved bot must allow it.
  assert.equal(decide({context:routine,call:terminal('npm test'),current:bot('balanced')}).automatic,false);
  assert.equal(decide({context:{...routine,bot:bot('balanced')},call:terminal('npm test'),current:bot('balanced',allow)}).automatic,false);
  assert.equal(decide({context:{...routine,bot:bot('strict',allow)},call:terminal('npm test'),current:bot('strict',allow)}).automatic,false);
  // The allowlist covers terminal-style commands, not arbitrary code snippets.
  assert.equal(decide({context:routine,call:{name:'execute_code',arguments:{language:'python',code:'import pandas'}}}).automatic,false);
  assert.equal(allowlisted(classifyCommand('ls'),['ls']),null,'read-only commands need no allowlist entry');
  assert.equal(allowlisted(classifyCommand('npm test'),[]),null);
});

test('allowlist validation keeps patterns to simple commands',()=>{
  assert.deepEqual(validateCommandAllowlist(['npm  test',' npm run * ','npm test','','npm\nrun lint']),['npm test','npm run *','npm run lint']);
  for(const bad of [['*'],['* rm'],['npm test; rm -rf /'],['a | b'],['$(x)'],['x'.repeat(201)],['bell\u0007x'],[42]])assert.throws(()=>validateCommandAllowlist(bad),/allowed command pattern/i,JSON.stringify(bad));
  assert.throws(()=>validateCommandAllowlist(Array(51).fill('ls')),/up to 50/);
  assert.throws(()=>validateCommandAllowlist('npm test'),/up to 50/);
});

test('routine pre-approved exact commands run unattended only in that routine for that bot',()=>{
  const approved=validateRoutineCommands(['npm run report','curl -s https://api.example.com/prices -o prices.json']);
  assert.deepEqual(approved.map(item=>item.digest),[commandDigest('npm run report'),commandDigest('curl -s https://api.example.com/prices -o prices.json')]);
  const routine={id:'r1',botId:'bot',approvedCommands:approved},context={...owner('balanced'),source:'routine',routine:structuredClone(routine)};
  assert.equal(decide({context,call:terminal('npm run report'),routine}).automatic,true);
  assert.match(decide({context,call:terminal('npm run report'),routine}).reason,/pre-approved/);
  assert.equal(decide({context,call:terminal('npm run report '),routine}).automatic,false,'the digest is exact');
  assert.equal(decide({context,call:terminal('npm run other'),routine}).automatic,false);
  assert.equal(decide({context,call:terminal('npm run report'),routine:{...routine,approvedCommands:[]}}).automatic,false,'the owner removed the pre-approval');
  assert.equal(decide({context,call:terminal('npm run report'),routine:{...routine,botId:'other'}}).automatic,false);
  assert.equal(decide({context:{...context,routine:{id:'r1'}},call:terminal('npm run report'),routine}).automatic,false,'the task snapshot must carry it too');
  assert.equal(decide({context:{...owner('balanced')},call:terminal('npm run report'),routine}).automatic,false,'other lanes cannot use it');
  // Strict still honours the owner's exact per-routine approval.
  assert.equal(decide({context:{...context,bot:bot('strict')},call:terminal('npm run report'),current:bot('strict'),routine}).automatic,true);
  assert.throws(()=>validateRoutineCommands(['git push']),/dangerous/);
  assert.throws(()=>validateRoutineCommands(['rm -rf build']),/dangerous/);
  assert.throws(()=>validateRoutineCommands(Array(21).fill('ls')),/up to 20/);
  assert.deepEqual(validateRoutineCommands(null),[]);
});

test('routine validation stores, clears and drops commands when the routine changes bots',()=>{
  const base={name:'Report',botId:'bot',prompt:'Make the report.',schedule:{kind:'interval',minutes:60}};
  const created=validateRoutine({...base,commands:['npm run report']},{id:'r1'});
  assert.deepEqual(created.approvedCommands,[{command:'npm run report',digest:commandDigest('npm run report')}]);
  assert.deepEqual(validateRoutine({name:'Renamed'},created).approvedCommands,created.approvedCommands);
  assert.equal(validateRoutine({commands:[]},created).approvedCommands,undefined);
  assert.equal(validateRoutine({botId:'other'},created).approvedCommands,undefined);
  assert.throws(()=>validateRoutine({...base,commands:['sudo reboot']},{id:'r2'}),/dangerous/);
  const summary=setupApprovalSummary({routines:[],bots:[],settings:{}},'routines_create',{...base,commands:['npm run report']});
  assert.match(summary,/pre-approve 1 exact command for unattended runs: “npm run report”/);
});

test('integration GET actions can be marked auto by the owner; writes and MCP keep review',()=>{
  const integrations=new Integrations({state:{},seal:value=>`sealed:${value}`},{allowPrivateHttp:false});
  const saved=integrations.validate({type:'rest',name:'Prices',baseUrl:'https://api.example.com',authType:'none',tools:[{name:'prices',method:'GET',path:'/prices',approval:'auto'},{name:'order',method:'POST',path:'/order'}]});
  assert.equal(saved.tools[0].approval,'auto');assert.equal(saved.tools[1].approval,undefined);
  assert.throws(()=>integrations.validate({type:'rest',name:'x',baseUrl:'https://api.example.com',authType:'none',tools:[{name:'order',method:'POST',path:'/order',approval:'auto'}]}),/Only GET/);
  assert.throws(()=>integrations.validate({type:'rest',name:'x',baseUrl:'https://api.example.com',authType:'none',tools:[{name:'p',method:'GET',path:'/p',approval:'always'}]}),/ask or auto/);
  const integration={id:'api',name:'Prices',...saved},call=tool=>({name:'integration_call',arguments:{integrationId:'api',tool,arguments:{}}});
  const assigned={integrationIds:['api']},routine={...owner('balanced',assigned),source:'routine',routine:{id:'r1'}};
  assert.equal(decide({context:routine,call:call('prices'),integration}).automatic,true);
  assert.equal(decide({context:routine,call:call('order'),integration}),null,'other actions keep the existing review path');
  assert.equal(decide({context:{...routine,bot:bot('strict',assigned)},current:bot('strict',assigned),call:call('prices'),integration}),null);
  assert.equal(decide({context:routine,current:bot('balanced'),call:call('prices'),integration}),null,'unassigned on the saved bot');
  assert.equal(decide({context:routine,call:call('prices'),integration:{...integration,type:'mcp'}}),null);
  const listed=new Integrations({state:{integrations:[integration]}}).listTools({integrationIds:['api']});
  assert.deepEqual(listed.map(tool=>[tool.name,tool.requiresApproval]),[['prices',false],['order',true]]);
});

test('shell_run and shell_start use the same classifier with their literal arguments and folder',()=>{
  const call=(name,args)=>({name,arguments:args});
  assert.equal(classifyToolCall(call('shell_run',{executable:'ls',args:['-la']}),{root}).risk,'read_only');
  assert.equal(classifyToolCall(call('shell_run',{executable:'cat',args:['../notes.md'],cwd:'sub'}),{root}).risk,'read_only');
  assert.equal(classifyToolCall(call('shell_start',{executable:'rm',args:['-rf','x']}),{root}).risk,'dangerous');
  // The legacy tools keep exact approval outside Approve for me in the owner's chat; the classifier replaces only the model review.
  assert.equal(decide({context:owner('balanced'),call:call('shell_run',{executable:'git',args:['status']})}).automatic,false);
  assert.equal(decide({context:owner('auto'),call:call('shell_run',{executable:process.execPath,args:['build.mjs']})}).automatic,true);
  assert.equal(decide({context:owner('auto'),call:call('shell_start',{executable:'git',args:['push']})}).automatic,false);
  assert.equal(decide({context:{...owner('auto'),source:'routine',routine:{id:'r1'}},call:call('shell_run',{executable:'ls',args:[]})}).automatic,false);
  assert.equal(decide({context:owner('balanced',{commandAllowlist:['npm test']}),call:call('shell_run',{executable:'npm',args:['test']})}).automatic,false);
});

test('terminal tools are in the terminal group with short descriptions',()=>{
  const tools=new AgentTools({state:{bots:[],skills:[]}},{}),definitions=tools.definitions({tools:['terminal']});
  for(const name of ['terminal','execute_code']) {
    const definition=definitions.find(item=>item.name===name);assert.ok(definition,name);
    assert.ok(definition.description.length<=200,`${name} description is ${definition.description.length} characters`);
    for(const [key,property] of Object.entries(definition.parameters.properties))assert.ok(!property.description || property.description.length<=120,`${name}.${key}`);
  }
  assert.equal(tools.definitions({tools:['workspace']}).some(item=>['terminal','execute_code'].includes(item.name)),false);
  assert.equal(tools.requiresApproval('terminal',{approvalPolicy:'auto'}),true,'the engine decides automatic runs; the tool itself always needs an approval decision');
});
