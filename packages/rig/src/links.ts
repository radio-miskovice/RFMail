// Live links to the configured transceivers.
//
// Configuration lives in the database; whether a link is *up* lives here, in the
// running process, because a connection is not something to restore from disk —
// after a restart the station is simply not connected to anything.
//
// The states are the ones the header LED shows:
//   disconnected — grey, never opened or closed on purpose
//   connecting   — amber, a dial is in flight
//   connected    — green, the last exchange with rigctld succeeded
//   error        — red, the last exchange failed; the message says why
//
// `error` clears in exactly two ways, and the screen offers both: connect again
// (the same button, "Reconnect"), or disconnect, which returns the link to
// `disconnected`. Nothing retries in the background — an unplugged radio must not
// keep hammering a daemon, and a red LED that goes away by itself tells the
// operator nothing.

import { Rigctld, RigError } from './rigctld.ts';
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
  /** When the state last changed, epoch ms. */
  changedAt: number;
}

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
    changedAt: Date.now(),
  };
}

interface Link {
  client: Rigctld;
  status: LinkStatus;
  config: TransceiverConfig;
}

export class TransceiverLinks {
  private readonly links = new Map<number, Link>();

  /** Opens a link, reads the radio's state and reports what happened. */
  async connect(config: TransceiverConfig): Promise<LinkStatus> {
    this.disconnect(config.id);

    const client = rigFromConfig(config);
    const link: Link = { client, config, status: blankStatus(config.id, 'connecting') };
    this.links.set(config.id, link);

    try {
      await client.connect();
      const state = await client.getState();
      const ptt = await client.getPtt();
      link.status = {
        ...link.status,
        state: 'connected',
        error: null,
        frequencyHz: state.frequencyHz,
        mode: state.mode,
        passbandHz: state.passbandHz,
        ptt,
        pttValue: client.pttValueInUse,
        fellBackToFront: client.pttFellBackToFront,
        changedAt: Date.now(),
      };
    } catch (error) {
      client.close();
      link.status = {
        ...blankStatus(config.id, 'error'),
        error: error instanceof RigError ? error.message : error instanceof Error ? error.message : String(error),
      };
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
    passbandHz = 0,
  ): Promise<{ frequencyHz: number; mode: string; passbandHz: number }> {
    const link = this.links.get(id);
    if (!link || link.status.state !== 'connected') {
      throw new RigError('the transceiver is not connected', -1, 'tune');
    }
    await link.client.setFrequency(frequencyHz);
    await link.client.setMode(mode, passbandHz);
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

  /** The registry with its live state, for the header and the overview. */
  list(configs: readonly TransceiverConfig[]): Array<TransceiverConfig & { link: LinkStatus }> {
    return configs.map((config) => ({ ...config, link: this.status(config.id) }));
  }

  /**
   * Re-reads frequency, mode and PTT for the links that are up. A link that has
   * failed since the last poll turns red; `error` is never written by a poll of a
   * link that is already disconnected.
   */
  async refresh(): Promise<void> {
    for (const link of this.links.values()) {
      if (link.status.state !== 'connected') continue;
      try {
        const state = await link.client.getState();
        const ptt = await link.client.getPtt();
        link.status = {
          ...link.status,
          frequencyHz: state.frequencyHz,
          mode: state.mode,
          passbandHz: state.passbandHz,
          ptt,
          pttValue: link.client.pttValueInUse,
          fellBackToFront: link.client.pttFellBackToFront,
        };
      } catch (error) {
        link.client.close();
        // The link stays in the map, closed, so the red LED has somewhere to
        // live until the operator reconnects or disconnects.
        link.status = {
          ...link.status,
          state: 'error',
          error: error instanceof RigError ? error.message : error instanceof Error ? error.message : String(error),
          ptt: null,
          changedAt: Date.now(),
        };
      }
    }
  }

  closeAll(): void {
    for (const link of this.links.values()) link.client.close();
    this.links.clear();
  }
}
