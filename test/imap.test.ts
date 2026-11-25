import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '@rfmail/server';
import { ImapServer, MailEvents, PeerPolicy } from '@rfmail/mailservers';
import { SqliteStore, hashPassword } from '@rfmail/store';
import { composeMessage } from '@rfmail/core-b2f';
import { FLAG_DELETED, FLAG_FLAGGED, FLAG_UNREAD } from '@rfmail/shared';
import { ImapTestClient } from './helpers/protocol-clients.ts';

const silent = createLogger('error', () => {});

async function harness(options: { password?: string } = {}): Promise<{
	store: SqliteStore;
	port: number;
	events: MailEvents;
	userId: number;
	close: () => Promise<void>;
}> {
	const store = new SqliteStore({ path: ':memory:' });
	await store.migrate();
	const user = await store.createUser({
		login: 'tester',
		pwHash: options.password ? hashPassword(options.password) : null,
		role: 'admin',
	});
	await store.setCallsign(user.id, 'OK4RM');
	const events = new MailEvents();
	const server = new ImapServer({
		store,
		policy: new PeerPolicy('very strict'),
		events,
		host: '127.0.0.1',
		port: 0,
		logger: silent,
	});
	await server.listen();
	const port = Number(server.address.split(':').pop());
	return {
		store,
		port,
		events,
		userId: user.id,
		close: async () => {
			await server.close();
			await store.close();
		}
	};
}

