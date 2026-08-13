#!/bin/bash
#
# apply-topics-host-plist.sh — patch the INSTALLED com.armonia.topics-server
# LaunchAgent so it launches the signed "Topics Host.app" and carries
# AssociatedBundleIdentifiers, anchoring TCC (computer-use) to the signed app.
# It also writes ProcessType, which is what keeps the agent fleet off the
# efficiency cores (see the block further down for the measurement).
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
PROCESS_TYPE="${PROCESS_TYPE:-Interactive}"
PB=/usr/libexec/PlistBuddy

[ -f "$PLIST" ] || { echo "ERROR: installed plist not found: $PLIST" >&2; exit 1; }
[ -x "$HOST_BIN" ] || { echo "ERROR: host app not built. Run scripts/build-topics-host.sh first ($HOST_BIN missing)" >&2; exit 1; }
case "$PROCESS_TYPE" in
  Interactive|Standard|Adaptive) ;;
  Background)
    echo "ERROR: ProcessType=Background would confine the whole fleet. Measured 0.09 core-units under load, against 8.8 for Interactive." >&2
    exit 1 ;;
  *) echo "ERROR: PROCESS_TYPE must be Interactive, Standard or Adaptive (got '$PROCESS_TYPE')" >&2; exit 1 ;;
esac

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

# --- ProcessType: get the fleet off the efficiency cores ------------------
# With no ProcessType key launchd applies reduced resource limits to the job
# AND to everything under it. On Apple Silicon that shows up as the whole tree
# being pushed onto the efficiency cores as soon as the machine is busy. The
# fleet inherits it all the way down: topics-host, start-prod.sh, server.ts,
# the ai-bridge and pty-bridge daemons, and finally every `claude`. The clamp
# is set at launch and is not handed back, so `taskpolicy -B -p <pid>` on the
# running processes does nothing. The only place to fix it is here.
#
# Measured 13/08/2026 on this host (12 cores, 8 performance + 4 efficiency),
# the same tsc run interleaved under load 24:
#   Interactive      2.65 s median, spread 2.58-2.80
#   key absent       4.99 s median   (what the job carries today)
#   inside an agent  4.63 s median, spread 3.63-6.86
# A CPU-bound step of a turn costs 1.75x more inside the clamp, and its
# duration swings by 89% instead of 8%.
#
# Interactive is the only value that moves the needle. Standard measures the
# same as leaving the key out (403-429 against 423-438 Miter per cpu-second,
# 5.7 against 6.0 core-units at 12 threads). It is also the honest trade: the
# fleet stops yielding to the user's foreground apps. Set PROCESS_TYPE=Standard
# to keep today's behaviour with the key written explicitly.
if $PB -c "Print :ProcessType" "$PLIST" >/dev/null 2>&1; then
  $PB -c "Set :ProcessType $PROCESS_TYPE" "$PLIST"
else
  $PB -c "Add :ProcessType string $PROCESS_TYPE" "$PLIST"
fi

# Validate the resulting plist parses.
plutil -lint "$PLIST" >/dev/null
echo "[apply] patched $PLIST:"
$PB -c "Print :ProgramArguments" "$PLIST"
echo "  AssociatedBundleIdentifiers = $($PB -c 'Print :AssociatedBundleIdentifiers' "$PLIST")"
echo "  ProcessType = $($PB -c 'Print :ProcessType' "$PLIST")"
echo
echo "Not restarted. To apply (kills the running server + live sessions):"
echo "  launchctl bootout gui/\$(id -u)/com.armonia.topics-server 2>/dev/null; \\"
echo "  launchctl bootstrap gui/\$(id -u) \"$PLIST\""
echo
echo "Rollback: cp \"$BACKUP\" \"$PLIST\" && re-bootstrap."
