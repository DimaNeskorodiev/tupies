import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { HttpError, ensure, string, now, id } from './store.mjs';
import { validateServiceUrl, serviceRequest } from './provider-net.mjs';

/**
 * OAuth 2.0 authorization-code sign-in (PKCE S256) for owner-declared integrations, REST and MCP alike.
 * Non-secret settings live in `integration.oauth`; the client secret and tokens live sealed in `integration.oauthSecret`
 * as one JSON bundle {client_secret?, access_token?, refresh_token?}. token_type is not stored: only Bearer is accepted, and the
 * store's redaction treats every value under a key containing "token" as a secret, so storing "Bearer" would redact that word everywhere. `oauth.connected` is true exactly when
 * an access or refresh token is stored. Endpoints are fixed by the owner (or a bot proposal the owner approved); there is
 * no metadata discovery or dynamic client registration.
 */
export const OAUTH_CALLBACK_PATH='/api/integrations/oauth/callback';
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
  constructor(store,integrations,options={}){this.store=store;this.integrations=integrations;this.options=options;this.pending=new Map();this.refreshes=new Map();this.redirectBase=options.oauthRedirectBase?()=>options.oauthRedirectBase:null;}
  allowPrivateHttp(){return this.integrations.options.allowPrivateHttp ?? process.env.STUDIO_ALLOW_PRIVATE_HTTP==='true';}
  redirectUri(){const base=this.redirectBase?.();ensure(base,503,'This engine has no sign-in return address yet.');return `${base}${OAUTH_CALLBACK_PATH}`;}
  tokens(integration){if(!integration?.oauthSecret)return {};try{const value=JSON.parse(this.store.unseal(integration.oauthSecret));return object(value)?value:{};}catch{throw new HttpError(500,`Stored sign-in for ${integration.name} could not be read. Disconnect it and sign in again.`);}}
  seal(bundle){const clean=Object.fromEntries(Object.entries(bundle).filter(([,value])=>typeof value==='string' && value));return Object.keys(clean).length?this.store.seal(JSON.stringify(clean)):undefined;}
  current(integrationId){const integration=this.store.state.integrations?.find(item=>item.id===integrationId);ensure(integration,404,'Integration not found.');return integration;}

  /**
   * The auth part of Integrations.validate. Endpoint, client or client-secret changes forget stored tokens, like an endpoint change
   * forgets an API key. A scope-only change keeps the tokens and sets `oauth.reauthSuggested` until the next sign-in grants them.
   */
  validate(input,previous,value){
    if(value.authType!=='oauth2'){delete value.oauth;delete value.oauthSecret;return;}
    const before=previous.authType==='oauth2' && object(previous.oauth)?previous.oauth:{},given=input.oauth;
    ensure(given===undefined || object(given),400,'OAuth settings must be an object.');
    const field=key=>given && Object.hasOwn(given,key)?given[key]:before[key];
    const allowPrivateHttp=this.allowPrivateHttp();
    const authorizationUrl=string(field('authorizationUrl') ?? '','OAuth authorization URL',2000);validateServiceUrl(authorizationUrl,{allowPrivateHttp,allowQuery:true});
    ensure(![...new URL(authorizationUrl).searchParams.keys()].some(key=>RESERVED_PARAMS.has(key)),400,'The authorization URL cannot preset sign-in parameters such as client_id, redirect_uri, state or scope.');
    const tokenUrl=string(field('tokenUrl') ?? '','OAuth token URL',2000);validateServiceUrl(tokenUrl,{allowPrivateHttp});
    let scopes=field('scopes') ?? [];if(typeof scopes==='string')scopes=scopes.split(/\s+/).filter(Boolean);
    ensure(Array.isArray(scopes) && scopes.length<=40 && scopes.every(scope=>typeof scope==='string' && SCOPE.test(scope)),400,'Use up to 40 OAuth scopes of 1–300 printable characters without spaces or quotes.');
    scopes=[...new Set(scopes)];
    const extra=field('extraParams') ?? {};ensure(object(extra) && Object.keys(extra).length<=8,400,'Use up to 8 extra authorization parameters.');
    const extraParams={};
    for(const [key,item] of Object.entries(extra)){
      ensure(PARAM.test(key) && !['__proto__','prototype','constructor'].includes(key),400,'Extra authorization parameter names may use letters, numbers, _, . and -.');
      ensure(!RESERVED_PARAMS.has(key),400,`${key} is set by Tupies and cannot be an extra authorization parameter.`);
      ensure(['string','number','boolean'].includes(typeof item) && String(item).length<=500 && !CONTROL.test(String(item)),400,'Extra authorization parameter values must be short text.');
      extraParams[key]=String(item);
    }
    const tokenAuth=field('tokenAuth') ?? 'body';ensure(['body','basic'].includes(tokenAuth),400,'Client authentication must be body or basic.');
    const clientId=field('clientId') ?? '';ensure(typeof clientId==='string' && clientId.trim().length<=500 && !CONTROL.test(clientId),400,'The OAuth client ID must be up to 500 characters.');
    const stored=previous.authType==='oauth2'?this.tokens(previous):{};let clientSecret=stored.client_secret || '';
    if(input.oauthClientSecret===null)clientSecret='';
    else if(input.oauthClientSecret){clientSecret=string(input.oauthClientSecret,'OAuth client secret',4096);ensure(!CONTROL.test(clientSecret),400,'Credentials cannot contain control characters.');}
    const drop=previous.authType!=='oauth2' || value.baseUrl!==previous.baseUrl || authorizationUrl!==before.authorizationUrl || tokenUrl!==before.tokenUrl || clientId.trim()!==(before.clientId || '') || clientSecret!==(stored.client_secret || '');
    const bundle=drop?{client_secret:clientSecret}:{...stored,client_secret:clientSecret};
    const connected=!!(bundle.access_token || bundle.refresh_token);
    const scopesChanged=connected && JSON.stringify(scopes)!==JSON.stringify(before.scopes || []);
    value.oauth={authorizationUrl,tokenUrl,scopes,clientId:clientId.trim(),extraParams,tokenAuth,connected,...(connected?{connectionId:before.connectionId,...(before.connectedAt?{connectedAt:before.connectedAt}:{}),...(before.expiresAt?{expiresAt:before.expiresAt}:{}),...(scopesChanged || before.reauthSuggested?{reauthSuggested:true}:{})}:{})};
    const sealed=this.seal(bundle);if(sealed)value.oauthSecret=sealed;else delete value.oauthSecret;
    if(drop)this.integrations.invalidate?.(previous.id);
  }
  /** Status after a save: connected with tokens; a pending re-sign-in stays visible until the owner signs in or changes the client. */
  statusOf(value,previous={}){return value.oauth?.connected?'connected':previous.status==='needs_reauth' && previous.authType==='oauth2' && previous.oauth?.clientId===value.oauth?.clientId && previous.oauth?.tokenUrl===value.oauth?.tokenUrl?'needs_reauth':'needs_credentials';}
  /** Fingerprint material: endpoints, client and the connection id, never the rotating tokens. */
  identity(integration){const oauth=integration.oauth || {};return {authorizationUrl:oauth.authorizationUrl,tokenUrl:oauth.tokenUrl,clientId:oauth.clientId,scopes:oauth.scopes,connectionId:oauth.connectionId || ''};}
  configKey(integration){const oauth=integration.oauth || {};return digest(JSON.stringify([integration.baseUrl,integration.authType,oauth.authorizationUrl,oauth.tokenUrl,oauth.clientId,oauth.scopes,oauth.extraParams,oauth.tokenAuth,digest(this.tokens(integration).client_secret)]));}

  async start(integrationId){
    const integration=this.current(integrationId);
    ensure(integration.authType==='oauth2' && object(integration.oauth),409,'This integration does not use OAuth sign-in.');
    ensure(integration.oauth.clientId,409,'Add the OAuth client ID from the provider before signing in.');
    const redirectUri=this.redirectUri(),attempt={integrationId,state:opaque(),verifier:opaque(),redirectUri,configKey:this.configKey(integration),expiresAt:Date.now()+ATTEMPT_MS};
    for(const [key,item] of this.pending)if(item.expiresAt<=Date.now())this.pending.delete(key);
    // One attempt per integration: starting again retires the previous link.
    this.pending.set(integrationId,attempt);
    const url=new URL(integration.oauth.authorizationUrl);
    for(const [key,item] of Object.entries(integration.oauth.extraParams || {}))url.searchParams.set(key,item);
    const params={response_type:'code',client_id:integration.oauth.clientId,redirect_uri:redirectUri,...(integration.oauth.scopes?.length?{scope:integration.oauth.scopes.join(' ')}:{}),state:attempt.state,code_challenge:createHash('sha256').update(attempt.verifier).digest('base64url'),code_challenge_method:'S256'};
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
    return serviceRequest(oauth.tokenUrl,{method:'POST',headers,body:form.toString(),timeoutMs:this.options.oauthTimeout || 25_000,maxBytes:256_000,allowPrivateHttp:this.allowPrivateHttp()});
  }
  async close(){for(const attempt of this.pending.values())attempt.verifier='';this.pending.clear();await Promise.allSettled([...this.refreshes.values()]);}
}

