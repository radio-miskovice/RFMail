// The FBB B2 exchange: handshake, turns, proposals and transfers over a byte
// stream.
//
// This module is the protocol only. It knows nothing about modems, telnet or the
// mail store: the caller hands it a duplex, supplies the messages to offer, and
// hears back about every proposal it made or received. A session is a sequence of
// turns, one side at a time:
//
//   handshake   the master sends its SID and a prompt ending in `>`; the
//               initiator answers with `;FW:`, its SID, an optional `;PR:` and a
//               greeting line.
//   turn        up to five `FC`/`FD` proposals, then `F> <checksum>`; the other
//               side answers `FS <one char per proposal>` and the accepted
//               messages follow as SOH/STX/EOT framed blocks.
//   FF          "nothing to offer this turn" — the turn passes to the other side.
//   FQ          "nothing more at all" — the exchange ends when either side quits.
//
// The initiator (the station dialling a gateway) takes the first turn, so it can
// offer its outbound mail before the gateway offers its own. See REQUIREMENTS.md
// R4.4 and references/b2f-wire-protocol.md in the project's skill.

import { gunzipSync, gzipSync } from 'node:zlib';
import { parseB2Message, serialiseB2Message, type B2Message } from './b2msg.ts';
import { encodeTransfer, MAX_TRANSFER_OFFSET, TransferDecoder } from './frame.ts';
import { compressB2, decompressB2 } from './lzhuf.ts';
import {
  formatAnswers,
  formatProposalBlock,
  forwarderLine,
  greetingLine,
  localSid,
  MAX_PROPOSALS_PER_BLOCK,
  parseProposal,
  parseSid,
  readAnswer,
  secureLoginResponse,
  supportsB2,
  type Proposal,
  type ProposalAnswer,
  type ProposalMessageType,
  type Sid,
} from './proposal.ts';
import { encodeWords } from './rfc822.ts';

/**
 * The byte stream a session runs over: a VARA-family data port, an ARDOP socket,
 * a telnet connection to the CMS. `read` resolves with whatever arrived next and
 * rejects when the link is gone; `flush` resolves when everything written has
 * actually left this station (a no-op for a plain socket, an ARDOP flush command
 * for a modem that has one).
 */
export interface Duplex {
  write(chunk: Uint8Array): void | Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  read(): Promise<Uint8Array>;
}

/** How long the peer may stay silent before the link is presumed lost. */
export const DEFAULT_SILENCE_MS = 120_000;
/** A session that has not ended after this many turns is talking in circles. */
const MAX_TURNS = 200;

export class ProtocolError extends Error {
  readonly phase: string;
  constructor(message: string, phase: string) {
    super(message);
    this.name = 'ProtocolError';
    this.phase = phase;
  }
}

export class LinkLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkLostError';
  }
}

/** One message failed; the framing was intact, so the session carries on. */
export class TransferError extends Error {
  readonly mid: string;
  constructor(mid: string, message: string) {
    super(message);
    this.name = 'TransferError';
    this.mid = mid;
  }
}

/**
 * A message this station wants to offer. `raw` is the serialised B2 structure and
 * `compressed` the payload that actually travels; `size` and `compressedSize` of
 * the proposal are their lengths, never invented numbers.
 */
export interface OutboundItem {
  mid: string;
  subject: string;
  raw: Uint8Array;
  compressed: Uint8Array;
  /** `C` is LZHUF (the normal case), `D` gzip — offer `D` only to a peer with `G`. */
  code: 'C' | 'D';
  type: ProposalMessageType;
}

/** What the peer said about a message before proposing it (`;PM:`). */
export interface PendingMessage {
  mid: string;
  to: string;
  from: string;
  subject: string;
  size: number;
}

export interface InboundMeta extends PendingMessage {
  proposal: Proposal;
}