async function addToInbox(store: SqliteStore, userId: number, subject: string, body: string): Promise<number> {
	const inbox = await store.findFolder(userId, 'INBOX');
	assert.ok(inbox);
	const inserted = await store.insertMessage(
		userId,
		inbox.id,
		composeMessage({
			from: 'jana@example.cz',
			to: 'tester@winlink.org',
			subject,
			body,
			mid: `M${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
		}),
		{ direction: 'in' }
	);
	return inserted.id;
}

async function login(port: number): Promise<ImapTestClient> {
	const client = new ImapTestClient(port);
	assert.match(await client.greeting(), /^\* OK \[CAPABILITY/);
	const loginReply = await client.command('LOGIN tester ""');
	assert.equal(loginReply.status, 'OK');
	return client;
}

test('login, list, select, fetch and search', async () => {
	const { store, port, userId, close } = await harness();
	try {
		await addToInbox(store, userId, 'První zpráva', 'Tělo první zprávy.');
		const client = await login(port);

		const list = await client.command('LIST "" "*"');
		assert.equal(list.status, 'OK');
		assert.equal(list.lines.filter((line) => line.startsWith('* LIST')).length, 5);

		const select = await client.command('SELECT INBOX');
		assert.equal(select.status, 'OK');
		assert.ok(select.lines.some((line) => line === '* 1 EXISTS'));
		assert.ok(select.lines.some((line) => line.includes('UIDVALIDITY')));

		const fetch = await client.command('FETCH 1 (UID FLAGS RFC822.SIZE ENVELOPE)');
		assert.equal(fetch.status, 'OK');
		const meta = fetch.lines.find((line) => line.startsWith('* 1 FETCH'));
		assert.ok(meta);
		assert.match(meta, /UID 1 /);
		assert.match(meta, /FLAGS \(\)/, 'a new message is unread, so it carries no \\Seen flag');
		assert.ok(meta.includes('ENVELOPE ('), 'the envelope is present');
		assert.match(meta, /RFC822\.SIZE \d+/);

		const body = await client.command('FETCH 1 (BODY.PEEK[])');
		assert.equal(body.status, 'OK');
		const raw = body.literals[0]?.toString('utf8') ?? '';
		assert.match(raw, /^From: jana@example\.cz\r\n/);
		assert.match(raw, /\r\nSubject: =/);

		// BODY.PEEK must not touch the flags; a plain BODY[] marks the message seen.
		const stillUnread = await client.command('FETCH 1 (FLAGS)');
		assert.ok(stillUnread.lines.some((line) => line.includes('FLAGS ()')));
		const markedRead = await client.command('FETCH 1 (BODY[])');
		assert.ok(markedRead.lines.some((line) => line.includes('FLAGS (\\Seen)')));

		const search = await client.command('SEARCH ALL');
		assert.deepEqual(search.lines.filter((line) => line.startsWith('* SEARCH')), ['* SEARCH 1']);

		// The BODY[] fetch above marked it seen, so UNSEEN is now empty and SEEN finds it.
		const unseen = await client.command('SEARCH UNSEEN');
		assert.ok(unseen.lines.some((line) => line.trim() === '* SEARCH'));
		const seenSearch = await client.command('SEARCH SEEN');
		assert.ok(seenSearch.lines.some((line) => line.includes('* SEARCH 1')));

		await client.command('LOGOUT');
		client.close();
	} finally {
		await close();
	}
});

test('flags: STORE updates the store and EXPUNGE removes \\Deleted messages', async () => {
	const { store, port, userId, close } = await harness();
	try {
		const first = await addToInbox(store, userId, 'One', 'first');
		await addToInbox(store, userId, 'Two', 'second');
		const client = await login(port);
		await client.command('SELECT INBOX');

		const store2 = await client.command('STORE 1 +FLAGS (\\Flagged \\Seen)');
		assert.equal(store2.status, 'OK');
		const afterStore = await store.getMessage(userId, first);
		assert.ok(afterStore);
		assert.equal(afterStore.flags & FLAG_FLAGGED, FLAG_FLAGGED);
		assert.equal(afterStore.flags & FLAG_UNREAD, 0);

		assert.equal((await client.command('STORE 1 -FLAGS (\\Seen)')).status, 'OK');
		const afterUnseen = await store.getMessage(userId, first);
		assert.ok(afterUnseen);
		assert.equal(afterUnseen.flags & FLAG_UNREAD, FLAG_UNREAD);

		await client.command('STORE 1 +FLAGS (\\Deleted)');
		const afterDelete = await store.getMessage(userId, first);
		assert.ok(afterDelete);
		assert.equal(afterDelete.flags & FLAG_DELETED, FLAG_DELETED);

		const expunge = await client.command('EXPUNGE');
		assert.equal(expunge.status, 'OK');
		assert.ok(expunge.lines.includes('* 1 EXPUNGE'));
		assert.equal(await store.getMessage(userId, first), null);
		assert.equal((await store.listMessages(userId, (await store.findFolder(userId, 'INBOX'))!.id)).total, 1);

		await client.command('LOGOUT');
		client.close();
	} finally {
		await close();
	}
});

test('APPEND stores a message, COPY duplicates it with its own MID', async () => {
	const { store, port, userId, close } = await harness();
	try {
		const client = await login(port);
		const raw = [
			'From: tester@winlink.org',
			'To: someone@winlink.org',
			'Subject: Appended',
			'Date: Tue, 24 Nov 2026 16:00:00 +0000',
			'',
			'Body of the appended message.',
			''
		].join('\r\n');
		const append = await client.command('APPEND INBOX (\\Seen) ', { literal: raw });
		assert.equal(append.status, 'OK');

		const inbox = await store.findFolder(userId, 'INBOX');
		assert.ok(inbox);
		const messages = await store.listMessages(userId, inbox.id);
		assert.equal(messages.total, 1);
		const stored = await store.getMailMessage(userId, messages.messages[0]?.id ?? 0);
		assert.equal(stored?.subject, 'Appended');

		const select = await client.command('SELECT INBOX');
		assert.ok(select.lines.includes('* 1 EXISTS'));

		const copy = await client.command('COPY 1 ARCHIVE');
		assert.equal(copy.status, 'OK');
		const archive = await store.findFolder(userId, 'ARCHIVE');
		assert.ok(archive);
		const archived = await store.listMessages(userId, archive.id);
		assert.equal(archived.total, 1);
		const copyMessage = await store.getMailMessage(userId, archived.messages[0]?.id ?? 0);
		assert.equal(copyMessage?.subject, 'Appended');
		assert.notEqual(copyMessage?.mid, stored?.mid, 'the copy has its own MID');

		await client.command('LOGOUT');
		client.close();
	} finally {
		await close();
	}
});

test('a password-protected account needs the right password', async () => {
	const { port, close } = await harness({ password: 'hunter2' });
	try {
		const client = new ImapTestClient(port);
		await client.greeting();
		const denied = await client.command('LOGIN tester ""');
		assert.equal(denied.status, 'NO');
		const wrong = await client.command('LOGIN tester wrong');
		assert.equal(wrong.status, 'NO');
		const accepted = await client.command('LOGIN tester hunter2');
		assert.equal(accepted.status, 'OK');
		await client.command('LOGOUT');
		client.close();
	} finally {
		await close();
	}
});

test('IDLE reports a new message without a poll', async () => {
	const { store, port, userId, events, close } = await harness();
	try {
		const client = await login(port);
		await client.command('SELECT INBOX');
		client.write('T99 IDLE\r\n');
		assert.match(await client.line(), /^\+ idling/);

		const inbox = await store.findFolder(userId, 'INBOX');
		assert.ok(inbox);
		await addToInbox(store, userId, 'While idling', 'arrived');
		// A writer elsewhere (SMTP, the API, later B2F) publishes the event.
		events.notify({ userId, folderId: inbox.id, folder: 'INBOX' });
		const seen = await (async () => {
			for (;;) {
				const line = await client.line();
				if (line.startsWith('* 1 EXISTS')) return line;
			}
		})();
		assert.match(seen, /^\* 1 EXISTS/);

		client.write('DONE\r\n');
		for (;;) {
			const line = await client.line();
			if (line.startsWith('T99 ')) {
				assert.match(line, /^T99 OK/);
				break;
			}
		}
		await client.command('LOGOUT');
		client.close();
	} finally {
		await close();
	}
});

test('a UID FETCH answer carries the UID even when the client did not ask for it', async () => {
	const { store, port, userId, close } = await harness();
	try {
		await addToInbox(store, userId, 'Uid rule', 'body');
		const client = await login(port);
		await client.command('SELECT INBOX');

		// RFC 3501 §6.4.8. Thunderbird matches messages by this item and drops
		// everything else, which shows up as an empty message list.
		const flagsOnly = await client.command('UID FETCH 1:* (FLAGS)');
		assert.equal(flagsOnly.status, 'OK');
		const line = flagsOnly.lines.find((entry) => entry.startsWith('* 1 FETCH'));
		assert.ok(line, 'a FETCH response was sent');
		assert.match(line, /UID 1 /, `the UID is missing from: ${line}`);

		// Asking for it explicitly must not duplicate it.
		const asked = await client.command('UID FETCH 1 (UID FLAGS)');
		const askedLine = asked.lines.find((entry) => entry.startsWith('* 1 FETCH')) ?? '';
		assert.equal(askedLine.match(/\bUID \d+/g)?.length, 1, askedLine);

		await client.command('LOGOUT');
		client.close();
	} finally {
		await close();
	}
});

test('body sections return the parts a client asks for, not the whole message', async () => {
	const { store, port, userId, close } = await harness();
	try {
		const inbox = await store.findFolder(userId, 'INBOX');
		assert.ok(inbox);
		await store.insertMessage(
			userId,
			inbox.id,
			composeMessage({
				from: 'OK4RM',
				to: 'OK2XYZ',
				subject: 'Parts',
				body: 'the text part\n',
				mid: 'PARTSPROBE12',
				attachments: [
					{ name: 'note.txt', contentType: 'text/plain', data: Buffer.from('the attachment\n') },
				],
			}),
			{ direction: 'in' },
		);
		const client = await login(port);
		await client.command('SELECT INBOX');

		const one = await client.command('UID FETCH 1 (BODY.PEEK[1])');
		const text = one.literals[0]?.toString('latin1') ?? '';
		assert.match(text, /^the text part/);
		assert.ok(!text.includes('Content-Type: multipart'), 'part 1 is not the whole message');

		const two = await client.command('UID FETCH 1 (BODY.PEEK[2])');
		const attachment = two.literals[0]?.toString('latin1') ?? '';
		assert.equal(attachment, 'dGhlIGF0dGFjaG1lbnQK', 'part 2 is the base64 attachment');

		const mime = await client.command('UID FETCH 1 (BODY.PEEK[1.MIME])');
		assert.match(mime.literals[0]?.toString('latin1') ?? '', /^Content-Type: text\/plain/);

		const header = await client.command('UID FETCH 1 (BODY.PEEK[HEADER.FIELDS (Subject)])');
		const fields = header.literals[0]?.toString('latin1') ?? '';
		assert.match(fields, /^Subject: Parts/);
		assert.ok(!fields.includes('From:'), 'only the named header comes back');

		await client.command('LOGOUT');
		client.close();
	} finally {
		await close();
	}
});
