import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { KnowledgeService } from '../lib/knowledge.mjs';
import { proposeSkill, decideProposal, listProposals } from '../lib/learning.mjs';

const quote='For the fictional fixture, verify the canonical target before recording the crawl.';
const receipts=[{segmentId:'segment_material_guard',sourceId:'source_material_guard',sourceDigest:createHash('sha256').update(quote).digest('hex'),title:'Public synthetic procedure',locator:{page:1},text:quote}];
const candidate={type:'method',title:'Fixture crawl procedure',content:quote,reason:'Supports the synthetic audit role.',scope:'Fictional fixture only.',method:{inputs:['URL'],steps:['Verify the canonical target.','Record the crawl.'],outputs:['Crawl ledger'],checks:['The canonical target was verified.']},evidence:[{segmentId:'segment_material_guard',quote}]};
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-material-proposal-')),store=await new Store(directory).init(),botId=store.state.bots[0].id,knowledge=new KnowledgeService(store);
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const plan=await knowledge.prepare(botId,'material_source',[candidate],{sourceReceipts:receipts});await knowledge.publish(plan);
  const current=await knowledge.read(botId,plan.actions[0].unitId);
  const propose=async({reference={unitId:current.id,sha256:current.sha256,revision:current.revision},targetBotId=botId,name='material-method'}={})=>{
    const bot=store.state.bots.find(bot=>bot.id===targetBotId),result=await proposeSkill(store,{bot,runId:'owner_review',source:'chat',sessionId:targetBotId},{name,description:'Run a source-derived fixture procedure.',instructions:quote,reason:'Owner-requested proposal from retained fixture knowledge.'});
    if(reference!==null)await store.mutate(state=>{state.proposals.find(p=>p.id===result.proposalId).source.knowledgeReferences=[reference];});
    return result.proposalId;
  };
  const decide=(proposalId,action='accept',targetBotId=botId)=>decideProposal(store,{botId:targetBotId,proposalId,action,idle:()=>{}});
  const update=async()=>{
    const plan=await knowledge.prepare(botId,'material_correction',[{...candidate,targetId:current.id,expectedSha256:current.sha256,content:'Verify the current canonical target, then record the scoped crawl.'}],{sourceReceipts:receipts});await knowledge.publish(plan);return knowledge.read(botId,current.id);
  };
  return {directory,store,botId,knowledge,current,propose,decide,update};
}

test('a material-derived proposal accepts the exact current knowledge revision',async t=>{
  const h=await fixture(t),proposalId=await h.propose();
  assert.equal((await listProposals(h.store,h.botId)).proposals.find(p=>p.id===proposalId).current,true);
  const accepted=await h.decide(proposalId);assert.equal(accepted.proposal.status,'accepted');assert.equal(accepted.proposal.undoable,true);
  assert.ok(h.store.state.bots[0].skills.includes('material-method'));
});

test('a corrected source makes its pending derived proposal stale without creating a skill',async t=>{
  const h=await fixture(t),proposalId=await h.propose();await h.update();
  assert.equal((await listProposals(h.store,h.botId)).proposals.find(p=>p.id===proposalId).current,false);
  await assert.rejects(h.decide(proposalId),error=>error.status===409&&/source knowledge has changed/.test(error.message));
  assert.equal(h.store.state.proposals.find(p=>p.id===proposalId).status,'stale');
  assert.equal(h.store.state.skills.some(skill=>skill.id==='material-method'),false);
  await assert.rejects(fs.stat(path.join(h.directory,'skills','material-method')),{code:'ENOENT'});
});

test('the source revision is checked even if a reference contains the current note hash',async t=>{
  const h=await fixture(t),latest=await h.update(),proposalId=await h.propose({reference:{unitId:latest.id,sha256:latest.sha256,revision:h.current.revision}});
  await assert.rejects(h.decide(proposalId),/source knowledge has changed/);
});

test('unavailable and cross-bot source knowledge cannot authorize a derived skill',async t=>{
  const h=await fixture(t),proposalId=await h.propose(),context=await h.knowledge.context(h.botId);
  await fs.rm(path.join(context.root,'brain',h.current.path.replace(/\.md$/,'.manifest.json')));
  await assert.rejects(h.decide(proposalId),/source knowledge is unavailable/);
  const otherBotId=h.store.state.bots[1].id,other=await h.propose({targetBotId:otherBotId,name:'other-material-method'});
  await assert.rejects(h.decide(other,'accept',otherBotId),/source knowledge is unavailable/);
  assert.equal(h.store.state.bots[1].skills.includes('other-material-method'),false);
});

test('malformed source references fail closed while ordinary legacy proposals remain accepted',async t=>{
  const h=await fixture(t),bad=await h.propose({reference:{unitId:'invented',sha256:'not-a-hash',revision:0},name:'invalid-material-method'});
  await assert.rejects(h.decide(bad),/source knowledge references are invalid/);
  const ordinary=await h.propose({reference:null,name:'ordinary-local-method'});
  assert.equal((await h.decide(ordinary)).proposal.status,'accepted');
});

test('a source correction does not prevent Undo of unchanged accepted skill bytes',async t=>{
  const h=await fixture(t),proposalId=await h.propose();await h.decide(proposalId);await h.update();
  assert.equal((await listProposals(h.store,h.botId)).proposals.find(p=>p.id===proposalId).undoable,true);
  assert.equal((await h.decide(proposalId,'undo')).proposal.status,'undone');
  assert.equal(h.store.state.bots[0].skills.includes('material-method'),false);
  assert.equal((await h.knowledge.read(h.botId,h.current.id)).revision,2);
});
