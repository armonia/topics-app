#!/usr/bin/env bash
#
# e2e-stop-on-red.test.sh: the contract of scripts/e2e-stop-on-red.sh, the
# shell that stops an e2e shard when unit or gates is red. A fake `curl` first
# on PATH plays the jobs API; each case writes the answers it returns, call by
# call. Run: bash scripts/e2e-stop-on-red.test.sh
#
# The two halves that matter most are opposite. A red unit or gates job must
# stop the step within one poll, with the job named in the log. And every
# other path must leave the step exactly as GitHub's default shell runs it:
# same exit code, same `bash -e`, no token in its environment, and no stop
# when the API is unreadable or the red belongs to another run attempt.
#
# E2E_STOP_SCRIPT lets a mutant copy be tested instead of the real script.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${E2E_STOP_SCRIPT:-$HERE/e2e-stop-on-red.sh}"
WORK="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$WORK"' EXIT
fails=0

mkdir -p "$WORK/bin"
# The fake curl: answer N comes from $FAKE_API/body.N (else $FAKE_API/body),
# with the status code of $FAKE_API/code and the rate limit left of
# $FAKE_API/left. $FAKE_API/down makes it fail like a dead connection.
cat >"$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
n=$(($(cat "$FAKE_API/calls" 2>/dev/null || echo 0) + 1))
echo "$n" >"$FAKE_API/calls"
out="" hdr="" fmt="" url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -D) hdr="$2"; shift ;;
    -w) fmt="$2"; shift ;;
    -H) case "$2" in Authorization:*) echo "$2" >"$FAKE_API/auth" ;; esac; shift ;;
    --max-time) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
echo "$url" >"$FAKE_API/url"
if [ -e "$FAKE_API/down" ]; then
  echo "curl: (7) Failed to connect to api.github.com port 443" >&2
  exit 7
fi
body="$FAKE_API/body.$n"
[ -e "$body" ] || body="$FAKE_API/body"
cp "$body" "$out"
printf 'HTTP/2 %s\r\nx-ratelimit-limit: 1000\r\nx-ratelimit-remaining: %s\r\n\r\n' \
  "$(cat "$FAKE_API/code" 2>/dev/null || echo 200)" "$(cat "$FAKE_API/left" 2>/dev/null || echo 900)" >"$hdr"
[ "$fmt" = '%{http_code}' ] && printf '%s' "$(cat "$FAKE_API/code" 2>/dev/null || echo 200)"
exit 0
EOF
chmod +x "$WORK/bin/curl"

# The jobs of a run as the API lists them: unit and gates with the given
# status/conclusion, plus the jobs that are not watched.
jobs_json() { # unit_status unit_conclusion gates_status gates_conclusion [attempt]
  local a="${5:-1}"
  cat <<EOF
{"total_count": 4, "jobs": [
  {"name": "unit", "status": "$1", "conclusion": $([ "$2" = null ] && echo null || echo "\"$2\""), "run_attempt": $a, "html_url": "https://github.com/o/r/actions/runs/1/job/11"},
  {"name": "gates", "status": "$3", "conclusion": $([ "$4" = null ] && echo null || echo "\"$4\""), "run_attempt": $a, "html_url": "https://github.com/o/r/actions/runs/1/job/12"},
  {"name": "check", "status": "queued", "conclusion": null, "run_attempt": $a, "html_url": "https://github.com/o/r/actions/runs/1/job/13"},
  {"name": "e2e (1)", "status": "in_progress", "conclusion": "failure", "run_attempt": $a, "html_url": "https://github.com/o/r/actions/runs/1/job/14"}
]}
EOF
}

# A fresh case: its own API, RUNNER_TEMP and step script.
new_case() {
  CASE="$WORK/case-$1"
  mkdir -p "$CASE/api" "$CASE/tmp"
  export FAKE_API="$CASE/api"
  jobs_json in_progress null in_progress null >"$FAKE_API/body"
}

