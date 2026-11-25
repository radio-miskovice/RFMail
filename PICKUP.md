# Picking this up

Written the evening of 25 November 2026. Everything below was run, measured or read
from the real thing — where it was not, it says so.

Repository `/home/jvavruska/dev/rfmail`, branch `main`, working tree dirty with the
B2F session work described below (the last commit is `e915d63`, this file). 141 tests
pass, `tsc` and `svelte-check` are clean.

---

## Where it stands

**Mail.** Its own store (SQLite via `node:sqlite`), SMTP submission, POP3 and
IMAP4rev1 (IDLE, APPEND, EXPUNGE, ENVELOPE, BODYSTRUCTURE), a browser GUI with
folders, reader, composer, search, `.eml` export. A mail program signs in with the
account name, the bare callsign or `CALLSIGN@winlink.org`; inside the station
addresses are bare callsigns, and `@winlink.org` is added only when serving a mail
program and stripped on receipt, `winlink.org` only.

**Accounts.** scrypt passwords; one callsign per account (a club or expedition
callsign is its own account); a WW-Locator per station; the Winlink password sealed
with AES-256-GCM under a `store_key` separate from the session secret. Any account
may configure the station's radios, modems and sessions (decision 14).

**Radio.** Transceivers in the store, rigctld links with the grey/amber/green/red
LED, the rear-versus-front PTT choice a TS-590 needs for a modem, explicit reset.

**Sessions.** The Winlink catalogue (`api.winlink.org/gateway/status.json`) is
fetched with the public client key, cached beside the database with the set of
service classes it was fetched for, and flattened to channels carrying band,
distance and bearing from the locator, plus two estimates. Ordering by distance or
by the estimate; VHF and up carry no estimate at all.

**Modems.** A registry (type, host, command/data/KISS ports, transceiver, rig mode)
and a live check that shows whether each one is actually listening.

**The B2F exchange — new, and the point of the last day's work.** A session now
dials, runs the FBB B2 protocol over the modem's data port, and files the mail away:

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

---

## Running it

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"   # the system npm is broken

cd /home/jvavruska/dev/rfmail
npm test                                    # 141 pass
npx tsc -p tsconfig.json                    # clean
npm --workspace apps/web run check          # svelte-check, 0/0
npm --workspace apps/web run build          # static site the backend serves
```

The test instance, which is running now (started 25 Nov, built from this tree):

```bash
T=$HOME/.hermes/cache/scratch/rfmail-phase2
HOME="$T/home" node apps/backend/src/main.ts --config "$T/rfmail.toml" --log info
```

* UI <http://192.168.133.207:8082>
* POP3 1110, SMTP 1025, IMAP 1143, all on `0.0.0.0`, access `strict` with
  `192.168.132.0/23`
* config `$T/rfmail.toml`; database `$T/home/.local/share/rfmail/rfmail.db`, schema
  v6 (the session work added no migration)
* accounts jvavruska (OK1ABC, admin, **no mail password**), ok4rm (OK4RM),
  operator (OK2XYZ, has a password set while testing)
* modems: ARDOP `192.168.133.222:8515`+8516, Data2G `.222:8300`+8301+KISS 8100,
  VARA FM `192.168.132.6:8300`, VARA HF `.222:8300`, XARA `192.168.133.50:8300`

---

## The one thing that is blocked

**Data2G is not reachable from this machine.** Measured today from 192.168.133.207:

```
ping 192.168.133.222           answers, 0% loss, 0.6 ms
135 139 445 3389 5040 5357 7680   open (Windows itself)
8300 8301 8100 8515 8516          refused on .222
4532 (rigctld)                    refused — it answered yesterday

