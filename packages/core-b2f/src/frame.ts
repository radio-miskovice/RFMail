// The transfer framing of one B2 message: SOH header, STX data blocks, EOT
// checksum.
//
//   \x01 <headerlen> <title> \0 <offset> \0
//   \x02 <len> <payload>          (repeated)
//   \x04 <checksum>
//
// `headerlen` counts the title, the offset in decimal and the two NULs.
// `len` is the payload length, with 0 meaning 256; this station sends 125,
// which fits an AX.25 paclen of 128 (R4.2.4). The checksum is the negated sum of
// every payload byte, masked to one byte.
//
// A `*` where SOH was expected means the peer sent an error line instead of a
// message; the line is surfaced, and only that message fails.

const SOH = 0x01;
const STX = 0x02;
const EOT = 0x04;
const NUL = 0x00;
const MAX_DECLARED = 256;

/** Payload bytes per STX block. The protocol allows 255; 125 keeps AX.25 happy. */
export const TRANSFER_BLOCK_BYTES = 125;
/** A title longer than this is not representable in the header. */
export const MAX_TITLE_BYTES = 80;
/** Highest offset the six-digit field can express. */
export const MAX_TRANSFER_OFFSET = 999_999;

export interface TransferHeader {
  title: string;
  offset: number;
}

function asciiTitle(title: string): string {
  if (title.trim() === '') return 'No title';
  // The header field is ASCII only; a caller passes the Q-encoded subject.
  const bytes = Buffer.from(title, 'latin1');
  const capped = bytes.length > MAX_TITLE_BYTES ? bytes.subarray(0, MAX_TITLE_BYTES).toString('latin1') : title;
  return capped.trim() === '' ? 'No title' : capped;
}

/**
 * Frames one compressed message for transmission. `payload` is the compressed
 * message bytes; `offset` restarts a transfer the peer asked to resume.
 */
export function encodeTransfer(header: TransferHeader, payload: Uint8Array): Buffer {
  const title = asciiTitle(header.title);
  const offsetText = String(Math.max(0, Math.min(header.offset, MAX_TRANSFER_OFFSET)));
  const titleBytes = Buffer.from(title, 'latin1');
  const offsetBytes = Buffer.from(offsetText, 'latin1');
  const headerLength = titleBytes.length + offsetBytes.length + 2;
  if (headerLength > 255) throw new Error('transfer header does not fit in one byte');

  const chunks: Buffer[] = [
    Buffer.from([SOH, headerLength]),
    titleBytes,
    Buffer.from([NUL]),
    offsetBytes,
    Buffer.from([NUL]),
  ];

  let checksum = 0;
  const data = payload.subarray(Math.min(header.offset, payload.length));
  for (let position = 0; position < data.length; position += TRANSFER_BLOCK_BYTES) {
    const block = data.subarray(position, position + TRANSFER_BLOCK_BYTES);
    chunks.push(Buffer.from([STX, block.length & 0xff]));
    chunks.push(Buffer.from(block));
    for (const byte of block) checksum = (checksum + byte) & 0xff;
  }

  chunks.push(Buffer.from([EOT, (-checksum) & 0xff]));
  return Buffer.concat(chunks);
}

export type TransferEvent =
  | { type: 'header'; header: TransferHeader }
  | { type: 'block'; data: Uint8Array }
  | { type: 'end'; payload: Uint8Array; checksumOk: boolean }
  | { type: 'remote-error'; line: string };

/**
 * Streaming decoder for the framing above. `push` takes whatever arrived and
 * returns the events it could complete; a decoder lives for one message and is
 * discarded on error, because the protocol cannot resynchronise inside a block.
 */
export class TransferDecoder {
  private buffer = Buffer.alloc(0);
  private header: TransferHeader | null = null;
  private expected = 0;
  private chunks: Buffer[] = [];
  private checksum = 0;
  private finished = false;

  push(chunk: Uint8Array): TransferEvent[] {
    if (this.finished) return [];
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    return this.drain();
  }

  private drain(): TransferEvent[] {
    const events: TransferEvent[] = [];
    for (;;) {
      if (this.header === null) {
        if (this.buffer.length < 2) break;
        const marker = this.buffer[0];
        if (marker === 0x2a /* '*' */) {
          const end = this.buffer.indexOf(0x0d);
          if (end === -1) break;
          events.push({ type: 'remote-error', line: this.buffer.subarray(0, end).toString('latin1') });
          this.buffer = this.buffer.subarray(end + 1);
          this.finished = true;
          break;
        }
        if (marker !== SOH) {
          throw new Error(`expected SOH, got 0x${(marker ?? 0).toString(16)}`);
        }
        const length = this.buffer[1] ?? 0;
        if (this.buffer.length < 2 + length) break;
        const field = this.buffer.subarray(2, 2 + length).toString('latin1');
        const nul = field.indexOf('\0');
        if (nul === -1) throw new Error('transfer header has no title separator');
        const title = field.slice(0, nul);
        const offsetText = field.slice(nul + 1).replace(/\0+$/, '');
        const offset = Number(offsetText || '0');
        if (!Number.isInteger(offset) || offset < 0) throw new Error(`malformed offset '${offsetText}'`);
        this.header = { title, offset };
        this.buffer = this.buffer.subarray(2 + length);
        events.push({ type: 'header', header: this.header });
        continue;
      }

      if (this.buffer.length < 2) break;
      const marker = this.buffer[0];
      if (marker === STX) {
        const declared = this.buffer[1] ?? 0;
        const length = declared === 0 ? MAX_DECLARED : declared;
        if (this.buffer.length < 2 + length) break;
        const data = this.buffer.subarray(2, 2 + length);
        for (const byte of data) this.checksum = (this.checksum + byte) & 0xff;
        this.expected += length;
        this.chunks.push(Buffer.from(data));
        this.buffer = this.buffer.subarray(2 + length);
        events.push({ type: 'block', data: new Uint8Array(data) });
        continue;
      }
      if (marker === EOT) {
        if (this.buffer.length < 2) break;
        const received = this.buffer[1] ?? 0;
        const payload = new Uint8Array(Buffer.concat(this.chunks));
        events.push({ type: 'end', payload, checksumOk: ((this.checksum + received) & 0xff) === 0 });
        this.buffer = this.buffer.subarray(2);
        this.finished = true;
        break;
      }
      throw new Error(`expected STX or EOT, got 0x${(marker ?? 0).toString(16)}`);
    }
    return events;
  }
}
