import assert from 'node:assert/strict';
import test from 'node:test';
import { findUserByCredential } from '@rfmail/mailservers';
import { SqliteStore, hashPassword } from '@rfmail/store';

async function setup(): Promise<{ store: SqliteStore; close: () => Promise<void> }> {
	const store = new SqliteStore({ path: ':memory:' });
	await store.migrate();
	const password = hashPassword('tajne');
	const user = await store.createUser({
		login: 'ok4rm',
		pwHash: password,
		role: 'user',
		callsign: 'OK4RM',
	});
	// An account whose name is not its callsign, so the callsign path is exercised.
	await store.createUser({ login: 'operator', pwHash: password, role: 'user', callsign: 'OK2XYZ' });
	await store.createUser({ login: 'nobody', pwHash: null, role: 'user' });
	return {
		store,
		close: async () => {
			await store.close();
			void user;
		},
	};
}

test('an account name, its callsign and its Winlink address all reach the same account', async () => {
	const { store, close } = await setup();
	try {
		const expected = (await store.findUserByLogin('ok4rm'))?.id;
		assert.ok(expected);
		for (const credential of ['ok4rm', 'OK4RM', 'ok4rm@winlink.org', ' OK4RM@Winlink.ORG ']) {
			const user = await findUserByCredential(store, credential);
			assert.equal(user?.id, expected, credential);
		}
	} finally {
		await close();
	}
});

test('an unknown name resolves to nobody, and never to a different account', async () => {
	const { store, close } = await setup();
	try {
		assert.equal(await findUserByCredential(store, 'ok9zzz'), null);
		assert.equal(await findUserByCredential(store, 'ok9zzz@winlink.org'), null);
		assert.equal(await findUserByCredential(store, 'jane@example.org'), null);
		assert.equal(await findUserByCredential(store, ''), null);
		// The free name `nobody` is unaffected by the callsign fallback.
		assert.equal((await findUserByCredential(store, 'nobody'))?.login, 'nobody');

		// A callsign whose account name is something else still resolves.
		assert.equal((await findUserByCredential(store, 'OK2XYZ'))?.login, 'operator');
		assert.equal((await findUserByCredential(store, 'ok2xyz@winlink.org'))?.login, 'operator');
	} finally {
		await close();
	}
});
