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
# Why there is no per-run quota and no second pool (card 5d825e61, measured on the node,
# 16 vCPU, ci.slice MemoryMax 26 GB): one e2e run on the 4 shard runners averages ~12 cores
# (peak ~15.5) and ~7.6 GB of anonymous RAM. It is CPU bound, so two runs side by side
# would each lose far more than 30%, and a fixed 2+2 split makes the common case (one run)
# slower and pushes its other shards to the saturated GitHub queue. Parallel runs need a
# bigger node, not a different split: the first run takes the free runners, a second one
# takes what is left, the rest goes to GitHub.
# Needs GH_TOKEN (repository admin, to edit runner labels) and GITHUB_REPOSITORY.
set -uo pipefail

PREFIX=pn-
SETTLE_S=${PERMANENT_SETTLE_S:-4}
# A prepare-e2e job that waited this long on its booked runner is not going to start
# (measured 20/11: 35+ minutes queued on an online, idle runner holding its label).
PREP_STUCK_S=${PERMANENT_PREP_STUCK_S:-300}
PREP_POOL=permanent-prep
RERUN_WAIT_TRIES=${PERMANENT_RERUN_WAIT_TRIES:-12}

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
      if [[ $lab == *-prep ]] && prep_stuck "$run" "$lab"; then
        # Hand every runner of the run back, take the runner that did not serve the prep
        # out of the prep pool (quarantine: it comes back by hand, after someone looked at
        # the node), then cancel the run and start it again so it places itself anew.
        unbook "$id" "$lab"
        for sid in $(jq -r --arg l "${lab%-prep}" '.runners[] | select(any(.labels[]; .name == $l)) | .id' <<<"$all"); do
          unbook "$sid" "${lab%-prep}"
        done
        unbook "$id" "$PREP_POOL"
        echo "::warning::runner $id removed from the $PREP_POOL pool: prep of run $run queued over ${PREP_STUCK_S}s on it; run $run cancelled and rerun" >&2
        restart_run "$run"
      elif [ "$(gh_api GET "/actions/runs/$run" | jq -r '.status // empty' 2>/dev/null)" = completed ] || run_done_with "$run" "$lab"; then
        unbook "$id" "$lab"
      fi
    done
}

# Cancel a run and start it again, so its PR is not left with a cancelled CI. A rerun is
# refused while the run is still winding down, hence the wait for it to complete.
restart_run() {  # <run id>
  local i
  gh_api POST "/actions/runs/$1/cancel" >/dev/null 2>&1 || true
  for i in $(seq 1 "$RERUN_WAIT_TRIES"); do
    [ "$(gh_api GET "/actions/runs/$1" 2>/dev/null | jq -r '.status // empty')" = completed ] && break
    sleep 5
  done
  gh_api POST "/actions/runs/$1/rerun" >/dev/null 2>&1 || true
}

# True when the run's prepare-e2e job on this prep label has sat queued for PREP_STUCK_S.
prep_stuck() {  # <run id> <prep label>
  gh_api GET "/actions/runs/$1/jobs?per_page=100" 2>/dev/null | jq -e --arg l "$2" --argjson max "$PREP_STUCK_S" '
    any(.jobs[]?; .status == "queued" and any(.labels[]?; . == $l)
      and (now - (.created_at | fromdateiso8601)) > $max)' >/dev/null 2>&1
}

# True when the run has jobs on this exact booking label and none is still queued or
# running. The run itself stays "queued" while any other job of it waits, and would hold
# the booking behind a queue it should relieve. A run with no listed job on the label
# (not created yet) keeps its booking. Only the exact label counts: the shard runners'
# `pn-<run>-<n>` judged by the finished `-prep` job would be dropped in the seconds
# between the end of prepare-e2e and the creation of the shards, stranding them on a
# label nobody serves. A prep job that ended without success means the shards will never
# be created (skipped shards list no label), so then the shard booking is over too.
run_done_with() {  # <run id> <booking label>
  gh_api GET "/actions/runs/$1/jobs?per_page=100" 2>/dev/null | jq -e --arg l "$2" '
    [.jobs[]? | select(any(.labels[]?; . == $l))] as $j
    | [.jobs[]? | select(any(.labels[]?; . == ($l + "-prep")))] as $p
    | (($j | length) > 0 and all($j[]; .status == "completed"))
      or (($j | length) == 0 and ($p | length) > 0
          and all($p[]; .status == "completed"
               and (.conclusion | IN("failure", "cancelled", "skipped", "timed_out"))))' >/dev/null 2>&1
}

reserve() {
  local pool=$1 want=$2 mine=$3 all ids kept=0 id
  [[ $want =~ ^[0-9]+$ ]] && [ "$want" -gt 0 ] || { echo 0; return 0; }
  all=$(runners) || { echo 0; return 0; }
  drop_stale "$all"
  all=$(runners) || { echo 0; return 0; }
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
