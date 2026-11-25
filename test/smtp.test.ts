import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '@rfmail/server';
import { MailEvents, PeerPolicy, SmtpServer } from '@rfmail/mailservers';
import { SqliteStore } from '@rfmail/store';
import { SmtpTestClient } from './helpers/protocol-clients.ts';

const silent = createLogger('error', () => {});

const MESSAGE = [
	'From: OK4RM@winlink.org',
	'To: LA5NTA@winlink.org',
	'Subject: Hello from SMTP',
	'Date: Tue, 24 Nov 2026 16:00:00 +0000',
	'MIME-Version: 1.0',
	'Content-Type: text/plain; charset=utf-8',
	'Content-Transfer-Encoding: 8bit',
	'',
	'Line one.',
	'.dot line preserved',
	'Konec.',
].join('\r\n');

async function harness(options: { password?: string; maxMessageBytes?: number } = {}): Promise<{
	store: SqliteStore;
	server: SmtpServer;
	port: number;
	events: MailEvents;
	userId: number;
	close: () => Promise<void>;
}> {
	const store = new SqliteStore({ path: ':memory:' });
	await store.migrate();
	const user = await store.createUser({ login: 'tester', pwHash: null, role: 'admin' });
	await store.setCallsign(user.id, 'OK4RM');
	const events = new MailEvents();
	const server = new SmtpServer({
		store,
		policy: new PeerPolicy('very strict'),
		events,
		host: '127.0.0.1',
		port: 0,
		logger: silent,
		...(options.maxMessageBytes !== undefined ? { maxMessageBytes: options.maxMessageBytes } : {}),
	});
	await server.listen();
	const port = Number(server.address.split(':').pop());
	return {
		store,
		server,
		port,
		events,
		userId: user.id,
		close: async () => {
			await server.close();
			await store.close();
		},
	};
}

test('accepts an authenticated submission into OUTBOX and notifies', async () => {
	const { store, port, events, userId, close } = await harness();
	try {
		const notifications: string[] = [];
		events.subscribe((event) => notifications.push(event.folder));

		const client = new SmtpTestClient(port);
		await client.greeting();
		assert.match(await client.cmd('EHLO test'), /^250/);
		const auth = await client.cmd(`AUTH PLAIN ${Buffer.from('\u0000tester\u0000').toString('base64')}`);
		assert.match(auth, /^235/);
		assert.match(await client.cmd('MAIL FROM:<OK4RM@winlink.org>'), /^250/);
		assert.match(await client.cmd('RCPT TO:<LA5NTA@winlink.org>'), /^250/);
		const queued = await client.data(MESSAGE);
		assert.match(queued, /^250 .*queued as [A-Z2-7]{12}/);
		assert.match(await client.cmd('QUIT'), /^221/);
		client.close();

		const outbox = await store.findFolder(userId, 'OUTBOX');
		assert.ok(outbox);
		const list = await store.listMessages(userId, outbox.id);
		assert.equal(list.total, 1);
		const stored = await store.getMailMessage(userId, list.messages[0]?.id ?? 0);
		assert.ok(stored);
		assert.equal(stored.from, 'OK4RM', 'the OUTBOX keeps the bare callsign');
		assert.deepEqual(stored.to, ['LA5NTA'], 'recipients likewise');
		const wire = Buffer.from(
			(await import('@rfmail/core-b2f')).serialiseRfc822(stored),
		).toString('latin1');
		assert.match(wire, /^From: OK4RM@winlink\.org\r$/m, 'a client sees the domain');
		assert.match(wire, /^To: LA5NTA@winlink\.org\r$/m);
		assert.equal(stored.subject, 'Hello from SMTP');
		assert.equal(stored.body, 'Line one.\n.dot line preserved\nKonec.\n');
		assert.deepEqual(notifications, ['OUTBOX']);
	} finally {
		await close();
	}
});

test('refuses submission before authentication and from a foreign sender', async () => {
	const { port, close } = await harness();
	try {
		const client = new SmtpTestClient(port);
		await client.greeting();
		await client.cmd('EHLO test');
		assert.match(await client.cmd('MAIL FROM:<someone@example.org>'), /^530/);

		assert.match(await client.cmd('AUTH LOGIN'), /^334 /);
		client.write(`${Buffer.from('tester').toString('base64')}\r\n`);
		assert.match(await client.line(), /^334 /);
		client.write(`${Buffer.from('').toString('base64')}\r\n`);
		assert.match(await client.line(), /^235/);

		assert.match(await client.cmd('MAIL FROM:<someone@example.org>'), /^553/);
		assert.match(await client.cmd('RCPT TO:<LA5NTA@winlink.org>'), /^503/);
		await client.cmd('QUIT');
		client.close();
	} finally {
		await close();
	}
});

test('rejects a wrong password and an oversized message', async () => {
	const { store, port, userId, close } = await harness({ maxMessageBytes: 400 });
	try {
		await store.setUserPassword(userId, (await import('@rfmail/store')).hashPassword('secret'));
		const client = new SmtpTestClient(port);
		await client.greeting();
		await client.cmd('EHLO test');
		assert.match(
			await client.cmd(`AUTH PLAIN ${Buffer.from('\u0000tester\u0000wrong').toString('base64')}`),
			/^535/,
		);
		assert.match(
			await client.cmd(`AUTH PLAIN ${Buffer.from('\u0000tester\u0000secret').toString('base64')}`),
			/^235/,
		);
		assert.match(await client.cmd('MAIL FROM:<OK4RM>'), /^250/);
		assert.match(await client.cmd('RCPT TO:<LA5NTA@winlink.org>'), /^250/);
		const payload = `${MESSAGE}\r\n${'x'.repeat(600)}`;
		assert.match(await client.data(payload), /^552/);
		// The session is still in step after the refusal.
		assert.match(await client.cmd('NOOP'), /^250/);
		await client.cmd('QUIT');
		client.close();
	} finally {
		await close();
	}
});
