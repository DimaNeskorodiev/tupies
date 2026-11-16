import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { HttpError, ensure, string, now, id } from './store.mjs';
import { validateServiceUrl, serviceRequest } from './provider-net.mjs';
import { OAuthDiscovery } from './integration-oauth-discovery.mjs';

/**
 * OAuth 2.0 authorization-code sign-in (PKCE S256) for owner-declared integrations, REST and MCP alike.
 * Non-secret settings live in `integration.oauth`; the client secret and tokens live sealed in `integration.oauthSecret`
 * as one JSON bundle {client_secret?, access_token?, refresh_token?}. token_type is not stored: only Bearer is accepted, and the
 * store's redaction treats every value under a key containing "token" as a secret, so storing "Bearer" would redact that word everywhere. `oauth.connected` is true exactly when
 * an access or refresh token is stored. Endpoints are fixed by the owner (or a bot proposal the owner approved), or, for an MCP
 * server with `oauth.auto`, found by MCP authorization discovery and client registration when the owner asks for it
 * (integration-oauth-discovery.mjs). Discovery never runs on its own: a changed sign-in server needs the owner's action again.
 */
export const OAUTH_CALLBACK_PATH='/api/integrations/oauth/callback',OAUTH_CLIENT_METADATA_PATH='/api/integrations/oauth/client.json';
const RESERVED_PARAMS=new Set(['client_id','redirect_uri','state','code_challenge','code_challenge_method','response_type','scope','client_secret']);
const ATTEMPT_MS=600_000,REFRESH_MARGIN_MS=60_000;
const TOKEN=/^[\x21-\x7e]{1,16384}$/,SCOPE=/^[\x21\x23-\x5b\x5d-\x7e]{1,300}$/,PARAM=/^[A-Za-z0-9_.-]{1,64}$/,CONTROL=/[\x00-\x1f\x7f]/;
const REAUTH_ERRORS=new Set(['invalid_grant','invalid_client','unauthorized_client']);
const object=value=>value && typeof value==='object' && !Array.isArray(value);
const opaque=()=>randomBytes(32).toString('base64url');
const digest=value=>createHash('sha256').update(String(value ?? '')).digest('hex');
const equal=(a,b)=>{if(typeof a!=='string' || typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);};
const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const providerCode=data=>typeof data?.error==='string' && /^[\x20-\x7e]{1,80}$/.test(data.error)?data.error:'';
const providerDetail=data=>typeof data?.error_description==='string'?data.error_description.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,200):'';
const needsSignIn=name=>`${name} needs the owner to sign in again in Settings → Integrations.`;
const coded=(status,message,code)=>Object.assign(new HttpError(status,message),{code});
const pick=(source,keys)=>Object.fromEntries(keys.filter(key=>source[key]!==undefined && source[key]!=='' && source[key]!==false).map(key=>[key,source[key]]));
// Settings that only discovery and registration write while automatic sign-in is on.
const DISCOVERED=['authorizationUrl','tokenUrl','tokenAuth','issuer','resource','registration','discoveredAt','registeredRedirectUri','issParameter','registrationExpiresAt'],AUTO_DEFAULTS={authorizationUrl:'',tokenUrl:'',tokenAuth:'body'};
function scopeInput(value){
  let scopes=value ?? [];if(typeof scopes==='string')scopes=scopes.split(/\s+/).filter(Boolean);
  ensure(Array.isArray(scopes) && scopes.length<=40 && scopes.every(scope=>typeof scope==='string' && SCOPE.test(scope)),400,'Use up to 40 OAuth scopes of 1–300 printable characters without spaces or quotes.');
  return [...new Set(scopes)];
}
function extraInput(extra=({}),{auto=false}={}){
  extra ??= {};ensure(object(extra) && Object.keys(extra).length<=8,400,'Use up to 8 extra authorization parameters.');
  const extraParams={};
  for(const [key,item] of Object.entries(extra)){
    ensure(PARAM.test(key) && !['__proto__','prototype','constructor'].includes(key),400,'Extra authorization parameter names may use letters, numbers, _, . and -.');
    ensure(!RESERVED_PARAMS.has(key) && !(auto && key==='resource'),400,`${key} is set by Tupies and cannot be an extra authorization parameter.`);
    ensure(['string','number','boolean'].includes(typeof item) && String(item).length<=500 && !CONTROL.test(String(item)),400,'Extra authorization parameter values must be short text.');
    extraParams[key]=String(item);
  }
  return extraParams;
}
function secretInput(input,current){
  if(input.oauthClientSecret===null)return '';
  if(!input.oauthClientSecret)return current;
  const secret=string(input.oauthClientSecret,'OAuth client secret',4096);ensure(!CONTROL.test(secret),400,'Credentials cannot contain control characters.');return secret;
}

