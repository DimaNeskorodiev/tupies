import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensure, HttpError, id, now, parseSkill, atomicWrite } from './store.mjs';
import { rememberFact, groupsFor, MAX_MEMORY_ENTRIES, MAX_PINNED_MEMORY } from './agent-tools.mjs';
import { citableMessages, describeMessages } from './history.mjs';
import { factRevision } from './memory-quality.mjs';

/**
 * Reviewed learning: a bot suggests changes to its own core memory and skills, and the owner accepts or rejects them.
 * A proposal records the base it was made against (the facts it saw, or the SKILL.md sha256) and what that base becomes.
 * Accepting applies it only while the base is unchanged, so a newer edit is never overwritten; an accepted proposal
 * is its own undo record, applied backwards only while nothing has changed it since.
 */
export const MAX_PENDING=20, MAX_PENDING_SKILLS=5, KEEP_DECIDED=30;
const MAX_CHANGES=10, MAX_SOURCES=10, REJECTED_DAYS=30, SKILL_ID=/^[a-z0-9][a-z0-9-]{0,63}$/;
const sha256=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const factState=entry=>entry?{value:entry.value,pinned:Boolean(entry.pinned)}:null;

const reason={type:'string',maxLength:1000,description:'Why, in one or two plain sentences the owner will read.'};
const sources={type:'array',maxItems:MAX_SOURCES,items:{type:'string',maxLength:120},description:'Message IDs from session_search or session_read that this is based on. The current request is recorded automatically.'};
const definitions=[
  {name:'memory_propose',group:'memory',description:'Suggest changes to your core memory for the owner to review, instead of changing it yourself. Use it for facts and preferences you inferred rather than were asked to remember, to merge near-duplicates or drop outdated facts, and whenever you work in a routine, a team room or a chat that is not the owner’s. Nothing changes until the owner accepts the whole suggestion in your profile. Each change sets one fact (key and value, optionally pinned) or removes one (remove true). A suggestion is refused as out of date if those facts change before it is reviewed. Do not include secrets.',parameters:{type:'object',properties:{
    changes:{type:'array',minItems:1,maxItems:MAX_CHANGES,description:'The facts to add, update or remove.',items:{type:'object',properties:{
      key:{type:'string',maxLength:100,description:'Exact fact key. An existing key is updated; a new key adds a fact.'},
      value:{type:'string',maxLength:4000,description:'The new fact. It may link a note with [[note name]]. Omit when removing.'},
      pinned:{type:'boolean',description:'Pin or unpin the fact. Omit to keep its current state.'},
      remove:{type:'boolean',description:'true removes the fact with this key.'},
    },required:['key'],additionalProperties:false}},
    reason,sourceMessageIds:sources,
  },required:['changes','reason'],additionalProperties:false}},
  {name:'skills_propose',group:'skills',description:'Suggest a new skill, or an improvement to one of your assigned skills, for the owner to review. Nothing changes until the owner accepts it in your profile. To improve a skill, read it with skills_read and give skillId, its sha256 as expectedSha256, and either edits (exact oldText and newText pairs, each oldText matching exactly once) or content (the complete new SKILL.md with the same name in its frontmatter). To suggest a new skill, give name, description and instructions. Resources and scripts cannot be changed. A suggestion is refused as out of date if the skill changes before it is reviewed. Do not include secrets or claim work that was not done.',parameters:{type:'object',properties:{
    skillId:{type:'string',maxLength:64,description:'An assigned skill to improve.'},
    expectedSha256:{type:'string',maxLength:64,description:'The sha256 returned by skills_read for that skill.'},
    edits:{type:'array',minItems:1,maxItems:20,description:'Exact replacements applied in order.',items:{type:'object',properties:{oldText:{type:'string',maxLength:20000,description:'Exact current text, including whitespace.'},newText:{type:'string',maxLength:20000,description:'Replacement text; empty removes it.'}},required:['oldText','newText'],additionalProperties:false}},
    content:{type:'string',maxLength:100000,description:'The complete new SKILL.md, frontmatter included.'},
    name:{type:'string',maxLength:64,description:'For a new skill: a lowercase slug with letters, numbers and hyphens.'},
    description:{type:'string',maxLength:1000,description:'For a new skill: when to use it.'},
    instructions:{type:'string',maxLength:80000,description:'For a new skill: the complete instructions.'},
    reason,sourceMessageIds:sources,
  },required:['reason'],additionalProperties:false}},
];
export const learningToolDefinitions=groups=>definitions.filter(tool=>groups.includes(tool.group)).map(({group,...tool})=>structuredClone(tool));
export const isLearningTool=name=>definitions.some(tool=>tool.name===name);

