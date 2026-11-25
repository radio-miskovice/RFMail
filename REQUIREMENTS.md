# rfmail — Requirements

Status: draft 2, 2026-11-24. Decisions in §12 settled the same day. Nothing is
implemented yet; this document is the contract the implementation is measured
against.

Basis: a study of `../pat` (14,266 lines of Go, plus its libraries `wl2k-go`,
`Pat-Vara`, `ptc-go`), the Winlink document *Open B2F — Winlink Message
Structure and B2 Forwarding Protocol* (2018 revision), the ARDOP host
interface specification, the VARA host interface as implemented by Pat-Vara and
reimplemented by XARA and Data2G, and the Hamlib `rigctld` command interface.

pat is the behavioural reference, not the architecture: pat is a single-user
desktop client with a mailbox directory, a command line, and an embedded web
GUI. rfmail is a multi-user server with a database and a browser front end, so
several of pat's decisions (per-callsign directories, config as the only state,
one session at a time because one person is at the keyboard, prompts that block
on a terminal) do not carry over.

---

## 0. Vocabulary

Terms used below, all of them existing constructs of the system being
interfaced with — no new names for old things.

| Term | Meaning here |
| --- | --- |
| **B2F** | Winlink's expansion of the FBB forwarding protocol: proposals, compressed blocks, the Winlink message structure with multiple recipients and attachments. |
| **FBB** | The original packet-BBS forwarding protocol (F6FBB). "B2" is the Winlink expansion; B1 and lower are the older levels. |
| **MBO** | Mailbox operator — a BBS that forwards mail. |
| **CMS** | Winlink Common Message Server (the AWS-hosted central servers). Clients reach it over radio via an RMS, or over TCP ("telnet") at `server.winlink.org:8772` / `cms.winlink.org:8772`. |
| **RMS** | Radio Mail Server — the amateur-operated gateway station between radio and CMS. |
| **RMS Relay** | The Winlink store-and-forward / local-routing companion to RMS Trimode, including the telnet "post office" on port 8772. |
| **MPS** | Message Pickup Station — a station in the Winlink Hybrid Network that picks up and forwards mail by HF. |
| **Post office** | A B2F server that terminates sessions locally and holds mail for its users instead of relaying to a CMS. |
| **Secure login** | The Winlink password exchange: the server sends `;PQ <challenge>`, the client answers `;PR <response>`. |
| **SID** | System identifier sent in the handshake, e.g. `[Pat-1.0.0-B2FHM$]`; contains the protocol capability codes. |
| **MID** | Message identifier, ≤ 12 characters, carried in the `Mid:` header. |
| **Proposal** | The `FC`/`FD` line offering a message with its MID, uncompressed and compressed size. |
| **Forwarder list** | The `;FW:` handshake line naming the addresses the remote will accept mail for. |
| **rigctld** | Hamlib's rig-control daemon, spoken to over TCP in ASCII. |
| **ARDOP** | Amateur Radio Digital Open Protocol; `ardopcf` is the maintained C implementation, interfaced over TCP with an ASCII control port and a binary data port. |
| **VARA** | The closed-source Windows sound-modem with a TCP host interface (command port, data port). XARA, Data2G and Mercury implement that same host interface. |

---

## 1. Shape and hard constraints

**R1.1** The whole application — backend and frontend — is TypeScript. The
backend runs on Node.js (≥ 24 LTS), ESM, no transpiler step at runtime. The
frontend is TypeScript compiled to browser JavaScript. No other language
appears in the source tree except test fixtures and shell snippets for
deployment.

**R1.2** Portability is a requirement: the backend must run on every platform
Node supports — Linux, macOS and Windows — from the same source, with no
platform-specific fork. Compiled code inside npm packages is permitted, under
these conditions:

* The default install must not require a compiler or a toolchain.
* A dependency that ships compiled code must ship prebuilt binaries for the
  supported platform/architecture matrix, or have a documented build path for
  the platforms it does not cover. Anything that can only be built on one
  operating system does not qualify as a required dependency.
* A platform-independent (pure JavaScript or WebAssembly) implementation is
  preferred where it is a realistic option, and is required where the compiled
  alternative would break portability.

Consequences, applying that rule:

* **SQLite** uses Node's built-in `node:sqlite`, which needs no dependency at
  all and is therefore identical on every platform. A `better-sqlite3` adapter
  may be added for performance, but only behind the same storage interface and
  never as the only SQLite option.
* **MariaDB** through `mysql2` and **PostgreSQL** through `pg` — pure
  JavaScript, no build step, every platform.
* **Password hashing** through `node:crypto` `scrypt`; no bcrypt/argon2 native
  binding, which would add a compile step for no functional gain.
* **LZHUF, gzip framing and the B2 CRC** are implemented in TypeScript; a
  WASM build of another project's coder would be acceptable but a port is
  smaller and auditable.
* **No serial-port dependency at all**: every modem, the CMS and `rigctld` are
  reached over TCP, so nothing here needs a native serial library.

CI enforces R1.2: `npm ci --ignore-scripts` must install with no compiler
present, and for every production dependency that contains compiled code there
must be a recorded platform matrix showing prebuilt coverage or a documented
build path.

**R1.3** One backend process. It serves the HTTP API, serves the built single
page application, runs RF sessions, and runs the mail-access servers. It talks
to external programs only as configured: `rigctld`, the modem programs (VARA,
XARA, Data2G, `ardopcf`), and CMS/RMS Relay endpoints over IP. Modem programs
may optionally be launched and supervised by the backend, but are never
required to be.

**R1.4** The browser is the only user interface. No Electron, no terminal UI as
the primary surface; a small CLI exists for installation, user creation and
diagnostics only.

**R1.5** The station runs as an unprivileged service user. Linux under systemd
is the reference deployment (the unit file ships with the project); macOS and
Windows run the same code, started by whatever service manager the operator
uses — shipped installers for those platforms are not a v1 deliverable, but
nothing in the code may prevent them. Config path, data directory and log
directory are configurable; OS-specific behaviour (paths, service integration,
process signalling) is confined to one small platform module rather than
scattered through the code.

**R1.6** Multi-user from the first schema version, including when exactly one
user exists. There is no "single-user mode" code path to diverge from.

**R1.7** All stored and transmitted timestamps are UTC. The UI may render local
time; nothing is stored in local time.

**R1.8** Ported algorithms keep their attribution: LZHUF (Haruyasu Yoshizaki,
JNOS/F6FBB lineage) and the B2 checksum variant (wl2k-go, MIT). The repository
carries a NOTICE file naming them.

---

## 2. Module 1 — Rig control through rigctld

