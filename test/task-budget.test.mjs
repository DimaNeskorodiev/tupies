import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, ensure } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { validateTaskBudget, taskBudget, budgetReached, budgetLabel } from '../lib/task-budget.mjs';
import { automaticReview } from '../lib/action-review.mjs';

const BOT='bot_atlas';
const call=(id,name,args)=>({id,name,arguments:args});
const waitFor=async(check,timeout=10_000)=>{const until=Date.now()+timeout;while(Date.now()<until){const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Task-budget fixture timed out.');};

test('a task budget is validated, optional and cleared by empty fields',()=>{
  assert.equal(validateTaskBudget({},ensure),null);
  assert.equal(validateTaskBudget({taskBudgetUsd:'',taskBudgetSteps:''},ensure),null);
  assert.deepEqual(validateTaskBudget({taskBudgetUsd:'2.50',taskBudgetSteps:'40'},ensure),{usd:2.5,steps:40});
  assert.deepEqual(validateTaskBudget({taskBudgetUsd:0.5},ensure),{usd:0.5});
  assert.deepEqual(validateTaskBudget({taskBudgetSteps:5},ensure),{steps:5});
  for(const bad of [{taskBudgetUsd:'0'},{taskBudgetUsd:'-1'},{taskBudgetUsd:'1e9'},{taskBudgetUsd:5000},{taskBudgetUsd:'abc'},{taskBudgetSteps:'4'},{taskBudgetSteps:1001},{taskBudgetSteps:'2.5'},{taskBudgetSteps:{}}])
    assert.throws(()=>validateTaskBudget(bad,ensure),error=>error.status===400,JSON.stringify(bad));
  // A stored value is sanitized again when read; anything unusable means no budget.
  assert.equal(taskBudget({}),null);assert.equal(taskBudget({taskBudget:{usd:-1,steps:2}}),null);assert.equal(taskBudget({taskBudget:'5'}),null);
  assert.deepEqual(taskBudget({taskBudget:{usd:2,steps:9999}}),{usd:2,steps:null});
});

test('a budget is reached by estimated dollars or steps, and each continue adds another full budget',()=>{
  const budget={usd:1,steps:10};
  assert.equal(budgetReached(null,{steps:999,costUsd:999}),null);
  assert.equal(budgetReached(budget,{steps:9,costUsd:0.99}),null);
  assert.deepEqual(budgetReached(budget,{steps:3,costUsd:1.2}),{kind:'usd',limit:1,used:1.2});
  assert.deepEqual(budgetReached(budget,{steps:10,costUsd:0.1}),{kind:'steps',limit:10,used:10});
  // An unpriced task (no dollar estimate) is limited by steps only.
  assert.equal(budgetReached({usd:1,steps:null},{steps:500,costUsd:null}),null);
  assert.equal(budgetReached(budget,{steps:19,costUsd:1.9,extensions:1}),null);
  assert.deepEqual(budgetReached(budget,{steps:20,costUsd:1.9,extensions:1}),{kind:'steps',limit:20,used:20});
  assert.equal(budgetLabel({kind:'usd',limit:2,used:2.1234}),'about 2.12 of its 2.00 US dollar task budget');
  assert.equal(budgetLabel({kind:'steps',limit:20,used:20}),'20 of its 20 budgeted model steps');
  // Approve for me never answers the owner's own budget decision.
  assert.equal(automaticReview({approvalPolicy:'auto'},{approvalPolicy:'auto'},'task_budget',{}).automatic,false);
});

async function fixture(t,complete,{budget,approvalPolicy='auto'}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-task-budget-')),store=await new Store(directory).init();
  await store.mutate(state=>{
    state.connections.push({id:'fixture',type:'openrouter',defaultModel:'m',models:[{id:'m',pricing:{input:100,output:100}}]});
    for(const bot of state.bots){bot.connectionId='fixture';bot.model='m';bot.tools=['workspace'];bot.approvalPolicy=approvalPolicy;if(budget)bot.taskBudget=budget;}
  });
  const requests=[],engine=new NativeEngine(store,{providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length);}},runTimeout:15000,stallNudgeRounds:0,stallAskRounds:0});
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,requests};
}
const decided=new Set();
const decide=async(f,choice)=>{
  const run=await waitFor(()=>{const current=f.store.state.runs[BOT],prompt=current?.pending_controls?.[0];return current?.status==='waiting_for_approval' && prompt?.tool==='task_budget' && !decided.has(prompt.prompt_id)?structuredClone(current):null;});
  decided.add(run.pending_controls[0].prompt_id);
  await f.engine.control(BOT,'approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation,choice});
  return run;
};
const looping=limit=>async(request,count)=>count<=limit?{text:'',toolCalls:[call(`list${count}`,'workspace_list',{path:count%2?'.':'notes'})],usage:{prompt_tokens:1000,completion_tokens:100}}:{text:'Finished.',toolCalls:[],usage:{prompt_tokens:1000,completion_tokens:100}};

test('without a budget nothing changes: the task runs to its end with no card',async t=>{
  const f=await fixture(t,looping(8));
  const started=await f.engine.start(BOT,'List things.');await f.engine.tasks.get(started.id);
  const run=f.store.state.runs[BOT];
  assert.equal(run.status,'completed');assert.equal(run.steps,9);
  assert.equal((run.events || []).some(event=>event.type==='task.budget'),false);
});

test('in the owner chat a step budget pauses on a card under Approve for me; Allow once continues for another budget, Deny stops with the work kept',async t=>{
  const f=await fixture(t,looping(100),{budget:{steps:5}});
  const started=await f.engine.start(BOT,'List things forever.');
  const first=await decide(f,'once');
  assert.equal(first.steps,5,'the card appears before the sixth model step');
  assert.match(first.pending_controls[0].summary || JSON.stringify(first.pending_controls[0]),/5 of its 5 budgeted model steps/);
  const second=await decide(f,'deny');
  assert.equal(second.steps,10,'continuing bought exactly one more budget');
  await f.engine.tasks.get(started.id);
  const run=f.store.state.runs[BOT];
  assert.equal(run.status,'cancelled');assert.equal(f.requests.length,10);
  assert.deepEqual((run.events || []).filter(event=>event.type==='task.budget' && event.decision).map(event=>event.decision),['continue','stopped']);
  // Every tool that ran before the stop is kept on the record; none ran twice.
  assert.equal(new Set(run.workRecords.map(record=>record.callId)).size,run.workRecords.length);assert.equal(run.workRecords.length,10);
});

test('a dollar budget uses the estimate from the task meter',async t=>{
  // Each call: 1,000 input + 100 output at $100 per million = $0.11.
  const f=await fixture(t,looping(100),{budget:{usd:0.3}});
  const started=await f.engine.start(BOT,'List things forever.');
  const waiting=await decide(f,'deny');
  assert.equal(waiting.steps,3,'three calls cost $0.33, which passes $0.30');
  assert.deepEqual([waiting.pending_controls[0].arguments.kind,waiting.pending_controls[0].arguments.limit],['usd',0.3]);
  await f.engine.tasks.get(started.id);
  assert.equal(f.store.state.runs[BOT].status,'cancelled');assert.equal(f.requests.length,3);
});

test('where nobody is watching, a task that reaches its budget stops with a plain reason instead of waiting',async t=>{
  const f=await fixture(t,looping(100),{budget:{steps:5}});
  let routine;
  await f.store.mutate(state=>{routine={id:'routine_budget',botId:BOT,name:'Budget check',prompt:'List things forever.',schedule:{kind:'interval',minutes:60},enabled:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};state.routines.push(routine);});
  const started=await f.engine.start(BOT,'List things forever.',{source:'routine',routineId:routine.id});await f.engine.tasks.get(started.id);
  const run=f.store.state.runs[BOT];
  assert.equal(run.status,'failed');assert.equal(f.requests.length,5);
  assert.match(typeof run.error==='string'?run.error:run.error.message,/used 5 of its 5 budgeted model steps and was stopped\. Its work so far is kept and nothing was replayed/);
  assert.equal((run.events || []).some(event=>event.type==='approval.request'),false);
});
