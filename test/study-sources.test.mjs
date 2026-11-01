import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph } from 'docx';
import { StudySources, STUDY_SOURCE_LIMITS, parseStudyTranscript } from '../lib/study-sources.mjs';
import { FileReplica } from '../lib/sync/files.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const upload=(name,content)=>({name,contentBase64:Buffer.from(content).toString('base64')});
async function fixture(t,options){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-study-sources-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return {directory,sources:new StudySources(directory,options)};}
async function pdf(pages){const doc=new PDFDocument({autoFirstPage:false}),parts=[];const ready=new Promise((resolve,reject)=>{doc.on('data',part=>parts.push(part));doc.on('end',()=>resolve(Buffer.concat(parts)));doc.on('error',reject);});for(let page=1;page<=pages;page++){doc.addPage();doc.text(`Source page ${page}. Preserve this numbered evidence.`);}doc.end();return ready;}

test('study staging stays local, stores exact identities, paged segments and compact manifests',async t=>{
  const {directory,sources}=await fixture(t),text=`# SEO topic\n\n${'Retain applicability and exceptions. '.repeat(260)}`;
  const staged=await sources.stage('study_one',[upload('reference.md',text)]),source=staged.sources[0];
  assert.equal(source.sha256,sha(text));assert.equal(source.status,'staged');assert.equal(source.identityKind,'file');
  const extracted=await sources.extract('study_one',source.id);assert.equal(extracted.status,'ready');assert.ok(extracted.segments.length>1);assert.equal(extracted.coverage.characters,text.length);
  let joined='';for(const unit of extracted.segments){assert.equal(unit.text,undefined);const read=await sources.readSegment('study_one',source.id,unit.id);assert.ok(read.text.length<=4000);assert.equal(sha(read.text),read.sha256);joined+=read.text;}
  assert.equal(joined,text);assert.doesNotMatch(await fs.readFile(path.join(directory,'study-staging','study_one','manifest.json'),'utf8'),/Retain applicability/);
  assert.equal((await fs.stat(path.join(directory,'study-staging','study_one'))).mode&0o777,0o700);
  assert.deepEqual((await sources.stage('study_one',[upload('reference.md',text)])).sources.map(item=>item.id),[source.id]);
  await assert.rejects(sources.stage('study_one',[upload('reference.md','Different bytes')]),/different admitted/);
  // The source namespace is not one of the file-sync roots.
  const sync=new FileReplica(directory);assert.ok(![...await sync.scan()].some(([key])=>key.includes('study-staging')));
});

test('source limits and path/symlink/hard-link refusals leave owner files untouched',async t=>{
  const {directory,sources}=await fixture(t,{limits:{sourceBytes:100}}),workspace=path.join(directory,'workspaces','bot_one');await fs.mkdir(workspace,{recursive:true});
  await fs.writeFile(path.join(workspace,'original.txt'),'owner data');
  for(const jobId of ['../escape','a/b',''])await assert.rejects(sources.stage(jobId,[upload('ok.txt','x')]));
  await assert.rejects(sources.stage('bad',[upload('../bad.txt','x')]));await assert.rejects(sources.stage('big',[upload('big.txt','x'.repeat(101))]),/source limit|byte limit/);
  await assert.rejects(sources.stage('base64',[{name:'x.txt',contentBase64:'eA'}]),/canonical/);
  await assert.rejects(sources.stage('outside',[{workspacePath:'../outside.txt'}],{workspaceRoot:workspace}),/paths/);
  await fs.symlink('original.txt',path.join(workspace,'alias.txt'));await assert.rejects(sources.stage('alias',[{workspacePath:'alias.txt'}],{workspaceRoot:workspace}),/symbolic/);
  await fs.link(path.join(workspace,'original.txt'),path.join(workspace,'hard.txt'));await assert.rejects(sources.stage('hard',[{workspacePath:'hard.txt'}],{workspaceRoot:workspace}),/invalid/);await fs.unlink(path.join(workspace,'hard.txt'));
  const staged=await sources.stage('copy',[{workspacePath:'original.txt'}],{workspaceRoot:workspace});await sources.cleanup('copy',{expectedManifestSha256:staged.manifestSha256});assert.equal(await fs.readFile(path.join(workspace,'original.txt'),'utf8'),'owner data');
  await assert.rejects(sources.stage('url',[{url:'https://127.0.0.1/watch?v=abcdefghijk'}]),/Private|reserved/);
});

