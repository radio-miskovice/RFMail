#!/bin/sh
# Install the rfmail post office as a service.
#
# The post office is a station that answers calls, not a program somebody starts when
# they want their mail: it has to come up at boot, stay up, and be found again after a
# power cut. That is what this script sets up — a service account, a data directory, a
# configuration with generated keys, and a systemd unit.
#
# It does not build anything. The console must already be built (`npm run build:postoffice`
# on a machine with the toolchain); a station that runs unattended should not need one.
#
# Usage:
#   sudo scripts/install-postoffice.sh [options]
#
# Options:
#   --prefix DIR    where the application lives      (default /opt/rfmail-postoffice)
#   --data DIR      where the station's database lives (default /var/lib/rfmail-postoffice)
#   --config FILE   its configuration                 (default /etc/rfmail-postoffice/postoffice.toml)
#   --user NAME     the service account              (default rfmail-postoffice)
#   --listen ADDR   the console's listener           (default 127.0.0.1:8090)
#   --source DIR    the checkout to install          (default: the one this script is in)
#   --no-service    install files and configuration, print how to run it, touch no service
#   --user-service  install as a *user* unit (systemctl --user), no root: prefix, data and
#                   config default under $HOME, and it starts at boot when lingering is on
#   --uninstall     stop, disable and remove the unit; data and configuration are kept
#   --print-unit    print the unit file and exit (for review)
#   --dry-run       say what would happen, change nothing
#
# Re-running it is safe: the configuration is never overwritten, and the unit is.

set -eu

PREFIX=/opt/rfmail-postoffice
DATA=/var/lib/rfmail-postoffice
CONFIG=/etc/rfmail-postoffice/postoffice.toml
SERVICE=rfmail-postoffice
RUN_USER=rfmail-postoffice
LISTEN=127.0.0.1:8090
UNIT_PATH=/etc/systemd/system/rfmail-postoffice.service
SOURCE=$(cd "$(dirname "$0")/.." && pwd)
NO_SERVICE=0
USER_SERVICE=0
UNINSTALL=0
DRY_RUN=0
PRINT_UNIT=0

say() { printf '%s\n' "$*"; }
fail() { printf 'install-postoffice: %s\n' "$*" >&2; exit 1; }
run() {
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '  would run: %s\n' "$*"
	else
		"$@"
	fi
}

while [ $# -gt 0 ]; do
	case "$1" in
	--prefix) PREFIX=${2:?--prefix needs a directory}; shift 2 ;;
	--data) DATA=${2:?--data needs a directory}; shift 2 ;;
	--config) CONFIG=${2:?--config needs a file}; shift 2 ;;
	--user) RUN_USER=${2:?--user needs a name}; shift 2 ;;
	--listen) LISTEN=${2:?--listen needs host:port}; shift 2 ;;
	--source) SOURCE=${2:?--source needs a directory}; shift 2 ;;
	--no-service) NO_SERVICE=1; shift ;;
	--user-service) USER_SERVICE=1; shift ;;
	--uninstall) UNINSTALL=1; shift ;;
	--print-unit) PRINT_UNIT=1; shift ;;
	--dry-run) DRY_RUN=1; shift ;;
	-h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) fail "unknown option: $1" ;;
	esac
done

unit_file() {
	if [ "$USER_SERVICE" -eq 1 ]; then
		cat <<UNIT
[Unit]
Description=rfmail post office ($LISTEN, user unit)
Documentation=file://$PREFIX/POSTOFFICE.md
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$PREFIX
ExecStart=$NODE_BIN $PREFIX/apps/postoffice/src/main.ts --config $CONFIG
Restart=always
RestartSec=5
# Disarming takes a few seconds: the modem is told to stop listening and the link is
# waited out. Never leave a transmitter keyed.
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
		return
	fi
	cat <<UNIT
[Unit]
Description=rfmail post office ($LISTEN)
Documentation=file://$PREFIX/POSTOFFICE.md
After=network-online.target
Wants=network-online.target
# The station answers calls; it should not be restarted just because the network
# came up late, but a modem on another host may appear after us and that is fine.

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$PREFIX
ExecStart=$NODE_BIN $PREFIX/apps/postoffice/src/main.ts --config $CONFIG
Restart=always
RestartSec=5
# Disarming takes a few seconds: the modem is told to stop listening and the link is
# waited out. Give it longer than the default, and never leave a transmitter keyed.
KillSignal=SIGTERM
TimeoutStopSec=30
# A post office needs its own files and nothing else on the machine.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT
}

NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] || fail "node is not on this PATH; install Node 22 or newer"
command -v rsync >/dev/null 2>&1 || fail "rsync is required to install the tree"

# A user unit is the same station run by the operator instead of by root: the files go
# under $HOME and systemd is asked as that user. Lingering decides whether it comes back
# after a reboot without a login; the installer says so at the end.
if [ "$USER_SERVICE" -eq 1 ]; then
	NO_SERVICE=0
	[ "$PREFIX" = /opt/rfmail-postoffice ] && PREFIX="${HOME}/.local/opt/rfmail-postoffice"
	[ "$DATA" = /var/lib/rfmail-postoffice ] && DATA="${HOME}/.local/share/rfmail-postoffice"
	[ "$CONFIG" = /etc/rfmail-postoffice/postoffice.toml ] &&
		CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/rfmail-postoffice/postoffice.toml"
	UNIT_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/rfmail-postoffice.service"
fi

if [ "$PRINT_UNIT" -eq 1 ]; then
	unit_file
	exit 0
fi

if [ "$UNINSTALL" -eq 1 ]; then
	say "Removing the $SERVICE service (data and configuration are kept)."
	if [ "$USER_SERVICE" -eq 1 ]; then
		run systemctl --user disable --now "$SERVICE" || true
	else
		run systemctl disable --now "$SERVICE" || true
	fi
	run rm -f "$UNIT_PATH"
	run systemctl daemon-reload
	say "  data   $DATA"
	say "  config $CONFIG"
	say "  remove them by hand when you are sure you want them gone."
	exit 0
fi

