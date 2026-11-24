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
	const user = await store.createUser({ login: 'Tester', pwHash: null, role: 'admin' });
	assert.equal(user.login, 'Tester');
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
	await store.createUser({ login: 'tester', pwHash: null, role: 'user' });
	assert.equal(await store.countUsers(), 1);
	assert.ok(await store.findUserByLogin('TESTER'));
	assert.equal(await store.findUserByLogin('other'), null);
	await assert.rejects(() => store.createUser({ login: 'TESTER', pwHash: null, role: 'user' }));
	await store.close();
});

test('stores a message, assigns uids per folder and lists it', async () => {
	const store = await freshStore();
	const user = await store.createUser({ login: 'tester', pwHash: null, role: 'user' });
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
	const alice = await store.createUser({ login: 'alice', pwHash: null, role: 'user' });
	const bob = await store.createUser({ login: 'bob', pwHash: null, role: 'user' });
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
	const alice = await store.createUser({ login: 'alice', pwHash: null, role: 'user' });
	const bob = await store.createUser({ login: 'bob', pwHash: null, role: 'user' });
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
	const user = await store.createUser({ login: 'tester', pwHash: null, role: 'user' });
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
	const user = await store.createUser({ login: 'tester', pwHash: null, role: 'user' });
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
	const user = await store.createUser({ login: 'op', pwHash: null, role: 'user' });

	assert.equal(await store.setWinlinkSecret(user.id, 'sealed-blob'), false, 'no callsign yet');
	assert.equal(await store.getWinlinkSecret(user.id), null);

	await store.setCallsign(user.id, 'ok1abc');
	assert.equal((await store.getUser(user.id))?.callsign, 'OK1ABC', 'stored upper-cased');
	assert.equal(await store.setWinlinkSecret(user.id, 'sealed-blob'), true);
	assert.equal(await store.getWinlinkSecret(user.id), 'sealed-blob');

	// Setting the same callsign again keeps the credential.
	await store.setCallsign(user.id, 'OK1ABC');
	assert.equal(await store.getWinlinkSecret(user.id), 'sealed-blob');

	// A different callsign must not inherit the previous callsign's password.
	await store.setCallsign(user.id, 'OK1ABC-10');
	assert.equal(await store.getWinlinkSecret(user.id), null);

	// A callsign belongs to one mailbox.
	const other = await store.createUser({ login: 'other', pwHash: null, role: 'user' });
	await assert.rejects(() => store.setCallsign(other.id, 'OK1ABC-10'), /UNIQUE|constraint/i);
	assert.equal((await store.findUserByCallsign('ok1abc-10'))?.id, user.id, 'lookup is case-insensitive');

	// Clearing the callsign clears the credential with it.
	await store.setWinlinkSecret(user.id, 'sealed-blob');
	await store.setCallsign(user.id, null);
	assert.equal((await store.getUser(user.id))?.callsign, null);
	assert.equal(await store.getWinlinkSecret(user.id), null);

	// Clearing the credential on its own.
	await store.setCallsign(user.id, 'OK1ABC');
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

	// Names are unique, case-insensitively; the registry is listed by name.
	await assert.rejects(() => store.createTransceiver({ name: 'ts-590sg', host: 'x' }), /UNIQUE|constraint/i);
	assert.deepEqual((await store.listTransceivers()).map((row) => row.name), ['IC-7300', 'TS-590SG']);

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
