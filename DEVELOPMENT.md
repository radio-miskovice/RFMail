# rfmail — Development plan

Companion to `REQUIREMENTS.md`. Requirement references (`R4.2.2`) point there.
Written 2026-11-24, before any code exists.

---

## 1. What was studied, and what that implies

`../pat` is 14,266 lines of Go and delegates the hard parts: `wl2k-go` has the
B2F engine (`fbb/`), LZHUF, the directory mailbox, the ARDOP and telnet
transports, AX.25 and the rigctld client; `Pat-Vara` has the VARA host
interface; `ptc-go` has PACTOR. pat itself is the CLI, the HTTP API, the web
GUI, Winlink forms, GPSd, VOACAP and the scheduling glue.

So this project is not a port of pat's 14k lines; it is a re-implementation of
roughly the `fbb` (2,572) + `mailbox` (287) + `lzhuf` (937) + non-AX.25
`transport` (2,330) + `rigcontrol` (615) slice of wl2k-go — about 6,700 of its
10,821 lines, counting implementation only — plus a new multi-user server, a
new database layer, new mail-access servers, and a new front end.

Behaviours in pat that were read closely and deliberately differ here:

| pat / wl2k-go | rfmail |
| --- | --- |
| Mailbox is `mailbox/<CALL>/{in,out,sent,archive}` of `.b2f` files; unread is an `X-Unread` header; `SetSent` renames the file and calls `log.Fatalf` if it fails | Database rows with explicit state (R5.6–R5.9); no file renames in the delivery path |
| One exchange loop serialises sessions through a channel (`exchangeChan`) because one operator is at one radio | Session queue with priority and cancellation (R4.5.2) |
| Prompts block on `<-a.promptHub.Prompt(...)` with a one-minute timeout, answered by terminal or WebSocket | Prompts are events with deadlines and a recorded outcome; a session with no attached client uses the configured default |
| VARA driver `panic`s on an unexpected `CONNECTED` line | Unknown or malformed asynchronous lines are logged and ignored (R3.3) |
| ARDOP data port derived by incrementing the last character of the control port string | Control port + 1 computed numerically (R3.5) |
| Config is one JSON file, rewritten wholesale by the GUI | Config file plus database for users and mail; config writes validated and atomic (R7.4) |
| Single callsign per instance, auxiliary addresses as a config list | Users own callsigns (R5.3, R5.4) |
| No server role: pat only listens for P2P sessions | Gateway relay and post office roles (R4.4.2, R4.4.3) |

---

## 2. Architecture

```
browser (SvelteKit SPA, TypeScript)
   |  HTTP + WebSocket
rfmail backend — one Node process, one event loop
   |
   +-- api/          auth, REST, /ws event bus, static assets
   +-- session/      queue, scheduler, session runner, prompts
   |     +-- b2f/        handshake, proposals, blocks, secure login
   |     +-- codec/      lzhuf, gzip, Winlink message (de)serialisation
   |     +-- transport/  Conn, telnet, vara-family, ardop
   |     +-- rig/        rigctld client, PTT bridge, QSY
   +-- store/        MailStore: sqlite | mariadb | postgres
   +-- mailservers/  SMTP submission, POP3, IMAP, peer policy
   +-- sys/          config, logging, audit, supervision, metrics
   |
   +-- TCP --> rigctld (separate process)
   +-- TCP --> VARA / XARA / Data2G / ardopcf (separate, optionally launched)
   +-- TCP --> CMS / RMS Relay (server.winlink.org:8772)
```

Everything above the TCP sockets is one process. There are no worker processes
for protocol logic. `worker_threads` is used only for compression of large
messages if measurement shows the event loop stalling (see §9).

### Concurrency model

Async/await throughout; nothing blocks the loop. Per-session state lives in one
object with an explicit state field; no shared mutable session state is passed
between modules. Every outbound write to a transport goes through a small
write queue with backpressure (`drain`/watermark), because a 200 KB message
pushed at a 500 baud link must not be buffered in memory — the send loop awaits
the modem's buffer count (ARDOP `BUFFER`, VARA `BUFFER`) before writing the next
block.

### Runtime and TypeScript constraints

* Node ≥ 24, ESM, **erasable TypeScript only** — no `enum`, `namespace`,
  parameter properties or decorators — so the backend runs directly from `.ts`
  with Node's type stripping and needs no build step. `tsc` is used for
  type-checking in CI, not for emitting.
* `tsconfig` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
* Test runner: `node:test` + `node:assert` (built in). No test framework
  dependency. Browser tests are separate (see §9).
* **Portable by construction** (R1.2, decision 9): one source tree runs on
  Linux, macOS and Windows. Paths go through `node:path` and a single
  `sys/platform.ts` (default ports and directories, service integration,
  signal names, modem process spawning); nothing else may branch on
  `process.platform`. No shell strings anywhere — process spawning takes an
  argv array, so a Windows path with backslashes is not a quoting problem. No
  dependency whose compiled code lacks a prebuilt binary for a supported
  platform.

---

## 3. Repository layout

npm workspaces; one lockfile.

```
rfmail/
  package.json                workspaces, scripts: dev, check, test, build, start
  tsconfig.base.json
  REQUIREMENTS.md  DEVELOPMENT.md  README.md  NOTICE  LICENSE
  packages/
    shared/                   types shared by API and frontend: message DTOs, event
                              payloads, config schema types (zod-free; hand-rolled
                              validators or `valibot`, pure JS)
    core-b2f/                 message structure, proposal, block framing, lzhuf,
                              gzip proposal code, secure login, MID, validation
    transport/                Conn interface + telnet, vara-family, ardop drivers
    rig/                      rigctld client, PTT bridge, QSY
    store/                    MailStore interface, sqlite/mariadb/postgres adapters,
                              migrations, import/export
    mailservers/              smtp/, pop3/, imap/, peer-policy
    server/                   session queue, scheduler, API, ws, auth, config,
                              logging, audit, supervision, metrics,
                              sys/platform.ts (the only OS-aware module)
  apps/
    backend/                  entry point: config load, migrate, start services
    web/                      SvelteKit 3 SPA (adapter-static), TypeScript
    postoffice/               the station that answers calls: its own entry, config,
                              console API and service (POSTOFFICE.md)
    postoffice-web/           that station's console (SvelteKit static SPA)
  test/
    peers/                    scripted peers: fake-vara, fake-ardop, fake-rigctld,
                              fake-b2f-peer, fake-cms
    fixtures/                 lzhuf vectors, B2F transcripts, messages, config
    conformance/              optional Go-oracle harness (dev only, not shipped)
    portability/              install + unit suite, run on all three OSes in CI
  deploy/
    rfmail.service            systemd unit (Linux reference deployment)
    install.sh                the one command the operator runs (root, Linux)
    install-postoffice.sh     the post office's installer; it writes the unit, so a
                              checked-in .service file would be a second source
```

Why workspaces rather than `src/`: `core-b2f` must be usable from a test with no
server, no database and no config, and it must not be able to import the store
or the API. Package boundaries enforce what the module boundaries claim.

---

## 4. Key interfaces

Sketches, not final code; they fix the shape each milestone builds against.

```ts
// transport/index.ts
export interface Capabilities {
  bandwidths: string[];          // VARA: 500/2300/2750; ARDOP: 200/500/1000/2000[+MAX|FORCED]
  supportsP2P: boolean;
  needsLocator: boolean;
  ptt: 'modem' | 'external';
  dataPort?: number;
}

export interface Conn extends AsyncIterable<Uint8Array> {   // reads
  write(chunk: Uint8Array): Promise<void>;                   // awaited backpressure
  flush(): Promise<void>;                                    // whole TX drained over the air
  txBuffered(): number;                                      // for progress accounting
  close(graceful: boolean): Promise<void>;
  readonly peer: string;
}

export interface ModemDriver {
  readonly kind: 'vara-hf' | 'vara-fm' | 'xara' | 'data2g' | 'ardop' | 'telnet';
  open(): Promise<void>;
  capabilities(): Promise<Capabilities>;
  version(): Promise<string>;
  dial(target: string, opts: DialOptions): Promise<Conn>;     // resolves with a live Conn or throws
  listen(on: boolean): Promise<void>;
  disconnect(): Promise<void>;
  abort(): Promise<void>;
  onBusy(cb: (busy: boolean) => void): void;
  onPtt(cb: (on: boolean) => void): void;                     // bridges to rig (R2.5)
  state(): 'stopped' | 'ready' | 'dialing' | 'connected' | 'failed';
  close(): Promise<void>;
}
```

