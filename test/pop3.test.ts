import assert from 'node:assert/strict';
import test from 'node:test';
import { connect, type Socket } from 'node:net';
import { composeMessage } from '@rfmail/core-b2f';
import { createLogger } from '@rfmail/server';
import { PeerPolicy, Pop3Server } from '@rfmail/mailservers';
import { SqliteStore, hashPassword } from '@rfmail/store';

const silent = createLogger('error', () => {});

interface Client {
	greeting: string;
	cmd: (line: string) => Promise<string>;
	multi: (line: string) => Promise<{ first: string; lines: string[] }>;
	close: () => void;
}

function connectClient(port: number): Promise<Client> {
	return new Promise((resolve, reject) => {
		const socket: Socket = connect(port, '127.0.0.1');
		let buffer = '';
		const queued: string[] = [];
		const waiters: Array<(line: string) => void> = [];
		let greeting = '';

		const nextLine = (): Promise<string> => {
			if (queued.length > 0) return Promise.resolve(queued.shift() as string);
			return new Promise((done, fail) => {
				const timer = setTimeout(() => fail(new Error('POP3 read timed out')), 5000);
				waiters.push((line) => {
					clearTimeout(timer);
					done(line);
				});
			});
		};

		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const index = buffer.indexOf('\r\n');
				if (index === -1) break;
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				if (greeting === '') {
					greeting = line;
				} else {
					const waiter = waiters.shift();
					if (waiter) waiter(line);
					else queued.push(line);
				}
			}
		});
		socket.on('error', reject);

		const ready = (): void => {
			socket.off('error', reject);
			resolve({
				get greeting() {
					return greeting;
				},
				async cmd(line: string) {
					socket.write(`${line}\r\n`);
					return nextLine();
				},
				async multi(line: string) {
					socket.write(`${line}\r\n`);
					const first = await nextLine();
					const lines: string[] = [];
					for (;;) {
						const next = await nextLine();
						if (next === '.') break;
						lines.push(next);
					}
					return { first, lines };
				},
				close() {
					socket.destroy();
				}
			});
		};

		const waitForGreeting = (): void => {
			if (greeting === '') setTimeout(waitForGreeting, 10);
			else ready();
		};
		waitForGreeting();
	});
}

async function setupAccount(options: { password?: string } = {}): Promise<{
	store: SqliteStore;
	server: Pop3Server;
	port: number;
	userId: number;
	close: () => Promise<void>;
}> {
	const store = new SqliteStore({ path: ':memory:' });
	await store.migrate();
	const user = await store.createUser({
		callsign: 'OK4RM',
		pwHash: options.password ? hashPassword(options.password) : null,
		role: 'admin',
	});
	const server = new Pop3Server({
		store,
		policy: new PeerPolicy('very strict'),
		host: '127.0.0.1',
		port: 0,
		logger: silent,
	});
	await server.listen();
	const port = Number(server.address.split(':').pop());
	return {
		store,
		server,
		port,
		userId: user.id,
		close: async () => {
			await server.close();
			await store.close();
		}
	};
}

async function addMessage(store: SqliteStore, userId: number, subject: string, body: string): Promise<number> {
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
			mid: `MID${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
		}),
		{ direction: 'in' }
	);
	return inserted.id;
}

test('POP3 retrieves a message with an empty password and dot-stuffs it', async () => {
	const { store, port, userId, close } = await setupAccount();
	try {
		await addMessage(store, userId, 'First', 'line one\n.hidden\nline three');
		const client = await connectClient(port);
		assert.match(client.greeting, /^\+OK /);
		assert.match(await client.cmd('USER ok4rm'), /^\+OK/);
		assert.match(await client.cmd('PASS '), /^\+OK 1 message/);

		const list = await client.multi('LIST');
		assert.match(list.first, /^\+OK/);
		assert.equal(list.lines.length, 1);
		const size = Number(list.lines[0]?.split(' ')[1]);
		assert.ok(size > 0);

		assert.equal(await client.cmd('STAT'), `+OK 1 ${size}`);

		const uidl = await client.multi('UIDL');
		assert.equal(uidl.lines.length, 1);

		const retr = await client.multi('RETR 1');
		assert.equal(retr.first, `+OK ${size} octets`);
		assert.ok(retr.lines.includes('..hidden'), 'leading dot must be doubled');
		assert.ok(retr.lines.join('\r\n').includes('Subject: First'));

		const top = await client.multi('TOP 1 1');
		assert.match(top.first, /^\+OK/);
		assert.ok(top.lines.some((line) => line.startsWith('Subject:')));
		const blank = top.lines.indexOf('');
		assert.ok(blank >= 0, 'headers are followed by a blank line');
		assert.ok(top.lines.length - blank - 1 <= 1, 'TOP 1 keeps at most one body line');

		assert.match(await client.cmd('QUIT'), /^\+OK/);
		client.close();
		assert.ok((await store.findFolder(userId, 'INBOX')) !== null);
		const list2 = await store.listMessages(userId, (await store.findFolder(userId, 'INBOX'))!.id);
		assert.equal(list2.total, 1, 'no DELE, so the message stays');
	} finally {
		await close();
	}
});

test('DELE removes the message when the session quits', async () => {
	const { store, port, userId, close } = await setupAccount();
	try {
		await addMessage(store, userId, 'Doomed', 'bye');
		const inbox = await store.findFolder(userId, 'INBOX');
		assert.ok(inbox);

		const client = await connectClient(port);
		await client.cmd('USER ok4rm');
		await client.cmd('PASS ');
		assert.match(await client.cmd('DELE 1'), /^\+OK/);
		assert.match(await client.cmd('RETR 1'), /^-ERR/);
		assert.match(await client.cmd('RSET'), /^\+OK/);
		assert.match((await client.multi('RETR 1')).first, /^\+OK/);
		assert.match(await client.cmd('DELE 1'), /^\+OK/);
		await client.cmd('QUIT');
		client.close();

		assert.equal((await store.listMessages(userId, inbox.id)).total, 0);
	} finally {
		await close();
	}
});

test('a password-protected account needs the right password', async () => {
	const { port, close } = await setupAccount({ password: 'hunter2' });
	try {
		const client = await connectClient(port);
		await client.cmd('USER ok4rm');
		assert.match(await client.cmd('PASS '), /^-ERR/);
		assert.match(await client.cmd('PASS wrong'), /^-ERR/);
		assert.match(await client.cmd('STAT'), /^-ERR/);
		assert.match(await client.cmd('PASS hunter2'), /^\+OK/);
		assert.match(await client.cmd('STAT'), /^\+OK/);
		await client.cmd('QUIT');
		client.close();
	} finally {
		await close();
	}
});

test('one maildrop per account: a second session is refused', async () => {
	const { port, close } = await setupAccount();
	try {
		const first = await connectClient(port);
		await first.cmd('USER ok4rm');
		assert.match(await first.cmd('PASS '), /^\+OK/);

		const second = await connectClient(port);
		await second.cmd('USER ok4rm');
		assert.match(await second.cmd('PASS '), /^-ERR \[IN-USE\]/);

		await first.cmd('QUIT');
		first.close();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const third = await connectClient(port);
		await third.cmd('USER ok4rm');
		assert.match(await third.cmd('PASS '), /^\+OK/);
		await third.cmd('QUIT');
		third.close();
	} finally {
		await close();
	}
});
