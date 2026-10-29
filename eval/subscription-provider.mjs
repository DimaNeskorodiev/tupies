import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {createDecipheriv,createHash} from 'node:crypto';
import {Providers,safeReasoning,safeImages} from '../lib/providers.mjs';
import {safeContextWindow} from '../lib/context-budget.mjs';
import {controlSocketPath,controlSocketLive} from '../lib/control.mjs';

const ENDPOINT='https://api.openai.com/v1';
const require_=condition=>{if(!condition)throw new Error('The explicitly authorized home-engine subscription grant is unavailable or changed. No copied token was renewed.');};
const optional=error=>{if(error.code==='ENOENT')return null;throw error;};
async function read(file,maxBytes) {
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW || 0));
  try{const stat=await handle.stat();require_(stat.isFile()&&stat.size<=maxBytes);return await handle.readFile();}finally{await handle.close();}
}
const modelsOf=connection=>(connection.models || []).slice(0,10_000).filter(model=>typeof model?.id==='string').map(model=>({id:model.id,...(safeContextWindow(model.contextWindow)?{contextWindow:safeContextWindow(model.contextWindow)}:{}),reasoning:safeReasoning('chatgpt',model.reasoning),...(safeImages(model.images)?{images:safeImages(model.images)}:{})}));

/** Read only the named engine's current grant. Never initialize a Store, renew tokens or copy transcripts. */
export function homeSubscriptionGrantReader({directory,connectionId='',authorized=false}={}) {
  require_(authorized===true&&typeof directory==='string'&&directory.length>0);let identity,sourceRoot;
  return async()=>{
    try {
      const configured=path.resolve(directory),root=await fs.realpath(configured);
      require_(!sourceRoot||sourceRoot===root);sourceRoot=root;
      const live=await controlSocketLive(controlSocketPath(configured)) || await controlSocketLive(controlSocketPath(root));require_(live);
      const configBytes=await read(path.join(root,'sync/config.json'),1024*1024).catch(optional),config=configBytes?JSON.parse(configBytes):{};require_(!config.hub);
      const key=await read(path.join(root,'vault.key'),32);require_(key.length===32);
      // Atomic state-file replacement gives one complete generation. Only connection metadata leaves this reader.
      const state=JSON.parse(await read(path.join(root,'state.json'),128*1024**2)),connections=(state.connections || []).filter(connection=>connection.type==='chatgpt'&&(!connectionId||connection.id===connectionId));require_(connections.length===1);
      const connection=connections[0];require_((connection.baseUrl || ENDPOINT)===ENDPOINT&&typeof connection.oauthSecret==='string');
      require_(!config.detachedOAuth?.includes(connection.id));
      const [iv,tag,encrypted]=connection.oauthSecret.split('.').map(value=>Buffer.from(value,'base64'));require_(iv?.length===12&&tag?.length===16&&encrypted);
      const cipher=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});cipher.setAuthTag(tag);
      const tokens=JSON.parse(Buffer.concat([cipher.update(encrypted),cipher.final()]).toString());
      for(const value of [tokens.subject,tokens.client_id])require_(typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x20\x7f]/.test(value));
      require_(!connection.oauthAccount?.subject||connection.oauthAccount.subject===tokens.subject);
      const currentIdentity=createHash('sha256').update(JSON.stringify([connection.id,tokens.subject,tokens.client_id])).digest('hex');
      require_(!identity||identity===currentIdentity);identity=currentIdentity;
      return {accessToken:tokens.access_token,expiresAt:tokens.expiresAt,scopes:tokens.scopes,refreshState:tokens.refreshState,planEnabled:connection.oauthAccount?.planEnabled===true,needsLogin:connection.oauthAccount?.needsLogin===true,endpoint:ENDPOINT,identity:currentIdentity,models:modelsOf(connection)};
    } catch {require_(false);}
  };
}

/** Reuses the real Responses adapter with fresh, memory-only access tokens and no refresh-token capability. */
export async function subscriptionProvider(store,{readGrant,authorized=false,model,imageInput='auto',maxOutputTokens=2048,requestTimeout=120_000,signal}={}) {
  require_(authorized===true&&typeof readGrant==='function'&&typeof model==='string'&&model.trim());
  const usedTokens=new Set(),originalRedact=store.redact;
  let identity;
  const current=async()=>{
    if(signal?.aborted)throw signal.reason;
    let grant,listener;
    try {const operation=Promise.resolve().then(()=>readGrant({signal}));grant=signal?await Promise.race([operation,new Promise((_,reject)=>{listener=()=>reject(signal.reason);signal.addEventListener('abort',listener,{once:true});})]):await operation;}
    catch {if(signal?.aborted)throw signal.reason;require_(false);}
    finally{if(listener)signal.removeEventListener('abort',listener);}
    require_(grant?.endpoint===ENDPOINT&&grant.planEnabled&&!grant.needsLogin&&!grant.refreshState&&Array.isArray(grant.scopes)&&grant.scopes.includes('resource.invoke')&&grant.scopes.includes('chatgpt.tokens.use.direct')&&grant.expiresAt>Date.now()+60_000&&typeof grant.accessToken==='string'&&grant.accessToken.length>=16&&grant.accessToken.length<=32768&&!/[\x00-\x20\x7f]/.test(grant.accessToken));
    require_(typeof grant.identity==='string'&&grant.identity.length>0&&grant.identity.length<=512&&!/[\x00-\x20\x7f]/.test(grant.identity)&&(!identity||identity===grant.identity));identity=grant.identity;usedTokens.add(grant.accessToken);return grant;
  };
  store.redact=function(value){let result=originalRedact.call(this,value);for(const token of usedTokens)result=result.split(token).join('[redacted]');return result;};
  try {
    const initial=await current(),providers=new Providers(store,{allowPrivateHttp:false,requestTimeout}),connection=providers.validate({type:'chatgpt',name:'Authorized subscription evaluation',defaultModel:model,imageInput,maxOutputTokens});
    connection.id='eval_provider';connection.models=initial.models || [];
    // There is deliberately no oauthSecret, refresh token, account record or source path in this store.
    providers.headers=async requested=>{require_(requested.id===connection.id&&requested.type==='chatgpt'&&requested.baseUrl===ENDPOINT);return {Authorization:`Bearer ${(await current()).accessToken}`};};
    const close=providers.close.bind(providers);providers.close=async()=>{await close();store.redact=originalRedact;usedTokens.clear();};
    return {providers,connection};
  } catch(error){store.redact=originalRedact;usedTokens.clear();throw error;}
}
