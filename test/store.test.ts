import assert from 'node:assert/strict';
import test from 'node:test';
import { composeMessage } from '@rfmail/core-b2f';
import { DEFAULT_FOLDERS, FLAG_UNREAD } from '@rfmail/shared';
import { SqliteStore } from '@rfmail/store';

async function freshStore(): Promise<SqliteStore> {
	const store = new SqliteStore({ path: ':memory:' });
	await store.migrate();
	return store;
}

test('creates a user with the default folders and no password', async () => {
	const store = await freshStore();
	// The callsign is the account and the login (decision 25), stored upper-case.
	const user = await store.createUser({ callsign: 'ok1abc', pwHash: null, role: 'admin' });
	assert.equal(user.login, 'OK1ABC');
	assert.equal(user.callsign, 'OK1ABC');
	assert.equal(user.pwHash, null);
	assert.equal(user.role, 'admin');

	const folders = await store.listFolders(user.id);
	assert.deepEqual(
		folders.map((folder) => folder.name),
		DEFAULT_FOLDERS.map((folder) => folder.name),
	);
	assert.deepEqual(
		folders.map((folder) => folder.kind),
		DEFAULT_FOLDERS.map((folder) => folder.kind),
	);
	assert.ok(folders.every((folder) => folder.total === 0 && folder.unread === 0));
	await store.close();
});

test('login lookup is case-insensitive and counts users', async () => {
	const store = await freshStore();
	await store.createUser({ callsign: 'OK1ABC', pwHash: null, role: 'user' });
	assert.equal(await store.countUsers(), 1);
	// A callsign arrives in whatever case the operator typed it.
	for (const spelling of ['OK1ABC', 'ok1abc', 'Ok1Abc', ' ok1abc ']) {
		assert.equal((await store.findUserByLogin(spelling))?.login, 'OK1ABC', spelling);
		assert.equal((await store.findUserByCallsign(spelling))?.id, (await store.findUserByLogin('OK1ABC'))?.id, spelling);
	}
	assert.equal(await store.findUserByLogin('ok2xyz'), null);
	// The same callsign in another case is the same account, not a second one.
	await assert.rejects(() => store.createUser({ callsign: 'ok1abc', pwHash: null, role: 'user' }));
	await store.close();
});

test('stores a message, assigns uids per folder and lists it', async () => {
	const store = await freshStore();
	const user = await store.createUser({ callsign: 'OK1ABC', pwHash: null, role: 'user' });
	const inbox = await store.findFolder(user.id, 'INBOX');
	assert.ok(inbox);

	const message = composeMessage({
		from: 'a@b',
		to: 'tester',
		subject: 'first',
		body: 'hello',
		mid: 'AAAAAAAAAAAA',
	});
	const inserted = await store.insertMessage(user.id, inbox.id, message, { direction: 'in' });
	assert.equal(inserted.uid, 1);

	const second = await store.insertMessage(
		user.id,
		inbox.id,
		{ ...message, mid: 'BBBBBBBBBBBB', subject: 'second' },
		{ direction: 'in' },
	);
	assert.equal(second.uid, 2);

	const list = await store.listMessages(user.id, inbox.id);
	assert.equal(list.total, 2);
	assert.equal(list.messages.length, 2);
	assert.equal(list.messages[0]?.subject, 'second', 'newest first');
	assert.equal(list.messages[0]?.flags & FLAG_UNREAD, FLAG_UNREAD);

	const folders = await store.listFolders(user.id);
	const listed = folders.find((folder) => folder.id === inbox.id);
	assert.equal(listed?.unread, 2);
	await store.close();
});

test('rejects a duplicate MID for the same user but not across users', async () => {
	const store = await freshStore();
	const alice = await store.createUser({ callsign: 'OK1ALC', pwHash: null, role: 'user' });
	const bob = await store.createUser({ callsign: 'OK2BOB', pwHash: null, role: 'user' });
	const aliceInbox = await store.findFolder(alice.id, 'INBOX');
	const bobInbox = await store.findFolder(bob.id, 'INBOX');
	assert.ok(aliceInbox && bobInbox);
	const message = composeMessage({ from: 'x', to: 'alice', subject: 's', body: 'b', mid: 'CCCCCCCCCCCC' });

	await store.insertMessage(alice.id, aliceInbox.id, message, { direction: 'in' });
	await assert.rejects(() => store.insertMessage(alice.id, aliceInbox.id, message, { direction: 'in' }));
	await store.insertMessage(bob.id, bobInbox.id, message, { direction: 'in' });
	await store.close();
});

