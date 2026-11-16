import { HttpError } from './store.mjs';
import { validateServiceUrl, serviceRequest } from './provider-net.mjs';
import { providerFailure } from './provider-failure.mjs';

/**
 * MCP authorization discovery (MCP 2026-07-28 / 2025-11-25 / 2025-06-18, with the 2025-03-26 fallbacks) and automatic client
 * registration. Everything read here is untrusted input from the MCP server or the authorization server it names: every URL
 * passes validateServiceUrl and goes through serviceRequest (pinned DNS, no redirects, bounded size and time), only known fields
 * are read with strict types and caps, and no credential or owner detail is ever sent. A remote document can name a loopback
 * address only when the MCP server itself is on loopback, so a public server cannot point the engine at its own host.
 *
 * Order: an unauthenticated `initialize` probe (its 401 `WWW-Authenticate` gives `resource_metadata` and `scope`), else the
 * protected-resource well-known URIs (path-specific, then root); the first authorization server's metadata from the RFC 8414 /
 * OpenID Connect well-known URIs in the spec's order, with an exact issuer match; without protected-resource metadata, the
 * 2025-03-26 rules: authorization-server metadata at the MCP server's origin, and on its 404 the default /authorize, /token and
 * /register paths there (used only when the server answered the probe with 401 and its /register exists).
 */
export const MAX_DISCOVERY_REQUESTS=8,MAX_DOCUMENT_BYTES=256_000;
export const OAUTH_DISCOVERY_FAILED='oauth_discovery_failed',OAUTH_REGISTRATION_FAILED='oauth_registration_failed';
const LOCAL=new Set(['localhost','127.0.0.1','::1']);
const SCOPE=/^[\x21\x23-\x5b\x5d-\x7e]{1,300}$/,CLIENT=/^[\x21-\x7e]{1,500}$/,SECRET=/^[\x21-\x7e]{1,4096}$/,CODE=/^[\x20-\x7e]{1,80}$/;
const RESERVED=new Set(['client_id','redirect_uri','state','code_challenge','code_challenge_method','response_type','scope','client_secret','resource']);
const USER_AGENT='Tupies/0.5.0',PROTOCOL='2025-06-18';
const object=value=>value && typeof value==='object' && !Array.isArray(value);
const own=(doc,key)=>object(doc) && Object.hasOwn(doc,key)?doc[key]:undefined;
const hostOf=value=>{try{return new URL(value).hostname.replace(/^\[|\]$/g,'').toLowerCase();}catch{return '';}};
const coded=(status,message,code)=>Object.assign(new HttpError(status,message),{code});
export const discoveryFailed=message=>coded(502,message,OAUTH_DISCOVERY_FAILED);
const NO_METADATA='This MCP server does not publish usable sign-in (OAuth) details. It may need a token instead (choose bearer token), or enter the OAuth details by hand with automatic sign-in turned off.';

/** RFC 6750/9728 challenge parameters from a WWW-Authenticate header: resource_metadata and scope, bounded. */
export function parseChallenge(header) {
  const text=(Array.isArray(header)?header.join(', '):String(header ?? '')).slice(0,8192),found={};
  for(const match of text.matchAll(/([A-Za-z][A-Za-z0-9_-]{0,63})\s*=\s*("(?:[^"\\]|\\.){0,4000}"|[^\s,"]{1,4000})/g)){
    const key=match[1].toLowerCase(),value=match[2].startsWith('"')?match[2].slice(1,-1).replace(/\\(.)/g,'$1'):match[2];
    if(['resource_metadata','scope'].includes(key) && !Object.hasOwn(found,key))found[key]=value;
  }
  return {resourceMetadata:found.resource_metadata || '',scopes:found.scope?scopeList(found.scope.split(/\s+/).filter(Boolean)):[]};
}
const scopeList=list=>[...new Set(list.filter(scope=>typeof scope==='string' && SCOPE.test(scope)))].slice(0,40);
/** Protected-resource metadata locations for an MCP endpoint, path-specific first (RFC 9728 §3.1). */
export function resourceMetadataUrls(baseUrl) {
  const url=new URL(baseUrl),path=url.pathname.replace(/\/+$/,''),root=`${url.origin}/.well-known/oauth-protected-resource`;
  return path?[`${root}${path}`,root]:[root];
}
/** Authorization-server metadata locations for an issuer in the order the MCP specification requires. */
export function authorizationServerUrls(issuer) {
  const url=new URL(issuer),path=url.pathname.replace(/\/+$/,'');
  return path?[`${url.origin}/.well-known/oauth-authorization-server${path}`,`${url.origin}/.well-known/openid-configuration${path}`,`${url.origin}${path}/.well-known/openid-configuration`]:[`${url.origin}/.well-known/oauth-authorization-server`,`${url.origin}/.well-known/openid-configuration`];
}
/** RFC 9728/8707: the advertised resource is this MCP endpoint or an ancestor of it on the same origin. */
export function resourceMatches(resource,baseUrl) {
  let a,b;try{a=new URL(resource);b=new URL(baseUrl);}catch{return false;}
  if(a.hash || a.search || a.username || a.password || a.origin!==b.origin)return false;
  const path=a.pathname.replace(/\/+$/,''),target=b.pathname.replace(/\/+$/,'');
  return !path || target===path || target.startsWith(`${path}/`);
}

