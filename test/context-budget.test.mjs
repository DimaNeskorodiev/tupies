import test from 'node:test';
import assert from 'node:assert/strict';
import { compactThreshold, compactionSummaryTokens, contextLimits, catalogContextWindow, knownContextWindow, contextOverflow, estimateTokens, promptTokens, safeContextWindow } from '../lib/context-budget.mjs';

test('context limits follow the model window with a 55% summary threshold capped at 128K and a 272K default ceiling',()=>{
  // A ChatGPT subscription model: 95% usable, summary compaction from 55% towards a 20% target.
  assert.deepEqual(contextLimits({type:'chatgpt'},'gpt-6.1-sol'),{window:272_000,source:'known',effective:272_000,usable:258_400,compactAt:128_000,fitAt:244_800,compactThreshold:55,compactTarget:54_400,small:false});
  assert.equal(contextLimits({type:'chatgpt'},'gpt-5.3-codex-spark').window,128_000);
  // A 1M window is capped by default; the bot may allow the full window or ask for 128K.
  const claude={type:'anthropic',models:[{id:'claude-opus-5',contextWindow:1_000_000}]};
  assert.equal(contextLimits(claude,'claude-opus-5').effective,272_000);assert.equal(contextLimits(claude,'claude-opus-5').source,'provider');
  // The full window still fits a large task, but with the default threshold a conversation is summarized at 128K tokens.
  assert.equal(contextLimits(claude,'claude-opus-5',{contextLimit:'max'}).compactAt,128_000);assert.equal(contextLimits(claude,'claude-opus-5',{contextLimit:'max'}).fitAt,900_000);
  assert.equal(contextLimits(claude,'claude-opus-5',{contextLimit:'max'}).compactTarget,54_400);
  // An explicit owner threshold is honoured as set.
  assert.equal(contextLimits(claude,'claude-opus-5',{contextLimit:'max',compactThreshold:55}).compactAt,550_000);
  assert.equal(contextLimits({type:'openai'},'gpt-4o').compactAt,70_400);
  assert.equal(contextLimits(claude,'claude-opus-5',{contextLimit:'128k'}).compactAt,70_400);
  // Unknown windows are treated as 128K; an owner's explicit setting wins over everything else.
  assert.deepEqual(contextLimits({type:'custom'},'local-model'),{window:128_000,source:'default',effective:128_000,usable:121_600,compactAt:70_400,fitAt:115_200,compactThreshold:55,compactTarget:25_600,small:false});
  assert.equal(contextLimits({type:'ollama',contextWindow:32_768,models:[{id:'qwen',contextWindow:262_144}]},'qwen').window,32_768);
  assert.equal(contextLimits({type:'ollama',contextWindow:32_768},'qwen').small,true);
  // A limit learned from a provider error is reported as such.
  assert.equal(contextLimits({type:'openai',models:[{id:'m',contextWindow:200_000,contextSource:'provider-error'}]},'m').source,'provider-error');
  // A large output reservation never pushes the usable budget below the compaction point.
  const limits=contextLimits({type:'custom',contextWindow:16_000,maxOutputTokens:32_768},'tiny');
  assert.ok(limits.compactAt<=limits.usable && limits.usable<=limits.effective);
});

test('catalog windows are read from the fields providers use and rejected when implausible',()=>{
  assert.equal(catalogContextWindow({context_window:272_000,max_context_window:900_000}),272_000);
  assert.equal(catalogContextWindow({max_context_window:400_000}),400_000);
  assert.equal(catalogContextWindow({context_length:131_072}),131_072);
  assert.equal(catalogContextWindow({top_provider:{context_length:200_000}}),200_000);
  assert.equal(catalogContextWindow({context_length:'lots'}),null);assert.equal(catalogContextWindow({context_length:12}),null);
  assert.equal(safeContextWindow('200000'),200_000);assert.equal(safeContextWindow('2e5'),null);assert.equal(safeContextWindow(20_000_000),null);
  assert.equal(knownContextWindow('xai','grok-4.6-fast'),500_000);assert.equal(knownContextWindow('openrouter','anthropic/claude-sonnet-5'),1_000_000);
  assert.equal(knownContextWindow('custom','mystery-model'),null);
});

test('provider context errors are recognised with their stated limit, and rate limits are not',()=>{
  assert.deepEqual(contextOverflow(new Error("OpenAI returned HTTP 400: This model's maximum context length is 128,000 tokens. However, your messages resulted in 130,512 tokens.")),{limit:128_000});
  assert.deepEqual(contextOverflow(new Error('Anthropic returned HTTP 400: prompt is too long: 210000 tokens > 200000 maximum')),{limit:200_000});
  assert.deepEqual(contextOverflow(new Error('xAI returned HTTP 400: The input exceeds the context window.')),{limit:null});
  assert.equal(contextOverflow(new Error('OpenAI returned HTTP 429: Rate limit reached on tokens per min (TPM). Too many tokens.')),null);
  assert.equal(contextOverflow(new Error('OpenAI returned HTTP 401: Invalid API key.')),null);
});

test('token estimates count multi-byte text denser and reported usage includes cached prompt segments',()=>{
  assert.equal(estimateTokens('a'.repeat(400)),100);
  assert.equal(estimateTokens('я'.repeat(400)),200);
  assert.ok(estimateTokens({role:'user',content:'hello'})>0);
  assert.equal(promptTokens({input_tokens:1000,output_tokens:50}),1000);
  assert.equal(promptTokens({prompt_tokens:900}),900);
  assert.equal(promptTokens({input_tokens:10,cache_read_input_tokens:5000,cache_creation_input_tokens:200}),5210);
  assert.equal(promptTokens({output_tokens:5}),null);
});

test('a bot chooses its summary threshold within 30-90% of the effective window',()=>{
  const chatgpt={type:'chatgpt'};
  assert.equal(contextLimits(chatgpt,'gpt-6.1-sol',{compactThreshold:90}).compactAt,244_800);
  assert.equal(contextLimits(chatgpt,'gpt-6.1-sol',{compactThreshold:'40'}).compactAt,108_800);
  for(const invalid of [10,95,'abc',55.5,null,''])assert.equal(compactThreshold({compactThreshold:invalid}),55);
  // The usable budget still caps a high threshold when the output reservation is large.
  const tight=contextLimits({type:'custom',contextWindow:16_000,maxOutputTokens:32_768},'tiny',{compactThreshold:90});
  assert.ok(tight.compactAt<=tight.usable);
  // Summary record plus kept tail aim at about a fifth of the window, never below a tenth.
  assert.equal(compactionSummaryTokens(272_000,10_000),44_400);
  assert.equal(compactionSummaryTokens(32_000,6_400),3_200);
});