```ts
// core-b2f/session.ts
export type Role = 'client' | 'gateway-relay' | 'post-office';

export interface Exchange {
  handshake(local: StationOptions): Promise<PeerInfo>;   // SID, ;FW, ;PQ already answered
  inboundTurn(): Promise<Proposal[]>;                    // parses FA..FD, FF, FQ, F>, ;PM
  answerInbound(p: Proposal[]): Promise<void>;           // writes FS ..., verifies checksum
  receive(p: Proposal, sink: WritableStream<Uint8Array>): Promise<void>;
  outboundTurn(pending: OutboundMessage[]): Promise<SendResult>;  // offers ≤5, reads FS, writes blocks
  quit(): Promise<void>;
}
```

```ts
// store/index.ts — one interface, three adapters
export interface MailStore {
  migrate(): Promise<void>;
  users: UserStore;                 // CRUD, scrypt verify, callsign ownership
  folders: FolderStore;             // per-user folders, uidvalidity/uidnext
  messages: MessageStore;           // insert (transactional), list, fetch body/attachments, flags, search
  outbox: OutboxStore;              // queue, next-attempt, mark sent/deferred/failed
  sessions: SessionStore;           // history + stats
  audit: AuditStore;
  quota(userId: number): Promise<{ used: number; limit: number }>;
  exportUser(userId: number, outDir: string): Promise<void>;
  close(): Promise<void>;
}
```

```ts
// mailservers/peer-policy.ts
export type AccessMode = 'very strict' | 'strict';
export interface PeerPolicy {
  readonly mode: AccessMode;
  allows(remote: string): boolean;   // loopback-only, or CIDR list
  describe(): string;                // rendered in the UI and the startup log
}
```

---

## 5. Data model (dialect-neutral)

Timestamps are epoch milliseconds in `BIGINT` everywhere (R1.7, portability).
Text is `TEXT`/`VARCHAR` sized to fit all three engines. Binary is `BLOB` /
`LONGBLOB` / `BYTEA` per dialect.

```
schema_migrations (version INTEGER PK, applied_at BIGINT)

users            (id PK, login VARCHAR(64) UNIQUE, pw_hash TEXT, role VARCHAR(16),
                  enabled BOOL, quota_bytes BIGINT, created_at BIGINT, updated_at BIGINT)
user_callsigns   (callsign VARCHAR(16) PK, user_id FK, is_primary BOOL,
                  winlink_pw_enc TEXT NULL, aux_of VARCHAR(16) NULL)
folders          (id PK, user_id FK, name VARCHAR(255), kind VARCHAR(16),
                  uidvalidity BIGINT, uidnext BIGINT, UNIQUE(user_id, name))
messages         (id PK, user_id FK, folder_id FK, uid BIGINT, mid VARCHAR(12),
                  direction VARCHAR(8), peer VARCHAR(32),
                  from_addr VARCHAR(320), subject TEXT, date_utc BIGINT,
                  received_at BIGINT, size BIGINT, charset VARCHAR(32),
                  body MEDIUMTEXT, headers_json TEXT, flags INTEGER,
                  UNIQUE(user_id, mid), UNIQUE(folder_id, uid))
recipients       (message_id FK, kind VARCHAR(4) /* to|cc */, addr VARCHAR(320))
attachments      (id PK, message_id FK, name TEXT, content_type VARCHAR(128),
                  size BIGINT, data BLOB)
outbox           (message_id PK FK, state VARCHAR(16), target VARCHAR(32),
                  attempts INTEGER, next_attempt BIGINT, last_error TEXT,
                  last_session_id BIGINT NULL)
sessions         (id PK, kind VARCHAR(16), role VARCHAR(16), started_at BIGINT,
                  ended_at BIGINT NULL, transport VARCHAR(32), peer VARCHAR(64),
                  rig_id VARCHAR(64) NULL, freq_hz BIGINT NULL, modem_id VARCHAR(64),
                  bytes_in BIGINT, bytes_out BIGINT, sent_count INTEGER,
                  recv_count INTEGER, result VARCHAR(32), error TEXT, log_path TEXT)
audit            (id PK, at BIGINT, actor VARCHAR(64), action VARCHAR(64),
                  object VARCHAR(128), old_value TEXT, new_value TEXT, remote_addr VARCHAR(64))
settings         (key VARCHAR(64) PK, value TEXT)     -- non-secret runtime settings only
```

Notes that matter for the adapters:

* `messages.body` is `MEDIUMTEXT` in MariaDB, `TEXT` in PostgreSQL (unlimited),
  `TEXT` in SQLite. Bodies are small by B2F convention; attachments carry the
  bytes.
* No triggers, no stored procedures, no `ON UPDATE` clauses, no
  `AUTO_INCREMENT`/`SERIAL` differences leaking: ids come from a single
  `nextId()` helper that uses the dialect's sequence or `last_insert_rowid()`.
* No native `ENUM` (three dialects, three behaviours): `VARCHAR` plus a
  checked-in domain list.
* Search (R5.11) uses indexed columns and `LIKE` with a lowercased shadow
  column; SQLite FTS5 / PostgreSQL `tsvector` / MariaDB `FULLTEXT` are added
  later behind a capability flag, never as a semantic difference.

Migrations: `packages/store/migrations/<dialect>/NNN-name.sql`, applied in
order under an advisory lock (`BEGIN IMMEDIATE` for SQLite, `GET_LOCK` for
MariaDB, `pg_advisory_lock` for PostgreSQL), recorded in `schema_migrations`.

---

## 6. Protocol engine plan

### 6.1 LZHUF (R4.2.2)

Port of the LZHUF coder with the B2 header: CRC-16 (XMODEM CRC-CCITT table)
over `LE32(uncompressedSize) || compressed`, then `LE32(uncompressedSize) ||
compressed`. The Go implementation in wl2k-go (`lzhuf/`) is the reference for
behaviour, including the initial `' '`-filled look-ahead buffer, the tree
constants (`N=2048, F=60, THRESHOLD=2`, `N_CHAR=256-2+60`), and the bit order of
the Huffman/position code.

Verification, in this order:

1. Golden vectors: the MIT-licensed `lzhuf/testdata/*` files from wl2k-go
   (`e.txt`, `gettysburg.txt`, `pi.txt`, one real `.b2f`) are copied into
   `test/fixtures/lzhuf/` with attribution and asserted byte-exact, both
   decode and encode.
2. Round-trip property tests: random buffers of lengths around the block and
   look-ahead boundaries decode to themselves.
3. Optional oracle: `test/conformance/lzhuf-oracle.test.ts` compiles the Go
   reference when a Go toolchain is present and compares on generated inputs.
   Skipped (not failed) when Go is absent; never part of the shipped build.

### 6.2 Message structure and framing (R4.1, R4.2.1, R4.2.4)

Pure functions over `Uint8Array`/`Uint8Array` streams, with no I/O:

* `serialise(message) → bytes` / `parse(bytes) → message` for the Winlink
  message structure, including header ordering, the body length contract, and
  the `File:` sections.
* `encodeProposals()`, `parseProposals()`, `parseAnswer()`, `checksum()`.
* `encodeBlockHeader()`, `encodeDataBlock()`, `decodeBlockStream()`.

