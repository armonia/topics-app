#!/bin/bash
#
# apply-topics-host-plist.sh — patch the INSTALLED com.armonia.topics-server
# LaunchAgent so it launches the signed "Topics Host.app" and carries
# AssociatedBundleIdentifiers, anchoring TCC (computer-use) to the signed app.
#
# This edits ~/Library/LaunchAgents/com.armonia.topics-server.plist in place
# (with a timestamped backup) but does NOT restart the agent — the change takes
# effect on the next bootout/bootstrap, which you run yourself when convenient
# (it kills the running server + its live sessions). See TCC-COMPUTER-USE.md.
#
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.armonia.topics-server.plist"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Applications}"
HOST_BIN="$INSTALL_DIR/Topics Host.app/Contents/MacOS/topics-host"
BUNDLE_ID="io.armonia.topics.host"
PB=/usr/libexec/PlistBuddy

[ -f "$PLIST" ] || { echo "ERROR: installed plist not found: $PLIST" >&2; exit 1; }
[ -x "$HOST_BIN" ] || { echo "ERROR: host app not built. Run scripts/build-topics-host.sh first ($HOST_BIN missing)" >&2; exit 1; }

BACKUP="$PLIST.bak.$(date +%Y%m%d%H%M%S)"
cp "$PLIST" "$BACKUP"
echo "[apply] backup → $BACKUP"

# --- ProgramArguments → launch the signed host (single element) -----------
$PB -c "Delete :ProgramArguments" "$PLIST" 2>/dev/null || true
$PB -c "Add :ProgramArguments array" "$PLIST"
$PB -c "Add :ProgramArguments:0 string $HOST_BIN" "$PLIST"

# --- AssociatedBundleIdentifiers → anchor the whole job to the signed app --
# (Set if present, else Add. Use a string value; launchd accepts string|array.)
if $PB -c "Print :AssociatedBundleIdentifiers" "$PLIST" >/dev/null 2>&1; then
  $PB -c "Set :AssociatedBundleIdentifiers $BUNDLE_ID" "$PLIST"
else
  $PB -c "Add :AssociatedBundleIdentifiers string $BUNDLE_ID" "$PLIST"
fi

# Validate the resulting plist parses.
plutil -lint "$PLIST" >/dev/null
echo "[apply] patched $PLIST:"
$PB -c "Print :ProgramArguments" "$PLIST"
echo "  AssociatedBundleIdentifiers = $($PB -c 'Print :AssociatedBundleIdentifiers' "$PLIST")"
echo
echo "Not restarted. To apply (kills the running server + live sessions):"
echo "  launchctl bootout gui/\$(id -u)/com.armonia.topics-server 2>/dev/null; \\"
echo "  launchctl bootstrap gui/\$(id -u) \"$PLIST\""
echo
echo "Rollback: cp \"$BACKUP\" \"$PLIST\" && re-bootstrap."
