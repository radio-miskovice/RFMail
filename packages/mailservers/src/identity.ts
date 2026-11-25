// Who is logging in?
//
// The account's identity is its callsign, and the callsign is also the login
// (decision 25): there is no separate account name to remember. A mail program
// that was set up from an address fills the username field with
// `ok4rm@winlink.org`, the sign-in form gets `ok4rm`, a client session carries
// `OK4RM` — all three are the same person, and all four doors (the web API, POP3,
// IMAP and SMTP) resolve them through this one function.
//
// Matching is case-insensitive and resolves to at most one account, because
// callsigns are unique (decision 13) and the callsign column is indexed without
// regard to case. Nothing is guessed across accounts.
//
// A row written before accounts were named by callsign may still carry a login of
// its own — no callsign exists there to copy — so the store's login lookup keeps
// answering for it until a callsign is set on the account.

import { toWinlinkAddress } from '@rfmail/core-b2f';
import type { Store, UserRecord } from '@rfmail/store';

export async function findUserByCredential(
  store: Store,
  input: string,
): Promise<UserRecord | null> {
  const name = input.trim();
  if (name === '') return null;

  // `OK4RM@winlink.org` and `OK4RM` name the same mailbox; the domain is how a
  // mail program spells it, not part of the account.
  const bare = toWinlinkAddress(name);
  if (bare === '') return null;

  return store.findUserByLogin(bare);
}
