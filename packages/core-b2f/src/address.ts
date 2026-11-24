// Winlink addressing.
//
// The radio side writes a Winlink address as a bare callsign (`OK1ABC`), and so
// does the message store: that is the form the B2F session has to put in its
// proposals and the form a gateway matches against its mailboxes. An ordinary
// mail program, however, only understands an addr-spec with a domain, so the
// user of a POP3/IMAP/SMTP client sees and types `OK1ABC@winlink.org`.
//
// Two directions, two functions each:
//   stored form   toWinlinkAddress() — `OK1ABC@winlink.org`, `ok1abc` -> `OK1ABC`
//                 toWinlinkHeader()  — the same, on a whole `From:`/`To:` value
//   client form   toFullAddress()    — `OK1ABC` -> `OK1ABC@winlink.org`
//                 toFullHeader()     — the same, on a whole header value
//
// The header variants leave an ordinary internet address exactly as it arrived,
// display name included; only Winlink addresses are rewritten, because there the
// callsign *is* the identity.
//
// Anything that already carries another domain passes through untouched, since
// Winlink also carries ordinary internet mail (the `SMTP:` recipients of B2F).

import type { MailMessage } from './message.ts';
import { addressOnly } from './message.ts';

export const WINLINK_DOMAIN = 'winlink.org';

/** Letters, digits and at most one SSID: `OK1ABC`, `OK1ABC-10`, `OK1ABC/7`. */
const CALLSIGN = /^[A-Z0-9]{1,10}(?:[-/][A-Z0-9]{1,3})?$/;

export function looksLikeCallsign(value: string): boolean {
  return CALLSIGN.test(value.trim().toUpperCase());
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at === -1 ? null : address.slice(at + 1).trim().toLowerCase();
}

/** True when the address is a Winlink one: a bare callsign or `@winlink.org`. */
export function isWinlinkAddress(input: string): boolean {
  const address = addressOnly(input).trim();
  if (address === '') return false;
  return domainOf(address) === WINLINK_DOMAIN || looksLikeCallsign(address);
}

/**
 * The addr-spec the store and the radio side keep: a Winlink address loses its
 * domain and its callsign is upper-cased; any other address is returned as its
 * addr-spec, trimmed.
 */
export function toWinlinkAddress(input: string): string {
  const address = addressOnly(input).trim();
  if (address === '') return '';
  const domain = domainOf(address);
  if (domain === null) {
    return looksLikeCallsign(address) ? address.toUpperCase() : address;
  }
  if (domain === WINLINK_DOMAIN) {
    const local = address.slice(0, address.lastIndexOf('@')).trim();
    return looksLikeCallsign(local) ? local.toUpperCase() : address;
  }
  return address;
}

/**
 * The addr-spec a mail client sees: a bare callsign gains `@winlink.org`; any
 * address that already has a domain is returned untouched.
 */
export function toFullAddress(input: string): string {
  const address = addressOnly(input).trim();
  if (address === '') return '';
  const domain = domainOf(address);
  if (domain === null) {
    return looksLikeCallsign(address) ? `${address.toUpperCase()}@${WINLINK_DOMAIN}` : address;
  }
  // A callsign is upper case, including one already carrying the domain.
  if (domain === WINLINK_DOMAIN) {
    const local = address.slice(0, address.lastIndexOf('@')).trim();
    return looksLikeCallsign(local) ? `${local.toUpperCase()}@${WINLINK_DOMAIN}` : address;
  }
  return address;
}

/** Stored form of a whole header value (`"Jana" <jana@example.cz>` survives). */
export function toWinlinkHeader(input: string): string {
  const value = input.trim();
  if (value === '') return '';
  return isWinlinkAddress(value) ? toWinlinkAddress(value) : value;
}

/** Client form of a whole header value; internet addresses keep their names. */
export function toFullHeader(input: string): string {
  const value = input.trim();
  if (value === '') return '';
  if (!isWinlinkAddress(value)) return value;
  if (domainOf(addressOnly(value).trim()) !== null) return value;
  return `${looksLikeCallsign(value) ? value.toUpperCase() : value}@${WINLINK_DOMAIN}`;
}

export function canonicaliseAddressList(list: readonly string[]): string[] {
  return list.map(toWinlinkHeader).filter((address) => address !== '');
}

export function expandAddressList(list: readonly string[]): string[] {
  return list.map(toFullAddress).filter((address) => address !== '');
}

/**
 * A copy of the message in its stored form. Applied at every ingress (SMTP
 * submission, IMAP APPEND, the API, the importer) so that nothing downstream has
 * to remember which form it is holding.
 */
export function canonicaliseMessageAddresses(msg: MailMessage): MailMessage {
  return {
    ...msg,
    from: toWinlinkHeader(msg.from),
    to: canonicaliseAddressList(msg.to),
    cc: canonicaliseAddressList(msg.cc),
  };
}

/** A copy of the message as a mail client should see it. */
export function expandMessageAddresses(msg: MailMessage): MailMessage {
  return {
    ...msg,
    from: toFullHeader(msg.from),
    to: canonicaliseAddressList(msg.to).map(toFullHeader),
    cc: canonicaliseAddressList(msg.cc).map(toFullHeader),
  };
}
