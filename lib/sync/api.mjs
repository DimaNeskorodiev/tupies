import { HttpError, ensure } from '../store.mjs';
import { validateEngineUrl } from './index.mjs';

const MAX_SEALED_BYTES = 80 * 1024 * 1024;
async function sealedBody(req, max = MAX_SEALED_BYTES) {
  ensure((req.headers['content-type'] || '').split(';')[0].trim() === 'application/octet-stream', 415, 'Use application/octet-stream.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; ensure(size <= max, 413, 'Sync payload is too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export const isEngineRoute = pathname => ['/api/sync/exchange', '/api/sync/oauth-refresh'].includes(pathname) || pathname.startsWith('/api/sync/blobs/');
const sealed = (res, data) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length }); res.end(data); };

/** Unauthenticated device routes: engine identity, pairing and signed session exchange. Returns true when handled. */
export async function syncPublicApi(req, res, url, { sync, body, json, login, rateLimit, access }) {
  const { pathname } = url, method = req.method;
  if (method === 'GET' && pathname === '/api/engine') {
    const identity = sync.identity;
    return json(res, { product: 'hermes-studio', version: '0.5.0', name: identity.name, nodeId: sync.nodeId, fingerprint: identity.fingerprint, publicKey: identity.publicKey, role: sync.role(), ...(sync.options.tls ? { tls: 'identity' } : {}) }), true;
  }
  if (method === 'POST' && pathname === '/api/pair') {
    rateLimit(req);
    return json(res, await sync.devices.pair(await body(req, 16_000)), 201), true;
  }
  if (method === 'POST' && pathname === '/api/device/session') {
    return json(res, sync.devices.signIn(await body(req, 4_000), access.client(req))), true;
  }
  if (method === 'GET' && pathname === '/auth/device') {
    const deviceId = sync.devices.redeemTicket(url.searchParams.get('ticket'));
    ensure(deviceId, 401, 'This sign-in link expired. Open the app again.');
    login(res, deviceId); res.writeHead(302, { Location: '/' }); res.end();
    return true;
  }
  return false;
}

/** Authenticated device management, sync status/linking and engine-to-engine replication. Returns true when handled. */
export async function syncApi(req, res, url, { sync, session, body, json, providers, requestOrigin, access }) {
  const { pathname } = url, method = req.method, devices = sync.devices;
  if (isEngineRoute(pathname)) {
    ensure(session.kind === 'engine', 403, 'Only linked engines can use this route.');
    if (method === 'POST' && pathname === '/api/sync/exchange') {
      const gone = new AbortController();
      res.on('close', () => gone.abort());
      return sealed(res, await sync.exchange(session, await sealedBody(req, 24 * 1024 * 1024), gone.signal)), true;
    }
    if (method === 'POST' && pathname === '/api/sync/oauth-refresh') return sealed(res, await sync.refreshForPeer(session, await sealedBody(req, 4096), providers)), true;
    const match = pathname.match(/^\/api\/sync\/blobs\/([0-9a-f]{64})$/);
    ensure(match, 404, 'Unknown content.');
    if (method === 'GET') return sealed(res, await sync.blobForPeer(session, match[1])), true;
    if (method === 'PUT') return sealed(res, await sync.receiveBlob(session, match[1], await sealedBody(req))), true;
    throw new HttpError(405, 'Method not allowed.');
  }
  // Linked engines only replicate; they do not drive the workspace API.
  ensure(session.kind !== 'engine', 403, 'Linked engines can only use sync routes.');
  if (method === 'POST' && pathname === '/api/device/web-ticket') {
    ensure(session.device, 403, 'Only a paired app can open a web session.');
    await body(req);
    return json(res, devices.webTicket(session.device.id)), true;
  }
  if (method === 'GET' && pathname === '/api/devices') return json(res, { devices: devices.list(), current: session.device?.id || null }), true;
  let match = pathname.match(/^\/api\/devices\/([a-zA-Z0-9_-]{1,120})$/);
  if (match && method === 'PATCH') return json(res, await devices.rename(match[1], (await body(req)).name)), true;
  if (match && method === 'DELETE') return json(res, await devices.revoke(match[1])), true;
  if (method === 'POST' && pathname === '/api/pairing') {
    const input = await body(req);
    const baseUrl = input.url ? validateEngineUrl(input.url) : sync.options.publicUrl || requestOrigin;
    return json(res, devices.createPairing({ kind: input.kind === 'engine' ? 'engine' : 'device', baseUrl }), 201), true;
  }
  if (method === 'GET' && pathname === '/api/sync/status') return json(res, { ...sync.status(), access: access.status(req) }), true;
  if (method === 'PATCH' && pathname === '/api/access') {
    const value = (await body(req)).publicPassword, result = await access.setPublicPassword(value);
    await sync.store.mutate(() => sync.store.audit('security.public-password', value ? 'Password sign-in from the internet turned on' : 'Password sign-in from the internet turned off'));
    return json(res, { ...result, public: access.isPublic(req) }), true;
  }
  if (method === 'PATCH' && pathname === '/api/sync/engine') return json(res, await sync.rename((await body(req)).name)), true;
  if (method === 'POST' && pathname === '/api/sync/connect') return json(res, await sync.connect((await body(req)).link)), true;
  if (method === 'POST' && pathname === '/api/sync/disconnect') { await body(req); return json(res, await sync.disconnect()), true; }
  return false;
}