# Runs the shell on $CASE/step.sh as GitHub would on a pull request, with a
# fast poll. Leaves the exit code in $RC, the output in $CASE/out and the
# seconds it took in $SECS.
run_step() {
  local t0=$SECONDS
  env PATH="$WORK/bin:$PATH" \
    GITHUB_EVENT_NAME="${EVENT:-pull_request}" GITHUB_REPOSITORY=o/r GITHUB_RUN_ID=1 \
    GITHUB_RUN_ATTEMPT="${ATTEMPT:-1}" GITHUB_API_URL=https://api.github.test \
    RUNNER_TEMP="$CASE/tmp" E2E_STOP_TOKEN="${TOKEN-secret-token}" \
    E2E_STOP_POLL_SECONDS=0.3 E2E_STOP_GRACE_SECONDS=2 E2E_STOP_MAX_ERRORS=3 \
    bash "$SCRIPT" "$CASE/step.sh" >"$CASE/out" 2>&1
  RC=$?
  SECS=$((SECONDS - t0))
}

check() { # description, condition (a command)
  local what="$1"
  shift
  if "$@"; then
    echo "ok    $what"
  else
    echo "FAIL  $what"
    sed 's/^/        | /' "$CASE/out"
    fails=$((fails + 1))
  fi
}
calls() { cat "$FAKE_API/calls" 2>/dev/null || echo 0; }
said() { grep -qF -- "$1" "$CASE/out"; }

# 1. A red unit stops a long step at the next poll, and the whole process
# group goes with it: the step's own background child included.
new_case red-unit
jobs_json completed failure in_progress null >"$FAKE_API/body.3"
cat >"$CASE/step.sh" <<EOF
sleep 60 &
echo \$! >"$CASE/grandchild"
wait
EOF
run_step
check "red unit: exit 1" [ "$RC" -eq 1 ]
check "red unit: stopped within seconds, not after the 60 s step ($SECS s)" [ "$SECS" -le 5 ]
check "red unit: the log names the red job and where to look" said "fermato: unit rosso, la e2e non è il guasto. Il rosso da guardare è qui: https://github.com/o/r/actions/runs/1/job/11"
check "red unit: the line is an error annotation" said "::error title=E2E fermata::"
check "red unit: the step's background child is gone too" bash -c '! kill -0 "$(cat "$1")" 2>/dev/null' _ "$CASE/grandchild"
check "red unit: it asked the jobs of this run, with the token" bash -c 'grep -qx "https://api.github.test/repos/o/r/actions/runs/1/jobs?per_page=100" "$1/url" && grep -qx "Authorization: Bearer secret-token" "$1/auth"' _ "$FAKE_API"

# 2. A red gates job stops it the same way.
new_case red-gates
jobs_json in_progress null completed failure >"$FAKE_API/body.2"
echo 'sleep 60' >"$CASE/step.sh"
run_step
check "red gates: exit 1, gates named" bash -c '[ "$1" -eq 1 ] && grep -qF "fermato: gates rosso" "$2"' _ "$RC" "$CASE/out"

# 3. A step that ignores SIGTERM is killed after the grace.
new_case deaf
jobs_json completed failure in_progress null >"$FAKE_API/body"
echo "trap '' TERM; sleep 60 & wait; sleep 60" >"$CASE/step.sh"
run_step
check "deaf step: killed after the grace ($SECS s), exit 1" bash -c '[ "$1" -eq 1 ] && [ "$2" -le 6 ]' _ "$RC" "$SECS"

# 4. Unit and gates green: the step's own exit code, a red one included, and
# the watch ends so the next step of the shard does not ask again.
new_case green
jobs_json in_progress null completed success >"$FAKE_API/body.1"
jobs_json completed success completed success >"$FAKE_API/body"
echo 'sleep 2; exit 7' >"$CASE/step.sh"
run_step
check "green siblings: the step's own exit code (7)" [ "$RC" -eq 7 ]
check "green siblings: no stop line" bash -c '! grep -q "fermato" "$1"' _ "$CASE/out"
check "green siblings: the watch ends at the green answer (2 calls, not one per poll)" [ "$(calls)" -eq 2 ]
check "green siblings: and says so, with the requests left" said "unit success, gates success: not red, watch over (900/1000 API requests left)"
echo 'exit 0' >"$CASE/step.sh"
run_step
check "next step after green: exit 0 and no further API call" bash -c '[ "$1" -eq 0 ] && [ "$2" -eq 2 ]' _ "$RC" "$(calls)"

