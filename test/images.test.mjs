import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { Store, HttpError } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { prepareImage } from '../lib/documents.mjs';
import { Providers, anthropicMessages, imageRejected, imagesForModel, knownImageInput, modelImages, responsesInput } from '../lib/providers.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=8000) {const until=Date.now()+timeout;while(Date.now()<until){const result=predicate();if(result)return result;await delay(5);}throw new Error('Fixture timed out waiting for agent state.');}
const current=(store,botId='bot_atlas')=>store.state.runs[botId];
const PIXEL='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XuAAAAAASUVORK5CYII=';
const userWith=request=>request.messages.filter(message=>message.role==='user' && !String(message.content).startsWith('<turn_context>')).at(-1);
async function fixture(t,complete,{imageInput,models}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-images-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'native-provider',type:'openai',name:'Fixture',model:'test-model',secret:store.seal('fixture-private-key'),...(imageInput?{imageInput}:{}),...(models?{models}:{})});for(const bot of state.bots){bot.connectionId='native-provider';bot.tools=['workspace','memory'];bot.collaborators=[];}});
  const engine=new NativeEngine(store,{runTimeout:20_000,providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length,connection);}}});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  const write=async(name,bytes)=>{const root=await getWorkspaceRoot(store,'bot_atlas');await fs.writeFile(path.join(root,name),bytes);return {path:name};};
  return {store,engine,requests,write,directory};
}
const photo=(width,height,options={})=>sharp({create:{width,height,channels:options.alpha?4:3,background:options.alpha?{r:200,g:30,b:30,alpha:0.5}:{r:30,g:120,b:200}}})[options.format || 'png']().toBuffer();

test('catalog declarations, the owner\'s setting and known families decide image input, in that order',()=>{
  assert.deepEqual(modelImages({input_modalities:['text','image']}),{supported:true,source:'provider'});
  assert.deepEqual(modelImages({architecture:{input_modalities:['text']}}),{supported:false,source:'provider'});
  assert.deepEqual(modelImages({capabilities:['completion','vision']}),{supported:true,source:'provider'});
  assert.deepEqual(modelImages({capabilities:{vision:false}}),{supported:false,source:'provider'});
  assert.equal(modelImages({id:'gpt-5'}),null,'silence is unknown, not a no');
  const connection={type:'openai',models:[{id:'declared-no',images:{supported:false,source:'provider'}},{id:'gpt-5-refused',images:{supported:false,source:'provider-error'}},{id:'forged',images:{supported:true,source:'model-said-so'}}]};
  assert.deepEqual(imagesForModel(connection,'declared-no'),{supported:false,source:'provider'});
  assert.deepEqual(imagesForModel(connection,'gpt-5-refused'),{supported:false,source:'provider-error'});
  assert.deepEqual(imagesForModel(connection,'gpt-5.1'),{supported:true,source:'known'});
  assert.deepEqual(imagesForModel(connection,'forged'),{supported:false,source:'unknown'});
  assert.deepEqual(imagesForModel({...connection,imageInput:'on'},'declared-no'),{supported:true,source:'owner'});
  assert.deepEqual(imagesForModel({...connection,imageInput:'off'},'gpt-5.1'),{supported:false,source:'owner'});
  assert.equal(knownImageInput('chatgpt','gpt-6.1-sol'),true);assert.equal(knownImageInput('chatgpt','gpt-5.3-codex-spark'),false);
  assert.equal(knownImageInput('openai','o3-mini'),false);assert.equal(knownImageInput('openai','gpt-4o-audio-preview'),false);
  assert.equal(knownImageInput('openrouter','anthropic/claude-sonnet-5'),true);assert.equal(knownImageInput('ollama','llama3.2'),false);
  assert.equal(imageRejected(new HttpError(502,'OpenAI returned HTTP 400: Invalid content type. image_url is only supported by certain models.')),true);
  assert.equal(imageRejected(new HttpError(502,'Fixture returned HTTP 400: This model does not support image input.')),true);
  assert.equal(imageRejected(new HttpError(502,'Fixture returned HTTP 429: Too many image requests.')),false);
  assert.equal(imageRejected(new HttpError(502,'Fixture returned HTTP 400: Unknown parameter.')),false);
});

