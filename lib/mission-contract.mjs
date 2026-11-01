import { createHash } from 'node:crypto';
import { ensure, id } from './store.mjs';

export const MISSION_CONTRACT_SCHEMA = 1;
export const MISSION_REQUIREMENT_LIMIT = 24;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const missionDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const identity = value => typeof value === 'string' && /^[\w-]{1,120}$/.test(value);
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
export const missionPrivatePath = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !value.startsWith('/') && !/^[a-z]:/i.test(value) && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');

function source(input) {
  ensure(fields(input, ['id', 'text', 'kind']) && identity(input.id) && text(input.text, 24000), 400, 'Bind the contract to an exact owner submission and its text.');
  ensure(input.kind === undefined || ['message', 'submission', 'revision'].includes(input.kind), 400, 'Use an owner submission source.');
  return structuredClone(input);
}

function checker(input) {
  ensure(fields(input, ['kind', 'path', 'value', 'callId', 'delegationId', 'rubric', 'rubricVersion']), 400, 'Use supported Mission checker fields.');
  const kind = input.kind;
  ensure(['file_exists', 'file_contains', 'file_sha256', 'source_read', 'command_success', 'teammate_completed', 'rubric', 'human_acceptance'].includes(kind), 400, 'Choose a supported Mission checker.');
  if (kind.startsWith('file_')) {
    ensure(missionPrivatePath(input.path), 400, 'Use a private relative file path.');
    ensure(input.callId === undefined && input.delegationId === undefined && input.rubric === undefined && input.rubricVersion === undefined, 400, 'File checkers contain only a path and expected value.');
    if (kind === 'file_contains') ensure(text(input.value, 4000), 400, 'Give literal expected file content.');
    else if (kind === 'file_sha256') ensure(typeof input.value === 'string' && /^[a-f0-9]{64}$/.test(input.value), 400, 'Use a complete file SHA-256.');
    else ensure(input.value === undefined, 400, 'File existence has no expected value.');
  } else if (kind === 'rubric') {
    ensure(text(input.rubric, 8000) && identity(input.rubricVersion), 400, 'Use a bounded fixed rubric and rubric version.');
    ensure(input.path === undefined && input.value === undefined && input.callId === undefined && input.delegationId === undefined, 400, 'Rubric checkers do not contain tool identities.');
  } else {
    ensure(input.path === undefined && input.value === undefined && input.rubric === undefined && input.rubricVersion === undefined, 400, 'Use only the checker identity.');
    ensure(input.callId === undefined || identity(input.callId), 400, 'Use an exact tool call identity.');
    ensure(input.delegationId === undefined || kind === 'teammate_completed' && identity(input.delegationId), 400, 'Only teammate checks use delegation identities.');
    ensure(!(input.callId && input.delegationId), 400, 'Use one exact delegation or call identity.');
  }
  return structuredClone(input);
}

function requirements(input, ownerSource) {
  ensure(Array.isArray(input) && input.length <= MISSION_REQUIREMENT_LIMIT, 400, 'Use at most 24 Mission requirements.');
  const ids = new Set();
  return input.map(item => {
    ensure(fields(item, ['id', 'text', 'source', 'checker', 'required']) && text(item.text, 2000), 400, 'Use a bounded requirement and checker.');
    const requirementId = item.id ?? id('requirement');
    ensure(identity(requirementId) && !ids.has(requirementId), 400, 'Requirement IDs must be unique and stable.'); ids.add(requirementId);
    ensure(item.required === undefined || item.required === true, 400, 'Mission acceptance requirements cannot be optional.');
    ensure(fields(item.source, ['ownerId', 'quote']) && item.source.ownerId === ownerSource.id && text(item.source.quote, 4000) && ownerSource.text.includes(item.source.quote), 400, 'Each requirement needs an exact quote from its owner source.');
    return { id: requirementId, text: item.text, source: structuredClone(item.source), checker: checker(item.checker), required: true };
  });
}

export function createMissionContract({ goal, requirements: items = [], ownerSource } = {}) {
  ensure(text(goal, 12000), 400, 'Give a Mission goal of 1–12000 characters.');
  const owner = source(ownerSource);
  const result = { schemaVersion: MISSION_CONTRACT_SCHEMA, version: 1, goal, ownerSource: owner, requirements: requirements(items, owner) };
  return { ...result, digest: missionDigest(result) };
}

export function validateMissionContract(contract) {
  ensure(fields(contract, ['schemaVersion', 'version', 'goal', 'ownerSource', 'requirements', 'digest', 'previousDigest']) && contract.schemaVersion === MISSION_CONTRACT_SCHEMA && Number.isSafeInteger(contract.version) && contract.version >= 1, 400, 'Unsupported Mission contract schema or version.');
  const normalized = createMissionContract(contract);
  const { digest, ...body } = contract;
  ensure(normalized.goal === contract.goal && missionDigest(normalized.requirements) === missionDigest(contract.requirements) && /^[a-f0-9]{64}$/.test(digest) && missionDigest(body) === digest, 409, 'Mission contract identity is invalid.');
  ensure(contract.previousDigest === undefined || /^[a-f0-9]{64}$/.test(contract.previousDigest), 400, 'Invalid previous contract identity.');
  return contract;
}

export function assertMissionContractVersion(contract, expectedVersion) {
  validateMissionContract(contract);
  ensure(Number.isSafeInteger(expectedVersion) && expectedVersion === contract.version, 409, 'The Mission contract changed. Read its current version.');
}

/** Owner-only callers retain the previous contract in the same Store commit. */
export function reviseMissionContract(contract, input, { expectedVersion } = {}) {
  assertMissionContractVersion(contract, expectedVersion);
  const next = createMissionContract(input);
  ensure(next.ownerSource.id !== contract.ownerSource.id, 409, 'A goal revision needs a new owner submission identity.');
  const { digest, ...body } = next;
  const revised = { ...body, version: contract.version + 1, previousDigest: contract.digest };
  return { ...revised, digest: missionDigest(revised) };
}

/** Model refinement may add criteria; it cannot remove or weaken a fixed requirement. */
export function refineMissionContract(contract, items, { expectedVersion } = {}) {
  assertMissionContractVersion(contract, expectedVersion);
  const normalized = requirements(items, contract.ownerSource);
  for (const previous of contract.requirements) ensure(normalized.some(item => item.id === previous.id && missionDigest(item) === missionDigest(previous)), 409, 'Fixed Mission requirements cannot be removed or weakened.');
  if (missionDigest(normalized) === missionDigest(contract.requirements)) return structuredClone(contract);
  const { digest, ...body } = contract;
  const next = { ...body, version: contract.version + 1, requirements: normalized, previousDigest: digest };
  return { ...next, digest: missionDigest(next) };
}