function check(value,rule,label) {
  if(rule.type==='string')ensure(typeof value==='string' && value.length<=rule.maxLength,400,`${label} must be text of at most ${rule.maxLength} characters.`);
  else if(rule.type==='boolean')ensure(typeof value==='boolean',400,`${label} must be true or false.`);
  else if(rule.type==='array') {
    ensure(Array.isArray(value) && value.length>=(rule.minItems || 0) && value.length<=rule.maxItems,400,`${label} must list ${rule.minItems || 0}–${rule.maxItems} items.`);
    value.forEach((item,index)=>check(item,rule.items,`${label} item ${index+1}`));
  } else {
    ensure(value && typeof value==='object' && !Array.isArray(value),400,`${label} must be an object.`);
    ensure(Object.keys(value).every(key=>Object.hasOwn(rule.properties,key)),400,`${label} contains unknown fields.`);
    ensure((rule.required || []).every(key=>Object.hasOwn(value,key)),400,`${label} is missing required fields.`);
    for(const [key,item] of Object.entries(value))check(item,rule.properties[key],key);
  }
}
const validate=(name,args)=>check(args,definitions.find(tool=>tool.name===name).parameters,'Tool arguments');
const plainReason=(store,value)=>{const text=store.redact(String(value).trim());ensure(text,400,'Say briefly why, for the owner.');return text;};

