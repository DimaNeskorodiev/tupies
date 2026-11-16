import { ensure, string, id, now } from './store.mjs';
import { validateIntegrationArguments } from './integrations.mjs';
import { memoryWriteAllowed } from './memory-quality.mjs';
import { integrationReady, notConnectedMessage, INTEGRATION_NOT_CONNECTED } from './integration-readiness.mjs';

// A bot that lacks a service proposes the connection itself: base URL, sign-in method and declared actions (or a remote
// MCP server). The owner approves the exact proposal; the engine creates it without credentials and assigns it to the
// proposing bot, and only the owner enters the key or signs in. The model never supplies, reads or keeps a secret.
export const PROPOSAL_TOOL='integration_propose';
export const MAX_INTEGRATIONS=100, MAX_PROPOSED_PER_BOT=12;
const object=value=>value && typeof value==='object' && !Array.isArray(value);
const bounded=(value,max)=>String(value ?? '').slice(0,max);
const text=(description,maxLength)=>({type:'string',description,maxLength});
// Keys that carry a credential. Compared without case, '_' or '-'.
const SECRET_KEYS=new Set(['apikey','key','secret','oauthclientsecret','clientsecret','token','accesstoken','refreshtoken','password','credential','credentials']);
const secretKey=key=>SECRET_KEYS.has(String(key).toLowerCase().replace(/[_-]/g,''));
// Static headers are for fixed, non-secret values such as an API version. A credential header is the owner's.
const SECRET_HEADER=/auth|key|token|secret|passw|cookie|session|signature|credential/i;

export const PROPOSAL_TOOL_DEFINITION={name:PROPOSAL_TOOL,group:'integrations',
  description:'Propose connecting an outside service (REST API actions or a remote MCP server) for yourself, or change one assigned to you. The owner approves it, then enters the key or signs in.',
  parameters:{type:'object',properties:{
    name:text('Service name the owner recognises, such as Gmail.',100),
    type:{type:'string',enum:['rest','mcp'],description:'rest (default): declared API actions. mcp: a remote MCP server; its tools are discovered.'},
    baseUrl:text('HTTPS base URL of the official API, or the MCP endpoint.',2000),
    authType:{type:'string',enum:['bearer','header','oauth2','none'],description:'How the owner signs in: bearer API key, API key in a header, OAuth 2.0, or none.'},
    headerName:text('For header: the API key header name.',100),
    oauth:{type:'object',description:'For oauth2: endpoints and the narrowest scopes. The owner creates the OAuth client.',properties:{
      authorizationUrl:text('HTTPS authorization endpoint.',2000),tokenUrl:text('HTTPS token endpoint.',2000),
      scopes:{type:'array',maxItems:30,items:{type:'string',maxLength:300}},extraParams:{type:'object',description:'Fixed non-secret authorization parameters.',additionalProperties:{type:'string',maxLength:500}},
      tokenAuth:{type:'string',enum:['body','basic']},
    },required:['authorizationUrl','tokenUrl','scopes'],additionalProperties:false},
    headers:{type:'object',description:'Optional fixed non-secret headers, such as an API version.',additionalProperties:{type:'string',maxLength:500}},
    tools:{type:'array',maxItems:64,description:'REST only: the fewest actions; reads (GET) separate from changes.',items:{type:'object',description:'{name,description,method,path:"/fixed/{param}",inputSchema,query?:[args],encode?:{arg:"base64url"},decode?:{keys,as}}'}},
    setupNotes:text('Plain steps for the owner to get the key or OAuth client: where to create it and which scopes to pick.',2000),
    reason:text('Why you need this connection, in one sentence.',500),
    integrationId:text('Change this existing integration assigned to you; omit to add a new one.',100),
  },required:['reason'],additionalProperties:false}};

export const INTEGRATIONS_GUIDANCE='When the owner asks for something in an outside service and no assigned tool, skill or built-in covers it, do not just say you cannot: check integration_list, then propose a connection with integration_propose. Prefer the service’s official REST API or its remote MCP server, and read its documentation with web tools first when unsure of endpoints or scopes. Declare the fewest actions and narrowest scopes that do the job, with reads separate from actions that change things, and write setupNotes as plain steps for the owner. Never ask for keys, passwords or codes in chat: the owner enters them in the connect card under your reply. An entry with ready false exists but waits for the owner; after they confirm, call integration_list again.';
export const INTEGRATIONS_OFF_GUIDANCE='Integrations are turned off for you. If the owner needs an outside service such as mail or a calendar, tell them to turn on Integrations in your settings (Tools); never claim a connection exists.';

