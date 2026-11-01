import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEngine } from '../lib/engine.mjs';
import { Questions } from '../lib/questions.mjs';
import { BrowserControl } from '../lib/browser-control.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const QUESTION = { questions: [{ id: 'format', header: 'Format', prompt: 'Which synthetic format?' }] };
const BROWSER = { reason: 'Use the existing private browser session.' };

// Keep actual NativeEngine deadline/pause/resume/update/assertion code. Only Store I/O,
// Mission presentation and the already-open browser session are narrow synthetic fixtures.
function fixture(t, kind, { slowAt = 0, failAt = 0, holdAt = 0 } = {}) {
  const engine = Object.create(NativeEngine.prototype), publication = deferred(), release = deferred();
  const run = { id: 'run_wait', botId: 'bot_wait', remoteRunId: 'remote_wait', source: 'chat', status: 'running', execution_generation: 1, events: [], pending_controls: [] };
  const state = { runs: { bot_wait: run } };
  let mutations = 0, pauses = 0, resumes = 0;
  engine.closing = false; engine.options = {}; engine.missions = { onRunUpdate() {} }; engine.controllers = new Map();
  engine.store = { state, redact: value => value, redactValue: value => structuredClone(value), async mutate(fn) {
    const index = ++mutations;
    if (index === failAt) throw new Error('Synthetic publication storage failure.');
    if (index === holdAt) { publication.resolve(); await release.promise; }
    const result = await fn(state);
    if (index === slowAt) { publication.resolve(); await delay(220); }
    return result;
  } };
  const context = { runId: run.id, sessionId: run.botId, source: 'chat', lane: 'chat', bot: { id: run.botId, tools: ['browser'] }, controller: new AbortController() };
  context.ceilingAt = Date.now() + 150; engine.deadline(context, 150); engine.controllers.set(run.id, context.controller);
  const pause = engine.pauseForInput.bind(engine), resume = engine.resumeAfterInput.bind(engine);
  engine.pauseForInput = input => { pauses++; return pause(input); };
  engine.resumeAfterInput = input => { resumes++; return resume(input); };
  engine.browsers = { sessions: new Map([[run.id, { botId: run.botId }]]) };
  const manager = kind === 'question' ? new Questions(engine) : new BrowserControl(engine);
  t.after(() => { clearTimeout(context.timer); context.controller.abort(new Error('Fixture cleanup.')); manager.close(); });
  return { engine, run, context, manager, publication, release, args: kind === 'question' ? QUESTION : BROWSER, get counts() { return { mutations, pauses, resumes }; } };
}

