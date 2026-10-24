#!/usr/bin/env bash
#
# graphify-regen.test.sh — the gates of graphify-regen.sh, run against temp git
# repos with a fake `graphify`, `sysctl` and `taskpolicy` first on PATH. Run:
# bash scripts/graphify-regen.test.sh
#
# The worker is detached, so each case waits for what the worker leaves behind
# (a log line, or the stamp it writes after a successful run) before it looks
# at the fake graphify's call count. A wait that times out is a failure. The
# fake sysctl prints the formats the real one prints, from files a case can
# change while the worker is waiting.
#
# scripts/testdata/graphify-regen.origin-main.sh is origin/main's script as it
# was before the lock moved to a pid file: a snapshot, so the test does not
# change with main. It must not be able to steal a lock the new script holds.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# GRAPHIFY_REGEN_SCRIPT lets a mutant copy be tested instead of the real script.
SCRIPT="${GRAPHIFY_REGEN_SCRIPT:-$HERE/graphify-regen.sh}"
LEGACY="$HERE/testdata/graphify-regen.origin-main.sh"
WORK="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$WORK"' EXIT
fails=0

mkdir -p "$WORK/bin" "$WORK/sysctl"
# The fake graphify: counts its calls, can hold the lock while it runs (until
# GRAPHIFY_HOLD is removed), and can take the lock over (write another pid
# into it) before it returns, as a stale reaper would.
cat >"$WORK/bin/graphify" <<'EOF'
#!/usr/bin/env bash
echo "called" >>"$GRAPHIFY_CALLS"
[ -z "${GRAPHIFY_HOLD:-}" ] || while [ -e "$GRAPHIFY_HOLD" ]; do sleep 0.1; done
[ -z "${GRAPHIFY_HIJACK_PID:-}" ] || echo "$GRAPHIFY_HIJACK_PID" >"$GRAPHIFY_HIJACK_LOCK/pid"
[ -z "${GRAPHIFY_FAIL:-}" ] || exit 1
EOF
cat >"$WORK/bin/sysctl" <<'EOF'
#!/usr/bin/env bash
# `sysctl -n <key>`: prints the value the case wrote to $SYSCTL_DIR/<key>. If the
# case left a vm.loadavg.next, this read still sees the old value and then the
# next one sees the new one: the Mac goes busy right after a check passed.
if [ "${!#}" = vm.loadavg ] && [ -f "$SYSCTL_DIR/vm.loadavg.next" ]; then
  cat "$SYSCTL_DIR/vm.loadavg"
  mv "$SYSCTL_DIR/vm.loadavg.next" "$SYSCTL_DIR/vm.loadavg"
  exit 0
fi
cat "$SYSCTL_DIR/${!#}" 2>/dev/null || exit 1
EOF
# The fake taskpolicy records its arguments, then runs the command it was given.
# `-b` takes no value; `-c <class>` takes one.
cat >"$WORK/bin/taskpolicy" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$TASKPOLICY_LOG"
case "$1" in -c) shift 2 ;; *) shift 1 ;; esac
exec "$@"
EOF
chmod +x "$WORK/bin/graphify" "$WORK/bin/sysctl" "$WORK/bin/taskpolicy"

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
  LOCK="$REPO/graphify-out/.regen.lock"
  LOG="$REPO/graphify-out/regen.log"
  mkdir -p "$REPO/graphify-out"
  git -C "$REPO" init -q
  echo '{}' >"$REPO/graphify-out/graph.json"
  : >"$CALLS"
  quiet
}

# Runs a copy of the hook from the repo, the way a post-commit hook does.
# run_with <script> [VAR=value...]
run_with() {
  local script="$1"
  shift
  (cd "$REPO" && env PATH="$WORK/bin:$PATH" GRAPHIFY_CALLS="$CALLS" \
    SYSCTL_DIR="$WORK/sysctl" TASKPOLICY_LOG="$WORK/taskpolicy.log" \
    GRAPHIFY_REGEN_DEBOUNCE=0 "$@" bash "$script")
}
run_hook() { run_with "$SCRIPT" "$@"; }

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
  fail "$name" "timed out after 15 s waiting for: $*; log=$(cat "$LOG" 2>/dev/null)"
  return 1
}

