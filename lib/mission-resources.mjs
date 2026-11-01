import { createHash } from 'node:crypto';
import { HttpError } from './store.mjs';

export const MISSION_RESOURCE_DIMENSIONS = Object.freeze(['tokens', 'moneyMicros', 'requests', 'toolCalls', 'computeMs']);
const dimensions = MISSION_RESOURCE_DIMENSIONS;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_:.\/-]{1,200}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => digest(canonical(a)) === digest(canonical(b));
function fail(code, message, dimension, reason, status = 409) { const error = new HttpError(status, message); Object.assign(error, { code, ...(dimension ? { dimension } : {}), ...(reason ? { reason } : {}) }); throw error; }
function valid(condition, message) { if (!condition) fail('mission_resource_invalid', message, undefined, 'invalid_schema', 400); }
const integer = value => Number.isSafeInteger(value) && value >= 0;
const empty = () => Object.fromEntries(dimensions.map(key => [key, 0]));
function add(a, b, dimension) { valid(integer(a) && integer(b) && Number.isSafeInteger(a + b), `Mission ${dimension} accounting exceeds its safe integer range.`); return a + b; }
function clock(value = Date.now()) { valid(integer(value), 'Use an exact nonnegative resource timestamp.'); return value; }
function quantities(value = {}) {
  valid(plain(value) && Object.keys(value).every(key => dimensions.includes(key)), 'Use supported Mission resource dimensions.');
  for (const number of Object.values(value)) valid(integer(number), 'Resource quantities must be nonnegative safe integers.');
  return { ...value };
}
function limits(value = {}) {
  valid(plain(value) && Object.keys(value).every(key => [...dimensions, 'deadlineAt'].includes(key)), 'Use supported Mission resource limits.');
  const result = {};
  for (const [key, number] of Object.entries(value)) { valid(number === null || integer(number), 'Resource limits must be nonnegative safe integers or null.'); if (number !== null) result[key] = number; }
  return result;
}
function checkLedger(ledger) { valid(plain(ledger) && ledger.schemaVersion === 1 && integer(ledger.revision) && ledger.revision > 0 && ledger.revision < Number.MAX_SAFE_INTEGER && plain(ledger.operations) && plain(ledger.adoptions), 'Unsupported Mission resource ledger.'); }
function cas(ledger, expectedRevision) { checkLedger(ledger); if (expectedRevision !== undefined && expectedRevision !== ledger.revision) fail('mission_resource_changed', 'Mission resources changed. Read the current revision.'); }
function touch(ledger, now) { ledger.revision = add(ledger.revision, 1, 'revision'); ledger.updatedAt = now; }
function assertAdmission(ledger, now) {
  if (ledger.admissionState !== 'open') fail('mission_resource_unavailable', `Resource dispatch is ${ledger.admissionState}; no new operation was admitted.`, undefined, ledger.admissionState);
  if (ledger.limits.deadlineAt !== undefined && now >= ledger.limits.deadlineAt) fail('mission_expired', 'The Mission deadline has expired.', 'deadlineAt', 'deadline');
}

/** Engine-owned state. All mutations below belong inside the existing serialized Store commit. */
export function createMissionResources({ limits: configured = {}, finalReserve = {}, now = Date.now() } = {}) {
  const configuredLimits = limits(configured), reserve = quantities(finalReserve), timestamp = clock(now);
  for (const key of dimensions) valid(configuredLimits[key] === undefined || (reserve[key] || 0) <= configuredLimits[key], `Final verification reserve exceeds the ${key} limit.`);
  return { schemaVersion: 1, revision: 1, admissionState: 'open', limits: configuredLimits, finalReserve: reserve, operations: {}, adoptions: {}, createdAt: timestamp, updatedAt: timestamp };
}