`rigctld` runs separately, as the requirement states; rfmail contains no rig
driver of its own and opens no serial ports.

**R2.1** Rig control is TCP to `rigctld` (default `localhost:4532`). Address is
per-rig configuration.

**R2.2** Multiple transceivers are configured and stored, each with: id, display
name, `rigctld` address, VFO (`A`, `B`, or current), optional band plan (band
name → frequency range) and default dial frequency per band, optional poll
interval for the frequency readout, and whether this rig may be keyed by rfmail
at all.

**R2.2.1** Each transceiver states **which connector transmits**: the rear input
that a modem feeds, the front microphone connector, or "rear input, falling back
to plain PTT if the rig cannot select it". This is not cosmetic — it is Hamlib's
`RIG_PTT_ON_DATA` (3) against `RIG_PTT_ON` (1), and on a TS-590 `T 1` keys with the
front microphone while `T 3` keys with the rear/USB line — so a station that gets
it wrong transmits silence and the far end hears nothing. The options are named
for the connectors, not for Hamlib's constants. The fallback records that it
happened, because it means the operator should correct the rig's own menu.

**R2.3** Commands used, all newline-terminated ASCII with `RPRT <n>` or extended
`<key>: <value>` responses (both response forms must be parsed):
`\chk_vfo`, `\dump_caps`, `\get_freq`, `\set_freq <Hz>`, `\set_mode <mode>
<passband>`, `t`, `\set_ptt <0|1>`, with the optional VFO prefix form
(`\set_freq VFOA 14070000`).

**R2.4** One connection per rig, commands serialised per rig, per-command
timeout, automatic reconnect on a dead socket, and a failed rig must not block
any other rig or any session on another rig.

**R2.5** PTT: a modem raises and drops PTT itself (VARA `PTT ON`/`PTT OFF`,
ARDOP `PTT <bool>` state); rfmail bridges that to rigctld `\set_ptt` when the
modem configuration says PTT is controlled by the rig. rfmail never keys a rig
that the modem is configured to key, and never keys two rigs for one session.

**R2.6** QSY: a session may carry a dial frequency. Before the session the
frequency is set; after the session the previous frequency is restored. The
restore happens on failure too.

**R2.7** The current dial frequency of each rig is available to the UI and is
recorded with every session.

**R2.8** A rig that is unreachable degrades only the sessions that need it: a
session without frequency control (e.g. telnet CMS) proceeds; a session that
needs QSY or PTT fails with a stated reason, before dialling.

**R2.9** Each configured rig has a test action in the UI that connects, reads
`\dump_caps` and `\get_freq`, and reports the result.

**R2.10** Rig state is not persisted, apart from configuration. "Last used
frequency" is a session attribute read from the session table, not rig state.

---

## 3. Module 2 — Modem interfaces

