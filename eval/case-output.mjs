import path from 'node:path';
import {createHash} from 'node:crypto';
import {documentFileMetadata,readWorkspaceBytes} from '../lib/agent-tools.mjs';
import {CASES,CORPUS_VERSION} from './scenarios.mjs';
import {sanitizeProviderFailure} from '../lib/provider-failure.mjs';

const ARTIFACTS={'research-document':new Set(['report.md'])},SAFE=/^[a-zA-Z0-9_-]{1,120}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const STATES=new Set(['queued','running','waiting_for_approval','waiting_for_input','waiting_for_delegate','stopping','completed','failed','cancelled','interrupted']);
const CHECKS=new Set(['file_exists','file_contains','file_sha256','command_success','source_read','teammate_completed']);
const count=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max?value:null;
/** Classifies locally held failure text without returning any part of it. Unknown stays unknown. */
export function syntheticFailureCategory(run) {
  if(run.status==='completed')return 'none';if(run.status==='cancelled')return 'cancelled';if(run.status==='interrupted')return 'restarted';
  const error=typeof run.error==='string'?run.error:typeof run.error?.message==='string'?run.error.message:'';
  if(run.verification?.passed===false)return 'declared_check_failed';
  const failure=sanitizeProviderFailure(run.failure);if(failure)return `provider_${failure.code}`;
  for(const [category,pattern] of [['required_teammate_incomplete',/required teammate deliverable is incomplete/i],['unfinished_plan',/unfinished plan steps/i],['output_limit',/model reached its output limit/i],['time_limit',/task reached its runtime limit/i],['step_limit',/task reached its model-step limit/i],['tool_limit',/task reached its tool-call limit/i],['provider_auth',/HTTP 401\b|continue with ChatGPT|sign in again|home-engine subscription grant/i],['provider_rate_limit',/HTTP 429\b|rate.limit/i],['provider_incomplete_response',/stream ended before a completed response|completed without text or a tool call/i],['provider_protocol',/model returned invalid tool arguments|provider returned invalid|outside the offered Tupies namespace/i],['provider_unavailable',/provider could not be reached|HTTP 50[234]\b/i],['admission_changed',/changed while .*being admitted|engine is changing its sync connection/i]])if(pattern.test(error))return category;
  return 'unknown';
}

/** Fixed synthetic corpus only: final display answers and explicitly allowed, reverified text artifacts. */
export async function collectSyntheticCaseOutput(harness,{definition,repetition,status,fixtureSha256}) {
  if(!CASES.includes(definition)||!/^tupies-evaluation-/.test(path.basename(harness.directory))||harness.store.directory!==harness.directory||!/^[a-f0-9]{64}$/.test(fixtureSha256))throw new Error('Synthetic output retention requires the versioned disposable evaluation corpus.');
  const {store}=harness,owned=harness.retentionRunIds,clean=value=>store.redact(String(value)).split(harness.directory).join('[fixture]');
  const runs=Object.values(store.state.runs).filter(run=>owned.has(run.id)||owned.has(run.delegation?.rootRunId)),ids=new Set([...owned,...runs.map(run=>run.id)]),answers=[],artifacts=[];
  const diagnosticRuns=new Map();
  for(const [botId,history] of Object.entries(store.state.runHistory || {}))if(SAFE.test(botId))for(const run of history)if(ids.has(run.id))diagnosticRuns.set(run.id,{botId,run});
  for(const run of runs)if(SAFE.test(run.botId))diagnosticRuns.set(run.id,{botId:run.botId,run});
  const diagnostics=[...diagnosticRuns.values()].slice(0,12).map(({botId,run})=>{const failure=sanitizeProviderFailure(run.failure);return {botId,runId:run.id,status:STATES.has(run.status)?run.status:'unknown',steps:count(run.steps,50),toolCalls:count(run.toolCalls ?? (Array.isArray(run.workRecords)?run.workRecords.length:undefined),60),failedChecks:(run.verification?.checks || []).filter(check=>check.passed===false&&CHECKS.has(check.kind)).slice(0,12).map(check=>({id:clean(check.id || '').slice(0,64),kind:check.kind})),failureCategory:syntheticFailureCategory(run),...(failure?{failure}:{})};});
  let remaining=128_000,truncated=false,omittedArtifacts=0;
  for(const [botId,messages] of Object.entries(store.state.messages))if(SAFE.test(botId))for(const message of messages) {
    if(message.role!=='assistant'||!ids.has(message.runId)||typeof message.content!=='string')continue;
    if(answers.length>=12||remaining<=0){truncated=true;continue;}
    const text=clean(message.content),kept=text.slice(0,Math.min(32_000,remaining));remaining-=kept.length;truncated ||= kept.length<text.length;
    answers.push({botId,runId:message.runId,text:kept,partial:message.partial===true});
  }
  for(const run of runs)for(const artifactPath of new Set([...(run.artifacts || []).map(item=>item.path),...(ARTIFACTS[definition.id] || [])])) {
    // No recursive file collection, model-invented paths, input files, arbitrary binaries or external files.
    if(!ARTIFACTS[definition.id]?.has(artifactPath)||!SAFE.test(run.botId)||artifacts.length>=2){omittedArtifacts++;continue;}
    try {
      const metadata=await documentFileMetadata(store,run.botId,artifactPath);if(metadata.size>256_000)throw new Error('Too large.');
      const bytes=await readWorkspaceBytes(store,run.botId,artifactPath,{maxBytes:256_000}),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),redacted=clean(text),retained=Buffer.from(redacted.slice(0,64_000),'utf8');
      artifacts.push({botId:run.botId,path:artifactPath,mime:metadata.mime,sha256:hash(retained),bytes:retained,recordedArtifact:(run.artifacts || []).some(item=>item.path===artifactPath),redacted:true,truncated:redacted.length>64_000});
    } catch {omittedArtifacts++;}
  }
  return {schemaVersion:1,corpus:CORPUS_VERSION,fixtureSha256,caseId:definition.id,repetition,status,answers,artifacts,diagnostics,truncated,omittedArtifacts};
}
