// rigctld client: frequency, mode, VFO and PTT over the Hamlib daemon's TCP port.
//
// rigctld is a separate process the operator starts (`rigctld -m 1042 -r /dev/ttyUSB0`),
// so this station never links Hamlib and never touches a serial port: it opens a
// TCP connection, sends one command per line, and reads one answer. Long form
// commands are used (`\get_freq`, `\set_freq`) because the short forms collide
// with the `t`/`T` PTT aliases and differ between Hamlib versions.
//
// The daemon drops the connection when the radio is unplugged, so a command that
// hits EOF reconnects once and repeats — the same behaviour wl2k-go's client has,
// for the same reason: an unattended station must survive a USB re-enumeration.
//
// Answers are either the value, or `RPRT <code>` where 0 means success and a
// negative number an error from Hamlib. Nothing here logs, retries forever or
// throws on a slow radio: a timeout is reported as a typed error and the caller
// decides whether the session can go on.

import { createConnection, type Socket } from 'node:net';

export type RigMode =
  | 'USB'
  | 'LSB'
  | 'CW'
  | 'CWR'
  | 'AM'
  | 'FM'
  | 'WFM'
  | 'RTTY'
  | 'RTTYR'
  | 'PKTUSB'
  | 'PKTLSB'
  | 'PKTFM';

/** Errors Hamlib reports, mapped onto something a caller can act on. */
export class RigError extends Error {
  readonly code: number;
  readonly command: string;

  constructor(message: string, code: number, command: string) {
    super(message);
    this.name = 'RigError';
    this.code = code;
    this.command = command;
  }
}

/**
 * Which connector the audio is transmitted from. A modem feeds the rear input,
 * not the front microphone connector; on a TS-590 `T 1` keys with the front panel
 * microphone and `T 3` with the rear/USB line, so a station that gets this wrong
 * transmits silence and the far end hears nothing.
 *
 * The names are the operator's, not Hamlib's: `rear` is `RIG_PTT_ON_DATA` (3) and
 * `front` is `RIG_PTT_ON` (1). `auto` tries the rear input and falls back to plain
 * PTT, recording the fact — better a session that works on a rig without a
 * selectable rear input than a silent one.
 */
export type PttInput = 'rear' | 'front' | 'auto';

/** Hamlib's RIG_PTT_* values, as `\set_ptt` takes them. */
export const PTT_OFF = 0;
/** Plain PTT on: the front microphone connector on a TS-590. */
export const PTT_ON = 1;
/** PTT on with the rear/data input selected. */
export const PTT_ON_REAR = 3;
/** @deprecated Hamlib's own name for {@link PTT_ON_REAR}. */
export const PTT_ON_DATA = PTT_ON_REAR;

export interface RigctldOptions {
  host: string;
  port: number;
  /** Which connector transmits: the rear input a modem feeds, or the front mic. */
  pttInput?: PttInput;
  /** Milliseconds to wait for one answer before giving up. */
  timeoutMs?: number;
  /** How many times to reconnect and repeat a command that hit EOF. */
  reconnectAttempts?: number;
}

export interface RigState {
  frequencyHz: number;
  mode: RigMode | string;
  passbandHz: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_ATTEMPTS = 3;

function parseRprt(line: string): number | null {
  const match = /^RPRT\s+(-?\d+)$/.exec(line.trim());
  return match ? Number(match[1]) : null;
}

export class Rigctld {
  private readonly options: Required<RigctldOptions>;
  private pttValue = PTT_OFF;
  private pttFellBack = false;
  private socket: Socket | null = null;
  private pending = '';

  constructor(options: RigctldOptions) {
    this.options = {
      host: options.host,
      port: options.port,
      pttInput: options.pttInput ?? 'auto',
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      reconnectAttempts: options.reconnectAttempts ?? DEFAULT_ATTEMPTS,
    };
  }

