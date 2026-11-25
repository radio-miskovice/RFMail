import assert from 'node:assert/strict';
import test from 'node:test';
import { findUserByCredential } from '@rfmail/mailservers';
import { SqliteStore, hashPassword } from '@rfmail/store';

async function setup(): Promise<{ store: SqliteStore; close: () => Promise<void> }> {
	const store = new SqliteStore({ path: ':memory:' });
	await store.migrate();
	const password = hashPassword('tajne');
	// One callsign is one account, and the callsign is the login (decision 25):
	// there is no separate account name for the resolver to try.
	await store.createUser({ callsign: 'OK4RM', pwHash: password, role: 'user' });
	await store.createUser({ callsign: 'OK2XYZ', pwHash: password, role: 'user' });
	return {
		store,
		close: async () => {
			await store.close();
		},
	};
}

test('a callsign, its spellings and its Winlink address all reach the same account', async () => {
	const { store, close } = await setup();
	try {
		const expected = (await store.findUserByCallsign('OK4RM'))?.id;
		assert.ok(expected);
		for (const credential of ['ok4rm', 'OK4RM', 'Ok4Rm', 'ok4rm@winlink.org', ' OK4RM@Winlink.ORG ']) {
			const user = await findUserByCredential(store, credential);
			assert.equal(user?.id, expected, credential);
		}
	} finally {
		await close();
	}
});

test('an unknown station resolves to nobody, and never to a different account', async () => {
	const { store, close } = await setup();
	try {
		assert.equal(await findUserByCredential(store, 'ok9zzz'), null);
		assert.equal(await findUserByCredential(store, 'ok9zzz@winlink.org'), null);
		assert.equal(await findUserByCredential(store, 'jane@example.org'), null);
		assert.equal(await findUserByCredential(store, ''), null);

		// The second account answers only to its own callsign.
		const second = (await store.findUserByCallsign('OK2XYZ'))?.id;
		assert.ok(second);
		assert.equal((await findUserByCredential(store, 'ok2xyz'))?.id, second);
		assert.equal((await findUserByCredential(store, 'ok2xyz@winlink.org'))?.id, second);
	} finally {
		await close();
	}
});
