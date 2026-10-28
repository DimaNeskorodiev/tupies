import { promises as fs, createReadStream, watch } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parseFileKey } from './docs.mjs';

/**
 * Content-addressed replication for skill resources and bot workspaces, including long-term notes. Symlinks, hidden
 * tool folders and dependency trees are never followed or replicated. Files apply atomically and stay inside their root.
 */
export const ROOTS = ['skills', 'workspaces'];
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 20_000;
const IGNORED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.DS_Store', '.Trash', '.cache', '.next', '.tmp']);
// Atomic-write temporaries from the store, notes, documents and edits are never replicated half-written.
export const ignoredSegment = name => IGNORED.has(name) || name.startsWith('.import-') || /[.-][0-9a-f]{12,32}\.tmp$/.test(name) || name.endsWith('.sync-partial');
const hashFile = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});

export class FileReplica {
  constructor(directory, { onChange = () => {}, maxFileBytes = MAX_FILE_BYTES } = {}) {
    this.directory = directory; this.onChange = onChange; this.maxFileBytes = maxFileBytes;
    this.cache = new Map(); this.bySha = new Map(); this.skipped = []; this.watchers = []; this.scanning = null;
    this.blobDir = path.join(directory, 'sync', 'blobs');
  }
  async init() {
    await fs.mkdir(this.blobDir, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(this.blobDir).catch(() => [])) await fs.rm(path.join(this.blobDir, entry), { force: true });
    for (const root of ROOTS) {
      await fs.mkdir(path.join(this.directory, root), { recursive: true, mode: 0o700 });
      try {
        const watcher = watch(path.join(this.directory, root), { recursive: true, persistent: false }, () => this.onChange());
        watcher.on('error', () => {}); this.watchers.push(watcher);
      } catch {}
    }
  }
  close() { for (const watcher of this.watchers) watcher.close(); this.watchers = []; }

  /** Walks both roots and returns file documents keyed like file:workspaces/bot_x/brain/note.md. Unchanged files are not rehashed. */
  async scan() {
    if (this.scanning) return this.scanning;
    this.scanning = this.walk().finally(() => { this.scanning = null; });
    return this.scanning;
  }
  async walk() {
    const docs = new Map(), seen = new Set(), skipped = [];
    const visit = async (root, relative) => {
      const absolute = path.join(this.directory, root, relative);
      let entries;
      try { entries = await fs.readdir(absolute, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (ignoredSegment(entry.name) || docs.size >= MAX_FILES) continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { await visit(root, child); continue; }
        if (!entry.isFile()) continue;
        const key = `file:${root}/${child}`, file = path.join(this.directory, root, child);
        if (!parseFileKey(key)) continue;
        let stat;
        try { stat = await fs.lstat(file); } catch { continue; }
        if (!stat.isFile()) continue;
        if (stat.size > this.maxFileBytes) { skipped.push(`${root}/${child}`); continue; }
        let cached = this.cache.get(key);
        if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
          try { cached = { size: stat.size, mtimeMs: stat.mtimeMs, sha: await hashFile(file) }; } catch { continue; }
          this.cache.set(key, cached);
        }
        seen.add(key); docs.set(key, { sha: cached.sha, size: cached.size });
      }
    };
    for (const root of ROOTS) await visit(root, '');
    for (const key of [...this.cache.keys()]) if (!seen.has(key)) this.cache.delete(key);
    this.bySha = new Map([...this.cache].map(([key, value]) => [value.sha, key]));
    this.skipped = skipped;
    return docs;
  }

  async target(key) {
    const parsed = parseFileKey(key);
    if (!parsed || parsed.path.split('/').some(ignoredSegment)) return null;
    const base = path.join(this.directory, parsed.root), file = path.join(base, ...parsed.path.split('/'));
    if (!file.startsWith(base + path.sep)) return null;
    // Refuse to write through an existing symlink anywhere along the path.
    let current = base;
    for (const part of parsed.path.split('/')) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(() => null);
      if (stat?.isSymbolicLink()) return null;
      if (!stat) break;
    }
    return file;
  }
  /** Current bytes for a content hash this engine advertised, if the file still has that content. */
  async readBlob(sha) {
    const staged = path.join(this.blobDir, sha);
    const stagedData = await fs.readFile(staged).catch(() => null);
    if (stagedData && createHash('sha256').update(stagedData).digest('hex') === sha) return stagedData;
    const key = this.bySha.get(sha), file = key && await this.target(key);
    if (!file) return null;
    const data = await fs.readFile(file).catch(() => null);
    return data && createHash('sha256').update(data).digest('hex') === sha ? data : null;
  }
  async hasBlob(sha) { return !!(await fs.stat(path.join(this.blobDir, sha)).catch(() => null)) || this.bySha.has(sha); }
  async stageBlob(sha, data) {
    if (!/^[0-9a-f]{64}$/.test(sha) || data.length > this.maxFileBytes || createHash('sha256').update(data).digest('hex') !== sha) return false;
    const temp = path.join(this.blobDir, `${sha}.${randomBytes(4).toString('hex')}.sync-partial`);
    await fs.writeFile(temp, data, { mode: 0o600 }); await fs.rename(temp, path.join(this.blobDir, sha));
    return true;
  }
  /** Places staged content at a file key (or removes it for null). Returns the previous bytes when a conflict copy is needed. */
  async apply(key, value) {
    const file = await this.target(key);
    if (!file) return false;
    if (value === null) {
      await fs.rm(file, { force: true });
      this.cache.delete(key);
      return true;
    }
    const staged = path.join(this.blobDir, value.sha);
    const data = await this.readBlob(value.sha);
    if (!data) return false;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomBytes(4).toString('hex')}.sync-partial`;
    await fs.writeFile(temp, data, { mode: 0o600 }); await fs.rename(temp, file);
    await fs.rm(staged, { force: true });
    const stat = await fs.lstat(file);
    this.cache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, sha: value.sha }); this.bySha.set(value.sha, key);
    return true;
  }
  async readKey(key) { const file = await this.target(key); return file ? fs.readFile(file).catch(() => null) : null; }
  /** Keeps the losing side of a concurrent edit next to the original, as Obsidian-style sync tools do. */
  async conflictCopy(key, data, label) {
    const parsed = parseFileKey(key);
    if (!parsed || !data) return null;
    const extension = path.posix.extname(parsed.path), stem = parsed.path.slice(0, parsed.path.length - extension.length);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
    const copyKey = `file:${parsed.root}/${stem} (conflict ${label.replace(/[^\w .-]/g, '').slice(0, 40)} ${stamp})${extension}`;
    const file = await this.target(copyKey);
    if (!file) return null;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' }).catch(() => {});
    return copyKey;
  }
}