export function missionResourceSummary(ledger, { now = Date.now() } = {}) {
  checkLedger(ledger); const timestamp = clock(now), settled = empty(), reserved = empty(), unknown = empty(), unknownUnbounded = new Set(); let unknownOperations = 0;
  for (const operation of Object.values(ledger.operations)) {
    for (const key of dimensions) {
      settled[key] = add(settled[key], operation.actual?.[key] || 0, key);
      if (operation.status === 'reserved') reserved[key] = add(reserved[key], operation.estimate[key] || 0, key);
      if (operation.status === 'unknown' && operation.unknownDimensions.includes(key)) unknown[key] = add(unknown[key], Math.max(0, (operation.estimate[key] || 0) - (operation.actual?.[key] || 0)), key);
    }
    if (operation.status === 'unknown') { unknownOperations++; for (const key of operation.unboundedDimensions || []) if(operation.unknownDimensions.includes(key))unknownUnbounded.add(key); }
  }
  const committed = empty(), remaining = {}, overrun = {};
  for (const key of dimensions) {
    committed[key] = add(add(settled[key], reserved[key], key), unknown[key], key);
    if (ledger.limits[key] !== undefined) { remaining[key] = unknownUnbounded.has(key) ? null : Math.max(0, ledger.limits[key] - committed[key]); if (committed[key] > ledger.limits[key]) overrun[key] = committed[key] - ledger.limits[key]; }
  }
  const records=Object.values(ledger.operations).filter(item=>item.status!=='released'),moneyUnknown=records.some(item=>item.unknownDimensions.includes('moneyMicros') || item.status==='reserved' && item.pricing?.status!=='known');
  return { revision: ledger.revision, admissionState: ledger.admissionState, limits: { ...ledger.limits }, finalReserve: { ...ledger.finalReserve }, settled, reserved, unknown, committed, remaining, overrun, unknownOperations, unknownUnbounded: [...unknownUnbounded], expired: ledger.limits.deadlineAt !== undefined && timestamp >= ledger.limits.deadlineAt, moneyBasis: moneyUnknown?'unavailable':records.some(item => item.moneyBasis === 'estimated') ? 'estimated_not_provider_bill' : records.some(item => item.moneyBasis === 'billed') ? 'provider_reported' : 'unavailable', notice: 'Local admission and recorded usage do not guarantee provider billing, subscription quota, CPU isolation or remote request fanout.' };
}

function identity(input) {
  valid(plain(input) && safeId(input.operationId) && safeId(input.botId) && safeId(input.runId) && safeId(input.kind) && typeof input.requestDigest === 'string' && /^[a-f0-9]{64}$/.test(input.requestDigest), 'Use exact engine operation, participant and request identities.');
  valid(input.phase === undefined || ['work', 'verification'].includes(input.phase), 'Use a supported resource phase.');
  const estimate = quantities(input.estimate), unavailableDimensions = input.unavailableDimensions || [], unboundedDimensions = input.unboundedDimensions || [];
  valid(Array.isArray(unavailableDimensions) && Array.isArray(unboundedDimensions) && [...unavailableDimensions, ...unboundedDimensions].every(key => dimensions.includes(key)), 'Use supported resource readiness dimensions.');
  valid(input.pricing === undefined || plain(input.pricing) && ['known', 'subscription', 'unknown'].includes(input.pricing.status), 'Use trusted price readiness metadata.');
  return { operationId: input.operationId, botId: input.botId, runId: input.runId, kind: input.kind, requestDigest: input.requestDigest, phase: input.phase || 'work', estimate, unavailableDimensions: [...new Set(unavailableDimensions)], unboundedDimensions: [...new Set([...unboundedDimensions,...unavailableDimensions, ...((input.pricing?.status || 'unknown') !== 'known' ? ['moneyMicros'] : [])])], pricing: structuredClone(input.pricing || { status: 'unknown' }), bounds: input.bounds === 'provider_enforced' ? 'provider_enforced' : 'estimated' };
}