**R3.0** The settings screen for a modem asks for exactly what the station needs
before a session can find it: a name, the type (ARDOP, VARA HF, VARA FM, XARA,
Data2G, Mercury), the host, the ports, the transceiver it is wired to, and the
transceiver mode while it runs. The three ports are separate fields because they
are different things: the command port every modem has (ARDOP's single TCP host
interface, default 8515), the data port only the modems that split audio from
commands have (VARA and XARA: 8300 and 8301), and the KISS port for packet modems
(Direwolf: 8001). Data2G and Mercury have no vendor defaults recorded here, so the
operator enters them. The transceiver is chosen from those already configured, and
the mode from the rigctld set, with PKTUSB the default on HF and FM on VHF. When a
session's gateway and dial are chosen the screen offers only the modems that can
work that gateway's digital mode: an ARDOP channel takes ARDOP, a VARA channel takes
VARA HF or XARA (both speak VARA's interface), a VARA FM channel takes VARA FM, and
the two VARA-compatible modems reach ARDOP channels as well. (R3.1, R4.4.0)

**R3.1** Modems are configured entries, not hard-coded sections. Each entry:
id, display name, driver kind, addresses and ports, bound rig, default
bandwidth, optional launch command (argv array, working directory, environment),
autostart flag, readiness probe (TCP connect), restart policy, and whether
inbound (P2P) sessions are accepted on it.

**R3.2** Every driver implements one interface: open/close, capability report,
dial(target, options) returning a duplex byte stream, listen(on/off),
disconnect(graceful), abort(immediate), busy state with events, version string,
PTT hook, transmit-buffer length (so transfer progress reflects what the modem
still holds), and close-on-session-end guarantees. A driver that returns from
`dial` has either a working stream or an error, and the modem is idle.

**R3.3** VARA-family driver — the command/data host interface shared by VARA HF,
VARA FM, XARA, Data2G and Mercury:

* Command port carries CR-terminated ASCII lines; the data port carries a raw
  byte stream (defaults 8300 / 8301; VARA FM commonly on the same ports).
* Startup sequence: `PUBLIC ON`, `CWID ON` (HF only), `COMPRESSION TEXT`,
  `MYCALL <call>`, `LISTEN OFF`.
* Bandwidth: `BW500`, `BW2300`, `BW2750` on HF; FM narrow/wide as configured.
* Session type where supported: `WINLINK SESSION` / `P2P SESSION`.
* `CONNECT <mycall> <target>`, `DISCONNECT`, `ABORT`, `VERSION`.
* Asynchronous lines to handle: `PTT ON`, `PTT OFF`, `BUSY ON`, `BUSY OFF`,
  `CONNECTED <src> <dst> [bw]`, `DISCONNECTED`, `BUFFER <n>`, `IAMALIVE`,
  `PENDING`, `CANCELPENDING`, `OK`, `WRONG`, `LINK REGISTERED|UNREGISTERED`,
  `REGISTERED <name>`, `ENCRYPTION …`, `UNENCRYPTED LINK`/`ENCRYPTED LINK`.
  Unknown lines are logged and ignored, never fatal — Data2G extends the
  interface and will emit lines VARA does not.
* The modem is declared dead if nothing arrives for two minutes (`IAMALIVE`
  is sent every 60 s by the specification).

**R3.4** VARA HF, VARA FM, XARA, Data2G and Mercury are one driver with
different configuration and capability flags, not five implementations. A
capability flag decides whether `WINLINK SESSION` is sent (Data2G and XARA
accept VARA's, but the driver must not require it).

**R3.5** ARDOP driver (`ardopcf` and ARDOP-compatible TNCs over TCP):

* Control connection: CR-terminated ASCII commands. Data connection on control
  port + 1 (the interface's "next sequential port" rule): outbound frames are a
  2-byte big-endian length followed by the payload; inbound frames carry a type
  byte first, `d` for data, then the 2-byte length and payload. No CRC over TCP
  (`ardopcf` and ARDOP_Win omit it on the TCP interface).
* Initialisation: `INITIALIZE`, `STATE`, `CODEC TRUE` when offline,
  `PROTOCOLMODE ARQ`, `ARQTIMEOUT`, `LISTEN FALSE`, `MYCALL <call>`,
  `GRIDSQUARE <locator>`.
* Per-session: `ARQBW <200|500|1000|2000>[MAX|FORCED]`, `CWID <bool>`,
  `ARQCALL <target> <repeats>`, `DISCONNECT`, `ABORT`.
* Asynchronous events: `NEWSTATE <state>`, `CONNECTED <call> <bw>`,
  `DISCONNECTED`, `BUFFER <n>`, `PTT <bool>`, `BUSY <bool>`, `FAULT <text>`,
  `VERSION <text>`, `PENDING`, `CANCELPENDING`, `TARGET <call>`,
  `INPUTPEAKS <…>`. `FAULT` is surfaced to the session and the UI; it is never
  swallowed.
* Connect attempts are configurable (default 10, as in the ARDOP host
  interface) and exposed per modem.

**R3.6** Telnet driver: plain TCP to a B2F peer over IP. Used for the CMS
(`server.winlink.org:8772`, target `wl2k`, login prompt answered with the
callsign and password `CMSTelnet`), for an RMS Relay, and for P2P on 8774. The
login exchange is answered only when the peer actually prompts
(`Callsign:`, `Password:`); no login is attempted against a peer that starts
the B2F handshake directly.

**R3.7** Launch and supervision, when configured: spawn with an argv array (no
shell string), captured stdout/stderr into a bounded per-modem ring buffer
visible in the UI, readiness probe before first use, `SIGTERM` then a timeout
then `SIGKILL` on stop, restart with backoff, and a state machine
(stopped/starting/ready/failed) reflected in the API. A modem that rfmail did
not launch is left alone when rfmail stops.

**R3.8** Busy channel: when the modem reports busy, the configured policy
decides between waiting with a prompt (timeout aborts) and aborting. Transmit
never starts while the modem reports busy under a wait policy.

**R3.9** Cancellation: aborting during dial cancels the dial and leaves the
modem idle; aborting during a session closes the stream and then disconnects
the modem, graceful first, hard on request. After any abort the modem must be
reusable without a restart.

**R3.10** Inbound sessions: listening can be enabled per modem. Incoming
sessions are surfaced in the UI with the peer callsign, and are either
accepted by policy or refused and disconnected.

**R3.11** Capabilities (bandwidths, P2P support, PTT support, needs locator,
data port) are reported to the UI so forms show only valid choices.

**R3.12** AX.25 (Linux/AX.25, AGWPE, serial TNC), PACTOR (SCS), WINMOR and
Robust Packet are out of scope for v1. The driver interface must not presuppose
TCP so they can be added without redesign.

---

## 4. Module 3 — FBB + Open B2F, client and server

### 4.1 Message structure

**R4.1.1** A message is: header lines (ASCII, CRLF), a blank line, the body
whose exact byte length is in the `Body:` header, then a CRLF, then each
attachment as exactly `File: <size> <name>` bytes followed by CRLF, in header
order.

**R4.1.2** Headers: `Mid:` written first, then the rest in stable sorted order
for reproducibility; `Date`, `From`, `To` (repeatable), `Cc` (repeatable),
`Subject`, `Type`, `Mbo`, `Body`, `File` (repeatable, repeatable per
attachment), `Content-Type`, `Content-Transfer-Encoding`. Message types:
`Private`, `Service`, `Inquiry`, `Position Report`, `Option`, `System`.

**R4.1.3** `Date:` is `YYYY/MM/DD HH:MM` in UTC. On input, the legacy layouts
seen in the field are accepted: `YYYY.MM.DD HH:MM`, `YYYY-MM-DD HH:MM`,
`YYYYMMDDHHMMSS`, and RFC 5322 forms with optional seconds/zone.

**R4.1.4** Body charset defaults to ISO-8859-1 (what RMS Express emits), is
declared in `Content-Type`, and is converted to UTF-8 at the storage boundary.
Body lines are CRLF-terminated and wrapped before 1000 characters including the
CRLF. Subjects and attachment filenames are RFC 2047 Q-encoded on the wire and
decoded on read, with the ISO-8859-1 fallback for unencoded non-UTF-8 bytes.

**R4.1.5** Validation before a message may be proposed: MID present and ≤ 12
characters, at least one recipient, non-empty `From`, non-empty body, subject
present and ≤ 128 characters, attachment name ≤ 255 characters. A message that
fails validation is refused locally and never offered, with the offending field
named.

**R4.1.6** MID generation: MD5 over a payload of the current time in nanoseconds
plus the callsign, base32-encoded and truncated to 12 characters. Only
uniqueness matters on the wire — the format is not interpreted by peers — but
the generation must avoid collisions when two messages are created in the same
second by the same station.

### 4.2 Proposals, compression, blocks

**R4.2.1** A proposal is `F<code> <type> <mid> <size> <compressed-size> 0`
followed by `F> <checksum>` for the block, at most 5 proposals per block. Code
`C` is a Winlink (LZHUF-compressed) message, `D` is gzip; `B`/`A` are the legacy
basic/ASCII levels, which are deferred rather than used, because they cannot
carry attachments or multiple recipients. Answers are `FS <chars>`, one
character per proposal, with `+`/`Y` accept, `-`/`N`/`R` reject, `=`/`L`/`H`
defer, and `A`/`!` accept-at-offset (offset up to 999999; a larger requested
offset is ignored and the transfer restarts, as the protocol's six-digit limit
requires). An answer line with more characters than there were proposals, or an
unknown character, is a protocol error and fails the exchange rather than being
guessed at. The proposal title is the subject, RFC 2047 Q-encoded to ASCII, at
most 80 bytes, with an empty title sent as `No title`.

**R4.2.2** LZHUF compression in the B2 variant: the compressed stream is
preceded by a CRC-16 (the XMODEM CRC-CCITT variant used by Airmail/Winlink)
computed over the 4-byte little-endian uncompressed size followed by the
compressed bytes; the size is then written little-endian ahead of the data.
Reader and writer both implement this.

**R4.2.3** gzip proposals (`FD`) use standard gzip. The SID advertises `G` when
gzip proposals will be sent; inbound gzip proposals are always accepted.

**R4.2.4** Message data blocks are framed as `SOH`, one header length byte, the
title, NUL, the offset as decimal ASCII, NUL, then `STX`, one length byte and
that many payload bytes (a length byte of 0 means 256; rfmail sends 125-byte
blocks), repeated, then `EOT` and one checksum byte over all payload bytes. A
block length mismatch, a bad checksum, or an unexpected first byte fails the
transfer with a stated reason, leaving the session's other messages unaffected.

### 4.3 Session

**R4.3.1** Handshake: SID in brackets; the remote SID must contain `B2` or the
session fails with "remote does not support B2 forwarding"; `;FW:` lists the
addresses the remote accepts mail for (rfmail requests mail for its own
callsign and for every configured auxiliary address); `;PQ <challenge>` is
answered with `;PR <response>`; `;PM:` carries pending-message details used to
show sender/subject/size before download; a line ending in `>` is the prompt.
The SID is parsed by taking everything after the last `-` inside the brackets,
so the station name and version in our own SID must contain no dash.

**R4.3.2** Secure login: the response is derived exactly as the reference
implementations do it — MD5 over `challenge ++ password ++ salt` with the
published 64-byte Winlink salt (copied as bytes, never retyped from prose), then
the 31-bit value `((s[3] & 0x3F) << 24) | (s[2] << 16) | (s[1] << 8) | s[0]`
printed as 8 zero-padded decimal digits (the mask guarantees no sign). Anything
looser — "the first bytes as a decimal" — produces a plausible-looking token that
fails every login. Auxiliary addresses may carry their own passwords, appended to
their `;FW:` entry as `CALL|response` computed from the same challenge; an
auxiliary address without a password is requested without one. A login failure is
reported as a login failure, with the note that passwords created before
2018-01-31 are upper-case only, since that is the usual cause.

**R4.3.3** Session turn: rfmail answers `FF` (more messages) or `FQ` (quit), and
treats `FF`/`FQ` from the remote symmetrically. Lines beginning `;` are
comments and ignored; lines beginning `*` are remote errors and are surfaced as
errors except during the handshake, where they are logged and ignored (gateways
send statistics lines prefixed with `***`).

**R4.3.4** Message ordering: proposals are sorted by precedence before sending
(`//WL2K Z/` flash, `O/` immediate, `P/` priority, routine otherwise) so
priority mail leaves in the first block.

**R4.3.5** A session is a state machine over a byte stream with explicit
states, timeouts and a per-session protocol log recording both directions.

**R4.3.6** Robust-mode (reduced throughput for poor links) is applied when the
transport supports it and the session requests it; otherwise ignored.

### 4.4 Roles the backend can play

These are configuration choices, not separate programs. Only one is active per
connection, and the post office and the gateway relay may both be enabled on
different modems.

**R4.4.0 Choosing a target.** Before a radio session exists, the operator picks
the digital mode (ARDOP, VARA HF, VARA FM, XARA, Data2G, Mercury) and the band;
those two decide which gateways are even possible. The session itself then needs
exactly three things: the gateway callsign, the dial frequency in hertz, and
that mode — the mode dropdown is the same control the session uses, not a second
one beside it. The gateway list comes from the Winlink catalogue
(`api.winlink.org/gateway/status.json`, POST form parameters with the public
client key), is cached on disk beside the database
and refreshed at most every six hours or on request, and may be ordered by
distance from the account's WW-Locator (its Maidenhead grid square, set on the
Account page or by an administrator when the account is created) or by an estimated quality. Choosing a
row fills the three fields. A modem reaches the catalogue mode families it can
actually work: ARDOP those channels, VARA HF and XARA the VARA ones, VARA FM the
FM ones, and Data2G and Mercury the VARA and ARDOP ones — the catalogue names
neither, so the screen says so rather than inventing entries. The distance is a
fact computed from grid squares; the "estimated quality" is a rough order built
from band-versus-distance plausibility, how recently the gateway reported in,
and whether it is open now, and the screen must label it as an estimate until
VOACAP replaces it (R5.x).

**R4.4.05 Connect test.** Until the FBB exchange exists, "Start session" performs a
connect test rather than a session. It first tunes the transceiver to the chosen
dial and the modem's mode through rigctld — refusing outright when that link is
not up, because keying a transmitter on whatever frequency it happened to hold is
not acceptable — then opens the modem's command port, dials the gateway with the
account's own callsign, watches the dialect's answers, and hangs up again. Two
dialects cover the modems the station knows: ARDOP (`MYCALL`, `ARQBW <bw>MAX`,
`ARQCALL <target> <repeats>`) and the VARA-shaped interface (`CONNECT <my> <target>
<bw>`) used by VARA HF, VARA FM, XARA and the Data2G and Mercury builds that speak
it. The bandwidth comes from the chosen channel's mode. The report is one of
connected, failed (no answer, or the frequency was busy) or error (the modem could
not be reached or reported a fault), with the modem's own lines kept for the
record. No mail is exchanged and nothing is left connected. (R4.4.0, R3.2)

**R4.4.1 Client session.** A user's own callsign dials a CMS (telnet), an RMS
over radio, or a P2P peer. Outbound messages from that user's outbox for the
remote's forwarder list are proposed; inbound messages are stored for that
user. This is the pat-equivalent behaviour.

**R4.4.1.1 Three kinds of far end.** The client session is one exchange with one
parameter, the peer's kind, because that parameter is the only thing the
protocol asks before the first message:

* `cms` — a Winlink RMS gateway or the CMS. `;FW:` names this callsign and every
  auxiliary address, because a CMS routes for the whole system; every outbox
  message may be offered. A `;PQ` challenge is answered, and having no Winlink
  password ends the session before the greeting goes out: the password is what
  decides who may collect the mail.
* `p2p` — another operator's station. `;FW:` names this callsign alone, and only
  messages addressed to that station are proposed, because a peer cannot route
  for anybody else. A `;PQ` challenge from a peer is answered if a password
  happens to be set and otherwise recorded and passed over: no authority holds
  the peer's password, so there is nothing for the challenge to establish and the
  session runs unauthenticated. An HF VARA modem is dialled with `P2P SESSION`
  instead of `WINLINK SESSION`.
* `postoffice` — a B2F server that terminates sessions and holds mail (our own
  post office, or an FBB-style BBS). It may hold mail for several of our
  addresses, so `;FW:` names them all, and it may hold mail for its own users,
  so anything its `;FW:` list accepts may be offered. It holds accounts, so it can
  challenge and check, exactly as a CMS does; an unanswered challenge is refused,
  as at a CMS, because a server that asks must not be served by a station that
  cannot say who it is.

**R4.4.1.2 The channel is not ours to take.** `BUSY ON` from the modem means it hears
a real signal in the channel, and it is a hint, not a verdict: the same modem sends it
a fraction of a second before `CONNECTED` on a call that comes up. The shape decides.
One unbroken stretch of about four seconds, with no more than a handful of on/off
transitions around it, is a data station, and the call is abandoned and reported rather
than transmitted into. Short irregular stretches — syllables of a voice — are dialled
through. The thresholds are a heuristic and say so. Note that Data2G 0.5.3 reports
nothing while merely listening (`LISTEN ON` for eight seconds produced no `BUSY` line),
so the first connect frame may still go out before the modem knows the channel is
occupied; what is preventable is the rest of the call, not the first frame.

**R4.4.1.2.1 The modem may own the transceiver.** Measured with Data2G 0.5.3: it connects
to rigctld by itself (whatever its "use rig control" box says), keys through it — `\set_ptt 3`
for the rear input first, falling back to `1` — and also changes the receiver's filter,
leaving a 1000 Hz passband where the station had 2000. A session therefore must not assume
that the mode and passband it set are still in force when the exchange runs, and the
operator must be told when the modem has narrowed the filter, because a 2300 Hz waveform
through a 1 kHz filter is inaudible to the decoder.

**R4.4.1.3 Hang-up is not DISCONNECT.** After `DISCONNECT` the modem goes on keying —
measured at eight seconds — and both stations send an identification frame before the
air goes quiet. A session's link is closed when the modem has said `DISCONNECTED` and
then been quiet for a few seconds; the hard ceiling closes it regardless, because a
station must never be left holding a transmitter.

The exchange itself is identical in all three: same SID, same turns, same
compression and offsets. Only `;FW:`, the password rule, the modem's session
type and the choice of what to propose differ. Note that `;PQ`/`;PR` is all the
authentication B2F has — an MD5 of the challenge, password and salt — and it
only means anything where the challenger holds the password: a CMS, or a post
office. Two peer stations can use the same arithmetic only with a pre-shared
key, and that is not implemented.

**R4.4.2 Gateway relay.** An inbound RF B2F session from a user's station is
piped to a CMS connection (or to a configured RMS Relay) so that the CMS sees
the user's callsign and secure login end to end. The relay does not interpret,
rewrite or terminate the B2F stream; it copies both directions, enforces an
access policy (default: deny unless the callsign is in the gateway's allow list
or the policy is explicitly "any"), tears both ends down together, and logs both
directions verbatim, `;PR` included — it is a hash of the nonce and the password, not
the password, and it is what makes a refused login diagnosable. The station has its own
gateway callsign with an SSID and its own Winlink password — the registration
and credentials an RMS gateway operator obtains from the Winlink Development
Team, used for the station's own forwarding sessions and not for the relayed
user's login. rfmail refuses to enable gateway mode without a gateway callsign,
its password, and an explicitly recorded acknowledgement that the station is
registered.

**R4.4.3 Post office.** An inbound RF B2F session is terminated locally: inbound
messages are stored for the addressed local callsign, outbound messages for the
connecting callsign are offered from the database. Proposals for a MID already
stored for that user are rejected (that is what makes reconnects harmless).
Mail for a callsign that no user owns is refused or held per configured policy.

**R4.4.4 Forwarding.** For a user account configured to fetch automatically, the
backend opens sessions on the user's behalf (typically to a CMS over telnet, or
to a configured RMS) when the user is not connected, on a schedule and on
demand. Mail leaving this way uses the user's callsign and secure login.

**R4.4.5 Store and forward.** When the CMS or RMS Relay is unreachable, outbound
mail stays queued with attempt counts and a next-attempt time; queued mail is
flushed before new inbound work when connectivity returns. Nothing is dropped
and nothing is reported sent until the remote accepted the proposal.

### 4.5 Concurrency and scheduling

**R4.5.1** Several sessions may run at once on different modems, including
telnet; one modem carries at most one session at a time.

**R4.5.2** A session request queue: requests come from the UI (a user connecting),
from the forwarder (automatic fetch), and from inbound sessions. Priority is
inbound > interactive > automatic. A queued request is visible in the UI with
its state and can be cancelled before it starts.

**R4.5.3** Aborting a session closes the B2F exchange at a protocol boundary if
possible (the remote may then finish its turn), and force-closes otherwise.

### 4.6 Channel catalogue and manual targets

**R4.6.1** Two ways to name a session target, both available in v1:

* **Catalogue**: the Winlink gateway status JSON
  (`api.winlink.org/gateway/status.json`) is downloaded and cached — per gateway
  the callsign, grid square, mode list, frequency and service code; from it,
  per-channel distance and azimuth from the configured locator, filtered by mode
  and band, and sorted so a plausible target is easy to pick.
* **Manual entry**: a target typed as callsign, as a `host:port` endpoint, or as
  a P2P address, for nodes that are not in the catalogue — an operator's own
  gateway, a station operated under a special event callsign, a private RMS
  Relay. Manual entry is a first-class path, not a fallback that bypasses the
  session machinery.

A session profile may hold either form. The catalogue is refreshed on demand and
on a configurable interval; an empty or unavailable catalogue never prevents a
manual session.

---

## 5. Module 4 — Mail storage

**R5.1** The database is chosen at installation time: SQLite (default), MariaDB,
or PostgreSQL. All three sit behind one storage interface, with identical
observable semantics. SQLite uses Node's built-in driver; MariaDB and
PostgreSQL use pure-JS drivers (R1.2).

**R5.2** Schema migrations are versioned, forward-only, applied at startup under
a lock, with per-dialect DDL. A database from a newer schema version is refused
rather than half-used.

**R5.3** Users: unique login name, password hash (scrypt with per-user salt),
role (admin or user), enabled flag, quota, created/updated timestamps, and a
list of owned callsigns. Administration is by role, not by configuration file.
An account may exist without a password at all — the first-run account does —
which is stored as a null hash: an empty password authenticates then, and the
moment a password is set, an empty one stops working everywhere (web client and
POP3 alike).

**R5.4** Callsign ownership: a callsign belongs to exactly one user; mail
addressed to it is routed to that user. A user may own several callsigns (base
call plus SSIDs). The station's own gateway callsign is not a user mailbox. The
schema enforces the uniqueness.

**R5.5** Folders: INBOX, OUTBOX (queued for RF delivery), SENT, ARCHIVE, plus
user-created folders. Each folder carries `uidvalidity` and `uidnext`, and each
message a monotonically increasing `uid` within its folder, so IMAP clients keep
stable references across restarts.

**R5.6** Stored per message: MID, direction, peer, From, To/Cc (structured), Date
(from the message), received timestamp, subject, body (UTF-8, original charset
recorded), size, headers as sent, flags (unread, flagged, answered, deleted),
folder, UID. Attachments are stored in the database as binary blobs with
filename, size and content type.

**R5.7** Attachment and message size limits are configuration with defaults (10 MB
per message total, 255 characters per filename); an oversized inbound message is
rejected at proposal time, not after transfer.

**R5.8** Deduplication is by `(user, mid)`, enforced by a unique constraint, and
is what the post office uses to reject re-proposals.

**R5.9** Outbox state machine per message: queued → proposed → (sent | deferred
with next attempt | failed with error and attempt count). A message that a
remote rejected as already received is marked sent with that reason recorded.

**R5.10** Conversion both ways between the B2F message structure and RFC 822
(MIME multipart for attachments, RFC 2047 headers, `Message-ID` synthesised from
the MID, MID preserved in `X-Winlink-MID`), so that POP3/IMAP clients and SMTP
submission see ordinary internet mail while the B2F identity survives.

**R5.11** Search by subject, sender, recipient, body text, date range and flags.
Implemented portably (indexed columns plus substring matching); a native
full-text index is an optional per-dialect improvement, not a requirement.

**R5.12** A received message and the outbox transitions for the same session are
committed in transactions per message: an interrupted session leaves either the
whole message or none of it, never a partial row.

**R5.13** Export without database tools: per-user export of messages as RFC 822
files with attachments and a manifest, and import of the same, so mail is not
hostage to the database.

**R5.14** Retention and quota are configuration. Quota exhaustion refuses new
inbound proposals (telling the remote to defer) rather than silently deleting.

---

## 6. Module 5 — Mail access: POP3/IMAP + SMTP

**R6.1** SMTP submission (RFC 5321) for the user's own mail client: `EHLO`,
`AUTH PLAIN`/`LOGIN` against the user store, `MAIL FROM`, `RCPT TO`, `DATA`,
`SIZE`, `8BITMIME`, plus `HELP`, `NOOP`, `RSET`, `QUIT`, `VRFY` (refused as
policy requires). Accepted mail is inserted into the authenticated user's OUTBOX
after B2F validation (R4.1.5), and refused with a correct permanent or temporary
code otherwise. Only authenticated submission is accepted; no relaying for
foreign destinations, and `MAIL FROM` must be one of the user's own addresses.

**R6.2** POP3 (RFC 1939): `USER`/`PASS`, `STAT`, `LIST`, `UIDL`, `RETR`, `TOP`,
`DELE`, `RSET`, `NOOP`, `CAPA`, `QUIT`, with maildrop lock and deletion only on
`QUIT`. UIDL is the message UID, so a client that leaves mail on the server does
not re-download it. POP3 serves INBOX only; deleted messages are removed on
`QUIT`, while the web client's delete moves to TRASH instead. An account with no
password authenticates with an empty `PASS` (R5.3).

**R6.3** IMAP4rev1 subset sufficient for current clients: `CAPABILITY`,
`LOGIN`, `SELECT`/`EXAMINE`, `LIST`/`LSUB`, `STATUS`, `FETCH` (`FLAGS`,
`RFC822.SIZE`, `BODY[]`/`BODY.PEEK[]`, `ENVELOPE`, `BODYSTRUCTURE`),
`UID FETCH`/`UID STORE`/`UID SEARCH`/`UID COPY`, `STORE` (flags), `SEARCH`,
`APPEND`, `EXPUNGE`, `CLOSE`, `LOGOUT`, `IDLE`. Mailbox names map onto the
folder table, with `INBOX` case-insensitive.

**R6.4** Access control, two named modes, exactly as specified:

* **very strict** — listen on loopback only (`127.0.0.1` and `::1`), and refuse
  any peer that is not loopback, at accept time.
* **strict** — listen on configured addresses and accept only peers inside
  configured CIDRs (default: the interface's own subnet); every other peer is
  refused at accept time and the refusal is logged.

The mode is backend configuration, applied when the mail servers start, and
changeable between server sessions. There is no third mode and no per-service
exception: SMTP, POP3 and IMAP share the same peer policy.

**R6.5** No anonymous access of any kind. No open relay. Failed authentication is
rate-limited per peer, and the refusal does not disclose whether the account
exists.

**R6.6** TLS applies to SMTP, POP3 and IMAP and is a per-service choice of off,
STARTTLS, or implicit TLS, with certificate and key paths in configuration. When
the peer is not loopback, plaintext `AUTH` and plaintext `PASS` are refused
unless explicitly permitted in configuration; the UI shows the current setting
and its consequence. The web UI has its own TLS setting of the same shape,
separate from the mail services: plaintext is the default on loopback, and
binding the UI to a LAN address without TLS is allowed but flagged in the UI and
the startup log, because the admin session cookie then travels in clear.

**R6.7** Ports and bind addresses are configuration (the standard 25/110/143, or
587/995/993). The generated configuration uses unprivileged ports — POP3 on
1110 — because binding 110 needs privileges (root or `setcap`); the standard
ports stay available to an operator who grants that. A bind outside the access
mode's scope is refused at startup rather than narrowed silently.

**R6.8** The mail servers run in the same process as the RF side but are
independent of it: reading mail never blocks a session, and a session never
blocks a mail client. A long `FETCH` of a large attachment streams rather than
buffering the whole mailbox.

---

## 7. Module 6 — Frontend: configuration and administration

**R7.1** The backend serves the built single-page application and an HTTP API
under `/api`, plus one WebSocket (`/ws`) carrying typed events: `status`,
`session.progress`, `session.log`, `prompt`, `mailbox.changed`, `modem.state`,
`rig.state`, `error`, `notification`. The API is described by an OpenAPI
document generated from the code, and the frontend's client types are generated
from that document — one client module, no hand-written duplicate of the API
surface.

**R7.2** Authentication: sign-in form, server-side session cookie (HttpOnly,
SameSite=Strict, Secure under TLS), CSRF nonce on every state-changing request.
The first account is created by the CLI, or by the first-run form, which exists
only while no account exists at all and answers 409 afterwards. The browser
remembers the account name in `localStorage` so a restart prefills the sign-in;
the name is a convenience, never a credential. Every account may configure and
operate the station's radios, modems and sessions; the admin role is needed only
to administer other accounts (decision 14).

**R7.3** Configuration surfaces, each a form with validation and an explicit save:

1. **Server** — listen address/port, TLS, API access mode (loopback or LAN with
   CIDRs), data/log paths (read-only where they are fixed at install),
   database backend and connection status (read-only: it was chosen at
   installation).
2. **Users** — list, create, edit, disable, delete; roles; quota; owned
   callsigns; per-callsign Winlink secure-login password and auxiliary addresses
   with their own passwords; password reset.
3. **Transceivers** — the rig registry of R2.2, with a test action and live
   frequency.
4. **Modems** — the modem registry of R3.1, with kind-specific fields that
   change with the selected driver, capability-driven choices (R3.11), start/
   stop, state, and the tail of the modem's own output.
5. **Winlink** — station callsign and locator, MOTD lines, auxiliary addresses,
   CMS endpoints, per-account automatic-fetch policy, P2P listen policy, and the
   gateway role: gateway callsign with SSID, gateway password, relay on/off per
   modem, access policy, and post office on/off with unknown-recipient policy.
6. **Session profiles** — named combinations of rig, modem, target (callsign,
   alias, or CMS), bandwidth and dial frequency, so a user picks a profile
   rather than assembling parameters.

**R7.4** Every configuration write is validated against a schema and against live
facts where cheap (TCP reachability, callsign syntax, unique names) before it
is persisted; the write is atomic, and a config that fails reload leaves the
previous one running.

**R7.5** Changes that require a restart are identified as such in the UI, with
the reason; everything else reloads in place. Configuration is never lost by a
failed reload.

**R7.6** Live operation: current session with peer, transport, rig frequency,
bytes and rate; the session protocol log streaming with filters and secrets
redacted; an abort control; and the prompt surface for the interactions that
cannot be automatic — busy channel, secure login password challenge, selecting
which messages to download when they exceed the size limit (with sender,
subject, size), and the new-account-password warning.

**R7.7** Administration views: session history with statistics and per-session
log download; audit trail of configuration changes (who, what, when, old and new
value); storage usage per user.

**R7.8** The UI is keyboard navigable, readable on a phone, and works offline
from the LAN: no CDN fonts, scripts or styles. Light and dark themes.

**R7.9** The operator never needs a Node toolchain: the frontend is built in CI
and shipped as static assets served by the backend.

---

## 8. Module 7 — Mail client GUI

**R8.1** Three-pane layout: folders (unread counts), message list (date, from,
subject, size; sortable; unread and flagged distinct), and reader with a
sanitised body and an attachment list with download.

**R8.2** Compose: To/Cc, subject, body, attachments, precedence (`//WL2K Z/`,
`O/`, `P/` prefix in the subject), P2P-only flag, draft autosave, and two send
actions: queue to OUTBOX, or queue and start a session now. Validation mirrors
R4.1.5 client-side, with the server as authority.

**R8.3** Bodies render as plain text by default; HTML bodies are sanitised
(scripts, frames, forms and event handlers removed), and remote images are
blocked until the reader asks for them.

**R8.4** Message operations: read/unread, flag, move between folders, delete,
reply, forward with quoted body, save attachment, download the raw `.b2f`.

**R8.5** Session control from the mail screen: choose a profile, connect, watch
progress, cancel; target selectable from the cached channel list or typed
manually.

**R8.6** Notifications: in-app and browser notifications for mail that arrives
during a live session.

**R8.7** Multi-user isolation: a user sees only their own mail, folders, quota and
sessions. Admin accounts manage users and configuration and see session
metadata, but do not read other users' message bodies — a postmaster who needs
that has to be given the mailbox, not the role.

---

## 9. Cross-cutting requirements

**R9.1** Secrets: `;PR` responses, passwords and gateway credentials never appear
in the protocol log, the application log, or the UI. Winlink passwords are stored
encrypted with a key held in the config file (mode 0600), not in plaintext.
User passwords are scrypt hashes.

**R9.2** Untrusted input: attachment filenames are sanitised for download, paths
are confined to the data directory, request body sizes are capped, and HTML mail
is sanitised server-side as well as client-side.

**R9.3** Limits: maximum concurrent sessions, maximum concurrent API connections,
per-session message size, modem buffer threshold for pacing, and a bounded log
ring per modem and per session.

**R9.4** Observability: structured JSON application log with levels and rotation;
per-session logs; a `/health` endpoint reporting database, modems and rigs; and a
Prometheus-format metrics endpoint (optional, off by default) for session counts,
bytes, queue depth and error counters.

**R9.5** Reliability: a modem, rig or peer failure never terminates the process;
unhandled promise rejections are handled and logged; shutdown closes sessions,
modems, rigs and the database cleanly, and refuses new sessions first.

**R9.6** Testability without hardware: every protocol engine (B2F, LZHUF, ARDOP
host interface, VARA host interface, rigctld client, POP3/IMAP/SMTP) is exercised
against an in-process scripted peer in the test suite.

**R9.7** Performance targets, measured on the reference host: mailbox listing of
1,000 messages under 100 ms at p95 on SQLite; API responses under 50 ms at p95
excluding database and network outliers; no polling loop faster than once per
second; session throughput bounded by the modem, not by our buffering (streaming
with backpressure throughout).

**R9.8** Internationalisation of the UI is out of scope for v1; message charsets
(R4.1.4) are not.

---

## 10. Out of scope for v1

Named so that their absence is a decision, not an oversight:

* AX.25 (Linux, AGWPE, serial TNC), PACTOR, WINMOR and Robust Packet transports.
* Winlink standard forms (ICS-213 and the rest) and template editing.
* Position reports, GPSd integration, Maidenhead/geodesy beyond the channel
  catalogue, and VOACAP propagation prediction.
* Winlink account creation and password recovery through the CMS web API;
  version reporting to the CMS.
* Import of pat's configuration or mailbox directories (an import tool is a
  later, separate deliverable).
* Winlink Hybrid Network HF forwarding between gateways and to MPS stations.
* Traffic encryption — prohibited on amateur frequencies and absent from B2F.
* Shipped installers and service integrations for macOS and Windows (portability
  is required by R1.2; packaging for those platforms is not a v1 deliverable),
  and container images beyond a documented Dockerfile sketch.

---

## 11. Acceptance criteria

Each module is done when these statements are true and demonstrated, not
asserted.

**Module 1 (rig control).** Two rigctld instances, two rigs, both read frequency
and both key PTT; unplugging one leaves the other usable; QSY sets and restores
frequency across a session including a failed session; a rig with an invalid
address produces a stated error before dialling, not a hang.

**Module 2 (modems).** With a scripted VARA-shaped peer and a scripted ARDOP
peer, a dial completes, data flows both ways, a busy channel waits and then
proceeds, an abort during dial leaves the modem idle, and a second dial
succeeds. Unknown asynchronous lines do not break a session. A supervised modem
process is started, is probed, is stopped with SIGTERM, and its output appears in
the UI.

**Module 3 (B2F).** Round-trip against a scripted B2F peer: proposals with
correct checksum, up to five per block, both compression codes, a 125-byte
blocked transfer of a 200 KB message, offset request handling, `;PM` display
data, secure login against a known challenge/response vector, deferred and
rejected proposals reflected in the outbox. A live session against the CMS over
telnet (behind an explicit opt-in flag) completes a real exchange. A session to a
manually entered target that is not in the channel catalogue runs through the
same path as a catalogue-selected one. As gateway, a scripted user session is
relayed to a scripted CMS and both directions match byte for byte; as post
office, a message received over RF is visible to the user and answerable by a
later session.

**Module 4 (storage).** The same test suite passes on SQLite, MariaDB and
PostgreSQL. Killing the process mid-session leaves no partial message and no
message marked sent that was not. Two users' mail never mixes, including when
both own SSIDs of the same base call. IMAP and POP3 see the same message with the
same UID after a restart.

**Module 5 (mail access).** A real mail client (Thunderbird and one mobile
client) authenticates, lists, reads, sends, and appends to a folder. In *very
strict* mode the same client is refused from another host on the LAN and
accepted on loopback; in *strict* mode it is accepted from a configured CIDR and
refused from outside it, with the refusal logged. No relay is possible from an
unauthenticated connection.

**Module 6 (configuration UI).** Every configured item in R7.3 is create/edit/
delete in the UI, survives a backend restart, and is rejected with a field-level
message when invalid. An invalid config cannot be saved. Prompt handling works
from a phone with the session running on the backend.

**Module 7 (mail GUI).** A user with no shell access composes, sends over a
session they start from the UI, reads the reply when it arrives, downloads an
attachment, and never sees another user's mail.

---

## 12. Decisions

Settled 2026-11-24. Kept numbered so later work can cite them ("per decision 7").

1. **Frontend**: SvelteKit with a static SPA build, served by the backend. No
   SSR, no second server. (R7.1, R7.9)
2. **Config format**: TOML, so the operator can comment and hand-edit the file
   the UI also writes. Secrets live in that file with mode 0600; users live in
   the database. (R7.4, R9.1)
3. **Mail access**: SMTP submission, POP3 and IMAP4rev1 in the first release, as
   one deliverable. (R6.1–R6.3)
4. **Administration**: an admin manages users, configuration and session
   metadata but cannot read other users' message bodies; a postmaster who needs
   the mail is given the mailbox, not the role. (R8.7)
5. **Gateway mode in v1**: both the relay to CMS and the post office, as
   separate switches. (R4.4.2, R4.4.3)
6. **Session trigger**: users request a session from the GUI and it enters a
   priority queue (inbound > interactive > automatic), with the sysop able to
   run and cancel sessions too. (R4.5.2)
7. **TLS**: optional, for the mail servers (SMTP/POP3/IMAP) and separately for
   the web UI; plaintext `AUTH`/`PASS` is refused from non-loopback peers unless
   explicitly permitted, and a LAN-bound UI without TLS is flagged but allowed.
   (R6.6)
8. **Targets**: both — the cached Winlink channel catalogue and first-class
   manual entry by callsign, `host:port` or P2P address, for nodes that are not
   in the official list. (R4.6.1)
9. **Compiled code**: dependencies that ship compiled code are acceptable, but
   portability is a requirement — the app must run on Linux, macOS and Windows
   from the same source, the default install must need no compiler, and any
   compiled dependency must ship prebuilt binaries or a documented build path.
   Platform-independent (JavaScript or WebAssembly) implementations are
   preferred where realistic. SQLite therefore stays on Node's built-in driver,
   with a `better-sqlite3` adapter only as an optional alternative. (R1.2)
10. **First-run account**: created in the web client at the first start, with no
    password; the account name is remembered in the browser's `localStorage`.
    Until a password is set, the sign-in and POP3 both accept an empty password;
    once one is set, both require it. (R5.3, R6.2, R7.2)
11. **Delivery order**: the mail store, the web client and POP3 come first;
    SMTP, IMAP, the MariaDB and PostgreSQL adapters, rig control, the modem
    drivers, the B2F engine and the gateway roles follow in later steps.
12. **Address form**: a Winlink address is a bare callsign (`OK4RM`) everywhere
    the station itself keeps or shows it — the database, the B2F proposal, a
    gateway's mailbox match, and the web GUI. The domain is added only where a
    *mail program* is being served: IMAP (`ENVELOPE`, `BODY[]`, `SEARCH`), POP3
    and the `.eml` download show `OK4RM@winlink.org`; SMTP submission accepts it
    and strips it again. An address with any other domain is internet mail and
    passes through unchanged, display name included. Search matches either form.
    (R4.1, R6.1–R6.3)
13. **One callsign per account**: a Winlink client session has exactly one
    originator callsign, so the callsign belongs to the account rather than a
    list on it, and it is unique across accounts — a second callsign is a second
    mailbox, not an alias. The account's Winlink secure-login password is the
    password registered for that callsign and is replaced (not carried over)
    when the callsign changes. Further addresses that should receive mail are
    *auxiliary addresses* (R7.3.5), a different concept, and are not session
    originators. (R7.3.2, R9.1)
14. **No operator class**: every account may configure and operate the station's
    own hardware — transceivers, modems, session profiles — because in a personal
    station there is no separate administrator to do it for the user. The expected
    deployment is one account, or two or three where a club or expedition callsign
    needs its own mailbox (one callsign is one account, decision 13). The `admin`
    role therefore means only "this account may create and administer the *other*
    accounts"; it gates no radio, session or connection action, and the UI does not
    display it. A post-office deployment still needs that one restriction, which is
    why the role is kept rather than removed. (R7.2, R7.3, R8.7)
15. **Facts and estimates are labelled apart**: distance to a gateway is computed
    from grid squares and shown as a number; the ordering called "estimated
    quality" is a heuristic over band-versus-distance, gateway recency and
    opening hours, and is named as an estimate in the UI and in the requirements
    until VOACAP supplies a real prediction. The gateway list is the Winlink
    catalogue, cached on disk. (R4.4.0)
16. **Service codes are access classes**: `PUBLIC` is a station open to everyone,
    `EMCOMM` one open for emergency traffic only — 128 channels carry it, and none
    of them may be offered for routine mail. They are fetched with the rest so
    asking costs no second download, but listed only when the operator ticks the
    emergency box, which starts unticked. Some gateways also list a channel under
    `XARA`, `MERCURY` or `DATA2G` to advertise it for one of the newer modems; such a
    channel's mode string is ordinary VARA, so it belongs to that modem alone and
    must be marked as tagged in the list. (R4.4.0, R3.0)
