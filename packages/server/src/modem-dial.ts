// Dialling a modem: the connect half of a session.
//
// There is no FBB exchange here yet. This module opens the modem's command port,
// asks it to dial the gateway, watches the dialect's answers until the call is
// connected or has clearly failed, and then drops the link. Everything it reports
// comes from the modem's own words — `CONNECTED`, `BUSY`, `DISCONNECTED`, `FAULT` —
// rather than from a guess about what the radio is doing.
//
// Two dialects cover every modem the station knows, and both sequences below follow
// the reference clients line for line (`wl2k-go/transport/ardop`, `Pat-Vara/vara`):
//   * ARDOP: `MYCALL`, `ARQBW <bw>MAX`, then `ARQCALL <target> <repeats>`;
//   * VARA: `MYCALL`, `LISTEN OFF`, `COMPRESSION TEXT`, `WINLINK SESSION` on HF,
//     `BW<bandwidth>`, then `CONNECT <my> <target>` — the bandwidth travels in its
//     own command, not in CONNECT, and `WINLINK SESSION` is what tells VARA HF this
//     is a Winlink call rather than a peer-to-peer one.
// Both answer `CONNECTED` on success, `DISCONNECTED` when the call failed,
// `BUSY ON` when the frequency is occupied, and `FAULT` when the modem is unhappy.

import { createConnection, type Socket } from 'node:net';
import { parseModemVersion, type ModemIdentity } from '@rfmail/shared';

export type DialResult = 'connected' | 'failed' | 'error' | 'cancelled';

export interface DialOutcome {
  result: DialResult;
  /** One sentence for the operator. */
  message: string;
  /** Every line the modem sent, in order, for the record. */
  log: string[];
  elapsedMs: number;
  /** The bandwidth the modem reported on connect, when it says. */
  connectedBandwidthHz: number | null;
  /**
   * The modem's command socket, still open, when `keepConnected` was asked for
   * and the call is up. The caller owns it from here: it closes the link with
   * {@link hangUpModem} when the exchange is over.
   */
  link?: Socket;
}

