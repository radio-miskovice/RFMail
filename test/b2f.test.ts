import assert from 'node:assert/strict';
import test from 'node:test';
import {
	formatProposal,
	formatProposalBlock,
	parseProposal,
	parseSid,
	precedenceOf,
	proposalChecksum,
	readAnswer,
	secureLoginResponse,
	supportsB2,
	localSid,
	formatB2Date,
	parseB2Date,
	parseB2Message,
	serialiseB2Message,
	messageToB2,
	validateB2Message,
	encodeTransfer,
	TransferDecoder,
	TRANSFER_BLOCK_BYTES,
	type TransferEvent,
} from '@rfmail/core-b2f';
import { composeMessage } from '@rfmail/core-b2f';

const MESSAGE = {
	mid: 'ABCDEFGHJKLM',
	dateUtc: Date.UTC(2026, 10, 24, 18, 20),
	from: 'OK4RM',
	to: ['LA5NTA', 'OK4RM'],
	cc: ['DL1XYZ'],
	subject: 'Pozdrav z Prahy',
	type: 'Private' as const,
	mbo: '',
	body: 'Ahoj, tady Jarda.\nDruhá řádka.\n',
	charset: 'UTF-8',
	attachments: [{ name: 'note.txt', contentType: 'text/plain', data: Buffer.from('attachment body\n') }],
	headers: [] as Array<[string, string]>,
};

test('a B2 message round-trips through the wire form', () => {
	const raw = Buffer.from(serialiseB2Message(MESSAGE)).toString('latin1');

	// Mid first, then the remaining headers sorted.
	const headerLines = raw.slice(0, raw.indexOf('\r\n\r\n')).split('\r\n');
	assert.equal(headerLines[0], 'Mid: ABCDEFGHJKLM');
	const names = headerLines.slice(1).map((line) => line.split(':')[0]);
	assert.deepEqual(names, [...names].sort(), 'the remaining headers are sorted');

	assert.match(raw, /^Date: 2026\/11\/24 18:20$/m);
	const expectedBody = Buffer.byteLength(MESSAGE.body.replace(/\n/g, '\r\n'), 'utf8');
	assert.match(raw, new RegExp(`^Body: ${expectedBody}$`, 'm'), 'the body length is measured, not guessed');
	assert.match(raw, /^File: 16 note\.txt$/m);

	const parsed = parseB2Message(new Uint8Array(Buffer.from(raw, 'latin1')));
	assert.equal(parsed.mid, 'ABCDEFGHJKLM');
	assert.equal(parsed.from, 'OK4RM');
	assert.deepEqual(parsed.to, ['LA5NTA', 'OK4RM']);
	assert.deepEqual(parsed.cc, ['DL1XYZ']);
	assert.equal(parsed.subject, 'Pozdrav z Prahy');
	assert.equal(parsed.body, MESSAGE.body);
	assert.equal(parsed.attachments.length, 1);
	assert.equal(Buffer.from(parsed.attachments[0]!.data).toString('latin1'), 'attachment body\n');
	assert.equal(parsed.dateUtc, MESSAGE.dateUtc);
});

test('a declared length that the block does not hold is refused, not truncated', () => {
	const raw = Buffer.from(serialiseB2Message(MESSAGE));
	// Claim a body 1000 bytes longer than what follows.
	const text = Buffer.from(raw).toString('latin1').replace(/^Body: \d+$/m, 'Body: 1045');
	assert.throws(() => parseB2Message(new Uint8Array(Buffer.from(text, 'latin1'))), /exceeds the block/);

	// And a file length past the end.
	const fileText = Buffer.from(raw).toString('latin1').replace(/^File: \d+ /m, 'File: 999999 ');
	assert.throws(() => parseB2Message(new Uint8Array(Buffer.from(fileText, 'latin1'))), /exceeds the remaining/);
});

test('every Date spelling seen in the field parses', () => {
	const expected = Date.UTC(2026, 10, 24, 18, 20);
	for (const text of [
		'2026/11/24 18:20',
		'2026.11.24 18:20',
		'2026-11-24 18:20',
		'20261124182000',
		'Tue, 24 Nov 2026 18:20:00 +0000',
		'24 Nov 2026 18:20:00 GMT',
	]) {
		assert.equal(parseB2Date(text), expected, text);
	}
	assert.equal(parseB2Date('nonsense'), null);
	assert.equal(formatB2Date(expected), '2026/11/24 18:20');
});

test('a message the CMS would refuse is refused here instead', () => {
	const base = messageToB2(
		composeMessage({ from: 'OK4RM', to: 'LA5NTA', subject: 'Hi', body: 'x', mid: 'ABCDEFGHJKLM' }),
	);
	assert.equal(validateB2Message(base).ok, true);
	assert.equal(validateB2Message({ ...base, to: [] }).fields.to, 'at least one recipient is required');
	assert.equal(
		validateB2Message({ ...base, subject: 'x'.repeat(129) }).fields.subject,
		'subject is longer than 128 characters',
	);
	assert.equal(validateB2Message({ ...base, mid: 'TOOLONGMID123' }).fields.mid, 'MID missing or longer than 12 characters');
});

