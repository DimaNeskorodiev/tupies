import { ensure, HttpError, id, now } from './store.mjs';
import { groupsFor } from './agent-tools.mjs';

const MAX_HANDOFFS=20,MAX_IDLE_MS=30*60*1000;
const IDENTITY=['runId','remoteRunId','request_id','execution_generation'];
const plain=value=>value && typeof value==='object' && !Array.isArray(value);
const ACTION_FIELDS={click:['x','y'],text:['text'],key:['key'],scroll:['deltaY','deltaX'],navigate:['url'],tab:['tabId'],drag:['x','y','toX','toY'],dialog:['accept','promptText']};
export const browserHandoffDefinition=()=>({name:'browser_handoff',description:'Pause a direct owner chat so the owner can operate this task’s open browser for a sign-in, password, two-factor code or human verification. Never ask for credentials in chat or attempt a challenge yourself. The owner’s inputs and screenshots stay outside model history. The owner may keep this bot’s browser session on this engine, resume or skip. Handoff does not approve later bot actions; inspect the current page after resuming.',parameters:{type:'object',properties:{reason:{type:'string',maxLength:1000,description:'Briefly explain what the owner needs to do. Do not include credentials.'}},required:['reason'],additionalProperties:false}});

function validate(input,extra=[]) {
  ensure(plain(input) && Object.keys(input).every(key=>[...IDENTITY,...extra].includes(key)),400,'Browser control contains unknown fields.');
  ensure(Buffer.byteLength(JSON.stringify(input))<=32_000,413,'Browser control exceeds the size limit.');
  ensure(IDENTITY.slice(0,3).every(key=>typeof input[key]==='string' && input[key].length<=100) && Number.isSafeInteger(input.execution_generation),400,'Use the exact current browser request identity.');
}

