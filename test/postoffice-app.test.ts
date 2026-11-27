// The post office application's own records and its console API.
//
// Two things are being pinned here, and they are the two a reviewer would otherwise
// have to trust: that a client station's database never grows the post office's tables
// (so the two applications cannot half-share a schema), and that a mailbox and an
// administrator remain two principals — the first has no way to sign in and the second
// has no mailbox.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger, SESSION_COOKIE, Sessions } from '@rfmail/server';
import type { PostOffice, PostOfficeSnapshot } from '@rfmail/server';
import { PeerPolicy } from '@rfmail/mailservers';
import { TransceiverLinks } from '@rfmail/rig';
import { hashPassword, SqliteStore } from '@rfmail/store';
import { createPoApi } from '../apps/postoffice/src/api.ts';
import { fakeRigctld } from './helpers/fake-rigctld.ts';

const silent = createLogger('error', () => {});

/** The station, without a modem: the API's contract is what is under test here. */
class FakePostOffice {
	armed = false;
	modem: number | null = null;
	owner: string | null = null;
	frequency: number | null = null;

	snapshot(): PostOfficeSnapshot {
		return {
			armed: this.armed,
			busy: false,
			owner: this.owner,
			modemId: this.armed ? this.modem : null,
			modemName: this.armed ? 'fake modem' : null,
			frequencyHz: this.frequency,
			error: null,
			sessions: []
		};
	}

	get isArmed(): boolean {
		return this.armed;
	}

	get modemId(): number | null {
		return this.armed ? this.modem : null;
	}

	async arm(options: { owner: { callsign: string | null }; modem: { id: number }; frequencyHz: number }) {
		this.armed = true;
		this.modem = options.modem.id;
		this.owner = options.owner.callsign;
		this.frequency = options.frequencyHz;
		return this.snapshot();
	}

	async disarm(): Promise<PostOfficeSnapshot> {
		this.armed = false;
		this.frequency = null;
		return this.snapshot();
	}
}