/** An existing operation is a receipt, never permission to dispatch it again. */
export function reserveMissionResources(ledger, input, { now = Date.now(), expectedRevision } = {}) {
  cas(ledger, expectedRevision); const timestamp = clock(now), request = identity(input), existing = ledger.operations[request.operationId];
  if (existing) { if (!same(existing.identity, request)) fail('mission_resource_changed', 'This resource operation ID already identifies a different request.'); return { ...structuredClone(existing), admitted: false }; }
  assertAdmission(ledger, timestamp);
  const summary = missionResourceSummary(ledger, { now: timestamp });
  for (const key of dimensions) {
    if (ledger.limits[key] === undefined) continue;
    if (key === 'moneyMicros' && request.pricing.status !== 'known') fail('mission_resource_unavailable', 'A monetary limit cannot admit this operation because its price is unknown or subscription-based.', key, 'unknown_price');
    if (request.unavailableDimensions.includes(key) || request.unboundedDimensions.includes(key)) fail('mission_resource_unavailable', `This operation cannot bound ${key}; choose a supported adapter or remove that resource limit.`, key, 'unsupported_bound');
    if (request.estimate[key] === undefined) fail('mission_resource_unavailable', `This operation has no explicit ${key} estimate, including a verified zero where appropriate.`, key, 'missing_estimate');
    if (summary.unknownUnbounded.includes(key)) fail('mission_resource_unavailable', `Earlier ${key} consumption is unknown; inspect its resource receipt before new dispatch.`, key, 'unknown_prior_usage');
    const held = request.phase === 'verification' ? 0 : ledger.finalReserve[key] || 0;
    const desired = add(add(summary.committed[key], request.estimate[key] || 0, key), held, key);
    if (desired > ledger.limits[key]) fail('mission_budget_exhausted', `The Mission ${key} limit has no remaining admission allowance${held ? ' after reserving final verification' : ''}.`, key, held ? 'verification_headroom' : 'limit');
  }
  const operation = { ...request, identity: request, status: 'reserved', actual: {}, unknownDimensions: [], createdAt: timestamp };
  const next=structuredClone(ledger); next.operations[request.operationId]=operation; touch(next,timestamp); missionResourceSummary(next,{now:timestamp}); Object.assign(ledger,next); return { ...structuredClone(operation), admitted: true };
}

function operationFor(ledger, input) { checkLedger(ledger); valid(plain(input) && safeId(input.operationId), 'Use an exact resource operation identity.'); const operation = ledger.operations[input.operationId]; if (!operation || operation.requestDigest !== input.requestDigest) fail('mission_resource_changed', 'This resource receipt does not match its reserved request.'); return operation; }
export function assertMissionResourceDispatch(ledger, input, { now = Date.now() } = {}) {
  const operation = operationFor(ledger, input), timestamp = clock(now); assertAdmission(ledger, timestamp);
  if(operation.status!=='reserved')fail('mission_resource_unavailable','This operation is already settled and cannot dispatch again.',undefined,'already_settled');
  // Owner limit changes between reserve and dispatch must win as well.
  const summary = missionResourceSummary(ledger, { now: timestamp });
  for (const key of dimensions) if (ledger.limits[key] !== undefined) {
    if(key==='moneyMicros' && operation.pricing.status!=='known')fail('mission_resource_unavailable','This operation has no trusted known price for the newly configured monetary limit.',key,'unknown_price');
    if (operation.unavailableDimensions.includes(key) || operation.unboundedDimensions.includes(key)) fail('mission_resource_unavailable', `This operation cannot enforce the newly configured ${key} limit.`, key, 'unsupported_bound');
    if(operation.estimate[key]===undefined)fail('mission_resource_unavailable',`This operation has no estimate for the newly configured ${key} limit.`,key,'missing_estimate');
    const held=operation.phase==='verification'?0:ledger.finalReserve[key] || 0;
    if (summary.unknownUnbounded.includes(key) || add(summary.committed[key],held,key) > ledger.limits[key]) fail('mission_budget_exhausted', `The ${key} allowance changed before dispatch.`, key, 'limit_changed');
  }
  return structuredClone(operation);
}
export function markMissionResourceDispatch(ledger, input, { now = Date.now() } = {}) {
  const operation=operationFor(ledger,input),timestamp=clock(now);assertAdmission(ledger,timestamp);
  if(operation.status!=='reserved' || operation.dispatchedAt!==undefined)return {...structuredClone(operation),admitted:false};
  assertMissionResourceDispatch(ledger,input,{now:timestamp});
  operation.dispatchedAt = timestamp; touch(ledger, timestamp); return { ...structuredClone(operation), admitted: true };
}

