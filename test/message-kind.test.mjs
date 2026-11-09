import test from 'node:test';
import assert from 'node:assert/strict';
import { compactConversation, historyForProvider } from '../lib/engine.mjs';
import { planCompaction, summaryMessage, fallbackSummary, userQuotes } from '../lib/compaction.mjs';
import { taskHistory } from '../lib/task-context.mjs';
import { messageKind, isTurnStart, withoutKind, MESSAGE_KINDS } from '../lib/message-kind.mjs';

const big='x'.repeat(3000);
const call=(id)=>({role:'assistant',content:'',tool_calls:[{id,type:'function',function:{name:'http_fetch',arguments:'{}'}}]});
const result=(id,content=big)=>({role:'tool',tool_call_id:id,content});
const feedback=()=>({role:'user',kind:MESSAGE_KINDS.feedback,content:'Engine execution feedback for this same task (no new permission): keep going\nKeep working on the requested outcome.'});
const measure=message=>JSON.stringify(message).length;

test('engine feedback does not start a new task, so current-task outputs are not cleared as earlier ones',()=>{
  const conversation=[
    {role:'user',content:'earlier question'},call('a'),result('a'),{role:'assistant',content:'earlier answer'},
    {role:'user',content:'current task'},call('b'),result('b','current-output '+big),feedback(),call('c'),result('c','recent '+big),feedback()
  ];
  const out=compactConversation('system',conversation,{limit:2600,hard:100_000,measure});
  const byId=id=>out.messages.find(message=>message.tool_call_id===id)?.content;
  assert.match(byId('a'),/earlier task cleared/);
  // The oldest current-task output may be shortened for space, but never reported as an earlier task's output.
  assert.doesNotMatch(byId('b') || '',/from an earlier task cleared/);
  assert.doesNotMatch(byId('c') || '',/from an earlier task cleared/);
  assert.equal(out.cleared,1);
});

test('the compaction summary survives whole-turn dropping and feedback is never a drop boundary',()=>{
  const summary=summaryMessage('Earlier work.',[{role:'user',content:'old'}],{count:3});
  const conversation=[summary];
  for(let i=0;i<6;i++)conversation.push({role:'user',content:`question ${i}`},call(`k${i}`),result(`k${i}`,'r'.repeat(150)),{role:'assistant',content:big});
  conversation.push({role:'user',content:'now'},feedback(),call('z'),result('z','r'.repeat(150)),feedback());
  const out=compactConversation('system',conversation,{limit:3500,hard:100_000,measure});
  assert.ok(out.omitted>0);
  assert.equal(out.messages[1].kind,MESSAGE_KINDS.summary);
  assert.ok(out.messages.some(message=>message.content==='now'));
  assert.ok(out.messages.some(message=>message.tool_call_id==='z'));
  // The kept part begins with a real user turn after the pinned summary, never with feedback or an orphan tool result.
  assert.equal(out.messages[2].role,'user');assert.equal(isTurnStart(out.messages[2]),true);
  // Same behaviour for a summary stored before `kind` existed.
  const legacy={...summary};delete legacy.kind;
  const old=compactConversation('system',[legacy,...conversation.slice(1)],{limit:3500,hard:100_000,measure});
  assert.match(old.messages[1].content,/^<conversation_summary>/);
});

test('earlier-task context at the head is pinned and not a turn boundary',()=>{
  const background={role:'user',kind:MESSAGE_KINDS.earlier,content:'<earlier_task_context>\n{}\n</earlier_task_context>'};
  const conversation=[background,{role:'user',content:'t1'},call('p'),result('p'),{role:'user',content:'t2'},call('q'),result('q','r'.repeat(100))];
  const out=compactConversation('system',conversation,{limit:1500,hard:100_000,measure});
  assert.equal(out.messages[1].kind,MESSAGE_KINDS.earlier);
  assert.ok(out.messages.some(message=>message.content==='t2'));
});

test('legacy engine messages without kind are recognised conservatively',()=>{
  const legacy=text=>({role:'user',content:text,runId:'r'});
  assert.equal(messageKind(legacy('Engine execution feedback for this same task (no new permission): x')),MESSAGE_KINDS.feedback);
  assert.equal(messageKind(legacy('Engine recovery of the same authorized task: continue')),MESSAGE_KINDS.feedback);
  assert.equal(messageKind(legacy('Deterministic routine preparation has finished. Its results')),MESSAGE_KINDS.feedback);
  assert.equal(messageKind(legacy('<earlier_task_context>\n{}')),MESSAGE_KINDS.earlier);
  assert.equal(messageKind({role:'user',compaction:true,content:'x'}),MESSAGE_KINDS.summary);
  // Real messages stay real: an owner message that merely quotes the text, or carries a sourceMessageId, is not engine-injected.
  assert.equal(messageKind(legacy('Please explain "Engine execution feedback for this same task"')),null);
  assert.equal(messageKind({role:'user',sourceMessageId:'m1',content:'Engine execution feedback for this same task (no new permission): x'}),null);
  assert.equal(messageKind({role:'assistant',content:'Engine execution feedback for this same task (no new permission): x'}),null);
});

test('planning and summaries treat feedback as engine notes, not user requests',()=>{
  const conversation=[{role:'user',content:'q1'},call('a'),result('a','r'),{role:'user',content:'q2'},feedback(),call('b'),result('b','r')];
  assert.deepEqual(planCompaction(conversation,{keepFrom:3,tailTokens:0}),{cut:3});
  assert.equal(planCompaction([feedback(),...conversation.slice(0,0)],{keepFrom:1,tailTokens:0}),null);
  assert.doesNotMatch(fallbackSummary(conversation),/Engine execution feedback/);
  assert.doesNotMatch(userQuotes(conversation),/Engine execution feedback/);
});

test('earlier task background carries the marker and providers never see it',()=>{
  const old=[{role:'user',content:'first',runId:'r1'},call('a'),result('a','t'.repeat(40000)),{role:'assistant',content:'done',runId:'r1'},{role:'user',content:'second',runId:'r2'}];
  const scoped=taskHistory(old,{runId:'r2',priorTokens:500});
  assert.equal(scoped.messages[0].kind,MESSAGE_KINDS.earlier);
  const stripped=withoutKind(historyForProvider([feedback(),summaryMessage('s',[],{count:1}),{role:'user',content:'hi'}],{}));
  assert.ok(stripped.every(message=>!('kind' in message)));
  assert.equal(stripped[1].compaction,true);
});
