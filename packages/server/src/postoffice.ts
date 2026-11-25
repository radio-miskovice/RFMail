// The post office: an answering B2F station.
//
// A station's post office terminates inbound sessions locally (decision 26). A user
// dials it as if it were an RMS, the station asks who is calling, and the session
// carries mail both ways without a CMS in the path:
//
//   inbound    proposals the caller makes are accepted for the local accounts the
//              messages name; duplicates are answered `-`, because a re-proposal
//              after a dropped link must be harmless.
//   outbound   whatever that account's mailbox holds and has not been collected
//              over the air yet (FLAG_COLLECTED), offered to the calling station.
//
// Authentication is the one thing a post office must not skip (decision 27): it
// sends `;PQ:` with a fresh nonce per call and compares the `;PR:` answer against
// the sealed credentials of the callsign being claimed — the Winlink password and
// the post-office password, either of which authenticates. Both are recomputed,
// because that is the only way a `;PR` can be checked.
//
// Everything here is one modem (a modem carries one session at a time, R4.5.1),
// armed from the API and disarmed on request or on a modem failure. The radio is
// tuned by the caller before arming; an inbound call cannot be tuned for.

import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import {
  Session,
  b2ToMessage,
  buildOutbound,
  messageToB2,
  secureLoginResponse,
  sortByPrecedence,
  type B2Message,
  type InboundMeta,
  type OutboundItem,
  type PendingMessage,
  type Proposal,
  type SessionHandler,
} from '@rfmail/core-b2f';
import { FLAG_COLLECTED, FLAG_DELETED, type Logger, type PostOfficeSession } from '@rfmail/shared';
import type { Store, UserRecord } from '@rfmail/store';
import { hangUpModem } from './modem-dial.ts';
import { tcpDuplex } from './tcp-duplex.ts';

export interface PostOfficeModem {
  id: number;
  name: string;
  host: string;
  commandPort: number;
  dataPort: number | null;
}

export interface ArmOptions {
  /** The account whose callsign the station answers as. */
  owner: UserRecord;
  modem: PostOfficeModem;
  /** Recorded for the report; the radio was already tuned by the caller. */
  frequencyHz: number;
}

export interface PostOfficeOptions {
  store: Store;
  logger: Logger;
  /** Opens the sealed credentials; the caller owns the key. */
  openSecret(blob: string): string | null;
  silenceMs?: number;
}

export interface PostOfficeSnapshot {
  armed: boolean;
  /** A call is up right now (the station is not merely listening). */
  busy: boolean;
  owner: string | null;
  modemId: number | null;
  modemName: string | null;
  frequencyHz: number | null;
  error: string | null;
  sessions: PostOfficeSession[];
}

/** How many finished sessions the status endpoint remembers. */
const SESSION_HISTORY = 20;

export class PostOffice {
  private readonly store: Store;
  private readonly logger: Logger;
  private readonly openSecret: (blob: string) => string | null;
  private readonly silenceMs: number | undefined;

  private armed = false;
  private owner: UserRecord | null = null;
  private modem: PostOfficeModem | null = null;
  private frequencyHz: number | null = null;
  private error: string | null = null;

  private command: Socket | null = null;
  private data: Socket | null = null;
  private session: Session | null = null;
  private reading = false;
  private sessions: PostOfficeSession[] = [];
  private current: PostOfficeSession | null = null;
  /** Serialises re-arming so a second call cannot open two sessions. */
  private working = false;

  constructor(options: PostOfficeOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.openSecret = options.openSecret;
    this.silenceMs = options.silenceMs;
  }

  snapshot(): PostOfficeSnapshot {
    return {
      armed: this.armed,
      busy: this.working || this.current !== null,
      owner: this.owner?.callsign ?? null,
      modemId: this.modem?.id ?? null,
      modemName: this.modem?.name ?? null,
      frequencyHz: this.frequencyHz,
      error: this.error,
      sessions: this.current ? [this.current, ...this.sessions] : [...this.sessions],
    };
  }

  get isArmed(): boolean {
    return this.armed;
  }

  get modemId(): number | null {
    return this.armed ? (this.modem?.id ?? null) : null;
  }