export interface SessionHandler {
  /**
   * The messages to offer on this turn, in preference order. At most five travel
   * per turn; anything beyond is offered on the next one, so a handler keeps
   * returning what is still pending until `sent`/`rejected`/`deferred` told it
   * otherwise. `forwarders` is the peer's `;FW:` list, empty for a CMS that takes
   * everything addressed to its users. A store-backed handler reads its outbox
   * here, so the answer may be a promise.
   */
  outbound(forwarders: readonly string[]): OutboundItem[] | Promise<OutboundItem[]>;
  /** The peer accepted the message and every framed byte was written. */
  sent(mid: string): void;
  /** The peer already has it — nothing was transmitted. */
  rejected(mid: string): void;
  /** The peer asked to be offered it again later. */
  deferred(mid: string): void;
  /** The decision for an inbound proposal: `+` accept, `-` already have it, `=` later. */
  answer(proposal: Proposal): ProposalAnswer | Promise<ProposalAnswer>;
  /** A complete message arrived, decoded. Throwing fails the session. */
  received(message: B2Message, meta: InboundMeta): void | Promise<void>;
  /** One message could not be decoded; the session itself is still healthy. */
  receiveFailed?(proposal: Proposal, reason: string): void;
  /** Every protocol line, in order, including the ones ignored — for the record. */
  line?(direction: '>' | '<', text: string): void;
  /** The peer's handshake is complete. */
  ready?(info: { sid: Sid; forwarders: string[] }): void;
}

/**
 * What the station on the far end is, which is what decides the two things B2 asks of
 * a client before the first message: whom we ask mail for, and whether a secure-login
 * challenge is answered or fatal.
 *
 *   cms         a Winlink RMS gateway or the CMS. It routes for the whole Winlink
 *               system, so we ask for our own address and every auxiliary address,
 *               and every outbound message may be offered. A `;PQ` challenge is
 *               normal, and having no Winlink password is a failure: an unauthenticated
 *               CMS session cannot be trusted with our mail.
 *   p2p         another operator's station, dialled directly. It holds mail for itself
 *               only, so we ask for our own address alone, and only messages addressed
 *               to that station are offered. There is no password relationship between
 *               two operators, so a challenge is answered when a password happens to be
 *               set and otherwise ignored rather than ending the session.
 *   postoffice  a B2F server that terminates sessions and holds mail instead of relaying
 *               (our own post office, or an FBB-style BBS). It may hold mail for several
 *               of our addresses, so the auxiliary list goes in `;FW:`, and it may hold
 *               mail for other users of its own, so anything the far end accepts as a
 *               forwarder may be offered.
 */
export type SessionMode = 'cms' | 'p2p' | 'postoffice';

export interface SessionOptions {
  /** This station's callsign: the originator of what it sends and the mailbox it asks for. */
  myCallsign: string;
  /** The station being dialled, as it appears in the greeting. */
  target: string;
  locator?: string;
  /** Further addresses to collect mail for; they receive, they never send. */
  auxiliary?: readonly string[];
  /**
   * What the far end is: a Winlink CMS/RMS gateway, another operator's station, or a
   * post office that holds mail instead of relaying. It decides what `;FW:` asks for
   * and whether a secure-login challenge is answered or refused. Defaults to `cms`.
   */
  mode?: SessionMode;
  /** The Winlink secure-login password, needed only when the peer sends `;PQ`. */
  password?: string | null;
  application?: string;
  version?: string;
  /** Offer gzip proposals to a peer advertising `G`. Off by default: LZHUF is what every peer reads. */
  gzip?: boolean;
  /** Run the answering half (post office, relay). The initiator is the default. */
  master?: boolean;
  silenceMs?: number;
  handler: SessionHandler;
}

export type SessionOutcome = 'complete' | 'aborted' | 'failed';

export interface LogEntry {
  direction: '>' | '<';
  text: string;
}

