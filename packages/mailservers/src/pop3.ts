// POP3 (RFC 1939) retrieval of a user's INBOX.
//
// Scope for this milestone: retrieval only, no APOP, no TLS yet. Deleted
// messages are removed on QUIT, as the protocol specifies; the web client's
// delete moves to TRASH instead, so a mail program that deletes is doing
// something the user asked for.

import { createServer, type Server, type Socket } from 'node:net';
import { serialiseRfc822, type MailMessage } from '@rfmail/core-b2f';
import { findUserByCredential } from './identity.ts';
import type { Logger } from '@rfmail/shared';
import {
  verifyPassword,
  type MessageEnvelope,
  type Store,
  type UserRecord,
} from '@rfmail/store';
import type { PeerPolicy } from './access.ts';

export interface Pop3Options {
  store: Store;
  policy: PeerPolicy;
  host: string;
  port: number;
  logger: Logger;
  idleTimeoutMs?: number;
  maxMessages?: number;
}

interface SessionState {
  user: UserRecord | null;
  folderId: number;
  messages: MessageEnvelope[];
  sizes: Map<number, number>;
  bodies: Map<number, Buffer>;
  deleted: Set<number>;
}

export class Pop3Server {
  private readonly opts: Pop3Options;
  private server: Server | null = null;
  private readonly connections = new Set<Socket>();
  /** One maildrop per account at a time. */
  private readonly locks = new Map<number, Socket>();

  constructor(options: Pop3Options) {
    this.opts = options;
  }

  get address(): string {
    if (!this.server) return `${this.opts.host}:${this.opts.port}`;
    const found = this.server.address();
    if (found && typeof found === 'object') return `${found.address}:${found.port}`;
    return `${this.opts.host}:${this.opts.port}`;
  }