/** One discovery or registration run: counts its requests and checks every remote URL against the MCP server's network. */
export class OAuthDiscovery {
  constructor({baseUrl,allowPrivateHttp=false,timeoutMs=10_000,signal}={}){this.baseUrl=baseUrl;this.allowPrivateHttp=allowPrivateHttp;this.timeoutMs=timeoutMs;this.signal=signal;this.requests=0;this.local=LOCAL.has(hostOf(baseUrl));}
  /** A URL taken from a remote document: public HTTPS (private HTTP only under the operator setting); loopback only for a loopback MCP server. */
  url(value,label,{query=false}={}) {
    if(typeof value!=='string' || !value || value.length>2000)throw discoveryFailed(`The sign-in metadata has no valid ${label}.`);
    let url;try{url=validateServiceUrl(value,{allowPrivateHttp:this.allowPrivateHttp,allowQuery:query});}catch(error){throw discoveryFailed(`The sign-in metadata names an unsafe ${label} (${error.message})`);}
    if(LOCAL.has(url.hostname.replace(/^\[|\]$/g,'').toLowerCase()) && !this.local)throw discoveryFailed(`The sign-in metadata names a local address as its ${label}, which a remote server may not do.`);
    return url;
  }
  async send(url,{method='GET',body,headers={},json=true,strict=json}={}) {
    if(++this.requests>MAX_DISCOVERY_REQUESTS)throw discoveryFailed('Sign-in discovery needed too many requests and was stopped.');
    let response;
    try{response=await serviceRequest(url,{method,body,signal:this.signal,timeoutMs:this.timeoutMs,maxBytes:MAX_DOCUMENT_BYTES,allowPrivateHttp:this.allowPrivateHttp,headers:{Accept:json?'application/json':'application/json, text/event-stream','User-Agent':USER_AGENT,...headers}});}
    catch(error){
      if(this.signal?.aborted)throw this.signal.reason || error;
      // An answer that arrived but was oversized or not JSON is refused, never skipped as if it were absent.
      const failure=providerFailure(error)?.code;if(strict && ['response_limit','invalid_json'].includes(failure))throw discoveryFailed(`The answer from ${hostOf(url)} was ${failure==='response_limit'?'larger than 256 KB':'not valid JSON'}, so sign-in discovery stopped.`);
      return {status:0,error:error instanceof HttpError?error.message:'network error',data:null,headers:{}};
    }
    const type=String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    return {...response,json:/^application\/([a-z0-9.+-]*\+)?json$/.test(type) && object(response.data)};
  }
  /** A metadata document: 2xx JSON object, or null when absent at this location. A malformed 2xx document is refused. */
  async document(url,label,headers) {
    const response=await this.send(url,{headers});
    if(response.status>=200 && response.status<300){if(!response.json)throw discoveryFailed(`The ${label} is not a JSON object.`);return {data:response.data,status:response.status};}
    return {data:null,status:response.status};
  }

