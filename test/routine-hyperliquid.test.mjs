// Covers the changes recovered from the VPS release 0.5.0-engine.beta.10.finance-0041c0b0, whose own tests were not on the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { AgentTools } from '../lib/agent-tools.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { hyperliquidVaultReport, validateVaultReportTarget } from '../lib/routine-hyperliquid.mjs';
import { validateRoutineWorkflow, prepareRoutineWorkflow } from '../lib/routine-workflow.mjs';
import { repeatedFailure, callFingerprint } from '../lib/work-quality.mjs';

const ENDPOINT='https://api.hyperliquid.xyz/info';
const VAULT='0x'+'Ab'.repeat(20),ALICE='0x'+'1'.repeat(40),BOB='0x'+'2'.repeat(40);
const follower=(user,vaultEquity,pnl,allTimePnl)=>({vaultAddress:VAULT,followerState:{user,vaultEquity,pnl,allTimePnl}});
const answer=(data,extra={})=>({status:200,url:ENDPOINT,text:JSON.stringify(data),...extra});
/** A Web tool stand-in that answers each wallet from a table and records the exact requests. */
function web(table,calls=[]) {
  return async(name,args)=>{calls.push({name,args});const reply=table[args.body.user];return typeof reply==='function'?reply():reply;};
}
const target={vault:VAULT.toLowerCase(),wallets:[ALICE,BOB]};

test('a vault report target is one vault and one to four distinct public wallets, stored in lower case',()=>{
  assert.deepEqual(validateVaultReportTarget({vault:VAULT,wallets:['0x'+'C'.repeat(40)]}),{vault:VAULT.toLowerCase(),wallets:['0x'+'c'.repeat(40)]});
  for(const bad of [{vault:'0x123',wallets:[ALICE]},{vault:VAULT,wallets:[]},{vault:VAULT,wallets:[ALICE,BOB,'0x'+'3'.repeat(40),'0x'+'4'.repeat(40),'0x'+'5'.repeat(40)]},{vault:VAULT,wallets:'0x'+'1'.repeat(40)},{vault:VAULT,wallets:[ALICE,'not-an-address']},{vault:VAULT,wallets:[ALICE,ALICE.toUpperCase().replace('0X','0x')]},{vault:VAULT,wallets:[VAULT.toLowerCase()]}])
    assert.throws(()=>validateVaultReportTarget(bad),error=>error.status===400,JSON.stringify(bad));
});

test('each wallet is read with one exact POST without redirects; totals are rounded after addition and wallets are masked',async()=>{
  const calls=[];
  const report=await hyperliquidVaultReport(target,{callTool:web({[ALICE]:answer(follower(ALICE,'1000.004','-12.5','40')),[BOB]:answer(follower(BOB.toUpperCase().replace('0X','0x'),'250.004','0.004','-0.004'))},calls)});
  assert.deepEqual(calls,[ALICE,BOB].map(user=>({name:'http_fetch',args:{url:ENDPOINT,method:'POST',followRedirects:false,body:{type:'vaultDetails',vaultAddress:VAULT.toLowerCase(),user}}})));
  assert.deepEqual(report.positions,[
    {wallet:`${ALICE.slice(0,8)}…${ALICE.slice(-6)}`,equity:'1000.00',pnl:'-12.50',allTimePnl:'40.00'},
    {wallet:`${BOB.slice(0,8)}…${BOB.slice(-6)}`,equity:'250.00',pnl:'0.00',allTimePnl:'0.00'},
  ]);
  // 1000.004 + 250.004 = 1250.008, which is 1250.01 only when the sum is rounded, not the rows.
  assert.deepEqual(report.total,{equity:'1250.01',pnl:'-12.50',allTimePnl:'40.00'});
  assert.ok(Number.isFinite(Date.parse(report.observedAt)));
  assert.ok(!JSON.stringify(report).includes(ALICE),'The full wallet address is not repeated in the report.');
});

