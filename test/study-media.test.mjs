import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import {StudySources} from '../lib/study-sources.mjs';
import {parseStudyWav,chunkStudyWav,STUDY_MEDIA_LIMITS} from '../lib/study-media.mjs';

const upload=(name,bytes)=>({name,contentBase64:Buffer.from(bytes).toString('base64')});
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-study-media-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return {directory,sources:new StudySources(directory)};}
function wav(seconds,{sampleRate=16000,channels=1}={}){const pcm=Buffer.alloc(Math.round(seconds*sampleRate)*channels*2);for(let offset=0;offset<pcm.length;offset+=channels*2){pcm.writeInt16LE(1000,offset);if(channels===2)pcm.writeInt16LE(3000,offset+2);}const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(channels,22);header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*channels*2,28);header.writeUInt16LE(channels*2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);return Buffer.concat([header,pcm]);}
async function visualPdf(){const doc=new PDFDocument({size:[800,1200]}),parts=[],ready=new Promise((resolve,reject)=>{doc.on('data',part=>parts.push(part));doc.on('end',()=>resolve(Buffer.concat(parts)));doc.on('error',reject);});doc.rect(20,20,300,100).fill('black');doc.text('Figure caption with source text.',30,180);doc.end();return ready;}

test('PCM16 WAV normalization yields valid <=60-second mono16k chunks with exact interval lineage',()=>{
  const original=wav(121,{sampleRate:8000,channels:2}),info=parseStudyWav(original),chunks=[...chunkStudyWav(original)];assert.equal(info.durationSeconds,121);assert.equal(chunks.length,3);assert.deepEqual(chunks.map(chunk=>[chunk.startSeconds,chunk.endSeconds]),[[0,60],[60,120],[120,121]]);
  for(const chunk of chunks){const bytes=Buffer.from(chunk.audioBase64,'base64'),parsed=parseStudyWav(bytes);assert.equal(parsed.sampleRate,16000);assert.equal(parsed.channels,1);assert.equal(parsed.bits,16);assert.ok(bytes.length<=1_920_044);assert.equal(bytes.readInt16LE(parsed.dataOffset),2000);assert.equal(parsed.durationSeconds,chunk.endSeconds-chunk.startSeconds);}
  assert.throws(()=>parseStudyWav(Buffer.from('not WAV')),error=>error.status===415);const compressed=Buffer.from(wav(1));compressed.writeUInt16LE(3,20);assert.throws(()=>parseStudyWav(compressed),error=>error.status===415);const damaged=Buffer.from(wav(1));damaged.writeUInt32LE(damaged.length,40);assert.throws(()=>parseStudyWav(damaged),error=>error.status===415);
});

test('uploaded audio uses only the explicit adapter and preserves engine-assigned intervals',async t=>{
  const {directory,sources}=await fixture(t),staged=await sources.stage('audio',[upload('lesson.wav',wav(61))]),seen=[];
  const source=await sources.extract('audio',staged.sources[0].id,{transcribeAudio:async request=>{seen.push(request);assert.equal(request.signal,undefined);return {text:`Bounded transcript for interval ${request.startSeconds}.`};}});assert.equal(source.status,'ready');assert.equal(source.totalUnits,2);assert.equal(source.expectedUnits,2);assert.equal(source.durationSeconds,61);assert.equal(seen.length,2);
  const last=await sources.readSegment('audio',source.id,source.segments[1].id);assert.equal(last.locator.kind,'audio');assert.equal(last.locator.startSeconds,60);assert.equal(last.locator.endSeconds,61);assert.equal(last.provenance.kind,'model-audio-transcription');assert.match(last.text,/interval 60/);const manifest=await fs.readFile(path.join(directory,'study-staging','audio','manifest.json'),'utf8');assert.doesNotMatch(manifest,/Bounded transcript|audioBase64/);
});

test('missing audio adapter and uncertain transcription remain explicitly unavailable or partial',async t=>{
  const {sources}=await fixture(t),staged=await sources.stage('audio_unavailable',[upload('lesson.wav',wav(1))]);const unavailable=await sources.extract('audio_unavailable',staged.sources[0].id);assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.segments.length,0);assert.match(unavailable.warnings[0],/explicitly configured/);
  const other=await sources.stage('audio_uncertain',[upload('lesson.wav',wav(1))]),partial=await sources.extract('audio_uncertain',other.sources[0].id,{transcribeAudio:async()=>({text:'Uncertain number: fifteen or fifty.',uncertain:true})});assert.equal(partial.status,'partial');assert.equal(partial.segments[0].provenance.uncertain,true);
});

