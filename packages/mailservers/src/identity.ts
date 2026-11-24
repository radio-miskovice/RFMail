// Who is logging in?
//
// A mail program knows the user by their address, so Thunderbird fills the
// username field with `ok4rm@winlink.org` when the account is set up from an
// address; the station knows the same person by their account name or by their
// callsign. All four doors — the web API, POP3, IMAP and SMTP — resolve a
// credential the same way, so nobody has to remember which of the three forms
// the server wants.
//
// The order is deliberate: an exact account name wins, then the bare callsign of
// a Winlink address, then a login that happens to equal the callsign. Nothing is
// guessed across accounts: an address resolves to at most one user, because
// callsigns are unique (decision 13).

import { toWinlinkAddress } from '@rfmail/core-b2f';
import type { Store, UserRecord } from '@rfmail/store';

export async function findUserByCredential(
  store: Store,
  input: string,
): Promise<UserRecord | null> {
  const name = input.trim();
  if (name === '') return null;

  const direct = await store.findUserByLogin(name);
  if (direct) return direct;

  // `OK4RM@winlink.org` and `OK4RM` are the same mailbox as the callsign owner.
  // The login lookup above already covered a bare callsign that is also an
  // account name; here the callsign itself decides.
  const bare = toWinlinkAddress(name);
  if (bare === '') return null;

  if (bare !== name) {
    const byLogin = await store.findUserByLogin(bare);
    if (byLogin) return byLogin;
  }
  return store.findUserByCallsign(bare);
}
