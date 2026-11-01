import {ensure,id,now} from './store.mjs';
import {proposeSkill} from './learning.mjs';
import {groupsFor} from './agent-tools.mjs';

/** Authenticated owner routes. The server applies session, Origin and CSRF checks before dispatch. */
export async function studyKnowledgeApi(req,res,url,context){
  const match=url.pathname.match(/^\/api\/bots\/([a-zA-Z0-9_-]+)\/knowledge(?:\/(units|batches|preview-correction|preview-rollback|publish|propose-method))?(?:\/(unit-[a-f0-9]{32}))?$/);
  if(!match)return false;
  const {store,runtime,rooms,sync,body,json}=context,[,botId,action,unitId]=match,bot=store.state.bots.find(b=>b.id===botId);
  ensure(bot,404,'Bot not found.');const knowledge=runtime.studies.knowledge;
  const reply=value=>{json(res,store.redactValue(value));return true;};
  const write=async operation=>{
    runtime.options.assertAdmission?.();ensure(!runtime.options.admissionPaused?.(),409,'Wait for engine topology changes before changing knowledge.');
    const run=store.state.runs[botId];ensure(!runtime.closing&&!runtime.starting.has(botId)&&!runtime.routineAdmissions.has(botId)&&!runtime.compactions.has(botId)&&!rooms.reserved(botId)&&!sync?.busyElsewhere(botId)&&!runtime.options.busyElsewhere?.(botId)&&(!run||['completed','failed','cancelled','interrupted','unknown'].includes(run.status)),409,'Wait for this bot on its active engine before changing its knowledge.');
    runtime.starting.add(botId);try{return await operation();}finally{runtime.starting.delete(botId);}
  };
  if(req.method==='GET'){
    if(action==='batches')return reply(await knowledge.batches(botId));
    if(action==='units'&&unitId)return reply(await knowledge.read(botId,unitId));
    if(!action||action==='units')return reply(await knowledge.list(botId));
  }
  ensure(req.method==='POST'&&!unitId,405,'Use GET to read knowledge or POST to prepare/review a concrete change.');
  const input=await body(req,100_000);
  if(action==='preview-rollback')return reply(await write(()=>knowledge.prepareRollback(botId,input.batchId)));
  if(action==='publish')return reply(await write(async()=>{const plan=await knowledge.readPlan(input.planId);ensure(plan.botId===botId,404,'Knowledge batch not found for this bot.');ensure(typeof input.approvalDigest==='string'&&input.approvalDigest===plan.approvalDigest,409,'Review the exact current knowledge changes before saving.');return knowledge.publish(plan,{approvedDigest:input.approvalDigest});}));
  if(action==='preview-correction')return reply(await write(async()=>{
    const current=await knowledge.read(botId,input.unitId);ensure(input.expectedSha256===current.sha256,409,'This knowledge changed. Read it again before correcting it.');
    ensure(['incorrect','missing-detail','wrong-application','project-preference'].includes(input.category),400,'Choose what the correction changes.');
    ensure(typeof input.content==='string'&&input.content.trim()&&input.content.length<=12_000&&typeof input.reason==='string'&&input.reason.trim()&&input.reason.length<=1500,400,'Supply a bounded correction and reason.');
    if(input.method!==undefined){ensure(current.unit.type==='method'&&input.method&&typeof input.method==='object'&&!Array.isArray(input.method)&&Object.keys(input.method).every(key=>['inputs','steps','outputs','checks'].includes(key)),400,'Only method knowledge accepts explicit procedure fields.');for(const [key,max]of [['inputs',20],['steps',30],['outputs',20],['checks',20]])ensure(Array.isArray(input.method[key])&&input.method[key].length<=max&&input.method[key].every(value=>typeof value==='string'&&value.trim()&&value.length<=1000)&&(!['steps','checks'].includes(key)||input.method[key].length>0),400,'Supply bounded method inputs, ordered steps, outputs and checks.');}
    if(input.category==='project-preference')ensure(typeof input.scope==='string'&&input.scope.trim(),400,'Specify the project scope for this preference.');
    const segmentId=id('owner'),content=store.redact(input.content),candidate={...current.unit,targetId:current.id,expectedSha256:current.sha256,content,...(input.method?{method:input.method}:{}),reason:store.redact(input.reason),support:'direct',scope:input.scope===undefined?current.unit.scope:input.scope,conditions:input.conditions===undefined?current.unit.conditions:input.conditions,exceptions:input.exceptions===undefined?current.unit.exceptions:input.exceptions,evidence:[{segmentId,quote:content.slice(0,1200)}]};
    return knowledge.prepare(botId,id('correction'),[candidate],{sourceReceipts:[{segmentId,sourceId:segmentId,sourceDigest:(await import('node:crypto')).createHash('sha256').update(content).digest('hex'),title:'Owner correction',locator:{kind:'owner-correction',category:input.category,observedAt:now()},text:content}]});
  }));
  if(action==='propose-method')return reply(await write(async()=>{
    ensure(groupsFor(bot).includes('skills'),403,'Skill suggestions require Skills tools.');const current=await knowledge.read(botId,input.unitId);ensure(current.sha256===input.expectedSha256&&current.unit.type==='method',409,'Read an unchanged method before proposing it as a skill.');
    ensure(typeof input.name==='string'&&typeof input.description==='string',400,'Supply a name and description for the proposed skill.');
    const runId=id('owner-review');await store.mutate(state=>(state.messages[botId]||=[]).push({id:id('message'),role:'user',content:`Propose the source-derived method “${current.unit.title}” as a reusable skill.`,createdAt:now(),runId}));
    const result=await proposeSkill(store,{bot,runId,source:'chat',sessionId:botId},{name:input.name,description:input.description,reason:`Owner-requested proposal from ${current.id}. This procedure is source-derived and has not been verified by executing it.`,instructions:`${current.unit.content}\n\nApplicability: ${JSON.stringify(current.unit.scope)}\n\nPrerequisites: ${current.unit.conditions.join('; ')}\n\nInputs:\n${current.unit.method.inputs.join('\n')}\n\nSteps:\n${current.unit.method.steps.map((s,i)=>`${i+1}. ${s}`).join('\n')}\n\nExpected outputs:\n${current.unit.method.outputs.join('\n')}\n\nChecks:\n${current.unit.method.checks.join('\n')}\n\nExceptions:\n${current.unit.exceptions.join('\n')}\n\nSource-derived, untested procedure. Knowledge: ${current.id}, revision ${current.revision}. This skill grants no tools or execution permission.`});
    await store.mutate(state=>{const proposal=state.proposals.find(p=>p.id===result.proposalId);if(proposal)proposal.source.knowledgeReferences=[{unitId:current.id,sha256:current.sha256,revision:current.revision}];});return result;
  }));
  ensure(false,405,'Unknown knowledge action.');
}