/** Only the owner's own direct chat can propose a connection: never routines, teammates, rooms or other people's chats. */
export const proposalAllowed=context=>memoryWriteAllowed(context) && !(context.delegation?.depth>0) && !context.routine;
const refusal=(error,errorCode)=>({error,errorCode,outcome:'not_started',retryable:false});
const groupsInclude=(bot,group)=>Array.isArray(bot?.tools)?bot.tools.includes(group):true;
function credentialIn(args) {
  if(!object(args))return '';
  const top=Object.keys(args).find(secretKey);if(top)return top;
  if(object(args.oauth)){const nested=Object.keys(args.oauth).find(secretKey);if(nested)return `oauth.${nested}`;if(object(args.oauth.extraParams)){const param=Object.keys(args.oauth.extraParams).find(key=>secretKey(key) || SECRET_HEADER.test(key));if(param)return `oauth.extraParams.${param}`;}}
  if(object(args.headers)){const header=Object.keys(args.headers).find(name=>SECRET_HEADER.test(name));if(header)return `headers.${header}`;}
  return '';
}

/**
 * Engine checks before a call's arguments are validated or approved. Returns a model-readable refusal, or null.
 * A proposal never carries a credential and only runs in the owner's direct chat; an integration call to an assigned
 * integration that still waits for the owner's credential is refused before any approval or network activity.
 */
export function integrationPrecheck(state,context,call) {
  if(!groupsInclude(context?.bot,'integrations'))return null;
  if(call?.name===PROPOSAL_TOOL) {
    const credential=credentialIn(call.arguments);
    if(credential)return refusal(`Remove ${credential}: never put keys, client secrets, tokens or passwords in ${PROPOSAL_TOOL}. Only the owner enters credentials, in the connect card after approval.`,'credential_not_allowed');
    if(!proposalAllowed(context))return refusal('A new connection can be proposed only in the owner’s direct chat with you. Report which service you need so the owner can ask you there or add it in Settings → Integrations.','owner_chat_required');
  }
  if(call?.name==='integration_call') {
    const integration=state.integrations?.find(row=>row.id===call.arguments?.integrationId);
    if(integration && (context.bot.integrationIds || []).includes(integration.id) && !integrationReady(integration))return refusal(notConnectedMessage(integration.name,integration.status),INTEGRATION_NOT_CONNECTED);
  }
  return null;
}

const host=value=>{try{return new URL(String(value)).host || bounded(value,120);}catch{return bounded(value,120) || 'an unknown address';}};
const signIn=(authType,headerName,oauth)=>{
  if(authType==='oauth2'){const authorize=host(oauth?.authorizationUrl),token=host(oauth?.tokenUrl);return `OAuth at ${authorize}${token!==authorize?` (tokens from ${token})`:''}`;}
  return authType==='header'?`API key in the ${bounded(headerName || 'x-api-key',100)} header`:authType==='none'?'none':'API key (bearer token)';
};
const isRead=tool=>String(tool?.method || '').toUpperCase()==='GET';
const names=list=>{const shown=list.slice(0,8).map(name=>bounded(name,60));return `${shown.join(', ')}${list.length>8?` and ${list.length-8} more`:''}`;};
const actionCount=tools=>{const reads=tools.filter(isRead).length;return `${tools.length} action${tools.length===1?'':'s'} (${reads} read, ${tools.length-reads} can change things)`;};
const actionShape=tool=>JSON.stringify(['description','method','path','inputSchema','parameters','query','encode','decode'].map(key=>tool?.[key] ?? null));
/** Whether a proposal over `previous` drops its stored credential or OAuth sign-in (the integration service's own rule, plus any OAuth change). */
function dropsCredential(previous,args) {
  if(!previous)return false;
  const authType=args.authType || previous.authType,headerName=authType==='header'?args.headerName || previous.headerName || 'x-api-key':undefined;
  const moved=(args.baseUrl!==undefined && String(args.baseUrl).replace(/\/+$/,'')!==previous.baseUrl) || authType!==previous.authType || headerName!==previous.headerName;
  return Boolean((previous.secret || previous.oauthSecret || previous.oauth?.connected) && (moved || Object.hasOwn(args,'oauth')));
}

