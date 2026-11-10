// Engine-owned approval policy for terminal/code actions and owner-marked automatic API reads.
// Replaces the per-action model risk review for these tools with the deterministic classifier
// in command-classifier.mjs. Model output never selects a policy: the bot settings (both the
// task snapshot and the current saved bot), the owner allowlist, routine pre-approvals and
// integration settings decide. Dangerous commands always wait for the owner.
import { createHash } from 'node:crypto';
import { classifyCommand, classifyCode, classifyArgv, WORKSPACE_PLACEHOLDER } from './command-classifier.mjs';
import { ensure } from './store.mjs';
// Namespace import: isBotChat (WS3 chat sessions) is used when this engine has it.
import { isBotChat } from './sessions.mjs';
import { executionBackend, executionReadiness, selectedBackend, noteHostFallback, clearHostFallback } from './exec/index.mjs';

export const COMMAND_TOOLS=new Set(['terminal','execute_code','shell_run','shell_start']);
export const MAX_ALLOWLIST=50, MAX_ROUTINE_COMMANDS=20;
const ORDER=['auto','balanced','strict'];

/** The stricter of the task snapshot and the current saved bot; unknown or missing means strict. */
export function effectiveApprovalPolicy(snapshot,current) {
  const a=ORDER.indexOf(snapshot?.approvalPolicy),b=ORDER.indexOf(current?.approvalPolicy);
  if(a<0 || b<0)return 'strict';
  return ORDER[Math.max(a,b)];
}

/**
 * The owner's own ordinary Bot Chat (any of its chat sessions). Teammates, rooms, routines, Telegram and
 * other people's sessions are not owner chat.
 */
export function ownerChat(context) {
  const botChat=isBotChat(context?.sessionId,context?.bot?.id);
  return (context?.source || 'chat')==='chat' && botChat && !context.delegation?.depth && !context.fromBotId && !context.parentRunId && !context.roomId;
}

export function commandDigest(command){return createHash('sha256').update(JSON.stringify(['terminal',command])).digest('hex');}

