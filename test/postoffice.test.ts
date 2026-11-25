// The post office, end to end: a calling station dials in through a scripted
// VARA-family modem, the station challenges it, and mail moves both ways.
//
// The two ends are both rfmail's own engine — the client half is what dials a real
// RMS, so what is proven here is the listener, the routing and the session, not the
// protocol framing (which `session.test.ts` pins against a hand-written peer).

import assert from 'node:assert/strict';
import test from 'node:test';
import { connect, createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  Session,
  b2ToMessage,
  buildOutbound,
  composeMessage,
  messageToB2,
  type Duplex,
  type OutboundItem,
  type Proposal,
  type SessionHandler,
} from '@rfmail/core-b2f';
import { createLogger, openSecret, PostOffice, sealSecret } from '@rfmail/server';
import { FLAG_COLLECTED } from '@rfmail/shared';
import { SqliteStore } from '@rfmail/store';
import { tcpDuplex } from '../packages/server/src/tcp-duplex.ts';

const silent = createLogger('error', () => {});
const STORE_KEY = Buffer.alloc(32, 9).toString('base64');

/**
 * A modem that takes an inbound call: commands on one port (the post office keeps
 * that socket open), audio on another. `incoming()` plays the far end's modem by
 * announcing the call, and hands the post office's data socket to the test, which
 * runs the calling station's session over it.
 */
class InboundModem {
  readonly commands: string[] = [];
  private command: Server;
  private data: Server;
  private far: Server;
  private commandSocket: Socket | null = null;
  private listeners = new Set<string>();
  private callHandler: ((socket: Socket) => void) | null = null;
  private readonly sockets = new Set<Socket>();
  /** The three sockets of the bridge: the post office's data port, the cable's far
   *  side inside the modem, and the end the calling station's session runs on. */
  private postOfficeSide: Socket | null = null;
  private bridgeSide: Socket | null = null;
  private callSide: Socket | null = null;
  private farPort = 0;
  private bridged = false;
  calls = 0;

  private constructor(command: Server, data: Server, far: Server) {
    this.command = command;
    this.data = data;
    this.far = far;
  }

  static async start(): Promise<InboundModem> {
    let modem: InboundModem;
    const command = createServer((socket) => {
      modem.commandSocket = socket;
      modem.sockets.add(socket);
      socket.setEncoding('latin1');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const match = /[\r\n]/.exec(buffer);
          if (!match) break;
          const line = buffer.slice(0, match.index).trim();
          buffer = buffer.slice(match.index + 1);
          if (line === '') continue;
          modem.commands.push(line);
          if (/^MYCALL\b/i.test(line)) socket.write('OK\r');
          else if (/^LISTEN\s+ON$/i.test(line)) {
            modem.listeners.add('on');
            socket.write('OK\r');
          } else if (/^LISTEN\s+OFF$/i.test(line)) {
            modem.listeners.delete('on');
            socket.write('OK\r');
          } else if (/^DISCONNECT$/i.test(line)) {
            setTimeout(() => socket.write('DISCONNECTED\r'), 50);
          } else socket.write('OK\r');
        }
      });
    });
    // The modem is a bridge: the post office opens the data port on one side, the
    // calling station's audio comes out of the other.
    const far = createServer((accepted) => {
      modem.bridgeSide = accepted;
      modem.sockets.add(accepted);
      modem.bridge();
    });
    await listen(far);
    const data = createServer((po: Socket) => {
      modem.calls += 1;
      // Each call is a fresh bridge: the previous one's sockets are gone.
      modem.postOfficeSide = po;
      modem.bridgeSide = null;
      modem.callSide = null;
      modem.bridged = false;
      modem.sockets.add(po);
      // The modem's own bridge cable: the calling station's session runs on the
      // connector end, and what it writes comes out of the accepted end.
      const cable = connect({ host: '127.0.0.1', port: modem.farPort });
      cable.on('connect', () => {
        modem.callSide = cable;
        modem.sockets.add(cable);
        modem.bridge();
      });
      cable.on('error', () => po.destroy());
    });
    await listen(command);
    await listen(data);
    modem = new InboundModem(command, data, far);
    modem.farPort = (far.address() as AddressInfo).port;
    return modem;
  }

  private bridge(): void {
    if (this.bridged || !this.postOfficeSide || !this.bridgeSide || !this.callSide) return;
    this.bridged = true;
    this.postOfficeSide.pipe(this.bridgeSide);
    this.bridgeSide.pipe(this.postOfficeSide);
    this.callHandler?.(this.callSide);
  }

  get commandPort(): number {
    return (this.command.address() as AddressInfo).port;
  }

  get dataPort(): number {
    return (this.data.address() as AddressInfo).port;
  }

  get listening(): boolean {
    return this.listeners.has('on');
  }

  onCall(handler: (socket: Socket) => void): void {
    this.callHandler = handler;
  }

  /** The far end's modem dialling us: `<peer>` is the station calling in. */
  async incoming(peer: string, us: string): Promise<void> {
    assert.ok(this.commandSocket, 'the post office must hold the command socket');
    this.commandSocket.write(`CONNECTED ${us} ${peer} 2300\r`);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.command.close(() => resolve()));
    await new Promise<void>((resolve) => this.data.close(() => resolve()));
    await new Promise<void>((resolve) => this.far.close(() => resolve()));
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
}

