import test from 'node:test';
import assert from 'node:assert/strict';
import { createMissionContract, validateMissionContract, refineMissionContract, reviseMissionContract } from '../lib/mission-contract.mjs';

const ownerSource = { id: 'owner_1', text: 'Create a report with checked sources and an exact summary.' };
const requirement = (id = 'report') => ({ id, text: 'Create the report.', source: { ownerId: ownerSource.id, quote: 'Create a report' }, checker: { kind: 'file_exists', path: 'Documents/report.md' } });
const create = requirements => createMissionContract({ goal: ownerSource.text, ownerSource, requirements });

test('Mission contract is bounded, versioned and bound to exact owner text', () => {
  const contract = create([requirement()]);
  assert.equal(contract.version, 1); assert.equal(contract.requirements[0].id, 'report');
  assert.equal(validateMissionContract(contract), contract);
  assert.throws(() => create([{ ...requirement(), source: { ownerId: 'model', quote: 'Create a report' } }]), /owner source/);
  assert.throws(() => create([{ ...requirement(), source: { ownerId: 'owner_1', quote: 'Invent a new goal' } }]), /owner source/);
  assert.throws(() => create([requirement(), requirement()]), /unique/);
  assert.throws(() => create(Array.from({ length: 25 }, (_, index) => requirement(`item_${index}`))), /24/);
});

test('empty criteria remain explicitly unconfigured', () => {
  assert.deepEqual(create([]).requirements, []);
});

test('model refinements retain exact previous predicates and use version CAS', () => {
  const original = create([requirement()]);
  assert.throws(() => refineMissionContract(original, [], { expectedVersion: 1 }), /removed or weakened/);
  assert.throws(() => refineMissionContract(original, [{ ...requirement(), checker: { kind: 'file_exists', path: 'easier.md' } }], { expectedVersion: 1 }), /removed or weakened/);
  assert.throws(() => refineMissionContract(original, original.requirements, { expectedVersion: 0 }), /changed/);
  const next = refineMissionContract(original, [...original.requirements, requirement('summary')], { expectedVersion: 1 });
  assert.equal(next.version, 2); assert.equal(next.previousDigest, original.digest);
  assert.equal(original.requirements.length, 1); validateMissionContract(next);
});

test('owner scope changes create a new historical identity without rewriting old contracts', () => {
  const original = create([requirement()]);
  assert.throws(() => reviseMissionContract(original, { goal: ownerSource.text, ownerSource, requirements: [] }, { expectedVersion: 1 }), /new owner submission/);
  const next = reviseMissionContract(original, { goal: 'A changed goal', ownerSource: { id: 'owner_2', text: 'A changed goal' }, requirements: [] }, { expectedVersion: 1 });
  assert.equal(next.version, 2); assert.equal(next.previousDigest, original.digest); assert.equal(original.version, 1);
  validateMissionContract(next);
  assert.throws(() => validateMissionContract({ ...original, goal: 'tampered' }), /identity/);
});

test('unsafe paths and checker payloads cannot become contract predicates', () => {
  for (const path of ['/tmp/report', '../report', 'a/../report', 'a\\report', 'C:/report', 'a//report']) assert.throws(() => create([{ ...requirement(), checker: { kind: 'file_exists', path } }]), /relative/);
  assert.throws(() => create([{ ...requirement(), checker: { kind: 'file_exists', path: 'report.md', url: 'https://invented.example' } }]), /fields/);
  assert.throws(() => create([{ ...requirement(), required: false }]), /optional/);
  assert.throws(() => create([{ ...requirement(), checker: { kind: 'rubric', rubric: 'Looks good', rubricVersion: '' } }]), /rubric/);
});
