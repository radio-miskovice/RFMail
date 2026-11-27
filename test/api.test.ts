import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createServer as createServer2, connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createApi, createLogger, openSecret, PostOffice, SESSION_COOKIE, Sessions } from '@rfmail/server';
import { TransceiverLinks } from '@rfmail/rig';
import { MailEvents, MailInterfaces, PeerPolicy } from '@rfmail/mailservers';
import type { MailInterfaceName } from '@rfmail/mailservers';
import { SqliteStore } from '@rfmail/store';
import type {
	Me,
	MailInterfacesResponse,
	MessageDetail,
	MessageListResponse,
	Modem,
	ModemStatusResponse,
	NetworkAccess,
	RadioStatus,
	SessionRunResponse,
	SessionTargetsResponse,
	StatusResponse,
	Transceiver,
	User
} from '@rfmail/shared';
import { ScriptedModem, outboundMessage } from './helpers/scripted-gateway.ts';

const silent = createLogger('error', () => {});

async function harness(
	specs: Partial<Record<MailInterfaceName, { host: string; port: number }>> = {},
	httpListen = '127.0.0.1:0',
	postOffice = false,
): Promise<{
	base: string;
	store: SqliteStore;
	mailInterfaces: MailInterfaces;
	close: () => Promise<void>;
}> {
	const store = new SqliteStore({ path: ':memory:' });
	await store.migrate();
	const storeKey = Buffer.alloc(32, 7).toString('base64');
	const policy = new PeerPolicy('very strict');
	const events = new MailEvents();
	// A station with a post office owner runs the mail access servers; a Winlink client
	// listens on none of them. The harness starts them the way the backend does.
	if (postOffice) {
		const owner = await store.createUser({ callsign: 'OK1OWN', pwHash: null, role: 'admin' });
		await store.setPostOfficeOwner(owner.id);
	}
	const mailInterfaces = new MailInterfaces({ store, policy, events, logger: silent, specs });
	if (postOffice) await mailInterfaces.startAll();
	const api = createApi({
		store,
		sessions: new Sessions('test-secret-value'),
		policy,
		logger: silent,
		events,
		uiDir: '/nonexistent-ui',
		httpListen,
		mailInterfaces,
		secureCookies: false,
		storeKey: storeKey,
		links: new TransceiverLinks(),
		postOffice: new PostOffice({
			store,
			logger: silent,
			openSecret: (blob) => openSecret(blob, storeKey),
		}),
	});
	const server = createServer((req, res) => void api.handle(req, res));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${address.port}`,
		store,
		mailInterfaces,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await mailInterfaces.closeAll();
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
			body: JSON.stringify({ callsign: 'OK1ABC' }),
		});
		assert.equal(setupResponse.status, 201);
		const me = (await setupResponse.json()) as Me;
		assert.equal(me.user.callsign, 'OK1ABC', 'the callsign is the account and the login');
		assert.equal(me.user.hasPassword, false);
		assert.equal(me.folders.length, 5);
		const cookie = cookieFrom(setupResponse);
		const csrf = me.csrf;

		const secondSetup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK9XXX' }),
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
			body: JSON.stringify({ callsign: 'OK1ABC' }),
		});
		assert.equal(setup.status, 201);

		const badLogin = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK8UNK' }),
		});
		assert.equal(badLogin.status, 401);

		const user = await store.findUserByLogin('OK1ABC');
		assert.ok(user);
		const { hashPassword } = await import('@rfmail/store');
		await store.setUserPassword(user.id, hashPassword('s3cret'));

		const needsPassword = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1ABC' }),
		});
		assert.equal(needsPassword.status, 401);
		const body = (await needsPassword.json()) as { passwordRequired?: boolean };
		assert.equal(body.passwordRequired, true);

		const withPassword = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1ABC', password: 's3cret' }),
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
			body: JSON.stringify({ callsign: 'OK1ADM' }),
		});
		assert.equal(setup.status, 201);
		const me = (await setup.json()) as Me;
		const cookie = cookieFrom(setup);
		const csrf = me.csrf;
		const auth = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

		const created = await fetch(`${base}/api/users`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ callsign: 'OK4RM', role: 'user' }),
		});
		assert.equal(created.status, 201);
		const operator = (await created.json()) as User;
		assert.equal(operator.callsign, 'OK4RM', 'the callsign is upper-cased');
		assert.equal(operator.hasPassword, false);

		const list = (await (await fetch(`${base}/api/users`, { headers: { cookie } })).json()) as User[];
		assert.deepEqual(list.map((user) => user.callsign).sort(), ['OK1ADM', 'OK4RM']);

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
			body: JSON.stringify({ callsign: 'OK1ADM', password: 'second-secret' }),
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
			body: JSON.stringify({ callsign: 'OK1ADM' }),
		});
		const me = (await setup.json()) as Me;
		const cookie = cookieFrom(setup);
		const auth = { cookie, 'x-csrf-token': me.csrf, 'content-type': 'application/json' };
		assert.equal(me.user.callsign, 'OK1ADM');
		assert.equal('login' in me.user, false, 'one name for one account: the DTO carries the callsign only');

		// Without a callsign the credential has nowhere to live. An account is born
		// with one now, so this is the pre-migration row: clear it to reach the case.
		await store.setCallsign(me.user.id, null);
		const tooEarly = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ winlinkPassword: 'cms-secret' }),
		});
		assert.equal(tooEarly.status, 400);

		const saved = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ callsign: 'OK4RM', winlinkPassword: 'cms-secret' }),
		});
		assert.equal(saved.status, 200);
		const savedText = await saved.text();
		assert.ok(!savedText.includes('cms-secret'), 'the password must not come back in the response');
		const updated = (JSON.parse(savedText) as Me).user;
		assert.equal(updated.hasWinlinkPassword, true);
		assert.equal(updated.callsign, 'OK4RM');
		assert.equal(updated.hasPassword, false, 'the mail password is a different setting');

		const sealed = await store.getWinlinkSecret(me.user.id);
		assert.ok(sealed);
		assert.match(sealed, /^v1\./, 'stored sealed, not in the clear');
		assert.ok(!sealed.includes('cms-secret'));

		// A second save that does not mention the password leaves it alone.
		const again = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ callsign: 'OK4RM' }),
		});
		assert.equal(((await again.json()) as Me).user.hasWinlinkPassword, true);

		// A different callsign is a different Winlink registration, so the stored
		// password must not follow it.
		const renamed = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ callsign: 'OK4RM-10' }),
		});
		const renamedUser = ((await renamed.json()) as Me).user;
		assert.equal(renamedUser.callsign, 'OK4RM-10');
		assert.equal(renamedUser.hasWinlinkPassword, false, 'the credential belonged to the old callsign');

		// Another account cannot take a callsign that is already in use.
		const clash = await fetch(`${base}/api/users`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ callsign: 'OK4RM-10' }),
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
	// A rigctld that answers the extended protocol and the `\get_rig_info` block, so the
	// connect route can be exercised end to end without a radio.
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
				if (line === '\\get_rig_info')
					socket.write(
						[
							'VFO=VFOA Freq=3597000 Mode=PKTUSB Width=2000 RX=1 TX=1',
							'VFO=VFOB Freq=0 Mode=None Width=0 RX=0 TX=0',
							'Split=0 SatMode=0',
							'Rig=TS-590S',
							'App=Hamlib',
							'Version=20241103 1.1.0',
							'Model=2031',
							'CRC=0x269e8082',
							'',
						].join('\n') + '\n',
					);
				else if (line === '+\\dump_caps')
					socket.write(
						[
							'dump_caps:',
							'Model name:	TS-590S',
							'Mfg name:	Kenwood',
							'Port type:	RS-232',
							'Serial speed:	4800..115200 baud, 8N1, ctrl=CTS/RTS',
							'Hamlib version:	Hamlib 4.6.3',
							'RPRT 0',
						].join('\n') + '\n',
					);
				else if (line === '+\\get_level RFPOWER') socket.write('get_level: RFPOWER\n0.35\nRPRT 0\n');
				else if (line === 'w SH;') socket.write('SH05;\n');
				else if (line === 'w SL;') socket.write('SL13;\n');
				else if (line === '+\\get_freq') socket.write('get_freq:\nFrequency: 3597000\nRPRT 0\n');
				else if (line === '+\\get_mode') socket.write('get_mode:\nMode: PKTUSB\nPassband: 2000\nRPRT 0\n');
				else if (line === '+\\get_ptt') socket.write('get_ptt:\nPTT: 0\nRPRT 0\n');
				else if (line === 'w SH;') socket.write('SH05;\0');
				else if (line === 'w SL;') socket.write('SL13;\0');
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
			body: JSON.stringify({ callsign: 'OK1ADM' }),
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

test('interfaces are configured one by one, and rigctld describes the radio behind each', async () => {
	// rigctld as the TS-590S answers it: the `\get_rig_info` block, the power level, and a
	// rig that takes a level. The Radio screen shows all of it, so all of it is exercised.
	const sockets = new Set<import('node:net').Socket>();
	let power = 0.35;
	const rigServer = createServer2((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		let buffer = '';
		socket.on('data', (chunk) => {
			buffer += chunk.toString('latin1');
			for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line === '\\get_rig_info')
					socket.write(
						[
							'VFO=VFOA Freq=3597000 Mode=PKTUSB Width=2000 RX=1 TX=1',
							'VFO=VFOB Freq=0 Mode=None Width=0 RX=0 TX=0',
							'Split=0 SatMode=0',
							'Rig=TS-590S',
							'App=Hamlib',
							'Version=20241103 1.1.0',
							'Model=2031',
							'CRC=0x269e8082',
							'',
						].join('\n') + '\n',
					);
				else if (line === '+\\dump_caps')
					socket.write(
						[
							'dump_caps:',
							'Model name:	TS-590S',
							'Mfg name:	Kenwood',
							'Port type:	RS-232',
							'Serial speed:	4800..115200 baud, 8N1, ctrl=CTS/RTS',
							'Hamlib version:	Hamlib 4.6.3',
							'RPRT 0',
						].join('\n') + '\n',
					);
				else if (line === '+\\get_level RFPOWER') socket.write(`get_level: RFPOWER\n${power}\nRPRT 0\n`);
				else if (line === 'w SH;') socket.write('SH05;\n');
				else if (line === 'w SL;') socket.write('SL13;\n');
				else if (line.startsWith('\\set_level RFPOWER')) {
					power = Number(line.split(/\s+/)[2] ?? power);
					socket.write('RPRT 0\n');
				} else if (line === '+\\get_ptt') socket.write('get_ptt:\nPTT: 0\nRPRT 0\n');
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
			body: JSON.stringify({ callsign: 'OK1RIG' }),
		});
		const me = (await setup.json()) as Me;
		const cookie = cookieFrom(setup);
		const auth = { cookie, 'x-csrf-token': me.csrf, 'content-type': 'application/json' };

		// Nothing configured: the screen has nothing to show but the form.
		const empty = (await (await fetch(`${base}/api/radio`, { headers: { cookie } })).json()) as RadioStatus;
		assert.equal(empty.interface, null);
		assert.equal(empty.connected, false);
		assert.equal(empty.rig, null);

		// One interface per rigctld; the station dials it when asked and keeps it.
		const created = await fetch(`${base}/api/transceivers`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ name: 'bench', host: '127.0.0.1', port: rigPort }),
		});
		assert.equal(created.status, 201);
		const radio = (await created.json()) as Transceiver;
		assert.equal(radio.enabled, true);
		assert.equal(radio.pttInput, 'rear', 'a modem-fed station transmits through the rear input');
		assert.ok(radio.lastUsedAt, 'creating an interface counts as using it');

		await fetch(`${base}/api/transceivers/${radio.id}/connect`, { method: 'POST', headers: auth });
		const status = (await (await fetch(`${base}/api/radio`, { headers: { cookie } })).json()) as RadioStatus;
		assert.deepEqual(status.interface, { host: '127.0.0.1', port: rigPort });
		assert.equal(status.connected, true);
		assert.equal(status.rig?.model, 'TS-590S');
		assert.equal(status.rig?.frequencyHz, 3_597_000);
		assert.equal(status.rig?.mode, 'PKTUSB');
		assert.equal(status.rig?.filterHz, 2500, 'the filter the rig reports (SL13), not Hamlib’s Width');
		assert.equal(status.rig?.shiftHz, 1500, 'the IF shift is centred');
		assert.equal(status.rig?.usableHz, 2500, 'nothing is lost to the shift');
		assert.equal(status.rig?.rfPower, 0.35);
		assert.equal(status.rig?.active, true);
		assert.equal(status.serial, null, 'the serial line is not in the protocol');

		// The serial line is what the operator records about the daemon (decision 39).
		const withSerial = await fetch(`${base}/api/transceivers/${radio.id}`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ serialPort: '/dev/ttyUSB0', serialSpeed: 115200 }),
		});
		assert.equal(withSerial.status, 200);
		const serialStatus = (await (await fetch(`${base}/api/radio`, { headers: { cookie } })).json()) as RadioStatus;
		assert.deepEqual(serialStatus.serial, { device: '/dev/ttyUSB0', speed: 115200 });

		// The transmitter power goes to the rig and comes back as the rig reports it.
		const powered = await fetch(`${base}/api/transceivers/${radio.id}/power`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ rfPower: 0.25 }),
		});
		assert.equal(powered.status, 200);
		const afterPower = (await (await fetch(`${base}/api/radio`, { headers: { cookie } })).json()) as RadioStatus;
		assert.equal(afterPower.rig?.rfPower, 0.25, 'the level is read back, not echoed');

		// The connector is a stored property of the interface.
		const connector = await fetch(`${base}/api/transceivers/${radio.id}`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ pttInput: 'front' }),
		});
		assert.equal(connector.status, 200);
		assert.equal(((await connector.json()) as Transceiver).pttInput, 'front');

		// A second interface: the one the operator uses last is the one the station follows.
		const second = await fetch(`${base}/api/transceivers`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ name: 'spare', host: '127.0.0.1', port: 1, enabled: false }),
		});
		const spare = (await second.json()) as Transceiver;
		const current = (await (await fetch(`${base}/api/radio`, { headers: { cookie } })).json()) as RadioStatus;
		assert.deepEqual(current.interface, { host: '127.0.0.1', port: 1 }, 'the newest interface is current');

		await fetch(`${base}/api/transceivers/${radio.id}/select`, { method: 'POST', headers: auth });
		const selected = (await (await fetch(`${base}/api/radio`, { headers: { cookie } })).json()) as RadioStatus;
		assert.deepEqual(selected.interface, { host: '127.0.0.1', port: rigPort });
		assert.equal(spare.enabled, false, 'a switched-off interface is stored, not dialled');

		// Validation happens before anything reaches the rig.
		const badPower = await fetch(`${base}/api/transceivers/${radio.id}/power`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ rfPower: 1.5 }),
		});
		assert.equal(badPower.status, 400);
		const badSpeed = await fetch(`${base}/api/transceivers/${radio.id}`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ serialSpeed: 5 }),
		});
		assert.equal(badSpeed.status, 400);
		const badHost = await fetch(`${base}/api/transceivers/${radio.id}`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ host: 'two words' }),
		});
		assert.equal(badHost.status, 400);
	} finally {
		await close();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => rigServer.close(() => resolve()));
	}
});

test('a packet modem is judged by its port being there, since it has no VERSION', async () => {
	// Direwolf's AGWPE port speaks its own command set and never answers VERSION, so the
	// status asks only whether the port is up (decision 41).
	const sockets = new Set<import('node:net').Socket>();
	const server = createServer2((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const port = (server.address() as AddressInfo).port;

	const { base, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1PKT' }),
		});
		const me = (await setup.json()) as Me;
		const cookie = cookieFrom(setup);
		const auth = { cookie, 'x-csrf-token': me.csrf, 'content-type': 'application/json' };

		const created = await fetch(`${base}/api/modems`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({
				name: 'Direwolf',
				kind: 'direwolf',
				host: '127.0.0.1',
				commandPort: port,
				kissPort: port,
				dataPort: port,
			}),
		});
		assert.equal(created.status, 201);
		const modem = (await created.json()) as Modem;

		// A record created without ports gets the modem's own numbers, so the form and an API
		// client agree (decision 41).
		const bare = await fetch(`${base}/api/modems`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ name: 'Direwolf defaults', kind: 'direwolf', host: '127.0.0.1' }),
		});
		const withDefaults = (await bare.json()) as Modem;
		assert.equal(withDefaults.commandPort, 8000, 'AGWPE');
		assert.equal(withDefaults.kissPort, 8001, 'KISS');
		assert.equal(withDefaults.dataPort, 7355, 'sound data, over UDP');

		const answer = (await (
			await fetch(`${base}/api/modems/status`, { headers: { cookie } })
		).json()) as ModemStatusResponse;
		const status = answer.statuses.find((entry) => entry.id === modem.id);
		assert.equal(status?.running, true, 'the AGWPE port is there');
		assert.equal(status?.reportedKind, null, 'nothing named itself, and nothing is expected to');
		assert.equal(status?.mismatch, false);
	} finally {
		await close();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test('a modem is unavailable when another program answers on its port', async () => {
	// Data2G answers on a port a VARA modem is configured to use. The socket connects, so the
	// port is "up", but there is no VARA there: the status must say unavailable and name the
	// program that answered instead (decision 38).
	const sockets = new Set<import('node:net').Socket>();
	const server = createServer2((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('data', () => socket.write('VERSION Data2G 0.5.3\r'));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const port = (server.address() as AddressInfo).port;

	const { base, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1KIN' }),
		});
		const me = (await setup.json()) as Me;
		const cookie = cookieFrom(setup);
		const auth = { cookie, 'x-csrf-token': me.csrf, 'content-type': 'application/json' };

		const create = async (name: string, kind: string): Promise<Modem> => {
			const response = await fetch(`${base}/api/modems`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({ name, kind, host: '127.0.0.1', commandPort: port }),
			});
			assert.equal(response.status, 201);
			return (await response.json()) as Modem;
		};
		const vara = await create('VARA HF', 'vara');
		const data2g = await create('Data2G', 'data2g');

		const answer = (await (
			await fetch(`${base}/api/modems/status`, { headers: { cookie } })
		).json()) as ModemStatusResponse;
		const varaStatus = answer.statuses.find((entry) => entry.id === vara.id);
		assert.equal(varaStatus?.running, false, 'a VARA record served by Data2G is not a VARA');
		assert.equal(varaStatus?.mismatch, true);
		assert.match(varaStatus?.error ?? '', /Data2G is answering on this port, not/);
		assert.equal(varaStatus?.reportedKind, 'data2g', 'the screen can still say who answered');

		const data2gStatus = answer.statuses.find((entry) => entry.id === data2g.id);
		assert.equal(data2gStatus?.running, true, 'the program that is there is available');
		assert.equal(data2gStatus?.mismatch, false);
		assert.equal(data2gStatus?.error, null);
	} finally {
		await close();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test('modems are configured, edited and removed, and must name a real transceiver', async () => {
	const { base, store, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1OWN' }),
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
			body: JSON.stringify({ callsign: 'OK1OWN' }),
		});
		const owner = (await setup.json()) as Me;
		const headers = { cookie: cookieFrom(setup), 'x-csrf-token': owner.csrf, 'content-type': 'application/json' };

		// At creation, for a club callsign that works from a different place.
		const created = await fetch(`${base}/api/users`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ callsign: 'OK9ZZZ', locator: 'jo70aa' }),
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
			body: JSON.stringify({ callsign: 'OK1NPW' }),
		});
		assert.equal(setup.status, 201, 'the first account starts without a password');
		const me = (await setup.json()) as Me;
		assert.equal(me.user.hasPassword, false);

		// Empty: accepted.
		const empty = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1NPW' }),
		});
		assert.equal(empty.status, 200);

		// Any invented password: refused, because "no password" must not mean "any
		// password" on an instance other machines can reach.
		const invented = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1NPW', password: 'anything' }),
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
			body: JSON.stringify({ callsign: 'OK1OWN' }),
		});
		const owner = (await setup.json()) as Me;
		const ownerHeaders = { cookie: cookieFrom(setup), 'x-csrf-token': owner.csrf, 'content-type': 'application/json' };

		await fetch(`${base}/api/users`, {
			method: 'POST',
			headers: ownerHeaders,
			body: JSON.stringify({ callsign: 'OK4RM', role: 'user', password: 'hunter2' }),
		});

		const login = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK4RM', password: 'hunter2' }),
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
		const afterPtt = (await patched.json()) as Transceiver;
		assert.equal(afterPtt.pttInput, 'front');
		assert.equal(afterPtt.name, 'Bench', 'a one-field edit leaves the name alone');
		assert.equal(afterPtt.host, '127.0.0.1');

		// Moving a radio's address must not wipe its name, which a create-shaped body
		// (name: body.name ?? '') did until this test existed.
		const moved = await fetch(`${base}/api/transceivers/${radio.id}`, {
			method: 'PATCH',
			headers: asUser,
			// Never the operator's own network: a test that expects "unreachable" must not
			// flip to reachable because a rigctld happened to be running on the LAN.
			body: JSON.stringify({ host: '127.0.0.1', port: 1 }),
		});
		assert.equal(moved.status, 200);
		const afterMove = (await moved.json()) as Transceiver;
		assert.equal(afterMove.name, 'Bench');
		assert.equal(afterMove.host, '127.0.0.1');
		assert.equal(afterMove.port, 1);
		assert.equal(afterMove.pttInput, 'front', 'the connector choice survives too');

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
			body: JSON.stringify({ callsign: 'OK9XXX' }),
		});
		assert.equal(forbidden.status, 403);
	} finally {
		await close();
	}
});

test('a session moves mail through the modem and into the mailbox over HTTP', async () => {
	// A rigctld and a modem, both scripted: the route tunes the radio, dials, runs the
	// exchange over the data port and reports what moved.
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
				if (line === '\\get_rig_info')
					socket.write(
						[
							'VFO=VFOA Freq=3597000 Mode=PKTUSB Width=2000 RX=1 TX=1',
							'VFO=VFOB Freq=0 Mode=None Width=0 RX=0 TX=0',
							'Split=0 SatMode=0',
							'Rig=TS-590S',
							'App=Hamlib',
							'Version=20241103 1.1.0',
							'Model=2031',
							'CRC=0x269e8082',
							'',
						].join('\n') + '\n',
					);
				else if (line === '+\\get_freq') socket.write('get_freq:\nFrequency: 3597000\nRPRT 0\n');
				else if (line === '+\\get_mode') socket.write('get_mode:\nMode: PKTUSB\nPassband: 2000\nRPRT 0\n');
				else if (line === '+\\get_ptt') socket.write('get_ptt:\nPTT: 0\nRPRT 0\n');
				else if (line === 'w SH;') socket.write('SH05;\0');
				else if (line === 'w SL;') socket.write('SL13;\0');
				else socket.write('RPRT 0\n');
			}
		});
	});
	await new Promise<void>((resolve) => rigServer.listen(0, '127.0.0.1', () => resolve()));
	const rigPort = (rigServer.address() as AddressInfo).port;

	const modem = new ScriptedModem([outboundMessage('INBOUND00001', 'OK1RAA', ['OK4RM'], 'Z gateway', 'Dobry den.\n')]);
	await modem.listen();

	const { base, store, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1ADM' }),
		});
		const me = (await setup.json()) as Me;
		const cookie = cookieFrom(setup);
		const auth = { cookie, 'x-csrf-token': me.csrf, 'content-type': 'application/json' };

		// The callsign and the locator a session puts on the air.
		const account = await fetch(`${base}/api/account`, {
			method: 'PATCH',
			headers: auth,
			body: JSON.stringify({ callsign: 'OK4RM', locator: 'JO70AA' }),
		});
		assert.equal(account.status, 200);

		const radioResponse = await fetch(`${base}/api/transceivers`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ name: 'TS-590S', host: '127.0.0.1', port: rigPort, pttInput: 'rear' }),
		});
		const radio = (await radioResponse.json()) as Transceiver;
		await fetch(`${base}/api/transceivers/${radio.id}/connect`, { method: 'POST', headers: auth });

		const modemResponse = await fetch(`${base}/api/modems`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({
				name: 'Data2G',
				kind: 'data2g',
				host: '127.0.0.1',
				commandPort: modem.commandPort,
				dataPort: modem.dataPort,
				// No transceiver named: the modem form no longer asks, so the session takes
				// the station's current interface (decision 43).
			}),
		});
		const configured = (await modemResponse.json()) as Modem;
		assert.equal(configured.dataPort, modem.dataPort);
		assert.equal(configured.transceiverId, null);

		// One message waiting in OUTBOX, as the composer leaves it.
		const composed = await fetch(`${base}/api/messages`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ to: 'OK1RAA', subject: 'Hello from the bench', body: 'Test.\n' }),
		});
		assert.equal(composed.status, 201);

		const run = await fetch(`${base}/api/session/run`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({
				modemId: configured.id,
				target: 'OK1RAA',
				frequencyHz: 3_597_000,
				bandwidthHz: 2300,
			}),
		});
		const runText = await run.text();
		assert.equal(run.status, 200, runText);
		const report = JSON.parse(runText) as SessionRunResponse;
		assert.ok(
			modem.log.includes('< [RMS Express-1.8.6.0-B2FHM$]'),
			'the SID a Winlink session sends is the client the CMS accepts',
		);

		assert.equal(report.result, 'complete', report.message);
		assert.equal(report.sent.length, 1);
		assert.deepEqual(report.received, ['INBOUND00001']);
		assert.equal(report.transceiverName, 'TS-590S');
		assert.equal(report.rig?.mode, 'PKTUSB');
		assert.ok(report.log.some((entry) => entry.direction === '<' && entry.text.startsWith('[WL2K')));
		assert.ok(modem.commandLines.includes('CONNECT OK4RM OK1RAA'));

		// The inbound message is in the account's INBOX, addressed as a Winlink address.
		const inbox = me.folders.find((folder) => folder.kind === 'inbox');
		assert.ok(inbox);
		const listing = (await (
			await fetch(`${base}/api/folders/${inbox.id}/messages`, { headers: { cookie } })
		).json()) as MessageListResponse;
		assert.equal(listing.total, 1);
		assert.equal(listing.messages[0]?.subject, 'Z gateway');

		// OUTBOX is empty: the message left when the gateway accepted it.
		const outbox = me.folders.find((folder) => folder.kind === 'outbox');
		assert.ok(outbox);
		const outboxListing = (await (
			await fetch(`${base}/api/folders/${outbox.id}/messages`, { headers: { cookie } })
		).json()) as MessageListResponse;
		assert.equal(outboxListing.total, 0);

		// The gateway that answered is remembered with the dial it was called on, so the
		// operator does not have to type a callsign-and-frequency pair twice (decision 44).
		const targets = (await (
			await fetch(`${base}/api/session/targets`, { headers: { cookie } })
		).json()) as SessionTargetsResponse;
		assert.deepEqual(targets.targets, [
				{
					callsign: 'OK1RAA',
					frequencyHz: 3_597_000,
					kind: 'data2g',
					sessionMode: 'cms',
					uses: 1,
					lastUsedAt: targets.targets[0]?.lastUsedAt,
				},
			]);
		assert.ok((targets.targets[0]?.lastUsedAt ?? 0) > 0, 'the use is stamped');
	} finally {
		await close();
		await modem.close();
		for (const socket of rigSockets) socket.destroy();
		await new Promise<void>((resolve) => rigServer.close(() => resolve()));
	}
});

test('a session needs the CSRF token and a callsign before anything is transmitted', async () => {
	const { base, store, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1ADM' }),
		});
		const me = (await setup.json()) as Me;
		const cookie = cookieFrom(setup);

		const noToken = await fetch(`${base}/api/session/run`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({ modemId: 1, target: 'OK1RAA', frequencyHz: 3_597_000 }),
		});
		assert.equal(noToken.status, 403, 'a session keys a transmitter and needs the CSRF token');

		// Every account is created with a callsign (decision 25), so the "no callsign"
		// refusal is reached by a row that has lost its own — the state a pre-migration
		// account could be in. A modem row is enough: the check comes before the radio.
		await store.createModem({ name: 'Bench', kind: 'vara', host: '127.0.0.1', commandPort: 1 });
		const own = await store.findUserByLogin('OK1ADM');
		assert.ok(own);
		await store.setCallsign(own.id, null);
		const noCallsign = await fetch(`${base}/api/session/run`, {
			method: 'POST',
			headers: { cookie, 'x-csrf-token': me.csrf, 'content-type': 'application/json' },
			body: JSON.stringify({ modemId: 1, target: 'OK1RAA', frequencyHz: 3_597_000 }),
		});
		assert.equal(noCallsign.status, 400);
		assert.equal(((await noCallsign.json()) as { fields?: { callsign?: string } }).fields?.callsign, 'required');
	} finally {
		await close();
	}
});

test('the post office owner is one account, and its credential is sealed', async () => {
	const { base, store, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1ADM' }),
		});
		const me = (await setup.json()) as Me;
		const headers = { cookie: cookieFrom(setup), 'x-csrf-token': me.csrf, 'content-type': 'application/json' };

		// A client session cannot see the post office at all; its routes are the seat's.
		const clientRead = await fetch(`${base}/api/postoffice/status`, { headers: { cookie: headers.cookie } });
		assert.equal(clientRead.status, 403);
		assert.match(((await clientRead.json()) as { error: string }).error, /not open in this session/);

		// The seat cannot be taken yet, so the test takes it the way a future login would:
		// a session token of its own, signed with the same secret the harness uses.
		const seat = new Sessions('test-secret-value').issue(me.user.id, 3600, true);
		// A session carries its own CSRF nonce, so the seat does too.
		const poHeaders = {
			...headers,
			cookie: `${SESSION_COOKIE}=${seat.token}`,
			'x-csrf-token': seat.payload.csrf,
		};

		// Nothing listens before an account owns the role and a modem is armed.
		const status = (await (await fetch(`${base}/api/postoffice/status`, { headers: poHeaders })).json()) as {
			armed: boolean;
			owner: string | null;
		};
		assert.equal(status.armed, false);
		assert.equal(status.owner, null);
		const noOwner = await fetch(`${base}/api/postoffice/arm`, {
			method: 'POST',
			headers: poHeaders,
			body: JSON.stringify({ modemId: 1, frequencyHz: 3_597_000 }),
		});
		assert.equal(noOwner.status, 400);
		assert.equal(((await noOwner.json()) as { fields?: { owner?: string } }).fields?.owner, 'missing');

		const second = await fetch(`${base}/api/users`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ callsign: 'OK2XYZ' }),
		});
		const other = (await second.json()) as User;

		const madeOwner = await fetch(`${base}/api/users/${me.user.id}`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({ isPostOffice: true }),
		});
		assert.equal(((await madeOwner.json()) as User).isPostOffice, true);

		// One owner: marking another account unseats the first.
		await fetch(`${base}/api/users/${other.id}`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({ isPostOffice: true }),
		});
		const list = (await (await fetch(`${base}/api/users`, { headers })).json()) as User[];
		assert.deepEqual(
			list.filter((user) => user.isPostOffice).map((user) => user.callsign),
			['OK2XYZ'],
		);

		// The post-office password is sealed, never returned, and reported as a flag.
		const saved = await fetch(`${base}/api/users/${other.id}`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({ postOfficePassword: 'stations-secret' }),
		});
		const savedText = await saved.text();
		assert.ok(!savedText.includes('stations-secret'), 'the password must not come back');
		assert.equal((JSON.parse(savedText) as User).hasPostOfficePassword, true);
		const sealed = await store.getPostOfficeSecret(other.id);
		assert.match(sealed ?? '', /^v1\./);
		assert.ok(!(sealed ?? '').includes('stations-secret'));

		// The owner's callsign is what the station would answer as.
		const after = (await (await fetch(`${base}/api/postoffice/status`, { headers: poHeaders })).json()) as {
			owner: string | null;
		};
		assert.equal(after.owner, 'OK2XYZ');
	} finally {
		await close();
	}
});

/** A port that is free right now: bind it, learn the number, let it go. */
async function freePort(): Promise<number> {
	const probe = createServer2();
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
	const port = (probe.address() as AddressInfo).port;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

/** True when something accepts a TCP connection on that port. */
function accepts(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(port, '127.0.0.1');
		let settled = false;
		const done = (answer: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(answer);
		};
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
		socket.setTimeout(2000, () => done(false));
	});
}

test('POP3, SMTP and IMAP are one door with a switch on each', async () => {
	const port = await freePort();
	// A station with a post office owner: this is where the mail interfaces belong.
	const { base, close } = await harness({ smtp: { host: '127.0.0.1', port } }, '127.0.0.1:0', true);
	try {
		// The public status carries all three, running or not: the header lamp needs them
		// before anybody signs in.
		const status = (await (await fetch(`${base}/api/status`)).json()) as StatusResponse;
		assert.deepEqual(status.mailInterfaces.map((entry) => entry.name), ['pop3', 'smtp', 'imap']);
		assert.deepEqual(status.mailInterfaces.map((entry) => entry.running), [false, true, false]);
		assert.deepEqual(status.mailInterfaces.map((entry) => entry.configured), [false, true, false]);
		assert.equal(status.mailInterfaces[1]?.address, `127.0.0.1:${port}`);
		assert.equal(status.network.listeners, 1, 'the access lamp counts the mail doors that are up');
		assert.equal(await accepts(port), true);

		// Details are for the station's operators: an unauthenticated read is refused.
		assert.equal((await fetch(`${base}/api/mail/interfaces`)).status, 401);

		const setup = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1OWN' }),
		});
		assert.equal(setup.status, 200, 'the harness owner signs in');
		const cookie = cookieFrom(setup);
		const me = (await setup.json()) as Me;
		const headers = { cookie, 'x-csrf-token': me.csrf, 'content-type': 'application/json' };
		const switchTo = (name: string, on: boolean, extra: Record<string, string> = {}): Promise<Response> =>
			fetch(`${base}/api/mail/interfaces`, {
				method: 'POST',
				headers: { ...headers, ...extra },
				body: JSON.stringify({ name, on }),
			});

		// A switch without the CSRF nonce is refused: it closes a listener.
		assert.equal((await switchTo('smtp', false, { 'x-csrf-token': 'wrong' })).status, 403);

		const off = (await (await switchTo('smtp', false)).json()) as MailInterfacesResponse;
		const stopped = off.interfaces.find((entry) => entry.name === 'smtp');
		assert.equal(stopped?.running, false);
		// The address stays reported while stopped: it is what the switch would reopen.
		assert.equal(stopped?.address, `127.0.0.1:${port}`);
		assert.equal(await accepts(port), false);
		const idle = (await (await fetch(`${base}/api/status`)).json()) as StatusResponse;
		assert.equal(idle.network.listeners, 0, 'nothing listening: the access lamp goes dark grey');

		// On again: the same address binds a second time, so a failed listen cannot stick.
		const on = (await (await switchTo('smtp', true)).json()) as MailInterfacesResponse;
		assert.equal(on.interfaces.find((entry) => entry.name === 'smtp')?.running, true);
		assert.equal(await accepts(port), true);
		const busy = (await (await fetch(`${base}/api/status`)).json()) as StatusResponse;
		assert.equal(busy.network.listeners, 1);

		// A protocol the configuration does not offer has nothing to bind.
		assert.equal((await switchTo('pop3', true)).status, 409);

		// A name that is not a protocol is a bad request, not a silent success.
		assert.equal((await switchTo('imap2', true)).status, 400);
	} finally {
		await close();
	}
});

test('the access mode is one posture: read by any operator, changed by an administrator', async () => {
	const { base, close } = await harness();
	try {
		// Before anybody signs in, the login page already knows the posture.
		const status = (await (await fetch(`${base}/api/status`)).json()) as StatusResponse;
		assert.equal(status.network.mode, 'very strict');
		assert.equal(status.network.exposed, false);
		assert.match(status.network.summary, /loopback only/);

		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1ABC' }),
		});
		const admin = (await setup.json()) as Me;
		const adminHeaders = {
			cookie: cookieFrom(setup),
			'x-csrf-token': admin.csrf,
			'content-type': 'application/json',
		};
		const readAccess = async (cookie: string): Promise<NetworkAccess> =>
			(await (await fetch(`${base}/api/network/access`, { headers: { cookie } })).json()) as NetworkAccess;
		const setAccess = (body: unknown, headers: Record<string, string> = adminHeaders): Promise<Response> =>
			fetch(`${base}/api/network/access`, { method: 'POST', headers, body: JSON.stringify(body) });

		const read = await readAccess(adminHeaders.cookie);
		assert.equal(read.mode, 'very strict');
		assert.deepEqual(read.cidrs, []);
		assert.equal(read.listen, '127.0.0.1:0');

		// Strict with no network is refused, and the station stays exactly as it was.
		const empty = await setAccess({ mode: 'strict', cidrs: [] });
		assert.equal(empty.status, 400);
		assert.equal(((await empty.json()) as { fields?: { cidrs?: string } }).fields?.cidrs, 'invalid');
		assert.equal((await readAccess(adminHeaders.cookie)).mode, 'very strict');

		// A CIDR that does not parse, and a mode that is not one of the two, are refused.
		assert.equal((await setAccess({ mode: 'strict', cidrs: ['192.168.0.0/33'] })).status, 400);
		assert.equal((await setAccess({ mode: 'open', cidrs: [] })).status, 400);

		// An ordinary account may read the posture and may not change it.
		await fetch(`${base}/api/users`, {
			method: 'POST',
			headers: adminHeaders,
			body: JSON.stringify({ callsign: 'OK4RM', role: 'user', password: 'hunter2' }),
		});
		const login = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK4RM', password: 'hunter2' }),
		});
		const plain = (await login.json()) as Me;
		const plainCookie = cookieFrom(login);
		const plainHeaders = { cookie: plainCookie, 'x-csrf-token': plain.csrf, 'content-type': 'application/json' };
		assert.equal((await fetch(`${base}/api/network/access`, { headers: { cookie: plainCookie } })).status, 200);
		assert.equal((await setAccess({ mode: 'strict', cidrs: ['10.0.0.0/8'] }, plainHeaders)).status, 403);

		// The administrator opens the LAN; the public status carries it at once.
		const opened = await setAccess({ mode: 'strict', cidrs: ['192.168.132.0/23'] });
		assert.equal(opened.status, 200);
		const posture = (await opened.json()) as NetworkAccess;
		assert.equal(posture.mode, 'strict');
		assert.deepEqual(posture.cidrs, ['192.168.132.0/23']);
		assert.match(posture.summary, /192\.168\.132\.0\/23/);
		const after = (await (await fetch(`${base}/api/status`)).json()) as StatusResponse;
		assert.equal(after.network.mode, 'strict');
		assert.equal(after.network.exposed, false);

		// And shuts it again.
		const closed = (await (await setAccess({ mode: 'very strict', cidrs: [] })).json()) as NetworkAccess;
		assert.equal(closed.mode, 'very strict');
		assert.deepEqual(closed.cidrs, []);
	} finally {
		await close();
	}
});

test('a listener on the wire with very strict is reported as exposed', async () => {
	// The real shape of the awkward state: a mail door and the web UI both bound to every
	// interface, while the policy admits only loopback.
	const port = await freePort();
	const { base, close } = await harness({ smtp: { host: '0.0.0.0', port } }, '0.0.0.0:8082', true);
	try {
		const status = (await (await fetch(`${base}/api/status`)).json()) as StatusResponse;
		assert.equal(status.network.mode, 'very strict');
		assert.equal(status.network.exposed, true, 'bound beyond loopback while admitting only loopback');
		assert.equal(status.network.listeners, 1);
		assert.match(status.network.summary, /loopback only/);
	} finally {
		await close();
	}
});

test('a Winlink client listens on nothing, and its switches cannot start one', async () => {
	const port = await freePort();
	// No post office owner: this is the station as it is used now, a Winlink client.
	const { base, close } = await harness({ smtp: { host: '127.0.0.1', port } });
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1ABC' }),
		});
		const me = (await setup.json()) as Me;
		const headers = { cookie: cookieFrom(setup), 'x-csrf-token': me.csrf, 'content-type': 'application/json' };

		// The file names an address for SMTP, and still nothing is listening.
		const status = (await (await fetch(`${base}/api/status`)).json()) as StatusResponse;
		assert.deepEqual(status.mailInterfaces.map((entry) => entry.running), [false, false, false]);
		assert.equal(status.mailInterfaces.find((entry) => entry.name === 'smtp')?.configured, true);
		assert.equal(status.network.listeners, 0);
		assert.equal(await accepts(port), false);

		const read = (await (
			await fetch(`${base}/api/mail/interfaces`, { headers: { cookie: headers.cookie } })
		).json()) as MailInterfacesResponse;
		assert.equal(read.postOffice, false);

		// Starting one is the post office's act; a client station is refused.
		const refused = await fetch(`${base}/api/mail/interfaces`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ name: 'smtp', on: true }),
		});
		assert.equal(refused.status, 409);
		assert.match(((await refused.json()) as { error: string }).error, /belong to the post office/);
		assert.equal(await accepts(port), false);
	} finally {
		await close();
	}
});

test('the post office is a seat at the door, and it is not open yet', async () => {
	const { base, close } = await harness();
	try {
		const setup = await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1ABC' }),
		});
		const me = (await setup.json()) as Me;
		assert.equal(me.postOffice, false, 'an ordinary sign-in is a client session, never the post office');

		// The seat is asked for at the door and refused while the post office is shelved.
		const refused = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1ABC', postOffice: true }),
		});
		assert.equal(refused.status, 409);
		assert.equal(
			((await refused.json()) as { fields?: { postOffice?: string } }).fields?.postOffice,
			'unavailable',
		);
	} finally {
		await close();
	}
});

test('a callsign makes its own mailbox at the sign-in page, with its Winlink password', async () => {
	const { base, store, close } = await harness();
	try {
		// The station already has its first account, so this is ordinary registration.
		await fetch(`${base}/api/setup`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK1ADM' }),
		});
		const register = (body: unknown): Promise<Response> =>
			fetch(`${base}/api/accounts`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});

		const created = await register({ callsign: 'ok2abc', winlinkPassword: 'wl-secret-1' });
		assert.equal(created.status, 201);
		const me = (await created.json()) as Me;
		assert.equal(me.user.callsign, 'OK2ABC', 'the callsign is normalised and is the login');
		assert.equal(me.user.role, 'user');
		assert.equal(me.user.hasWinlinkPassword, true);
		assert.equal(me.postOffice, false, 'a self-made account is never the post office');
		assert.deepEqual(
			me.folders.map((folder) => folder.name).filter((name) => name === 'INBOX' || name === 'OUTBOX'),
			['INBOX', 'OUTBOX'],
		);

		// The password is sealed, never hashed, never returned.
		const sealed = await store.getWinlinkSecret(me.user.id);
		assert.match(sealed ?? '', /^v1\./);
		assert.ok(!(sealed ?? '').includes('wl-secret-1'));

		// No local password was set, so the callsign alone signs in afterwards.
		const again = await fetch(`${base}/api/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ callsign: 'OK2ABC' }),
		});
		assert.equal(again.status, 200);

		// One callsign, one mailbox.
		const duplicate = await register({ callsign: 'OK2ABC', winlinkPassword: 'another' });
		assert.equal(duplicate.status, 409);
		assert.equal(
			((await duplicate.json()) as { fields?: { callsign?: string } }).fields?.callsign,
			'duplicate',
		);

		// The Winlink password is the one field that cannot be skipped.
		const missing = await register({ callsign: 'OK3ABC', winlinkPassword: '   ' });
		assert.equal(missing.status, 400);
		assert.equal(
			((await missing.json()) as { fields?: { winlinkPassword?: string } }).fields?.winlinkPassword,
			'required',
		);

		// And the callsign has to be one.
		assert.equal((await register({ callsign: 'not a callsign', winlinkPassword: 'x' })).status, 400);
	} finally {
		await close();
	}
});
