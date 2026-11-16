import { ensure, HttpError } from './store.mjs';

// Live owner control of a task's browser: a CDP screencast pushed to the owner's panel and raw
// input forwarded from it. Pixels, typed text and field values exist only in memory and in the
// owner's own response. Everything here uses short, bounded DevTools waits: an owner request
// never waits for the pipe's 30-second timeout.

export const BOT_VIEWPORT={width:1280,height:900,dpr:1,touch:false};
const RANGE={width:[320,1440],height:[400,1200],dpr:[1,2]};
const MAX_EVENTS=64,MAX_DT=250,MAX_DT_TOTAL=2000,BATCH_BUDGET=4000,COMMAND_MS=1000,CONTROL_MS=1500,CAPTURE_MS=3000,QUALITY=65,MIN_PRIVATE=3,MAX_TABS=8;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const plain=value=>value && typeof value==='object' && !Array.isArray(value);
const finite=value=>typeof value==='number' && Number.isFinite(value);
const clamp=(value,[low,high])=>Math.min(high,Math.max(low,value));
/** Resolves with the promise's value, or `fallback` after `ms`. A late rejection is ignored. */
const bounded=(pending,ms,fallback=null)=>{let timer;void pending?.catch?.(()=>{});return Promise.race([pending,new Promise(resolve=>{timer=setTimeout(()=>resolve(fallback),ms);})]).finally(()=>clearTimeout(timer));};

export function checkViewport(value) {
  ensure(plain(value) && Object.keys(value).every(key=>['width','height','dpr','touch'].includes(key)) && finite(value.width) && finite(value.height) && (value.dpr===undefined || finite(value.dpr)) && (value.touch===undefined || typeof value.touch==='boolean'),400,'Use a viewport {width,height,dpr,touch}.');
  return {width:Math.round(clamp(value.width,RANGE.width)),height:Math.round(clamp(value.height,RANGE.height)),dpr:Math.round(clamp(value.dpr ?? 1,RANGE.dpr)*100)/100,touch:value.touch===true};
}

const FIELDS={
  pointer:['kind','x','y','button','buttons','clickCount','modifiers','dt','tabId','nav'],
  touch:['kind','points','modifiers','dt','tabId','nav'],
  wheel:['x','y','dx','dy','modifiers','dt'],
  key:['kind','key','code','modifiers','repeat','dt'],
  text:['text','dt'],
  navigate:['url'],history:['action'],tab:['tabId'],dialog:['accept','promptText'],resize:['width','height','dpr','touch'],
};
const KINDS={pointer:['move','down','up'],touch:['start','move','end','cancel'],key:['down','up']};
const coordinate=value=>finite(value) && Math.abs(value)<=100_000;
const tabIdOk=value=>typeof value==='string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const optional=(value,check)=>value===undefined || check(value);
const integer=(low,high)=>value=>Number.isSafeInteger(value) && value>=low && value<=high;

/** Validates one input batch. Unknown fields or event types are refused; nothing is dispatched for an invalid batch. */
export function checkEvents(events,{url}={}) {
  ensure(Array.isArray(events),400,'Send browser input as an events array.');
  ensure(events.length<=MAX_EVENTS,413,`Send at most ${MAX_EVENTS} browser input events at a time.`);
  for(const event of events) {
    ensure(plain(event) && typeof event.t==='string' && Object.hasOwn(FIELDS,event.t),400,'Unsupported browser input event.');
    ensure(Object.keys(event).every(key=>key==='t' || FIELDS[event.t].includes(key)),400,'Browser input contains unknown fields.');
    if(KINDS[event.t])ensure(KINDS[event.t].includes(event.kind),400,'Unsupported browser input kind.');
    ensure(optional(event.modifiers,integer(0,15)) && optional(event.dt,value=>finite(value) && value>=0),400,'Invalid browser input timing or modifiers.');
    if(event.t==='pointer') {
      ensure(coordinate(event.x) && coordinate(event.y) && optional(event.button,value=>[0,1,2].includes(value)) && optional(event.buttons,integer(0,31)) && optional(event.clickCount,integer(0,3)),400,'Invalid pointer input.');
      ensure(optional(event.tabId,tabIdOk) && optional(event.nav,integer(0,Number.MAX_SAFE_INTEGER)),400,'Invalid pointer page identity.');
      if(event.kind==='down')ensure(event.tabId!==undefined && event.nav!==undefined,400,'A pointer press needs the tabId and nav of the picture it aims at.');
    }
    if(event.t==='touch') {
      ensure(Array.isArray(event.points) && event.points.length<=10 && (['end','cancel'].includes(event.kind) || event.points.length) && event.points.every(point=>plain(point) && Object.keys(point).every(key=>['id','x','y'].includes(key)) && integer(0,1_000_000)(point.id) && coordinate(point.x) && coordinate(point.y)),400,'Invalid touch points.');
      ensure(optional(event.tabId,tabIdOk) && optional(event.nav,integer(0,Number.MAX_SAFE_INTEGER)),400,'Invalid touch page identity.');
      if(event.kind==='start')ensure(event.tabId!==undefined && event.nav!==undefined,400,'A touch start needs the tabId and nav of the picture it aims at.');
    }
    if(event.t==='wheel')ensure(coordinate(event.x) && coordinate(event.y) && finite(event.dx ?? 0) && finite(event.dy ?? 0),400,'Invalid wheel input.');
    if(event.t==='key')ensure(typeof event.key==='string' && event.key.length>=1 && event.key.length<=32 && !/[\x00-\x1f\x7f]/.test(event.key) && optional(event.code,value=>typeof value==='string' && /^[A-Za-z0-9]{0,32}$/.test(value)) && optional(event.repeat,value=>typeof value==='boolean'),400,'Invalid key input.');
    if(event.t==='text')ensure(typeof event.text==='string' && event.text.length>=1 && event.text.length<=10_000 && !event.text.includes('\0'),400,'Send between 1 and 10000 characters of text.');
    if(event.t==='navigate'){ensure(typeof event.url==='string',400,'Enter a web address.');url?.(event.url);}
    if(event.t==='history')ensure(['back','forward','reload'].includes(event.action),400,'Unsupported browser history action.');
    if(event.t==='tab')ensure(tabIdOk(event.tabId),400,'Choose a browser tab.');
    if(event.t==='dialog')ensure(typeof event.accept==='boolean' && optional(event.promptText,value=>typeof value==='string' && value.length<=2000 && !value.includes('\0')),400,'Use an accept decision and optional prompt text.');
    if(event.t==='resize')checkViewport({width:event.width,height:event.height,...(event.dpr===undefined?{}:{dpr:event.dpr}),...(event.touch===undefined?{}:{touch:event.touch})});
  }
  return events;
}