export interface ExchangeResult {
  result: SessionOutcome;
  /** MIDs the peer accepted and this station transmitted in full. */
  sent: string[];
  /** MIDs the peer said it already had. */
  rejected: string[];
  /** MIDs the peer asked for again later. */
  deferred: string[];
  /** MIDs received and handed to the caller. */
  received: string[];
  /** MIDs that arrived damaged; the session continued. */
  failed: Array<{ mid: string; reason: string }>;
  /** The `;PM:` details the peer sent, for display before a download. */
  pending: PendingMessage[];
  log: LogEntry[];
  remoteSid: string;
  forwarders: string[];
  offeredBytes: number;
  receivedBytes: number;
  elapsedMs: number;
  error: string | null;
}

/**
 * Byte-at-a-time reading over a chunk stream. The protocol is line-oriented
 * between messages and binary inside them, so both shapes are needed from the same
 * buffer. Transports and tests build on it.
 */
export class ByteReader {
  private buffer = Buffer.alloc(0);
  private readonly duplex: Duplex;
  private readonly onData: () => void;

  constructor(duplex: Duplex, onData: () => void = () => {}) {
    this.duplex = duplex;
    this.onData = onData;
  }

  get empty(): boolean {
    return this.buffer.length === 0;
  }

  private async fill(): Promise<void> {
    const chunk = await this.duplex.read();
    this.onData();
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, Buffer.from(chunk)]);
  }

  /** The next byte without consuming it, or -1 at end of stream. */
  async peek(): Promise<number> {
    if (this.buffer.length === 0) await this.fill();
    return this.buffer[0] ?? -1;
  }

  /** Everything buffered; waits for at least one byte. */
  async take(): Promise<Buffer> {
    if (this.buffer.length === 0) await this.fill();
    const all = this.buffer;
    this.buffer = Buffer.alloc(0);
    return all;
  }

  /** Puts bytes back in front of the buffer (a decoder's leftover). */
  unshift(data: Uint8Array): void {
    if (data.length === 0) return;
    this.buffer = Buffer.concat([Buffer.from(data), this.buffer]);
  }

  /**
   * One line, without its terminator: CR, LF or CRLF. A bare CR is a terminator,
   * as FBB peers send it, and an LF that follows is absorbed with it.
   */
  async line(): Promise<string> {
    for (;;) {
      const cr = this.buffer.indexOf(0x0d);
      const lf = this.buffer.indexOf(0x0a);
      const index = cr === -1 ? lf : lf === -1 ? cr : Math.min(cr, lf);
      if (index >= 0) {
        const text = this.buffer.subarray(0, index).toString('latin1');
        let next = index + 1;
        if (this.buffer[index] === 0x0d && this.buffer[next] === 0x0a) next += 1;
        this.buffer = this.buffer.subarray(next);
        return text;
      }
      await this.fill();
    }
  }
}

/** Serialises and compresses one message into what a proposal needs. */
export function buildOutbound(
  message: B2Message,
  options: { gzip?: boolean; type?: ProposalMessageType } = {},
): OutboundItem {
  const raw = serialiseB2Message(message);
  const gzip = options.gzip === true;
  return {
    mid: message.mid,
    subject: message.subject,
    raw,
    compressed: gzip ? new Uint8Array(gzipSync(raw)) : compressB2(raw),
    code: gzip ? 'D' : 'C',
    type: options.type ?? 'EM',
  };
}

function emptyResult(): ExchangeResult {
  return {
    result: 'complete',
    sent: [],
    rejected: [],
    deferred: [],
    received: [],
    failed: [],
    pending: [],
    log: [],
    remoteSid: '',
    forwarders: [],
    offeredBytes: 0,
    receivedBytes: 0,
    elapsedMs: 0,
    error: null,
  };
}

/**
 * Answers to one `FS` line, walked left to right because an offset answer (`A`,
 * `!`) carries its digits in the same string.
 */
