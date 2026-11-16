import { HttpError, ensure, string, now, id } from './store.mjs';
import { validateServiceUrl, serviceRequest, requireSuccess } from './provider-net.mjs';
import { createHash } from 'node:crypto';
import { TAVILY_SEARCH_SCHEMA, SEARXNG_SEARCH_SCHEMA } from './web-search.mjs';
import { exaPreset } from './exa.mjs';

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
const PLACEHOLDER=/\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;
const ENGINE_HEADERS=new Set(['authorization','user-agent','mcp-session-id','mcp-protocol-version']);
const DECODE_BUDGET=1_000_000;
const placeholders=path=>[...String(path).matchAll(PLACEHOLDER)].map(match=>match[1]);
const headerAllowed=(name,authHeader)=>typeof name==='string' && name.length<=100 && /^[A-Za-z][A-Za-z0-9-]*$/.test(name) && !RESERVED_HEADERS.has(name.toLowerCase()) && !ENGINE_HEADERS.has(name.toLowerCase()) && name.toLowerCase()!==String(authHeader || '').toLowerCase();
const headerValue=value=>typeof value==='string' && value.length<=512 && !/[\x00-\x1f\x7f]/.test(value);
/** Owner-declared non-secret headers sent with every request of one integration; auth and engine headers always win. */
export function staticHeaders(integration){return Object.fromEntries((object(integration?.headers)?Object.entries(integration.headers):[]).filter(([name,value])=>headerAllowed(name,integration.headerName) && headerValue(value)).slice(0,8));}
function validateHeaders(value,authHeader){
  if(value===undefined || value===null)return undefined;
  const entries=object(value)?Object.entries(value):null;ensure(entries && entries.length<=8 && new Set(entries.map(([name])=>name.toLowerCase())).size===entries.length,400,'Integration headers must be an object with at most 8 distinct names.');
  for(const [name,text] of entries){ensure(headerAllowed(name,authHeader),400,`Header ${name.slice(0,100)} is reserved or unsafe. Authentication and engine headers cannot be set here.`);ensure(headerValue(text),400,'Header values must be text up to 512 characters without control characters.');}
  return entries.length?Object.fromEntries(entries):undefined;
}
/** REST action: fixed safe path with optional {placeholders}, query list for non-GET, base64 argument encoding and response decoding. */
function restAction(tool,normalized){
  ensure(METHODS.has(tool.method),400,'REST action method must be GET, POST, PUT, PATCH or DELETE.');
  const path=string(tool.path,'Action path',500),literal=path.replace(PLACEHOLDER,'x'),params=placeholders(path),properties=object(normalized.inputSchema.properties)?normalized.inputSchema.properties:{},required=Array.isArray(normalized.inputSchema.required)?normalized.inputSchema.required:[];
  ensure(literal.startsWith('/') && !literal.startsWith('//') && !/[?#\\{}\x00-\x1f]/.test(literal) && !literal.split('/').some(part=>['.','..'].includes(part)) && !/%(?:2f|5c|2e|00)/i.test(literal),400,'REST actions need fixed safe paths without query strings.');
  ensure(params.length<=16 && new Set(params).size===params.length,400,'Path placeholders must be unique, at most 16.');
  for(const name of params)ensure(Object.hasOwn(properties,name) && ['string','integer'].includes(properties[name]?.type) && required.includes(name),400,`Path placeholder {${name}} must be a required string or integer input.`);
  ensure(tool.approval===undefined || ['ask','auto'].includes(tool.approval),400,'Action approval must be ask or auto.');ensure(tool.approval!=='auto' || tool.method==='GET',400,'Only GET actions can run without asking.');
  const action={...normalized,method:tool.method,path,...(tool.approval==='auto'?{approval:'auto'}:{})};
  if(tool.query!==undefined){ensure(tool.method!=='GET',400,'GET actions already send their inputs as query parameters. Remove query.');ensure(Array.isArray(tool.query) && tool.query.length>=1 && tool.query.length<=32 && new Set(tool.query).size===tool.query.length && tool.query.every(name=>typeof name==='string' && Object.hasOwn(properties,name) && !params.includes(name)),400,'Action query must list 1–32 unique declared inputs that are not path placeholders.');action.query=[...tool.query];}
  if(tool.encode!==undefined){const entries=object(tool.encode)?Object.entries(tool.encode):[];ensure(entries.length>=1 && entries.length<=8 && entries.every(([name,kind])=>Object.hasOwn(properties,name) && properties[name]?.type==='string' && !params.includes(name) && ['base64','base64url'].includes(kind)),400,'Action encode must map 1–8 declared string inputs (not path placeholders) to base64 or base64url.');action.encode=Object.fromEntries(entries);}
  if(tool.decode!==undefined){const keys=tool.decode?.keys;ensure(object(tool.decode) && Object.keys(tool.decode).every(key=>['keys','as'].includes(key)) && Array.isArray(keys) && keys.length>=1 && keys.length<=8 && new Set(keys).size===keys.length && keys.every(key=>typeof key==='string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(key)) && ['base64','base64url'].includes(tool.decode.as),400,'Action decode needs 1–8 response key names and as: base64 or base64url.');action.decode={keys:[...keys],as:tool.decode.as};}
  return action;
}
/** The action path with each {placeholder} replaced by one encoded, non-traversing segment value. */
export function actionPath(tool,args={}){
  return tool.path.replace(PLACEHOLDER,(_match,name)=>{const value=args[name],text=typeof value==='string' || Number.isInteger(value)?String(value):'';ensure(text && text.length<=512 && !/[\/\\\x00-\x1f\x7f]/.test(text) && !['.','..'].includes(text),400,`Path input ${name} must be a non-empty value up to 512 characters without slashes, control characters or dot segments.`);return encodeURIComponent(text);});
}
function appendQuery(params,key,value){
  if(value===null)return;
  if(Array.isArray(value)){ensure(value.length<=50 && value.every(item=>['string','number','boolean'].includes(typeof item)),400,'Query list parameters must contain at most 50 scalar values.');for(const item of value)params.append(key,String(item));return;}
  ensure(['string','number','boolean'].includes(typeof value),400,'Query parameters must be scalar values or lists of scalars.');params.append(key,String(value));
}
function encodeArguments(tool,args){const result={...args};for(const [name,kind] of Object.entries(tool.encode || {}))if(typeof result[name]==='string')result[name]=Buffer.from(result[name],'utf8').toString(kind);return result;}
/** Replace base64 strings under the declared keys with their text when they decode cleanly to printable UTF-8; bounded depth and total bytes. */
export function decodeResponseFields(value,{keys,as}){
  const names=new Set(keys),pattern=as==='base64url'?/^[A-Za-z0-9_-]+={0,2}$/:/^[A-Za-z0-9+/]+={0,2}$/,decoder=new TextDecoder('utf-8',{fatal:true});let budget=DECODE_BUDGET;
  const decode=text=>{
    if(budget<=0 || text.length%4===1 || !pattern.test(text))return text;
    const bytes=Buffer.from(text,as);if(bytes.length>budget){budget=0;return text;}
    let decoded;try{decoded=decoder.decode(bytes);}catch{return text;}
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded))return text;
    budget-=bytes.length;return decoded;
  };
  const walk=(item,depth)=>{
    if(depth>32 || !item || typeof item!=='object')return item;
    if(Array.isArray(item)){for(let index=0;index<item.length;index++)item[index]=walk(item[index],depth+1);return item;}
    for(const key of Object.keys(item))item[key]=names.has(key) && typeof item[key]==='string'?decode(item[key]):walk(item[key],depth+1);
    return item;
  };
  return walk(value,0);
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

/** Owner-configured REST actions and MCP tools. Every call passes engine approval; the owner may mark a REST GET action approval:'auto' (default ask). */
export class Integrations {
  constructor(store,options={}){this.store=store;this.options=options;this.sessions=new Map();this.initializing=new Map();}
  catalog(){return [
    {id:'mcp',name:'MCP server',type:'mcp',description:'Connect a Streamable HTTP MCP server and discover its tools.'},
    exaPreset(),
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
      value.tools=tools.map((tool,index)=>restAction(tool,safeTool(tool,index)));
      ensure(new Set(value.tools.map(tool=>tool.name)).size===value.tools.length,400,'Action names must be unique.');
    } else if(input.tools)throw new HttpError(400,'MCP tool definitions are discovered from the configured server.');
    const headers=validateHeaders(Object.hasOwn(input,'headers')?input.headers:value.headers,value.headerName);if(headers)value.headers=headers;else delete value.headers;
    value.status='untested';return value;
  }
  get(integrationId){const integration=this.store.state.integrations?.find(item=>item.id===integrationId);ensure(integration,404,'Integration not found.');return integration;}
  fingerprint(integration){return createHash('sha256').update(JSON.stringify([integration.baseUrl,integration.authType,integration.headerName,integration.secret])).digest('hex');}
  headers(integration){if(integration.authType==='none')return {};const token=this.store.unseal(integration.secret);return integration.authType==='header'?{[integration.headerName]:token}:{Authorization:`Bearer ${token}`};}
  async request(integration,{method='POST',path='',body,signal,headers={},maxBytes=2_000_000}={}){
    const base=integration.baseUrl.replace(/\/+$/,'');
    try{return requireSuccess(await serviceRequest(`${base}${path}`,{method,headers:{...staticHeaders(integration),Accept:'application/json, text/event-stream','User-Agent':'Tupies/0.2.0',...this.headers(integration),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body,signal,timeoutMs:this.options.requestTimeout || 30_000,maxBytes,allowPrivateHttp:this.options.allowPrivateHttp ?? process.env.STUDIO_ALLOW_PRIVATE_HTTP==='true'}),'Integration');}
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
    return (this.store.state.integrations || []).filter(integration=>ids.includes(integration.id)).flatMap(integration=>(integration.tools || []).map(tool=>({integrationId:integration.id,integrationName:integration.name,name:tool.name,description:tool.description,parameters:tool.inputSchema,requiresApproval:!(integration.type==='rest' && tool.method==='GET' && tool.approval==='auto')})));
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
      // Path inputs fill their segment only; GET sends the rest as query, other methods send declared query inputs as query and the rest as JSON.
      const sent=encodeArguments(tool,args),inPath=new Set(placeholders(tool.path)),inQuery=tool.method==='GET'?null:new Set(tool.query || []),params=new URLSearchParams(),body={};let path=actionPath(tool,sent);
      for(const [key,value] of Object.entries(sent)){if(inPath.has(key))continue;if(!inQuery || inQuery.has(key))appendQuery(params,key,value);else body[key]=value;}
      if(params.size)path+=`?${params}`;
      // Node sends a DELETE body without framing, so DELETE carries a body only when it has inputs, with an explicit length.
      const payload=tool.method==='GET' || tool.method==='DELETE' && !Object.keys(body).length?undefined:tool.method==='DELETE'?JSON.stringify(body):body;
      const response=await this.request(integration,{method:tool.method,path,body:payload,signal,maxBytes:maxResponseBytes,...(typeof payload==='string'?{headers:{'Content-Length':String(Buffer.byteLength(payload))}}:{})});
      if(readOnly)ensure(!response.streaming,502,'Workshop API reads require a finite JSON response.');
      result=tool.decode?decodeResponseFields(response.data,tool.decode):response.data;
      if(result?.ok===false)throw new HttpError(502,`The API refused the action: ${this.store.redact(String(result.error || 'service error'))}`);
    }
    if(result?.isError===true)result={...result,error:'The integration reported a failed tool result. Inspect its content and actual service state before any retry.',errorCode:'integration_failed',outcome:'unknown'};
    await this.store.mutate(()=>this.store.audit(result?.isError===true?'integration.failed':'integration.called',`${integration.name}: ${name}`,botId,{integrationId,tool:name}));
    return this.store.redactValue(result);
  }
  invalidate(integrationId){this.sessions.delete(integrationId);}
  async close(){this.sessions.clear();}
}
