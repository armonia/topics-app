#!/usr/bin/env bash
# Where each e2e shard of a CI run goes: the PC first (free), then the Hetzner
# server of the run, then GitHub.
#
#   e2e-placement.sh '<shards JSON>' <pc label> <pc runners> <hetzner label> <hetzner runners> [<prep label>]
#
# Prints one JSON object, {"s1": "<label>", ..., "prep": "<label>"}, read by
# `runs-on` in ci.yml. A shard missing from it runs on ubuntu-latest, and so does
# `prepare-e2e` without "prep". The prep label is a runner of its own (one job):
# the caller passes it only when that runner is online.
#
# A self-hosted label never gets more shards than it has runners ONLINE. Every
# runner on those machines is ephemeral (one job, then gone), so a sixth shard on
# five runners would wait in the queue for a runner that never comes, and the run
# would hang: the server is deleted only after the shards end.
#
# Shard 0 (the touched specs, two minutes, pull requests only) goes last: the
# self-hosted slots are worth more on the long shards.
set -euo pipefail

shards=${1:?shards JSON}
pc_label=${2:-}
pc_n=${3:-0}
hz_label=${4:-}
hz_n=${5:-0}
prep=${6:-}

[[ $pc_n =~ ^[0-9]+$ ]] || pc_n=0
[[ $hz_n =~ ^[0-9]+$ ]] || hz_n=0
[ -n "$pc_label" ] || pc_n=0
[ -n "$hz_label" ] || hz_n=0

jq -cn --argjson shards "$shards" \
  --arg pl "$pc_label" --argjson pn "$pc_n" \
  --arg hl "$hz_label" --argjson hn "$hz_n" --arg prep "$prep" '
  ([$shards[] | select(. != 0)] + [$shards[] | select(. == 0)]) as $order
  | reduce range(0; $order | length) as $i ({};
      if $i < $pn then . + {("s\($order[$i])"): $pl}
      elif $i < $pn + $hn then . + {("s\($order[$i])"): $hl}
      else . end)
  | if $prep != "" then . + {prep: $prep} else . end'
