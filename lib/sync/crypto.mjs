import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, createCipheriv, createDecipheriv, diffieHellman } from 'node:crypto';
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
  if(key.export({type:'spki',format:'der'}).toString('base64')!==publicKey)throw new HttpError(400,'Use a canonical base64 SPKI P-256 public key.');
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

/** A captured pairing code/public transcript cannot derive this P-256 shared secret. */
const wrappingKey = (privateKey, publicKey, context) => Buffer.from(hkdfSync('sha256',diffieHellman({privateKey:createPrivateKey(privateKey),publicKey:publicKeyObject(publicKey)}),sha256(context),Buffer.from('hermes-studio/key-wrap/v2'),32));
export const wrapWorkspaceKey = (privateKey, publicKey, context, key) => sealBytes(wrappingKey(privateKey,publicKey,context),key,context).toString('base64');
export const unwrapWorkspaceKey = (privateKey, publicKey, context, wrapped) => openBytes(wrappingKey(privateKey,publicKey,context),Buffer.from(String(wrapped),'base64'),context);
export const keyId = key => b64url(sha256(key));
export const ENGINE_PAIR_MESSAGE=(code,hubNodeId,hubFingerprint,nodeId,publicKey,ephemeralKey)=>`hermes-studio/engine-pair/v2\n${JSON.stringify([code,hubNodeId,hubFingerprint,nodeId,publicKey,ephemeralKey])}`;
export const ENGINE_PAIR_CONTEXT=value=>`hermes-studio/engine-paired/v2\n${JSON.stringify([value.code,value.hubNodeId,value.hubFingerprint,value.nodeId,value.publicKey,value.ephemeralKey,value.engineEphemeralKey,value.deviceId,value.workspaceId,value.epoch,value.keyId])}`;
export const WRAPPED_KEY_PROOF=(context,wrapped)=>`${context}\n${keyId(Buffer.from(wrapped,'base64'))}`;
export const SYNC_KEY_CONTEXT=value=>`hermes-studio/sync-key/v2\n${JSON.stringify([value.hubNodeId,value.hubFingerprint,value.deviceId,value.nodeId,value.fingerprint,value.workspaceId,value.epoch,value.keyId,value.nonce])}`;

export const PAIR_MESSAGE = (code, publicKey) => `hermes-studio/pair/v1\n${code}\n${publicKey}`;
export const PAIRED_MESSAGE = (deviceId, publicKey) => `hermes-studio/paired/v1\n${deviceId}\n${publicKey}`;
export const SESSION_MESSAGE = (engineNodeId,engineFingerprint,deviceId,timestamp,nonce) => `hermes-studio/session/v2\n${engineNodeId}\n${engineFingerprint}\n${deviceId}\n${timestamp}\n${nonce}`;
export const SESSION_REVOKED_MESSAGE=value=>`hermes-studio/session-revoked/v2\n${JSON.stringify([value.engineNodeId,value.engineFingerprint,value.deviceId,value.nodeId,value.fingerprint,value.timestamp,value.nonce,value.revokedAt])}`;
