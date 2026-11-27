#!/bin/sh
# Build the Windows single-file installer: a self-extracting .exe holding the station.
#
#   deploy/pack-postoffice.sh [--out DIR] [--no-build] [--sfx FILE]
#
# The payload is a *runtime* tree, not the checkout: the console as built, the post office
# application, the workspace packages, and only the third-party packages those actually
# depend on. The build toolchain (typescript, vite, svelte) stays behind — the target
# machine needs Node and nothing else.
#
# The workspace links are deliberately left out of the archive: `node_modules/@rfmail/*`
# must be links to `packages/*` for Node to run TypeScript at all, and an archive that
# stores them as real directories (a zip does; a 7z from Windows does once extracted) makes
# the station refuse to start with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. The Windows
# installer re-creates them as junctions after the copy.
#
# A self-extracting .exe needs a 7-Zip SFX module — a Windows PE file that is not part of
# the Linux package. Take `7z.sfx` from a 7-Zip for Windows installation (it is in the
# installer, and installed into C:\Program Files\7-Zip) and put it at deploy/7z.sfx, or
# point --sfx at it. Without one, this script still writes the payload and the .7z and says
# how to finish the file on Windows: `copy /b 7z.sfx + config.txt + payload.7z setup.exe`.

set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT="$REPO/dist"
BUILD=1
SFX="$REPO/deploy/7z.sfx"

while [ $# -gt 0 ]; do
	case "$1" in
	--out) OUT=${2:?--out needs a directory}; shift 2 ;;
	--no-build) BUILD=0; shift ;;
	--sfx) SFX=${2:?--sfx needs a file}; shift 2 ;;
	-h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) echo "pack-postoffice: unknown option: $1" >&2; exit 2 ;;
	esac
done

NPM_BIN=$(command -v npm || true)
NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] || { echo "pack-postoffice: node is required" >&2; exit 1; }
command -v 7z >/dev/null 2>&1 || { echo "pack-postoffice: 7z is required" >&2; exit 1; }

if [ "$BUILD" -eq 1 ]; then
	if [ -n "$NPM_BIN" ]; then
		echo "building the console"
		(cd "$REPO" && "$NPM_BIN" --workspace apps/postoffice-web run build >/dev/null)
	fi
fi
[ -f "$REPO/apps/postoffice-web/build/index.html" ] || {
	echo "pack-postoffice: the console is not built (npm run build:postoffice)" >&2
	exit 1
}

VERSION=$("$NODE_BIN" -e 'process.stdout.write(require("./package.json").version)')
STAGE="$OUT/payload"

rm -rf "$STAGE"
mkdir -p "$STAGE/node_modules" "$STAGE/apps" "$STAGE/deploy"

# -- what runs ---------------------------------------------------------------

cp -a "$REPO/packages" "$STAGE/packages"
mkdir -p "$STAGE/apps/postoffice"
cp -a "$REPO/apps/postoffice/src" "$STAGE/apps/postoffice/src"
cp -a "$REPO/apps/postoffice/package.json" "$STAGE/apps/postoffice/package.json"
mkdir -p "$STAGE/apps/postoffice-web"
cp -a "$REPO/apps/postoffice-web/build" "$STAGE/apps/postoffice-web/build"
cp -a "$REPO/package.json" "$STAGE/package.json"
cp -a "$REPO/deploy/install-postoffice.ps1" "$STAGE/deploy/install-postoffice.ps1"
cp -a "$REPO/POSTOFFICE.md" "$STAGE/POSTOFFICE.md"

# -- the third-party closure -------------------------------------------------
#
# Walk the declared dependencies of the workspace packages and of each package found, so
# the payload carries smol-toml and sanitize-html with their own dependencies and nothing
# from the build toolchain.

