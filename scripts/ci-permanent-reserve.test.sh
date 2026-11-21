#!/usr/bin/env bash
# Bar of scripts/ci-permanent-reserve.sh. Exit 0 = every case holds.
# A fake GitHub API (a JSON file under a lock) plays the runners; no network.
# The failure it guards: one runner booked by two runs (a shard waits in the
# queue behind another run) or a booking that outlives its run.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export STATE="$tmp/state.json" PERMANENT_SETTLE_S=1 PERMANENT_PUSH_WAIT_S=2 PERMANENT_PUSH_POLL_S=1
fail=0
ok() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got $2 want $3"; fail=1; fi; }

# Fake gh_api: GET runners / runs, POST and DELETE labels, on $STATE under a mkdir lock (macOS has no flock).
cat > "$tmp/fake.sh" <<'EOS'
source "$HERE/ci-permanent-reserve.sh"
gh_api() {
  local m=$1 p=$2 body=${3:-}
  until mkdir "$STATE.lock" 2>/dev/null; do sleep 0.05; done
  (
    case "$m $p" in
      "GET /actions/runners?"*) jq '{runners}' "$STATE" ;;
      "GET /actions/runs/"*/jobs*) jq --arg r "$(basename "$(dirname "${p%%\?*}")")" '{jobs: (.jobs[$r] // [])}' "$STATE" ;;
      "GET /actions/runs/"*) jq --arg r "${p##*/}" '{status: (.runs[$r] // "in_progress")}' "$STATE" ;;
      "POST /actions/runs/"*/cancel)
        jq --arg r "$(basename "$(dirname "$p")")" '.runs[$r] = "completed"' "$STATE" > "$STATE.n" && mv "$STATE.n" "$STATE" ;;
      "POST /actions/runs/"*/rerun)
        jq --arg r "$(basename "$(dirname "$p")")" '.reruns += [$r]' "$STATE" > "$STATE.n" && mv "$STATE.n" "$STATE" ;;
      "POST /actions/runners/"*/labels)
        id=${p#/actions/runners/}; id=${id%/labels}
        l=$(jq -r '.labels[0]' <<<"$body")
        jq --argjson id "$id" --arg l "$l" '(.runners[] | select(.id == $id) | .labels) += [{name: $l}]' "$STATE" > "$STATE.n" && mv "$STATE.n" "$STATE"
        # PUSH_WORKS: rewriting a prep label wakes the runner, so its queued prep job starts
        if [ -n "${PUSH_WORKS:-}" ] && [[ $l == pn-*-prep ]]; then
          jq --arg l "$l" '.jobs |= map_values(map(if (.labels | index($l)) then .status = "in_progress" else . end))' "$STATE" > "$STATE.n" && mv "$STATE.n" "$STATE"
        fi
        # INJECT: another run books the same runner in the same instant
        if [ -n "${INJECT:-}" ]; then
          jq --argjson id "$id" --arg l "$INJECT" '(.runners[] | select(.id == $id) | .labels) += [{name: $l}]' "$STATE" > "$STATE.n" && mv "$STATE.n" "$STATE"
        fi ;;
      "DELETE /actions/runners/"*)
        id=${p#/actions/runners/}; id=${id%%/*}; l=${p##*/}
        jq --argjson id "$id" --arg l "$l" '(.runners[] | select(.id == $id) | .labels) |= map(select(.name != $l))' "$STATE" > "$STATE.n" && mv "$STATE.n" "$STATE" ;;
    esac
  )
  rmdir "$STATE.lock"
}
EOS
export HERE=$here
run() { bash -c "source '$tmp/fake.sh'; $*"; }

seed() {  # <runners spec: "id:status:busy:label ..."> [runs json]
  local js='[]' id st b l
  for r in $1; do
    IFS=: read -r id st b l <<<"$r"
    js=$(jq --argjson id "$id" --arg st "$st" --argjson b "$b" --arg l "$l" \
      '. + [{id: $id, name: "topics-permanent-node-\($id)", status: $st, busy: $b, labels: ([$l] | map({name: .}))}]' <<<"$js")
  done
  jq -n --argjson r "$js" --argjson runs "${2:-{\}}" '{runners: $r, runs: $runs, reruns: [], jobs: ($ENV.JOBS // "{}" | fromjson)}' > "$STATE"
}
booked() { jq -r --arg l "$1" '[.runners[] | select(any(.labels[]; .name == $l))] | length' "$STATE"; }
double() { jq '[.runners[] | select([.labels[].name | select(startswith("pn-"))] | length > 1)] | length' "$STATE"; }

FOUR="1:online:false:permanent 2:online:false:permanent 3:online:false:permanent 4:online:false:permanent"

