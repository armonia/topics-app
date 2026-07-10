#!/usr/bin/env bash
# Ship a Tauri desktop release for the version currently on origin/main.
#
# Normally you don't need this: every merge to main already auto-builds and
# publishes its version (auto-bump.yml → tauri-release.yml). ship.sh is the manual
# escape hatch — re-cut a release for the version currently on origin/main.
#
# What it does: tags origin/main as `tauri-v<version>` and pushes the tag, which
# fires .github/workflows/tauri-release.yml → builds the macOS/Windows/Linux
# installers + the `latest.json` updater manifest and PUBLISHES the GitHub Release
# live (releaseDraft: false), so the signed auto-updater picks it up.
#
# Why a local tag push works when CI can't: CI's built-in GITHUB_TOKEN cannot
# trigger a tag-driven workflow. Pushing the tag from YOUR git credential (a real
# user) does — no repo PAT/secret to manage.
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
