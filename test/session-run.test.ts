// A whole session over real sockets: a scripted VARA-family modem with a command
// port and a data port, the store on either side of the exchange, and runSession
// in the middle. This is what the live test on the air exercises, with a radio
// instead of a socket pair.

import assert from 'node:assert/strict';
import test from 'node:test';
import { composeMessage } from '@rfmail/core-b2f';
import { FLAG_UNREAD } from '@rfmail/shared';
import { SqliteStore } from '@rfmail/store';
import { createLogger } from '../packages/server/src/logging.ts';
import { runSession } from '../packages/server/src/session-run.ts';
import { ScriptedModem, outboundMessage } from './helpers/scripted-gateway.ts';

async function setup(): Promise<{ store: SqliteStore; userId: number; outboxId: number }> {
  const store = new SqliteStore({ path: ':memory:' });
  await store.migrate();
  const user = await store.createUser({ callsign: 'OK4RM', pwHash: null, role: 'admin' });
  await store.setLocator(user.id, 'JO70AA');
  const outbox = await store.findFolder(user.id, 'OUTBOX');
  assert.ok(outbox);
  return { store, userId: user.id, outboxId: outbox.id };
}

test('a session dials, exchanges both ways and files the mail away', async () => {
  const modem = new ScriptedModem([outboundMessage('INBOUND00001', 'OK1RAA', ['OK4RM'], 'Z gateway', 'Vítej doma.\n')]);
  await modem.listen();
  const { store, userId, outboxId } = await setup();
  await store.insertMessage(
    userId,
    outboxId,
    composeMessage({ from: 'OK4RM', to: 'OK1RAA', subject: 'Outbound one', body: 'Toto je test.\n', mid: 'OUTBOUND0001' }),
    { direction: 'out' },
  );

  try {
    const report = await runSession({
      store,
      account: (await store.getUser(userId))!,
      modem: {
        name: 'Data2G',
        kind: 'data2g',
        host: '127.0.0.1',
        commandPort: modem.commandPort,
        dataPort: modem.dataPort,
      },
      target: 'OK1RAA',
      logger: createLogger('error'),
      silenceMs: 5_000,
      dialTimeoutMs: 5_000,
    });

    assert.equal(report.result, 'complete', report.message);
    assert.deepEqual(report.sent, ['OUTBOUND0001']);
    assert.deepEqual(report.received, ['INBOUND00001']);

    // The modem heard the dial the VARA dialect asks for, and was hung up after.
    assert.ok(modem.commandLines.includes('MYCALL OK4RM'));
    assert.ok(modem.commandLines.includes('LISTEN OFF'));
    assert.ok(modem.commandLines.includes('CONNECT OK4RM OK1RAA'));
    assert.ok(modem.commandLines.includes('DISCONNECT'));
    assert.ok(!modem.commandLines.includes('WINLINK SESSION'), 'Data2G does not take VARA HF commands');

    // The gateway got the bytes it accepted the proposal for.
    assert.deepEqual(modem.received, [{ mid: 'OUTBOUND0001', body: 'Toto je test.\n' }]);

    // The delivered message left OUTBOX for SENT; the arrived one is unread in INBOX.
    const sentFolder = await store.findFolder(userId, 'SENT');
    const inbox = await store.findFolder(userId, 'INBOX');
    assert.ok(sentFolder && inbox);
    assert.equal((await store.findMessageByMid(userId, 'OUTBOUND0001'))?.folderId, sentFolder.id);
    const inboundNow = await store.findMessageByMid(userId, 'INBOUND00001');
    assert.equal(inboundNow?.folderId, inbox.id);
    assert.equal((inboundNow?.flags ?? 0) & FLAG_UNREAD, FLAG_UNREAD, 'an arriving message is unread');
    const arrived = await store.getMailMessage(userId, inboundNow!.id);
    assert.equal(arrived?.body, 'Vítej doma.\n');
    assert.deepEqual(arrived?.to, ['OK4RM']);
  } finally {
    await store.close();
    await modem.close();
  }
});

test('a message the far end already holds is not transmitted and still leaves OUTBOX', async () => {
  const modem = new ScriptedModem([], '-');
  await modem.listen();
  const { store, userId, outboxId } = await setup();
  await store.insertMessage(
    userId,
    outboxId,
    composeMessage({ from: 'OK4RM', to: 'OK1RAA', subject: 'Repeat', body: 'x\n', mid: 'OUTBOUND0002' }),
    { direction: 'out' },
  );

  try {
    const report = await runSession({
      store,
      account: (await store.getUser(userId))!,
      modem: { name: 'VARA HF', kind: 'vara', host: '127.0.0.1', commandPort: modem.commandPort, dataPort: modem.dataPort },
      target: 'OK1RAA',
      logger: createLogger('error'),
      silenceMs: 5_000,
      dialTimeoutMs: 5_000,
    });

    assert.equal(report.result, 'complete', report.message);
    assert.deepEqual(report.sent, []);
    assert.deepEqual(report.exchange?.rejected, ['OUTBOUND0002']);
    assert.deepEqual(modem.received, [], 'a message the peer holds is not transmitted');
    const sentFolder = await store.findFolder(userId, 'SENT');
    assert.equal((await store.findMessageByMid(userId, 'OUTBOUND0002'))?.folderId, sentFolder?.id);
  } finally {
    await store.close();
    await modem.close();
  }
});

