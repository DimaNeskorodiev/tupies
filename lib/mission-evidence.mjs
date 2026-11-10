import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensure, now, atomicWrite } from './store.mjs';
import { readWorkspaceBytes } from './agent-tools.mjs';
import { inspectDocument, documentFormat } from './documents.mjs';
import { missionDigest, missionPrivatePath } from './mission-contract.mjs';

const MAX_RECEIPT_BYTES = 160000;
const MAX_RESPONSE_PACKET_BYTES = 48000;
const FILE_TOOLS = new Set(['workspace_write', 'workspace_edit', 'workspace_read', 'documents_create', 'documents_read', 'workspace_image', 'browser_download']);
export const MISSION_SOURCE_TOOLS = new Set(['http_fetch','web_extract','documents_read','workspace_read','workspace_list','workspace_glob','workspace_search','workspace_structure','scripts_list','scripts_inspect','workspace_image','browser_text','browser_snapshot','browser_tabs','browser_frames','session_read','brain_read','skills_list','skills_read','skills_file','skills_search','skills_inspect','integration_list','bots_list','routines_list']);
const COMMAND_TOOLS = new Set(['shell_run', 'skills_run', 'scripts_run', 'script_run', 'shell_read', 'shell_start', 'terminal', 'execute_code']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const validId = value => typeof value === 'string' && /^[\w-]{1,120}$/.test(value);
const digestRef = reference => typeof reference === 'string' ? reference.replace(/^evidence_/, '') : reference?.digest;
export function missionEvidenceDigest(references = []) {
  ensure(Array.isArray(references) && references.length <= 256, 400, 'Use at most 256 Mission evidence references.');
  const digests = references.map(digestRef);
  ensure(digests.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), 400, 'Use exact engine evidence identities.');
  return missionDigest([...new Set(digests)].sort());
}

function identity(input) {
  for (const key of ['missionId', 'botId', 'runId', 'requirementId']) ensure(validId(input[key]), 400, 'Use exact Mission, requirement, bot and run identities.');
  ensure(Number.isSafeInteger(input.contractVersion) && input.contractVersion >= 1, 400, 'Use the current contract version.');
  return Object.fromEntries(['missionId', 'botId', 'runId', 'contractVersion', 'requirementId'].map(key => [key, input[key]]));
}

function findRun(store, botId, runId) {
  const runs = [store.state.runs?.[botId], ...(store.state.runHistory?.[botId] || [])].filter(run => run?.id === runId);
  ensure(runs.length === 1, 404, 'No unique engine-owned run is available for this evidence.');
  return runs[0];
}

async function directory(store) {
  const root = path.resolve(store.directory);
  const parent = await fs.lstat(root);
  ensure(parent.isDirectory() && !parent.isSymbolicLink(), 400, 'Evidence storage needs a real engine data directory.');
  const target = path.join(root, 'mission-evidence');
  await fs.mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(target);
  ensure(stat.isDirectory() && !stat.isSymbolicLink(), 400, 'Mission evidence storage cannot be a symbolic link.');
  return target;
}

async function persist(store, record) {
  // The receipt contains no arbitrary tool payload or model-authored download URL.
  const normalized = store.redactValue ? store.redactValue(record) : record;
  if (normalized.kind === 'response') { normalized.sha256 = sha(Buffer.from(normalized.text)); normalized.size = Buffer.byteLength(normalized.text); }
  const bytes = Buffer.from(JSON.stringify(normalized));
  ensure(bytes.length <= MAX_RECEIPT_BYTES, 413, 'Mission evidence exceeds its bounded receipt size.');
  const digest = sha(bytes), target = path.join(await directory(store), `${digest}.json`);
  // Publish only complete bytes. Concurrent publication of this digest has identical content.
  await atomicWrite(target, bytes);
  return { id: `evidence_${digest}`, digest, schemaVersion: 1, ...Object.fromEntries(['missionId', 'botId', 'runId', 'contractVersion', 'requirementId', 'kind', 'observedAt', 'path', 'sha256', 'size'].filter(key => normalized[key] !== undefined).map(key => [key, normalized[key]])) };
}

