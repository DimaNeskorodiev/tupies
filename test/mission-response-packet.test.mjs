import test from 'node:test';
import assert from 'node:assert/strict';
import { missionResponsePacket } from '../lib/mission-evidence.mjs';

const observations = () => Array.from({ length: 40 }, (_, index) => ({ callId: `call_${index}`, tool: 'http_fetch', resultDigest: String(index).padStart(64, '0'), url: `https://example.com/source-${index}`, observation: 'Actual synthetic source content. '.repeat(220), observationTruncated: false }));

test('only exactly referenced sources support the bounded final packet', () => {
  const packet = JSON.parse(missionResponsePacket('Compare https://example.com/source-38 and [source](https://example.com/source-39).', observations()));
  assert.deepEqual(packet.observedSources.map(row => row.callId), ['call_38', 'call_39']);
  assert.equal(packet.omittedUncitedSources, 38); assert.equal(packet.omittedSelectedSources, 0); assert.equal(packet.sourceCoverage, 'retained_observations');
});

test('aggregate bounds are counted in bytes and disclose missing selected observations', () => {
  const source = observations(); source[0].observation = 'Український текст. '.repeat(500);
  const text = missionResponsePacket('A final source-based result without explicit source selection.', source), packet = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) <= 48000); assert.equal(packet.sourceCoverage, 'partial');
  assert.ok(packet.omittedSelectedSources > 0); assert.equal(packet.observedSources.at(-1).observationTruncated, true);
  assert.equal(source[0].observationTruncated, false);
});

test('missing source bodies remain partial and invented citations do not fabricate observations', () => {
  const row = { ...observations()[0], observation: null };
  const packet = JSON.parse(missionResponsePacket('Read https://example.com/source-0.', [row]));
  assert.equal(packet.sourceCoverage, 'partial'); assert.equal(packet.observedSources[0].observation, null);
  const empty = JSON.parse(missionResponsePacket('An invented citation: https://example.com/invented.', []));
  assert.equal(empty.observedSources.length, 0);
});

test('private path selection uses full path boundaries and keeps quote/backslash overhead bounded', () => {
  const source = [{ callId: 'short', path: 'Docs/report.md', observation: 'short' }, { callId: 'long', path: 'Docs/report.md.bak', observation: '\\"'.repeat(50000) }];
  const text = missionResponsePacket('Inspect Docs/report.md.bak.', source), packet = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) <= 48000); assert.deepEqual(packet.observedSources.map(row => row.callId), ['long']); assert.equal(packet.sourceCoverage, 'partial');
});

test('an oversized final response is refused rather than silently shortened or accepted', () => {
  assert.throws(() => missionResponsePacket('я'.repeat(30000), []), error => error.status === 413 && /bounded Mission review/.test(error.message));
});