test('a message already in the mailbox is not accepted twice', async () => {
  // The gateway offers a message this station already has: the answer is `-`, and
  // nothing is transferred for it.
  const existing = outboundMessage('ALREADY00001', 'OK1RAA', ['OK4RM'], 'Already here', 'Seen before.\n');
  const modem = new ScriptedModem([existing, outboundMessage('NEWNEW000001', 'OK1RAA', ['OK4RM'], 'New', 'Fresh.\n')]);
  await modem.listen();
  const { store, userId } = await setup();
  const inbox = await store.findFolder(userId, 'INBOX');
  assert.ok(inbox);
  await store.insertMessage(
    userId,
    inbox.id,
    composeMessage({ from: 'OK1RAA', to: 'OK4RM', subject: 'Already here', body: 'Seen before.\n', mid: 'ALREADY00001' }),
    { direction: 'in' },
  );

  try {
    const report = await runSession({
      store,
      account: (await store.getUser(userId))!,
      modem: { name: 'VARA HF', kind: 'vara', host: '127.0.0.1', commandPort: modem.commandPort, dataPort: modem.dataPort },
      target: 'OK1RAA',
      logger: createLogger('error'),
      silenceMs: 5_000,
      dialTimeoutMs: 5_000,
    });

    assert.equal(report.result, 'complete', report.message);
    assert.deepEqual(report.received, ['NEWNEW000001'], 'the known MID is not fetched again');
    assert.equal(modem.log.find((line) => line.startsWith('< FS ')), '< FS -+');
  } finally {
    await store.close();
    await modem.close();
  }
});

test('ARDOP is refused with a reason instead of half-run', async () => {
  const { store, userId } = await setup();
  try {
    const report = await runSession({
      store,
      account: (await store.getUser(userId))!,
      modem: { name: 'ARDOP', kind: 'ardop', host: '127.0.0.1', commandPort: 8515, dataPort: 8516 },
      target: 'OK1RAA',
      logger: createLogger('error'),
    });
    assert.equal(report.result, 'error');
    assert.match(report.message, /ARDOP/);
  } finally {
    await store.close();
  }
});

test('a peer-to-peer session offers only what is addressed to that station', async () => {
  // Two messages in OUTBOX: one for the station being dialled, one for somebody else
  // entirely. A peer cannot route the second, so it must not be proposed to it — and
  // must still be in OUTBOX afterwards, not lost to a session that could not deliver it.
  const modem = new ScriptedModem([], '+');
  await modem.listen();
  const store = new SqliteStore({ path: ':memory:' });
  await store.migrate();
  const user = await store.createUser({ callsign: 'OK4RM', pwHash: null, role: 'admin' });
  await store.setLocator(user.id, 'JO70AA');
  const outbox = await store.findFolder(user.id, 'OUTBOX');
  assert.ok(outbox);
  await store.insertMessage(
    user.id,
    outbox.id,
    composeMessage({ from: 'OK4RM', to: 'OK1RAA', subject: 'For the peer', body: 'Peer mail.\n', mid: 'FORPEER00001' }),
    { direction: 'out' },
  );
  await store.insertMessage(
    user.id,
    outbox.id,
    composeMessage({ from: 'OK4RM', to: 'OK2XYZ', subject: 'For somebody else', body: 'Not this one.\n', mid: 'NOTTHIS00001' }),
    { direction: 'out' },
  );

  try {
    const report = await runSession({
      store,
      account: (await store.getUser(user.id))!,
      modem: { name: 'VARA HF', kind: 'vara', host: '127.0.0.1', commandPort: modem.commandPort, dataPort: modem.dataPort },
      target: 'OK1RAA',
      mode: 'p2p',
      logger: createLogger('error'),
      silenceMs: 5_000,
      dialTimeoutMs: 5_000,
    });

    assert.equal(report.result, 'complete', report.message);
    assert.deepEqual(report.sent, ['FORPEER00001']);
    assert.deepEqual(report.received, []);
    // VARA HF is told this is a peer-to-peer call, not a Winlink one.
    assert.ok(modem.commandLines.includes('P2P SESSION'), 'a peer-to-peer call asks VARA for P2P framing');
    assert.ok(!modem.commandLines.includes('WINLINK SESSION'));
    // The other message never left the outbox.
    const stillOut = await store.findMessageByMid(user.id, 'NOTTHIS00001');
    assert.equal(stillOut?.folderId, outbox.id);
  } finally {
    await store.close();
    await modem.close();
  }
});