/** One plain line for the approval card. The host is what the owner trusts, so the API and sign-in hosts are always named. */
export function proposalApprovalSummary(state,args) {
  const a=object(args)?args:{},quoted=value=>`“${bounded(value,100)}”`;
  const previous=typeof a.integrationId==='string'?state.integrations?.find(item=>item.id===a.integrationId):null;
  const type=a.type || previous?.type || 'rest',authType=a.authType || previous?.authType || 'bearer',oauth=object(a.oauth)?a.oauth:previous?.oauth;
  const tools=Array.isArray(a.tools)?a.tools.filter(object):previous?.tools || [];
  const login=`Sign-in: ${signIn(authType,a.headerName || previous?.headerName,oauth)}.`;
  const actions=type==='mcp'?'an MCP server; its tools are discovered after you connect it':actionCount(tools);
  if(!previous)return `Add a connection ${quoted(a.name || 'unnamed')} to ${host(a.baseUrl)} — ${actions}. ${login}${authType==='none'?'':' You enter the key or sign in yourself afterwards.'}`;
  const changes=[];
  if(a.name!==undefined && a.name!==previous.name)changes.push(`rename it ${quoted(a.name)}`);
  if(a.baseUrl!==undefined && String(a.baseUrl).replace(/\/+$/,'')!==previous.baseUrl)changes.push(`move it to ${host(a.baseUrl)}`);
  if(a.authType!==undefined && a.authType!==previous.authType || a.headerName!==undefined || a.oauth!==undefined)changes.push('change its sign-in');
  if(a.headers!==undefined)changes.push('change its fixed headers');
  if(Array.isArray(a.tools)) {
    const before=new Map((previous.tools || []).map(tool=>[tool.name,tool])),after=new Map(tools.map(tool=>[String(tool.name),tool]));
    const added=[...after.keys()].filter(name=>!before.has(name)),removed=[...before.keys()].filter(name=>!after.has(name)),changed=[...after.keys()].filter(name=>before.has(name) && actionShape(before.get(name))!==actionShape(after.get(name)));
    if(added.length)changes.push(`add ${names(added)}`);if(changed.length)changes.push(`change ${names(changed)}`);if(removed.length)changes.push(`remove ${names(removed)}`);
    changes.push(`then ${actionCount(tools)}`);
  }
  if(a.setupNotes!==undefined)changes.push('update its setup notes');
  return `Change the connection ${quoted(previous.name)} at ${host(previous.baseUrl)}${changes.length?`: ${changes.join(', ')}`:''}. ${login}${dropsCredential(previous,a)?' Its saved key or sign-in will be removed and you connect it again.':''}`;
}

function proposalInput(args) {
  const input={};
  for(const key of ['type','name','baseUrl','authType','headerName','oauth','headers','tools'])if(Object.hasOwn(args,key))input[key]=structuredClone(args[key]);
  return input;
}
function checkArguments(args) {
  const credential=credentialIn(args);
  ensure(!credential,400,`Remove ${credential}: only the owner enters credentials, in the connect card after approval.`);
  validateIntegrationArguments(args,PROPOSAL_TOOL_DEFINITION.parameters);
  ensure(!object(args.headers) || Object.keys(args.headers).length<=8,400,'Declare at most 8 fixed headers.');
  ensure(!object(args.oauth?.extraParams) || Object.keys(args.oauth.extraParams).length<=10,400,'Declare at most 10 extra OAuth parameters.');
  for(const tool of Array.isArray(args.tools)?args.tools:[])ensure(!object(tool) || tool.approval===undefined || tool.approval==='ask',403,'Only the owner can let an action run without asking, in Settings → Integrations. Omit approval.');
  ensure(args.oauth===undefined || (args.authType ?? 'oauth2')==='oauth2',400,'oauth applies only to authType oauth2.');
  ensure(args.headerName===undefined || (args.authType ?? 'header')==='header',400,'headerName applies only to authType header.');
}
const statusOf=integration=>!integrationReady(integration)?'needs_credentials':integration.type==='rest'?'configured':integration.tools?.length?'connected':'untested';
const how=authType=>authType==='oauth2'?'oauth':authType==='none'?'none':'api_key';
const connectRequired=integration=>!integrationReady(integration) || integration.type==='mcp' && !integration.tools?.length;

