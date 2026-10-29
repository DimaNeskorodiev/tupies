import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const source=await readFile(new URL('../public/thinking-waves.js',import.meta.url),'utf8');
const css=await readFile(new URL('../public/thinking-waves.css',import.meta.url),'utf8');
const baseGraph={kind:'research',signature:'fetch-1',caption:'Reading a source',context:'One observed response',nodes:[
  {id:'source',x:.1,y:.28,label:'Source',value:'https://example.test/weather',detail:'Requested public source',kind:'source',major:true},
  {id:'core',x:.5,y:.5,label:'Read',value:'http_fetch',kind:'transform',major:true},
  {id:'temperature',x:.9,y:.18,label:'Temperature',value:'10°C',detail:'Observed value',kind:'output',major:true},
  {id:'wind',x:.9,y:.82,label:'Wind',value:'4 km/h',detail:'Observed value',kind:'output'},
],edges:[
  {id:'request',from:'source',to:'core',text:'http_fetch',detail:'GET public weather',weight:1,bend:.1},
  {id:'temperature-result',from:'core',to:'temperature',text:'10°C',detail:'Recorded temperature',weight:1,bend:-.1},
  {id:'wind-result',from:'core',to:'wind',text:'4 km/h',detail:'Recorded wind',weight:1,bend:.2},
]};
const clone=value=>JSON.parse(JSON.stringify(value));
function harness(t,{reduced=false,width=540,height=188}={}){
  const dom=new JSDOM('<!doctype html><style></style><body><article class="thinking-message"><div class="thinking-card" data-thinking-card><canvas data-thinking="run-1" data-keep="thinking-run-1"></canvas><div class="thinking-caption"><span data-thinking-elapsed></span><button type="button" class="thinking-stop" data-action="stop-run">Stop</button></div><p class="thinking-context" data-thinking-context></p></div></article></body>',{runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,frames=new Map(),timers=new Map(),observers=[],mediaListeners=new Set();let id=0,strokes=0,arcs=0,maxQueued=0,documentHidden=false,top=0,labels=[];
  w.document.querySelector('style').textContent=css;
  w.requestAnimationFrame=fn=>{frames.set(++id,fn);maxQueued=Math.max(maxQueued,frames.size);return id;};w.cancelAnimationFrame=n=>frames.delete(n);
  w.setTimeout=fn=>{timers.set(++id,fn);return id;};w.clearTimeout=n=>timers.delete(n);
  Object.defineProperty(w.document,'hidden',{configurable:true,get:()=>documentHidden});
  const media={matches:reduced,addEventListener:(name,fn)=>mediaListeners.add(fn),removeEventListener:(name,fn)=>mediaListeners.delete(fn)};w.matchMedia=()=>media;
  const gradient={addColorStop(offset){assert.ok(offset>=0&&offset<=1);}};
  const ctx=new Proxy({},{get(target,name){if(name in target)return target[name];if(name==='createRadialGradient')return()=>gradient;if(name==='measureText')return value=>({width:String(value).length*5.8});if(name==='clearRect')return()=>{labels=[];};return(...args)=>{if(name==='stroke')strokes++;if(name==='arc')arcs++;if(name==='fillText')labels.push({text:args[0],x:args[1],y:args[2],width:String(args[0]).length*5.8,align:target.textAlign});for(const arg of args)if(typeof arg==='number')assert.ok(Number.isFinite(arg),`${String(name)} received a non-finite value`);};},set(target,name,value){target[name]=value;return true;}});
  Object.defineProperty(w.HTMLCanvasElement.prototype,'clientWidth',{get:()=>width});Object.defineProperty(w.HTMLCanvasElement.prototype,'clientHeight',{get:()=>height});w.HTMLCanvasElement.prototype.getContext=()=>ctx;
  w.HTMLCanvasElement.prototype.getBoundingClientRect=()=>({top,left:0,bottom:top+height,right:width,width,height});
  Object.defineProperty(w.HTMLElement.prototype,'offsetWidth',{get(){return Math.min(165,width*.46,(this.textContent?.length||0)*6+18);}});
  Object.defineProperty(w.HTMLElement.prototype,'offsetHeight',{get(){return 28;}});
  w.ResizeObserver=class{observe(){}disconnect(){this.dead=true;}};
  w.IntersectionObserver=class{constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){this.dead=true;}};
  let card=w.document.querySelector('.thinking-card');const canvas=w.document.querySelector('canvas');
  card.dataset.flow=JSON.stringify(baseGraph);card.dataset.started=new Date(Date.now()-75000).toISOString();card.dataset.colors='#a4f5d5,#21c6a1,#087a77,#c4ffe7';
  w.eval(source);w.StudioThinking.mount(w.document);
  function advance(time){const item=frames.entries().next().value;if(item){frames.delete(item[0]);item[1](time);}assert.ok(frames.size<=1,'at most one queued frame');}
  function run(from,to){for(let time=from;time<=to;time+=16)advance(time);}
  function quiet(){const item=timers.entries().next().value;if(item){timers.delete(item[0]);item[1]();}}
  function update(graph){card.dataset.flow=JSON.stringify(graph);w.StudioThinking.mount(w.document);}
  function replacement(graph){const next=card.cloneNode(false);next.dataset.flow=JSON.stringify(graph);card.replaceWith(next);next.appendChild(canvas);card=next;w.StudioThinking.mount(w.document);return next;}
  function visibility(hidden){documentHidden=hidden;w.document.dispatchEvent(new w.Event('visibilitychange'));}
  function mediaChange(matches){media.matches=matches;for(const fn of mediaListeners)fn({matches});}
  function page(name,persisted){const event=new w.Event(name);Object.defineProperty(event,'persisted',{value:persisted});w.dispatchEvent(event);}
  t.after(()=>{page('pagehide',false);w.close();});
  return{w,canvas,frames,timers,mediaListeners,observers,advance,run,quiet,update,replacement,visibility,mediaChange,page,card:()=>card,stats:()=>({strokes,arcs,maxQueued,labels:labels.slice()}),setWidth:value=>{width=value;},setTop:value=>{top=value;}};
}
const packets=h=>[...h.w.document.querySelectorAll('.thinking-flow-fragment')];
const xy=button=>button.style.transform.match(/translate3d\(([-\d.]+)px,([-\d.]+)px/).slice(1).map(Number);

test('adaptive activity stays transparent and has a bounded responsive text layer',t=>{
  const h=harness(t,{width:280});h.run(16,1800);const style=h.w.getComputedStyle(h.card());
  assert.equal(style.backgroundColor,'rgba(0, 0, 0, 0)');assert.equal(style.borderTopWidth,'0px');assert.equal(style.boxShadow,'none');
  assert.equal(packets(h).length,2);
  for(const button of packets(h).filter(button=>!button.hidden)){const[x,y]=xy(button);assert.ok(x>=0&&x+button.offsetWidth<=280);assert.ok(y>=0&&y+button.offsetHeight<=188);}
  assert.equal(h.w.document.querySelectorAll('.thinking-flow-layer').length,1);
});

test('static canvas labels yield to readable data fragments and avoid one another without hiding nodes',t=>{
  const h=harness(t,{reduced:true}),graph=clone(baseGraph);
  for(const node of graph.nodes){node.y=.5;node.major=true;node.label=node.id==='core'?'Read workspace':'Result received';}
  graph.nodes.find(node=>node.id==='core').x=.7;for(const node of graph.nodes.filter(node=>node.kind==='output'))node.x=.73;
  for(const edge of graph.edges)edge.bend=0;
  graph.nodes.push({id:'free-a',x:.5,y:.07,label:'Retained source',major:true},{id:'free-b',x:.5,y:.07,label:'Another source',major:true});
  const before=h.stats().arcs;h.update(graph);const labels=h.stats().labels,rects=packets(h).filter(button=>!button.hidden).map(button=>{const[x,y]=xy(button);return{x,y,width:button.offsetWidth,height:button.offsetHeight};});
  assert.equal(labels.filter(label=>['Retained source','Another source'].includes(label.text)).length,1,'a clear label remains, with its overlapping neighbor omitted');
  assert.ok(!labels.some(label=>label.text==='Read workspace'),'a static action label yields to travelling data');
  assert.ok(h.stats().arcs-before>=graph.nodes.length,'all graph nodes are still drawn');
  for(const label of labels){const rect={x:label.x-(label.align==='right'?label.width:label.align==='center'?label.width/2:0),y:label.y-10,width:label.width,height:13};
    assert.ok(rects.every(other=>rect.x+rect.width<=other.x||rect.x>=other.x+other.width||rect.y+rect.height<=other.y||rect.y>=other.y+other.height),'static text never overlaps another visible label');rects.push(rect);
  }
});

test('real event graph changes morph existing nodes without restarting the preserved canvas',t=>{
  const h=harness(t);h.run(16,1600);const button=packets(h)[0],before=xy(button);
  const graph=clone(baseGraph);graph.signature='fetch-2';graph.nodes[0].x=.75;graph.nodes[1].x=.85;
  h.update(graph);h.advance(1616);const early=xy(button);h.run(1632,3200);const later=xy(button);
  assert.ok(Math.abs(early[0]-before[0])<40,'first frame keeps the previous position');assert.ok(Math.abs(later[0]-before[0])>70,'the node reaches its new route');
  assert.equal(h.w.document.querySelector('canvas'),h.canvas);assert.equal(h.stats().maxQueued,1);
});

test('canvas reparenting carries the inspection and selected data identity into a new chat card',t=>{
  const h=harness(t);h.run(16,1600);packets(h)[0].click();const section=h.w.document.querySelector('.thinking-flow-inspection');
  const graph=clone(baseGraph);graph.context='New observation';const next=h.replacement(graph);
  assert.equal(next.querySelector('.thinking-flow-inspection'),section);assert.equal(section.hidden,false);
  assert.equal(next.querySelector('[aria-pressed="true"]').textContent,'http_fetch');assert.match(section.textContent,/https:\/\/example.test\/weather/);
  assert.equal(next.querySelectorAll('.thinking-flow-layer').length,1);assert.equal(h.frames.size,1);assert.equal(h.timers.size,1);
});

test('hover and keyboard focus hold only their own readable fragment while other data keeps moving',t=>{
  const h=harness(t);h.run(16,1800);const buttons=packets(h),first=buttons[0];
  first.dispatchEvent(new h.w.Event('pointerenter'));h.advance(1816);const held=first.style.transform,other=buttons[2].style.transform;
  h.run(1832,2600);assert.equal(first.style.transform,held);assert.notEqual(buttons[2].style.transform,other);assert.equal(first.style.opacity,'1');
  first.dispatchEvent(new h.w.Event('pointerleave'));h.run(2616,3200);assert.notEqual(first.style.transform,held);
  first.focus();h.advance(3216);const focused=first.style.transform;h.run(3232,3700);assert.equal(first.style.transform,focused);assert.equal(first.style.opacity,'1');
});

test('recorded fragments cycle during visible motion while inspected keyboard selections stay readable',t=>{
  const h=harness(t),graph=clone(baseGraph);
  for(const [id,label,value]of [['humidity','Humidity','81%'],['pressure','Pressure','1020 hPa'],['condition','Condition','Clear'],['observed','Observed','16:00 UTC']]){
    graph.nodes.push({id,label,value,detail:'Recorded weather field',kind:'fact',x:.9,y:.5});
    graph.edges.push({id:`${id}-result`,from:'core',to:id,text:`${label}: ${value}`,detail:'Recorded weather field'});
  }
  h.update(graph);h.run(16,1600);const first=packets(h)[0],initial=packets(h).map(button=>button.textContent);first.click();first.focus();h.advance(1616);const held=first.style.transform;
  h.run(1632,12500);const cycled=packets(h).map(button=>button.textContent);
  assert.ok(packets(h).some(button=>!button.hidden&&!initial.includes(button.textContent)),'other recorded values become readable in the moving layer');
  assert.equal(first.isConnected,true);assert.equal(first.style.transform,held);assert.equal(first.style.opacity,'1');assert.equal(h.w.document.activeElement,first);
  assert.equal(first.getAttribute('aria-pressed'),'true');assert.match(h.w.document.querySelector('.thinking-flow-inspection').textContent,/https:\/\/example.test\/weather/);
  h.observers[0].fn([{isIntersecting:false}]);h.run(13000,70000);h.quiet();assert.deepEqual(packets(h).map(button=>button.textContent),cycled);
  h.observers[0].fn([{isIntersecting:true}]);h.advance(70016);assert.deepEqual(packets(h).map(button=>button.textContent),cycled,'hidden wall time does not advance the cycle');
  h.mediaChange(true);h.run(70032,100000);h.quiet();assert.deepEqual(packets(h).map(button=>button.textContent),cycled,'reduced motion keeps a still selection');
});

test('inspection shows exact source and result text and never executes imported markup',t=>{
  const h=harness(t);const graph=clone(baseGraph);graph.edges[0].text='<img src=x onerror="window.compromised=true">';graph.nodes[0].value='<script>window.compromised=true</script>';
  h.update(graph);h.run(16,1800);const button=packets(h)[0];assert.equal(button.textContent,graph.edges[0].text);button.click();
  const section=h.w.document.querySelector('.thinking-flow-inspection');assert.match(section.textContent,/<script>/);assert.match(section.textContent,/http_fetch/);
  assert.equal(h.w.document.querySelector('img'),null);assert.equal(h.w.document.querySelectorAll('script').length,0);assert.equal(h.w.compromised,undefined);
  section.querySelector('.thinking-flow-close').click();assert.equal(section.hidden,true);
});

test('reduced motion draws once, updates elapsed time, and redraws only for meaningful changes',t=>{
  const h=harness(t,{reduced:true,width:280});assert.equal(h.frames.size,0);assert.equal(h.timers.size,1);assert.ok(h.stats().strokes>0);
  const drawn=h.stats().strokes;h.quiet();assert.equal(h.stats().strokes,drawn);assert.match(h.card().querySelector('[data-thinking-elapsed]').textContent,/1m 1[56]s/);
  h.setWidth(300);h.quiet();assert.ok(h.stats().strokes>drawn);assert.equal(h.frames.size,0);assert.equal(h.timers.size,1);
  const resized=h.stats().strokes;h.card().style.color='rgb(170, 181, 201)';h.quiet();assert.ok(h.stats().strokes>resized,'a theme text-color change redraws a still graph');assert.equal(h.frames.size,0);
  h.mediaChange(false);h.advance(16);assert.equal(h.frames.size,1);h.mediaChange(true);h.advance(32);assert.equal(h.frames.size,0);
});

test('offscreen and hidden activity stop frames, including after polling updates',t=>{
  const h=harness(t);h.run(16,500);h.observers[0].fn([{isIntersecting:false}]);assert.equal(h.frames.size,0);
  const graph=clone(baseGraph);graph.signature='new-while-away';graph.nodes[0].x=.8;h.update(graph);h.quiet();assert.equal(h.frames.size,0);
  h.observers[0].fn([{isIntersecting:true}]);assert.equal(h.frames.size,1);h.advance(600);
  h.visibility(true);assert.equal(h.frames.size,0);h.quiet();assert.equal(h.frames.size,0);
  h.visibility(false);assert.equal(h.frames.size,1);
});

test('native engine return and browser back-forward cache resume one existing runtime',t=>{
  const h=harness(t);h.run(16,500);h.observers[0].fn([{isIntersecting:false}]);h.setTop(2000);h.w.dispatchEvent(new h.w.Event('studio:visible'));assert.equal(h.frames.size,0,'a scrolled-away canvas stays asleep');
  h.setTop(0);h.w.dispatchEvent(new h.w.Event('studio:visible'));assert.equal(h.frames.size,1);
  h.page('pagehide',true);assert.equal(h.frames.size,0);assert.equal(h.timers.size,0);
  h.page('pageshow',true);assert.equal(h.frames.size,1);assert.equal(h.timers.size,1);assert.equal(h.w.document.querySelectorAll('.thinking-flow-layer').length,1);
});

test('disconnection disposes observers, listeners and timers and permits a clean remount',t=>{
  const h=harness(t);h.run(16,300);const parent=h.canvas.parentElement;h.canvas.remove();h.advance(400);
  assert.equal(h.frames.size,0);assert.equal(h.timers.size,0);assert.equal(h.mediaListeners.size,0);assert.equal(parent.querySelector('.thinking-flow-layer'),null);assert.equal(h.observers[0].dead,true);
  parent.prepend(h.canvas);h.w.StudioThinking.mount(h.w.document);assert.equal(h.frames.size,1);assert.equal(h.timers.size,1);assert.equal(parent.querySelectorAll('.thinking-flow-layer').length,1);
});

test('invalid graphs fall back safely and activity interactions do not hijack the task Stop control',t=>{
  const h=harness(t);let stopped=0;h.w.document.addEventListener('click',event=>{if(event.target.closest('[data-action="stop-run"]'))stopped++;});
  h.card().querySelector('.thinking-stop').click();assert.equal(stopped,1);h.card().dataset.flow='{invalid';h.w.StudioThinking.mount(h.w.document);h.run(16,1000);
  assert.equal(packets(h).length,0);assert.ok(h.stats().arcs>0);assert.equal(h.frames.size,1);h.card().querySelector('.thinking-stop').click();assert.equal(stopped,2);
  const graph=clone(baseGraph);graph.nodes[0].x={toString:'invalid'};graph.nodes[0].value={toString:'invalid'};graph.edges[0].weight={toString:'invalid'};
  assert.doesNotThrow(()=>h.update(graph));h.run(1016,1400);assert.equal(h.frames.size,1);
});