/** The redirect base: the configured public HTTPS origin, otherwise the loopback address this engine serves. Never a request Host header. */
export function oauthRedirectBase({publicOrigin='',scheme='http',address='127.0.0.1',port}={}){
  if(publicOrigin)return publicOrigin;
  ensure(Number.isInteger(port) && port>0,503,'The engine is not listening yet, so it has no sign-in return address.');
  return `${scheme}://${['::1','::'].includes(address)?'[::1]':'127.0.0.1'}:${port}`;
}
/** A small self-contained page for the provider's top-level redirect. Everything is escaped and no credential is shown. */
export function oauthResultPage({ok,title,message}){
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>Integration sign-in · Tupies</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f6f8;color:#1d2330}main{max-width:32rem;padding:2rem;background:#fff;border-radius:16px;box-shadow:0 4px 24px #0001}h1{font-size:1.3rem;margin:0 0 .5rem;color:${ok?'#17643a':'#9b1c1c'}}</style><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></html>`;
}

export class IntegrationOAuth {
  constructor(store,integrations,options={}){this.store=store;this.integrations=integrations;this.options=options;this.pending=new Map();this.refreshes=new Map();this.redirectBase=options.oauthRedirectBase?()=>options.oauthRedirectBase:null;this.discovering=new Map();}
  allowPrivateHttp(){return this.integrations.options.allowPrivateHttp ?? process.env.STUDIO_ALLOW_PRIVATE_HTTP==='true';}
  redirectUri(){const base=this.redirectBase?.();ensure(base,503,'This engine has no sign-in return address yet.');return `${base}${OAUTH_CALLBACK_PATH}`;}
  tokens(integration){if(!integration?.oauthSecret)return {};try{const value=JSON.parse(this.store.unseal(integration.oauthSecret));return object(value)?value:{};}catch{throw new HttpError(500,`Stored sign-in for ${integration.name} could not be read. Disconnect it and sign in again.`);}}
  seal(bundle){const clean=Object.fromEntries(Object.entries(bundle).filter(([,value])=>typeof value==='string' && value));return Object.keys(clean).length?this.store.seal(JSON.stringify(clean)):undefined;}
  current(integrationId){const integration=this.store.state.integrations?.find(item=>item.id===integrationId);ensure(integration,404,'Integration not found.');return integration;}

