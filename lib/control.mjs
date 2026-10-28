import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { ensure } from './store.mjs';

// Unix socket paths are limited to about 104 bytes on macOS and 108 on Linux.
const SOCKET_PATH_MAX = process.platform === 'darwin' ? 103 : 107;

/**
 * Where the engine listens for same-user shell commands (npm run pair): inside the private data directory, or, when that
 * path is too long for a Unix socket, in a per-user 0700 directory under /tmp named after the data directory.
 */
export function controlSocketPath(dataDir) {
  const directory = path.resolve(dataDir), direct = path.join(directory, 'control.sock');
  if (Buffer.byteLength(direct) <= SOCKET_PATH_MAX) return direct;
  return path.join('/tmp', `hermes-studio-${process.getuid?.() ?? 'user'}`, `${createHash('sha256').update(directory).digest('hex').slice(0, 24)}.sock`);
}

/** Refuses a socket directory that another account could read or replace. */
export async function prepareControlDirectory(file) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  ensure(stat.isDirectory() && (process.getuid === undefined || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0, 500, `${directory} must be a private directory owned by this account.`);
}

/** Throws unless the socket and its directory belong to this account and nobody else can enter the directory. */
export async function assertOwnedControlSocket(file) {
  const uid = process.getuid?.(), [directory, socket] = await Promise.all([fs.lstat(path.dirname(file)), fs.lstat(file)]);
  ensure(directory.isDirectory() && (directory.mode & 0o077) === 0 && socket.isSocket() && (uid === undefined || (directory.uid === uid && socket.uid === uid)), 403, `${file} is not a private Tupies socket owned by this account. Remove it and restart Tupies.`);
}

/** True when a running engine answers on this control socket, so a second engine never opens the same data directory. */
export const controlSocketLive = file => new Promise(resolve => {
  const probe = net.connect(file);
  probe.once('connect', () => { probe.destroy(); resolve(true); });
  probe.once('error', () => resolve(false));
});