/** The provider's top-level redirect. No owner session is required (the session cookie is SameSite=Strict and never rides a cross-site redirect); the single-use state is the authority. */
export async function integrationOAuthCallback(req,res,url,integrations){
  let result=null,message='The sign-in could not be completed. Start the connection again in Tupies.';
  try{result=await integrations.oauth.callback(Object.fromEntries(url.searchParams));}
  catch(error){if(error instanceof HttpError)message=integrations.store.redact(error.message);}
  res.writeHead(result?200:400,{'Content-Type':'text/html; charset=utf-8'});
  res.end(oauthResultPage(result?{ok:true,title:'Connected — you can close this tab',message:`${result.name} is connected to Tupies. Return to Tupies to use it.`}:{ok:false,title:'Sign-in was not completed',message}));
}

/** Owner routes: redirect address, start, manual complete and disconnect. The callback itself is served before session checks in server.mjs. */
export async function integrationOAuthApi(req,res,url,{store,integrations,body,json}){
  const route=url.pathname,method=req.method;
  if(!route.startsWith('/api/integrations/'))return false;
  if(route==='/api/integrations/oauth/redirect' && method==='GET'){json(res,{redirectUri:integrations.oauth.redirectUri()});return true;}
  const match=route.match(/^\/api\/integrations\/([a-zA-Z0-9_-]+)\/oauth\/(start|complete|disconnect)$/);
  if(!match)return false;
  ensure(method==='POST',405,'Use POST for integration sign-in actions.');
  const [,integrationId,action]=match,input=await body(req);
  ensure(store.state.integrations.some(item=>item.id===integrationId),404,'Integration not found.');
  const result=action==='start'?await integrations.oauth.start(integrationId):action==='complete'?await integrations.oauth.complete(integrationId,input):await integrations.oauth.disconnect(integrationId);
  json(res,store.redactValue(result));return true;
}
