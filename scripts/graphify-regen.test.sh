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
# change with main. It must not be able to steal a lock the new script holds,
# and the new script must not remove the lock the old one holds (it has no pid).
#
# GRAPHIFY_TEST_SHELL picks the shell that runs the worker (default: bash from
# PATH). On the Mac /bin/bash is 3.2, the shell without BASHPID; case 15 runs
# the worker under /bin/bash whatever this is set to.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# GRAPHIFY_REGEN_SCRIPT lets a mutant copy be tested instead of the real script.
SCRIPT="${GRAPHIFY_REGEN_SCRIPT:-$HERE/graphify-regen.sh}"
LEGACY="$HERE/testdata/graphify-regen.origin-main.sh"
WORKER_SHELL="${GRAPHIFY_TEST_SHELL:-bash}"
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
# The fake find counts its calls, then runs the real one. The script calls find
# once per pass over a lock that has no live owner, so the count tells a worker
# that sleeps between passes from one that spins.
cat >"$WORK/bin/find" <<'EOF'
#!/usr/bin/env bash
echo "called" >>"$FIND_CALLS"
exec /usr/bin/find "$@"
EOF
chmod +x "$WORK/bin/graphify" "$WORK/bin/sysctl" "$WORK/bin/taskpolicy" "$WORK/bin/find"

# The Mac's readings, in the real formats, on a 12-core machine.
printf '12\n' >"$WORK/sysctl/hw.ncpu"
QUIET_LOAD="{ 1.00 1.10 1.20 }"       # 0.08 per core
BUSY_LOAD="{ 60.00 58.10 40.00 }"     # 5.00 per core, over the 1.5 limit
# set_readings <loadavg> <pressure level> [swap used %, default 50]: swap is 10000M in all.
set_readings() {
  printf '%s\n' "$1" >"$WORK/sysctl/vm.loadavg"
  printf '%s\n' "$2" >"$WORK/sysctl/kern.memorystatus_vm_pressure_level"
  local used=$(( ${3:-50} * 100 ))
  printf 'total = 10000.00M  used = %s.00M  free = %s.00M  (encrypted)\n' "$used" "$(( 10000 - used ))" \
    >"$WORK/sysctl/vm.swapusage"
}
quiet() { set_readings "$QUIET_LOAD" 1; }
busy() { set_readings "$BUSY_LOAD" 1; }

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
  : >"$REPO/findcalls"
  quiet
}

