#!/usr/bin/env sh
# Bar of scripts/claude-hooks/post-hook.sh, the wrapper every Claude Code hook
# event goes through. Exit 0 = every case holds.
# A temporary TOPICS_HOME with a token and a fake Topics server that answers 401
# to a wrong token and logs every authorised request; nothing outside the temp
# folder is read or written.
# @covers CCS-02
set -u
here="$(cd "$(dirname "$0")" && pwd)"
hook="$here/post-hook.sh"
tmp="$(mktemp -d)"; tmp="$(cd "$tmp" && pwd -P)"
trap 'stop_fake; rm -rf "$tmp"' EXIT
. "$here/worktree-hook.test-lib.sh"

# --- Topics down: the hook says nothing and never fails ------------------------
printf '{"hook_event_name":"Stop"}' | sh "$hook" Stop >"$tmp/out" 2>"$tmp/err"
ok "topics down: exit 0" "$?" 0
ok "topics down: nothing on stdout or stderr" "$(cat "$tmp/out" "$tmp/err" | wc -c | tr -d ' ')" 0

# --- no token file: a no-op, not a failure -------------------------------------
mv "$TOPICS_HOME/claude-hooks/hook-token" "$tmp/token.away"
start_fake
printf '{"hook_event_name":"Stop"}' | HOME="$tmp/no-home" sh "$hook" Stop; code=$?
ok "no token: exit 0" "$code" 0
ok "no token: nothing sent" "$(/usr/bin/grep -c . "$tmp/requests.log")" 0
mv "$tmp/token.away" "$TOPICS_HOME/claude-hooks/hook-token"

# --- the event reaches the server with the right token and the payload ---------
printf '{"hook_event_name":"PreToolUse","tool_name":"Bash"}' | sh "$hook" PreToolUse; code=$?
ok "delivered: exit 0" "$code" 0
ok "delivered: one POST to the event path, payload intact" \
  "$(/usr/bin/grep -c '^POST /api/claude-hooks/PreToolUse {"hook_event_name":"PreToolUse","tool_name":"Bash"}$' "$tmp/requests.log")" 1
stop_fake

# --- the token never sits in a command line (ps, /proc/<pid>/cmdline) ----------
mkdir -p "$tmp/fakebin"
real_curl="$(command -v curl)"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/curl-argv.log"\nexec "%s" "$@"\n' "$tmp" "$real_curl" > "$tmp/fakebin/curl"
chmod +x "$tmp/fakebin/curl"
: > "$tmp/curl-argv.log"
start_fake
printf '{"hook_event_name":"Stop"}' | PATH="$tmp/fakebin:$PATH" sh "$hook" Stop
ok "token: the server still got the call (so the header reached it)" "$(/usr/bin/grep -c '^POST /api/claude-hooks/Stop ' "$tmp/requests.log")" 1
ok "token: curl was run through the shim" "$(/usr/bin/grep -c 'claude-hooks/Stop' "$tmp/curl-argv.log")" 1
ok "token: absent from curl's arguments" "$(/usr/bin/grep -c abcdef0123456789 "$tmp/curl-argv.log")" 0
stop_fake

# --- a wrong token is refused by the server, and the hook still exits 0 --------
printf 'ffffffffffffffffffffffffffffffff' > "$TOPICS_HOME/claude-hooks/hook-token"
start_fake
printf '{"hook_event_name":"Stop"}' | sh "$hook" Stop; code=$?
ok "wrong token: exit 0" "$code" 0
ok "wrong token: the server logged nothing" "$(/usr/bin/grep -c . "$tmp/requests.log")" 0
stop_fake
printf 'abcdef0123456789abcdef0123456789' > "$TOPICS_HOME/claude-hooks/hook-token"

# --- mutation: with the token back in the arguments the bar must go red --------
sed 's|printf .Authorization: Bearer %s\\n. "\${TOKEN}" \| curl|curl|; s|--header @- |--header "Authorization: Bearer ${TOKEN}" |' "$hook" > "$tmp/mutant.sh"
if cmp -s "$hook" "$tmp/mutant.sh"; then echo "FAIL mutation not applied"; fail=1; fi
: > "$tmp/curl-argv.log"
printf '{"hook_event_name":"Stop"}' | PATH="$tmp/fakebin:$PATH" sh "$tmp/mutant.sh" Stop
if [ "$(/usr/bin/grep -c abcdef0123456789 "$tmp/curl-argv.log")" = 0 ]; then
  echo "FAIL mutation survived: the token in the arguments went unseen"; fail=1
else
  echo "ok   mutation (token back in the arguments) is caught"
fi

exit $fail
