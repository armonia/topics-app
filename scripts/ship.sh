#!/usr/bin/env bash
# Ship a Tauri desktop release for the version currently on origin/main.
#
# What it does: tags origin/main as `tauri-v<version>` and pushes the tag, which
# fires .github/workflows/tauri-release.yml → builds the macOS/Windows/Linux
# installers + the `latest.json` updater manifest into a DRAFT GitHub Release.
# Publish that draft (Releases page, or `gh release edit tauri-v<version>
# --draft=false`) to actually push the update to everyone's auto-updater.
#
# Why a local script instead of CI auto-tagging: CI's built-in GITHUB_TOKEN
# cannot trigger a tag-driven workflow, so an auto-bump job pushing the tag would
# never start the build. Pushing the tag from YOUR git credential (a real user)
# does — no repo PAT/secret to manage. Keeping release deliberate also avoids a
# full 3-OS build on every trivial merge (auto-bump keeps the version ahead;
# ship.sh decides when it's worth building).
#
# Always ships exactly what's merged on origin/main, never local WIP.
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch --quiet origin main
sha="$(git rev-parse origin/main)"
version="$(git show "origin/main:desktop-tauri/src-tauri/tauri.conf.json" \
  | grep -m1 '"version"' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
[ -n "$version" ] || { echo "Could not read version from tauri.conf.json on origin/main" >&2; exit 1; }
tag="tauri-v${version}"

if git ls-remote --exit-code --tags origin "$tag" >/dev/null 2>&1; then
  echo "Tag $tag already exists on origin — that version was already shipped." >&2
  echo "Merge a change to main (auto-bump raises the patch), then re-run ship.sh." >&2
  exit 1
fi

echo "Shipping $tag  (origin/main @ ${sha:0:8})"
git tag "$tag" "$sha"
git push origin "$tag"
cat <<EOF

Pushed $tag. tauri-release.yml is building (~12 min).
  Watch:   gh run watch --exit-status \$(gh run list --workflow=tauri-release.yml -L1 --json databaseId -q '.[0].databaseId')
  Publish: gh release edit $tag --draft=false     # this is what pushes the update to users
EOF
