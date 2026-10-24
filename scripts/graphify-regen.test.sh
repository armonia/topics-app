#!/usr/bin/env bash
#
# graphify-regen.test.sh — the gates of graphify-regen.sh, run against temp git
# repos with a fake `graphify` and a fake `sysctl` first on PATH. Run:
# bash scripts/graphify-regen.test.sh
#
# The worker is detached, so each case waits for what the worker leaves behind
# (a log line, or the stamp it writes after a successful run) before it looks
# at the fake graphify's call count. A wait that times out is a failure. The
# fake sysctl prints the formats the real one prints, from files a case can
# change while the worker is waiting.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# GRAPHIFY_REGEN_SCRIPT lets a mutant copy be tested instead of the real script.
SCRIPT="${GRAPHIFY_REGEN_SCRIPT:-$HERE/graphify-regen.sh}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fails=0

mkdir -p "$WORK/bin" "$WORK/sysctl"
cat >"$WORK/bin/graphify" <<'EOF'
#!/usr/bin/env bash
echo "called" >>"$GRAPHIFY_CALLS"
[ -z "${GRAPHIFY_FAIL:-}" ] || exit 1
EOF
cat >"$WORK/bin/sysctl" <<'EOF'
#!/usr/bin/env bash
# `sysctl -n <key>`: prints the value the case wrote to $SYSCTL_DIR/<key>.
cat "$SYSCTL_DIR/${!#}" 2>/dev/null || exit 1
EOF
chmod +x "$WORK/bin/graphify" "$WORK/bin/sysctl"

# The Mac's readings, in the real formats, on a 12-core machine.
printf '12\n' >"$WORK/sysctl/hw.ncpu"
QUIET_LOAD="{ 1.00 1.10 1.20 }"       # 0.08 per core
BUSY_LOAD="{ 60.00 58.10 40.00 }"     # 5.00 per core, over the 4 limit
set_readings() {
  printf '%s\n' "$1" >"$WORK/sysctl/vm.loadavg"
  printf '%s\n' "$2" >"$WORK/sysctl/kern.memorystatus_vm_pressure_level"
}
quiet() { set_readings "$QUIET_LOAD" 1; }
busy() { set_readings "$BUSY_LOAD" 1; }
critical() { set_readings "$QUIET_LOAD" 4; }

# A fresh repo with a graph, as the hook sees a primary checkout. The Mac starts quiet.
new_case() {
  REPO="$WORK/$1"
  CALLS="$REPO/calls"
  mkdir -p "$REPO/graphify-out"
  git -C "$REPO" init -q
  echo '{}' >"$REPO/graphify-out/graph.json"
  : >"$CALLS"
  quiet
}

# Runs the hook from the repo, the way a post-commit hook does.
run_hook() {
  (cd "$REPO" && env PATH="$WORK/bin:$PATH" GRAPHIFY_CALLS="$CALLS" \
    SYSCTL_DIR="$WORK/sysctl" GRAPHIFY_REGEN_DEBOUNCE=0 "$@" bash "$SCRIPT")
}

# Up to 15 s for a command to succeed.
wait_for() {
  local i=0
  until "$@" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge 150 ] && return 1
    sleep 0.1
  done
}

# expect <name> <command...>: waiting for a worker effect; a timeout fails the case.
expect() {
  local name="$1"
  shift
  if wait_for "$@"; then return 0; fi
  fail "$name" "timed out after 15 s waiting for: $*; log=$(cat "$REPO/graphify-out/regen.log" 2>/dev/null)"
  return 1
}

stamped_since() {
  [ "$(cat "$1" 2>/dev/null)" -ge "$2" ] 2>/dev/null
}

logged() {
  /usr/bin/grep -qF -- "$1" "$REPO/graphify-out/regen.log" 2>/dev/null
}

calls() { wc -l <"$CALLS" | tr -d ' '; }

pass() { echo "ok   $1"; }
fail() { echo "FAIL $1 — $2"; fails=$((fails + 1)); }

# check <name> <command...>: passes when the command succeeds right now.
check() {
  local name="$1"
  shift
  if "$@"; then pass "$name"; else fail "$name" "calls=$(calls) log=$(cat "$REPO/graphify-out/regen.log" 2>/dev/null)"; fi
}

# 1. Quiet Mac, no previous run → graphify runs once and the run is stamped.
new_case unloaded
run_hook
expect "unloaded: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "unloaded: graphify called once" [ "$(calls)" = 1 ]

# 2. Busy (load 5.00/core) and then quiet: the rebuild is held, not lost. The
# commit's request is kept by the waiting worker, which runs once the Mac is quiet.
new_case busy-then-quiet
busy
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1
expect "busy: wait logged" logged "rimandato: load 5.00/core sopra 4"
check "busy: graphify not called while busy" [ "$(calls)" = 0 ]
quiet
expect "busy then quiet: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "busy then quiet: graphify called once, after the wait" [ "$(calls)" = 1 ]

# 3. Memory pressure at warn (2) is not busy: the rebuild runs.
new_case pressure-warn
set_readings "$QUIET_LOAD" 2
run_hook
expect "pressure warn: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "pressure warn: graphify called once" [ "$(calls)" = 1 ]

# 4. Critical memory pressure (4) on a quiet load: held, then forced after the
# max wait, and the forced run is logged with its reason.
new_case forced
critical
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1 GRAPHIFY_REGEN_MAX_WAIT=2
expect "forced: wait logged" logged "rimandato: pressione di memoria critica (4)"
expect "forced: run stamped after the max wait" test -s "$REPO/graphify-out/.regen.last"
check "forced: forzato logged with the reason" logged "forzato (pressione di memoria critica (4))"
check "forced: graphify called once" [ "$(calls)" = 1 ]

# 5. Last rebuild 1 s ago, minimum 3 s → the worker waits the remainder, then runs.
new_case min-interval
echo "$(( $(date +%s) - 1 ))" >"$REPO/graphify-out/.regen.last"
start="$(date +%s)"
run_hook GRAPHIFY_REGEN_MIN_INTERVAL=3
expect "min interval: wait logged" logged "rimandato: ultimo rebuild"
check "min interval: graphify not called before the wait ends" [ "$(calls)" = 0 ]
expect "min interval: run stamped after the wait" stamped_since "$REPO/graphify-out/.regen.last" "$start"
check "min interval: graphify called once" [ "$(calls)" = 1 ]

# 6. Last rebuild 5000 s ago, past the default minimum → runs and re-stamps.
new_case stale
echo "$(( $(date +%s) - 5000 ))" >"$REPO/graphify-out/.regen.last"
start="$(date +%s)"
run_hook
expect "stale stamp: run re-stamped" stamped_since "$REPO/graphify-out/.regen.last" "$start"
check "stale stamp: graphify called once" [ "$(calls)" = 1 ]

# 7. graphify exits 1 → the run is logged as failed and nothing is stamped.
new_case failing
run_hook GRAPHIFY_FAIL=1
expect "failure: exit code logged" logged "graphify uscito con codice 1"
check "failure: graphify called once" [ "$(calls)" = 1 ]
check "failure: .regen.last not written" [ ! -e "$REPO/graphify-out/.regen.last" ]

echo
if [ "$fails" -gt 0 ]; then echo "$fails failure(s)"; exit 1; fi
echo "all cases pass"