export function parseAnswerLine(text: string): Array<{ decision: 'accept' | 'reject' | 'defer'; offset: number }> {
  const answers: Array<{ decision: 'accept' | 'reject' | 'defer'; offset: number }> = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? '';
    if (character === 'A' || character === '!') {
      const digits = /^\d{1,9}/.exec(text.slice(index + 1))?.[0] ?? '';
      const offset = digits === '' ? 0 : Number(digits);
      answers.push({ decision: 'accept', offset: offset > MAX_TRANSFER_OFFSET ? 0 : offset });
      index += 1 + digits.length;
      continue;
    }
    answers.push(readAnswer(character, 0));
    index += 1;
  }
  return answers;
}

/** `;PM: TO MID SIZE FROM SUBJECT`, the Winlink extension shown before a download. */
export function parsePendingMessage(line: string): PendingMessage | null {
  const text = line.replace(/^;PM:?\s*/i, '');
  const parts = text.split(' ');
  if (parts.length < 5) return null;
  const [to, mid, size, from] = parts;
  const subject = parts.slice(4).join(' ');
  const parsed = Number(size);
  if (!to || !mid || !from || !Number.isInteger(parsed)) return null;
  return { to, mid: mid.toUpperCase(), size: parsed, from, subject };
}

/** `;FW: OK4RM OK1ABC|12345678` — the addresses, with any auxiliary password stripped. */
export function parseForwarders(line: string): string[] {
  return line
    .replace(/^;FW:?\s*/i, '')
    .split(/\s+/)
    .map((entry) => entry.split('|')[0]?.trim().toUpperCase() ?? '')
    .filter(Boolean);
}

/**
 * One exchange. Instances are single-use: one session, one connection.
 */
export class Session {
  private readonly options: SessionOptions;
  private readonly handler: SessionHandler;
  private readonly result: ExchangeResult;
  private duplex: Duplex | null = null;
  private reader: ByteReader | null = null;
  private timer: NodeJS.Timeout | null = null;
  private abortError: Error | null = null;
  private silenceError: Error | null = null;
  private quitSent = false;
  private quitReceived = false;
  private remoteNoMsgs = false;
  private challenge = '';
  private remoteSid: Sid | null = null;
  private remoteSidLine = '';
  private forwarders: string[] = [];
  private pending = new Map<string, PendingMessage>();
  private startedAt = 0;
  private turns = 0;

  constructor(options: SessionOptions) {
    this.options = options;
    this.handler = options.handler;
    this.result = emptyResult();
  }

  /** Ends the session from outside (an operator pressing Abort, a supervisor). */
  abort(reason = 'the session was cancelled'): void {
    if (this.abortError) return;
    this.abortError = new Error(reason);
    void Promise.resolve(this.duplex?.close()).catch(() => undefined);
  }

  /**
   * Runs the exchange. Never throws: a failed or aborted session is a result the
   * caller has to read, because that is what the operator will be shown.
   */
  async run(duplex: Duplex): Promise<ExchangeResult> {
    this.duplex = duplex;
    this.reader = new ByteReader(duplex, () => this.touch());
    this.startedAt = Date.now();
    this.touch();

    try {
      if (this.options.master) await this.sendHandshake('');
      await this.readHandshake();
      if (!this.options.master) await this.sendHandshake(this.challenge);

      for (let mine = !this.options.master; !(this.quitSent || this.quitReceived); mine = !mine) {
        this.turns += 1;
        if (this.turns > MAX_TURNS) {
          throw new ProtocolError(`the exchange did not end after ${MAX_TURNS} turns`, 'turn');
        }
        if (mine) await this.sendTurn();
        else await this.receiveTurn();
        this.touch();
      }

      await duplex.flush();
      this.result.result = 'complete';
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (this.abortError) {
        this.result.result = 'aborted';
        this.result.error = this.abortError.message;
      } else {
        this.result.result = 'failed';
        this.result.error = failure.message;
        // A protocol error is the peer's to see: it is what makes a bad session
        // show up in the gateway's log rather than as silence.
        if (failure instanceof ProtocolError) await this.echoError(failure.message);
      }
    } finally {
      this.clearTimer();
      await Promise.resolve(this.duplex?.close()).catch(() => undefined);
      this.result.elapsedMs = Date.now() - this.startedAt;
      this.result.remoteSid = this.remoteSidLine;
      this.result.forwarders = [...this.forwarders];
      this.result.pending = [...this.pending.values()];
    }
    return this.result;
  }

