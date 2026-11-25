// Telling one modem from another: VARA, XARA, Data2G and Mercury share ports and most of
// their command set, and `VERSION` is the only thing that names the program.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server, type Socket } from 'node:net';
import { parseModemVersion } from '@rfmail/shared';
import { identifyModem } from '../packages/server/src/modem-dial.ts';

test('each modem is recognised from the words it answers with', () => {
  // Measured on the air against Data2G 0.5.3; the others are the strings their own
  // VERSION replies carry (VARA "Return the VARA Version", XARA/Mercury likewise).
  const measured = parseModemVersion('VERSION Data2G 0.5.3\r');
  assert.equal(measured.kind, 'data2g');
  assert.equal(measured.version, 'Data2G 0.5.3');

  assert.equal(parseModemVersion('VERSION VARA HF 4.9.0\r').kind, 'vara');
  assert.equal(parseModemVersion('VERSION VARA FM 4.4.0\r').kind, 'vara-fm');
  assert.equal(parseModemVersion('VERSION XARA 0.1.3\r').kind, 'xara');
  assert.equal(parseModemVersion('VERSION Mercury 1.2.0\r').kind, 'mercury');
  // Case and spacing are the modem's business, not ours.
  assert.equal(parseModemVersion('version data2g 0.5.3').kind, 'data2g');
  assert.equal(parseModemVersion('VERSION VARA  SAT 4.4.5').kind, 'vara');
});

test('an answer we cannot name is reported as unnamed, never guessed at', () => {
  for (const reply of ['WRONG\r', '', 'OK\r', 'VERSION 4.9.0\r']) {
    const identity = parseModemVersion(reply);
    assert.equal(identity.kind, null, JSON.stringify(reply));
  }
  assert.equal(parseModemVersion('').line, '');
  assert.equal(parseModemVersion('VERSION Aether HF 1.0').version, 'Aether HF 1.0');
});

test('the probe asks VERSION and reports both liveness and identity', async () => {
  const answer = async (reply: string) => {
    const sockets = new Set<Socket>();
    const heard: string[] = [];
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        for (const line of chunk.split('\r').filter(Boolean)) {
          heard.push(line);
          if (line === 'VERSION') socket.write(reply);
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return { port: address.port, heard, close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } };
  };

  const data2g = await answer('VERSION Data2G 0.5.3\r');
  try {
    const probe = await identifyModem('127.0.0.1', data2g.port);
    assert.equal(probe.running, true);
    assert.equal(probe.identity?.kind, 'data2g');
    assert.deepEqual(data2g.heard, ['VERSION'], 'the probe sends the one command and nothing else');
  } finally {
    await data2g.close();
  }

  const silent = await answer('');
  try {
    const probe = await identifyModem('127.0.0.1', silent.port, 300);
    assert.equal(probe.running, true, 'a port that answers nothing is still listening');
    assert.equal(probe.identity, null, 'and its identity is unknown rather than invented');
  } finally {
    await silent.close();
  }

  const closed = await identifyModem('127.0.0.1', 1, 300);
  assert.equal(closed.running, false);
  assert.ok(closed.error);
});
