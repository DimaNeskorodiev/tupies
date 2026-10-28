import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\nstart\(\);\s*$/,'\n');

// Browser dialog close events arrive on a later task. These DOM doubles retain
// that event order while exercising the real openDialog()/closeDialog() code.
function harness() {
  const pending=[],classes=new Set(),classRemovals=[];
  class Dialog {
    constructor(html){this.html=html;this.open=false;this.isConnected=true;this.listeners=new Map();}
    showModal(){this.open=true;}
    addEventListener(type,fn,options={}){const list=this.listeners.get(type)||[];list.push({fn,once:!!options.once});this.listeners.set(type,list);}
    dispatch(type,event={}){for(const entry of [...(this.listeners.get(type)||[])]){if(entry.once)this.listeners.set(type,this.listeners.get(type).filter(item=>item!==entry));entry.fn({target:this,...event});}}
    close(){if(!this.open)return;this.open=false;pending.push(()=>this.dispatch('close'));}
    browserEscape(){this.dispatch('cancel');this.close();}
    getBoundingClientRect(){return {left:0,right:600,top:0,bottom:500};}
  }
  const root={_html:'',dialog:null,
    get innerHTML(){return this._html;},
    set innerHTML(html){if(this.dialog)this.dialog.isConnected=false;this._html=html;this.dialog=html?new Dialog(html):null;},
    querySelector(selector){return selector==='dialog'?this.dialog:null;}
  };
  const document={hidden:false,activeElement:null,addEventListener(){},querySelectorAll(){return [];},
    body:{classList:{add(value){classes.add(value);},remove(value){classRemovals.push(value);classes.delete(value);}}},
    querySelector(selector){if(selector==='#dialog-root')return root;if(selector==='dialog')return root.dialog;return null;}
  };
  const ctx=vm.createContext({document,window:{addEventListener(){}},location:{hash:'#/integrations'},URL,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(source,ctx,{filename:'app.js'});
  return {root,classes,classRemovals,pending,run:code=>vm.runInContext(code,ctx),flush(){while(pending.length)pending.shift()();}};
}

test('a late close event from a saved form cannot remove its replacement result dialog',()=>{
  const h=harness();h.run("openDialog('Integration setup','<form>Saved settings</form>')");
  const setup=h.root.dialog;assert.equal(setup.open,true);assert.ok(h.classes.has('scroll-lock'));
  h.run('closeDialog()');assert.equal(h.pending.length,1);
  h.run("openDialog('API actions are configured','<p>The definitions were validated.</p>')");
  const result=h.root.dialog,resultHTML=h.root.innerHTML;
  assert.notEqual(result,setup);assert.equal(result.open,true);assert.equal(setup.isConnected,false);
  h.flush();
  assert.equal(h.root.dialog,result);assert.equal(h.root.innerHTML,resultHTML);assert.equal(result.open,true);
  assert.ok(h.classes.has('scroll-lock'));assert.equal(h.classRemovals.length,0);
});

test('closing the current dialog clears its contents and restores page scrolling',()=>{
  const h=harness();h.run("openDialog('Current result','<p>Done.</p>')");
  const current=h.root.dialog;h.run('closeDialog()');
  assert.equal(current.open,false);assert.equal(h.pending.length,1);
  h.flush();
  assert.equal(h.root.dialog,null);assert.equal(h.root.innerHTML,'');assert.ok(!h.classes.has('scroll-lock'));
  assert.deepEqual(h.classRemovals,['scroll-lock']);
});

test('Escape and a browser-originated close use the same current-dialog cleanup',()=>{
  for(const close of ['browserEscape','close']){
    const h=harness();h.run("openDialog('Dismissible dialog','<p>Safe to close.</p>')");
    h.root.dialog[close]();h.flush();
    assert.equal(h.root.dialog,null);assert.equal(h.root.innerHTML,'');assert.ok(!h.classes.has('scroll-lock'));
    assert.deepEqual(h.classRemovals,['scroll-lock']);
  }
});

test('several queued old close events leave the newest dialog intact until it closes',()=>{
  const h=harness();
  h.run("openDialog('First','<p>First.</p>');closeDialog();openDialog('Second','<p>Second.</p>');closeDialog();openDialog('Newest','<p>Keep this result.</p>')");
  const newest=h.root.dialog;assert.equal(h.pending.length,2);
  h.flush();assert.equal(h.root.dialog,newest);assert.match(h.root.innerHTML,/Keep this result/);
  assert.ok(h.classes.has('scroll-lock'));assert.equal(h.classRemovals.length,0);
  h.run('closeDialog()');h.flush();assert.equal(h.root.dialog,null);assert.ok(!h.classes.has('scroll-lock'));
});
