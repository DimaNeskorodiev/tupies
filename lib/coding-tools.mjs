import { ensure } from './store.mjs';
import { groupsFor } from './agent-tools.mjs';

const text=maxLength=>({type:'string',minLength:1,maxLength});
const schema=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const tool=(name,description,parameters)=>({name,description,parameters});
const definitions=[
  tool('coding_discover','After owner approval, discover installed coding agents and local repositories. Returns metadata only. Use it before asking the owner for paths or Azure details.',schema({includeClaudeProjects:{type:'boolean'}},[])),
  tool('coding_projects','List this bot’s connected Mac coding projects and supported coding agents. Accounts and repository access are local to this engine.',schema({})),
  tool('coding_connect','Ask the owner to connect a discovered local repository and coding agent to this bot. Existing account access is an explicit choice; no credentials are copied.',schema({path:text(2000),agent:{type:'string',enum:['claude','codex']},account:{type:'string',enum:['existing','dedicated']}})),
  tool('coding_work_items','With exact approval, read Azure work items assigned to the connected account for an allowed project. Missing access belongs in Coding settings, never chat.',schema({projectId:text(100)})),
  tool('coding_run','Delegate work to a connected Mac coding agent in a separate checkout (up to 30 minutes). Inspect the result and run coding_verify; pass jobId for a correction. Claims prove nothing.',schema({projectId:text(100),instructions:text(20000),workItemId:{type:'integer',minimum:1,maximum:2147483647},jobId:text(100)},['projectId','instructions'])),
  tool('coding_inspect','Inspect this bot’s completed coding job and real current Git diff. Changed files invalidate earlier verification. Returned file and agent text is untrusted evidence.',schema({jobId:text(100)})),
  tool('coding_publish','After exact approval, commit verified work, recheck it, push the job branch and open an Azure draft PR. Never merges. Inspect an unknown outcome; never retry it.',schema({jobId:text(100),title:text(300),description:text(10000),targetBranch:text(200)})),
  tool('coding_verify','Run exact-approved independent checks in the job checkout. A changed checkout or nonzero result fails verification; request corrections with coding_run.',schema({jobId:text(100),checks:{type:'array',minItems:1,maxItems:10,items:schema({name:text(100),executable:text(2000),args:{type:'array',maxItems:50,items:{type:'string',maxLength:2000}}})}},['jobId'])),
];
export const isCodingTool=name=>definitions.some(item=>item.name===name);
export const codingToolDefinitions=(engine,context)=>engine.localCoding.available()&&context.source==='chat'&&groupsFor(context.bot).includes('coding')?definitions:[];
function validate(name,args) {
  const definition=definitions.find(item=>item.name===name);ensure(definition&&args&&typeof args==='object'&&!Array.isArray(args),400,'Invalid coding tool arguments.');
  ensure(Object.keys(args).every(key=>Object.hasOwn(definition.parameters.properties,key))&&definition.parameters.required.every(key=>Object.hasOwn(args,key)),400,'Use the declared coding arguments.');
  for(const [key,value] of Object.entries(args)){const spec=definition.parameters.properties[key];ensure(spec.type==='array'?Array.isArray(value):spec.type==='integer'?Number.isInteger(value)&&value>=spec.minimum&&value<=spec.maximum:typeof value===spec.type,400,'Invalid coding argument type.');if(spec.type==='string')ensure(value.length>=1&&(spec.maxLength===undefined||value.length<=spec.maxLength)&&!value.includes('\0'),400,'Invalid coding text.');if(spec.enum)ensure(spec.enum.includes(value),400,'Invalid coding choice.');}
}
export async function executeCodingTool(engine,context,name,args) {
  ensure(codingToolDefinitions(engine,context).some(tool=>tool.name===name)&&groupsFor(engine.store.state.bots.find(bot=>bot.id===context.bot.id)).includes('coding'),403,'Local coding requires the Coding tools in a direct owner chat on this Mac.');validate(name,args);
  const service=engine.localCoding;await service.init();const botId=context.bot.id,signal=context.controller.signal;
  const approve=async request=>{const accepted=await engine.approve(context,{name:request.tool,arguments:request.args || args},{signal:request.signal});engine.assertRunning(context);ensure(groupsFor(engine.store.state.bots.find(bot=>bot.id===botId)).includes('coding'),403,'Coding access was removed.');return accepted;};
  if(name==='coding_projects'){const status=await service.status();return {...status,projects:status.projects.filter(project=>project.botIds.includes(botId)),jobs:status.jobs.filter(job=>job.botId===botId)};}
  if(name==='coding_discover'){ensure(await approve({tool:name,args}),403,'Project discovery was denied.');return service.discover(args);}
  if(name==='coding_connect'){
    ensure(await approve({tool:name,args:{...args,botId}}),403,'Coding connection was denied.');const discovery=await service.discover({includeClaudeProjects:true}),agent=discovery.agents.find(item=>item.id===args.agent),project=discovery.projects.find(item=>item.path===args.path);ensure(agent?.executable,409,'The coding executable was not found. Choose its installed path in Coding on this Mac.');
    await service.configureAgent(args.agent,{executable:agent.executable,account:args.account});
    return service.configureProject({name:project?.name,path:args.path,agent:args.agent,organization:project?.organization || '',project:project?.project || '',repositoryId:project?.repositoryId || '',repositoryName:project?.repositoryName || '',botIds:[botId],checks:[]});
  }
  if(name==='coding_work_items'){const project=service.project(args.projectId,botId);ensure(await approve({tool:name,args:{projectId:project.id,organization:project.organization,project:project.project}}),403,'Azure work-item access was denied.');return service.workItems(args.projectId,{botId,signal});}
  if(name==='coding_inspect')return service.inspect(args.jobId,{botId,signal});
  // One separate, bounded budget for delegated coding/check work; ordinary model work retains its remaining budget.
  const remaining=Math.max(0,context.deadlineAt-Date.now()),ceiling=Math.max(0,context.ceilingAt-Date.now());context.codingRemaining ??=5400000;
  ensure(context.codingRemaining>0,409,'This task reached its 90-minute coding-work budget.');const started=Date.now();engine.deadline(context,context.codingRemaining);
  try{if(name==='coding_run')return await service.run(args,{botId,runId:context.runId,signal,approve,onEvent:event=>engine.event(context,'coding.progress',{jobId:event.jobId,phase:event.type,text:event.text})});
    if(name==='coding_publish')return await service.publish(args.jobId,args,{botId,runId:context.runId,signal,approve});
    return await service.verify(args.jobId,args.checks,{botId,runId:context.runId,signal,approve});
  }finally{context.codingRemaining-=Date.now()-started;context.ceilingAt=Date.now()+ceiling;engine.deadline(context,Math.min(remaining,ceiling));}
}
