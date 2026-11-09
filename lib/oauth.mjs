import { randomBytes, randomUUID, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { HttpError, ensure, now } from './store.mjs';
import { serviceRequest, requireSuccess, validateServiceUrl } from './provider-net.mjs';
import { markProviderFailure, providerFailure } from './provider-failure.mjs';

const ISSUER='https://auth.openai.com';
const RESOURCE='https://api.openai.com/v1';
const SCOPES='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const opaque=()=>randomBytes(32).toString('base64url');
const equal=(a,b)=>{if(typeof a!=='string' || typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);};

/** ChatGPT's documented public-client OAuth flow; no borrowed Codex credentials. */
export class ChatGPTSignIn {
  constructor(store,options={}) {
    this.store=store;this.options=options;this.pending=new Map();this.refreshes=new Map();
    this.issuer=options.oauthIssuer || ISSUER;
    ensure(this.issuer===ISSUER || options.allowTestOAuth===true,500,'Custom OAuth issuers are permitted only in explicit test mode.');
    this.allowPrivateHttp=options.allowTestOAuth===true;
  }
  async request(url,options={}){return serviceRequest(url,{...options,allowPrivateHttp:this.allowPrivateHttp,timeoutMs:this.options.requestTimeout || 20_000});}
  async metadata(){
    if(this.discovery && this.discovery.expires>Date.now())return this.discovery.value;
    const result=requireSuccess(await this.request(`${this.issuer}/.well-known/openid-configuration`),'OpenAI sign-in discovery').data;
    ensure(result && result.issuer===this.issuer,502,'OpenAI sign-in discovery returned an unexpected issuer.');
    for(const field of ['jwks_uri','token_endpoint']){const url=validateServiceUrl(result[field],{allowPrivateHttp:this.allowPrivateHttp});ensure(url.origin===new URL(this.issuer).origin,502,'OpenAI sign-in discovery returned an unexpected service origin.');}
    if(result.revocation_endpoint)ensure(new URL(result.revocation_endpoint).origin===new URL(this.issuer).origin,502,'OpenAI revocation endpoint origin is invalid.');
    this.discovery={value:result,expires:Date.now()+3_600_000};return result;
  }
  tokens(connection){if(!connection.oauthSecret)return null;try{return JSON.parse(this.store.unseal(connection.oauthSecret));}catch{throw new HttpError(500,'Stored ChatGPT credentials could not be read. Restore the vault or sign in again.');}}
  async save(connectionId,tokens,account){
    await this.store.mutate(state=>{const connection=state.connections.find(c=>c.id===connectionId);ensure(connection,409,'This provider connection was removed.');connection.oauthSecret=tokens?this.store.seal(JSON.stringify(tokens)):'';connection.oauthAccount=account;connection.status=tokens && account.planEnabled && !tokens.refreshState?'connected':'untested';connection.updatedAt=now();});
  }
  status(connection){
    const pending=this.pending.get(connection.id);
    if(pending && pending.expiresAt<Date.now() && pending.status==='pending'){pending.status='error';pending.message='Sign-in expired. Start a fresh sign-in.';}
    if(pending && pending.status!=='connected')return {status:pending.status==='exchanging'?'pending':pending.status,loginId:pending.loginId,message:pending.message || 'Finish sign-in in your browser.',expiresAt:new Date(pending.expiresAt).toISOString()};
    const blocked=this.credentialAccess?.(connection);if(blocked)return {status:'signed_out',account:connection.oauthAccount || null,message:blocked};
    if(connection.oauthSecret && connection.oauthAccount?.planEnabled && !connection.oauthAccount?.needsLogin)return {status:'connected',account:connection.oauthAccount,message:'ChatGPT plan access is authorized. Model access is verified when a request succeeds.'};
    return {status:'signed_out',account:connection.oauthAccount || null,message:connection.oauthAccount?.needsLogin?'Sign in again to renew ChatGPT plan access.':'Continue with ChatGPT to authorize eligible plan usage.'};
  }
  async start(connection,{redirectUri}={}){
    this.assertAuthorization?.();
    const callback=new URL(redirectUri);
    ensure(callback.protocol==='http:' && callback.hostname==='127.0.0.1' && callback.pathname==='/auth/callback' && !callback.search && !callback.hash && !callback.username && !callback.password,400,'ChatGPT sign-in requires the Tupies HTTP loopback callback at 127.0.0.1/auth/callback.');
    const existing=this.tokens(connection),configuredClient=this.options.openaiClientId || process.env.STUDIO_OPENAI_CLIENT_ID || '';
    const hosted=this.options.hostedDeployment ?? process.env.STUDIO_DEPLOYMENT_MODE==='hosted';
    ensure(!hosted || configuredClient,409,'Paid or remotely hosted ChatGPT plan integrations require OpenAI onboarding and an approved client ID. Self-hosted open-source deployments can use local registration.');
    await this.store.mutate(state=>{state.hostId ||= `urn:uuid:${randomUUID()}`;});
    const clientId=existing?.client_id || connection.oauthAccount?.clientId || configuredClient || 'dynamic_agent_client';
    const pending={connectionId:connection.id,loginId:opaque(),state:opaque(),nonce:opaque(),verifier:opaque(),clientId,subject:existing?.subject || connection.oauthAccount?.subject || null,redirectUri:callback.href,expiresAt:Date.now()+600_000,status:'pending'};
    this.pending.set(connection.id,pending);
    const auth=new URL(`${this.issuer}/api/accounts/authorize`);
    const params={client_id:clientId,ext_agent_host_id:this.store.state.hostId,response_type:'code',redirect_uri:callback.href,scope:SCOPES,resource:RESOURCE,state:pending.state,nonce:pending.nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(pending.verifier).digest('base64url')};
    if(clientId==='dynamic_agent_client')params.agent_name_hint='Tupies';
    if(connection.oauthAccount?.email && clientId!=='dynamic_agent_client')params.login_hint=connection.oauthAccount.email;
    for(const [key,value] of Object.entries(params))auth.searchParams.set(key,value);
    return {status:'pending',authUrl:auth.href,loginId:pending.loginId,expiresAt:new Date(pending.expiresAt).toISOString(),message:`Approve Tupies in ChatGPT. Keep this Tupies tab open. On a VPS, forward port ${callback.port} over SSH.`};
  }
  cancel(connection){const pending=this.pending.get(connection.id);if(pending){pending.status='cancelled';pending.verifier='';pending.nonce='';}return {status:'cancelled'};}
  async validateIdToken(token,{clientId,nonce,subject=null}) {
    ensure(typeof token==='string' && token.length<50_000,502,'OpenAI did not return a valid ID token.');
    const segments=token.split('.');ensure(segments.length===3,502,'OpenAI ID token has an invalid format.');
    let header,claims;try{header=JSON.parse(Buffer.from(segments[0],'base64url'));claims=JSON.parse(Buffer.from(segments[1],'base64url'));}catch{throw new HttpError(502,'OpenAI ID token has invalid encoding.');}
    ensure(['RS256','ES256'].includes(header.alg) && typeof header.kid==='string',502,'OpenAI ID token uses an unsupported signature.');
    const metadata=await this.metadata(),jwks=requireSuccess(await this.request(metadata.jwks_uri),'OpenAI signing keys').data;
    const key=jwks?.keys?.find(key=>key.kid===header.kid && (!key.alg || key.alg===header.alg));ensure(key,502,'OpenAI ID token signing key was not found.');
    let valid=false;try{const publicKey=createPublicKey({key,format:'jwk'});valid=verify(header.alg==='RS256'?'RSA-SHA256':'sha256',Buffer.from(`${segments[0]}.${segments[1]}`),header.alg==='ES256'?{key:publicKey,dsaEncoding:'ieee-p1363'}:publicKey,Buffer.from(segments[2],'base64url'));}catch{}
    ensure(valid,502,'OpenAI ID token signature verification failed.');
    const seconds=Date.now()/1000,audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];
    ensure(claims.iss===this.issuer && audiences.includes(clientId) && Number.isFinite(claims.exp) && claims.exp>seconds && (!claims.nbf || claims.nbf<=seconds+30) && equal(claims.nonce,nonce) && typeof claims.sub==='string' && claims.sub.length>0,502,'OpenAI ID token identity, expiry, audience, or nonce is invalid.');
    if(audiences.length>1)ensure(claims.azp===clientId,502,'OpenAI ID token authorized party is invalid.');
    if(subject)ensure(claims.sub===subject,409,'The selected ChatGPT account changed. Add a separate connection for a different account.');
    return claims;
  }
  async callback(params){
    this.assertAuthorization?.();
    const pending=[...this.pending.values()].find(attempt=>equal(attempt.state,params.state));
    ensure(pending && pending.status==='pending' && pending.expiresAt>Date.now(),400,'This sign-in callback is expired or does not match an active attempt.');
    ensure(this.store.state.connections.some(connection=>connection.id===pending.connectionId && connection.type==='chatgpt'),409,'The provider changed while signing in. Start a new sign-in for the intended ChatGPT connection.');
    // Consume before exchanging a code; a callback is never replayed after an uncertain exchange.
    pending.status='exchanging';
    try {
      if(params.error)throw new HttpError(400,params.error==='access_denied'?'ChatGPT sign-in was declined.':'ChatGPT sign-in did not complete.');
      ensure(typeof params.code==='string' && params.code.length>0 && params.code.length<=10_000,400,'The sign-in callback is missing its authorization code.');
      const clientId=pending.clientId==='dynamic_agent_client'?params.client_id:pending.clientId;
      ensure(typeof clientId==='string' && clientId && clientId!=='dynamic_agent_client' && clientId.length<=500,400,'OpenAI registration did not return an issued client ID.');
      if(pending.clientId!=='dynamic_agent_client' && params.client_id)ensure(params.client_id===pending.clientId,400,'The sign-in client identity changed.');
      const metadata=await this.metadata();
      const result=requireSuccess(await this.request(metadata.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code:params.code,code_verifier:pending.verifier,redirect_uri:pending.redirectUri,resource:RESOURCE}).toString()}),'OpenAI code exchange').data;
      ensure(typeof result?.access_token==='string' && result.token_type?.toLowerCase()==='bearer' && Number.isFinite(result.expires_in) && result.expires_in>0,502,'OpenAI returned an incomplete token response.');
      const claims=await this.validateIdToken(result.id_token,{clientId,nonce:pending.nonce,subject:pending.subject});
      const scopes=String(result.scope || '').split(/\s+/).filter(Boolean),planEnabled=scopes.includes('chatgpt.tokens.use.direct') && scopes.includes('resource.invoke');
      const credentials={...result,client_id:clientId,subject:claims.sub,issuer:this.issuer,scopes,expiresAt:Date.now()+result.expires_in*1000,savedAt:now()};
      await this.save(pending.connectionId,credentials,{clientId,subject:claims.sub,email:typeof claims.email==='string'?claims.email:'',planEnabled,needsLogin:false});
      await this.onAuthorized?.(pending.connectionId);
      pending.status='connected';pending.message=planEnabled?'ChatGPT plan access connected.':'Identity connected, but ChatGPT plan usage was not granted. Sign in again and approve plan access.';
      return {connectionId:pending.connectionId,status:'connected',planEnabled,message:pending.message};
    } catch(error){pending.status='error';pending.message=error instanceof HttpError?error.message:'ChatGPT sign-in could not be verified. Start a fresh sign-in.';throw new HttpError(error.status || 502,pending.message);}
    finally {pending.verifier='';pending.nonce='';}
  }
  async bearer(connection){
    connection=this.store.state.connections.find(item=>item.id===connection.id) || connection;
    const blocked=this.credentialAccess?.(connection);ensure(!blocked,401,blocked || 'ChatGPT authorization belongs to another engine.');
    const tokens=this.tokens(connection);ensure(tokens && tokens.scopes?.includes('chatgpt.tokens.use.direct') && tokens.scopes?.includes('resource.invoke'),401,'Continue with ChatGPT and approve plan usage before sending a task.');
    // A renewal already running here is awaited: while it runs the stored bundle is marked in progress, which must not
    // turn a concurrent caller (another task, or a linked engine asking the home server) into a failure.
    if(this.refreshes.has(connection.id))return this.refreshes.get(connection.id);
    ensure(!tokens.refreshState,401,'ChatGPT renewal could not be confirmed. Sign in again before using this connection.');
    if(tokens.expiresAt>Date.now()+60_000)return tokens.access_token;
    // After a transient renewal failure the endpoint is left alone until the backoff passes; a still-valid token keeps working meanwhile.
    if(tokens.nextRefreshAttemptAt>Date.now()){if(tokens.expiresAt>Date.now())return tokens.access_token;throw this.renewalUnavailable();}
    // A linked engine never spends the rotating refresh token itself; its home server renews and replicates the bundle.
    const delegated=this.refreshDelegate?.(connection.id);
    if(delegated){
      const task=delegated.then(()=>{const current=this.store.state.connections.find(item=>item.id===connection.id),renewed=current && this.tokens(current);ensure(renewed && !renewed.refreshState && renewed.expiresAt>Date.now()+60_000,401,'Your home server could not renew ChatGPT access. Sign in to ChatGPT again on the home server.');return renewed.access_token;}).finally(()=>this.refreshes.delete(connection.id));
      this.refreshes.set(connection.id,task);return task;
    }
    const task=this.refresh(connection,tokens).finally(()=>this.refreshes.delete(connection.id));this.refreshes.set(connection.id,task);return task;
  }
  async refresh(connection,tokens){
    ensure(tokens.refresh_token,401,'ChatGPT access expired. Continue with ChatGPT to sign in again.');
    // The in-progress marker keeps the account state as it was: a renewal underway is not a sign-out.
    await this.save(connection.id,{...tokens,refreshState:'in_progress'},connection.oauthAccount);
    const unavailable=async()=>{
      const failures=(Number(tokens.refreshFailures)||0)+1,wait=[30_000,60_000,300_000,900_000][Math.min(failures-1,3)];
      await this.save(connection.id,{...tokens,refreshFailures:failures,nextRefreshAttemptAt:Date.now()+wait},connection.oauthAccount);
      throw this.renewalUnavailable();
    };
    let metadata;try{metadata=await this.metadata();}catch{return unavailable();}
    // unsent: nothing reached the token endpoint, or it answered without consuming the token. ambiguous: the request may have been processed.
    // definitive: a 4xx (or unusable success) answer, so the refresh token is spent or rejected and must never be replayed.
    for(let attempt=1;attempt<=2;attempt++){
      let kind='unsent';
      try {
        const response=requireSuccess(await this.request(metadata.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:tokens.client_id,refresh_token:tokens.refresh_token,resource:RESOURCE}).toString()}),'OpenAI access renewal').data;
        if(!(typeof response?.access_token==='string' && typeof response.refresh_token==='string' && Number.isFinite(response.expires_in))){kind='definitive';throw new HttpError(502,'OpenAI returned incomplete renewed credentials.');}
        const replacement={...tokens,...response,scopes:response.scope?response.scope.split(/\s+/).filter(Boolean):tokens.scopes,expiresAt:Date.now()+response.expires_in*1000,savedAt:now()};delete replacement.refreshState;delete replacement.refreshFailures;delete replacement.nextRefreshAttemptAt;
        await this.save(connection.id,replacement,{...connection.oauthAccount,planEnabled:replacement.scopes.includes('chatgpt.tokens.use.direct') && replacement.scopes.includes('resource.invoke'),needsLogin:false});return replacement.access_token;
      } catch(error){
        if(kind!=='definitive')kind=this.renewalFailureKind(error);
        if(kind==='ambiguous' && attempt===1)continue;
        if(kind==='definitive'){const settled={...tokens,refreshState:'uncertain'};delete settled.refreshFailures;delete settled.nextRefreshAttemptAt;await this.save(connection.id,settled,{...connection.oauthAccount,needsLogin:true});throw new HttpError(401,'ChatGPT renewal could not be confirmed. Sign in again; the old refresh token will not be replayed.');}
        return unavailable();
      }
    }
  }
  renewalUnavailable(){return markProviderFailure(new HttpError(503,'ChatGPT renewal is temporarily unavailable; retrying automatically.'),'upstream_unavailable',{status:503});}
  renewalFailureKind(error){
    const failure=providerFailure(error),upstream=failure?.upstreamStatus,code=typeof error?.code==='string'?error.code:'';
    if(upstream>=400 && upstream<500)return upstream===408 || upstream===429?'unsent':'definitive';
    if(upstream>=500)return 'ambiguous';
    if(failure?.code==='timeout')return failure.timeoutPhase==='dns'?'unsent':'ambiguous';
    if(failure && ['dns_error','tls_error'].includes(failure.code) || ['ENOTFOUND','EAI_AGAIN','EAI_FAIL','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH'].includes(code) || /^ERR_TLS_|^CERT_|^UNABLE_TO_VERIFY_/.test(code))return 'unsent';
    return 'ambiguous';
  }
  async logout(connection){
    this.cancel(connection);const tokens=this.tokens(connection),blocked=this.credentialAccess?.(connection);let revoked=!tokens?.refresh_token;
    try{if(tokens?.refresh_token&&!blocked){const metadata=await this.metadata();if(metadata.revocation_endpoint){const result=await this.request(metadata.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:tokens.refresh_token,token_type_hint:'refresh_token',client_id:tokens.client_id}).toString()});revoked=result.status===200;}}}catch{}
    const account={...connection.oauthAccount,planEnabled:false,needsLogin:true};await this.save(connection.id,null,account);this.pending.delete(connection.id);
    return {status:'signed_out',revocationConfirmed:revoked,message:blocked?'Signed out on this engine. The former home server’s authorization was not revoked.':revoked?'Signed out of ChatGPT.':'Signed out locally. Remote revocation was not confirmed; disconnect Tupies in ChatGPT Settings if needed.'};
  }
  async close(){for(const attempt of this.pending.values()){attempt.verifier='';attempt.nonce='';}this.pending.clear();await Promise.allSettled([...this.refreshes.values()]);}
}
