import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../lib/store.mjs';
import {KnowledgeService} from '../lib/knowledge.mjs';
import {reconcileStudyCandidates} from '../lib/study-reconcile.mjs';

const botId='bot_atlas',sha=value=>createHash('sha256').update(value).digest('hex');
const candidate=(text,options={})=>({type:'principle',title:'Canonical URL choice',content:text,reason:'Preserve a single preferred URL in an SEO audit.',scope:'Public product pages',conditions:['The page is indexable.'],exceptions:['Do not combine unrelated content.'],aliases:[],evidence:[],...options});
const receipt=(id,text)=>({segmentId:id,sourceId:`source_${id}`,sourceDigest:sha(text),title:`Reference ${id}`,locator:{page:1},text});
const supported=(unit,id)=>({...unit,evidence:[{segmentId:id,quote:unit.content}]});
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-reconcile-')),store=await new Store(directory).init(),knowledge=new KnowledgeService(store);t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});return {directory,store,knowledge};}
async function publish(knowledge,jobId,candidates,sourceReceipts){const plan=await knowledge.prepare(botId,jobId,candidates,{sourceReceipts});await knowledge.publish(plan);return (await knowledge.list(botId)).units;}
async function prior(knowledge,text='Choose one canonical URL for duplicate product pages.',options={}){const unit=supported(candidate(text,options),'old_segment'),units=await publish(knowledge,'prior',[unit],[receipt('old_segment',text)]);return knowledge.read(botId,units[0].id);}
const reconcile=(knowledge,candidates,sourceReceipts,infer)=>reconcileStudyCandidates({knowledge,botId,candidates,sourceReceipts,infer});
const choose=(action,other='existing_0')=>async(phase,payload)=>{assert.equal(phase,'reconcile');const pair=payload.pairs.find(item=>item.otherId===other);assert.ok(pair);return {decisions:[{...pair,action}]};};

test('an independent first unit needs no semantic call and cannot choose its own overwrite target',async t=>{
  const {knowledge}=await fixture(t),text='Choose a canonical URL for duplicate product pages.',unit={...supported(candidate(text),'new_segment'),targetId:'unit-'+'a'.repeat(32),expectedSha256:'b'.repeat(64),relations:[{kind:'conflicts-with',unitId:'unit-'+'c'.repeat(32)}]};
  const result=await reconcile(knowledge,[unit],[receipt('new_segment',text)],()=>assert.fail('Independent first knowledge requires no extra inference.'));
  assert.equal(result.report.inferenceCalls,0);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].targetId,undefined);assert.equal(result.candidates[0].expectedSha256,undefined);assert.equal(result.candidates[0].relations,undefined);
  assert.equal((await publish(knowledge,'first',result.candidates,result.sourceReceipts)).length,1);
});

test('a semantically duplicate paraphrase can skip only an actually read unchanged scoped unit',async t=>{
  const {knowledge}=await fixture(t),saved=await prior(knowledge),text='Select one preferred canonical URL when product pages contain duplicate content.',unit=supported(candidate(text,{title:'Preferred canonical URL'}),'new_segment');
  const result=await reconcile(knowledge,[unit],[receipt('new_segment',text)],choose('duplicate'));
  assert.equal(result.candidates.length,0);assert.equal(result.report.duplicates,1);assert.deepEqual(result.readSet,[{unitId:saved.id,sha256:saved.sha256,revision:1}]);assert.equal((await knowledge.read(botId,saved.id)).sha256,saved.sha256);
});

test('enrichment preserves complete prior content, prerequisites, exceptions and exact retained evidence',async t=>{
  const {knowledge}=await fixture(t),saved=await prior(knowledge),text='The preferred canonical URL should use HTTPS when the secure version is available.',unit=supported(candidate(text,{title:'Canonical URL HTTPS requirement',conditions:['HTTPS is available.'],exceptions:['Do not change an intentionally HTTP-only archive.']}),'new_segment');
  const result=await reconcile(knowledge,[unit],[receipt('new_segment',text)],choose('enrich'));
  assert.equal(result.candidates.length,1);const merged=result.candidates[0];assert.equal(merged.targetId,saved.id);assert.equal(merged.expectedSha256,saved.sha256);assert.ok(merged.content.includes(saved.unit.content));assert.ok(merged.content.includes(text));assert.deepEqual(merged.conditions,[...saved.unit.conditions,...unit.conditions]);assert.deepEqual(merged.exceptions,[...saved.unit.exceptions,...unit.exceptions]);assert.equal(merged.evidence.length,2);
  const retained=result.sourceReceipts.find(item=>item.segmentId.startsWith('retained_'));assert.equal(retained.sourceDigest,saved.unit.evidence[0].sourceDigest);assert.equal(retained.locator.retainedSegmentId,'old_segment');assert.deepEqual(retained.locator.originalLocator,saved.unit.evidence[0].locator);
  await publish(knowledge,'enrich',result.candidates,result.sourceReceipts);const current=await knowledge.read(botId,saved.id);assert.equal(current.revision,2);assert.equal(current.unit.evidence.length,2);assert.equal(current.unit.support,'synthesis');
});

