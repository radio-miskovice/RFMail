import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createServer as createServer2 } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createApi, createLogger, Sessions } from '@rfmail/server';
import { TransceiverLinks } from '@rfmail/rig';
import { MailEvents, PeerPolicy } from '@rfmail/mailservers';
import { SqliteStore } from '@rfmail/store';
import type {
	Me,
	MessageDetail,
	MessageListResponse,
	Modem,
	StatusResponse,
	Transceiver,
	User
} from '@rfmail/shared';

const silent = createLogger('error', () => {});

async function harness(): Promise<{
	base: string;
	store: SqliteStore;
	close: () => Promise<void>;
}> {
	const store = new SqliteStore({ path: ':memory:' });
	await store.migrate();
	const api = createApi({
		store,
		sessions: new Sessions('test-secret-value'),
		policy: new PeerPolicy('very strict'),
		logger: silent,
		events: new MailEvents(),
		uiDir: '/nonexistent-ui',
		accessMode: 'very strict (loopback only)',
		pop3Address: null,
		smtpAddress: null,
		imapAddress: null,
		secureCookies: false,
		storeKey: Buffer.alloc(32, 7).toString('base64'),
		links: new TransceiverLinks(),
	});
	const server = createServer((req, res) => void api.handle(req, res));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${address.port}`,
		store,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await store.close();
		},
	};
}

function cookieFrom(response: Response): string {
	const cookies = response.headers.getSetCookie();
	assert.ok(cookies.length > 0, 'expected a session cookie');
	return cookies[0]?.split(';')[0] ?? '';
}

test('first-run setup, login, compose and delete over HTTP', async () => {
	const { base, store, close } = await harness();
	try {
		const status = (await (await fetch(`${base}/api/status`)).json()) as StatusResponse;
		assert.equal(status.state, 'setup');

		const setupResponse = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'tester' }),
		});
		assert.equal(setupResponse.status, 201);
		const me = (await setupResponse.json()) as Me;
		assert.equal(me.user.login, 'tester');
		assert.equal(me.user.hasPassword, false);
		assert.equal(me.folders.length, 5);
		const cookie = cookieFrom(setupResponse);
		const csrf = me.csrf;

		const secondSetup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'intruder' }),
		});
		assert.equal(secondSetup.status, 409);

		const meResponse = await fetch(`${base}/api/me`, { headers: { cookie } });
		assert.equal(meResponse.status, 200);

		const withoutCsrf = await fetch(`${base}/api/messages`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ to: 'LA5NTA', subject: 's', body: 'b' }),
		});
		assert.equal(withoutCsrf.status, 403, 'state-changing requests need the CSRF token');

		const compose = await fetch(`${base}/api/messages`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
			body: JSON.stringify({ to: 'LA5NTA@winlink.org', subject: 'Hello', body: 'Stored.' }),
		});
		assert.equal(compose.status, 201);
		const created = (await compose.json()) as MessageDetail;
		assert.equal(created.direction, 'out');
		assert.equal(created.subject, 'Hello');

		const outbox = me.folders.find((folder) => folder.kind === 'outbox');
		assert.ok(outbox);
		const list = (await (
			await fetch(`${base}/api/folders/${outbox.id}/messages`, { headers: { cookie } })
		).json()) as MessageListResponse;
		assert.equal(list.total, 1);

		const patched = await fetch(`${base}/api/messages/${created.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
			body: JSON.stringify({ flagged: true }),
		});
		assert.equal(patched.status, 200);
		assert.equal(((await patched.json()) as MessageDetail).flagged, true);

		const firstDelete = await fetch(`${base}/api/messages/${created.id}`, {
			method: 'DELETE',
			headers: { cookie, 'x-csrf-token': csrf },
		});
		assert.deepEqual(await firstDelete.json(), { ok: true, movedToTrash: true });

		const secondDelete = await fetch(`${base}/api/messages/${created.id}`, {
			method: 'DELETE',
			headers: { cookie, 'x-csrf-token': csrf },
		});
		assert.deepEqual(await secondDelete.json(), { ok: true, movedToTrash: false });

		const missing = await fetch(`${base}/api/messages/${created.id}`, { headers: { cookie } });
		assert.equal(missing.status, 404);

		// Unauthenticated access to the mailbox is refused.
		const anonymous = await fetch(`${base}/api/folders`);
		assert.equal(anonymous.status, 401);

		assert.equal(await store.countUsers(), 1);
	} finally {
		await close();
	}
});

