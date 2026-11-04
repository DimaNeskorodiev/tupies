import test from 'node:test';
import assert from 'node:assert/strict';
import { MISSION_START_DEFINITION, validateMissionIntent } from '../lib/mission-intent.mjs';

const owner = { id: 'owner_message', content: 'Run the launch as a staged process with a review checkpoint between phases. Produce a market research report. Build the release candidate from the report. Deliver an independently verified rollout package after the build.' };
const decision = () => ({ intent: 'clear_goal', ownerMessageId: owner.id, scope: {
  outcomes: [
    { quote: 'Produce a market research report.', kind: 'deliverable', dependsOn: [] },
    { quote: 'Build the release candidate from the report.', kind: 'change', dependsOn: [0] },
    { quote: 'Deliver an independently verified rollout package after the build.', kind: 'deliverable', dependsOn: [1] },
  ],
  process: { kind: 'staged_execution', quote: 'Run the launch as a staged process with a review checkpoint between phases.' },
} });
const rejected = (input, source = owner) => assert.throws(() => validateMissionIntent(input, source), error => error.status === 400 && /ordinary chat/.test(error.message));

test('a large connected process retains bounded owner evidence for its admission decision', () => {
  const input = decision(), admitted = validateMissionIntent(input, owner);
  assert.equal(admitted.schemaVersion, 1); assert.equal(admitted.intent, 'clear_goal');
  assert.deepEqual(admitted.scope, input.scope);
  input.scope.outcomes[1].dependsOn.push(5);
  assert.deepEqual(admitted.scope.outcomes[1].dependsOn, [0], 'retained evidence is not a mutable model object');
});

test('explicit Mission intent requires an exact owner quote naming the mode', () => {
  for (const content of ['Create a Mission to choose a domain.', 'Створи місію для вибору домену.', 'Crea una Mission para elegir un dominio.']) {
    const admitted = validateMissionIntent({ intent: 'explicit', ownerMessageId: owner.id, explicitRequest: content }, { ...owner, content });
    assert.equal(admitted.explicitRequest, content);
  }
  rejected({ intent: 'explicit', ownerMessageId: owner.id });
  rejected({ intent: 'explicit', ownerMessageId: owner.id, explicitRequest: 'Create a Mission.' });
  rejected({ intent: 'explicit', ownerMessageId: owner.id, explicitRequest: owner.content });
});

test('legacy clear_goal alone cannot create an automatic Mission', () => rejected({ intent: 'clear_goal', ownerMessageId: owner.id }));

for (const [name, edit] of [
  ['wrong owner identity', input => { input.ownerMessageId = 'another_owner'; }],
  ['invented outcome', input => { input.scope.outcomes[0].quote = 'Invent an extra report.'; }],
  ['invented process need', input => { input.scope.process.quote = 'Wait for external dependencies every week.'; }],
  ['only two outcomes', input => { input.scope.outcomes.pop(); }],
  ['unconnected supporting actions', input => { input.scope.outcomes[2].dependsOn = []; }],
  ['a cyclic dependency', input => { input.scope.outcomes[0].dependsOn = [2]; }],
  ['a self dependency', input => { input.scope.outcomes[1].dependsOn = [1]; }],
  ['repeated dependencies', input => { input.scope.outcomes[1].dependsOn = [0, 0]; }],
  ['duplicate outcome evidence', input => { input.scope.outcomes[1].quote = input.scope.outcomes[0].quote; }],
  ['overlapping outcome evidence', input => { input.scope.outcomes[1].quote = 'market research report.'; }],
  ['reusing an outcome as process evidence', input => { input.scope.process.quote = input.scope.outcomes[2].quote; }],
  ['no separate process requirement', input => { delete input.scope.process; }],
  ['tool calls as outcome kinds', input => { input.scope.outcomes[0].kind = 'browser_call'; }],
  ['effort alone as process need', input => { input.scope.process.kind = 'high_effort'; }],
  ['extra model authority', input => { input.scope.approved = true; }],
  ['mixing explicit and inferred intent', input => { input.explicitRequest = owner.content; }],
]) test(`automatic Mission admission refuses ${name}`, () => { const input = decision(); edit(input); rejected(input); });

test('the domain recommendation cannot acquire fabricated large-process evidence or explicit intent', () => {
  const source = { ...owner, content: 'Я зараз шукаю домен для Tupies. Пошукай тут https://dash.cloudflare.com/domains/registrations/purchase?query=tupies який домен краще підійде.' };
  rejected(decision(), source);
  rejected({ intent: 'explicit', ownerMessageId: source.id, explicitRequest: source.content }, source);
});

test('bounded decision fields cannot hide malformed or oversized evidence', () => {
  for (const value of [null, [], {}, { ...decision(), intent: 'probably' }, { ...decision(), override: true }]) rejected(value);
  const oversized = decision(); oversized.scope.outcomes[0].quote = 'a'.repeat(1201); rejected(oversized);
  const excessive = decision(); excessive.scope.outcomes = Array(7).fill(excessive.scope.outcomes[0]); rejected(excessive);
});

test('model instructions distinguish small autonomous tasks from large durable processes', () => {
  const description = MISSION_START_DEFINITION.description;
  for (const phrase of ['Ordinary chat is the default', 'domain/product comparison', 'one report/document', 'login, approvals', 'When uncertain', 'Negated, quoted, hypothetical', 'at least three distinct']) assert.ok(description.includes(phrase), phrase);
  assert.equal(MISSION_START_DEFINITION.parameters.additionalProperties, false);
});
