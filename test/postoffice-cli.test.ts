// The post office's mailbox loader: the list format, and what it does to the store.

import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from '@rfmail/store';
import { loadMailboxes, parseMailboxList } from '../apps/postoffice/src/cli.ts';

test('the list is one mailbox per line, with comments, quotes and colons in passwords', () => {
  const { seeds, problems } = parseMailboxList(
    [
      '# the club list',
      '',
      'ok1raa: another good password',
      'OK2XYZ: " padded and preserved "',
      'OK3ABC: pass:with:colons',
    ].join('\n'),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(
    seeds.map((seed) => [seed.callsign, seed.password, seed.line]),
    [
      ['OK1RAA', 'another good password', 3],
      ['OK2XYZ', ' padded and preserved ', 4],
      ['OK3ABC', 'pass:with:colons', 5],
    ],
  );
});

test('a bad line is reported with its number, and nothing is loaded', () => {
  const { seeds, problems } = parseMailboxList(
    ['OK1RAA: a good password', 'no colon here', 'OK2XYZ:', 'OK3ABC: short'].join('\n'),
  );
  assert.equal(seeds.length, 1);
  assert.equal(problems.length, 3);
  assert.deepEqual(problems.map((problem) => problem.line), [2, 3, 4]);
  assert.match(problems[0]?.message ?? '', /CALLSIGN: password/);
  assert.match(problems[1]?.message ?? '', /no password/);
  assert.match(problems[2]?.message ?? '', /shorter than 8/);
});

test('the same callsign twice is one mistake, not two mailboxes', () => {
  const { seeds, problems } = parseMailboxList(
    ['OK1RAA: a good password', 'ok1raa: another good password'].join('\n'),
  );
  assert.equal(seeds.length, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.message ?? '', /already listed on line 1/);
});

async function harness(): Promise<{ store: SqliteStore; close: () => Promise<void> }> {
  const store = new SqliteStore({ path: ':memory:', postOffice: true });
  await store.migrate();
  return { store, close: () => store.close() };
}

const sealed = (plaintext: string): string => `sealed:${plaintext}`;

test('a new mailbox is created without a browser password and with a sealed one', async () => {
  const app = await harness();
  try {
    const report = await loadMailboxes(
      app.store,
      [{ callsign: 'OK1RAA', password: 'another good password', line: 1 }],
      sealed,
    );
    assert.deepEqual(report.mailboxes, [{ callsign: 'OK1RAA', outcome: 'created' }]);
    const mailbox = await app.store.findUserByCallsign('OK1RAA');
    assert.equal(mailbox?.pwHash, null);
    assert.equal(mailbox?.postOfficeSecret, 'sealed:another good password');
    assert.equal(mailbox?.postOfficeSecret === null, false);
  } finally {
    await app.close();
  }
});

test('an existing password is left alone unless replacing, and a dry run writes nothing', async () => {
  const app = await harness();
  try {
    const first = [{ callsign: 'OK1RAA', password: 'another good password', line: 1 }];
    await loadMailboxes(app.store, first, sealed);

    const again = await loadMailboxes(
      app.store,
      [{ callsign: 'OK1RAA', password: 'a different password', line: 1 }],
      sealed,
    );
    assert.deepEqual(again.mailboxes, [{ callsign: 'OK1RAA', outcome: 'unchanged' }]);
    assert.equal((await app.store.findUserByCallsign('OK1RAA'))?.postOfficeSecret, 'sealed:another good password');

    const replaced = await loadMailboxes(
      app.store,
      [{ callsign: 'OK1RAA', password: 'a different password', line: 1 }],
      sealed,
      { replace: true },
    );
    assert.deepEqual(replaced.mailboxes, [{ callsign: 'OK1RAA', outcome: 'updated' }]);
    assert.equal((await app.store.findUserByCallsign('OK1RAA'))?.postOfficeSecret, 'sealed:a different password');

    const dry = await loadMailboxes(
      app.store,
      [{ callsign: 'OK9ZZZ', password: 'another good password', line: 1 }],
      sealed,
      { dryRun: true },
    );
    assert.deepEqual(dry.mailboxes, [{ callsign: 'OK9ZZZ', outcome: 'created' }]);
    assert.equal(await app.store.findUserByCallsign('OK9ZZZ'), null, 'a dry run creates nothing');
  } finally {
    await app.close();
  }
});

test('a mailbox whose password cannot be sealed is reported, not called created', async () => {
  const app = await harness();
  try {
    const report = await loadMailboxes(
      app.store,
      [{ callsign: 'OK1RAA', password: 'another good password', line: 1 }],
      () => {
        throw new Error('no store key');
      },
    );
    assert.deepEqual(report.mailboxes, []);
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0]?.reason ?? '', /no store key/);
  } finally {
    await app.close();
  }
});