Tests are byte-level against fixtures recorded from the scripted peer, and
include the failure modes the protocol must reject: header length mismatch,
bad EOT checksum, `0` length meaning 256, oversized offset request.

### 6.3 Session state machine (R4.3)

`Exchange` is written as an explicit state machine with a single read loop over
the `Conn` iterator, because B2F interleaves synchronous prompts (`;PQ`, `F>`)
with asynchronous comments (`;PM`, `;` lines) and remote errors (`*`) in the
same byte stream. A naive request/response design deadlocks on real gateways,
which is visible in wl2k-go's `Peek`-based special-casing; the state machine
avoids that by classifying every line before deciding.

Every transition is logged with direction, and the log is the artifact the
tests assert against. `;PR` is logged as sent: it is a hash of the nonce and the
password, so it cannot be replayed against a different challenge (R9.1).

### 6.4 Transports

Written against scripted peers first, hardware second:

* `test/peers/fake-telnet-cms.ts` — accepts, sends the callsign/password prompt,
  then speaks B2F as a CMS would.
* `test/peers/fake-vara.ts` — command port that answers `VERSION`, accepts
  `MYCALL`/`BW…`/`CONNECT`, emits `PTT ON`, `CONNECTED`, `BUFFER`, and a data
  port. Also emits an unknown line (`XYZ SOMETHING`) that must be tolerated.
* `test/peers/fake-ardop.ts` — control port with ASCII commands and states,
  data port at control+1 with `d`-frames.
* `test/peers/fake-rigctld.ts` — `RPRT` and extended responses, plus a mode
  that refuses `\chk_vfo`.

Real-hardware steps, when available: `ardopcf` on loopback (it is a normal
program, no radio needed for the TCP dialogue), and XARA in `--ui-port`-only
mode for capability reading. VARA itself is Windows-only; the same driver is
covered by fake-vara and by Data2G/XARA on Linux.

---

## 7. API and frontend plan

**API surface** (all under `/api`, JSON, OpenAPI 3.1 generated from route
schemas):

```
GET    /api/status                     station + service status
POST   /api/session                    {profileId|rigId,modemId,target,freq,bw,role}
GET    /api/session                    current session
POST   /api/session/abort             {hard?: boolean}
GET    /api/sessions                   history (paged, filterable)
GET    /api/sessions/:id/log           protocol log
GET    /api/rigs  POST/PATCH/DELETE /api/rigs/:id   POST /api/rigs/:id/test
GET    /api/modems POST/PATCH/DELETE /api/modems/:id  start/stop/state/log
GET    /api/config  PUT /api/config   validate + reload
GET    /api/users POST/PATCH/DELETE /api/users/:id   POST /api/users/:id/password
GET    /api/mailbox/:folder           list (paged)
POST   /api/mailbox/:folder           create message (→outbox)
GET    /api/message/:id               headers + body + attachments
PATCH  /api/message/:id               flags, folder
DELETE /api/message/:id
GET    /api/message/:id/attachment/:name
GET    /api/message/:id/raw           .b2f download
GET    /api/audit                     admin
GET    /api/channels                  cached channel catalogue (optional)
WS     /api/session/ws?id=…           one running session's live view: its stage, the
                                      modem's commands, the exchange's lines, its end;
                                      authenticated by the session cookie (R4.5.4)
POST   /api/session/stop              {streamId} — the one control: disconnect, then abort
```

**Frontend**: SvelteKit 3, `adapter-static`, SPA (no SSR — the backend is the
only server). One API client module generated from the OpenAPI document; every
view goes through it. Design tokens in one CSS file; components built from
small primitives (no component framework dependency unless one is chosen in
decision 1). Views:

1. Login / first-run admin creation.
2. Mail: folders, list, reader, composer, attachment handling.
3. Session: profile picker, target picker (channel list or typed), live
   progress, log, abort, prompts.
4. Configuration: server, users, transceivers, modems, Winlink, gateway,
   profiles.
5. Administration: sessions history, audit, storage usage.

The frontend is developed against the scripted backend (`test/peers` plus a
fixture mode that serves recorded responses) so that UI work does not need a
radio; a labelled "stand-in" banner makes fixture mode impossible to mistake for
a live system.

---

## 8. Milestones

Each milestone ends with its tests green and the acceptance sentence in
`REQUIREMENTS.md §11` demonstrable. Sizes are rough: S < 500 lines, M 500–1500,
L 1500–3000 (implementation + tests).

### M0 — Skeleton and guard rails (S)
Workspaces, tsconfig, `npm run check|test|build`, CI with the R1.2 portability
job, config loader (TOML + validator, atomic write), structured logging,
`/health`, graceful shutdown, systemd unit, README.
**Exit:** `npm ci && npm run check && npm test && npm run build` passes on a
clean clone under Linux, macOS and Windows with no compiler installed; a
compiled dependency with no prebuilt coverage for one of those platforms fails
the portability job.

### M1 — Storage (L)
`MailStore` interface, three adapters, migrations, users/callsigns/folders/
messages/outbox/sessions/audit, scrypt, quota, export/import, CLI
(`rfmail user add`, `rfmail db migrate`, `rfmail db check`), dialect test matrix.
**Exit:** the same storage test suite passes on SQLite, MariaDB and PostgreSQL;
export/import round-trips a mailbox byte for byte; R5.3–R5.14 covered by tests.

### M2 — Rig control (S)
rigctld client, PTT bridge, QSY with revert, frequency polling, per-rig test.
**Exit:** fake-rigctld tests for all R2.3 commands; two rigs in parallel; rig
failure isolated; QSY reverts on success and on failure.

### M3 — Transport layer and telnet driver (M)
`Conn`, write queue with backpressure, telnet driver with login handling, scripted
CMS peer, dial/abort/close semantics.
**Exit:** dial, bidirectional byte flow, abort during dial, reuse after abort;
login prompt handled only when the peer prompts (R3.6).

### M4 — Message codec and LZHUF (L)
Message structure, proposals, block framing, LZHUF both directions, gzip
proposal, MID, validation, secure login vector.
**Exit:** golden vectors byte-exact; failure modes rejected with stated reasons;
round-trip of a 200 KB message through 125-byte blocks.

### M5 — B2F client session (L)
`Exchange` state machine, outbox/inbox integration through `MailStore`, session
logging, prompt events, defer/reject handling, offset requests.
**Exit:** scripted-peer exchange sends and receives messages, both compression
codes, with a `;PQ` challenge; messages land in the right user's folders with
correct outbox transitions; against the live CMS behind an opt-in flag, one real
exchange completes.

### M6 — Modem drivers (L)
VARA-family driver (VARA HF/FM, XARA, Data2G), ARDOP driver, capability
reporting, busy policy, PTT hook, version reporting.
**Exit:** scripted VARA and ARDOP peers; unknown lines tolerated; a second dial
after an abort; `ardopcf` on loopback initialises and reports its version.

### M7 — Supervision, queue and inbound (M)
Launch/stop with probes and logs, modem state machine, session queue and
scheduler with priority, P2P listening and inbound session policy.
**Exit:** a supervised process starts and stops cleanly; queued sessions run in
priority order; an inbound session over a scripted modem reaches the post
office; abort leaves everything idle.

### M8 — Mail access servers (L)
SMTP submission, POP3, IMAP subset, peer policy, TLS modes, rate limits, RFC 822
conversion.
**Exit:** R6 acceptance criteria, including the same client under *very strict*
and *strict*, and a real desktop plus mobile client.

### M9 — API, auth, events (M)
REST routes, OpenAPI document, WebSocket event bus, cookie+CSRF auth, roles,
audit recording, metrics.
**Exit:** the OpenAPI document round-trips into the generated client; every
route covered by a test; CSRF and role checks proven by negative tests.

