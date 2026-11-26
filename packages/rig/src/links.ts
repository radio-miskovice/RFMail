// Live links to the configured transceivers.
//
// Configuration lives in the database; whether a link is *up* lives here, in the
// running process, because a connection is not something to restore from disk —
// after a restart the station dials again by itself.
//
// The states are the ones the header LED shows:
//   disconnected — grey, never opened or closed on purpose
//   connecting   — amber, a dial is in flight
//   connected    — green, the last exchange with rigctld succeeded
//   error        — red, the last exchange failed; the message says why
//
// The radio interface is part of the station, not a button on a screen: `keepAlive`
// re-reads the links that are up and reopens the ones that are down, slowly enough
// that a rig which is switched off does not get hammered. `refresh` stays the plain
// "read what is up" call for the API.

import type { RadioRig } from '@rfmail/shared';
import { Rigctld, RigError, type RigInfoState } from './rigctld.ts';
import { rigFromConfig, type TransceiverConfig } from './transceiver.ts';

export type LinkState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface LinkStatus {
  transceiverId: number;
  state: LinkState;
  /** Why the last exchange failed, when `state` is `error`. */
  error: string | null;
  frequencyHz: number | null;
  mode: string | null;
  passbandHz: number | null;
  ptt: boolean | null;
  /** The `\set_ptt` value last used: 0, 1 (front) or 3 (rear). */
  pttValue: number | null;
  /** True when `auto` had to use the front connector. */
  fellBackToFront: boolean;
  /** What rigctld said about the radio itself — identity, interface, live readout. */
  rig: RadioRig | null;
  /** When the state last changed, epoch ms. */
  changedAt: number;
}

/** How long a failed link waits before it is dialled again. */
const RETRY_MS = 15_000;

function blankStatus(transceiverId: number, state: LinkState = 'disconnected'): LinkStatus {
  return {
    transceiverId,
    state,
    error: null,
    frequencyHz: null,
    mode: null,
    passbandHz: null,
    ptt: null,
    pttValue: null,
    fellBackToFront: false,
    rig: null,
    changedAt: Date.now(),
  };
}

interface Link {
  client: Rigctld;
  status: LinkStatus;
  config: TransceiverConfig;
  /** Do not dial again before this, epoch ms. */
  nextAttemptAt: number;
}

/**
 * The current VFO's readout, the rig's identity and how it is attached, as one value for
 * the screen. Hamlib reports several VFOs; the one that is receiving is the one an
 * operator means by "the frequency".
 */
function describeRig(
  info: RigInfoState,
  rfPower: number | null,
  ifShiftHz: number | null,
  dataFilterHz: number | null,
  active: boolean,
): RadioRig {
  const vfo =
    info.vfos.find((entry) => entry.rx && entry.frequencyHz > 0) ??
    info.vfos.find((entry) => entry.frequencyHz > 0) ??
    null;
  // Everything here comes from `\get_rig_info` and the two raw queries (decisions 46, 47). The
  // capability dump (`\dump_caps`) is never asked for: on this daemon it prints a full state
  // dump and, on a Kenwood, that path re-applies settings the operator owns.
  const hamlib = [info.app, info.version].filter(Boolean).join(' ') || null;
  // What is left of the filter once the shift has moved it off centre: a 2500 Hz filter with
  // the IF at 1100 Hz (400 Hz low) passes 2100 Hz, which is why a 2300 Hz mode stops decoding.
  const usableHz =
    dataFilterHz === null ? null : ifShiftHz === null ? dataFilterHz : Math.max(0, dataFilterHz - Math.abs(ifShiftHz - 1500));
  return {
    model: info.rig,
    hamlib,
    frequencyHz: vfo?.frequencyHz ?? null,
    mode: vfo?.mode ?? null,
    filterHz: dataFilterHz,
    shiftHz: ifShiftHz,
    usableHz,
    rfPower,
    active,
  };
}

export class TransceiverLinks {
  private readonly links = new Map<number, Link>();

  /** Opens a link, reads the radio's state and reports what happened. */
  async connect(config: TransceiverConfig): Promise<LinkStatus> {
    this.disconnect(config.id);

    const client = rigFromConfig(config);
    const link: Link = {
      client,
      config,
      status: blankStatus(config.id, 'connecting'),
      nextAttemptAt: 0,
    };
    this.links.set(config.id, link);

    try {
      await client.connect();
      // Five reads, no capability dump: `\dump_caps` is a state dump that, on this daemon,
      // makes Hamlib re-apply settings the operator owns (decision 46). The two raw queries are
      // the only ones: the IF shift and the filter the rig is really using (decision 47).
      const state = await client.getRigInfo();
      const ptt = await client.getPtt();
      const power = await client.getPower();
      const shiftHz = await client.getIfShiftHz();
      const filterHz = await client.getDataFilterHz();
      const rig = describeRig(state, power, shiftHz, filterHz, true);
      link.status = {
        ...link.status,
        state: 'connected',
        error: null,
        frequencyHz: rig.frequencyHz,
        mode: rig.mode,
        passbandHz: rig.filterHz,
        ptt,
        pttValue: client.pttValueInUse,
        fellBackToFront: client.pttFellBackToFront,
        rig,
        changedAt: Date.now(),
      };
    } catch (error) {
      client.close();
      link.status = {
        ...blankStatus(config.id, 'error'),
        error: error instanceof RigError ? error.message : error instanceof Error ? error.message : String(error),
      };
      link.nextAttemptAt = Date.now() + RETRY_MS;
    }
    return { ...link.status };
  }

