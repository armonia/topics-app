#!/usr/bin/env bash
# Drive `win-typed-probe.ps1` on the real Windows machine and bring back what it
# saw: does a browser pane, opened with the mouse, take an address typed on the
# keyboard and load it.
#
#   ./tools/win-typed-probe.sh [user@host] [label]
#
# It installs nothing: it measures the version already on the machine, restarts
# it so the pane is created by this run, and leaves the app running with the
# pane open on the witness page. Everything goes through a scheduled task
# registered with `/it`, for the same reason the gate does it: an ssh session on
# Windows lives on its own window station, where the console user's windows do
# not exist and a screen capture is black.
#
# Artefacts land in `tools/out/win/probe/`, which is gitignored: they are
# evidence, not source. The `.ps1` of `win-browser-probe` has to be on the
# machine too, and this script copies it: the witness lives there.
set -euo pipefail

HOST="${1:-zorah@100.92.197.74}"
LABEL="${2:-typed}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE='C:/Users/zorah/topics-win-check'
REMOTE_WIN='C:\Users\zorah\topics-win-check'
OUT="$ROOT/tools/out/win/probe"
mkdir -p "$OUT"

ps() { ssh "$HOST" "powershell -NoProfile -Command \"$1\"" 2>/dev/null | tr -d '\r'; }

# `schtasks /run` returns at once and the scheduler reports 267009 ("still
# running") until the task is done, so the state has to be polled before the
# result means anything.
task() {
  local name="$1" cmd="$2"
  ssh "$HOST" "schtasks /delete /tn $name /f" >/dev/null 2>&1 || true
  ssh "$HOST" "schtasks /create /tn $name /tr \"$cmd\" /sc once /st 23:59 /it /f" >/dev/null
  ssh "$HOST" "schtasks /run /tn $name" >/dev/null
  local state=""
  for _ in $(seq 1 40); do
    sleep 10
    state="$(ps "(Get-ScheduledTask -TaskName $name).State" | tr -d ' ')"
    [ "$state" = "Running" ] || break
  done
  local code
  code="$(ps "(Get-ScheduledTaskInfo -TaskName $name).LastTaskResult" | tr -d ' ')"
  ssh "$HOST" "schtasks /delete /tn $name /f" >/dev/null 2>&1 || true
  echo "$code"
}

echo "==> sending the probe"
ps "New-Item -ItemType Directory -Force -Path '$REMOTE_WIN' | Out-Null" >/dev/null
scp -q "$ROOT/tools/win-typed-probe.ps1" "$HOST:$REMOTE/win-typed-probe.ps1"
scp -q "$ROOT/tools/win-browser-probe.ps1" "$HOST:$REMOTE/win-browser-probe.ps1"

echo "==> running it in the interactive session (label $LABEL)"
CODE="$(task TopicsTypedProbe "powershell -NoProfile -ExecutionPolicy Bypass -File $REMOTE_WIN\\win-typed-probe.ps1 -Out $REMOTE_WIN -Label $LABEL")"
ps "Get-Content '$REMOTE_WIN\\typed-$LABEL.log'" | sed 's/^/    /'
scp -q "$HOST:$REMOTE/4*-$LABEL.png" "$OUT/" 2>/dev/null || true
scp -q "$HOST:$REMOTE/witness-$LABEL.log" "$OUT/" 2>/dev/null || true

echo "==> exit $CODE, artefacts in tools/out/win/probe/"
exit "$CODE"
