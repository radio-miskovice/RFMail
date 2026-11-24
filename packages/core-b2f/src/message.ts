// Message model and address helpers.
//
// The same model is the target of the RFC 822 parser/serialiser (internet mail,
// POP3, SMTP) and, from milestone M4, of the Winlink B2F message structure.

export interface MailAttachment {
  name: string;
  contentType: string;
  data: Uint8Array;
}

export interface MailMessage {
  /** Protocol MID: at most 12 characters, base32 alphabet. Always set. */
  mid: string;
  /** RFC 822 Message-ID without angle brackets; empty when the source had none. */
  messageId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** Epoch milliseconds, UTC. */
  dateUtc: number;
  /** Body text as UTF-8. Received content is converted at the storage boundary. */
  body: string;
  /** Charset the body was received in; the body itself is always UTF-8 here. */
  charset: string;
  /** Headers not represented by the fields above, in their original order. */
  headers: Array<[string, string]>;
  attachments: MailAttachment[];
}

/** Headers owned by the model; they are regenerated on serialisation. */
export const MODELLED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'subject',
  'date',
  'message-id',
  'mid',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'content-disposition',
]);

/**
 * Splits an address list on commas that are not inside quotes, comments or
 * angle brackets: `"Doe, Jane" <j@x>, bob@y` yields two entries.
 */
export function splitAddressList(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuote = false;
  let inAngle = false;
  let depth = 0;

  for (const ch of input) {
    if (inQuote) {
      current += ch;
      if (ch === '"') inQuote = false;
      continue;
    }
    switch (ch) {
      case '"':
        inQuote = true;
        current += ch;
        break;
      case '<':
        inAngle = true;
        current += ch;
        break;
      case '>':
        inAngle = false;
        current += ch;
        break;
      case '(':
        depth += 1;
        current += ch;
        break;
      case ')':
        depth = Math.max(0, depth - 1);
        current += ch;
        break;
      case ',':
        if (inAngle || depth > 0) {
          current += ch;
        } else {
          if (current.trim()) out.push(current.trim());
          current = '';
        }
        break;
      default:
        current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** `Doe, Jane <j@x>` -> `j@x`; `bob@y` -> `bob@y`. */
export function addressOnly(input: string): string {
  const angle = /<([^>]*)>/.exec(input);
  if (angle && angle[1]) return angle[1].trim();
  const plain = input.replace(/\([^)]*\)/g, '').trim();
  return plain;
}

export function isAscii(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    if (input.charCodeAt(i) > 0x7e) return false;
  }
  return true;
}

export interface ComposeInput {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  attachments?: Array<{ name: string; contentType: string; data: Uint8Array }>;
  mid: string;
  dateUtc?: number;
}

/** Builds a message ready for storage or serialisation. */
export function composeMessage(input: ComposeInput): MailMessage {
  return {
    mid: input.mid,
    messageId: `${input.mid.toLowerCase()}.rfmail`,
    from: input.from,
    to: splitAddressList(input.to),
    cc: splitAddressList(input.cc ?? ''),
    subject: input.subject,
    dateUtc: input.dateUtc ?? Date.now(),
    body: input.body,
    charset: 'UTF-8',
    headers: [],
    attachments: (input.attachments ?? []).map((a) => ({
      name: a.name,
      contentType: a.contentType || 'application/octet-stream',
      data: a.data,
    })),
  };
}

/** Validation rules shared by the composer, the store and (later) B2F. */
export interface ValidationResult {
  ok: boolean;
  fields: Record<string, string>;
}

export function validateMessage(msg: MailMessage): ValidationResult {
  const fields: Record<string, string> = {};
  if (!msg.mid || msg.mid.length > 12) fields.mid = 'Message identifier missing or too long';
  if (!msg.from.trim()) fields.from = 'Sender is required';
  if (msg.to.length === 0) fields.to = 'At least one recipient is required';
  if (!msg.subject.trim()) fields.subject = 'Subject is required';
  else if (msg.subject.length > 128) fields.subject = 'Subject is longer than 128 characters';
  for (const a of msg.attachments) {
    if (a.name.length > 255) fields.attachments = `Attachment name too long: ${a.name}`;
  }
  return { ok: Object.keys(fields).length === 0, fields };
}