  async listen(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => {
      void this.handle(socket);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.opts.port, this.opts.host);
    });
    this.opts.logger.info('pop3 listening', {
      address: this.address,
      access: this.opts.policy.describe(),
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (!server) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref();
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async handle(socket: Socket): Promise<void> {
    const remote = socket.remoteAddress ?? '';
    if (!this.opts.policy.allows(remote)) {
      this.opts.logger.warn('pop3 connection refused by access policy', { remote });
      socket.end('-ERR service not available from this address\r\n');
      return;
    }

    this.connections.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(this.opts.idleTimeoutMs ?? 10 * 60 * 1000);
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());

    const state: SessionState = {
      user: null,
      folderId: 0,
      messages: [],
      sizes: new Map(),
      bodies: new Map(),
      deleted: new Set(),
    };

    const write = (line: string): void => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };

    write('+OK rfmail POP3 ready');

    try {
      for await (const line of readLines(socket)) {
        const trimmed = line.replace(/\r$/, '');
        if (trimmed.trim() === '') continue;
        const space = trimmed.indexOf(' ');
        const command = (space === -1 ? trimmed : trimmed.slice(0, space)).toUpperCase();
        const argument = space === -1 ? '' : trimmed.slice(space + 1).trim();

        if (command === 'QUIT') {
          await this.release(socket, state, true);
          write('+OK rfmail signing off');
          socket.end();
          return;
        }

        if (command === 'CAPA') {
          write('+OK Capability list follows');
          write('USER');
          write('TOP');
          write('UIDL');
          write('IMPLEMENTATION rfmail');
          write('.');
          continue;
        }

        if (command === 'USER') {
          if (!argument) {
            write('-ERR username required');
            continue;
          }
          // Hold the name; authentication happens on PASS.
          state.user = { ...(state.user ?? emptyUser()), login: argument };
          write('+OK send your password');
          continue;
        }

        if (command === 'PASS') {
          const login = state.user?.login ?? '';
          if (!login) {
            write('-ERR send USER first');
            continue;
          }
          const user = await findUserByCredential(this.opts.store, login);
          if (!user || !user.enabled) {
            this.opts.logger.warn('pop3 login failed', { login, remote });
            write('-ERR [AUTH] invalid credentials');
            continue;
          }
          if (!verifyPassword(argument, user.pwHash)) {
            this.opts.logger.warn('pop3 login failed', { login, remote });
            write('-ERR [AUTH] invalid credentials');
            continue;
          }
          const mailbox = await this.openMailbox(socket, user);
          if (!mailbox) {
            write('-ERR [IN-USE] maildrop is locked by another session');
            continue;
          }
          state.user = user;
          state.folderId = mailbox.folderId;
          state.messages = mailbox.messages;
          write(`+OK ${state.messages.length} message(s)`);
          continue;
        }

        if (!isAuthenticated(state)) {
          write(isPreAuth(command) ? '-ERR unknown command' : '-ERR authenticate first');
          continue;
        }

        await this.dispatch(socket, state, command, argument, write);
      }
    } catch (err) {
      this.opts.logger.warn('pop3 session error', {
        remote,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await this.release(socket, state, false);
      this.connections.delete(socket);
      socket.destroy();
    }
  }

  private async openMailbox(
    socket: Socket,
    user: UserRecord,
  ): Promise<{ folderId: number; messages: MessageEnvelope[] } | null> {
    const inbox = await this.opts.store.findFolder(user.id, 'INBOX');
    if (!inbox) return null;
    const existing = this.locks.get(user.id);
    if (existing && existing !== socket && !existing.destroyed) return null;
    this.locks.set(user.id, socket);
    const list = await this.opts.store.listMessages(user.id, inbox.id, {
      limit: this.opts.maxMessages ?? 20000,
    });
    return { folderId: inbox.id, messages: list.messages };
  }

  private async release(socket: Socket, state: SessionState, commit: boolean): Promise<void> {
    const user = state.user;
    if (user && user.id !== 0) {
      if (commit && state.deleted.size > 0) {
        for (const index of state.deleted) {
          const message = state.messages[index];
          if (message) await this.opts.store.deleteMessage(user.id, message.id);
        }
      }
      if (this.locks.get(user.id) === socket) this.locks.delete(user.id);
    }
    state.deleted.clear();
  }

  private async dispatch(
    socket: Socket,
    state: SessionState,
    command: string,
    argument: string,
    write: (line: string) => void,
  ): Promise<void> {
    const user = state.user;
    if (!user) return;
    // POP3 message numbers are 1-based; the store indexes from 0.
    const index = Number.parseInt(argument, 10) - 1;

    switch (command) {
      case 'STAT': {
        let count = 0;
        let total = 0;
        for (let i = 0; i < state.messages.length; i += 1) {
          if (state.deleted.has(i)) continue;
          count += 1;
          total += await this.sizeOf(state, i);
        }
        write(`+OK ${count} ${total}`);
        return;
      }
      case 'LIST': {
        if (argument) {
          this.assertIndex(state, index, write);
          if (!this.validIndex(state, index)) return;
          write(`+OK ${index + 1} ${await this.sizeOf(state, index)}`);
          return;
        }
        write('+OK scan listing follows');
        for (let i = 0; i < state.messages.length; i += 1) {
          if (state.deleted.has(i)) continue;
          write(`${i + 1} ${await this.sizeOf(state, i)}`);
        }
        write('.');
        return;
      }
      case 'UIDL': {
        if (argument) {
          this.assertIndex(state, index, write);
          if (!this.validIndex(state, index)) return;
          const message = state.messages[index];
          if (!message) return;
          write(`+OK ${index + 1} ${message.uid}`);
          return;
        }
        write('+OK unique-id listing follows');
        for (let i = 0; i < state.messages.length; i += 1) {
          if (state.deleted.has(i)) continue;
          const message = state.messages[i];
          if (message) write(`${i + 1} ${message.uid}`);
        }
        write('.');
        return;
      }
      case 'RETR': {
        this.assertIndex(state, index, write);
        if (!this.validIndex(state, index)) return;
        const body = await this.bodyOf(state, index);
        write(`+OK ${body.length} octets`);
        socket.write(dotStuff(body));
        write('.');
        return;
      }
      case 'TOP': {
        const [indexPart = '', linesPart = '0'] = argument.split(/\s+/);
        const topIndex = Number.parseInt(indexPart, 10) - 1;
        this.assertIndex(state, topIndex, write);
        if (!this.validIndex(state, topIndex)) return;
        const lineCount = Math.max(0, Number.parseInt(linesPart, 10) || 0);
        const body = await this.bodyOf(state, topIndex);
        const split = body.indexOf('\r\n\r\n');
        const head = split === -1 ? body : body.subarray(0, split + 4);
        const rest = split === -1 ? Buffer.alloc(0) : body.subarray(split + 4);
        const tailLines = rest.toString('latin1').split('\r\n').slice(0, lineCount);
        write('+OK top of message follows');
        socket.write(head);
        if (lineCount > 0) socket.write(dotStuff(Buffer.from(`${tailLines.join('\r\n')}\r\n`, 'latin1')));
        write('.');
        return;
      }
      case 'DELE': {
        this.assertIndex(state, index, write);
        if (!this.validIndex(state, index)) return;
        state.deleted.add(index);
        write(`+OK message ${index + 1} deleted`);
        return;
      }
      case 'RSET': {
        state.deleted.clear();
        write('+OK maildrop has been reset');
        return;
      }
      case 'NOOP': {
        write('+OK');
        return;
      }
      default:
        write('-ERR unknown command');
    }
  }

  private validIndex(state: SessionState, index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= state.messages.length) return false;
    return !state.deleted.has(index);
  }

  private assertIndex(state: SessionState, index: number, write: (line: string) => void): void {
    if (!Number.isInteger(index) || index < 0 || index >= state.messages.length) {
      write('-ERR no such message');
    } else if (state.deleted.has(index)) {
      write('-ERR message deleted');
    }
  }

  private async sizeOf(state: SessionState, index: number): Promise<number> {
    const cached = state.sizes.get(index);
    if (cached !== undefined) return cached;
    const body = await this.bodyOf(state, index);
    state.sizes.set(index, body.length);
    return body.length;
  }

  private async bodyOf(state: SessionState, index: number): Promise<Buffer> {
    const cached = state.bodies.get(index);
    if (cached) return cached;
    const user = state.user;
    const envelope = state.messages[index];
    if (!user || !envelope) throw new Error('no such message');
    const record = await this.opts.store.getMessage(user.id, envelope.id);
    if (!record) throw new Error('message vanished');
    const attachments = [];
    for (const meta of record.attachments) {
      const found = await this.opts.store.getAttachment(user.id, record.id, meta.id);
      if (found) {
        attachments.push({
          name: found.meta.name,
          contentType: found.meta.contentType,
          data: found.data,
        });
      }
    }
    const message: MailMessage = {
      mid: record.mid,
      messageId: record.messageId,
      from: record.from,
      to: record.to,
      cc: record.cc,
      subject: record.subject,
      dateUtc: record.dateUtc,
      body: record.body,
      charset: record.charset,
      headers: record.headers,
      attachments,
    };
    const body = Buffer.from(serialiseRfc822(message));
    state.bodies.set(index, body);
    return body;
  }
}

