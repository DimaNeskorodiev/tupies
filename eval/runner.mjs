import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { NativeEngine, isActive } from '../lib/engine.mjs';
import { Providers } from '../lib/providers.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { CASES, CORPUS_VERSION } from './scenarios.mjs';
import { homeSubscriptionGrantReader, subscriptionProvider } from './subscription-provider.mjs';
import { collectSyntheticCaseOutput } from './case-output.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class EvaluationBudgetError extends Error {constructor(resource){super(`Evaluation ${resource} budget reached.`);this.name='EvaluationBudgetError';this.resource=resource;}}
const positive=(value,name,maximum)=>{if(!Number.isFinite(value) || value<=0 || value>maximum)throw new Error(`Use a positive ${name} no greater than ${maximum}.`);return value;};
export function evaluationOptions(options={}) {
  const mode=options.mode || 'fixture';if(!['fixture','live'].includes(mode))throw new Error('Mode must be fixture or live.');
  const normalized={mode,repeat:options.repeat ?? 1,maxInferences:options.maxInferences ?? 16,maxTools:options.maxTools ?? 40,maxMs:options.maxMs ?? (mode==='live'?120_000:20_000),maxTokens:options.maxTokens ?? 1_000_000,maxOutputTokens:options.maxOutputTokens ?? 2048,maxCost:options.maxCost ?? 2,inputPrice:options.inputPrice ?? null,outputPrice:options.outputPrice ?? null,cases:options.cases || CASES.map(item=>item.id),provider:options.provider || '',model:options.model || '',imageInput:options.imageInput || 'auto',baseUrl:options.baseUrl || '',authorizedSubscription:options.authorizedSubscription===true,subscriptionSource:options.subscriptionSource || '',subscriptionConnection:options.subscriptionConnection || ''};
  positive(normalized.repeat,'repetitions',10);positive(normalized.maxInferences,'inference calls per case',100);positive(normalized.maxTools,'tool calls per case',100);positive(normalized.maxMs,'milliseconds per case',600_000);positive(normalized.maxTokens,'suite token allowance',10_000_000);positive(normalized.maxOutputTokens,'output tokens per request',32768);positive(normalized.maxCost,'suite cost allowance',100);
  for(const field of ['repeat','maxInferences','maxTools','maxMs','maxTokens','maxOutputTokens'])if(!Number.isInteger(normalized[field]))throw new Error(`${field} must be an integer.`);
  if(normalized.maxOutputTokens<256)throw new Error('Output token allowance must be at least 256.');
  if(!Array.isArray(normalized.cases) || !normalized.cases.length || normalized.cases.some(id=>!CASES.some(item=>item.id===id)))throw new Error('Select known case IDs; use --list.');
  if(typeof normalized.model!=='string' || normalized.model.length>200 || /[\x00-\x1f\x7f]/.test(normalized.model))throw new Error('Use a model identifier of at most 200 characters.');
  if(!['auto','on','off'].includes(normalized.imageInput))throw new Error('Use image input auto, on or off.');
  if(mode==='live') {
    if(!['openai','anthropic','xai','openrouter','ollama','custom','chatgpt'].includes(normalized.provider) || !normalized.model.trim())throw new Error('Live mode requires an explicit provider and model.');
    if(normalized.provider==='chatgpt') {
      if(!normalized.authorizedSubscription)throw new Error('Live subscription evaluation requires explicit --authorized-subscription.');
      if(normalized.baseUrl)throw new Error('Live subscription evaluation uses only the official endpoint; omit --base-url.');
      normalized.inputPrice=null;normalized.outputPrice=null;
    } else for(const field of ['inputPrice','outputPrice'])if(!Number.isFinite(normalized[field]) || normalized[field]<0)throw new Error('Live mode requires explicit input/output USD prices per million tokens (0 for a free local model).');
  }
  return normalized;
}