export interface DialOptions {
  host: string;
  port: number;
  /** `ardop` for the ARDOP host interface, `vara` for everything VARA-shaped. */
  dialect: 'ardop' | 'vara';
  /** The station's own callsign, which goes on the air. */
  myCallsign: string;
  target: string;
  /** Wanted bandwidth in hertz, in the chosen modem's own set. */
  bandwidthHz: number;
  /**
   * The bandwidths the modem accepts, or null when they are not recorded — in which
   * case no bandwidth command is sent rather than one it would reject.
   */
  bandwidthChoices?: number[] | null;
  /** How long to wait for the call to settle. */
  timeoutMs?: number;
  /** How many connect frames ARDOP should send. */
  connectRequests?: number;
  /**
   * Whether the modem is an HF VARA: those need a session type before dialling, because
   * the framing differs between a Winlink call and a peer-to-peer contact.
   */
  hf?: boolean;
  /**
   * A peer-to-peer call. HF VARA takes `P2P SESSION` for it where a Winlink call takes
   * `WINLINK SESSION`; modems without the command ignore it, and a post office is a
   * Winlink-framed server, not a peer.
   */
  p2p?: boolean;
  /**
   * A modem that speaks the VARA ports but not VARA's command set — Data2G — gets the
   * commands it knows (`MYCALL`, `LISTEN`, `BW…`, `CONNECT`) and none of the rest.
   */
  plainVara?: boolean;
  /**
   * Leave the call up and hand the socket back in `link`, for a session that runs
   * over the link. The connect test leaves this off and hangs up.
   */
  keepConnected?: boolean;
  /**
   * Every line the modem says and every command we send, with how long into the call it
   * happened. A record without timestamps cannot tell "CONNECTED, then silence" from
   * "CONNECTED, then a disconnect frame a second later" — the same words, different story.
   */
  onModemLine?: (atMs: number, line: string) => void;
  onCommand?: (atMs: number, command: string) => void;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** After a terminal answer, how long the modem gets to acknowledge the disconnect. */
const HANGUP_GRACE_MS = 2_500;
/** A single busy stretch this long, with few transitions, is a station, not a voice. */
const BUSY_STEADY_MS = 4_000;
/** Transitions seen inside this window decide whether the signal is broken up. */
const BUSY_WINDOW_MS = 10_000;
/** At most this many transitions in the window still counts as one steady signal. */
const BUSY_CHATTY = 5;

/** ARDOP writes its bandwidth as `500MAX`; VARA writes plain numbers. */
export function ardopBandwidth(bandwidthHz: number): string {
  const allowed = [200, 500, 1000, 2000];
  const nearest = allowed.reduce((best, value) =>
    Math.abs(value - bandwidthHz) < Math.abs(best - bandwidthHz) ? value : best,
  );
  return `${nearest}MAX`;
}

/**
 * Snaps a wanted bandwidth to one the modem actually offers. A catalogue mode may say
 * 2750 Hz on a channel a Data2G station lists, but Data2G works 200, 500 and 2300 — the
 * modem's own set wins, because it is the one that has to accept the command.
 */
export function nearestBandwidth(bandwidthHz: number, allowed: readonly number[]): number {
  if (allowed.length === 0) return bandwidthHz;
  return allowed.reduce((best, value) =>
    Math.abs(value - bandwidthHz) < Math.abs(best - bandwidthHz) ? value : best,
  );
}

/** The bandwidth a catalogue mode string implies, for the modem's dial. */
export function bandwidthOfMode(mode: string, fallback = 2300): number {
  const number = /(\d{3,4})/.exec(mode);
  if (number) return Number(number[1]);
  const lower = mode.toLowerCase();
  if (lower.startsWith('vara fm')) return 1200;
  if (lower.startsWith('ardop')) return 2000;
  if (lower.startsWith('vara')) return 2300;
  return fallback;
}

interface Pending {
  settle: (outcome: DialOutcome) => void;
  finished: boolean;
  /** The modem reported the channel occupied; the call is still being attempted. */
  busy: boolean;
  /** When the current busy stretch began, or null when the channel is clear. */
  busySince: number | null;
  /** When every busy transition happened, for telling voice from data. */
  busyTransitions: number[];
  log: string[];
  connectedBandwidthHz: number | null;
  startedAt: number;
  /** The command socket, kept for a session when the caller asked for it. */
  link: Socket | null;
}

/**
 * Opens the command port and dials. Resolves with what the modem said; never
 * throws for a modem that refuses or is not there — that is a result, not an
 * exception, and the operator needs to read it.
 */
export async function dialModem(options: DialOptions): Promise<DialOutcome> {
  const startedAt = Date.now();
  const log: string[] = [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let socket: Socket;
  try {
    socket = await openSocket(options.host, options.port, CONNECT_TIMEOUT_MS);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      result: 'error',
      message: `cannot reach the modem at ${options.host}:${options.port}: ${reason}`,
      log,
      elapsedMs: Date.now() - startedAt,
      connectedBandwidthHz: null,
    };
  }

  log.push(`connected to ${options.host}:${options.port}`);

  return await new Promise<DialOutcome>((resolve) => {
    const state: Pending = {
      settle: () => {},
      finished: false,
      busy: false,
      busySince: null,
      busyTransitions: [],
      log,
      connectedBandwidthHz: null,
      startedAt,
      link: null,
    };

    const finish = (result: DialResult, message: string): void => {
      if (state.finished) return;
      state.finished = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearInterval(busyWatch);
      resolve({
        result,
        message,
        log: [...state.log],
        elapsedMs: Date.now() - state.startedAt,
        connectedBandwidthHz: state.connectedBandwidthHz,
        ...(state.link ? { link: state.link } : {}),
      });
    };

    // The hang-up is sent only after a terminal answer, and the socket is closed
    // whether or not the modem acknowledges it.
    let graceTimer: NodeJS.Timeout | undefined;
    const hangUp = (result: DialResult, message: string): void => {
      if (state.finished) return;
      state.finished = true;
      clearTimeout(timer);
      clearInterval(busyWatch);
      state.log.push('the client is ending the call (we sent DISCONNECT)');
      write('DISCONNECT');
      const settled = (): void => {
        clearTimeout(graceTimer);
        socket.destroy();
        resolve({
          result,
          message,
          log: [...state.log],
          elapsedMs: Date.now() - state.startedAt,
          connectedBandwidthHz: state.connectedBandwidthHz,
        });
      };
      graceTimer = setTimeout(settled, HANGUP_GRACE_MS);
      socket.once('close', settled);
      // ARDOP ignores DISCONNECT when idle, so nudge it out of any ARQ state too.
      if (options.dialect === 'ardop') write('ABORT');
    };

    /**
     * How long a single steady busy stretch may last before the call is abandoned. A
     * voice transmission breaks into syllables and pauses, so its busy stretches are
     * short and its transitions irregular; a data station holds the channel for many
     * seconds without a gap. The thresholds are a heuristic and are named as such:
     * BUSY_STEADY_MS of one stretch, with at most BUSY_CHATTY transitions in the last
     * BUSY_WINDOW_MS, is a station; anything more broken up is a voice and is ignored.
     */
    const busyWatch = setInterval(() => {
      if (state.finished || !state.busy || state.busySince === null) return;
      const now = Date.now();
      const recent = state.busyTransitions.filter((at) => now - at < BUSY_WINDOW_MS).length;
      const stretch = now - state.busySince;
      if (stretch >= BUSY_STEADY_MS && recent <= BUSY_CHATTY) {
        hangUp(
          'failed',
          `the frequency is carrying another station (${Math.round(stretch / 1000)} seconds of unbroken signal)`,
        );
      }
    }, 500);
    busyWatch.unref?.();

    /** Sends a command and records it with the moment it went out. */
    const write = (line: string): void => {
      const atMs = Date.now() - state.startedAt;
      state.log.push(`+${(atMs / 1000).toFixed(2)}s > ${line}`);
      options.onCommand?.(atMs, line);
      send(socket, line);
    };

    const timer = setTimeout(() => {
      const seconds = Math.round(timeoutMs / 1000);
      hangUp(
        'failed',
        state.busy
          ? `the frequency was busy for ${seconds} seconds and ${options.target} never came back`
          : `no answer from ${options.target} within ${seconds} seconds`,
      );
    }, timeoutMs);

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.search(/[\r\n]/);
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handleLine(line);
        index = buffer.search(/[\r\n]/);
      }
    });

