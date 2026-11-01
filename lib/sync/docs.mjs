import { hmac } from './crypto.mjs';
import { sessionOwner } from '../sessions.mjs';
import { sessionKind } from '../sessions.mjs';
import { sanitizeMissionSummary } from '../mission-presentation.mjs';

/**
 * Maps Tupies state to small replicated documents. Each document is one bot, provider, message, memory fact and so on,
 * so concurrent edits to different items never collide. Runs, room drives, passwords, activity and channel delivery
 * cursors stay with the engine that executes them.
 */
const SECRET_FIELDS = { conn: ['secret', 'oauthSecret'], integ: ['secret'], chan: ['secret'] };
const LOCAL_FIELDS = { chan: ['offset', 'pending', 'lastDispatch', 'lastDelivery', 'busyNoticeAt', 'nextPollAt', 'lastUpdateAt', 'received'] };
const LISTS = { bot: 'bots', conn: 'connections', integ: 'integrations', chan: 'channels', routine: 'routines', skill: 'skills', room: 'rooms', device: 'devices', session: 'sessions', proposal: 'proposals' };
const NESTED = { msg: ['messages', 'id'], rmsg: ['roomMessages', 'id'], mem: ['memory', 'key'] };
const SAFE_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const encodeKey = value => Buffer.from(String(value), 'utf8').toString('base64url');
const decodeKey = value => Buffer.from(value, 'base64url').toString('utf8');

export const STATE_KINDS = new Set([...Object.keys(LISTS), ...Object.keys(NESTED), 'conv', 'settings', 'presence', 'mission']);
export const kindOf = key => key.split(':', 1)[0];

/** Parses a document key and refuses anything that could address state outside the replicated collections. */
export function parseKey(key) {
  if (typeof key !== 'string' || key.length > 1200) return null;
  const parts = key.split(':'), kind = parts[0];
  if (kind === 'settings') return parts.length === 1 ? { kind } : null;
  if (LISTS[kind] || kind === 'conv' || kind === 'presence' || kind === 'mission') return parts.length === 2 && SAFE_ID.test(parts[1]) ? { kind, id: parts[1] } : null;
  if (NESTED[kind]) {
    if (parts.length !== 3 || !SAFE_ID.test(parts[1])) return null;
    if (kind === 'mem') { if (!/^[A-Za-z0-9_-]{1,800}$/.test(parts[2])) return null; return { kind, owner: parts[1], id: decodeKey(parts[2]) }; }
    return SAFE_ID.test(parts[2]) ? { kind, owner: parts[1], id: parts[2] } : null;
  }
  if (kind === 'file') return parseFileKey(key);
  return null;
}
export function parseFileKey(key) {
  const match = typeof key === 'string' && key.match(/^file:(skills|workspaces)\/(.+)$/);
  if (!match) return null;
  const relative = match[2], parts = relative.split('/');
  if (relative.length > 900 || /[\\\x00-\x1f\x7f]/.test(relative) || parts.some(part => !part || part === '.' || part === '..')) return null;
  return { kind: 'file', root: match[1], path: relative };
}

/** Secrets never appear in documents at rest: the hash uses a keyed digest, the wire form carries plaintext inside the sealed envelope. */
function transformSecrets(kind, item, mode, store) {
  const fields = SECRET_FIELDS[kind], local = LOCAL_FIELDS[kind];
  if (!fields && !local) return item;
  const value = { ...item };
  for (const field of local || []) delete value[field];
  for (const field of fields || []) {
    if (!Object.hasOwn(value, field)) continue;
    let plain = '';
    try { plain = store.unseal(value[field]); } catch { plain = `unreadable:${value[field]}`; }
    value[field] = plain ? (mode === 'wire' ? { $secret: plain } : { $secretDigest: hmac(store.key, plain) }) : '';
  }
  return value;
}
function restoreSecrets(kind, value, previous, store) {
  const fields = SECRET_FIELDS[kind], local = LOCAL_FIELDS[kind];
  if (!fields && !local) return value;
  const result = { ...value };
  for (const field of fields || []) {
    const incoming = result[field];
    if (incoming && typeof incoming === 'object' && typeof incoming.$secret === 'string') result[field] = store.seal(incoming.$secret);
    else if (incoming && typeof incoming === 'object') result[field] = previous?.[field] || '';
    else if (incoming !== undefined) result[field] = '';
  }
  for (const field of local || []) if (previous && Object.hasOwn(previous, field)) result[field] = previous[field];
  return result;
}

