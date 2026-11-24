// MIME structure, for the IMAP `BODY[<section>]` fetches a mail client makes.
//
// A client asks for `BODY[1]` (the text of a multipart message), `BODY[2]`
// (an attachment), `BODY[1.MIME]` (that part's own headers) or `BODY[HEADER]`
// and expects *that slice* of the message as it was stored, transfer encoding
// and all. This module splits a serialised message into its parts so the IMAP
// server can answer with the right bytes instead of the whole message.
//
// Section numbers follow RFC 3501: a multipart's children are numbered from 1
// in order, a nested multipart continues with `1.1`, and the parts of an
// encapsulated message/rfc822 are numbered under their parent.

export interface MimePart {
  /** IMAP section number: '' for the whole message, then '1', '1.2', … */
  section: string;
  /** Raw header block, including the blank line that ends it. */
  headers: Buffer;
  /** Raw body, still transfer-encoded. */
  body: Buffer;
  contentType: string;
  children: MimePart[];
}

const CRLF = '\r\n';
const HEADER_END = '\r\n\r\n';

function headerText(block: Buffer): string {
  return block.toString('latin1');
}

function headerValue(headers: Buffer, name: string): string {
  const lines = headerText(headers).split(CRLF);
  const wanted = name.toLowerCase();
  const collected: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (line === '') break;
    if (/^[ \t]/.test(line)) {
      if (collecting) collected.push(line.trim());
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      collecting = false;
      continue;
    }
    const field = line.slice(0, colon).trim().toLowerCase();
    collecting = field === wanted;
    if (collecting) collected.push(line.slice(colon + 1).trim());
  }
  return collected.join(' ');
}

function parameter(value: string, name: string): string | null {
  const pattern = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i');
  const match = pattern.exec(value);
  if (!match) return null;
  return (match[2] ?? match[1] ?? '').trim() || null;
}

function splitHeaders(raw: Buffer): { headers: Buffer; body: Buffer } {
  const index = raw.indexOf(HEADER_END);
  if (index === -1) return { headers: raw, body: Buffer.alloc(0) };
  return { headers: raw.subarray(0, index + HEADER_END.length), body: raw.subarray(index + HEADER_END.length) };
}

/** Splits a multipart body on its boundary, dropping the preamble and the epilogue. */
function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString('latin1');
  const marker = `--${boundary}`;
  const segments: Buffer[] = [];
  let position = text.indexOf(marker);
  if (position === -1) return segments;
  let offset = 0;
  while (position !== -1) {
    const afterMarker = position + marker.length;
    const closing = text.startsWith('--', afterMarker);
    const lineEnd = text.indexOf(CRLF, afterMarker);
    // A part starts after the boundary line; the previous segment ends here.
    if (offset > 0) {
      const end = position - CRLF.length >= offset ? position - CRLF.length : position;
      segments.push(Buffer.from(text.slice(offset, end), 'latin1'));
    }
    if (closing || lineEnd === -1) break;
    offset = lineEnd + CRLF.length;
    position = text.indexOf(marker, offset);
  }
  return segments;
}

function parsePart(raw: Buffer, section: string): MimePart {
  const { headers, body } = splitHeaders(raw);
  const type = (headerValue(headers, 'content-type') || 'text/plain').trim();
  const contentType = type.split(';')[0]?.trim().toLowerCase() ?? 'text/plain';
  const part: MimePart = { section, headers, body, contentType, children: [] };

  if (contentType.startsWith('multipart/')) {
    const boundary = parameter(type, 'boundary');
    if (boundary) {
      splitMultipart(body, boundary).forEach((segment, index) => {
        part.children.push(parsePart(segment, section === '' ? String(index + 1) : `${section}.${index + 1}`));
      });
    }
  } else if (contentType === 'message/rfc822') {
    // The encapsulated message is part <section>.1 in IMAP numbering.
    part.children.push(parsePart(body, section === '' ? '1' : `${section}.1`));
  }
  return part;
}

export function parseMimeTree(raw: Buffer): MimePart {
  return parsePart(raw, '');
}

/** Finds a part by IMAP section number: '', '1', '2.1', … */
export function findMimePart(root: MimePart, section: string): MimePart | null {
  if (section === '') return root;
  let node: MimePart = root;
  for (const piece of section.split('.')) {
    const next = node.children.find((child) => child.section.split('.').pop() === piece);
    if (!next) return null;
    node = next;
  }
  return node;
}