export function releaseMissionReservation(ledger, input, { now = Date.now() } = {}) {
  const operation = operationFor(ledger, input), timestamp = clock(now);
  if (operation.status === 'released') return structuredClone(operation);
  if (operation.status !== 'reserved' || operation.dispatchedAt !== undefined) fail('mission_resource_unavailable', 'Only a proven undispatched reservation may be released.', undefined, 'dispatch_not_proven_absent');
  Object.assign(operation, { status: 'released', finishedAt: timestamp, outcome: 'not_started' }); touch(ledger, timestamp); return structuredClone(operation);
}

/** Missing usage remains a held liability even after a successful tool/model response. */
export function settleMissionResources(ledger, input, { now = Date.now() } = {}) {
  const operation = operationFor(ledger, input), timestamp = clock(now), actual = quantities(input.actual), declaredUnknown = input.unknownDimensions || [];
  valid(Array.isArray(declaredUnknown) && declaredUnknown.every(key => dimensions.includes(key)), 'Use supported unknown usage dimensions.');
  valid(typeof input.receiptDigest === 'string' && /^[a-f0-9]{64}$/.test(input.receiptDigest), 'Settlement needs an exact engine receipt digest.');
  valid(input.moneyBasis === undefined || ['estimated', 'billed', 'unknown'].includes(input.moneyBasis), 'Use a supported monetary evidence basis.');
  const unknownDimensions = [...new Set([...declaredUnknown, ...dimensions.filter(key => actual[key] === undefined && (operation.estimate[key] > 0 || operation.unboundedDimensions.includes(key)))])];
  const settlement = { actual, unknownDimensions, receiptDigest: input.receiptDigest, moneyBasis: input.moneyBasis || (actual.moneyMicros !== undefined ? 'estimated' : 'unknown') };
  if (operation.settlement) { if (!same(operation.settlement, settlement)) fail('mission_resource_changed', 'A settled resource receipt cannot be rewritten.'); return structuredClone(operation); }
  if (!['reserved', 'unknown'].includes(operation.status) || operation.dispatchedAt === undefined) fail('mission_resource_unavailable', 'Settlement requires an engine-marked dispatch.', undefined, 'not_dispatched');
  const next=structuredClone(ledger), updated=next.operations[operation.operationId];
  Object.assign(updated, settlement, { settlement, status: unknownDimensions.length ? 'unknown' : 'settled', finishedAt: timestamp, unboundedDimensions:[...new Set([...operation.unboundedDimensions,...unknownDimensions.filter(key=>!(operation.estimate[key]>0))])] });
  touch(next,timestamp); missionResourceSummary(next,{now:timestamp}); Object.assign(ledger,next); return structuredClone(updated);
}

export function unknownMissionResources(ledger, input, { now = Date.now() } = {}) {
  const operation = operationFor(ledger, input), timestamp = clock(now);
  if (operation.status === 'unknown' || operation.status === 'settled') return structuredClone(operation);
  if (operation.status !== 'reserved' || operation.dispatchedAt === undefined) fail('mission_resource_unavailable', 'Unknown consumption requires a possible dispatched effect.', undefined, 'not_dispatched');
  Object.assign(operation, { status: 'unknown', unknownDimensions: dimensions.filter(key => operation.estimate[key] > 0 || operation.unboundedDimensions.includes(key)), reason: typeof input.reason === 'string' ? input.reason.slice(0,200) : 'dispatch_outcome_unknown', finishedAt: timestamp }); touch(ledger, timestamp); return structuredClone(operation);
}

