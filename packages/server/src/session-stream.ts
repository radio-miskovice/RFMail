// The live view of a running session: what the modem says, what the far end says, and the one
// control that stops it (decision 51).
//
// A session is a conversation over TCP with a modem's command port and its data port, and while
// it runs the operator is blind: the B2F exchange can spend minutes repeating a frame to a signal
// that has faded. This module carries those two streams to the browser over a WebSocket — the
// command channel's words and the protocol's lines, each as it happens — and gives the screen the
// two-step stop an operator actually needs: ask the link to come down, and if that does not
// happen quickly, cut it.
//
// The WebSocket is implemented here rather than pulled in: the handshake and the few frame types
// this needs are a hundred lines, and the rest of the station already speaks its protocols by
// hand rather than through a library.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The token a browser checks in `Sec-WebSocket-Accept`: sha1 of the key and the protocol's GUID. */
export function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}
/** How many events a channel keeps for a screen that connects a moment late. */
const BACKLOG = 400;
/** How many channels may exist at once; a screen opens its own before its session starts. */
const MAX_CHANNELS = 64;

export type SessionEvent =
  | { t: 'state'; state: 'dialing' | 'connected' | 'exchange' | 'closing' | 'done'; detail: string | null }
  | { t: 'modem'; dir: '>' | '<'; text: string; atMs: number }
  | { t: 'line'; dir: '>' | '<'; text: string; atMs: number }
  /** Data that is not text: the first bytes in hex, and how many arrived. */
  | { t: 'hex'; dir: '>' | '<'; hex: string; count: number; atMs: number }
  | { t: 'end'; result: string; message: string };

/** What a running session lets the screen do to it. */
export interface SessionControl {
  /** Ask the link to come down: the modem is told to disconnect and the data socket closes. */
  disconnect(): void;
  /** Cut both sockets now, with no closing sequence and no waiting. */
  abort(): void;
}

/** One open WebSocket, speaking just enough of RFC 6455 to carry text frames. */
class WsClient {
  private readonly socket: Duplex;
  private closed = false;

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {
      this.closed = true;
    });
    socket.on('data', (chunk: Buffer) => this.read(chunk));
  }

  get isClosed(): boolean {
    return this.closed || this.socket.destroyed;
  }

  send(text: string): void {
    if (this.isClosed) return;
    const payload = Buffer.from(text, 'utf8');
    this.socket.write(Buffer.concat([frame(0x1, payload)]));
  }

  close(): void {
    if (this.isClosed) return;
    this.socket.write(Buffer.concat([frame(0x8, Buffer.alloc(0))]));
    this.socket.end();
    this.closed = true;
  }

  /** Frames from the browser: a close ends the connection, a ping is answered. Nothing else. */
  private read(chunk: Buffer): void {
    const opcode = chunk[0] !== undefined ? chunk[0] & 0x0f : 0;
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(Buffer.concat([frame(0xa, Buffer.alloc(0))]));
    }
  }
}

/** One text frame, unmasked: the server side of a WebSocket never masks. */
function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : (() => {
            const head = Buffer.alloc(10);
            head[0] = 0x80 | opcode;
            head[1] = 127;
            head.writeBigUInt64BE(BigInt(length), 2);
            return head;
          })();
  return Buffer.concat([header, payload]);
}

/** One session's channel: a backlog, the screens watching it, and the stop control. */
class Channel {
  readonly id: string;
  private readonly clients = new Set<WsClient>();
  private readonly backlog: SessionEvent[] = [];
  private control: SessionControl | null = null;
  /** `idle` until someone asks for the link to come down. */
  private phase: 'idle' | 'disconnecting' | 'aborted' = 'idle';

  constructor(id: string) {
    this.id = id;
  }

  publish(event: SessionEvent): void {
    this.backlog.push(event);
    if (this.backlog.length > BACKLOG) this.backlog.shift();
    const text = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.isClosed) this.clients.delete(client);
      else client.send(text);
    }
  }

  attach(socket: Duplex): void {
    const client = new WsClient(socket);
    // A screen that connects a moment after the session started still sees the beginning.
    for (const event of this.backlog) client.send(JSON.stringify(event));
    this.clients.add(client);
  }

  bind(control: SessionControl): void {
    this.control = control;
  }

  /**
   * The single control, in two steps: the first call asks the link to come down, the second —
   * while that is still happening — cuts it. That is the operator's sequence when a signal has
   * faded: stop asking politely, then stop waiting.
   */
  stop(): 'idle' | 'disconnecting' | 'aborted' {
    if (!this.control) return this.phase;
    if (this.phase === 'idle') {
      this.phase = 'disconnecting';
      this.publish({ t: 'state', state: 'closing', detail: 'disconnecting the link' });
      this.control.disconnect();
      return this.phase;
    }
    if (this.phase === 'disconnecting') {
      this.phase = 'aborted';
      this.publish({ t: 'state', state: 'closing', detail: 'aborting' });
      this.control.abort();
      return this.phase;
    }
    return this.phase;
  }

  get stopped(): 'disconnecting' | 'aborted' | null {
    return this.phase === 'idle' ? null : this.phase;
  }
}

export class SessionStreams {
  private readonly channels = new Map<string, Channel>();

  open(id: string): Channel {
    const existing = this.channels.get(id);
    if (existing) return existing;
    const channel = new Channel(id);
    this.channels.set(id, channel);
    return channel;
  }

  get(id: string): Channel | null {
    return this.channels.get(id) ?? null;
  }

  forget(id: string): void {
    this.channels.delete(id);
  }

  /**
   * The WebSocket handshake for `GET /api/session/ws?id=…`, on the HTTP server's `upgrade`
   * event. Returns false when the request is not for this path, so the caller can refuse it
   * in its own way.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, authenticated: boolean): boolean {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/session/ws') return false;
    const key = req.headers['sec-websocket-key'];
    if (!authenticated || typeof key !== 'string') {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return true;
    }
    const id = url.searchParams.get('id') ?? '';
    // The screen opens its view before it starts the session, so the channel is made here and
    // the run joins it a moment later. A name that is not an id, or a screen that opens more
    // channels than there are sessions, is refused.
    if (!/^[\w.-]{1,64}$/.test(id) || (!this.get(id) && this.channels.size >= MAX_CHANNELS)) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return true;
    }
    const channel = this.open(id);
    const accept = websocketAccept(key);
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
    channel.attach(socket);
    return true;
  }
}