test('each protocol carries images as its own image parts, before the text',async()=>{
  const message={role:'user',content:'What is this?',imageParts:[{mediaType:'image/png',data:PIXEL}]};
  assert.deepEqual(responsesInput([message]),[{role:'user',content:[{type:'input_image',image_url:`data:image/png;base64,${PIXEL}`},{type:'input_text',text:'What is this?'}]}]);
  assert.deepEqual(anthropicMessages([message]),[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:PIXEL}},{type:'text',text:'What is this?'}]}]);
  // Assistant messages never carry image parts, even if a field says so.
  assert.deepEqual(responsesInput([{role:'assistant',content:'Done.',imageParts:message.imageParts}]),[{role:'assistant',content:'Done.'}]);
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-image-providers-')),store=await new Store(directory).init();
  try {
    const providers=new Providers(store);let body;
    providers.request=async(connection,route,options)=>{body=options.body;return {status:200,data:{choices:[{message:{content:'A pixel.'},finish_reason:'stop'}]}};};
    await providers.complete({id:'c',type:'openrouter',baseUrl:'https://openrouter.ai/api/v1',defaultModel:'vision'},{messages:[{role:'system',content:'Rules.'},message]});
    assert.deepEqual(body.messages[1],{role:'user',content:[{type:'image_url',image_url:{url:`data:image/png;base64,${PIXEL}`}},{type:'text',text:'What is this?'}]});
    assert.deepEqual(providers.validate({type:'ollama',baseUrl:'http://127.0.0.1:11434/v1',imageInput:'on'},{}).imageInput,'on');
    assert.equal(Object.hasOwn(providers.validate({imageInput:'auto'},{type:'ollama',baseUrl:'http://127.0.0.1:11434/v1',imageInput:'on'}),'imageInput'),false);
    assert.throws(()=>providers.validate({type:'ollama',baseUrl:'http://127.0.0.1:11434/v1',imageInput:'sometimes'},{}),/automatic, on or off/);
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});

test('the worker fits an image for a model: oriented, within 1568px and about 1.15 MP, keeping PNG for screenshots',async t=>{
  const {store,write}=await fixture(t,async()=>({text:'',toolCalls:[]}));
  await write('wide.jpg',await photo(3000,2000,{format:'jpeg'}));
  const wide=await prepareImage(store,'bot_atlas','wide.jpg');
  assert.equal(wide.mediaType,'image/jpeg');assert.ok(Math.max(wide.width,wide.height)<=1568);assert.ok(wide.width*wide.height<=1_150_000);
  assert.ok(Math.abs(wide.width/wide.height-1.5)<0.01);assert.deepEqual([...Buffer.from(wide.data,'base64').subarray(0,3)],[255,216,255]);
  assert.equal(await prepareImage(store,'bot_atlas','wide.jpg'),wide,'an unchanged file is prepared once');
  await write('screen.png',await photo(2880,1800));
  const screen=await prepareImage(store,'bot_atlas','screen.png');assert.equal(screen.mediaType,'image/png');assert.ok(screen.width*screen.height<=1_150_000);
  await write('glass.png',await photo(400,300,{alpha:true}));
  const glass=await prepareImage(store,'bot_atlas','glass.png');assert.equal(glass.mediaType,'image/png');assert.deepEqual([glass.width,glass.height],[400,300]);
  await write('turned.jpg',await sharp({create:{width:400,height:200,channels:3,background:'#336699'}}).jpeg().withMetadata({orientation:6}).toBuffer());
  const turned=await prepareImage(store,'bot_atlas','turned.jpg');assert.deepEqual([turned.width,turned.height],[200,400]);
  await write('fake.png',Buffer.from('not an image'));
  await assert.rejects(prepareImage(store,'bot_atlas','fake.png'),error=>error.status===415);
  await assert.rejects(prepareImage(store,'bot_atlas','wide.jpg',{expectedSize:12}),/changed after it was attached/);
  await assert.rejects(prepareImage(store,'bot_atlas','notes.txt'),error=>error.status===415);
});

test('a model that can see images gets the attached image; history keeps only a reference',async t=>{
  const {engine,store,requests,write}=await fixture(t,async()=>({text:'A blue rectangle.',toolCalls:[],usage:{input_tokens:900,output_tokens:5}}),{imageInput:'on'});
  const file=await write('screen.png',await photo(1200,800));
  assert.equal(engine.capabilities(store.state.bots[0]).documents.imageVision,true);
  await engine.start('bot_atlas','What is in this screenshot?',{attachments:[file]});
  await waitFor(()=>current(store)?.status==='completed');
  const sent=userWith(requests[0]);
  assert.equal(sent.imageParts.length,1);assert.equal(sent.imageParts[0].mediaType,'image/png');assert.ok(sent.imageParts[0].data.length>100);
  assert.match(sent.content,/included with this message for you to see/);assert.equal(sent.images,undefined,'references are not sent to the provider');
  const stored=store.state.conversations.bot_atlas.find(message=>message.role==='user');
  assert.deepEqual(stored.images,[{path:'screen.png',name:'screen.png',format:'png',size:(await fs.stat(path.join(await getWorkspaceRoot(store,'bot_atlas'),'screen.png'))).size}]);
  assert.ok(!JSON.stringify(store.state).includes(sent.imageParts[0].data.slice(0,200)),'image bytes never reach the state file or sync');
  assert.ok(current(store).events.some(event=>event.type==='images.attached' && event.count===1));
  assert.ok(current(store).context.tokens>=1000,'image tokens count toward the working context');
});

