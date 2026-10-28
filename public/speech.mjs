const STORAGE_KEY='hermes-studio-speech-v1';
export const recognitionNotice='Your browser may send microphone audio to its speech service for processing. Dictation only fills your draft; review it before sending. Tupies does not record or upload microphone audio.';
export const recognitionFallback='Voice input is unavailable in this browser. Use Chrome or Safari with microphone access, or use your device’s keyboard dictation to type into the message draft.';
export const cloudNotice='OpenRouter and the selected speech provider process your microphone recording for dictation and reply text for spoken audio. API usage is billed to your OpenRouter account. Tupies keeps recordings and generated audio in memory only. Dictation stays in your draft until Send.';
export const defaultSpeechModel='elevenlabs/eleven-v4-turbo';
export const defaultTranscriptionModel='elevenlabs/scribe-v2';
export const previewText='Hello, I’m your Tupies teammate. We can take this one step at a time. Here’s the plan: review the details, explore a few ideas, and choose what works best for you.';
const errorMessages={
  'not-allowed':'Microphone access was denied. Allow microphone access in your browser settings, then try again.',
  'service-not-allowed':'The browser’s speech service is unavailable. Use your device’s keyboard dictation in the message draft.',
  'audio-capture':'No microphone is available. Connect a microphone or use your device’s keyboard dictation.',
  'no-speech':'No speech was detected. Check your microphone and try again.',
  network:'The browser’s speech service could not connect. Check your connection or use keyboard dictation.',
  'language-not-supported':'This speech language is unavailable. Choose another language in Chat options.'
};
export function spokenText(value){
  let text=String(value??'').slice(0,100000).replace(/```[\s\S]*?(?:```|$)/g,' ').replace(/~~~[\s\S]*?(?:~~~|$)/g,' ').replace(/\$\$[\s\S]*?\$\$/g,' ').replace(/\$[^$\n]+\$/g,' ').replace(/`[^`\n]+`/g,' ').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<[^>]*>/g,' ').replace(/!\[[^\]]*\]\([^)]*\)/g,' ').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1');
  text=text.split(/\n\s*\n/).filter(block=>{const trimmed=block.trim();if(/^[\[{]/.test(trimmed))try{JSON.parse(trimmed);return false;}catch{}return true;}).map(block=>block.split('\n').filter(line=>!/^\s*\|/.test(line)&&!/^\s*:?-{3,}/.test(line)).join('\n')).join('\n\n');
  return text.replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm,'').replace(/[*_~]{1,3}/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim().slice(0,16000);
}
function chunks(text){const result=[];let rest=text;while(rest.length>1400){let end=rest.lastIndexOf('. ',1400)+1;if(end<300)end=rest.lastIndexOf(' ',1400);if(end<1)end=1400;result.push(rest.slice(0,end).trim());rest=rest.slice(end).trim();}if(rest)result.push(rest);return result;}
export function recordingWav(buffer){
  if(!buffer.length||buffer.length/buffer.sampleRate>60.1)throw new Error('Record up to 60 seconds at a time.');
  const count=Math.min(960000,Math.floor(buffer.length*16000/buffer.sampleRate)),bytes=new Uint8Array(44+count*2),view=new DataView(bytes.buffer),write=(offset,text)=>{for(let i=0;i<text.length;i++)bytes[offset+i]=text.charCodeAt(i);};
  write(0,'RIFF');view.setUint32(4,bytes.length-8,true);write(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,count*2,true);
  const channels=Array.from({length:buffer.numberOfChannels},(_,index)=>buffer.getChannelData(index)),ratio=buffer.sampleRate/16000;
  for(let i=0;i<count;i++){const start=Math.floor(i*ratio),end=Math.max(start+1,Math.min(buffer.length,Math.floor((i+1)*ratio)));let sample=0;for(const channel of channels)for(let j=start;j<end;j++)sample+=channel[j];sample=Math.max(-1,Math.min(1,sample/(channels.length*(end-start))));view.setInt16(44+i*2,sample*(sample<0?32768:32767),true);}
  return bytes;
}
export function createSpeechController(win,{storage,voiceWaitMs=2200}={}){
  const Recognition=win.SpeechRecognition||win.webkitSpeechRecognition,synthesis=win.speechSynthesis,Utterance=win.SpeechSynthesisUtterance;
  try{storage??=win.localStorage;}catch{}
  let saved={};try{saved=JSON.parse(storage?.getItem(STORAGE_KEY)||'{}');}catch{}
  if(!saved||typeof saved!=='object'||Array.isArray(saved))saved={};
  const preferences={language:typeof saved.language==='string'&&/^[a-z0-9-]{2,35}$/i.test(saved.language)?saved.language:win.navigator?.language||'en-US',autoRead:saved.autoRead===true,voiceURI:typeof saved.voiceURI==='string'?saved.voiceURI.slice(0,300):'',allowRemoteVoice:saved.allowRemoteVoice===true,noticeAccepted:saved.noticeAccepted===true,engine:saved.engine==='browser'?'browser':'openrouter',connectionId:typeof saved.connectionId==='string'?saved.connectionId.slice(0,100):'',speechModel:typeof saved.speechModel==='string'?saved.speechModel.slice(0,200):defaultSpeechModel,transcriptionModel:typeof saved.transcriptionModel==='string'?saved.transcriptionModel.slice(0,200):defaultTranscriptionModel,cloudConsent:saved.cloudConsent===true,modelVoices:{}};
  for(const model of [defaultSpeechModel,'google/gemini-3.8-flash-tts','fish-audio/drama-3'])if(typeof saved.modelVoices?.[model]==='string')preferences.modelVoices[model]=saved.modelVoices[model].slice(0,200);
  let state={listening:false,transcribing:false,reading:false,readingKey:null,loadingVoice:false,error:''},recognition=null,dictation=null,recording=null,recognitionGeneration=0,readingGeneration=0,utterance=null,transport=null,player=null,playerUrl=null,readingRequest=null;
  const audioCache=new Map();
  const listeners=new Set(),histories=new Map();
  const emit=patch=>{state={...state,...patch};for(const listener of listeners)listener({...state});};
  const persist=()=>{try{storage?.setItem(STORAGE_KEY,JSON.stringify(preferences));}catch{}};
  const voices=()=>{try{return synthesis?.getVoices?.()||[];}catch{return [];}};
  const available={recognition:!!Recognition&&win.isSecureContext!==false,synthesis:!!synthesis&&!!Utterance,cloudRecognition:!!win.navigator?.mediaDevices?.getUserMedia&&!!win.MediaRecorder&&!!(win.AudioContext||win.webkitAudioContext)&&win.isSecureContext!==false,cloudSynthesis:!!win.Audio&&!!win.URL?.createObjectURL};
  function releasePlayer(){if(player){player.onended=null;player.onerror=null;player.pause();player.removeAttribute?.('src');player.load?.();player=null;}if(playerUrl){win.URL.revokeObjectURL(playerUrl);playerUrl=null;}}
  function stopReading(){readingGeneration++;utterance=null;readingRequest?.abort();readingRequest=null;releasePlayer();try{synthesis?.cancel();}catch{}emit({reading:false,readingKey:null,loadingVoice:false});}
  function releaseRecording(current){if(!current)return;win.clearTimeout(current.timer);current.stream?.getTracks().forEach(track=>track.stop());if(current.context)void Promise.resolve(current.context.close()).catch(()=>{});current.parts=[];}
  function stopDictation({restoreDraft=false,discard=false}={}){
    if(recording&&!restoreDraft&&!discard&&recording.recorder?.state==='recording'){recording.recorder.stop();emit({listening:false,transcribing:true});return;}
    recognitionGeneration++;const current=recognition,record=recording;recognition=null;recording=null;record?.request?.abort();if(record?.recorder?.state==='recording')record.recorder.stop();releaseRecording(record);
    if(restoreDraft&&dictation&&(!dictation.getDraft||String(dictation.getDraft())===dictation.lastValue))dictation.onDraft(dictation.base);dictation=null;try{if(restoreDraft||discard)current?.abort();else current?.stop();}catch{}emit({listening:false,transcribing:false});
  }
  const discardDictation=()=>stopDictation({discard:true});
  function requireCloud(settings){if(!transport)throw new Error('Open Chat options to configure OpenRouter speech.');if(!settings.cloudConsent)throw new Error('Allow OpenRouter speech processing in Chat options first.');if(!settings.connectionId)throw new Error('Choose an OpenRouter connection in Chat options.');}
  async function startRecording({getDraft,onDraft,maxLength=20000}){
    requireCloud(preferences);if(!available.cloudRecognition)throw new Error('AI dictation needs microphone access, audio recording support, and HTTPS or localhost. Try a full Chrome or Safari browser.');
    stopReading();discardDictation();const generation=++recognitionGeneration,settings={...preferences},current={parts:[],size:0,settings};recording=current;dictation={base:String(getDraft?.()||''),lastValue:String(getDraft?.()||''),getDraft,onDraft,maxLength};emit({listening:true,error:''});
    try{
      const stream=await win.navigator.mediaDevices.getUserMedia({audio:true});if(generation!==recognitionGeneration){stream.getTracks().forEach(track=>track.stop());return;}current.stream=stream;
      const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type=>win.MediaRecorder.isTypeSupported?.(type));
      const recorder=new win.MediaRecorder(stream,mime?{mimeType:mime}:undefined);current.recorder=recorder;current.context=new (win.AudioContext||win.webkitAudioContext)();
      recorder.ondataavailable=event=>{if(generation!==recognitionGeneration)return;if(event.data?.size){current.size+=event.data.size;if(current.size>4_000_000){discardDictation();emit({error:'Recording is too large. Try a shorter message.'});return;}current.parts.push(event.data);}};
      recorder.onerror=()=>{if(generation!==recognitionGeneration)return;discardDictation();emit({error:'Microphone recording stopped. Check browser microphone access.'});};
      recorder.onstop=async()=>{
        current.stream.getTracks().forEach(track=>track.stop());win.clearTimeout(current.timer);if(generation!==recognitionGeneration)return;emit({listening:false,transcribing:true});
        try{
          const blob=new win.Blob(current.parts,{type:recorder.mimeType}),decoded=await current.context.decodeAudioData(await blob.arrayBuffer());if(generation!==recognitionGeneration)return;
          const bytes=recordingWav(decoded);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
          current.request=new win.AbortController();const result=await transport.transcribe({connectionId:settings.connectionId,model:settings.transcriptionModel,language:settings.language.split('-')[0].toLowerCase(),audio:win.btoa(binary),consent:settings.cloudConsent},current.request.signal);
          if(generation!==recognitionGeneration||!dictation)return;
          if(dictation.getDraft&&String(dictation.getDraft())!==dictation.lastValue)throw new Error('The draft changed. Dictation was discarded to keep your edits.');
          const text=String(result.text||'').trim();if(!text)throw new Error('No speech was detected. Try again.');const draft=dictation;draft.onDraft((draft.base+(draft.base?'\n':'')+text).slice(0,Math.max(draft.base.length,draft.maxLength)));
          dictation=null;recording=null;releaseRecording(current);emit({transcribing:false});
        }catch(error){if(generation!==recognitionGeneration)return;discardDictation();emit({error:error.name==='NotAllowedError'?'Allow microphone access in your browser and try again.':error.message||'Dictation could not be transcribed. Try a shorter recording.'});}
      };
      recorder.start(1000);current.timer=win.setTimeout(()=>{if(generation===recognitionGeneration)stopDictation();},60000);
    }catch(error){if(generation!==recognitionGeneration)return;discardDictation();emit({error:error.name==='NotAllowedError'?'Allow microphone access in your browser and try again.':error.message||'Voice input could not start.'});}
  }
  function startDictation({getDraft,onDraft,maxLength=100000}={}){
    if(preferences.engine==='openrouter'){if(typeof onDraft!=='function')throw new Error('Open a message draft before starting dictation.');return startRecording({getDraft,onDraft,maxLength});}
    if(!Recognition)throw new Error(recognitionFallback);
    if(win.isSecureContext===false)throw new Error('Browser voice input needs HTTPS or localhost. Open your secure workspace URL, or use your device’s keyboard dictation.');
    if(!preferences.noticeAccepted)throw new Error('Review the browser speech processing notice before starting dictation.');
    if(typeof onDraft!=='function')throw new Error('Open a message draft before starting dictation.');
    stopReading();discardDictation();const generation=++recognitionGeneration,instance=new Recognition();recognition=instance;dictation={base:String(getDraft?.()||''),lastValue:String(getDraft?.()||''),getDraft,onDraft,maxLength};
    instance.lang=preferences.language;instance.continuous=true;instance.interimResults=true;instance.maxAlternatives=1;
    instance.onresult=event=>{if(generation!==recognitionGeneration||!dictation)return;const parts=[];for(let i=0;i<event.results.length;i++){const part=event.results[i]?.[0]?.transcript;if(part)parts.push(part.trim());}const text=parts.join(' '),current=dictation;if(typeof current.getDraft==='function'&&String(current.getDraft())!==current.lastValue){stopDictation();emit({error:'Dictation stopped while you edited the draft.'});return;}const value=(current.base+(current.base&&text?'\n':'')+text).slice(0,Math.max(current.base.length,Number(current.maxLength)||100000));current.lastValue=value;current.onDraft(value);};
    instance.onerror=event=>{if(generation!==recognitionGeneration)return;const message=event.error==='aborted'?'':errorMessages[event.error]||'Voice input stopped. Check microphone access and try again.';stopDictation();emit({error:message});};
    instance.onend=()=>{if(generation!==recognitionGeneration)return;recognition=null;dictation=null;emit({listening:false});};
    try{instance.start();emit({listening:true,error:''});}catch(error){stopDictation();throw new Error(error.name==='NotAllowedError'?errorMessages['not-allowed']:'Voice input could not start. Check microphone access and try again.');}
  }
  async function waitForVoices(){const existing=voices();if(existing.length)return existing;return new Promise(resolve=>{let finished=false,timer;const finish=()=>{if(finished)return;const list=voices();if(!list.length)return;finished=true;win.clearTimeout(timer);synthesis?.removeEventListener?.('voiceschanged',finish);resolve(list);};synthesis?.addEventListener?.('voiceschanged',finish);timer=win.setTimeout(()=>{if(finished)return;finished=true;synthesis?.removeEventListener?.('voiceschanged',finish);resolve(voices());},voiceWaitMs);finish();});}
  async function readCloud(text,settings,key){
    requireCloud(settings);if(!available.cloudSynthesis)throw new Error('AI voice playback is unavailable in this browser.');
    discardDictation();stopReading();const generation=readingGeneration,pending=chunks(text),voice=settings.modelVoices?.[settings.speechModel];if(!voice)throw new Error('Choose a voice for this model in Chat options.');
    readingRequest=new win.AbortController();const signal=readingRequest.signal;let index=0;emit({loadingVoice:true,readingKey:key,error:''});
    const next=async()=>{
      if(generation!==readingGeneration)return false;releasePlayer();if(index>=pending.length){readingRequest=null;emit({loadingVoice:false,reading:false,readingKey:null});return true;}
      const part=pending[index++],cacheKey=JSON.stringify([settings.connectionId,settings.speechModel,voice,part]);let blob=audioCache.get(cacheKey);
      try{
        emit({loadingVoice:true});if(!blob){blob=await transport.synthesize({connectionId:settings.connectionId,model:settings.speechModel,voice,text:part,consent:settings.cloudConsent},signal);if(generation!==readingGeneration)return false;
          if(!blob?.size||!['audio/mpeg','audio/wav'].includes(blob.type))throw new Error('The speech service returned unsupported audio.');audioCache.set(cacheKey,blob);while(audioCache.size>6||[...audioCache.values()].reduce((sum,item)=>sum+item.size,0)>16_000_000)audioCache.delete(audioCache.keys().next().value);
        }
        if(generation!==readingGeneration)return false;playerUrl=win.URL.createObjectURL(blob);const audio=new win.Audio(playerUrl);player=audio;audio.onended=()=>{void next();};audio.onerror=()=>{if(generation!==readingGeneration)return;stopReading();emit({error:'Audio playback failed. Try another voice or browser.'});};
        emit({reading:true,loadingVoice:false});await audio.play();return generation===readingGeneration;
      }catch(error){if(generation!==readingGeneration)return false;stopReading();emit({error:error.name==='NotAllowedError'?'Press Read aloud or Preview to allow audio playback.':error.message||'AI speech could not play.'});return false;}
    };
    return next();
  }
  async function read(value,{key='manual',auto=false,settings}={}){
    const chosen={...preferences,...settings};const text=spokenText(value);if(!text){if(auto)return false;throw new Error('This reply contains only code, tables or visuals. Its content is available in the chat.');}
    if(chosen.engine==='openrouter')return readCloud(text,chosen,key);
    if(!available.synthesis)throw new Error('Read aloud is unavailable in this browser. Use your device’s screen reader or open this workspace in a browser with speech synthesis.');
    discardDictation();stopReading();const generation=readingGeneration;emit({loadingVoice:true,error:''});const list=await waitForVoices();if(generation!==readingGeneration)return false;
    const explicit=preferences.voiceURI?list.find(voice=>voice.voiceURI===preferences.voiceURI):null;
    const local=list.filter(voice=>voice.localService===true),language=preferences.language.toLowerCase();let voice=explicit||local.find(item=>item.lang.toLowerCase()===language)||local.find(item=>item.lang.toLowerCase().split('-')[0]===language.split('-')[0])||local[0];
    if(!voice){emit({loadingVoice:false});throw new Error('No on-device reading voice is available. Choose a voice in Chat options, or use your device’s screen reader.');}
    if(voice.localService!==true&&(!preferences.allowRemoteVoice||voice.voiceURI!==preferences.voiceURI)){emit({loadingVoice:false});throw new Error('This online voice may send reply text to its provider. Choose it explicitly in Chat options and allow online voice processing first.');}
    const pending=chunks(text);let index=0;emit({loadingVoice:false,reading:true,readingKey:key});
    const next=()=>{if(generation!==readingGeneration)return;if(index>=pending.length){utterance=null;emit({reading:false,readingKey:null});return;}utterance=new Utterance(pending[index++]);utterance.voice=voice;utterance.lang=preferences.language||voice.lang;utterance.rate=1;utterance.onend=next;utterance.onerror=event=>{if(generation!==readingGeneration)return;stopReading();if(event.error!=='canceled'&&event.error!=='interrupted')emit({error:'Read aloud stopped. Try another available voice in Chat options.'});};try{synthesis.speak(utterance);return true;}catch{stopReading();emit({error:'Read aloud could not continue. Choose another voice in Chat options.'});return false;}};
    return next()!==false;
  }
  function observeReplies(scope,messages){const entries=messages.filter(message=>message.role==='assistant'&&!message.partial&&(!message.runStatus||message.runStatus==='completed'));if(!histories.has(scope)){histories.set(scope,new Set(entries.map(message=>message.key)));return;}const seen=histories.get(scope),fresh=entries.filter(message=>!seen.has(message.key));for(const message of entries)seen.add(message.key);if(seen.size>600){const recent=[...seen].slice(-400);histories.set(scope,new Set(recent));}if(preferences.autoRead&&(preferences.engine==='openrouter'?available.cloudSynthesis:available.synthesis)&&fresh.length&&!win.document?.hidden){const latest=fresh.at(-1);void read(latest.text,{key:latest.key,auto:true}).catch(error=>emit({error:error.message}));}}
  return {
    available,get state(){return {...state};},get preferences(){return {...preferences,modelVoices:{...preferences.modelVoices}};},
    setTransport(value){transport=value;},
    subscribe(listener){listeners.add(listener);listener({...state});return ()=>listeners.delete(listener);},
    getVoices(){return voices().map(voice=>({uri:voice.voiceURI,name:voice.name,lang:voice.lang,local:voice.localService===true}));},
    onVoicesChanged(listener){synthesis?.addEventListener?.('voiceschanged',listener);return ()=>synthesis?.removeEventListener?.('voiceschanged',listener);},
    setPreferences(update){if(typeof update.language==='string'&&/^[a-z0-9-]{2,35}$/i.test(update.language))preferences.language=update.language;if(typeof update.autoRead==='boolean')preferences.autoRead=update.autoRead;if(typeof update.voiceURI==='string')preferences.voiceURI=update.voiceURI.slice(0,300);if(typeof update.allowRemoteVoice==='boolean')preferences.allowRemoteVoice=update.allowRemoteVoice;
      if(['browser','openrouter'].includes(update.engine))preferences.engine=update.engine;for(const field of ['connectionId','speechModel','transcriptionModel'])if(typeof update[field]==='string')preferences[field]=update[field].slice(0,200);if(typeof update.cloudConsent==='boolean')preferences.cloudConsent=update.cloudConsent;
      if(update.modelVoices&&typeof update.modelVoices==='object')for(const model of [defaultSpeechModel,'google/gemini-3.8-flash-tts','fish-audio/drama-3'])if(typeof update.modelVoices[model]==='string')preferences.modelVoices[model]=update.modelVoices[model].slice(0,200);
      persist();return {...preferences};},
    acceptRecognitionNotice(){preferences.noticeAccepted=true;persist();},clearError(){emit({error:''});},
    startDictation,stopDictation,discardDictation,cancelDictation:()=>stopDictation({restoreDraft:true,discard:true}),stopReading,read,observeReplies,
    cleanup(){discardDictation();stopReading();histories.clear();audioCache.clear();emit({error:''});}
  };
}
export const controller=typeof window==='undefined'?null:createSpeechController(window);
