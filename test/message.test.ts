import assert from 'node:assert/strict';
import test from 'node:test';
import { composeMessage, generateMid, serialiseRfc822, parseRfc822 } from '@rfmail/core-b2f';
import { hashPassword, verifyPassword } from '@rfmail/store';

const SAMPLE = Buffer.from(
	[
		'From: "Jana Novakova" <jana@example.cz>',
		'To: tester@winlink.org',
		'Cc: second@example.org',
		'Subject: =?UTF-8?Q?P=C5=99=C3=ADli=C5=A1_velk=C3=BD_test?=',
		'Date: Mon, 24 Nov 2026 09:12:00 +0100',
		'Message-ID: <abc123@example.cz>',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="b1"',
		'',
		'--b1',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: quoted-printable',
		'',
		'Dobr=C3=BD den,',
		'toto je testovac=C3=AD zpr=C3=A1va.',
		'--b1',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Disposition: attachment; filename="poznamka.txt"',
		'Content-Transfer-Encoding: base64',
		'',
		'SGVsbG8gYXR0YWNobWVudAo=',
		'--b1--',
		'',
	].join('\r\n'),
	'latin1',
);

test('parses headers, charset, recipients and attachments', () => {
	const message = parseRfc822(SAMPLE, { mid: 'ABCDEFGHJKLM' });
	assert.equal(message.subject, 'Příliš velký test');
	assert.equal(message.from, '"Jana Novakova" <jana@example.cz>');
	// Winlink addresses are stored bare (address.ts); the domain comes back when
	// the message is serialised for a mail client.
	assert.deepEqual(message.to, ['TESTER']);
	assert.deepEqual(message.cc, ['second@example.org']);
	assert.equal(message.messageId, 'abc123@example.cz');
	assert.equal(new Date(message.dateUtc).toISOString(), '2026-11-24T08:12:00.000Z');
	assert.match(message.body, /^Dobrý den,\ntoto je testovací zpráva\.$/);
	assert.equal(message.attachments.length, 1);
	assert.equal(message.attachments[0]?.name, 'poznamka.txt');
	assert.equal(Buffer.from(message.attachments[0]?.data ?? []).toString(), 'Hello attachment\n');
});

test('serialises to CRLF and parses back to the same message', () => {
	const original = parseRfc822(SAMPLE, { mid: 'ABCDEFGHJKLM' });
	const wire = Buffer.from(serialiseRfc822(original)).toString('latin1');
	assert.ok(wire.includes('\r\nSubject: =?UTF-8?Q?'), 'subject must be Q-encoded');
	assert.ok(!/[^\r]\n/.test(wire), 'every newline on the wire is CRLF');

	const reparsed = parseRfc822(new Uint8Array(Buffer.from(wire, 'latin1')), { mid: 'ABCDEFGHJKLM' });
	assert.equal(reparsed.subject, original.subject);
	assert.equal(reparsed.body.trimEnd(), original.body.trimEnd());
	assert.deepEqual(reparsed.to, original.to);
	assert.equal(reparsed.attachments.length, 1);
	assert.equal(Buffer.from(reparsed.attachments[0]?.data ?? []).toString(), 'Hello attachment\n');
});

test('plain text message without attachments round-trips', () => {
	const message = composeMessage({
		from: 'OK4RM',
		to: 'LA5NTA@winlink.org',
		subject: 'Žluťoučký kůň',
		body: 'Line one\nLine two with ünïcode',
		mid: 'ZZZZZZZZZZZZ',
	});
	const wire = new Uint8Array(serialiseRfc822(message));
	const back = parseRfc822(wire, { mid: message.mid });
	assert.equal(back.subject, 'Žluťoučký kůň');
	assert.equal(back.body.trimEnd(), 'Line one\nLine two with ünïcode');
	assert.equal(back.attachments.length, 0);
});

test('empty and non-UTF-8 headers do not throw', () => {
	const raw = Buffer.from('From: a@b\r\nSubject: caf\xe9 latin1\r\n\r\nbody\r\n', 'latin1');
	const message = parseRfc822(new Uint8Array(raw), { mid: 'MID000000001' });
	assert.equal(message.subject, 'café latin1');
});

test('MID is 12 characters of base32 and changes over time', () => {
	const a = generateMid('OK4RM', 1);
	const b = generateMid('OK4RM', 2);
	assert.equal(a.length, 12);
	assert.match(a, /^[A-Z2-7]{12}$/);
	assert.notEqual(a, b);
});

test('scrypt password hashing verifies and rejects', () => {
	const hash = hashPassword('correct horse battery staple');
	assert.ok(verifyPassword('correct horse battery staple', hash));
	assert.equal(verifyPassword('wrong', hash), false);
	assert.equal(verifyPassword('anything', null), false);
	assert.equal(verifyPassword('', null), true, 'a passwordless account accepts an empty password');
});
