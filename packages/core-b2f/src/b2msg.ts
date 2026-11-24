// The Winlink message structure of the FBB B2 protocol.
//
// On the wire a message is a block of headers, a blank line, a body of exactly
// the length declared by `Body:`, then each attachment of exactly its declared
// `File:` length followed by CRLF, in header order. Nothing is self-delimiting:
// every length is checked against the stream and a short block is an error, not
// a short message (see REQUIREMENTS.md R4.2.1 and the "lengths are declared"
// invariant).
//
//   Mid: ABCDEFGHJKLM
//   Date: 2026/11/24 18:20
//   Cc: OK1ABC
//   From: OK4RM
//   Subject: Hello
//   To: LA5NTA
//   Type: Private
//   Body: 26
//   File: 12 note.txt
//
//   <26 bytes of body><CRLF><12 bytes of file><CRLF>
//
// Header order on write: `Mid` first, then the remaining keys in stable sorted
// order, so a re-send is byte-for-byte reproducible. On read any order is
// accepted and unknown headers are kept.

import type { MailAttachment, MailMessage } from './message.ts';
import { toWinlinkAddress } from './address.ts';

const CRLF = '\r\n';
/** A message larger than this is refused before any buffer is allocated. */
export const MAX_B2_MESSAGE_BYTES = 128 * 1024 * 1024;

export type B2MessageType = 'Private' | 'Service' | 'Inquiry' | 'Position Report' | 'Option' | 'System';

export const B2_MESSAGE_TYPES: B2MessageType[] = [
  'Private',
  'Service',
  'Inquiry',
  'Position Report',
  'Option',
  'System',
];

export interface B2Message {
  mid: string;
  /** Epoch milliseconds, UTC. Serialised as `YYYY/MM/DD HH:MM`. */
  dateUtc: number;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  type: B2MessageType;
  /** MBO address for a message left in a mailbox by store-and-forward. */
  mbo: string;
  body: string;
  /** Original charset, so a body received as ISO-8859-1 can be sent back so. */
  charset: string;
  attachments: MailAttachment[];
  /** Headers the model does not own, kept in order for a faithful re-send. */
  headers: Array<[string, string]>;
}

/** Headers the structure owns; they are regenerated from the fields. */
const MODELLED = new Set([
  'mid',
  'date',
  'from',
  'to',
  'cc',
  'subject',
  'type',
  'mbo',
  'body',
  'file',
  'content-type',
  'content-transfer-encoding',
]);