test('flags, folders and deletion respect ownership', async () => {
	const store = await freshStore();
	const alice = await store.createUser({ callsign: 'OK1ALC', pwHash: null, role: 'user' });
	const bob = await store.createUser({ callsign: 'OK2BOB', pwHash: null, role: 'user' });
	const inbox = await store.findFolder(alice.id, 'INBOX');
	const archive = await store.findFolder(alice.id, 'ARCHIVE');
	assert.ok(inbox && archive);

	const message = composeMessage({ from: 'x', to: 'alice', subject: 's', body: 'b', mid: 'DDDDDDDDDDDD' });
	const inserted = await store.insertMessage(alice.id, inbox.id, message, { direction: 'in' });

	assert.equal(await store.getMessage(bob.id, inserted.id), null, 'another user cannot read it');
	await store.setFlags(alice.id, inserted.id, 0);
	assert.equal((await store.getMessage(alice.id, inserted.id))?.flags, 0);

	const moved = await store.moveMessage(alice.id, inserted.id, archive.id);
	assert.ok(moved);
	const afterMove = await store.getMessage(alice.id, inserted.id);
	assert.equal(afterMove?.folderId, archive.id);
	assert.equal(afterMove?.uid, 1, 'uid is assigned in the target folder');

	assert.equal(await store.deleteMessage(bob.id, inserted.id), false);
	assert.ok(await store.deleteMessage(alice.id, inserted.id));
	assert.equal(await store.getMessage(alice.id, inserted.id), null);
	await store.close();
});

test('search filters on subject and sender', async () => {
	const store = await freshStore();
	const user = await store.createUser({ callsign: 'OK1ABC', pwHash: null, role: 'user' });
	const inbox = await store.findFolder(user.id, 'INBOX');
	assert.ok(inbox);
	const base = {
		to: ['tester'],
		cc: [] as string[],
		body: 'body',
		charset: 'UTF-8',
		headers: [] as Array<[string, string]>,
		attachments: [] as never[],
		dateUtc: Date.now(),
		messageId: ''
	};
	await store.insertMessage(user.id, inbox.id, { ...base, from: 'jana@example.cz', subject: 'Report', mid: 'EEEEEEEEEEEE' }, { direction: 'in' });
	await store.insertMessage(user.id, inbox.id, { ...base, from: 'petr@example.cz', subject: 'Lunch', mid: 'FFFFFFFFFFFG' }, { direction: 'in' });

	const bySubject = await store.listMessages(user.id, inbox.id, { search: 'repo' });
	assert.equal(bySubject.total, 1);
	assert.equal(bySubject.messages[0]?.subject, 'Report');

	const bySender = await store.listMessages(user.id, inbox.id, { search: 'petr' });
	assert.equal(bySender.total, 1);
	assert.equal(bySender.messages[0]?.subject, 'Lunch');
	await store.close();
});

test('usage counts message bodies and attachments', async () => {
	const store = await freshStore();
	const user = await store.createUser({ callsign: 'OK1ABC', pwHash: null, role: 'user' });
	const inbox = await store.findFolder(user.id, 'INBOX');
	assert.ok(inbox);
	const message = composeMessage({
		from: 'x',
		to: 'tester',
		subject: 's',
		body: 'hello',
		mid: 'GGGGGGGGGGGG',
		attachments: [{ name: 'a.bin', contentType: 'application/octet-stream', data: new Uint8Array(100) }],
	});
	await store.insertMessage(user.id, inbox.id, message, { direction: 'in' });
	const used = await store.usage(user.id);
	assert.ok(used > 100, `usage should include the attachment, got ${used}`);
	await store.close();
});

