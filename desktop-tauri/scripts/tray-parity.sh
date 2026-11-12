#!/bin/sh
# Renders the original macOS menu-bar strip (Swift sources) and the Rust strip from the
# SAME overview JSON, offscreen, and compares them. macOS only (swiftc + ImageMagick).
#
#   TRAY_OLD_SRC=<dir with the Swift sources> TRAY_FIXTURE=<overview.json> \
#     desktop-tauri/scripts/tray-parity.sh [outdir]
#
# Exit 0 when fewer than TRAY_MAX_DIFF (default 0.02) of the pixels differ beyond a 25% colour
# fuzz. The two sides use different font engines, so exact pixel equality is not reachable;
# the fuzz absorbs anti-aliasing while a wrong case, colour, icon or column moves the ratio.
#
# TRAY_MUTATE=case|color renders a deliberately broken copy of the Rust strip (names not
# upper-cased, or a wrong warning colour). The script must then exit non-zero: that proves the
# bar can fail. The source file is restored on exit.
set -eu
: "${TRAY_OLD_SRC:?directory with the Swift sources}" "${TRAY_FIXTURE:?overview json}"
OUT="${1:-$(mktemp -d)}"
MAX="${TRAY_MAX_DIFF:-0.02}"
SCREEN="${TRAY_SCREEN_W:-1920}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT/srv/api" "$OUT/src"
cp "$TRAY_FIXTURE" "$OUT/srv/api/overview"
cp -R "$TRAY_OLD_SRC"/*.swift "$TRAY_OLD_SRC/assets" "$OUT/src/"
# The old strip also draws a pace gauge; it is out of this comparison, so switch it off.
python3 - "$OUT/src/ClaudeUsage.swift" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
sig = "func barPace(_ snap: Overview?) -> (ratio: Double, color: NSColor?)? {"
t = t.replace(sig, sig + '\n    if ProcessInfo.processInfo.environment["NO_PACE"] != nil { return nil }', 1)
open(p, "w").write(t)
PY
(cd "$OUT/src" && swiftc -O ClaudeUsage.swift ProviderIcon.swift MacStats.swift ProcessWindow.swift ProcessTable.swift ProcCensus.swift main.swift -o strip-old 2>/dev/null)
PORT="${TRAY_PORT:-3999}"
(cd "$OUT/srv" && python3 -m http.server "$PORT" >/dev/null 2>&1 & echo $! >"$OUT/pid")
trap 'kill "$(cat "$OUT/pid")" 2>/dev/null || true' EXIT
sleep 1
NO_PACE=1 USAGE_HUB_URL="http://127.0.0.1:$PORT" TRAY_BAR_H=22 "$OUT/src/strip-old" --snapshot "$OUT/old.png"
SRC="$HERE/src-tauri/src/tray_quota.rs"
case "${TRAY_MUTATE:-}" in
  case) cp "$SRC" "$OUT/tray_quota.rs.orig"; trap 'cp "$OUT/tray_quota.rs.orig" "$SRC"; kill "$(cat "$OUT/pid")" 2>/dev/null || true' EXIT
        sed -i '' 's/label.to_uppercase()/label.to_string()/' "$SRC" ;;
  color) cp "$SRC" "$OUT/tray_quota.rs.orig"; trap 'cp "$OUT/tray_quota.rs.orig" "$SRC"; kill "$(cat "$OUT/pid")" 2>/dev/null || true' EXIT
         sed -i '' 's/"warning" => (\[255, 145, 46\]/"warning" => ([255, 159, 10]/' "$SRC" ;;
esac
(cd "$HERE/src-tauri" && TRAY_SNAPSHOT_OUT="$OUT/new-raw.png" TRAY_SNAPSHOT_JSON="$TRAY_FIXTURE" \
  TRAY_SNAPSHOT_SCREEN_W="$SCREEN" cargo test -q --lib tray_quota::tests::snapshot >/dev/null 2>&1)
magick "$OUT/old-bar.png" -alpha off "$OUT/old-flat.png"
magick "$OUT/new-raw.png" -background gray12 -alpha remove -alpha off "$OUT/new-flat.png"
RATIO=$(magick compare -fuzz 25% -metric AE "$OUT/old-flat.png" "$OUT/new-flat.png" "$OUT/diff.png" 2>&1 >/dev/null | sed -n 's/.*(\([0-9.e+-]*\)).*/\1/p')
echo "old=$(identify -format %wx%h "$OUT/old-flat.png") new=$(identify -format %wx%h "$OUT/new-flat.png") differing=$RATIO max=$MAX out=$OUT"
# Colour check: the fuzz hides a slightly wrong tint, so every saturated colour that dominates
# the original (bars, status text) must exist in the new strip within 8 levels per channel.
python3 - "$OUT/old-flat.png" "$OUT/new-flat.png" <<'PY'
import sys
from collections import Counter
from PIL import Image
def dominant(path):
    px = Image.open(path).convert("RGB").getdata()
    return Counter(p for p in px if max(p) - min(p) > 60)
old, new = dominant(sys.argv[1]), dominant(sys.argv[2])
bad = [c for c, n in old.items() if n >= 40 and min(max(abs(a - b) for a, b in zip(c, d)) for d in new) > 8]
if bad:
    print("colour mismatch (original colour missing in the new strip):", sorted(bad))
    sys.exit(1)
PY
awk -v r="$RATIO" -v m="$MAX" 'BEGIN { exit (r < m ? 0 : 1) }'