test('login with a wrong name is refused and login requires a password once set', async () => {
	const { base, store, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'tester' }),
		});
		assert.equal(setup.status, 201);

		const badLogin = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'nobody' }),
		});
		assert.equal(badLogin.status, 401);

		const user = await store.findUserByLogin('tester');
		assert.ok(user);
		const { hashPassword } = await import('@rfmail/store');
		await store.setUserPassword(user.id, hashPassword('s3cret'));

		const needsPassword = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'tester' }),
		});
		assert.equal(needsPassword.status, 401);
		const body = (await needsPassword.json()) as { passwordRequired?: boolean };
		assert.equal(body.passwordRequired, true);

		const withPassword = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'tester', password: 's3cret' }),
		});
		assert.equal(withPassword.status, 200);
	} finally {
		await close();
	}
});

test('administrators create accounts; accounts manage their own password', async () => {
	const { base, store, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'admin' }),
		});
		assert.equal(setup.status, 201);
		const me = (await setup.json()) as Me;
		const cookie = cookieFrom(setup);
		const csrf = me.csrf;
		const auth = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

		const created = await fetch(`${base}/api/users`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ login: 'operator', callsign: 'ok1abc', role: 'user' }),
		});
		assert.equal(created.status, 201);
		const operator = (await created.json()) as User;
		assert.equal(operator.callsign, 'OK1ABC', 'the callsign is upper-cased');
		assert.equal(operator.hasPassword, false);

		const list = (await (await fetch(`${base}/api/users`, { headers: { cookie } })).json()) as User[];
		assert.deepEqual(list.map((user) => user.login).sort(), ['admin', 'operator']);

		const renamed = await fetch(`${base}/api/users/${operator.id}`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ role: 'admin', enabled: false }),
		});
		assert.equal(renamed.status, 200);
		const updated = (await renamed.json()) as User;
		assert.equal(updated.role, 'admin');
		assert.equal(updated.enabled, false);

		// A refused password change: wrong current password.
		const wrong = await fetch(`${base}/api/account/password`, {
			method: 'POST',
			headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
			body: JSON.stringify({ password: 'first-secret' }),
		});
		assert.equal(wrong.status, 200, 'no password yet, so no current password is needed');

		const badCurrent = await fetch(`${base}/api/account/password`, {
			method: 'POST',
			headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
			body: JSON.stringify({ currentPassword: 'nope', password: 'second-secret' }),
		});
		assert.equal(badCurrent.status, 403);

		const goodCurrent = await fetch(`${base}/api/account/password`, {
			method: 'POST',
			headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
			body: JSON.stringify({ currentPassword: 'first-secret', password: 'second-secret' }),
		});
		assert.equal(goodCurrent.status, 200);

		const relogin = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'admin', password: 'second-secret' }),
		});
		assert.equal(relogin.status, 200);

		// Guards: cannot delete yourself, cannot delete the last admin.
		const selfDelete = await fetch(`${base}/api/users/${me.user.id}`, {
			method: 'DELETE',
			headers: { cookie, 'x-csrf-token': csrf },
		});
		assert.equal(selfDelete.status, 400);

		// The other account is an admin now but disabled, so it is not the last admin.
		const removeOperator = await fetch(`${base}/api/users/${operator.id}`, {
			method: 'DELETE',
			headers: { cookie, 'x-csrf-token': csrf },
		});
		assert.equal(removeOperator.status, 200);
		assert.equal(await store.countUsers(), 1);

		const anonymous = await fetch(`${base}/api/users`);
		assert.equal(anonymous.status, 401);
	} finally {
		await close();
	}
});