function isAuthenticated(state: SessionState): boolean {
  return state.user !== null && state.user.id !== 0;
}

function isPreAuth(command: string): boolean {
  return command === 'USER' || command === 'PASS' || command === 'APOP' || command === 'AUTH';
}

function emptyUser(): UserRecord {
  return {
    id: 0,
    login: '',
    role: 'user',
    enabled: true,
    quotaBytes: 0,
    pwHash: null,
    callsign: null,
    locator: null,
    winlinkSecret: null,
    createdAt: 0,
  };
}

/** Doubles a leading dot on every line, as POP3 requires for RETR/TOP data. */
function dotStuff(body: Buffer): Buffer {
  const text = body.toString('latin1');
  const stuffed = text.replace(/(^|\r\n)\./g, '$1..');
  return Buffer.from(stuffed, 'latin1');
}

async function* readLines(socket: Socket): AsyncGenerator<string> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of socket) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    for (;;) {
      const crlf = buffer.indexOf('\r\n');
      const lf = buffer.indexOf('\n');
      let end = -1;
      let width = 1;
      if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
        end = crlf;
        width = 2;
      } else if (lf !== -1) {
        end = lf;
      }
      if (end === -1) break;
      const line = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + width);
      yield line;
      if (socket.destroyed) return;
    }
  }
  if (buffer.length > 0) yield buffer.toString('utf8');
}
