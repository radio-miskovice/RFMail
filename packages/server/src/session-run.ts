// Running a session: dial the gateway, open the modem's data port, run the B2
// exchange over it, and put what happened back in the store.
//
// The dial is the connect test's dial with the call left up; the exchange is
// core-b2f's Session; what sits between them is the store — OUTBOX supplies the
// proposals, INBOX receives, and a message the peer accepted moves to SENT.
//
// VARA-family modems (VARA HF/FM, XARA, Data2G, Mercury) hand the session bytes to
// a second port. ARDOP does not: its data shares the command socket with text
// lines, which needs ARDOP's own framing and is not written yet, so it is refused
// here rather than half-run.

import { connect, type Socket } from 'node:net';
import {
  Session,
  b2ToMessage,
  buildOutbound,
  messageToB2,
  sortByPrecedence,
  type B2Message,
  type ExchangeResult,
  type InboundMeta,
  type OutboundItem,
  type Proposal,
  type ProposalAnswer,
  type SessionHandler,
  type SessionMode,
} from '@rfmail/core-b2f';
import type { Logger, ModemKind } from '@rfmail/shared';
import type { Store, UserRecord } from '@rfmail/store';
import { bandwidthOfMode, dialModem, hangUpModem, type DialOutcome } from './modem-dial.ts';
import { tcpDuplex } from './tcp-duplex.ts';

export interface SessionModem {
  name: string;
  kind: ModemKind;
  host: string;
  commandPort: number;
  dataPort: number | null;
}

export interface SessionRunOptions {
  store: Store;
  account: UserRecord;
  modem: SessionModem;
  /** The gateway or CMS being dialled. */
  target: string;
  /**
   * What is on the far end. `cms` is the Winlink gateway, `p2p` another operator's
   * station, `postoffice` a B2F server that holds mail instead of relaying. It decides
   * the modem's session type, what `;FW:` asks for, whether a secure login is required,
   * and which of the account's outbox messages may be offered at all.
   */
  mode?: SessionMode;
  bandwidthHz?: number;
  /** The Winlink secure-login password, opened from the sealed secret by the caller. */
  password?: string | null;
  logger: Logger;
  silenceMs?: number;
  /** How long the call may take to come up. */
  dialTimeoutMs?: number;
  onLine?: (direction: '>' | '<', text: string) => void;
}

export interface SessionReport {
  result: 'complete' | 'failed' | 'aborted' | 'error';
  /** One sentence for the operator. */
  message: string;
  dial: DialOutcome | null;
  exchange: ExchangeResult | null;
  /** MIDs that left this station and are now in SENT. */
  sent: string[];
  /** MIDs that arrived and are now in INBOX. */
  received: string[];
}

