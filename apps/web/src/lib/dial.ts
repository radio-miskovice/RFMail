// How a dial frequency is written.
//
import { BAND_RANGES } from '@rfmail/shared';

// HF below 10 MHz is read in kilohertz — hams say "7053.5" on 40 m and "3.597"
// on 80 m — while from 10 MHz upwards the same number is natural in megahertz,
// and everything above 30 MHz is always megahertz. The backend and rigctld speak
// hertz; only the screen converts, and it always says which unit it is showing.

export type DialUnit = 'kHz' | 'MHz';

/** The legal span of a dial: the 160 m band to the top of 70 cm. */
export const DIAL_MIN_HZ = 1_800_000;
export const DIAL_MAX_HZ = 450_000_000;

const TEN_MHZ = 10_000_000;

export function isDial(hz: number | null): boolean {
  return hz !== null && Number.isFinite(hz) && hz >= DIAL_MIN_HZ && hz <= DIAL_MAX_HZ;
}

/** Below 10 MHz kilohertz, at 10 MHz and above megahertz. */
export function dialUnitFor(hz: number): DialUnit {
  return hz < TEN_MHZ ? 'kHz' : 'MHz';
}

/** The band chosen decides the unit while no frequency has been entered yet. */
export function dialUnitForBand(band: string): DialUnit {
  const range = BAND_RANGES.find((entry) => entry.name === band);
  return range ? dialUnitFor(range.lowHz) : 'MHz';
}

function decimals(unit: DialUnit): number {
  // A kilohertz value needs one decimal for the 500 Hz channel grid; megahertz
  // needs four, because HF channels are 100 Hz apart at worst.
  return unit === 'kHz' ? 1 : 4;
}

/** The bare number an input shows, without the unit. */
export function dialNumber(hz: number, unit: DialUnit = dialUnitFor(hz)): string {
  return (hz / (unit === 'kHz' ? 1000 : 1_000_000)).toFixed(decimals(unit));
}

/** A dial with its unit, for a table cell or a readout. */
export function formatDial(hz: number): string {
  const unit = dialUnitFor(hz);
  return `${dialNumber(hz, unit)} ${unit}`;
}

/**
 * Reads what the operator typed. The unit he is typing in is the one shown, but a
 * number that only makes sense in the other unit is read that way instead of
 * being rejected — 14.1 on the kilohertz setting is 14.1 MHz, not 14 100 Hz.
 */
export function parseDial(text: string, unit: DialUnit): { hz: number; unit: DialUnit } | null {
  let cleaned = text.trim().replace(/[\s_']/g, '');
  // The last separator is the decimal point; anything before it groups thousands.
  // So both `7.053,5` (European) and `7,053.5` (English) read as 7053.5.
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const grouping = decimal === '.' ? /,/g : /\./g;
    cleaned = cleaned.replace(grouping, '');
    if (decimal === ',') cleaned = cleaned.replace(/,/g, '.');
  } else if (lastComma >= 0) {
    cleaned = cleaned.replace(',', '.');
  }
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;

  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;

  const asShown = Math.round(value * (unit === 'kHz' ? 1000 : 1_000_000));
  if (isDial(asShown)) return { hz: asShown, unit: dialUnitFor(asShown) };

  // A number that only makes sense in the other unit is read that way: 14.1 on the
  // kilohertz setting is 14.1 MHz, not 14 100 Hz.
  const other: DialUnit = unit === 'kHz' ? 'MHz' : 'kHz';
  const asOther = Math.round(value * (other === 'kHz' ? 1000 : 1_000_000));
  if (isDial(asOther)) return { hz: asOther, unit: dialUnitFor(asOther) };

  return null;
}

