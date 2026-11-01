import { HttpError, ensure, string, now, id } from './store.mjs';
import { validateServiceUrl, serviceRequest, requireSuccess } from './provider-net.mjs';
import { createHash } from 'node:crypto';
import { TAVILY_SEARCH_SCHEMA, SEARXNG_SEARCH_SCHEMA } from './web-search.mjs';

const PROTOCOL='2025-06-18';
const METHODS=new Set(['GET','POST','PUT','PATCH','DELETE']);
const RESERVED_HEADERS=new Set(['host','cookie','content-length','transfer-encoding','connection','accept','content-type','origin','proxy-authorization']);
const object=value=>value && typeof value==='object' && !Array.isArray(value);
const schemaFor=tool=>tool.inputSchema || tool.parameters || {type:'object',properties:{}};
function schema(value){ensure(object(value) && Buffer.byteLength(JSON.stringify(value))<=32_000,400,'Tool input schema must be a JSON object under 32 KB.');return structuredClone(value);}
function safeTool(tool,index=0){
  ensure(object(tool),400,'Each integration action must be an object.');
  const name=string(tool.name,`Action ${index+1} name`,100);ensure(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(name),400,'Action names must contain letters, numbers, _, ., : or -.');
  return {name,description:string(tool.description || name,'Action description',2000),inputSchema:schema(schemaFor(tool))};
}
export function validateIntegrationArguments(value,spec,path='arguments',depth=0){
  ensure(depth<=12,400,'Tool input is nested too deeply.');
  if(!object(spec))return;
  if(spec.enum)ensure(spec.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)),400,`${path} must match an allowed value.`);
  const types=Array.isArray(spec.type)?spec.type:spec.type?[spec.type]:[];
  if(types.length){const actual=value===null?'null':Array.isArray(value)?'array':typeof value;ensure(types.some(type=>type===actual || type==='integer' && Number.isInteger(value)),400,`${path} has an invalid type.`);}
  if(typeof value==='string'){if(spec.minLength!==undefined)ensure(value.length>=spec.minLength,400,`${path} is too short.`);if(spec.maxLength!==undefined)ensure(value.length<=spec.maxLength,400,`${path} is too long.`);}
  if(typeof value==='number'){ensure(Number.isFinite(value),400,`${path} must be finite.`);if(spec.minimum!==undefined)ensure(value>=spec.minimum,400,`${path} is below its minimum.`);if(spec.maximum!==undefined)ensure(value<=spec.maximum,400,`${path} exceeds its maximum.`);}
  if(Array.isArray(value)){if(spec.maxItems!==undefined)ensure(value.length<=spec.maxItems,400,`${path} contains too many entries.`);if(spec.items)value.forEach((item,index)=>validateIntegrationArguments(item,spec.items,`${path}[${index}]`,depth+1));}
  if(object(value)){
    for(const key of spec.required || [])ensure(Object.hasOwn(value,key),400,`${path}.${key} is required.`);
    for(const [key,item] of Object.entries(value)){ensure(!['__proto__','prototype','constructor'].includes(key),400,'Unsafe argument key.');if(spec.properties?.[key])validateIntegrationArguments(item,spec.properties[key],`${path}.${key}`,depth+1);else if(spec.additionalProperties===false)throw new HttpError(400,`${path}.${key} is not an allowed field.`);}
  }
}

