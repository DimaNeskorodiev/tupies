import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { TOOL_GROUPS } from '../lib/agent-tools.mjs';
import { CORE_TOOLS, DESCRIPTION_LIMIT, PARAMETER_DESCRIPTION_LIMIT, LOAD_GROUPS, catalogGroups, groupGuidance, loadGroupOf } from '../lib/tool-catalog.mjs';
import { measurePrompt } from '../scripts/measure-prompt.mjs';

const call=(id,name,args)=>({id,name,arguments:args});
const reference=request=>request.messages.find(message=>String(message.content).startsWith('<reference_data>'));

/** A disposable engine whose optional host adapters are reported available; nothing launches. */
async function catalogFixture(t,{tools,policy}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-tool-catalog-')),store=await new Store(directory).init();
  const engine=new NativeEngine(store,{executionMode:'bounded'});
  engine.browsers.available=()=>true;engine.localCoding.available=()=>true;engine.desktop.available=()=>true;engine.desktop.ready=()=>true;
  const bot=store.state.bots[0];
  if(tools)bot.tools=tools;if(policy)bot.approvalPolicy=policy;
  engine.desktop.config.apps=[{id:'catalog_app',botIds:[bot.id]}];await engine.desktop.admit('catalog_run',bot.id);
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const context=(overrides={})=>({bot:store.state.bots[0],source:'chat',runId:'catalog_run',sessionId:bot.id,connection:{id:'c',type:'openai'},inference:{model:'gpt-5',images:true},recall:[],...overrides});
  return {store,engine,bot,context};
}

/** Every tool any context can offer: a fully enabled bot inside and outside a Mission, with each approval policy. */
async function fullCatalog(t) {
  const all=new Map();
  for(const policy of ['auto','balanced','strict']) {
    const f=await catalogFixture(t,{tools:[...TOOL_GROUPS],policy});
    for(const mission of [false,true]) {
      f.store.state.runs[f.bot.id]={id:'catalog_run',botId:f.bot.id,status:'running',...(mission?{missionId:'catalog_mission'}:{})};
      f.store.state.missions ||= {};
      f.store.state.missions.catalog_mission={id:'catalog_mission',state:'running',leadBotId:f.bot.id,ownerEngineId:f.engine.missions.ownerEngineId,episodeRefs:[{runId:'catalog_run',botId:f.bot.id}]};
      for(const tool of f.engine.toolDefinitions({...f.context(),loadedToolGroups:LOAD_GROUPS.map(group=>group.id)}))all.set(`${tool.name}\n${tool.description}`,tool);
    }
  }
  return [...all.values()];
}

test('every tool description in the whole catalog fits 200 characters and parameter descriptions stay short',async t=>{
  const tools=await fullCatalog(t),names=new Set(tools.map(tool=>tool.name));
  assert.ok(names.size>=120,`Exercise the whole catalog: ${names.size}`);
  for(const name of ['tools_load','mission_start','mission_contract_set','browser_screenshot','browser_handoff','ask_user','coding_run','desktop_action','engine_candidate_build','routines_update','workspace_image'])assert.ok(names.has(name),name);
  const long=[];
  const visit=(schema,where)=>{
    if(!schema || typeof schema!=='object')return;
    if(Array.isArray(schema)){schema.forEach((item,index)=>visit(item,`${where}[${index}]`));return;}
    if(typeof schema.description==='string' && schema.description.length>PARAMETER_DESCRIPTION_LIMIT)long.push(`${where} (${schema.description.length})`);
    for(const [key,value] of Object.entries(schema.properties || {}))visit(value,`${where}.${key}`);
    for(const key of ['items','additionalProperties'])if(schema[key] && typeof schema[key]==='object')visit(schema[key],`${where}.${key}`);
    for(const key of ['anyOf','oneOf','allOf'])if(Array.isArray(schema[key]))visit(schema[key],`${where}.${key}`);
  };
  for(const tool of tools) {
    assert.equal(typeof tool.description,'string',tool.name);
    if(tool.description.length>DESCRIPTION_LIMIT)long.push(`${tool.name} (${tool.description.length})`);
    for(const [key,value] of Object.entries(tool.parameters?.properties || {}))visit(value,`${tool.name}.${key}`);
  }
  assert.deepEqual(long,[]);
});

