#!/bin/bash
# Prints the Bun that runs this checkout's server: the version pinned in
# .bun-version, installed by scripts/install-bun.sh under ~/.topics/bun/<version>/.
#
# The global `bun` of this Mac is shared with every other project and stays out
# of it. It is printed only when the pinned version is not installed, with a
# line on stderr naming the command that installs it: the server still starts.
#
# Why a binary of its own: CI, the release and the tests run .bun-version, and
# two defects of the cloud quality pass (`columnNames` reversed past 62 columns,
# `require` ignoring `with { type: "text" }`) came from this Mac running 1.3.8
# meanwhile.
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
want="$(cat "$app_dir/.bun-version" 2>/dev/null | tr -d '[:space:]')"
pinned="$HOME/.topics/bun/$want/bun"
if [ -n "$want" ] && [ -x "$pinned" ]; then
  echo "$pinned"
  exit 0
fi
global="$(command -v bun || echo "$HOME/.bun/bin/bun")"
echo "[pinned-bun] Bun ${want:-?} is not installed in ~/.topics/bun: the server runs $global ($("$global" --version 2>/dev/null)). Install it with scripts/install-bun.sh" >&2
echo "$global"