  /** Closes the link; the LED goes grey and a red state is cleared with it. */
  disconnect(id: number): LinkStatus {
    const link = this.links.get(id);
    if (link) {
      link.client.close();
      this.links.delete(id);
    }
    return blankStatus(id, 'disconnected');
  }

  /** Forgets a transceiver that was deleted from the registry. */
  forget(id: number): void {
    this.disconnect(id);
  }

  /**
   * Sets a radio's frequency and mode for a session. Refuses when the link is not
   * up: tuning a radio we cannot talk to, and then transmitting, is not a risk worth
   * taking for a convenience.
   */
  async tune(
    id: number,
    frequencyHz: number,
    mode: string,
  ): Promise<{ frequencyHz: number; mode: string; passbandHz: number }> {
    const link = this.links.get(id);
    if (!link || link.status.state !== 'connected') {
      throw new RigError('the transceiver is not connected', -1, 'tune');
    }
    await link.client.setFrequency(frequencyHz);
    // A mode write makes Hamlib recompute the rig's filter and IF shift; the station only
    // writes the mode when the link's last read says the radio is in something else, and it
    // never names a passband at all (decision 45).
    if ((link.status.mode ?? '').toUpperCase() !== mode.toUpperCase()) {
      await link.client.setMode(mode);
    }
    const state = await link.client.getState();
    link.status = {
      ...link.status,
      frequencyHz: state.frequencyHz,
      mode: state.mode,
      passbandHz: state.passbandHz,
      changedAt: Date.now(),
    };
    return state;
  }

  status(id: number): LinkStatus {
    const link = this.links.get(id);
    return link ? { ...link.status } : blankStatus(id);
  }

  /**
   * The transmitter power, written to a radio that is listening and read straight back. A
   * link that is down refuses: a screen must not report a level the rig never heard.
   */
  async setPower(id: number, fraction: number): Promise<LinkStatus> {
    const link = this.links.get(id);
    if (!link || link.status.state !== 'connected') {
      throw new RigError('the radio is not connected', -1, 'set_level');
    }
    await link.client.setPower(fraction);
    await this.readInto(link);
    return { ...link.status };
  }

  /**
   * Which connector transmits — the rear input a modem feeds, or the front microphone. It is
   * a property of the link, so the next keying uses it without reopening the socket.
   */
  setPttInput(id: number, pttInput: TransceiverConfig['pttInput']): LinkStatus {
    const link = this.links.get(id);
    if (!link) return this.status(id);
    link.config = { ...link.config, pttInput };
    link.client.setPttInput(pttInput);
    return { ...link.status };
  }

  /** The registry with its live state, for the header and the overview. */
  list(configs: readonly TransceiverConfig[]): Array<TransceiverConfig & { link: LinkStatus }> {
    return configs.map((config) => ({ ...config, link: this.status(config.id) }));
  }

  /**
   * Keeps the station talking to rigctld. A link that is up is re-read; one that is down
   * is dialled again once the retry window has passed, so a rig that is switched off
   * costs one attempt every fifteen seconds rather than a stream of them. Transceivers
   * no longer in the registry are dropped.
   */
  async keepAlive(configs: readonly TransceiverConfig[]): Promise<void> {
    const known = new Set(configs.map((config) => config.id));
    for (const id of [...this.links.keys()]) {
      if (!known.has(id)) this.disconnect(id);
    }

    for (const config of configs) {
      const link = this.links.get(config.id);
      if (link && link.status.state === 'connected') {
        await this.readInto(link);
        continue;
      }
      if (Date.now() < (link?.nextAttemptAt ?? 0)) continue;
      await this.connect(config);
    }
  }

  /** Re-reads the links that are up. Used by the API when a screen asks for a fresh view. */
  async refresh(): Promise<void> {
    for (const link of this.links.values()) {
      if (link.status.state !== 'connected') continue;
      await this.readInto(link);
    }
  }

  /**
   * One poll of one live link. A failure turns the link red and leaves it in the map, so
   * the LED has somewhere to live and `keepAlive` has a retry window to respect.
   */
  private async readInto(link: Link): Promise<void> {
    try {
      const info = await link.client.getRigInfo();
      const ptt = await link.client.getPtt();
      const power = await link.client.getPower();
      const shiftHz = await link.client.getIfShiftHz();
      const filterHz = await link.client.getDataFilterHz();
      const rig = describeRig(info, power, shiftHz, filterHz, true);
      link.status = {
        ...link.status,
        frequencyHz: rig.frequencyHz,
        mode: rig.mode,
        passbandHz: rig.filterHz,
        ptt,
        pttValue: link.client.pttValueInUse,
        fellBackToFront: link.client.pttFellBackToFront,
        rig,
      };
    } catch (error) {
      link.client.close();
      link.status = {
        ...link.status,
        state: 'error',
        error: error instanceof RigError ? error.message : error instanceof Error ? error.message : String(error),
        ptt: null,
        changedAt: Date.now(),
      };
      link.nextAttemptAt = Date.now() + RETRY_MS;
    }
  }

  closeAll(): void {
    for (const link of this.links.values()) link.client.close();
    this.links.clear();
  }
}