# Runs a copy of the hook from the repo, the way a post-commit hook does.
# run_with <script> [VAR=value...]
run_with() {
  local script="$1"
  shift
  (cd "${RUN_DIR:-$REPO}" && env PATH="$WORK/bin:$PATH" GRAPHIFY_CALLS="$CALLS" FIND_CALLS="$REPO/findcalls" \
    SYSCTL_DIR="$WORK/sysctl" TASKPOLICY_LOG="$WORK/taskpolicy.log" \
    GRAPHIFY_REGEN_DEBOUNCE=0 "$@" "$WORKER_SHELL" "$script")
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

find_calls() { wc -l <"$REPO/findcalls" | tr -d ' '; }
# find_calls_at_most <n>: true when the script has called find at most n times.
find_calls_at_most() { [ "$(find_calls)" -le "$1" ]; }
# Ends the workers of a case that may have been left spinning or waiting.
stop_workers() { pkill -f "$SCRIPT" 2>/dev/null || true; }

# A live process that stands for a lock owner, and a pid that is dead for sure.
# The child must not keep the caller's stdout: $(live_pid) would wait for it.
live_pid() { sleep 600 >/dev/null 2>&1 & echo $!; }
dead_pid() { sh -c 'exit 0' >/dev/null 2>&1 & local p=$!; wait "$p"; echo "$p"; }

# The lock names a live process by a plain number.
lock_owner_alive() {
  local p
  p="$(cat "$LOCK/pid" 2>/dev/null)"
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$p" 2>/dev/null
}

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
expect "busy: wait logged" logged "rimandato: load 5.00/core sopra 1.5"
check "busy: graphify not called while busy" [ "$(calls)" = 0 ]
quiet
expect "busy then quiet: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "busy then quiet: graphify called once, after the wait" [ "$(calls)" = 1 ]

# 2b. The decimal dot survives an Italian locale: awk there would print 5,00.
if locale -a 2>/dev/null | /usr/bin/grep -qx 'it_IT.UTF-8'; then
  new_case busy-italian-locale
  busy
  run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1 LC_ALL=it_IT.UTF-8
  expect "italian locale: reason keeps the dot" logged "rimandato: load 5.00/core sopra 1.5"
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

# 3. Memory guard. Swap used 85% (limit 80%) on a quiet load and normal pressure:
# the rebuild is held, not lost, and runs once swap is back under the limit.
new_case swap-high
set_readings "$QUIET_LOAD" 1 85
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1
expect "swap 85%: wait logged" logged "rimandato: swap al 85% (limite 80%)"
check "swap 85%: graphify not called" calls_is 0
set_readings "$QUIET_LOAD" 1 79
expect "swap back to 79%: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "swap back to 79%: graphify called once" calls_is 1

# 3b. Memory pressure 2 (warn) on a quiet load and low swap: held, then runs at 1.
new_case pressure-warn
set_readings "$QUIET_LOAD" 2
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1
expect "pressure 2: wait logged" logged "rimandato: pressione di memoria alta (2)"
check "pressure 2: graphify not called" calls_is 0
set_readings "$QUIET_LOAD" 1
expect "pressure back to 1: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "pressure back to 1: graphify called once" calls_is 1

# 3c. Both memory readings just under their limits (swap 79%, pressure 1): one start.
new_case memory-under-limits
set_readings "$QUIET_LOAD" 1 79
run_hook
expect "memory under limits: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "memory under limits: graphify called once" calls_is 1

# 4. A busy load is held, then forced after the max wait, and the forced run is
# logged with its reason.
new_case forced-load
busy
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1 GRAPHIFY_REGEN_MAX_WAIT=2
expect "forced: wait logged" logged "rimandato: load 5.00/core sopra 1.5"
expect "forced: run stamped after the max wait" test -s "$REPO/graphify-out/.regen.last"
check "forced: forzato logged with the reason" logged "forzato (load 5.00/core sopra 1.5)"
check "forced: graphify called once" calls_is 1

# 4b. Memory is never forced: after the max wait the worker gives up with one
# line and leaves the request, whatever the reading (swap 85, then pressure 4).
new_case memory-never-forced
set_readings "$QUIET_LOAD" 1 85
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1 GRAPHIFY_REGEN_MAX_WAIT=2
expect "memory: wait logged" logged "rimandato: swap al 85% (limite 80%)"
expect "memory: gave up after the max wait" logged "rinunciato (swap al 85% (limite 80%)): richiesta lasciata al prossimo evento"
check "memory: not forced" test "$(/usr/bin/grep -c forzato "$LOG")" = 0
quiet
sleep 2.5
check "memory: the worker is gone, nothing runs when memory frees up" calls_is 0
check "memory: the request is left for the next event" test -s "$REPO/graphify-out/.regen.request"

new_case memory-never-forced-pressure
set_readings "$QUIET_LOAD" 4
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1 GRAPHIFY_REGEN_MAX_WAIT=2
expect "pressure 4: gave up after the max wait" logged "rinunciato (pressione di memoria alta (4))"
check "pressure 4: graphify not called" calls_is 0

# 4c. Load and memory both busy: the load wait is forced at the max wait, and
# the forced run still stops at memory.
new_case forced-load-then-memory
set_readings "$BUSY_LOAD" 1 85
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1 GRAPHIFY_REGEN_MAX_WAIT=2
expect "load then memory: forced on the load" logged "forzato (load 5.00/core sopra 1.5)"
expect "load then memory: gave up on the memory" logged "rinunciato (swap al 85% (limite 80%))"
check "load then memory: graphify not called" calls_is 0

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
expect "won while busy: wait logged" logged "rimandato: load 5.00/core sopra 1.5"
check "won while busy: graphify not called" [ "$(calls)" = 0 ]
quiet
expect "won while busy: run stamped once quiet" test -s "$REPO/graphify-out/.regen.last"
check "won while busy: graphify called once" [ "$(calls)" = 1 ]

# 13b. The Mac goes busy between the check and the lock: a worker that got the
# lock while quiet must re-check after taking it, release it and wait.
new_case busy-after-lock
echo "$BUSY_LOAD" >"$WORK/sysctl/vm.loadavg.next"
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1
expect "busy after lock: wait logged" logged "rimandato: load 5.00/core sopra 1.5"
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

# 15. The worker under /bin/bash, which is 3.2 on the Mac and has no BASHPID: the
# lock must still name a live worker, so a second worker waits instead of
# running next to it. (A worker whose pid came out empty let the second in after
# a second: two rebuilds at once.)
new_case bin-bash-lock
echo "shell for case 15: $(/bin/bash --version | head -1)"
saved_shell="$WORKER_SHELL"
WORKER_SHELL=/bin/bash
: >"$REPO/hold"
run_hook GRAPHIFY_HOLD="$REPO/hold"
expect "/bin/bash: first worker under the lock" calls_is 1
check "/bin/bash: the lock names a live worker" lock_owner_alive
run_hook GRAPHIFY_REGEN_MIN_INTERVAL=0 GRAPHIFY_HOLD="$REPO/hold"
sleep 3
check "/bin/bash: second worker does not run next to the first" calls_is 1
check "/bin/bash: lock still names a live worker" lock_owner_alive
rm -f "$REPO/hold"
expect "/bin/bash: second worker runs once the first is done" calls_is 2
expect "/bin/bash: lock released at the end" test ! -e "$LOCK"
WORKER_SHELL="$saved_shell"

# 16. The old script holds the lock (a directory with no pid file; 29 worktrees
# still run it): the new script waits, it does not remove the lock after a
# second. Once the old one is done, the new one runs.
legacy_lock_untouched() { [ -d "$LOCK" ] && [ ! -e "$LOCK/pid" ]; }
new_case legacy-holds-lock
: >"$REPO/hold"
run_with "$LEGACY" GRAPHIFY_HOLD="$REPO/hold"
expect "old script: running under its lock" calls_is 1
check "old script: its lock has no pid file" legacy_lock_untouched
run_hook GRAPHIFY_HOLD="$REPO/hold"
sleep 3
check "old script: the new one does not run next to it" calls_is 1
check "old script: the new one left its lock alone" legacy_lock_untouched
rm -f "$REPO/hold"
expect "old script done: the new one runs after it" calls_is 2
expect "old script done: new run stamped" test -s "$REPO/graphify-out/.regen.last"

# 17. A lock with no pid that is older than the old script's own stale limit (30
# min) is a crashed run: the new script reaps it and runs, it does not wait forever.
new_case pidless-stale-lock
mkdir "$LOCK"
touch -t 202001010000 "$LOCK"
run_hook
expect "stale pid-less lock: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "stale pid-less lock: graphify called once" calls_is 1

# 18. A lock older than the stale limit whose pid file is EMPTY (a full disk at the
# pid write, a crash between the open and the write): it is dead, and it goes in a
# pass or two. A worker that only tried rmdir found the directory not empty, took
# that for "reaped" and spun: graphify never started, and find ran hundreds of
# times a second.
new_case empty-pid-stale-lock
mkdir "$LOCK"
: >"$LOCK/pid"
touch -t 202001010000 "$LOCK"
run_hook
expect "empty pid: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "empty pid: graphify called once" calls_is 1
check "empty pid: the lock was reaped in a pass or two, not spun on" find_calls_at_most 5
stop_workers

# 19. A stale lock that cannot be removed (the directory around it is read-only):
# the worker sleeps between passes instead of looping hot, and runs once the lock
# can go. Root ignores directory permissions, so the case is skipped there.
if [ "$(id -u)" -eq 0 ]; then
  echo "skip unremovable lock: running as root"
else
  new_case unremovable-stale-lock
  mkdir "$LOCK"
  : >"$LOCK/pid"
  touch -t 202001010000 "$LOCK"
  # The hook rewrites the request in place; it could not create one in a read-only directory.
  : >"$REPO/graphify-out/.regen.request"
  chmod a-w "$REPO/graphify-out"
  run_hook
  sleep 3
  check "unremovable lock: graphify not called" calls_is 0
  check "unremovable lock: the worker sleeps between passes, it does not spin" find_calls_at_most 3
  chmod u+w "$REPO/graphify-out"
  # Removing the pid file made the directory young; make it old again.
  touch -t 202001010000 "$LOCK"
  expect "unremovable lock: run stamped once the lock can go" test -s "$REPO/graphify-out/.regen.last"
  check "unremovable lock: graphify called once" calls_is 1
  stop_workers
fi

# 20. A commit in a LINKED worktree does not rebuild the main checkout's graph:
# the main checkout's files did not change. The hook run from the worktree makes
# no request and starts no graphify; run from the primary checkout it starts one.
new_case linked-worktree
git -C "$REPO" -c user.name=t -c user.email=t@t.invalid commit -q --allow-empty -m first
git -C "$REPO" worktree add -q "$WORK/linked-worktree-side" -b side
RUN_DIR="$WORK/linked-worktree-side" run_hook
sleep 2
check "linked worktree: graphify not called" calls_is 0
check "linked worktree: no request written" test ! -e "$REPO/graphify-out/.regen.request"
run_hook
expect "primary checkout: run stamped" test -s "$REPO/graphify-out/.regen.last"
check "primary checkout: graphify called once" calls_is 1

# 21. The default load limit is 1.5 per core: 2.00 per core is busy with no
# override.
new_case load-default-limit
set_readings "{ 24.00 20.00 20.00 }" 1
run_hook GRAPHIFY_REGEN_BUSY_SLEEP=1
expect "default load limit: 2.00/core is held" logged "rimandato: load 2.00/core sopra 1.5"
check "default load limit: graphify not called" calls_is 0
quiet
expect "default load limit: run stamped once quiet" test -s "$REPO/graphify-out/.regen.last"
check "default load limit: graphify called once" calls_is 1

echo
if [ "$fails" -gt 0 ]; then echo "$fails failure(s)"; exit 1; fi
echo "all cases pass"
