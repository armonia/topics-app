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
# A prepare-e2e job queued this long on its booked runner gets a push; if it still does not
# start after PUSH_WAIT_S, and has waited PREP_STUCK_S in all, the runner is quarantined.
# Cause measured 20/11 (card 698fd926): the runner's broker session never got the
# ForceTokenRefreshMessage that reloads its labels, so it was never offered the job carrying
# the booking label although it was online and idle. Rewriting its labels sends the message.
PREP_PUSH_S=${PERMANENT_PREP_PUSH_S:-120}
PUSH_WAIT_S=${PERMANENT_PUSH_WAIT_S:-90}
PUSH_POLL_S=${PERMANENT_PUSH_POLL_S:-5}
PREP_STUCK_S=${PERMANENT_PREP_STUCK_S:-300}
PREP_POOL=permanent-prep
# A quarantined runner rejoins the prep pool by itself after this long (card 06e7894c): it is
# the only prep runner, so a quarantine nobody lifts would switch the whole pool off.
QUARANTINE_S=${PERMANENT_QUARANTINE_S:-1800}
QUARANTINE_PREFIX=prep-quarantine-
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
      if [[ $lab == *-prep ]] && prep_queued_over "$run" "$lab" "$PREP_PUSH_S" && ! push_prep "$run" "$id" "$lab" \
          && prep_queued_over "$run" "$lab" "$PREP_STUCK_S"; then
        # The push did not start it. Hand every runner of the run back, take the runner that
        # did not serve the prep out of the prep pool for QUARANTINE_S (its label carries the start time, and the
        # first reserve after that puts it back), then cancel the run and start it again so it places itself anew.
        unbook "$id" "$lab"
        for sid in $(jq -r --arg l "${lab%-prep}" '.runners[] | select(any(.labels[]; .name == $l)) | .id' <<<"$all"); do
          unbook "$sid" "${lab%-prep}"
        done
        unbook "$id" "$PREP_POOL"
        gh_api POST "/actions/runners/$id/labels" "{\"labels\":[\"$QUARANTINE_PREFIX$(date +%s)\"]}" >/dev/null 2>&1 || true
        echo "::warning::runner $id removed from the $PREP_POOL pool for ${QUARANTINE_S}s: prep of run $run queued over ${PREP_STUCK_S}s on it; run $run cancelled and rerun" >&2
        restart_run "$run"
      elif [ "$(gh_api GET "/actions/runs/$run" | jq -r '.status // empty' 2>/dev/null)" = completed ] || run_done_with "$run" "$lab"; then
        unbook "$id" "$lab"
      fi
    done
}

# Put runners whose quarantine has run out back into the prep pool. The pool label goes
# back first, so a crash between the two calls never strands the runner outside it.
rejoin_quarantined() {  # <runners json>
  local id lab
  jq -r --arg p "$QUARANTINE_PREFIX" '.runners[] | .id as $id | .labels[].name | select(startswith($p)) | "\($id) \(.)"' <<<"$1" |
    while read -r id lab; do
      [[ ${lab#"$QUARANTINE_PREFIX"} =~ ^[0-9]+$ ]] || continue
      [ $(($(date +%s) - ${lab#"$QUARANTINE_PREFIX"})) -ge "$QUARANTINE_S" ] || continue
      gh_api POST "/actions/runners/$id/labels" "{\"labels\":[\"$PREP_POOL\"]}" >/dev/null 2>&1 || true
      unbook "$id" "$lab"
      echo "::warning::runner $id back in the $PREP_POOL pool after ${QUARANTINE_S}s of quarantine" >&2
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

# Take the prep label off the runner and put it back: the label write makes the broker send
# the runner a ForceTokenRefreshMessage, so it reloads its labels and is offered the job.
# Waits up to PUSH_WAIT_S; succeeds when the prep job is no longer queued.
push_prep() {  # <run id> <runner id> <prep label>
  local waited=0
  unbook "$2" "$3"
  gh_api POST "/actions/runners/$2/labels" "{\"labels\":[\"$3\"]}" >/dev/null 2>&1 || true
  echo "::warning::prep of run $1 queued over ${PREP_PUSH_S}s on runner $2: label rewritten to refresh its session" >&2
  while [ "$waited" -lt "$PUSH_WAIT_S" ]; do
    sleep "$PUSH_POLL_S"; waited=$((waited + PUSH_POLL_S))
    prep_queued_over "$1" "$3" 0 || return 0
  done
  return 1
}

# True when the run's prepare-e2e job on this prep label has sat queued for more than <seconds>.
prep_queued_over() {  # <run id> <prep label> <seconds>
  gh_api GET "/actions/runs/$1/jobs?per_page=100" 2>/dev/null | jq -e --arg l "$2" --argjson max "$3" '
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
  rejoin_quarantined "$all"
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
