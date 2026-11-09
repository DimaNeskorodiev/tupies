#!/usr/bin/env node
// Measures the engine-written part of one model request: system prompt, offered tool schemas, task-start reference data
// and the per-step turn context. It builds the real request with NativeEngine.workingContext against a disposable store,
// for a default new bot and a fully enabled bot, and estimates tokens with the engine's own estimator (UTF-8 bytes / 4).
// Usage: node scripts/measure-prompt.mjs [--json]
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const load=relative=>import(pathToFileURL(path.join(root,relative)).href);

// A mid-task step: an owner request, a four-step plan with one step done, and observed web research.
const TASK='Compare the three cheapest direct flights from Warsaw to Lisbon next Friday and summarize them in a short table.';
const PLAN={version:2,steps:[{id:'search',title:'Search for direct flights',status:'completed'},{id:'compare',title:'Compare prices and times',status:'in_progress'},{id:'table',title:'Write the summary table',status:'pending'},{id:'check',title:'Check the final answer',status:'pending'}],explanation:'',updatedAt:new Date().toISOString()};

/**
 * Measure one bot profile. `profile` is 'default' (a new bot with standard tool groups) or 'full' (every tool group,
 * Browser, Coding and Desktop available). `loadAll` marks every on-demand group loaded; the offered list must stay the same.
 */
export async function measurePrompt({profile='default',loadAll=false,seeded=false}={}) {
  const [{Store},{NativeEngine},{TOOL_GROUPS},{estimateTokens}]=await Promise.all([load('lib/store.mjs'),load('lib/engine.mjs'),load('lib/agent-tools.mjs'),load('lib/context-budget.mjs')]);
  const directory=await mkdtemp(path.join(tmpdir(),'tupies-measure-prompt-')),store=await new Store(directory).init();
  const engine=new NativeEngine(store,{executionMode:'bounded'});
  try {
    const bot=store.state.bots[0],runId='run_measure',connection={id:'measure',type:'openai',defaultModel:'gpt-5'};
    if(profile==='full') {
      engine.browsers.available=()=>true;engine.localCoding.available=()=>true;engine.desktop.available=()=>true;engine.desktop.ready=()=>true;
      engine.desktop.config.apps=[{id:'measure_app',botIds:[bot.id]}];await engine.desktop.admit(runId,bot.id);
    }
    await store.mutate(state=>{
      state.connections.push(connection);
      const target=state.bots[0];target.connectionId=connection.id;target.model='gpt-5';if(profile==='full')target.tools=[...TOOL_GROUPS];
      state.runs[target.id]={id:runId,botId:target.id,status:'running',source:'chat',sessionId:target.id,events:[]};
      state.conversations[target.id]=[{role:'user',content:TASK,runId}];
      state.messages[target.id]=[{id:'message_measure',role:'user',content:TASK,runId,source:'chat',createdAt:new Date().toISOString()}];
      if(seeded)state.memory[target.id]=Array.from({length:8},(_,index)=>({id:`memory_${index}`,key:`fact-${index}`,value:`A short durable preference or fact number ${index} about the owner and their work.`,updatedAt:new Date().toISOString(),...(index<2?{pinned:true}:{})}));
    });
    const current=store.state.bots[0];
    const context={bot:structuredClone(current),runId,sessionId:current.id,source:'chat',lane:'chat',task:TASK,connection:structuredClone(connection),inference:{model:'gpt-5',images:false},controller:new AbortController(),recall:[],usedModelTurns:1};
    if(loadAll && typeof engine.permittedTools==='function'){const offered=engine.toolDefinitions(context).find(tool=>tool.name==='tools_load');context.loadedToolGroups=[...(offered?.parameters.properties.groups.items.enum || [])];}
    // The first step builds the system prompt (with Mission recognition offered); a later step reuses it with a plan in progress.
    const step=()=>{
      const tools=engine.toolDefinitions(context);
      const working=engine.workingContext(context,{connectionId:connection.id,provider:connection.type,model:'gpt-5'},tools);
      const system=working.messages[0].content,reference=working.messages.find(message=>String(message.content).startsWith('<reference_data>'))?.content || '';
      const parts={system,tools,reference,turnContext:working.turn};
      const measured=Object.fromEntries(Object.entries(parts).map(([key,value])=>[key,{chars:(typeof value==='string'?value:JSON.stringify(value)).length,tokens:estimateTokens(value)}]));
      const fixed=measured.system.tokens+measured.tools.tokens+measured.turnContext.tokens;
      return {toolCount:tools.length,parts:measured,fixedTokens:fixed,totalTokens:fixed+measured.reference.tokens};
    };
    const first=step();
    await store.mutate(state=>{Object.assign(state.runs[current.id],{steps:3,plan:structuredClone(PLAN)});});context.usedModelTurns=3;
    const later=step(),worst=first.fixedTokens>=later.fixedTokens?first:later;
    return {profile,loadAll,seeded,first,later,toolCount:worst.toolCount,fixedTokens:worst.fixedTokens,totalTokens:Math.max(first.totalTokens,later.totalTokens)};
  } finally {
    await engine.close();await rm(directory,{recursive:true,force:true});
  }
}

const isMain=process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(isMain) {
  const results=[];
  for(const options of [{profile:'default'},{profile:'default',seeded:true},{profile:'full'},{profile:'full',loadAll:true}])results.push(await measurePrompt(options));
  if(process.argv.includes('--json'))console.log(JSON.stringify(results,null,2));
  else for(const result of results) {
    console.log(`${result.profile}${result.seeded?' (8 memory facts)':''}${result.loadAll?' (all groups loaded)':''}: fixed ${result.fixedTokens} tokens per step at most (system + tools + turn context), ${result.totalTokens} with reference data`);
    for(const label of ['first','later']){const step=result[label];console.log(`  ${label} step: ${step.toolCount} tools, fixed ${step.fixedTokens}, with reference ${step.totalTokens}`);for(const [name,{chars,tokens}] of Object.entries(step.parts))console.log(`    ${name.padEnd(12)} ${String(chars).padStart(7)} chars  ${String(tokens).padStart(6)} tokens`);}
  }
}
