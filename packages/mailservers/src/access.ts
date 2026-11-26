// Peer access policy for the mail services.
//
// Two named modes, exactly as specified: "very strict" reaches only the
// loopback interface, "strict" accepts peers inside configured CIDRs. Both are
// enforced on the accepted socket's peer address, so a proxy or a stray route
// cannot widen the access the operator chose.

import { isIP } from 'node:net';
import type { AccessMode } from '@rfmail/shared';

// The mode is named where the API and the UI can see it (shared); this module owns the
// enforcement and the parsing, and re-exports the type for its own callers.
export type { AccessMode };

interface Cidr {
  family: 4 | 6;
  bytes: Uint8Array;
  bits: number;
}

function ipv4ToBytes(address: string): Uint8Array | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const value = Number(parts[i]);
    if (!/^\d{1,3}$/.test(parts[i] ?? '') || value < 0 || value > 255) return null;
    out[i] = value;
  }
  return out;
}

function ipv6ToBytes(address: string): Uint8Array | null {
  const clean = address.split('%')[0] ?? address; // strip zone id
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (head.length + tail.length);
  if (halves.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const group = groups[i] ?? '0';
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    out[i * 2] = value >> 8;
    out[i * 2 + 1] = value & 0xff;
  }
  return out;
}

/** Maps `::ffff:192.168.1.7` onto its IPv4 form; leaves other addresses alone. */
export function normalisePeer(address: string): string {
  const lowered = address.toLowerCase();
  if (lowered.startsWith('::ffff:') && isIP(lowered.slice(7)) === 4) {
    return lowered.slice(7);
  }
  return lowered;
}

export function isLoopback(address: string): boolean {
  const normal = normalisePeer(address);
  if (isIP(normal) === 4) return normal.startsWith('127.');
  if (isIP(normal) === 6) return normal === '::1' || normal === '0:0:0:0:0:0:0:1';
  return false;
}

function parseCidr(input: string): Cidr | null {
  const [addressPart, bitsPart] = input.trim().split('/');
  if (!addressPart) return null;
  const address = normalisePeer(addressPart);
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4ToBytes(address);
    if (!bytes) return null;
    const bits = bitsPart === undefined ? 32 : Number(bitsPart);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    return { family: 4, bytes, bits };
  }
  if (family === 6) {
    const bytes = ipv6ToBytes(address);
    if (!bytes) return null;
    const bits = bitsPart === undefined ? 128 : Number(bitsPart);
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) return null;
    return { family: 6, bytes, bits };
  }
  return null;
}

function matches(peer: Uint8Array, cidr: Cidr): boolean {
  if (peer.length !== cidr.bytes.length) return false;
  const wholeBytes = Math.floor(cidr.bits / 8);
  for (let i = 0; i < wholeBytes; i += 1) {
    if (peer[i] !== cidr.bytes[i]) return false;
  }
  const remainder = cidr.bits % 8;
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder);
  return ((peer[wholeBytes] ?? 0) & mask) === ((cidr.bytes[wholeBytes] ?? 0) & mask);
}

/**
 * Validates a mode and its CIDRs in one go, and answers with the parsed forms. The
 * constructor and `set()` share it, so a policy that could not start cannot be installed
 * from the UI either.
 */
function parsePolicy(mode: AccessMode, cidrs: string[]): { cidrs: Cidr[]; texts: string[] } {
  const parsed: Cidr[] = [];
  const texts: string[] = [];
  for (const entry of cidrs) {
    const text = entry.trim();
    if (text === '') continue;
    const cidr = parseCidr(text);
    if (!cidr) throw new Error(`invalid CIDR in access policy: ${text}`);
    parsed.push(cidr);
    texts.push(text);
  }
  if (mode === 'strict' && parsed.length === 0) {
    throw new Error('access mode "strict" requires at least one CIDR');
  }
  return { cidrs: parsed, texts };
}

export class PeerPolicy {
  private currentMode: AccessMode;
  private currentCidrs: Cidr[];
  private currentTexts: string[];

  constructor(mode: AccessMode, cidrs: string[] = []) {
    const parsed = parsePolicy(mode, cidrs);
    this.currentMode = mode;
    this.currentCidrs = parsed.cidrs;
    this.currentTexts = parsed.texts;
  }

  get mode(): AccessMode {
    return this.currentMode;
  }

  /** The CIDRs as the operator wrote them, trimmed and in the order given. */
  get cidrs(): string[] {
    return [...this.currentTexts];
  }

  /**
   * Replaces the policy in a single step: the mode and the CIDRs are validated before
   * anything is assigned, so a rejected change leaves the station exactly as it was.
   * Every listener and the HTTP API read this object per connection, so the new policy
   * applies to the next peer without touching the sockets.
   */
  set(mode: AccessMode, cidrs: string[]): void {
    const parsed = parsePolicy(mode, cidrs);
    this.currentMode = mode;
    this.currentCidrs = parsed.cidrs;
    this.currentTexts = parsed.texts;
  }

  allows(remoteAddress: string | undefined): boolean {
    if (!remoteAddress) return false;
    if (this.currentMode === 'very strict') return isLoopback(remoteAddress);
    const normal = normalisePeer(remoteAddress);
    if (isLoopback(normal)) return true;
    const family = isIP(normal);
    if (family === 0) return false;
    const bytes = family === 4 ? ipv4ToBytes(normal) : ipv6ToBytes(normal);
    if (!bytes) return false;
    return this.currentCidrs.some((cidr) => matches(bytes, cidr));
  }

  describe(): string {
    if (this.currentMode === 'very strict') return 'very strict (loopback only)';
    return `strict (${this.currentCidrs.length} CIDR${this.currentCidrs.length === 1 ? '' : 's'}: ${this.currentCidrs
      .map((c) => `${bytesToText(c)}/${c.bits}`)
      .join(', ')})`;
  }
}

function bytesToText(cidr: Cidr): string {
  if (cidr.family === 4) return Array.from(cidr.bytes).join('.');
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((cidr.bytes[i] ?? 0) << 8 | (cidr.bytes[i + 1] ?? 0)).toString(16));
  }
  return groups.join(':');
}