test('transcript parsing retains actual cue times and explicitly accounts malformed cues',async t=>{
  const {sources}=await fixture(t),text='WEBVTT\n\n00:01.000 --> 00:03.500\nKeep the exception.\n\n00:05.000 --> 00:06.000\nSecond cue.\n\nbad --> 00:08.000\nNot trustworthy.';
  const staged=await sources.stage('transcript',[upload('talk.vtt',text)]),source=await sources.extract('transcript',staged.sources[0].id);assert.equal(source.status,'partial');assert.equal(source.totalUnits,3);assert.equal(source.coverage.failed,1);
  const first=await sources.readSegment('transcript',source.id,source.segments[0].id);assert.equal(first.text,'Keep the exception.');assert.equal(first.locator.startSeconds,1);assert.equal(first.locator.endSeconds,3.5);
  assert.equal(parseStudyTranscript('1\n00:00:01,000 --> 00:00:02,000\nHello')[0].locator.startSeconds,1);
});

test('transcript markup parsing preserves unterminated angle runs without regex backtracking',()=>{
  const hostile='<'.repeat(100_000),parsed=parseStudyTranscript(`1\n00:00:01,000 --> 00:00:02,000\n${hostile}`);assert.equal(parsed.length,1);assert.equal(parsed[0].text,hostile);assert.equal(parseStudyTranscript('1\n00:00:01,000 --> 00:00:02,000\n<b>Supported &amp; bounded</b>')[0].text,'Supported & bounded');
});

test('PDF books above the ordinary preview page cap retain late-page evidence',async t=>{
  const {sources}=await fixture(t),staged=await sources.stage('book',[upload('book.pdf',await pdf(105))]),source=await sources.extract('book',staged.sources[0].id);
  assert.equal(source.status,'ready');assert.equal(source.totalUnits,105);assert.equal(source.expectedUnits,105);const late=source.segments.find(unit=>unit.locator.page===105);assert.ok(late);assert.match((await sources.readSegment('book',source.id,late.id)).text,/Source page 105/);
});

test('DOCX source extraction runs in a bounded worker and preserves late paragraphs',async t=>{
  const {sources}=await fixture(t),document=new Document({sections:[{children:[new Paragraph('Domain knowledge'),new Paragraph('A condition near the end must be preserved.')]}]}),bytes=await Packer.toBuffer(document),staged=await sources.stage('word',[upload('book.docx',bytes)]),source=await sources.extract('word',staged.sources[0].id);assert.equal(source.status,'ready');assert.match((await sources.readSegment('word',source.id,source.segments[0].id)).text,/condition near the end/);
});

test('PDF drawing-only pages remain explicitly unavailable and mixed visual pages partial',async t=>{
  const {sources}=await fixture(t),doc=new PDFDocument({autoFirstPage:false}),parts=[],ready=new Promise(resolve=>{doc.on('data',part=>parts.push(part));doc.on('end',()=>resolve(Buffer.concat(parts)));});
  doc.addPage();doc.rect(30,30,50,50).fill('black');doc.addPage();doc.text('Diagram caption.');doc.rect(30,100,50,50).stroke();doc.end();
  const staged=await sources.stage('visual',[upload('visual.pdf',await ready)]),source=await sources.extract('visual',staged.sources[0].id);assert.equal(source.status,'partial');assert.equal(source.totalUnits,2);assert.equal(source.segments[0].status,'unavailable');assert.equal(source.segments[1].status,'partial');assert.ok(source.segments[1].warnings.some(value=>/vector drawings|visual coverage/.test(value)));
});