test('a default bot is offered a small core set; every other permitted tool loads on demand and nothing beyond permission',async t=>{
  const f=await catalogFixture(t),context=f.context(),offered=f.engine.toolDefinitions(context),permitted=f.engine.permittedTools(context);
  const names=offered.map(tool=>tool.name),load=offered.find(tool=>tool.name==='tools_load');
  assert.ok(names.length<=16,`Core set: ${names.join(', ')}`);
  for(const name of names)assert.ok(CORE_TOOLS.has(name) || name.startsWith('mission_'),name);
  assert.deepEqual(load.parameters.properties.groups.items.enum,['files','documents','memory','skills','team','automation','setup','integrations','quality']);
  for(const name of ['shell_run','browser_open','coding_run','desktop_action','lsp_start'])assert.ok(!permitted.some(tool=>tool.name===name),name);
  // Every bot configuration: loading every available group yields exactly the permitted catalog plus tools_load.
  for(const groups of [[],['web'],['workspace'],['memory'],['workspace','terminal'],['terminal'],['delegation','automation'],[...TOOL_GROUPS]]) {
    const g=await catalogFixture(t,{tools:groups}),scoped=g.context(),allowed=new Set(g.engine.permittedTools(scoped).map(tool=>tool.name));
    const {available}=catalogGroups(g.engine.permittedTools(scoped));
    const loaded=g.engine.toolDefinitions({...scoped,loadedToolGroups:LOAD_GROUPS.map(group=>group.id)}).map(tool=>tool.name);
    for(const name of loaded)assert.ok(name==='tools_load' || allowed.has(name),`${groups.join('+')}: ${name}`);
    assert.equal(loaded.includes('tools_load'),available.length>0);
    assert.equal(new Set(loaded).size,loaded.length);
    // Language-server reads are only offered with a way to start a server.
    if(!allowed.has('lsp_start'))assert.ok(!loaded.some(name=>/^lsp_/.test(name)));
  }
  // Tools defined by other workstreams fall back to their permission group or name prefix, never to the core set.
  assert.equal(loadGroupOf('shell_run'),'terminal');assert.equal(loadGroupOf('browser_future_tool'),'browser');assert.equal(loadGroupOf('workspace_future_tool'),'files');assert.equal(loadGroupOf('unknown_future_tool'),'other');
});

test('every system prompt paragraph names only tools the bot is offered',async t=>{
  const known=[...new Set((await fullCatalog(t)).map(tool=>tool.name))];
  const mentioned=text=>known.filter(name=>new RegExp(`(^|[^a-z0-9_])${name}($|[^a-z0-9_])`).test(text));
  const configurations=[undefined,[],...TOOL_GROUPS.map(group=>[group]),['workspace','memory'],['workspace','terminal'],['delegation'],[...TOOL_GROUPS]];
  for(const tools of configurations)for(const images of [false,true])for(const source of ['chat','routine']) {
    const f=await catalogFixture(t,{tools});
    const context=f.context({inference:{model:'gpt-5',images},source,lane:source==='chat'?'chat':`routine:fixture`}),offered=f.engine.toolDefinitions(context);
    const names=new Set(offered.map(tool=>tool.name)),system=f.engine.instructions(f.bot,context,offered);
    const outside=mentioned(system).filter(name=>!names.has(name));
    assert.deepEqual(outside,[],`${JSON.stringify(tools)} images=${images} ${source}`);
    // Guidance for an available group arrives with tools_load and mentions only tools this bot is permitted to call.
    const permitted=new Set(f.engine.permittedTools(context).map(tool=>tool.name));
    for(const id of catalogGroups(f.engine.permittedTools(context)).available) {
      const text=groupGuidance(id,permitted);
      for(const name of mentioned(text))assert.ok(permitted.has(name),`${id} guidance names ${name} for ${JSON.stringify(tools)}`);
    }
  }
});

