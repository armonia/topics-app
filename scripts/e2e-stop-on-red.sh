#!/usr/bin/env bash
#
# e2e-stop-on-red.sh: the shell of the long steps of the `e2e` shards in
# .github/workflows/ci.yml, written there as
#
#     shell: bash scripts/e2e-stop-on-red.sh {0}
#
# GitHub hands it the path of the step's script. It runs that script exactly
# as the default shell would (`bash -e <script>`), and on a pull request it
# asks the API, every E2E_STOP_POLL_SECONDS, how the `unit` and `gates` jobs
# that ran in this attempt are doing. When one of them concluded `failure`, the
# step is stopped and exits 1 with a line saying which job is the red one.
#
# WHY. Measured on 199 pull request runs (22-25/10/2026): in 82 of them unit or
# gates was red after a median of 6.6-8.1 minutes, and the eight e2e shards ran
# on for another 7,749 runner minutes, 25% of all the PR minutes, to produce a
# verdict nobody needed (the e2e was the red one in 13 runs). The minutes are
# free on a public repository; the jobs are not: the organisation runs at most
# 20 at a time, a CI run opens about 15, and the ubuntu jobs of the other runs
# waited for a slot with a p90 of 16.7 minutes.
#
# WHY A STOPPED SHARD ENDS `failure` AND NEVER `cancelled`. Agents, Auto-fix
# and the CI monitor read `cancelled` as "superseded, nothing to fix". The run
# is red because unit or gates is red, and it has to stay red: so no
# `gh run cancel`, the shard fails on its own.
#
# WHY ONLY ON A PULL REQUEST. On main every commit keeps its whole verdict:
# `auto-bump.yml` releases only a SHA whose CI completed green, and an e2e
# result is worth having there even when a unit test is red.
#
# IT NEVER STOPS A SHARD IT IS NOT SURE ABOUT. Every doubt runs the step to the
# end, as if this file were not there:
#   - not a pull request, or no token: plain `exec bash -e <script>`;
#   - unit and gates both completed without a failure: the watch ends, and a
#     mark in RUNNER_TEMP stops the next steps of the shard from asking again;
#   - neither job ran in this attempt: no watch. That is "Re-run job" on one
#     shard: GitHub lists the jobs it did not re-run as COPIES in the new
#     attempt (new id, same run_attempt as the shard, the old started_at and
#     conclusion), and a copied red is the verdict someone chose to look past
#     (runs 40191266179, 40197979566). After "Re-run failed jobs" a red unit is
#     re-run, so it is watched again;
#   - the API unreadable E2E_STOP_MAX_ERRORS times in a row, or fewer than
#     E2E_STOP_RATE_RESERVE requests left on the token: the watch ends with a
#     warning. The token had 5,000 requests an hour on run 40245465850, shared
#     with every workflow of the repository; this watch costs about 40 a run.
#
# The token arrives as E2E_STOP_TOKEN and is removed from the environment
# before the step runs: Playwright, the test server and whatever they spawn
# see the same environment they saw before this file existed.
#
# Tested by scripts/e2e-stop-on-red.test.sh, with a fake `curl` first on PATH.

set -u

script="${1:?usage: e2e-stop-on-red.sh <path of the step script>}"
token="${E2E_STOP_TOKEN:-}"
unset E2E_STOP_TOKEN

interval="${E2E_STOP_POLL_SECONDS:-45}"
grace="${E2E_STOP_GRACE_SECONDS:-15}"
reserve="${E2E_STOP_RATE_RESERVE:-250}"
max_errors="${E2E_STOP_MAX_ERRORS:-5}"
attempt="${GITHUB_RUN_ATTEMPT:-1}"
state="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
done_mark="$state/e2e-stop-on-red.done"

say() { echo "[e2e-stop] $*"; }

if [ "${GITHUB_EVENT_NAME:-}" != "pull_request" ] || [ -e "$done_mark" ]; then
  exec bash -e "$script"
fi
if [ -z "$token" ]; then
  echo "::warning title=E2E senza fermata::E2E_STOP_TOKEN is empty: this shard will not stop when unit or gates is red."
  exec bash -e "$script"
fi

work="$(mktemp -d "$state/e2e-stop-on-red.XXXXXX")"
reason="$work/reason"