    socket.on('error', (error: Error) => {
      hangUp('error', `the modem connection failed: ${error.message}`);
    });
    socket.on('close', () => {
      if (!state.finished) {
        // A modem that closes the socket mid-dial has stopped trying.
        finish('failed', 'the modem closed the connection during the call');
      }
    });

    const handleLine = (line: string): void => {
      const atMs = Date.now() - state.startedAt;
      state.log.push(`+${(atMs / 1000).toFixed(2)}s < ${line}`);
      options.onModemLine?.(atMs, line);
      const [verb] = line.split(/\s+/);
      const word = (verb ?? '').toUpperCase();

      switch (word) {
        case 'CONNECTED': {
          // ARDOP: `CONNECTED <call> <bw>`; VARA: `CONNECTED` (data follows on the
          // data port). Either way the call is up.
          const bw = Number(line.split(/\s+/)[2]);
          state.connectedBandwidthHz = Number.isFinite(bw) && bw > 0 ? bw : options.bandwidthHz;
          if (options.keepConnected) {
            // The call is up and the caller runs a session over it: no hang-up.
            state.link = socket;
            finish('connected', `connected to ${options.target}`);
            return;
          }
          hangUp('connected', `connected to ${options.target}`);
          return;
        }
        case 'DISCONNECTED':
          // The modem says the far end ended the call. Before `CONNECTED` that means it
          // never came up; afterwards the session's own reader sees the link close.
          state.log.push(
            state.link
              ? 'the far end sent a disconnect frame'
              : 'the far end sent a disconnect frame before the call was up',
          );
          hangUp('failed', `${options.target} sent a disconnect frame — it did not answer`);
          return;
        case 'BUSY':
          // `BUSY ON` means the modem hears a real signal in the channel: someone else
          // is on the frequency. It is not a verdict on our call — Data2G 0.5.3 sends it
          // a few hundred milliseconds before `CONNECTED` on a call that comes up — so
          // the shape is what decides: short irregular bursts are voice and are dialled
          // through, while one long steady stretch is data and the call is abandoned
          // rather than transmitted into (see `busyWatch`).
          state.busyTransitions.push(Date.now());
          if (/\bON\b/i.test(line)) {
            state.busy = true;
            state.busySince = Date.now();
            state.log.push('the modem reports the frequency is busy; watching the shape');
          } else {
            state.busy = false;
            state.busySince = null;
            state.log.push('the frequency is clear again');
          }
          return;
        case 'FAULT':
        case 'ERROR':
          hangUp('error', line);
          return;
        case 'CANCELPENDING':
        case 'PENDING':
        case 'PTT':
        case 'NEWSTATE':
        case 'STATUS':
        case 'BUFFER':
        case 'VERSION':
        case 'IAMALIVE':
        case 'REPEAT':
        case 'CANCEL':
        case 'OK':
        case 'PUBLIC':
        case 'LISTEN':
        case 'MYCALL':
        case 'ARQBW':
          // Progress and housekeeping, not an outcome.
          return;
        default:
          // Unknown verbs are kept in the log and otherwise ignored: some modems
          // emit lines this code has no business acting on.
          return;
      }
    };