test('the default bot fixed per-step payload is at most 8K estimated tokens; a fully enabled bot stays within it until it loads groups',async t=>{
  const fresh=await measurePrompt({profile:'default'}),seeded=await measurePrompt({profile:'default',seeded:true}),full=await measurePrompt({profile:'full'}),all=await measurePrompt({profile:'full',loadAll:true});
  for(const result of [fresh,seeded,full,all])t.diagnostic(`${result.profile}${result.seeded?' seeded':''}${result.loadAll?' all groups':''}: ${result.toolCount} tools, fixed ${result.fixedTokens} tokens (system ${result.first.parts.system.tokens}, tools ${result.first.parts.tools.tokens}, turn ${result.later.parts.turnContext.tokens}), reference ${result.first.parts.reference.tokens}`);
  assert.ok(fresh.fixedTokens<=8000,`default: ${fresh.fixedTokens}`);assert.ok(seeded.fixedTokens<=8000,`seeded: ${seeded.fixedTokens}`);assert.ok(full.fixedTokens<=8000,`full: ${full.fixedTokens}`);
  for(const result of [fresh,seeded,full])for(const step of [result.first,result.later])assert.ok(step.parts.turnContext.tokens<=500,`turn context: ${step.parts.turnContext.tokens}`);
  // Seeded memory lives in the cached reference data, not in the system prompt or per-step turn context.
  assert.equal(seeded.first.parts.system.chars,fresh.first.parts.system.chars);assert.equal(seeded.later.parts.turnContext.chars,fresh.later.parts.turnContext.chars);
  assert.ok(seeded.first.parts.reference.tokens>fresh.first.parts.reference.tokens);
  assert.ok(all.toolCount>100 && all.toolCount<=128,`all groups: ${all.toolCount}`);
});

test('tools_load adds permitted groups for later steps, refuses others, keeps the prefix stable and auto-loads on a direct call',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-tools-load-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'fixture',type:'openai',defaultModel:'fixture-model'});for(const bot of state.bots){bot.connectionId='fixture';bot.approvalPolicy='balanced';}});
  const result=(request,id)=>JSON.parse(request.messages.findLast(message=>message.tool_call_id===id).content);
  const steps=[
    ()=>({text:'',toolCalls:[call('load','tools_load',{groups:['files']})]}),
    request=>{const loaded=result(request,'load');assert.deepEqual(loaded.loaded,['files']);assert.ok(loaded.tools.includes('workspace_glob'));assert.match(loaded.guidance.files,/expectedSha256/);return {text:'',toolCalls:[call('denied','tools_load',{groups:['terminal']})]};},
    request=>{assert.match(result(request,'denied').error,/Not available to this bot: terminal/);return {text:'',toolCalls:[call('glob','workspace_glob',{pattern:'**/*.md'})]};},
    ()=>({text:'',toolCalls:[call('notes','brain_search',{query:'launch'})]}),
    request=>{assert.equal(Array.isArray(result(request,'notes').results),true);return {text:'',toolCalls:[call('plan','task_plan_set',{steps:[{id:'done',title:'Report',status:'completed'}]})]};},
    ()=>({text:'Loaded what was needed.',toolCalls:[]}),
  ];
  const engine=new NativeEngine(store,{runTimeout:10_000,executionMode:'bounded',providers:{async complete(_connection,request){requests.push(request);return steps[requests.length-1](request);}}});
  await engine.recover();t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const started=await engine.start('bot_atlas','Find the launch notes.');await engine.tasks.get(started.id);
  const run=store.state.runs.bot_atlas;assert.equal(run.status,'completed',run.error);assert.equal(requests.length,6);
  const names=request=>request.tools.map(tool=>tool.name);
  assert.ok(!names(requests[0]).includes('workspace_glob'));assert.ok(names(requests[1]).includes('workspace_glob'));assert.ok(!names(requests[1]).includes('shell_run'));
  // The system prompt and reference data never change within the task; loaded groups append to the tool list.
  for(const request of requests){assert.equal(request.messages[0].content,requests[0].messages[0].content);assert.deepEqual(reference(request),reference(requests[0]));}
  assert.deepEqual(requests[2].tools,requests[1].tools,'a refused load leaves the catalog unchanged');
  assert.deepEqual(requests[4].tools.slice(0,requests[1].tools.length),requests[1].tools);assert.ok(names(requests[4]).includes('brain_search'));
  // A direct call to a permitted tool loads its group, and its guidance appears in exactly one turn context.
  assert.match(requests[4].turnContext,/Tools loaded by your last call[\s\S]*brain_search first/);assert.doesNotMatch(requests[5].turnContext,/Tools loaded by your last call/);
  assert.deepEqual(run.loadedToolGroups,['files','memory']);
  const loads=run.events.filter(event=>event.type==='tools.loaded');
  assert.deepEqual(loads.map(event=>[event.groups,event.reason]),[[['files'],'requested'],[['memory'],'called']]);assert.equal(loads[1].tool,'brain_search');
  // A resumed context restores the loaded groups from the run.
  const resumed={bot:store.state.bots[0],source:'chat',runId:run.id,connection:store.state.connections[0],inference:{model:'fixture-model'}};
  assert.ok(engine.toolDefinitions(resumed).some(tool=>tool.name==='brain_search'));
});
