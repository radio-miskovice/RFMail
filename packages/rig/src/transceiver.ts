// The transceiver as the station configures it.
//
// One row per radio, pointing at a rigctld the operator runs (or that the
// station launches itself). The fields are the ones a session actually needs:
// where the daemon listens, which transmit audio input to select, what to tune
// to, and the argv of the launcher — an argv array, never a shell string, so a
// path with a space or a stray quote cannot become a second command.
//
// This is the shape the database, the API and the configuration screen share;
// the session engine is handed a config and nothing else.

import { Rigctld, type PttInput, type RigMode } from './rigctld.ts';

export interface TransceiverConfig {
  id: number;
  /** Operator's name for the radio, unique in the station. */
  name: string;
  /** rigctld's TCP host; `127.0.0.1` when the station launches it itself. */
  host: string;
  port: number;
  /** Which connector transmits: the rear input a modem feeds, or the front mic. */
  pttInput: PttInput;
  /** Command that starts rigctld, or null when it runs separately. */
  launchCommand: string | null;
  /** Arguments as separate strings — never one shell string. */
  launchArgs: string[];
  /** Mode the radio is left in outside a session, e.g. `PKTUSB`. */
  idleMode: RigMode | string;
  idlePassbandHz: number;
  /** Milliseconds to wait for one rigctld answer. */
  timeoutMs: number;
}

export const PTT_INPUT_CHOICES: ReadonlyArray<{ value: PttInput; label: string }> = [
  { value: 'rear', label: 'Rear input — the connector a modem feeds (rig PTT 3)' },
  { value: 'front', label: 'Front microphone connector (rig PTT 1)' },
  { value: 'auto', label: 'Rear input, falling back to plain PTT if the rig cannot select it' },
];

export function defaultTransceiver(id: number, name: string): TransceiverConfig {
  return {
    id,
    name,
    host: '127.0.0.1',
    port: 4532,
    pttInput: 'rear',
    launchCommand: null,
    launchArgs: [],
    idleMode: 'PKTUSB',
    idlePassbandHz: 2000,
    timeoutMs: 5000,
  };
}

export interface ValidationResult {
  ok: boolean;
  fields: Record<string, string>;
}

export function validateTransceiver(config: TransceiverConfig): ValidationResult {
  const fields: Record<string, string> = {};
  const name = config.name.trim();
  if (!name) fields.name = 'a name is required';
  else if (name.length > 64) fields.name = 'the name is longer than 64 characters';
  if (!config.host.trim()) fields.host = 'a host is required';
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    fields.port = 'the port must be between 1 and 65535';
  }
  if (!['rear', 'front', 'auto'].includes(config.pttInput)) {
    fields.pttInput = 'choose the rear input, the front microphone, or automatic';
  }
  if (!config.idleMode.trim()) fields.idleMode = 'an idle mode is required';
  if (!Number.isInteger(config.idlePassbandHz) || config.idlePassbandHz < 0) {
    fields.idlePassbandHz = 'the passband must be zero or a positive number of Hz';
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 500 || config.timeoutMs > 60000) {
    fields.timeoutMs = 'the timeout must be between 500 and 60000 ms';
  }
  if (config.launchCommand !== null && !config.launchCommand.trim()) {
    fields.launchCommand = 'leave the launcher empty or name a command';
  }
  if (config.launchCommand !== null && config.launchArgs.some((argument) => /[\n\r]/.test(argument))) {
    fields.launchArgs = 'an argument contains a line break';
  }
  if (config.launchCommand === null && config.launchArgs.length > 0) {
    fields.launchArgs = 'arguments without a command have no effect';
  }
  return { ok: Object.keys(fields).length === 0, fields };
}

/** A client for this radio, with its PTT input and timeout applied. */
export function rigFromConfig(config: TransceiverConfig): Rigctld {
  return new Rigctld({
    host: config.host,
    port: config.port,
    pttInput: config.pttInput,
    timeoutMs: config.timeoutMs,
  });
}

/**
 * The launcher's argv, ready for `spawn(command, args, { shell: false })`. The
 * operator's arguments are appended verbatim: a station configured to reach
 * `192.168.133.222:4532` must be able to say so on the command line.
 */
export function launchArgv(config: TransceiverConfig): { command: string; args: string[] } | null {
  if (!config.launchCommand) return null;
  return { command: config.launchCommand, args: [...config.launchArgs] };
}
