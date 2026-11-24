// LZHUF codec tests: byte-exact against the wl2k-go golden vectors in both
// directions, plus the round-trips and failure modes the session code relies
// on. A compressor that is merely "self-consistent" is worthless here — a peer
// running Airmail or wl2k-go has to decode our frames and we theirs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
	compressB2,
	compressLzhuf,
	crc16,
	decompressB2,
	decompressLzhuf,
} from '@rfmail/core-b2f';

const FIXTURE_DIR = new URL('./fixtures/lzhuf/', import.meta.url);

function fixture(name: string): Buffer {
	return readFileSync(new URL(name, FIXTURE_DIR));
}

/**
 * Compares byte by byte and stops at the first difference, like wl2k-go's
 * TestWriterTestdata: the index and both values say where the coder went
 * wrong, whereas `deepEqual` on two 861-byte buffers says nothing.
 *
 * Returns the number of bytes compared so a test can report its coverage.
 */
function assertSameBytes(actual: Uint8Array, expected: Uint8Array, what: string): number {
	const common = Math.min(actual.length, expected.length);
	for (let i = 0; i < common; i++) {
		const got = actual[i]!;
		const want = expected[i]!;
		if (got !== want) {
			assert.fail(
				`${what}: byte idx ${i} not matching: got 0x${got.toString(16).padStart(2, '0')}, ` +
					`want 0x${want.toString(16).padStart(2, '0')} ` +
					`(${actual.length} bytes vs ${expected.length} expected)`,
			);
		}
	}
	assert.equal(
		actual.length,
		expected.length,
		`${what}: length differs after ${common} matching bytes (got ${actual.length}, want ${expected.length})`,
	);
	return common;
}

/** Deterministic xorshift32, so a failure is reproducible from the seed alone. */
function randomBytes(length: number, seed: number): Uint8Array {
	let state = seed >>> 0;
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		out[i] = state & 0xff;
	}
	return out;
}

test('crc16 is the XMODEM CRC-CCITT variant Winlink uses', () => {
	// The classic check value, with the two trailing zero bytes the B2 writers
	// fold in — no reflection, initial value 0.
	assert.equal(crc16(Buffer.from('123456789', 'latin1')), 0x31c3);
	assert.equal(crc16(new Uint8Array(0)), 0x0000);
});

test('compressB2 is byte-exact against the gettysburg vector', (t) => {
	const plain = fixture('gettysburg.txt');
	const expected = fixture('gettysburg.txt.lzh');

	const actual = compressB2(plain);

	assert.equal(actual.length, expected.length, 'the B2 frame length must match');
	assert.equal(readSize(actual, 2), plain.length, 'the size header is the uncompressed length');
	const compared = assertSameBytes(actual, expected, 'gettysburg.txt');
	t.diagnostic(`compared ${compared} bytes of the B2 frame byte for byte`);
});

test('decompressB2 of the gettysburg vector returns the plaintext', (t) => {
	const plain = fixture('gettysburg.txt');
	const compressed = fixture('gettysburg.txt.lzh');

	const actual = decompressB2(compressed);

	assert.equal(actual.length, plain.length);
	const compared = assertSameBytes(actual, plain, 'gettysburg.txt (decode)');
	t.diagnostic(`compared ${compared} bytes of plaintext byte for byte`);
});

test('the B2 checksum covers the size header and the compressed bytes', () => {
	const compressed = fixture('gettysburg.txt.lzh');
	// The stream's own bytes from offset 2 are uint32le(size) || compressed, so
	// this also pins down that the checksum is not over the plaintext.
	assert.equal(crc16(compressed.subarray(2)), readSize(compressed, 0) & 0xffff);
});

test('raw LZHUF round-trips', async (t) => {
	const cases: Array<{ name: string; data: Uint8Array }> = [
		{ name: 'empty', data: new Uint8Array(0) },
		{ name: 'one byte', data: Uint8Array.of(0x2a) },
		{ name: '60 bytes (one look-ahead buffer)', data: randomBytes(60, 0x5eed) },
		{ name: '2048 bytes (one ring buffer)', data: randomBytes(2048, 0xc0ffee) },
		{ name: '100 KB of reproducible pseudo-random bytes', data: randomBytes(100 * 1024, 0x1234567) },
		{
			name: 'highly repetitive buffer',
			data: Uint8Array.from({ length: 4096 }, (_, i) => 'abcabcabd'.charCodeAt(i % 9)),
		},
	];

	for (const { name, data } of cases) {
		await t.test(name, () => {
			const compressed = compressLzhuf(data);
			assert.equal(readSize(compressed, 0), data.length, 'declared size');
			assertSameBytes(decompressLzhuf(compressed), data, name);
			// The B2 framing must round-trip the same bytes.
			assertSameBytes(decompressB2(compressB2(data)), data, `${name} (B2)`);
		});
	}
});

test('decompressB2 rejects a corrupted stream', () => {
	const plain = fixture('gettysburg.txt');
	const corrupted = Uint8Array.from(compressB2(plain));
	// A byte in the middle of the compressed payload, well past the header.
	const victim = 6 + Math.floor((corrupted.length - 6) / 2);
	corrupted[victim] = (corrupted[victim] ?? 0) ^ 0xff;

	assert.throws(() => decompressB2(corrupted), /lzhuf: /);
});

test('decompressB2 rejects a corrupted checksum', () => {
	const compressed = Uint8Array.from(fixture('gettysburg.txt.lzh'));
	compressed[0] = (compressed[0] ?? 0) ^ 0x01;

	assert.throws(() => decompressB2(compressed), /checksum mismatch/);
});

test('decompressB2 rejects a truncated stream', () => {
	const compressed = fixture('gettysburg.txt.lzh');

	assert.throws(() => decompressB2(compressed.subarray(0, compressed.length - 10)), /lzhuf: /);
	assert.throws(() => decompressB2(compressed.subarray(0, 4)), /truncated/);
	assert.throws(() => decompressLzhuf(compressed.subarray(0, 2)), /truncated/);
});

test('decompressB2 rejects a declared size larger than the data', () => {
	const compressed = Uint8Array.from(fixture('gettysburg.txt.lzh'));
	// Keep the stream, lie about its length: the decoder runs out of bits
	// before it has produced the declared number of bytes.
	compressed[2] = 0xff;
	compressed[3] = 0xff;

	assert.throws(() => decompressB2(compressed), /lzhuf: /);
});

function readSize(data: Uint8Array, offset: number): number {
	return (
		(data[offset]! |
			(data[offset + 1]! << 8) |
			(data[offset + 2]! << 16)) +
		data[offset + 3]! * 0x1000000
	);
}
