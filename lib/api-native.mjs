import { codingApi } from './coding-api.mjs';
import path from 'node:path';
import { ensure, string, now, id } from './store.mjs';
import { isActive } from './runtime.mjs';
import { listWorkspace, readWorkspace, writeWorkspace, readWorkspaceBytes, documentFileMetadata, workspaceMime, workspaceFilename, MAX_DOCUMENT_BYTES, MAX_ATTACHMENTS, rememberFact, getWorkspaceRoot, safePath } from './agent-tools.mjs';
import { brainOverview, brainNote } from './brain.mjs';
import { imagesForModel, safeImages, safeReasoning } from './providers.mjs';
import { contextLimits, estimateTokens, safeContextWindow } from './context-budget.mjs';
import { findSession } from './sessions.mjs';
import { decideProposal, listProposals } from './learning.mjs';
import { searchConversations } from './conversation-search.mjs';

const connectionPublic=({secret,oauthSecret,...connection})=>({...connection,hasKey:!!secret,hasOAuth:!!oauthSecret});
const integrationPublic=({secret,...integration})=>({...integration,hasKey:!!secret});
function inferenceState(bot,connection,models,runs={},state={}) {
  // How full the Bot Chat is now (an estimate) and when it was last summarized, for the context note in Chat options.
  const session=findSession(state,bot.id),conversation={tokens:estimateTokens(state.conversations?.[bot.id] || []),...(session?.compactedAt?{compactedAt:session.compactedAt,compactions:session.compactions || 1}:{})};
  const effectiveModel=bot.model || connection.defaultModel || connection.model || '',selected=models.find(item=>item.id===effectiveModel),run=runs[bot.id];
  // Each model says whether attached images would be shown to it, so Chat options can tell before the owner switches.
  const described=models.map(item=>({...item,imageInput:imagesForModel({...connection,models},item.id)}));
  return {botId:bot.id,connectionId:connection.id,provider:{id:connection.id,type:connection.type,name:connection.name},model:bot.model || '',reasoningEffort:bot.reasoningEffort || '',effectiveModel,defaultModel:connection.defaultModel || connection.model || '',models:described,reasoning:safeReasoning(connection.type,selected?.reasoning),context:contextLimits({...connection,models},effectiveModel,bot),conversation,appliesTo:'next-run',activeRun:isActive(run)?{id:run.id,status:run.status,model:run.model || '',reasoningEffort:run.reasoningEffort || ''}:null};
}