  /**
   * Arms the modem for inbound calls: `MYCALL` + `LISTEN ON` on a command socket
   * that then stays open, because `CONNECTED` is the only notice of a call and
   * nothing re-opens it for us.
   */
  async arm(options: ArmOptions): Promise<PostOfficeSnapshot> {
    if (this.armed) throw new Error('the post office is already armed');
    const { owner, modem } = options;
    const callsign = owner.callsign;
    if (!callsign) throw new Error('the post office owner has no callsign');
    if (!modem.dataPort) throw new Error(`${modem.name} has no data port, so a session has nowhere to run`);

    this.owner = owner;
    this.modem = modem;
    this.frequencyHz = options.frequencyHz;
    this.error = null;

    const socket = await openSocket(modem.host, modem.commandPort, 3_000);
    this.command = socket;
    socket.setEncoding('latin1');
    this.armed = true;

    socket.write(`MYCALL ${callsign}\r`);
    socket.write('LISTEN ON\r');
    socket.on('data', (chunk: string) => this.onCommandData(chunk));
    socket.on('close', () => {
      if (!this.armed) return;
      this.armed = false;
      this.error = 'the modem closed the connection';
      this.logger.warn('post office stopped', { reason: this.error, modem: modem.name });
    });
    socket.on('error', (failure: Error) => {
      this.logger.warn('post office command socket failed', { modem: modem.name, reason: failure.message });
    });

    this.logger.info('post office armed', {
      callsign,
      modem: modem.name,
      host: modem.host,
      commandPort: modem.commandPort,
      dataPort: modem.dataPort,
      frequencyHz: options.frequencyHz,
    });
    return this.snapshot();
  }

  /** Disarms: an in-flight session is aborted and the modem told to stop listening. */
  async disarm(): Promise<PostOfficeSnapshot> {
    this.armed = false;
    this.session?.abort('the post office was disarmed');
    this.session = null;
    this.data?.destroy();
    this.data = null;
    const socket = this.command;
    this.command = null;
    if (socket && !socket.destroyed) {
      try {
        socket.write('LISTEN OFF\r');
      } catch {
        // The link is going away anyway.
      }
    }
    await hangUpModemSafely(socket);
    this.logger.info('post office disarmed', { by: this.owner?.callsign ?? null });
    return this.snapshot();
  }

  // -- the command channel ---------------------------------------------------

  private pendingText = '';

  private onCommandData(chunk: string): void {
    // VARA-family lines end in a bare CR, and Data2G/XARA add their own; split on
    // both and keep the unterminated remainder, or a modem looks silent.
    this.pendingText += chunk;
    for (;;) {
      const match = /[\r\n]/.exec(this.pendingText);
      if (!match) break;
      const line = this.pendingText.slice(0, match.index).trim();
      this.pendingText = this.pendingText.slice(match.index + 1);
      if (line !== '') this.onCommandLine(line);
    }
  }

  private onCommandLine(line: string): void {
    this.logger.debug?.('post office modem line', { line });
    const connected = /^CONNECTED\b\s*(.*)$/i.exec(line);
    if (connected) {
      // `CONNECTED <this station> <the far station> <bandwidth>`; the far station is
      // what the session must offer mail to.
      const parts = (connected[1] ?? '').trim().split(/\s+/).filter(Boolean);
      const peer = (parts[1] ?? parts[0] ?? '').toUpperCase();
      if (!peer) {
        this.logger.warn('post office call without a callsign', { line });
        return;
      }
      void this.handleCall(peer);
      return;
    }
    if (/^DISCONNECTED\b/i.test(line)) {
      // While idle this is the tail of the last session's hang-up; while a session
      // runs, the session's own reader sees the data port close.
      return;
    }
    if (/^FAULT\b/i.test(line)) {
      this.error = `the modem reported a fault: ${line}`;
      this.logger.warn('post office modem fault', { line });
      this.armed = false;
    }
  }

  // -- one inbound session ---------------------------------------------------

