// The reason a session ended the way it did is worth recording: "failed" alone cannot
// tell a band that was busy from a modem that never answered.

import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server, type Socket } from 'node:net';
import type { Logger } from '@rfmail/shared';
import { SqliteStore } from '@rfmail/store';
import { runSession } from '../packages/server/src/session-run.ts';

interface Line { message: string; meta: Record<string, unknown> }

function capturing(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const push = (message: string, meta?: Record<string, unknown>): void => { lines.push({ message, meta: meta ?? {} }); };
  return { lines, logger: { debug: push, info: push, warn: push, error: push } };
}

async function silentModem(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('a call that never comes up is logged with the reason it did not', async () => {
  const store = new SqliteStore({ path: ':memory:' });
  await store.migrate();
  const user = await store.createUser({ callsign: 'OK4RM', pwHash: null, role: 'admin' });
  const modem = await silentModem();
  const { logger, lines } = capturing();

  try {
    const report = await runSession({
      store,
      account: (await store.getUser(user.id))!,
      modem: { name: 'Data2G@Q1', kind: 'data2g', host: '127.0.0.1', commandPort: modem.port, dataPort: 1 },
      target: 'YO4CIL-5',
      mode: 'cms',
      logger,
      dialTimeoutMs: 400,
    });

    assert.equal(report.result, 'failed');
    const failure = lines.find((line) => line.message === 'session dial failed');
    assert.ok(failure, 'the dial failure is logged');
    assert.match(String(failure.meta.reason), /no answer from YO4CIL-5/);
    assert.equal(failure.meta.result, 'failed');
    assert.equal(failure.meta.mode, 'cms');
    assert.equal(failure.meta.modem, 'Data2G@Q1');
  } finally {
    await store.close();
    await modem.close();
  }
});
