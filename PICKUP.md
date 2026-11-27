# Picking this up

Written the evening of 26 November 2026, for the morning after. Everything below was
run, measured or read from the real thing — where it was not, it says so.

Repository `/home/jvavruska/dev/rfmail`, branch `master` (tracking `dev/master`),
working tree dirty with **21 paths and nothing committed**: the session window and its
live view (decisions 51–54), the corrections to *Called before* and to what the sheet
says (55), the band that follows the typed dial (56), plus migrations 011–013 on
`session_targets`. `npm test` 203/203, `tsc` and `svelte-check` clean, the web build
written. Schema v13.

---

## Where it stands

**Mail.** Its own store (SQLite via `node:sqlite`), SMTP submission, POP3 and
IMAP4rev1 (IDLE, APPEND, EXPUNGE, ENVELOPE, BODYSTRUCTURE), a browser GUI with
folders, reader, composer, search, `.eml` export. A mail program signs in with the
callsign in any case, or with `CALLSIGN@winlink.org`; inside the station addresses
are bare callsigns, and `@winlink.org` is added only when serving a mail program and
stripped on receipt, `winlink.org` only. The callsign *is* the account and the login
(decision 25) — there is no separate account name.

**Accounts.** scrypt passwords; one callsign per account, which is also the login
(a club or expedition callsign is its own account); a WW-Locator per station; the Winlink password sealed
with AES-256-GCM under a `store_key` separate from the session secret. Any account
may configure the station's radios, modems and sessions (decision 14).

**Radio.** Interfaces, one per rigctld: each is a small tile with `host:port` and its LED on
the first line and the transceiver it serves on the second, and everything else — the
serial line, the dial, the filter, the transmit connector, the power, and the switch that
turns the interface off — opens under the click. The station dials every enabled interface
and keeps it dialled; the one used last is remembered in the database (`last_used_at`) and is
the one the header follows. The serial device and speed are noted by the operator, because
the daemon cannot be asked for them.

**Sessions.** The Winlink catalogue (`api.winlink.org/gateway/status.json`) is
fetched with the public client key, cached beside the database with the set of
service classes it was fetched for, and flattened to channels carrying band,
distance and bearing from the locator, plus two estimates. Ordering by distance or
by the estimate; VHF and up carry no estimate at all.

**Modems.** A registry (type, host, command/data/KISS ports, transceiver, rig mode)
and a live check that shows whether each one is actually there: one small tile per modem —
protocol and LED, the address, then command, data and KISS port in three columns — with
the labelled ports, the radio, the mode and the reason it is unavailable under the click.

**Post office.** A station can answer calls instead of only making them:
`packages/server/src/postoffice.ts` arms one modem (`MYCALL`, `LISTEN ON`, the command
socket stays open because `CONNECTED` is the only notice of a call), challenges the
caller with a fresh `;PQ:` nonce, files inbound mail in the INBOX of every local
callsign it names, offers what the caller's own mailbox has not collected yet, hangs
the call up properly (`DISCONNECT`, `DISCONNECTED`, a quiet channel — keeping its own
command socket, which a dial would destroy), and re-arms after every call. The owner account (`users.is_post_office`, at most one via
a partial unique index) is the callsign the station answers as; its password may be
the Winlink one or the account's new *post-office password* (sealed, per account), and
either authenticates. A message for an address nobody holds is deferred when the peer
names it in `;PM:`, and otherwise held in the owner's mailbox and logged — never
dropped, never answered `-`. Screen: **Post office** in the top bar; API:
`GET /api/postoffice/status`, `POST /api/postoffice/arm` (`modemId`, `frequencyHz`),
`POST /api/postoffice/disarm`. No gateway registration is involved.

**The B2F exchange.** A session dials, runs the FBB B2 protocol over the modem's data
port, and files the mail away:

- `packages/core-b2f/src/session.ts` is the exchange: handshake (`;FW:`, SID,
  `;PQ`→`;PR`, greeting), turns, proposal blocks with their `F>` checksum, the
  `FS` answers, SOH/STX/EOT transfers in both directions, offsets, deferrals,
  duplicate proposals, `;PM:` display lines, `FF`/`FQ`. It knows nothing about
  modems or the store: it takes a duplex byte stream and a handler.
- The answering half (master mode) is written too — the post office and the
  gateway relay both need it later — and is covered by a test.
- `packages/server/src/session-run.ts` joins it to the station: dial through
  `dialModem`, open the modem's data port, offer the account's OUTBOX, insert what
  arrives into INBOX, move what the peer accepted into SENT, hang up on every path.
- `POST /api/session/run` exposes it, and the session screen's primary button is
  now **Start session**; **Test the link** keeps the old dial-and-hang-up connect
  test for when the question is only whether the gateway answers.
- `Store.findMessageByMid` answers "do I already have this MID", which is what makes
  a re-proposal after a dropped link harmless.

**The session window — new.** A session now runs in a modal of its own and can be watched
while it runs, instead of a button that says "In session…" for three minutes. The modem's
command channel and the exchange's data channel are carried over a WebSocket
(`/api/session/ws?id=…`, the page's own session cookie, a channel the screen names before it
starts the run) and drawn as what they are: `MODEM` for the command channel — replies plain,
commands in italic — and the callsign being called for the data channel, bold, dark blue when
received and green when sent. `PTT ON`/`PTT OFF` are not logged; they drive an **ON AIR** lamp in
the header (bright red), and each transmission leaves one line with the moment it began and how
long it held the channel (`1.0 MODEM > TRANSMIT 3.0 s`); a gap with no traffic in it becomes
`4.0 MODEM · waiting 5.0 s`. A binary block — a compressed message — is reported as its first
twelve bytes in hex and a length, because the exchange carries messages as bytes and would
otherwise look silent. The sheet carries one control: **Disconnect** asks the modem to bring the
link down, and a second press while that is happening — the button now reads **Abort** — cuts
both sockets. The server decides which step it is, and the control exists from the moment the
dial starts, because the dial is often the long part. The sheet is a fixed frame between the app
header and the bottom of the window; the feed scrolls, and the sheet stays until it is closed.

**Called before, and the form.** The chips list what the station has actually called — callsign,
dial, digital mode and the kind of session (GW/P2P/PO) — ranked by uses and then recency, read
from the store again after every session, and a call that never got an answer says in its report
that it was not counted. Typing a dial moves the band to the one that dial belongs to. The target
field starts empty and carries nothing invented; the identity line is one line, `SID: [ … ]`.

---

## Running it

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"   # the system npm is broken