/** Every replicated document in the current state, in the local (hashable) representation. */
export function listDocuments(state, store, mode = 'local') {
  const docs = new Map();
  for (const [kind, field] of Object.entries(LISTS)) for (const item of state[field] || []) if (item && SAFE_ID.test(item.id || '') && !(kind==='session' && item.kind==='mission')) docs.set(`${kind}:${item.id}`, transformSecrets(kind, item, mode, store));
  for(const item of Object.values(state.missionSummaries || {})){const safe=sanitizeMissionSummary(item);if(safe)docs.set(`mission:${safe.id}`,safe);}
  docs.set('settings', state.settings || {});
  // A conversation is keyed by its session: the bot's id for its Bot Chat, a derived id for every other lane.
  for (const [sessionId, conversation] of Object.entries(state.conversations || {})) if (SAFE_ID.test(sessionId) && sessionKind(sessionId)!=='mission') docs.set(`conv:${sessionId}`, conversation);
  for (const [node, presence] of Object.entries(state.presence || {})) if (SAFE_ID.test(node)) docs.set(`presence:${node}`, presence);
  for (const [kind, [field, idField]] of Object.entries(NESTED)) {
    for (const [owner, items] of Object.entries(state[field] || {})) {
      if (!SAFE_ID.test(owner) || !Array.isArray(items)) continue;
      for (const item of items) {
        const itemId = item?.[idField];
        if (typeof itemId !== 'string' || !itemId) continue;
        const key = kind === 'mem' ? `mem:${owner}:${encodeKey(itemId)}` : SAFE_ID.test(itemId) ? `${kind}:${owner}:${itemId}` : null;
        if (key) docs.set(key, item);
      }
    }
  }
  return docs;
}

export function readDocument(state, key, store, mode = 'local') {
  const parsed = parseKey(key);
  if (!parsed || parsed.kind === 'file') return undefined;
  const { kind } = parsed;
  if (kind === 'settings') return state.settings || {};
  if (kind === 'mission') return sanitizeMissionSummary(state.missionSummaries?.[parsed.id]);
  if (kind === 'conv') return state.conversations?.[parsed.id];
  if (kind === 'presence') return state.presence?.[parsed.id];
  if (LISTS[kind]) { const item = (state[LISTS[kind]] || []).find(entry => entry.id === parsed.id); return item && transformSecrets(kind, item, mode, store); }
  const [field, idField] = NESTED[kind];
  return (state[field]?.[parsed.owner] || []).find(entry => entry?.[idField] === parsed.id);
}

const byCreated = (items, value) => {
  const index = items.findIndex(entry => String(entry.createdAt || '') > String(value.createdAt || ''));
  if (index < 0) items.push(value); else items.splice(index, 0, value);
};

/** Applies one remote document to state. A null value removes the item. Returns false when the value is not acceptable. */
export function writeDocument(state, key, value, store) {
  const parsed = parseKey(key);
  if (!parsed || parsed.kind === 'file') return false;
  if (value !== null && (typeof value !== 'object' || Array.isArray(value) !== (parsed.kind === 'conv'))) return false;
  const { kind } = parsed;
  if (kind === 'settings') { state.settings = value || {}; return true; }
  if(kind==='mission'){
    // A received presentation can never overwrite local execution authority, even with a higher LWW clock.
    if(state.missions?.[parsed.id])return false;
    state.missionSummaries ||= {};if(value===null){delete state.missionSummaries[parsed.id];return true;}
    const safe=sanitizeMissionSummary(value);if(!safe || safe.id!==parsed.id)return false;
    state.missionSummaries[parsed.id]=safe;return true;
  }
  if(kind==='conv' && sessionKind(parsed.id)==='mission')return false;
  if (kind === 'conv') { state.conversations ||= {}; if (value === null) delete state.conversations[parsed.id]; else state.conversations[parsed.id] = value; return true; }
  if (kind === 'presence') { state.presence ||= {}; if (value === null) delete state.presence[parsed.id]; else state.presence[parsed.id] = value; return true; }
  if (LISTS[kind]) {
    const list = state[LISTS[kind]] ||= [], index = list.findIndex(entry => entry.id === parsed.id);
    if (value === null) { if (index >= 0) list.splice(index, 1); return true; }
    if (value.id !== parsed.id) return false;
    let next = restoreSecrets(kind, value, index >= 0 ? list[index] : null, store);
    // Revocation is final: an edit made before an engine learned of it cannot bring the device back.
    if (kind === 'device' && index >= 0 && list[index].revokedAt && !next.revokedAt) next = { ...next, revokedAt: list[index].revokedAt };
    if (index >= 0) list[index] = next; else list.push(next);
    return true;
  }
  const [field, idField] = NESTED[kind], collection = state[field] ||= {};
  const items = collection[parsed.owner] ||= [], index = items.findIndex(entry => entry?.[idField] === parsed.id);
  if (value === null) { if (index >= 0) items.splice(index, 1); if (!items.length) delete collection[parsed.owner]; return true; }
  if (value[idField] !== parsed.id) return false;
  if (index >= 0) items[index] = value;
  else if (kind === 'mem') items.push(value);
  else byCreated(items, value);
  return true;
}

/** Which bot a document belongs to, so changes for a bot with an active local run can wait until it settles. */
export function botOf(key) {
  const parsed = parseKey(key);
  if (!parsed) return null;
  if (parsed.kind === 'bot') return parsed.id;
  if (parsed.kind === 'conv' || parsed.kind === 'session') return sessionOwner(parsed.id);
  return null;
}