stamped_since() {
  [ "$(cat "$1" 2>/dev/null)" -ge "$2" ] 2>/dev/null
}

logged() {
  /usr/bin/grep -qF -- "$1" "$LOG" 2>/dev/null
}

calls() { wc -l <"$CALLS" | tr -d ' '; }
# calls_is <n>: true when graphify has been called n times. A test expression
# like `test "$(calls)" = 1` would be frozen at its first value inside expect.
calls_is() { [ "$(calls)" = "$1" ]; }

# A live process that stands for a lock owner, and a pid that is dead for sure.
# The child must not keep the caller's stdout: $(live_pid) would wait for it.
live_pid() { sleep 600 >/dev/null 2>&1 & echo $!; }
dead_pid() { sh -c 'exit 0' >/dev/null 2>&1 & local p=$!; wait "$p"; echo "$p"; }

pass() { echo "ok   $1"; }
fail() { echo "FAIL $1 — $2"; fails=$((fails + 1)); }

# check <name> <command...>: passes when the command succeeds right now.
check() {
  local name="$1"
  shift
  if "$@"; then pass "$name"; else fail "$name" "calls=$(calls) log=$(cat "$LOG" 2>/dev/null)"; fi
}

# 1. Quiet Mac, no previous run → graphify runs once and the run is stamped.
new_case unloaded
run_hook
expect "unloaded: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "unloaded: graphify called once" [ "$(calls)" = 1 ]
# 1b. The rebuild runs at background QoS (-b) under nice.
check "unloaded: taskpolicy gets -b and nice" grep -qF -- "-b nice -n 15 graphify update" "$WORK/taskpolicy.log"

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

# 2b. The decimal dot survives an Italian locale: awk there would print 5,00.
if locale -a 2>/dev/null | /usr/bin/grep -qx 'it_IT.UTF-8'; then
  new_case busy-italian-locale
  busy
  run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1 LC_ALL=it_IT.UTF-8
  expect "italian locale: reason keeps the dot" logged "rimandato: load 5.00/core sopra 4"
  quiet
  expect "italian locale: run stamped" test -s "$REPO/graphify-out/.regen.last"
else
  echo "skip italian locale: it_IT.UTF-8 not installed here"
fi

# 2c. A zero busy sleep is clamped to one second: a spin would write thousands of lines.
new_case busy-sleep-zero
busy
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=0
expect "busy sleep zero: first wait logged" logged "rimandato: load"
sleep 2.5
lines="$(/usr/bin/grep -c 'rimandato' "$LOG" 2>/dev/null || echo 0)"
check "busy sleep zero: at most one line per second" [ "$lines" -le 4 ]
quiet
expect "busy sleep zero: run stamped" test -s "$REPO/graphify-out/.regen.last"

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

# 8. A superseded worker exits: two commits both wait on a busy Mac, and only
# the newer request carries the rebuild. The older worker must not run too. The
# minimum interval is off, so a worker that ignored the supersede would run.
new_case superseded
busy
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1 GRAPHIFY_REGEN_MIN_INTERVAL=0
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1 GRAPHIFY_REGEN_MIN_INTERVAL=0
expect "superseded: waiting logged" logged "rimandato: load"
quiet
expect "superseded: run stamped" test -s "$REPO/graphify-out/.regen.last"
# Longer than the 5 s poll of a worker waiting for the lock: a worker that
# ignored the supersede would have got the lock by now.
sleep 6
check "superseded: graphify called once, by the newer worker" calls_is 1

# 9. A live owner holds the lock, even an old one: nothing is reaped, nothing
# runs. When the owner dies, the waiting worker reaps the lock and runs.
new_case live-owner-old-lock
owner="$(live_pid)"
mkdir "$LOCK" && echo "$owner" >"$LOCK/pid"
touch -t 202001010000 "$LOCK"
run_hook
sleep 2
check "live owner: lock not reaped, graphify not called" [ "$(calls)" = 0 ]
check "live owner: lock still names the owner" [ "$(cat "$LOCK/pid")" = "$owner" ]
kill "$owner"
expect "live owner gone: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "live owner gone: graphify called once" [ "$(calls)" = 1 ]