interface World {
  /** The station's own database: the post office's accounts and their mail. */
  store: SqliteStore;
  /**
   * The calling station's database. A separate store on purpose: both halves in one
   * database would see each other's MIDs and every proposal would be a duplicate.
   */
  client: SqliteStore;
  ownerId: number;
  userId: number;
  ownerInbox: number;
  userInbox: number;
  userOutbox: number;
  clientInbox: number;
  clientOutbox: number;
  clientUserId: number;
  postOffice: PostOffice;
  modem: InboundModem;
  close: () => Promise<void>;
}

async function world(): Promise<World> {
  const store = new SqliteStore({ path: ':memory:' });
  await store.migrate();
  // The station's own identity, with both credentials a challenge can be answered
  // with; and one user of the post office.
  const owner = await store.createUser({ callsign: 'OK4RM', pwHash: null, role: 'admin' });
  await store.setPostOfficeOwner(owner.id);
  await store.setPostOfficeSecret(owner.id, sealSecret('tajne', STORE_KEY));
  const user = await store.createUser({ callsign: 'OK2XYZ', pwHash: null, role: 'user' });
  await store.setPostOfficeSecret(user.id, sealSecret('druhe', STORE_KEY));

  // One message waiting for each: the owner has mail for the calling station, and
  // the calling station has mail for the owner.
  const userInbox = (await store.findFolder(user.id, 'INBOX'))!.id;
  const ownerInbox = (await store.findFolder(owner.id, 'INBOX'))!.id;
  const userOutbox = (await store.findFolder(user.id, 'OUTBOX'))!.id;
  await store.insertMessage(
    user.id,
    userInbox,
    composeMessage({
      mid: 'POUCH0000001',
      from: 'OK4RM',
      to: 'OK2XYZ',
      subject: 'Waiting for you',
      body: 'Pick this up over the air.\n',
    }),
    { direction: 'in', peer: 'OK4RM' },
  );

  // The calling station's own store: one account, its folders, its mail.
  const client = new SqliteStore({ path: ':memory:' });
  await client.migrate();
  const station = await client.createUser({ callsign: 'OK2XYZ', pwHash: null, role: 'user' });
  const clientInbox = (await client.findFolder(station.id, 'INBOX'))!.id;
  const clientOutbox = (await client.findFolder(station.id, 'OUTBOX'))!.id;

  const modem = await InboundModem.start();
  const postOffice = new PostOffice({
    store,
    logger: silent,
    openSecret: (blob) => openSecret(blob, STORE_KEY),
    silenceMs: 5_000,
  });
  return {
    store,
    client,
    ownerId: owner.id,
    userId: user.id,
    ownerInbox,
    userInbox,
    userOutbox,
    clientInbox,
    clientOutbox,
    clientUserId: station.id,
    postOffice,
    modem,
    close: async () => {
      await postOffice.disarm();
      await modem.close();
      await store.close();
      await client.close();
    },
  };
}

