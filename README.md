# rfmail

A Winlink radio mail server: multi-user mail storage, a browser mail client,
and mail access for ordinary mail programs — written entirely in TypeScript,
running on Node.js.

This is the first implementation step. What works today:

* **Mail storage** — SQLite (through Node's built-in `node:sqlite`), users,
  folders, message bodies, attachments, flags, search, per-folder UIDs.
* **Web client** — first-run account creation, sign in, three-pane mailbox,
  reader with attachments, composer with attachments, folders, search,
  read/unread, flag, delete to TRASH, raw `.eml` download.
* **POP3** — retrieval of INBOX with `USER`/`PASS`, `STAT`, `LIST`, `UIDL`,
  `RETR`, `TOP`, `DELE`, `RSET`; one session per account.
* **SMTP** — submission with `AUTH PLAIN`/`AUTH LOGIN`, queueing into OUTBOX;
  the sender must be one of the account's callsigns.
* **IMAP4rev1** — `LOGIN`, `LIST`, `SELECT`/`EXAMINE`, `SEARCH`, `FETCH`
  (`ENVELOPE`, `BODY[]`, `BODY.PEEK[]`, flags, sizes), `STORE`, `COPY`,
  `APPEND`, `EXPUNGE`, `IDLE`.
* **Station settings** — each account has one callsign — the originator of
  everything it sends and the mailbox incoming mail is addressed to — and its
  Winlink (CMS) secure-login password, both on the Account page. A second
  callsign is a second account, and the callsign is unique across accounts. The
  Winlink password is a different secret from the mail password: it is needed
  during a radio session, it is sealed at rest with a key in the configuration
  file, and it is never shown again once stored.
* **Radio** — transceivers are configured in the browser by any account: a name,
  the `rigctld` address and port, and which connector transmits (rear input or
  front microphone). The header shows a dropdown, an LED and a connect button.
* **Accounts** — an administrator creates, disables and deletes accounts, sets
  roles and resets passwords from the browser; every account has its own
  mailbox and reaches it with the same credentials over the web client and all
  three mail protocols. An account cannot read another account's mail.
* **HTML mail** — bodies are sanitised on the server against an allowlist;
  scripts, handlers and `javascript:` URLs never reach the browser, and images
  stay blocked until the reader asks for them.
* **Administration** — `rfmail` CLI for account creation, password changes and
  RFC 822 import; TOML configuration generated on first start.

Not implemented yet, by design (see `REQUIREMENTS.md`): rig control, modem
interfaces, the B2F session engine, MariaDB/PostgreSQL adapters, and the gateway
relay. Mail composed today is queued in OUTBOX and waits for the radio side.

## The post office

A Winlink post office — the station that *answers* calls and holds mail for other
callsigns — is a separate application in this tree, `apps/postoffice`, with its own
console, configuration, data directory and service. Its mailboxes never sign in to a
browser; they collect over the radio, and the people who run the station are
administrators with a local password and no mailbox. Design, installation and the
console: `POSTOFFICE.md`.

```sh
npm run build:postoffice                       # build the console
sudo deploy/install-postoffice.sh             # Linux: /opt, /etc, /var/lib, systemd unit
deploy\install-postoffice.ps1                 # Windows: Program Files, ProgramData, a boot task
#   or, without a service, on either:
deploy/install-postoffice.sh --no-service --prefix /opt/rfmail-po --data ~/.local/share/rfmail-postoffice
```

The console opens on `http://127.0.0.1:8090`; its first screen names the station (a
callsign) and its first administrator.

## Quick start

```sh
npm install
npm run build:web          # builds the browser client into apps/web/build
npm start                  # first start writes ~/.config/rfmail/rfmail.toml
```

Open <http://127.0.0.1:8080>, create the station account (a name, no password),
and the mailbox appears. Remember the name is kept in the browser's
`localStorage` so a restart prefills it.

Options: `npm start -- --config /path/rfmail.toml --port 8081 --log debug`.

A headless box reached from another machine needs the listener off loopback:

```sh
npm start -- --listen 0.0.0.0:8082      # or set [server] listen in the file
```

`--listen` takes a full `host:port`; `--port` only moves the port and stays on
loopback. Exposing the station to the LAN also needs `[mail] access = "strict"`
with at least one CIDR — `very strict` refuses every peer that is not loopback,
and `strict` with an empty CIDR list refuses to start rather than guess. The
mail servers bind where `[mail] pop3/smtp/imap` say; set them to `0.0.0.0:1110`
and friends to serve the LAN. There is no TLS yet, so a LAN-exposed station
sends passwords in the clear: keep it behind a trusted network.

## Configuration

Created on first start (mode 0600, secret generated). Relative paths resolve
against the file's own directory:

```toml
[server]
listen = "127.0.0.1:8080"
secret = "…"                 # session signing key
store_key = "…"              # seals Winlink passwords at rest (separate key)
tls = "off"                  # or "files" with cert/key
cert = ""
key = ""
ui_dir = ""                  # empty: the build shipped with rfmail

[mail]
access = "very strict"       # or "strict" with cidrs
cidrs = []
pop3 = "127.0.0.1:1110"       # ports below 1024 need privileges
smtp = "127.0.0.1:1025"       # 25 needs privileges
imap = "127.0.0.1:1143"       # 143 needs privileges

[database]
driver = "sqlite"
path = "rfmail.db"
```

`very strict` accepts loopback peers only; `strict` accepts the listed CIDRs
(and loopback). The same policy governs the web API and all three mail servers.
Empty `smtp`/`imap` strings keep that service off.

## Using a mail client

| Setting | Value |
| --- | --- |
| Server | `127.0.0.1` |
| POP3 | `1110` — INBOX only |
| IMAP | `1143` — every folder |
| SMTP submission | `1025` — `AUTH` required once the account has a password |
| User | your callsign — `OK4RM`; `ok4rm` and `OK4RM@winlink.org` are the same name |
| Password | the *mail* password from the Account page, not the Winlink one |
| Security | none on loopback; TLS is not implemented yet |

The username is the callsign: it is the account, the mailbox and the login at
every door, and it is matched without regard to case. A mail program that fills in
`OK4RM@winlink.org` from the address therefore authenticates without being
corrected. There is no separate account name. The password is the mail password set on
the Account page's Password section — the Winlink password beside the callsign is
a different secret and will not be accepted here.

Your mail program sees Winlink addresses with the domain, so type
`OK4RM@winlink.org` as your address and as the address of any other Winlink user.
The browser client and the database show the bare callsign (`OK4RM`): the domain
exists only so a mail program has a syntactically complete address. The store keeps the bare callsign, which is the form a
radio session and a gateway use; an ordinary internet address such as
`jane@example.org` passes through untouched.

POP3 serves INBOX only, and deleting there removes the message when the session
ends, as POP3 specifies; deleting in the web client moves it to TRASH. IMAP sees
all five folders. Submission through SMTP lands in OUTBOX, where the radio side
will pick it up; the sender address must be the account's callsign.

## Post office

The station can answer calls as well as make them: it terminates the B2F session
itself and holds mail for its own accounts, with no Winlink gateway registration.

1. Accounts → mark one account as the **post office owner**. Its callsign is what the
   station answers as.
2. On that account (or on the Accounts page), set a **post-office password** — this is
   what a station with no Winlink registration answers the challenge with. A Winlink
   password works too, and either one authenticates.
3. Post office → pick a modem, type the dial frequency (kHz below 10 MHz, MHz above)
   and **Start answering**. The radio is tuned first; if its `rigctld` link is down the
   station refuses rather than listening on a frequency nobody chose.

Mail a caller leaves is filed in the INBOX of every local callsign it names. Mail
waiting for the caller is offered once: collected mail stays in the mailbox but is
marked as collected. Mail for a callsign no account holds is deferred when the caller
names the recipient, and otherwise held in the owner's mailbox and logged.

## Command line

```sh
npm run cli -- info
npm run cli -- user add OK1ABC --admin
npm run cli -- user passwd OK1ABC
npm run cli -- import message.eml --user OK1ABC
```

`import` parses RFC 822 (multipart, charsets, encoded words) and stores the
message in INBOX — useful for trying the UI or POP3 without a radio.

## Checks

```sh
npm run check   # tsc for the backend + svelte-check for the client (0 warnings)
npm test        # 171 tests: message codec, LZHUF, B2F exchange, sessions, the
                # post office, store, HTTP API, POP3, SMTP, IMAP, HTML sanitiser
```

## Layout

```
packages/shared      API types shared by server and browser
packages/core-b2f    message model, RFC 822 parse/serialise, MID
packages/store       store contract, SQLite adapter, schema, scrypt passwords
packages/mailservers POP3, SMTP and IMAP servers, peer access policy, events
packages/server      config, HTTP router, sessions, API, sanitiser, static files
apps/backend         entry point and CLI
apps/web             SvelteKit client (static build)
test/                node:test suites
```

The backend runs TypeScript directly (Node's type stripping); there is no build
step for it. `REQUIREMENTS.md` is the contract and `DEVELOPMENT.md` the plan.

Where the work stands, how to run it, and what is next: see
[PICKUP.md](PICKUP.md).
