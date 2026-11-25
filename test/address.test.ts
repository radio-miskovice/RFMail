import assert from 'node:assert/strict';
import test from 'node:test';
import {
	canonicaliseAddressList,
	composeMessage,
	expandMessageAddresses,
	parseRfc822,
	serialiseRfc822,
	toFullAddress,
	toFullHeader,
	toWinlinkAddress,
	toWinlinkHeader,
} from '@rfmail/core-b2f';

test('a Winlink address loses its domain in the store', () => {
	for (const input of ['OK4RM@winlink.org', 'OK4RM@Winlink.ORG', 'OK4RM', ' OK4RM ']) {
		assert.equal(toWinlinkAddress(input), 'OK4RM', input);
	}
	assert.equal(toWinlinkAddress('OK4RM-10@winlink.org'), 'OK4RM-10');
	assert.equal(toWinlinkAddress('jana@example.cz'), 'jana@example.cz', 'another domain is untouched');
	assert.equal(toWinlinkAddress('"Jana" <jana@example.cz>'), 'jana@example.cz');
	assert.equal(toWinlinkAddress(''), '');
});

test('a bare callsign gains the domain for a mail client', () => {
	assert.equal(toFullAddress('OK4RM'), 'OK4RM@winlink.org');
	assert.equal(toFullAddress('OK4RM-10'), 'OK4RM-10@winlink.org');
	assert.equal(toFullAddress('OK4RM@winlink.org'), 'OK4RM@winlink.org');
	assert.equal(toFullAddress('jana@example.cz'), 'jana@example.cz');
	assert.equal(toFullAddress(''), '');
});

test('header values keep display names for internet senders only', () => {
	assert.equal(toWinlinkHeader('"Jana Novakova" <jana@example.cz>'), '"Jana Novakova" <jana@example.cz>');
	assert.equal(toWinlinkHeader('"Tester" <tester@winlink.org>'), 'TESTER');
	assert.equal(toFullHeader('OK4RM'), 'OK4RM@winlink.org');
	assert.equal(toFullHeader('OK4RM@winlink.org'), 'OK4RM@winlink.org');
	assert.equal(toFullHeader('"Jana Novakova" <jana@example.cz>'), '"Jana Novakova" <jana@example.cz>');
});

test('lists are canonicalised in both directions and drop empties', () => {
	assert.deepEqual(canonicaliseAddressList(['OK4RM@winlink.org', ' jana@example.cz ', '']), [
		'OK4RM',
		'jana@example.cz',
	]);
});

test('a message round-trips: clients see the domain, the store keeps the callsign', () => {
	const raw = Buffer.from(
		[
			'From: OK4RM@winlink.org',
			'To: OK4RM@winlink.org, jana@example.cz',
			'Subject: Round trip',
			'Date: Tue, 24 Nov 2026 16:00:00 +0000',
			'',
			'Body.',
			'',
		].join('\r\n'),
		'latin1',
	);
	const stored = parseRfc822(raw, { mid: 'ABCDEFGHJKLM' });
	assert.equal(stored.from, 'OK4RM');
	assert.deepEqual(stored.to, ['OK4RM', 'jana@example.cz']);

	const wire = Buffer.from(serialiseRfc822(stored)).toString('latin1');
	assert.match(wire, /^From: OK4RM@winlink\.org\r$/m);
	assert.match(wire, /^To: OK4RM@winlink\.org, jana@example\.cz\r$/m);

	// The radio side asks for the stored form.
	const radio = Buffer.from(serialiseRfc822(stored, { winlink: false })).toString('latin1');
	assert.match(radio, /^From: OK4RM\r$/m);
	assert.match(radio, /^To: OK4RM, jana@example\.cz\r$/m);
});

test('the composer stores bare callsigns and expands them for display', () => {
	const message = composeMessage({
		from: 'OK4RM',
		to: 'OK4RM@winlink.org, jana@example.cz',
		cc: 'ok9zzz@winlink.org',
		subject: 'Composed',
		body: 'hello',
		mid: 'ABCDEFGHJKLM',
	});
	const stored = {
		...message,
		from: toWinlinkHeader(message.from),
		to: message.to.map(toWinlinkHeader),
		cc: message.cc.map(toWinlinkHeader),
	};
	assert.equal(stored.from, 'OK4RM');
	assert.deepEqual(stored.to, ['OK4RM', 'jana@example.cz']);
	assert.deepEqual(stored.cc, ['OK9ZZZ']);

	const shown = expandMessageAddresses(stored);
	assert.equal(shown.from, 'OK4RM@winlink.org');
	assert.deepEqual(shown.to, ['OK4RM@winlink.org', 'jana@example.cz']);
});
