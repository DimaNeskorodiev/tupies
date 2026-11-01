// Only generated managed-note identities participate in the publication protocol.
// Ordinary Brain paths keep their existing behavior. These predicates grant no access.
export const MANAGED_KNOWLEDGE_FOLDER='tupies-managed-knowledge';
export const KNOWLEDGE_UNIT_ID=/^unit-[a-f0-9]{32}$/;
const clean=value=>typeof value==='string'?value.normalize('NFC').replace(/\\/g,'/').toLowerCase():'';
export function managedKnowledgeId(relative) {
  return clean(relative).replace(/^brain\//,'').match(/^tupies-managed-knowledge\/(unit-[a-f0-9]{32})\.md$/)?.[1] || null;
}
// FileReplica preserves concurrent edits with this generated suffix. A conflict
// of a conflict can retain a truncated earlier suffix before the final one.
// These preserved bytes are review material, never another active Brain note.
export function managedKnowledgeConflictPath(relative) {
  return /^tupies-managed-knowledge\/unit-[a-f0-9]{32} \(conflict [a-z0-9_ .()-]* [a-f0-9]{16}\)\.md$/.test(clean(relative).replace(/^brain\//,''));
}
export function managedKnowledgeManifestPath(relative) {
  const id=managedKnowledgeId(relative);
  return id?`brain/${MANAGED_KNOWLEDGE_FOLDER}/${id}.manifest.json`:null;
}
export function protectedKnowledgeControlPath(relative) {
  return /^brain\/tupies-managed-knowledge\/unit-[a-f0-9]{32}\.manifest\.json$/.test(clean(relative));
}
export function knowledgeManifestMatches(manifest,relative,sha256,botId) {
  const id=managedKnowledgeId(relative);
  return Boolean(id && manifest?.schema===1 && manifest.unitId===id && manifest.path===`${MANAGED_KNOWLEDGE_FOLDER}/${id}.md` && manifest.botId===botId && manifest.status==='active' && manifest.noteSha256===sha256 && /^[a-f0-9]{64}$/.test(sha256));
}