seed "$FOUR"
ok "four free, eight wanted: four booked" "$(run reserve permanent 8 pn-100-1)" 4
ok "a second run finds none: its shards go to GitHub" "$(run reserve permanent 8 pn-101-1)" 0
ok "the second run left no label behind" "$(booked pn-101-1)" 0
run release pn-100-1
ok "release frees all four" "$(booked pn-100-1)" 0
ok "freed runners serve the next run" "$(run reserve permanent 3 pn-102-1)" 3

seed "1:online:true:permanent 2:offline:false:permanent 3:online:false:permanent-prep 4:online:false:permanent"
ok "busy, offline and other pools are skipped" "$(run reserve permanent 4 pn-103-1)" 1
ok "the prep pool books its own runner" "$(run reserve permanent-prep 1 pn-103-1-prep)" 1

seed "$FOUR" '{"200": "completed"}'
run 'gh_api POST /actions/runners/1/labels "{\"labels\":[\"pn-200-1\"]}"' >/dev/null
ok "a booking of a finished run is dropped and the runner reused" "$(run reserve permanent 4 pn-201-1)" 4
ok "the stale label is gone" "$(booked pn-200-1)" 0

# Run 600 is "queued" only because its give-back job waits on ubuntu-latest: e2e all done.
JOBS='{"600":[{"status":"completed","labels":["pn-600-1"]},{"status":"queued","labels":["ubuntu-latest"]}]}' seed "$FOUR"
run 'gh_api POST /actions/runners/1/labels "{\"labels\":[\"pn-600-1\"]}"' >/dev/null
ok "booking of a queued run with every e2e job done is dropped" "$(run reserve permanent 4 pn-601-1)" 4
ok "...and its label is gone" "$(booked pn-600-1)" 0
JOBS='{"610":[{"status":"completed","labels":["pn-610-1"]},{"status":"queued","labels":["pn-610-1"]}]}' seed "$FOUR"
run 'gh_api POST /actions/runners/1/labels "{\"labels\":[\"pn-610-1\"]}"' >/dev/null
ok "a run with an e2e job still queued keeps its booking" "$(run reserve permanent 4 pn-611-1)" 3
ok "...label kept" "$(booked pn-610-1)" 1
# Run 720: prepare-e2e is done, its shards are not created yet. The shard booking is
# judged by its own label only, so another run's reserve in that gap leaves it alone.
JOBS='{"720":[{"status":"completed","conclusion":"success","labels":["pn-720-1-prep"]}]}' seed "$FOUR"
run 'gh_api POST /actions/runners/1/labels "{\"labels\":[\"pn-720-1\"]}"' >/dev/null
ok "the shard booking is kept while only the prep job is done" "$(run reserve permanent 4 pn-721-1)" 3
ok "...label kept" "$(booked pn-720-1)" 1
# Run 730: prepare-e2e failed, so its shards are skipped and will never run: the shard
# booking is over and the runners go to the next run.
JOBS='{"730":[{"status":"completed","conclusion":"failure","labels":["pn-730-1-prep"]}]}' seed "$FOUR"
run 'gh_api POST /actions/runners/1/labels "{\"labels\":[\"pn-730-1\"]}"' >/dev/null
ok "a failed prep frees the shard booking" "$(run reserve permanent 4 pn-731-1)" 4
ok "...and its label is gone" "$(booked pn-730-1)" 0

# Run 740: its prepare-e2e has sat queued for 10 minutes on its booked runner. Both
# bookings are released and the run is cancelled; a prep queued 1 minute is left alone.
old=$(jq -rn 'now - 600 | todate'); new=$(jq -rn 'now - 60 | todate')
JOBS="{\"740\":[{\"status\":\"queued\",\"created_at\":\"$old\",\"labels\":[\"pn-740-1-prep\"]}],\"750\":[{\"status\":\"queued\",\"created_at\":\"$new\",\"labels\":[\"pn-750-1-prep\"]}]}" seed "$FOUR"
run 'gh_api POST /actions/runners/1/labels "{\"labels\":[\"permanent-prep\"]}"; gh_api POST /actions/runners/4/labels "{\"labels\":[\"permanent-prep\"]}"; gh_api POST /actions/runners/1/labels "{\"labels\":[\"pn-740-1-prep\"]}"; gh_api POST /actions/runners/2/labels "{\"labels\":[\"pn-740-1\"]}"; gh_api POST /actions/runners/3/labels "{\"labels\":[\"pn-750-1-prep\"]}"' >/dev/null
ok "a prep stuck in the queue frees the whole run" "$(run reserve permanent 4 pn-741-1 2>/dev/null)" 3
ok "...prep label gone" "$(booked pn-740-1-prep)" 0
ok "...shard label gone" "$(booked pn-740-1)" 0
ok "...run cancelled" "$(jq -r '.runs["740"]' "$STATE")" completed
ok "...and rerun" "$(jq -r '.reruns | join(",")' "$STATE")" 740
ok "...runner 1 quarantined out of the prep pool" "$(jq -r '.runners[0].labels | map(.name) | index("permanent-prep")' "$STATE")" null
ok "a prep queued only a minute keeps its booking" "$(booked pn-750-1-prep)" 1
# Next round (run 741 is over): the quarantined runner is not picked for a prep, runner 4 is.
run release pn-741-1
ok "the next prep booking skips the quarantined runner" "$(run reserve permanent-prep 1 pn-742-1-prep 2>/dev/null)" 1
ok "...it took runner 4" "$(jq -r '[.runners[] | select(any(.labels[]; .name == "pn-742-1-prep")) | .id] | join(",")' "$STATE")" 4

