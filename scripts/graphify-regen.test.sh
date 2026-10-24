#!/usr/bin/env bash
#
# graphify-regen.test.sh — the gates of graphify-regen.sh, run against temp git
# repos with a fake `graphify` first on PATH. Run: bash scripts/graphify-regen.test.sh
#
# The worker is detached, so each case waits for what the worker leaves behind
# (a skip line in the log, or the stamp it writes after a successful run)
# before it looks at the fake graphify's call count.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# GRAPHIFY_REGEN_SCRIPT lets a mutant copy be tested instead of the real script.
SCRIPT="${GRAPHIFY_REGEN_SCRIPT:-$HERE/graphify-regen.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fails=0

mkdir -p "$WORK/bin"
cat >"$WORK/bin/graphify" <<'EOF'
#!/usr/bin/env bash
echo "called" >>"$GRAPHIFY_CALLS"
EOF
chmod +x "$WORK/bin/graphify"

# A fresh repo with a graph, as the hook sees a primary checkout.
new_case() {
  REPO="$WORK/$1"
  CALLS="$REPO/calls"
  mkdir -p "$REPO/graphify-out"
  git -C "$REPO" init -q
  echo '{}' >"$REPO/graphify-out/graph.json"
  : >"$CALLS"
}

# Runs the hook from the repo, the way a post-commit hook does.
run_hook() {
  (cd "$REPO" && env PATH="$WORK/bin:$PATH" GRAPHIFY_CALLS="$CALLS" \
    GRAPHIFY_REGEN_DEBOUNCE=0 "$@" bash "$SCRIPT")
}

# Up to 15 s for a command to succeed (the box can be at load 50).
wait_for() {
  local i=0
  until "$@" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge 150 ] && return 1
    sleep 0.1
  done
}

stamped_since() {
  [ "$(cat "$1" 2>/dev/null)" -ge "$2" ] 2>/dev/null
}

calls() { wc -l <"$CALLS" | tr -d ' '; }

pass() { echo "ok   $1"; }
fail() { echo "FAIL $1 — $2"; fails=$((fails + 1)); }

# 1. Quiet Mac, no previous run → graphify runs once and the run is stamped.
new_case unloaded
run_hook GRAPHIFY_REGEN_LOAD_OVERRIDE=0.2 GRAPHIFY_REGEN_SWAP_PCT_OVERRIDE=10
wait_for test -s "$REPO/graphify-out/.regen.last"
if [ "$(calls)" = 1 ]; then pass "unloaded: graphify called once"; else fail "unloaded: graphify called once" "calls=$(calls)"; fi

# 2. Load 2.5 per core (over 1.5) → no graphify, request kept, reason logged.
new_case loaded
run_hook GRAPHIFY_REGEN_LOAD_OVERRIDE=2.5 GRAPHIFY_REGEN_SWAP_PCT_OVERRIDE=10
wait_for /usr/bin/grep -q saltato "$REPO/graphify-out/regen.log"
if [ "$(calls)" = 0 ]; then pass "loaded: graphify not called"; else fail "loaded: graphify not called" "calls=$(calls)"; fi
if [ -s "$REPO/graphify-out/.regen.request" ]; then pass "loaded: request file kept"; else fail "loaded: request file kept" "request file gone"; fi
if /usr/bin/grep -q 'load 2.5/core' "$REPO/graphify-out/regen.log"; then pass "loaded: reason logged"; else fail "loaded: reason logged" "$(cat "$REPO/graphify-out/regen.log")"; fi

# 3. Swap at 90% (over 85) with a quiet load → no graphify.
new_case swap
run_hook GRAPHIFY_REGEN_LOAD_OVERRIDE=0.2 GRAPHIFY_REGEN_SWAP_PCT_OVERRIDE=90
wait_for /usr/bin/grep -q saltato "$REPO/graphify-out/regen.log"
if [ "$(calls)" = 0 ]; then pass "swap 90%: graphify not called"; else fail "swap 90%: graphify not called" "calls=$(calls)"; fi

# 4. Last rebuild stamped 100 s ago (minimum 1200 s) → no graphify.
new_case recent
echo "$(( $(date +%s) - 100 ))" >"$REPO/graphify-out/.regen.last"
run_hook GRAPHIFY_REGEN_LOAD_OVERRIDE=0.2 GRAPHIFY_REGEN_SWAP_PCT_OVERRIDE=10
wait_for /usr/bin/grep -q saltato "$REPO/graphify-out/regen.log"
if [ "$(calls)" = 0 ]; then pass "within min interval: graphify not called"; else fail "within min interval: graphify not called" "calls=$(calls)"; fi

# 5. Last rebuild stamped 5000 s ago → graphify runs and re-stamps.
new_case stale
echo "$(( $(date +%s) - 5000 ))" >"$REPO/graphify-out/.regen.last"
start="$(date +%s)"
run_hook GRAPHIFY_REGEN_LOAD_OVERRIDE=0.2 GRAPHIFY_REGEN_SWAP_PCT_OVERRIDE=10
wait_for stamped_since "$REPO/graphify-out/.regen.last" "$start"
if [ "$(calls)" = 1 ]; then pass "after min interval: graphify called once"; else fail "after min interval: graphify called once" "calls=$(calls)"; fi

echo
if [ "$fails" -gt 0 ]; then echo "$fails failure(s)"; exit 1; fi
echo "all cases pass"