/** Admission checks happen before provider dispatch, including summary requests. Unknown usage is charged against the conservative reservation. */
export class EvaluationBudget {
  constructor(options){this.options=options;this.calls=0;this.settledCalls=0;this.tokens=0;this.cost=0;this.reportedInput=0;this.reportedOutput=0;this.reportedCache=0;this.usageComplete=true;this.cacheKnown=false;this.cacheComplete=true;this.exhausted=null;}
  reserve(request,caseCalls) {
    const input=Buffer.byteLength(JSON.stringify({messages:request.messages,turnContext:request.turnContext,tools:request.tools}))+2048,output=this.options.maxOutputTokens;
    const tokens=input+output,cost=this.options.mode==='live'&&this.options.provider!=='chatgpt'?(input*this.options.inputPrice+output*this.options.outputPrice)/1_000_000:0;
    const resource=caseCalls>=this.options.maxInferences?'inference':this.tokens+tokens>this.options.maxTokens?'token':this.cost+cost>this.options.maxCost?'cost':null;
    if(resource){this.exhausted=resource;throw new EvaluationBudgetError(resource);}
    this.calls++;this.tokens+=tokens;this.cost+=cost;
    return {input,output,tokens,cost};
  }
  settle(reservation,usage={}) {
    this.settledCalls++;
    const input=usage.input_tokens ?? usage.prompt_tokens,output=usage.output_tokens ?? usage.completion_tokens;
    const valid=Number.isFinite(input) && input>=0 && Number.isFinite(output) && output>=0;
    this.usageComplete &&= valid;
    if(valid) {
      this.reportedInput+=input;this.reportedOutput+=output;
      this.tokens+=input+output-reservation.tokens;
      if(this.options.mode==='live'&&this.options.provider!=='chatgpt')this.cost+=(input*this.options.inputPrice+output*this.options.outputPrice)/1_000_000-reservation.cost;
    }
    const cache=usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens;
    this.cacheComplete &&= Number.isFinite(cache) && cache>=0;
    if(Number.isFinite(cache) && cache>=0){this.reportedCache+=cache;this.cacheKnown=true;}
    if(this.tokens>=this.options.maxTokens)this.exhausted='token';if(this.cost>=this.options.maxCost)this.exhausted='cost';
  }
  metrics(){const complete=this.usageComplete && this.settledCalls===this.calls,billed=this.options.mode==='live'&&this.options.provider!=='chatgpt';return {usageSource:this.options.mode==='fixture'?'scripted-fixture':'provider-report-or-admission-reservation',inferences:this.calls,admissionTokens:this.tokens,reportedInputTokens:complete?this.reportedInput:null,reportedOutputTokens:complete?this.reportedOutput:null,reportedCacheTokens:this.cacheKnown && this.cacheComplete && this.settledCalls===this.calls?this.reportedCache:null,reportedCostUsd:billed && complete?this.cost:null,costReservationUsd:billed?this.cost:null,usageReportingCoverage:{dispatched:this.calls,returned:this.settledCalls,complete},exhausted:this.exhausted};}
}