test('one callsign per account, and the Winlink credential belongs to it', async () => {
	const store = new SqliteStore({ path: ':memory:' });
	await store.migrate();
	// An account is created with its callsign, and the login is that callsign.
	const user = await store.createUser({ callsign: 'OK1OP', pwHash: null, role: 'user' });
	assert.equal(user.login, 'OK1OP');

	assert.equal(await store.setWinlinkSecret(user.id, 'sealed-blob'), true);
	assert.equal(await store.getWinlinkSecret(user.id), 'sealed-blob');

	await store.setCallsign(user.id, 'OK4RM');
	assert.equal((await store.getUser(user.id))?.callsign, 'OK4RM', 'stored upper-cased');
	assert.equal((await store.getUser(user.id))?.login, 'OK4RM', 'the login follows the callsign');
	assert.equal((await store.findUserByLogin('ok4rm'))?.id, user.id);
	assert.equal((await store.findUserByLogin('ok1op')), null, 'the old callsign is not a second name');
	assert.equal(await store.setWinlinkSecret(user.id, 'sealed-blob'), true);
	assert.equal(await store.getWinlinkSecret(user.id), 'sealed-blob');

	// Setting the same callsign again keeps the credential.
	await store.setCallsign(user.id, 'OK4RM');
	assert.equal(await store.getWinlinkSecret(user.id), 'sealed-blob');

	// A different callsign must not inherit the previous callsign's password.
	await store.setCallsign(user.id, 'OK4RM-10');
	assert.equal(await store.getWinlinkSecret(user.id), null);

	// A callsign belongs to one mailbox.
	const other = await store.createUser({ callsign: 'OK2OTH', pwHash: null, role: 'user' });
	await assert.rejects(() => store.setCallsign(other.id, 'OK4RM-10'), /UNIQUE|constraint/i);
	assert.equal((await store.getUser(other.id))?.login, 'OK2OTH', 'a refused rename leaves the login alone');
	assert.equal((await store.findUserByCallsign('OK4RM-10'))?.id, user.id, 'lookup is case-insensitive');

	// Clearing the callsign clears the credential with it, and the old callsign
	// stays the login so the account can still be signed in to.
	await store.setWinlinkSecret(user.id, 'sealed-blob');
	await store.setCallsign(user.id, null);
	assert.equal((await store.getUser(user.id))?.callsign, null);
	assert.equal((await store.getUser(user.id))?.login, 'OK4RM-10');
	assert.equal(await store.getWinlinkSecret(user.id), null);

	// Clearing the credential on its own.
	await store.setCallsign(user.id, 'OK4RM');
	assert.equal(await store.setWinlinkSecret(user.id, 'sealed-blob'), true);
	assert.equal(await store.setWinlinkSecret(user.id, null), true);
	assert.equal(await store.getWinlinkSecret(user.id), null);
	await store.close();
});

test('the transceiver registry stores what a session needs and nothing about state', async () => {
	const store = new SqliteStore({ path: ':memory:' });
	await store.migrate();

	assert.deepEqual(await store.listTransceivers(), []);

	const created = await store.createTransceiver({ name: 'TS-590SG', host: '192.168.133.222' });
	assert.equal(created.port, 4532, 'the default rigctld port');
	assert.equal(created.pttInput, 'rear', 'a modem station transmits from the rear input');
	assert.equal(created.idleMode, 'PKTUSB');
	assert.equal(created.idlePassbandHz, 2000);
	assert.equal(created.timeoutMs, 5000);
	assert.equal(created.enabled, true);
	assert.deepEqual(created.launchArgs, []);
	assert.equal(created.launchCommand, null);
	assert.equal(created.serialPort, null, 'the serial line is recorded, so it starts empty');
	assert.equal(created.serialSpeed, null);
	assert.equal(created.lastUsedAt, 0, 'nothing has been used yet');

	// A second radio, with everything spelled out.
	const second = await store.createTransceiver({
		name: 'IC-7300',
		host: '127.0.0.1',
		port: 4533,
		pttInput: 'front',
		launchCommand: '/usr/bin/rigctld',
		launchArgs: ['-m', '3073', '-r', '/dev/ttyUSB1'],
		idleMode: 'USB',
		idlePassbandHz: 2400,
		timeoutMs: 3000,
	});
	assert.equal(second.pttInput, 'front');
	assert.deepEqual(second.launchArgs, ['-m', '3073', '-r', '/dev/ttyUSB1']);

	// Names are unique, case-insensitively; the registry keeps its stable order, and which
	// interface is *current* is decided by `last_used_at`, not by position.
	await assert.rejects(() => store.createTransceiver({ name: 'ts-590sg', host: 'x' }), /UNIQUE|constraint/i);
	assert.deepEqual((await store.listTransceivers()).map((row) => row.name), ['TS-590SG', 'IC-7300']);

	const patched = await store.updateTransceiver(created.id, { port: 4534, pttInput: 'auto', enabled: false });
	assert.equal(patched?.port, 4534);
	assert.equal(patched?.pttInput, 'auto');
	assert.equal(patched?.enabled, false);
	assert.equal((await store.getTransceiver(created.id))?.port, 4534);

	assert.equal(await store.deleteTransceiver(created.id), true);
	assert.equal(await store.deleteTransceiver(created.id), false, 'the second delete reports nothing removed');
	assert.equal((await store.listTransceivers()).length, 1);
	await store.close();
});

