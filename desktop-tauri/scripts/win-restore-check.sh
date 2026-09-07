#!/usr/bin/env bash
# Run the restore gate on the real Windows machine, both arms, and bring the
# evidence back.
#
#   ./desktop-tauri/scripts/win-restore-check.sh [user@host] [runs]
#
# WHY A SCHEDULED TASK AND NOT PLAIN SSH. An ssh session on Windows lives on its
# own window station: from there the console user's windows do not exist, so
# EnumWindows finds nothing, PrintWindow returns an empty bitmap and
# Start-Process opens a window nobody can see. The measurement has to run INSIDE
# the interactive session, and a scheduled task registered with `/it` is the way
# in. Same reason the task's output is read from a file afterwards instead of
# from stdout: the task has no stdout to give back.
#
# WHAT IT RUNS. Two arms of the same gate, and the first one has to FAIL:
#   OFF  app relaunched with TOPICS_NO_WEBVIEW_REBUILD=1, remedy disabled.
#        This is the falsification: without it a green run proves nothing,
#        because a gate that cannot fail is not measuring.
#   ON   app relaunched clean, remedy live. Ten cycles, all of them green.
#
# IT TOUCHES A RUNNING APP: each arm kills and relaunches the shell (the remedy
# is read from the environment at startup, so there is no other way to choose an
# arm). It leaves the machine on the ON arm, which is the normal one.
set -euo pipefail

HOST="${1:-zorah@100.92.197.74}"
RUNS="${2:-10}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_DIR='C:/Users/zorah/topics-restore-check'
REMOTE_DIR_WIN='C:\Users\zorah\topics-restore-check'

VER="$(ssh "$HOST" 'powershell -NoProfile -Command "(Get-Item \"$env:LOCALAPPDATA\Topics\app.exe\").VersionInfo.FileVersion"' 2>/dev/null | tr -d '\r\n ')"
[ -n "$VER" ] || { echo "!! cannot read the installed version on $HOST" >&2; exit 2; }
OUT="$ROOT/tools/out/win/restore-$VER"
mkdir -p "$OUT"
echo "==> installed app $VER, artefacts in tools/out/win/restore-$VER"

ssh "$HOST" "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -Path '$REMOTE_DIR_WIN' | Out-Null\"" >/dev/null
scp -q "$ROOT/desktop-tauri/scripts/win-restore-check.ps1" "$HOST:$REMOTE_DIR/win-restore-check.ps1"

# One arm = one interactive task. `/it` is what puts it on the console user's
# desktop; without it the task runs and measures a window station with no
# windows in it.
arm() {
  local label="$1" runs="$2" extra="$3" expect="$4"
  local task="TopicsRestoreCheck_$label"
  local cmd="powershell -NoProfile -ExecutionPolicy Bypass -File $REMOTE_DIR_WIN\\win-restore-check.ps1 -Runs $runs -Out $REMOTE_DIR_WIN -Label $label -Restart $extra"
  echo "==> arm $label ($runs cycles, expected exit $expect)"
  ssh "$HOST" "schtasks /delete /tn $task /f" >/dev/null 2>&1 || true
  ssh "$HOST" "schtasks /create /tn $task /tr \"$cmd\" /sc once /st 23:59 /it /f" >/dev/null
  ssh "$HOST" "schtasks /run /tn $task" >/dev/null
  # Poll until the task stops running: `schtasks /run` returns immediately and the
  # exit code only means anything once the task is done (while it runs it reads
  # 267009, which is "still going", not a verdict).
  local state=""
  for _ in $(seq 1 120); do
    sleep 10
    state="$(ssh "$HOST" "powershell -NoProfile -Command \"(Get-ScheduledTask -TaskName $task).State\"" 2>/dev/null | tr -d '\r\n ')"
    [ "$state" = "Running" ] || break
  done
  local code
  code="$(ssh "$HOST" "powershell -NoProfile -Command \"(Get-ScheduledTaskInfo -TaskName $task).LastTaskResult\"" 2>/dev/null | tr -d '\r\n ')"
  ssh "$HOST" "schtasks /delete /tn $task /f" >/dev/null 2>&1 || true
  echo "    exit $code"
  scp -q "$HOST:$REMOTE_DIR/restore-check-$label.log" "$OUT/" 2>/dev/null || true
  scp -q "$HOST:$REMOTE_DIR/$label-*.png" "$OUT/" 2>/dev/null || true
  sed 's/^/    /' "$OUT/restore-check-$label.log" 2>/dev/null || true
  if [ "$code" != "$expect" ]; then
    echo "!! arm $label answered $code, expected $expect" >&2
    return 1
  fi
}

# Three cycles are enough to falsify: the defect reproduces on every restore.
arm off 3 "-NoRemedy" 1
arm on "$RUNS" "" 0

echo "==> both arms as expected: the gate fails without the remedy and passes $RUNS/$RUNS with it"