/** The calling station's half: its outbox out, the far end's mail into its INBOX. */
function clientHandler(
  store: SqliteStore,
  userId: number,
  outboxId: number,
  inboxId: number,
): { handler: SessionHandler; received: string[] } {
  const prepared = new Map<string, OutboundItem>();
  const settled = new Set<string>();
  const received: string[] = [];
  return {
    received,
    handler: {
      outbound: async () => {
        const listing = await store.listMessages(userId, outboxId, { limit: 50 });
        const items: OutboundItem[] = [];
        for (const envelope of listing.messages) {
          if (settled.has(envelope.mid)) continue;
          const mail = await store.getMailMessage(userId, envelope.id);
          if (!mail) continue;
          const item = buildOutbound(messageToB2(mail));
          prepared.set(envelope.mid, item);
          items.push(item);
        }
        return items;
      },
      sent: (mid) => settled.add(mid),
      rejected: (mid) => settled.add(mid),
      deferred: () => {},
      answer: async (proposal: Proposal) =>
        (await store.findMessageByMid(userId, proposal.mid)) ? '-' : '+',
      received: async (message) => {
        received.push(message.mid);
        await store.insertMessage(userId, inboxId, b2ToMessage(message), {
          direction: 'in',
          peer: message.from,
        });
      },
    },
  };
}

async function arm(w: World): Promise<void> {
  const owner = await w.store.getUser(w.ownerId);
  assert.ok(owner);
  await w.postOffice.arm({
    owner,
    modem: {
      id: 1,
      name: 'Data2G',
      host: '127.0.0.1',
      commandPort: w.modem.commandPort,
      dataPort: w.modem.dataPort,
    },
    frequencyHz: 3_597_000,
  });
  await waitFor(() => w.modem.listening);
  assert.ok(w.modem.listening, 'arming must put the modem in LISTEN ON');
}

test('a calling station collects its mail and leaves its own, both authenticated', async () => {
  const w = await world();
  try {
    await arm(w);
    const user = await w.store.getUser(w.userId);
    assert.ok(user);
    const client = clientHandler(w.client, w.clientUserId, w.clientOutbox, w.clientInbox);

    // The calling station's own outbound message, as its composer leaves it.
    await w.client.insertMessage(
      w.clientUserId,
      w.clientOutbox,
      composeMessage({
        mid: 'POOUT0000001',
        from: 'OK2XYZ',
        to: 'OK4RM',
        subject: 'From the field',
        body: 'Two lines.\nSecond.\n',
      }),
      { direction: 'out' },
    );

    const exchanges: Array<Awaited<ReturnType<Session['run']>>> = [];
    w.modem.onCall((socket) => {
      void (async () => {
        const session = new Session({
          myCallsign: 'OK2XYZ',
          target: 'OK4RM',
          mode: 'postoffice',
          password: 'druhe',
          handler: client.handler,
          silenceMs: 5_000,
        });
        exchanges.push(await session.run(tcpDuplex(socket)));
        await new Promise((resolve) => setTimeout(resolve, 50));
      })();
    });

    await w.modem.incoming('OK2XYZ', 'OK4RM');
    await waitFor(() => exchanges.length === 1 && w.postOffice.snapshot().sessions.length >= 1);
    // The call is closed properly and the station is listening again.
    await waitFor(() => !w.postOffice.snapshot().busy && w.modem.commands.filter((line) => /^LISTEN ON$/i.test(line)).length >= 2);

    const exchange = exchanges[0]!;
    assert.equal(exchange.result, 'complete', exchange.error ?? '');
    assert.equal(exchange.secureLogin, 'answered');

    // The owner has the calling station's message in its INBOX.
    const forOwner = await w.store.listMessages(w.ownerId, w.ownerInbox);
    assert.deepEqual(
      forOwner.messages.map((message) => message.mid),
      ['POOUT0000001'],
    );
    assert.deepEqual(forOwner.messages[0]?.to, ['OK4RM']);

    // The calling station got the message that was waiting for it…
    assert.deepEqual(client.received, ['POUCH0000001']);
    // …and it will not be offered again: collected, not deleted.
    const held = (await w.store.listMessages(w.userId, w.userInbox)).messages.find(
      (message) => message.mid === 'POUCH0000001',
    );
    assert.ok(held);
    assert.equal(held.flags & FLAG_COLLECTED, FLAG_COLLECTED);
    assert.ok(w.modem.commands.includes('MYCALL OK4RM'));
    assert.ok(w.modem.commands.includes('DISCONNECT'), 'the call is closed, not left holding a transmitter');
    assert.ok(
      w.modem.commands.filter((line) => /^LISTEN ON$/i.test(line)).length >= 2,
      'listening is re-armed after the call',
    );
  } finally {
    await w.close();
  }
});