  /** Unauthenticated initialize: 401 with its challenge, or another status. Errors only mean no challenge. */
  async probe() {
    const response=await this.send(this.baseUrl,{method:'POST',json:false,headers:{'Content-Type':'application/json'},body:{jsonrpc:'2.0',id:'tupies-discovery',method:'initialize',params:{protocolVersion:PROTOCOL,capabilities:{},clientInfo:{name:'Tupies',version:'0.5.0'}}}});
    return {status:response.status,...(response.status===401?parseChallenge(response.headers?.['www-authenticate']):{resourceMetadata:'',scopes:[]})};
  }
  async protectedResource(challenge) {
    const tried=new Set();
    for(const location of [...(challenge.resourceMetadata?[challenge.resourceMetadata]:[]),...resourceMetadataUrls(this.baseUrl)]){
      if(tried.has(location))continue;tried.add(location);
      const url=this.url(location,'protected-resource metadata address',{query:location===challenge.resourceMetadata});
      const {data}=await this.document(url.href,'protected-resource metadata');if(!data)continue;
      const resource=own(data,'resource'),servers=own(data,'authorization_servers'),supported=own(data,'scopes_supported');
      if(typeof resource!=='string' || resource.length>2000)throw discoveryFailed('The protected-resource metadata has no resource identifier.');
      if(!resourceMatches(resource,this.baseUrl))throw discoveryFailed(`The protected-resource metadata describes a different resource (${hostOf(resource) || 'unknown'}) than this MCP server, so it is not used.`);
      if(!Array.isArray(servers) || !servers.length || servers.length>20 || typeof servers[0]!=='string')throw discoveryFailed('The protected-resource metadata names no authorization server.');
      if(supported!==undefined && (!Array.isArray(supported) || supported.length>200 || !supported.every(scope=>typeof scope==='string')))throw discoveryFailed('The protected-resource metadata lists its scopes in an invalid form.');
      return {resource,issuer:servers[0],scopes:scopeList(supported || [])};
    }
    return null;
  }
  /** RFC 8414 §3.3 / OIDC Discovery §4.3 validation plus the MCP requirements (PKCE S256, authorization code). */
  authorizationServer(data,issuer,{issuers=[issuer]}={}) {
    const got=own(data,'issuer');
    if(typeof got!=='string' || !issuers.includes(got))throw discoveryFailed('The authorization server metadata names a different issuer than the one it was fetched for, so it is not used.');
    const authorize=this.url(own(data,'authorization_endpoint'),'authorization endpoint',{query:true});
    if([...authorize.searchParams.keys()].some(key=>RESERVED.has(key)))throw discoveryFailed('The authorization endpoint presets sign-in parameters, which is refused.');
    const token=this.url(own(data,'token_endpoint'),'token endpoint');
    const methods=own(data,'code_challenge_methods_supported');
    if(!Array.isArray(methods) || !methods.includes('S256'))throw discoveryFailed('This sign-in server does not declare PKCE with S256, which MCP sign-in requires, so Tupies will not use it.');
    const responses=own(data,'response_types_supported'),grants=own(data,'grant_types_supported');
    if(responses!==undefined && (!Array.isArray(responses) || !responses.includes('code')))throw discoveryFailed('This sign-in server does not offer the authorization-code flow.');
    if(grants!==undefined && (!Array.isArray(grants) || !grants.includes('authorization_code')))throw discoveryFailed('This sign-in server does not offer the authorization-code grant.');
    const registration=own(data,'registration_endpoint')===undefined?'':this.url(own(data,'registration_endpoint'),'registration endpoint').href;
    const supported=own(data,'scopes_supported'),auth=own(data,'token_endpoint_auth_methods_supported');
    return {issuer:got,authorizationUrl:authorize.href,tokenUrl:token.href,registrationUrl:registration,metadataDocument:own(data,'client_id_metadata_document_supported')===true,issParameter:own(data,'authorization_response_iss_parameter_supported')===true,offlineAccess:Array.isArray(supported) && supported.includes('offline_access'),authMethods:Array.isArray(auth)?auth.filter(item=>typeof item==='string').slice(0,20):[]};
  }