const utf8Encode = new TextEncoder();
const utf8Decode = new TextDecoder('utf-8', { fatal: false });
const latin1Decode = new TextDecoder('latin1');

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY/MM/DD HH:MM`, UTC — the form RMS Express writes and every peer reads. */
export function formatB2Date(epochMs: number): string {
  const date = new Date(epochMs);
  return (
    `${date.getUTCFullYear()}/${two(date.getUTCMonth() + 1)}/${two(date.getUTCDate())} ` +
    `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`
  );
}

/**
 * Parses every `Date:` spelling seen in the field: the canonical
 * `YYYY/MM/DD HH:MM`, RMS Relay's `YYYY.MM.DD HH:MM`, radio-only
 * `YYYY-MM-DD HH:MM`, BPQ's `YYYYMMDDHHMMSS`, and RFC 5322 forms with an
 * optional day name, seconds and zone.
 */
export function parseB2Date(value: string): number | null {
  const text = value.trim();
  if (text === '') return null;

  let match = /^(\d{4})[/.-](\d{2})[/.-](\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour ?? '0'),
      Number(minute ?? '0'),
      Number(second ?? '0'),
    );
  }

  match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
  }

  // RFC 5322, with or without a day name, seconds or zone.
  const rfc = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?(?:\s*([+-]\d{4}))?/.exec(
    text,
  );
  if (rfc) {
    const [, day, monthName, year, hour, minute, second, zone] = rfc;
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf((monthName ?? '').toLowerCase());
    if (month !== -1) {
      let ms = Date.UTC(
        Number(year),
        month,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second ?? '0'),
      );
      if (zone) {
        const sign = zone.startsWith('-') ? -1 : 1;
        const offset = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5));
        ms -= sign * offset * 60 * 1000;
      }
      return ms;
    }
  }

  const fallback = Date.parse(text);
  return Number.isNaN(fallback) ? null : fallback;
}

function headerValue(headers: Map<string, string[]>, name: string): string {
  return headers.get(name)?.[0]?.trim() ?? '';
}

function headerList(headers: Map<string, string[]>, name: string): string[] {
  return (headers.get(name) ?? []).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Parses one message block. `raw` is the message exactly as framed on the wire,
 * without the transfer framing; the trailing CRLF after the last attachment is
 * tolerated but not required.
 */
export function parseB2Message(raw: Uint8Array): B2Message {
  const separator = Buffer.from(raw).indexOf(`${CRLF}${CRLF}`, 0, 'latin1');
  if (separator === -1) throw new Error('message has no header terminator');

  const headerBlock = Buffer.from(raw).subarray(0, separator).toString('latin1');
  const rest = Buffer.from(raw).subarray(separator + 4);

  const headers = new Map<string, string[]>();
  const extras: Array<[string, string]> = [];
  let currentName = '';
  for (const line of headerBlock.split(CRLF)) {
    if (line === '') continue;
    if (/^[ \t]/.test(line) && currentName) {
      const list = headers.get(currentName) ?? [];
      const last = list.length - 1;
      if (last >= 0) list[last] = `${list[last]} ${line.trim()}`;
      headers.set(currentName, list);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).replace(/^ /, '');
    currentName = name;
    const list = headers.get(name) ?? [];
    list.push(value);
    headers.set(name, list);
    if (!MODELLED.has(name)) extras.push([line.slice(0, colon).trim(), value]);
  }

  const bodyLength = Number(headerValue(headers, 'body'));
  if (!Number.isInteger(bodyLength) || bodyLength < 0) {
    throw new Error('message has no valid Body: length');
  }
  if (bodyLength > MAX_B2_MESSAGE_BYTES || bodyLength > rest.length) {
    throw new Error(`declared body length ${bodyLength} exceeds the block (${rest.length} bytes)`);
  }

  const contentTypeHeader = headerValue(headers, 'content-type');
  const charsetMatch = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentTypeHeader);
  const charset = (charsetMatch?.[1] ?? 'ISO-8859-1').toUpperCase();

  // The body is `bodyLength` *bytes* in the declared charset: decode those bytes,
  // never the string the whole block was read as.
  const bodyBytes = raw.subarray(separator + 4, separator + 4 + bodyLength);
  const decodedBody =
    charset === 'UTF-8' || charset === 'UTF8' ? utf8Decode.decode(bodyBytes) : latin1Decode.decode(bodyBytes);
  // The model keeps LF, like the RFC 822 parser: the wire form is CRLF.
  const body = decodedBody.replace(/\r\n/g, '\n');

  // After the body: a CRLF, then each attachment with its declared length.
  let cursor = bodyLength;
  if (rest.subarray(cursor, cursor + 2).toString('latin1') === CRLF) cursor += 2;

  const attachments: MailAttachment[] = [];
  for (const value of headerList(headers, 'file')) {
    const match = /^(\d+)\s+(.*)$/.exec(value);
    if (!match) throw new Error(`malformed File: header: ${value}`);
    const size = Number(match[1]);
    const name = (match[2] ?? '').trim();
    if (!Number.isInteger(size) || size < 0) throw new Error(`malformed File: size in ${value}`);
    if (size > MAX_B2_MESSAGE_BYTES) throw new Error(`declared file size ${size} is too large`);
    if (cursor + size > rest.length) {
      throw new Error(`declared file length ${size} exceeds the remaining ${rest.length - cursor} bytes`);
    }
    const data = Buffer.from(rest.subarray(cursor, cursor + size));
    cursor += size;
    if (rest.subarray(cursor, cursor + 2).toString('latin1') === CRLF) cursor += 2;
    attachments.push({ name, contentType: name.toLowerCase().endsWith('.html') ? 'text/html' : 'application/octet-stream', data });
  }

  const typeRaw = headerValue(headers, 'type');
  const type = (B2_MESSAGE_TYPES.find((candidate) => candidate.toLowerCase() === typeRaw.toLowerCase()) ??
    'Private') as B2MessageType;

  return {
    mid: headerValue(headers, 'mid').toUpperCase(),
    dateUtc: parseB2Date(headerValue(headers, 'date')) ?? Date.now(),
    // Winlink addresses stay bare in the structure (address.ts).
    from: toWinlinkAddress(headerValue(headers, 'from')),
    to: headerList(headers, 'to').map(toWinlinkAddress),
    cc: headerList(headers, 'cc').map(toWinlinkAddress),
    subject: headerValue(headers, 'subject'),
    type,
    mbo: headerValue(headers, 'mbo'),
    body,
    charset,
    attachments,
    headers: extras.filter(([name]) => !MODELLED.has(name.toLowerCase())),
  };
}

function foldLongLine(name: string, value: string): string[] {
  const limit = 998;
  if (value.length + name.length + 2 <= limit) return [`${name}: ${value}`];
  const out: string[] = [];
  let rest = value;
  out.push(`${name}: ${rest.slice(0, limit - name.length - 2)}`);
  rest = rest.slice(limit - name.length - 2);
  while (rest.length > 0) {
    out.push(` ${rest.slice(0, limit - 1)}`);
    rest = rest.slice(limit - 1);
  }
  return out;
}

/**
 * Serialises the structure. The body is emitted as the bytes it declares and
 * each attachment follows in `File:` order; lengths are measured, not guessed,
 * so `Body:` and `File:` always describe what actually went out.
 */
export function serialiseB2Message(message: B2Message): Uint8Array {
  if (!message.mid) throw new Error('message has no MID');
  if (message.to.length === 0) throw new Error('message has no recipient');
  if (!message.from) throw new Error('message has no sender');
  if (!message.subject.trim()) throw new Error('message has no subject');
  if (message.subject.length > 128) throw new Error('subject is longer than 128 characters');
  if (message.mid.length > 12) throw new Error('MID is longer than 12 characters');

  const normalised = message.body.replace(/\r?\n/g, CRLF);
  const requested = (message.charset || 'ISO-8859-1').toUpperCase();
  const asciiOnly = ![...normalised].some((character) => (character.codePointAt(0) ?? 0) > 0xff);
  // A body that cannot be written in the legacy charset is sent as UTF-8 and
  // declared so; losing characters to a truncation is worse than a charset change.
  const charset = requested === 'UTF-8' || requested === 'UTF8' || !asciiOnly ? 'UTF-8' : requested;
  const bodyBytes =
    charset === 'UTF-8' ? Buffer.from(utf8Encode.encode(normalised)) : Buffer.from(normalised, 'latin1');

  const headers: Array<[string, string]> = [];
  headers.push(['Mid', message.mid]);
  headers.push(['Date', formatB2Date(message.dateUtc)]);
  headers.push(['Type', message.type]);
  headers.push(['From', toWinlinkAddress(message.from)]);
  for (const address of message.to) headers.push(['To', toWinlinkAddress(address)]);
  for (const address of message.cc) headers.push(['Cc', toWinlinkAddress(address)]);
  headers.push(['Subject', message.subject]);
  if (message.mbo) headers.push(['Mbo', message.mbo]);
  headers.push(['Content-Type', `text/plain; charset=${charset}`]);
  headers.push(['Content-Transfer-Encoding', '8bit']);
  headers.push(['Body', String(bodyBytes.length)]);
  for (const attachment of message.attachments) {
    const name = attachment.name.trim() || 'attachment.bin';
    if (name.length > 255) throw new Error(`attachment name is longer than 255 characters: ${name}`);
    headers.push(['File', `${attachment.data.length} ${name}`]);
  }
  for (const [name, value] of message.headers) {
    if (MODELLED.has(name.toLowerCase())) continue;
    headers.push([name, value]);
  }

  // `Mid` first, then the rest sorted, so a re-send is byte-identical.
  const ordered = [headers[0]!, ...headers.slice(1).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))];

  const lines: string[] = [];
  for (const [name, value] of ordered) lines.push(...foldLongLine(name, value));
  lines.push('');

  const head = Buffer.from(`${lines.join(CRLF)}${CRLF}`, 'latin1');
  const parts: Buffer[] = [head, bodyBytes, Buffer.from(CRLF, 'latin1')];
  for (const attachment of message.attachments) {
    parts.push(Buffer.from(attachment.data), Buffer.from(CRLF, 'latin1'));
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** The message model in its B2 form, ready to be compressed and proposed. */
export function messageToB2(message: MailMessage, options: { type?: B2MessageType; mbo?: string } = {}): B2Message {
  return {
    mid: message.mid,
    dateUtc: message.dateUtc,
    from: toWinlinkAddress(message.from),
    to: message.to.map(toWinlinkAddress),
    cc: message.cc.map(toWinlinkAddress),
    subject: message.subject,
    type: options.type ?? 'Private',
    mbo: options.mbo ?? '',
    body: message.body,
    charset: message.charset || 'ISO-8859-1',
    attachments: message.attachments,
    headers: message.headers,
  };
}

/** Back to the message model after a download. */
export function b2ToMessage(message: B2Message): MailMessage {
  const body = Buffer.from(
    message.charset.toUpperCase() === 'ISO-8859-1'
      ? Buffer.from(message.body, 'latin1')
      : Buffer.from(message.body, 'utf8'),
  ).toString('utf8');
  return {
    mid: message.mid,
    messageId: '',
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    dateUtc: message.dateUtc,
    body,
    charset: message.charset,
    headers: message.headers,
    attachments: message.attachments,
  };
}

/** Validation the CMS applies anyway, applied before the airtime is spent. */
export function validateB2Message(message: B2Message): { ok: boolean; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  if (!message.mid || message.mid.length > 12) fields.mid = 'MID missing or longer than 12 characters';
  if (!message.from.trim()) fields.from = 'sender is required';
  if (message.to.length === 0) fields.to = 'at least one recipient is required';
  if (!message.subject.trim()) fields.subject = 'subject is required';
  else if (message.subject.length > 128) fields.subject = 'subject is longer than 128 characters';
  else if (utf8Encode.encode(message.subject).length > 255) fields.subject = 'subject is too long in bytes';
  for (const attachment of message.attachments) {
    if (!attachment.name.trim()) fields.attachments = 'an attachment has no name';
    else if (attachment.name.length > 255) fields.attachments = `attachment name too long: ${attachment.name}`;
  }
  return { ok: Object.keys(fields).length === 0, fields };
}
