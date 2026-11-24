// RFC 822 / MIME parsing and serialisation.
//
// The stored model is charset-normalised UTF-8 with attachments kept as bytes.
// This module is the only place that knows about transfer encodings, charsets,
// encoded words and multipart boundaries, so a message can round-trip through
// POP3, SMTP and (later) the B2F message structure without the rest of the
// system seeing transport details.

import {
  MODELLED_HEADERS,
  isAscii,
  type MailAttachment,
  type MailMessage,
} from './message.ts';
import {
  canonicaliseAddressList,
  expandMessageAddresses,
  toWinlinkHeader,
} from './address.ts';

const CRLF = '\r\n';

type Header = [string, string];

export function headerValue(headers: Header[], name: string): string {
  const lower = name.toLowerCase();
  for (const [key, value] of headers) {
    if (key.toLowerCase() === lower) return value;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Charsets and encodings

export function decodeCharset(bytes: Uint8Array, charset: string): string {
  const label = (charset || 'utf-8').trim().toLowerCase();
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    // Unknown label: fall back to Latin-1, which never throws.
    return new TextDecoder('iso-8859-1').decode(bytes);
  }
}

function decodeQuotedPrintable(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? '';
    if (ch === '=') {
      const next = input[i + 1];
      const after = input[i + 2];
      if (next === '\r' && after === '\n') {
        i += 2; // soft line break
        continue;
      }
      if (next === '\n') {
        i += 1;
        continue;
      }
      if (next !== undefined && after !== undefined) {
        const hex = Number.parseInt(next + after, 16);
        if (!Number.isNaN(hex) && /^[0-9a-fA-F]{2}$/.test(next + after)) {
          out.push(hex);
          i += 2;
          continue;
        }
      }
    }
    out.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

function decodeTransfer(bytes: Uint8Array, encoding: string): Uint8Array {
  const cte = encoding.trim().toLowerCase();
  if (cte === 'base64') {
    const text = Buffer.from(bytes).toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    if (text.length === 0) return new Uint8Array();
    try {
      return new Uint8Array(Buffer.from(text, 'base64'));
    } catch {
      return bytes;
    }
  }
  if (cte === 'quoted-printable') {
    return decodeQuotedPrintable(Buffer.from(bytes).toString('latin1'));
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// RFC 2047 encoded words

export function decodeWords(input: string): string {
  const re = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  let out = '';
  let last = 0;
  for (;;) {
    const match = re.exec(input);
    if (!match) break;
    out += input.slice(last, match.index);
    const charset = match[1] ?? 'utf-8';
    const encoding = (match[2] ?? 'q').toLowerCase();
    const payload = match[3] ?? '';
    let bytes: Uint8Array;
    if (encoding === 'b') {
      bytes = new Uint8Array(Buffer.from(payload, 'base64'));
    } else {
      bytes = decodeQuotedPrintable(payload.replace(/_/g, ' '));
    }
    out += decodeCharset(bytes, charset);
    last = match.index + match[0].length;
  }
  out += input.slice(last);
  return out;
}

/** True when the string is plausible UTF-8 that was read as Latin-1. */
function looksLikeMojibakeUtf8(input: string): boolean {
  const bytes = Uint8Array.from(
    Array.from(input, (ch) => ch.charCodeAt(0) & 0xff),
  );
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decodes one header value: first RFC 2047 words, then the unencoded remainder
 * if it is UTF-8 that arrived byte-for-byte (common in modern senders, and how
 * Winlink's CMS forwards Q-decoded subjects).
 */
export function decodeHeaderValue(raw: string): string {
  const hadWords = raw.includes('=?');
  const decoded = hadWords ? decodeWords(raw) : raw;
  if (hadWords) return decoded;
  if (isAscii(decoded)) return decoded;
  if (looksLikeMojibakeUtf8(decoded)) {
    const bytes = Uint8Array.from(
      Array.from(decoded, (ch) => ch.charCodeAt(0) & 0xff),
    );
    return new TextDecoder('utf-8').decode(bytes);
  }
  return decoded;
}

export function encodeWords(input: string): string {
  if (isAscii(input)) return input;
  const words: string[] = [];
  let current = '';
  for (const ch of input) {
    if (current.length + ch.length > 45) {
      words.push(current);
      current = '';
    }
    current += ch;
  }
  if (current) words.push(current);
  return words
    .map((word) => {
      let encoded = '';
      for (const ch of word) {
        const code = ch.codePointAt(0) ?? 0;
        if (ch === ' ') {
          encoded += '_';
        } else if (code > 0x20 && code < 0x7f && !/["=?_]/.test(ch)) {
          encoded += ch;
        } else {
          const bytes = new TextEncoder().encode(ch);
          for (const byte of bytes) {
            encoded += `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
          }
        }
      }
      return `=?UTF-8?Q?${encoded}?=`;
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// Header block

export function parseHeaders(text: string): Header[] {
  const headers: Header[] = [];
  let currentName: string | null = null;
  let currentValue = '';

  const flush = (): void => {
    if (currentName !== null) {
      headers.push([currentName, currentValue.trim()]);
      currentName = null;
      currentValue = '';
    }
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue;
    if ((line.startsWith(' ') || line.startsWith('\t')) && currentName !== null) {
      currentValue += ` ${line.trim()}`;
      continue;
    }
    flush();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    currentName = line.slice(0, colon).trim();
    currentValue = line.slice(colon + 1);
  }
  flush();
  return headers;
}

function splitHeadBody(buffer: Buffer): { head: Buffer; body: Buffer } {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  if (crlf === -1 && lf === -1) return { head: buffer, body: Buffer.alloc(0) };
  if (lf === -1 || (crlf !== -1 && crlf < lf)) {
    return { head: buffer.subarray(0, crlf), body: buffer.subarray(crlf + 4) };
  }
  return { head: buffer.subarray(0, lf), body: buffer.subarray(lf + 2) };
}

interface ContentType {
  type: string;
  params: Record<string, string>;
}

export function parseContentType(value: string): ContentType {
  const params: Record<string, string> = {};
  if (!value) return { type: 'text/plain', params };
  let inQuote = false;
  let current = '';
  const pieces: string[] = [];
  for (const ch of value) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ';' && !inQuote) {
      pieces.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  pieces.push(current);
  const type = (pieces.shift() ?? 'text/plain').trim().toLowerCase();
  for (const piece of pieces) {
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    const key = piece.slice(0, eq).trim().toLowerCase();
    let val = piece.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (key) params[key] = val;
  }
  return { type, params };
}

// ---------------------------------------------------------------------------
// Parsing

interface ParsedParts {
  text?: string;
  html?: string;
  charset: string;
  attachments: MailAttachment[];
  attachmentCount: number;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitMultipart(
  body: Uint8Array,
  boundary: string,
): Array<Buffer> {
  const text = Buffer.from(body).toString('latin1');
  const delimiter = `--${boundary}`;
  const chunks: Buffer[] = [];
  let index = text.indexOf(delimiter);
  if (index === -1) return [];
  while (index !== -1) {
    const start = index + delimiter.length;
    const next = text.indexOf(delimiter, start);
    if (next === -1) break;
    let part = text.slice(start, next);
    // Strip the CRLF that belongs to the delimiter line, and the trailing one.
    part = part.replace(/^(\r?\n)/, '').replace(/(\r?\n)$/, '');
    if (part.startsWith('--')) break; // closing delimiter
    chunks.push(Buffer.from(part, 'latin1'));
    index = next;
  }
  return chunks;
}

function parsePart(
  headers: Header[],
  body: Buffer,
  depth: number,
  state: ParsedParts,
): void {
  const contentType = parseContentType(headerValue(headers, 'content-type'));
  const cte = headerValue(headers, 'content-transfer-encoding');
  const disposition = parseContentType(headerValue(headers, 'content-disposition'));
  const decoded = decodeTransfer(body, cte);

  if (contentType.type.startsWith('multipart/') && contentType.params['boundary'] && depth < 6) {
    for (const part of splitMultipart(decoded, contentType.params['boundary'])) {
      const split = splitHeadBody(part);
      const partHeaders = parseHeaders(split.head.toString('latin1'));
      parsePart(partHeaders, split.body, depth + 1, state);
    }
    return;
  }

  const filenameRaw =
    disposition.params['filename'] ??
    contentType.params['name'] ??
    '';
  const filename = filenameRaw ? decodeWords(filenameRaw) : '';
  const isTextType =
    contentType.type === 'text/plain' || contentType.type === 'text/html';
  const isAttachment =
    disposition.type === 'attachment' || filename !== '' || !isTextType;

  if (!isAttachment && isTextType) {
    const charset = contentType.params['charset'] ?? 'iso-8859-1';
    const text = decodeCharset(decoded, charset);
    if (contentType.type === 'text/html') {
      if (state.html === undefined) state.html = text;
    } else if (state.text === undefined) {
      state.text = text;
      state.charset = charset;
    }
    return;
  }

  state.attachmentCount += 1;
  state.attachments.push({
    name: filename || `attachment-${state.attachmentCount}`,
    contentType: contentType.type || 'application/octet-stream',
    data: decoded,
  });
}

export interface ParseOptions {
  /** MID for the parsed message; generated by the caller when omitted. */
  mid: string;
}

export function parseRfc822(input: Uint8Array, options: ParseOptions): MailMessage {
  const buffer = Buffer.from(input);
  const { head, body } = splitHeadBody(buffer);
  const headers = parseHeaders(head.toString('latin1'));
  const state: ParsedParts = { charset: 'iso-8859-1', attachments: [], attachmentCount: 0 };
  parsePart(headers, body, 0, state);

  let text = (state.text ?? '').replace(/\r\n/g, '\n');
  if (state.html !== undefined) {
    if (state.text === undefined) {
      text = htmlToText(state.html);
      state.charset = 'utf-8';
    }
    state.attachments.push({
      name: 'message.html',
      contentType: 'text/html',
      data: new TextEncoder().encode(state.html),
    });
  }

  const dateRaw = headerValue(headers, 'date');
  let dateUtc = Date.parse(dateRaw);
  if (Number.isNaN(dateUtc)) dateUtc = Date.now();

  const messageIdRaw = headerValue(headers, 'message-id').replace(/[<>]/g, '').trim();

  const extras: Header[] = headers.filter(
    ([name]) => !MODELLED_HEADERS.has(name.toLowerCase()),
  );

  return {
    mid: options.mid,
    messageId: messageIdRaw,
    // Winlink addresses are stored bare; see address.ts.
    from: toWinlinkHeader(decodeHeaderValue(headerValue(headers, 'from'))),
    to: canonicaliseAddressList(splitAddresses(headerValue(headers, 'to'))),
    cc: canonicaliseAddressList(splitAddresses(headerValue(headers, 'cc'))),
    subject: decodeHeaderValue(headerValue(headers, 'subject')),
    dateUtc,
    body: text,
    charset: state.charset,
    headers: extras,
    attachments: state.attachments,
  };
}

function splitAddresses(value: string): string[] {
  if (!value.trim()) return [];
  // Local import to avoid a circular re-export in message.ts.
  const out: string[] = [];
  let current = '';
  let inQuote = false;
  let inAngle = false;
  for (const ch of value) {
    if (inQuote) {
      current += ch;
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    if (ch === '<') inAngle = true;
    if (ch === '>') inAngle = false;
    if (ch === ',' && !inAngle) {
      if (current.trim()) out.push(decodeHeaderValue(current.trim()));
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(decodeHeaderValue(current.trim()));
  return out;
}

// ---------------------------------------------------------------------------
// Serialisation

/** Storage keeps LF line endings; the wire wants CRLF. */
function normaliseCrlf(text: string): string {
  return text.replace(/\r?\n/g, CRLF);
}

/**
 * Quoted-printable for text parts, so a downloaded message stays readable and
 * a body line beginning with a dot reaches POP3's dot-stuffing path intact.
 */
function encodeQuotedPrintable(text: string): string {
  const normalised = normaliseCrlf(text);
  const bytes = new TextEncoder().encode(normalised);
  const lines: string[] = [];
  let line = '';

  const flush = (): void => {
    lines.push(line);
    line = '';
  };

  const emit = (chunk: string): void => {
    if (line.length + chunk.length > 75) {
      lines.push(`${line}=`);
      line = '';
    }
    line += chunk;
  };

  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte === 0x0d && bytes[i + 1] === 0x0a) {
      flush();
      i += 1;
      continue;
    }
    if (byte === 0x0d || byte === 0x0a) {
      flush();
      continue;
    }
    const next = bytes[i + 1];
    const atLineEnd = next === undefined || next === 0x0d || next === 0x0a;
    if (byte === 0x20 || byte === 0x09) {
      emit(atLineEnd ? `=${byte.toString(16).toUpperCase()}` : String.fromCodePoint(byte));
      continue;
    }
    if (byte > 0x7e || byte < 0x20 || byte === 0x3d) {
      emit(`=${byte.toString(16).toUpperCase().padStart(2, '0')}`);
      continue;
    }
    emit(String.fromCodePoint(byte));
  }
  if (line !== '') flush();
  return lines.join(CRLF);
}

function wrapBase64(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78) return line;
  const words = value.split(' ');
  const lines: string[] = [];
  let current = `${name}:`;
  for (const word of words) {
    if (current.length + 1 + word.length > 78 && current.length > name.length + 2) {
      lines.push(current);
      current = ` ${word}`;
    } else {
      current += ` ${word}`;
    }
  }
  lines.push(current);
  return lines.join(CRLF);
}

/**
 * Renders the message for a mail client, which is the only consumer today:
 * Winlink addresses come out as `CALLSIGN@winlink.org`. Pass
 * `{ winlink: false }` for the radio side, which wants the bare callsigns the
 * store keeps.
 */
export function serialiseRfc822(
  msg: MailMessage,
  options: { winlink?: boolean } = {},
): Uint8Array {
  const wire = options.winlink === false ? msg : expandMessageAddresses(msg);
  const lines: string[] = [];
  const push = (name: string, value: string): void => {
    if (value === '') return;
    lines.push(foldHeader(name, value));
  };

  push('From', wire.from);
  push('To', wire.to.join(', '));
  push('Cc', wire.cc.join(', '));
  push('Subject', encodeWords(msg.subject));
  push('Date', new Date(msg.dateUtc).toUTCString());
  push('Message-ID', `<${msg.messageId || `${msg.mid.toLowerCase()}@rfmail`}>`);
  push('MIME-Version', '1.0');

  for (const [name, value] of msg.headers) {
    if (MODELLED_HEADERS.has(name.toLowerCase())) continue;
    push(name, value);
  }

  if (msg.attachments.length === 0) {
    push('Content-Type', 'text/plain; charset=utf-8');
    push('Content-Transfer-Encoding', 'quoted-printable');
  } else {
    const boundary = `rfmail-${msg.mid.toLowerCase()}-${msg.attachments.length}`;
    push('Content-Type', `multipart/mixed; boundary="${boundary}"`);
    const parts: string[] = [];
    parts.push(
      [
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        encodeQuotedPrintable(msg.body),
      ].join(CRLF),
    );
    for (const att of msg.attachments) {
      const nameParam = isAscii(att.name)
        ? `filename="${att.name.replace(/"/g, '')}"`
        : `filename="${encodeWords(att.name)}"`;
      parts.push(
        [
          `Content-Type: ${att.contentType || 'application/octet-stream'}`,
          `Content-Disposition: attachment; ${nameParam}`,
          'Content-Transfer-Encoding: base64',
          '',
          wrapBase64(att.data),
        ].join(CRLF),
      );
    }
    const body =
      `This is a multi-part message in MIME format.${CRLF}` +
      parts.map((part) => `${CRLF}--${boundary}${CRLF}${part}${CRLF}`).join('') +
      `--${boundary}--${CRLF}`;
    lines.push('', body.replace(/\r\n$/, ''));
    return new TextEncoder().encode(`${lines.join(CRLF)}${CRLF}`);
  }

  lines.push('', encodeQuotedPrintable(msg.body));
  return new TextEncoder().encode(`${lines.join(CRLF)}${CRLF}`);
}