### M10 — Configuration UI (L)
All R7.3 surfaces, validation feedback, live monitor with prompt handling,
modem/rig state, log tail.
**Exit:** everything configurable and persisted; invalid input rejected with
field-level messages; the app usable from a phone.

### M11 — Mail GUI (L)
Three-pane mailbox, composer with precedence/P2P flag, sanitised HTML, flags and
moves, attachments, raw download, notifications.
**Exit:** R8 acceptance criteria via the real browser.

### M12 — Post office and gateway relay (L)
Local termination of inbound sessions, unknown-recipient policy, gateway relay
with access policy and redaction, forwarding/store-and-forward.

**Split (25 Nov 2026):** the post office is built first and does not wait for the
relay — it needs no Winlink Development Team registration, so it can be run and
tested today.

* *M12a — post office* (built): `packages/server/src/postoffice.ts` arms one modem,
  answers `CONNECTED` with a challenge, files inbound mail by recipient, offers what
  the caller's mailbox has not collected, holds mail for an unknown address, and
  re-arms after every call. Owner flag and post-office password on the account; API
  arm/disarm/status. **Exit:** a calling station's session collects its mail and
  leaves its own over a scripted modem; a wrong password is refused before anything
  is offered (`test/postoffice.test.ts`).
* *M12b — forwarding and store-and-forward* (R4.4.4, R4.4.5): open sessions on a
  user's behalf, attempt counts and next-attempt time, flush when the far end
  returns.
* *M12c — gateway relay* (R4.4.2): byte pipe to a CMS, access policy, verbatim
  logging both ways, registration acknowledgement before it can be enabled.
**Exit (whole milestone):** a scripted user session relayed to a scripted CMS,
byte-identical both ways; a post office message picked up by a second session;
queued mail flushed when the CMS comes back.

### M13 — Hardening and packaging (M)
Limits, log rotation, redaction audit, backup documentation, Dockerfile sketch,
operator manual, upgrade path (migrations + restart), fuzz tests over parsers.
**Exit:** a week-long soak with scripted sessions shows no leak (RSS flat), no
unhandled rejection, and no lost or duplicated message.

Sequencing: M0 → M1 → (M3, M4 in parallel) → M5 → M6 → M7 → M8 → M9 → M10/M11
in parallel → M12 → M13. M2 can start any time after M0.

---

## 9. Testing strategy

* **Unit** — codec, proposals, LZHUF, header parsing, config validation,
  peer policy, RFC 822 conversion. No I/O, no clock, no randomness without a
  seed.
* **Golden vectors** — LZHUF fixtures (MIT, attributed), recorded B2F
  transcripts, `;PQ`/`;PR` known pair.
* **Scripted peers** — every driver and the B2F engine run against in-process
  TCP servers (`test/peers/`), so the suite needs no radio, no CMS and no
  Windows.
* **Database matrix** — SQLite on every run; MariaDB and PostgreSQL via
  containers when available, and skipped with a loud message when not. A test
  that silently skips is not evidence, so CI runs all three.
* **Portability job** — `npm ci --ignore-scripts` plus the unit suite on Linux,
  macOS and Windows runners; no compiler, no build tools. Catches an accidental
  shell string, a `/dev/...` path, a POSIX-only signal or a dependency that
  quietly gained a native build step.
* **Live-opt-in** — `RFMAIL_LIVE_CMS=1` performs a real CMS telnet exchange;
  never on by default, never in CI without credentials.
* **Browser** — the built SPA is loaded and exercised with real clicks and real
  key events (not scripted `.value =`), asserting state that the click was
  supposed to change; screenshots inspected. Every config form is exercised
  through a save and a backend restart.
* **Fuzzing** — message parser, proposal parser, block decoder, LZHUF decoder:
  random and mutated inputs must produce errors, never exceptions escaping the
  session or unbounded allocation (a 4-byte declared size must not allocate 4 GB:
  every length is validated against the remaining stream).
* **Soak** — M13: scripted sessions at a fixed rate, checking memory, session
  table growth, queue drain, and no duplicate outbox transitions.

---

## 10. Risks

| Risk | Why it bites | Mitigation |
| --- | --- | --- |
| LZHUF mismatch | Every message exchanged with real software is compressed; a wrong bit silently corrupts mail | Golden vectors, oracle comparison, decode-then-reencode equality, early milestone (M4) before any live session |
| VARA-family drift | VARA is closed source; XARA and Data2G are young (Data2G self-describes as beta); command behaviour differs at the edges | Capability flags, tolerant async parsing, one driver with configuration, per-modem smoke test in the UI |
| CMS protocol changes | The CMS telnet side is a third party; a behaviour change breaks sessions | Opt-in live test, clear error surfacing, retry, and no assumption that CMS is available (store-and-forward from M12) |
| IMAP client quirks | IMAP is the largest compatibility surface in the project | Implement the subset clients actually use, test with Thunderbird + one mobile client, and keep `IMAP` behind the same store interface so a missing verb is a small change |
| `node:sqlite` API stability | It is part of Node, not a package we pin | Pin the Node version in CI and deployment; the SQLite adapter is one file behind `MailStore`; `better-sqlite3` behind the same interface is the fallback (decision 9) |
| Compiled dependencies erode portability | One dependency with a build step, or a `/dev/...` path, turns a working Linux install into a tree that will not start on Windows | M0 portability job on all three OSes with no compiler; `sys/platform.ts` as the only OS-aware module; no shell strings; prebuilt-coverage requirement (R1.2) |
| Gateway registration | RMS gateway operation needs WDT approval and a registered callsign with SSID; a correct implementation still cannot be tested without it | Relay and post office are separate switches; post office works with no registration; relay refuses to enable without the registration acknowledgement (R4.4.2) |
| Multi-user isolation | A bug here exposes other users' mail | Every store query is scoped by `user_id` at the interface level, not at call sites; isolation tests are a required suite, run on all three dialects |
| Single event loop stalls | Compression or a big export blocks sessions and mail clients | Measure; move compression above a size threshold to `worker_threads`; stream exports and attachment reads |

---

## 11. Engineering decisions taken in this plan

Product decisions are in §12; these are the technical ones this plan makes on
its own.

1. **Node ≥ 24, one process, ESM, erasable TypeScript** (no build step for the
   backend) — R1.1, §2.
2. **npm workspaces with five packages plus two apps**, so the protocol core
   cannot depend on the store or the API — §3.
3. **No compiled dependency in the default install**; SQLite on `node:sqlite`,
   scrypt through `node:crypto`, and a `better-sqlite3` adapter only as an
   optional alternative behind the same interface — R1.2, decision 9 (`§12`).
4. **Timestamps as epoch milliseconds in `BIGINT`**, not dialect date types —
   §5.
5. **Scripted peers before hardware** for every driver — §6.4, §9.
6. **Frontend as a static SPA served by the backend**, no SSR — §7.
7. **Session queue with priority** rather than pat's single serialised exchange
   loop — R4.5.2.
8. **Gateway relay is a byte pipe with an access policy, not a B2F
   re-origination** — R4.4.2.
9. **LZHUF ported, not delegated to a subprocess or a WASM build of another
   project**; fixtures carry the MIT attribution — §6.1.
10. **One OS-aware module** (`sys/platform.ts`) and no shell strings, so the
    same tree starts on Linux, macOS and Windows — R1.2, §2.

## 12. Product decisions — settled 2026-11-24

Recorded here as answered; `REQUIREMENTS.md §12` is the authoritative copy with
the requirement references.

1. **Frontend** — SvelteKit, static SPA served by the backend.
2. **Config format** — TOML.
3. **Mail access** — SMTP + POP3 + IMAP4rev1 in the first release.
4. **Administration** — admin manages users and configuration, does not read
   other users' bodies.
5. **Gateway mode** — relay to CMS and post office, both, as separate switches.
6. **Session trigger** — user-requested from the GUI, priority queue, sysop can
   also run and cancel.
