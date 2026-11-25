// A scripted Winlink station on the far end: a modem's command port, a data port,
// and the gateway half of a B2 exchange written out by hand.
//
// Used by the session tests so the engine and the API route are exercised over
// real sockets: the command port answers `CONNECT` with `CONNECTED` and hangs up on
// `DISCONNECT`, and the data port plays the other side of the protocol.

import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import {
  ByteReader,
  TransferDecoder,
  buildOutbound,
  decompressB2,
  encodeTransfer,
  formatProposalBlock,
  parseB2Message,
  parseProposal,
  type B2Message,
  type OutboundItem,
  type Proposal,
} from '@rfmail/core-b2f';
import { tcpDuplex } from '../../packages/server/src/tcp-duplex.ts';

export const GW_SID = '[WL2K-5.0-B2FWIHJM$]';

export function proposalOf(item: OutboundItem): Proposal {
  return {
    code: item.code,
    messageType: item.type,
    mid: item.mid,
    size: item.raw.length,
    compressedSize: item.compressed.length,
  };
}

export function outboundMessage(
  mid: string,
  from: string,
  to: string[],
  subject: string,
  body: string,
): B2Message {
  return {
    mid,
    dateUtc: Date.UTC(2026, 10, 24, 19, 0),
    from,
    to,
    cc: [],
    subject,
    type: 'Private',
    mbo: '',
    body,
    charset: 'UTF-8',
    attachments: [],
    headers: [],
  };
}

export class ScriptedModem {
  private readonly commandServer: Server;
  private readonly dataServer: Server;
  private readonly sockets = new Set<Socket>();
  readonly commandLines: string[] = [];
  dataPort = 0;
  /** The gateway's answer to each proposal the station makes: `+`, `-` or `=`. */
  answer: string;
  /** What the gateway offers on its own turn. */
  inbound: B2Message[];
  /** MIDs and bodies the station transmitted, as the far end decoded them. */
  readonly received: Array<{ mid: string; body: string }> = [];
  /** Every line the gateway side sent and received, for assertions. */
  readonly log: string[] = [];
  constructor(inbound: B2Message[] = [], answer = '+') {
    this.inbound = inbound;
    this.answer = answer;
    this.commandServer = createServer((socket) => {
      this.sockets.add(socket);
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (let index = buffer.indexOf('\r'); index >= 0; index = buffer.indexOf('\r')) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          this.commandLines.push(line);
          if (line.startsWith('CONNECT ')) socket.write('CONNECTED 2300\r');
          if (line === 'DISCONNECT') {
            socket.write('DISCONNECTED\r');
            socket.end();
          }
        }
      });
      socket.on('error', () => undefined);
    });
    this.dataServer = createServer((socket) => {
      this.sockets.add(socket);
      void this.playGateway(socket).catch(() => socket.destroy());
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.commandServer.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => this.dataServer.listen(0, '127.0.0.1', resolve));
    const address = this.dataServer.address();
    assert.ok(address && typeof address === 'object');
    this.dataPort = address.port;
  }

  get commandPort(): number {
    const address = this.commandServer.address();
    assert.ok(address && typeof address === 'object');
    return address.port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.commandServer.close(() => resolve()));
    await new Promise<void>((resolve) => this.dataServer.close(() => resolve()));
  }

  private async playGateway(socket: Socket): Promise<void> {
    const reader = new ByteReader(tcpDuplex(socket));
    const send = (line: string): void => {
      this.log.push(`> ${line}`);
      socket.write(`${line}\r`);
    };
    const read = async (): Promise<string> => {
      const line = await reader.line();
      this.log.push(`< ${line}`);
      return line;
    };

    send(GW_SID);
    send('; OK4RM DE OK1RAA (JO70AA)>');

    // The station's handshake: ;FW, SID, greeting.
    for (let index = 0; index < 3; index += 1) await read();

    // Its turn: proposals and their checksum, answered as scripted — or an FF when
    // its outbox is empty.
    const offered: Proposal[] = [];
    let stationOffered = true;
    for (;;) {
      const line = await read();
      if (line === 'FF') {
        stationOffered = false;
        break;
      }
      if (line === 'FQ') return;
      if (line.startsWith('F> ')) break;
      offered.push(parseProposal(line));
    }

    if (stationOffered) {
      send(`FS ${offered.map(() => this.answer).join('')}`);
      // The frames of what we accepted.
      for (const proposal of offered) {
        if (this.answer !== '+') continue;
        const payload = await readTransfer(reader);
        const message = parseB2Message(decompressB2(payload));
        this.received.push({ mid: proposal.mid, body: message.body });
      }
    }

    // Our turn: offer the gateway's own mail, then send what the station accepts.
    const entries = this.inbound.map((message) => {
      const item = buildOutbound(message);
      return { item, proposal: proposalOf(item) };
    });
    if (entries.length === 0) {
      // A turn with nothing to offer is an FF; the station then quits.
      send('FF');
      await read();
      return;
    }

    for (const line of formatProposalBlock(entries.map((entry) => entry.proposal))) send(line);
    const answers = (await read()).replace(/^FS ?/, '');
    entries.forEach((entry, index) => {
      if (answers[index] === '+') {
        socket.write(encodeTransfer({ title: entry.item.subject, offset: 0 }, entry.item.compressed));
      }
    });

    // The station's next turn: nothing left on its side, so it says FF and we quit.
    const last = await read();
    if (last === 'FF') send('FQ');
  }
}

async function readTransfer(reader: ByteReader): Promise<Uint8Array> {
  const decoder = new TransferDecoder();
  for (;;) {
    const chunk = await reader.take();
    for (const event of decoder.push(chunk)) {
      if (event.type === 'end') {
        reader.unshift(decoder.drain());
        return event.payload;
      }
      if (event.type === 'remote-error') throw new Error(`the station refused a message: ${event.line}`);
    }
  }
}
