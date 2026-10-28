import { HttpError, ensure } from './store.mjs';
import { serviceRequest, requireSuccess } from './provider-net.mjs';

const BASE='https://openrouter.ai/api/v1';
export const SPEECH_MODELS=['elevenlabs/eleven-v4-turbo','google/gemini-3.8-flash-tts','fish-audio/drama-3'];
export const TRANSCRIPTION_MODELS=['elevenlabs/scribe-v2','openai/gpt-transcribe','openai/whisper-large-v3-turbo'];
// OpenRouter currently omits Fish supported_voices. These public, trained provider
// presets were verified at api.fish.audio/model/<id> on 2026-10-26; no extra runtime request.
export const FISH_VOICES={'536d3a5e000945adb7038665781a4aca':'Ethan','c70cfb98867a4bfb9ae20d2401257b92':'Delia','bf322df2096a46f18c579d0baa36f41d':'Adrian'};
export const MAX_AUDIO_BYTES=1_920_044; // 60 seconds, mono PCM16 at 16 kHz, plus WAV header.
const safeText=(value,max)=>typeof value==='string'&&!/[\x00-\x1f\x7f]/.test(value)&&value.length<=max?value:'';
function catalogModel(item,ids){
  if(!ids.includes(item?.id))return null;
  let voices=Array.isArray(item.supported_voices)?[...new Set(item.supported_voices.map(value=>safeText(value,200)).filter(Boolean))].slice(0,300):[];
  if(item.id==='fish-audio/drama-3'&&!voices.length)voices=Object.keys(FISH_VOICES);
  const pricing={};for(const field of ['prompt','completion'])if(typeof item.pricing?.[field]==='string'&&/^\d+(?:\.\d+)?$/.test(item.pricing[field])&&Number(item.pricing[field])<=1)pricing[field]=item.pricing[field];
  return {id:item.id,name:safeText(item.name,200)||item.id,voices,voiceLabels:item.id==='fish-audio/drama-3'?FISH_VOICES:{},pricing};
}
function wav(pcm,sampleRate=24000){
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);return Buffer.concat([header,pcm]);
}
function recording(value){
  ensure(typeof value==='string'&&value.length<=Math.ceil(MAX_AUDIO_BYTES/3)*4&&value.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(value),400,'Record up to 60 seconds of audio.');
  const bytes=Buffer.from(value,'base64');
  ensure(bytes.length>=46&&bytes.length<=MAX_AUDIO_BYTES&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,16)==='WAVEfmt '&&bytes.readUInt32LE(16)===16&&bytes.readUInt16LE(20)===1&&bytes.readUInt16LE(22)===1&&bytes.readUInt32LE(24)===16000&&bytes.readUInt32LE(28)===32000&&bytes.readUInt16LE(32)===2&&bytes.readUInt16LE(34)===16&&bytes.toString('ascii',36,40)==='data'&&bytes.readUInt32LE(40)===bytes.length-44&&bytes.readUInt32LE(4)===bytes.length-8&&(bytes.length-44)%2===0,400,'Use a mono 16 kHz PCM WAV recording of at most 60 seconds.');
  return bytes;
}