7. **TLS** — optional for SMTP/POP3/IMAP and separately for the web UI;
   plaintext credentials refused off-loopback unless explicitly allowed.
8. **Targets** — cached channel catalogue *and* first-class manual entry
   (callsign, `host:port`, P2P address) for stations outside the official list.
9. **Compiled code** — allowed, provided portability holds: one source for
   Linux, macOS and Windows, no compiler for the default install, prebuilt
   binaries or a documented build path for anything compiled, and a preference
   for JavaScript/WASM where realistic. SQLite stays on `node:sqlite`.
10. **First-run account** — created in the web client at the first start with no
    password; the name is remembered in `localStorage`; an empty password works
    for the sign-in and for POP3 until one is set.
11. **Delivery order** — store + web client + POP3 first; SMTP, IMAP, the other
    database adapters, rigs, modems, B2F and the gateway roles afterwards.

Consequences for the plan, already applied: R1.2 and R1.5 rewritten; the M0 exit
criterion is a three-OS portability job instead of a `.node` ban; §2 gained the
platform module rule; §3 gained `test/portability/`; §9 gained the portability
job; §10 replaced the native-addon risk with the portability risk; R4.6.1 gained
manual targets; R6.6 now names the mail servers and the web UI separately; R5.3,
R6.2 and R7.2 describe the passwordless first-run account.

---

## 13. Status after the first implementation step

Built and verified (2026-11-24):

```
packages/shared/src/index.ts          API and domain types (browser-safe)
packages/core-b2f/src/message.ts      message model, addresses, validation
packages/core-b2f/src/rfc822.ts       MIME parse + serialise (QP/base64, charsets,
                                      encoded words, multipart, dot-safe text)
packages/core-b2f/src/address.ts      Winlink addressing: bare callsign in the
                                      store, CALL@winlink.org for clients
packages/core-b2f/src/lzhuf.ts        LZHUF codec + the B2 CRC/size wrapper,
                                      byte-exact against wl2k-go's vectors
packages/core-b2f/src/b2msg.ts        the Winlink message structure (Mid/Date/
                                      Body:/File:), parse and serialise
packages/core-b2f/src/proposal.ts     FC/FD proposals, F> checksum, SID, secure
                                      login response, precedence
packages/core-b2f/src/frame.ts        SOH/STX/EOT transfer framing
packages/rig/src/rigctld.ts           rigctld client: freq, mode, VFO, PTT with a
                                      selectable transmit input (data / mic / auto)
packages/rig/src/transceiver.ts       the transceiver config shape, validation and
                                      the rig client it builds
packages/core-b2f/src/mime.ts         MIME tree, for IMAP body sections
packages/core-b2f/src/mid.ts          MID generation (base32 of md5)
packages/store/src/types.ts           store contract
packages/store/src/sqlite.ts          SQLite adapter on node:sqlite
packages/store/src/schema.ts          schema v1 + v2 (per-callsign credential)
packages/store/src/password.ts        scrypt hash/verify
packages/mailservers/src/access.ts    "very strict" / "strict" peer policy
packages/mailservers/src/lines.ts     CRLF line reader (utf8 or latin1)
packages/mailservers/src/events.ts    in-process "something arrived" bus
packages/mailservers/src/identity.ts  login by callsign (any case, or the address)
packages/mailservers/src/pop3.ts      POP3 server, one maildrop per account
packages/mailservers/src/smtp.ts      SMTP submission (AUTH PLAIN/LOGIN)
packages/mailservers/src/imap.ts      IMAP4rev1 (LOGIN, LIST, SELECT, SEARCH,
                                      FETCH, STORE, COPY, APPEND, EXPUNGE, IDLE;
                                      a UID FETCH answer always carries UID and
                                      BODY[<section>] returns that part)
packages/server/src/config.ts         TOML config, generated on first start
packages/server/src/auth.ts           signed session cookie + CSRF nonce
packages/server/src/http.ts           router, body limits, JSON helpers
packages/server/src/api.ts            REST API, accounts, password changes
packages/server/src/session-stream.ts the live view of a running session: a small
                                      WebSocket server (handshake, text frames, close,
                                      ping), a backlog per session, and the one control
                                      that escalates from a disconnect to an abort
                                      (decision 51)
packages/server/src/html.ts           allowlist sanitiser for HTML bodies
packages/server/src/secrets.ts        AES-256-GCM sealing for stored credentials
packages/server/src/static.ts         SPA assets with fallback
packages/server/src/platform.ts       the only OS-aware module
apps/backend/src/main.ts              startup, wiring, shutdown
apps/backend/src/cli.ts               user/import/info commands
apps/web/                             SvelteKit 3 client (adapter-static)
test/                                 89 tests: message, address, mime, lzhuf,
                                      b2f, rigctld, store, api, access, pop3,
                                      smtp, imap, html, secrets, identity
```

Deviations from the plan above, and why:

* **MariaDB and PostgreSQL adapters are not written yet.** The store contract
  and the schema are dialect-neutral as designed; only the SQLite adapter exists
  (decision 11). Their suites still have to be added to CI in milestone M1's
  remainder.
* **scrypt lives in `packages/store/src/password.ts`**, because the store owns
  the credential column and the API and every mail server need to verify
  against it — no separate credentials package.
* **`platform.ts` is `packages/server/src/platform.ts`**, not `server/sys/`: the
  server package is small enough that a subfolder buys nothing.
* **The web client is built and served by the same process** (`apps/web/build`),
  with `npm run dev` in `apps/web` proxying `/api` to a separately started
  backend.
* **The generated config binds POP3 to `127.0.0.1:1110`**, because 110 needs
  privileges; R6.7 says so and the file explains it.
* **One callsign per account** (decision 12): `users.callsign`, unique, with the
  sealed Winlink credential beside it. Schema v3 moves both off the old
  `user_callsigns` table and drops it, so a callsign that is no longer primary
  cannot take its credential into a different account. Changing an account's
  callsign clears the credential, because a Winlink password is registered for
  one callsign — the CMS would reject it under another. Further addresses are
  auxiliary addresses (R7.3.5), not session originators.
* **The Winlink password is sealed** with AES-256-GCM under `[server] store_key`,
  a key separate from the session secret, so rotating the session key does not
  destroy credentials. The store only ever sees an opaque
  `v1.<iv>.<tag>.<ct>` blob; the API exposes a `hasWinlinkPassword` boolean and
  never the value.
* **One identity, one name** (`mailservers/src/identity.ts`, decision 25): the
  account IS its callsign, so the web API, POP3, IMAP and SMTP all resolve a
  username the same way — strip a `@winlink.org` domain, then one case-insensitive
  callsign lookup. A mail program that fills the username field from the address
  and an operator who types the callsign reach the same mailbox, and there is no
  second account name to drift from it.
* **One address form per surface** (`core-b2f/src/address.ts`): `toWinlinkAddress`
  on every ingress (SMTP `MAIL FROM`/`RCPT TO`, IMAP `APPEND`, the API composer,
  the importer — the first two through `parseRfc822`), `toFullAddress` only where
  a mail program is served (`serialiseRfc822` by default, the IMAP `ENVELOPE`,
  the `.eml` download). The web GUI and the API payloads keep the stored, bare
  form: the station's own face shows `OK4RM`, the client's face shows
  `OK4RM@winlink.org`. `serialiseRfc822(msg, { winlink: false })` is the radio
  form and is what the B2F writer must call. The two header variants keep an internet sender's display
  name; only Winlink addresses are rewritten, because there the callsign is the
  identity. Storing the bare form means a message can be handed to a B2F
  proposal, matched against a mailbox or shown to a client without a second
  interpretation of its addresses.
* **rigctld getters go through the extended protocol** (`+\get_mode` … read until
  `RPRT`). `\get_mode`, `\get_split_vfo` and `\get_level` answer with varying
  numbers of lines and there is no delimiter in the classic form: a client that
  reads one line per command sees every later answer shifted by one, which reads
  as a plausible wrong number rather than a fault. Setters and `\chk_vfo` stay
  classic (`+\chk_vfo` never answers).
