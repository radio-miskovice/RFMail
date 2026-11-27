# The post office application

This is the design record for `apps/postoffice` — the station that answers calls. It is a
separate application from the Winlink client in `apps/backend`, sharing the B2F engine, the
mail store, the modem driver and the rig client, and nothing else (decision 57).

The client is a person's station: one callsign, one mailbox, a browser to read it, and a
dial to make. The post office is a station that other people's stations call: it holds
mailboxes for many callsigns, none of which can sign in to a browser, and it is run by
administrators who are not mailboxes (decision 58).

---

## 1. What it starts

    console     HTTP + the built SPA, on loopback by default
    store       SQLite: mailboxes, messages, administrators, the call log
    post office the answering half of the B2F exchange, armed on one modem

It does **not** start: POP3, SMTP or IMAP (a post office's users collect over the radio, and
no mailbox here has a password a mail program could use); outbound sessions (the station
answers, it does not dial); a gateway relay; the RMS catalogue.

The console is the only door, and it is for administrators.

---

## 2. Installation

`deploy/install-postoffice.sh`, run as root on the station:

```sh
sudo deploy/install-postoffice.sh                 # /opt, /etc, /var/lib, systemd
deploy/install-postoffice.sh --no-service ...     # files and config only, run it yourself
deploy/install-postoffice.sh --dry-run            # say what it would do
deploy/install-postoffice.sh --uninstall          # stop and remove the unit, keep the data
```

What it does, and why each part is what it is:

* **A service account** (`rfmail-postoffice`, no shell, no home of its own). The station runs
  unattended; nothing needs to be a login. `--no-service` skips this — an operator running the
  station under their own account is a legitimate deployment.
* **A copy of the tree** into `/opt/rfmail-postoffice`, `node_modules` included, because the
  backend is run directly by Node with no build step of its own. `.git`, build caches and any
  `*.db` are left out. The copy means the checkout can move or be deleted.
* **One configuration file**, `/etc/rfmail-postoffice/postoffice.toml`, written once with both
  keys generated. Re-running the installer never overwrites it: it holds the session secret and
  the key that seals mailbox passwords, and replacing either would sign every administrator out
  or make every stored post-office password unreadable.
* **A systemd unit**, `rfmail-postoffice.service`, with `Restart=always`, a 30-second stop
  timeout (disarming tells the modem to stop listening and waits for the link to come down), and
  the usual hardening — `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome`, and a single
  writable path which is the data directory.
* **The console's listener** defaults to `127.0.0.1:8090`. Reaching it from the LAN is two edits
  the installer prints: `listen = "0.0.0.0:8090"` and `[access] mode = "strict"` with a CIDR.
  A bare `0.0.0.0` with `very strict` is accepted and warned about, because a station that
  answers nothing looks broken.

The console must already be built (`npm run build:postoffice`). The installer refuses without
it rather than shipping a station whose screen is a placeholder: a radio PC should not need a
Node toolchain to be repaired.

**Upgrading** is the same command with the new tree: files and unit are replaced, the
configuration and the database are not. **Windows** is a real target — VARA and most stations
are on it — and needs a service wrapper (`nssm`, or a scheduled task) rather than systemd;
that script does not exist yet and is recorded as the next platform task, not pretended.

### What the unit trusts

The station answers calls without anybody watching, so the unit is written for that: it
restarts on failure, it is stopped with SIGTERM and given time to disarm, and it cannot write
anywhere except its database directory. It has no `HOME` and therefore no `~/.config` to hide
a second configuration in.

---

## 3. The console

Four screens, one page, no user-facing mail reader. Everything is a table or a form; there are
no explanatory paragraphs where a word will do.

### Station

    ● ARMED     VARA HF 192.168.1.20 listening as OK4RM      [modem ▾]  [Disarm]
    ● CALL      OK1RAA · 41 s
    ● DISARMED  not listening
    ● FAULT     the modem closed the connection

