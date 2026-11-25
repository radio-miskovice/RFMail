// Which digital mode the session screen opens on.
//
// Opening on a fixed mode is wrong for a station that runs one modem: the operator picked
// Data2G or VARA days ago and the screen still offers ARDOP, whose port is not even
// listening. So the default follows what the station is actually doing — a mode whose
// modem is configured *and* answering — and only falls back to the last choice remembered
// in the browser when nothing is running.

import { modemDrivesMode, type ModemKind } from '@rfmail/shared';

/** The little of a modem this decision needs. */
export interface ModemLike {
  id: number;
  kind: ModemKind;
  enabled: boolean;
}

export interface ModeChoiceInput {
  /** The modes the station offers, in the order the screen lists them. */
  kinds: readonly ModemKind[];
  modems: readonly ModemLike[];
  /** Per modem id: is its command port answering? Unknown ids are absent, not false. */
  running: Readonly<Record<number, boolean>>;
  /** The mode last chosen in this browser, if any. */
  saved: ModemKind | null;
  /** Used when the station offers no modes at all. */
  fallback?: ModemKind;
}

/**
 * In order:
 *   1. the remembered mode, when a modem for it is listening;
 *   2. any mode that has a listening modem, in the order the screen lists them;
 *   3. the remembered mode, when the station still offers it but nothing is listening;
 *   4. the first mode offered.
 * The remembered mode leads (1) because it is the station's habit, and habit plus a live
 * modem is the best guess; (2) covers a station that has just started a different modem.
 */
export function chooseSessionMode(input: ModeChoiceInput): ModemKind {
  const { kinds, modems, running, saved, fallback = 'ardop' } = input;
  const offered = (kind: ModemKind): boolean => kinds.includes(kind);
  const listening = (kind: ModemKind): boolean =>
    modems.some(
      (modem) => modem.enabled && modemDrivesMode(modem.kind, kind) && running[modem.id] === true,
    );

  if (saved && offered(saved) && listening(saved)) return saved;

  const anyListening = kinds.find((kind) => listening(kind));
  if (anyListening) return anyListening;

  if (saved && offered(saved)) return saved;

  return kinds[0] ?? fallback;
}