export function recoverMissionResources(ledger, { now = Date.now() } = {}) {
  checkLedger(ledger); const timestamp = clock(now);
  for (const operation of Object.values(ledger.operations)) if (operation.status === 'reserved') {
    if (operation.dispatchedAt === undefined) releaseMissionReservation(ledger, operation, { now: timestamp });
    else unknownMissionResources(ledger, { ...operation, reason: 'engine_restart_usage_unknown' }, { now: timestamp });
  }
  return missionResourceSummary(ledger, { now: timestamp });
}

export function reviseMissionResourceLimits(ledger, { limits: configured, finalReserve = ledger.finalReserve }, { expectedRevision, now = Date.now() } = {}) {
  valid(expectedRevision !== undefined, 'Owner resource changes require an expected revision.'); cas(ledger, expectedRevision);
  const next = limits(configured), reserve = quantities(finalReserve), timestamp = clock(now);
  for (const key of dimensions) valid(next[key] === undefined || (reserve[key] || 0) <= next[key], `Final verification reserve exceeds the ${key} limit.`);
  ledger.limits = next; ledger.finalReserve = reserve; touch(ledger, timestamp); return missionResourceSummary(ledger, { now: timestamp });
}
export function setMissionResourceAdmission(ledger, state, { expectedRevision, now = Date.now() } = {}) {
  cas(ledger, expectedRevision); const timestamp=clock(now); valid(['open', 'paused', 'stopped', 'terminal'].includes(state), 'Use a supported resource admission state.');
  if (ledger.admissionState === 'stopped' && state !== 'stopped' && state !== 'terminal') fail('mission_resource_unavailable', 'A stopped resource ledger cannot reopen without a new owner-approved attempt.', undefined, 'stopped');
  ledger.admissionState = state; touch(ledger, timestamp); return missionResourceSummary(ledger, { now:timestamp });
}

/** Called only by an authenticated owner retry/resume transaction, never a model tool. */
export function reopenMissionResources(ledger, { expectedRevision, now = Date.now() } = {}) {
  valid(expectedRevision !== undefined,'Owner resource reopening requires an expected revision.'); cas(ledger,expectedRevision);
  const timestamp=clock(now); ledger.admissionState='open'; touch(ledger,timestamp); return missionResourceSummary(ledger,{now:timestamp});
}

/** Promotion imports past costs once; it does not grant another dispatch or reset a budget. */
export function adoptMissionUsage(ledger, { runId, usageDigest, actual = {}, unknownDimensions = [], reservations = [], moneyBasis = 'unknown' }, { now = Date.now() } = {}) {
  checkLedger(ledger); valid(safeId(runId) && typeof usageDigest === 'string' && /^[a-f0-9]{64}$/.test(usageDigest), 'Adopt an exact engine run and usage identity.');
  valid(Array.isArray(reservations) && reservations.length <= 1000 && Array.isArray(unknownDimensions) && unknownDimensions.every(key => dimensions.includes(key)), 'Adopt bounded engine-owned reservations and unknown dimensions.');
  valid(['estimated','billed','unknown'].includes(moneyBasis),'Use a supported monetary evidence basis.');
  const body = { runId, usageDigest, actual: quantities(actual), unknownDimensions, reservations, moneyBasis }, previous = ledger.adoptions[runId];
  if (previous) { if (!same(previous, body)) fail('mission_resource_changed', 'The adopted run usage identity changed.'); return { adopted: false, summary: missionResourceSummary(ledger, { now }) }; }
  const next = structuredClone(ledger), timestamp = clock(now), operationId = `adopt:${runId}`;
  valid(!next.operations[operationId], 'This adoption operation already exists.');
  next.operations[operationId] = { operationId, runId, botId: 'engine_adoption', kind: 'adopted_usage', requestDigest: usageDigest, phase: 'work', estimate: {}, actual: body.actual, status: unknownDimensions.length ? 'unknown' : 'settled', unknownDimensions: [...unknownDimensions], unboundedDimensions: [...unknownDimensions], moneyBasis, createdAt: timestamp, finishedAt: timestamp };
  for (const input of reservations) {
    const request = identity(input); valid(!next.operations[request.operationId], 'An adopted reservation identity already exists.');
    next.operations[request.operationId] = { ...request, identity: request, status: 'reserved', actual: {}, unknownDimensions: [], createdAt: timestamp, ...(input.dispatchedAt === undefined ? {} : { dispatchedAt: clock(input.dispatchedAt) }) };
  }
  next.adoptions[runId] = structuredClone(body); touch(next, timestamp); const summary=missionResourceSummary(next,{now:timestamp}); Object.assign(ledger, next); return { adopted: true, summary };
}