test('the Winlink password is stored sealed and never handed back', async () => {
	const { base, store, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'admin' }),
		});
		const me = (await setup.json()) as Me;
		const cookie = cookieFrom(setup);
		const auth = { cookie, 'x-csrf-token': me.csrf, 'content-type': 'application/json' };

		// No callsign yet: the credential has nowhere to live.
		const tooEarly = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ winlinkPassword: 'cms-secret' }),
		});
		assert.equal(tooEarly.status, 400);

		const saved = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ callsign: 'ok1abc', winlinkPassword: 'cms-secret' }),
		});
		assert.equal(saved.status, 200);
		const savedText = await saved.text();
		assert.ok(!savedText.includes('cms-secret'), 'the password must not come back in the response');
		const updated = (JSON.parse(savedText) as Me).user;
		assert.equal(updated.hasWinlinkPassword, true);
		assert.equal(updated.callsign, 'OK1ABC');
		assert.equal(updated.hasPassword, false, 'the mail password is a different setting');

		const sealed = await store.getWinlinkSecret(me.user.id);
		assert.ok(sealed);
		assert.match(sealed, /^v1\./, 'stored sealed, not in the clear');
		assert.ok(!sealed.includes('cms-secret'));

		// A second save that does not mention the password leaves it alone.
		const again = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ callsign: 'OK1ABC' }),
		});
		assert.equal(((await again.json()) as Me).user.hasWinlinkPassword, true);

		// A different callsign is a different Winlink registration, so the stored
		// password must not follow it.
		const renamed = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ callsign: 'OK1ABC-10' }),
		});
		const renamedUser = ((await renamed.json()) as Me).user;
		assert.equal(renamedUser.callsign, 'OK1ABC-10');
		assert.equal(renamedUser.hasWinlinkPassword, false, 'the credential belonged to the old callsign');

		// Another account cannot take a callsign that is already in use.
		const clash = await fetch(`${base}/api/users`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ login: 'intruder', callsign: 'OK1ABC-10' }),
		});
		assert.equal(clash.status, 409);

		// Clearing it removes the row's value.
		const cleared = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ winlinkPassword: null }),
		});
		assert.equal(((await cleared.json()) as Me).user.hasWinlinkPassword, false);
		assert.equal(await store.getWinlinkSecret(me.user.id), null);

		// Another account cannot see or change this one's station settings.
		const outsider = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ winlinkPassword: 'x' }),
		});
		assert.equal(outsider.status, 401);
	} finally {
		await close();
	}
});

test('transceivers are configured, listed and their link reports a state', async () => {
	// A rigctld that answers the extended protocol, so the connect route can be
	// exercised end to end without a radio.
	const rigSockets = new Set<import('node:net').Socket>();
	const rigServer = createServer2((socket) => {
		rigSockets.add(socket);
		socket.on('close', () => rigSockets.delete(socket));
		let buffer = '';
		socket.on('data', (chunk) => {
			buffer += chunk.toString('latin1');
			for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line === '+\\get_freq') socket.write('get_freq:\nFrequency: 3597000\nRPRT 0\n');
				else if (line === '+\\get_mode') socket.write('get_mode:\nMode: PKTUSB\nPassband: 2000\nRPRT 0\n');
				else if (line === '+\\get_ptt') socket.write('get_ptt:\nPTT: 0\nRPRT 0\n');
				else socket.write('RPRT 0\n');
			}
		});
	});
	await new Promise<void>((resolve) => rigServer.listen(0, '127.0.0.1', () => resolve()));
	const rigPort = (rigServer.address() as AddressInfo).port;

	const { base, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'admin' }),
		});
		const me = (await setup.json()) as Me;
		const cookie = cookieFrom(setup);
		const auth = { cookie, 'x-csrf-token': me.csrf, 'content-type': 'application/json' };

		const created = await fetch(`${base}/api/transceivers`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ name: 'TS-590SG', host: '127.0.0.1', port: rigPort, pttInput: 'rear' }),
		});
		assert.equal(created.status, 201);
		const transceiver = (await created.json()) as Transceiver;
		assert.equal(transceiver.pttInput, 'rear');
		assert.equal(transceiver.link.state, 'disconnected', 'configuration says nothing about a link');

		// A second transceiver with the same name is refused.
		const duplicate = await fetch(`${base}/api/transceivers`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ name: 'ts-590sg', host: '127.0.0.1' }),
		});
		assert.equal(duplicate.status, 409);

		// Connect: the link goes green and reports the radio's state.
		const connected = await fetch(`${base}/api/transceivers/${transceiver.id}/connect`, {
			method: 'POST',
			headers: auth,
		});
		assert.equal(connected.status, 200);
		const live = (await connected.json()) as { transceiver: Transceiver };
		assert.equal(live.transceiver.link.state, 'connected');
		assert.equal(live.transceiver.link.frequencyHz, 3_597_000);
		assert.equal(live.transceiver.link.mode, 'PKTUSB');

		const listed = (await (await fetch(`${base}/api/transceivers`, { headers: { cookie } })).json()) as Transceiver[];
		assert.equal(listed[0]?.link.state, 'connected');

		// Disconnect returns it to grey.
		await fetch(`${base}/api/transceivers/${transceiver.id}/disconnect`, { method: 'POST', headers: auth });
		const afterDisconnect = (await (await fetch(`${base}/api/transceivers`, { headers: { cookie } })).json()) as Transceiver[];
		assert.equal(afterDisconnect[0]?.link.state, 'disconnected');

		// A transceiver pointing nowhere goes red with the reason, not green.
		const broken = await fetch(`${base}/api/transceivers`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ name: 'NoSuchRadio', host: '127.0.0.1', port: 1, timeoutMs: 500 }),
		});
		const brokenTransceiver = (await broken.json()) as Transceiver;
		const failed = await fetch(`${base}/api/transceivers/${brokenTransceiver.id}/connect`, {
			method: 'POST',
			headers: auth,
		});
		assert.equal(failed.status, 502);
		const failedBody = (await failed.json()) as { transceiver: Transceiver; error: string };
		assert.equal(failedBody.transceiver.link.state, 'error');
		assert.ok(failedBody.error.length > 0);

		// Deleting forgets the link too.
		const removed = await fetch(`${base}/api/transceivers/${brokenTransceiver.id}`, {
			method: 'DELETE',
			headers: { cookie, 'x-csrf-token': me.csrf },
		});
		assert.equal(removed.status, 200);
		assert.equal(
			((await (await fetch(`${base}/api/transceivers`, { headers: { cookie } })).json()) as Transceiver[]).length,
			1,
		);
	} finally {
		await close();
		for (const socket of rigSockets) socket.destroy();
		await new Promise<void>((resolve) => rigServer.close(() => resolve()));
	}
});

