// SMTP submission (RFC 5321) into a user's OUTBOX.
//
// Only authenticated submission is accepted: the sender must be an address the
// account owns, and nothing is relayed anywhere — accepted mail is stored for
// the next radio session, not forwarded to another SMTP server.

import { createServer, type Server, type Socket } from 'node:net';
import { findUserByCredential } from './identity.ts';
import {
  isWinlinkAddress,
  parseRfc822,
  generateMid,
  toWinlinkAddress,
  validateMessage,
  type MailMessage,
} from '@rfmail/core-b2f';
import type { Logger } from '@rfmail/shared';
import { verifyPassword, type Store, type UserRecord } from '@rfmail/store';
import type { PeerPolicy } from './access.ts';
import type { MailEvents } from './events.ts';
import { readLines } from './lines.ts';

export interface SmtpOptions {
  store: Store;
  policy: PeerPolicy;
  events: MailEvents;
  host: string;
  port: number;
  logger: Logger;
  hostname?: string;
  maxMessageBytes?: number;
  idleTimeoutMs?: number;
  maxRecipients?: number;
}

interface Transaction {
  from: string;
  recipients: string[];
}

export class SmtpServer {
  private readonly opts: SmtpOptions;
  private server: Server | null = null;
  private readonly connections = new Set<Socket>();

  constructor(options: SmtpOptions) {
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
    const server = createServer((socket) => void this.handle(socket));
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
    this.opts.logger.info('smtp listening', { address: this.address, access: this.opts.policy.describe() });
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
    const hostname = this.opts.hostname ?? 'rfmail';
    if (!this.opts.policy.allows(remote)) {
      this.opts.logger.warn('smtp connection refused by access policy', { remote });
      socket.end('421 4.7.0 Service not available from this address\r\n');
      return;
    }

    this.connections.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(this.opts.idleTimeoutMs ?? 10 * 60 * 1000);
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());

