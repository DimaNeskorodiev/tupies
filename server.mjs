import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHash, scrypt as scryptCallback } from 'node:crypto';
import { brotliCompress, gzip, constants as zlib } from 'node:zlib';
import { promisify } from 'node:util';
import { Store, HttpError, ensure, string, now, id, atomicWrite, parseSkillPackage } from './lib/store.mjs';
import { Runtime, isActive } from './lib/runtime.mjs';
import { CONTEXT_LIMITS } from './lib/context-budget.mjs';
import { removeBotSessions } from './lib/sessions.mjs';
import { routineRuns, validateRoutine } from './lib/routines.mjs';
import { Rooms, isDriveActive } from './lib/rooms.mjs';
import { Providers } from './lib/providers.mjs';
import { Integrations } from './lib/integrations.mjs';
import { Channels } from './lib/channels.mjs';
import { nativeApi, oauthCallback } from './lib/api-native.mjs';
import { dashboard } from './lib/dashboard.mjs';
import { Speech } from './lib/speech.mjs';
import { Sync, validateEngineUrl } from './lib/sync/index.mjs';
import { syncApi, syncPublicApi, isEngineRoute } from './lib/sync/api.mjs';
import { identityCertificate, CERTIFICATE_RENEWAL_MS } from './lib/sync/certificate.mjs';
import { Access, WindowCounter, addressBucket } from './lib/access.mjs';
import { controlSocketPath, controlSocketLive, prepareControlDirectory } from './lib/control.mjs';
import { APNs } from './lib/apns.mjs';
import { Notifications, notificationsApi } from './lib/notifications.mjs';

export { controlSocketPath, controlSocketLive };