test('proposals format, parse and checksum', () => {
	const proposal = { code: 'C' as const, messageType: 'EM' as const, mid: 'ABCDEFGHJKLM', size: 527, compressedSize: 123 };
	const line = formatProposal(proposal);
	assert.equal(line, 'FC EM ABCDEFGHJKLM 527 123 0');
	assert.deepEqual(parseProposal(line), proposal);
	assert.deepEqual(parseProposal('FD EM ABCDEFGHJKLM 527 123 0').code, 'D');
	assert.throws(() => parseProposal('FC XX ABCDEFGHJKLM 527 123 0'), /expected message type/);
	assert.throws(() => parseProposal('FZ EM ABCDEFGHJKLM 527 123 0'), /unsupported proposal code/);

	// The checksum is the negated sum of the line bytes including the CR.
	const expected = (-[...line].reduce((sum, ch) => sum + ch.charCodeAt(0), 0x0d)) & 0xff;
	assert.equal(proposalChecksum([line]), expected.toString(16).toUpperCase().padStart(2, '0'));

	const block = formatProposalBlock([proposal]);
	assert.equal(block.length, 2);
	assert.match(block[1]!, /^F> [0-9A-F]{2}$/);
	assert.deepEqual(formatProposalBlock([]), ['FF']);
	assert.throws(
		() => formatProposalBlock(Array.from({ length: 6 }, () => proposal)),
		/at most 5/,
	);
});

test('answers decode into accept, reject and defer, with the offset rule', () => {
	assert.deepEqual(readAnswer('+', 0), { decision: 'accept', offset: 0 });
	assert.deepEqual(readAnswer('Y', 0), { decision: 'accept', offset: 0 });
	assert.deepEqual(readAnswer('-', 0), { decision: 'reject', offset: 0 });
	assert.deepEqual(readAnswer('=', 0), { decision: 'defer', offset: 0 });
	assert.deepEqual(readAnswer('A1234', 0), { decision: 'accept', offset: 1234 });
	// Past six digits the field cannot express it: start from zero.
	assert.deepEqual(readAnswer('A12345678', 0), { decision: 'accept', offset: 0 });
	assert.throws(() => readAnswer('?', 0), /unknown proposal answer/);
});

test('the secure-login response matches the reference vectors', () => {
	// Copied from wl2k-go/fbb/secure_test.go, which took them from paclink-unix.
	assert.equal(secureLoginResponse('23753528', 'FOOBAR'), '72768415');
	assert.equal(secureLoginResponse('23753528', 'FooBar'), '95074758');
});

test('the SID advertises what a peer needs to see', () => {
	const sid = parseSid('[WL2K-5.0-B2FWIHJM$]');
	assert.ok(sid);
	assert.equal(sid.application, 'WL2K');
	assert.equal(sid.version, '5.0');
	assert.equal(sid.flags, 'B2FWIHJM$');
	assert.equal(supportsB2(sid), true);
	assert.equal(supportsB2(parseSid('[BPQ-1.0-AF$]')!), false);

	const ours = parseSid(localSid('RF Mail', '0.1', 'B2FHM$G'));
	assert.equal(ours?.application, 'RF Mail');
	assert.equal(ours?.flags, 'B2FHM$G');
});

test('precedence comes from the subject prefix, not a field', () => {
	assert.equal(precedenceOf('//WL2K Z/Emergency'), 'flash');
	assert.equal(precedenceOf('//WL2K O/Now'), 'immediate');
	assert.equal(precedenceOf('//WL2K P/Soon'), 'priority');
	assert.equal(precedenceOf('Hello'), 'routine');
});

test('a transfer frame carries the title, the offset and a checksum', () => {
	const payload = Buffer.alloc(300, 0x41);
	const framed = encodeTransfer({ title: 'Test subject', offset: 0 }, payload);

	assert.equal(framed[0], 0x01);
	const headerLength = framed[1] ?? 0;
	const header = framed.subarray(2, 2 + headerLength).toString('latin1');
	assert.equal(header, `Test subject\0${0}\0`);

	// 300 bytes in blocks of 125.
	const blocks = Math.ceil(300 / TRANSFER_BLOCK_BYTES);
	const stxCount = framed.filter((byte) => byte === 0x02).length;
	assert.equal(stxCount, blocks);
	assert.equal(framed[framed.length - 2], 0x04);

	const decoder = new TransferDecoder();
	const events: TransferEvent[] = [];
	// Feed it in awkward pieces to prove the streaming path.
	for (let position = 0; position < framed.length; position += 7) {
		events.push(...decoder.push(framed.subarray(position, position + 7)));
	}
	const done = events.find((event) => event.type === 'end');
	assert.ok(done && done.type === 'end');
	assert.equal(done.checksumOk, true);
	assert.equal(done.payload.length, 300);
	assert.equal(Buffer.from(done.payload).toString('latin1'), payload.toString('latin1'));

	const head = events.find((event) => event.type === 'header');
	assert.ok(head && head.type === 'header');
	assert.deepEqual(head.header, { title: 'Test subject', offset: 0 });
});

test('a corrupted block fails the checksum, and an error line is surfaced', () => {
	const framed = Buffer.from(encodeTransfer({ title: 'x', offset: 0 }, Buffer.from('hello world')));
	framed[framed.length - 3] = (framed[framed.length - 3] ?? 0) ^ 0xff; // flip a payload byte
	const decoder = new TransferDecoder();
	const events = [...decoder.push(framed)];
	const end = events.find((event) => event.type === 'end');
	assert.ok(end && end.type === 'end');
	assert.equal(end.checksumOk, false);

	const errorDecoder = new TransferDecoder();
	const errorEvents = [...errorDecoder.push(Buffer.from('*** Protocol error, message rejected\r\n'))];
	assert.equal(errorEvents[0]?.type, 'remote-error');
	assert.match((errorEvents[0] as { line: string }).line, /Protocol error/);
});