# 10. A dead owner's lock is reaped at once.
new_case dead-owner
dead="$(dead_pid)"
mkdir "$LOCK" && echo "$dead" >"$LOCK/pid"
run_hook
expect "dead owner: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "dead owner: graphify called once" [ "$(calls)" = 1 ]
# The stamp comes before the release: wait for the release, not for the stamp.
expect "dead owner: lock released after the run" test ! -e "$LOCK"

# 11. A worker's exit does not delete a lock that now names someone else: the
# fake graphify hands the lock to a live pid while it runs.
new_case trap-keeps-other-lock
other="$(live_pid)"
run_hook GRAPHIFY_HIJACK_LOCK="$LOCK" GRAPHIFY_HIJACK_PID="$other"
expect "hijack: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "hijack: lock survives the worker's exit" [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$other" ]
kill "$other"

# 12. The main-branch script cannot steal a lock the new script holds: it finds
# the lock old (mtime over 30 min) and its owner live, and must leave it alone.
new_case legacy-cannot-steal
: >"$REPO/hold"
run_hook GRAPHIFY_HOLD="$REPO/hold"
expect "legacy: new worker running under the lock" calls_is 1
touch -t 202001010000 "$LOCK"
run_with "$LEGACY" GRAPHIFY_HOLD="$REPO/hold"
sleep 2
check "legacy: no second graphify run" [ "$(calls)" = 1 ]
check "legacy: lock still held by the new worker" [ -s "$LOCK/pid" ]
rm -f "$REPO/hold"
expect "legacy: new worker's run stamped" test -s "$REPO/graphify-out/.regen.last"

# 13. A lock that is taken while the Mac is busy is given back, not used: the
# owner dies while the Mac is busy, the worker reaps the lock and must wait.
new_case lock-won-while-busy
owner="$(live_pid)"
mkdir "$LOCK" && echo "$owner" >"$LOCK/pid"
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1
sleep 1
busy
kill "$owner"
expect "won while busy: wait logged" logged "rimandato: load 5.00/core sopra 4"
check "won while busy: graphify not called" [ "$(calls)" = 0 ]
quiet
expect "won while busy: run stamped once quiet" test -s "$REPO/graphify-out/.regen.last"
check "won while busy: graphify called once" [ "$(calls)" = 1 ]

# 13b. The Mac goes busy between the check and the lock: a worker that got the
# lock while quiet must re-check after taking it, release it and wait.
new_case busy-after-lock
echo "$BUSY_LOAD" >"$WORK/sysctl/vm.loadavg.next"
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1
expect "busy after lock: wait logged" logged "rimandato: load 5.00/core sopra 4"
check "busy after lock: graphify not called" calls_is 0
check "busy after lock: lock released while waiting" test ! -e "$LOCK"
rm -f "$WORK/sysctl/vm.loadavg.next"
quiet
expect "busy after lock: run stamped once quiet" test -s "$REPO/graphify-out/.regen.last"
check "busy after lock: graphify called once" calls_is 1

# 14. A waiting worker never truncates the log of the run it waits behind: the
# log keeps the running job's line until the waiter wins the lock.
new_case log-kept-while-waiting
: >"$REPO/hold"
run_hook GRAPHIFY_HOLD="$REPO/hold"
expect "log: first run under way" calls_is 1
echo "MARCATORE della corsa in corso" >>"$LOG"
start="$(date +%s)"
run_hook GRAPHIFY_REGEN_MIN_INTERVAL=0 GRAPHIFY_HOLD="$REPO/hold"
sleep 1.5
check "log: running job's line survives a waiting worker" logged "MARCATORE della corsa in corso"
rm -f "$REPO/hold"
# The first run's own stamp would satisfy a stamp wait, so wait for the second call.
expect "log: second run under way" calls_is 2
expect "log: second run finished, lock released" test ! -e "$LOCK"
check "log: graphify called twice, once per run" calls_is 2
check "log: second run stamped" stamped_since "$REPO/graphify-out/.regen.last" "$start"

echo
if [ "$fails" -gt 0 ]; then echo "$fails failure(s)"; exit 1; fi
echo "all cases pass"