# One line per watched job: name, status, conclusion, url. Exit 1 when the API
# could not be read; the rate limit left is in $work/left.
query() {
  local code
  code="$(curl -sS --max-time 20 -o "$work/body" -D "$work/headers" -w '%{http_code}' \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${GITHUB_API_URL:-https://api.github.com}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs?filter=all&per_page=100" 2>"$work/curl.err")" || return 1
  [ "$code" = "200" ] || return 1
  tr -d '\r' <"$work/headers" | awk -F': *' 'tolower($1) == "x-ratelimit-remaining" { print $2 }' >"$work/left"
  tr -d '\r' <"$work/headers" | awk -F': *' 'tolower($1) == "x-ratelimit-limit" { print $2 }' >"$work/limit"
  # The unit and gates jobs of this attempt that RAN in it: a copy carries the
  # started_at of the earlier attempt it was copied from (see the top).
  jq -r --argjson attempt "$attempt" '
    .jobs as $all
    | $all[]
    | select(.run_attempt == $attempt and (.name == "unit" or .name == "gates"))
    | select(. as $j | any($all[]; .run_attempt < $attempt and .name == $j.name and .started_at == $j.started_at) | not)
    | [.name, .status, (.conclusion // "none"), .html_url] | @tsv' "$work/body"
}

# SIGTERM to the step's process group, SIGKILL to whatever is left after the
# grace. The reason is written BEFORE the signal: the step can die at once,
# and the main loop must find the reason when it does.
stop_step() {
  printf '%s\n' "$1" >"$reason"
  if ! kill -TERM -- "-$step" 2>/dev/null; then
    rm -f "$reason" # the step had already ended on its own
    return
  fi
  local ticks=$((grace * 5))
  while [ "$ticks" -gt 0 ] && kill -0 -- "-$step" 2>/dev/null; do
    sleep 0.2
    ticks=$((ticks - 1))
  done
  kill -KILL -- "-$step" 2>/dev/null
}

watch() {
  local errors=0 jobs red left
  while :; do
    if jobs="$(query)"; then
      errors=0
      red="$(printf '%s\n' "$jobs" | awk -F'\t' '$2 == "completed" && $3 == "failure"')"
      if [ -n "$red" ]; then
        stop_step "$red"
        return
      fi
      if [ -z "$jobs" ]; then
        if [ "$attempt" -gt 1 ]; then
          say "unit and gates did not run in attempt $attempt (a re-run of single jobs): not watching"
        else
          # On a first attempt both jobs always exist: they were renamed.
          echo "::warning title=E2E senza fermata::no job named unit or gates in this run: this shard will not stop when they are red (renamed in ci.yml?)."
        fi
        : >"$done_mark"
        return
      fi
      if ! printf '%s\n' "$jobs" | awk -F'\t' '$2 != "completed" { pending = 1 } END { exit !pending }'; then
        say "$(printf '%s\n' "$jobs" | awk -F'\t' '{ printf "%s%s %s", sep, $1, $3; sep = ", " }'): not red, watch over ($(cat "$work/left")/$(cat "$work/limit") API requests left)"
        : >"$done_mark"
        return
      fi
      left="$(cat "$work/left")"
      if [ -n "$left" ] && [ "$left" -lt "$reserve" ]; then
        echo "::warning title=E2E senza fermata::$left API requests left on the token (reserve $reserve): this shard stops watching unit and gates and runs to the end."
        return
      fi
    else
      errors=$((errors + 1))
      if [ "$errors" -ge "$max_errors" ]; then
        echo "::warning title=E2E senza fermata::the jobs API was unreadable $errors times in a row ($(head -c 200 "$work/curl.err" 2>/dev/null)): this shard runs to the end."
        return
      fi
    fi
    sleep "$interval"
  done
}

say "watching unit and gates every ${interval}s: a red one stops this step"

# Job control gives the step and the watch a process group each, so a stop
# reaches every process of the step (the client build in the background, npx,
# Playwright and its workers) and nothing else.
set -m
bash -e "$script" </dev/null &
step=$!
watch &
watcher=$!

trap 'kill -INT -- "-$step" 2>/dev/null' INT
trap 'kill -TERM -- "-$step" 2>/dev/null' TERM

while :; do
  wait "$step"
  status=$?
  kill -0 "$step" 2>/dev/null || break # a trap can interrupt `wait` while the step still runs
done

# The watch can be halfway through a stop: let it finish (it sends the last
# SIGKILL), otherwise end it.
if [ -e "$reason" ]; then
  wait "$watcher" 2>/dev/null
else
  kill -- "-$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
fi

# A stopped step is reported stopped whatever its exit code: a process that
# answers SIGTERM with 0 did not finish the e2e, and a green here would be a
# green e2e row on the board for a suite that never ran to the end.
if [ -e "$reason" ]; then
  while IFS=$'\t' read -r name _ _ url; do
    echo "::error title=E2E fermata::fermato: $name rosso, la e2e non è il guasto. Il rosso da guardare è qui: $url"
  done <"$reason"
  rm -rf "$work"
  exit 1
fi
rm -rf "$work"
exit "$status"
