// Proposals, the SID line and the secure-login response — the parts of an FBB
// B2 session that are pure text.
//
// A block of proposals looks like this, at most five per block:
//
//   FC EM ABCDEFGHJKLM 527 123 0
//   FC EM QRSTUVWXYZAB 218 118 0
//   F> 8C
//
// `FC` is an LZHUF-compressed message, `FD` a gzip one; `EM` is a message and
// `CM` a Winlink control message; the first number is the uncompressed size, the
// second the compressed size, and the last field is reserved. `F>` carries the
// checksum over every byte of the proposal lines, including their CR.
//
// See REQUIREMENTS.md R4.3 and references/b2f-wire-protocol.md in the project's
// skill for the full session outline.

import { createHash } from 'node:crypto';

/** Proposal codes: C = LZHUF (the normal case), D = gzip, B/A = legacy. */
export type ProposalCode = 'B' | 'A' | 'C' | 'D';
export type ProposalMessageType = 'EM' | 'CM';
/** Answer characters, in the order the protocol defines them. */
export type ProposalAnswer = '+' | 'Y' | '-' | 'N' | 'R' | '=' | 'L' | 'H' | 'A' | '!';

export interface Proposal {
  code: ProposalCode;
  messageType: ProposalMessageType;
  mid: string;
  /** Uncompressed message size in bytes. */
  size: number;
  /** Compressed size in bytes, which is what actually travels. */
  compressedSize: number;
}

/** Proposals per block, before the `F>` checksum line. */
export const MAX_PROPOSALS_PER_BLOCK = 5;
/** The offset field holds six digits; a peer asking for more is asking for 0. */
export const MAX_OFFSET = 999999;

/** `FC EM MID size csize 0`, without the line terminator. */
export function formatProposal(proposal: Proposal): string {
  return (
    `F${proposal.code} ${proposal.messageType} ${proposal.mid} ` +
    `${proposal.size} ${proposal.compressedSize} 0`
  );
}

/**
 * Parses `FC EM MID 527 123 0`. Legacy `FB`/`FA` proposals are reported with
 * their code so the caller can answer "defer" rather than fail the session.
 */
export function parseProposal(line: string): Proposal {
  const text = line.replace(/[\r\n]+$/, '');
  if (text.length < 4 || (text[0] !== 'F' && text[0] !== 'f')) {
    throw new Error(`not a proposal line: ${text}`);
  }
  const code = text[1]?.toUpperCase() as ProposalCode;
  if (!['B', 'A', 'C', 'D'].includes(code)) {
    throw new Error(`unsupported proposal code '${text[1]}'`);
  }
  const parts = text.slice(3).split(/\s+/).filter(Boolean);
  if (parts.length < 4) throw new Error(`malformed proposal: ${text}`);
  const messageType = (parts[0] ?? '').toUpperCase();
  if (messageType !== 'EM' && messageType !== 'CM') {
    throw new Error(`expected message type CM or EM, found ${parts[0]}`);
  }
  const mid = (parts[1] ?? '').toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(mid)) throw new Error(`malformed MID in proposal: ${text}`);
  const size = Number(parts[2]);
  const compressedSize = Number(parts[3]);
  if (!Number.isInteger(size) || size < 0 || !Number.isInteger(compressedSize) || compressedSize < 0) {
    throw new Error(`malformed sizes in proposal: ${text}`);
  }
  return { code, messageType, mid, size, compressedSize };
}

/**
 * The `F>` checksum: the sum of every byte of the proposal lines *including*
 * their CR, negated and masked to one byte, printed as two upper-case hex
 * digits. A block of zero proposals cannot be checksummed — send `FF` instead.
 */