/** Owner-configured command patterns. `*` matches any text; a pattern must start with a command. */
export function validateCommandAllowlist(value) {
  ensure(Array.isArray(value) && value.length<=MAX_ALLOWLIST,400,`Give up to ${MAX_ALLOWLIST} allowed command patterns.`);
  const patterns=value.map(item=>typeof item==='string'?item.trim().replace(/\s+/g,' '):item).filter(item=>item!=='');
  ensure(patterns.every(item=>typeof item==='string' && item.length<=200 && !/[\x00-\x1f\x7f]/.test(item) && /^[A-Za-z0-9_./-]/.test(item)),400,'Each allowed command pattern must start with a command name and be at most 200 characters.');
  ensure(patterns.every(item=>!/[;&|<>`$()]/.test(item)),400,'Allowed command patterns describe one simple command; leave out ; & | < > ` $ and parentheses.');
  return [...new Set(patterns)];
}

const patternExpression=pattern=>new RegExp(`^${pattern.split('*').map(part=>part.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*')}$`);

/**
 * True when every non-read-only command unit matches one of the patterns and at least one
 * unit matched. Dangerous or computed commands never match.
 */
export function allowlisted(classification,patterns) {
  if(!Array.isArray(patterns) || !patterns.length || classification.risk!=='normal')return null;
  const expressions=patterns.map(pattern=>[pattern,patternExpression(pattern)]);let matched=null;
  for(const unit of classification.units || []) {
    if(unit.risk==='read_only')continue;
    if(unit.computed || unit.risk!=='normal')return null;
    const hit=expressions.find(([,expression])=>expression.test(unit.text));
    if(!hit)return null;matched ||= hit[0];
  }
  return matched;
}

/** Validates routine pre-approved terminal commands; dangerous commands cannot be pre-approved. */
export function validateRoutineCommands(value) {
  if(value===null)return [];
  ensure(Array.isArray(value) && value.length<=MAX_ROUTINE_COMMANDS,400,`Give up to ${MAX_ROUTINE_COMMANDS} exact commands.`);
  return value.map(command=>{
    ensure(typeof command==='string' && command.trim() && command.length<=4000 && !command.includes('\0'),400,'Each pre-approved command must be one bash command of at most 4000 characters.');
    const classification=classifyCommand(command);
    ensure(classification.risk!=='dangerous',400,`This command is dangerous and always needs the owner at run time: ${classification.reasons[0] || 'unclassified risk'}.`);
    return {command,digest:commandDigest(command)};
  });
}

/** Classifies one terminal-family call from its exact arguments. */
export function classifyToolCall(call,{root,cwd}={}) {
  const args=call?.arguments || {};root ||= WORKSPACE_PLACEHOLDER;cwd ||= root;
  switch(call?.name) {
    case 'terminal': return classifyCommand(args.command,{workspaceRoot:root,cwd});
    case 'execute_code': return classifyCode(args.language,args.code);
    case 'shell_run':case 'shell_start': {
      const folder=typeof args.cwd==='string' && args.cwd && args.cwd!=='.'?`${root}/${args.cwd}`.replace(/\/+/g,'/'):root;
      return classifyArgv(args.executable,Array.isArray(args.args)?args.args:[],{workspaceRoot:root,cwd:folder});
    }
    default: return null;
  }
}

const relativeFolder=(root,cwd)=>!root || !cwd || cwd===root?'.':cwd.startsWith(root+'/')?cwd.slice(root.length+1):cwd;

/**
 * Pure decision for one call. Returns null for tools this policy does not own.
 * Inputs: context (task snapshot), currentBot, currentRoutine (state copy of context.routine),
 * session ({root,cwd} of the task terminal), integration/currentIntegration rows.
 */
export function decideAction({context,call,currentBot,currentRoutine,session,integration,execution}) {
  if(call?.name==='integration_call')return integrationDecision({context,call,currentBot,integration});
  if(!COMMAND_TOOLS.has(call?.name))return null;
  const policy=effectiveApprovalPolicy(context?.bot,currentBot);
  const classification=classifyToolCall(call,session || {});
  const command={risk:classification.risk,reasons:classification.reasons,...(call.name==='terminal' || call.name==='execute_code'?{cwd:relativeFolder(session?.root,session?.cwd)}:{})};
  const review={command};
  // Where the command runs is the task snapshot's choice; unattended isolation also needs the saved bot to agree.
  const where=executionNote(context?.bot,currentBot,execution),backend=where.runs;
  const manual=reason=>({automatic:false,reason:reason+where.note,review,classification,policy,backend});
  const automatic=reason=>({automatic:true,reason,review,classification,policy,backend});
  if(!currentBot || !Array.isArray(currentBot.tools) || !currentBot.tools.includes('terminal'))return manual('Terminal access is no longer enabled for this bot. Review this exact action.');
  if(classification.risk==='dangerous')return manual(`Dangerous: ${classification.reasons.join('; ') || 'unclassified risk'}. Review this exact action.`);
  // Inside a ready isolated backend, read-only and ordinary commands run in every lane, except under Strict.
  if(where.isolated && policy!=='strict')return automatic(`Ordinary command in this bot’s ${where.label}: it can change only the bot’s own folders.`);
  // shell_run/shell_start keep their earlier meaning: exact approval, except that Approve for me in the owner's
  // chat now relies on the classifier instead of a model review. The allowlist and pre-approvals are for terminal.
  if(call.name==='shell_run' || call.name==='shell_start') {
    if(policy==='auto' && ownerChat(context))return automatic('Approve for me: an ordinary command in your chat.');
    return manual(policy==='auto'?'Outside your own chat this command waits for your approval.':'This command waits for your approval.');
  }
  // An exact command the owner pre-approved for this routine runs in that routine's lane only.
  if(call.name==='terminal' && context?.routine?.id && currentRoutine?.id===context.routine.id && currentRoutine.botId===context.bot?.id) {
    const digest=commandDigest(call.arguments?.command);
    if([context.routine,currentRoutine].every(routine=>(routine.approvedCommands || []).some(item=>item.digest===digest)))return automatic('The owner pre-approved this exact command for this routine.');
  }
  if(policy==='strict')return manual('Strict review: every command waits for your approval.');
  if(classification.risk==='read_only')return automatic('Read-only command inside the workspace.');
  if(call.name!=='execute_code') {
    const snapshotMatch=allowlisted(classification,context?.bot?.commandAllowlist),currentMatch=allowlisted(classification,currentBot.commandAllowlist);
    if(snapshotMatch && currentMatch)return automatic(`Matches your allowed command “${currentMatch}”.`);
  }
  if(policy==='auto' && ownerChat(context))return automatic('Approve for me: an ordinary command in your chat.');
  return manual(policy==='auto'
    ?'This command can change files or run code outside your own chat. Allow it here, add it to the bot’s allowed commands, or pre-approve it for a routine.'
    :'This command can change files or run code. Review this exact action, or add it to the bot’s allowed commands.');
}

/**
 * Pure. `execution` is the admission-time readiness of the snapshot's backend ({backend,isolated,ready,reason}).
 * Isolation counts only when the snapshot and the saved bot select the same isolated backend and it is ready.
 */
function executionNote(snapshotBot,currentBot,execution) {
  const wanted=selectedBackend(snapshotBot);
  if(wanted==='host')return {runs:'host',isolated:false,note:''};
  const label=executionBackend(wanted)?.noun || wanted;
  const ready=execution?.backend===wanted && execution.ready===true;
  if(!ready)return {runs:'host',isolated:false,label,note:` The ${label} is unavailable (${execution?.backend===wanted && execution.reason || 'not checked yet'}), so this command would run on this computer without isolation.`};
  const isolated=Boolean(execution.isolated) && selectedBackend(currentBot)===wanted;
  return {runs:wanted,isolated,label,note:` It will run in this bot’s ${label}.`};
}

function integrationDecision({context,call,currentBot,integration}) {
  // Only an owner-marked REST GET runs without review; everything else keeps the existing path.
  const tool=integration?.tools?.find(item=>item.name===call.arguments?.tool);
  if(!tool || tool.approval!=='auto' || integration.type!=='rest' || tool.method!=='GET')return null;
  const policy=effectiveApprovalPolicy(context?.bot,currentBot);
  if(policy==='strict')return null;
  const assigned=[context?.bot,currentBot].every(bot=>Array.isArray(bot?.integrationIds) && bot.integrationIds.includes(integration.id) && Array.isArray(bot.tools) && bot.tools.includes('integrations'));
  if(!assigned)return null;
  return {automatic:true,reason:`You set ${integration.name || 'this service'} · ${tool.name} to run without asking (read-only GET).`};
}

// Admission-time readiness of the task's execution backend, per task context (see prepareActionDecision).
const readiness=new WeakMap();
/** Engine adapter, asynchronous part: checks the snapshot's execution backend before the synchronous decision. */
export async function prepareActionDecision(engine,context,call) {
  if(!COMMAND_TOOLS.has(call?.name) || selectedBackend(context?.bot)==='host')return;
  readiness.set(context,await executionReadiness({store:engine.store,bot:context.bot}));
}

/** Engine adapter: gathers current state for decideAction. Synchronous so it can be re-checked. */
export function engineActionDecision(engine,context,call) {
  if(!COMMAND_TOOLS.has(call?.name) && call?.name!=='integration_call')return null;
  const state=engine.store.state,currentBot=state.bots.find(bot=>bot.id===context.bot.id);
  const currentRoutine=context.routine?.id?state.routines?.find(routine=>routine.id===context.routine.id):null;
  const integration=call.name==='integration_call'?state.integrations?.find(row=>row.id===call.arguments?.integrationId):null;
  if(call.name==='integration_call')return decideAction({context,call,currentBot,integration});
  const terminal=engine.tools?.terminal,root=terminal?.rootHint?.(context.bot.id) || null;
  const session=terminal?.peek(context.bot.id,context.runId) || {root,cwd:root};
  const execution=readiness.get(context) || null,decision=decideAction({context,call,currentBot,currentRoutine,session,execution});
  // A command decided while the selected backend was not ready may run on the host (the card said so);
  // every other command of a non-host bot must run in its backend or not at all.
  if(selectedBackend(context.bot)!=='host' && !(execution?.backend===selectedBackend(context.bot) && execution.ready))noteHostFallback(call.arguments,execution?.reason || 'not checked yet');
  else clearHostFallback(call.arguments);
  return decision;
}