test('an incomplete, redirected, mismatched or malformed answer stops the report',async()=>{
  const failing={
    'another status':answer(follower(ALICE,'1','0','0'),{status:429}),
    'another final URL':answer(follower(ALICE,'1','0','0'),{url:'https://example.com/info'}),
    'a shortened body':answer(follower(ALICE,'1','0','0'),{extraction:{limited:true}}),
    'a tool error':answer(follower(ALICE,'1','0','0'),{error:'blocked'}),
    'text that is not JSON':{status:200,url:ENDPOINT,text:'<html>'},
    'another vault':answer({...follower(ALICE,'1','0','0'),vaultAddress:'0x'+'9'.repeat(40)}),
    'another wallet':answer(follower(BOB,'1','0','0')),
    'no position':answer({vaultAddress:VAULT}),
    'an amount that is not a decimal':answer(follower(ALICE,'1e3','0','0')),
    'a numeric amount':answer(follower(ALICE,1000,'0','0')),
    'negative equity':answer(follower(ALICE,'-1','0','0')),
  };
  for(const [name,reply] of Object.entries(failing))
    await assert.rejects(hyperliquidVaultReport({vault:VAULT.toLowerCase(),wallets:[ALICE]},{callTool:web({[ALICE]:reply})}),error=>error.status===502,name);
  const stopped=new AbortController();stopped.abort(new Error('Stop'));
  await assert.rejects(hyperliquidVaultReport(target,{callTool:()=>assert.fail('A stopped report sends nothing.'),signal:stopped.signal}),/Stop/);
});

test('the routine step is report-only, keeps its literal addresses and renders into the report',async()=>{
  const workflow={version:1,mode:'report',steps:[{id:'vault',op:'hyperliquid_vault',vault:VAULT,wallets:[ALICE,BOB]}],report:'Equity {{vault.total.equity}} USDC, P&L {{vault.total.pnl}}'};
  const spec=validateRoutineWorkflow(workflow);
  assert.deepEqual({...spec.steps[0],wallets:[...spec.steps[0].wallets]},{id:'vault',op:'hyperliquid_vault',vault:VAULT.toLowerCase(),wallets:[ALICE,BOB]});
  assert.throws(()=>validateRoutineWorkflow({...workflow,mode:'agent',report:undefined,context:'{{vault.total.equity}}'}),/report mode/);
  assert.throws(()=>validateRoutineWorkflow({...workflow,steps:[{...workflow.steps[0],url:'https://example.com/'}]}));
  assert.throws(()=>validateRoutineWorkflow({...workflow,steps:[{...workflow.steps[0],wallets:[ALICE,ALICE]}]}),/distinct/);
  assert.throws(()=>validateRoutineWorkflow({...workflow,steps:[{id:'vault',op:'hyperliquid_transfer',vault:VAULT,wallets:[ALICE]}]}),/Step operation is unsupported/);
  const calls=[],checkpoints=[];
  const result=await prepareRoutineWorkflow(workflow,{callTool:web({[ALICE]:answer(follower(ALICE,'10','1','2')),[BOB]:answer(follower(BOB,'5.5','-0.25','0'))},calls),checkpoint:entry=>checkpoints.push(entry)});
  assert.equal(result.output,'Equity 15.50 USDC, P&L 0.75');
  assert.deepEqual(calls.map(call=>call.name),['http_fetch','http_fetch']);assert.deepEqual(checkpoints.map(entry=>entry.op),['hyperliquid_vault']);
  // A resumed routine reuses the completed step instead of asking Hyperliquid again.
  const resumed=await prepareRoutineWorkflow(workflow,{callTool:()=>assert.fail('A completed vault read must not be sent again.'),results:{vault:checkpoints[0].result}});
  assert.equal(resumed.output,result.output);
});

test('a JSON step after a saved script reads its stdout when no path is given',async()=>{
  const script={id:'collect',op:'script',scriptId:'collect-fixture',digest:'a'.repeat(64),args:[]};
  const run=steps=>prepareRoutineWorkflow({version:1,mode:'report',steps,report:'Count: {{parsed.count}}'},{callTool:async()=>({scriptId:'collect-fixture',digest:'a'.repeat(64),status:'completed',exitCode:0,stdout:'{"count":7}',stderr:'',timedOut:false,truncated:false})});
  assert.equal((await run([script,{id:'parsed',op:'json',from:'collect'}])).output,'Count: 7');
  assert.equal((await run([script,{id:'parsed',op:'json',from:'collect',path:''}])).output,'Count: 7');
  assert.equal((await run([script,{id:'parsed',op:'json',from:'collect',path:'stdout'}])).output,'Count: 7');
});

