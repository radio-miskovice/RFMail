import { createHash } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Protocol MID: md5 over the timestamp and a seed (the callsign), base32,
 * first 12 characters. Peers never parse it; uniqueness is what matters.
 */
export function generateMid(seed: string, now: number = Date.now()): string {
  const digest = createHash('md5').update(`${now}-${seed.toUpperCase()}`).digest();
  return base32(new Uint8Array(digest)).slice(0, 12);
}
