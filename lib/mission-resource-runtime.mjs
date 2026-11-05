import { checkMissionEffort, missionEffortSummary } from './mission-effort.mjs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ensure, id } from './store.mjs';
import { safeContextWindow, estimateTokens } from './context-budget.mjs';
import { groupsFor, TOOL_GROUPS } from './agent-tools.mjs';
import { missionSuspension } from './mission-waits.mjs';
import { routineConnectionIdentity, routineBotIdentity } from './routine-checkpoints.mjs';
import { createMissionResources, reserveMissionResources, markMissionResourceDispatch, assertMissionResourceDispatch, releaseMissionReservation, settleMissionResources, unknownMissionResources, estimateMissionInference, missionInferenceUsage, missionResourceReadiness } from './mission-resources.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const allZero=()=>({tokens:0,moneyMicros:0,requests:0,toolCalls:0,computeMs:0});
const localTools=new Set(['workspace_structure','workspace_initialize','workspace_list','workspace_read','workspace_glob','workspace_search','workspace_write','workspace_edit','workspace_image','documents_create','documents_read','memory_get','memory_set','memory_delete','memory_search','memory_refresh','brain_search','brain_read','brain_write','brain_link','skills_list','skills_read','skills_file','skills_create','skills_propose','task_plan_set','task_status','task_outcome_set','tool_result_read','session_search','session_read','routines_list','bots_list','bot_inspect','mission_start','mission_status','mission_contract_set','mission_submit_result','mission_request_completion','mission_approach_set','mission_approach_search','mission_approach_read','mission_search','mission_read','mission_wait','ask_user','browser_handoff','delegation_status','shell_list','shell_read','shell_stop','lsp_list','lsp_stop']);
// These tools may spend via independently admitted descendants; the outer call has no own provider/network dispatch.
const nestedTools=new Set(['delegate_task']);
const documentTools=new Set(['documents_create','documents_read']);