export async function oauthCallback(req,res,url,providers){
  let successful=false;
  try{await providers.loginCallback(Object.fromEntries(url.searchParams));successful=true;}catch{}
  res.writeHead(successful?200:400,{'Content-Type':'text/html; charset=utf-8'});
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign-in · Tupies</title><link rel="stylesheet" href="/guide.css"><main><h1>${successful?'ChatGPT is connected.':'Sign-in could not be completed.'}</h1><p>${successful?'Return to Tupies to use your connected account. You can close this tab.':'Return to Tupies and start a fresh sign-in. Expired or mismatched requests are refused.'}</p><a href="/">Return to your workspace</a></main></html>`);
}

export async function nativeApi(req,res,url,context){
  const {store,providers,speech,integrations,channels,runtime,rooms,body,json}=context;
  if(await codingApi(req,res,url,context))return true;
  const route=url.pathname,method=req.method;
  const reply=(data,status)=>{json(res,data,status);return true;};
  const connectionIdle=connectionId=>ensure(!Object.values(store.state.runs).some(run=>isActive(run)&&run.connectionId===connectionId),409,'Wait for tasks using this provider to finish.');

  if(route==='/api/conversations/search'&&method==='GET')return reply(searchConversations(store.state,Object.fromEntries(url.searchParams),{redact:value=>store.redact(value)}));

  if(route==='/api/speech/catalog'&&method==='GET'){
    const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort(new Error('Speech request closed.'));};res.once('close',abort);
    try{return reply(await speech.catalog(url.searchParams.get('connectionId'),{signal:controller.signal,refresh:url.searchParams.get('refresh')==='true'}));}finally{res.off('close',abort);}
  }
  if(['/api/speech/synthesize','/api/speech/transcribe'].includes(route)&&method==='POST'){
    const input=await body(req,route.endsWith('/transcribe')?2_600_000:24_000),controller=new AbortController();
    const abort=()=>{if(!res.writableEnded)controller.abort(new Error('Speech request closed.'));};res.once('close',abort);if(req.aborted||res.destroyed)abort();
    try{
      if(route.endsWith('/transcribe'))return reply(await speech.transcribe(input,{signal:controller.signal}));
      const result=await speech.synthesize(input,{signal:controller.signal});
      res.writeHead(200,{'Content-Type':result.contentType,'Content-Length':result.bytes.length});res.end(result.bytes);return true;
    }finally{res.off('close',abort);}
  }

  const processRoute=route.match(/^\/api\/bots\/([a-zA-Z0-9_-]+)\/processes\/([a-zA-Z0-9_-]+)(\/stop)?$/);
  if(processRoute) {
    const [,botId,processId,stop]=processRoute,run=store.state.runs[botId];
    ensure(store.state.bots.some(bot=>bot.id===botId),404,'Bot not found.');
    if(!stop && method==='GET') {
      ensure(run && url.searchParams.get('runId')===run.id,409,'This output belongs to an older task.');
      return reply(await runtime.backgroundProcesses.read(botId,run.id,processId,{offset:Number(url.searchParams.get('offset') || 0),limit:Number(url.searchParams.get('limit') || 12000),outputVersion:url.searchParams.has('outputVersion')?Number(url.searchParams.get('outputVersion')):undefined}));
    }
    if(stop && method==='POST') {
      const input=await body(req);
      ensure(run && isActive(run) && input.runId===run.id && input.remoteRunId===run.remoteRunId,409,'This action belongs to an older or completed task.');
      const result=await runtime.backgroundProcesses.stop(botId,run.id,processId,{reason:'Stopped by the user.'});
      await store.mutate(()=>store.audit('process.stopped','An owned background command was stopped by the user.',botId,{runId:run.id,processId}));
      return reply(result);
    }
    ensure(false,405,'Use GET for process output or POST to stop the owned process.');
  }

  if(route==='/api/providers'&&method==='GET')return reply({providers:providers.catalog(),engine:'studio',features:{nativeEngine:true,chatgptOAuth:true,integrations:true,autonomousCollaboration:true,computerUse:false}});
  if(route==='/api/capabilities'&&method==='GET')return reply({version:'0.5.0',engine:'studio',independent:true,features:{tools:true,workspaceSearch:true,conversationSearch:true,ownerGuidance:true,workspaceEdit:true,taskPlans:true,outcomeChecks:true,workRecords:true,workspaceImages:true,webSearch:true,parallelReads:true,pagedToolResults:true,backgroundCommands:true,lsp:true,memory:true,skills:true,skillCatalog:true,skillInstall:true,delegation:true,rooms:true,integrations:true,files:true,documents:true,artifacts:true,attachments:true,richOutput:true,modelSelection:true,reasoningControls:true,computerUse:false,mobile:false},documents:{formats:['pdf','docx','pptx','xlsx','md','csv','txt','json'],imageFormats:['png','jpg','jpeg','webp'],maxBytes:MAX_DOCUMENT_BYTES,maxAttachments:MAX_ATTACHMENTS,imageVision:false}});
  if(route==='/api/channels'&&method==='GET')return reply({channels:store.publicState().channels,catalog:channels.catalog()});
  if(route==='/api/channels'&&method==='POST'){
    const input=await body(req),channel={...channels.validate(input),id:id('channel'),createdAt:now(),status:'untested'};
    await store.mutate(state=>{ensure(state.channels.length<20,400,'You can configure up to 20 messaging channels.');state.channels.push(channel);store.audit('channel.created',`${channel.name} configured`);});
    const {secret,...safe}=channel;return reply({...safe,hasToken:!!secret},201);
  }
  let channelMatch=route.match(/^\/api\/channels\/([a-zA-Z0-9_-]+)(?:\/(test))?$/);
  if(channelMatch){const [,channelId,action]=channelMatch,channel=store.state.channels.find(c=>c.id===channelId);ensure(channel,404,'Channel not found.');
    if(!action&&method==='PATCH'){const input=await body(req);await channels.cancel?.(channelId);const updated=await store.mutate(state=>{const current=state.channels.find(c=>c.id===channelId);ensure(current,409,'Channel was removed.');const updated=channels.validate(input,current);state.channels[state.channels.findIndex(c=>c.id===channelId)]=updated;store.audit('channel.updated',`${updated.name} updated`);return updated;});const {secret,...safe}=updated;return reply({...safe,hasToken:!!secret});}
    if(!action&&method==='DELETE'){await channels.cancel?.(channelId);await store.mutate(state=>{const current=state.channels.find(c=>c.id===channelId);ensure(current,409,'Channel was already removed.');ensure(!current.pending,409,'Pause the channel and stop or finish its active bot task before removing it.');state.channels=state.channels.filter(c=>c.id!==channelId);store.audit('channel.deleted',`${channel.name} removed`);});return reply({deleted:true});}
    if(action==='test'&&method==='POST'){await body(req);return reply(await channels.test(channelId));}
  }
  if(route==='/api/connections'&&method==='POST'){
    const input=await body(req),connection={...providers.validate(input),id:id('provider'),createdAt:now(),status:'untested'};
    await store.mutate(state=>{
      ensure(state.connections.length<100,400,'You can save up to 100 model providers.');
      const first=!state.connections.some(c=>c.type!=='legacy-hermes');
      state.connections.push(connection);
      if(first&&input.assignToUnconfigured!==false)for(const bot of state.bots)if(!bot.connectionId)bot.connectionId=connection.id;
      store.audit('provider.created',`${connection.name} added`);
    });
    return reply(connectionPublic(connection),201);
  }
  let match=route.match(/^\/api\/connections\/([a-zA-Z0-9_-]+)(?:\/(test|models|login|logout|default-model))?$/);
  if(match){
    const [,connectionId,action]=match,connection=store.state.connections.find(c=>c.id===connectionId);
    ensure(connection,404,'Model provider not found.');
    if(action==='default-model'&&method==='POST'){
      const input=await body(req),model=string(input.model,'Default model',200);
      ensure(input.applyToAllBots===undefined||typeof input.applyToAllBots==='boolean',400,'Apply to all bots must be true or false.');
      const applyToAllBots=input.applyToAllBots!==false;
      connectionIdle(connectionId);
      const catalog=store.redactValue(await providers.models(connection));
      ensure(Array.isArray(catalog.models)&&catalog.models.length>0,409,'This provider returned no available models. Refresh its model list and try again.');
      const models=catalog.models.filter(item=>item&&typeof item.id==='string'&&item.id.length>0&&item.id.length<=200).map(item=>({id:item.id,name:String(item.name||item.id).slice(0,300),reasoning:safeReasoning(connection.type,item.reasoning),...(safeContextWindow(item.contextWindow)?{contextWindow:safeContextWindow(item.contextWindow)}:{}),...(safeImages(item.images)?{images:safeImages(item.images)}:{})}));
      const selected=models.find(item=>item.id===model);
      ensure(selected,400,'Choose a model from this provider’s current model list.');
      const result=await store.mutate(state=>{
        const current=state.connections.find(item=>item.id===connectionId);
        ensure(current,409,'This provider was removed. Refresh and choose a provider again.');
        ensure(current.type===connection.type&&current.baseUrl===connection.baseUrl&&current.secret===connection.secret,409,'This provider changed while loading its models. Refresh the model list and try again.');
        if(current.type==='chatgpt')ensure(current.oauthSecret&&current.oauthAccount?.planEnabled&&!current.oauthAccount?.needsLogin,409,'ChatGPT plan access changed. Sign in again before choosing a model.');
        connectionIdle(connectionId);
        const previousDefault=state.settings?.defaultConnectionId;
        const affected=applyToAllBots?state.bots:state.bots.filter(bot=>!bot.model&&(!bot.connectionId||bot.connectionId===connectionId||bot.connectionId===previousDefault));
        ensure(!affected.some(bot=>isActive(state.runs[bot.id])||runtime.starting?.has(bot.id)||rooms.reserved(bot.id)),409,'Wait for bots using the workspace default to finish their active tasks before changing it.');
        Object.assign(current,{defaultModel:model,models:[selected,...models.filter(item=>item.id!==model)].slice(0,200),status:'connected',testedAt:now(),updatedAt:now()});
        delete current.error;
        state.settings={...(state.settings||{}),defaultConnectionId:connectionId,defaultModel:model};
        for(const bot of affected){bot.connectionId=connectionId;bot.model='';bot.reasoningEffort='';}
        const appliedBotIds=affected.map(bot=>bot.id);
        store.audit('provider.default_model',`Workspace default model set to ${selected.name}`,null,{connectionId,model,appliedBotIds,applyToAllBots});
        return {connection:connectionPublic(current),model,appliedBotIds,defaultConnectionId:connectionId,applyToAllBots};
      });
      return reply(result);
    }
    if(!action&&method==='PATCH'){
      connectionIdle(connectionId);
      const updated=providers.validate(await body(req),connection);
      await store.mutate(state=>{state.connections[state.connections.findIndex(c=>c.id===connectionId)]={...updated,status:'untested'};store.audit('provider.updated',`${updated.name} updated`);});
      return reply(connectionPublic(store.state.connections.find(c=>c.id===connectionId)));
    }
    if(!action&&method==='DELETE'){
      connectionIdle(connectionId);
      ensure(!store.state.bots.some(bot=>bot.connectionId===connectionId),409,'Choose another provider for its bots before removing this one.');
      await providers.loginCancel?.(connection);
      await store.mutate(state=>{
        const current=state.connections.find(c=>c.id===connectionId);ensure(current,409,'This provider was already removed.');
        connectionIdle(connectionId);
        ensure(!state.bots.some(bot=>bot.connectionId===connectionId),409,'Choose another provider for its bots before removing this one.');
        state.connections=state.connections.filter(c=>c.id!==connectionId);
        if(state.settings?.defaultConnectionId===connectionId)state.settings={...state.settings,defaultConnectionId:'',defaultModel:''};
        store.audit('provider.deleted',`${current.name} removed`);
      });
      return reply({deleted:true});
    }
    if(action==='test'&&method==='POST'){
      await body(req);
      try{
        const result=store.redactValue(await providers.test(connection));
        await store.mutate(state=>{const current=state.connections.find(c=>c.id===connectionId);ensure(current,409,'Provider was removed.');Object.assign(current,{status:'connected',testedAt:now(),models:(result.models||[]).slice(0,200)});delete current.error;store.audit('provider.tested',`${current.name} connected`);});
        return reply({...result,connected:true});
      }catch(error){await store.mutate(state=>{const current=state.connections.find(c=>c.id===connectionId);if(current)Object.assign(current,{status:'error',error:store.redact(error.message),testedAt:now()});});throw error;}
    }
    if(action==='models'&&method==='GET')return reply(store.redactValue(await providers.models(connection)));
    if(action==='login'&&method==='POST'){
      connectionIdle(connectionId);await body(req);
      // An app-owned loopback callback works locally and through a same-port SSH tunnel.
      const redirectUri=`http://127.0.0.1:${req.socket.localPort}/auth/callback`;
      return reply(await providers.loginStart(connection,{redirectUri}));
    }
    if(action==='login'&&method==='GET')return reply(await providers.loginStatus(connection));
    if(action==='login'&&method==='DELETE'){await providers.loginCancel(connection);return reply({cancelled:true});}
    if((action==='logout'&&method==='POST')||(action==='login'&&method==='PUT')){connectionIdle(connectionId);await providers.logout(connection);return reply({authenticated:false});}
  }

  match=route.match(/^\/api\/bots\/([a-zA-Z0-9_-]+)\/inference$/);
  if(match && ['GET','PATCH'].includes(method)) {
    const botId=match[1],bot=store.state.bots.find(item=>item.id===botId);ensure(bot,404,'Bot not found.');
    const connection=store.state.connections.find(item=>item.id===bot.connectionId);ensure(connection && connection.type!=='legacy-hermes',409,'Choose a direct model provider for this bot first.');
    const before={connectionId:bot.connectionId,model:bot.model || '',reasoningEffort:bot.reasoningEffort || ''},providerBefore={type:connection.type,baseUrl:connection.baseUrl,secret:connection.secret};
    let input;
    if(method==='PATCH') {
      input=await body(req);
      ensure(Object.keys(input).length>0 && Object.keys(input).every(key=>['model','reasoningEffort'].includes(key)),400,'Choose only a model and reasoning effort.');
      if(Object.hasOwn(input,'model'))input.model=string(input.model,'Model',200,false);
      if(Object.hasOwn(input,'reasoningEffort'))ensure(typeof input.reasoningEffort==='string' && ['', 'none','minimal','low','medium','high','xhigh','max'].includes(input.reasoningEffort),400,'Choose a supported reasoning effort or the provider default.');
    }
    const catalog=store.redactValue(await providers.models(connection));
    ensure(Array.isArray(catalog.models) && catalog.models.length>0,409,'This provider returned no available models. Refresh its catalog and try again.');
    const models=catalog.models.map(item=>({id:item.id,name:item.name,reasoning:safeReasoning(connection.type,item.reasoning),...(safeContextWindow(item.contextWindow)?{contextWindow:safeContextWindow(item.contextWindow)}:{}),...(safeImages(item.images)?{images:safeImages(item.images)}:{})}));
    const unchanged=state=>{
      const currentBot=state.bots.find(item=>item.id===botId),currentConnection=state.connections.find(item=>item.id===connection.id);
      ensure(currentBot && currentConnection && currentBot.connectionId===before.connectionId,409,'The bot provider changed while loading models. Refresh its settings.');
      ensure(currentConnection.type===providerBefore.type && currentConnection.baseUrl===providerBefore.baseUrl && currentConnection.secret===providerBefore.secret,409,'This provider changed while loading models. Refresh its settings.');
      return {currentBot,currentConnection};
    };
    if(method==='GET'){const {currentBot,currentConnection}=unchanged(store.state);return reply(inferenceState(currentBot,currentConnection,models,store.state.runs,store.state));}
    const result=await store.mutate(state=>{
      const {currentBot,currentConnection}=unchanged(state);
      ensure((currentBot.model || '')===before.model && (currentBot.reasoningEffort || '')===before.reasoningEffort,409,'The bot model settings changed while loading the catalog. Refresh before saving.');
      const model=Object.hasOwn(input,'model')?input.model:before.model,effectiveModel=model || currentConnection.defaultModel || currentConnection.model || '',selected=models.find(item=>item.id===effectiveModel);
      ensure(selected,400,'Choose a model from this provider’s current catalog. An inherited selection needs a valid provider default.');
      const effort=Object.hasOwn(input,'reasoningEffort')?input.reasoningEffort:model!==before.model?'':before.reasoningEffort;
      ensure(!effort || selected.reasoning.efforts.includes(effort),400,'This model does not advertise that reasoning effort. Choose the provider default or a listed effort.');
      currentBot.model=model;currentBot.reasoningEffort=effort;
      // Cache only safe catalog fields; active runs already hold an independent capability snapshot.
      currentConnection.models=[selected,...models.filter(item=>item.id!==selected.id)].slice(0,200);
      store.audit('bot.inference_updated',`${currentBot.name} model settings updated`,botId,{model,reasoningEffort:effort,appliesTo:'next-run'});
      return {bot:structuredClone(currentBot),...inferenceState(currentBot,currentConnection,models,state.runs,state)};
    });
    return reply(result);
  }

  if(route==='/api/integrations/catalog'&&method==='GET')return reply({integrations:integrations.catalog()});
  if(route==='/api/integrations'&&method==='POST'){
    const input=await body(req),integration={...integrations.validate(input),id:id('integration'),createdAt:now(),status:'untested'};
    await store.mutate(state=>{ensure(state.integrations.length<100,400,'You can save up to 100 integrations.');state.integrations.push(integration);store.audit('integration.created',`${integration.name} added`);});
    return reply(integrationPublic(integration),201);
  }
  match=route.match(/^\/api\/integrations\/([a-zA-Z0-9_-]+)(?:\/(test))?$/);
  if(match){
    const [,integrationId,action]=match,integration=store.state.integrations.find(i=>i.id===integrationId);
    ensure(integration,404,'Integration not found.');
    const idle=()=>ensure(!store.state.bots.some(bot=>bot.integrationIds?.includes(integrationId)&&(isActive(store.state.runs[bot.id])||rooms.reserved(bot.id))),409,'Wait for bots using this integration to finish.');
    if(!action&&method==='PATCH'){idle();const updated=integrations.validate(await body(req),integration);await store.mutate(state=>{state.integrations[state.integrations.findIndex(i=>i.id===integrationId)]={...updated,status:'untested'};store.audit('integration.updated',`${updated.name} updated`);});return reply(integrationPublic(store.state.integrations.find(i=>i.id===integrationId)));}
    if(!action&&method==='DELETE'){idle();await store.mutate(state=>{state.integrations=state.integrations.filter(i=>i.id!==integrationId);for(const bot of state.bots){bot.integrationIds=(bot.integrationIds||[]).filter(target=>target!==integrationId);if(bot.searchFallbackIntegrationId===integrationId)bot.searchFallbackIntegrationId='';}store.audit('integration.deleted',`${integration.name} removed`);});return reply({deleted:true});}
    if(action==='test'&&method==='POST'){
      await body(req);
      try{const result=store.redactValue(await integrations.discover(integrationId));await store.mutate(state=>{const current=state.integrations.find(i=>i.id===integrationId);ensure(current,409,'Integration was removed.');Object.assign(current,{status:result.status||'connected',testedAt:now(),discoveredTools:Array.isArray(result)?result:result.tools||[]});delete current.error;});return reply(Array.isArray(result)?{connected:true,tools:result}:{connected:result.status==='connected',...result});}
      catch(error){await store.mutate(state=>{const current=state.integrations.find(i=>i.id===integrationId);if(current)Object.assign(current,{status:'error',error:store.redact(error.message)});});throw error;}
    }
  }

  // Suggested memory and skill changes: the owner reviews them; accepting or undoing waits while an involved bot works.
  const proposalRoute=route.match(/^\/api\/bots\/([a-zA-Z0-9_-]+)\/proposals(?:\/([a-zA-Z0-9_-]+)\/(accept|reject|undo))?$/);
  if(proposalRoute){
    const [,botId,proposalId,action]=proposalRoute;ensure(store.state.bots.some(bot=>bot.id===botId),404,'Bot not found.');
    if(!proposalId&&method==='GET')return reply(store.redactValue(await listProposals(store,botId)));
    ensure(proposalId&&method==='POST',405,'Use GET to list suggestions or POST to review one.');
    await body(req);
    const idle=ids=>{for(const id of ids){const name=store.state.bots.find(bot=>bot.id===id)?.name || 'A bot';ensure(!isActive(store.state.runs[id])&&!rooms.reserved(id),409,id===botId?'Wait for this bot to finish its task before changing what it has learned.':`${name} is using this skill right now. Wait for it to finish.`);}};
    return reply(store.redactValue(await decideProposal(store,{botId,proposalId,action,idle})));
  }

  match=route.match(/^\/api\/bots\/([a-zA-Z0-9_-]+)\/(memory|files|attachments|events|documents|brain)(?:\/([a-zA-Z0-9_-]+))?$/);
  if(match){
    const [,botId,action,child]=match,bot=store.state.bots.find(b=>b.id===botId);ensure(bot,404,'Bot not found.');
    const idle=()=>ensure(!isActive(store.state.runs[botId])&&!rooms.reserved(botId),409,'Wait for this bot and its team task before changing its workspace.');
    // Read-only notes view for the owner; no idle check, so it works while the bot is busy.
    if(action==='brain'&&method==='GET'&&(!child||child==='note')){
      const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort(new Error('Notes request closed.'));};res.once('close',abort);
      try{
        const context={root:await getWorkspaceRoot(store,botId),resolve:safePath,signal:controller.signal};
        return reply(store.redactValue(child?await brainNote(context,{path:url.searchParams.get('path')}):await brainOverview(context)));
      }finally{res.off('close',abort);}
    }
    if(action==='memory'&&method==='GET')return reply({entries:store.redactValue(store.state.memory[botId]||[])});
    if(action==='memory'&&method==='PUT'){
      idle();const input=await body(req),key=store.redact(string(input.key,'Memory key',100)),value=store.redact(string(input.value,'Memory value',4000));
      const entry=await store.mutate(state=>{const entry=rememberFact(state,botId,{key,value,pinned:input.pinned,source:{kind:'owner-edit',observedAt:now()}});store.audit('memory.updated',`${bot.name} memory updated`,botId);return entry;});
      return reply(entry);
    }
    if(action==='memory'&&child&&method==='DELETE'){idle();await store.mutate(state=>{ensure((state.memory[botId]||[]).some(entry=>entry.id===child),404,'Memory entry not found.');state.memory[botId]=state.memory[botId].filter(entry=>entry.id!==child);store.audit('memory.deleted',`${bot.name} memory removed`,botId);});return reply({deleted:true});}
    if(action==='documents'&&child==='preview'&&method==='GET'){
      const relative=url.searchParams.get('path'),metadata=await documentFileMetadata(store,botId,relative);
      if(metadata.mime.startsWith('image/'))return reply({...metadata,title:metadata.name,text:'',preview:{kind:'image',url:`/api/bots/${encodeURIComponent(botId)}/files/view?path=${encodeURIComponent(relative)}`},warnings:['Image preview only; no OCR text is extracted. A bot whose model can see images is shown an image attached to a message.'],truncated:false});
      const {inspectDocument}=await import('./documents.mjs');
      const result=await inspectDocument(store,botId,relative);return reply({...result,name:metadata.name,downloadUrl:metadata.downloadUrl,previewUrl:metadata.previewUrl});
    }
    if(action==='files'&&method==='GET'){
      const relative=url.searchParams.get('path')||'.';
      if(child==='download'||child==='view'){
        const mime=workspaceMime(relative),inline=child==='view' && (mime==='application/pdf'||mime.startsWith('image/')||mime.startsWith('text/')||mime.startsWith('application/json'));
        const bytes=await readWorkspaceBytes(store,botId,relative);
        const name=workspaceFilename(relative),fallback=name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,160)||'workspace-file';
        res.writeHead(200,{'Content-Type':mime,'Content-Length':bytes.length,'Content-Disposition':`${inline?'inline':'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g,'%27')}`});res.end(bytes);return true;
      }
      if(child==='content'){const result=await readWorkspace(store,botId,relative,{maxBytes:100_000});return reply(typeof result==='string'?{path:relative,content:result}:result);}
      const result=await listWorkspace(store,botId,relative);return reply(Array.isArray(result)?{path:relative,files:result}:result);
    }
    if(action==='files'&&method==='PUT'){idle();const input=await body(req),filePath=string(input.path,'File path',240);ensure(typeof input.content==='string'&&Buffer.byteLength(input.content)<=100_000,400,'File content must be text under 100 KB.');await writeWorkspace(store,botId,filePath,input.content);await store.mutate(()=>store.audit('file.written',`${bot.name}: ${path.posix.basename(filePath)}`,botId));return reply({path:filePath,saved:true});}
    if(action==='attachments'&&method==='POST'){
      idle();const input=await body(req,28_000_000);ensure(Array.isArray(input.files)&&input.files.length>=1&&input.files.length<=MAX_ATTACHMENTS,400,'Choose between 1 and 5 files.');
      let total=0;const uploads=input.files.map(file=>{ensure(file&&typeof file==='object'&&!Array.isArray(file),400,'Each upload must describe a file.');const name=string(file.name,'Filename',160);ensure(!/[\\/\x00-\x1f\x7f]/.test(name)&&name!=='.'&&name!=='..',400,'Use a plain filename.');ensure(typeof file.contentBase64==='string'&&file.contentBase64.length<=26_666_668,413,'Upload file contents as base64 up to 20 MB.');const bytes=Buffer.from(file.contentBase64,'base64');ensure(bytes.toString('base64')===file.contentBase64,400,'Use canonical padded base64.');total+=bytes.length;ensure(total<=MAX_DOCUMENT_BYTES,413,'Uploads exceed the combined 20 MB limit.');return {name,path:`uploads/${id('file')}-${name}`,bytes};});
      for(const file of uploads)await writeWorkspace(store,botId,file.path,file.bytes);
      await store.mutate(()=>store.audit('file.uploaded',`${uploads.length} file${uploads.length===1?'':'s'} added to ${bot.name}`,botId));
      return reply({files:uploads.map(({bytes,...file})=>({...file,size:bytes.length,format:path.posix.extname(file.name).slice(1).toLowerCase(),mime:workspaceMime(file.path),downloadUrl:`/api/bots/${encodeURIComponent(botId)}/files/download?path=${encodeURIComponent(file.path)}`,previewUrl:`/api/bots/${encodeURIComponent(botId)}/documents/preview?path=${encodeURIComponent(file.path)}`}))},201);
    }
    if(action==='events'&&method==='GET'){const run=await runtime.poll(botId),after=Number(url.searchParams.get('after')||0);return reply({runId:run?.id,status:run?.status,events:(run?.events||[]).filter(event=>(event.seq||0)>after),partialOutput:run?.partialOutput||''});}
  }
  return false;
}
