#!/usr/bin/env bash
# Book runners of the permanent node (topics-permanent-node) for one CI run, and give them back.
#
#   ci-permanent-reserve.sh reserve <pool label> <how many> <run label>   prints how many it got
#   ci-permanent-reserve.sh release <run label>
#
# The runners there are persistent and shared by every run. A run takes a runner by
# adding its own label to it (`pn-<run>-<attempt>`), and its shards target that label
# only, so a shard never waits for a runner another run is using: what is not booked
# goes to GitHub at once.
#
# Two runs can book at the same moment. The rule that keeps one runner from serving two:
# after adding its label a run waits, reads again, and keeps the runner only if its
# label is the ONLY booking on it; otherwise it takes its label back. If both added
# before either read, both give it up (the shard goes to GitHub, nothing hangs); if one
# read first, it sees only itself and keeps it, and the later one sees two and yields.
#
# A booking whose run is over (cancelled before `release`, a dead job) is dropped by the
# next `reserve`, so a runner is never held by a run that no longer exists.
#
# Slots: the node serves at most PERMANENT_MAX_RUNS runs at once (default 2). Each run
# is held to its share of the pool (pool size / max runs, rounded up), so two runs fit
# side by side and neither starves the other; a third finds both slots taken and its
# shards go to GitHub as before. The slot is the booking itself: it is released with the
# run's label, by `release`, by the next `reserve` or by the sweeper, so a cancelled run
# cannot hold one. Isolation of the two runs (ports, HOME, /tmp, cgroup) is per runner,
# see deploy/permanent-node/ci-runners.sh.
#
# Needs GH_TOKEN (repository admin, to edit runner labels) and GITHUB_REPOSITORY.
set -uo pipefail

PREFIX=pn-
SETTLE_S=${PERMANENT_SETTLE_S:-4}
MAX_RUNS=${PERMANENT_MAX_RUNS:-2}

gh_api() {  # <method> <path> [json body]: the GitHub REST API, overridden by the test
  local m=$1 p=$2
  if [ $# -ge 3 ]; then
    curl -fsS -X "$m" -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$GITHUB_REPOSITORY$p" -d "$3"
  else
    curl -fsS -X "$m" -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$GITHUB_REPOSITORY$p"
  fi
}

runners() { gh_api GET "/actions/runners?per_page=100"; }

bookings_of() {  # <runners json> <runner id>: the pn- labels on that runner
  jq -r --argjson id "$2" --arg p "$PREFIX" '.runners[] | select(.id == $id) | .labels[].name | select(startswith($p))' <<<"$1"
}

unbook() { gh_api DELETE "/actions/runners/$1/labels/$2" >/dev/null 2>&1 || true; }

drop_stale() {  # bookings of runs that are over
  local all=$1 id lab run
  jq -r --arg p "$PREFIX" '.runners[] | .id as $id | .labels[].name | select(startswith($p)) | "\($id) \(.)"' <<<"$all" |
    while read -r id lab; do
      run=${lab#"$PREFIX"}; run=${run%%-*}
      [[ $run =~ ^[0-9]+$ ]] || continue
      [ "$(gh_api GET "/actions/runs/$run" | jq -r '.status // empty' 2>/dev/null)" = completed ] && unbook "$id" "$lab"
    done
}

busy_slots() {  # <runners json> <pool> <my label>: runs other than mine holding a runner of the pool
  jq -r --arg pool "$2" --arg p "$PREFIX" --arg mine "$3" '
    [.runners[] | select(any(.labels[]; .name == $pool)) | .labels[].name
      | select(startswith($p) and . != $mine and (endswith("-prep") | not)) | ltrimstr($p) | split("-")[0]]
    | unique | length' <<<"$1"
}

pool_size() {  # <runners json> <pool>: runners of ours in the pool, whatever their state
  jq -r --arg pool "$2" '[.runners[] | select((.name | startswith("topics-permanent-node-")) and any(.labels[]; .name == $pool))] | length' <<<"$1"
}

reserve() {
  local pool=$1 want=$2 mine=$3 all ids kept=0 id
  [[ $want =~ ^[0-9]+$ ]] && [ "$want" -gt 0 ] || { echo 0; return 0; }
  all=$(runners) || { echo 0; return 0; }
  drop_stale "$all"
  all=$(runners) || { echo 0; return 0; }
  # The shard pool is split between runs; the prep pool has one runner and needs no cap.
  if [ "$pool" != permanent-prep ]; then
    local size quota
    [ "$(busy_slots "$all" "$pool" "$mine")" -lt "$MAX_RUNS" ] || { echo 0; return 0; }
    size=$(pool_size "$all" "$pool"); quota=$(( (size + MAX_RUNS - 1) / MAX_RUNS ))
    [ "$want" -le "$quota" ] || want=$quota
  fi
  # Free = online, idle, one of ours by name (a runner registered by anybody else with
# the same label is never booked), in the pool, booked by nobody.
  ids=$(jq -r --arg pool "$pool" --arg p "$PREFIX" --argjson n "$want" '
    [.runners[] | select(.status == "online" and (.busy | not) and (.name | startswith("topics-permanent-node-"))
      and any(.labels[]; .name == $pool)
      and all(.labels[]; .name | startswith($p) | not)) | .id] | sort | .[:$n][]' <<<"$all")
  [ -n "$ids" ] || { echo 0; return 0; }
  for id in $ids; do
    gh_api POST "/actions/runners/$id/labels" "{\"labels\":[\"$mine\"]}" >/dev/null 2>&1 || true
  done
  sleep "$SETTLE_S"
  all=$(runners) || { for id in $ids; do unbook "$id" "$mine"; done; echo 0; return 0; }
  for id in $ids; do
    if [ "$(bookings_of "$all" "$id" | xargs)" = "$mine" ]; then
      kept=$((kept + 1))
    else
      unbook "$id" "$mine"
    fi
  done
  echo "$kept"
}

release() {
  local mine=$1 all
  all=$(runners) || return 0
  jq -r --arg l "$mine" '.runners[] | select(any(.labels[]; .name == $l)) | .id' <<<"$all" |
    while read -r id; do unbook "$id" "$mine"; done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    reserve) reserve "${2:?pool}" "${3:?how many}" "${4:?run label}" ;;
    release) release "${2:?run label}" ;;
    *) echo "uso: $0 reserve <pool> <n> <run label> | release <run label>" >&2; exit 2 ;;
  esac
fi