  // -- handshake ------------------------------------------------------------

  private get mode(): SessionMode {
    return this.options.mode ?? 'cms';
  }

  /**
   * A CMS routes for all of Winlink, so it is asked for every address we collect for.
   * A peer station holds mail for itself alone; asking it for an auxiliary address only
   * makes it answer "nothing for that one", and some peers answer the whole block with
   * `-`. A post office may hold mail for several of our addresses, so it is asked for
   * all of them, as the CMS is.
   */
  private forwardersToAskFor(): string[] {
    if (this.mode === 'p2p') return [this.options.myCallsign];
    return [this.options.myCallsign, ...(this.options.auxiliary ?? [])];
  }

  private async sendHandshake(challenge: string): Promise<void> {
    await this.writeLine(forwarderLine(this.options.myCallsign, this.forwardersToAskFor().slice(1)));
    await this.writeLine(
      localSid(this.options.application ?? 'rfmail', this.options.version ?? '0.1', this.sidFlags()),
    );
    if (challenge !== '') {
      const password = this.options.password ?? '';
      if (password === '') {
        // Anyone may claim any callsign: an unanswered challenge means the peer cannot
        // know who it is talking to, so a server that asks for one (a CMS, or a post
        // office that holds accounts) is refused rather than served unauthenticated.
        // Only a peer station goes on without it — there is no authority to check a
        // password against, so there is nothing for the challenge to establish.
        if (this.mode !== 'p2p') {
          throw new ProtocolError(
            'the peer asked for a secure login and this station has no Winlink password',
            'handshake',
          );
        }
        this.result.log.push({ direction: '<', text: 'a secure login was offered; a peer cannot be authenticated, continuing' });
      } else {
        // Logged as it goes out. It is a hash of the nonce and the password, not the
        // password: it cannot be replayed against a different challenge, and it is what
        // an operator needs to see when a gateway refuses one.
        await this.writeLine(`;PR: ${secureLoginResponse(challenge, password)}`);
      }
    }
    await this.writeLine(
      greetingLine(this.options.target, this.options.myCallsign, this.options.locator ?? '', this.options.master === true),
    );
    await this.duplex?.flush();
  }

  private sidFlags(): string {
    // `$` is always last; the gzip letter goes just before it.
    return this.options.gzip === true ? 'B2FHMG$' : 'B2FHM$';
  }

  private async readHandshake(): Promise<void> {
    for (;;) {
      if (this.options.master) {
        const next = await this.peek();
        // A protocol command can follow the handshake immediately; the answering
        // half must not eat it as an unknown line.
        if (next === 0x46 /* 'F' */) return;
      }

      const line = await this.nextLine();
      if (line === '') continue;

      if (line.startsWith('[') && line.endsWith(']')) {
        const sid = parseSid(line);
        if (!sid) throw new ProtocolError(`malformed SID line: ${line}`, 'handshake');
        if (!supportsB2(sid)) {
          throw new ProtocolError('the peer does not support B2 forwarding', 'handshake');
        }
        this.remoteSid = sid;
        this.remoteSidLine = line;
        continue;
      }
      if (/^;FW\b/i.test(line)) {
        this.forwarders = parseForwarders(line);
        continue;
      }
      if (/^;PQ\b/i.test(line)) {
        this.challenge = line.replace(/^;PQ:?\s*/i, '');
        continue;
      }
      if (/^;PM\b/i.test(line)) {
        this.notePending(line);
        continue;
      }
      if (line.endsWith('>')) {
        // The prompt: the master may now be talked to. `*** MTD Stats …` and
        // other gateway chatter is simply not one of the lines above.
        break;
      }
      if (this.options.master && /^;\s+\S+\s+DE\s+\S+/i.test(line)) break;
    }

    if (!this.remoteSid) throw new ProtocolError('the peer sent no SID', 'handshake');
    this.handler.ready?.({ sid: this.remoteSid, forwarders: [...this.forwarders] });
  }