test('six successive enrichments keep original source lineage flat and preserve media provenance',async t=>{
  const {knowledge}=await fixture(t),text='Choose one canonical URL for duplicate product pages.',originalLocator={kind:'pdf',page:7,interpretation:{kind:'model-visual-interpretation',uncertain:true,includesExtractedText:true}},source=receipt('original_visual_segment',text);source.locator=originalLocator;
  const first=await publish(knowledge,'visual_prior',[supported(candidate(text),'original_visual_segment')],[source]),unitId=first[0].id;
  const expected=new Map([['original_visual_segment',{locator:originalLocator,digest:source.sourceDigest,quote:text}]]);
  let priorReceiptId;
  for(let round=1;round<=6;round++){
    const detail=`Canonical URL audit detail ${round}: preserve the reviewed product-page URL condition.`,segmentId=`detail_${round}`,nextReceipt=receipt(segmentId,detail);nextReceipt.locator={kind:'document',section:round};expected.set(segmentId,{locator:nextReceipt.locator,digest:nextReceipt.sourceDigest,quote:detail});
    const result=await reconcile(knowledge,[supported(candidate(detail,{title:`Canonical URL audit detail ${round}`}),segmentId)],[nextReceipt],choose('enrich'));
    assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].targetId,unitId);assert.equal(result.report.enriched,1);
    const oldVisual=result.sourceReceipts.find(item=>item.locator?.retainedSegmentId==='original_visual_segment');assert.ok(oldVisual);if(priorReceiptId)assert.equal(oldVisual.segmentId,priorReceiptId);priorReceiptId=oldVisual.segmentId;
    await publish(knowledge,`enrichment_${round}`,result.candidates,result.sourceReceipts);const current=await knowledge.read(botId,unitId);assert.equal(current.revision,round+1);assert.equal(current.unit.evidence.length,round+1);assert.ok(current.unit.content.includes(text));assert.ok(current.unit.content.includes(detail));
    for(const evidence of current.unit.evidence){
      const isRetained=Object.hasOwn(evidence.locator,'retainedSegmentId'),originalId=isRetained?evidence.locator.retainedSegmentId:evidence.segmentId,lineage=expected.get(originalId);assert.ok(lineage,`Unknown original segment ${originalId}`);assert.equal(evidence.sourceDigest,lineage.digest);assert.equal(evidence.quote,lineage.quote);assert.deepEqual(isRetained?evidence.locator.originalLocator:evidence.locator,lineage.locator);
      if(isRetained)assert.equal(Object.hasOwn(evidence.locator.originalLocator,'originalLocator'),false,'retained evidence must not nest another envelope');
    }
  }
});

test('same-scope contradictory rules remain present, disputed and reciprocally linked',async t=>{
  const {knowledge}=await fixture(t),saved=await prior(knowledge),text='Do not select a canonical URL for duplicate product pages.',unit=supported(candidate(text,{title:'Opposing canonical URL rule'}),'new_segment');
  const result=await reconcile(knowledge,[unit],[receipt('new_segment',text)],choose('conflict'));
  assert.equal(result.candidates.length,2);assert.ok(result.candidates.every(item=>item.status==='disputed'));const update=result.candidates.find(item=>item.targetId);assert.equal(update.targetId,saved.id);assert.equal(update.content,saved.unit.content);assert.equal(update.expectedSha256,saved.sha256);assert.ok(result.candidates.every(item=>item.relations[0].kind==='conflicts-with'));
  await publish(knowledge,'conflict',result.candidates,result.sourceReceipts);const units=(await knowledge.list(botId)).units;assert.equal(units.length,2);assert.ok(units.every(item=>item.unit.status==='disputed'&&item.unit.relations[0].kind==='conflicts-with'));
});