/** Readiness describes only adapter facts supplied by Engine, never model authority. */
export function missionResourceReadiness({ tool, currentGroups = [], requiredGroups = [], limits: configured = {}, unavailableDimensions = [], pricing = { status: 'unknown' } } = {}) {
  const constrained = limits(configured), unavailable = unavailableDimensions.filter(key => constrained[key] !== undefined);
  if (typeof tool !== 'string' || !tool) return { available: false, status: 'missing_tool', reason: 'No supported tool adapter is available.' };
  if (requiredGroups.some(group => !currentGroups.includes(group))) return { available: false, status: 'needs_access', reason: 'The current bot lacks the required tool access.' };
  if (unavailable.length) return { available: false, status: 'unsupported_bound', dimensions: unavailable, reason: `This adapter cannot enforce the configured ${unavailable.join(', ')} limit.` };
  if (constrained.moneyMicros !== undefined && pricing.status !== 'known') return { available: false, status: 'unknown_price', dimensions: ['moneyMicros'], reason: 'The provider/service price is unknown or subscription-based; a monetary limit is unavailable.' };
  return { available: true, status: 'available', pricing: pricing.status, notice: 'Resource readiness grants no tools, access or action approval.' };
}

function priceSchedule(value, model) {
  if (!value) return null;
  valid(plain(value) && ['operator', 'provider'].includes(value.source) && value.currency === 'USD' && typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 120 && value.model === model, 'Use an exact trusted USD price schedule for this model and version.');
  valid(integer(value.inputMicrosPerMillion) && integer(value.outputMicrosPerMillion) && (value.cachedInputMicrosPerMillion === undefined || integer(value.cachedInputMicrosPerMillion)) && (value.cacheCreationMicrosPerMillion === undefined || integer(value.cacheCreationMicrosPerMillion)), 'Price rates must be nonnegative safe integer microUSD per million tokens.');
  return Object.fromEntries(['source','currency','version','model','inputMicrosPerMillion','outputMicrosPerMillion','cachedInputMicrosPerMillion','cacheCreationMicrosPerMillion'].filter(key => value[key] !== undefined).map(key => [key,value[key]]));
}
function tokenCost(input, output, cached, created, schedule) {
  if (!schedule || cached > 0 && schedule.cachedInputMicrosPerMillion === undefined || created > 0 && schedule.cacheCreationMicrosPerMillion === undefined) return undefined;
  const sum = BigInt(input-cached-created)*BigInt(schedule.inputMicrosPerMillion) + BigInt(output)*BigInt(schedule.outputMicrosPerMillion) + BigInt(cached)*BigInt(schedule.cachedInputMicrosPerMillion || 0) + BigInt(created)*BigInt(schedule.cacheCreationMicrosPerMillion || 0);
  const rounded = (sum + 999999n) / 1000000n;
  valid(rounded <= BigInt(Number.MAX_SAFE_INTEGER), 'The modeled price exceeds safe microUSD accounting.'); return Number(rounded);
}