# 5. The step fails on its own while unit and gates are still running: its
# exit code, and nothing about a stop.
new_case own-red
echo 'sleep 1; exit 3' >"$CASE/step.sh"
run_step
check "own red: exit 3, no stop line" bash -c '[ "$1" -eq 3 ] && ! grep -q "fermato" "$2"' _ "$RC" "$CASE/out"

# 6. `bash -e`, as GitHub's default shell: the first failing command ends it.
new_case bash-e
printf 'false\necho after-false\n' >"$CASE/step.sh"
run_step
check "bash -e: exit 1 at the first failing command" bash -c '[ "$1" -eq 1 ] && ! grep -q after-false "$2"' _ "$RC" "$CASE/out"

# 7. The token reaches the API and never the step.
new_case token
echo 'echo "token=[${E2E_STOP_TOKEN:-}]"' >"$CASE/step.sh"
run_step
check "token: not in the step's environment" said "token=[]"

# 8. A red of ANOTHER attempt is not this attempt's red: after "re-run failed
# jobs", unit keeps the failure of attempt 1 until it runs again.
new_case other-attempt
jobs_json completed failure completed success 1 >"$FAKE_API/body"
echo 'sleep 2; exit 0' >"$CASE/step.sh"
ATTEMPT=2 run_step
check "other attempt: not stopped, exit 0" bash -c '[ "$1" -eq 0 ] && ! grep -q "fermato" "$2"' _ "$RC" "$CASE/out"

# 9. The API unreadable: the step runs to the end, with a warning.
new_case api-down
: >"$FAKE_API/down"
echo 'sleep 2; exit 0' >"$CASE/step.sh"
run_step
check "API down: runs to the end, exit 0" [ "$RC" -eq 0 ]
check "API down: warns that this shard will not stop" said "::warning title=E2E senza fermata::the jobs API was unreadable 3 times in a row"
new_case api-500
echo 500 >"$FAKE_API/code"
jobs_json completed failure in_progress null >"$FAKE_API/body"
echo 'sleep 2; exit 0' >"$CASE/step.sh"
run_step
check "API 500 with a red-looking body: not trusted, exit 0" bash -c '[ "$1" -eq 0 ] && ! grep -q "fermato" "$2"' _ "$RC" "$CASE/out"

# 10. Few requests left on the token: the watch gives them back.
new_case rate
echo 100 >"$FAKE_API/left"
echo 'sleep 2; exit 0' >"$CASE/step.sh"
run_step
check "rate limit: stops asking after one call, exit 0" bash -c '[ "$1" -eq 0 ] && [ "$2" -eq 1 ]' _ "$RC" "$(calls)"
check "rate limit: says so" said "100 API requests left on the token (reserve 250)"

# 11. Not a pull request: no API call at all, the plain shell.
new_case push
jobs_json completed failure completed failure >"$FAKE_API/body"
echo 'sleep 1; exit 5' >"$CASE/step.sh"
EVENT=push run_step
check "push: exit 5, never asked the API" bash -c '[ "$1" -eq 5 ] && [ "$2" -eq 0 ]' _ "$RC" "$(calls)"
check "push: no watch line" bash -c '! grep -q "e2e-stop" "$1"' _ "$CASE/out"

# 12. No token on a pull request: the plain shell, with a warning.
new_case no-token
jobs_json completed failure completed failure >"$FAKE_API/body"
echo 'exit 0' >"$CASE/step.sh"
TOKEN="" run_step
check "no token: exit 0, warning, no API call" bash -c '[ "$1" -eq 0 ] && [ "$2" -eq 0 ] && grep -qF "E2E_STOP_TOKEN is empty" "$3"' _ "$RC" "$(calls)" "$CASE/out"

# 13. A step that answers the stop with exit 0 did not run the e2e to the end:
# it is reported stopped, never green.
new_case term-zero
jobs_json completed failure in_progress null >"$FAKE_API/body.2"
echo "trap 'exit 0' TERM; sleep 60 & wait" >"$CASE/step.sh"
run_step
check "step exiting 0 on SIGTERM: still exit 1, stopped" bash -c '[ "$1" -eq 1 ] && grep -qF "fermato: unit rosso" "$2"' _ "$RC" "$CASE/out"

if [ "$fails" -gt 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