DEPS=$(cd "$REPO" && "$NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const root = "node_modules";
const seen = new Set();
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const roots = [];
for (const scope of ["packages", "apps"]) {
  if (!fs.existsSync(scope)) continue;
  for (const name of fs.readdirSync(scope)) {
    const file = path.join(scope, name, "package.json");
    if (!fs.existsSync(file)) continue;
    const pkg = read(file);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!dep.startsWith("@rfmail/")) roots.push(dep);
    }
  }
}
const walk = (name) => {
  if (seen.has(name)) return;
  const dir = path.join(root, name);
  if (!fs.existsSync(dir)) return; // an optional dependency that is not installed
  seen.add(name);
  const pkgFile = path.join(dir, "package.json");
  if (!fs.existsSync(pkgFile)) return;
  const pkg = read(pkgFile);
  for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) walk(dep);
};
roots.forEach(walk);
process.stdout.write([...seen].sort().join("\n"));
')

for name in $DEPS; do
	mkdir -p "$STAGE/node_modules/$(dirname "$name")"
	cp -a "$REPO/node_modules/$name" "$STAGE/node_modules/$name"
done

# -- the installer's two files ------------------------------------------------

cat >"$STAGE/config.txt" <<'CONFIG'
;!@Install@!UTF-8!
Title="rfmail post office"
BeginPrompt="Install the rfmail post office on this machine?"
RunProgram="Install.cmd"
;!@InstallEnd@!
CONFIG

# Windows line endings and a BOM-free body: cmd.exe is happy with CRLF only when the file
# is CRLF throughout, and a stray LF makes a batch file skip its last line.
"$NODE_BIN" -e '
const fs = require("node:fs");
const file = process.argv[1];
const text = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
' "$STAGE/config.txt"

cat >"$STAGE/Install.cmd" <<'BATCH'
@echo off
setlocal
rem rfmail post office: self-extracting installer.
rem Node.js 22 or newer is the only prerequisite. Everything else is in this file.
rem Arguments are passed through, e.g.  rfmail-postoffice-setup.exe -Listen 0.0.0.0:8090

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs -Wait"
  exit /b
)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js was not found on PATH. Install Node 22 or newer, then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo Installing the rfmail post office. The console will be at http://127.0.0.1:8090
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\install-postoffice.ps1" -Source "%~dp0." %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo The installer reported an error ^(exit %RC%^).
) else (
  echo Done. Name the station and its first administrator in the console.
)
pause
exit /b %RC%
BATCH

"$NODE_BIN" -e '
const fs = require("node:fs");
const file = process.argv[1];
fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\r?\n/g, "\r\n"), "utf8");
' "$STAGE/Install.cmd"

# -- one file ----------------------------------------------------------------

ARCHIVE="$OUT/rfmail-postoffice-$VERSION-payload.7z"
EXE="$OUT/rfmail-postoffice-$VERSION-setup.exe"
rm -f "$ARCHIVE" "$EXE"
(cd "$STAGE" && 7z a -t7z -mx=9 -m0=lzma2 "$ARCHIVE" ./* >/dev/null)

if [ -f "$SFX" ]; then
	# Layout: module, then config.txt, then the archive — the form 7-Zip's own documentation
	# uses for an installer SFX (`copy /b 7z.sfx + config.txt + payload.7z setup.exe`). The
	# same config.txt is also in the archive root, because some modules read it from there
	# instead; a module that ignores one of the two copies ignores it harmlessly.
	cat "$SFX" "$STAGE/config.txt" "$ARCHIVE" >"$EXE"
	chmod +x "$EXE"
	printf '\n'
	printf '  exe      %s (%s)\n' "$EXE" "$(du -h "$EXE" | cut -f1)"
else
	printf '\n'
	printf '  payload  %s (%s)\n' "$ARCHIVE" "$(du -h "$ARCHIVE" | cut -f1)"
	printf '\n'
	printf 'No SFX module at %s, so the .exe was not built. To finish it on Windows:\n' "$SFX"
	printf '  copy /b 7z.sfx + payload.7z setup.exe     (7z.sfx is in C:\\Program Files\\7-Zip)\n'
	printf 'or put a Windows 7z.sfx at deploy/7z.sfx and run this script again.\n'
fi
printf '\n'