  // -- turns ----------------------------------------------------------------

  /** This station's turn: offer up to a block of proposals, or say there is nothing. */
  private async sendTurn(): Promise<void> {
    const items = (await this.handler.outbound([...this.forwarders])).slice(0, MAX_PROPOSALS_PER_BLOCK);

    if (items.length === 0) {
      const reply = this.remoteNoMsgs ? 'FQ' : 'FF';
      await this.writeLine(reply);
      if (this.remoteNoMsgs) this.quitSent = true;
      return;
    }

    const proposals: Proposal[] = items.map((item) => ({
      code: item.code,
      messageType: item.type,
      mid: item.mid,
      size: item.raw.length,
      compressedSize: item.compressed.length,
    }));

    for (const line of formatProposalBlock(proposals)) await this.writeLine(line);
    const answers = await this.readProposalAnswers(proposals.length);

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const answer = answers[index]!;

      if (answer.decision === 'accept') {
        const framed = encodeTransfer({ title: encodeWords(item.subject), offset: answer.offset }, item.compressed);
        this.log('>', `>> ${item.mid} ${item.raw.length} bytes, ${item.compressed.length} compressed, offset ${answer.offset}`);
        await this.write(framed);
        await this.duplex?.flush();
        this.result.sent.push(item.mid);
        this.result.offeredBytes += framed.length;
        this.handler.sent(item.mid);
        continue;
      }

      if (answer.decision === 'reject') {
        this.result.rejected.push(item.mid);
        this.handler.rejected(item.mid);
        continue;
      }

      this.result.deferred.push(item.mid);
      this.handler.deferred(item.mid);
    }
  }

  private async readProposalAnswers(offered: number): Promise<Array<{ decision: 'accept' | 'reject' | 'defer'; offset: number }>> {
    for (;;) {
      const line = await this.nextLine();
      if (line === '') continue;
      if (line.startsWith('FS ') || line === 'FS') {
        const answers = parseAnswerLine(line.replace(/^FS ?/, ''));
        if (answers.length !== offered) {
          throw new ProtocolError(
            `the peer answered ${answers.length} of the ${offered} proposals offered`,
            'answer',
          );
        }
        return answers;
      }
      if (line.startsWith(';PM')) {
        this.notePending(line);
        continue;
      }
      if (line.startsWith(';')) continue;
      throw new ProtocolError(`expected a proposal answer from the peer, got: ${line}`, 'answer');
    }
  }

  /** The peer's turn: read its proposal block (or FF/FQ), answer it, fetch what we accepted. */
  private async receiveTurn(): Promise<void> {
    const proposals: Proposal[] = [];
    let checksum = 0;
    let answered = false;

    for (;;) {
      const line = await this.nextLine();
      if (line === '') continue;
      if (line.startsWith(';PM')) {
        this.notePending(line);
        continue;
      }
      if (line.startsWith(';')) continue;
      if (line.length < 2 || line[0] !== 'F') {
        throw new ProtocolError(`unexpected line from the peer: ${line}`, 'turn');
      }

      const verb = line.slice(0, 2);
      switch (verb) {
        case 'FA':
        case 'FB':
        case 'FC':
        case 'FD': {
          for (let index = 0; index < line.length; index += 1) checksum = (checksum + line.charCodeAt(index)) & 0xff;
          checksum = (checksum + 0x0d) & 0xff;
          proposals.push(parseProposal(line));
          continue;
        }
        case 'FF': {
          this.remoteNoMsgs = true;
          break;
        }
        case 'FQ': {
          this.quitReceived = true;
          break;
        }
        case 'F>': {
          const received = Number.parseInt(line.slice(2).trim(), 16);
          const expected = (-checksum) & 0xff;
          if (!Number.isFinite(received) || received !== expected) {
            throw new ProtocolError(
              `proposal block checksum mismatch: the peer said ${line.slice(2).trim()}, the lines sum to ${expected.toString(16).toUpperCase().padStart(2, '0')}`,
              'proposals',
            );
          }
          if (proposals.length === 0) {
            this.remoteNoMsgs = true;
            return;
          }
          await this.answerProposals(proposals);
          answered = true;
          break;
        }
        default:
          throw new ProtocolError(`unknown protocol line: ${line}`, 'turn');
      }
      break;
    }

    // An FQ ends the exchange; a block we answered is followed by the messages we
    // accepted, in the order they were proposed.
    if (answered) await this.fetchAccepted(proposals);
  }

  private async answerProposals(proposals: Proposal[]): Promise<void> {
    const answers: ProposalAnswer[] = [];
    const seen = new Set<string>();

    for (const proposal of proposals) {
      let answer: ProposalAnswer;
      if (seen.has(proposal.mid)) {
        // Radio-only gateways propose the same MID twice in one block: defer the
        // duplicate until one copy is actually in hand.
        answer = '=';
      } else if (proposal.code !== 'C' && proposal.code !== 'D') {
        // A basic/ASCII proposal cannot carry what this store holds; ask later
        // rather than refuse the message for good.
        answer = '=';
      } else {
        answer = await this.handler.answer(proposal);
      }
      seen.add(proposal.mid);
      this.answered.set(proposal, answer);
      answers.push(answer);
    }

    await this.writeLine(`FS ${formatAnswers(answers)}`);
  }

  private async fetchAccepted(proposals: Proposal[]): Promise<void> {
    const answers = this.lastAnswers(proposals);
    for (let index = 0; index < proposals.length; index += 1) {
      const proposal = proposals[index]!;
      if (answers[index] !== '+') continue;

      try {
        const message = await this.receiveMessage(proposal);
        this.result.received.push(proposal.mid);
        await this.handler.received(message, {
          ...(this.pending.get(proposal.mid) ?? {
            mid: proposal.mid,
            to: '',
            from: '',
            subject: '',
            size: proposal.size,
          }),
          proposal,
        });
      } catch (error) {
        if (!(error instanceof TransferError)) throw error;
        this.result.failed.push({ mid: proposal.mid, reason: error.message });
        this.handler.receiveFailed?.(proposal, error.message);
      }
    }
  }

  /**
   * The answers just written for this block. `answerProposals` computed them once;
   * keeping them here avoids asking the handler twice (a deferred message would
   * otherwise be asked about again and could be answered differently).
   */
  private answered = new Map<Proposal, ProposalAnswer>();

  private lastAnswers(proposals: Proposal[]): ProposalAnswer[] {
    const answers = proposals.map((proposal) => this.answered.get(proposal) ?? '=');
    this.answered = new Map();
    return answers;
  }

  /** Reads one framed message and decodes it. A damaged message throws TransferError. */
  private async receiveMessage(proposal: Proposal): Promise<B2Message> {
    const decoder = new TransferDecoder();
    let payload: Uint8Array | null = null;

    for (;;) {
      const chunk = await this.take();
      let events;
      try {
        events = decoder.push(chunk);
      } catch (error) {
        // The framing itself is broken; nothing can resynchronise inside it.
        throw new ProtocolError(
          `framing error in ${proposal.mid}: ${error instanceof Error ? error.message : String(error)}`,
          'transfer',
        );
      }

      for (const event of events) {
        if (event.type === 'remote-error') {
          this.reader?.unshift(decoder.drain());
          throw new TransferError(proposal.mid, `the peer refused the message: ${event.line}`);
        }
        if (event.type === 'header' && event.header.offset !== 0) {
          throw new TransferError(
            proposal.mid,
            `the peer sent a partial message at offset ${event.header.offset}`,
          );
        }
        if (event.type === 'end') {
          if (!event.checksumOk) throw new TransferError(proposal.mid, 'bad checksum');
          if (event.payload.length !== proposal.compressedSize) {
            throw new TransferError(
              proposal.mid,
              `${event.payload.length} bytes arrived, the proposal declared ${proposal.compressedSize}`,
            );
          }
          payload = event.payload;
        }
      }

      if (payload) {
        // Anything after the EOT belongs to the next line, not to this decoder.
        this.reader?.unshift(decoder.drain());
        break;
      }
    }

    this.result.receivedBytes += payload.length;
    this.log('<', `<< ${proposal.mid} ${payload.length} bytes`);

    let raw: Uint8Array;
    try {
      raw = proposal.code === 'D' ? new Uint8Array(gunzipSync(payload)) : decompressB2(payload);
    } catch (error) {
      throw new TransferError(
        proposal.mid,
        `cannot decompress: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      return parseB2Message(raw);
    } catch (error) {
      throw new TransferError(
        proposal.mid,
        `malformed message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // -- plumbing -------------------------------------------------------------

  private touch(): void {
    this.clearTimer();
    const silenceMs = this.options.silenceMs ?? DEFAULT_SILENCE_MS;
    if (silenceMs <= 0) return;
    this.timer = setTimeout(() => {
      if (this.abortError || this.silenceError) return;
      // Silence is a lost link, not a cancellation: the operator did not ask for
      // this and the report has to say why the session stopped.
      this.silenceError = new LinkLostError(`the peer was silent for ${Math.round(silenceMs / 1000)} seconds`);
      void Promise.resolve(this.duplex?.close()).catch(() => undefined);
    }, silenceMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private log(direction: '>' | '<', text: string): void {
    this.result.log.push({ direction, text });
    this.handler.line?.(direction, text);
  }

  private async writeLine(line: string): Promise<void> {
    this.log('>', line);
    await this.write(Buffer.from(`${line}\r`, 'latin1'));
  }

  private async write(data: Uint8Array): Promise<void> {
    if (!this.duplex) throw new LinkLostError('the session has no connection');
    if (this.abortError) throw this.abortError;
    await this.duplex.write(data);
  }

  private async nextLine(): Promise<string> {
    const reader = this.reader;
    if (!reader) throw new LinkLostError('the session has no connection');
    let text: string;
    try {
      text = await reader.line();
    } catch (error) {
      if (this.abortError) throw this.abortError;
      if (this.silenceError) throw this.silenceError;
      throw new LinkLostError(error instanceof Error ? error.message : String(error));
    }
    if (text !== '') this.log('<', text);
    return text;
  }

  private async peek(): Promise<number> {
    const reader = this.reader;
    if (!reader) throw new LinkLostError('the session has no connection');
    try {
      return await reader.peek();
    } catch (error) {
      if (this.abortError) throw this.abortError;
      if (this.silenceError) throw this.silenceError;
      throw new LinkLostError(error instanceof Error ? error.message : String(error));
    }
  }

  private async take(): Promise<Buffer> {
    const reader = this.reader;
    if (!reader) throw new LinkLostError('the session has no connection');
    try {
      return await reader.take();
    } catch (error) {
      if (this.abortError) throw this.abortError;
      if (this.silenceError) throw this.silenceError;
      throw new LinkLostError(error instanceof Error ? error.message : String(error));
    }
  }

  private notePending(line: string): void {
    const pending = parsePendingMessage(line);
    if (!pending) return;
    // Older peers leave `;PM:` out, so this is a detail for the screen, never a
    // precondition for the transfer itself.
    this.pending.set(pending.mid, pending);
  }

  private async echoError(message: string): Promise<void> {
    try {
      await this.write(Buffer.from(`*** ${message}\r\n`, 'latin1'));
      await this.duplex?.flush();
    } catch {
      // The link is already gone; the error is still in the result.
    }
  }
}

