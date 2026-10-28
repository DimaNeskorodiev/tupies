// Engine side of the crypto interop check (uses the real lib/sync/crypto.mjs; no server).
// Usage: node engine-side.mjs <repo> sign <out.json>   |   node engine-side.mjs <repo> verify <swift.json>
import { readFileSync, writeFileSync } from 'node:fs';
const [repo, mode, file] = process.argv.slice(2);
const c = await import(`${repo}/lib/sync/crypto.mjs`);
const { identityCertificate } = await import(`${repo}/lib/sync/certificate.mjs`);
const { generateKeyPairSync } = await import('node:crypto');
const der = pem => pem.replace(/-----[^-]+-----|\s/g, '');
if (mode === 'sign') {
  const id = c.generateIdentity();
    const params = new URLSearchParams({ v: '1', url: 'http://127.0.0.1:4311', code: 'abc_DEF-123', fp: id.fingerprint, name: 'Home server + lab', kind: 'device' });
  // The engine's TLS certificate (STUDIO_TLS=engine), another engine's, and one with a P-384 key that must not be pinnable.
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const certificates = { own: der(identityCertificate(id.privateKey, { hosts: ['203.0.113.5'] })), other: der(identityCertificate(c.generateIdentity().privateKey)), p384: der(identityCertificate(p384)) };
  writeFileSync(file, JSON.stringify({ identity: { publicKey: id.publicKey, fingerprint: id.fingerprint, privateKey: id.privateKey }, link: `hermes-studio://pair?${params}`, short: c.shortFingerprint(id.fingerprint), certificates }));
  console.log('engine identity written');
} else {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const ok1 = c.verifyMessage(s.publicKey, c.PAIR_MESSAGE(s.code, s.publicKey), s.proof);
  const ok2 = c.verifyMessage(s.publicKey, c.SESSION_MESSAGE(s.deviceId, s.timestamp, s.nonce), s.sessionSignature);
  const fp = c.fingerprint(s.publicKey) === s.deviceFingerprint;
  const engine = JSON.parse(readFileSync(s.engineFile, 'utf8'));
  const proof = c.signMessage(engine.identity.privateKey, c.PAIRED_MESSAGE(s.deviceId, s.publicKey));
  writeFileSync(s.engineFile + '.proof', proof);
  console.log(JSON.stringify({ pairProofValid: ok1, sessionSignatureValid: ok2, deviceFingerprintMatches: fp }));
  if (!(ok1 && ok2 && fp)) process.exit(1);
}