    const write = (line: string): void => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };

    let user: UserRecord | null = null;
    let transaction: Transaction | null = null;
    let authFailures = 0;

    write(`220 ${hostname} ESMTP rfmail ready`);

    // latin1 keeps every byte; DATA is reassembled with Buffer.from(..., 'latin1').
    const iterator = readLines(socket, 'latin1');
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const line = next.value;

        if (line.trim() === '') continue;
        const space = line.indexOf(' ');
        const verb = (space === -1 ? line : line.slice(0, space)).toUpperCase();
        const argument = space === -1 ? '' : line.slice(space + 1);

        if (verb === 'EHLO' || verb === 'HELO') {
          if (verb === 'EHLO') {
            write(`250-${hostname} greets ${argument || remote}`);
            write(`250-SIZE ${this.opts.maxMessageBytes ?? 10 * 1024 * 1024}`);
            write('250-8BITMIME');
            write('250-AUTH PLAIN LOGIN');
            write('250 HELP');
          } else {
            write(`250 ${hostname}`);
          }
          continue;
        }

        if (verb === 'AUTH') {
          if (user) {
            write('503 5.5.1 Already authenticated');
            continue;
          }
          const [mechanismRaw = '', initialRaw = ''] = argument.split(' ');
          const mechanism = mechanismRaw.toUpperCase();
          let login = '';
          let password = '';

          if (mechanism === 'PLAIN') {
            let payload = initialRaw;
            if (!payload) {
              write('334 ');
              const answer = await iterator.next();
              if (answer.done) break;
              payload = answer.value.trim();
              if (payload === '*') {
                write('501 5.7.0 Authentication cancelled');
                continue;
              }
            }
            const decoded = decodeBase64(payload);
            const parts = decoded.split('\u0000');
            login = parts.length >= 3 ? (parts[1] ?? '') : (parts[0] ?? '');
            password = parts.length >= 3 ? (parts[2] ?? '') : (parts[1] ?? '');
          } else if (mechanism === 'LOGIN') {
            write('334 VXNlcm5hbWU6');
            const userAnswer = await iterator.next();
            if (userAnswer.done) break;
            if (userAnswer.value.trim() === '*') {
              write('501 5.7.0 Authentication cancelled');
              continue;
            }
            login = decodeBase64(userAnswer.value.trim());
            write('334 UGFzc3dvcmQ6');
            const passAnswer = await iterator.next();
            if (passAnswer.done) break;
            if (passAnswer.value.trim() === '*') {
              write('501 5.7.0 Authentication cancelled');
              continue;
            }
            password = decodeBase64(passAnswer.value.trim());
          } else {
            write('504 5.5.4 Unrecognised authentication mechanism');
            continue;
          }

          const candidate = login ? await findUserByCredential(this.opts.store, login) : null;
          if (!candidate || !candidate.enabled || !verifyPassword(password, candidate.pwHash)) {
            authFailures += 1;
            this.opts.logger.warn('smtp login failed', { login, remote });
            write('535 5.7.8 Authentication credentials invalid');
            if (authFailures >= 3) socket.end('421 4.7.0 Too many failed attempts\r\n');
            continue;
          }
          user = candidate;
          authFailures = 0;
          write('235 2.7.0 Authentication successful');
          continue;
        }

        if (verb === 'MAIL') {
          if (!user) {
            write('530 5.7.0 Authentication required');
            continue;
          }
          const address = extractPath(argument);
          if (!address) {
            write('501 5.1.7 Missing or malformed sender address');
            continue;
          }
          // A mail program writes OK1ABC@winlink.org; the mailbox is OK1ABC.
          const sender = toWinlinkAddress(address);
          if (!this.ownsAddress(user, sender)) {
            write('553 5.7.1 Sender address is not owned by this account');
            continue;
          }
          transaction = { from: sender, recipients: [] };
          write('250 2.1.0 Ok');
          continue;
        }

        if (verb === 'RCPT') {
          if (!transaction) {
            write('503 5.5.1 Send MAIL FROM first');
            continue;
          }
          const address = extractPath(argument);
          if (!address || !(isWinlinkAddress(address) || /^[^\s@<>]+@[^\s@<>]+$/.test(address))) {
            write('501 5.1.3 Missing or malformed recipient address');
            continue;
          }
          if (transaction.recipients.length >= (this.opts.maxRecipients ?? 50)) {
            write('452 4.5.3 Too many recipients');
            continue;
          }
          transaction.recipients.push(toWinlinkAddress(address));
          write('250 2.1.5 Ok');
          continue;
        }

        if (verb === 'DATA') {
          if (!transaction || transaction.recipients.length === 0) {
            write('503 5.5.1 No sender or recipients');
            continue;
          }
          write('354 End data with <CR><LF>.<CR><LF>');
          const collected = await this.readData(iterator, this.opts.maxMessageBytes ?? 10 * 1024 * 1024);
          if ('error' in collected) {
            write(collected.error);
            transaction = null;
            continue;
          }
          const outcome = await this.deliver(user, transaction, collected.data);
          write(outcome);
          transaction = null;
          continue;
        }

        switch (verb) {
          case 'RSET':
            transaction = null;
            write('250 2.0.0 Ok');
            break;
          case 'NOOP':
            write('250 2.0.0 Ok');
            break;
          case 'VRFY':
            write('252 2.5.2 Cannot verify the address');
            break;
          case 'HELP':
            write('214 2.0.0 Commands: EHLO HELO AUTH MAIL RCPT DATA RSET NOOP VRFY QUIT');
            break;
          case 'QUIT':
            write('221 2.0.0 Bye');
            socket.end();
            return;
          default:
            write('500 5.5.2 Command not recognised');
        }
      }
    } catch (err) {
      this.opts.logger.warn('smtp session error', {
        remote,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.connections.delete(socket);
      socket.destroy();
    }
  }

  private async readData(
    iterator: AsyncGenerator<string>,
    limit: number,
  ): Promise<{ data: Buffer } | { error: string }> {
    const chunks: string[] = [];
    let size = 0;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return { error: '421 4.4.2 Connection lost during DATA' };
      const line = next.value;
      if (line === '.') break;
      const unstuffed = line.startsWith('..') ? line.slice(1) : line;
      size += unstuffed.length + 2;
      if (size > limit) {
        // Drain until the terminator so the session stays in step.
        for (;;) {
          const drain = await iterator.next();
          if (drain.done || drain.value === '.') break;
        }
        return { error: '552 5.3.4 Message exceeds the size limit' };
      }
      chunks.push(unstuffed);
    }
    return { data: Buffer.from(`${chunks.join('\r\n')}\r\n`, 'latin1') };
  }

  private async deliver(
    user: UserRecord | null,
    transaction: Transaction,
    raw: Buffer,
  ): Promise<string> {
    if (!user) return '530 5.7.0 Authentication required';
    const mid = generateMid(transaction.from);
    let message: MailMessage;
    try {
      message = parseRfc822(new Uint8Array(raw), { mid });
    } catch (err) {
      this.opts.logger.warn('smtp message parse failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return '554 5.6.0 Message could not be parsed';
    }

    // The envelope decides where it goes; the headers decide how it is shown.
    // Both keep Winlink addresses in their bare form (address.ts).
    message.from = toWinlinkAddress(transaction.from);
    if (message.to.length === 0) message.to = [...transaction.recipients];
    if (!message.subject.trim()) message.subject = '(no subject)';

    const validation = validateMessage(message);
    if (!validation.ok) {
      const field = Object.entries(validation.fields)[0];
      return `554 5.6.0 Message rejected: ${field ? `${field[0]}: ${field[1]}` : 'invalid'}`;
    }

    const outbox = await this.opts.store.findFolder(user.id, 'OUTBOX');
    if (!outbox) return '451 4.3.0 Mailbox unavailable';
    const inserted = await this.opts.store.insertMessage(user.id, outbox.id, message, {
      direction: 'out',
      peer: null,
    });
    this.opts.events.notify({ userId: user.id, folderId: outbox.id, folder: outbox.name });
    this.opts.logger.info('smtp message queued', {
      callsign: user.callsign ?? user.login,
      mid: message.mid,
      recipients: transaction.recipients.length,
    });
    return `250 2.0.0 Ok: queued as ${message.mid} (id ${inserted.id})`;
  }

  private ownsAddress(user: UserRecord, address: string): boolean {
    const local = address.split('@')[0]?.toUpperCase() ?? '';
    // A Winlink client session has one originator callsign; an account without
    // one can only submit as its login name.
    const allowed = user.callsign ? [user.callsign] : [user.login];
    return allowed.some((callsign) => toWinlinkAddress(callsign) === toWinlinkAddress(address));
  }
}

function decodeBase64(value: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** `<addr>`, `<Name <addr>>` or `addr` -> `addr`. */
function extractPath(argument: string): string {
  const match = /<([^>]*)>/.exec(argument);
  if (match && match[1] !== undefined) return match[1].trim();
  const bare = argument.split(/\s+/).find((part) => part.includes('@'));
  if (bare) return bare.replace(/^[:<]|[>]$/g, '').trim();
  return '';
}
