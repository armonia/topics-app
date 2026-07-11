#!/usr/bin/env bash
# Bump the version in LOCKSTEP across the three sources of truth:
#   - package.json                              ("version")
#   - desktop-tauri/src-tauri/tauri.conf.json   ("version")
#   - desktop-tauri/src-tauri/Cargo.toml        (the [package] version line)
#   - desktop-tauri/src-tauri/Cargo.lock        (the [[package]] "app" stanza)
#
# Surgical text replacement (not a JSON re-serialize), so only the version
# string changes and every file keeps its exact formatting → minimal diff.
#
# Prints the NEW version to stdout (nothing else on stdout) so callers can
# capture it: NEW=$(scripts/bump-version.sh patch)
#
# Usage: scripts/bump-version.sh [patch|minor|major]   (default: patch)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
PART="${1:-patch}"

python3 - "$PART" <<'PY'
import re, sys

part = sys.argv[1]
if part not in ("patch", "minor", "major"):
    sys.exit(f"bump-version: unknown part '{part}' (use patch|minor|major)")

PKG = "package.json"
TAURI = "desktop-tauri/src-tauri/tauri.conf.json"
CARGO = "desktop-tauri/src-tauri/Cargo.toml"
LOCK = "desktop-tauri/src-tauri/Cargo.lock"

# Read the current version from package.json (the canonical source).
cur = re.search(r'"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"', open(PKG).read())
if not cur:
    sys.exit("bump-version: no semver \"version\" in package.json")
x, y, z = (int(n) for n in cur.groups())

if part == "major":   x, y, z = x + 1, 0, 0
elif part == "minor": x, y, z = x, y + 1, 0
else:                 z += 1
new = f"{x}.{y}.{z}"

def sub_once(path, pattern, repl):
    s = open(path).read()
    s2, n = re.subn(pattern, repl, s, count=1)
    if n != 1:
        sys.exit(f"bump-version: version line not found in {path}")
    open(path, "w").write(s2)

# JSON: "version": "X.Y.Z"  (first occurrence = the top-level app version)
sub_once(PKG,   r'("version"\s*:\s*")\d+\.\d+\.\d+(")', rf'\g<1>{new}\g<2>')
sub_once(TAURI, r'("version"\s*:\s*")\d+\.\d+\.\d+(")', rf'\g<1>{new}\g<2>')
# Cargo.toml: a line-anchored `version = "X.Y.Z"` = the [package] version
# (dependency versions are inline `name = { version = "…" }`, never line-start).
sub_once(CARGO, r'(?m)^(version\s*=\s*")\d+\.\d+\.\d+(")', rf'\g<1>{new}\g<2>')
# Cargo.lock: keep the "app" package stanza in lockstep too. Without this
# every bump leaves the lock one version behind, and the NEXT local
# `cargo build`/`cargo check` rewrites it as uncommitted noise (a dirty
# Cargo.lock rode along in two PRs before this).
sub_once(LOCK, r'(?m)^(name = "app"\nversion = ")\d+\.\d+\.\d+(")', rf'\g<1>{new}\g<2>')

print(new)
PY