test('optional image interpretation receives only fitted inert bytes and retains honest provenance',async t=>{
  const {directory,sources}=await fixture(t),png=await sharp({create:{width:3000,height:2000,channels:3,background:'#ffffff'}}).png().toBuffer(),staged=await sources.stage('visual_image',[upload('page.png',png)]);let received;
  const source=await sources.extract('visual_image',staged.sources[0].id,{visualReader:async request=>{received=request;const meta=await sharp(Buffer.from(request.data,'base64')).metadata();assert.ok(meta.width<=1568&&meta.height<=1568&&meta.width*meta.height<=STUDY_MEDIA_LIMITS.imagePixels);assert.equal(request.locator.kind,'image');return {text:'Readable visual statement with its exception.',uncertain:false};}});assert.equal(source.status,'ready');assert.equal(received.mediaType,'image/png');assert.ok(received.bytes<=STUDY_MEDIA_LIMITS.imageBytes);const read=await sources.readSegment('visual_image',source.id,source.segments[0].id);assert.equal(read.provenance.kind,'model-visual-interpretation');assert.match(read.text,/Model visual interpretation/);assert.ok(read.warnings.some(warning=>warning.includes('model interpretations')));assert.doesNotMatch(await fs.readFile(path.join(directory,'study-staging','visual_image','manifest.json'),'utf8'),/Readable visual statement|data:image/);
});

test('PDF visual pages render to bounded PNG in the isolated worker before optional interpretation',async t=>{
  const {sources}=await fixture(t),staged=await sources.stage('visual_pdf',[upload('diagram.pdf',await visualPdf())]);let calls=0;
  const source=await sources.extract('visual_pdf',staged.sources[0].id,{visualReader:async request=>{calls++;assert.equal(request.locator.page,1);assert.match(request.text,/Figure caption/);const image=Buffer.from(request.data,'base64'),meta=await sharp(image).metadata();assert.equal(meta.format,'png');assert.ok(meta.width*meta.height<=STUDY_MEDIA_LIMITS.imagePixels);return {text:'The black rectangle illustrates a bounded region.',uncertain:false};}});assert.equal(calls,1,source.segments[0]?.warnings.join(' '));assert.equal(source.status,'ready');assert.equal(source.segments[0].locator.page,1);const read=await sources.readSegment('visual_pdf',source.id,source.segments[0].id);assert.match(read.text,/Figure caption/);assert.match(read.text,/black rectangle/);assert.equal(read.provenance.includesExtractedText,true);
});

test('Stop after a transcribed interval preserves verified media receipts and avoids repeating that adapter call',async t=>{
  const {sources}=await fixture(t),staged=await sources.stage('audio_stop',[upload('lesson.wav',wav(61))]),controller=new AbortController(),seen=[];
  const adapter=async request=>{seen.push(request.startSeconds);return {text:`Verified transcript interval ${request.startSeconds}.`};};
  await assert.rejects(sources.extract('audio_stop',staged.sources[0].id,{signal:controller.signal,transcribeAudio:adapter,onProgress:()=>controller.abort(new Error('Stop after first receipt.'))}));assert.deepEqual(seen,[0]);assert.equal((await sources.inspect('audio_stop')).sources[0].status,'interrupted');
  const completed=await sources.extract('audio_stop',staged.sources[0].id,{transcribeAudio:adapter});assert.equal(completed.status,'ready');assert.deepEqual(seen,[0,60]);assert.equal(completed.totalUnits,2);
});

test('adapter failures do not expose error details or manufacture supported media text',async t=>{
  const {sources}=await fixture(t),staged=await sources.stage('adapter_fail',[upload('lesson.wav',wav(1))]),source=await sources.extract('adapter_fail',staged.sources[0].id,{transcribeAudio:async()=>{throw new Error('synthetic-secret-that-must-not-enter-receipts');}});assert.equal(source.status,'partial');assert.equal(source.segments[0].status,'failed');assert.doesNotMatch(JSON.stringify(source),/synthetic-secret/);assert.equal((await sources.readSegment('adapter_fail',source.id,source.segments[0].id)).text,'');
});
