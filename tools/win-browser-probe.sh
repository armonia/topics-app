#!/usr/bin/env bash
# Drive `win-browser-probe.ps1` on the real Windows machine and bring back what
# it saw.
#
#   ./tools/win-browser-probe.sh [user@host] [label]
#
# It assumes the app is ALREADY installed and running there (this is a probe,
# not a gate: it installs nothing and relaunches nothing, so what it measures is
# the state the machine is in). Everything goes through a scheduled task
# registered with `/it` for the same reason the desktop gate does it: an ssh
# session on Windows lives on its own window station, where the console user's
# windows do not exist and a screen capture is black.
#
# Artefacts land in `tools/out/win/probe/`, git-ignored like the rest of
# `tools/out`: they are evidence, not source.
set -euo pipefail

HOST="${1:-zorah@100.92.197.74}"
LABEL="${2:-probe}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE='C:/Users/zorah/topics-win-check'
REMOTE_WIN='C:\Users\zorah\topics-win-check'
OUT="$ROOT/tools/out/win/probe"
mkdir -p "$OUT"

ps() { ssh "$HOST" "powershell -NoProfile -Command \"$1\"" 2>/dev/null | tr -d '\r'; }

# Same shape as `win-desktop-check.sh`: `schtasks /run` returns at once and the
# scheduler reports 267009 ("still running") until the task is done, so the
# state has to be polled before the result means anything.
task() {
  local name="$1" cmd="$2"
  ssh "$HOST" "schtasks /delete /tn $name /f" >/dev/null 2>&1 || true
  ssh "$HOST" "schtasks /create /tn $name /tr \"$cmd\" /sc once /st 23:59 /it /f" >/dev/null
  ssh "$HOST" "schtasks /run /tn $name" >/dev/null
  local state=""
  for _ in $(seq 1 60); do
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
scp -q "$ROOT/tools/win-browser-probe.ps1" "$HOST:$REMOTE/win-browser-probe.ps1"

echo "==> running it in the interactive session (label $LABEL)"
CODE="$(task TopicsBrowserProbe "powershell -NoProfile -ExecutionPolicy Bypass -File $REMOTE_WIN\\win-browser-probe.ps1 -Out $REMOTE_WIN -Label $LABEL")"

ps "Get-Content '$REMOTE_WIN\\browser-probe-$LABEL.log'" | sed 's/^/    /'
scp -q "$HOST:$REMOTE/browser-probe-$LABEL.log" "$OUT/" 2>/dev/null || true
scp -q "$HOST:$REMOTE/witness-$LABEL.log" "$OUT/" 2>/dev/null || true
scp -q "$HOST:$REMOTE/2*-$LABEL*.png" "$OUT/" 2>/dev/null || true
scp -q "$HOST:$REMOTE/2*.png" "$OUT/" 2>/dev/null || true

echo "==> exit $CODE, artefacts in tools/out/win/probe/"
exit "$CODE"