192.168.133.86:8300, :8301        no answer at all (SYN dropped), ping 6.9 ms
```

Two different signals, and on Windows they mean the same thing. Data2G binds loopback
by its own defaults (`data2g/host.py`: `--host 127.0.0.1`, `--command-port 8300`,
`--kiss-address 127.0.0.1`, `--kiss-port 8100`), so a LAN connect either gets a refusal
(.222 yesterday, where the firewall let the RST through) or is dropped by the
Windows firewall before any RST (.86 today). A timeout is *not* evidence that the
program is not running: a loopback-only listener produces exactly that from the client
side. Settle it on the host, not from here.

In order, on the machine running Data2G:

1. `powershell -c "Get-NetTCPConnection -LocalPort 8300 | Select LocalAddress,State,OwningProcess"`
   (or `netstat -ano | findstr :8300`). `127.0.0.1:8300` means loopback-only;
   `0.0.0.0:8300` means it is on the LAN and the firewall is dropping us.
2. If loopback-only, start Data2G with `--host 0.0.0.0 --kiss-address 0.0.0.0`.
   (Alternatives: run rfmail's backend on that machine and point the modem at
   `127.0.0.1`; or `netsh interface portproxy add v4tov4 listenport=8300
   connectaddress=127.0.0.1 connectport=8300`, same for 8301 and 8100.)
3. If it is already on `0.0.0.0`, the firewall is the blocker:
   `netsh advfirewall firewall add rule name="Data2G" dir=in action=allow protocol=TCP
   localport=8300,8301,8100 remoteip=192.168.132.0/23`.
4. Start rigctld too — 4532 was up yesterday and is down now, and a session refuses
   to key a transmitter that it cannot tune first.
5. Then, in the app: Session → Data2G → target `OK1RAA` → dial `3597.0` (kHz, 40 m) →
   **Start session**. The TS-590S was left on 3597.0 kHz PKTUSB.

That session transmits. Expect the exchange log: the gateway's SID and prompt, our
`;FW: OK1ABC` and SID, the proposals for anything in OUTBOX, and either `FS +` with
the framed message or `FQ`. With an empty OUTBOX it will be the short shape —
`FF`/`FQ` — and still tells you whether the far end speaks B2.

---

## What is proven, and what is not

Proven by tests (over real sockets, not stubs of the engine):

* `test/session.test.ts` — the exchange against a hand-written gateway: outbound
  accepted/rejected/deferred, inbound LZHUF and gzip, a duplicated proposal, an
  offset resume, a secure-login challenge answered with the response in the log,
  a peer without B2, a wrong proposal checksum, one damaged message inside an
  otherwise good block, a silent peer, an aborted session, and the master half.
* `test/session-run.test.ts` — a scripted VARA-family modem (command port plus data
  port) with the real store: dial, exchange both ways, message moved OUTBOX→SENT,
  inbound unread in INBOX, a MID the store already holds answered `-` and not
  transmitted, ARDOP refused with a reason.
* `test/api.test.ts` — the same through `POST /api/session/run` over HTTP, against
  rigctld and a scripted modem, including CSRF.

Not proven, in order of how much it matters:

1. **Nothing has been on the air.** No session has run against a real gateway — the
   modem is not reachable (above). Everything above is sockets and stores.
2. **ARDOP sessions do not exist.** ARDOP carries the session bytes on the same
   socket as its text command replies, which needs ARDOP's binary framing
   (`BUFFER`/`ARQ` frames); `runSession` refuses an ARDOP modem with that sentence
   rather than half-running one. VARA HF/FM, XARA, Data2G and Mercury take a plain
   data port and work as written.
3. **The secure-login answer has never been accepted by a CMS.** The construction is
   copied byte-for-byte from the reference and unit-tested, but a real `;PQ` has not
   answered it. The first live session will say.
4. **No queue, no progress, no cancellation.** `POST /api/session/run` holds the HTTP
   request open for the whole session (minutes), and the screen shows "In session…"
   with no live log until it returns. A queue with priority, a WebSocket log and an
   abort button are M7.
5. **Inbound mail always lands in the account's INBOX** — correct for a client
   session, wrong for a gateway relaying for other callsigns, which is M12 (the
   answering half of the engine is ready for it).
6. Nothing retries. A deferred message stays in OUTBOX, but there is no attempt
   counter or next-attempt time yet.

---

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
* **20** The SID this station sends is `[rfmail-0.1-B2FHM$]`, with `G` before the `$`
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

---

## Measured on the air, Data2G 0.5.3 (25 Nov 2026)

* It talks to rigctld on its own, whatever its "use rig control" checkbox says: a
  `\set_ptt 3` first (the rear input a modem feeds), then `\set_ptt 1` on the retries when
  3 is refused. With a daemon that reports no PTT type, all of it is accepted and none of
  it keys anything — which is why the radio stayed silent while the log filled with PTT
  lines.
* It also sets the receiver filter: after a session the rig read PKTUSB with a 1000 Hz
  passband where the station had 2000, so the app's own mode/passband set at the start of
  the session does not last. Nothing in rfmail did it; the modem did.
* Its command port answers `VERSION Data2G 0.5.3` and reports `BUSY ON` about 300 ms
  before `CONNECTED` on a call that comes up, plus `PTT ON`/`PTT OFF`, `BUFFER <n>`,
  `MODE <name>`, `IAMALIVE` and `DISCONNECTED`. It says nothing while merely listening, so
  a channel cannot be checked before the first connect frame goes out.
* A completed session ran 53 s end to end for two messages of 266 and 200 bytes, and both
  were accepted by a pat station (`FS ++`).

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
* Gateway relay and post office as running roles: the engine's answering half exists,
  but nothing listens for an inbound session yet.
* Nothing is transmitted unless a session is started, and nothing is left connected:
  every path (connected, failed, error, aborted) hangs up.
