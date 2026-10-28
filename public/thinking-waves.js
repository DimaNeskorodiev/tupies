/* Event-driven activity, shared by the web and Apple web views. No model runs here:
   the adapter supplies bounded sources, operations and observed results. A runtime
   belongs to the preserved canvas, so polling never restarts its flow. */
(() => {
  'use strict';
  const win=window, runtimes=new WeakMap(), active=new Set(), TAU=Math.PI*2;
  const media=win.matchMedia?.('(prefers-reduced-motion: reduce)'), reduced=()=>!!media?.matches;
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  const num=(v,f)=>(typeof v==='number'||typeof v==='string')&&Number.isFinite(Number(v))?Number(v):f;
  const text=(v,max=600)=>['string','number','boolean'].includes(typeof v)?String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max):'';
  const mix=(a,b,k)=>a.map((v,i)=>Math.round(v+(b[i]-v)*k));
  const rgba=(c,a)=>`rgba(${c.map(Math.round).join(',')},${clamp(a,0,1).toFixed(3)})`;
  function hash(value){let n=2166136261;for(const c of String(value))n=Math.imul(n^c.charCodeAt(0),16777619);return n>>>0;}
  function palette(value){
    const parse=hex=>{const m=/^#([0-9a-f]{6})$/i.exec(hex.trim());if(!m)return null;const n=Number.parseInt(m[1],16);return[n>>16&255,n>>8&255,n&255];};
    const colors=String(value||'').split(',').slice(0,4).map(parse).filter(Boolean);
    return colors.length>=4?colors:['#d9baff','#9970ed','#5931ad','#efdcff'].map(parse);
  }
  function fallback(key){
    return {kind:'thinking',signature:key,nodes:[[.08,.5],[.25,.25],[.34,.72],[.5,.46],[.66,.21],[.74,.73],[.92,.5]].map(([x,y],i)=>({id:`n${i}`,x,y,label:'',value:'',detail:'',kind:i===3?'transform':'input',major:false})),edges:[[0,1],[0,2],[1,3],[2,3],[1,4],[3,4],[3,5],[4,6],[5,6]].map(([a,b],i)=>({id:`e${i}`,from:`n${a}`,to:`n${b}`,text:'',detail:'',weight:1,bend:(i%3-1)*.1,color:i%3}))};
  }
  function normalize(input,key){
    if(!input||!Array.isArray(input.nodes)||!Array.isArray(input.edges))return fallback(key);
    const ids=new Set(),nodes=[];
    for(const item of input.nodes.slice(0,24)){
      if(!item||typeof item!=='object')continue;const id=text(item.id,100);if(!id||ids.has(id))continue;ids.add(id);
      nodes.push({id,label:text(item.label,70),value:text(item.value),detail:text(item.detail,1200),kind:text(item.kind,30),x:clamp(num(item.x,.5),.04,.96),y:clamp(num(item.y,.5),.06,.94),major:!!item.major});
    }
    if(!nodes.length)return fallback(key);
    const seen=new Set(),edges=[];
    for(const item of input.edges.slice(0,40)){
      if(!item||typeof item!=='object')continue;const from=text(item.from,100),to=text(item.to,100),id=text(item.id||`${from}:${to}`,220);
      if(!ids.has(from)||!ids.has(to)||seen.has(id))continue;seen.add(id);
      edges.push({id,from,to,text:text(item.text,100),detail:text(item.detail,1200),weight:clamp(num(item.weight,1),.1,8),bend:clamp(num(item.bend,0),-.65,.65),color:clamp(Math.floor(num(item.color,0)),0,2)});
    }
    return {kind:text(input.kind,30),signature:text(input.signature||key,180),caption:text(input.caption,200),context:text(input.context,300),status:text(input.status,40),nodes,edges};
  }
  function create(canvas){
    const ctx=canvas.getContext?.('2d');if(!ctx)return null;
    const doc=canvas.ownerDocument||(typeof document==='object'?document:null);
    const s={canvas,ctx,doc,card:null,graph:null,key:'',colorKey:'',pool:new Map(),colors:palette(''),peer:null,width:0,height:0,ratio:0,clock:(hash(canvas.dataset?.thinking)%100)/8,packetTime:0,packetTurn:0,last:0,paint:0,raf:0,timer:0,dirty:true,visible:true,suspended:false,dead:false,pointer:null,hover:null,held:null,selected:null,focused:null,packets:[],layer:null,inspection:null,listeners:[],cardListeners:[]};
    const connected=()=>canvas.isConnected!==false,hidden=()=>!!doc?.hidden;
    const cancelFrame=id=>{if(id&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(id);};
    const cancelTimer=id=>{if(id&&typeof clearTimeout==='function')clearTimeout(id);};
    function listen(target,name,handler,options,bucket=s.listeners){if(!target?.addEventListener)return;target.addEventListener(name,handler,options);bucket.push(()=>target.removeEventListener?.(name,handler,options));}
    function clear(bucket){for(const remove of bucket.splice(0))remove();}
    function el(tag,className){const node=doc?.createElement?.(tag);if(node&&className)node.className=className;return node;}
    function compact(){return !!s.card?.closest?.('.thinking-message.is-compact');}
    function attach(){
      const card=canvas.closest?.('[data-thinking-card]')||canvas.parentElement;if(!card)return null;
      if(card===s.card)return card;
      clear(s.cardListeners);s.card=card;s.pointer=null;s.dirty=true;
      if(!doc?.createElement||!card.appendChild)return card;
      if(!s.layer){s.layer=el('div','thinking-flow-layer');s.layer.setAttribute('role','group');s.layer.setAttribute('aria-label','Moving activity data');}
      card.appendChild(s.layer);if(s.inspection)card.appendChild(s.inspection);
      listen(card,'pointermove',event=>{
        const r=canvas.getBoundingClientRect?.();if(!r)return;const x=event.clientX-r.left,y=event.clientY-r.top;
        if(x<0||x>s.width||y<0||y>s.height){s.pointer=null;if(!s.held)s.hover=null;return;}
        s.pointer={x,y};if(!s.held&&!s.selected)s.hover=nearest().edge?.id||null;wake();
      },{passive:true},s.cardListeners);
      listen(card,'pointerleave',()=>{s.pointer=null;if(!s.held&&!s.selected)s.hover=null;wake();},undefined,s.cardListeners);
      listen(card,'click',event=>{
        if(event.target?.closest?.('button,a,input,textarea,summary'))return;const r=canvas.getBoundingClientRect?.();if(!r)return;
        const x=event.clientX-r.left,y=event.clientY-r.top;if(x<0||x>s.width||y<0||y>s.height)return;
        s.pointer={x,y};const hit=nearest();if(hit.node)inspectNode(hit.node);else if(hit.edge)inspectEdge(hit.edge);if(event.pointerType==='touch')s.pointer=null;wake();
      },undefined,s.cardListeners);
      return card;
    }
    function read(){
      const card=attach();if(!card)return;
      const raw=String(card.dataset?.flow||''),key=`${raw.slice(0,64000)}|${card.dataset?.energy||''}`;
      if(key!==s.key){s.key=key;let input=null;if(raw&&raw.length<=64000){try{input=JSON.parse(raw);}catch{}}install(normalize(input,key));}
      const colors=`${card.dataset?.colors||''}|${card.dataset?.peerColors||''}`;
      if(colors!==s.colorKey){s.colorKey=colors;s.colors=palette(card.dataset?.colors);s.peer=card.dataset?.peerColors?palette(card.dataset.peerColors):null;s.dirty=true;}
    }
    function install(graph){
      s.graph=graph;const ids=new Set(graph.nodes.map(node=>node.id));
      for(const node of s.pool.values())if(!ids.has(node.id)){node.targetAlpha=0;node.tx=.5;node.ty=.5;}
      graph.nodes.forEach((node,i)=>{const old=s.pool.get(node.id);if(old){const {x,y,alpha}=old;Object.assign(old,node,{x,y,alpha,tx:node.x,ty:node.y,targetAlpha:1});}else s.pool.set(node.id,{...node,x:.45+Math.sin(i*2.3)*.045,y:.5+Math.cos(i*1.9)*.06,tx:node.x,ty:node.y,alpha:reduced()?1:.15,targetAlpha:1});});
      if(reduced())for(const [id,node]of s.pool){node.x=node.tx;node.y=node.ty;node.alpha=node.targetAlpha;if(!node.targetAlpha)s.pool.delete(id);}
      if(s.selected&&!graph.edges.some(edge=>edge.id===s.selected))closeInspection(false);
      if(s.held&&!graph.edges.some(edge=>edge.id===s.held.id))s.held=null;
      renderPackets();const label=s.card?.querySelector?.('[data-thinking-context]');if(label)label.textContent=graph.context||'';
      s.layer?.setAttribute('aria-label',graph.caption?`Activity data: ${graph.caption}`:'Moving activity data');s.dirty=true;
    }
    function resize(){
      const w=Math.max(1,num(canvas.clientWidth,320)||320),h=Math.max(1,num(canvas.clientHeight,180)||180),ratio=clamp(num(win.devicePixelRatio,1),1,2);
      if(w===s.width&&h===s.height&&ratio===s.ratio)return false;const changed=(s.width<380)!==(w<380);s.width=w;s.height=h;s.ratio=ratio;
      canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);ctx.setTransform(ratio,0,0,ratio,0,0);
      if(changed)renderPackets();for(const packet of s.packets)measure(packet);if(s.held){const edge=edgeById(s.held.id);if(edge)s.held.point=curve(edge,s.held.u);}s.dirty=true;return true;
    }
    function edgeById(id){return s.graph?.edges.find(edge=>edge.id===id);}
    function pinned(id){return id===s.selected||id===s.held?.id||id===s.focused;}
    function selection(){
      const edges=s.graph?.edges.filter(edge=>edge.text)||[],count=s.width<380||compact()?2:3;
      const selected=edges.length<=count?edges:Array.from({length:count},(_,i)=>edges[(Math.floor(i*(edges.length-1)/(count-1))+s.packetTurn)%edges.length]);
      const keep=edges.filter(edge=>pinned(edge.id));
      return [...new Map([...keep,...selected].map(edge=>[edge.id,edge])).values()].slice(0,count);
    }
    function packetFor(button){return s.packets.find(packet=>packet.button===button);}
    function measure(packet){packet.width=packet.button.offsetWidth||Math.min(140,packet.edge.text.length*6+18);packet.height=packet.button.offsetHeight||28;}
    function hold(button,focus){const packet=packetFor(button);if(!packet)return;if(focus)s.focused=packet.edge.id;if(s.held?.id!==packet.edge.id)s.held={id:packet.edge.id,u:progress(packet.index),point:curve(packet.edge,progress(packet.index))};s.hover=packet.edge.id;wake();}
    function release(button,focus){const packet=packetFor(button);if(!packet)return;if(focus&&s.focused===packet.edge.id)s.focused=null;if(s.selected===packet.edge.id||s.focused===packet.edge.id)return;if(s.held?.id===packet.edge.id)s.held=null;s.hover=null;wake();}
    function renderPackets(){
      if(!s.layer||!s.graph)return;const existing=new Map(s.packets.map(packet=>[packet.edge.id,packet])),chosen=selection(),ids=new Set(chosen.map(edge=>edge.id));
      for(const packet of s.packets)if(!ids.has(packet.edge.id)){clear(packet.listeners);packet.button.remove?.();}
      s.packets=chosen.map((edge,index)=>{
        let packet=existing.get(edge.id);
        if(!packet){
          const button=el('button','thinking-flow-fragment'),listeners=[];button.type='button';button.setAttribute('aria-pressed','false');packet={button,edge,index,width:100,height:28,born:s.packetTime,listeners};
          listen(button,'pointerenter',()=>hold(button,false),undefined,listeners);listen(button,'pointerleave',()=>release(button,false),undefined,listeners);
          listen(button,'focus',()=>hold(button,true),undefined,listeners);listen(button,'blur',()=>release(button,true),undefined,listeners);
          listen(button,'click',event=>{event.stopPropagation?.();const current=packetFor(button);if(!current)return;hold(button,false);s.selected=current.edge.id;inspectEdge(current.edge);syncPressed();wake();},undefined,listeners);
        }
        packet.edge=edge;packet.index=index;packet.button.textContent=edge.text;packet.button.setAttribute('aria-label',`Inspect ${edge.text}`);packet.button.setAttribute('aria-pressed',String(s.selected===edge.id));if(packet.button.parentElement!==s.layer)s.layer.appendChild(packet.button);measure(packet);return packet;
      });
      if(s.selected){const edge=edgeById(s.selected);if(edge)inspectEdge(edge);}
    }
    function syncPressed(){for(const packet of s.packets)packet.button.setAttribute('aria-pressed',String(packet.edge.id===s.selected));}
    function ensureInspection(){
      if(!doc?.createElement||!s.card?.appendChild)return null;if(s.inspection)return s.inspection;
      const section=el('section','thinking-flow-inspection'),head=el('div','thinking-flow-inspection-head'),title=el('strong'),close=el('button','thinking-flow-close'),detail=el('p'),value=el('pre');
      section.setAttribute('aria-label','Selected activity data');title.dataset.thinkingInspectTitle='';detail.dataset.thinkingInspectDetail='';value.dataset.thinkingInspectValue='';close.type='button';close.textContent='Close ×';close.setAttribute('aria-label','Close activity inspection');
      head.appendChild(title);head.appendChild(close);section.appendChild(head);section.appendChild(detail);section.appendChild(value);listen(close,'click',event=>{event.stopPropagation?.();closeInspection(true);});s.card.appendChild(section);s.inspection=section;return section;
    }
    function showInspection(title,detail,value){const section=ensureInspection();if(!section)return;section.hidden=false;section.querySelector('[data-thinking-inspect-title]').textContent=text(title,200);section.querySelector('[data-thinking-inspect-detail]').textContent=text(detail,1200);section.querySelector('[data-thinking-inspect-value]').textContent=text(value,1800);}
    function inspectEdge(edge){const a=s.pool.get(edge.from),b=s.pool.get(edge.to);if(!a||!b)return;s.hover=edge.id;showInspection(`${a.label||'Input'} → ${b.label||'Result'}`,edge.detail,[edge.text,a.value,b.value].filter(Boolean).join('\n'));}
    function inspectNode(node){showInspection(node.label||'Activity data',node.detail,node.value);}
    function closeInspection(restore){const selected=s.selected;s.selected=null;s.held=null;s.hover=null;if(s.inspection)s.inspection.hidden=true;syncPressed();if(restore)s.packets.find(packet=>packet.edge.id===selected)?.button.focus?.({preventScroll:true});wake();}
    function position(node){
      const time=reduced()?4:s.clock,seed=hash(node.id)%1000,margin=s.width<380?11:18,vertical=s.height<120?14:22;
      let x=margin+node.x*Math.max(1,s.width-margin*2)+Math.sin(time*.37+seed)*2.4,y=vertical+node.y*Math.max(1,s.height-vertical*2)+Math.cos(time*.32+seed)*Math.min(3,s.height*.018);
      if(s.pointer&&!reduced()){const dx=x-s.pointer.x,dy=y-s.pointer.y,d=Math.hypot(dx,dy);if(d>1&&d<82){const shift=(1-d/82)*7;x+=dx/d*shift;y+=dy/d*shift;}}return{x,y};
    }
    function curve(edge,amount){
      const start=s.pool.get(edge.from),end=s.pool.get(edge.to);if(!start||!end)return{x:s.width/2,y:s.height/2};
      const a=position(start),b=position(end),dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy));let bend=edge.bend*s.height+(reduced()?0:Math.sin(s.clock*.42+hash(edge.id)%100)*Math.min(8,s.height*.04));
      if(s.pointer&&!reduced()){const near=Math.hypot((a.x+b.x)/2-s.pointer.x,(a.y+b.y)/2-s.pointer.y);if(near<100)bend+=(1-near/100)*7;}
      const c={x:a.x+dx*.35-dy/d*bend,y:a.y+dy*.35+dx/d*bend},e={x:a.x+dx*.7-dy/d*bend,y:a.y+dy*.7+dx/d*bend},u=clamp(amount,0,1),v=1-u;
      return{x:v*v*v*a.x+3*v*v*u*c.x+3*v*u*u*e.x+u*u*u*b.x,y:v*v*v*a.y+3*v*v*u*c.y+3*v*u*u*e.y+u*u*u*b.y};
    }
    function progress(index){const local=((s.clock*.075+index*.31)%1+1)%1;return local<.24?.08+local/.24*.42:local>.73?.5+(local-.73)/.27*.42:.5;}
    function lineage(id){
      const edge=edgeById(id);if(!edge)return null;const result=new Set([edge.from,edge.to]);
      for(const direction of ['up','down']){const queue=[direction==='up'?edge.from:edge.to],seen=new Set(queue);while(queue.length){const id=queue.shift();for(const link of s.graph.edges)if((direction==='up'?link.to:link.from)===id){const next=direction==='up'?link.from:link.to;result.add(next);if(!seen.has(next)){seen.add(next);queue.push(next);}}}}return result;
    }
    function nearest(){
      if(!s.pointer)return{node:null,edge:null};let node=null,edge=null,nd=21,ed=12;
      for(const item of s.graph?.nodes||[]){const current=s.pool.get(item.id);if(!current||current.alpha<.6)continue;const p=position(current),d=Math.hypot(p.x-s.pointer.x,p.y-s.pointer.y);if(d<nd){node=current;nd=d;}}
      for(const link of s.graph?.edges||[])for(let i=0;i<=12;i++){const p=curve(link,i/12),d=Math.hypot(p.x-s.pointer.x,p.y-s.pointer.y);if(d<ed){edge=link;ed=d;}}return{node,edge};
    }
    function glow(x,y,r,color,alpha){const gradient=ctx.createRadialGradient(x,y,0,x,y,r);gradient.addColorStop(0,rgba(color,alpha));gradient.addColorStop(1,rgba(color,0));ctx.fillStyle=gradient;ctx.fillRect(x-r,y-r,r*2,r*2);}
    function draw(){
      resize();ctx.clearRect(0,0,s.width,s.height);const [,mid,deep]=s.colors,colors=[mid,mix(mid,deep,.42),s.peer?s.peer[1]:mix(mid,s.colors[0],.3)],traced=lineage(s.hover);
      for(const edge of s.graph?.edges||[]){
        const a=s.pool.get(edge.from),b=s.pool.get(edge.to);if(!a||!b)continue;const alpha=Math.min(a.alpha,b.alpha),focus=traced?.has(edge.from)&&traced?.has(edge.to),color=colors[edge.color];
        for(let strand=0;strand<3;strand++){ctx.beginPath();for(let i=0;i<=32;i++){const u=i/32,p=curve(edge,u),off=(strand-1)*Math.sin(u*Math.PI)*Math.min(2.2,s.height*.016);i?ctx.lineTo(p.x+off,p.y+off*.3):ctx.moveTo(p.x,p.y);}ctx.strokeStyle=rgba(color,alpha*(focus?.62:.24)*(strand===1?1:.4));ctx.lineWidth=focus?1.1:.55+Math.min(1.3,edge.weight*.2);ctx.stroke();}
      }
      if(!reduced()&&s.graph?.edges.length){
        const edges=s.graph.edges,count=compact()?52:s.width<380?68:112,maximum=Math.max(1,...edges.map(edge=>edge.weight));
        for(let i=0;i<count;i++){const edge=edges[(i*7+Math.floor(i/edges.length))%edges.length],a=s.pool.get(edge.from),b=s.pool.get(edge.to);if(!a||!b)continue;const alpha=Math.min(a.alpha,b.alpha),u=(i*.6180339+s.clock*(.075+edge.weight/maximum*.04))%1,p=curve(edge,u),tail=curve(edge,Math.max(0,u-.034)),color=colors[edge.color];ctx.strokeStyle=rgba(color,alpha*(.3+.4*Math.sin(u*Math.PI)));ctx.lineWidth=i%5===0?1.25:.7;ctx.beginPath();ctx.moveTo(tail.x,tail.y);ctx.lineTo(p.x,p.y);ctx.stroke();if(i%6===0){glow(p.x,p.y,5,color,.1*alpha);ctx.beginPath();ctx.arc(p.x,p.y,.9,0,TAU);ctx.fillStyle=rgba(color,.75*alpha);ctx.fill();}}
      }
      const occupied=placePackets();let labels=0;
      for(const node of [...s.pool.values()].sort((a,b)=>Number(b.kind==='output')-Number(a.kind==='output'))){
        if(node.alpha<.02)continue;const p=position(node),color=colors[node.kind==='output'||node.kind==='agent'?2:node.kind==='source'?1:0],radius=node.major?2.8:1.5;
        glow(p.x,p.y,node.major?16:7,color,node.alpha*(node.major?.16:.07));ctx.beginPath();ctx.arc(p.x,p.y,radius,0,TAU);ctx.fillStyle=rgba(color,node.alpha*.8);ctx.fill();
        if(node.targetAlpha===1&&node.major&&node.label&&node.alpha>.65&&labels<(compact()?1:s.width<380?2:4)){
          const label=node.label.length>18?`${node.label.slice(0,17)}…`:node.label,y=clamp(p.y+16,12,s.height-2);ctx.font='10px -apple-system, BlinkMacSystemFont, sans-serif';
          const width=num(ctx.measureText?.(label)?.width,label.length*5.6),align=p.x<s.width*.15?'left':p.x>s.width*.85?'right':'center',rect={x:p.x-(align==='right'?width:align==='center'?width/2:0)-1,y:y-10,width:width+2,height:13};
          if(rect.x<1||rect.x+rect.width>s.width-1||occupied.some(other=>rect.x<other.x+other.width+4&&rect.x+rect.width+4>other.x&&rect.y<other.y+other.height+4&&rect.y+rect.height+4>other.y))continue;
          ctx.textAlign=align;ctx.fillStyle=rgba(mix(deep,[106,126,145],.5),.8*node.alpha);ctx.fillText(label,p.x,y);occupied.push(rect);labels++;
        }
      }
    }
    function placePackets(){
      const occupied=[],order=s.packets.slice().sort((a,b)=>Number(b.edge.id===s.held?.id)-Number(a.edge.id===s.held?.id));
      for(const packet of order){
        const a=s.pool.get(packet.edge.from),b=s.pool.get(packet.edge.to);if(!a||!b)continue;const held=s.held?.id===packet.edge.id;
        let p=held?s.held.point:curve(packet.edge,reduced()?.25+packet.index*.25:progress(packet.index)),x=clamp(p.x-packet.width/2,1,Math.max(1,s.width-packet.width-1)),y=clamp(p.y-packet.height/2,1,Math.max(1,s.height-packet.height-1));
        const overlaps=()=>occupied.some(r=>x<r.x+r.width+6&&x+packet.width+6>r.x&&y<r.y+r.height+8&&y+packet.height+8>r.y);
        if(overlaps()&&!held){p=curve(packet.edge,.18+packet.index*.23);x=clamp(p.x-packet.width/2,1,Math.max(1,s.width-packet.width-1));y=clamp(p.y-packet.height/2,1,Math.max(1,s.height-packet.height-1));}
        const fading=reduced()||pinned(packet.edge.id)?1:clamp((s.packetTime-packet.born)/.65,0,1);
        packet.button.hidden=!held&&(overlaps()||Math.min(a.alpha,b.alpha)<.25);packet.button.style.transform=`translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;packet.button.style.opacity=String(held?1:clamp(Math.min(a.alpha,b.alpha)*.93,.3,1)*fading);if(!packet.button.hidden)occupied.push({x,y,width:packet.width,height:packet.height});
      }
      return occupied;
    }
    function elapsed(){const label=s.card?.querySelector?.('[data-thinking-elapsed]'),started=Date.parse(s.card?.dataset?.started||'');if(!label||!Number.isFinite(started))return;const seconds=Math.max(0,Math.floor((Date.now()-started)/1000)),value=seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${String(seconds%60).padStart(2,'0')}s`;if(label.textContent!==value)label.textContent=value;}
    function frame(now){
      s.raf=0;if(s.dead||s.suspended)return;if(!connected()){destroy();return;}if(hidden()){s.last=0;return;}
      const dt=s.last?Math.min((now-s.last)/1000,.05):0;s.last=now;read();
      if(!reduced()){
        s.clock+=dt*(s.card?.dataset?.energy==='calm'?.5:s.card?.dataset?.energy==='write'?.7:1);s.packetTime+=dt;
        const turn=Math.floor(s.packetTime/12);if(turn!==s.packetTurn){s.packetTurn=turn;renderPackets();}
      }
      const amount=reduced()?1:Math.min(1,dt*3.5);let morphing=false;
      for(const [id,node]of s.pool){node.x+=(node.tx-node.x)*amount;node.y+=(node.ty-node.y)*amount;node.alpha+=(node.targetAlpha-node.alpha)*amount;if(Math.abs(node.alpha-node.targetAlpha)>.015||Math.abs(node.x-node.tx)>.001||Math.abs(node.y-node.ty)>.001)morphing=true;if(!node.targetAlpha&&node.alpha<.01)s.pool.delete(id);}
      if(s.dirty||now-s.paint>=1000/30){draw();s.dirty=false;s.paint=now;}elapsed();if(!reduced()&&(s.visible||morphing))schedule();else s.last=0;
    }
    function schedule(){if(!s.raf&&!s.dead&&!s.suspended&&s.visible&&!hidden()&&typeof requestAnimationFrame==='function')s.raf=requestAnimationFrame(frame);}
    function wake(){s.dirty=true;if(!s.dead&&!s.suspended)schedule();}
    function quiet(){
      s.timer=0;if(s.dead||s.suspended)return;if(!connected()){destroy();return;}read();const changed=resize();elapsed();if((s.dirty||changed)&&!hidden()&&s.visible){if(reduced()){draw();s.dirty=false;}else if(s.visible)wake();}s.timer=setTimeout(quiet,1000);
    }
    function destroy(){
      if(s.dead)return;s.dead=true;cancelFrame(s.raf);cancelTimer(s.timer);s.raf=0;s.timer=0;clear(s.listeners);clear(s.cardListeners);for(const packet of s.packets)clear(packet.listeners);s.resizeObserver?.disconnect?.();s.intersectionObserver?.disconnect?.();s.layer?.remove?.();s.inspection?.remove?.();s.pool.clear();active.delete(runtime);runtimes.delete(canvas);
    }
    function suspend(){s.suspended=true;cancelFrame(s.raf);cancelTimer(s.timer);s.raf=0;s.timer=0;s.last=0;}
    function resume(){if(!connected()){destroy();return;}s.suspended=false;read();quiet();wake();}
    const runtime={refresh(){if(!connected()){destroy();return;}read();resize();elapsed();if(reduced()){if(s.dirty){draw();s.dirty=false;}}else wake();},destroy,suspend,resume};
    active.add(runtime);
    listen(doc,'visibilitychange',()=>{if(hidden()){cancelFrame(s.raf);s.raf=0;s.last=0;}else wake();});
    listen(win,'studio:visible',()=>{const bounds=canvas.getBoundingClientRect?.();s.visible=!bounds||(bounds.bottom>0&&bounds.right>0&&bounds.top<(win.innerHeight||Infinity)&&bounds.left<(win.innerWidth||Infinity));s.last=0;runtime.refresh();});
    listen(media,'change',()=>{cancelFrame(s.raf);s.raf=0;s.last=0;s.held=null;s.pointer=null;if(reduced())for(const node of s.pool.values()){node.x=node.tx;node.y=node.ty;node.alpha=node.targetAlpha;}wake();});
    const Resize=win.ResizeObserver||(typeof ResizeObserver==='function'?ResizeObserver:null),Intersection=win.IntersectionObserver||(typeof IntersectionObserver==='function'?IntersectionObserver:null);
    if(Resize){s.resizeObserver=new Resize(()=>{resize();wake();});s.resizeObserver.observe(canvas);}
    if(Intersection){s.intersectionObserver=new Intersection(entries=>{s.visible=entries[0]?.isIntersecting!==false;if(s.visible)wake();else{cancelFrame(s.raf);s.raf=0;s.last=0;}});s.intersectionObserver.observe(canvas);}
    read();resize();draw();s.dirty=false;elapsed();if(!reduced())schedule();s.timer=setTimeout(quiet,1000);return runtime;
  }
  function mount(root=typeof document==='object'?document:null){for(const canvas of root?.querySelectorAll?.('canvas[data-thinking]')||[]){let runtime=runtimes.get(canvas);if(!runtime){runtime=create(canvas);if(runtime)runtimes.set(canvas,runtime);}else runtime.refresh();}}
  win.addEventListener?.('pagehide',event=>{for(const runtime of [...active])event.persisted?runtime.suspend():runtime.destroy();});
  win.addEventListener?.('pageshow',event=>{if(event.persisted)for(const runtime of [...active])runtime.resume();});
  win.StudioThinking=Object.freeze({mount});
})();
