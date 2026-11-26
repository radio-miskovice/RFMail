// LAN names for the addresses the station talks to (decision 42).
//
// rigctld is configured with an address and nothing else, so a tile shows `192.168.133.222:4532`
// and the operator has to remember that this is Quantum-Q1 on the shelf. Two services answer
// that question on a small LAN, and neither needs a dependency:
//
//   NetBIOS   a NBSTAT query to UDP 137. Windows and Samba answer with their computer name,
//             the workgroup and the services they run. This is the first thing asked.
//   mDNS      a PTR query for `<reversed>.in-addr.arpa` on 224.0.0.251:5353, which is what a
//             Mac or a Linux box with avahi publishes as `<name>.local`. Asked when NetBIOS
//             says nothing.
//
// Neither is guaranteed — a plain Linux box with no avahi answers neither — so a miss is a
// null, never an error, and the answer is cached because a name does not change every second.

import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';

export interface HostNameOptions {
  /** Where the NBSTAT query goes; 137 in the field, an ephemeral port in a test. */
  netbiosPort?: number;
  /** Set false to skip the mDNS fallback, as a test with no avahi on the box would. */
  mdns?: boolean;
  /** How long each service gets before it is given up on. */
  timeoutMs?: number;
}

const NBSTAT_PORT = 137;
const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
/** A name is stable; a miss is worth retrying sooner than a hit is worth forgetting. */
const HIT_TTL_MS = 10 * 60_000;
const MISS_TTL_MS = 60_000;

interface CacheEntry {
  name: string | null;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * The LAN name of an address, or null when nothing answers. Loopback and anything that is not
 * an IPv4 address (a host name the operator typed) are not asked about.
 */
export async function lookupHostName(host: string, options: HostNameOptions = {}): Promise<string | null> {
  if (!isIPv4(host) || host.startsWith('127.') || host === '0.0.0.0') return null;

  const cached = cache.get(host);
  if (cached && cached.expires > Date.now()) return cached.name;

  const timeoutMs = options.timeoutMs ?? 800;
  let name = await queryNbstat(host, options.netbiosPort ?? NBSTAT_PORT, timeoutMs);
  if (name === null && options.mdns !== false) {
    name = await queryMdns(host, timeoutMs + 400);
  }

  cache.set(host, { name, expires: Date.now() + (name === null ? MISS_TTL_MS : HIT_TTL_MS) });
  return name;
}

/** Forgets one address, or everything when called with no argument. */
export function forgetHostNames(host?: string): void {
  if (host === undefined) cache.clear();
  else cache.delete(host);
}

// -- NetBIOS ---------------------------------------------------------------

/**
 * The NBSTAT query: first-level encode the wildcard name `*` (padded with zeros to sixteen
 * characters), then ask for type NBSTAT (0x21) in class IN.
 */
export function buildNbstatQuery(transactionId: number): Buffer {
  const name = Buffer.alloc(34);
  name[0] = 0x20;
  const nibbles = [0x2a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let at = 1;
  for (const byte of nibbles) {
    name[at] = 0x41 + (byte >> 4);
    name[at + 1] = 0x41 + (byte & 0x0f);
    at += 2;
  }
  name[33] = 0x00;

  const header = Buffer.alloc(12);
  header.writeUInt16BE(transactionId & 0xffff, 0);
  header.writeUInt16BE(0x0000, 2); // standard query
  header.writeUInt16BE(1, 4); // one question
  const tail = Buffer.from([0x00, 0x21, 0x00, 0x01]); // NBSTAT, IN
  return Buffer.concat([header, name, tail]);
}

/**
 * The computer name out of a NBSTAT answer: the first name entry that is not a group and is
 * the workstation (`00`) or the file-server (`20`) suffix. The workgroup and the service
 * entries are ignored — they describe the network, not the machine.
 */
export function parseNbstat(answer: Buffer): string | null {
  try {
    const questions = answer.readUInt16BE(4);
    const answers = answer.readUInt16BE(6);
    let at = 12;
    for (let i = 0; i < questions; i += 1) at = skipName(answer, at) + 4;
    if (answers === 0 || at + 12 > answer.length) return null;

    // Names are answered with the question's encoded name, then type, class, ttl, length.
    at = skipName(answer, at);
    const type = answer.readUInt16BE(at);
    if (type !== 0x0021) return null;
    at += 8; // type, class, ttl
    const length = answer.readUInt16BE(at);
    at += 2;
    if (at + length > answer.length) return null;

    const count = answer[at] ?? 0;
    let entries = at + 1;
    let fallback: string | null = null;
    for (let i = 0; i < count; i += 1) {
      const name = answer.subarray(entries, entries + 15).toString('latin1').trim();
      const suffix = answer[entries + 15] ?? 0;
      const flags = answer.readUInt16BE(entries + 16);
      const group = (flags & 0x8000) !== 0;
      entries += 18;
      if (!name || group) continue;
      if (suffix === 0x00) return name;
      if (suffix === 0x20 && fallback === null) fallback = name;
    }
    return fallback;
  } catch {
    return null;
  }
}

/** One NBSTAT question to one address; exported so a test can drive it against a fake. */
export async function queryNbstat(host: string, port: number, timeoutMs: number): Promise<string | null> {
  return await new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const finish = (name: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed by an error
      }
      resolve(name);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', () => finish(null));
    socket.on('message', (message) => finish(parseNbstat(message)));
    try {
      socket.send(buildNbstatQuery(0x4d42), port, host);
    } catch {
      finish(null);
    }
  });
}