test('unsupported image OCR and inaccessible video captions produce honest unavailable results',async t=>{
  const {sources}=await fixture(t,{publicFetch:async()=>({status:200,text:'<html>No caption track</html>'})}),staged=await sources.stage('unsupported',[upload('scan.png','unparsed image bytes'),{url:'https://youtu.be/abcdefghijk'}]);
  for(const item of staged.sources){const source=await sources.extract('unsupported',item.id);assert.equal(source.status,'unavailable');assert.equal(source.segments.length,0);assert.ok(source.warnings.length);}
});

test('public YouTube caption extraction uses fixed safe destinations, actual timings and content digest',async t=>{
  const requests=[],caption=JSON.stringify({events:[{tStartMs:1200,dDurationMs:2300,segs:[{utf8:'Supported caption evidence.'}]}]}),fetcher=async(url,options)=>{requests.push({url,options});return url.includes('/api/timedtext')?{status:200,text:caption}:{status:200,text:`<script>var ytInitialPlayerResponse = ${JSON.stringify({captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:'https://www.youtube.com/api/timedtext?v=abcdefghijk',languageCode:'en'}]}}})};</script>`};};
  const {sources}=await fixture(t,{publicFetch:fetcher}),staged=await sources.stage('video',[{url:'https://www.youtube.com/watch?v=abcdefghijk'}]),source=await sources.extract('video',staged.sources[0].id);
  assert.equal(source.status,'partial');assert.equal(source.identityKind,'url');assert.equal(source.extractedSha256,sha(caption));assert.equal(requests.length,2);assert.equal(requests[1].options.maxRedirects,0);const read=await sources.readSegment('video',source.id,source.segments[0].id);assert.equal(read.locator.startSeconds,1.2);assert.equal(read.locator.endSeconds,3.5);assert.equal(read.text,'Supported caption evidence.');
});

test('staging tamper, unexpected entries and stale cleanup identities fail closed',async t=>{
  const {directory,sources}=await fixture(t),staged=await sources.stage('guard',[upload('source.txt','Original source')]),source=await sources.extract('guard',staged.sources[0].id),folder=path.join(directory,'study-staging','guard');
  await assert.rejects(sources.cleanup('guard',{expectedManifestSha256:staged.manifestSha256}),/changed/);
  await fs.writeFile(path.join(folder,`${source.id}-0.segment`),'Tampered');await assert.rejects(sources.readSegment('guard',source.id,source.segments[0].id),/identity/);
  await fs.writeFile(path.join(folder,'owner-file.txt'),'Do not remove');await assert.rejects(sources.cleanup('guard'),/unexpected/);assert.equal(await fs.readFile(path.join(folder,'owner-file.txt'),'utf8'),'Do not remove');
});

test('Stop retains bounded verified segment receipts and deterministic extraction recovery',async t=>{
  const {sources}=await fixture(t),staged=await sources.stage('stop',[upload('source.txt','Long source. '.repeat(800))]),controller=new AbortController();
  await assert.rejects(sources.extract('stop',staged.sources[0].id,{signal:controller.signal,onProgress:()=>controller.abort(new Error('Explicit Stop'))}));
  const partial=(await sources.inspect('stop')).sources[0];assert.equal(partial.status,'interrupted');assert.ok(partial.segments.length>1);
  const resumed=await sources.extract('stop',partial.id);assert.equal(resumed.status,'ready');assert.equal(new Set(resumed.segments.map(item=>item.id)).size,resumed.segments.length);assert.ok(resumed.segments.length<=STUDY_SOURCE_LIMITS.segments);
});

test('a source worker deadline fails honestly and drains the killed worker before returning',async t=>{
  const {sources}=await fixture(t,{limits:{workerTimeoutMs:1}}),staged=await sources.stage('deadline',[upload('book.pdf',await pdf(2))]);
  await assert.rejects(sources.extract('deadline',staged.sources[0].id),error=>error.status===408);
  const source=(await sources.inspect('deadline')).sources[0];assert.equal(source.status,'failed');assert.equal(source.segments.length,0);assert.match(source.warnings[0],/incomplete/);
});
