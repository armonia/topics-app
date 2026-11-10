#!/usr/bin/env bash
# Bar of scripts/ci-fisso-reserve.sh. Exit 0 = every case holds.
# A fake GitHub API (a JSON file under a lock) plays the runners; no network.
# The failure it guards: one runner booked by two runs (a shard waits in the
# queue behind another run) or a booking that outlives its run.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export STATE="$tmp/state.json" FISSO_SETTLE_S=1
fail=0
ok() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got $2 want $3"; fail=1; fi; }

# Fake gh_api: GET runners / runs, POST and DELETE labels, on $STATE under a mkdir lock (macOS has no flock).
cat > "$tmp/fake.sh" <<'EOS'
source "$HERE/ci-fisso-reserve.sh"
gh_api() {
  local m=$1 p=$2 body=${3:-}
  until mkdir "$STATE.lock" 2>/dev/null; do sleep 0.05; done
  (
    case "$m $p" in
      "GET /actions/runners?"*) jq '{runners}' "$STATE" ;;
      "GET /actions/runs/"*) jq --arg r "${p##*/}" '{status: (.runs[$r] // "in_progress")}' "$STATE" ;;
      "POST /actions/runners/"*/labels)
        id=${p#/actions/runners/}; id=${id%/labels}
        l=$(jq -r '.labels[0]' <<<"$body")
        jq --argjson id "$id" --arg l "$l" '(.runners[] | select(.id == $id) | .labels) += [{name: $l}]' "$STATE" > "$STATE.n" && mv "$STATE.n" "$STATE"
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
      '. + [{id: $id, status: $st, busy: $b, labels: ([$l] | map({name: .}))}]' <<<"$js")
  done
  jq -n --argjson r "$js" --argjson runs "${2:-{\}}" '{runners: $r, runs: $runs}' > "$STATE"
}
booked() { jq -r --arg l "$1" '[.runners[] | select(any(.labels[]; .name == $l))] | length' "$STATE"; }
double() { jq '[.runners[] | select([.labels[].name | select(startswith("fz-"))] | length > 1)] | length' "$STATE"; }

FOUR="1:online:false:fisso 2:online:false:fisso 3:online:false:fisso 4:online:false:fisso"

seed "$FOUR"
ok "four free, eight wanted: four booked" "$(run reserve fisso 8 fz-100-1)" 4
ok "a second run finds none: its shards go to GitHub" "$(run reserve fisso 8 fz-101-1)" 0
ok "the second run left no label behind" "$(booked fz-101-1)" 0
run release fz-100-1
ok "release frees all four" "$(booked fz-100-1)" 0
ok "freed runners serve the next run" "$(run reserve fisso 3 fz-102-1)" 3

seed "1:online:true:fisso 2:offline:false:fisso 3:online:false:fisso-prep 4:online:false:fisso"
ok "busy, offline and other pools are skipped" "$(run reserve fisso 4 fz-103-1)" 1
ok "the prep pool books its own runner" "$(run reserve fisso-prep 1 fz-103-1-prep)" 1

seed "$FOUR" '{"200": "completed"}'
run 'gh_api POST /actions/runners/1/labels "{\"labels\":[\"fz-200-1\"]}"' >/dev/null
ok "a booking of a finished run is dropped and the runner reused" "$(run reserve fisso 4 fz-201-1)" 4
ok "the stale label is gone" "$(booked fz-200-1)" 0

seed "$FOUR"
ok "zero wanted books nothing" "$(run reserve fisso 0 fz-300-1)" 0
ok "garbage count books nothing" "$(run reserve fisso abc fz-300-1)" 0

# Both runs added their label before either read: this one gives every runner up.
seed "1:online:false:fisso 2:online:false:fisso"
ok "a runner booked by two runs at once is given up" "$(INJECT=fz-other-1 run reserve fisso 2 fz-400-1)" 0
ok "...and its label taken back, the other run's left" "$(booked fz-400-1)/$(booked fz-other-1)" 0/2

# Two runs at the same moment, ten times: never one runner kept by both.
for i in $(seq 1 10); do
  seed "$FOUR"
  run reserve fisso 3 fz-a-1 > "$tmp/a" & sleep "0.$((RANDOM % 9))"
  run reserve fisso 3 fz-b-1 > "$tmp/b"; wait
  a=$(cat "$tmp/a"); b=$(cat "$tmp/b")
  [ "$(double)" = 0 ] || { echo "FAIL race $i: a runner with two bookings"; fail=1; }
  [ "$a" = "$(booked fz-a-1)" ] && [ "$b" = "$(booked fz-b-1)" ] || { echo "FAIL race $i: count $a/$b, labels $(booked fz-a-1)/$(booked fz-b-1)"; fail=1; }
done
[ "$fail" = 0 ] && echo "ok   two runs at once: never a runner booked twice (10 rounds)"

exit "$fail"