    // The dial itself, in the order the reference clients use.
    if (options.dialect === 'ardop') {
      write(`MYCALL ${options.myCallsign}`);
      write(`ARQBW ${ardopBandwidth(options.bandwidthHz)}`);
      write(`ARQCALL ${options.target} ${options.connectRequests ?? 10}`);
      state.log.push(`dialling: ARQCALL ${options.target} at ${ardopBandwidth(options.bandwidthHz)}`);
    } else {
      write(`MYCALL ${options.myCallsign}`);
      write('LISTEN OFF');
      // The rest of this preamble is VARA's own. Data2G speaks the VARA ports but not
      // these commands — it knows MYCALL, LISTEN, CONNECT, BW… and its own extensions —
      // so a Data2G modem gets the common part only.
      if (!options.plainVara) {
        write('COMPRESSION TEXT');
        // VARA HF distinguishes a Winlink call from a peer-to-peer one; VARA FM does not
        // take the command at all, so it is sent only where it belongs.
        if (options.hf) write(options.p2p === true ? 'P2P SESSION' : 'WINLINK SESSION');
      }
      const choices = options.bandwidthChoices;
      let chosen = options.bandwidthHz;
      if (choices === null || choices === undefined) {
        state.log.push('bandwidths of this modem are not recorded, so none is requested');
      } else {
        chosen = nearestBandwidth(options.bandwidthHz, choices);
        write(`BW${chosen}`);
      }
      write(`CONNECT ${options.myCallsign} ${options.target}`);
      state.log.push(`dialling: CONNECT ${options.myCallsign} ${options.target} at ${chosen} Hz`);
    }
  });
}

export interface HangUpOptions {
  /** How long to wait for the modem to report `DISCONNECTED` after `DISCONNECT`. */
  disconnectedMs?: number;
  /** How long the air must stay quiet after that, for the closing ID frame to finish. */
  quietMs?: number;
  /** A ceiling on the whole hang-up, however chatty the modem stays. */
  hardMs?: number;
  /** Every line the modem says while hanging up, for the session record. */
  onLine?: (line: string) => void;
}

/**
 * Ends a call that `dialModem(…, keepConnected)` left up.
 *
 * `DISCONNECT` is not the end of the transmission: measured on the air, the modem went on
 * keying for eight seconds afterwards, and both stations send an identification frame
 * once the exchange is over. So the link is closed only when the modem has said
 * `DISCONNECTED` and the air has then been quiet — no `PTT ON`, no new lines — for a few
 * seconds. The hard ceiling means a modem that never falls silent is still closed on.
 */
export interface HangUpReport {
  /** The modem said DISCONNECTED; without it the peer's fate is unknown, not fine. */
  sawDisconnected: boolean;
  /** Why the link was closed, in the words an operator needs. */
  by: 'client';
  /** The modem never said DISCONNECTED within the wait; the call may still have been up. */
  timedOut: boolean;
  /** Every line the modem said after DISCONNECT, in order, with how long after it came. */
  lines: string[];
}