  async run() {
    const challenge=await this.probe(),resource=await this.protectedResource(challenge);
    if(resource){
      const issuer=this.url(resource.issuer,'authorization server');
      if(issuer.search)throw discoveryFailed('The authorization server identifier has a query, which is not allowed.');
      for(const location of authorizationServerUrls(resource.issuer)){
        const {data}=await this.document(location,'authorization server metadata');if(!data)continue;
        const server=this.authorizationServer(data,resource.issuer);
        const scopes=challenge.scopes.length?challenge.scopes:resource.scopes;
        return {...server,resource:resource.resource,scopes:server.offlineAccess && scopes.length && !scopes.includes('offline_access')?[...scopes,'offline_access'].slice(0,40):scopes,revision:'2025-06-18'};
      }
      throw discoveryFailed(`The authorization server ${hostOf(resource.issuer)} publishes no usable metadata. ${NO_METADATA}`);
    }
    // 2025-03-26: authorization-server metadata at the MCP server's origin, else default endpoints there.
    const origin=new URL(this.baseUrl).origin,legacy=await this.document(`${origin}/.well-known/oauth-authorization-server`,'authorization server metadata',{'MCP-Protocol-Version':'2025-03-26'});
    if(legacy.data)return {...this.authorizationServer(legacy.data,origin,{issuers:[origin,`${origin}/`]}),resource:this.baseUrl,scopes:challenge.scopes,revision:'2025-03-26'};
    if(legacy.status===404 && challenge.status===401)return {issuer:origin,authorizationUrl:`${origin}/authorize`,tokenUrl:`${origin}/token`,registrationUrl:`${origin}/register`,metadataDocument:false,issParameter:false,offlineAccess:false,authMethods:[],resource:this.baseUrl,scopes:challenge.scopes,revision:'2025-03-26-defaults'};
    throw discoveryFailed(NO_METADATA);
  }

  /** RFC 7591 registration of a public client for exactly this redirect URI. Nothing personal is sent. */
  async register(server,redirectUri) {
    const native=LOCAL.has(hostOf(redirectUri));
    const response=await this.send(server.registrationUrl,{method:'POST',strict:false,headers:{'Content-Type':'application/json'},body:{client_name:'Tupies',redirect_uris:[redirectUri],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',application_type:native?'native':'web'}});
    const defaults=server.revision==='2025-03-26-defaults';
    // Without any metadata, a missing /register means nothing shows that this server signs in with OAuth at all.
    if(defaults && (response.status===0 || [404,405].includes(response.status)))throw discoveryFailed(NO_METADATA);
    const data=response.data,error=typeof own(data,'error')==='string' && CODE.test(data.error)?data.error:'';
    if(response.status<200 || response.status>=300 || !response.json)throw coded(502,`The sign-in server at ${hostOf(server.registrationUrl)} refused to register Tupies as an app (${error || (response.status?`HTTP ${response.status}`:'not reachable')}). Enter a client ID you created with the service instead, or connect it with a token.`,OAUTH_REGISTRATION_FAILED);
    const clientId=own(data,'client_id'),secret=own(data,'client_secret'),method=own(data,'token_endpoint_auth_method'),expires=own(data,'client_secret_expires_at'),uris=own(data,'redirect_uris');
    if(typeof clientId!=='string' || !CLIENT.test(clientId))throw coded(502,'The sign-in server returned an unusable client registration.',OAUTH_REGISTRATION_FAILED);
    if(secret!==undefined && secret!==null && (typeof secret!=='string' || !SECRET.test(secret)))throw coded(502,'The sign-in server returned an unusable client secret.',OAUTH_REGISTRATION_FAILED);
    if(uris!==undefined && (!Array.isArray(uris) || !uris.includes(redirectUri)))throw coded(502,'The sign-in server registered a different return address than Tupies asked for, so the registration is not used.',OAUTH_REGISTRATION_FAILED);
    const seconds=Number(expires);
    return {clientId,clientSecret:typeof secret==='string'?secret:'',tokenAuth:secret && method==='client_secret_basic'?'basic':'body',...(Number.isFinite(seconds) && seconds>0?{expiresAt:new Date(Math.min(seconds*1000,8.64e15)).toISOString()}:{})};
  }
}
