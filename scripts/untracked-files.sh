#!/usr/bin/env bash
# Every gate in qa-gate.sh enumerates files through git, so a file not yet added
# is read by none of them and the bar says green on code nobody checked. It
# happened three times (12/09, 15/09, 22/11/2026), each one a red CI on main
# right after the push. Exit 1 with the list while such files exist; ignored
# files do not count. Runs in the current directory (qa-gate.sh cds to the root).
set -uo pipefail

files="$(git ls-files --others --exclude-standard)" || exit 2
if [ -z "$files" ]; then
  echo "nessun file nuovo fuori da git"
  exit 0
fi
printf '%s\n' "$files" | head -20
n="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
echo "$n file nuovi fuori da git: nessun cancello li legge (git add, poi rilancia)"
exit 1
