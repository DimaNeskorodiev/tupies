// Small presentation receipts, never execution authority. Only successful native
// writes supply these; model prose and imported content cannot announce a save.
const compact=(value,max=160)=>String(value || '').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max);
export async function recordLearningChange(engine,context,call,output) {
  if(!output || output.error || output.alreadyCompleted || output.skipped || output.duplicate)return;
  let kind,target,label,status='saved',remembered=null;
  if(['brain_write','brain_append','task_note'].includes(call.name) && output.path && /^[a-f0-9]{64}$/.test(output.sha256 || '')) {
    kind='brain';target=output.path;label=call.name==='task_note'?'Task notes':output.path.replace(/\.md$/,'').split('/').at(-1);
  } else if(call.name==='memory_set' && output.remembered===true){
    kind='memory';target=output.key;label=output.key;
    const entry=engine.store.state.memory?.[context.bot.id]?.find(item=>item.key===output.key);
    if(entry?.id && entry.revision)remembered={entryId:compact(entry.id,120),revision:compact(entry.revision,128),value:compact(entry.value,240),replaced:Boolean(entry.previous)};
  }
  else if(['skills_create','skills_install'].includes(call.name) && output.skill?.id && !output.alreadyAssigned && engine.store.state.bots.find(bot=>bot.id===context.bot.id)?.skills?.includes(output.skill.id)){kind='skill';target=output.skill.id;label=output.skill.name;status=call.name==='skills_install'?'installed':'saved';}
  else if(['skills_propose','memory_propose'].includes(call.name) && output.status==='pending' && output.proposalId){kind=call.name==='skills_propose'?'skill':'memory';target=output.proposalId;label=call.arguments?.name || (kind==='skill'?'Skill suggestion':'Memory suggestion');status='suggested';}
  else return;
  await engine.store.mutate(state=>{
    const run=state.runs[context.bot.id];if(run?.id!==context.runId)return;
    const rows=run.learningChanges ||= [],key=`${kind}:${status}:${compact(target,240)}`;
    const earlier=rows.find(row=>row.key===key);
    // A fact saved again in the same task keeps one receipt, pointing at its newest revision.
    if(earlier && remembered)Object.assign(earlier,engine.store.redactValue(remembered));
    if(earlier?!remembered:rows.length>=24)return;
    if(!earlier)rows.push(engine.store.redactValue({id:`${context.runId}:learning:${rows.length+1}`,key,kind,status,label:compact(label),target:compact(target,240),...(remembered || {}),createdAt:new Date().toISOString()}));
    // Retain even a committed write followed by Stop or a missing final answer.
    // This field travels with the display transcript, never model history.
    const owner=(state.messages[context.bot.id] || []).find(message=>message.runId===context.runId && message.role==='user');
    if(owner)owner.learningChanges=structuredClone(rows);
    run.updatedAt=new Date().toISOString();
  });
}