/** Owner-configured REST actions and MCP tools. Every call requires engine approval. */
export class Integrations {
  constructor(store,options={}){this.store=store;this.options=options;this.sessions=new Map();this.initializing=new Map();}
  catalog(){return [
    {id:'mcp',name:'MCP server',type:'mcp',description:'Connect a Streamable HTTP MCP server and discover its tools.'},
    {id:'brave',name:'Brave Search',type:'rest',baseUrl:'https://api.search.brave.com/res',authType:'header',headerName:'X-Subscription-Token',tools:[{name:'web_search',description:'Search the public web and return source URLs and snippets.',method:'GET',path:'/v1/web/search',inputSchema:{type:'object',properties:{q:{type:'string',minLength:1,maxLength:600},count:{type:'integer',minimum:1,maximum:20}},required:['q'],additionalProperties:false}}]},
    {id:'tavily',name:'Tavily Search',type:'rest',baseUrl:'https://api.tavily.com',authType:'bearer',description:'Optional API-key search. Basic depth only; API usage and query handling follow your Tavily account.',tools:[{name:'web_search',description:'Discover public source URLs and snippets with fixed Basic search settings.',method:'POST',path:'/search',inputSchema:structuredClone(TAVILY_SEARCH_SCHEMA)}]},
    {id:'searxng',name:'SearXNG (your instance)',type:'rest',baseUrl:'',authType:'none',description:'Provide your own trusted instance URL with JSON output enabled. No public instance is selected automatically.',tools:[{name:'web_search',description:'Discover public source URLs and snippets through this owner-configured SearXNG instance.',method:'GET',path:'/search',inputSchema:structuredClone(SEARXNG_SEARCH_SCHEMA)}]},
    {id:'github',name:'GitHub',type:'rest',baseUrl:'https://api.github.com',authType:'bearer',tools:[{name:'list_repositories',description:'List repositories available to the connected GitHub account.',method:'GET',path:'/user/repos',inputSchema:{type:'object',properties:{per_page:{type:'integer',minimum:1,maximum:100}},additionalProperties:false}}]},
    {id:'slack',name:'Slack',type:'rest',baseUrl:'https://slack.com/api',authType:'bearer',tools:[{name:'list_channels',description:'List channels visible to this Slack token.',method:'GET',path:'/conversations.list',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:200}},additionalProperties:false}},{name:'post_message',description:'Send a message to an explicitly selected Slack channel.',method:'POST',path:'/chat.postMessage',inputSchema:{type:'object',properties:{channel:{type:'string',minLength:1,maxLength:100},text:{type:'string',minLength:1,maxLength:4000}},required:['channel','text'],additionalProperties:false}}]},
    {id:'rest',name:'Custom API',type:'rest',description:'Declare fixed API actions and their input schemas.'}
  ];}
  validate(input,previous={}){
    const type=input.type || previous.type || 'mcp';ensure(['mcp','rest'].includes(type),400,'Choose MCP or a REST API integration.');
    const value={...previous,type,name:Object.hasOwn(input,'name')?string(input.name,'Integration name',100):previous.name || 'New integration'};
    value.baseUrl=string(input.baseUrl ?? previous.baseUrl,'Integration URL',2000).replace(/\/+$/,'');
    validateServiceUrl(value.baseUrl,{allowPrivateHttp:this.options.allowPrivateHttp ?? process.env.STUDIO_ALLOW_PRIVATE_HTTP==='true'});
    value.authType=input.authType || previous.authType || 'bearer';ensure(['bearer','header','none'].includes(value.authType),400,'Choose bearer token, API header, or no authentication.');
    if(value.authType==='header'){value.headerName=string(input.headerName || previous.headerName || 'x-api-key','Authentication header',100);ensure(/^[A-Za-z][A-Za-z0-9-]*$/.test(value.headerName) && !RESERVED_HEADERS.has(value.headerName.toLowerCase()),400,'Choose a safe API authentication header.');}
    else delete value.headerName;
    if(previous.baseUrl && (value.baseUrl!==previous.baseUrl || value.authType!==previous.authType || value.headerName!==previous.headerName)){delete value.secret;delete value.tools;value.status='untested';}
    if(input.apiKey){const key=string(input.apiKey,'Integration credential',8192);ensure(!/[\x00-\x1f\x7f]/.test(key),400,'Credentials cannot contain control characters.');value.secret=this.store.seal(key);}
    if(value.authType==='none')delete value.secret;
    else ensure(value.secret,400,'Add the integration credential.');
    if(type==='rest'){
      const tools=input.tools ?? value.tools;ensure(Array.isArray(tools) && tools.length>0 && tools.length<=64,400,'Declare 1–64 REST actions.');
      value.tools=tools.map((tool,index)=>{const normalized=safeTool(tool,index);ensure(METHODS.has(tool.method),400,'REST action method must be GET, POST, PUT, PATCH or DELETE.');const path=string(tool.path,'Action path',500);ensure(path.startsWith('/') && !path.startsWith('//') && !/[?#\\\x00-\x1f]/.test(path) && !path.split('/').some(part=>['.','..'].includes(part)) && !/%(?:2f|5c|2e|00)/i.test(path),400,'REST actions need fixed safe paths without query strings.');return {...normalized,method:tool.method,path};});
      ensure(new Set(value.tools.map(tool=>tool.name)).size===value.tools.length,400,'Action names must be unique.');
    } else if(input.tools)throw new HttpError(400,'MCP tool definitions are discovered from the configured server.');
    value.status='untested';return value;
  }
  get(integrationId){const integration=this.store.state.integrations?.find(item=>item.id===integrationId);ensure(integration,404,'Integration not found.');return integration;}
  fingerprint(integration){return createHash('sha256').update(JSON.stringify([integration.baseUrl,integration.authType,integration.headerName,integration.secret])).digest('hex');}
  headers(integration){if(integration.authType==='none')return {};const token=this.store.unseal(integration.secret);return integration.authType==='header'?{[integration.headerName]:token}:{Authorization:`Bearer ${token}`};}
  async request(integration,{method='POST',path='',body,signal,headers={},maxBytes=2_000_000}={}){
    const base=integration.baseUrl.replace(/\/+$/,'');
    try{return requireSuccess(await serviceRequest(`${base}${path}`,{method,headers:{Accept:'application/json, text/event-stream','User-Agent':'Tupies/0.2.0',...this.headers(integration),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body,signal,timeoutMs:this.options.requestTimeout || 30_000,maxBytes,allowPrivateHttp:this.options.allowPrivateHttp ?? process.env.STUDIO_ALLOW_PRIVATE_HTTP==='true'}),'Integration');}
    catch(error){if(signal?.aborted)throw signal.reason || error;throw new HttpError(error.status || 502,this.store.redact(error instanceof HttpError?error.message:'The integration could not be reached. Check its endpoint, credential and network.'));}
  }
  async rpc(integration,method,params,{signal,notification=false,initialize=false}={}){
    let session=this.sessions.get(integration.id);if(session && session.fingerprint!==this.fingerprint(integration)){this.sessions.delete(integration.id);session=null;}const requestId=id('rpc');
    const result=await this.request(integration,{signal,headers:{...(!initialize && session?.id?{'Mcp-Session-Id':session.id}:{}),...(!initialize?{'MCP-Protocol-Version':session?.version || PROTOCOL}:{})},body:{jsonrpc:'2.0',...(notification?{}:{id:requestId}),method,...(params!==undefined?{params}:{})}});
    if(notification){ensure(result.status===202 || result.status===200 || result.status===204,502,'MCP notification was not accepted.');return null;}
    const response=result.streaming?result.events.find(event=>event.id===requestId):result.data;
    ensure(response && response.jsonrpc==='2.0' && response.id===requestId,502,'MCP returned an invalid or unmatched response.');
    if(response.error)throw new HttpError(502,this.store.redact(`MCP ${method} failed: ${String(response.error.message || 'protocol error').slice(0,300)}`));
    if(initialize){const sessionId=result.headers['mcp-session-id'];ensure(!sessionId || typeof sessionId==='string' && /^[\x21-\x7e]{1,500}$/.test(sessionId),502,'MCP returned an invalid session id.');const version=response.result?.protocolVersion;ensure(['2025-06-18','2025-03-26'].includes(version),502,'This MCP server negotiated an unsupported protocol version.');this.sessions.set(integration.id,{id:sessionId || '',version,fingerprint:this.fingerprint(integration)});}
    return response.result;
  }
  async initialize(integration,signal){
    if(this.sessions.get(integration.id)?.fingerprint===this.fingerprint(integration))return;
    this.sessions.delete(integration.id);
    if(this.initializing.has(integration.id))return this.initializing.get(integration.id);
    const task=(async()=>{await this.rpc(integration,'initialize',{protocolVersion:PROTOCOL,capabilities:{},clientInfo:{name:'Tupies',version:'0.5.0'}},{signal,initialize:true});await this.rpc(integration,'notifications/initialized',undefined,{signal,notification:true});})();
    this.initializing.set(integration.id,task);try{await task;}catch(error){this.sessions.delete(integration.id);throw error;}finally{this.initializing.delete(integration.id);}
  }
  async discover(integrationId,{signal}={}){
    const integration=this.get(integrationId);let tools;
    if(integration.type==='mcp'){
      // An explicit discovery refresh starts a fresh session against the current credential.
      this.sessions.delete(integration.id);await this.initialize(integration,signal);tools=[];let cursor;
      for(let page=0;page<8;page++){const result=await this.rpc(integration,'tools/list',cursor?{cursor}:{},{signal});ensure(Array.isArray(result?.tools),502,'MCP server did not return a tool list.');tools.push(...result.tools.map(safeTool));ensure(tools.length<=64,502,'MCP catalog exceeded the 64-tool limit.');cursor=result.nextCursor;if(!cursor)break;ensure(page<7,502,'MCP tool catalog pagination exceeded its limit.');}
      ensure(new Set(tools.map(tool=>tool.name)).size===tools.length,502,'MCP returned duplicate tool names.');
    } else tools=integration.tools || [];
    const status=integration.type==='rest'?'configured':'connected';
    await this.store.mutate(state=>{const current=state.integrations.find(item=>item.id===integrationId);ensure(current,409,'Integration was removed.');current.tools=tools;current.status=status;current.testedAt=now();delete current.error;});
    return {tools,status,note:integration.type==='rest'?'The declared actions are configured. No external action was executed.':'MCP tool discovery succeeded. Tool calls still require approval.'};
  }
  listTools(bot){
    const ids=bot.integrationIds || [];
    return (this.store.state.integrations || []).filter(integration=>ids.includes(integration.id)).flatMap(integration=>(integration.tools || []).map(tool=>({integrationId:integration.id,integrationName:integration.name,name:tool.name,description:tool.description,parameters:tool.inputSchema,requiresApproval:true})));
  }
  async call(integrationId,name,args,{signal,approved=false,botId,readOnly=false,maxResponseBytes=2_000_000}={}){
    const integration=this.get(integrationId),bot=this.store.state.bots.find(item=>item.id===botId);
    ensure(bot && (bot.integrationIds || []).includes(integrationId),403,'This integration is not assigned to the bot.');
    ensure(approved===true,403,'Integration calls require approval for the exact action and arguments.');
    ensure(object(args) && Buffer.byteLength(JSON.stringify(args))<=64_000,400,'Integration arguments must be an object under 64 KB.');
    const tool=(integration.tools || []).find(tool=>tool.name===name);ensure(tool,404,'The selected integration action does not exist. Refresh its tool list.');validateIntegrationArguments(args,tool.inputSchema);
    ensure(Number.isInteger(maxResponseBytes) && maxResponseBytes>0 && maxResponseBytes<=2_000_000,400,'Invalid integration response limit.');
    if(readOnly)ensure(integration.type==='rest' && tool.method==='GET',403,'This gateway supports only configured REST GET actions.');
    let result;
    if(integration.type==='mcp'){await this.initialize(integration,signal);result=await this.rpc(integration,'tools/call',{name,arguments:args},{signal});}
    else {
      let path=tool.path;if(tool.method==='GET'){
        const params=new URLSearchParams();for(const [key,value] of Object.entries(args)){ensure(value===null || ['string','number','boolean'].includes(typeof value),400,'GET action parameters must be scalar values.');if(value!==null)params.set(key,String(value));}if(params.size)path+=`?${params}`;
      }
      const response=await this.request(integration,{method:tool.method,path,body:tool.method==='GET'?undefined:args,signal,maxBytes:maxResponseBytes});
      if(readOnly)ensure(!response.streaming,502,'Workshop API reads require a finite JSON response.');
      result=response.data;
      if(result?.ok===false)throw new HttpError(502,`The API refused the action: ${this.store.redact(String(result.error || 'service error'))}`);
    }
    if(result?.isError===true)result={...result,error:'The integration reported a failed tool result. Inspect its content and actual service state before any retry.',errorCode:'integration_failed',outcome:'unknown'};
    await this.store.mutate(()=>this.store.audit(result?.isError===true?'integration.failed':'integration.called',`${integration.name}: ${name}`,botId,{integrationId,tool:name}));
    return this.store.redactValue(result);
  }
  invalidate(integrationId){this.sessions.delete(integrationId);}
  async close(){this.sessions.clear();}
}
