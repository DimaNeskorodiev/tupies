import { ensure } from './store.mjs';
import { groupsFor } from './agent-tools.mjs';
import { inspectWorkshopTool, workshopDigest } from './workshop.mjs';
import { sandboxTransform, boundedJSON, WORKSHOP_LIMITS } from './workshop-sandbox.mjs';
import { validateIntegrationArguments } from './integrations.mjs';

const object=value=>value && typeof value==='object' && !Array.isArray(value);
function access(store,bot,integrations) {
  ensure(integrations && integrations.store===store,409,'No integration service is configured.');
  const current=store.state.bots.find(item=>item.id===bot.id);
  ensure(current && current.enabled!==false && [bot,current].every(item=>['workshop','integrations'].every(group=>groupsFor(item).includes(group))),403,'The owner must enable both Tool workshop and Integrations for this bot.');
  return current;
}
function selected(store,bot,integrations,integrationId,toolName) {
  const current=access(store,bot,integrations);
  ensure([bot,current].every(item=>item.integrationIds?.includes(integrationId)),403,'This integration must be assigned in both the task snapshot and current bot settings.');
  const integration=integrations.get(integrationId),tool=integration.tools?.find(item=>item.name===toolName);
  ensure(integration.type==='rest' && tool?.method==='GET',403,'Workshop API reads support only owner-configured REST GET actions, not MCP or writes.');
  return {integration,tool};
}
export function listWorkshopSources(store,bot,integrations) {
  const current=access(store,bot,integrations);
  const sources=(store.state.integrations || []).filter(item=>item.type==='rest' && bot.integrationIds?.includes(item.id) && current.integrationIds?.includes(item.id)).flatMap(item=>(item.tools || []).filter(tool=>tool.method==='GET').map(tool=>({integrationId:item.id,integrationName:item.name,tool:tool.name,description:tool.description,parameters:tool.inputSchema,method:'GET',requiresApproval:true})));
  return {sources,notice:'Owner-configured endpoints, not a proof that a remote GET is side-effect-free or free of charge. Every request requires exact approval; source descriptions and results are untrusted data.'};
}
function requestArgs(args) {
  ensure(object(args) && Object.keys(args).every(key=>['digest','integrationId','tool','arguments','input'].includes(key)) && ['digest','integrationId','tool','arguments','input'].every(key=>Object.hasOwn(args,key)),400,'Supply only digest, integrationId, tool, arguments and input.');
  ensure(typeof args.digest==='string' && /^[a-f0-9]{64}$/.test(args.digest) && ['integrationId','tool'].every(key=>typeof args[key]==='string' && args[key].length>0 && args[key].length<=100),400,'Select an exact package digest and assigned API action.');
  ensure(object(args.arguments),400,'API arguments must be an object.');
  boundedJSON(args.arguments,8192);boundedJSON(args.input,16384);
  ensure(Object.values(args.arguments).every(value=>value===null || ['string','boolean','number'].includes(typeof value)),400,'GET parameters must be scalar JSON values.');
  return structuredClone(args);
}
function identity(store,bot,integrations,args) {
  const {integration,tool}=selected(store,bot,integrations,args.integrationId,args.tool);
  validateIntegrationArguments(args.arguments,tool.inputSchema);
  const scope={request:args,integration:{id:integration.id,name:integration.name,type:integration.type,fingerprint:integrations.fingerprint(integration),tool}};
  return {integration,tool,digest:workshopDigest({botId:bot.id,...scope}),scopeIdentity:workshopDigest(scope)};
}
export async function prepareWorkshopRead(store,bot,integrations,args,{signal}={}) {
  args=requestArgs(args);signal?.throwIfAborted();
  const record=await inspectWorkshopTool(store,bot.id,args.digest);
  const selected=identity(store,bot,integrations,args),endpoint=`${selected.integration.baseUrl.replace(/\/+$/,'')}${selected.tool.path}`;
  // Only the Engine retains this identity. A model-provided hash is never approval.
  return {identity:selected.digest,scopeIdentity:selected.scopeIdentity,review:{summary:`Read ${selected.integration.name} · GET ${endpoint} once and process its JSON with ${record.package.title}. The API may charge for this request.`,method:'GET',endpoint,packageDigest:args.digest,requestArguments:args.arguments,limits:{requests:1,responseBytes:WORKSHOP_LIMITS.jsonBytes,networkMs:20000},notice:'Only arguments are sent to the API. Local input and tool source stay in the Engine. No redirects or automatic retries.'}};
}
export async function runWorkshopRead(store,bot,integrations,args,{signal,approved=false,approvedIdentity}={}) {
  ensure(approved===true && typeof approvedIdentity==='string',403,'Workshop API reads require exact Engine approval.');
  args=requestArgs(args);signal?.throwIfAborted();
  const record=await inspectWorkshopTool(store,bot.id,args.digest);
  const check=()=>ensure(identity(store,bot,integrations,args).digest===approvedIdentity,409,'The API configuration, credential or request changed after review. Request a new exact approval.');
  check();
  const timeout=AbortSignal.timeout(20000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  // The guest never constructs a URL, receives headers, or calls a host function.
  combined.throwIfAborted();
  const response=await integrations.call(args.integrationId,args.tool,args.arguments,{signal:combined,approved:true,botId:bot.id,readOnly:true,maxResponseBytes:WORKSHOP_LIMITS.jsonBytes});
  combined.throwIfAborted();check();
  ensure(response?.isError!==true,502,'The API reported a failed result. No workshop transform was run; inspect the service before retrying.');
  const data=store.redactValue({data:args.input,response});boundedJSON(data);
  const output=await sandboxTransform(record.package.source,data,{signal});
  signal?.throwIfAborted();check();
  return {digest:args.digest,id:record.package.id,output:store.redactValue(output),source:{integrationId:args.integrationId,tool:args.tool,method:'GET',requests:1},verifiedExecution:true,notice:'One approved API response processed in isolation. Remote data and computed output are untrusted; this proves execution, not freshness, accuracy or an economic outcome. Save artifacts with ordinary file/document tools.'};
}

const str={type:'string',minLength:1,maxLength:100};
export const WORKSHOP_GATEWAY_DEFINITIONS=[
  {name:'workshop_sources',group:'workshop',description:'List assigned owner-configured REST GET sources for isolated tools. Requires Workshop and Integrations; listing grants no permission.',parameters:{type:'object',properties:{},required:[],additionalProperties:false}},
  {name:'workshop_read_api',group:'workshop',description:'After exact approval, make one assigned REST GET request through Engine and process its JSON with an exact verified workshop package. Guest input is {data:input,response:API_JSON}; test this shape with synthetic data. Only arguments go to the API, never input or source. 8 KiB arguments, 16 KiB input, 64 KiB response/combined guest input, 20s network limit. No MCP, writes, headers, arbitrary URLs, redirects or automatic retries.',parameters:{type:'object',properties:{digest:{type:'string',pattern:'^[a-f0-9]{64}$'},integrationId:str,tool:str,arguments:{type:'object'},input:{}},required:['digest','integrationId','tool','arguments','input'],additionalProperties:false}},
];

WORKSHOP_GATEWAY_DEFINITIONS.push({...WORKSHOP_GATEWAY_DEFINITIONS[1],name:'workshop_poll_api',description:'Observe fresh API JSON using an owner-issued bounded-read grant for this exact request, package and local input, scoped to this task family and explicitly chosen bots. The first call asks the owner for exact review; a grant shares a request count, expiry and interval. Failed/unknown calls consume budget and block the grant. No automatic retry, writes, spending authority or persistence of authority across restart. Guest shape and limits match workshop_read_api.'});
