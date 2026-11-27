// The two identifiers a Winlink station is allowed to type: a callsign and a grid
// square. Both are validated here and nowhere else, because the same value crosses a
// form, an API request, a database row and — for the callsign — the air. A form that
// checks differently from the server is two rules that disagree in the field.

import { HttpError } from './http.ts';

/** One callsign per account: an empty value clears it, anything else must look
 *  like a call sign (letters, digits, optionally one SSID). */
export function normaliseCallsign(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') {
    throw new HttpError(400, 'the callsign must be a string', { callsign: 'invalid' });
  }
  const value = input.trim().toUpperCase();
  if (!value) return null;
  if (!/^[A-Z0-9]{1,10}([-/][A-Z0-9]{1,3})?$/.test(value)) {
    throw new HttpError(400, `invalid callsign: ${input}`, { callsign: 'invalid' });
  }
  if (/^[0-9]+$/.test(value)) {
    throw new HttpError(400, `invalid callsign: ${input}`, { callsign: 'invalid' });
  }
  return value;
}

/** A grid square locator (`JO70AA` or the four-character `JO70`), or null. */
export function normaliseLocator(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') {
    throw new HttpError(400, 'the locator must be a string', { locator: 'invalid' });
  }
  const value = input.trim().toUpperCase();
  if (!value) return null;
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(value)) {
    throw new HttpError(400, `invalid locator: ${input} (expected a grid square like JO70AA)`, {
      locator: 'invalid',
    });
  }
  return value;
}
