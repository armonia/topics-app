#!/bin/bash
#
# build-topics-host.sh — build, code-sign and install the "Topics Host.app"
# launcher used to anchor macOS TCC (Screen Recording / Accessibility) for the
# Topics production server LaunchAgent, so Claude "computer use" works.
#
# See scripts/TCC-COMPUTER-USE.md for the full rationale + the manual steps that
# must follow (apply the plist, grant TCC, verify). This script does ONLY the
# safe, non-disruptive parts: compile + sign + install the app bundle.
#
# Usage:
#   scripts/build-topics-host.sh              # auto-detect signing identity
#   SIGN_ID="Apple Distribution: …(TEAMID)" scripts/build-topics-host.sh
#   INSTALL_DIR="$HOME/Applications" scripts/build-topics-host.sh
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$APP_DIR/scripts/topics-host"
START_SCRIPT="$APP_DIR/scripts/start-prod.sh"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Applications}"
HOST_APP="$INSTALL_DIR/Topics Host.app"
BUNDLE_ID="io.armonia.topics.host"

[ -f "$START_SCRIPT" ] || { echo "ERROR: start-prod.sh not found at $START_SCRIPT" >&2; exit 1; }

# --- 1. Resolve a stable, team-signed codesigning identity ----------------
# TCC keys the grant to the signature; ad-hoc ("-") is NOT stable and the grant
# silently drops. We require a real identity with a Team Identifier.
if [ -z "${SIGN_ID:-}" ]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -Eo '"[^"]+"' | head -1 | tr -d '"')"
fi
if [ -z "${SIGN_ID:-}" ]; then
  echo "ERROR: no codesigning identity found. Computer-use TCC needs a stable" >&2
  echo "       team-signed identity (Developer ID Application or Apple" >&2
  echo "       Distribution). Install one, or pass SIGN_ID=…" >&2
  exit 1
fi
echo "[topics-host] signing identity: $SIGN_ID"

# --- 2. Compile the Mach-O launcher (baking the server script path) -------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "[topics-host] compiling launcher (START_SCRIPT=$START_SCRIPT)…"
clang -O2 -Wall -Wextra \
  -DSTART_SCRIPT="\"$START_SCRIPT\"" \
  "$SRC/topics-host.c" -o "$WORK/topics-host"

# --- 3. Assemble the .app bundle ------------------------------------------
echo "[topics-host] assembling bundle → $HOST_APP"
rm -rf "$HOST_APP"
mkdir -p "$HOST_APP/Contents/MacOS" "$HOST_APP/Contents/Resources"
cp "$WORK/topics-host" "$HOST_APP/Contents/MacOS/topics-host"
chmod +x "$HOST_APP/Contents/MacOS/topics-host"
cp "$SRC/Info.plist" "$HOST_APP/Contents/Info.plist"
printf 'APPL????' > "$HOST_APP/Contents/PkgInfo"

# --- 4. Code-sign (stable signature → stable TCC grant) -------------------
# No hardened runtime: this launcher only posix_spawns /bin/bash; the bun
# server and node-pty bridge are separately-signed binaries with their own
# signatures, so the host needs no JIT/library entitlements. A stable team
# signature is what TCC keys on.
echo "[topics-host] code-signing…"
codesign --force --timestamp=none \
  --identifier "$BUNDLE_ID" \
  --sign "$SIGN_ID" \
  "$HOST_APP"

# --- 5. Verify + register with Launch Services ----------------------------
echo "[topics-host] verifying signature…"
codesign --verify --strict --verbose=2 "$HOST_APP"
echo "[topics-host] signature details:"
codesign -dvv "$HOST_APP" 2>&1 | grep -E 'Identifier|TeamIdentifier|Authority' | head -5 || true
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "$HOST_APP" 2>/dev/null || true

echo
echo "✅ Built + signed: $HOST_APP"
echo "   bundle id: $BUNDLE_ID"
echo "   launches : /bin/bash $START_SCRIPT"
echo
echo "NEXT (manual — see scripts/TCC-COMPUTER-USE.md):"
echo "  1. Point the server LaunchAgent at this app + add AssociatedBundleIdentifiers:"
echo "       scripts/apply-topics-host-plist.sh        # patches the installed plist (no restart)"
echo "  2. Restart the server agent (kills live server sessions — pick a good moment):"
echo "       launchctl bootout gui/\$(id -u)/com.armonia.topics-server 2>/dev/null; \\"
echo "       launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.armonia.topics-server.plist"
echo "  3. System Settings → Privacy & Security → grant 'Topics Host':"
echo "       • Screen Recording   • Accessibility   (and Automation if prompted)"
echo "  4. Verify the grant reaches Claude (needs sudo):"
echo "       CLAUDE_PID=\$(pgrep -n -f 'claude'); sudo launchctl procinfo \$CLAUDE_PID | grep -i responsible"
echo "       → must show 'Topics Host', not pid 1 / (null)."