test('a second call is offered nothing, because the mail was collected once', async () => {
  const w = await world();
  try {
    await arm(w);
    const client = clientHandler(w.client, w.clientUserId, w.clientOutbox, w.clientInbox);
    const exchanges: Array<Awaited<ReturnType<Session['run']>>> = [];
    w.modem.onCall((socket) => {
      void (async () => {
        const session = new Session({
          myCallsign: 'OK2XYZ',
          target: 'OK4RM',
          mode: 'postoffice',
          password: 'druhe',
          handler: client.handler,
          silenceMs: 5_000,
        });
        exchanges.push(await session.run(tcpDuplex(socket)));
      })();
    });

    await w.modem.incoming('OK2XYZ', 'OK4RM');
    await waitFor(() => exchanges.length === 1);
    await waitFor(() => w.postOffice.snapshot().sessions.length === 1 && !w.postOffice.snapshot().busy);
    assert.deepEqual(client.received, ['POUCH0000001']);

    await w.modem.incoming('OK2XYZ', 'OK4RM');
    await waitFor(() => exchanges.length === 2);
    assert.equal(exchanges[1]?.result, 'complete', exchanges[1]?.error ?? '');
    assert.deepEqual(client.received, ['POUCH0000001'], 'collected mail is not offered again');
  } finally {
    await w.close();
  }
});

test('a station with the wrong password is refused before any mail is offered', async () => {
  const w = await world();
  try {
    await arm(w);
    const client = clientHandler(w.client, w.clientUserId, w.clientOutbox, w.clientInbox);
    const exchanges: Array<Awaited<ReturnType<Session['run']>>> = [];
    w.modem.onCall((socket) => {
      void (async () => {
        const session = new Session({
          myCallsign: 'OK2XYZ',
          target: 'OK4RM',
          mode: 'postoffice',
          password: 'wrong',
          handler: client.handler,
          silenceMs: 5_000,
        });
        exchanges.push(await session.run(tcpDuplex(socket)));
      })();
    });

    await w.modem.incoming('OK2XYZ', 'OK4RM');
    await waitFor(() => exchanges.length === 1);

    const exchange = exchanges[0]!;
    assert.equal(exchange.result, 'failed');
    assert.match(exchange.error ?? '', /secure-login/);
    assert.deepEqual(client.received, [], 'nothing was offered to an unauthenticated station');
    // The post office recorded the refusal rather than a completed session.
    const status = w.postOffice.snapshot();
    assert.equal(status.sessions[0]?.result, 'failed');
    assert.equal(status.armed, true, 'a refused call leaves the station armed');
  } finally {
    await w.close();
  }
});

test('an account with no credential at all cannot collect mail', async () => {
  const w = await world();
  try {
    // An account on the post office's side (so it exists) with no credential at all.
    await w.store.createUser({ callsign: 'OK9ZZZ', pwHash: null, role: 'user' });
    // …and the calling station's own mailbox, which has nothing to do with it.
    const stranger = await w.client.createUser({ callsign: 'OK9ZZZ', pwHash: null, role: 'user' });
    await arm(w);
    const inbox = (await w.client.findFolder(stranger.id, 'INBOX'))!;
    const outbox = (await w.client.findFolder(stranger.id, 'OUTBOX'))!;
    const client = clientHandler(w.client, stranger.id, outbox.id, inbox.id);
    const exchanges: Array<Awaited<ReturnType<Session['run']>>> = [];
    w.modem.onCall((socket) => {
      void (async () => {
        const session = new Session({
          myCallsign: 'OK9ZZZ',
          target: 'OK4RM',
          mode: 'postoffice',
          password: 'anything',
          handler: client.handler,
          silenceMs: 5_000,
        });
        exchanges.push(await session.run(tcpDuplex(socket)));
      })();
    });

    await w.modem.incoming('OK9ZZZ', 'OK4RM');
    await waitFor(() => exchanges.length === 1);
    assert.equal(exchanges[0]?.result, 'failed');
    assert.deepEqual(client.received, []);
  } finally {
    await w.close();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the condition');
}

void (0 as unknown as Duplex);
