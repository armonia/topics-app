#!/bin/bash
# Process lock shared by the watcher and its supervisor. Descriptor 9 stays in
# the owning shell, and the kernel releases its lease if that shell is killed.

WATCHDOG_INTERVAL_S="${TOPICS_SERVER_WATCHDOG_INTERVAL_S:-1}"

acquire_process_lock() {
  local pidfile="$1" expected="$2" platform owner lease_status
  PROCESS_LOCK_FILE="${pidfile}.lock"
  PROCESS_LOCK_OWNER_PID="$$"
  PROCESS_LOCK_OWNED=0

  if ! exec 9>>"$PROCESS_LOCK_FILE"; then
    echo "[$expected] cannot open process lease $PROCESS_LOCK_FILE"
    return 1
  fi

  platform=$(exec 9>&-; uname -s)
  # Only the acquisition primitive receives descriptor 9. Every later child
  # closes it so the owner's death releases the lease immediately.
  if [ "$platform" = Darwin ] && [ -x /usr/bin/lockf ]; then
    /usr/bin/lockf -s -t 0 9
    lease_status=$?
  elif command -v flock >/dev/null 2>&1; then
    flock -n 9
    lease_status=$?
  else
    echo "[$expected] no supported process lease tool (lockf or flock)"
    exec 9>&-
    return 1
  fi

  if [ "$lease_status" -ne 0 ]; then
    owner=$(exec 9>&-; cat "$pidfile" 2>/dev/null)
    echo "[$expected] already running${owner:+ (pid $owner)}; this instance exits"
    exec 9>&-
    return 1
  fi

  if [ -n "${TOPICS_SERVER_WATCH_LOCK_PAUSE_AFTER_ACQUIRE_FILE:-}" ]; then
    echo "$PROCESS_LOCK_OWNER_PID" > "$TOPICS_SERVER_WATCH_LOCK_PAUSE_AFTER_ACQUIRE_FILE"
    kill -STOP "$PROCESS_LOCK_OWNER_PID"
  fi

  echo "$PROCESS_LOCK_OWNER_PID" > "$pidfile"
  PROCESS_LOCK_OWNED=1
  return 0
}

process_has_parent() {
  local watched_pid="$1" expected_parent="$2"
  if [ -n "${TOPICS_SERVER_WATCH_PARENT_INSPECTOR:-}" ]; then
    "$TOPICS_SERVER_WATCH_PARENT_INSPECTOR" "$watched_pid" "$expected_parent" 9>&-
    return $?
  fi
  [ "$(exec 9>&-; ps -o ppid= -p "$watched_pid" 2>/dev/null | tr -d ' ')" = "$expected_parent" ]
}

start_parent_watchdog() {
  local managed_parent="$1" watched_pid="$2"
  PARENT_WATCHDOG_PID=""
  [ -n "$managed_parent" ] || return 0

  if ! process_has_parent "$watched_pid" "$managed_parent"; then
    echo "[server-watch] managed parent $managed_parent does not own process $watched_pid"
    return 1
  fi

  (
    exec 9>&-
    while kill -0 "$managed_parent" 2>/dev/null && process_has_parent "$watched_pid" "$managed_parent"; do
      sleep "$WATCHDOG_INTERVAL_S"
    done
    kill -TERM "$watched_pid" 2>/dev/null
  ) &
  PARENT_WATCHDOG_PID=$!
}

stop_parent_watchdog() {
  [ -n "${PARENT_WATCHDOG_PID:-}" ] || return 0
  kill -TERM "$PARENT_WATCHDOG_PID" 2>/dev/null
  wait "$PARENT_WATCHDOG_PID" 2>/dev/null
  PARENT_WATCHDOG_PID=""
}

release_process_lock() {
  local pidfile="$1"
  [ "${PROCESS_LOCK_OWNED:-0}" = 1 ] || return 0
  if [ "$(exec 9>&-; cat "$pidfile" 2>/dev/null)" = "$PROCESS_LOCK_OWNER_PID" ]; then
    rm -f "$pidfile" 9>&-
  fi
  exec 9>&-
  PROCESS_LOCK_OWNED=0
}
