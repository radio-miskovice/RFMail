// Password hashing for account credentials.
//
// scrypt through node:crypto: no native binding, identical on every platform.
// Accounts created at first run have no password (stored as NULL); a password
// can be set later from the UI, and an empty password then stops being valid.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * Verifies a password against a stored hash.
 *
 * `stored === null` means the account has no password: only an empty password
 * authenticates. Anything else is a mismatch, never an error.
 */
export function verifyPassword(password: string, stored: string | null): boolean {
  if (stored === null) return password === '';
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;
  const [, nRaw, rRaw, pRaw, saltB64, keyB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(keyB64 ?? '', 'base64');
    actual = scryptSync(password, Buffer.from(saltB64 ?? '', 'base64'), expected.length, {
      N,
      r,
      p,
      maxmem: 128 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
