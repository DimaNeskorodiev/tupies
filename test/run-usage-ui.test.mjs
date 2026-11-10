import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('../public/run-usage.js',import.meta.url),'utf8');
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const index=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/run-usage.css',import.meta.url),'utf8');
const window={};vm.runInNewContext(source,{window});
const {footer,tokens,dollars,duration}=window.StudioRunUsage;

test('token, dollar and time labels stay short and honest',()=>{
  assert.deepEqual([0,950,1000,12_600,20_700,99_940,250_000,1_250_000,3_000_000].map(tokens),['0','950','1K','12.6K','20.7K','99.9K','250K','1.25M','3M']);
  assert.deepEqual([0,0.0004,0.00456,0.012,0.0146,0.5,1.25,12].map(dollars),['$0','$0.0004','$0.0046','$0.012','$0.015','$0.50','$1.25','$12.00']);
  assert.equal(dollars(-1),'');assert.equal(dollars(NaN),'');
  assert.deepEqual([400,34_000,60_000,95_000,3_600_000,7_500_000].map(duration),['1 s','34 s','1 min','1 min 35 s','1 h 0 min','2 h 5 min']);
  assert.equal(duration(undefined),'');
});

test('a priced task shows steps, tokens, cache reuse, an estimate and time, with a breakdown',()=>{
  const html=footer({steps:2,toolCalls:1,modelCalls:2,inputTokens:12_600,cachedTokens:12_000,cacheWriteTokens:0,outputTokens:380,reasoningTokens:120,totalTokens:24_980,cachePercent:49,costUsd:0.01456,costSource:'catalog',durationMs:1200,model:'demo-model',provider:'custom'});
  assert.match(html,/^<details class="run-usage"><summary aria-label="Task usage: 2 steps, 25K tokens, 49% cached, ≈ \$0\.015, 1 s">/);
  for(const part of ['<span>2 steps</span>','<span>25K tokens</span>','<span>49% cached</span>','<span>≈ $0.015</span>','<dt>Tool calls</dt><dd>1</dd>','<dt>New input</dt><dd>12.6K tokens</dd>','<dt>Cached input</dt><dd>12K tokens</dd>','<dt>Output</dt><dd>380 tokens (120 reasoning)</dd>','<dt>Model</dt><dd>demo-model</dd>','Estimate from the list prices in the provider’s model catalog.'])assert.ok(html.includes(part),part);
  assert.equal(html.includes('Cache writes'),false);
});

test('no dollars are shown without a price, and nothing is shown without a model call',()=>{
  const unpriced=footer({steps:3,toolCalls:0,modelCalls:3,inputTokens:900,cachedTokens:0,cacheWriteTokens:0,outputTokens:50,totalTokens:950,cachePercent:0,durationMs:65_000});
  assert.equal(unpriced.includes('$'),false);assert.equal(unpriced.includes('cached</span>'),false);
  assert.ok(unpriced.includes('No price is known for this model, so no cost is shown.'));assert.ok(unpriced.includes('<span>1 min 5 s</span>'));
  const plan=footer({steps:1,toolCalls:0,modelCalls:1,inputTokens:10,cachedTokens:90,cacheWriteTokens:0,outputTokens:5,totalTokens:105,cachePercent:90,costSource:'subscription'});
  assert.ok(plan.includes('Included in your subscription; no per-task price.'));assert.equal(plan.includes('$'),false);
  const silent=footer({steps:1,toolCalls:0,modelCalls:1,inputTokens:0,cachedTokens:0,cacheWriteTokens:0,outputTokens:0,totalTokens:0,unreportedCalls:1,durationMs:900});
  assert.ok(silent.includes('The provider did not report token usage for this task.'));
  for(const empty of [undefined,null,{},[],'x',{totalTokens:5},{totalTokens:5,modelCalls:0},{totalTokens:'5',modelCalls:1}])assert.equal(footer(empty),'');
});

test('a record is rendered as escaped text only',()=>{
  const html=footer({steps:1,toolCalls:0,modelCalls:1,inputTokens:1,cachedTokens:0,cacheWriteTokens:0,outputTokens:1,totalTokens:2,model:'<img src=x onerror=alert(1)>"',costSource:'<script>'});
  assert.equal(/<img|<script/.test(html),false);assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;'));
});

test('the chat renders the line only under finished bot replies and loads its assets',()=>{
  assert.ok(app.includes("!user&&!system&&!asked&&!message.partial&&message.usage?window.StudioRunUsage?.footer(message.usage)||'':''"));
  assert.match(index,/<link rel="stylesheet" href="\/run-usage\.css">/);assert.match(index,/<script defer src="\/run-usage\.js"><\/script>/);
  assert.match(css,/\.run-usage>summary\{[^}]*min-height:28px/);assert.match(css,/@media \(max-width:760px\)\{\.run-usage>summary\{min-height:44px\}/);
  assert.equal(/animation|transition/.test(css),false);
});

test('bot settings offer an optional task budget and engine check-ins are a plain continue-or-stop card',()=>{
  assert.ok(app.includes('name="taskBudgetUsd"') && app.includes('name="taskBudgetSteps"'));
  assert.ok(app.includes("['task_budget','task_checkpoint'].includes(control?.tool)"));
  const card=app.slice(app.indexOf("['task_budget','task_checkpoint'].includes(control?.tool)"),app.indexOf('Your approval is needed'));
  assert.match(card,/data-choice="deny"[^>]*>Stop<\/button>/);assert.match(card,/data-choice="once"[^>]*>Continue<\/button>/);
  assert.equal(card.includes('JSON.stringify(rawDetail'),false);
});

test('work that used no model says so, with no token rows or price note',()=>{
  const html=footer({steps:0,toolCalls:1,modelCalls:0,inputTokens:0,cachedTokens:0,outputTokens:0,totalTokens:0,durationMs:3000});
  assert.match(html,/^<details class="run-usage"><summary aria-label="Task usage: 0 model calls, 1 command, 3 s">/);
  assert.ok(html.includes('<span>0 model calls</span><span>1 command</span><span>3 s</span>'));
  assert.ok(html.includes('<p>This ran without a model: no tokens were used.</p>'));
  assert.equal(/<dl|tokens<\/dd>|\$|price|cached/i.test(html),false);
  assert.ok(footer({modelCalls:0,totalTokens:0,toolCalls:3}).includes('<span>0 model calls</span><span>3 commands</span>'));
  assert.ok(footer({modelCalls:0,totalTokens:0}).includes('<span>0 model calls</span></summary>'));
  // A record claiming zero calls but real tokens is not a zero-model record.
  assert.equal(footer({modelCalls:0,totalTokens:12}),'');assert.equal(footer({modelCalls:0,totalTokens:0,inputTokens:5}),'');
});