export function check(name,passed,detail='',metric){return {name,passed:Boolean(passed),...(detail?{detail}:{} ),...(metric?{metric}:{})};}
export function grade(checks,{capabilityGap=false,budgetReached=false}={}) {
  if(budgetReached)return 'budget_exhausted';
  if(checks.some(item=>item.passed===false))return 'failed';
  if(capabilityGap)return 'capability_gap';
  return checks.length && checks.every(item=>item.passed)?'passed':'failed';
}
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;return n?n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2:null;};
export function qualityMetrics(results) {
  const measuredChecks=item=>(item.checks || []).filter(check=>['goal','retention','source','privacy','duplicate'].includes(check.metric));
  const measured=results.filter(item=>item.taskOutcome && ['completed','failed','cancelled','interrupted','unknown'].includes(item.taskOutcome.actual) && (item.taskOutcome.expected!=='completed' || measuredChecks(item).length));
  const completions=measured.filter(item=>item.taskOutcome.actual==='completed');
  const falseSuccess=completions.filter(item=>item.taskOutcome.expected!=='completed' || measuredChecks(item).some(check=>!check.passed));
  const normal=measured.filter(item=>item.taskOutcome.expected==='completed');
  const fraction=(count,denominator)=>({count,denominator,rate:denominator?count/denominator:null});
  const checksFor=metric=>results.flatMap(item=>item.checks || []).filter(check=>check.metric===metric);
  const accuracy=metric=>{const checks=checksFor(metric);return fraction(checks.filter(check=>check.passed).length,checks.length);};
  const violations=metric=>{const checks=checksFor(metric);return fraction(checks.filter(check=>!check.passed).length,checks.length);};
  return {verifiedCompletion:fraction(normal.filter(item=>item.taskOutcome.actual==='completed' && measuredChecks(item).every(check=>check.passed)).length,normal.length),falseSuccess:fraction(falseSuccess.length,completions.length),exactConstraintRetention:accuracy('retention'),sourceCorrectness:accuracy('source'),unauthorizedChanges:violations('privacy'),duplicateEffects:violations('duplicate'),humanInterventions:{count:null,measuredRuns:0,totalRuns:results.length},notice:'Finite independent fixture checks only. Unknown or unmeasured categories have a zero denominator/null rate; automated control responses are not human interventions.'};
}
export function repeatStatistics(results) {
  return [...new Set(results.map(item=>item.id))].map(id=>{const rows=results.filter(item=>item.id===id),values=rows.map(item=>item.elapsedMs),mean=values.reduce((sum,value)=>sum+value,0)/Math.max(1,values.length);return {id,samples:rows.length,elapsedMs:values,medianMs:median(values),minMs:values.length?Math.min(...values):null,maxMs:values.length?Math.max(...values):null,populationStdDevMs:values.length?Math.sqrt(values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length):null,statuses:rows.map(item=>item.status)};});
}
export async function createHarness(definition,options,budget,{subscriptionGrantReader}={}) {
  const deadlineAt=Date.now()+options.maxMs,controller=new AbortController(),timer=setTimeout(()=>controller.abort(new EvaluationBudgetError('time')),options.maxMs);
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-evaluation-'));
  let engine,actualProviders;
  try {
  const store=await new Store(directory).init();
  const subscription=options.mode==='live'&&options.provider==='chatgpt'?await subscriptionProvider(store,{readGrant:subscriptionGrantReader,authorized:options.authorizedSubscription,model:options.model,imageInput:options.imageInput,maxOutputTokens:options.maxOutputTokens,requestTimeout:Math.min(options.maxMs,120_000),signal:controller.signal}):null;
  actualProviders=subscription?.providers || (options.mode==='live'?new Providers(store,{allowPrivateHttp:false,requestTimeout:Math.min(options.maxMs,120_000)}):null);
  let calls=0,toolCalls=0,blocked=false,oracle=null;const usageRecords=[],retentionRunIds=new Set();
  const connection=subscription?.connection || (options.mode==='live'?actualProviders.validate({type:options.provider,name:'Evaluation provider',defaultModel:options.model,imageInput:options.imageInput,...(options.baseUrl?{baseUrl:options.baseUrl}:{}),maxOutputTokens:options.maxOutputTokens,apiKey:process.env.STUDIO_EVAL_API_KEY || ''}):{type:'custom',name:'Scripted fixture',defaultModel:'scripted-fixture',imageInput:'on',maxOutputTokens:options.maxOutputTokens});
  connection.id='eval_provider';
  await store.mutate(state=>{
    state.connections=[connection];state.settings={timezone:'UTC'};
    for(const bot of state.bots){bot.connectionId=connection.id;bot.model=connection.defaultModel;bot.skills=[];bot.tools=['workspace','memory','delegation'];bot.approvalPolicy='balanced';bot.teamMode='all';bot.maxSteps=50;}
  });
  let harness;
  const providers={async complete(current,request) {
    if(controller.signal.aborted)throw controller.signal.reason;
    if(Date.now()>=deadlineAt)throw new EvaluationBudgetError('time');
    request={...request,signal:request.signal?AbortSignal.any([request.signal,controller.signal]):controller.signal};
    if(blocked)throw new EvaluationBudgetError('inference');
    const reservation=budget.reserve(request,calls);calls++;
    harness.offeredTools=new Set((request.tools || []).map(tool=>tool.name));
    for(const image of request.messages.flatMap(message=>message.imageParts || []))if(harness.imageParts.length<5 && !harness.imageParts.some(item=>item.data===image.data))harness.imageParts.push(image);
    try {
      const result=options.mode==='fixture'?await definition.script(request,harness):await actualProviders.complete(current,request);
      const returnedCalls=Array.isArray(result.toolCalls)?result.toolCalls.length:0;
      if(toolCalls+returnedCalls>options.maxTools){blocked=true;budget.exhausted='tool';throw new EvaluationBudgetError('tool');}
      await definition.beforeToolCalls?.(harness,result.toolCalls || []);
      toolCalls+=returnedCalls;budget.settle(reservation,result.usage);usageRecords.push(result.usage || {});
      return result;
    } catch(error){usageRecords.push(null);if(error instanceof EvaluationBudgetError)blocked=true;throw error;}
  }};
  engine=new NativeEngine(store,{providers,runTimeout:options.maxMs,summaryTimeout:Math.min(options.maxMs,20_000),publicFetch:async()=>{throw new Error('Evaluation fixtures have no public web transport.');}});
  await engine.recover();
  const checkDeadline=()=>{if(controller.signal.aborted)throw controller.signal.reason;if(Date.now()>=deadlineAt)throw new EvaluationBudgetError('time');};
  const oracleUnchanged=async()=>{try{return Boolean(oracle && hash(await fs.readFile(oracle.path))===oracle.sha256);}catch{return false;}};
  const sameCommand=args=>Boolean(oracle && JSON.stringify(canonical(args))===JSON.stringify(canonical(oracle.command)));
  const caseUsage=()=>{
    const number=(record,key,other)=>record?.[key] ?? record?.[other],valid=usageRecords.every(record=>Number.isFinite(number(record,'input_tokens','prompt_tokens')) && number(record,'input_tokens','prompt_tokens')>=0 && Number.isFinite(number(record,'output_tokens','completion_tokens')) && number(record,'output_tokens','completion_tokens')>=0);
    const input=usageRecords.reduce((sum,record)=>sum+(number(record,'input_tokens','prompt_tokens') || 0),0),output=usageRecords.reduce((sum,record)=>sum+(number(record,'output_tokens','completion_tokens') || 0),0);
    const cache=usageRecords.map(record=>record?.input_tokens_details?.cached_tokens ?? record?.prompt_tokens_details?.cached_tokens ?? record?.cache_read_input_tokens);
    return {usageSource:options.mode==='fixture'?'scripted-fixture':'provider-report',reportedInputTokens:valid?input:null,reportedOutputTokens:valid?output:null,reportedCacheTokens:cache.length && cache.every(value=>Number.isFinite(value) && value>=0)?cache.reduce((sum,value)=>sum+value,0):null,reportedCostUsd:options.mode==='live' && options.provider!=='chatgpt' && valid?(input*options.inputPrice+output*options.outputPrice)/1_000_000:null};
  };
  harness={directory,store,engine,connection,options,signal:controller.signal,check,phase:0,retentionRunIds,controlResponses:{answers:0,skips:0,denials:0,fixtureCommandApprovals:0},offeredTools:new Set(),imageParts:[],calls:()=>calls,toolCalls:()=>toolCalls,usage:caseUsage,workspace:botId=>{checkDeadline();return getWorkspaceRoot(store,botId || 'bot_atlas');},
    async write(name,text,botId='bot_atlas'){checkDeadline();const target=path.join(await harness.workspace(botId),name);await fs.mkdir(path.dirname(target),{recursive:true});checkDeadline();await fs.writeFile(target,text);return target;},
    async read(name,botId='bot_atlas'){checkDeadline();return fs.readFile(path.join(await harness.workspace(botId),name),'utf8');},
    async workspaceIdentity(except=[]){
      const root=await harness.workspace(),entries=[];
      const walk=async(relative='')=>{checkDeadline();for(const item of await fs.readdir(path.join(root,relative),{withFileTypes:true})){const name=path.posix.join(relative,item.name);if(except.includes(name))continue;if(item.isDirectory())await walk(name);else if(item.isFile())entries.push([name,hash(await fs.readFile(path.join(root,name)))]);else entries.push([name,'non-regular']);if(entries.length>1000)throw new Error('Fixture workspace exceeds its bound.');}};
      await walk();return hash(JSON.stringify(entries.sort(([a],[b])=>a.localeCompare(b))));
    },
    async installOracle(name,content){
      checkDeadline();if(oracle || !/^[a-z-]{1,60}$/.test(name) || typeof content!=='string' || content.length>12000)throw new Error('Use one bounded static fixture oracle.');
      const folder=path.join(directory,'oracles');await fs.mkdir(folder,{mode:0o700});const target=path.join(folder,`${name}.test.mjs`);await fs.writeFile(target,content,{mode:0o600,flag:'wx'});
      oracle={path:target,sha256:hash(content),command:{executable:process.execPath,args:['--test',target],cwd:'.',timeoutMs:10000}};
      await store.mutate(state=>{state.bots[0].tools.push('terminal');});harness.oracleCommand=structuredClone(oracle.command);harness.oracleSha256=oracle.sha256;return harness.oracleCommand;
    },
    async runOracle(){checkDeadline();if(!await oracleUnchanged())throw new Error('The static fixture oracle changed.');return engine.tools.execute(store.state.bots[0],'shell_run',oracle.command,{approved:true,signal:controller.signal});},
    async wait(predicate,timeout=options.maxMs){const until=Math.min(deadlineAt,Date.now()+timeout);while(Date.now()<until){checkDeadline();const value=predicate();if(value)return value;await delay(5);}throw new EvaluationBudgetError('time');},
    async run(task,{botId='bot_atlas',control,...startOptions}={}) {
      checkDeadline();const run=await engine.start(botId,task,{...startOptions,parentSignal:controller.signal}),until=deadlineAt,handledControls=new Set();
      retentionRunIds.add(run.id);
      while(Date.now()<until) {
        checkDeadline();
        const current=store.state.runs[botId];
        if(!isActive(current)){const pending=engine.tasks.get(run.id);if(pending)await pending;return store.state.runs[botId];}
        const controls=current.pending_controls?.[0];
        if(controls && !handledControls.has(controls.prompt_id) && current.status==='waiting_for_approval'){
          const fixtureCommand=controls.tool==='shell_run' && sameCommand(controls.arguments) && await oracleUnchanged();
          await engine.control(botId,'approval',{runId:current.id,remoteRunId:current.remoteRunId,request_id:controls.prompt_id,execution_generation:current.execution_generation,choice:fixtureCommand?'once':'deny'});
          handledControls.add(controls.prompt_id);
          if(fixtureCommand)harness.controlResponses.fixtureCommandApprovals++;else harness.controlResponses.denials++;
        }
        else if(controls && !handledControls.has(controls.prompt_id) && current.status==='waiting_for_input') {
          if(control){await control(current,harness);harness.controlResponses.answers++;}
          else{await engine.control(botId,'answer',{runId:current.id,remoteRunId:current.remoteRunId,request_id:controls.prompt_id,execution_generation:current.execution_generation,skip:true});harness.controlResponses.skips++;}
          handledControls.add(controls.prompt_id);
        }
        await delay(5);
      }
      await engine.control(botId,'stop',{runId:run.id,remoteRunId:run.remoteRunId}).catch(()=>{});throw new EvaluationBudgetError('time');
    },
    async withinDeadline(operation){
      checkDeadline();let listener;
      const expired=new Promise((_,reject)=>{listener=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',listener,{once:true});});
      try{return await Promise.race([operation,expired]);}
      finally{controller.signal.removeEventListener('abort',listener);}
    },
    cancel(){clearTimeout(timer);controller.abort(new EvaluationBudgetError('time'));},
    async close(beforeRemove){clearTimeout(timer);controller.abort(new EvaluationBudgetError('time'));await engine.close();try{await beforeRemove?.();}finally{await actualProviders?.close();await fs.rm(directory,{recursive:true,force:true});}},
  };
  return harness;
  } catch(error){clearTimeout(timer);controller.abort(error);await engine?.close();await actualProviders?.close();await fs.rm(directory,{recursive:true,force:true});throw error;}
}

export async function runEvaluation(options={},hooks={}) {
  const config=evaluationOptions(options),budget=new EvaluationBudget(config),results=[],started=Date.now();
  if(hooks.onCaseComplete!==undefined&&typeof hooks.onCaseComplete!=='function')throw new Error('Use an explicit synthetic case output callback.');
  const fixtureSha256=hash(await fs.readFile(path.join(ROOT,'eval/scenarios.mjs')));
  const subscriptionGrantReader=config.mode==='live'&&config.provider==='chatgpt'?(hooks.subscriptionGrantReader || homeSubscriptionGrantReader({directory:config.subscriptionSource,connectionId:config.subscriptionConnection,authorized:config.authorizedSubscription})):undefined;
  const identities=await Promise.all(['lib/engine.mjs','lib/agent-tools.mjs','lib/compaction.mjs','lib/context-handoff.mjs','lib/brain.mjs','lib/history.mjs','lib/sessions.mjs','lib/memory-quality.mjs','lib/work-quality.mjs','lib/web-search.mjs','lib/providers.mjs','lib/learning.mjs','package.json','eval/scenarios.mjs','eval/runner.mjs','eval/subscription-provider.mjs','eval/case-output.mjs','eval/oracles.mjs'].map(async name=>({path:name,sha256:hash(await fs.readFile(path.join(ROOT,name)))})));
  for(const id of config.cases)for(let repetition=1;repetition<=config.repeat;repetition++) {
    if(budget.exhausted)break;
    const definition=CASES.find(item=>item.id===id),caseStart=Date.now();let harness,checks=[],status,error=null,metadata={},retention;
    let execution;
    try {
      harness=await createHarness(definition,config,budget,{subscriptionGrantReader});
      execution=definition.execute(harness);const result=await harness.withinDeadline(execution);checks=result.checks;metadata=result.metadata || {};status=grade(checks,{capabilityGap:result.capabilityGap,budgetReached:budget.exhausted});
    } catch(cause){const limited=cause instanceof EvaluationBudgetError || budget.exhausted;status=limited?'budget_exhausted':'failed';error=limited?'Evaluation admission/time budget reached.':'Fixture or provider failed; inspect a local reproduction. Details are omitted to protect credentials.';}
    finally{harness?.cancel();await execution?.catch(()=>{});await harness?.close(hooks.onCaseComplete?async()=>{try{const output=await collectSyntheticCaseOutput(harness,{definition,repetition,status,fixtureSha256});await hooks.onCaseComplete(output);retention={captured:true,answers:output.answers.length,artifacts:output.artifacts.length,truncated:output.truncated,omittedArtifacts:output.omittedArtifacts};}catch{retention={captured:false,error:'Synthetic output retention failed; private details omitted.'};}}:undefined);}
    results.push({id,family:definition.family,repetition,evidenceMode:config.mode==='fixture'?'scripted-engine-fixture':'real-model',status,checks,elapsedMs:Date.now()-caseStart,inferenceCalls:harness?.calls() || 0,toolCalls:harness?.toolCalls() || 0,usage:harness?.usage() || null,humanInterventions:null,controlResponses:harness?.controlResponses || null,...(retention?{outputRetention:retention}:{}),...(harness?.oracleSha256?{fixtureOracleSha256:harness.oracleSha256}:{}),...(error?{error}:{}),...metadata});
  }
  const times=results.map(item=>item.elapsedMs),{subscriptionSource,subscriptionConnection,...publicConfig}=config;
  return {schemaVersion:2,corpus:CORPUS_VERSION,mode:config.mode,qualityClaim:config.mode==='fixture'?'Deterministic engine correctness coverage; not model quality or Grok superiority.':'Finite task sample; not a general product superiority claim.',configuration:{...publicConfig,syntheticOutputCallback:Boolean(hooks.onCaseComplete),subscriptionSource:subscriptionSource?{configured:true}:null,subscriptionConnection:subscriptionConnection?{selected:true}:null,outputTokenLimitEnforcedByProvider:config.mode==='live'&&config.provider==='chatgpt'?false:config.mode==='live'?true:null,provider:config.mode==='fixture'?'custom':config.provider,model:config.mode==='fixture'?'scripted-fixture':config.model,imageInput:config.mode==='fixture'?'on':config.imageInput,baseUrl:config.baseUrl?{configured:true}:null,toolGroups:['workspace','memory','delegation'],caseSpecificTools:{'coding-verification':['terminal']},skills:[],permissionPolicy:'balanced private writes; exact hash-checked static fixture oracle only; all other approval requests denied',reasoningEffort:'provider-default'},sourceIdentities:identities,fixtureSha256,results,summary:{requested:config.cases.length*config.repeat,executed:results.length,passed:results.filter(item=>item.status==='passed').length,failed:results.filter(item=>item.status==='failed').length,capabilityGaps:results.filter(item=>item.status==='capability_gap').length,budgetExhausted:results.some(item=>item.status==='budget_exhausted'),elapsedMs:Date.now()-started,medianCaseMs:median(times),p95CaseMs:null},quality:qualityMetrics(results),repeatStatistics:repeatStatistics(results),usage:budget.metrics(),limitations:['Checks certify only their documented mechanical properties.','All work uses disposable data; no live workspace or scheduler is imported.','No raw prompts, outputs, account identities or provider URLs are included in this report.','Token admission reserves UTF-8 bytes plus requested output tokens. API cost estimates use supplied prices; subscription cost stays unknown. ChatGPT preview rejects max_output_tokens, so subscription output tokens are not remotely capped; transport bytes, time and inference admission still bound execution.','The last dispatched request can exceed estimates; no further request is dispatched after a reported ceiling is reached.','Fixture summaries, usage counters, questions and model choices are scripted, so fixture passes do not establish real-model reasoning or memory quality.','Control responses are fixture automation, not measured human interventions.','The coding oracle executes a fixed Node test outside the model-writable workspace; it parses a restricted source grammar and never imports or executes generated code.']};
}

export { CASES };