  /** Opens the connection if it is not open. Idempotent, so callers stay simple. */
  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: this.options.host, port: this.options.port });
      const onError = (error: Error): void => {
        socket.destroy();
        reject(new RigError(`cannot reach rigctld at ${this.options.host}:${this.options.port}: ${error.message}`, -1, 'connect'));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        socket.setNoDelay(true);
        socket.on('error', () => this.drop());
        socket.on('close', () => this.drop());
        this.socket = socket;
        this.pending = '';
        resolve();
      });
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.pending = '';
    if (socket && !socket.destroyed) socket.end();
  }

  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    this.pending = '';
    if (socket && !socket.destroyed) socket.destroy();
  }

  /**
   * One command, one answer. Retries on EOF and on `RPRT -9` (Hamlib's "IO error"),
   * which is what a radio that was unplugged and replugged produces.
   */
  async command(line: string): Promise<string> {
    const answers = await this.exchange(line, 1);
    return answers[0] ?? '';
  }

  /**
   * The extended protocol: prefix the command with `+` and the daemon answers
   * with an echo line, labelled values, and a terminating `RPRT <code>`.
   *
   *   +\get_mode        -> get_mode:
   *                        Mode: PKTUSB
   *                        Passband: 2000
   *                        RPRT 0
   *
   * This is the only way to read a getter whose answer is several lines long
   * (`\get_split_vfo` returns Split and TX VFO, `\get_level` a bare number):
   * counting lines per command leaves the extra ones in the stream and every
   * later answer arrives shifted by one.
   */
  async extended(command: string): Promise<{ code: number; values: Map<string, string[]>; raw: string[] }> {
    const answers = await this.exchange(`+${command}`, 'terminated');
    const codeLine = answers.find((line) => /^RPRT\b/.test(line)) ?? '';
    const code = parseRprt(codeLine) ?? 0;
    if (code !== 0) throw new RigError(`rigctld rejected '${command}' with RPRT ${code}`, code, command);

    let lines = answers.filter((line) => !/^RPRT\b/.test(line));
    // The first line echoes the command ("get_level: STRENGTH"): drop it.
    const verb = command.replace(/^\\/, '').split(/[\s=]/)[0]?.toLowerCase() ?? '';
    if (lines.length > 1 && (lines[0] ?? '').toLowerCase().startsWith(verb)) lines = lines.slice(1);

    const values = new Map<string, string[]>();
    for (const line of lines) {
      const match = /^([^:]+):\s*(.*)$/.exec(line);
      if (match) {
        const key = (match[1] ?? '').trim().toLowerCase();
        const list = values.get(key) ?? [];
        list.push((match[2] ?? '').trim());
        values.set(key, list);
      } else {
        const list = values.get('') ?? [];
        list.push(line.trim());
        values.set('', list);
      }
    }
    return { code, values, raw: lines };
  }

  /**
   * Sends one command and reads `expected` lines. `\get_mode` answers with two
   * lines (mode, then passband) and leaving the second one in the buffer corrupts
   * whatever is sent next.
   */
  private async exchange(line: string, expected: number | 'terminated'): Promise<string[]> {
    const attempts = this.options.reconnectAttempts;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.connect();
        return await this.roundTrip(line, expected);
      } catch (error) {
        lastError = error;
        this.drop();
        if (error instanceof RigError && error.code !== -1 && error.code !== -9) throw error;
        if (attempt === attempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new RigError(`rigctld did not answer '${line}'`, -1, line);
  }

  private roundTrip(line: string, expected: number | 'terminated'): Promise<string[]> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new RigError('not connected', -1, line));

    return new Promise<string[]>((resolve, reject) => {
      // Whatever arrived after the previous answer belongs to this one.
      let buffer = this.pending;
      this.pending = '';
      const answers: string[] = [];
      let settled = false;

      const finish = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('data', onData);
        if (error) reject(error);
        else resolve(answers);
      };

      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('latin1');
        for (;;) {
          if (settled) return;
          const newline = buffer.indexOf('\n');
          if (newline === -1) return;
          const answer = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);

          const code = parseRprt(answer);
          if (code !== null) {
            if (code !== 0) {
              finish(new RigError(`rigctld rejected '${line}' with RPRT ${code}`, code, line));
              return;
            }
            // A bare `RPRT 0` is the whole answer: the command succeeded.
            answers.push(answer);
          } else {
            answers.push(answer);
          }

          const enough =
            expected === 'terminated'
              ? /^RPRT\b/.test(answer)
              : answers.length >= expected;
          if (enough) {
            // Anything the daemon volunteered for the next command is kept.
            this.pending = buffer;
            finish(null);
            return;
          }
        }
      };

      const timer = setTimeout(() => {
        finish(new RigError(`rigctld did not answer '${line}' within ${this.options.timeoutMs} ms`, -1, line));
      }, this.options.timeoutMs);
      timer.unref?.();

      socket.on('data', onData);
      socket.once('error', (error) => finish(new RigError(`rigctld connection failed: ${error.message}`, -1, line)));
      socket.once('close', () => finish(new RigError('rigctld closed the connection', -1, line)));
      socket.write(`${line}\n`);
    });
  }

  async getFrequency(): Promise<number> {
    const { values } = await this.extended('\\get_freq');
    const answer = (values.get('frequency') ?? values.get('') ?? [])[0] ?? '';
    const value = Number(answer.trim());
    if (!Number.isFinite(value) || value <= 0) {
      throw new RigError(`rigctld returned a bad frequency '${answer}'`, -1, '\\get_freq');
    }
    return value;
  }

  async setFrequency(hertz: number): Promise<void> {
    if (!Number.isFinite(hertz) || hertz <= 0) throw new RigError(`refusing frequency ${hertz}`, -1, '\\set_freq');
    await this.command(`\\set_freq ${Math.round(hertz)}`);
  }

  /** Mode and passband, read through the extended protocol (two answer lines). */
  async getMode(): Promise<{ mode: string; passbandHz: number }> {
    const { values } = await this.extended('\\get_mode');
    const mode = (values.get('mode') ?? values.get('') ?? [])[0] ?? '';
    const passband = (values.get('passband') ?? [])[0] ?? '0';
    return { mode: mode.trim().toUpperCase(), passbandHz: Number(passband.trim()) || 0 };
  }

  async setMode(mode: RigMode | string, passbandHz = 0): Promise<void> {
    await this.command(`\\set_mode ${mode.toUpperCase()} ${Math.round(passbandHz)}`);
  }

  /** Reads frequency, mode and passband — what a session records before it starts. */
  async getState(): Promise<RigState> {
    const frequencyHz = await this.getFrequency();
    const { mode, passbandHz } = await this.getMode();
    return { frequencyHz, mode, passbandHz };
  }

  /**
   * Keys or unkeys the transmitter, selecting the connector the audio comes from.
   * `pttInput: 'auto'` falls back to plain PTT when the rig cannot select its rear
   * input, so `pttFellBackToFront` is worth logging once per session rather than
   * once per over: it means the far end will hear the room, and the operator should
   * set the rig's own menu to rear/USB.
   */
  async setPtt(on: boolean): Promise<void> {
    if (!on) {
      await this.command(`\\set_ptt ${PTT_OFF}`);
      this.pttValue = PTT_OFF;
      return;
    }
    const preferred = this.options.pttInput === 'front' ? PTT_ON : PTT_ON_REAR;
    try {
      await this.command(`\\set_ptt ${preferred}`);
      this.pttValue = preferred;
      this.pttFellBack = false;
    } catch (error) {
      if (preferred === PTT_ON || this.options.pttInput !== 'auto') throw error;
      await this.command(`\\set_ptt ${PTT_ON}`);
      this.pttValue = PTT_ON;
      this.pttFellBack = true;
    }
  }

  /** The last `\set_ptt` value used: 0 unkeyed, 1 front, 3 rear. */
  get pttValueInUse(): number {
    return this.pttValue;
  }

  /** True when `auto` had to fall back to the front microphone connector. */
  get pttFellBackToFront(): boolean {
    return this.pttFellBack;
  }

  async getPtt(): Promise<boolean> {
    const { values } = await this.extended('\\get_ptt');
    const answer = (values.get('ptt') ?? values.get('') ?? [])[0] ?? '0';
    return Number(answer.trim()) === 1;
  }

  /** Split state and the TX VFO — the two lines that shifted every later answer. */
  async getSplit(): Promise<{ split: boolean; txVfo: string }> {
    const { values } = await this.extended('\\get_split_vfo');
    const split = (values.get('split') ?? ['0'])[0] ?? '0';
    const txVfo = (values.get('tx vfo') ?? [''])[0] ?? '';
    return { split: split.trim() === '1', txVfo: txVfo.trim().toUpperCase() };
  }

  /** `CHKVFO 1` when the daemon supports per-VFO frequencies. */
  async supportsVfo(): Promise<boolean> {
    const answer = await this.command('\\chk_vfo');
    return /1/.test(answer);
  }

  async setVfo(vfo: 'VFOA' | 'VFOB' | 'currVFO'): Promise<void> {
    await this.command(`\\set_vfo ${vfo}`);
  }

  /** Tunes and keys the radio in one go: the two things a session does between turns. */
  async prepare(frequencyHz: number, mode: RigMode | string, passbandHz = 0): Promise<void> {
    await this.setFrequency(frequencyHz);
    await this.setMode(mode, passbandHz);
  }
}