test('http_fetch can require the exact URL with no redirects, and only as a boolean',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-fetch-redirects-')),store=await new Store(directory).init();
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const calls=[],tools=new AgentTools(store,{publicFetch:async(url,options)=>{calls.push(options);return {url,status:200,method:options.method||'GET',contentType:'application/json',text:'{"ok":1}'};}});
  const bot={...store.state.bots[0],approvalPolicy:'auto',tools:[...new Set([...(store.state.bots[0].tools||[]),'http_fetch','web'])]};
  assert.equal(tools.definitions(bot).find(item=>item.name==='http_fetch').parameters.properties.followRedirects.type,'boolean');
  await tools.execute(bot,'http_fetch',{url:'https://example.com/a',followRedirects:false});
  await tools.execute(bot,'http_fetch',{url:'https://example.com/b',followRedirects:true});
  await tools.execute(bot,'http_fetch',{url:'https://example.com/c'});
  assert.deepEqual(calls.map(options=>options.maxRedirects),[0,undefined,undefined]);
  await assert.rejects(tools.execute(bot,'http_fetch',{url:'https://example.com/d',followRedirects:'no'}),/followRedirects must be boolean/);
  assert.equal(calls.length,3);
});

test('a call that already failed on its arguments is blocked at once with advice to correct them',()=>{
  const call={name:'workspace_read',arguments:{path:5}},failed=errorCode=>({failedCalls:new Map([[callFingerprint(call),{count:1,errorCode}]])});
  const blocked=repeatedFailure(failed('invalid_arguments'),call);
  assert.equal(blocked.errorCode,'repeated_failure');assert.equal(blocked.outcome,'not_started');assert.match(blocked.recovery,/Correct the arguments using the tool schema/);
  assert.equal(repeatedFailure(failed('transient_read'),call),null,'One ordinary failure may still be retried.');
  assert.equal(repeatedFailure({failedCalls:new Map()},call),null);
});

test('a task may look through its own run diagnostics twice; an earlier run stays readable by its ID',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-diagnostics-')),store=await new Store(directory).init(),results={};
  await store.mutate(state=>{state.connections.push({id:'fixture-provider',type:'openai',name:'Fixture',model:'test-model'});state.bots[0].connectionId='fixture-provider';state.bots[0].tools=['workspace','memory'];});
  let earlierId='',count=0;
  const inspect=(id,args)=>({text:'',toolCalls:[{id,name:'runs_inspect',arguments:args}]});
  const engine=new NativeEngine(store,{runTimeout:10_000,providers:{async complete(_connection,request){
    for(const message of request.messages)if(message.role==='tool' && !results[message.tool_call_id])results[message.tool_call_id]=JSON.parse(message.content);
    return [{text:'Earlier task done.',toolCalls:[]},inspect('first',{limit:2}),inspect('second',{limit:3}),inspect('third',{limit:4}),inspect('earlier',{runId:earlierId}),{text:'Done.',toolCalls:[]}][count++];
  }}});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const finished=async previous=>{const deadline=Date.now()+8000;while(Date.now()<deadline){const run=store.state.runs.bot_atlas;if(run && run.id!==previous && run.status==='completed')return run;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('The fixture run did not finish.');};
  await engine.start('bot_atlas','Earlier task.');earlierId=(await finished('')).id;
  await engine.start('bot_atlas','Why was that slow?');await finished(earlierId);
  assert.equal(results.first.botId,'bot_atlas');assert.equal(results.second.botId,'bot_atlas');
  assert.equal(results.third.errorCode,'repeated_read');assert.match(results.third.recovery,/specific earlier run ID/);
  assert.equal(results.earlier.errorCode,undefined,'A named earlier run is not counted as browsing the current diagnostics.');
});
