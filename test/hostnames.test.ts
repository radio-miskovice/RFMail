import assert from 'node:assert/strict';
import test from 'node:test';
import { createSocket, type Socket } from 'node:dgram';
import {
  buildNbstatQuery,
  buildReverseQuery,
  parseMdnsPtr,
  parseNbstat,
  queryNbstat,
} from '@rfmail/server';

/** A DNS name as the wire has it: length-prefixed labels and a terminating zero. */
function encodeName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split('.')) parts.push(Buffer.from([label.length]), Buffer.from(label, 'latin1'));
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** The answer packet a Windows box sends: question echoed, then one NBSTAT record. */
function nbstatAnswer(request: Buffer, names: Array<{ name: string; suffix: number; group: boolean }>): Buffer {
  const questionEnd = 12 + 34 + 4;
  const question = request.subarray(12, questionEnd);
  const entries = names.map((entry) => {
    const name = Buffer.alloc(18);
    Buffer.from(entry.name.padEnd(15), 'latin1').copy(name, 0, 0, 15);
    name[15] = entry.suffix;
    name.writeUInt16BE(entry.group ? 0x8000 : 0x0000, 16);
    return name;
  });
  const rdata = Buffer.concat([Buffer.from([entries.length]), ...entries]);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(request.readUInt16BE(0), 0); // the caller's transaction id
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);

  const fixup = Buffer.alloc(12);
  fixup.writeUInt16BE(0x0021, 0); // NBSTAT
  fixup.writeUInt16BE(0x0001, 2);
  fixup.writeUInt32BE(0, 4);
  fixup.writeUInt16BE(rdata.length, 8);

  return Buffer.concat([header, question, Buffer.from([0x20]), Buffer.alloc(33), fixup.subarray(0, 10), rdata]);
}

test('the NBSTAT query asks for the wildcard name in type NBSTAT', () => {
  const query = buildNbstatQuery(0x4d42);
  assert.equal(query.length, 50, 'header, encoded name, type and class');
  assert.equal(query.readUInt16BE(0), 0x4d42);
  assert.equal(query.readUInt16BE(4), 1, 'one question');
  assert.equal(query[12], 0x20, 'first-level encoded');
  assert.equal(query.subarray(13, 15).toString('latin1'), 'CK', 'the nibbles of "*"');
  assert.equal(query.readUInt16BE(46), 0x0021, 'NBSTAT');
  assert.equal(query.readUInt16BE(48), 0x0001, 'IN');
});

test('the computer name is the unique workstation entry, not the workgroup', () => {
  const answer = nbstatAnswer(buildNbstatQuery(1), [
    { name: 'QUANTUM-Q1', suffix: 0x00, group: false },
    { name: 'MISKOVICE', suffix: 0x00, group: true },
    { name: 'QUANTUM-Q1', suffix: 0x20, group: false },
  ]);
  assert.equal(parseNbstat(answer), 'QUANTUM-Q1');

  // A box that only offers the file-server entry still has a name worth showing.
  const serverOnly = nbstatAnswer(buildNbstatQuery(2), [{ name: 'BOX', suffix: 0x20, group: false }]);
  assert.equal(parseNbstat(serverOnly), 'BOX');

  // A packet with groups only is a network description, not a machine.
  const groups = nbstatAnswer(buildNbstatQuery(3), [{ name: 'MISKOVICE', suffix: 0x00, group: true }]);
  assert.equal(parseNbstat(groups), null);

  assert.equal(parseNbstat(Buffer.from([1, 2, 3])), null, 'rubbish is not a name');
});

test('a name comes back from a NetBIOS responder', async () => {
  const socket: Socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()));
  const port = socket.address().port;
  socket.on('message', (message, remote) => {
    socket.send(
      nbstatAnswer(message, [
        { name: 'QUANTUM-Q1', suffix: 0x00, group: false },
        { name: 'MISKOVICE', suffix: 0x00, group: true },
      ]),
      remote.port,
      remote.address,
    );
  });
  try {
    assert.equal(await queryNbstat('127.0.0.1', port, 500), 'QUANTUM-Q1');
  } finally {
    socket.close();
  }
});

test('a host that answers nothing is a miss, not a hang', async () => {
  const silent: Socket = createSocket('udp4');
  await new Promise<void>((resolve) => silent.bind(0, '127.0.0.1', () => resolve()));
  const port = silent.address().port;
  const started = Date.now();
  try {
    assert.equal(await queryNbstat('127.0.0.1', port, 150), null);
    assert.ok(Date.now() - started < 1500, 'the timeout is the answer, not an error');
  } finally {
    silent.close();
  }
});

test('the mDNS question is a reverse PTR for the address, answered unicast', () => {
  const query = buildReverseQuery('192.168.133.222');
  assert.equal(query.readUInt16BE(4), 1);
  const text = query.toString('latin1');
  assert.ok(text.includes('222') && text.includes('133') && text.includes('192'));
  assert.ok(text.includes('in-addr') && text.includes('arpa'));
  assert.equal(query.readUInt16BE(query.length - 2), 0x8001, 'PTR, IN with the unicast bit');
});

test('an mDNS PTR answer names the machine, without the .local suffix', () => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  const owner = encodeName('222.133.168.192.in-addr.arpa');
  const target = encodeName('Quantum-Q1.local');
  const record = Buffer.alloc(10);
  record.writeUInt16BE(0x000c, 0); // PTR
  record.writeUInt16BE(0x0001, 2);
  record.writeUInt32BE(120, 4);
  record.writeUInt16BE(target.length, 8);
  const answer = Buffer.concat([header, owner, record, target]);
  assert.equal(parseMdnsPtr(answer), 'Quantum-Q1');

  // A name outside .local is returned as it stands.
  const foreign = Buffer.concat([
    header.subarray(0, 12),
    owner,
    record.subarray(0, 10),
    encodeName('nas04.example.net'),
  ]);
  foreign.writeUInt16BE(encodeName('nas04.example.net').length, 12 + owner.length + 8);
  assert.equal(parseMdnsPtr(foreign), 'nas04.example.net');
});