/** Runs an approved proposal. The caller has checked the tool is enabled, the lane and the owner's exact approval. */
export async function executeIntegrationProposal(agentTools,bot,args,{runId,signal}={}) {
  const store=agentTools.store,integrations=agentTools.options.integrations;
  ensure(integrations,409,'No integration service is configured.');
  checkArguments(args);
  const input=proposalInput(args),reason=store.redact(string(args.reason,'Reason',500));
  const setupNotes=Object.hasOwn(args,'setupNotes')?store.redact(string(args.setupNotes,'Setup notes',2000,false)):undefined;
  if(Object.hasOwn(input,'name'))input.name=store.redact(string(input.name,'Integration name',100));
  const integrationId=args.integrationId===undefined?'':string(args.integrationId,'Integration id',100);
  if(!integrationId) {
    for(const key of ['name','baseUrl','authType'])ensure(Object.hasOwn(args,key),400,`Give the new connection its ${key}.`);
    ensure(args.authType==='none' || setupNotes?.trim(),400,'Write setupNotes: plain steps for the owner to get the key or OAuth client.');
    input.type ||= 'rest';
  } else ensure(Object.keys(input).length || setupNotes!==undefined,400,'Say what to change about the connection.');
  signal?.throwIfAborted();
  const by={botId:bot.id,botName:bot.name,...(runId?{runId}:{}),at:now()};
  let saved,dropped=false;
  await store.mutate(state=>{
    state.integrations ||= [];
    const current=state.bots.find(item=>item.id===bot.id);ensure(current,404,'Bot not found.');
    if(integrationId) {
      const index=state.integrations.findIndex(item=>item.id===integrationId);ensure(index>=0,404,'Integration not found. Use integration_list for ids.');
      ensure([bot,current].every(item=>(item.integrationIds || []).includes(integrationId)),403,'You can change only an integration assigned to you.');
      const previous=state.integrations[index];dropped=dropsCredential(previous,args);
      const updated=integrations.validate(input,previous,{allowMissingCredential:true});
      // Changing OAuth endpoints or scopes needs a fresh owner sign-in: stored tokens never carry over.
      if(dropped){delete updated.secret;delete updated.oauthSecret;if(object(updated.oauth))updated.oauth={...updated.oauth,connected:false};}
      saved={...updated,id:previous.id,createdAt:previous.createdAt,updatedAt:now(),...(setupNotes!==undefined?{setupNotes}:{}),reason,changedBy:by};
      saved.status=statusOf(saved);delete saved.error;
      state.integrations[index]=saved;
      store.audit('integration.proposal_applied',`${bot.name} changed ${saved.name}`,bot.id,{integrationId,source:'agent',...(runId?{runId}:{})});
    } else {
      ensure(state.integrations.length<MAX_INTEGRATIONS,400,'You can save up to 100 integrations. Ask the owner to remove unused ones.');
      ensure(state.integrations.filter(item=>item.proposedBy?.botId===bot.id).length<MAX_PROPOSED_PER_BOT,400,`You have already proposed ${MAX_PROPOSED_PER_BOT} connections. Ask the owner to remove unused ones in Settings → Integrations.`);
      const validated=integrations.validate(input,{},{allowMissingCredential:true});
      saved={...validated,id:id('integration'),createdAt:now(),proposedBy:by,setupNotes:setupNotes || '',reason};
      saved.status=statusOf(saved);
      state.integrations.push(saved);current.integrationIds=[...new Set([...(current.integrationIds || []),saved.id])];
      store.audit('integration.proposed',`${bot.name} added ${saved.name}`,bot.id,{integrationId:saved.id,source:'agent',...(runId?{runId}:{})});
    }
  });
  integrations.invalidate?.(saved.id);
  // The running task may use its new connection once the owner connects it; only this approved assignment is added.
  bot.integrationIds=[...new Set([...(bot.integrationIds || []),saved.id])];
  const required=connectRequired(saved);
  const notice=required?`The owner must now connect “${saved.name}” in the card under this reply or in Settings → Integrations${saved.type==='mcp' && integrationReady(saved)?' (Test discovers its tools)':''}. Never ask for keys, passwords or codes in chat. After the owner confirms, call integration_list and continue.`
    :`“${saved.name}” is ready. Call integration_list and use its actions with integration_call; each call still needs approval.`;
  return {integrationId:saved.id,name:saved.name,type:saved.type,status:saved.status,authType:saved.authType,actions:(saved.tools || []).map(tool=>tool.name),connect:{required,how:how(saved.authType)},...(dropped?{credentialRemoved:true}:{}),notice};
}

/** What a finished reply needs to show a “Connect <name>” card: integrations this run proposed or changed that still wait for the owner. */
export function connectionRequests(state,run) {
  if(!run?.id)return [];
  return (state.integrations || []).filter(item=>(item.proposedBy?.runId===run.id || item.changedBy?.runId===run.id) && connectRequired(item)).slice(0,5).map(item=>({integrationId:item.id,name:item.name,how:how(item.authType)}));
}
