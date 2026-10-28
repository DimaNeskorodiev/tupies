import net from 'node:net';
import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';

// A minimal DER encoder: enough for one self-signed X.509 v3 certificate.
const length = n => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = []; for (let value = n; value; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, ...parts) => { const value = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), length(value.length), value]); };
const sequence = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const oid = dotted => {
  const [first, second, ...rest] = dotted.split('.').map(Number), bytes = [40 * first + second];
  for (const n of rest) { const chunk = [n & 0x7f]; for (let value = n >> 7; value; value >>= 7) chunk.unshift(0x80 | (value & 0x7f)); bytes.push(...chunk); }
  return tlv(0x06, Buffer.from(bytes));
};
const time = date => {
  const digits = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii')) : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'));
};
const extension = (id, value, critical = false) => sequence(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
const ECDSA_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));
// Apple's trust evaluation reports a long-lived TLS certificate as "not standards compliant" (seen on iOS 27), which
// Safari will not let anyone bypass. The certificate therefore stays inside the 47-day limit that public certificates
// reach in 2029, and the engine renews it weekly.
const DAY_MS = 24 * 60 * 60_000, BACKDATE_MS = DAY_MS, VALIDITY_MS = 45 * DAY_MS;
export const CERTIFICATE_RENEWAL_MS = 7 * DAY_MS;

function subjectAltNames(hosts) {
  const names = [];
  for (const host of new Set(hosts.map(value => String(value || '').replace(/^\[|\]$/g, '').toLowerCase()).filter(Boolean))) {
    if (net.isIPv4(host)) names.push(tlv(0x87, Buffer.from(host.split('.').map(Number))));
    else if (net.isIPv6(host) && !host.includes('.') && !host.includes('%')) names.push(tlv(0x87, ipv6Bytes(host)));
    else if (/^[a-z0-9.-]{1,253}$/.test(host)) names.push(tlv(0x82, Buffer.from(host, 'ascii')));
  }
  return sequence(...names);
}
function ipv6Bytes(address) {
  const [head, tail = ''] = address.split('::'), left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return Buffer.from(groups.flatMap(group => { const value = parseInt(group || '0', 16); return [value >> 8, value & 0xff]; }));
}

/**
 * A self-signed TLS certificate over the engine's identity key. Apps and linked engines trust it because its key matches
 * the fingerprint in the pairing link (the "server code"), not because a certificate authority vouches for it, so no
 * domain or public CA is involved. Regenerated at every start and renewed weekly; only the key matters, so the pin never changes.
 */
export function identityCertificate(privateKeyPem, { hosts = [], now = new Date() } = {}) {
  const privateKey = createPrivateKey(privateKeyPem), spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const serial = randomBytes(16); serial[0] = (serial[0] & 0x7f) || 1;
  const name = sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from('Tupies', 'utf8')))));
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ECDSA_SHA256,
    name,
    sequence(time(new Date(now.getTime() - BACKDATE_MS)), time(new Date(now.getTime() + VALIDITY_MS))),
    name,
    spki,
    tlv(0xa3, sequence(
      extension('2.5.29.19', sequence(), true),
      extension('2.5.29.15', tlv(0x03, Buffer.from([0x07, 0x80])), true),
      extension('2.5.29.37', sequence(oid('1.3.6.1.5.5.7.3.1'))),
      extension('2.5.29.17', subjectAltNames(['localhost', '127.0.0.1', '::1', ...hosts]))
    ))
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = sequence(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}