* **PTT selects the connector the audio comes from.** `\set_ptt 3` is
  `RIG_PTT_ON_DATA` — the rear input a modem feeds — while `1` is plain
  `RIG_PTT_ON`, the front microphone on a TS-590. It is a per-transceiver setting
  (R2.2.1), named `rear` / `front` / `auto` for the connectors rather than by
  Hamlib's constants, and `auto` tries the rear input first and records a
  fallback, since `\dump_caps` does not advertise which on-values a backend
  accepts.
* **IMAP answers the client's shape, not the store's**: every `UID FETCH` reply
  carries `UID` even when the client did not ask (RFC 3501 §6.4.8 — Thunderbird
  silently drops every message without it, which looks like an empty mailbox),
  and `BODY[1]`/`BODY[2]`/`BODY[1.MIME]`/`BODY[HEADER.FIELDS (…)]` return that
  slice of the stored message (`core-b2f/src/mime.ts`) rather than the whole
  MIME blob, which a client cannot render.
* **The IMAP text path reads bytes as latin1** (`readLines(socket, 'latin1')`),
  not UTF-8: the eight-bit octets of a stored body must reach the client
  unchanged, and the first UTF-8 version turned `Tělo` into replacement
  characters. Headers are decoded as UTF-8 only where RFC 2047 allows it.
* **POP3, SMTP and IMAP are one door with a switch on each.** The header carries one
  `Mail` pill instead of three address badges — green when all three listen, orange when
  some do, dark red when none does — and the addresses, the states and the switches live
  in a dialog behind it. A switch closes or reopens a listener at once
  (`GET`/`POST /api/mail/interfaces`); it is not configuration, because the file decides
  which protocols exist and a restart returns to it. A protocol the file does not offer
  keeps its row with the switch disabled rather than vanishing, so "no IMAP here" is
  visible instead of absent. Each server now reports `listening` from its bound socket
  and a failed listen leaves it unbound, which is what lets a switch retry; a bind that
  fails is recorded on the row and no longer stops the station, because the screen that
  reports the fault has to be up.
* **The header wraps on a phone.** Below 860 px the section buttons scroll on their own
  line and the modem selector and rig control move below them, so nothing important is
  pushed off the right edge. This is a stopgap; the navigation itself is the next piece of
  work (R7).
* **The access mode is a server fact, not a client screen.** `PeerPolicy` is mutable but
  still validates a change as a whole (`set()`), so a bad form cannot leave the station
  half-open, and the running listeners pick it up on the next connection because they hold
  the policy, not a copy of it. It is enforced on the HTTP API and web UI as well as the
  mail doors, so the client cannot be shown it as a mail-interface detail — the chip and
  its dialog were removed with the mail lamp, the sign-in page says only which build it is
  talking to, and the switch belongs to the post office screen when that returns. Runtime
  only; the file decides again at the next start.
* **A variable named `state` breaks runes typing.** A component that declares `let state =
  $derived(...)` makes svelte-check report `$state` used before its declaration on every
  rune in the file, which reads like a compiler fault. Rename the variable; the rune names
  are reserved in the generated types.
* **The station is a client or a post office, and the mail interfaces are the post office's.**
  Boot asks the store for a post office owner: with one, POP3/SMTP/IMAP start; without one
  the station is a Winlink client and none of them is opened, though every configured
  address is still reported. The switches refuse to start an interface on a client station
  (`409` with that sentence) but always allow stopping, so an interface left listening can
  be closed after the owner is unseated. The client UI carries no trace of them — no lamp,
  no addresses, no switches, and no access-policy chip either (decision 33); the header is
  the sections, the modem selector and the rig control. The post office is a seat, not a
  role: the sign-in form will carry the box when the post office returns, only a session
  opened with it renders the route and reaches its API, and the form offers nothing of the
  kind today — the server refuses the seat and the guard stands, so every login is a client
  login.
* **An account makes itself at the sign-in page.** `POST /api/accounts` (public, like the
  first-run form, and rate-limited per remote) takes a callsign and a Winlink password: the
  password is sealed with the store key like the account page's, the callsign is the login,
  and no local password is set, so the callsign alone signs in until its owner adds one.
  `assertCallsignFree` runs first, so one callsign cannot have two mailboxes, and a failure
  to store the sealed secret deletes the half-made account rather than leaving it behind.
  The route answers `201` with a session, so the new mailbox is open immediately.
* **A non-WL account is not offered what it cannot use.** `SessionView` takes the account
  (`me`) and derives `canWinlink` from `user.hasWinlinkPassword`: without it the gateway
  list is not fetched, the "Find gateways" button and the whole RMS panel are absent, the
  session-type select carries only "Peer to peer", the screen's lede changes, and a notice
  stands where the list would be. The server is unchanged: the engine already refuses a
  challenged session with no password (decision 21), and a scripted peer that never
  challenges still works, which the tests rely on. The flag itself is shown as `non-WL`
  beside the Winlink password on the account page and beside the callsign in the accounts
  list.
* **A Winlink session wears the client identity the CMS accepts.** `WINLINK_CLIENT_IDENTITY`
  lives in shared with the measured reason (a production CMS rejects client types it does
  not know; HB9AK said so on 25 Nov 2026) and is applied in the run route: for `mode: 'cms'`
  the server passes it to `runSession`, and every other mode passes nothing, so `localSid`
  sends this station's own `RF Mail-0.1`. Neither the request nor the screen offers a
  choice — `fakeClient` was removed from `SessionRunRequest` with the debugging checkbox,
  and the session screen states which identity the chosen mode will use. The test asserts
  the SID the scripted gateway received, not just a field.
* **Transceivers are one interface, and it is read, not written.** `RadioView` sets an
  address and a port (placeholders `localhost` and `4532`, both defaulted server-side) and
  otherwise reports what the daemon says: the model and manufacturer and the control
  interface with its speeds (`\dump_caps`), the frequency, mode and filter width of the
  receiving VFO (`\get_rig_info`), the RFPOWER setting, and the Hamlib build answering. The
  link is opened at start-up by the backend and polled every five seconds; a failure is
  retried every fifteen seconds. What the operator sets on the rig is set here too: the
  transmitter power as a slider (`\set_level RFPOWER`, then the level is read back, so the
  screen shows what the radio took) and the transmitting connector as a select (rear, front,
  or rear with fallback — applied to the live link without reopening it). `PATCH /api/radio`
  carries both; `PUT /api/radio` carries the address. The header chip (`RadioControl`) is the
  same data in one line and a click away from the screen. `Rigctld.getRigInfo`, `getCaps`,
  `getPower`, `setPower` and `setPttInput` are the client side; `\get_rig_info` needs its own
  read because it ends at a blank line.
* **A modem is active only when it is the modem it claims to be.** `GET /api/modems/status`
  takes the `VERSION` reply as the truth: a kind mismatch makes `running` false and sets the
  error to `<kind> is answering on this port, not <kind>`. VARA, XARA, Data2G and Mercury share
  ports, so a socket that connects proves nothing. The screens say *active* and *unavailable*
  and nothing else: the answering program is in the reason (tooltip on the LEDs, and the
  warning on the session screen), not in a column of its own.
* **Small tiles, detail on click.** The Radio screen is a registry of rigctld interfaces, one
  small tile each — `host:port` and LED, then the transceiver it serves — that opens into the
  serial line, dial, filter, transmit connector, power, on/off switch and Edit/Delete. Every
  enabled interface is dialled by the backend loop; `last_used_at` (migration 010) decides
  which one `GET /api/radio` calls current, and a tie goes to the newer row. The Modems screen
  is one small tile per modem — protocol and LED, address, then command, data and KISS port in
  three columns — that opens into the labelled ports, the radio, the mode, the reason it is
  unavailable, and Edit/Delete. `serial_port` and `serial_speed` (migration 009) are notes the
  operator records, since `\dump_caps` reports only the model's range.
