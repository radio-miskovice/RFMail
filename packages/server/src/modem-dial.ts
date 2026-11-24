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
   * Whether the modem is an HF VARA: those need `WINLINK SESSION` before dialling so
   * the call runs in Winlink framing rather than as a peer-to-peer contact.
   */
  hf?: boolean;
  /**
   * A modem that speaks the VARA ports but not VARA's command set — Data2G — gets the
   * commands it knows (`MYCALL`, `LISTEN`, `BW…`, `CONNECT`) and none of the rest.
   */
  plainVara?: boolean;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** After a terminal answer, how long the modem gets to acknowledge the disconnect. */
const HANGUP_GRACE_MS = 2_500;

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
  log: string[];
  connectedBandwidthHz: number | null;
  startedAt: number;
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
      log,
      connectedBandwidthHz: null,
      startedAt,
    };

    const finish = (result: DialResult, message: string): void => {
      if (state.finished) return;
      state.finished = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve({
        result,
        message,
        log: [...state.log],
        elapsedMs: Date.now() - state.startedAt,
        connectedBandwidthHz: state.connectedBandwidthHz,
      });
    };

    // The hang-up is sent only after a terminal answer, and the socket is closed
    // whether or not the modem acknowledges it.
    let graceTimer: NodeJS.Timeout | undefined;
    const hangUp = (result: DialResult, message: string): void => {
      if (state.finished) return;
      state.finished = true;
      clearTimeout(timer);
      send(socket, options.dialect === 'ardop' ? 'DISCONNECT' : 'DISCONNECT');
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
      if (options.dialect === 'ardop') send(socket, 'ABORT');
    };

    const timer = setTimeout(() => {
      hangUp('failed', `no answer from ${options.target} within ${Math.round(timeoutMs / 1000)} seconds`);
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
      state.log.push(line);
      const [verb] = line.split(/\s+/);
      const word = (verb ?? '').toUpperCase();

      switch (word) {
        case 'CONNECTED': {
          // ARDOP: `CONNECTED <call> <bw>`; VARA: `CONNECTED` (data follows on the
          // data port). Either way the call is up.
          const bw = Number(line.split(/\s+/)[2]);
          state.connectedBandwidthHz = Number.isFinite(bw) && bw > 0 ? bw : options.bandwidthHz;
          hangUp('connected', `connected to ${options.target}`);
          return;
        }
        case 'DISCONNECTED':
          hangUp('failed', `${options.target} did not answer`);
          return;
        case 'BUSY':
          hangUp('failed', 'the frequency is busy');
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
      send(socket, `MYCALL ${options.myCallsign}`);
      send(socket, `ARQBW ${ardopBandwidth(options.bandwidthHz)}`);
      send(socket, `ARQCALL ${options.target} ${options.connectRequests ?? 10}`);
      state.log.push(`dialling: ARQCALL ${options.target} at ${ardopBandwidth(options.bandwidthHz)}`);
    } else {
      send(socket, `MYCALL ${options.myCallsign}`);
      send(socket, 'LISTEN OFF');
      // The rest of this preamble is VARA's own. Data2G speaks the VARA ports but not
      // these commands — it knows MYCALL, LISTEN, CONNECT, BW… and its own extensions —
      // so a Data2G modem gets the common part only.
      if (!options.plainVara) {
        send(socket, 'COMPRESSION TEXT');
        // VARA HF distinguishes a Winlink call from a peer-to-peer one; VARA FM does not
        // take the command at all, so it is sent only where it belongs.
        if (options.hf) send(socket, 'WINLINK SESSION');
      }
      const choices = options.bandwidthChoices;
      let chosen = options.bandwidthHz;
      if (choices === null || choices === undefined) {
        state.log.push('bandwidths of this modem are not recorded, so none is requested');
      } else {
        chosen = nearestBandwidth(options.bandwidthHz, choices);
        send(socket, `BW${chosen}`);
      }
      send(socket, `CONNECT ${options.myCallsign} ${options.target}`);
      state.log.push(`dialling: CONNECT ${options.myCallsign} ${options.target} at ${chosen} Hz`);
    }
  });
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