test('different platform scopes retain independent active alternatives without disputing current knowledge',async t=>{
  const {knowledge}=await fixture(t),saved=await prior(knowledge),text='Do not select a canonical URL for duplicate product pages on the closed store platform.',unit=supported(candidate(text,{scope:'Closed store platform'}),'new_segment');
  const result=await reconcile(knowledge,[unit],[receipt('new_segment',text)],choose('conflict'));
  assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].targetId,undefined);assert.equal(result.candidates[0].status,'active');assert.equal(result.candidates[0].relations[0].kind,'scoped-alternative');assert.equal(result.candidates[0].relations[0].unitId,saved.id);assert.equal((await knowledge.read(botId,saved.id)).sha256,saved.sha256);
});

test('same-batch multi-source enrichment preserves both complete supported details',async t=>{
  const {knowledge}=await fixture(t),first=supported(candidate('Choose one canonical URL for duplicate product pages.'),'first'),second=supported(candidate('Use the canonical URL consistently in the product-page sitemap.',{title:'Consistent sitemap canonical URL',exceptions:['Keep intentionally excluded pages out of the sitemap.']}),'second');
  const result=await reconcile(knowledge,[first,second],[receipt('first',first.content),receipt('second',second.content)],choose('enrich','candidate_0'));
  assert.equal(result.report.inferenceCalls,1);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].evidence.length,2);assert.ok(result.candidates[0].content.includes(first.content));assert.ok(result.candidates[0].content.includes(second.content));assert.ok(result.candidates[0].exceptions.includes(second.exceptions[0]));assert.deepEqual(result.readSet,[]);
  assert.equal((await publish(knowledge,'synthesis',result.candidates,result.sourceReceipts)).length,1);
});

test('methods with different step order remain separate and never overwrite the retained procedure',async t=>{
  const {knowledge}=await fixture(t),text='Audit canonical URL consistency for product pages.',method={inputs:['Product URLs'],steps:['Read the canonical URL.','Compare the product sitemap.'],outputs:['Scoped audit findings'],checks:['Verify both URLs refer to the same product.']},saved=await prior(knowledge,text,{type:'method',method}),unit=supported(candidate(text,{type:'method',method:{...method,steps:[...method.steps].reverse()}}),'new_segment');
  const result=await reconcile(knowledge,[unit],[receipt('new_segment',text)],choose('enrich'));
  assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].targetId,undefined);assert.deepEqual(result.candidates[0].method.steps,unit.method.steps);assert.equal(result.candidates[0].relations[0].kind,'supplements');assert.equal((await knowledge.read(botId,saved.id)).sha256,saved.sha256);
  assert.equal((await publish(knowledge,'separate_procedure',result.candidates,result.sourceReceipts)).length,2);
});

test('literal reimport after synthesis preserves disputed metadata without another model call',async t=>{
  const {knowledge}=await fixture(t),text='Choose one canonical URL for duplicate product pages.',saved=await prior(knowledge,text,{support:'synthesis',status:'disputed'}),unit=supported(candidate(text,{reason:'A differently worded role relevance.'}),'new_segment');
  const result=await reconcile(knowledge,[unit],[receipt('new_segment',text)],()=>assert.fail('The literal claim is already retained.'));
  assert.equal(result.candidates.length,0);assert.equal(result.report.inferenceCalls,0);assert.equal((await knowledge.read(botId,saved.id)).unit.status,'disputed');assert.deepEqual(result.readSet,[{unitId:saved.id,sha256:saved.sha256,revision:1}]);
});

test('a newly disputed duplicate conservatively revises active status without losing current content',async t=>{
  const {knowledge}=await fixture(t),text='Choose one canonical URL for duplicate product pages.',saved=await prior(knowledge,text),unit=supported(candidate(text,{status:'disputed'}),'new_segment');
  const result=await reconcile(knowledge,[unit],[receipt('new_segment',text)],()=>assert.fail('Identical claim metadata needs no semantic inference.'));
  assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].targetId,saved.id);assert.equal(result.candidates[0].status,'disputed');assert.equal(result.candidates[0].content,saved.unit.content);
});

test('evidence bounds retain a separate supplement rather than truncating protected prior evidence',async t=>{
  const {knowledge}=await fixture(t),text='Choose one canonical URL for duplicate product pages.',unit=candidate(text),oldReceipts=Array.from({length:8},(_,index)=>receipt(`old_${index}`,text));unit.evidence=oldReceipts.map(item=>({segmentId:item.segmentId,quote:text}));const units=await publish(knowledge,'many_sources',[unit],oldReceipts),saved=await knowledge.read(botId,units[0].id),detail='Use the preferred canonical URL consistently in all product-page links.',incoming=supported(candidate(detail),'new_segment');
  const result=await reconcile(knowledge,[incoming],[receipt('new_segment',detail)],choose('enrich'));
  assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].targetId,undefined);assert.equal(result.candidates[0].relations[0].kind,'supplements');assert.equal(result.candidates[0].evidence.length,1);assert.equal(result.sourceReceipts.length,1);assert.equal((await knowledge.read(botId,saved.id)).unit.evidence.length,8);
});

