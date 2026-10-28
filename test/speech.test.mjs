import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpeechController,spokenText,recognitionNotice} from '../public/speech.mjs';
function harness({voiceList,recognition=true,storageValue}={}){
  const instances=[],utterances=[],stored=new Map(storageValue===undefined?[]:[['hermes-studio-speech-v1',storageValue]]),events=new EventTarget();let list=voiceList??[{voiceURI:'local-en',name:'Device English',lang:'en-US',localService:true}],cancelled=0;
  class Recognition{constructor(){instances.push(this);}start(){this.started=true;}stop(){this.stopped=true;}abort(){this.aborted=true;}result(...parts){this.onresult?.({results:parts.map(text=>[{transcript:text}])});}}
  class Utterance{constructor(text){this.text=text;}}
  const synthesis={getVoices:()=>list,speak:item=>utterances.push(item),cancel(){cancelled++;},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)};
  const win={navigator:{language:'en-US'},isSecureContext:true,document:{hidden:false},SpeechRecognition:recognition?Recognition:undefined,speechSynthesis:synthesis,SpeechSynthesisUtterance:Utterance,setTimeout,clearTimeout,localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value)}};
  const controller=createSpeechController(win,{voiceWaitMs:15});controller.setPreferences({engine:"browser"});return {controller,win,instances,utterances,stored,synthesis,setVoices(value){list=value;events.dispatchEvent(new Event('voiceschanged'));},get cancelled(){return cancelled;}};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('recognition requires the browser-processing notice and only changes a draft',()=>{
  const h=harness();let draft='Existing draft';assert.match(recognitionNotice,/may send microphone audio/);assert.throws(()=>h.controller.startDictation({getDraft:()=>draft,onDraft:value=>draft=value}),/notice/);assert.equal(h.instances.length,0);
  h.controller.acceptRecognitionNotice();h.controller.setPreferences({language:'uk-UA'});h.controller.startDictation({getDraft:()=>draft,onDraft:value=>draft=value});assert.equal(h.instances[0].lang,'uk-UA');assert.equal(h.controller.state.listening,true);h.instances[0].result('A dictated thought');assert.equal(draft,'Existing draft\nA dictated thought');assert.equal(h.utterances.length,0);
  h.controller.stopDictation();h.instances[0].result('late text');assert.equal(draft,'Existing draft\nA dictated thought');assert.equal(h.controller.state.listening,false);
});
test('cancel restores the pre-dictation draft and suppresses all late browser results',()=>{
  const h=harness();let draft='Keep this';h.controller.acceptRecognitionNotice();h.controller.startDictation({getDraft:()=>draft,onDraft:value=>draft=value});h.instances[0].result('temporary');h.controller.cancelDictation();assert.equal(draft,'Keep this');assert.equal(h.instances[0].aborted,true);h.instances[0].result('late');h.instances[0].onend();assert.equal(draft,'Keep this');assert.equal(h.controller.state.listening,false);
});
test('manual edits stop recognition rather than overwriting new typing, and long prefixes never shrink',()=>{
  const h=harness();let draft='Beginning';h.controller.acceptRecognitionNotice();h.controller.startDictation({getDraft:()=>draft,onDraft:value=>draft=value});h.instances[0].result('dictated');draft+=' typed by hand';h.instances[0].result('replacement');assert.equal(draft,'Beginning\ndictated typed by hand');assert.equal(h.controller.state.listening,false);h.controller.cancelDictation();assert.match(draft,/typed by hand$/);
  draft='x'.repeat(100000);h.controller.startDictation({getDraft:()=>draft,onDraft:value=>draft=value,maxLength:20000});h.instances[1].result('new content');assert.equal(draft.length,100000);assert.equal(draft,'x'.repeat(100000));h.controller.cleanup();
});
test('unavailable recognition and microphone failures have actionable messages',()=>{
  const h=harness({recognition:false});assert.equal(h.controller.available.recognition,false);assert.throws(()=>h.controller.startDictation(),/keyboard dictation/);
  const active=harness();active.controller.acceptRecognitionNotice();active.controller.startDictation({onDraft(){}});active.instances[0].onerror({error:'not-allowed'});assert.match(active.controller.state.error,/microphone access/i);assert.equal(active.controller.state.listening,false);
});
test('read aloud excludes code, chart JSON, tables, links and formulas from useful prose',async()=>{
  const text='# A useful result\n\nRevenue grew **12 percent**. Read [the report](https://example.com).\n\n| Quarter | Value |\n|---|---|\n| Q1 | 12 |\n\n```chart\n{"type":"bar","secret":42}\n```\n\nInline `run_command()` and $$x^2$$.';
  const prose=spokenText(text);assert.match(prose,/Revenue grew 12 percent/);assert.match(prose,/the report/);assert.doesNotMatch(prose,/secret|Q1|run_command|x\^2|https:/);
  const h=harness();await h.controller.read(text,{key:'reply'});assert.equal(h.utterances.length,1);assert.equal(h.utterances[0].voice.localService,true);assert.equal(h.controller.state.readingKey,'reply');h.utterances[0].onend();assert.equal(h.controller.state.reading,false);
});
test('online voices require explicit selection and acknowledgement; automatic never chooses one',async()=>{
  const online={voiceURI:'online-en',name:'Online voice',lang:'en-US',localService:false},h=harness({voiceList:[online]});await assert.rejects(h.controller.read('Private reply'),/on-device/);assert.equal(h.utterances.length,0);
  h.controller.setPreferences({voiceURI:online.voiceURI});await assert.rejects(h.controller.read('Private reply'),/explicitly/);assert.equal(h.utterances.length,0);
  h.controller.setPreferences({allowRemoteVoice:true});await h.controller.read('Approved online reply');assert.equal(h.utterances[0].voice,online);h.controller.cleanup();
});
test('voices are allowed to load asynchronously and cleanup invalidates waiting speech',async()=>{
  const h=harness({voiceList:[]}),pending=h.controller.read('After voices load');assert.equal(h.controller.state.loadingVoice,true);h.setVoices([{voiceURI:'local',name:'Local',lang:'en-US',localService:true}]);assert.equal(await pending,true);assert.equal(h.utterances.length,1);h.controller.cleanup();
  const cancelled=harness({voiceList:[]}),waiting=cancelled.controller.read('Do not read after navigation');cancelled.controller.cleanup();cancelled.setVoices([{voiceURI:'local',name:'Local',lang:'en-US',localService:true}]);assert.equal(await waiting,false);assert.equal(cancelled.utterances.length,0);
});
test('automatic reading is off by default and reads only each new completed assistant reply once',async()=>{
  const h=harness(),old={key:'old',role:'assistant',text:'Existing history'};h.controller.observeReplies('bot/a',[old]);h.controller.observeReplies('bot/a',[old,{key:'not-auto',role:'assistant',text:'Auto is off'}]);await tick();assert.equal(h.utterances.length,0);
  h.controller.setPreferences({autoRead:true});h.controller.observeReplies('bot/a',[old,{key:'partial',role:'assistant',partial:true,text:'Partial'},{key:'failed',role:'assistant',runStatus:'failed',text:'Failed'}]);await tick();assert.equal(h.utterances.length,0);
  const final={key:'new',role:'assistant',runStatus:'completed',text:'A fresh completed reply'};h.controller.observeReplies('bot/a',[old,final]);await tick();assert.equal(h.utterances.length,1);h.controller.observeReplies('bot/a',[old,final]);await tick();assert.equal(h.utterances.length,1);
  h.controller.cleanup();h.controller.observeReplies('bot/a',[old,final,{key:'away',role:'assistant',text:'History from another visit'}]);await tick();assert.equal(h.utterances.length,1);
});
test('dictation and cleanup stop ongoing reading, and later chunk errors never leave a stuck player',async()=>{
  const h=harness();await h.controller.read('A long sentence. '.repeat(200),{key:'long'});const first=h.utterances[0];h.synthesis.speak=()=>{throw new Error('voice disappeared');};assert.doesNotThrow(()=>first.onend());assert.equal(h.controller.state.reading,false);assert.match(h.controller.state.error,/could not continue/);
  h.synthesis.speak=item=>h.utterances.push(item);await h.controller.read('Another reply');h.controller.acceptRecognitionNotice();h.controller.startDictation({onDraft(){}});assert.equal(h.controller.state.reading,false);assert.equal(h.controller.state.listening,true);h.controller.cleanup();assert.equal(h.controller.state.listening,false);assert.equal(h.controller.state.reading,false);
});
test('malformed preferences and blocked browser storage do not disable voice controls',()=>{
  for(const value of ['null','0','[]','"text"','invalid JSON'])assert.equal(harness({storageValue:value}).controller.preferences.autoRead,false);
  const h=harness();Object.defineProperty(h.win,'localStorage',{get(){throw new Error('blocked');}});assert.doesNotThrow(()=>{const controller=createSpeechController(h.win);controller.setPreferences({language:'pl-PL',autoRead:true});assert.equal(controller.preferences.language,'pl-PL');});
});