/** Speech is a user-initiated presentation service, separate from the agent/tool loop. */
export class Speech {
  constructor(store,options={}){this.store=store;this.options=options;this.cache=new Map();this.active=new Set();this.closed=false;}
  connection(id){
    const connection=this.store.state.connections.find(item=>item.id===id);
    ensure(connection?.type==='openrouter'&&connection.secret,409,'Choose an OpenRouter connection with an API key in Chat options.');
    const base=(connection.baseUrl||BASE).replace(/\/+$/,'');
    const testBase=this.options.speechTestBaseUrl;
    ensure(base===BASE||(testBase&&base===testBase&&/^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/.test(testBase)),400,'Speech credentials can only be sent to the official OpenRouter API.');
    return {...connection,baseUrl:base};
  }
  async request(connection,path,{body,signal,responseType='json',maxBytes=4_000_000}={}){
    ensure(!this.closed,503,'Speech service is closing.');
    // The sealed connection is snapshotted before awaiting; a changed connection cannot retarget its key.
    try{return requireSuccess(await serviceRequest(connection.baseUrl+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${this.store.unseal(connection.secret)}`,Accept:responseType==='bytes'?'audio/mpeg, audio/pcm, audio/wav':'application/json',...(body?{'Content-Type':'application/json'}:{})},body,signal,responseType,maxBytes,timeoutMs:this.options.speechTimeoutMs||60_000}),'OpenRouter speech');}
    catch(error){if(signal?.aborted)throw signal.reason||error;throw new HttpError([401,403].includes(error.status)?502:error.status||502,this.store.redact(error instanceof HttpError?error.message:'OpenRouter speech could not connect. Check the connection and try again.'));}
  }
  async catalog(connectionId,{signal,refresh=false}={}){
    const connection=this.connection(connectionId),entry=this.cache.get(connectionId);
    if(!refresh&&entry&&entry.secret===connection.secret&&entry.base===connection.baseUrl&&entry.expires>Date.now())return entry.value;
    const speech=await this.request(connection,'/models?output_modalities=speech',{signal});
    const transcription=await this.request(connection,'/models?output_modalities=transcription',{signal});
    ensure(Array.isArray(speech.data?.data)&&Array.isArray(transcription.data?.data),502,'OpenRouter returned an invalid speech catalog.');
    const collect=(items,ids)=>ids.map(id=>items.find(item=>item?.id===id)).map(item=>catalogModel(item,ids)).filter(Boolean);
    const value=this.store.redactValue({connectionId,speech:collect(speech.data.data,SPEECH_MODELS),transcription:collect(transcription.data.data,TRANSCRIPTION_MODELS)});
    this.cache.set(connectionId,{secret:connection.secret,base:connection.baseUrl,expires:Date.now()+300_000,value});return value;
  }
  async perform(input,{signal}={},operation){
    ensure(input.consent===true,400,'Allow OpenRouter speech processing in Chat options first.');
    ensure(this.active.size<2,429,'Two speech requests are already active. Stop playback or wait for transcription.');
    const connection=this.connection(input.connectionId),controller=new AbortController(),abort=()=>controller.abort(signal.reason||new Error('Speech cancelled.'));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();this.active.add(controller);
    try{return await operation(connection,controller.signal);}finally{this.active.delete(controller);signal?.removeEventListener('abort',abort);}
  }
  async synthesize(input,options={}){
    return this.perform(input,options,async(connection,signal)=>{
      ensure(typeof input.text==='string'&&input.text.trim()&&input.text.length<=2000,400,'Read at most 2000 characters in one speech request.');
      const catalog=await this.catalog(connection.id,{signal}),model=catalog.speech.find(item=>item.id===input.model);
      ensure(this.connection(connection.id).secret===connection.secret,409,'The OpenRouter connection changed. Refresh models before generating speech.');
      ensure(model,400,'Choose an available speech model from Chat options.');ensure(model.voices.includes(input.voice),400,'Choose a voice advertised for this speech model.');
      const pcm=input.model.startsWith('google/'),result=await this.request(connection,'/audio/speech',{signal,responseType:'bytes',maxBytes:8_000_000,body:{model:input.model,input:input.text,voice:input.voice,response_format:pcm?'pcm':'mp3'}});
      const type=String(result.headers['content-type']||'').split(';')[0].trim().toLowerCase(),bytes=result.bytes;
      ensure(bytes?.length,502,'The speech provider returned empty audio.');
      if(pcm&&['audio/pcm','audio/l16','application/octet-stream'].includes(type)){ensure(bytes.length%2===0,502,'The speech provider returned invalid PCM audio.');return {bytes:wav(bytes),contentType:'audio/wav'};}
      if(type==='audio/wav'||type==='audio/x-wav'){ensure(bytes.length>=44&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE',502,'The speech provider returned invalid WAV audio.');return {bytes,contentType:'audio/wav'};}
      ensure(['audio/mpeg','audio/mp3'].includes(type)&&(bytes.toString('ascii',0,3)==='ID3'||bytes.length>2&&bytes[0]===255&&(bytes[1]&224)===224),502,'The speech provider returned an unsupported audio response.');return {bytes,contentType:'audio/mpeg'};
    });
  }
  async transcribe(input,options={}){
    return this.perform(input,options,async(connection,signal)=>{
      const bytes=recording(input.audio),catalog=await this.catalog(connection.id,{signal});
      ensure(this.connection(connection.id).secret===connection.secret,409,'The OpenRouter connection changed. Refresh models before dictating.');
      ensure(catalog.transcription.some(item=>item.id===input.model),400,'Choose an available dictation model from Chat options.');
      ensure(input.language===undefined||typeof input.language==='string'&&/^[a-z]{2,3}$/.test(input.language),400,'Choose a valid speech language.');
      const result=await this.request(connection,'/audio/transcriptions',{signal,maxBytes:128_000,body:{model:input.model,input_audio:{data:bytes.toString('base64'),format:'wav'},...(input.language?{language:input.language}:{})}});
      ensure(typeof result.data?.text==='string'&&result.data.text.length<=20000,502,'The speech provider returned an invalid transcript.');
      return {text:result.data.text};
    });
  }
  close(){this.closed=true;for(const controller of this.active)controller.abort(new Error('Speech service closed.'));this.cache.clear();}
}