test('modems are configured, edited and removed, and must name a real transceiver', async () => {
	const { base, store, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'owner' }),
		});
		const owner = (await setup.json()) as Me;
		const headers = { cookie: cookieFrom(setup), 'x-csrf-token': owner.csrf, 'content-type': 'application/json' };

		const radio = await fetch(`${base}/api/transceivers`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ name: 'Bench', host: '127.0.0.1', port: 4532 }),
		});
		assert.equal(radio.status, 201);
		const transceiver = (await radio.json()) as Transceiver;

		// VARA HF: commands on 8300, data on 8301, PKTUSB, wired to the bench radio.
		const created = await fetch(`${base}/api/modems`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				name: 'VARA 40m',
				kind: 'vara',
				host: '127.0.0.1',
				commandPort: 8300,
				dataPort: 8301,
				rigMode: 'pktusb',
				transceiverId: transceiver.id,
			}),
		});
		const createdText = await created.text();
		assert.equal(created.status, 201, createdText);
		const modem = JSON.parse(createdText) as Modem;
		assert.equal(modem.kind, 'vara');
		assert.equal(modem.commandPort, 8300);
		assert.equal(modem.dataPort, 8301);
		assert.equal(modem.kissPort, null, 'VARA FM/HF have no KISS port');
		assert.equal(modem.rigMode, 'PKTUSB', 'the mode is stored upper case');
		assert.equal(modem.transceiverId, transceiver.id);

		// List, then edit: switching to ARDOP keeps one port only.
		const listed = await fetch(`${base}/api/modems`, { headers: { cookie: headers.cookie } });
		assert.equal(((await listed.json()) as Modem[]).length, 1);

		const patched = await fetch(`${base}/api/modems/${modem.id}`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({ kind: 'ardop', commandPort: 8515, dataPort: null, name: 'ARDOP 40m' }),
		});
		assert.equal(patched.status, 200);
		const edited = (await patched.json()) as Modem;
		assert.equal(edited.kind, 'ardop');
		assert.equal(edited.commandPort, 8515);
		assert.equal(edited.dataPort, null);

		// A modem that names a radio nobody configured cannot be started, so it is refused.
		const ghost = await fetch(`${base}/api/modems`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ name: 'Ghost', kind: 'vara', host: '127.0.0.1', transceiverId: 999 }),
		});
		assert.equal(ghost.status, 400);
		assert.equal(((await ghost.json()) as { fields?: { transceiverId?: string } }).fields?.transceiverId, 'invalid');

		// A port that is not a port is refused, and so is an unknown modem type.
		for (const body of [
			{ name: 'Bad port', kind: 'vara', host: '127.0.0.1', commandPort: 70000 },
			{ name: 'Bad kind', kind: 'winmor', host: '127.0.0.1' },
			{ name: 'Bad mode', kind: 'vara', host: '127.0.0.1', rigMode: 'SSB' }
		]) {
			const refused = await fetch(`${base}/api/modems`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			});
			assert.equal(refused.status, 400, JSON.stringify(body));
		}

		// Deleting drops it; the transceiver stays.
		const removed = await fetch(`${base}/api/modems/${modem.id}`, { method: 'DELETE', headers });
		assert.equal(removed.status, 200);
		const after = await fetch(`${base}/api/modems`, { headers: { cookie: headers.cookie } });
		assert.equal(((await after.json()) as Modem[]).length, 0);
		assert.equal((await store.listTransceivers()).length, 1);
	} finally {
		await close();
	}
});

