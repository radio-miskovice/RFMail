# Picking this up

Written the night of 24 November 2026. Everything below was run, measured or read
from the real thing — where it was not, it says so.

Repository `/home/jvavruska/dev/rfmail`, branch `main`, commit `51d8cb4`
("rfmail: mail, rig control, gateway catalogue and the modem layer"), working tree
clean. 124 tests pass.

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

**Connect test.** "Start session" tunes the radio, dials the gateway, reports what
the modem said (`connected` / `failed` / `error`) and hangs up. No B2F exchange yet.

---

## Running it

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"   # the system npm is broken

cd /home/jvavruska/dev/rfmail
npm test                                    # 124 pass
npx tsc -p tsconfig.json                    # clean
npm --workspace apps/web run check          # svelte-check, 0/0
npm --workspace apps/web run build          # static site the backend serves
```

The test instance, which is the one that was left running:

```bash
T=$HOME/.hermes/cache/scratch/rfmail-phase2
HOME="$T/home" node apps/backend/src/main.ts --config "$T/rfmail.toml" --log info
```

* UI <http://192.168.133.207:8082>
* POP3 1110, SMTP 1025, IMAP 1143, all on `0.0.0.0`, access `strict` with
  `192.168.132.0/23`
* config `$T/rfmail.toml`; database `$T/home/.local/share/rfmail/rfmail.db`, schema
  v6, migrations 1–6
* accounts jvavruska (OK1ABC, admin, **no mail password**), ok4rm (OK4RM),
  operator (OK2XYZ, has a password set while testing)
* modems: ARDOP `192.168.133.222:8515`+8516, Data2G `.222:8300`+8301+KISS 8100,
  VARA FM `192.168.132.6:8300`, VARA HF `.222:8300`, XARA `192.168.133.50:8300`

---

## The one thing that is blocked

**Data2G is running on 192.168.133.222 but is not reachable from this machine.**
A full TCP scan of that host finds only 135, 139, 445, 3389, 4532 (rigctld), 5040,
5357, 7680 and the Windows RPC range. Port 8300 answers `ECONNREFUSED` in 0 ms — the
host itself saying nothing listens there, not a firewall dropping packets.

Data2G's own defaults explain it (`data2g/host.py`):

```
--host          default "127.0.0.1"    the command/data listener
--command-port  default 8300           data on the next port
--kiss-address  default "127.0.0.1"
--kiss-port     default 8100
```

So it listens on loopback inside that Windows box. To let rfmail (on
192.168.133.207) reach it, any one of:

1. start Data2G with `--host 0.0.0.0` (and `--kiss-address 0.0.0.0` for KISS);
2. run rfmail's backend on that machine and point the modem at `127.0.0.1`;
3. `netsh interface portproxy add v4tov4 listenport=8300 connectaddress=127.0.0.1
   connectport=8300` on that machine.

Confirm first with `netstat -ano | findstr :8300` there: `127.0.0.1:8300` means
loopback-only; `0.0.0.0:8300` means the refusal is coming from something else and is
worth chasing further.

---

## Tomorrow, in order

1. **Make Data2G reachable** (above), then confirm the app agrees: the Modems page
   should turn Data2G's dot green within ten seconds, and the Session screen should
   stop marking it *not running*.
2. **Run the connect test for real**: digital mode Data2G, target `OK1RAA`, dial
   `3597.0 kHz`, transceiver `TS-590S` connected (rigctld answers on
   `192.168.133.222:4532`, the radio was left on 3597.0 kHz PKTUSB). This one
   **transmits** — it tunes, dials and hangs up after the call settles. Expect
   `connected` or `failed` (no answer), with the modem's own lines in the report.
3. **Then the B2F exchange**, which is what turns a connect test into a session.
   Already written and tested: proposal lines (`packages/core-b2f/src/proposal.ts`),
   the transfer framing (`\x01`/`\x02` 125-byte payloads/`\x04`), LZHUF, the address
   and RFC 5322 layers. Not written: the session state machine over the modem's data
   stream, the CMS secure-login handshake, and feeding proposals from the OUTBOX and
   into the store. The reference is `~/.hermes/cache/scratch/wl2k-go/fbb/*.go`
   (`b2f.go`, `secure.go`, `proposal.go`) and `pat` under `/home/jvavruska/dev/pat`.

---

## Decisions taken (REQUIREMENTS.md §12, and R3.0 / R4.4.0 / R4.4.05)

* **14** No operator class: any account configures the station's radios and modems;
  the `admin` role only administers other accounts.
* **15** Facts and estimates are labelled apart — distance and bearing are computed,
  "estimated quality" is a heuristic and says so until VOACAP replaces it.
* **16** Service codes are access classes: `PUBLIC` open to all, `EMCOMM`
  emergency-only (listed only when the emergency box is ticked), and `XARA`,
  `MERCURY`, `DATA2G` are classes that belong to one modem each — a `DATA2G` channel
  is not an ordinary VARA channel, whatever its mode string says.
* One callsign per account; VARA and XARA speak the same interface, so either can run
  a VARA session and either can work a VARA or XARA channel.

---

## Open questions

1. **Data2G bandwidths**: you said 200/500/2300; `data2g/host.py` upstream takes
   `BW500`, `BW1200`, `BW2300`, `BW2750`. I set the modem to the four the source
   accepts. Tell me which your build really answers and I will change it.
2. **VARA HF and XARA-tagged channels**: today a VARA HF modem also sees the one
   channel a gateway listed under `XARA`, since the two speak the same interface. Say
   if that should be strict instead.
3. **EMCOMM**: fetchable and listed only behind the tick-box. Should the emergency
   list ever be the default when the station is in an emergency? Not now, by design.
4. **Thunderbird** was never explained: mail was visible in the web client but not in
   the program. The IMAP replay answered every command correctly, so the suspicion
   fell on the client's "IMAP server directory" or the folder subscription. Worth one
   more look now that the addresses are presented as `CALLSIGN@winlink.org`.

---

## Deliberately not done

* MariaDB and PostgreSQL adapters behind the store contract (SQLite only, by design
  for now).
* Modem parameter screens beyond type/host/ports/rig mode — bandwidth, ARQ retries,
  launch commands, autostart, readiness probes (R3.1 lists them).
* Nothing is transmitted unless a session is started, and nothing is left connected:
  the connect test hangs up on both success and failure.