test('an identity-colliding bounded supplement gets a stable title and reimports without losing aliases',async t=>{
  const {knowledge}=await fixture(t),text='Choose one canonical URL for duplicate product pages.',saved=await prior(knowledge,text,{aliases:Array.from({length:10},(_,index)=>`canonical_alias_${index}`)}),unit=supported(candidate(text,{aliases:['канонічна адреса']}),'new_segment'),receipts=[receipt('new_segment',text)];
  const first=await reconcile(knowledge,[unit],receipts,()=>assert.fail('The literal claim is already known.'));assert.equal(first.candidates.length,1);assert.equal(first.candidates[0].content,text);assert.match(first.candidates[0].title,/\(supplement [a-f0-9]{12}\)$/);assert.ok(first.candidates[0].title.length<=180);assert.deepEqual(first.candidates[0].aliases,['канонічна адреса']);assert.equal(first.candidates[0].relations[0].unitId,saved.id);
  const published=await publish(knowledge,'bounded_alias',first.candidates,first.sourceReceipts);assert.equal(published.length,2);assert.equal((await knowledge.read(botId,saved.id)).unit.aliases.length,10);
  const again=await reconcile(knowledge,[{...unit,reason:'Different wording of the same role relevance.'}],receipts,()=>assert.fail('A retained literal supplement is still deterministic.'));assert.equal(again.candidates.length,0);assert.ok(again.readSet.length>=1);
});

test('an evidence-full active unit can retain a newly disputed duplicate as a distinct supplement',async t=>{
  const {knowledge}=await fixture(t),text='Choose one canonical URL for duplicate product pages.',unit=candidate(text),oldReceipts=Array.from({length:8},(_,index)=>receipt(`old_${index}`,text));unit.evidence=oldReceipts.map(item=>({segmentId:item.segmentId,quote:text}));const units=await publish(knowledge,'full_active',[unit],oldReceipts),saved=await knowledge.read(botId,units[0].id),incoming=supported(candidate(text,{status:'disputed'}),'new_segment');
  const result=await reconcile(knowledge,[incoming],[receipt('new_segment',text)],()=>assert.fail('Only uncertainty metadata differs.'));assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].status,'disputed');assert.equal(result.candidates[0].content,text);assert.match(result.candidates[0].title,/\(supplement [a-f0-9]{12}\)$/);assert.equal((await knowledge.read(botId,saved.id)).sha256,saved.sha256);assert.equal((await publish(knowledge,'disputed_supplement',result.candidates,result.sourceReceipts)).length,2);
});

test('an unknown model target or invented replacement text cannot become an overwrite',async t=>{
  const {knowledge}=await fixture(t),saved=await prior(knowledge),text='Choose the preferred canonical URL for duplicate product pages.',unit=supported(candidate(text),'new_segment');
  await assert.rejects(reconcile(knowledge,[unit],[receipt('new_segment',text)],async()=>({decisions:[{candidateId:'candidate_0',otherId:'existing_999',action:'enrich',targetId:saved.id,content:'Invented replacement'}]})),error=>error.status===502);
  assert.equal((await knowledge.read(botId,saved.id)).sha256,saved.sha256);
});

test('knowledge edited while the model decides fails the final stale read guard',async t=>{
  const {knowledge}=await fixture(t),saved=await prior(knowledge),text='Select one preferred canonical URL for duplicated product pages.',unit=supported(candidate(text),'new_segment');
  await assert.rejects(reconcile(knowledge,[unit],[receipt('new_segment',text)],async(phase,payload)=>{
    const correction='Choose one reviewed canonical URL for duplicate product pages.',updated={...saved.unit,targetId:saved.id,expectedSha256:saved.sha256,content:correction,evidence:[{segmentId:'correction',quote:correction}]};await publish(knowledge,'owner_correction',[updated],[receipt('correction',correction)]);return {decisions:[{...payload.pairs[0],action:'duplicate'}]};
  }),error=>error.status===409);
  assert.equal((await knowledge.read(botId,saved.id)).revision,2);
});