/** Engine adapter only. Callbacks/resolvers are installed by source, never supplied by model arguments. */
export class MissionResourceRuntime {
  constructor(engine,{priceFor=()=>undefined,clock=()=>Date.now(),monotonic=()=>performance.now()}={}) {this.engine=engine;this.store=engine.store;this.priceFor=priceFor;this.clock=clock;this.monotonic=monotonic;}
  sample(context){const at=this.monotonic();return {at,wait:(context.resourceWaitMs || 0)+(Number.isFinite(context.resourceWaitStartedAt)?Math.max(0,at-context.resourceWaitStartedAt):0)};}
  elapsed(context,started){const finished=this.sample(context);return Math.max(0,Math.ceil(finished.at-started.at-(finished.wait-started.wait)));}
  failedUsage(operation,computeMs){const actual={computeMs,toolCalls:operation.estimate.toolCalls || 0};for(const key of ['tokens','moneyMicros','requests'])if(operation.estimate[key]===0 && !operation.unboundedDimensions?.includes(key) && !operation.unavailableDimensions?.includes(key) && (key!=='moneyMicros' || operation.pricing?.status==='known'))actual[key]=0;return {actual,unknownDimensions:[],moneyBasis:'unknown'};}
  mission(context){const run=this.engine.current(context);return run?.missionId?this.engine.missions.get(run.missionId):null;}
  gate(context,expected){
    this.engine.assertRunning(context);const run=this.engine.current(context),mission=this.mission(context);
    ensure(mission && mission.id===expected.id && mission.contractVersion===expected.contractVersion,409,'The Mission contract or execution owner changed before resource dispatch.');
    ensure(run.missionContractVersion===undefined || run.missionContractVersion===mission.contractVersion,409,'This participant has a stale Mission contract.');
    if(mission.pauseRequested || ['pausing','paused'].includes(mission.state) || context.missionWaitReady || this.engine.shouldSuspendMission?.(context))throw missionSuspension();
    ensure(!mission.stopRequested && mission.state!=='terminal',409,'This Mission has ended.');
    return mission;
  }
  async change(missionId,action){return this.store.mutate(()=>{const mission=this.engine.missions.get(missionId);const result=action(mission);this.engine.missions.touch(mission);return result;},{local:true});}
  async priceSnapshot(context,connection,model){
    const connectionIdentity=routineConnectionIdentity(connection),key=hash({connectionId:connection.id,connectionIdentity,model});
    const existing=this.engine.current(context)?.missionPricing?.[key];if(existing)return structuredClone(existing);
    return this.store.mutate(()=>{
      const run=this.engine.current(context);ensure(run,409,'The inference run changed before its price snapshot.');
      if(run.missionPricing?.[key])return structuredClone(run.missionPricing[key]);
      const selected=connection.type==='chatgpt'?undefined:this.priceFor(connection,model);
      const {pricing}=estimateMissionInference({model,inputTokens:0,outputTokens:0,price:selected,subscription:connection.type==='chatgpt',enforcedOutput:true});
      const snapshot={...pricing,connectionId:connection.id,connectionIdentity};(run.missionPricing ||= {})[key]=snapshot;return structuredClone(snapshot);
    },{local:true});
  }
  /** Ordinary work gets a durable observation, not a resource limit or a replay grant. */
  async observe(context,operation,invoke,usage){
    if(!this.engine.current(context))return invoke({signal:context.controller.signal});
    const operationId=id('ordinary_resource'),identity={...operation,operationId,botId:context.bot.id,runId:context.runId};
    const target=()=>{const run=this.engine.current(context);if(!run)return null;const mission=this.mission(context);if(mission){ensure(mission.resourceLedger?.operations[operationId],409,'The promoted Mission did not retain its in-flight resource observation.');return {ledger:mission.resourceLedger,mission};}return {ledger:run.resourceJournal};};
    await this.store.mutate(()=>{this.engine.assertRunning(context);const run=this.engine.current(context);run.resourceJournal ||= createMissionResources({now:this.clock()});reserveMissionResources(run.resourceJournal,identity,{now:this.clock()});markMissionResourceDispatch(run.resourceJournal,identity,{now:this.clock()});},{local:true});
    const recheck=()=>{const current=target();if(current?.mission){this.gate(context,{id:current.mission.id,contractVersion:current.mission.contractVersion});assertMissionResourceDispatch(current.ledger,identity,{now:this.clock()});}};
    let started;
    try {
      recheck();started=this.sample(context);const result=await invoke({signal:context.controller.signal,recheck});
      const measured=this.elapsed(context,started),record=usage(result,measured);
      await this.store.mutate(()=>{const current=target();if(!current)return;settleMissionResources(current.ledger,{operationId,requestDigest:operation.requestDigest,...record,receiptDigest:hash({operationId,result:result ?? null,record})},{now:this.clock()});if(current.mission)this.engine.missions.touch(current.mission);},{local:true});
      return result;
    }catch(error){
      await this.store.mutate(()=>{const current=target();if(!current || current.ledger.operations[operationId]?.status!=='reserved')return;if(started){const record=this.failedUsage(operation,this.elapsed(context,started));settleMissionResources(current.ledger,{operationId,requestDigest:operation.requestDigest,...record,receiptDigest:hash({operationId,outcome:'failed_usage_observed',record})},{now:this.clock()});}else unknownMissionResources(current.ledger,{operationId,requestDigest:operation.requestDigest,reason:'ordinary_dispatch_usage_unknown'},{now:this.clock()});if(current.mission)this.engine.missions.touch(current.mission);},{local:true}).catch(()=>{});
      throw error;
    }
  }
  async execute(context,operation,invoke,usage){
    const initial=this.mission(context);if(!initial)return this.observe(context,operation,invoke,usage);
    const expected={id:initial.id,contractVersion:initial.contractVersion},operationId=operation.operationId || id('mission_resource');
    const identity={...operation,operationId,botId:context.bot.id,runId:context.runId};
    let reserved=false,dispatched=false,signal=context.controller.signal,started;
    try {
      await this.change(expected.id,mission=>{this.gate(context,expected);operation.assertIdentity?.();mission.resourceLedger ||= createMissionResources({now:this.clock()});checkMissionEffort(mission,operation.effort,operation.effortScope);const result=reserveMissionResources(mission.resourceLedger,identity,{now:this.clock()});ensure(result.admitted,409,'This exact resource operation already has a receipt and cannot dispatch again.');reserved=true;});
      await this.change(expected.id,mission=>{this.gate(context,expected);operation.assertIdentity?.();checkMissionEffort(mission,{}, {...operation.effortScope,tool:undefined});const result=markMissionResourceDispatch(mission.resourceLedger,identity,{now:this.clock()});ensure(result.admitted,409,'This exact resource operation was already dispatched.');});
      dispatched=true;
      // No await separates this current-state recheck from invoking the actual adapter.
      this.gate(context,expected);operation.assertIdentity?.();
      const current=this.engine.missions.get(expected.id),deadline=current.resourceLedger.limits.deadlineAt;
      const duration=Math.min(current.resourceLedger.limits.computeMs===undefined?Infinity:operation.timeoutMs ?? Infinity,deadline===undefined?Infinity:Math.max(1,deadline-this.clock()));
      if(Number.isFinite(duration))signal=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.min(2_147_483_647,Math.ceil(duration))))]);
      const recheck=()=>{const mission=this.gate(context,expected);operation.assertIdentity?.();return assertMissionResourceDispatch(mission.resourceLedger,identity,{now:this.clock()});};
      started=this.sample(context);const result=await invoke({signal,recheck});
      const measured=this.elapsed(context,started),record=usage(result,measured);
      await this.change(expected.id,mission=>settleMissionResources(mission.resourceLedger,{operationId,requestDigest:operation.requestDigest,...record,receiptDigest:hash({operationId,result:result ?? null,record})},{now:this.clock()}));
      if(signal.aborted)throw signal.reason;
      return result;
    } catch(error) {
      if(error.code==='mission_effort_closing')await this.change(expected.id,mission=>{mission.effort.finishing=true;});
      if(reserved)await this.change(expected.id,mission=>{const saved=mission.resourceLedger.operations[operationId];if(saved?.status!=='reserved')return;if(started){const record=this.failedUsage(operation,this.elapsed(context,started));settleMissionResources(mission.resourceLedger,{operationId,requestDigest:operation.requestDigest,...record,receiptDigest:hash({operationId,outcome:'failed_usage_observed',record})},{now:this.clock()});}else if(dispatched || saved.dispatchedAt!==undefined)unknownMissionResources(mission.resourceLedger,{operationId,requestDigest:operation.requestDigest,reason:'dispatch_outcome_or_usage_unknown'},{now:this.clock()});else releaseMissionReservation(mission.resourceLedger,{operationId,requestDigest:operation.requestDigest},{now:this.clock()});}).catch(()=>{});
      const deadline=this.engine.missions.get(expected.id).resourceLedger?.limits.deadlineAt;
      if(deadline!==undefined && this.clock()>=deadline && !context.controller.signal.aborted)throw Object.assign(new Error('The Mission deadline expired during the admitted operation.'),{code:'mission_expired',dimension:'deadlineAt',reason:'deadline',status:409,cause:error});
      throw error;
    }
  }
  async infer(context,connection,request,{kind='model',phase='work',providerMethod='complete'}={}) {
    ensure(['complete','reviewMemory','reviewSkill','reviewAction'].includes(providerMethod),400,'Use a supported internal inference method.');
    const invoke=request=>this.engine.providers[providerMethod](connection,request);
    const mission=this.mission(context);
    const assertIdentity=()=>{const current=Array.isArray(this.store.state.connections)?this.store.state.connections.find(row=>row.id===connection.id):this.engine.providers.current?.(connection);if((Array.isArray(this.store.state.connections) && !current) || current && routineConnectionIdentity(current)!==routineConnectionIdentity(connection))throw Object.assign(new Error('The provider identity or destination changed before Mission resource dispatch. Start a new owner-approved attempt with the current connection.'),{code:'mission_resource_unavailable',reason:'provider_changed',status:409});if(connection.type==='chatgpt' && this.mission(context)?.resourceLedger?.limits.requests!==undefined)throw Object.assign(new Error('ChatGPT credential renewal can perform additional metadata, token or home-server requests. This adapter cannot enforce the configured API-request limit.'),{code:'mission_resource_unavailable',dimension:'requests',reason:'oauth_renewal_fanout',status:409});};
    const model=request.model || context.inference?.model || connection.defaultModel,entry=connection.models?.find(row=>row.id===model),catalogWindow=entry && [undefined,'provider','provider-error'].includes(entry.contextSource)?safeContextWindow(entry.contextWindow):null;
    const knownInput=!!catalogWindow,inputTokens=catalogWindow || estimateTokens({messages:request.messages,tools:request.tools,turnContext:request.turnContext});
    const outputTokens=Math.min(connection.maxOutputTokens || 4096,request.maxOutputTokens || Infinity),enforcedOutput=['openai','anthropic'].includes(connection.type);
    const pinned=await this.priceSnapshot(context,connection,model);
    const prepared=estimateMissionInference({model,inputTokens,outputTokens,price:pinned.status==='known'?pinned.schedule:undefined,subscription:pinned.status==='subscription',enforcedOutput});
    if(connection.type==='anthropic' && pinned.status==='known' && (pinned.schedule.cachedInputMicrosPerMillion===undefined || pinned.schedule.cacheCreationMicrosPerMillion===undefined))prepared.unboundedDimensions=[...new Set([...prepared.unboundedDimensions,'moneyMicros'])];
    if(connection.type==='chatgpt')prepared.unavailableDimensions=['requests'];
    if(!knownInput)prepared.unboundedDimensions=[...new Set([...prepared.unboundedDimensions,'tokens','moneyMicros'])];
    if(!mission)prepared.unboundedDimensions=[...new Set([...prepared.unboundedDimensions,'tokens','moneyMicros'])];
    const timeoutMs=Math.min(request.timeoutMs ?? Infinity,this.engine.providers.options?.inferenceTimeout || 1_800_000);
    const effort={modelCalls:1,estimatedTokens:estimateTokens({messages:request.messages,tools:request.tools,turnContext:request.turnContext})+outputTokens},coordinator=mission?.leadBotId===context.bot.id && !context.delegation?.depth;
    const effortScope={coordinator,phase:phase==='verification'?'verification':kind==='model' && coordinator && missionEffortSummary(mission)?.finishing?'closure':'work'};
    const operation={...prepared,kind,phase,effort,effortScope,assertIdentity,estimate:{...allZero(),...prepared.estimate,computeMs:timeoutMs},requestDigest:hash({connectionId:connection.id,type:connection.type,model,messages:request.messages,tools:request.tools,turnContext:request.turnContext,reasoningEffort:request.reasoningEffort,maxOutputTokens:outputTokens}),timeoutMs};
    return this.execute(context,operation,({signal})=>mission?invoke({...request,model,maxOutputTokens:outputTokens,signal:request.signal?AbortSignal.any([request.signal,signal]):signal,timeoutMs:Math.min(request.timeoutMs ?? Infinity,timeoutMs)}):invoke(request),(result,computeMs)=>{
      const record=missionInferenceUsage(result.usage || {},{protocol:connection.type==='anthropic'?'anthropic':'openai',pricing:prepared.pricing});
      if(connection.type==='chatgpt'){delete record.actual.requests;record.unknownDimensions=[...new Set([...record.unknownDimensions,'requests'])];}
      return {...record,actual:{...record.actual,toolCalls:0,computeMs}};
    });
  }
  toolFacts(call,context){
    const local=localTools.has(call.name),nested=nestedTools.has(call.name),document=documentTools.has(call.name);
    // integration_list discovers remote MCP tools in this codebase; it is not a local zero-request read.
    const remote=call.name==='integration_list' || !local && !nested;
    const ownerWait=call.name==='documents_create' && context && this.engine.tools?.requiresApproval?.(call.name,context.bot,call.arguments || {});
    return {effort:{toolCalls:1,...(call.name==='delegate_task'?{delegations:1}:{})},estimate:{...allZero(),toolCalls:1,...(document?{computeMs:25_000}:{})},pricing:{status:remote?'unknown':'known'},unavailableDimensions:[...(remote?['requests','tokens','moneyMicros']:[]),...(!document || ownerWait?['computeMs']:[])],...(document?{timeoutMs:25_000}:{})};
  }
  readiness(context,call,{missionId}={}){
    const mission=missionId?this.engine.missions.get(missionId):this.mission(context),facts=this.toolFacts(call,context),bot=this.store.state.bots?.find(row=>row.id===(mission?.leadBotId || context.bot.id)) || context.bot;
    if(mission?.botIdentity && routineBotIdentity(bot)!==mission.botIdentity)return {available:false,status:'needs_access',reason:'The coordinator or its saved access changed. Review the current Mission before another attempt.'};
    if(bot.enabled===false)return {available:false,status:'needs_access',reason:'The coordinator is disabled.'};
    if(this.engine.tools?.definitions){
      const available=this.engine.tools.definitions(bot).some(row=>row.name===call.name),catalog=this.engine.tools.definitions({...bot,tools:TOOL_GROUPS}).some(row=>row.name===call.name);
      if(call.name.startsWith('browser_')){if(!this.engine.browsers?.available?.())return {available:false,status:'missing_tool',reason:'The execution engine has no available Browser adapter.'};if(!groupsFor(bot).includes('browser') || context.bot.tools && !groupsFor(context.bot).includes('browser'))return {available:false,status:'needs_access',reason:'Current and saved Browser access are required.'};}
      else if(catalog && (!available || context.bot.tools && !this.engine.tools.definitions(context.bot).some(row=>row.name===call.name)))return {available:false,status:'needs_access',reason:'Current and saved tool access are required.'};
      else if(!catalog && !localTools.has(call.name) && !nestedTools.has(call.name))return {available:false,status:'missing_tool',reason:'No supported tool is installed for this name.'};
    }
    return missionResourceReadiness({tool:call.name,limits:mission?.resourceLedger?.limits || {},unavailableDimensions:facts.unavailableDimensions,pricing:facts.pricing});
  }
  async tool(context,call,invoke){
    const facts=this.toolFacts(call,context),mission=this.mission(context),coordinator=mission?.leadBotId===context.bot.id && !context.delegation?.depth,operation={...facts,effortScope:{tool:call.name,coordinator,phase:coordinator && missionEffortSummary(mission)?.finishing?'closure':'work'},kind:`tool:${call.name}`,operationId:`tool:${context.runId}:${call.id}`,requestDigest:hash({id:call.id,name:call.name,arguments:call.arguments})};
    return this.execute(context,operation,invoke,(result,computeMs)=>({actual:{...allZero(),toolCalls:1,computeMs},unknownDimensions:facts.unavailableDimensions.filter(key=>['requests','tokens','moneyMicros'].includes(key)),moneyBasis:facts.pricing.status==='known'?'estimated':'unknown'}));
  }
}