  private async handleCall(peer: string): Promise<void> {
    if (this.working) {
      // One session per modem; a second call cannot be carried.
      this.logger.warn('post office busy', { peer });
      return;
    }
    const modem = this.modem;
    const owner = this.owner;
    if (!modem?.dataPort || !owner?.callsign) return;

    this.working = true;
    const startedAt = Date.now();
    this.current = {
      peer,
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: 0,
      result: null,
      sent: 0,
      received: 0,
      reason: null,
    };
    this.logger.info('post office call', { peer, callsign: owner.callsign, modem: modem.name });

    try {
      const socket = await openSocket(modem.host, modem.dataPort, 10_000);
      this.data = socket;
      const challenge = randomBytes(4).toString('hex').toUpperCase();

      const session = new Session({
        myCallsign: owner.callsign,
        target: peer,
        locator: owner.locator ?? '',
        master: true,
        masterAuth: {
          challenge,
          verify: (answer) => this.verify(peer, challenge, answer),
        },
        handler: this.handlerFor(peer),
        ...(this.silenceMs === undefined ? {} : { silenceMs: this.silenceMs }),
      });
      this.session = session;

      const exchange = await session.run(tcpDuplex(socket));
      const received = exchange.received.length;
      const sent = exchange.sent.length;
      this.current = {
        ...this.current,
        elapsedMs: Date.now() - startedAt,
        result: exchange.result,
        sent,
        received,
        reason: exchange.error,
      };
      this.logger.info('post office session ended', {
        peer,
        result: exchange.result,
        sent,
        received,
        secureLogin: exchange.secureLogin,
        reason: exchange.error,
        remoteSid: exchange.remoteSid,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      this.current = {
        ...(this.current ?? {
          peer,
          startedAt: new Date(startedAt).toISOString(),
          elapsedMs: 0,
          result: null,
          sent: 0,
          received: 0,
          reason: null,
        }),
        elapsedMs: Date.now() - startedAt,
        result: 'error',
        reason,
      };
      this.logger.warn('post office session could not run', { peer, reason });
    } finally {
      this.sessions = [this.current as PostOfficeSession, ...this.sessions]
        .filter((entry) => entry.result !== null)
        .slice(0, SESSION_HISTORY);
      this.current = null;
      this.data?.destroy();
      this.data = null;
      this.session = null;
      // The far end's ID frame is still in the air after DISCONNECT, so the call is
      // closed properly — but the station's own command socket stays open, because
      // closing it would deafen the post office to the next call.
      if (this.armed && this.command && !this.command.destroyed) {
        const report = await hangUpModem(this.command, { keepSocket: true }).catch(() => null);
        this.logger.info('post office hangup', {
          peer,
          sawDisconnected: report?.sawDisconnected ?? false,
          timedOut: report?.timedOut ?? true,
        });
      }
      this.working = false;
      await this.rearm();
    }
  }

  private async rearm(): Promise<void> {
    if (!this.armed) return;
    const socket = this.command;
    if (!socket || socket.destroyed) {
      this.armed = false;
      this.error = this.error ?? 'the modem link was lost';
      return;
    }
    try {
      socket.write('LISTEN ON\r');
    } catch {
      this.armed = false;
      this.error = 'the modem link was lost while re-arming';
      this.logger.warn('post office could not re-arm', { reason: this.error });
    }
  }

  // -- authentication --------------------------------------------------------

  /**
   * Judges a `;PR:` answer. The challenger must hold the password, and this station
   * holds up to two for one callsign (decision 27): the Winlink one registered for
   * that callsign, and the post-office one set on the account. Either authenticates
   * — until the station is registered with the Winlink Development Team, only the
   * second exists, and a challenge that only the first could answer would lock the
   * operator out of their own post office.
   */
  private verify(peer: string, challenge: string, answer: string): Promise<boolean> {
    return authenticateStation(
      { store: this.store, openSecret: this.openSecret, logger: this.logger },
      peer,
      challenge,
      answer,
    );
  }

  // -- the store side of a session -------------------------------------------

  private handlerFor(connecting: string): SessionHandler {
    if (!this.owner) throw new Error('the post office has no owner');
    return createPostOfficeHandler({
      store: this.store,
      logger: this.logger,
      owner: this.owner,
      connecting,
    });
  }
}

export interface PostOfficeHandlerOptions {
  store: Store;
  logger: Logger;
  /** The account whose callsign the station answers as: where unroutable mail is held. */
  owner: UserRecord;
  /** The callsign of the station that dialled in. */
  connecting: string;
}

/**
 * The post office's side of one session: what to offer, what to accept, and where an
 * accepted message is filed. Exported because it is the part worth testing without a
 * modem — a session pair over a socket exercises exactly this code.
 */
export function createPostOfficeHandler(options: PostOfficeHandlerOptions): SessionHandler {
  const { store, logger: log, owner, connecting } = options;
  /** What this session has already decided, so a turn does not re-offer it. */
  const settled = new Set<string>();
  const prepared = new Map<string, OutboundItem>();

  const accountOf = async (callsign: string): Promise<UserRecord | null> =>
    store.findUserByCallsign(callsign);

  async function markCollected(mid: string): Promise<void> {
    const found = await store.findReceivedByMid(mid);
    if (!found) return;
    await store.setFlags(found.userId, found.envelope.id, found.envelope.flags | FLAG_COLLECTED);
  }

  /**
   * Files one message for every local callsign it names (decision 26: a local
   * recipient's own mailbox is the delivery). A message for nobody this station holds
   * is not dropped: it goes to the owner's mailbox with the peer recorded, so the
   * postmaster can create the account or delete the mail knowingly.
   */
  async function fileInbound(message: B2Message, meta: InboundMeta): Promise<void> {
    const recipients = pendingRecipients(undefined, message);
    let delivered = 0;
    const unknown: string[] = [];
    for (const callsign of recipients) {
      const account = await accountOf(callsign);
      if (!account) {
        unknown.push(callsign);
        continue;
      }
      const inbox = await store.findFolder(account.id, 'INBOX');
      if (!inbox) continue;
      if (await store.findMessageByMid(account.id, message.mid)) continue;
      try {
        await store.insertMessage(account.id, inbox.id, b2ToMessage(message), {
          direction: 'in',
          peer: meta.from || connecting,
        });
        delivered += 1;
        log.info('post office mail filed', {
          mid: message.mid,
          to: callsign,
          from: meta.from || connecting,
        });
      } catch (failure) {
        log.warn('post office could not file mail', {
          mid: message.mid,
          to: callsign,
          reason: failure instanceof Error ? failure.message : String(failure),
        });
      }
    }

    if (delivered > 0) {
      if (unknown.length > 0) {
        log.warn('post office ignored recipients it does not hold', {
          mid: message.mid,
          recipients: unknown.join(' '),
        });
      }
      return;
    }

    const inbox = await store.findFolder(owner.id, 'INBOX');
    if (!inbox) return;
    if (await store.findMessageByMid(owner.id, message.mid)) return;
    await store.insertMessage(owner.id, inbox.id, b2ToMessage(message), {
      direction: 'in',
      peer: meta.from || connecting,
    });
    log.warn('post office held mail for an unknown recipient', {
      mid: message.mid,
      recipients: unknown.join(' ') || '(none named)',
      from: meta.from || connecting,
      heldFor: owner.callsign,
    });
  }

  return {
    outbound: async (forwarders) => {
      // Mail is offered for the addresses the caller asked for, not for the
      // station's whole account list: `;FW:` is the only statement it made, and
      // broadcasting the account list would be a disclosure to any caller.
      const wanted = new Set(
        (forwarders.length > 0 ? forwarders : [connecting]).map((call) => call.toUpperCase()),
      );
      const items: OutboundItem[] = [];
      for (const callsign of wanted) {
        const account = await accountOf(callsign);
        if (!account) continue;
        const inbox = await store.findFolder(account.id, 'INBOX');
        if (!inbox) continue;
        const listing = await store.listMessages(account.id, inbox.id, { limit: 100 });
        for (const envelope of listing.messages) {
          if (settled.has(envelope.mid)) continue;
          // Collected once, not offered again; deleted is the user's decision.
          if ((envelope.flags & FLAG_COLLECTED) !== 0) continue;
          if ((envelope.flags & FLAG_DELETED) !== 0) continue;
          let item = prepared.get(envelope.mid);
          if (!item) {
            const mail = await store.getMailMessage(account.id, envelope.id);
            if (!mail) continue;
            item = buildOutbound(messageToB2(mail));
            prepared.set(envelope.mid, item);
          }
          items.push(item);
        }
      }
      return sortByPrecedence(items);
    },

    sent: (mid) => {
      settled.add(mid);
      void markCollected(mid);
    },
    rejected: (mid) => {
      // The peer already holds it: from this station's point of view it has been
      // collected, and offering it again every session would only spend airtime.
      settled.add(mid);
      void markCollected(mid);
    },
    deferred: (mid) => {
      settled.add(mid);
    },

    answer: async (proposal, pending) => {
      // The station's duplicate check: a proposal arrives before the recipient is
      // known, so the MID is matched across every mailbox.
      if (await store.findReceivedByMid(proposal.mid)) return '-';
      // Where the peer told us whom the message is for (`;PM:`), a callsign this
      // station does not hold is deferred rather than accepted and dropped: `=`
      // means "ask me again", while `-` would mean "I have it" and lose the message.
      const recipients = pendingRecipients(pending);
      if (recipients.length > 0) {
        let known = false;
        for (const callsign of recipients) {
          if (await accountOf(callsign)) {
            known = true;
            break;
          }
        }
        if (!known) {
          log.info('post office deferred mail for an unknown recipient', {
            mid: proposal.mid,
            to: recipients.join(' '),
            from: connecting,
          });
          return '=';
        }
      }
      return '+';
    },

    received: async (message: B2Message, meta: InboundMeta) => {
      await fileInbound(message, meta);
    },

    receiveFailed: (proposal: Proposal, reason: string) => {
      log.warn('post office message failed', { mid: proposal.mid, reason, from: connecting });
    },

    line: (direction, text) => {
      log.debug?.(`post office ${direction} ${text}`);
    },

    ready: (info) => {
      log.info('post office handshake', {
        peer: connecting,
        sid: info.sid.flags,
        asks: info.forwarders,
      });
    },
  };
}

export interface PostOfficeAuthOptions {
  store: Store;
  logger: Logger;
  openSecret(blob: string): string | null;
}

/**
 * Judges a `;PR:` answer. The challenger must hold the password, and this station
 * holds up to two for one callsign (decision 27): the Winlink one registered for that
 * callsign, and the post-office one set on the account. Either authenticates — until
 * the station is registered with the Winlink Development Team only the second exists,
 * and a challenge the first alone could answer would lock the operator out of their
 * own post office.
 */
export async function authenticateStation(
  options: PostOfficeAuthOptions,
  peer: string,
  challenge: string,
  answer: string,
): Promise<boolean> {
  const { store, logger: log, openSecret } = options;
  const account = await store.findUserByCallsign(peer);
  if (!account || !account.enabled) {
    log.warn('post office refused a call', { peer, reason: 'no such account' });
    return false;
  }
  const candidates: Array<{ source: 'winlink' | 'post-office'; password: string }> = [];
  for (const [source, blob] of [
    ['winlink', account.winlinkSecret],
    ['post-office', account.postOfficeSecret],
  ] as const) {
    if (!blob) continue;
    const password = openSecret(blob);
    if (password !== null && password !== '') candidates.push({ source, password });
  }
  if (candidates.length === 0) {
    log.warn('post office refused a call', { peer, reason: 'the account has no password stored' });
    return false;
  }
  for (const candidate of candidates) {
    if (constantTimeEquals(secureLoginResponse(challenge, candidate.password), answer)) {
      log.info('post office authenticated', { peer, credential: candidate.source });
      return true;
    }
  }
  log.warn('post office refused a call', {
    peer,
    reason: 'the secure-login response did not match either stored password',
  });
  return false;
}

/** A callsign belongs to one account, so a duplicate copy would violate the MID index. */
function pendingRecipients(
  pending: PendingMessage | undefined,
  message?: B2Message,
): string[] {
  const addresses = message
    ? [...message.to, ...message.cc]
    : pending
      ? [pending.to]
      : [];
  const seen = new Set<string>();
  for (const address of addresses) {
    const bare = address.split('@')[0]?.trim().toUpperCase() ?? '';
    if (bare !== '') seen.add(bare);
  }
  return [...seen];
}

/** Compares two 8-digit responses without an early exit on the first wrong digit. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

async function hangUpModemSafely(socket: Socket | null): Promise<void> {
  if (!socket || socket.destroyed) {
    socket?.destroy();
    return;
  }
  try {
    await hangUpModem(socket);
  } catch {
    socket.destroy();
  }
}

async function openSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer from ${host}:${port} within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      socket.on('error', () => {
        // A broken session socket surfaces as a read error inside the Session.
      });
      resolve(socket);
    });
    socket.once('error', (failure: Error) => {
      clearTimeout(timer);
      reject(failure);
    });
  });
}
