// Pairs a phone, Mac or another engine from the server's shell: no browser or password needed.
// Usage: npm run pair                    a phone or Mac app (shows a QR code)
//        npm run pair -- --engine        a link for Devices & sync → Connect to a home server
//        npm run pair -- --url https://… use this address in the link instead of STUDIO_PUBLIC_URL
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-generator';
import { controlSocketPath, assertOwnedControlSocket } from '../lib/control.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('npm run pair                  Pair a phone or Mac app with this engine (QR code)\nnpm run pair -- --engine      Link another engine (paste in Devices & sync → Connect to a home server)\nnpm run pair -- --url <https> Put this address in the link instead of STUDIO_PUBLIC_URL');
  process.exit(0);
}
const kind = args.includes('--engine') ? 'engine' : 'device';
const urlIndex = args.indexOf('--url'), url = urlIndex >= 0 ? args[urlIndex + 1] : undefined;
if (urlIndex >= 0 && !url) { console.error('Add the address after --url, for example --url https://studio.example.com'); process.exit(1); }
const dataDir = process.env.STUDIO_DATA_DIR || path.join(root, 'data'), file = controlSocketPath(dataDir);

function request(message) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(file);
    let reply = '';
    socket.setTimeout(10_000, () => { socket.destroy(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', chunk => { reply += chunk; });
    socket.on('end', () => { try { resolve(JSON.parse(reply)); } catch { reject(new Error('Tupies sent an unexpected reply.')); } });
    socket.on('error', reject);
  });
}

/** Two modules per character cell with explicit black-on-white colors, so the code scans on dark and light terminals. */
function terminalQr(text) {
  const qr = qrcode(0, 'L'); qr.addData(text); qr.make();
  const size = qr.getModuleCount(), margin = 2, dark = (r, c) => r >= 0 && c >= 0 && r < size && c < size && qr.isDark(r, c);
  const lines = [];
  for (let r = -margin; r < size + margin; r += 2) {
    let line = '';
    for (let c = -margin; c < size + margin; c++) line += `\x1b[${dark(r, c) ? 30 : 97};${dark(r + 1, c) ? 40 : 107}m▀`;
    lines.push(`  ${line}\x1b[0m`);
  }
  return lines.join('\n');
}

let reply;
// Another local account could otherwise listen at a socket path under /tmp first and hand out its own pairing links.
try { await assertOwnedControlSocket(file); reply = await request({ v: 1, command: 'pair', kind, ...(url ? { url } : {}) }); }
catch (error) {
  if (error.status === 403) console.error(error.message);
  else if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) console.error(`Tupies is not running with the data directory ${dataDir}.\nStart it first (npm start), then run this again. In Docker: docker compose exec studio npm run pair`);
  else if (error.code === 'EACCES') console.error('Run this as the same user that runs Tupies.');
  else console.error(`Could not reach Tupies: ${error.message}`);
  process.exit(1);
}
if (!reply.ok) { console.error(reply.error); process.exit(1); }

const { pairing } = reply, code = pairing.fingerprint.slice(0, 8).toUpperCase().replace(/(.{4})/, '$1 ');
const expires = new Date(pairing.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|\[::\])(:|\/|$)/.test(pairing.url);
if (kind === 'engine') {
  console.log(`\nLink another engine to “${pairing.name}”\n\nOn the other engine (for example Tupies on your Mac), open Devices & sync → Connect to a home server and paste:\n\n${pairing.link}\n`);
} else {
  console.log(`\nPair a phone or Mac with “${pairing.name}”\n`);
  if (process.stdout.isTTY) console.log(`${terminalQr(pairing.link)}\n`);
  console.log(`In the Tupies app, choose Scan QR code${process.stdout.isTTY ? '' : ' or paste the link'}. You can also open this link on the device:\n\n${pairing.link}\n`);
}
console.log(`Server code ${code}: check that the ${kind === 'engine' ? 'other engine' : 'app'} shows the same.\nThe link works once and expires at ${expires}.`);
if (local) console.log(`\nNote: the link points at ${pairing.url}, which other devices cannot reach. Set STUDIO_PUBLIC_URL to this engine's HTTPS address, or add --url https://….`);