// Windows virtual key codes, derived on the engine from the physical code (or, for soft keyboards, the key).
const VK={Backspace:8,Tab:9,Enter:13,NumpadEnter:13,ShiftLeft:16,ShiftRight:16,ControlLeft:17,ControlRight:17,AltLeft:18,AltRight:18,Pause:19,CapsLock:20,Escape:27,Space:32,PageUp:33,PageDown:34,End:35,Home:36,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,PrintScreen:44,Insert:45,Delete:46,MetaLeft:91,MetaRight:92,ContextMenu:93,NumpadMultiply:106,NumpadAdd:107,NumpadSubtract:109,NumpadDecimal:110,NumpadDivide:111,NumLock:144,ScrollLock:145,Semicolon:186,Equal:187,Comma:188,Minus:189,Period:190,Slash:191,Backquote:192,BracketLeft:219,Backslash:220,BracketRight:221,Quote:222,IntlBackslash:226};
const NAMED={Backspace:8,Tab:9,Enter:13,Shift:16,Control:17,Alt:18,CapsLock:20,Escape:27,' ':32,PageUp:33,PageDown:34,End:35,Home:36,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Insert:45,Delete:46,Meta:91};
export function virtualKey(code='',key='') {
  let match;
  if(Object.hasOwn(VK,code))return VK[code];
  if((match=/^Key([A-Z])$/.exec(code)))return match[1].charCodeAt(0);
  if((match=/^Digit(\d)$/.exec(code)))return 48+Number(match[1]);
  if((match=/^Numpad(\d)$/.exec(code)))return 96+Number(match[1]);
  if((match=/^F(\d{1,2})$/.exec(code)) && Number(match[1])>=1 && Number(match[1])<=24)return 111+Number(match[1]);
  if(Object.hasOwn(NAMED,key))return NAMED[key];
  if((match=/^F(\d{1,2})$/.exec(key)) && Number(match[1])>=1 && Number(match[1])<=24)return 111+Number(match[1]);
  if(/^[a-z]$/i.test(key))return key.toUpperCase().charCodeAt(0);
  if(/^\d$/.test(key))return key.charCodeAt(0);
  return 0;
}
// Editing shortcuts need explicit CDP commands in headless Chrome (on macOS hosts nothing happens without them).
// Ctrl and Meta both work, so a Mac panel driving a Linux engine (or the reverse) behaves the same. Paste arrives as text.
const LETTER={a:'selectAll',c:'copy',x:'cut',z:'undo',y:'redo'};
export function editingCommands(key,modifiers) {
  const alt=modifiers & 1,primary=modifiers & 6,shift=modifiers & 8,select=name=>shift?`${name}AndModifySelection`:name,lower=key.length===1?key.toLowerCase():key;
  if(primary && !alt && Object.hasOwn(LETTER,lower))return [lower==='z' && shift?'redo':LETTER[lower]];
  if(primary && !alt && ['ArrowLeft','Home'].includes(key))return [select('moveToBeginningOfLine')];
  if(primary && !alt && ['ArrowRight','End'].includes(key))return [select('moveToEndOfLine')];
  if(primary && !alt && key==='ArrowUp')return [select('moveToBeginningOfDocument')];
  if(primary && !alt && key==='ArrowDown')return [select('moveToEndOfDocument')];
  if(primary && !alt && key==='Backspace')return ['deleteToBeginningOfLine'];
  if(alt && !primary && key==='ArrowLeft')return [select('moveWordLeft')];
  if(alt && !primary && key==='ArrowRight')return [select('moveWordRight')];
  if((alt || modifiers & 2) && !(modifiers & 4) && key==='Backspace')return ['deleteWordBackward'];
  if((alt || modifiers & 2) && !(modifiers & 4) && key==='Delete')return ['deleteWordForward'];
  return undefined;
}
const location=code=>/^Numpad/.test(code)?3:/Left$/.test(code) && /^(?:Shift|Control|Alt|Meta)/.test(code)?1:/Right$/.test(code) && /^(?:Shift|Control|Alt|Meta)/.test(code)?2:0;
const CARET=new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Delete','Escape']);

