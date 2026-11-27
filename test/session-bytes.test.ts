import assert from 'node:assert/strict';
import test from 'node:test';
import type { Duplex } from '@rfmail/core-b2f';
import { watchBytes } from '@rfmail/server';

/** A stream that hands out prepared chunks and keeps what is written, in memory. */
function memoryStream(chunks: Uint8Array[]): Duplex & { written: Uint8Array[] } {
  const queue = [...chunks];
  const written: Uint8Array[] = [];
  return {
    written,
    write(chunk: Uint8Array): void {
      written.push(chunk);
    },
    async flush(): Promise<void> {},
    async close(): Promise<void> {},
    async read(): Promise<Uint8Array> {
      const next = queue.shift();
      if (!next) throw new Error('nothing left to read');
      return next;
    },
  };
}

const encoder = new TextEncoder();

/**
 * The exchange speaks in lines, but a message travels as a binary block. Without a report for
 * that block a session carrying an LZHUF message would look silent on the screen (decision 52).
 */
test('a binary block is reported with its head in hex and its length', async () => {
  const reports: Array<{ dir: string; hex: string; count: number }> = [];
  // An LZHUF block: the B2 header is text, the body is not.
  const block = new Uint8Array([0x3c, 0x2a, 0x4c, 0x5a, 0x00, 0xff, 0x80, 0x01, 0x7c, 0x2a, 0x3e, 0x0d, 0x00, 0x9a]);
  const stream = watchBytes(memoryStream([block]), (dir, info) => reports.push({ dir, ...info }));

  const chunk = await stream.read();
  assert.equal(chunk.length, block.length, 'the bytes are passed through untouched');
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.dir, '<', 'it was received');
  assert.equal(reports[0]?.hex, '3C 2A 4C 5A 00 FF 80 01 7C 2A 3E 0D', 'the first twelve bytes');
  assert.equal(reports[0]?.count, block.length, 'and how many arrived at once');
});

/** A protocol line is text, and is left to the line report rather than repeated as bytes. */
test('a line of text is not reported as binary', async () => {
  const reports: unknown[] = [];
  const line = encoder.encode('FC EM 3X4ABC 1234 567 89\r');
  const stream = watchBytes(memoryStream([line]), (dir, info) => reports.push({ dir, ...info }));

  await stream.read();
  assert.equal(reports.length, 0, 'plain text is not a binary block');
});

/** What the station sends can be binary too, and it is reported the same way. */
test('a binary block sent to the peer is reported as sent', () => {
  const reports: Array<{ dir: string; hex: string; count: number }> = [];
  const stream = watchBytes(memoryStream([]), (dir, info) => reports.push({ dir, ...info }));

  stream.write(new Uint8Array([0x00, 0x11, 0x22, 0x33]));
  assert.deepEqual(reports, [{ dir: '>', hex: '00 11 22 33', count: 4 }]);
});