cd /home/jvavruska/dev/rfmail
npm test                                    # 203 pass
npm run check                               # tsc + svelte-check, 0 errors 0 warnings
npm --workspace apps/web run build          # static site the backend serves
```

The test instance, which is running now (restarted tonight from this tree, port 8082):

```bash
T=$HOME/.hermes/cache/scratch/rfmail-phase2
HOME="$T/home" node apps/backend/src/main.ts --config "$T/rfmail.toml" --log info
```

* UI <http://192.168.133.207:8082>
* POP3 1110, SMTP 1025, IMAP 1143 are configured on `0.0.0.0` but **not listening**:
  the station is a Winlink client and has no post office owner, so the mail interfaces
  stay down (decision 31). Access is `strict` with `192.168.132.0/23`.
* config `$T/rfmail.toml`; database `$T/home/.local/share/rfmail/rfmail.db`, schema
  v13 (`session_targets` gained the digital mode in 012 and the kind of session in 013)
* accounts OK1ABC (admin, **no mail password**), OK4RM, OK2XYZ (has a password set
  while testing) — the callsigns are the logins now, so the old names `jvavruska`,
  `ok4rm` and `operator` no longer sign in. The running instance still has the code
  from before migration 007; restart it and the database migrates itself.
* modems: ARDOP `192.168.133.222:8515`+8516, Data2G `.222:8300`+8301+KISS 8100,
  VARA FM `192.168.132.6:8300`, VARA HF `.222:8300`, XARA `192.168.133.50:8300`

---

## Where the air time stands

**The modem answers again.** The Data2G instance on `192.168.133.222` was unreachable when this
file was first written; it is reachable now, and every session started today went out through
it — the station keyed the transmitter, the modem reported its bandwidth, and the call either
completed or timed out on the *far end*. The same host runs the other modems too: ARDOP on
8515/8516 still refuses, and a Data2G restart can take the command port away again, so a modem
that stops answering is still the first thing to check.

**Three sessions have completed on the air, not just on sockets:**

```
2026-11-25 22:41  HB9AK   cms  3591.5 kHz  Data2G  complete
2026-11-26 10:09  OK1RAA  p2p  3597.0 kHz  Data2G  complete
2026-11-26 18:38  OK1RAA  p2p  3597.0 kHz  Data2G  complete
```

Those are what *Called before* lists, twice each, and they are the only entries the store has.

**Tonight's calls got no answer.** Two peer calls at 22:22 and 22:28 to `OK1RAA` and one gateway
call at 22:29 to `HB9AK` all ended `dial=failed`, `no answer from … within 45 seconds` — the
modem was there, the station transmitted, the gateway did not come back. Nothing was recorded,
which is why the counts did not move; the sheet now says so in as many words.

Before the next call, check:

1. Put the rig back where a session expects it — it is sitting on **7041.0 kHz** now; an 80 m
   peer call wants **3597.0 kHz PKTUSB**.
2. Check the station being called is actually on: the catalogue (`GET /api/session/gateways`)
   carries each channel's `openNow` from `api.winlink.org`, and a peer has to be listening by
   arrangement.
3. Then a peer call to `OK1RAA` on `3597.0` (kHz), or a gateway call through the catalogue, and
   watch the new sheet: `MODEM` lines while dialling, `ON AIR` when the key goes down, `PEER`
   lines when the far end answers.

---

## What is proven, and what is not

Proven by tests (over real sockets, not stubs of the engine):

* `test/session.test.ts` — the exchange against a hand-written gateway: outbound
  accepted/rejected/deferred, inbound LZHUF and gzip, a duplicated proposal, an
  offset resume, a secure-login challenge answered with the response in the log,
  a peer without B2, a wrong proposal checksum, one damaged message inside an
  otherwise good block, a silent peer, an aborted session, and the master half.
* `test/session-run.test.ts` — a scripted VARA-family modem (command port plus data
  port) with the real store: dial, exchange both ways, messages moving OUTBOX→SENT,
  inbound unread in INBOX, a MID the store already holds answered `-` and not
  transmitted, ARDOP refused with a reason.
* `test/session-stream.test.ts` — the live view's own protocol: the single control
  escalates once (disconnect, then abort, and a third press does nothing), the channel is
  found by the id and forgotten when the run ends, `Sec-WebSocket-Accept` is the token the
  RFC computes, and an event reaches a screen as one unmasked text frame with the backlog
  ahead of it.
* `test/session-bytes.test.ts` — `watchBytes()`: a binary block is reported once with its
  head in hex and its length, a protocol line is not reported at all, and what is sent is
  reported as sent.
* `test/postoffice.test.ts` — a calling station dials a scripted modem, authenticates with
  its post-office password, leaves a message for the owner and collects what was waiting;
  a wrong password is refused before anything is offered; an account with no credential
  gets nothing.
* `test/api.test.ts` — the same session through `POST /api/session/run` over HTTP, against
  rigctld and a scripted modem, including CSRF.
* `test/store.test.ts` — what *Called before* keeps and what it refuses to invent: one row
  per callsign/dial/mode/kind, ranked by uses then recency, a known call never rewriting a
  half-known row.

Proven on the air (the three sessions above): the modem's command and data ports, the dial,
the B2F exchange against a real peer, and filing what arrived. The live view and the stop
control were exercised against a stand-in modem only; what has *not* been seen on a real link:

1. **The hex line and the exchange's own traffic.** No message has crossed the new feed yet —
   the three completed sessions ran before it existed. The first session that carries a
   message should show `PEER <`/`PEER >` lines in bold and one `… N bytes` line per binary
   block. If it does not, `watchBytes()` is measuring chunks the engine never reads.
2. **Aborting mid-exchange.** The data socket is destroyed on abort, which ends the exchange at
   its next read; only the dialling half has been watched live.
3. **The post office has never been armed on the air.** Everything is a scripted modem and two
   in-memory stores. The accept path assumes the VARA-family data port can be opened after
   `CONNECTED` and that `LISTEN ON` survives while the post office holds its own command
   socket; both need one real call.
4. **ARDOP sessions do not exist.** ARDOP carries session bytes on its command socket, which
   needs its binary framing; `runSession` refuses an ARDOP modem with that sentence rather
   than half-running one.
5. **The secure-login answer has never been accepted by a CMS.** The construction is copied
   from the reference and unit-tested; the completed `HB9AK` gateway session of 25 Nov did not
   report a refusal, but the exchange may have ended before the challenge.
6. **No queue and no retries.** `POST /api/session/run` still holds the HTTP request open for
   the whole session; there is no priority queue, no attempt counter and no next-attempt time.
   A deferred message stays in OUTBOX for the operator to try again.

## Decisions taken (REQUIREMENTS.md §12, R3.0 / R4.4 / R4.4.0 / R4.4.05)

* **14** No operator class: any account configures the station's radios and modems;
  the `admin` role only administers other accounts.
* **15** Facts and estimates are labelled apart — distance and bearing are computed,
  "estimated quality" is a heuristic and says so until VOACAP replaces it.
* **16** Service codes are access classes: `PUBLIC` open to all, `EMCOMM`
  emergency-only (listed only when the emergency box is ticked), and `XARA`,
  `MERCURY`, `DATA2G` are classes that belong to one modem each.
* One callsign per account; VARA and XARA speak the same interface, so either can run
  a VARA session and either can work a VARA or XARA channel.
* **17** The exchange lives in `core-b2f` over a `Duplex` byte stream, with no modem
  and no store knowledge. A transport is a stream (data port, telnet, a test pair);
  the store is a handler. This is what let the engine be proven over sockets before
  any radio was reachable.
* **18** A session sends LZHUF (`FC`) proposals and accepts gzip (`FD`) inbound. The
  gzip offer is switchable but off by default: every peer reads LZHUF, and the CMS's
  gzip support is an experiment in the reference client, not a certainty here.
* **19** An accepted message, and one the peer already holds, both move OUTBOX →
  SENT: from the station's point of view both are delivered. A deferred one stays in
  OUTBOX — "ask me again" is not "sent".
* **20** The SID this station sends is `[RF Mail-0.1-B2FHM$]`, with `G` before the `$`
  when gzip is offered (`B2FHMG$`). `$` is last by the protocol; the earlier helper
  had it wrong.
* **21** A secure-login challenge with no Winlink password set fails the session
  *before* the greeting goes out, rather than answering with a wrong response and
  letting the CMS spend the airtime rejecting it.
* **22** ARDOP is refused, not approximated. Its data shares the command socket, so
  carrying it means ARDOP's framed protocol — a separate driver, not a flag.
* **23** One exchange, one parameter: the peer's kind. `cms` asks for this callsign and
  every auxiliary address, may offer the whole outbox, and treats an unanswered
  `;PQ` challenge as fatal; `p2p` asks for its own callsign alone, offers only what is
  addressed to that station, notes a challenge it cannot answer and goes on
  unauthenticated, and dials VARA HF with `P2P SESSION`; `postoffice` asks for every
  address, offers what the far end's `;FW:` list accepts, and refuses an unanswered
  challenge like a CMS, because it holds accounts and can check one. Everything else —
  SID, turns, compression, offsets — is the same code. (R4.4.1.1)
* **24** The channel is listened to, not fought over. `BUSY ON` blocks the *rest* of a
  call when it is one unbroken stretch of about four seconds (a data station); short
  irregular stretches are voice and are dialled through. The first connect frame
  cannot be prevented — Data2G 0.5.3 reports no busy state while listening. And a
  hang-up waits for `DISCONNECTED` plus a few seconds of silence, because the ID frame
  is still on the air after `DISCONNECT`. (R4.4.1.2, R4.4.1.3)
* **25** The callsign is the account: one name at the sign-in form, POP3, IMAP and
  SMTP, matched without regard to case, and `CALLSIGN@winlink.org` is the same name.
  The store keeps `login` as the callsign so the unique index is the sign-in key;
  renaming the station renames the login. An account is created with a callsign;
  migration 007 copied existing callsigns into their logins, and an account without
  one keeps its old login until it gets a callsign (never invented). (R7.2, R7.3)

---

## Measured on the air, Data2G 0.5.3 (25 Nov 2026)

* It talks to rigctld on its own, whatever its "use rig control" checkbox says: a
  `\set_ptt 3` first (the rear input a modem feeds), then `\set_ptt 1` on the retries when
  3 is refused. With a daemon that reports no PTT type, all of it is accepted and none of
  it keys anything — which is why the radio stayed silent while the log filled with PTT
  lines.
* It also sets the receiver filter: after a session the rig read PKTUSB with a 1000 Hz
  passband where the station had 2000, so the app's own mode/passband set at the start of
  the session does not last. Nothing in rfmail did it; the modem did. *(Corrected on the
  evening of 26 Nov: the filter was ours after all — `\set_mode … 0` recomputes the passband
  and `\dump_caps` re-applies the rig's state. Decisions 45 and 46 removed both; the station
  now sends `-1` and never asks for capabilities.)*
* Its command port answers `VERSION Data2G 0.5.3` and reports `BUSY ON` about 300 ms
  before `CONNECTED` on a call that comes up, plus `PTT ON`/`PTT OFF`, `BUFFER <n>`,
  `MODE <name>`, `IAMALIVE` and `DISCONNECTED`. It says nothing while merely listening, so
  a channel cannot be checked before the first connect frame goes out.
* A completed session ran 53 s end to end for two messages of 266 and 200 bytes, and both
  were accepted by a pat station (`FS ++`).

---

## Tomorrow

1. **Commit.** 21 paths are dirty and nothing is in git yet; the work is one coherent step —
   the session window, its live view and its control, the corrections to *Called before*, the
   band that follows the dial. `git add` the 21 paths by name and commit with a message about
   the session window; the tree should be clean before anything else is touched.
2. **One real session, watched.** Rig back to `3597.0 kHz PKTUSB`, a peer call to `OK1RAA` or a
   gateway call from the catalogue, and the sheet open from the first second. The things to
   look for that have never been seen on the air: `PEER` lines in the feed, the `… N bytes`
   line when a message crosses, the `ON AIR` lamp during a transmission, and the count in
   *Called before* moving by one when the call completes.
3. **Then the stop control, on a real call.** Abort mid-exchange once, in a session that is
   repeating, and confirm the sheet ends as `Session cancelled` and the modem is not left
   keyed. That is the case the control exists for.
4. After that, the open items below: ARDOP's binary framing, the post office on the air, and
   the secure-login answer at a real CMS.

---

## Open questions

1. **Data2G bandwidths**: you said 200/500/2300; `data2g/host.py` upstream takes
   `BW500`, `BW1200`, `BW2300`, `BW2750`. I left the modem with the four the source
   accepts, and `runSession` requests no bandwidth at all when the set is not
   recorded. Tell me which your build answers.
2. **VARA HF and XARA-tagged channels**: today a VARA HF modem also sees the one
   channel a gateway listed under `XARA`, since the two speak the same interface. Say
   if that should be strict instead.
3. **EMCOMM**: fetchable and listed only behind the tick-box. Should the emergency
   list ever be the default when the station is in an emergency? Not now, by design.
4. **Thunderbird** was never explained: mail was visible in the web client but not in
   the program. The IMAP replay answered every command correctly, so the suspicion
   fell on the client's "IMAP server directory" or the folder subscription. Worth one
   more look now that the addresses are presented as `CALLSIGN@winlink.org`.
5. **Where does a client session's mail go when a message names several recipients?**
   The engine files everything into the account's INBOX because a CMS only sends what
   `;FW:` asked for. If a P2P peer ever sends for a third callsign, the address on the
   message is the truth and the store should route by it (M12).

---

## Deliberately not done

* MariaDB and PostgreSQL adapters behind the store contract (SQLite only, by design
  for now).
* Modem parameter screens beyond type/host/ports/rig mode — bandwidth, ARQ retries,
  launch commands, autostart, readiness probes (R3.1 lists them).
* Gateway relay (M12c) and forwarding/store-and-forward (M12b): the post office answers
  calls, but nothing relays to a CMS yet and nothing retries a deferred message.
* Nothing is transmitted unless a session is started, and nothing is left connected:
  every path (connected, failed, error, aborted) hangs up.
* **26** The post office is the station answering calls: sessions terminate locally, the
  mailboxes are the store (an inbound message is filed for every local callsign it
  names; what the caller's mailbox holds and has not collected is what it is offered),
  collection is a flag so nothing is deleted by being collected, an address nobody holds
  is deferred when `;PM:` names it and otherwise held for the postmaster, one modem
  carries the role, and arming tunes the radio first. No registration. (R4.4.3)
* **27** The station challenges every caller with a fresh nonce, and either the Winlink
  password or the account's post-office password authenticates; both are sealed, not
  hashed, because `;PR` is checked by recomputation, and both are dropped when the
  callsign changes. No guest access; unknown callsigns are challenged too, so the
  refusal does not reveal which callsigns exist. (R4.4.3, R7.2)
* **28** The post office's duplicate check is the station's and matches only mail that
  arrived: a MID in somebody's OUTBOX is a message this station is sending, and
  answering `-` for it would lose the peer's message. (R4.4.3)
* **29** POP3, SMTP and IMAP are one door: one lamp in the header — green when all three
  listen, orange when some do, dark red when none does — and one popup holding the
  addresses, the states and a switch on each. The switches are runtime, not configuration:
  the file decides which protocols exist, a restart returns to it, and a protocol the file
  does not offer has a disabled switch rather than no row. A bind that fails is reported on
  its row and never stops the station. The door is the post office's (decision 31).
  (R7.3, R7.8)
* **30** The access mode — who may reach the station at all — is `strict` (loopback and the
  configured CIDRs) or `very strict` (loopback alone), and it is enforced on every accepted
  connection: the HTTP API and web UI included, not only the mail doors. The policy object
  is mutable but validates a change as a whole (`set()`), so a bad form cannot leave the
  station half-open. The change applies to the next connection and is runtime: the file
  decides again at the next start. The validation is start-up's (a CIDR must parse,
  `strict` needs one), and a rejected change leaves the running policy untouched. The client
  UI shows none of it (decision 33); the API and the file are where it lives now. (R7.3, R7.8)
* **31** The station is either a Winlink client or a post office, and the mail-access
  interfaces are the post office's: they serve mail programs, which only a post office has.
  At start-up they open only when the station has a post office owner; with no owner the
  station is a client, nothing listens on POP3, SMTP or IMAP, and the switches refuse to
  start one — stopping is always allowed, so an interface left listening can be closed even
  after the owner is unseated. Until post office work resumes no account is the owner, so
  nothing starts them. (R7.3, R4.4.3)
* **32** The seat is chosen at the door, not by the account: when the post office returns,
  the sign-in form will carry a "post office owner" box, and only a session opened with it
  renders the post office screen or reaches its API. There is no per-user switch and no
  route that appears because of what the account happens to be. At this stage the form
  offers no such option at all — a box that cannot be ticked is worse than no box — and the
  server answers `409` if the seat is asked for anyway, so today every login is an RF Mail
  client login. A client session carries `postOffice: false`, and the client UI says nothing
  at all about POP3, SMTP or IMAP, or about the access policy: no lamp, no addresses, no
  switches. A client has its mailboxes and its radio sessions, and that is the whole
  application. (R7.2, R7.8)
* **33** The client UI shows no access policy either: no lamp, no mode, no CIDRs, not even
  on the sign-in page. The policy is a station-role fact — it decides who may reach the
  server's doors, and the mail doors are the post office's — so it belongs to the post office
  screen when that returns. Until then it is set in the configuration file and enforced on
  every connection, the web UI included; the API keeps `GET`/`POST /api/network/access`
  because enforcement needs the policy and the tests pin the behaviour.
* **34** In client mode an account is made by its owner at the sign-in page: the callsign
  and the Winlink password, nothing else. The Winlink password is required because it is
  the one credential the station cannot invent — it answers a peer's `;PQ` challenge — and
  it is sealed with the store key, never hashed and never returned. The callsign is the
  login and no local password is set here, so the callsign alone signs in until its owner
  sets one on the account page. One callsign, one mailbox: a second attempt is refused
  (`409`), a created account is never the post office, and creations from one address are
  rate-limited (five per ten minutes). The account is signed in as soon as it is made.
  (R7.2)
* **35** An account with no Winlink password is **non-WL**, and the session screen offers it
  only what it can use: no RMS gateway list, no "Winlink RMS gateway" or "Post office"
  session type, and a peer-to-peer call to a station it names as the one way out. The reason
  stands where the list would be, and the screen's own lede changes to match. The flag is
  shown where the fact lives — beside the Winlink password on the account page, and beside
  the callsign in the accounts list — and nothing is withheld from an account that has the
  password. (R8.5)
* **36** A Winlink session always presents `RMS Express-1.8.6.0` in its SID. A production
  CMS refuses a client type it does not know — measured against HB9AK on 25 Nov 2026, where
  our own SID was answered "Unknown client types are not allowed on production servers" —
  so the server sets the identity for every `cms` session. Both identities are kept: `RF Mail`
  is the station's own name, sent to every peer and to a post office, and the one to use
  again when Winlink knows it; `RMS Express` is what the real RMS infrastructure demands.
  The operator chooses neither — there is no checkbox and no text field for it, because the
  identity is a property of the mode, and the debug switch that offered a choice is gone.
  The claim is the SID's client field alone: the callsign, the greeting and the exchange are
  the station's own. (R4.3.1)
* **37** The station has one radio interface, and the operator sets nothing about the rig
  itself: `rigctld`, an address (empty means `localhost`) and a port (empty means 4532).
  Everything else on the Radio screen is read from the daemon — `\get_rig_info` for the
  model, the current VFO's frequency, mode and filter width, `\dump_caps` for the control
  interface and the speeds it accepts, `\get_level RFPOWER` for the power setting — because a
  second copy of facts the rig already knows is a second copy to get wrong. The station dials
  at start-up, polls every five seconds and keeps the link open; a link that fails is retried
  every fifteen seconds, not in a tight loop, and comes back by itself when the daemon does.
  The LED is the radio-to-rigctld side: rigctld can be reachable while the rig is silent, so
  a TCP connection alone is not shown as green. The exact device and speed are rigctld's own
  `-r` and `-s` and are not reported by the protocol at all: `\dump_caps` gives the interface
  the model offers and the range of speeds it takes, never the configured pair, so the screen
  stopped printing that range and records the real one instead (decision 39).
  The transmit-connector choice (R2.2.1) left the old form and came back as a control on
  this card: it is stored with the interface, applied to the live link without reopening the
  socket, and a new interface is created with `auto` — rear input where the rig can select
  it, plain PTT where it cannot. The transmitter power is a control too (`\set_level
  RFPOWER`), written straight to the rig and read back, so what the slider shows is the level
  the radio reports rather than the level that was asked for; a link that is down refuses to
  pretend. `PATCH /api/radio` carries both. The model is not a field anywhere: rigctld
  decides it when it is started, so a typed name could only ever agree with the rig by luck,
  and the stored `name` is now an internal row label that no screen shows. Sentences that
  named the radio call it by the model, or by the address until the daemon has answered.
  (R2.2)
* **38** A modem is **active** only when the program on its port is the kind it is configured
  as, and **unavailable** otherwise — whatever the socket did. VARA, XARA, Data2G and Mercury
  share ports, and a VARA record served by Data2G answers TCP cheerfully while having no VARA
  in it; calling that "running" told the operator a session could start when it could not.
  The `VERSION` reply decides, and the reason names the program that answered; the screen keeps
  one word — active or unavailable — because a name-and-version line beside the record's own
  type told the operator nothing they could act on. The same rule covers every kind, not
  only VARA: the kind that answers is not the kind that was configured. (R3.11.1)
* **39** The serial line is recorded, not read. `\dump_caps` answers with the rig model's port
  type and the range of speeds it accepts, never the device rigctld was started with or the
  speed it actually uses — measured against Hamlib 4.6.3, whose `\get_rig_info`, `\dump_caps`
  and `\dump_state` carry neither. A range printed as if it were the setting is worse than no
  line at all, so the interface form takes the device and speed as two optional notes
  (`serial_port`, `serial_speed`), the tile shows them when they are there, and nothing is
  invented when they are not. The same discipline gives the screens their shape: one tile per
  radio (model, host, state) and one per modem (protocol, `host:port`, state), with the detail
  — dial, filter, serial line, ports, radio, mode, the two rig settings — opening under the
  click, because a table of everything is a table nobody reads. (R2.2, R3.11)
* **40** A station may have several rigctld interfaces, one tile each: `host:port` and LED on
  the first line, the transceiver it serves on the second, and the rest under the click. Each
  is switched on or off on its own, and every enabled interface is dialled and kept dialled.
  Which one the station treats as *current* — the header chip, the screen's default — is a
  fact, not a setting: `last_used_at` on the interface row, bumped when it is created, edited,
  opened or selected, ties broken by the newer row. That is what "the previously used
  interface is remembered in the database" means here, and it needs no setting table. The
  older name-based registry ordering went with it: the list keeps a stable order so tiles do
  not jump when they are clicked, and the current one is chosen by time. (R2.2)
* **41** A modem's three ports are named by the modem, not by the station. VARA, ARDOP, XARA,
  Data2G and Mercury use **CMD**, **DATA** and **KISS**, all TCP; the tile prints each prefix
  with the number and one letter for the transport (`t`, `u`), so a KISS port on TCP is never
  confused with Direwolf's sound port. Direwolf is a different animal behind similar names:
  **KISS** (TCP) and **AGW** (the AGWPE interface, TCP with a different command set) are
  command interfaces, and **SND** (also called AUX) carries the channel audio over **UDP**. It
  is registered as a kind with those three ports and the vendor defaults 8001 (KISS), 8000
  (AGW) and 7355 (SND, UDP); it is judged "active" by its AGW port answering TCP, because no
  Direwolf interface answers `VERSION` and the kind-mismatch rule of decision 38 has nothing to
  compare. A session driver for packet radio is not built, so a Direwolf modem runs no session
  yet. A record created without ports takes the kind's own numbers on the server as well, so
  the form and an API client agree. (R3.11)
* **42** The interface tile shows the machine's LAN name beside the address, and the station
  asks two services to get it. NetBIOS first — a NBSTAT query to UDP 137, which is what a
  Windows PC answers with its computer name (measured on this LAN: 192.168.133.222 answers
  QUANTUM-Q1, workgroup MISKOVICE, MAC 4C-52-62-25-7D-A5) — then an mDNS PTR for
  `<reversed>.in-addr.arpa` with the unicast-response bit set, which covers a Mac or a Linux
  box publishing `.local`. Plain reverse DNS is not asked: the router does not register DHCP
  names, so `getent hosts 192.168.133.222` returns nothing while the two LAN services both
  answer. Neither query may hold a page: the registry is drawn first and `/api/hostnames`
  fills the names in afterwards, a hit is cached for ten minutes and a miss for one, and a
  host that answers neither simply keeps its address. Nothing is written to the interface
  record, because the name belongs to the network, not to the configuration. The tile puts the
  name first — bold, with `:port` in normal weight after it — then the address, then the
  transceiver; a modem tile carries the same pair above its ports, and `/api/hostnames` covers
  every host in the registry, radios and modems alike. (R2.2.2)
* **43** The modem form asks four things downwards and nothing else: the protocol, the address,
  the ports that protocol has, and the transceiver mode. The ports are a two-column table —
  function on the left, number on the right — and it is rebuilt when the protocol changes, so
  the form never offers a KISS port to a VARA, whose kind has none, and never leaves the
  vendor's numbers for the operator to look up: VARA/VARA FM/XARA 8300 and 8301, ARDOP 8515 and
  8516, Direwolf AGWPE 8000, KISS 8001 and the sound port 7355 over UDP. The name left the
  form: the station composes it from the facts (`VARA HF 192.168.133.222:8300`), which is the
  same tuple that makes two modems different. The transceiver left the form too, because the
  station has one interface (decision 37) and a second field asking to name it invited a
  question the operator cannot answer; a modem now names no radio, and a session tunes
  whatever interface is current (decision 40), so the details panel shows the radio that will
  actually be keyed. A modem created before this keeps the transceiver it named. (R3.11.2)
* **44** The session screen keeps the gateways the station has called, as chips above the client
  identity, and builds the list from what happened rather than from a setting. The key is the
  pair — callsign on one dial — because the same gateway may be reachable on two bands and only
  one of them works from here; case is not part of it. An entry is recorded when the dial
  connects, not when it is attempted: a call that got no answer says nothing about the gateway,
  and counting it would push a dead frequency up the list. Each use increments a counter, and
  the chips are ordered by that counter, then by recency, so the gateway called every evening
  sits first and a callsign tried once from a bulletin does not. This is the answer to the RMS
  catalogue being the only way in: a pair typed by hand becomes a button on its first successful
  session, and a non-WL account, which is offered no catalogue at all, still has a list. The chip
  fills all four fields the way `pick()` does — target, dial, unit, band — so a favourite and a
  listed channel are the same act. (R3.13)
* **45** A session sets the dial and the mode, and nothing else. The station used to send
  `\set_mode PKTUSB 0`, believing 0 meant "leave the passband alone"; in Hamlib 0 is
  `RIG_PASSBAND_NORMAL`, so the daemon recomputed the rig's filter — on a TS-590S it moved the
  width from 2000 Hz to 1000 Hz, measured — and re-centred the IF shift, which the operator had
  set to 1500. With the IF shifted to 1100 the 2.5 kHz filter delivers 2.1 kHz, which is why a
  2300 Hz mode stopped decoding. The station now sends `-1`, Hamlib's `RIG_PASSBAND_NOCHANGE`,
  and skips the mode write entirely when the link's last read says the radio is already in that
  mode, so a session that begins with the rig where the operator left it writes no filter, no
  shift and no power. What a station may set is the dial and the mode; the filter width, the IF
  shift and the power are the operator's, and the protocol has no way to ask him. The passband
  is gone from the client's signature altogether — `setMode(mode)` cannot name one — because
  2300 Hz is a modem's bandwidth (`BW2300`, `ARQBW`, on the modem's own port), never a rig
  filter: a TS-590 has 500/1000/2000/2400, and a width it does not have makes Hamlib shift the
  IF to fake it, which is exactly the meddling this removes. (R2.2.3)
* **46** The station never asks rigctld for its capability dump. `\dump_caps` was the only
  heavyweight request it made, and on this daemon it runs `rigctl_dump_state` — the block of
  `unknown RIG_FUNC=` lines the operator saw twice at start-up — which is the path where a
  Kenwood's settings get re-applied: the 5 W that appears at the first session after a connect
  and the IF shift that lands at 1100 instead of 1500 are that path, not a `\set_*` of ours. The
  screen needed nothing from it: the model comes from `\get_rig_info`'s `Rig=`, the Hamlib
  version from its `App=` and `Version=`, and the port type and speed it listed were the model's
  generic range, not the configured line — the line the operator records himself (decision 39).
  What the station sends to the daemon is now a closed list: three reads per poll
  (`\get_rig_info`, `\get_ptt`, `\get_level RFPOWER`) and, only when asked, `\set_freq`,
  `\set_mode <mode> -1`, `\set_ptt` and `\set_level RFPOWER`. (R2.2.4)
* **47** The screen shows the rig's own filter and IF shift, read with two fixed raw queries.
  `w SH;` answers `SHnn;` — `SH05;` is the centred 1500 Hz — and `w SL;` answers `SLnn;`, the
  filter in use. The ladder is the TS-590S's own for SSB and SSB-DATA: 00=50, 01=80, 02=100,
  03=150, 04=200, 05=250, 06=300, 07=400, 08=500, 09=600, 10=1000, 11=1500, 12=2000, 13=2500 Hz;
  a code outside it is unknown, never guessed from another mode's table. Hamlib's `Width=` is its
  own idea of the passband and need not be the rig's filter (measured: `Width=2000` against
  `SL13;`), which is why the old readout was wrong. The raw channel is the only one that can read these on a Kenwood,
  and `w` writes as easily as it reads — so it appears exactly twice, with nothing after the
  command letters and no parameter anywhere, and a test asserts that the whole wire traffic of
  those two calls is `['w SH;', 'w SL;']`. The shift is reported as centred or, when it is not,
  with the width it costs: 2500 Hz at `SH01;` passes 2100 Hz, which is the 2300 Hz mode's
  passband gone. (R2.2.5)
* **48** The RMS catalogue is a modal, not a second page. "Find gateways" puts it over the
  session form, where the choice is made and the modal leaves behind the answer; the form behind
  is never unmounted, so a half-typed dial survives a look at the list. Five ways out, all ending
  in the same state: a row (which picks and fills the form), the × in the header, the Cancel
  button in the footer, a click on the backdrop, and Escape — the last two come from the dialog
  element itself, which is why it is a `<dialog>` and not a styled `<div>`. Opened and closed from
  one `listOpen` flag through an `$effect`, so the native close (Escape) cannot leave the state
  disagreeing with the screen. While it is open the page behind cannot be touched or tabbed into,
  which is the point: a session is assembled in one place. (R4.7)
* **49** A gateway called before is remembered with the mode it answered on, not only the callsign
  and the dial. The mode is half of what the operator chose — the same RMS on the same dial is
  reachable with VARA or with ARDOP, and a chip that forgets which one leaves the question open —
  so it joins the key, and the chip reads `OK1RAA · 3597.0 kHz · Data2G · 2×`. Picking one fills
  the form with all three, and only a mode the station still has a modem for is put back (an
  entry whose modem has been deleted leaves the choice as the operator left it rather than
  selecting nothing). Entries recorded before the mode was kept have none and show a dash. The
  claim rule written here — the next successful use filling the gap instead of leaving a second
  row — was withdrawn by decision 55: it is what relabelled a peer call as a gateway call. (R3.13)
* **50** The kind of session is remembered with the gateway too. A station called as a Winlink
  gateway, as a peer, or as this station's post office is three different conversations, even on
  the same dial with the same mode — a peer session hands the far end its own mail and nothing of
  the CMS's — so `cms`, `p2p` and `postoffice` join the key, and the chip reads `OK1RAA · 3597.0
  kHz · Data2G · GW · 3×`. Picking it sets the Session type select as well; a `cms` or
  `postoffice` entry is not forced on an account without a Winlink password, which may not make
  that call at all. Entries from before the column have no type and show nothing where it would
  be; the claiming rule written here was withdrawn by decision 55. (R3.13)
* **51** A running session is watched, not guessed at, and has one way out. The modem's commands
  and the exchange's lines are carried to the screen over a WebSocket on
  `/api/session/ws?id=…`, opened with the session cookie the page already holds, in a channel
  the screen makes up an id for *before* it starts the run — so the channel exists when the
  first command is written, and a screen that connects a moment late is given the backlog. The
  protocol is spoken here (handshake, text frames, close and ping) rather than through a
  library, like the mail protocols. The session then runs in a modal of its own, and the modal
  has one control: the **first** press asks the link to come down — the modem is told
  `DISCONNECT`, the data socket closes, the far end sees a normal end of link — and a **second**
  press, while that is still happening, cuts it: both sockets destroyed, no closing sequence,
  no waiting for repeats. The server decides which step it is from the channel's own phase, so
  a screen cannot ask for an abort before a disconnect, and a third press does nothing. The
  control exists from the moment the dial starts, because the dial is often the long part: a
  stop asked for during the dial reaches `dialModem` through two `AbortSignal`s — a polite one
  that sends `DISCONNECT` and waits out the grace, and a hard one that destroys the socket — and
  the run reports `aborted` with which of the two happened (`the session was aborted while
  dialling`, `the session was disconnected while dialling`) rather than as a failure of the
  modem. (R4.5.3, R4.5.4)
* **52** The feed names who is speaking, and does not go quiet on a binary block. Every line
  carries its speaker: `MODEM` for what the modem is told, the callsign being called (or `PEER`
  when there is none) for the B2F lines, which are set in dark blue bold when they are received —
  the traffic is the reason the sheet exists, the modem's chatter is not. A message travels as a
  binary block, and the exchange reads bytes, so `runSession` wraps the data stream in
  `watchBytes()`: anything with a byte that is neither printable nor CR/LF/TAB is reported once,
  as its first twelve bytes in hex, an ellipsis and how many bytes arrived (`3C 2A 4C 5A 00 FF 80
  01 7C 2A 3E 0D … 4128 bytes`). Protocol lines are pure ASCII, so they are left to the line
  report and never repeated. The sheet is a report, not a transcript: the two collapsible logs
  under the feed are gone, and the sheet stays until it is closed — by its button, its ×, Escape
  or a click on the backdrop, but by none of those while the transmitter is up.
* **53** The feed is a log of two channels, and each is drawn as what it is. Only the *data*
  channel is emphasised: the peer's lines are bold, dark blue when received and green when sent,
  under the callsign being called. The command channel is machinery — its replies plain grey, the
  commands sent to it in italic — and nothing there is bold. `PTT ON` and `PTT OFF` are not logged
  at all: the modem keys the transmitter, so that is a lamp marked **ON AIR** in the sheet's
  header, red while it is lit, and when the key drops the feed gains one line carrying the moment
  the transmitter came on, `MODEM > TRANSMIT 3.0 s` — the duration between the two, so a hundred
  keyed frames do not become two hundred lines. The sheet is a fixed frame: it spans the session
  screen from just under the app's 56px header to just above the bottom of the window, the feed
  takes the height it is given and scrolls once it is full, and the head and foot stay put.
* **54** Silence is worth a line too, once. The modem keys the transmitter frame after frame; between
  the key dropping and the next time it comes on there is often a gap in which nothing is said to
  the modem and nothing comes back from it — the station listening, which is what the operator
  wants to see when a call is slow. So after `PTT OFF` the sheet remembers the moment, and if the
  next `PTT ON` arrives with no line in between — no command sent, no data received, not even a
  modem reply — it writes one line stamped with that moment: `4.0 MODEM · waiting 5.0 s`. Any line
  at all cancels it: the gap is then already accounted for, and a session that is working does not
  collect waits. A wait shorter than a tenth of a second is not written, and the silence must be one: what
  breaks it is traffic — data from the peer or a command sent to the modem — while the modem's own
  `MODE …` and `IAMALIVE` lines do not count, because Data2G prints a `MODE` line after most
  transmissions and counting those hid every wait.
* **55** A recorded call says what it was, and is never rewritten into something else. `CALLED
  BEFORE` is a list of calls that actually happened — callsign, dial, digital mode, *and* the kind
  of session — and it was lying: an entry made before the session type was kept has an empty one,
  and the first later use claimed it, which is how a peer call came to be listed as a Winlink
  gateway call. The claim is gone. Recording is one statement, an insert-or-count on the whole
  quadruple: a call of a known kind is its own entry, and an entry left half-known by an older
  version keeps what it knows and shows nothing where it knows nothing — guessing the missing
  half is how the guess becomes a fact. The list is read from the store again after every session,
  successful or not, so it is a record of what the station has been doing rather than a snapshot
  taken when the page opened. (R3.13)
* **56** The band follows the dial. Typing a frequency into the session form used to leave the
  band select where it was — 3597 kHz typed under 40 m, with the form then describing 80 m in one
  field and 40 m in the next. The typed dial now sets the band to the one that contains it (and
  reloads the catalogue for that band once the typing has settled), and a number that lands in no
  band in the unit the field shows is read in the other unit: `3597` in a megahertz field is 3.597
  MHz rather than 3597 MHz. The dial field carries no placeholder either — a greyed `7053.5` was
  read, reasonably, as something already entered.

* **57** The post office is a separate application (settled 27 Nov 2026): `apps/postoffice`
  with its own console, its own configuration, its own data directory and its own service,
  built on the same `core-b2f`, `store`, `rig` and modem code as the client. The client loses
  the seat at the door, the post office screen and `/api/postoffice/*`, and decisions 31, 32
  and 33 fall with them: a session is a client session, and a station is either one application
  or the other. The two databases are separate files — one holds a person's mailbox, the other
  other people's mailboxes — and the store admits the post office's own tables only when it is
  opened for it. (R4.4.3, R7.2, R7.9)
* **58** A mailbox and an administrator are two principals. A *mailbox* is a callsign the
  station holds mail for: a sealed post-office password, folders, messages, a quota — and no
  password hash, no session and no route, because its owner collects over the radio. An
  *administrator* is a person: a name, a scrypt password, a session, and the optional permission
  to read other mailboxes' envelope metadata; it has no callsign and no mailbox. Two tables, two
  verifiers, and the `;PQ`/`;PR` path never consults an administrator's password — one shared
  verifier is one refactor away from a `pw_hash IS NULL` branch that admits a stranger. The
  console's session carries an administrator id, and its API never resolves that id through the
  mailbox table. (R7.2, R8.7, R9.1)
* **59** The B2F door is frozen: SID, `;PQ:` with a fresh nonce, `;PR:` folded to eight digits,
  and nothing added to the handshake that carries authentication. Two facts decide it. wl2k-go
  ignores every handshake line it does not know (`default: // Ignore`, with its own review note
  that unknown `;`-comments ought to be allowed), so an extra line would not break pat; but the
  answering side speaks first, so the post office has committed to a handshake shape before it
  knows who is calling, and any new line goes to every caller including the closed-source
  clients nobody here can test. A second password protocol inside B2F would also be thrown away
  when the native door arrives. (R4.4.1.1, R4.4.3)
* **60** The native door is announced, not negotiated: one line after the post office's SID,
  `;RFPO: 1`, ignored by every B2F client as a comment. A native client answers it with its own
  hello instead of `;FW:` and the station switches to the new protocol on the same data port;
  a B2F client never notices. The challenge that has already gone out costs a dozen bytes. This
  is the comment convention used as a doorbell, never as a second authentication. (R4.4.3)
* **61** Identity in the native door is PKI, and the post office is its own CA. Each mailbox gets
  one static key bound to its callsign; enrolment happens once, as a system message over the B2F
  door, accepted only in a session that authenticated as that mailbox with its post-office
  password, which can then be revoked. The private key never leaves the client, so no form here
  can issue one. Revocation is a store flag, not a CRL, because the post office is the verifier.
  The volume is a one-time 100–150 bytes of binding (a certificate, if wanted as a document, is
  300–400); per session there is none, because Noise proves possession of a key both ends
  already hold. (R4.4.3, R9.1)
* **62** The native handshake is Noise IK/KK with Ed25519/X25519 static keys — about 200 bytes
  each way, one round trip, mutual authentication, forward secrecy, no certificate on the wire.
  TLS 1.3 with client certificates was rejected on air time: a first session moves kilobytes of
  handshake, and only resumption makes it cheap. One response per challenge, as the handshake's
  single flight allows; both responses present is a refusal even when one is right. (R4.4.3)
* **63** `b2f: allow | refuse` is a property of a mailbox and it limits **collection only**.
  Delivery is not collection: mail for that mailbox still arrives over B2F, because the caller
  authenticates as the *sender* and the recipient is not the caller — a mailbox the network
  cannot deliver to is not a mailbox. On the wire a refused mailbox is refused exactly like a
  callsign that does not exist, so the door cannot be asked which mailboxes exist; the call log
  records the real reason. (R4.4.3)
* **64** The post office's B2F door verifies the post-office password only. Decision 27's
  "either credential authenticates" was settled when the station was a single-account client
  that was also its own post office and the operator's Winlink secret was the only one that
  might exist; with an administrator-issued mailbox that rationale is gone, and the CMS password
  stays the CMS's business. The trade is stated: a visiting registered user needs the password
  this post office gave them. (R4.4.3, R9.1)
* **65** The first step of the application is the seam, not the protocol: the answering half
  splits into the mail policy (accept, defer, duplicate, offer, collected, unknown recipient)
  and the B2F framing that drives it, with the listener as the door multiplexer. The native
  protocol, the key store and the enrolment flow are postponed; they are not first-release work.
  (R4.4.3)
* **66** The console is the only door: four screens — station, mailboxes, calls, administrators
  — and no user-facing mail reader, because the users are radio-only. The station screen is one
  lamp and one word (armed / call / disarmed / fault), the modem picker, and the panels for
  modems and recent calls; the call log is written from the session's own ending and is the
  first thing to read when a user says a message never arrived, because it names the caller and
  what the exchange did without any message content. Envelope inspection is a per-administrator
  grant, off by default, metadata only, audited — and is the next screen, not this one. (R4.4.3,
  R8.7, R7.7)
* **67** The station is installed as a service, written by `deploy/install-postoffice.sh`: a
  service account, a copy of the tree, one configuration written once with both keys generated
  (never overwritten — replacing either key signs everybody out or makes every stored password
  unreadable), and a systemd unit that restarts on failure, holds a 30-second stop timeout so
  the station can disarm, and can write only its data directory. The console is built before
  installation; the installer refuses without it rather than shipping a placeholder screen. The
  default listener is loopback, and the two edits for a LAN console are printed at the end. The
  Windows service wrapper is the next platform task and does not exist yet. (R7.9, R9.1)

* **68** The post office's radio is one rigctld, and arming is a tuning act (settled 27 Nov 2026).
  The console names the address and the transmit connector and nothing else about the radio: the
  daemon knows the model, so a typed name could only agree with it by luck, and the station reads
  the power rather than setting it. The link lives in the running process — dialled at start-up,
  re-read every five seconds, retried fifteen seconds after a failure — and nothing about it is
  written to the store. Arming tunes the transceiver to the dial the operator typed and only then
  tells the modem to listen; with no radio configured or a link that is down the arm is refused,
  because an inbound call cannot be tuned for and a transmitter must never be keyed on whatever
  frequency the rig happened to hold. The dial is typed in the unit the band uses (kilohertz
  below 10 MHz, megahertz above) and recorded with the call. The five-second read also exposed a
  listener leak: each completed `rigctld` round trip left an `error` and a `close` handler on the
  shared socket, so an unattended station would have run into `MaxListenersExceededWarning` after
  ten commands; the handlers are now removed when a round trip settles, and a test polls twelve
  times and asserts the warning never appears. (R4.4.3, R2.2)

* **69** Windows installs the station as a task at boot, and both installers repair the
  workspace links (settled 27 Nov 2026). `node` is not service-aware, so a "service" on Windows
  would be a wrapper the operator has to fetch before anything works — and a station on a hill
  cannot fetch one. Task Scheduler is already on every station box: the task runs as SYSTEM at
  boot, restarts a minute after it stops, has no execution limit, and starts a shim
  (`run-postoffice.cmd`) that writes the log and rotates it at 5 MB, because Task Scheduler
  captures nothing. The console port is opened in the firewall only when `-OpenFirewall` is
  asked for; the configuration is ACL'd to SYSTEM and Administrators instead of chmod 0600.
  Both installers then re-create `node_modules/@rfmail/*` as links into `packages/`: Node
  refuses to strip types for a file under `node_modules`, so a dereferenced copy — which is what
  `robocopy` and `Copy-Item` make — refuses to start with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. A junction on Windows (no privilege), a
  symlink on Unix, so a tree unpacked from an archive that stored links as files still installs.
  Verified here with PowerShell 7 and `-NoService`: the copy, the generated configuration, the
  shim, and the installed tree serving its console; the Task Scheduler, `icacls` and firewall
  branches need a Windows machine and have not been run. (R7.9, R9.1)