test('one post office owner, and its credential follows the callsign', async () => {
	const store = await freshStore();
	const first = await store.createUser({ callsign: 'OK1ABC', pwHash: null, role: 'admin' });
	const second = await store.createUser({ callsign: 'OK2XYZ', pwHash: null, role: 'user' });

	assert.equal(await store.findPostOfficeOwner(), null, 'nobody owns it until one is marked');
	assert.equal(await store.setPostOfficeOwner(first.id), true);
	assert.equal((await store.findPostOfficeOwner())?.callsign, 'OK1ABC');
	// Marking another account takes the role from the first: the station answers as
	// one callsign, so there is one owner.
	assert.equal(await store.setPostOfficeOwner(second.id), true);
	assert.equal((await store.findPostOfficeOwner())?.callsign, 'OK2XYZ');
	assert.equal((await store.getUser(first.id))?.isPostOffice, false);
	assert.equal(await store.setPostOfficeOwner(null), true);
	assert.equal(await store.findPostOfficeOwner(), null);

	// The post-office password belongs to a callsign like the Winlink one.
	await store.setPostOfficeSecret(second.id, 'sealed-blob');
	assert.equal(await store.getPostOfficeSecret(second.id), 'sealed-blob');
	await store.setCallsign(second.id, 'OK2XYZ-5');
	assert.equal(await store.getPostOfficeSecret(second.id), null, 'a different callsign keeps no credential');
	await store.close();
});