export function proposalChecksum(lines: readonly string[]): string {
  let sum = 0;
  for (const line of lines) {
    const text = line.replace(/[\r\n]+$/, '');
    for (let index = 0; index < text.length; index += 1) sum = (sum + text.charCodeAt(index)) & 0xff;
    sum = (sum + 0x0d) & 0xff;
  }
  return ((-sum) & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

export function formatProposalBlock(proposals: readonly Proposal[]): string[] {
  if (proposals.length === 0) return ['FF'];
  if (proposals.length > MAX_PROPOSALS_PER_BLOCK) {
    throw new Error(`a block carries at most ${MAX_PROPOSALS_PER_BLOCK} proposals`);
  }
  const lines = proposals.map(formatProposal);
  return [...lines, `F> ${proposalChecksum(lines)}`];
}

/**
 * Answers a block: one character per proposal, in the order they were offered,
 * optionally followed by the offset for `A`/`!`. Answering a different number of
 * proposals than were offered is a protocol error the peer will act on, so the
 * caller is expected to know how many arrived.
 */
export function formatAnswers(answers: readonly ProposalAnswer[]): string {
  return answers.join('');
}

/** Maps a peer's answer character onto the three decisions that matter here. */
export function readAnswer(reply: string, index: number): { decision: 'accept' | 'reject' | 'defer'; offset: number } {
  const character = reply[index] ?? '';
  switch (character) {
    case '+':
    case 'Y':
      return { decision: 'accept', offset: 0 };
    case 'A':
    case '!': {
      const digits = /^(\d{1,9})/.exec(reply.slice(index + 1))?.[1];
      const offset = digits ? Number(digits) : 0;
      // The protocol cannot express an offset past six digits: start from 0.
      return { decision: 'accept', offset: offset > MAX_OFFSET ? 0 : offset };
    }
    case '-':
    case 'N':
    case 'R':
      return { decision: 'reject', offset: 0 };
    case '=':
    case 'L':
    case 'H':
      return { decision: 'defer', offset: 0 };
    default:
      throw new Error(`unknown proposal answer '${character}'`);
  }
}

export interface Sid {
  /** Application name as advertised, e.g. `WL2K` or `rfmail`. */
  application: string;
  version: string;
  /** Upper-cased flag letters, e.g. `B2FHM$`. */
  flags: string;
}

/**
 * Parses a SID line such as `[WL2K-5.0-B2FWIHJM$]`. The name and version may not
 * contain a dash: everything after the last dash is the flag field.
 */
export function parseSid(line: string): Sid | null {
  const match = /\[([^\]]+)\]/.exec(line);
  if (!match?.[1]) return null;
  const body = match[1];
  const lastDash = body.lastIndexOf('-');
  if (lastDash === -1) return { application: '', version: '', flags: body.toUpperCase() };
  const head = body.slice(0, lastDash);
  const flags = body.slice(lastDash + 1).toUpperCase();
  const dash = head.indexOf('-');
  if (dash === -1) return { application: head, version: '', flags };
  return { application: head.slice(0, dash), version: head.slice(dash + 1), flags };
}

/** A peer must advertise `B2` before a compressed session makes sense. */
export function supportsB2(sid: Sid): boolean {
  return /\bB2\b/.test(sid.flags) || sid.flags.includes('B2');
}

/** The SID this station sends; `G` advertises gzip proposals. */
export function localSid(application = 'rfmail', version = '0.1', flags = 'B2FHM$G'): string {
  const safeVersion = version.replace(/-/g, '.');
  return `[${application}-${safeVersion}-${flags}]`;
}

/**
 * The published 64-byte Winlink salt, copied as bytes from paclink-unix through
 * wl2k-go. Copied, never retyped: one wrong byte silently fails every login.
 */
export const WINLINK_SECURE_SALT = Uint8Array.from([
  77, 197, 101, 206, 190, 249, 93, 200, 51, 243, 93, 237, 71, 94, 239, 138, 68, 108, 70, 185, 225,
  137, 217, 16, 51, 122, 193, 48, 194, 195, 198, 175, 172, 169, 70, 84, 61, 62, 104, 186, 114, 52,
  61, 168, 66, 129, 192, 208, 187, 249, 232, 193, 41, 113, 41, 45, 240, 16, 29, 228, 208, 228, 61,
  20,
]);

/**
 * The `;PR` response: md5 over challenge || password || salt, the low four bytes
 * packed little-endian with the top two bits of the last byte masked, printed as
 * eight decimal digits. This is not a digest of the password and not the
 * password: a caller that sends either gets rejected on the air.
 */
export function secureLoginResponse(challenge: string, password: string): string {
  const hash = createHash('md5');
  hash.update(Buffer.from(challenge, 'latin1'));
  hash.update(Buffer.from(password, 'latin1'));
  hash.update(Buffer.from(WINLINK_SECURE_SALT));
  const sum = hash.digest();

  let value = (sum[3] ?? 0) & 0x3f;
  for (let index = 2; index >= 0; index -= 1) value = value * 256 + (sum[index] ?? 0);
  return String(value).padStart(8, '0').slice(-8);
}

/** `;FW: OK4RM OK1ABC` — the addresses this station wants mail for. */
export function forwarderLine(callsign: string, auxiliary: readonly string[] = []): string {
  return `;FW: ${[callsign, ...auxiliary].join(' ')}`;
}

/** `; <target> DE <callsign> (<locator>)`, with `>` when this side is master. */
export function greetingLine(target: string, callsign: string, locator: string, master = false): string {
  const tail = locator ? ` (${locator})` : '';
  return `; ${target.toUpperCase()} DE ${callsign.toUpperCase()}${tail}${master ? '>' : ''}`;
}

export type Precedence = 'flash' | 'immediate' | 'priority' | 'routine';

/**
 * Precedence lives only in the subject prefix, so a block is ordered by reading
 * it out of the subject rather than from a field of our own.
 */
export function precedenceOf(subject: string): Precedence {
  const match = /^\/\/WL2K\s+([ZOP])\//i.exec(subject);
  switch (match?.[1]?.toUpperCase()) {
    case 'Z':
      return 'flash';
    case 'O':
      return 'immediate';
    case 'P':
      return 'priority';
    default:
      return 'routine';
  }
}

const PRECEDENCE_ORDER: Record<Precedence, number> = { flash: 0, immediate: 1, priority: 2, routine: 3 };

/** Sorts outbound proposals by precedence, keeping the offered order within a class. */
export function sortByPrecedence<T extends { subject: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => PRECEDENCE_ORDER[precedenceOf(a.subject)] - PRECEDENCE_ORDER[precedenceOf(b.subject)]);
}