const scrypt=promisify(scryptCallback);
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const COOKIE='hermes_studio_session';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.wasm':'application/wasm','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.otf':'font/otf'};
const COMPRESSIBLE=new Set(['.html','.js','.mjs','.css','.svg','.wasm','.ttf','.otf','.pfb']);
const compress={br:promisify(brotliCompress),gzip:promisify(gzip)};
const staticAssets=new Map();
const tagMatches=(header,tag)=>typeof header==='string' && header.split(',').some(value=>value.trim().replace(/^W\//,'')===tag.replace(/^W\//,''));
/** Public assets are application code, never account data: browsers revalidate them by ETag, and text is compressed once per file version. */
function staticEncoding(req,file,stat) {
  if(!COMPRESSIBLE.has(path.extname(file)) || stat.size<1024)return null;
  const accepted=String(req.headers['accept-encoding'] || '').split(',').map(value=>value.trim().split(';')).filter(([,q])=>!/^\s*q=0(\.0*)?\s*$/.test(q || '')).map(([name])=>name.trim().toLowerCase());
  const encoding=accepted.includes('br')?'br':accepted.includes('gzip')?'gzip':null;
  if(!encoding)return null;
  const version=`${stat.size}:${stat.mtimeMs}`;let asset=staticAssets.get(file);
  if(asset?.version!==version)staticAssets.set(file,asset={version,encoded:new Map()});
  if(!asset.encoded.has(encoding)) {
    const pending=fs.readFile(file).then(data=>compress[encoding](data,encoding==='br'?{params:{[zlib.BROTLI_PARAM_QUALITY]:9,[zlib.BROTLI_PARAM_SIZE_HINT]:data.length}}:{level:9}));
    asset.encoded.set(encoding,pending);pending.catch(()=>asset.encoded.delete(encoding));
  }
  return asset.encoded.get(encoding).then(data=>({encoding,data}),()=>null);
}
const safeEqual=(a,b)=>{if(typeof a!=='string' || typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length && timingSafeEqual(left,right);};
const validateKey=value=>{const key=string(value,'API key',4096);ensure(!/[\x00-\x1f\x7f]/.test(key),400,'API key cannot contain control characters.');return key;};
const objectBody=b=>ensure(b && typeof b==='object' && !Array.isArray(b),400,'Expected a JSON object.');

async function body(req,maxSize=128_000) {
  ensure((req.headers['content-type'] || '').split(';')[0].trim()==='application/json',415,'Use application/json.');
  let size=0,chunks=[];
  for await(const chunk of req) {size+=chunk.length;ensure(size<=maxSize,413,'Request is too large.');chunks.push(chunk);}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');}catch{throw new HttpError(400,'Invalid JSON.');}
  objectBody(value);return value;
}
function validateBot(input, previous={}) {
  const bot={...previous};
  ensure(!Object.hasOwn(input,'reasoningEffort'),400,'Use the bot inference settings endpoint to validate reasoning effort.');
  for(const [key,max,required] of [['name',60,true],['title',100,true],['description',1000,false],['instructions',20_000,false],['model',200,false]]) {
    if(Object.hasOwn(input,key))bot[key]=string(input[key],key,max,required);
  }
  ensure(bot.name && bot.title,400,'Bot name and title are required.');
  if(Object.hasOwn(input,'color')){ensure(['mint','lavender','peach','blue','rose','amber','coral','ruby','tangerine','lemon','lime','forest','teal','ice','indigo','plum','orchid','slate'].includes(input.color),400,'Choose a supported bot color.');bot.color=input.color;}
  if(Object.hasOwn(input,'icon'))bot.icon=string(input.icon,'icon',40);
  if(Object.hasOwn(input,'connectionId'))bot.connectionId=string(input.connectionId,'connectionId',100,false);
  for(const key of ['tools','collaborators','integrationIds'])if(Object.hasOwn(input,key)){ensure(Array.isArray(input[key]) && input[key].length<=30 && input[key].every(item=>typeof item==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(item)),400,`Choose valid ${key}.`);bot[key]=[...new Set(input[key])];}
  if(bot.tools)ensure(bot.tools.every(tool=>['workspace','memory','skills','web','integrations','delegation','automation','terminal','browser'].includes(tool)),400,'Choose supported bot tools.');
  if(Object.hasOwn(input,'approvalPolicy')){ensure(['balanced','strict'].includes(input.approvalPolicy),400,'Choose a supported action review policy.');bot.approvalPolicy=input.approvalPolicy;}
  if(Object.hasOwn(input,'skills')){ensure(Array.isArray(input.skills) && input.skills.length<=30 && input.skills.every(s=>typeof s==='string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s)),400,'Select valid local skills.');bot.skills=[...new Set(input.skills)];}
  if(Object.hasOwn(input,'enabled')){ensure(typeof input.enabled==='boolean',400,'enabled must be true or false.');bot.enabled=input.enabled;}
  if(Object.hasOwn(input,'hidden')){ensure(typeof input.hidden==='boolean',400,'hidden must be true or false.');bot.hidden=input.hidden;}
  if(Object.hasOwn(input,'teamMode')){ensure(['all','selected'].includes(input.teamMode),400,'Choose whether this bot knows the whole team or only selected teammates.');bot.teamMode=input.teamMode;}
  if(Object.hasOwn(input,'contextLimit')){ensure(CONTEXT_LIMITS.includes(input.contextLimit),400,'Choose an automatic, 128K or full-model context limit.');bot.contextLimit=input.contextLimit;}
  if(bot.connectionId!==previous.connectionId || bot.model!==previous.model)bot.reasoningEffort='';
  return {description:'',instructions:'',model:'',reasoningEffort:'',color:'slate',icon:'roki',connectionId:'',skills:[],tools:['workspace','memory','skills','web','integrations','delegation','automation'],collaborators:[],teamMode:'all',integrationIds:[],approvalPolicy:'balanced',enabled:true,hidden:false,...bot};
}
function validateBinding(bot,state) {
  if(bot.connectionId)ensure(state.connections.some(c=>c.id===bot.connectionId && c.type!=='legacy-hermes'),400,'Choose a model provider. Replace legacy gateway connections in Providers.');
  ensure((bot.collaborators||[]).every(target=>target!==bot.id && state.bots.some(b=>b.id===target)),400,'Choose other existing bots as collaborators.');
  ensure((bot.integrationIds||[]).every(target=>state.integrations.some(i=>i.id===target)),400,'Choose existing integrations.');
}

export async function createStudioServer(options={}) {
  const dataDir=options.dataDir || process.env.STUDIO_DATA_DIR || path.join(ROOT,'data');
  const store=await new Store(dataDir).init();
  const publicUrl=options.publicUrl ?? process.env.STUDIO_PUBLIC_URL ?? '';
  let publicOrigin='';
  if(publicUrl){const url=new URL(publicUrl);ensure(url.protocol==='https:' && !url.username && !url.password && (url.pathname==='/' || !url.pathname) && !url.search && !url.hash,500,'STUDIO_PUBLIC_URL must be an HTTPS origin.');publicOrigin=url.origin;}
  // STUDIO_TLS=engine: serve HTTPS directly with the engine's identity key; apps trust it through the pairing link's fingerprint.
  const tlsSetting=String(options.tls ?? process.env.STUDIO_TLS ?? '').toLowerCase();
  ensure(['','off','engine'].includes(tlsSetting),500,'STUDIO_TLS must be engine or off.');
  const tlsMode=tlsSetting==='engine',scheme=tlsMode?'https':'http';
  const allowedHosts=new Set(String(options.allowedHosts ?? process.env.STUDIO_ALLOWED_HOSTS ?? '').split(',').map(host=>host.trim().toLowerCase()).filter(Boolean));
  const sync=await new Sync(store,{publicUrl:publicOrigin,tls:tlsMode,logErrors:options.logErrors,...options.sync}).init();
  // Nothing sits in front of an engine that terminates TLS itself, so no proxy may report client addresses.
  const access=await new Access(dataDir,{publicHost:publicOrigin?new URL(publicOrigin).host:'',...(tlsMode?{trustProxy:'none'}:options.trustProxy?{trustProxy:options.trustProxy}:{})}).init();
  const providers=options.providers || new Providers(store,options);
  providers.oauth && (providers.oauth.refreshDelegate=connectionId=>sync.role()==='replica'?sync.delegateRefresh(connectionId):null);
  const speech=new Speech(store,options);
  const integrations=options.integrations || new Integrations(store,options);
  const runtime=new Runtime(store,{...options,providers,integrations,busyElsewhere:botId=>sync.busyElsewhere(botId),automation:()=>sync.runsAutomation()});
  sync.locallyActive=botId=>isActive(store.state.runs[botId]) || runtime.starting.has(botId);
  await runtime.recover();
  const rooms=new Rooms(store,runtime);runtime.roomManager=rooms;await rooms.recover();
  const channels=new Channels(store,runtime,options);
  await channels.recover?.();
  const notificationTransport=options.notifications?.transport || await new APNs(options.apns).init();
  const notifications=await new Notifications(store,{...options.notifications,sync,transport:notificationTransport}).init();
  const bootstrapToken=options.bootstrapToken || randomBytes(24).toString('base64url');
  const sessions=new Map(), attempts=new WindowCounter();
  const secureCookie=options.secureCookie ?? (tlsMode || process.env.STUDIO_SECURE_COOKIE==='true' || !!publicOrigin);
  let closed=false,ticking=false,control=null,controlFile='';
  function headers(res) {
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy','camera=(), microphone=(self), geolocation=()');
    res.setHeader('Cache-Control','no-store');
    if(secureCookie)res.setHeader('Strict-Transport-Security','max-age=31536000');
  }
  function json(res,data,status=200) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
  /** Chat polling: an unchanged transcript answers 304. Only the tag is remembered, keyed by the store's commit revision. */
  const pollTags=new Map();
  function pollReply(req,res,key,extra,build) {
    const marker=`${store.revision}:${JSON.stringify(extra ?? null)}`;let entry=pollTags.get(key),text=null;
    if(entry?.marker!==marker) {
      text=JSON.stringify(build());entry={marker,tag:`"${createHash('sha256').update(text).digest('base64url').slice(0,32)}"`};
      pollTags.delete(key);pollTags.set(key,entry);if(pollTags.size>64)pollTags.delete(pollTags.keys().next().value);
    }
    res.setHeader('ETag',entry.tag);
    if(tagMatches(req.headers['if-none-match'],entry.tag)){res.writeHead(304);return res.end();}
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(text ?? JSON.stringify(build()));
  }
  function verifyHost(req) {
    let origin;try{origin=new URL(`http://${req.headers.host}`);}catch{throw new HttpError(403,'Invalid Host header.');}
    if(publicOrigin && req.headers.host===new URL(publicOrigin).host)return;
    const host=origin.hostname.replace(/^\[|\]$/g,'');
    if(allowedHosts.has(host.toLowerCase()) || allowedHosts.has(req.headers.host.toLowerCase()))return;
    ensure(['localhost','127.0.0.1','::1'].includes(host),403,'Host is not allowed. Configure STUDIO_PUBLIC_URL for HTTPS access.');
    const port=server.address()?.port;
    ensure(Number(origin.port || (tlsMode?443:80))===port,403,'Host port does not match this server.');
  }
  function verifyOrigin(req) {
    const origin=req.headers.origin;if(!origin)return;
    const expected=publicOrigin && req.headers.host===new URL(publicOrigin).host ? publicOrigin : `${scheme}://${req.headers.host}`;
    ensure(origin===expected,403,'Cross-origin requests are not allowed.');
    ensure(!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site']!=='cross-site',403,'Cross-site requests are not allowed.');
  }
  function getSession(req) {
    const cookie=(req.headers.cookie || '').split(';').map(v=>v.trim()).find(v=>v.startsWith(`${COOKIE}=`));
    const token=cookie?.slice(COOKIE.length+1), session=token && sessions.get(token);
    if(!session)return null;
    // A web view signed in through a device ticket loses its session as soon as that device is revoked, here or on another engine.
    if(session.expires<Date.now() || (session.deviceId && !sync.devices.find(session.deviceId))){sessions.delete(token);return null;}
    // A password session does not carry over to the internet address while sign-in there is limited to paired apps.
    if(!session.deviceId && !access.passwordAllowed(req))return null;
    return {...session,token};
  }
  function auth(req,mutate=false) {
    // Paired apps and linked engines use short-lived bearer tokens; they are not ambient browser credentials, so CSRF does not apply.
    const device=sync.devices.authenticate(req.headers.authorization);
    if(device)return device;
    ensure(!/^Bearer /i.test(req.headers.authorization || ''),401,'This device session expired. Sign in again.');
    const session=getSession(req);ensure(session,401,'Sign in to continue.');
    if(mutate&&!safeEqual(req.headers['x-csrf-token'],session.csrf))throw Object.assign(new HttpError(403,'Security token expired. Reload and try again.'),{code:'csrf_mismatch'});
    return session;
  }
  function login(res,deviceId=null) {
    const token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url');
    for(const [k,v] of sessions){if(v.expires<Date.now())sessions.delete(k);}
    if(sessions.size>=100)sessions.delete(sessions.keys().next().value);
    sessions.set(token,{csrf,expires:Date.now()+12*60*60*1000,...(deviceId?{deviceId}:{})});
    res.setHeader('Set-Cookie',`${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookie?'; Secure':''}`);
    return {authenticated:true,csrf};
  }
  /** Unauthenticated sign-in and pairing attempts per client (IPv6 by /64). A successful password sign-in clears its client. */
  function rateLimit(req) {
    const key=addressBucket(access.client(req));
    ensure(attempts.count(key)<10,429,'Too many sign-in attempts. Wait 15 minutes.');attempts.add(key,15*60*1000);
  }
  const handler=async(req,res)=>{
    headers(res);
    try {
      verifyHost(req);verifyOrigin(req);
      const url=new URL(req.url,`http://${req.headers.host}`),pathname=url.pathname;
      const method=req.method;
      if(method==='GET' && pathname==='/auth/callback'){await oauthCallback(req,res,url,providers);return;}
      if(await syncPublicApi(req,res,url,{sync,body,json,login,rateLimit,access}))return;
      if(method==='GET' && pathname==='/api/auth') {
        const session=getSession(req);return json(res,{setupRequired:!store.state.password,authenticated:!!session,csrf:session?.csrf || null,passwordSignIn:access.passwordAllowed(req)});
      }
      if(method==='POST' && pathname==='/api/setup') {
        const refund=access.checkPassword(req);let wrong=false;
        try {
          rateLimit(req);ensure(!store.state.password,409,'Tupies is already set up.');
          const input=await body(req);
          wrong=!safeEqual(input.token,bootstrapToken);ensure(!wrong,403,'The setup token is incorrect. Copy it from the Tupies terminal.');
          const password=string(input.password,'Password',1024);ensure(password.length>=12,400,'Use a password of at least 12 characters.');
          const salt=randomBytes(16).toString('hex'),hash=(await scrypt(password,salt,64)).toString('hex');
          await store.mutate(state=>{ensure(!state.password,409,'Tupies is already set up.');state.password={salt,hash};store.audit('security.setup','Workspace password created');});
          attempts.delete(addressBucket(access.client(req)));return json(res,login(res),201);
        } finally {if(!wrong)refund();}
      }
      if(method==='POST' && pathname==='/api/login') {
        // A wrong password keeps its place under the internet cap; anything else (limits, malformed input, success) is refunded.
        const refund=access.checkPassword(req);let wrong=false;
        try {
          rateLimit(req);ensure(store.state.password,409,'Set up Tupies first.');
          const input=await body(req),password=string(input.password,'Password',1024);
          const hash=(await scrypt(password,store.state.password.salt,64)).toString('hex');
          wrong=!safeEqual(hash,store.state.password.hash);ensure(!wrong,401,'Incorrect password.');
          attempts.delete(addressBucket(access.client(req)));return json(res,login(res));
        } finally {if(!wrong)refund();}
      }
      if(pathname.startsWith('/api/')) {
        const session=auth(req,!['GET','HEAD'].includes(method));
        ensure(session.kind!=='engine' || isEngineRoute(pathname),403,'Linked engines can only use sync routes.');
        const requestOrigin=publicOrigin && req.headers.host===new URL(publicOrigin).host ? publicOrigin : `${scheme}://${req.headers.host}`;
        if(await syncApi(req,res,url,{sync,session,body,json,providers,requestOrigin,access}))return;
        if(await notificationsApi(req,res,url,{session,notifications,body,json}))return;
        if(method==='POST' && pathname==='/api/logout'){sessions.delete(session.token);if(session.device)sync.devices.sessions.delete(session.token);res.setHeader('Set-Cookie',`${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie?'; Secure':''}`);return json(res,{authenticated:false});}
        if(method==='GET' && pathname==='/api/state')return json(res,{...store.publicState(),sync:sync.summary(),browser:runtime.browsers.status()});
        if(method==='GET' && pathname==='/api/dashboard'){const busy=sync.summary().busy;return pollReply(req,res,'dashboard',busy,()=>dashboard(store,{busy}));}
        if(await nativeApi(req,res,url,{store,providers,speech,integrations,channels,runtime,rooms,body,json}))return;
        // After an uncertain send, the browser asks whether the engine received its message before sending it again.
        const receiptMatch=method==='GET' && pathname.match(/^\/api\/bots\/([a-zA-Z0-9_-]+)\/submissions\/([A-Za-z0-9_-]{8,80})$/);
        if(receiptMatch) {
          ensure(store.state.bots.some(b=>b.id===receiptMatch[1]),404,'Bot not found.');
          const receipt=runtime.receipt(receiptMatch[1],receiptMatch[2]);
          if(!receipt)return json(res,{received:false,pending:runtime.submitting.has(`${receiptMatch[1]}\n${receiptMatch[2]}`)},404);
          return json(res,{received:true,runId:receipt.runId,createdAt:receipt.createdAt,run:runtime.receiptRun(receiptMatch[1],receipt)});
        }
        if(method==='POST' && pathname==='/api/bots') {
          const input=await body(req);
          const bot=await store.mutate(state=>{const bot=validateBot(input,{id:id('bot'),createdAt:now(),connectionId:state.settings.defaultConnectionId||''});ensure(state.bots.length<100,400,'Workspace supports up to 100 bots.');validateBinding(bot,state);ensure(bot.skills.every(s=>state.skills.some(x=>x.id===s)),400,'Unknown skill.');state.bots.push(bot);store.audit('bot.created',`${bot.name} joined your team`,bot.id);return bot;});
          return json(res,bot,201);
        }
        let match=pathname.match(/^\/api\/bots\/([a-zA-Z0-9_-]+)(?:\/(messages|run|runs|stop|approval|answer|capabilities|skills|compact))?$/);
        if(match) {
          const [,botId,action]=match,bot=store.state.bots.find(b=>b.id===botId);ensure(bot,404,'Bot not found.');
          if(!action && method==='PATCH') {
            const input=await body(req);
            // Hiding only changes where a bot is listed, so it never waits for the bot's work.
            if(input && typeof input==='object' && Object.keys(input).length===1 && Object.hasOwn(input,'hidden')) {
              ensure(typeof input.hidden==='boolean',400,'hidden must be true or false.');
              const updated=await store.mutate(state=>{const target=state.bots.find(b=>b.id===botId);ensure(target,404,'Bot not found.');target.hidden=input.hidden;store.audit('bot.updated',`${target.name} was ${input.hidden?'hidden':'shown again'}`,botId);return structuredClone(target);});
              return json(res,updated);
            }
            ensure(!isActive(store.state.runs[botId]) && !rooms.reserved(botId),409,'Wait for this bot and its room turn to finish before editing it.');
            const updated=validateBot(input,bot);
            if(updated.connectionId!==bot.connectionId)delete updated.sessionId;
            await store.mutate(state=>{validateBinding(updated,state);ensure(updated.skills.every(s=>state.skills.some(x=>x.id===s)),400,'Unknown skill.');state.bots[state.bots.findIndex(b=>b.id===botId)]=updated;store.audit('bot.updated',`${updated.name} was updated`,botId);});return json(res,updated);
          }
          if(!action && method==='DELETE') {
            ensure(!isActive(store.state.runs[botId]) && !rooms.reserved(botId),409,'Stop the active run and room turn before removing this bot.');
            await store.mutate(state=>{state.bots=state.bots.filter(b=>b.id!==botId);state.routines=state.routines.filter(r=>r.botId!==botId);delete state.messages[botId];removeBotSessions(state,botId);delete state.memory[botId];delete state.runs[botId];delete state.runHistory?.[botId];delete state.submissions?.[botId];state.proposals=(state.proposals || []).filter(item=>item.botId!==botId);for(const b of state.bots)b.collaborators=(b.collaborators||[]).filter(id=>id!==botId);for(const room of state.rooms)room.botIds=room.botIds.filter(id=>id!==botId);for(const channel of state.channels)if(channel.botId===botId){channel.enabled=false;channel.error='The assigned bot was removed.';}store.audit('bot.deleted',`${bot.name} removed from this workspace`);});return json(res,{deleted:true});
          }
          if(action==='messages' && method==='GET'){await runtime.poll(botId);const elsewhere=sync.busyElsewhere(botId);return pollReply(req,res,`bot:${botId}`,elsewhere,()=>({messages:store.state.messages[botId] || [],run:store.state.runs[botId] || null,elsewhere}));}
          if(action==='compact' && method==='POST'){
            const input=await body(req);ensure(input && typeof input==='object' && Object.keys(input).every(key=>key==='topic') && (input.topic===undefined || typeof input.topic==='boolean'),400,'Send {topic?: boolean}.');
            return json(res,await runtime.compactChat(botId,{topic:input.topic===true}));
          }
          if(action==='messages' && method==='POST'){
            const input=await body(req),text=input.text===undefined?'':input.text;
            ensure(typeof text==='string' && text.length<=20_000,400,'Message must contain at most 20000 characters.');
            const result=await runtime.submit(botId,text,{attachments:input.attachments===undefined?[]:input.attachments,...(input.clientMessageId!==undefined?{clientMessageId:input.clientMessageId}:{})});
            return json(res,result,result.duplicate?200:202);
          }
          if(action==='run' && method==='GET')return json(res,{run:await runtime.poll(botId) || null});
          if(['stop','approval','answer'].includes(action) && method==='POST'){const input=await body(req);return json(res,await runtime.control(botId,action,input));}
          if(action==='runs' && method==='GET')return json(res,{data:store.state.runHistory?.[botId] || []});
          if(action==='capabilities' && method==='GET')return json(res,store.redactValue(await runtime.capabilities(bot)));
          if(action==='skills' && method==='GET')return json(res,{data:store.state.skills.filter(skill=>bot.skills.includes(skill.id))});
        }
        if(method==='POST' && pathname==='/api/rooms') {
          const input=await body(req),name=string(input.name,'Room name',100);
          ensure(Array.isArray(input.botIds) && input.botIds.length>=2 && input.botIds.length<=8 && new Set(input.botIds).size===input.botIds.length,400,'Choose 2–8 different bots.');
          ensure(input.botIds.every(id=>store.state.bots.some(b=>b.id===id)),400,'Choose existing bots.');
          ensure(input.autoCollaborate===undefined||typeof input.autoCollaborate==='boolean',400,'Choose a valid collaboration mode.');
          ensure(input.maxRounds===undefined||(Number.isInteger(input.maxRounds)&&input.maxRounds>=1&&input.maxRounds<=8),400,'Choose between 1 and 8 handoffs.');
          const room={id:id('room'),name,botIds:input.botIds,autoCollaborate:input.autoCollaborate??true,maxRounds:input.maxRounds||4,createdAt:now()};
          await store.mutate(state=>{ensure(state.rooms.length<100,400,'Workspace supports up to 100 rooms.');state.rooms.push(room);store.audit('room.created',`${name} room created`,null,{roomId:room.id});});return json(res,room,201);
        }
        match=pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)(?:\/(messages|stop))?$/);
        if(match) {
          const [,roomId,action]=match,room=store.state.rooms.find(r=>r.id===roomId);ensure(room,404,'Room not found.');
          if(!action && method==='PATCH') {
            ensure(!isDriveActive(store.state.roomDrives[roomId]),409,'Wait for this room turn to finish before editing it.');
            const input=await body(req),updated={...room};
            if(Object.hasOwn(input,'name'))updated.name=string(input.name,'Room name',100);
            if(Object.hasOwn(input,'autoCollaborate')){ensure(typeof input.autoCollaborate==='boolean',400,'Choose a valid collaboration mode.');updated.autoCollaborate=input.autoCollaborate;}
            if(Object.hasOwn(input,'maxRounds')){ensure(Number.isInteger(input.maxRounds)&&input.maxRounds>=1&&input.maxRounds<=8,400,'Choose between 1 and 8 handoffs.');updated.maxRounds=input.maxRounds;}
            if(Object.hasOwn(input,'botIds')) {ensure(Array.isArray(input.botIds) && input.botIds.length>=2 && input.botIds.length<=8 && new Set(input.botIds).size===input.botIds.length,400,'Choose 2–8 different bots.');ensure(input.botIds.every(id=>store.state.bots.some(b=>b.id===id)),400,'Choose existing bots.');updated.botIds=input.botIds;}
            await store.mutate(state=>{state.rooms[state.rooms.findIndex(r=>r.id===roomId)]=updated;store.audit('room.updated',`${updated.name} room updated`,null,{roomId});});return json(res,updated);
          }
          if(!action && method==='DELETE') {
            ensure(!isDriveActive(store.state.roomDrives[roomId]),409,'Stop this room turn before removing it.');
            await store.mutate(state=>{state.rooms=state.rooms.filter(r=>r.id!==roomId);delete state.roomMessages[roomId];delete state.roomDrives[roomId];store.audit('room.deleted',`${room.name} room removed`);});return json(res,{deleted:true});
          }
          if(action==='messages' && method==='GET') {
            const drive=store.state.roomDrives[roomId];if(drive?.currentBotId)await runtime.poll(drive.currentBotId);await rooms.advance(roomId);
            return pollReply(req,res,`room:${roomId}`,null,()=>({messages:store.state.roomMessages[roomId] || [],drive:store.state.roomDrives[roomId] || null}));
          }
          if(action==='messages' && method==='POST'){const input=await body(req);return json(res,{drive:await rooms.start(roomId,string(input.text,'Message',20_000))},202);}
          if(action==='stop' && method==='POST'){const input=await body(req);return json(res,{drive:await rooms.stop(roomId,input)});}
        }
        if(pathname==='/api/skills' && method==='POST') {
          const input=await body(req,7_100_000),{skill,files}=parseSkillPackage(input);
          const staging=path.join(store.directory,'skills',`.import-${id('stage')}`),target=path.join(store.directory,'skills',skill.id);
          let installed=false;
          try {
            await store.mutate(async state=>{
              ensure(!state.skills.some(s=>s.id===skill.id),409,'A local skill with this name already exists.');ensure(state.skills.length<200,400,'Workspace supports up to 200 local skills.');
              await fs.mkdir(staging,{mode:0o700});
              for(const file of files){const destination=path.join(staging,file.path);await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});await fs.writeFile(destination,file.data,{mode:0o600,flag:'wx'});}
              await fs.rename(staging,target);installed=true;
              state.skills.push(skill);store.audit('skill.imported',`${skill.name} skill imported`);
            });
          } catch(err) {if(installed)await fs.rm(target,{recursive:true,force:true});throw err;}
          finally {await fs.rm(staging,{recursive:true,force:true});}
          return json(res,skill,201);
        }
        match=pathname.match(/^\/api\/skills\/([a-z0-9][a-z0-9-]{0,63})(?:\/(export))?$/);
        if(match) {
          const skill=store.state.skills.find(s=>s.id===match[1]);ensure(skill,404,'Skill not found.');
          if(method==='GET' && match[2]==='export'){const files=await Promise.all((skill.files || ['SKILL.md']).map(async filePath=>({path:filePath,contentBase64:(await fs.readFile(path.join(store.directory,'skills',skill.id,filePath))).toString('base64')})));return json(res,{files});}
          if(method==='GET')return json(res,{...skill,content:await fs.readFile(path.join(store.directory,'skills',skill.id,'SKILL.md'),'utf8')});
          if(method==='DELETE' && !match[2]) {
            ensure(!store.state.bots.some(b=>b.skills.includes(skill.id) && isActive(store.state.runs[b.id])),409,'A bot is currently using this skill. Wait for it to finish.');
            await store.mutate(async state=>{state.skills=state.skills.filter(s=>s.id!==skill.id);for(const bot of state.bots)bot.skills=bot.skills.filter(s=>s!==skill.id);await fs.rm(path.join(store.directory,'skills',skill.id),{recursive:true,force:true});store.audit('skill.deleted',`${skill.name} skill removed`);});return json(res,{deleted:true});
          }
        }
        if(pathname==='/api/routines' && method==='POST') {
          const input=await body(req),routine=validateRoutine(input,{id:id('routine'),createdAt:now()},{timeZone:store.state.settings.timezone});
          ensure(store.state.bots.some(b=>b.id===routine.botId),400,'Choose an existing bot.');
          if(routine.enabled)runtime.connection(store.state.bots.find(b=>b.id===routine.botId));
          // The owner's chosen zone becomes the default for routines bots create.
          await store.mutate(state=>{ensure(state.routines.length<200,400,'Workspace supports up to 200 routines.');state.routines.push(routine);if(input.timezone)state.settings.timezone=routine.timezone;store.audit('routine.created',`${routine.name} routine created`,routine.botId);});return json(res,routine,201);
        }
        match=pathname.match(/^\/api\/routines\/([a-zA-Z0-9_-]+)(?:\/(run|runs))?$/);
        if(match) {
          const [,routineId,action]=match,routine=store.state.routines.find(r=>r.id===routineId);ensure(routine,404,'Routine not found.');
          if(action==='run' && method==='POST'){await body(req);return json(res,{run:await runtime.runRoutine(routineId)},202);}
          if(action==='runs' && method==='GET')return json(res,{data:routineRuns(store.state,routine),missedRuns:routine.missedRuns || 0,...(routine.lastMissedAt?{lastMissedAt:routine.lastMissedAt}:{})});
          if(!action && method==='PATCH') {
            const input=await body(req),updated=validateRoutine(input,routine,{timeZone:store.state.settings.timezone});ensure(store.state.bots.some(b=>b.id===updated.botId),400,'Choose an existing bot.');
            if(updated.enabled)runtime.connection(store.state.bots.find(b=>b.id===updated.botId));
            await store.mutate(state=>{state.routines[state.routines.findIndex(r=>r.id===routineId)]=updated;if(input.timezone)state.settings.timezone=updated.timezone;store.audit('routine.updated',`${updated.name} routine updated`,updated.botId);});return json(res,updated);
          }
          if(!action && method==='DELETE'){await store.mutate(state=>{state.routines=state.routines.filter(r=>r.id!==routineId);store.audit('routine.deleted',`${routine.name} routine removed`,routine.botId);});return json(res,{deleted:true});}
        }
        throw new HttpError(404,'API route not found.');
      }
      ensure(['GET','HEAD'].includes(method),405,'Method not allowed.');
      let relative;try{relative=decodeURIComponent(pathname);}catch{throw new HttpError(400,'Invalid path.');}
      ensure(!relative.includes('\0') && !relative.includes('\\') && !relative.split('/').includes('..'),404,'Not found.');
      if(relative==='/')relative='/index.html';
      const file=path.resolve(ROOT,'public',`.${relative}`),base=path.join(ROOT,'public')+path.sep;
      ensure(file.startsWith(base) && Object.hasOwn(MIME,path.extname(file)),404,'Not found.');
      const stat=await fs.stat(file).catch(()=>null);ensure(stat?.isFile(),404,'Not found.');
      const real=await fs.realpath(file);ensure(real.startsWith(base),404,'Not found.');
      const tag=`W/"${stat.size.toString(36)}-${Math.trunc(stat.mtimeMs).toString(36)}"`;
      res.setHeader('Cache-Control','no-cache');res.setHeader('ETag',tag);res.setHeader('Vary','Accept-Encoding');
      if(tagMatches(req.headers['if-none-match'],tag)){res.writeHead(304);return res.end();}
      const encoded=await staticEncoding(req,file,stat),data=encoded?.data || await fs.readFile(file);
      res.writeHead(200,{'Content-Type':MIME[path.extname(file)],'Content-Length':data.length,...(encoded?{'Content-Encoding':encoded.encoding}:{})});res.end(method==='HEAD'?undefined:data);
    } catch(err) {
      if(!res.headersSent)json(res,{error:err instanceof HttpError ? store.redact(err.message) : 'An internal error occurred. Check the Tupies terminal.',...(err.code==='csrf_mismatch'?{code:'csrf_mismatch'}:{})},err.status || 500);
      else res.end();
      if(!(err instanceof HttpError) && options.logErrors!==false)console.error('Tupies internal error:',store.redact(err.stack || err.message));
    }
  };
  const tlsContext=()=>({key:sync.identity.privateKey,cert:identityCertificate(sync.identity.privateKey,{hosts:[publicOrigin?new URL(publicOrigin).hostname:'']}),minVersion:'TLSv1.3'});
  const server=tlsMode?https.createServer(tlsContext(),handler):http.createServer(handler);
  // The certificate is short-lived; renewing it over the same identity key keeps every pairing valid.
  const renewal=tlsMode?setInterval(()=>server.setSecureContext(tlsContext()),options.certificateRenewalMs || CERTIFICATE_RENEWAL_MS):null;
  renewal?.unref();
  server.requestTimeout=30_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;
  const timer=options.scheduler===false ? null : setInterval(async()=>{if(ticking || closed)return;ticking=true;try{await runtime.tick();if(sync.runsAutomation())await channels.tick();}catch(err){if(options.logErrors!==false)console.error('Tupies scheduler:',store.redact(err.message));}finally{ticking=false;}},options.pollInterval || 2500);
  timer?.unref();
  function controlCommand(request,localUrl) {
    ensure(request?.v===1,400,'Update Tupies: unsupported command version.');
    if(request.command==='pair') {
      const kind=request.kind==='engine'?'engine':'device',baseUrl=request.url?validateEngineUrl(request.url):publicOrigin || localUrl;
      const {qrSvg,...pairing}=sync.devices.createPairing({kind,baseUrl});
      return {pairing:{...pairing,name:sync.identity.name}};
    }
    throw new HttpError(400,'Unknown command.');
  }
  return {
    server,bootstrapToken,store,runtime,rooms,providers,integrations,channels,sync,access,notifications,
    /** Shell commands of the same user (npm run pair) reach the engine through a socket inside the private data directory. */
    async openControl(file,localUrl) {
      await prepareControlDirectory(file);
      ensure(!await controlSocketLive(file),409,'Another Tupies engine is already using this data directory.');
      await fs.rm(file,{force:true});
      const listener=net.createServer(socket=>{
        let input='';socket.setTimeout(5000,()=>socket.destroy());socket.on('error',()=>{});
        socket.on('data',chunk=>{
          input+=chunk;if(input.length>4096){socket.destroy();return;}
          const end=input.indexOf('\n');if(end<0)return;
          socket.removeAllListeners('data');
          let reply;
          try{reply={ok:true,...controlCommand(JSON.parse(input.slice(0,end)),localUrl)};}
          catch(err){reply={ok:false,error:err instanceof HttpError?err.message:'The command could not be handled.'};}
          socket.end(`${JSON.stringify(reply)}\n`);
        });
      });
      await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(file,()=>{listener.off('error',reject);resolve();});});
      await fs.chmod(file,0o600);control=listener;controlFile=file;
    },
    /** Lets the Mac app on this account pair with a loopback engine without a code: same-user processes can already read the data directory. */
    async writeLocalPairing(file,url) {
      const write=async()=>{const pairing=sync.devices.createPairing({kind:'device',baseUrl:url,local:true});await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await atomicWrite(file,JSON.stringify({v:1,url,code:pairing.code,fingerprint:pairing.fingerprint,name:sync.identity.name,expiresAt:pairing.expiresAt},null,2));};
      sync.devices.onLocalPairingUsed=()=>{write().catch(()=>{});};
      await write();
      // Local codes last a day; refresh well before then so a long-running engine never leaves a stale file.
      const refresh=setInterval(()=>{if(!closed)write().catch(()=>{});},12*60*60_000);refresh.unref?.();
    },
    async listen(port=Number(process.env.STUDIO_PORT || 4310),host=process.env.STUDIO_HOST || '127.0.0.1') {
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve();});});
      return {port:server.address().port,url:`${scheme}://${host.includes(':')?`[${host}]`:host}:${server.address().port}`};
    },
    async close() {
      if(closed)return;closed=true;if(timer)clearInterval(timer);if(renewal)clearInterval(renewal);runtime.closing=true;
      speech.close();
      await notifications.close();
      if(control){control.close();await fs.rm(controlFile,{force:true});}
      // Ends open sync long-polls first so the listener can close promptly.
      await sync.close();
      await channels.close();
      // Polling clients (browser tabs, app web views) can keep keep-alive sockets busy indefinitely; give them two seconds.
      const listenerClosed=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();
      const force=setTimeout(()=>server.closeAllConnections(),2000);force.unref?.();
      await listenerClosed;clearTimeout(force);server.closeAllConnections();
      await runtime.close();
      // Detached room admissions and scheduler work must settle before releasing data.
      while(runtime.starting.size || runtime.polling.size || rooms.working.size || ticking)await new Promise(resolve=>setTimeout(resolve,10));
      await providers.close?.();await integrations.close?.();await store.queue;sessions.clear();
    }
  };
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const controlFile=controlSocketPath(process.env.STUDIO_DATA_DIR || path.join(ROOT,'data'));
  if(await controlSocketLive(controlFile)){console.error('Another Tupies engine is already running with this data directory. Stop it before starting a second one.');process.exit(1);}
  const app=await createStudioServer();
  const address=await app.listen();
  console.log(`\nTupies is running at ${address.url}`);
  if(process.env.STUDIO_TLS==='engine')console.log(process.env.STUDIO_PUBLIC_URL?`Apps connect to ${process.env.STUDIO_PUBLIC_URL} and trust this engine's own certificate (server code ${app.sync.identity.fingerprint.slice(0,8).toUpperCase().replace(/(.{4})/,'$1 ')}).`:'Set STUDIO_PUBLIC_URL to this server\'s https:// address so pairing links point here.');
  await app.openControl(controlFile,address.url).catch(err=>console.error('Tupies shell commands (npm run pair) are unavailable:',err.message));
  const loopback=['127.0.0.1','::1','localhost'].includes(process.env.STUDIO_HOST || '127.0.0.1');
  const pairingFile=process.env.STUDIO_LOCAL_PAIRING_FILE || (process.platform==='darwin' && loopback ? path.join(process.env.HOME || '',`Library/Application Support/Hermes Studio/local-engine.json`) : '');
  if(pairingFile && loopback)await app.writeLocalPairing(pairingFile,address.url).catch(err=>console.error('Tupies local pairing:',err.message));
  if(!app.store.state.password)console.log(`One-time setup token: ${app.bootstrapToken}\nOpen Tupies, paste this token, and choose a password.\n`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
}