  /**
   * The auth part of Integrations.validate. Endpoint, client or client-secret changes forget stored tokens, like an endpoint change
   * forgets an API key. A scope-only change keeps the tokens and sets `oauth.reauthSuggested` until the next sign-in grants them.
   * An MCP server with `oauth.auto` (the default for an MCP server whose oauth settings are omitted) takes its endpoints and client
   * from discovery only; a new address or turning automatic sign-in on forgets discovery, registration and tokens.
   */
  validate(input,previous,value){
    if(value.authType!=='oauth2'){delete value.oauth;delete value.oauthSecret;return;}
    const before=previous.authType==='oauth2' && object(previous.oauth)?previous.oauth:{},given=input.oauth;
    ensure(given===undefined || object(given),400,'OAuth settings must be an object.');
    const requested=given && Object.hasOwn(given,'auto')?given.auto:undefined;ensure(requested===undefined || typeof requested==='boolean',400,'OAuth auto must be true or false.');
    const auto=requested ?? (previous.authType==='oauth2'?before.auto===true:value.type==='mcp' && given===undefined);
    ensure(!auto || value.type==='mcp',400,'Automatic sign-in discovery works only for MCP servers. Give the OAuth endpoints of a REST API.');
    if(auto)return this.validateAuto(input,previous,value,before,given || {});
    const field=key=>given && Object.hasOwn(given,key)?given[key]:before[key];
    const allowPrivateHttp=this.allowPrivateHttp();
    ensure(field('authorizationUrl')!==undefined,400,'Give the OAuth authorization and token URLs. Automatic sign-in discovery works only for MCP servers.');
    const authorizationUrl=string(field('authorizationUrl') ?? '','OAuth authorization URL',2000);validateServiceUrl(authorizationUrl,{allowPrivateHttp,allowQuery:true});
    ensure(![...new URL(authorizationUrl).searchParams.keys()].some(key=>RESERVED_PARAMS.has(key)),400,'The authorization URL cannot preset sign-in parameters such as client_id, redirect_uri, state or scope.');
    const tokenUrl=string(field('tokenUrl') ?? '','OAuth token URL',2000);validateServiceUrl(tokenUrl,{allowPrivateHttp});
    const scopes=scopeInput(field('scopes')),extraParams=extraInput(field('extraParams'));
    const tokenAuth=field('tokenAuth') ?? 'body';ensure(['body','basic'].includes(tokenAuth),400,'Client authentication must be body or basic.');
    const clientId=field('clientId') ?? '';ensure(typeof clientId==='string' && clientId.trim().length<=500 && !CONTROL.test(clientId),400,'The OAuth client ID must be up to 500 characters.');
    const stored=previous.authType==='oauth2'?this.tokens(previous):{},clientSecret=secretInput(input,stored.client_secret || '');
    const drop=previous.authType!=='oauth2' || value.baseUrl!==previous.baseUrl || authorizationUrl!==before.authorizationUrl || tokenUrl!==before.tokenUrl || clientId.trim()!==(before.clientId || '') || clientSecret!==(stored.client_secret || '');
    // Turning automatic sign-in off keeps the discovered audience and issuer while the endpoints stay the same.
    const kept=!drop || previous.authType==='oauth2' && value.baseUrl===previous.baseUrl && authorizationUrl===before.authorizationUrl && tokenUrl===before.tokenUrl?pick(before,['issuer','resource','issParameter']):{};
    this.settle(previous,value,before,{authorizationUrl,tokenUrl,scopes,clientId:clientId.trim(),extraParams,tokenAuth,...kept},stored,clientSecret,drop);
  }
  validateAuto(input,previous,value,before,given){
    const fresh=previous.authType!=='oauth2' || before.auto!==true || value.baseUrl!==previous.baseUrl,found=fresh?{}:before;
    for(const key of DISCOVERED)ensure(!Object.hasOwn(given,key) || JSON.stringify(given[key] ?? '')===JSON.stringify(found[key] ?? AUTO_DEFAULTS[key] ?? ''),400,'With automatic sign-in the sign-in addresses come from the server. Prepare sign-in again, or turn automatic sign-in off to edit them.');
    const manual=found.registration==='manual_required',stored=fresh?{}:this.tokens(previous);let clientId=found.clientId || '';
    if(Object.hasOwn(given,'clientId') && given.clientId!==clientId){
      ensure(manual,400,found.registration?'Tupies registered its own client for this server. Turn automatic sign-in off to use another client ID.':'Prepare sign-in first; a client ID is needed only when the server cannot register Tupies itself.');
      ensure(typeof given.clientId==='string' && given.clientId.trim().length<=500 && !CONTROL.test(given.clientId),400,'The OAuth client ID must be up to 500 characters.');clientId=given.clientId.trim();
    }
    ensure(input.oauthClientSecret===undefined || manual,400,'Tupies registered its own client for this server, so there is no client secret to enter.');
    const clientSecret=manual?secretInput(input,stored.client_secret || ''):stored.client_secret || '';
    const scopes=scopeInput(Object.hasOwn(given,'scopes')?given.scopes:found.scopes),extraParams=extraInput(Object.hasOwn(given,'extraParams')?given.extraParams:found.extraParams,{auto:true});
    const drop=fresh || clientId!==(before.clientId || '') || clientSecret!==(stored.client_secret || '');
    this.settle(previous,value,before,{auto:true,authorizationUrl:found.authorizationUrl || '',tokenUrl:found.tokenUrl || '',scopes,clientId,extraParams,tokenAuth:found.tokenAuth || 'body',...(found.discoveredAt?pick(found,['issuer','resource','registration','discoveredAt','registeredRedirectUri','issParameter','registrationExpiresAt']):{})},stored,clientSecret,drop);
  }
  /** Stores the settings, keeping tokens unless `drop`; a connected scope change suggests a new sign-in. */
  settle(previous,value,before,settings,stored,clientSecret,drop){
    const bundle=drop?{client_secret:clientSecret}:{...stored,client_secret:clientSecret};
    const connected=!!(bundle.access_token || bundle.refresh_token);
    const scopesChanged=connected && JSON.stringify(settings.scopes)!==JSON.stringify(before.scopes || []);
    value.oauth={...settings,connected,...(connected?{connectionId:before.connectionId,...(before.connectedAt?{connectedAt:before.connectedAt}:{}),...(before.expiresAt?{expiresAt:before.expiresAt}:{}),...(scopesChanged || before.reauthSuggested?{reauthSuggested:true}:{})}:{})};
    const sealed=this.seal(bundle);if(sealed)value.oauthSecret=sealed;else delete value.oauthSecret;
    if(drop)this.integrations.invalidate?.(previous.id);
  }
  /** Status after a save: connected with tokens; a pending re-sign-in stays visible until the owner signs in or changes the client. */
  statusOf(value,previous={}){return value.oauth?.connected?'connected':previous.status==='needs_reauth' && previous.authType==='oauth2' && previous.oauth?.clientId===value.oauth?.clientId && previous.oauth?.tokenUrl===value.oauth?.tokenUrl?'needs_reauth':'needs_credentials';}
  /** Fingerprint material: endpoints, client and the connection id, never the rotating tokens. */
  identity(integration){const oauth=integration.oauth || {};return {authorizationUrl:oauth.authorizationUrl,tokenUrl:oauth.tokenUrl,clientId:oauth.clientId,scopes:oauth.scopes,connectionId:oauth.connectionId || '',...(oauth.auto || oauth.issuer || oauth.resource?{auto:oauth.auto===true,issuer:oauth.issuer || '',resource:oauth.resource || ''}:{})};}
  configKey(integration){const oauth=integration.oauth || {};return digest(JSON.stringify([integration.baseUrl,integration.authType,oauth.authorizationUrl,oauth.tokenUrl,oauth.clientId,oauth.scopes,oauth.extraParams,oauth.tokenAuth,digest(this.tokens(integration).client_secret),oauth.auto===true,oauth.issuer || '',oauth.resource || '',oauth.registeredRedirectUri || '']));}
  /** The client ID metadata document URL: only with a public HTTPS origin, which an authorization server can fetch. */
  clientMetadataUrl(){const origin=this.publicOrigin ?? this.options.oauthPublicOrigin ?? '';return /^https:\/\/[^/?#]+$/.test(origin)?`${origin}${OAUTH_CLIENT_METADATA_PATH}`:'';}
  /** The client ID metadata document (draft-ietf-oauth-client-id-metadata-document): static, nothing beyond the public origin and the return address. */
  clientMetadata(){const clientId=this.clientMetadataUrl();return clientId?{client_id:clientId,client_name:'Tupies',redirect_uris:[this.redirectUri()],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'}:null;}
  /** Whether the stored client still fits this sign-in server and this engine's return address. */
  usableClient(oauth,server,redirectUri){
    if(!oauth.clientId || oauth.issuer!==server.issuer)return false;
    if(oauth.registration==='manual_required')return true;
    if(oauth.registration==='metadata_document')return server.metadataDocument && oauth.clientId===this.clientMetadataUrl() && oauth.registeredRedirectUri===redirectUri;
    return oauth.registration==='dynamic' && oauth.registeredRedirectUri===redirectUri && !(Date.parse(oauth.registrationExpiresAt || '')<=Date.now()+REFRESH_MARGIN_MS);
  }

  /**
   * Owner-requested MCP authorization discovery and client registration. Idempotent: endpoints are refreshed; a client is
   * registered only when none fits the current sign-in server and return address. A different sign-in server, audience or client
   * forgets the tokens, so the owner sees the new hosts and signs in again; nothing here is ever triggered by a bot or a 401.
   */
  discover(integrationId){
    if(this.discovering.has(integrationId))return this.discovering.get(integrationId);
    const task=this.runDiscovery(integrationId).finally(()=>this.discovering.delete(integrationId));
    this.discovering.set(integrationId,task);return task;
  }
  async runDiscovery(integrationId){
    const integration=this.current(integrationId),oauth=integration.oauth || {};
    if(integration.type!=='mcp' || integration.authType!=='oauth2' || oauth.auto!==true)throw coded(409,'Automatic sign-in discovery is only for MCP servers set to sign in automatically.','not_auto_oauth');
    const snapshot=this.configKey(integration),redirectUri=this.redirectUri();
    const discovery=new OAuthDiscovery({baseUrl:integration.baseUrl,allowPrivateHttp:this.allowPrivateHttp(),timeoutMs:this.options.oauthDiscoveryTimeout || 10_000,signal:AbortSignal.timeout(this.options.oauthDiscoveryBudget || 60_000)});
    let server;
    try{server=await discovery.run();}
    catch(error){throw error.code?Object.assign(new HttpError(error.status || 502,this.store.redact(error.message)),{code:error.code}):coded(502,'Sign-in discovery could not reach the server. Check the address and try again.','oauth_discovery_failed');}
    const stored=this.tokens(integration);let client,registered=false;
    if(this.usableClient(oauth,server,redirectUri))client={clientId:oauth.clientId,clientSecret:stored.client_secret || '',tokenAuth:oauth.tokenAuth || 'body',registration:oauth.registration,registeredRedirectUri:oauth.registeredRedirectUri || '',...(oauth.registrationExpiresAt?{expiresAt:oauth.registrationExpiresAt}:{})};
    else if(server.metadataDocument && this.clientMetadataUrl())client={clientId:this.clientMetadataUrl(),clientSecret:'',tokenAuth:'body',registration:'metadata_document',registeredRedirectUri:redirectUri};
    else if(server.registrationUrl){
      try{client={...await discovery.register(server,redirectUri),registration:'dynamic',registeredRedirectUri:redirectUri};registered=true;}
      catch(error){throw error.code?Object.assign(new HttpError(error.status || 502,this.store.redact(error.message)),{code:error.code}):coded(502,'The sign-in server could not register Tupies right now. Try again shortly.','oauth_registration_failed');}
    }
    // A client ID the owner entered belongs to one sign-in server; it is kept only while that server stays the same.
    else client={clientId:oauth.registration==='manual_required' && oauth.issuer===server.issuer?oauth.clientId || '':'',clientSecret:oauth.registration==='manual_required' && oauth.issuer===server.issuer?stored.client_secret || '':'',tokenAuth:'body',registration:'manual_required',registeredRedirectUri:''};
    const result=await this.store.mutate(state=>{
      const current=state.integrations.find(item=>item.id===integrationId);
      ensure(current && this.configKey(current)===snapshot,409,'The integration changed while its sign-in was being prepared. Try again.');
      const before=current.oauth,same=before.issuer===server.issuer && before.authorizationUrl===server.authorizationUrl && before.tokenUrl===server.tokenUrl && before.resource===server.resource && before.clientId===client.clientId && (stored.client_secret || '')===client.clientSecret && (before.tokenAuth || 'body')===client.tokenAuth;
      const keep=same && before.connected,bundle={client_secret:client.clientSecret,...(keep?{access_token:stored.access_token,refresh_token:stored.refresh_token}:{})};
      const sealed=this.seal(bundle);if(sealed)current.oauthSecret=sealed;else delete current.oauthSecret;
      const scopesChanged=keep && JSON.stringify(server.scopes)!==JSON.stringify(before.scopes || []);
      current.oauth={auto:true,authorizationUrl:server.authorizationUrl,tokenUrl:server.tokenUrl,scopes:server.scopes,clientId:client.clientId,extraParams:before.extraParams || {},tokenAuth:client.tokenAuth,issuer:server.issuer,resource:server.resource,registration:client.registration,discoveredAt:now(),registeredRedirectUri:client.registeredRedirectUri,...(server.issParameter?{issParameter:true}:{}),...(client.expiresAt?{registrationExpiresAt:client.expiresAt}:{}),connected:keep,
        ...(keep?{connectionId:before.connectionId,...pick(before,['connectedAt','expiresAt']),...(scopesChanged || before.reauthSuggested?{reauthSuggested:true}:{})}:{})};
      if(!keep){current.status='needs_credentials';delete current.error;}
      const host=value=>new URL(value).host;
      this.store.audit('integration.oauth_discovered',`${current.name} sign-in found at ${host(server.authorizationUrl)}`,null,{integrationId,authorizationHost:host(server.authorizationUrl),tokenHost:host(server.tokenUrl),registration:client.registration});
      if(registered)this.store.audit('integration.oauth_registered',`Tupies registered as an app at ${host(server.registrationUrl)} for ${current.name}`,null,{integrationId,registrationHost:host(server.registrationUrl)});
      return {integration:this.store.integrationPublic(current),authorizationHost:host(server.authorizationUrl),tokenHost:host(server.tokenUrl),issuer:server.issuer,scopes:server.scopes,registration:client.registration,registered,changed:!same};
    });
    if(result.changed){this.pending.delete(integrationId);this.integrations.invalidate?.(integrationId);}
    delete result.changed;return result;
  }

  async start(integrationId){
    const integration=this.current(integrationId);
    ensure(integration.authType==='oauth2' && object(integration.oauth),409,'This integration does not use OAuth sign-in.');
    const oauth=integration.oauth,redirectUri=this.redirectUri();
    // Automatic sign-in sends the owner only to a sign-in host they were shown, registered for this return address.
    if(oauth.auto && !oauth.discoveredAt)throw coded(409,'Prepare the sign-in first, so you can see where it will take you.','oauth_discovery_required');
    if(oauth.auto && oauth.registration!=='manual_required' && oauth.registeredRedirectUri!==redirectUri)throw coded(409,'This engine’s sign-in return address changed since Tupies registered with the server. Prepare the sign-in again.','oauth_discovery_required');
    ensure(oauth.clientId,409,'Add the OAuth client ID from the provider before signing in.');
    const attempt={integrationId,state:opaque(),verifier:opaque(),redirectUri,configKey:this.configKey(integration),issuer:oauth.issuer || '',issRequired:oauth.issParameter===true,expiresAt:Date.now()+ATTEMPT_MS};
    for(const [key,item] of this.pending)if(item.expiresAt<=Date.now())this.pending.delete(key);
    // One attempt per integration: starting again retires the previous link.
    this.pending.set(integrationId,attempt);
    const url=new URL(integration.oauth.authorizationUrl);
    for(const [key,item] of Object.entries(integration.oauth.extraParams || {}))url.searchParams.set(key,item);
    const params={response_type:'code',client_id:oauth.clientId,redirect_uri:redirectUri,...(oauth.scopes?.length?{scope:oauth.scopes.join(' ')}:{}),...(oauth.resource?{resource:oauth.resource}:{}),state:attempt.state,code_challenge:createHash('sha256').update(attempt.verifier).digest('base64url'),code_challenge_method:'S256'};
    for(const [key,item] of Object.entries(params))url.searchParams.set(key,item);
    return {authorizationUrl:url.href,redirectUri,expiresAt:new Date(attempt.expiresAt).toISOString()};
  }
  /** Finishes an attempt from the provider redirect (or a pasted copy of it). The state is consumed before the code is exchanged. */
  async callback(params,{integrationId}={}){
    ensure(object(params) && typeof params.state==='string' && params.state.length<=200,400,'This sign-in response has no valid state. Start the connection again in Tupies.');
    const attempt=[...this.pending.values()].find(item=>equal(item.state,params.state));
    ensure(attempt,400,'This sign-in link is expired or was already used. Start the connection again in Tupies.');
    this.pending.delete(attempt.integrationId);
    const verifier=attempt.verifier;attempt.verifier='';
    ensure(attempt.expiresAt>Date.now(),400,'This sign-in link is expired or was already used. Start the connection again in Tupies.');
    ensure(!integrationId || integrationId===attempt.integrationId,400,'This sign-in response belongs to a different integration. Start the connection again.');
    const integration=this.store.state.integrations?.find(item=>item.id===attempt.integrationId);
    ensure(integration && integration.authType==='oauth2' && this.configKey(integration)===attempt.configKey,409,'The integration settings changed while signing in. Start the connection again.');
    // RFC 9207: a response from another issuer is dropped before its code or error is used (MCP 2026-07-28 mix-up defence).
    if(typeof params.iss==='string')ensure(!attempt.issuer || params.iss===attempt.issuer,400,'This sign-in response came from a different sign-in server than the one you were shown. Start the connection again.');
    else ensure(!attempt.issRequired,400,'This sign-in response did not name its sign-in server, which this server promised to do. Start the connection again.');
    if(params.error){const code=providerCode(params);throw new HttpError(400,code==='access_denied'?'Sign-in was declined at the provider.':`The provider did not complete the sign-in${code?` (${code})`:''}.`);}
    ensure(typeof params.code==='string' && params.code.length>0 && params.code.length<=10_000,400,'The sign-in response is missing its authorization code.');
    const stored=this.tokens(integration);
    let response;
    try{response=await this.token(integration,stored,{grant_type:'authorization_code',code:params.code,redirect_uri:attempt.redirectUri,code_verifier:verifier});}
    catch(error){throw new HttpError(502,this.store.redact(`The provider's token endpoint could not be reached (${error instanceof HttpError?error.message:'network error'}). Start the connection again.`));}
    const code=providerCode(response.data);
    if(response.status<200 || response.status>=300 || code){const detail=providerDetail(response.data);throw new HttpError(502,this.store.redact(`The provider did not accept the sign-in (${code || `HTTP ${response.status}`}${detail?`: ${detail}`:''}). Start the connection again.`));}
    const tokens=this.parse(response.data,{});
    const name=await this.store.mutate(state=>{
      const current=state.integrations.find(item=>item.id===attempt.integrationId);
      ensure(current && current.authType==='oauth2' && this.configKey(current)===attempt.configKey,409,'The integration settings changed while signing in. Start the connection again.');
      const bundle={client_secret:this.tokens(current).client_secret,access_token:tokens.access_token,refresh_token:tokens.refresh_token};
      current.oauthSecret=this.seal(bundle);
      const oauth={...current.oauth,connected:true,connectionId:id('oauthconn'),connectedAt:now()};delete oauth.expiresAt;delete oauth.reauthSuggested;if(tokens.expiresAt)oauth.expiresAt=tokens.expiresAt;
      current.oauth=oauth;current.status='connected';delete current.error;
      this.store.audit('integration.oauth_connected',`${current.name} signed in`,null,{integrationId:current.id});
      return current.name;
    });
    this.integrations.invalidate?.(attempt.integrationId);
    // An MCP server's tools are listed right after sign-in (initialize and tools/list only); a failure keeps the sign-in and Test retries it.
    if(integration.type==='mcp')await this.integrations.discover?.(attempt.integrationId,{signal:AbortSignal.timeout(this.options.oauthToolDiscoveryTimeout || 20_000)}).catch(()=>{});
    return {integrationId:attempt.integrationId,name,status:'connected'};
  }
  /** Manual fallback when the provider's redirect cannot reach the engine: the owner pastes the final address-bar URL. */
  async complete(integrationId,input){
    this.current(integrationId);ensure(object(input),400,'Paste the address the provider opened after sign-in.');
    let params;
    if(input.redirectUrl!==undefined){
      const raw=string(input.redirectUrl,'Redirect URL',8000);let url;try{url=new URL(raw);}catch{throw new HttpError(400,'Paste the full address from the browser, starting with http:// or https://.');}
      params=Object.fromEntries(url.searchParams);
    } else params={state:input.state,code:input.code};
    return this.callback(params,{integrationId});
  }
  async disconnect(integrationId){
    this.current(integrationId);this.pending.delete(integrationId);
    const result=await this.store.mutate(state=>{
      const current=state.integrations.find(item=>item.id===integrationId);ensure(current,404,'Integration not found.');ensure(current.authType==='oauth2',409,'This integration does not use OAuth sign-in.');
      const sealed=this.seal({client_secret:this.tokens(current).client_secret});if(sealed)current.oauthSecret=sealed;else delete current.oauthSecret;
      const oauth={...current.oauth,connected:false};for(const key of ['connectionId','connectedAt','expiresAt','reauthSuggested'])delete oauth[key];
      current.oauth=oauth;current.status='needs_credentials';delete current.error;
      this.store.audit('integration.oauth_disconnected',`${current.name} signed out`,null,{integrationId});
      return {integrationId,status:current.status,connected:false};
    });
    this.integrations.invalidate?.(integrationId);return result;
  }

  /** A current access token, renewed first when it expires within a minute. Concurrent callers share one renewal. */
  async accessToken(integration){
    const current=this.current(integration.id);
    ensure(current.authType==='oauth2' && current.oauth?.connected,409,current.status==='needs_reauth'?needsSignIn(current.name):`${current.name} is not signed in yet. The owner connects it in Settings → Integrations.`);
    if(this.refreshes.has(current.id))return this.refreshes.get(current.id);
    const tokens=this.tokens(current),expiresAt=Date.parse(current.oauth.expiresAt || '');
    if(tokens.access_token && !(Number.isFinite(expiresAt) && expiresAt-Date.now()<=REFRESH_MARGIN_MS))return tokens.access_token;
    return this.refresh(current.id);
  }
  /** Single-flight renewal. With `stale`, a token another caller already replaced is returned instead of renewing again. */
  refresh(integrationId,{stale}={}){
    if(this.refreshes.has(integrationId))return this.refreshes.get(integrationId);
    const current=this.current(integrationId),tokens=this.tokens(current);
    if(stale && tokens.access_token && !equal(tokens.access_token,stale))return Promise.resolve(tokens.access_token);
    const task=this.renew(current,tokens).finally(()=>this.refreshes.delete(integrationId));
    this.refreshes.set(integrationId,task);return task;
  }
  async renew(integration,tokens){
    const connectionId=integration.oauth?.connectionId;
    if(!tokens.refresh_token)return this.reauth(integration,connectionId,'no_refresh_token');
    let response;
    // The refresh token is sent at most once per renewal; an uncertain answer is never replayed automatically.
    try{response=await this.token(integration,tokens,{grant_type:'refresh_token',refresh_token:tokens.refresh_token});}
    catch{throw new HttpError(502,`${integration.name} sign-in could not be renewed right now. The request was not sent to the service; try again shortly.`);}
    const code=providerCode(response.data);
    if(response.status>=200 && response.status<300 && !code){
      const renewed=this.parse(response.data,tokens);
      await this.store.mutate(state=>{
        const current=state.integrations.find(item=>item.id===integration.id);
        ensure(current && current.oauth?.connected && current.oauth.connectionId===connectionId,409,`${integration.name} was disconnected or changed while its sign-in was renewed.`);
        current.oauthSecret=this.seal({client_secret:this.tokens(current).client_secret,access_token:renewed.access_token,refresh_token:renewed.refresh_token});
        const oauth={...current.oauth};delete oauth.expiresAt;if(renewed.expiresAt)oauth.expiresAt=renewed.expiresAt;current.oauth=oauth;
      });
      return renewed.access_token;
    }
    if([400,401].includes(response.status) && REAUTH_ERRORS.has(code))return this.reauth(integration,connectionId,code);
    throw new HttpError(502,`${integration.name} sign-in could not be renewed (${code || `HTTP ${response.status}`}). The request was not sent to the service; try again shortly.`);
  }
  /** Forgets the tokens after the provider refused them; the client id and secret stay so the owner only signs in again. */
  async reauth(integration,connectionId,reason){
    const message=needsSignIn(integration.name);
    await this.store.mutate(state=>{
      const current=state.integrations.find(item=>item.id===integration.id);
      if(!current || current.authType!=='oauth2' || current.oauth?.connectionId!==connectionId)return;
      const sealed=this.seal({client_secret:this.tokens(current).client_secret});if(sealed)current.oauthSecret=sealed;else delete current.oauthSecret;
      const oauth={...current.oauth,connected:false};for(const key of ['connectionId','connectedAt','expiresAt','reauthSuggested'])delete oauth[key];
      current.oauth=oauth;current.status='needs_reauth';current.error=message;
      this.store.audit('integration.oauth_refresh_failed',`${current.name} sign-in expired`,null,{integrationId:current.id,reason:String(reason).slice(0,80)});
    });
    this.integrations.invalidate?.(integration.id);
    throw new HttpError(409,message);
  }
  /**
   * Sends once; on HTTP 401 renews the token once. Only a GET is sent again. Any other method is not replayed, because the
   * service may treat it as a side effect, and the caller learns it can safely call again.
   */
  async send(integration,{method},send,auth){
    const response=await send(auth);
    if(integration.authType!=='oauth2' || response.status!==401)return response;
    const token=await this.refresh(integration.id,{stale:String(auth.Authorization || '').replace(/^Bearer /,'')});
    ensure(method==='GET',409,`${integration.name} did not accept the request because its sign-in had expired. The sign-in was renewed and the request was not sent again; it is safe to call it again.`);
    return send({Authorization:`Bearer ${token}`});
  }
  parse(data,previous){
    ensure(object(data) && typeof data.access_token==='string' && TOKEN.test(data.access_token),502,'The provider did not return a usable access token.');
    ensure(data.token_type===undefined || String(data.token_type).toLowerCase()==='bearer',502,'The provider returned a token type other than Bearer, which Tupies does not support.');
    const seconds=Number(data.expires_in),refresh=typeof data.refresh_token==='string' && TOKEN.test(data.refresh_token)?data.refresh_token:previous.refresh_token;
    return {access_token:data.access_token,refresh_token:refresh,...(Number.isFinite(seconds) && seconds>0?{expiresAt:new Date(Date.now()+seconds*1000).toISOString()}:{})};
  }
  token(integration,tokens,params){
    const oauth=integration.oauth,form=new URLSearchParams(params),headers={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json','User-Agent':'Tupies/0.2.0'},secret=tokens.client_secret;
    if(oauth.tokenAuth==='basic' && secret)headers.Authorization=`Basic ${Buffer.from(`${encodeURIComponent(oauth.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`;
    else {form.set('client_id',oauth.clientId);if(secret)form.set('client_secret',secret);}
    // RFC 8707: the token is requested for this MCP server only, on the code exchange and on every renewal.
    if(oauth.resource)form.set('resource',oauth.resource);
    return serviceRequest(oauth.tokenUrl,{method:'POST',headers,body:form.toString(),timeoutMs:this.options.oauthTimeout || 25_000,maxBytes:256_000,allowPrivateHttp:this.allowPrivateHttp()});
  }
  async close(){for(const attempt of this.pending.values())attempt.verifier='';this.pending.clear();await Promise.allSettled([...this.refreshes.values(),...this.discovering.values()]);}
}

/** The provider's top-level redirect. No owner session is required (the session cookie is SameSite=Strict and never rides a cross-site redirect); the single-use state is the authority. */
export async function integrationOAuthCallback(req,res,url,integrations){
  let result=null,message='The sign-in could not be completed. Start the connection again in Tupies.';
  try{result=await integrations.oauth.callback(Object.fromEntries(url.searchParams));}
  catch(error){if(error instanceof HttpError)message=integrations.store.redact(error.message);}
  res.writeHead(result?200:400,{'Content-Type':'text/html; charset=utf-8'});
  res.end(oauthResultPage(result?{ok:true,title:'Connected — you can close this tab',message:`${result.name} is connected to Tupies. Return to Tupies to use it.`}:{ok:false,title:'Sign-in was not completed',message}));
}

/** The client ID metadata document an authorization server fetches without a session; 404 without a public HTTPS origin. */
export function integrationOAuthClientMetadata(req,res,integrations){
  const document=integrations.oauth.clientMetadata();
  res.writeHead(document?200:404,{'Content-Type':'application/json; charset=utf-8','Cache-Control':document?'public, max-age=300':'no-store'});
  res.end(JSON.stringify(document || {error:'Not available: this engine has no public HTTPS address.'}));
}

/** Owner routes: redirect address, discover, start, manual complete and disconnect. The callback itself is served before session checks in server.mjs. */
export async function integrationOAuthApi(req,res,url,{store,integrations,body,json,busy}){
  const route=url.pathname,method=req.method;
  if(!route.startsWith('/api/integrations/'))return false;
  if(route==='/api/integrations/oauth/redirect' && method==='GET'){json(res,{redirectUri:integrations.oauth.redirectUri()});return true;}
  const match=route.match(/^\/api\/integrations\/([a-zA-Z0-9_-]+)\/oauth\/(discover|start|complete|disconnect)$/);
  if(!match)return false;
  ensure(method==='POST',405,'Use POST for integration sign-in actions.');
  const [,integrationId,action]=match,input=await body(req);
  ensure(store.state.integrations.some(item=>item.id===integrationId),404,'Integration not found.');
  if(action==='discover'){ensure(!busy?.(integrationId),409,'Wait for bots using this integration to finish.');json(res,store.redactValue(await integrations.oauth.discover(integrationId)));return true;}
  const result=action==='start'?await integrations.oauth.start(integrationId):action==='complete'?await integrations.oauth.complete(integrationId,input):await integrations.oauth.disconnect(integrationId);
  json(res,store.redactValue(result));return true;
}
