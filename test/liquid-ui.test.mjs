import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/liquid.js',import.meta.url),'utf8');

// Minimal DOM doubles: elements match the liquid selector by class and report a fixed box.
function harness({reduced=false}={}) {
  const listeners={};
  class Element {
    constructor(className,parent=null,{disabled=false}={}){this.className=className;this.parent=parent;this.disabled=disabled;this.vars={};this.classes=new Set(className.split(' '));this.flushes=0;
      this.style={setProperty:(name,value)=>{this.vars[name]=value;}};
      this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name),contains:name=>this.classes.has(name)};}
    get offsetWidth(){this.flushes++;return 120;}
    getAttribute(){return null;}
    getBoundingClientRect(){return {left:100,top:50,width:120,height:40};}
    closest(selector){for(let node=this;node;node=node.parent){if(selector.split(',').some(part=>part.trim().split(' ').every(token=>token.split('.').filter(Boolean).every(name=>node.classes.has(name)))))return node;}return null;}
  }
  const document={addEventListener(type,fn){listeners[type]=fn;}};
  const window={matchMedia:()=>({matches:reduced})};
  vm.runInContext(source,vm.createContext({document,window,Element,requestAnimationFrame:fn=>{fn();return 1;}}));
  return {Element,fire:(type,event)=>listeners[type](event)};
}

test('a press starts the drop where the pointer touched and restarts it on the next press',()=>{
  const h=harness(),button=new h.Element('primary-button'),label=new h.Element('label',button);
  h.fire('pointerdown',{target:label,button:0,clientX:130,clientY:70});
  assert.ok(button.classList.contains('is-dropping'));
  assert.deepEqual(button.vars,{'--drop-x':'30px','--drop-y':'20px','--drop-size':'138px'});
  h.fire('pointerdown',{target:button,button:0,clientX:200,clientY:60});
  assert.equal(button.flushes,2);assert.equal(button.vars['--drop-x'],'100px');
  h.fire('animationend',{target:button,animationName:'liquid-drop'});assert.ok(!button.classList.contains('is-dropping'));
});

test('keyboard presses drop from the centre; other buttons, right clicks and disabled controls are left alone',()=>{
  const h=harness(),button=new h.Element('secondary-button'),plain=new h.Element('nav-item'),disabled=new h.Element('primary-button',null,{disabled:true});
  h.fire('click',{target:button,detail:0});assert.equal(button.vars['--drop-x'],'60px');assert.equal(button.vars['--drop-y'],'20px');
  h.fire('click',{target:plain,detail:0});h.fire('pointerdown',{target:plain,button:0,clientX:1,clientY:1});assert.deepEqual(plain.vars,{});
  const other=new h.Element('accent-button');h.fire('pointerdown',{target:other,button:2,clientX:1,clientY:1});assert.ok(!other.classList.contains('is-dropping'));
  h.fire('pointerdown',{target:disabled,button:0,clientX:1,clientY:1});assert.ok(!disabled.classList.contains('is-dropping'));
});

test('reduced motion turns the drop off and the highlight only follows a mouse',()=>{
  const h=harness({reduced:true}),button=new h.Element('primary-button');
  h.fire('pointerdown',{target:button,button:0,clientX:130,clientY:70});assert.ok(!button.classList.contains('is-dropping'));
  h.fire('pointermove',{target:button,pointerType:'touch',clientX:130,clientY:70});assert.equal(button.vars['--mx'],undefined);
  h.fire('pointermove',{target:button,pointerType:'mouse',clientX:130,clientY:70});assert.equal(button.vars['--mx'],'30px');assert.equal(button.vars['--my'],'20px');
});