* **Ports are named by the modem.** `modemPortsOf(kind)` in `@rfmail/shared` gives the three
  ports left to right with their label and transport — `CMD`/`DATA`/`KISS` on TCP for VARA
  and the rest, `KISS`/`AGW` on TCP and `SND` on UDP for Direwolf. Tiles print `LABEL number
  TCP|UDP`; the form labels and the detail list use the same helper, so a name cannot drift.
  The tile prints the transport as one letter — `t` for TCP, `u` for UDP, with the word in the
  tooltip — because three ports spelled out were wider than the tile.
  Ports a modem does not have are not printed at all — the tile lists what exists, spread left
  to right — rather than holding a column open with a dash.
  Direwolf is a registry kind (no session driver) with defaults 8000 AGW / 7355 SND (UDP) /
  8001 KISS, both in the form and on the server, and its status probe is a plain TCP connect
  to the AGW port rather than `VERSION`.
* **LAN names are asked, not stored.** `packages/server/src/hostnames.ts` answers "what is this
  address called" with a NBSTAT query to UDP 137 (`buildNbstatQuery` / `parseNbstat`) and, when
  that misses, an mDNS PTR for `<reversed>.in-addr.arpa` with the QU bit set (`buildReverseQuery`
  / `parseMdnsPtr`). `lookupHostName` skips loopback and non-IPv4 hosts, gives each service a
  timeout, and caches a hit for ten minutes and a miss for one. `GET /api/hostnames` maps every
  configured host to its name — transceivers and modems both — and the screens draw the registry
  first and fill the names in after, so a box that answers nothing costs a request, never a
  delay. The interface tile reads `name:port` (name bold, port lighter), then the address, then
  the transceiver; the modem tile carries `name · address` above its ports.
* **The modem form is a column, and its ports are the kind's.** `modemPortsOf(kind)` returns
  only the ports that modem has, with a short `label` for the tile and a `title` for the form,
  so the form's port table and the tile cannot disagree; choosing a protocol refills the inputs
  from `MODEM_KINDS`. The name is composed on submit (`${label} ${host}:${firstPort}`) because
  sessions still key off it, and `transceiverId` is no longer sent, so a modem's radio comes
  from `radioForModem()` in `api.ts`: the named one if there is one, otherwise `firstRadio()`,
  otherwise a 409 saying the station has no interface.
* **Session targets are counted, not configured.** `session_targets` (migration 11) holds
  `callsign`, `frequency_hz`, `uses`, `last_used_at`, unique on the pair with the callsign
  compared `NOCASE`; `recordSessionTarget()` upserts and counts, `listSessionTargets()` orders by
  `uses DESC, last_used_at DESC`. `POST /api/session/run` calls it only when
  `report.dial.result === 'connected'`, and `GET /api/session/targets` feeds the chips above the
  client identity; clicking one sets target, dial, unit and band exactly as `pick()` does. The
  write is one `INSERT … ON CONFLICT (callsign COLLATE NOCASE, frequency_hz, kind, session_mode)
  DO UPDATE` — no earlier `UPDATE` that filled a half-known row's missing mode or type, because
  that is what relabelled peer calls as gateway calls; the chips are re-read after every run.
  The run's answer carries `dialResult`, and when the dial did not connect the sheet says so in one
  line — "Not counted in Called before: the far end never answered" — so a call that was made and
  not counted is not a mystery. The client identity is shown as `SID: [<identity>-B2FHM$]` and
  nothing else: which identity, and why, is the mode's business, not the operator's reading.
* **The band is derived from the typed dial, not chosen beside it.** `onFrequencyInput()` parses
  the field, and when the result lies in a band other than the selected one it sets `band` and
  schedules one catalogue read (`scheduleGateways()`, 350 ms, so typing does not fire a request per
  keystroke). A parse that lands in no band is retried in the other unit, which is what makes
  `3597` in a MHz field mean 3.597 MHz. `onBandChange()` keeps the opposite rule — a frequency
  outside the newly chosen band is dropped — so the two directions cannot contradict each other
  and leave the form half-true.
* **`RFMAIL_RIG_TRACE=1` logs every command the station sends to rigctld.** `setRigTrace()` in
  `packages/rig/src/rigctld.ts` is called from `exchange()` for each line written, so a setting
  that moved on the radio can be traced to a command or to the absence of one. Measured on
  start-up: the station sends `\dump_caps` once and then `\get_rig_info`, `+\get_ptt` and
  `+\get_level RFPOWER` per poll — reads only, no `\set_level` anywhere.
* **A passband of 0 is not "no change".** `\set_mode <mode> 0` is Hamlib's
  `RIG_PASSBAND_NORMAL`: measured against the live TS-590S it moved the filter from 2000 Hz to
  1000 Hz and shifted the IF, which cost a 2300 Hz mode its passband. `Rigctld.setMode()` now
  sends `-1` (`RIG_PASSBAND_NOCHANGE`) unless a passband is asked for, and `links.tune()` skips
  the mode write when `link.status.mode` already matches, so an ordinary session sends only
  `\set_freq`. Live check after the change: `\set_mode PKTUSB -1` left the passband at 2000 Hz
  and the power at 0.5.
* **No capability dump.** `Rigctld.getCaps()` and `RigCaps` are gone, and `describeRig()` builds
  the readout from `\get_rig_info` alone. On this daemon `\dump_caps` runs `rigctl_dump_state`
  (the `unknown RIG_FUNC=` block, printed twice at start-up) and re-applies rig settings on the
  way. The station's wire traffic is now exactly three reads per poll — verified in the trace:
  six `\get_rig_info`, seven `+\get_ptt`, seven `+\get_level RFPOWER`, and no dump.
* **`Width=` is Hamlib's idea of the passband, not the rig's filter.** Measured with raw CAT on
  the live TS-590S: `\get_rig_info` says `Width=2000` while the rig answers `SL13;` — 2500 Hz —
  and `SH05;` — IF shift centred at 1500 Hz. Raw CAT is reachable through rigctld's `w <cmd>`
  command (that is the only way to read `SH`/`SL`), but the station does not use it: `w` can
  write as easily as read, and this station's rule is that the operator owns the filter and the
  shift. Verified that the new mode write preserves both: `\set_mode PKTUSB -1` left `SH05;`
  and `SL13;` untouched.
* **Raw reads are two fixed strings.** `Rigctld.getIfShiftHz()` sends `w SH;` and
  `getDataFilterHz()` sends `w SL;` — literals, never assembled — and `exchange()` grew a `'raw'`
  mode for them: a Kenwood reply ends with `;` and no newline, so a line-oriented read would sit
  until the timeout. `SHnn` maps as 1000 + 100·nn (05 = 1500); `SLnn` uses the TS-590S SSB/SSB-DATA
  ladder the operator read off the rig (00=50 … 13=2500), and a code outside it is reported as
  unknown rather than converted from another mode's table. `describeRig()` computes `usableHz` =
  filter − |shift − 1500|, which is what a centred signal can actually use.
* **The catalogue is a `<dialog>`.** `listOpen` drives `showModal()`/`close()` from one
  `$effect`, so the row click, the × , Cancel, the backdrop and Escape all land in the same
  state; `onclose` (which is what Escape fires) only sets the flag. The gateway table moved
  unchanged into `.sheet-body`, and the sort/EMCOMM/refresh controls stayed with it in a sticky
  header.
* **`--panel` did not exist.** The session panel and the catalogue sheet named a custom property
  the stylesheet never defined, so both were transparent; they now use `--bg-panel`, which is
  what `app.css` declares.