/** Runs one session and returns what happened. Never throws for an RF failure. */
export async function runSession(options: SessionRunOptions): Promise<SessionReport> {
  const { store, account, modem, logger } = options;
  const callsign = account.callsign;
  if (!callsign) {
    return failure('error', 'this account has no callsign to put on the air');
  }
  if (modem.kind === 'ardop') {
    return failure('error', 'ARDOP carries session data on the command port, which this build cannot yet carry');
  }
  if (!modem.dataPort) {
    return failure('error', `${modem.name} has no data port configured, so a session has nowhere to run`);
  }

  const bandwidthHz = options.bandwidthHz ?? bandwidthOfMode('VARA');
  const mode: SessionMode = options.mode ?? 'cms';
  const dial = await dialModem({
    host: modem.host,
    port: modem.commandPort,
    dialect: 'vara',
    hf: modem.kind !== 'vara-fm',
    p2p: mode === 'p2p',
    plainVara: modem.kind === 'data2g' || modem.kind === 'mercury',
    bandwidthChoices: null,
    myCallsign: callsign,
    target: options.target,
    bandwidthHz,
    keepConnected: true,
    // Every word the modem says, with its timestamp: whether the far end sent a
    // disconnect frame or our own deadline expired is the question an operator asks first.
    onModemLine: (atMs, line) => logger.info('modem line', { target: options.target, atMs, line }),
    onCommand: (atMs, command) => logger.debug?.('modem command', { target: options.target, atMs, command }),
    ...(options.dialTimeoutMs === undefined ? {} : { timeoutMs: options.dialTimeoutMs }),
  });

  if (dial.result !== 'connected' || !dial.link) {
    // The reason travels with the report and into the log: "failed" on its own cannot tell
    // a band that was busy from a modem that never answered from a gateway that said no.
    logger.warn('session dial failed', {
      target: options.target,
      modem: modem.name,
      mode,
      result: dial.result,
      reason: dial.message,
      elapsedMs: dial.elapsedMs,
    });
    return {
      result: dial.result === 'error' ? 'error' : 'failed',
      message: dial.message,
      dial,
      exchange: null,
      sent: [],
      received: [],
    };
  }

  const commandSocket = dial.link;
  let dataSocket: Socket | null = null;
  try {
    dataSocket = await openSocket(modem.host, modem.dataPort, 10_000);
    logger.info('session running', { target: options.target, by: callsign, modem: modem.name });

    const outbox = await store.findFolder(account.id, 'OUTBOX');
    const inbox = await store.findFolder(account.id, 'INBOX');
    if (!inbox) return failure('error', 'the mailbox has no INBOX folder');

    const prepared = new Map<string, OutboundItem>();
    const settled = new Set<string>();

    const handler: SessionHandler = {
      outbound: async (forwarders) => {
        if (!outbox) return [];
        // Whom the far end will take mail for. A CMS routes for the whole Winlink
        // system, so everything goes to it. A peer station takes only what is addressed
        // to it. A post office takes what its users are called, which is what its
        // `;FW:` list names, plus itself.
        const addressedTo =
          mode === 'cms'
            ? null
            : new Set([options.target, ...(mode === 'postoffice' ? forwarders : [])].map((call) => call.toUpperCase()));
        const listing = await store.listMessages(account.id, outbox.id, { limit: 100 });
        const items: OutboundItem[] = [];
        for (const envelope of listing.messages) {
          if (settled.has(envelope.mid)) continue;
          if (addressedTo && ![...envelope.to, ...envelope.cc].some((call) => addressedTo.has(call.toUpperCase()))) {
            continue;
          }
          let item = prepared.get(envelope.mid);
          if (!item) {
            const mail = await store.getMailMessage(account.id, envelope.id);
            if (!mail) continue;
            item = buildOutbound(messageToB2(mail));
            prepared.set(envelope.mid, item);
          }
          items.push(item);
        }
        return sortByPrecedence(items);
      },
      sent: (mid) => {
        settled.add(mid);
      },
      rejected: (mid) => {
        settled.add(mid);
      },
      deferred: (mid) => {
        // Deferred means "ask me again": out of this session, still in OUTBOX.
        settled.add(mid);
      },
      answer: async (proposal: Proposal): Promise<ProposalAnswer> => {
        const known = await store.findMessageByMid(account.id, proposal.mid);
        return known ? '-' : '+';
      },
      received: async (message: B2Message, meta: InboundMeta) => {
        await store.insertMessage(account.id, inbox.id, b2ToMessage(message), {
          direction: 'in',
          peer: meta.from || options.target,
        });
      },
      receiveFailed: (proposal, reason) => {
        logger.warn('session message failed', { mid: proposal.mid, reason });
      },
      line: (direction, text) => {
        logger.debug?.(`session ${direction} ${text}`);
        options.onLine?.(direction, text);
      },
      ready: (info) => {
        logger.info('session handshake', { sid: info.sid.flags, forwarders: info.forwarders });
      },
    };

    const session = new Session({
      myCallsign: callsign,
      target: options.target,
      mode,
      locator: account.locator ?? '',
      password: options.password ?? null,
      handler,
      ...(options.silenceMs === undefined ? {} : { silenceMs: options.silenceMs }),
    });

    const exchange = await session.run(tcpDuplex(dataSocket));
    await fileAway(store, account.id, exchange);

    const summary = describe(exchange);
    logger.info('session finished', {
      target: options.target,
      result: exchange.result,
      sent: exchange.sent.length,
      received: exchange.received.length,
      deferred: exchange.deferred.length,
      // Null on a clean exchange; the sentence the operator was shown otherwise.
      reason: exchange.error ?? null,
      remoteSid: exchange.remoteSid,
    });

    return {
      result: exchange.result,
      message: summary,
      dial,
      exchange,
      sent: exchange.sent,
      received: exchange.received,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('session could not run', { target: options.target, reason });
    return { result: 'error', message: `the session could not run: ${reason}`, dial, exchange: null, sent: [], received: [] };
  } finally {
    dataSocket?.destroy();
    const hangUp = await hangUpModem(commandSocket);
    // Who ended the call, and whether the modem confirmed it. `sawDisconnected: false`
    // means the link closed without the far end saying so — which is not success.
    logger.info('session hangup', {
      target: options.target,
      by: hangUp.by,
      sawDisconnected: hangUp.sawDisconnected,
      timedOut: hangUp.timedOut,
      afterDisconnect: hangUp.lines,
    });
  }
}

/** A delivered message leaves OUTBOX for SENT, whether accepted or already held. */
async function fileAway(store: Store, userId: number, exchange: ExchangeResult): Promise<void> {
  const sent = await store.findFolder(userId, 'SENT');
  if (!sent) return;
  for (const mid of [...exchange.sent, ...exchange.rejected]) {
    const envelope = await store.findMessageByMid(userId, mid);
    if (envelope && envelope.folderId !== sent.id) {
      await store.moveMessage(userId, envelope.id, sent.id);
    }
  }
}

function describe(exchange: ExchangeResult): string {
  if (exchange.result === 'aborted') return exchange.error ?? 'the session was cancelled';
  if (exchange.result === 'failed') return exchange.error ?? 'the session failed';
  const parts = [
    `${exchange.sent.length} sent`,
    `${exchange.received.length} received`,
  ];
  if (exchange.deferred.length > 0) parts.push(`${exchange.deferred.length} deferred`);
  if (exchange.failed.length > 0) parts.push(`${exchange.failed.length} damaged`);
  return parts.join(', ');
}

function failure(result: 'error' | 'failed', message: string): SessionReport {
  return { result, message, dial: null, exchange: null, sent: [], received: [] };
}

async function openSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer from ${host}:${port} within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      socket.on('error', () => {
        // A broken session socket surfaces as a read error inside the Session.
      });
      resolve(socket);
    });
    socket.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