/** Estimates local admission only; even supported output limits are not billing guarantees. */
export function estimateMissionInference({ model, inputTokens, outputTokens, cachedInputTokens = 0, price, subscription = false, enforcedOutput = false } = {}) {
  valid(typeof model === 'string' && model.length > 0 && model.length <= 240 && integer(inputTokens) && integer(outputTokens) && integer(cachedInputTokens) && cachedInputTokens <= inputTokens, 'Use bounded model input/output token estimates.');
  const schedule = subscription ? null : priceSchedule(price, model);
  // A cache miss or creation may cost more than a read. Reserve the highest explicit input rate, never an assumed hit.
  const admissionSchedule=schedule?{...schedule,inputMicrosPerMillion:Math.max(schedule.inputMicrosPerMillion,schedule.cachedInputMicrosPerMillion || 0,schedule.cacheCreationMicrosPerMillion || 0)}:null;
  const moneyMicros = tokenCost(inputTokens,outputTokens,0,0,admissionSchedule);
  return { estimate: { tokens: add(inputTokens,outputTokens,'tokens'), requests: 1, ...(moneyMicros === undefined ? {} : { moneyMicros }) }, pricing: { status: subscription ? 'subscription' : moneyMicros === undefined ? 'unknown' : 'known', model, ...(schedule ? { schedule, version: schedule.version, rateDigest: digest(canonical(schedule)) } : {}) }, bounds: enforcedOutput ? 'provider_enforced' : 'estimated', unboundedDimensions: [...(moneyMicros === undefined || !enforcedOutput ? ['moneyMicros'] : []),...(!enforcedOutput ? ['tokens'] : [])], notice: enforcedOutput ? 'Measured input plus configured output ceiling; modeled money is an estimate, not a provider bill.' : 'The provider may exceed the requested output. This is a local admission estimate, not a hard token or billing cap.' };
}

/** Normalize only complete provider usage. Missing fields remain unknown after success. */
export function missionInferenceUsage(usage, { protocol = 'openai', pricing = { status: 'unknown' } } = {}) {
  valid(plain(usage) && ['openai','anthropic'].includes(protocol), 'Use a supported provider usage object.');
  const input = usage.input_tokens ?? usage.prompt_tokens, output = usage.output_tokens ?? usage.completion_tokens;
  for (const value of [input,output,usage.cache_read_input_tokens,usage.cache_creation_input_tokens,usage.input_tokens_details?.cached_tokens,usage.prompt_tokens_details?.cached_tokens]) valid(value === undefined || integer(value), 'Provider usage must contain nonnegative safe integer token counts.');
  const actual = { requests: 1 }, unknownDimensions = [];
  if (input === undefined || output === undefined) return { actual, unknownDimensions: ['tokens','moneyMicros'], moneyBasis: 'unknown' };
  const cached = protocol === 'anthropic' ? usage.cache_read_input_tokens || 0 : usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const created = protocol === 'anthropic' ? usage.cache_creation_input_tokens || 0 : 0;
  const fullInput = protocol === 'anthropic' ? add(add(input,cached,'tokens'),created,'tokens') : input;
  valid(cached + created <= fullInput && Number.isSafeInteger(cached + created), 'Cached usage cannot exceed input usage.');
  actual.tokens = add(fullInput,output,'tokens');
  const schedule = pricing.status === 'known' ? priceSchedule(pricing.schedule,pricing.model) : null;
  const cost = tokenCost(fullInput,output,cached,created,schedule);
  if (cost !== undefined) actual.moneyMicros = cost; else unknownDimensions.push('moneyMicros');
  return { actual, unknownDimensions, moneyBasis: cost === undefined ? 'unknown' : 'estimated', notice: 'Reported token usage is recorded; calculated microUSD remains a price-schedule estimate.' };
}
