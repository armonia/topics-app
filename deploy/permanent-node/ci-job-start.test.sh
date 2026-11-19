#!/usr/bin/env bash
# Bar of the job-started hook of the release runner, written by ci-runners.sh.
# Exit 0 = a fork's pull request (or one whose fork is gone) is refused before any
# step runs, while push and pull requests from this repository run.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail=0
ok() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got $2 want $3"; fail=1; fi; }

# The hook as ci-runners.sh installs it, from its heredoc.
awk '/^cat > \/usr\/local\/bin\/ci-job-start.sh/{f=1; next} f && /^EOS$/{exit} f' \
  "$here/ci-runners.sh" > "$tmp/hook.sh"
[ -s "$tmp/hook.sh" ] || { echo "FAIL hook not found in ci-runners.sh"; exit 1; }

hook() {  # <event json or "none">
  local ev="$tmp/event.json"
  if [ "$1" = none ]; then ev="$tmp/missing.json"; else printf '%s' "$1" > "$ev"; fi
  GITHUB_EVENT_PATH=$ev GITHUB_REPOSITORY=armonia/topics-app bash "$tmp/hook.sh" 2>/dev/null
  echo $?
}

ok "push runs" "$(hook '{"ref":"refs/heads/main"}')" 0
ok "pull request from this repository runs" \
  "$(hook '{"pull_request":{"head":{"repo":{"full_name":"armonia/topics-app"}}}}')" 0
ok "pull request from a fork is refused" \
  "$(hook '{"pull_request":{"head":{"repo":{"full_name":"someone/topics-app"}}}}')" 1
ok "pull request whose fork was deleted is refused" \
  "$(hook '{"pull_request":{"head":{"repo":null}}}')" 1
ok "no event payload is refused" "$(hook none)" 1

# The hook is wired to the release runner only, the one that sees the token.
grep -q 'ci-runner@ctl.service.d' "$here/ci-runners.sh" \
  && grep -q 'ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/bin/ci-job-start.sh' "$here/ci-runners.sh"
ok "the release runner's unit sets the hook" "$?" 0

exit "$fail"