async function readPrivateBytes(store, digest, extension, maxBytes) {
  ensure(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 400, 'Use an exact engine evidence digest.');
  const handle = await fs.open(path.join(await directory(store), `${digest}.${extension}`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    ensure(stat.isFile() && stat.size <= maxBytes && stat.nlink === 1, 413, 'Invalid Mission evidence storage object.');
    let bytes = Buffer.alloc(stat.size + 1), length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    bytes = bytes.subarray(0, length);
    ensure(length === stat.size && sha(bytes) === digest, 409, 'Mission evidence bytes changed or do not match their receipt.');
    return bytes;
  } finally { await handle.close(); }
}

async function persistFile(store, bytes) {
  const digest = sha(bytes), file = path.join(await directory(store), `${digest}.bin`);
  await atomicWrite(file, bytes);
  return digest;
}

/** Internal Engine API. A caller supplies only identities; receipts come from Store. */
export async function captureMissionEvidence(input) {
  const { store, callId } = input;
  let { kind, path: relative } = input;
  const bound = identity(input), run = findRun(store, bound.botId, bound.runId);
  ensure(typeof callId === 'string' && callId.length > 0 && callId.length <= 120, 400, 'Use an exact tool call identity.');
  const matches = (run.workRecords || []).filter(item => item.callId === callId);
  ensure(matches.length === 1, 409, 'Evidence needs an unambiguous engine-recorded tool receipt.');
  const receipt = matches[0];
  ensure(receipt.status === 'succeeded' && !receipt.errorCode && !['unknown', 'pending', 'partial'].includes(receipt.outcome), 409, 'Failed, pending or uncertain work cannot become verified evidence.');
  ensure(typeof receipt.resultDigest === 'string' && /^[a-f0-9]{64}$/.test(receipt.resultDigest), 409, 'The tool receipt has no exact retained result identity.');
  if (kind === 'rubric') {
    relative ||= receipt.path;
    kind = FILE_TOOLS.has(receipt.tool) && missionPrivatePath(relative) ? 'file' : MISSION_SOURCE_TOOLS.has(receipt.tool) ? 'source_read' : null;
  }
  const record = { schemaVersion: 1, ...bound, kind, observedAt: now(), receipt: Object.fromEntries(['callId', 'tool', 'status', 'outcome', 'at', 'requestDigest', 'resultDigest', 'httpStatus', 'exitCode', 'childRunId', 'childStatus', 'deliverableId', 'deliverable', 'url'].filter(key => receipt[key] !== undefined).map(key => [key, receipt[key]])) };
  if (kind === 'file' || kind?.startsWith('file_')) {
    ensure(FILE_TOOLS.has(receipt.tool) && missionPrivatePath(relative) && receipt.path === relative, 409, 'File evidence needs a successful receipt for this exact private file.');
    const bytes = await readWorkspaceBytes(store, bound.botId, relative, { maxBytes: 20_000_000 });
    const hash = sha(bytes);
    ensure(!receipt.sha256 || receipt.sha256 === hash, 409, 'The file changed after the retained tool observation. Read it again.');
    Object.assign(record, { kind: 'file', path: relative, sha256: hash, size: bytes.length, blobDigest: await persistFile(store, bytes) });
  } else if (kind === 'source_read') {
    ensure(MISSION_SOURCE_TOOLS.has(receipt.tool) && (!['http_fetch','web_extract'].includes(receipt.tool) || receipt.httpStatus === undefined || receipt.httpStatus >= 200 && receipt.httpStatus < 300), 409, 'This receipt is not an eligible successful source read.');
    if (receipt.path !== undefined) record.path = receipt.path;
  } else if (kind === 'command_success') {
    ensure(COMMAND_TOOLS.has(receipt.tool) && receipt.exitCode === 0, 409, 'Command evidence needs an actual successful exit receipt.');
  } else if (kind === 'teammate_completed') {
    ensure(receipt.tool === 'delegate_task' && receipt.childStatus === 'completed' && receipt.deliverable === 'completed', 409, 'The teammate result is not verified complete.');
  } else ensure(false, 400, 'Unsupported Mission evidence kind.');
  return persist(store, record);
}

/** Only the controller finish path calls this; a response is data for review, never proof. */
export async function captureMissionResponseEvidence(input) {
  const { store, text } = input, bound = identity(input);
  findRun(store, bound.botId, bound.runId);
  ensure(typeof text === 'string' && text.trim() && Buffer.byteLength(text) <= 100000, 413, 'Use a nonempty final response up to 100000 bytes.');
  return persist(store, { schemaVersion: 1, ...bound, kind: 'response', observedAt: now(), text, sha256: sha(Buffer.from(text)), size: Buffer.byteLength(text) });
}

/** Engine observations only. Select cited sources, bound the aggregate and disclose any missing selected content. */
export function missionResponsePacket(finalResponse, observations) {
  ensure(typeof finalResponse === 'string' && finalResponse.trim() && Array.isArray(observations), 400, 'Use a final response and actual source observations.');
  const urls = new Set((finalResponse.match(/https?:\/\/[^\s<>"`\]\}]+/gu) || []).flatMap(value => [value, value.replace(/[),.;!?]+$/u, '')]));
  const pathReferenced = value => {
    if (typeof value !== 'string' || !value) return false;
    for (let offset = finalResponse.indexOf(value); offset >= 0; offset = finalResponse.indexOf(value, offset + 1)) {
      const before = finalResponse[offset - 1], after = finalResponse[offset + value.length];
      const sentenceEnd = after === '.' && (!finalResponse[offset + value.length + 1] || /[\s)\]}>"'`]/u.test(finalResponse[offset + value.length + 1]));
      if ((!before || !/[\p{L}\p{N}_./%#=&:+-]/u.test(before)) && (!after || sentenceEnd || !/[\p{L}\p{N}_./?%#=&:+-]/u.test(after))) return true;
    }
    return false;
  };
  const cited = observations.filter(row => typeof row.url === 'string' && urls.has(row.url) || pathReferenced(row.path));
  const selected = cited.length ? cited : observations;
  const packet = { finalResponse, observedSources: [], sourceSelection: cited.length ? 'references_in_final_response' : 'all_observed_sources', omittedUncitedSources: observations.length - selected.length, omittedSelectedSources: 0, sourceCoverage: 'retained_observations' };
  const serialize = () => JSON.stringify(packet);
  ensure(Buffer.byteLength(serialize()) <= MAX_RESPONSE_PACKET_BYTES, 413, 'The final response exceeds the bounded Mission review packet. Save a concise result with exact evidence references.');
  for (let index = 0; index < selected.length; index++) {
    const row = structuredClone(selected[index]); packet.observedSources.push(row);
    if (row.observationTruncated || row.observation === null) packet.sourceCoverage = 'partial';
    if (Buffer.byteLength(serialize()) <= MAX_RESPONSE_PACKET_BYTES) continue;
    packet.sourceCoverage = 'partial'; row.observationTruncated = true;
    const original = typeof row.observation === 'string' ? row.observation : '';
    row.observation = '';
    // Reserve the real omission count before fitting, including its serialized digits.
    packet.omittedSelectedSources = selected.length - index - 1;
    if (Buffer.byteLength(serialize()) > MAX_RESPONSE_PACKET_BYTES) {
      packet.observedSources.pop(); packet.omittedSelectedSources++; break;
    }
    let low = 0, high = original.length;
    while (low < high) { const middle = Math.ceil((low + high) / 2); row.observation = original.slice(0, middle); if (Buffer.byteLength(serialize()) <= MAX_RESPONSE_PACKET_BYTES) low = middle; else high = middle - 1; }
    row.observation = original.slice(0, low).replace(/[\uD800-\uDBFF]$/u, '');
    break;
  }
  return serialize();
}

/** Reopen immutable Engine bytes; caller-provided metadata is never authoritative. */
async function loadReceipt(store, reference) {
  const digest = digestRef(reference);
  ensure(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 400, 'Use an exact engine evidence digest.');
  if (typeof reference === 'object' && reference.id !== undefined) ensure(reference.id === `evidence_${digest}`, 409, 'Evidence identity does not match its digest.');
  const bytes = await readPrivateBytes(store, digest, 'json', MAX_RECEIPT_BYTES);
  const record = JSON.parse(bytes.toString('utf8'));
  ensure(record.schemaVersion === 1, 400, 'Unsupported evidence schema.'); identity(record);
  return { ...record, id: `evidence_${digest}`, digest };
}

export async function readMissionEvidence({ store, reference, includeContent = false, maxChars = 60000, signal }) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('Mission evidence read cancelled.'), { name: 'AbortError' });
  ensure(Number.isSafeInteger(maxChars) && maxChars >= 1 && maxChars <= 60000, 400, 'Evidence text is bounded to 60000 characters.');
  const result = await loadReceipt(store, reference), record = result;
  if (record.kind === 'file') {
    ensure(missionPrivatePath(record.path), 400, 'Invalid private evidence path.');
    const retained = await readPrivateBytes(store, record.blobDigest, 'bin', 20_000_000);
    ensure(retained.length === record.size && record.blobDigest === record.sha256, 409, 'The retained file version does not match its evidence.');
    const current = await readWorkspaceBytes(store, record.botId, record.path, { maxBytes: 20_000_000 });
    ensure(current.length === record.size && sha(current) === record.sha256, 409, 'The result file changed after evidence capture.');
    if (includeContent) {
      if (/\.(?:pdf|docx|pptx|xlsx)$/i.test(record.path) && maxChars >= 100) {
        // Reuse the existing bounded document worker on the exact hash-checked bytes.
        // A private disposable copy prevents a mutable workspace path changing the parser input.
        const staging = await fs.mkdtemp(path.join(await directory(store), '.extract-'));
        try {
          const folder = path.join(staging, 'workspaces', record.botId);
          await fs.mkdir(folder, { recursive: true, mode: 0o700 });
          const name = path.basename(record.path); await fs.writeFile(path.join(folder, name), current, { mode: 0o600, flag: 'wx' });
          const parsed = await inspectDocument({ directory: staging }, record.botId, name, { maxChars, signal });
          result.content = parsed.text; result.truncated = !!parsed.truncated; result.contentKind = 'document_text'; result.warnings = parsed.warnings || [];
        } finally { await fs.rm(staging, { recursive: true, force: true }); }
      } else {
        try { const decoded = new TextDecoder('utf-8', { fatal: true }).decode(current); result.content = decoded.slice(0, maxChars); result.truncated = decoded.length > maxChars; result.contentKind = 'literal_utf8'; }
        catch { result.content = null; result.contentUnavailable = 'The file is not UTF-8 text; this reader does not certify its semantic contents.'; }
      }
    }
  } else if (record.kind === 'response') {
    ensure(typeof record.text === 'string' && Buffer.byteLength(record.text) === record.size && sha(Buffer.from(record.text)) === record.sha256, 409, 'The retained response identity is invalid.');
    if (includeContent) { result.content = record.text.slice(0, maxChars); result.truncated = record.text.length > maxChars; }
    delete result.text;
  }
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('Mission evidence read cancelled.'), { name: 'AbortError' });
  return result;
}

/** Historical download only. Does not certify the current mutable workspace file. */
export async function readMissionEvidenceFile({ store, reference, missionId }) {
  ensure(validId(missionId), 400, 'Use an exact Mission identity.');
  const record = await loadReceipt(store, reference);
  ensure(record.missionId === missionId && record.kind === 'file' && missionPrivatePath(record.path), 404, 'No file evidence belongs to this Mission.');
  const bytes = await readPrivateBytes(store, record.blobDigest, 'bin', 20_000_000);
  ensure(bytes.length === record.size && record.blobDigest === record.sha256, 409, 'The retained file version does not match its evidence.');
  let format = path.extname(record.path).slice(1).toLowerCase(), mime = 'application/octet-stream';
  try { ({ format, mime } = documentFormat(record.path)); } catch { /* Other files remain attachment-only bytes. */ }
  return { bytes, metadata: { botId: record.botId, path: record.path, name: path.basename(record.path), size: bytes.length, sha256: record.sha256, format, mime, evidenceId: record.id, contractVersion: record.contractVersion } };
}