[ -d "$SOURCE" ] || fail "source directory does not exist: $SOURCE"
[ -f "$SOURCE/apps/postoffice/src/main.ts" ] || fail "$SOURCE is not the rfmail tree"
# A prefix inside the tree being copied (or the other way round) would copy the tree into
# itself, which rsync then walks forever.
SOURCE_REAL=$(cd "$SOURCE" && pwd -P)
PREFIX_REAL=$(cd "$(dirname "$PREFIX")" 2>/dev/null && pwd -P || printf '%s' "$PREFIX")/$(basename "$PREFIX")
case "$PREFIX_REAL" in
	"$SOURCE_REAL"/*) fail "the prefix ($PREFIX) is inside the source tree ($SOURCE)" ;;
esac
case "$SOURCE_REAL" in
	"$PREFIX_REAL"/*) fail "the source tree ($SOURCE) is inside the prefix ($PREFIX)" ;;
esac

[ -f "$SOURCE/apps/postoffice-web/build/index.html" ] || fail \
	"the console is not built: run 'npm run build:postoffice' in $SOURCE first"

if [ "$NO_SERVICE" -eq 0 ] && [ "$USER_SERVICE" -eq 0 ] && [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
	fail "installing a service needs root; run with sudo, or use --no-service for a user-run install"
fi

say "rfmail post office"
say "  source   $SOURCE"
say "  prefix   $PREFIX"
say "  data     $DATA"
say "  config   $CONFIG"
say "  listen   $LISTEN"
say "  account  $RUN_USER"
say ""

# -- the service account ------------------------------------------------------
#
# A station account with no shell and no home of its own: it may read the application and
# write its database, and nothing else. In --no-service mode the operator runs the
# station themselves, so there is no account to make.

if [ "$NO_SERVICE" -eq 0 ] && [ "$USER_SERVICE" -eq 0 ]; then
	if ! id -u "$RUN_USER" >/dev/null 2>&1; then
		run useradd --system --no-create-home --home-dir "$DATA" --shell /usr/sbin/nologin "$RUN_USER"
	else
		say "  account $RUN_USER already exists"
	fi
fi

# -- the files ----------------------------------------------------------------

# A copy, not a link: an operator may move or delete the checkout, and a running station
# must not care. node_modules travels with it because the backend is run directly by
# node, with no build step of its own.
if [ "$DRY_RUN" -eq 1 ]; then
	say "  would copy $SOURCE to $PREFIX"
else
	mkdir -p "$PREFIX"
	rsync -a --delete \
		--exclude '.git' \
		--exclude '*.db' \
		--exclude '*.db-wal' \
		--exclude '*.db-shm' \
		--exclude 'apps/web/.svelte-kit' \
		--exclude 'apps/postoffice-web/.svelte-kit' \
		"$SOURCE"/ "$PREFIX"/
fi

run mkdir -p "$DATA"
run mkdir -p "$(dirname "$CONFIG")"

# The workspace packages are TypeScript that node runs directly, and node refuses to strip
# types for a file under node_modules. The link is what puts the real path outside
# node_modules, so it is load-bearing: a tree whose links were lost (unpacked from an
# archive that stored them as files) refuses to start with
# ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. Re-create them, whatever arrived.
if [ "$DRY_RUN" -eq 0 ] && [ -d "$PREFIX/packages" ]; then
	mkdir -p "$PREFIX/node_modules/@rfmail"
	for package in "$PREFIX"/packages/*; do
		[ -d "$package" ] || continue
		ln -sfn "$package" "$PREFIX/node_modules/@rfmail/$(basename "$package")"
	done
fi

# -- the configuration --------------------------------------------------------
#
# Written once and never again: it holds the two generated keys, and overwriting it would
# sign every administrator out and make the sealed mailbox passwords unreadable.

if [ -f "$CONFIG" ]; then
	say "  config already exists, left alone"
else
	if [ "$DRY_RUN" -eq 1 ]; then
		say "  would write $CONFIG (mode 0600, keys generated on first start)"
	else
		SECRET=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
		STORE_KEY=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')
		umask 077
		cat >"$CONFIG" <<EOF
# rfmail post office configuration
#
# Secrets live in this file (keep it mode 0600). Mailboxes, administrators and the
# station's callsign live in the database. Relative paths resolve against this file.

[server]
listen = "$LISTEN"
# Session signing secret. Changing it signs every administrator out.
secret = "$SECRET"
# Key that seals the mailboxes' post-office passwords at rest. Changing it makes those
# passwords unreadable: set them again.
store_key = "$STORE_KEY"
tls = "off"
cert = ""
key = ""
ui_dir = ""

[access]
# Who may reach the console. "very strict" is loopback only; "strict" also admits the
# CIDRs below. Enforced on every accepted connection.
mode = "very strict"
cidrs = []

[database]
driver = "sqlite"
path = "$DATA/postoffice.db"
EOF
		chmod 0600 "$CONFIG"
		say "  wrote $CONFIG"
	fi
fi

if [ "$NO_SERVICE" -eq 0 ] && [ "$USER_SERVICE" -eq 0 ]; then
	run chown -R "$RUN_USER:$RUN_USER" "$DATA"
	run chown root:"$RUN_USER" "$CONFIG"
	run chmod 0640 "$CONFIG"
	# The application itself is only read by the service, so root owns it.
	run chown -R root:root "$PREFIX"
fi

# -- the service --------------------------------------------------------------

if [ "$NO_SERVICE" -eq 1 ]; then
	say ""
	say "No service was installed. To run the station under this account:"
	say "  $NODE_BIN $PREFIX/apps/postoffice/src/main.ts --config $CONFIG"
	exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
	say "  would write $UNIT_PATH"
else
	mkdir -p "$(dirname "$UNIT_PATH")"
	unit_file >"$UNIT_PATH"
	chmod 0644 "$UNIT_PATH"
	say "  wrote $UNIT_PATH"
	if [ "$USER_SERVICE" -eq 1 ]; then
		run systemctl --user daemon-reload
		run systemctl --user enable --now "$SERVICE"
	else
		run systemctl daemon-reload
		run systemctl enable --now "$SERVICE"
	fi
fi

say ""
say "The console is at http://$LISTEN — the first page names the station and its administrator."
if [ "$USER_SERVICE" -eq 1 ]; then
	say "Logs:      journalctl --user -u $SERVICE -f"
	if [ "$(loginctl show-user "$(id -un)" 2>/dev/null | sed -n 's/^Linger=//p')" != "yes" ]; then
		say "Reboot:    it comes back after a reboot only with lingering on:"
		say "             loginctl enable-linger $(id -un)"
	fi
else
	say "Logs:      journalctl -u $SERVICE -f"
fi
say "Reaching it from the LAN needs two changes in $CONFIG:"
say "             listen = \"0.0.0.0:8090\"   and   [access] mode = \"strict\" with a CIDR."
say "Removing:  $0 --uninstall"
