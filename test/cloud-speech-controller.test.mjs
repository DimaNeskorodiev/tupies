import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechController, recordingWav, defaultSpeechModel } from '../public/speech.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function harness(){
  const audio=[],recorders=[],stopped=[],revoked=[],requests=[];let permission,transcript;
  class Audio {constructor(src){this.src=src;audio.push(this);}play(){return Promise.resolve();}pause(){this.paused=true;}removeAttribute(){}load(){}}
  class Recorder {static isTypeSupported(){return true;}constructor(){this.state='inactive';this.mimeType='audio/webm';recorders.push(this);}start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['fixture recording'])});this.onstop?.();});}}
  class Context {async decodeAudioData(){return {length:1600,sampleRate:16000,numberOfChannels:1,getChannelData:()=>new Float32Array(1600)};}async close(){this.closed=true;}}
  let uri=0;const win={navigator:{language:'en-US',mediaDevices:{getUserMedia:()=>permission||Promise.resolve({getTracks:()=>[{stop:()=>stopped.push(true)}]})}},isSecureContext:true,document:{hidden:false},MediaRecorder:Recorder,AudioContext:Context,Audio,AbortController,Blob,btoa:value=>Buffer.from(value,'binary').toString('base64'),URL:{createObjectURL:()=>`blob:${++uri}`,revokeObjectURL:value=>revoked.push(value)},setTimeout,clearTimeout};
  const controller=createSpeechController(win);controller.setTransport({async synthesize(body,signal){requests.push({type:'speech',body,signal});return new Blob(['audio'],{type:'audio/mpeg'});},async transcribe(body,signal){requests.push({type:'transcription',body,signal});return transcript||{text:'A dictated thought.'};}});
  controller.setPreferences({connectionId:'openrouter',cloudConsent:true,modelVoices:{[defaultSpeechModel]:'voice-a'}});
  return {controller,win,audio,recorders,stopped,revoked,requests,setPermission(value){permission=value;},setTranscript(value){transcript=value;}};
}
test('AI voices default to ElevenLabs but generation requires an explicitly chosen connection and consent',async()=>{
  const h=harness();assert.equal(h.controller.preferences.engine,'openrouter');assert.equal(h.controller.preferences.speechModel,'elevenlabs/eleven-v4-turbo');assert.equal(h.controller.preferences.transcriptionModel,'elevenlabs/scribe-v2');h.controller.setPreferences({cloudConsent:false});await assert.rejects(h.controller.read('No consent'),/Allow OpenRouter/);assert.equal(h.requests.length,0);
});
test('AI playback caches identical previews, separates voices, releases URLs, and sends readable prose only',async()=>{
  const h=harness();await h.controller.read('**Hello.**\n\n```js\nprivate_code()\n```',{key:'preview:eleven'});assert.equal(h.requests[0].body.text,'Hello.');assert.equal(h.controller.state.readingKey,'preview:eleven');h.controller.stopReading();assert.equal(h.audio[0].paused,true);assert.deepEqual(h.revoked,['blob:1']);
  await h.controller.read('Hello.');assert.equal(h.requests.length,1);await h.controller.read('Hello.',{settings:{modelVoices:{[defaultSpeechModel]:'voice-b'}}});assert.equal(h.requests.length,2);assert.equal(h.controller.preferences.modelVoices[defaultSpeechModel],'voice-a');h.audio.at(-1).onended();await tick();assert.equal(h.controller.state.reading,false);h.controller.cleanup();
});
test('Stop cancels paid generation and late audio cannot start playback',async()=>{
  const h=harness();let finish,signal;h.controller.setTransport({synthesize:(_body,s)=>{signal=s;return new Promise(resolve=>finish=resolve);}});const pending=h.controller.read('Still generating');assert.equal(h.controller.state.loadingVoice,true);h.controller.stopReading();assert.equal(signal.aborted,true);finish(new Blob(['late'],{type:'audio/mpeg'}));assert.equal(await pending,false);assert.equal(h.audio.length,0);
});
test('cloud dictation is recorded only until Stop, appends to the draft, and releases microphone tracks',async()=>{
  const h=harness();let draft='Existing draft';await h.controller.startDictation({getDraft:()=>draft,onDraft:value=>draft=value,maxLength:20000});assert.equal(h.requests.length,0);assert.equal(h.controller.state.listening,true);h.controller.stopDictation();await tick();assert.equal(draft,'Existing draft\nA dictated thought.');assert.equal(h.controller.state.transcribing,false);assert.ok(h.stopped.length);const request=h.requests[0];assert.equal(request.body.model,'elevenlabs/scribe-v2');assert.equal(request.body.language,'en');assert.equal(Buffer.from(request.body.audio,'base64').toString('ascii',0,4),'RIFF');h.controller.cleanup();
});
test('Cancel and edits during transcription preserve the draft and suppress late text',async()=>{
  const h=harness();let draft='Keep',resolve;h.setTranscript(new Promise(done=>resolve=done));await h.controller.startDictation({getDraft:()=>draft,onDraft:value=>draft=value});h.controller.stopDictation();await tick();assert.equal(h.controller.state.transcribing,true);draft+=' my typing';h.controller.cancelDictation();resolve({text:'Late transcript'});await tick();assert.equal(draft,'Keep my typing');assert.equal(h.requests[0].signal.aborted,true);assert.equal(h.controller.state.transcribing,false);h.controller.cleanup();
});
test('navigation during microphone permission stops any stream granted later without uploading audio',async()=>{
  const h=harness();let allow;h.setPermission(new Promise(resolve=>allow=resolve));const pending=h.controller.startDictation({onDraft(){}});h.controller.cleanup();allow({getTracks:()=>[{stop:()=>h.stopped.push(true)}]});await pending;assert.equal(h.stopped.length,1);assert.equal(h.recorders.length,0);assert.equal(h.requests.length,0);
});
test('Send discards an ongoing recording rather than dispatching a second transcription',async()=>{
  const h=harness();let draft='Ready';await h.controller.startDictation({getDraft:()=>draft,onDraft:value=>draft=value});h.controller.discardDictation();await tick();assert.equal(h.requests.length,0);assert.equal(draft,'Ready');assert.equal(h.controller.state.listening,false);
});
test('audio recording conversion downmixes, resamples, bounds duration and writes a valid WAV header',()=>{
  const bytes=recordingWav({length:4800,sampleRate:48000,numberOfChannels:2,getChannelData:index=>new Float32Array(4800).fill(index?-.5:.5)}),view=new DataView(bytes.buffer);assert.equal(bytes.length,3244);assert.equal(view.getUint32(24,true),16000);assert.equal(view.getInt16(44,true),0);assert.throws(()=>recordingWav({length:48000*61,sampleRate:48000}),/60 seconds/);
});