test('a gateway is remembered once per dial, ranked by how often it answered', async () => {
	const store = await freshStore();

	// Nothing called yet.
	assert.deepEqual(await store.listSessionTargets(), []);

	// Three calls to one gateway on one dial count as one entry used three times.
	await store.recordSessionTarget({ callsign: 'OK0N', frequencyHz: 3_597_000, kind: 'vara', sessionMode: 'cms' });
	await store.recordSessionTarget({ callsign: 'ok0n', frequencyHz: 3_597_000, kind: 'vara', sessionMode: 'cms' });
	const third = await store.recordSessionTarget({ callsign: 'OK0N', frequencyHz: 3_597_000, kind: 'vara', sessionMode: 'cms' });
	assert.equal(third.uses, 3, 'a repeated pair counts a use, not a second entry');
	assert.equal(third.callsign, 'OK0N', 'the newest spelling is kept');

	// The same gateway reached on another dial is a different way to call it.
	await store.recordSessionTarget({ callsign: 'OK0N', frequencyHz: 7_043_000, kind: 'vara', sessionMode: 'cms' });
	// A millisecond apart, so "most recent" is a real ordering rather than a tie.
	await new Promise((resolve) => setTimeout(resolve, 2));
	// A gateway called once ranks below one called three times, and below a more recent call.
	await store.recordSessionTarget({ callsign: 'HB9AK', frequencyHz: 14_109_600, kind: 'vara', sessionMode: 'cms' });

	const ranked = await store.listSessionTargets();
	assert.deepEqual(
		ranked.map((row) => [row.callsign, row.frequencyHz, row.uses]),
		[
			['OK0N', 3_597_000, 3],
			['HB9AK', 14_109_600, 1],
			['OK0N', 7_043_000, 1],
		],
		'most used first; equal counts fall back to the more recent use',
	);
	assert.equal((await store.listSessionTargets(2)).length, 2, 'the list can be capped');
	assert.equal(third.kind, 'vara', 'the mode that answered is kept with the entry');

	// The same gateway on the same dial reached with another mode is a separate way in, and it
	// does not inherit the first one's count (decision 49).
	const other = await store.recordSessionTarget({ callsign: 'OK0N', frequencyHz: 3_597_000, kind: 'ardop', sessionMode: 'cms' });
	assert.equal(other.uses, 1);
	assert.equal((await store.listSessionTargets()).filter((row) => row.frequencyHz === 3_597_000).length, 2);

	// …and the same gateway, mode and dial called as a peer is a third entry, not a peer use of
	// the gateway entry (decision 50).
	const peer = await store.recordSessionTarget({
		callsign: 'OK0N',
		frequencyHz: 3_597_000,
		kind: 'ardop',
		sessionMode: 'p2p',
	});
	assert.equal(peer.uses, 1);
	assert.deepEqual(
		(await store.listSessionTargets())
			.filter((row) => row.frequencyHz === 3_597_000)
			.map((row) => [row.kind, row.sessionMode, row.uses])
			.sort(),
		[
			['ardop', 'cms', 1],
			['ardop', 'p2p', 1],
			['vara', 'cms', 3],
		],
	);

	// An entry from before the mode was kept knows nothing about it. A call that does know one is
	// its own entry; the older one keeps what it knows and is never rewritten with a mode, let
	// alone a session type, it did not have (decision 55).
	(store as unknown as { run: (sql: string, ...args: unknown[]) => unknown }).run(
		"INSERT INTO session_targets (callsign, frequency_hz, kind, session_mode, uses, last_used_at, created_at) VALUES ('OK0N', 10148000, '', '', 2, 1, 1)",
	);
	const typed = await store.recordSessionTarget({ callsign: 'OK0N', frequencyHz: 10_148_000, kind: 'xara', sessionMode: 'p2p' });
	assert.equal(typed.kind, 'xara');
	assert.equal(typed.sessionMode, 'p2p');
	assert.equal(typed.uses, 1, 'a call of a known kind is its own entry, not a use of the unknown one');
	const half = (await store.listSessionTargets()).filter((row) => row.frequencyHz === 10_148_000);
	assert.deepEqual(
		half.map((row) => [row.kind, row.sessionMode, row.uses]).sort(),
		[
			[null, null, 2],
			['xara', 'p2p', 1],
		],
		'the unknown entry is left unknown, and nothing was invented into it',
	);

	// The same peer call again counts on the peer entry only: a gateway call never becomes one.
	await store.recordSessionTarget({ callsign: 'ok0n', frequencyHz: 10_148_000, kind: 'xara', sessionMode: 'p2p' });
	assert.deepEqual(
		(await store.listSessionTargets())
			.filter((row) => row.frequencyHz === 10_148_000)
			.map((row) => [row.callsign, row.kind, row.sessionMode, row.uses])
			.sort(),
		[
			['OK0N', null, null, 2],
			['ok0n', 'xara', 'p2p', 2],
		],
	);

	await store.close();
});

test('the station duplicate check sees received mail, never its own outbox', async () => {
	const store = await freshStore();
	const alice = await store.createUser({ callsign: 'OK1ABC', pwHash: null, role: 'user' });
	const bob = await store.createUser({ callsign: 'OK2XYZ', pwHash: null, role: 'user' });
	const aliceOutbox = (await store.findFolder(alice.id, 'OUTBOX'))!.id;
	const bobInbox = (await store.findFolder(bob.id, 'INBOX'))!.id;

	// A message this station is sending is not one it already has.
	await store.insertMessage(
		alice.id,
		aliceOutbox,
		composeMessage({ from: 'OK1ABC', to: 'OK9ZZZ', subject: 's', body: 'b', mid: 'OUTBOX000001' }),
		{ direction: 'out' },
	);
	assert.equal(await store.findReceivedByMid('OUTBOX000001'), null);

	await store.insertMessage(
		bob.id,
		bobInbox,
		composeMessage({ from: 'OK9ZZZ', to: 'OK2XYZ', subject: 's', body: 'b', mid: 'INBOX0000001' }),
		{ direction: 'in' },
	);
	const found = await store.findReceivedByMid('inbox0000001');
	assert.equal(found?.userId, bob.id, 'matched across mailboxes, without regard to case');
	await store.close();
});