// Runs in an isolated world of the main frame (and of out-of-process frames): which element has focus and what
// keyboard suits it. A private field's value is returned to the engine's memory for redaction only; it is never
// sent to the panel, logged or stored.
const FOCUS=function() {
  const state=globalThis.__studioFocus || (globalThis.__studioFocus={ids:new WeakMap(),next:0});
  let el=document.activeElement;
  for(let depth=0;el && depth<16;depth++) {
    if(el.shadowRoot?.activeElement){el=el.shadowRoot.activeElement;continue;}
    if(el.tagName==='IFRAME' || el.tagName==='FRAME') {
      let inner=null;try {inner=el.contentDocument;} catch { /* Cross-origin. */ }
      if(inner?.activeElement && inner.activeElement!==inner.body){el=inner.activeElement;continue;}
      return {frame:true,hasFocus:document.hasFocus()};
    }
    break;
  }
  if(!el || el===document.body || el===document.documentElement)return {editable:false,hasFocus:document.hasFocus()};
  if(!state.ids.has(el))state.ids.set(el,++state.next);
  const id=state.ids.get(el),tag=el.tagName,type=String(el.type || '').toLowerCase(),auto=String(el.getAttribute('autocomplete') || '').toLowerCase(),mode=String(el.getAttribute('inputmode') || '').toLowerCase();
  let kind=null;
  if(tag==='TEXTAREA')kind='textarea';
  else if(tag==='INPUT') {
    if(['button','submit','reset','checkbox','radio','file','image','range','color','hidden'].includes(type))kind=null;
    else if(auto.includes('one-time-code'))kind='otp';
    else if(type==='text' && {numeric:'number',decimal:'number',tel:'tel',email:'email',url:'url',search:'search'}[mode])kind={numeric:'number',decimal:'number',tel:'tel',email:'email',url:'url',search:'search'}[mode];
    else kind=['text','password','email','tel','number','url','search'].includes(type)?type:'other';
  } else if(el.isContentEditable)kind='textarea';
  else if(el.getAttribute('role')==='textbox')kind=el.getAttribute('aria-multiline')==='true'?'textarea':'text';
  if(!kind || el.disabled || el.readOnly)return {editable:false,id,hasFocus:document.hasFocus()};
  const privateField=type==='password' || /(?:password|one-time-code|cc-number|cc-csc|cc-exp)/.test(auto);
  return {editable:true,kind,id,private:privateField,hasFocus:document.hasFocus(),...(privateField?{value:String(el.value ?? '').slice(0,1000)}:{})};
};

/** An SSE response that carries one owner stream. Frames are flow-controlled: the next screencast frame is acknowledged only after the previous write drained. */
export class StreamSink {
  constructor(res,streamId) {
    this.res=res;this.streamId=streamId;this.ended=false;this.blocked=false;this.queued=null;this.acks=[];
    this.done=new Promise(resolve=>{this.finish=resolve;});
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    res.flushHeaders?.();res.socket?.setNoDelay?.(true);
    this.heartbeat=setInterval(()=>this.write(': ping\n\n'),5000);this.heartbeat.unref?.();
    const closed=()=>{if(!this.ended){this.ended=true;this.cleanup();this.onClose?.();}};
    res.once?.('close',closed);res.once?.('error',closed);
  }
  write(text) {
    if(this.ended || this.res.writableEnded || this.res.destroyed)return true;
    try {return this.res.write(text);} catch {return true;}
  }
  event(name,data) {this.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);}
  /** At most one frame waits for the socket; a newer frame replaces it. Acknowledgements run once the socket drained. */
  frame(data,ack) {
    if(this.ended){ack?.();return;}
    if(ack)this.acks.push(ack);
    if(this.blocked){this.queued=data;return;}
    this.sendFrame(data);
  }
  sendFrame(data) {
    if(this.write(`event: frame\ndata: ${JSON.stringify(data)}\n\n`)){this.release();return;}
    this.blocked=true;
    this.res.once('drain',()=>{this.blocked=false;const next=this.queued;this.queued=null;if(next)this.sendFrame(next);else this.release();});
  }
  release() {const acks=this.acks;this.acks=[];for(const ack of acks)ack();}
  end(reason,message) {
    if(this.ended)return;
    this.event('end',{reason,message});this.ended=true;this.cleanup();
    try {this.res.end();} catch { /* Already closed. */ }
  }
  cleanup() {clearInterval(this.heartbeat);this.queued=null;this.release();this.finish();}
}