for (const kind of ['question', 'browser']) {
  for (const slowAt of [1, 2]) test(`${kind} excludes slow ${slowAt === 1 ? 'waiting-state' : 'event'} Store publication from the fixed 150ms runtime`, async t => {
    const f = fixture(t, kind, { slowAt }), waiting = f.manager.ask(f.context, f.args); void waiting.catch(() => {});
    await f.publication.promise;
    assert.ok(f.context.paused); assert.equal(f.counts.pauses, 1);
    await delay(240);
    assert.equal(f.context.controller.signal.aborted, false, '220ms Store publication must not spend a 150ms runtime budget');
    assert.equal(f.run.status, 'waiting_for_input');
    f.manager.pending.get(f.run.id).resolve({ syntheticAnswer: true });
    assert.deepEqual(await waiting, { syntheticAnswer: true });
    assert.equal(f.manager.pending.size, 0); assert.equal(f.context.paused, undefined); assert.equal(f.counts.resumes, 1);
    assert.equal(f.run.status, 'running'); assert.deepEqual(f.run.pending_controls, []);
    assert.equal(f.context.controller.signal.aborted, false);
    await delay(170);
    assert.equal(f.context.controller.signal.aborted, true, 'the saved runtime timer must resume after the owner wait ends');
    assert.equal(f.context.controller.signal.reason.name, 'TimeoutError');
  });

  for (const failAt of [1, 2]) test(`${kind} publication failure at Store step ${failAt} unregisters pending state and resumes the saved timer`, async t => {
    const f = fixture(t, kind, { failAt });
    await assert.rejects(f.manager.ask(f.context, f.args), /publication storage failure/);
    assert.equal(f.manager.pending.size, 0); assert.equal(f.context.paused, undefined);
    assert.equal(f.counts.pauses, 1); assert.equal(f.counts.resumes, 1);
    assert.equal(f.run.status, 'running'); assert.deepEqual(f.run.pending_controls, []);
    await delay(170); assert.equal(f.context.controller.signal.aborted, true); assert.equal(f.context.controller.signal.reason.name, 'TimeoutError');
  });

  test(`${kind} Stop winning before an awaited waiting publication cannot be overwritten or reopen controls`, async t => {
    const f = fixture(t, kind, { holdAt: 1 }), waiting = f.manager.ask(f.context, f.args); void waiting.catch(() => {});
    await f.publication.promise; assert.ok(f.context.paused);
    const stopped = new Error('Owner stopped before publication committed.');
    f.run.stopRequested = true; f.run.status = 'stopping'; f.context.controller.abort(stopped); f.release.resolve();
    await assert.rejects(waiting, error => error === stopped);
    assert.equal(f.run.status, 'stopping'); assert.deepEqual(f.run.pending_controls, []);
    assert.equal(f.manager.pending.size, 0); assert.equal(f.context.paused, undefined); assert.equal(f.counts.resumes, 1);
    await delay(170); assert.equal(f.context.controller.signal.reason, stopped, 'a resumed timeout cannot replace durable owner cancellation');
  });

  test(`${kind} Abort during slow published Store I/O removes its rendezvous without returning to running`, async t => {
    const f = fixture(t, kind, { slowAt: 1 }), waiting = f.manager.ask(f.context, f.args); void waiting.catch(() => {});
    await f.publication.promise;
    const stopped = new Error('Owner cancelled during publication.');
    f.run.stopRequested = true; f.run.status = 'stopping'; f.run.pending_controls = []; f.context.controller.abort(stopped);
    await assert.rejects(waiting, error => error === stopped);
    assert.equal(f.run.status, 'stopping'); assert.deepEqual(f.run.pending_controls, []); assert.equal(f.manager.pending.size, 0); assert.equal(f.context.paused, undefined);
  });

  test(`${kind} rejected arguments and unattended sources never pause the task`, async t => {
    const f = fixture(t, kind);
    await assert.rejects(f.manager.ask(f.context, kind === 'question' ? { questions: [] } : { reason: '' }));
    await assert.rejects(f.manager.ask({ ...f.context, source: 'routine', lane: 'routine:fixture' }, f.args));
    assert.equal(f.counts.pauses, 0); assert.equal(f.counts.mutations, 0); assert.equal(f.manager.pending.size, 0); assert.equal(f.context.paused, undefined);
  });
}

test('browser missing/foreign sessions and disabled Browser tools fail before pausing', async t => {
  const f = fixture(t, 'browser');
  f.engine.browsers.sessions.clear(); await assert.rejects(f.manager.ask(f.context, f.args), /Open this task/);
  f.engine.browsers.sessions.set(f.run.id, { botId: 'another_bot' }); await assert.rejects(f.manager.ask(f.context, f.args), /Open this task/);
  await assert.rejects(f.manager.ask({ ...f.context, bot: { ...f.context.bot, tools: [] } }, f.args), /Browser tools/);
  assert.equal(f.counts.pauses, 0); assert.equal(f.counts.mutations, 0); assert.equal(f.manager.pending.size, 0);
});

for(const kind of ['question','browser'])test(`${kind} derived cancellation invalidates owner control during delayed event publication`,async t=>{
 const f=fixture(t,kind,{holdAt:2}),derived=new AbortController(),waiting=f.manager.ask(f.context,f.args,{signal:derived.signal});void waiting.catch(()=>{});await f.publication.promise;const pending=f.manager.pending.get(f.run.id),input={runId:f.run.id,remoteRunId:f.run.remoteRunId,request_id:pending.promptId,execution_generation:pending.generation};derived.abort(new Error('Synthetic absolute resource deadline.'));
 if(kind==='question')await assert.rejects(f.manager.answer(f.run.botId,input),error=>error.status===409);else assert.throws(()=>f.manager.current(f.run.botId,input),error=>error.status===409);
 assert.equal(f.context.controller.signal.aborted,false);assert.equal(f.run.questionResponses,undefined);f.release.resolve();await assert.rejects(waiting,/absolute resource deadline/);assert.equal(f.manager.pending.size,0);assert.equal(f.context.paused,undefined);assert.equal(f.counts.resumes,1);
});
