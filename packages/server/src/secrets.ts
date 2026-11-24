// Sealing for secrets that have to be read back: the Winlink (CMS) secure-login
// password is sent to the gateway during a B2F session, so it cannot be hashed
// like the mail password. It is encrypted with AES-256-GCM under a key derived
// from `[server] store_key`, which is written to the configuration file on
// first start — separate from the session secret, so rotating the session key
// does not destroy stored credentials.
//
// The blob is self-describing: `v1.<iv>.<tag>.<ciphertext>`, each field base64url
// without padding. A version prefix leaves room for a key or algorithm change
// without guessing at old rows.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AAD = Buffer.from('rfmail/winlink-credential');

function b64(buf: Buffer): string {
  return buf.toString('base64url');
}

function deriveKey(storeKey: string): Buffer {
  // hkdfSync returns an ArrayBuffer in older typings and a Buffer in newer ones.
  const derived = hkdfSync(
    'sha256',
    Buffer.from(storeKey, 'base64'),
    Buffer.from('rfmail'),
    Buffer.from('secret-sealing'),
    KEY_BYTES,
  );
  return Buffer.from(derived as ArrayBuffer);
}

export function sealSecret(plaintext: string, storeKey: string): string {
  if (!storeKey) throw new Error('cannot seal a secret without a store key');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(storeKey), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, b64(iv), b64(tag), b64(ciphertext)].join('.');
}

export function openSecret(blob: string, storeKey: string): string | null {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1] ?? '', 'base64url');
    const tag = Buffer.from(parts[2] ?? '', 'base64url');
    const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(storeKey), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key or a tampered blob: the caller treats it as "no credential".
    return null;
  }
}

/** Constant-time comparison for anything secret that arrives over the wire. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