/** One handoff's live control over the task's BrowserSession. Owns the viewport override, screencast, input queue and owner-typed redaction for that handoff. */
export class OwnerControl {
  constructor(session,{idleMs=0}={}) {
    this.session=session;this.idleMs=idleMs;this.nav=0;this.frameSeq=0;this.queue=Promise.resolve();this.sink=null;this.closed=false;this.started=false;
    this.viewport={...BOT_VIEWPORT};this.emulated=new Map();this.pages=new Map();this.mainFrame=null;this.loading=false;this.history={canGoBack:false,canGoForward:false};
    this.focus=null;this.focusKey=null;this.focusPrivate=false;this.privateValue='';this.run='';this.typedSinceProbe=false;this.privateFull=false;
    this.pointer={drop:false};this.touch={active:new Map(),dropped:new Set()};this.worlds=new Map();this.frameSessions=new Map();this.casting=null;this.capturing=false;this.lastState='';
    this.armDialog();if(session.dialog)this.openDialog();this.handler=message=>{try {this.onEvent(message);} catch { /* Never let a malformed event break the pipe. */ }};session.pipe.handlers.add(this.handler);
  }
  armDialog() {this.gateOpen=false;this.dialogGate=new Promise(resolve=>{this.openDialog=()=>{this.gateOpen=true;resolve();};});}
  /** After a tab switch the gate and the panel follow the new current tab's own dialog (BrowserSession keeps one per tab). */
  syncDialog() {
    const dialog=this.session.dialog;
    if(dialog){this.openDialog();this.emit('dialog',{open:true,type:String(dialog.type || ''),message:dialog.message,defaultPrompt:dialog.defaultPrompt || ''});}
    else{if(this.gateOpen)this.armDialog();this.emit('dialog',{open:false});}
  }
  /** A press whose release was dropped (a dialog opened from mousedown, a stall) is released once the page can take input again, so no button stays held. */
  async releasePressed() {
    const held=this.pointer.held;if(!held || this.session.dialog)return;this.pointer.held=null;
    await this.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:held.x,y:held.y,button:held.button,buttons:0,clickCount:1,modifiers:0,pointerType:'mouse'});
  }
  get current() {return this.session.session;}
  request(method,params={},timeout=CONTROL_MS,sessionId=this.current) {return this.session.pipe.send(method,params,sessionId,timeout);}
  /** Sends one input command. It resolves when Chrome answers, a dialog opens (which blocks the answer), or the command times out. */
  command(method,params,timeout=COMMAND_MS) {
    const pending=this.request(method,params,timeout).then(()=>'ok',error=>error?.status===504?'timeout':'error');
    return Promise.race([pending,this.dialogGate.then(()=>'dialog')]);
  }
  start(method,params) {this.loading=true;this.emitState();void this.request(method,params,30_000).catch(()=>{});return 'ok';}
  enqueue(operation) {const run=this.queue.then(operation,operation);this.queue=run.catch(()=>{});return run;}
  emit(name,data) {this.sink?.event(name,data);}

  onEvent(message) {
    const {method,params={},sessionId}=message,current=this.current;
    if(method==='Page.screencastFrame') {
      const ack=()=>{void this.request('Page.screencastFrameAck',{sessionId:params.sessionId},CONTROL_MS,sessionId).catch(()=>{});};
      if(this.closed || !this.sink || sessionId!==current || sessionId!==this.casting){ack();return;}
      const meta=params.metadata || {};
      this.sink.frame({seq:++this.frameSeq,tabId:this.session.tabId,nav:this.nav,width:Math.round(meta.deviceWidth || this.viewport.width),height:Math.round(meta.deviceHeight || this.viewport.height),jpeg:params.data},ack);
      return;
    }
    if(method==='Target.targetCreated' || method==='Target.targetInfoChanged') {
      const info=params.targetInfo;if(info?.type!=='page')return;
      const known=this.pages.has(info.targetId);this.pages.set(info.targetId,{id:info.targetId,title:String(info.title || '').slice(0,300),url:String(info.url || ''),openerId:info.openerId || null});
      // A page the current tab opened (OAuth window, target=_blank) is followed, like a person's browser would.
      if(!known && method==='Target.targetCreated' && info.openerId && info.openerId===this.session.tabId && this.started && !this.closed)void this.enqueue(()=>this.follow(info.targetId));
      else this.emitState();
      return;
    }
    if(method==='Target.targetDestroyed' || method==='Target.targetCrashed') {
      const gone=params.targetId;this.pages.delete(gone);this.session.targets?.delete(gone);this.frameSessions.delete(gone);
      if(gone===this.session.tabId && !this.closed)void this.enqueue(()=>this.recover(gone));else this.emitState();
      return;
    }
    if(method==='Target.detachedFromTarget') {
      for(const [target,id] of this.frameSessions)if(id===params.sessionId)this.frameSessions.delete(target);
      if(params.sessionId===current && !this.closed){const gone=this.session.tabId;this.session.targets?.delete(gone);void this.enqueue(()=>this.recover(gone));}
      return;
    }
    if(sessionId!==current)return;
    if(method==='Page.frameNavigated' && !params.frame?.parentId) {
      this.mainFrame=params.frame.id;this.nav++;this.worlds.clear();
      this.flushSync();this.focus=null;this.focusKey=null;this.focusPrivate=false;this.privateValue='';
      this.emitState();void this.refreshHistory();this.capture();
    } else if(method==='Page.navigatedWithinDocument' && params.frameId===this.mainFrame)void this.refreshHistory();
    else if(method==='Page.frameStartedLoading' && (!this.mainFrame || params.frameId===this.mainFrame)){this.loading=true;this.emitState();}
    else if((method==='Page.frameStoppedLoading' && (!this.mainFrame || params.frameId===this.mainFrame)) || method==='Page.loadEventFired'){if(this.loading){this.loading=false;this.emitState();}void this.probeFocus();}
    else if(method==='Runtime.executionContextsCleared')this.worlds.clear();
    else if(method==='Page.javascriptDialogOpening') {
      this.openDialog();this.emit('dialog',{open:true,type:String(params.type || ''),message:String(params.message || '').slice(0,2000),defaultPrompt:String(params.defaultPrompt || '').slice(0,1000)});
    } else if(method==='Page.javascriptDialogClosed'){this.armDialog();this.emit('dialog',{open:false});if(this.pointer.held && !this.closed)void this.enqueue(()=>this.releasePressed());if(this.viewPending && this.sink)void this.enqueue(async()=>{await this.restartView();this.capture();});else this.capture();}
  }

  tabs() {return [...this.pages.values()].slice(0,MAX_TABS).map(page=>({id:page.id,title:page.title,url:page.url,active:page.id===this.session.tabId}));}
  snapshot() {
    const page=this.pages.get(this.session.tabId);
    return {tabId:this.session.tabId,nav:this.nav,url:page?.url || '',title:page?.title || '',tabs:this.tabs(),loading:this.loading,canGoBack:this.history.canGoBack,canGoForward:this.history.canGoForward,focus:this.focus};
  }
  emitState(force=false) {
    if(!this.sink || this.closed)return;
    const state=this.snapshot(),text=JSON.stringify(state);
    if(!force && text===this.lastState)return;
    this.lastState=text;this.emit('state',state);
  }
  async refreshPages() {
    const {targetInfos}=await this.request('Target.getTargets',{},CONTROL_MS,undefined);
    this.pages.clear();for(const info of targetInfos)if(info.type==='page')this.pages.set(info.targetId,{id:info.targetId,title:String(info.title || '').slice(0,300),url:String(info.url || ''),openerId:info.openerId || null});
  }
  // Page.getFrameTree blocks while a navigation is pending; a page target's main frame ID is its target ID.
  async refreshFrame() {this.mainFrame=this.session.tabId || null;}
  async refreshHistory() {
    if(this.session.dialog)return;
    try {const {currentIndex,entries}=await this.request('Page.getNavigationHistory');this.history={canGoBack:currentIndex>0,canGoForward:currentIndex<entries.length-1};this.emitState();} catch { /* Kept as it was. */ }
  }

  async applyViewport() {
    if(this.closed)return;
    const {width,height,dpr,touch}=this.viewport,id=this.current;
    this.emulated.set(id,this.session.tabId);
    // screen.* matches the viewport, so pages never see a screen smaller than their window.
    await this.request('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:dpr,mobile:touch,screenWidth:width,screenHeight:height});
    if(this.closed)return;
    await this.request('Emulation.setTouchEmulationEnabled',touch?{enabled:true,maxTouchPoints:5}:{enabled:false});
  }
  async startScreencast() {
    const {width,height,dpr}=this.viewport;
    await this.request('Page.startScreencast',{format:'jpeg',quality:QUALITY,maxWidth:Math.round(width*dpr),maxHeight:Math.round(height*dpr),everyNthFrame:1});this.casting=this.current;
  }
  async stopScreencast() {const casting=this.casting;this.casting=null;if(casting)await this.request('Page.stopScreencast',{},CONTROL_MS,casting).catch(()=>{});}
  /** Applies the owner viewport and (re)starts the screencast, bounded. With a dialog open this may not complete; it is retried when the dialog closes. */
  async restartView() {
    if(this.closed)return;
    this.viewPending=true;
    // A page with an open dialog answers no view command until the dialog closes; the view is retried then. Waiting here
    // would hold the owner's answer to the dialog (and every later input) behind this queue entry.
    if(this.session.dialog)return;
    // View changes run one after another: one left waiting on a dialog finishes before the next starts, so two never start the screencast at once.
    const previous=this.viewWork;
    const work=this.viewWork=(async()=>{await previous?.catch(()=>{});if(this.closed)return false;await this.applyViewport();await this.stopScreencast();if(this.sink && !this.closed)await this.startScreencast();return true;})();void work.catch(()=>{});
    const done=await Promise.race([bounded(work,CONTROL_MS*2,false),this.dialogGate.then(()=>false)]).catch(()=>false);
    if(done && this.viewWork===work)this.viewPending=false;
  }
  /** The screencast only emits on visual change, so one explicit picture follows open, tab switch, resize and navigation. */
  capture() {
    if(!this.sink || this.closed || this.session.dialog)return;
    // A capture already in flight may show the previous page: ask again once it returns.
    if(this.capturing){this.captureAgain=true;return;}
    this.capturing=true;this.captureAgain=false;const tabId=this.session.tabId,nav=this.nav,{width,height}=this.viewport;
    void this.request('Page.captureScreenshot',{format:'jpeg',quality:QUALITY,optimizeForSpeed:true},CAPTURE_MS).then(({data})=>{
      if(data && this.sink && !this.closed && tabId===this.session.tabId)this.sink.frame({seq:++this.frameSeq,tabId,nav,width,height,jpeg:data});
    },()=>{}).finally(()=>{this.capturing=false;if(this.captureAgain){this.captureAgain=false;this.capture();}});
  }

  /** Attaches an owner stream, replacing any earlier one. Runs on the input queue so it never interleaves with dispatch. */
  attach(sink,viewport,{onReady}={}) {
    const previous=this.sink;this.sink=sink;
    if(previous && previous!==sink)previous.end('replaced','This browser was opened in another window.');
    sink.onClose=()=>{if(this.sink===sink){this.sink=null;void this.enqueue(()=>this.stopScreencast());}};
    return this.enqueue(async()=>{
      if(this.sink!==sink || this.closed)return;
      try {
        if(!this.started){await this.refreshPages();this.started=true;}
        if(!this.pages.has(this.session.tabId))await this.recover(this.session.tabId,{announce:false});
        if(!this.mainFrame)await this.refreshFrame();
        // ready, state and an already open dialog go out before anything that a dialog or pending navigation could hold.
        this.viewport=viewport;const page=this.pages.get(this.session.tabId);
        sink.event('ready',{streamId:sink.streamId,width:viewport.width,height:viewport.height,dpr:viewport.dpr,tabId:this.session.tabId,nav:this.nav,url:page?.url || '',title:page?.title || '',tabs:this.tabs(),retained:this.session.retained===true,idleMs:this.idleMs});
        onReady?.();this.lastState='';this.emitState(true);
        const dialog=this.session.dialog;if(dialog){this.openDialog();sink.event('dialog',{open:true,type:String(dialog.type || ''),message:dialog.message,defaultPrompt:dialog.defaultPrompt || ''});}
        await this.restartView();
        this.capture();void this.refreshHistory();void this.probeFocus();
      } catch {
        if(this.sink===sink){this.sink=null;sink.end('error','The browser view is unavailable. Reopen it.');}
      }
    });
  }
  /** Switches the stream (and the bot's current tab) to another page target. */
  async switchTo(tabId) {
    this.flushSync();await this.stopScreencast();
    await bounded(this.session.switchTab(tabId,CONTROL_MS),CONTROL_MS*6,null);
    if(this.session.tabId!==tabId)throw new HttpError(409,'That tab is no longer open.');
    // The handoff may have ended while the switch ran: the bot's view is restored by close(), never re-emulated here.
    if(this.closed)return;
    this.nav++;this.mainFrame=null;this.worlds.clear();this.loading=false;this.focus=null;this.focusKey=null;this.focusPrivate=false;this.privateValue='';this.touch.active.clear();this.touch.dropped.clear();this.pointer.drop=false;
    this.pointer.held=null;this.syncDialog();
    await this.refreshFrame();await this.restartView();
    this.emitState();this.capture();void this.refreshHistory();void this.probeFocus();
  }
  async follow(targetId) {
    if(this.closed || !this.pages.has(targetId) || targetId===this.session.tabId)return;
    try {await this.switchTo(targetId);} catch {this.emitState();}
  }
  /** The current tab closed, crashed or detached: fall back to its opener or another live tab so the handoff stays usable. */
  async recover(gone,{announce=true}={}) {
    if(this.closed || gone!==this.session.tabId)return;
    const opener=this.pages.get(gone)?.openerId;this.pages.delete(gone);
    try {await this.refreshPages();} catch { /* Use what is known. */ }
    this.pages.delete(gone);
    let next=opener && this.pages.has(opener)?opener:[...this.pages.keys()][0];
    if(!next){const {targetId}=await this.request('Target.createTarget',{url:'about:blank'},CONTROL_MS,undefined);next=targetId;this.pages.set(next,{id:next,title:'',url:'about:blank',openerId:null});}
    this.casting=null;
    try {await this.switchTo(next);} catch {if(announce)this.emitState();}
  }

  // Owner-typed text is registered for redaction at flush points (focus change, Enter/Tab, a new press, navigation,
  // tab switch, resume/end). Later model-visible browser output then shows [private] in its place.
  register(value) {
    if(typeof value!=='string' || value.length<MIN_PRIVATE)return;
    try {this.session.keepPrivate(value);} catch {this.privateFull=true;}
  }
  flushSync() {const run=this.run;this.run='';this.register(run);this.register(this.privateValue);}
  async flush(read=true) {
    const run=this.run;this.run='';this.register(run);
    if(read && this.typedSinceProbe && this.focusPrivate && !this.session.dialog)await bounded(this.probeFocus(),CONTROL_MS);
    this.register(this.privateValue);this.typedSinceProbe=false;
  }
  typed(text) {this.session.ownerTouched=true;this.session.ownerTyped=true;this.run+=text;this.typedSinceProbe=true;if(this.run.length>=10_000){this.register(this.run);this.run='';}}
  async world(sessionId,frameId) {
    const key=`${sessionId}:${frameId}`;if(this.worlds.has(key))return this.worlds.get(key);
    const {executionContextId}=await this.request('Page.createIsolatedWorld',{frameId,worldName:'studio-owner',grantUniveralAccess:false},CONTROL_MS,sessionId);
    this.worlds.set(key,executionContextId);return executionContextId;
  }
  async focusIn(sessionId,frameId) {
    for(let attempt=0;attempt<2;attempt++) {
      try {
        const contextId=await this.world(sessionId,frameId),reply=await this.request('Runtime.evaluate',{expression:`(${FOCUS})()`,contextId,returnByValue:true},CONTROL_MS,sessionId);
        if(reply.exceptionDetails)return null;return reply.result?.value || null;
      } catch {this.worlds.delete(`${sessionId}:${frameId}`);}
    }
    return null;
  }
  /** Out-of-process frames (cross-site sign-in or card widgets) answer for themselves; only the focused one counts. */
  async focusInFrames() {
    let infos=[];try {infos=(await this.request('Target.getTargets',{},CONTROL_MS,undefined)).targetInfos.filter(info=>info.type==='iframe').slice(0,8);} catch {return null;}
    const results=await Promise.all(infos.map(async info=>{
      try {
        let id=this.frameSessions.get(info.targetId);
        if(!id){id=(await this.request('Target.attachToTarget',{targetId:info.targetId,flatten:true},CONTROL_MS,undefined)).sessionId;this.frameSessions.set(info.targetId,id);}
        const result=await this.focusIn(id,info.targetId);return result?.hasFocus?{...result,frameKey:info.targetId}:null;
      } catch {return null;}
    }));
    return results.find(result=>result && !result.frame) || null;
  }
  async probeFocus({force=false}={}) {
    if(this.closed && !force || this.session.dialog)return;
    if(!this.mainFrame)await this.refreshFrame();
    if(!this.mainFrame)return;
    const tabId=this.session.tabId,nav=this.nav;
    let result=await this.focusIn(this.current,this.mainFrame),frameKey='main';
    if(result?.frame){const inner=await this.focusInFrames();if(inner){result=inner;frameKey=inner.frameKey;}else result={editable:true,kind:'other'};}
    if(this.closed && !force || tabId!==this.session.tabId || nav!==this.nav || !result)return;
    const key=result.id?`${tabId}:${nav}:${frameKey}:${result.id}`:null;
    if(key!==this.focusKey)this.flushSync();
    this.focusKey=key;this.focusPrivate=result.private===true;this.privateValue=result.private?String(result.value || ''):'';this.typedSinceProbe=false;
    this.focus=result.editable?{editable:true,kind:result.kind || 'other'}:null;this.emitState();
  }

  stale(event) {return event.tabId!==this.session.tabId || event.nav!==this.nav;}
  async pointerEvent(event) {
    const {x,y}=this.point(event);
    if(event.kind==='down') {
      if(this.stale(event)){this.pointer.drop=true;return 'dropped';}
      this.pointer.drop=false;await this.flush();
    } else if(this.pointer.drop){if(event.kind==='up')this.pointer.drop=false;return 'dropped';}
    const buttons=event.buttons ?? 0,button=event.kind==='move'?(buttons&1?'left':buttons&4?'middle':buttons&2?'right':'none'):['left','middle','right'][event.button ?? 0];
    if(event.kind==='down')this.pointer.held={x,y,button};else if(event.kind==='up')this.pointer.held=null;
    return this.command('Input.dispatchMouseEvent',{type:{move:'mouseMoved',down:'mousePressed',up:'mouseReleased'}[event.kind],x,y,button,buttons,clickCount:event.kind==='move'?0:(event.clickCount || 1),modifiers:event.modifiers || 0,pointerType:'mouse'});
  }
  /** `points` are the touches still down after this change: start/move carry every current touch, end carries the ones that remain ([] when all lifted), cancel is []. */
  async touchEvent(event) {
    const {active,dropped}=this.touch,points=event.points.map(point=>({id:point.id,...this.point(point)})),ids=new Set(points.map(point=>point.id));
    if(event.kind==='start') {
      const added=points.filter(point=>!active.has(point.id) && !dropped.has(point.id));
      if(this.stale(event)){for(const point of added)dropped.add(point.id);}
      else if(!active.size && added.length)await this.flush();
    }
    // A touch whose start aimed at a replaced page stays dropped until it lifts.
    for(const id of [...dropped])if(!ids.has(id) || event.kind==='cancel')dropped.delete(id);
    const live=event.kind==='cancel'?[]:points.filter(point=>!dropped.has(point.id));
    const wasActive=active.size;active.clear();for(const point of live)active.set(point.id,{x:point.x,y:point.y,id:point.id,radiusX:1,radiusY:1,force:1});
    if(event.kind==='cancel')return wasActive?this.command('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[],modifiers:event.modifiers || 0}):'dropped';
    if(!active.size && !wasActive)return 'dropped';
    // CDP compares each event with the previous set: touchEnd carries no points, so lifting some fingers is a touchMove with the rest.
    const type=!active.size?'touchEnd':!wasActive?'touchStart':event.kind==='start'?'touchStart':'touchMove';
    return this.command('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[...active.values()],modifiers:event.modifiers || 0});
  }
  async keyEvent(event) {
    // Ctrl+Alt with one printable character is AltGr on Windows/Linux layouts (@, €, \): it is text, not a shortcut.
    const modifiers=event.modifiers || 0,altGraph=(modifiers & 7)===3 && [...event.key].length===1,shortcut=!altGraph && (modifiers & 6)!==0,code=event.code || '',key=event.key,vk=virtualKey(code,key);
    const base={key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers,location:location(code)};
    if(event.kind==='up')return this.command('Input.dispatchKeyEvent',{type:'keyUp',...base});
    const printable=[...key].length===1 && !shortcut,text=key==='Enter'?'\r':printable?key:undefined;
    if(key==='Enter' || key==='Tab')await this.flush();
    else if(shortcut || CARET.has(key)){this.register(this.run);this.run='';}
    const command=altGraph?undefined:editingCommands(key,modifiers);if(command)this.register(this.run),this.run='';
    // Typed text is recorded before it is dispatched, so a handoff that ends mid-dispatch still redacts it.
    if(printable)this.typed(key);else if(key==='Backspace'){this.run=[...this.run].slice(0,-1).join('');this.typedSinceProbe=true;}
    return this.command('Input.dispatchKeyEvent',{type:text?'keyDown':'rawKeyDown',...base,...(altGraph?{modifiers:0}:{}),autoRepeat:event.repeat===true,...(text?{text,unmodifiedText:text}:{}),...(command?{commands:command}:{})});
  }
  point(value) {return {x:clamp(value.x,[0,this.viewport.width-1]),y:clamp(value.y,[0,this.viewport.height-1])};}
  async dispatch(event,{webUrl}) {
    this.session.ownerTouched=true;
    if(event.t==='pointer')return this.pointerEvent(event);
    if(event.t==='touch')return this.touchEvent(event);
    if(event.t==='key')return this.keyEvent(event);
    if(event.t==='wheel'){const {x,y}=this.point(event);return this.command('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:clamp(event.dx ?? 0,[-10_000,10_000]),deltaY:clamp(event.dy ?? 0,[-10_000,10_000]),modifiers:event.modifiers || 0,pointerType:'mouse'});}
    if(event.t==='text'){this.typed(event.text);return this.command('Input.insertText',{text:event.text});}
    // Navigation is started and never awaited: a slow site shows progress through state.loading, not a held request.
    if(event.t==='navigate'){await this.flush();return this.start('Page.navigate',{url:webUrl(event.url).href});}
    if(event.t==='history') {
      await this.flush();
      if(event.action==='reload')return this.start('Page.reload',{});
      const {currentIndex,entries}=await this.request('Page.getNavigationHistory'),entry=entries[currentIndex+(event.action==='back'?-1:1)];
      return entry?this.start('Page.navigateToHistoryEntry',{entryId:entry.id}):'dropped';
    }
    if(event.t==='tab'){if(event.tabId===this.session.tabId)return 'ok';if(!this.pages.has(event.tabId))return 'dropped';await this.switchTo(event.tabId);return 'ok';}
    if(event.t==='dialog') {
      if(!this.session.dialog)return 'dropped';
      if(event.promptText){this.session.ownerTyped=true;this.session.keepPrivate(event.promptText);}
      return this.request('Page.handleJavaScriptDialog',{accept:event.accept,...(event.promptText===undefined?{}:{promptText:event.promptText})},2000).then(()=>'ok',()=>'error');
    }
    if(event.t==='resize') {
      const next=checkViewport({width:event.width,height:event.height,dpr:event.dpr ?? this.viewport.dpr,touch:event.touch ?? this.viewport.touch});
      // Panels resize often (keyboard, rotation): an unchanged size only pushes a fresh picture.
      if(!this.viewPending && JSON.stringify(next)===JSON.stringify(this.viewport)){this.capture();return 'ok';}
      this.viewport=checkViewport({width:event.width,height:event.height,dpr:event.dpr ?? this.viewport.dpr,touch:event.touch ?? this.viewport.touch});
      await this.restartView();this.capture();this.emitState(true);return 'ok';
    }
    return 'dropped';
  }
  /** Runs one owner batch in order on the handoff's queue. Waits are capped so drags keep their real trajectory and timing, and a dialog or stall drops the rest instead of hanging. */
  input(events,{active=()=>true,webUrl}) {
    ensure(!this.privateFull || !events.some(event=>event.t==='key' || event.t==='text'),413,'Private browser input reached this task’s limit. Finish or stop the task.');
    return this.enqueue(async()=>{
      const started=Date.now();let waited=0,dropped=0;
      for(let index=0;index<events.length;index++) {
        const event=events[index];
        if(this.closed || !active()){dropped+=events.length-index;break;}
        if(event.dt){const ms=Math.min(MAX_DT,event.dt,Math.max(0,MAX_DT_TOTAL-waited));waited+=ms;if(ms)await sleep(ms);}
        const release=event.t==='pointer' && event.kind==='up' || event.t==='touch' && ['end','cancel'].includes(event.kind);
        const blocked=this.session.dialog && !['dialog','tab','resize'].includes(event.t) || !release && Date.now()-started>BATCH_BUDGET;
        if(blocked) {
          dropped++;
          if(event.t==='pointer' && event.kind==='down')this.pointer.drop=true;
          if(event.t==='touch' && event.kind==='start')for(const point of event.points)this.touch.dropped.add(point.id);
          continue;
        }
        let result;try {result=await this.dispatch(event,{webUrl});} catch(error){if(error?.status===400)throw error;result='error';}
        if(result==='dropped')dropped++;
      }
      if(!this.closed && events.some(event=>event.t!=='wheel' && !(event.t==='pointer' && event.kind==='move')))setTimeout(()=>{void this.probeFocus();},80);
      return {dropped};
    });
  }
  /** Ends the owner stream for this handoff, registers pending private text and restores the bot's view of the browser. Bounded. */
  close(reason,message) {
    if(this.closePromise)return this.closePromise;
    this.closed=true;const sink=this.sink;this.sink=null;sink?.end(reason,message);
    this.closePromise=(async()=>{
      this.flushSync();
      if(this.typedSinceProbe && this.focusPrivate && !this.session.dialog && !this.session.pipe.closed){await bounded(this.probeFocus({force:true}),CONTROL_MS);this.register(this.privateValue);}
      let settled=false;const queue=this.queue.then(()=>{settled=true;});
      await bounded(queue,CONTROL_MS*2);
      // Text whose dispatch was still running when the wait began is registered too.
      this.flushSync();
      const restore=()=>this.session.pipe.closed?[]:[...this.emulated.keys()].flatMap(id=>[this.request('Emulation.setDeviceMetricsOverride',{width:BOT_VIEWPORT.width,height:BOT_VIEWPORT.height,deviceScaleFactor:BOT_VIEWPORT.dpr,mobile:false,screenWidth:BOT_VIEWPORT.width,screenHeight:BOT_VIEWPORT.height},CONTROL_MS,id),this.request('Emulation.setTouchEmulationEnabled',{enabled:false},CONTROL_MS,id)]);
      if(!this.session.pipe.closed)await Promise.allSettled([this.stopScreencast(),...restore(),...[...this.frameSessions.values()].map(id=>this.request('Target.detachFromTarget',{sessionId:id},CONTROL_MS,undefined))]);
      const finish=()=>{this.session.pipe.handlers.delete(this.handler);this.emulated.clear();this.frameSessions.clear();this.worlds.clear();};
      // An owner operation that outlived the wait (a slow tab switch or resize) may have emulated a tab again: restore once more when it really ends.
      if(settled)finish();
      else void queue.then(async()=>{this.flushSync();await Promise.allSettled([this.stopScreencast(),...restore()]);finish();});
    })();
    return this.closePromise;
  }
  /** Ends only the panel's stream (engine shutdown); the handoff itself is ended by its owner prompt. */
  endSink(reason,message) {const sink=this.sink;this.sink=null;sink?.end(reason,message);void this.enqueue(()=>this.stopScreencast());}
}
