import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, createCipheriv, createDecipheriv } from 'node:crypto';
import { HttpError } from '../store.mjs';

/** Engine and device identities are P-256 ECDSA keys so Apple devices can keep theirs in the Secure Enclave. */
export const b64url = buffer => Buffer.from(buffer).toString('base64url');
export const sha256 = value => createHash('sha256').update(value).digest();
export const digest = value => createHash('sha1').update(value).digest('base64url');
export const hmac = (key, value) => createHmac('sha256', key).update(value).digest('base64url');

export function generateIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: der.toString('base64'), fingerprint: fingerprint(der) };
}
export const fingerprint = publicKey => b64url(sha256(Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey, 'base64')));
export const shortFingerprint = value => String(value || '').slice(0, 8).replace(/(.{4})/, '$1 ').toUpperCase();

/** Parses a canonical base64 SPKI P-256 key; anything else is refused. */
export function publicKeyObject(publicKey) {
  if (typeof publicKey !== 'string' || publicKey.length > 400 || !/^[A-Za-z0-9+/]+=*$/.test(publicKey)) throw new HttpError(400, 'Device public key must be base64 SPKI DER.');
  let key;
  try { key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }); } catch { throw new HttpError(400, 'Device public key could not be read.'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new HttpError(400, 'Device keys must be P-256.');
  return key;
}
export const signMessage = (privateKeyPem, message) => sign('sha256', Buffer.from(message, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64');
export function verifyMessage(publicKey, message, signature) {
  if (typeof signature !== 'string' || signature.length > 200) return false;
  try { return verify('sha256', Buffer.from(message, 'utf8'), typeof publicKey === 'string' ? publicKeyObject(publicKey) : publicKey, Buffer.from(signature, 'base64')); } catch { return false; }
}

/** Authenticated encryption for engine-to-engine payloads: version byte, IV, tag, ciphertext. */
export function sealBytes(key, plaintext, aad) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}
export function openBytes(key, sealed, aad) {
  if (!Buffer.isBuffer(sealed) || sealed.length < 29 || sealed[0] !== 1) throw new HttpError(400, 'Sync payload is not a sealed Tupies envelope.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 13));
    decipher.setAAD(Buffer.from(aad, 'utf8')); decipher.setAuthTag(sealed.subarray(13, 29));
    return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
  } catch { throw new HttpError(400, 'Sync payload could not be authenticated with this workspace key.'); }
}
export const sealJson = (key, value, aad) => sealBytes(key, Buffer.from(JSON.stringify(value), 'utf8'), aad);
export const openJson = (key, sealed, aad) => JSON.parse(openBytes(key, sealed, aad).toString('utf8'));

/** The workspace key travels only inside a key derived from the single-use pairing code. */
const wrappingKey = (code, nodeId) => Buffer.from(hkdfSync('sha256', Buffer.from(code, 'utf8'), Buffer.from(nodeId, 'utf8'), Buffer.from('hermes-studio/workspace-key/v1', 'utf8'), 32));
export const wrapWorkspaceKey = (code, nodeId, key) => sealBytes(wrappingKey(code, nodeId), key, 'workspace-key').toString('base64');
export const unwrapWorkspaceKey = (code, nodeId, wrapped) => openBytes(wrappingKey(code, nodeId), Buffer.from(String(wrapped), 'base64'), 'workspace-key');

export const PAIR_MESSAGE = (code, publicKey) => `hermes-studio/pair/v1\n${code}\n${publicKey}`;
export const PAIRED_MESSAGE = (deviceId, publicKey) => `hermes-studio/paired/v1\n${deviceId}\n${publicKey}`;
export const SESSION_MESSAGE = (deviceId, timestamp, nonce) => `hermes-studio/session/v1\n${deviceId}\n${timestamp}\n${nonce}`;