* **The session target carries its mode.** Migration 12 adds `kind` to `session_targets` and
  rebuilds the unique index over `(callsign NOCASE, frequency_hz, kind)`; `recordSessionTarget()`
  first tries to claim a row whose mode is still empty (an entry from before the column) and
  otherwise upserts on the triple. `POST /api/session/run` passes `modem.kind`, `GET
  /api/session/targets` returns it, and the chip shows the mode label from `modemKindInfo`.
* **The session kind joins the key.** Migration 13 adds `session_mode` and rebuilds the index over
  `(callsign NOCASE, frequency_hz, kind, session_mode)`; `/api/session/run` records the mode it
  ran in. The claim for rows written before the columns is `(kind = '' OR kind = ?) AND
  (session_mode = '' OR session_mode = ?) AND (kind = '' OR session_mode = '')`, which fills a row
  that knows nothing or agrees, and never lets two half-known rows take each other's place.

Verified by hand, not only by tests: first-run creation, sign-in with the
remembered name, three-pane mailbox with an imported multipart message, opening
it (charset-decoded subject and body), attachment download, composing with an
attachment from the real file picker, the message appearing in OUTBOX, `.eml`
export carrying Q-encoded headers and quoted-printable text, search, delete to
TRASH, second delete removing it.

The mail protocols were driven by real clients, not by internal calls:
`python3` `smtplib` submission with AUTH (subject, body and attachment retrieved
back from IMAP byte-identical after the latin1 fix), `imaplib` `LIST`/`SELECT`/
`SEARCH`/`FETCH` `ENVELOPE` and `BODY.PEEK[]`, `COPY` to ARCHIVE, `STATUS`,
`LOGOUT`, and `poplib` retrieval with `STAT`/`LIST`/`UIDL`/`TOP`/`RETR`. The
socket-level tests in `test/` speak the same protocols through
`test/helpers/protocol-clients.ts` (buffer-based, five-minute read timeout, no
calls into server internals), including an IDLE test where a second writer
publishes an event and the idling session is told `* 1 EXISTS`.

Accounts were exercised in the browser: an administrator created a second
account with a password, the new account signed in to an empty mailbox, saw
only `Mail` and `Account` in the navigation, and used the same credentials
through IMAP, SMTP and POP3. HTML bodies are rendered from the server-side
allowlist: the test message's `<script>` and `onclick` attribute disappeared,
links gained `rel="noopener noreferrer"` and `target="_blank"`, and the tracking
image carried `data-src` only until the reader asked for images.

Gates: `npm run check` 0 errors 0 warnings (tsc + svelte-check), `npm test`
89/89, `npm run build:web` writes `apps/web/build`.

* **The session is watched over a WebSocket, and stopped by one control** (decision 51).
  `packages/server/src/session-stream.ts` speaks the WebSocket itself — the handshake
  (`Sec-WebSocket-Accept` is `websocketAccept()`), one unmasked text frame per event, close and
  ping — because the handshake and the frames this needs are a hundred lines and the station
  already speaks its protocols by hand. `apps/backend/src/main.ts` hands `httpServer`'s `upgrade`
  event to `api.handleUpgrade`, which checks the session cookie and then the id; the channel is
  created on the upgrade rather than on the run, because the screen opens its view first and the
  run joins it a moment later, and a screen that connects late is given the backlog (400 events).
  `runSession` reports through `onStage`, `onCommand`, `onModemLine` and `onLine`, and hands the
  two ways to stop it to `bindControl` before the dial, so a stop can reach `dialModem` through
  `signal` (send `DISCONNECT`, wait out the grace) and `cutSignal` (destroy the socket now). The
  screen's single button reads `Disconnect` → `Abort` → `Aborting…` from the phase the server
  returns, and the sheet ends as `Session cancelled` with `the session was disconnected while
  dialling` or `the session was aborted while dialling` — a stopped session is not a failed one.
  `runSession` also wraps the data stream in `export function watchBytes()`, which reports any
  chunk carrying a byte that is neither printable nor CR/LF/TAB as one `hex` event — the first
  twelve bytes and the length — because the exchange reads messages as binary blocks and would
  otherwise show nothing while a message came in; the screen prints those as
  `3C 2A 4C 5A … 4128 bytes` under the peer's own label. Lines are labelled `MODEM` or by the
  callsign being called, received text is dark blue and bold, and the sheet stays open after the
  session until it is dismissed (button, ×, Escape or backdrop; none of them while running).
  In the sheet the two channels are drawn apart: peer lines are bold (dark blue received, green
  sent, `--peer` / `--data-out` under `.live`), modem replies plain, modem commands italic, and
  `PTT ON`/`PTT OFF` become the header's `ON AIR` lamp plus one `TRANSMIT <n> s` line stamped with
  A `PTT OFF` also remembers its moment in `idleFrom`, and the next `PTT ON` turns a gap with no
  traffic in it into `· waiting <n> s`. Only traffic clears it — a peer line (`t: 'line'`), a
  binary block (`t: 'hex'`) or a command sent to the modem (`t: 'modem'`, `dir: '>'`); the modem's
  own replies (`MODE …`, `IAMALIVE`) are chatter and leave the wait standing, because Data2G sends
  a `MODE` line after most transmissions and an "any line" rule hid every gap there was. `.sheet.running` is a
  fixed frame (`inset: calc(56px + 1rem) 0 1rem 0`, flex column) and `.live` takes the remaining
  height with `overflow: auto`, so a long session scrolls the feed and not the window.
  The frame is written as `.sheet.running[open]`: a closed `<dialog>` is hidden by the user
  agent's `display: none`, and a class rule setting `display: flex` without `[open]` puts the
  closed sheet on the page, over the very fields the session form is there to fill.

Next: the MariaDB/PostgreSQL adapters, then rig control and the modem drivers,
then the B2F engine — which is where the LZHUF golden vectors and the scripted
peers from milestone M4 come in.

---

## 14. The post office application (2026-11-27)

* **It is a second application, and that is what retires the seat.** `apps/postoffice` has its
  own entry point, configuration, data directory, console and service, and its database is never
  the client's. The client's copy of the post office — `is_post_office`, the sign-in seat,
  `postOffice` on the session payload, `/api/postoffice/*` and the post office screen — is still
  in the tree; it is removed the next time the client is opened, and until then two ways into
  one role exist, which is exactly what decision 57 retires. Do not add anything to the client's
  post office screen in the meantime. What stays in the client for good is the `postoffice`
  *session mode*, which is how it calls somebody else's post office.
* **The store knows which application opened it.** `new SqliteStore({ postOffice: true })` adds
  exactly one migration (`MIGRATION_014`: `administrators`, `po_calls`) and raises the supported
  version to 14; a client store stays at 13 and refuses a file that has been to 14. That is
  cheaper than two migration lists and keeps the client's schema honest.
* **Two principals, two tables, two verifiers.** A mailbox is a `users` row with a callsign, a
  sealed post-office password and no `pw_hash`; an administrator is an `administrators` row with
  a name and a scrypt hash and no callsign. The console's session token carries an
  *administrator* id, so its API never calls `store.getUser(session.uid)` — in that database the
  same integer is a mailbox.
* **A call is recorded where it ends.** `PostOffice` takes an optional `onCall` and fires it in
  its `finally`, before re-arming; the post office writes that to `po_calls`. A client station
  passes nothing, so its process keeps the in-memory history the session sheet uses.
* **Installation generates, it does not template.** `deploy/install-postoffice.sh` writes the
  configuration once (both keys) and then leaves it alone; re-running replaces the tree and the
  unit and touches neither the configuration nor the database. `--print-unit` exists so the unit
  can be reviewed and `systemd-analyze verify`ed without root, and `--no-service` installs files
  and configuration only, which is also how the installer is tested here.

Next for this application: the rig link and the radio tile (arming tunes the transceiver), the
envelope-inspection view behind the `inspect` grant, then the `po-mail` / `po-b2f` split that the
native door will need.
