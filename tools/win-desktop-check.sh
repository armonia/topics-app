#!/usr/bin/env bash
# Run the desktop gate on the real Windows machine, against the REAL published
# installer, and bring the evidence back to this repo.
#
#   ./tools/win-desktop-check.sh [user@host] [tag]
#
# With no tag it takes the latest release. It downloads the asset ON the Windows
# box, checks the SHA256 against the digest GitHub declares (the installers are
# not Authenticode signed, so that digest is the only integrity check there is),
# installs it, and then runs the five checks of `win-desktop-check.ps1`.
#
# WHY EVERY STEP GOES THROUGH A SCHEDULED TASK. An ssh session on Windows lives
# on its own window station: from there the console user's windows do not exist,
# the NSIS installer has no desktop to draw on, SendKeys types into nothing and
# `Stop-Process` on the running shell kills the ssh command itself without
# printing a line. `schtasks /it` is the way into the interactive session, and
# the task has no stdout to give back, which is why every script here writes a
# log file that gets read afterwards.
#
# WHAT IT LEAVES BEHIND: the app installed at the released version, running,
# with its panes closed, and no scheduled task of ours. Artefacts land in
# `tools/out/win/`, which is git-ignored on purpose: they are evidence, not
# source.
set -euo pipefail

HOST="${1:-zorah@100.92.197.74}"
TAG="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="armonia/topics-app"
REMOTE='C:/Users/zorah/topics-win-check'
REMOTE_WIN='C:\Users\zorah\topics-win-check'

if [ -z "$TAG" ]; then TAG="$(gh release view --json tagName --jq .tagName)"; fi
VER="${TAG#tauri-v}"
ASSET="Topics_${VER}_x64-setup.exe"
OUT="$ROOT/tools/out/win"
mkdir -p "$OUT"
echo "==> release $TAG, asset $ASSET"

DIGEST="$(gh api "repos/$REPO/releases/tags/$TAG" --jq ".assets[]|select(.name==\"$ASSET\")|.digest")"
URL="$(gh api "repos/$REPO/releases/tags/$TAG" --jq ".assets[]|select(.name==\"$ASSET\")|.browser_download_url")"
[ -n "$DIGEST" ] || { echo "!! no digest for $ASSET" >&2; exit 2; }

ps() { ssh "$HOST" "powershell -NoProfile -Command \"$1\"" 2>/dev/null | tr -d '\r'; }

# One task, run to completion, its exit code read from the scheduler. `schtasks
# /run` returns at once and reports 267009 ("still running") until it is done,
# so the state has to be polled before the result means anything.
task() {
  local name="$1" cmd="$2"
  ssh "$HOST" "schtasks /delete /tn $name /f" >/dev/null 2>&1 || true
  ssh "$HOST" "schtasks /create /tn $name /tr \"$cmd\" /sc once /st 23:59 /it /f" >/dev/null
  ssh "$HOST" "schtasks /run /tn $name" >/dev/null
  local state=""
  for _ in $(seq 1 90); do
    sleep 10
    state="$(ps "(Get-ScheduledTask -TaskName $name).State" | tr -d ' ')"
    [ "$state" = "Running" ] || break
  done
  local code
  code="$(ps "(Get-ScheduledTaskInfo -TaskName $name).LastTaskResult" | tr -d ' ')"
  ssh "$HOST" "schtasks /delete /tn $name /f" >/dev/null 2>&1 || true
  echo "$code"
}

echo "==> downloading on the machine and checking the digest"
ps "New-Item -ItemType Directory -Force -Path '$REMOTE_WIN' | Out-Null; \$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '$URL' -OutFile '$REMOTE_WIN\\$ASSET'" >/dev/null
GOT="$(ps "(Get-FileHash '$REMOTE_WIN\\$ASSET' -Algorithm SHA256).Hash" | tr -d ' ' | tr 'A-F' 'a-f')"
WANT="$(echo "${DIGEST#sha256:}" | tr 'A-F' 'a-f')"
if [ "$GOT" != "$WANT" ]; then echo "!! digest mismatch: $GOT vs $WANT" >&2; exit 1; fi
echo "    sha256 $GOT matches the release, signature: $(ps "(Get-AuthenticodeSignature '$REMOTE_WIN\\$ASSET').Status")"

echo "==> installing $VER"
scp -q "$ROOT/tools/win-desktop-install.ps1" "$HOST:$REMOTE/win-desktop-install.ps1"
CODE="$(task TopicsWinInstall "powershell -NoProfile -ExecutionPolicy Bypass -File $REMOTE_WIN\\win-desktop-install.ps1 -Installer $REMOTE_WIN\\$ASSET -Out $REMOTE_WIN -ExpectedVersion $VER")"
ps "Get-Content '$REMOTE_WIN\\install.log'" | sed 's/^/    /'
[ "$CODE" = "0" ] || { echo "!! install task answered $CODE" >&2; exit 1; }

scp -q "$ROOT/tools/win-desktop-check.ps1" "$HOST:$REMOTE/win-desktop-check.ps1"

# One arm = one run of the gate. The expected exit code is part of the call:
# three of these are falsifications and a 0 from them would mean the gate is
# blind, not that the app is well.
arm() {
  local label="$1" expect="$2" args="$3"
  echo "==> arm $label (expecting exit $expect)"
  local code
  code="$(task TopicsDeskCheck "powershell -NoProfile -ExecutionPolicy Bypass -File $REMOTE_WIN\\win-desktop-check.ps1 -Out $REMOTE_WIN -Label $label $args")"
  ps "Get-Content '$REMOTE_WIN\\desktop-check-$label.log'" | sed 's/^/    /'
  scp -q "$HOST:$REMOTE/*-$label.png" "$OUT/" 2>/dev/null || true
  echo "    exit $code"
  if [ "$code" != "$expect" ]; then
    echo "!! arm $label answered $code, expected $expect" >&2
    RC=1
  fi
}
RC=0

# The falsifications first, so a green final run cannot be mistaken for a gate
# that always says yes. `wrongkey` sends an unbound combination in place of
# Ctrl+K: it proves the shortcut probe can tell an overlay from nothing.
# `noremedy` turns off the webview rebuild, which is a real lever on the subject
# of (d).
arm wrongkey 1 "-Only abc -WrongKey"
arm noremedy 1 "-Only ad -NoRemedy"
# The browser pane, alone, so its verdict is not hidden by anything before it.
arm browser 0 "-Only e"
# Last, and whatever happened before, the run that leaves the machine in a good
# state: remedy on, panes closed, marker aside so the app can serve itself.
arm full 0 "-Only abcd -ClearDegradedMarker"

echo "==> artefacts in tools/out/win/"
exit $RC