export async function hangUpModem(socket: Socket, options: HangUpOptions = {}): Promise<HangUpReport> {
  if (socket.destroyed) return { sawDisconnected: false, by: 'client', timedOut: false, lines: [] };
  const disconnectedMs = options.disconnectedMs ?? 12_000;
  const quietMs = options.quietMs ?? 4_000;
  const hardMs = options.hardMs ?? 30_000;

  const startedAt = Date.now();
  const lines: string[] = [];
  let sawDisconnected = false;
  let silentFor = 0;

  await new Promise<void>((resolve) => {
    let pttOn = false;
    let lastLineAt = Date.now();
    let partial = '';
    let finished = false;
    let gaveUpWaiting = false;

    const done = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      clearTimeout(disconnectedTimer);
      clearInterval(poll);
      socket.removeListener('close', done);
      socket.destroy();
      resolve();
    };

    const hardTimer = setTimeout(done, hardMs);
    hardTimer.unref?.();
    const disconnectedTimer = setTimeout(() => {
      // The modem never said DISCONNECTED; look for quiet all the same, but say so.
      gaveUpWaiting = true;
      silentFor = Date.now();
    }, disconnectedMs);
    disconnectedTimer.unref?.();

    const poll = setInterval(() => {
      if (sawDisconnected) {
        if (!pttOn && Date.now() - lastLineAt >= quietMs) done();
        return;
      }
      // Nothing came within the wait: stop once the air has been quiet for a while too.
      if (gaveUpWaiting && !pttOn && Date.now() - lastLineAt >= quietMs) done();
    }, 200);
    poll.unref?.();

    socket.on('data', (chunk: string | Buffer) => {
      partial += chunk.toString();
      let index = partial.search(/[\r\n]/);
      while (index >= 0) {
        const line = partial.slice(0, index).trim();
        partial = partial.slice(index + 1);
        if (line) {
          lastLineAt = Date.now();
          lines.push(`+${((lastLineAt - startedAt) / 1000).toFixed(2)}s < ${line}`);
          if (/^DISCONNECTED/i.test(line)) sawDisconnected = true;
          if (/^PTT\b/i.test(line)) pttOn = /\bON\b/i.test(line);
          options.onLine?.(line);
        }
        index = partial.search(/[\r\n]/);
      }
    });
    socket.once('close', done);

    try {
      socket.write('DISCONNECT\r');
    } catch {
      done();
    }
  });

  return { sawDisconnected, by: 'client', timedOut: !sawDisconnected, lines };
}

function send(socket: Socket, line: string): void {
  if (socket.destroyed) return;
  try {
    socket.write(`${line}\r`);
  } catch {
    // A write to a socket the modem just closed is not worth an exception: the
    // close handler has already settled the call.
  }
}

/**
 * Is the modem's command port answering? A plain TCP connect that sends nothing: a
 * configured modem is not a running one, and the screen should not pretend otherwise.
 */
/**
 * Asks the command port who it is. VARA, XARA, Data2G and Mercury are indistinguishable by
 * port, and the digital mode to run depends on which one is answering, so `VERSION` is
 * sent and its answer classified. A modem that does not answer the command (an old VARA
 * build returns `WRONG`, a stranger returns nothing) still counts as running, with the
 * identity unknown — that is a fact about the modem, not a failure.
 */
export async function identifyModem(
  host: string,
  port: number,
  timeoutMs = 1_500,
): Promise<{ running: boolean; error: string | null; identity: ModemIdentity | null }> {
  let socket: Socket;
  try {
    socket = await openSocket(host, port, 700);
  } catch (error) {
    return {
      running: false,
      error: error instanceof Error ? error.message : String(error),
      identity: null,
    };
  }

  return await new Promise((resolve) => {
    let reply = '';
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ running: true, error: null, identity: reply ? parseModemVersion(reply) : null });
    };
    const timer = setTimeout(done, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      reply += chunk;
      // One line is the answer; anything after it belongs to another command.
      if (reply.includes('\r') || reply.includes('\n')) done();
    });
    socket.once('error', done);
    try {
      socket.write('VERSION\r');
    } catch {
      done();
    }
  });
}

/**
 * Arms or disarms a modem for inbound calls: `LISTEN ON` / `LISTEN OFF`, the same command
 * the dial sends before a call and the one an operator needs to accept a P2P session.
 * Returns what the modem answered rather than a bare success, because a build that does
 * not take the command says so with `WRONG` and the screen should show that.
 */
export async function setModemListening(
  host: string,
  port: number,
  on: boolean,
  timeoutMs = 1_500,
): Promise<{ ok: boolean; answer: string; error: string | null }> {
  let socket: Socket;
  try {
    socket = await openSocket(host, port, 700);
  } catch (error) {
    return { ok: false, answer: '', error: error instanceof Error ? error.message : String(error) };
  }

  return await new Promise((resolve) => {
    let reply = '';
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const answer = reply.replace(/[\r\n]+/g, ' ').trim();
      resolve({ ok: /^OK\b/i.test(answer), answer, error: null });
    };
    const timer = setTimeout(done, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      reply += chunk;
      if (reply.includes('\r') || reply.includes('\n')) done();
    });
    socket.once('error', done);
    try {
      socket.write(`LISTEN ${on ? 'ON' : 'OFF'}\r`);
    } catch {
      done();
    }
  });
}

export async function probeModem(
  host: string,
  port: number,
  timeoutMs = 700,
): Promise<{ running: boolean; error: string | null }> {
  try {
    const socket = await openSocket(host, port, timeoutMs);
    socket.destroy();
    return { running: true, error: null };
  } catch (error) {
    return {
      running: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function openSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