One lamp and one word. Green = listening, amber = a call is up (with the caller and how long),
grey = deliberate and dark red = it stopped by itself with the reason on the same line. The
modem picker and one button; arming is `MYCALL` + `LISTEN ON`, disarming is `LISTEN OFF` and a
waited-out link.

Below it, two panels:

* **Modems** — the configured modems, with protocol, `host:port` and Remove. Adding one is a
  short form: protocol, address, command and data ports, prefilled from the vendor numbers for
  the protocol chosen. A modem that is answering calls cannot be removed.
* **Recent calls** — the last twenty calls: time (UTC, with the Z), caller, result, messages in
  and out, duration, and the reason when it is not `complete`.

The screen asks the API again every five seconds while it is open, so a call appearing needs no
reload.

### Mailboxes

One row per callsign: messages, size, password set or not, enabled or disabled, and — except for
the station's own row, which is marked and has no actions — Enable/Disable, Delete, and a
password button. The add form is a callsign and an optional post-office password.

A mailbox is not an account: it has no password hash, no session and no route, and nothing in
the console lets one sign in. Its post-office password is sealed, never shown again, and is only
ever used to recompute a caller's `;PR` answer.

### Calls

The full call log, newest first — the same rows as the station screen, longer. This is the
first thing a postmaster reads when a user says a message never arrived, because it names the
caller, the time and what the exchange did without exposing anybody's mail.

### Administrators

Name, inspect permission, state, and since when. Adding one is a name, a password, and the
inspect box (unticked). An administrator has no callsign and no mailbox; `inspect` is the
separate right to read other mailboxes' envelope metadata when investigating a problem, never
their message bodies. You cannot disable or delete the administrator you are signed in as, and
the last enabled administrator cannot be removed — computed from the state after the change,
not the row count before it.

### Sign-in and first start

The first page names the station: its callsign (a mailbox) and its first administrator (a
person), in one act. The sign-in form asks for the administrator's name and password. There is
no callsign on it and no "post office" seat — the console *is* the post office.

---

## 4. The call log

Written from the session's own ending, before the station re-arms: caller, start (UTC), elapsed,
result (`complete` / `failed` / `aborted`), messages received and sent, and the reason. It
survives a console restart because it is in the store, not in the process. It carries no
message content by construction, which is what makes it safe to be the troubleshooting surface.

---

## 5. What this first cut does not do

Recorded here so that the gap is a plan rather than an oversight:

* **No rig control.** Arming records nothing about a frequency and writes nothing to a rig: the
  operator tunes the transceiver. The transceiver registry, the tuning before arming, and the
  radio tile arrive with the station screen's second cut. Until then a post office must not be
  armed from a remote console without somebody on the frequency.
* **No envelope inspection.** The `inspect` permission is stored and shown; the view it would
  open (timestamps, from, to, size — never subject or body, audited per read) is the next screen.
* **No native protocol.** The B2F door is the only door, and it is frozen: `;PQ:`/`;PR:`, the
  post-office password verified by recomputation. The native door (a doorbell line, Noise with
  static keys, enrolment over B2F as a system message) is designed in decisions 59–62 and waits.
* **No forwarding, no quotas enforcement on inbound** — the quota is stored and shown, not yet
  applied when mail arrives.
* **Windows service wrapper** — see above.

---

## 6. Reading the code

    apps/postoffice/src/main.ts    entry: config, store, API, listener, shutdown
    apps/postoffice/src/config.ts  the installation's TOML and its two generated keys
    apps/postoffice/src/api.ts     the console's routes; the two principals kept apart
    apps/postoffice-web/           the console (SvelteKit static SPA)
    packages/store/src/schema.ts   MIGRATION_014: administrators and po_calls
    packages/server/src/postoffice.ts  the answering half — shared with the client

The store is opened with `postOffice: true`, which adds exactly one migration: the client's
database never grows tables it has no use for. The token's `uid` is an *administrator* id in
this database and a *mailbox* id in the client's; the two applications never share a file, and
the console's API never resolves its own `uid` through `store.getUser`.