/** Owner-only rendezvous. Browser pixels, typed inputs and page identities exist only in memory and the direct API response. */
export class BrowserControl {
  constructor(engine){this.engine=engine;this.pending=new Map();}
  async ask(context,args){
    const engine=this.engine;
    ensure(plain(args) && Object.keys(args).length===1 && typeof args.reason==='string' && args.reason.trim() && args.reason.length<=1000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args.reason),400,'Give a brief browser handoff reason.');
    engine.assertRunning(context);engine.assertNoPendingSteer(context);
    ensure(context.source==='chat' && (!context.lane || context.lane==='chat'),403,'Browser handoff is available only in a direct owner Tupies chat.');
    ensure(groupsFor(context.bot).includes('browser'),403,'Browser handoff needs Browser tools.');
    const session=engine.browsers.sessions.get(context.runId);
    ensure(session && (!session.botId || session.botId===context.bot.id),409,'Open this task’s browser before requesting a handoff.');
    ensure(!this.pending.has(context.runId),409,'This task already has a browser handoff.');
    ensure((context.browserHandoffs || 0)<MAX_HANDOFFS,400,'This task reached its browser handoff limit.');context.browserHandoffs=(context.browserHandoffs || 0)+1;
    const promptId=id('browser'),generation=(engine.current(context)?.execution_generation || 0)+1;
    let resolve,reject;const decision=new Promise((yes,no)=>{resolve=yes;reject=no;});void decision.catch(()=>{});
    const pending={context,session,promptId,generation,resolve,reject,busy:false,claimed:false,view:null};this.pending.set(context.runId,pending);
    const onAbort=()=>reject(context.controller.signal.reason || Object.assign(new Error('Task cancelled.'),{name:'AbortError'}));
    context.controller.signal.addEventListener('abort',onAbort,{once:true});if(context.controller.signal.aborted)onAbort();
    let timer,paused=false;
    try {
      const reason=engine.store.redact(args.reason).replace(/https?:\/\/[^\s]+/g,value=>{try{const url=new URL(value);return `${url.origin}${url.pathname}`;}catch{return '[web page]';}});
      await engine.update(context,{status:'waiting_for_input',execution_generation:generation,pending_controls:[{kind:'browser',prompt_id:promptId,reason}]});
      await engine.event(context,'browser.handoff_requested',{requestId:promptId,executionGeneration:generation});
      engine.assertRunning(context);engine.pauseForInput(context);paused=true;
      const configured=engine.options.browserHandoffTimeoutMs,idleMs=Number.isFinite(configured)?Math.max(100,Math.min(configured,MAX_IDLE_MS)):MAX_IDLE_MS;
      timer=setTimeout(()=>reject(new HttpError(408,'Browser handoff expired. No owner action or sign-in success is assumed.')),idleMs);timer.unref();
      const result=await decision;engine.assertRunning(context);return result;
    } finally {
      clearTimeout(timer);context.controller.signal.removeEventListener('abort',onAbort);pending.view=null;
      if(this.pending.get(context.runId)===pending)this.pending.delete(context.runId);
      if(paused)engine.resumeAfterInput(context);
      if(!context.controller.signal.aborted && !engine.closing && engine.current(context)?.status==='waiting_for_input')await engine.update(context,{status:'running',pending_controls:[]});
    }
  }
  current(botId,input){
    const engine=this.engine,run=engine.store.state.runs[botId];
    ensure(run?.status==='waiting_for_input' && input.runId===run.id && input.remoteRunId===run.remoteRunId,409,'This browser request belongs to an older or inactive task.');
    const pending=this.pending.get(run.id);
    ensure(pending && !pending.claimed && input.request_id===pending.promptId && input.execution_generation===pending.generation && run.execution_generation===pending.generation && run.pending_controls?.some(control=>control.kind==='browser' && control.prompt_id===pending.promptId),409,'This browser handoff changed or was already resumed.');
    engine.assertRunning(pending.context);
    ensure(engine.controllers.get(run.id)===pending.context.controller && engine.browsers.sessions.get(run.id)===pending.session,409,'This browser belongs to an older engine session.');
    ensure(!engine.options.busyElsewhere?.(botId) && !engine.options.admissionPaused?.(),409,'Engine ownership is changing. Refresh before controlling this browser.');
    engine.options.assertAdmission?.();
    return pending;
  }
  async locked(botId,input,operation){
    const pending=this.current(botId,input);ensure(!pending.busy,409,'Another browser request is in progress. Refresh after it finishes.');pending.busy=true;
    try{return await operation(pending);}finally{pending.busy=false;}
  }
  async capture(botId,input,pending){
    pending.view=null;
    let result;try{result=await pending.session.ownerView();}catch{throw new HttpError(409,'The browser view is unavailable. Refresh the current handoff.');}
    this.current(botId,input);
    ensure(result && typeof result.imageBase64==='string' && result.imageBase64.length<=12_000_000 && Number.isFinite(result.width) && Number.isFinite(result.height),502,'The browser returned an unavailable view.');
    const viewId=id('view');pending.view={id:viewId,identity:result.identity};
    const dialog=plain(result.dialog)?{type:String(result.dialog.type || '').slice(0,40),message:String(result.dialog.message || '').slice(0,2000)}:null;
    return {imageBase64:result.imageBase64,url:result.url,title:result.title,width:result.width,height:result.height,viewId,tabs:result.tabs || [],tabId:result.tabId,retained:pending.session.retained===true,...(dialog?{dialog}:{})};
  }
  async view(botId,input){validate(input);return this.locked(botId,input,pending=>this.capture(botId,input,pending));}
  async action(botId,input){
    validate(input,['viewId','action']);
    ensure(typeof input.viewId==='string' && input.viewId.length<=100 && plain(input.action),400,'Use the current browser view and one action.');
    ensure(typeof input.action.type==='string' && Object.hasOwn(ACTION_FIELDS,input.action.type),400,'Choose a supported browser action.');
    ensure(Object.keys(input.action).every(key=>key==='type' || ACTION_FIELDS[input.action.type].includes(key)),400,'Browser action contains unknown fields.');
    ensure(input.action.text===undefined || typeof input.action.text==='string' && input.action.text.length<=20_000,413,'Browser input exceeds the size limit.');
    ensure(input.action.promptText===undefined || typeof input.action.promptText==='string' && input.action.promptText.length<=2000,413,'Browser prompt input exceeds the size limit.');
    return this.locked(botId,input,async pending=>{
      ensure(pending.view && pending.view.id===input.viewId,409,'This browser view changed. Refresh before acting.');
      const identity=pending.view.identity;pending.view=null;
      try{await pending.session.ownerAction(input.action,identity);}catch(error){
        // Browser/DevTools errors may echo form input or a credential-bearing URL. Never return or log their payload.
        const status=[400,403,409,413].includes(error?.status)?error.status:502;
        throw new HttpError(status,status===409?'This page changed. Refresh before acting.':'Browser action could not be confirmed. Refresh and inspect the page before trying a different action.');
      }
      this.current(botId,input);return this.capture(botId,input,pending);
    });
  }
  async resume(botId,input){
    validate(input,['keepSession','skip']);ensure(typeof input.keepSession==='boolean' && (input.skip===undefined || typeof input.skip==='boolean'),400,'Choose whether to keep this browser session and resume or skip.');
    return this.locked(botId,input,async pending=>{
      pending.view=null;
      try{await this.engine.browsers.setRetained(input.runId,botId,input.keepSession);}catch{throw new HttpError(409,'The browser session preference could not be saved. Refresh before resuming.');}
      this.current(botId,input);pending.claimed=true;
      try {
        await this.engine.store.mutate(state=>{
          this.engine.assertRunning(pending.context);
          const run=state.runs[botId];ensure(run?.id===input.runId && run.status==='waiting_for_input' && run.execution_generation===pending.generation,409,'This browser handoff changed.');
          Object.assign(run,{status:'running',pending_controls:[],updatedAt:now()});
        });
        const skipped=input.skip===true;
        await this.engine.event(pending.context,'browser.handoff_resumed',{requestId:pending.promptId,skipped});
        pending.resolve({resumed:true,skipped,notice:skipped?'The owner skipped browser assistance. Missing access remains unavailable; do not infer sign-in or challenge success.':'The owner returned browser control. Read a fresh snapshot to verify the current state. Owner inputs were private; this does not approve any later bot action.'});
        return {resolved:1,runId:input.runId,requestId:pending.promptId,skipped};
      }catch(error){if(this.pending.get(input.runId)===pending)pending.claimed=false;throw error;}
    });
  }
  close(){for(const pending of this.pending.values())pending.reject(Object.assign(new Error('Tupies closed during browser handoff.'),{name:'AbortError'}));}
}