test('a model that cannot see images gets the file name and an explicit note, never the image',async t=>{
  const {engine,store,requests,write}=await fixture(t,async()=>({text:'I can only see the file name.',toolCalls:[]}));
  const file=await write('screen.png',await photo(300,200));
  assert.equal(engine.capabilities(store.state.bots[0]).documents.imageVision,false);
  await engine.start('bot_atlas','What is in this screenshot?',{attachments:[file]});
  await waitFor(()=>current(store)?.status==='completed');
  const sent=userWith(requests[0]);
  assert.equal(sent.imageParts,undefined);assert.match(sent.content,/cannot see images, so you have only the image file names/);
  assert.match(sent.content,/\[Not shown to you now: screen\.png\. Your current model cannot see images/);
  assert.match(requests[0].messages[0].content,/Never describe an image you were not shown/);
});

test('only the newest five images in a conversation are shown; older and changed ones get a note',async t=>{
  const {engine,store,requests,write}=await fixture(t,async()=>({text:'Seen.',toolCalls:[]}),{imageInput:'on'});
  const first=[],second=[];
  for(let index=0;index<3;index++)first.push(await write(`a${index}.png`,await photo(40+index,30)));
  for(let index=0;index<3;index++)second.push(await write(`b${index}.png`,await photo(50+index,30)));
  await engine.start('bot_atlas','Look at these.',{attachments:first});await waitFor(()=>current(store)?.status==='completed');
  await engine.start('bot_atlas','And these.',{attachments:second});await waitFor(()=>current(store)?.status==='completed' && requests.length===2);
  const users=requests[1].messages.filter(message=>message.role==='user' && !/^<(turn_context|reference_data)>/.test(String(message.content)));
  assert.equal(users[0].imageParts.length,2);assert.match(users[0].content,/Not shown to you now: a0\.png\. Only the newest images/);
  assert.equal(users[1].imageParts.length,3);
  // A file replaced after it was attached is not shown as if it were the original.
  await write('b2.png',await photo(500,400));
  await engine.start('bot_atlas','Once more.');await waitFor(()=>current(store)?.status==='completed' && requests.length===3);
  const latest=requests[2].messages.filter(message=>message.role==='user' && message.content.includes('And these.'))[0];
  assert.equal(latest.imageParts.length,2);assert.match(latest.content,/Not shown to you now: b2\.png/);
  assert.ok(current(store).events.some(event=>event.type==='images.unavailable' && /b2\.png/.test(event.message)));
});

test('a provider that refuses images gets the step again without them, and the model is remembered as text-only',async t=>{
  const models=[{id:'test-model',name:'Test model',reasoning:{supported:false,efforts:[]}}];
  const {engine,store,requests,write}=await fixture(t,async request=>{
    if(userWith(request).imageParts)throw new HttpError(502,'OpenAI returned HTTP 400: Invalid content type. image_url is only supported by certain models.');
    return {text:'I can only see the file name.',toolCalls:[]};
  },{models});
  await store.mutate(state=>{state.connections[0].models[0].images={supported:true,source:'provider'};});
  const file=await write('screen.png',await photo(300,200));
  await engine.start('bot_atlas','What is this?',{attachments:[file]});
  await waitFor(()=>current(store)?.status==='completed');
  assert.equal(requests.length,2);assert.ok(userWith(requests[0]).imageParts);assert.equal(userWith(requests[1]).imageParts,undefined);
  assert.match(userWith(requests[1]).content,/Your current model cannot see images/);
  assert.ok(current(store).events.some(event=>event.type==='images.refused'));
  assert.deepEqual(store.state.connections[0].models[0].images,{supported:false,source:'provider-error'});
  // The next task does not try again.
  await engine.start('bot_atlas','And now?');await waitFor(()=>current(store)?.status==='completed' && requests.length===3);
  assert.equal(userWith(requests[2]).imageParts,undefined);
});

test('a second image refusal in one task fails it instead of retrying again, and an owner\'s "on" is not overwritten',async t=>{
  const models=[{id:'test-model',name:'Test model',reasoning:{supported:false,efforts:[]}}];
  const {engine,store,requests,write}=await fixture(t,async()=>{throw new HttpError(502,'OpenAI returned HTTP 400: image input is not supported.');},{imageInput:'on',models});
  const file=await write('screen.png',await photo(300,200));
  await engine.start('bot_atlas','What is this?',{attachments:[file]});
  await waitFor(()=>current(store)?.status==='failed');
  assert.equal(requests.length,2);assert.match(current(store).error,/image input is not supported/);
  assert.equal(store.state.connections[0].models[0].images,undefined);
});