test('the WW-locator is set when an account is created, edited, and by its owner', async () => {
	const { base, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'owner' }),
		});
		const owner = (await setup.json()) as Me;
		const headers = { cookie: cookieFrom(setup), 'x-csrf-token': owner.csrf, 'content-type': 'application/json' };

		// At creation, for a club callsign that works from a different place.
		const created = await fetch(`${base}/api/users`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ login: 'club', callsign: 'OK9ZZZ', locator: 'jo70aa' }),
		});
		assert.equal(created.status, 201);
		const club = (await created.json()) as User;
		assert.equal(club.locator, 'JO70AA', 'stored upper case');

		// Edited afterwards.
		const patched = await fetch(`${base}/api/users/${club.id}`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({ locator: 'JN79' }),
		});
		assert.equal(patched.status, 200);
		assert.equal(((await patched.json()) as User).locator, 'JN79');

		// A grid square that is not one is refused, not silently dropped.
		const bad = await fetch(`${base}/api/users/${club.id}`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({ locator: 'Prague' }),
		});
		assert.equal(bad.status, 400);
		assert.equal(((await bad.json()) as { fields?: { locator?: string } }).fields?.locator, 'invalid');

		// And the owner can set their own.
		const mine = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({ locator: 'JO70AA' }),
		});
		assert.equal(mine.status, 200);
		assert.equal(((await mine.json()) as Me).user.locator, 'JO70AA');

		// Clearing works too.
		const cleared = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({ locator: null }),
		});
		assert.equal(((await cleared.json()) as Me).user.locator, null);
	} finally {
		await close();
	}
});

test('an account without a password takes an empty password and nothing else', async () => {
	const { base, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'nopassword' }),
		});
		assert.equal(setup.status, 201, 'the first account starts without a password');
		const me = (await setup.json()) as Me;
		assert.equal(me.user.hasPassword, false);

		// Empty: accepted.
		const empty = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'nopassword' }),
		});
		assert.equal(empty.status, 200);

		// Any invented password: refused, because "no password" must not mean "any
		// password" on an instance other machines can reach.
		const invented = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'nopassword', password: 'anything' }),
		});
		assert.equal(invented.status, 401);
	} finally {
		await close();
	}
});

test('an ordinary account configures the station radios without an administrator', async () => {
	const { base, store, close } = await harness();
	try {
		// The first account, then a plain "user" account created by it.
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'owner' }),
		});
		const owner = (await setup.json()) as Me;
		const ownerHeaders = { cookie: cookieFrom(setup), 'x-csrf-token': owner.csrf, 'content-type': 'application/json' };

		await fetch(`${base}/api/users`, {
			method: 'POST',
			headers: ownerHeaders,
			body: JSON.stringify({ login: 'operator', role: 'user', password: 'hunter2' }),
		});

		const login = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ login: 'operator', password: 'hunter2' }),
		});
		assert.equal(login.status, 200);
		const me = (await login.json()) as Me;
		assert.equal(me.user.role, 'user');
		const asUser = { cookie: cookieFrom(login), 'x-csrf-token': me.csrf, 'content-type': 'application/json' };

		// Create, edit, connect-attempt and delete: all of it, without the role.
		const created = await fetch(`${base}/api/transceivers`, {
			method: 'POST',
			headers: asUser,
			body: JSON.stringify({ name: 'Bench', host: '127.0.0.1', port: 1, timeoutMs: 500 }),
		});
		const createdText = await created.text();
		assert.equal(created.status, 201, createdText);
		const radio = JSON.parse(createdText) as Transceiver;

		const patched = await fetch(`${base}/api/transceivers/${radio.id}`, {
			method: 'PATCH',
			headers: asUser,
			body: JSON.stringify({ pttInput: 'front' }),
		});
		assert.equal(patched.status, 200);
		assert.equal(((await patched.json()) as Transceiver).pttInput, 'front');

		const connect = await fetch(`${base}/api/transceivers/${radio.id}/connect`, {
			method: 'POST',
			headers: asUser,
		});
		assert.equal(connect.status, 502, 'unreachable, so red — but allowed');

		const removed = await fetch(`${base}/api/transceivers/${radio.id}`, {
			method: 'DELETE',
			headers: asUser,
		});
		assert.equal(removed.status, 200);
		assert.equal((await store.listTransceivers()).length, 0);

		// Account administration is still the owner's: a plain user cannot create accounts.
		const forbidden = await fetch(`${base}/api/users`, {
			method: 'POST',
			headers: asUser,
			body: JSON.stringify({ login: 'intruder' }),
		});
		assert.equal(forbidden.status, 403);
	} finally {
		await close();
	}
});