async function harness(): Promise<{
	base: string;
	store: SqliteStore;
	postOffice: FakePostOffice;
	radio: TransceiverLinks;
	close: () => Promise<void>;
}> {
	const store = new SqliteStore({ path: ':memory:', postOffice: true });
	await store.migrate();
	const storeKey = Buffer.alloc(32, 9).toString('base64');
	const postOffice = new FakePostOffice();
	const radio = new TransceiverLinks();
	const api = createPoApi({
		store,
		sessions: new Sessions('postoffice-test-secret'),
		policy: new PeerPolicy('very strict'),
		logger: silent,
		storeKey,
		postOffice: postOffice as unknown as PostOffice,
		radio,
		uiDir: '/nonexistent-ui',
		secureCookies: false,
		appVersion: '0.0.0-test',
		seal: (plaintext) => `sealed:${plaintext}`
	});
	const server = createServer((req, res) => void api.handle(req, res));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${address.port}`,
		store,
		postOffice,
		radio,
		close: async () => {
			radio.closeAll();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await store.close();
		}
	};
}

interface Reply<T> {
	status: number;
	body: T;
	cookie: string;
}

async function call<T = Record<string, unknown>>(
	base: string,
	method: string,
	path: string,
	options: { body?: unknown; cookie?: string; csrf?: string } = {}
): Promise<Reply<T>> {
	const headers: Record<string, string> = { accept: 'application/json' };
	if (options.body !== undefined) headers['content-type'] = 'application/json';
	if (options.csrf) headers['x-csrf-token'] = options.csrf;
	if (options.cookie) headers.cookie = options.cookie;
	const response = await fetch(`${base}${path}`, {
		method,
		headers,
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
	});
	const text = await response.text();
	const setCookie = response.headers.getSetCookie();
	return {
		status: response.status,
		body: (text ? JSON.parse(text) : {}) as T,
		cookie: setCookie.find((entry) => entry.startsWith(`${SESSION_COOKIE}=`)) ?? ''
	};
}

/** Signs in and returns the cookie followed by the CSRF nonce the routes demand. */
async function signIn(base: string, name: string, password: string): Promise<{ cookie: string; csrf: string }> {
	const reply = await call<{ csrf: string }>(base, 'POST', '/api/login', { body: { name, password } });
	assert.equal(reply.status, 200);
	return { cookie: reply.cookie.split(';')[0] ?? '', csrf: reply.body.csrf };
}

async function setup(base: string): Promise<{ cookie: string; csrf: string }> {
	const reply = await call<{ csrf: string }>(base, 'POST', '/api/setup', {
		body: { callsign: 'OK4RM', name: 'sysop', password: 'correct horse battery', locator: 'JO70AA' }
	});
	assert.equal(reply.status, 201);
	return { cookie: reply.cookie.split(';')[0] ?? '', csrf: reply.body.csrf };
}

// -- the store's own side -----------------------------------------------------

test('a client database has no post office tables, a post office database has them', async () => {
	const client = new SqliteStore({ path: ':memory:' });
	await client.migrate();
	await assert.rejects(() => client.countAdministrators(), /no such table/i);
	await client.close();

	const postOffice = new SqliteStore({ path: ':memory:', postOffice: true });
	await postOffice.migrate();
	assert.equal(await postOffice.countAdministrators(), 0);
	assert.deepEqual(await postOffice.listCalls(), []);
	await postOffice.close();
});

test('administrators are names with a password, never callsigns', async () => {
	const store = new SqliteStore({ path: ':memory:', postOffice: true });
	await store.migrate();
	const admin = await store.createAdministrator({ name: 'Sys Op', pwHash: hashPassword('a good password') });
	assert.equal(admin.name, 'Sys Op');
	assert.equal(admin.canInspect, false);
	assert.equal(admin.enabled, true);

	// Matched without regard to case, the way a sign-in form asks.
	assert.equal((await store.findAdministrator('sys op'))?.id, admin.id);
	await assert.rejects(
		() => store.createAdministrator({ name: 'sys op', pwHash: hashPassword('another one') }),
		/UNIQUE/i
	);

	const changed = await store.updateAdministrator(admin.id, { canInspect: true, enabled: false });
	assert.equal(changed?.canInspect, true);
	assert.equal(changed?.enabled, false);
	assert.equal(await store.deleteAdministrator(admin.id), true);
	assert.equal(await store.getAdministrator(admin.id), null);
	await store.close();
});

test('the call log keeps who called and what happened, and nothing else', async () => {
	const store = new SqliteStore({ path: ':memory:', postOffice: true });
	await store.migrate();
	const first = await store.recordCall({
		peer: 'ok1raa',
		startedAt: 1_000,
		elapsedMs: 61_400,
		result: 'complete',
		sent: 2,
		received: 1
	});
	assert.equal(first.peer, 'OK1RAA');
	assert.equal(first.reason, null);
	await store.recordCall({
		peer: 'OK2XYZ',
		startedAt: 2_000,
		elapsedMs: 3_000,
		result: 'failed',
		sent: 0,
		received: 0,
		reason: 'the exchange did not end after 40 turns'
	});

	const calls = await store.listCalls();
	assert.equal(calls.length, 2);
	assert.equal(calls[0]?.peer, 'OK2XYZ', 'newest first');
	assert.equal(calls[0]?.reason, 'the exchange did not end after 40 turns');
	assert.equal((await store.listCalls(1)).length, 1);
	await store.close();
});

// -- the console's side ------------------------------------------------------

test('first start creates the station mailbox and one administrator, once', async () => {
	const app = await harness();
	try {
		const status = await call<{ state: string; callsign: string | null }>(app.base, 'GET', '/api/status');
		assert.equal(status.body.state, 'setup');
		assert.equal(status.body.callsign, null);

		await setup(app.base);
		const after = await call<{ state: string; callsign: string }>(app.base, 'GET', '/api/status');
		assert.equal(after.body.state, 'ready');
		assert.equal(after.body.callsign, 'OK4RM');

		// The station's own mailbox is a mailbox and the administrator is not.
		const mailboxes = await call<{ mailboxes: Array<{ callsign: string; isStation: boolean; hasPassword: boolean }> }>(
			app.base,
			'GET',
			'/api/mailboxes',
			{ cookie: (await signIn(app.base, 'sysop', 'correct horse battery')).cookie }
		);
		assert.equal(mailboxes.body.mailboxes.length, 1);
		assert.equal(mailboxes.body.mailboxes[0]?.callsign, 'OK4RM');
		assert.equal(mailboxes.body.mailboxes[0]?.isStation, true);
		assert.equal(mailboxes.body.mailboxes[0]?.hasPassword, false);

		const again = await call(app.base, 'POST', '/api/setup', {
			body: { callsign: 'OK1ABC', name: 'other', password: 'another good password' }
		});
		assert.equal(again.status, 409);
	} finally {
		await app.close();
	}
});

test('the sign-in route is uniform on the wire and refuses a disabled administrator', async () => {
	const app = await harness();
	try {
		await setup(app.base);
		const wrong = await call(app.base, 'POST', '/api/login', { body: { name: 'sysop', password: 'nope' } });
		const unknown = await call(app.base, 'POST', '/api/login', {
			body: { name: 'nobody', password: 'correct horse battery' }
		});
		assert.equal(wrong.status, 401);
		assert.equal(unknown.status, 401);
		assert.deepEqual(wrong.body, unknown.body, 'the refusal must not say which half was wrong');

		const admin = await app.store.findAdministrator('sysop');
		assert.ok(admin);
		await app.store.updateAdministrator(admin.id, { enabled: false });
		const disabled = await call(app.base, 'POST', '/api/login', {
			body: { name: 'sysop', password: 'correct horse battery' }
		});
		assert.equal(disabled.status, 401);
	} finally {
		await app.close();
	}
});

test('mailboxes are administered with the CSRF nonce and the station cannot delete itself', async () => {
	const app = await harness();
	try {
		await setup(app.base);
		const { cookie, csrf } = await signIn(app.base, 'sysop', 'correct horse battery');

		const noCsrf = await call(app.base, 'POST', '/api/mailboxes', {
			cookie,
			body: { callsign: 'OK1RAA' }
		});
		assert.equal(noCsrf.status, 403);

		const created = await call<{ id: number; callsign: string; hasPassword: boolean }>(
			app.base,
			'POST',
			'/api/mailboxes',
			{ cookie, csrf, body: { callsign: 'ok1raa', password: 'another good password' } }
		);
		assert.equal(created.status, 201);
		assert.equal(created.body.callsign, 'OK1RAA');
		assert.equal(created.body.hasPassword, true);

		// Sealed, never stored as written.
		const row = await app.store.getUser(created.body.id);
		assert.equal(row?.postOfficeSecret, 'sealed:another good password');
		assert.equal(row?.pwHash, null, 'a mailbox holds no browser password');

		const duplicate = await call(app.base, 'POST', '/api/mailboxes', {
			cookie,
			csrf,
			body: { callsign: 'OK1RAA' }
		});
		assert.equal(duplicate.status, 409);

		const station = (await app.store.findPostOfficeOwner())?.id ?? 0;
		const refusedDelete = await call(app.base, 'DELETE', `/api/mailboxes/${station}`, { cookie, csrf });
		assert.equal(refusedDelete.status, 409);

		const disabled = await call<{ enabled: boolean }>(app.base, 'PATCH', `/api/mailboxes/${created.body.id}`, {
			cookie,
			csrf,
			body: { enabled: false }
		});
		assert.equal(disabled.body.enabled, false);
	} finally {
		await app.close();
	}
});

test('an administrator cannot lock the station out of itself', async () => {
	const app = await harness();
	try {
		await setup(app.base);
		const { cookie, csrf } = await signIn(app.base, 'sysop', 'correct horse battery');
		const me = await call<{ administrator: { id: number } }>(app.base, 'GET', '/api/me', { cookie });
		const selfId = me.body.administrator.id;

		const second = await call<{ id: number; name: string }>(app.base, 'POST', '/api/admins', {
			cookie,
			csrf,
			body: { name: 'helper', password: 'another good password' }
		});
		assert.equal(second.status, 201);

		const disableSelf = await call(app.base, 'PATCH', `/api/admins/${selfId}`, {
			cookie,
			csrf,
			body: { enabled: false }
		});
		assert.equal(disableSelf.status, 409);
		const deleteSelf = await call(app.base, 'DELETE', `/api/admins/${selfId}`, { cookie, csrf });
		assert.equal(deleteSelf.status, 409);

		const inspect = await call<{ canInspect: boolean }>(app.base, 'PATCH', `/api/admins/${second.body.id}`, {
			cookie,
			csrf,
			body: { canInspect: true }
		});
		assert.equal(inspect.body.canInspect, true);
		assert.equal((await app.store.getAdministrator(second.body.id))?.canInspect, true);
	} finally {
		await app.close();
	}
});

test('the station arms one modem and reports it, and a modem in use cannot be removed', async () => {
	const app = await harness();
	const rig = await fakeRigctld();
	try {
		await setup(app.base);
		const { cookie, csrf } = await signIn(app.base, 'sysop', 'correct horse battery');

		const badKind = await call(app.base, 'POST', '/api/modems', {
			cookie,
			csrf,
			body: { kind: 'nonsense', host: '127.0.0.1' }
		});
		assert.equal(badKind.status, 400);

		const modem = await call<{ id: number; name: string; commandPort: number }>(app.base, 'POST', '/api/modems', {
			cookie,
			csrf,
			body: { kind: 'vara', host: '127.0.0.1' }
		});
		assert.equal(modem.status, 201);
		assert.equal(modem.body.commandPort, 8300, 'the vendor port fills in on the server');

		// No radio yet: arming would key a transmitter on whatever frequency it held.
		const noRadio = await call<{ fields?: Record<string, string> }>(app.base, 'POST', '/api/station/arm', {
			cookie,
			csrf,
			body: { modemId: modem.body.id, frequencyHz: 3_595_500 }
		});
		assert.equal(noRadio.status, 409);
		assert.equal(noRadio.body.fields?.['radio'], 'missing');

		const radio = await call<{ transceiver: { host: string } | null; link: { state: string; model: string } }>(
			app.base,
			'PUT',
			'/api/radio',
			{ cookie, csrf, body: { host: '127.0.0.1', port: rig.port, pttInput: 'rear' } }
		);
		assert.equal(radio.status, 200);
		assert.equal(radio.body.link.state, 'connected');
		assert.equal(radio.body.link.model, 'TS-590S', 'the radio names itself');

		// A dial is required, because an inbound call cannot be tuned for.
		const noDial = await call<{ fields?: Record<string, string> }>(app.base, 'POST', '/api/station/arm', {
			cookie,
			csrf,
			body: { modemId: modem.body.id }
		});
		assert.equal(noDial.status, 400);
		assert.equal(noDial.body.fields?.['frequencyHz'], 'required');

		const armed = await call<{ armed: boolean; modemId: number; callsign: string; frequencyHz: number }>(
			app.base,
			'POST',
			'/api/station/arm',
			{ cookie, csrf, body: { modemId: modem.body.id, frequencyHz: 3_595_500 } }
		);
		assert.equal(armed.status, 200);
		assert.equal(armed.body.armed, true);
		assert.equal(armed.body.modemId, modem.body.id);
		assert.equal(armed.body.callsign, 'OK4RM');
		assert.equal(armed.body.frequencyHz, 3_595_500);

		// The radio was tuned before the modem was armed, and in the modem's own mode.
		assert.ok(rig.received.includes('\\set_freq 3595500'), rig.received.join(' | '));
		assert.ok(rig.received.includes('\\set_mode PKTUSB -1'), rig.received.join(' | '));

		const twice = await call(app.base, 'POST', '/api/station/arm', {
			cookie,
			csrf,
			body: { modemId: modem.body.id, frequencyHz: 3_595_500 }
		});
		assert.equal(twice.status, 409);

		const removeArmed = await call(app.base, 'DELETE', `/api/modems/${modem.body.id}`, { cookie, csrf });
		assert.equal(removeArmed.status, 409);

		const disarmed = await call<{ armed: boolean }>(app.base, 'POST', '/api/station/disarm', { cookie, csrf });
		assert.equal(disarmed.body.armed, false);
		const removed = await call(app.base, 'DELETE', `/api/modems/${modem.body.id}`, { cookie, csrf });
		assert.equal(removed.status, 200);
	} finally {
		await rig.close();
		await app.close();
	}
});

test('a radio link that is down refuses arming instead of keying into the dark', async () => {
	const app = await harness();
	try {
		await setup(app.base);
		const { cookie, csrf } = await signIn(app.base, 'sysop', 'correct horse battery');
		const modem = await call<{ id: number }>(app.base, 'POST', '/api/modems', {
			cookie,
			csrf,
			body: { kind: 'vara', host: '127.0.0.1' }
		});

		// A closed loopback port: instant, local, and never the station's own hardware.
		const radio = await call<{ link: { state: string; error: string } }>(app.base, 'PUT', '/api/radio', {
			cookie,
			csrf,
			body: { host: '127.0.0.1', port: 1 }
		});
		assert.equal(radio.status, 200);
		assert.equal(radio.body.link.state, 'error');

		const arm = await call<{ error: string; fields?: Record<string, string> }>(
			app.base,
			'POST',
			'/api/station/arm',
			{ cookie, csrf, body: { modemId: modem.body.id, frequencyHz: 3_595_500 } }
		);
		assert.equal(arm.status, 409);
		assert.equal(arm.body.fields?.['radio'], 'down');
		assert.match(arm.body.error, /the radio link is down/);

		// The radio cannot be removed while the station is answering with it.
		const radioRow = await call<{ transceiver: { id: number } }>(app.base, 'GET', '/api/radio', { cookie });
		assert.equal(radioRow.status, 200);
		const removed = await call(app.base, 'DELETE', '/api/radio', { cookie, csrf });
		assert.equal(removed.status, 200, 'no call is up, so removing it is allowed');
	} finally {
		await app.close();
	}
});

test('nothing but the status page answers without a session', async () => {
	const app = await harness();
	try {
		for (const path of ['/api/me', '/api/mailboxes', '/api/admins', '/api/station', '/api/calls', '/api/modems']) {
			const reply = await call(app.base, 'GET', path);
			assert.equal(reply.status, 401, path);
		}
		const status = await call(app.base, 'GET', '/api/status');
		assert.equal(status.status, 200);
	} finally {
		await app.close();
	}
});
