import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStudioServer } from '../server.mjs';
import { Speech, SPEECH_MODELS, TRANSCRIPTION_MODELS, FISH_VOICES } from '../lib/speech.mjs';
import { recordingWav } from '../public/speech.mjs';

const SECRET='speech-fixture-key-not-for-output';
const audio=()=>Buffer.from(recordingWav({length:1600,sampleRate:16000,numberOfChannels:1,getChannelData:()=>new Float32Array(1600)}));
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
async function fixture(t){
  const calls=[];let mode='ok';
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const input=raw?JSON.parse(raw):null;calls.push({url:req.url,input,authorization:req.headers.authorization});
    if(req.url.includes('/models?'))return json(res,{data:req.url.includes('=speech')?[...SPEECH_MODELS.map((id,index)=>({id,name:['Eleven v4 Turbo','Gemini 3.8 Flash TTS','Fish Drama 3'][index],supported_voices:[`voice-${index}-a`,`voice-${index}-b`],pricing:{prompt:'0.00004',completion:'0'}})),{id:'unrequested/expensive-model',supported_voices:['no']}]:TRANSCRIPTION_MODELS.map(id=>({id,name:id}))});
    if(mode==='error')return json(res,{error:{message:`Upstream key rejected ${SECRET}`}},401);
    if(req.url.endsWith('/audio/transcriptions'))return json(res,{text:'A fixture transcript.'});
    if(mode==='slow'){req.socket.once('close',()=>{});res.writeHead(200,{'Content-Type':'audio/mpeg'});res.write('ID3');return;}
    if(mode==='html'){res.writeHead(200,{'Content-Type':'text/html'});return res.end('<script>bad()</script>');}
    if(mode==='redirect'){res.writeHead(302,{Location:'/should-never-follow'});return res.end();}
    if(mode==='large'){res.writeHead(200,{'Content-Type':'audio/mpeg'});return res.end(Buffer.alloc(8_000_001));}
    if(input.model.startsWith('google/')){res.writeHead(200,{'Content-Type':'audio/pcm'});return res.end(Buffer.alloc(480));}
    res.writeHead(200,{'Content-Type':'audio/mpeg'});res.end(Buffer.from('ID3fixture-audio'));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${upstream.address().port}/api/v1`,directory=await fs.mkdtemp(path.join(tmpdir(),'studio-speech-'));
  const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,speechTestBaseUrl:base,speechTimeoutMs:2000});const {url}=await app.listen(0);
  await app.store.mutate(state=>state.connections.push({id:'speech_fixture',name:'OpenRouter fixture',type:'openrouter',baseUrl:base,secret:app.store.seal(SECRET)}));
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'speech-fixture-password'})}),auth=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  const request=(route,{body,authenticated=true,csrf=true,headers={},signal}={})=>fetch(url+route,{method:body?'POST':'GET',headers:{...(authenticated?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':auth.csrf}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{}),signal});
  const speech=new Speech(app.store,{speechTestBaseUrl:base,speechTimeoutMs:2000});
  t.after(async()=>{speech.close();upstream.closeAllConnections();await app.close();await new Promise(resolve=>upstream.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  return {app,speech,calls,request,setMode:value=>mode=value,base};
}
const speechInput=(overrides={})=>({connectionId:'speech_fixture',model:SPEECH_MODELS[0],voice:'voice-0-a',text:'Hello from a public sample.',consent:true,...overrides});

test('speech catalog authenticates, discovers exact model voices, caches, and never exposes sealed credentials',async t=>{
  const f=await fixture(t),route='/api/speech/catalog?connectionId=speech_fixture';assert.equal((await f.request(route,{authenticated:false})).status,401);
  const response=await f.request(route),catalog=await response.json();assert.equal(response.status,200);assert.deepEqual(catalog.speech.map(item=>item.id),SPEECH_MODELS);assert.equal(catalog.transcription[0].id,'elevenlabs/scribe-v2');assert.equal(catalog.speech[0].voices[0],'voice-0-a');assert.ok(!JSON.stringify(catalog).includes(SECRET));assert.ok(!JSON.stringify(catalog).includes('secret'));
  await f.request(route);assert.equal(f.calls.length,2);await f.request(route+'&refresh=true');assert.equal(f.calls.length,4);assert.ok(f.calls.every(call=>call.authorization===`Bearer ${SECRET}`));
  assert.ok(!(await fs.readFile(f.app.store.file,'utf8')).includes(SECRET));
});
test('synthesis requires authentication, CSRF, consent, exact advertised models and voices, and safe destinations',async t=>{
  const f=await fixture(t),route='/api/speech/synthesize';
  for(const [body,options,status] of [[speechInput(),{authenticated:false},401],[speechInput(),{csrf:false},403],[speechInput({consent:false}),{},400],[speechInput({model:'other/model'}),{},400],[speechInput({voice:'voice-1-a'}),{},400],[speechInput({text:'x'.repeat(2001)}),{},400]])assert.equal((await f.request(route,{body,...options})).status,status);
  assert.equal(f.calls.filter(call=>call.input).length,0);
  await f.app.store.mutate(state=>state.connections[0].baseUrl='https://example.com/api/v1');assert.equal((await f.request(route,{body:speechInput()})).status,400);assert.equal(f.calls.filter(call=>call.input).length,0);
});
test('all three speech models use the right formats and Gemini PCM is returned as playable WAV',async t=>{
  const f=await fixture(t);
  for(let index=0;index<3;index++){
    const response=await f.request('/api/speech/synthesize',{body:speechInput({model:SPEECH_MODELS[index],voice:`voice-${index}-a`})}),bytes=Buffer.from(await response.arrayBuffer());assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),index===1?'audio/wav':'audio/mpeg');assert.equal(bytes.toString('ascii',0,3),index===1?'RIF':'ID3');
    const sent=f.calls.at(-1).input;assert.equal(sent.response_format,index===1?'pcm':'mp3');assert.equal(sent.voice,`voice-${index}-a`);assert.equal(sent.input,'Hello from a public sample.');assert.equal(sent.consent,undefined);
    if(index===1){assert.equal(bytes.readUInt32LE(24),24000);assert.equal(bytes.readUInt32LE(40),480);}
    assert.match(response.headers.get('content-security-policy'),/media-src 'self' blob:/);assert.equal(response.headers.get('cache-control'),'no-store');
  }
});
test('speech transport rejects HTML, redirects, oversized audio, and redacts upstream credential errors',async t=>{
  const f=await fixture(t);
  for(const mode of ['html','redirect','large','error']){f.setMode(mode);const response=await f.request('/api/speech/synthesize',{body:speechInput()}),result=await response.json();assert.equal(response.status,502);assert.ok(!JSON.stringify(result).includes(SECRET));}
  assert.ok(!f.calls.some(call=>call.url==='/should-never-follow'));
});
test('dictation accepts bounded real PCM WAV and returns only text without persisting audio or transcripts',async t=>{
  const f=await fixture(t),before=JSON.stringify(f.app.store.state.messages),recording=audio().toString('base64'),body={connectionId:'speech_fixture',model:TRANSCRIPTION_MODELS[0],audio:recording,language:'en',consent:true};
  const response=await f.request('/api/speech/transcribe',{body}),result=await response.json();assert.equal(response.status,200);assert.deepEqual(result,{text:'A fixture transcript.'});assert.equal(f.calls.at(-1).input.input_audio.format,'wav');assert.equal(f.calls.at(-1).input.input_audio.data,recording);assert.equal(JSON.stringify(f.app.store.state.messages),before);
  const disk=await fs.readFile(f.app.store.file,'utf8');assert.ok(!disk.includes(recording));assert.ok(!disk.includes(result.text));
  for(const patch of [{audio:Buffer.from('not audio').toString('base64')},{audio:'%%%=='},{model:'unlisted/model'},{language:'en-US'},{consent:false}])assert.equal((await f.request('/api/speech/transcribe',{body:{...body,...patch}})).status,400);
  const long=Buffer.from(recordingWav({length:960000,sampleRate:16000,numberOfChannels:1,getChannelData:()=>new Float32Array(960000)}));assert.equal((await f.request('/api/speech/transcribe',{body:{...body,audio:long.toString('base64')}})).status,200);
});
test('speech cancellation aborts the credentialed HTTP request and releases concurrency slots',async t=>{
  const f=await fixture(t);await f.speech.catalog('speech_fixture');f.setMode('slow');const controller=new AbortController(),pending=f.speech.synthesize(speechInput(),{signal:controller.signal});
  while(!f.calls.some(call=>call.input))await new Promise(resolve=>setTimeout(resolve,5));controller.abort(new Error('Stopped by the user.'));await assert.rejects(pending,/Stopped by the user/);assert.equal(f.speech.active.size,0);
});
test('Fish remains selectable when the live catalog omits voices, using verified provider presets',async t=>{
  const f=await fixture(t),speech=new Speech(f.app.store,{speechTestBaseUrl:f.base});t.after(()=>speech.close());
  const request=speech.request.bind(speech);speech.request=async(connection,route,options)=>{const result=await request(connection,route,options);if(route.includes('=speech'))delete result.data.data.find(item=>item.id==='fish-audio/drama-3').supported_voices;return result;};
  const catalog=await speech.catalog('speech_fixture'),fish=catalog.speech.find(item=>item.id==='fish-audio/drama-3');assert.deepEqual(fish.voices,Object.keys(FISH_VOICES));assert.equal(fish.voiceLabels[fish.voices[0]],'Ethan');await speech.synthesize(speechInput({model:fish.id,voice:fish.voices[0]}));assert.equal(f.calls.at(-1).input.voice,fish.voices[0]);
});
