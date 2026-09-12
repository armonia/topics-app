# Release manifest repair

The release workflow disables per-runner updater JSON and uploads one composed
manifest from `publish`. The composer reads the release's real installer URLs
and signatures, and preserves metadata from an existing manifest when repairing
a draft. The asset gate still runs before the release is made public.

To repair draft `tauri-v2.2.310` without rebuilding or requiring new CI
artifacts, run the following from a checkout containing this commit. It uses
the known draft id, so it also works before GitHub creates the tag:

```bash
repo="OWNER/REPO"
id=387481055
tag=tauri-v2.2.310
work="$(mktemp -d)"
gh api "repos/$repo/releases/$id" > "$work/release.json"
mkdir "$work/signatures"
jq -r '.assets[] | select(.name | endswith(".sig")) | [.name, .url] | @tsv' "$work/release.json" |
while IFS=$'\t' read -r name url; do
  gh api "$url" -H 'Accept: application/octet-stream' > "$work/signatures/$name"
done
latest_url="$(jq -r '.assets[] | select(.name == "latest.json") | .url' "$work/release.json")"
gh api "$latest_url" -H 'Accept: application/octet-stream' > "$work/existing.json"
bun run scripts/compose-release-manifest.ts "$work/latest.json" "$tag" "$work/release.json" "$work/signatures" "$work/existing.json"
gh release upload --repo "$repo" "$tag" "$work/latest.json#latest.json" --clobber
REPO="$repo" bun run scripts/check-release-assets.ts "$id"
```

The command only replaces `latest.json`; it does not publish or push. The
existing asset check must report 12/12 and 10/10 before a human publishes the
draft. The `OWNER/REPO` placeholder must be replaced locally and must not be
committed.