const skillFile=(store,skillId)=>{ensure(SKILL_ID.test(skillId),400,'Invalid skill id.');return path.join(store.directory,'skills',skillId,'SKILL.md');};
async function readSkill(store,skillId) {try{return await fs.readFile(skillFile(store,skillId),'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}}

/** Adds a pending proposal, or returns the identical one already waiting. Runs inside a store mutation. */
function record(store,state,context,proposal,cited=[]) {
  const botId=context.bot.id,list=state.proposals ||= [];
  const duplicate=list.find(item=>item.botId===botId && item.status==='pending' && item.signature===proposal.signature);
  if(duplicate)return {proposalId:duplicate.id,status:'pending',duplicate:true,message:'An identical suggestion is already waiting for the owner’s review.'};
  const since=Date.now()-REJECTED_DAYS*86_400_000,rejected=list.find(item=>item.botId===botId && item.status==='rejected' && item.signature===proposal.signature && Date.parse(item.decidedAt)>=since);
  ensure(!rejected,409,`The owner declined this exact suggestion on ${String(rejected?.decidedAt).slice(0,10)}. Do not suggest it again unless they ask.`);
  const pending=list.filter(item=>item.botId===botId && item.status==='pending');
  ensure(pending.length<MAX_PENDING,429,`${MAX_PENDING} of your suggestions are already waiting for review. Wait until the owner has reviewed them.`);
  ensure(proposal.kind!=='skill' || pending.filter(item=>item.kind==='skill').length<MAX_PENDING_SKILLS,429,`${MAX_PENDING_SKILLS} of your skill suggestions are already waiting for review. Wait until the owner has reviewed them.`);
  const request=(state.messages?.[botId] || []).find(message=>message?.runId===context.runId && message.role==='user');
  const messageIds=[...new Set([...(request?[request.id]:[]),...citableMessages(state,context,[...new Set(cited)])])];
  const item={id:id('proposal'),botId,...proposal,status:'pending',source:{runId:context.runId,from:context.source || 'chat',...(context.sessionId && context.sessionId!==botId?{sessionId:context.sessionId}:{}),messageIds},createdAt:now()};
  list.push(item);prune(state,botId);
  store.audit('learning.proposed',`${context.bot.name} suggested ${label(item)}`,botId,{proposalId:item.id,kind:item.kind});
  return {proposalId:item.id,status:'pending',message:'Suggested for review. Nothing has changed yet: the owner accepts or declines it in your profile. Tell them briefly what you suggested and why.'};
}
const label=item=>item.kind==='memory'?'a memory update':item.skill?.create?'a new skill':'a skill change';

/** Keeps every pending proposal and the newest decided ones per bot; older decisions lose their undo record. */
function prune(state,botId) {
  const decided=(state.proposals || []).filter(item=>item.botId===botId && item.status!=='pending').sort((a,b)=>String(b.decidedAt || b.createdAt).localeCompare(String(a.decidedAt || a.createdAt)));
  const drop=new Set(decided.slice(KEEP_DECIDED).map(item=>item.id));
  if(drop.size)state.proposals=state.proposals.filter(item=>!drop.has(item.id));
}

export async function proposeMemory(store,context,args,{guard}={}) {
  validate('memory_propose',args);
  const keys=new Set(),text=plainReason(store,args.reason);
  const requested=args.changes.map(change=>{
    const key=change.key.trim();ensure(key,400,'Each change needs the fact’s key.');
    ensure(!keys.has(key),400,`The key ${JSON.stringify(key)} appears more than once.`);keys.add(key);
    if(change.remove){ensure(change.value===undefined && change.pinned===undefined,400,'A removal takes only the key and remove true.');return {key,remove:true};}
    const value=store.redact(String(change.value ?? '').trim());ensure(value,400,`Give the new text for ${JSON.stringify(key)}, or set remove to true.`);
    return {key,value,pinned:change.pinned};
  });
  return store.mutate(state=>{
    guard?.();
    const entries=state.memory?.[context.bot.id] || [];
    const changes=requested.map(change=>{
      const existing=entries.find(entry=>entry.key===change.key),before=factState(existing);
      ensure(!change.remove || existing,404,`There is no fact called ${JSON.stringify(change.key)} to remove. Check memory_search.`);
      const after=change.remove?null:{value:change.value,pinned:change.pinned ?? Boolean(existing?.pinned)};
      ensure(!same(before,after),400,`${JSON.stringify(change.key)} already says exactly this.`);
      return {key:change.key,before,after,beforeRevision:factRevision(existing),beforeEntry:existing?structuredClone(existing):null};
    });
    // A suggestion that could never apply is refused now; acceptance checks the limits again.
    const count=entries.length+changes.filter(change=>!change.before).length-changes.filter(change=>!change.after).length;
    const pinned=entries.filter(entry=>entry.pinned).length+changes.reduce((sum,change)=>sum+Number(Boolean(change.after?.pinned))-Number(Boolean(change.before?.pinned)),0);
    ensure(count<=MAX_MEMORY_ENTRIES,400,`Core memory holds at most ${MAX_MEMORY_ENTRIES} facts. Suggest removing old ones in the same change.`);
    ensure(pinned<=MAX_PINNED_MEMORY,400,`At most ${MAX_PINNED_MEMORY} facts can be pinned. Suggest unpinning one in the same change.`);
    return record(store,state,context,{kind:'memory',changes,reason:text,signature:sha256(JSON.stringify(changes.map(({key,after})=>[key,after])))},args.sourceMessageIds);
  });
}

export async function proposeSkill(store,context,args) {
  validate('skills_propose',args);
  const text=plainReason(store,args.reason);
  if(args.skillId!==undefined) {
    ensure(args.name===undefined && args.description===undefined && args.instructions===undefined,400,'To improve a skill, give skillId, expectedSha256 and edits or content. name, description and instructions are only for a new skill.');
    ensure((args.edits===undefined)!==(args.content===undefined),400,'Give either edits or the complete new content.');
    ensure(/^[a-f0-9]{64}$/.test(args.expectedSha256 || ''),400,'Give the sha256 from skills_read as expectedSha256.');
    ensure(context.bot.skills?.includes(args.skillId),403,'You can only suggest changes to skills assigned to you.');
    const skill=store.state.skills.find(item=>item.id===args.skillId),current=skill && await readSkill(store,skill.id);ensure(skill && current!==null,404,'Skill not found.');
    ensure(!skill.packageDigest,409,'Installed package versions are immutable. Suggest a new skill with a new name to customize this workflow.');
    ensure(sha256(current)===args.expectedSha256,409,'This skill changed since you read it. Read it again with skills_read and base the suggestion on the current text.');
    let next=args.content;
    if(args.edits) {
      next=current;
      args.edits.forEach((edit,index)=>{
        ensure(edit.oldText,400,`Edit ${index+1} needs the exact text it replaces.`);
        const count=next.split(edit.oldText).length-1;
        ensure(count===1,400,count?`Edit ${index+1} matches ${count} places. Include more of the surrounding text.`:`Edit ${index+1} does not match the skill. Copy oldText exactly from skills_read.`);
        next=next.replace(edit.oldText,()=>edit.newText);
      });
    }
    next=store.redact(next);
    const parsed=parseSkill(next);
    ensure(parsed.id===skill.id,400,'The skill’s name cannot change. Suggest a new skill instead.');
    ensure(next!==current,400,'The suggested text is the same as the current skill.');
    const change={id:skill.id,name:parsed.name,description:parsed.description,create:false,before:{sha256:sha256(current),content:current},after:{sha256:sha256(next),content:next}};
    return store.mutate(state=>record(store,state,context,{kind:'skill',skill:change,reason:text,signature:sha256(`${skill.id}\n${change.after.sha256}`)},args.sourceMessageIds));
  }
  ensure(args.edits===undefined && args.content===undefined && args.expectedSha256===undefined,400,'To improve an existing skill, give its skillId. A new skill takes name, description and instructions.');
  ensure([args.name,args.description,args.instructions].every(value=>typeof value==='string' && value.trim()),400,'A new skill needs a name, a description and instructions.');
  const content=store.redact(`---\nname: ${JSON.stringify(args.name.trim())}\ndescription: ${JSON.stringify(args.description.trim())}\n---\n\n${args.instructions}\n`),parsed=parseSkill(content);
  ensure(!store.state.skills.some(skill=>skill.id===parsed.id),409,'A skill with this name already exists. Choose another name, or improve that skill with skillId if it is assigned to you.');
  const change={id:parsed.id,name:parsed.name,description:parsed.description,create:true,before:null,after:{sha256:sha256(content),content}};
  return store.mutate(state=>record(store,state,context,{kind:'skill',skill:change,reason:text,signature:sha256(`${parsed.id}\n${change.after.sha256}`)},args.sourceMessageIds));
}

export async function executeLearningTool(engine,context,name,args) {
  engine.assertRunning(context);
  const group=definitions.find(tool=>tool.name===name).group;
  ensure(groupsFor(context.bot).includes(group),403,`Suggesting ${group==='memory'?'memory updates needs the Memory':'skill changes needs the Skills'} tools.`);
  const result=name==='memory_propose'?await proposeMemory(engine.store,context,args):await proposeSkill(engine.store,context,args);
  if(!result.duplicate)await engine.event(context,'learning.proposed',{message:`Suggested ${name==='memory_propose'?'a memory update':'a skill change'} for review`,proposalId:result.proposalId});
  return result;
}

/** Why the proposal no longer fits the current state, or '' when it does. `side` is the state it expects to find. */
async function conflict(store,state,proposal,side) {
  if(proposal.kind==='memory') {
    const entries=state.memory?.[proposal.botId] || [],changed=proposal.changes.find(change=>{
      const current=entries.find(entry=>entry.key===change.key),revision=change[side==='before'?'beforeRevision':'afterRevision'];
      return !same(factState(current),change[side]) || (revision!==undefined && factRevision(current)!==revision);
    });
    return changed?`The fact ${JSON.stringify(changed.key)} has changed since this was suggested.`:'';
  }
  // Source-derived instructions are accepted only while their exact managed
  // knowledge revision remains available to this bot. Undo instead checks the
  // accepted skill bytes below; a later source correction must not prevent it.
  const references=proposal.source?.knowledgeReferences;
  if(side==='before' && references!==undefined) {
    if(!Array.isArray(references) || references.length<1 || references.length>MAX_SOURCES)return 'The source knowledge references are invalid.';
    const {KnowledgeService}=await import('./knowledge.mjs'),knowledge=new KnowledgeService(store);
    for(const reference of references) {
      if(!reference || !/^unit-[a-f0-9]{32}$/.test(reference.unitId || '') || !/^[a-f0-9]{64}$/.test(reference.sha256 || '') || !Number.isSafeInteger(reference.revision) || reference.revision<1)return 'The source knowledge references are invalid.';
      let current;
      try{current=await knowledge.read(proposal.botId,reference.unitId);}catch{return 'The source knowledge is unavailable or has changed since this was suggested.';}
      if(current.sha256!==reference.sha256 || current.revision!==reference.revision)return 'The source knowledge has changed since this was suggested.';
    }
  }
  const skill=proposal.skill,expected=skill[side],meta=state.skills.find(item=>item.id===skill.id);
  if(!expected)return meta?'A skill with this name was added since this was suggested.':'';
  if(!meta)return 'This skill has been removed since.';
  if(meta.packageDigest)return 'Installed package versions are immutable. Create a new skill to customize this workflow.';
  if(skill.create && side==='after' && (meta.files || ['SKILL.md']).some(file=>file!=='SKILL.md'))return 'Files were added to this skill since it was created.';
  const content=await readSkill(store,skill.id);
  return content!==null && sha256(content)===expected.sha256?'':'This skill has changed since this was suggested.';
}

/** Moves memory or a skill from one side of the proposal to the other. The caller has checked for conflicts. */
async function apply(store,state,proposal,target) {
  const botId=proposal.botId;
  if(proposal.kind==='memory') {
    // Removals and unpins first, so a swap stays within the fact and pin limits.
    const order=change=>!change[target]?0:change[target].pinned?2:1;
    for(const change of [...proposal.changes].sort((a,b)=>order(a)-order(b))) {
      const next=change[target];
      if(next && target==='before' && change.beforeEntry) {
        // Recheck today's capacity/pin limits before restoring the exact old identity and provenance.
        rememberFact(state,botId,{key:change.key,value:next.value,pinned:next.pinned,source:change.beforeEntry.provenance});
        const entries=state.memory[botId] ||= [],index=entries.findIndex(entry=>entry.key===change.key),restored=structuredClone(change.beforeEntry);
        if(index>=0)entries[index]=restored;else entries.push(restored);
      }
      else if(next)rememberFact(state,botId,{key:change.key,value:next.value,pinned:next.pinned,source:target==='after'?{kind:'reviewed',proposalId:proposal.id,messageIds:proposal.source?.messageIds || [],observedAt:proposal.createdAt}:undefined});
      else if(state.memory?.[botId])state.memory[botId]=state.memory[botId].filter(entry=>entry.key!==change.key);
      if(target==='after')change.afterRevision=factRevision(state.memory?.[botId]?.find(entry=>entry.key===change.key));
    }
    return;
  }
  const skill=proposal.skill,next=skill[target],directory=path.dirname(skillFile(store,skill.id));
  if(!next) {
    // Undoing a new skill removes it again, from every bot it was assigned to.
    state.skills=state.skills.filter(item=>item.id!==skill.id);
    for(const bot of state.bots)bot.skills=(bot.skills || []).filter(item=>item!==skill.id);
    await fs.rm(directory,{recursive:true,force:true});
    return;
  }
  const parsed=parseSkill(next.content),size=Buffer.byteLength(next.content),meta=state.skills.find(item=>item.id===skill.id);
  if(!meta) {
    const bot=state.bots.find(item=>item.id===botId);ensure(bot,404,'Bot not found.');
    ensure(state.skills.length<200,400,'This workspace supports up to 200 skills. Remove one first.');
    ensure((bot.skills || []).length<30,400,`${bot.name} already has 30 skills. Remove one from it first.`);
    try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw new HttpError(409,'A skill folder with this name already exists and will not be overwritten.');throw error;}
    try{await atomicWrite(skillFile(store,skill.id),next.content);}catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}
    state.skills.push({...parsed,source:'learned',createdBy:botId,createdAt:now(),size,resourceCount:0,fileCount:1,files:['SKILL.md']});
    bot.skills=[...new Set([...(bot.skills || []),skill.id])];
    return;
  }
  const previous=Buffer.byteLength(skill[target==='after'?'before':'after'].content);
  ensure(!meta.packageDigest,409,'Installed package versions are immutable. Create a new skill to customize this workflow.');
  await atomicWrite(skillFile(store,skill.id),next.content);
  Object.assign(meta,{description:parsed.description,size:Math.max(size,(Number(meta.size) || 0)-previous+size),updatedAt:now()});
}

/** The bots that must be idle: the proposing bot, and for a skill every bot that uses it now. */
function involved(state,proposal) {
  const ids=new Set([proposal.botId]);
  if(proposal.kind==='skill')for(const bot of state.bots)if((bot.skills || []).includes(proposal.skill.id))ids.add(bot.id);
  return [...ids];
}

/**
 * The owner's decision. accept applies a pending proposal, reject declines it, undo reverses an accepted one.
 * `idle(botIds)` throws while any of those bots is working. A proposal whose base changed is marked stale and refused.
 */
export async function decideProposal(store,{botId,proposalId,action,idle}) {
  ensure(['accept','reject','undo'].includes(action),400,'Choose accept, reject or undo.');
  const result=await store.mutate(async state=>{
    const proposal=(state.proposals || []).find(item=>item.id===proposalId && item.botId===botId);ensure(proposal,404,'This suggestion no longer exists.');
    const bot=state.bots.find(item=>item.id===botId),name=bot?.name || 'The bot';
    if(action==='undo')ensure(proposal.status==='accepted',409,'Only an accepted suggestion can be undone.');
    else ensure(proposal.status==='pending',409,'This suggestion has already been reviewed.');
    if(action==='reject') {
      Object.assign(proposal,{status:'rejected',decidedAt:now()});prune(state,botId);
      store.audit('learning.rejected',`${name} ${label(proposal).replace(/^an? /,'')} declined`,botId,{proposalId,kind:proposal.kind});
      return {proposal};
    }
    idle(involved(state,proposal));
    const problem=await conflict(store,state,proposal,action==='accept'?'before':'after');
    if(problem) {
      if(action==='undo')return {refused:`${problem} It can’t be undone automatically.`};
      Object.assign(proposal,{status:'stale',decidedAt:now(),staleReason:problem});prune(state,botId);
      return {refused:`${problem} Nothing was changed. Ask ${name} to suggest it again from the current version.`};
    }
    await apply(store,state,proposal,action==='accept'?'after':'before');
    if(action==='accept')Object.assign(proposal,{status:'accepted',decidedAt:now()});
    else Object.assign(proposal,{status:'undone',undoneAt:now()});
    prune(state,botId);
    store.audit(action==='accept'?'learning.accepted':'learning.undone',`${name} ${label(proposal).replace(/^an? /,'')} ${action==='accept'?'accepted':'undone'}`,botId,{proposalId,kind:proposal.kind});
    return {proposal};
  });
  ensure(!result.refused,409,result.refused);
  return {proposal:await view(store,result.proposal)};
}

/** A proposal as the owner reviews it: whether it still applies (or can still be undone), its sources and who else uses the skill. */
async function view(store,proposal) {
  const state=store.state,{signature,...item}=proposal;
  const result={...item,sources:describeMessages(state,proposal.botId,proposal.source?.messageIds || [])};
  if(proposal.status==='pending')result.current=!(await conflict(store,state,proposal,'before'));
  if(proposal.status==='accepted')result.undoable=!(await conflict(store,state,proposal,'after'));
  if(proposal.kind==='skill')result.usedBy=state.bots.filter(bot=>bot.id!==proposal.botId && (bot.skills || []).includes(proposal.skill.id)).map(bot=>({id:bot.id,name:bot.name}));
  return result;
}

/** Pending suggestions oldest first, then the reviewed ones newest first. */
export async function listProposals(store,botId) {
  const items=(store.state.proposals || []).filter(item=>item.botId===botId);
  const pending=items.filter(item=>item.status==='pending').sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
  const decided=items.filter(item=>item.status!=='pending').sort((a,b)=>String(b.undoneAt || b.decidedAt || '').localeCompare(String(a.undoneAt || a.decidedAt || '')));
  const proposals=[];for(const item of [...pending,...decided])proposals.push(await view(store,item));
  return {proposals,pending:pending.length};
}

export const pendingProposals=(state,botId)=>(state.proposals || []).filter(item=>item.botId===botId && item.status==='pending');