# Run 770: same stuck prep, but rewriting the label wakes the runner and the job starts:
# no quarantine, no cancel, no rerun, and the bookings stay.
JOBS="{\"770\":[{\"status\":\"queued\",\"created_at\":\"$old\",\"labels\":[\"pn-770-1-prep\"]}]}" seed "$FOUR"
run 'gh_api POST /actions/runners/1/labels "{\"labels\":[\"permanent-prep\"]}"; gh_api POST /actions/runners/1/labels "{\"labels\":[\"pn-770-1-prep\"]}"' >/dev/null
PUSH_WORKS=1 run reserve permanent 4 pn-771-1 >/dev/null 2>&1
ok "a push that starts the prep keeps its booking" "$(booked pn-770-1-prep)" 1
ok "...no cancel" "$(jq -r '.runs["770"] // "none"' "$STATE")" none
ok "...no rerun" "$(jq -r '.reruns | length' "$STATE")" 0
ok "...runner stays in the prep pool" "$(jq -r '.runners[0].labels | map(.name) | index("permanent-prep") != null' "$STATE")" true
# Quarantine over: runner 1 carries a quarantine label from 31 minutes ago, runner 2 one from
# 5 minutes ago (both out of the pool). The next reserve puts runner 1 back, runner 2 stays out.
seed "$FOUR"
t=$(date +%s)
run "for i in 1 2; do gh_api DELETE /actions/runners/\$i/labels/permanent; done; gh_api POST /actions/runners/1/labels '{\"labels\":[\"prep-quarantine-$((t - 1860))\"]}'; gh_api POST /actions/runners/2/labels '{\"labels\":[\"prep-quarantine-$((t - 300))\"]}'" >/dev/null
run reserve permanent 1 pn-760-1 >/dev/null 2>&1
ok "an expired quarantine puts the runner back in the prep pool" "$(jq -r '.runners[0].labels | map(.name) | index("permanent-prep") != null' "$STATE")" true
ok "...and its quarantine label is gone" "$(jq -r '[.runners[0].labels[].name | select(startswith("prep-quarantine-"))] | length' "$STATE")" 0
ok "a quarantine of 5 minutes holds" "$(jq -r '.runners[1].labels | map(.name) | index("permanent-prep")' "$STATE")" null
ok "...the next prep booking takes the rejoined runner" "$(run reserve permanent-prep 1 pn-761-1-prep 2>/dev/null)" 1
ok "...it is runner 1" "$(booked pn-761-1-prep)" 1

seed "$FOUR"
ok "zero wanted books nothing" "$(run reserve permanent 0 pn-300-1)" 0
ok "garbage count books nothing" "$(run reserve permanent abc pn-300-1)" 0

seed "$FOUR"
jq '.runners[0].name = "intruso-1"' "$STATE" > "$STATE.n" && mv "$STATE.n" "$STATE"
ok "a runner not named topics-permanent-node-* is never booked" "$(run reserve permanent 4 pn-500-1)" 3

# Both runs added their label before either read: this one gives every runner up.
seed "1:online:false:permanent 2:online:false:permanent"
ok "a runner booked by two runs at once is given up" "$(INJECT=pn-other-1 run reserve permanent 2 pn-400-1)" 0
ok "...and its label taken back, the other run's left" "$(booked pn-400-1)/$(booked pn-other-1)" 0/2

# Two runs at the same moment, ten times: never one runner kept by both.
for i in $(seq 1 10); do
  seed "$FOUR"
  run reserve permanent 3 pn-a-1 > "$tmp/a" & sleep "0.$((RANDOM % 9))"
  run reserve permanent 3 pn-b-1 > "$tmp/b"; wait
  a=$(cat "$tmp/a"); b=$(cat "$tmp/b")
  [ "$(double)" = 0 ] || { echo "FAIL race $i: a runner with two bookings"; fail=1; }
  [ "$a" = "$(booked pn-a-1)" ] && [ "$b" = "$(booked pn-b-1)" ] || { echo "FAIL race $i: count $a/$b, labels $(booked pn-a-1)/$(booked pn-b-1)"; fail=1; }
done
[ "$fail" = 0 ] && echo "ok   two runs at once: never a runner booked twice (10 rounds)"

exit "$fail"