// -- mDNS ------------------------------------------------------------------

/** The PTR question for an IPv4 address's reverse name, with the unicast-response bit set. */
export function buildReverseQuery(host: string): Buffer {
  const labels = `${host.split('.').reverse().join('.')}.in-addr.arpa`.split('.');
  const parts: Buffer[] = [];
  for (const label of labels) {
    parts.push(Buffer.from([label.length]), Buffer.from(label, 'latin1'));
  }
  parts.push(Buffer.from([0x00]));
  const question = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x0000, 0); // one-shot multicast query carries no id
  header.writeUInt16BE(0x0000, 2);
  header.writeUInt16BE(0x0001, 4);
  const tail = Buffer.from([0x00, 0x0c, 0x80, 0x01]); // PTR, IN + QU
  return Buffer.concat([header, question, tail]);
}

/**
 * The first PTR target in an mDNS answer, without the `.local` suffix. The reply may point at
 * earlier names (compression), which is why the decoding follows pointers.
 */
export function parseMdnsPtr(answer: Buffer): string | null {
  try {
    const questions = answer.readUInt16BE(4);
    const answers = answer.readUInt16BE(6);
    let at = 12;
    for (let i = 0; i < questions; i += 1) at = skipName(answer, at) + 4;
    for (let i = 0; i < answers; i += 1) {
      at = skipName(answer, at);
      const type = answer.readUInt16BE(at);
      at += 8; // type, class, ttl
      const length = answer.readUInt16BE(at);
      at += 2;
      if (type === 0x000c && length > 0) {
        const target = readName(answer, at).replace(/\.$/, '');
        return target.endsWith('.local') ? target.slice(0, -'.local'.length) : target;
      }
      at += length;
    }
    return null;
  } catch {
    return null;
  }
}

async function queryMdns(host: string, timeoutMs: number): Promise<string | null> {
  return await new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const finish = (name: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed by an error
      }
      resolve(name);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', () => finish(null));
    socket.on('message', (message) => finish(parseMdnsPtr(message)));
    try {
      // QU set, so an avahi on the other side answers this socket directly.
      socket.send(buildReverseQuery(host), MDNS_PORT, MDNS_ADDRESS);
    } catch {
      finish(null);
    }
  });
}

// -- names -----------------------------------------------------------------

/** Walks an uncompressed or pointer-compressed name and returns the offset after it. */
function skipName(buffer: Buffer, at: number): number {
  let cursor = at;
  for (let guard = 0; guard < 128; guard += 1) {
    const length = buffer[cursor] ?? 0;
    if (length === 0) return cursor + 1;
    if ((length & 0xc0) === 0xc0) return cursor + 2;
    cursor += length + 1;
  }
  return cursor;
}

/** Reads a name at an offset, following a compression pointer at most once. */
function readName(buffer: Buffer, at: number): string {
  const labels: string[] = [];
  let cursor = at;
  for (let guard = 0; guard < 128; guard += 1) {
    const length = buffer[cursor] ?? 0;
    if (length === 0) break;
    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | (buffer[cursor + 1] ?? 0);
      labels.push(readName(buffer, pointer));
      break;
    }
    labels.push(buffer.subarray(cursor + 1, cursor + 1 + length).toString('latin1'));
    cursor += length + 1;
  }
  return labels.join('.');
}
